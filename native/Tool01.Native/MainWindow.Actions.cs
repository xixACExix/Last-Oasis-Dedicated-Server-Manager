using System.IO;
using System.Text.Json;
using Microsoft.Win32;
using System.Windows;
using System.Windows.Controls;

namespace Tool01.Native;

public partial class MainWindow
{
    private static int GetNextUnusedPort(IEnumerable<int?> usedPorts, int startAt)
    {
        var used = usedPorts.Where(value => value.HasValue).Select(value => value!.Value).ToHashSet();
        var current = Math.Max(1, startAt);
        while (used.Contains(current))
        {
            current += 1;
        }

        return current;
    }

    private static string GetNextRealmName(IEnumerable<LaunchProfile> profiles)
    {
        var existingNames = profiles.Select(profile => profile.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var index = 2;
        while (existingNames.Contains($"Realm {index}"))
        {
            index += 1;
        }

        return $"Realm {index}";
    }

    private static string GetNextIdentifier(IEnumerable<LaunchProfile> profiles)
    {
        var existingIdentifiers = profiles
            .Select(profile => profile.Launch.Identifier)
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var index = 1;
        while (existingIdentifiers.Contains($"realm_server_{index}"))
        {
            index += 1;
        }

        return $"realm_server_{index}";
    }

    private static List<string> ParseRestartFixedTimes(string raw)
    {
        var result = raw
            .Split([',', '/', ';', ' ', '\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(entry =>
            {
                var parts = entry.Split(':', StringSplitOptions.TrimEntries);
                if (parts.Length != 2 || !int.TryParse(parts[0], out var hour) || !int.TryParse(parts[1], out var minute))
                {
                    return null;
                }

                if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
                {
                    return null;
                }

                return $"{hour:00}:{minute:00}";
            })
            .OfType<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(entry => entry)
            .ToList();

        return result.Count > 0 ? result : ["00:00", "12:00"];
    }

    private static TimeSpan ParseRestartStartTime(string raw)
    {
        var value = raw.Trim();
        if (!TimeSpan.TryParse(value, out var parsed))
        {
            throw new InvalidOperationException("First restart time must be a clock time like 00:00 or 18:30.");
        }

        if (parsed < TimeSpan.Zero || parsed >= TimeSpan.FromDays(1))
        {
            throw new InvalidOperationException("First restart time must be between 00:00 and 23:59.");
        }

        return new TimeSpan(parsed.Hours, parsed.Minutes, 0);
    }

    private static List<string> BuildRestartTimesForDay(TimeSpan firstRestart, int restartsPerDay)
    {
        var count = Math.Clamp(restartsPerDay, 1, 12);
        var intervalMinutes = 24 * 60 / count;
        return Enumerable.Range(0, count)
            .Select(index => firstRestart.Add(TimeSpan.FromMinutes(intervalMinutes * index)))
            .Select(time => TimeSpan.FromMinutes(time.TotalMinutes % (24 * 60)))
            .OrderBy(time => time)
            .Select(time => $"{time.Hours:00}:{time.Minutes:00}")
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static string GetComboTag(ComboBox comboBox, string fallback)
    {
        return (comboBox.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? fallback;
    }

    private async Task CreateProfileAsync()
    {
        var config = RequireConfigClone();
        var sourceProfile = GetSelectedProfile(config) ?? throw new InvalidOperationException("Select a base profile first.");
        var newProfile = DeepClone(sourceProfile);

        newProfile.Id = $"profile-{Guid.NewGuid():N}";
        newProfile.Name = GetNextRealmName(config.Profiles);
        newProfile.Launch.Identifier = GetNextIdentifier(config.Profiles);
        newProfile.Launch.Port = GetNextUnusedPort(config.Profiles.Select(profile => (int?)profile.Launch.Port), 5555);
        newProfile.Launch.QueryPort = GetNextUnusedPort(config.Profiles.Select(profile => profile.Launch.QueryPort), 27015);
        newProfile.Notes = "Cloned host profile. Review ports, address, and restart policy before launching.";

        config.Profiles.Add(newProfile);
        config.SelectedProfileId = newProfile.Id;

        var response = await _client.SaveConfigAsync(config);
        _profileDirty = false;
        ApplyReturnedConfig(response.Config);
        SetActionStatus($"Created {newProfile.Name}.");
        QueueRefresh(false);
    }

    private async Task DeleteSelectedProfileAsync()
    {
        var config = RequireConfigClone();
        if (config.Profiles.Count <= 1)
        {
            throw new InvalidOperationException("At least one launch profile must remain.");
        }

        var selectedProfileId = RequireSelectedProfileId();
        var profile = config.Profiles.FirstOrDefault(entry => entry.Id == selectedProfileId)
            ?? throw new InvalidOperationException("Selected profile could not be found.");

        var confirm = MessageBox.Show(
            $"Delete {profile.Name}? This removes its saved ports, identifier, and launch settings.",
            "Delete profile?",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);

        if (confirm != MessageBoxResult.Yes)
        {
            return;
        }

        config.Profiles.RemoveAll(entry => entry.Id == profile.Id);
        config.SelectedProfileId = config.Profiles[0].Id;

        var response = await _client.SaveConfigAsync(config);
        _profileDirty = false;
        ApplyReturnedConfig(response.Config);
        SetActionStatus($"Deleted {profile.Name}.");
        QueueRefresh(false);
    }

    private AppConfig RequireConfigClone()
    {
        if (_dashboard is null)
        {
            throw new InvalidOperationException("The dashboard is not loaded yet.");
        }

        return DeepClone(_dashboard.Config);
    }

    private string RequireSelectedProfileId()
    {
        if (ProfilesListBox.SelectedItem is LaunchProfile profile)
        {
            return profile.Id;
        }

        var selectedId = _dashboard?.Config.SelectedProfileId;
        if (!string.IsNullOrWhiteSpace(selectedId))
        {
            return selectedId;
        }

        throw new InvalidOperationException("Select a launch profile first.");
    }

    private string RequireSelectedEventCycleId(AppConfig? config = null)
    {
        var source = config ?? _dashboard?.Config ?? throw new InvalidOperationException("The dashboard is not loaded yet.");
        var selectedCycle = EventCycleSelectorComboBox.SelectedItem as EventTileCycleState;
        if (!string.IsNullOrWhiteSpace(selectedCycle?.Id))
        {
            return selectedCycle.Id;
        }

        if (!string.IsNullOrWhiteSpace(source.SelectedEventTileCycleId))
        {
            return source.SelectedEventTileCycleId!;
        }

        return GetEventCycles(source).First().Id;
    }

    private static string GetComboValue(ComboBox comboBox, string fallback)
    {
        if (comboBox.SelectedItem is ComboBoxItem selectedItem)
        {
            return selectedItem.Tag?.ToString() ?? selectedItem.Content?.ToString() ?? fallback;
        }

        return fallback;
    }

    private async Task SaveProfileAsync()
    {
        var config = RequireConfigClone();
        var selectedProfileId = RequireSelectedProfileId();
        var profile = config.Profiles.FirstOrDefault(entry => entry.Id == selectedProfileId)
            ?? throw new InvalidOperationException("Selected profile could not be found.");

        profile.Name = ProfileNameTextBox.Text.Trim();
        profile.Launch.Identifier = IdentifierTextBox.Text.Trim();
        profile.Launch.Port = ParseRequiredInt(GamePortTextBox.Text, "Game port");
        profile.Launch.QueryPort = ParseRequiredInt(QueryPortTextBox.Text, "Query port");
        profile.Launch.Slots = ParseRequiredInt(SlotsTextBox.Text, "Slots");
        profile.Launch.OverrideConnectionAddress = OverrideAddressTextBox.Text.Trim();
        profile.Launch.ExtraArgs = ExtraArgsTextBox.Text.Trim();
        profile.Launch.EnableLogs = EnableLogsCheckBox.IsChecked == true;
        profile.Launch.ForceSteamClientLink = ForceSteamLinkCheckBox.IsChecked == true;
        profile.Launch.Messaging = MessagingCheckBox.IsChecked == true;
        profile.Launch.EnableCheats = EnableCheatsCheckBox.IsChecked == true;
        profile.Launch.NoLiveServer = NoLiveServerCheckBox.IsChecked == true;
        profile.RestartPolicy.Enabled = RestartEnabledCheckBox.IsChecked == true;
        var restartsPerDay = Math.Clamp(ParseRequiredInt(GetComboTag(RestartTimesPerDayComboBox, "2"), "Restarts per day"), 1, 12);
        profile.RestartPolicy.ScheduleMode = "fixed-times";
        profile.RestartPolicy.FixedTimes = BuildRestartTimesForDay(ParseRestartStartTime(RestartStartTimeTextBox.Text), restartsPerDay);
        profile.RestartPolicy.IntervalHours = Math.Max(1, 24 / restartsPerDay);
        profile.RestartPolicy.GracefulWarningMinutes = Math.Max(30, ParseRequiredInt(RestartWarningMinutesTextBox.Text, "Restart warning minutes"));

        var response = await _client.SaveConfigAsync(config);
        _profileDirty = false;
        ApplyReturnedConfig(response.Config);
        SetActionStatus($"Saved {profile.Name}.");
        QueueRefresh(false);
    }

    private async Task SaveRealmAsync()
    {
        var config = RequireConfigClone();
        config.RealmSettings.CustomerKey = CustomerKeyTextBox.Text.Trim();
        config.RealmSettings.ProviderKey = ProviderKeyTextBox.Text.Trim();
        config.RealmSettings.ProviderName = ProviderNameTextBox.Text.Trim();
        config.RealmSettings.ApiKey = ApiKeyTextBox.Text.Trim();

        var response = await _client.SaveConfigAsync(config);
        _realmDirty = false;
        ApplyReturnedConfig(response.Config);
        SetActionStatus("Realm settings saved.");
        QueueRefresh(false);
    }

    private async Task SaveOperationsAsync()
    {
        var config = RequireConfigClone();
        config.OperationsSettings.LastKnownPublicIp = LastKnownPublicIpTextBox.Text.Trim();
        config.OperationsSettings.SteamCmdPath = SteamCmdPathTextBox.Text.Trim();
        config.OperationsSettings.SteamCmdInstallDirectory = SteamCmdInstallDirectoryTextBox.Text.Trim();
        config.OperationsSettings.WorkshopContentPath = WorkshopContentPathTextBox.Text.Trim();
        config.OperationsSettings.AppId = ParseRequiredInt(AppIdTextBox.Text, "App ID");
        config.OperationsSettings.BetaBranch = BetaBranchTextBox.Text.Trim();
        config.OperationsSettings.ModIds = ModIdsTextBox.Text
            .Split([',', ';', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        config.OperationsSettings.ModSyncDeletesMissing = DeleteMissingModsCheckBox.IsChecked == true;
        config.OperationsSettings.AutoUpdateMods = AutoUpdateModsCheckBox.IsChecked == true;
        config.OperationsSettings.AutoUpdateGameServer = AutoUpdateGameServerCheckBox.IsChecked == true;
        config.OperationsSettings.AutoRestartOfflineRealms = AutoRestartRealmsCheckBox.IsChecked == true;
        config.OperationsSettings.GameBridgeModMessagesEnabled = GameBridgeModMessagesCheckBox.IsChecked == true;
        config.OperationsSettings.GameBridgeInboxRootPath = GameBridgeInboxRootPathTextBox.Text.Trim();
        config.OperationsSettings.GameBridgeCommandFilePath = GameBridgeCommandFilePathTextBox.Text.Trim();
        config.OperationsSettings.GameBridgeNoWidgetCommandFilePath = GameBridgeNoWidgetCommandFilePathTextBox.Text.Trim();
        config.OperationsSettings.GameBridgeTileWidgetDirectory = GameBridgeTileWidgetDirectoryTextBox.Text.Trim();
        config.OperationsSettings.GameBridgeTileNoWidgetDirectory = GameBridgeTileNoWidgetDirectoryTextBox.Text.Trim();
        config.OperationsSettings.GameBridgeTileDiscordDirectory = GameBridgeTileDiscordDirectoryTextBox.Text.Trim();
        config.OperationsSettings.ModUpdateCheckMinutes = ParseRequiredInt(ModUpdateCheckMinutesTextBox.Text, "Update check minutes");
        config.OperationsSettings.GameUpdateCheckMinutes = ParseRequiredInt(GameUpdateCheckMinutesTextBox.Text, "Server update check minutes");
        config.OperationsSettings.ModUpdateGraceMinutes = 15;
        config.OperationsSettings.OfflineRestartGraceMinutes = ParseRequiredInt(OfflineRestartGraceMinutesTextBox.Text, "Offline restart grace");
        var myRealmWebhookUrl = MyRealmWebhookTextBox.Text.Trim();
        config.OperationsSettings.DiscordMyRealmWebhookUrl = myRealmWebhookUrl;
        config.OperationsSettings.DiscordPlayerCounterWebhookUrl = myRealmWebhookUrl;
        config.OperationsSettings.DiscordTileOnlineWebhookUrl = myRealmWebhookUrl;
        config.OperationsSettings.DiscordUpdateWebhookUrl = UpdateWebhookTextBox.Text.Trim();
        config.OperationsSettings.DiscordEventTileWebhookUrl = EventTileWebhookTextBox.Text.Trim();
        config.OperationsSettings.DiscordGameChatWebhookUrl = GameChatWebhookTextBox.Text.Trim();
        config.OperationsSettings.DiscordBotEnabled = DiscordReplyBotEnabledCheckBox.IsChecked == true;
        config.OperationsSettings.DiscordBotToken = DiscordReplyBotTokenTextBox.Password.Trim();
        config.OperationsSettings.DiscordBotChannelId = DiscordReplyBotChannelIdTextBox.Text.Trim();
        config.OperationsSettings.DiscordMaintenanceRoleId = MaintenanceRoleIdTextBox.Text.Trim();

        var response = await _client.SaveConfigAsync(config);
        _operationsDirty = false;
        ApplyReturnedConfig(response.Config);
        SetActionStatus("Operations settings saved.");
        QueueRefresh(false);
    }

    private async Task EnsureOperationsSavedBeforeModActionAsync()
    {
        if (_operationsDirty)
        {
            await SaveOperationsAsync();
        }
    }

    private static string BuildModSyncStatus(ModSyncResult result)
    {
        var syncText = result.Synced.Count == 0
            ? "No mod files were copied."
            : $"Synced {result.Synced.Count} mod(s): {string.Join(", ", result.Synced)}.";
        var updateText = result.Updated.Count == 0
            ? "No real Workshop updates were detected."
            : $"Detected real Workshop updates for {result.Updated.Count} mod(s): {string.Join(", ", result.Updated)}.";
        var missingText = result.Missing.Count == 0
            ? "No workshop files were missing."
            : $"Missing workshop files: {string.Join(", ", result.Missing)}.";
        var transportText = result.UsedSteamCmd
            ? "SteamCMD was used for the download step."
            : "SteamCMD was not used for this sync.";
        var mirrorText = result.MirroredToSteamWorkshop
            ? "Desktop workshop cache mirrors were refreshed too."
            : "Desktop workshop cache mirrors did not need refreshing.";

        return $"{syncText} {updateText} {missingText} {transportText} {mirrorText}";
    }

    private static string BuildGameUpdateCheckStatus(GameUpdateCheckResult result)
    {
        var availability = result.UpdateAvailable switch
        {
            true => "Update available",
            false => "Current",
            _ => "Unknown",
        };
        var latestUpdated = string.IsNullOrWhiteSpace(result.LatestUpdatedAt)
            ? "unknown"
            : FormatAuditDate(result.LatestUpdatedAt);
        var stderrText = string.IsNullOrWhiteSpace(result.Stderr)
            ? ""
            : $" SteamCMD notes: {result.Stderr}";

        return
            $"{availability}. {result.Note}{Environment.NewLine}" +
            $"App: {result.AppId} | Branch: {result.Branch}{Environment.NewLine}" +
            $"Local build: {result.LocalBuildId ?? "unknown"} | Latest build: {result.LatestBuildId ?? "unknown"} | Latest updated: {latestUpdated}{Environment.NewLine}" +
            $"Manifest: {result.LocalManifestPath ?? "not found"}{stderrText}";
    }

    private static string BuildGameUpdateApplyStatus(GameUpdateEnvelope response)
    {
        var restartText = response.RestartPlan.RestartScheduled
            ? $"Shared tiles / host profiles restart/update is queued for {FormatAuditDate(response.RestartPlan.RestartAt)}."
            : response.RestartPlan.Note;
        var updateText = response.Result is null
            ? "SteamCMD will run after the shared maintenance stop."
            : "SteamCMD server update completed.";
        var outputText = response.Result is null
            ? ""
            : $" {TrimLong(response.Result.Stderr.Length > 0 ? response.Result.Stderr : response.Result.Stdout, 360)}";

        return $"{updateText} {restartText}{outputText}".Trim();
    }

    private static string BuildModUpdateStatus(ModUpdateResult result)
    {
        if (result.UpdatedIds.Count == 0)
        {
            return result.Note;
        }

        var updatedText = $"Updated shared mod IDs: {string.Join(", ", result.UpdatedIds)}.";
        var restartText = result.RestartScheduled
            ? $" Shared tiles / host profiles restart is queued for {FormatAuditDate(result.RestartAt)}."
            : "";
        return $"{updatedText} {result.Note}{restartText}".Trim();
    }

    private static string BuildModReconcileStatus(ModReconcileResult result)
    {
        var changesText = result.UpdatedIds.Count == 0
            ? "No real mod changes were pending."
            : $"Applied pending shared mod changes for: {string.Join(", ", result.UpdatedIds)}.";
        var missingText = result.Sync.Missing.Count == 0
            ? "No workshop files were missing."
            : $"Missing workshop files: {string.Join(", ", result.Sync.Missing)}.";
        var restartText = result.RestartScheduled
            ? $" Shared tiles / host profiles restart is queued for {FormatAuditDate(result.RestartAt)}."
            : " No restart was queued.";

        return $"{changesText} {missingText} {result.Note}{restartText}".Trim();
    }

    private static string TrimLong(string value, int maxLength)
    {
        var trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : $"{trimmed[..maxLength]}...";
    }

    private async Task SaveEventAsync()
    {
        var config = RequireConfigClone();
        var selectedCycleId = RequireSelectedEventCycleId(config);
        var cycles = GetEventCycles(config).Select(cycle => DeepClone(cycle)).ToList();
        var selectedCycle = cycles.FirstOrDefault(entry => entry.Id == selectedCycleId)
            ?? throw new InvalidOperationException("Select an event cycle first.");
        var cycleName = CycleNameTextBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(cycleName))
        {
            throw new InvalidOperationException("Cycle name cannot be blank.");
        }

        selectedCycle.Name = cycleName;
        selectedCycle.CycleSize = ParseRequiredInt(CycleSizeTextBox.Text, "Tiles per cycle");
        selectedCycle.PreviewHours = ParseRequiredInt(PreviewHoursTextBox.Text, "Preview hours");
        selectedCycle.ActiveHours = ParseRequiredInt(ActiveHoursTextBox.Text, "Active hours");
        selectedCycle.DeleteGraceHours = ParseRequiredInt(DeleteGraceHoursTextBox.Text, "Delete after deactivation");
        selectedCycle.NamePrefix = NamePrefixTextBox.Text.Trim();
        selectedCycle.SpacingRadius = ParseRequiredInt(SpacingRadiusTextBox.Text, "Max spacing from anchor");
        selectedCycle.QualityMode = GetComboValue(QualityModeComboBox, "fixed");
        selectedCycle.Quality = ParseRequiredInt(FixedQualityTextBox.Text, "Fixed quality");
        selectedCycle.QualityMin = ParseRequiredInt(QualityMinTextBox.Text, "Random quality min");
        selectedCycle.QualityMax = ParseRequiredInt(QualityMaxTextBox.Text, "Random quality max");
        selectedCycle.PvpMode = GetComboValue(PvpModeComboBox, "NoPvp");
        selectedCycle.AutoAdvance = EventAutoAdvanceCheckBox.IsChecked == true;
        selectedCycle.AllowedMapIds = _allowedMaps.Where(entry => entry.IsSelected).Select(entry => entry.MapId).ToList();
        selectedCycle.EligibleTileIds = _anchorTiles.Where(entry => entry.IsSelected).Select(entry => entry.TileId).ToList();

        config.SelectedEventTileCycleId = selectedCycle.Id;
        config.EventTileCycles = cycles;
        config.EventTileCycle = selectedCycle;

        var response = await _client.SaveConfigAsync(config);
        _eventDirty = false;
        ApplyReturnedConfig(response.Config);
        SetActionStatus($"Saved {selectedCycle.Name}.");
        QueueRefresh(false);
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e)
    {
        await RefreshAsync(true);
    }

    private async void CreateProfileButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await CreateProfileAsync();
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void DeleteProfileButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await DeleteSelectedProfileAsync();
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void StartBackendButton_Click(object sender, RoutedEventArgs e)
    {
        SetActionStatus("Starting the local backend...");
        await EnsureBackendAndRefreshAsync();
    }

    private async void StopBackendButton_Click(object sender, RoutedEventArgs e)
    {
        SetActionStatus("Stopping the backend watchdog and local backend...");
        await _client.StopBackendAsync();
        HandleOfflineState("Backend stopped. The startup task remains installed for the next Windows login unless you disable it.");
    }

    private async void EnableBackendAutostartButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Installing the backend startup watchdog...");
            await _client.InstallBackendAutostartAsync();
            SetActionStatus("Backend startup watchdog is enabled. It starts at Windows login and restarts the backend if it crashes.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void DisableBackendAutostartButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Removing the backend startup watchdog...");
            await _client.RemoveBackendAutostartAsync();
            SetActionStatus("Backend startup watchdog is disabled. The backend will still run until you disconnect it.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void SaveRemotePasswordButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var password = RemotePasswordBox.Password.Trim();
            var confirmation = RemotePasswordConfirmBox.Password.Trim();
            if (password.Length < 8)
            {
                SetActionStatus("Remote web password must be at least 8 characters.", true);
                return;
            }

            if (!string.Equals(password, confirmation, StringComparison.Ordinal))
            {
                SetActionStatus("Remote web password confirmation does not match.", true);
                return;
            }

            SetActionStatus("Saving the remote web password...");
            var response = await _client.UpdateRemotePasswordAsync(password);
            RemotePasswordBox.Clear();
            RemotePasswordConfirmBox.Clear();
            RemotePasswordStatusText.Text = string.IsNullOrWhiteSpace(response.PasswordFilePath)
                ? "Remote password saved. Existing phone sessions were cleared."
                : $"Remote password saved to {response.PasswordFilePath}. Existing phone sessions were cleared.";
            SetActionStatus("Remote web password saved.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private void ApplySteamLoginStatus(SteamLoginInfoResponse response)
    {
        SteamLoginAccountTextBox.Text = response.AccountName;
        SteamClientAutoLoginCheckBox.IsChecked = response.SteamClientAutoLogin;
        var savedLabel = response.Configured && response.HasPassword ? "saved" : "not saved";
        var updatedLabel = string.IsNullOrWhiteSpace(response.UpdatedAt)
            ? ""
            : $" Updated {FormatAuditDate(response.UpdatedAt)}.";
        var fileLabel = string.IsNullOrWhiteSpace(response.FilePath) ? "" : $" File: {response.FilePath}";
        var autoLabel = response.SteamClientAutoLogin ? " Steam client auto-login is enabled." : " Steam client auto-login is disabled.";
        SteamLoginStatusText.Text = $"Steam login secret is {savedLabel}.{updatedLabel}{autoLabel}{fileLabel}";
    }

    private void ApplySteamClientStatus(SteamClientStatusResponse response)
    {
        var runningLabel = response.Running ? "running" : "not running";
        var pathLabel = string.IsNullOrWhiteSpace(response.SteamExePath) ? "Steam.exe not found" : response.SteamExePath;
        SteamClientStatusText.Text = $"Steam client is {runningLabel}. Path: {pathLabel}. {response.Note}";
    }

    private async Task RefreshSteamLoginStatusAsync()
    {
        var response = await _client.GetSteamLoginInfoAsync();
        ApplySteamLoginStatus(response);
    }

    private async Task RefreshSteamClientStatusAsync()
    {
        var response = await _client.GetSteamClientStatusAsync();
        ApplySteamClientStatus(response);
    }

    private async void RefreshSteamLoginButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Checking the saved Steam login secret...");
            await RefreshSteamLoginStatusAsync();
            await RefreshSteamClientStatusAsync();
            SetActionStatus("Steam login secret status refreshed.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void SaveSteamLoginButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var accountName = SteamLoginAccountTextBox.Text.Trim();
            var password = SteamLoginPasswordBox.Password;
            if (string.IsNullOrWhiteSpace(accountName))
            {
                SetActionStatus("Steam login name is required.", true);
                return;
            }

            if (string.IsNullOrEmpty(password))
            {
                SetActionStatus("Steam password is required.", true);
                return;
            }

            SetActionStatus("Saving the Steam login secret...");
            var response = await _client.SaveSteamLoginAsync(accountName, password, SteamClientAutoLoginCheckBox.IsChecked == true);
            SteamLoginPasswordBox.Clear();
            ApplySteamLoginStatus(response);
            await RefreshSteamClientStatusAsync();
            SetActionStatus("Steam login secret saved.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void RefreshSteamClientButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Checking the Steam desktop client...");
            await RefreshSteamClientStatusAsync();
            SetActionStatus("Steam desktop client status refreshed.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void LoginSteamClientButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Starting Steam desktop client login...");
            var response = await _client.LoginSteamClientAsync();
            SteamClientStatusText.Text = $"Steam client login command sent for {response.AccountName}. Running before: {response.RunningBefore}. Running after: {response.RunningAfter}. {response.Note}";
            SetActionStatus("Steam desktop client login command sent.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void ClearSteamLoginButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var confirmed = MessageBox.Show(
                "Delete the saved Steam login name and encrypted password from this profile folder?",
                "Clear Steam Login",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);
            if (confirmed != MessageBoxResult.Yes)
            {
                return;
            }

            SetActionStatus("Clearing the Steam login secret...");
            var response = await _client.ClearSteamLoginAsync();
            SteamLoginPasswordBox.Clear();
            ApplySteamLoginStatus(response);
            await RefreshSteamClientStatusAsync();
            SetActionStatus("Steam login secret cleared.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void RunSetupWizardButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Opening the setup wizard from the standalone native app...");
            await _client.StopBackendAsync();
            await _client.RunInstallerAsync();
            RefreshLocalInstallContext(true);
            await EnsureBackendAndRefreshAsync();
            SetActionStatus("Setup wizard finished. Reloaded the install and profile-folder paths.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async Task SaveInstallContextAsync()
    {
        var workspaceRoot = WorkspaceLocator.FindRoot();
        var currentContext = BackendWorkspaceBootstrapper.ReadInstallContext(workspaceRoot);
        var profileRoot = NormalizeMachinePath(InstallProfileRootTextBox.Text);
        var serverPath = NormalizeMachinePath(InstallServerPathTextBox.Text);
        var steamCmdInstallDirectory = NormalizeMachinePath(InstallSteamCmdDirectoryTextBox.Text);
        var steamCmdPath = DeriveSteamCmdExecutablePath(steamCmdInstallDirectory, currentContext.SteamCmdPath);
        var workshopContentPath = DeriveWorkshopContentPath(steamCmdInstallDirectory, currentContext.WorkshopContentPath);
        var nextContext = new LocalInstallContext
        {
            ToolRoot = currentContext.ToolRoot,
            WorkspaceDataPath = currentContext.WorkspaceDataPath,
            ProfileLinkPath = currentContext.ProfileLinkPath,
            InstallContextPath = currentContext.InstallContextPath,
            ProfileRoot = profileRoot,
            ServerPath = serverPath,
            GamePath = currentContext.GamePath,
            SteamExePath = currentContext.SteamExePath,
            SteamServicePath = currentContext.SteamServicePath,
            WorkshopContentPath = workshopContentPath,
            SteamCmdInstallDirectory = steamCmdInstallDirectory,
            SteamCmdPath = steamCmdPath,
            NodeRoot = currentContext.NodeRoot,
            InstalledAt = currentContext.InstalledAt,
        };

        if (string.IsNullOrWhiteSpace(nextContext.ProfileRoot))
        {
            throw new InvalidOperationException("Profile folder cannot be blank.");
        }

        if (string.IsNullOrWhiteSpace(nextContext.ServerPath))
        {
            throw new InvalidOperationException("Dedicated server path cannot be blank.");
        }

        if (string.IsNullOrWhiteSpace(nextContext.SteamCmdInstallDirectory))
        {
            throw new InvalidOperationException("SteamCMD install folder cannot be blank.");
        }

        SetActionStatus("Saving install paths and reloading the backend...");
        _installContext = BackendWorkspaceBootstrapper.SaveInstallContext(workspaceRoot, nextContext);
        _installDirty = false;
        PopulateInstallContextView(_installContext);
        var backendWasOnline = await _client.IsBackendOnlineAsync();
        if (backendWasOnline && _dashboard is not null)
        {
            var config = RequireConfigClone();
            var serverExecutablePath = Path.Combine(nextContext.ServerPath, "Mist", "Binaries", "Win64", "MistServer-Win64-Shipping.exe");
            var serverWorkingDirectory = Path.GetDirectoryName(serverExecutablePath) ?? nextContext.ServerPath;
            var serverSavedPath = Path.Combine(nextContext.ServerPath, "Mist", "Saved");
            config.Paths.InstallPath = nextContext.ServerPath;
            config.Paths.ExecutablePath = serverExecutablePath;
            config.Paths.WorkingDirectory = serverWorkingDirectory;
            config.Paths.LocalDataPath = serverSavedPath;
            config.Paths.LogsPath = Path.Combine(serverSavedPath, "Logs");
            config.Paths.AdminDataPath = Path.Combine(serverSavedPath, "AdminData.json");
            config.Paths.ServerConfigPath = Path.Combine(serverSavedPath, "Config", "WindowsServer");
            config.OperationsSettings.SteamCmdPath = _installContext.SteamCmdPath;
            config.OperationsSettings.SteamCmdInstallDirectory = _installContext.SteamCmdInstallDirectory;
            config.OperationsSettings.WorkshopContentPath = _installContext.WorkshopContentPath;
            foreach (var profile in config.Profiles)
            {
                profile.ExecutablePath = serverExecutablePath;
                profile.WorkingDirectory = serverWorkingDirectory;
            }
            await _client.SaveConfigAsync(config);
            await _client.StopBackendAsync();
            await EnsureBackendAndRefreshAsync();
            SetActionStatus("Install paths saved. The control center is now using the updated profile folder and machine paths.");
            return;
        }

        SetActionStatus("Install paths saved locally. Start or refresh the backend to load them.");
    }

    private static string NormalizeMachinePath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "";
        }

        return Path.GetFullPath(Environment.ExpandEnvironmentVariables(value.Trim()));
    }

    private static string DeriveSteamCmdExecutablePath(string steamCmdInstallDirectory, string fallback)
    {
        if (!string.IsNullOrWhiteSpace(steamCmdInstallDirectory))
        {
            return Path.Combine(steamCmdInstallDirectory, "steamcmd.exe");
        }

        return NormalizeMachinePath(fallback);
    }

    private static string DeriveWorkshopContentPath(string steamCmdInstallDirectory, string fallback)
    {
        if (!string.IsNullOrWhiteSpace(steamCmdInstallDirectory))
        {
            return Path.Combine(steamCmdInstallDirectory, "steamapps", "workshop", "content", "903950");
        }

        return NormalizeMachinePath(fallback);
    }

    private void OpenProfileFolderButton_Click(object sender, RoutedEventArgs e)
    {
        OpenExistingPath(_installContext.ProfileRoot, "profile folder");
    }

    private void OpenInstallContextButton_Click(object sender, RoutedEventArgs e)
    {
        OpenExistingPath(_installContext.InstallContextPath, "install context");
    }

    private void OpenBackupsFolderButton_Click(object sender, RoutedEventArgs e)
    {
        var backupsPath = string.IsNullOrWhiteSpace(_installContext.ProfileRoot) ? "" : Path.Combine(_installContext.ProfileRoot, "backups");
        OpenExistingPath(backupsPath, "backups folder");
    }

    private void OpenWorkspaceFolderButton_Click(object sender, RoutedEventArgs e)
    {
        OpenExistingPath(_installContext.ToolRoot, "workspace");
    }

    private async void ProfilesListBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suspendUiEvents || ProfilesListBox.SelectedItem is not LaunchProfile profile)
        {
            return;
        }

        if (_dashboard?.Config.SelectedProfileId == profile.Id)
        {
            return;
        }

        if (_profileDirty)
        {
            var shouldContinue = MessageBox.Show(
                "Unsaved profile edits will be discarded if you switch hosts now. Continue?",
                "Discard unsaved changes?",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);

            if (shouldContinue != MessageBoxResult.Yes)
            {
                _suspendUiEvents = true;
                ProfilesListBox.SelectedItem = _dashboard?.Config.Profiles.FirstOrDefault(entry => entry.Id == _dashboard.Config.SelectedProfileId);
                _suspendUiEvents = false;
                return;
            }
        }

        try
        {
            var response = await _client.SelectProfileAsync(profile.Id);
            SetActionStatus($"Selected {profile.Name}.");
            _profileDirty = false;

            if (_dashboard is not null)
            {
                _dashboard.Config = response.Config;
                ApplyDashboard(_dashboard);
                RefreshLocalInstallContext();
            }

            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void StartSelectedButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var selectedProfileId = RequireSelectedProfileId();
            SetActionStatus("Submitting start request for the selected host...");
            var response = await _client.StartSelectedAsync(selectedProfileId);
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus("Start request accepted.");
            QueueRefresh(true, 300);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void StartAllButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Submitting start-all request...");
            var response = await _client.StartAllAsync();
            SetActionStatus($"Start-all accepted for {response.ProfileIds.Count} realm hosts.");
            QueueRefresh(true, 300);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void StopAllButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Submitting stop-all request...");
            var response = await _client.StopAllAsync();
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus("Stop-all request completed.");
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void SafeStopButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var prompt = new TextPromptWindow(
                "Schedule Safe Stop",
                "Enter the maintenance reason that should appear in the Discord webhook before the active realm host pool stops.",
                "Planned maintenance",
                "Maintenance reason",
                "Schedule",
                "Maintenance reason cannot be blank.")
            {
                Owner = this,
            };

            if (prompt.ShowDialog() != true)
            {
                SetActionStatus("Safe maintenance stop cancelled.");
                return;
            }

            SetActionStatus("Scheduling a safe maintenance stop with a Discord maintenance notice...");
            var response = await _client.SafeStopAsync(prompt.ResponseText);
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus($"Safe maintenance stop scheduled. The active realm host pool will stop in 10 minutes. Reason: {prompt.ResponseText}");
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void SkipNextRestartButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var selectedProfileId = RequireSelectedProfileId();
            SetActionStatus("Skipping the next scheduled restart for the selected host...");
            var response = await _client.SkipNextRestartAsync(selectedProfileId);
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus("Skipped the next scheduled restart for the selected host.");
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void ClearRestartSkipButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var selectedProfileId = RequireSelectedProfileId();
            SetActionStatus("Clearing the restart skip for the selected host...");
            var response = await _client.ClearRestartSkipAsync(selectedProfileId);
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus("Cleared the restart skip for the selected host.");
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void RefreshAuditButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Refreshing manager audit log...");
            var response = await _client.GetAuditAsync();
            ManagerAuditGrid.ItemsSource = response.Entries;
            SetActionStatus($"Loaded {response.Entries.Count} audit entries.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void CheckMessageBridgeButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Refreshing the game bridge...");
            await RefreshGameBridgeAsync();
            SetActionStatus("Game bridge refreshed.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void RefreshGameBridgeButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Refreshing queued game messages and chat...");
            await RefreshGameBridgeAsync();
            SetActionStatus("Game bridge refreshed.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private void BrowseGameBridgeCommandPathButton_Click(object sender, RoutedEventArgs e)
    {
        var currentPath = GameBridgeCommandFilePathTextBox.Text.Trim();
        var initialDirectory = "";
        if (!string.IsNullOrWhiteSpace(currentPath))
        {
            initialDirectory = Path.GetFileName(currentPath).EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                ? Path.GetDirectoryName(currentPath) ?? ""
                : currentPath;
        }

        if (string.IsNullOrWhiteSpace(initialDirectory))
        {
            initialDirectory = @"C:\LastOasisServer\Mist\Content\Mods\LOManagerBridge\Inbox";
        }

        var dialog = new OpenFileDialog
        {
            Title = "Choose LOManagerBridge Admin.json",
            Filter = "Admin.json|Admin.json|JSON files (*.json)|*.json|All files (*.*)|*.*",
            FileName = "Admin.json",
            CheckFileExists = false,
            CheckPathExists = true,
            InitialDirectory = Directory.Exists(initialDirectory) ? initialDirectory : "",
        };

        if (dialog.ShowDialog(this) != true || string.IsNullOrWhiteSpace(dialog.FileName))
        {
            return;
        }

        GameBridgeCommandFilePathTextBox.Text = dialog.FileName;
        _operationsDirty = true;
        SetActionStatus("Bridge Admin.json path changed. Save Bridge Setting to apply it.");
    }

    private void BrowseGameBridgeInboxRootButton_Click(object sender, RoutedEventArgs e)
    {
        var currentPath = GameBridgeInboxRootPathTextBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(currentPath))
        {
            currentPath = GameBridgeCommandFilePathTextBox.Text.Trim();
        }

        var initialDirectory = "";
        if (!string.IsNullOrWhiteSpace(currentPath))
        {
            initialDirectory = Path.GetFileName(currentPath).EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                ? Path.GetDirectoryName(currentPath) ?? ""
                : currentPath;
        }

        if (string.IsNullOrWhiteSpace(initialDirectory))
        {
            initialDirectory = @"C:\LastOasisServer\Mist\Content\Mods\LOManagerBridge\Inbox";
        }

        var dialog = new OpenFileDialog
        {
            Title = "Choose LOManagerBridge Inbox root",
            Filter = "Admin.json|Admin.json|JSON files (*.json)|*.json|All files (*.*)|*.*",
            FileName = "Admin.json",
            CheckFileExists = false,
            CheckPathExists = true,
            InitialDirectory = Directory.Exists(initialDirectory) ? initialDirectory : "",
        };

        if (dialog.ShowDialog(this) != true || string.IsNullOrWhiteSpace(dialog.FileName))
        {
            return;
        }

        var inboxRoot = Path.GetDirectoryName(dialog.FileName) ?? initialDirectory;
        GameBridgeInboxRootPathTextBox.Text = inboxRoot;
        GameBridgeCommandFilePathTextBox.Text = Path.Combine(inboxRoot, "Admin.json");
        _operationsDirty = true;
        SetActionStatus("Bridge inbox root changed. Save Bridge Setting to apply it.");
    }

    private async Task RefreshGameBridgeAsync()
    {
        var messages = await _client.GetGameBridgeMessagesAsync();
        ApplyMessageBridgeStatus(messages.Status);
        GameBridgeMessagesGrid.ItemsSource = messages.Messages;

        var chat = await _client.GetGameBridgeChatAsync(100);
        GameBridgeChatGrid.ItemsSource = chat.Entries;
        ApplyMessageBridgeStatus(chat.Status);
    }

    private async void SendGameBridgeAdminMessageButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var message = AdminGameMessageTextBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(message))
            {
                SetActionStatus("Type an admin message before queueing it.", true);
                return;
            }

            if (!int.TryParse(AdminGameMessageDurationTextBox.Text.Trim(), out var durationSeconds))
            {
                SetActionStatus("Message seconds must be a whole number.", true);
                return;
            }

            durationSeconds = Math.Clamp(durationSeconds, 3, 600);
            var target = GameBridgeTargetComboBox.SelectedItem as GameBridgeTargetOption;
            var targetScope = target?.Scope == "tile" ? "tile" : "global";
            var targetIdentifier = targetScope == "tile" ? target?.Identifier : null;
            var targetLabel = targetScope == "tile" ? target?.TileName ?? target?.Label : "All servers";
            var withWidget = GameBridgeWithWidgetCheckBox.IsChecked == true;
            SetActionStatus("Queueing admin message for the game bridge...");
            var response = await _client.SendGameBridgeAdminMessageAsync(message, "info", durationSeconds, targetScope, targetIdentifier, targetLabel, withWidget);
            ApplyMessageBridgeStatus(response.Status);
            AdminGameMessageTextBox.Clear();
            await RefreshGameBridgeAsync();
            SetActionStatus($"Queued admin message: {response.Message.Message}");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void ClearGameBridgeMessagesButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Clearing queued game bridge messages...");
            var response = await _client.ClearGameBridgeMessagesAsync();
            ApplyMessageBridgeStatus(response.Status);
            await RefreshGameBridgeAsync();
            SetActionStatus("Cleared the game bridge queue.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void RunApiProbeButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Running safe MyRealm API probe...");
            var response = await _client.RunMyRealmApiProbeAsync();
            var result = response.Result;
            ApiProbeGrid.ItemsSource = result.Rows;
            ApiProbeSummaryText.Text =
                $"Checked {result.Rows.Count} route/header combinations at {FormatAuditDate(result.CheckedAt)}. API key configured: {(result.HasApiKey ? "yes" : "no")}.";
            SetActionStatus("Safe MyRealm API probe finished.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void ExportDiagnosticsButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Preparing redacted diagnostics...");
            var response = await _client.ExportDiagnosticsAsync();
            DiagnosticBundleTextBox.Text = JsonSerializer.Serialize(response.Bundle, new JsonSerializerOptions
            {
                WriteIndented = true,
            });
            ManagerAuditGrid.ItemsSource = response.Bundle.RecentAudit;
            SetActionStatus("Redacted diagnostic bundle is ready in the diagnostics box.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private void SafeModeCheckBox_Changed(object sender, RoutedEventArgs e)
    {
        _safeMode = SafeModeCheckBox.IsChecked == true;
        ApplySafeMode();
        SetActionStatus(_safeMode
            ? "Safe mode enabled. Destructive one-click actions are disabled."
            : "Safe mode disabled. Full manager actions are available.");
    }

    private async void SaveProfileButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await SaveProfileAsync();
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void SaveRealmButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await SaveRealmAsync();
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void SaveOperationsButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await SaveOperationsAsync();
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void InstallWorkshopModButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var prompt = new TextPromptWindow(
                "Install Workshop Mod",
                "Paste a Steam Workshop URL or a numeric workshop item ID. The manager will add it to the configured list and sync it into the server right away.",
                "",
                "Workshop URL or mod ID",
                "Install",
                "Paste a Workshop URL or a numeric mod ID first.")
            {
                Owner = this,
            };

            if (prompt.ShowDialog() != true)
            {
                SetActionStatus("Workshop mod install cancelled.");
                return;
            }

            await EnsureOperationsSavedBeforeModActionAsync();
            SetActionStatus("Installing the workshop mod into the configured server mod set...");
            var response = await _client.InstallWorkshopModAsync(prompt.ResponseText);
            SetActionStatus(
                response.AlreadyConfigured
                    ? $"Re-synced configured mod {response.ModId}. {BuildModSyncStatus(response.Result)}"
                    : $"Installed and configured mod {response.ModId}. {BuildModSyncStatus(response.Result)}");
            ApplyReturnedDashboard(response.Dashboard);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void SyncModsButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await EnsureOperationsSavedBeforeModActionAsync();
            SetActionStatus("Syncing the configured shared workshop mod set into the server...");
            var response = await _client.SyncModsAsync();
            SetActionStatus(BuildModSyncStatus(response.Result));
            ApplyReturnedDashboard(response.Dashboard);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void CheckServerUpdateButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await EnsureOperationsSavedBeforeModActionAsync();
            SetActionStatus("Checking SteamCMD for a dedicated server update...");
            var response = await _client.CheckGameUpdateAsync();
            var status = BuildGameUpdateCheckStatus(response.Result);
            ServerUpdateSummaryTextBlock.Text = status;
            SetActionStatus(response.Result.Note);
            ApplyReturnedDashboard(response.Dashboard);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
            ServerUpdateSummaryTextBlock.Text = ex.Message;
        }
    }

    private async void ApplyServerUpdateButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await EnsureOperationsSavedBeforeModActionAsync();
            SetActionStatus("Applying the dedicated server update through the shared tiles / host profiles maintenance plan...");
            var response = await _client.UpdateGameAsync();
            var status = BuildGameUpdateApplyStatus(response);
            ServerUpdateSummaryTextBlock.Text = status;
            SetActionStatus(status);
            ApplyReturnedDashboard(response.Dashboard);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
            ServerUpdateSummaryTextBlock.Text = ex.Message;
        }
    }

    private async void ReconcileModsButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await EnsureOperationsSavedBeforeModActionAsync();
            SetActionStatus("Refreshing configured mods and building one shared restart plan...");
            var response = await _client.ReconcileModsAsync();
            SetActionStatus(BuildModReconcileStatus(response.Result));
            ApplyReturnedDashboard(response.Dashboard);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void CheckModUpdatesButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await EnsureOperationsSavedBeforeModActionAsync();
            SetActionStatus("Checking configured shared Workshop mods for updates...");
            var response = await _client.CheckModUpdatesAsync();
            SetActionStatus(BuildModUpdateStatus(response.Result));
            ApplyReturnedDashboard(response.Dashboard);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void SaveInstallContextButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await SaveInstallContextAsync();
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void DetectPublicIpButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Detecting the current public IP...");
            var response = await _client.DetectPublicIpAsync();
            LastKnownPublicIpTextBox.Text = response.Ip.Address;
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus($"Detected public IP {response.Ip.Address} via {response.Ip.Source}.");
            QueueRefresh(false);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void ApplyPublicIpButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Applying the stored public IP to the selected host...");
            var response = await _client.ApplyPublicIpAsync(RequireSelectedProfileId());
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus("Applied the stored public IP to the selected profile.");
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void LanModeButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var response = await _client.SetAddressModeAsync("lan");
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus("Switched the selected profile to LAN mode.");
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void PublicModeButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var response = await _client.SetAddressModeAsync("public");
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus("Switched the selected profile to public mode.");
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void LoadMyRealmSessionButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Loading the live MyRealm session...");
            var response = await _client.LoadMyRealmSessionAsync();
            _session = response.Session;
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus("Loaded the live MyRealm session.");
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void OpenMyRealmDashboardButton_Click(object sender, RoutedEventArgs e) => await OpenMyRealmManagedBrowserAsync(_dashboard?.Config.MyRealmFlow?.DashboardUrl ?? _session?.Links.DashboardUrl, "MyRealm dashboard");
    private async void OpenMyRealmRealmButton_Click(object sender, RoutedEventArgs e) => await OpenMyRealmManagedBrowserAsync(_dashboard?.Config.MyRealmFlow?.RealmUrl ?? _session?.Links.RealmUrl, "MyRealm realm");
    private async void OpenMyRealmMapButton_Click(object sender, RoutedEventArgs e) => await OpenMyRealmManagedBrowserAsync(_dashboard?.Config.MyRealmFlow?.MapUrl ?? _session?.Links.MapUrl, "MyRealm map");
    private async void OpenMyRealmServersButton_Click(object sender, RoutedEventArgs e) => await OpenMyRealmManagedBrowserAsync(_dashboard?.Config.MyRealmFlow?.ServersUrl, "MyRealm servers");
    private async void OpenMyRealmProvidersButton_Click(object sender, RoutedEventArgs e) => await OpenMyRealmManagedBrowserAsync(_dashboard?.Config.MyRealmFlow?.ProvidersUrl, "MyRealm providers");
    private async void OpenMyRealmApiButton_Click(object sender, RoutedEventArgs e) => await OpenMyRealmManagedBrowserAsync(_dashboard?.Config.MyRealmFlow?.ApiUrl ?? _session?.Links.ApiUrl, "MyRealm API page");

    private async Task OpenMyRealmManagedBrowserAsync(string? url, string label)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            SetActionStatus("No MyRealm URL is available yet. Load a live MyRealm session first.", true);
            return;
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            SetActionStatus($"MyRealm URL is not valid: {url}", true);
            return;
        }

        try
        {
            SetActionStatus($"Opening {label} in the managed MyRealm Edge session...");
            await _client.OpenMyRealmManagedBrowserAsync(uri.ToString());
            SetActionStatus($"Opened {label} in the managed MyRealm Edge session.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private void MyRealmTilesGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        UpdateSelectedTileDetails(MyRealmTilesGrid.SelectedItem as MyRealmTileSummary);
    }

    private void CopySelectedTileIdButton_Click(object sender, RoutedEventArgs e)
    {
        if (MyRealmTilesGrid.SelectedItem is not MyRealmTileSummary tile)
        {
            SetActionStatus("Select a MyRealm tile first.", true);
            return;
        }

        Clipboard.SetText(tile.TileId.ToString());
        SetActionStatus($"Copied tile ID {tile.TileId}.");
    }

    private async void OpenSelectedTileDetailsButton_Click(object sender, RoutedEventArgs e)
    {
        if (MyRealmTilesGrid.SelectedItem is not MyRealmTileSummary tile)
        {
            SetActionStatus("Select a MyRealm tile first.", true);
            return;
        }

        var realmUrl = _dashboard?.Config.MyRealmFlow?.RealmUrl ?? _session?.Links.RealmUrl;
        if (string.IsNullOrWhiteSpace(realmUrl))
        {
            SetActionStatus("No MyRealm realm URL is available yet. Load a live MyRealm session first.", true);
            return;
        }

        await OpenMyRealmManagedBrowserAsync($"{realmUrl.TrimEnd('/')}/Tiles/{tile.TileId}/Details", $"MyRealm details for tile {tile.TileId}");
    }

    private async void SaveEventButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await SaveEventAsync();
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void DryRunEventBatchButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_eventDirty)
            {
                await SaveEventAsync();
            }

            SetActionStatus("Previewing the next event tile batch without creating anything...");
            var response = await _client.DryRunEventBatchAsync(RequireSelectedEventCycleId());
            var result = response.Result;
            EventDryRunGrid.ItemsSource = result.SelectedCandidates;
            EventDryRunSummaryText.Text =
                $"{result.Message}{Environment.NewLine}" +
                $"Cycle: {result.CycleName} | desired: {result.DesiredCount} | selected: {result.SelectedCandidates.Count} | available: {result.AvailableCandidates} | skipped coords: {result.SkippedCoordinates}";
            SetActionStatus("Dry-run preview completed. No MyRealm tiles were created.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void CreateNextBatchButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_eventDirty)
            {
                await SaveEventAsync();
            }

            SetActionStatus("Creating the next MyRealm event batch. This can take a minute...");
            var response = await _client.StartEventBatchAsync(RequireSelectedEventCycleId());
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus(response.Result.Message);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void AdvanceCycleButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_eventDirty)
            {
                await SaveEventAsync();
            }

            SetActionStatus("Advancing the event cycle. Waiting for MyRealm...");
            var response = await _client.AdvanceEventBatchAsync(RequireSelectedEventCycleId());
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus(response.Result.Message);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void PauseCycleButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            SetActionStatus("Pausing the selected event cycle...");
            var response = await _client.PauseEventBatchAsync(RequireSelectedEventCycleId());
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus(response.Result.Message);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void NewEventCycleButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var existingCycles = GetEventCycles(_dashboard?.Config ?? throw new InvalidOperationException("The dashboard is not loaded yet.")).ToList();
            var suggestedName = $"Event Cycle {existingCycles.Count + 1}";
            var prompt = new TextPromptWindow(
                "Create Event Cycle",
                "Choose a name for the new event cycle. It will clone the currently selected cycle settings.",
                suggestedName,
                "Cycle name",
                "Create",
                "Cycle name cannot be blank.")
            {
                Owner = this,
            };

            if (prompt.ShowDialog() != true)
            {
                SetActionStatus("Cycle creation cancelled.");
                return;
            }

            SetActionStatus($"Creating event cycle {prompt.ResponseText}...");
            var response = await _client.CreateEventCycleAsync(RequireSelectedEventCycleId(), prompt.ResponseText);
            _eventDirty = false;
            ApplyReturnedConfig(response.Config);
            QueueRefresh(false);
            SetActionStatus($"Created event cycle {prompt.ResponseText}.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void DeleteEventCycleButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var cycleName = (EventCycleSelectorComboBox.SelectedItem as EventTileCycleState)?.Name ?? "this cycle";
            var confirm = MessageBox.Show(
                $"Delete {cycleName}? Only idle cycles with no tracked tiles can be deleted.",
                "Delete event cycle?",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);

            if (confirm != MessageBoxResult.Yes)
            {
                return;
            }

            var response = await _client.DeleteEventCycleAsync(RequireSelectedEventCycleId());
            _eventDirty = false;
            ApplyReturnedConfig(response.Config);
            QueueRefresh(false);
            SetActionStatus($"Deleted {cycleName}.");
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private async void ForceCleanupCycleButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var confirm = MessageBox.Show(
                "Force cleanup will deactivate and delete the tracked tiles for the selected cycle. Continue?",
                "Force cleanup selected cycle?",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);

            if (confirm != MessageBoxResult.Yes)
            {
                return;
            }

            SetActionStatus("Force-cleaning the selected event cycle...");
            var response = await _client.CleanupEventBatchAsync(RequireSelectedEventCycleId());
            _eventDirty = false;
            ApplyReturnedDashboard(response.Dashboard);
            SetActionStatus(response.Result.Message);
            QueueRefresh(true);
        }
        catch (Exception ex)
        {
            SetActionStatus(ex.Message, true);
        }
    }

    private void ProfileEditorChanged(object sender, TextChangedEventArgs e)
    {
        if (ReferenceEquals(sender, RestartStartTimeTextBox))
        {
            UpdateRestartSchedulePreview();
        }

        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _profileDirty = true;
        }
    }

