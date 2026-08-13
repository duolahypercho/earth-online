import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFerryBuildingAtmosphere } from '../src/realmap/hero-atmosphere.js';

// Includes GLSL ES keywords and future-reserved names that WebGL drivers reject.
// Keeping this gate driver-agnostic prevents failures that only appear on Metal,
// ANGLE, or a specific browser's shader translator.
const RESERVED_GLSL_IDENTIFIERS = new Set(`
  active asm attribute bool break bvec2 bvec3 bvec4 case cast centroid class common
  const continue default discard do double else enum extern external false filter
  fixed flat float for fvec2 fvec3 fvec4 goto half highp if in inline inout input
  int interface invariant ivec2 ivec3 ivec4 layout long lowp mat2 mat3 mat4
  mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 mediump
  namespace noinline noperspective out output packed partition precision public
  return sampler1D sampler1DShadow sampler2D sampler2DArray sampler2DArrayShadow
  sampler2DShadow sampler3D samplerCube samplerCubeShadow short smooth static
  struct superp switch template this true typedef uint union uniform unsigned
  using varying vec2 vec3 vec4 void volatile while
`.trim().split(/\s+/));

function uniformDeclarations(source) {
  const declarations = [];
  const pattern = /\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?\w+\s+(\w+)\s*(?:\[[^\]]+\])?\s*;/g;
  for (const match of source.matchAll(pattern)) declarations.push(match[1]);
  return declarations;
}

function waterResourceCounts(root) {
  const meshes = new Set();
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  let lights = 0;
  root.traverse((object) => {
    if (object.isLight && object.userData?.type === 'water') lights += 1;
    if (!object.isMesh || object.userData?.type !== 'water') return;
    meshes.add(object);
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!material) continue;
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
  });
  return {
    meshes: meshes.size,
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
    lights,
    surfaceDraws: meshes.size,
  };
}

const scene = new THREE.Scene();
const waterGeometry = new THREE.PlaneGeometry(2200, 2200, 1, 1);
waterGeometry.rotateX(-Math.PI / 2);
const waterMap = new THREE.DataTexture(new Uint8Array([23, 72, 93, 255]), 1, 1);
waterMap.needsUpdate = true;
const waterMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: waterMap,
  roughness: 0.28,
  metalness: 0.16,
  emissive: 0x3c829f,
  emissiveMap: waterMap,
  emissiveIntensity: 0.05,
  depthWrite: true,
  depthTest: true,
  side: THREE.FrontSide,
  fog: true,
  toneMapped: true,
});
const originalWaterCompile = function originalWaterCompile(shader) {
  shader.uniforms.originalWaterSentinel = { value: 1 };
};
const originalWaterCacheKey = function originalWaterCacheKey() { return 'original-water-program'; };
waterMaterial.onBeforeCompile = originalWaterCompile;
waterMaterial.customProgramCacheKey = originalWaterCacheKey;
const water = new THREE.Mesh(waterGeometry, waterMaterial);
water.name = 'SF Bay shared water surface';
water.userData = { type: 'water', sharedBaySurface: true, heroAtmosphereEligible: true };
scene.add(water);
waterGeometry.computeBoundingBox();
waterGeometry.computeBoundingSphere();
const resourceCountsBefore = waterResourceCounts(scene);
const waterSnapshot = {
  geometry: water.geometry,
  material: water.material,
  map: waterMaterial.map,
  emissiveMap: waterMaterial.emissiveMap,
  color: waterMaterial.color.getHex(),
  emissive: waterMaterial.emissive.getHex(),
  roughness: waterMaterial.roughness,
  metalness: waterMaterial.metalness,
  emissiveIntensity: waterMaterial.emissiveIntensity,
  depthWrite: waterMaterial.depthWrite,
  depthTest: waterMaterial.depthTest,
  side: waterMaterial.side,
  fog: waterMaterial.fog,
  toneMapped: waterMaterial.toneMapped,
  defines: waterMaterial.defines,
  onBeforeCompile: waterMaterial.onBeforeCompile,
  customProgramCacheKey: waterMaterial.customProgramCacheKey,
  position: water.position.toArray(),
  bounds: waterGeometry.boundingBox.clone(),
  sphere: waterGeometry.boundingSphere.clone(),
};
const disposal = { geometry: 0, material: 0, map: 0 };
waterGeometry.addEventListener('dispose', () => { disposal.geometry += 1; });
waterMaterial.addEventListener('dispose', () => { disposal.material += 1; });
waterMap.addEventListener('dispose', () => { disposal.map += 1; });
const asphalt = new THREE.MeshStandardMaterial({ color: 0x454b4d, roughness: 0.9, metalness: 0.01 });
const rainGeometry = new THREE.BufferGeometry();
rainGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
  -3, 8, -5, -2, 1, -4,
  2, 11, -8, 3, 2, -7,
  -5, 6, -16, -4, 0, -15,
  5, 9, -28, 6, 1, -27,
], 3));
const originalRainMaterial = new THREE.LineBasicMaterial({
  color: 0xd8e4f0,
  transparent: true,
  opacity: 0.66,
  depthWrite: false,
});
const rain = new THREE.LineSegments(rainGeometry, originalRainMaterial);
rain.name = 'Pacific drizzle rain';
scene.add(rain);
const atmosphere = createFerryBuildingAtmosphere({
  scene,
  water,
  conditions: { timeOfDay: 'night', weather: 'drizzle' },
});
const resourceCountsActive = waterResourceCounts(scene);

