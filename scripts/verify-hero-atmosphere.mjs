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

const scene = new THREE.Scene();
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
  conditions: { timeOfDay: 'night', weather: 'drizzle' },
});

try {
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
  assert.equal(rain.material, originalRainMaterial, 'Clear weather did not restore the shared rain material');
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

assert.equal(scene.children.length, 0, 'Hero atmosphere did not detach during disposal');
