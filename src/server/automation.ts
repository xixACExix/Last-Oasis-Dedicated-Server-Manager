import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, EventTileCycleState, LiveServerSummary, ModSummary, MyRealmSessionSnapshot, MyRealmTileSummary, RestartPolicy, SchedulerStatus } from "../shared/types.js";
import { getProfileDataPath, loadConfig, saveConfig } from "./configStore.js";
import { advanceEventTileCycle, applyEventTileCycleState, getEventTileCycleNextMaintenanceAt, listEventTileCycles } from "./eventTileCycle.js";
import { runWithEventTileCycleLock } from "./eventTileCycleLock.js";
import { scanGameChatLogs } from "./gameLogChatWatcher.js";
import { queueGameMessage } from "./messageBridge.js";
import { inspectMyRealmFlow } from "./myRealmInspector.js";
import { loadMyRealmSessionSnapshot } from "./myRealmSession.js";
import { checkGameUpdate, collectLiveServers, listServerProcesses, readMods, startServer, stopServer, syncMods, updateGame } from "./serverManager.js";

let activeConfig: AppConfig | null = null;
let timerHandle: NodeJS.Timeout | null = null;
let busy = false;
let lastAction = "Scheduler is idle.";
let nextModCheckAt = 0;
let nextGameUpdateCheckAt = 0;
let gameUpdateCheckInFlight = false;
let pendingRestartTimer: NodeJS.Timeout | null = null;
let pendingRestartWarningTimers: NodeJS.Timeout[] = [];
let pendingRestartAt: string | null = null;
let pendingRestartProfileIds: string[] = [];
let pendingRestartProfileName: string | null = null;
let pendingRestartReason = "";
let pendingRestartPublicReason = "";
let pendingRestartAction: "restart" | "stop" = "restart";
let pendingRestartSource: "scheduled" | "mod-update" | "game-update" | "maintenance-stop" = "scheduled";
let pendingRestartMentionEveryone = false;
let pendingRestartWork: null | { kind: "mods-update"; modIds: string[] } | { kind: "game-update" } = null;
let lastWebhookTitle: string | null = null;
let lastWebhookAt: string | null = null;
let playerCounterBaselineReady = false;
let tileOnlineBaselineReady = false;
let lastPlayerCounterDigest = "";
let lastPlayerCounterWebhookAt = 0;
let lastOnlineTileIds = new Set<number>();
let lastHostedTilesById = new Map<number, {
  tileId: number;
  tileName: string;
  mapName: string | null;
  hostLabel: string;
  playerCount: number | null;
  statusLabel: string;
}>();
const desiredRunningProfileIds = new Set<string>();
const missingProfileSince = new Map<string, number>();
const lastRestartAttemptAt = new Map<string, number>();
const SCHEDULER_TICK_MS = 5_000;
const MYREALM_SESSION_CACHE_TTL_MS = 60_000;
const MYREALM_AUTOCONNECT_COOLDOWN_MS = 120_000;
const DESIRED_PROFILE_RESTART_COOLDOWN_MS = 10_000;
const DESIRED_PROFILE_STARTUP_GRACE_MS = 20_000;
const DEFAULT_RESTART_FIXED_TIMES = ["00:00", "12:00"] as const;
const SCHEDULED_RESTART_COVER_WINDOW_MS = 90 * 60 * 1000;
const SCHEDULED_RESTART_WARNING_MINUTES = 30;
const UPDATE_RESTART_DELAY_MINUTES = 15;
const SAFE_STOP_DELAY_MINUTES = 10;
const MAINTENANCE_ANNOUNCEMENT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const DISCORD_WEBHOOK_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const PLAYER_COUNTER_WEBHOOK_MIN_INTERVAL_MS = 10 * 60 * 1000;
const MAINTENANCE_DEDUPE_BUCKET_MS = 5 * 60 * 1000;
let lastMyRealmAutoConnectAttemptAt = 0;
const managerProfileDataPath = getProfileDataPath();
const maintenanceAnnouncementStatePath = path.join(managerProfileDataPath, "discord", "maintenance-announcement-state.json");
const discordWebhookDedupeDirectory = path.join(managerProfileDataPath, "discord", "webhook-dedupe");

let myRealmSessionCache: {
  key: string;
  fetchedAt: number;
  session: MyRealmSessionSnapshot | null;
} | null = null;

type DiscordField = {
  name: string;
  value: string;
  inline?: boolean;
};

type DiscordWebhookOptions = {
  title: string;
  description?: string;
  color: number;
  fields?: DiscordField[];
  content?: string;
  allowEveryone?: boolean;
  allowedRoleIds?: string[];
  dedupeKey?: string | null;
  dedupeWindowMs?: number;
};

type MaintenanceAnnouncementState = {
  lastAnnouncementKey: string | null;
  lastAnnouncementAt: string | null;
};

function getPrimaryProfile(config: AppConfig) {
  return config.profiles.find((entry) => entry.id === config.selectedProfileId) ?? config.profiles[0] ?? null;
}

function clearPendingRestart() {
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }

  for (const timer of pendingRestartWarningTimers) {
    clearTimeout(timer);
  }
  pendingRestartWarningTimers = [];

  pendingRestartAt = null;
  pendingRestartProfileIds = [];
  pendingRestartProfileName = null;
  pendingRestartReason = "";
  pendingRestartPublicReason = "";
  pendingRestartAction = "restart";
  pendingRestartSource = "scheduled";
  pendingRestartMentionEveryone = false;
  pendingRestartWork = null;
}

function clearPendingModUpdateRestart() {
  if (pendingRestartSource === "mod-update" && pendingRestartWork?.kind === "mods-update") {
    clearPendingRestart();
  }
}

function createEmptySyncResult() {
  return {
    modsPath: "",
    synced: [] as string[],
    updated: [] as string[],
    missing: [] as string[],
    activated: [] as string[],
    deactivated: [] as string[],
    usedSteamCmd: false,
    mirroredToSteamWorkshop: false,
  };
}

async function executePendingRestartWork(config: AppConfig) {
  const work = pendingRestartWork;
  if (!work) {
    return;
  }

  if (work.kind === "mods-update") {
    const syncResult = await syncMods(config, true, work.modIds);
    const appliedIds = work.modIds.filter((modId) => syncResult.updated.includes(modId));

    if (appliedIds.length) {
      await announceUpdate(config, "Mod update applied", [
        `Applied ${appliedIds.length} workshop mod(s).`,
        syncResult.missing.length ? `Missing workshop files: ${syncResult.missing.join(", ")}.` : "Old server copies were replaced with the refreshed workshop files.",
      ]).catch(() => undefined);

      lastAction = `Applied ${appliedIds.length} mod change(s) during the maintenance window.`;
      return;
    }

    const missingText = syncResult.missing.length ? ` Missing workshop files: ${syncResult.missing.join(", ")}.` : "";
    lastAction = `No new mod files were applied during the maintenance window.${missingText}`.trim();
    return;
  }

  const result = await updateGame(config);
  await sendUpdateLifecycleNotification(config, "game", "finish", [
    "SteamCMD server update completed.",
    result.stderr || result.stdout || "SteamCMD returned without additional output.",
  ]).catch(() => undefined);
  lastAction = "SteamCMD server update completed during the maintenance window.";
}

function normalizeRestartTime(value: string) {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function getRestartFixedTimes(policy: RestartPolicy) {
  const normalized = (policy.fixedTimes?.length ? policy.fixedTimes : DEFAULT_RESTART_FIXED_TIMES)
    .map(normalizeRestartTime)
    .filter((entry): entry is string => Boolean(entry));
  return [...new Set(normalized.length ? normalized : DEFAULT_RESTART_FIXED_TIMES)].sort();
}

function getRestartIntervalHours(policy: RestartPolicy) {
  return Math.min(24, Math.max(1, Number.isFinite(policy.intervalHours) ? Math.round(policy.intervalHours) : 12));
}

function shouldSkipScheduledRestart(policy: RestartPolicy, candidate: Date, now = new Date()) {
  const skippedAt = policy.skipNextScheduledRestartAt ? Date.parse(policy.skipNextScheduledRestartAt) : Number.NaN;
  const coveredAt = policy.coveredScheduledRestartAt ? Date.parse(policy.coveredScheduledRestartAt) : Number.NaN;
  const candidateAt = candidate.getTime();
  const nowAt = now.getTime();

  if (Number.isFinite(skippedAt) && skippedAt >= nowAt - 60_000 && Math.abs(candidateAt - skippedAt) < 60_000) {
    return true;
  }

  return Number.isFinite(coveredAt) && coveredAt >= nowAt - 60_000 && Math.abs(candidateAt - coveredAt) < 60_000;
}

function getNextFixedScheduledRestartAt(policy: RestartPolicy, now = new Date(), includeSkipped = false) {
  const candidates: Date[] = [];
  const fixedTimes = getRestartFixedTimes(policy);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const fixedTime of fixedTimes) {
      const [hour, minute] = fixedTime.split(":").map((entry) => Number.parseInt(entry, 10));
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + dayOffset);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate.getTime() > now.getTime() && (includeSkipped || !shouldSkipScheduledRestart(policy, candidate, now))) {
        candidates.push(candidate);
      }
    }
  }

  candidates.sort((left, right) => left.getTime() - right.getTime());
  return candidates[0] ?? null;
}

function getNextIntervalScheduledRestartAt(policy: RestartPolicy, now = new Date(), includeSkipped = false) {
  const intervalHours = getRestartIntervalHours(policy);
  const candidates: Date[] = [];
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (let hour = 0; hour < 24; hour += intervalHours) {
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + dayOffset);
      candidate.setHours(hour, 0, 0, 0);
      if (candidate.getTime() > now.getTime() && (includeSkipped || !shouldSkipScheduledRestart(policy, candidate, now))) {
        candidates.push(candidate);
      }
    }
  }

  candidates.sort((left, right) => left.getTime() - right.getTime());
  return candidates[0] ?? null;
}

export function getNextScheduledRestartAt(policy: RestartPolicy, now = new Date(), includeSkipped = false) {
  return policy.scheduleMode === "interval"
    ? getNextIntervalScheduledRestartAt(policy, now, includeSkipped)
    : getNextFixedScheduledRestartAt(policy, now, includeSkipped);
}

function getRestartScheduleLabel(policy: RestartPolicy) {
  if (policy.scheduleMode === "interval") {
    return `Every ${getRestartIntervalHours(policy)} hour(s)`;
  }

  return getRestartFixedTimes(policy).join(" / ");
}

