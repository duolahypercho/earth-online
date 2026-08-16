/** Adversarial verifier for the deterministic, offline Ferry Boolean foundation. */
import assert from 'node:assert/strict';
import { FERRY_BOOLEAN_V1, assertStaticLockContract, buildFerrySurfaceBooleanPlan, booleanDifference, booleanNormalize, booleanUnion, normalizeSurface, triangulatePolygon } from './ferry-surface-boolean-v1.mjs';

const square = (left, bottom, right, top) => [[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]];
const area2 = (ring) => ring.reduce((sum, point, index) => {
  const next = ring[(index + 1) % ring.length];
  return sum + BigInt(point[0]) * BigInt(next[1]) - BigInt(next[0]) * BigInt(point[1]);
}, 0n);
const polygonArea2 = ({ outer, holes = [] }) => area2(outer) - holes.reduce((sum, hole) => sum + (area2(hole) < 0n ? -area2(hole) : area2(hole)), 0n);
const allArea2 = (polygons) => polygons.reduce((sum, polygon) => sum + polygonArea2(polygon), 0n);

// The committed OSM multipolygon has exactly one outer ring and two inner rings.
const first = await buildFerrySurfaceBooleanPlan();
assertStaticLockContract(first.lock);
assert.deepEqual(first.plan.coordinateFrame, FERRY_BOOLEAN_V1.coordinateFrame, 'Plan coordinate frame must be the exact locked frame');
assert.deepEqual(first.plan.boolean, FERRY_BOOLEAN_V1.boolean, 'Plan Boolean contract must be the exact locked contract');
assert.deepEqual(first.plan.triangulation, FERRY_BOOLEAN_V1.triangulation, 'Plan triangulation contract must be the exact locked contract');
const driftedLock = structuredClone(first.lock);
driftedLock.coordinateContract.frame = 'drifted-frame';
assert.throws(() => assertStaticLockContract(driftedLock), /coordinate contract drifted/, 'Coordinate-lock drift must fail before a plan can be accepted');
const relation = first.plan.records.find(({ recordId }) => recordId === 'relation/2642389');
assert(relation, 'Ferry relation/2642389 must remain in the Boolean plan');
assert.equal(relation.polygons.length, 1, 'Ferry relation must remain one filled polygon');
assert.equal(relation.polygons[0].holes.length, 2, 'Ferry relation must preserve both holes');
assert(relation.polygons[0].triangulation.triangles.length > 0, 'Ferry relation must triangulate');

// Explicit ownership: higher-priority pavement wins its overlap with lower-priority pavement.
const low = { outers: [square(0, 0, 20, 20)] };
const high = { outers: [square(10, 0, 30, 20)] };
const visibleLow = booleanDifference(low, [high], 'precedence low minus high');
assert.equal(allArea2(visibleLow), 400n, 'Overlap precedence must remove the high-priority shared 10 x 20 region');
assert.equal(allArea2(booleanUnion([low, high], 'precedence union')), 1200n, 'Union must preserve the authored 30 x 20 footprint');
const fullyClipped = booleanDifference({ outers: [square(0, 0, 10, 10)] }, [
  { outers: [square(0, 0, 6, 10)] }, { outers: [square(4, 0, 10, 10)] },
], 'overlapping clips');
assert.deepEqual(fullyClipped, [], 'Overlapping clips must not restore their 4..6 overlap strip');

// Exact shared edges and vertices are valid Boolean inputs and must not create slivers or throw.
const sharedEdge = booleanUnion([{ outers: [square(0, 0, 10, 10)] }, { outers: [square(10, 0, 20, 10)] }], 'shared edge');
assert.equal(allArea2(sharedEdge), 400n, 'Shared-edge union area drifted');
const sharedVertex = booleanUnion([{ outers: [square(0, 0, 10, 10)] }, { outers: [square(10, 10, 20, 20)] }], 'shared vertex');
assert.equal(allArea2(sharedVertex), 400n, 'Shared-vertex union area drifted');

