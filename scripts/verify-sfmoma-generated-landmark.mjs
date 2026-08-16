import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createSfmomaGeneratedLandmark,
  SFMOMA_GENERATED_V1_BUDGET,
  SFMOMA_GENERATED_V1_SOURCE,
} from '../src/citygen/landmarks/sfmoma-generated-v1.js';

const asset = createSfmomaGeneratedLandmark();
const { root, stats } = asset;
const diagnostics = asset.getDiagnostics();

assert.equal(root.name, 'SFMOMA generated landmark v1');
assert.equal(root.userData.source.reference, SFMOMA_GENERATED_V1_SOURCE.reference);
assert.equal(diagnostics.source.presentationOnly, true);
assert.equal(diagnostics.source.hiddenElevations, 'approximate');
assert.ok(root.getObjectByName('sfmoma.darkPodium'));
assert.ok(root.getObjectByName('sfmoma.galleryStack'));
assert.ok(root.getObjectByName('sfmoma.redTower'));
assert.ok(root.getObjectByName('sfmoma.glassSystems'));
assert.ok(root.getObjectByName('sfmoma.architecturalDetails'));
assert.equal(diagnostics.identityFeatures.stackedGalleryVolumes, 6);
assert.equal(diagnostics.identityFeatures.redTowerRibs, 40);
assert.equal(diagnostics.identityFeatures.rearCurtainWalls, 3);
assert.ok(diagnostics.identityFeatures.curtainWallMullions >= 30);
assert.ok(diagnostics.identityFeatures.concreteSeams >= 20);
assert.equal(diagnostics.identityFeatures.entryDoors, 4);
assert.equal(diagnostics.pbr.independentChannels, true);
assert.equal(diagnostics.pbr.exactRecoveryClaimed, false);
assert.ok(stats.drawCalls <= SFMOMA_GENERATED_V1_BUDGET.maxDrawCalls, `draw calls ${stats.drawCalls}`);
assert.ok(stats.triangles <= SFMOMA_GENERATED_V1_BUDGET.maxTriangles, `triangles ${stats.triangles}`);
assert.ok(stats.textures <= SFMOMA_GENERATED_V1_BUDGET.maxTextures, `textures ${stats.textures}`);

const concrete = asset.materials.concrete;
const red = asset.materials.redCladding;
for (const material of [concrete, red]) {
  assert.ok(material.map?.isTexture, `${material.name} albedo`);
  assert.ok(material.roughnessMap?.isTexture, `${material.name} roughness`);
  assert.ok(material.bumpMap?.isTexture, `${material.name} bump`);
  assert.notEqual(material.map, material.roughnessMap, `${material.name} albedo/roughness independence`);
  assert.notEqual(material.map, material.bumpMap, `${material.name} albedo/bump independence`);
  assert.notEqual(material.roughnessMap, material.bumpMap, `${material.name} roughness/bump independence`);
}

const bounds = new THREE.Box3().setFromObject(root);
const size = bounds.getSize(new THREE.Vector3());
assert.ok(size.x >= 37.9 && size.x <= 38.1, `width ${size.x}`);
assert.ok(size.y >= 38 && size.y <= 40, `height ${size.y}`);
assert.ok(size.z >= 16.3 && size.z <= 16.4, `depth ${size.z}`);

root.traverse((object) => {
  if (!object.isMesh) return;
  const position = object.geometry.attributes.position;
  assert.ok(position && Array.from(position.array).every(Number.isFinite), `${object.name} finite positions`);
  if (object.isInstancedMesh) {
    assert.ok(Array.from(object.instanceMatrix.array).every(Number.isFinite), `${object.name} finite matrices`);
  }
});

asset.dispose();
assert.equal(asset.getDiagnostics().disposed, true);
assert.equal(root.parent, null);

console.log(JSON.stringify({ result: 'passed', stats, size: size.toArray(), source: diagnostics.source }, null, 2));
