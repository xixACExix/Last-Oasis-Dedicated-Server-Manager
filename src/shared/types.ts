export type HealthCheck = {
  label: string;
  ok: boolean;
  value: string;
  details?: string;
};

export type DiscoveredPaths = {
  installPath: string;
  executablePath: string;
  workingDirectory: string;
  localDataPath: string;
  logsPath: string;
  adminDataPath: string;
  serverConfigPath: string;
  persistedConfigPath: string;
  backupsPath: string;
};

export type LastOasisLaunchSettings = {
  steamDedicatedServerAppId?: number | null;
  identifier: string;
  customerKey: string;
  providerKey: string;
  slots: number;
  port: number;
  queryPort: number | null;
  overrideConnectionAddress: string;
  backendApiUrl: string;
  enableLogs: boolean;
  forceSteamClientLink: boolean;
  messaging: boolean;
  noLiveServer: boolean;
  enableCheats: boolean;
  extraArgs: string;
};

export type RestartPolicy = {
  enabled: boolean;
  scheduleMode: "fixed-times" | "interval";
  fixedTimes: string[];
  intervalHours: number;
  gracefulWarningMinutes: number;
  skipNextScheduledRestartAt: string | null;
  coveredScheduledRestartAt: string | null;
};

export type RealmSettings = {
  customerKey: string;
  providerKey: string;
  providerName: string;
  apiKey: string;
};

export type MyRealmFlowSummary = {
  browser: string | null;
  customerId: string | null;
  realmId: string | null;
  dashboardUrl: string | null;
  realmUrl: string | null;
  mapUrl: string | null;
  serversUrl: string | null;
  providersUrl: string | null;
  usersUrl: string | null;
  apiUrl: string | null;
  recentTileUrls: string[];
  note: string;
};

export type MyRealmSessionSnapshot = {
  browser: string | null;
  connectedAt: string;
  customerId: string | null;
  customerName: string | null;
  realmId: string | null;
  realmName: string | null;
  apiKeyPreview: string | null;
  activePlayers: number | null;
  activeTiles: number | null;
  maxTiles: number | null;
  activeTileNames: string[];
  tiles: MyRealmTileSummary[];
  availableCreateTileMaps: MyRealmCreateTileOption[];
  hostingMode: string | null;
  activationMode: string | null;
  experienceMultiplier: string | null;
  foliageRespawnMultiplier: string | null;
  harvestQuantityMultiplier: string | null;
  maxClanSize: string | null;
  clanSwitchCooldown: string | null;
  travelMode: string | null;
  additionalSettings: string | null;
  links: {
    dashboardUrl: string | null;
    realmUrl: string | null;
    apiUrl: string | null;
    gameplayUrl: string | null;
    mapUrl: string | null;
    charactersUrl: string | null;
    hostingUrl: string | null;
    generateApiKeyUrl: string | null;
    updateMultipliersUrl: string | null;
    updateMaxClanSizeUrl: string | null;
    updateClanSwitchCooldownUrl: string | null;
    updateTravelModeUrl: string | null;
    updateAdditionalSettingsUrl: string | null;
  };
  note: string;
};

export type MyRealmTileModsSyncEntry = {
  tileId: number;
  tileName: string;
  mapName: string | null;
  statusText: string | null;
  previousAdditionalSettings: string | null;
  nextAdditionalSettings: string;
};

export type MyRealmTileModsSyncResult = {
  realmId: string;
  desiredModsSetting: string;
  syncedModIds: string[];
  updatedTiles: MyRealmTileModsSyncEntry[];
  unchangedTiles: MyRealmTileModsSyncEntry[];
};

export type MyRealmCreateTileOption = {
  mapId: string;
  mapName: string;
  difficulty: string | null;
};

export type MyRealmTileSummary = {
  tileId: number;
  tileName: string;
  mapName: string | null;
  statusText: string | null;
  hostingStatusText: string | null;
  x: number | null;
  y: number | null;
  quality: number | null;
  pvpModeText: string | null;
  canActivate: boolean;
  canDeactivate: boolean;
  canDelete: boolean;
  canUseAutomation: boolean;
  isActive: boolean;
  isInactive: boolean;
  isPendingActive: boolean;
  isPendingInactive: boolean;
  playerCount: number | null;
  activationDate: string | null;
  deactivationDate: string | null;
};

export type EventTileCyclePhase = "idle" | "preview" | "active" | "cleanup";
export type MyRealmTilePvpMode = "NoPvp" | "FullPvp";
export type EventTileQualityMode = "fixed" | "random";