    private void ProfileEditorChanged(object sender, RoutedEventArgs e)
    {
        if (ReferenceEquals(sender, RestartTimesPerDayComboBox))
        {
            UpdateRestartSchedulePreview();
        }

        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _profileDirty = true;
        }
    }

    private void RealmEditorChanged(object sender, TextChangedEventArgs e)
    {
        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _realmDirty = true;
        }
    }

    private void OperationsEditorChanged(object sender, TextChangedEventArgs e)
    {
        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _operationsDirty = true;
        }
    }

    private void OperationsEditorChanged(object sender, RoutedEventArgs e)
    {
        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _operationsDirty = true;
        }
    }

    private void EventEditorChanged(object sender, TextChangedEventArgs e)
    {
        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _eventDirty = true;
        }
    }

    private void EventEditorChanged(object sender, RoutedEventArgs e)
    {
        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _eventDirty = true;
        }
    }

    private void EventEditorChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _eventDirty = true;
        }
    }

    private void InstallContextEditorChanged(object sender, TextChangedEventArgs e)
    {
        if (!_suspendUiEvents)
        {
            MarkEditorInteraction();
            _installDirty = true;
        }
    }

    private void OpenExistingPath(string? targetPath, string label)
    {
        if (string.IsNullOrWhiteSpace(targetPath))
        {
            SetActionStatus($"No {label} path is available yet.", true);
            return;
        }

        if (!Directory.Exists(targetPath) && !File.Exists(targetPath))
        {
            SetActionStatus($"The {label} path does not exist: {targetPath}", true);
            return;
        }

        WorkspaceLocator.OpenPath(targetPath);
        SetActionStatus($"Opened the {label}.");
    }
}
