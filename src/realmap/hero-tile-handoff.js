/**
 * Bounded walkability controller for a streamed hero tile.
 *
 * This deliberately owns no streaming or collision state. It constrains a
 * collision-resolved player centre to the geometry currently resident in
 * memory (the tile core plus build buffer), and reports the exact cardinal
 * neighbor needed once the player crosses a core edge. Calling code remains
 * responsible for loading that neighbor and for sampling the final terrain.
 */

const CARDINAL_EDGES = Object.freeze(['north', 'east', 'south', 'west']);
const EPSILON = 1e-7;

const DEFAULT_CORE_BOUNDS = Object.freeze({ minX: 2144, minZ: 1728, maxX: 2528, maxZ: 2112 });
const DEFAULT_BUFFERED_BOUNDS = Object.freeze({ minX: 2128, minZ: 1712, maxX: 2544, maxZ: 2128 });

export const FERRY_HERO_TILE_HANDOFF_CONFIG = Object.freeze({
  // These are the live `hero-tile.js` coordinates, not the planned
  // sf-local-6-5 manifest coordinates. They must not be treated as a loaded
  // sf-local neighbor set until the coordinate-contract mismatch is resolved.
  tileId: 'sf-ferry-building-v1',
  coreBounds: DEFAULT_CORE_BOUNDS,
  bufferedBounds: DEFAULT_BUFFERED_BOUNDS,
  neighbors: Object.freeze({}),
});

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}

function normalizeBounds(bounds, label) {
  if (!bounds || typeof bounds !== 'object') throw new TypeError(`${label} is required.`);
  const normalized = {
    minX: finite(bounds.minX, `${label}.minX`),
    minZ: finite(bounds.minZ, `${label}.minZ`),
    maxX: finite(bounds.maxX, `${label}.maxX`),
    maxZ: finite(bounds.maxZ, `${label}.maxZ`),
  };
  if (normalized.minX >= normalized.maxX || normalized.minZ >= normalized.maxZ) {
    throw new RangeError(`${label} must have positive area.`);
  }
  return Object.freeze(normalized);
}

function normalizePosition(position, label) {
  if (!position || typeof position !== 'object') throw new TypeError(`${label} is required.`);
  return { x: finite(position.x, `${label}.x`), z: finite(position.z, `${label}.z`) };
}

function contains(bounds, position) {
  return position.x >= bounds.minX - EPSILON
    && position.x <= bounds.maxX + EPSILON
    && position.z >= bounds.minZ - EPSILON
    && position.z <= bounds.maxZ + EPSILON;
}

function strictlyContains(bounds, position) {
  return position.x > bounds.minX + EPSILON
    && position.x < bounds.maxX - EPSILON
    && position.z > bounds.minZ + EPSILON
    && position.z < bounds.maxZ - EPSILON;
}

function clampToBounds(bounds, position) {
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, position.x)),
    z: Math.min(bounds.maxZ, Math.max(bounds.minZ, position.z)),
  };
}

function cloneBounds(bounds) {
  return { ...bounds };
}

function edgeNeighborId(neighbors, edge) {
  // A cardinal request without a resolved tile id is deliberately explicit.
  // It never claims that missing neighbor content is available.
  return neighbors[edge] || null;
}

function crossingCandidates(previous, target, bounds) {
  const dx = target.x - previous.x;
  const dz = target.z - previous.z;
  const candidates = [];
  const add = (edge, t, other, min, max) => {
    if (t <= EPSILON || t >= 1 - EPSILON || other < min - EPSILON || other > max + EPSILON) return;
    candidates.push({ edge, t });
  };
  if (Math.abs(dx) > EPSILON) {
    add('west', (bounds.minX - previous.x) / dx, previous.z + dz * ((bounds.minX - previous.x) / dx), bounds.minZ, bounds.maxZ);
    add('east', (bounds.maxX - previous.x) / dx, previous.z + dz * ((bounds.maxX - previous.x) / dx), bounds.minZ, bounds.maxZ);
  }
  if (Math.abs(dz) > EPSILON) {
    add('south', (bounds.minZ - previous.z) / dz, previous.x + dx * ((bounds.minZ - previous.z) / dz), bounds.minX, bounds.maxX);
    add('north', (bounds.maxZ - previous.z) / dz, previous.x + dx * ((bounds.maxZ - previous.z) / dz), bounds.minX, bounds.maxX);
  }
  candidates.sort((a, b) => a.t - b.t || CARDINAL_EDGES.indexOf(a.edge) - CARDINAL_EDGES.indexOf(b.edge));
  const groups = [];
  for (const candidate of candidates) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.t - candidate.t) <= EPSILON) last.edges.push(candidate.edge);
    else groups.push({ t: candidate.t, edges: [candidate.edge] });
  }
  return groups;
}

