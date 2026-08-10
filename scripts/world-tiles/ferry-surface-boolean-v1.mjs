/**
 * Deterministic, offline-only Boolean preparation for the Ferry OSM surface
 * preview. This is deliberately not a runtime, navigation, collision, or
 * survey pipeline.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { difference, union, FillRule } from 'clipper2-ts';
import { ShapeUtils, Vector2, REVISION as THREE_REVISION } from 'three';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SURFACE_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-ferry-osm-surfaces-v1/sf-ferry-osm-surfaces-v1.json');
const RAW_PBF_PATH = path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-surface-boolean-v1.lock.json');
const PACKAGE_LOCK_PATH = path.join(ROOT, 'package-lock.json');

export const FERRY_BOOLEAN_V1 = Object.freeze({
  id: 'sf-ferry-surface-boolean-v1',
  status: 'offline-preview-plan-not-for-runtime-or-manifest-promotion',
  coordinateFrame: Object.freeze({
    id: 'sf-atlas-linear-v1', axisOrder: ['east', 'north'], runtimeAxisOrder: ['x', 'z'],
    originMetres: [2304, 1920], gridMetres: 0.001, ticksPerMetre: 1000,
    maxAbsTick: 10_000_000,
    sourceWgs84AnchorLonLatDegrees: [-122.4194, 37.778],
    sourceMetresPerDegreeLonLat: [87986.24747640654, 110574],
  }),
  boolean: Object.freeze({ package: 'clipper2-ts', version: '2.0.1-18', license: 'BSL-1.0', fillRule: 'NonZero' }),
  triangulation: Object.freeze({ package: 'three', version: '0.180.0', revision: THREE_REVISION, api: 'ShapeUtils.triangulateShape', algorithm: 'Earcut-via-three', clipperTriangulation: 'prohibited' }),
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const pointKey = ([x, y]) => `${x},${y}`;
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const comparePoint = (a, b) => a[0] - b[0] || a[1] - b[1];
function comparePaths(a, b) {
  const left = JSON.stringify(a); const right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function roundHalfAwayFromZero(value) {
  assert(Number.isFinite(value), 'Coordinate must be finite');
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

function signedArea2(pathPoints) {
  let result = 0n;
  for (let index = 0; index < pathPoints.length; index += 1) {
    const [ax, ay] = pathPoints[index];
    const [bx, by] = pathPoints[(index + 1) % pathPoints.length];
    result += BigInt(ax) * BigInt(by) - BigInt(bx) * BigInt(ay);
  }
  return result;
}

function orient(a, b, c) {
  return (BigInt(b[0] - a[0]) * BigInt(c[1] - a[1])) - (BigInt(b[1] - a[1]) * BigInt(c[0] - a[0]));
}

function onSegment(a, b, p) {
  return orient(a, b, p) === 0n
    && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

function signsCross(a, b) { return (a < 0n && b > 0n) || (a > 0n && b < 0n); }

function segmentsIntersect(a, b, c, d) {
  const abC = orient(a, b, c); const abD = orient(a, b, d);
  const cdA = orient(c, d, a); const cdB = orient(c, d, b);
  return signsCross(abC, abD) && signsCross(cdA, cdB)
    || abC === 0n && onSegment(a, b, c)
    || abD === 0n && onSegment(a, b, d)
    || cdA === 0n && onSegment(c, d, a)
    || cdB === 0n && onSegment(c, d, b);
}

/** -1 outside, 0 boundary, 1 strictly inside. */
function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[previous]; const b = ring[index];
    if (onSegment(a, b, point)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const left = BigInt(point[0] - a[0]) * BigInt(b[1] - a[1]);
      const right = BigInt(b[0] - a[0]) * BigInt(point[1] - a[1]);
      if ((b[1] > a[1]) ? left < right : left > right) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

function pathEdgesIntersect(a, b) {
  for (let ai = 0; ai < a.length; ai += 1) for (let bi = 0; bi < b.length; bi += 1) {
    if (segmentsIntersect(a[ai], a[(ai + 1) % a.length], b[bi], b[(bi + 1) % b.length])) return true;
  }
  return false;
}

function assertSimpleRing(ring, label) {
  for (let first = 0; first < ring.length; first += 1) for (let second = first + 1; second < ring.length; second += 1) {
    if ((first + 1) % ring.length === second || (second + 1) % ring.length === first) continue;
    assert(!segmentsIntersect(ring[first], ring[(first + 1) % ring.length], ring[second], ring[(second + 1) % ring.length]), `${label} self-intersects`);
  }
}

function rotateCanonical(ring) {
  let start = 0;
  for (let index = 1; index < ring.length; index += 1) if (comparePoint(ring[index], ring[start]) < 0) start = index;
  return ring.slice(start).concat(ring.slice(0, start));
}

/** Removes only exact duplicate terminal/consecutive ticks; no tolerance cleanup. */
export function normalizeRing(input, label = 'ring', desiredWinding = null) {
  assert(Array.isArray(input), `${label} must be an array`);
  const ring = [];
  for (const point of input) {
    assert(Array.isArray(point) && point.length === 2, `${label} points must be [x, z] tick pairs`);
    assert(Number.isSafeInteger(point[0]) && Number.isSafeInteger(point[1]), `${label} coordinates must be safe integers`);
    assert(Math.abs(point[0]) <= FERRY_BOOLEAN_V1.coordinateFrame.maxAbsTick && Math.abs(point[1]) <= FERRY_BOOLEAN_V1.coordinateFrame.maxAbsTick, `${label} exceeds conservative ±${FERRY_BOOLEAN_V1.coordinateFrame.maxAbsTick} tick bound`);
    if (!ring.length || !samePoint(ring.at(-1), point)) ring.push([...point]);
  }
  if (ring.length > 1 && samePoint(ring[0], ring.at(-1))) ring.pop();
  assert(ring.length >= 3, `${label} needs at least three unique vertices after duplicate cleanup`);
  assert(new Set(ring.map(pointKey)).size === ring.length, `${label} repeats a non-consecutive vertex`);
  assertSimpleRing(ring, label);
  const area2 = signedArea2(ring);
  assert(area2 !== 0n, `${label} has zero area after quantization`);
  const wound = desiredWinding === 'ccw' && area2 < 0n || desiredWinding === 'cw' && area2 > 0n ? [...ring].reverse() : ring;
  return rotateCanonical(wound);
}

function assertNoRingOverlap(rings, label) {
  for (let first = 0; first < rings.length; first += 1) for (let second = first + 1; second < rings.length; second += 1) {
    assert(!pathEdgesIntersect(rings[first], rings[second]), `${label} rings ${first} and ${second} touch or cross`);
    assert(pointInRing(rings[first][0], rings[second]) === -1 && pointInRing(rings[second][0], rings[first]) === -1, `${label} rings ${first} and ${second} overlap or contain each other`);
  }
}

/** A validated polygon/multipolygon with explicitly assigned outer and hole rings. */
export function normalizeSurface({ outers, holes = [] }, label = 'surface') {
  assert(Array.isArray(outers) && outers.length, `${label} needs at least one outer ring`);
  const normalizedOuters = outers.map((ring, index) => normalizeRing(ring, `${label} outer ${index}`, 'ccw')).sort(comparePaths);
  const normalizedHoles = holes.map((ring, index) => normalizeRing(ring, `${label} hole ${index}`, 'cw')).sort(comparePaths);
  assertNoRingOverlap(normalizedOuters, `${label} outer`);
  assertNoRingOverlap(normalizedHoles, `${label} hole`);
  for (const [holeIndex, hole] of normalizedHoles.entries()) {
    const owners = normalizedOuters.filter((outer) => pointInRing(hole[0], outer) === 1);
    assert.equal(owners.length, 1, `${label} hole ${holeIndex} must be strictly inside exactly one outer ring`);
    assert(!pathEdgesIntersect(hole, owners[0]), `${label} hole ${holeIndex} touches or crosses its outer ring`);
  }
  return { outers: normalizedOuters, holes: normalizedHoles };
}

function toClipper(paths) { return paths.map((ring) => ring.map(([x, y]) => ({ x, y }))); }
function fromClipper(paths) { return paths.map((ring) => ring.map(({ x, y }) => [x, y])); }

/** Converts clean Clipper paths into canonical outer/hole polygon groups. */
export function classifyBooleanPaths(paths, label = 'Boolean result') {
  const rings = fromClipper(paths).map((ring, index) => normalizeRing(ring, `${label} ring ${index}`));
  const candidates = rings.map((ring, index) => ({ index, ring, absArea: signedArea2(ring) < 0n ? -signedArea2(ring) : signedArea2(ring), parent: null, depth: 0 }));
  for (const candidate of candidates) {
    const parents = candidates.filter((other) => other !== candidate && other.absArea > candidate.absArea && pointInRing(candidate.ring[0], other.ring) === 1);
    if (parents.length) candidate.parent = parents.sort((a, b) => (a.absArea < b.absArea ? -1 : a.absArea > b.absArea ? 1 : a.index - b.index))[0];
  }
  for (const candidate of candidates) {
    let parent = candidate.parent;
    while (parent) { candidate.depth += 1; parent = parent.parent; }
  }
  const outers = candidates.filter((candidate) => candidate.depth % 2 === 0).map((candidate) => ({
    outer: normalizeRing(candidate.ring, `${label} outer`, 'ccw'),
    holes: candidates.filter((other) => other.parent === candidate).map((other) => normalizeRing(other.ring, `${label} hole`, 'cw')).sort(comparePaths),
  })).sort((a, b) => comparePaths(a.outer, b.outer));
  return outers;
}

export function booleanDifference(surface, clips = [], label = 'surface') {
  const prepared = normalizeSurface(surface, label);
  const clipRings = clips.flatMap((clip, index) => {
    const normalized = normalizeSurface(clip, `${label} clip ${index}`);
    return [...normalized.outers, ...normalized.holes];
  });
  const result = difference(toClipper([...prepared.outers, ...prepared.holes]), toClipper(clipRings), FillRule.NonZero);
  return classifyBooleanPaths(result, `${label} difference`);
}

export function booleanNormalize(surface, label = 'surface') {
  const prepared = normalizeSurface(surface, label);
  return classifyBooleanPaths(union(toClipper([...prepared.outers, ...prepared.holes]), FillRule.NonZero), `${label} union`);
}

/** Unions independently validated surfaces; intended for explicit authored precedence policies. */
export function booleanUnion(surfaces, label = 'surface union') {
  assert(Array.isArray(surfaces) && surfaces.length, `${label} needs at least one surface`);
  const rings = surfaces.flatMap((surface, index) => {
    const prepared = normalizeSurface(surface, `${label} member ${index}`);
    return [...prepared.outers, ...prepared.holes];
  });
  return classifyBooleanPaths(union(toClipper(rings), FillRule.NonZero), label);
}

function triangleArea2(a, b, c) { return orient(a, b, c); }

function pointInTriangleStrict(point, triangle) {
  const [a, b, c] = triangle;
  const first = orient(a, b, point); const second = orient(b, c, point); const third = orient(c, a, point);
  return (first > 0n && second > 0n && third > 0n) || (first < 0n && second < 0n && third < 0n);
}

export function triangulatePolygon({ outer, holes = [] }, label = 'polygon') {
  const validated = normalizeSurface({ outers: [outer], holes }, label);
  assert.equal(validated.outers.length, 1, `${label} triangulation accepts exactly one outer ring`);
  const safeOuter = validated.outers[0];
  const safeHoles = validated.holes;
  const contour = safeOuter.map(([x, y]) => new Vector2(x, y));
  const holeVectors = safeHoles.map((hole) => hole.map(([x, y]) => new Vector2(x, y)));
  const vertices = [safeOuter, ...safeHoles].flat();
  const triangles = ShapeUtils.triangulateShape([...contour], holeVectors.map((hole) => [...hole]));
  assert(triangles.length, `${label} Earcut returned no triangles`);
  let triangleArea = 0n;
  for (const indices of triangles) {
    assert.equal(indices.length, 3, `${label} triangulation emitted a non-triangle`);
    const triangle = indices.map((index) => vertices[index]);
    const area2 = triangleArea2(...triangle);
    assert(area2 !== 0n, `${label} triangulation emitted a degenerate triangle`);
    triangleArea += area2 < 0n ? -area2 : area2;
    for (const hole of safeHoles) for (const point of hole) assert(!pointInTriangleStrict(point, triangle), `${label} triangle covers a hole vertex`);
  }
  const polygonArea = signedArea2(safeOuter) - safeHoles.reduce((sum, hole) => sum + (signedArea2(hole) < 0n ? -signedArea2(hole) : signedArea2(hole)), 0n);
  assert.equal(triangleArea, polygonArea, `${label} triangle area does not equal polygon area`);
  return { vertices, triangles, area2: polygonArea.toString() };
}

function lonLatToTicks([lon, lat]) {
  const { originMetres, ticksPerMetre, sourceWgs84AnchorLonLatDegrees, sourceMetresPerDegreeLonLat } = FERRY_BOOLEAN_V1.coordinateFrame;
  const east = (lon - sourceWgs84AnchorLonLatDegrees[0]) * sourceMetresPerDegreeLonLat[0];
  const north = (lat - sourceWgs84AnchorLonLatDegrees[1]) * sourceMetresPerDegreeLonLat[1];
  return [roundHalfAwayFromZero((east - originMetres[0]) * ticksPerMetre), roundHalfAwayFromZero((north - originMetres[1]) * ticksPerMetre)];
}

function sourceRecordToSurface(record) {
  return {
    outers: record.geometry.rings.map((ring) => ring.coordinatesLonLat.map(lonLatToTicks)),
    holes: record.geometry.holes.map((ring) => ring.coordinatesLonLat.map(lonLatToTicks)),
  };
}

function polygonOutput(polygon, label) {
  const triangulation = triangulatePolygon(polygon, label);
  return { outer: polygon.outer, holes: polygon.holes, triangulation };
}

/** The static contract is separately exported so the verifier can reject lock drift directly. */
export function assertStaticLockContract(lock) {
  assert.deepEqual(lock.coordinateContract, {
    frame: FERRY_BOOLEAN_V1.coordinateFrame.id,
    axisOrder: FERRY_BOOLEAN_V1.coordinateFrame.axisOrder,
    runtimeAxisOrder: FERRY_BOOLEAN_V1.coordinateFrame.runtimeAxisOrder,
    originMetres: FERRY_BOOLEAN_V1.coordinateFrame.originMetres,
    gridMetres: FERRY_BOOLEAN_V1.coordinateFrame.gridMetres,
    ticksPerMetre: FERRY_BOOLEAN_V1.coordinateFrame.ticksPerMetre,
    maxAbsTick: FERRY_BOOLEAN_V1.coordinateFrame.maxAbsTick,
    sourceWgs84AnchorLonLatDegrees: FERRY_BOOLEAN_V1.coordinateFrame.sourceWgs84AnchorLonLatDegrees,
    sourceMetresPerDegreeLonLat: FERRY_BOOLEAN_V1.coordinateFrame.sourceMetresPerDegreeLonLat,
    quantization: 'sign(v) * floor(abs(v) + 0.5), after WGS84-to-shared-local projection',
    winding: { outer: 'CCW', hole: 'CW' }, fillRule: FERRY_BOOLEAN_V1.boolean.fillRule,
  }, 'Ferry Boolean coordinate contract drifted from the source lock');
  assert.deepEqual(FERRY_BOOLEAN_V1.boolean, {
    package: lock.toolchain.clipper2Ts.package, version: lock.toolchain.clipper2Ts.version,
    license: lock.toolchain.clipper2Ts.license, fillRule: lock.coordinateContract.fillRule,
  }, 'Ferry Boolean operation contract drifted from the source lock');
  assert.deepEqual(FERRY_BOOLEAN_V1.triangulation, {
    package: lock.toolchain.three.package, version: lock.toolchain.three.version, revision: lock.toolchain.three.revision,
    api: lock.toolchain.three.api, algorithm: lock.toolchain.three.algorithm, clipperTriangulation: lock.toolchain.clipper2Ts.triangulation,
  }, 'Ferry triangulation contract drifted from the source lock');
}

export async function buildFerrySurfaceBooleanPlan({ sourcePath = SURFACE_PATH, rawPbfPath = RAW_PBF_PATH, lockPath = LOCK_PATH } = {}) {
  const [sourceBytes, rawPbfBytes, lockBytes, packageLockBytes] = await Promise.all([readFile(sourcePath), readFile(rawPbfPath), readFile(lockPath), readFile(PACKAGE_LOCK_PATH)]);
  const source = JSON.parse(sourceBytes); const lock = JSON.parse(lockBytes);
  assert.equal(sha256(sourceBytes), lock.inputs.surfaceArtifact.sha256, 'Ferry OSM surface artifact hash does not match Boolean source lock');
  assert.equal(rawPbfBytes.length, lock.inputs.rawPbf.bytes, 'Raw Ferry PBF byte count does not match Boolean source lock');
  assert.equal(sha256(rawPbfBytes), lock.inputs.rawPbf.sha256, 'Raw Ferry PBF hash does not match Boolean source lock');
  assert.equal(sha256(packageLockBytes), lock.toolchain.packageLock.sha256, 'package-lock.json hash does not match Boolean source lock');
  const packageLock = JSON.parse(packageLockBytes);
  const clipper = packageLock.packages?.['node_modules/clipper2-ts'];
  assert.deepEqual({ version: clipper?.version, integrity: clipper?.integrity, license: clipper?.license }, {
    version: lock.toolchain.clipper2Ts.version, integrity: lock.toolchain.clipper2Ts.integrity, license: lock.toolchain.clipper2Ts.license,
  }, 'clipper2-ts package-lock provenance drifted');
  assert.equal(packageLock.packages?.['']?.devDependencies?.['clipper2-ts'], lock.toolchain.clipper2Ts.version, 'clipper2-ts must remain an exact devDependency');
  assert.equal(process.versions.node, lock.toolchain.node, 'Node version differs from the locked offline Boolean toolchain');
  assert.equal(THREE_REVISION, lock.toolchain.three.revision, 'Three.js revision differs from the locked triangulation toolchain');
  assertStaticLockContract(lock);
  const records = source.surfaceRecords.map((record) => {
    const normalized = booleanNormalize(sourceRecordToSurface(record), record.recordId);
    return { recordId: record.recordId, source: { type: record.source.type, id: record.source.id }, materialFamily: record.materialFamily, polygons: normalized.map((polygon, index) => polygonOutput(polygon, `${record.recordId} polygon ${index}`)) };
  });
  const plan = {
    schemaVersion: 1, id: FERRY_BOOLEAN_V1.id, status: FERRY_BOOLEAN_V1.status, previewOnly: true,
    scope: { runtimePlacement: 'none', manifestPromotion: 'prohibited', collision: 'none', navigation: 'none', productionUse: 'prohibited' },
    coordinateFrame: FERRY_BOOLEAN_V1.coordinateFrame, boolean: FERRY_BOOLEAN_V1.boolean, triangulation: FERRY_BOOLEAN_V1.triangulation,
    inputs: { surfaceArtifact: { path: path.relative(ROOT, sourcePath).split(path.sep).join('/'), sha256: sha256(sourceBytes) }, rawPbf: { path: path.relative(ROOT, rawPbfPath).split(path.sep).join('/'), bytes: rawPbfBytes.length, sha256: sha256(rawPbfBytes) } },
    ownership: { policy: 'none', note: 'This foundation preserves source records independently. OSM renderOrder is not treated as an overlap-ownership rule.' },
    records,
  };
  return { plan, bytes: canonicalBytes(plan), lock };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildFerrySurfaceBooleanPlan();
  process.stdout.write(`${JSON.stringify({ result: 'Ferry offline Boolean foundation prepared', planSha256: sha256(result.bytes), records: result.plan.records.length, previewOnly: true }, null, 2)}\n`);
}
