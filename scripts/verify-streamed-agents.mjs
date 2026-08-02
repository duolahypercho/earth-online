import * as THREE from 'three';
import {
  createSanFranciscoSectorCatalog,
  createSanFranciscoStreaming,
} from '../src/streaming.js';
import { createStreamedAgentSystem } from '../src/streamed-agents.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function actorMap(evidence) {
  return new Map(evidence.actors.map((actor) => [actor.id, actor]));
}

const scene = new THREE.Scene();
const catalog = createSanFranciscoSectorCatalog();
const streaming = createSanFranciscoStreaming({
  scene,
  catalog,
  externalDetailedKeys: ['0:0'],
});
const agents = createStreamedAgentSystem({ scene, streaming });
streaming.setStreamedAgentStatsProvider(() => agents.getStats());
const camera = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 1800);
let elapsed = 0;

function advance(position, seconds) {
  const steps = Math.ceil(seconds / 0.05);
  for (let index = 0; index < steps; index += 1) {
    const dt = seconds / steps;
    elapsed += dt;
    camera.position.set(position.x, position.y + 1.75, position.z);
    camera.lookAt(position.x + 80, position.y + 1.5, position.z);
    camera.updateMatrixWorld(true);
    streaming.update(position, camera, dt, elapsed);
    agents.update(position, dt, elapsed);
  }
}

const core = new THREE.Vector3(28, 0, 38);
advance(core, 0.5);
assert(agents.stats.coreSuppressed, 'Streamed agents are not suppressed in core 0:0.');
assert(
  agents.stats.vehicles.visible === 0 && agents.stats.pedestrians.visible === 0,
  'Streamed representatives duplicated authored core actors.',
);
assert(!agents.group.visible, 'Streamed actor render group remains visible in core 0:0.');

const stops = [
  { key: '1:0', position: new THREE.Vector3(256, 0, -59) },
  { key: '2:0', position: new THREE.Vector3(773, 0, -128) },
];
const results = [];
let predictedSectorTwoOwnership = null;

for (const stop of stops) {
  stop.position.y = streaming.getSurfaceHeight(stop.position) + 1.75;
  advance(stop.position, 0.5);
  const first = agents.getEvidenceState(stop.position, 120);
  advance(stop.position, 1);
  const second = agents.getEvidenceState(stop.position, 120);
  const before = actorMap(first);
  const deltas = second.actors
    .filter((actor) => before.has(actor.id))
    .map((actor) => ({
      id: actor.id,
      kind: actor.kind,
      meters: distance(before.get(actor.id).position, actor.position),
    }));
  const vehicleDeltas = deltas.filter((entry) => entry.kind === 'vehicle');
  const pedestrianDeltas = deltas.filter((entry) => entry.kind === 'pedestrian');
  const stats = second.stats;

  assert(stats.focusSectorKey === stop.key, `Agent focus did not reach ${stop.key}.`);
  assert(stats.activeSectorKeys.includes(stop.key), `${stop.key} is not an active agent sector.`);
  assert(stats.activeSectors <= 2 && stats.activeSectors <= stats.maxActiveSectors, 'Active agent sectors exceeded milestone/hard caps.');
  assert(stats.vehicles.visible <= 22, 'Vehicle pool cap exceeded.');
  assert(stats.pedestrians.visible <= 36, 'Pedestrian pool cap exceeded.');
  assert(stats.duplicateIds === 0, 'Duplicate streamed actor IDs detected.');
  assert(stats.conservationError === 0, 'Representative lease conservation error detected.');
  assert(stats.capErrors === 0, 'Streamed agent cap instrumentation reported an error.');
  assert(stats.incrementalDrawCallEstimate <= 24, 'Incremental draw-call estimate exceeded 24.');
  assert(first.visibleWithinRadius.vehicles >= 3 && second.visibleWithinRadius.vehicles >= 3, `${stop.key} has fewer than three nearby visible vehicles.`);
  assert(first.visibleWithinRadius.pedestrians >= 5 && second.visibleWithinRadius.pedestrians >= 5, `${stop.key} has fewer than five nearby visible pedestrians.`);
  assert(stats.vehicles.moving > 0 && stats.pedestrians.moving > 0, `${stop.key} does not have both actor kinds moving.`);
  assert(
    vehicleDeltas.some((entry) => entry.meters > 2),
    `${stop.key} has no vehicle motion delta above 2 m.`,
  );
  assert(
    pedestrianDeltas.filter((entry) => entry.meters > 0.5).length >= 3,
    `${stop.key} has fewer than three pedestrian motion deltas above 0.5 m.`,
  );
  results.push({
    key: stop.key,
    nearby: second.visibleWithinRadius,
    activeSectorKeys: stats.activeSectorKeys,
    vehiclesMovedOver2m: vehicleDeltas.filter((entry) => entry.meters > 2).length,
    pedestriansMovedOverHalfMeter: pedestrianDeltas.filter((entry) => entry.meters > 0.5).length,
    stats,
  });
  const sectorTwoOwnership = agents.getEvidenceState(null, 10000).actors
    .filter((actor) => actor.sectorKey === '2:0')
    .map((actor) => `${actor.id}:${actor.poolIndex}`)
    .sort();
  if (stop.key === '1:0') predictedSectorTwoOwnership = sectorTwoOwnership;
  if (stop.key === '2:0') {
    assert(
      JSON.stringify(predictedSectorTwoOwnership) === JSON.stringify(sectorTwoOwnership),
      'Sector 2:0 actor identity or instance ownership changed across predicted-to-focus handoff.',
    );
  }
}

const sectorTwoIdsBeforeRevisit = agents.getEvidenceState(null, 10000).actors
  .filter((actor) => actor.sectorKey === '2:0')
  .map((actor) => `${actor.id}:${JSON.stringify(actor.appearance)}`)
  .sort();
advance(stops[0].position, 0.5);
advance(stops[1].position, 0.5);
const sectorTwoIdsAfterRevisit = agents.getEvidenceState(null, 10000).actors
  .filter((actor) => actor.sectorKey === '2:0')
  .map((actor) => `${actor.id}:${JSON.stringify(actor.appearance)}`)
  .sort();
assert(
  JSON.stringify(sectorTwoIdsBeforeRevisit) === JSON.stringify(sectorTwoIdsAfterRevisit),
  'Sector 2:0 IDs or appearance changed on deterministic revisit.',
);

console.log(JSON.stringify({
  result: 'streamed agent milestone invariants passed',
  leaseMode: agents.stats.mode,
  leaseLimitation: agents.stats.limitation,
  results,
}, null, 2));
