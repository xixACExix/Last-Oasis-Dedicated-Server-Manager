using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace Tool01.Native;

internal sealed class ControlCenterClient : IDisposable
{
    private static readonly TimeSpan QuickRequestTimeout = TimeSpan.FromSeconds(4);
    private static readonly TimeSpan MonitorRequestTimeout = TimeSpan.FromSeconds(25);
    private static readonly TimeSpan DashboardRequestTimeout = TimeSpan.FromSeconds(20);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly HttpClient _httpClient;
    private readonly string _root;
    private readonly string _startScriptPath;
    private readonly string _stopScriptPath;
    private readonly string _installAutostartScriptPath;
    private readonly string _removeAutostartScriptPath;
    private readonly string _backendPort;

    public ControlCenterClient()
    {
        _root = WorkspaceLocator.FindRoot();
        _startScriptPath = Path.Combine(_root, "scripts", "start-control-center.ps1");
        _stopScriptPath = Path.Combine(_root, "scripts", "stop-control-center.ps1");
        _installAutostartScriptPath = Path.Combine(_root, "scripts", "install-backend-autostart.ps1");
        _removeAutostartScriptPath = Path.Combine(_root, "scripts", "remove-backend-autostart.ps1");
        _backendPort = string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("PORT"))
            ? "4020"
            : Environment.GetEnvironmentVariable("PORT")!;
        _httpClient = new HttpClient
        {
            BaseAddress = new Uri($"http://localhost:{_backendPort}"),
            Timeout = TimeSpan.FromMinutes(10),
        };
    }

    public async Task<bool> IsBackendOnlineAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var timeout = CreateTimeout(QuickRequestTimeout, cancellationToken);
            using var response = await _httpClient.GetAsync("/api/health", timeout.Token);
            if (response.IsSuccessStatusCode)
            {
                return true;
            }

            if (response.StatusCode is not (HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed))
            {
                return false;
            }

            using var fallbackTimeout = CreateTimeout(QuickRequestTimeout, cancellationToken);
            using var fallbackResponse = await _httpClient.GetAsync("/api/monitor", fallbackTimeout.Token);
            return fallbackResponse.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task StartBackendAsync(CancellationToken cancellationToken = default)
    {
        if (await IsBackendOnlineAsync(cancellationToken))
        {
            return;
        }

        if (BackendWorkspaceBootstrapper.NeedsInstall(_root))
        {
            await RunInstallerAsync(_root, cancellationToken);
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{_startScriptPath}\"",
            WorkingDirectory = _root,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
            Environment =
            {
                ["PORT"] = _backendPort,
            },
        });

        await WaitForBackendAsync(TimeSpan.FromSeconds(25), cancellationToken);
    }

    public async Task RunInstallerAsync(CancellationToken cancellationToken = default)
    {
        await RunInstallerAsync(_root, cancellationToken);
    }

    public static async Task RunInstallerAsync(string root, CancellationToken cancellationToken = default)
    {
        await ShowInstallerUiAsync(root, cancellationToken);
    }

    private static async Task ShowInstallerUiAsync(string root, CancellationToken cancellationToken)
    {
        var uiScriptPath = Path.Combine(root, "scripts", "install-control-center-ui.ps1");
        if (!File.Exists(uiScriptPath))
        {
            throw new InvalidOperationException("The installer UI script is missing from the embedded workspace.");
        }

        var systemDriveRoot = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows)) ?? "C:\\";
        var seedContext = BackendWorkspaceBootstrapper.ReadInstallContext(root);
        var hasSavedInstall = !string.IsNullOrWhiteSpace(seedContext.InstalledAt);
        var seedServerPath = !hasSavedInstall || string.IsNullOrWhiteSpace(seedContext.ServerPath)
            ? Path.Combine(systemDriveRoot, "LastOasisServer")
            : seedContext.ServerPath;
        var seedSteamCmdDirectory = !hasSavedInstall || string.IsNullOrWhiteSpace(seedContext.SteamCmdInstallDirectory)
            ? Path.Combine(systemDriveRoot, "SteamCMD")
            : seedContext.SteamCmdInstallDirectory;
        var seedProfileRoot = !hasSavedInstall || string.IsNullOrWhiteSpace(seedContext.ProfileRoot)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "LO_Profiles")
            : seedContext.ProfileRoot;

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments =
                $"-NoProfile -ExecutionPolicy Bypass -STA -File \"{uiScriptPath}\" " +
                "-RunInstall " +
                $"-ServerPath \"{seedServerPath}\" " +
                $"-SteamCmdInstallDirectory \"{seedSteamCmdDirectory}\" " +
                $"-ProfileRoot \"{seedProfileRoot}\"",
            WorkingDirectory = root,
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Normal,
        };

        var process = Process.Start(startInfo);
        if (process is null)
        {
            throw new InvalidOperationException("The installer UI could not be started.");
        }

        await process.WaitForExitAsync(cancellationToken);
        if (process.ExitCode != 0)
        {
            if (BackendWorkspaceBootstrapper.NeedsInstall(root))
            {
                throw new InvalidOperationException("The installer window closed before setup completed.");
            }

            throw new OperationCanceledException("Setup was cancelled.");
        }

        if (BackendWorkspaceBootstrapper.NeedsInstall(root))
        {
            throw new InvalidOperationException("The installer finished, but the dedicated server setup did not complete.");
        }
    }

    public async Task StopBackendAsync(CancellationToken cancellationToken = default)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{_stopScriptPath}\"",
            WorkingDirectory = _root,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
            Environment =
            {
                ["PORT"] = _backendPort,
            },
        });

        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            if (!await IsBackendOnlineAsync(cancellationToken))
            {
                return;
            }

            await Task.Delay(350, cancellationToken);
        }
    }

    public async Task InstallBackendAutostartAsync(CancellationToken cancellationToken = default)
    {
        await RunPowerShellScriptAsync(_installAutostartScriptPath, $" -Port {_backendPort}", cancellationToken);
    }

    public async Task RemoveBackendAutostartAsync(CancellationToken cancellationToken = default)
    {
        await RunPowerShellScriptAsync(_removeAutostartScriptPath, "", cancellationToken);
    }

    private async Task RunPowerShellScriptAsync(string scriptPath, string extraArguments, CancellationToken cancellationToken)
    {
        if (!File.Exists(scriptPath))
        {
            throw new FileNotFoundException("The requested manager script was not found.", scriptPath);
        }

        var process = Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{scriptPath}\"{extraArguments}",
            WorkingDirectory = _root,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            Environment =
            {
                ["PORT"] = _backendPort,
            },
        });

        if (process is null)
        {
            throw new InvalidOperationException("PowerShell could not start the requested manager script.");
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
        {
            var details = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(details) ? $"Script exited with code {process.ExitCode}." : details.Trim());
        }
    }

    public async Task WaitForBackendAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        var deadline = DateTime.UtcNow.Add(timeout);
        while (DateTime.UtcNow < deadline)
        {
            if (await IsBackendOnlineAsync(cancellationToken))
            {
                return;
            }

            await Task.Delay(400, cancellationToken);
        }

        throw new InvalidOperationException("The local control center backend did not come online in time.");
    }

    public async Task<MonitorState> GetMonitorAsync(CancellationToken cancellationToken = default)
    {
        return await GetAsync<MonitorState>("/api/monitor", MonitorRequestTimeout, cancellationToken);
    }

    public async Task<DashboardState> GetDashboardAsync(CancellationToken cancellationToken = default)
    {
        return await GetAsync<DashboardState>("/api/state", DashboardRequestTimeout, cancellationToken);
    }

    public async Task<ConfigSaveResponse> SaveConfigAsync(AppConfig config, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PutAsJsonAsync("/api/config", config, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ConfigSaveResponse>(response, cancellationToken);
    }

    public async Task<RemotePasswordUpdateResponse> UpdateRemotePasswordAsync(string password, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/remote/password", new { password }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<RemotePasswordUpdateResponse>(response, cancellationToken);
    }

    public async Task<SteamLoginInfoResponse> GetSteamLoginInfoAsync(CancellationToken cancellationToken = default)
    {
        return await GetAsync<SteamLoginInfoResponse>("/api/steam-login", QuickRequestTimeout, cancellationToken);
    }

    public async Task<SteamLoginInfoResponse> SaveSteamLoginAsync(string accountName, string password, bool steamClientAutoLogin, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/steam-login", new { accountName, password, steamClientAutoLogin }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SteamLoginInfoResponse>(response, cancellationToken);
    }

    public async Task<SteamLoginInfoResponse> ClearSteamLoginAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.DeleteAsync("/api/steam-login", cancellationToken);
        return await ReadResponseAsync<SteamLoginInfoResponse>(response, cancellationToken);
    }

    public async Task<SteamClientStatusResponse> GetSteamClientStatusAsync(CancellationToken cancellationToken = default)
    {
        return await GetAsync<SteamClientStatusResponse>("/api/steam-login/client-status", QuickRequestTimeout, cancellationToken);
    }

    public async Task<SteamClientLoginResponse> LoginSteamClientAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/steam-login/client-login", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SteamClientLoginResponse>(response, cancellationToken);
    }

    public async Task<ConfigSaveResponse> SelectProfileAsync(string profileId, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/config/selected-profile", new { profileId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ConfigSaveResponse>(response, cancellationToken);
    }

    public async Task<SimpleDashboardResponse> StartSelectedAsync(string profileId, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/server/start", new { profileId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SimpleDashboardResponse>(response, cancellationToken);
    }

    public async Task<StartAllResponse> StartAllAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/server/start-all", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<StartAllResponse>(response, cancellationToken);
    }

    public async Task<SimpleDashboardResponse> StopAllAsync(bool force = false, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/server/stop", new { force }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SimpleDashboardResponse>(response, cancellationToken);
    }

    public async Task<SimpleDashboardResponse> SafeStopAsync(string reason, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/server/safe-stop", new { reason }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SimpleDashboardResponse>(response, cancellationToken);
    }

    public async Task<SimpleDashboardResponse> SkipNextRestartAsync(string profileId, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/restarts/skip-next", new { profileId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SimpleDashboardResponse>(response, cancellationToken);
    }

    public async Task<SimpleDashboardResponse> ClearRestartSkipAsync(string profileId, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/restarts/clear-skip", new { profileId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SimpleDashboardResponse>(response, cancellationToken);
    }

    public async Task<AuditEnvelope> GetAuditAsync(CancellationToken cancellationToken = default)
    {
        return await GetAsync<AuditEnvelope>("/api/audit", DashboardRequestTimeout, cancellationToken);
    }

    public async Task<MessageBridgeEnvelope> GetMessageBridgeStatusAsync(CancellationToken cancellationToken = default)
    {
        return await GetAsync<MessageBridgeEnvelope>("/api/message-bridge/status", DashboardRequestTimeout, cancellationToken);
    }

    public async Task<GameBridgeMessagesEnvelope> GetGameBridgeMessagesAsync(CancellationToken cancellationToken = default)
    {
        return await GetAsync<GameBridgeMessagesEnvelope>("/api/message-bridge/messages", DashboardRequestTimeout, cancellationToken);
    }

    public async Task<GameBridgeChatEnvelope> GetGameBridgeChatAsync(int limit = 100, CancellationToken cancellationToken = default)
    {
        return await GetAsync<GameBridgeChatEnvelope>($"/api/message-bridge/chat?limit={limit}", DashboardRequestTimeout, cancellationToken);
    }

    public async Task<GameBridgeSendEnvelope> SendGameBridgeAdminMessageAsync(
        string message,
        string severity,
        int durationSeconds,
        string targetScope,
        string? targetIdentifier,
        string? targetLabel,
        bool withWidget,
        CancellationToken cancellationToken = default)
    {
        var payload = new Dictionary<string, object?>
        {
            ["message"] = message,
            ["severity"] = severity,
            ["durationSeconds"] = durationSeconds,
            ["title"] = "Admin",
            ["targetScope"] = targetScope,
            ["targetLabel"] = targetLabel,
            ["withWidget"] = withWidget,
        };
        if (!string.IsNullOrWhiteSpace(targetIdentifier))
        {
            payload["targetIdentifier"] = targetIdentifier;
        }

        using var response = await _httpClient.PostAsJsonAsync(
            "/api/message-bridge/admin-message",
            payload,
            JsonOptions,
            cancellationToken);
        return await ReadResponseAsync<GameBridgeSendEnvelope>(response, cancellationToken);
    }

    public async Task<MessageBridgeEnvelope> ClearGameBridgeMessagesAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/message-bridge/clear", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<MessageBridgeEnvelope>(response, cancellationToken);
    }

    public async Task<DiagnosticEnvelope> ExportDiagnosticsAsync(CancellationToken cancellationToken = default)
    {
        return await GetAsync<DiagnosticEnvelope>("/api/diagnostics/export", DashboardRequestTimeout, cancellationToken);
    }

    public async Task<MyRealmApiProbeEnvelope> RunMyRealmApiProbeAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/api-probe", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<MyRealmApiProbeEnvelope>(response, cancellationToken);
    }

    public async Task<DetectIpResponse> DetectPublicIpAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/network/public-ip/detect", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<DetectIpResponse>(response, cancellationToken);
    }

    public async Task<SimpleDashboardResponse> ApplyPublicIpAsync(string profileId, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/network/public-ip/apply", new { profileId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SimpleDashboardResponse>(response, cancellationToken);
    }

    public async Task<SimpleDashboardResponse> SetAddressModeAsync(string mode, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/network/address-mode", new { mode }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SimpleDashboardResponse>(response, cancellationToken);
    }

    public async Task<ModSyncEnvelope> SyncModsAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/mods/sync", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ModSyncEnvelope>(response, cancellationToken);
    }

    public async Task<GameUpdateCheckEnvelope> CheckGameUpdateAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/maintenance/check-game-update", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<GameUpdateCheckEnvelope>(response, cancellationToken);
    }

    public async Task<GameUpdateEnvelope> UpdateGameAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/maintenance/update-game", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<GameUpdateEnvelope>(response, cancellationToken);
    }

    public async Task<ModUpdateEnvelope> CheckModUpdatesAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/mods/update", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ModUpdateEnvelope>(response, cancellationToken);
    }

    public async Task<ModReconcileEnvelope> ReconcileModsAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/mods/reconcile", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ModReconcileEnvelope>(response, cancellationToken);
    }

    public async Task<ModInstallEnvelope> InstallWorkshopModAsync(string input, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/mods/install", new { input }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ModInstallEnvelope>(response, cancellationToken);
    }

    public async Task<SessionEnvelope> LoadMyRealmSessionAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/session/refresh", new { }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<SessionEnvelope>(response, cancellationToken);
    }

    public async Task<MyRealmManagedBrowserResponse> OpenMyRealmManagedBrowserAsync(string url, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/managed-browser/open", new { url }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<MyRealmManagedBrowserResponse>(response, cancellationToken);
    }

    public async Task<EventTileEnvelope> StartEventBatchAsync(string? cycleId = null, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/event-tiles/start", new { cycleId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<EventTileEnvelope>(response, cancellationToken);
    }

    public async Task<EventTileDryRunEnvelope> DryRunEventBatchAsync(string? cycleId = null, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/event-tiles/dry-run", new { cycleId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<EventTileDryRunEnvelope>(response, cancellationToken);
    }

    public async Task<EventTileEnvelope> AdvanceEventBatchAsync(string? cycleId = null, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/event-tiles/advance", new { cycleId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<EventTileEnvelope>(response, cancellationToken);
    }

    public async Task<EventTileEnvelope> PauseEventBatchAsync(string? cycleId = null, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/event-tiles/pause", new { cycleId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<EventTileEnvelope>(response, cancellationToken);
    }

    public async Task<EventTileEnvelope> CleanupEventBatchAsync(string? cycleId = null, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/event-tiles/cleanup", new { cycleId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<EventTileEnvelope>(response, cancellationToken);
    }

    public async Task<ConfigSaveResponse> CreateEventCycleAsync(string? cloneFromCycleId = null, string? cycleName = null, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/event-tiles/cycles/create", new { cloneFromCycleId, cycleName }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ConfigSaveResponse>(response, cancellationToken);
    }

    public async Task<ConfigSaveResponse> DeleteEventCycleAsync(string cycleId, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/event-tiles/cycles/delete", new { cycleId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ConfigSaveResponse>(response, cancellationToken);
    }

    public async Task<ConfigSaveResponse> SelectEventCycleAsync(string cycleId, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/myrealm/event-tiles/cycles/select", new { cycleId }, JsonOptions, cancellationToken);
        return await ReadResponseAsync<ConfigSaveResponse>(response, cancellationToken);
    }

    private async Task<T> GetAsync<T>(string path, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(path, cancellationToken);
        return await ReadResponseAsync<T>(response, cancellationToken);
    }

    private async Task<T> GetAsync<T>(string path, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var timeoutSource = CreateTimeout(timeout, cancellationToken);
        using var response = await _httpClient.GetAsync(path, timeoutSource.Token);
        return await ReadResponseAsync<T>(response, timeoutSource.Token);
    }

    private static CancellationTokenSource CreateTimeout(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        return timeoutSource;
    }

    private static async Task<T> ReadResponseAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(await ReadErrorAsync(response, cancellationToken));
        }

        var payload = await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken);
        return payload ?? throw new InvalidOperationException("The control center returned an empty response.");
    }

    private static async Task<string> ReadErrorAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            var payload = await response.Content.ReadFromJsonAsync<Dictionary<string, JsonElement>>(JsonOptions, cancellationToken);
            if (payload is not null && payload.TryGetValue("error", out var error) && error.ValueKind == JsonValueKind.String)
            {
                return error.GetString() ?? "The control center request failed.";
            }
        }
        catch
        {
        }

        var raw = await response.Content.ReadAsStringAsync(cancellationToken);
        return string.IsNullOrWhiteSpace(raw) ? $"The control center request failed with status {(int)response.StatusCode}." : raw;
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }
}
