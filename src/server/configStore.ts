import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildLastOasisArguments, validateLastOasisSettings } from "../shared/lastOasis.js";
import type {
  AppConfig,
  DiscoveredPaths,
  EventTileCycleState,
  LastOasisLaunchSettings,
  LaunchProfile,
  MyRealmFlowSummary,
  OperationsSettings,
  RealmSettings,
} from "../shared/types.js";

const lastOasisLaunchSettingsSchema = z.object({
  steamDedicatedServerAppId: z.number().int().nullable().optional(),
  identifier: z.string(),
  customerKey: z.string(),
  providerKey: z.string(),
  slots: z.number().int(),
  port: z.number().int(),
  queryPort: z.number().int().nullable(),
  overrideConnectionAddress: z.string(),
  backendApiUrl: z.string(),
  enableLogs: z.boolean(),
  forceSteamClientLink: z.boolean(),
  messaging: z.boolean(),
  noLiveServer: z.boolean(),
  enableCheats: z.boolean(),
  extraArgs: z.string(),
});

const restartPolicySchema = z.object({
  enabled: z.boolean(),
  scheduleMode: z.enum(["fixed-times", "interval"]).catch("fixed-times"),
  fixedTimes: z.array(z.string()).catch(["00:00", "12:00"]),
  intervalHours: z.number().int(),
  gracefulWarningMinutes: z.number().int(),
  skipNextScheduledRestartAt: z.string().nullable().catch(null),
  coveredScheduledRestartAt: z.string().nullable().catch(null),
});

const realmSettingsSchema = z.object({
  customerKey: z.string(),
  providerKey: z.string(),
  providerName: z.string(),
  apiKey: z.string(),
});

const myRealmFlowSchema = z.object({
  browser: z.string().nullable(),
  customerId: z.string().nullable(),
  realmId: z.string().nullable(),
  dashboardUrl: z.string().nullable(),
  realmUrl: z.string().nullable(),
  mapUrl: z.string().nullable(),
  serversUrl: z.string().nullable(),
  providersUrl: z.string().nullable(),
  usersUrl: z.string().nullable(),
  apiUrl: z.string().nullable(),
  recentTileUrls: z.array(z.string()),
  note: z.string(),
});

const operationsSettingsSchema = z.object({
  steamCmdPath: z.string(),
  steamCmdInstallDirectory: z.string(),
  workshopContentPath: z.string(),
  modIds: z.array(z.string()),
  betaBranch: z.string(),
  appId: z.number().int(),
  lastKnownPublicIp: z.string(),
  modSyncDeletesMissing: z.boolean(),
  autoUpdateMods: z.boolean(),
  autoUpdateGameServer: z.boolean(),
  modUpdateCheckMinutes: z.number().int(),
  gameUpdateCheckMinutes: z.number().int(),
  modUpdateGraceMinutes: z.number().int(),
  discordMyRealmWebhookUrl: z.string(),
  discordPlayerCounterWebhookUrl: z.string(),
  discordTileOnlineWebhookUrl: z.string(),
  discordUpdateWebhookUrl: z.string(),
  discordEventTileWebhookUrl: z.string(),
  discordGameChatWebhookUrl: z.string().catch(""),
  discordBotEnabled: z.boolean().catch(false),
  discordBotToken: z.string().catch(""),
  discordBotChannelId: z.string().catch(""),
  discordMaintenanceRoleId: z.string(),
  gameBridgeModMessagesEnabled: z.boolean().catch(true),
  gameBridgeInboxRootPath: z.string().catch(""),
  gameBridgeCommandFilePath: z.string().catch(""),
  autoRestartOfflineRealms: z.boolean(),
  offlineRestartGraceMinutes: z.number().int(),
});

const eventTileCleanupBatchSchema = z.object({
  tileIds: z.array(z.number().int()).catch([]),
  tileNames: z.array(z.string()).catch([]),
  deleteAfter: z.string(),
  deleteRequestedAt: z.string().nullable().catch(null),
});

const eventTileCycleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  autoAdvance: z.boolean(),
  cycleSize: z.number().int(),
  previewHours: z.number().int(),
  activeHours: z.number().int(),
  deleteGraceHours: z.number().int(),
  eligibleTileIds: z.array(z.number().int()),
  allowedMapIds: z.array(z.string()),
  phase: z.enum(["idle", "preview", "active", "cleanup"]),
  previewTileIds: z.array(z.number().int()),
  previewTileNames: z.array(z.string()),
  activeTileIds: z.array(z.number().int()),
  activeTileNames: z.array(z.string()),
  cleanupTileIds: z.array(z.number().int()).catch([]),
  cleanupTileNames: z.array(z.string()).catch([]),
  cleanupDeleteAfter: z.string().nullable().catch(null),
  cleanupBatches: z.array(eventTileCleanupBatchSchema).catch([]),
  rotationCursor: z.number().int(),
  previewStartedAt: z.string().nullable(),
  activeStartedAt: z.string().nullable(),
  cleanupDeleteRequestedAt: z.string().nullable(),
  nextTransitionAt: z.string().nullable(),
  namePrefix: z.string(),
  spacingRadius: z.number().int(),
  qualityMode: z.enum(["fixed", "random"]),
  quality: z.number().int(),
  qualityMin: z.number().int(),
  qualityMax: z.number().int(),
  pvpMode: z.enum(["NoPvp", "FullPvp"]),
  lastAction: z.string(),
});

const launchProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  executablePath: z.string().min(1),
  workingDirectory: z.string().min(1),
  notes: z.string(),
  launch: lastOasisLaunchSettingsSchema,
  restartPolicy: restartPolicySchema,
  generatedArguments: z.string(),
  validationIssues: z.array(z.string()),
});

const legacyLaunchProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  executablePath: z.string().min(1),
  workingDirectory: z.string().min(1),
  arguments: z.string(),
  notes: z.string(),
});

const discoveredPathsSchema = z.object({
  installPath: z.string(),
  executablePath: z.string(),
  workingDirectory: z.string(),
  localDataPath: z.string(),
  logsPath: z.string(),
  adminDataPath: z.string(),
  serverConfigPath: z.string(),
  persistedConfigPath: z.string(),
  backupsPath: z.string(),
});

const appConfigSchema = z.object({
  selectedProfileId: z.string().nullable(),
  selectedEventTileCycleId: z.string().nullable(),
  paths: discoveredPathsSchema,
  realmSettings: realmSettingsSchema,
  myRealmFlow: myRealmFlowSchema.nullable(),
  operationsSettings: operationsSettingsSchema,
  eventTileCycle: eventTileCycleSchema,
  eventTileCycles: z.array(eventTileCycleSchema),
  profiles: z.array(launchProfileSchema),
});

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const WORKSPACE_DATA_DIR = path.join(ROOT_DIR, "data");
const PROFILE_LINK_PATH = path.join(WORKSPACE_DATA_DIR, "profile-link.json");
const PROFILE_ROOT_ENV = "TOOL_01_PROFILE_ROOT";
const DEFAULT_PROFILE_FOLDER_NAME = "LO_Profiles";
const LEGACY_PROFILE_FOLDER_NAME = "LO_Profile";
const DEFAULT_GAME_BRIDGE_INBOX_ROOT_PATH =
  "C:\\LastOasisServer\\Mist\\Content\\Mods\\LOManagerBridge\\Inbox";
