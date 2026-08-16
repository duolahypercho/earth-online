/**
 * Source-neutral building entrance and interior metadata.
 *
 * This module deliberately contains no renderer, DOM, clock, or Three.js
 * dependency.  A city source can derive the same portal contract before its
 * presentation is built, and the canonical runtime can then decide how to
 * render or stream the active room.
 */

export const INTERIOR_CONTRACT_SCHEMA_VERSION = 1;

const EPSILON = 1e-6;
const DEFAULT_APPROACH_OFFSET = 2.65;
const ROAD_PENALTY = Object.freeze({
  motorway: 2.4,
  trunk: 2.1,
  primary: 1.3,
  secondary: 0.9,
  tertiary: 0.55,
  unclassified: 0.35,
  residential: 0,
  living_street: 0,
  service: 0.15,
  pedestrian: 0.1,
  footway: 0.75,
  cycleway: 0.9,
  path: 1.1,
  steps: 1.2,
});

const CIVIC_WORDS = /(?:civic|school|university|college|hospital|clinic|library|museum|courthouse|townhall|town hall|fire[_ -]?station|police|community[_ -]?centre|place[_ -]?of[_ -]?worship|church|cathedral|chapel|temple|mosque|synagogue|government)/i;
const HOSPITALITY_WORDS = /(?:hotel|hostel|restaurant|cafe|coffee|bar|pub|bakery|fast[_ -]?food|guesthouse|motel|tourism)/i;
const RETAIL_WORDS = /(?:retail|shop|store|market|supermarket|mall|department|boutique|salon|pharmacy|commercial)/i;
const INDUSTRIAL_WORDS = /(?:industrial|warehouse|factory|manufactur|workshop|hangar|shed|depot)/i;
const OFFICE_WORDS = /(?:office|tower|bank|financial|corporate|cowork|studio)/i;
const RESIDENTIAL_WORDS = /(?:residential|rowhouse|house|home|apartment|flat|dormitory|detached|semidetached|terrace)/i;

/**
 * Derive one deterministic public entrance and one compact ground-floor room
 * descriptor for every record in `city.buildings`.
 *
 * Render-only sources (for example a metric tile that has no building
 * metadata) intentionally return an empty array.  A malformed individual
 * building still receives a deterministic fallback portal so the one-record
 * to one-portal invariant is never silently weakened.
 */
export function deriveBuildingEntrances(city, options = {}) {
  const buildings = Array.isArray(city?.buildings) ? city.buildings : [];
  if (buildings.length === 0) return [];

  const segments = collectStreetSegments(city);
  const generator = sourceGenerator(city);
  const usedPortalIds = new Set();
  const occurrences = new Map();
  const maxApproachOffset = finitePositive(options.maxApproachOffset, 5.5);
  const minApproachOffset = finitePositive(options.minApproachOffset, 2.2);

  return buildings.map((building, index) => {
    const rawBuildingId = stableBuildingId(building, index);
    const occurrence = occurrences.get(rawBuildingId) || 0;
    occurrences.set(rawBuildingId, occurrence + 1);
    const basePortalId = `sf-portal:${rawBuildingId}`;
    const portalId = uniqueId(basePortalId, occurrence, usedPortalIds);
    usedPortalIds.add(portalId);

    const points = normalizePolygon(building);
    const shape = shapeMetrics(points, building, city);
    const frontage = chooseFrontage(shape, building, segments);
    const normal = frontage.normal;
    const wallOffset = clamp(
      Number.isFinite(frontage.edgeLength) ? frontage.edgeLength * 0.08 : 0.34,
      0.22,
      0.52,
    );
    const sidewalkWidth = finiteNonNegative(frontage.segment?.sidewalkW, 0);
    const streetOffset = frontage.segment
      ? clamp(sidewalkWidth + 1.25, minApproachOffset, maxApproachOffset)
      : clamp(DEFAULT_APPROACH_OFFSET, minApproachOffset, maxApproachOffset);
    const position = pointWithOffset(frontage.midpoint, normal, wallOffset);
    const approach = pointWithOffset(frontage.midpoint, normal, streetOffset);
    const archetype = interiorArchetype(building);
    const roomSize = roomDimensions(shape, building);
    const floors = floorCount(building);
    const interior = {
      schemaVersion: INTERIOR_CONTRACT_SCHEMA_VERSION,
      archetype,
      floors,
      rooms: [{
        id: `${portalId}:ground-floor`,
        floor: 0,
        kind: groundRoomKind(archetype),
        archetype,
        walkable: true,
        width: roomSize.width,
        depth: roomSize.depth,
      }],
    };

    const source = frontage.segment
      ? (frontage.matchesFacingStreet ? 'facing-street' : 'street-frontage')
      : 'generated-fallback';
    const street = frontage.segment ? {
      id: stringOrNull(frontage.segment.streetId),
      name: stringOrNull(frontage.segment.streetName || frontage.segment.name),
      highway: stringOrNull(frontage.segment.highway),
      distance: finiteNonNegative(frontage.distance, null),
    } : null;

    return {
      id: portalId,
      buildingId: rawBuildingId,
      buildingIndex: index,
      label: stringOrNull(building?.name || building?.typeLabel || building?.type) || `Building ${index + 1}`,
      address: stringOrNull(building?.address || building?.addr),
      position: point3(position.x, 0, position.z),
      approach: point3(approach.x, 0, approach.z),
      normal: point3(normal.x, 0, normal.z),
      heading: finiteNumber(Math.atan2(normal.x, normal.z), 0),
      radius: clamp(streetOffset * 0.48, 1.25, 2.4),
      source,
      sourceMetadata: {
        generator,
        buildingId: rawBuildingId,
        street,
        edgeIndex: frontage.edgeIndex,
        distanceToStreet: finiteNonNegative(frontage.distance, null),
      },
      street,
      interior,
    };
  });
}

