import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getProfileDataPath } from "./configStore.js";

const STEAM_LOGIN_FILE = "steam-login.json";
const SECRET_PROTECTION = "windows-dpapi-user";

type SteamLoginRecord = {
  accountName: string;
  encryptedPassword: string;
  protection: typeof SECRET_PROTECTION;
  steamClientAutoLogin: boolean;
  updatedAt: string;
  note: string;
};

function getSteamLoginFilePath() {
  return path.join(getProfileDataPath(), STEAM_LOGIN_FILE);
}

function ensureWindowsSecretSupport() {
  if (process.platform !== "win32") {
    throw new Error("Steam login storage is only available on Windows.");
  }
}

function runPowerShellSecretScript(script: string, input: string) {
  ensureWindowsSecretSupport();
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
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
        resolve(stdout);
        return;
      }

      reject(new Error((stderr || stdout || `PowerShell exited with code ${code}.`).trim()));
    });

    child.stdin.end(input, "utf8");
  });
}

async function encryptSecret(secret: string) {
  return (
    await runPowerShellSecretScript(
      [
        "$ErrorActionPreference = 'Stop'",
        "$plain = [Console]::In.ReadToEnd()",
        "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
        "$encrypted = ConvertFrom-SecureString -SecureString $secure",
        "[Console]::Out.Write($encrypted)",
      ].join("\n"),
      secret,
    )
  ).trim();
}

async function decryptSecret(encryptedSecret: string) {
  return runPowerShellSecretScript(
    [
      "$ErrorActionPreference = 'Stop'",
      "$encrypted = [Console]::In.ReadToEnd().Trim()",
      "$secure = ConvertTo-SecureString -String $encrypted",
      "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
      "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }",
      "finally { if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) } }",
    ].join("\n"),
    encryptedSecret,
  );
}

async function writeJsonAtomically(filePath: string, payload: unknown) {
  const directoryPath = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const tempPath = path.join(directoryPath, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readSteamLoginRecord() {
  const filePath = getSteamLoginFilePath();
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<SteamLoginRecord>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const accountName = typeof parsed.accountName === "string" ? parsed.accountName.trim() : "";
    const encryptedPassword = typeof parsed.encryptedPassword === "string" ? parsed.encryptedPassword.trim() : "";
    if (!accountName || !encryptedPassword) {
      return null;
    }

    return {
      accountName,
      encryptedPassword,
      protection: SECRET_PROTECTION,
      steamClientAutoLogin: parsed.steamClientAutoLogin === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      note: typeof parsed.note === "string" ? parsed.note : "",
    } satisfies SteamLoginRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function getSteamLoginInfo() {
  const filePath = getSteamLoginFilePath();
  const record = await readSteamLoginRecord();
  return {
    configured: Boolean(record),
    accountName: record?.accountName ?? "",
    hasPassword: Boolean(record?.encryptedPassword),
    steamClientAutoLogin: record?.steamClientAutoLogin === true,
    updatedAt: record?.updatedAt || null,
    filePath,
    protection: SECRET_PROTECTION,
  };
}

export async function saveSteamLoginCredentials(accountName: string, password: string, steamClientAutoLogin = false) {
  const normalizedAccountName = accountName.trim();
  if (!normalizedAccountName) {
    throw new Error("Steam login name is required.");
  }
  if (!password) {
    throw new Error("Steam password is required.");
  }

  const updatedAt = new Date().toISOString();
  const encryptedPassword = await encryptSecret(password);
  const filePath = getSteamLoginFilePath();
  await writeJsonAtomically(filePath, {
    accountName: normalizedAccountName,
    encryptedPassword,
    protection: SECRET_PROTECTION,
    steamClientAutoLogin,
    updatedAt,
    note: "Steam server account for the Last Oasis Manager. Password is protected by Windows DPAPI for this Windows user.",
  } satisfies SteamLoginRecord);

  return getSteamLoginInfo();
}

export async function clearSteamLoginCredentials() {
  await fs.rm(getSteamLoginFilePath(), { force: true });
  return getSteamLoginInfo();
}

export async function loadSteamLoginCredentials() {
  const record = await readSteamLoginRecord();
  if (!record) {
    return null;
  }

  return {
    accountName: record.accountName,
    password: await decryptSecret(record.encryptedPassword),
    updatedAt: record.updatedAt,
  };
}
