/**
 * Deterministically bake the first native UTM SF production tile.
 *
 * The geometry is emitted as standards-compliant GLB with Three.js axes
 * (x=east, y=up, z=north). OSM is used only for two-dimensional plan geometry;
 * every height is sampled from the byte-locked USGS 3DEP GeoTIFF.
 *
 * Usage: node scripts/world-tiles/build-ferry-production-tile-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import parse from 'osm-pbf-parser';
import through from 'through2';
import { ShapeUtils, Vector2 } from 'three';
import { FillRule, triangulate as triangulateClipper, trimCollinear, union as unionClipper } from 'clipper2-ts';
import { booleanDifference, booleanUnion, classifyBooleanPaths, triangulatePolygon } from './ferry-surface-boolean-v1.mjs';
import { openGeoTiffWindowReader } from './geotiff-window-reader-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PBF_PATH = path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf');
const HORIZONTAL_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json');
const GEOMETRY_AUTH_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-osm-horizontal-geometry-v1.lock.json');
const NATIVE_PIXEL_AUTH_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-production-authorization-v1.lock.json');
const TERRAIN_SOURCES = [
  ['x55y419', 10, true, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json', 'public/data/world/source-locks/sf-ferry-3dep-terrain-elevation-authorized-v1.lock.json'],
  ['x54y419', 10, true, 'public/data/world/source-locks/sf-3dep-ca-sanfrancisco-b23-x54y419-v1.lock.json', 'public/data/world/source-locks/sf-3dep-ca-sanfrancisco-b23-x54y419-elevation-authorized-v1.lock.json'],
  ['x54y418', 10, true, 'public/data/world/source-locks/sf-3dep-ca-sanfrancisco-b23-x54y418-v1.lock.json', 'public/data/world/source-locks/sf-3dep-ca-sanfrancisco-b23-x54y418-elevation-authorized-v1.lock.json'],
  ['x55y418', 10, true, 'public/data/world/source-locks/sf-3dep-ca-sanfrancisco-b23-x55y418-v1.lock.json', 'public/data/world/source-locks/sf-3dep-ca-sanfrancisco-b23-x55y418-elevation-authorized-v1.lock.json'],
  ['californiagaps-x54y418', 5, false, 'public/data/world/source-locks/sf-3dep-ca-californiagaps-b23-x54y418-v1.lock.json', 'public/data/world/source-locks/sf-3dep-ca-californiagaps-b23-x54y418-elevation-authorized-v1.lock.json'],
  ['californiagaps-x55y418', 5, false, 'public/data/world/source-locks/sf-3dep-ca-californiagaps-b23-x55y418-v1.lock.json', 'public/data/world/source-locks/sf-3dep-ca-californiagaps-b23-x55y418-elevation-authorized-v1.lock.json'],
].map(([label, priority, productionEligible, sourceLockPath, elevationLockPath], sourceOrder) => ({ label, priority, productionEligible, sourceOrder, sourceLockPath: path.join(ROOT, sourceLockPath), elevationLockPath: path.join(ROOT, elevationLockPath) }));
const FERRY_OUTPUT_DIR = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const METRIC_TILE_OUTPUT_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
// OSM ways are node-referenced. A building or long road segment can cross the
// 16 m production buffer while every authored node remains farther away. Use a
// wider discovery envelope, then let the exact tile clippers decide ownership.
const FEATURE_DISCOVERY_BUFFER_METRES = 128;
const FERRY_TILE = Object.freeze({ id: 'epsg26910-1441-10893', minE: 553344, minN: 4182912, size: 384, originH: 0, sourceBuffer: 16 });
let TILE = FERRY_TILE;
let buildSfMetricTileQueue = Promise.resolve();
const TERRAIN_STEP = 1;
const PROVISIONAL_FRAME = 'provisional-utm-source-declared-navd88-unrealized';
const RETRIEVED_AT = '2026-08-02';
const DEFAULT_TERRAIN_SELECTION_MODE = 'production-cell-owned-v1';
const NATIVE_PIXEL_FALLBACK_PROOF_MODE = 'per-native-pixel-fallback-proof-v1';
const NATIVE_PIXEL_FALLBACK_PRODUCTION_MODE = 'per-native-pixel-fallback-production-v1';
const TERRAIN_SELECTION_MODES = new Set([DEFAULT_TERRAIN_SELECTION_MODE, NATIVE_PIXEL_FALLBACK_PROOF_MODE, NATIVE_PIXEL_FALLBACK_PRODUCTION_MODE]);
const NATIVE_PIXEL_SELECTION_POLICY = Object.freeze({
  name: 'source-locked-original-first-per-native-pixel-v1',
  candidateOrder: 'original-before-californiagaps',
  fallbackCondition: 'original-native-pixel-is-nodata',
  sampleMethod: 'direct-native-pixel-float32-le',
  interpolation: 'none',
});
// A 12 cm paved surface keeps long, terrain-following road ribbons above the
// sampled ground without changing their authoritative plan geometry.
const ROAD_LIFT = 0.12;
const COAST_EDGE_HALF_HEIGHT = 0.06;
const SURFACE_TICKS_PER_METRE = 1000;
const PBF_SHA256 = 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae';

function tileFromGrid(gridEasting, gridNorthing) {
  assert(Number.isInteger(gridEasting) && Number.isInteger(gridNorthing), 'Tile grid coordinates must be integers');
  return Object.freeze({ id: `epsg26910-${gridEasting}-${gridNorthing}`, minE: gridEasting * 384, minN: gridNorthing * 384, size: 384, originH: 0, sourceBuffer: 16 });
}

function normalizeTile(tile) {
  if (!tile) return FERRY_TILE;
  if (Number.isInteger(tile.gridEasting) && Number.isInteger(tile.gridNorthing)) return tileFromGrid(tile.gridEasting, tile.gridNorthing);
  assert.equal(tile.size, 384, 'Only 384 m metric tiles are supported');
  assert.equal(tile.minE / 384, Math.round(tile.minE / 384), 'Tile minE must lie on the 384 m grid');
  assert.equal(tile.minN / 384, Math.round(tile.minN / 384), 'Tile minN must lie on the 384 m grid');
  return tileFromGrid(tile.minE / 384, tile.minN / 384);
}

function defaultOutputDir(tile) {
  return tile.id === FERRY_TILE.id ? FERRY_OUTPUT_DIR : path.join(METRIC_TILE_OUTPUT_ROOT, tile.id);
}

function artifactStem(tile) {
  return tile.id === FERRY_TILE.id ? 'ferry-production-tile-v1' : tile.id;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stableBytes = (value) => Buffer.from(JSON.stringify(value));
const NATIVE_PIXEL_SELECTION_POLICY_HASH = `sha256:${sha256(stableBytes(NATIVE_PIXEL_SELECTION_POLICY))}`;
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const q = (value) => Math.round(value * 1e6) / 1e6;
const sortedTags = (tags = {}) => Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Validate the checked-in per-pixel ownership authorization against the exact
 * source-lock bytes it names.  This is intentionally fail-closed and is used
 * by the future production mode before it can ever write an artifact.  The
 * authorization currently records productionWriteEnabled=false while the
 * source-aware seam parity gate remains pending.
 */
export async function loadSfNativePixelFallbackAuthorization({ requireProductionWrite = false } = {}) {
  const authorizationBytes = await readFile(NATIVE_PIXEL_AUTH_PATH);
  const authorization = JSON.parse(authorizationBytes);
  assert.equal(Buffer.compare(authorizationBytes, jsonBytes(authorization)), 0, 'Native-pixel authorization JSON must be canonical byte-for-byte');
  assert.equal(authorization.schemaVersion, 1, 'Native-pixel authorization schema drifted');
  assert.equal(authorization.kind, 'sf-native-pixel-terrain-ownership-authorization', 'Native-pixel authorization kind drifted');
  assert.equal(authorization.verticalCertification, 'source-declared-navd88-unrealized', 'Native-pixel authorization vertical certification drifted');
  assert.equal(authorization.policy?.name, NATIVE_PIXEL_SELECTION_POLICY.name, 'Native-pixel ownership policy name drifted');
  assert.equal(authorization.policy?.sha256, NATIVE_PIXEL_SELECTION_POLICY_HASH, 'Native-pixel ownership policy hash drifted');
  assert.deepEqual(authorization.policy?.definition, NATIVE_PIXEL_SELECTION_POLICY, 'Native-pixel ownership policy definition drifted');
  assert.equal(authorization.ownership?.nativePixelRule, 'direct-native-pixel-float32-le', 'Native-pixel rule drifted');
  assert.equal(authorization.ownership?.fallbackCause, 'original-native-pixel-is-nodata', 'Native-pixel fallback cause drifted');
  assert.equal(authorization.ownership?.interpolation, 'none', 'Native-pixel ownership must reject interpolation');
  assert.equal(authorization.ownership?.cellBoundaryRule, 'half-open EPSG:26910 10000m cells; exact boundary belongs west/south via 1e-7m epsilon', 'Native-pixel cell ownership rule drifted');
  assert.equal(authorization.evidence?.verticalCertification, 'source-declared-navd88-unrealized', 'Native-pixel evidence vertical certification drifted');
  assert.deepEqual(authorization.evidence?.requiredPerSourceCounts, ['chosenCount', 'finiteCount', 'noDataCount', 'nonFiniteCount', 'outsideWindowCount'], 'Native-pixel evidence count contract drifted');
  assert.deepEqual(authorization.evidence?.requiredDisagreementStatistics, ['bothFiniteSourceComparisons', 'maxBothFiniteDisagreementMetres', 'p99BothFiniteDisagreementMetres'], 'Native-pixel disagreement evidence contract drifted');
  assert.deepEqual(authorization.evidence?.requiredSampleFields, ['sourceLockId', 'elevationSourceLockId', 'rasterSha256', 'nativePixel', 'sampledSourceDeclaredNavd88UnrealizedMetres', 'fallbackOriginalReason'], 'Native-pixel sample evidence contract drifted');
  assert.equal(authorization.evidence?.sampleLedgerDigest, 'sha256-stable-json-over-sorted-sample-records-v1', 'Native-pixel sample-ledger digest contract drifted');
  assert.equal(authorization.evidence?.seamComparisonRule, 'same-source authority plus exact float32 bits; cross-source authority requires exact float32 bits', 'Native-pixel seam comparison rule drifted');
  assert.deepEqual(authorization.evidence?.seamCounts, ['sameSourceSamples', 'crossSourceSamples'], 'Native-pixel seam accounting contract drifted');
  assert.equal(typeof authorization.productionWriteEnabled, 'boolean', 'Native-pixel authorization must explicitly gate production writes');
  assert.equal(authorization.promotionGate?.requiredTileCount, 25, 'Native-pixel promotion tile count drifted');
  if (requireProductionWrite) {
    assert.equal(authorization.productionWriteEnabled, true, 'Native-pixel production write is not enabled by its authorization');
    assert.equal(authorization.status, 'byte-locked-source-policy-and-seam-parity-production-authorized', 'Native-pixel authorization has not reached its terminal production status');
    assert.equal(authorization.promotionGate?.status, 'passed', 'Native-pixel source-aware seam parity has not passed');
    assert.match(authorization.promotionGate?.evidenceReceiptSha256 ?? '', /^sha256:[a-f0-9]{64}$/, 'Native-pixel promotion evidence receipt is not byte-locked');
  }

  const terrainDescriptors = await Promise.all(TERRAIN_SOURCES.map(async (descriptor) => {
    const sourceLock = JSON.parse(await readFile(descriptor.sourceLockPath));
    const bounds = sourceLock.raster.gridEnvelope.modelBoundsAtPixelIsAreaEdges;
    return { descriptor, sourceLock, cellKey: terrainCellKey((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2) };
  }));
  const descriptorsByCell = new Map();
  for (const item of terrainDescriptors) {
    const group = descriptorsByCell.get(item.cellKey) ?? [];
    group.push(item); descriptorsByCell.set(item.cellKey, group);
  }
  const fallbackCells = new Set([...descriptorsByCell].filter(([, group]) => group.some(({ descriptor }) => !descriptor.productionEligible)).map(([cellKey]) => cellKey));
  const expectedSources = terrainDescriptors.filter(({ cellKey }) => fallbackCells.has(cellKey));
  assert.equal(authorization.sources?.length, expectedSources.length, 'Native-pixel authorization must bind each original/fallback source pair');
  const recordsBySourceLockId = new Map();
  for (const record of authorization.sources) {
    assert(record.sourceLock?.path && record.sourceLock?.sha256 && record.sourceLock?.id, 'Native-pixel authorization source lock binding is incomplete');
    assert(record.elevationAuthorization?.path && record.elevationAuthorization?.sha256 && record.elevationAuthorization?.id, 'Native-pixel authorization elevation lock binding is incomplete');
    const sourceLockPath = path.resolve(ROOT, record.sourceLock.path);
    const elevationLockPath = path.resolve(ROOT, record.elevationAuthorization.path);
    const [sourceLockBytes, elevationLockBytes] = await Promise.all([readFile(sourceLockPath), readFile(elevationLockPath)]);
    assert.equal(record.sourceLock.sha256, `sha256:${sha256(sourceLockBytes)}`, `Native-pixel source lock bytes drifted for ${record.sourceLock.id}`);
    assert.equal(record.elevationAuthorization.sha256, `sha256:${sha256(elevationLockBytes)}`, `Native-pixel elevation authorization bytes drifted for ${record.elevationAuthorization.id}`);
    const sourceLock = JSON.parse(sourceLockBytes); const elevationLock = JSON.parse(elevationLockBytes);
    assert.equal(sourceLock.id, record.sourceLock.id, 'Native-pixel source lock id drifted');
    assert.equal(elevationLock.id, record.elevationAuthorization.id, 'Native-pixel elevation authorization id drifted');
    assert.equal(elevationLock.sourceLock?.id, sourceLock.id, `Native-pixel elevation authorization source id drifted for ${sourceLock.id}`);
    assert.equal(elevationLock.sourceLock?.sha256, sha256(sourceLockBytes), `Native-pixel elevation authorization source hash drifted for ${sourceLock.id}`);
    assert.equal(elevationLock.sourceRaster?.sha256, sourceLock.raster?.sha256, `Native-pixel elevation raster hash drifted for ${sourceLock.id}`);
    assert.equal(record.rasterSha256, `sha256:${sourceLock.raster?.sha256}`, `Native-pixel raster hash binding drifted for ${sourceLock.id}`);
    assert(!recordsBySourceLockId.has(sourceLock.id), `Native-pixel source lock duplicated: ${sourceLock.id}`);
    recordsBySourceLockId.set(sourceLock.id, Object.freeze({ record, sourceLock, elevationLock }));
  }
  for (const { descriptor, sourceLock, cellKey } of expectedSources) {
    assert(recordsBySourceLockId.has(sourceLock.id), `Native-pixel authorization omitted ${sourceLock.id}`);
    const record = recordsBySourceLockId.get(sourceLock.id).record;
    assert.equal(record.role, descriptor.productionEligible ? 'original' : 'californiagaps-fallback', `Native-pixel source role drifted for ${sourceLock.id}`);
    assert.equal(record.cellKey, cellKey, `Native-pixel source cell drifted for ${sourceLock.id}`);
  }
  return Object.freeze({ authorization, authorizationBytes, authorizationSha256: `sha256:${sha256(authorizationBytes)}` });
}

async function sha256File(filePath) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filePath)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