/**
 * Summarize one portal per building coverage without making any presentation
 * claims.  Passing a portal array avoids deriving the same records twice when
 * the caller already owns the canonical portal list.
 */
export function getBuildingInteriorCoverage(city, portals = null) {
  const buildings = Array.isArray(city?.buildings) ? city.buildings : [];
  const records = Array.isArray(portals) ? portals : deriveBuildingEntrances(city);
  const buildingCount = buildings.length;
  const registered = Math.min(buildingCount, records.length);
  const functional = records.filter((portal) => (
    portal?.interior?.schemaVersion === INTERIOR_CONTRACT_SCHEMA_VERSION
    && Number.isFinite(portal?.interior?.floors)
    && Array.isArray(portal?.interior?.rooms)
    && portal.interior.rooms.length > 0
  )).length;
  const sourceCounts = {};
  const archetypeCounts = {};
  for (const portal of records) {
    const source = String(portal?.source || 'unknown');
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    const archetype = String(portal?.interior?.archetype || 'unknown');
    archetypeCounts[archetype] = (archetypeCounts[archetype] || 0) + 1;
  }
  return {
    source: sourceGenerator(city),
    renderOnly: buildingCount === 0,
    buildingCount,
    portalCount: records.length,
    registered,
    functional: Math.min(registered, functional),
    missing: Math.max(0, buildingCount - registered),
    sourceCounts,
    archetypeCounts,
  };
}

// Short aliases keep the contract discoverable to callers that use the
// broader “interior coverage” vocabulary while retaining one implementation.
export const summarizeInteriorCoverage = getBuildingInteriorCoverage;
export const getInteriorCoverage = getBuildingInteriorCoverage;
export const deriveInteriorPortals = deriveBuildingEntrances;

function chooseFrontage(shape, building, segments) {
  const edges = shape.edges;
  if (edges.length === 0) {
    const midpoint = shape.center;
    const normal = { x: 0, z: 1 };
    return {
      midpoint,
      normal,
      edgeIndex: -1,
      edgeLength: 0,
      segment: null,
      distance: Infinity,
      matchesFacingStreet: false,
    };
  }

  let best = null;
  for (const edge of edges) {
    const nearest = nearestStreet(edge.midpoint, segments);
    const facingStreet = String(building?.facingStreet || building?.facing_street || '').trim().toLowerCase();
    const segmentName = String(nearest.segment?.streetName || nearest.segment?.name || '').trim().toLowerCase();
    const matchesFacingStreet = Boolean(facingStreet && segmentName && facingStreet === segmentName);
    const roadPenalty = ROAD_PENALTY[String(nearest.segment?.highway || '').toLowerCase()] || 0;
    // A matching source-facing street is a meaningful tie-breaker, but the
    // geometric distance remains dominant so portals stay on the true frontage.
    const score = nearest.segment
      ? nearest.distance + roadPenalty + (matchesFacingStreet ? -0.75 : 0)
      : 100000 + edge.edgeIndex;
    const candidate = {
      midpoint: edge.midpoint,
      normal: edge.normal,
      edgeIndex: edge.edgeIndex,
      edgeLength: edge.length,
      segment: nearest.segment,
      distance: nearest.distance,
      matchesFacingStreet,
      score,
    };
    if (!best || candidate.score < best.score - EPSILON
      || (Math.abs(candidate.score - best.score) <= EPSILON && candidate.edgeIndex < best.edgeIndex)) {
      best = candidate;
    }
  }

  // A city may have buildings but no street segment metadata.  The longest
  // stable edge is a predictable frontage fallback in that render-only case.
  if (!best?.segment) {
    return edges.slice().sort((a, b) => b.length - a.length || a.edgeIndex - b.edgeIndex)[0];
  }
  return best;
}

