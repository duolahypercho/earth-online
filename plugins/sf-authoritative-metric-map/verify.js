import { getWorldPlugin } from '../../src/plugins/registry.js';

const runButton = document.querySelector('#run');
const result = document.querySelector('#result');
const plugin = getWorldPlugin('sf-authoritative-metric-map');

function disposeObject(root) {
  root?.traverse?.((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose?.();
  });
}

result.textContent = JSON.stringify({
  result: 'CONTRACT PASS',
  id: plugin.id,
  worldId: plugin.worldId,
  owner: plugin.owner,
  kind: plugin.kind,
}, null, 2);

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  result.textContent = 'Fetching and verifying the production manifest, receipt, SHA-256, and GLB…';
  let bundle;
  try {
    bundle = await plugin.load({ count: 1 });
    result.textContent = JSON.stringify({
      result: 'RUNTIME PASS',
      pluginId: plugin.id,
      worldId: plugin.worldId,
      rendererCreated: false,
      animationLoopCreated: false,
      manifestTileCount: bundle.manifestTileCount,
      verifiedTileIds: bundle.tileIds,
      counts: bundle.counts,
      anchorOriginEpsg26910: bundle.anchorOriginEpsg26910,
    }, null, 2);
  } catch (error) {
    result.textContent = JSON.stringify({ result: 'FAIL', error: error.message }, null, 2);
  } finally {
    disposeObject(bundle?.root);
    runButton.disabled = false;
  }
});
