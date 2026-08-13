import * as THREE from 'three';
import {
  DISTRICT_MASSING_LIMITS,
  generateDistrictMassing,
  getDistrictNames,
  getPalette,
  getSharedGeometryPools,
} from '../src/district_massing.js';
import {
  createSanFranciscoSectorCatalog,
  createSanFranciscoStreaming,
} from '../src/streaming.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const deterministicDescriptor = {
  district: 'Castro / Noe Valley',
  seed: 0x51f15e,
};
const deterministicMassing = generateDistrictMassing(
  deterministicDescriptor,
  384,
  'detail',
);
const repeatedMassing = generateDistrictMassing(
  deterministicDescriptor,
  384,
  'detail',
);
assert(
  JSON.stringify(deterministicMassing) === JSON.stringify(repeatedMassing),
  'District massing output changed between identical deterministic inputs.',
);

const colorIndexesByPalette = new Map();
deterministicMassing.forEach((building) => {
  if (!colorIndexesByPalette.has(building.paletteName)) {
    colorIndexesByPalette.set(building.paletteName, new Set());
  }
  colorIndexesByPalette.get(building.paletteName).add(building.paletteIndex);
});
assert(
  [...colorIndexesByPalette.values()].some((indexes) => indexes.size > 1),
  'Deterministic massing does not vary colors within its selected palettes.',
);

const financialMassing = generateDistrictMassing(
  { district: 'Financial District', seed: 0x5f0001 },
  384,
  'detail',
);
const sunsetMassing = generateDistrictMassing(
  { district: 'Sunset', seed: 0x5f0001 },
  384,
  'detail',
);
const averageHeight = (buildings) => buildings.reduce(
  (total, building) => total + building.height,
  0,
) / buildings.length;
assert(
  averageHeight(financialMassing) > averageHeight(sunsetMassing) * 3,
  'Financial District and Sunset massing do not have meaningful height differentiation.',
);
assert(
  financialMassing.some((building) => ['setback', 'tapered'].includes(building.geometryStyle))
    && sunsetMassing.every((building) => ['box', 'rowhouse'].includes(building.geometryStyle)),
  'District profiles do not produce meaningfully differentiated geometry styles.',
);

let reachableRowhouse = null;
for (let seed = 0; seed < 128 && !reachableRowhouse; seed += 1) {
  reachableRowhouse = generateDistrictMassing(
    { district: 'Castro / Noe Valley', seed },
    384,
    'detail',
  ).find((building) => building.geometryStyle === 'rowhouse');
}
assert(reachableRowhouse, 'A rowhouse-weighted district cannot reach the rowhouse style.');
assert(
  getSharedGeometryPools().rowhouse?.getAttribute('position')?.count > 24,
  'Detailed rowhouse style does not have distinct compound geometry.',
);