function shapeMetrics(points, building, city) {
  if (points.length < 2) {
    const fallback = fallbackCenter(building, city);
    return { center: fallback, edges: [] };
  }
  const center = polygonCenter(points);
  const edges = [];
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < EPSILON) continue;
    const midpoint = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
    let normal = outwardNormal(a, b, midpoint, center);
    if (!Number.isFinite(normal.x) || !Number.isFinite(normal.z)) normal = { x: 0, z: 1 };
    edges.push({ edgeIndex: index, midpoint, normal, length });
  }
  return { center, edges };
}

function collectStreetSegments(city) {
  const input = Array.isArray(city?.segments)
    ? city.segments
    : Array.isArray(city?.streetSegments)
      ? city.streetSegments
      : Array.isArray(city?.roads)
        ? city.roads
        : [];
  const segments = [];
  for (const street of input) {
    const points = normalizeSegmentPoints(street);
    if (points.length < 2) continue;
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      if (Math.hypot(b.x - a.x, b.z - a.z) < EPSILON) continue;
      segments.push({
        ...street,
        points: [a, b],
      });
    }
  }
  if (segments.length > 0) return segments;

  // Procedural city metadata has enough axis information to reconstruct a
  // source-neutral line when an importer omitted explicit segments.
  const streets = Array.isArray(city?.streets) ? city.streets : [];
  const bounds = finiteBounds(city?.meta?.bounds) || { minX: -10000, maxX: 10000, minZ: -10000, maxZ: 10000 };
  for (const street of streets) {
    const axis = String(street?.axis || '').toLowerCase();
    const position = Number(street?.position);
    if (!Number.isFinite(position)) continue;
    const points = axis === 'x'
      ? [{ x: position, z: bounds.minZ }, { x: position, z: bounds.maxZ }]
      : axis === 'z'
        ? [{ x: bounds.minX, z: position }, { x: bounds.maxX, z: position }]
        : [];
    if (points.length === 2) segments.push({ ...street, points });
  }
  return segments;
}

function nearestStreet(point, segments) {
  let best = { segment: null, distance: Infinity };
  for (const segment of segments) {
    const points = segment.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    const distance = pointToSegmentDistance(point, points[0], points[1]);
    if (distance < best.distance - EPSILON
      || (Math.abs(distance - best.distance) <= EPSILON && stableSegmentKey(segment) < stableSegmentKey(best.segment))) {
      best = { segment, distance };
    }
  }
  return best;
}

function stableSegmentKey(segment) {
  if (!segment) return '\uffff';
  return String(segment.id || segment.streetId || segment.streetName || segment.name || '');
}

function normalizePolygon(building) {
  const raw = Array.isArray(building?.polygon) && building.polygon.length
    ? building.polygon
    : building?.points;
  if (!Array.isArray(raw)) return [];
  const points = [];
  if (raw.length && typeof raw[0] === 'number') {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const point = finitePoint(raw[index], raw[index + 1]);
      if (point) points.push(point);
    }
  } else {
    for (const value of raw) {
      const point = finitePoint(value?.x ?? value?.[0], value?.z ?? value?.[1]);
      if (point) points.push(point);
    }
  }
  while (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  const unique = [];
  for (const point of points) {
    if (!unique.length || !samePoint(unique[unique.length - 1], point)) unique.push(point);
  }
  return unique;
}

function normalizeSegmentPoints(segment) {
  const raw = Array.isArray(segment?.points) && segment.points.length
    ? segment.points
    : Array.isArray(segment?.geometry)
      ? segment.geometry
      : [];
  if (!Array.isArray(raw)) return [];
  if (raw.length && typeof raw[0] === 'number') {
    const points = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const point = finitePoint(raw[index], raw[index + 1]);
      if (point) points.push(point);
    }
    return points;
  }
  return raw
    .map((point) => finitePoint(point?.x ?? point?.[0], point?.z ?? point?.[1]))
    .filter(Boolean);
}

function polygonCenter(points) {
  let twiceArea = 0;
  let x = 0;
  let z = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const cross = a.x * b.z - b.x * a.z;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    z += (a.z + b.z) * cross;
  }
  if (Math.abs(twiceArea) > EPSILON) {
    return { x: x / (3 * twiceArea), z: z / (3 * twiceArea) };
  }
  const xs = points.map((point) => point.x);
  const zs = points.map((point) => point.z);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) * 0.5,
    z: (Math.min(...zs) + Math.max(...zs)) * 0.5,
  };
}

