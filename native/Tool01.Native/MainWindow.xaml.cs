using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Media3D;
using System.Windows.Threading;

namespace Tool01.Native;

public partial class MainWindow : Window
{
    private static readonly IReadOnlyList<MyRealmCreateTileOption> BuiltinMapOptions =
    [
        new() { MapId = "AncientCity", MapName = "AncientCity", Difficulty = "MEDIUM" },
        new() { MapId = "Asteroid Crash Site", MapName = "Asteroid Crash Site", Difficulty = "HARD" },
        new() { MapId = "Canyon", MapName = "Canyon", Difficulty = "MEDIUM" },
        new() { MapId = "CanyonB", MapName = "CanyonB", Difficulty = "MEDIUM" },
        new() { MapId = "Cradle", MapName = "Cradle", Difficulty = "EASY" },
        new() { MapId = "Icelands", MapName = "Icelands", Difficulty = "HARD" },
        new() { MapId = "Kali Spires", MapName = "Kali Spires", Difficulty = "HARD" },
        new() { MapId = "Sleeping Giants", MapName = "Sleeping Giants", Difficulty = "HARD" },
        new() { MapId = "Sleeping Giants Roads", MapName = "Sleeping Giants Roads", Difficulty = "HARD" },
        new() { MapId = "Volcano", MapName = "Volcano", Difficulty = "HARD" },
        new() { MapId = "Volcanyon", MapName = "Volcanyon", Difficulty = "HARD" },
        new() { MapId = "Worm's Lair", MapName = "Worm's Lair", Difficulty = "HARD" },
    ];

    private readonly ControlCenterClient _client = new();
    private readonly DispatcherTimer _pollTimer;
    private readonly ObservableCollection<SelectableMapOption> _allowedMaps = [];
    private readonly ObservableCollection<SelectableTileOption> _anchorTiles = [];
    private readonly string _workspaceRoot;
    private FileSystemWatcher? _profileFolderWatcher;
    private string _watchedProfileRoot = "";
    private DateTime _lastProfileFolderRefreshUtc = DateTime.MinValue;
    private bool _refreshInProgress;
    private bool _queuedRefreshWorkerActive;
    private bool _queuedRefreshRequested;
    private bool _queuedRefreshForceDashboard;
    private int _queuedRefreshDelayMs;
    private bool _suspendUiEvents;
    private bool _profileDirty;
    private bool _realmDirty;
    private bool _operationsDirty;
    private bool _eventDirty;
    private bool _installDirty;
    private int _pollCounter;
    private int _backendFailureStreak;
    private int _monitorFailureStreak;
    private DateTime _lastEditorInteractionUtc = DateTime.MinValue;
    private DashboardState? _dashboard;
    private MonitorState? _monitor;
    private MyRealmSessionSnapshot? _session;
    private LocalInstallContext _installContext = new();
    private bool _safeMode;

    public MainWindow()
    {
        InitializeComponent();
        _workspaceRoot = WorkspaceLocator.FindRoot();

        AllowedMapsGrid.ItemsSource = _allowedMaps;
        AnchorTilesGrid.ItemsSource = _anchorTiles;
        EventCyclesGrid.ItemsSource = Array.Empty<EventTileCycleState>();
        EventCycleSelectorComboBox.ItemsSource = Array.Empty<EventTileCycleState>();
        HealthChecksGrid.ItemsSource = Array.Empty<HealthCheck>();
        ApiProbeGrid.ItemsSource = Array.Empty<MyRealmApiProbeRow>();
        ManagerAuditGrid.ItemsSource = Array.Empty<ManagerAuditEntry>();
        EventDryRunGrid.ItemsSource = Array.Empty<EventTileDryRunCandidate>();
        GameBridgeMessagesGrid.ItemsSource = Array.Empty<GameBridgeMessage>();
        GameBridgeChatGrid.ItemsSource = Array.Empty<GameBridgeChatEntry>();

        _pollTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(6),
        };
        _pollTimer.Tick += PollTimer_Tick;

