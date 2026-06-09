using System.Text.Json.Serialization;

using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace Tool01.Native;

public sealed class DashboardState
{
    public AppConfig Config { get; set; } = new();
    public List<HealthCheck> Health { get; set; } = [];
    public MyRealmSessionSnapshot? MyRealmSession { get; set; }
    public SchedulerStatus SchedulerStatus { get; set; } = new();
    public LaunchStatus LaunchStatus { get; set; } = new();
    public NetworkAddresses NetworkAddresses { get; set; } = new();
    public List<LiveServerSummary> LiveServers { get; set; } = [];
    public List<ModSummary> Mods { get; set; } = [];
}

public sealed class HealthCheck
{
    public string Label { get; set; } = "";
    public bool Ok { get; set; }
    public string Value { get; set; } = "";
    public string? Details { get; set; }

    [JsonIgnore]
    public string StateLabel => Ok ? "OK" : "Check";
}

public sealed class NetworkAddresses
{
    public string? PublicIp { get; set; }
    public string? LocalIp { get; set; }
}

public sealed class SchedulerStatus
{
    public bool Enabled { get; set; }
    public string? MonitoredProfileId { get; set; }
    public string? MonitoredProfileName { get; set; }
    public string? NextRestartAt { get; set; }
    public string RestartScheduleMode { get; set; } = "fixed-times";
    public string RestartScheduleLabel { get; set; } = "00:00 / 12:00";
    public string? SkippedRestartAt { get; set; }
    public bool SkipActive { get; set; }
    public string? PendingAction { get; set; }
    public string? PendingSource { get; set; }
    public string? PendingReason { get; set; }
    public string? PendingTargetSummary { get; set; }
    public string? LastWebhookTitle { get; set; }
    public string? LastWebhookAt { get; set; }
    public string LastAction { get; set; } = "";
    public bool Running { get; set; }
    public bool AutoRestartEnabled { get; set; }
    public int DesiredRunningProfiles { get; set; }
}

public sealed class LaunchStatus
{
    public string Phase { get; set; } = "idle";
    public string Summary { get; set; } = "";
    public int DesiredHosts { get; set; }
    public int ProcessHosts { get; set; }
    public int HostingReadyHosts { get; set; }
    public int WarmingHosts { get; set; }
    public int PendingHosts { get; set; }
}

public sealed class LiveServerSummary
{
    public int? ProcessId { get; set; }
    public string? Identifier { get; set; }
    public int? GamePort { get; set; }
    public bool Online { get; set; }
    public string Status { get; set; } = "offline";
    public string? ServerName { get; set; }
    public string? Map { get; set; }
    public string? Game { get; set; }
    public string? Version { get; set; }
    public int PlayerCount { get; set; }
    public int? MaxPlayers { get; set; }
    public int? QueryPort { get; set; }
    public string? Note { get; set; }
}

public sealed class ModSummary
{
    public string ModId { get; set; } = "";
    public string Title { get; set; } = "";
    public string? LocalTitle { get; set; }
    public string? Description { get; set; }
    public string? Tag { get; set; }
    public string? FolderName { get; set; }
    public bool? Active { get; set; }
    public int? ModKitVersion { get; set; }
    public string? VersionLabel { get; set; }
    public string? Creator { get; set; }
    public string? PreviewUrl { get; set; }
    public string WorkshopUrl { get; set; } = "";
    public string? LocalPath { get; set; }
    public string? ServerPath { get; set; }
    public string? LocalUpdatedAt { get; set; }
    public string? ServerUpdatedAt { get; set; }
    public string? WorkshopUpdatedAt { get; set; }
    public bool ServerInstalled { get; set; }
    public bool HasWorkshopMetadata { get; set; }
    public bool UpdateAvailable { get; set; }
    public bool Deprecated { get; set; }

    [JsonIgnore]
    public string DisplayTitle => string.IsNullOrWhiteSpace(Title) ? ModId : $"{Title} ({ModId})";

    [JsonIgnore]
    public string CreatorDisplay => string.IsNullOrWhiteSpace(Creator) ? "Unknown" : Creator!;

