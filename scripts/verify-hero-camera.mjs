import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeroCamera } from '../src/realmap/hero-camera.js';

const focus = new THREE.Vector3(0, 1.08, 0);
const camera = new THREE.PerspectiveCamera(52, 16 / 9, 1, 500);
const controller = createHeroCamera({ distance: 5, verticalOffset: 1.1, shoulderOffset: 0 });

const clear = controller.update({ camera, focus, yaw: 0, dt: 1 / 60 });
assert.equal(clear.occluded, false, 'an unobstructed arm should retain its hero framing');
assert.ok(clear.armDistance > 4.9, 'the clear arm should remain close to its requested distance');
assert.equal(camera.near, 0.08, 'the controller should keep a near-clip-safe camera plane');
const clearArmDistance = clear.armDistance;

const wall = new THREE.Box3(
  new THREE.Vector3(-2, 0, -3.2),
  new THREE.Vector3(2, 4, -2.65),
);
controller.reset();
const blocked = controller.update({
  camera,
  focus,
  yaw: 0,
  collisionBoxes: [wall],
  dt: 1 / 60,
});
assert.equal(blocked.occluded, true, 'a box across the spring arm should be reported');
assert.equal(blocked.obstructionType, 'box', 'the diagnostic should identify box avoidance');
assert.ok(blocked.armDistance < clearArmDistance, 'the arm should retract before crossing a wall');
assert.ok(
  camera.position.z > wall.max.z - 0.001,
  'the retracted camera should remain on the character side of the wall',
);

const framedCamera = new THREE.PerspectiveCamera(52, 16 / 9, 1, 500);
const framed = createHeroCamera({
  distance: 5,
  verticalOffset: 1.1,
  shoulderOffset: 0,
  framingOffset: { x: 1.25, y: 0.2 },
});
const framedClear = framed.update({ camera: framedCamera, focus, yaw: 0, dt: 1 / 60 });
assert.equal(framedClear.occluded, false, 'framing offset must not create an obstruction');
assert.ok(framedClear.armDistance > 4.9, 'framing offset must preserve the requested camera arm');
assert.deepEqual(framedClear.framingOffset, { x: 1.25, y: 0.2 }, 'the active aim bias should be diagnostic');
assert.ok(Math.abs(framedClear.lookTarget.x - 1.25) < 0.001, 'the aim bias should offset the target in camera space');
assert.ok(Math.abs(framedClear.lookTarget.y - 1.36) < 0.001, 'the vertical aim bias should offset the target');

console.log('hero camera verifier passed: unobstructed, occluded, and framed spring-arm cases');
