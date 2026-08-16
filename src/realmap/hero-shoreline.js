/**
 * Source-backed shoreline classification for the Ferry Building hero tile.
 *
 * `sf-city.json` embeds projected/simplified rings from DataSF's SF Shoreline
 * and Islands feature.  This module deliberately consumes those emitted rings
 * instead of inventing a waterfront rectangle from the terrain raster.
 */

export const FERRY_SHORELINE_SOURCE = Object.freeze({
  name: 'SF Shoreline and Islands (DataSF)',
  url: 'https://data.sfgov.org/api/geospatial/txuc-3kzm?method=export&format=GeoJSON',
  sha256: 'a3023288edff7a91f84f20ca54fc55693b2f6a4fa4fb396807378f31be80f01d',
  simplificationToleranceM: 5,
});

function finite(value) {
  return Number.isFinite(value);
}

function ringFromFlat(flat) {
  if (!Array.isArray(flat) || flat.length < 6 || flat.length % 2) return null;
  const ring = [];
  for (let index = 0; index < flat.length; index += 2) {
    const x = Number(flat[index]);
    const z = Number(flat[index + 1]);
    if (!finite(x) || !finite(z)) return null;
    ring.push({ x, z });
  }
  return ring;
}

function boundsOfRing(ring) {
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const point of ring) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.minZ = Math.min(bounds.minZ, point.z);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.maxZ = Math.max(bounds.maxZ, point.z);
  }
  return bounds;
}

function overlaps(left, right) {
  return left.minX <= right.maxX && left.maxX >= right.minX
    && left.minZ <= right.maxZ && left.maxZ >= right.minZ;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index];
    const b = ring[previous];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function nearestPointOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared))
    : 0;
  return { x: a.x + dx * t, z: a.z + dz * t, dx, dz, lengthSquared };
}

function clippedSegment(a, b, bounds) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let enter = 0;
  let exit = 1;
  for (const [p, q] of [
    [-dx, a.x - bounds.minX], [dx, bounds.maxX - a.x],
    [-dz, a.z - bounds.minZ], [dz, bounds.maxZ - a.z],
  ]) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else exit = Math.min(exit, t);
    if (enter > exit) return null;
  }
  return {
    a: { x: a.x + dx * enter, z: a.z + dz * enter },
    b: { x: a.x + dx * exit, z: a.z + dz * exit },
  };
}

function sourceRecord(cityData) {
  return (cityData?.meta?.sources || []).find((source) => source?.name === FERRY_SHORELINE_SOURCE.name) || null;
}

/**
 * Builds a tile-local union predicate.  This intentionally matches the union
 * rule used by build-realmap-assets.mjs when it retained OSM features inside
 * the shoreline data, so roads/land continue to agree with their source.
 */
export function createFerryHeroShorelineMask(cityData, bounds) {
  if (!bounds || !Object.values(bounds).every(finite)) {
    throw new TypeError('Ferry shoreline mask requires finite local tile bounds.');
  }
  const source = sourceRecord(cityData);
  if (!source || source.url !== FERRY_SHORELINE_SOURCE.url || source.sha256 !== FERRY_SHORELINE_SOURCE.sha256) {
    throw new Error('Ferry shoreline source lock is absent or does not match the embedded DataSF record.');
  }
  const allRings = (cityData?.boundary || []).map(ringFromFlat).filter(Boolean);
  if (!allRings.length) throw new Error('Ferry shoreline source contains no usable projected rings.');
  const tileRings = allRings.filter((ring) => overlaps(boundsOfRing(ring), bounds));
  if (!tileRings.length) throw new Error('Ferry tile does not intersect an authoritative shoreline ring.');
  const ringRecords = tileRings.map((ring) => Object.freeze({
    points: Object.freeze(ring.map((point) => Object.freeze({ ...point }))),
    bounds: Object.freeze(boundsOfRing(ring)),
  }));
  const shorelineSegments = ringRecords.flatMap(({ points }) => points.map((point, index) => (
    clippedSegment(point, points[(index + 1) % points.length], bounds)
  )).filter(Boolean));
  const isLand = (x, z) => finite(x) && finite(z)
    && ringRecords.some(({ points, bounds: ringBounds }) => (
      x >= ringBounds.minX && x <= ringBounds.maxX && z >= ringBounds.minZ && z <= ringBounds.maxZ
        && pointInRing({ x, z }, points)
    ));
  const nearestLandPoint = (x, z, inset = 0.55) => {
    if (isLand(x, z)) return { x, z, clamped: false };
    let nearest = null;
    for (const { points } of ringRecords) {
      for (let index = 0; index < points.length; index += 1) {
        const point = nearestPointOnSegment({ x, z }, points[index], points[(index + 1) % points.length]);
        const distanceSquared = (x - point.x) ** 2 + (z - point.z) ** 2;
        if (!nearest || distanceSquared < nearest.distanceSquared) nearest = { ...point, distanceSquared };
      }
    }
    if (!nearest) return { x, z, clamped: false };
    const length = Math.sqrt(nearest.lengthSquared) || 1;
    const normal = { x: -nearest.dz / length, z: nearest.dx / length };
    const candidates = [
      { x: nearest.x + normal.x * inset, z: nearest.z + normal.z * inset },
      { x: nearest.x - normal.x * inset, z: nearest.z - normal.z * inset },
    ];
    const land = candidates.find((candidate) => isLand(candidate.x, candidate.z));
    return land ? { ...land, clamped: true } : { x, z, clamped: false };
  };
  const sourceBounds = ringRecords.reduce((result, { bounds: ringBounds }) => ({
    minX: Math.min(result.minX, ringBounds.minX),
    minZ: Math.min(result.minZ, ringBounds.minZ),
    maxX: Math.max(result.maxX, ringBounds.maxX),
    maxZ: Math.max(result.maxZ, ringBounds.maxZ),
  }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
  return Object.freeze({
    isLand,
    nearestLandPoint,
    rings: Object.freeze(ringRecords),
    shorelineSegments: Object.freeze(shorelineSegments.map(({ a, b }) => Object.freeze({
      a: Object.freeze({ ...a }), b: Object.freeze({ ...b }),
    }))),
    getDiagnostics: () => ({
      active: true,
      source: { ...FERRY_SHORELINE_SOURCE },
      tileBounds: { ...bounds },
      sourceBounds,
      sourceRingCount: allRings.length,
      tileRingCount: ringRecords.length,
      tileVertexCount: ringRecords.reduce((total, { points }) => total + points.length, 0),
      clippedSegmentCount: shorelineSegments.length,
      classification: 'source-ring-union; all-land grid cells only',
    }),
  });
}