    [JsonIgnore]
    public string VersionDisplay => string.IsNullOrWhiteSpace(VersionLabel) ? "Unknown" : VersionLabel!;

    [JsonIgnore]
    public string InstallStatusLabel => ServerInstalled
        ? Active == false
            ? "Installed (inactive)"
            : "Installed"
        : "Not installed";

    [JsonIgnore]
    public string UpdateStatusLabel => UpdateAvailable
        ? ServerInstalled
            ? "Update available"
            : "Needs install"
        : HasWorkshopMetadata
            ? "Current"
            : "Current (local)";

    [JsonIgnore]
    public string LastUpdatedLabel => BuildLastUpdatedLabel();

    private string BuildLastUpdatedLabel()
    {
        var candidates = new[]
        {
            ("Workshop", TryParseTimestamp(WorkshopUpdatedAt)),
            ("Server", TryParseTimestamp(ServerUpdatedAt)),
            ("Local", TryParseTimestamp(LocalUpdatedAt)),
        }
        .Where(entry => entry.Item2.HasValue)
        .OrderByDescending(entry => entry.Item2!.Value)
        .ToList();

        if (candidates.Count == 0)
        {
            return "Unknown";
        }

        var selected = candidates[0];
        return $"{selected.Item1} {selected.Item2!.Value.ToLocalTime():g}";
    }

    private static DateTimeOffset? TryParseTimestamp(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;
    }
}

public sealed class AppConfig
{
    public string? SelectedProfileId { get; set; }
    public string? SelectedEventTileCycleId { get; set; }
    public DiscoveredPaths Paths { get; set; } = new();
    public RealmSettings RealmSettings { get; set; } = new();
    public MyRealmFlowSummary? MyRealmFlow { get; set; }
    public OperationsSettings OperationsSettings { get; set; } = new();
    public EventTileCycleState EventTileCycle { get; set; } = new();
    public List<EventTileCycleState> EventTileCycles { get; set; } = [];
    public List<LaunchProfile> Profiles { get; set; } = [];
}

public sealed class DiscoveredPaths
{
    public string InstallPath { get; set; } = "";
    public string ExecutablePath { get; set; } = "";
    public string WorkingDirectory { get; set; } = "";
    public string LocalDataPath { get; set; } = "";
    public string LogsPath { get; set; } = "";
    public string AdminDataPath { get; set; } = "";
    public string ServerConfigPath { get; set; } = "";
    public string PersistedConfigPath { get; set; } = "";
    public string BackupsPath { get; set; } = "";
}

public sealed class RealmSettings
{
    public string CustomerKey { get; set; } = "";
    public string ProviderKey { get; set; } = "";
    public string ProviderName { get; set; } = "";
    public string ApiKey { get; set; } = "";
}

public sealed class MyRealmFlowSummary
{
    public string? Browser { get; set; }
    public string? CustomerId { get; set; }
    public string? RealmId { get; set; }
    public string? DashboardUrl { get; set; }
    public string? RealmUrl { get; set; }
    public string? MapUrl { get; set; }
    public string? ServersUrl { get; set; }
    public string? ProvidersUrl { get; set; }
    public string? UsersUrl { get; set; }
    public string? ApiUrl { get; set; }
    public List<string> RecentTileUrls { get; set; } = [];
    public string Note { get; set; } = "";
}

