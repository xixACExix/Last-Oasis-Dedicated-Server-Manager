import fs from "node:fs/promises";
import path from "node:path";
import { getProfileDataPath, loadConfig } from "./configStore.js";
import type {
  AppConfig,
  GameBridgeChatEntry,
  GameBridgeMessage,
  GameBridgeMessageSeverity,
  GameBridgeTargetScope,
  GameBridgeMessageType,
  GameBridgePollResponse,
  InGameMessageBridgeStatus,
} from "../shared/types.js";

const QUEUE_LIMIT = 200;
const CHAT_TAIL_LIMIT = 250;
const DEFAULT_MESSAGE_DURATION_SECONDS = 12;
const DEFAULT_MESSAGE_TTL_SECONDS = 2 * 60 * 60;
const POLL_ENDPOINT = "/api/game-bridge/messages/poll";
const ACK_ENDPOINT = "/api/game-bridge/messages/ack";
const ADMIN_ENDPOINT = "/api/message-bridge/admin-message";
const CHAT_ENDPOINT = "/api/game-bridge/chat";
const CHAT_DEDUPE_WINDOW_MS = 15_000;
const DEFAULT_GAME_BRIDGE_INBOX_ROOT_PATH =
  "C:\\LastOasisServer\\Mist\\Content\\Mods\\LOManagerBridge\\Inbox";
const DEFAULT_GAME_BRIDGE_COMMAND_FILE_PATH = path.join(DEFAULT_GAME_BRIDGE_INBOX_ROOT_PATH, "Admin.json");

type MessageBridgeStore = {
  messages: GameBridgeMessage[];
  chatTail: GameBridgeChatEntry[];
  lastPollAt: string | null;
  lastClientId: string | null;
  lastClientVersion: string | null;
  lastClientMap: string | null;
};

type QueueGameMessageInput = {
  type: GameBridgeMessageType;
  severity?: GameBridgeMessageSeverity;
  source?: GameBridgeMessage["source"];
  title?: string | null;
  message: string;
  durationSeconds?: number;
  countdownSeconds?: number | null;
  expiresInSeconds?: number;
  dedupeKey?: string | null;
  targetScope?: GameBridgeTargetScope;
  targetIdentifier?: string | null;
  targetLabel?: string | null;
  withWidget?: boolean;
};

type PollGameMessagesInput = {
  clientId?: string | null;
  version?: string | null;
  mapName?: string | null;
  limit?: number | null;
};

type ChatInput = {
  channel?: string | null;
  playerName?: string | null;
  message: string;
  mapName?: string | null;
  tileName?: string | null;
  profileId?: string | null;
  clientId?: string | null;
  externalId?: string | null;
  createdAt?: string | null;
};

let storeLock: Promise<void> = Promise.resolve();

function toWindowsPath(targetPath: string) {
  return process.platform === "win32" ? targetPath.replace(/\//g, "\\") : targetPath;
}

function bridgeDirectory() {
  return path.join(getProfileDataPath(), "message-bridge");
}

function storePath() {
  return path.join(bridgeDirectory(), "queue.json");
}

function chatLogDirectory() {
  return path.join(bridgeDirectory(), "chat-logs");
}

function chatLogDay(createdAt = new Date()) {
  return createdAt.toISOString().slice(0, 10);
}

function chatLogPath(createdAt = new Date()) {
  return path.join(chatLogDirectory(), `${chatLogDay(createdAt)}.jsonl`);
}

function chatHumanLogPath(createdAt = new Date()) {
  return path.join(chatLogDirectory(), `${chatLogDay(createdAt)}.log`);
}

function buildId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultStore(): MessageBridgeStore {
  return {
    messages: [],
    chatTail: [],
    lastPollAt: null,
    lastClientId: null,
    lastClientVersion: null,
    lastClientMap: null,
  };
}

function cleanOptionalText(value: string | null | undefined, maxLength: number) {
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function cleanRequiredText(value: string, maxLength: number) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, maxLength);
}

function normalizeChannel(value: string | null | undefined): GameBridgeChatEntry["channel"] {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "map" || normalized === "clan" || normalized === "combat" || normalized === "other") {
    return normalized;
  }

  return "all";
}

