import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, ManagerAuditEntry } from "../shared/types.js";
import { getProfileDataPath } from "./configStore.js";
import { writeDiscordTileMessage } from "./messageBridge.js";

type AuditInput = Omit<ManagerAuditEntry, "id" | "createdAt">;

type TileTarget = {
  identifier: string;
  tileName: string;
};

type DiscordRelayDeps = {
  resolveTileTarget: (tileName: string) => Promise<TileTarget | null>;
  listTileTargets: () => Promise<TileTarget[]>;
  recordAudit: (entry: AuditInput) => void;
};

type DiscordGatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  content?: string | null;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: {
    nick?: string | null;
  };
  message_reference?: {
    channel_id?: string | null;
    message_id?: string | null;
  };
  embeds?: Array<{
    title?: string | null;
    footer?: {
      text?: string | null;
    } | null;
  }>;
};

type DiscordReadyPayload = {
  user?: {
    id?: string;
  };
  application?: {
    id?: string;
  };
  guilds?: Array<{
    id?: string;
  }>;
};

type DiscordInteraction = {
  id: string;
  token: string;
  type: number;
  channel_id?: string | null;
  member?: {
    nick?: string | null;
    user?: DiscordMessage["author"];
  };
  user?: DiscordMessage["author"];
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
};

type DiscordInteractionOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
};

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_API_ORIGIN = "https://discord.com/api/v10";
const DISCORD_INTENT_GUILDS = 1;
const DISCORD_INTENT_GUILD_MESSAGES = 1 << 9;
const DISCORD_INTENT_MESSAGE_CONTENT = 1 << 15;
const DISCORD_INTENTS = DISCORD_INTENT_GUILDS | DISCORD_INTENT_GUILD_MESSAGES | DISCORD_INTENT_MESSAGE_CONTENT;
const RECONNECT_MIN_MS = 15_000;
const RECONNECT_MAX_MS = 15 * 60_000;
const CONNECTION_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const CONNECTION_RATE_LIMIT_MAX_ATTEMPTS = 12;
const CONNECTION_RATE_LIMIT_PAUSE_MS = 60 * 60_000;
const BOT_LOCK_REFRESH_MS = 30_000;
const BOT_LOCK_STALE_MS = 120_000;
const SLASH_COMMAND_NAME = "lo-message";
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_INTERACTION_AUTOCOMPLETE = 4;
const DISCORD_RESPONSE_CHANNEL_MESSAGE = 4;
const DISCORD_RESPONSE_AUTOCOMPLETE = 8;
const DISCORD_EPHEMERAL_FLAG = 1 << 6;
const TILE_OPTION_SEPARATOR = "|";

let activeToken = "";
let activeChannelId = "";
let activeEnabled = false;
let activeDeps: DiscordRelayDeps | null = null;
let socket: WebSocket | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let botLockRefreshTimer: NodeJS.Timeout | null = null;
let sequence: number | null = null;
let reconnectAttempt = 0;
let intentionalClose = false;
let socketStarting = false;
let botLockOwner = false;
let blockedConnectionKey: string | null = null;
let lastStatus = "Discord reply bot is disabled.";
let lastError: string | null = null;
const registeredGuildCommands = new Set<string>();
const discordBotLockPath = path.join(getProfileDataPath(), "discord", "discord-reply-bot.lock.json");
const discordBotStatePath = path.join(getProfileDataPath(), "discord", "discord-reply-bot-state.json");

type DiscordBotLock = {
  pid: number;
  tokenHash: string;
  channelId: string;
  claimedAt: string;
  refreshedAt: string;
};

type DiscordBotConnectionState = {
  connectionAttempts: string[];
  pauseUntil: string | null;
};

function clearTimer(timer: NodeJS.Timeout | null) {
  if (timer) {
    clearTimeout(timer);
  }
}

function stopSocket() {
  intentionalClose = true;
  clearTimer(heartbeatTimer);
  clearTimer(reconnectTimer);
  clearTimer(botLockRefreshTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
  botLockRefreshTimer = null;
  socketStarting = false;

  if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
    socket.close(1000, "Config changed");
  }

  socket = null;
  void releaseBotLock();
}