const DEFAULT_GAME_BRIDGE_COMMAND_FILE_PATH =
  path.join(DEFAULT_GAME_BRIDGE_INBOX_ROOT_PATH, "Admin.json");
const LAST_OASIS_LAUNCH_APP_ID = 903950;
const LAST_OASIS_DEDICATED_SERVER_APP_ID = 920720;
let configSaveQueue: Promise<unknown> = Promise.resolve();
let loadedConfigCache: {
  key: string;
  config: AppConfig;
} | null = null;

type ProfileDataLink = {
  profileRoot?: string;
  linkedAt?: string;
};

function toWindowsPath(targetPath: string) {
  return process.platform === "win32" ? targetPath.replace(/\//g, "\\") : targetPath;
}

function normalizeUserPath(targetPath: string) {
  return toWindowsPath(path.resolve(targetPath));
}

function getDefaultProfileRootCandidates() {
  const candidates: string[] = [];
  const homeDirectory = os.homedir();

  if (homeDirectory) {
    const desktopDirectory = path.join(homeDirectory, "Desktop");
    candidates.push(path.join(desktopDirectory, DEFAULT_PROFILE_FOLDER_NAME));
    candidates.push(path.join(desktopDirectory, LEGACY_PROFILE_FOLDER_NAME));
    candidates.push(path.join(homeDirectory, DEFAULT_PROFILE_FOLDER_NAME));
  }

  if (process.env.ProgramData) {
    candidates.push(path.join(process.env.ProgramData, DEFAULT_PROFILE_FOLDER_NAME));
  }

  return candidates;
}

function getDefaultProfileDataPath() {
  const candidates = getDefaultProfileRootCandidates();
  const existingWithConfig = candidates.find((candidate) => fsSync.existsSync(path.join(candidate, "lo-tool.config.json")));
  if (existingWithConfig) {
    return normalizeUserPath(existingWithConfig);
  }

  const existingFolder = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (existingFolder) {
    return normalizeUserPath(existingFolder);
  }

  return normalizeUserPath(candidates[0] ?? path.join(WORKSPACE_DATA_DIR, DEFAULT_PROFILE_FOLDER_NAME));
}

function readLinkedProfileRoot() {
  try {
    if (!fsSync.existsSync(PROFILE_LINK_PATH)) {
      return "";
    }

    const raw = fsSync.readFileSync(PROFILE_LINK_PATH, "utf8");
    const parsed = JSON.parse(raw) as ProfileDataLink;
    const linkedProfileRoot = parsed.profileRoot?.trim() ?? "";
    if (!linkedProfileRoot) {
      return "";
    }

    const normalizedPath = normalizeUserPath(linkedProfileRoot);
    return fsSync.existsSync(normalizedPath) ? normalizedPath : "";
  } catch {
    return "";
  }
}

export function getWorkspaceDataPath() {
  return toWindowsPath(WORKSPACE_DATA_DIR);
}

export function getProfileLinkPath() {
  return toWindowsPath(PROFILE_LINK_PATH);
}

export function getProfileDataPath() {
  const configuredProfileRoot = process.env[PROFILE_ROOT_ENV]?.trim() ?? "";
  if (configuredProfileRoot) {
    return normalizeUserPath(configuredProfileRoot);
  }

  const linkedProfileRoot = readLinkedProfileRoot();
  if (linkedProfileRoot) {
    return linkedProfileRoot;
  }

  return getDefaultProfileDataPath();
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function cloneConfig(config: AppConfig) {
  return JSON.parse(JSON.stringify(config)) as AppConfig;
}

async function buildFileCacheStamp(filePath: string) {
  try {
    const stats = await fs.stat(filePath);
    return {
      path: toWindowsPath(filePath),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return {
      path: toWindowsPath(filePath),
      mtimeMs: 0,
      size: -1,
    };
  }
}

async function buildConfigLoadCacheKey() {
  const profileDataPath = getProfileDataPath();
  return JSON.stringify({
    profileDataPath,
    config: await buildFileCacheStamp(path.join(profileDataPath, "lo-tool.config.json")),
    installContext: await buildFileCacheStamp(path.join(profileDataPath, "install-context.json")),
  });
}

async function rememberLoadedConfig(config: AppConfig) {
  loadedConfigCache = {
    key: await buildConfigLoadCacheKey(),
    config: cloneConfig(config),
  };
  return cloneConfig(config);
}

function dedupePaths(candidates: string[]) {
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const normalized = toWindowsPath(path.resolve(candidate));
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    resolved.push(normalized);
  }

  return resolved;
}

function parseSteamLibraryPaths(raw: string) {
  return [...raw.matchAll(/"path"\s+"((?:\\\\|[^"])*)"/g)]
    .map((match) => match[1]?.replace(/\\\\/g, "\\").trim() ?? "")
    .filter(Boolean);
}

function normalizeLaunchSteamDedicatedServerAppId(value: number | null | undefined) {
  if (!Number.isFinite(value) || value === null) {
    return LAST_OASIS_LAUNCH_APP_ID;
  }

  const normalizedValue = Math.trunc(Number(value));
  if (normalizedValue === LAST_OASIS_DEDICATED_SERVER_APP_ID) {
    return LAST_OASIS_LAUNCH_APP_ID;
  }

  return normalizedValue;
}

async function readSteamLibraryRoots(steamRoot: string) {
  const roots = [steamRoot];
  const libraryFoldersPath = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
  if (!(await exists(libraryFoldersPath))) {
    return dedupePaths(roots);
  }

  try {
    const raw = await fs.readFile(libraryFoldersPath, "utf8");
    roots.push(...parseSteamLibraryPaths(raw));
  } catch {
    return dedupePaths(roots);
  }

  return dedupePaths(roots);
}

async function discoverSteamLibraryRoots() {
  const steamRootCandidates = [
    process.env.LAST_OASIS_STEAM_ROOT,
    process.env.LAST_OASIS_STEAM_PATH ? path.dirname(process.env.LAST_OASIS_STEAM_PATH) : "",
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
    "C:\\SteamLibrary",
  ].filter((value): value is string => Boolean(value));

  const roots: string[] = [];
  for (const candidate of steamRootCandidates) {
    if (!(await exists(candidate))) {
      continue;
    }

    roots.push(...(await readSteamLibraryRoots(candidate)));
  }

  return dedupePaths(roots);
}

async function discoverInstallPathFromSteamLibraries(libraryRoots: string[], appNames: string[]) {
  for (const libraryRoot of libraryRoots) {
    for (const appName of appNames) {
      const candidate = path.join(libraryRoot, "steamapps", "common", appName);
      if (await exists(candidate)) {
        return toWindowsPath(candidate);
      }
    }
  }

  return "";
}

function buildDefaultLaunchSettings(identifier: string, basePort = 5555): LastOasisLaunchSettings {
  return {
    steamDedicatedServerAppId: LAST_OASIS_LAUNCH_APP_ID,
    identifier,
    customerKey: "",
    providerKey: "",
    slots: 10,
    port: basePort,
    queryPort: 27015 + Math.max(0, basePort - 5555),
    overrideConnectionAddress: "",
    backendApiUrl: "backend.last-oasis.com",
    enableLogs: true,
    forceSteamClientLink: false,
    messaging: true,
    noLiveServer: true,
    enableCheats: true,
    extraArgs: "-noupnp -noeac",
  };
}

function buildDefaultEventTileCycle(index = 0, input?: Partial<EventTileCycleState>): EventTileCycleState {
  const defaultName = index === 0 ? "Primary Event Cycle" : `Event Cycle ${index + 1}`;
  const cycle: EventTileCycleState = {
    id: input?.id?.trim() || `event-cycle-${index + 1}`,
    name: input?.name?.trim() || defaultName,
    enabled: input?.enabled ?? false,
    autoAdvance: input?.autoAdvance ?? true,
    cycleSize: input?.cycleSize ?? 4,
    previewHours: input?.previewHours ?? 12,
    activeHours: Math.max(2, input?.activeHours ?? 48),
    deleteGraceHours: Math.max(0, input?.deleteGraceHours ?? 8),
    eligibleTileIds: input?.eligibleTileIds ?? [],
    allowedMapIds: input?.allowedMapIds ?? [],
    phase: input?.phase ?? "idle",
    previewTileIds: input?.previewTileIds ?? [],
    previewTileNames: input?.previewTileNames ?? [],
    activeTileIds: input?.activeTileIds ?? [],
    activeTileNames: input?.activeTileNames ?? [],
    cleanupTileIds: input?.cleanupTileIds ?? [],
    cleanupTileNames: input?.cleanupTileNames ?? [],
    cleanupDeleteAfter: input?.cleanupDeleteAfter ?? null,
    cleanupBatches: input?.cleanupBatches ?? [],
    rotationCursor: input?.rotationCursor ?? 0,
    previewStartedAt: input?.previewStartedAt ?? null,
    activeStartedAt: input?.activeStartedAt ?? null,
    cleanupDeleteRequestedAt: input?.cleanupDeleteRequestedAt ?? null,
    nextTransitionAt: input?.nextTransitionAt ?? null,
    namePrefix: input?.namePrefix ?? "[EVENT]",
    spacingRadius: input?.spacingRadius ?? 4,
    qualityMode: input?.qualityMode ?? "fixed",
    quality: Math.min(4, Math.max(1, input?.quality ?? 4)),
    qualityMin: Math.min(4, Math.max(1, input?.qualityMin ?? 1)),
    qualityMax: Math.min(4, Math.max(1, input?.qualityMax ?? 4)),
    pvpMode: input?.pvpMode ?? "NoPvp",
    lastAction: input?.lastAction ?? "Event tile cycle is idle.",
  };
  if (cycle.qualityMin > cycle.qualityMax) {
    [cycle.qualityMin, cycle.qualityMax] = [cycle.qualityMax, cycle.qualityMin];
  }
  return cycle;
}

function normalizeEventTileCycle(input: unknown, index: number): EventTileCycleState {
  const maybeCycle = typeof input === "object" && input !== null ? (input as Partial<EventTileCycleState>) : {};
  return buildDefaultEventTileCycle(index, {
    id: maybeCycle.id,
    name: maybeCycle.name,
    enabled: maybeCycle.enabled,
    autoAdvance: maybeCycle.autoAdvance,
    cycleSize: maybeCycle.cycleSize,
    previewHours: maybeCycle.previewHours,
    activeHours: maybeCycle.activeHours,
    deleteGraceHours: maybeCycle.deleteGraceHours,
    eligibleTileIds: maybeCycle.eligibleTileIds,
    allowedMapIds: maybeCycle.allowedMapIds,
    phase: maybeCycle.phase,
    previewTileIds: maybeCycle.previewTileIds,
    previewTileNames: maybeCycle.previewTileNames,
    activeTileIds: maybeCycle.activeTileIds,
    activeTileNames: maybeCycle.activeTileNames,
    cleanupTileIds: maybeCycle.cleanupTileIds,
    cleanupTileNames: maybeCycle.cleanupTileNames,
    cleanupDeleteAfter: maybeCycle.cleanupDeleteAfter,
    cleanupBatches: maybeCycle.cleanupBatches,
    rotationCursor: maybeCycle.rotationCursor,
    previewStartedAt: maybeCycle.previewStartedAt,
    activeStartedAt: maybeCycle.activeStartedAt,
    cleanupDeleteRequestedAt: maybeCycle.cleanupDeleteRequestedAt,
    nextTransitionAt: maybeCycle.nextTransitionAt,
    namePrefix: maybeCycle.namePrefix,
    spacingRadius: maybeCycle.spacingRadius,
    qualityMode: maybeCycle.qualityMode,
    quality: maybeCycle.quality,
    qualityMin: maybeCycle.qualityMin,
    qualityMax: maybeCycle.qualityMax,
    pvpMode: maybeCycle.pvpMode,
    lastAction: maybeCycle.lastAction,
  });
}

async function discoverSteamCmdPath(installPath: string) {
  const driveRoot = installPath ? path.parse(installPath).root : "C:\\";
  const candidates = [
    process.env.STEAMCMD_PATH,
    installPath ? path.join(installPath, "steamcmd", "steamcmd.exe") : "",
    installPath ? path.join(installPath, "tools", "steamcmd", "steamcmd.exe") : "",
    path.join(driveRoot, "SteamCMD", "steamcmd.exe"),
    path.join(driveRoot, "steamcmd", "steamcmd.exe"),
    "C:\\SteamCMD\\steamcmd.exe",
    "C:\\steamcmd\\steamcmd.exe",
    "C:\\Program Files (x86)\\Steam\\steamcmd.exe",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return toWindowsPath(candidate);
    }
  }

  return "";
}