function terrainFileIdentity(pathname, fileStat) {
  return Object.freeze({ pathname, device: fileStat.dev, inode: fileStat.ino, size: fileStat.size, mtimeNs: fileStat.mtimeNs, ctimeNs: fileStat.ctimeNs });
}

function assertSameTerrainFileIdentity(expected, actual, phase) {
  assert.deepEqual(actual, expected, `Verified terrain source identity changed ${phase}: ${expected.pathname}`);
}

export async function hashVerifiedTerrainSourceFile(pathname, { hashFile = sha256File, statFile = stat } = {}) {
  const before = terrainFileIdentity(pathname, await statFile(pathname, { bigint: true }));
  const raw = await hashFile(pathname);
  const after = terrainFileIdentity(pathname, await statFile(pathname, { bigint: true }));
  assertSameTerrainFileIdentity(before, after, 'while hashing');
  return Object.freeze({ ...raw, fileIdentity: after });
}

export async function assertVerifiedTerrainSourceUnchanged(verifiedTerrainDigest, { pathname = verifiedTerrainDigest.fileIdentity?.pathname, statFile = stat, phase = 'before opening' } = {}) {
  const expected = verifiedTerrainDigest.fileIdentity;
  assert(expected && Object.isFrozen(expected), 'Verified terrain digest file identity must be immutable');
  assert.equal(expected.pathname, pathname, 'Verified terrain digest pathname drifted from selected source');
  assertSameTerrainFileIdentity(expected, terrainFileIdentity(pathname, await statFile(pathname, { bigint: true })), phase);
}

async function scanPbf(onItems) {
  await new Promise((resolve, reject) => fs.createReadStream(PBF_PATH).pipe(parse()).pipe(through.obj((items, _encoding, callback) => {
    try { onItems(items); callback(); } catch (error) { callback(error); }
  })).on('finish', resolve).on('error', reject));
}

function forward(lonDegrees, latDegrees, lock) {
  const projection = lock.claims.operation.authorityPath[1];
  const p = projection.parameters; const { semiMajorAxisMetres: a, inverseFlattening } = projection.ellipsoidFromEpsg4269;
  const f = 1 / inverseFlattening; const e2 = f * (2 - f); const ep2 = e2 / (1 - e2); const radians = Math.PI / 180;
  const phi = latDegrees * radians; const lon0 = p.longitudeOfNaturalOriginDegrees * radians;
  const sin = Math.sin(phi); const cos = Math.cos(phi); const tan = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * sin ** 2); const t = tan ** 2; const c = ep2 * cos ** 2; const aa = cos * (lonDegrees * radians - lon0);
  const m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  return [p.falseEastingMetres + p.scaleFactor * n * (aa + (1 - t + c) * aa ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120),
    p.falseNorthingMetres + p.scaleFactor * (m + n * tan * (aa ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720))];
}

function inverse(easting, northing, lock) {
  const projection = lock.claims.operation.authorityPath[1]; const p = projection.parameters;
  const { semiMajorAxisMetres: a, inverseFlattening } = projection.ellipsoidFromEpsg4269;
  const f = 1 / inverseFlattening; const e2 = f * (2 - f); const ep2 = e2 / (1 - e2); const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const m = (northing - p.falseNorthingMetres) / p.scaleFactor; const mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + 151 * e1 ** 3 / 96 * Math.sin(6 * mu) + 1097 * e1 ** 4 / 512 * Math.sin(8 * mu);
  const sin = Math.sin(phi1); const cos = Math.cos(phi1); const tan = Math.tan(phi1); const n1 = a / Math.sqrt(1 - e2 * sin ** 2); const r1 = a * (1 - e2) / (1 - e2 * sin ** 2) ** 1.5;
  const t1 = tan ** 2; const c1 = ep2 * cos ** 2; const d = (easting - p.falseEastingMetres) / (n1 * p.scaleFactor);
  const lat = phi1 - n1 * tan / r1 * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24 + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720);
  const lon = p.longitudeOfNaturalOriginDegrees * Math.PI / 180 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / cos;
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

async function readOsmFeatures(horizontalLock, featureCache = null) {
  const corners = [[TILE.minE - FEATURE_DISCOVERY_BUFFER_METRES, TILE.minN - FEATURE_DISCOVERY_BUFFER_METRES], [TILE.minE + TILE.size + FEATURE_DISCOVERY_BUFFER_METRES, TILE.minN + TILE.size + FEATURE_DISCOVERY_BUFFER_METRES]].map(([e, n]) => inverse(e, n, horizontalLock));
  const bounds = { west: Math.min(...corners.map((v) => v[0])), east: Math.max(...corners.map((v) => v[0])), south: Math.min(...corners.map((v) => v[1])), north: Math.max(...corners.map((v) => v[1])) };
  if (featureCache) {
    const features = featureCache.filter(({ lonLat }) => lonLat.some(([lon, lat]) => lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north));
    return { bounds, features };
  }
  const nearbyNodeIds = new Set();
  await scanPbf((items) => { for (const item of items) if (item.type === 'node' && item.lon >= bounds.west && item.lon <= bounds.east && item.lat >= bounds.south && item.lat <= bounds.north) nearbyNodeIds.add(item.id); });
  const ways = new Map(); const requiredNodeIds = new Set();
  await scanPbf((items) => { for (const item of items) {
    if (item.type !== 'way' || (!item.tags?.highway && !item.tags?.building && item.tags?.natural !== 'coastline') || !item.refs.some((id) => nearbyNodeIds.has(id))) continue;
    ways.set(item.id, { id: item.id, tags: sortedTags(item.tags), refs: [...item.refs] }); for (const id of item.refs) requiredNodeIds.add(id);
  } });
  const nodes = new Map();
  await scanPbf((items) => { for (const item of items) if (item.type === 'node' && requiredNodeIds.has(item.id)) nodes.set(item.id, { lon: item.lon, lat: item.lat }); });
  assert.equal(nodes.size, requiredNodeIds.size, 'Selected OSM way has an unresolved node');
  const features = [...ways.values()].map((way) => ({ ...way, en: way.refs.map((id) => forward(nodes.get(id).lon, nodes.get(id).lat, horizontalLock)), lonLat: way.refs.map((id) => [nodes.get(id).lon, nodes.get(id).lat]) }))
    .sort((a, b) => a.id - b.id);
  return { bounds, features };
}

export async function loadSfMetricSharedInputs() {
  const [pbfHash, horizontalLockBytes, geometryAuthBytes] = await Promise.all([sha256File(PBF_PATH), readFile(HORIZONTAL_LOCK_PATH), readFile(GEOMETRY_AUTH_PATH)]);
  assert.equal(pbfHash.sha256, PBF_SHA256, 'OSM PBF hash mismatch');
  const horizontalLock = JSON.parse(horizontalLockBytes);
  const ways = new Map(); const requiredNodeIds = new Set();
  await scanPbf((items) => { for (const item of items) {
    if (item.type !== 'way' || (!item.tags?.highway && !item.tags?.building && item.tags?.natural !== 'coastline')) continue;
    ways.set(item.id, { id: item.id, tags: sortedTags(item.tags), refs: [...item.refs] });
    for (const id of item.refs) requiredNodeIds.add(id);
  } });
  const nodes = new Map();
  await scanPbf((items) => { for (const item of items) if (item.type === 'node' && requiredNodeIds.has(item.id)) nodes.set(item.id, { lon: item.lon, lat: item.lat }); });
  assert.equal(nodes.size, requiredNodeIds.size, 'Cached eligible OSM way has an unresolved node');
  const osmFeatureCache = [...ways.values()].map((way) => ({ ...way, en: way.refs.map((id) => forward(nodes.get(id).lon, nodes.get(id).lat, horizontalLock)), lonLat: way.refs.map((id) => [nodes.get(id).lon, nodes.get(id).lat]) })).sort((a, b) => a.id - b.id);
  return Object.freeze({ pbfHash, horizontalLockBytes, geometryAuthBytes, horizontalLock, osmFeatureCache });
}

/**
 * Hash every locked GeoTIFF once for a single verifier process. The returned
 * metadata is deliberately data-only and frozen: callers may reuse it across
 * rebuilds, but cannot make a later rebuild observe a different digest.
 */
export async function loadSfMetricVerifiedTerrainSourceDigests() {
  const digests = await Promise.all(TERRAIN_SOURCES.map(async ({ sourceLockPath }) => {
    const sourceLock = JSON.parse(await readFile(sourceLockPath));
    const raw = await hashVerifiedTerrainSourceFile(path.join(ROOT, sourceLock.raster.localRawCache));
    assert.equal(raw.bytes, sourceLock.raster.bytes, `GeoTIFF byte count does not match lock ${sourceLock.id}`);
    assert.equal(raw.sha256, sourceLock.raster.sha256, `GeoTIFF hash does not match lock ${sourceLock.id}`);
    return Object.freeze({ path: sourceLock.raster.localRawCache, bytes: raw.bytes, sha256: raw.sha256, fileIdentity: raw.fileIdentity });
  }));
  assert.equal(new Set(digests.map(({ path: rawPath }) => rawPath)).size, digests.length, 'Terrain digest memo has duplicate raster paths');
  return Object.freeze(digests);
}

function verifiedTerrainDigestFor(sourceLock, verifiedTerrainSourceDigests) {
  if (verifiedTerrainSourceDigests === null) return null;
  assert(Object.isFrozen(verifiedTerrainSourceDigests), 'Verified terrain digest memo must be immutable');
  const matches = verifiedTerrainSourceDigests.filter(({ path: rawPath }) => rawPath === sourceLock.raster.localRawCache);
  assert.equal(matches.length, 1, `Verified terrain digest memo must contain exactly one entry for locked GeoTIFF ${sourceLock.id}`);
  const verified = matches[0];
  assert(Object.isFrozen(verified), `Verified terrain digest memo entry for ${sourceLock.id} must be immutable`);
  assert.equal(verified.path, sourceLock.raster.localRawCache, `Verified terrain digest path drifted from lock ${sourceLock.id}`);
  assert.equal(verified.bytes, sourceLock.raster.bytes, `Verified terrain digest byte count drifted from lock ${sourceLock.id}`);
  assert.equal(verified.sha256, sourceLock.raster.sha256, `Verified terrain digest hash drifted from lock ${sourceLock.id}`);
  assert(verified.fileIdentity && Object.isFrozen(verified.fileIdentity), `Verified terrain digest file identity for ${sourceLock.id} must be immutable`);
  return verified;
}