function buildChatDedupeKey(input: ChatInput, messageText: string) {
  const externalId = cleanOptionalText(input.externalId, 160);
  const clientId = cleanOptionalText(input.clientId, 80);
  if (externalId) {
    return `external:${clientId ?? "unknown"}:${externalId}`;
  }

  return [
    "body",
    normalizeChannel(input.channel),
    cleanOptionalText(input.playerName, 80) ?? "Unknown",
    cleanOptionalText(input.mapName, 120) ?? "",
    cleanOptionalText(input.tileName, 120) ?? "",
    cleanOptionalText(input.profileId, 120) ?? "",
    messageText,
  ].join("|").toLowerCase();
}

function resolveChatTimestamp(input: ChatInput) {
  const parsed = input.createdAt ? Date.parse(input.createdAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function formatChatLogLine(entry: GameBridgeChatEntry) {
  const location = entry.tileName || entry.mapName || "Unknown tile";
  return `[${entry.createdAt}] [${location}] [${entry.channel}] ${entry.playerName}: ${entry.message}\n`;
}

function isExpired(message: GameBridgeMessage, now = Date.now()) {
  return Date.parse(message.expiresAt) <= now;
}

function isPending(message: GameBridgeMessage, now = Date.now()) {
  return !message.acknowledgedAt && !isExpired(message, now);
}

function normalizeStore(value: unknown): MessageBridgeStore {
  if (!value || typeof value !== "object") {
    return defaultStore();
  }

  const raw = value as Partial<MessageBridgeStore>;
  return {
    messages: Array.isArray(raw.messages) ? raw.messages.filter((entry) => entry && typeof entry === "object") : [],
    chatTail: Array.isArray(raw.chatTail) ? raw.chatTail.filter((entry) => entry && typeof entry === "object") : [],
    lastPollAt: typeof raw.lastPollAt === "string" ? raw.lastPollAt : null,
    lastClientId: typeof raw.lastClientId === "string" ? raw.lastClientId : null,
    lastClientVersion: typeof raw.lastClientVersion === "string" ? raw.lastClientVersion : null,
    lastClientMap: typeof raw.lastClientMap === "string" ? raw.lastClientMap : null,
  };
}

async function readStore(): Promise<MessageBridgeStore> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch {
    return defaultStore();
  }
}

async function writeStore(store: MessageBridgeStore) {
  const directory = bridgeDirectory();
  await fs.mkdir(directory, { recursive: true });
  store.messages = store.messages.slice(-QUEUE_LIMIT);
  store.chatTail = store.chatTail.slice(-CHAT_TAIL_LIMIT);
  const targetPath = storePath();
  const tempPath = `${targetPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2));
  await fs.rename(tempPath, targetPath);
}

async function withStore<T>(work: (store: MessageBridgeStore) => Promise<T>): Promise<T> {
  const previousLock = storeLock;
  let releaseLock: () => void = () => undefined;
  storeLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock.catch(() => undefined);

  try {
    const store = await readStore();
    return await work(store);
  } finally {
    releaseLock();
  }
}

function prunePostedCommandMessages(store: MessageBridgeStore) {
  const before = store.messages.length;
  store.messages = store.messages.filter((message) => !(message.acknowledgedBy === "command-file" && message.acknowledgedAt));
  return store.messages.length !== before;
}

type BridgeCommandTargets = {
  enabled: boolean;
  inboxRootPath: string;
  commandPath: string;
  globalWidgetPath: string;
  globalNoWidgetPath: string;
  tileWidgetDirectory: string;
  tileNoWidgetDirectory: string;
  tileDiscordDirectory: string;
};

function normalizeBridgePath(value: string) {
  return toWindowsPath(path.resolve(value));
}

function resolveConfiguredInboxRoot(config: AppConfig) {
  const configuredRoot = config.operationsSettings.gameBridgeInboxRootPath?.trim();
  if (configuredRoot) {
    const rootPath = path.basename(configuredRoot).toLowerCase().endsWith(".json")
      ? path.dirname(configuredRoot)
      : configuredRoot;
    return normalizeBridgePath(rootPath);
  }

  const configuredCommandPath = config.operationsSettings.gameBridgeCommandFilePath?.trim();
  if (configuredCommandPath) {
    const rootPath = path.basename(configuredCommandPath).toLowerCase().endsWith(".json")
      ? path.dirname(configuredCommandPath)
      : configuredCommandPath;
    return normalizeBridgePath(rootPath);
  }

  return normalizeBridgePath(DEFAULT_GAME_BRIDGE_INBOX_ROOT_PATH);
}

function resolveBridgeCommandTargetsFromConfig(config: AppConfig): BridgeCommandTargets {
  const inboxRootPath = resolveConfiguredInboxRoot(config);
  const configuredCommandPath = config.operationsSettings.gameBridgeCommandFilePath?.trim();
  const globalWidgetPath = configuredCommandPath
    ? normalizeBridgePath(
        path.basename(configuredCommandPath).toLowerCase().endsWith(".json")
          ? configuredCommandPath
          : path.join(configuredCommandPath, "Admin.json"),
      )
    : path.join(inboxRootPath, "Admin.json");

  return {
    enabled: config.operationsSettings.gameBridgeModMessagesEnabled !== false,
    inboxRootPath,
    commandPath: globalWidgetPath,
    globalWidgetPath,
    globalNoWidgetPath: path.join(inboxRootPath, "AdminNOwidget.json"),
    tileWidgetDirectory: path.join(inboxRootPath, "Tiles"),
    tileNoWidgetDirectory: path.join(inboxRootPath, "TilesNW"),
    tileDiscordDirectory: path.join(inboxRootPath, "TilesDC"),
  };
}

function normalizeTargetIdentifier(value: string | null | undefined) {
  const cleaned = cleanOptionalText(value, 100)
    ?.replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return cleaned || null;
}

async function resolveBridgeCommandFile(message?: GameBridgeMessage) {
  try {
    const config = await loadConfig();
    const targets = resolveBridgeCommandTargetsFromConfig(config);
    return {
      ...targets,
      commandPath: message ? resolveBridgeCommandPath(message, targets) : targets.commandPath,
    };
  } catch {
    const fallbackRoot = normalizeBridgePath(DEFAULT_GAME_BRIDGE_INBOX_ROOT_PATH);
    return {
      enabled: true,
      inboxRootPath: fallbackRoot,
      commandPath: "",
      globalWidgetPath: path.join(fallbackRoot, "Admin.json"),
      globalNoWidgetPath: path.join(fallbackRoot, "AdminNOwidget.json"),
      tileWidgetDirectory: path.join(fallbackRoot, "Tiles"),
      tileNoWidgetDirectory: path.join(fallbackRoot, "TilesNW"),
      tileDiscordDirectory: path.join(fallbackRoot, "TilesDC"),
    };
  }
}

function resolveBridgeCommandPath(message: GameBridgeMessage, targets: BridgeCommandTargets) {
  if (message.type === "restart-warning" || message.type === "update-warning" || message.type === "maintenance") {
    const countdownSeconds = typeof message.countdownSeconds === "number" ? message.countdownSeconds : null;
    if (countdownSeconds !== null && countdownSeconds > 0 && countdownSeconds <= 300) {
      return targets.globalWidgetPath;
    }
  }

  const targetScope = message.targetScope ?? (message.target === "tile" ? "tile" : "global");
  const withWidget = message.withWidget !== false;
  if (targetScope === "tile") {
    const targetIdentifier = normalizeTargetIdentifier(message.targetIdentifier);
    if (targetIdentifier) {
      const directory = withWidget ? targets.tileWidgetDirectory : targets.tileNoWidgetDirectory;
      return path.join(directory, `${targetIdentifier}.json`);
    }
  }

  return withWidget ? targets.globalWidgetPath : targets.globalNoWidgetPath;
}

function buildBridgeCommand(message: GameBridgeMessage) {
  if (message.type === "admin") {
    return {
      id: message.id,
      type: "AdminMessage" as const,
      message: message.message,
      seconds: 0,
      createdUtc: message.createdAt,
    };
  }

  if (message.type === "restart-now" || (message.countdownSeconds !== null && message.countdownSeconds <= 0)) {
    return {
      id: message.id,
      type: "AdminMessage" as const,
      message: message.message,
      seconds: 0,
      createdUtc: message.createdAt,
    };
  }

  const countdownSeconds = typeof message.countdownSeconds === "number" ? message.countdownSeconds : null;
  const shouldTriggerCountdownWidget =
    (message.type === "restart-warning" || message.type === "update-warning" || message.type === "maintenance") &&
    countdownSeconds !== null &&
    countdownSeconds > 0 &&
    countdownSeconds <= 300;

  if (shouldTriggerCountdownWidget) {
    return {
      id: message.id,
      type: "RestartWarning" as const,
      message: message.message,
      seconds: Math.max(1, Math.round(countdownSeconds ?? 0)),
      createdUtc: message.createdAt,
    };
  }

  if (message.type === "restart-warning" || message.type === "update-warning" || message.type === "maintenance") {
    return {
      id: message.id,
      type: "AdminMessage" as const,
      message: message.message,
      seconds: 0,
      createdUtc: message.createdAt,
    };
  }

  return null;
}

async function writeBridgeCommandFile(message: GameBridgeMessage) {
  const command = buildBridgeCommand(message);
  if (!command) {
    return null;
  }

  const bridgeCommandFile = await resolveBridgeCommandFile(message);
  if (!bridgeCommandFile.enabled || !bridgeCommandFile.commandPath) {
    return null;
  }

  await fs.mkdir(path.dirname(bridgeCommandFile.commandPath), { recursive: true });
  await fs.writeFile(bridgeCommandFile.commandPath, Buffer.from(JSON.stringify(command, null, 2), "utf8"));
  return bridgeCommandFile.commandPath;
}

async function buildStatus(store: MessageBridgeStore): Promise<InGameMessageBridgeStatus> {
  const now = Date.now();
  const pendingCount = store.messages.filter((message) => isPending(message, now)).length;
  const deliveredCount = store.messages.filter((message) => message.deliveredAt && !message.acknowledgedAt).length;
  const bridgeCommandFile = await resolveBridgeCommandFile();
  const bridgeCommandPath = bridgeCommandFile.commandPath ? toWindowsPath(bridgeCommandFile.commandPath) : null;
  const inboxRootPath = bridgeCommandFile.inboxRootPath ? toWindowsPath(bridgeCommandFile.inboxRootPath) : null;
  const note = bridgeCommandFile.enabled
    ? bridgeCommandPath
      ? `Local bridge queue is ready. Global widget commands use ${bridgeCommandPath}; tile messages use Tiles, TilesNW, and Discord replies use TilesDC under the inbox root.`
      : "Local bridge queue is ready, but the LOManagerBridge inbox root is not configured."
    : "Local bridge queue is ready. LOManagerBridge command-file messages are disabled in Operations.";

  return {
    configured: true,
    mode: "mod-bridge",
    endpoint: POLL_ENDPOINT,
    pollEndpoint: POLL_ENDPOINT,
    ackEndpoint: ACK_ENDPOINT,
    adminEndpoint: ADMIN_ENDPOINT,
    chatEndpoint: CHAT_ENDPOINT,
    chatLogPath: toWindowsPath(chatLogPath()),
    markerInboxPath: bridgeCommandPath,
    markerInboxRootPath: inboxRootPath,
    markerGlobalNoWidgetPath: toWindowsPath(bridgeCommandFile.globalNoWidgetPath),
    markerTileInboxPath: toWindowsPath(bridgeCommandFile.tileWidgetDirectory),
    markerTileNoWidgetInboxPath: toWindowsPath(bridgeCommandFile.tileNoWidgetDirectory),
    markerTileDiscordInboxPath: toWindowsPath(bridgeCommandFile.tileDiscordDirectory),
    markerMessagesEnabled: bridgeCommandFile.enabled,
    queueDepth: store.messages.length,
    pendingCount,
    deliveredCount,
    lastPollAt: store.lastPollAt,
    lastClientId: store.lastClientId,
    lastClientVersion: store.lastClientVersion,
    lastClientMap: store.lastClientMap,
    lastCheckedAt: new Date().toISOString(),
    note,
  };
}

export async function getMessageBridgeStatus() {
  return withStore(async (store) => {
    const changed = prunePostedCommandMessages(store);
    if (changed) {
      await writeStore(store);
    }
    return buildStatus(store);
  });
}

export async function listGameBridgeMessages() {
  return withStore(async (store) => {
    const changed = prunePostedCommandMessages(store);
    if (changed) {
      await writeStore(store);
    }
    return {
      status: await buildStatus(store),
      messages: [...store.messages].reverse(),
    };
  });
}

export async function clearGameBridgeMessages() {
  return withStore(async (store) => {
    store.messages = [];
    await writeStore(store);
    return buildStatus(store);
  });
}

export async function queueGameMessage(input: QueueGameMessageInput) {
  const body = cleanRequiredText(input.message, 360);
  if (!body) {
    throw new Error("Message text is required.");
  }

  return withStore(async (store) => {
    const now = Date.now();
    const dedupeKey = cleanOptionalText(input.dedupeKey, 160);
    if (dedupeKey) {
      const duplicate = [...store.messages]
        .reverse()
        .find((message) => message.dedupeKey === dedupeKey && !isExpired(message, now));
      if (duplicate) {
        return duplicate;
      }
    }

    const createdAt = new Date(now).toISOString();
    const expiresInSeconds = Math.max(30, input.expiresInSeconds ?? DEFAULT_MESSAGE_TTL_SECONDS);
    const durationSeconds = Math.max(3, Math.min(600, input.durationSeconds ?? DEFAULT_MESSAGE_DURATION_SECONDS));
    const targetScope = input.targetScope === "tile" ? "tile" : "global";
    const targetIdentifier = targetScope === "tile" ? normalizeTargetIdentifier(input.targetIdentifier) : null;
    const targetLabel = targetScope === "tile" ? cleanOptionalText(input.targetLabel, 120) ?? targetIdentifier : "All servers";
    const message: GameBridgeMessage = {
      id: buildId("msg"),
      createdAt,
      expiresAt: new Date(now + expiresInSeconds * 1000).toISOString(),
      type: input.type,
      severity: input.severity ?? "info",
      source: input.source ?? "manager",
      target: targetScope === "tile" ? "tile" : "all",
      targetScope,
      targetIdentifier,
      targetLabel,
      withWidget: input.withWidget ?? true,
      commandFilePath: null,
      title: cleanOptionalText(input.title, 80),
      message: body,
      durationSeconds,
      countdownSeconds: typeof input.countdownSeconds === "number" ? Math.max(0, Math.round(input.countdownSeconds)) : null,
      dedupeKey,
      deliveredAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };

    let writtenCommandPath: string | null = null;
    const commandWrittenAt = await writeBridgeCommandFile(message)
      .then((commandPath) => {
        writtenCommandPath = commandPath;
        return commandPath ? new Date().toISOString() : null;
      })
      .catch(() => null);
    if (commandWrittenAt) {
      message.deliveredAt = commandWrittenAt;
      message.acknowledgedAt = commandWrittenAt;
      message.acknowledgedBy = "command-file";
      message.commandFilePath = writtenCommandPath ? toWindowsPath(writtenCommandPath) : null;
      await appendChatEntryToStore(store, {
        channel: "other",
        playerName: "Admin",
        message: body,
        mapName: null,
        tileName: targetScope === "tile" ? targetLabel : "All servers",
        profileId: targetIdentifier,
        clientId: "lo-manager-bridge",
        externalId: `bridge-out:${dedupeKey || message.id}`,
        createdAt,
      });
    }

    store.messages.push(message);
    await writeStore(store);
    return message;
  });
}

export async function pollGameBridgeMessages(input: PollGameMessagesInput): Promise<GameBridgePollResponse> {
  return withStore(async (store) => {
    const now = Date.now();
    const limit = Math.max(1, Math.min(50, input.limit ?? 25));
    const clientId = cleanOptionalText(input.clientId, 80);
    store.lastPollAt = new Date(now).toISOString();
    store.lastClientId = clientId;
    store.lastClientVersion = cleanOptionalText(input.version, 80);
    store.lastClientMap = cleanOptionalText(input.mapName, 120);

    const messages = store.messages.filter((message) => isPending(message, now)).slice(0, limit);
    for (const message of messages) {
      message.deliveredAt ??= store.lastPollAt;
    }

    await writeStore(store);
    return {
      serverTime: store.lastPollAt,
      status: await buildStatus(store),
      messages,
    };
  });
}

export async function acknowledgeGameBridgeMessages(ids: string[], clientId?: string | null) {
  return withStore(async (store) => {
    const acknowledgedAt = new Date().toISOString();
    const acknowledgedBy = cleanOptionalText(clientId, 80);
    const wanted = new Set(ids.map((id) => id.trim()).filter(Boolean));
    let acknowledged = 0;

    for (const message of store.messages) {
      if (!wanted.has(message.id) || message.acknowledgedAt) {
        continue;
      }

      message.acknowledgedAt = acknowledgedAt;
      message.acknowledgedBy = acknowledgedBy;
      acknowledged += 1;
    }

    await writeStore(store);
    return {
      acknowledged,
      status: await buildStatus(store),
    };
  });
}

export async function recordGameBridgeChat(input: ChatInput) {
  const messageText = cleanRequiredText(input.message, 600);
  if (!messageText) {
    throw new Error("Chat message text is required.");
  }

  return withStore(async (store) => {
    const result = await appendChatEntryToStore(store, input, messageText);
    await writeStore(store);
    return result;
  });
}

async function appendChatEntryToStore(store: MessageBridgeStore, input: ChatInput, cleanedMessageText?: string) {
  const messageText = cleanedMessageText ?? cleanRequiredText(input.message, 600);
  const now = resolveChatTimestamp(input);
  const dedupeKey = buildChatDedupeKey(input, messageText);
  const hasExternalId = Boolean(cleanOptionalText(input.externalId, 160));
  const duplicate = [...store.chatTail].reverse().find((entry) => {
    if (entry.dedupeKey !== dedupeKey) {
      return false;
    }

    if (hasExternalId) {
      return true;
    }

    const ageMs = now - Date.parse(entry.createdAt);
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= CHAT_DEDUPE_WINDOW_MS;
  });
  if (duplicate) {
    return {
      entry: duplicate,
      duplicate: true,
    };
  }

  const createdAt = new Date(now);
  const entry: GameBridgeChatEntry = {
    id: buildId("chat"),
    createdAt: createdAt.toISOString(),
    channel: normalizeChannel(input.channel),
    playerName: cleanOptionalText(input.playerName, 80) ?? "Unknown",
    message: messageText,
    mapName: cleanOptionalText(input.mapName, 120),
    tileName: cleanOptionalText(input.tileName, 120),
    profileId: cleanOptionalText(input.profileId, 120),
    clientId: cleanOptionalText(input.clientId, 80),
    externalId: cleanOptionalText(input.externalId, 160),
    dedupeKey,
    discordPostedAt: null,
  };

  store.chatTail.push(entry);
  const jsonLogPath = chatLogPath(createdAt);
  const humanLogPath = chatHumanLogPath(createdAt);
  await fs.mkdir(path.dirname(jsonLogPath), { recursive: true }).catch(() => undefined);
  await Promise.all([
    fs.appendFile(jsonLogPath, `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined),
    fs.appendFile(humanLogPath, formatChatLogLine(entry), "utf8").catch(() => undefined),
  ]);
  return {
    entry,
    duplicate: false,
  };
}