function hydrateProfile(profile: Omit<LaunchProfile, "generatedArguments" | "validationIssues">): LaunchProfile {
  const generatedArguments = buildLastOasisArguments(profile.launch);
  const validationIssues = validateLastOasisSettings(profile.launch);
  return {
    ...profile,
    generatedArguments,
    validationIssues,
  };
}

function shouldUseDiscoveredExecutable(executablePath: string, paths: DiscoveredPaths) {
  if (!executablePath) {
    return true;
  }

  const normalizedExecutable = executablePath.toLowerCase();
  const discoveredExecutable = paths.executablePath.toLowerCase();
  const legacyRootExecutable = path.join(paths.installPath, "MistServer.exe").toLowerCase();

  return normalizedExecutable === discoveredExecutable || normalizedExecutable === legacyRootExecutable;
}

function rewritePathToDiscoveredInstall(targetPath: string, discoveredPaths: DiscoveredPaths, previousInstallPath?: string) {
  if (!targetPath) {
    return targetPath;
  }

  const normalizedTarget = toWindowsPath(targetPath);
  const normalizedPreviousInstallPath = previousInstallPath ? toWindowsPath(previousInstallPath) : "";
  const normalizedDiscoveredInstallPath = toWindowsPath(discoveredPaths.installPath);

  if (
    normalizedPreviousInstallPath &&
    normalizedDiscoveredInstallPath &&
    normalizedTarget.toLowerCase().startsWith(normalizedPreviousInstallPath.toLowerCase()) &&
    normalizedPreviousInstallPath.toLowerCase() !== normalizedDiscoveredInstallPath.toLowerCase()
  ) {
    const suffix = normalizedTarget.slice(normalizedPreviousInstallPath.length).replace(/^\\+/, "");
    return suffix ? `${normalizedDiscoveredInstallPath}\\${suffix}` : normalizedDiscoveredInstallPath;
  }

  return normalizedTarget;
}

