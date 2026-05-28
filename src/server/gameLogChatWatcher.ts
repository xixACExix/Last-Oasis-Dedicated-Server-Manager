import fs from "node:fs/promises";
import path from "node:path";
import { getProfileDataPath } from "./configStore.js";
import { getConfiguredServerLogsPath } from "./serverManager.js";
import { markGameBridgeChatDiscordPosted, recordGameBridgeChat } from "./messageBridge.js";
import type { AppConfig, GameBridgeChatEntry } from "../shared/types.js";

const STATE_VERSION = 1;
const MAX_INITIAL_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_INITIAL_TAIL_BYTES = 512 * 1024;
const MAX_READ_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_LOG_FILES_PER_SCAN = 48;

const CHAT_LINE_RE =
  /^\[(?<timestamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\]\[\s*\d+\]LogGame:\s+Chat message from (?<playerName>.+?):\s*(?<message>.*)$/;
const REALM_ID_RE = /LogPersistence:\s+realm_id:\s*(?<value>.+)$/;
const TILE_NAME_RE = /LogPersistence:\s+tile_name:\s*(?<value>.+)$/;
const TILE_ID_RE = /LogPersistence:\s+tile_id:\s*(?<value>.+)$/;

type LogFileState = {
  offset: number;
  partial: string;
  tileName: string | null;
  tileId: string | null;
  realmId: string | null;
  lastSeenAt: string;
};

type GameLogChatWatcherState = {
  version: number;
  files: Record<string, LogFileState>;
};

type CandidateLogFile = {
  key: string;
  filePath: string;
  fileName: string;
  size: number;
  mtimeMs: number;
};

type ParsedChatLine = {
  createdAt: string;
  playerName: string;
  message: string;
};

let scanLock: Promise<void> | null = null;

function watcherDirectory() {
  return path.join(getProfileDataPath(), "message-bridge");
}

function watcherStatePath() {
  return path.join(watcherDirectory(), "log-chat-watch-state.json");
}

function defaultState(): GameLogChatWatcherState {
  return {
    version: STATE_VERSION,
    files: {},
  };
}

function cleanLogValue(value: string | null | undefined, maxLength = 160) {
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function normalizeState(raw: unknown): GameLogChatWatcherState {
  if (!raw || typeof raw !== "object") {
    return defaultState();
  }

  const source = raw as Partial<GameLogChatWatcherState>;
  const files: Record<string, LogFileState> = {};
  for (const [key, value] of Object.entries(source.files ?? {})) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const entry = value as Partial<LogFileState>;
    files[key] = {
      offset: Number.isFinite(entry.offset) && entry.offset ? Math.max(0, Math.floor(entry.offset)) : 0,
      partial: typeof entry.partial === "string" ? entry.partial.slice(-4096) : "",
      tileName: cleanLogValue(entry.tileName, 160),
      tileId: cleanLogValue(entry.tileId, 80),
      realmId: cleanLogValue(entry.realmId, 80),
      lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : new Date(0).toISOString(),
    };
  }

  return {
    version: STATE_VERSION,
    files,
  };
}

async function readState() {
  try {
    return normalizeState(JSON.parse(await fs.readFile(watcherStatePath(), "utf8")));
  } catch {
    return defaultState();
  }
}

async function writeState(state: GameLogChatWatcherState) {
  await fs.mkdir(watcherDirectory(), { recursive: true });
  const targetPath = watcherStatePath();
  const tempPath = `${targetPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tempPath, targetPath);
}

function parseUnrealTimestamp(value: string) {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})$/.exec(value);
  if (!match) {
    return new Date().toISOString();
  }

  const [, year, month, day, hour, minute, second, millisecond] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millisecond),
    ),
  ).toISOString();
}

function updateTileMetadata(state: LogFileState, line: string) {
  const realmMatch = REALM_ID_RE.exec(line);
  if (realmMatch?.groups?.value) {
    state.realmId = cleanLogValue(realmMatch.groups.value, 80);
  }

  const tileNameMatch = TILE_NAME_RE.exec(line);
  if (tileNameMatch?.groups?.value) {
    state.tileName = cleanLogValue(tileNameMatch.groups.value, 160);
  }

  const tileIdMatch = TILE_ID_RE.exec(line);
  if (tileIdMatch?.groups?.value) {
    state.tileId = cleanLogValue(tileIdMatch.groups.value, 80);
  }
}

function parseChatLine(line: string): ParsedChatLine | null {
  const match = CHAT_LINE_RE.exec(line);
  if (!match?.groups) {
    return null;
  }

  const message = cleanLogValue(match.groups.message, 600);
  if (!message) {
    return null;
  }

  return {
    createdAt: parseUnrealTimestamp(match.groups.timestamp),
    playerName: cleanLogValue(match.groups.playerName, 80) ?? "Unknown",
    message,
  };
}

async function listCandidateLogFiles(logsPath: string): Promise<CandidateLogFile[]> {
  let entries;
  try {
    entries = await fs.readdir(logsPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: CandidateLogFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const fileName = entry.name;
    const lowerName = fileName.toLowerCase();
    if (!lowerName.endsWith(".log") || lowerName.includes("backup")) {
      continue;
    }

    const filePath = path.join(logsPath, fileName);
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      continue;
    }

    candidates.push({
      key: path.resolve(filePath).toLowerCase(),
      filePath,
      fileName,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }

  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, MAX_LOG_FILES_PER_SCAN);
}

async function readRange(filePath: string, position: number, length: number) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readInitialMetadata(file: CandidateLogFile) {
  const headLength = Math.min(file.size, MAX_INITIAL_METADATA_BYTES);
  let text = headLength > 0 ? await readRange(file.filePath, 0, headLength).catch(() => "") : "";
  if (file.size > headLength) {
    const tailLength = Math.min(file.size - headLength, MAX_INITIAL_TAIL_BYTES);
    const tailStart = Math.max(headLength, file.size - tailLength);
    const tail = await readRange(file.filePath, tailStart, tailLength).catch(() => "");
    text = `${text}\n${tail}`;
  }

  return text;
}

function createSeededFileState(file: CandidateLogFile, nowIso: string): LogFileState {
  return {
    offset: file.size,
    partial: "",
    tileName: null,
    tileId: null,
    realmId: null,
    lastSeenAt: nowIso,
  };
}

async function seedFileState(file: CandidateLogFile, nowIso: string) {
  const fileState = createSeededFileState(file, nowIso);
  const seedText = await readInitialMetadata(file);
  for (const line of seedText.split(/\r?\n/)) {
    updateTileMetadata(fileState, line);
  }

  return fileState;
}

function splitCompleteLines(fileState: LogFileState, chunk: string) {
  const combined = `${fileState.partial ?? ""}${chunk}`;
  const complete = combined.endsWith("\n") || combined.endsWith("\r");
  const lines = combined.split(/\r?\n/);
  fileState.partial = complete ? "" : lines.pop()?.slice(-4096) ?? "";
  return complete ? lines.filter((line) => line.length > 0) : lines;
}

function buildExternalChatId(file: CandidateLogFile, createdAt: string, lineIndex: number, parsed: ParsedChatLine) {
  return `${file.fileName}:${createdAt}:${lineIndex}:${parsed.playerName}:${parsed.message}`.slice(0, 160);
}

async function postChatEntryToDiscord(config: AppConfig, entry: GameBridgeChatEntry) {
  const webhookUrl = config.operationsSettings.discordGameChatWebhookUrl.trim();
  if (!webhookUrl || entry.discordPostedAt) {
    return false;
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
    throw new Error(`Discord game chat webhook failed with status ${response.status}.`);
  }

  await markGameBridgeChatDiscordPosted(entry.id);
  return true;
}

async function processLogChunk(config: AppConfig, file: CandidateLogFile, fileState: LogFileState, chunk: string) {
  let recorded = 0;
  let posted = 0;
  let lineIndex = 0;
  for (const line of splitCompleteLines(fileState, chunk)) {
    lineIndex += 1;
    updateTileMetadata(fileState, line);
    const parsed = parseChatLine(line);
    if (!parsed) {
      continue;
    }

    const { entry, duplicate } = await recordGameBridgeChat({
      channel: "all",
      playerName: parsed.playerName,
      message: parsed.message,
      tileName: fileState.tileName,
      mapName: null,
      profileId: config.selectedProfileId,
      clientId: file.fileName,
      externalId: buildExternalChatId(file, parsed.createdAt, lineIndex, parsed),
      createdAt: parsed.createdAt,
    });

    if (!duplicate) {
      recorded += 1;
    }

    if (await postChatEntryToDiscord(config, entry).catch(() => false)) {
      posted += 1;
    }
  }

  return { recorded, posted };
}

async function scanGameChatLogsUnlocked(config: AppConfig) {
  const logsPath = getConfiguredServerLogsPath(config);
  if (!logsPath) {
    return { checkedFiles: 0, recorded: 0, posted: 0 };
  }

  const files = await listCandidateLogFiles(logsPath);
  const state = await readState();
  const nowIso = new Date().toISOString();
  const liveKeys = new Set(files.map((file) => file.key));
  let recorded = 0;
  let posted = 0;

  for (const file of files) {
    let fileState = state.files[file.key];
    if (!fileState) {
      fileState = await seedFileState(file, nowIso);
      state.files[file.key] = fileState;
      continue;
    }

    if (file.size < fileState.offset) {
      fileState.offset = 0;
      fileState.partial = "";
    }

    if (file.size > fileState.offset) {
      const startOffset = fileState.offset;
      const bytesToRead = Math.min(file.size - startOffset, MAX_READ_BYTES_PER_FILE);
      const chunk = await readRange(file.filePath, startOffset, bytesToRead).catch(() => "");
      fileState.offset = startOffset + Buffer.byteLength(chunk, "utf8");
      const result = await processLogChunk(config, file, fileState, chunk);
      recorded += result.recorded;
      posted += result.posted;
    }

    fileState.lastSeenAt = nowIso;
  }

  for (const key of Object.keys(state.files)) {
    if (!liveKeys.has(key)) {
      delete state.files[key];
    }
  }

  await writeState(state);
  return { checkedFiles: files.length, recorded, posted };
}

export async function scanGameChatLogs(config: AppConfig) {
  if (scanLock) {
    return { checkedFiles: 0, recorded: 0, posted: 0, skipped: true };
  }

  let releaseLock: () => void = () => undefined;
  scanLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  try {
    return await scanGameChatLogsUnlocked(config);
  } finally {
    releaseLock();
    scanLock = null;
  }
}