async function openTerrain(sourceLock, rasterSha256, elevationLock, descriptor, regionBounds, verifiedTerrainDigest = null, { allowNoData = false } = {}) {
  const rawPath = path.join(ROOT, sourceLock.raster.localRawCache);
  const raw = verifiedTerrainDigest ?? await sha256File(rawPath);
  assert.equal(raw.path ?? sourceLock.raster.localRawCache, sourceLock.raster.localRawCache, `GeoTIFF path does not match lock ${sourceLock.id}`);
  assert.equal(raw.sha256, sourceLock.raster.sha256, `GeoTIFF hash does not match lock ${sourceLock.id}`); assert.equal(raw.bytes, sourceLock.raster.bytes, `GeoTIFF byte count does not match lock ${sourceLock.id}`);
  if (verifiedTerrainDigest) await assertVerifiedTerrainSourceUnchanged(verifiedTerrainDigest, { pathname: rawPath });
  let reader;
  try {
    reader = await openGeoTiffWindowReader(rawPath); const rasterBounds = sourceLock.raster.gridEnvelope.modelBoundsAtPixelIsAreaEdges;
    if (regionBounds[0] < rasterBounds[0] || regionBounds[1] < rasterBounds[1] || regionBounds[2] > rasterBounds[2] || regionBounds[3] > rasterBounds[3]) {
      await reader.close(); reader = null;
      if (verifiedTerrainDigest) await assertVerifiedTerrainSourceUnchanged(verifiedTerrainDigest, { pathname: rawPath, phase: 'after rejected coverage window' });
      return null;
    }
    if (!allowNoData) {
      const validationTopLeft = reader.modelToPixel(regionBounds[0], regionBounds[3]); const validationBottomRight = reader.modelToPixel(regionBounds[2], regionBounds[1]);
      const validationColumn = Math.max(0, Math.floor(validationTopLeft.column)); const validationRow = Math.max(0, Math.floor(validationTopLeft.row)); const validationRight = Math.min(reader.metadata.width, Math.ceil(validationBottomRight.column) + 1); const validationBottom = Math.min(reader.metadata.height, Math.ceil(validationBottomRight.row) + 1);
      const validationWindow = await reader.readWindow({ column: validationColumn, row: validationRow, width: validationRight - validationColumn, height: validationBottom - validationRow });
      if (!validationWindow.values.every((value) => value !== validationWindow.nodata && Number.isFinite(value))) {
        await reader.close(); reader = null;
        if (verifiedTerrainDigest) await assertVerifiedTerrainSourceUnchanged(verifiedTerrainDigest, { pathname: rawPath, phase: 'after rejected no-data window' });
        return null;
      }
    }
    const clippedBounds = [Math.max(TILE.minE - TILE.sourceBuffer - 2, rasterBounds[0]), Math.max(TILE.minN - TILE.sourceBuffer - 2, rasterBounds[1]), Math.min(TILE.minE + TILE.size + TILE.sourceBuffer + 2, rasterBounds[2]), Math.min(TILE.minN + TILE.size + TILE.sourceBuffer + 2, rasterBounds[3])];
    assert(clippedBounds[0] < clippedBounds[2] && clippedBounds[1] < clippedBounds[3], `Terrain source ${sourceLock.id} does not overlap ${TILE.id}`);
    const a = reader.modelToPixel(clippedBounds[0], clippedBounds[3]); const b = reader.modelToPixel(clippedBounds[2], clippedBounds[1]);
    const column = Math.max(0, Math.floor(a.column)); const row = Math.max(0, Math.floor(a.row)); const right = Math.min(reader.metadata.width, Math.ceil(b.column) + 1); const bottom = Math.min(reader.metadata.height, Math.ceil(b.row) + 1);
    const window = await reader.readWindow({ column, row, width: right - column, height: bottom - row });
    const pixelWindow = (e, n) => { const pixel = reader.modelToPixel(e, n); return { column: Math.floor(pixel.column), row: Math.floor(pixel.row), width: 1, height: 1 }; };
    const sampleMaybe = (e, n) => {
      const pixel = pixelWindow(e, n); const x = pixel.column - window.column; const y = pixel.row - window.row;
      if (x < 0 || y < 0 || x >= window.width || y >= window.height) return { valid: false, reason: 'outside-window', pixel };
      const value = window.values[y * window.width + x];
      if (value === window.nodata) return { valid: false, reason: 'nodata', pixel, value };
      if (!Number.isFinite(value)) return { valid: false, reason: 'non-finite', pixel, value };
      return { valid: true, value, pixel };
    };
    const sample = (e, n) => { const result = sampleMaybe(e, n); assert(result.valid, `Invalid terrain sample (${result.reason})`); return result.value; };
    const evidence = async (e, n) => { const nativePixelWindow = pixelWindow(e, n); const direct = await reader.readWindow(nativePixelWindow); const value = direct.values[0]; assert(value !== direct.nodata && Number.isFinite(value), 'Invalid terrain evidence sample'); const bytes = Buffer.allocUnsafe(4); bytes.writeFloatLE(value); return { rasterSha256, nativePixelWindow, compressedTileIndices: direct.tileIndices, compressedTileBytesRead: direct.bytesRead, sampleMethod: 'direct-native-pixel-float32-le', sampledSourceDeclaredNavd88UnrealizedMetres: value, sampleWindowSha256: `sha256:${sha256(bytes)}` }; };
    return { reader, window, sample, sampleMaybe, evidence, raw, rawPath, sourceLock, rasterSha256, elevationLock, descriptor, verifiedTerrainDigest };
  } catch (error) {
    if (reader) {
      try { await reader.close(); } finally {
        if (verifiedTerrainDigest) await assertVerifiedTerrainSourceUnchanged(verifiedTerrainDigest, { pathname: rawPath, phase: 'after failed window reads/close' });
      }
    }
    throw error;
  }
}

async function loadTerrainDescriptors(verifiedTerrainSourceDigests = null) {
  const sourceBounds = [TILE.minE - TILE.sourceBuffer - 2, TILE.minN - TILE.sourceBuffer - 2, TILE.minE + TILE.size + TILE.sourceBuffer + 2, TILE.minN + TILE.size + TILE.sourceBuffer + 2];
  const selected = [];
  for (const descriptor of TERRAIN_SOURCES) {
    const [sourceLockBytes, elevationLockBytes] = await Promise.all([readFile(descriptor.sourceLockPath), readFile(descriptor.elevationLockPath)]);
    const sourceLock = JSON.parse(sourceLockBytes); const elevationLock = JSON.parse(elevationLockBytes); const bounds = sourceLock.raster.gridEnvelope.modelBoundsAtPixelIsAreaEdges;
    if (sourceBounds[2] < bounds[0] || sourceBounds[0] > bounds[2] || sourceBounds[3] < bounds[1] || sourceBounds[1] > bounds[3]) continue;
    assert.equal(elevationLock.sourceLock.id, sourceLock.id, 'Terrain elevation authorization source id drifted');
    assert.equal(elevationLock.sourceLock.sha256, sha256(sourceLockBytes), 'Terrain elevation authorization source hash drifted');
    assert.equal(elevationLock.sourceRaster.sha256, sourceLock.raster.sha256, 'Terrain elevation authorization raster hash drifted');
    selected.push({ ...descriptor, sourceLockBytes, elevationLockBytes, sourceLock, elevationLock, bounds, verifiedTerrainDigest: verifiedTerrainDigestFor(sourceLock, verifiedTerrainSourceDigests) });
  }
  assert(selected.length, `No byte-locked terrain source overlaps the buffered tile ${TILE.id}`);
  return selected;
}

function terrainCellKey(easting, northing) {
  return `${Math.floor((easting - 1e-7) / 10000)},${Math.floor((northing - 1e-7) / 10000)}`;
}

function terrainOwnershipRegions() {
  const sourceBounds = [TILE.minE - TILE.sourceBuffer - 2, TILE.minN - TILE.sourceBuffer - 2, TILE.minE + TILE.size + TILE.sourceBuffer + 2, TILE.minN + TILE.size + TILE.sourceBuffer + 2];
  const minCellE = Math.floor((sourceBounds[0] - 1e-7) / 10000); const maxCellE = Math.floor((sourceBounds[2] - 1e-7) / 10000);
  const minCellN = Math.floor((sourceBounds[1] - 1e-7) / 10000); const maxCellN = Math.floor((sourceBounds[3] - 1e-7) / 10000);
  const regions = [];
  for (let cellN = minCellN; cellN <= maxCellN; cellN += 1) for (let cellE = minCellE; cellE <= maxCellE; cellE += 1) {
    const bounds = [Math.max(sourceBounds[0], cellE * 10000), Math.max(sourceBounds[1], cellN * 10000), Math.min(sourceBounds[2], (cellE + 1) * 10000), Math.min(sourceBounds[3], (cellN + 1) * 10000)];
    if (bounds[0] < bounds[2] && bounds[1] < bounds[3]) regions.push({ cellKey: `${cellE},${cellN}`, bounds });
  }
  return regions;
}

function isCaliforniaGapsDescriptor(descriptor) {
  return descriptor.label.startsWith('californiagaps-');
}

function proofCoordinateKey(easting, northing) {
  return `${q(easting)},${q(northing)}`;
}

/**
 * Isolated source-selection proof path.  This deliberately opens both the
 * original and CaliforniaGaps rasters, then chooses one direct native pixel
 * for each requested sample.  The proof mode is write:false only.  The
 * production mode shares this implementation but is independently gated by
 * the byte-locked authorization below; it is currently disabled by policy.
 */
async function openPerNativePixelFallbackProofMosaic(descriptors, mode = NATIVE_PIXEL_FALLBACK_PROOF_MODE) {
  assert([NATIVE_PIXEL_FALLBACK_PROOF_MODE, NATIVE_PIXEL_FALLBACK_PRODUCTION_MODE].includes(mode), `Unknown native-pixel mosaic mode ${mode}`);
  const sources = [];
  const groups = [];
  try {
    const descriptorsByCell = new Map();
    for (const descriptor of descriptors) {
      const cellKey = terrainCellKey((descriptor.bounds[0] + descriptor.bounds[2]) / 2, (descriptor.bounds[1] + descriptor.bounds[3]) / 2);
      const candidates = descriptorsByCell.get(cellKey) ?? [];
      candidates.push(descriptor);
      candidates.sort((a, b) => Number(isCaliforniaGapsDescriptor(a)) - Number(isCaliforniaGapsDescriptor(b)) || a.sourceOrder - b.sourceOrder || a.label.localeCompare(b.label));
      descriptorsByCell.set(cellKey, candidates);
    }
    for (const region of terrainOwnershipRegions()) {
      const descriptorsInCell = descriptorsByCell.get(region.cellKey) ?? [];
      assert(descriptorsInCell.length, `No byte-locked terrain source owns ${region.cellKey} for ${TILE.id}`);
      const opened = [];
      for (const descriptor of descriptorsInCell) {
        const source = await openTerrain(descriptor.sourceLock, descriptor.sourceLock.raster.sha256, descriptor.elevationLock, descriptor, region.bounds, descriptor.verifiedTerrainDigest, { allowNoData: true });
        if (source) { const openedSource = { ...source, cellKey: region.cellKey }; opened.push(openedSource); sources.push(openedSource); }
      }
      const original = opened.find((source) => !isCaliforniaGapsDescriptor(source.descriptor));
      assert(original, `Per-native-pixel proof requires an original terrain source for ${region.cellKey}`);
      const fallbacks = opened.filter((source) => isCaliforniaGapsDescriptor(source.descriptor));
      groups.push({ cellKey: region.cellKey, bounds: region.bounds, original, fallbacks });
    }
    assert(groups.length, `No terrain ownership groups opened for ${TILE.id}`);
    sources.sort((a, b) => a.descriptor.sourceOrder - b.descriptor.sourceOrder || a.cellKey.localeCompare(b.cellKey));
  } catch (error) {
    await closeTerrainSources(sources);
    throw error;
  }

  const groupByCell = new Map(groups.map((group) => [group.cellKey, group]));
  const selectionCache = new Map();
  const sampleAudit = new Map();
  const sourceProbeStats = new Map(sources.map((source) => [source.sourceLock.id, { sourceLockId: source.sourceLock.id, finiteCount: 0, noDataCount: 0, nonFiniteCount: 0, outsideWindowCount: 0, chosenCount: 0 }]));
  const sourceDisagreements = [];
  const select = (easting, northing) => {
    const cacheKey = proofCoordinateKey(easting, northing);
    const cached = selectionCache.get(cacheKey);
    if (cached) return cached;
    const cellKey = terrainCellKey(easting, northing); const group = groupByCell.get(cellKey);
    assert(group, `No authoritative terrain ownership group for sample ${easting},${northing} in ${TILE.id}`);
    const originalProbe = group.original.sampleMaybe(easting, northing);
    let selectedSource = group.original; let selectedProbe = originalProbe; let fallbackFrom = null;
    const fallbackProbes = group.fallbacks.map((candidate) => ({ source: candidate, probe: candidate.sampleMaybe(easting, northing) }));
    if (!originalProbe.valid) {
      assert.equal(originalProbe.reason, 'nodata', `Original terrain source ${group.original.sourceLock.id} was unavailable at ${easting},${northing}; CaliforniaGaps fallback is only allowed for original NoData`);
      const fallback = fallbackProbes.find(({ probe }) => probe.valid)?.source;
      assert(fallback, `No finite CaliforniaGaps fallback for original NoData at ${easting},${northing} in ${TILE.id}`);
      selectedSource = fallback; selectedProbe = fallbackProbes.find(({ source }) => source === fallback).probe; fallbackFrom = group.original;
      assert(selectedProbe.valid && Number.isFinite(selectedProbe.value), `CaliforniaGaps fallback produced an invalid value at ${easting},${northing}`);
    } else {
      assert(Number.isFinite(originalProbe.value), `Original terrain source produced a non-finite value at ${easting},${northing}`);
    }
    const selection = Object.freeze({ source: selectedSource, probe: selectedProbe, originalProbe, fallbackFrom, probes: Object.freeze([{ source: group.original, probe: originalProbe }, ...fallbackProbes]) });
    selectionCache.set(cacheKey, selection);
    return selection;
  };
  const audit = (easting, northing, selection) => {
    const key = proofCoordinateKey(easting, northing); const source = selection.source; const existing = sampleAudit.get(key);
    if (existing) {
      assert.equal(existing.sourceLockId, source.sourceLock.id, `Per-native-pixel terrain source changed for ${key}`);
      assert.deepEqual(existing.nativePixel, { column: selection.probe.pixel.column, row: selection.probe.pixel.row }, `Per-native-pixel terrain pixel changed for ${key}`);
      return;
    }
    for (const { source: candidate, probe } of selection.probes) {
      const stats = sourceProbeStats.get(candidate.sourceLock.id); assert(stats, `Missing source accounting entry for ${candidate.sourceLock.id}`);
      if (probe.valid) stats.finiteCount += 1;
      else if (probe.reason === 'nodata') stats.noDataCount += 1;
      else if (probe.reason === 'non-finite') stats.nonFiniteCount += 1;
      else if (probe.reason === 'outside-window') stats.outsideWindowCount += 1;
    }
    sourceProbeStats.get(source.sourceLock.id).chosenCount += 1;
    const finiteFallbacks = selection.probes.filter(({ source: candidate, probe }) => candidate !== selection.fallbackFrom && isCaliforniaGapsDescriptor(candidate.descriptor) && probe.valid);
    if (selection.originalProbe.valid && finiteFallbacks.length) for (const { probe } of finiteFallbacks) sourceDisagreements.push(Math.abs(selection.originalProbe.value - probe.value));
    const record = Object.freeze({
      modelEastingMetres: q(easting),
      modelNorthingMetres: q(northing),
      sourceLockId: source.sourceLock.id,
      elevationSourceLockId: source.elevationLock.id,
      rasterSha256: source.rasterSha256,
      nativePixel: { column: selection.probe.pixel.column, row: selection.probe.pixel.row },
      sampledSourceDeclaredNavd88UnrealizedMetres: selection.probe.value,
      sourceRole: isCaliforniaGapsDescriptor(source.descriptor) ? 'californiagaps-fallback' : 'original',
      fallbackFromSourceLockId: selection.fallbackFrom?.sourceLock.id ?? null,
      fallbackOriginalReason: selection.fallbackFrom ? selection.originalProbe.reason : null,
      fallbackOriginalNativePixel: selection.fallbackFrom ? { ...selection.originalProbe.pixel } : null,
    });
    sampleAudit.set(key, record);
  };
  const proof = {
    mode,
    rule: 'original direct native float32 pixel; CaliforniaGaps direct native pixel only when original pixel is NoData; no blending/interpolation',
    finalize() {
      const records = [...sampleAudit.values()].sort((a, b) => a.modelNorthingMetres - b.modelNorthingMetres || a.modelEastingMetres - b.modelEastingMetres);
      const sourceSampleCounts = {};
      let originalFiniteSamples = 0; let fallbackSamples = 0;
      for (const record of records) {
        sourceSampleCounts[record.sourceLockId] = (sourceSampleCounts[record.sourceLockId] ?? 0) + 1;
        if (record.sourceRole === 'californiagaps-fallback') fallbackSamples += 1; else originalFiniteSamples += 1;
      }
      const sortedDisagreements = [...sourceDisagreements].sort((a, b) => a - b);
      const p99Index = sortedDisagreements.length ? Math.min(sortedDisagreements.length - 1, Math.ceil(sortedDisagreements.length * 0.99) - 1) : -1;
      const sharedEdgeSamples = Object.fromEntries([
        ['south', records.filter((record) => Math.abs(record.modelNorthingMetres - TILE.minN) <= 1e-9 && Number.isInteger(record.modelEastingMetres))],
        ['north', records.filter((record) => Math.abs(record.modelNorthingMetres - (TILE.minN + TILE.size)) <= 1e-9 && Number.isInteger(record.modelEastingMetres))],
        ['west', records.filter((record) => Math.abs(record.modelEastingMetres - TILE.minE) <= 1e-9 && Number.isInteger(record.modelNorthingMetres))],
        ['east', records.filter((record) => Math.abs(record.modelEastingMetres - (TILE.minE + TILE.size)) <= 1e-9 && Number.isInteger(record.modelNorthingMetres))],
      ].map(([edge, edgeRecords]) => [edge, Object.freeze(edgeRecords)]));
      const sourceStats = Object.fromEntries([...sourceProbeStats.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, stats]) => [id, Object.freeze({ ...stats })]));
      return Object.freeze({
        mode,
        selectionPolicyName: NATIVE_PIXEL_SELECTION_POLICY.name,
        selectionPolicy: NATIVE_PIXEL_SELECTION_POLICY,
        selectionPolicyHash: `sha256:${sha256(stableBytes(NATIVE_PIXEL_SELECTION_POLICY))}`,
        rule: this.rule,
        verticalCertification: 'source-declared-navd88-unrealized',
        status: 'provisional-vertical-unrealized',
        sampleLedgerSha256: `sha256:${sha256(stableBytes(records))}`,
        sharedEdgeLedgerSha256: `sha256:${sha256(stableBytes(sharedEdgeSamples))}`,
        counts: Object.freeze({ uniqueNativeSampleCoordinates: records.length, originalFiniteSamples, californiaGapsFallbackSamples: fallbackSamples, sourceSampleCounts: Object.freeze(sourceSampleCounts), sourceProbeStats: Object.freeze(sourceStats), bothFiniteSourceComparisons: sortedDisagreements.length, maxBothFiniteDisagreementMetres: sortedDisagreements.at(-1) ?? 0, p99BothFiniteDisagreementMetres: p99Index < 0 ? 0 : sortedDisagreements[p99Index] }),
        sharedEdgeSamples: Object.freeze(sharedEdgeSamples),
        sourceLocks: Object.freeze([...new Set(sources.map((source) => source.sourceLock.id))].sort()),
        records: Object.freeze(records),
      });
    },
  };
  return {
    sources,
    sample(easting, northing) { const selection = select(easting, northing); audit(easting, northing, selection); return selection.probe.value; },
    async evidence(easting, northing) { const selection = select(easting, northing); audit(easting, northing, selection); return { source: selection.source, payload: await selection.source.evidence(easting, northing) }; },
    proof,
    async close() { await closeTerrainSources(sources); },
  };
}

