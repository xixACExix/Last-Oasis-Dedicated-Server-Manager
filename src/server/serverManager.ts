import { execFile } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSON5 from "json5";
import { buildLastOasisArguments } from "../shared/lastOasis.js";
import type {
  AdminDataSummary,
  AppConfig,
  BackupSummary,
  DashboardState,
  GameUpdateCheckResult,
  HealthCheck,
  LaunchStatus,
  LivePlayerSummary,
  LiveServerSummary,
  LogFileSummary,
  LogTailResponse,
  ModSummary,
  MyRealmSessionSnapshot,
  PlayerActivityEntry,
  SchedulerStatus,
  ServerProcess,
} from "../shared/types.js";
import { getProfileDataPath } from "./configStore.js";

const execFileAsync = promisify(execFile);
const WORKSHOP_CACHE_TTL_MS = 5 * 60 * 1000;
const DASHBOARD_MODS_CACHE_TTL_MS = 30 * 1000;
const MOD_UPDATE_TIMESTAMP_TOLERANCE_MS = 2 * 60 * 1000;
const LAST_OASIS_BASE_APP_ID = 903950;

type WorkshopMetadata = Record<string, unknown>;
type ModSyncStateEntry = {
  modId: string;
  serverModsPath: string;
  workshopUpdatedAt: string | null;
  syncedAt: string;
  title?: string | null;
};

type ModSyncStateFile = {
  version: 1;
  mods: Record<string, ModSyncStateEntry>;
};
type ProcessLaunchHints = {
  processId: number;
  identifier: string | null;
  gamePort: number | null;
  queryPort: number | null;
};

type LaunchConflict = {
  processId: number;
  reason: string;
};

type StartAllServersResult = {
  started: Array<{
    profileId: string;
    profileName: string;
    pid: number;
    note?: string;
  }>;
  skipped: Array<{
    profileId: string;
    profileName: string;
    reason: string;
  }>;
  failed: Array<{
    profileId: string;
    profileName: string;
    reason: string;
  }>;
};

let workshopMetadataCache: {
  fetchedAt: number;
  items: Map<string, WorkshopMetadata>;
} = {
  fetchedAt: 0,
  items: new Map(),
};

let playerActivityCache: {
  key: string;
  value: PlayerActivityEntry[];
} | null = null;

let recentGameplayCache: {
  key: string;
  value: RecentGameplaySession[];
} | null = null;

let dedicatedTileSnapshotCache: {
  key: string;
  value: DedicatedServerTileSnapshot[];
} | null = null;

let modsCache: {
  key: string;
  expiresAt: number;
  value: ModSummary[];
} | null = null;