function tokenFingerprint(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function getConnectionKey(token: string, channelId: string) {
  return `${tokenFingerprint(token)}:${channelId}`;
}

function buildBotLock(token: string, channelId: string): DiscordBotLock {
  const now = new Date().toISOString();
  return {
    pid: process.pid,
    tokenHash: tokenFingerprint(token),
    channelId,
    claimedAt: now,
    refreshedAt: now,
  };
}

function isCurrentBotLock(lock: DiscordBotLock | null, token: string, channelId: string) {
  return Boolean(lock && lock.pid === process.pid && lock.tokenHash === tokenFingerprint(token) && lock.channelId === channelId);
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isBotLockStale(lock: DiscordBotLock) {
  const refreshedAt = Date.parse(lock.refreshedAt);
  return !Number.isFinite(refreshedAt) || Date.now() - refreshedAt > BOT_LOCK_STALE_MS || !isProcessAlive(lock.pid);
}

async function readConnectionState(): Promise<DiscordBotConnectionState> {
  try {
    const raw = await fs.readFile(discordBotStatePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DiscordBotConnectionState>;
    return {
      connectionAttempts: Array.isArray(parsed.connectionAttempts)
        ? parsed.connectionAttempts.filter((entry): entry is string => typeof entry === "string")
        : [],
      pauseUntil: typeof parsed.pauseUntil === "string" ? parsed.pauseUntil : null,
    };
  } catch {
    return {
      connectionAttempts: [],
      pauseUntil: null,
    };
  }
}

async function writeConnectionState(state: DiscordBotConnectionState) {
  await fs.mkdir(path.dirname(discordBotStatePath), { recursive: true });
  await fs.writeFile(discordBotStatePath, JSON.stringify(state, null, 2), "utf8");
}

async function claimConnectionAttempt() {
  const state = await readConnectionState();
  const now = Date.now();
  const pauseUntilMs = state.pauseUntil ? Date.parse(state.pauseUntil) : Number.NaN;
  if (Number.isFinite(pauseUntilMs) && pauseUntilMs > now) {
    return {
      allowed: false,
      retryAfterMs: pauseUntilMs - now,
    };
  }

  const recentAttempts = state.connectionAttempts.filter((entry) => {
    const parsed = Date.parse(entry);
    return Number.isFinite(parsed) && now - parsed <= CONNECTION_RATE_LIMIT_WINDOW_MS;
  });
  recentAttempts.push(new Date(now).toISOString());

  if (recentAttempts.length > CONNECTION_RATE_LIMIT_MAX_ATTEMPTS) {
    const pauseUntil = new Date(now + CONNECTION_RATE_LIMIT_PAUSE_MS).toISOString();
    await writeConnectionState({
      connectionAttempts: recentAttempts.slice(-CONNECTION_RATE_LIMIT_MAX_ATTEMPTS),
      pauseUntil,
    });
    return {
      allowed: false,
      retryAfterMs: CONNECTION_RATE_LIMIT_PAUSE_MS,
    };
  }

  await writeConnectionState({
    connectionAttempts: recentAttempts,
    pauseUntil: null,
  });
  return {
    allowed: true,
    retryAfterMs: 0,
  };
}

async function pauseConnectionAttempts(pauseMs = CONNECTION_RATE_LIMIT_PAUSE_MS) {
  const state = await readConnectionState();
  const now = Date.now();
  const recentAttempts = state.connectionAttempts.filter((entry) => {
    const parsed = Date.parse(entry);
    return Number.isFinite(parsed) && now - parsed <= CONNECTION_RATE_LIMIT_WINDOW_MS;
  });
  await writeConnectionState({
    connectionAttempts: recentAttempts,
    pauseUntil: new Date(now + pauseMs).toISOString(),
  });
}

async function readBotLock(): Promise<DiscordBotLock | null> {
  try {
    const raw = await fs.readFile(discordBotLockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DiscordBotLock>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.tokenHash !== "string" ||
      typeof parsed.channelId !== "string" ||
      typeof parsed.claimedAt !== "string" ||
      typeof parsed.refreshedAt !== "string"
    ) {
      return null;
    }

    return {
      pid: parsed.pid,
      tokenHash: parsed.tokenHash,
      channelId: parsed.channelId,
      claimedAt: parsed.claimedAt,
      refreshedAt: parsed.refreshedAt,
    };
  } catch {
    return null;
  }
}

async function writeBotLock(lock: DiscordBotLock, mode: "claim" | "refresh") {
  await fs.mkdir(path.dirname(discordBotLockPath), { recursive: true });
  if (mode === "claim") {
    const handle = await fs.open(discordBotLockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(lock, null, 2), "utf8");
    } finally {
      await handle.close();
    }
    return;
  }

  await fs.writeFile(discordBotLockPath, JSON.stringify(lock, null, 2), "utf8");
}

async function refreshBotLock(token: string, channelId: string) {
  if (!botLockOwner) {
    return;
  }

  try {
    const existingLock = await readBotLock();
    if (existingLock && !isCurrentBotLock(existingLock, token, channelId)) {
      botLockOwner = false;
      clearTimer(botLockRefreshTimer);
      botLockRefreshTimer = null;
      return;
    }

    const refreshedLock = {
      ...(existingLock ?? buildBotLock(token, channelId)),
      refreshedAt: new Date().toISOString(),
    };
    await writeBotLock(refreshedLock, "refresh");
  } catch (error) {
    lastError = `Discord reply bot lock refresh failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function startBotLockRefresh(token: string, channelId: string) {
  clearTimer(botLockRefreshTimer);
  botLockRefreshTimer = setInterval(() => {
    void refreshBotLock(token, channelId);
  }, BOT_LOCK_REFRESH_MS);
}

async function releaseBotLock() {
  if (!botLockOwner) {
    return;
  }

  botLockOwner = false;
  clearTimer(botLockRefreshTimer);
  botLockRefreshTimer = null;

  try {
    const existingLock = await readBotLock();
    if (existingLock?.pid === process.pid) {
      await fs.unlink(discordBotLockPath);
    }
  } catch {
    // The lock is best-effort; if it is already gone there is nothing to clean up.
  }
}

async function tryClaimBotLock(token: string, channelId: string) {
  if (botLockOwner) {
    const existingLock = await readBotLock();
    if (isCurrentBotLock(existingLock, token, channelId)) {
      await refreshBotLock(token, channelId);
      startBotLockRefresh(token, channelId);
      return true;
    }

    await releaseBotLock();
  }

  const lock = buildBotLock(token, channelId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeBotLock(lock, "claim");
      botLockOwner = true;
      startBotLockRefresh(token, channelId);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        lastError = `Discord reply bot lock could not be created: ${error instanceof Error ? error.message : String(error)}`;
        lastStatus = lastError;
        return false;
      }

      const existingLock = await readBotLock();
      if (!existingLock || existingLock.pid === process.pid || isBotLockStale(existingLock)) {
        await fs.unlink(discordBotLockPath).catch(() => undefined);
        continue;
      }

      lastError = null;
      lastStatus = `Discord reply bot is enabled, but another manager backend owns the bot lock (PID ${existingLock.pid}).`;
      return false;
    }
  }

  return false;
}

function tileFingerprint(tileName: string) {
  return crypto.createHash("sha256").update(tileName.trim().toLowerCase()).digest("hex").slice(0, 10);
}

function makeTileOptionValue(target: TileTarget) {
  return `${target.identifier}${TILE_OPTION_SEPARATOR}${tileFingerprint(target.tileName)}`;
}

function parseTileOptionValue(value: string) {
  const separatorIndex = value.indexOf(TILE_OPTION_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }

  return {
    identifier: value.slice(0, separatorIndex),
    tileHash: value.slice(separatorIndex + TILE_OPTION_SEPARATOR.length),
  };
}

function cleanDiscordText(value: string | null | undefined, maxLength: number) {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function getDiscordAuthorName(message: DiscordMessage) {
  return (
    cleanDiscordText(message.member?.nick, 80) ||
    cleanDiscordText(message.author?.global_name, 80) ||
    cleanDiscordText(message.author?.username, 80) ||
    "Discord"
  );
}

function getDiscordInteractionAuthorName(interaction: DiscordInteraction) {
  return (
    cleanDiscordText(interaction.member?.nick, 80) ||
    cleanDiscordText(interaction.member?.user?.global_name, 80) ||
    cleanDiscordText(interaction.user?.global_name, 80) ||
    cleanDiscordText(interaction.member?.user?.username, 80) ||
    cleanDiscordText(interaction.user?.username, 80) ||
    "Discord"
  );
}

function readMessageFromEvent(event: MessageEvent) {
  const data = event.data as unknown;
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  return String(data ?? "");
}

function sendGateway(payload: unknown) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function scheduleReconnect(reason: string) {
  if (
    !activeEnabled ||
    intentionalClose ||
    !activeToken ||
    !activeChannelId ||
    !activeDeps ||
    blockedConnectionKey === getConnectionKey(activeToken, activeChannelId)
  ) {
    return;
  }

  clearTimer(reconnectTimer);
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(6, reconnectAttempt));
  reconnectAttempt += 1;
  lastStatus = `Discord reply bot reconnecting in ${Math.round(delay / 1000)} seconds: ${reason}`;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startSocket();
  }, delay);
}

async function fetchDiscordMessage(channelId: string, messageId: string): Promise<DiscordMessage | null> {
  const response = await fetch(`${DISCORD_API_ORIGIN}/channels/${channelId}/messages/${messageId}`, {
    headers: {
      Authorization: `Bot ${activeToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    lastError = `Discord REST fetch failed with status ${response.status}.`;
    return null;
  }

  return (await response.json()) as DiscordMessage;
}

async function respondToInteraction(interaction: DiscordInteraction, content: string, ephemeral = true) {
  await fetch(`${DISCORD_API_ORIGIN}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: DISCORD_RESPONSE_CHANNEL_MESSAGE,
      data: {
        content: content.slice(0, 1900),
        flags: ephemeral ? DISCORD_EPHEMERAL_FLAG : 0,
      },
    }),
  }).catch(() => undefined);
}

async function respondToAutocomplete(interaction: DiscordInteraction, choices: Array<{ name: string; value: string }>) {
  await fetch(`${DISCORD_API_ORIGIN}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: DISCORD_RESPONSE_AUTOCOMPLETE,
      data: {
        choices: choices.slice(0, 25).map((choice) => ({
          name: choice.name.slice(0, 100),
          value: choice.value.slice(0, 100),
        })),
      },
    }),
  }).catch(() => undefined);
}

