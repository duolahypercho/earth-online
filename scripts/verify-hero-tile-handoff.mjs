import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createHeroTileHandoffController,
  diagnoseHeroTileHandoffContract,
  FERRY_HERO_TILE_HANDOFF_CONFIG,
  heroTileHandoffConfigFromManifest,
  heroTileHandoffConfigFromRuntimeTile,
} from '../src/realmap/hero-tile-handoff.js';
import { HERO_TILES } from '../src/realmap/hero-tile.js';

const manifest = JSON.parse(await readFile(new URL('../public/data/world/tiles/sf-local-6-5.manifest.json', import.meta.url), 'utf8'));
const manifestConfig = heroTileHandoffConfigFromManifest(manifest);
assert.equal(manifestConfig.tileId, 'sf-local-6-5');
assert.deepEqual(manifestConfig.coreBounds, { minX: 2304, minZ: 1920, maxX: 2688, maxZ: 2304 });
assert.deepEqual(manifestConfig.bufferedBounds, { minX: 2288, minZ: 1904, maxX: 2704, maxZ: 2320 });
assert.equal(manifestConfig.neighbors.east, 'sf-local-7-5');

const runtimeConfig = heroTileHandoffConfigFromRuntimeTile(HERO_TILES['ferry-building']);
assert.equal(runtimeConfig.tileId, 'sf-ferry-building-v1');
assert.deepEqual(runtimeConfig.coreBounds, { minX: 2144, minZ: 1728, maxX: 2528, maxZ: 2112 });
const contract = diagnoseHeroTileHandoffContract({
  runtimeTile: HERO_TILES['ferry-building'],
  manifest,
  launchPosition: { x: 2173, z: 1831.4 },
  landmarkPosition: { x: 2281.5306, z: 1936.6459 },
});
assert.equal(contract.status, 'mismatch', 'runtime and planned tile coordinate contracts must not be silently conflated');
assert.equal(contract.coreBoundsMatch, false, 'runtime and planned core bounds are materially different');
assert.equal(contract.bufferedBoundsMatch, false, 'runtime and planned buffers are materially different');
assert.equal(contract.launch.insideRuntimeCore, true, 'the player launch belongs to the live runtime core');
assert.equal(contract.launch.insideManifestBuffer, false, 'the player launch is not covered by the planned manifest buffer');
assert.equal(contract.landmark.insideRuntimeCore, true, 'the Ferry tower belongs to the live runtime core');
assert.equal(contract.landmark.insideManifestBuffer, false, 'the Ferry tower is not covered by the planned manifest buffer');

const controller = createHeroTileHandoffController(manifestConfig);
const core = manifestConfig.coreBounds;
const buffer = manifestConfig.bufferedBounds;

function startFor(edge) {
  const midX = (core.minX + core.maxX) / 2;
  const midZ = (core.minZ + core.maxZ) / 2;
  if (edge === 'north') return { x: midX, z: core.maxZ - 1 };
  if (edge === 'east') return { x: core.maxX - 1, z: midZ };
  if (edge === 'south') return { x: midX, z: core.minZ + 1 };
  return { x: core.minX + 1, z: midZ };
}

function targetFor(edge, distance = 4) {
  const midX = (core.minX + core.maxX) / 2;
  const midZ = (core.minZ + core.maxZ) / 2;
  if (edge === 'north') return { x: midX, z: core.maxZ + distance };
  if (edge === 'east') return { x: core.maxX + distance, z: midZ };
  if (edge === 'south') return { x: midX, z: core.minZ - distance };
  return { x: core.minX - distance, z: midZ };
}

for (const edge of ['north', 'east', 'south', 'west']) {
  const start = startFor(edge);
  const result = controller.resolve(targetFor(edge), { previousPosition: start });
  assert.equal(result.coreBoundaryCrossed, true, `${edge} edge must emit a core crossing`);
  assert.equal(result.insideBuffer, true, `${edge} edge should remain in the loaded buffer`);
  assert.equal(result.neighborRequested, true, `${edge} edge must request its neighbor`);
  assert.equal(result.neighborReady, false, `${edge} neighbor must remain unloaded by default`);
  assert.deepEqual(result.crossings[0].edges, [edge], `${edge} must request only its canonical neighbor`);
  assert.equal(result.crossings[0].neighborIds[0], manifestConfig.neighbors[edge]);
}