async function markNextScheduledRestartCovered(config: AppConfig, profiles: AppConfig["profiles"]) {
  const now = new Date();
  const coveredProfileIds = new Set(profiles.map((profile) => profile.id));
  let changed = false;
  const nextProfiles = config.profiles.map((profile) => {
    if (!coveredProfileIds.has(profile.id) || !profile.restartPolicy.enabled) {
      return profile;
    }

    const nextScheduledRestartAt = getNextScheduledRestartAt(profile.restartPolicy, now, true);
    if (!nextScheduledRestartAt) {
      return profile;
    }

    changed = true;
    return {
      ...profile,
      restartPolicy: {
        ...profile.restartPolicy,
        coveredScheduledRestartAt: nextScheduledRestartAt.toISOString(),
      },
    };
  });

  if (!changed) {
    return config;
  }

  const nextConfig = await saveConfig({
    ...config,
    profiles: nextProfiles,
  });
  activeConfig = nextConfig;
  return nextConfig;
}

function getPendingRestartTargetSummary() {
  return pendingRestartProfileName ?? "realm host pool";
}

function getMaintenanceDedupeBucket(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return "unknown";
  }

  return String(Math.round(parsed / MAINTENANCE_DEDUPE_BUCKET_MS));
}

function getPendingMaintenanceDedupeBucket() {
  return getMaintenanceDedupeBucket(pendingRestartAt);
}

function buildPendingMaintenanceAnnouncementKey(warningMinutes?: number) {
  return [
    "warning",
    warningMinutes ?? "any",
    pendingRestartAction,
    pendingRestartSource,
    getPendingMaintenanceDedupeBucket(),
    pendingRestartPublicReason || pendingRestartReason,
  ].join("|");
}

function buildMaintenanceFinishedAnnouncementKey(options: {
  action: "restart" | "stop";
  source: "scheduled" | "mod-update" | "game-update" | "maintenance-stop";
  targetSummary: string;
  publicReason: string;
  fatalError?: string | null;
  failedRestarts?: string[];
}) {
  return [
    "finished",
    getPendingMaintenanceDedupeBucket(),
    options.action,
    options.source,
    options.publicReason,
    options.fatalError ?? options.failedRestarts?.[0] ?? "ok",
  ].join("|");
}

function isManagedServerMod(mod: ModSummary) {
  return mod.serverInstalled;
}

async function readMaintenanceAnnouncementState(): Promise<MaintenanceAnnouncementState> {
  try {
    const raw = await fs.readFile(maintenanceAnnouncementStatePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MaintenanceAnnouncementState>;
    return {
      lastAnnouncementKey: typeof parsed.lastAnnouncementKey === "string" ? parsed.lastAnnouncementKey : null,
      lastAnnouncementAt: typeof parsed.lastAnnouncementAt === "string" ? parsed.lastAnnouncementAt : null,
    };
  } catch {
    return {
      lastAnnouncementKey: null,
      lastAnnouncementAt: null,
    };
  }
}

async function shouldSuppressMaintenanceAnnouncement(announcementKey: string) {
  const state = await readMaintenanceAnnouncementState();
  if (!state.lastAnnouncementKey || state.lastAnnouncementKey !== announcementKey || !state.lastAnnouncementAt) {
    return false;
  }

  const announcedAt = Date.parse(state.lastAnnouncementAt);
  if (!Number.isFinite(announcedAt)) {
    return false;
  }

  return Date.now() - announcedAt < MAINTENANCE_ANNOUNCEMENT_DEDUPE_WINDOW_MS;
}

async function recordMaintenanceAnnouncement(announcementKey: string) {
  await fs.mkdir(path.dirname(maintenanceAnnouncementStatePath), { recursive: true });
  await fs.writeFile(
    maintenanceAnnouncementStatePath,
    JSON.stringify({
      lastAnnouncementKey: announcementKey,
      lastAnnouncementAt: new Date().toISOString(),
    } satisfies MaintenanceAnnouncementState, null, 2),
    "utf8",
  );
}

async function clearMaintenanceAnnouncementClaim(announcementKey: string) {
  const state = await readMaintenanceAnnouncementState();
  if (state.lastAnnouncementKey !== announcementKey) {
    return;
  }

  await fs.mkdir(path.dirname(maintenanceAnnouncementStatePath), { recursive: true });
  await fs.writeFile(
    maintenanceAnnouncementStatePath,
    JSON.stringify(
      {
        lastAnnouncementKey: null,
        lastAnnouncementAt: null,
      } satisfies MaintenanceAnnouncementState,
      null,
      2,
    ),
    "utf8",
  );
}

function buildSchedulerStatusSnapshot(config: AppConfig, profile = getPrimaryProfile(config)): SchedulerStatus {
  const now = new Date();
  const restartPolicy = profile?.restartPolicy ?? null;
  const nextScheduledRestartAt = restartPolicy?.enabled ? getNextScheduledRestartAt(restartPolicy, now)?.toISOString() ?? null : null;
  const skippedRestartAtMs = restartPolicy?.skipNextScheduledRestartAt ? Date.parse(restartPolicy.skipNextScheduledRestartAt) : Number.NaN;
  const skippedRestartAt = Number.isFinite(skippedRestartAtMs) && skippedRestartAtMs > now.getTime() - 60_000
    ? restartPolicy?.skipNextScheduledRestartAt ?? null
    : null;

  return {
    enabled: Boolean(profile?.restartPolicy.enabled || config.operationsSettings.autoUpdateMods || config.operationsSettings.autoUpdateGameServer),
    monitoredProfileId: pendingRestartProfileIds[0] ?? profile?.id ?? null,
    monitoredProfileName: pendingRestartProfileName ?? profile?.name ?? null,
    nextRestartAt: pendingRestartAt ?? nextScheduledRestartAt,
    restartScheduleMode: restartPolicy?.scheduleMode ?? "fixed-times",
    restartScheduleLabel: restartPolicy ? getRestartScheduleLabel(restartPolicy) : "00:00 / 12:00",
    skippedRestartAt,
    skipActive: Boolean(skippedRestartAt),
    pendingAction: pendingRestartAt ? pendingRestartAction : null,
    pendingSource: pendingRestartAt ? pendingRestartSource : null,
    pendingReason: pendingRestartAt ? (pendingRestartPublicReason || pendingRestartReason) : null,
    pendingTargetSummary: pendingRestartAt ? getPendingRestartTargetSummary() : null,
    lastWebhookTitle,
    lastWebhookAt,
    lastAction,
    running: busy,
    autoRestartEnabled: config.operationsSettings.autoRestartOfflineRealms,
    desiredRunningProfiles: desiredRunningProfileIds.size,
  };
}

function getPendingMaintenanceWarningMinutes() {
  if (pendingRestartSource === "mod-update" || pendingRestartSource === "game-update") {
    return [15, 10, 5];
  }

  if (pendingRestartAction === "stop" || pendingRestartSource === "maintenance-stop") {
    return [10, 5];
  }

  return [30, 15, 10, 5];
}

function getPendingMaintenanceTitle() {
  if (pendingRestartSource === "mod-update") {
    return "Mod update restart";
  }

  if (pendingRestartSource === "game-update") {
    return "Server update restart";
  }

  if (pendingRestartAction === "stop") {
    return "Maintenance stop";
  }

  return "Scheduled restart";
}

function buildDiscordMaintenanceWarningMessage(warningMinutes: number) {
  const targetSummary = getPendingRestartTargetSummary();
  const actionLabel = pendingRestartAction === "stop" ? "stop" : "restart";
  const publicReason = pendingRestartPublicReason || pendingRestartReason;

  if (pendingRestartSource === "maintenance-stop") {
    return publicReason;
  }

  return `Server ${actionLabel} in ${warningMinutes} minute${warningMinutes === 1 ? "" : "s"} for ${targetSummary}. Reason: ${publicReason}`;
}

function buildInGameMaintenanceWarningMessage(warningMinutes: number) {
  const publicReason = pendingRestartPublicReason || pendingRestartReason;

  if (pendingRestartSource === "maintenance-stop") {
    return `Restart in ${warningMinutes} minute${warningMinutes === 1 ? "" : "s"} for a ${publicReason}`;
  }

  const scheduleMatch = /^Scheduled Restart \((.+)\)$/.exec(publicReason);
  const reasonLabel = scheduleMatch ? `Scheduled Restart (${scheduleMatch[1]})` : publicReason;
  return `Server restart in ${warningMinutes} minute${warningMinutes === 1 ? "" : "s"} for a ${reasonLabel}`;
}

async function announceMaintenanceWarning(config: AppConfig, warningMinutes: number, mentionWarningMinutes: number) {
  if (!pendingRestartAt) {
    return;
  }

  const warningSeconds = warningMinutes * 60;
  const inGameWarningMessage = buildInGameMaintenanceWarningMessage(warningMinutes);
  const discordWarningMessage = buildDiscordMaintenanceWarningMessage(warningMinutes);
  const inGameAnnouncementKey = buildPendingMaintenanceAnnouncementKey(warningMinutes);
  const discordAnnouncementKey = buildPendingMaintenanceAnnouncementKey();
  const targetSummary = getPendingRestartTargetSummary();
  const publicReason = pendingRestartPublicReason || pendingRestartReason;
  const source = pendingRestartSource === "mod-update" ? "mod-update" : pendingRestartSource === "game-update" ? "game-update" : "scheduler";
  const type =
    pendingRestartSource === "mod-update" || pendingRestartSource === "game-update"
      ? "update-warning"
      : pendingRestartAction === "restart"
        ? "restart-warning"
        : "maintenance";
  const title = `${getPendingMaintenanceTitle()} warning`;

  await queueGameMessage({
    type,
    source,
    severity: pendingRestartSource === "mod-update" || pendingRestartSource === "game-update" ? "danger" : "warning",
    title,
    message: inGameWarningMessage,
    durationSeconds: 15,
    countdownSeconds: warningSeconds,
    expiresInSeconds: warningSeconds + 10 * 60,
    dedupeKey: `maintenance:${inGameAnnouncementKey}`,
  }).catch(() => undefined);

  const webhookUrl = config.operationsSettings.discordUpdateWebhookUrl.trim();
  if (!webhookUrl || warningMinutes !== mentionWarningMinutes || (await shouldSuppressMaintenanceAnnouncement(discordAnnouncementKey))) {
    return;
  }
  await recordMaintenanceAnnouncement(discordAnnouncementKey).catch(() => undefined);

  const timestamp = toDiscordTimestamp(pendingRestartAt, "F") ?? pendingRestartAt;
  const relative = toDiscordTimestamp(pendingRestartAt, "R");
  const maintenanceRoleId = config.operationsSettings.discordMaintenanceRoleId.trim();
  const shouldMention = pendingRestartMentionEveryone && warningMinutes === mentionWarningMinutes;

  try {
    await postDiscordWebhook(webhookUrl, {
      title,
      description: discordWarningMessage,
      color: pendingRestartAction === "stop" ? 0xdf6748 : 0xf2a44a,
      dedupeKey: `maintenance-warning:${discordAnnouncementKey}`,
      dedupeWindowMs: MAINTENANCE_ANNOUNCEMENT_DEDUPE_WINDOW_MS,
      content: shouldMention
        ? maintenanceRoleId
          ? `<@&${maintenanceRoleId}>`
          : undefined
        : undefined,
      allowEveryone: false,
      allowedRoleIds: shouldMention && maintenanceRoleId ? [maintenanceRoleId] : undefined,
      fields: [
        {
          name: "Target",
          value: targetSummary,
          inline: true,
        },
        {
          name: "Time left",
          value: `${warningMinutes} minute${warningMinutes === 1 ? "" : "s"}`,
          inline: true,
        },
        {
          name: pendingRestartAction === "stop" ? "Stops" : "Restarts",
          value: (relative ? `${timestamp} (${relative})` : timestamp).slice(0, 1024),
          inline: true,
        },
        {
          name: "Reason",
          value: publicReason.slice(0, 1024),
          inline: false,
        },
      ],
    });
  } catch (error) {
    await clearMaintenanceAnnouncementClaim(discordAnnouncementKey).catch(() => undefined);
    lastAction = error instanceof Error ? `Discord maintenance warning failed: ${error.message}` : "Discord maintenance warning failed.";
    throw error;
  }
}

async function scheduleMaintenanceWarnings(config: AppConfig, delayMs: number) {
  const warningMinutes = getPendingMaintenanceWarningMinutes()
    .filter((minutes) => minutes * 60 * 1000 <= delayMs + SCHEDULER_TICK_MS + 1_000)
    .sort((left, right) => right - left);
  const mentionWarningMinutes = warningMinutes[0] ?? 0;

  for (const minutes of warningMinutes) {
    const warningDelayMs = Math.max(0, delayMs - minutes * 60 * 1000);
    if (warningDelayMs <= 1_000) {
      await announceMaintenanceWarning(config, minutes, mentionWarningMinutes).catch(() => undefined);
      continue;
    }

    const timer = setTimeout(() => {
      void announceMaintenanceWarning(config, minutes, mentionWarningMinutes).catch(() => undefined);
    }, warningDelayMs);
    pendingRestartWarningTimers.push(timer);
  }
}

async function announceBridgeMaintenanceNow(
  action: "restart" | "stop",
  source: "scheduled" | "mod-update" | "game-update" | "maintenance-stop",
  targetSummary: string,
  publicReason: string,
) {
  await queueGameMessage({
    type: action === "restart" ? "restart-now" : "maintenance",
    source: source === "mod-update" ? "mod-update" : source === "game-update" ? "game-update" : "scheduler",
    severity: action === "restart" ? "danger" : "warning",
    title: action === "restart" ? "Restarting now" : "Stopping now",
    message:
      source === "maintenance-stop"
        ? `Server restarting now for a ${publicReason}`
        : `Server restarting now for a ${publicReason}`,
    durationSeconds: 20,
    countdownSeconds: 0,
    expiresInSeconds: 10 * 60,
    dedupeKey: `maintenance-now:${source}:${action}:${targetSummary}:${publicReason}`,
  });
}

async function announceMaintenanceExecutionResult(
  config: AppConfig,
  options: {
    action: "restart" | "stop";
    source: "scheduled" | "mod-update" | "game-update" | "maintenance-stop";
    targetSummary: string;
    publicReason: string;
    completedAt: string;
    restartedLabels?: string[];
    failedRestarts?: string[];
    fatalError?: string | null;
  },
) {
  const webhookUrl = config.operationsSettings.discordUpdateWebhookUrl.trim();
  if (!webhookUrl) {
    return;
  }

  const announcementKey = buildMaintenanceFinishedAnnouncementKey(options);
  if (await shouldSuppressMaintenanceAnnouncement(announcementKey)) {
    return;
  }
  await recordMaintenanceAnnouncement(announcementKey).catch(() => undefined);

  const timestamp = toDiscordTimestamp(options.completedAt, "F") ?? options.completedAt;
  const relative = toDiscordTimestamp(options.completedAt, "R");
  const completedText = relative ? `${timestamp} (${relative})` : timestamp;
  const failedRestarts = options.failedRestarts ?? [];
  const restartedLabels = options.restartedLabels ?? [];

  let title = "Scheduled restart finished";
  let description = "Tiles finished the scheduled restart.";

  if (options.source === "mod-update") {
    title = "Mod update restart finished";
    description = "Tiles finished restarting after the mod update.";
  } else if (options.source === "game-update") {
    title = "Server update restart finished";
    description = "Tiles finished restarting after the server update.";
  } else if (options.source === "maintenance-stop") {
    title = "Maintenance shutdown finished";
    description = "Tiles finished stopping for maintenance.";
  }

  if (options.fatalError) {
    description =
      options.action === "stop"
        ? "Tiles did not complete the requested maintenance shutdown."
        : "Tiles did not complete the requested restart.";
  } else if (failedRestarts.length) {
    description = "Tiles attempted the restart, but some hosts still need attention.";
  }

  const fields: DiscordField[] = [
    {
      name: "Target",
      value: options.targetSummary.slice(0, 1024),
      inline: true,
    },
    {
      name: options.action === "stop" ? "Stopped" : "Completed",
      value: completedText.slice(0, 1024),
      inline: true,
    },
    {
      name: "Reason",
      value: options.publicReason.slice(0, 1024),
      inline: false,
    },
  ];

  if (options.fatalError) {
    fields.push({
      name: "Result",
      value: options.fatalError.slice(0, 1024),
      inline: false,
    });
  } else if (failedRestarts.length) {
    fields.push({
      name: "Result",
      value: `Restarted: ${restartedLabels.length ? formatProfileLabelSummary(restartedLabels) : "none"}\nStill failing: ${failedRestarts[0]}`.slice(0, 1024),
      inline: false,
    });
  } else if (options.action === "restart") {
    fields.push({
      name: "Result",
      value: `Restarted: ${restartedLabels.length ? formatProfileLabelSummary(restartedLabels) : options.targetSummary}`.slice(0, 1024),
      inline: false,
    });
  }

  await postDiscordWebhook(webhookUrl, {
    title,
    description,
    color: options.fatalError ? 0xdf6748 : failedRestarts.length ? 0xf2a44a : 0x8fc77c,
    dedupeKey: `maintenance-finished:${announcementKey}`,
    dedupeWindowMs: MAINTENANCE_ANNOUNCEMENT_DEDUPE_WINDOW_MS,
    fields,
  });
}

function getDesiredRunningProfiles(config: AppConfig) {
  return config.profiles.filter((profile) => desiredRunningProfileIds.has(profile.id));
}

function dedupeProfiles(profiles: AppConfig["profiles"]) {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    if (seen.has(profile.id)) {
      return false;
    }

    seen.add(profile.id);
    return true;
  });
}

