/** Bounded exact-seam gate for named production tiles and all resident neighbours. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adjacentPairs,
  loadTile,
  verifyPair,
} from './verify-sf-production-tile-seams-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(
  ROOT,
  'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json',
);
const args = process.argv.slice(2);
const requestedIds = args.flatMap((value, index) => (
  value === '--tile' && args[index + 1] ? [args[index + 1]] : []
));
assert(requestedIds.length > 0, 'Pass at least one repeated --tile epsg26910-X-Y argument');
assert.equal(new Set(requestedIds).size, requestedIds.length, 'Target tile IDs must be unique');

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
assert.equal(manifest.kind, 'sf-metric-tile-set', 'Metric tile manifest kind drifted');
assert.equal(manifest.status, 'provisional-vertical-unrealized', 'Targeted seams require the honest provisional manifest');
const manifestById = new Map(manifest.tiles.map((tile) => [tile.id, tile]));
const targetEntries = requestedIds.map((id) => {
  const entry = manifestById.get(id);
  assert(entry, `Target tile is absent from the production manifest: ${id}`);
  return entry;
});

const selectedIds = new Set(requestedIds);
for (const entry of targetEntries) {
  const [x, y] = entry.gridIndex;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const neighbour = manifest.tiles.find(({ gridIndex }) => gridIndex[0] === x + dx && gridIndex[1] === y + dy);
    if (neighbour) selectedIds.add(neighbour.id);
  }
}

const selectedTiles = [];
for (const id of [...selectedIds].sort()) selectedTiles.push(await loadTile(id, manifestById.get(id)));
const targetSet = new Set(requestedIds);
const targetPairs = adjacentPairs(selectedTiles).filter(([left, right]) => (
  targetSet.has(left.identity) || targetSet.has(right.identity)
));
assert(targetPairs.length > 0, 'Target tiles have no resident four-neighbour seams');

const seams = targetPairs.map(([left, right]) => verifyPair(left, right));
const coveredTargets = new Set(targetPairs.flatMap(([left, right]) => [left.identity, right.identity]).filter((id) => targetSet.has(id)));
assert.deepEqual([...coveredTargets].sort(), [...targetSet].sort(), 'Every target tile must participate in a resident seam');

process.stdout.write(`${JSON.stringify({
  result: 'SF targeted production tile seams passed',
  status: manifest.status,
  targets: requestedIds,
  loadedTiles: selectedTiles.map(({ identity }) => identity),
  seams,
}, null, 2)}\n`);