getDistrictNames().forEach((district, districtIndex) => {
  for (const quality of ['detail', 'proxy']) {
    const buildings = generateDistrictMassing(
      { district, seed: 0xa11ce + districtIndex },
      384,
      quality,
    );
    const limits = DISTRICT_MASSING_LIMITS[quality];
    assert(
      buildings.length <= limits.maxBuildings,
      `${district} ${quality} massing exceeded its building slot capacity.`,
    );
    const styleCounts = new Map();
    buildings.forEach((building) => {
      styleCounts.set(
        building.geometryStyle,
        (styleCounts.get(building.geometryStyle) || 0) + 1,
      );
      const palette = getPalette(building.paletteName);
      assert(
        Number.isInteger(building.paletteIndex)
          && building.paletteIndex >= 0
          && building.paletteIndex < palette.colors.length,
        `${district} produced a palette color index outside its selected palette.`,
      );
    });
    styleCounts.forEach((count) => {
      assert(
        count <= limits.maxBuildings,
        `${district} ${quality} style count exceeded its instanced slot capacity.`,
      );
    });
  }
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1800);
camera.position.set(0, 120, 220);
camera.lookAt(0, 0, 0);
const catalog = createSanFranciscoSectorCatalog();
const streaming = createSanFranciscoStreaming({ scene, catalog });
const mirrorCatalog = createSanFranciscoSectorCatalog();
const mirrorStreaming = createSanFranciscoStreaming({
  scene: new THREE.Scene(),
  catalog: mirrorCatalog,
});
const clampedStreaming = createSanFranciscoStreaming({
  scene: new THREE.Scene(),
  catalog: createSanFranciscoSectorCatalog(),
  maxDetailed: 999,
  maxProxies: 999,
});
assert(
  clampedStreaming.stats.maxDetailed === 12
    && clampedStreaming.stats.maxProxies === 44,
  'Configured runtime sector budgets can exceed their hard caps.',
);

// An authored external sector can be visible from the 3:0 evidence framing
// while its distance makes it a proxy candidate. It must still consume a
// detailed slot because it resolves as external-detail at activation.
const externalCapCatalog = createSanFranciscoSectorCatalog();
const externalCapStreaming = createSanFranciscoStreaming({
  scene: new THREE.Scene(),
  catalog: externalCapCatalog,
});
const externalCapCamera = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1800);
const externalCapStops = [
  {
    key: '3:0',
    position: new THREE.Vector3(1216, 0, 0),
    camera: new THREE.Vector3(1216, 18, 0),
    lookAt: new THREE.Vector3(1120, 12, 32),
    expectsCore: true,
  },
  {
    key: '4:0',
    position: new THREE.Vector3(1472, 0, 0),
    camera: new THREE.Vector3(1472, 18, 0),
    lookAt: new THREE.Vector3(1568, 12, 32),
    expectsCore: false,
  },
];
let externalCapElapsed = 0;
let externalCapPeakDetailed = 0;
externalCapStops.forEach((stop) => {
  externalCapCamera.position.copy(stop.camera);
  externalCapCamera.lookAt(stop.lookAt);
  externalCapCamera.updateMatrixWorld(true);
  externalCapElapsed += 0.3;
  externalCapStreaming.update(stop.position, externalCapCamera, 0.3, externalCapElapsed);
  const externalCapStats = externalCapStreaming.stats;
  externalCapPeakDetailed = Math.max(externalCapPeakDetailed, externalCapStats.activeDetailed);
  assert(
    externalCapStats.focusSector === stop.key,
    `External-detail cap regression did not reach focus sector ${stop.key}.`,
  );
  assert(
    externalCapStats.activeDetailed <= externalCapStats.maxDetailed,
    `External-detail activation exceeded the detailed cap near ${stop.key}.`,
  );
  assert(
    externalCapStats.activeProxies <= externalCapStats.maxProxies,
    `External-detail activation exceeded the proxy cap near ${stop.key}.`,
  );
  if (stop.expectsCore) {
    assert(
      externalCapStreaming.isSectorActive('0:0')
        && externalCapStreaming.isSectorDetailed('0:0'),
      'Authored core disappeared while enforcing the external-detail cap.',
    );
  }
});
assert(
  externalCapPeakDetailed <= externalCapStreaming.stats.maxDetailed,
  'External-detail regression peak exceeded the detailed budget.',
);

function stableSimulationFields(state) {
  return {
    stateId: state.stateId,
    vehicleCount: state.vehicleCount,
    pedestrianCount: state.pedestrianCount,
    trafficClock: state.trafficClock,
    pedestrianClock: state.pedestrianClock,
    portalIds: state.portalIds,
  };
}

