import type {
  AppConfig,
  EventTileCleanupBatch,
  EventTileCycleResult,
  EventTileCycleState,
  EventTileDryRunResult,
  MyRealmCreateTileOption,
  MyRealmFlowSummary,
  MyRealmTileSummary,
} from "../shared/types.js";
import {
  activateMyRealmTile,
  createMyRealmTile,
  deactivateMyRealmTile,
  deleteMyRealmTile,
  loadMyRealmCreateTileOptions,
  loadMyRealmTileSummaries,
  updateMyRealmTileAutomation,
} from "./myRealmSession.js";

type EventTileLaunchOptions = {
  allowLaunch?: boolean;
};

const EVENT_ADJECTIVES = [
  "Ancient",
  "Ashen",
  "Blackened",
  "Blazing",
  "Bleached",
  "Bloodlit",
  "Bone-Dry",
  "Buried",
  "Cinder",
  "Clouded",
  "Copper",
  "Crimson",
  "Dead",
  "Dustbound",
  "Dune",
  "Ember",
  "Feral",
  "Forgotten",
  "Fractured",
  "Glass",
  "Golden",
  "Grim",
  "Hidden",
  "Hollow",
  "Iron",
  "Jagged",
  "Last",
  "Lost",
  "Moonlit",
  "Nomad",
  "Obsidian",
  "Old",
  "Pale",
  "Ravaged",
  "Rogue",
  "Rust",
  "Salt",
  "Savage",
  "Scorched",
  "Silent",
  "Shifting",
  "Sirocco",
  "Smoldering",
  "Storm",
  "Sunken",
  "Thorned",
  "Twilight",
  "Vagrant",
  "Veiled",
  "Warborn",
  "White",
  "Wicked",
];

const EVENT_NOUNS = [
  "Ambush",
  "Arena",
  "Badlands",
  "Basin",
  "Boneyard",
  "Breach",
  "Bulwark",
  "Camp",
  "Caravan",
  "Citadel",
  "Crest",
  "Crossing",
  "Crucible",
  "Deadfall",
  "Den",
  "Drift",
  "Drydock",
  "Echo",
  "Expanse",
  "Fall",
  "Frontier",
  "Gauntlet",
  "Gate",
  "Grounds",
  "Harbor",
  "Hearth",
  "Hollow",
  "Labyrinth",
  "March",
  "Maw",
  "Mirage",
  "Needle",
  "Nest",
  "Outpost",
  "Pit",
  "Passage",
  "Pinnacle",
  "Quarry",
  "Reach",
  "Redoubt",
  "Ridge",
  "Rift",
  "Ruins",
  "Sanctum",
  "Scar",
  "Shelf",
  "Spire",
  "Strand",
  "Stronghold",
  "Throne",
  "Tomb",
  "Trail",
  "Vault",
  "Vigil",
  "Wastes",
  "Watch",
  "Waystation",
];

const EVENT_LOCATION_NAMES = [
  "Ashen Crossing",
  "Black Dune Outpost",
  "Bleached Bone Camp",
  "Blood Sun Arena",
  "Buried Caravan",
  "Cinder Ridge",
  "Copper Wreck",
  "Crimson Basin",
  "Dead Salt Flats",
  "Dune Watch",
  "Dustbound Stronghold",
  "Ember Gate",
  "Fallen Nomad Camp",
  "Fractured Spire",
  "Glass Hollow",
  "Iron Drift",
  "Jagged Pass",
  "Last Walker Camp",
  "Lost Quarry",
  "Moonlit Ruins",
  "Nomad Redoubt",
  "Obsidian Scar",
  "Old Trade Post",
  "Pale Ridge",
  "Ravaged Waystation",
  "Rogue Harbor",
  "Rust Needle",
  "Salt March",
  "Scorched Bulwark",
  "Shifting Frontier",
  "Silent Tomb",
  "Smoldering Pit",
  "Storm Shelf",
  "Sunken Vault",
  "Thorned Basin",
  "Twilight Reach",
  "Vagrant Trail",
  "Veiled Stronghold",
  "Warborn Arena",
  "White Dune Camp",
];

const EVENT_LOCATION_SUFFIXES = [
  "Ambush",
  "Cache",
  "Challenge",
  "Convoy",
  "Expedition",
  "Gauntlet",
  "Hunt",
  "Raid",
  "Rally",
  "Trial",
];

const TRACKED_TILE_DISCOVERY_GRACE_MS = 10 * 60_000;
const CLEANUP_DELETE_VERIFICATION_DELAY_MS = 60_000;
const CLEANUP_DELETE_STABLE_ABSENCE_MS = 3 * 60_000;

type Coordinate = {
  x: number;
  y: number;
};

type CandidateCoordinate = Coordinate & {
  distanceScore: number;
  anchorTouches: number;
  randomWeight: number;
};

function addHours(timestamp: string, hours: number) {
  return new Date(Date.parse(timestamp) + Math.max(0, hours) * 60 * 60 * 1000).toISOString();
}

