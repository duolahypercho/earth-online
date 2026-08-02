import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import './styles.css';
import { createCity } from './world.js';
import { createTrafficSystem } from './traffic.js';
import { createPedestrianSystem } from './pedestrians.js';
import { createSanFranciscoStreaming } from './streaming.js';
import { createStreamedAgentSystem } from './streamed-agents.js';
import { createCityShift } from './gameplay.js';
import { createHud } from './ui.js';

const app = document.querySelector('#app');
const canvas = document.querySelector('#scene-canvas');
const bootOverlay = document.querySelector('#boot-overlay');
const bootStatus = document.querySelector('#boot-status');
const launchButton = document.querySelector('#launch-button');
const hudRoot = document.querySelector('#hud-root');
const sceneTransition = document.createElement('div');
sceneTransition.className = 'scene-transition';
sceneTransition.setAttribute('aria-hidden', 'true');
app?.append(sceneTransition);

const setBootStatus = (message, isError = false) => {
  if (!bootStatus) return;
  bootStatus.textContent = message;
  bootStatus.classList.toggle('is-error', isError);
};

// Keep startup failures visible in the local preview instead of leaving the
// launch card permanently in its warming state. This also makes WebGL shader
// regressions diagnosable without opening a separate devtools window.
window.addEventListener('error', (event) => {
  const message = event?.error?.message || event?.message || 'Unknown runtime error';
  setBootStatus(`Runtime error · ${message}`, true);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason?.message || String(event?.reason || 'Unknown promise rejection');
  setBootStatus(`Runtime error · ${reason}`, true);
});

let webgl2;
try {
  webgl2 = canvas.getContext('webgl2', {
    alpha: false,
    antialias: true,
    powerPreference: 'high-performance',
    premultipliedAlpha: false,
  });
} catch (error) {
  setBootStatus('WebGL2 could not be initialized.', true);
  throw error;
}

if (!webgl2) {
  setBootStatus('WebGL2 is required for this city study.', true);
  throw new Error('This experience requires a WebGL2-capable browser.');
}

const renderer = new THREE.WebGLRenderer({ canvas, context: webgl2 });
// Keep the drawing buffer bounded on high-DPI WebGL2 devices. The quality
// profiles can raise this within their caps, but never inherit an unbounded
// devicePixelRatio that would make the post stack or shadow atlas unstable.
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Start close to the calibrated clear-world value so the first frame does not
// flash brighter than the later weather/lighting presentation.
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.sortObjects = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101925);
scene.fog = new THREE.Fog(0x182a3a, 60, 190);
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const roomEnvironment = new RoomEnvironment();
scene.environment = pmremGenerator.fromScene(roomEnvironment, 0.04).texture;
scene.environmentIntensity = 0.3;
roomEnvironment.dispose();
pmremGenerator.dispose();

const camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 0.1, 1300);
camera.position.set(52, 28, 56);

// Keep the sky fill restrained enough that the directional key can actually
// ground vehicles, people, and curb edges. Weather presets below recolor this
// light toward a broader overcast source when the sun disappears.
const hemisphere = new THREE.HemisphereLight(0xb7d7ef, 0x302824, 1.02);
scene.add(hemisphere);

const sun = new THREE.DirectionalLight(0xffc48b, 3.62);
sun.position.set(-75, 82, 45);
sun.target.position.set(28, 3, 38);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -68;
sun.shadow.camera.right = 68;
sun.shadow.camera.top = 78;
sun.shadow.camera.bottom = -58;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 210;
sun.shadow.bias = -0.00018;
sun.shadow.normalBias = 0.035;
sun.shadow.radius = 2;
scene.add(sun, sun.target);

const rim = new THREE.DirectionalLight(0x7ba9dc, 0.34);
rim.position.set(80, 50, -65);
scene.add(rim);

// The staged interiors already carry warm practicals. These two restrained
// helpers keep the exterior key from washing those rooms out during the
// crossfade, while giving the interior walls a stable cool bounce on WebGL2
// devices that do not expose a full HDR environment.
const interiorHemisphere = new THREE.HemisphereLight(0xd7e6e7, 0x1d2022, 0);
interiorHemisphere.name = 'Interior cool bounce';
const interiorTransitionFill = new THREE.PointLight(0xffb57f, 0, 15, 2);
interiorTransitionFill.name = 'Interior transition fill';
interiorTransitionFill.castShadow = false;
scene.add(interiorHemisphere, interiorTransitionFill);
const interiorPresentation = {
  current: 0,
  target: 0,
};

const STATIC_BATCH_MIN_INSTANCES = 12;

function freezeStaticTransforms(root) {
  if (!root) return;
  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    object.matrixAutoUpdate = false;
    object.matrixWorldNeedsUpdate = false;
  });
}

function getBatchLayoutKey(mesh) {
  const geometry = mesh.geometry;
  const attributes = Object.entries(geometry.attributes)
    .map(([name, attribute]) => [
      name,
      attribute.itemSize,
      attribute.normalized,
      attribute.array.constructor.name,
    ].join(':'))
    .sort()
    .join('|');
  return [
    mesh.material.uuid,
    geometry.index ? 'indexed' : 'non-indexed',
    attributes,
    mesh.castShadow ? 'casts' : 'no-cast',
    mesh.receiveShadow ? 'receives' : 'no-receive',
  ].join('::');
}

function createStaticCityBatches(root) {
  const batchCandidates = new Map();
  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    if (!object.isMesh
      || !object.visible
      || object.isInstancedMesh
      || object.isBatchedMesh
      || object.isSkinnedMesh
      || Array.isArray(object.material)
      || !object.material
      || !object.geometry?.getAttribute('position')
      || object.material.transparent
      || object.material.isShaderMaterial
      || object.material.opacity < 1
      || object.material.transmission > 0
      || object.material.wireframe
      || object.renderOrder !== 0
      || object.customDepthMaterial
      || object.customDistanceMaterial
      || Object.keys(object.geometry.morphAttributes).length > 0) {
      return;
    }

    const key = getBatchLayoutKey(object);
    if (!batchCandidates.has(key)) batchCandidates.set(key, []);
    batchCandidates.get(key).push(object);
  });

  const batchRoot = new THREE.Group();
  batchRoot.name = 'Static city render batches';
  let batchedMeshes = 0;
  let batchCount = 0;

  batchCandidates.forEach((meshes) => {
    if (meshes.length < STATIC_BATCH_MIN_INSTANCES) return;

    const uniqueGeometries = new Map();
    let vertexCapacity = 0;
    let indexCapacity = 0;
    meshes.forEach((mesh) => {
      if (uniqueGeometries.has(mesh.geometry)) return;
      uniqueGeometries.set(mesh.geometry, null);
      vertexCapacity += mesh.geometry.getAttribute('position').count;
      indexCapacity += mesh.geometry.index?.count ?? 0;
    });

    const batch = new THREE.BatchedMesh(
      meshes.length,
      vertexCapacity,
      indexCapacity,
      meshes[0].material,
    );
    batch.name = `Static city batch ${batchCount + 1}`;
    batch.castShadow = meshes[0].castShadow;
    batch.receiveShadow = meshes[0].receiveShadow;
    // The authored core is bounded and only ~330k triangles in total. Drawing
    // each opaque batch as one cached multi-draw is materially cheaper than
    // sorting and frustum-testing thousands of tiny boxes every frame.
    batch.frustumCulled = false;
    batch.perObjectFrustumCulled = false;
    batch.sortObjects = false;

    uniqueGeometries.forEach((value, geometry) => {
      uniqueGeometries.set(geometry, batch.addGeometry(geometry));
    });
    meshes.forEach((mesh) => {
      const instanceId = batch.addInstance(uniqueGeometries.get(mesh.geometry));
      batch.setMatrixAt(instanceId, mesh.matrixWorld);
      mesh.visible = false;
    });

    batchRoot.add(batch);
    batchedMeshes += meshes.length;
    batchCount += 1;
  });

  scene.add(batchRoot);
  freezeStaticTransforms(root);
  freezeStaticTransforms(batchRoot);
  return { root: batchRoot, batchCount, batchedMeshes };
}

const city = createCity({ scene, renderer });
const proceduralSkyMaterial = scene.getObjectByName('Procedural Pacific sky')?.material;
const wetWeatherVisuals = {
  current: 0,
  target: 0,
  nodes: [
    { object: scene.getObjectByName('Pacific drizzle distant streaks'), uniform: 'uAlpha', max: 0.32 },
    { object: scene.getObjectByName('Pacific drizzle near streaks'), uniform: 'uAlpha', max: 0.4 },
    { object: scene.getObjectByName('Drizzle gutter runoff ribbons'), uniform: 'uOpacity', max: 0.42 },
    { object: scene.getObjectByName('Drizzle seawall wind spray'), uniform: 'uOpacity', max: 0.32 },
    { object: scene.getObjectByName('Natural puddle shorelines'), property: 'opacity', max: 0.24 },
    { object: scene.getObjectByName('Shallow curb puddles'), property: 'opacity', max: 0.68 },
    { object: scene.getObjectByName('Puddle sky sheens'), uniform: 'uOpacity', max: 0.22 },
  ].filter((entry) => entry.object),
};
function applyWetWeatherVisuals(amount) {
  const wetAmount = THREE.MathUtils.clamp(amount, 0, 1);
  const active = wetAmount > 0.001 || wetWeatherVisuals.target > 0;
  wetWeatherVisuals.nodes.forEach(({ object, uniform, property, max }) => {
    object.visible = active;
    if (uniform && object.material?.uniforms?.[uniform]) {
      object.material.uniforms[uniform].value = max * wetAmount;
    } else if (property && object.material) {
      object.material[property] = max * wetAmount;
    }
  });
  wetWeatherVisuals.current = wetAmount;
}
const staticCityRendering = createStaticCityBatches(city.group);
const traffic = createTrafficSystem({ scene, roadNetwork: city.roadNetwork });
const pedestrians = createPedestrianSystem({ scene, sidewalkNetwork: city.sidewalkNetwork });
const streaming = createSanFranciscoStreaming({
  scene,
  // The current hand-authored avenue is sector 0:0. Streaming tracks it as
  // externally owned and never hides, reparents, or disposes its objects.
  externalDetailedKeys: ['0:0'],
});
const streamedAgents = createStreamedAgentSystem({ scene, streaming });
streaming.setStreamedAgentStatsProvider?.(() => streamedAgents.getStats());