const corner = controller.resolve({ x: core.maxX + 4, z: core.maxZ + 4 }, {
  previousPosition: { x: core.maxX - 1, z: core.maxZ - 1 },
});
assert.equal(corner.coreBoundaryCrossed, true, 'a diagonal corner crossing must be recorded');
assert.deepEqual(corner.crossings[0].edges, ['north', 'east'], 'corner edge ordering must be deterministic');
assert.deepEqual(corner.crossings[0].neighborIds, ['sf-local-6-6', 'sf-local-7-5']);

const tunneling = controller.resolve({ x: buffer.maxX + 500, z: (core.minZ + core.maxZ) / 2 }, {
  previousPosition: { x: core.minX + 1, z: (core.minZ + core.maxZ) / 2 },
});
assert.equal(tunneling.coreBoundaryCrossed, true, 'high-speed movement must not tunnel past the core edge');
assert.equal(tunneling.clampedToBuffer, true, 'movement beyond resident geometry must clamp at the buffer edge');
assert.equal(tunneling.position.x, buffer.maxX, 'high-speed movement must stop on the loaded buffer edge');
assert.equal(tunneling.position.z, (core.minZ + core.maxZ) / 2);

const reentry = controller.resolve({ x: core.maxX - 4, z: (core.minZ + core.maxZ) / 2 }, {
  previousPosition: { x: buffer.maxX, z: (core.minZ + core.maxZ) / 2 },
});
assert.equal(reentry.coreBoundaryCrossed, true, 'reentry must retain a boundary diagnostic');
assert.equal(reentry.reenteredCore, true, 'reentry must be distinguished from an outbound request');
assert.equal(reentry.neighborRequested, false, 'reentry must not fabricate a second load request');
assert.equal(reentry.insideCore, true, 'reentry must end within the core');

controller.setNeighborReady('sf-local-7-5', true);
const readyEast = controller.resolve(targetFor('east'), { previousPosition: startFor('east') });
assert.equal(readyEast.neighborReady, true, 'explicitly marked neighbors should report ready without claiming they were loaded by this controller');

const terrain = controller.resolveMovement({
  previousPosition: { x: core.maxX - 1, z: (core.minZ + core.maxZ) / 2 },
  candidatePosition: { x: buffer.maxX + 20, z: (core.minZ + core.maxZ) / 2 },
  resolveCollision: ({ x, z }) => ({ x: x - 2, z }),
  elevationAt: (x, z) => x * 0.001 + z * 0.002,
});
assert.equal(terrain.collisionResolved.x, buffer.maxX + 18, 'collision resolver must run before tile bounding');
assert.equal(terrain.position.x, buffer.maxX, 'tile bounds must apply after collision resolver');
assert.equal(terrain.terrainY, buffer.maxX * 0.001 + ((core.minZ + core.maxZ) / 2) * 0.002, 'terrain must sample the final constrained position');

const unknownNeighbor = createHeroTileHandoffController(FERRY_HERO_TILE_HANDOFF_CONFIG);
const unknown = unknownNeighbor.resolve({ x: 2532, z: 1920 }, { previousPosition: { x: 2527, z: 1920 } });
assert.equal(unknown.neighborRequested, true, 'a runtime tile without mapped neighbors must still signal handoff demand');
assert.deepEqual(unknown.crossings[0].neighborIds, [null], 'unknown neighbor ids must remain explicit rather than fabricated');
unknownNeighbor.dispose();
assert.throws(() => unknownNeighbor.resolve({ x: 1, z: 1 }), /disposed/);

const diagnostics = controller.getDiagnostics();
assert.ok(diagnostics.requestedNeighborIds.includes('sf-local-7-5'), 'request diagnostics must retain deterministic neighbor identity');
assert.ok(diagnostics.readyNeighborIds.includes('sf-local-7-5'), 'readiness diagnostics must be explicit');
controller.dispose();
assert.equal(controller.getDiagnostics().active, false, 'dispose must be observable');

console.log(JSON.stringify({
  result: 'passed',
  core: manifestConfig.coreBounds,
  buffered: manifestConfig.bufferedBounds,
  testedEdges: ['north', 'east', 'south', 'west'],
  cornerEdges: corner.crossings[0].edges,
  tunneledTo: tunneling.position,
  reentry: { insideCore: reentry.insideCore, neighborRequested: reentry.neighborRequested },
  contract: {
    status: contract.status,
    launchInsideRuntimeCore: contract.launch.insideRuntimeCore,
    launchInsideManifestBuffer: contract.launch.insideManifestBuffer,
  },
}, null, 2));