async function openTerrainMosaic(descriptors, terrainSelectionMode = DEFAULT_TERRAIN_SELECTION_MODE) {
  if (terrainSelectionMode === NATIVE_PIXEL_FALLBACK_PROOF_MODE || terrainSelectionMode === NATIVE_PIXEL_FALLBACK_PRODUCTION_MODE) return openPerNativePixelFallbackProofMosaic(descriptors, terrainSelectionMode);
  assert.equal(terrainSelectionMode, DEFAULT_TERRAIN_SELECTION_MODE, `Unknown terrain selection mode ${terrainSelectionMode}`);
  const sources = [];
  try {
    const descriptorsByCell = new Map();
    for (const descriptor of descriptors) {
      const cellKey = terrainCellKey((descriptor.bounds[0] + descriptor.bounds[2]) / 2, (descriptor.bounds[1] + descriptor.bounds[3]) / 2);
      const candidates = descriptorsByCell.get(cellKey) ?? [];
      candidates.push(descriptor);
      candidates.sort((a, b) => b.priority - a.priority || a.label.localeCompare(b.label));
      descriptorsByCell.set(cellKey, candidates);
    }
    for (const region of terrainOwnershipRegions()) {
      const candidates = descriptorsByCell.get(region.cellKey) ?? [];
      assert(candidates.length, `No byte-locked terrain source owns ${region.cellKey} for ${TILE.id}`);
      let selected = null;
      for (const descriptor of candidates) {
        const source = await openTerrain(descriptor.sourceLock, descriptor.sourceLock.raster.sha256, descriptor.elevationLock, descriptor, region.bounds, descriptor.verifiedTerrainDigest);
        if (!source) continue;
        selected = { ...source, cellKey: region.cellKey };
        sources.push(selected);
        break;
      }
      assert(selected, `No fully finite byte-locked terrain source owns ${region.cellKey} for ${TILE.id}`);
    }
    sources.sort((a, b) => a.descriptor.sourceOrder - b.descriptor.sourceOrder || a.cellKey.localeCompare(b.cellKey));
  } catch (error) {
    await closeTerrainSources(sources);
    throw error;
  }
  const sourceFor = (easting, northing) => {
    const key = terrainCellKey(easting, northing);
    const source = sources.find(({ cellKey }) => cellKey === key);
    assert(source, `No authoritative terrain cell owns sample ${easting},${northing} for ${TILE.id}`);
    return source;
  };
  return {
    sources,
    sample(easting, northing) { return sourceFor(easting, northing).sample(easting, northing); },
    async evidence(easting, northing) { const source = sourceFor(easting, northing); return { source, payload: await source.evidence(easting, northing) }; },
    async close() { await closeTerrainSources(sources); },
  };
}

async function closeTerrainSources(sources) {
  const closeResults = await Promise.allSettled(sources.map(({ reader }) => reader.close()));
  const closeError = closeResults.find(({ status }) => status === 'rejected')?.reason ?? null;
  await Promise.all(sources.map(({ verifiedTerrainDigest, rawPath }) => verifiedTerrainDigest && assertVerifiedTerrainSourceUnchanged(verifiedTerrainDigest, { pathname: rawPath, phase: 'after all window reads/close' })));
  if (closeError) throw closeError;
}

function category() { return { positions: [], indices: [], sourceIds: new Set() }; }
function vertex(target, e, h, n) { target.positions.push(q(e - TILE.minE), q(h - TILE.originH), q(n - TILE.minN)); return target.positions.length / 3 - 1; }
function triangle(target, a, b, c) { target.indices.push(a, b, c); }
function inside([e, n]) { return e >= TILE.minE && e <= TILE.minE + TILE.size && n >= TILE.minN && n <= TILE.minN + TILE.size; }

function clipSegment(a, b) {
  let t0 = 0; let t1 = 1; const dx = b[0] - a[0]; const dy = b[1] - a[1];
  for (const [p, qv] of [[-dx, a[0] - TILE.minE], [dx, TILE.minE + TILE.size - a[0]], [-dy, a[1] - TILE.minN], [dy, TILE.minN + TILE.size - a[1]]]) {
    if (p === 0 && qv < 0) return null; if (p === 0) continue; const r = qv / p; if (p < 0) { if (r > t1) return null; t0 = Math.max(t0, r); } else { if (r < t0) return null; t1 = Math.min(t1, r); }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

function clipPolygon(points) {
  let output = points.slice();
  const edges = [([e]) => e >= TILE.minE, ([e]) => e <= TILE.minE + TILE.size, (([, n]) => n >= TILE.minN), (([, n]) => n <= TILE.minN + TILE.size)];
  const intersect = (a, b, edge) => {
    if (edge === 0 || edge === 1) { const x = edge === 0 ? TILE.minE : TILE.minE + TILE.size; const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + t * (b[1] - a[1])]; }
    const y = edge === 2 ? TILE.minN : TILE.minN + TILE.size; const t = (y - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y];
  };
  for (let edge = 0; edge < 4; edge += 1) { const input = output; output = []; if (!input.length) break; let a = input.at(-1);
    for (const b of input) { if (edges[edge](b)) { if (!edges[edge](a)) output.push(intersect(a, b, edge)); output.push(b); } else if (edges[edge](a)) output.push(intersect(a, b, edge)); a = b; }
  }
  return output;
}

function roadWidth(tags) {
  const explicit = Number.parseFloat(tags.width); if (Number.isFinite(explicit) && explicit > 0 && explicit < 60) return explicit;
  const lanes = Number.parseInt(tags.lanes, 10); const base = { motorway: 24, trunk: 18, primary: 14, secondary: 11, tertiary: 9, residential: 7, service: 5, pedestrian: 5, footway: 2.2, path: 1.8, cycleway: 2.2, steps: 2.2 }[tags.highway] ?? 5;
  return Number.isFinite(lanes) ? Math.max(base, lanes * 3.2) : base;
}

function buildingHeight(tags) {
  const height = Number.parseFloat(tags.height); if (Number.isFinite(height) && height >= 2 && height <= 500) return height;
  const levels = Number.parseFloat(tags['building:levels']); return Number.isFinite(levels) && levels > 0 ? Math.min(500, levels * 3.2) : 9.6;
}

function samePlanPoint(a, b) { return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7; }

function assembleDirectedCoastline(features) {
  const remaining = new Map(features.filter(({ tags }) => tags.natural === 'coastline').map((way) => [way.id, way]));
  if (!remaining.size) return null;
  const lastRefs = new Set([...remaining.values()].map(({ refs }) => refs.at(-1)));
  let current = [...remaining.values()].find(({ refs }) => !lastRefs.has(refs[0])) ?? [...remaining.values()].sort((a, b) => a.id - b.id)[0];
  const ordered = [];
  while (current) {
    ordered.push(current); remaining.delete(current.id);
    current = [...remaining.values()].find(({ refs }) => refs[0] === current.refs.at(-1));
  }
  assert.equal(remaining.size, 0, `Tile ${TILE.id} has disconnected OSM coastline chains; refuse to guess water ownership`);
  const points = [];
  for (const way of ordered) for (const point of way.en) if (!points.length || !samePlanPoint(points.at(-1), point)) points.push(point);
  const contributingWayIds = new Set(ordered.filter((way) => way.en.slice(0, -1).some((point, index) => {
    const segment = clipSegment(point, way.en[index + 1]);
    return segment && !samePlanPoint(segment[0], segment[1]);
  })).map(({ id }) => id));
  const fragments = []; let clipped = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const segment = clipSegment(points[index], points[index + 1]);
    if (!segment) { if (clipped.length >= 2) fragments.push(clipped); clipped = []; continue; }
    if (clipped.length && !samePlanPoint(clipped.at(-1), segment[0])) { if (clipped.length >= 2) fragments.push(clipped); clipped = []; }
    if (!clipped.length || !samePlanPoint(clipped.at(-1), segment[0])) clipped.push(segment[0]);
    if (!samePlanPoint(clipped.at(-1), segment[1])) clipped.push(segment[1]);
  }
  if (clipped.length >= 2) fragments.push(clipped);
  if (!fragments.length) return null;
  return { fragments, ways: ordered.filter(({ id }) => contributingWayIds.has(id)) };
}

function clockwiseBoundaryParameter([e, n]) {
  const maxE = TILE.minE + TILE.size; const maxN = TILE.minN + TILE.size; const epsilon = 1e-5;
  if (Math.abs(e - TILE.minE) <= epsilon) return n - TILE.minN;
  if (Math.abs(n - maxN) <= epsilon) return TILE.size + e - TILE.minE;
  if (Math.abs(e - maxE) <= epsilon) return TILE.size * 2 + maxN - n;
  if (Math.abs(n - TILE.minN) <= epsilon) return TILE.size * 3 + maxE - e;
  assert.fail(`Coastline endpoint ${e},${n} is not on tile boundary`);
}

function toTicks([e, n]) { return [Math.round((e - TILE.minE) * SURFACE_TICKS_PER_METRE), Math.round((n - TILE.minN) * SURFACE_TICKS_PER_METRE)]; }
function fromTicks([x, z]) { return [TILE.minE + x / SURFACE_TICKS_PER_METRE, TILE.minN + z / SURFACE_TICKS_PER_METRE]; }

function signedArea2(ring) {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index]; const b = ring[(index + 1) % ring.length]; area += a[0] * b[1] - b[0] * a[1];
  }
  return area;
}

function boundaryParameterTicks([x, z]) {
  const size = TILE.size * SURFACE_TICKS_PER_METRE;
  if (x === 0) return z;
  if (z === size) return size + x;
  if (x === size) return size * 3 - z;
  if (z === 0) return size * 4 - x;
  assert.fail(`Coastline endpoint ${x},${z} is not on the integer tile boundary`);
}

