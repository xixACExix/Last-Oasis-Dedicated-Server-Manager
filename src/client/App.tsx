import { useCallback, useEffect, useMemo, useState } from "react";
import type { DashboardState, GameBridgeChatEntry, LiveServerSummary } from "../shared/types";

type RemoteAccessInfo = {
  authRequired: boolean;
  remotePasswordRequired: boolean;
  localBypass: boolean;
  sessionMinutes: number;
  passwordSource: "environment" | "profile-json";
  passwordFilePath: string | null;
  passwordEnvName: string;
};

type RemoteTab = "overview" | "updates" | "messages" | "remote";
type BridgeTargetOption = {
  label: string;
  scope: "global" | "tile";
  identifier?: string;
  tileName?: string;
};

type ApiError = Error & {
  status?: number;
};

const REMOTE_TOKEN_KEY = "lo-manager-remote-token";

const remoteTabs: Array<{ id: RemoteTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "updates", label: "Updates / Mods" },
  { id: "messages", label: "Messages" },
  { id: "remote", label: "Remote Access" },
];

function readRemoteToken() {
  try {
    return window.localStorage.getItem(REMOTE_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveRemoteToken(token: string) {
  try {
    if (token) {
      window.localStorage.setItem(REMOTE_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(REMOTE_TOKEN_KEY);
    }
  } catch {
    // Local storage can be blocked in some embedded browsers.
  }
}

async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const token = readRemoteToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });
  const rawText = await response.text();
  const body = rawText.trim()
    ? (() => {
        try {
          return JSON.parse(rawText) as T & { error?: string };
        } catch {
          return null;
        }
      })()
    : null;

  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed with status ${response.status}`) as ApiError;
    error.status = response.status;
    throw error;
  }

  if (!body) {
    return {} as T;
  }

  return body as T;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    if (error.message === "Failed to fetch") {
      return "The Last Oasis Manager backend is not reachable.";
    }
    return error.message;
  }

  return fallback;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Not scheduled";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFullDateTime(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function formatPhase(value: string | null | undefined) {
  if (!value) {
    return "offline";
  }

  if (value === "warming") {
    return "running";
  }

  return value.replace(/-/g, " ");
}

function summarizeHostNames(names: string[]) {
  if (!names.length) {
    return "No hosts";
  }

  if (names.length <= 3) {
    return names.join(", ");
  }

  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

function buildBridgeTargetOptions(servers: LiveServerSummary[]): BridgeTargetOption[] {
  const options: BridgeTargetOption[] = [{ label: "All servers", scope: "global" }];
  for (const server of servers) {
    const identifier = server.identifier?.trim();
    if (!identifier) {
      continue;
    }

    const tileName = server.map?.trim() || "Not hosting yet";
    options.push({
      label: `${tileName} (${identifier})`,
      scope: "tile",
      identifier,
      tileName,
    });
  }

  return options;
}

function formatChatLine(entry: GameBridgeChatEntry) {
  const location = entry.tileName || entry.mapName || "Unknown tile";
  const player = entry.playerName || "Unknown";
  return `${location} - ${player}: ${entry.message}`;
}

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessInfo | null>(null);
  const [activeTab, setActiveTab] = useState<RemoteTab>("overview");
  const [chatEntries, setChatEntries] = useState<GameBridgeChatEntry[]>([]);
  const [password, setPassword] = useState("");
  const [adminMessage, setAdminMessage] = useState("");
  const [adminTargetKey, setAdminTargetKey] = useState("global");
  const [adminWithWidget, setAdminWithWidget] = useState(true);
  const [safeStopReason, setSafeStopReason] = useState("Admin maintenance");
  const [busyAction, setBusyAction] = useState("");
  const [loginRequired, setLoginRequired] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const loadRemoteAccess = useCallback(async () => {
    try {
      const response = await fetch("/api/remote/access", {
        headers: {
          Accept: "application/json",
        },
      });
      const info = (await response.json()) as RemoteAccessInfo;
      setRemoteAccess(info);
      setLoginRequired(info.remotePasswordRequired && !readRemoteToken());
    } catch (remoteError) {
      setError(getErrorMessage(remoteError, "Failed to load remote access settings."));
    }
  }, []);

  const refreshDashboard = useCallback(async () => {
    try {
      const nextDashboard = await apiFetch<DashboardState>("/api/state");
      setDashboard(nextDashboard);
      setLoginRequired(false);
      setError("");
    } catch (refreshError) {
      const apiError = refreshError as ApiError;
      if (apiError.status === 401) {
        saveRemoteToken("");
        setLoginRequired(true);
        setDashboard(null);
        setError("");
        return;
      }

      setError(getErrorMessage(refreshError, "Failed to load manager state."));
    }
  }, []);

  const refreshChat = useCallback(async () => {
    try {
      const result = await apiFetch<{ entries: GameBridgeChatEntry[] }>("/api/message-bridge/chat?limit=120");
      setChatEntries(result.entries);
    } catch (chatError) {
      const apiError = chatError as ApiError;
      if (apiError.status === 401) {
        saveRemoteToken("");
        setLoginRequired(true);
        return;
      }

      setError(getErrorMessage(chatError, "Failed to load server chat."));
    }
  }, []);

  useEffect(() => {
    void loadRemoteAccess();
    void refreshDashboard();
    const interval = window.setInterval(() => {
      void refreshDashboard();
    }, 30000);

    return () => window.clearInterval(interval);
  }, [loadRemoteAccess, refreshDashboard]);

  useEffect(() => {
    if (activeTab !== "messages" || loginRequired) {
      return;
    }

    void refreshChat();
    const interval = window.setInterval(() => {
      void refreshChat();
    }, 10000);

    return () => window.clearInterval(interval);
  }, [activeTab, loginRequired, refreshChat]);

  const profiles = dashboard?.config.profiles ?? [];
  const selectedProfile =
    profiles.find((profile) => profile.id === dashboard?.config.selectedProfileId) ?? profiles[0] ?? null;
  const runningServers = (dashboard?.liveServers ?? []).filter((server) => server.status !== "offline" || server.processId);
  const hostingServers = runningServers.filter((server) => Boolean(server.map));
  const playersOnline =
    dashboard?.myRealmSession?.activePlayers ??
    runningServers.reduce((total, server) => total + (server.playerCount || 0), 0);
  const pendingMods = (dashboard?.mods ?? []).filter((mod) => mod.updateAvailable);
  const configuredMods = dashboard?.config.operationsSettings.modIds ?? [];
  const updateAutomation = dashboard?.config.operationsSettings;
  const scheduler = dashboard?.schedulerStatus ?? null;
  const launchStatus = dashboard?.launchStatus ?? null;
  const hostNames = profiles.map((profile) => profile.name);
  const bridgeTargets = useMemo(() => buildBridgeTargetOptions(dashboard?.liveServers ?? []), [dashboard?.liveServers]);
  const selectedBridgeTarget =
    bridgeTargets.find((target) => (target.scope === "global" ? "global" : target.identifier) === adminTargetKey) ??
    bridgeTargets[0];

  useEffect(() => {
    if (!bridgeTargets.some((target) => (target.scope === "global" ? "global" : target.identifier) === adminTargetKey)) {
      setAdminTargetKey("global");
    }
  }, [adminTargetKey, bridgeTargets]);

  const statusCards = useMemo(
    () => [
      { label: "Launch phase", value: formatPhase(launchStatus?.phase), detail: launchStatus?.summary ?? "Waiting for backend state" },
      { label: "Running hosts", value: String(runningServers.length), detail: `${hostingServers.length} currently hosting a tile` },
      { label: "Players", value: String(playersOnline ?? 0), detail: dashboard?.myRealmSession?.realmName ?? "Live query / MyRealm snapshot" },
      { label: "Next restart", value: formatDateTime(scheduler?.nextRestartAt), detail: scheduler?.pendingReason ?? scheduler?.restartScheduleLabel ?? "No queued restart" },
    ],
    [dashboard?.myRealmSession?.realmName, hostingServers.length, launchStatus, playersOnline, runningServers.length, scheduler],
  );

  async function login() {
    if (busyAction || !password.trim()) {
      return;
    }

    setBusyAction("login");
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/remote/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      const rawBody = await response.text();
      const body = rawBody.trim() ? (JSON.parse(rawBody) as { token?: string; expiresAt?: string; error?: string }) : {};
      if (!response.ok || !body.token) {
        throw new Error(body.error ?? "Remote login failed.");
      }

      saveRemoteToken(body.token);
      setPassword("");
      setLoginRequired(false);
      setNotice(`Remote login accepted. Session expires ${formatFullDateTime(body.expiresAt)}.`);
      await refreshDashboard();
    } catch (loginError) {
      setError(getErrorMessage(loginError, "Remote login failed."));
    } finally {
      setBusyAction("");
    }
  }

  async function runAction(action: string, successMessage: string, callback: () => Promise<void>) {
    if (busyAction) {
      return;
    }

    setBusyAction(action);
    setNotice("");
    setError("");
    try {
      await callback();
      setNotice(successMessage);
      await refreshDashboard();
    } catch (actionError) {
      const apiError = actionError as ApiError;
      if (apiError.status === 401) {
        saveRemoteToken("");
        setLoginRequired(true);
      }
      setError(getErrorMessage(actionError, "Action failed."));
    } finally {
      setBusyAction("");
    }
  }

  async function startAllHosts() {
    await runAction("start-all", "Start-all request was queued.", async () => {
      await apiFetch<{ accepted: boolean }>("/api/server/start-all", {
        method: "POST",
      });
    });
  }

  async function scheduleSafeStop() {
    await runAction("safe-stop", "Safe stop was scheduled.", async () => {
      await apiFetch<{ ok: boolean }>("/api/server/safe-stop", {
        method: "POST",
        body: JSON.stringify({ reason: safeStopReason.trim() || "Admin maintenance" }),
      });
    });
  }

  async function stopAllNow() {
    const confirmed = window.confirm("Stop all Last Oasis server hosts now?");
    if (!confirmed) {
      return;
    }

    await runAction("stop-all", "Stop request was sent.", async () => {
      await apiFetch<{ ok: boolean }>("/api/server/stop", {
        method: "POST",
        body: JSON.stringify({ force: false }),
      });
    });
  }

  async function checkServerUpdate() {
    await runAction("check-server-update", "Server update check finished.", async () => {
      await apiFetch<{ result: unknown }>("/api/maintenance/check-game-update", {
        method: "POST",
      });
    });
  }

  async function updateServer() {
    await runAction("server-update", "Server update request was sent.", async () => {
      await apiFetch<{ result: unknown }>("/api/maintenance/update-game", {
        method: "POST",
      });
    });
  }

  async function updateMods() {
    await runAction("mod-update", "Shared mod update request was sent.", async () => {
      await apiFetch<{ result: unknown }>("/api/mods/update", {
        method: "POST",
      });
    });
  }

  async function sendAdminMessage() {
    if (!adminMessage.trim()) {
      setError("Write an admin message first.");
      return;
    }

    await runAction("admin-message", "Admin message was queued for the in-game bridge.", async () => {
      await apiFetch<{ message: unknown }>("/api/message-bridge/admin-message", {
        method: "POST",
        body: JSON.stringify({
          message: adminMessage.trim(),
          durationSeconds: 12,
          targetScope: selectedBridgeTarget.scope,
          targetIdentifier: selectedBridgeTarget.identifier,
          targetLabel: selectedBridgeTarget.tileName ?? selectedBridgeTarget.label,
          withWidget: adminWithWidget,
        }),
      });
      setAdminMessage("");
    });
  }

  function logout() {
    saveRemoteToken("");
    setDashboard(null);
    setLoginRequired(true);
    setNotice("Remote session cleared.");
  }

  return (
    <div className="manager-page">
      <header className="manager-hero">
        <div>
          <p className="manager-eyebrow">Remote Control</p>
          <h1>Last Oasis Server Manager</h1>
          <p>Dedicated server controls for realm hosts, updates, restarts, in-game admin messages, and server chat.</p>
        </div>
        <div className="manager-hero-status">
          <strong>{dashboard ? "Backend: online" : loginRequired ? "Login required" : "Backend: checking"}</strong>
          <span>Selected host: {selectedProfile?.name ?? "None"}</span>
          <span>Launch phase: {formatPhase(launchStatus?.phase)}</span>
        </div>
      </header>

      <main className="manager-layout">
        <aside className="manager-sidebar">
          <section className="manager-side-card">
            <h2>Realm Hosts</h2>
            <p>{profiles.length ? `${profiles.length} configured host profiles` : "Waiting for manager state"}</p>
            <div className="host-list">
              {profiles.length ? (
                profiles.map((profile) => (
                  <div key={profile.id} className={`host-row ${profile.id === selectedProfile?.id ? "host-row-active" : ""}`}>
                    <span>{profile.name}</span>
                    <small>{profile.launch.identifier}</small>
                  </div>
                ))
              ) : (
                <div className="host-row">
                  <span>No profiles loaded</span>
                  <small>Connect to the backend first</small>
                </div>
              )}
            </div>
          </section>

          <section className="manager-side-card">
            <h3>Snapshot</h3>
            <dl className="compact-facts">
              <div>
                <dt>Running</dt>
                <dd>{runningServers.length}</dd>
              </div>
              <div>
                <dt>Hosting</dt>
                <dd>{hostingServers.length}</dd>
              </div>
              <div>
                <dt>Mods</dt>
                <dd>{configuredMods.length}</dd>
              </div>
              <div>
                <dt>Pending updates</dt>
                <dd>{pendingMods.length}</dd>
              </div>
            </dl>
          </section>
        </aside>

        <section className="manager-workspace">
          <nav className="manager-tabs" aria-label="Remote manager sections">
            {remoteTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={tab.id === activeTab ? "manager-tab manager-tab-active" : "manager-tab"}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {(notice || error) && <div className={error ? "manager-banner manager-banner-error" : "manager-banner"}>{error || notice}</div>}

          {loginRequired ? (
            <section className="manager-panel login-panel">
              <div>
                <p className="manager-eyebrow">Password Required</p>
                <h2>Log in to remote control</h2>
                <p>
                  Enter the remote password from the dedicated server. By default it is stored in the active
                  <strong> LO_Profiles</strong> folder as <strong>remote-access.json</strong>.
                </p>
                {remoteAccess?.passwordFilePath && <p className="muted">Local password file: {remoteAccess.passwordFilePath}</p>}
              </div>
              <div className="login-form">
                <input
                  type="password"
                  value={password}
                  placeholder="Remote password"
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void login();
                    }
                  }}
                />
                <button type="button" className="manager-button manager-button-primary" onClick={() => void login()} disabled={busyAction === "login"}>
                  {busyAction === "login" ? "Logging in..." : "Log in"}
                </button>
              </div>
            </section>
          ) : (
            <>
              {activeTab === "overview" && (
                <section className="manager-panel">
                  <div className="stat-grid">
                    {statusCards.map((card) => (
                      <article key={card.label} className="stat-card">
                        <span>{card.label}</span>
                        <strong>{card.value}</strong>
                        <small>{card.detail}</small>
                      </article>
                    ))}
                  </div>

                  <div className="manager-columns">
                    <section className="manager-box">
                      <p className="manager-eyebrow">Server Actions</p>
                      <h2>Quick controls</h2>
                      <div className="button-grid">
                        <button type="button" className="manager-button manager-button-primary" onClick={() => void startAllHosts()} disabled={Boolean(busyAction) || !profiles.length}>
                          {busyAction === "start-all" ? "Starting..." : "Start All Hosts"}
                        </button>
                        <button type="button" className="manager-button" onClick={() => void scheduleSafeStop()} disabled={Boolean(busyAction) || !runningServers.length}>
                          {busyAction === "safe-stop" ? "Scheduling..." : "Schedule Safe Stop"}
                        </button>
                        <button type="button" className="manager-button manager-button-danger" onClick={() => void stopAllNow()} disabled={Boolean(busyAction) || !runningServers.length}>
                          {busyAction === "stop-all" ? "Stopping..." : "Stop All Now"}
                        </button>
                      </div>
                      <label className="field-label" htmlFor="safe-stop-reason">
                        Safe stop message
                      </label>
                      <input
                        id="safe-stop-reason"
                        value={safeStopReason}
                        onChange={(event) => setSafeStopReason(event.target.value)}
                        placeholder="Reason shown in Discord / in game"
                      />
                    </section>

                    <section className="manager-box">
                      <p className="manager-eyebrow">Maintenance</p>
                      <h2>Queue</h2>
                      <dl className="detail-list">
                        <div>
                          <dt>Action</dt>
                          <dd>{scheduler?.pendingAction ?? "None"}</dd>
                        </div>
                        <div>
                          <dt>Source</dt>
                          <dd>{scheduler?.pendingSource ?? "None"}</dd>
                        </div>
                        <div>
                          <dt>Target</dt>
                          <dd>{scheduler?.pendingTargetSummary ?? summarizeHostNames(hostNames)}</dd>
                        </div>
                        <div>
                          <dt>Next</dt>
                          <dd>{formatDateTime(scheduler?.nextRestartAt)}</dd>
                        </div>
                      </dl>
                    </section>
                  </div>

                  <section className="manager-box">
                    <p className="manager-eyebrow">Live Servers</p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Host</th>
                            <th>Map</th>
                            <th>Status</th>
                            <th>Players</th>
                            <th>PID</th>
                          </tr>
                        </thead>
                        <tbody>
                          {runningServers.length ? (
                            runningServers.map((server) => (
                              <tr key={`${server.identifier ?? "server"}-${server.processId ?? server.gamePort ?? "none"}`}>
                                <td>{server.identifier ?? "Unknown host"}</td>
                                <td>{server.map ?? "Not hosting yet"}</td>
                                <td>{server.status}</td>
                                <td>{server.playerCount}</td>
                                <td>{server.processId ?? "n/a"}</td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={5}>No running Last Oasis hosts are reported by the manager.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </section>
              )}

              {activeTab === "updates" && (
                <section className="manager-panel">
                  <div className="manager-columns">
                    <section className="manager-box">
                      <p className="manager-eyebrow">Dedicated Server</p>
                      <h2>Server update</h2>
                      <p className="muted">
                        Server updates use the configured manager install path and the shared restart plan for all configured running hosts.
                      </p>
                      <div className="button-grid">
                        <button type="button" className="manager-button" onClick={() => void checkServerUpdate()} disabled={Boolean(busyAction)}>
                          {busyAction === "check-server-update" ? "Checking..." : "Check Server Update"}
                        </button>
                        <button type="button" className="manager-button manager-button-primary" onClick={() => void updateServer()} disabled={Boolean(busyAction)}>
                          {busyAction === "server-update" ? "Updating..." : "Apply Server Update"}
                        </button>
                      </div>
                    </section>

                    <section className="manager-box">
                      <p className="manager-eyebrow">Workshop</p>
                      <h2>Shared mod updates</h2>
                      <p className="muted">
                        Mod updates are based on the mod IDs configured in the manager, not every workshop folder SteamCMD has ever downloaded.
                      </p>
                      <button type="button" className="manager-button manager-button-primary" onClick={() => void updateMods()} disabled={Boolean(busyAction) || !configuredMods.length}>
                        {busyAction === "mod-update" ? "Updating..." : "Apply Shared Mod Updates"}
                      </button>
                    </section>
                  </div>

                  <section className="manager-box">
                    <p className="manager-eyebrow">Update Status</p>
                    <dl className="detail-list">
                      <div>
                        <dt>Configured mods</dt>
                        <dd>{configuredMods.length ? configuredMods.join(", ") : "None"}</dd>
                      </div>
                      <div>
                        <dt>Pending mod updates</dt>
                        <dd>{pendingMods.length ? pendingMods.map((mod) => mod.title || mod.modId).join(", ") : "None detected"}</dd>
                      </div>
                      <div>
                        <dt>Auto mod updates</dt>
                        <dd>{updateAutomation?.autoUpdateMods ? "Enabled" : "Disabled"}</dd>
                      </div>
                      <div>
                        <dt>Auto server updates</dt>
                        <dd>{updateAutomation?.autoUpdateGameServer ? "Enabled" : "Disabled"}</dd>
                      </div>
                    </dl>
                  </section>
                </section>
              )}

              {activeTab === "messages" && (
                <section className="manager-panel">
                  <div className="manager-columns">
                    <section className="manager-box">
                      <p className="manager-eyebrow">Game Bridge</p>
                      <h2>Send admin message</h2>
                      <textarea
                        value={adminMessage}
                        onChange={(event) => setAdminMessage(event.target.value)}
                        placeholder="Admin message to broadcast in game"
                        rows={5}
                      />
                      <label className="field-label" htmlFor="admin-message-target">
                        Target
                      </label>
                      <select
                        id="admin-message-target"
                        value={adminTargetKey}
                        onChange={(event) => setAdminTargetKey(event.target.value)}
                      >
                        {bridgeTargets.map((target) => {
                          const value = target.scope === "global" ? "global" : target.identifier ?? "global";
                          return (
                            <option key={value} value={value}>
                              {target.label}
                            </option>
                          );
                        })}
                      </select>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={adminWithWidget}
                          onChange={(event) => setAdminWithWidget(event.target.checked)}
                        />
                        Use widget path
                      </label>
                      <button type="button" className="manager-button manager-button-primary" onClick={() => void sendAdminMessage()} disabled={Boolean(busyAction)}>
                        {busyAction === "admin-message" ? "Queueing..." : "Send Admin Message"}
                      </button>
                    </section>

                    <section className="manager-box">
                      <p className="manager-eyebrow">Server Chat</p>
                      <div className="box-header-row">
                        <h2>Recent messages</h2>
                        <button type="button" className="manager-button manager-button-small" onClick={() => void refreshChat()} disabled={Boolean(busyAction)}>
                          Refresh
                        </button>
                      </div>
                      <div className="chat-list">
                        {chatEntries.length ? (
                          chatEntries.map((entry) => (
                            <article key={entry.id} className="chat-entry">
                              <strong>{formatChatLine(entry)}</strong>
                              <small>{formatFullDateTime(entry.createdAt)}</small>
                            </article>
                          ))
                        ) : (
                          <p className="muted">No captured server chat has been reported yet.</p>
                        )}
                      </div>
                    </section>
                  </div>
                </section>
              )}

              {activeTab === "remote" && (
                <section className="manager-panel">
                  <div className="manager-columns">
                    <section className="manager-box">
                      <p className="manager-eyebrow">Security</p>
                      <h2>Remote login</h2>
                      <dl className="detail-list">
                        <div>
                          <dt>Password source</dt>
                          <dd>{remoteAccess?.passwordSource === "environment" ? remoteAccess.passwordEnvName : "LO_Profiles remote-access.json"}</dd>
                        </div>
                        <div>
                          <dt>Session length</dt>
                          <dd>{remoteAccess?.sessionMinutes ?? 720} minutes</dd>
                        </div>
                        <div>
                          <dt>Local desktop bypass</dt>
                          <dd>{remoteAccess?.localBypass ? "Active for this browser" : "Only localhost bypasses login"}</dd>
                        </div>
                      </dl>
                      <button type="button" className="manager-button" onClick={logout}>
                        Clear Remote Session
                      </button>
                    </section>

                    <section className="manager-box">
                      <p className="manager-eyebrow">Phone Access</p>
                      <h2>How to open it</h2>
                      <p className="muted">
                        From the same network, open <strong>http://SERVER-IP:4020</strong> on your phone and log in with the remote password.
                        The backend must already be running for the phone page to load. Enable the backend startup watchdog in the desktop manager
                        so it starts at Windows login and restarts after crashes. If you manually disconnect the backend, start it again from the
                        desktop manager.
                      </p>
                    </section>
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