function getMistSavedRelativePath(targetPath: string) {
  const normalizedTarget = toWindowsPath(targetPath);
  const marker = "\\Mist\\Saved";
  const markerIndex = normalizedTarget.toLowerCase().indexOf(marker.toLowerCase());
  if (markerIndex < 0) {
    return null;
  }

  return normalizedTarget.slice(markerIndex + marker.length).replace(/^\\+/, "");
}

function isClientMistSavedPath(targetPath: string) {
  return toWindowsPath(targetPath).toLowerCase().includes("\\appdata\\local\\mist\\saved");
}

function normalizeSavedDataPath(
  targetPath: string | undefined,
  fallbackPath: string,
  discoveredPaths: DiscoveredPaths,
  previousInstallPath?: string,
) {
  const migratedPath = rewritePathToDiscoveredInstall(targetPath ?? "", discoveredPaths, previousInstallPath);
  if (!migratedPath) {
    return fallbackPath;
  }

  if (isClientMistSavedPath(migratedPath)) {
    const relativePath = getMistSavedRelativePath(migratedPath);
    return relativePath ? toWindowsPath(path.join(discoveredPaths.localDataPath, relativePath)) : fallbackPath;
  }

  return migratedPath;
}

function normalizeProfileWorkingDirectory(executablePath: string, fallbackWorkingDirectory: string) {
  const normalizedExecutablePath = executablePath ? toWindowsPath(executablePath) : "";
  if (normalizedExecutablePath && /\.exe$/i.test(path.basename(normalizedExecutablePath))) {
    return toWindowsPath(path.dirname(normalizedExecutablePath));
  }

  return toWindowsPath(fallbackWorkingDirectory);
}

function normalizeProfile(input: unknown, paths: DiscoveredPaths, realmSettings: RealmSettings, index: number): LaunchProfile {
  const nextIdentifier = `realm_server_${index + 1}`;
  const defaultBase = {
    id: `realm-profile-${index + 1}`,
    name: index === 0 ? "Primary Realm" : `Realm ${index + 1}`,
    executablePath: paths.executablePath,
    workingDirectory: paths.workingDirectory,
    notes: "Structured Last Oasis launch profile.",
    launch: buildDefaultLaunchSettings(nextIdentifier, 5555 + index),
    restartPolicy: {
      enabled: false,
      scheduleMode: "fixed-times" as const,
      fixedTimes: ["00:00", "12:00"],
      intervalHours: 12,
      gracefulWarningMinutes: 30,
      skipNextScheduledRestartAt: null,
      coveredScheduledRestartAt: null,
    },
  };

  const modern = launchProfileSchema.safeParse(input);
  if (modern.success) {
    const preferredExecutablePath = shouldUseDiscoveredExecutable(modern.data.executablePath, paths) ? paths.executablePath : modern.data.executablePath;
    const normalizedExecutablePath = preferredExecutablePath || paths.executablePath;
    return hydrateProfile({
      ...defaultBase,
      ...modern.data,
      launch: {
        ...defaultBase.launch,
        ...modern.data.launch,
        steamDedicatedServerAppId: normalizeLaunchSteamDedicatedServerAppId(
          modern.data.launch.steamDedicatedServerAppId ?? defaultBase.launch.steamDedicatedServerAppId,
        ),
        customerKey: modern.data.launch.customerKey || realmSettings.customerKey,
        providerKey: modern.data.launch.providerKey || realmSettings.providerKey,
        forceSteamClientLink: false,
        noLiveServer: true,
      },
      restartPolicy: {
        ...defaultBase.restartPolicy,
        ...modern.data.restartPolicy,
      },
      executablePath: normalizedExecutablePath,
      workingDirectory: normalizeProfileWorkingDirectory(
        normalizedExecutablePath,
        modern.data.workingDirectory || paths.workingDirectory,
      ),
    });
  }

  const legacy = legacyLaunchProfileSchema.safeParse(input);
  if (legacy.success) {
    const preferredExecutablePath = shouldUseDiscoveredExecutable(legacy.data.executablePath, paths) ? paths.executablePath : legacy.data.executablePath;
    const normalizedExecutablePath = preferredExecutablePath || paths.executablePath;
    return hydrateProfile({
      ...defaultBase,
      id: legacy.data.id,
      name: legacy.data.name,
      executablePath: normalizedExecutablePath,
      workingDirectory: normalizeProfileWorkingDirectory(
        normalizedExecutablePath,
        legacy.data.workingDirectory || paths.workingDirectory,
      ),
      notes: legacy.data.notes,
      launch: {
        ...defaultBase.launch,
        steamDedicatedServerAppId: defaultBase.launch.steamDedicatedServerAppId,
        customerKey: realmSettings.customerKey,
        providerKey: realmSettings.providerKey,
        extraArgs: legacy.data.arguments,
        forceSteamClientLink: false,
        noLiveServer: true,
      },
    });
  }

  return hydrateProfile(defaultBase);
}