for (const key of ['0:0', '1:0', '-1:1']) {
  const state = streaming.getSectorSimulationState(key);
  const mirrorState = mirrorStreaming.getSectorSimulationState(key);
  assert(
    JSON.stringify(stableSimulationFields(state))
      === JSON.stringify(stableSimulationFields(mirrorState)),
    `Coarse population state is not deterministic for ${key}.`,
  );
  assert(
    Number.isInteger(state.vehicleCount)
      && state.vehicleCount >= 14
      && state.vehicleCount <= 33,
    `Vehicle population is outside its deterministic envelope for ${key}.`,
  );
  assert(
    Number.isInteger(state.pedestrianCount)
      && state.pedestrianCount >= 28
      && state.pedestrianCount <= 77,
    `Pedestrian population is outside its deterministic envelope for ${key}.`,
  );
  assert(
    state.trafficPhase >= 0
      && state.trafficPhase < 1
      && state.pedestrianPhase >= 0
      && state.pedestrianPhase < 1,
    `Simulation phase is outside [0, 1) for ${key}.`,
  );
}

const origin = catalog.get(0, 0);
assert(origin.elevation === 0, 'Authored core does not resolve to local Y=0.');
const halfSector = catalog.sectorSize * 0.5;
assert(
  JSON.stringify(catalog.sectorAt(new THREE.Vector3(halfSector, 0, halfSector)))
    === JSON.stringify({ x: 0, z: 0 }),
  'An exact east/north metric boundary is not owned by its west/south sector.',
);
assert(
  JSON.stringify(catalog.sectorAt(new THREE.Vector3(halfSector + 1, 0, halfSector + 1)))
    === JSON.stringify({ x: 1, z: 1 }),
  'A one-metre east/north crossing did not select the adjacent metric sector.',
);
assert(
  JSON.stringify(catalog.sectorAt(new THREE.Vector3(-halfSector, 0, -halfSector)))
    === JSON.stringify({ x: -1, z: -1 }),
  'An exact west/south metric boundary is ambiguously assigned to the origin sector.',
);
assert(
  JSON.stringify(catalog.sectorAt(new THREE.Vector3(-halfSector + 1, 0, -halfSector + 1)))
    === JSON.stringify({ x: 0, z: 0 }),
  'A one-metre east/north move from a negative boundary did not select the origin sector.',
);
assert(
  streaming.getSurfaceHeight(new THREE.Vector3(28, 4, 38)) === 0,
  'Hero camera target was not preserved on the authored core datum.',
);
const adjacentElevations = [];
for (let z = -1; z <= 1; z += 1) {
  for (let x = -1; x <= 1; x += 1) {
    if (x === 0 && z === 0) continue;
    adjacentElevations.push(Math.abs(catalog.get(x, z).elevation));
  }
}
assert(
  Math.max(...adjacentElevations) <= 15,
  'A neighboring sector begins more than 15 m from the authored seam datum.',
);
const seamInside = streaming.getSurfaceHeight(new THREE.Vector3(catalog.sectorSize * 0.5 - 0.01, 0, 0));
const seamOutside = streaming.getSurfaceHeight(new THREE.Vector3(catalog.sectorSize * 0.5 + 0.01, 0, 0));
assert(
  Math.abs(seamInside - seamOutside) < 0.02,
  'Surface-height hook is discontinuous at the authored sector boundary.',
);
const protectedStats = streaming.stats;
assert(protectedStats.protectionActive, 'Authored-core protection aperture is not active at center.');
assert(
  protectedStats.activeRuntimeSectors === 1
    && protectedStats.activeDetailed === 1
    && protectedStats.activeProxies === 0,
  'Generated neighbors are visible inside the authored-core protection aperture.',
);

