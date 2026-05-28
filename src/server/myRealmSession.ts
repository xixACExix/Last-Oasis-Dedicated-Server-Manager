import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MyRealmCreateTileOption,
  MyRealmFlowSummary,
  MyRealmSessionSnapshot,
  MyRealmTileModsSyncResult,
  MyRealmTilePvpMode,
  MyRealmTileSummary,
} from "../shared/types.js";
import { getProfileDataPath } from "./configStore.js";
import { loadSteamLoginCredentials } from "./steamCredentials.js";

const DEBUG_PORT = 9222;
const DEBUG_ENDPOINT = `http://127.0.0.1:${DEBUG_PORT}`;
const MYREALM_ORIGIN = "https://myrealm.lastoasis.gg";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
const MYREALM_SESSION_CACHE_PATH = path.join(ROOT_DIR, "data", "myrealm.session-cache.json");
const LEGACY_EDGE_DEBUG_PROFILE_ROOT = path.join(ROOT_DIR, "data", "edge-debug-profile");
const EDGE_EXECUTABLE_CANDIDATES = [
  process.env.MSEDGE_PATH,
  process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe") : "",
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe") : "",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter((entry): entry is string => Boolean(entry));

type DevToolsTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

type ChromeCookie = {
  name: string;
  value: string;
  domain: string;
};

type RuntimeEvaluateResult<T> = {
  result?: {
    type?: string;
    value?: T;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
    };
  };
};

type MyRealmMapIndexTile = {
  id: number;
  name: string;
  statusText?: string | null;
  hostingStatusText?: string | null;
  x?: number | null;
  y?: number | null;
  quality?: number | null;
  pvpModeText?: string | null;
  canActivate?: boolean;
  canDeactivate?: boolean;
  canDelete?: boolean;
  canUseAutomation?: boolean;
  isActive?: boolean;
  isInactive?: boolean;
  isPendingActive?: boolean;
  isPendingInactive?: boolean;
  playerCount?: number | null;
  activationDate?: string | null;
  deactivationDate?: string | null;
  map?: {
    name?: string | null;
  } | null;
};

type MyRealmMapIndexResponse = {
  realmId: number;
  tileList: MyRealmMapIndexTile[];
};

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findEdgeExecutable() {
  for (const candidate of EDGE_EXECUTABLE_CANDIDATES) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error("Microsoft Edge was not found on this machine. Install Edge or set MSEDGE_PATH first.");
}

async function ensureEdgeDebugProfileRoot() {
  const profileRoot = path.join(getProfileDataPath(), "MyRealm Edge Profile");
  await fs.mkdir(path.dirname(profileRoot), { recursive: true });

  if (
    profileRoot !== LEGACY_EDGE_DEBUG_PROFILE_ROOT &&
    (await exists(LEGACY_EDGE_DEBUG_PROFILE_ROOT)) &&
    !(await exists(profileRoot))
  ) {
    await fs.cp(LEGACY_EDGE_DEBUG_PROFILE_ROOT, profileRoot, { recursive: true });
  }

  await fs.mkdir(profileRoot, { recursive: true });
  return profileRoot;
}

function absolutizeUrl(rawUrl: string | null) {
  if (!rawUrl) {
    return null;
  }

  try {
    return new URL(rawUrl, MYREALM_ORIGIN).toString();
  } catch {
    return null;
  }
}

function isMyRealmUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.hostname === "myrealm.lastoasis.gg";
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function cleanText(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized = decodeHtmlEntities(stripTags(value)).replace(/\s+/g, " ").trim();
  return normalized || null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFirst(html: string, pattern: RegExp) {
  const match = pattern.exec(html);
  return cleanText(match?.[1]);
}

function extractLink(html: string, pattern: RegExp) {
  const match = pattern.exec(html);
  return absolutizeUrl(match?.[1] ?? null);
}

function extractRequestVerificationToken(html: string) {
  return (
    extractFirst(html, /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i) ??
    extractFirst(html, /value="([^"]+)"[^>]*name="__RequestVerificationToken"/i)
  );
}

function extractIdFromUrl(rawUrl: string | null | undefined, pattern: RegExp) {
  if (!rawUrl) {
    return null;
  }

  const match = rawUrl.match(pattern);
  return cleanText(match?.[1]);
}

function extractCustomerIdFromHtml(html: string | null | undefined) {
  if (!html) {
    return null;
  }

  return (
    extractFirst(html, /href="\/customer\/(\d+)"/i) ??
    extractFirst(html, /action="\/customer\/(\d+)"/i)
  );
}

function extractRealmIdFromHtml(html: string | null | undefined) {
  if (!html) {
    return null;
  }

  return (
    extractFirst(html, /href="\/realm\/(\d+)"/i) ??
    extractFirst(html, /action="\/realm\/(\d+)"/i)
  );
}

function extractTextareaValue(html: string, fieldName: string) {
  const match = new RegExp(`<textarea[^>]*name="${escapeRegExp(fieldName)}"[^>]*>([\\s\\S]*?)<\\/textarea>`, "i").exec(html);
  if (!match?.[1]) {
    return null;
  }

  return decodeHtmlEntities(match[1]).replace(/\r/g, "").trim();
}

function extractInputValue(html: string, fieldName: string) {
  return (
    extractFirst(html, new RegExp(`name="${escapeRegExp(fieldName)}"[^>]*value="([^"]*)"`, "i")) ??
    extractFirst(html, new RegExp(`value="([^"]*)"[^>]*name="${escapeRegExp(fieldName)}"`, "i"))
  );
}

function extractHiddenInputs(html: string) {
  const values = new Map<string, string>();
  const patterns = [
    /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi,
    /<input[^>]*value="([^"]*)"[^>]*type="hidden"[^>]*name="([^"]+)"/gi,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const first = decodeHtmlEntities(match[1] ?? "");
      const second = decodeHtmlEntities(match[2] ?? "");
      if (pattern === patterns[0]) {
        values.set(first, second);
      } else {
        values.set(second, first);
      }
    }
  }

  return values;
}