function normalizeConfig(input: unknown, discoveredPaths: DiscoveredPaths): AppConfig {
  const maybeConfig = typeof input === "object" && input !== null ? (input as Partial<AppConfig> & { profiles?: unknown[]; paths?: Partial<DiscoveredPaths> }) : {};
  const migratedInstallPath = rewritePathToDiscoveredInstall(
    maybeConfig.paths?.installPath ?? "",
    discoveredPaths,
    maybeConfig.paths?.installPath,
  ) || discoveredPaths.installPath;

  const realmSettings: RealmSettings = {
    customerKey: maybeConfig.realmSettings?.customerKey ?? "",
    providerKey: maybeConfig.realmSettings?.providerKey ?? "",
    providerName: maybeConfig.realmSettings?.providerName ?? "",
    apiKey: maybeConfig.realmSettings?.apiKey ?? "",
  };
  const myRealmFlow: MyRealmFlowSummary | null =
    maybeConfig.myRealmFlow && typeof maybeConfig.myRealmFlow === "object"
      ? {
          browser: maybeConfig.myRealmFlow.browser ?? null,
          customerId: maybeConfig.myRealmFlow.customerId ?? null,
          realmId: maybeConfig.myRealmFlow.realmId ?? null,
          dashboardUrl: maybeConfig.myRealmFlow.dashboardUrl ?? null,
          realmUrl: maybeConfig.myRealmFlow.realmUrl ?? null,
          mapUrl: maybeConfig.myRealmFlow.mapUrl ?? null,
          serversUrl: maybeConfig.myRealmFlow.serversUrl ?? null,
          providersUrl: maybeConfig.myRealmFlow.providersUrl ?? null,
          usersUrl: maybeConfig.myRealmFlow.usersUrl ?? null,
          apiUrl: maybeConfig.myRealmFlow.apiUrl ?? null,
          recentTileUrls: Array.isArray(maybeConfig.myRealmFlow.recentTileUrls) ? maybeConfig.myRealmFlow.recentTileUrls : [],
          note: maybeConfig.myRealmFlow.note ?? "",
        }
      : null;

  const gameBridgeInboxRootPath = normalizeGameBridgeInboxRootPath(
    maybeConfig.operationsSettings?.gameBridgeInboxRootPath || maybeConfig.operationsSettings?.gameBridgeCommandFilePath,
    discoveredPaths,
  );
  const operationsSettings: OperationsSettings = {
    steamCmdPath: rewritePathToDiscoveredInstall(
      maybeConfig.operationsSettings?.steamCmdPath ?? "",
      discoveredPaths,
      maybeConfig.paths?.installPath,
    ),
    steamCmdInstallDirectory: rewritePathToDiscoveredInstall(
      maybeConfig.operationsSettings?.steamCmdInstallDirectory ?? "",
      discoveredPaths,
      maybeConfig.paths?.installPath,
    ),
    workshopContentPath: maybeConfig.operationsSettings?.workshopContentPath ?? "",
    modIds: maybeConfig.operationsSettings?.modIds ?? [],
    betaBranch: maybeConfig.operationsSettings?.betaBranch === "sdktest" ? "" : maybeConfig.operationsSettings?.betaBranch ?? "",
    appId: maybeConfig.operationsSettings?.appId ?? LAST_OASIS_DEDICATED_SERVER_APP_ID,
    lastKnownPublicIp: maybeConfig.operationsSettings?.lastKnownPublicIp ?? "",
    modSyncDeletesMissing: maybeConfig.operationsSettings?.modSyncDeletesMissing ?? true,
    autoUpdateMods: maybeConfig.operationsSettings?.autoUpdateMods ?? false,
    autoUpdateGameServer:
      maybeConfig.operationsSettings?.autoUpdateGameServer ??
      maybeConfig.operationsSettings?.autoUpdateMods ??
      false,
    modUpdateCheckMinutes: maybeConfig.operationsSettings?.modUpdateCheckMinutes ?? 15,
    gameUpdateCheckMinutes:
      maybeConfig.operationsSettings?.gameUpdateCheckMinutes ??
      maybeConfig.operationsSettings?.modUpdateCheckMinutes ??
      15,
    modUpdateGraceMinutes: Math.max(15, maybeConfig.operationsSettings?.modUpdateGraceMinutes ?? 15),
    discordMyRealmWebhookUrl:
      maybeConfig.operationsSettings?.discordMyRealmWebhookUrl ??
      maybeConfig.operationsSettings?.discordTileOnlineWebhookUrl ??
      maybeConfig.operationsSettings?.discordPlayerCounterWebhookUrl ??
      "",
    discordPlayerCounterWebhookUrl: maybeConfig.operationsSettings?.discordPlayerCounterWebhookUrl ?? "",
    discordTileOnlineWebhookUrl: maybeConfig.operationsSettings?.discordTileOnlineWebhookUrl ?? "",
    discordUpdateWebhookUrl: maybeConfig.operationsSettings?.discordUpdateWebhookUrl ?? "",
    discordEventTileWebhookUrl: maybeConfig.operationsSettings?.discordEventTileWebhookUrl ?? "",
    discordGameChatWebhookUrl: maybeConfig.operationsSettings?.discordGameChatWebhookUrl ?? "",
    discordBotEnabled: maybeConfig.operationsSettings?.discordBotEnabled ?? false,
    discordBotToken: maybeConfig.operationsSettings?.discordBotToken ?? "",
    discordBotChannelId: maybeConfig.operationsSettings?.discordBotChannelId ?? "",
    discordMaintenanceRoleId: maybeConfig.operationsSettings?.discordMaintenanceRoleId ?? "",
    gameBridgeModMessagesEnabled: maybeConfig.operationsSettings?.gameBridgeModMessagesEnabled ?? true,
    gameBridgeInboxRootPath,
    gameBridgeCommandFilePath: normalizeGameBridgeCommandFilePath(
      maybeConfig.operationsSettings?.gameBridgeCommandFilePath || path.join(gameBridgeInboxRootPath, "Admin.json"),
      discoveredPaths,
    ),
    autoRestartOfflineRealms: maybeConfig.operationsSettings?.autoRestartOfflineRealms ?? true,
    offlineRestartGraceMinutes: maybeConfig.operationsSettings?.offlineRestartGraceMinutes ?? 1,
  };

  const cycleInputs = Array.isArray((maybeConfig as { eventTileCycles?: unknown[] }).eventTileCycles)
    ? (maybeConfig as { eventTileCycles?: unknown[] }).eventTileCycles ?? []
    : [];
  const normalizedCyclesSource = cycleInputs.length ? cycleInputs : [maybeConfig.eventTileCycle];
  let eventTileCycles = normalizedCyclesSource.map((cycle, index) => normalizeEventTileCycle(cycle, index));
  const selectedEventTileCycleIdCandidate =
    typeof maybeConfig.selectedEventTileCycleId === "string" && maybeConfig.selectedEventTileCycleId.trim()
      ? maybeConfig.selectedEventTileCycleId.trim()
      : eventTileCycles[0]?.id ?? null;
  let selectedEventTileCycleId =
    selectedEventTileCycleIdCandidate && eventTileCycles.some((cycle) => cycle.id === selectedEventTileCycleIdCandidate)
      ? selectedEventTileCycleIdCandidate
      : eventTileCycles[0]?.id ?? null;

  if (!cycleInputs.length && maybeConfig.eventTileCycle && selectedEventTileCycleId) {
    eventTileCycles = eventTileCycles.map((cycle, index) =>
      cycle.id === selectedEventTileCycleId
        ? normalizeEventTileCycle(
            {
              ...cycle,
              ...maybeConfig.eventTileCycle,
              id: cycle.id,
              name: maybeConfig.eventTileCycle?.name || cycle.name,
            },
            index,
          )
        : cycle,
    );
  }

  const dedupedEventTileCycles = new Map<string, EventTileCycleState>();
  for (let index = eventTileCycles.length - 1; index >= 0; index -= 1) {
    const cycle = eventTileCycles[index];
    if (!dedupedEventTileCycles.has(cycle.id)) {
      dedupedEventTileCycles.set(cycle.id, cycle);
    }
  }
  eventTileCycles = [...dedupedEventTileCycles.values()].reverse();

  if (!eventTileCycles.length) {
    eventTileCycles = [buildDefaultEventTileCycle(0)];
    selectedEventTileCycleId = eventTileCycles[0].id;
  }

  const eventTileCycle =
    eventTileCycles.find((cycle) => cycle.id === selectedEventTileCycleId) ??
    eventTileCycles[0] ??
    buildDefaultEventTileCycle(0);

  const profiles = (
    Array.isArray(maybeConfig.profiles)
      ? maybeConfig.profiles.map((profile, index) => normalizeProfile(profile, discoveredPaths, realmSettings, index))
      : [normalizeProfile(undefined, discoveredPaths, realmSettings, 0)]
  ).map((profile) =>
    {
      const normalizedExecutablePath = shouldUseDiscoveredExecutable(profile.executablePath, discoveredPaths)
        ? discoveredPaths.executablePath
        : rewritePathToDiscoveredInstall(profile.executablePath, discoveredPaths, maybeConfig.paths?.installPath) || discoveredPaths.executablePath;
      const requestedWorkingDirectory =
        rewritePathToDiscoveredInstall(profile.workingDirectory, discoveredPaths, maybeConfig.paths?.installPath) || discoveredPaths.workingDirectory;

      return hydrateProfile({
        ...profile,
        executablePath: normalizedExecutablePath,
        workingDirectory: normalizeProfileWorkingDirectory(normalizedExecutablePath, requestedWorkingDirectory),
      });
    },
  );

  const selectedProfileId =
    typeof maybeConfig.selectedProfileId === "string" && profiles.some((profile) => profile.id === maybeConfig.selectedProfileId)
      ? maybeConfig.selectedProfileId
      : profiles[0]?.id ?? null;
  const normalizedLocalDataPath = normalizeSavedDataPath(
    maybeConfig.paths?.localDataPath,
    discoveredPaths.localDataPath,
    discoveredPaths,
    maybeConfig.paths?.installPath,
  );
  const normalizedLogsPath = normalizeSavedDataPath(
    maybeConfig.paths?.logsPath,
    discoveredPaths.logsPath,
    discoveredPaths,
    maybeConfig.paths?.installPath,
  );
  const normalizedAdminDataPath = normalizeSavedDataPath(
    maybeConfig.paths?.adminDataPath,
    discoveredPaths.adminDataPath,
    discoveredPaths,
    maybeConfig.paths?.installPath,
  );
  const normalizedServerConfigPath = normalizeSavedDataPath(
    maybeConfig.paths?.serverConfigPath,
    discoveredPaths.serverConfigPath,
    discoveredPaths,
    maybeConfig.paths?.installPath,
  );

  return {
    selectedProfileId,
    selectedEventTileCycleId: eventTileCycle.id,
    paths: {
      installPath: migratedInstallPath,
      executablePath: shouldUseDiscoveredExecutable(maybeConfig.paths?.executablePath ?? "", discoveredPaths)
        ? discoveredPaths.executablePath
        : rewritePathToDiscoveredInstall(
            maybeConfig.paths?.executablePath || discoveredPaths.executablePath,
            discoveredPaths,
            maybeConfig.paths?.installPath,
          ) || discoveredPaths.executablePath,
      workingDirectory: normalizeProfileWorkingDirectory(
        shouldUseDiscoveredExecutable(maybeConfig.paths?.executablePath ?? "", discoveredPaths)
          ? discoveredPaths.executablePath
          : rewritePathToDiscoveredInstall(
              maybeConfig.paths?.executablePath || discoveredPaths.executablePath,
              discoveredPaths,
              maybeConfig.paths?.installPath,
            ) || discoveredPaths.executablePath,
        rewritePathToDiscoveredInstall(
          maybeConfig.paths?.workingDirectory || discoveredPaths.workingDirectory,
          discoveredPaths,
          maybeConfig.paths?.installPath,
        ) || discoveredPaths.workingDirectory,
      ),
      localDataPath: normalizedLocalDataPath,
      logsPath: normalizedLogsPath,
      adminDataPath: normalizedAdminDataPath,
      serverConfigPath: normalizedServerConfigPath,
      persistedConfigPath: discoveredPaths.persistedConfigPath,
      backupsPath: discoveredPaths.backupsPath,
    },
    realmSettings,
    myRealmFlow,
    operationsSettings,
    eventTileCycle,
    eventTileCycles,
    profiles,
  };
}