        Loaded += MainWindow_Loaded;
        Closed += MainWindow_Closed;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        RefreshLocalInstallContext();
        await EnsureBackendAndRefreshAsync();
        try
        {
            await RefreshSteamLoginStatusAsync();
            await RefreshSteamClientStatusAsync();
        }
        catch
        {
            SteamLoginStatusText.Text = "Steam login secret status could not be checked yet.";
            SteamClientStatusText.Text = "Steam client status could not be checked yet.";
        }
        _pollTimer.Start();
    }

    private void MainWindow_Closed(object? sender, EventArgs e)
    {
        _pollTimer.Stop();
        _profileFolderWatcher?.Dispose();
        _client.Dispose();
    }

    private async void PollTimer_Tick(object? sender, EventArgs e)
    {
        await RefreshAsync(false);
    }

    private async Task EnsureBackendAndRefreshAsync()
    {
        try
        {
            SetActionStatus("Connecting to the local control center backend...");
            if (!await _client.IsBackendOnlineAsync())
            {
                SetActionStatus("Backend is offline. Starting it now...");
                await _client.StartBackendAsync();
            }

            await RefreshAsync(true);
            RefreshLocalInstallContext();
            _backendFailureStreak = 0;
            SetActionStatus("Native desktop client is connected.");
        }
        catch (Exception ex)
        {
            HandleOfflineState(ex.Message);
        }
    }

    private async Task RefreshAsync(bool forceDashboard)
    {
        if (_refreshInProgress)
        {
            return;
        }

        _refreshInProgress = true;
        try
        {
            _monitor = await _client.GetMonitorAsync();
            _backendFailureStreak = 0;
            _monitorFailureStreak = 0;
            UpdateMonitorUi(_monitor);

            var shouldRefreshDashboard =
                forceDashboard ||
                _dashboard is null ||
                (!HasPendingEdits() && !ShouldDeferBackgroundRefresh() && IsLiveRefreshTabSelected() && _pollCounter++ % 5 == 0);
            if (shouldRefreshDashboard)
            {
                try
                {
                    _dashboard = await _client.GetDashboardAsync();
                    ApplyDashboard(_dashboard);
                    RefreshLocalInstallContext();
                }
                catch (Exception ex)
                {
                    SetActionStatus($"Backend is online, but dashboard refresh failed: {ex.Message}", true);
                }
            }
        }
        catch (Exception ex)
        {
            var backendReachable = await _client.IsBackendOnlineAsync();
            if (backendReachable)
            {
                _backendFailureStreak = 0;
                _monitorFailureStreak += 1;
                BackendStateText.Text = "Backend: online";
                BackendStateText.Foreground = new SolidColorBrush(Color.FromRgb(216, 164, 93));

                if (ex is OperationCanceledException)
                {
                    var statusMessage = _monitorFailureStreak < 4
                        ? "Live monitor refresh was slow; keeping the last status."
                        : "Backend is online, but live monitor refresh is still slow. Keeping the last status while it catches up.";
                    SetActionStatus(statusMessage);
                }
                else
                {
                    SetActionStatus($"Backend is online, but monitor refresh keeps failing: {ex.Message}", true);
                }
            }
            else
            {
                _backendFailureStreak += 1;
                _monitorFailureStreak = 0;
                if (_backendFailureStreak >= 2)
                {
                    HandleOfflineState(ex.Message);
                }
                else
                {
                    SetActionStatus("Backend check missed once. Waiting for the next refresh before marking it offline.", true);
                }
            }
        }
        finally
        {
            _refreshInProgress = false;
        }
    }

    private void ApplyReturnedDashboard(DashboardState? dashboard)
    {
        if (dashboard is null)
        {
            return;
        }

        ApplyDashboard(dashboard);
        RefreshLocalInstallContext();
    }

    private void ApplyReturnedConfig(AppConfig? config)
    {
        if (config is null || _dashboard is null)
        {
            return;
        }

        _dashboard.Config = config;
        ApplyDashboard(_dashboard);
        RefreshLocalInstallContext();
    }

    private void QueueRefresh(bool forceDashboard, int delayMs = 0)
    {
        _queuedRefreshRequested = true;
        _queuedRefreshForceDashboard = _queuedRefreshForceDashboard || forceDashboard;
        _queuedRefreshDelayMs = Math.Max(_queuedRefreshDelayMs, delayMs);

        if (_queuedRefreshWorkerActive)
        {
            return;
        }

        _queuedRefreshWorkerActive = true;
        _ = QueueRefreshAsync();
    }

    private async Task QueueRefreshAsync()
    {
        try
        {
            while (true)
            {
                var forceDashboard = _queuedRefreshForceDashboard;
                var delayMs = _queuedRefreshDelayMs;
                _queuedRefreshRequested = false;
                _queuedRefreshForceDashboard = false;
                _queuedRefreshDelayMs = 0;

                if (delayMs > 0)
                {
                    await Task.Delay(delayMs);
                }

                while (_refreshInProgress)
                {
                    await Task.Delay(100);
                }

                await RefreshAsync(forceDashboard);

                if (!_queuedRefreshRequested)
                {
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            SetActionStatus($"Background refresh failed: {ex.Message}", true);
        }
        finally
        {
            _queuedRefreshWorkerActive = false;
            if (_queuedRefreshRequested)
            {
                QueueRefresh(_queuedRefreshForceDashboard, _queuedRefreshDelayMs);
            }
        }
    }

    private bool HasPendingEdits()
    {
        return _profileDirty || _realmDirty || _operationsDirty || _eventDirty || _installDirty;
    }

    private bool ShouldDeferBackgroundRefresh()
    {
        if (HasPendingEdits())
        {
            return true;
        }

        if (!IsActive)
        {
            return false;
        }

        var currentTabHeader = (MainTabControl.SelectedItem as TabItem)?.Header?.ToString() ?? "";
        if (!string.Equals(currentTabHeader, "Overview", StringComparison.OrdinalIgnoreCase) &&
            DateTime.UtcNow - _lastEditorInteractionUtc < TimeSpan.FromSeconds(20))
        {
            return true;
        }

        return false;
    }

    private bool IsLiveRefreshTabSelected()
    {
        var currentTabHeader = (MainTabControl.SelectedItem as TabItem)?.Header?.ToString() ?? "";
        return string.Equals(currentTabHeader, "Overview", StringComparison.OrdinalIgnoreCase)
            || string.Equals(currentTabHeader, "MyRealm Tiles", StringComparison.OrdinalIgnoreCase)
            || string.Equals(currentTabHeader, "Event Tiles", StringComparison.OrdinalIgnoreCase);
    }

    private void MarkEditorInteraction()
    {
        _lastEditorInteractionUtc = DateTime.UtcNow;
    }

    private static T? FindAncestor<T>(DependencyObject? source) where T : DependencyObject
    {
        var current = source;
        while (current is not null)
        {
            if (current is T typed)
            {
                return typed;
            }

            current = current switch
            {
                Visual visual => VisualTreeHelper.GetParent(visual),
                Visual3D visual3D => VisualTreeHelper.GetParent(visual3D),
                FrameworkContentElement frameworkContent => frameworkContent.Parent,
                _ => null,
            };
        }

        return null;
    }

    private static bool ToggleSelectableRow<T>(object originalSource) where T : class
    {
        if (originalSource is not DependencyObject dependencyObject)
        {
            return false;
        }

        if (FindAncestor<CheckBox>(dependencyObject) is not null)
        {
            return false;
        }

        var row = FindAncestor<DataGridRow>(dependencyObject);
        if (row?.Item is not T entry)
        {
            return false;
        }

        var property = typeof(T).GetProperty("IsSelected");
        if (property?.PropertyType != typeof(bool) || !property.CanWrite)
        {
            return false;
        }

        var currentValue = (bool)(property.GetValue(entry) ?? false);
        property.SetValue(entry, !currentValue);
        return true;
    }

    private void NestedScrollable_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (sender is not DependencyObject source || e.Handled)
        {
            return;
        }

        var parent = VisualTreeHelper.GetParent(source);
        ScrollViewer? targetScrollViewer = null;
        while (parent is not null)
        {
            if (parent is ScrollViewer scrollViewer)
            {
                targetScrollViewer = scrollViewer;
            }

            parent = VisualTreeHelper.GetParent(parent);
        }

        if (targetScrollViewer is null || ReferenceEquals(targetScrollViewer, sender))
        {
            return;
        }

        e.Handled = true;
        targetScrollViewer.ScrollToVerticalOffset(targetScrollViewer.VerticalOffset - e.Delta);
    }

    private void ApplyDashboard(DashboardState dashboard)
    {
        _dashboard = dashboard;
        _session = dashboard.MyRealmSession;
        _suspendUiEvents = true;

        try
        {
            PopulateProfiles(dashboard.Config.Profiles, dashboard.Config.SelectedProfileId);
            PopulateDashboardSummary(dashboard);
            PopulateGameBridgeTargets(dashboard);
            PopulateDiagnosticsSummary(dashboard);
            PopulateMyRealmTab(dashboard.MyRealmSession, dashboard.Config.MyRealmFlow);

            var selectedProfile = GetSelectedProfile(dashboard.Config);
            if (!_profileDirty && selectedProfile is not null)
            {
                PopulateProfileEditor(selectedProfile);
            }

            if (!_realmDirty)
            {
                PopulateRealmEditor(dashboard.Config.RealmSettings);
            }

            if (!_operationsDirty)
            {
                PopulateOperationsEditor(dashboard.Config.OperationsSettings);
            }

            if (!_eventDirty)
            {
                PopulateEventCycleLibrary(dashboard.Config);
                PopulateEventTab(GetSelectedEventTileCycle(dashboard.Config), dashboard.MyRealmSession);
            }
        }
        finally
        {
            _suspendUiEvents = false;
        }
    }

    private void PopulateProfiles(IReadOnlyList<LaunchProfile> profiles, string? selectedProfileId)
    {
        ProfilesListBox.ItemsSource = null;
        ProfilesListBox.ItemsSource = profiles;
        ProfilesListBox.SelectedItem = profiles.FirstOrDefault(entry => entry.Id == selectedProfileId) ?? profiles.FirstOrDefault();
    }

    private void PopulateGameBridgeTargets(DashboardState dashboard)
    {
        var previous = GameBridgeTargetComboBox.SelectedItem as GameBridgeTargetOption;
        var options = new List<GameBridgeTargetOption>
        {
            new() { Label = "All servers", Scope = "global" },
        };

        foreach (var server in dashboard.LiveServers.Where(server => !string.IsNullOrWhiteSpace(server.Identifier)))
        {
            var identifier = server.Identifier!.Trim();
            var tileName = string.IsNullOrWhiteSpace(server.Map) ? "Not hosting yet" : server.Map!.Trim();
            options.Add(new GameBridgeTargetOption
            {
                Label = $"{tileName} ({identifier})",
                Scope = "tile",
                Identifier = identifier,
                TileName = tileName,
            });
        }

        GameBridgeTargetComboBox.ItemsSource = options;
        GameBridgeTargetComboBox.SelectedItem =
            options.FirstOrDefault(option =>
                option.Scope == previous?.Scope &&
                string.Equals(option.Identifier, previous?.Identifier, StringComparison.OrdinalIgnoreCase)) ??
            options.First();
    }

    private void PopulateDashboardSummary(DashboardState dashboard)
    {
        var selectedProfile = GetSelectedProfile(dashboard.Config);
        var selectedCycle = GetSelectedEventTileCycle(dashboard.Config);
        var selectedName = selectedProfile?.Name ?? "None";
        var launchPhaseLabel = FormatLaunchPhase(dashboard.LaunchStatus.Phase, dashboard.LaunchStatus);
        var publicIp = dashboard.Config.OperationsSettings.LastKnownPublicIp;
        var localIp = dashboard.NetworkAddresses.LocalIp;
        var launchSummary = string.IsNullOrWhiteSpace(dashboard.LaunchStatus.Summary) ? "No realm hosts are queued or running right now." : dashboard.LaunchStatus.Summary;
        var myRealmStatus = dashboard.MyRealmSession is null ? "Disconnected" : $"{dashboard.MyRealmSession.RealmName} ({dashboard.MyRealmSession.ActiveTiles ?? 0} active tiles)";
        var installedMods = dashboard.Mods.Count((mod) => mod.ServerInstalled);
        var configuredMods = dashboard.Mods.Count;
        var modSummary = configuredMods == 0
            ? "No workshop mods configured."
            : $"{installedMods} of {configuredMods} configured workshop mod(s) are installed on the server.";

        DashboardSelectedHostText.Text = selectedName;
        DashboardPublicIpText.Text = string.IsNullOrWhiteSpace(publicIp) ? "Not set" : publicIp;
        DashboardLocalIpText.Text = string.IsNullOrWhiteSpace(localIp) ? "Unknown" : localIp;
        DashboardLaunchSummaryText.Text = launchSummary;

        HeaderSelectedText.Text = $"Selected host: {selectedName}";
        HeaderLaunchText.Text = $"Launch phase: {launchPhaseLabel}";
        SidebarSelectedHostText.Text = $"Selected host: {selectedName}";
        SidebarLaunchPhaseText.Text = $"Launch phase: {launchPhaseLabel}";
        SidebarRunningHostsText.Text = $"Running hosts: {dashboard.LaunchStatus.ProcessHosts}";
        SidebarDesiredHostsText.Text = $"Desired hosts: {dashboard.LaunchStatus.DesiredHosts}";
        SidebarEventPhaseText.Text = $"Event phase: {selectedCycle.Phase}";
        SidebarMyRealmText.Text = $"MyRealm: {myRealmStatus}";

        StatusLogTextBox.Text =
            $"Launch: {dashboard.LaunchStatus.Summary}{Environment.NewLine}" +
            $"Restart schedule: {dashboard.SchedulerStatus.RestartScheduleLabel} | Next: {FormatAuditDate(dashboard.SchedulerStatus.NextRestartAt)} | Skip active: {(dashboard.SchedulerStatus.SkipActive ? "yes" : "no")}{Environment.NewLine}" +
            $"Scheduler: {dashboard.SchedulerStatus.LastAction}{Environment.NewLine}" +
            $"Event cycle: {selectedCycle.LastAction}{Environment.NewLine}" +
            $"Mods: {modSummary}";

        var activeCycles = GetEventCycles(dashboard.Config)
            .Where(cycle => cycle.Enabled || cycle.Phase != "idle" || cycle.PreviewTileIds.Count > 0 || cycle.ActiveTileIds.Count > 0)
            .Select(BuildCycleAuditLine)
            .ToList();
        var pendingActionLabel = dashboard.SchedulerStatus.PendingAction switch
        {
            "stop" => "Maintenance stop queued",
            "restart" => "Restart queued",
            _ => "No queued maintenance",
        };
        var pendingTimeLabel = string.IsNullOrWhiteSpace(dashboard.SchedulerStatus.NextRestartAt)
            ? "Not scheduled"
            : FormatAuditDate(dashboard.SchedulerStatus.NextRestartAt);
        var lastWebhookLabel = string.IsNullOrWhiteSpace(dashboard.SchedulerStatus.LastWebhookTitle)
            ? "No webhook sent yet"
            : $"{dashboard.SchedulerStatus.LastWebhookTitle} at {FormatAuditDate(dashboard.SchedulerStatus.LastWebhookAt)}";

        AuditStatusTextBox.Text =
            $"Queue: {pendingActionLabel}{Environment.NewLine}" +
            $"Target: {dashboard.SchedulerStatus.PendingTargetSummary ?? "None"}{Environment.NewLine}" +
            $"When: {pendingTimeLabel}{Environment.NewLine}" +
            $"Reason: {dashboard.SchedulerStatus.PendingReason ?? "None"}{Environment.NewLine}" +
            $"Last webhook: {lastWebhookLabel}{Environment.NewLine}" +
            $"Cycles:{Environment.NewLine}" +
            $"{(activeCycles.Count > 0 ? string.Join(Environment.NewLine, activeCycles) : "No active or queued event cycles.")}";

        LiveServersGrid.ItemsSource = dashboard.LiveServers;
        InstalledModsGrid.ItemsSource = dashboard.Mods;
        ModActionSummaryTextBlock.Text = BuildModActionSummary(dashboard);
    }

    private void PopulateDiagnosticsSummary(DashboardState dashboard)
    {
        HealthChecksGrid.ItemsSource = dashboard.Health;

        var operations = dashboard.Config.OperationsSettings;
        var scheduler = dashboard.SchedulerStatus;
        var selectedProfile = GetSelectedProfile(dashboard.Config);
        RestartLockStatusText.Text =
            $"Schedule: {scheduler.RestartScheduleLabel}{Environment.NewLine}" +
            $"Next restart: {FormatAuditDate(scheduler.NextRestartAt)}{Environment.NewLine}" +
            $"Skip active: {(scheduler.SkipActive ? "yes" : "no")}{Environment.NewLine}" +
            $"Queued action: {scheduler.PendingAction ?? "none"}{Environment.NewLine}" +
            $"Source: {scheduler.PendingSource ?? "none"}{Environment.NewLine}" +
            $"Reason: {scheduler.PendingReason ?? "none"}{Environment.NewLine}" +
            $"Selected host restart enabled: {(selectedProfile?.RestartPolicy.Enabled == true ? "yes" : "no")}";

        WarningDestinationsText.Text =
            $"Discord maintenance/update: {(string.IsNullOrWhiteSpace(operations.DiscordUpdateWebhookUrl) ? "not configured" : "configured")}{Environment.NewLine}" +
            $"Discord MyRealm: {(string.IsNullOrWhiteSpace(operations.DiscordMyRealmWebhookUrl) ? "not configured" : "configured")}{Environment.NewLine}" +
            $"Discord event tiles: {(string.IsNullOrWhiteSpace(operations.DiscordEventTileWebhookUrl) ? "not configured" : "configured")}{Environment.NewLine}" +
            "Local log: enabled through manager audit/status log" + Environment.NewLine +
            "Game bridge: local queue is ready; the mod must poll it before players see messages";

        if (string.IsNullOrWhiteSpace(MessageBridgeStatusText.Text))
        {
            MessageBridgeStatusText.Text = "Not checked in this session. Use Check Message Bridge for the current bridge status.";
        }

        ApplySafeMode();
    }

    private void ApplyMessageBridgeStatus(InGameMessageBridgeStatus status)
    {
        var endpoint = status.PollEndpoint ?? status.Endpoint ?? "none";
        var lastPoll = string.IsNullOrWhiteSpace(status.LastPollAt) ? "No mod has polled yet" : FormatAuditDate(status.LastPollAt);
        var client = string.IsNullOrWhiteSpace(status.LastClientId) ? "none" : status.LastClientId;
        var map = string.IsNullOrWhiteSpace(status.LastClientMap) ? "unknown" : status.LastClientMap;
        var version = string.IsNullOrWhiteSpace(status.LastClientVersion) ? "unknown" : status.LastClientVersion;
        var discordBotStatus = status.DiscordBot is null
            ? "Discord bot: status not reported"
            : $"Discord bot: {(status.DiscordBot.Enabled ? "enabled" : "disabled")} | Channel: {status.DiscordBot.ChannelId ?? "none"} | {status.DiscordBot.Status}" +
              (string.IsNullOrWhiteSpace(status.DiscordBot.LastError) ? "" : $" | Last error: {status.DiscordBot.LastError}");

        var summary =
            $"Configured: {(status.Configured ? "yes" : "no")}{Environment.NewLine}" +
            $"Mode: {status.Mode}{Environment.NewLine}" +
            $"Poll endpoint: {endpoint}{Environment.NewLine}" +
            $"Admin endpoint: {status.AdminEndpoint ?? "none"}{Environment.NewLine}" +
            $"Chat endpoint: {status.ChatEndpoint ?? "none"}{Environment.NewLine}" +
            $"Admin.json commands: {(status.MarkerMessagesEnabled ? "enabled" : "disabled")}{Environment.NewLine}" +
            $"Inbox root: {status.MarkerInboxRootPath ?? "not configured"}{Environment.NewLine}" +
            $"Command file: {status.MarkerInboxPath ?? "not configured"}{Environment.NewLine}" +
            $"No-widget file: {status.MarkerGlobalNoWidgetPath ?? "not configured"}{Environment.NewLine}" +
            $"Tile widget folder: {status.MarkerTileInboxPath ?? "not configured"}{Environment.NewLine}" +
            $"Tile no-widget folder: {status.MarkerTileNoWidgetInboxPath ?? "not configured"}{Environment.NewLine}" +
            $"Tile Discord folder: {status.MarkerTileDiscordInboxPath ?? "not configured"}{Environment.NewLine}" +
            $"Queue: {status.PendingCount} pending / {status.QueueDepth} total / {status.DeliveredCount} delivered-not-acked{Environment.NewLine}" +
            $"Last mod poll: {lastPoll}{Environment.NewLine}" +
            $"Last client: {client} | Version: {version} | Map: {map}{Environment.NewLine}" +
            $"{discordBotStatus}{Environment.NewLine}" +
            $"Chat log: {status.ChatLogPath ?? "not created yet"}{Environment.NewLine}" +
            status.Note;

        MessageBridgeStatusText.Text =
            $"Pending HTTP queue: {status.PendingCount} / History: {status.QueueDepth}{Environment.NewLine}" +
            $"Inbox root: {status.MarkerInboxRootPath ?? status.MarkerInboxPath ?? "not configured"}{Environment.NewLine}" +
            $"Last mod poll: {lastPoll}{Environment.NewLine}" +
            $"{discordBotStatus}{Environment.NewLine}" +
            status.Note;
        GameBridgeStatusTextBox.Text = summary;
    }

    private static string FormatAuditDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "Unknown";
        }

        return DateTime.TryParse(value, out var parsed)
            ? parsed.ToLocalTime().ToString("g")
            : value;
    }

    private static string FormatLaunchPhase(string? phase, LaunchStatus? status = null)
    {
        return (phase ?? "").Trim().ToLowerInvariant() switch
        {
            "warming" => status?.ProcessHosts > 0 || status?.HostingReadyHosts > 0 ? "running" : "starting",
            "idle" => "idle",
            "starting" => "starting",
            "running" => "running",
            "live" => "live",
            var value when string.IsNullOrWhiteSpace(value) => "unknown",
            var value => value,
        };
    }

    private static string BuildCycleAuditLine(EventTileCycleState cycle)
    {
        var trackedCount = cycle.PreviewTileIds.Count + cycle.ActiveTileIds.Count;
        var nextTransition = cycle.NextTransitionAt is null ? "Waiting" : FormatAuditDate(cycle.NextTransitionAt);
        var cleanupBatches = cycle.CleanupBatches.Count;
        var nextCleanup = cycle.CleanupBatches
            .Select(batch => batch.DeleteAfter)
            .Where(value => DateTime.TryParse(value, out _))
            .OrderBy(value => DateTime.Parse(value!))
            .FirstOrDefault();
        var cleanupLabel = cleanupBatches > 0
            ? $" | cleanup {cleanupBatches} | next cleanup {FormatAuditDate(nextCleanup)}"
            : "";
        return $"- {cycle.Name}: {cycle.Phase} | tracked {trackedCount} | next {nextTransition}{cleanupLabel}";
    }

    private static string BuildModActionSummary(DashboardState dashboard)
    {
        var configuredMods = dashboard.Mods.Count;
        if (configuredMods == 0)
        {
            return "No workshop mods are configured yet. Use \"Install Mod From URL / ID\" to add one cleanly, or paste raw IDs into the list above if you prefer.";
        }

        var installedMods = dashboard.Mods.Count(mod => mod.ServerInstalled);
        var updatePending = dashboard.Mods.Count(mod => mod.UpdateAvailable);
        var pendingMods = dashboard.Mods
            .Where(mod => mod.UpdateAvailable)
            .Select(mod => mod.DisplayTitle)
            .Take(3)
            .ToList();
        var newestServerTimestamp = dashboard.Mods
            .Select(mod => mod.ServerUpdatedAt)
            .Where(value => DateTime.TryParse(value, out _))
            .OrderByDescending(value => DateTime.Parse(value!))
            .FirstOrDefault();
        var newestWorkshopTimestamp = dashboard.Mods
            .Select(mod => mod.WorkshopUpdatedAt)
            .Where(value => DateTime.TryParse(value, out _))
            .OrderByDescending(value => DateTime.Parse(value!))
            .FirstOrDefault();
        var restartQueued =
            dashboard.SchedulerStatus.PendingAction == "restart" &&
            dashboard.SchedulerStatus.PendingSource == "mod-update";
        var restartSummary = restartQueued
            ? $"Restart queued: {FormatAuditDate(dashboard.SchedulerStatus.NextRestartAt)}"
            : "Restart queued: none";
        var pendingSummary = updatePending == 0
            ? "Pending updates: none"
            : $"Pending updates: {string.Join(", ", pendingMods)}{(updatePending > pendingMods.Count ? $" +{updatePending - pendingMods.Count} more" : "")}";

        return
            $"Configured: {configuredMods}{Environment.NewLine}" +
            $"Installed on server: {installedMods}{Environment.NewLine}" +
            $"Updates waiting: {updatePending}{Environment.NewLine}" +
            $"{pendingSummary}{Environment.NewLine}" +
            $"Latest server copy: {FormatAuditDate(newestServerTimestamp)}{Environment.NewLine}" +
            $"Latest workshop update: {FormatAuditDate(newestWorkshopTimestamp)}{Environment.NewLine}" +
            restartSummary;
    }

    private void PopulateProfileEditor(LaunchProfile profile)
    {
        ProfileNameTextBox.Text = profile.Name;
        IdentifierTextBox.Text = profile.Launch.Identifier;
        GamePortTextBox.Text = profile.Launch.Port.ToString();
        QueryPortTextBox.Text = (profile.Launch.QueryPort ?? 0).ToString();
        SlotsTextBox.Text = profile.Launch.Slots.ToString();
        OverrideAddressTextBox.Text = profile.Launch.OverrideConnectionAddress;
        ExtraArgsTextBox.Text = profile.Launch.ExtraArgs;
        EnableLogsCheckBox.IsChecked = profile.Launch.EnableLogs;
        ForceSteamLinkCheckBox.IsChecked = profile.Launch.ForceSteamClientLink;
        MessagingCheckBox.IsChecked = profile.Launch.Messaging;
        EnableCheatsCheckBox.IsChecked = profile.Launch.EnableCheats;
        NoLiveServerCheckBox.IsChecked = profile.Launch.NoLiveServer;
        RestartEnabledCheckBox.IsChecked = profile.RestartPolicy.Enabled;
        var firstRestartTime = ResolveFirstRestartTime(profile.RestartPolicy);
        RestartStartTimeTextBox.Text = firstRestartTime;
        SelectComboByValue(RestartTimesPerDayComboBox, InferRestartsPerDay(profile.RestartPolicy).ToString());
        RestartWarningMinutesTextBox.Text = Math.Max(30, profile.RestartPolicy.GracefulWarningMinutes == 0 ? 30 : profile.RestartPolicy.GracefulWarningMinutes).ToString();
        UpdateRestartSchedulePreview();
        _profileDirty = false;
    }

    private static string ResolveFirstRestartTime(RestartPolicy policy)
    {
        if (policy.FixedTimes.Count > 0)
        {
            return policy.FixedTimes.OrderBy(value => value).First();
        }

        return "00:00";
    }

    private static int InferRestartsPerDay(RestartPolicy policy)
    {
        if (string.Equals(policy.ScheduleMode, "interval", StringComparison.OrdinalIgnoreCase) && policy.IntervalHours > 0)
        {
            return Math.Clamp(24 / Math.Clamp(policy.IntervalHours, 1, 24), 1, 12);
        }

        return Math.Clamp(policy.FixedTimes.Count == 0 ? 2 : policy.FixedTimes.Count, 1, 12);
    }

    private void UpdateRestartSchedulePreview()
    {
        try
        {
            var firstRestart = TimeSpan.TryParse(RestartStartTimeTextBox.Text.Trim(), out var parsed)
                ? new TimeSpan(parsed.Hours, parsed.Minutes, 0)
                : TimeSpan.Zero;
            var restartsPerDay = int.TryParse((RestartTimesPerDayComboBox.SelectedItem as ComboBoxItem)?.Tag?.ToString(), out var count)
                ? Math.Clamp(count, 1, 12)
                : 2;
            var intervalMinutes = 24 * 60 / restartsPerDay;
            var times = Enumerable.Range(0, restartsPerDay)
                .Select(index => firstRestart.Add(TimeSpan.FromMinutes(intervalMinutes * index)))
                .Select(time => TimeSpan.FromMinutes(time.TotalMinutes % (24 * 60)))
                .OrderBy(time => time)
                .Select(time => $"{time.Hours:00}:{time.Minutes:00}")
                .ToList();

            RestartSchedulePreviewText.Text = $"Will restart at: {string.Join(" / ", times)}";
        }
        catch
        {
            RestartSchedulePreviewText.Text = "Enter a first restart time like 00:00, then choose how many restarts per day.";
        }
    }

    private void PopulateRealmEditor(RealmSettings realm)
    {
        CustomerKeyTextBox.Text = realm.CustomerKey;
        ProviderKeyTextBox.Text = realm.ProviderKey;
        ProviderNameTextBox.Text = realm.ProviderName;
        ApiKeyTextBox.Text = realm.ApiKey;
        _realmDirty = false;
    }

    private void PopulateOperationsEditor(OperationsSettings operations)
    {
        LastKnownPublicIpTextBox.Text = operations.LastKnownPublicIp;
        SteamCmdPathTextBox.Text = operations.SteamCmdPath;
        SteamCmdInstallDirectoryTextBox.Text = operations.SteamCmdInstallDirectory;
        WorkshopContentPathTextBox.Text = operations.WorkshopContentPath;
        AppIdTextBox.Text = operations.AppId.ToString();
        BetaBranchTextBox.Text = operations.BetaBranch;
        ModIdsTextBox.Text = string.Join(Environment.NewLine, operations.ModIds);
        DeleteMissingModsCheckBox.IsChecked = operations.ModSyncDeletesMissing;
        AutoUpdateModsCheckBox.IsChecked = operations.AutoUpdateMods;
        AutoUpdateGameServerCheckBox.IsChecked = operations.AutoUpdateGameServer;
        AutoRestartRealmsCheckBox.IsChecked = operations.AutoRestartOfflineRealms;
        GameBridgeModMessagesCheckBox.IsChecked = operations.GameBridgeModMessagesEnabled;
        GameBridgeInboxRootPathTextBox.Text = operations.GameBridgeInboxRootPath;
        GameBridgeCommandFilePathTextBox.Text = operations.GameBridgeCommandFilePath;
        ModUpdateCheckMinutesTextBox.Text = operations.ModUpdateCheckMinutes.ToString();
        GameUpdateCheckMinutesTextBox.Text = (operations.GameUpdateCheckMinutes > 0 ? operations.GameUpdateCheckMinutes : operations.ModUpdateCheckMinutes).ToString();
        ModUpdateGraceMinutesTextBox.Text = Math.Max(15, operations.ModUpdateGraceMinutes).ToString();
        OfflineRestartGraceMinutesTextBox.Text = operations.OfflineRestartGraceMinutes.ToString();
        MyRealmWebhookTextBox.Text = string.IsNullOrWhiteSpace(operations.DiscordMyRealmWebhookUrl)
            ? (!string.IsNullOrWhiteSpace(operations.DiscordTileOnlineWebhookUrl)
                ? operations.DiscordTileOnlineWebhookUrl
                : operations.DiscordPlayerCounterWebhookUrl)
            : operations.DiscordMyRealmWebhookUrl;
        UpdateWebhookTextBox.Text = operations.DiscordUpdateWebhookUrl;
        EventTileWebhookTextBox.Text = operations.DiscordEventTileWebhookUrl;
        GameChatWebhookTextBox.Text = operations.DiscordGameChatWebhookUrl;
        DiscordReplyBotEnabledCheckBox.IsChecked = operations.DiscordBotEnabled;
        DiscordReplyBotTokenTextBox.Password = operations.DiscordBotToken;
        DiscordReplyBotChannelIdTextBox.Text = operations.DiscordBotChannelId;
        MaintenanceRoleIdTextBox.Text = operations.DiscordMaintenanceRoleId;
        _operationsDirty = false;
    }

    private void PopulateMyRealmTab(MyRealmSessionSnapshot? session, MyRealmFlowSummary? flow)
    {
        MyRealmCustomerText.Text = session?.CustomerName ?? "Not connected";
        MyRealmRealmText.Text = session?.RealmName ?? "Not connected";
        MyRealmTilesText.Text = session is null ? "-" : $"{session.ActiveTiles ?? 0} / {session.MaxTiles ?? 0}";
        MyRealmPlayersText.Text = session?.ActivePlayers?.ToString() ?? "-";
        MyRealmNoteText.Text = session?.Note ?? flow?.Note ?? "Load a live MyRealm session to read the authenticated realm directly.";
        MyRealmTilesGrid.ItemsSource = session?.Tiles ?? new List<MyRealmTileSummary>();
        UpdateSelectedTileDetails(MyRealmTilesGrid.SelectedItem as MyRealmTileSummary);
    }

    private void PopulateEventCycleLibrary(AppConfig config)
    {
        var cycles = GetEventCycles(config);
        EventCyclesGrid.ItemsSource = cycles;
        EventCycleSelectorComboBox.ItemsSource = cycles;

        var selectedCycle = GetSelectedEventTileCycle(config);
        EventCycleSelectorComboBox.SelectedItem = cycles.FirstOrDefault(entry => entry.Id == selectedCycle.Id) ?? cycles.FirstOrDefault();
        EventCyclesGrid.SelectedItem = cycles.FirstOrDefault(entry => entry.Id == selectedCycle.Id) ?? cycles.FirstOrDefault();
    }

    private void PopulateEventTab(EventTileCycleState state, MyRealmSessionSnapshot? session)
    {
        EventEditorGroupBox.Header = $"Cycle Settings: {state.Name}";
        CycleNameTextBox.Text = state.Name;
        CycleSizeTextBox.Text = state.CycleSize.ToString();
        PreviewHoursTextBox.Text = state.PreviewHours.ToString();
        ActiveHoursTextBox.Text = state.ActiveHours.ToString();
        DeleteGraceHoursTextBox.Text = state.DeleteGraceHours.ToString();
        NamePrefixTextBox.Text = state.NamePrefix;
        SpacingRadiusTextBox.Text = state.SpacingRadius.ToString();
        FixedQualityTextBox.Text = state.Quality.ToString();
        QualityMinTextBox.Text = state.QualityMin.ToString();
        QualityMaxTextBox.Text = state.QualityMax.ToString();
        SelectComboByValue(QualityModeComboBox, state.QualityMode);
        SelectComboByValue(PvpModeComboBox, state.PvpMode);
        EventAutoAdvanceCheckBox.IsChecked = state.AutoAdvance;

        EventPhaseValueText.Text = state.Phase;
        EventPreviewBatchText.Text = BuildBatchLabel(state.PreviewTileIds, session);
        EventActiveBatchText.Text = BuildBatchLabel(state.ActiveTileIds, session);
        EventLastActionText.Text = state.LastAction;

        var selectedMaps = state.AllowedMapIds.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var mapOptions = session?.AvailableCreateTileMaps?.Count > 0 ? session.AvailableCreateTileMaps : BuiltinMapOptions;
        _allowedMaps.Clear();
        foreach (var option in mapOptions)
        {
            _allowedMaps.Add(new SelectableMapOption
            {
                IsSelected = selectedMaps.Contains(option.MapId) || selectedMaps.Contains(option.MapName),
                MapId = option.MapId,
                MapName = option.MapName,
                Difficulty = option.Difficulty,
            });
        }

        var selectedTiles = state.EligibleTileIds.ToHashSet();
        _anchorTiles.Clear();
        foreach (var tile in session?.Tiles ?? [])
        {
            _anchorTiles.Add(new SelectableTileOption
            {
                IsSelected = selectedTiles.Contains(tile.TileId),
                TileId = tile.TileId,
                TileName = tile.TileName,
                MapName = tile.MapName,
                StatusText = tile.StatusText,
                X = tile.X,
                Y = tile.Y,
            });
        }

        _eventDirty = false;
    }

    private void UpdateMonitorUi(MonitorState monitor)
    {
        var launchPhaseLabel = FormatLaunchPhase(monitor.LaunchPhase, new LaunchStatus
        {
            ProcessHosts = monitor.RunningHosts,
            HostingReadyHosts = monitor.RunningHosts,
            WarmingHosts = monitor.WarmingHosts,
            PendingHosts = monitor.PendingHosts,
        });
        BackendStateText.Text = monitor.Online ? "Backend: online" : "Backend: offline";
        BackendStateText.Foreground = monitor.Online ? new SolidColorBrush(Color.FromRgb(216, 164, 93)) : Brushes.IndianRed;
        HeaderSelectedText.Text = $"Selected host: {monitor.SelectedProfileName ?? "None"}";
        HeaderLaunchText.Text = $"Launch phase: {launchPhaseLabel}";
        SidebarSelectedHostText.Text = $"Selected host: {monitor.SelectedProfileName ?? "None"}";
        SidebarLaunchPhaseText.Text = $"Launch phase: {launchPhaseLabel}";
        SidebarRunningHostsText.Text = $"Running hosts: {monitor.RunningHosts}";
        SidebarDesiredHostsText.Text = $"Desired hosts: {monitor.DesiredHosts}";
        SidebarEventPhaseText.Text = $"Event phase: {monitor.EventPhase}";
    }

    private static void SelectComboByValue(ComboBox comboBox, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            comboBox.SelectedIndex = 0;
            return;
        }

        foreach (var item in comboBox.Items.OfType<ComboBoxItem>())
        {
            var candidateValue = item.Tag?.ToString() ?? item.Content?.ToString();
            if (string.Equals(candidateValue, value, StringComparison.OrdinalIgnoreCase))
            {
                comboBox.SelectedItem = item;
                return;
            }
        }

        comboBox.SelectedIndex = 0;
    }

    private static string BuildBatchLabel(IEnumerable<long> tileIds, MyRealmSessionSnapshot? session)
    {
        var ids = tileIds.ToList();
        if (ids.Count == 0)
        {
            return "None tracked";
        }

        var names = session?.Tiles
            .Where(tile => ids.Contains(tile.TileId))
            .Select(tile => tile.TileName)
            .ToList() ?? [];

        return names.Count > 0 ? string.Join(", ", names) : string.Join(", ", ids);
    }

    private LaunchProfile? GetSelectedProfile(AppConfig? config = null)
    {
        var source = config ?? _dashboard?.Config;
        if (source is null)
        {
            return null;
        }

        return source.Profiles.FirstOrDefault(entry => entry.Id == source.SelectedProfileId)
            ?? source.Profiles.FirstOrDefault();
    }

    private static IReadOnlyList<EventTileCycleState> GetEventCycles(AppConfig config)
    {
        return config.EventTileCycles is { Count: > 0 } ? config.EventTileCycles : [config.EventTileCycle];
    }

    private static EventTileCycleState GetSelectedEventTileCycle(AppConfig config)
    {
        return GetEventCycles(config).FirstOrDefault(entry => entry.Id == config.SelectedEventTileCycleId)
            ?? GetEventCycles(config).First();
    }

    private static T DeepClone<T>(T value)
    {
        var json = JsonSerializer.Serialize(value);
        return JsonSerializer.Deserialize<T>(json) ?? throw new InvalidOperationException("Failed to clone the current state.");
    }

    private void AllowedMapsGrid_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (_suspendUiEvents)
        {
            return;
        }

        if (ToggleSelectableRow<SelectableMapOption>(e.OriginalSource))
        {
            _eventDirty = true;
            MarkEditorInteraction();
            AllowedMapsGrid.Items.Refresh();
            e.Handled = true;
        }
    }

    private void AnchorTilesGrid_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (_suspendUiEvents)
        {
            return;
        }

        if (ToggleSelectableRow<SelectableTileOption>(e.OriginalSource))
        {
            _eventDirty = true;
            MarkEditorInteraction();
            AnchorTilesGrid.Items.Refresh();
            e.Handled = true;
        }
    }

    private async void EventCycleSelectorComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        await ChangeSelectedEventCycleFromUiAsync(EventCycleSelectorComboBox.SelectedItem as EventTileCycleState);
    }

    private async void EventCyclesGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        await ChangeSelectedEventCycleFromUiAsync(EventCyclesGrid.SelectedItem as EventTileCycleState);
    }

    private async Task ChangeSelectedEventCycleFromUiAsync(EventTileCycleState? cycle)
    {
        if (_suspendUiEvents || cycle is null || _dashboard is null)
        {
            return;
        }

        if (_dashboard.Config.SelectedEventTileCycleId == cycle.Id)
        {
            return;
        }

        if (_eventDirty)
        {
            var shouldContinue = MessageBox.Show(
                "Unsaved event-cycle edits will be discarded if you switch cycles now. Continue?",
                "Discard unsaved changes?",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);

            if (shouldContinue != MessageBoxResult.Yes)
            {
                _suspendUiEvents = true;
                PopulateEventCycleLibrary(_dashboard.Config);
                _suspendUiEvents = false;
                return;
            }
        }

        try
        {
            var response = await _client.SelectEventCycleAsync(cycle.Id);
            _eventDirty = false;
            ApplyReturnedConfig(response.Config);
            QueueRefresh(false);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private static int ParseRequiredInt(string raw, string label)
    {
        if (!int.TryParse(raw, out var value))
        {
            throw new InvalidOperationException($"{label} must be a whole number.");
        }

        return value;
    }

    private void SetActionStatus(string message, bool error = false)
    {
        ActionStatusTextBlock.Text = message;
        ActionStatusTextBlock.Foreground = error ? Brushes.IndianRed : new SolidColorBrush(Color.FromRgb(216, 164, 93));
    }

    private void ApplySafeMode()
    {
        var allowDangerousActions = !_safeMode;
        DeleteProfileButton.IsEnabled = allowDangerousActions;
        StopAllButton.IsEnabled = allowDangerousActions;
        SafeStopButton.IsEnabled = allowDangerousActions;
        ApplyServerUpdateButton.IsEnabled = allowDangerousActions;
        InstallWorkshopModButton.IsEnabled = allowDangerousActions;
        SyncModsButton.IsEnabled = allowDangerousActions;
        ReconcileModsButton.IsEnabled = allowDangerousActions;
        CheckModUpdatesButton.IsEnabled = allowDangerousActions;
        DeleteEventCycleButton.IsEnabled = allowDangerousActions;
        ForceCleanupCycleButton.IsEnabled = allowDangerousActions;
        CreateNextBatchButton.IsEnabled = allowDangerousActions;
        AdvanceCycleButton.IsEnabled = allowDangerousActions;
    }

    private void UpdateSelectedTileDetails(MyRealmTileSummary? tile)
    {
        if (tile is null)
        {
            SelectedTileDetailsText.Text = "Select a tile above to inspect its ID, map, quality, PvP mode, coordinates, and available panel actions.";
            return;
        }

        SelectedTileDetailsText.Text =
            $"Tile ID: {tile.TileId}{Environment.NewLine}" +
            $"Name: {tile.TileName}{Environment.NewLine}" +
            $"Map: {tile.MapName ?? "unknown"} | Quality: {tile.Quality?.ToString() ?? "unknown"} | PvP: {tile.PvpModeText ?? "unknown"}{Environment.NewLine}" +
            $"Coordinates: {tile.X?.ToString() ?? "?"}, {tile.Y?.ToString() ?? "?"}{Environment.NewLine}" +
            $"Status: {tile.StatusText ?? "unknown"} | Hosting: {tile.HostingStatusText ?? "unknown"} | Players: {tile.PlayerCount?.ToString() ?? "0"}{Environment.NewLine}" +
            $"Panel actions: activate {(tile.CanActivate ? "yes" : "no")}, deactivate {(tile.CanDeactivate ? "yes" : "no")}, delete {(tile.CanDelete ? "yes" : "no")}, automation {(tile.CanUseAutomation ? "yes" : "no")}";
    }

    private void HandleOfflineState(string message)
    {
        BackendStateText.Text = "Backend: offline";
        BackendStateText.Foreground = Brushes.IndianRed;
        AuditStatusTextBox.Text = "Backend offline. Audit data will refresh once the control center reconnects.";
        ModActionSummaryTextBlock.Text = "Backend offline. Mod actions will light back up once the control center reconnects.";
        RestartLockStatusText.Text = "Backend offline. Restart and update lock status will refresh after reconnect.";
        WarningDestinationsText.Text = "Backend offline. Warning destinations will refresh after reconnect.";
        MessageBridgeStatusText.Text = "Backend offline. Message bridge status is not available.";
        GameBridgeStatusTextBox.Text = "Backend offline. Game bridge queue and chat log are not available.";
        GameBridgeMessagesGrid.ItemsSource = Array.Empty<GameBridgeMessage>();
        GameBridgeChatGrid.ItemsSource = Array.Empty<GameBridgeChatEntry>();
        SetActionStatus(message, true);
    }

    private void RefreshLocalInstallContext(bool forcePopulate = false)
    {
        var latestContext = BackendWorkspaceBootstrapper.ReadInstallContext(_workspaceRoot);
        _installContext = latestContext;
        ConfigureProfileFolderWatcher(latestContext.ProfileRoot);
        if (_installDirty && !forcePopulate)
        {
            return;
        }

        PopulateInstallContextView(latestContext);
    }

    private void ConfigureProfileFolderWatcher(string profileRoot)
    {
        var resolvedProfileRoot = "";
        try
        {
            resolvedProfileRoot = string.IsNullOrWhiteSpace(profileRoot) ? "" : Path.GetFullPath(profileRoot);
        }
        catch
        {
            resolvedProfileRoot = "";
        }

        if (string.Equals(_watchedProfileRoot, resolvedProfileRoot, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        _profileFolderWatcher?.Dispose();
        _profileFolderWatcher = null;
        _watchedProfileRoot = resolvedProfileRoot;

        if (string.IsNullOrWhiteSpace(resolvedProfileRoot) || !Directory.Exists(resolvedProfileRoot))
        {
            return;
        }

        try
        {
            _profileFolderWatcher = new FileSystemWatcher(resolvedProfileRoot)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                Filter = "*.*",
                EnableRaisingEvents = true,
            };
            _profileFolderWatcher.Changed += ProfileFolderWatcher_Changed;
            _profileFolderWatcher.Created += ProfileFolderWatcher_Changed;
            _profileFolderWatcher.Deleted += ProfileFolderWatcher_Changed;
            _profileFolderWatcher.Renamed += ProfileFolderWatcher_Changed;
        }
        catch (Exception ex)
        {
            SetActionStatus($"Profile folder watcher disabled: {ex.Message}", true);
        }
    }

    private void ProfileFolderWatcher_Changed(object sender, FileSystemEventArgs e)
    {
        if (!IsProfileSyncPath(e.FullPath))
        {
            return;
        }

        Dispatcher.BeginInvoke(() =>
        {
            var now = DateTime.UtcNow;
            if ((now - _lastProfileFolderRefreshUtc).TotalMilliseconds < 750)
            {
                return;
            }

            _lastProfileFolderRefreshUtc = now;
            RefreshLocalInstallContext();

            if (HasPendingEdits())
            {
                SetActionStatus("Profile folder changed. Finish or save the current edit before the manager auto-refreshes.");
                return;
            }

            SetActionStatus("Profile folder changed. Syncing the latest saved settings...");
            QueueRefresh(true, 250);
        });
    }

    private static bool IsProfileSyncPath(string path)
    {
        var fileName = Path.GetFileName(path);
        if (fileName.Equals("lo-tool.config.json", StringComparison.OrdinalIgnoreCase) ||
            fileName.Equals("install-context.json", StringComparison.OrdinalIgnoreCase) ||
            fileName.Equals("index.json", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (!fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return path.IndexOf($"{Path.DirectorySeparatorChar}event-cycles{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase) >= 0 ||
               path.IndexOf($"{Path.AltDirectorySeparatorChar}event-cycles{Path.AltDirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private void PopulateInstallContextView(LocalInstallContext installContext)
    {
        _suspendUiEvents = true;
        try
        {
            InstallProfileRootTextBox.Text = installContext.ProfileRoot;
            InstallContextPathTextBox.Text = installContext.InstallContextPath;
            InstallServerPathTextBox.Text = installContext.ServerPath;
            InstallSteamCmdDirectoryTextBox.Text = installContext.SteamCmdInstallDirectory;
            InstallSteamCmdPathTextBox.Text = installContext.SteamCmdPath;
            InstallWorkshopContentPathTextBox.Text = installContext.WorkshopContentPath;
            InstallWorkspaceRootTextBox.Text = installContext.ToolRoot;
            _installDirty = false;
        }
        finally
        {
            _suspendUiEvents = false;
        }
    }
}
