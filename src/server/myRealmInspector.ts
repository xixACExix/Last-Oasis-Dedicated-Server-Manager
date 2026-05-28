import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MyRealmFlowSummary } from "../shared/types.js";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const INSPECTOR_ROOT = path.join(ROOT_DIR, "data", "MyRealmInspector");
const INSPECTOR_EXE = path.join(INSPECTOR_ROOT, "MyRealmInspector.exe");
const INSPECTOR_DLL = path.join(INSPECTOR_ROOT, "MyRealmInspector.dll");
const INSPECTOR_PROJECT = path.join(ROOT_DIR, "data", "MyRealmInspector", "MyRealmInspector.csproj");

type InspectorRow = {
  url?: string;
  title?: string;
  last_visit_time?: number | string | null;
};

type InspectorBrowserResult = {
  browser?: string;
  history?: { exists?: boolean; rows?: InspectorRow[] };
};

function extractId(url: string, pattern: RegExp) {
  const match = url.match(pattern);
  return match?.[1] ?? null;
}

function firstRecoveredId(urls: string[], pattern: RegExp) {
  for (const url of urls) {
    const id = extractId(url, pattern);
    if (id) {
      return id;
    }
  }

  return null;
}

function tryGetPathname(rawUrl: string) {
  try {
    return new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return rawUrl.toLowerCase();
  }
}

function getRowVisitTime(row: InspectorRow) {
  const parsed = Number(row.last_visit_time ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getBrowserResultVisitTime(result: InspectorBrowserResult) {
  return Math.max(0, ...(result.history?.rows ?? []).map(getRowVisitTime));
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runInspector() {
  const sharedOptions = {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 8,
  } as const;

  if (await exists(INSPECTOR_EXE)) {
    return execFileAsync(INSPECTOR_EXE, [], sharedOptions);
  }

  if (await exists(INSPECTOR_DLL)) {
    return execFileAsync("dotnet", [INSPECTOR_DLL], sharedOptions);
  }

  if (await exists(INSPECTOR_PROJECT)) {
    return execFileAsync("dotnet", ["run", "--project", INSPECTOR_PROJECT], sharedOptions);
  }

  throw new Error(
    `MyRealm inspector helper is missing from this install. Expected it under ${INSPECTOR_ROOT}. Reinstall the control center package.`,
  );
}

export async function inspectMyRealmFlow(): Promise<MyRealmFlowSummary> {
  const { stdout } = await runInspector();

  const parsed = JSON.parse(stdout) as InspectorBrowserResult[];
  const browserResult = parsed
    .filter((entry) => (entry.history?.rows?.length ?? 0) > 0)
    .sort((left, right) => getBrowserResultVisitTime(right) - getBrowserResultVisitTime(left))[0];

  if (!browserResult?.history?.rows?.length) {
    return {
      browser: null,
      customerId: null,
      realmId: null,
      dashboardUrl: null,
      realmUrl: null,
      mapUrl: null,
      serversUrl: null,
      providersUrl: null,
      usersUrl: null,
      apiUrl: null,
      recentTileUrls: [],
      note: "No authenticated MyRealm history was found in the inspected browser profiles.",
    };
  }

  const urls = browserResult.history.rows.map((row) => row.url).filter((url): url is string => Boolean(url));
  const customerUrl = urls.find((url) => /\/customer\/\d+$/.test(tryGetPathname(url))) ?? null;
  const realmUrl = urls.find((url) => /\/realm\/\d+$/.test(tryGetPathname(url))) ?? null;
  const mapUrl = urls.find((url) => /\/realm\/\d+\/map$/.test(tryGetPathname(url))) ?? null;
  const serversUrl = urls.find((url) => /\/customer\/\d+\/servers$/.test(tryGetPathname(url))) ?? null;
  const providersUrl = urls.find((url) => /\/customer\/\d+\/providers$/.test(tryGetPathname(url))) ?? null;
  const usersUrl = urls.find((url) => /\/customer\/\d+\/users$/.test(tryGetPathname(url))) ?? null;
  const apiUrl = urls.find((url) => /\/customer\/\d+\/api$/.test(tryGetPathname(url))) ?? null;
  const recentTileUrls = urls.filter((url) => /\/realm\/\d+\/tiles\/\d+/.test(tryGetPathname(url))).slice(0, 8);
  const customerId =
    (customerUrl && extractId(customerUrl, /\/customer\/(\d+)/i)) ||
    (serversUrl && extractId(serversUrl, /\/customer\/(\d+)/i)) ||
    (providersUrl && extractId(providersUrl, /\/customer\/(\d+)/i)) ||
    (usersUrl && extractId(usersUrl, /\/customer\/(\d+)/i)) ||
    (apiUrl && extractId(apiUrl, /\/customer\/(\d+)/i)) ||
    firstRecoveredId(urls, /\/customer\/(\d+)/i) ||
    null;
  const realmId =
    (realmUrl && extractId(realmUrl, /\/realm\/(\d+)/i)) ||
    (mapUrl && extractId(mapUrl, /\/realm\/(\d+)/i)) ||
    firstRecoveredId(urls, /\/realm\/(\d+)/i) ||
    null;
  const resolvedDashboardUrl = customerUrl ?? (customerId ? `https://myrealm.lastoasis.gg/customer/${customerId}` : null);
  const resolvedRealmUrl = realmUrl ?? (realmId ? `https://myrealm.lastoasis.gg/realm/${realmId}` : null);
  const resolvedMapUrl = mapUrl ?? (realmId ? `https://myrealm.lastoasis.gg/realm/${realmId}/Map` : null);
  const resolvedServersUrl = serversUrl ?? (customerId ? `https://myrealm.lastoasis.gg/customer/${customerId}/Servers` : null);
  const resolvedProvidersUrl = providersUrl ?? (customerId ? `https://myrealm.lastoasis.gg/customer/${customerId}/Providers` : null);
  const resolvedUsersUrl = usersUrl ?? (customerId ? `https://myrealm.lastoasis.gg/customer/${customerId}/Users` : null);
  const resolvedApiUrl = apiUrl ?? (customerId ? `https://myrealm.lastoasis.gg/customer/${customerId}/Api` : null);

  return {
    browser: browserResult.browser ?? null,
    customerId,
    realmId,
    dashboardUrl: resolvedDashboardUrl,
    realmUrl: resolvedRealmUrl,
    mapUrl: resolvedMapUrl,
    serversUrl: resolvedServersUrl,
    providersUrl: resolvedProvidersUrl,
    usersUrl: resolvedUsersUrl,
    apiUrl: resolvedApiUrl,
    recentTileUrls,
    note: `Recovered recent authenticated MyRealm routes from ${browserResult.browser ?? "a browser"} history. Use the live-session button to read the signed-in pages directly.`,
  };
}