function outwardNormal(a, b, midpoint, center) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const candidates = [
    { x: -dz / length, z: dx / length },
    { x: dz / length, z: -dx / length },
  ];
  const fromCenter = { x: midpoint.x - center.x, z: midpoint.z - center.z };
  return candidates[0].x * fromCenter.x + candidates[0].z * fromCenter.z
    >= candidates[1].x * fromCenter.x + candidates[1].z * fromCenter.z
    ? candidates[0]
    : candidates[1];
}

function pointToSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (!Number.isFinite(lengthSq) || lengthSq < EPSILON) return Math.hypot(point.x - a.x, point.z - a.z);
  let t = ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function fallbackCenter(building, city) {
  const center = finitePoint(
    building?.centroid?.x ?? building?.center?.x ?? building?.centroid?.[0],
    building?.centroid?.z ?? building?.center?.z ?? building?.centroid?.[1],
  );
  if (center) return center;
  const mapCenter = finitePoint(city?.meta?.center?.x, city?.meta?.center?.z);
  return mapCenter || { x: 0, z: 0 };
}

function roomDimensions(shape, building) {
  const points = shape.edges.flatMap((edge) => [
    { x: edge.midpoint.x - edge.normal.z * edge.length * 0.5, z: edge.midpoint.z + edge.normal.x * edge.length * 0.5 },
    { x: edge.midpoint.x + edge.normal.z * edge.length * 0.5, z: edge.midpoint.z - edge.normal.x * edge.length * 0.5 },
  ]);
  const rawWidth = Number(building?.width);
  const rawDepth = Number(building?.depth);
  const xs = points.length ? points.map((point) => point.x) : [shape.center.x];
  const zs = points.length ? points.map((point) => point.z) : [shape.center.z];
  return {
    width: clamp(finitePositive(rawWidth, Math.max(...xs) - Math.min(...xs)), 3.5, 18),
    depth: clamp(finitePositive(rawDepth, Math.max(...zs) - Math.min(...zs)), 3.5, 18),
  };
}

function interiorArchetype(building) {
  const values = [
    building?.usage,
    building?.type,
    building?.typeLabel,
    building?.building,
    building?.['building:use'],
    building?.shop,
    building?.amenity,
    building?.tourism,
    building?.name,
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  const text = values.join(' ');
  if (CIVIC_WORDS.test(text)) return 'civic';
  if (HOSPITALITY_WORDS.test(text)) return 'hospitality';
  if (RETAIL_WORDS.test(text)) return 'retail';
  if (INDUSTRIAL_WORDS.test(text)) return 'industrial';
  if (OFFICE_WORDS.test(text)) return 'office';
  if (RESIDENTIAL_WORDS.test(text)) return 'residential';
  return 'mixed';
}

function groundRoomKind(archetype) {
  if (archetype === 'retail') return 'storefront';
  if (archetype === 'hospitality') return 'public-hall';
  if (archetype === 'civic') return 'lobby';
  if (archetype === 'industrial') return 'workshop';
  if (archetype === 'office') return 'reception';
  if (archetype === 'residential') return 'home';
  return 'ground-floor';
}

function floorCount(building) {
  const raw = Number(
    building?.stories
    ?? building?.floors
    ?? building?.levels
    ?? building?.['building:levels'],
  );
  if (Number.isFinite(raw) && raw > 0) return clamp(Math.round(raw), 1, 128);
  const height = Number(building?.height);
  if (Number.isFinite(height) && height > 0) return clamp(Math.round(height / 3.2), 1, 128);
  return 1;
}

function sourceGenerator(city) {
  return String(city?.meta?.generator || city?.meta?.source || city?.source || 'unknown');
}

function stableBuildingId(building, index) {
  const value = building?.id ?? building?.buildingId ?? building?.osmId;
  const normalized = String(value ?? '').trim();
  return normalized || `building-${index + 1}`;
}

function uniqueId(base, occurrence, used) {
  const first = occurrence === 0 ? base : `${base}:${occurrence + 1}`;
  if (!used.has(first)) return first;
  let suffix = occurrence + 2;
  let candidate = `${base}:${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}:${suffix}`;
  }
  return candidate;
}

function pointWithOffset(point, normal, offset) {
  return {
    x: finiteNumber(point.x + normal.x * offset, 0),
    z: finiteNumber(point.z + normal.z * offset, 0),
  };
}

function point3(x, y, z) {
  return { x: finiteNumber(x, 0), y: finiteNumber(y, 0), z: finiteNumber(z, 0) };
}

function finitePoint(x, z) {
  return Number.isFinite(Number(x)) && Number.isFinite(Number(z))
    ? { x: Number(x), z: Number(z) }
    : null;
}

function finiteBounds(bounds) {
  if (!bounds) return null;
  const values = [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  return { minX: values[0], maxX: values[1], minZ: values[2], maxZ: values[3] };
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.z - b.z) <= EPSILON;
}

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function stringOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
