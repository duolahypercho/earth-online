/** Verify the checked-in contiguous Ferry waterfront runtime set and its exact source receipts. */
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
assert.deepEqual(manifest.tiles.map(({ id }) => id), ['epsg26910-1440-10893', 'epsg26910-1441-10893', 'epsg26910-1441-10894']);
for (const tile of manifest.tiles) {
  assert.deepEqual(tile.originEpsg26910VerticalMetres, [tile.gridIndex[0] * 384, tile.gridIndex[1] * 384, 0]);
  const [glb, receiptBytes] = await Promise.all([readFile(path.join(ROOT, tile.lod0.path)), readFile(path.join(ROOT, tile.receipt.path))]);
  assert.equal(sha256(glb), tile.lod0.sha256); assert.equal(sha256(receiptBytes), tile.receipt.sha256);
  const receipt = JSON.parse(receiptBytes); assert.equal(receipt.tile.identity, tile.id); assert.deepEqual(receipt.tile.originEpsg26910VerticalMetres, tile.originEpsg26910VerticalMetres); assert.equal(receipt.source.osmPbf.sha256, 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae'); assert.equal(receipt.source.geoTiff.sha256, '9cc9c03f4ddaf8ec6712951b980157ea02293c7723761466e6e60f21147a9424'); assert.deepEqual(receipt.deterministicInputs.availableLods, [0]); assert.equal(receipt.deterministicInputs.terrainGridStepMetres, 1); assert.equal(receipt.relationCoverage.implemented, false); assert.equal(receipt.surfaceClassification.terrainWaterOverlapAreaSquareMetres, 0); assert(Math.abs(receipt.surfaceClassification.partitionAreaSquareMetres - 384 ** 2) <= 0.001);
}
assert.equal(manifest.tiles[1].originEpsg26910VerticalMetres[0] - manifest.tiles[0].originEpsg26910VerticalMetres[0], 384, 'Tiles must share one exact east/west edge');
assert.equal(manifest.tiles[1].originEpsg26910VerticalMetres[1], manifest.tiles[0].originEpsg26910VerticalMetres[1], 'Tiles must occupy the same northing row');
assert.equal(manifest.tiles[2].originEpsg26910VerticalMetres[1] - manifest.tiles[1].originEpsg26910VerticalMetres[1], 384, 'North tile must share one exact north/south edge with Ferry');
assert.equal(manifest.tiles[2].originEpsg26910VerticalMetres[0], manifest.tiles[1].originEpsg26910VerticalMetres[0], 'North tile must occupy the Ferry easting column');
console.log(JSON.stringify({ result: 'SF metric tile set passed', manifest: path.relative(ROOT, manifestPath), tileIds: manifest.tiles.map(({ id }) => id) }, null, 2));