public sealed class OperationsSettings
{
    public string SteamCmdPath { get; set; } = "";
    public string SteamCmdInstallDirectory { get; set; } = "";
    public string WorkshopContentPath { get; set; } = "";
    public List<string> ModIds { get; set; } = [];
    public string BetaBranch { get; set; } = "";
    public int AppId { get; set; }
    public string LastKnownPublicIp { get; set; } = "";
    public bool ModSyncDeletesMissing { get; set; }
    public bool AutoUpdateMods { get; set; }
    public bool AutoUpdateGameServer { get; set; }
    public int ModUpdateCheckMinutes { get; set; }
    public int GameUpdateCheckMinutes { get; set; }
    public int ModUpdateGraceMinutes { get; set; }
    public string DiscordMyRealmWebhookUrl { get; set; } = "";
    public string DiscordPlayerCounterWebhookUrl { get; set; } = "";
    public string DiscordTileOnlineWebhookUrl { get; set; } = "";
    public string DiscordUpdateWebhookUrl { get; set; } = "";
    public string DiscordEventTileWebhookUrl { get; set; } = "";
    public string DiscordGameChatWebhookUrl { get; set; } = "";
    public bool DiscordBotEnabled { get; set; }
    public string DiscordBotToken { get; set; } = "";
    public string DiscordBotChannelId { get; set; } = "";
    public string DiscordMaintenanceRoleId { get; set; } = "";
    public bool GameBridgeModMessagesEnabled { get; set; } = true;
    public string GameBridgeInboxRootPath { get; set; } = "";
    public string GameBridgeCommandFilePath { get; set; } = "";
    public string GameBridgeNoWidgetCommandFilePath { get; set; } = "";
    public string GameBridgeTileWidgetDirectory { get; set; } = "";
    public string GameBridgeTileNoWidgetDirectory { get; set; } = "";
    public string GameBridgeTileDiscordDirectory { get; set; } = "";
    public bool AutoRestartOfflineRealms { get; set; }
    public int OfflineRestartGraceMinutes { get; set; }
}

public sealed class LocalInstallContext
{
    public string ToolRoot { get; set; } = "";
    public string WorkspaceDataPath { get; set; } = "";
    public string ProfileLinkPath { get; set; } = "";
    public string InstallContextPath { get; set; } = "";
    public string ProfileRoot { get; set; } = "";
    public string ServerPath { get; set; } = "";
    public string GamePath { get; set; } = "";
    public string SteamExePath { get; set; } = "";
    public string SteamServicePath { get; set; } = "";
    public string WorkshopContentPath { get; set; } = "";
    public string SteamCmdInstallDirectory { get; set; } = "";
    public string SteamCmdPath { get; set; } = "";
    public string NodeRoot { get; set; } = "";
    public string InstalledAt { get; set; } = "";
}

public sealed class EventTileCycleState
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; }
    public bool AutoAdvance { get; set; }
    public int CycleSize { get; set; }
    public int PreviewHours { get; set; }
    public int ActiveHours { get; set; }
    public int DeleteGraceHours { get; set; }
    public List<long> EligibleTileIds { get; set; } = [];
    public List<string> AllowedMapIds { get; set; } = [];
    public string Phase { get; set; } = "idle";
    public List<long> PreviewTileIds { get; set; } = [];
    public List<string> PreviewTileNames { get; set; } = [];
    public List<long> ActiveTileIds { get; set; } = [];
    public List<string> ActiveTileNames { get; set; } = [];
    public List<long> CleanupTileIds { get; set; } = [];
    public List<string> CleanupTileNames { get; set; } = [];
    public string? CleanupDeleteAfter { get; set; }
    public List<EventTileCleanupBatch> CleanupBatches { get; set; } = [];
    public int RotationCursor { get; set; }
    public string? PreviewStartedAt { get; set; }
    public string? ActiveStartedAt { get; set; }
    public string? NextTransitionAt { get; set; }
    public string NamePrefix { get; set; } = "[EVENT]";
    public int SpacingRadius { get; set; }
    public string QualityMode { get; set; } = "fixed";
    public int Quality { get; set; }
    public int QualityMin { get; set; }
    public int QualityMax { get; set; }
    public string PvpMode { get; set; } = "NoPvp";
    public string LastAction { get; set; } = "";

    [JsonIgnore]
    public int PreviewTileCount => PreviewTileIds?.Count ?? 0;

    [JsonIgnore]
    public int ActiveTileCount => ActiveTileIds?.Count ?? 0;

    [JsonIgnore]
    public string Summary => $"{Phase} | preview {PreviewTileCount} | active {ActiveTileCount}";

    public override string ToString() => string.IsNullOrWhiteSpace(Name) ? Id : Name;
}

