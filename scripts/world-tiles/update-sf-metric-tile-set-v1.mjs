/** Recompute the runtime tile manifest from already admitted, verified artifacts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
assert.equal(manifest.kind, 'sf-metric-tile-set');
const tiles = [];
for (const tile of manifest.tiles) {
  const receiptBytes = await readFile(path.join(ROOT, tile.receipt.path));
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.tile.identity, tile.id, `${tile.id} receipt identity drifted`);
  assert.deepEqual(receipt.tile.gridIndex, tile.gridIndex, `${tile.id} receipt grid index drifted`);
  assert.equal(receipt.lods.length, 1, `${tile.id} must expose exactly LOD0`);
  const glbPath = receipt.lods[0].path;
  const glbBytes = await readFile(path.join(ROOT, glbPath));
  assert.equal(sha256(glbBytes), receipt.lods[0].artifactHash, `${tile.id} LOD0 hash drifted`);
  tiles.push({
    id: tile.id,
    gridIndex: tile.gridIndex,
    originEpsg26910VerticalMetres: receipt.tile.originEpsg26910VerticalMetres,
    lod0: { path: glbPath, sha256: receipt.lods[0].artifactHash },
    receipt: { path: tile.receipt.path, sha256: sha256(receiptBytes) },
  });
}
manifest.tiles = tiles.sort((a, b) => a.gridIndex[1] - b.gridIndex[1] || a.gridIndex[0] - b.gridIndex[0]);
await writeFile(MANIFEST_PATH, stableJson(manifest));
console.log(JSON.stringify({ result: 'SF metric tile set manifest refreshed', tiles: manifest.tiles.length, path: path.relative(ROOT, MANIFEST_PATH) }, null, 2));