function orderProfiles(profiles: AppConfig["profiles"]) {
  return [...profiles].sort((left, right) => left.launch.port - right.launch.port || left.name.localeCompare(right.name));
}

function parseProcessHints(commandLine: string | null | undefined) {
  const normalizedCommandLine = commandLine ?? "";
  const queryPortMatch = normalizedCommandLine.match(/-QueryPort=(\d+)/i);
  const gamePortMatch = normalizedCommandLine.match(/-port=(\d+)/i);
  const identifierMatch = normalizedCommandLine.match(/-identifier=([^\s"]+)/i);

  return {
    identifier: identifierMatch?.[1]?.toLowerCase() ?? null,
    gamePort: gamePortMatch ? Number.parseInt(gamePortMatch[1], 10) : null,
    queryPort: queryPortMatch ? Number.parseInt(queryPortMatch[1], 10) : null,
  };
}

function getMyRealmSessionCacheKey(config: AppConfig) {
  return `${config.myRealmFlow?.customerId ?? "none"}:${config.myRealmFlow?.realmId ?? "none"}`;
}

function hasReusableMyRealmRoute(config: AppConfig) {
  return Boolean(
    config.myRealmFlow?.dashboardUrl ||
      config.myRealmFlow?.realmUrl ||
      config.myRealmFlow?.mapUrl ||
      config.myRealmFlow?.apiUrl ||
      (config.myRealmFlow?.recentTileUrls?.length ?? 0) > 0,
  );
}

async function ensureMyRealmFlowResolved(config: AppConfig) {
  const needsDiscovery =
    !config.myRealmFlow?.customerId ||
    !config.myRealmFlow?.realmId ||
    !hasReusableMyRealmRoute(config);

  if (!needsDiscovery) {
    return config;
  }

  try {
    const discoveredFlow = await inspectMyRealmFlow();
    if (JSON.stringify(discoveredFlow ?? null) === JSON.stringify(config.myRealmFlow ?? null)) {
      return config;
    }

    const nextConfig = {
      ...config,
      myRealmFlow: discoveredFlow,
    };
    const saved = await saveConfig(nextConfig).catch(() => nextConfig);
    if (activeConfig && activeConfig === config) {
      activeConfig = saved;
    }
    return saved;
  } catch {
    return config;
  }
}

async function loadCachedMyRealmSession(config: AppConfig) {
  const resolvedConfig = await ensureMyRealmFlowResolved(config);
  if (!resolvedConfig.myRealmFlow?.customerId || !resolvedConfig.myRealmFlow?.realmId || !hasReusableMyRealmRoute(resolvedConfig)) {
    return null;
  }

  const key = getMyRealmSessionCacheKey(resolvedConfig);
  if (myRealmSessionCache && myRealmSessionCache.key === key && Date.now() - myRealmSessionCache.fetchedAt < MYREALM_SESSION_CACHE_TTL_MS) {
    return myRealmSessionCache.session;
  }

  try {
    const allowLaunch = Date.now() - lastMyRealmAutoConnectAttemptAt >= MYREALM_AUTOCONNECT_COOLDOWN_MS;
    if (allowLaunch) {
      lastMyRealmAutoConnectAttemptAt = Date.now();
    }
    const session = await loadMyRealmSessionSnapshot(resolvedConfig.myRealmFlow, { allowLaunch });
    myRealmSessionCache = {
      key,
      fetchedAt: Date.now(),
      session,
    };
    return session;
  } catch {
    return myRealmSessionCache?.key === key ? myRealmSessionCache.session : null;
  }
}

function normalizeLooseMapName(value: string | null | undefined) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getHostedMyRealmTiles(session: MyRealmSessionSnapshot | null) {
  return (session?.tiles ?? []).filter((tile) => tile.isActive || tile.isPendingInactive);
}

function getHostedMyRealmLabel(tile: MyRealmTileSummary) {
  return tile.hostingStatusText?.split(":")[0]?.trim() || "Unknown host";
}

function getHostedMyRealmStatus(tile: MyRealmTileSummary) {
  return tile.isPendingInactive ? "burning" : tile.isActive ? "running" : tile.statusText ?? "inactive";
}

function getLiveServerKey(server: LiveServerSummary) {
  return server.identifier ?? `pid-${server.processId ?? "none"}`;
}

function scoreMyRealmTileMatch(server: LiveServerSummary, tile: MyRealmTileSummary) {
  let score = 0;
  const identifier = server.identifier?.toLowerCase() ?? "";
  const hostingStatusText = tile.hostingStatusText?.toLowerCase() ?? "";
  if (identifier && hostingStatusText.includes(identifier)) {
    score += 100;
  }

  const serverMap = normalizeLooseMapName(server.map ?? server.serverName);
  const tileMap = normalizeLooseMapName(tile.mapName);
  if (serverMap && tileMap) {
    if (serverMap === tileMap) {
      score += 40;
    } else if (serverMap.startsWith(tileMap) || tileMap.startsWith(serverMap)) {
      score += 30;
    } else if (serverMap.includes(tileMap) || tileMap.includes(serverMap)) {
      score += 20;
    } else {
      const tileFirstWord = normalizeLooseMapName(tile.mapName?.split(/\s+/)[0] ?? "");
      if (tileFirstWord && serverMap.includes(tileFirstWord)) {
        score += 10;
      }
    }
  }

  if (server.playerCount > 0 && tile.playerCount === server.playerCount) {
    score += 5;
  }

  if (tile.isActive) {
    score += 3;
  }

  if (tile.isPendingActive) {
    score += 1;
  }

  return score;
}

function buildMyRealmTileAssignments(liveServers: LiveServerSummary[], session: MyRealmSessionSnapshot | null) {
  const hostedTiles = getHostedMyRealmTiles(session);
  if (!hostedTiles.length) {
    return new Map<string, MyRealmTileSummary>();
  }

  const rankedPairs = liveServers
    .flatMap((server) =>
      hostedTiles.map((tile) => ({
        server,
        tile,
        score: scoreMyRealmTileMatch(server, tile),
      })),
    )
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      return (left.server.gamePort ?? 0) - (right.server.gamePort ?? 0);
    });

  const assignedServers = new Set<string>();
  const assignedTiles = new Set<number>();
  const assignments = new Map<string, MyRealmTileSummary>();

  for (const entry of rankedPairs) {
    const serverKey = getLiveServerKey(entry.server);
    if (assignedServers.has(serverKey) || assignedTiles.has(entry.tile.tileId)) {
      continue;
    }

    assignedServers.add(serverKey);
    assignedTiles.add(entry.tile.tileId);
    assignments.set(serverKey, entry.tile);
  }

  return assignments;
}

function resolveMyRealmTileForServer(
  server: LiveServerSummary,
  session: MyRealmSessionSnapshot | null,
  assignments?: Map<string, MyRealmTileSummary>,
) {
  const assignedTile = assignments?.get(getLiveServerKey(server));
  if (assignedTile) {
    return assignedTile;
  }

  const ranked = getHostedMyRealmTiles(session)
    .map((tile) => ({
      tile,
      score: scoreMyRealmTileMatch(server, tile),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.tile.tileName.localeCompare(right.tile.tileName));

  return ranked[0]?.tile ?? null;
}

function profileMatchesProcessHints(profile: AppConfig["profiles"][number], hints: ReturnType<typeof parseProcessHints>) {
  const identifierMatches = hints.identifier !== null && profile.launch.identifier.toLowerCase() === hints.identifier;
  const gamePortMatches = hints.gamePort !== null && profile.launch.port === hints.gamePort;
  const queryPortMatches =
    hints.queryPort !== null && profile.launch.queryPort !== null && profile.launch.queryPort === hints.queryPort;

  return identifierMatches || gamePortMatches || queryPortMatches;
}

function matchRunningProfileIds(config: AppConfig, runningProcesses: Awaited<ReturnType<typeof listServerProcesses>>) {
  const matches = new Set<string>();

  for (const processInfo of runningProcesses) {
    const hints = parseProcessHints(processInfo.commandLine);
    const profile = config.profiles.find((candidate) => profileMatchesProcessHints(candidate, hints));

    if (profile) {
      matches.add(profile.id);
    }
  }

  return matches;
}

function formatLiveServerLabel(
  server: LiveServerSummary,
  myRealmSession: MyRealmSessionSnapshot | null = null,
  assignments?: Map<string, MyRealmTileSummary>,
) {
  const myRealmTile = resolveMyRealmTileForServer(server, myRealmSession, assignments);
  return myRealmTile?.tileName ?? server.map ?? server.serverName ?? server.identifier ?? "Unknown tile";
}

function getHostedTileLabel(
  server: LiveServerSummary,
  myRealmSession: MyRealmSessionSnapshot | null = null,
  assignments?: Map<string, MyRealmTileSummary>,
) {
  const myRealmTile = resolveMyRealmTileForServer(server, myRealmSession, assignments);
  if (myRealmTile?.tileName?.trim()) {
    return myRealmTile.tileName.trim();
  }

  const candidates = [server.map, server.serverName];
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized && !/^empty$/i.test(normalized)) {
      return normalized;
    }
  }

  return null;
}

function findLiveServerForProfile(profile: AppConfig["profiles"][number], liveServers: LiveServerSummary[]) {
  return liveServers.find((server) => {
    const identifierMatches =
      Boolean(server.identifier) && server.identifier!.toLowerCase() === profile.launch.identifier.toLowerCase();
    const gamePortMatches = server.gamePort !== null && server.gamePort === profile.launch.port;
    const queryPortMatches =
      server.queryPort !== null && profile.launch.queryPort !== null && server.queryPort === profile.launch.queryPort;

    return identifierMatches || gamePortMatches || queryPortMatches;
  });
}

function getProfileDisplayLabel(
  profile: AppConfig["profiles"][number],
  liveServers: LiveServerSummary[],
  myRealmSession: MyRealmSessionSnapshot | null = null,
) {
  const liveServer = findLiveServerForProfile(profile, liveServers);
  return liveServer ? formatLiveServerLabel(liveServer, myRealmSession) : profile.launch.identifier || profile.name;
}

async function resolveProfileDisplayLabels(config: AppConfig, profiles: AppConfig["profiles"]) {
  if (!profiles.length) {
    return [] as string[];
  }

  const runningProcesses = await listServerProcesses().catch(() => []);
  const liveServers = await collectLiveServers(config, runningProcesses).catch(() => []);
  const myRealmSession = await loadCachedMyRealmSession(config);
  const labels = profiles.map((profile) => getProfileDisplayLabel(profile, liveServers, myRealmSession));
  return [...new Set(labels)];
}

function formatProfileLabelSummary(labels: string[]) {
  if (!labels.length) {
    return "realm hosts";
  }

  if (labels.length <= 3) {
    return labels.join(", ");
  }

  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3} more`;
}

function buildPlayerCounterDigest(myRealmSession: MyRealmSessionSnapshot | null) {
  const hostedTiles = getHostedMyRealmTiles(myRealmSession);
  if (!myRealmSession) {
    return "";
  }

  return hostedTiles
    .map((tile) => `${tile.tileId}:${tile.tileName}:${tile.playerCount ?? 0}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

function toDiscordFields(lines: string[]) {
  return lines.slice(0, 8).map((line) => {
    const keyValueMatch = line.match(/^(?<name>[^:]{1,80}):\s*(?<value>.+)$/);
    if (keyValueMatch?.groups?.name && keyValueMatch?.groups?.value) {
      return {
        name: keyValueMatch.groups.name.trim().slice(0, 256),
        value: keyValueMatch.groups.value.trim().slice(0, 1024),
        inline: true,
      };
    }

    return {
      name: "Details",
      value: line.slice(0, 1024),
      inline: false,
    };
  });
}

function resolveMyRealmActivityWebhookUrl(config: AppConfig) {
  return (
    config.operationsSettings.discordMyRealmWebhookUrl?.trim() ||
    config.operationsSettings.discordTileOnlineWebhookUrl?.trim() ||
    config.operationsSettings.discordPlayerCounterWebhookUrl?.trim() ||
    ""
  );
}

function resolvePlayerCounterWebhookUrl(config: AppConfig) {
  return (
    config.operationsSettings.discordPlayerCounterWebhookUrl?.trim() ||
    config.operationsSettings.discordMyRealmWebhookUrl?.trim() ||
    config.operationsSettings.discordTileOnlineWebhookUrl?.trim() ||
    ""
  );
}

function buildPlayerCounterFields(myRealmSession: MyRealmSessionSnapshot | null) {
  const hostedTiles = getHostedMyRealmTiles(myRealmSession);
  if (!myRealmSession) {
    return [];
  }

  return hostedTiles.slice(0, 12).map((tile) => ({
      name: tile.tileName.slice(0, 256),
      value: [
        `Players: ${tile.playerCount ?? 0}`,
        `Status: ${getHostedMyRealmStatus(tile)}`,
      ].join("\n").slice(0, 1024),
      inline: false,
    }));
}

function hashWebhookValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function buildDiscordWebhookFingerprint(url: string, options: DiscordWebhookOptions) {
  const normalizedFields = (options.fields ?? []).map((field) => ({
    name: field.name,
    value: field.value,
    inline: Boolean(field.inline),
  }));
  const payloadKey =
    options.dedupeKey?.trim() ||
    JSON.stringify({
      title: options.title,
      description: options.description ?? "",
      content: options.content ?? "",
      color: options.color,
      fields: normalizedFields,
      allowEveryone: Boolean(options.allowEveryone),
      allowedRoleIds: options.allowedRoleIds?.slice().sort() ?? [],
    });

  return hashWebhookValue(`${url.trim()}|${payloadKey}`);
}

async function readDiscordWebhookClaimTime(filePath: string) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { claimedAt?: string; sentAt?: string };
    const timestamp = Date.parse(parsed.sentAt ?? parsed.claimedAt ?? "");
    return Number.isFinite(timestamp) ? timestamp : 0;
  } catch {
    return 0;
  }
}