function extractTableValue(html: string, label: string) {
  return extractFirst(html, new RegExp(`<td[^>]*>\\s*${escapeRegExp(label)}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i"));
}

function extractSectionTableValue(html: string, sectionLabel: string, rowLabel: string) {
  const sectionMatch = new RegExp(`>\\s*${escapeRegExp(sectionLabel)}\\s*<`, "i").exec(html);
  const sectionHtml = sectionMatch ? html.slice(sectionMatch.index, sectionMatch.index + 4000) : html;
  return extractFirst(
    sectionHtml,
    new RegExp(`<td[^>]*>\\s*${escapeRegExp(rowLabel)}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i"),
  );
}

function extractActivePlayers(html: string) {
  const oldShape = Number.parseInt(html.match(/id="activeplayers">(\d+)</i)?.[1] ?? "", 10);
  if (Number.isFinite(oldShape)) {
    return oldShape;
  }

  const cardValue = extractSectionTableValue(html, "Players", "Active");
  const parsedCardValue = Number.parseInt(cleanText(cardValue)?.replace(/[^0-9]/g, "") ?? "", 10);
  return Number.isFinite(parsedCardValue) ? parsedCardValue : null;
}

export function isCurrentlyCreatedMyRealmTile(tile: MyRealmTileSummary) {
  return (tile.isActive || tile.isPendingActive) && !tile.isPendingInactive;
}

function collectActiveTileNames(html: string) {
  const names: string[] = [];
  const pattern = /<tr class="table-warning"[\s\S]*?<td[^>]*>\s*([^<]+?)\s*(?:<span|<\/td>)/gi;

  for (const match of html.matchAll(pattern)) {
    const name = cleanText(match[1]);
    if (name) {
      names.push(name);
    }
  }

  return names.slice(0, 12);
}

async function fetchDevToolsTargets(): Promise<DevToolsTarget[] | null> {
  try {
    const response = await fetch(`${DEBUG_ENDPOINT}/json/list`);
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as DevToolsTarget[];
  } catch {
    return null;
  }
}

function selectTarget(targets: DevToolsTarget[], preferredUrl: string | null) {
  const exactMatch = preferredUrl ? targets.find((target) => target.webSocketDebuggerUrl && target.url === preferredUrl) : null;
  if (exactMatch) {
    return exactMatch;
  }

  return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl && isMyRealmUrl(target.url)) ?? null;
}

async function ensureDebugTarget(flow: MyRealmFlowSummary, options?: { allowLaunch?: boolean }) {
  const preferredUrl = absolutizeUrl(flow.mapUrl ?? flow.realmUrl ?? flow.dashboardUrl ?? flow.apiUrl ?? `${MYREALM_ORIGIN}/`);
  const currentTargets = await fetchDevToolsTargets();
  const currentTarget = currentTargets ? selectTarget(currentTargets, preferredUrl) : null;

  if (currentTarget) {
    return currentTarget;
  }

  if (!options?.allowLaunch) {
    throw new Error("No signed-in MyRealm Edge page is currently open for the control center to reuse.");
  }

  const edgeExecutable = await findEdgeExecutable();
  const edgeDebugProfileRoot = await ensureEdgeDebugProfileRoot();
  spawn(
    edgeExecutable,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${edgeDebugProfileRoot}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--new-window",
      preferredUrl ?? `${MYREALM_ORIGIN}/`,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  ).unref();

  const debugStartedAt = Date.now();
  while (Date.now() - debugStartedAt < 20000) {
    const targets = await fetchDevToolsTargets();
    const target = targets ? selectTarget(targets, preferredUrl) : null;
    if (target) {
      return target;
    }

    await delay(500);
  }

  throw new Error("Edge did not expose a debuggable MyRealm page in time. Sign into MyRealm in Edge and try again.");
}

class CdpClient {
  private readonly socket: WebSocket;

  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();

  private nextId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event) => {
      const payload = typeof event.data === "string" ? event.data : "";
      if (!payload) {
        return;
      }

      const parsed = JSON.parse(payload) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof parsed.id !== "number") {
        return;
      }

      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? "Chrome DevTools Protocol command failed."));
        return;
      }

      pending.resolve(parsed.result ?? null);
    });

    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("The browser debug session closed unexpectedly."));
      }

      this.pending.clear();
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", (event) => reject(event), { once: true });
    });

    return new CdpClient(socket);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;

    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });

    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  async evaluate<T>(expression: string) {
    const response = await this.send<RuntimeEvaluateResult<T>>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Browser script failed.");
    }

    return response.result?.value as T;
  }

  close() {
    this.socket.close();
  }
}

function hasAuthenticatedMyRealmCookie(cookies: ChromeCookie[]) {
  return cookies.some((cookie) => cookie.name === ".AspNetCore.Cookies");
}

function buildMyRealmCookieHeader(cookies: ChromeCookie[]) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function readMyRealmCookies(client: CdpClient, target: DevToolsTarget, flow: MyRealmFlowSummary) {
  const currentUrl = await client.evaluate<string>("window.location.href").catch(() => target.url);
  const result = await client.send<{ cookies?: ChromeCookie[] }>("Network.getCookies", {
    urls: [MYREALM_ORIGIN, absolutizeUrl(flow.dashboardUrl ?? flow.realmUrl ?? currentUrl) ?? currentUrl],
  });

  return (result.cookies ?? []).filter((cookie) => cookie.domain.includes("myrealm.lastoasis.gg"));
}

async function waitForMyRealmCookie(client: CdpClient, target: DevToolsTarget, flow: MyRealmFlowSummary, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await readMyRealmCookies(client, target, flow);
    if (hasAuthenticatedMyRealmCookie(cookies)) {
      return cookies;
    }

    await delay(500);
  }

  return [];
}

async function tryClickMyRealmSteamSignIn(client: CdpClient) {
  return client.evaluate<boolean>(`(() => {
    const labelFor = (element) => [
      element.innerText,
      element.textContent,
      element.value,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("href")
    ].filter(Boolean).join(" ").toLowerCase();
    const candidates = Array.from(document.querySelectorAll("a,button,input[type='button'],input[type='submit']"));
    const login = candidates.find((element) => {
      const label = labelFor(element);
      return label.includes("sign in") || label.includes("login") || label.includes("steam");
    });
    if (!login) {
      return false;
    }
    login.click();
    return true;
  })()`);
}

async function fillSteamLoginForm(client: CdpClient, accountName: string, password: string) {
  return client.evaluate<{ submitted: boolean; reason: string }>(`(() => {
    const accountName = ${JSON.stringify(accountName)};
    const password = ${JSON.stringify(password)};
    const setInputValue = (element, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const fields = Array.from(document.querySelectorAll("input"));
    const usernameInput =
      document.querySelector("input[name='username'], input#input_username, input[autocomplete='username']") ||
      fields.find((field) => ["text", "email", ""].includes((field.getAttribute("type") || "").toLowerCase()));
    const passwordInput =
      document.querySelector("input[name='password'], input#input_password, input[type='password'], input[autocomplete='current-password']");
    if (!usernameInput || !passwordInput) {
      const bodyText = (document.body?.innerText || "").toLowerCase();
      if (bodyText.includes("steam guard") || bodyText.includes("authenticator") || bodyText.includes("verification code")) {
        return { submitted: false, reason: "Steam is asking for Steam Guard or an authenticator code." };
      }
      if (bodyText.includes("captcha")) {
        return { submitted: false, reason: "Steam is asking for captcha verification." };
      }
      return { submitted: false, reason: "Steam login fields were not found." };
    }
    setInputValue(usernameInput, accountName);
    setInputValue(passwordInput, password);
    const buttons = Array.from(document.querySelectorAll("button,input[type='submit']"));
    const submitButton = buttons.find((button) => {
      const label = [button.innerText, button.textContent, button.value, button.getAttribute("aria-label")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return label.includes("sign in") || label.includes("login") || label.includes("submit") || button.type === "submit";
    });
    if (submitButton) {
      submitButton.click();
    } else if (passwordInput.form) {
      passwordInput.form.requestSubmit();
    } else {
      passwordInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    return { submitted: true, reason: "" };
  })()`);
}