// Weather setters in the city/traffic systems intentionally update shared
// materials in one cheap pass. Capture those values at the boundary so the
// presentation layer can crossfade the visible wetness instead of snapping
// every road, curb, vehicle, and landmark at the first transition frame.
const WEATHER_MATERIAL_PROPERTIES = [
  'roughness',
  'metalness',
  'opacity',
  'clearcoat',
  'clearcoatRoughness',
  'envMapIntensity',
  'reflectivity',
  'transmission',
];
const WEATHER_UNIFORM_NAMES = [
  'uWeatherMix',
  'uFogColor',
  'uFogNear',
  'uFogFar',
  'uShallowColor',
  'uDeepColor',
  'uSkyHorizon',
  'uSkyZenith',
  'uColor',
  'uDensity',
];
const weatherMaterialRefs = new Map();
const weatherUniformRefs = new Map();
const weatherSurfaceTransition = { entries: [], active: false };
const weatherUniformTransition = { entries: [], active: false };

function registerWeatherVisuals() {
  scene.traverse((object) => {
    const materials = Array.isArray(object.material)
      ? object.material
      : object.material
        ? [object.material]
        : [];
    materials.forEach((material) => {
      if (!material?.uuid) return;
      weatherMaterialRefs.set(material.uuid, material);
      WEATHER_UNIFORM_NAMES.forEach((name) => {
        const uniform = material.uniforms?.[name];
        const value = uniform?.value;
        if (!uniform || !(value?.isColor || typeof value === 'number')) return;
        weatherUniformRefs.set(`${material.uuid}:${name}`, { material, name });
      });
    });
  });
}

function captureWeatherMaterialState() {
  return [...weatherMaterialRefs.values()].map((material) => ({
    material,
    color: material.color?.isColor ? material.color.clone() : null,
    numbers: Object.fromEntries(
      WEATHER_MATERIAL_PROPERTIES
        .filter((property) => Number.isFinite(material[property]))
        .map((property) => [property, material[property]]),
    ),
  }));
}

function captureWeatherUniformState() {
  return [...weatherUniformRefs.values()].map(({ material, name }) => {
    const value = material.uniforms[name].value;
    return {
      material,
      name,
      value: value?.isColor ? value.clone() : value,
    };
  });
}

function createWeatherTransitionEntries(before, after) {
  const beforeByMaterial = new Map(before.map((entry) => [entry.material.uuid, entry]));
  return after.map((target) => {
    const from = beforeByMaterial.get(target.material.uuid) || target;
    const colorChanged = from.color && target.color && !from.color.equals(target.color);
    const numberChanged = WEATHER_MATERIAL_PROPERTIES.some((property) => (
      Number.isFinite(from.numbers[property])
      && Number.isFinite(target.numbers[property])
      && Math.abs(from.numbers[property] - target.numbers[property]) > 0.0001
    ));
    return colorChanged || numberChanged
      ? { material: target.material, from, target }
      : null;
  }).filter(Boolean);
}

function createWeatherUniformTransitionEntries(before, after) {
  const beforeByUniform = new Map(
    before.map((entry) => [`${entry.material.uuid}:${entry.name}`, entry]),
  );
  return after.map((target) => {
    const from = beforeByUniform.get(`${target.material.uuid}:${target.name}`) || target;
    const changed = from.value?.isColor && target.value?.isColor
      ? !from.value.equals(target.value)
      : Number.isFinite(from.value)
        && Number.isFinite(target.value)
        && Math.abs(from.value - target.value) > 0.0001;
    return changed
      ? { material: target.material, name: target.name, from, target }
      : null;
  }).filter(Boolean);
}

function applyWeatherSurfaceTransition(progress) {
  if (!weatherSurfaceTransition.active) return;
  const blend = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(progress, 0, 1), 0, 1);
  weatherSurfaceTransition.entries.forEach(({ material, from, target }) => {
    if (material.color?.isColor && from.color && target.color) {
      material.color.copy(from.color).lerp(target.color, blend);
    }
    WEATHER_MATERIAL_PROPERTIES.forEach((property) => {
      if (!Number.isFinite(from.numbers[property]) || !Number.isFinite(target.numbers[property])) return;
      material[property] = THREE.MathUtils.lerp(from.numbers[property], target.numbers[property], blend);
    });
  });
}

function applyWeatherUniformTransition(progress) {
  if (!weatherUniformTransition.active) return;
  const blend = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(progress, 0, 1), 0, 1);
  weatherUniformTransition.entries.forEach(({ material, name, from, target }) => {
    const uniform = material.uniforms?.[name];
    if (!uniform) return;
    if (from.value?.isColor && target.value?.isColor) {
      uniform.value.copy(from.value).lerp(target.value, blend);
    } else if (Number.isFinite(from.value) && Number.isFinite(target.value)) {
      uniform.value = THREE.MathUtils.lerp(from.value, target.value, blend);
    }
  });
}

registerWeatherVisuals();
freezeStaticTransforms(scene.getObjectByName('Enterable interiors staging wing'));
scene.updateMatrixWorld(true);
scene.matrixAutoUpdate = false;
scene.matrixWorldNeedsUpdate = false;
// No dynamic actor casts into the directional atlas. Cache the authored city
// shadow once, then request an explicit refresh only when interior visibility
// changes instead of resubmitting the same depth scene every frame.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.toneMappingExposure = 1.04;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// A smaller AO target keeps contact shading visible around curbs and vehicles
// without making Cinematic pay full-resolution scene traversal and blur costs.
const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight, 16);
// SSAOPass' radius is expressed in view-space scene units. The former
// sub-unit radius was effectively invisible at this city scale even though
// the full pass cost was already being paid in Cinematic mode.
ssaoPass.kernelRadius = 1.35;
ssaoPass.minDistance = 0.002;
ssaoPass.maxDistance = 0.18;
ssaoPass.output = SSAOPass.OUTPUT.Default;
// Profiles opt into this pass explicitly. Cinematic enables it at a reduced
// internal resolution for stronger grounding without turning the whole frame
// into a second full-resolution scene render.
ssaoPass.enabled = false;
composer.addPass(ssaoPass);
const smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
smaaPass.enabled = false;
composer.addPass(smaaPass);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.16,
  0.38,
  0.84,
);
bloomPass.enabled = false;
composer.addPass(bloomPass);
const cinematicGradePass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: window.innerWidth / Math.max(1, window.innerHeight) },
    uVignette: { value: 0.08 },
    uSaturation: { value: 1.04 },
    uContrast: { value: 1.03 },
    uWarmth: { value: 0.018 },
    uWetness: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uAspect;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uWarmth;
    uniform float uWetness;
    varying vec2 vUv;

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);
      color = (color - 0.5) * uContrast + 0.5;
      color += vec3(uWarmth * 1.25, uWarmth * 0.46, -uWarmth * 0.72);
      color = mix(color, color * vec3(0.94, 0.98, 1.04), uWetness * 0.22);

      vec2 centered = (vUv - 0.5) * vec2(uAspect, 1.0);
      float distanceFromCenter = length(centered);
      float centerLight = 1.0 - smoothstep(0.34, 0.96, distanceFromCenter);
      color *= 1.0 - uVignette * (1.0 - centerLight);
      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
});
cinematicGradePass.enabled = false;
composer.addPass(cinematicGradePass);
composer.addPass(new OutputPass());

const renderProfiles = {
  auto: {
    maxPixelRatio: 1.04,
    bloom: false,
    ssao: false,
    smaa: false,
    grade: false,
  },
  balanced: {
    maxPixelRatio: 1,
    bloom: false,
    ssao: false,
    smaa: false,
    grade: false,
  },
  cinematic: {
    maxPixelRatio: 1.04,
    bloom: true,
    ssao: true,
    smaa: true,
    grade: true,
    ssaoScale: 0.48,
  },
};
const renderQuality = {
  // Auto is the safe default for the existing authored scene. Cinematic stays
  // available as an intentional beauty profile rather than taxing every QA
  // and first-load frame with the full post stack.
  mode: 'auto',
  autoScale: 1,
  effectivePixelRatio: 1,
  sampleTime: 0,
  sampleFrames: 0,
  adjustmentCooldown: 0,
  lastFps: null,
};
let postProcessingActive = false;
let hud;
let cityShift;

function getRenderQualitySnapshot() {
  const profile = renderProfiles[renderQuality.mode];
  return {
    mode: renderQuality.mode,
    scale: renderQuality.mode === 'auto' ? renderQuality.autoScale : 1,
    effects: profile.bloom,
    post: profile.grade || profile.ssao || profile.smaa || profile.bloom,
  };
}

function applyRenderQuality() {
  const profile = renderProfiles[renderQuality.mode];
  const devicePixelRatio = window.devicePixelRatio || 1;
  const profileScale = renderQuality.mode === 'auto' ? renderQuality.autoScale : 1;
  const pixelRatio = Math.max(0.65, Math.min(devicePixelRatio, profile.maxPixelRatio) * profileScale);

  renderQuality.effectivePixelRatio = pixelRatio;
  bloomPass.enabled = profile.bloom;
  ssaoPass.enabled = profile.ssao;
  smaaPass.enabled = profile.smaa;
  cinematicGradePass.enabled = profile.grade;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(window.innerWidth, window.innerHeight);
  if (profile.ssao) {
    const ssaoScale = profile.ssaoScale ?? 1;
    ssaoPass.setSize(
      Math.max(1, Math.floor(window.innerWidth * pixelRatio * ssaoScale)),
      Math.max(1, Math.floor(window.innerHeight * pixelRatio * ssaoScale)),
    );
  }
  cinematicGradePass.uniforms.uAspect.value = window.innerWidth / Math.max(1, window.innerHeight);
  postProcessingActive = profile.grade || profile.ssao || profile.smaa || profile.bloom;
  hud?.setQualityProfile(getRenderQualitySnapshot());
}

function setRenderQuality(mode) {
  if (!renderProfiles[mode]) return;

  renderQuality.mode = mode;
  renderQuality.sampleTime = 0;
  renderQuality.sampleFrames = 0;
  renderQuality.adjustmentCooldown = 0;
  renderQuality.lastFps = null;
  if (mode === 'auto') renderQuality.autoScale = 1;
  applyRenderQuality();
}

