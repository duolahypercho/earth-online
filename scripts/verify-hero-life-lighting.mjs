import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeroLifeLighting, HERO_LIFE_LIGHTING_BUDGET } from '../src/realmap/hero-life-lighting.js';

const scene = new THREE.Scene();
const pedestrian = new THREE.Group();
pedestrian.position.set(12, 0.4, -3);
pedestrian.rotation.y = 0.7;
scene.add(pedestrian);
const nearPedestrian = new THREE.Group();
nearPedestrian.position.set(1, 0, 0);
scene.add(nearPedestrian);
const vehicle = new THREE.Group();
vehicle.position.set(-9, 0, 18);
vehicle.rotation.y = -0.5;
vehicle.scale.setScalar(2.5);
scene.add(vehicle);

const presentation = createHeroLifeLighting({
  scene,
  maxPedestrians: 2,
  maxVehicles: 1,
  cameraExclusionRadius: 3,
  heroExclusionRadius: 2,
  conditions: { timeOfDay: 'night', weather: 'drizzle' },
});

try {
  presentation.attachPedestrians([{ mesh: pedestrian, topColor: 0x2f6fae }, { mesh: nearPedestrian }]);
  presentation.attachVehicles([{ mesh: vehicle, vehicleColor: 0xc44737 }]);
  presentation.setPracticals([
    { x: 4, y: 3, z: -2, kind: 'storefront' },
    { x: -4, y: 4, z: 6, kind: 'street' },
    { source: vehicle, kind: 'vehicle', intensity: 0.75 },
  ]);
  assert.equal(pedestrian.visible, false, 'replacement must hide the primitive source without mutating its transform');
  assert.equal(vehicle.visible, false, 'replacement must hide vehicle source presentation');

  let stats = presentation.update({ camera: new THREE.Vector3(0, 2, 0), hero: new THREE.Vector3(0, 0, 0), elapsedSeconds: 1 });
  assert.equal(stats.pedestriansActive, 1, 'near-camera pedestrian should be excluded');
  assert.equal(stats.pedestriansExcluded, 1, 'near pedestrian exclusion is required for hero framing');
  assert.equal(stats.vehiclesActive, 1, 'distant vehicle should remain rendered');
  assert.equal(stats.vehiclesDetailed, 1, 'near-field vehicle must keep wheel detail');
  assert.equal(stats.activePracticals, 3, 'night practical hierarchy should activate supplied warm anchors');
  assert.equal(stats.pointLights, 6, 'strict practical-light cap regressed');
  assert.equal(stats.drawCalls, 10, 'fixed draw-call budget regressed');
  assert.equal(stats.materials, 8, 'shared material budget regressed');
  assert.equal(stats.budget.maxPracticals, 6, 'public budget must expose six-light ceiling');

  const torso = presentation.group.getObjectByName('Hero life pedestrian torsos');
  const torsoMatrix = new THREE.Matrix4();
  torso.getMatrixAt(0, torsoMatrix);
  const torsoPosition = new THREE.Vector3();
  const torsoQuaternion = new THREE.Quaternion();
  const torsoScale = new THREE.Vector3();
  torsoMatrix.decompose(torsoPosition, torsoQuaternion, torsoScale);
  assert.ok(torsoPosition.distanceTo(new THREE.Vector3(12, 1.53, -3)) < 1e-6, 'presentation must preserve source world location with adult grounding offset');
  assert.ok(torsoQuaternion.angleTo(pedestrian.quaternion) < 1e-6, 'presentation must preserve simulation heading');
  assert.ok(torsoScale.distanceTo(new THREE.Vector3(0.48, 0.98, 0.36)) < 1e-6, 'source authoring scale must not make the human a toy');

  stats = presentation.update({ camera: new THREE.Vector3(200, 2, 0), elapsedSeconds: 2 });
  assert.equal(stats.pedestriansActive, 2, 'moving the camera away should admit both pedestrians');
  const day = presentation.setConditions({ timeOfDay: 'day', weather: 'clear' });
  assert.equal(day.night, 0, 'day condition must turn off practical hierarchy');
  stats = presentation.update({ camera: new THREE.Vector3(200, 2, 0) });
  assert.equal(stats.activePracticals, 0, 'day practicals should remain uncounted as active');

  const lightCount = presentation.group.children.filter((child) => child.isPointLight).length;
  assert.equal(lightCount, HERO_LIFE_LIGHTING_BUDGET.maxPracticals, 'adapter must create no more than six shadowless point lights');
  assert.ok(presentation.group.children.filter((child) => child.isPointLight).every((light) => !light.castShadow), 'practical lights must not cast shadows');
  console.log(JSON.stringify({ result: 'hero life and lighting verified', stats }, null, 2));
} finally {
  presentation.dispose();
}

assert.equal(pedestrian.visible, true, 'dispose must restore pedestrian source visibility');
assert.equal(nearPedestrian.visible, true, 'dispose must restore excluded pedestrian source visibility');
assert.equal(vehicle.visible, true, 'dispose must restore vehicle source visibility');
assert.equal(scene.children.includes(presentation.group), false, 'dispose must detach adapter group');