function readStringOption(interaction: DiscordInteraction, name: string) {
  const value = interaction.data?.options?.find((option) => option.name === name)?.value;
  return typeof value === "string" ? cleanDiscordText(value, name === "message" ? 360 : 120) : "";
}

function readFocusedOption(interaction: DiscordInteraction) {
  const option = interaction.data?.options?.find((candidate) => candidate.focused);
  return typeof option?.value === "string" ? cleanDiscordText(option.value, 120) : "";
}

async function resolveTileTargetFromSlashInput(input: string) {
  if (!activeDeps) {
    return null;
  }

  const normalizedInput = input.toLowerCase();
  const targets = await activeDeps.listTileTargets();
  const encodedTarget = parseTileOptionValue(input);
  if (encodedTarget) {
    const currentTarget = targets.find((target) => target.identifier === encodedTarget.identifier);
    if (currentTarget && tileFingerprint(currentTarget.tileName) === encodedTarget.tileHash) {
      return currentTarget;
    }

    return null;
  }

  return (
    targets.find((target) => target.identifier.toLowerCase() === normalizedInput) ??
    targets.find((target) => target.tileName.toLowerCase() === normalizedInput) ??
    targets.find((target) => {
      const normalizedTile = target.tileName.toLowerCase();
      return normalizedTile.includes(normalizedInput) || normalizedInput.includes(normalizedTile);
    }) ??
    null
  );
}

