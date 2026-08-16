/** Verify the checked-in contiguous SF runtime set and its exact source receipts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.kind, 'sf-metric-tile-set'); assert.equal(manifest.status, 'provisional-vertical-unrealized'); assert.equal(manifest.coordinateReference.horizontal.crs, 'EPSG:26910'); assert.equal(manifest.tiling.tileSizeMetres, 384);
assert(manifest.tiles.length >= 3, 'Runtime set must retain at least the three verified waterfront tiles');
const tileIds = manifest.tiles.map(({ id }) => id);
assert.equal(new Set(tileIds).size, tileIds.length, 'Runtime manifest tile IDs must be unique');
assert.deepEqual([...manifest.tiles].sort((a, b) => a.gridIndex[1] - b.gridIndex[1] || a.gridIndex[0] - b.gridIndex[0]).map(({ id }) => id), tileIds, 'Runtime tiles must use stable south-to-north, west-to-east ordering');
for (const required of ['epsg26910-1440-10893', 'epsg26910-1441-10893', 'epsg26910-1440-10894']) assert(tileIds.includes(required), `Runtime set lost required source-ready tile ${required}`);
for (const tile of manifest.tiles) {
  assert.deepEqual(tile.originEpsg26910VerticalMetres, [tile.gridIndex[0] * 384, tile.gridIndex[1] * 384, 0]);
  const [glb, receiptBytes] = await Promise.all([readFile(path.join(ROOT, tile.lod0.path)), readFile(path.join(ROOT, tile.receipt.path))]);
  assert.equal(sha256(glb), tile.lod0.sha256); assert.equal(sha256(receiptBytes), tile.receipt.sha256);
  const receipt = JSON.parse(receiptBytes); assert.equal(receipt.tile.identity, tile.id); assert.deepEqual(receipt.tile.originEpsg26910VerticalMetres, tile.originEpsg26910VerticalMetres); assert.equal(receipt.source.osmPbf.sha256, 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae'); assert(Array.isArray(receipt.source.geoTiffs) && receipt.source.geoTiffs.length >= 1, 'Tile receipt must expose every terrain raster in its deterministic mosaic'); assert(receipt.source.geoTiffs.every(({ sha256: hash, ownershipCell }) => /^[a-f0-9]{64}$/.test(hash) && /^\d+,\d+$/.test(ownershipCell)), 'Terrain mosaic source identity is incomplete'); assert.deepEqual(receipt.deterministicInputs.availableLods, [0]); assert.equal(receipt.deterministicInputs.terrainGridStepMetres, 1); assert.equal(receipt.relationCoverage.implemented, false); assert.equal(receipt.surfaceClassification.terrainWaterOverlapAreaSquareMetres, 0); assert(Math.abs(receipt.surfaceClassification.partitionAreaSquareMetres - 384 ** 2) <= 0.001);
}
const byGrid = new Set(manifest.tiles.map(({ gridIndex: [e, n] }) => `${e},${n}`));
const visited = new Set([`${manifest.tiles[0].gridIndex[0]},${manifest.tiles[0].gridIndex[1]}`]);
const queue = [...visited];
while (queue.length) {
  const current = queue.shift(); const [e, n] = current.split(',').map(Number);
  for (const neighbor of [`${e - 1},${n}`, `${e + 1},${n}`, `${e},${n - 1}`, `${e},${n + 1}`]) if (byGrid.has(neighbor) && !visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
}
assert.equal(visited.size, manifest.tiles.length, 'Runtime tile set must form one 4-connected district');
console.log(JSON.stringify({ result: 'SF metric tile set passed', manifest: path.relative(ROOT, manifestPath), tileIds: manifest.tiles.map(({ id }) => id) }, null, 2));
