import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const artifactPath = new URL('../../public/data/world/preview/sf-ferry-building-west-preview-v1.json', import.meta.url);
const cityPath = new URL('../../public/data/sf/sf-city.json', import.meta.url);
const elevationPath = new URL('../../public/data/sf/sf-elevation.json', import.meta.url);
const [raw, cityRaw, elevationRaw] = await Promise.all([readFile(artifactPath), readFile(cityPath), readFile(elevationPath)]);
const artifact = JSON.parse(raw);
const city = JSON.parse(cityRaw);
const elevation = JSON.parse(elevationRaw);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalPayload = ({ contentSha256, ...payload }) => JSON.stringify(payload);
const pairs = (feature) => Array.from({ length: Math.floor((feature.points?.length || 0) / 2) }, (_, index) => [feature.points[index * 2], feature.points[index * 2 + 1]]);
const hasPointIn = (feature, [minX, minZ, maxX, maxZ]) => pairs(feature).some(([x, z]) => x >= minX && x <= maxX && z >= minZ && z <= maxZ);
const elevationAt = (x, z) => {
  const { originX, originZ, cellSize, width, height, grid } = elevation;
  const gx = (x - originX) / cellSize;
  const gz = (z - originZ) / cellSize;
  const x0 = Math.floor(gx); const z0 = Math.floor(gz);
  const tx = gx - x0; const tz = gz - z0;
  const sample = (column, row) => (column < 0 || row < 0 || column >= width || row >= height ? 0 : grid[row * width + column] || 0);
  return (sample(x0, z0) * (1 - tx) + sample(x0 + 1, z0) * tx) * (1 - tz)
    + (sample(x0, z0 + 1) * (1 - tx) + sample(x0 + 1, z0 + 1) * tx) * tz;
};

assert.equal(artifact.kind, 'earth-walkable-preview-neighbor');
assert.equal(artifact.status, 'preview');
assert.equal(artifact.previewOnly, true);
assert.equal(artifact.id, 'sf-ferry-building-west-preview-v1');
assert.deepEqual(artifact.bounds.coreMeters, [1760, 1728, 2144, 2112]);
assert.deepEqual(artifact.bounds.bufferedMeters, [1744, 1712, 2160, 2128]);
assert.equal(artifact.relationship.originTileId, 'sf-ferry-building-v1');
assert.equal(artifact.relationship.sharedEdge.ownerTileId, 'sf-ferry-building-v1');
assert.ok(artifact.relationship.sharedEdge.quantizationMeters <= 0.01);
assert.equal(artifact.contentSha256, sha256(canonicalPayload(artifact)), 'content digest must cover the complete artifact payload');
assert.equal(artifact.source.citySha256, sha256(cityRaw));
assert.equal(artifact.source.elevationSha256, sha256(elevationRaw));
assert.ok(artifact.source.filteredStableOsmIds.roads.length > 0 && artifact.source.filteredStableOsmIds.buildings.length > 0);
assert.deepEqual(artifact.source.filteredStableOsmIds.roads, [...artifact.source.filteredStableOsmIds.roads].sort((a, b) => a - b), 'road ids must be stable sorted');
assert.deepEqual(artifact.source.filteredStableOsmIds.buildings, [...artifact.source.filteredStableOsmIds.buildings].sort((a, b) => a - b), 'building ids must be stable sorted');
assert.deepEqual(artifact.runtime.roads.map((feature) => feature.id).sort((a, b) => a - b), artifact.source.filteredStableOsmIds.roads);
assert.deepEqual(artifact.runtime.buildings.map((feature) => feature.id).sort((a, b) => a - b), artifact.source.filteredStableOsmIds.buildings);
for (const feature of artifact.runtime.roads) assert.ok(hasPointIn(feature, artifact.bounds.bufferedMeters), `road ${feature.id} escaped preview source window`);
for (const feature of artifact.runtime.buildings) assert.ok(hasPointIn(feature, artifact.bounds.bufferedMeters), `building ${feature.id} escaped preview source window`);
assert.equal(artifact.runtime.terrain.heightsMeters.length, artifact.runtime.terrain.gridSize ** 2);
const edgeError = Math.max(...artifact.relationship.sharedEdge.samples.map(([x, z, value]) => Math.abs(elevationAt(x, z) - value)));
assert.ok(edgeError <= 0.01, `shared edge mismatch ${edgeError}m exceeds 1cm`);
assert.ok(artifact.productionBlockers.some((value) => /Source-lock/.test(value)));
assert.ok(artifact.productionBlockers.some((value) => /NAVD88/.test(value)));

console.log(JSON.stringify({ result: 'passed', id: artifact.id, roads: artifact.runtime.roads.length, buildings: artifact.runtime.buildings.length, edgeErrorMeters: edgeError, contentSha256: artifact.contentSha256, productionBlockers: artifact.productionBlockers }, null, 2));
