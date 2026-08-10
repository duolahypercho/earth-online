import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeroLifeLighting, HERO_LIFE_LIGHTING_BUDGET } from '../src/realmap/hero-life-lighting.js';

const scene = new THREE.Scene();
const makePedestrian = (x, z, yaw = 0) => {
  const root = new THREE.Group();
  root.position.set(x, 0.4, z);
  root.rotation.y = yaw;
  scene.add(root);
  return root;
};
// Four adults are deliberately inside the close-detail radius but outside the
// camera/hero exclusion envelope. The fifth confirms that close detail never
// obstructs the player framing.
const detailPedestrians = [
  makePedestrian(9, -3, 0.7),
  makePedestrian(11, 3, -0.4),
  makePedestrian(14, -4, 1.2),
  makePedestrian(18, 1, -1.1),
];
const nearPedestrian = makePedestrian(1, 0);
const vehicle = new THREE.Group();
vehicle.position.set(-9, 0, 18);
vehicle.rotation.y = -0.5;
vehicle.scale.setScalar(2.5);
scene.add(vehicle);

const presentation = createHeroLifeLighting({
  scene,
  maxPedestrians: 5,
  maxVehicles: 1,
  cameraExclusionRadius: 3,
  heroExclusionRadius: 2,
  pedestrianDetailDistance: 22,
  conditions: { timeOfDay: 'night', weather: 'drizzle' },
});

function activeDetailRoots() {
  return presentation.group.children.filter((child) => child.userData?.heroLifeDetailedActor && child.visible);
}