async function handleSlashAutocomplete(interaction: DiscordInteraction) {
  if (!activeDeps) {
    await respondToAutocomplete(interaction, []);
    return;
  }

  const query = readFocusedOption(interaction).toLowerCase();
  const targets = await activeDeps.listTileTargets();
  const matchingTargets = targets.filter((target) => {
    if (!query) {
      return true;
    }

    return target.tileName.toLowerCase().includes(query) || target.identifier.toLowerCase().includes(query);
  });

  await respondToAutocomplete(
    interaction,
    matchingTargets.map((target) => ({
      name: target.tileName,
      value: makeTileOptionValue(target),
    })),
  );
}

async function handleSlashCommand(interaction: DiscordInteraction) {
  if (!activeDeps || interaction.data?.name !== SLASH_COMMAND_NAME) {
    return;
  }

  if (interaction.channel_id !== activeChannelId) {
    await respondToInteraction(interaction, "Use this command in the configured Last Oasis server-chat channel.");
    return;
  }

  const tileInput = readStringOption(interaction, "tile");
  const content = readStringOption(interaction, "message");
  if (!tileInput || !content) {
    await respondToInteraction(interaction, "Use `/lo-message tile:<live tile> message:<message>`.");
    return;
  }

  const target = await resolveTileTargetFromSlashInput(tileInput);
  if (!target) {
    if (parseTileOptionValue(tileInput)) {
      await respondToInteraction(interaction, "That tile is no longer live. Pick the tile again from the current list.");
      return;
    }

    await respondToInteraction(interaction, `No live tile matched "${tileInput}".`);
    return;
  }

  const authorName = getDiscordInteractionAuthorName(interaction);
  const result = await writeDiscordTileMessage({
    targetIdentifier: target.identifier,
    tileName: target.tileName,
    authorName,
    message: content,
    discordMessageId: interaction.id,
  });

  activeDeps.recordAudit({
    category: "message-bridge",
    action: "discord-slash-message",
    status: "success",
    summary: `Slash command sent to ${target.tileName}: ${authorName} - ${content.slice(0, 80)}`,
    details: result.commandPath,
  });

  await respondToInteraction(interaction, `${target.tileName} - Discord: ${authorName} - ${content}`, false);
}