function waterSurfaceFromDirectedCoastline(coastline) {
  const size = TILE.size * SURFACE_TICKS_PER_METRE;
  const vertices = new Map(); const adjacency = new Map(); const edges = new Map();
  const key = ([x, z]) => `${x},${z}`;
  const addVertex = (point) => { const id = key(point); if (!vertices.has(id)) vertices.set(id, point); if (!adjacency.has(id)) adjacency.set(id, new Set()); return id; };
  const addEdge = (a, b, metadata) => {
    const ak = addVertex(a); const bk = addVertex(b); if (ak === bk) return;
    const edgeKey = [ak, bk].sort().join('|'); const existing = edges.get(edgeKey);
    if (existing) { assert.equal(existing.kind, metadata.kind, `Conflicting coastline/boundary edge ${edgeKey}`); return; }
    edges.set(edgeKey, { ...metadata, forward: [ak, bk] }); adjacency.get(ak).add(bk); adjacency.get(bk).add(ak);
  };
  const boundaryPoints = [[0, 0], [0, size], [size, size], [size, 0]];
  for (const fragment of coastline.fragments) {
    const points = fragment.map(toTicks);
    boundaryParameterTicks(points[0]); boundaryParameterTicks(points.at(-1));
    boundaryPoints.push(points[0], points.at(-1));
    for (let index = 0; index < points.length - 1; index += 1) addEdge(points[index], points[index + 1], { kind: 'coastline' });
  }
  const orderedBoundary = [...new Map(boundaryPoints.map((point) => [key(point), point])).values()].sort((a, b) => boundaryParameterTicks(a) - boundaryParameterTicks(b));
  for (let index = 0; index < orderedBoundary.length; index += 1) addEdge(orderedBoundary[index], orderedBoundary[(index + 1) % orderedBoundary.length], { kind: 'boundary' });
  const sortedNeighbors = new Map([...adjacency].map(([id, neighbors]) => {
    const origin = vertices.get(id); return [id, [...neighbors].sort((a, b) => {
      const pa = vertices.get(a); const pb = vertices.get(b); return Math.atan2(pa[1] - origin[1], pa[0] - origin[0]) - Math.atan2(pb[1] - origin[1], pb[0] - origin[0]);
    })];
  }));
  const visited = new Set(); const waterFaces = []; const landFaces = [];
  for (const [edgeKey] of edges) for (const start of [edgeKey.split('|'), edgeKey.split('|').reverse()]) {
    const startKey = `${start[0]}>${start[1]}`; if (visited.has(startKey)) continue;
    const ringKeys = []; let from = start[0]; let to = start[1];
    while (!visited.has(`${from}>${to}`)) {
      visited.add(`${from}>${to}`); ringKeys.push(from);
      const neighbors = sortedNeighbors.get(to); const reverseIndex = neighbors.indexOf(from); assert(reverseIndex >= 0, 'Planar coastline graph lost its reverse edge');
      const next = neighbors[(reverseIndex - 1 + neighbors.length) % neighbors.length]; from = to; to = next;
    }
    assert.equal(`${from}>${to}`, startKey, 'Planar coastline face did not close on its starting half-edge');
    const ring = ringKeys.map((id) => vertices.get(id)); if (signedArea2(ring) <= 0) continue;
    const classifications = new Set();
    for (let index = 0; index < ringKeys.length; index += 1) {
      const a = ringKeys[index]; const b = ringKeys[(index + 1) % ringKeys.length]; const edge = edges.get([a, b].sort().join('|'));
      if (edge.kind !== 'coastline') continue;
      classifications.add(edge.forward[0] === a && edge.forward[1] === b ? 'land' : 'water');
    }
    assert.equal(classifications.size, 1, `Tile ${TILE.id} coastline face has contradictory OSM direction ownership`);
    (classifications.has('water') ? waterFaces : landFaces).push({ outer: ring });
  }
  assert(waterFaces.length && landFaces.length, `Tile ${TILE.id} coastline graph must resolve at least one land and one water face`);
  const partitionArea = [...waterFaces, ...landFaces].reduce((sum, { outer }) => sum + Math.abs(signedArea2(outer)) / 2, 0);
  assert(Math.abs(partitionArea - size ** 2) <= 1, `Tile ${TILE.id} coastline faces do not partition the integer tile`);
  return { waterFaces, landFaces };
}

function pointInRing(point, ring) {
  let result = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[previous]; const b = ring[index];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function roadPathBounds(pathPoints) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { x, y } of pathPoints) {
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }
  return bounds;
}