async function claimDiscordWebhookSend(url: string, options: DiscordWebhookOptions) {
  const windowMs = Math.max(1_000, options.dedupeWindowMs ?? DISCORD_WEBHOOK_DEDUPE_WINDOW_MS);
  const fingerprint = buildDiscordWebhookFingerprint(url, options);
  const filePath = path.join(discordWebhookDedupeDirectory, `${fingerprint}.json`);
  await fs.mkdir(discordWebhookDedupeDirectory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(filePath, "wx");
      await handle.writeFile(
        JSON.stringify(
          {
            claimedAt: new Date().toISOString(),
            title: options.title,
          },
          null,
          2,
        ),
        "utf8",
      );
      await handle.close();
      return {
        claimed: true,
        filePath,
      };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
      if (code !== "EEXIST") {
        throw error;
      }

      const claimedAt = await readDiscordWebhookClaimTime(filePath);
      if (claimedAt && Date.now() - claimedAt < windowMs) {
        return {
          claimed: false,
          filePath,
        };
      }

      await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  return {
    claimed: false,
    filePath,
  };
}

async function markDiscordWebhookSent(filePath: string, options: DiscordWebhookOptions) {
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        claimedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        title: options.title,
      },
      null,
      2,
    ),
    "utf8",
  ).catch(() => undefined);
}

