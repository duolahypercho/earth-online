import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createSanFranciscoSectorCatalog,
  createSanFranciscoStreaming,
} from '../src/streaming.js';
import { createSanFranciscoExpansion } from '../src/sf-expansion.js';
import { SIGNAL_PERIOD } from '../src/signals.js';

const scene = new THREE.Scene();
const catalog = createSanFranciscoSectorCatalog();
const streaming = createSanFranciscoStreaming({ scene, catalog });
const expansion = createSanFranciscoExpansion({ streaming, catalog });
const keys = expansion.registeredSectorKeys;
assert.equal(keys.length, 22, 'Expected twenty-two authored district registrations.');
const interiorArchetypesBySector = new Map();

for (const key of keys) {
  const network = expansion.getSectorRoadNetwork(key);
  assert(network, `Missing road network for ${key}.`);
  assert(network.roads.length >= 14, `${key} has too few roads.`);
  assert.equal(network.laneData.length, network.roads.length * 2, `${key} lane metadata is incomplete.`);
  assert.equal(network.spawnPoints.length, network.roads.length, `${key} spawn metadata is incomplete.`);
  assert.equal(network.crossings.length, network.signalIntersections.length, `${key} crossing metadata is incomplete.`);
  const roadIds = new Set(network.roads.map((road) => road.id));
  network.laneData.forEach((lane) => assert(roadIds.has(lane.roadId), `${key} lane references an unknown road.`));
  network.spawnPoints.forEach((spawn) => assert(roadIds.has(spawn.roadId), `${key} spawn references an unknown road.`));
  if (network.roads.some((road) => road.diagonal)) {
    assert(network.crossings.some((crossing) => crossing.diagonal), `${key} diagonal has no pedestrian junctions.`);
  }
  network.signalPlans.forEach((plan) => {
    assert(Number.isFinite(plan.position?.x) && Number.isFinite(plan.position?.z), `${key} signal plan has no position.`);
    assert(Math.abs(plan.cycleSeconds - SIGNAL_PERIOD) < 1e-6, `${key} is not using shared signal timing.`);
  });
}

assert.equal(expansion.roadNetwork.connections[0]?.id, 'sf:core-east-connector', 'Core-to-east connection is missing.');
assert(expansion.roadNetwork.connections.length > 1, 'Grid spine connections are missing.');
assert(expansion.roadNetwork.roads.some((road) => road.connection), 'Connection road is not in the merged graph.');
assert(Math.abs(expansion.roadNetwork.connections[0].start.y - (0.022 * 84)) < 1e-6, 'Core connector does not start on the core grade.');

const graph = expansion.roadNetwork;
const nodeKeys = new Map();
const edges = [];
const nodeFor = (x, z) => {
  const key = `${Math.round(x * 100)}:${Math.round(z * 100)}`;
  if (!nodeKeys.has(key)) nodeKeys.set(key, nodeKeys.size);
  return nodeKeys.get(key);
};
graph.roads.forEach((road) => {
  const dx = road.end.x - road.start.x;
  const dz = road.end.z - road.start.z;
  const lengthSq = dx * dx + dz * dz || 1;
  const points = [
    { t: 0, x: road.start.x, z: road.start.z },
    ...graph.intersections.flatMap((intersection) => {
      const t = ((intersection.x - road.start.x) * dx + (intersection.z - road.start.z) * dz) / lengthSq;
      const distance = Math.abs((intersection.x - road.start.x) * dz - (intersection.z - road.start.z) * dx) / Math.sqrt(lengthSq);
      return t > 1e-4 && t < 0.9999 && distance < 1.3
        ? [{ t, x: intersection.x, z: intersection.z }]
        : [];
    }),
    { t: 1, x: road.end.x, z: road.end.z },
  ].sort((left, right) => left.t - right.t);
  for (let index = 1; index < points.length; index += 1) {
    edges.push([nodeFor(points[index - 1].x, points[index - 1].z), nodeFor(points[index].x, points[index].z)]);
  }
});
const parent = Array.from({ length: nodeKeys.size }, (_, index) => index);
const find = (index) => {
  while (parent[index] !== index) {
    parent[index] = parent[parent[index]];
    index = parent[index];
  }
  return index;
};
edges.forEach(([a, b]) => {
  const rootA = find(a);
  const rootB = find(b);
  if (rootA !== rootB) parent[rootB] = rootA;
});
assert.equal(new Set(parent.map((_, index) => find(index))).size, 1, 'Expansion road graph has disconnected components.');