async function registerSlashCommands(ready: DiscordReadyPayload) {
  const applicationId = cleanDiscordText(ready.application?.id, 80) || cleanDiscordText(ready.user?.id, 80);
  if (!applicationId) {
    return;
  }

  const guildIds = (ready.guilds ?? []).map((guild) => cleanDiscordText(guild.id, 80)).filter(Boolean);
  await Promise.all(
    guildIds.map(async (guildId) => {
      const registrationKey = `${applicationId}:${guildId}:${tokenFingerprint(activeToken)}`;
      if (registeredGuildCommands.has(registrationKey)) {
        return;
      }

      const response = await fetch(`${DISCORD_API_ORIGIN}/applications/${applicationId}/guilds/${guildId}/commands`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${activeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: SLASH_COMMAND_NAME,
          description: "Send a Last Oasis message to a live tile",
          options: [
            {
              type: 3,
              name: "tile",
              description: "Live tile name",
              required: true,
              autocomplete: true,
            },
            {
              type: 3,
              name: "message",
              description: "Message to show in game",
              required: true,
            },
          ],
        }),
      });

      if (!response.ok) {
        lastError = `Discord slash command registration failed with status ${response.status}.`;
        activeDeps?.recordAudit({
          category: "message-bridge",
          action: "discord-slash-register",
          status: "warning",
          summary: lastError,
        });
        return;
      }

      registeredGuildCommands.add(registrationKey);
    }),
  );
}

async function handleDiscordMessage(message: DiscordMessage) {
  if (!activeDeps || !activeEnabled) {
    return;
  }

  if (message.author?.bot) {
    return;
  }

  if (message.channel_id !== activeChannelId) {
    return;
  }

  const content = cleanDiscordText(message.content, 360);
  const reference = message.message_reference;
  const referencedMessageId = cleanDiscordText(reference?.message_id, 80);
  const referencedChannelId = cleanDiscordText(reference?.channel_id, 80) || message.channel_id;
  if (!content || !referencedMessageId) {
    return;
  }

  const repliedMessage = await fetchDiscordMessage(referencedChannelId, referencedMessageId);
  const embed = repliedMessage?.embeds?.[0];
  const tileName = cleanDiscordText(embed?.title, 120);
  const footerText = cleanDiscordText(embed?.footer?.text, 120).toLowerCase();
  if (!tileName || footerText !== "last oasis manager") {
    return;
  }

  const target = await activeDeps.resolveTileTarget(tileName);
  if (!target) {
    activeDeps.recordAudit({
      category: "message-bridge",
      action: "discord-reply",
      status: "warning",
      summary: `Discord reply ignored; no live tile matched "${tileName}".`,
    });
    return;
  }

  const authorName = getDiscordAuthorName(message);
  const result = await writeDiscordTileMessage({
    targetIdentifier: target.identifier,
    tileName: target.tileName,
    authorName,
    message: content,
    discordMessageId: message.id,
  });

  activeDeps.recordAudit({
    category: "message-bridge",
    action: "discord-reply",
    status: "success",
    summary: `Sent Discord reply to ${target.tileName}: ${authorName} - ${content.slice(0, 80)}`,
    details: result.commandPath,
  });
}