const revealPosition = new THREE.Vector3(catalog.sectorSize * 0.38, 0, 0);
camera.position.set(revealPosition.x, 120, revealPosition.z + 220);
camera.lookAt(revealPosition);
streaming.update(revealPosition, camera, 0.3, 0.3);
const revealStats = streaming.stats;
assert(!revealStats.protectionActive, 'Protection aperture did not open before the sector seam.');
assert(
  revealStats.activeRuntimeSectors > 1
    && revealStats.detailedPool.active + revealStats.proxyPool.active > 0,
  'Generated neighbors were not revealed before the traveler reached the seam.',
);
const eastPortal = streaming.getPortalId('0:0', '1:0');
assert(
  eastPortal === 'sf-portal:ew:0:0'
    && eastPortal === streaming.getPortalId('1:0', '0:0'),
  'East/west portal ID is not canonical from both sectors.',
);
const northPortal = streaming.getPortalId('0:0', '0:1');
assert(
  northPortal === 'sf-portal:ns:0:0'
    && northPortal === streaming.getPortalId('0:1', '0:0'),
  'North/south portal ID is not canonical from both sectors.',
);
assert(
  streaming.getPortalId('0:0', '1:1') === null
    && streaming.getPortalId('0:0', '2:0') === null,
  'Non-adjacent sectors unexpectedly share a portal.',
);

const stateBeforeCrossing = streaming.getSectorSimulationState('1:0');
assert(
  stateBeforeCrossing.stateId === 'sf-sim:1:0'
    && stateBeforeCrossing.portalIds.west === eastPortal,
  'Revealed sector did not retain its authoritative west portal.',
);

let simulationElapsed = 0.3;
for (let step = 0; step < 80; step += 1) {
  simulationElapsed += 4;
  streaming.update(revealPosition, camera, 0.3, simulationElapsed);
  const stepStats = streaming.stats;
  assert(stepStats.handoffs.pending <= stepStats.maxHandoffQueue, 'Handoff queue exceeded its cap.');
  assert(stepStats.backgroundStates <= stepStats.maxBackgroundStates, 'Background state cap exceeded.');
}

const acrossSeamPosition = new THREE.Vector3(catalog.sectorSize * 0.58, 0, 0);
camera.position.set(acrossSeamPosition.x, 120, acrossSeamPosition.z + 220);
camera.lookAt(acrossSeamPosition);
simulationElapsed += 0.3;
streaming.update(acrossSeamPosition, camera, 0.3, simulationElapsed);
assert(streaming.stats.focusSector === '1:0', 'The 0.58-sector crossing did not enter sector 1:0.');
const stateAfterCrossing = streaming.getSectorSimulationState('1:0');
assert(
  stateAfterCrossing.stateId === stateBeforeCrossing.stateId
    && stateAfterCrossing.trafficClock >= stateBeforeCrossing.trafficClock
    && stateAfterCrossing.pedestrianClock >= stateBeforeCrossing.pedestrianClock
    && stateAfterCrossing.handoffRevision >= stateBeforeCrossing.handoffRevision,
  'Population state reset or teleported during reveal-to-seam travel.',
);
assert(
  Math.abs(stateAfterCrossing.trafficPhase - (stateAfterCrossing.trafficClock % 1)) < 1e-12
    && Math.abs(stateAfterCrossing.pedestrianPhase - (stateAfterCrossing.pedestrianClock % 1)) < 1e-12,
  'Published phases are inconsistent with authoritative clocks.',
);
const handoffsAfterCrossing = streaming.stats.handoffs;
assert(handoffsAfterCrossing.queued > 0, 'Long route did not exercise a portal handoff.');
assert(
  handoffsAfterCrossing.completed === handoffsAfterCrossing.queued
    && handoffsAfterCrossing.pending === 0
    && handoffsAfterCrossing.dropped === 0
    && handoffsAfterCrossing.deferred === 0,
  'A portal handoff was lost, deferred, or left pending.',
);
assert(
  handoffsAfterCrossing.conservationError === 0
    && handoffsAfterCrossing.vehicleAgents + handoffsAfterCrossing.pedestrianAgents > 0,
  'Aggregate vehicle/pedestrian population was not conserved.',
);
assert(
  handoffsAfterCrossing.destinationsCreated > 0,
  'No handoff demonstrated on-demand destination-state creation.',
);