function classifyCrossings(previous, target, bounds) {
  const magnitude = Math.hypot(target.x - previous.x, target.z - previous.z);
  if (magnitude <= EPSILON) return [];
  const sampleStep = Math.min(1e-5, 0.01 / magnitude);
  return crossingCandidates(previous, target, bounds).flatMap(({ t, edges }) => {
    const beforeT = Math.max(0, t - sampleStep);
    const afterT = Math.min(1, t + sampleStep);
    const before = { x: previous.x + (target.x - previous.x) * beforeT, z: previous.z + (target.z - previous.z) * beforeT };
    const after = { x: previous.x + (target.x - previous.x) * afterT, z: previous.z + (target.z - previous.z) * afterT };
    const wasInside = strictlyContains(bounds, before);
    const isInside = strictlyContains(bounds, after);
    if (wasInside === isInside) return [];
    return [{ t, edges, direction: wasInside ? 'exit' : 'entry' }];
  });
}

function freezeEvent(event) {
  return Object.freeze({
    ...event,
    edges: Object.freeze([...event.edges]),
    neighborIds: Object.freeze([...event.neighborIds]),
  });
}

/**
 * Converts the published manifest fields to a controller configuration. This
 * utility avoids a hard import so the runtime can load its manifest however it
 * chooses, and makes the planned-tile coordinates explicit at the call site.
 */
export function heroTileHandoffConfigFromManifest(manifest) {
  const grid = manifest?.grid;
  if (!manifest?.id || !grid?.localBoundsMeters || !grid?.localBuildBoundsMeters) {
    throw new TypeError('A world-tile manifest with id and grid bounds is required.');
  }
  const [minX, minZ, maxX, maxZ] = grid.localBoundsMeters;
  const [bufferMinX, bufferMinZ, bufferMaxX, bufferMaxZ] = grid.localBuildBoundsMeters;
  return {
    tileId: manifest.id,
    coreBounds: { minX, minZ, maxX, maxZ },
    bufferedBounds: { minX: bufferMinX, minZ: bufferMinZ, maxX: bufferMaxX, maxZ: bufferMaxZ },
    neighbors: { ...manifest.neighbors },
  };
}

/**
 * Adapts the active runtime hero tile without implying that it has the same
 * coordinate contract as any planned world-tile manifest.
 */
export function heroTileHandoffConfigFromRuntimeTile(tile, { neighbors = {} } = {}) {
  if (!tile?.id || !tile?.bounds || !tile?.bufferedBounds) {
    throw new TypeError('A runtime hero tile with id, bounds, and bufferedBounds is required.');
  }
  return {
    tileId: tile.id,
    coreBounds: { ...tile.bounds },
    bufferedBounds: { ...tile.bufferedBounds },
    neighbors: { ...neighbors },
  };
}

function boundsEqual(a, b) {
  return a.minX === b.minX && a.minZ === b.minZ && a.maxX === b.maxX && a.maxZ === b.maxZ;
}

/**
 * Reports whether the live hero launch and an offline manifest describe the
 * same resident coordinate domain. The runtime core remains authoritative for
 * a live player until this check passes; this function intentionally does not
 * transform or reconcile mismatching data.
 */