function updateAdaptiveQuality(frameDelta) {
  if (renderQuality.mode !== 'auto' || frameDelta <= 0) return;

  renderQuality.adjustmentCooldown = Math.max(
    0,
    renderQuality.adjustmentCooldown - frameDelta,
  );
  renderQuality.sampleTime += frameDelta;
  renderQuality.sampleFrames += 1;
  if (renderQuality.sampleTime < 2.75) return;

  const fps = renderQuality.sampleFrames / renderQuality.sampleTime;
  renderQuality.lastFps = fps;
  const previousScale = renderQuality.autoScale;
  if (renderQuality.adjustmentCooldown <= 0) {
    // Use a broad dead band so a borderline display does not bounce between
    // two render sizes every sample window. Downshift in larger steps for a
    // quick recovery, then restore quality gradually once the frame budget is
    // comfortably healthy again.
    if (fps < 52) {
      renderQuality.autoScale = Math.max(0.68, renderQuality.autoScale - 0.08);
      renderQuality.adjustmentCooldown = 3.5;
    } else if (fps > 66) {
      renderQuality.autoScale = Math.min(1, renderQuality.autoScale + 0.025);
      renderQuality.adjustmentCooldown = 3.5;
    }
  }
  renderQuality.sampleTime = 0;
  renderQuality.sampleFrames = 0;

  if (renderQuality.autoScale !== previousScale) applyRenderQuality();
}

applyRenderQuality();
hud = createHud({
  renderer,
  camera,
  traffic,
  pedestrians,
  streamedAgents,
  streaming,
  city,
  quality: getRenderQualitySnapshot(),
  onQualityChange: setRenderQuality,
  onInteraction: () => {
    if (controls.interiorMode) {
      performInteriorAction();
    } else {
      enterNearestInterior();
    }
  },
  onTouchMove: (code, pressed) => {
    if (pressed) controls.keys.add(code.toLowerCase());
    else controls.keys.delete(code.toLowerCase());
  },
  onRestartGame: () => {
    cityShift?.restart();
    hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
    hud?.setMessage('Shift reset · follow the amber beacon to the Welcome Center.');
  },
});

const controls = {
  target: new THREE.Vector3(28, 4, 38),
  focus: new THREE.Vector3(28, 4, 38),
  spherical: new THREE.Spherical(68, 1.55, Math.PI),
  yaw: Math.PI,
  pitch: 1.55,
  distance: 68,
  cameraYaw: Math.PI,
  cameraPitch: 1.55,
  cameraDistance: 68,
  pointerId: null,
  lastX: 0,
  lastY: 0,
  touchPoints: new Map(),
  pinchDistance: null,
  keys: new Set(),
  interiorMode: false,
  activePortal: null,
  exteriorSnapshot: null,
};

const PORTAL_NEARBY_RADIUS = 22;
const FEATURED_PORTAL_DISCOVERY_RADIUS = 48;

cityShift = createCityShift({
  scene,
  city,
  onAdvance: ({ message }) => {
    hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
    hud?.setMessage(message);
  },
});
hud.setGameState(cityShift.getState(controls.target, controls.activePortal));

function getInteractionPortal() {
  const nearby = city.getNearestPortal(controls.target, PORTAL_NEARBY_RADIUS);
  const streamed = city.getStreamedPortal?.(
    controls.target,
    streaming,
    PORTAL_NEARBY_RADIUS,
  );
  if (streamed && (!nearby || streamed.distance < nearby.distance)) return streamed;
  if (nearby) return nearby;
  const featured = city.getFeaturedPortal?.(controls.target);
  return featured?.distance <= FEATURED_PORTAL_DISCOVERY_RADIUS ? featured : null;
}

// QA hook: when set, updateCamera parks the camera at this explicit pose
// instead of orbiting the roam target. Used by screenshot tooling to frame
// close-ups of simulation actors without touching the input path.
let qaCameraPose = null;

// Explicit, opt-in streaming QA travel. These values are deliberately kept
// separate from normal controls: no route starts unless a QA caller invokes
// runStreamingTour(), and the regular player input remains the source of
// motion in normal play.
const QA_ROAM_CLEARANCE = 4;
const QA_TOUR_DEFAULT_SEGMENT_DURATION = 1.2;
const QA_TOUR_MIN_SEGMENT_DURATION = 0.35;
const QA_TOUR_MAX_SEGMENT_DURATION = 4;
const QA_EVIDENCE_CAMERA_CLEARANCE = 1.75;
const QA_EVIDENCE_LOOK_HEIGHT = 1.65;
const QA_EVIDENCE_CAMERA_HEIGHT_BAND = Object.freeze([1.70, 1.80]);
const QA_EVIDENCE_LOOK_HEIGHT_BAND = Object.freeze([1.60, 1.70]);
const QA_EVIDENCE_BUILDING_CLEARANCE = 3;
const QA_EVIDENCE_FORWARD_CLEARANCE = 45;
const QA_EVIDENCE_TREATMENT_RADIUS = 120;
// Transit may reserve the documented 56 m civic avenue. Completion restores
// the ordinary 12 m grid before any evidence-stop promise can settle.
const QA_TOUR_CAMERA = Object.freeze({
  yaw: -Math.PI * 0.5,
  pitch: 1.18,
  distance: 64,
});
// Each endpoint lands just beyond the next 384 m sector seam, yielding four
// real handoffs while both the focus and camera remain in the z=0 corridor.
const QA_STREAMING_TOUR_ROUTE = Object.freeze([
  Object.freeze({ x: 28, z: 0 }),
  Object.freeze({ x: 216, z: 0 }),
  Object.freeze({ x: 600, z: 0 }),
  Object.freeze({ x: 984, z: 0 }),
  Object.freeze({ x: 1368, z: 0 }),
]);
const QA_STREAMING_EVIDENCE_STOPS = Object.freeze([
  Object.freeze({
    id: 'sf-evidence:1:0:street-level',
    sectorKey: '1:0',
    entryPortalId: 'sf-portal:ew:0:0',
    camera: Object.freeze({ x: 288, z: -64 }),
    lookAt: Object.freeze({ x: 352, z: -64 }),
  }),
  Object.freeze({
    id: 'sf-evidence:2:0:street-level',
    sectorKey: '2:0',
    entryPortalId: 'sf-portal:ew:1:0',
    camera: Object.freeze({ x: 768, z: -96 }),
    lookAt: Object.freeze({ x: 768, z: -32 }),
  }),
  Object.freeze({
    id: 'sf-evidence:3:0:street-level',
    sectorKey: '3:0',
    entryPortalId: 'sf-portal:ew:2:0',
    camera: Object.freeze({ x: 1248, z: 64 }),
    lookAt: Object.freeze({ x: 1184, z: 64 }),
  }),
  Object.freeze({
    id: 'sf-evidence:4:0:street-level',
    sectorKey: '4:0',
    entryPortalId: 'sf-portal:ew:3:0',
    camera: Object.freeze({ x: 1536, z: 96 }),
    lookAt: Object.freeze({ x: 1536, z: 32 }),
  }),
]);
let qaStreamingTour = null;

let sceneTransitioning = false;
const interiorShadowRefresh = {
  requests: 0,
  lastReason: null,
};

function requestInteriorShadowRefresh(reason) {
  renderer.shadowMap.needsUpdate = true;
  interiorShadowRefresh.requests += 1;
  interiorShadowRefresh.lastReason = reason;
}

const weatherModes = ['clear', 'fog', 'drizzle'];
let weatherIndex = 0;
let weatherMode = 'clear';
let beautyMode = false;

const lightingProfiles = {
  clear: {
    sun: 3.62,
    sunColor: new THREE.Color(0xffc48b),
    hemisphere: 0.98,
    skyColor: new THREE.Color(0xb7d7ef),
    groundColor: new THREE.Color(0x302824),
    skyTopColor: new THREE.Color(0x5b789e),
    skyHorizonColor: new THREE.Color(0xe3b8a0),
    skySunColor: new THREE.Color(0xffd0a0),
    rim: 0.34,
    rimColor: new THREE.Color(0x7ba9dc),
    fogColor: new THREE.Color(0x87999d),
    fogNear: 84,
    fogFar: 286,
    backgroundColor: new THREE.Color(0x101925),
    exposure: 1.04,
    environment: 0.3,
    bloom: 0.08,
    saturation: 1.04,
    contrast: 1.03,
    warmth: 0.018,
    wetness: 0,
    wetSurface: 0,
    vignette: 0.075,
    sunPulse: 0.06,
  },
  fog: {
    sun: 1.78,
    sunColor: new THREE.Color(0xdce1e3),
    hemisphere: 1.08,
    skyColor: new THREE.Color(0xc4d0d3),
    groundColor: new THREE.Color(0x4a4d4b),
    skyTopColor: new THREE.Color(0x64737f),
    skyHorizonColor: new THREE.Color(0x8d9998),
    skySunColor: new THREE.Color(0xa4acab),
    rim: 0.28,
    rimColor: new THREE.Color(0x9fb3be),
    fogColor: new THREE.Color(0x93a2a2),
    fogNear: 42,
    fogFar: 168,
    backgroundColor: new THREE.Color(0x16242d),
    exposure: 0.98,
    environment: 0.4,
    bloom: 0.1,
    saturation: 0.95,
    contrast: 0.98,
    warmth: -0.006,
    wetness: 0.18,
    wetSurface: 0,
    vignette: 0.085,
    sunPulse: 0.025,
  },
  drizzle: {
    sun: 0.98,
    sunColor: new THREE.Color(0xb8c8d0),
    hemisphere: 1.1,
    skyColor: new THREE.Color(0x9eb7c2),
    groundColor: new THREE.Color(0x343d3e),
    skyTopColor: new THREE.Color(0x536779),
    skyHorizonColor: new THREE.Color(0x8c9b9f),
    skySunColor: new THREE.Color(0xa7b4b4),
    rim: 0.22,
    rimColor: new THREE.Color(0x7995a3),
    fogColor: new THREE.Color(0x7f929b),
    fogNear: 58,
    fogFar: 222,
    backgroundColor: new THREE.Color(0x101f2b),
    exposure: 0.86,
    environment: 0.44,
    bloom: 0.075,
    saturation: 0.88,
    contrast: 1.01,
    warmth: -0.012,
    wetness: 1,
    wetSurface: 1,
    vignette: 0.095,
    sunPulse: 0.018,
  },
};

