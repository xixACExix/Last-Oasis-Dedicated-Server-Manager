import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig, saveConfig } from "./configStore.js";
import {
  cancelPendingMaintenance,
  forgetDesiredProfiles,
  getSchedulerMonitorStatus,
  getSchedulerStatus,
  getNextScheduledRestartAt,
  markDesiredProfiles,
  planGameUpdateRestart,
  planSafeStop,
  recordSchedulerAction,
  announceEventTileCreated,
  reconcileModsAndPlanRestart,
  sendUpdateLifecycleNotification,
  syncScheduler,
  updateModsAndPlanRestart,
} from "./automation.js";
import { buildDashboardState, buildLaunchStatus, checkGameUpdate, collectLiveServers, countServerProcesses, createBackup, detectLocalNetworkIp, detectPublicIp, getConfiguredServerAdminDataPath, getConfiguredServerInstallPath, getConfiguredServerLogsPath, installSteamCmd, listServerProcesses, readLogTail, startAllServers, startServer, stopServer, syncMods, updateGame } from "./serverManager.js";
import { inspectMyRealmFlow } from "./myRealmInspector.js";
import {
  isCurrentlyCreatedMyRealmTile,
  loadMyRealmSessionSnapshot,
  loadSavedMyRealmSessionSnapshot,
  openMyRealmManagedBrowser,
  saveMyRealmSessionSnapshot,
  syncMyRealmTileMods,
} from "./myRealmSession.js";
import { advanceEventTileCycle, applyEventTileCycleState, createEventTileCycle, deleteEventTileCycle, forceCleanupEventTileCycle, loadEventTileContext, pauseEventTileCycle, preserveEventTileCycleLibraryForConfigSave, previewEventTileBatchPlan, startEventTilePreviewCycle } from "./eventTileCycle.js";
import { runWithEventTileCycleLock } from "./eventTileCycleLock.js";
import { acknowledgeGameBridgeMessages, clearGameBridgeMessages, getMessageBridgeStatus, listGameBridgeChat, listGameBridgeMessages, markGameBridgeChatDiscordPosted, pollGameBridgeMessages, queueGameMessage, recordGameBridgeChat } from "./messageBridge.js";
import { getRemoteAccessInfo, isLoopbackRequest, loginRemoteAccess, requireRemoteAccess, updateRemotePassword } from "./remoteAccess.js";
import { clearSteamLoginCredentials, getSteamLoginInfo, saveSteamLoginCredentials } from "./steamCredentials.js";
import { getSteamClientStatus, loginSteamClient, maybeAutoLoginSteamClientOnBackendStartup } from "./steamClient.js";
import { getDiscordReplyBotStatus, syncDiscordReplyBot } from "./discordReplyBot.js";
import type { DiagnosticBundle, GameBridgeChatEntry, InGameMessageBridgeStatus, ManagerAuditEntry, MyRealmApiProbeResult, MyRealmSessionSnapshot } from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../");
const CLIENT_DIST = path.join(ROOT_DIR, "dist", "client");
const APP_VERSION = "0.1.16";
const MYREALM_ORIGIN = "https://myrealm.lastoasis.gg";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "4020", 10);
let myRealmSessionCache: MyRealmSessionSnapshot | null = null;
let startAllLaunchInFlight: Promise<void> | null = null;
const DASHBOARD_CACHE_TTL_MS = 3_000;
const MONITOR_CACHE_TTL_MS = 2_500;
const MYREALM_BACKGROUND_REFRESH_MS = 60_000;
let lastMyRealmRefreshAt = 0;
let dashboardStateCache:
  | {
      expiresAt: number;
      configKey: string;
      value: Awaited<ReturnType<typeof buildResponseState>>;
    }
  | null = null;
let monitorStateCache:
  | {
      expiresAt: number;
      configKey: string;
      value: {
        online: true;
        profiles: number;
        runningHosts: number;
        desiredHosts: number;
        selectedProfileId: string | null;
        selectedProfileName: string | null;
        selectedIdentifier: string | null;
        eventPhase: string;
        previewBatchCount: number;
        activeBatchCount: number;
        nextTransitionAt: string | null;
        serverAction: string;
        eventAction: string;
        launchPhase: string;
        launchSummary: string;
        pendingHosts: number;
        warmingHosts: number;
      };
    }
  | null = null;
let stateCacheGeneration = 0;
const managerAudit: ManagerAuditEntry[] = [];
const MANAGER_AUDIT_LIMIT = 120;

function recordManagerAudit(entry: Omit<ManagerAuditEntry, "id" | "createdAt">) {
  managerAudit.unshift({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...entry,
  });

  if (managerAudit.length > MANAGER_AUDIT_LIMIT) {
    managerAudit.length = MANAGER_AUDIT_LIMIT;
  }
}

function buildConfigCacheKey(config: Awaited<ReturnType<typeof loadConfig>>) {
  return JSON.stringify({
    selectedProfileId: config.selectedProfileId,
    selectedEventTileCycleId: config.selectedEventTileCycleId,
    paths: {
      persistedConfigPath: config.paths.persistedConfigPath,
      installPath: getConfiguredServerInstallPath(config),
      logsPath: getConfiguredServerLogsPath(config),
    },
    realmSettings: config.realmSettings,
    operationsSettings: config.operationsSettings,
    eventTileCycle: config.eventTileCycle,
    eventTileCycles: config.eventTileCycles,
    profiles: config.profiles,
  });
}

function liveServerMatchesProfile(
  server: Awaited<ReturnType<typeof collectLiveServers>>[number],
  profile: Awaited<ReturnType<typeof loadConfig>>["profiles"][number],
) {
  const profileIdentifier = profile.launch.identifier?.trim().toLowerCase();
  const serverIdentifier = server.identifier?.trim().toLowerCase();

  if (profileIdentifier && serverIdentifier && profileIdentifier === serverIdentifier) {
    return true;
  }

  if (server.gamePort !== null && server.gamePort === profile.launch.port) {
    return true;
  }

  if (profile.launch.queryPort !== null && server.queryPort !== null && server.queryPort === profile.launch.queryPort) {
    return true;
  }

  return false;
}

async function resolveProfileLiveServers(
  config: Awaited<ReturnType<typeof loadConfig>>,
  profile: Awaited<ReturnType<typeof loadConfig>>["profiles"][number],
) {
  const liveServers = await collectLiveServers(config);
  return liveServers.filter((server) => liveServerMatchesProfile(server, profile));
}

function describeProfileLiveServer(server: Awaited<ReturnType<typeof collectLiveServers>>[number] | null) {
  if (!server) {
    return "not running";
  }

  const map = server.map?.trim() || "not hosting yet";
  const pid = server.processId ? `PID ${server.processId}` : "no PID";
  return `${map}, ${server.status}, ${pid}`;
}

const startSchema = z.object({
  profileId: z.string().min(1),
});

const profileServerActionSchema = z.object({
  profileId: z.string().min(1),
  force: z.boolean().optional(),
});

const stopSchema = z.object({
  pid: z.number().int().positive().optional(),
  force: z.boolean().optional(),
});

const safeStopSchema = z.object({
  reason: z.string().trim().min(1).max(200),
});

const profileSchema = z.object({
  profileId: z.string().min(1),
});

const myRealmManagedBrowserSchema = z.object({
  url: z.string().trim().min(1).max(2048),
});

const addressModeSchema = z.object({
  mode: z.enum(["public", "lan"]),
});

const eventTileCycleActionSchema = z.object({
  cycleId: z.string().min(1).optional(),
});

const eventTileCycleCreateSchema = z.object({
  cloneFromCycleId: z.string().min(1).optional(),
  cycleName: z.string().trim().min(1).max(80).optional(),
});

const installSteamCmdSchema = z.object({
  installDirectory: z.string().optional(),
});

const updateModsSchema = z.object({
  modId: z.string().optional(),
});

const installWorkshopModSchema = z.object({
  input: z.string().min(1),
});

const remotePasswordUpdateSchema = z.object({
  password: z.string().trim().min(8).max(200),
});

const steamLoginSaveSchema = z.object({
  accountName: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(256),
  steamClientAutoLogin: z.boolean().optional().default(false),
});

const gameBridgeSeveritySchema = z.enum(["info", "success", "warning", "danger"]);
const gameBridgeTargetScopeSchema = z.enum(["global", "tile"]);

const gameBridgeAdminMessageSchema = z.object({
  message: z.string().trim().min(1).max(360),
  title: z.string().trim().max(80).optional(),
  severity: gameBridgeSeveritySchema.optional(),
  durationSeconds: z.coerce.number().int().min(3).max(600).optional(),
  targetScope: gameBridgeTargetScopeSchema.optional(),
  targetIdentifier: z.string().trim().max(100).nullable().optional(),
  targetLabel: z.string().trim().max(120).nullable().optional(),
  withWidget: z.coerce.boolean().optional(),
});