try {
  const concurrentAtmosphere = createFerryBuildingAtmosphere({ scene, water, maxLampLights: 0 });
  assert.equal(concurrentAtmosphere.water, null, 'Concurrent atmosphere adopted an already-owned water material');
  assert.equal(concurrentAtmosphere.getWaterDiagnostics().adopted, false, 'Concurrent adoption did not fail closed');
  concurrentAtmosphere.dispose();
  assert.equal(atmosphere.water, water, 'Concurrent fail-closed lifecycle disturbed the active adoption');

  const waterMeshes = [];
  scene.traverse((object) => {
    if (object.isMesh && (object.userData?.type === 'water' || /water/i.test(object.name))) waterMeshes.push(object);
  });
  assert.deepEqual(waterMeshes, [water], 'Hero atmosphere introduced a second water mesh');
  assert.equal(atmosphere.root.getObjectByName('Ferry Building local Bay water'), undefined, 'Finite hero water plane regressed');
  assert.equal(atmosphere.water, water, 'Atmosphere did not expose the exact shared Bay mesh');
  const adopted = atmosphere.getWaterDiagnostics();
  assert.equal(adopted.adopted, true, 'Shared Bay surface was not adopted');
  assert.equal(adopted.sharedSurface, true, 'Adopted water was not classified as shared');
  assert.equal(adopted.ownsSurface, false, 'Atmosphere claimed ownership of shared water');
  assert.equal(adopted.meshIdentity, true, 'Shared water mesh identity changed');
  assert.equal(adopted.geometryIdentity, true, 'Shared water geometry identity changed');
  assert.equal(adopted.materialIdentity, true, 'Shared water material identity changed');
  assert.equal(adopted.mapIdentity, true, 'Shared water map identity changed');
  assert.equal(adopted.materialType, 'MeshStandardMaterial', 'Stock PBR water material was replaced');

  const compiledWaterShader = {
    uniforms: {},
    vertexShader: '#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <normal_fragment_maps>\n#include <fog_fragment>\n#include <tonemapping_fragment>',
  };
  waterMaterial.onBeforeCompile(compiledWaterShader, null);
  assert.equal(compiledWaterShader.uniforms.originalWaterSentinel.value, 1, 'Original water compile callback was skipped');
  for (const uniform of ['heroBayTime', 'heroBayNight', 'heroBayWetness', 'heroBayWind']) {
    assert(compiledWaterShader.uniforms[uniform], `Adopted water shader is missing ${uniform}`);
  }
  assert(compiledWaterShader.vertexShader.includes('#include <begin_vertex>'), 'Stock vertex transform chunk was removed');
  assert(compiledWaterShader.vertexShader.includes('vHeroBaySurface = transformed.xz'), 'Water response lacks stable surface coordinates');
  assert(!compiledWaterShader.vertexShader.includes('transformed.y +='), 'Shared water shader displaced vertices');
  assert(compiledWaterShader.fragmentShader.includes('#include <normal_fragment_maps>'), 'Stock normal-map path was removed');
  assert(compiledWaterShader.fragmentShader.includes('#include <fog_fragment>'), 'Stock fog path was removed');
  assert(compiledWaterShader.fragmentShader.includes('#include <tonemapping_fragment>'), 'Stock tone-mapping path was removed');
  assert(compiledWaterShader.fragmentShader.includes('heroBayNoise'), 'Non-periodic Bay surface response is missing');
  assert(!compiledWaterShader.fragmentShader.includes('sin('), 'Broad periodic sine bands regressed into shared water');
  assert(compiledWaterShader.fragmentShader.includes('dot(normalize(vViewPosition), normal)'), 'Bay Fresnel diverged from Three geometryViewDir semantics');
  assert(compiledWaterShader.fragmentShader.includes('heroBayWetness * 0.15'), 'Drizzle did not reduce Bay roughness for a visible sheen');
  assert(compiledWaterShader.fragmentShader.includes('heroBayWetness * 0.12'), 'Drizzle did not strengthen Bay Fresnel depth response');
  assert(waterMaterial.customProgramCacheKey().endsWith('|ferry-bay-shared-water-v1'), 'Water shader cache key is not deterministic');

  assert.equal(atmosphere.getLightBudget().pointLights, 6, 'Hero atmosphere light budget changed unexpectedly');
  assert.equal(atmosphere.registerWetMaterial(asphalt), true, 'Wet-material registration failed');
  atmosphere.update(1 / 60);
  assert(asphalt.roughness < 0.9, 'Drizzle did not lower asphalt roughness');
  assert.equal(rain.material.isShaderMaterial, true, 'Hero drizzle did not replace the uniform white rain material');
  assert(rain.geometry.getAttribute('rainFade'), 'Hero drizzle did not add per-streak opacity variation');
  assert(rain.geometry.drawRange.count < rain.geometry.getAttribute('position').count, 'Hero drizzle did not reduce rain density');
  assert.equal(rain.material.uniforms.rainOpacity.value, 0.18, 'Hero drizzle opacity regressed');

  const shaderMaterials = new Set();
  atmosphere.root.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material?.isShaderMaterial) shaderMaterials.add(material);
    }
  });
  assert(shaderMaterials.size >= 3, `Expected at least 3 custom hero shaders, found ${shaderMaterials.size}`);

  const shaderReport = [];
  for (const material of shaderMaterials) {
    const source = `${material.vertexShader}\n${material.fragmentShader}`;
    const declarations = uniformDeclarations(source);
    const reserved = declarations.filter((name) => RESERVED_GLSL_IDENTIFIERS.has(name));
    assert.deepEqual(reserved, [], `Reserved GLSL uniform(s) in hero shader: ${reserved.join(', ')}`);
    for (const key of Object.keys(material.uniforms)) {
      assert(declarations.includes(key), `JS uniform "${key}" has no matching GLSL declaration`);
    }
    shaderReport.push({ uniforms: [...new Set(declarations)].sort() });
  }

  const reflection = atmosphere.root.getObjectByName('Ferry Plaza rain reflection 1');
  assert(reflection?.material?.uniforms?.activation, 'Reflection shader must expose the non-reserved activation uniform');
  assert.equal(reflection.material.uniforms.active, undefined, 'Reserved reflection uniform "active" regressed');
  assert(reflection.material.uniforms.activation.value > 0, 'Night drizzle did not activate pavement reflections');

  atmosphere.setConditions({ weather: 'clear', timeOfDay: 'day' });
  atmosphere.update(1 / 60);
  const dryWater = atmosphere.getWaterDiagnostics();
  assert.equal(dryWater.uniforms.night, 0, 'Clear day left the Bay night response active');
  assert.equal(dryWater.uniforms.wetness, 0, 'Clear day left the Bay wetness response active');
  const waterVersionBeforeUpdates = waterMaterial.version;
  for (let frame = 0; frame < 12; frame += 1) atmosphere.update(1 / 60);
  assert.equal(waterMaterial.version, waterVersionBeforeUpdates, 'Per-frame Bay update recompiled the material');
  atmosphere.setConditions({ weather: 'drizzle', timeOfDay: 'dusk' });
  atmosphere.update(1 / 60);
  const wetWater = atmosphere.getWaterDiagnostics();
  assert.equal(wetWater.uniforms.night, 0.48, 'Dusk response did not reach the shared water shader');
  assert.equal(wetWater.uniforms.wetness, 0.9, 'Drizzle response did not reach the shared water shader');
  assert.notDeepEqual(wetWater.uniforms, dryWater.uniforms, 'Water conditions did not produce distinct uniforms');
  assert.notEqual(rain.material, originalRainMaterial, 'Drizzle did not reactivate its sparse rain presentation');
  atmosphere.setConditions({ weather: 'clear', timeOfDay: 'day' });
  atmosphere.update(1 / 60);
  assert.equal(rain.material, originalRainMaterial, 'Second clear transition did not restore the shared rain material');
  assert.equal(rain.geometry.drawRange.count, Infinity, 'Clear weather did not restore the full rain draw range');
  assert.equal(asphalt.roughness, 0.9, 'Clear weather left registered asphalt wet');

  console.log(JSON.stringify({
    result: 'hero atmosphere shader verification passed',
    shaderMaterials: shaderMaterials.size,
    shaderUniforms: shaderReport,
    lightBudget: atmosphere.getLightBudget(),
  }, null, 2));
} finally {
  atmosphere.dispose();
  asphalt.dispose();
  scene.remove(rain);
  rainGeometry.dispose();
  originalRainMaterial.dispose();
}