export function getPersistedConfigPath() {
  return toWindowsPath(path.join(getProfileDataPath(), "lo-tool.config.json"));
}

export function getBackupsPath() {
  return toWindowsPath(path.join(getProfileDataPath(), "backups"));
}

export function getEventCycleSnapshotsPath() {
  return toWindowsPath(path.join(getProfileDataPath(), "event-cycles"));
}

export function getInstallContextPath() {
  return toWindowsPath(path.join(getProfileDataPath(), "install-context.json"));
}

function inferInstallPathFromExecutablePath(executablePath: string) {
  const normalizedExecutablePath = executablePath.trim();
  if (!normalizedExecutablePath) {
    return "";
  }

  const executableDirectory = path.dirname(normalizedExecutablePath);
  const executableDirectorySuffix = path.normalize(path.join("Mist", "Binaries", "Win64")).toLowerCase();
  if (path.normalize(executableDirectory).toLowerCase().endsWith(executableDirectorySuffix)) {
    return toWindowsPath(path.resolve(executableDirectory, "..", "..", ".."));
  }

  return toWindowsPath(path.dirname(normalizedExecutablePath));
}

function getDefaultGameBridgeCommandFilePath(discoveredPaths: DiscoveredPaths) {
  return toWindowsPath(path.join(getDefaultGameBridgeInboxRootPath(discoveredPaths), "Admin.json"));
}

function getDefaultGameBridgeInboxRootPath(discoveredPaths: DiscoveredPaths) {
  return toWindowsPath(DEFAULT_GAME_BRIDGE_INBOX_ROOT_PATH);
}

function normalizeGameBridgeInboxRootPath(value: string | null | undefined, discoveredPaths: DiscoveredPaths) {
  const configuredValue = value?.trim() ?? "";
  const rawValue = configuredValue || getDefaultGameBridgeInboxRootPath(discoveredPaths);
  if (!rawValue) {
    return "";
  }

  const rootPath = path.basename(rawValue).toLowerCase().endsWith(".json")
    ? path.dirname(rawValue)
    : rawValue;
  return toWindowsPath(path.resolve(rootPath));
}

function normalizeGameBridgeCommandFilePath(value: string | null | undefined, discoveredPaths: DiscoveredPaths) {
  const configuredValue = value?.trim() ?? "";
  const oldInstallDerivedDefault = discoveredPaths.installPath
    ? toWindowsPath(path.join(discoveredPaths.installPath, "Mist", "Content", "LOManagerBridge", "Inbox", "Admin.json"))
    : "";
  const isOldInstallDerivedDefault =
    Boolean(configuredValue && oldInstallDerivedDefault) &&
    toWindowsPath(path.resolve(configuredValue)).toLowerCase() ===
      toWindowsPath(path.resolve(oldInstallDerivedDefault)).toLowerCase();
  const rawValue =
    configuredValue && !isOldInstallDerivedDefault
      ? configuredValue
      : getDefaultGameBridgeCommandFilePath(discoveredPaths);
  if (!rawValue) {
    return "";
  }

  const filePath = path.basename(rawValue).toLowerCase().endsWith(".json")
    ? rawValue
    : path.join(rawValue, "Admin.json");
  return toWindowsPath(path.resolve(filePath));
}

