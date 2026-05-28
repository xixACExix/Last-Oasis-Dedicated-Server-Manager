import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getInstallContextPath } from "./configStore.js";
import { getSteamLoginInfo, loadSteamLoginCredentials } from "./steamCredentials.js";

type InstallContext = {
  steamExePath?: string;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runPowerShell(command: string) {
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error((stderr || stdout || `PowerShell exited with code ${code}.`).trim()));
    });
  });
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readInstallContextSteamPath() {
  try {
    const parsed = JSON.parse(await fs.readFile(getInstallContextPath(), "utf8")) as InstallContext;
    const steamExePath = typeof parsed.steamExePath === "string" ? parsed.steamExePath.trim() : "";
    return steamExePath;
  } catch {
    return "";
  }
}

async function readRegistrySteamPath() {
  if (process.platform !== "win32") {
    return "";
  }

  const output = await runPowerShell(
    [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$paths = @(",
      "  (Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -Name SteamExe).SteamExe,",
      "  (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -Name InstallPath).InstallPath,",
      "  (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Valve\\Steam' -Name InstallPath).InstallPath",
      ")",
      "$paths | Where-Object { $_ } | ForEach-Object {",
      "  if ($_ -match '\\.exe$') { $_ } else { Join-Path $_ 'steam.exe' }",
      "} | Select-Object -First 1",
    ].join("\n"),
  ).catch(() => "");

  return output.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

export async function findSteamClientExePath() {
  const candidates = [
    await readInstallContextSteamPath(),
    process.env.STEAM_EXE_PATH ?? "",
    await readRegistrySteamPath(),
    "C:\\Program Files (x86)\\Steam\\steam.exe",
    "C:\\Program Files\\Steam\\steam.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return path.normalize(candidate);
    }
  }

  return candidates[0] ? path.normalize(candidates[0]) : "";
}

export async function isSteamClientRunning() {
  if (process.platform !== "win32") {
    return false;
  }

  const output = await runPowerShell(
    "if (Get-Process -Name steam -ErrorAction SilentlyContinue) { 'true' } else { 'false' }",
  ).catch(() => "false");
  return output.trim().toLowerCase().includes("true");
}

export async function getSteamClientStatus() {
  const [loginInfo, steamExePath, running] = await Promise.all([
    getSteamLoginInfo(),
    findSteamClientExePath(),
    isSteamClientRunning(),
  ]);

  const canLogin = Boolean(loginInfo.configured && loginInfo.hasPassword && steamExePath);
  return {
    ok: true,
    steamExePath,
    running,
    canLogin,
    accountName: loginInfo.accountName,
    steamClientAutoLogin: loginInfo.steamClientAutoLogin,
    checkedAt: new Date().toISOString(),
    note: !steamExePath
      ? "Steam.exe was not found."
      : canLogin
        ? "Steam client login can use the saved encrypted Steam secret."
        : "Save a Steam login secret before starting the Steam client login.",
  };
}

export async function loginSteamClient(reason = "manual") {
  if (process.platform !== "win32") {
    throw new Error("Steam client login is only available on Windows.");
  }

  const credentials = await loadSteamLoginCredentials();
  if (!credentials) {
    throw new Error("Save the Steam login secret before starting the Steam client login.");
  }

  const steamExePath = await findSteamClientExePath();
  if (!steamExePath || !(await exists(steamExePath))) {
    throw new Error("Steam.exe was not found. Install Steam or set the Steam path during setup.");
  }

  const runningBefore = await isSteamClientRunning();
  const child = spawn(steamExePath, ["-silent", "-login", credentials.accountName, credentials.password], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  await delay(1500);
  const runningAfter = await isSteamClientRunning();
  return {
    ok: true,
    steamExePath,
    accountName: credentials.accountName,
    reason,
    runningBefore,
    runningAfter,
    checkedAt: new Date().toISOString(),
    note: runningAfter
      ? "Steam client login command was sent."
      : "Steam client login command was sent, but Steam is not visible as running yet.",
  };
}

export async function maybeAutoLoginSteamClientOnBackendStartup() {
  const loginInfo = await getSteamLoginInfo();
  if (!loginInfo.configured || !loginInfo.hasPassword || !loginInfo.steamClientAutoLogin) {
    return {
      attempted: false,
      note: "Steam client auto-login is not enabled.",
    };
  }

  const result = await loginSteamClient("backend-startup");
  return {
    attempted: true,
    ...result,
  };
}