const weatherTransition = {
  duration: 1.25,
  elapsed: 1.25,
  target: lightingProfiles.clear,
  from: {
    sun: lightingProfiles.clear.sun,
    sunColor: lightingProfiles.clear.sunColor.clone(),
    hemisphere: lightingProfiles.clear.hemisphere,
    skyColor: lightingProfiles.clear.skyColor.clone(),
    groundColor: lightingProfiles.clear.groundColor.clone(),
    skyTopColor: lightingProfiles.clear.skyTopColor.clone(),
    skyHorizonColor: lightingProfiles.clear.skyHorizonColor.clone(),
    skySunColor: lightingProfiles.clear.skySunColor.clone(),
    rim: lightingProfiles.clear.rim,
    rimColor: lightingProfiles.clear.rimColor.clone(),
    fogColor: lightingProfiles.clear.fogColor.clone(),
    fogNear: lightingProfiles.clear.fogNear,
    fogFar: lightingProfiles.clear.fogFar,
    backgroundColor: lightingProfiles.clear.backgroundColor.clone(),
    exposure: lightingProfiles.clear.exposure,
    environment: lightingProfiles.clear.environment,
    bloom: lightingProfiles.clear.bloom,
    saturation: lightingProfiles.clear.saturation,
    contrast: lightingProfiles.clear.contrast,
    warmth: lightingProfiles.clear.warmth,
    wetness: lightingProfiles.clear.wetness,
    wetSurface: lightingProfiles.clear.wetSurface,
    vignette: lightingProfiles.clear.vignette,
  },
};

function applyWeatherPresentation(progress, time = elapsed) {
  const profile = weatherTransition.target;
  const from = weatherTransition.from;
  const clampedProgress = THREE.MathUtils.clamp(progress, 0, 1);
  const blend = THREE.MathUtils.smoothstep(clampedProgress, 0, 1);
  const interiorBlend = interiorPresentation.current;
  const exteriorKey = THREE.MathUtils.lerp(1, 0.08, interiorBlend);
  const exteriorFill = THREE.MathUtils.lerp(1, 0.42, interiorBlend);
  const exteriorRim = THREE.MathUtils.lerp(1, 0.16, interiorBlend);

  const calibratedSun = Math.max(
    0.04,
    THREE.MathUtils.lerp(from.sun, profile.sun, blend)
      + Math.sin(time * 0.035) * profile.sunPulse,
  );
  sun.intensity = calibratedSun * exteriorKey;
  sun.color.copy(from.sunColor).lerp(profile.sunColor, blend);
  hemisphere.intensity = THREE.MathUtils.lerp(from.hemisphere, profile.hemisphere, blend) * exteriorFill;
  hemisphere.color.copy(from.skyColor).lerp(profile.skyColor, blend);
  hemisphere.groundColor.copy(from.groundColor).lerp(profile.groundColor, blend);
  interiorHemisphere.intensity = interiorBlend * 0.5;
  interiorTransitionFill.intensity = interiorBlend * 1.15;
  if (proceduralSkyMaterial?.uniforms) {
    proceduralSkyMaterial.uniforms.topColor.value.copy(from.skyTopColor)
      .lerp(profile.skyTopColor, blend);
    proceduralSkyMaterial.uniforms.horizonColor.value.copy(from.skyHorizonColor)
      .lerp(profile.skyHorizonColor, blend);
    proceduralSkyMaterial.uniforms.sunColor.value.copy(from.skySunColor)
      .lerp(profile.skySunColor, blend);
  }
  rim.intensity = THREE.MathUtils.lerp(from.rim, profile.rim, blend) * exteriorRim;
  rim.color.copy(from.rimColor).lerp(profile.rimColor, blend);
  scene.fog.color.copy(from.fogColor).lerp(profile.fogColor, blend);
  scene.fog.near = THREE.MathUtils.lerp(from.fogNear, profile.fogNear, blend);
  scene.fog.far = THREE.MathUtils.lerp(from.fogFar, profile.fogFar, blend);
  scene.background.copy(from.backgroundColor).lerp(profile.backgroundColor, blend);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(from.exposure, profile.exposure, blend);
  scene.environmentIntensity = THREE.MathUtils.lerp(from.environment, profile.environment, blend)
    * THREE.MathUtils.lerp(1, 1.1, interiorBlend);
  bloomPass.strength = THREE.MathUtils.lerp(from.bloom, profile.bloom, blend);
  cinematicGradePass.uniforms.uSaturation.value = THREE.MathUtils.lerp(
    from.saturation,
    profile.saturation,
    blend,
  );
  cinematicGradePass.uniforms.uContrast.value = THREE.MathUtils.lerp(
    from.contrast,
    profile.contrast,
    blend,
  );
  cinematicGradePass.uniforms.uWarmth.value = THREE.MathUtils.lerp(
    from.warmth,
    profile.warmth,
    blend,
  );
  cinematicGradePass.uniforms.uWetness.value = THREE.MathUtils.lerp(
    from.wetness,
    profile.wetness,
    blend,
  );
  applyWetWeatherVisuals(
    THREE.MathUtils.lerp(from.wetSurface, profile.wetSurface, blend),
  );
  applyWeatherSurfaceTransition(clampedProgress);
  applyWeatherUniformTransition(clampedProgress);
  cinematicGradePass.uniforms.uVignette.value = THREE.MathUtils.lerp(
    from.vignette,
    profile.vignette + (beautyMode ? 0.045 : 0),
    blend,
  );
}

function updateInteriorPresentation(dt) {
  interiorPresentation.current = THREE.MathUtils.damp(
    interiorPresentation.current,
    interiorPresentation.target,
    10,
    Math.max(0, dt),
  );
}

function setWeatherMode(mode, { immediate = false } = {}) {
  const nextMode = weatherModes.includes(mode) ? mode : 'clear';
  const nextProfile = lightingProfiles[nextMode];
  if (nextMode === weatherMode && !immediate && weatherTransition.elapsed >= weatherTransition.duration) {
    return weatherMode;
  }

  registerWeatherVisuals();
  const previousWeatherMaterials = captureWeatherMaterialState();
  const previousWeatherUniforms = captureWeatherUniformState();
  weatherTransition.from.sun = sun.intensity;
  weatherTransition.from.sunColor.copy(sun.color);
  weatherTransition.from.hemisphere = hemisphere.intensity;
  weatherTransition.from.skyColor.copy(hemisphere.color);
  weatherTransition.from.groundColor.copy(hemisphere.groundColor);
  if (proceduralSkyMaterial?.uniforms) {
    weatherTransition.from.skyTopColor.copy(proceduralSkyMaterial.uniforms.topColor.value);
    weatherTransition.from.skyHorizonColor.copy(proceduralSkyMaterial.uniforms.horizonColor.value);
    weatherTransition.from.skySunColor.copy(proceduralSkyMaterial.uniforms.sunColor.value);
  }
  weatherTransition.from.rim = rim.intensity;
  weatherTransition.from.rimColor.copy(rim.color);
  weatherTransition.from.fogColor.copy(scene.fog.color);
  weatherTransition.from.fogNear = scene.fog.near;
  weatherTransition.from.fogFar = scene.fog.far;
  weatherTransition.from.backgroundColor.copy(scene.background);
  weatherTransition.from.exposure = renderer.toneMappingExposure;
  weatherTransition.from.environment = scene.environmentIntensity;
  weatherTransition.from.bloom = bloomPass.strength;
  weatherTransition.from.saturation = cinematicGradePass.uniforms.uSaturation.value;
  weatherTransition.from.contrast = cinematicGradePass.uniforms.uContrast.value;
  weatherTransition.from.warmth = cinematicGradePass.uniforms.uWarmth.value;
  weatherTransition.from.wetness = cinematicGradePass.uniforms.uWetness.value;
  weatherTransition.from.wetSurface = wetWeatherVisuals.current;
  weatherTransition.from.vignette = cinematicGradePass.uniforms.uVignette.value;
  weatherTransition.target = nextProfile;
  weatherTransition.elapsed = immediate ? weatherTransition.duration : 0;
  weatherMode = nextMode;
  weatherIndex = weatherModes.indexOf(nextMode);
  wetWeatherVisuals.target = nextProfile.wetSurface;

  city.setWeather?.(nextMode);
  streaming.setWeather?.(nextMode);
  traffic.setWeather?.(nextMode);
  pedestrians.setWeather?.(nextMode);
  streamedAgents.setWeather?.(nextMode);
  registerWeatherVisuals();
  weatherSurfaceTransition.entries = createWeatherTransitionEntries(
    previousWeatherMaterials,
    captureWeatherMaterialState(),
  );
  weatherUniformTransition.entries = createWeatherUniformTransitionEntries(
    previousWeatherUniforms,
    captureWeatherUniformState(),
  );
  weatherSurfaceTransition.active = !immediate && weatherSurfaceTransition.entries.length > 0;
  weatherUniformTransition.active = !immediate && weatherUniformTransition.entries.length > 0;
  applyWeatherPresentation(immediate ? 1 : 0, 0);
  hud?.setAtmosphere?.(nextMode);
  hud?.setMessage(
    nextMode === 'clear'
      ? 'Pacific light returns. Press R to cycle coastal weather.'
      : nextMode === 'fog'
        ? 'Coastal fog is rolling through the avenue.'
        : 'A light Pacific drizzle is moving across downtown.',
  );
  return nextMode;
}

// `createCity()` applies its own clear-world material preset while assembling
// the scene. Re-apply the matching shared presentation after all weather-aware
// objects exist, then let later changes crossfade instead of flashing between
// incompatible light, fog, and exposure states.
setWeatherMode('clear', { immediate: true });

function cycleWeather() {
  return setWeatherMode(weatherModes[(weatherIndex + 1) % weatherModes.length]);
}

function updateWeatherPresentation(dt, time) {
  if (weatherTransition.elapsed < weatherTransition.duration) {
    weatherTransition.elapsed = Math.min(
      weatherTransition.duration,
      weatherTransition.elapsed + Math.max(0, dt),
    );
  }
  applyWeatherPresentation(weatherTransition.elapsed / weatherTransition.duration, time);
  if (weatherTransition.elapsed >= weatherTransition.duration) {
    weatherSurfaceTransition.active = false;
    weatherUniformTransition.active = false;
  }
}

function toggleBeautyMode() {
  beautyMode = !beautyMode;
  app?.classList.toggle('is-beauty', beautyMode);
  if (!beautyMode) hud?.setMessage('HUD restored. Press H at any time for a clean cinematic view.');
}

