/**
 * Offline gates for checked-in Earth tile metadata. No source data, geometry,
 * runtime handoff, or published tile artifact is inferred from a manifest.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TILES_DIR = path.join(ROOT, 'public/data/world/tiles');
const REGION_PATH = path.join(ROOT, 'public/data/world/regions/sf-ferry-building-hero.region.json');
const requestedPath = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : null;
const requiredLayers = [
  'terrain', 'shoreline', 'water', 'roads', 'sidewalks', 'buildings',
  'streetFurniture', 'pedestrianGraph', 'trafficGraph', 'npcs', 'vehicles',
  'lighting', 'weather', 'audio', 'collision',
];
const requiredChecks = [
  'provenance-lock', 'geometry-and-shoreline', 'road-sidewalk-continuity',
  'portal-handoff', 'character-grounding', 'npc-and-traffic-safety',
  'weather-water-lighting', 'fixed-camera-visual-review', 'performance-budget',
];

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertBounds(name, bounds) {
  assert(Array.isArray(bounds) && bounds.length === 4, `${name} must be [minX, minY, maxX, maxY]`);
  assert(bounds.every(isFiniteNumber), `${name} must contain finite numbers`);
  assert(bounds[0] < bounds[2] && bounds[1] < bounds[3], `${name} must have positive area`);
}

function assertPointInBounds(name, point, bounds) {
  assert(Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(isFiniteNumber), `${name} must be a finite [x, y] point`);
  assert(point[0] >= bounds[0] && point[0] <= bounds[2] && point[1] >= bounds[1] && point[1] <= bounds[3], `${name} must be inside ${JSON.stringify(bounds)}`);
}

function validateTile(manifest) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported schemaVersion');
  assert.equal(manifest.kind, 'earth-walkable-tile', 'Unexpected manifest kind');
  assert.match(manifest.id, /^[a-z0-9-]+$/, 'Tile id must be stable lowercase kebab case');
  assert.equal(manifest.world?.id, 'earth-v1', 'Tile must declare the shared Earth world id');
  assert(Array.isArray(manifest.world?.wgs84Anchor) && manifest.world.wgs84Anchor.length === 3, 'Missing WGS84 anchor');
  assert(manifest.world.wgs84Anchor.every(isFiniteNumber), 'WGS84 anchor must be finite');

  const grid = manifest.grid;
  assert.equal(grid?.tileSizeMeters, 384, 'Earth walkable tiles use a 384 m grid');
  assert.equal(grid?.buildBufferMeters, 16, 'Earth walkable tiles require a 16 m build buffer');
  assert.equal(grid?.indexBase, 0, 'Grid indexes must declare zero-based identity');
  assert(Array.isArray(grid?.index) && grid.index.length === 2 && grid.index.every(Number.isInteger), 'Grid index must be two integers');
  assertBounds('localBoundsMeters', grid.localBoundsMeters);
  assertBounds('localBuildBoundsMeters', grid.localBuildBoundsMeters);
  assertBounds('wgs84Bounds', grid.wgs84Bounds);
  assertBounds('wgs84BuildBounds', grid.wgs84BuildBounds);
  assert.equal(grid.localBoundsMeters[2] - grid.localBoundsMeters[0], 384, 'Tile width must be 384 m');
  assert.equal(grid.localBoundsMeters[3] - grid.localBoundsMeters[1], 384, 'Tile height must be 384 m');
  assert.equal(grid.localBuildBoundsMeters[0], grid.localBoundsMeters[0] - 16, 'West buffer mismatch');
  assert.equal(grid.localBuildBoundsMeters[1], grid.localBoundsMeters[1] - 16, 'South buffer mismatch');
  assert.equal(grid.localBuildBoundsMeters[2], grid.localBoundsMeters[2] + 16, 'East buffer mismatch');
  assert.equal(grid.localBuildBoundsMeters[3], grid.localBoundsMeters[3] + 16, 'North buffer mismatch');

  const [x, y] = grid.index;
  assert.equal(manifest.id, `sf-local-${x}-${y}`, 'Tile id must agree with grid indexes');
  assert.equal(grid.localBoundsMeters[0], x * 384, 'Local west bound must agree with grid X index');
  assert.equal(grid.localBoundsMeters[1], y * 384, 'Local south bound must agree with grid Y index');
  const [lon, lat] = manifest.world.wgs84Anchor;
  assert(lon >= grid.wgs84Bounds[0] && lon <= grid.wgs84Bounds[2], 'Anchor longitude must be inside this tile');
  assert(lat >= grid.wgs84Bounds[1] && lat <= grid.wgs84Bounds[3], 'Anchor latitude must be inside this tile');
  assert.equal(manifest.world.geodeticKey, `earth-v1:${lat.toFixed(6)}:${lon.toFixed(6)}`, 'Geodetic key must match this tile anchor');

  const expectedNeighbors = {
    north: `sf-local-${x}-${y + 1}`,
    east: `sf-local-${x + 1}-${y}`,
    south: `sf-local-${x}-${y - 1}`,
    west: `sf-local-${x - 1}-${y}`,
  };
  assert.deepEqual(manifest.neighbors, expectedNeighbors, 'Neighbor ids must agree with the regular grid');

  const expectedIdentity = `earth-tile-v1|${grid.scheme}|${manifest.id}|${grid.tileSizeMeters}|${grid.buildBufferMeters}|${grid.localBoundsMeters[0]}|${grid.localBoundsMeters[1]}`;
  assert.equal(manifest.determinism?.identity, expectedIdentity, 'Deterministic identity drifted');
  assert.equal(manifest.determinism?.seed, createHash('sha256').update(expectedIdentity).digest('hex'), 'Seed must be the SHA-256 of the deterministic identity');

  assert.equal(manifest.status, 'planned', 'These Ferry coverage tiles are metadata-only planned tiles');
  assert(Array.isArray(manifest.sources) && manifest.sources.length >= 3, 'Tile needs source provenance records');
  for (const source of manifest.sources) {
    assert.match(source.id || '', /^[a-z0-9-]+$/, 'Source id must be stable lowercase kebab case');
    assert(Array.isArray(source.role) && source.role.length > 0, `Source ${source.id} needs a role`);
    assert(typeof source.license === 'string' && source.license.length > 0, `Source ${source.id} needs a license`);
    assert(typeof source.attribution === 'string' && source.attribution.length > 0, `Source ${source.id} needs attribution`);
    assert(!/google(?:maps|earth|streetview)?/i.test(JSON.stringify(source)), `Source ${source.id} must not be Google-derived`);
  }
  assert(Array.isArray(manifest.lod) && manifest.lod.length === 3, 'Tile needs three LOD slots');
  assert.deepEqual(manifest.lod.map(({ level }) => level), [0, 1, 2], 'LOD levels must be 0, 1, 2');
  for (const layer of requiredLayers) {
    assert.equal(manifest.runtimeLayers?.[layer]?.required, true, `Missing required runtime layer: ${layer}`);
    assert(['planned', 'blocked-by-source-lock'].includes(manifest.runtimeLayers[layer].state), `Layer ${layer} cannot claim a published artifact`);
  }
  assert.deepEqual(manifest.qaContract?.requiredChecks, requiredChecks, 'QA contract drifted');
  assert.equal(manifest.qaContract?.seamToleranceMeters, 0.01, 'Seam tolerance must be 1 cm');
  return manifest;
}

function validateFerryRegion(region, manifests) {
  assert.equal(region.schemaVersion, 1, 'Unsupported Ferry region schema');
  assert.equal(region.kind, 'earth-walkable-region', 'Unexpected Ferry region kind');
  assert.equal(region.id, 'sf-ferry-building-hero', 'Ferry region id drifted');
  assert.equal(region.status, 'live-runtime-region-with-planned-production-tiles', 'Region status must not imply published assets');
  assert.equal(region.productionState?.tileArtifacts, 'not-published', 'Tile artifact state must remain honest');
  assert.equal(region.productionState?.directNeighborArtifacts, 'not-published', 'Neighbor artifact state must remain honest');
  assert.equal(region.productionState?.runtimeHandoff, 'not-yet-backed-by-published-tile-artifacts', 'Runtime handoff state must remain honest');

  const runtime = region.liveRuntime;
  assertBounds('liveRuntime.localBoundsMeters', runtime?.localBoundsMeters);
  assertBounds('liveRuntime.localBufferedBoundsMeters', runtime?.localBufferedBoundsMeters);
  assertPointInBounds('launchPositionMeters', runtime.launchPositionMeters, runtime.localBoundsMeters);
  assertPointInBounds('launchPositionMeters', runtime.launchPositionMeters, runtime.localBufferedBoundsMeters);
  assert(Array.isArray(runtime.landmarks) && runtime.landmarks.length === 1, 'Ferry contract needs exactly one tower anchor');
  assert.equal(runtime.landmarks[0].id, 'ferry-building-clock-tower', 'Ferry tower id drifted');
  assert.equal(runtime.landmarks[0].heightMeters, 74, 'Ferry tower height drifted');
  assertPointInBounds('Ferry tower', runtime.landmarks[0].positionMeters, runtime.localBoundsMeters);

  const coverage = region.tileCoverage;
  assert.deepEqual(coverage.tileIds, ['sf-local-5-4', 'sf-local-6-4', 'sf-local-5-5', 'sf-local-6-5'], 'Ferry coverage must use the exact 2 x 2 regular grid');
  assert.deepEqual(coverage.gridIndexes, [[5, 4], [6, 4], [5, 5], [6, 5]], 'Ferry coverage grid index drifted');
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const coveredTiles = coverage.tileIds.map((id) => {
    assert(byId.has(id), `Ferry coverage manifest is missing: ${id}`);
    return byId.get(id);
  });
  const xs = [...new Set(coveredTiles.map((tile) => tile.grid.index[0]))].sort((a, b) => a - b);
  const ys = [...new Set(coveredTiles.map((tile) => tile.grid.index[1]))].sort((a, b) => a - b);
  assert.deepEqual(xs, [5, 6], 'Ferry coverage needs both regular X cells');
  assert.deepEqual(ys, [4, 5], 'Ferry coverage needs both regular Y cells');
  for (const x of xs) for (const y of ys) assert(byId.has(`sf-local-${x}-${y}`), `Ferry coverage has a regular-grid gap at ${x},${y}`);
  const actualCoverage = [xs[0] * 384, ys[0] * 384, (xs.at(-1) + 1) * 384, (ys.at(-1) + 1) * 384];
  assert.deepEqual(coverage.coverageBoundsMeters, actualCoverage, 'Ferry coverage bounds must agree with the complete regular grid');
  for (const [name, bounds] of [['live region', runtime.localBoundsMeters], ['live buffer', runtime.localBufferedBoundsMeters]]) {
    assert(bounds[0] >= actualCoverage[0] && bounds[1] >= actualCoverage[1] && bounds[2] <= actualCoverage[2] && bounds[3] <= actualCoverage[3], `${name} is not fully covered by the planned regular tiles`);
  }

  for (const tile of coveredTiles) {
    for (const [direction, neighborId] of Object.entries(tile.neighbors)) {
      const neighbor = byId.get(neighborId);
      if (!neighbor) continue;
      const opposite = { north: 'south', east: 'west', south: 'north', west: 'east' }[direction];
      assert.equal(neighbor.neighbors[opposite], tile.id, `${tile.id} and ${neighborId} must be reciprocal regular neighbors`);
    }
  }
}

const manifestPaths = requestedPath
  ? [requestedPath]
  : readdirSync(TILES_DIR).filter((name) => name.endsWith('.manifest.json')).sort().map((name) => path.join(TILES_DIR, name));
const manifests = manifestPaths.map((filePath) => validateTile(loadJson(filePath)));
if (!requestedPath) validateFerryRegion(loadJson(REGION_PATH), manifests);

console.log(JSON.stringify({
  result: 'world tile metadata contract passed',
  tiles: manifests.map(({ id, determinism, neighbors }) => ({ id, seed: determinism.seed, neighbors })),
  ferryRegionVerified: !requestedPath,
  requiredLayers: requiredLayers.length,
  qaChecks: requiredChecks.length,
}, null, 2));