public sealed class EventTileCleanupBatch
{
    public List<long> TileIds { get; set; } = [];
    public List<string> TileNames { get; set; } = [];
    public string DeleteAfter { get; set; } = "";
    public string? DeleteRequestedAt { get; set; }
}

public sealed class LaunchProfile
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string ExecutablePath { get; set; } = "";
    public string WorkingDirectory { get; set; } = "";
    public string Notes { get; set; } = "";
    public LastOasisLaunchSettings Launch { get; set; } = new();
    public RestartPolicy RestartPolicy { get; set; } = new();
    public string GeneratedArguments { get; set; } = "";
    public List<string> ValidationIssues { get; set; } = [];
}

public sealed class LastOasisLaunchSettings
{
    public int? SteamDedicatedServerAppId { get; set; }
    public string Identifier { get; set; } = "";
    public string CustomerKey { get; set; } = "";
    public string ProviderKey { get; set; } = "";
    public int Slots { get; set; }
    public int Port { get; set; }
    public int? QueryPort { get; set; }
    public string OverrideConnectionAddress { get; set; } = "";
    public string BackendApiUrl { get; set; } = "";
    public bool EnableLogs { get; set; }
    public bool ForceSteamClientLink { get; set; }
    public bool Messaging { get; set; }
    public bool NoLiveServer { get; set; }
    public bool EnableCheats { get; set; }
    public string ExtraArgs { get; set; } = "";
}

public sealed class RestartPolicy
{
    public bool Enabled { get; set; }
    public string ScheduleMode { get; set; } = "fixed-times";
    public List<string> FixedTimes { get; set; } = ["00:00", "12:00"];
    public int IntervalHours { get; set; }
    public int GracefulWarningMinutes { get; set; }
    public string? SkipNextScheduledRestartAt { get; set; }
    public string? CoveredScheduledRestartAt { get; set; }
}

public sealed class MyRealmSessionSnapshot
{
    public string? Browser { get; set; }
    public string ConnectedAt { get; set; } = "";
    public string? CustomerId { get; set; }
    public string? CustomerName { get; set; }
    public string? RealmId { get; set; }
    public string? RealmName { get; set; }
    public string? ApiKeyPreview { get; set; }
    public int? ActivePlayers { get; set; }
    public int? ActiveTiles { get; set; }
    public int? MaxTiles { get; set; }
    public List<string> ActiveTileNames { get; set; } = [];
    public List<MyRealmTileSummary> Tiles { get; set; } = [];
    public List<MyRealmCreateTileOption> AvailableCreateTileMaps { get; set; } = [];
    public string? HostingMode { get; set; }
    public string? ActivationMode { get; set; }
    public string? ExperienceMultiplier { get; set; }
    public string? FoliageRespawnMultiplier { get; set; }
    public string? HarvestQuantityMultiplier { get; set; }
    public string? MaxClanSize { get; set; }
    public string? ClanSwitchCooldown { get; set; }
    public string? TravelMode { get; set; }
    public string? AdditionalSettings { get; set; }
    public MyRealmLinks Links { get; set; } = new();
    public string Note { get; set; } = "";
}

public sealed class MyRealmLinks
{
    public string? DashboardUrl { get; set; }
    public string? RealmUrl { get; set; }
    public string? ApiUrl { get; set; }
    public string? GameplayUrl { get; set; }
    public string? MapUrl { get; set; }
    public string? CharactersUrl { get; set; }
    public string? HostingUrl { get; set; }
    public string? GenerateApiKeyUrl { get; set; }
    public string? UpdateMultipliersUrl { get; set; }
    public string? UpdateMaxClanSizeUrl { get; set; }
    public string? UpdateClanSwitchCooldownUrl { get; set; }
    public string? UpdateTravelModeUrl { get; set; }
    public string? UpdateAdditionalSettingsUrl { get; set; }
}