function runSceneTransition(callback) {
  if (sceneTransitioning) return;
  sceneTransitioning = true;
  sceneTransition.classList.add('is-active');
  window.setTimeout(() => {
    callback();
    window.setTimeout(() => {
      sceneTransition.classList.remove('is-active');
      sceneTransitioning = false;
    }, 180);
  }, 180);
}

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const cameraAxis = new THREE.Vector3();
const controlOffset = new THREE.Vector3();
const desiredCamera = new THREE.Vector3();
const lookTarget = new THREE.Vector3();
const previousCameraTarget = new THREE.Vector3().copy(controls.target);
const cameraVelocity = new THREE.Vector3();
const targetDelta = new THREE.Vector3();
const cameraLookAhead = new THREE.Vector3();

function dampAngle(current, target, lambda, dt) {
  const difference = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
  return current + difference * (1 - Math.exp(-lambda * dt));
}

function setInteriorPresentationTarget(active, room = null) {
  interiorPresentation.target = active ? 1 : 0;
  if (room?.position) {
    interiorTransitionFill.position.copy(room.position).add(new THREE.Vector3(0, 3.15, 0.4));
  }
}

function snapCameraToControls() {
  controls.focus.copy(controls.target);
  previousCameraTarget.copy(controls.target);
  cameraVelocity.set(0, 0, 0);
  controls.cameraYaw = controls.yaw;
  controls.cameraPitch = controls.pitch;
  controls.cameraDistance = controls.distance;
  controls.spherical.set(controls.cameraDistance, controls.cameraPitch, controls.cameraYaw);
  desiredCamera.copy(controls.focus).add(controlOffset.setFromSpherical(controls.spherical));
  const safeCamera = city.resolveCameraPosition?.(controls.focus, desiredCamera) || desiredCamera;
  camera.position.copy(safeCamera);
  lookTarget.copy(controls.target);
  camera.lookAt(lookTarget);
  camera.updateMatrixWorld(true);
}

function getQaRoamState() {
  const stats = streaming.stats;
  return {
    mode: controls.interiorMode ? 'interior' : 'roam',
    target: {
      x: controls.target.x,
      y: controls.target.y,
      z: controls.target.z,
    },
    focus: {
      x: controls.focus.x,
      y: controls.focus.y,
      z: controls.focus.z,
    },
    streamingFocusSector: stats.focusSector,
    qaPublicCorridor: streaming.getQaPublicCorridor?.() ?? null,
    tour: qaStreamingTour
      ? {
        segment: qaStreamingTour.segmentIndex + 1,
        segmentCount: qaStreamingTour.route.length - 1,
        segmentProgress: qaStreamingTour.segmentElapsed / qaStreamingTour.segmentDuration,
      }
      : null,
  };
}

function getQaEvidenceStopSpec(selector) {
  const stop = QA_STREAMING_EVIDENCE_STOPS.find(
    (candidate) => candidate.id === selector || candidate.sectorKey === selector,
  );
  if (!stop) {
    throw new RangeError(
      `Unknown streaming evidence stop "${selector}". Expected one of ${
        QA_STREAMING_EVIDENCE_STOPS.map((candidate) => candidate.sectorKey).join(', ')
      }.`,
    );
  }
  return stop;
}

function resolveQaEvidenceStop(spec) {
  const cameraSurface = streaming.getSurfaceHeight?.(spec.camera);
  const lookSurface = streaming.getSurfaceHeight?.(spec.lookAt);
  if (!Number.isFinite(cameraSurface) || !Number.isFinite(lookSurface)) {
    throw new RangeError(`Evidence stop ${spec.id} is outside the streaming footprint.`);
  }
  const cameraPosition = new THREE.Vector3(
    spec.camera.x,
    cameraSurface + QA_EVIDENCE_CAMERA_CLEARANCE,
    spec.camera.z,
  );
  const lookAt = new THREE.Vector3(
    spec.lookAt.x,
    lookSurface + QA_EVIDENCE_LOOK_HEIGHT,
    spec.lookAt.z,
  );
  const publicRealm = streaming.getPublicRealmPoint?.(spec.camera) ?? null;
  return {
    id: spec.id,
    sectorKey: spec.sectorKey,
    entryPortalId: spec.entryPortalId,
    cameraPosition,
    lookAt,
    cameraSurface,
    lookSurface,
    publicRealm,
  };
}

function getQaStreamingEvidenceStops() {
  return QA_STREAMING_EVIDENCE_STOPS.map((spec) => {
    const stop = resolveQaEvidenceStop(spec);
    return {
      id: stop.id,
      sectorKey: stop.sectorKey,
      entryPortalId: stop.entryPortalId,
      camera: {
        x: stop.cameraPosition.x,
        y: stop.cameraPosition.y,
        z: stop.cameraPosition.z,
      },
      lookAt: {
        x: stop.lookAt.x,
        y: stop.lookAt.y,
        z: stop.lookAt.z,
      },
      cameraSurface: stop.cameraSurface,
      lookSurface: stop.lookSurface,
      cameraClearance: stop.cameraPosition.y - stop.cameraSurface,
      lookClearance: stop.lookAt.y - stop.lookSurface,
      publicRealm: stop.publicRealm,
    };
  });
}

function observeQaTourSector(tour) {
  const focusSector = streaming.stats.focusSector;
  if (!focusSector) return;
  if (!tour.focusSectors.includes(focusSector)) {
    tour.focusSectors.push(focusSector);
  }
  if (tour.lastObservedSector && tour.lastObservedSector !== focusSector) {
    tour.boundaries.push({
      fromSector: tour.lastObservedSector,
      toSector: focusSector,
      portalId: streaming.getPortalId?.(tour.lastObservedSector, focusSector) ?? null,
      target: {
        x: controls.target.x,
        y: controls.target.y,
        z: controls.target.z,
      },
      camera: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      },
      corridor: streaming.getQaPublicCorridor?.() ?? null,
    });
  }
  tour.lastObservedSector = focusSector;
}

function finishQaStreamingTour(tour, status) {
  observeQaTourSector(tour);
  if (qaStreamingTour === tour) qaStreamingTour = null;
  const transitCorridor = streaming.getQaPublicCorridor?.() ?? null;
  streaming.setQaPublicCorridorActive?.(false);
  tour.resolve({
    status,
    segmentCount: tour.route.length - 1,
    focusSectors: [...tour.focusSectors],
    boundaries: tour.boundaries.map((boundary) => ({ ...boundary })),
    transitCorridor,
    corridor: streaming.getQaPublicCorridor?.() ?? null,
    evidenceStops: getQaStreamingEvidenceStops(),
    roam: getQaRoamState(),
  });
}

function cancelQaStreamingTour(status = 'cancelled') {
  const tour = qaStreamingTour;
  if (!tour) return false;
  finishQaStreamingTour(tour, status);
  return true;
}

function resolveQaRoamPose(position) {
  const x = position?.x;
  const z = position?.z;
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new TypeError('setRoamPose requires finite numeric x and z coordinates.');
  }
  const surfaceHeight = streaming.getSurfaceHeight?.({ x, z });
  if (!Number.isFinite(surfaceHeight)) {
    throw new RangeError('Roam pose must remain inside the streaming footprint.');
  }
  // The player focus is kept at the same terrain-relative clearance used by
  // normal roaming. updateCamera then runs the ordinary camera collision path.
  return new THREE.Vector3(x, surfaceHeight + QA_ROAM_CLEARANCE, z);
}

function prepareQaRoam() {
  if (sceneTransitioning) {
    throw new Error('QA roaming travel cannot start during an interior transition.');
  }
  controls.keys.clear();
  qaCameraPose = null;
  if (!controls.interiorMode) return;
  city.exitInterior();
  requestInteriorShadowRefresh('qa-exit');
  controls.interiorMode = false;
  controls.activePortal = null;
  controls.exteriorSnapshot = null;
}

function applyQaRoamPose(position) {
  prepareQaRoam();
  controls.target.copy(position);
  // Keep the camera looking at the same roaming focus on the next normal
  // frame. Its position still passes through city.resolveCameraPosition().
  controls.focus.copy(position);
}

function applyQaTourCameraFraming() {
  controls.yaw = QA_TOUR_CAMERA.yaw;
  controls.cameraYaw = QA_TOUR_CAMERA.yaw;
  controls.pitch = QA_TOUR_CAMERA.pitch;
  controls.cameraPitch = QA_TOUR_CAMERA.pitch;
  controls.distance = QA_TOUR_CAMERA.distance;
  controls.cameraDistance = QA_TOUR_CAMERA.distance;
}

function setQaRoamPose(position) {
  cancelQaStreamingTour('superseded');
  streaming.setQaPublicCorridorActive?.(false);
  applyQaRoamPose(resolveQaRoamPose(position));
  // Teleport-based visual gates should show the district, not a stale
  // post-interior/tutorial toast from the previous pose.
  hud.setMessage(null);
  return getQaRoamState();
}