async function handleGatewayPayload(payload: DiscordGatewayPayload) {
  if (typeof payload.s === "number") {
    sequence = payload.s;
  }

  if (payload.op === 10 && payload.d && typeof payload.d === "object" && "heartbeat_interval" in payload.d) {
    const heartbeatInterval = Number((payload.d as { heartbeat_interval?: number }).heartbeat_interval);
    clearTimer(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      sendGateway({ op: 1, d: sequence });
    }, Math.max(1_000, heartbeatInterval));
    sendGateway({
      op: 2,
      d: {
        token: activeToken,
        intents: DISCORD_INTENTS,
        properties: {
          os: process.platform,
          browser: "last-oasis-manager",
          device: "last-oasis-manager",
        },
      },
    });
    return;
  }

  if (payload.op === 1) {
    sendGateway({ op: 1, d: sequence });
    return;
  }

  if (payload.op === 7) {
    scheduleReconnect("Discord requested a reconnect.");
    return;
  }

  if (payload.t === "READY") {
    reconnectAttempt = 0;
    lastError = null;
    lastStatus = `Discord reply bot connected to channel ${activeChannelId}.`;
    await registerSlashCommands(payload.d as DiscordReadyPayload);
    return;
  }

  if (payload.t === "MESSAGE_CREATE") {
    await handleDiscordMessage(payload.d as DiscordMessage);
    return;
  }

  if (payload.t === "INTERACTION_CREATE") {
    const interaction = payload.d as DiscordInteraction;
    if (interaction.type === DISCORD_INTERACTION_AUTOCOMPLETE && interaction.data?.name === SLASH_COMMAND_NAME) {
      await handleSlashAutocomplete(interaction);
      return;
    }

    if (interaction.type === DISCORD_INTERACTION_APPLICATION_COMMAND) {
      await handleSlashCommand(interaction);
    }
  }
}