public sealed class MyRealmTileSummary
{
    public long TileId { get; set; }
    public string TileName { get; set; } = "";
    public string? MapName { get; set; }
    public string? StatusText { get; set; }
    public string? HostingStatusText { get; set; }
    public int? X { get; set; }
    public int? Y { get; set; }
    public int? Quality { get; set; }
    public string? PvpModeText { get; set; }
    public bool CanActivate { get; set; }
    public bool CanDeactivate { get; set; }
    public bool CanDelete { get; set; }
    public bool CanUseAutomation { get; set; }
    public bool IsActive { get; set; }
    public bool IsInactive { get; set; }
    public bool IsPendingActive { get; set; }
    public bool IsPendingInactive { get; set; }
    public int? PlayerCount { get; set; }
    public string? ActivationDate { get; set; }
    public string? DeactivationDate { get; set; }
}

public sealed class MyRealmCreateTileOption
{
    public string MapId { get; set; } = "";
    public string MapName { get; set; } = "";
    public string? Difficulty { get; set; }
}

public sealed class ConfigSaveResponse
{
    public bool Ok { get; set; }
    public AppConfig Config { get; set; } = new();
}

public sealed class RemotePasswordUpdateResponse
{
    public bool Ok { get; set; }
    public string PasswordSource { get; set; } = "";
    public string PasswordFilePath { get; set; } = "";
    public bool SessionsCleared { get; set; }
    public string UpdatedAt { get; set; } = "";
}

public sealed class SteamLoginInfoResponse
{
    public bool Configured { get; set; }
    public string AccountName { get; set; } = "";
    public bool HasPassword { get; set; }
    public bool SteamClientAutoLogin { get; set; }
    public string? UpdatedAt { get; set; }
    public string FilePath { get; set; } = "";
    public string Protection { get; set; } = "";
}

public sealed class SteamClientStatusResponse
{
    public bool Ok { get; set; }
    public string SteamExePath { get; set; } = "";
    public bool Running { get; set; }
    public bool CanLogin { get; set; }
    public string AccountName { get; set; } = "";
    public bool SteamClientAutoLogin { get; set; }
    public string CheckedAt { get; set; } = "";
    public string Note { get; set; } = "";
}

public sealed class SteamClientLoginResponse
{
    public bool Ok { get; set; }
    public string SteamExePath { get; set; } = "";
    public string AccountName { get; set; } = "";
    public string Reason { get; set; } = "";
    public bool RunningBefore { get; set; }
    public bool RunningAfter { get; set; }
    public string CheckedAt { get; set; } = "";
    public string Note { get; set; } = "";
}