function getQaEvidenceStopState(stop) {
  const corridor = streaming.getQaPublicCorridor?.() ?? null;
  const presentation = streaming.getSectorPresentation?.(stop.sectorKey) ?? null;
  const publicRealm = streaming.getPublicRealmPoint?.({
    x: stop.cameraPosition.x,
    z: stop.cameraPosition.z,
  }) ?? null;
  const viewValidation = streaming.validateDetailedView?.(
    stop.cameraPosition,
    stop.lookAt,
    {
      minimumClearance: QA_EVIDENCE_BUILDING_CLEARANCE,
      forwardLength: QA_EVIDENCE_FORWARD_CLEARANCE,
      treatmentRadius: QA_EVIDENCE_TREATMENT_RADIUS,
    },
  ) ?? null;
  const stats = streaming.stats;
  const streamedAgentEvidence = streamedAgents.getEvidenceState(stop.cameraPosition, 120);
  const coreSimulationActive = stats.focusSector === '0:0';
  const cameraClearance = stop.cameraPosition.y - (publicRealm?.surfaceHeight ?? Number.NaN);
  const lookClearance = stop.lookAt.y - stop.lookSurface;
  const presentationData = presentation?.presentation;
  const verificationErrors = [];
  if (corridor?.active !== false) verificationErrors.push('transit corridor still active');
  if (stats.focusSector !== stop.sectorKey) {
    verificationErrors.push(`streaming focus is ${stats.focusSector}`);
  }
  if (!presentation?.active || !presentation?.detailed) {
    verificationErrors.push('sector is not active detailed geometry');
  }
  if (!presentationData?.normalPresentation || presentationData?.mode !== 'normal-detail') {
    verificationErrors.push('sector has not restored normal detail');
  }
  if ((presentationData?.buildingCount ?? 0) < 24) {
    verificationErrors.push('normal massing has fewer than 24 buildings');
  }
  if ((presentationData?.atlasFrontageBuildings ?? 0)
    !== (presentationData?.buildingCount ?? -1)) {
    verificationErrors.push('not every massing instance has four treated faces');
  }
  if ((presentationData?.architecturalFaceCount ?? 0)
    !== (presentationData?.requiredArchitecturalFaceCount ?? -1)) {
    verificationErrors.push('normal massing has untreated architectural faces');
  }
  if ((presentationData?.facadePlaneCount ?? 0)
    < (presentationData?.requiredArchitecturalFaceCount ?? Number.POSITIVE_INFINITY)) {
    verificationErrors.push('facade plane coverage is below all-face count');
  }
  if (presentationData?.roadGridDivisions !== 6
    || presentationData?.sidewalkBlockCount !== 36
    || presentationData?.crosswalkCount !== 100
    || presentationData?.crosswalkStripeCount !== 500
    || presentationData?.centerMarkLength !== 3
    || presentationData?.centerMarkGap !== 6
    || presentationData?.storefrontBandCount !== presentationData?.buildingCount
    || presentationData?.streetlightCount !== 32) {
    verificationErrors.push('bounded public-realm grid is incomplete');
  }
  if (presentationData?.crosswalkStripesPerCrossing !== 5
    || presentationData?.crosswalkStripeWidth !== 0.45
    || presentationData?.crosswalkStripeGap !== 0.35
    || presentationData?.crosswalkCurbInset !== 0.15
    || presentationData?.crosswalkIntersectionSetback !== 0.6
    || presentationData?.crosswalkLongDimensions?.eastWestRoad !== 11.7
    || presentationData?.crosswalkLongDimensions?.northSouthRoad !== 11.7
    || presentationData?.roadSurfaceOffset !== 0.014
    || presentationData?.markingRoadOffset !== 0.026
    || presentationData?.surfacePatchMaximum !== 8
    || presentationData?.markingPatchMaximum !== 2) {
    verificationErrors.push('road marking geometry metadata is inconsistent');
  }
  if (!publicRealm?.onRoad || publicRealm?.mode !== 'normal-detail') {
    verificationErrors.push('camera is not above a normal public road or intersection');
  }
  if (!Number.isFinite(cameraClearance)
    || cameraClearance < QA_EVIDENCE_CAMERA_HEIGHT_BAND[0]
    || cameraClearance > QA_EVIDENCE_CAMERA_HEIGHT_BAND[1]) {
    verificationErrors.push('camera is outside the 1.70-1.80 m eye-height band');
  }
  if (!Number.isFinite(lookClearance)
    || lookClearance < QA_EVIDENCE_LOOK_HEIGHT_BAND[0]
    || lookClearance > QA_EVIDENCE_LOOK_HEIGHT_BAND[1]) {
    verificationErrors.push('look target is outside the 1.60-1.70 m height band');
  }
  if (!viewValidation?.cameraClearance?.clear) {
    verificationErrors.push('camera is within 3 m of a building volume');
  }
  if (!viewValidation?.forwardRay?.clear) {
    verificationErrors.push('the first 45 m of the view ray intersects massing');
  }
  if (!viewValidation?.nearbyTreatment?.complete) {
    verificationErrors.push('a proxy or building within 120 m is untreated');
  }
  if ((viewValidation?.nearbyVariety?.atlasCells?.length ?? 0) < 2
    || (viewValidation?.nearbyVariety?.silhouettes?.length ?? 0) < 2
    || (viewValidation?.nearbyVariety?.storefrontBands ?? 0) < 3) {
    verificationErrors.push('nearby facade, silhouette, or storefront variety is insufficient');
  }
  if (stats.activeDetailed > stats.maxDetailed
    || stats.activeProxies > stats.maxProxies
    || stats.backgroundStates > stats.maxBackgroundStates
    || stats.handoffs.pending > stats.maxHandoffQueue) {
    verificationErrors.push('a streaming or simulation cap is exceeded');
  }
  if ((streamedAgentEvidence.visibleWithinRadius.vehicles ?? 0) < 3
    || (streamedAgentEvidence.visibleWithinRadius.pedestrians ?? 0) < 5) {
    verificationErrors.push('streamed actors are below the 3 vehicle / 5 pedestrian evidence minimum');
  }
  if ((streamedAgentEvidence.stats.vehicles.moving ?? 0) < 1
    || (streamedAgentEvidence.stats.pedestrians.moving ?? 0) < 1) {
    verificationErrors.push('both streamed actor kinds are not moving');
  }
  if (streamedAgentEvidence.stats.duplicateIds !== 0
    || streamedAgentEvidence.stats.conservationError !== 0
    || streamedAgentEvidence.stats.capErrors !== 0) {
    verificationErrors.push('streamed actor identity, conservation, or cap invariant failed');
  }
  if (streamedAgentEvidence.stats.incrementalDrawCallEstimate > 24) {
    verificationErrors.push('streamed actor incremental draw-call estimate exceeded 24');
  }
  if (coreSimulationActive || traffic.group.visible || pedestrians.group.visible) {
    verificationErrors.push('authored core actor groups remain active outside sector 0:0');
  }
  return {
    id: stop.id,
    sectorKey: stop.sectorKey,
    entryPortalId: stop.entryPortalId,
    verified: verificationErrors.length === 0,
    verificationErrors,
    corridor,
    presentation,
    publicRealm,
    viewValidation,
    cameraClearance,
    lookClearance,
    camera: {
      x: stop.cameraPosition.x,
      y: stop.cameraPosition.y,
      z: stop.cameraPosition.z,
    },
    lookAt: {
      x: stop.lookAt.x,
      y: stop.lookAt.y,
      z: stop.lookAt.z,
    },
    stats,
    streamedAgents: streamedAgentEvidence,
    coreActors: {
      active: coreSimulationActive,
      trafficVisible: traffic.group.visible,
      pedestriansVisible: pedestrians.group.visible,
    },
  };
}

function setQaStreamingEvidenceStop(selector) {
  const spec = getQaEvidenceStopSpec(selector);
  cancelQaStreamingTour('superseded');
  streaming.setQaPublicCorridorActive?.(false);
  const stop = resolveQaEvidenceStop(spec);
  applyQaRoamPose(resolveQaRoamPose(spec.camera));
  qaCameraPose = {
    position: stop.cameraPosition.clone(),
    lookAt: stop.lookAt.clone(),
  };
  camera.position.copy(stop.cameraPosition);
  camera.lookAt(stop.lookAt);
  camera.updateMatrixWorld(true);
  // Force one ordinary bounded reconcile at this focus. This uses the same
  // detail/proxy budgets as play and cannot expand the whole-city load.
  streaming.update?.(controls.target, camera, 0.3, elapsed);

  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const state = getQaEvidenceStopState(stop);
        if (!state.verified) {
          reject(new Error(
            `Evidence stop ${stop.id} failed: ${state.verificationErrors.join('; ')}.`,
          ));
          return;
        }
        resolve(state);
      });
    });
  });
}

function getQaTourSegmentDuration(options = {}) {
  if (options == null || typeof options !== 'object') {
    throw new TypeError('runStreamingTour options must be an object when provided.');
  }
  const duration = options.segmentDuration ?? QA_TOUR_DEFAULT_SEGMENT_DURATION;
  if (!Number.isFinite(duration)
    || duration < QA_TOUR_MIN_SEGMENT_DURATION
    || duration > QA_TOUR_MAX_SEGMENT_DURATION) {
    throw new RangeError(
      `runStreamingTour segmentDuration must be ${QA_TOUR_MIN_SEGMENT_DURATION}-${QA_TOUR_MAX_SEGMENT_DURATION} seconds.`,
    );
  }
  return duration;
}

function runQaStreamingTour(options) {
  const segmentDuration = getQaTourSegmentDuration(options);
  if (sceneTransitioning) {
    throw new Error('QA roaming travel cannot start during an interior transition.');
  }
  cancelQaStreamingTour('superseded');
  const route = QA_STREAMING_TOUR_ROUTE.map(resolveQaRoamPose);
  streaming.setQaPublicCorridorActive?.(true);
  let resolve;
  const completion = new Promise((done) => { resolve = done; });
  qaStreamingTour = {
    route,
    segmentDuration,
    segmentIndex: 0,
    segmentElapsed: 0,
    awaitingCompletion: false,
    focusSectors: [],
    boundaries: [],
    lastObservedSector: null,
    resolve,
  };
  applyQaRoamPose(route[0]);
  applyQaTourCameraFraming();
  return completion;
}

function updateQaStreamingTour(dt) {
  const tour = qaStreamingTour;
  if (!tour) return false;
  controls.keys.clear();
  if (tour.awaitingCompletion) {
    // Let one completed application frame reconcile the final player pose
    // through streaming.update() before the caller's promise settles.
    finishQaStreamingTour(tour, 'completed');
    return true;
  }

  let remaining = Math.max(0, dt);
  while (remaining > 0 && qaStreamingTour === tour) {
    const durationRemaining = tour.segmentDuration - tour.segmentElapsed;
    const step = Math.min(remaining, durationRemaining);
    tour.segmentElapsed += step;
    remaining -= step;
    const progress = THREE.MathUtils.clamp(tour.segmentElapsed / tour.segmentDuration, 0, 1);
    controls.target.lerpVectors(
      tour.route[tour.segmentIndex],
      tour.route[tour.segmentIndex + 1],
      progress,
    );
    controls.focus.copy(controls.target);
    if (progress < 1) break;
    tour.segmentIndex += 1;
    tour.segmentElapsed = 0;
    if (tour.segmentIndex >= tour.route.length - 1) {
      tour.awaitingCompletion = true;
      break;
    }
  }
  return true;
}