function escapePowerShell(input: string) {
  return input.replace(/'/g, "''");
}

function isPrivateIpv4(address: string) {
  if (/^10\./.test(address)) {
    return true;
  }

  if (/^192\.168\./.test(address)) {
    return true;
  }

  const match = address.match(/^172\.(\d+)\./);
  if (!match) {
    return false;
  }

  const octet = Number.parseInt(match[1] ?? "", 10);
  return octet >= 16 && octet <= 31;
}

function scoreLocalAddress(interfaceName: string, address: string) {
  let score = 0;

  if (/^192\.168\./.test(address)) {
    score += 300;
  } else if (/^10\./.test(address)) {
    score += 250;
  } else if (isPrivateIpv4(address)) {
    score += 200;
  }

  if (/ethernet|wi-?fi|wlan/i.test(interfaceName)) {
    score += 50;
  }

  if (/virtual|vmware|hyper-v|loopback|teredo/i.test(interfaceName)) {
    score -= 100;
  }

  return score;
}

function parseLooseJson<T>(raw: string): T {
  return JSON5.parse(raw) as T;
}

async function pathExists(targetPath: string) {
  if (!targetPath.trim()) {
    return false;
  }

  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  return parseLooseJson<T>(await fs.readFile(filePath, "utf8"));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAcfValue(raw: string, key: string) {
  const match = raw.match(new RegExp(`"${escapeRegExp(key)}"\\s*"([^"]*)"`, "i"));
  return match?.[1] ?? null;
}

function findSteamAppsRootFromPath(candidatePath: string) {
  const parts = path.resolve(candidatePath).split(path.sep);
  const steamAppsIndex = parts.findIndex((part) => part.toLowerCase() === "steamapps");
  if (steamAppsIndex < 0) {
    return null;
  }

  return parts.slice(0, steamAppsIndex + 1).join(path.sep);
}

function isSameOrChildPath(parentPath: string, candidatePath: string) {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relativePath === "" || (relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function getSelectedProfile(config: AppConfig) {
  return config.profiles.find((profile) => profile.id === config.selectedProfileId) ?? config.profiles[0] ?? null;
}

export function getConfiguredServerInstallPath(config: AppConfig) {
  const selectedProfile = getSelectedProfile(config);
  const profileRoot = selectedProfile ? getProfileServerInstallRoot(selectedProfile) : "";
  return profileRoot;
}

export function getConfiguredServerSavedPath(config: AppConfig) {
  const serverInstallPath = getConfiguredServerInstallPath(config);
  return serverInstallPath ? path.join(serverInstallPath, "Mist", "Saved") : "";
}

export function getConfiguredServerLogsPath(config: AppConfig) {
  const savedPath = getConfiguredServerSavedPath(config);
  return savedPath ? path.join(savedPath, "Logs") : "";
}

export function getConfiguredServerAdminDataPath(config: AppConfig) {
  const savedPath = getConfiguredServerSavedPath(config);
  return savedPath ? path.join(savedPath, "AdminData.json") : "";
}

function buildGameManifestCandidates(config: AppConfig) {
  const appId = config.operationsSettings.appId;
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addManifest = (manifestPath: string | null | undefined) => {
    if (!manifestPath) {
      return;
    }

    const resolvedPath = path.resolve(manifestPath);
    const key = resolvedPath.toLowerCase();
    if (!seen.has(key)) {
      candidates.push(resolvedPath);
      seen.add(key);
    }
  };
  const addSteamAppsManifest = (steamAppsRoot: string | null | undefined) => {
    if (steamAppsRoot) {
      addManifest(path.join(steamAppsRoot, `appmanifest_${appId}.acf`));
    }
  };

  const installPath = getConfiguredServerInstallPath(config);
  if (installPath) {
    addSteamAppsManifest(findSteamAppsRootFromPath(installPath));
    addManifest(path.join(installPath, "steamapps", `appmanifest_${appId}.acf`));
    addManifest(path.join(path.dirname(installPath), `appmanifest_${appId}.acf`));
    addManifest(path.join(path.dirname(path.dirname(installPath)), `appmanifest_${appId}.acf`));
  }

  const steamCmdInstallDirectory = config.operationsSettings.steamCmdInstallDirectory.trim();
  if (installPath && steamCmdInstallDirectory) {
    addManifest(path.join(steamCmdInstallDirectory, "steamapps", `appmanifest_${appId}.acf`));
  }

  return candidates;
}

async function readGameAppManifest(config: AppConfig) {
  for (const manifestPath of buildGameManifestCandidates(config)) {
    if (!(await pathExists(manifestPath))) {
      continue;
    }

    const raw = await fs.readFile(manifestPath, "utf8");
    return {
      path: manifestPath,
      buildId: parseAcfValue(raw, "buildid"),
      lastUpdated: parseAcfValue(raw, "LastUpdated"),
    };
  }

  return null;
}

function parseSteamAppInfoBuild(raw: string, branchName: string) {
  const branch = branchName.trim() || "public";
  const branchMatch = raw.match(new RegExp(`"${escapeRegExp(branch)}"\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, "i"));
  const branchBody = branchMatch?.[1] ?? raw;
  return {
    buildId: parseAcfValue(branchBody, "buildid") ?? parseAcfValue(raw, "buildid"),
    timeUpdated: parseAcfValue(branchBody, "timeupdated") ?? parseAcfValue(raw, "timeupdated"),
  };
}

function decodeJsonStringLiteral(value: string) {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function stripUtf8Bom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

async function setServerModActiveState(modDirectoryPath: string, active: boolean) {
  const modInfoPath = path.join(modDirectoryPath, "modinfo.json");
  if (!(await pathExists(modInfoPath))) {
    return null;
  }

  const persistedRawModInfo = await fs.readFile(modInfoPath, "utf8");
  const rawModInfo = stripUtf8Bom(persistedRawModInfo);
  const activeMatch = rawModInfo.match(/("active"\s*:\s*)(true|false)/);
  if (!activeMatch) {
    if (persistedRawModInfo !== rawModInfo) {
      await fs.writeFile(modInfoPath, rawModInfo, "utf8");
    }
    return null;
  }

  const currentlyActive = activeMatch[2] === "true";
  if (currentlyActive === active && persistedRawModInfo === rawModInfo) {
    return null;
  }

  const titleMatch = rawModInfo.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const nextRawModInfo = rawModInfo.replace(/("active"\s*:\s*)(true|false)/, `$1${active ? "true" : "false"}`);
  await fs.writeFile(modInfoPath, nextRawModInfo, "utf8");
  return titleMatch ? decodeJsonStringLiteral(titleMatch[1]) : path.basename(modDirectoryPath);
}

async function synchronizeServerModActivation(modsPath: string, activeModIds: string[]) {
  if (!(await pathExists(modsPath))) {
    return {
      activated: [] as string[],
      deactivated: [] as string[],
    };
  }

  const wanted = new Set(activeModIds.map((modId) => modId.trim()).filter(Boolean));
  const candidateIds = (await fs.readdir(modsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const changes = await Promise.all(
    candidateIds.map(async (modId) => {
      const modDirectoryPath = path.join(modsPath, modId);
      if (!(await pathExists(modDirectoryPath))) {
        return null;
      }

      const changedMod = await setServerModActiveState(modDirectoryPath, wanted.has(modId));
      if (!changedMod) {
        return null;
      }

      return {
        modId,
        title: changedMod,
        active: wanted.has(modId),
      };
    }),
  );

  return {
    activated: changes
      .filter(
        (entry): entry is { modId: string; title: string; active: boolean } => entry !== null && entry.active,
      )
      .map((entry) => entry.title),
    deactivated: changes
      .filter(
        (entry): entry is { modId: string; title: string; active: boolean } => entry !== null && !entry.active,
      )
      .map((entry) => entry.title),
  };
}

async function synchronizeServerModsForLaunch(modsPath: string, activeModIds: string[]) {
  return synchronizeServerModActivation(modsPath, activeModIds);
}

async function sanitizeModCopiesUnderRoot(rootPath: string, modIds: string[] = []) {
  if (!(await pathExists(rootPath))) {
    return [] as string[];
  }

  const candidateIds =
    modIds.length > 0
      ? [...new Set(modIds.map((modId) => modId.trim()).filter(Boolean))]
      : (await fs.readdir(rootPath, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);

  const deactivated = new Set<string>();

  for (const modId of candidateIds) {
    const modDirectoryPath = path.join(rootPath, modId);
    if (!(await pathExists(modDirectoryPath))) {
      continue;
    }

    const sanitized = await sanitizeServerModInfoFile(modDirectoryPath);
    if (sanitized?.deactivated) {
      deactivated.add(sanitized.title);
    }
  }

  return [...deactivated];
}

async function sanitizeDedicatedServerModCopies(workingDirectory: string, modIds: string[] = []) {
  const serverInstallRoot = inferServerInstallRootFromDirectory(workingDirectory);
  const roots = [
    path.join(serverInstallRoot, "steamapps", "workshop", "content", "903950"),
    path.join(serverInstallRoot, "tools", "steamcmd", "steamapps", "workshop", "content", "903950"),
  ];

  const deactivated = new Set<string>();

  for (const rootPath of roots) {
    for (const title of await sanitizeModCopiesUnderRoot(rootPath, modIds)) {
      deactivated.add(title);
    }
  }

  return [...deactivated];
}

async function repairSavedModReferences(serverInstallRoot: string) {
  const modsPath = path.join(serverInstallRoot, "Mist", "Content", "Mods");
  const savedPath = path.join(serverInstallRoot, "Mist", "Saved");
  if (!(await pathExists(savedPath))) {
    return {
      staleIds: [] as string[],
      rewrittenFiles: [] as string[],
      backupRoot: null as string | null,
    };
  }

  const backupRoot = path.join(
    savedPath,
    "LOManagerModRepair",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const candidatePathRegex = /(mod|workshop|mistmod|sqlite|database|session|realm|gameplay|config)/i;
  const contentHintRegex = /(mods\s*=|workshop|mistmod|last session mod|active mod)/i;
  const idRegex = /(?<!\d)\d{9,12}(?!\d)/g;
  const excludedPathRegex = /(\\LOManagerModRepair\\|\\Logs\\|\\Crashes\\|\.disabled-by-manager$)/i;
  const textExtensions = new Set([".ini", ".cfg", ".txt", ".json", ".xml", ".csv"]);

  await fs.mkdir(modsPath, { recursive: true });
  const activeModIds = (await fs.readdir(modsPath, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^\d{9,12}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (!activeModIds.length) {
    return {
      staleIds: [] as string[],
      rewrittenFiles: [] as string[],
      backupRoot: null as string | null,
    };
  }

  const files = await (async function walk(currentPath: string): Promise<string[]> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    const found: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (excludedPathRegex.test(fullPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        found.push(...(await walk(fullPath)));
        continue;
      }

      if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
        found.push(fullPath);
      }
    }

    return found;
  })(savedPath);

  const rewrittenFiles: string[] = [];
  const staleIds = new Set<string>();
  let backupInitialized = false;

  for (const filePath of files) {
    let raw = "";
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 32 * 1024 * 1024) {
        continue;
      }

      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    if (!raw) {
      continue;
    }

    if (!candidatePathRegex.test(filePath) && !contentHintRegex.test(raw)) {
      continue;
    }

    const idsInFile = [...new Set(raw.match(idRegex) ?? [])];
    const missingIds = idsInFile.filter((modId) => !activeModIds.includes(modId));
    if (!missingIds.length) {
      continue;
    }

    missingIds.forEach((modId) => staleIds.add(modId));

    if (!backupInitialized) {
      await fs.mkdir(backupRoot, { recursive: true });
      backupInitialized = true;
    }

    const relativePath = path.relative(savedPath, filePath);
    const backupPath = path.join(backupRoot, relativePath);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(filePath, backupPath);

    const filteredLines = raw
      .split(/\r?\n/)
      .filter((line) => missingIds.every((modId) => !line.includes(modId)))
      .join(os.EOL)
      .trimEnd();

    await fs.writeFile(filePath, filteredLines, "utf8");
    rewrittenFiles.push(filePath);
  }

  return {
    staleIds: [...staleIds].sort(),
    rewrittenFiles,
    backupRoot: backupInitialized ? backupRoot : null,
  };
}

async function emptyDirectory(targetPath: string) {
  if (!(await pathExists(targetPath))) {
    await fs.mkdir(targetPath, { recursive: true });
    return;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(targetPath, entry.name);
      await fs.rm(fullPath, { recursive: true, force: true });
    }),
  );
}

async function pruneMissingModFolders(targetModsPath: string, keepModIds: string[]) {
  if (!(await pathExists(targetModsPath))) {
    return [] as string[];
  }

  const keep = new Set(keepModIds);
  const removed: string[] = [];
  const entries = await fs.readdir(targetModsPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{9,12}$/.test(entry.name) || keep.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(targetModsPath, entry.name);
    await fs.rm(fullPath, { recursive: true, force: true });
    removed.push(entry.name);
  }

  return removed;
}

function parseLaunchHints(processInfo: ServerProcess): ProcessLaunchHints {
  const commandLine = processInfo.commandLine ?? "";
  const queryPortMatch = commandLine.match(/-QueryPort=(\d+)/i);
  const gamePortMatch = commandLine.match(/-port=(\d+)/i);
  const identifierMatch = commandLine.match(/-identifier=([^\s"]+)/i);

  return {
    processId: processInfo.pid,
    identifier: identifierMatch?.[1] ?? null,
    gamePort: gamePortMatch ? Number.parseInt(gamePortMatch[1], 10) : null,
    queryPort: queryPortMatch ? Number.parseInt(queryPortMatch[1], 10) : null,
  };
}

function launchHintsMatchProfile(hints: Pick<ProcessLaunchHints, "identifier" | "gamePort" | "queryPort">, profile: AppConfig["profiles"][number]) {
  const identifierMatches = hints.identifier !== null && profile.launch.identifier.toLowerCase() === hints.identifier.toLowerCase();
  const gamePortMatches = hints.gamePort !== null && profile.launch.port === hints.gamePort;
  const queryPortMatches =
    hints.queryPort !== null && profile.launch.queryPort !== null && profile.launch.queryPort === hints.queryPort;

  return identifierMatches || gamePortMatches || queryPortMatches;
}

function extractProcessExecutablePath(commandLine: string | null | undefined) {
  const normalizedCommandLine = commandLine?.trim() ?? "";
  if (!normalizedCommandLine) {
    return "";
  }

  const quotedMatch = normalizedCommandLine.match(/^"([^"]+?\.exe)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const unquotedMatch = normalizedCommandLine.match(/^([A-Za-z]:\\[^\s"]+?\.exe)\b/i);
  return unquotedMatch?.[1] ?? "";
}

function getProcessExecutablePath(processInfo: ServerProcess) {
  return processInfo.executablePath?.trim() || extractProcessExecutablePath(processInfo.commandLine);
}

function processRunsUnderServerRoot(processInfo: ServerProcess, serverInstallRoot: string) {
  const normalizedRoot = serverInstallRoot.trim();
  if (!normalizedRoot) {
    return false;
  }

  const executablePath = getProcessExecutablePath(processInfo);
  if (executablePath) {
    try {
      if (isSameOrChildPath(normalizedRoot, executablePath)) {
        return true;
      }
    } catch {
      // Fall back to command-line text matching below.
    }
  }

  const rootText = path.resolve(normalizedRoot).toLowerCase();
  return Boolean(rootText && (processInfo.commandLine ?? "").toLowerCase().includes(rootText));
}

function serverProcessMatchesProfile(
  processInfo: ServerProcess,
  profile: AppConfig["profiles"][number],
  options: { includeServerRoot: boolean },
) {
  if (launchHintsMatchProfile(parseLaunchHints(processInfo), profile)) {
    return true;
  }

  return options.includeServerRoot && processRunsUnderServerRoot(processInfo, getProfileServerInstallRoot(profile));
}

export function serverProcessMatchesProfiles(
  processInfo: ServerProcess,
  profiles: AppConfig["profiles"],
  options: { includeServerRoot?: boolean } = {},
) {
  const includeServerRoot = options.includeServerRoot ?? false;
  return profiles.some((profile) => serverProcessMatchesProfile(processInfo, profile, { includeServerRoot }));
}

function findLaunchConflict(runningProcesses: ServerProcess[], profile: AppConfig["profiles"][number]): LaunchConflict | null {
  const processHints = runningProcesses.map(parseLaunchHints);

  const identifierConflict = processHints.find((entry) => entry.identifier && launchHintsMatchProfile({ ...entry, gamePort: null, queryPort: null }, profile));
  if (identifierConflict) {
    return {
      processId: identifierConflict.processId,
      reason: `Identifier ${profile.launch.identifier} is already running on PID ${identifierConflict.processId}.`,
    };
  }

  const gamePortConflict = processHints.find((entry) => entry.gamePort !== null && entry.gamePort === profile.launch.port);
  if (gamePortConflict) {
    return {
      processId: gamePortConflict.processId,
      reason: `Game port ${profile.launch.port} is already in use by PID ${gamePortConflict.processId}.`,
    };
  }

  if (profile.launch.queryPort !== null) {
    const queryPortConflict = processHints.find((entry) => entry.queryPort !== null && entry.queryPort === profile.launch.queryPort);
    if (queryPortConflict) {
      return {
        processId: queryPortConflict.processId,
        reason: `Query port ${profile.launch.queryPort} is already in use by PID ${queryPortConflict.processId}.`,
      };
    }
  }

  return null;
}

function readNullTerminatedString(buffer: Buffer, offset: number) {
  const end = buffer.indexOf(0x00, offset);
  const nextOffset = end >= 0 ? end + 1 : buffer.length;
  return {
    value: buffer.toString("utf8", offset, end >= 0 ? end : buffer.length),
    nextOffset,
  };
}

async function sendUdpRequest(host: string, port: number, payload: Buffer, timeoutMs = 800) {
  return await new Promise<Buffer>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.close();
      reject(new Error("Server query timed out."));
    }, timeoutMs);

    socket.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(error);
    });

    socket.once("message", (message) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });

    socket.send(payload, port, host, (error) => {
      if (!error || settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

function buildLogCacheKey(logFiles: LogFileSummary[], limit: number) {
  return logFiles
    .slice(0, limit)
    .map((entry) => `${entry.name}:${entry.modifiedAt}:${entry.sizeBytes}`)
    .join("|");
}

async function queryInfoPacket(host: string, port: number) {
  const basePayload = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from("Source Engine Query\0", "ascii")]);
  const first = await sendUdpRequest(host, port, basePayload);

  if (first[4] === 0x41 && first.length >= 9) {
    const challenge = first.subarray(5, 9);
    return sendUdpRequest(host, port, Buffer.concat([basePayload, challenge]));
  }

  return first;
}

async function queryPlayersPacket(host: string, port: number) {
  const request = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x55, 0xff, 0xff, 0xff, 0xff]);
  const challengeResponse = await sendUdpRequest(host, port, request);

  if (challengeResponse[4] !== 0x41 || challengeResponse.length < 9) {
    return challengeResponse;
  }

  const challenge = challengeResponse.subarray(5, 9);
  return sendUdpRequest(host, port, Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x55]), challenge]));
}

function buildOfflineLiveServerSummary(hints?: Partial<ProcessLaunchHints>, note?: string): LiveServerSummary {
  const hasRunningProcess = typeof hints?.processId === "number";

  return {
    processId: hints?.processId ?? null,
    identifier: hints?.identifier ?? null,
    gamePort: hints?.gamePort ?? null,
    online: false,
    status: hasRunningProcess ? "running" : "offline",
    serverName: null,
    map: null,
    game: null,
    version: null,
    playerCount: 0,
    maxPlayers: null,
    queryPort: hints?.queryPort ?? null,
    players: [],
    note: note ?? "Live query is unavailable.",
  };
}

function getServerInstallRoot(paths: Pick<AppConfig["paths"], "installPath" | "workingDirectory">) {
  return (paths.installPath || paths.workingDirectory || "").trim();
}

function getServerModsPathFromRoot(serverInstallRoot: string) {
  return path.join(serverInstallRoot, "Mist", "Content", "Mods");
}

function getServerModsPath(config: AppConfig) {
  const serverInstallPath = getConfiguredServerInstallPath(config);
  if (!serverInstallPath) {
    throw new Error("No selected host profile path is linked in the manager.");
  }

  return getServerModsPathFromRoot(serverInstallPath);
}

function inferServerInstallRootFromDirectory(directoryPath: string) {
  const trimmedDirectoryPath = directoryPath.trim();
  if (!trimmedDirectoryPath) {
    return "";
  }

  const normalizedDirectoryPath = path.normalize(trimmedDirectoryPath);
  const executableDirectorySuffix = path.normalize(path.join("Mist", "Binaries", "Win64")).toLowerCase();

  if (normalizedDirectoryPath.toLowerCase().endsWith(executableDirectorySuffix)) {
    return path.resolve(normalizedDirectoryPath, "..", "..", "..");
  }

  return normalizedDirectoryPath;
}

function resolveSteamRuntimePaths(workingDirectory: string, executablePath: string) {
  const executableDirectory = path.dirname(executablePath);
  const serverInstallRoot =
    inferServerInstallRootFromDirectory(executableDirectory) ||
    inferServerInstallRootFromDirectory(workingDirectory) ||
    executableDirectory;

  return {
    executableDirectory,
    serverInstallRoot,
    bundledSteamworksWin64Directory: path.join(
      serverInstallRoot,
      "Engine",
      "Binaries",
      "ThirdParty",
      "Steamworks",
      "Steamv149",
      "Win64",
    ),
  };
}

function getProfileServerInstallRoot(profile: Pick<AppConfig["profiles"][number], "workingDirectory" | "executablePath">) {
  return resolveSteamRuntimePaths(profile.workingDirectory, profile.executablePath).serverInstallRoot;
}

function getProfileServerModsPath(profile: Pick<AppConfig["profiles"][number], "workingDirectory" | "executablePath">) {
  return getServerModsPathFromRoot(getProfileServerInstallRoot(profile));
}

function isLiveServerHostingReady(server: LiveServerSummary) {
  return (
    server.processId !== null &&
    (server.status === "query" || server.status === "activity" || (server.status === "running" && Boolean(server.map)))
  );
}

const HOSTING_READY_FALLBACK_AGE_MS = 90_000;

function countStableRunningProcesses(runningProcesses: ServerProcess[], minimumAgeMs = HOSTING_READY_FALLBACK_AGE_MS) {
  const now = Date.now();
  return runningProcesses.filter((processInfo) => {
    if (!processInfo.startedAt) {
      return false;
    }

    const startedAt = Date.parse(processInfo.startedAt);
    if (!Number.isFinite(startedAt)) {
      return false;
    }

    return now - startedAt >= minimumAgeMs;
  }).length;
}

export function buildLaunchStatus(
  desiredHosts: number,
  processHosts: number,
  hostingReadyHosts?: number | null,
): LaunchStatus {
  const normalizedDesiredHosts = Math.max(0, desiredHosts);
  const normalizedProcessHosts = Math.max(0, processHosts);
  const hasExplicitHostingReadyCount = typeof hostingReadyHosts === "number" && Number.isFinite(hostingReadyHosts);
  const normalizedHostingReadyHosts = Math.max(
    0,
    Math.min(normalizedProcessHosts, hasExplicitHostingReadyCount ? Number(hostingReadyHosts) : 0),
  );
  const pendingHosts = Math.max(0, normalizedDesiredHosts - normalizedProcessHosts);
  const warmingHosts = Math.max(
    0,
    normalizedProcessHosts - (hasExplicitHostingReadyCount ? normalizedHostingReadyHosts : 0),
  );

  if (normalizedDesiredHosts === 0) {
    if (normalizedProcessHosts === 0) {
      return {
        phase: "idle",
        summary: "No realm hosts are queued or running right now.",
        desiredHosts: 0,
        processHosts: 0,
        hostingReadyHosts: 0,
        warmingHosts: 0,
        pendingHosts: 0,
      };
    }

    if (hasExplicitHostingReadyCount && normalizedHostingReadyHosts > 0) {
      return {
        phase: "hosting",
        summary:
          normalizedHostingReadyHosts === normalizedProcessHosts
            ? `${normalizedHostingReadyHosts} host${normalizedHostingReadyHosts === 1 ? "" : "s"} ${normalizedHostingReadyHosts === 1 ? "is" : "are"} up and hosting with no desired host target saved.`
            : `${normalizedProcessHosts} server process${normalizedProcessHosts === 1 ? "" : "es"} are live with no desired host target saved. ${warmingHosts} host${warmingHosts === 1 ? "" : "s"} ${warmingHosts === 1 ? "is" : "are"} still warming up.`,
        desiredHosts: 0,
        processHosts: normalizedProcessHosts,
        hostingReadyHosts: normalizedHostingReadyHosts,
        warmingHosts,
        pendingHosts: 0,
      };
    }

    return {
      phase: "warming",
      summary: `${normalizedProcessHosts} server process${normalizedProcessHosts === 1 ? "" : "es"} ${normalizedProcessHosts === 1 ? "is" : "are"} live with no desired host target saved.`,
      desiredHosts: 0,
      processHosts: normalizedProcessHosts,
      hostingReadyHosts: normalizedHostingReadyHosts,
      warmingHosts,
      pendingHosts: 0,
    };
  }

  if (normalizedProcessHosts === 0) {
    return {
      phase: "launching",
      summary: `Launch requested for ${normalizedDesiredHosts} realm host${normalizedDesiredHosts === 1 ? "" : "s"}. Waiting for Windows to start the first dedicated server process.`,
      desiredHosts: normalizedDesiredHosts,
      processHosts: 0,
      hostingReadyHosts: 0,
      warmingHosts: 0,
      pendingHosts: normalizedDesiredHosts,
    };
  }

  if (!hasExplicitHostingReadyCount) {
    if (pendingHosts > 0) {
      return {
        phase: "launching",
        summary: `Windows has started ${normalizedProcessHosts} of ${normalizedDesiredHosts} dedicated server process${normalizedDesiredHosts === 1 ? "" : "es"}. ${pendingHosts} more ${pendingHosts === 1 ? "is" : "are"} still waiting to launch.`,
        desiredHosts: normalizedDesiredHosts,
        processHosts: normalizedProcessHosts,
        hostingReadyHosts: 0,
        warmingHosts: normalizedProcessHosts,
        pendingHosts,
      };
    }

    return {
      phase: "warming",
      summary: `All ${normalizedProcessHosts} requested server process${normalizedProcessHosts === 1 ? "" : "es"} are live. Waiting for tile load and MyRealm hosting readiness.`,
      desiredHosts: normalizedDesiredHosts,
      processHosts: normalizedProcessHosts,
      hostingReadyHosts: 0,
      warmingHosts: normalizedProcessHosts,
      pendingHosts: 0,
    };
  }

  if (normalizedHostingReadyHosts >= normalizedDesiredHosts) {
    return {
      phase: "hosting",
      summary: `All ${normalizedDesiredHosts} requested realm host${normalizedDesiredHosts === 1 ? "" : "s"} are up and hosting.`,
      desiredHosts: normalizedDesiredHosts,
      processHosts: normalizedProcessHosts,
      hostingReadyHosts: normalizedHostingReadyHosts,
      warmingHosts,
      pendingHosts,
    };
  }

  if (normalizedHostingReadyHosts > 0) {
    const parts = [
      `${normalizedHostingReadyHosts} host${normalizedHostingReadyHosts === 1 ? "" : "s"} ${normalizedHostingReadyHosts === 1 ? "is" : "are"} already hosting`,
    ];

    if (warmingHosts > 0) {
      parts.push(`${warmingHosts} ${warmingHosts === 1 ? "is" : "are"} still warming up`);
    }

    if (pendingHosts > 0) {
      parts.push(`${pendingHosts} ${pendingHosts === 1 ? "has" : "have"} not launched yet`);
    }

    return {
      phase: "partial",
      summary: `${parts.join(", ")}.`,
      desiredHosts: normalizedDesiredHosts,
      processHosts: normalizedProcessHosts,
      hostingReadyHosts: normalizedHostingReadyHosts,
      warmingHosts,
      pendingHosts,
    };
  }

  if (pendingHosts > 0) {
    return {
      phase: "launching",
      summary: `Windows has started ${normalizedProcessHosts} of ${normalizedDesiredHosts} dedicated server process${normalizedDesiredHosts === 1 ? "" : "es"}, and the launched host${normalizedProcessHosts === 1 ? " is" : "s are"} still waiting for tile load.`,
      desiredHosts: normalizedDesiredHosts,
      processHosts: normalizedProcessHosts,
      hostingReadyHosts: normalizedHostingReadyHosts,
      warmingHosts,
      pendingHosts,
    };
  }

  return {
    phase: "warming",
    summary: `All ${normalizedProcessHosts} requested server process${normalizedProcessHosts === 1 ? "" : "es"} are live. Waiting for ${warmingHosts} host${warmingHosts === 1 ? "" : "s"} to finish tile load and become hosted.`,
    desiredHosts: normalizedDesiredHosts,
    processHosts: normalizedProcessHosts,
    hostingReadyHosts: normalizedHostingReadyHosts,
    warmingHosts,
    pendingHosts: 0,
  };
}

async function queryLiveServerFromHints(hints: ProcessLaunchHints): Promise<LiveServerSummary> {
  if (!hints.queryPort) {
    return buildOfflineLiveServerSummary(hints, "No query port was found on the running process.");
  }

  try {
    const infoPacket = await queryInfoPacket("127.0.0.1", hints.queryPort);
    if (infoPacket[4] !== 0x49) {
      throw new Error("Unexpected A2S_INFO response.");
    }

    let offset = 6;
    const serverName = readNullTerminatedString(infoPacket, offset);
    offset = serverName.nextOffset;
    const map = readNullTerminatedString(infoPacket, offset);
    offset = map.nextOffset;
    const folder = readNullTerminatedString(infoPacket, offset);
    offset = folder.nextOffset;
    const game = readNullTerminatedString(infoPacket, offset);
    offset = game.nextOffset + 2;
    const playerCount = infoPacket[offset] ?? 0;
    offset += 1;
    const maxPlayers = infoPacket[offset] ?? 0;
    offset += 4;
    const version = readNullTerminatedString(infoPacket, offset);

    let players: LivePlayerSummary[] = [];
    try {
      const playersPacket = await queryPlayersPacket("127.0.0.1", hints.queryPort);
      if (playersPacket[4] === 0x44) {
        let playerOffset = 6;
        const count = playersPacket[5] ?? 0;
        players = [];

        for (let index = 0; index < count && playerOffset < playersPacket.length; index += 1) {
          playerOffset += 1;
          const name = readNullTerminatedString(playersPacket, playerOffset);
          playerOffset = name.nextOffset;
          const score = playersPacket.readInt32LE(playerOffset);
          playerOffset += 4;
          const durationSeconds = playersPacket.readFloatLE(playerOffset);
          playerOffset += 4;
          players.push({
            name: name.value || `Player ${index + 1}`,
            score,
            durationSeconds,
          });
        }
      }
    } catch {
      players = [];
    }

    return {
      processId: hints.processId,
      identifier: hints.identifier,
      gamePort: hints.gamePort,
      online: true,
      status: "query",
      serverName: serverName.value || null,
      map: map.value || folder.value || null,
      game: game.value || null,
      version: version.value || null,
      playerCount,
      maxPlayers,
      queryPort: hints.queryPort,
      players,
    };
  } catch (error) {
    return buildOfflineLiveServerSummary(hints, error instanceof Error ? error.message : "Live query is unavailable.");
  }
}

function rankLiveServerStatus(server: LiveServerSummary) {
  switch (server.status) {
    case "query":
      return 0;
    case "activity":
      return 1;
    case "running":
      return 2;
    case "offline":
    default:
      return 3;
  }
}

async function queryLiveServers(config: AppConfig, runningProcesses: ServerProcess[]): Promise<LiveServerSummary[]> {
  const selectedProfile = config.profiles.find((profile) => profile.id === config.selectedProfileId) ?? config.profiles[0] ?? null;
  const processHints = runningProcesses
    .map(parseLaunchHints)
    .filter((entry, index, entries) => entry.queryPort || entries.findIndex((candidate) => candidate.processId === entry.processId) === index);

  if (!processHints.length) {
    return [
      buildOfflineLiveServerSummary(
        selectedProfile
          ? {
              identifier: selectedProfile.launch.identifier,
              gamePort: selectedProfile.launch.port,
              queryPort: selectedProfile.launch.queryPort,
            }
          : undefined,
        selectedProfile ? "No live Last Oasis process is running right now." : "No profile is configured.",
      ),
    ];
  }

  const liveServers = await Promise.all(processHints.map((hints) => queryLiveServerFromHints(hints)));
  return liveServers.sort((left, right) => {
    const leftRank = rankLiveServerStatus(left);
    const rightRank = rankLiveServerStatus(right);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return (left.queryPort ?? 0) - (right.queryPort ?? 0);
  });
}

function parseLogTimestamp(stamp: string) {
  return stamp.replace(/^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})$/, "$1-$2-$3T$4:$5:$6.$7Z");
}

function normalizeMapName(raw: string) {
  const cleaned = raw.trim().split("?")[0];
  const segments = cleaned.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? cleaned;
}

async function readRecentPlayerActivity(logsPath: string, knownLogFiles?: LogFileSummary[]): Promise<PlayerActivityEntry[]> {
  if (!(await pathExists(logsPath))) {
    return [];
  }

  const files = (knownLogFiles ?? (await listLogFiles(logsPath)))
    .filter((file) => !file.name.toLowerCase().includes("backup"))
    .slice(0, 8);
  const cacheKey = buildLogCacheKey(files, 8);
  if (playerActivityCache?.key === cacheKey) {
    return playerActivityCache.value;
  }
  const entries: PlayerActivityEntry[] = [];

  for (const logFile of files) {
    const content = await fs.readFile(logFile.path, "utf8");
    const lines = content.split(/\r?\n/).slice(-4000);
    let currentTileName: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const tileMatch = line.match(/LogPersistence:\s+tile_name:\s+(?<tile>.+)$/);
      if (tileMatch?.groups?.tile) {
        currentTileName = tileMatch.groups.tile.trim();
        const stampedTile = line.match(/\[(?<stamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\]/);
        if (stampedTile?.groups?.stamp) {
          entries.push({
            activityType: "host_tile",
            playerName: "Server",
            uniqueNetId: "Server",
            observedAt: parseLogTimestamp(stampedTile.groups.stamp),
            mapName: currentTileName,
            characterId: null,
            connectionAddress: null,
            sourceLog: logFile.name,
            sourceLine: line,
          });
        }
        continue;
      }

      const mapMatch = line.match(
        /\[(?<stamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\].*(?:ProcessServerTravel|Server switch level|LogNet:\s+Browse:)\s+(?<map>\/Game\/Mist\/Maps\/[^\s]+)/,
      );
      if (mapMatch?.groups?.map) {
        currentTileName = normalizeMapName(mapMatch.groups.map);
      }

      const persistMatch = line.match(/\[(?<stamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\].*Persisting (?<name>.+?), UniqueNetId = (?<id>.+)$/);
      if (persistMatch?.groups) {
        entries.push({
          activityType: "persisted",
          playerName: persistMatch.groups.name.trim(),
          uniqueNetId: persistMatch.groups.id.trim(),
          observedAt: parseLogTimestamp(persistMatch.groups.stamp),
          mapName: currentTileName,
          characterId: null,
          connectionAddress: null,
          sourceLog: logFile.name,
          sourceLine: line,
        });
        continue;
      }

      const loginMatch = line.match(
        /\[(?<stamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\].*LogNet:\s+Login request:\s+\?CharacterId=(?<characterId>\d+).*?\?Name=(?<name>[^?\s]+).*?userId:\s+(?<userId>[^ ]+)/,
      );
      if (loginMatch?.groups) {
        entries.push({
          activityType: "login",
          playerName: loginMatch.groups.name.trim(),
          uniqueNetId: loginMatch.groups.userId.trim(),
          observedAt: parseLogTimestamp(loginMatch.groups.stamp),
          mapName: currentTileName,
          characterId: loginMatch.groups.characterId.trim(),
          connectionAddress: null,
          sourceLog: logFile.name,
          sourceLine: line,
        });
        continue;
      }

      const joinMatch = line.match(
        /\[(?<stamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\].*LogNet:\s+Join request:\s+(?<mapPath>[^?]+)\?CharacterId=(?<characterId>\d+).*?\?Name=(?<name>[^?\s]+)/,
      );
      if (joinMatch?.groups) {
        const mapPath = joinMatch.groups.mapPath.trim();
        entries.push({
          activityType: "join",
          playerName: joinMatch.groups.name.trim(),
          uniqueNetId: "Pending handshake",
          observedAt: parseLogTimestamp(joinMatch.groups.stamp),
          mapName: currentTileName ?? normalizeMapName(mapPath),
          characterId: joinMatch.groups.characterId.trim(),
          connectionAddress: null,
          sourceLog: logFile.name,
          sourceLine: line,
        });
        continue;
      }

      const disconnectMatch = line.match(
        /\[(?<stamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\].*LogNet:\s+UNetConnection::Close:\s+\[UNetConnection\]\s+RemoteAddr:\s+(?<address>[^,]+).*?UniqueId:\s+(?<userId>.+?),\s+Channels:/,
      );
      if (disconnectMatch?.groups) {
        entries.push({
          activityType: "disconnect",
          playerName: "Disconnected player",
          uniqueNetId: disconnectMatch.groups.userId.trim(),
          observedAt: parseLogTimestamp(disconnectMatch.groups.stamp),
          mapName: currentTileName,
          characterId: null,
          connectionAddress: disconnectMatch.groups.address.trim(),
          sourceLog: logFile.name,
          sourceLine: line,
        });
      }
    }
  }

  const sorted = entries.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const featured = sorted.filter((entry) => entry.activityType !== "persisted").slice(0, 20);
  const persisted = sorted.filter((entry) => entry.activityType === "persisted").slice(0, 20);

  const result = [...featured, ...persisted]
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
    .slice(0, 40);
  playerActivityCache = {
    key: cacheKey,
    value: result,
  };
  return result;
}

type RecentGameplaySession = {
  gamePort: number;
  connectedAt: string;
  lastSeenAt: string;
  mapName: string | null;
  disconnectedAt: string | null;
};

type DedicatedServerTileSnapshot = {
  identifier: string | null;
  gamePort: number | null;
  queryPort: number | null;
  tileName: string | null;
  mapName: string | null;
  tileId: string | null;
  realmId: string | null;
  hostingStartedAt: string | null;
  sourceLog: string;
  modifiedAt: string;
};

function scoreDedicatedServerTileSnapshot(snapshot: DedicatedServerTileSnapshot) {
  const tileName = snapshot.tileName?.trim() ?? "";
  const mapName = snapshot.mapName?.trim() ?? "";
  let score = 0;

  if (tileName && !/^empty$/i.test(tileName)) {
    score += 100;
  } else if (tileName) {
    score += 20;
  }

  if (mapName && !/^empty$/i.test(mapName)) {
    score += 60;
  } else if (mapName) {
    score += 10;
  }

  if (snapshot.identifier) {
    score += 5;
  }

  if (snapshot.gamePort !== null || snapshot.queryPort !== null) {
    score += 5;
  }

  return score;
}

function getDedicatedServerTileSnapshotTime(snapshot: DedicatedServerTileSnapshot) {
  const value = Date.parse(snapshot.hostingStartedAt ?? snapshot.modifiedAt);
  return Number.isFinite(value) ? value : 0;
}

function dedupeDedicatedServerTileSnapshots(snapshots: DedicatedServerTileSnapshot[]) {
  const withoutTileName: DedicatedServerTileSnapshot[] = [];
  const latestByTileName = new Map<string, DedicatedServerTileSnapshot>();

  for (const snapshot of snapshots) {
    const tileNameKey = snapshot.tileName?.trim().toLowerCase();
    if (!tileNameKey) {
      withoutTileName.push(snapshot);
      continue;
    }

    const existing = latestByTileName.get(tileNameKey);
    if (!existing || getDedicatedServerTileSnapshotTime(snapshot) >= getDedicatedServerTileSnapshotTime(existing)) {
      latestByTileName.set(tileNameKey, snapshot);
    }
  }

  return [...withoutTileName, ...latestByTileName.values()];
}

async function readLogStartupAndTail(logFile: LogFileSummary, startupBytes = 4 * 1024 * 1024, tailBytes = 2 * 1024 * 1024) {
  const size = logFile.sizeBytes;
  if (size <= startupBytes + tailBytes) {
    return fs.readFile(logFile.path, "utf8");
  }

  const handle = await fs.open(logFile.path, "r");
  try {
    const startupBuffer = Buffer.alloc(Math.min(size, startupBytes));
    const startup = await handle.read(startupBuffer, 0, startupBuffer.length, 0);
    const tailStart = Math.max(0, size - tailBytes);
    const tailBuffer = Buffer.alloc(size - tailStart);
    const tail = await handle.read(tailBuffer, 0, tailBuffer.length, tailStart);
    return `${startupBuffer.subarray(0, startup.bytesRead).toString("utf8")}\n${tailBuffer.subarray(0, tail.bytesRead).toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

async function inferRecentGameplaySessions(logsPath: string, knownLogFiles?: LogFileSummary[]): Promise<RecentGameplaySession[]> {
  if (!(await pathExists(logsPath))) {
    return [];
  }

  const latestLog = (knownLogFiles ?? (await listLogFiles(logsPath))).filter((file) => !file.name.toLowerCase().includes("backup"))[0];
  if (!latestLog) {
    return [];
  }

  const cacheKey = `${latestLog.name}:${latestLog.modifiedAt}:${latestLog.sizeBytes}`;
  if (recentGameplayCache?.key === cacheKey) {
    return recentGameplayCache.value;
  }

  const content = await fs.readFile(latestLog.path, "utf8");
  const lines = content.split(/\r?\n/).slice(-5000);
  const sessions = new Map<number, RecentGameplaySession>();
  let currentPort: number | null = null;
  let currentTileName: string | null = null;

  const updateSessionMap = (port: number | null, mapName: string, observedAt: string) => {
    if (port !== null && sessions.has(port)) {
      const session = sessions.get(port);
      if (session) {
        sessions.set(port, {
          ...session,
          mapName,
          lastSeenAt: observedAt,
        });
      }
      return;
    }

    const activeSessions = [...sessions.values()].filter((session) => !session.disconnectedAt);
    if (activeSessions.length === 1) {
      const loneSession = activeSessions[0];
      sessions.set(loneSession.gamePort, {
        ...loneSession,
        mapName,
        lastSeenAt: observedAt,
      });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const stampMatch = line.match(/\[(?<stamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\]/);
    const observedAt = stampMatch?.groups?.stamp ? parseLogTimestamp(stampMatch.groups.stamp) : new Date().toISOString();

    const browseMatch = line.match(/LogNet:\s+Browse:\s+(?<address>[^:]+):(?<port>\d+)\/Game\/Mist\/Maps\/Menu\?/);
    if (browseMatch?.groups?.port) {
      currentPort = Number.parseInt(browseMatch.groups.port, 10);
      if (Number.isFinite(currentPort)) {
        sessions.set(currentPort, {
          gamePort: currentPort,
          connectedAt: observedAt,
          lastSeenAt: observedAt,
          mapName: sessions.get(currentPort)?.mapName ?? null,
          disconnectedAt: null,
        });
      }
      continue;
    }

    const clientPortMatch = line.match(/LogNet:\s+Game client on port\s+(?<port>\d+)/);
    if (clientPortMatch?.groups?.port) {
      currentPort = Number.parseInt(clientPortMatch.groups.port, 10);
      continue;
    }

    const tileMatch = line.match(/LogPersistence:\s+tile_name:\s+(?<tile>.+)$/);
    if (tileMatch?.groups?.tile) {
      currentTileName = tileMatch.groups.tile.trim();
      updateSessionMap(currentPort, currentTileName, observedAt);
      continue;
    }

    const mapMatch = line.match(/\/Game\/Mist\/Maps\/(?:EA\/)?[^/]+\/(?<map>[^/]+)\//);
    if (mapMatch?.groups?.map) {
      currentTileName = normalizeMapName(mapMatch.groups.map);
      updateSessionMap(currentPort, currentTileName, observedAt);
      continue;
    }

    const disconnectMatch = line.match(/LogNet:\s+UNetConnection::Close:.*RemoteAddr:\s+[^:]+:(?<port>\d+),/);
    if (disconnectMatch?.groups?.port) {
      const disconnectedPort = Number.parseInt(disconnectMatch.groups.port, 10);
      if (Number.isFinite(disconnectedPort) && sessions.has(disconnectedPort)) {
        const session = sessions.get(disconnectedPort);
        if (session) {
          sessions.set(disconnectedPort, {
            ...session,
            lastSeenAt: observedAt,
            disconnectedAt: observedAt,
          });
        }
      }
    }
  }

  const result = [...sessions.values()].filter((session) => !session.disconnectedAt || session.disconnectedAt < session.connectedAt);
  recentGameplayCache = {
    key: cacheKey,
    value: result,
  };
  return result;
}

async function inferDedicatedServerTileSnapshots(serverLogsPath: string): Promise<DedicatedServerTileSnapshot[]> {
  if (!(await pathExists(serverLogsPath))) {
    return [];
  }

  const files = (await listLogFiles(serverLogsPath))
    .filter((file) => !file.name.toLowerCase().includes("backup"))
    .slice(0, 32);
  const cacheKey = buildLogCacheKey(files, 32);
  if (dedicatedTileSnapshotCache?.key === cacheKey) {
    return dedicatedTileSnapshotCache.value;
  }

  const snapshots: DedicatedServerTileSnapshot[] = [];

  for (const logFile of files) {
    const content = await readLogStartupAndTail(logFile).catch(() => "");
    const lines = content.split(/\r?\n/);
    let identifier: string | null = null;
    let gamePort: number | null = null;
    let queryPort: number | null = null;
    let tileName: string | null = null;
    let mapName: string | null = null;
    let tileId: string | null = null;
    let realmId: string | null = null;
    let hostingStartedAt: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const commandLineMatch = line.match(/LogInit:\s+Command Line:\s+(?<command>.+)$/);
      if (commandLineMatch?.groups?.command) {
        const command = commandLineMatch.groups.command;
        identifier = command.match(/-identifier=([^\s"]+)/i)?.[1] ?? identifier;
        const gamePortValue = command.match(/-port=(\d+)/i)?.[1];
        const queryPortValue = command.match(/-QueryPort=(\d+)/i)?.[1];
        gamePort = gamePortValue ? Number.parseInt(gamePortValue, 10) : gamePort;
        queryPort = queryPortValue ? Number.parseInt(queryPortValue, 10) : queryPort;
      }

      const startedMatch = line.match(/\[(?<stamp>\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\].*LogPersistence:\s+Started hosting tile/);
      if (startedMatch?.groups?.stamp) {
        hostingStartedAt = parseLogTimestamp(startedMatch.groups.stamp);
      }

      const realmMatch = line.match(/LogPersistence:\s+realm_id:\s+(?<realmId>.+)$/);
      if (realmMatch?.groups?.realmId) {
        realmId = realmMatch.groups.realmId.trim();
      }

      const tileMatch = line.match(/LogPersistence:\s+tile_name:\s+(?<tile>.+)$/);
      if (tileMatch?.groups?.tile) {
        tileName = tileMatch.groups.tile.trim();
      }

      const tileIdMatch = line.match(/LogPersistence:\s+tile_id:\s+(?<tileId>.+)$/);
      if (tileIdMatch?.groups?.tileId) {
        tileId = tileIdMatch.groups.tileId.trim();
      }

      const mapMatch = line.match(/(?:ProcessServerTravel|Server switch level):\s+(?<map>\/Game\/Mist\/Maps\/[^\s?]+)/);
      if (mapMatch?.groups?.map) {
        mapName = normalizeMapName(mapMatch.groups.map);
      }
    }

    if (identifier || gamePort !== null || queryPort !== null || tileName || hostingStartedAt) {
      snapshots.push({
        identifier,
        gamePort,
        queryPort,
        tileName,
        mapName,
        tileId,
        realmId,
        hostingStartedAt,
        sourceLog: logFile.name,
        modifiedAt: logFile.modifiedAt,
      });
    }
  }

  const dedupedSnapshots = dedupeDedicatedServerTileSnapshots(snapshots);
  dedicatedTileSnapshotCache = {
    key: cacheKey,
    value: dedupedSnapshots,
  };
  return dedupedSnapshots;
}

async function fetchWorkshopMetadata(modIds: string[]) {
  if (!modIds.length) {
    return new Map<string, Record<string, unknown>>();
  }

  const cacheIsFresh = Date.now() - workshopMetadataCache.fetchedAt < WORKSHOP_CACHE_TTL_MS;
  const cacheHasAllIds = modIds.every((modId) => workshopMetadataCache.items.has(modId));
  if (cacheIsFresh && cacheHasAllIds) {
    return new Map(modIds.map((modId) => [modId, workshopMetadataCache.items.get(modId) ?? {}]));
  }

  const body = new URLSearchParams();
  body.set("itemcount", String(modIds.length));
  modIds.forEach((modId, index) => {
    body.set(`publishedfileids[${index}]`, modId);
  });

  const response = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
    method: "POST",
    body,
  });

  if (!response.ok) {
    throw new Error(`Workshop metadata request failed with status ${response.status}.`);
  }

  const json = (await response.json()) as {
    response?: { publishedfiledetails?: Array<Record<string, unknown>> };
  };

  const entries = json.response?.publishedfiledetails ?? [];
  workshopMetadataCache = {
    fetchedAt: Date.now(),
    items: new Map(entries.map((entry) => [String(entry.publishedfileid), entry])),
  };
  return new Map(entries.map((entry) => [String(entry.publishedfileid), entry]));
}

function getWorkshopUpdatedAt(workshop: Record<string, unknown> | undefined) {
  return workshop && typeof workshop.time_updated === "number" ? new Date(workshop.time_updated * 1000).toISOString() : null;
}

function parseTimestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isTimestampNewer(newer: string | null | undefined, older: string | null | undefined) {
  const newerTimestamp = parseTimestamp(newer);
  const olderTimestamp = parseTimestamp(older);
  return Number.isFinite(newerTimestamp) && (!Number.isFinite(olderTimestamp) || newerTimestamp > olderTimestamp + MOD_UPDATE_TIMESTAMP_TOLERANCE_MS);
}

function isTimestampCurrentOrNewer(current: string | null | undefined, required: string | null | undefined) {
  const currentTimestamp = parseTimestamp(current);
  const requiredTimestamp = parseTimestamp(required);
  return Number.isFinite(currentTimestamp) && Number.isFinite(requiredTimestamp) && currentTimestamp + MOD_UPDATE_TIMESTAMP_TOLERANCE_MS >= requiredTimestamp;
}

function getModSyncStatePath() {
  return path.join(getProfileDataPath(), "mod-sync-state.json");
}

function getModSyncStateKey(config: AppConfig, modId: string) {
  return `${path.normalize(getServerModsPath(config)).toLowerCase()}|${modId}`;
}

async function readModSyncState(): Promise<ModSyncStateFile> {
  try {
    const raw = await fs.readFile(getModSyncStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ModSyncStateFile>;
    return {
      version: 1,
      mods: parsed.mods && typeof parsed.mods === "object" ? parsed.mods : {},
    };
  } catch {
    return {
      version: 1,
      mods: {},
    };
  }
}

async function writeModSyncState(state: ModSyncStateFile) {
  const statePath = getModSyncStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function getSteamCmdWorkshopContentRoot(config: AppConfig) {
  const installDirectory =
    config.operationsSettings.steamCmdInstallDirectory.trim() ||
    (config.operationsSettings.steamCmdPath ? path.dirname(config.operationsSettings.steamCmdPath) : "").trim();

  return installDirectory ? path.join(installDirectory, "steamapps", "workshop", "content", "903950") : "";
}

function getDesktopWorkshopContentRoots(config: AppConfig) {
  const roots = new Set<string>();

  if (config.operationsSettings.workshopContentPath.trim()) {
    roots.add(config.operationsSettings.workshopContentPath.trim());
  }

  roots.add("C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\903950");
  roots.add("C:\\Program Files\\Steam\\steamapps\\workshop\\content\\903950");

  return [...roots];
}

function getWorkshopContentRoots(config: AppConfig) {
  const roots = new Set<string>();

  const steamCmdWorkshopRoot = getSteamCmdWorkshopContentRoot(config);
  if (steamCmdWorkshopRoot) {
    roots.add(steamCmdWorkshopRoot);
  }

  for (const root of getDesktopWorkshopContentRoots(config)) {
    roots.add(root);
  }

  return [...roots];
}

async function mirrorWorkshopModToRoots(sourcePath: string, modId: string, targetRoots: string[]) {
  const mirroredRoots: string[] = [];
  const normalizedSourcePath = path.normalize(sourcePath).toLowerCase();

  for (const root of targetRoots) {
    if (!root) {
      continue;
    }

    await fs.mkdir(root, { recursive: true });
    const destinationPath = path.join(root, modId);
    if (path.normalize(destinationPath).toLowerCase() === normalizedSourcePath) {
      continue;
    }

    await fs.rm(destinationPath, { recursive: true, force: true });
    await fs.cp(sourcePath, destinationPath, { recursive: true, force: true });
    mirroredRoots.push(root);
  }

  return mirroredRoots;
}

async function resolveWorkshopModSourcePath(config: AppConfig, modId: string) {
  for (const root of getWorkshopContentRoots(config)) {
    if (!root || !(await pathExists(root))) {
      continue;
    }

    const candidate = path.join(root, modId);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function getNewestFileTimestamp(modPath: string) {
  const pending = [modPath];
  let newest = Number.NaN;

  while (pending.length) {
    const currentPath = pending.pop();
    if (!currentPath) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const stat = await fs.stat(entryPath);
        newest = Number.isFinite(newest) ? Math.max(newest, stat.mtimeMs) : stat.mtimeMs;
      } catch {
        // Ignore files that disappear or lock during the scan.
      }
    }
  }

  if (Number.isFinite(newest)) {
    return new Date(newest).toISOString();
  }

  try {
    const stat = await fs.stat(modPath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

async function sanitizeServerModInfoFile(modDirectoryPath: string) {
  const modInfoPath = path.join(modDirectoryPath, "modinfo.json");
  if (!(await pathExists(modInfoPath))) {
    return null;
  }

  const raw = await fs.readFile(modInfoPath, "utf8");
  let sanitized = stripUtf8Bom(raw);
  const activeMatch = sanitized.match(/("active"\s*:\s*)(true|false)/);
  const titleMatch = sanitized.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (activeMatch && activeMatch[2] !== "false") {
    sanitized = sanitized.replace(/("active"\s*:\s*)(true|false)/, '$1false');
  }

  if (sanitized !== raw) {
    await fs.writeFile(modInfoPath, sanitized, "utf8");
  }

  return {
    title: titleMatch ? decodeJsonStringLiteral(titleMatch[1]) : path.basename(modDirectoryPath),
    deactivated: Boolean(activeMatch && activeMatch[2] !== "false"),
  };
}

async function sanitizeModCopiesAtPaths(modDirectoryPaths: string[]) {
  const deactivated = new Set<string>();

  for (const modDirectoryPath of modDirectoryPaths) {
    if (!modDirectoryPath || !(await pathExists(modDirectoryPath))) {
      continue;
    }

    const sanitized = await sanitizeServerModInfoFile(modDirectoryPath);
    if (sanitized?.deactivated) {
      deactivated.add(sanitized.title);
    }
  }

  return [...deactivated];
}

export async function readMods(config: AppConfig): Promise<ModSummary[]> {
  const workshopRoots = getWorkshopContentRoots(config);
  const serverModsPath = getServerModsPath(config);
  const cacheKey = JSON.stringify({
    workshopRoots,
    serverModsPath,
    modIds: config.operationsSettings.modIds,
  });

  if (modsCache && modsCache.key === cacheKey && modsCache.expiresAt > Date.now()) {
    return modsCache.value;
  }

  const metadata = await fetchWorkshopMetadata(config.operationsSettings.modIds).catch(() => new Map<string, Record<string, unknown>>());
  const modSyncState = await readModSyncState();
  let modSyncStateChanged = false;
  const summaries: ModSummary[] = [];

  for (const modId of config.operationsSettings.modIds) {
    const localPath = await resolveWorkshopModSourcePath(config, modId);
    const serverPath = path.join(serverModsPath, modId);
    const localInfoPath = localPath ? path.join(localPath, "modinfo.json") : null;
    const serverInfoPath = path.join(serverPath, "modinfo.json");
    const stateKey = getModSyncStateKey(config, modId);
    let localInfo: Record<string, unknown> | null = null;
    let serverInfo: Record<string, unknown> | null = null;
    let localUpdatedAt: string | null = null;
    let serverUpdatedAt: string | null = null;

    if (localPath && (await pathExists(localPath))) {
      localUpdatedAt = await getNewestFileTimestamp(localPath);
    }

    const serverInstalled = await pathExists(serverPath);
    if (serverInstalled) {
      serverUpdatedAt = await getNewestFileTimestamp(serverPath);
    }

    if (localInfoPath && (await pathExists(localInfoPath))) {
      localInfo = parseLooseJson<Record<string, unknown>>(stripUtf8Bom(await fs.readFile(localInfoPath, "utf8")));
    }

    if (await pathExists(serverInfoPath)) {
      serverInfo = parseLooseJson<Record<string, unknown>>(stripUtf8Bom(await fs.readFile(serverInfoPath, "utf8")));
    }

    const workshop = metadata.get(modId);
    const workshopUpdatedAt = getWorkshopUpdatedAt(workshop);
    const stateAppliedWorkshopUpdatedAt = modSyncState.mods[stateKey]?.workshopUpdatedAt ?? null;
    let appliedWorkshopUpdatedAt = stateAppliedWorkshopUpdatedAt;
    const effectiveInfo = serverInfo ?? localInfo;
    const title = typeof workshop?.title === "string" ? workshop.title : typeof effectiveInfo?.title === "string" ? effectiveInfo.title : modId;

    if (!appliedWorkshopUpdatedAt && serverInstalled && workshopUpdatedAt && isTimestampCurrentOrNewer(serverUpdatedAt, workshopUpdatedAt)) {
      appliedWorkshopUpdatedAt = workshopUpdatedAt;
      modSyncState.mods[stateKey] = {
        modId,
        serverModsPath,
        workshopUpdatedAt,
        syncedAt: new Date().toISOString(),
        title,
      };
      modSyncStateChanged = true;
    }

    const localVersion = localInfo?.version as Record<string, number> | undefined;
    const versionLabel =
      localVersion && typeof localVersion === "object"
        ? [localVersion.Main, localVersion.Major, localVersion.Minor, localVersion.Micro].filter((part) => typeof part === "number").join(".")
        : null;
    const localSyncPending = !workshopUpdatedAt && isTimestampNewer(localUpdatedAt, serverUpdatedAt);
    const syncPending = !serverInstalled && Boolean(localPath || workshopUpdatedAt);
    const workshopUpdatePending = Boolean(workshopUpdatedAt && (!serverInstalled || isTimestampNewer(workshopUpdatedAt, appliedWorkshopUpdatedAt)));
    const activeValue =
      typeof serverInfo?.active === "boolean"
        ? serverInfo.active
        : typeof localInfo?.active === "boolean"
          ? localInfo.active
          : null;

    summaries.push({
      modId,
      title,
      localTitle: typeof effectiveInfo?.title === "string" ? effectiveInfo.title : null,
      description: typeof workshop?.description === "string" ? workshop.description : typeof effectiveInfo?.description === "string" ? effectiveInfo.description : null,
      tag: typeof effectiveInfo?.tag === "string" ? effectiveInfo.tag : null,
      folderName: typeof effectiveInfo?.folderName === "string" ? effectiveInfo.folderName : null,
      active: activeValue,
      modKitVersion: typeof effectiveInfo?.modKitVersion === "number" ? effectiveInfo.modKitVersion : null,
      versionLabel,
      creator: workshop && typeof workshop.creator === "string" ? workshop.creator : typeof effectiveInfo?.creator === "number" ? String(effectiveInfo.creator) : null,
      previewUrl: workshop && typeof workshop.preview_url === "string" ? workshop.preview_url : null,
      workshopUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${modId}`,
      localPath,
      serverPath: serverInstalled ? serverPath : null,
      localUpdatedAt,
      serverUpdatedAt,
      workshopUpdatedAt,
      serverInstalled,
      hasWorkshopMetadata: Boolean(workshop),
      updateAvailable: workshopUpdatePending || localSyncPending || syncPending,
      deprecated: typeof effectiveInfo?.modKitVersion === "number" && effectiveInfo.modKitVersion < 3,
    });
  }

  if (modSyncStateChanged) {
    await writeModSyncState(modSyncState).catch(() => undefined);
  }

  modsCache = {
    key: cacheKey,
    expiresAt: Date.now() + DASHBOARD_MODS_CACHE_TTL_MS,
    value: summaries,
  };
  return summaries;
}

async function releaseHeldSteamRuntimeIfIdle() {
  // The working baseline launcher never rewrote Steam registry state during
  // normal server operation, so there is nothing to release here anymore.
  return true;
}

export async function releaseSteamRegistryIfIdle() {
  // Keep this export as a no-op so the rest of the backend can call it safely
  // without reviving the old registry lease path.
  return true;
}

async function resolveLaunchExecutable(profile: AppConfig["profiles"][number]) {
  const directExecutable = profile.executablePath;
  const legacyRootExecutable =
    path.basename(directExecutable).toLowerCase() === "mistserver.exe"
      ? path.join(path.dirname(directExecutable), "Mist", "Binaries", "Win64", "MistServer-Win64-Shipping.exe")
      : null;

  if (legacyRootExecutable && (await pathExists(legacyRootExecutable))) {
    return {
      executablePath: legacyRootExecutable,
      workingDirectory: path.dirname(legacyRootExecutable),
      usedCompatibilityRedirect: true,
    };
  }

  return {
    executablePath: directExecutable,
    workingDirectory: path.dirname(directExecutable),
    usedCompatibilityRedirect: false,
  };
}

export async function installSteamCmd(config: AppConfig, installDirectory?: string) {
  const targetDirectory =
    installDirectory?.trim() ||
    config.operationsSettings.steamCmdInstallDirectory ||
    path.join(getConfiguredServerInstallPath(config), "tools", "steamcmd");

  if (!targetDirectory) {
    throw new Error("Unable to determine where SteamCMD should be installed.");
  }

  await fs.mkdir(targetDirectory, { recursive: true });

  const steamCmdZipUrl = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
  const tempZipPath = path.join(targetDirectory, "steamcmd-download.zip");
  const steamCmdExePath = path.join(targetDirectory, "steamcmd.exe");

  const response = await fetch(steamCmdZipUrl);
  if (!response.ok) {
    throw new Error(`SteamCMD download failed with status ${response.status}.`);
  }

  const zipBuffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(tempZipPath, zipBuffer);

  const extractScript = `
Expand-Archive -LiteralPath '${escapePowerShell(tempZipPath)}' -DestinationPath '${escapePowerShell(targetDirectory)}' -Force
`.trim();

  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", extractScript], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
  });

  await fs.rm(tempZipPath, { force: true });

  if (!(await pathExists(steamCmdExePath))) {
    throw new Error("SteamCMD archive extracted, but steamcmd.exe was not found.");
  }

  let bootstrapNotes = "";
  try {
    const { stderr } = await execFileAsync(steamCmdExePath, ["+quit"], {
      cwd: targetDirectory,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 16,
    });
    bootstrapNotes = stderr.trim();
  } catch (error) {
    bootstrapNotes = error instanceof Error ? error.message : "SteamCMD extracted but its first-run bootstrap reported an issue.";
  }

  return {
    installDirectory: targetDirectory,
    executablePath: steamCmdExePath,
    bootstrapNotes,
    sourceUrl: steamCmdZipUrl,
  };
}

export async function listServerProcesses(): Promise<ServerProcess[]> {
  const script = `
$processes = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -in @('MistServer.exe', 'MistServer-Win64-Shipping.exe') } |
  Select-Object @{Name='pid';Expression={$_.ProcessId}},
                @{Name='name';Expression={$_.Name}},
                @{Name='commandLine';Expression={$_.CommandLine}},
                @{Name='executablePath';Expression={$_.ExecutablePath}},
                @{Name='startedAt';Expression={ if ($_.CreationDate) { [Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate).ToString('o') } else { $null } }},
                @{Name='memoryMb';Expression={ [math]::Round(($_.WorkingSetSize / 1MB), 1) }}
if (-not $processes) { '[]' } else { $processes | ConvertTo-Json -Compress }
`.trim();

  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4,
  });

  const normalized = stdout.trim();
  if (!normalized) {
    return [];
  }

  const parsed = JSON.parse(normalized) as ServerProcess | ServerProcess[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function countServerProcesses(): Promise<number> {
  const script = `
$count = @(Get-Process -Name 'MistServer', 'MistServer-Win64-Shipping' -ErrorAction SilentlyContinue).Count
$count
`.trim();

  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  const parsedCount = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(parsedCount) ? parsedCount : 0;
}

export async function listLogFiles(logsPath: string): Promise<LogFileSummary[]> {
  if (!(await pathExists(logsPath))) {
    return [];
  }

  const entries = await fs.readdir(logsPath, { withFileTypes: true });
  const logs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".log"))
      .map(async (entry) => {
        const fullPath = path.join(logsPath, entry.name);
        const stat = await fs.stat(fullPath);
        return {
          name: entry.name,
          path: fullPath,
          modifiedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        };
      }),
  );

  return logs.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export async function listBackups(backupsPath: string): Promise<BackupSummary[]> {
  if (!(await pathExists(backupsPath))) {
    return [];
  }

  const entries = await fs.readdir(backupsPath, { withFileTypes: true });
  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
      .map(async (entry) => {
        const fullPath = path.join(backupsPath, entry.name);
        const stat = await fs.stat(fullPath);
        return {
          name: entry.name,
          path: fullPath,
          modifiedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        };
      }),
  );

  return backups.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export async function createBackup(config: AppConfig) {
  await fs.mkdir(config.paths.backupsPath, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destinationPath = path.join(config.paths.backupsPath, `last-oasis-backup-${timestamp}.zip`);
  const localDataPath = getConfiguredServerSavedPath(config);
  const adminDataPath = getConfiguredServerAdminDataPath(config);
  const sourceItems = [
    adminDataPath,
    path.join(localDataPath, "Config"),
    path.join(localDataPath, "Logs"),
  ];

  const availableSources = [];
  for (const item of sourceItems) {
    if (await pathExists(item)) {
      availableSources.push(item);
    }
  }

  if (!availableSources.length) {
    throw new Error("No Last Oasis local data sources were found for backup.");
  }

  const sourceLiteral = availableSources.map((item) => `'${escapePowerShell(item)}'`).join(", ");
  const script = `
$items = @(${sourceLiteral})
Compress-Archive -Path $items -DestinationPath '${escapePowerShell(destinationPath)}' -Force
`.trim();

  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
  });

  const backups = await listBackups(config.paths.backupsPath);
  const created = backups.find((backup) => backup.path === destinationPath);

  if (!created) {
    throw new Error("Backup was created but could not be verified.");
  }

  return created;
}

export async function detectPublicIp() {
  const candidates = [
    { url: "https://api.ipify.org?format=json", parse: async (response: Response) => ((await response.json()) as { ip: string }).ip, source: "ipify" },
    { url: "https://ifconfig.me/ip", parse: async (response: Response) => (await response.text()).trim(), source: "ifconfig.me" },
    { url: "https://checkip.amazonaws.com", parse: async (response: Response) => (await response.text()).trim(), source: "checkip.amazonaws.com" },
  ];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url, { method: "GET" });
      if (!response.ok) {
        continue;
      }

      const address = await candidate.parse(response);
      if (address) {
        return {
          address,
          source: candidate.source,
          detectedAt: new Date().toISOString(),
        };
      }
    } catch {
      continue;
    }
  }

  throw new Error("Unable to detect the public IP address from the available providers.");
}

export function detectLocalNetworkIp() {
  const interfaces = os.networkInterfaces();
  const candidates: Array<{ interfaceName: string; address: string; score: number }> = [];

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }

      if (entry.address.startsWith("127.") || entry.address.startsWith("169.254.")) {
        continue;
      }

      candidates.push({
        interfaceName,
        address: entry.address,
        score: scoreLocalAddress(interfaceName, entry.address),
      });
    }
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
  return candidates[0]?.address ?? null;
}

export async function readLogTail(logsPath: string, fileName: string, lines = 200): Promise<LogTailResponse> {
  if (!logsPath.trim()) {
    throw new Error("No selected host log path is linked in the manager.");
  }

  const safeName = path.basename(fileName);
  const fullPath = path.join(logsPath, safeName);

  if (!(await pathExists(fullPath))) {
    throw new Error(`Log file not found: ${safeName}`);
  }

  const [stat, content] = await Promise.all([fs.stat(fullPath), fs.readFile(fullPath, "utf8")]);
  const splitLines = content.split(/\r?\n/);
  const tail = splitLines.slice(Math.max(0, splitLines.length - lines)).join("\n");

  return {
    file: {
      name: safeName,
      path: fullPath,
      modifiedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    },
    lines,
    content: tail,
  };
}

export async function readAdminData(adminDataPath: string): Promise<AdminDataSummary> {
  if (!(await pathExists(adminDataPath))) {
    return {
      path: null,
      commandGroups: [],
      itemSetCount: 0,
    };
  }

  const raw = await fs.readFile(adminDataPath, "utf8");
  const json = parseLooseJson<{
    Commands?: Record<string, string[]>;
    ItemSets?: Record<string, string[]>;
  }>(raw);

  const commandGroups = Object.entries(json.Commands ?? {})
    .map(([name, commands]) => ({
      name,
      count: commands.length,
      commands,
    }))
    .sort((left, right) => right.count - left.count);

  return {
    path: adminDataPath,
    commandGroups,
    itemSetCount: Object.keys(json.ItemSets ?? {}).length,
  };
}

export async function updateGame(config: AppConfig) {
  const steamCmdPath = config.operationsSettings.steamCmdPath;
  if (!steamCmdPath || !(await pathExists(steamCmdPath))) {
    throw new Error("SteamCMD path is not configured or the executable was not found.");
  }

  const installPath = getConfiguredServerInstallPath(config);
  if (!installPath) {
    throw new Error("No selected host profile path is linked in the manager.");
  }

  const args = [
    "+force_install_dir",
    installPath,
    "+login",
    "anonymous",
    "+app_update",
    String(config.operationsSettings.appId),
    ...(config.operationsSettings.betaBranch ? ["-beta", config.operationsSettings.betaBranch] : []),
    "validate",
    "+quit",
  ];

  const { stdout, stderr } = await execFileAsync(steamCmdPath, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
  });

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

export async function checkGameUpdate(config: AppConfig): Promise<GameUpdateCheckResult> {
  const steamCmdPath = config.operationsSettings.steamCmdPath;
  if (!steamCmdPath || !(await pathExists(steamCmdPath))) {
    throw new Error("SteamCMD path is not configured or the executable was not found.");
  }

  const appId = config.operationsSettings.appId;
  const branch = config.operationsSettings.betaBranch.trim() || "public";
  const installPath = getConfiguredServerInstallPath(config);
  if (!installPath) {
    throw new Error("No selected host profile path is linked in the manager.");
  }

  const localManifest = await readGameAppManifest(config);
  const args = [
    "+login",
    "anonymous",
    "+app_info_update",
    "1",
    "+app_info_print",
    String(appId),
    "+quit",
  ];

  const { stdout, stderr } = await execFileAsync(steamCmdPath, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
  });

  const latest = parseSteamAppInfoBuild(stdout, branch);
  const updateAvailable =
    localManifest?.buildId && latest.buildId
      ? localManifest.buildId !== latest.buildId
      : null;
  const latestUpdatedAt =
    latest.timeUpdated && /^\d+$/.test(latest.timeUpdated)
      ? new Date(Number.parseInt(latest.timeUpdated, 10) * 1000).toISOString()
      : null;

  let note = "SteamCMD check finished.";
  if (!localManifest) {
    note = `SteamCMD returned app info, but no app manifest was found for the linked server path ${installPath}. The manager cannot compare build IDs yet.`;
  } else if (!localManifest.buildId) {
    note = `Local app manifest was found at ${localManifest.path}, but it did not contain a build ID.`;
  } else if (!latest.buildId) {
    note = "SteamCMD returned app info, but the latest build ID could not be parsed.";
  } else if (updateAvailable) {
    note = `Server update is available for linked server path ${installPath}. Local build ${localManifest.buildId}; latest ${latest.buildId}.`;
  } else {
    note = `Linked server path ${installPath} is current. Local build ${localManifest.buildId} matches latest ${latest.buildId}.`;
  }

  return {
    appId,
    branch,
    checkedAt: new Date().toISOString(),
    steamCmdPath,
    installPath,
    localManifestPath: localManifest?.path ?? null,
    localBuildId: localManifest?.buildId ?? null,
    latestBuildId: latest.buildId,
    latestUpdatedAt,
    updateAvailable,
    note,
    stderr: stderr.trim(),
  };
}

export async function syncMods(config: AppConfig, downloadBeforeSync = true, modIds = config.operationsSettings.modIds) {
  const workshopRoots = getWorkshopContentRoots(config);
  if (!workshopRoots.length) {
    throw new Error("Workshop content path is not configured or could not be found.");
  }

  const modsPath = getServerModsPath(config);
  const steamCmdAvailable = Boolean(config.operationsSettings.steamCmdPath) && (await pathExists(config.operationsSettings.steamCmdPath));
  const steamCmdWorkshopRoot = getSteamCmdWorkshopContentRoot(config);
  const desktopWorkshopRoots = getDesktopWorkshopContentRoots(config);

  if (downloadBeforeSync && steamCmdAvailable) {
    for (const modId of modIds) {
      await execFileAsync(
        config.operationsSettings.steamCmdPath,
        ["+login", "anonymous", "+workshop_download_item", "903950", modId, "+quit"],
        { windowsHide: true, maxBuffer: 1024 * 1024 * 16 },
      );
    }
  }

  const metadata = await fetchWorkshopMetadata(modIds).catch(() => new Map<string, Record<string, unknown>>());
  const modSyncState = await readModSyncState();
  let modSyncStateChanged = false;
  await fs.mkdir(modsPath, { recursive: true });

  for (const modId of modIds) {
    const stateKey = getModSyncStateKey(config, modId);
    if (modSyncState.mods[stateKey]?.workshopUpdatedAt) {
      continue;
    }

    const workshop = metadata.get(modId);
    const workshopUpdatedAt = getWorkshopUpdatedAt(workshop);
    const destinationPath = path.join(modsPath, modId);
    if (!workshopUpdatedAt || !(await pathExists(destinationPath))) {
      continue;
    }

    const destinationUpdatedAt = await getNewestFileTimestamp(destinationPath);
    if (!isTimestampCurrentOrNewer(destinationUpdatedAt, workshopUpdatedAt)) {
      continue;
    }

    modSyncState.mods[stateKey] = {
      modId,
      serverModsPath: modsPath,
      workshopUpdatedAt,
      syncedAt: new Date().toISOString(),
      title: typeof workshop?.title === "string" ? workshop.title : null,
    };
    modSyncStateChanged = true;
  }

  const isFullSync = modIds.length === config.operationsSettings.modIds.length && modIds.every((modId) => config.operationsSettings.modIds.includes(modId));

  if (config.operationsSettings.modSyncDeletesMissing && isFullSync) {
    await emptyDirectory(modsPath);
  }

  const synced: string[] = [];
  const updated: string[] = [];
  const missing: string[] = [];
  const deactivated = new Set<string>();
  let pruned: string[] = [];
  let mirroredToSteamWorkshop = false;
  for (const modId of modIds) {
    const sourcePath = await resolveWorkshopModSourcePath(config, modId);
    if (!sourcePath) {
      missing.push(modId);
      continue;
    }

    const normalizedSourcePath = path.normalize(sourcePath).toLowerCase();
    const sourceIsSteamCmdCache =
      Boolean(steamCmdWorkshopRoot) &&
      (normalizedSourcePath === path.normalize(path.join(steamCmdWorkshopRoot, modId)).toLowerCase());

    for (const title of await sanitizeModCopiesAtPaths([sourcePath])) {
      deactivated.add(title);
    }

    if (sourceIsSteamCmdCache) {
      const mirroredRoots = await mirrorWorkshopModToRoots(sourcePath, modId, desktopWorkshopRoots);
      if (mirroredRoots.length) {
        mirroredToSteamWorkshop = true;
      }

      for (const title of await sanitizeModCopiesAtPaths(mirroredRoots.map((root) => path.join(root, modId)))) {
        deactivated.add(title);
      }
    }

    const destinationPath = path.join(modsPath, modId);
    const stateKey = getModSyncStateKey(config, modId);
    const workshop = metadata.get(modId);
    const workshopUpdatedAt = getWorkshopUpdatedAt(workshop);
    const previousAppliedWorkshopUpdatedAt = modSyncState.mods[stateKey]?.workshopUpdatedAt ?? null;
    const destinationExists = await pathExists(destinationPath);
    const destinationUpdatedAt = destinationExists ? await getNewestFileTimestamp(destinationPath) : null;
    const sourceUpdatedAt = await getNewestFileTimestamp(sourcePath);
    const realUpdate = workshopUpdatedAt
      ? isTimestampNewer(workshopUpdatedAt, previousAppliedWorkshopUpdatedAt)
      : !destinationExists || isTimestampNewer(sourceUpdatedAt, destinationUpdatedAt);

    await fs.rm(destinationPath, { recursive: true, force: true });
    await fs.cp(sourcePath, destinationPath, { recursive: true, force: true });

    for (const title of await sanitizeModCopiesAtPaths([destinationPath])) {
      deactivated.add(title);
    }

    if (workshopUpdatedAt) {
      modSyncState.mods[stateKey] = {
        modId,
        serverModsPath: modsPath,
        workshopUpdatedAt,
        syncedAt: new Date().toISOString(),
        title: typeof workshop?.title === "string" ? workshop.title : null,
      };
      modSyncStateChanged = true;
    }

    if (realUpdate) {
      updated.push(modId);
    }

    synced.push(modId);
  }

  if (!config.operationsSettings.modSyncDeletesMissing && isFullSync) {
    pruned = await pruneMissingModFolders(modsPath, modIds);
  }

  modsCache = null;
  if (modSyncStateChanged) {
    await writeModSyncState(modSyncState).catch(() => undefined);
  }

  return {
    modsPath,
    synced: [...synced, ...pruned],
    updated,
    missing,
    activated: [] as string[],
    deactivated: [...deactivated],
    usedSteamCmd: steamCmdAvailable && downloadBeforeSync,
    mirroredToSteamWorkshop,
  };
}

export async function startServer(
  profile: AppConfig["profiles"][number],
  options?: {
    activeModIds?: string[];
    verificationDelayMs?: number;
    resolvedLaunch?: Awaited<ReturnType<typeof resolveLaunchExecutable>>;
  },
) {
  const existingProcesses = await listServerProcesses();
  const launchConflict = findLaunchConflict(existingProcesses, profile);
  if (launchConflict) {
    throw new Error(launchConflict.reason);
  }

  const resolvedLaunch = options?.resolvedLaunch ?? (await resolveLaunchExecutable(profile));

  if (!(await pathExists(resolvedLaunch.executablePath))) {
    throw new Error(`Executable not found: ${resolvedLaunch.executablePath}`);
  }

  if (!(await pathExists(resolvedLaunch.workingDirectory))) {
    throw new Error(`Working directory not found: ${resolvedLaunch.workingDirectory}`);
  }

  if (profile.validationIssues.length) {
    throw new Error(`Profile is incomplete: ${profile.validationIssues.join(" ")}`);
  }

  const sanitizedTitles = [
    ...new Set([
      ...(await sanitizeModCopiesUnderRoot(getProfileServerModsPath(profile), options?.activeModIds ?? [])),
      ...(await sanitizeDedicatedServerModCopies(resolvedLaunch.workingDirectory, options?.activeModIds ?? [])),
    ]),
  ];
  const modActivationResult = await synchronizeServerModsForLaunch(
    getProfileServerModsPath(profile),
    options?.activeModIds ?? [],
  );
  const modRepairResult = await repairSavedModReferences(getProfileServerInstallRoot(profile));

  const normalizedLaunchSettings = {
    ...profile.launch,
    steamDedicatedServerAppId: LAST_OASIS_BASE_APP_ID,
    forceSteamClientLink: false,
    noLiveServer: true,
  };
  const generatedArguments = buildLastOasisArguments(normalizedLaunchSettings);
  const script = `
$workingDirectory = '${escapePowerShell(resolvedLaunch.workingDirectory)}'
$process = Start-Process -FilePath '${escapePowerShell(resolvedLaunch.executablePath)}' -WorkingDirectory $workingDirectory -ArgumentList '${escapePowerShell(generatedArguments)}' -PassThru
$process.Id
`.trim();

  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  try {
    const pid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(pid)) {
      throw new Error("The server process started but no PID was returned.");
    }

    const verificationDelayMs = Math.max(150, options?.verificationDelayMs ?? 800);
    await new Promise((resolve) => {
      setTimeout(resolve, verificationDelayMs);
    });

    const runningProcesses = await listServerProcesses();
    const matchingProcess = runningProcesses.find((processInfo) => processInfo.pid === pid);

    if (!matchingProcess) {
      throw new Error("The start command returned a PID, but no Last Oasis server process stayed alive.");
    }

    return {
      pid: matchingProcess.pid,
      note: [
        resolvedLaunch.usedCompatibilityRedirect
          ? `Redirected launch from ${profile.executablePath} to ${resolvedLaunch.executablePath} for dedicated-server compatibility.`
          : null,
        sanitizedTitles.length
          ? `Reset active flags on ${sanitizedTitles.length} copied mod${sanitizedTitles.length === 1 ? "" : "s"} before launch.`
          : null,
        modActivationResult.activated.length || modActivationResult.deactivated.length
          ? `Updated server mod activation flags (${modActivationResult.activated.length} enabled, ${modActivationResult.deactivated.length} disabled).`
          : null,
        modRepairResult.rewrittenFiles.length
          ? `Repaired stale saved-state mod references for ${modRepairResult.staleIds.join(", ")}.`
          : null,
        "Launched with the same simple direct dedicated-server baseline as the working launcher, without rewriting Steam runtime files first.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  } catch (error) {
    throw error;
  }
}

export async function startAllServers(profiles: AppConfig["profiles"], activeModIds: string[] = []): Promise<StartAllServersResult> {
  const orderedProfiles = [...profiles].sort((left, right) => {
    if (left.launch.port !== right.launch.port) {
      return left.launch.port - right.launch.port;
    }

    return left.name.localeCompare(right.name);
  });

  const result: StartAllServersResult = {
    started: [],
    skipped: [],
    failed: [],
  };

  for (const profile of orderedProfiles) {
    const runningProcesses = await listServerProcesses();
    const launchConflict = findLaunchConflict(runningProcesses, profile);

    if (launchConflict) {
      result.skipped.push({
        profileId: profile.id,
        profileName: profile.name,
        reason: launchConflict.reason,
      });
      continue;
    }

    const resolvedLaunch = await resolveLaunchExecutable(profile);

    try {
      const started = await startServer(profile, {
        activeModIds,
        verificationDelayMs: 200,
        resolvedLaunch,
      });
      result.started.push({
        profileId: profile.id,
        profileName: profile.name,
        pid: started.pid,
        note: started.note,
      });
    } catch (error) {
      result.failed.push({
        profileId: profile.id,
        profileName: profile.name,
        reason: error instanceof Error ? error.message : "Unknown start failure.",
      });
    }
  }

  if (result.started.length) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1500);
    });

    const stabilizedProcesses = await listServerProcesses().catch(() => []);
    const alivePids = new Set(stabilizedProcesses.map((processInfo) => processInfo.pid));
    const stabilizedStarted = [];

    for (const started of result.started) {
      if (alivePids.has(started.pid)) {
        stabilizedStarted.push(started);
        continue;
      }

      result.failed.push({
        profileId: started.profileId,
        profileName: started.profileName,
        reason: "The process launched but exited again during startup.",
      });
    }

    result.started = stabilizedStarted;
  }

  return result;
}

async function waitForTargetExit(targetPids: number[], timeoutMs = 8_000) {
  const targetPidSet = new Set(targetPids);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runningProcesses = await listServerProcesses().catch(() => []);
    const hasTargets = runningProcesses.some((processInfo) => targetPidSet.has(processInfo.pid));
    if (!hasTargets) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }

  return false;
}

async function waitForNoMatchingServerProcesses(profiles: AppConfig["profiles"], timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runningProcesses = await listServerProcesses().catch(() => []);
    const remaining = runningProcesses.filter((processInfo) =>
      serverProcessMatchesProfiles(processInfo, profiles, { includeServerRoot: true }),
    );
    if (!remaining.length) {
      return [] as ServerProcess[];
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }

  const runningProcesses = await listServerProcesses().catch(() => []);
  return runningProcesses.filter((processInfo) => serverProcessMatchesProfiles(processInfo, profiles, { includeServerRoot: true }));
}

async function terminateTargetPids(targetPids: number[], forceKill: boolean) {
  if (!targetPids.length) {
    return;
  }

  await Promise.all(
    targetPids.map(async (targetPid) => {
      try {
        await execFileAsync(
          "taskkill.exe",
          ["/PID", String(targetPid), "/T", ...(forceKill ? ["/F"] : [])],
          {
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch {
        // Ignore taskkill failures here and verify the process list after.
      }
    }),
  );
}

export async function stopServerPids(targetPids: number[], force = false) {
  const uniqueTargetPids = [...new Set(targetPids)].filter((targetPid) => Number.isFinite(targetPid));
  if (!uniqueTargetPids.length) {
    return;
  }

  await terminateTargetPids(uniqueTargetPids, force);
  const stopped = await waitForTargetExit(uniqueTargetPids, force ? 4_000 : 8_000);

  if (!stopped && !force) {
    const remainingProcesses = await listServerProcesses().catch(() => []);
    const remainingTargetPids = remainingProcesses
      .filter((processInfo) => uniqueTargetPids.includes(processInfo.pid))
      .map((processInfo) => processInfo.pid);

    await terminateTargetPids(remainingTargetPids, true);
    await waitForTargetExit(remainingTargetPids, 6_000);
  }

  await releaseHeldSteamRuntimeIfIdle().catch(() => undefined);
}

export async function stopConfiguredServerProcesses(profiles: AppConfig["profiles"]) {
  const uniqueProfiles = [...new Map(profiles.map((profile) => [profile.id, profile])).values()];
  if (!uniqueProfiles.length) {
    return {
      stoppedPids: [] as number[],
      remainingPids: [] as number[],
    };
  }

  const runningProcesses = await listServerProcesses();
  const targetProcesses = runningProcesses.filter((processInfo) =>
    serverProcessMatchesProfiles(processInfo, uniqueProfiles, { includeServerRoot: true }),
  );
  const targetPids = targetProcesses.map((processInfo) => processInfo.pid);

  if (targetPids.length) {
    await stopServerPids(targetPids, false);
  }

  let remainingProcesses = await waitForNoMatchingServerProcesses(uniqueProfiles, 5_000);
  if (remainingProcesses.length) {
    await stopServerPids(
      remainingProcesses.map((processInfo) => processInfo.pid),
      true,
    );
    remainingProcesses = await waitForNoMatchingServerProcesses(uniqueProfiles, 4_000);
  }

  return {
    stoppedPids: [...new Set(targetPids)],
    remainingPids: [...new Set(remainingProcesses.map((processInfo) => processInfo.pid))],
  };
}

export async function stopServer(pid?: number, force = false) {
  if (pid) {
    await stopServerPids([pid], force);
    return;
  }

  const processes = await listServerProcesses();
  if (!processes.length) {
    return;
  }

  const targetPids = processes.map((processInfo) => processInfo.pid);
  await stopServerPids(targetPids, force);
}

function buildHealth(config: AppConfig, runningProcesses: ServerProcess[], logFiles: LogFileSummary[], adminPresent: boolean, backupCount: number) {
  const selectedProfile = config.profiles.find((profile) => profile.id === config.selectedProfileId) ?? config.profiles[0];
  const selectedInstallPath = getConfiguredServerInstallPath(config);
  const selectedLogsPath = getConfiguredServerLogsPath(config);
  const selectedAdminDataPath = getConfiguredServerAdminDataPath(config);

  const checks: HealthCheck[] = [
    {
      label: "Install folder",
      ok: Boolean(selectedInstallPath),
      value: selectedInstallPath || "Not linked",
      details: "Taken from the selected host profile path in the manager.",
    },
    {
      label: "Executable",
      ok: Boolean(selectedProfile?.executablePath || config.paths.executablePath),
      value: selectedProfile?.executablePath || config.paths.executablePath || "Not found",
      details: "The selected profile launch path is shown here.",
    },
    {
      label: "MyRealm launch fields",
      ok: Boolean(selectedProfile) && selectedProfile.validationIssues.length === 0,
      value: selectedProfile?.name ?? "No profile selected",
      details: selectedProfile
        ? selectedProfile.validationIssues.length
          ? selectedProfile.validationIssues.join(" ")
          : "Customer key, provider key, ports, slots, and public address look ready."
        : "No launch profile is available.",
    },
    {
      label: "Local Mist data",
      ok: Boolean(selectedLogsPath),
      value: selectedLogsPath ? path.dirname(selectedLogsPath) : "Not linked",
      details: "Derived from the selected host profile path, not from Steam auto-detection.",
    },
    {
      label: "Server config profile",
      ok: config.paths.serverConfigPath.length > 0,
      value: config.paths.serverConfigPath,
      details: "This folder usually appears after a dedicated-server profile writes WindowsServer config files.",
    },
    {
      label: "Log files",
      ok: logFiles.length > 0,
      value: `${logFiles.length} file(s)`,
      details: logFiles[0] ? `Latest: ${logFiles[0].name}` : "No logs found yet.",
    },
    {
      label: "Admin command data",
      ok: adminPresent,
      value: adminPresent ? selectedAdminDataPath : "Not found",
      details: "AdminData.json can seed future admin-command helpers in the UI.",
    },
    {
      label: "Backups",
      ok: backupCount > 0,
      value: backupCount ? `${backupCount} archive(s)` : "None yet",
      details: "Manual Saved-data backups are written into the workspace data/backups folder.",
    },
    {
      label: "SteamCMD",
      ok: Boolean(config.operationsSettings.steamCmdPath),
      value: config.operationsSettings.steamCmdPath || "Not configured",
      details: "Required for game updates and workshop downloads. Mod copy still works from an existing workshop cache.",
    },
    {
      label: "Workshop mods",
      ok: Boolean(config.operationsSettings.workshopContentPath),
      value: `${config.operationsSettings.modIds.length} configured`,
      details: config.operationsSettings.workshopContentPath || "No workshop content path configured.",
    },
    {
      label: "Stored public IP",
      ok: Boolean(config.operationsSettings.lastKnownPublicIp),
      value: config.operationsSettings.lastKnownPublicIp || "Not detected yet",
      details: "Used as the quick-fill source for OverrideConnectionAddress.",
    },
    {
      label: "Running server process",
      ok: runningProcesses.length > 0,
      value: runningProcesses.length ? `${runningProcesses.length} active` : "Stopped",
      details: runningProcesses[0]
        ? `PID ${runningProcesses[0].pid} using ${runningProcesses[0].name}`
        : "No Last Oasis dedicated server process is active right now.",
    },
  ];

  return checks;
}

export async function collectLiveServers(
  config: AppConfig,
  runningProcesses?: ServerProcess[],
  knownLogFiles?: LogFileSummary[],
): Promise<LiveServerSummary[]> {
  const resolvedRunningProcesses = runningProcesses ?? (await listServerProcesses());
  const logsPath = getConfiguredServerLogsPath(config);
  const resolvedLogFiles = knownLogFiles ?? (await listLogFiles(logsPath));
  const [liveServers, recentGameplaySessions, dedicatedServerTileSnapshots] = await Promise.all([
    queryLiveServers(config, resolvedRunningProcesses),
    inferRecentGameplaySessions(logsPath, resolvedLogFiles),
    inferDedicatedServerTileSnapshots(logsPath),
  ]);

  return liveServers.map((server): LiveServerSummary => {
    const tileSnapshot = dedicatedServerTileSnapshots
      .filter((snapshot) => {
      const identifierMatches =
        Boolean(server.identifier && snapshot.identifier) && server.identifier!.toLowerCase() === snapshot.identifier!.toLowerCase();
      const gamePortMatches = server.gamePort !== null && snapshot.gamePort !== null && server.gamePort === snapshot.gamePort;
      const queryPortMatches = server.queryPort !== null && snapshot.queryPort !== null && server.queryPort === snapshot.queryPort;
      return identifierMatches || gamePortMatches || queryPortMatches;
      })
      .sort((left, right) => {
        const scoreDelta = scoreDedicatedServerTileSnapshot(right) - scoreDedicatedServerTileSnapshot(left);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        return right.modifiedAt.localeCompare(left.modifiedAt);
      })[0];
    const resolvedMapName = tileSnapshot?.tileName ?? server.map ?? tileSnapshot?.mapName ?? null;
    const hostingLogNote = tileSnapshot?.tileName
      ? `Hosting ${tileSnapshot.tileName} confirmed by ${tileSnapshot.sourceLog}${
          tileSnapshot.hostingStartedAt ? ` at ${new Date(tileSnapshot.hostingStartedAt).toLocaleTimeString()}` : ""
        }.`
      : null;

    if (server.status === "query" || server.gamePort === null) {
      return {
        ...server,
        map: resolvedMapName,
        note: hostingLogNote ?? server.note,
      };
    }

    const recentSession = recentGameplaySessions.find((session) => session.gamePort === server.gamePort);
    if (recentSession) {
      return {
        ...server,
        status: "activity" as const,
        map: resolvedMapName ?? recentSession.mapName,
        playerCount: Math.max(server.playerCount, 1),
        note: hostingLogNote
          ? `${hostingLogNote} Recent gameplay was detected on port ${server.gamePort} at ${new Date(recentSession.lastSeenAt).toLocaleTimeString()}, but the optional live query probe did not answer.`
          : `Process is running. Recent gameplay was detected on port ${server.gamePort} at ${new Date(recentSession.lastSeenAt).toLocaleTimeString()}, but the optional live query probe did not answer.`,
      };
    }

    if (server.processId !== null) {
      const runningNote =
        hostingLogNote ??
        (server.note === "Server query timed out."
          ? "Process is running. Last Oasis did not answer the optional live query probe on this refresh."
          : server.note ?? "Process is running. Live query details are unavailable right now.");
      return {
        ...server,
        status: "running" as const,
        map: resolvedMapName,
        note: runningNote,
      };
    }

    return server;
  });
}

export async function buildDashboardState(
  config: AppConfig,
  schedulerStatus: SchedulerStatus,
  myRealmSession: MyRealmSessionSnapshot | null = null,
): Promise<DashboardState> {
  const logsPath = getConfiguredServerLogsPath(config);
  const adminDataPath = getConfiguredServerAdminDataPath(config);
  const [runningProcesses, logFiles, adminData, backups] = await Promise.all([
    listServerProcesses(),
    listLogFiles(logsPath),
    readAdminData(adminDataPath),
    listBackups(config.paths.backupsPath),
  ]);
  const [liveServers, playerActivity, mods] = await Promise.all([
    collectLiveServers(config, runningProcesses, logFiles),
    readRecentPlayerActivity(logsPath, logFiles),
    readMods(config),
  ]);
  const explicitHostingReadyHosts = liveServers.filter(isLiveServerHostingReady).length;
  const fallbackHostingReadyHosts = countStableRunningProcesses(runningProcesses);
  const launchStatus = buildLaunchStatus(
    schedulerStatus.desiredRunningProfiles,
    runningProcesses.length,
    Math.max(explicitHostingReadyHosts, fallbackHostingReadyHosts),
  );
  const livePlayerActivity: PlayerActivityEntry[] = liveServers.flatMap((server) =>
    server.players.map((player) => ({
      activityType: "observed" as const,
      playerName: player.name,
      uniqueNetId: "Live query",
      observedAt: new Date().toISOString(),
      mapName: server.map,
      characterId: null,
      connectionAddress: null,
      sourceLog: null,
      sourceLine: `${player.name} is currently reported on ${server.map ?? server.identifier ?? "an active map"} via query port ${server.queryPort ?? "unknown"}.`,
    })),
  );
  const selectedProfile = config.profiles.find((profile) => profile.id === config.selectedProfileId) ?? config.profiles[0] ?? null;
  const selectedInstallPath = getConfiguredServerInstallPath(config);
  const selectedSavedPath = getConfiguredServerSavedPath(config);
  const resolvedConfigForDisplay: AppConfig = selectedInstallPath
    ? {
        ...config,
        paths: {
          ...config.paths,
          installPath: selectedInstallPath,
          executablePath: selectedProfile?.executablePath ?? config.paths.executablePath,
          workingDirectory: selectedProfile?.workingDirectory ?? config.paths.workingDirectory,
          localDataPath: selectedSavedPath,
          logsPath,
          adminDataPath,
          serverConfigPath: path.join(selectedSavedPath, "Config", "WindowsServer"),
        },
      }
    : config;
  const liveServer =
    liveServers.find((entry) => entry.identifier && entry.identifier === selectedProfile?.launch.identifier) ??
    liveServers.find((entry) => entry.online || entry.playerCount > 0) ??
    liveServers[0] ??
    buildOfflineLiveServerSummary(
      selectedProfile
        ? {
            identifier: selectedProfile.launch.identifier,
            gamePort: selectedProfile.launch.port,
            queryPort: selectedProfile.launch.queryPort,
          }
        : undefined,
      "No live server data is available yet.",
    );

  return {
    config: resolvedConfigForDisplay,
    myRealmSession,
    runningProcesses,
    health: buildHealth(config, runningProcesses, logFiles, Boolean(adminData.path), backups.length),
    networkAddresses: {
      publicIp: config.operationsSettings.lastKnownPublicIp || null,
      localIp: detectLocalNetworkIp(),
    },
    logFiles,
    adminData,
    backups,
    schedulerStatus,
    launchStatus,
    liveServer,
    liveServers,
    playerActivity: [...livePlayerActivity, ...playerActivity].slice(0, 30),
    mods,
  };
}