async function readPersistedServerPathCandidate() {
  try {
    const persistedConfigPath = getPersistedConfigPath();
    if (!(await exists(persistedConfigPath))) {
      return "";
    }

    const parsed = JSON.parse(await fs.readFile(persistedConfigPath, "utf8")) as Partial<AppConfig>;
    const selectedProfile =
      parsed.profiles?.find((profile) => profile.id === parsed.selectedProfileId) ??
      parsed.profiles?.[0] ??
      null;
    const profileInstallPath = selectedProfile?.executablePath
      ? inferInstallPathFromExecutablePath(selectedProfile.executablePath)
      : "";
    return profileInstallPath || parsed.paths?.installPath?.trim() || "";
  } catch {
    return "";
  }
}

export async function discoverPaths(): Promise<DiscoveredPaths> {
  let installContextServerPath = "";
  try {
    const installContextPath = getInstallContextPath();
    if (await exists(installContextPath)) {
      const installContext = JSON.parse(await fs.readFile(installContextPath, "utf8")) as { serverPath?: string };
      if (typeof installContext.serverPath === "string" && installContext.serverPath.trim()) {
        installContextServerPath = installContext.serverPath.trim();
      }
    }
  } catch {
    installContextServerPath = "";
  }

  const persistedServerPath = await readPersistedServerPathCandidate();
  const linkedInstallCandidates = installContextServerPath
    ? [installContextServerPath]
    : process.env.LAST_OASIS_SERVER_PATH
      ? [process.env.LAST_OASIS_SERVER_PATH]
      : persistedServerPath
        ? [persistedServerPath]
        : [];

  const libraryInstallPath = linkedInstallCandidates.length
    ? ""
    : await discoverInstallPathFromSteamLibraries(await discoverSteamLibraryRoots(), [
        "Last Oasis - Dedicated Server",
        "LastOasis-DedicatedServer",
      ]);
  const autoDetectInstallCandidates = [
    libraryInstallPath,
    "C:\\SteamLibrary\\steamapps\\common\\LastOasis-DedicatedServer",
    "C:\\SteamLibrary\\steamapps\\common\\Last Oasis - Dedicated Server",
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\LastOasis-DedicatedServer",
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Last Oasis - Dedicated Server",
  ].filter((value): value is string => Boolean(value));
  const installCandidates = linkedInstallCandidates.length ? linkedInstallCandidates : autoDetectInstallCandidates;

  let installPath = installCandidates[0] ?? "";
  for (const candidate of installCandidates) {
    if (await exists(candidate)) {
      installPath = candidate;
      break;
    }
  }

  const rootExecutable = installPath ? path.join(installPath, "MistServer.exe") : "";
  const shippingExecutable = installPath
    ? path.join(installPath, "Mist", "Binaries", "Win64", "MistServer-Win64-Shipping.exe")
    : "";

  const executablePath = (await exists(shippingExecutable))
    ? shippingExecutable
    : (await exists(rootExecutable))
      ? rootExecutable
      : shippingExecutable;
  const workingDirectory = executablePath ? path.dirname(executablePath) : installPath;

  const serverSavedPath = installPath ? path.join(installPath, "Mist", "Saved") : "";
  const clientSavedPath = path.join(os.homedir(), "AppData", "Local", "Mist", "Saved");
  const localDataPath = serverSavedPath || clientSavedPath;

  return {
    installPath: toWindowsPath(installPath),
    executablePath: toWindowsPath(executablePath),
    workingDirectory: toWindowsPath(workingDirectory),
    localDataPath: toWindowsPath(localDataPath),
    logsPath: toWindowsPath(path.join(localDataPath, "Logs")),
    adminDataPath: toWindowsPath(path.join(localDataPath, "AdminData.json")),
    serverConfigPath: toWindowsPath(path.join(localDataPath, "Config", "WindowsServer")),
    persistedConfigPath: getPersistedConfigPath(),
    backupsPath: getBackupsPath(),
  };
}

function createDefaultProfile(paths: DiscoveredPaths): LaunchProfile {
  return hydrateProfile({
    id: "primary-realm",
    name: "Primary Realm",
    executablePath: paths.executablePath,
    workingDirectory: paths.workingDirectory,
    notes:
      "Use the fields below with the values from MyRealm. The generated launch string follows the official self-hosting format shared by Last Oasis.",
    launch: buildDefaultLaunchSettings("realm_server_1", 5555),
    restartPolicy: {
      enabled: false,
      scheduleMode: "fixed-times" as const,
      fixedTimes: ["00:00", "12:00"],
      intervalHours: 12,
      gracefulWarningMinutes: 30,
      skipNextScheduledRestartAt: null,
      coveredScheduledRestartAt: null,
    },
  });
}

export function buildDefaultConfig(paths: DiscoveredPaths): AppConfig {
  const profile = createDefaultProfile(paths);
  return {
    selectedProfileId: profile.id,
    selectedEventTileCycleId: "event-cycle-1",
    paths,
    realmSettings: {
      customerKey: "",
      providerKey: "",
      providerName: "",
      apiKey: "",
    },
    myRealmFlow: null,
    operationsSettings: {
      steamCmdPath: "",
      steamCmdInstallDirectory: "",
      workshopContentPath: "",
      modIds: [],
      betaBranch: "",
      appId: LAST_OASIS_DEDICATED_SERVER_APP_ID,
      lastKnownPublicIp: "",
      modSyncDeletesMissing: true,
      autoUpdateMods: false,
      autoUpdateGameServer: false,
      modUpdateCheckMinutes: 15,
      gameUpdateCheckMinutes: 15,
      modUpdateGraceMinutes: 15,
      discordMyRealmWebhookUrl: "",
      discordPlayerCounterWebhookUrl: "",
      discordTileOnlineWebhookUrl: "",
      discordUpdateWebhookUrl: "",
      discordEventTileWebhookUrl: "",
      discordGameChatWebhookUrl: "",
      discordBotEnabled: false,
      discordBotToken: "",
      discordBotChannelId: "",
      discordMaintenanceRoleId: "",
      gameBridgeModMessagesEnabled: true,
      gameBridgeInboxRootPath: getDefaultGameBridgeInboxRootPath(paths),
      gameBridgeCommandFilePath: getDefaultGameBridgeCommandFilePath(paths),
      autoRestartOfflineRealms: true,
      offlineRestartGraceMinutes: 1,
    },
    eventTileCycle: buildDefaultEventTileCycle(0),
    eventTileCycles: [buildDefaultEventTileCycle(0)],
    profiles: [profile],
  };
}

function extractFirstJsonObject(raw: string) {
  const start = raw.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (character === "\\") {
        escaping = true;
        continue;
      }

      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return raw.slice(start, index + 1);
    }
  }

  return null;
}

function parsePersistedConfigJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const repaired = extractFirstJsonObject(raw);
    if (!repaired) {
      throw error;
    }

    return JSON.parse(repaired);
  }
}