export type EventTileCleanupBatch = {
  tileIds: number[];
  tileNames: string[];
  deleteAfter: string;
  deleteRequestedAt: string | null;
};

export type EventTileCycleState = {
  id: string;
  name: string;
  enabled: boolean;
  autoAdvance: boolean;
  cycleSize: number;
  previewHours: number;
  activeHours: number;
  deleteGraceHours: number;
  eligibleTileIds: number[];
  allowedMapIds: string[];
  phase: EventTileCyclePhase;
  previewTileIds: number[];
  previewTileNames: string[];
  activeTileIds: number[];
  activeTileNames: string[];
  cleanupTileIds: number[];
  cleanupTileNames: string[];
  cleanupDeleteAfter: string | null;
  cleanupBatches: EventTileCleanupBatch[];
  rotationCursor: number;
  previewStartedAt: string | null;
  activeStartedAt: string | null;
  cleanupDeleteRequestedAt: string | null;
  nextTransitionAt: string | null;
  namePrefix: string;
  spacingRadius: number;
  qualityMode: EventTileQualityMode;
  quality: number;
  qualityMin: number;
  qualityMax: number;
  pvpMode: MyRealmTilePvpMode;
  lastAction: string;
};

export type EventTileCycleResult = {
  action:
    | "preview_started"
    | "preview_promoted"
    | "active_burned"
    | "cleanup_scheduled"
    | "cleanup_finished"
    | "manual_cleanup"
    | "paused"
    | "maintenance_checked";
  phase: EventTileCyclePhase;
  previewTileIds: number[];
  activeTileIds: number[];
  previewTileNames: string[];
  activeTileNames: string[];
  createdTileIds: number[];
  createdTileNames: string[];
  createdTiles: Array<{
    tileId: number;
    tileName: string;
    mapName: string | null;
    quality: number | null;
    activationAt: string | null;
    deactivationAt: string | null;
  }>;
  activationAt: string | null;
  deactivationAt: string | null;
  nextTransitionAt: string | null;
  message: string;
};

export type EventTileDryRunCandidate = {
  x: number;
  y: number;
  distanceScore: number;
  anchorTouches: number;
  mapId: string | null;
  mapName: string | null;
  quality: number;
  pvpMode: MyRealmTilePvpMode;
  name: string;
};

export type EventTileDryRunResult = {
  cycleId: string;
  cycleName: string;
  generatedAt: string;
  desiredCount: number;
  availableCandidates: number;
  selectedCandidates: EventTileDryRunCandidate[];
  skippedCoordinates: number;
  message: string;
};

export type MyRealmApiProbeRow = {
  label: string;
  path: string;
  headerMode: "none" | "x-api-key" | "bearer" | "api-key";
  status: number | null;
  contentType: string | null;
  contentLength: number | null;
  redirectedTo: string | null;
  note: string | null;
};

export type MyRealmApiProbeResult = {
  checkedAt: string;
  baseUrl: string;
  hasApiKey: boolean;
  rows: MyRealmApiProbeRow[];
};

export type ManagerAuditEntry = {
  id: string;
  createdAt: string;
  category: "myrealm" | "event-tiles" | "mods" | "server" | "diagnostics" | "message-bridge";
  action: string;
  status: "info" | "success" | "warning" | "error";
  summary: string;
  details?: string;
};

export type InGameMessageBridgeStatus = {
  configured: boolean;
  mode: "not-configured" | "mod-bridge";
  endpoint: string | null;
  pollEndpoint?: string | null;
  ackEndpoint?: string | null;
  adminEndpoint?: string | null;
  chatEndpoint?: string | null;
  chatLogPath?: string | null;
  markerInboxPath?: string | null;
  markerInboxRootPath?: string | null;
  markerGlobalNoWidgetPath?: string | null;
  markerTileInboxPath?: string | null;
  markerTileNoWidgetInboxPath?: string | null;
  markerTileDiscordInboxPath?: string | null;
  markerMessagesEnabled?: boolean;
  queueDepth?: number;
  pendingCount?: number;
  deliveredCount?: number;
  lastPollAt?: string | null;
  lastClientId?: string | null;
  lastClientVersion?: string | null;
  lastClientMap?: string | null;
  discordBot?: {
    enabled: boolean;
    channelId: string | null;
    status: string;
    lastError: string | null;
  };
  lastCheckedAt: string;
  note: string;
};

