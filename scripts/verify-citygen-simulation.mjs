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
}
if (oneWayEdges.size === 0) failures.push('no one-way streets found');

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