public sealed class DetectIpResponse
{
    public DetectIpPayload Ip { get; set; } = new();
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class DetectIpPayload
{
    public string Address { get; set; } = "";
    public string Source { get; set; } = "";
}

public sealed class DashboardEnvelope
{
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class SessionEnvelope
{
    public MyRealmSessionSnapshot? Session { get; set; }
    public DashboardState? Dashboard { get; set; }
}

public sealed class MyRealmManagedBrowserResponse
{
    public bool Ok { get; set; }
    public string Url { get; set; } = "";
    public string TargetId { get; set; } = "";
}

public sealed class EventTileEnvelope
{
    public EventTileCycleResult Result { get; set; } = new();
    public MyRealmSessionSnapshot? Session { get; set; }
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class EventTileCycleResult
{
    public string Action { get; set; } = "";
    public string Phase { get; set; } = "idle";
    public List<long> PreviewTileIds { get; set; } = [];
    public List<long> ActiveTileIds { get; set; } = [];
    public List<string> PreviewTileNames { get; set; } = [];
    public List<string> ActiveTileNames { get; set; } = [];
    public List<long> CreatedTileIds { get; set; } = [];
    public List<string> CreatedTileNames { get; set; } = [];
    public string? ActivationAt { get; set; }
    public string? DeactivationAt { get; set; }
    public string? NextTransitionAt { get; set; }
    public string Message { get; set; } = "";
}

public sealed class EventTileDryRunCandidate
{
    public int X { get; set; }
    public int Y { get; set; }
    public int DistanceScore { get; set; }
    public int AnchorTouches { get; set; }
    public string? MapId { get; set; }
    public string? MapName { get; set; }
    public int Quality { get; set; }
    public string PvpMode { get; set; } = "";
    public string Name { get; set; } = "";
}

public sealed class EventTileDryRunResult
{
    public string CycleId { get; set; } = "";
    public string CycleName { get; set; } = "";
    public string GeneratedAt { get; set; } = "";
    public int DesiredCount { get; set; }
    public int AvailableCandidates { get; set; }
    public List<EventTileDryRunCandidate> SelectedCandidates { get; set; } = [];
    public int SkippedCoordinates { get; set; }
    public string Message { get; set; } = "";
}

public sealed class EventTileDryRunEnvelope
{
    public EventTileDryRunResult Result { get; set; } = new();
}

public sealed class MyRealmApiProbeRow
{
    public string Label { get; set; } = "";
    public string Path { get; set; } = "";
    public string HeaderMode { get; set; } = "none";
    public int? Status { get; set; }
    public string? ContentType { get; set; }
    public long? ContentLength { get; set; }
    public string? RedirectedTo { get; set; }
    public string? Note { get; set; }
}

public sealed class MyRealmApiProbeResult
{
    public string CheckedAt { get; set; } = "";
    public string BaseUrl { get; set; } = "";
    public bool HasApiKey { get; set; }
    public List<MyRealmApiProbeRow> Rows { get; set; } = [];
}

public sealed class MyRealmApiProbeEnvelope
{
    public MyRealmApiProbeResult Result { get; set; } = new();
}

public sealed class ManagerAuditEntry
{
    public string Id { get; set; } = "";
    public string CreatedAt { get; set; } = "";
    public string Category { get; set; } = "";
    public string Action { get; set; } = "";
    public string Status { get; set; } = "";
    public string Summary { get; set; } = "";
    public string? Details { get; set; }
}

public sealed class AuditEnvelope
{
    public List<ManagerAuditEntry> Entries { get; set; } = [];
}

public sealed class InGameMessageBridgeStatus
{
    public bool Configured { get; set; }
    public string Mode { get; set; } = "not-configured";
    public string? Endpoint { get; set; }
    public string? PollEndpoint { get; set; }
    public string? AckEndpoint { get; set; }
    public string? AdminEndpoint { get; set; }
    public string? ChatEndpoint { get; set; }
    public string? ChatLogPath { get; set; }
    public string? MarkerInboxPath { get; set; }
    public string? MarkerInboxRootPath { get; set; }
    public string? MarkerGlobalNoWidgetPath { get; set; }
    public string? MarkerTileInboxPath { get; set; }
    public string? MarkerTileNoWidgetInboxPath { get; set; }
    public string? MarkerTileDiscordInboxPath { get; set; }
    public bool MarkerMessagesEnabled { get; set; }
    public int QueueDepth { get; set; }
    public int PendingCount { get; set; }
    public int DeliveredCount { get; set; }
    public string? LastPollAt { get; set; }
    public string? LastClientId { get; set; }
    public string? LastClientVersion { get; set; }
    public string? LastClientMap { get; set; }
    public DiscordBotStatus? DiscordBot { get; set; }
    public string LastCheckedAt { get; set; } = "";
    public string Note { get; set; } = "";
}

public sealed class DiscordBotStatus
{
    public bool Enabled { get; set; }
    public string? ChannelId { get; set; }
    public string Status { get; set; } = "";
    public string? LastError { get; set; }
}

public sealed class MessageBridgeEnvelope
{
    public InGameMessageBridgeStatus Status { get; set; } = new();
}

public sealed class GameBridgeMessage
{
    public string Id { get; set; } = "";
    public string CreatedAt { get; set; } = "";
    public string ExpiresAt { get; set; } = "";
    public string Type { get; set; } = "";
    public string Severity { get; set; } = "";
    public string Source { get; set; } = "";
    public string Target { get; set; } = "";
    public string? TargetScope { get; set; }
    public string? TargetIdentifier { get; set; }
    public string? TargetLabel { get; set; }
    public bool WithWidget { get; set; }
    public string? CommandFilePath { get; set; }
    public string? Title { get; set; }
    public string Message { get; set; } = "";
    public int DurationSeconds { get; set; }
    public int? CountdownSeconds { get; set; }
    public string? DedupeKey { get; set; }
    public string? DeliveredAt { get; set; }
    public string? AcknowledgedAt { get; set; }
    public string? AcknowledgedBy { get; set; }
}

public sealed class GameBridgeMessagesEnvelope
{
    public InGameMessageBridgeStatus Status { get; set; } = new();
    public List<GameBridgeMessage> Messages { get; set; } = [];
}

public sealed class GameBridgeSendEnvelope
{
    public GameBridgeMessage Message { get; set; } = new();
    public InGameMessageBridgeStatus Status { get; set; } = new();
}

public sealed class GameBridgeChatEntry
{
    public string Id { get; set; } = "";
    public string CreatedAt { get; set; } = "";
    public string Channel { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public string Message { get; set; } = "";
    public string? MapName { get; set; }
    public string? TileName { get; set; }
    public string? ProfileId { get; set; }
    public string? ClientId { get; set; }
}

public sealed class GameBridgeChatEnvelope
{
    public InGameMessageBridgeStatus Status { get; set; } = new();
    public List<GameBridgeChatEntry> Entries { get; set; } = [];
}

public sealed class GameBridgeTargetOption
{
    public string Label { get; set; } = "";
    public string Scope { get; set; } = "global";
    public string? Identifier { get; set; }
    public string? TileName { get; set; }

