import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDefaultConfig,
  discoverPaths,
  getBackupsPath,
  getInstallContextPath,
  getPersistedConfigPath,
  getProfileDataPath,
  getProfileLinkPath,
  getWorkspaceDataPath,
  saveConfig,
} from "./configStore.js";
import { buildLastOasisArguments, validateLastOasisSettings } from "../shared/lastOasis.js";
import type { AppConfig } from "../shared/types.js";

type BootstrapArgs = {
  serverPath: string;
  gamePath: string;
  steamExePath: string;
  steamServicePath: string;
  workshopContentPath: string;
  steamCmdInstallDirectory: string;
  steamCmdPath: string;
  profileRoot: string;
  nodeRoot: string;
  customerKey: string;
  providerKey: string;
  providerName: string;
  apiKey: string;
  publicAddress: string;
};

type InstallContext = {
  toolRoot: string;
  profileRoot: string;
  serverPath: string;
  gamePath: string;
  steamExePath: string;
  steamServicePath: string;
  workshopContentPath: string;
  steamCmdInstallDirectory: string;
  steamCmdPath: string;
  nodeRoot: string;
  installedAt: string;
};

type ProfileLink = {
  profileRoot?: string;
};

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const LAST_OASIS_LAUNCH_APP_ID = 903950;

