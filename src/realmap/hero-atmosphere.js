import * as THREE from 'three';

/**
 * A deliberately small, local atmosphere layer for the Ferry Building hero tile.
 *
 * Usage:
 *   const heroAtmosphere = createFerryBuildingAtmosphere({ scene, renderer });
 *   heroAtmosphere.setConditions({ timeOfDay: 'night', weather: 'drizzle' });
 *   heroAtmosphere.registerWetMaterial(asphaltMaterial, 1);
 *   // Per frame:
 *   heroAtmosphere.update(deltaSeconds);
 *   // On tile unload:
 *   heroAtmosphere.dispose();
 *
 * It deliberately owns no global renderer state and creates at most six local
 * point lights (all shadowless). This keeps it safe to compose with the city
 * runtime's sky, weather, and global directional lighting.
 */

export const FERRY_BUILDING_HERO_ATMOSPHERE = Object.freeze({
  focus: Object.freeze({ x: 2290, z: 1938 }),
  // The east edge of the production tile faces the Bay in this local OSM frame.
  waterBounds: Object.freeze({ minX: 2420, minZ: 1712, maxX: 2544, maxZ: 2128 }),
  seaLevel: -1.8,
  maxLampLights: 6,
});

const DAY_COLOR = new THREE.Color(0xa9cadd);
const NIGHT_COLOR = new THREE.Color(0x15233a);
const WET_TINT = new THREE.Color(0x9fb7c0);
const MAX_DELTA_SECONDS = 1 / 20;

function clamp01(value) {
  return THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
}

function hash11(value) {
  const x = Math.sin(value * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function seededRange(seed, min, max) {
  return THREE.MathUtils.lerp(min, max, hash11(seed));
}

function disposeOwnedObject(root) {
  root.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture && value.userData?.heroAtmosphereOwned) value.dispose();
      }
      material.dispose();
    }
  });
}

const BAY_WATER_PROGRAM_KEY = 'ferry-bay-shared-water-v1';
const BAY_WATER_MATERIAL_ADOPTIONS = new WeakMap();

