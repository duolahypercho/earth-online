/** Build multiple plan-approved SF metric tiles from one deterministic OSM cache. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSfMetricTile, loadSfMetricSharedInputs } from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLAN_PATH = path.join(ROOT, 'public/data/world/plans/sf-metric-tile-coverage-v1.json');
const args = process.argv.slice(2);
const requested = args.flatMap((argument, index) => argument === '--tile' ? [args[index + 1]] : []).filter(Boolean).map((value) => {
  const [gridEasting, gridNorthing, ...extra] = value.split(',').map(Number);
  assert(Number.isInteger(gridEasting) && Number.isInteger(gridNorthing) && !extra.length, `Invalid --tile grid index ${value}`);
  return { id: `epsg26910-${gridEasting}-${gridNorthing}`, gridEasting, gridNorthing };
});
assert(requested.length, 'Pass one or more --tile easting,northing values');
assert.equal(new Set(requested.map(({ id }) => id)).size, requested.length, 'Batch tile IDs must be unique');
const plan = JSON.parse(await readFile(PLAN_PATH, 'utf8'));
for (const tile of requested) {
  const planned = plan.tiles.find(({ id }) => id === tile.id);
  assert(planned, `${tile.id} is absent from the locked SF coverage plan`);
  assert.equal(planned.sourceReadiness.buildReady, true, `${tile.id} is not source-ready: ${planned.sourceReadiness.terrainElevation}`);
}
const started = performance.now();
const sharedInputs = await loadSfMetricSharedInputs();
const outputs = [];
for (const tile of requested) {
  const result = await buildSfMetricTile({ tile, sharedInputs });
  outputs.push({ id: tile.id, artifactHash: result.receipt.lods[0].artifactHash, bytes: result.receipt.lods[0].bytes, roads: result.receipt.counts.emittedRoadWays, buildings: result.receipt.counts.emittedBuildingWays });
}
console.log(JSON.stringify({ result: 'SF metric tile batch baked', tiles: outputs, osmFeatureCacheWays: sharedInputs.osmFeatureCache.length, elapsedSeconds: Math.round((performance.now() - started) / 10) / 100 }, null, 2));
