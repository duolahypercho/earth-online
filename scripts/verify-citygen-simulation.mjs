import { generateCity, buildTrafficGraph } from '../src/citygen/core.js';
import { TrafficSim } from '../src/citygen/traffic.js';

// Deterministic simulation gate: one-way streets must produce exactly one
// legal travel direction, two-way streets exactly two, and every signal edge
// must honor red phases the same way the runtime TrafficSim does.
const city = generateCity({ seed: 731, style: 'sanfrancisco', extent: 660 });
const edges = buildTrafficGraph(city);
const bySegment = new Map();
for (const segment of city.segments) bySegment.set(segment.id, segment);

const failures = [];
const oneWayEdges = new Set();
let successorLinks = 0;
let edgesWithUsefulSuccessors = 0;
let maxCornerJump = 0;
for (const edge of edges) {
  const segment = bySegment.get(edge.segmentId);
  if (!segment) {
    failures.push(`edge ${edge.id} references missing segment`);
    continue;
  }
  if (edge.direction === 'increasing' && segment.oneway === 'decreasing') {
    failures.push(`${edge.id} drives against one-way decreasing`);
  }
  if (edge.direction === 'decreasing' && segment.oneway === 'increasing') {
    failures.push(`${edge.id} drives against one-way increasing`);
  }
  if (segment.oneway === 'both') {
    const forward = edges.some((e) => e.segmentId === segment.id && e.direction === 'increasing');
    const reverse = edges.some((e) => e.segmentId === segment.id && e.direction === 'decreasing');
    if (!forward || !reverse) failures.push(`${segment.id} two-way missing a direction`);
  } else {
    oneWayEdges.add(segment.id);
    const count = edges.filter((e) => e.segmentId === segment.id).length;
    if (count !== 1) failures.push(`${segment.id} one-way has ${count} directions`);
  }
  const last = edge.points[edge.points.length - 1];
  let hasUsefulSuccessor = false;
  for (const successor of edge.outgoing || []) {
    successorLinks += 1;
    const first = successor.points[0];
    const cornerJump = Math.hypot(first.x - last.x, first.z - last.z);
    maxCornerJump = Math.max(maxCornerJump, cornerJump);
    if (cornerJump > 0.25) {
      failures.push(`${edge.id} -> ${successor.id} jumps ${cornerJump.toFixed(3)}m at the corner`);
    }
    if (successor.segmentId !== edge.segmentId) hasUsefulSuccessor = true;
  }
  if (hasUsefulSuccessor) edgesWithUsefulSuccessors += 1;
}
if (oneWayEdges.size === 0) failures.push('no one-way streets found');
if (successorLinks === 0) failures.push('traffic graph has no successor links');
if (edgesWithUsefulSuccessors < edges.length / 2) {
  failures.push(`only ${edgesWithUsefulSuccessors}/${edges.length} edges have useful successors`);
}
if (maxCornerJump > 0.25) failures.push(`maximum corner jump is ${maxCornerJump.toFixed(3)}m`);

// Real-SF street IDs do not encode an axis. Lane placement must use the
// segment's source direction, including diagonals, rather than ID prefixes.
const osmSegment = {
  id: 'osm-seg-direction-check',
  streetId: 'osm-way-123456',
  streetName: 'Direction Check',
  highway: 'residential',
  lanes: 2,
  oneway: 'increasing',
  width: 8,
  points: [{ x: 2, z: 3 }, { x: 14, z: 8 }],
};
const [osmEdge] = buildTrafficGraph({ segments: [osmSegment] });
const sourceMidpoint = {
  x: (osmSegment.points[0].x + osmSegment.points[1].x) / 2,
  z: (osmSegment.points[0].z + osmSegment.points[1].z) / 2,
};
const sourceDx = osmSegment.points[1].x - osmSegment.points[0].x;
const sourceDz = osmSegment.points[1].z - osmSegment.points[0].z;
const sourceLength = Math.hypot(sourceDx, sourceDz);
const expectedOffset = Math.max(1.15, osmSegment.width / 2 - 1.45);
const expectedMidpoint = {
  x: sourceMidpoint.x - (sourceDz / sourceLength) * expectedOffset,
  z: sourceMidpoint.z + (sourceDx / sourceLength) * expectedOffset,
};
const laneMidpoint = osmEdge?.points?.[1];
if (!laneMidpoint || Math.hypot(laneMidpoint.x - expectedMidpoint.x, laneMidpoint.z - expectedMidpoint.z) > 1e-9) {
  failures.push('OSM-style segment lane offset does not follow source direction');
}

// Runtime signal behavior: emulate TrafficSim's phase math at every signal.
const fakeRenderer = { terrain: { heightAt: () => 0 }, scene: { add() {}, remove() {} } };
const sim = new TrafficSim(fakeRenderer, city, { count: 0 });
const phaseSamples = Array.from({ length: 32 }, (_, index) => index);
let signalEdgesChecked = 0;
for (const signal of city.signals) {
  for (const edge of edges) {
    if (edge.signalId !== signal.id) continue;
    signalEdgesChecked += 1;
    const blocked = [];
    const free = [];
    for (const phase of phaseSamples) {
      sim.phase = phase;
      const car = { edge, distance: 0 };
      if (sim.signalBlocked(car)) blocked.push(phase);
      else free.push(phase);
    }
    if (!blocked.length) failures.push(`${edge.id} never stops at ${signal.id}`);
    if (!free.length) failures.push(`${edge.id} is permanently red at ${signal.id}`);
  }
}
if (!signalEdgesChecked) failures.push('no signal-controlled traffic edges found');

const result = {
  city: describe(city),
  edges: edges.length,
  oneWayStreets: city.streets.filter((street) => street.oneway !== 'both').length,
  successorLinks,
  edgesWithUsefulSuccessors,
  maxCornerJump,
  signalEdgesChecked,
  failures,
};
if (failures.length) {
  console.error(JSON.stringify({ result: 'FAIL', ...result }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ result: 'PASS', ...result }, null, 2));
}

function describe(city) {
  return {
    buildings: city.buildings.length,
    blocks: city.blocks.length,
    streets: city.streets.length,
    segments: city.segments.length,
    signals: city.signals.length,
  };
}