assert.equal(scene.children.length, 1, 'Hero atmosphere disposal removed or duplicated the shared water surface');
assert.equal(scene.children[0], water, 'Shared Bay mesh identity changed during atmosphere disposal');
assert.equal(water.geometry, waterSnapshot.geometry, 'Shared Bay geometry changed during disposal');
assert.equal(water.material, waterSnapshot.material, 'Shared Bay material changed during disposal');
assert.equal(waterMaterial.map, waterSnapshot.map, 'Shared Bay map changed during disposal');
assert.equal(waterMaterial.emissiveMap, waterSnapshot.emissiveMap, 'Shared Bay emissive map changed during disposal');
assert.equal(waterMaterial.color.getHex(), waterSnapshot.color, 'Shared Bay color changed during disposal');
assert.equal(waterMaterial.emissive.getHex(), waterSnapshot.emissive, 'Shared Bay emissive changed during disposal');
assert.equal(waterMaterial.roughness, waterSnapshot.roughness, 'Shared Bay roughness changed during disposal');
assert.equal(waterMaterial.metalness, waterSnapshot.metalness, 'Shared Bay metalness changed during disposal');
assert.equal(waterMaterial.emissiveIntensity, waterSnapshot.emissiveIntensity, 'Shared Bay emissive intensity changed during disposal');
assert.equal(waterMaterial.depthWrite, waterSnapshot.depthWrite, 'Shared Bay depth-write state changed during disposal');
assert.equal(waterMaterial.depthTest, waterSnapshot.depthTest, 'Shared Bay depth-test state changed during disposal');
assert.equal(waterMaterial.side, waterSnapshot.side, 'Shared Bay side changed during disposal');
assert.equal(waterMaterial.fog, waterSnapshot.fog, 'Shared Bay fog state changed during disposal');
assert.equal(waterMaterial.toneMapped, waterSnapshot.toneMapped, 'Shared Bay tone-mapping state changed during disposal');
assert.equal(waterMaterial.defines, waterSnapshot.defines, 'Shared Bay defines changed during disposal');
assert.equal(waterMaterial.onBeforeCompile, waterSnapshot.onBeforeCompile, 'Original water compile callback was not restored');
assert.equal(waterMaterial.customProgramCacheKey, waterSnapshot.customProgramCacheKey, 'Original water cache key was not restored');
assert.deepEqual(water.position.toArray(), waterSnapshot.position, 'Shared Bay transform changed during disposal');
assert(waterGeometry.boundingBox.equals(waterSnapshot.bounds), 'Shared Bay geometry bounds changed during disposal');
assert(waterGeometry.boundingSphere.equals(waterSnapshot.sphere), 'Shared Bay bounding sphere changed during disposal');
assert.deepEqual(disposal, { geometry: 0, material: 0, map: 0 }, 'Atmosphere disposed a shared Bay resource');
const resourceCountsAfter = waterResourceCounts(scene);
assert.deepEqual(resourceCountsBefore, {
  meshes: 1, geometries: 1, materials: 1, textures: 1, lights: 0, surfaceDraws: 1,
}, 'Baseline shared-water resource count is invalid');
assert.deepEqual(resourceCountsActive, resourceCountsBefore, 'Active atmosphere added a water resource or draw');
assert.deepEqual(resourceCountsAfter, resourceCountsBefore, 'Atmosphere disposal changed shared-water resources or draws');
console.log(JSON.stringify({
  result: 'shared Bay water resource identity passed',
  resourceCounts: { before: resourceCountsBefore, active: resourceCountsActive, after: resourceCountsAfter },
}, null, 2));

