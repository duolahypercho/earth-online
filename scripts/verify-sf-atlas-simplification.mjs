/** Deterministic projected-coordinate fixtures for sf-atlas simplification. */
import assert from 'node:assert/strict';
import {
  pointToSegmentDistance,
  simplify,
  simplifyClosedRing,
} from './build-sf-atlas.mjs';

const polygonArea = (points) => Math.abs(points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length];
  return sum + point.x * next.z - next.x * point.z;
}, 0) / 2);

const bend = [{ x: 0, z: 0 }, { x: 5, z: 4 }, { x: 10, z: 0 }];
const collinear = [{ x: 0, z: 0 }, { x: 5, z: 0.25 }, { x: 10, z: 0 }];
const closedArea = [{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 8, z: 6 }, { x: 0, z: 6 }, { x: 0, z: 0 }];

for (const point of [...bend, ...collinear, ...closedArea]) {
  assert.equal(Object.hasOwn(point, 'lat'), false, 'Fixtures must use projected x/z points only');
  assert.equal(Object.hasOwn(point, 'lon'), false, 'Fixtures must use projected x/z points only');
}

// This finite 4 m offset assertion fails under the former lat/lon field bug.
assert.equal(pointToSegmentDistance(bend[1], bend[0], bend[2]), 4, 'Projected point-to-segment distance must use x/z coordinates');
assert.deepEqual(simplify(bend, 1), bend, 'A bend above tolerance must be retained');
assert.deepEqual(simplify(collinear, 1), [collinear[0], collinear.at(-1)], 'A near-collinear road below tolerance must reduce to endpoints');

const simplifiedClosedArea = simplify(closedArea, 1);
assert.deepEqual(simplifiedClosedArea[0], simplifiedClosedArea.at(-1), 'Closed area road must remain closed');
assert(polygonArea(simplifiedClosedArea) > 0, 'Closed area road must retain nonzero area');
assert.deepEqual(simplifyClosedRing(closedArea, 1), closedArea.slice(0, -1), 'Closed footprint simplification must retain its nonzero-area open ring');
for (let index = 0; index < 8; index += 1) {
  assert.deepEqual(simplify(bend, 1), simplify(bend, 1), 'Simplification must be repeatable');
  assert.deepEqual(simplify(closedArea, 1), simplifiedClosedArea, 'Closed-area simplification must be repeatable');
}

process.stdout.write(`${JSON.stringify({
  result: 'sf-atlas projected-coordinate simplification verified',
  bentRoadPoints: simplify(bend, 1).length,
  collinearRoadPoints: simplify(collinear, 1).length,
  closedAreaPoints: simplifiedClosedArea.length,
  closedAreaSquareMetres: polygonArea(simplifiedClosedArea),
  deterministicRuns: 8,
}, null, 2)}\n`);
