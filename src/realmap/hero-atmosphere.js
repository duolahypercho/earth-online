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

function makeWaterMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 },
      wind: { value: new THREE.Vector2(0.78, 0.35) },
      night: { value: 0 },
      wetness: { value: 0 },
      opacity: { value: 0.84 },
    },
    vertexShader: `
      uniform float time;
      uniform vec2 wind;
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      void main() {
        vUv = uv;
        vec3 displaced = position;
        float waveA = sin((position.x + position.z * 0.42) * 0.19 + time * 0.72) * 0.10;
        float waveB = sin((position.z - position.x * 0.31) * 0.31 + time * 1.18) * 0.045;
        displaced.y += waveA + waveB;
        vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform vec2 wind;
      uniform float night;
      uniform float wetness;
      uniform float opacity;
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
      }
      void main() {
        vec2 flow = vWorldPosition.xz * 0.045 + wind * time * 0.11;
        float ripples = noise(flow) * 0.72 + noise(flow * 2.6 - wind * time * 0.18) * 0.28;
        float bands = sin((vWorldPosition.x * 0.23 + vWorldPosition.z * 0.11) + time * 1.1) * 0.5 + 0.5;
        vec3 bayDeep = vec3(0.025, 0.135, 0.19);
        vec3 bayLight = vec3(0.13, 0.38, 0.48);
        vec3 color = mix(bayDeep, bayLight, ripples * 0.72 + bands * 0.11);
        float distantGlint = pow(max(0.0, ripples + bands * 0.45), 8.0);
        color += vec3(0.42, 0.64, 0.70) * distantGlint * (0.18 + wetness * 0.18);
        color = mix(color, vec3(0.012, 0.035, 0.075), night * 0.45);
        color += vec3(0.14, 0.23, 0.30) * night * distantGlint * 0.55;
        gl_FragColor = vec4(color, opacity);
      }
    `,
  });
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

function createReflectionMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      active: { value: 0 },
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
      uniform float active;
      uniform vec3 color;
      varying vec2 vUv;
      void main() {
        float across = 1.0 - smoothstep(0.08, 0.5, abs(vUv.x - 0.5));
        float falloff = smoothstep(1.0, 0.08, vUv.y);
        float breakup = step(0.24, fract(sin(vUv.y * 93.1) * 127.8));
        gl_FragColor = vec4(color, across * falloff * breakup * active * 0.22);
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
 * `scene`. `waterBounds` should be supplied by a more exact shoreline mask when
 * one becomes available.
 */
export function createFerryBuildingAtmosphere(options = {}) {
  const scene = options.scene;
  if (!scene?.isScene && !scene?.isObject3D) {
    throw new Error('createFerryBuildingAtmosphere requires a Three.js scene or parent group.');
  }
  const parent = options.parent?.isObject3D ? options.parent : scene;
  const waterBounds = { ...FERRY_BUILDING_HERO_ATMOSPHERE.waterBounds, ...(options.waterBounds || {}) };
  const seaLevel = Number.isFinite(options.seaLevel) ? options.seaLevel : FERRY_BUILDING_HERO_ATMOSPHERE.seaLevel;
  const lightBudget = THREE.MathUtils.clamp(
    Math.floor(options.maxLampLights ?? FERRY_BUILDING_HERO_ATMOSPHERE.maxLampLights),
    0,
    FERRY_BUILDING_HERO_ATMOSPHERE.maxLampLights,
  );
  const root = new THREE.Group();
  root.name = 'Ferry Building hero atmosphere';
  root.userData.heroAtmosphere = true;
  parent.add(root);

  const waterMaterial = makeWaterMaterial();
  const waterGeometry = new THREE.PlaneGeometry(
    waterBounds.maxX - waterBounds.minX,
    waterBounds.maxZ - waterBounds.minZ,
    56,
    96,
  );
  waterGeometry.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.position.set((waterBounds.minX + waterBounds.maxX) * 0.5, seaLevel + 0.055, (waterBounds.minZ + waterBounds.maxZ) * 0.5);
  water.name = 'Ferry Building local Bay water';
  water.renderOrder = 1;
  water.receiveShadow = true;
  root.add(water);

  const cloudMaterial = makeCloudMaterial();
  const cloudDeck = new THREE.Mesh(new THREE.PlaneGeometry(780, 440), cloudMaterial);
  cloudDeck.rotation.x = -Math.PI / 2;
  cloudDeck.position.set(2350, 1860, 176);
  cloudDeck.name = 'Low marine cloud deck';
  cloudDeck.renderOrder = -7;
  root.add(cloudDeck);

  const hazeMaterial = new THREE.MeshBasicMaterial({
    color: DAY_COLOR.clone(),
    transparent: true,
    opacity: 0.035,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const haze = new THREE.Mesh(new THREE.PlaneGeometry(520, 76), hazeMaterial);
  haze.position.set(2475, 31, 1850);
  haze.rotation.y = -Math.PI / 2;
  haze.name = 'Bay horizon aerial perspective';
  haze.renderOrder = -6;
  root.add(haze);

  const lampAssembly = makeLampAssemblies(lightBudget);
  root.add(lampAssembly.group);

  const wetMaterials = new Map();
  let conditions = normaliseConditions(options.conditions);
  let elapsed = 0;
  let disposed = false;

  function refreshWetMaterials() {
    for (const [material, record] of wetMaterials) {
      const wet = conditions.wetness * record.factor;
      if ('roughness' in material) material.roughness = THREE.MathUtils.lerp(record.roughness, Math.min(record.roughness, 0.2), wet);
      if ('metalness' in material) material.metalness = THREE.MathUtils.lerp(record.metalness, Math.max(record.metalness, 0.18), wet * 0.72);
      if (material.color?.isColor) material.color.copy(record.color).lerp(WET_TINT, wet * 0.08);
      material.needsUpdate = true;
    }
  }

  function setConditions(nextConditions = {}) {
    if (disposed) return { ...conditions };
    conditions = normaliseConditions({ ...conditions, ...nextConditions });
    refreshWetMaterials();
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
    waterMaterial.uniforms.time.value = elapsed;
    waterMaterial.uniforms.wind.value.set(0.58 + conditions.windSpeed * 0.58, 0.2 + conditions.windSpeed * 0.24);
    waterMaterial.uniforms.night.value = conditions.night;
    waterMaterial.uniforms.wetness.value = conditions.wetness;
    waterMaterial.uniforms.opacity.value = 0.77 + conditions.wetness * 0.12;
    cloudMaterial.uniforms.time.value = elapsed;
    cloudMaterial.uniforms.cloudiness.value = conditions.cloudiness;
    cloudMaterial.uniforms.night.value = conditions.night;
    hazeMaterial.color.copy(DAY_COLOR).lerp(NIGHT_COLOR, conditions.night);
    hazeMaterial.opacity = 0.028 + conditions.cloudiness * 0.1 + conditions.night * 0.018;
    for (const { lens, light } of lampAssembly.lamps) {
      const active = conditions.night * 0.9 + conditions.wetness * 0.12;
      light.intensity = active * 2.1;
      lens.material.emissiveIntensity = 0.35 + active * 2.4;
    }
    for (const reflection of lampAssembly.reflections) {
      reflection.material.uniforms.active.value = conditions.night * (0.18 + conditions.wetness * 0.82);
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
    root.removeFromParent();
    disposeOwnedObject(root);
  }

  setConditions(conditions);
  update(0);
  return Object.freeze({
    root,
    water,
    setConditions,
    registerWetMaterial,
    registerWetRoot,
    update,
    getLightBudget,
    dispose,
  });
}