function compareRoadClipperPaths(left, right) {
  const a = roadPathBounds(left); const b = roadPathBounds(right);
  for (let axis = 0; axis < a.length; axis += 1) if (a[axis] !== b[axis]) return a[axis] - b[axis];
  const leftKey = JSON.stringify(left); const rightKey = JSON.stringify(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function isRoadUnionSelfIntersection(error, label) {
  return error instanceof assert.AssertionError
    && String(error.message).startsWith(`${label} ring `)
    && String(error.message).endsWith(' self-intersects');
}

function roadOrient(a, b, c) {
  return BigInt(b.x - a.x) * BigInt(c.y - a.y) - BigInt(b.y - a.y) * BigInt(c.x - a.x);
}

function roadPointOnSegment(a, b, point) {
  return roadOrient(a, b, point) === 0n
    && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)
    && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
}

function sameRoadPoint(a, b) { return a.x === b.x && a.y === b.y; }

function roadSegmentsIntersect(a, b, c, d) {
  const abC = roadOrient(a, b, c); const abD = roadOrient(a, b, d);
  const cdA = roadOrient(c, d, a); const cdB = roadOrient(c, d, b);
  const crosses = (left, right) => left < 0n && right > 0n || left > 0n && right < 0n;
  return crosses(abC, abD) && crosses(cdA, cdB)
    || abC === 0n && roadPointOnSegment(a, b, c)
    || abD === 0n && roadPointOnSegment(a, b, d)
    || cdA === 0n && roadPointOnSegment(c, d, a)
    || cdB === 0n && roadPointOnSegment(c, d, b);
}

function splitRoadRingAtTouch(pathPoints, label, repairState) {
  for (let first = 0; first < pathPoints.length; first += 1) for (let second = first + 1; second < pathPoints.length; second += 1) {
    if ((first + 1) % pathPoints.length === second || (second + 1) % pathPoints.length === first) continue;
    const a = pathPoints[first]; const b = pathPoints[(first + 1) % pathPoints.length];
    const c = pathPoints[second]; const d = pathPoints[(second + 1) % pathPoints.length];
    if (!roadSegmentsIntersect(a, b, c, d)) continue;
    let endpointTouch = [a, b].find((point) => !sameRoadPoint(point, c) && !sameRoadPoint(point, d) && roadPointOnSegment(c, d, point))
      ?? [c, d].find((point) => !sameRoadPoint(point, a) && !sameRoadPoint(point, b) && roadPointOnSegment(a, b, point));
    if (!endpointTouch) {
      const rx = b.x - a.x; const ry = b.y - a.y; const sx = d.x - c.x; const sy = d.y - c.y;
      const denominator = rx * sy - ry * sx;
      assert(denominator, `${label} has an unresolved collinear overlap`);
      const numerator = (c.x - a.x) * sy - (c.y - a.y) * sx;
      const exactX = a.x + rx * numerator / denominator; const exactY = a.y + ry * numerator / denominator;
      endpointTouch = { x: Math.round(exactX), y: Math.round(exactY) };
      const repair = Math.hypot(endpointTouch.x - exactX, endpointTouch.y - exactY);
      assert(repair <= Math.SQRT1_2 + Number.EPSILON, `${label} crossing repair exceeded one millimetre grid quantization`);
      repairState.crossings += 1; repairState.maxCoordinateRepairTicks = Math.max(repairState.maxCoordinateRepairTicks, repair);
      const firstRing = [endpointTouch, ...pathPoints.slice(first + 1, second + 1)];
      const secondRing = [endpointTouch, ...pathPoints.slice(second + 1), ...pathPoints.slice(0, first + 1)];
      const rings = [firstRing, secondRing].filter((ring) => new Set(ring.map(({ x, y }) => `${x},${y}`)).size >= 3);
      assert(rings.length, `${label} crossing decomposition collapsed every ring`);
      return rings.flatMap((ring, index) => splitRoadRingAtTouch(ring, `${label}/${index}`, repairState));
    }
    const expanded = [];
    for (let index = 0; index < pathPoints.length; index += 1) {
      const start = pathPoints[index]; const end = pathPoints[(index + 1) % pathPoints.length];
      expanded.push(start);
      if (!sameRoadPoint(endpointTouch, start) && !sameRoadPoint(endpointTouch, end) && roadPointOnSegment(start, end, endpointTouch)) expanded.push(endpointTouch);
    }
    const occurrences = expanded.flatMap((point, index) => sameRoadPoint(point, endpointTouch) ? [index] : []);
    assert.equal(occurrences.length, 2, `${label} touch decomposition must create exactly two occurrences`);
    const [left, right] = occurrences;
    const firstRing = expanded.slice(left, right + 1).slice(0, -1);
    const secondRing = expanded.slice(right).concat(expanded.slice(0, left + 1)).slice(0, -1);
    const rings = [firstRing, secondRing].filter((ring) => new Set(ring.map(({ x, y }) => `${x},${y}`)).size >= 3);
    assert(rings.length, `${label} touch decomposition collapsed every ring`);
    return rings.flatMap((ring, index) => splitRoadRingAtTouch(ring, `${label}/${index}`, repairState));
  }
  return [pathPoints];
}

function batchedRoadUnion(roadSurfaces, label) {
  const sourcePaths = roadSurfaces.flatMap(({ outers, holes = [] }) => [...outers, ...holes])
    .map((ring) => ring.map(([x, y]) => ({ x, y })))
    .sort(compareRoadClipperPaths);
  let lastError = null;
  for (const batchSize of [64, 32, 16, 8, 4, 2]) {
    try {
      const batches = [];
      for (let offset = 0; offset < sourcePaths.length; offset += batchSize) {
        batches.push(...unionClipper(sourcePaths.slice(offset, offset + batchSize), FillRule.NonZero));
      }
      const exactUnion = unionClipper(batches, FillRule.NonZero).map((ring) => trimCollinear(ring));
      try {
        return { polygons: classifyBooleanPaths(exactUnion, `${label} batched-${batchSize}`), triangles: null };
      } catch (error) {
        if (!(error instanceof assert.AssertionError) || !String(error.message).includes(' self-intersects')) throw error;
        const area2 = (ring) => ring.reduce((sum, point, index) => {
          const next = ring[(index + 1) % ring.length];
          return sum + BigInt(point.x) * BigInt(next.y) - BigInt(next.x) * BigInt(point.y);
        }, 0n);
        const unionArea2 = exactUnion.reduce((sum, ring) => sum + area2(ring), 0n);
        const repairState = { crossings: 0, maxCoordinateRepairTicks: 0 };
        const decomposedUnion = exactUnion.flatMap((ring, index) => splitRoadRingAtTouch(ring, `${label} ring ${index}`, repairState));
        const decomposedArea2 = decomposedUnion.reduce((sum, ring) => sum + area2(ring), 0n);
        const areaDelta2 = decomposedArea2 > unionArea2 ? decomposedArea2 - unionArea2 : unionArea2 - decomposedArea2;
        assert(areaDelta2 <= BigInt(repairState.crossings) * 1_000_000n, `${label} crossing decomposition changed more than 0.5 square metres per repaired crossing`);
        try {
          return { polygons: classifyBooleanPaths(decomposedUnion, `${label} batched-${batchSize}-decomposed`), triangles: null };
        } catch (decomposedError) {
          if (!(decomposedError instanceof assert.AssertionError) || !String(decomposedError.message).includes(' self-intersects')) throw decomposedError;
        }
        const resolvedUnion = unionClipper(exactUnion, FillRule.EvenOdd).map((ring) => trimCollinear(ring));
        const resolvedArea2 = resolvedUnion.reduce((sum, ring) => sum + area2(ring), 0n);
        if ((resolvedArea2 < 0n ? -resolvedArea2 : resolvedArea2) === (unionArea2 < 0n ? -unionArea2 : unionArea2)) {
          try {
            return { polygons: classifyBooleanPaths(resolvedUnion, `${label} batched-${batchSize}-resolved`), triangles: null };
          } catch (resolvedError) {
            if (!(resolvedError instanceof assert.AssertionError) || !String(resolvedError.message).includes(' self-intersects')) throw resolvedError;
          }
        }
        const triangulated = triangulateClipper(resolvedUnion, false);
        if (triangulated.result !== 0 || !triangulated.solution.length) throw error;
        const triangleArea2 = triangulated.solution.reduce((sum, triangle) => sum + (area2(triangle) < 0n ? -area2(triangle) : area2(triangle)), 0n);
        assert.equal(triangleArea2, unionArea2 < 0n ? -unionArea2 : unionArea2, `${label} fallback triangulation changed filled area`);
        return { polygons: null, triangles: triangulated.solution };
      }
    } catch (error) {
      if (!(error instanceof assert.AssertionError) || !String(error.message).includes(' self-intersects')) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function unionRoadSurfaces(roadSurfaces, label) {
  try {
    return { polygons: booleanUnion(roadSurfaces, label), triangles: null };
  } catch (error) {
    if (!isRoadUnionSelfIntersection(error, label)) throw error;
    return batchedRoadUnion(roadSurfaces, label);
  }
}

function emitRoadTriangles(target, triangles, sample, cache, label) {
  for (const [triangleIndex, face] of triangles.entries()) {
    assert.equal(face.length, 3, `${label} triangle ${triangleIndex} is not triangular`);
    const indices = face.map(({ x, y }) => {
      const point = canonicalSurfaceBoundaryPoint([x, y]);
      const key = `${point[0]},${point[1]}`;
      if (!cache.has(key)) { const [e, n] = fromTicks(point); cache.set(key, vertex(target, e, sample(e, n) + ROAD_LIFT, n)); }
      return cache.get(key);
    });
    assert(indices[0] !== indices[1] && indices[1] !== indices[2] && indices[2] !== indices[0], `${label} triangle ${triangleIndex} collapsed after boundary canonicalization`);
    triangle(target, indices[0], indices[2], indices[1]);
  }
}

function booleanIntersection(subject, clip, label) {
  const outside = booleanDifference(subject, [clip], `${label} outside`);
  const outsideSurfaces = outside.map(({ outer, holes = [] }) => ({ outers: [outer], holes }));
  return booleanDifference(subject, outsideSurfaces, label);
}

function canonicalSurfaceBoundaryPoint([x, z]) {
  const size = TILE.size * SURFACE_TICKS_PER_METRE;
  const snapMetre = (value) => {
    const snapped = Math.round(value / SURFACE_TICKS_PER_METRE) * SURFACE_TICKS_PER_METRE;
    return Math.abs(value - snapped) <= 1 ? snapped : value;
  };
  const onVerticalEdge = x === 0 || x === size;
  const onHorizontalEdge = z === 0 || z === size;
  return [onHorizontalEdge ? snapMetre(x) : x, onVerticalEdge ? snapMetre(z) : z];
}

function emitSurfacePolygon(target, polygon, sample, cache, label, lift = 0, surfaceHeight = null) {
  const result = triangulatePolygon(polygon, label);
  const indices = result.vertices.map((rawPoint) => {
    const point = canonicalSurfaceBoundaryPoint(rawPoint);
    const key = `${point[0]},${point[1]}`;
    if (!cache.has(key)) { const [e, n] = fromTicks(point); cache.set(key, vertex(target, e, (surfaceHeight ? surfaceHeight(point) : sample(e, n)) + lift, n)); }
    return cache.get(key);
  });
  for (const face of result.triangles) {
    const a = indices[face[0]]; const b = indices[face[2]]; const c = indices[face[1]];
    if (a !== b && b !== c && c !== a) triangle(target, a, b, c);
  }
}

function emitRoadPolygon(target, polygon, sample, cache, label) {
  try {
    emitSurfacePolygon(target, polygon, sample, cache, label, ROAD_LIFT);
    return;
  } catch (error) {
    assert(error instanceof assert.AssertionError, `${label} Earcut failed unexpectedly: ${error.message}`);
  }
  const paths = [polygon.outer, ...(polygon.holes ?? [])].map((ring) => ring.map(([x, y]) => ({ x, y })));
  const result = triangulateClipper(paths, false);
  assert.equal(result.result, 0, `${label} Clipper triangulation failed`);
  assert(result.solution.length, `${label} Clipper triangulation returned no triangles`);
  for (const [triangleIndex, face] of result.solution.entries()) {
    assert.equal(face.length, 3, `${label} triangle ${triangleIndex} is not triangular`);
    const indices = face.map(({ x, y }) => {
      const key = `${x},${y}`;
      if (!cache.has(key)) { const [e, n] = fromTicks([x, y]); cache.set(key, vertex(target, e, sample(e, n) + ROAD_LIFT, n)); }
      return cache.get(key);
    });
    triangle(target, indices[0], indices[2], indices[1]);
  }
}

function emitCoastEdge(target, coastline, sample) {
  for (let index = 0; index < coastline.points.length - 1; index += 1) {
    const a = coastline.points[index]; const b = coastline.points[index + 1];
    if (samePlanPoint(a, b)) continue;
    const ah = sample(...a); const bh = sample(...b); const base = target.positions.length / 3;
    vertex(target, a[0], ah - COAST_EDGE_HALF_HEIGHT, a[1]); vertex(target, a[0], ah + COAST_EDGE_HALF_HEIGHT, a[1]);
    vertex(target, b[0], bh - COAST_EDGE_HALF_HEIGHT, b[1]); vertex(target, b[0], bh + COAST_EDGE_HALF_HEIGHT, b[1]);
    triangle(target, base, base + 2, base + 1); triangle(target, base + 1, base + 2, base + 3);
  }
}

function canonicalLatticeSurfaceHeight(sample, [x, z]) {
  assert(Number.isInteger(x) && Number.isInteger(z), 'Canonical lattice height requires integer surface ticks');
  const direct = (point) => { const [e, n] = fromTicks(point); return sample(e, n); };
  if (x % SURFACE_TICKS_PER_METRE === 0 && z % SURFACE_TICKS_PER_METRE === 0) return direct([x, z]);
  const cellX = Math.min(Math.floor(x / SURFACE_TICKS_PER_METRE) * SURFACE_TICKS_PER_METRE, TILE.size * SURFACE_TICKS_PER_METRE - SURFACE_TICKS_PER_METRE);
  const cellZ = Math.min(Math.floor(z / SURFACE_TICKS_PER_METRE) * SURFACE_TICKS_PER_METRE, TILE.size * SURFACE_TICKS_PER_METRE - SURFACE_TICKS_PER_METRE);
  const fractionX = (x - cellX) / SURFACE_TICKS_PER_METRE; const fractionZ = (z - cellZ) / SURFACE_TICKS_PER_METRE;
  const southWest = direct([cellX, cellZ]); const southEast = direct([cellX + SURFACE_TICKS_PER_METRE, cellZ]); const northEast = direct([cellX + SURFACE_TICKS_PER_METRE, cellZ + SURFACE_TICKS_PER_METRE]); const northWest = direct([cellX, cellZ + SURFACE_TICKS_PER_METRE]);
  // Every cell uses the same southwest-to-northeast diagonal. The two formulas
  // are barycentric evaluations on that exact source-lattice triangle pair.
  return fractionX >= fractionZ
    ? southWest * (1 - fractionX) + southEast * (fractionX - fractionZ) + northEast * fractionZ
    : southWest * (1 - fractionZ) + northEast * fractionX + northWest * (fractionZ - fractionX);
}

function signedRingAreaTicks(ring) {
  let twiceArea = 0n;
  for (let index = 0; index < ring.length; index += 1) {
    const [ax, az] = ring[index]; const [bx, bz] = ring[(index + 1) % ring.length];
    twiceArea += BigInt(ax) * BigInt(bz) - BigInt(az) * BigInt(bx);
  }
  return twiceArea;
}

function polygonAreaTicks(polygon) {
  return signedRingAreaTicks(polygon.outer) - (polygon.holes ?? []).reduce((sum, ring) => sum + signedRingAreaTicks(ring), 0n);
}

function collectFractionalGridBoundaryVertices(surfaceParts) {
  const vertical = new Map(); const horizontal = new Map();
  const add = (map, line, value) => {
    if (!map.has(line)) map.set(line, new Set()); map.get(line).add(value);
  };
  for (const { polygon } of surfaceParts) for (const ring of [polygon.outer, ...(polygon.holes ?? [])]) for (const [x, z] of ring) {
    if (x % SURFACE_TICKS_PER_METRE === 0 && z % SURFACE_TICKS_PER_METRE !== 0) add(vertical, x, z);
    if (z % SURFACE_TICKS_PER_METRE === 0 && x % SURFACE_TICKS_PER_METRE !== 0) add(horizontal, z, x);
  }
  return { vertical, horizontal };
}

function splitRingOnGridBoundaryVertices(ring, boundaryVertices) {
  const split = [];
  for (let index = 0; index < ring.length; index += 1) {
    const point = ring[index]; const next = ring[(index + 1) % ring.length]; split.push(point);
    const vertical = point[0] === next[0] && point[0] % SURFACE_TICKS_PER_METRE === 0 ? boundaryVertices.vertical.get(point[0]) : null;
    const horizontal = point[1] === next[1] && point[1] % SURFACE_TICKS_PER_METRE === 0 ? boundaryVertices.horizontal.get(point[1]) : null;
    const candidates = vertical ?? horizontal;
    if (!candidates) continue;
    const axis = vertical ? 1 : 0; const direction = Math.sign(next[axis] - point[axis]);
    for (const value of [...candidates].filter((value) => (value - point[axis]) * direction > 0 && (value - next[axis]) * direction < 0).sort((a, b) => direction * (a - b))) {
      split.push(axis === 1 ? [point[0], value] : [value, point[1]]);
    }
  }
  return split;
}

/**
 * Proof-only topology construction: fractional coastline vertices that occur
 * on a one-metre cell edge are inserted into every matching cell edge before
 * triangulation. Existing Clipper/OSM coordinates are retained byte-for-byte;
 * all new coordinates lie on an already-authored axis-aligned cell edge.
 */
function conformSurfacePartsToGridBoundaries(surfaceParts) {
  const boundaryVertices = collectFractionalGridBoundaryVertices(surfaceParts); let insertedVertices = 0;
  const parts = surfaceParts.map((part) => {
    const originalArea = polygonAreaTicks(part.polygon);
    const outer = splitRingOnGridBoundaryVertices(part.polygon.outer, boundaryVertices);
    const holes = (part.polygon.holes ?? []).map((ring) => splitRingOnGridBoundaryVertices(ring, boundaryVertices));
    insertedVertices += outer.length - part.polygon.outer.length + holes.reduce((sum, ring, index) => sum + ring.length - part.polygon.holes[index].length, 0);
    const polygon = { outer, ...(holes.length ? { holes } : {}) };
    assert.equal(polygonAreaTicks(polygon), originalArea, `${part.label} conforming stitch changed exact plan area`);
    return { ...part, polygon };
  });
  return { parts, insertedVertices, gridBoundaryVertices: [...boundaryVertices.vertical.values(), ...boundaryVertices.horizontal.values()].reduce((sum, points) => sum + points.size, 0) };
}

function bakeGeometry(features, sample, terrainGridStepMetres = TERRAIN_STEP, surfaceHeightOwnership = 'direct-native-pixel', surfaceTopology = 'independent-cell-polygons', buildingPresentationProof = false) {
  const terrain = category(); const water = category(); const coastline = category(); const roads = category(); const buildings = category();
  if (buildingPresentationProof) Object.defineProperty(buildings, 'presentationRecords', { value: [], enumerable: false });
  const surfaceHeight = surfaceHeightOwnership === 'canonical-1m-lattice-height-v1' ? (point) => canonicalLatticeSurfaceHeight(sample, point) : null;
  const directedCoastline = assembleDirectedCoastline(features);
  const classified = directedCoastline ? waterSurfaceFromDirectedCoastline(directedCoastline) : null;
  const waterSurface = classified ? { outers: classified.waterFaces.map(({ outer }) => outer) } : null;
  const coastSegments = directedCoastline ? directedCoastline.fragments.flatMap((points) => points.slice(0, -1).map((point, index) => [toTicks(point), toTicks(points[index + 1])])) : [];
  const terrainCache = new Map(); const waterCache = new Map(); const surfaceParts = [];
  const side = TILE.size / terrainGridStepMetres + 1;
  for (let z = 0; z < side - 1; z += 1) for (let x = 0; x < side - 1; x += 1) {
    const minX = x * terrainGridStepMetres * SURFACE_TICKS_PER_METRE; const minZ = z * terrainGridStepMetres * SURFACE_TICKS_PER_METRE; const maxX = minX + terrainGridStepMetres * SURFACE_TICKS_PER_METRE; const maxZ = minZ + terrainGridStepMetres * SURFACE_TICKS_PER_METRE;
    const cell = { outers: [[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]]] };
    const touchesCoast = coastSegments.some(([a, b]) => Math.max(a[0], b[0]) >= minX && Math.min(a[0], b[0]) <= maxX && Math.max(a[1], b[1]) >= minZ && Math.min(a[1], b[1]) <= maxZ);
    if (!waterSurface || !touchesCoast) {
      const target = classified?.waterFaces.some(({ outer }) => pointInRing([(minX + maxX) / 2, (minZ + maxZ) / 2], outer)) ? water : terrain;
      surfaceParts.push({ target, polygon: { outer: cell.outers[0] }, label: `${TILE.id} ${target === water ? 'water' : 'land'} cell ${x},${z}` });
      continue;
    }
    const waterParts = booleanIntersection(cell, waterSurface, `${TILE.id} water cell ${x},${z}`);
    const landParts = booleanDifference(cell, [waterSurface], `${TILE.id} land cell ${x},${z}`);
    for (const [index, polygon] of landParts.entries()) surfaceParts.push({ target: terrain, polygon, label: `${TILE.id} land boundary cell ${x},${z}/${index}` });
    for (const [index, polygon] of waterParts.entries()) surfaceParts.push({ target: water, polygon, label: `${TILE.id} water boundary cell ${x},${z}/${index}` });
  }
  const conforming = surfaceTopology === 'conforming-grid-boundary-stitch-v1' ? conformSurfacePartsToGridBoundaries(surfaceParts) : { parts: surfaceParts, insertedVertices: 0, gridBoundaryVertices: 0 };
  for (const { target, polygon, label } of conforming.parts) emitSurfacePolygon(target, polygon, sample, target === water ? waterCache : terrainCache, label, 0, surfaceHeight);
  if (directedCoastline) {
    for (const way of directedCoastline.ways) { water.sourceIds.add(way.id); coastline.sourceIds.add(way.id); }
    for (const points of directedCoastline.fragments) emitCoastEdge(coastline, { points }, sample);
  }
  const roadSurfaces = [];
  for (const way of features.filter((item) => item.tags.highway)) {
    let emitted = false; const half = roadWidth(way.tags) / 2;
    for (let i = 0; i < way.en.length - 1; i += 1) { const clipped = clipSegment(way.en[i], way.en[i + 1]); if (!clipped) continue; const [a, b] = clipped; const length = Math.hypot(b[0] - a[0], b[1] - a[1]); if (length < 0.05) continue;
      const dx = (b[0] - a[0]) / length; const dz = (b[1] - a[1]) / length; const ox = -dz * half; const oz = dx * half;
      const start = [a[0] - dx * half, a[1] - dz * half]; const end = [b[0] + dx * half, b[1] + dz * half];
      const corners = [[start[0] + ox, start[1] + oz], [start[0] - ox, start[1] - oz], [end[0] - ox, end[1] - oz], [end[0] + ox, end[1] + oz]]
        .map(([e, n]) => [Math.max(TILE.minE, Math.min(TILE.minE + TILE.size, e)), Math.max(TILE.minN, Math.min(TILE.minN + TILE.size, n))]).map(toTicks);
      if (new Set(corners.map((point) => point.join(','))).size >= 3) { roadSurfaces.push({ outers: [corners] }); emitted = true; }
    } if (emitted) roads.sourceIds.add(way.id);
  }
  if (roadSurfaces.length) {
    const roadCache = new Map(); const roadNetwork = unionRoadSurfaces(roadSurfaces, `${TILE.id} road network`);
    if (roadNetwork.polygons) for (const [index, polygon] of roadNetwork.polygons.entries()) emitRoadPolygon(roads, polygon, sample, roadCache, `${TILE.id} road network/${index}`);
    else emitRoadTriangles(roads, roadNetwork.triangles, sample, roadCache, `${TILE.id} road network fallback`);
  }
  for (const way of features.filter((item) => item.tags.building && item.refs[0] === item.refs.at(-1))) {
    const ring = clipPolygon(way.en.slice(0, -1)); if (ring.length < 3) continue; const faces = ShapeUtils.triangulateShape(ring.map(([e, n]) => new Vector2(e, n)), []); if (!faces.length) continue;
    const height = buildingHeight(way.tags); const floor = ring.map(([e, n]) => sample(e, n)); const bottom = []; const top = [];
    const presentationRecord = buildingPresentationProof ? { sourceOsmWayId: way.id, sourceTags: Object.fromEntries(['building', 'building:levels', 'building:material', 'facade:material', 'roof:material', 'roof:shape'].filter((key) => way.tags[key] !== undefined).map((key) => [key, way.tags[key]])), heightMetres: q(height), vertexStart: buildings.positions.length / 3, indexStart: buildings.indices.length, roofIndexCount: faces.length * 3, wallSegments: [] } : null;
    for (let i = 0; i < ring.length; i += 1) { bottom.push(vertex(buildings, ring[i][0], floor[i], ring[i][1])); top.push(vertex(buildings, ring[i][0], floor[i] + height, ring[i][1])); }
    for (const face of faces) { triangle(buildings, top[face[0]], top[face[2]], top[face[1]]); }
    for (let i = 0; i < ring.length; i += 1) { const j = (i + 1) % ring.length; const indexStart = buildings.indices.length; triangle(buildings, bottom[i], bottom[j], top[i]); triangle(buildings, top[i], bottom[j], top[j]);
      if (presentationRecord) presentationRecord.wallSegments.push({ indexStart, edgeLengthMetres: q(Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1])) });
    }
    if (presentationRecord) {
      presentationRecord.vertexCount = buildings.positions.length / 3 - presentationRecord.vertexStart;
      presentationRecord.indexCount = buildings.indices.length - presentationRecord.indexStart;
      buildings.presentationRecords.push(presentationRecord);
    }
    buildings.sourceIds.add(way.id);
  }
  if (TILE.id === FERRY_TILE.id) assert(buildings.sourceIds.has(558731934), 'Ferry Building OSM way 558731934 was not baked');
  const result = { terrain, water, coastline, roads, buildings };
  // Keep proof accounting available to the isolated builder without changing
  // the enumerable category contract used by GLB serialization and receipts.
  Object.defineProperty(result, 'surfaceTopologyProof', { value: Object.freeze({ mode: surfaceTopology, insertedVertices: conforming.insertedVertices, gridBoundaryVertices: conforming.gridBoundaryVertices }), enumerable: false });
  if (buildingPresentationProof) Object.defineProperty(result, 'buildingPresentationProof', { value: Object.freeze({ mode: 'source-building-facade-metadata-v1', records: Object.freeze(buildings.presentationRecords.map((record) => Object.freeze(record))) }), enumerable: false });
  return result;
}

function geometryBounds(categories) {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (const data of Object.values(categories)) for (let index = 0; index < data.positions.length; index += 3) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], data.positions[index + axis]); max[axis] = Math.max(max[axis], data.positions[index + axis]); }
  return { min, max };
}