export function diagnoseHeroTileHandoffContract({ runtimeTile, manifest, launchPosition = null, landmarkPosition = null } = {}) {
  const runtime = heroTileHandoffConfigFromRuntimeTile(runtimeTile);
  const planned = heroTileHandoffConfigFromManifest(manifest);
  const pointStatus = (position) => {
    if (!position) return null;
    const point = normalizePosition(position, 'contract position');
    return {
      position: point,
      insideRuntimeCore: contains(runtime.coreBounds, point),
      insideRuntimeBuffer: contains(runtime.bufferedBounds, point),
      insideManifestCore: contains(planned.coreBounds, point),
      insideManifestBuffer: contains(planned.bufferedBounds, point),
    };
  };
  const coreBoundsMatch = boundsEqual(runtime.coreBounds, planned.coreBounds);
  const bufferedBoundsMatch = boundsEqual(runtime.bufferedBounds, planned.bufferedBounds);
  return {
    status: coreBoundsMatch && bufferedBoundsMatch ? 'aligned' : 'mismatch',
    authoritativeRuntimeCore: {
      tileId: runtime.tileId,
      coreBounds: runtime.coreBounds,
      bufferedBounds: runtime.bufferedBounds,
    },
    plannedManifestCore: {
      tileId: planned.tileId,
      coreBounds: planned.coreBounds,
      bufferedBounds: planned.bufferedBounds,
    },
    coreBoundsMatch,
    bufferedBoundsMatch,
    launch: pointStatus(launchPosition),
    landmark: pointStatus(landmarkPosition),
  };
}

/**
 * @param {object} config
 * @param {string} config.tileId stable identity of the currently resident tile
 * @param {object} config.coreBounds loaded tile's walkable core bounds
 * @param {object} config.bufferedBounds resident build-buffer bounds
 * @param {object} [config.neighbors] cardinal neighbor tile ids, if known
 * @param {(event: object) => void} [config.onNeighborRequested] loader hook
 */
