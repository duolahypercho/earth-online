import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeroTrafficVisuals } from '../src/realmap/hero-traffic-visuals.js';

const scene = new THREE.Scene();
const sourceSmall = new THREE.Group();
sourceSmall.position.set(12, 2.5, -4);
sourceSmall.rotation.y = Math.PI * 0.37;
sourceSmall.scale.setScalar(0.25);
scene.add(sourceSmall);

const sourceLarge = new THREE.Group();
sourceLarge.position.set(-9, -1.25, 18);
sourceLarge.rotation.y = Math.PI * 0.37;
sourceLarge.scale.setScalar(2);
scene.add(sourceLarge);

const visuals = createHeroTrafficVisuals({ scene, maxVehicles: 2, cameraExclusionRadius: 4, cameraFadeDistance: 6 });
visuals.attach([
  { mesh: sourceSmall, variant: 'taxi', color: 0xffc324 },
  { mesh: sourceLarge, variant: 'taxi', color: 0xffc324 },
]);
assert.equal(sourceSmall.visible, false, 'adapter must replace a small primitive source render');
assert.equal(sourceLarge.visible, false, 'adapter must replace a large primitive source render');

let stats = visuals.update({ camera: new THREE.Vector3(0, 4, 0) });
assert.equal(stats.active, 2, 'a distant camera should leave both traffic shells active');
assert.equal(stats.drawCalls, 8, 'the presentation draw budget must be fixed');
assert.equal(stats.materials, 7, 'the material budget must remain shared');

const body = visuals.group.getObjectByName('Hero traffic chassis');
const shadow = visuals.group.getObjectByName('Hero traffic contact shadows');
const firstBody = new THREE.Matrix4();
const secondBody = new THREE.Matrix4();
const firstShadow = new THREE.Matrix4();
const secondShadow = new THREE.Matrix4();
body.getMatrixAt(0, firstBody);
body.getMatrixAt(1, secondBody);
shadow.getMatrixAt(0, firstShadow);
shadow.getMatrixAt(1, secondShadow);

const decompose = (matrix) => {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
};
const first = decompose(firstBody);
const second = decompose(secondBody);
const firstContact = decompose(firstShadow);
const secondContact = decompose(secondShadow);
const expectedBodyScale = new THREE.Vector3(1.88 * 0.98, 1.46 * 0.46, 4.68 * 0.98);
assert.ok(first.scale.distanceTo(expectedBodyScale) < 1e-6, '0.25x source must render at explicit real-world taxi dimensions');
assert.ok(second.scale.distanceTo(expectedBodyScale) < 1e-6, '2x source must render at the same explicit real-world taxi dimensions');
assert.ok(first.position.distanceTo(new THREE.Vector3(12, 2.5 + 0.34 * 1.03, -4)) < 1e-6, 'small source world position and ground offset must be preserved');
assert.ok(second.position.distanceTo(new THREE.Vector3(-9, -1.25 + 0.34 * 1.03, 18)) < 1e-6, 'large source world position and ground offset must be preserved');
assert.ok(first.quaternion.angleTo(sourceSmall.quaternion) < 1e-6, 'small source orientation must be preserved');
assert.ok(second.quaternion.angleTo(sourceLarge.quaternion) < 1e-6, 'large source orientation must be preserved');
assert.ok(Math.abs(firstContact.position.y - (sourceSmall.position.y + 0.025)) < 1e-6, 'small source contact shadow must stay grounded');
assert.ok(Math.abs(secondContact.position.y - (sourceLarge.position.y + 0.025)) < 1e-6, 'large source contact shadow must stay grounded');

stats = visuals.update({ camera: new THREE.Vector3(12, 4.1, -4), hero: new THREE.Vector3(12, 2.5, -4) });
assert.equal(stats.excluded, 1, 'a vehicle on the hero/camera should be excluded instead of obstructing the frame');

stats = visuals.update({ camera: new THREE.Vector3(17, 2.5, -4), hero: new THREE.Vector3(12, 2.5, -4) });
assert.equal(stats.excluded, 1, 'a vehicle inside the gate must be hidden rather than rendered toy-sized');
body.getMatrixAt(0, firstBody);
assert.ok(firstBody.elements.every(Number.isFinite), 'excluded instance matrix must remain valid');

visuals.dispose();
assert.equal(sourceSmall.visible, true, 'disposal must restore the small source rendering');
assert.equal(sourceLarge.visible, true, 'disposal must restore the large source rendering');
console.log('hero traffic visuals verified');