const readoptedAtmosphere = createFerryBuildingAtmosphere({ scene, water, maxLampLights: 0 });
assert.equal(readoptedAtmosphere.water, water, 'Disposed adoption did not release its material ownership guard');
readoptedAtmosphere.dispose();
assert.equal(waterMaterial.onBeforeCompile, waterSnapshot.onBeforeCompile, 'Readoption did not restore the compile hook exactly');
assert.equal(waterMaterial.customProgramCacheKey, waterSnapshot.customProgramCacheKey, 'Readoption did not restore the cache hook exactly');
assert.deepEqual(disposal, { geometry: 0, material: 0, map: 0 }, 'Readoption disposed a shared Bay resource');

scene.remove(water);
waterGeometry.dispose();
waterMaterial.dispose();
waterMap.dispose();

const failClosedScene = new THREE.Scene();
const incompatibleWater = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.ShaderMaterial(),
);
failClosedScene.add(incompatibleWater);
const failClosedAtmosphere = createFerryBuildingAtmosphere({ scene: failClosedScene, water: incompatibleWater, maxLampLights: 0 });
assert.equal(failClosedAtmosphere.water, null, 'Incompatible water surface was adopted');
assert.equal(failClosedAtmosphere.getWaterDiagnostics().adopted, false, 'Incompatible water did not fail closed');
failClosedAtmosphere.dispose();
assert.equal(failClosedScene.children[0], incompatibleWater, 'Fail-closed lifecycle removed incompatible shared water');
failClosedScene.remove(incompatibleWater);
incompatibleWater.geometry.dispose();
incompatibleWater.material.dispose();