async function describeLoginPageState(client: CdpClient) {
  return client.evaluate<{ url: string; text: string }>(`(() => ({
    url: window.location.href,
    text: (document.body?.innerText || "").slice(0, 3000)
  }))()`);
}

async function autoLoginMyRealm(client: CdpClient, target: DevToolsTarget, flow: MyRealmFlowSummary) {
  const credentials = await loadSteamLoginCredentials();
  if (!credentials) {
    throw new Error("No authenticated MyRealm cookie was found. Save the Steam login secret in the desktop Manager, or sign into MyRealm manually in the managed Edge profile.");
  }

  await client.send("Page.enable");
  await client.send("Runtime.enable").catch(() => undefined);
  await client.send("Page.bringToFront").catch(() => undefined);
  const targetUrl = absolutizeUrl(flow.mapUrl ?? flow.realmUrl ?? flow.dashboardUrl ?? `${MYREALM_ORIGIN}/`) ?? `${MYREALM_ORIGIN}/`;
  await client.send("Page.navigate", { url: targetUrl });
  await delay(2500);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cookies = await readMyRealmCookies(client, target, flow);
    if (hasAuthenticatedMyRealmCookie(cookies)) {
      return cookies;
    }

    const pageState = await describeLoginPageState(client).catch(() => ({ url: "", text: "" }));
    const currentUrl = pageState.url.toLowerCase();
    const pageText = pageState.text.toLowerCase();
    if (pageText.includes("steam guard") || pageText.includes("authenticator") || pageText.includes("verification code")) {
      throw new Error("Steam login needs Steam Guard or an authenticator code. Finish that once in the managed Edge profile, then the saved session can be reused.");
    }
    if (pageText.includes("captcha")) {
      throw new Error("Steam login needs captcha verification. Finish it once in the managed Edge profile.");
    }
    if (pageText.includes("incorrect") || pageText.includes("try again") || pageText.includes("too many")) {
      throw new Error("Steam rejected the saved login. Check the Steam login name/password saved in the Manager.");
    }

    if (currentUrl.includes("steamcommunity.com") || currentUrl.includes("store.steampowered.com")) {
      const result = await fillSteamLoginForm(client, credentials.accountName, credentials.password);
      if (!result.submitted) {
        throw new Error(result.reason || "Steam login form could not be submitted.");
      }
      const loggedInCookies = await waitForMyRealmCookie(client, target, flow, 20000);
      if (hasAuthenticatedMyRealmCookie(loggedInCookies)) {
        return loggedInCookies;
      }
      await delay(1500);
      continue;
    }

    const clicked = await tryClickMyRealmSteamSignIn(client).catch(() => false);
    if (!clicked) {
      await client.send("Page.navigate", { url: MYREALM_ORIGIN }).catch(() => undefined);
    }
    await delay(2500);
  }

  throw new Error("The manager could not finish the Steam/MyRealm auto-login. Open MyRealm in the managed Edge profile once and complete the visible login page.");
}

async function getMyRealmCookieHeader(target: DevToolsTarget, flow: MyRealmFlowSummary) {
  if (!target.webSocketDebuggerUrl) {
    throw new Error("The selected Edge tab does not expose a debugging socket.");
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);

  try {
    await client.send("Network.enable");
    const cookies = await readMyRealmCookies(client, target, flow);
    if (hasAuthenticatedMyRealmCookie(cookies)) {
      return buildMyRealmCookieHeader(cookies);
    }

    const loggedInCookies = await autoLoginMyRealm(client, target, flow);
    return buildMyRealmCookieHeader(loggedInCookies);
  } finally {
    client.close();
  }
}

export async function openMyRealmManagedBrowser(flow: MyRealmFlowSummary, rawUrl: string) {
  const targetUrl = absolutizeUrl(rawUrl);
  if (!targetUrl || !isMyRealmUrl(targetUrl)) {
    throw new Error("Only MyRealm URLs can be opened in the managed MyRealm browser session.");
  }

  const target = await ensureDebugTarget(flow, { allowLaunch: true });
  if (!target.webSocketDebuggerUrl) {
    throw new Error("The managed MyRealm Edge tab does not expose a debugging socket.");
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Page.bringToFront").catch(() => undefined);
    await client.send("Page.navigate", { url: targetUrl });
    await client.send("Page.bringToFront").catch(() => undefined);
  } finally {
    client.close();
  }

  return {
    url: targetUrl,
    targetId: target.id,
  };
}

async function fetchAuthenticatedPage(url: string, cookieHeader: string) {
  const response = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Last Oasis Control Center",
    },
  });

  if (!response.ok) {
    throw new Error(`MyRealm returned ${response.status} while fetching ${url}.`);
  }

  return response.text();
}

async function fetchAuthenticatedPageOrNull(url: string | null, cookieHeader: string) {
  if (!url) {
    return null;
  }

  try {
    return await fetchAuthenticatedPage(url, cookieHeader);
  } catch {
    return null;
  }
}

async function fetchAuthenticatedJson<T>(url: string, cookieHeader: string) {
  const response = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "Last Oasis Control Center",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!response.ok) {
    throw new Error(`MyRealm returned ${response.status} while fetching ${url}.`);
  }

  return (await response.json()) as T;
}

async function postAuthenticatedForm(url: string, cookieHeader: string, form: URLSearchParams) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Cookie: cookieHeader,
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Last Oasis Control Center",
      Origin: MYREALM_ORIGIN,
      Referer: url,
    },
    body: form.toString(),
    redirect: "manual",
  });

  if (response.status >= 200 && response.status < 400) {
    return response;
  }

  throw new Error(`MyRealm returned ${response.status} while posting ${url}.`);
}