try {
  presentation.attachPedestrians([...detailPedestrians, nearPedestrian].map((mesh, index) => ({
    mesh,
    topColor: [0x2f6fae, 0x765043, 0x536e59, 0x74546f][index % 4],
  })));
  presentation.attachVehicles([{ mesh: vehicle, vehicleColor: 0xc44737 }]);
  presentation.setPracticals([
    { x: 4, y: 3, z: -2, kind: 'storefront' },
    { x: -4, y: 4, z: 6, kind: 'street' },
    { source: vehicle, kind: 'vehicle', intensity: 0.75 },
  ]);
  for (const source of [...detailPedestrians, nearPedestrian]) {
    assert.equal(source.visible, false, 'replacement must hide each primitive pedestrian source');
  }
  assert.equal(vehicle.visible, false, 'replacement must hide vehicle source presentation');

  const camera = new THREE.Vector3(0, 2, 0);
  const hero = new THREE.Vector3(0, 0, 0);
  let stats = presentation.update({ camera, hero, elapsedSeconds: 1, deltaSeconds: 1 / 60 });
  assert.equal(stats.pedestriansActive, 4, 'the near player-envelope pedestrian must be excluded');
  assert.equal(stats.pedestriansExcluded, 1, 'near player exclusion is required for clean hero framing');
  assert.equal(stats.detailedActors, 4, 'four eligible close adults must use the bounded player-grade pool');
  assert.equal(stats.fallbackActors, stats.pedestriansActive - stats.detailedActors, 'no detailed adult may render an instanced duplicate');
  assert.equal(stats.swaps, 4, 'first four assignments must be counted exactly once');
  assert.ok(stats.detailDrawCost >= 4 && stats.detailMaterials > 0, 'active detail draw/material diagnostics are required');
  assert.equal(stats.performanceTargetFps, 60, 'the close-rig performance floor must remain explicit');
  assert.equal(stats.detailAssignments.length, 4, 'every detailed adult must expose an assignment diagnostic');
  assert.equal(new Set(stats.detailAssignments.map(({ sourceUuid }) => sourceUuid)).size, 4, 'detailed actors cannot share a source');
  assert.deepEqual(
    new Set(stats.detailAssignments.map(({ sourceUuid }) => sourceUuid)),
    new Set(detailPedestrians.map((source) => source.uuid)),
    'detailed actor mapping must cover the four selected source UUIDs exactly',
  );
  assert.equal(activeDetailRoots().length, 4, 'the visible detailed-root count must equal the diagnostic count');
  for (const root of activeDetailRoots()) {
    assert.ok(detailPedestrians.some((source) => source.uuid === root.userData.heroLifeSource), 'every detailed root must map to a selected source UUID');
    assert.deepEqual(root.scale.toArray(), [1, 1, 1], 'source authoring scale must not make a detailed adult a toy');
    let visibleSprites = 0;
    root.traverse((object) => { if (object.isSprite && object.visible) visibleSprites += 1; });
    assert.equal(visibleSprites, 0, 'detailed civilians must not display name tags or thought UI');
  }
  assert.equal(stats.vehiclesActive, 1, 'distant vehicle should remain rendered');
  assert.equal(stats.vehiclesDetailed, 1, 'near-field vehicle must keep wheel detail');
  assert.equal(stats.activePracticals, 3, 'night practical hierarchy should activate supplied warm anchors');
  assert.ok(stats.practicalLightPower > 6, 'night anchors must carry enough bounded local light to read on facade and paving');
  assert.ok(stats.practicalGlowOpacity >= 0.75, 'night drizzle must expose the bounded emissive practical response');
  assert.equal(stats.pointLights, 6, 'strict practical-light cap regressed');
  assert.equal(stats.drawCalls, 10, 'fixed instanced draw-call budget regressed');
  assert.equal(stats.materials, 8, 'shared material budget regressed');
  assert.equal(stats.budget.maxPracticals, 6, 'public budget must expose six-light ceiling');

  const assignmentByActor = new Map(stats.detailAssignments.map(({ actor, sourceUuid }) => [actor, sourceUuid]));
  // An unchanged next frame must retain identities rather than teleporting a
  // wardrobe onto a different nearby source.
  stats = presentation.update({ camera, hero, elapsedSeconds: 1.1, deltaSeconds: 0.1 });
  assert.equal(stats.swaps, 4, 'stable close crowd must not produce assignment churn');
  assert.deepEqual(new Map(stats.detailAssignments.map(({ actor, sourceUuid }) => [actor, sourceUuid])), assignmentByActor, 'detail identities must remain stable across frames');

  detailPedestrians[0].position.x += 0.7;
  stats = presentation.update({ camera, hero, elapsedSeconds: 1.2, deltaSeconds: 0.1 });
  const movingAssignment = stats.detailAssignments.find(({ sourceUuid }) => sourceUuid === detailPedestrians[0].uuid);
  assert.ok(movingAssignment, 'moving source must retain its detailed assignment');
  assert.equal(movingAssignment.position[0], 9.7, 'detailed actor must track source movement without a stale position');
  assert.equal(stats.swaps, 4, 'normal source movement cannot swap wardrobe identity');

  // Leaving and re-entering the detail radius should return the actor to the
  // instanced fallback, then make one explicit re-entry swap without a clone.
  detailPedestrians[3].position.set(40, 0.4, 1);
  stats = presentation.update({ camera, hero, elapsedSeconds: 1.3, deltaSeconds: 0.1 });
  assert.equal(stats.detailedActors, 3, 'out-of-range source must leave the detail pool');
  assert.equal(stats.fallbackActors, 1, 'out-of-range source must return to the instanced fallback');
  assert.equal(stats.pedestriansActive, stats.detailedActors + stats.fallbackActors, 'active crowd must never double-render a source');
  detailPedestrians[3].position.set(18, 0.4, 1);
  stats = presentation.update({ camera, hero, elapsedSeconds: 1.4, deltaSeconds: 0.1 });
  assert.equal(stats.detailedActors, 4, 're-entered source must regain a detailed actor');
  assert.equal(stats.fallbackActors, 0, 're-entered source cannot keep its fallback duplicate');
  assert.equal(stats.swaps, 5, 're-entry must produce exactly one diagnosable assignment swap');

  const day = presentation.setConditions({ timeOfDay: 'day', weather: 'clear' });
  assert.equal(day.night, 0, 'day condition must turn off practical hierarchy');
  stats = presentation.update({ camera, hero, elapsedSeconds: 2, deltaSeconds: 1 / 60 });
  assert.equal(stats.activePracticals, 0, 'day practicals should remain uncounted as active');
  assert.equal(stats.practicalGlowOpacity, 0, 'day must not inherit the night-only glow cards');
  assert.equal(stats.detailedActors, 4, 'final verifier snapshot must retain active detailed adults');

  presentation.setConditions({ timeOfDay: 'night', weather: 'drizzle' });
  stats = presentation.update({ camera, hero, elapsedSeconds: 2.2, deltaSeconds: 1 / 60 });
  assert.equal(stats.conditions.wetness, 0.9, 'drizzle must derive the expected wet practical response');
  assert.ok(stats.practicalGlowOpacity >= 0.75, 'drizzle must retain a visible local glow response');
  assert.ok(stats.practicalLightPower > 6, 'drizzle cannot collapse local storefront light power');

  const lightCount = presentation.group.children.filter((child) => child.isPointLight).length;
  assert.equal(lightCount, HERO_LIFE_LIGHTING_BUDGET.maxPracticals, 'adapter must create no more than six shadowless point lights');
  assert.ok(presentation.group.children.filter((child) => child.isPointLight).every((light) => !light.castShadow), 'practical lights must not cast shadows');
  console.log(JSON.stringify({ result: 'hero life and lighting verified', stats }, null, 2));
} finally {
  presentation.dispose();
}

for (const source of [...detailPedestrians, nearPedestrian]) {
  assert.equal(source.visible, true, 'dispose must restore pedestrian source visibility');
}
assert.equal(vehicle.visible, true, 'dispose must restore vehicle source visibility');
assert.equal(scene.children.includes(presentation.group), false, 'dispose must detach adapter group');