export async function writeDiscordTileMessage(input: {
  targetIdentifier: string;
  tileName: string;
  authorName: string;
  message: string;
  discordMessageId: string;
}) {
  const messageText = cleanRequiredText(input.message, 360);
  const authorName = cleanOptionalText(input.authorName, 80) ?? "Discord";
  const targetIdentifier = normalizeTargetIdentifier(input.targetIdentifier);
  if (!messageText) {
    throw new Error("Discord reply text is required.");
  }

  if (!targetIdentifier) {
    throw new Error("A live tile identifier is required before sending a Discord reply to the game.");
  }

  const createdAt = new Date().toISOString();
  const bridgeCommandFile = await resolveBridgeCommandFile();
  if (!bridgeCommandFile.enabled) {
    throw new Error("LOManagerBridge command-file messages are disabled in Operations.");
  }

  const commandPath = path.join(bridgeCommandFile.tileDiscordDirectory, `${targetIdentifier}.json`);
  const command = {
    id: `discord-${input.discordMessageId}-${Date.now().toString(36)}`,
    type: "AdminMessage" as const,
    message: `${authorName} - ${messageText}`,
    seconds: 0,
    createdUtc: createdAt,
  };

  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, Buffer.from(JSON.stringify(command, null, 2), "utf8"));

  const chatResult = await recordGameBridgeChat({
    channel: "other",
    playerName: "Discord",
    message: command.message,
    mapName: null,
    tileName: input.tileName,
    profileId: targetIdentifier,
    clientId: "discord-reply-bot",
    externalId: `discord:${input.discordMessageId}`,
    createdAt,
  });

  return {
    commandPath: toWindowsPath(commandPath),
    entry: chatResult.entry,
    duplicate: chatResult.duplicate,
  };
}

export async function markGameBridgeChatDiscordPosted(entryId: string) {
  return withStore(async (store) => {
    const entry = store.chatTail.find((candidate) => candidate.id === entryId);
    if (!entry) {
      return null;
    }

    entry.discordPostedAt = new Date().toISOString();
    await writeStore(store);
    return entry;
  });
}

export async function listGameBridgeChat(limit = 100) {
  return withStore(async (store) => {
    const clampedLimit = Math.max(1, Math.min(250, limit));
    return {
      status: await buildStatus(store),
      entries: [...store.chatTail].slice(-clampedLimit).reverse(),
    };
  });
}