function planAreaSquareMetres(data) {
  let area = 0;
  for (let index = 0; index < data.indices.length; index += 3) {
    const vertices = data.indices.slice(index, index + 3).map((vertexIndex) => [data.positions[vertexIndex * 3], data.positions[vertexIndex * 3 + 2]]);
    area += Math.abs((vertices[1][0] - vertices[0][0]) * (vertices[2][1] - vertices[0][1]) - (vertices[2][0] - vertices[0][0]) * (vertices[1][1] - vertices[0][1])) / 2;
  }
  return q(area);
}

function partitionIndexedCategory(data, maxVertices = 65_535) {
  const chunks = [];
  let positions = [];
  let indices = [];
  let remap = new Map();
  const flush = () => {
    if (indices.length) chunks.push({ positions, indices });
    positions = [];
    indices = [];
    remap = new Map();
  };
  for (let index = 0; index < data.indices.length; index += 3) {
    const triangleIndices = data.indices.slice(index, index + 3);
    const additionalVertices = triangleIndices.filter((sourceIndex) => !remap.has(sourceIndex)).length;
    if (remap.size + additionalVertices > maxVertices) flush();
    for (const sourceIndex of triangleIndices) {
      if (!remap.has(sourceIndex)) {
        remap.set(sourceIndex, remap.size);
        positions.push(...data.positions.slice(sourceIndex * 3, sourceIndex * 3 + 3));
      }
      indices.push(remap.get(sourceIndex));
    }
  }
  flush();
  return chunks;
}

function serializedMeshStats(categories) {
  return Object.fromEntries(Object.entries(categories).map(([name, data]) => {
    const partitions = partitionIndexedCategory(data);
    return [name, {
      vertices: partitions.reduce((sum, partition) => sum + partition.positions.length / 3, 0),
      indices: data.indices.length,
      triangles: data.indices.length / 3,
      sourceOsmWayCount: data.sourceIds.size,
      primitiveChunks: partitions.length,
    }];
  }));
}

function makeGlb(categories, level) {
  const allNames = ['terrain', 'water', 'coastline', 'roads', 'buildings']; const names = allNames.filter((name) => categories[name].positions.length); const chunks = []; const bufferViews = []; const accessors = []; const primitives = [];
  let offset = 0; const pad = () => { const count = (4 - offset % 4) % 4; if (count) { chunks.push(Buffer.alloc(count)); offset += count; } };
  const addView = (bytes, target) => { pad(); const index = bufferViews.length; bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target }); chunks.push(bytes); offset += bytes.length; return index; };
  for (const name of names) { const material = allNames.indexOf(name); const data = categories[name]; const partitions = partitionIndexedCategory(data);
    for (const [chunkIndex, partition] of partitions.entries()) { const positions = Buffer.alloc(partition.positions.length * 4); partition.positions.forEach((v, i) => positions.writeFloatLE(v, i * 4)); const indices = Buffer.alloc(partition.indices.length * 2); partition.indices.forEach((v, i) => indices.writeUInt16LE(v, i * 2));
    const positionView = addView(positions, 34962); const indexView = addView(indices, 34963); const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < partition.positions.length; index += 3) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], partition.positions[index + axis]); max[axis] = Math.max(max[axis], partition.positions[index + axis]); }
    const positionAccessor = accessors.length; accessors.push({ bufferView: positionView, componentType: 5126, count: partition.positions.length / 3, type: 'VEC3', min, max });
    const indexAccessor = accessors.length; accessors.push({ bufferView: indexView, componentType: 5123, count: partition.indices.length, type: 'SCALAR', min: [0], max: [partition.positions.length / 3 - 1] });
    primitives.push({ attributes: { POSITION: positionAccessor }, indices: indexAccessor, material, mode: 4, extras: { category: name, chunkIndex, chunkCount: partitions.length, sourceOsmWayIds: [...data.sourceIds].sort((a, b) => a - b) } });
    }
  }
  pad(); const bin = Buffer.concat(chunks); const gltf = { asset: { version: '2.0', generator: 'build-sf-metric-tile-v1' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: `${TILE.id}-lod${level}` }], meshes: [{ name: `${TILE.id}-lod${level}`, primitives }], materials: [
    { name: 'terrain-night', pbrMetallicRoughness: { baseColorFactor: [0.055, 0.075, 0.085, 1], metallicFactor: 0, roughnessFactor: 1 } },
    { name: 'water-osm-coastline-night', pbrMetallicRoughness: { baseColorFactor: [0.018, 0.16, 0.24, 1], metallicFactor: 0.05, roughnessFactor: 0.34 } },
    { name: 'coastline-osm-night', pbrMetallicRoughness: { baseColorFactor: [0.25, 0.78, 0.86, 1], metallicFactor: 0, roughnessFactor: 0.62 }, emissiveFactor: [0.025, 0.12, 0.14], doubleSided: true },
    { name: 'roads-night', pbrMetallicRoughness: { baseColorFactor: [0.105, 0.12, 0.135, 1], metallicFactor: 0, roughnessFactor: 0.92 } },
    { name: 'buildings-night', pbrMetallicRoughness: { baseColorFactor: [0.34, 0.28, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.86 } },
  ], buffers: [{ byteLength: bin.length }], bufferViews, accessors, extras: { tileId: TILE.id, lod: level, runtimeFrame: PROVISIONAL_FRAME, horizontalCrs: 'EPSG:26910', verticalCertification: 'source-declared-navd88-unrealized', tileOriginEpsg26910VerticalMetres: [TILE.minE, TILE.minN, TILE.originH], originTupleOrder: ['easting', 'northing', 'vertical'], vertexAxes: { x: 'eastMinusOriginEasting', y: 'verticalMinusOriginVertical', z: 'northMinusOriginNorthing' }, unitsPerMetre: 1 } };
  let json = Buffer.from(JSON.stringify(gltf)); const jsonPad = (4 - json.length % 4) % 4; if (jsonPad) json = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]); const total = 12 + 8 + json.length + 8 + bin.length; const out = Buffer.alloc(total); out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8); out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20); const at = 20 + json.length; out.writeUInt32LE(bin.length, at); out.writeUInt32LE(0x004e4942, at + 4); bin.copy(out, at + 8); return out;
}

function centroid(points) { const unique = points.at(0)[0] === points.at(-1)[0] && points.at(0)[1] === points.at(-1)[1] ? points.slice(0, -1) : points; return [unique.reduce((s, p) => s + p[0], 0) / unique.length, unique.reduce((s, p) => s + p[1], 0) / unique.length]; }

function representativeEn(feature) {
  if (feature.tags.building) {
    const ring = clipPolygon(feature.en.slice(0, feature.refs[0] === feature.refs.at(-1) ? -1 : undefined));
    if (ring.length >= 3) return centroid(ring);
  }
  const points = [];
  for (let index = 0; index < feature.en.length - 1; index += 1) { const segment = clipSegment(feature.en[index], feature.en[index + 1]); if (segment) points.push(...segment); }
  assert(points.length, `Emitted OSM way ${feature.id} has no in-tile representative point`);
  return centroid(points);
}

/**
 * Bake one native EPSG:26910 384 m tile.  `tile` may contain integer
 * `gridEasting`/`gridNorthing`; the Ferry default is retained for compatibility.
 */