async function releaseDiscordWebhookClaim(filePath: string) {
  await fs.rm(filePath, { force: true }).catch(() => undefined);
}

async function postDiscordWebhook(url: string, options: DiscordWebhookOptions) {
  if (!url.trim()) {
    return false;
  }

  const claim = await claimDiscordWebhookSend(url, options);
  if (!claim.claimed) {
    return false;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "Last Oasis Manager",
        content: options.content?.slice(0, 2000) || undefined,
        allowed_mentions: options.allowEveryone
          ? {
              parse: ["everyone"],
              roles: options.allowedRoleIds?.slice(0, 100),
            }
          : {
              parse: [],
              roles: options.allowedRoleIds?.slice(0, 100),
            },
        embeds: [
          {
            title: options.title.slice(0, 256),
            description: options.description?.slice(0, 4000) || undefined,
            color: options.color,
            fields: options.fields?.slice(0, 25),
            footer: {
              text: "Last Oasis Manager",
            },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook failed with status ${response.status}.`);
    }

    await markDiscordWebhookSent(claim.filePath, options);
    lastWebhookTitle = options.title;
    lastWebhookAt = new Date().toISOString();
    return true;
  } catch (error) {
    await releaseDiscordWebhookClaim(claim.filePath);
    throw error;
  }
}

async function announceUpdate(config: AppConfig, title: string, lines: string[]) {
  if (!config.operationsSettings.discordUpdateWebhookUrl.trim()) {
    return;
  }

  const color = /failed/i.test(title) ? 0xdf6748 : /finished/i.test(title) ? 0x8fc77c : 0xf2a44a;
  await postDiscordWebhook(config.operationsSettings.discordUpdateWebhookUrl, {
    title,
    description: lines[0],
    color,
    dedupeKey: `update:${title}:${lines.join("|")}`,
    dedupeWindowMs: 10 * 60 * 1000,
    fields: toDiscordFields(lines.slice(1)),
  });
}

async function announceTileOnline(config: AppConfig, title: string, lines: string[]) {
  const webhookUrl = resolveMyRealmActivityWebhookUrl(config);
  if (!webhookUrl) {
    return;
  }

  const color = /offline/i.test(title) ? 0xdf6748 : /restarted/i.test(title) ? 0x8fc77c : 0x4ea1ff;
  await postDiscordWebhook(webhookUrl, {
    title,
    color,
    dedupeKey: `tile-status:${title}:${lines.join("|")}`,
    dedupeWindowMs: 5 * 60 * 1000,
    fields: toDiscordFields(lines),
  });
}

function toDiscordTimestamp(value: string | null, style: "F" | "R") {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return `<t:${Math.floor(timestamp / 1000)}:${style}>`;
}

export async function announceEventTileCreated(
  config: AppConfig,
  cycle: EventTileCycleState,
  tiles: Array<{
    tileName: string;
    mapName: string | null;
    quality: number | null;
    activationAt: string | null;
    deactivationAt: string | null;
  }>,
) {
  if (!config.operationsSettings.discordEventTileWebhookUrl.trim() || !tiles.length) {
    return;
  }

  const fields = tiles.slice(0, 8).map((tile) => ({
    name: tile.tileName.slice(0, 256),
    value: [
      `Map: ${tile.mapName || "Unknown"}`,
      `Quality: ${tile.quality ?? "Unknown"}`,
      `Activates: ${
        toDiscordTimestamp(tile.activationAt, "F")
          ? `${toDiscordTimestamp(tile.activationAt, "F")} (${toDiscordTimestamp(tile.activationAt, "R")})`
          : "Now"
      }`,
      `Deactivates: ${
        toDiscordTimestamp(tile.deactivationAt, "F")
          ? `${toDiscordTimestamp(tile.deactivationAt, "F")} (${toDiscordTimestamp(tile.deactivationAt, "R")})`
          : "Unknown"
      }`,
    ].join("\n").slice(0, 1024),
    inline: false,
  }));

  await postDiscordWebhook(config.operationsSettings.discordEventTileWebhookUrl, {
    title: "Event tiles created",
    description: `${tiles.length} tile(s) were created by ${cycle.name}.`,
    color: 0xd8a45d,
    dedupeKey: `event-tiles-created:${cycle.id}:${tiles.map((tile) => tile.tileName).join("|")}`,
    dedupeWindowMs: 30 * 60 * 1000,
    fields,
  });
}

function buildCreatedEventTilesForWebhook(
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
  tiles: MyRealmTileSummary[],
) {
  const createdTiles = result.createdTiles ?? [];
  if (createdTiles.length) {
    return createdTiles.map((tile) => ({
      tileName: tile.tileName,
      mapName: tile.mapName,
      quality: tile.quality,
      activationAt: tile.activationAt ?? result.activationAt ?? null,
      deactivationAt: tile.deactivationAt ?? result.deactivationAt ?? null,
    }));
  }

  const createdTileIds = result.createdTileIds ?? [];
  if (!createdTileIds.length) {
    return [];
  }

  const byId = new Map(tiles.map((tile) => [tile.tileId, tile]));
  return createdTileIds
    .map((tileId) => byId.get(tileId))
    .filter((tile): tile is MyRealmTileSummary => Boolean(tile))
    .map((tile) => ({
      tileName: tile.tileName,
      mapName: tile.mapName,
      quality: tile.quality,
      activationAt: result.activationAt ?? tile.activationDate ?? null,
      deactivationAt: result.deactivationAt ?? tile.deactivationDate ?? null,
    }));
}

async function announcePlayerCounters(
  config: AppConfig,
  myRealmSession: MyRealmSessionSnapshot | null,
) {
  const webhookUrl = resolvePlayerCounterWebhookUrl(config);
  if (!webhookUrl) {
    return;
  }

  const fields = buildPlayerCounterFields(myRealmSession);
  if (!fields.length) {
    return;
  }

  await postDiscordWebhook(
    webhookUrl,
    {
      title: "Live Player Feed",
      color: 0x4ea1ff,
      dedupeKey: "player-counter-feed",
      dedupeWindowMs: PLAYER_COUNTER_WEBHOOK_MIN_INTERVAL_MS,
      fields,
    },
  );
}

async function resolveRestartTargets(config: AppConfig, preferredProfile?: AppConfig["profiles"][number] | null) {
  const desiredProfiles = getDesiredRunningProfiles(config);
  if (desiredProfiles.length) {
    return orderProfiles(dedupeProfiles(desiredProfiles));
  }

  const runningProcesses = await listServerProcesses();
  const runningProfileIds = matchRunningProfileIds(config, runningProcesses);
  const runningProfiles = config.profiles.filter((profile) => runningProfileIds.has(profile.id));
  if (runningProfiles.length) {
    return orderProfiles(dedupeProfiles(runningProfiles));
  }

  return preferredProfile ? [preferredProfile] : getPrimaryProfile(config) ? [getPrimaryProfile(config)!] : [];
}

async function resolveRunningHostPoolTargets(config: AppConfig) {
  const runningProcesses = await listServerProcesses();
  const runningProfileIds = matchRunningProfileIds(config, runningProcesses);
  const runningProfiles = config.profiles.filter((profile) => runningProfileIds.has(profile.id));
  if (runningProfiles.length) {
    return orderProfiles(dedupeProfiles(runningProfiles));
  }

  const desiredProfiles = getDesiredRunningProfiles(config);
  if (desiredProfiles.length) {
    return orderProfiles(dedupeProfiles(desiredProfiles));
  }

  return [] as AppConfig["profiles"];
}

function resolveRunningConfiguredHostTargets(config: AppConfig, runningProcesses: Awaited<ReturnType<typeof listServerProcesses>>) {
  const runningProfileIds = matchRunningProfileIds(config, runningProcesses);
  const runningProfiles = config.profiles.filter((profile) => runningProfileIds.has(profile.id));
  return orderProfiles(dedupeProfiles(runningProfiles));
}

async function stopMaintenanceTargetProcesses(config: AppConfig, profiles: AppConfig["profiles"]) {
  const runningProcesses = await listServerProcesses();
  const targetPids = runningProcesses
    .filter((processInfo) => {
      const hints = parseProcessHints(processInfo.commandLine);
      return profiles.some((profile) => profileMatchesProcessHints(profile, hints));
    })
    .map((processInfo) => processInfo.pid);

  if (!targetPids.length) {
    if (runningProcesses.length) {
      throw new Error("No running Last Oasis process matched the queued maintenance targets, so the manager refused to stop unrelated hosts.");
    }

    return;
  }

  for (const targetPid of targetPids) {
    await stopServer(targetPid, false);
  }
}

async function runPendingMaintenanceTargets(config: AppConfig, profiles: AppConfig["profiles"], reason: string) {
  const latestConfig = await loadConfig().catch(() => config);
  const pendingActionSnapshot = pendingRestartAction;
  const pendingSourceSnapshot = pendingRestartSource;
  const pendingPublicReasonSnapshot = pendingRestartPublicReason || pendingRestartReason;
  const pendingWorkSnapshot = pendingRestartWork ? { ...pendingRestartWork } : null;
  const orderedProfiles = orderProfiles(dedupeProfiles(profiles));
  const effectiveProfiles = orderProfiles(
    dedupeProfiles(
      orderedProfiles.map((profile) => latestConfig.profiles.find((entry) => entry.id === profile.id) ?? profile),
    ),
  );
  const profileLabels = await resolveProfileDisplayLabels(latestConfig, effectiveProfiles).catch(() =>
    effectiveProfiles.map((profile) => profile.launch.identifier || profile.name),
  );
  const targetSummary = formatProfileLabelSummary(profileLabels);
  busy = true;
  lastAction = reason;

  try {
    await announceBridgeMaintenanceNow(
      pendingActionSnapshot,
      pendingSourceSnapshot,
      targetSummary,
      pendingPublicReasonSnapshot,
    ).catch(() => undefined);
    await stopMaintenanceTargetProcesses(latestConfig, effectiveProfiles);
    if (pendingWorkSnapshot) {
      pendingRestartWork = pendingWorkSnapshot;
      try {
        await executePendingRestartWork(latestConfig);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The queued maintenance work failed.";
        const kind = pendingWorkSnapshot.kind === "game-update" ? "game" : "mods";
        await sendUpdateLifecycleNotification(latestConfig, kind, "failed", [message]).catch(() => undefined);
        lastAction = `Maintenance work failed before restart: ${message}`;
      }
    }

    if (pendingActionSnapshot === "restart") {
      markDesiredProfiles(effectiveProfiles.map((profile) => profile.id));
      const restartedLabels: string[] = [];
      const failedRestarts: string[] = [];

      for (let index = 0; index < effectiveProfiles.length; index += 1) {
        const profile = effectiveProfiles[index];
        const profileLabel = profileLabels[index] ?? (profile.launch.identifier || profile.name);

        try {
          await startServer(profile, {
            activeModIds: latestConfig.operationsSettings.modIds,
          });
          restartedLabels.push(profileLabel);
        } catch (error) {
          const failureMessage = error instanceof Error ? error.message : "Unknown launch error.";
          failedRestarts.push(`${profileLabel}: ${failureMessage}`);
        }
      }

      if (!failedRestarts.length) {
        lastAction = `Restarted ${formatProfileLabelSummary(profileLabels)} at ${new Date().toLocaleString()}.`;
      } else if (restartedLabels.length) {
        lastAction = `Restarted ${formatProfileLabelSummary(restartedLabels)}. ${failedRestarts.length} host(s) failed to relaunch and will stay in the desired pool for automatic retry. First failure: ${failedRestarts[0]}`;
      } else {
        lastAction = `Scheduled restart stopped ${formatProfileLabelSummary(profileLabels)}, but none of the hosts relaunched successfully. Automatic retry remains armed. First failure: ${failedRestarts[0]}`;
      }

      await announceMaintenanceExecutionResult(latestConfig, {
        action: pendingActionSnapshot,
        source: pendingSourceSnapshot,
        targetSummary,
        publicReason: pendingPublicReasonSnapshot,
        completedAt: new Date().toISOString(),
        restartedLabels,
        failedRestarts,
      }).catch(() => undefined);
    } else {
      forgetDesiredProfiles(effectiveProfiles.map((profile) => profile.id));
      lastAction = `Stopped ${formatProfileLabelSummary(profileLabels)} for maintenance at ${new Date().toLocaleString()}.`;
      await announceMaintenanceExecutionResult(latestConfig, {
        action: pendingActionSnapshot,
        source: pendingSourceSnapshot,
        targetSummary,
        publicReason: pendingPublicReasonSnapshot,
        completedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
  } catch (error) {
    const failureLabel = pendingActionSnapshot === "restart" ? "Scheduled restart failed" : "Scheduled stop failed";
    lastAction = error instanceof Error ? `${failureLabel}: ${error.message}` : `${failureLabel}.`;
    await announceMaintenanceExecutionResult(latestConfig, {
      action: pendingActionSnapshot,
      source: pendingSourceSnapshot,
      targetSummary,
      publicReason: pendingPublicReasonSnapshot,
      completedAt: new Date().toISOString(),
      fatalError: error instanceof Error ? error.message : failureLabel,
    }).catch(() => undefined);
  } finally {
    busy = false;
    clearPendingRestart();
  }
}

async function scheduleMaintenanceTargets(
  config: AppConfig,
  profiles: AppConfig["profiles"],
  delayMinutes: number,
  reason: string,
  options?: {
    action?: "restart" | "stop";
    source?: "scheduled" | "mod-update" | "game-update" | "maintenance-stop";
    mentionEveryone?: boolean;
    publicReason?: string;
    pendingWork?: null | { kind: "mods-update"; modIds: string[] } | { kind: "game-update" };
  },
) {
  if (!profiles.length) {
    return;
  }

  const orderedProfiles = orderProfiles(dedupeProfiles(profiles));
  const labels = await resolveProfileDisplayLabels(config, orderedProfiles).catch(() =>
    orderedProfiles.map((profile) => profile.launch.identifier || profile.name),
  );
  const label = formatProfileLabelSummary(labels);

  clearPendingRestart();

  const clampedDelayMinutes = Math.max(0, delayMinutes);
  const delayMs = clampedDelayMinutes * 60 * 1000;
  pendingRestartProfileIds = orderedProfiles.map((profile) => profile.id);
  pendingRestartProfileName = label;
  pendingRestartReason = reason;
  pendingRestartPublicReason = options?.publicReason?.trim() || reason;
  pendingRestartAction = options?.action ?? "restart";
  pendingRestartSource = options?.source ?? "scheduled";
  pendingRestartMentionEveryone = options?.mentionEveryone ?? false;
  pendingRestartWork = options?.pendingWork ?? null;
  pendingRestartAt = new Date(Date.now() + delayMs).toISOString();

  if (pendingRestartAction === "restart" && (pendingRestartSource === "mod-update" || pendingRestartSource === "game-update")) {
    await markNextScheduledRestartCovered(config, orderedProfiles).catch(() => undefined);
  }

  if (delayMs === 0) {
    void runPendingMaintenanceTargets(config, orderedProfiles, reason);
    return;
  }

  const actionLabel = pendingRestartAction === "restart" ? "restart" : "maintenance stop";
  lastAction = `${reason} ${actionLabel} queued for ${label} at ${new Date(pendingRestartAt).toLocaleString()}.`;
  await scheduleMaintenanceWarnings(config, delayMs).catch(() => undefined);
  pendingRestartTimer = setTimeout(() => {
    void runPendingMaintenanceTargets(config, orderedProfiles, reason);
  }, delayMs);
}

async function notifyLiveServerChanges(config: AppConfig, liveServers: LiveServerSummary[], myRealmSession: MyRealmSessionSnapshot | null) {
  if (!myRealmSession) {
    return;
  }

  const hostedTiles = getHostedMyRealmTiles(myRealmSession);
  const currentOnlineTileIds = new Set(hostedTiles.map((tile) => tile.tileId));
  const currentHostedTilesById = new Map(
    hostedTiles.map((tile) => [
      tile.tileId,
      {
        tileId: tile.tileId,
        tileName: tile.tileName,
        mapName: tile.mapName,
        hostLabel: getHostedMyRealmLabel(tile),
        playerCount: tile.playerCount,
        statusLabel: getHostedMyRealmStatus(tile),
      },
    ]),
  );

  if (!tileOnlineBaselineReady) {
    tileOnlineBaselineReady = true;
    lastOnlineTileIds = currentOnlineTileIds;
    lastHostedTilesById = currentHostedTilesById;
  } else {
    const offlineTiles = [...lastHostedTilesById.values()].filter((tile) => !currentOnlineTileIds.has(tile.tileId));
    for (const tile of offlineTiles) {
      await announceTileOnline(config, "Tile offline", [
        `Tile: ${tile.tileName}`,
        `Map: ${tile.mapName ?? "Unknown"}`,
        `Status: Inactive`,
      ]).catch(() => undefined);
    }

    const newTiles = hostedTiles.filter((tile) => !lastOnlineTileIds.has(tile.tileId));

    for (const tile of newTiles) {
      await announceTileOnline(config, "Tile online", [
        `Tile: ${tile.tileName}`,
        `Map: ${tile.mapName ?? "Unknown"}`,
        `Players: ${tile.playerCount ?? 0}`,
        `Status: Active`,
      ]).catch(() => undefined);
    }

    lastOnlineTileIds = currentOnlineTileIds;
    lastHostedTilesById = currentHostedTilesById;
  }

  const nextDigest = buildPlayerCounterDigest(myRealmSession);
  if (!playerCounterBaselineReady) {
    playerCounterBaselineReady = true;
    lastPlayerCounterDigest = nextDigest;
    return;
  }

  const now = Date.now();
  if (nextDigest !== lastPlayerCounterDigest && now - lastPlayerCounterWebhookAt >= PLAYER_COUNTER_WEBHOOK_MIN_INTERVAL_MS) {
    await announcePlayerCounters(config, myRealmSession).catch(() => undefined);
    lastPlayerCounterDigest = nextDigest;
    lastPlayerCounterWebhookAt = now;
  }
}

async function evaluateDesiredProfiles(
  config: AppConfig,
  runningProcesses: Awaited<ReturnType<typeof listServerProcesses>>,
  liveServers: LiveServerSummary[],
) {
  if (!desiredRunningProfileIds.size && runningProcesses.length) {
    for (const profileId of matchRunningProfileIds(config, runningProcesses)) {
      desiredRunningProfileIds.add(profileId);
    }
  }

  if (!desiredRunningProfileIds.size) {
    missingProfileSince.clear();
    return;
  }

  const runningProfileIds = matchRunningProfileIds(config, runningProcesses);

  const now = Date.now();

  for (const profile of getDesiredRunningProfiles(config)) {
    const profileLabel = getProfileDisplayLabel(profile, liveServers);

    if (runningProfileIds.has(profile.id)) {
      missingProfileSince.delete(profile.id);
      continue;
    }

    const firstMissingAt = missingProfileSince.get(profile.id) ?? now;
    missingProfileSince.set(profile.id, firstMissingAt);

    const configuredGraceMs = Math.max(0, config.operationsSettings.offlineRestartGraceMinutes) * 60_000;
    const effectiveGraceMs = Math.max(DESIRED_PROFILE_STARTUP_GRACE_MS, configuredGraceMs);
    if (now - firstMissingAt < effectiveGraceMs) {
      continue;
    }

    const lastRestartAt = lastRestartAttemptAt.get(profile.id) ?? 0;
    const cooldownMs = DESIRED_PROFILE_RESTART_COOLDOWN_MS;
    if (now - lastRestartAt < cooldownMs || busy || pendingRestartTimer) {
      continue;
    }

    busy = true;
    lastRestartAttemptAt.set(profile.id, now);
    lastAction = `${profileLabel} appears offline. Trying an automatic restart.`;

    try {
      const started = await startServer(profile, {
        activeModIds: config.operationsSettings.modIds,
      });
      missingProfileSince.delete(profile.id);
      markDesiredProfiles([profile.id]);
      lastAction = `Automatically restarted ${profileLabel} on PID ${started.pid}.`;
    } catch (error) {
      lastAction = error instanceof Error ? `Automatic restart failed for ${profileLabel}: ${error.message}` : `Automatic restart failed for ${profileLabel}.`;
    } finally {
      busy = false;
    }
  }

  for (const profileId of [...missingProfileSince.keys()]) {
    if (!desiredRunningProfileIds.has(profileId)) {
      missingProfileSince.delete(profileId);
    }
  }
}

export function markDesiredProfiles(profileIds: string[]) {
  for (const profileId of profileIds) {
    if (profileId) {
      desiredRunningProfileIds.add(profileId);
    }
  }
}

export function cancelPendingMaintenance(message?: string) {
  clearPendingRestart();
  if (message) {
    lastAction = message;
  }
}

export function forgetDesiredProfiles(profileIds?: string[]) {
  if (!profileIds?.length) {
    desiredRunningProfileIds.clear();
    missingProfileSince.clear();
    lastRestartAttemptAt.clear();
    return;
  }

  for (const profileId of profileIds) {
    desiredRunningProfileIds.delete(profileId);
    missingProfileSince.delete(profileId);
    lastRestartAttemptAt.delete(profileId);
  }
}

export async function updateModsAndPlanRestart(config: AppConfig, requestedModIds?: string[]) {
  const profile = getPrimaryProfile(config);
  if (!profile) {
    throw new Error("No profile is available for a restart plan.");
  }

  const mods = await readMods(config);
  const selectedIds = requestedModIds?.length ? new Set(requestedModIds) : null;
  const targetModIds = mods
    .filter((mod) => (selectedIds ? selectedIds.has(mod.modId) : true))
    .filter(isManagedServerMod)
    .filter((mod) => mod.updateAvailable)
    .map((mod) => mod.modId);

  if (!targetModIds.length) {
    clearPendingModUpdateRestart();
    lastAction = "Checked workshop mods. Everything already looks current.";
    return {
      updatedIds: [],
      restartScheduled: false,
      restartAt: null,
      note: "No workshop or server mod updates were pending.",
    };
  }

  const processes = await listServerProcesses();
  let restartTargets: AppConfig["profiles"] = [];
  let restartTargetSummary = "";

  restartTargets = resolveRunningConfiguredHostTargets(config, processes);
  if (restartTargets.length) {
    const restartTargetLabels = await resolveProfileDisplayLabels(config, restartTargets).catch(() =>
      restartTargets.map((entry) => entry.launch.identifier || entry.name),
    );
    restartTargetSummary = formatProfileLabelSummary(restartTargetLabels);
    await scheduleMaintenanceTargets(
      config,
      restartTargets,
      UPDATE_RESTART_DELAY_MINUTES,
      `Restarting ${restartTargetSummary} after applying ${targetModIds.length} shared mod update(s).`,
      {
        action: "restart",
        source: "mod-update",
        mentionEveryone: true,
        publicReason: "Mod Update",
        pendingWork: {
          kind: "mods-update",
          modIds: targetModIds,
        },
      },
    );
    lastAction = `Queued ${targetModIds.length} mod update(s) for the next maintenance window so the server files can be updated while the hosts are stopped.`;
    return {
      updatedIds: targetModIds,
      restartScheduled: true,
      restartAt: pendingRestartAt,
      note: "Pending mod updates were queued for the next maintenance restart so locked server files can be updated safely.",
    };
  }

  const syncResult = await syncMods(config, true, targetModIds);
  const appliedIds = targetModIds.filter((modId) => syncResult.updated.includes(modId));
  if (!appliedIds.length) {
    const missingText = syncResult.missing.length ? ` Missing workshop files: ${syncResult.missing.join(", ")}.` : "";
    lastAction = `Checked workshop mods, but no new mod files were available to apply.${missingText}`.trim();
    return {
      updatedIds: [],
      restartScheduled: false,
      restartAt: null,
      note: `No new mod files were applied.${missingText}`.trim(),
    };
  }

  await announceUpdate(config, "Mod update applied", [
    `Applied ${appliedIds.length} workshop mod(s).`,
    syncResult.missing.length ? `Missing workshop files: ${syncResult.missing.join(", ")}.` : "Old server copies were replaced with the refreshed workshop files.",
  ]).catch(() => undefined);

  clearPendingRestart();
  lastAction = processes.length
    ? `Updated ${appliedIds.length} mod(s) while no configured realm host profiles were running. Unmatched Last Oasis processes were ignored.`
    : `Updated ${appliedIds.length} mod(s) while the server was offline.`;

  return {
    updatedIds: appliedIds,
    restartScheduled: false,
    restartAt: pendingRestartAt,
    note: processes.length
      ? "Mods were updated for the configured server path. Other running Last Oasis processes did not match the manager profiles and were not stopped."
      : "Mods were updated while the server was offline, so no restart was needed.",
  };
}

export async function reconcileModsAndPlanRestart(config: AppConfig) {
  const profile = getPrimaryProfile(config);
  if (!profile) {
    throw new Error("No profile is available for a mod sync plan.");
  }

  if (!config.operationsSettings.modIds.length) {
    clearPendingModUpdateRestart();
    lastAction = "No workshop mods are configured yet.";
    return {
      sync: {
        modsPath: "",
        synced: [] as string[],
        updated: [] as string[],
        missing: [] as string[],
        activated: [] as string[],
        deactivated: [] as string[],
        usedSteamCmd: false,
        mirroredToSteamWorkshop: false,
      },
      updatedIds: [] as string[],
      restartScheduled: false,
      restartAt: null as string | null,
      note: "No workshop mods are configured yet.",
    };
  }

  const modsBefore = await readMods(config);
  const pendingModIds = modsBefore.filter((mod) => isManagedServerMod(mod) && mod.updateAvailable).map((mod) => mod.modId);
  const processes = await listServerProcesses();

  const restartTargets = resolveRunningConfiguredHostTargets(config, processes);
  if (restartTargets.length) {
    if (!pendingModIds.length) {
      clearPendingModUpdateRestart();
      const note = "Workshop mods were already current. No restart was needed.";
      lastAction = note;
      return {
        sync: createEmptySyncResult(),
        updatedIds: [] as string[],
        restartScheduled: false,
        restartAt: null as string | null,
        note,
      };
    }

    const restartTargetLabels = await resolveProfileDisplayLabels(config, restartTargets).catch(() =>
      restartTargets.map((entry) => entry.launch.identifier || entry.name),
    );
    const restartTargetSummary = formatProfileLabelSummary(restartTargetLabels);

    await scheduleMaintenanceTargets(
      config,
      restartTargets,
      UPDATE_RESTART_DELAY_MINUTES,
      `Restarting ${restartTargetSummary} after applying ${pendingModIds.length} shared mod update(s).`,
      {
        action: "restart",
        source: "mod-update",
        mentionEveryone: true,
        publicReason: "Mod Update",
        pendingWork: {
          kind: "mods-update",
          modIds: pendingModIds,
        },
      },
    );
    lastAction = `Queued ${pendingModIds.length} pending mod change(s) for ${restartTargetSummary}.`;
    return {
      sync: createEmptySyncResult(),
      updatedIds: pendingModIds,
      restartScheduled: true,
      restartAt: pendingRestartAt,
      note: "Pending mod changes were queued for the next maintenance restart so locked server files can be updated safely.",
    };
  }

  const syncResult = await syncMods(config, true);
  const appliedPendingIds = pendingModIds.filter((modId) => syncResult.updated.includes(modId));

  if (!appliedPendingIds.length) {
    if (!pendingModIds.length) {
      clearPendingModUpdateRestart();
    }
    const note = pendingModIds.length
      ? `Pending mod changes were detected, but no new files were applied.${syncResult.missing.length ? ` Missing workshop files: ${syncResult.missing.join(", ")}.` : ""}`.trim()
      : "Workshop mods were already current. Server copies were refreshed and no restart was needed.";
    lastAction = note;
    return {
      sync: syncResult,
      updatedIds: [] as string[],
      restartScheduled: false,
      restartAt: null as string | null,
      note,
    };
  }

  await announceUpdate(config, "Mod update applied", [
    `Applied ${appliedPendingIds.length} workshop mod(s).`,
    syncResult.missing.length ? `Missing workshop files: ${syncResult.missing.join(", ")}.` : "Old server copies were replaced with the refreshed workshop files.",
  ]).catch(() => undefined);
  lastAction = processes.length
    ? `Applied ${appliedPendingIds.length} mod change(s) while no configured realm host profiles were running. Unmatched Last Oasis processes were ignored.`
    : `Applied ${appliedPendingIds.length} mod change(s) while the server was offline.`;

  return {
    sync: syncResult,
    updatedIds: appliedPendingIds,
    restartScheduled: false,
    restartAt: pendingRestartAt,
    note: processes.length
      ? "Pending mod changes were applied for the configured server path. Other running Last Oasis processes did not match the manager profiles and were not stopped."
      : "Pending mod changes were applied while the server was offline, so no restart was needed.",
  };
}

export async function planGameUpdateRestart(config: AppConfig) {
  const processes = await listServerProcesses();
  const restartTargets = resolveRunningConfiguredHostTargets(config, processes);
  if (!restartTargets.length) {
    clearPendingRestart();
    lastAction = processes.length
      ? "Server update can run immediately because no configured realm host profiles are running. Unmatched Last Oasis processes were ignored."
      : "Server update finished while the realm host pool was offline.";
    return {
      restartScheduled: false,
      restartAt: null as string | null,
      note: processes.length
        ? "No configured realm host profiles are running, so no restart is required for the server update. Other Last Oasis processes were not touched."
        : "The server was offline, so no restart was required after the server update.",
    };
  }

  const restartTargetLabels = await resolveProfileDisplayLabels(config, restartTargets).catch(() =>
    restartTargets.map((entry) => entry.launch.identifier || entry.name),
  );
  const restartTargetSummary = formatProfileLabelSummary(restartTargetLabels);

  await scheduleMaintenanceTargets(
    config,
    restartTargets,
    UPDATE_RESTART_DELAY_MINUTES,
    `Restarting ${restartTargetSummary} after applying a server update.`,
    {
      action: "restart",
      source: "game-update",
      mentionEveryone: true,
      publicReason: "Server Update",
      pendingWork: {
        kind: "game-update",
      },
    },
  );

  return {
    restartScheduled: true,
    restartAt: pendingRestartAt,
    note: `Server update queued for ${restartTargetSummary} in ${UPDATE_RESTART_DELAY_MINUTES} minute(s), and SteamCMD will run after the hosts are stopped.`,
  };
}

export async function planSafeStop(config: AppConfig, maintenanceReason: string) {
  const profile = getPrimaryProfile(config);
  if (!profile) {
    throw new Error("No profile is available for a maintenance-stop plan.");
  }

  const stopTargets = await resolveRestartTargets(config, profile);
  if (!stopTargets.length) {
    throw new Error("No running or desired realm hosts are available to stop safely.");
  }

  const targetLabels = await resolveProfileDisplayLabels(config, stopTargets).catch(() =>
    stopTargets.map((entry) => entry.launch.identifier || entry.name),
  );
  const targetSummary = formatProfileLabelSummary(targetLabels);

  await scheduleMaintenanceTargets(
    config,
    stopTargets,
    SAFE_STOP_DELAY_MINUTES,
    `Stopping ${targetSummary} for maintenance.`,
    {
      action: "stop",
      source: "maintenance-stop",
      mentionEveryone: true,
      publicReason: maintenanceReason,
    },
  );

  return {
    scheduled: true,
    stopAt: pendingRestartAt,
    targetSummary,
  };
}

async function evaluateModUpdates(config: AppConfig) {
  if (!config.operationsSettings.autoUpdateMods) {
    return;
  }

  const intervalMs = Math.max(5, config.operationsSettings.modUpdateCheckMinutes) * 60 * 1000;
  if (Date.now() < nextModCheckAt) {
    return;
  }

  nextModCheckAt = Date.now() + intervalMs;

  if (busy || pendingRestartTimer) {
    return;
  }

  try {
    const result = await updateModsAndPlanRestart(config);
    if (result.updatedIds.length) {
      const restartTargets = await resolveRunningHostPoolTargets(config);
      lastAction = result.restartScheduled
        ? `Auto-updated ${result.updatedIds.length} mod(s). Restart queued for ${restartTargets.length || "the running"} host pool with a Discord maintenance notice.`
        : `Auto-updated ${result.updatedIds.length} mod(s) while the server was offline.`;
    }
  } catch (error) {
    lastAction = error instanceof Error ? `Automatic mod update failed: ${error.message}` : "Automatic mod update failed.";
    await announceUpdate(config, "Mod update failed", [lastAction]).catch(() => undefined);
  }
}

async function evaluateGameUpdates(config: AppConfig) {
  if (!config.operationsSettings.autoUpdateGameServer) {
    return;
  }

  const intervalMinutes = config.operationsSettings.gameUpdateCheckMinutes || config.operationsSettings.modUpdateCheckMinutes;
  const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;
  if (Date.now() < nextGameUpdateCheckAt || gameUpdateCheckInFlight) {
    return;
  }

  nextGameUpdateCheckAt = Date.now() + intervalMs;

  if (busy || pendingRestartTimer) {
    return;
  }

  gameUpdateCheckInFlight = true;

  try {
    const updateCheck = await checkGameUpdate(config);
    if (updateCheck.updateAvailable !== true) {
      if (updateCheck.updateAvailable === null) {
        lastAction = `Automatic server update check could not compare build IDs: ${updateCheck.note}`;
      }
      return;
    }

    const processes = await listServerProcesses();
    if (processes.length) {
      const restartPlan = await planGameUpdateRestart(config);
      if (restartPlan.restartScheduled) {
        await sendUpdateLifecycleNotification(config, "game", "start", [
          `Detected dedicated server update: local build ${updateCheck.localBuildId ?? "unknown"}, latest ${updateCheck.latestBuildId ?? "unknown"}.`,
          restartPlan.note,
        ]).catch(() => undefined);
        lastAction = `Detected dedicated server update. ${restartPlan.note}`;
        return;
      }
    }

    busy = true;
    await sendUpdateLifecycleNotification(config, "game", "start", [
      `Detected dedicated server update: local build ${updateCheck.localBuildId ?? "unknown"}, latest ${updateCheck.latestBuildId ?? "unknown"}.`,
      processes.length
        ? "No configured realm host profiles are running. Other Last Oasis processes were ignored, so SteamCMD is updating the configured server path immediately."
        : "No Last Oasis server processes are running, so SteamCMD is updating immediately.",
    ]).catch(() => undefined);
    const result = await updateGame(config);
    await sendUpdateLifecycleNotification(config, "game", "finish", [
      "SteamCMD server update completed.",
      result.stderr || result.stdout || "SteamCMD returned without additional output.",
    ]).catch(() => undefined);
    lastAction = "Automatically updated the dedicated server while the host pool was offline.";
  } catch (error) {
    lastAction = error instanceof Error ? `Automatic server update failed: ${error.message}` : "Automatic server update failed.";
    await sendUpdateLifecycleNotification(config, "game", "failed", [lastAction]).catch(() => undefined);
  } finally {
    busy = false;
    gameUpdateCheckInFlight = false;
  }
}

async function evaluateEventTileAutomation(config: AppConfig) {
  const flow = config.myRealmFlow;
  if (!flow?.realmId) {
    return;
  }

  let cycleIndex = 0;
  let cycles = listEventTileCycles(config);
  const processedCycleIds = new Set<string>();
  while (cycleIndex < cycles.length) {
    const cycle = cycles[cycleIndex];
    if (processedCycleIds.has(cycle.id)) {
      cycleIndex += 1;
      continue;
    }
    processedCycleIds.add(cycle.id);
    if (!cycle.enabled || !cycle.autoAdvance) {
      cycleIndex += 1;
      continue;
    }

    const dueAt = Date.parse(getEventTileCycleNextMaintenanceAt(cycle) ?? "");
    if (!Number.isFinite(dueAt) || Date.now() + SCHEDULER_TICK_MS < dueAt) {
      cycleIndex += 1;
      continue;
    }

    if (busy || pendingRestartTimer) {
      return;
    }

    busy = true;

    try {
      const lockedResult = await runWithEventTileCycleLock(config, cycle.id, "scheduler-advance", async (freshConfig) => {
        const freshCycle = listEventTileCycles(freshConfig).find((entry) => entry.id === cycle.id);
        if (!freshCycle?.enabled || !freshCycle.autoAdvance) {
          return null;
        }

        const freshDueAt = Date.parse(getEventTileCycleNextMaintenanceAt(freshCycle) ?? "");
        if (!Number.isFinite(freshDueAt) || Date.now() + SCHEDULER_TICK_MS < freshDueAt) {
          return null;
        }

        if (!freshConfig.myRealmFlow?.realmId) {
          return null;
        }

        const { nextState, result, tiles } = await advanceEventTileCycle(freshConfig, freshConfig.myRealmFlow, cycle.id, { allowLaunch: false });
        const nextConfig = await saveConfig(applyEventTileCycleState(freshConfig, nextState));
        return { nextConfig, nextState, result, tiles };
      });

      if (lockedResult) {
        await announceEventTileCreated(lockedResult.nextConfig, lockedResult.nextState, buildCreatedEventTilesForWebhook(lockedResult.result, lockedResult.tiles)).catch(() => undefined);
        activeConfig = lockedResult.nextConfig;
        lastAction = `[${lockedResult.nextState.name}] ${lockedResult.result.message}`;
        config = lockedResult.nextConfig;
        cycles = listEventTileCycles(config);
      } else {
        activeConfig = config;
      }
    } catch (error) {
      lastAction = error instanceof Error ? `Automatic event tile maintenance failed: ${error.message}` : "Automatic event tile maintenance failed.";
    } finally {
      busy = false;
    }

    cycleIndex += 1;
  }
}

async function evaluateScheduler() {
  if (!activeConfig) {
    return;
  }

  const fallbackConfig = activeConfig;
  const config = await loadConfig().catch(() => fallbackConfig);
  activeConfig = config;
  const profile = getPrimaryProfile(config);
  const runningProcesses = await listServerProcesses();
  const liveServers = await collectLiveServers(config, runningProcesses).catch(() => []);
  const myRealmSession = await loadCachedMyRealmSession(config);

  await scanGameChatLogs(config).catch((error) => {
    lastAction = error instanceof Error ? `Game chat log watcher failed: ${error.message}` : "Game chat log watcher failed.";
  });
  await notifyLiveServerChanges(config, liveServers, myRealmSession);
  await evaluateDesiredProfiles(config, runningProcesses, liveServers);

  if (busy) {
    return;
  }

  await evaluateEventTileAutomation(config);

  if (busy) {
    return;
  }

  await evaluateGameUpdates(config);

  if (busy) {
    return;
  }

  await evaluateModUpdates(config);

  if (!profile || !profile.restartPolicy.enabled || pendingRestartTimer) {
    return;
  }

  if (!runningProcesses.length) {
    return;
  }

  const nextScheduledRestartAt = getNextScheduledRestartAt(profile.restartPolicy);
  if (!nextScheduledRestartAt) {
    return;
  }

  const warningLeadMs = Math.max(
    SCHEDULED_RESTART_WARNING_MINUTES,
    profile.restartPolicy.gracefulWarningMinutes || SCHEDULED_RESTART_WARNING_MINUTES,
  ) * 60 * 1000;
  if (Date.now() < nextScheduledRestartAt.getTime() - warningLeadMs) {
    return;
  }

  const runningHostPoolTargets = await resolveRunningHostPoolTargets(config);
  const restartTargets = runningHostPoolTargets.length ? runningHostPoolTargets : await resolveRestartTargets(config, profile);
  const restartTargetLabels = await resolveProfileDisplayLabels(config, restartTargets).catch(() =>
    restartTargets.map((entry) => entry.launch.identifier || entry.name),
  );
  const restartTargetSummary = formatProfileLabelSummary(restartTargetLabels);
  await scheduleMaintenanceTargets(
    config,
    restartTargets,
    Math.max(0, Math.ceil((nextScheduledRestartAt.getTime() - Date.now()) / 60_000)),
    `Restarting ${restartTargetSummary} during the scheduled maintenance window.`,
    {
      action: "restart",
      source: "scheduled",
      mentionEveryone: true,
      publicReason: `Scheduled Restart (${getRestartScheduleLabel(profile.restartPolicy)})`,
    },
  );
}

export async function sendUpdateLifecycleNotification(
  config: AppConfig,
  kind: "game" | "mods",
  phase: "start" | "finish" | "failed",
  details: string[],
) {
  const title = `${kind === "game" ? "Server" : "Mod"} update ${phase}`;
  try {
    await announceUpdate(config, title, details);
  } finally {
    await queueGameMessage({
      type: "update-status",
      source: kind === "game" ? "game-update" : "mod-update",
      severity: phase === "failed" ? "danger" : phase === "finish" ? "success" : "info",
      title,
      message: details[0] ?? title,
      durationSeconds: 12,
      expiresInSeconds: 60 * 60,
      dedupeKey: `update:${kind}:${phase}:${details[0] ?? title}`,
    }).catch(() => undefined);
  }
}

export function syncScheduler(config: AppConfig) {
  activeConfig = config;

  if (!timerHandle) {
    timerHandle = setInterval(() => {
      void evaluateScheduler();
    }, SCHEDULER_TICK_MS);
  }
}

export function recordSchedulerAction(message: string) {
  lastAction = message;
}

export function getSchedulerMonitorStatus(config: AppConfig): Pick<
  SchedulerStatus,
  | "enabled"
  | "monitoredProfileId"
  | "monitoredProfileName"
  | "nextRestartAt"
  | "pendingAction"
  | "pendingSource"
  | "pendingReason"
  | "pendingTargetSummary"
  | "lastWebhookTitle"
  | "lastWebhookAt"
  | "lastAction"
  | "running"
  | "autoRestartEnabled"
  | "desiredRunningProfiles"
> {
  return buildSchedulerStatusSnapshot(config);
}

export async function getSchedulerStatus(config: AppConfig): Promise<SchedulerStatus> {
  const profile = getPrimaryProfile(config);
  const processes = await listServerProcesses();

  if (pendingRestartAt) {
    return buildSchedulerStatusSnapshot(config, profile);
  }

  if (!profile || !profile.restartPolicy.enabled) {
    return buildSchedulerStatusSnapshot(config, profile);
  }

  if (!processes.length) {
    return buildSchedulerStatusSnapshot(config, profile);
  }

  return buildSchedulerStatusSnapshot(config, profile);
}
