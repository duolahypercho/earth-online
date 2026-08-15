import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

const MAX_REBUILD_WORKERS = 4;
const DEFAULT_WORKER_URL = new URL('./verify-sf-production-tile-seams-v1.worker.mjs', import.meta.url);

const detectedParallelism = typeof availableParallelism === 'function' ? availableParallelism() : 1;
export const DEFAULT_REBUILD_WORKERS = Math.min(
  MAX_REBUILD_WORKERS,
  Math.max(1, detectedParallelism - 1),
);

function workerError(payload) {
  const error = new Error(payload?.message ?? 'Tile rebuild worker failed');
  if (payload?.name) error.name = payload.name;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

function normalizeWorkerCount(workerCount, tileCount) {
  if (!Number.isInteger(workerCount) || workerCount < 1) throw new RangeError('workerCount must be a positive integer');
  return Math.min(MAX_REBUILD_WORKERS, workerCount, tileCount);
}

function workerTile(tile) {
  if (!Number.isInteger(tile?.gridEasting) || !Number.isInteger(tile?.gridNorthing)) {
    throw new TypeError('Each rebuild tile must contain integer gridEasting and gridNorthing values');
  }
  if (tile.buildingSourceToneProof != null && typeof tile.buildingSourceToneProof !== 'boolean') {
    throw new TypeError('buildingSourceToneProof must be a boolean when provided');
  }
  return {
    gridEasting: tile.gridEasting,
    gridNorthing: tile.gridNorthing,
    buildingSourceToneProof: tile.buildingSourceToneProof === true,
  };
}

function rebuiltResult(payload) {
  return {
    glbs: [{ bytes: Buffer.from(payload.glbBytes) }],
    receipt: payload.receipt,
    packageDescriptor: payload.packageDescriptor,
  };
}

/**
 * Rebuild tiles in isolated builder module instances.
 *
 * Each worker receives the shared input snapshot once through workerData and
 * processes one tile at a time. The returned array always follows `tiles`
 * order, regardless of worker completion order. Workers are hard-capped so a
 * full manifest cannot accidentally fan out an unbounded number of builders.
 */
export async function rebuildSfMetricTilesInWorkers({
  tiles,
  sharedInputs,
  verifiedTerrainSourceDigests,
  workerCount = DEFAULT_REBUILD_WORKERS,
  workerUrl = DEFAULT_WORKER_URL,
} = {}) {
  if (!Array.isArray(tiles)) throw new TypeError('tiles must be an array');
  if (!tiles.length) return [];
  const count = normalizeWorkerCount(workerCount, tiles.length);
  const workerData = { sharedInputs, verifiedTerrainSourceDigests };
  const states = [];
  const results = new Array(tiles.length);

  try {
    for (let index = 0; index < count; index += 1) {
      const worker = new Worker(workerUrl, { workerData });
      states.push({ worker, ready: false, busy: false, tileIndex: null });
    }
  } catch (error) {
    await Promise.allSettled(states.map(({ worker }) => worker.terminate()));
    throw error;
  }

  try {
    return await new Promise((resolve, reject) => {
      let nextTileIndex = 0;
      let completed = 0;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const finishIfDone = () => {
        if (!settled && completed === tiles.length) {
          settled = true;
          resolve(results);
        }
      };

      const dispatch = (state) => {
        if (settled || !state.ready || state.busy) return;
        if (nextTileIndex >= tiles.length) {
          finishIfDone();
          return;
        }
        const tileIndex = nextTileIndex;
        nextTileIndex += 1;
        state.busy = true;
        state.tileIndex = tileIndex;
        try {
          state.worker.postMessage({ type: 'rebuild', index: tileIndex, tile: workerTile(tiles[tileIndex]) });
        } catch (error) {
          fail(error);
        }
      };

      for (const state of states) {
        state.worker.on('message', (message) => {
          if (settled) return;
          if (message?.type === 'ready') {
            state.ready = true;
            dispatch(state);
            return;
          }
          if (message?.type === 'error') {
            const error = workerError(message.error);
            if (Number.isInteger(message.index)) error.tileIndex = message.index;
            fail(error);
            return;
          }
          if (message?.type !== 'result' || !Number.isInteger(message.index) || !state.busy || state.tileIndex !== message.index) {
            fail(new Error('Tile rebuild worker returned an invalid result'));
            return;
          }
          state.busy = false;
          state.tileIndex = null;
          try {
            results[message.index] = { tile: tiles[message.index], rebuilt: rebuiltResult(message) };
          } catch (error) {
            fail(error);
            return;
          }
          completed += 1;
          dispatch(state);
          finishIfDone();
        });
        state.worker.on('error', (error) => fail(error));
        state.worker.on('exit', (code) => {
          if (!settled) fail(new Error(`Tile rebuild worker exited with code ${code}`));
        });
      }
    });
  } finally {
    await Promise.allSettled(states.map(({ worker }) => worker.terminate()));
  }
}