export type GameBridgeMessageType =
  | "admin"
  | "restart-warning"
  | "restart-now"
  | "update-warning"
  | "update-status"
  | "maintenance"
  | "system";

export type GameBridgeMessageSeverity = "info" | "success" | "warning" | "danger";
export type GameBridgeTargetScope = "global" | "tile";

export type GameBridgeMessage = {
  id: string;
  createdAt: string;
  expiresAt: string;
  type: GameBridgeMessageType;
  severity: GameBridgeMessageSeverity;
  source: "manager" | "scheduler" | "manual" | "mod-update" | "game-update" | "system";
  target: "all" | "tile";
  targetScope?: GameBridgeTargetScope;
  targetIdentifier?: string | null;
  targetLabel?: string | null;
  withWidget?: boolean;
  commandFilePath?: string | null;
  title: string | null;
  message: string;
  durationSeconds: number;
  countdownSeconds: number | null;
  dedupeKey: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
};

export type GameBridgePollResponse = {
  serverTime: string;
  status: InGameMessageBridgeStatus;
  messages: GameBridgeMessage[];
};

export type GameBridgeChatEntry = {
  id: string;
  createdAt: string;
  channel: "all" | "map" | "clan" | "combat" | "other";
  playerName: string;
  message: string;
  mapName: string | null;
  tileName: string | null;
  profileId: string | null;
  clientId: string | null;
  externalId: string | null;
  dedupeKey: string;
  discordPostedAt: string | null;
};

export type DiagnosticBundle = {
  createdAt: string;
  appVersion: string;
  paths: Record<string, string>;
  profiles: Array<{
    id: string;
    name: string;
    identifier: string;
    gamePort: number;
    queryPort: number | null;
    restartEnabled: boolean;
    validationIssues: string[];
  }>;
  myRealm: {
    hasFlow: boolean;
    customerIdKnown: boolean;
    realmIdKnown: boolean;
    apiKeyConfigured: boolean;
    sessionCached: boolean;
    cachedTileCount: number;
  };
  operations: {
    modCount: number;
    autoUpdateMods: boolean;
    autoUpdateGameServer: boolean;
    modUpdateCheckMinutes: number;
    gameUpdateCheckMinutes: number;
    autoRestartOfflineRealms: boolean;
    discordWebhooksConfigured: number;
  };
  messageBridge: {
    queueDepth: number;
    pendingCount: number;
    lastPollAt: string | null;
    lastClientId: string | null;
    chatLogPath: string | null;
  };
  recentAudit: ManagerAuditEntry[];
};

export type OperationsSettings = {
  steamCmdPath: string;
  steamCmdInstallDirectory: string;
  workshopContentPath: string;
  modIds: string[];
  betaBranch: string;
  appId: number;
  lastKnownPublicIp: string;
  modSyncDeletesMissing: boolean;
  autoUpdateMods: boolean;
  autoUpdateGameServer: boolean;
  modUpdateCheckMinutes: number;
  gameUpdateCheckMinutes: number;
  modUpdateGraceMinutes: number;
  discordMyRealmWebhookUrl: string;
  discordPlayerCounterWebhookUrl: string;
  discordTileOnlineWebhookUrl: string;
  discordUpdateWebhookUrl: string;
  discordEventTileWebhookUrl: string;
  discordGameChatWebhookUrl: string;
  discordBotEnabled: boolean;
  discordBotToken: string;
  discordBotChannelId: string;
  discordMaintenanceRoleId: string;
  gameBridgeModMessagesEnabled: boolean;
  gameBridgeInboxRootPath: string;
  gameBridgeCommandFilePath: string;
  gameBridgeNoWidgetCommandFilePath: string;
  gameBridgeTileWidgetDirectory: string;
  gameBridgeTileNoWidgetDirectory: string;
  gameBridgeTileDiscordDirectory: string;
  autoRestartOfflineRealms: boolean;
  offlineRestartGraceMinutes: number;
};

export type SchedulerStatus = {
  enabled: boolean;
  monitoredProfileId: string | null;
  monitoredProfileName: string | null;
  nextRestartAt: string | null;
  restartScheduleMode: "fixed-times" | "interval";
  restartScheduleLabel: string;
  skippedRestartAt: string | null;
  skipActive: boolean;
  pendingAction: "restart" | "stop" | null;
  pendingSource: "scheduled" | "mod-update" | "game-update" | "maintenance-stop" | null;
  pendingReason: string | null;
  pendingTargetSummary: string | null;
  lastWebhookTitle: string | null;
  lastWebhookAt: string | null;
  lastAction: string;
  running: boolean;
  autoRestartEnabled: boolean;
  desiredRunningProfiles: number;
};

