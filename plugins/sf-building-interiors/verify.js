import { getWorldPlugin } from '../../src/plugins/registry.js';

const plugin = getWorldPlugin('sf-building-interiors');
const runButton = document.querySelector('#run');
const result = document.querySelector('#result');
const fixture = {
  meta: { generator: 'sf-plugin-fixture', bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } },
  buildings: [
    { id: 'fixture-home', usage: 'residential', stories: 3, polygon: [{ x: -8, z: -4 }, { x: -1, z: -4 }, { x: -1, z: 5 }, { x: -8, z: 5 }] },
    { id: 'fixture-shop', usage: 'retail', stories: 2, polygon: [{ x: 2, z: -4 }, { x: 9, z: -4 }, { x: 9, z: 5 }, { x: 2, z: 5 }] },
  ],
  segments: [{ id: 'fixture-street', streetId: 'street-1', streetName: 'Market Street', highway: 'primary', sidewalkW: 3, points: [{ x: -20, z: -8 }, { x: 20, z: -8 }] }],
};

function run() {
  const first = plugin.load({ city: fixture });
  const second = plugin.load({ city: fixture });
  const valid = first.portals.length === fixture.buildings.length
    && first.coverage.functional === fixture.buildings.length
    && first.portals.every((portal) => portal.interior.rooms.length === 1)
    && JSON.stringify(first) === JSON.stringify(second);
  result.textContent = JSON.stringify({
    result: valid ? 'PASS' : 'FAIL',
    pluginId: plugin.id,
    worldId: plugin.worldId,
    rendererCreated: false,
    animationLoopCreated: false,
    coverage: first.coverage,
    portals: first.portals,
  }, null, 2);
}

runButton.addEventListener('click', run);
run();