async function writeConfigAtomically(filePath: string, payload: unknown) {
  const serialized = JSON.stringify(payload, null, 2);
  const directoryPath = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const tempPath = path.join(directoryPath, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(tempPath, serialized, "utf8");

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
    if (code !== "EEXIST" && code !== "EPERM") {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }

    await fs.rm(filePath, { force: true }).catch(() => undefined);
    await fs.rename(tempPath, filePath);
  }
}

export async function loadConfig() {
  const cacheKey = await buildConfigLoadCacheKey();
  if (loadedConfigCache?.key === cacheKey) {
    return cloneConfig(loadedConfigCache.config);
  }

  const discoveredPaths = await discoverPaths();
  const persistedConfigPath = getPersistedConfigPath();
  const profileDataPath = getProfileDataPath();
  const defaultWorkshopContentPath = discoveredPaths.installPath
    ? toWindowsPath(path.resolve(discoveredPaths.installPath, "..", "..", "workshop", "content", "903950"))
    : "";
  const defaultSteamCmdPath = await discoverSteamCmdPath(discoveredPaths.installPath);
  const defaultSteamCmdInstallDirectory = defaultSteamCmdPath ? toWindowsPath(path.dirname(defaultSteamCmdPath)) : discoveredPaths.installPath
    ? toWindowsPath(path.join(discoveredPaths.installPath, "tools", "steamcmd"))
    : "";
  await fs.mkdir(profileDataPath, { recursive: true });
  await fs.mkdir(getBackupsPath(), { recursive: true });

  if (!(await exists(persistedConfigPath))) {
    const config = buildDefaultConfig(discoveredPaths);
    await writeConfigAtomically(persistedConfigPath, config);
    return rememberLoadedConfig(config);
  }

  const raw = await fs.readFile(persistedConfigPath, "utf8");
  if (!raw.trim()) {
    const config = buildDefaultConfig(discoveredPaths);
    await writeConfigAtomically(persistedConfigPath, config);
    return rememberLoadedConfig(config);
  }
  const parsedRaw = parsePersistedConfigJson(raw);
  const hasExplicitModIds =
    typeof parsedRaw === "object" &&
    parsedRaw !== null &&
    "operationsSettings" in parsedRaw &&
    typeof (parsedRaw as { operationsSettings?: unknown }).operationsSettings === "object" &&
    (parsedRaw as { operationsSettings?: { modIds?: unknown } }).operationsSettings !== null &&
    Array.isArray((parsedRaw as { operationsSettings?: { modIds?: unknown } }).operationsSettings?.modIds);
  const normalized = normalizeConfig(parsedRaw, discoveredPaths);
  normalized.operationsSettings = {
    ...normalized.operationsSettings,
    steamCmdPath: normalized.operationsSettings.steamCmdPath || defaultSteamCmdPath,
    steamCmdInstallDirectory: normalized.operationsSettings.steamCmdInstallDirectory || defaultSteamCmdInstallDirectory,
    workshopContentPath: normalized.operationsSettings.workshopContentPath || defaultWorkshopContentPath,
    modIds: hasExplicitModIds ? normalized.operationsSettings.modIds : [],
  };
  const validated = appConfigSchema.parse(normalized);
  return rememberLoadedConfig(validated);
}

export async function saveConfig(input: AppConfig) {
  const runSave = async () => {
    const discoveredPaths = await discoverPaths();
    const normalized = normalizeConfig(input, discoveredPaths);
    const config = appConfigSchema.parse(normalized);
    const persistedConfigPath = getPersistedConfigPath();
    await fs.mkdir(getProfileDataPath(), { recursive: true });
    await fs.mkdir(getBackupsPath(), { recursive: true });
    await fs.mkdir(getEventCycleSnapshotsPath(), { recursive: true });
    await writeConfigAtomically(persistedConfigPath, config);
    await writeEventCycleSnapshots(config);
    loadedConfigCache = {
      key: await buildConfigLoadCacheKey(),
      config: cloneConfig(config),
    };
    return config;
  };

  const savePromise = configSaveQueue.then(runSave, runSave);
  configSaveQueue = savePromise.then(() => undefined, () => undefined);
  return savePromise;
}

function sanitizeEventCycleSnapshotStem(value: string) {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned || "Event Cycle";
}

function buildEventCycleSnapshotFileNames(cycles: EventTileCycleState[]) {
  const usedNames = new Set<string>();
  const fileNames = new Map<string, string>();

  for (const cycle of cycles) {
    const baseName = sanitizeEventCycleSnapshotStem(cycle.name);
    let candidateName = `${baseName}.json`;
    let suffix = 2;

    while (usedNames.has(candidateName.toLowerCase())) {
      candidateName = `${baseName} (${suffix}).json`;
      suffix += 1;
    }

    usedNames.add(candidateName.toLowerCase());
    fileNames.set(cycle.id, candidateName);
  }

  return fileNames;
}

async function writeEventCycleSnapshots(config: AppConfig) {
  const snapshotsPath = getEventCycleSnapshotsPath();
  await fs.mkdir(snapshotsPath, { recursive: true });
  const snapshotFileNames = buildEventCycleSnapshotFileNames(config.eventTileCycles);

  const existingEntries = await fs.readdir(snapshotsPath, { withFileTypes: true }).catch(() => []);
  const expectedFiles = new Set([
    "index.json",
    ...Array.from(snapshotFileNames.values()),
  ]);

  await Promise.all(
    existingEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !expectedFiles.has(entry.name))
      .map((entry) => fs.rm(path.join(snapshotsPath, entry.name), { force: true })),
  );

  const selectedCycle =
    config.eventTileCycles.find((cycle) => cycle.id === config.selectedEventTileCycleId) ??
    config.eventTileCycles[0] ??
    config.eventTileCycle;
  const exportedAt = new Date().toISOString();

  await writeConfigAtomically(
    path.join(snapshotsPath, "index.json"),
    {
      exportedAt,
      selectedEventTileCycleId: selectedCycle.id,
      selectedEventTileCycleName: selectedCycle.name,
      cycles: config.eventTileCycles.map((cycle) => ({
        id: cycle.id,
        name: cycle.name,
        fileName: snapshotFileNames.get(cycle.id) ?? `${sanitizeEventCycleSnapshotStem(cycle.name)}.json`,
        enabled: cycle.enabled,
        autoAdvance: cycle.autoAdvance,
        phase: cycle.phase,
        previewTileCount: cycle.previewTileIds.length,
        activeTileCount: cycle.activeTileIds.length,
        nextTransitionAt: cycle.nextTransitionAt,
        lastAction: cycle.lastAction,
      })),
    },
  );

  await Promise.all(
    config.eventTileCycles.map((cycle) =>
      writeConfigAtomically(
        path.join(snapshotsPath, snapshotFileNames.get(cycle.id) ?? `${sanitizeEventCycleSnapshotStem(cycle.name)}.json`),
        {
          exportedAt,
          selected: cycle.id === selectedCycle.id,
          cycle,
        },
      ),
    ),
  );
}