    public override string ToString() => Label;
}

public sealed class DiagnosticProfileSummary
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Identifier { get; set; } = "";
    public int GamePort { get; set; }
    public int? QueryPort { get; set; }
    public bool RestartEnabled { get; set; }
    public List<string> ValidationIssues { get; set; } = [];
}

public sealed class DiagnosticMyRealmSummary
{
    public bool HasFlow { get; set; }
    public bool CustomerIdKnown { get; set; }
    public bool RealmIdKnown { get; set; }
    public bool ApiKeyConfigured { get; set; }
    public bool SessionCached { get; set; }
    public int CachedTileCount { get; set; }
}

public sealed class DiagnosticOperationsSummary
{
    public bool SteamCmdConfigured { get; set; }
    public bool WorkshopPathConfigured { get; set; }
    public int ModCount { get; set; }
    public bool AutoUpdateMods { get; set; }
    public bool AutoUpdateGameServer { get; set; }
    public bool AutoRestartOfflineRealms { get; set; }
    public bool DiscordMyRealmWebhookConfigured { get; set; }
    public bool DiscordUpdateWebhookConfigured { get; set; }
    public bool DiscordEventTileWebhookConfigured { get; set; }
}

public sealed class DiagnosticBundle
{
    public string CreatedAt { get; set; } = "";
    public string AppVersion { get; set; } = "";
    public Dictionary<string, string> Paths { get; set; } = [];
    public List<DiagnosticProfileSummary> Profiles { get; set; } = [];
    public DiagnosticMyRealmSummary MyRealm { get; set; } = new();
    public DiagnosticOperationsSummary Operations { get; set; } = new();
    public List<ManagerAuditEntry> RecentAudit { get; set; } = [];
}

public sealed class DiagnosticEnvelope
{
    public DiagnosticBundle Bundle { get; set; } = new();
}

public sealed class MonitorState
{
    public bool Online { get; set; }
    public int Profiles { get; set; }
    public int RunningHosts { get; set; }
    public int DesiredHosts { get; set; }
    public string? SelectedProfileId { get; set; }
    public string? SelectedProfileName { get; set; }
    public string? SelectedIdentifier { get; set; }
    public string EventPhase { get; set; } = "idle";
    public int PreviewBatchCount { get; set; }
    public int ActiveBatchCount { get; set; }
    public string? NextTransitionAt { get; set; }
    public string ServerAction { get; set; } = "";
    public string EventAction { get; set; } = "";
    public string LaunchPhase { get; set; } = "idle";
    public string LaunchSummary { get; set; } = "";
    public int PendingHosts { get; set; }
    public int WarmingHosts { get; set; }
}

public sealed class StartAllResponse
{
    public bool Accepted { get; set; }
    public bool AlreadyRunning { get; set; }
    public List<string> ProfileIds { get; set; } = [];
}

public sealed class SimpleDashboardResponse
{
    public bool Ok { get; set; }
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class ModSyncResult
{
    public string ModsPath { get; set; } = "";
    public List<string> Synced { get; set; } = [];
    public List<string> Updated { get; set; } = [];
    public List<string> Missing { get; set; } = [];
    public List<string> Activated { get; set; } = [];
    public List<string> Deactivated { get; set; } = [];
    public bool UsedSteamCmd { get; set; }
    public bool MirroredToSteamWorkshop { get; set; }
}

public sealed class ModSyncEnvelope
{
    public ModSyncResult Result { get; set; } = new();
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class GameUpdateCheckResult
{
    public int AppId { get; set; }
    public string Branch { get; set; } = "";
    public string CheckedAt { get; set; } = "";
    public string SteamCmdPath { get; set; } = "";
    public string InstallPath { get; set; } = "";
    public string? LocalManifestPath { get; set; }
    public string? LocalBuildId { get; set; }
    public string? LatestBuildId { get; set; }
    public string? LatestUpdatedAt { get; set; }
    public bool? UpdateAvailable { get; set; }
    public string Note { get; set; } = "";
    public string Stderr { get; set; } = "";
}

public sealed class GameUpdateCheckEnvelope
{
    public GameUpdateCheckResult Result { get; set; } = new();
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class GameUpdateRestartPlan
{
    public bool RestartScheduled { get; set; }
    public string? RestartAt { get; set; }
    public string Note { get; set; } = "";
}

public sealed class GameUpdateRunResult
{
    public string Stdout { get; set; } = "";
    public string Stderr { get; set; } = "";
}

public sealed class GameUpdateEnvelope
{
    public GameUpdateRunResult? Result { get; set; }
    public GameUpdateRestartPlan RestartPlan { get; set; } = new();
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class ModUpdateResult
{
    public List<string> UpdatedIds { get; set; } = [];
    public bool RestartScheduled { get; set; }
    public string? RestartAt { get; set; }
    public string Note { get; set; } = "";
}

public sealed class ModUpdateEnvelope
{
    public ModUpdateResult Result { get; set; } = new();
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class ModReconcileResult
{
    public ModSyncResult Sync { get; set; } = new();
    public List<string> UpdatedIds { get; set; } = [];
    public bool RestartScheduled { get; set; }
    public string? RestartAt { get; set; }
    public string Note { get; set; } = "";
}

public sealed class ModReconcileEnvelope
{
    public ModReconcileResult Result { get; set; } = new();
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class ModInstallEnvelope
{
    public string ModId { get; set; } = "";
    public bool AlreadyConfigured { get; set; }
    public ModSyncResult Result { get; set; } = new();
    public DashboardState Dashboard { get; set; } = new();
}

public sealed class SelectableMapOption : INotifyPropertyChanged
{
    private bool _isSelected;

    public bool IsSelected
    {
        get => _isSelected;
        set
        {
            if (_isSelected == value)
            {
                return;
            }

            _isSelected = value;
            OnPropertyChanged();
        }
    }

    public string MapId { get; set; } = "";
    public string MapName { get; set; } = "";
    public string? Difficulty { get; set; }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}

public sealed class SelectableTileOption : INotifyPropertyChanged
{
    private bool _isSelected;

    public bool IsSelected
    {
        get => _isSelected;
        set
        {
            if (_isSelected == value)
            {
                return;
            }

            _isSelected = value;
            OnPropertyChanged();
        }
    }

    public long TileId { get; set; }
    public string TileName { get; set; } = "";
    public string? MapName { get; set; }
    public string? StatusText { get; set; }
    public int? X { get; set; }
    public int? Y { get; set; }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}