export type LaunchStatus = {
  phase: "idle" | "launching" | "warming" | "partial" | "hosting";
  summary: string;
  desiredHosts: number;
  processHosts: number;
  hostingReadyHosts: number;
  warmingHosts: number;
  pendingHosts: number;
};

export type LaunchProfile = {
  id: string;
  name: string;
  executablePath: string;
  workingDirectory: string;
  notes: string;
  launch: LastOasisLaunchSettings;
  restartPolicy: RestartPolicy;
  generatedArguments: string;
  validationIssues: string[];
};

export type AppConfig = {
  selectedProfileId: string | null;
  selectedEventTileCycleId: string | null;
  paths: DiscoveredPaths;
  realmSettings: RealmSettings;
  myRealmFlow: MyRealmFlowSummary | null;
  operationsSettings: OperationsSettings;
  eventTileCycle: EventTileCycleState;
  eventTileCycles: EventTileCycleState[];
  profiles: LaunchProfile[];
};

export type ServerProcess = {
  pid: number;
  name: string;
  commandLine: string;
  startedAt: string | null;
  memoryMb: number;
};

export type LogFileSummary = {
  name: string;
  path: string;
  modifiedAt: string;
  sizeBytes: number;
};

export type AdminCommandGroup = {
  name: string;
  count: number;
  commands: string[];
};

export type AdminDataSummary = {
  path: string | null;
  commandGroups: AdminCommandGroup[];
  itemSetCount: number;
};

export type BackupSummary = {
  name: string;
  path: string;
  modifiedAt: string;
  sizeBytes: number;
};

export type LivePlayerSummary = {
  name: string;
  score: number;
  durationSeconds: number;
};

export type LiveServerSummary = {
  processId: number | null;
  identifier: string | null;
  gamePort: number | null;
  online: boolean;
  status: "offline" | "running" | "activity" | "query";
  serverName: string | null;
  map: string | null;
  game: string | null;
  version: string | null;
  playerCount: number;
  maxPlayers: number | null;
  queryPort: number | null;
  players: LivePlayerSummary[];
  note?: string;
};

export type PlayerActivityEntry = {
  activityType: "persisted" | "observed" | "login" | "join" | "disconnect" | "host_tile";
  playerName: string;
  uniqueNetId: string;
  observedAt: string;
  mapName: string | null;
  characterId: string | null;
  connectionAddress: string | null;
  sourceLog: string | null;
  sourceLine: string;
};

export type ModSummary = {
  modId: string;
  title: string;
  localTitle: string | null;
  description: string | null;
  tag: string | null;
  folderName: string | null;
  active: boolean | null;
  modKitVersion: number | null;
  versionLabel: string | null;
  creator: string | null;
  previewUrl: string | null;
  workshopUrl: string;
  localPath: string | null;
  serverPath: string | null;
  localUpdatedAt: string | null;
  serverUpdatedAt: string | null;
  workshopUpdatedAt: string | null;
  serverInstalled: boolean;
  hasWorkshopMetadata: boolean;
  updateAvailable: boolean;
  deprecated: boolean;
};

export type GameUpdateCheckResult = {
  appId: number;
  branch: string;
  checkedAt: string;
  steamCmdPath: string;
  installPath: string;
  localManifestPath: string | null;
  localBuildId: string | null;
  latestBuildId: string | null;
  latestUpdatedAt: string | null;
  updateAvailable: boolean | null;
  note: string;
  stderr: string;
};

export type DashboardState = {
  config: AppConfig;
  myRealmSession: MyRealmSessionSnapshot | null;
  runningProcesses: ServerProcess[];
  health: HealthCheck[];
  networkAddresses: {
    publicIp: string | null;
    localIp: string | null;
  };
  logFiles: LogFileSummary[];
  adminData: AdminDataSummary;
  backups: BackupSummary[];
  schedulerStatus: SchedulerStatus;
  launchStatus: LaunchStatus;
  liveServer: LiveServerSummary;
  liveServers: LiveServerSummary[];
  playerActivity: PlayerActivityEntry[];
  mods: ModSummary[];
};

export type LogTailResponse = {
  file: LogFileSummary;
  lines: number;
  content: string;
};