const gameBridgePollSchema = z.object({
  clientId: z.string().trim().max(80).optional(),
  version: z.string().trim().max(80).optional(),
  mapName: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const gameBridgeAckSchema = z.object({
  ids: z.array(z.string().trim().min(1)).max(50),
  clientId: z.string().trim().max(80).optional(),
});

const gameBridgeChatSchema = z.object({
  channel: z.string().trim().max(30).optional(),
  playerName: z.string().trim().max(80).optional(),
  message: z.string().trim().min(1).max(600),
  mapName: z.string().trim().max(120).optional(),
  tileName: z.string().trim().max(120).optional(),
  profileId: z.string().trim().max(120).optional(),
  clientId: z.string().trim().max(80).optional(),
  externalId: z.string().trim().max(160).optional(),
  createdAt: z.string().trim().max(40).optional(),
});

function extractWorkshopModId(input: string) {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const id = parsed.searchParams.get("id");
    if (id && /^\d+$/.test(id)) {
      return id;
    }
  } catch {
    // Fall back to regex parsing for pasted partial URLs.
  }

  const regexMatch = trimmed.match(/[?&]id=(\d+)/i) ?? trimmed.match(/sharedfiles\/filedetails\/?\/?(?:\?[^#]*?)?id=(\d+)/i);
  if (regexMatch?.[1]) {
    return regexMatch[1];
  }

  throw new Error("Paste a Steam Workshop mod URL or a numeric workshop item ID.");
}

async function buildResponseState(config: Awaited<ReturnType<typeof loadConfig>>) {
  if (!myRealmSessionCache) {
    await ensureMyRealmSessionCacheAvailable(config, { force: true, allowLaunch: false });
  } else if (Date.now() - lastMyRealmRefreshAt >= MYREALM_BACKGROUND_REFRESH_MS) {
    void ensureMyRealmSessionCacheAvailable(config).catch(() => undefined);
  }
  syncScheduler(config);
  const schedulerStatus = await getSchedulerStatus(config);
  return buildDashboardState(config, schedulerStatus, myRealmSessionCache);
}

function invalidateStateCaches() {
  stateCacheGeneration += 1;
  dashboardStateCache = null;
  monitorStateCache = null;
}

async function getCachedResponseState(config: Awaited<ReturnType<typeof loadConfig>>, force = false) {
  const configKey = buildConfigCacheKey(config);
  if (!force && dashboardStateCache && dashboardStateCache.configKey === configKey && dashboardStateCache.expiresAt > Date.now()) {
    return dashboardStateCache.value;
  }

  const cacheGeneration = stateCacheGeneration;
  const nextState = await buildResponseState(config);
  if (cacheGeneration === stateCacheGeneration) {
    dashboardStateCache = {
      expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS,
      configKey,
      value: nextState,
    };
  }
  return nextState;
}

async function getCachedMonitorState(config: Awaited<ReturnType<typeof loadConfig>>, force = false) {
  const configKey = buildConfigCacheKey(config);
  if (!force && monitorStateCache && monitorStateCache.configKey === configKey && monitorStateCache.expiresAt > Date.now()) {
    return monitorStateCache.value;
  }

  const cacheGeneration = stateCacheGeneration;
  const schedulerStatus = getSchedulerMonitorStatus(config);
  const runningHosts = await countServerProcesses();
  const selectedProfile = config.profiles.find((profile) => profile.id === config.selectedProfileId) ?? config.profiles[0] ?? null;
  const launchStatus = buildLaunchStatus(schedulerStatus.desiredRunningProfiles, runningHosts, runningHosts);
  const nextState = {
    online: true as const,
    profiles: config.profiles.length,
    runningHosts,
    desiredHosts: schedulerStatus.desiredRunningProfiles,
    selectedProfileId: selectedProfile?.id ?? null,
    selectedProfileName: selectedProfile?.name ?? null,
    selectedIdentifier: selectedProfile?.launch.identifier ?? null,
    eventPhase: config.eventTileCycle.phase,
    previewBatchCount: config.eventTileCycle.previewTileIds.length,
    activeBatchCount: config.eventTileCycle.activeTileIds.length,
    nextTransitionAt: config.eventTileCycle.nextTransitionAt,
    serverAction: schedulerStatus.lastAction,
    eventAction: config.eventTileCycle.lastAction,
    launchPhase: launchStatus.phase,
    launchSummary: launchStatus.summary,
    pendingHosts: launchStatus.pendingHosts,
    warmingHosts: launchStatus.warmingHosts,
  };

  if (cacheGeneration === stateCacheGeneration) {
    monitorStateCache = {
      expiresAt: Date.now() + MONITOR_CACHE_TTL_MS,
      configKey,
      value: nextState,
    };
  }
  return nextState;
}

function mergeMyRealmSessionCache(partial: {
  tiles?: MyRealmSessionSnapshot["tiles"];
  activeTileNames?: string[];
  activeTiles?: number;
}) {
  if (!myRealmSessionCache) {
    return null;
  }

  myRealmSessionCache = {
    ...myRealmSessionCache,
    connectedAt: new Date().toISOString(),
    tiles: partial.tiles ?? myRealmSessionCache.tiles,
    activeTileNames: partial.activeTileNames ?? myRealmSessionCache.activeTileNames,
    activeTiles: partial.activeTiles ?? myRealmSessionCache.activeTiles,
  };
  void saveMyRealmSessionSnapshot(myRealmSessionCache).catch(() => undefined);

  return myRealmSessionCache;
}

function buildMyRealmProbePaths(config: Awaited<ReturnType<typeof loadConfig>>) {
  const customerId = config.myRealmFlow?.customerId;
  const realmId = config.myRealmFlow?.realmId;
  return [
    { label: "Docs root", path: "/api" },
    { label: "Swagger", path: "/swagger" },
    { label: "Swagger UI", path: "/swagger/index.html" },
    { label: "OpenAPI JSON", path: "/openapi.json" },
    { label: "API Swagger", path: "/api/swagger" },
    ...(customerId
      ? [
          { label: "Customer API page", path: `/customer/${customerId}/Api` },
        ]
      : []),
    ...(realmId
      ? [
          { label: "Realm page", path: `/realm/${realmId}` },
          { label: "Tiles page", path: `/realm/${realmId}/Tiles` },
          { label: "Characters page", path: `/realm/${realmId}/Characters` },
          { label: "Map page", path: `/realm/${realmId}/Map` },
          { label: "Map index data", path: `/realm/${realmId}/map/indexdata` },
        ]
      : []),
  ];
}

async function probeMyRealmApi(config: Awaited<ReturnType<typeof loadConfig>>): Promise<MyRealmApiProbeResult> {
  const apiKey = config.realmSettings.apiKey.trim();
  const headerSets: Array<{
    headerMode: MyRealmApiProbeResult["rows"][number]["headerMode"];
    headers: Record<string, string>;
  }> = [
    { headerMode: "none", headers: {} },
    { headerMode: "x-api-key", headers: apiKey ? { "X-Api-Key": apiKey } : {} },
    { headerMode: "bearer", headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
    { headerMode: "api-key", headers: apiKey ? { "Api-Key": apiKey } : {} },
  ];
  const rows: MyRealmApiProbeResult["rows"] = [];

  for (const route of buildMyRealmProbePaths(config)) {
    for (const headerSet of headerSets) {
      if (headerSet.headerMode !== "none" && !apiKey) {
        rows.push({
          label: route.label,
          path: route.path,
          headerMode: headerSet.headerMode,
          status: null,
          contentType: null,
          contentLength: null,
          redirectedTo: null,
          note: "Skipped; no API key is configured.",
        });
        continue;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch(new URL(route.path, MYREALM_ORIGIN), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
            "User-Agent": "Last Oasis Control Center API Probe",
            ...headerSet.headers,
          },
        });
        await response.body?.cancel().catch(() => undefined);
        rows.push({
          label: route.label,
          path: route.path,
          headerMode: headerSet.headerMode,
          status: response.status,
          contentType: response.headers.get("content-type"),
          contentLength: Number.parseInt(response.headers.get("content-length") ?? "", 10) || null,
          redirectedTo: response.headers.get("location"),
          note: response.status === 405 ? "Endpoint exists but does not accept GET." : null,
        });
      } catch (error) {
        rows.push({
          label: route.label,
          path: route.path,
          headerMode: headerSet.headerMode,
          status: null,
          contentType: null,
          contentLength: null,
          redirectedTo: null,
          note: error instanceof Error ? error.message : "Request failed.",
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  recordManagerAudit({
    category: "diagnostics",
    action: "myrealm-api-probe",
    status: "success",
    summary: `Checked ${rows.length} safe MyRealm API/header combinations.`,
  });

  return {
    checkedAt: new Date().toISOString(),
    baseUrl: MYREALM_ORIGIN,
    hasApiKey: Boolean(apiKey),
    rows,
  };
}

function countConfiguredWebhooks(config: Awaited<ReturnType<typeof loadConfig>>) {
  return [
    config.operationsSettings.discordMyRealmWebhookUrl,
    config.operationsSettings.discordPlayerCounterWebhookUrl,
    config.operationsSettings.discordTileOnlineWebhookUrl,
    config.operationsSettings.discordUpdateWebhookUrl,
    config.operationsSettings.discordEventTileWebhookUrl,
    config.operationsSettings.discordGameChatWebhookUrl,
    config.operationsSettings.discordBotEnabled && config.operationsSettings.discordBotToken && config.operationsSettings.discordBotChannelId
      ? "discord-reply-bot"
      : "",
  ].filter((value) => value.trim()).length;
}

function chatChannelColor(channel: GameBridgeChatEntry["channel"]) {
  switch (channel) {
    case "clan":
      return 0x8fc77c;
    case "map":
      return 0x4ea1ff;
    case "combat":
      return 0xdf6748;
    case "other":
      return 0xb58cff;
    default:
      return 0xf2a44a;
  }
}

function normalizeDiscordTileName(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function resolveDiscordReplyTileTarget(tileName: string) {
  const normalizedTileName = normalizeDiscordTileName(tileName);
  if (!normalizedTileName) {
    return null;
  }

  const candidates = await listDiscordReplyTileTargets();
  const identifierMatch = candidates.find((server) => normalizeDiscordTileName(server.identifier) === normalizedTileName);
  if (identifierMatch) {
    return identifierMatch;
  }

  const exactMatch = candidates.find((server) => normalizeDiscordTileName(server.tileName) === normalizedTileName);
  const looseMatch =
    exactMatch ??
    candidates.find((server) => {
      const normalizedMap = normalizeDiscordTileName(server.tileName);
      return normalizedMap.includes(normalizedTileName) || normalizedTileName.includes(normalizedMap);
    });

  return looseMatch ?? null;
}

async function listDiscordReplyTileTargets() {
  const config = await loadConfig();
  const state = await getCachedResponseState(config, true);
  return state.liveServers
    .filter((server) => server.identifier && server.map)
    .map((server) => ({
      identifier: server.identifier ?? "",
      tileName: server.map ?? "",
    }))
    .filter((target) => target.identifier && target.tileName);
}

function syncDiscordReplyBotForConfig(config: Awaited<ReturnType<typeof loadConfig>>) {
  syncDiscordReplyBot(config, {
    resolveTileTarget: resolveDiscordReplyTileTarget,
    listTileTargets: listDiscordReplyTileTargets,
    recordAudit: recordManagerAudit,
  });
}

async function postGameBridgeChatToDiscord(config: Awaited<ReturnType<typeof loadConfig>>, entry: GameBridgeChatEntry) {
  const webhookUrl = config.operationsSettings.discordGameChatWebhookUrl.trim();
  if (!webhookUrl || entry.discordPostedAt) {
    return;
  }

  const location = entry.tileName || entry.mapName || "Unknown tile";
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "Last Oasis Chat",
      allowed_mentions: {
        parse: [],
        roles: [],
      },
      embeds: [
        {
          title: location.slice(0, 256),
          description: `${entry.playerName || "Unknown"}: ${entry.message}`.slice(0, 4000),
          footer: {
            text: "Last Oasis Manager",
          },
          timestamp: entry.createdAt,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord chat webhook failed with status ${response.status}.`);
  }

  await markGameBridgeChatDiscordPosted(entry.id);
}

function includeDiscordBotStatus(status: InGameMessageBridgeStatus): InGameMessageBridgeStatus {
  return {
    ...status,
    discordBot: getDiscordReplyBotStatus(),
  };
}

async function buildMessageBridgeStatus(): Promise<InGameMessageBridgeStatus> {
  return includeDiscordBotStatus(await getMessageBridgeStatus());
}

async function buildDiagnosticBundle(config: Awaited<ReturnType<typeof loadConfig>>): Promise<DiagnosticBundle> {
  const messageBridge = await buildMessageBridgeStatus();
  return {
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    paths: {
      installPath: getConfiguredServerInstallPath(config),
      executablePath:
        config.profiles.find((profile) => profile.id === config.selectedProfileId)?.executablePath ??
        config.profiles[0]?.executablePath ??
        "",
      workingDirectory:
        config.profiles.find((profile) => profile.id === config.selectedProfileId)?.workingDirectory ??
        config.profiles[0]?.workingDirectory ??
        "",
      logsPath: getConfiguredServerLogsPath(config),
      adminDataPath: getConfiguredServerAdminDataPath(config),
      persistedConfigPath: config.paths.persistedConfigPath,
      backupsPath: config.paths.backupsPath,
    },
    profiles: config.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      identifier: profile.launch.identifier,
      gamePort: profile.launch.port,
      queryPort: profile.launch.queryPort,
      restartEnabled: profile.restartPolicy.enabled,
      validationIssues: profile.validationIssues,
    })),
    myRealm: {
      hasFlow: Boolean(config.myRealmFlow),
      customerIdKnown: Boolean(config.myRealmFlow?.customerId),
      realmIdKnown: Boolean(config.myRealmFlow?.realmId),
      apiKeyConfigured: Boolean(config.realmSettings.apiKey.trim()),
      sessionCached: Boolean(myRealmSessionCache),
      cachedTileCount: myRealmSessionCache?.tiles.length ?? 0,
    },
    operations: {
      modCount: config.operationsSettings.modIds.length,
      autoUpdateMods: config.operationsSettings.autoUpdateMods,
      autoUpdateGameServer: config.operationsSettings.autoUpdateGameServer,
      modUpdateCheckMinutes: config.operationsSettings.modUpdateCheckMinutes,
      gameUpdateCheckMinutes: config.operationsSettings.gameUpdateCheckMinutes,
      autoRestartOfflineRealms: config.operationsSettings.autoRestartOfflineRealms,
      discordWebhooksConfigured: countConfiguredWebhooks(config),
    },
    messageBridge: {
      queueDepth: messageBridge.queueDepth ?? 0,
      pendingCount: messageBridge.pendingCount ?? 0,
      lastPollAt: messageBridge.lastPollAt ?? null,
      lastClientId: messageBridge.lastClientId ?? null,
      chatLogPath: messageBridge.chatLogPath ?? null,
    },
    recentAudit: managerAudit.slice(0, 40),
  };
}

async function refreshMyRealmSessionCacheNow(
  myRealmFlow: Awaited<ReturnType<typeof inspectMyRealmFlow>>,
  options?: {
    allowLaunch?: boolean;
  },
) {
  const session = await loadMyRealmSessionSnapshot(myRealmFlow, { allowLaunch: options?.allowLaunch ?? false });
  myRealmSessionCache = session;
  lastMyRealmRefreshAt = Date.now();
  await saveMyRealmSessionSnapshot(session).catch(() => undefined);
  invalidateStateCaches();
  return session;
}

async function ensureMyRealmSessionCacheAvailable(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options?: {
    force?: boolean;
    allowLaunch?: boolean;
  },
) {
  if (!myRealmSessionCache) {
    myRealmSessionCache = await loadSavedMyRealmSessionSnapshot();
    if (myRealmSessionCache && !lastMyRealmRefreshAt) {
      const cachedConnectedAt = Date.parse(myRealmSessionCache.connectedAt);
      if (Number.isFinite(cachedConnectedAt)) {
        lastMyRealmRefreshAt = cachedConnectedAt;
      }
    }
  }

  if (myRealmSessionCache && !myRealmSessionMatchesFlow(myRealmSessionCache, config.myRealmFlow)) {
    myRealmSessionCache = null;
    lastMyRealmRefreshAt = 0;
  }

  const now = Date.now();
  const isFresh = myRealmSessionCache && now - lastMyRealmRefreshAt < MYREALM_BACKGROUND_REFRESH_MS;
  if (!options?.force && isFresh) {
    return myRealmSessionCache;
  }

  try {
    const resolved = await resolveCurrentMyRealmFlow(config, { requireIds: false });
    const allowLaunch = options?.allowLaunch ?? false;

    return await refreshMyRealmSessionCacheNow(resolved.myRealmFlow, { allowLaunch });
  } catch {
    return myRealmSessionCache;
  }
}

function myRealmSessionMatchesFlow(
  session: MyRealmSessionSnapshot,
  flow: Awaited<ReturnType<typeof inspectMyRealmFlow>> | null | undefined,
) {
  if (!flow) {
    return true;
  }

  if (flow.customerId && session.customerId && flow.customerId !== session.customerId) {
    return false;
  }

  if (flow.realmId && session.realmId && flow.realmId !== session.realmId) {
    return false;
  }

  return true;
}

function ensureMyRealmSessionCacheInBackground(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options?: {
    force?: boolean;
    allowLaunch?: boolean;
  },
) {
  void ensureMyRealmSessionCacheAvailable(config, {
    force: options?.force ?? true,
    allowLaunch: options?.allowLaunch,
  }).catch(() => undefined);
}

async function announceCreatedEventTiles(
  config: Awaited<ReturnType<typeof loadConfig>>,
  result: {
    createdTileIds?: number[];
    createdTiles?: Array<{
      tileId: number;
      tileName: string;
      mapName: string | null;
      quality: number | null;
      activationAt: string | null;
      deactivationAt: string | null;
    }>;
    activationAt?: string | null;
    deactivationAt?: string | null;
  },
  tiles: MyRealmSessionSnapshot["tiles"],
) {
  const createdTileIds = result.createdTileIds ?? [];
  const createdTiles = result.createdTiles ?? [];
  if ((!createdTileIds.length && !createdTiles.length) || !config.operationsSettings.discordEventTileWebhookUrl.trim()) {
    return;
  }

  const cycle =
    config.eventTileCycles.find((entry) => entry.id === config.selectedEventTileCycleId) ??
    config.eventTileCycle;
  const byId = new Map(tiles.map((tile) => [tile.tileId, tile]));
  const createdTilesForWebhook = createdTiles.length
    ? createdTiles.map((tile) => ({
        tileName: tile.tileName,
        mapName: tile.mapName,
        quality: tile.quality,
        activationAt: tile.activationAt ?? result.activationAt ?? null,
        deactivationAt: tile.deactivationAt ?? result.deactivationAt ?? null,
      }))
    : createdTileIds
        .map((tileId) => byId.get(tileId))
        .filter((tile): tile is NonNullable<typeof tile> => Boolean(tile))
        .map((tile) => ({
          tileName: tile.tileName,
          mapName: tile.mapName,
          quality: tile.quality,
          activationAt: result.activationAt ?? tile.activationDate ?? null,
          deactivationAt: result.deactivationAt ?? tile.deactivationDate ?? null,
        }));

  await announceEventTileCreated(config, cycle, createdTilesForWebhook);
}

function hasResolvedMyRealmIds(
  myRealmFlow: Awaited<ReturnType<typeof inspectMyRealmFlow>> | null | undefined,
): myRealmFlow is Awaited<ReturnType<typeof inspectMyRealmFlow>> & { customerId: string; realmId: string } {
  return Boolean(myRealmFlow?.customerId && myRealmFlow?.realmId);
}

function hasReusableMyRealmRoute(myRealmFlow: Awaited<ReturnType<typeof inspectMyRealmFlow>> | null | undefined) {
  return Boolean(
    myRealmFlow?.dashboardUrl ||
      myRealmFlow?.realmUrl ||
      myRealmFlow?.mapUrl ||
      myRealmFlow?.apiUrl ||
      (myRealmFlow?.recentTileUrls?.length ?? 0) > 0,
  );
}

function choosePreferredFlowString(preferred: string | null | undefined, fallback: string | null | undefined) {
  const normalizedPreferred = preferred?.trim() ?? "";
  if (normalizedPreferred) {
    return normalizedPreferred;
  }

  const normalizedFallback = fallback?.trim() ?? "";
  return normalizedFallback || null;
}

function flowIdChanged(preferredId: string | null | undefined, fallbackId: string | null | undefined) {
  return Boolean(preferredId?.trim() && fallbackId?.trim() && preferredId.trim() !== fallbackId.trim());
}

function mergeMyRealmFlowSummaries(
  preferred: Awaited<ReturnType<typeof inspectMyRealmFlow>> | null | undefined,
  fallback: Awaited<ReturnType<typeof inspectMyRealmFlow>> | null | undefined,
) {
  if (!preferred) {
    return fallback ?? null;
  }

  if (!fallback) {
    return preferred;
  }

  const customerChanged = flowIdChanged(preferred.customerId, fallback.customerId);
  const realmChanged = flowIdChanged(preferred.realmId, fallback.realmId);
  const fallbackCustomerFlow = customerChanged ? null : fallback;
  const fallbackRealmFlow = customerChanged || realmChanged ? null : fallback;

  return {
    browser: choosePreferredFlowString(preferred.browser, fallback.browser),
    customerId: choosePreferredFlowString(preferred.customerId, fallback.customerId),
    realmId: choosePreferredFlowString(preferred.realmId, fallbackRealmFlow?.realmId),
    dashboardUrl: choosePreferredFlowString(preferred.dashboardUrl, fallbackCustomerFlow?.dashboardUrl),
    realmUrl: choosePreferredFlowString(preferred.realmUrl, fallbackRealmFlow?.realmUrl),
    mapUrl: choosePreferredFlowString(preferred.mapUrl, fallbackRealmFlow?.mapUrl),
    serversUrl: choosePreferredFlowString(preferred.serversUrl, fallbackCustomerFlow?.serversUrl),
    providersUrl: choosePreferredFlowString(preferred.providersUrl, fallbackCustomerFlow?.providersUrl),
    usersUrl: choosePreferredFlowString(preferred.usersUrl, fallbackCustomerFlow?.usersUrl),
    apiUrl: choosePreferredFlowString(preferred.apiUrl, fallbackCustomerFlow?.apiUrl),
    recentTileUrls: [
      ...new Set([...(preferred.recentTileUrls ?? []), ...(fallbackRealmFlow?.recentTileUrls ?? [])].filter(Boolean)),
    ],
    note: choosePreferredFlowString(preferred.note, fallback.note) ?? "",
  };
}

function buildMyRealmFlowFromSession(
  session: MyRealmSessionSnapshot,
  fallback: Awaited<ReturnType<typeof inspectMyRealmFlow>> | null | undefined,
): Awaited<ReturnType<typeof inspectMyRealmFlow>> | null {
  if (!session.customerId && !session.realmId) {
    return fallback ?? null;
  }

  const customerId = session.customerId ?? fallback?.customerId ?? null;
  const realmId = session.realmId ?? fallback?.realmId ?? null;

  return {
    browser: session.browser ?? fallback?.browser ?? null,
    customerId,
    realmId,
    dashboardUrl: session.links.dashboardUrl ?? (customerId ? `${MYREALM_ORIGIN}/customer/${customerId}` : null),
    realmUrl: session.links.realmUrl ?? (realmId ? `${MYREALM_ORIGIN}/realm/${realmId}` : null),
    mapUrl: session.links.mapUrl ?? (realmId ? `${MYREALM_ORIGIN}/realm/${realmId}/map` : null),
    serversUrl: customerId ? `${MYREALM_ORIGIN}/customer/${customerId}/Servers` : (fallback?.serversUrl ?? null),
    providersUrl: customerId ? `${MYREALM_ORIGIN}/customer/${customerId}/Providers` : (fallback?.providersUrl ?? null),
    usersUrl: customerId ? `${MYREALM_ORIGIN}/customer/${customerId}/users` : (fallback?.usersUrl ?? null),
    apiUrl: session.links.apiUrl ?? (customerId ? `${MYREALM_ORIGIN}/customer/${customerId}/Api` : null),
    recentTileUrls: (fallback?.recentTileUrls ?? []).filter((url) => (realmId ? url.includes(`/realm/${realmId}/`) : true)),
    note: session.note || fallback?.note || "",
  };
}

async function resolveCurrentMyRealmFlow(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options?: {
    requireIds?: boolean;
    forceInspect?: boolean;
  },
) {
  const shouldInspect =
    options?.forceInspect || !hasResolvedMyRealmIds(config.myRealmFlow) || !hasReusableMyRealmRoute(config.myRealmFlow);
  const discoveredFlow = shouldInspect ? await inspectMyRealmFlow() : config.myRealmFlow;
  const myRealmFlow = mergeMyRealmFlowSummaries(discoveredFlow, config.myRealmFlow);
  if (!myRealmFlow) {
    throw new Error("MyRealm discovery did not return any reusable route yet.");
  }
  const requireIds = options?.requireIds ?? true;
  if (requireIds && !hasResolvedMyRealmIds(myRealmFlow)) {
    throw new Error("MyRealm discovery has not found both the customer ID and realm ID yet.");
  }
  if (!requireIds && !hasResolvedMyRealmIds(myRealmFlow) && !hasReusableMyRealmRoute(myRealmFlow)) {
    throw new Error("MyRealm discovery has not found a reusable dashboard, realm, map, or API route yet.");
  }
  const configChanged = JSON.stringify(config.myRealmFlow ?? null) !== JSON.stringify(myRealmFlow ?? null);
  const nextConfig = configChanged
    ? await saveConfig({
        ...config,
        myRealmFlow,
      })
    : config;

  return {
    config: nextConfig,
    myRealmFlow,
  };
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    version: APP_VERSION,
    checkedAt: new Date().toISOString(),
  });
});

app.get("/api/remote/access", async (request, response) => {
  try {
    response.json(await getRemoteAccessInfo(request));
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load remote access settings.",
    });
  }
});

app.post("/api/remote/login", async (request, response) => {
  await loginRemoteAccess(request, response);
});

app.post("/api/remote/password", async (request, response) => {
  try {
    if (!isLoopbackRequest(request)) {
      response.status(403).json({ error: "Remote password changes are only allowed from the local desktop Manager." });
      return;
    }

    const { password } = remotePasswordUpdateSchema.parse(request.body ?? {});
    response.json({
      ok: true,
      ...(await updateRemotePassword(password)),
    });
  } catch (error) {
    response.status(error instanceof z.ZodError ? 400 : 500).json({
      error: error instanceof Error ? error.message : "Failed to update remote password.",
    });
  }
});

app.get("/api/steam-login", async (request, response) => {
  try {
    if (!isLoopbackRequest(request)) {
      response.status(403).json({ error: "Steam login settings are only available from the local desktop Manager." });
      return;
    }

    response.json(await getSteamLoginInfo());
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load Steam login settings.",
    });
  }
});

app.post("/api/steam-login", async (request, response) => {
  try {
    if (!isLoopbackRequest(request)) {
      response.status(403).json({ error: "Steam login settings can only be changed from the local desktop Manager." });
      return;
    }

    const { accountName, password, steamClientAutoLogin } = steamLoginSaveSchema.parse(request.body ?? {});
    response.json(await saveSteamLoginCredentials(accountName, password, steamClientAutoLogin));
  } catch (error) {
    response.status(error instanceof z.ZodError ? 400 : 500).json({
      error: error instanceof Error ? error.message : "Failed to save Steam login settings.",
    });
  }
});

app.delete("/api/steam-login", async (request, response) => {
  try {
    if (!isLoopbackRequest(request)) {
      response.status(403).json({ error: "Steam login settings can only be changed from the local desktop Manager." });
      return;
    }

    response.json(await clearSteamLoginCredentials());
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to clear Steam login settings.",
    });
  }
});

app.get("/api/steam-login/client-status", async (request, response) => {
  try {
    if (!isLoopbackRequest(request)) {
      response.status(403).json({ error: "Steam client login status is only available from the local desktop Manager." });
      return;
    }

    response.json(await getSteamClientStatus());
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load Steam client status.",
    });
  }
});

app.post("/api/steam-login/client-login", async (request, response) => {
  try {
    if (!isLoopbackRequest(request)) {
      response.status(403).json({ error: "Steam client login can only be started from the local desktop Manager." });
      return;
    }

    response.json(await loginSteamClient("manual"));
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to start Steam client login.",
    });
  }
});

app.use("/api", requireRemoteAccess);

app.get("/api/remote/steam-client/status", async (_request, response) => {
  try {
    response.json(await getSteamClientStatus());
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load Steam client status.",
    });
  }
});

app.post("/api/remote/steam-client/login", async (_request, response) => {
  try {
    const result = await loginSteamClient("remote-manual");
    response.json(result);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to start Steam client login.",
    });
  }
});

app.get("/api/monitor", async (_request, response) => {
  try {
    const config = await loadConfig();
    const monitorState = await getCachedMonitorState(config);
    response.json(monitorState);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load launcher monitor status.",
    });
  }
});

app.get("/api/state", async (_request, response) => {
  try {
    const config = await loadConfig();
    const dashboard = await getCachedResponseState(config);
    response.json(dashboard);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load dashboard state.",
    });
  }
});

app.get("/api/audit", (_request, response) => {
  response.json({ entries: managerAudit });
});

app.get("/api/message-bridge/status", async (_request, response) => {
  try {
    const status = await buildMessageBridgeStatus();
    recordManagerAudit({
      category: "message-bridge",
      action: "status",
      status: status.configured ? "success" : "info",
      summary: status.note,
    });
    response.json({ status });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load the in-game message bridge status.",
    });
  }
});

app.get("/api/message-bridge/messages", async (_request, response) => {
  try {
    const result = await listGameBridgeMessages();
    response.json({ ...result, status: includeDiscordBotStatus(result.status) });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load queued in-game messages.",
    });
  }
});

app.post("/api/message-bridge/admin-message", async (request, response) => {
  try {
    const body = gameBridgeAdminMessageSchema.parse(request.body);
    const message = await queueGameMessage({
      type: "admin",
      source: "manual",
      severity: body.severity ?? "info",
      title: body.title || "Admin",
      message: body.message,
      durationSeconds: body.durationSeconds ?? 12,
      targetScope: body.targetScope ?? "global",
      targetIdentifier: body.targetIdentifier,
      targetLabel: body.targetLabel,
      withWidget: body.withWidget ?? true,
      expiresInSeconds: 60 * 60,
    });
    const status = await buildMessageBridgeStatus();
    recordManagerAudit({
      category: "message-bridge",
      action: "admin-message",
      status: "success",
      summary: `Queued in-game admin message: ${message.message.slice(0, 80)}`,
    });
    response.json({ message, status });
  } catch (error) {
    recordManagerAudit({
      category: "message-bridge",
      action: "admin-message",
      status: "error",
      summary: error instanceof Error ? error.message : "Failed to queue in-game admin message.",
    });
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to queue in-game admin message.",
    });
  }
});

app.post("/api/message-bridge/clear", async (_request, response) => {
  try {
    const status = await clearGameBridgeMessages();
    recordManagerAudit({
      category: "message-bridge",
      action: "clear-queue",
      status: "success",
      summary: "Cleared queued in-game bridge messages.",
    });
    response.json({ status: includeDiscordBotStatus(status) });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to clear queued in-game messages.",
    });
  }
});

app.get("/api/message-bridge/chat", async (request, response) => {
  try {
    const limit = z.coerce.number().int().min(1).max(250).optional().parse(request.query.limit);
    const result = await listGameBridgeChat(limit ?? 100);
    response.json({ ...result, status: includeDiscordBotStatus(result.status) });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to load bridge chat log.",
    });
  }
});

app.get("/api/game-bridge/messages/poll", async (request, response) => {
  try {
    const query = gameBridgePollSchema.parse(request.query);
    const result = await pollGameBridgeMessages(query);
    response.json({ ...result, status: includeDiscordBotStatus(result.status) });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to poll in-game bridge messages.",
    });
  }
});

app.post("/api/game-bridge/messages/poll", async (request, response) => {
  try {
    const body = gameBridgePollSchema.parse(request.body);
    const result = await pollGameBridgeMessages(body);
    response.json({ ...result, status: includeDiscordBotStatus(result.status) });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to poll in-game bridge messages.",
    });
  }
});

app.post("/api/game-bridge/messages/ack", async (request, response) => {
  try {
    const body = gameBridgeAckSchema.parse(request.body);
    const result = await acknowledgeGameBridgeMessages(body.ids, body.clientId);
    response.json({ ...result, status: includeDiscordBotStatus(result.status) });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to acknowledge in-game bridge messages.",
    });
  }
});

app.post("/api/game-bridge/chat", async (request, response) => {
  try {
    const body = gameBridgeChatSchema.parse(request.body);
    const { entry, duplicate } = await recordGameBridgeChat(body);
    if (!duplicate) {
      void loadConfig()
        .then((config) => postGameBridgeChatToDiscord(config, entry))
        .catch((error) => {
          recordManagerAudit({
            category: "message-bridge",
            action: "discord-chat-forward",
            status: "warning",
            summary: error instanceof Error ? error.message : "Failed to forward game chat to Discord.",
          });
        });
    }
    response.json({ entry, duplicate });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to record in-game chat.",
    });
  }
});

app.get("/api/diagnostics/export", async (_request, response) => {
  try {
    const config = await loadConfig();
    const bundle = await buildDiagnosticBundle(config);
    recordManagerAudit({
      category: "diagnostics",
      action: "redacted-export",
      status: "success",
      summary: "Prepared a redacted diagnostic bundle.",
    });
    response.json({ bundle });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to build diagnostic bundle.",
    });
  }
});

app.post("/api/myrealm/api-probe", async (_request, response) => {
  try {
    const config = await loadConfig();
    const result = await probeMyRealmApi(config);
    response.json({ result });
  } catch (error) {
    recordManagerAudit({
      category: "diagnostics",
      action: "myrealm-api-probe",
      status: "error",
      summary: error instanceof Error ? error.message : "Failed to run MyRealm API probe.",
    });
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to run MyRealm API probe.",
    });
  }
});

app.put("/api/config", async (request, response) => {
  try {
    const currentConfig = await loadConfig();
    const incomingConfig = typeof request.body === "object" && request.body !== null ? request.body : {};
    const mergedConfig = {
      ...currentConfig,
      ...incomingConfig,
      paths: {
        ...currentConfig.paths,
        ...((typeof incomingConfig.paths === "object" && incomingConfig.paths !== null) ? incomingConfig.paths : {}),
      },
      realmSettings: {
        ...currentConfig.realmSettings,
        ...((typeof incomingConfig.realmSettings === "object" && incomingConfig.realmSettings !== null) ? incomingConfig.realmSettings : {}),
      },
      operationsSettings: {
        ...currentConfig.operationsSettings,
        ...((typeof incomingConfig.operationsSettings === "object" && incomingConfig.operationsSettings !== null) ? incomingConfig.operationsSettings : {}),
      },
      myRealmFlow: "myRealmFlow" in incomingConfig ? incomingConfig.myRealmFlow : currentConfig.myRealmFlow,
      profiles: Array.isArray(incomingConfig.profiles) ? incomingConfig.profiles : currentConfig.profiles,
      ...preserveEventTileCycleLibraryForConfigSave(currentConfig, incomingConfig),
    };
    const config = await saveConfig(mergedConfig);
    syncDiscordReplyBotForConfig(config);
    invalidateStateCaches();
    response.json({
      ok: true,
      config,
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to save configuration.",
    });
  }
});

app.post("/api/config/selected-profile", async (request, response) => {
  try {
    const { profileId } = profileSchema.parse(request.body ?? {});
    const config = await loadConfig();
    const profile = config.profiles.find((entry) => entry.id === profileId);

    if (!profile) {
      response.status(404).json({ error: `Profile not found: ${profileId}` });
      return;
    }

    const nextConfig =
      config.selectedProfileId === profileId
        ? config
        : await saveConfig({
            ...config,
            selectedProfileId: profileId,
          });

    invalidateStateCaches();
    response.json({
      ok: true,
      config: nextConfig,
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to save the selected profile.",
    });
  }
});

app.post("/api/server/start", async (request, response) => {
  try {
    const { profileId } = startSchema.parse(request.body);
    const config = await loadConfig();
    const profile = config.profiles.find((entry) => entry.id === profileId);

    if (!profile) {
      response.status(404).json({ error: `Profile not found: ${profileId}` });
      return;
    }

    markDesiredProfiles([profile.id]);
    cancelPendingMaintenance("Manual start requested. Cleared any queued maintenance action.");
    recordSchedulerAction(`Start requested for ${profile.name}. Launching through the control center now...`);
    invalidateStateCaches();
    const result = await startServer(profile, {
      activeModIds: config.operationsSettings.modIds,
    });
    recordSchedulerAction(`Started ${profile.name} on PID ${result.pid}.`);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ ...result, dashboard });
  } catch (error) {
    const profileId = request.body?.profileId;
    if (typeof profileId === "string" && profileId.length > 0) {
      forgetDesiredProfiles([profileId]);
    }
    recordSchedulerAction(error instanceof Error ? `Start failed: ${error.message}` : "Start failed.");
    invalidateStateCaches();
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to start the server process.",
    });
  }
});

app.post("/api/server/stop-profile", async (request, response) => {
  try {
    const payload = profileServerActionSchema.parse(request.body ?? {});
    const config = await loadConfig();
    const profile = config.profiles.find((entry) => entry.id === payload.profileId);

    if (!profile) {
      response.status(404).json({ error: `Profile not found: ${payload.profileId}` });
      return;
    }

    cancelPendingMaintenance(`Manual stop requested for ${profile.name}. Cleared any queued maintenance action.`);
    const liveServers = await resolveProfileLiveServers(config, profile);
    const targetPids = [...new Set(liveServers.map((server) => server.processId).filter((pid): pid is number => Boolean(pid)))];

    if (!targetPids.length) {
      forgetDesiredProfiles([profile.id]);
      recordSchedulerAction(`Stop requested for ${profile.name}, but no matching running process was found.`);
      invalidateStateCaches();
      const dashboard = await getCachedResponseState(config, true);
      response.json({ ok: true, stopped: false, profileId: profile.id, dashboard });
      return;
    }

    recordSchedulerAction(
      `${payload.force ? "Force stop" : "Stop"} requested for ${profile.name}: ${liveServers.map(describeProfileLiveServer).join("; ")}.`,
    );
    for (const pid of targetPids) {
      await stopServer(pid, payload.force ?? false);
    }
    forgetDesiredProfiles([profile.id]);
    recordSchedulerAction(`Stopped ${profile.name}.`);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ ok: true, stopped: true, profileId: profile.id, pids: targetPids, dashboard });
  } catch (error) {
    recordSchedulerAction(error instanceof Error ? `Profile stop failed: ${error.message}` : "Profile stop failed.");
    invalidateStateCaches();
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to stop the selected host profile.",
    });
  }
});

app.post("/api/server/restart-profile", async (request, response) => {
  let profileId: string | null = null;

  try {
    const payload = profileServerActionSchema.parse(request.body ?? {});
    profileId = payload.profileId;
    const config = await loadConfig();
    const profile = config.profiles.find((entry) => entry.id === payload.profileId);

    if (!profile) {
      response.status(404).json({ error: `Profile not found: ${payload.profileId}` });
      return;
    }

    cancelPendingMaintenance(`Manual restart requested for ${profile.name}. Cleared any queued maintenance action.`);
    const liveServers = await resolveProfileLiveServers(config, profile);
    const targetPids = [...new Set(liveServers.map((server) => server.processId).filter((pid): pid is number => Boolean(pid)))];

    if (targetPids.length) {
      recordSchedulerAction(`Restart requested for ${profile.name}. Stopping ${liveServers.map(describeProfileLiveServer).join("; ")} first.`);
      for (const pid of targetPids) {
        await stopServer(pid, payload.force ?? false);
      }
    } else {
      recordSchedulerAction(`Restart requested for ${profile.name}, but no matching running process was found. Starting it fresh.`);
    }

    forgetDesiredProfiles([profile.id]);
    markDesiredProfiles([profile.id]);
    invalidateStateCaches();
    const started = await startServer(profile, {
      activeModIds: config.operationsSettings.modIds,
    });
    recordSchedulerAction(`Restarted ${profile.name} on PID ${started.pid}.`);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ ok: true, profileId: profile.id, stoppedPids: targetPids, started, dashboard });
  } catch (error) {
    if (profileId) {
      forgetDesiredProfiles([profileId]);
    }
    recordSchedulerAction(error instanceof Error ? `Profile restart failed: ${error.message}` : "Profile restart failed.");
    invalidateStateCaches();
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to restart the selected host profile.",
    });
  }
});

app.post("/api/server/start-all", async (_request, response) => {
  try {
    const config = await loadConfig();
    const requestedProfileIds = config.profiles.map((profile) => profile.id);
    cancelPendingMaintenance("Manual start-all requested. Cleared any queued maintenance action.");
    markDesiredProfiles(requestedProfileIds);
    const alreadyRunning = startAllLaunchInFlight !== null;

    if (!alreadyRunning) {
      recordSchedulerAction(`Start requested for ${requestedProfileIds.length} realm hosts. Building the launch queue now...`);
      invalidateStateCaches();
      startAllLaunchInFlight = (async () => {
        try {
          const result = await startAllServers(config.profiles, config.operationsSettings.modIds);
          const summaryParts = [`${result.started.length} process live`, `${result.skipped.length} skipped`, `${result.failed.length} failed`];
          const launchSummary = buildLaunchStatus(requestedProfileIds.length, result.started.length).summary;
          recordSchedulerAction(`Bulk process launch finished: ${summaryParts.join(", ")}. ${launchSummary}`);
          if (result.failed.length) {
            const firstFailure = result.failed[0];
            recordSchedulerAction(
              `Bulk process launch finished: ${summaryParts.join(", ")}. ${launchSummary} First failure: ${firstFailure.profileName} - ${firstFailure.reason}`,
            );
          }
          invalidateStateCaches();
        } finally {
          startAllLaunchInFlight = null;
          invalidateStateCaches();
        }
      })();
    } else {
      recordSchedulerAction("Start all was requested again while a bulk launch is already running.");
      invalidateStateCaches();
    }

    invalidateStateCaches();
    response.status(202).json({
      accepted: true,
      alreadyRunning,
      profileIds: requestedProfileIds,
    });
  } catch (error) {
    recordSchedulerAction(error instanceof Error ? `Bulk start failed: ${error.message}` : "Bulk start failed.");
    invalidateStateCaches();
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to start the configured server profiles.",
    });
  }
});

app.post("/api/server/stop", async (request, response) => {
  try {
    const payload = stopSchema.parse(request.body ?? {});
    cancelPendingMaintenance("Manual stop requested. Cleared any queued maintenance action.");
    const actionLabel =
      payload.pid !== undefined
        ? `${payload.force ? "Force stop" : "Stop"} requested for PID ${payload.pid}.`
        : `${payload.force ? "Force stop" : "Stop"} requested for all running realm hosts.`;
    recordSchedulerAction(actionLabel);
    await stopServer(payload.pid, payload.force ?? false);
    forgetDesiredProfiles();
    recordSchedulerAction(
      payload.pid !== undefined
        ? `Stopped PID ${payload.pid}.`
        : `${payload.force ? "Force stop completed" : "Stop completed"} for all running realm hosts.`,
    );
    const config = await loadConfig();
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ ok: true, dashboard });
  } catch (error) {
    recordSchedulerAction(error instanceof Error ? `Stop failed: ${error.message}` : "Stop failed.");
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to stop the server process.",
    });
  }
});

app.post("/api/server/safe-stop", async (_request, response) => {
  try {
    const { reason } = safeStopSchema.parse(_request.body ?? {});
    const config = await loadConfig();
    const result = await planSafeStop(config, reason);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ ok: true, result, dashboard });
  } catch (error) {
    recordSchedulerAction(error instanceof Error ? `Safe stop failed: ${error.message}` : "Safe stop failed.");
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to schedule the safe maintenance stop.",
    });
  }
});

app.post("/api/restarts/skip-next", async (request, response) => {
  try {
    const payload = z.object({ profileId: z.string().min(1).optional() }).parse(request.body ?? {});
    const config = await loadConfig();
    const profile =
      (payload.profileId ? config.profiles.find((entry) => entry.id === payload.profileId) : null) ??
      (config.selectedProfileId ? config.profiles.find((entry) => entry.id === config.selectedProfileId) : null) ??
      config.profiles[0] ??
      null;

    if (!profile) {
      response.status(404).json({ error: "No profile is available to skip a scheduled restart." });
      return;
    }

    const nextScheduledRestartAt = getNextScheduledRestartAt(profile.restartPolicy, new Date(), true);
    if (!profile.restartPolicy.enabled || !nextScheduledRestartAt) {
      response.status(400).json({ error: "Scheduled restarts are not enabled for the selected profile." });
      return;
    }

    const skippedAt = nextScheduledRestartAt.toISOString();
    const nextConfig = await saveConfig({
      ...config,
      profiles: config.profiles.map((entry) =>
        entry.id === profile.id
          ? {
              ...entry,
              restartPolicy: {
                ...entry.restartPolicy,
                skipNextScheduledRestartAt: skippedAt,
              },
            }
          : entry,
      ),
    });
    recordSchedulerAction(`Skipped the next scheduled restart for ${profile.name} at ${nextScheduledRestartAt.toLocaleString()}.`);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ ok: true, skippedAt, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to skip the next scheduled restart.",
    });
  }
});

app.post("/api/restarts/clear-skip", async (request, response) => {
  try {
    const payload = z.object({ profileId: z.string().min(1).optional() }).parse(request.body ?? {});
    const config = await loadConfig();
    const profile =
      (payload.profileId ? config.profiles.find((entry) => entry.id === payload.profileId) : null) ??
      (config.selectedProfileId ? config.profiles.find((entry) => entry.id === config.selectedProfileId) : null) ??
      config.profiles[0] ??
      null;

    if (!profile) {
      response.status(404).json({ error: "No profile is available to clear a scheduled restart skip." });
      return;
    }

    const nextConfig = await saveConfig({
      ...config,
      profiles: config.profiles.map((entry) =>
        entry.id === profile.id
          ? {
              ...entry,
              restartPolicy: {
                ...entry.restartPolicy,
                skipNextScheduledRestartAt: null,
                coveredScheduledRestartAt: null,
              },
            }
          : entry,
      ),
    });
    recordSchedulerAction(`Cleared the scheduled restart skip for ${profile.name}.`);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ ok: true, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to clear the scheduled restart skip.",
    });
  }
});

app.post("/api/backups/create", async (_request, response) => {
  try {
    const config = await loadConfig();
    const backup = await createBackup(config);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ backup, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to create a backup.",
    });
  }
});

app.post("/api/network/public-ip/detect", async (_request, response) => {
  try {
    const ip = await detectPublicIp();
    const config = await loadConfig();
    const nextConfig = await saveConfig({
      ...config,
      operationsSettings: {
        ...config.operationsSettings,
        lastKnownPublicIp: ip.address,
      },
    });
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ ip, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to detect the public IP.",
    });
  }
});

app.post("/api/network/public-ip/apply", async (request, response) => {
  try {
    const { profileId } = profileSchema.parse(request.body);
    const config = await loadConfig();
    const nextProfiles = config.profiles.map((profile) =>
      profile.id === profileId
        ? {
            ...profile,
            launch: {
              ...profile.launch,
              overrideConnectionAddress: config.operationsSettings.lastKnownPublicIp,
            },
          }
        : profile,
    );

    const nextConfig = await saveConfig({
      ...config,
      profiles: nextProfiles,
    });
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ ok: true, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to apply the detected public IP.",
    });
  }
});

app.post("/api/network/address-mode", async (request, response) => {
  try {
    const { mode } = addressModeSchema.parse(request.body);
    const config = await loadConfig();
    const appliedAddress = mode === "public" ? config.operationsSettings.lastKnownPublicIp : detectLocalNetworkIp();

    if (!appliedAddress) {
      response.status(400).json({
        error: mode === "public" ? "No stored public IP is available yet." : "No suitable local network IPv4 address could be detected.",
      });
      return;
    }

    const nextConfig = await saveConfig({
      ...config,
      profiles: config.profiles.map((profile) => ({
        ...profile,
        launch: {
          ...profile.launch,
          overrideConnectionAddress: appliedAddress,
        },
      })),
    });
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ mode, appliedAddress, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to apply the selected address mode.",
    });
  }
});

app.post("/api/maintenance/update-game", async (_request, response) => {
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig();
    const runningProcesses = await listServerProcesses().catch(() => []);
    if (runningProcesses.length) {
      const restartPlan = await planGameUpdateRestart(config).catch(() => ({
        restartScheduled: false,
        restartAt: null,
        note: "No delayed restart was queued for the server update.",
      }));
      if (restartPlan.restartScheduled) {
        await sendUpdateLifecycleNotification(config, "game", "start", [
          `Queued SteamCMD app update for app ${config.operationsSettings.appId}.`,
          config.operationsSettings.betaBranch ? `Branch override: ${config.operationsSettings.betaBranch}` : "Branch: public",
          restartPlan.note,
        ]).catch(() => undefined);
        invalidateStateCaches();
        const dashboard = await getCachedResponseState(config, true);
        response.json({ result: null, restartPlan, dashboard });
        return;
      }
    }

    await sendUpdateLifecycleNotification(config, "game", "start", [
      `Running SteamCMD app update for app ${config.operationsSettings.appId}.`,
      config.operationsSettings.betaBranch ? `Branch override: ${config.operationsSettings.betaBranch}` : "Branch: public",
      runningProcesses.length
        ? "No configured realm host profiles are running. Other Last Oasis processes were ignored, so the configured server path is updating immediately."
        : "No Last Oasis server processes are running, so the configured server path is updating immediately.",
    ]).catch(() => undefined);
    const result = await updateGame(config);
    const restartPlan = await planGameUpdateRestart(config).catch(() => ({
      restartScheduled: false,
      restartAt: null,
      note: "No delayed restart was queued after the server update.",
    }));
    await sendUpdateLifecycleNotification(config, "game", "finish", [
      "SteamCMD server update completed.",
      restartPlan.note,
      result.stderr || result.stdout || "SteamCMD returned without additional output.",
    ]).catch(() => undefined);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ result, restartPlan, dashboard });
  } catch (error) {
    if (config) {
      await sendUpdateLifecycleNotification(config, "game", "failed", [
      error instanceof Error ? error.message : "Failed to update the game server via SteamCMD.",
      ]).catch(() => undefined);
    }
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to update the game server via SteamCMD.",
    });
  }
});

app.post("/api/maintenance/check-game-update", async (_request, response) => {
  try {
    const config = await loadConfig();
    const result = await checkGameUpdate(config);
    recordManagerAudit({
      category: "server",
      action: "check-game-update",
      status: result.updateAvailable ? "warning" : result.updateAvailable === false ? "success" : "info",
      summary: result.note,
    });
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ result, dashboard });
  } catch (error) {
    recordManagerAudit({
      category: "server",
      action: "check-game-update",
      status: "error",
      summary: error instanceof Error ? error.message : "Failed to check the game server update status.",
    });
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to check the game server update status.",
    });
  }
});

app.post("/api/maintenance/install-steamcmd", async (request, response) => {
  try {
    const payload = installSteamCmdSchema.parse(request.body ?? {});
    const config = await loadConfig();
    const result = await installSteamCmd(config, payload.installDirectory);
    const nextConfig = await saveConfig({
      ...config,
      operationsSettings: {
        ...config.operationsSettings,
        steamCmdPath: result.executablePath,
        steamCmdInstallDirectory: result.installDirectory,
      },
    });
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ result, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to install SteamCMD.",
    });
  }
});

app.post("/api/mods/sync", async (_request, response) => {
  try {
    const config = await loadConfig();
    const result = await syncMods(config, true);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ result, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to sync mods.",
    });
  }
});

app.post("/api/mods/reconcile", async (_request, response) => {
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig();
    const result = await reconcileModsAndPlanRestart(config);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ result, dashboard });
  } catch (error) {
    if (config) {
      await sendUpdateLifecycleNotification(config, "mods", "failed", [
        error instanceof Error ? error.message : "Failed to sync mods and build the restart summary.",
      ]).catch(() => undefined);
    }
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to sync mods and build the restart summary.",
    });
  }
});

app.post("/api/mods/update", async (request, response) => {
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    const payload = updateModsSchema.parse(request.body ?? {});
    config = await loadConfig();
    const result = await updateModsAndPlanRestart(config, payload.modId ? [payload.modId] : undefined);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(config, true);
    response.json({ result, dashboard });
  } catch (error) {
    if (config) {
      await sendUpdateLifecycleNotification(config, "mods", "failed", [
        error instanceof Error ? error.message : "Failed to update mods.",
      ]).catch(() => undefined);
    }
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to update mods.",
    });
  }
});

app.post("/api/mods/install", async (request, response) => {
  try {
    const payload = installWorkshopModSchema.parse(request.body ?? {});
    const modId = extractWorkshopModId(payload.input);
    const config = await loadConfig();
    const alreadyConfigured = config.operationsSettings.modIds.includes(modId);
    const nextConfigInput = {
      ...config,
      operationsSettings: {
        ...config.operationsSettings,
        modIds: alreadyConfigured ? config.operationsSettings.modIds : [...config.operationsSettings.modIds, modId].sort(),
      },
    };
    const result = await syncMods(nextConfigInput, true, [modId]);
    const nextConfig = await saveConfig(nextConfigInput);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({
      modId,
      alreadyConfigured,
      result,
      dashboard,
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to install the workshop mod.",
    });
  }
});

app.post("/api/myrealm/discover", async (_request, response) => {
  try {
    const config = await loadConfig();
    const myRealmFlow = await inspectMyRealmFlow();
    const nextConfig = await saveConfig({
      ...config,
      myRealmFlow,
    });
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ myRealmFlow, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to inspect the local MyRealm browser flow.",
    });
  }
});

app.get("/api/myrealm/session", (_request, response) => {
  void (async () => {
    const config = await loadConfig();
    await ensureMyRealmSessionCacheAvailable(config, { force: !myRealmSessionCache, allowLaunch: false });

    response.json({ session: myRealmSessionCache });
  })().catch((error) => {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to load the cached MyRealm session.",
    });
  });
});

app.post("/api/myrealm/session/refresh", async (_request, response) => {
  try {
    const config = await loadConfig();
    const resolved = await resolveCurrentMyRealmFlow(config, { requireIds: false, forceInspect: true });
    const session = await refreshMyRealmSessionCacheNow(resolved.myRealmFlow, { allowLaunch: true });
    const sessionFlow = buildMyRealmFlowFromSession(session, resolved.myRealmFlow);
    const configChanged = JSON.stringify(resolved.config.myRealmFlow ?? null) !== JSON.stringify(sessionFlow ?? null);
    const nextConfig =
      configChanged && sessionFlow
        ? await saveConfig({
            ...resolved.config,
            myRealmFlow: sessionFlow,
          })
        : resolved.config;
    if (configChanged) {
      invalidateStateCaches();
    }
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ session, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to load the authenticated MyRealm session.",
    });
  }
});

app.post("/api/myrealm/managed-browser/open", async (request, response) => {
  try {
    const { url } = myRealmManagedBrowserSchema.parse(request.body ?? {});
    const config = await loadConfig();
    const resolved = await resolveCurrentMyRealmFlow(config, { requireIds: false });
    const result = await openMyRealmManagedBrowser(resolved.myRealmFlow, url);
    response.json({ ok: true, ...result });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to open the managed MyRealm browser.",
    });
  }
});

app.post("/api/myrealm/mods/sync", async (_request, response) => {
  try {
    const config = await loadConfig();
    const resolved = await resolveCurrentMyRealmFlow(config);
    const result = await syncMyRealmTileMods(resolved.myRealmFlow, resolved.config.operationsSettings.modIds);
    const session = await refreshMyRealmSessionCacheNow(resolved.myRealmFlow, { allowLaunch: false });
    const dashboard = await getCachedResponseState(resolved.config, true);
    response.json({ result, session, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to sync MyRealm tile mods.",
    });
  }
});

app.post("/api/myrealm/event-tiles/start", async (_request, response) => {
  try {
    const { cycleId } = eventTileCycleActionSchema.parse(_request.body ?? {});
    const config = await loadConfig();
    const lockedResult = await runWithEventTileCycleLock(config, cycleId, "manual-start", async (freshConfig) => {
      const resolved = await resolveCurrentMyRealmFlow(freshConfig);
      const nextConfigBase = resolved.config;
      const { nextState, result, tiles } = await startEventTilePreviewCycle(nextConfigBase, resolved.myRealmFlow, cycleId);
      const nextConfig = await saveConfig(applyEventTileCycleState({ ...nextConfigBase, selectedEventTileCycleId: nextState.id }, nextState));
      return { resolved, nextConfig, nextState, result, tiles };
    });
    const activeTiles = lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).length;
    const fallbackSession =
      mergeMyRealmSessionCache({
        tiles: lockedResult.tiles,
        activeTileNames: lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).map((tile) => tile.tileName).slice(0, 12),
        activeTiles,
      }) ?? myRealmSessionCache;
    const session = await refreshMyRealmSessionCacheNow(lockedResult.resolved.myRealmFlow, { allowLaunch: false }).catch(() => fallbackSession);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(lockedResult.nextConfig, true);
    await announceCreatedEventTiles(lockedResult.nextConfig, lockedResult.result, lockedResult.tiles).catch(() => undefined);
    recordManagerAudit({
      category: "event-tiles",
      action: "start",
      status: "success",
      summary: lockedResult.result.message,
    });
    response.json({ result: lockedResult.result, session, dashboard });
    ensureMyRealmSessionCacheInBackground(lockedResult.nextConfig);
  } catch (error) {
    recordManagerAudit({
      category: "event-tiles",
      action: "start",
      status: "error",
      summary: error instanceof Error ? error.message : "Failed to start the event tile preview cycle.",
    });
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to start the event tile preview cycle.",
    });
  }
});

app.post("/api/myrealm/event-tiles/dry-run", async (_request, response) => {
  try {
    const { cycleId } = eventTileCycleActionSchema.parse(_request.body ?? {});
    const config = await loadConfig();
    const resolved = await resolveCurrentMyRealmFlow(config);
    const result = await previewEventTileBatchPlan(resolved.config, resolved.myRealmFlow, cycleId, { allowLaunch: false });
    recordManagerAudit({
      category: "event-tiles",
      action: "dry-run",
      status: result.selectedCandidates.length ? "success" : "warning",
      summary: result.message,
    });
    response.json({ result });
  } catch (error) {
    recordManagerAudit({
      category: "event-tiles",
      action: "dry-run",
      status: "error",
      summary: error instanceof Error ? error.message : "Failed to preview the event tile batch.",
    });
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to preview the event tile batch.",
    });
  }
});

app.post("/api/myrealm/event-tiles/advance", async (_request, response) => {
  try {
    const { cycleId } = eventTileCycleActionSchema.parse(_request.body ?? {});
    const config = await loadConfig();
    const lockedResult = await runWithEventTileCycleLock(config, cycleId, "manual-advance", async (freshConfig) => {
      const resolved = await resolveCurrentMyRealmFlow(freshConfig);
      const nextConfigBase = resolved.config;
      const { nextState, result, tiles } = await advanceEventTileCycle(nextConfigBase, resolved.myRealmFlow, cycleId);
      const nextConfig = await saveConfig(applyEventTileCycleState({ ...nextConfigBase, selectedEventTileCycleId: nextState.id }, nextState));
      return { resolved, nextConfig, nextState, result, tiles };
    });
    const activeTiles = lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).length;
    const fallbackSession =
      mergeMyRealmSessionCache({
        tiles: lockedResult.tiles,
        activeTileNames: lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).map((tile) => tile.tileName).slice(0, 12),
        activeTiles,
      }) ?? myRealmSessionCache;
    const session = await refreshMyRealmSessionCacheNow(lockedResult.resolved.myRealmFlow, { allowLaunch: false }).catch(() => fallbackSession);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(lockedResult.nextConfig, true);
    await announceCreatedEventTiles(lockedResult.nextConfig, lockedResult.result, lockedResult.tiles).catch(() => undefined);
    recordManagerAudit({
      category: "event-tiles",
      action: "advance",
      status: "success",
      summary: lockedResult.result.message,
    });
    response.json({ result: lockedResult.result, session, dashboard });
    ensureMyRealmSessionCacheInBackground(lockedResult.nextConfig);
  } catch (error) {
    recordManagerAudit({
      category: "event-tiles",
      action: "advance",
      status: "error",
      summary: error instanceof Error ? error.message : "Failed to advance the event tile cycle.",
    });
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to advance the event tile cycle.",
    });
  }
});

app.post("/api/myrealm/event-tiles/pause", async (_request, response) => {
  try {
    const { cycleId } = eventTileCycleActionSchema.parse(_request.body ?? {});
    const config = await loadConfig();
    const lockedResult = await runWithEventTileCycleLock(config, cycleId, "manual-pause", async (freshConfig) => {
      const resolved = await resolveCurrentMyRealmFlow(freshConfig);
      const nextConfigBase = resolved.config;
      const context = await loadEventTileContext(resolved.myRealmFlow);
      const { nextState, result } = pauseEventTileCycle(nextConfigBase, context.tiles, cycleId);
      const nextConfig = await saveConfig(applyEventTileCycleState({ ...nextConfigBase, selectedEventTileCycleId: nextState.id }, nextState));
      return { resolved, nextConfig, result, tiles: context.tiles };
    });
    const activeTiles = lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).length;
    const fallbackSession =
      mergeMyRealmSessionCache({
        tiles: lockedResult.tiles,
        activeTileNames: lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).map((tile) => tile.tileName).slice(0, 12),
        activeTiles,
      }) ?? myRealmSessionCache;
    const session = await refreshMyRealmSessionCacheNow(lockedResult.resolved.myRealmFlow, { allowLaunch: false }).catch(() => fallbackSession);
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(lockedResult.nextConfig, true);
    recordManagerAudit({
      category: "event-tiles",
      action: "pause",
      status: "success",
      summary: lockedResult.result.message,
    });
    response.json({ result: lockedResult.result, session, dashboard });
    ensureMyRealmSessionCacheInBackground(lockedResult.nextConfig);
  } catch (error) {
    recordManagerAudit({
      category: "event-tiles",
      action: "pause",
      status: "error",
      summary: error instanceof Error ? error.message : "Failed to pause the event tile cycle.",
    });
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to pause the event tile cycle.",
    });
  }
});

app.post("/api/myrealm/event-tiles/cleanup", async (_request, response) => {
  try {
    const { cycleId } = eventTileCycleActionSchema.parse(_request.body ?? {});
    const config = await loadConfig();
    const lockedResult = await runWithEventTileCycleLock(config, cycleId, "manual-cleanup", async (freshConfig) => {
      const resolved = await resolveCurrentMyRealmFlow(freshConfig);
      const nextConfigBase = resolved.config;
      const { nextState, result, tiles } = await forceCleanupEventTileCycle(nextConfigBase, resolved.myRealmFlow, cycleId);
      const nextConfig = await saveConfig(applyEventTileCycleState({ ...nextConfigBase, selectedEventTileCycleId: nextState.id }, nextState));
      return { resolved, nextConfig, result, tiles };
    });
    const activeTiles = lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).length;
    const fallbackSession =
      mergeMyRealmSessionCache({
        tiles: lockedResult.tiles,
        activeTileNames: lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).map((tile) => tile.tileName).slice(0, 12),
        activeTiles,
      }) ??
      {
        browser: lockedResult.nextConfig.myRealmFlow?.browser ?? null,
        connectedAt: new Date().toISOString(),
        customerId: lockedResult.nextConfig.myRealmFlow?.customerId ?? null,
        customerName: null,
        realmId: lockedResult.nextConfig.myRealmFlow?.realmId ?? null,
        realmName: null,
        apiKeyPreview: null,
        activePlayers: null,
        activeTiles,
        maxTiles: null,
        activeTileNames: lockedResult.tiles.filter(isCurrentlyCreatedMyRealmTile).map((tile) => tile.tileName).slice(0, 12),
        tiles: lockedResult.tiles,
        availableCreateTileMaps: [],
        hostingMode: null,
        activationMode: null,
        experienceMultiplier: null,
        foliageRespawnMultiplier: null,
        harvestMultiplier: null,
        maxClanSize: null,
        clanCooldown: null,
        otherSettingSummaries: [],
      };
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(lockedResult.nextConfig, true);
    recordManagerAudit({
      category: "event-tiles",
      action: "cleanup",
      status: "success",
      summary: lockedResult.result.message,
    });
    response.json({ result: lockedResult.result, session: fallbackSession, dashboard });
    ensureMyRealmSessionCacheInBackground(lockedResult.nextConfig);
  } catch (error) {
    recordManagerAudit({
      category: "event-tiles",
      action: "cleanup",
      status: "error",
      summary: error instanceof Error ? error.message : "Failed to force-clean the event tile cycle.",
    });
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to force-clean the event tile cycle.",
    });
  }
});

app.post("/api/myrealm/event-tiles/cycles/create", async (_request, response) => {
  try {
    const { cloneFromCycleId, cycleName } = eventTileCycleCreateSchema.parse(_request.body ?? {});
    const config = await loadConfig();
    const nextConfig = await saveConfig(createEventTileCycle(config, cloneFromCycleId, cycleName));
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ ok: true, config: nextConfig, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to create the event cycle.",
    });
  }
});

app.post("/api/myrealm/event-tiles/cycles/delete", async (_request, response) => {
  try {
    const { cycleId } = eventTileCycleActionSchema.parse(_request.body ?? {});
    const config = await loadConfig();
    const nextConfig = await saveConfig(deleteEventTileCycle(config, cycleId));
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ ok: true, config: nextConfig, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to delete the event cycle.",
    });
  }
});

app.post("/api/myrealm/event-tiles/cycles/select", async (_request, response) => {
  try {
    const { cycleId } = eventTileCycleActionSchema.extend({ cycleId: z.string().min(1) }).parse(_request.body ?? {});
    const config = await loadConfig();
    const selectedCycle =
      config.eventTileCycles.find((cycle) => cycle.id === cycleId) ??
      config.eventTileCycle;
    const nextConfig = await saveConfig({
      ...config,
      selectedEventTileCycleId: selectedCycle.id,
      eventTileCycle: selectedCycle,
    });
    invalidateStateCaches();
    const dashboard = await getCachedResponseState(nextConfig, true);
    response.json({ ok: true, config: nextConfig, dashboard });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to select the event cycle.",
    });
  }
});

app.get("/api/logs/:fileName", async (request, response) => {
  try {
    const lines = Number.parseInt(String(request.query.lines ?? "200"), 10);
    const config = await loadConfig();
    const tail = await readLogTail(getConfiguredServerLogsPath(config), request.params.fileName, Number.isFinite(lines) ? lines : 200);
    response.json(tail);
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : "Failed to read the log file.",
    });
  }
});

async function clientDistExists() {
  try {
    await fs.access(CLIENT_DIST);
    return true;
  } catch {
    return false;
  }
}

if (await clientDistExists()) {
  app.use(
    express.static(CLIENT_DIST, {
      setHeaders(response) {
        response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        response.setHeader("Pragma", "no-cache");
        response.setHeader("Expires", "0");
      },
    }),
  );
  app.get(/.*/, (_request, response) => {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Expires", "0");
    response.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Last Oasis Control Center API listening on http://localhost:${port}`);
  void loadConfig()
    .then((config) => syncDiscordReplyBotForConfig(config))
    .catch((error) => {
      console.warn(`Discord reply bot startup skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  setTimeout(() => {
    void maybeAutoLoginSteamClientOnBackendStartup()
      .then((result) => {
        if (result.attempted) {
          console.log(`Steam client auto-login: ${result.note}`);
        }
      })
      .catch((error) => {
        console.warn(`Steam client auto-login skipped: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, 5000);
});