async function startSocket() {
  if (!activeEnabled || !activeToken || !activeChannelId || !activeDeps) {
    return;
  }

  if (blockedConnectionKey === getConnectionKey(activeToken, activeChannelId)) {
    return;
  }

  if (socketStarting || (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING)) {
    return;
  }

  if (typeof WebSocket === "undefined") {
    lastError = "This Node runtime does not expose WebSocket, so the Discord reply bot cannot start.";
    lastStatus = lastError;
    activeDeps.recordAudit({
      category: "message-bridge",
      action: "discord-reply-bot",
      status: "error",
      summary: lastError,
    });
    return;
  }

  socketStarting = true;
  const connectionAttempt = await claimConnectionAttempt().catch((error) => {
    lastError = `Discord reply bot connection guard failed: ${error instanceof Error ? error.message : String(error)}`;
    return { allowed: true, retryAfterMs: 0 };
  });
  if (!connectionAttempt.allowed) {
    socketStarting = false;
    const retrySeconds = Math.max(1, Math.ceil(connectionAttempt.retryAfterMs / 1000));
    lastStatus = `Discord reply bot paused for ${retrySeconds} seconds because Discord connection attempts were too frequent.`;
    activeDeps.recordAudit({
      category: "message-bridge",
      action: "discord-reply-bot",
      status: "warning",
      summary: lastStatus,
    });
    clearTimer(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void startSocket();
    }, Math.max(60_000, connectionAttempt.retryAfterMs));
    return;
  }

  const lockClaimed = await tryClaimBotLock(activeToken, activeChannelId);
  if (!lockClaimed) {
    socketStarting = false;
    return;
  }

  if (!activeEnabled || !activeToken || !activeChannelId || !activeDeps) {
    socketStarting = false;
    await releaseBotLock();
    return;
  }

  intentionalClose = false;
  clearTimer(heartbeatTimer);
  clearTimer(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
  sequence = null;
  lastStatus = `Discord reply bot connecting to channel ${activeChannelId}.`;
  socket = new WebSocket(DISCORD_GATEWAY_URL);

  socket.addEventListener("open", () => {
    socketStarting = false;
    lastStatus = `Discord reply bot connected to Discord gateway for channel ${activeChannelId}.`;
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(readMessageFromEvent(event)) as DiscordGatewayPayload;
      void handleGatewayPayload(payload).catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
        activeDeps?.recordAudit({
          category: "message-bridge",
          action: "discord-reply-bot",
          status: "warning",
          summary: lastError,
        });
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Discord gateway payload could not be parsed.";
    }
  });

  socket.addEventListener("close", (event) => {
    socketStarting = false;
    clearTimer(heartbeatTimer);
    heartbeatTimer = null;
    socket = null;
    if (intentionalClose) {
      return;
    }

    const reason = cleanDiscordText(event.reason, 160) || `gateway closed with code ${event.code}`;
    lastError = reason;
    const rateLimitedClose = event.code === 4008;
    const terminalClose =
      event.code === 4004 ||
      event.code === 4010 ||
      event.code === 4011 ||
      event.code === 4012 ||
      event.code === 4013 ||
      event.code === 4014;
    activeDeps?.recordAudit({
      category: "message-bridge",
      action: "discord-reply-bot",
      status: terminalClose ? "error" : "warning",
      summary: `Discord gateway closed: ${reason}`,
      details:
        event.code === 4004
          ? "Discord rejected the bot token."
          : event.code === 4008
            ? "Discord rate-limited the bot connection. The manager will pause before trying again."
          : event.code === 4010 || event.code === 4011 || event.code === 4012
            ? "Discord rejected the gateway session. Check the bot settings before reconnecting."
          : event.code === 4013
            ? "Discord rejected the requested intents. Check the bot settings and restart or save the bot settings after fixing them."
          : event.code === 4014
            ? "Discord rejected one of the requested intents. Enable Message Content Intent in the Developer Portal or reinstall the bot with the correct permissions."
            : undefined,
    });

    if (rateLimitedClose) {
      lastStatus = "Discord rate-limited the reply bot. The manager paused reconnect attempts for 1 hour.";
      void pauseConnectionAttempts();
      void releaseBotLock();
      clearTimer(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void startSocket();
      }, CONNECTION_RATE_LIMIT_PAUSE_MS);
      return;
    }

    if (terminalClose) {
      blockedConnectionKey = getConnectionKey(activeToken, activeChannelId);
      lastStatus =
        event.code === 4004
          ? "Discord rejected the bot token. Paste the new reset token in Game Bridge and save before reconnecting."
          : "Discord rejected the bot intents. Enable Message Content Intent, then save the bot settings or restart the backend.";
      void releaseBotLock();
      return;
    }

    scheduleReconnect(reason);
  });

  socket.addEventListener("error", () => {
    socketStarting = false;
    lastError = "Discord gateway socket error.";
    activeDeps?.recordAudit({
      category: "message-bridge",
      action: "discord-reply-bot",
      status: "warning",
      summary: lastError,
    });
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      scheduleReconnect(lastError);
    }
  });
}

export function syncDiscordReplyBot(config: AppConfig, deps: DiscordRelayDeps) {
  const token = config.operationsSettings.discordBotToken.trim();
  const channelId = config.operationsSettings.discordBotChannelId.trim();
  const enabled = config.operationsSettings.discordBotEnabled && Boolean(token && channelId);
  const connectionKey = token && channelId ? getConnectionKey(token, channelId) : null;

  if (!enabled) {
    activeEnabled = false;
    activeToken = "";
    activeChannelId = "";
    activeDeps = deps;
    stopSocket();
    lastError = null;
    lastStatus = config.operationsSettings.discordBotEnabled
      ? "Discord reply bot is enabled, but bot token or channel ID is missing."
      : "Discord reply bot is disabled.";
    return;
  }

  if (blockedConnectionKey && blockedConnectionKey !== connectionKey) {
    blockedConnectionKey = null;
  }

  const sameConnection = activeEnabled && activeToken === token && activeChannelId === channelId;
  activeEnabled = true;
  activeToken = token;
  activeChannelId = channelId;
  activeDeps = deps;

  if (blockedConnectionKey === connectionKey) {
    stopSocket();
    lastError = lastStatus;
    return;
  }

  if (sameConnection && (socket || socketStarting || reconnectTimer)) {
    return;
  }

  stopSocket();
  lastStatus = `Discord reply bot starting for channel ${channelId} with token ${tokenFingerprint(token)}.`;
  void startSocket();
}

export function getDiscordReplyBotStatus() {
  return {
    enabled: activeEnabled,
    channelId: activeChannelId || null,
    status: lastStatus,
    lastError,
  };
}