function adoptSharedBayWater(mesh) {
  if (!mesh?.isMesh || Array.isArray(mesh.material) || !mesh.material?.isMeshStandardMaterial) return null;
  if (!mesh.geometry?.isBufferGeometry || !mesh.material.map?.isTexture) return null;
  if (mesh.userData?.type !== 'water'
    || mesh.userData.sharedBaySurface !== true
    || mesh.userData.heroAtmosphereEligible !== true) return null;

  const material = mesh.material;
  if (typeof material.onBeforeCompile !== 'function'
    || typeof material.customProgramCacheKey !== 'function') return null;
  if (BAY_WATER_MATERIAL_ADOPTIONS.has(material)) return null;
  const identity = Object.freeze({
    mesh,
    geometry: mesh.geometry,
    material,
    map: material.map,
  });
  const original = {
    onBeforeCompile: material.onBeforeCompile,
    customProgramCacheKey: material.customProgramCacheKey,
    ownsOnBeforeCompile: Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile'),
    ownsCustomProgramCacheKey: Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey'),
    programCacheKey: material.customProgramCacheKey.call(material),
  };
  const uniforms = {
    heroBayTime: { value: 0 },
    heroBayNight: { value: 0 },
    heroBayWetness: { value: 0 },
    heroBayWind: { value: 0.2 },
  };
  let shaderCompatible = null;
  let disposed = false;
  const adoptionToken = {};

  const vertexHeader = `
varying vec2 vHeroBaySurface;
`;
  const fragmentHeader = `
uniform float heroBayTime;
uniform float heroBayNight;
uniform float heroBayWetness;
uniform float heroBayWind;
varying vec2 vHeroBaySurface;

float heroBayHash(vec2 point) {
  vec3 point3 = fract(vec3(point.xyx) * 0.1031);
  point3 += dot(point3, point3.yzx + 33.33);
  return fract((point3.x + point3.y) * point3.z);
}

float heroBayNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  local = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(heroBayHash(cell), heroBayHash(cell + vec2(1.0, 0.0)), local.x),
    mix(heroBayHash(cell + vec2(0.0, 1.0)), heroBayHash(cell + vec2(1.0, 1.0)), local.x),
    local.y
  );
}

mat3 heroBayTangentFrame(vec3 eyePosition, vec3 surfaceNormal, vec2 surfacePoint) {
  vec3 eyeDx = dFdx(eyePosition);
  vec3 eyeDy = dFdy(eyePosition);
  vec2 surfaceDx = dFdx(surfacePoint);
  vec2 surfaceDy = dFdy(surfacePoint);
  vec3 tangent = cross(eyeDy, surfaceNormal) * surfaceDx.x
    + cross(surfaceNormal, eyeDx) * surfaceDy.x;
  vec3 bitangent = cross(eyeDy, surfaceNormal) * surfaceDx.y
    + cross(surfaceNormal, eyeDx) * surfaceDy.y;
  float determinant = max(dot(tangent, tangent), dot(bitangent, bitangent));
  float scale = determinant == 0.0 ? 0.0 : inversesqrt(determinant);
  return mat3(tangent * scale, bitangent * scale, surfaceNormal);
}
`;
  const waterResponse = `
    vec2 heroBayFlow = vec2(0.71, 0.29) * heroBayTime * (0.012 + heroBayWind * 0.018);
    vec2 heroBayPoint = vHeroBaySurface * 0.018 + heroBayFlow;
    float heroBayLow = heroBayNoise(heroBayPoint);
    float heroBayFine = heroBayNoise(heroBayPoint * 2.73 - heroBayFlow * 1.61);
    float heroBayHeight = mix(heroBayLow, heroBayFine, 0.34);
    float heroBayOffsetX = mix(
      heroBayNoise(heroBayPoint + vec2(0.035, 0.0)),
      heroBayNoise((heroBayPoint + vec2(0.035, 0.0)) * 2.73 - heroBayFlow * 1.61),
      0.34
    );
    float heroBayOffsetY = mix(
      heroBayNoise(heroBayPoint + vec2(0.0, 0.035)),
      heroBayNoise((heroBayPoint + vec2(0.0, 0.035)) * 2.73 - heroBayFlow * 1.61),
      0.34
    );
    vec2 heroBaySlope = vec2(heroBayOffsetX, heroBayOffsetY) - heroBayHeight;
    float heroBayResponse = 0.038 + heroBayWetness * 0.035 + heroBayWind * 0.016;
    mat3 heroBayFrame = heroBayTangentFrame(-vViewPosition, normal, vHeroBaySurface);
    normal = normalize(heroBayFrame * vec3(heroBaySlope * heroBayResponse, 1.0));
    // Three's stock geometryViewDir is normalize(vViewPosition); the negated
    // value above is only the eye-space surface position used for derivatives.
    float heroBayFresnel = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 5.0);
    roughnessFactor = clamp(
      roughnessFactor + (heroBayHeight - 0.5) * 0.045 + heroBayWetness * 0.055,
      0.18,
      0.52
    );
    vec3 heroBayBody = mix(vec3(0.018, 0.105, 0.15), vec3(0.052, 0.19, 0.235), heroBayHeight);
    heroBayBody = mix(heroBayBody, vec3(0.038, 0.12, 0.145), heroBayWetness * 0.32);
    heroBayBody = mix(heroBayBody, vec3(0.012, 0.045, 0.075), heroBayNight * 0.58);
    diffuseColor.rgb = mix(diffuseColor.rgb, heroBayBody, 0.28 + heroBayWetness * 0.08);
    vec3 heroBayHorizon = mix(vec3(0.055, 0.17, 0.22), vec3(0.025, 0.075, 0.12), heroBayNight);
    diffuseColor.rgb = mix(diffuseColor.rgb, heroBayHorizon, heroBayFresnel * (0.12 + heroBayWetness * 0.045));
`;

  const wrapper = function onBeforeCompile(shader, renderer) {
    original.onBeforeCompile.call(material, shader, renderer);
    const compatible = shader.vertexShader.includes('#include <begin_vertex>')
      && shader.fragmentShader.includes('#include <common>')
      && shader.fragmentShader.includes('#include <normal_fragment_maps>');
    shaderCompatible = compatible;
    if (!compatible) return;
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `${vertexHeader}\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvHeroBaySurface = transformed.xz;',
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>${fragmentHeader}`);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>${waterResponse}`,
    );
  };
  const cacheKey = function customProgramCacheKey() {
    return `${original.programCacheKey}|${BAY_WATER_PROGRAM_KEY}`;
  };

  material.onBeforeCompile = wrapper;
  material.customProgramCacheKey = cacheKey;
  BAY_WATER_MATERIAL_ADOPTIONS.set(material, adoptionToken);
  material.needsUpdate = true;

  function update(elapsed, conditions) {
    if (disposed) return;
    uniforms.heroBayTime.value = elapsed;
    uniforms.heroBayNight.value = conditions.night;
    uniforms.heroBayWetness.value = conditions.wetness;
    uniforms.heroBayWind.value = conditions.windSpeed;
  }

  function getDiagnostics() {
    return {
      adopted: !disposed,
      sharedSurface: true,
      ownsSurface: false,
      meshIdentity: mesh === identity.mesh,
      geometryIdentity: mesh.geometry === identity.geometry,
      materialIdentity: mesh.material === identity.material,
      mapIdentity: material.map === identity.map,
      materialType: material.type,
      shaderCompatible,
      uniforms: {
        time: uniforms.heroBayTime.value,
        night: uniforms.heroBayNight.value,
        wetness: uniforms.heroBayWetness.value,
        wind: uniforms.heroBayWind.value,
      },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (material.onBeforeCompile === wrapper) {
      if (original.ownsOnBeforeCompile) material.onBeforeCompile = original.onBeforeCompile;
      else delete material.onBeforeCompile;
    }
    if (material.customProgramCacheKey === cacheKey) {
      if (original.ownsCustomProgramCacheKey) material.customProgramCacheKey = original.customProgramCacheKey;
      else delete material.customProgramCacheKey;
    }
    if (BAY_WATER_MATERIAL_ADOPTIONS.get(material) === adoptionToken) {
      BAY_WATER_MATERIAL_ADOPTIONS.delete(material);
    }
    material.needsUpdate = true;
  }

  return Object.freeze({ identity, uniforms, update, getDiagnostics, dispose });
}

function makeCloudMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    uniforms: {
      time: { value: 0 },
      cloudiness: { value: 0.18 },
      night: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform float cloudiness;
      uniform float night;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(41.7, 289.3))) * 33758.3); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
      }
      void main() {
        vec2 p = vUv * vec2(3.8, 2.1) + vec2(time * 0.004, time * 0.0015);
        float n = noise(p) * 0.58 + noise(p * 2.1 + 4.0) * 0.29 + noise(p * 4.7) * 0.13;
        float edge = smoothstep(0.35, 0.72, n) * cloudiness;
        edge *= smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.58, vUv.y);
        vec3 cloud = mix(vec3(0.72, 0.78, 0.80), vec3(0.20, 0.27, 0.34), night);
        gl_FragColor = vec4(cloud, edge * 0.58);
      }
    `,
  });
}

function makeHazeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 },
      cloudiness: { value: 0.18 },
      wetness: { value: 0 },
      night: { value: 0 },
      color: { value: DAY_COLOR.clone() },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform float cloudiness;
      uniform float wetness;
      uniform float night;
      uniform vec3 color;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(83.1, 177.7))) * 43758.5); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
      }
      void main() {
        float horizon = smoothstep(0.0, 0.24, vUv.y) * smoothstep(1.0, 0.48, vUv.y);
        float drifting = noise(vUv * vec2(5.2, 2.2) + vec2(time * 0.006, time * 0.002));
        float patches = smoothstep(0.36, 0.74, drifting);
        float drizzle = wetness * (0.035 + patches * 0.075);
        float alpha = horizon * (0.022 + cloudiness * 0.032 + drizzle) * (1.0 - night * 0.18);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

function makeDrizzleMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      rainColor: { value: new THREE.Color(0x9aaeb6) },
      rainOpacity: { value: 0.18 },
      nearDistance: { value: 10 },
      farDistance: { value: 185 },
    },
    vertexShader: `
      attribute float rainFade;
      uniform float nearDistance;
      uniform float farDistance;
      varying float vRainFade;
      varying float vDepthFade;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        float distanceToCamera = max(0.0, -viewPosition.z);
        vRainFade = rainFade;
        vDepthFade = 1.0 - smoothstep(nearDistance, farDistance, distanceToCamera);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 rainColor;
      uniform float rainOpacity;
      varying float vRainFade;
      varying float vDepthFade;
      void main() {
        gl_FragColor = vec4(rainColor, rainOpacity * vRainFade * vDepthFade);
      }
    `,
  });
}

function originalDrawRange(geometry) {
  const count = geometry?.drawRange?.count;
  return Number.isFinite(count) ? count : Infinity;
}

function rainFadeAttribute(positionCount) {
  const values = new Float32Array(positionCount);
  for (let index = 0; index < positionCount; index += 2) {
    // Both vertices in a line segment share opacity. The deterministic spread
    // avoids the artificial all-white curtain without adding per-frame work.
    const fade = 0.22 + hash11(index * 0.5 + 41) * 0.78;
    values[index] = fade;
    if (index + 1 < positionCount) values[index + 1] = fade;
  }
  return new THREE.BufferAttribute(values, 1);
}

function createReflectionMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      activation: { value: 0 },
      color: { value: new THREE.Color(0xffbd75) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float activation;
      uniform vec3 color;
      varying vec2 vUv;
      void main() {
        float across = 1.0 - smoothstep(0.08, 0.5, abs(vUv.x - 0.5));
        float falloff = smoothstep(1.0, 0.08, vUv.y);
        float breakup = step(0.24, fract(sin(vUv.y * 93.1) * 127.8));
        gl_FragColor = vec4(color, across * falloff * breakup * activation * 0.22);
      }
    `,
  });
}

function makeLampAssemblies(maxLights) {
  const group = new THREE.Group();
  const reflectionGroup = new THREE.Group();
  const lamps = [];
  const reflections = [];
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x192225, roughness: 0.36, metalness: 0.72 });
  const lensMaterial = new THREE.MeshStandardMaterial({ color: 0xffd4a0, emissive: 0xffa34e, emissiveIntensity: 0.45, roughness: 0.22 });
  const poleGeometry = new THREE.CylinderGeometry(0.075, 0.12, 5.8, 8);
  const armGeometry = new THREE.BoxGeometry(1.05, 0.08, 0.08);
  const lensGeometry = new THREE.SphereGeometry(0.16, 10, 8);
  const reflectionGeometry = new THREE.PlaneGeometry(1.5, 15.5, 1, 1);
  reflectionGeometry.rotateX(-Math.PI / 2);
  const positions = [
    [2398, 2.9, 1766, 0.1], [2409, 2.9, 1814, -0.06], [2418, 2.9, 1862, 0.08],
    [2428, 2.9, 1911, -0.09], [2435, 2.9, 1960, 0.06], [2441, 2.9, 2010, -0.04],
  ].slice(0, maxLights);
  for (let index = 0; index < positions.length; index += 1) {
    const [x, y, z, yaw] = positions[index];
    const fixture = new THREE.Group();
    const pole = new THREE.Mesh(poleGeometry, poleMaterial);
    pole.position.y = y;
    const arm = new THREE.Mesh(armGeometry, poleMaterial);
    arm.position.set(0.48, y + 2.78, 0);
    const lens = new THREE.Mesh(lensGeometry, lensMaterial);
    lens.position.set(1.0, y + 2.68, 0);
    fixture.add(pole, arm, lens);
    fixture.position.set(x, 0, z);
    fixture.rotation.y = yaw;
    fixture.name = `Ferry Plaza warm LED ${index + 1}`;
    group.add(fixture);

    const light = new THREE.PointLight(0xffbd83, 0, 17, 2);
    light.position.set(x + Math.cos(yaw) * 0.9, y + 2.6, z - Math.sin(yaw) * 0.9);
    light.castShadow = false;
    light.name = `Ferry Plaza pooled light ${index + 1}`;
    group.add(light);
    lamps.push({ lens, light });

    const reflectionMaterial = createReflectionMaterial();
    reflectionMaterial.uniforms.color.value.set(index % 3 === 0 ? 0xffc37d : 0xffdaaa);
    const reflection = new THREE.Mesh(reflectionGeometry, reflectionMaterial);
    reflection.position.set(x - 3.8, 0.045, z + 4.6);
    reflection.rotation.y = yaw + (index % 2 ? 0.08 : -0.08);
    reflection.renderOrder = 4;
    reflection.name = `Ferry Plaza rain reflection ${index + 1}`;
    reflectionGroup.add(reflection);
    reflections.push(reflection);
  }
  group.add(reflectionGroup);
  return { group, lamps, reflections };
}

function normaliseConditions(input = {}) {
  const weather = input.weather === 'drizzle' || input.weather === 'fog' ? input.weather : 'clear';
  const timeOfDay = input.timeOfDay === 'night' || input.timeOfDay === 'dusk' ? input.timeOfDay : 'day';
  const inferredNight = timeOfDay === 'night' ? 1 : timeOfDay === 'dusk' ? 0.48 : 0;
  return {
    weather,
    timeOfDay,
    night: clamp01(input.night ?? inferredNight),
    wetness: clamp01(input.wetness ?? (weather === 'drizzle' ? 0.9 : weather === 'fog' ? 0.32 : 0)),
    cloudiness: clamp01(input.cloudiness ?? (weather === 'drizzle' ? 0.88 : weather === 'fog' ? 0.7 : 0.22)),
    windSpeed: clamp01(input.windSpeed ?? (weather === 'drizzle' ? 0.72 : weather === 'fog' ? 0.36 : 0.2)),
  };
}

/**
 * Creates local Bay atmosphere without assuming the application's scene graph.
 * `parent` can be a streamed hero-tile group; otherwise the effect is added to
 * `scene`. The optional `water` must be the existing shared Bay surface; the
 * atmosphere never owns or duplicates that mesh.
 */
export function createFerryBuildingAtmosphere(options = {}) {
  const scene = options.scene;
  if (!scene?.isScene && !scene?.isObject3D) {
    throw new Error('createFerryBuildingAtmosphere requires a Three.js scene or parent group.');
  }
  const parent = options.parent?.isObject3D ? options.parent : scene;
  const lightBudget = THREE.MathUtils.clamp(
    Math.floor(options.maxLampLights ?? FERRY_BUILDING_HERO_ATMOSPHERE.maxLampLights),
    0,
    FERRY_BUILDING_HERO_ATMOSPHERE.maxLampLights,
  );
  const root = new THREE.Group();
  root.name = 'Ferry Building hero atmosphere';
  root.userData.heroAtmosphere = true;
  parent.add(root);

  const sharedWater = adoptSharedBayWater(options.water);

  const cloudMaterial = makeCloudMaterial();
  const cloudDeck = new THREE.Mesh(new THREE.PlaneGeometry(780, 440), cloudMaterial);
  cloudDeck.rotation.x = -Math.PI / 2;
  cloudDeck.position.set(2350, 1860, 176);
  cloudDeck.name = 'Low marine cloud deck';
  cloudDeck.renderOrder = -7;
  root.add(cloudDeck);

  const hazeMaterial = makeHazeMaterial();
  const haze = new THREE.Mesh(new THREE.PlaneGeometry(520, 76), hazeMaterial);
  haze.position.set(2475, 31, 1850);
  haze.rotation.y = -Math.PI / 2;
  haze.name = 'Bay horizon aerial perspective';
  haze.renderOrder = -6;
  root.add(haze);

  const lampAssembly = makeLampAssemblies(lightBudget);
  root.add(lampAssembly.group);

  const wetMaterials = new Map();
  let rainPresentation = null;
  let conditions = normaliseConditions(options.conditions);
  let elapsed = 0;
  let disposed = false;

  function refreshWetMaterials() {
    for (const [material, record] of wetMaterials) {
      const wet = conditions.wetness * record.factor;
      const wetRoughness = Math.min(record.roughness, THREE.MathUtils.lerp(0.24, 0.14, record.factor));
      if ('roughness' in material) material.roughness = THREE.MathUtils.lerp(record.roughness, wetRoughness, wet);
      if ('metalness' in material) material.metalness = THREE.MathUtils.lerp(record.metalness, Math.max(record.metalness, 0.2), wet * 0.76);
      if (material.color?.isColor) material.color.copy(record.color).lerp(WET_TINT, wet * 0.11);
      material.needsUpdate = true;
    }
  }

  function restoreRainPresentation() {
    if (!rainPresentation) return;
    const { mesh, material, drawRangeCount } = rainPresentation;
    if (mesh?.material === rainPresentation.replacement) mesh.material = material;
    if (mesh?.geometry) mesh.geometry.setDrawRange(0, drawRangeCount);
    rainPresentation.replacement.dispose();
    rainPresentation = null;
  }

  function refreshRainPresentation() {
    const rain = scene.getObjectByName('Pacific drizzle rain');
    const wantsDrizzle = conditions.weather === 'drizzle' && conditions.wetness > 0.05;
    if (!wantsDrizzle || !rain?.isLineSegments || !rain.geometry?.attributes?.position) {
      restoreRainPresentation();
      return;
    }
    if (rainPresentation?.mesh !== rain) restoreRainPresentation();
    if (rainPresentation) return;

    const positionCount = rain.geometry.attributes.position.count;
    const replacement = makeDrizzleMaterial();
    rain.geometry.setAttribute('rainFade', rainFadeAttribute(positionCount));
    // A Bay drizzle should read as intermittent nearby drops, not as a solid
    // screen-space curtain. Retain a deterministic subset of the shared rain.
    const renderedVertices = Math.max(2, Math.floor(positionCount * 0.46 / 2) * 2);
    rainPresentation = {
      mesh: rain,
      material: rain.material,
      drawRangeCount: originalDrawRange(rain.geometry),
      replacement,
      renderedVertices,
    };
    rain.geometry.setDrawRange(0, renderedVertices);
    rain.material = replacement;
  }

  function setConditions(nextConditions = {}) {
    if (disposed) return { ...conditions };
    const weatherChanged = Object.prototype.hasOwnProperty.call(nextConditions, 'weather')
      && nextConditions.weather !== conditions.weather;
    const timeChanged = Object.prototype.hasOwnProperty.call(nextConditions, 'timeOfDay')
      && nextConditions.timeOfDay !== conditions.timeOfDay;
    const merged = { ...conditions, ...nextConditions };
    // Weather-derived values must return to their clear defaults when the
    // runtime switches modes; otherwise a prior drizzle would leave dry
    // materials glossy even though the rain layer has been removed.
    if (weatherChanged) {
      for (const key of ['wetness', 'cloudiness', 'windSpeed']) {
        if (!Object.prototype.hasOwnProperty.call(nextConditions, key)) delete merged[key];
      }
    }
    if (timeChanged && !Object.prototype.hasOwnProperty.call(nextConditions, 'night')) delete merged.night;
    conditions = normaliseConditions(merged);
    refreshWetMaterials();
    refreshRainPresentation();
    return { ...conditions };
  }

  function registerWetMaterial(material, response = 1) {
    if (disposed || !material?.isMaterial) return false;
    if (!wetMaterials.has(material)) {
      wetMaterials.set(material, {
        roughness: Number.isFinite(material.roughness) ? material.roughness : 1,
        metalness: Number.isFinite(material.metalness) ? material.metalness : 0,
        color: material.color?.isColor ? material.color.clone() : null,
        factor: clamp01(response),
      });
    }
    refreshWetMaterials();
    return true;
  }

  function registerWetRoot(object3d, response = 1) {
    if (!object3d?.traverse) return 0;
    let count = 0;
    object3d.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (registerWetMaterial(material, response)) count += 1;
      }
    });
    return count;
  }

  function update(deltaSeconds = 0) {
    if (disposed) return;
    elapsed += Math.min(Math.max(Number(deltaSeconds) || 0, 0), MAX_DELTA_SECONDS);
    sharedWater?.update(elapsed, conditions);
    cloudMaterial.uniforms.time.value = elapsed;
    cloudMaterial.uniforms.cloudiness.value = conditions.cloudiness;
    cloudMaterial.uniforms.night.value = conditions.night;
    hazeMaterial.uniforms.time.value = elapsed;
    hazeMaterial.uniforms.cloudiness.value = conditions.cloudiness;
    hazeMaterial.uniforms.wetness.value = conditions.wetness;
    hazeMaterial.uniforms.night.value = conditions.night;
    hazeMaterial.uniforms.color.value.copy(DAY_COLOR).lerp(NIGHT_COLOR, conditions.night);
    refreshRainPresentation();
    for (const { lens, light } of lampAssembly.lamps) {
      const active = conditions.night * 0.9 + conditions.wetness * 0.12;
      light.intensity = active * 2.1;
      lens.material.emissiveIntensity = 0.35 + active * 2.4;
    }
    for (const reflection of lampAssembly.reflections) {
      reflection.material.uniforms.activation.value = conditions.night * (0.18 + conditions.wetness * 0.82);
    }
  }

  function getLightBudget() {
    return Object.freeze({ pointLights: lampAssembly.lamps.length, shadowCastingLights: 0, maxPointLights: lightBudget });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [material, record] of wetMaterials) {
      if ('roughness' in material) material.roughness = record.roughness;
      if ('metalness' in material) material.metalness = record.metalness;
      if (material.color?.isColor && record.color) material.color.copy(record.color);
      material.needsUpdate = true;
    }
    wetMaterials.clear();
    restoreRainPresentation();
    sharedWater?.dispose();
    root.removeFromParent();
    disposeOwnedObject(root);
  }

  setConditions(conditions);
  update(0);
  return Object.freeze({
    root,
    water: sharedWater?.identity.mesh || null,
    getWaterDiagnostics: () => sharedWater?.getDiagnostics() || {
      adopted: false,
      sharedSurface: false,
      ownsSurface: false,
      shaderCompatible: null,
    },
    setConditions,
    registerWetMaterial,
    registerWetRoot,
    update,
    getLightBudget,
    dispose,
  });
}
