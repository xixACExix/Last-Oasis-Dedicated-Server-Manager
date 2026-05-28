import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { getProfileDataPath } from "./configStore.js";

const REMOTE_PASSWORD_ENV = "LO_MANAGER_REMOTE_PASSWORD";
const REMOTE_PASSWORD_JSON_FILE = "remote-access.json";
const LEGACY_REMOTE_PASSWORD_FILE = "remote-access-password.txt";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map<string, number>();

type RemotePasswordSource = "environment" | "profile-json";

let passwordCache:
  | {
      password: string;
      source: RemotePasswordSource;
      filePath: string | null;
    }
  | null = null;

function hashForCompare(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function timingSafeEquals(left: string, right: string) {
  const leftHash = hashForCompare(left);
  const rightHash = hashForCompare(right);
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function getRemotePasswordFilePath() {
  return path.join(getProfileDataPath(), REMOTE_PASSWORD_JSON_FILE);
}

function getLegacyRemotePasswordFilePath() {
  return path.join(getProfileDataPath(), LEGACY_REMOTE_PASSWORD_FILE);
}

function extractPasswordFromJson(raw: string, passwordFilePath: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Remote access password file is not valid JSON: ${passwordFilePath}. ` +
        (error instanceof Error ? error.message : "Check the file format."),
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Remote access password file must contain a JSON object: ${passwordFilePath}.`);
  }

  const candidate = parsed as { password?: unknown; remotePassword?: unknown };
  const password = typeof candidate.password === "string" ? candidate.password.trim() : typeof candidate.remotePassword === "string" ? candidate.remotePassword.trim() : "";
  if (!password) {
    throw new Error(`Remote access password file is missing a password value: ${passwordFilePath}.`);
  }

  return password;
}

async function readLegacyRemotePassword() {
  const legacyPath = getLegacyRemotePasswordFilePath();
  try {
    const legacyText = await fs.readFile(legacyPath, "utf8");
    return legacyText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeRemotePasswordJson(password: string) {
  const passwordFilePath = getRemotePasswordFilePath();
  await fs.mkdir(path.dirname(passwordFilePath), { recursive: true });
  const updatedAt = new Date().toISOString();
  await fs.writeFile(
    passwordFilePath,
    `${JSON.stringify(
      {
        password,
        updatedAt,
        note: "Used by the Last Oasis Manager remote web panel. Change this from the desktop Manager when possible.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { passwordFilePath, updatedAt };
}

async function loadRemotePassword(options?: { force?: boolean }) {
  const envPassword = process.env[REMOTE_PASSWORD_ENV]?.trim();
  if (envPassword) {
    passwordCache = {
      password: envPassword,
      source: "environment",
      filePath: null,
    };
    return passwordCache;
  }

  if (!options?.force && passwordCache?.source === "profile-json") {
    return passwordCache;
  }

  const passwordFilePath = getRemotePasswordFilePath();
  await fs.mkdir(path.dirname(passwordFilePath), { recursive: true });

  try {
    const existingPassword = extractPasswordFromJson(await fs.readFile(passwordFilePath, "utf8"), passwordFilePath);
    if (existingPassword) {
      passwordCache = {
        password: existingPassword,
        source: "profile-json",
        filePath: passwordFilePath,
      };
      return passwordCache;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const legacyPassword = await readLegacyRemotePassword();
  if (legacyPassword) {
    await writeRemotePasswordJson(legacyPassword);
    passwordCache = {
      password: legacyPassword,
      source: "profile-json",
      filePath: passwordFilePath,
    };
    return passwordCache;
  }

  const generatedPassword = crypto.randomBytes(18).toString("base64url");
  await writeRemotePasswordJson(generatedPassword);

  passwordCache = {
    password: generatedPassword,
    source: "profile-json",
    filePath: passwordFilePath,
  };
  return passwordCache;
}

function normalizeRemoteAddress(value: string | undefined | null) {
  const address = (value ?? "").trim().toLowerCase();
  if (address.startsWith("::ffff:")) {
    return address.slice("::ffff:".length);
  }
  return address;
}

export function isLoopbackRequest(request: Request) {
  const candidates = [
    request.socket.remoteAddress,
    request.ip,
    Array.isArray(request.ips) ? request.ips[0] : null,
  ].map(normalizeRemoteAddress);

  return candidates.some(
    (address) =>
      address === "127.0.0.1" ||
      address === "::1" ||
      address === "localhost" ||
      address.startsWith("127."),
  );
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of sessions.entries()) {
    if (expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function extractBearerToken(request: Request) {
  const authorization = request.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || request.get("x-lo-manager-token")?.trim() || "";
}

function hasValidSession(request: Request) {
  pruneExpiredSessions();
  const token = extractBearerToken(request);
  if (!token) {
    return false;
  }

  const expiresAt = sessions.get(token);
  return Boolean(expiresAt && expiresAt > Date.now());
}

export async function getRemoteAccessInfo(request?: Request) {
  const password = await loadRemotePassword();
  const loopback = request ? isLoopbackRequest(request) : false;
  return {
    authRequired: true,
    remotePasswordRequired: request ? !loopback : true,
    localBypass: loopback,
    sessionMinutes: Math.round(SESSION_TTL_MS / 60000),
    passwordSource: password.source,
    passwordFilePath: loopback ? password.filePath : null,
    passwordEnvName: REMOTE_PASSWORD_ENV,
  };
}

export async function updateRemotePassword(rawPassword: string) {
  if (process.env[REMOTE_PASSWORD_ENV]?.trim()) {
    throw new Error(`Remote password is controlled by ${REMOTE_PASSWORD_ENV}. Remove that environment override before changing it in the Manager.`);
  }

  const password = rawPassword.trim();
  if (password.length < 8) {
    throw new Error("Remote password must be at least 8 characters.");
  }
  if (password.length > 200) {
    throw new Error("Remote password must be 200 characters or less.");
  }

  const { passwordFilePath, updatedAt } = await writeRemotePasswordJson(password);
  passwordCache = {
    password,
    source: "profile-json",
    filePath: passwordFilePath,
  };
  sessions.clear();

  return {
    passwordSource: passwordCache.source,
    passwordFilePath,
    sessionsCleared: true,
    updatedAt,
  };
}

export async function loginRemoteAccess(request: Request, response: Response) {
  try {
    const body = request.body as { password?: unknown };
    const providedPassword = typeof body.password === "string" ? body.password : "";
    const configuredPassword = await loadRemotePassword();

    if (!providedPassword || !timingSafeEquals(providedPassword, configuredPassword.password)) {
      response.status(401).json({ error: "Remote password is incorrect." });
      return;
    }

    pruneExpiredSessions();
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(token, expiresAt);

    response.json({
      ok: true,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      sessionMinutes: Math.round(SESSION_TTL_MS / 60000),
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to log in to remote access.",
    });
  }
}

export function requireRemoteAccess(request: Request, response: Response, next: NextFunction) {
  if (isLoopbackRequest(request) || hasValidSession(request)) {
    next();
    return;
  }

  response.status(401).json({
    error: "Remote password login required.",
    loginPath: "/api/remote/login",
  });
}