function parseArgs(argv: string[]): BootstrapArgs {
  const args: BootstrapArgs = {
    serverPath: "",
    gamePath: "",
    steamExePath: "",
    steamServicePath: "",
    workshopContentPath: "",
    steamCmdInstallDirectory: "",
    steamCmdPath: "",
    profileRoot: "",
    nodeRoot: "",
    customerKey: "",
    providerKey: "",
    providerName: "",
    apiKey: "",
    publicAddress: "",
  };

  const readNextValue = (currentIndex: number) => {
    const candidate = argv[currentIndex + 1] ?? "";
    if (!candidate || candidate.startsWith("--")) {
      return "";
    }

    return candidate;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = readNextValue(index);

    switch (token) {
      case "--server-path":
        args.serverPath = next;
        if (next) {
          index += 1;
        }
        break;
      case "--game-path":
        args.gamePath = next;
        if (next) {
          index += 1;
        }
        break;
      case "--steam-exe":
        args.steamExePath = next;
        if (next) {
          index += 1;
        }
        break;
      case "--steam-service":
        args.steamServicePath = next;
        if (next) {
          index += 1;
        }
        break;
      case "--workshop-path":
        args.workshopContentPath = next;
        if (next) {
          index += 1;
        }
        break;
      case "--steamcmd-dir":
        args.steamCmdInstallDirectory = next;
        if (next) {
          index += 1;
        }
        break;
      case "--steamcmd-path":
        args.steamCmdPath = next;
        if (next) {
          index += 1;
        }
        break;
      case "--profile-root":
        args.profileRoot = next;
        if (next) {
          index += 1;
        }
        break;
      case "--node-root":
        args.nodeRoot = next;
        if (next) {
          index += 1;
        }
        break;
      case "--customer-key":
        args.customerKey = next;
        if (next) {
          index += 1;
        }
        break;
      case "--provider-key":
        args.providerKey = next;
        if (next) {
          index += 1;
        }
        break;
      case "--provider-name":
        args.providerName = next;
        if (next) {
          index += 1;
        }
        break;
      case "--api-key":
        args.apiKey = next;
        if (next) {
          index += 1;
        }
        break;
      case "--public-address":
        args.publicAddress = next;
        if (next) {
          index += 1;
        }
        break;
      default:
        break;
    }
  }

  return args;
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists<T>(filePath: string) {
  if (!(await pathExists(filePath))) {
    return null;
  }

  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeProfileLink(profileRoot: string) {
  const profileLinkPath = getProfileLinkPath();
  await fs.mkdir(path.dirname(profileLinkPath), { recursive: true });
  await fs.writeFile(
    profileLinkPath,
    JSON.stringify(
      {
        profileRoot,
        linkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function ensureProfileFolderReadme(profileRoot: string) {
  const readmePath = path.join(profileRoot, "README.txt");
  if (await pathExists(readmePath)) {
    return;
  }

  const workspaceDataPath = getWorkspaceDataPath();
  await fs.writeFile(
    readmePath,
    [
      "LO_Profiles settings folder",
      "",
      "This folder stores the reusable dedicated-server setup data that should survive fresh installs.",
      "",
      "Important files here:",
      "- lo-tool.config.json -> launch profiles, realm settings, event settings, mod settings",
      "- install-context.json -> important install/runtime paths chosen during setup",
      "- backups\\ -> saved config backups created before installer rewrites",
      "",
      `If the manager is reinstalled somewhere else, point the new installer back to this same folder.`,
      `The workspace-local data folder only keeps a small link file that points here: ${workspaceDataPath}`,
    ].join("\r\n"),
    "utf8",
  );
}

async function backupExistingConfig(configPath: string) {
  if (!(await pathExists(configPath))) {
    return null;
  }

  const backupsPath = getBackupsPath();
  await fs.mkdir(backupsPath, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupsPath, `pre-install-config-${stamp}.json`);
  await fs.copyFile(configPath, backupPath);
  return backupPath;
}

function samePath(left: string, right: string) {
  try {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  } catch {
    return left.toLowerCase() === right.toLowerCase();
  }
}

async function readLinkedProfileRoot() {
  const profileLink = await readJsonIfExists<ProfileLink>(getProfileLinkPath());
  if (!profileLink?.profileRoot?.trim()) {
    return null;
  }

  return path.resolve(profileLink.profileRoot);
}

async function copyFileIfMissing(sourcePath: string, targetPath: string) {
  if (!(await pathExists(sourcePath)) || (await pathExists(targetPath))) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function mergeDirectoryIfMissing(sourceDirectory: string, targetDirectory: string) {
  if (!(await pathExists(sourceDirectory))) {
    return;
  }

  await fs.mkdir(targetDirectory, { recursive: true });
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      await mergeDirectoryIfMissing(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile() || (await pathExists(targetPath))) {
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

async function preserveLinkedProfileData(previousProfileRoot: string | null, selectedProfileRoot: string) {
  if (!previousProfileRoot || samePath(previousProfileRoot, selectedProfileRoot)) {
    return null;
  }

  const previousConfigPath = path.join(previousProfileRoot, "lo-tool.config.json");
  const selectedConfigPath = path.join(selectedProfileRoot, "lo-tool.config.json");
  if (!(await pathExists(previousConfigPath))) {
    return null;
  }

  await fs.mkdir(selectedProfileRoot, { recursive: true });
  const backupsPath = path.join(selectedProfileRoot, "backups");
  await fs.mkdir(backupsPath, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rescueBackupPath = path.join(backupsPath, `pre-install-linked-profile-config-${stamp}.json`);
  await fs.copyFile(previousConfigPath, rescueBackupPath);

  if (!(await pathExists(selectedConfigPath))) {
    await fs.copyFile(previousConfigPath, selectedConfigPath);
  }

  await copyFileIfMissing(path.join(previousProfileRoot, "myrealm.session-cache.json"), path.join(selectedProfileRoot, "myrealm.session-cache.json"));
  await mergeDirectoryIfMissing(path.join(previousProfileRoot, "backups"), backupsPath);
  await mergeDirectoryIfMissing(path.join(previousProfileRoot, "event-cycles"), path.join(selectedProfileRoot, "event-cycles"));

  return rescueBackupPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const previousLinkedProfileRoot = await readLinkedProfileRoot();
  if (args.serverPath) {
    process.env.LAST_OASIS_SERVER_PATH = args.serverPath;
  }
  if (args.profileRoot) {
    process.env.TOOL_01_PROFILE_ROOT = args.profileRoot;
  }

  const profileDataPath = getProfileDataPath();
  await fs.mkdir(profileDataPath, { recursive: true });
  await fs.mkdir(path.join(profileDataPath, "backups"), { recursive: true });
  const linkedProfileBackupPath = await preserveLinkedProfileData(previousLinkedProfileRoot, profileDataPath);
  await writeProfileLink(profileDataPath);
  await ensureProfileFolderReadme(profileDataPath);

  const discoveredPaths = await discoverPaths();
  const configPath = getPersistedConfigPath();
  const installContextPath = getInstallContextPath();
  const existingInstallContext = await readJsonIfExists<Partial<InstallContext>>(installContextPath);
  const derivedWorkshopPath =
    args.workshopContentPath ||
    existingInstallContext?.workshopContentPath ||
    (discoveredPaths.installPath
      ? path.resolve(discoveredPaths.installPath, "..", "..", "workshop", "content", "903950")
      : "");
  const derivedSteamCmdInstallDirectory =
    args.steamCmdInstallDirectory ||
    existingInstallContext?.steamCmdInstallDirectory ||
    (discoveredPaths.installPath ? path.join(discoveredPaths.installPath, "tools", "steamcmd") : "");
  const derivedSteamCmdPath =
    args.steamCmdPath ||
    existingInstallContext?.steamCmdPath ||
    (derivedSteamCmdInstallDirectory ? path.join(derivedSteamCmdInstallDirectory, "steamcmd.exe") : "");
  const derivedSteamExePath = args.steamExePath || existingInstallContext?.steamExePath || "";
  const derivedSteamServicePath = args.steamServicePath || existingInstallContext?.steamServicePath || "";
  const derivedGamePath = args.gamePath || existingInstallContext?.gamePath || "";
  const hasExistingConfig = await pathExists(configPath);
  const existingConfig = hasExistingConfig ? await readJsonIfExists<AppConfig>(configPath) : null;
  const config = existingConfig ?? buildDefaultConfig(discoveredPaths);

  config.operationsSettings.workshopContentPath = derivedWorkshopPath || config.operationsSettings.workshopContentPath;
  config.operationsSettings.steamCmdInstallDirectory =
    derivedSteamCmdInstallDirectory || config.operationsSettings.steamCmdInstallDirectory;
  config.operationsSettings.steamCmdPath =
    (await pathExists(derivedSteamCmdPath)) ? derivedSteamCmdPath : config.operationsSettings.steamCmdPath;
  config.operationsSettings.lastKnownPublicIp = args.publicAddress.trim() || config.operationsSettings.lastKnownPublicIp;

  if (!hasExistingConfig) {
    config.operationsSettings.modIds = [];
    config.operationsSettings.discordPlayerCounterWebhookUrl = "";
    config.operationsSettings.discordTileOnlineWebhookUrl = "";
    config.operationsSettings.discordUpdateWebhookUrl = "";
    config.myRealmFlow = null;
    config.eventTileCycles = config.eventTileCycles.map((cycle) => ({
      ...cycle,
      lastAction: "Install completed. Configure MyRealm keys, network address, and event settings before creating tiles.",
    }));
    config.eventTileCycle =
      config.eventTileCycles.find((cycle) => cycle.id === config.selectedEventTileCycleId) ??
      config.eventTileCycles[0] ??
      config.eventTileCycle;
  }

  config.realmSettings = {
    customerKey: args.customerKey.trim() || config.realmSettings.customerKey,
    providerKey: args.providerKey.trim() || config.realmSettings.providerKey,
    providerName: args.providerName.trim() || config.realmSettings.providerName,
    apiKey: args.apiKey.trim() || config.realmSettings.apiKey,
  };
  config.paths = {
    ...config.paths,
    installPath: discoveredPaths.installPath,
    executablePath: discoveredPaths.executablePath,
    workingDirectory: discoveredPaths.workingDirectory,
    localDataPath: discoveredPaths.localDataPath,
    logsPath: discoveredPaths.logsPath,
    adminDataPath: discoveredPaths.adminDataPath,
    serverConfigPath: discoveredPaths.serverConfigPath,
  };
  config.profiles = config.profiles.map((profile) => {
    const executablePath = discoveredPaths.executablePath || profile.executablePath;
    const launch = {
      ...profile.launch,
      steamDedicatedServerAppId: LAST_OASIS_LAUNCH_APP_ID,
      customerKey: args.customerKey.trim() || profile.launch.customerKey,
      providerKey: args.providerKey.trim() || profile.launch.providerKey,
      overrideConnectionAddress: args.publicAddress.trim() || profile.launch.overrideConnectionAddress,
      forceSteamClientLink: false,
      noLiveServer: true,
    };

    return {
      ...profile,
      executablePath,
      workingDirectory: executablePath ? path.dirname(executablePath) : discoveredPaths.workingDirectory,
      launch,
      generatedArguments: buildLastOasisArguments(launch),
      validationIssues: validateLastOasisSettings(launch),
    };
  });

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const backupPath = await backupExistingConfig(configPath);
  const savedConfig = await saveConfig(config);

  const installContext: InstallContext = {
    toolRoot: TOOL_ROOT,
    profileRoot: profileDataPath,
    serverPath: discoveredPaths.installPath,
    gamePath: derivedGamePath,
    steamExePath: derivedSteamExePath,
    steamServicePath: derivedSteamServicePath,
    workshopContentPath: derivedWorkshopPath,
    steamCmdInstallDirectory: derivedSteamCmdInstallDirectory,
    steamCmdPath: savedConfig.operationsSettings.steamCmdPath,
    nodeRoot: args.nodeRoot,
    installedAt: new Date().toISOString(),
  };

  await fs.writeFile(installContextPath, JSON.stringify(installContext, null, 2), "utf8");
  await writeProfileLink(profileDataPath);

  process.stdout.write(
    JSON.stringify(
      {
        configPath,
        backupPath,
        linkedProfileBackupPath,
        installContextPath,
        profileRoot: profileDataPath,
        serverPath: discoveredPaths.installPath,
        gamePath: installContext.gamePath,
        steamExePath: installContext.steamExePath,
        steamServicePath: installContext.steamServicePath,
        workshopContentPath: installContext.workshopContentPath,
        steamCmdPath: installContext.steamCmdPath,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Dedicated-server bootstrap failed.");
  process.exitCode = 1;
});