function getTouchDistance() {
  const points = [...controls.touchPoints.values()];
  if (points.length !== 2) return null;
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function updateCamera(dt) {
  if (qaCameraPose) {
    previousCameraTarget.copy(controls.target);
    cameraVelocity.set(0, 0, 0);
    camera.position.copy(qaCameraPose.position);
    camera.lookAt(qaCameraPose.lookAt);
    camera.updateMatrixWorld(true);
    return;
  }
  const qaTourActive = updateQaStreamingTour(dt);
  const moveSpeed = controls.keys.has('shiftleft') || controls.keys.has('shiftright') ? 22 : 10;
  const axis = cameraAxis.set(
    (controls.keys.has('keyd') ? 1 : 0) - (controls.keys.has('keya') ? 1 : 0),
    0,
    (controls.keys.has('keys') ? 1 : 0) - (controls.keys.has('keyw') ? 1 : 0),
  );

  if (!qaTourActive && axis.lengthSq() > 0) {
    // A regular movement input returns the pooled street presentation to its
    // ordinary layout. The broad avenue is intentionally an opt-in QA view.
    streaming.setQaPublicCorridorActive?.(false);
    axis.normalize();
    forward.set(Math.sin(controls.yaw), 0, Math.cos(controls.yaw));
    right.set(forward.z, 0, -forward.x);
    controlOffset.copy(right).multiplyScalar(axis.x).addScaledVector(forward, axis.z);
    controls.target.addScaledVector(controlOffset, moveSpeed * dt);
    if (controls.interiorMode && controls.activePortal?.room) {
      const anchor = controls.activePortal.room.position;
      controls.target.x = THREE.MathUtils.clamp(controls.target.x, anchor.x - 4.4, anchor.x + 4.4);
      controls.target.z = THREE.MathUtils.clamp(controls.target.z, anchor.z - 3.4, anchor.z + 3.4);
      controls.target.y = THREE.MathUtils.clamp(controls.target.y, 1.4, 3.5);
    } else {
      controls.target.y = THREE.MathUtils.clamp(controls.target.y, 2, 46);
    }
  }

  if (!controls.interiorMode) {
    const streamedSurface = streaming.getSurfaceHeight?.(controls.target);
    if (Number.isFinite(streamedSurface)) {
      // Sector 0:0 resolves to Y=0, retaining the authored target at Y=4.
      // Outside it, the same clearance follows a smooth, query-only terrain
      // datum without loading any additional sector geometry.
      controls.target.y = THREE.MathUtils.damp(
        controls.target.y,
        streamedSurface + QA_ROAM_CLEARANCE,
        7,
        dt,
      );
    }
  }

  // Track focus motion separately from input so the camera can lead a moving
  // roam target by a small, speed-scaled amount. Large discontinuities are QA
  // teleports or sector resets; do not turn those into a dramatic whip-pan.
  targetDelta.set(
    controls.target.x - previousCameraTarget.x,
    0,
    controls.target.z - previousCameraTarget.z,
  );
  if (targetDelta.lengthSq() > 100 || dt <= 0) {
    cameraVelocity.set(0, 0, 0);
  } else {
    cameraLookAhead.copy(targetDelta).multiplyScalar(1 / dt);
    if (cameraLookAhead.lengthSq() > 1156) cameraLookAhead.setLength(34);
    cameraVelocity.lerp(cameraLookAhead, 1 - Math.exp(-8 * dt));
  }
  previousCameraTarget.copy(controls.target);

  controls.pitch = THREE.MathUtils.clamp(controls.pitch, 0.28, controls.interiorMode ? 2.2 : 2.45);
  controls.distance = THREE.MathUtils.clamp(
    controls.distance,
    controls.interiorMode ? 3.1 : 16,
    controls.interiorMode ? 8.5 : 180,
  );
  controls.focus.lerp(controls.target, 1 - Math.exp(-13 * dt));
  controls.cameraYaw = dampAngle(controls.cameraYaw, controls.yaw, 18, dt);
  controls.cameraPitch = THREE.MathUtils.damp(controls.cameraPitch, controls.pitch, 18, dt);
  controls.cameraDistance = THREE.MathUtils.damp(controls.cameraDistance, controls.distance, 14, dt);
  controls.spherical.set(controls.cameraDistance, controls.cameraPitch, controls.cameraYaw);
  desiredCamera.copy(controls.focus).add(controlOffset.setFromSpherical(controls.spherical));
  const safeCamera = city.resolveCameraPosition?.(controls.focus, desiredCamera) || desiredCamera;
  const cameraFollowLambda = controls.interiorMode ? 18 : qaTourActive ? 14 : 12;
  camera.position.lerp(safeCamera, 1 - Math.exp(-cameraFollowLambda * dt));
  const lookAheadFactor = controls.interiorMode ? 0.025 : qaTourActive ? 0.06 : 0.11;
  cameraLookAhead.copy(cameraVelocity).multiplyScalar(lookAheadFactor);
  if (cameraLookAhead.lengthSq() > 7.84) cameraLookAhead.setLength(2.8);
  lookTarget.copy(controls.focus).add(cameraLookAhead);
  camera.lookAt(lookTarget);
  hud?.setCameraState({
    mode: controls.interiorMode ? 'interior' : 'roam',
    distance: controls.cameraDistance,
  });
}

function onPointerDown(event) {
  canvas.focus({ preventScroll: true });
  controls.pointerId = event.pointerId;
  controls.lastX = event.clientX;
  controls.lastY = event.clientY;
  if (event.pointerType === 'touch') {
    controls.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    controls.pinchDistance = getTouchDistance();
  }
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-dragging');
}

function onPointerMove(event) {
  if (sceneTransitioning) return;
  if (event.pointerType === 'touch' && controls.touchPoints.has(event.pointerId)) {
    controls.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinchDistance = getTouchDistance();
    if (pinchDistance && controls.pinchDistance) {
      controls.distance *= controls.pinchDistance / pinchDistance;
      controls.pinchDistance = pinchDistance;
      return;
    }
  }
  if (controls.pointerId !== event.pointerId) return;
  const dx = event.clientX - controls.lastX;
  const dy = event.clientY - controls.lastY;
  controls.lastX = event.clientX;
  controls.lastY = event.clientY;
  const sensitivity = event.pointerType === 'touch' ? 0.005 : 0.0038;
  controls.yaw -= dx * sensitivity;
  controls.pitch += dy * sensitivity * 0.72;
}

function onPointerUp(event) {
  if (event.pointerType === 'touch') {
    controls.touchPoints.delete(event.pointerId);
    controls.pinchDistance = getTouchDistance();
    if (controls.pointerId === event.pointerId) {
      const remainingTouch = controls.touchPoints.entries().next().value;
      controls.pointerId = remainingTouch ? remainingTouch[0] : null;
      if (remainingTouch) {
        controls.lastX = remainingTouch[1].x;
        controls.lastY = remainingTouch[1].y;
      }
    }
  } else if (controls.pointerId === event.pointerId) {
    controls.pointerId = null;
  }
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  canvas.classList.toggle('is-dragging', controls.pointerId !== null);
}

function onWheel(event) {
  event.preventDefault();
  controls.distance *= Math.exp(event.deltaY * 0.0009);
}

function onKeyDown(event) {
  const rawCode = event.code || event.key || '';
  const code = rawCode.length === 1 ? `Key${rawCode.toUpperCase()}` : rawCode;
  if (sceneTransitioning) {
    event.preventDefault();
    return;
  }
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyH', 'KeyR', 'KeyC', 'KeyM'].includes(code)) event.preventDefault();
  if (code === 'KeyR' && !event.repeat) cycleWeather();
  if (code === 'KeyH' && !event.repeat) toggleBeautyMode();
  if (code === 'KeyC' && !event.repeat) setRenderQuality(renderQuality.mode === 'cinematic' ? 'auto' : 'cinematic');
  if (code === 'KeyM' && !event.repeat) hud?.toggleMap?.();
  if (code === 'KeyE' && !event.repeat) {
    if (controls.interiorMode) {
      performInteriorAction();
    } else {
      enterNearestInterior();
    }
  }
  if (code === 'Escape' && controls.interiorMode) {
    exitInterior();
  }
  controls.keys.add(code.toLowerCase());
}

function onKeyUp(event) {
  const rawCode = event.code || event.key || '';
  const code = rawCode.length === 1 ? `Key${rawCode.toUpperCase()}` : rawCode;
  controls.keys.delete(code.toLowerCase());
}

function enterNearestInterior() {
  const nearest = getInteractionPortal();
  if (!nearest) {
    hud.setMessage('Move toward a lit doorway to enter.');
    return;
  }
  if (nearest.distance > nearest.radius) {
    hud.setMessage(`${nearest.label} / ${nearest.distance.toFixed(1)} m away`);
    return;
  }

  runSceneTransition(() => {
    controls.exteriorSnapshot = {
      target: controls.target.clone(),
      yaw: controls.yaw,
      pitch: controls.pitch,
      distance: controls.distance,
    };
    const interior = city.enterInterior(nearest);
    if (!interior) return;
    requestInteriorShadowRefresh('enter');
    controls.activePortal = nearest;
    controls.interiorMode = true;
    controls.target.copy(interior.target);
    controls.yaw = Math.PI;
    controls.pitch = 1.34;
    controls.distance = 5.7;
    setInteriorPresentationTarget(true, nearest.room);
    snapCameraToControls();
    const shiftAdvance = cityShift?.onPortalEntered(nearest);
    const flagship = city.getInteriorState?.().flagship;
    if (!shiftAdvance) {
      hud.setMessage(
        `Entered ${interior.label} · ${interior.roomLabel}. Press E or ESC to return.`,
      );
    }
  });
}

function performInteriorAction() {
  if (!controls.interiorMode) return;
  const hotspot = city.getInteriorInteraction?.(controls.target);
  if (!hotspot) {
    exitInterior();
    return;
  }
  if (!hotspot.enabled) {
    hud.setMessage(`${hotspot.label} / ${hotspot.distance.toFixed(1)} m away`);
    return;
  }
  const result = city.useInteriorInteraction?.(hotspot.id, controls.target);
  if (!result) return;
  if (result.changed) requestInteriorShadowRefresh(`hotspot:${result.id}`);
  const shiftAdvance = cityShift?.onHotspotUsed(result);
  if (!shiftAdvance) hud.setMessage(result.message);
}

function exitInterior() {
  if (!controls.interiorMode) return;
  runSceneTransition(() => {
    city.exitInterior();
    requestInteriorShadowRefresh('exit');
    controls.interiorMode = false;
    controls.activePortal = null;
    if (controls.exteriorSnapshot) {
      controls.target.copy(controls.exteriorSnapshot.target);
      controls.yaw = controls.exteriorSnapshot.yaw;
      controls.pitch = controls.exteriorSnapshot.pitch;
      controls.distance = controls.exteriorSnapshot.distance;
    }
    controls.exteriorSnapshot = null;
    setInteriorPresentationTarget(false);
    snapCameraToControls();
    hud.setMessage('Back on the avenue.');
  });
}

function updateInteraction() {
  if (controls.interiorMode) {
    const hotspot = city.getInteriorInteraction?.(controls.target);
    if (hotspot) {
      hud.setInteraction({
        label: `${hotspot.label} / ${hotspot.state.toUpperCase()}`,
        prompt: hotspot.enabled
          ? `E / TAP  ${hotspot.action}`
          : 'APPROACH · ESC EXIT',
        enabled: hotspot.enabled,
      });
      return;
    }
    hud.setInteraction({
      label: `INTERIOR / ${controls.activePortal?.room?.userData?.interiorLabel || 'ROOM'}`,
      prompt: 'E / TAP  EXIT',
      enabled: true,
    });
    return;
  }
  const nearest = getInteractionPortal();
  if (!nearest) {
    hud.setInteraction(null);
    return;
  }
  hud.setInteraction({
    label: `${nearest.featured ? 'FEATURED DOOR / ' : ''}${nearest.label} / ${nearest.distance.toFixed(1)} M`,
    prompt: nearest.distance <= nearest.radius ? 'E / TAP  ENTER' : 'APPROACH',
    enabled: nearest.distance <= nearest.radius,
  });
}

function getQaInteractionState() {
  const nearest = controls.interiorMode ? null : getInteractionPortal();
  const interiorHotspot = controls.interiorMode
    ? city.getInteriorInteraction?.(controls.target) ?? null
    : null;
  return {
    mode: controls.interiorMode ? 'interior' : 'roam',
    target: {
      x: controls.target.x,
      y: controls.target.y,
      z: controls.target.z,
    },
    camera: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    },
    portal: nearest
      ? {
        id: nearest.id,
        label: nearest.label,
        distance: nearest.distance,
        radius: nearest.radius,
        enabled: nearest.distance <= nearest.radius,
        featured: nearest.featured === true,
        signposted: nearest.signposted === true,
        source: nearest.source ?? 'authored-city',
        sectorKey: nearest.sectorKey ?? null,
        buildingId: nearest.buildingId ?? null,
        variant: nearest.room?.userData?.interiorVariant ?? null,
        roomLabel: nearest.room?.userData?.interiorLabel ?? null,
      }
      : null,
    focusedHotspot: interiorHotspot,
    interior: city.getInteriorState?.() ?? null,
    shadowRefresh: {
      pending: renderer.shadowMap.needsUpdate,
      requests: interiorShadowRefresh.requests,
      lastReason: interiorShadowRefresh.lastReason,
    },
  };
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('wheel', onWheel, { passive: false });
canvas.addEventListener('keydown', onKeyDown);
canvas.addEventListener('keyup', onKeyUp);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => controls.keys.clear());
document.addEventListener('visibilitychange', () => {
  controls.keys.clear();
  if (!document.hidden) {
    // Avoid treating time spent backgrounded as a real frame stall and
    // immediately downshifting quality when the tab becomes visible again.
    lastFrame = performance.now();
    clock.start();
    renderQuality.sampleTime = 0;
    renderQuality.sampleFrames = 0;
    renderQuality.adjustmentCooldown = Math.max(renderQuality.adjustmentCooldown, 1.5);
  }
});
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  controls.keys.clear();
  canvas?.setAttribute('inert', '');
  hudRoot?.setAttribute('inert', '');
  bootOverlay?.classList.remove('is-dismissed');
  app?.classList.remove('is-live');
  launchButton?.setAttribute('disabled', '');
  setBootStatus('Graphics context lost. Reload the page to continue.', true);
});

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  applyRenderQuality();
}

