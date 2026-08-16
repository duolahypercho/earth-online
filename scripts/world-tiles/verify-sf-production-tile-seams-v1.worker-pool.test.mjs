import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadSfMetricSharedInputs,
  loadSfMetricVerifiedTerrainSourceDigests,
} from './build-ferry-production-tile-v1.mjs';
import {
  DEFAULT_REBUILD_WORKERS,
  rebuildSfMetricTilesInWorkers,
} from './verify-sf-production-tile-seams-v1.worker-pool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const METRIC_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const fixtureWorkerUrl = new URL('./verify-sf-production-tile-seams-v1.worker-pool.fixture-worker.mjs', import.meta.url);
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const representativeIds = ['epsg26910-1416-10872', 'epsg26910-1433-10885'];

async function publishedTile(id) {
  const directory = path.join(METRIC_ROOT, id);
  const [receipt, packageDescriptor, glb] = await Promise.all([
    readFile(path.join(directory, `${id}.receipt.json`), 'utf8').then(JSON.parse),
    readFile(path.join(directory, `${id}.package.json`), 'utf8').then(JSON.parse),
    readFile(path.join(directory, `${id}.lod0.glb`)),
  ]);
  return { id, receipt, packageDescriptor, glb };
}

test('isolated worker rebuilds are byte-identical, write-free, and report in input order', { timeout: 120_000 }, async () => {
  const published = await Promise.all(representativeIds.map(publishedTile));
  const [sharedInputs, verifiedTerrainSourceDigests] = await Promise.all([
    loadSfMetricSharedInputs(),
    loadSfMetricVerifiedTerrainSourceDigests(),
  ]);
  const before = published.map(({ glb, receipt, packageDescriptor }) => ({ glb, receipt, packageDescriptor }));
  const rebuilt = await rebuildSfMetricTilesInWorkers({
    tiles: published.map(({ receipt, id }) => ({
      id,
      gridEasting: receipt.tile.gridIndex[0],
      gridNorthing: receipt.tile.gridIndex[1],
    })),
    sharedInputs,
    verifiedTerrainSourceDigests,
    workerCount: 2,
  });

  assert.deepEqual(rebuilt.map(({ tile }) => tile.id), representativeIds, 'worker completion must not reorder gate results');
  for (const [{ receipt, packageDescriptor, glb }, { rebuilt: result }] of rebuilt.map((entry, index) => [published[index], entry])) {
    assert.deepEqual(Buffer.from(result.glbs[0].bytes), glb, `${receipt.tile.identity} GLB drifted`);
    assert.equal(digest(result.glbs[0].bytes), receipt.lods[0].artifactHash, `${receipt.tile.identity} GLB receipt hash drifted`);
    assert.deepEqual(result.receipt, receipt, `${receipt.tile.identity} receipt/source/origin drifted`);
    assert.deepEqual(result.packageDescriptor, packageDescriptor, `${receipt.tile.identity} package status/origin drifted`);
  }
  const after = await Promise.all(representativeIds.map(publishedTile));
  assert.deepEqual(after.map(({ glb, receipt, packageDescriptor }) => ({ glb, receipt, packageDescriptor })), before, 'write:false changed landed artifacts');
});

test('worker failures reject the pool and terminate the in-flight rebuild set', { timeout: 10_000 }, async () => {
  await assert.rejects(
    rebuildSfMetricTilesInWorkers({
      tiles: [
        { id: 'ok', gridEasting: 3, gridNorthing: 1 },
        { id: 'fails', gridEasting: -1, gridNorthing: 1 },
      ],
      workerCount: 2,
      workerUrl: fixtureWorkerUrl,
    }),
    /fixture worker failure/,
  );
});

test('results remain input-ordered when fixture workers finish out of order', { timeout: 10_000 }, async () => {
  const tiles = [
    { id: 'first', gridEasting: 1, gridNorthing: 1 },
    { id: 'second', gridEasting: 3, gridNorthing: 1 },
    { id: 'third', gridEasting: 2, gridNorthing: 1 },
  ];
  const rebuilt = await rebuildSfMetricTilesInWorkers({ tiles, workerCount: 3, workerUrl: fixtureWorkerUrl });
  assert.deepEqual(rebuilt.map(({ tile }) => tile.id), tiles.map(({ id }) => id));
  assert.deepEqual(rebuilt.map(({ rebuilt: result }) => result.receipt.tile.originEpsg26910VerticalMetres[0]), [1, 3, 2]);
});

test('the default rebuild worker count is bounded for local full-gate use', () => {
  assert(Number.isInteger(DEFAULT_REBUILD_WORKERS));
  assert(DEFAULT_REBUILD_WORKERS >= 1 && DEFAULT_REBUILD_WORKERS <= 4);
});