function extractTileIdFromHtml(html: string) {
  const patterns = [
    /\/Tiles\/(\d+)\/(?:Details|UpdateAutomation|Activate|Deactivate|Delete)/i,
    /data-tile-id="(\d+)"/i,
    /name="TileId"[^>]*value="(\d+)"/i,
    /value="(\d+)"[^>]*name="TileId"/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function maskApiKey(value: string | null) {
  if (!value) {
    return null;
  }

  if (value.length <= 8) {
    return value;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseTileSummary(html: string) {
  const match = html.match(/created\s+(\d+)\s+of the maximum\s+(\d+)\s+tiles/i);
  return {
    activeTiles: match ? Number.parseInt(match[1] ?? "", 10) : null,
    maxTiles: match ? Number.parseInt(match[2] ?? "", 10) : null,
  };
}

function normalizeAdditionalSettings(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function mergeModsIntoAdditionalSettings(current: string | null, modIds: string[]) {
  const nextModsLine = modIds.length ? `Mods=${modIds.join(",")}` : "";
  const nextLines = normalizeAdditionalSettings(current)
    .split("\n")
    .filter(Boolean)
    .filter((line) => !/^mods\s*=/i.test(line));

  if (nextModsLine) {
    nextLines.unshift(nextModsLine);
  }

  return nextLines.join("\n");
}

function mapTileSummary(tile: MyRealmMapIndexTile): MyRealmTileSummary {
  const tileName = cleanText(tile.name) ?? `Tile ${tile.id}`;
  return {
    tileId: tile.id,
    tileName,
    mapName: cleanText(tile.map?.name ?? null),
    statusText: cleanText(tile.statusText ?? null),
    hostingStatusText: cleanText(tile.hostingStatusText ?? null),
    x: typeof tile.x === "number" ? tile.x : null,
    y: typeof tile.y === "number" ? tile.y : null,
    quality: typeof tile.quality === "number" ? tile.quality : null,
    pvpModeText: cleanText(tile.pvpModeText ?? null),
    canActivate: Boolean(tile.canActivate),
    canDeactivate: Boolean(tile.canDeactivate),
    canDelete: Boolean(tile.canDelete),
    canUseAutomation: Boolean(tile.canUseAutomation),
    isActive: Boolean(tile.isActive),
    isInactive: Boolean(tile.isInactive),
    isPendingActive: Boolean(tile.isPendingActive),
    isPendingInactive: Boolean(tile.isPendingInactive),
    playerCount: typeof tile.playerCount === "number" ? tile.playerCount : null,
    activationDate: cleanText(tile.activationDate ?? null),
    deactivationDate: cleanText(tile.deactivationDate ?? null),
  };
}

function formatMyRealmLocalInput(value: Date | null) {
  if (!value) {
    return "";
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatMyRealmUtcInput(value: Date | null) {
  if (!value) {
    return "";
  }

  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function automationValueMatches(actual: string | null, expected: string) {
  const normalizedActual = cleanText(actual);
  const normalizedExpected = cleanText(expected);
  if ((normalizedActual ?? "") === (normalizedExpected ?? "")) {
    return true;
  }

  if (!normalizedActual || !normalizedExpected) {
    return false;
  }

  const actualTimestamp = Date.parse(normalizedActual);
  const expectedTimestamp = Date.parse(normalizedExpected);
  if (!Number.isFinite(actualTimestamp) || !Number.isFinite(expectedTimestamp)) {
    return false;
  }

  return Math.abs(actualTimestamp - expectedTimestamp) < 60_000;
}

async function verifyMyRealmTileAutomationValues(
  updatePageUrl: string,
  cookieHeader: string,
  expectedActivation: string,
  expectedDeactivation: string,
) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const html = await fetchAuthenticatedPage(updatePageUrl, cookieHeader);
    const currentActivation = extractInputValue(html, "ActivationDate");
    const currentDeactivation = extractInputValue(html, "DeactivationDate");

    if (
      automationValueMatches(currentActivation, expectedActivation) &&
      automationValueMatches(currentDeactivation, expectedDeactivation)
    ) {
      return true;
    }

    await wait(500);
  }

  return false;
}

function extractCreateTileMapOptions(html: string) {
  const options: MyRealmCreateTileOption[] = [];
  const pattern = /<div class="form-check">([\s\S]*?)<\/div>/gi;

  for (const match of html.matchAll(pattern)) {
    const block = match[1] ?? "";
    if (!/name="MapId"/i.test(block)) {
      continue;
    }

    const mapId =
      extractFirst(block, /name="MapId"[^>]*value="([^"]+)"/i) ??
      extractFirst(block, /value="([^"]+)"[^>]*name="MapId"/i);
    const rawLabel = cleanText(extractFirst(block, /<label[^>]*class="form-check-label"[^>]*>([\s\S]*?)<\/label>/i));
    if (!mapId || !rawLabel) {
      continue;
    }

    const difficultyMatch = rawLabel.match(/\b(EASY|MEDIUM|HARD)\b/i);
    const difficulty = difficultyMatch ? difficultyMatch[1].toUpperCase() : null;
    const mapName = difficulty ? rawLabel.replace(new RegExp(`\\s*${difficulty}\\s*$`, "i"), "").trim() : rawLabel;
    options.push({
      mapId,
      mapName: mapName || rawLabel,
      difficulty,
    });
  }

  return options;
}

async function fetchCreateTilePage(flow: MyRealmFlowSummary, cookieHeader: string, x: number, y: number) {
  if (!flow.realmId) {
    throw new Error("MyRealm discovery has not found the realm ID yet.");
  }

  const returnUrl = `/realm/${flow.realmId}/map`;
  const pageUrl = `${MYREALM_ORIGIN}/realm/${flow.realmId}/Tiles/Create?x=${x}&y=${y}&returnurl=${encodeURIComponent(returnUrl)}`;
  const html = await fetchAuthenticatedPage(pageUrl, cookieHeader);
  const verificationToken = extractRequestVerificationToken(html);
  const hiddenInputs = extractHiddenInputs(html);
  const actionMatch = html.match(/<form[^>]*action="([^"]*\/Tiles\/Create[^"]*)"[^>]*>/i);
  const actionUrl = absolutizeUrl(actionMatch?.[1] ?? null) ?? `${MYREALM_ORIGIN}/realm/${flow.realmId}/Tiles/Create`;

  return {
    html,
    pageUrl,
    returnUrl,
    verificationToken,
    hiddenInputs,
    actionUrl,
    mapOptions: extractCreateTileMapOptions(html),
  };
}

function coordinateKey(x: number, y: number) {
  return `${x},${y}`;
}

function* createCoordinateSearchOrder(radius: number) {
  for (let currentRadius = 1; currentRadius <= radius; currentRadius += 1) {
    for (let dx = -currentRadius; dx <= currentRadius; dx += 1) {
      for (let dy = -currentRadius; dy <= currentRadius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy)) !== currentRadius) {
          continue;
        }

        yield { dx, dy };
      }
    }
  }
}

async function discoverAvailableCreateTileMaps(
  flow: MyRealmFlowSummary,
  cookieHeader: string,
  tiles: MyRealmTileSummary[],
) {
  const withCoordinates = tiles.filter((tile) => tile.x !== null && tile.y !== null);
  if (!withCoordinates.length) {
    return [] as MyRealmCreateTileOption[];
  }

  const occupied = new Set(withCoordinates.map((tile) => coordinateKey(tile.x!, tile.y!)));
  const seenCandidates = new Set<string>();

  for (const anchor of withCoordinates) {
    for (const offset of createCoordinateSearchOrder(6)) {
      const candidateX = anchor.x! + offset.dx;
      const candidateY = anchor.y! + offset.dy;
      const key = coordinateKey(candidateX, candidateY);
      if (occupied.has(key) || seenCandidates.has(key)) {
        continue;
      }

      seenCandidates.add(key);

      try {
        const form = await fetchCreateTilePage(flow, cookieHeader, candidateX, candidateY);
        if (form.mapOptions.length) {
          return [...new Map(form.mapOptions.map((option) => [option.mapId, option])).values()].sort((left, right) =>
            left.mapName.localeCompare(right.mapName),
          );
        }
      } catch {
        // Keep probing nearby coordinates until MyRealm returns an add-tile form.
      }
    }
  }

  return [] as MyRealmCreateTileOption[];
}

type MyRealmLaunchOptions = {
  allowLaunch?: boolean;
};

async function getMyRealmCookieHeaderForFlow(flow: MyRealmFlowSummary, options?: MyRealmLaunchOptions) {
  const target = await ensureDebugTarget(flow, { allowLaunch: options?.allowLaunch ?? true });

  try {
    return await getMyRealmCookieHeader(target, flow);
  } catch (error) {
    if (
      options?.allowLaunch &&
      error instanceof Error &&
      error.message.includes("No authenticated MyRealm cookie was found")
    ) {
      throw new Error(
        "A dedicated Edge MyRealm window was opened on the map page. Sign into MyRealm there once, and future live-session loads should reuse that dedicated profile automatically.",
      );
    }

    throw error;
  }
}

async function fetchMyRealmTileSummariesWithCookie(flow: MyRealmFlowSummary, cookieHeader: string) {
  if (!flow.realmId) {
    throw new Error("MyRealm discovery has not found the realm ID yet.");
  }

  const mapIndexUrl = `${MYREALM_ORIGIN}/realm/${flow.realmId}/map/indexdata`;
  const mapIndex = await fetchAuthenticatedJson<MyRealmMapIndexResponse>(mapIndexUrl, cookieHeader);
  const tileList = Array.isArray(mapIndex.tileList) ? mapIndex.tileList : [];

  return tileList.map(mapTileSummary).sort((left, right) => left.tileId - right.tileId);
}

export async function loadMyRealmTileSummaries(flow: MyRealmFlowSummary, options?: MyRealmLaunchOptions) {
  const cookieHeader = await getMyRealmCookieHeaderForFlow(flow, options);
  return fetchMyRealmTileSummariesWithCookie(flow, cookieHeader);
}

export async function loadMyRealmCreateTileOptions(flow: MyRealmFlowSummary, x: number, y: number, options?: MyRealmLaunchOptions) {
  const cookieHeader = await getMyRealmCookieHeaderForFlow(flow, options);
  const form = await fetchCreateTilePage(flow, cookieHeader, x, y);
  return form.mapOptions;
}

export async function createMyRealmTile(
  flow: MyRealmFlowSummary,
  options: {
    x: number;
    y: number;
    name: string;
    mapId: string;
    mapName?: string | null;
    pvpMode: MyRealmTilePvpMode;
    quality: number;
  },
  launchOptions?: MyRealmLaunchOptions,
) {
  if (!flow.realmId) {
    throw new Error("MyRealm discovery has not found the realm ID yet.");
  }

  const cookieHeader = await getMyRealmCookieHeaderForFlow(flow, launchOptions);
  const createForm = await fetchCreateTilePage(flow, cookieHeader, options.x, options.y);
  if (!createForm.verificationToken || !createForm.mapOptions.length) {
    throw new Error(`MyRealm did not expose a usable create-tile form for (${options.x}, ${options.y}).`);
  }

  const form = new URLSearchParams();
  for (const [name, value] of createForm.hiddenInputs.entries()) {
    form.set(name, value);
  }

  form.set("ReturnUrl", form.get("ReturnUrl") ?? createForm.returnUrl);
  form.set("X", form.get("X") ?? String(options.x));
  form.set("Y", form.get("Y") ?? String(options.y));
  form.set("Name", options.name);
  form.set("MapId", options.mapId);
  form.set("PvpMode", options.pvpMode);
  form.set("Quality", String(options.quality));
  form.set("__RequestVerificationToken", createForm.verificationToken);

  const response = await postAuthenticatedForm(createForm.actionUrl, cookieHeader, form);
  const responseBody = await response.text();
  const location = absolutizeUrl(response.headers.get("location"));
  const tileIdMatch =
    location?.match(/\/Tiles\/(\d+)\//i) ??
    location?.match(/\/tiles\/(\d+)\//i) ??
    response.url?.match(/\/Tiles\/(\d+)\//i) ??
    response.url?.match(/\/tiles\/(\d+)\//i);
  const tileId =
    (tileIdMatch?.[1] ? Number.parseInt(tileIdMatch[1], 10) : null) ??
    extractTileIdFromHtml(responseBody);

  for (let attempt = 0; attempt < 45; attempt += 1) {
    const tiles = await fetchMyRealmTileSummariesWithCookie(flow, cookieHeader);
    const createdTile =
      (tileId ? tiles.find((tile) => tile.tileId === tileId) : null) ??
      tiles.find((tile) => tile.tileName === options.name && tile.x === options.x && tile.y === options.y) ??
      tiles.find((tile) => tile.tileName === options.name);

    if (createdTile) {
      return createdTile;
    }

    await wait(1_000);
  }

  const creationError = new Error(
    tileId
      ? `MyRealm accepted the create request for ${options.name} (tile ${tileId}), but it never exposed the tile in the map index.`
      : `MyRealm accepted the create request for ${options.name}, but it did not expose the new tile in the map index quickly enough.`,
  ) as Error & { tileId?: number };
  if (tileId) {
    creationError.tileId = tileId;
  }

  throw creationError;
}

export async function updateMyRealmTileAutomation(
  flow: MyRealmFlowSummary,
  tileId: number,
  automation: {
    activationAt: Date | null;
    deactivationAt: Date | null;
  },
  options?: MyRealmLaunchOptions,
) {
  if (!flow.realmId) {
    throw new Error("MyRealm discovery has not found the realm ID yet.");
  }

  const cookieHeader = await getMyRealmCookieHeaderForFlow(flow, options);
  const returnUrl = `/realm/${flow.realmId}/Tiles/${tileId}/Details`;
  const updateUrl = `${MYREALM_ORIGIN}/realm/${flow.realmId}/Tiles/${tileId}/UpdateAutomation`;
  const updatePageUrl = `${updateUrl}?returnurl=${encodeURIComponent(returnUrl)}`;
  let updateHtml = "";
  let verificationToken: string | null = null;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      updateHtml = await fetchAuthenticatedPage(updatePageUrl, cookieHeader);
      verificationToken = extractRequestVerificationToken(updateHtml);
      if (verificationToken) {
        break;
      }
    } catch {
      // MyRealm can lag briefly right after tile creation.
    }

    await wait(750);
  }

  if (!verificationToken) {
    throw new Error(`MyRealm did not expose a request verification token for tile ${tileId} automation.`);
  }

  const hiddenInputs = extractHiddenInputs(updateHtml);
  const buildAutomationForm = (activationValue: string, deactivationValue: string) => {
    const form = new URLSearchParams();
    for (const [name, value] of hiddenInputs.entries()) {
      form.set(name, value);
    }

    form.set("ReturnUrl", form.get("ReturnUrl") ?? returnUrl);
    form.set("ActivationDate", activationValue);
    form.set("DeactivationDate", deactivationValue);
    form.set("__RequestVerificationToken", verificationToken);
    return form;
  };

  const utcActivation = formatMyRealmUtcInput(automation.activationAt);
  const utcDeactivation = formatMyRealmUtcInput(automation.deactivationAt);
  await postAuthenticatedForm(updateUrl, cookieHeader, buildAutomationForm(utcActivation, utcDeactivation));
  if (await verifyMyRealmTileAutomationValues(updatePageUrl, cookieHeader, utcActivation, utcDeactivation)) {
    return;
  }

  const localActivation = formatMyRealmLocalInput(automation.activationAt);
  const localDeactivation = formatMyRealmLocalInput(automation.deactivationAt);
  await postAuthenticatedForm(updateUrl, cookieHeader, buildAutomationForm(localActivation, localDeactivation));
  if (await verifyMyRealmTileAutomationValues(updatePageUrl, cookieHeader, localActivation, localDeactivation)) {
    return;
  }

  throw new Error(`MyRealm did not keep the requested activation/deactivation schedule for tile ${tileId}.`);
}

export async function deleteMyRealmTile(flow: MyRealmFlowSummary, tileId: number, options?: MyRealmLaunchOptions) {
  if (!flow.realmId) {
    throw new Error("MyRealm discovery has not found the realm ID yet.");
  }

  const cookieHeader = await getMyRealmCookieHeaderForFlow(flow, options);
  const returnUrl = `/realm/${flow.realmId}/Map`;
  const deleteUrl = `${MYREALM_ORIGIN}/realm/${flow.realmId}/Tiles/${tileId}/Delete`;
  const deletePageUrl = `${deleteUrl}?returnurl=${encodeURIComponent(returnUrl)}`;
  const deleteHtml = await fetchAuthenticatedPage(deletePageUrl, cookieHeader);
  const verificationToken = extractRequestVerificationToken(deleteHtml);

  if (!verificationToken) {
    throw new Error(`MyRealm did not expose a request verification token for tile ${tileId} deletion.`);
  }

  const form = new URLSearchParams();
  for (const [name, value] of extractHiddenInputs(deleteHtml).entries()) {
    form.set(name, value);
  }

  form.set("ReturnUrl", form.get("ReturnUrl") ?? returnUrl);
  form.set("__RequestVerificationToken", verificationToken);
  await postAuthenticatedForm(deleteUrl, cookieHeader, form);
}

async function submitTileLifecycleAction(flow: MyRealmFlowSummary, tileId: number, action: "activate" | "deactivate", options?: MyRealmLaunchOptions) {
  if (!flow.realmId) {
    throw new Error("MyRealm discovery has not found the realm ID yet.");
  }

  const cookieHeader = await getMyRealmCookieHeaderForFlow(flow, options);
  const actionName = action === "activate" ? "Activate" : "Deactivate";
  const returnUrl = `/realm/${flow.realmId}/Tiles/${tileId}/Details`;
  const actionUrl = `${MYREALM_ORIGIN}/realm/${flow.realmId}/Tiles/${tileId}/${actionName}`;
  const actionPageUrl = `${actionUrl}?returnurl=${encodeURIComponent(returnUrl)}`;
  const actionHtml = await fetchAuthenticatedPage(actionPageUrl, cookieHeader);
  const verificationToken = extractRequestVerificationToken(actionHtml);

  if (!verificationToken) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const tiles = await fetchMyRealmTileSummariesWithCookie(flow, cookieHeader);
      const tile = tiles.find((entry) => entry.tileId === tileId);
      const completed =
        action === "activate"
          ? Boolean(tile && (tile.isActive || tile.isPendingActive))
          : Boolean(tile && (tile.isInactive || tile.isPendingInactive));

      if (completed) {
        return;
      }

      await wait(500);
    }

    throw new Error(`MyRealm did not expose a request verification token for tile ${tileId} ${action}, and the tile state did not change after opening the action page.`);
  }

  const form = new URLSearchParams();
  for (const [name, value] of extractHiddenInputs(actionHtml).entries()) {
    form.set(name, value);
  }

  form.set("ReturnUrl", form.get("ReturnUrl") ?? returnUrl);
  form.set("__RequestVerificationToken", verificationToken);
  await postAuthenticatedForm(actionUrl, cookieHeader, form);
}

export async function activateMyRealmTile(flow: MyRealmFlowSummary, tileId: number, options?: MyRealmLaunchOptions) {
  await submitTileLifecycleAction(flow, tileId, "activate", options);
}

export async function deactivateMyRealmTile(flow: MyRealmFlowSummary, tileId: number, options?: MyRealmLaunchOptions) {
  await submitTileLifecycleAction(flow, tileId, "deactivate", options);
}

export async function loadMyRealmSessionSnapshot(
  flow: MyRealmFlowSummary,
  options?: {
    allowLaunch?: boolean;
  },
): Promise<MyRealmSessionSnapshot> {
  const target = await ensureDebugTarget(flow, { allowLaunch: options?.allowLaunch ?? true });
  const cookieHeader = await getMyRealmCookieHeader(target, flow);
  const targetCustomerId = extractIdFromUrl(target.url, /\/customer\/(\d+)/i);
  const targetRealmId = extractIdFromUrl(target.url, /\/realm\/(\d+)/i);
  const targetDashboardUrl = targetCustomerId ? target.url : null;
  const targetRealmUrl = targetRealmId ? target.url : null;

  let customerId =
    targetCustomerId ??
    flow.customerId ??
    extractIdFromUrl(flow.dashboardUrl, /\/customer\/(\d+)/i) ??
    extractIdFromUrl(flow.apiUrl, /\/customer\/(\d+)/i) ??
    extractIdFromUrl(target.url, /\/customer\/(\d+)/i);
  let realmId =
    targetRealmId ??
    flow.realmId ??
    extractIdFromUrl(flow.realmUrl, /\/realm\/(\d+)/i) ??
    extractIdFromUrl(flow.mapUrl, /\/realm\/(\d+)/i) ??
    extractIdFromUrl(flow.recentTileUrls[0] ?? null, /\/realm\/(\d+)/i) ??
    extractIdFromUrl(target.url, /\/realm\/(\d+)/i);

  const seedDashboardUrl =
    absolutizeUrl(targetDashboardUrl) ??
    absolutizeUrl(flow.dashboardUrl) ??
    absolutizeUrl(flow.apiUrl) ??
    (customerId ? `${MYREALM_ORIGIN}/customer/${customerId}` : null);
  const seedRealmUrl =
    absolutizeUrl(targetRealmUrl) ??
    absolutizeUrl(flow.realmUrl) ??
    absolutizeUrl(flow.mapUrl) ??
    absolutizeUrl(flow.recentTileUrls[0] ?? null) ??
    (realmId ? `${MYREALM_ORIGIN}/realm/${realmId}` : null);
  const seedApiUrl =
    absolutizeUrl(flow.apiUrl) ??
    (customerId ? `${MYREALM_ORIGIN}/customer/${customerId}/Api` : null);

  const [seedDashboardHtml, seedRealmHtml, seedApiHtml] = await Promise.all([
    fetchAuthenticatedPageOrNull(seedDashboardUrl, cookieHeader),
    fetchAuthenticatedPageOrNull(seedRealmUrl, cookieHeader),
    fetchAuthenticatedPageOrNull(seedApiUrl, cookieHeader),
  ]);

  const discoveredCustomerId =
    targetCustomerId ??
    extractCustomerIdFromHtml(seedDashboardHtml) ??
    extractCustomerIdFromHtml(seedRealmHtml) ??
    extractCustomerIdFromHtml(seedApiHtml);
  const discoveredRealmId =
    targetRealmId ??
    extractRealmIdFromHtml(seedDashboardHtml) ??
    extractRealmIdFromHtml(seedRealmHtml) ??
    extractRealmIdFromHtml(seedApiHtml);

  customerId = discoveredCustomerId ?? customerId;
  realmId = discoveredRealmId ?? realmId;

  if (!customerId || !realmId) {
    throw new Error(
      "MyRealm discovery found a recent route, but the signed-in page still did not reveal both the customer ID and realm ID. Open the realm map or dashboard in Edge once, then try Load Live Session again.",
    );
  }

  const resolvedFlow: MyRealmFlowSummary = {
    ...flow,
    customerId,
    realmId,
    dashboardUrl: `${MYREALM_ORIGIN}/customer/${customerId}`,
    realmUrl: `${MYREALM_ORIGIN}/realm/${realmId}`,
    mapUrl: `${MYREALM_ORIGIN}/realm/${realmId}/map`,
    serversUrl: `${MYREALM_ORIGIN}/customer/${customerId}/Servers`,
    providersUrl: `${MYREALM_ORIGIN}/customer/${customerId}/Providers`,
    usersUrl: `${MYREALM_ORIGIN}/customer/${customerId}/users`,
    apiUrl: `${MYREALM_ORIGIN}/customer/${customerId}/Api`,
    recentTileUrls: flow.recentTileUrls.filter((url) => url.includes(`/realm/${realmId}/`)),
  };
  const dashboardUrl = `${MYREALM_ORIGIN}/customer/${customerId}`;
  const realmUrl = `${MYREALM_ORIGIN}/realm/${realmId}`;
  const apiUrl = `${MYREALM_ORIGIN}/customer/${customerId}/Api`;
  const gameplayUrl = `${MYREALM_ORIGIN}/realm/${realmId}/Gameplay`;

  const [customerHtml, realmHtml, apiHtml, gameplayHtml] = await Promise.all([
    seedDashboardHtml && dashboardUrl === seedDashboardUrl ? Promise.resolve(seedDashboardHtml) : fetchAuthenticatedPage(dashboardUrl, cookieHeader),
    seedRealmHtml && realmUrl === seedRealmUrl ? Promise.resolve(seedRealmHtml) : fetchAuthenticatedPage(realmUrl, cookieHeader),
    seedApiHtml && apiUrl === seedApiUrl ? Promise.resolve(seedApiHtml) : fetchAuthenticatedPage(apiUrl, cookieHeader),
    fetchAuthenticatedPage(gameplayUrl, cookieHeader),
  ]);

  const { activeTiles, maxTiles } = parseTileSummary(realmHtml);
  const apiKey = extractFirst(apiHtml, /id="ApiKey"[^>]*value="([^"]*)"/i);
  const tiles = await fetchMyRealmTileSummariesWithCookie(resolvedFlow, cookieHeader).catch(() => [] as MyRealmTileSummary[]);
  const availableCreateTileMaps = await discoverAvailableCreateTileMaps(resolvedFlow, cookieHeader, tiles).catch(
    () => [] as MyRealmCreateTileOption[],
  );
  const activeTileNames =
      collectActiveTileNames(realmHtml).length
        ? collectActiveTileNames(realmHtml)
        : tiles
            .filter(isCurrentlyCreatedMyRealmTile)
            .map((tile) => tile.tileName)
            .slice(0, 12);

  return {
    browser: resolvedFlow.browser,
    connectedAt: new Date().toISOString(),
    customerId,
    customerName:
      extractFirst(customerHtml, new RegExp(`href="/customer/${escapeRegExp(customerId)}"[^>]*>([\\s\\S]*?)<`, "i")) ??
      extractFirst(realmHtml, new RegExp(`href="/customer/${escapeRegExp(customerId)}"[^>]*>([\\s\\S]*?)<`, "i")),
    realmId,
    realmName:
      extractFirst(realmHtml, new RegExp(`href="/realm/${escapeRegExp(realmId)}"[^>]*>([\\s\\S]*?)<`, "i")) ??
      extractFirst(realmHtml, /<title>([\s\S]*?)<\/title>/i),
    apiKeyPreview: maskApiKey(apiKey),
    activePlayers: extractActivePlayers(realmHtml),
    activeTiles,
    maxTiles,
    activeTileNames,
    tiles,
    availableCreateTileMaps,
    hostingMode: extractTableValue(realmHtml, "Mode"),
    activationMode: extractTableValue(realmHtml, "Activation"),
    experienceMultiplier: extractTableValue(gameplayHtml, "Experience"),
    foliageRespawnMultiplier: extractTableValue(gameplayHtml, "Foliage Respawn"),
    harvestQuantityMultiplier: extractTableValue(gameplayHtml, "Harvest Quantity"),
    maxClanSize: extractTableValue(gameplayHtml, "Max size"),
    clanSwitchCooldown: extractTableValue(gameplayHtml, "Switch cooldown"),
    travelMode: extractTableValue(gameplayHtml, "Mode"),
    additionalSettings: extractFirst(gameplayHtml, /font-monospace"[^>]*>([\s\S]*?)<\/div>/i),
    links: {
      dashboardUrl,
      realmUrl,
      apiUrl,
      gameplayUrl,
      mapUrl: resolvedFlow.mapUrl,
      charactersUrl: extractLink(realmHtml, /href="(\/realm\/\d+\/Characters)"/i),
      hostingUrl: extractLink(realmHtml, /href="(\/realm\/\d+\/Hosting\/UpdateMode)"/i),
      generateApiKeyUrl: extractLink(apiHtml, /href="(\/customer\/\d+\/Api\/GenerateKey)"/i),
      updateMultipliersUrl: extractLink(gameplayHtml, /href="(\/realm\/\d+\/Gameplay\/UpdateMultipliers)"/i),
      updateMaxClanSizeUrl: extractLink(gameplayHtml, /href="(\/realm\/\d+\/Gameplay\/UpdateMaxClanSize)"/i),
      updateClanSwitchCooldownUrl: extractLink(gameplayHtml, /href="(\/realm\/\d+\/Gameplay\/UpdateClanSwitchCooldown)"/i),
      updateTravelModeUrl: extractLink(gameplayHtml, /href="(\/realm\/\d+\/Gameplay\/UpdateTravelMode)"/i),
      updateAdditionalSettingsUrl: extractLink(gameplayHtml, /href="(\/realm\/\d+\/Gameplay\/UpdateAdditionalSettings)"/i),
    },
    note: "Live MyRealm pages were fetched through the local Edge session. The control center does not store the session cookie and only keeps this parsed snapshot in memory.",
  };
}

export function getMyRealmSessionCachePath() {
  return MYREALM_SESSION_CACHE_PATH;
}

export async function loadSavedMyRealmSessionSnapshot() {
  try {
    const raw = await fs.readFile(MYREALM_SESSION_CACHE_PATH, "utf8");
    if (!raw.trim()) {
      return null;
    }

    return JSON.parse(raw) as MyRealmSessionSnapshot;
  } catch {
    return null;
  }
}

export async function saveMyRealmSessionSnapshot(snapshot: MyRealmSessionSnapshot) {
  await fs.mkdir(path.dirname(MYREALM_SESSION_CACHE_PATH), { recursive: true });
  await fs.writeFile(MYREALM_SESSION_CACHE_PATH, JSON.stringify(snapshot, null, 2), "utf8");
}

export async function syncMyRealmTileMods(flow: MyRealmFlowSummary, modIds: string[]): Promise<MyRealmTileModsSyncResult> {
  if (!flow.realmId) {
    throw new Error("MyRealm discovery has not found the realm ID yet.");
  }

  const normalizedModIds = [...new Set(modIds.map((modId) => modId.trim()).filter(Boolean))];
  const cookieHeader = await getMyRealmCookieHeaderForFlow(flow);
  const realmId = flow.realmId;
  const mapIndexUrl = `${MYREALM_ORIGIN}/realm/${realmId}/map/indexdata`;
  const mapIndex = await fetchAuthenticatedJson<MyRealmMapIndexResponse>(mapIndexUrl, cookieHeader);

  if (!Array.isArray(mapIndex.tileList) || !mapIndex.tileList.length) {
    throw new Error("MyRealm did not return any tiles for this realm.");
  }

  const updatedTiles: MyRealmTileModsSyncResult["updatedTiles"] = [];
  const unchangedTiles: MyRealmTileModsSyncResult["unchangedTiles"] = [];

  for (const tile of mapIndex.tileList) {
    const updateUrl = `${MYREALM_ORIGIN}/realm/${realmId}/Tiles/${tile.id}/UpdateAdditionalSettings`;
    const updatePageUrl = `${updateUrl}?returnurl=${encodeURIComponent(`/realm/${realmId}/Tiles/${tile.id}/Details`)}`;
    const updateHtml = await fetchAuthenticatedPage(updatePageUrl, cookieHeader);
    const verificationToken = extractRequestVerificationToken(updateHtml);

    if (!verificationToken) {
      throw new Error(`MyRealm did not expose a request verification token for tile ${tile.name}.`);
    }

    const previousAdditionalSettings = extractTextareaValue(updateHtml, "AdditionalSettings");
    const returnUrl = extractInputValue(updateHtml, "ReturnUrl") ?? `/realm/${realmId}/Tiles/${tile.id}/Details`;
    const nextAdditionalSettings = mergeModsIntoAdditionalSettings(previousAdditionalSettings, normalizedModIds);
    const entry = {
      tileId: tile.id,
      tileName: cleanText(tile.name) ?? `Tile ${tile.id}`,
      mapName: cleanText(tile.map?.name ?? null),
      statusText: cleanText(tile.statusText ?? null),
      previousAdditionalSettings: normalizeAdditionalSettings(previousAdditionalSettings) || null,
      nextAdditionalSettings,
    };

    if (normalizeAdditionalSettings(previousAdditionalSettings) === normalizeAdditionalSettings(nextAdditionalSettings)) {
      unchangedTiles.push(entry);
      continue;
    }

    const form = new URLSearchParams();
    form.set("ReturnUrl", returnUrl);
    form.set("AdditionalSettings", nextAdditionalSettings);
    form.set("__RequestVerificationToken", verificationToken);

    await postAuthenticatedForm(updateUrl, cookieHeader, form);
    updatedTiles.push(entry);
  }

  return {
    realmId,
    desiredModsSetting: normalizedModIds.length ? `Mods=${normalizedModIds.join(",")}` : "",
    syncedModIds: normalizedModIds,
    updatedTiles,
    unchangedTiles,
  };
}
