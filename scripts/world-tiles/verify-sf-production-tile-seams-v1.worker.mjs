import { parentPort, workerData } from 'node:worker_threads';
import { buildSfMetricTile } from './build-ferry-production-tile-v1.mjs';

function freezeTerrainDigestMemo(memo) {
  if (!Array.isArray(memo)) return memo;
  return Object.freeze(memo.map((entry) => Object.freeze({
    ...entry,
    fileIdentity: entry.fileIdentity ? Object.freeze({ ...entry.fileIdentity }) : entry.fileIdentity,
  })));
}

const sharedInputs = workerData?.sharedInputs;
const verifiedTerrainSourceDigests = freezeTerrainDigestMemo(workerData?.verifiedTerrainSourceDigests);

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async (message) => {
  if (message?.type !== 'rebuild') return;
  try {
    const rebuilt = await buildSfMetricTile({
      tile: message.tile,
      sharedInputs,
      verifiedTerrainSourceDigests,
      write: false,
      buildingSourceToneProof: message.tile.buildingSourceToneProof === true,
    });
    parentPort.postMessage({
      type: 'result',
      index: message.index,
      glbBytes: rebuilt.glbs[0].bytes,
      receipt: rebuilt.receipt,
      packageDescriptor: rebuilt.packageDescriptor,
    });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      index: message.index,
      error: { name: error?.name, message: error?.message, stack: error?.stack },
    });
  }
});