function isTrackedTileDiscoveryRecent(timestamp: string | null | undefined) {
  if (!timestamp) {
    return false;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return Date.now() - parsed < TRACKED_TILE_DISCOVERY_GRACE_MS;
}

function hasRecentTimestamp(timestamp: string | null | undefined, windowMs: number) {
  if (!timestamp) {
    return false;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return Date.now() - parsed < windowMs;
}

function uniqNumbers(values: number[]) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function uniqStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildCleanupBatchKey(batch: EventTileCleanupBatch) {
  return [
    uniqNumbers(batch.tileIds).join(","),
    uniqStrings(batch.tileNames).join("|").toLowerCase(),
    batch.deleteAfter,
  ].join("::");
}

function normalizeCleanupBatches(state: EventTileCycleState): EventTileCleanupBatch[] {
  const batches: EventTileCleanupBatch[] = [];

  for (const batch of state.cleanupBatches ?? []) {
    const tileIds = uniqNumbers(batch.tileIds ?? []);
    const tileNames = uniqStrings(batch.tileNames ?? []);
    const deleteAfter = typeof batch.deleteAfter === "string" && batch.deleteAfter.trim()
      ? batch.deleteAfter
      : state.cleanupDeleteAfter ?? new Date().toISOString();
    if (!tileIds.length && !tileNames.length) {
      continue;
    }

    batches.push({
      tileIds,
      tileNames,
      deleteAfter,
      deleteRequestedAt: batch.deleteRequestedAt ?? null,
    });
  }

  const legacyTileIds = uniqNumbers(state.cleanupTileIds ?? []);
  const legacyTileNames = uniqStrings(state.cleanupTileNames ?? []);
  if (!batches.length && (legacyTileIds.length || legacyTileNames.length)) {
    batches.push({
      tileIds: legacyTileIds,
      tileNames: legacyTileNames,
      deleteAfter: state.cleanupDeleteAfter ?? new Date().toISOString(),
      deleteRequestedAt: state.cleanupDeleteRequestedAt ?? null,
    });
  }

  const seen = new Set<string>();
  return batches.filter((batch) => {
    const key = buildCleanupBatchKey(batch);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getNextCleanupDeleteAfter(batches: EventTileCleanupBatch[]) {
  const candidates = batches
    .map((batch) => ({ batch, timestamp: Date.parse(batch.deleteAfter) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);

  return candidates[0]?.batch.deleteAfter ?? null;
}

function withCleanupBatches(state: EventTileCycleState, batches: EventTileCleanupBatch[]): EventTileCycleState {
  const normalizedBatches = normalizeCleanupBatches({
    ...state,
    cleanupTileIds: [],
    cleanupTileNames: [],
    cleanupDeleteAfter: null,
    cleanupDeleteRequestedAt: null,
    cleanupBatches: batches,
  });
  const nextDeleteAfter = getNextCleanupDeleteAfter(normalizedBatches);
  const nextRequestedAt =
    normalizedBatches.find((batch) => batch.deleteAfter === nextDeleteAfter)?.deleteRequestedAt ??
    normalizedBatches.find((batch) => batch.deleteRequestedAt)?.deleteRequestedAt ??
    null;

  return {
    ...state,
    cleanupBatches: normalizedBatches,
    cleanupTileIds: uniqNumbers(normalizedBatches.flatMap((batch) => batch.tileIds)),
    cleanupTileNames: uniqStrings(normalizedBatches.flatMap((batch) => batch.tileNames)),
    cleanupDeleteAfter: nextDeleteAfter,
    cleanupDeleteRequestedAt: nextRequestedAt,
  };
}

function addCleanupBatch(
  state: EventTileCycleState,
  tileIds: number[],
  tileNames: string[],
  deleteAfter: string,
) {
  return withCleanupBatches(state, [
    ...normalizeCleanupBatches(state),
    {
      tileIds: uniqNumbers(tileIds),
      tileNames: uniqStrings(tileNames),
      deleteAfter,
      deleteRequestedAt: null,
    },
  ]);
}

function coordinateKey(x: number, y: number) {
  return `${x},${y}`;
}

function hexDistance(left: Coordinate, right: Coordinate) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return (Math.abs(dx) + Math.abs(dx + dy) + Math.abs(dy)) / 2;
}

function distancePriority(distance: number) {
  if (distance === 3) {
    return 0;
  }
  if (distance === 4) {
    return 1;
  }
  if (distance === 2) {
    return 2;
  }
  return 3;
}

function resolveTrackedTilesByIdsOrNames(tileIds: number[], tileNames: string[], tiles: MyRealmTileSummary[]) {
  const tileSet = new Set(uniqNumbers(tileIds));
  const tileNameSet = new Set(uniqStrings(tileNames).map((value) => value.toLowerCase()));
  return tiles.filter((tile) => tileSet.has(tile.tileId) || tileNameSet.has(tile.tileName.trim().toLowerCase()));
}

function resolveAnchorTiles(state: EventTileCycleState, tiles: MyRealmTileSummary[]) {
  const withCoordinates = tiles.filter((tile) => tile.x !== null && tile.y !== null);
  if (!withCoordinates.length) {
    return [];
  }

  const configured = uniqNumbers(state.eligibleTileIds);
  if (!configured.length) {
    return withCoordinates;
  }

  const configuredSet = new Set(configured);
  const anchors = withCoordinates.filter((tile) => configuredSet.has(tile.tileId));
  return anchors.length ? anchors : withCoordinates;
}

function buildCandidateCoordinates(anchors: MyRealmTileSummary[], occupied: Set<string>, spacingRadius: number) {
  const candidates = new Map<string, CandidateCoordinate>();

  for (const anchor of anchors) {
    if (anchor.x === null || anchor.y === null) {
      continue;
    }

    for (let dx = -spacingRadius; dx <= spacingRadius; dx += 1) {
      for (let dy = -spacingRadius; dy <= spacingRadius; dy += 1) {
        const candidate = { x: anchor.x + dx, y: anchor.y + dy };
        const distance = hexDistance({ x: anchor.x, y: anchor.y }, candidate);
        if (!Number.isFinite(distance) || distance < 1 || distance > spacingRadius) {
          continue;
        }

        const key = coordinateKey(candidate.x, candidate.y);
        if (occupied.has(key)) {
          continue;
        }

        const existing = candidates.get(key);
        const distanceScore = distancePriority(distance);
        if (!existing) {
          candidates.set(key, {
            ...candidate,
            distanceScore,
            anchorTouches: 1,
            randomWeight: Math.random(),
          });
          continue;
        }

        existing.anchorTouches += 1;
        existing.distanceScore = Math.min(existing.distanceScore, distanceScore);
      }
    }
  }

  return [...candidates.values()].sort((left, right) => {
    if (left.distanceScore !== right.distanceScore) {
      return left.distanceScore - right.distanceScore;
    }

    if (left.anchorTouches !== right.anchorTouches) {
      return right.anchorTouches - left.anchorTouches;
    }

    return left.randomWeight - right.randomWeight;
  });
}

function buildEventTileName(prefix: string, existingNames: Set<string>) {
  const normalizedPrefix = prefix.trim() || "[EVENT]";

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const locationName = Math.random() < 0.82
      ? EVENT_LOCATION_NAMES[Math.floor(Math.random() * EVENT_LOCATION_NAMES.length)]
      : `${EVENT_ADJECTIVES[Math.floor(Math.random() * EVENT_ADJECTIVES.length)]} ${EVENT_NOUNS[Math.floor(Math.random() * EVENT_NOUNS.length)]}`;
    const suffix = Math.random() < 0.24
      ? ` ${EVENT_LOCATION_SUFFIXES[Math.floor(Math.random() * EVENT_LOCATION_SUFFIXES.length)]}`
      : "";
    const candidate = `${normalizedPrefix} ${locationName}${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${normalizedPrefix} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function clampQuality(value: number) {
  return Math.min(4, Math.max(1, Math.round(value)));
}

function formatDeleteGraceLabel(hours: number) {
  const normalized = Math.max(0, Math.round(hours));
  if (normalized === 1) {
    return "1 hour";
  }

  if (normalized >= 24 && normalized % 24 === 0) {
    const days = normalized / 24;
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  return `${normalized} hours`;
}

function resolveEventTileQuality(state: EventTileCycleState) {
  if (state.qualityMode !== "random") {
    return clampQuality(state.quality);
  }

  const minimum = clampQuality(Math.min(state.qualityMin, state.qualityMax));
  const maximum = clampQuality(Math.max(state.qualityMin, state.qualityMax));
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function resolveAllowedMapOptions(state: EventTileCycleState, mapOptions: MyRealmCreateTileOption[]) {
  const allowedMapIds = new Set(state.allowedMapIds.filter(Boolean));
  if (!allowedMapIds.size) {
    return mapOptions;
  }

  return mapOptions.filter((option) => allowedMapIds.has(option.mapId));
}

function normalizeMapKey(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function resolveTrackedMapKeys(state: EventTileCycleState, tiles: MyRealmTileSummary[]) {
  const trackedTileIds = uniqNumbers([...state.previewTileIds, ...state.activeTileIds]);
  const trackedTileNames = uniqStrings([...state.previewTileNames, ...state.activeTileNames]);
  const trackedTiles = resolveTrackedTilesByIdsOrNames(trackedTileIds, trackedTileNames, tiles);
  const mapKeys = new Set<string>();

  for (const tile of trackedTiles) {
    const mapKey = normalizeMapKey(tile.mapName);
    if (mapKey) {
      mapKeys.add(mapKey);
    }
  }

  return mapKeys;
}

async function ensureTilesActivated(
  flow: MyRealmFlowSummary,
  tileIds: number[],
  activationAt: Date,
  deactivationAt: Date,
  options?: EventTileLaunchOptions,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tiles = await loadMyRealmTileSummaries(flow, options);
    const trackedTiles = resolveTrackedTilesByIdsOrNames(tileIds, [], tiles);
    const inactiveTiles = trackedTiles.filter((tile) => !tile.isActive && !tile.isPendingInactive && tile.canActivate);

    if (!inactiveTiles.length) {
      return tiles;
    }

    for (const tile of inactiveTiles) {
      await activateMyRealmTile(flow, tile.tileId, options);
      await updateMyRealmTileAutomation(
        flow,
        tile.tileId,
        {
          activationAt,
          deactivationAt,
        },
        options,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  return loadMyRealmTileSummaries(flow, options);
}

function resolveTileNames(tileIds: number[], tiles: MyRealmTileSummary[], fallbackNames: string[] = []) {
  const byId = new Map(tiles.map((tile) => [tile.tileId, tile.tileName]));
  const resolved = tileIds.map((tileId) => byId.get(tileId)).filter((value): value is string => Boolean(value));
  if (resolved.length === tileIds.length && resolved.length) {
    return resolved;
  }

  const normalizedFallback = uniqStrings(fallbackNames);
  if (normalizedFallback.length) {
    return normalizedFallback;
  }

  return tileIds.map((tileId) => byId.get(tileId) ?? `Tile ${tileId}`);
}

function dedupeEventTileCycles(cycles: EventTileCycleState[]) {
  const seen = new Set<string>();
  const deduped: EventTileCycleState[] = [];
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const cycle = cycles[index];
    if (seen.has(cycle.id)) {
      continue;
    }

    seen.add(cycle.id);
    deduped.unshift(cycle);
  }

  return deduped;
}

export function listEventTileCycles(config: AppConfig) {
  const cycles = config.eventTileCycles.length ? config.eventTileCycles : [config.eventTileCycle];
  return dedupeEventTileCycles(cycles);
}

export function resolveEventTileCycle(config: AppConfig, cycleId?: string | null) {
  const cycles = listEventTileCycles(config);
  const preferredId = cycleId ?? config.selectedEventTileCycleId ?? config.eventTileCycle.id ?? null;
  return (
    (preferredId ? cycles.find((cycle) => cycle.id === preferredId) : null) ??
    cycles[0] ??
    config.eventTileCycle
  );
}

export function applyEventTileCycleState(config: AppConfig, nextState: EventTileCycleState) {
  const nextCycles = listEventTileCycles(config).map((cycle) => (cycle.id === nextState.id ? nextState : cycle));
  const selectedEventTileCycleId =
    config.selectedEventTileCycleId && nextCycles.some((cycle) => cycle.id === config.selectedEventTileCycleId)
      ? config.selectedEventTileCycleId
      : nextState.id;
  const selectedCycle =
    nextCycles.find((cycle) => cycle.id === selectedEventTileCycleId) ??
    nextCycles.find((cycle) => cycle.id === nextState.id) ??
    nextCycles[0] ??
    nextState;

  return {
    ...config,
    selectedEventTileCycleId,
    eventTileCycles: nextCycles,
    eventTileCycle: selectedCycle,
  };
}

export function getEventTileCycleNextMaintenanceAt(state: EventTileCycleState) {
  const candidates: number[] = [];
  const mainTransitionAt = state.nextTransitionAt ? Date.parse(state.nextTransitionAt) : Number.NaN;
  if (Number.isFinite(mainTransitionAt)) {
    candidates.push(mainTransitionAt);
  }

  for (const batch of normalizeCleanupBatches(state)) {
    const cleanupAt = Date.parse(batch.deleteAfter);
    if (Number.isFinite(cleanupAt)) {
      candidates.push(cleanupAt);
    }
  }

  if (!candidates.length) {
    return null;
  }

  return new Date(Math.min(...candidates)).toISOString();
}

export function preserveEventTileCycleLibraryForConfigSave(currentConfig: AppConfig, incomingConfig: Partial<AppConfig>) {
  const currentCycles = listEventTileCycles(currentConfig);
  const incomingCycles = Array.isArray(incomingConfig.eventTileCycles)
    ? dedupeEventTileCycles(
        incomingConfig.eventTileCycles.filter(
          (cycle): cycle is EventTileCycleState => Boolean(cycle && typeof cycle.id === "string" && cycle.id.trim()),
        ),
      )
    : [];
  const incomingSelectedId =
    typeof incomingConfig.selectedEventTileCycleId === "string" && incomingConfig.selectedEventTileCycleId.trim()
      ? incomingConfig.selectedEventTileCycleId.trim()
      : null;
  const incomingSelectedCycle = incomingConfig.eventTileCycle ?? null;
  const mergedCycles = [...currentCycles];
  const mergedCycleIds = new Set(mergedCycles.map((cycle) => cycle.id));

  for (let index = 0; index < mergedCycles.length; index += 1) {
    const currentCycle = mergedCycles[index];
    const incomingCycle = incomingCycles.find((cycle) => cycle.id === currentCycle.id);
    if (incomingCycle) {
      mergedCycles[index] = {
        ...currentCycle,
        ...incomingCycle,
        id: currentCycle.id,
      };
      continue;
    }

    if (incomingSelectedCycle && incomingSelectedId === currentCycle.id) {
      mergedCycles[index] = {
        ...currentCycle,
        ...incomingSelectedCycle,
        id: currentCycle.id,
        name: incomingSelectedCycle.name?.trim() || currentCycle.name,
      };
    }
  }

  for (const incomingCycle of incomingCycles) {
    if (mergedCycleIds.has(incomingCycle.id)) {
      continue;
    }

    mergedCycles.push(incomingCycle);
    mergedCycleIds.add(incomingCycle.id);
  }

  const fallbackCycles = mergedCycles.length ? mergedCycles : currentCycles;
  const selectedEventTileCycleId =
    (incomingSelectedId && fallbackCycles.some((cycle) => cycle.id === incomingSelectedId)
      ? incomingSelectedId
      : currentConfig.selectedEventTileCycleId && fallbackCycles.some((cycle) => cycle.id === currentConfig.selectedEventTileCycleId)
        ? currentConfig.selectedEventTileCycleId
        : fallbackCycles[0]?.id) ?? null;
  const eventTileCycle =
    fallbackCycles.find((cycle) => cycle.id === selectedEventTileCycleId) ??
    fallbackCycles[0] ??
    currentConfig.eventTileCycle;

  return {
    selectedEventTileCycleId: eventTileCycle.id,
    eventTileCycles: fallbackCycles,
    eventTileCycle,
  };
}

function createCycleId() {
  return `event-cycle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createEventTileCycle(config: AppConfig, templateCycleId?: string | null, cycleName?: string | null) {
  const template = resolveEventTileCycle(config, templateCycleId);
  const nextIndex = listEventTileCycles(config).length;
  const nextState: EventTileCycleState = {
    ...template,
    id: createCycleId(),
    name: cycleName?.trim() || `Event Cycle ${nextIndex + 1}`,
    enabled: false,
    phase: "idle",
    previewTileIds: [],
    previewTileNames: [],
    activeTileIds: [],
    activeTileNames: [],
    cleanupTileIds: [],
    cleanupTileNames: [],
    cleanupDeleteAfter: null,
    cleanupBatches: [],
    previewStartedAt: null,
    activeStartedAt: null,
    cleanupDeleteRequestedAt: null,
    nextTransitionAt: null,
    lastAction: "Event tile cycle is idle.",
  };

  return {
    ...config,
    selectedEventTileCycleId: nextState.id,
    eventTileCycles: [...listEventTileCycles(config), nextState],
    eventTileCycle: nextState,
  };
}

export function deleteEventTileCycle(config: AppConfig, cycleId?: string | null) {
  const cycles = listEventTileCycles(config);
  if (cycles.length <= 1) {
    throw new Error("At least one event cycle must remain.");
  }

  const target = resolveEventTileCycle(config, cycleId);
  if (
    target.phase !== "idle" ||
    target.previewTileIds.length ||
    target.activeTileIds.length ||
    target.cleanupTileIds.length ||
    normalizeCleanupBatches(target).length
  ) {
    throw new Error("Only idle event cycles with no tracked tiles can be deleted.");
  }

  const nextCycles = cycles.filter((cycle) => cycle.id !== target.id);
  const selectedEventTileCycleId =
    config.selectedEventTileCycleId === target.id ? nextCycles[0]?.id ?? null : config.selectedEventTileCycleId;
  const selectedCycle =
    nextCycles.find((cycle) => cycle.id === selectedEventTileCycleId) ??
    nextCycles[0];

  return {
    ...config,
    selectedEventTileCycleId: selectedCycle?.id ?? null,
    eventTileCycles: nextCycles,
    eventTileCycle: selectedCycle ?? target,
  };
}

function createResult(
  action: EventTileCycleResult["action"],
  nextState: EventTileCycleState,
  tiles: MyRealmTileSummary[],
  message: string,
  created?: {
    tileIds: number[];
    tileNames: string[];
    tiles?: MyRealmTileSummary[];
    activationAt: string | null;
    deactivationAt: string | null;
  },
): EventTileCycleResult {
  return {
    action,
    phase: nextState.phase,
    previewTileIds: nextState.previewTileIds,
    activeTileIds: nextState.activeTileIds,
    previewTileNames: resolveTileNames(nextState.previewTileIds, tiles, nextState.previewTileNames),
    activeTileNames: resolveTileNames(nextState.activeTileIds, tiles, nextState.activeTileNames),
    createdTileIds: created?.tileIds ?? [],
    createdTileNames: created?.tileNames ?? [],
    createdTiles:
      created?.tiles?.map((tile) => ({
        tileId: tile.tileId,
        tileName: tile.tileName,
        mapName: tile.mapName,
        quality: tile.quality,
        activationAt: created.activationAt ?? tile.activationDate ?? null,
        deactivationAt: created.deactivationAt ?? tile.deactivationDate ?? null,
      })) ?? [],
    activationAt: created?.activationAt ?? null,
    deactivationAt: created?.deactivationAt ?? null,
    nextTransitionAt: nextState.nextTransitionAt,
    message,
  };
}

function createIdleResetState(currentState: EventTileCycleState, message: string): EventTileCycleState {
  return withCleanupBatches({
    ...currentState,
    phase: "idle",
    previewTileIds: [],
    previewTileNames: [],
    activeTileIds: [],
    activeTileNames: [],
    cleanupTileIds: currentState.cleanupTileIds,
    cleanupTileNames: currentState.cleanupTileNames,
    cleanupDeleteAfter: currentState.cleanupDeleteAfter,
    previewStartedAt: null,
    activeStartedAt: null,
    cleanupDeleteRequestedAt: currentState.cleanupDeleteRequestedAt,
    nextTransitionAt: null,
    lastAction: message,
  }, normalizeCleanupBatches(currentState));
}

function createCleanupVerificationState(
  currentState: EventTileCycleState,
  nextTransitionAt: string,
  cleanupDeleteRequestedAt: string,
  message: string,
): EventTileCycleState {
  return {
    ...currentState,
    phase: "cleanup",
    cleanupDeleteRequestedAt,
    nextTransitionAt,
    lastAction: message,
  };
}

async function createPreviewBatch(state: EventTileCycleState, flow: MyRealmFlowSummary, tiles: MyRealmTileSummary[], options?: EventTileLaunchOptions) {
  const anchors = resolveAnchorTiles(state, tiles);
  if (!anchors.length) {
    throw new Error("MyRealm did not return any anchor tiles with map coordinates. Load a live MyRealm session first.");
  }

  const occupied = new Set(
    tiles
      .filter((tile) => tile.x !== null && tile.y !== null)
      .map((tile) => coordinateKey(tile.x!, tile.y!)),
  );
  const candidates = buildCandidateCoordinates(anchors, occupied, Math.max(1, Math.min(6, state.spacingRadius)));
  if (!candidates.length) {
    throw new Error("No valid empty map positions were found near the chosen anchor tiles.");
  }

  const existingNames = new Set(tiles.map((tile) => tile.tileName.toLowerCase()));
  const desiredCount = Math.max(1, Math.min(state.cycleSize, candidates.length));
  const createdTileIds: number[] = [];
  const createdTileNames: string[] = [];
  const createdTiles: MyRealmTileSummary[] = [];
  const usedMapKeys = resolveTrackedMapKeys(state, tiles);
  const previewHours = Math.max(0, state.previewHours);
  const activeHours = Math.max(2, state.activeHours);
  const activationAt = new Date(Date.now() + previewHours * 60 * 60 * 1000);
  const deactivationAt = new Date(activationAt.getTime() + activeHours * 60 * 60 * 1000);

  for (const candidate of candidates) {
    if (createdTileIds.length >= desiredCount) {
      break;
    }

    let mapOptions;
    try {
      mapOptions = await loadMyRealmCreateTileOptions(flow, candidate.x, candidate.y, options);
    } catch {
      continue;
    }

    const allowedMapOptions = resolveAllowedMapOptions(state, mapOptions).filter((option) => {
      const mapIdKey = normalizeMapKey(option.mapId);
      const mapNameKey = normalizeMapKey(option.mapName);
      return (!mapIdKey || !usedMapKeys.has(mapIdKey)) && (!mapNameKey || !usedMapKeys.has(mapNameKey));
    });
    if (!allowedMapOptions.length) {
      continue;
    }

    const selectedMap = allowedMapOptions[Math.floor(Math.random() * allowedMapOptions.length)];
    const name = buildEventTileName(state.namePrefix, existingNames);

      try {
        const createdTile = await createMyRealmTile(flow, {
          x: candidate.x,
          y: candidate.y,
          name,
          mapId: selectedMap.mapId,
          mapName: selectedMap.mapName,
          pvpMode: state.pvpMode,
          quality: resolveEventTileQuality(state),
        }, options);
        await updateMyRealmTileAutomation(flow, createdTile.tileId, {
          activationAt,
          deactivationAt,
        }, options);

        existingNames.add(createdTile.tileName.toLowerCase());
        createdTileIds.push(createdTile.tileId);
        createdTileNames.push(createdTile.tileName);
        createdTiles.push(createdTile);
        const selectedMapIdKey = normalizeMapKey(selectedMap.mapId);
        const selectedMapNameKey = normalizeMapKey(selectedMap.mapName);
        if (selectedMapIdKey) {
          usedMapKeys.add(selectedMapIdKey);
        }
        if (selectedMapNameKey) {
          usedMapKeys.add(selectedMapNameKey);
        }
        occupied.add(coordinateKey(candidate.x, candidate.y));
      } catch (error) {
        const pendingTileId =
          typeof (error as { tileId?: unknown }).tileId === "number"
            ? ((error as { tileId: number }).tileId)
            : null;
        if (pendingTileId) {
          try {
            await deleteMyRealmTile(flow, pendingTileId, options);
          } catch {
            // Best effort: if MyRealm accepted the create request but never exposed the tile reliably,
            // don't let that hidden tile poison the next cycle state.
          }
        }
      }
    }

  if (!createdTileIds.length) {
    throw new Error("MyRealm did not accept any of the candidate event tile placements.");
  }

  const activatedImmediately = previewHours <= 0;
  if (activatedImmediately) {
    for (const tileId of createdTileIds) {
      await activateMyRealmTile(flow, tileId, options);
    }

    await ensureTilesActivated(flow, createdTileIds, activationAt, deactivationAt, options);
  }

  return {
    createdTileIds,
    createdTileNames,
    createdTiles,
    activationAt: activationAt.toISOString(),
    deactivationAt: deactivationAt.toISOString(),
    activatedImmediately,
  };
}

function createPreviewState(
  currentState: EventTileCycleState,
  createdTileIds: number[],
  activationAt: string,
  createdTileNames: string[],
) {
  return {
    ...currentState,
    enabled: true,
    phase: "preview" as const,
    previewTileIds: createdTileIds,
    previewTileNames: createdTileNames,
    activeTileIds: [],
    activeTileNames: [],
    previewStartedAt: new Date().toISOString(),
    activeStartedAt: null,
    cleanupDeleteRequestedAt: currentState.cleanupDeleteRequestedAt,
    nextTransitionAt: activationAt,
    lastAction: `Created ${createdTileIds.length} event tile(s): ${createdTileNames.join(", ")}. Preview ends at ${new Date(activationAt).toLocaleString()}.`,
  };
}

export async function previewEventTileBatchPlan(
  config: AppConfig,
  flow: MyRealmFlowSummary,
  cycleId?: string | null,
  options?: EventTileLaunchOptions,
): Promise<EventTileDryRunResult> {
  const state = resolveEventTileCycle(config, cycleId);
  const tiles = await loadMyRealmTileSummaries(flow, options);
  const anchors = resolveAnchorTiles(state, tiles);
  if (!anchors.length) {
    throw new Error("MyRealm did not return any anchor tiles with map coordinates. Load a live MyRealm session first.");
  }

  const occupied = new Set(
    tiles
      .filter((tile) => tile.x !== null && tile.y !== null)
      .map((tile) => coordinateKey(tile.x!, tile.y!)),
  );
  const candidates = buildCandidateCoordinates(anchors, occupied, Math.max(1, Math.min(6, state.spacingRadius)));
  const existingNames = new Set(tiles.map((tile) => tile.tileName.toLowerCase()));
  const usedMapKeys = resolveTrackedMapKeys(state, tiles);
  const desiredCount = Math.max(1, Math.min(state.cycleSize, candidates.length));
  const selectedCandidates: EventTileDryRunResult["selectedCandidates"] = [];
  let skippedCoordinates = 0;

  for (const candidate of candidates) {
    if (selectedCandidates.length >= desiredCount) {
      break;
    }

    let mapOptions: MyRealmCreateTileOption[];
    try {
      mapOptions = await loadMyRealmCreateTileOptions(flow, candidate.x, candidate.y, options);
    } catch {
      skippedCoordinates += 1;
      continue;
    }

    const allowedMapOptions = resolveAllowedMapOptions(state, mapOptions).filter((option) => {
      const mapIdKey = normalizeMapKey(option.mapId);
      const mapNameKey = normalizeMapKey(option.mapName);
      return (!mapIdKey || !usedMapKeys.has(mapIdKey)) && (!mapNameKey || !usedMapKeys.has(mapNameKey));
    });
    if (!allowedMapOptions.length) {
      skippedCoordinates += 1;
      continue;
    }

    const selectedMap = allowedMapOptions[Math.floor(Math.random() * allowedMapOptions.length)];
    const name = buildEventTileName(state.namePrefix, existingNames);
    existingNames.add(name.toLowerCase());
    const selectedMapIdKey = normalizeMapKey(selectedMap.mapId);
    const selectedMapNameKey = normalizeMapKey(selectedMap.mapName);
    if (selectedMapIdKey) {
      usedMapKeys.add(selectedMapIdKey);
    }
    if (selectedMapNameKey) {
      usedMapKeys.add(selectedMapNameKey);
    }

    selectedCandidates.push({
      x: candidate.x,
      y: candidate.y,
      distanceScore: candidate.distanceScore,
      anchorTouches: candidate.anchorTouches,
      mapId: selectedMap.mapId,
      mapName: selectedMap.mapName,
      quality: resolveEventTileQuality(state),
      pvpMode: state.pvpMode,
      name,
    });
  }

  return {
    cycleId: state.id,
    cycleName: state.name,
    generatedAt: new Date().toISOString(),
    desiredCount,
    availableCandidates: candidates.length,
    selectedCandidates,
    skippedCoordinates,
    message: selectedCandidates.length
      ? `Dry run selected ${selectedCandidates.length} candidate event tile(s). No MyRealm create request was sent.`
      : "Dry run did not find a usable event tile placement. No MyRealm create request was sent.",
  };
}

function createActiveState(
  currentState: EventTileCycleState,
  createdTileIds: number[],
  activationAt: string,
  deactivationAt: string,
  createdTileNames: string[],
) {
  return {
    ...currentState,
    enabled: true,
    phase: "active" as const,
    previewTileIds: [],
    previewTileNames: [],
    activeTileIds: createdTileIds,
    activeTileNames: createdTileNames,
    previewStartedAt: null,
    activeStartedAt: activationAt,
    cleanupDeleteRequestedAt: currentState.cleanupDeleteRequestedAt,
    nextTransitionAt: deactivationAt,
    lastAction: `Created and activated ${createdTileIds.length} event tile(s): ${createdTileNames.join(", ")}. They burn at ${new Date(deactivationAt).toLocaleString()}.`,
  };
}

function createBackgroundCleanupState(
  currentState: EventTileCycleState,
  cleanupTileIds: number[],
  deleteAt: string,
  cleanupTileNames: string[],
  deleteGraceHours: number,
  messagePrefix: string,
) {
  const nextState = addCleanupBatch(currentState, cleanupTileIds, cleanupTileNames, deleteAt);
  return {
    ...nextState,
    lastAction: `${messagePrefix} ${cleanupTileNames.join(", ")} will stay for ${formatDeleteGraceLabel(deleteGraceHours)} as a safety buffer and delete after ${new Date(deleteAt).toLocaleString()}.`,
  };
}

function createCleanupState(
  currentState: EventTileCycleState,
  activeTileIds: number[],
  deleteAt: string,
  activeTileNames: string[],
  deleteGraceHours: number,
) {
  return {
    ...currentState,
    enabled: true,
    phase: "cleanup" as const,
    previewTileIds: [],
    previewTileNames: [],
    activeTileIds,
    activeTileNames,
    previewStartedAt: null,
    cleanupDeleteRequestedAt: null,
    nextTransitionAt: deleteAt,
    lastAction: `The event batch burned and is cooling down for ${formatDeleteGraceLabel(deleteGraceHours)} before delete: ${activeTileNames.join(", ")}. Cleanup is scheduled for ${new Date(deleteAt).toLocaleString()}.`,
  };
}

function createStateFromBatch(
  currentState: EventTileCycleState,
  batch: {
    createdTileIds: number[];
    createdTileNames: string[];
    activationAt: string;
    deactivationAt: string;
    activatedImmediately: boolean;
  },
) {
  if (batch.activatedImmediately) {
    return createActiveState(
      currentState,
      batch.createdTileIds,
      batch.activationAt,
      batch.deactivationAt,
      batch.createdTileNames,
    );
  }

  return createPreviewState(currentState, batch.createdTileIds, batch.activationAt, batch.createdTileNames);
}

async function processBackgroundCleanup(
  state: EventTileCycleState,
  flow: MyRealmFlowSummary,
  tiles: MyRealmTileSummary[],
  options?: EventTileLaunchOptions,
) {
  const cleanupBatches = normalizeCleanupBatches(state);
  if (!cleanupBatches.length) {
    return withCleanupBatches(state, []);
  }

  const now = Date.now();
  const remainingBatches: EventTileCleanupBatch[] = [];
  let deletedRequestCount = 0;
  let finishedCount = 0;
  let waitingNames: string[] = [];

  for (const batch of cleanupBatches) {
    const deleteAfter = Date.parse(batch.deleteAfter);
    if (Number.isFinite(deleteAfter) && now < deleteAfter) {
      remainingBatches.push(batch);
      continue;
    }

    const trackedCleanupTiles = resolveTrackedTilesByIdsOrNames(batch.tileIds, batch.tileNames, tiles);
    if (!trackedCleanupTiles.length) {
      if (batch.deleteRequestedAt && hasRecentTimestamp(batch.deleteRequestedAt, CLEANUP_DELETE_STABLE_ABSENCE_MS)) {
        remainingBatches.push(batch);
        continue;
      }

      finishedCount += batch.tileIds.length || batch.tileNames.length;
      continue;
    }

    if (batch.deleteRequestedAt && hasRecentTimestamp(batch.deleteRequestedAt, CLEANUP_DELETE_VERIFICATION_DELAY_MS)) {
      remainingBatches.push(batch);
      continue;
    }

    const deletableTiles = trackedCleanupTiles.filter((tile) => tile.canDelete);
    if (!deletableTiles.length) {
      remainingBatches.push(batch);
      waitingNames = [...waitingNames, ...batch.tileNames];
      continue;
    }

    for (const tile of deletableTiles) {
      await deleteMyRealmTile(flow, tile.tileId, options);
    }

    deletedRequestCount += deletableTiles.length;
    remainingBatches.push({
      ...batch,
      deleteRequestedAt: new Date().toISOString(),
    });
  }

  const nextState = withCleanupBatches(state, remainingBatches);
  if (deletedRequestCount > 0) {
    return {
      ...nextState,
      lastAction: `Background cleanup requested delete for ${deletedRequestCount} previous event tile(s). ${remainingBatches.length} cleanup batch(es) remain tracked.`,
    };
  }

  if (finishedCount > 0) {
    return {
      ...nextState,
      lastAction: `Background cleanup finished for ${finishedCount} previous event tile reference(s). ${remainingBatches.length} cleanup batch(es) remain tracked.`,
    };
  }

  if (waitingNames.length) {
    return {
      ...nextState,
      lastAction: `Waiting for MyRealm to allow background delete on ${uniqStrings(waitingNames).join(", ")}.`,
    };
  }

  return nextState;
}

export async function loadEventTileContext(flow: MyRealmFlowSummary, options?: EventTileLaunchOptions) {
  const tiles = await loadMyRealmTileSummaries(flow, options);
  return {
    tiles,
  };
}

export async function startEventTilePreviewCycle(
  config: AppConfig,
  flow: MyRealmFlowSummary,
  cycleId?: string | null,
  options?: EventTileLaunchOptions,
) {
  const tiles = await loadMyRealmTileSummaries(flow, options);
  const cycleState = await processBackgroundCleanup(resolveEventTileCycle(config, cycleId), flow, tiles, options);
  const hasPreviewTracking = cycleState.previewTileIds.length > 0 || cycleState.previewTileNames.length > 0;
  const hasActiveTracking = cycleState.activeTileIds.length > 0 || cycleState.activeTileNames.length > 0;
  const trackedPreviewTiles = resolveTrackedTilesByIdsOrNames(cycleState.previewTileIds, cycleState.previewTileNames, tiles);
  const trackedActiveTiles = resolveTrackedTilesByIdsOrNames(cycleState.activeTileIds, cycleState.activeTileNames, tiles);
  const previewBatchStillSettling =
    hasPreviewTracking &&
    trackedPreviewTiles.length === 0 &&
    isTrackedTileDiscoveryRecent(cycleState.previewStartedAt);
  const activeBatchStillSettling =
    hasActiveTracking &&
    trackedActiveTiles.length === 0 &&
    isTrackedTileDiscoveryRecent(cycleState.activeStartedAt);
  const staleTrackedState =
    (cycleState.phase !== "idle" &&
      !hasPreviewTracking &&
      !hasActiveTracking) ||
    (hasPreviewTracking && trackedPreviewTiles.length === 0 && !previewBatchStillSettling) ||
    (hasActiveTracking && trackedActiveTiles.length === 0 && !activeBatchStillSettling);
  const baseState =
    staleTrackedState
      ? createIdleResetState(
          cycleState,
          "The previous event batch no longer exists in MyRealm, so the generator was reset and is ready to create a fresh batch.",
        )
      : cycleState;

  if (
    baseState.phase !== "idle" &&
    (
      baseState.previewTileIds.length ||
      baseState.previewTileNames.length ||
      baseState.activeTileIds.length ||
      baseState.activeTileNames.length ||
      trackedPreviewTiles.length ||
      trackedActiveTiles.length
    )
  ) {
    throw new Error("The event cycle is already running. Pause it first if you want to reset the generated event batch.");
  }

  const batch = await createPreviewBatch(baseState, flow, tiles, options);
  const nextTiles = await loadMyRealmTileSummaries(flow, options);
  const nextState = createStateFromBatch(baseState, batch);

  return {
    tiles: nextTiles,
    nextState,
      result: createResult(batch.activatedImmediately ? "preview_promoted" : "preview_started", nextState, nextTiles, nextState.lastAction, {
        tileIds: batch.createdTileIds,
        tileNames: batch.createdTileNames,
        tiles: batch.createdTiles,
        activationAt: batch.activationAt,
        deactivationAt: batch.deactivationAt,
      }),
    };
  }

export async function advanceEventTileCycle(
  config: AppConfig,
  flow: MyRealmFlowSummary,
  cycleId?: string | null,
  options?: EventTileLaunchOptions,
) {
  const currentTiles = await loadMyRealmTileSummaries(flow, options);
  let state = await processBackgroundCleanup(resolveEventTileCycle(config, cycleId), flow, currentTiles, options);
  const now = Date.now();

  if (state.phase === "preview") {
    const hasPreviewTracking = state.previewTileIds.length > 0 || state.previewTileNames.length > 0;
    const trackedPreviewTiles = resolveTrackedTilesByIdsOrNames(state.previewTileIds, state.previewTileNames, currentTiles);
    const nextTransitionAt = state.nextTransitionAt ? Date.parse(state.nextTransitionAt) : Number.NaN;
    if (!trackedPreviewTiles.length && hasPreviewTracking) {
      if (Number.isFinite(nextTransitionAt) && now < nextTransitionAt) {
        const nextState: EventTileCycleState = {
          ...state,
          lastAction: `Preview batch is not visible in MyRealm yet. Waiting for activation at ${new Date(nextTransitionAt).toLocaleString()} before taking any corrective action.`,
        };
        return {
          tiles: currentTiles,
          nextState,
          result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
        };
      }

      const activationStartedAt = state.nextTransitionAt ?? state.previewStartedAt ?? new Date().toISOString();
      const deactivationAt = addHours(activationStartedAt, state.activeHours);
      const activationSnapshot = await ensureTilesActivated(
        flow,
        state.previewTileIds,
        new Date(activationStartedAt),
        new Date(deactivationAt),
        options,
      );
      const promotedTiles = resolveTrackedTilesByIdsOrNames(
        state.previewTileIds,
        state.previewTileNames,
        activationSnapshot,
      );

      if (!promotedTiles.length) {
        const activationGraceDeadline =
          (Number.isFinite(nextTransitionAt) ? nextTransitionAt : Date.parse(activationStartedAt)) + TRACKED_TILE_DISCOVERY_GRACE_MS;
        if (now < activationGraceDeadline) {
          const nextState: EventTileCycleState = {
            ...state,
            lastAction: "The preview batch is still not visible in MyRealm after the activation window. Waiting for MyRealm to expose the tracked tiles instead of creating a duplicate batch.",
          };
          return {
            tiles: activationSnapshot,
            nextState,
            result: createResult("maintenance_checked", nextState, activationSnapshot, nextState.lastAction),
          };
        }

        const nextState = createIdleResetState(
          state,
          "The preview batch never became visible in MyRealm after the activation window, so the cycle was reset without creating a duplicate batch.",
        );
        return {
          tiles: activationSnapshot,
          nextState,
          result: createResult("maintenance_checked", nextState, activationSnapshot, nextState.lastAction),
        };
      }
    }

    const previewHasGoneLive = trackedPreviewTiles.some((tile) => tile.isActive || tile.isPendingInactive);
    if (!previewHasGoneLive && Number.isFinite(nextTransitionAt) && now < nextTransitionAt) {
      const nextState: EventTileCycleState = {
        ...state,
        lastAction: `Preview batch is still waiting for MyRealm activation at ${new Date(nextTransitionAt).toLocaleString()}.`,
      };
      return {
        tiles: currentTiles,
        nextState,
        result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
      };
    }

    const activeStartedAt = state.nextTransitionAt ?? state.previewStartedAt ?? new Date().toISOString();
    const deactivationAt = addHours(activeStartedAt, state.activeHours);
    const promotedTiles = !previewHasGoneLive && hasPreviewTracking
      ? resolveTrackedTilesByIdsOrNames(
          state.previewTileIds,
          state.previewTileNames,
          await ensureTilesActivated(
            flow,
            state.previewTileIds,
            new Date(activeStartedAt),
            new Date(deactivationAt),
            options,
          ),
        )
      : trackedPreviewTiles;
    const promotedTileIds = promotedTiles.length ? promotedTiles.map((tile) => tile.tileId) : state.previewTileIds;
    const promotedTileNames = promotedTiles.length
      ? uniqStrings(promotedTiles.map((tile) => tile.tileName))
      : resolveTileNames(promotedTileIds, currentTiles, state.previewTileNames);
    const nextState: EventTileCycleState = {
      ...state,
      phase: "active",
      previewTileIds: [],
      previewTileNames: [],
      activeTileIds: promotedTileIds,
      activeTileNames: promotedTileNames,
      activeStartedAt,
      nextTransitionAt: deactivationAt,
      lastAction: previewHasGoneLive
        ? `MyRealm event batch is now active: ${promotedTileNames.join(", ")}. They burn at ${new Date(deactivationAt).toLocaleString()}.`
        : `The activation window was reached, so the control center activated ${promotedTileNames.join(", ")}. They burn at ${new Date(deactivationAt).toLocaleString()}.`,
    };

    return {
      tiles: promotedTiles.length ? promotedTiles : currentTiles,
      nextState,
      result: createResult("preview_promoted", nextState, promotedTiles.length ? promotedTiles : currentTiles, nextState.lastAction),
    };
  }

  if (state.phase === "active") {
    const hasActiveTracking = state.activeTileIds.length > 0 || state.activeTileNames.length > 0;
    const trackedActiveTiles = resolveTrackedTilesByIdsOrNames(state.activeTileIds, state.activeTileNames, currentTiles);
    if (!trackedActiveTiles.length && hasActiveTracking) {
      if (isTrackedTileDiscoveryRecent(state.activeStartedAt)) {
        const nextState: EventTileCycleState = {
          ...state,
          lastAction: "Active batch was promoted recently and MyRealm is still refreshing the hosted tile list. Waiting before resetting the cycle.",
        };
        return {
          tiles: currentTiles,
          nextState,
          result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
        };
      }

      const nextState = createIdleResetState(
        state,
        "The active event batch no longer exists in MyRealm, so the generator returned to idle.",
      );
      return {
        tiles: currentTiles,
        nextState,
        result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
      };
    }

    const nextTransitionAt = state.nextTransitionAt ? Date.parse(state.nextTransitionAt) : Number.NaN;
    if (Number.isFinite(nextTransitionAt) && now < nextTransitionAt) {
      const nextState: EventTileCycleState = {
        ...state,
        lastAction: `Active event batch is still scheduled to burn at ${new Date(nextTransitionAt).toLocaleString()}.`,
      };
      return {
        tiles: currentTiles,
        nextState,
        result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
      };
    }

    const stillActiveTiles = trackedActiveTiles.filter((tile) => !tile.isInactive);
    if (stillActiveTiles.length) {
      const nextState: EventTileCycleState = {
        ...state,
        lastAction: `Waiting for MyRealm to finish deactivating ${resolveTileNames(state.activeTileIds, currentTiles, state.activeTileNames).join(", ")} before the ${formatDeleteGraceLabel(state.deleteGraceHours)} cleanup timer begins.`,
      };
      return {
        tiles: currentTiles,
        nextState,
        result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
      };
    }

    const deleteAt = addHours(new Date().toISOString(), state.deleteGraceHours);
    const burnedTileIds = state.activeTileIds;
    const burnedTileNames = resolveTileNames(state.activeTileIds, currentTiles, state.activeTileNames);
    const cleanupBaseState = createBackgroundCleanupState(
      state,
      burnedTileIds,
      deleteAt,
      burnedTileNames,
      state.deleteGraceHours,
      "The active event batch burned.",
    );

    const respawnBaseState = createIdleResetState(cleanupBaseState, cleanupBaseState.lastAction);
    if (!state.autoAdvance) {
      return {
        tiles: currentTiles,
        nextState: respawnBaseState,
        result: createResult("cleanup_scheduled", respawnBaseState, currentTiles, respawnBaseState.lastAction),
      };
    }

    const batch = await createPreviewBatch(respawnBaseState, flow, currentTiles, options);
    const nextTiles = await loadMyRealmTileSummaries(flow, options);
    const nextState = createStateFromBatch(respawnBaseState, batch);
    nextState.lastAction = batch.activatedImmediately
      ? `${cleanupBaseState.lastAction} Immediately activated the next batch: ${batch.createdTileNames.join(", ")}.`
      : `${cleanupBaseState.lastAction} Created the next preview batch: ${batch.createdTileNames.join(", ")}.`;

    return {
      tiles: nextTiles,
      nextState,
      result: createResult(batch.activatedImmediately ? "preview_promoted" : "preview_started", nextState, nextTiles, nextState.lastAction, {
        tileIds: batch.createdTileIds,
        tileNames: batch.createdTileNames,
        tiles: batch.createdTiles,
        activationAt: batch.activationAt,
        deactivationAt: batch.deactivationAt,
      }),
    };
  }

  if (state.phase === "cleanup") {
    const trackedCleanupTiles = resolveTrackedTilesByIdsOrNames(state.activeTileIds, state.activeTileNames, currentTiles);
    const nextTransitionAt = state.nextTransitionAt ? Date.parse(state.nextTransitionAt) : Number.NaN;
    if (Number.isFinite(nextTransitionAt) && now < nextTransitionAt) {
      const nextState: EventTileCycleState = {
        ...state,
        lastAction: `The burned batch is cooling down and will be deleted at ${new Date(nextTransitionAt).toLocaleString()}.`,
      };
      return {
        tiles: currentTiles,
        nextState,
        result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
      };
    }

    if (!trackedCleanupTiles.length) {
      if (!state.cleanupDeleteRequestedAt) {
        const deleteRequestedAt = new Date().toISOString();
        let directDeleteCount = 0;
        for (const tileId of state.activeTileIds) {
          try {
            await deleteMyRealmTile(flow, tileId, options);
            directDeleteCount += 1;
          } catch {
            // MyRealm sometimes drops burned tiles from the map list before the delete flow settles.
            // We'll retry on the next pass instead of spawning a new batch from stale visibility.
          }
        }

        if (directDeleteCount > 0) {
          const tilesAfterDeleteRequest = await loadMyRealmTileSummaries(flow, options);
          const verifyAt = new Date(Date.now() + CLEANUP_DELETE_VERIFICATION_DELAY_MS).toISOString();
          const nextState = createCleanupVerificationState(
            state,
            verifyAt,
            deleteRequestedAt,
            `Delete was requested directly for ${directDeleteCount} cooled-down event tile(s) even though MyRealm hid them from the tile list. Waiting for removal to stay stable before spawning the next batch.`,
          );
          return {
            tiles: tilesAfterDeleteRequest,
            nextState,
            result: createResult("maintenance_checked", nextState, tilesAfterDeleteRequest, nextState.lastAction),
          };
        }

        const verifyAt = new Date(Date.now() + CLEANUP_DELETE_VERIFICATION_DELAY_MS).toISOString();
        const nextState: EventTileCycleState = {
          ...state,
          nextTransitionAt: verifyAt,
          lastAction: `MyRealm is still refreshing the burned batch visibility for ${resolveTileNames(state.activeTileIds, currentTiles, state.activeTileNames).join(", ")}. Waiting before retrying cleanup so the next batch cannot spawn from a stale empty list.`,
        };
        return {
          tiles: currentTiles,
          nextState,
          result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
        };
      }

      if (hasRecentTimestamp(state.cleanupDeleteRequestedAt, CLEANUP_DELETE_STABLE_ABSENCE_MS)) {
        const stableAt = new Date(Date.parse(state.cleanupDeleteRequestedAt) + CLEANUP_DELETE_STABLE_ABSENCE_MS).toLocaleString();
        const nextState: EventTileCycleState = {
          ...state,
          nextTransitionAt: new Date(Date.parse(state.cleanupDeleteRequestedAt) + CLEANUP_DELETE_STABLE_ABSENCE_MS).toISOString(),
          lastAction: `MyRealm no longer shows the burned batch, but the control center is double-checking that absence until ${stableAt} before spawning the next batch.`,
        };
        return {
          tiles: currentTiles,
          nextState,
          result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
        };
      }

      const respawnBaseState = createIdleResetState(
        state,
        `Deleted ${state.activeTileIds.length} cooled-down event tile(s) and is preparing the next batch.`,
      );
      if (!state.autoAdvance) {
        return {
          tiles: currentTiles,
          nextState: respawnBaseState,
          result: createResult("cleanup_finished", respawnBaseState, currentTiles, respawnBaseState.lastAction),
        };
      }

      const batch = await createPreviewBatch(respawnBaseState, flow, currentTiles, options);
      const nextTiles = await loadMyRealmTileSummaries(flow, options);
      const nextState = createStateFromBatch(respawnBaseState, batch);
      nextState.lastAction = batch.activatedImmediately
        ? `Deleted ${state.activeTileIds.length} cooled-down event tile(s) and immediately activated ${batch.createdTileNames.join(", ")}.`
        : `Deleted ${state.activeTileIds.length} cooled-down event tile(s) and created ${batch.createdTileNames.join(", ")}.`;

      return {
        tiles: nextTiles,
        nextState,
        result: createResult("cleanup_finished", nextState, nextTiles, nextState.lastAction, {
          tileIds: batch.createdTileIds,
          tileNames: batch.createdTileNames,
          tiles: batch.createdTiles,
          activationAt: batch.activationAt,
          deactivationAt: batch.deactivationAt,
        }),
      };
    }

    if (trackedCleanupTiles.some((tile) => !tile.canDelete)) {
      const nextState: EventTileCycleState = {
        ...state,
        lastAction: `Waiting for MyRealm to allow delete on ${resolveTileNames(state.activeTileIds, currentTiles, state.activeTileNames).join(", ")} after the cooldown window.`,
      };
      return {
        tiles: currentTiles,
        nextState,
        result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
      };
    }

    const deleteRequestedAt = new Date().toISOString();
    for (const tile of trackedCleanupTiles) {
      await deleteMyRealmTile(flow, tile.tileId, options);
    }

    const tilesAfterDeleteRequest = await loadMyRealmTileSummaries(flow, options);
    const verifyAt = new Date(Date.now() + CLEANUP_DELETE_VERIFICATION_DELAY_MS).toISOString();
    const nextState = createCleanupVerificationState(
      state,
      verifyAt,
      deleteRequestedAt,
      `Delete was requested for ${trackedCleanupTiles.length} cooled-down event tile(s). Waiting for MyRealm to confirm removal before spawning the next batch.`,
    );
    return {
      tiles: tilesAfterDeleteRequest,
      nextState,
      result: createResult("maintenance_checked", nextState, tilesAfterDeleteRequest, nextState.lastAction),
    };
  }

  const nextState: EventTileCycleState = {
    ...state,
    lastAction: state.lastAction || "Event tile cycle is idle.",
  };
  return {
    tiles: currentTiles,
    nextState,
    result: createResult("maintenance_checked", nextState, currentTiles, nextState.lastAction),
  };
}

export function pauseEventTileCycle(config: AppConfig, tiles: MyRealmTileSummary[], cycleId?: string | null) {
  const cycleState = resolveEventTileCycle(config, cycleId);
  const nextState: EventTileCycleState = {
    ...cycleState,
    enabled: false,
    phase: "idle",
    previewTileIds: [],
    previewTileNames: [],
    activeTileIds: [],
    activeTileNames: [],
    previewStartedAt: null,
    activeStartedAt: null,
    cleanupDeleteRequestedAt: null,
    nextTransitionAt: null,
    lastAction: "Paused the generated event tile cycle. Existing MyRealm event tiles were left untouched.",
  };

  return {
    nextState,
    result: createResult("paused", nextState, tiles, nextState.lastAction),
  };
}

export async function forceCleanupEventTileCycle(
  config: AppConfig,
  flow: MyRealmFlowSummary,
  cycleId?: string | null,
  options?: EventTileLaunchOptions,
) {
  const cycleState = resolveEventTileCycle(config, cycleId);
  const cleanupBatches = normalizeCleanupBatches(cycleState);
  const trackedTileIds = uniqNumbers([
    ...cycleState.previewTileIds,
    ...cycleState.activeTileIds,
    ...cleanupBatches.flatMap((batch) => batch.tileIds),
  ]);
  const trackedTileNames = uniqStrings([
    ...cycleState.previewTileNames,
    ...cycleState.activeTileNames,
    ...cleanupBatches.flatMap((batch) => batch.tileNames),
  ]);
  const currentTiles = await loadMyRealmTileSummaries(flow, options);

  if (!trackedTileIds.length && !trackedTileNames.length) {
    const nextState = createIdleResetState(cycleState, `No tracked tiles were left for ${cycleState.name}, so nothing needed cleanup.`);
    return {
      tiles: currentTiles,
      nextState,
      result: createResult("manual_cleanup", nextState, currentTiles, nextState.lastAction),
    };
  }

  const trackedTiles = resolveTrackedTilesByIdsOrNames(trackedTileIds, trackedTileNames, currentTiles);
  for (const tile of trackedTiles) {
    if (tile.canDeactivate && !tile.isInactive && !tile.isPendingInactive) {
      await deactivateMyRealmTile(flow, tile.tileId, options);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const tilesAfterDeactivate = await loadMyRealmTileSummaries(flow, options);
  const tilesToDelete = resolveTrackedTilesByIdsOrNames(trackedTileIds, trackedTileNames, tilesAfterDeactivate);

  for (const tile of tilesToDelete) {
    if (tile.canDelete) {
      await deleteMyRealmTile(flow, tile.tileId, options);
    }
  }

  const nextTiles = await loadMyRealmTileSummaries(flow, options);
  const nextState: EventTileCycleState = {
    ...cycleState,
    phase: "idle",
    previewTileIds: [],
    previewTileNames: [],
    activeTileIds: [],
    activeTileNames: [],
    cleanupTileIds: [],
    cleanupTileNames: [],
    cleanupDeleteAfter: null,
    cleanupBatches: [],
    previewStartedAt: null,
    activeStartedAt: null,
    cleanupDeleteRequestedAt: null,
    nextTransitionAt: null,
    lastAction: `Force-cleaned ${trackedTileIds.length} tracked tile(s) for ${cycleState.name}.`,
  };

  return {
    tiles: nextTiles,
    nextState,
    result: createResult("manual_cleanup", nextState, nextTiles, nextState.lastAction),
  };
}