const camera = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1800);
const focus = new THREE.Vector3(384, 4, 24);
camera.position.set(384, 52, 180);
camera.lookAt(focus);
camera.updateMatrixWorld(true);
streaming.update(focus, camera, 0.3, 0.3);
assert.equal(streaming.stats.focusSector, '1:0', 'Authored QA sector did not become the streaming focus.');
// Sector population is intentionally time-sliced in the runtime. Advance the
// same bounded update loop used by the render frame until the hidden pooled
// slot publishes its presentation and entry metadata. The explicit window
// leaves room for both detail and proxy generators to receive fair turns
// without weakening the zero-pending assertion.
const POPULATION_SETTLE_STEPS = 720;
for (let step = 0; step < POPULATION_SETTLE_STEPS; step += 1) {
  const published = streaming.getSectorPresentation('1:0');
  if (published.active
    && published.detailed
    && published.presentation?.authoredOverlay
    && streaming.getSectorBuildingVolumes('1:0').length > 0) break;
  streaming.update(focus, camera, 0.25, 0.3 + (step + 1) * 0.25);
}
const presentation = streaming.getSectorPresentation('1:0');
assert(presentation.presentation?.authoredOverlay, 'Authored presentation metadata is not published.');
const volumes = expansion.getAuthoredBuildingVolumes('1:0');
assert(volumes.length > 0, 'Authored district has no enterable landmark volume.');
volumes.forEach((volume) => {
  assert.equal(volume.coordinateSpace, 'world', `${volume.id} is not canonical world-space metadata.`);
  assert(volume.entrance && volume.rooms?.length && volume.interiorState, `${volume.id} lacks entry metadata.`);
  assert.equal(volume.interiorState, 'district-archetype-room', `${volume.id} lacks a district interior archetype.`);
  assert(volume.interiorArchetype, `${volume.id} has no interior archetype identity.`);
  assert.equal(volume.entrance.returnPath.length, 2, `${volume.id} lacks a street return path.`);
  assert(volume.min && volume.max && volume.collisionMode === 'aabb-shell', `${volume.id} lacks collision metadata.`);
  const portal = streaming.getNearestEnterablePortal(volume.entrance, 0.5);
  assert(
    portal?.id === `sf-streamed-portal:${volume.id}` && portal.buildingId === volume.id,
    `${volume.id} is not discoverable as a portal.`,
  );
});
const volume = volumes[0];
const blocked = streaming.resolveRoamPosition({
  x: volume.center.x,
  y: volume.center.y,
  z: volume.center.z,
});
assert(
  blocked.x < volume.min.x || blocked.x > volume.max.x || blocked.z < volume.min.z || blocked.z > volume.max.z,
  'Roam collision resolver left the player inside an authored building shell.',
);

// Probe the actual world-space entrance on every authored district. A local
// descriptor can pass a metadata-only test while still missing the visible
// doorway after its pooled sector is translated into the city grid.
for (const key of keys) {
  const [sectorX, sectorZ] = key.split(':').map(Number);
  const descriptor = catalog.get(sectorX, sectorZ);
  const districtFocus = new THREE.Vector3(
    descriptor.center.x,
    descriptor.elevation + 4,
    descriptor.center.z + 24,
  );
  camera.position.set(
    descriptor.center.x,
    descriptor.elevation + 52,
    descriptor.center.z + 180,
  );
  camera.lookAt(districtFocus);
  camera.updateMatrixWorld(true);
  streaming.update(districtFocus, camera, 0.25, 100 + sectorX * 10 + sectorZ);
  for (let step = 0; step < POPULATION_SETTLE_STEPS; step += 1) {
    const published = streaming.getSectorPresentation(key);
    if (streaming.stats.focusSector === key
      && published.active
      && published.detailed
      && published.presentation?.authoredOverlay
      && streaming.getSectorBuildingVolumes(key).length > 0) break;
    streaming.update(districtFocus, camera, 0.25, 100.25 + sectorX * 10 + sectorZ + step * 0.25);
  }
  assert.equal(streaming.stats.focusSector, key, `${key} did not become the streaming focus.`);
  const districtVolumes = expansion.getAuthoredBuildingVolumes(key);
  assert(districtVolumes.length > 0, `${key} has no authored building volumes after streaming.`);
  const archetypes = new Set();
  districtVolumes.forEach((volume) => {
    assert.equal(volume.coordinateSpace, 'world', `${volume.id} lost world-space identity.`);
    assert(
      Math.abs(volume.entrance.x - descriptor.center.x) <= 220
        && Math.abs(volume.entrance.z - descriptor.center.z) <= 220,
      `${volume.id} entrance is outside its authored world-space sector.`,
    );
    const portal = streaming.getNearestEnterablePortal(volume.entrance, 0.5);
    assert(
      portal?.id === `sf-streamed-portal:${volume.id}` && portal.buildingId === volume.id,
      `${volume.id} world-space entrance does not resolve to its own portal.`,
    );
    assert.equal(volume.interiorState, 'district-archetype-room', `${volume.id} lost its district interior state.`);
    assert(volume.interiorArchetype, `${volume.id} lost its interior archetype.`);
    archetypes.add(volume.interiorArchetype);
  });
  assert(archetypes.size >= 2, `${key} has too little interior archetype variety.`);
  interiorArchetypesBySector.set(key, [...archetypes].sort());
}

const allInteriorArchetypes = new Set(
  [...interiorArchetypesBySector.values()].flat(),
);
assert(allInteriorArchetypes.size >= 8, 'Expansion does not expose enough distinct interior archetypes.');

console.log(JSON.stringify({
  result: 'San Francisco expansion invariants passed',
  sectors: keys,
  authoredRoads: expansion.roadNetwork.roads.length,
  authoredIntersections: expansion.roadNetwork.intersections.length,
  authoredSignalPlans: expansion.roadNetwork.signalPlans.length,
  diagonalCrossings: expansion.roadNetwork.crossings.filter((crossing) => crossing.diagonal).length,
  activeSector: streaming.stats.focusSector,
  authoredEnterableVolumes: volumes.length,
  interiorArchetypesBySector: Object.fromEntries(interiorArchetypesBySector),
  interiorArchetypeCount: allInteriorArchetypes.size,
}));
