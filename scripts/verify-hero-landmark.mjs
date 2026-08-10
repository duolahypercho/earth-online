import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createFerryBuildingLandmark,
  FERRY_BUILDING_LANDMARK_BUDGET,
  FERRY_BUILDING_LANDMARK_SOURCE,
} from '../src/realmap/hero-landmark.js';

const building = {
  id: 558731934,
  name: 'San Francisco Ferry Building',
  height: 15,
  centroid: [2290.3, 1937.6],
  // Compact fixture matching the long, diagonal OSM terminal character.
  points: [2325.5, 1844.6, 2346.6, 1859.9, 2223, 2018.2, 2206.4, 2006.2, 2325.5, 1844.6],
};
const scene = new THREE.Scene();
const sourceMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
sourceMesh.userData.building = building;
scene.add(sourceMesh);
const landmark = createFerryBuildingLandmark({ scene, building, sourceMesh, elevationAt: () => 1.8 });

assert.equal(FERRY_BUILDING_LANDMARK_SOURCE.osmWay, 558731934, 'landmark must retain the exact OSM way');
assert.equal(landmark.root.userData.source.osmWay, 558731934, 'source diagnostics must expose the exact OSM way');
assert.ok(scene.children.includes(landmark.root), 'landmark should attach to the caller scene');
assert.equal(sourceMesh.visible, false, 'only the matching supplied source render should be hidden');
assert.equal(landmark.getDiagnostics().source.osmWay, 558731934, 'runtime diagnostics must retain source identity');
assert.equal(landmark.getDiagnostics().hiddenSourceRender, true, 'runtime diagnostics must record suppression');
assert.ok(landmark.stats.drawCalls <= FERRY_BUILDING_LANDMARK_BUDGET.maxDrawCalls, 'draw-call budget must hold');
assert.ok(landmark.stats.triangles <= FERRY_BUILDING_LANDMARK_BUDGET.maxTriangles, 'triangle budget must hold');
assert.ok(landmark.stats.instances <= FERRY_BUILDING_LANDMARK_BUDGET.maxInstances, 'instance budget must hold');
assert.ok(landmark.root.getObjectByName('Ferry Building clock tower pyramidal roof'), 'clock tower silhouette is required');
assert.ok(landmark.root.getObjectByName('Ferry Building clock faces').count === 4, 'all four clock faces are required');

const unrelated = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
unrelated.userData.buildingId = 999;
const noHide = createFerryBuildingLandmark({ scene: new THREE.Scene(), building, sourceMesh: unrelated });
assert.equal(unrelated.visible, true, 'unrelated source render must never be hidden');
noHide.dispose();

assert.throws(
  () => createFerryBuildingLandmark({ scene: new THREE.Scene(), building: { ...building, id: 999 } }),
  /refused/,
  'missing the exact source building must fail closed',
);
landmark.update(1 / 30);
landmark.dispose();
assert.equal(landmark.disposed, true, 'dispose should be idempotently recorded');
assert.equal(landmark.root.parent, null, 'dispose should detach the landmark');
assert.equal(sourceMesh.visible, true, 'dispose should restore matching source visibility');
assert.equal(landmark.getDiagnostics().disposed, true, 'runtime diagnostics should report lifecycle state');

console.log(JSON.stringify({ result: 'passed', source: FERRY_BUILDING_LANDMARK_SOURCE, stats: landmark.stats }, null, 2));
