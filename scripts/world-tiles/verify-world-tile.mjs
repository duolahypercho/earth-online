/**
 * Offline contract gate for an Earth-scale walkable tile manifest.
 * It intentionally validates only checked-in metadata; source acquisition and
 * geometry construction remain separate, reproducible build stages.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_MANIFEST = path.join(ROOT, 'public/data/world/tiles/sf-local-6-5.manifest.json');
const manifestPath = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : DEFAULT_MANIFEST;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertBounds(name, bounds) {
  assert(Array.isArray(bounds) && bounds.length === 4, `${name} must be [minX, minY, maxX, maxY]`);
  assert(bounds.every(isFiniteNumber), `${name} must contain finite numbers`);
  assert(bounds[0] < bounds[2] && bounds[1] < bounds[3], `${name} must have positive area`);
}

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
assert(grid.wgs84Bounds[0] <= manifest.world.wgs84Anchor[0] && manifest.world.wgs84Anchor[0] <= grid.wgs84Bounds[2], 'Anchor longitude must be inside tile');
assert(grid.wgs84Bounds[1] <= manifest.world.wgs84Anchor[1] && manifest.world.wgs84Anchor[1] <= grid.wgs84Bounds[3], 'Anchor latitude must be inside tile');

const expectedNeighbors = {
  north: `sf-local-${x}-${y + 1}`,
  east: `sf-local-${x + 1}-${y}`,
  south: `sf-local-${x}-${y - 1}`,
  west: `sf-local-${x - 1}-${y}`,
};
assert.deepEqual(manifest.neighbors, expectedNeighbors, 'Neighbor ids must agree with the regular grid');

const expectedIdentity = `earth-tile-v1|${grid.scheme}|${manifest.id}|${grid.tileSizeMeters}|${grid.buildBufferMeters}|${grid.localBoundsMeters[0]}|${grid.localBoundsMeters[1]}`;
assert.equal(manifest.determinism?.identity, expectedIdentity, 'Deterministic identity drifted');
const expectedSeed = createHash('sha256').update(expectedIdentity).digest('hex');
assert.equal(manifest.determinism?.seed, expectedSeed, 'Seed must be the SHA-256 of the deterministic identity');

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
}
assert.deepEqual(manifest.qaContract?.requiredChecks, requiredChecks, 'QA contract drifted');
assert.equal(manifest.qaContract?.seamToleranceMeters, 0.01, 'Seam tolerance must be 1 cm');

console.log(JSON.stringify({
  result: 'world tile manifest contract passed',
  tile: manifest.id,
  seed: manifest.determinism.seed,
  neighbors: manifest.neighbors,
  requiredLayers: requiredLayers.length,
  qaChecks: requiredChecks.length,
}, null, 2));