const mappedNonWaterScene = new THREE.Scene();
const mappedNonWaterMap = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255]), 1, 1);
mappedNonWaterMap.needsUpdate = true;
const mappedNonWaterMaterial = new THREE.MeshStandardMaterial({ map: mappedNonWaterMap });
const mappedNonWaterCompile = mappedNonWaterMaterial.onBeforeCompile;
const mappedNonWaterCacheKey = mappedNonWaterMaterial.customProgramCacheKey;
const mappedNonWater = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), mappedNonWaterMaterial);
mappedNonWater.userData = { type: 'ground', sharedBaySurface: true, heroAtmosphereEligible: true };
mappedNonWaterScene.add(mappedNonWater);
const mappedNonWaterAtmosphere = createFerryBuildingAtmosphere({
  scene: mappedNonWaterScene,
  water: mappedNonWater,
  maxLampLights: 0,
});
assert.equal(mappedNonWaterAtmosphere.water, null, 'Mapped MeshStandard non-water mesh was adopted');
assert.equal(mappedNonWaterMaterial.onBeforeCompile, mappedNonWaterCompile, 'Non-water rejection changed compile hook');
assert.equal(mappedNonWaterMaterial.customProgramCacheKey, mappedNonWaterCacheKey, 'Non-water rejection changed cache hook');
mappedNonWaterAtmosphere.dispose();
mappedNonWater.userData = { type: 'water', sharedBaySurface: true, heroAtmosphereEligible: false };
const ineligibleWaterAtmosphere = createFerryBuildingAtmosphere({
  scene: mappedNonWaterScene,
  water: mappedNonWater,
  maxLampLights: 0,
});
assert.equal(ineligibleWaterAtmosphere.water, null, 'Ineligible shared water mesh was adopted');
assert.equal(mappedNonWaterMaterial.onBeforeCompile, mappedNonWaterCompile, 'Ineligible-water rejection changed compile hook');
assert.equal(mappedNonWaterMaterial.customProgramCacheKey, mappedNonWaterCacheKey, 'Ineligible-water rejection changed cache hook');
ineligibleWaterAtmosphere.dispose();
mappedNonWaterScene.remove(mappedNonWater);
mappedNonWater.geometry.dispose();
mappedNonWaterMaterial.dispose();
mappedNonWaterMap.dispose();