// A one-tick gap stays distinct, while coincident edges collapse under the exact same grid contract.
const oneTickGap = booleanUnion([{ outers: [square(0, 0, 10, 10)] }, { outers: [square(11, 0, 21, 10)] }], 'one tick gap');
assert.equal(oneTickGap.length, 2, 'One-tick gap must not be snapped closed after quantization');
const coincidence = booleanUnion([{ outers: [square(0, 0, 10, 10)] }, { outers: [square(10, 0, 20, 10)] }], 'coincidence');
assert.equal(coincidence.length, 1, 'Coincident edge must have one unioned filled polygon');

// Winding and only duplicate-terminal/consecutive cleanup are canonicalized identically.
const canonical = booleanNormalize({ outers: [square(0, 0, 12, 9)] }, 'canonical source');
const reversedWithDuplicates = booleanNormalize({ outers: [[[0, 0], [0, 0], [0, 9], [12, 9], [12, 0], [0, 0], [0, 0]]] }, 'reversed duplicate source');
assert.deepEqual(reversedWithDuplicates, canonical, 'Reversed winding and duplicate cleanup must be canonical-equivalent');
const sortedForward = booleanUnion([{ outers: [square(30, 0, 40, 10)] }, { outers: [square(0, 0, 10, 10)] }], 'canonical sort forward');
const sortedReverse = booleanUnion([{ outers: [square(0, 0, 10, 10)] }, { outers: [square(30, 0, 40, 10)] }], 'canonical sort reverse');
assert.deepEqual(sortedForward, sortedReverse, 'Canonical path ordering must not depend on source order or host locale');

// Concavity plus two holes must preserve exact integer area through Earcut triangulation.
const concave = {
  outer: [[0, 0], [30, 0], [30, 30], [18, 30], [18, 12], [12, 12], [12, 30], [0, 30]],
  holes: [square(2, 2, 8, 8), square(22, 2, 28, 8)],
};
const concaveTriangles = triangulatePolygon(concave, 'concave two-hole fixture');
assert.equal(BigInt(concaveTriangles.area2), polygonArea2(concave), 'Concave hole triangulation must conserve exact area');

// Ambiguous or unsafe geometry fails rather than receiving a best-effort Boolean interpretation.
assert.throws(() => normalizeSurface({ outers: [[[0, 0], [10, 10], [0, 10], [10, 0]]] }, 'bow tie'), /self-intersects/);
assert.throws(() => normalizeSurface({ outers: [square(0, 0, 10, 10)], holes: [square(20, 20, 21, 21)] }, 'exterior hole'), /strictly inside exactly one outer ring/);
assert.throws(() => normalizeSurface({ outers: [square(0, 0, 10_000_001, 1)] }, 'range overflow'), /conservative/);
assert.throws(() => triangulatePolygon({ outer: square(0, 0, 10, 10), holes: [square(20, 20, 21, 21)] }, 'triangulation exterior hole'), /strictly inside exactly one outer ring/);
assert.throws(() => triangulatePolygon({ outer: square(0, 0, 10, 10), holes: [square(0, 2, 2, 4)] }, 'triangulation touching hole'), /strictly inside exactly one outer ring|touches or crosses/);
assert.throws(() => triangulatePolygon({ outer: square(0, 0, 10, 10), holes: [square(2, 2, 6, 6), square(4, 4, 8, 8)] }, 'triangulation overlapping holes'), /touch or cross|overlap or contain/);

// The complete source-derived plan must be byte-identical on repeated runs.
const second = await buildFerrySurfaceBooleanPlan();
assert(first.bytes.equals(second.bytes), 'Repeated Ferry Boolean builds differ byte-for-byte');

process.stdout.write(`${JSON.stringify({ result: 'Ferry offline Boolean foundation verified adversarially', relationHoles: relation.polygons[0].holes.length, relationTriangles: relation.polygons[0].triangulation.triangles.length, deterministicRebuild: true, planBytes: first.bytes.length }, null, 2)}\n`);