// A regressing timestamp must be clamped and leave authoritative clocks
// monotonic; callers cannot rewind a district by revisiting it.
const beforeRegressingUpdate = streaming.getSectorSimulationState('1:0');
streaming.update(acrossSeamPosition, camera, 0.3, simulationElapsed - 100);
const afterRegressingUpdate = streaming.getSectorSimulationState('1:0');
assert(
  afterRegressingUpdate.trafficClock >= beforeRegressingUpdate.trafficClock
    && streaming.stats.handoffs.elapsedClamps === 1,
  'Regressing elapsed time rewound the coarse simulation.',
);

const route = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(420, 0, -180),
  new THREE.Vector3(980, 0, -850),
  new THREE.Vector3(-1400, 0, -2100),
  new THREE.Vector3(1150, 0, 1850),
  new THREE.Vector3(0, 0, 0),
];

route.forEach((position) => {
  camera.position.set(position.x, 120, position.z + 220);
  camera.lookAt(position);
  simulationElapsed += 0.3;
  streaming.update(position, camera, 0.3, simulationElapsed);
  const stats = streaming.stats;
  assert(stats.activeDetailed <= stats.maxDetailed, 'Detailed sector budget exceeded.');
  assert(stats.activeProxies <= stats.maxProxies, 'Proxy sector budget exceeded.');
  assert(
    stats.backgroundStates <= stats.maxBackgroundStates,
    'Background simulation state budget exceeded.',
  );
  assert(
    stats.descriptorMetadataLoaded <= stats.maxDescriptorMetadata,
    'Sector descriptor metadata cache exceeded its budget.',
  );
  assert(
    stats.activeRuntimeSectors <= stats.maxDetailed + stats.maxProxies,
    'Total runtime sector budget exceeded.',
  );
});

const stats = streaming.stats;
const stateAfterRepeatVisit = streaming.getSectorSimulationState('1:0');
assert(
  stateAfterRepeatVisit.stateId === stateBeforeCrossing.stateId
    && stateAfterRepeatVisit.trafficClock >= stateBeforeCrossing.trafficClock
    && stateAfterRepeatVisit.pedestrianClock >= stateBeforeCrossing.pedestrianClock,
  'A repeat district visit reset its coarse simulation identity or phase.',
);
assert(catalog.totalSectors > 700, 'Catalog does not span a whole-city footprint.');
assert(
  catalog.footprintAreaKm2 > 115 && catalog.footprintAreaKm2 < 130,
  'Streaming footprint is not approximately San Francisco land-area scale.',
);
assert(stats.detailedPool.reused > 0, 'Detailed sector objects were not reused.');
assert(stats.proxyPool.reused > 0, 'Proxy sector objects were not reused.');
assert(stats.detailedPool.created <= stats.maxDetailed, 'Detailed pool allocation exceeded its cap.');
assert(stats.proxyPool.created <= stats.maxProxies, 'Proxy pool allocation exceeded its cap.');
assert(
  stats.maxDetailed <= 12 && stats.maxProxies <= 44,
  'Runtime sector budgets exceed the hard detail/proxy caps.',
);
assert(
  stats.massingCapacity.detailStyles.includes('rowhouse')
    && stats.massingCapacity.detailInstanceCapacityPerStyle
      >= stats.massingCapacity.detailMaxBuildings
    && stats.massingCapacity.proxyInstanceCapacity
      >= stats.massingCapacity.proxyMaxBuildings,
  'Instanced massing slots cannot hold their maximum generated building counts.',
);
assert(stats.transitions > 0, 'No sector transitions were observed.');
assert(stats.handoffs.dropped === 0, 'At least one aggregate agent handoff was dropped.');
assert(stats.handoffs.conservationError === 0, 'Population conservation error is non-zero.');

console.log(JSON.stringify({
  result: 'streaming invariants passed',
  ...stats,
}, null, 2));
