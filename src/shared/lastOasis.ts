import type { LastOasisLaunchSettings } from "./types.js";

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function buildLastOasisArguments(settings: LastOasisLaunchSettings) {
  const parts: string[] = [];

  if (Number.isFinite(settings.steamDedicatedServerAppId) && settings.steamDedicatedServerAppId !== null) {
    parts.push(`-SteamDedicatedServerAppId=${settings.steamDedicatedServerAppId}`);
  }

  if (settings.enableLogs) {
    parts.push("-log");
  }

  if (settings.forceSteamClientLink) {
    parts.push("-force_steamclient_link");
  }

  if (settings.messaging) {
    parts.push("-messaging");
  }

  if (settings.noLiveServer) {
    parts.push("-NoLiveServer");
  }

  if (settings.enableCheats) {
    parts.push("-EnableCheats");
  }

  if (settings.backendApiUrl.trim()) {
    parts.push(`-backendapiurloverride="${settings.backendApiUrl.trim()}"`);
  }

  if (settings.identifier.trim()) {
    parts.push(`-identifier=${settings.identifier.trim()}`);
  }

  if (Number.isFinite(settings.port)) {
    parts.push(`-port=${settings.port}`);
  }

  if (settings.customerKey.trim()) {
    parts.push(`-CustomerKey=${settings.customerKey.trim()}`);
  }

  if (settings.providerKey.trim()) {
    parts.push(`-ProviderKey=${settings.providerKey.trim()}`);
  }

  if (Number.isFinite(settings.slots)) {
    parts.push(`-slots=${settings.slots}`);
  }

  if (settings.queryPort) {
    parts.push(`-QueryPort=${settings.queryPort}`);
  }

  if (settings.overrideConnectionAddress.trim()) {
    parts.push(`-OverrideConnectionAddress=${settings.overrideConnectionAddress.trim()}`);
  }

  if (settings.extraArgs.trim()) {
    parts.push(settings.extraArgs.trim());
  }

  return parts.join(" ");
}

export function validateLastOasisSettings(settings: LastOasisLaunchSettings) {
  const issues: string[] = [];

  if (!normalizeWhitespace(settings.identifier)) {
    issues.push("Identifier is required.");
  }

  if (!normalizeWhitespace(settings.customerKey)) {
    issues.push("Customer key is required.");
  }

  if (!normalizeWhitespace(settings.providerKey)) {
    issues.push("Provider key is required.");
  }

  if (!normalizeWhitespace(settings.overrideConnectionAddress)) {
    issues.push("External IP or DNS value is required for OverrideConnectionAddress.");
  }

  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    issues.push("Game port must be between 1 and 65535.");
  }

  if (settings.queryPort !== null && (!Number.isInteger(settings.queryPort) || settings.queryPort < 1 || settings.queryPort > 65535)) {
    issues.push("Query port must be null or between 1 and 65535.");
  }

  if (!Number.isInteger(settings.slots) || settings.slots < 1 || settings.slots > 100) {
    issues.push("Slots must be between 1 and 100.");
  }

  return issues;
}