const defaultKeyScene = new THREE.Scene();
const defaultKeyMap = new THREE.DataTexture(new Uint8Array([23, 72, 93, 255]), 1, 1);
defaultKeyMap.needsUpdate = true;
const defaultKeyMaterial = new THREE.MeshStandardMaterial({ map: defaultKeyMap });
defaultKeyMaterial.onBeforeCompile = function defaultKeyCustomCompile(shader) {
  shader.uniforms.defaultKeySentinel = { value: 1 };
};
const defaultCompileHook = defaultKeyMaterial.onBeforeCompile;
const inheritedDefaultCacheHook = defaultKeyMaterial.customProgramCacheKey;
const defaultKeyBeforeAdoption = defaultKeyMaterial.customProgramCacheKey();
const defaultKeyWater = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), defaultKeyMaterial);
defaultKeyWater.userData = { type: 'water', sharedBaySurface: true, heroAtmosphereEligible: true };
defaultKeyScene.add(defaultKeyWater);
const defaultKeyAtmosphere = createFerryBuildingAtmosphere({
  scene: defaultKeyScene,
  water: defaultKeyWater,
  maxLampLights: 0,
});
assert.equal(
  defaultKeyMaterial.customProgramCacheKey(),
  `${defaultKeyBeforeAdoption}|ferry-bay-shared-water-v1`,
  'Default cache-key semantics changed after compile-hook replacement',
);
defaultKeyAtmosphere.dispose();
assert.equal(defaultKeyMaterial.onBeforeCompile, defaultCompileHook, 'Default-key compile hook was not restored');
assert.equal(defaultKeyMaterial.customProgramCacheKey, inheritedDefaultCacheHook, 'Inherited default cache hook was not restored');
assert.equal(defaultKeyMaterial.customProgramCacheKey(), defaultKeyBeforeAdoption, 'Default cache-key value changed after disposal');
defaultKeyScene.remove(defaultKeyWater);
defaultKeyWater.geometry.dispose();
defaultKeyMaterial.dispose();
defaultKeyMap.dispose();