async function buildSfMetricTileUnlocked({ tile: requestedTile, outputDir, write = true, sharedInputs = null, verifiedTerrainSourceDigests = null, terrainGridStepMetres = TERRAIN_STEP, lodLevel = 0, surfaceHeightOwnership = 'direct-native-pixel', surfaceTopology = 'independent-cell-polygons', terrainSelectionMode = DEFAULT_TERRAIN_SELECTION_MODE, buildingPresentationProof = false } = {}) {
  const previousTile = TILE; TILE = normalizeTile(requestedTile);
  let terrainSource = null;
  let terrainAuthorization = null;
  try {
    assert(Number.isInteger(terrainGridStepMetres) && terrainGridStepMetres >= 1 && TILE.size % terrainGridStepMetres === 0, 'terrainGridStepMetres must be a positive integer divisor of 384');
    assert(Number.isInteger(lodLevel) && lodLevel >= 0, 'lodLevel must be a non-negative integer');
    assert(['direct-native-pixel', 'canonical-1m-lattice-height-v1'].includes(surfaceHeightOwnership), 'Unknown surfaceHeightOwnership mode');
    assert(['independent-cell-polygons', 'conforming-grid-boundary-stitch-v1'].includes(surfaceTopology), 'Unknown surfaceTopology mode');
    assert(TERRAIN_SELECTION_MODES.has(terrainSelectionMode), `Unknown terrain selection mode ${terrainSelectionMode}`);
    assert(!buildingPresentationProof || !write, 'Building presentation metadata is an in-memory proof only and may not write production-shaped artifacts');
    assert(terrainSelectionMode !== NATIVE_PIXEL_FALLBACK_PROOF_MODE || !write, 'Per-native-pixel fallback terrain selection is an in-memory proof only and may not write artifacts');
    if (terrainSelectionMode === NATIVE_PIXEL_FALLBACK_PRODUCTION_MODE) terrainAuthorization = await loadSfNativePixelFallbackAuthorization({ requireProductionWrite: write });
    assert(terrainSelectionMode === DEFAULT_TERRAIN_SELECTION_MODE || (terrainGridStepMetres === TERRAIN_STEP && surfaceHeightOwnership === 'direct-native-pixel' && surfaceTopology === 'independent-cell-polygons'), 'Per-native-pixel fallback proof requires direct 1 m independent-cell surfaces');
    const isCanonicalLod0 = terrainGridStepMetres === TERRAIN_STEP && lodLevel === 0 && surfaceHeightOwnership === 'direct-native-pixel';
    assert((isCanonicalLod0 && surfaceTopology === 'independent-cell-polygons') || !write, 'Non-default terrain steps, LOD levels, surface ownership modes, or topology modes are in-memory proof builds only and may not write production-shaped artifacts');
    assert(surfaceHeightOwnership === 'direct-native-pixel' || (terrainGridStepMetres === TERRAIN_STEP && lodLevel === 0), 'Canonical lattice height ownership is limited to the 1 m LOD0 proof');
    assert(surfaceTopology === 'independent-cell-polygons' || surfaceHeightOwnership === 'canonical-1m-lattice-height-v1', 'Conforming topology proof requires canonical 1 m lattice height ownership');
    outputDir ??= defaultOutputDir(TILE);
    const stem = artifactStem(TILE);
    const [resolvedSharedInputs, terrainDescriptors] = await Promise.all([sharedInputs ?? loadSfMetricSharedInputs(), loadTerrainDescriptors(verifiedTerrainSourceDigests)]);
    const { pbfHash, horizontalLockBytes, geometryAuthBytes, horizontalLock, osmFeatureCache } = resolvedSharedInputs;
    assert.equal(pbfHash.sha256, PBF_SHA256, 'OSM PBF hash mismatch');
    const { bounds, features } = await readOsmFeatures(horizontalLock, osmFeatureCache); terrainSource = await openTerrainMosaic(terrainDescriptors, terrainSelectionMode);
    const authorizedFallbackWrite = terrainSelectionMode === NATIVE_PIXEL_FALLBACK_PRODUCTION_MODE && terrainAuthorization?.authorization.productionWriteEnabled === true;
    assert(!write || terrainSource.sources.every(({ descriptor }) => descriptor.productionEligible) || authorizedFallbackWrite, 'Fallback terrain sources are proof-only until an exact seam policy and per-pixel provenance authorization are locked');
    const baseGeometry = bakeGeometry(features, terrainSource.sample, terrainGridStepMetres, surfaceHeightOwnership, surfaceTopology, buildingPresentationProof); const geometries = [baseGeometry]; const categories = baseGeometry;
    for (const data of Object.values(categories)) for (const value of data.positions) assert(Number.isFinite(value), `Terrain selection emitted a non-finite geometry coordinate for ${TILE.id}`);
    const included = features.filter((feature) => (feature.tags.highway && categories.roads.sourceIds.has(feature.id)) || (feature.tags.building && categories.buildings.sourceIds.has(feature.id)) || (feature.tags.natural === 'coastline' && categories.water.sourceIds.has(feature.id)));
    const glbs = geometries.map((geometry, index) => { const level = lodLevel + index; return { level, name: `${stem}.lod${level}.glb`, bytes: makeGlb(geometry, level), geometry }; });
    const lods = glbs.map(({ level, bytes, name, geometry }) => ({ level, runtimeFrame: PROVISIONAL_FRAME, scale: [1, 1, 1], translationMetres: [0, 0, 0], maxHorizontalDeviationMetres: isCanonicalLod0 ? 0.000002 : null, maxVerticalDeviationMetres: isCanonicalLod0 ? 0.000002 : null, artifactHash: `sha256:${sha256(bytes)}`, path: `${relative(outputDir)}/${name}`, bytes: bytes.length, boundsLocalMetres: geometryBounds(geometry), meshStats: serializedMeshStats(geometry) }));
    const sourceFeatures = [];
    for (const feature of included) { const en = representativeEn(feature); const native = inverse(en[0], en[1], horizontalLock); const terrainEvidence = await terrainSource.evidence(en[0], en[1]); const evidencePayload = terrainEvidence.payload; const elevationSampleEvidence = { ...evidencePayload, evidenceSha256: `sha256:${sha256(stableBytes(evidencePayload))}` }; const height = elevationSampleEvidence.sampledSourceDeclaredNavd88UnrealizedMetres;
      const transformedPosition = [q(en[0]), q(en[1]), height];
      sourceFeatures.push({ sourceId: 'bbbike-sanfrancisco-osm-pbf', sourceFeatureId: `way/${feature.id}`, publisher: 'OpenStreetMap contributors; BBBike extract service', license: 'ODbL-1.0', retrievedAt: RETRIEVED_AT, nativeHorizontalCrs: 'EPSG:4326', nativeVerticalDatum: 'not-provided-by-2d-source', sourceLockId: 'sf-ferry-osm-horizontal-geometry-v1', horizontalTransformLockId: 'sf-ferry-3dep-2023-horizontal-crs-v1', verticalMode: 'terrain-sampled-source-declared-navd88-unrealized', verticalTransformLockId: 'terrain-sample-source-declared-navd88-unrealized', elevationSourceLockId: terrainEvidence.source.elevationLock.id, elevationSampleEvidence, sourceGeometryHash: `sha256:${sha256(stableBytes({ type: 'way', id: feature.id, tags: feature.tags, nodeIds: feature.refs, coordinatesLonLat: feature.lonLat.map(([lon, lat]) => [q(lon), q(lat)]) }))}`, nativeHorizontalPosition: [q(native[0]), q(native[1]), 0], transformedPositionEpsg26910VerticalMetres: transformedPosition, runtimePositionMetres: [q(transformedPosition[0] - TILE.minE), q(height - TILE.originH), q(transformedPosition[1] - TILE.minN)] });
    }
    const usesNativePixelFallback = terrainSelectionMode !== DEFAULT_TERRAIN_SELECTION_MODE;
    const terrainReceiptSources = terrainSource.sources.map((source) => ({
      path: source.sourceLock.raster.localRawCache,
      bytes: source.raw.bytes,
      sha256: source.raw.sha256,
      elevationSourceLockId: source.elevationLock.id,
      ...(usesNativePixelFallback
        ? { role: source.descriptor.productionEligible ? 'original-probe-and-candidate' : 'californiagaps-fallback-probe-and-candidate', candidateCell: source.cellKey, ownershipMode: 'per-native-pixel-selection-candidate' }
        : { ownershipCell: source.cellKey }),
      verticalCertification: 'source-declared-navd88-unrealized',
      reader: 'geotiff-window-reader-v1',
      window: { column: source.window.column, row: source.window.row, width: source.window.width, height: source.window.height },
    }));
    const terrainSampling = usesNativePixelFallback ? 'source-locked-original-first-per-native-pixel-with-californiagaps-nodata-fallback-v1' : 'canonical-10km-cell-owned-direct-native-pixel-float32-le';
    const packageDescriptor = { schemaVersion: 1, kind: 'sf-one-to-one-map-package', status: 'provisional-vertical-unrealized', contractId: 'sf-one-to-one-reality-v1', coordinateReference: { horizontal: { crs: 'EPSG:26910', unit: 'metre' }, vertical: { datum: 'source-declared-navd88-unrealized', unit: 'metre' }, runtimeFrame: PROVISIONAL_FRAME }, verticalCertification: 'source-declared-navd88-unrealized', runtimeAxes: { x: 'east', y: 'up', z: 'north' }, scale: { runtimeUnitsPerMetre: 1, horizontalScale: 1, verticalScale: 1, verticalExaggeration: 0 }, tiling: { scheme: 'rectilinear-utm', tileSizeMetres: 384, sourceBufferMetres: 16 }, tileOriginEpsg26910VerticalMetres: [TILE.minE, TILE.minN, TILE.originH], authorizedHorizontalTransform: { id: 'sf-ferry-3dep-2023-horizontal-crs-v1', path: ['EPSG:1188-inverse', 'EPSG:26910-projection'], absoluteHorizontalAccuracyFloorMetres: 4, nad83Realization: 'not-claimed', coordinateEpoch: 'not-claimed' }, accuracyQualification: { absoluteHorizontalAccuracyFloorMetres: 4, nad83Realization: 'not-claimed', coordinateEpoch: 'not-claimed', lodErrorIsRelativeToTransformedSource: true }, sourceLocks: [
      { id: 'sf-ferry-osm-horizontal-geometry-v1', path: relative(GEOMETRY_AUTH_PATH), sha256: sha256(geometryAuthBytes), purpose: 'geometry' }, { id: 'sf-ferry-3dep-2023-horizontal-crs-v1', path: relative(HORIZONTAL_LOCK_PATH), sha256: sha256(horizontalLockBytes), purpose: 'horizontal-coordinate-operation' }, ...terrainSource.sources.map((source) => ({ id: source.elevationLock.id, path: relative(source.descriptor.elevationLockPath), sha256: sha256(source.descriptor.elevationLockBytes), purpose: 'terrain-elevation' })),
    ], sourceFeatures, lods: lods.map(({ path: _path, bytes: _bytes, boundsLocalMetres: _bounds, meshStats: _stats, ...lod }) => lod) };
    const landAreaSquareMetres = planAreaSquareMetres(categories.terrain); const waterAreaSquareMetres = planAreaSquareMetres(categories.water);
    assert(Math.abs(landAreaSquareMetres + waterAreaSquareMetres - TILE.size ** 2) <= 0.001, 'Land and OSM-classified water must partition the tile without gaps or overlap');
    const receipt = { schemaVersion: 1, kind: 'sf-metric-tile-build-receipt', id: stem, status: 'provisional-vertical-unrealized', tile: { identity: TILE.id, gridIndex: [TILE.minE / TILE.size, TILE.minN / TILE.size], boundsEpsg26910Metres: [TILE.minE, TILE.minN, TILE.minE + TILE.size, TILE.minN + TILE.size], originEpsg26910VerticalMetres: [TILE.minE, TILE.minN, TILE.originH], originTupleOrder: ['easting', 'northing', 'vertical'], runtimeFrame: PROVISIONAL_FRAME, vertexAxes: { x: 'eastMinusOriginEasting', y: 'verticalMinusOriginVertical', z: 'northMinusOriginNorthing' }, scale: 1 }, source: { osmPbf: { path: relative(PBF_PATH), bytes: pbfHash.bytes, sha256: pbfHash.sha256, queryBoundsWgs84: bounds }, geoTiffs: terrainReceiptSources }, counts: { osmCandidateWays: features.length, emittedCoastlineWays: categories.water.sourceIds.size, emittedRoadWays: categories.roads.sourceIds.size, emittedBuildingWays: categories.buildings.sourceIds.size, packageSourceFeatures: sourceFeatures.length, terrainVertices: categories.terrain.positions.length / 3, waterVertices: categories.water.positions.length / 3, coastlineVertices: categories.coastline.positions.length / 3, roadVertices: categories.roads.positions.length / 3, buildingVertices: categories.buildings.positions.length / 3 }, surfaceClassification: { authority: 'OpenStreetMap natural=coastline ways in the byte-locked PBF', coastlineDirectionRule: 'OSM coastline direction: land on left, water on right', sourceOsmWayIds: [...categories.water.sourceIds].sort((a, b) => a - b), landAreaSquareMetres, waterAreaSquareMetres, partitionAreaSquareMetres: q(landAreaSquareMetres + waterAreaSquareMetres), waterVerticalMode: 'terrain-sampled-source-declared-navd88-unrealized; hydrologic classification only, not a tidal or hydroflattened water level', terrainWaterOverlapAreaSquareMetres: 0 }, ferryBuilding: TILE.id === FERRY_TILE.id ? { sourceFeatureId: 'way/558731934', present: categories.buildings.sourceIds.has(558731934) } : null, lods, relationCoverage: { implemented: false, statement: 'Directed OSM coastline ways are represented for coastal land/water ownership. Unassembled OSM multipolygon relations remain unrepresented and are not claimed as coverage.' }, deterministicInputs: { ...(usesNativePixelFallback ? { terrainSelectionMode } : {}), availableLods: [0], terrainGridStepMetres: TERRAIN_STEP, terrainSampling, terrainCellOwnership: 'half-open EPSG:26910 10000m cells; exact boundary belongs west/south via 1e-7m epsilon', surfaceGridMetres: 1 / SURFACE_TICKS_PER_METRE, lod0Construction: '1 m terrain cells partitioned by directed OSM coastline into exclusive terrain/water primitives, plus coastline edge, OSM roads, and buildings', lod0DeviationMetres: 0, geometryQuantizationDecimalPlaces: 6, buildingHeightPolicy: 'OSM height, else building:levels*3.2m, else 9.6m', roadWidthPolicy: 'OSM width, else deterministic highway-class/lanes table' } };
    const terrainSelectionProof = terrainSource.proof?.finalize?.() ?? null;
    if (terrainSelectionProof) {
      const evidence = { mode: terrainSelectionProof.mode, status: terrainSelectionProof.status, verticalCertification: terrainSelectionProof.verticalCertification, selectionPolicyName: terrainSelectionProof.selectionPolicyName, selectionPolicyHash: terrainSelectionProof.selectionPolicyHash, rule: terrainSelectionProof.rule, sourceLocks: terrainSelectionProof.sourceLocks, sampleLedgerSha256: terrainSelectionProof.sampleLedgerSha256, sharedEdgeLedgerSha256: terrainSelectionProof.sharedEdgeLedgerSha256, counts: terrainSelectionProof.counts };
      receipt.terrainSelectionEvidence = evidence;
      packageDescriptor.terrainSelectionEvidence = evidence;
    }
    if (terrainAuthorization) {
      const authorizationEvidence = { id: terrainAuthorization.authorization.id, path: relative(NATIVE_PIXEL_AUTH_PATH), sha256: terrainAuthorization.authorizationSha256, status: terrainAuthorization.authorization.status, productionWriteEnabled: terrainAuthorization.authorization.productionWriteEnabled, promotionGate: terrainAuthorization.authorization.promotionGate, policyName: terrainAuthorization.authorization.policy.name, policySha256: terrainAuthorization.authorization.policy.sha256, sources: terrainAuthorization.authorization.sources };
      receipt.terrainOwnershipAuthorization = authorizationEvidence;
      packageDescriptor.terrainOwnershipAuthorization = authorizationEvidence;
    }
    try { await terrainSource.close(); } finally { terrainSource = null; }
    if (write) { await mkdir(outputDir, { recursive: true }); await Promise.all([...glbs.map((glb) => writeFile(path.join(outputDir, glb.name), glb.bytes)), writeFile(path.join(outputDir, `${stem}.receipt.json`), jsonBytes(receipt)), writeFile(path.join(outputDir, `${stem}.package.json`), jsonBytes(packageDescriptor))]); }
    const result = { outputDir, glbs, receipt, packageDescriptor, categories };
    if (terrainSelectionProof) result.terrainSelectionProof = terrainSelectionProof;
    if (buildingPresentationProof) result.buildingPresentationProof = baseGeometry.buildingPresentationProof;
    return result;
  } finally {
    try { await terrainSource?.close(); } finally { TILE = previousTile; }
  }
}

export function buildSfMetricTile(options = {}) {
  const task = buildSfMetricTileQueue.then(() => buildSfMetricTileUnlocked(options));
  buildSfMetricTileQueue = task.catch(() => {});
  return task;
}

export async function buildFerryProductionTile(options = {}) { return buildSfMetricTile(options); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2); const valueAfter = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const gridEasting = valueAfter('--grid-easting'); const gridNorthing = valueAfter('--grid-northing');
  assert.equal((gridEasting === null), (gridNorthing === null), 'Pass --grid-easting and --grid-northing together');
  const tile = gridEasting === null ? undefined : { gridEasting: Number(gridEasting), gridNorthing: Number(gridNorthing) };
  const outputDirArgument = valueAfter('--output-dir');
  assert(!args.includes('--output-dir') || outputDirArgument, '--output-dir requires a directory');
  const outputDir = outputDirArgument ? path.resolve(ROOT, outputDirArgument) : undefined;
  const result = await buildSfMetricTile({ tile, outputDir });
  process.stdout.write(`${JSON.stringify({ result: 'SF metric tile baked', tile: result.receipt.tile, status: result.receipt.status, counts: result.receipt.counts, lods: result.receipt.lods.map(({ level, artifactHash, path: artifactPath }) => ({ level, artifactHash, path: artifactPath })) }, null, 2)}\n`);
}