window.addEventListener('resize', resize);

const clock = new THREE.Clock();
let elapsed = 0;
let lastFrame = performance.now();
let ready = false;
let started = false;
const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

function startExperience() {
  if (!ready || started) return;

  started = true;
  canvas?.removeAttribute('inert');
  hudRoot?.removeAttribute('inert');
  bootOverlay?.classList.add('is-dismissed');
  app?.classList.add('is-live');
  canvas.focus({ preventScroll: true });
  cityShift?.start();
  hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
  const featured = city.getFeaturedPortal?.(controls.target);
  hud.setMessage(
    featured
      ? `Featured interior · ${featured.label}, ${featured.distance.toFixed(0)} m east. Follow the lit PUBLIC LOBBY · ENTER sign.`
      : 'Tip: press R for coastal weather, C for render quality, H for beauty mode.',
  );
  window.setTimeout(() => hud.setMessage(null), featured ? 8200 : 5600);
}

launchButton?.addEventListener('click', startExperience);
launchButton?.addEventListener('keydown', (event) => {
  const key = event.key || event.code;
  if (!['Enter', 'NumpadEnter', ' ', 'Spacebar', 'Space'].includes(key)) return;
  if (launchButton.disabled) return;
  event.preventDefault();
  startExperience();
});

function frame(now) {
  const frameDelta = Math.min(Math.max(0, (now - lastFrame) / 1000), 0.25);
  const dt = Math.min(clock.getDelta(), 0.05);
  const motionDt = reducedMotionQuery?.matches ? 0 : dt;
  elapsed += motionDt;
  updateCamera(dt);
  const streamingFocus = controls.interiorMode && controls.exteriorSnapshot
    ? controls.exteriorSnapshot.target
    : controls.target;
  streaming.update?.(streamingFocus, camera, motionDt, elapsed);
  streamedAgents.update?.(streamingFocus, motionDt, elapsed);
  if (qaStreamingTour) observeQaTourSector(qaStreamingTour);
  city.update?.(motionDt, elapsed);
  // The authored traffic/NPC simulation belongs to the core sector. Park its
  // render groups and CPU updates when roaming elsewhere; streamed districts
  // will register their own bounded systems as authored data comes online.
  const coreSimulationActive = streaming.stats.focusSector === '0:0';
  traffic.group.visible = coreSimulationActive;
  pedestrians.group.visible = coreSimulationActive;
  if (coreSimulationActive) {
    traffic.update?.(motionDt, elapsed);
    pedestrians.update?.(motionDt, elapsed);
  }
  const gameState = cityShift?.update?.(motionDt, controls.target, controls.activePortal);
  const mapStreamingStats = streaming.stats;
  const mapStreamedAgents = streamedAgents.getStats?.() ?? null;
  const mapDistrict = coreSimulationActive
    ? 'Core district'
    : streaming.getSectorPresentation?.(mapStreamingStats.focusSector)?.presentation?.district
      || 'City grid';
  const mapVehicles = coreSimulationActive
    ? traffic.getStats?.()?.active
    : mapStreamedAgents?.vehicles?.visible;
  const mapPedestrians = coreSimulationActive
    ? pedestrians.getStats?.()?.active
    : mapStreamedAgents?.pedestrians?.visible;
  const mapState = {
    sector: mapStreamingStats.focusSector,
    district: mapDistrict,
    vehicles: mapVehicles,
    pedestrians: mapPedestrians,
    weather: weatherMode,
    mapX: THREE.MathUtils.clamp((controls.target.x / 5760 + 0.5) * 100, 4, 96),
    mapY: THREE.MathUtils.clamp((controls.target.z / 5760 + 0.5) * 100, 4, 96),
  };
  hud.update?.(frameDelta, elapsed, gameState, mapState);
  updateInteraction();
  // The city owns weather-aware materials and particles; this pass owns the
  // shared light/fog/exposure crossfade and runs after city.update(), which
  // otherwise reapplies its authored sun pulse every frame.
  updateInteriorPresentation(reducedMotionQuery?.matches ? 1 : frameDelta);
  updateWeatherPresentation(frameDelta, elapsed);
  if (postProcessingActive) composer.render();
  else renderer.render(scene, camera);
  updateAdaptiveQuality(frameDelta);

  if (!ready) {
    ready = true;
    bootOverlay?.classList.add('is-ready');
    launchButton?.removeAttribute('disabled');
    launchButton?.focus({ preventScroll: true });
    const label = launchButton?.querySelector('span');
    if (label) label.textContent = 'Enter the city';
    setBootStatus('WebGL2 ready · Calibrated lighting and adaptive rendering enabled.');
  }

  lastFrame = now;
  requestAnimationFrame(frame);
}

setBootStatus(`WebGL2 online · Three.js ${THREE.REVISION}`);
requestAnimationFrame(frame);

window.__SF_SIM__ = {
  scene,
  camera,
  renderer,
  composer,
  city,
  traffic,
  pedestrians,
  streamedAgents,
  streaming,
  cityShift,
  staticCityRendering,
  hud,
  setRenderQuality,
  setWeather(mode) {
    return setWeatherMode(mode);
  },
  get weather() {
    return weatherMode;
  },
  get weatherTransition() {
    return {
      mode: weatherMode,
      progress: THREE.MathUtils.clamp(
        weatherTransition.elapsed / weatherTransition.duration,
        0,
        1,
      ),
      active: weatherTransition.elapsed < weatherTransition.duration,
    };
  },
  setCameraPose(position, lookAt) {
    qaCameraPose = position && lookAt
      ? {
        position: new THREE.Vector3(position.x, position.y, position.z),
        lookAt: new THREE.Vector3(lookAt.x, lookAt.y, lookAt.z),
      }
      : null;
  },
  setRoamPose(position) {
    return setQaRoamPose(position);
  },
  runStreamingTour(options) {
    return runQaStreamingTour(options);
  },
  getStreamingEvidenceStops() {
    return getQaStreamingEvidenceStops();
  },
  setStreamingEvidenceStop(selector) {
    return setQaStreamingEvidenceStop(selector);
  },
  stopStreamingTour() {
    cancelQaStreamingTour();
    streaming.setQaPublicCorridorActive?.(false);
    return getQaRoamState();
  },
  getRoamState() {
    return getQaRoamState();
  },
  getInteractionState() {
    return getQaInteractionState();
  },
  get renderQuality() {
    return {
      ...getRenderQualitySnapshot(),
      pixelRatio: renderQuality.effectivePixelRatio,
    };
  },
  get elapsed() {
    return elapsed;
  },
  get lastFrame() {
    return lastFrame;
  },
};