export function createHeroTileHandoffController(config = FERRY_HERO_TILE_HANDOFF_CONFIG) {
  const coreBounds = normalizeBounds(config.coreBounds, 'coreBounds');
  const bufferedBounds = normalizeBounds(config.bufferedBounds, 'bufferedBounds');
  const tileId = String(config.tileId || '').trim();
  if (!tileId) throw new TypeError('tileId is required.');
  if (!contains(bufferedBounds, { x: coreBounds.minX, z: coreBounds.minZ })
    || !contains(bufferedBounds, { x: coreBounds.maxX, z: coreBounds.maxZ })) {
    throw new RangeError('bufferedBounds must fully contain coreBounds.');
  }
  const bufferThickness = {
    west: coreBounds.minX - bufferedBounds.minX,
    east: bufferedBounds.maxX - coreBounds.maxX,
    south: coreBounds.minZ - bufferedBounds.minZ,
    north: bufferedBounds.maxZ - coreBounds.maxZ,
  };
  if (Object.values(bufferThickness).some((value) => value < -EPSILON)) {
    throw new RangeError('bufferedBounds must surround coreBounds.');
  }
  const neighbors = Object.freeze({ ...(config.neighbors || {}) });
  const onNeighborRequested = typeof config.onNeighborRequested === 'function' ? config.onNeighborRequested : null;
  const neighborReady = new Map();
  const events = [];
  let lastPosition = null;
  let revision = 0;
  let disposed = false;
  let lastResult = null;

  const requestEvent = (crossing, requestedPosition) => {
    const neighborIds = crossing.edges.map((edge) => edgeNeighborId(neighbors, edge));
    const event = freezeEvent({
      id: `earth-tile-handoff:${tileId}:${crossing.edges.join('+')}:${revision + 1}`,
      type: 'neighbor-requested',
      originTileId: tileId,
      edges: crossing.edges,
      neighborIds,
      neighborReady: neighborIds.length > 0 && neighborIds.every((id) => id && neighborReady.get(id) === true),
      requestedPosition: { ...requestedPosition },
      crossingT: crossing.t,
    });
    revision += 1;
    events.push(event);
    if (events.length > 32) events.shift();
    onNeighborRequested?.(event);
    return event;
  };

  const getDiagnostics = () => ({
    active: !disposed,
    tileId,
    coreBounds: cloneBounds(coreBounds),
    bufferedBounds: cloneBounds(bufferedBounds),
    bufferThickness: { ...bufferThickness },
    lastPosition: lastPosition ? { ...lastPosition } : null,
    events: events.map((event) => ({ ...event, edges: [...event.edges], neighborIds: [...event.neighborIds] })),
    requestedNeighborIds: [...new Set(events.flatMap((event) => event.neighborIds).filter(Boolean))],
    readyNeighborIds: [...neighborReady.entries()].filter(([, ready]) => ready).map(([id]) => id).sort(),
    lastResult: lastResult ? { ...lastResult, position: { ...lastResult.position }, crossings: lastResult.crossings.map((crossing) => ({ ...crossing, edges: [...crossing.edges], neighborIds: [...crossing.neighborIds] })) } : null,
  });

  const resolve = (candidatePosition, { previousPosition = lastPosition } = {}) => {
    if (disposed) throw new Error('Hero tile handoff controller has been disposed.');
    const requestedPosition = normalizePosition(candidatePosition, 'candidatePosition');
    const previous = previousPosition ? normalizePosition(previousPosition, 'previousPosition') : requestedPosition;
    const crossings = classifyCrossings(previous, requestedPosition, coreBounds);
    const eventsThisResolve = [];
    for (const crossing of crossings) {
      if (crossing.direction === 'exit') eventsThisResolve.push(requestEvent(crossing, requestedPosition));
    }
    const position = clampToBounds(bufferedBounds, requestedPosition);
    lastPosition = { ...position };
    const insideCore = contains(coreBounds, position);
    const insideBuffer = !insideCore && contains(bufferedBounds, position);
    const crossingDiagnostics = crossings.map((crossing) => ({
      direction: crossing.direction,
      edges: [...crossing.edges],
      crossingT: crossing.t,
      neighborIds: crossing.edges.map((edge) => edgeNeighborId(neighbors, edge)),
      neighborReady: crossing.edges.every((edge) => {
        const id = edgeNeighborId(neighbors, edge);
        return Boolean(id && neighborReady.get(id) === true);
      }),
    }));
    const exited = crossingDiagnostics.some((crossing) => crossing.direction === 'exit');
    const entered = crossingDiagnostics.some((crossing) => crossing.direction === 'entry');
    lastResult = {
      requestedPosition: { ...requestedPosition },
      position: { ...position },
      clampedToBuffer: position.x !== requestedPosition.x || position.z !== requestedPosition.z,
      insideCore,
      insideBuffer,
      coreBoundaryCrossed: crossings.length > 0,
      neighborRequested: exited,
      neighborReady: eventsThisResolve.length > 0 && eventsThisResolve.every((event) => event.neighborReady),
      reenteredCore: entered,
      crossings: crossingDiagnostics,
    };
    return { ...lastResult, position: { ...position }, crossings: crossingDiagnostics };
  };

  /**
   * Convenience wrapper for main.js: resolve collisions first, then constrain
   * to resident geometry, then sample elevation at the final position.
   */
  const resolveMovement = ({ previousPosition, candidatePosition, resolveCollision, elevationAt } = {}) => {
    const candidate = normalizePosition(candidatePosition, 'candidatePosition');
    const collisionResolved = typeof resolveCollision === 'function'
      ? normalizePosition(resolveCollision(candidate), 'resolveCollision result')
      : candidate;
    const handoff = resolve(collisionResolved, { previousPosition });
    const terrainY = typeof elevationAt === 'function' ? finite(elevationAt(handoff.position.x, handoff.position.z), 'elevationAt result') : null;
    return { ...handoff, collisionResolved, terrainY };
  };

  return Object.freeze({
    resolve,
    resolveMovement,
    getDiagnostics,
    setNeighborReady(neighborId, ready = true) {
      if (disposed) throw new Error('Hero tile handoff controller has been disposed.');
      const id = String(neighborId || '').trim();
      if (!id) throw new TypeError('neighborId is required.');
      neighborReady.set(id, ready === true);
    },
    dispose() {
      disposed = true;
      lastPosition = null;
      events.length = 0;
      neighborReady.clear();
      lastResult = null;
    },
  });
}
