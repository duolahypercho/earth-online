import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async ({ index, tile }) => {
  const delay = Math.max(0, 35 - tile.gridEasting * 5);
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (tile.gridEasting === -1) {
    parentPort.postMessage({
      type: 'error',
      index,
      error: { name: 'FixtureError', message: 'fixture worker failure', stack: 'fixture worker failure' },
    });
    return;
  }
  const identity = `fixture-${tile.gridEasting}-${tile.gridNorthing}`;
  const bytes = Buffer.from(identity);
  parentPort.postMessage({
    type: 'result',
    index,
    glbBytes: bytes,
    receipt: {
      lods: [{ artifactHash: `sha256:${identity}` }],
      tile: { originEpsg26910VerticalMetres: [tile.gridEasting, tile.gridNorthing, 0] },
      status: 'fixture',
    },
    packageDescriptor: { status: 'fixture' },
  });
});
