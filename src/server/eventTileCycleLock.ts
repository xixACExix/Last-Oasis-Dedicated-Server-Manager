import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../shared/types.js";
import { loadConfig } from "./configStore.js";

const EVENT_TILE_LOCK_FILE = "event-tile-cycle.lock";
const EVENT_TILE_LOCK_TIMEOUT_MS = 30_000;
const EVENT_TILE_LOCK_RETRY_MS = 250;
const EVENT_TILE_LOCK_STALE_MS = 10 * 60 * 1000;

function getEventTileLockDirectory(config: AppConfig) {
  const persistedConfigPath = config.paths.persistedConfigPath?.trim();
  if (persistedConfigPath) {
    return path.dirname(persistedConfigPath);
  }

  return path.join(process.cwd(), "data");
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleEventTileLock(lockPath: string) {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > EVENT_TILE_LOCK_STALE_MS) {
      await fs.rm(lockPath, { force: true });
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export async function runWithEventTileCycleLock<T>(
  config: AppConfig,
  cycleId: string | null | undefined,
  actionLabel: string,
  work: (freshConfig: AppConfig) => Promise<T>,
) {
  const lockDirectory = getEventTileLockDirectory(config);
  const lockPath = path.join(lockDirectory, EVENT_TILE_LOCK_FILE);
  const deadline = Date.now() + EVENT_TILE_LOCK_TIMEOUT_MS;
  await fs.mkdir(lockDirectory, { recursive: true });

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  while (!handle && Date.now() < deadline) {
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify(
          {
            pid: process.pid,
            action: actionLabel,
            cycleId: cycleId ?? null,
            acquiredAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      break;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
      if (code !== "EEXIST") {
        throw error;
      }

      const removed = await removeStaleEventTileLock(lockPath);
      if (!removed) {
        await delay(EVENT_TILE_LOCK_RETRY_MS);
      }
    }
  }

  if (!handle) {
    throw new Error("Another backend is already processing event tile automation. Please wait a moment and try again.");
  }

  try {
    const freshConfig = await loadConfig();
    return await work(freshConfig);
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}
