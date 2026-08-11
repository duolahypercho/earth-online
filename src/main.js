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
import { createTrafficSystem, createTrafficRulesHarness } from './traffic.js';
import { createPedestrianSystem, createSfpdOfficerResponse } from './pedestrians.js';
import { createSanFranciscoStreaming } from './streaming.js';
import { createStreamedAgentSystem } from './streamed-agents.js';
import { createSanFranciscoExpansion } from './sf-expansion.js';
import { SIGNAL_PERIOD } from './signals.js';
import { createCityShift, createStreetHeat, createCombatLoop } from './gameplay.js';
import { createHud } from './ui.js';
import {
  createPlayerAvatar,
  animatePlayerAvatar,
  setAvatarCombatPose,
  setAvatarVehiclePose,
  setAvatarSurrenderPose,
  setAvatarLook,
  registerPlayerHitReaction,
  applyPlayerHitReaction,
  getPlayerHitReactionTelemetry,
  createPlayerCameraImpulse,
} from './player.js';
import { createLifeSim } from './lifesim.js';
import { createNetworking } from './networking.js';
import { createCombatAudio, createEngineAudio, createWindAudio } from './audio.js';

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

// The action readout is deliberately a tiny DOM layer over the authored HUD:
// it stays pointer-transparent, only becomes visible after launch, and keeps
// the reticle/ammo/health feedback legible against both dark streets and the
// bright waterfront without changing the existing HUD layout.
const combatOverlay = document.createElement('section');
combatOverlay.className = 'combat-overlay';
combatOverlay.setAttribute('aria-label', 'On-foot action status');
combatOverlay.hidden = true;
Object.assign(combatOverlay.style, {
  position: 'fixed',
  inset: '0',
  zIndex: '14',
  pointerEvents: 'none',
  color: '#f5f0e7',
  fontFamily: 'var(--hud-mono, monospace)',
  opacity: '0',
  transition: 'opacity 180ms ease',
});
const combatReticle = document.createElement('div');
combatReticle.className = 'combat-reticle';
Object.assign(combatReticle.style, {
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: '38px',
  height: '38px',
  transform: 'translate(-50%, -50%)',
  border: '1px solid rgba(245,240,231,0.52)',
  borderRadius: '50%',
  boxSizing: 'border-box',
  transition: 'border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease',
});
const reticleDot = document.createElement('span');
Object.assign(reticleDot.style, {
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: '4px',
  height: '4px',
  transform: 'translate(-50%, -50%)',
  borderRadius: '50%',
  background: '#f2b56d',
  boxShadow: '0 0 12px #f2b56d',
});
combatReticle.append(reticleDot);
const combatHitConfirm = document.createElement('div');
Object.assign(combatHitConfirm.style, {
  position: 'absolute',
  left: '50%',
  top: 'calc(50% - 82px)',
  transform: 'translate(-50%, 0)',
  minWidth: '168px',
  padding: '6px 10px 5px',
  border: '1px solid rgba(107,214,197,0.8)',
  borderRadius: '4px',
  background: 'rgba(8,13,16,0.76)',
  color: '#6bd6c5',
  textAlign: 'center',
  letterSpacing: '0.13em',
  fontSize: '10px',
  fontWeight: '700',
  opacity: '0',
  transition: 'opacity 90ms ease, transform 120ms ease',
});
const combatHitLabel = document.createElement('strong');
combatHitLabel.style.display = 'block';
const combatHitTarget = document.createElement('span');
combatHitTarget.style.display = 'block';
combatHitTarget.style.marginTop = '2px';
combatHitTarget.style.color = '#f2b56d';
combatHitTarget.style.fontSize = '9px';
combatHitConfirm.append(combatHitLabel, combatHitTarget);
const combatReadout = document.createElement('div');
Object.assign(combatReadout.style, {
  position: 'absolute',
  right: '28px',
  bottom: '28px',
  minWidth: '176px',
  padding: '10px 12px',
  border: '1px solid rgba(245,240,231,0.2)',
  borderRadius: '6px',
  background: 'rgba(8,13,16,0.72)',
  boxShadow: '0 12px 28px rgba(0,0,0,0.24)',
  lineHeight: '1.25',
  letterSpacing: '0.08em',
  fontSize: '11px',
});
const combatModeLabel = document.createElement('strong');
combatModeLabel.style.display = 'block';
combatModeLabel.style.color = '#6bd6c5';
const combatAmmoLabel = document.createElement('span');
combatAmmoLabel.style.display = 'block';
const combatHealthLabel = document.createElement('span');
combatHealthLabel.style.display = 'block';
const combatHealthTrack = document.createElement('span');
Object.assign(combatHealthTrack.style, {
  display: 'block',
  height: '3px',
  marginTop: '7px',
  borderRadius: '3px',
  background: 'rgba(245,240,231,0.18)',
  overflow: 'hidden',
});
const combatHealthFill = document.createElement('span');
Object.assign(combatHealthFill.style, {
  display: 'block',
  width: '100%',
  height: '100%',
  background: '#6bd6c5',
  transition: 'width 120ms ease, background 120ms ease',
});
combatHealthTrack.append(combatHealthFill);
combatReadout.append(combatModeLabel, combatAmmoLabel, combatHealthLabel, combatHealthTrack);
combatOverlay.append(combatReticle, combatHitConfirm, combatReadout);
app?.append(combatOverlay);

function updateCombatOverlay(combatState) {
  if (!combatState) return;
  const combatPresentationAvailable = playerLayerActive
    && !controls.interiorMode
    && !beautyMode
    && !qaCameraPose;
  const visible = combatPresentationAvailable && (
    combatState.aiming
    || combatState.reloading
    || combatState.hitConfirm
    || combatState.status === 'downed'
  );
  combatOverlay.hidden = !visible;
  combatOverlay.style.opacity = visible ? '1' : '0';
  combatReticle.style.opacity = combatState.status === 'downed' ? '0.3' : '1';
  combatReticle.style.borderColor = combatState.hitConfirm
    ? '#6bd6c5'
    : combatState.aiming
      ? combatState.lockedTargetId ? '#ee806f' : '#f2b56d'
      : 'rgba(245,240,231,0.52)';
  combatReticle.style.boxShadow = combatState.hitConfirm
    ? '0 0 0 7px rgba(107,214,197,0.2), 0 0 18px rgba(107,214,197,0.6)'
    : 'none';
  combatReticle.style.transform = combatState.recoil > 0.04
    ? `translate(-50%, -50%) scale(${1 + combatState.recoil * 0.08})`
    : 'translate(-50%, -50%) scale(1)';
  combatModeLabel.textContent = combatState.status === 'downed'
    ? 'DOWN / RECOVERING'
    : combatState.aiming && traffic.isPlayerDriving?.()
      ? `DRIVE-BY / ${Math.round(traffic.getPlayerVehicleState?.()?.speed || 0)} KM/H`
      : combatState.aiming ? 'AIM / READY' : 'ON FOOT / READY';
  combatAmmoLabel.textContent = combatState.reloading
    ? `RELOAD / ${Math.ceil((1 - combatState.reloadProgress) * 1.18 * 10) / 10}s`
    : `AMMO / ${combatState.ammo} + ${combatState.reserveAmmo}`;
  combatHealthLabel.textContent = `HEALTH / ${Math.round(combatState.health)}`;
  combatHealthFill.style.width = `${Math.max(0, Math.min(100, combatState.health))}%`;
  combatHealthFill.style.background = combatState.damageFlash > 0 ? '#ee806f' : '#6bd6c5';
  combatHitConfirm.style.opacity = combatState.hitConfirm ? '1' : '0';
  combatHitConfirm.style.transform = combatState.hitConfirm
    ? 'translate(-50%, 0) scale(1)'
    : 'translate(-50%, -4px) scale(0.94)';
  combatHitLabel.textContent = combatState.hitConfirm ? 'HIT CONFIRMED' : '';
  combatHitTarget.textContent = combatState.hitConfirm
    ? `${String(combatState.hitLabel || combatState.lastHit?.kind || 'TARGET').toUpperCase()} / ${
      combatState.lastHit?.defeated ? 'DISABLED' : 'REACTING'
    }`
    : '';
}

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
sun.shadow.bias = -0.00016;
sun.shadow.normalBias = 0.032;
sun.shadow.radius = 2.2;
scene.add(sun, sun.target);

// Keep the sun direction stable while moving its finite shadow volume with
// the active district. The authored and streamed city lives kilometres from
// the origin, so a shadow camera left at (0, 0, 0) silently stops grounding
// the beach, towers, and traffic after a sector handoff.
const sunShadowFocus = new THREE.Vector3();
const sunShadowPositionOffset = new THREE.Vector3(-75, 82, 45);
const sunShadowTargetOffset = new THREE.Vector3(28, 3, 38);
let sunShadowFocusSector = null;
function updateSunShadowFocus(focus, sectorKey) {
  if (!focus?.isVector3) return;
  const sectorChanged = sunShadowFocusSector !== sectorKey;
  const movedEnough = sunShadowFocus.distanceToSquared(focus) >= 32 * 32;
  if (!sectorChanged && !movedEnough) return;
  sunShadowFocus.copy(focus);
  sun.position.copy(focus).add(sunShadowPositionOffset);
  sun.target.position.copy(focus).add(sunShadowTargetOffset);
  sun.updateMatrixWorld();
  sun.target.updateMatrixWorld();
  sunShadowFocusSector = sectorKey;
  renderer.shadowMap.needsUpdate = true;
}

const rim = new THREE.DirectionalLight(0x7ba9dc, 0.34);
rim.position.set(80, 50, -65);
scene.add(rim);

const nightFill = new THREE.PointLight(0xffb57f, 0, 64, 2);
nightFill.name = 'Street night fill';
nightFill.castShadow = false;
scene.add(nightFill);

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

const STATIC_BATCH_MIN_INSTANCES = 2;

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
    // sorting and frustum-testing thousands of tiny boxes every frame, while
    // the batch-level sphere still removes the whole core when the traveler
    // is looking across the streamed city.
    batch.frustumCulled = true;
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
    batch.computeBoundingSphere();

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
const proceduralSky = scene.getObjectByName('Procedural Pacific sky');
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
// Static batching freezes the authored city transforms, but the compact sky
// dome is deliberately camera-relative for streamed districts. Leave this
// shader-only background node live so its matrix follows the camera too.
if (proceduralSky) proceduralSky.matrixAutoUpdate = true;
const streaming = createSanFranciscoStreaming({
  scene,
  // Keep facade-grade geometry on the focused district plus a small visible
  // forward ring. The proxy ring preserves city-scale silhouettes, coarse
  // population, collision metadata, and handoffs without paying for eleven
  // simultaneously graded detail sectors during traversal.
  maxDetailed: 4,
  maxProxies: 24,
  prewarmPools: true,
  // The current hand-authored avenue is sector 0:0. Streaming tracks it as
  // externally owned and never hides, reparents, or disposes its objects.
  externalDetailedKeys: ['0:0'],
});
const expansion = createSanFranciscoExpansion({ streaming, scene });
const coreSignalPlans = city.roadNetwork.intersections.map((position, index) => ({
  id: `core:junction:${index}`,
  position,
  cycleSeconds: SIGNAL_PERIOD,
  signalized: true,
}));
const traffic = createTrafficSystem({
  scene,
  onPlayerTrafficViolation: (event) => handlePlayerTrafficViolation(event),
  onPlayerVehicleCollision: (event) => handlePlayerVehicleCollision(event),
  onPlayerOnFootVehicleContact: (event) => handlePlayerOnFootVehicleContact(event),
  canRepairPlayerVehicle: () => streetHeat?.getState?.().pursuitActive !== true,
  roadNetwork: {
    ...city.roadNetwork,
    roads: [...city.roadNetwork.roads, ...expansion.roadNetwork.roads],
    intersections: [...city.roadNetwork.intersections, ...expansion.roadNetwork.intersections],
    signalPlans: [...coreSignalPlans, ...expansion.roadNetwork.signalPlans],
  },
});
const pedestrians = createPedestrianSystem({
  scene,
  sidewalkNetwork: city.sidewalkNetwork,
  onPlayerCrowdContact: (event) => handlePlayerOnFootPedestrianContact(event),
});
const sfpdOfficers = createSfpdOfficerResponse({
  scene,
  getNearestWorldBlocker: getNearestCombatWorldBlocker,
  getSurfaceHeight: getTraversalSurfaceHeight,
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
  'uOpacity',
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

const PREWARM_TEXTURE_FIELDS = Object.freeze([
  'map',
  'alphaMap',
  'bumpMap',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'lightMap',
  'envMap',
]);

function sceneTexturesReadyForPrewarm() {
  let ready = true;
  scene.traverse((object) => {
    if (!ready) return;
    const materials = Array.isArray(object.material)
      ? object.material
      : object.material
        ? [object.material]
        : [];
    materials.forEach((material) => {
      if (!ready) return;
      PREWARM_TEXTURE_FIELDS.forEach((field) => {
        const texture = material?.[field];
        // Most materials intentionally omit optional maps. Only textures
        // that are actually attached to this material participate in the
        // startup gate; an absent normal/AO/light map is already ready.
        if (!texture?.isTexture) return;
        const image = texture?.image;
        const width = image?.width ?? image?.videoWidth ?? null;
        const height = image?.height ?? image?.videoHeight ?? null;
        if (image == null
          || image.complete === false
          || width === 0
          || height === 0) {
          ready = false;
        }
      });
    });
  });
  return ready;
}

let prewarmScheduled = false;

function prewarmRenderResourcesWhenReady() {
  // TextureLoader creates a null-image texture immediately and fills it on a
  // later browser task. Rendering the prewarm scene in that gap produces
  // WebGL warnings and needlessly warms incomplete texture state.
  if (!sceneTexturesReadyForPrewarm()) {
    window.setTimeout(prewarmRenderResourcesWhenReady, 80);
    return;
  }
  if (prewarmScheduled) return;
  prewarmScheduled = true;
  window.setTimeout(() => {
    prewarmScheduled = false;
    if (!sceneTexturesReadyForPrewarm()) {
      prewarmRenderResourcesWhenReady();
      return;
    }
    expansion.prewarmRenderResources?.(renderer, camera);
    registerWeatherVisuals();
    streaming.prewarmRenderResources?.(renderer, camera);
    freezeStaticTransforms(scene.getObjectByName('Enterable interiors staging wing'));
    scene.updateMatrixWorld(true);
    // Keep the scene root live: streamed sector groups and traffic are added or
    // repositioned after this one-time warmup. Static authored roots are
    // already frozen individually, so freezing the root would strand dynamic
    // children at their previous world matrices.
    // No dynamic actor casts into the directional atlas. Cache the authored city
    // shadow once, then request an explicit refresh only when interior visibility
    // changes instead of resubmitting the same depth scene every frame.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.toneMappingExposure = 1.04;
  }, 240);
}

prewarmRenderResourcesWhenReady();

// The first RAF can arrive before TextureLoader's image task completes. Keep
// the boot card over a cleared buffer until every material texture has usable
// image data; otherwise Three's renderer quite correctly warns while trying
// to upload a null-image texture. This is a startup gate only—the normal loop
// remains unchanged after the first valid draw.
let firstSceneFrameReady = false;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// A smaller AO target keeps contact shading visible around curbs and vehicles
// without making Cinematic pay full-resolution scene traversal and blur costs.
const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight, 16);
// SSAOPass' radius is expressed in view-space scene units. The former
// sub-unit radius was effectively invisible at this city scale even though
// the full pass cost was already being paid in Cinematic mode.
ssaoPass.kernelRadius = 1.52;
ssaoPass.minDistance = 0.0016;
ssaoPass.maxDistance = 0.21;
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
    uAtmosphere: { value: 0 },
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
    uniform float uAtmosphere;
    varying vec2 vUv;

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, mix(uSaturation, uSaturation * 1.04, uAtmosphere * 0.35));
      color = (color - 0.5) * mix(uContrast, uContrast * 0.98, uAtmosphere * 0.4) + 0.5;
      color += vec3(uWarmth * 1.25, uWarmth * 0.46, -uWarmth * 0.72);
      color = mix(color, color * vec3(0.94, 0.98, 1.04), uWetness * 0.22);
      color = mix(color, sqrt(max(color, 0.0)), uAtmosphere * 0.14);
      color = mix(color, color * (0.9 + luma * 0.18), uAtmosphere * 0.16);

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
    ssaoScale: 0.5,
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
  hitchStreak: 0,
  lowFpsWindows: 0,
  healthyFpsWindows: 0,
};
const performanceTelemetry = {
  sampleCapacity: 240,
  // `samples` measures the interval between presentation callbacks. Browsers
  // can add compositor/vsync jitter even when the app is idle, so keep the
  // application-owned frame work in a separate rolling window.
  samples: [],
  applicationSamples: [],
  frameCount: 0,
  lastFrameMs: null,
  lastApplicationFrameMs: null,
  lastSnapshotAt: 0,
};

// Opt-in stage timing for QA only. The normal experience does not pay for
// these timestamps; profiling runs use `?sf-profile=1` and read the rolling
// breakdown through `window.__SF_SIM__.getFrameProfile()`.
const frameProfileEnabled = new URLSearchParams(window.location.search).has('sf-profile');
const frameProfile = {
  frameCount: 0,
  totals: Object.create(null),
  maxima: Object.create(null),
};

function resetFrameProfile() {
  frameProfile.frameCount = 0;
  frameProfile.totals = Object.create(null);
  frameProfile.maxima = Object.create(null);
}

function recordFrameProfileStage(name, durationMs) {
  if (!frameProfileEnabled || !Number.isFinite(durationMs)) return;
  frameProfile.totals[name] = (frameProfile.totals[name] || 0) + durationMs;
  frameProfile.maxima[name] = Math.max(frameProfile.maxima[name] || 0, durationMs);
}

function getFrameProfile() {
  const stages = {};
  Object.keys(frameProfile.totals).forEach((name) => {
    const total = frameProfile.totals[name];
    stages[name] = {
      averageMs: frameProfile.frameCount ? total / frameProfile.frameCount : 0,
      maxMs: frameProfile.maxima[name] || 0,
      totalMs: total,
    };
  });
  return {
    enabled: frameProfileEnabled,
    frameCount: frameProfile.frameCount,
    stages,
  };
}

function resetPerformanceTelemetry() {
  performanceTelemetry.samples.length = 0;
  performanceTelemetry.applicationSamples.length = 0;
  performanceTelemetry.frameCount = 0;
  performanceTelemetry.lastFrameMs = null;
  performanceTelemetry.lastApplicationFrameMs = null;
  performanceTelemetry.lastSnapshotAt = 0;
  resetFrameProfile();
}

let postProcessingActive = false;
let hud;
let cityShift;
let streetHeat;
let combat;
let sfpdOfficerQaScenario = null;
let sfpdOfficerQaPressureDelay = 0;
let onFootVehicleImpactQaScenario = null;
let onFootPedestrianSpaceQaScenario = null;
const sfpdResponderDeploymentHolds = new Set();

function getSfpdPursuitResponders() {
  return sfpdOfficerQaScenario?.responders || traffic.getPursuitResponders?.() || [];
}

function clearSfpdResponderDeploymentHolds() {
  sfpdResponderDeploymentHolds.clear();
  traffic.setPursuitDeploymentHolds?.([]);
}

function updateSfpdResponderDeploymentHolds({ heatState, driving = false } = {}) {
  const responders = traffic.getPursuitResponders?.() || [];
  const eligible = heatState?.pursuitActive === true
    && heatState.level >= 2
    && !driving
    && playerLayerActive
    && !controls.interiorMode
    && !passengerRideActive()
    && !beautyMode
    && !sfpdOfficerQaScenario;
  if (!eligible) {
    clearSfpdResponderDeploymentHolds();
    return;
  }
  const responderIds = new Set(responders.map((responder) => responder.id));
  const officersByResponder = new Map(
    (sfpdOfficers.getState?.().officers || []).map((officer) => [officer.responderId, officer]),
  );
  for (const id of sfpdResponderDeploymentHolds) {
    const officer = officersByResponder.get(id);
    if (!responderIds.has(id) || officer?.live === false) {
      sfpdResponderDeploymentHolds.delete(id);
    }
  }
  for (const responder of responders) {
    if (!responder?.active || !Number.isFinite(responder.distance) || responder.distance > 24) continue;
    const officer = officersByResponder.get(responder.id);
    if (officer?.live === false) continue;
    sfpdResponderDeploymentHolds.add(responder.id);
  }
  traffic.setPursuitDeploymentHolds?.([...sfpdResponderDeploymentHolds]);
}

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
  // Default play keeps the city at frame budget by using the cheaper basic
  // shadow pass at half resolution. Cinematic is the only profile that pays
  // for the soft PCF 2048 shadow map.
  if (renderQuality.mode === 'cinematic') {
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    sun.shadow.mapSize.set(2048, 2048);
  } else {
    renderer.shadowMap.type = THREE.BasicShadowMap;
    sun.shadow.mapSize.set(1024, 1024);
  }
  if (sun.shadow.map) sun.shadow.map.needsUpdate = true;
  renderer.shadowMap.needsUpdate = true;
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
  renderQuality.hitchStreak = 0;
  renderQuality.lowFpsWindows = 0;
  renderQuality.healthyFpsWindows = 0;
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
  // A one-off traversal or first-use shader stall is not enough evidence to
  // lower the image quality. React to a sustained callback hitch instead;
  // the rolling FPS windows below cover slower but persistent pressure.
  renderQuality.hitchStreak = frameDelta >= 0.08
    ? renderQuality.hitchStreak + 1
    : 0;
  if (renderQuality.hitchStreak >= 2 && renderQuality.adjustmentCooldown <= 0) {
    const previousScale = renderQuality.autoScale;
    renderQuality.autoScale = Math.max(0.68, renderQuality.autoScale - 0.08);
    renderQuality.adjustmentCooldown = 1.25;
    renderQuality.sampleTime = 0;
    renderQuality.sampleFrames = 0;
    renderQuality.hitchStreak = 0;
    if (renderQuality.autoScale !== previousScale) applyRenderQuality();
    return;
  }
  if (renderQuality.sampleTime < 1.25) return;

  const fps = renderQuality.sampleFrames / renderQuality.sampleTime;
  renderQuality.lastFps = fps;
  const previousScale = renderQuality.autoScale;
  if (renderQuality.adjustmentCooldown <= 0) {
    // Use a broad dead band so a borderline display does not bounce between
    // two render sizes every sample window. Downshift in larger steps for a
    // quick recovery, then restore quality gradually once the frame budget is
    // comfortably healthy again.
    if (fps < 58) {
      renderQuality.lowFpsWindows += 1;
      renderQuality.healthyFpsWindows = 0;
      if (renderQuality.lowFpsWindows >= 1) {
        renderQuality.autoScale = Math.max(0.68, renderQuality.autoScale - 0.08);
        renderQuality.adjustmentCooldown = 1.75;
        renderQuality.lowFpsWindows = 0;
      }
    } else if (fps > 66) {
      renderQuality.healthyFpsWindows += 1;
      renderQuality.lowFpsWindows = 0;
      if (renderQuality.healthyFpsWindows >= 2) {
        renderQuality.autoScale = Math.min(1, renderQuality.autoScale + 0.025);
        renderQuality.adjustmentCooldown = 2.5;
        renderQuality.healthyFpsWindows = 0;
      }
    } else {
      renderQuality.lowFpsWindows = 0;
      renderQuality.healthyFpsWindows = 0;
    }
  }
  renderQuality.sampleTime = 0;
  renderQuality.sampleFrames = 0;

  if (renderQuality.autoScale !== previousScale) applyRenderQuality();
}

function recordPerformanceFrame(frameDelta, applicationFrameMs) {
  if (!Number.isFinite(frameDelta) || frameDelta <= 0) return;
  const frameMs = frameDelta * 1000;
  performanceTelemetry.lastFrameMs = frameMs;
  performanceTelemetry.frameCount += 1;
  performanceTelemetry.samples.push(frameMs);
  if (performanceTelemetry.samples.length > performanceTelemetry.sampleCapacity) {
    performanceTelemetry.samples.shift();
  }
  if (!Number.isFinite(applicationFrameMs) || applicationFrameMs < 0) return;
  performanceTelemetry.lastApplicationFrameMs = applicationFrameMs;
  performanceTelemetry.applicationSamples.push(applicationFrameMs);
  if (performanceTelemetry.applicationSamples.length > performanceTelemetry.sampleCapacity) {
    performanceTelemetry.applicationSamples.shift();
  }
}

function getPerformanceSnapshot() {
  const samples = [...performanceTelemetry.samples].sort((a, b) => a - b);
  const applicationSamples = [...performanceTelemetry.applicationSamples].sort((a, b) => a - b);
  const averageFrameMs = samples.length
    ? samples.reduce((sum, value) => sum + value, 0) / samples.length
    : null;
  const averageApplicationFrameMs = applicationSamples.length
    ? applicationSamples.reduce((sum, value) => sum + value, 0) / applicationSamples.length
    : null;
  const percentile = (ratio) => samples.length
    ? samples[Math.min(samples.length - 1, Math.floor(samples.length * ratio))]
    : null;
  const applicationPercentile = (ratio) => applicationSamples.length
    ? applicationSamples[Math.min(applicationSamples.length - 1, Math.floor(applicationSamples.length * ratio))]
    : null;
  const p99FrameMs = percentile(0.99);
  const applicationP99FrameMs = applicationPercentile(0.99);
  const maxFrameMs = samples.length ? samples[samples.length - 1] : null;
  const applicationMaxFrameMs = applicationSamples.length
    ? applicationSamples[applicationSamples.length - 1]
    : null;
  const memory = renderer.info.memory || {};
  const jsMemory = performance.memory && {
    usedBytes: performance.memory.usedJSHeapSize,
    totalBytes: performance.memory.totalJSHeapSize,
    limitBytes: performance.memory.jsHeapSizeLimit,
  };
  const streamingStats = streaming?.stats || null;
  return {
    targetFrameMs: 16.67,
    sampleCount: samples.length,
    frameCount: performanceTelemetry.frameCount,
    lastFrameMs: performanceTelemetry.lastFrameMs,
    averageFrameMs,
    p99FrameMs,
    maxFrameMs,
    onePercentLowFps: p99FrameMs ? 1000 / p99FrameMs : null,
    // The hard game budget is the application-owned work duration. The raw
    // callback cadence remains available below as an environment diagnostic.
    hardBudgetMet: applicationP99FrameMs != null && applicationP99FrameMs <= 16.67,
    applicationFrameCount: applicationSamples.length,
    lastApplicationFrameMs: performanceTelemetry.lastApplicationFrameMs,
    averageApplicationFrameMs,
    applicationP99FrameMs,
    applicationMaxFrameMs,
    applicationOnePercentLowFps: applicationP99FrameMs ? 1000 / applicationP99FrameMs : null,
    applicationHardBudgetMet: applicationP99FrameMs != null && applicationP99FrameMs <= 16.67,
    // The compositor can present at 60Hz with normal frame-interval jitter that
    // shows up as p99 slightly above 16.67ms. The application-owned budget is
    // the meaningful game target; this flag is a display-cadence diagnostic.
    presentedCadenceBudgetMet: p99FrameMs != null
      && p99FrameMs <= 19
      && averageFrameMs != null
      && averageFrameMs <= 16.75,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    points: renderer.info.render.points,
    lines: renderer.info.render.lines,
    gpuMemory: {
      geometries: memory.geometries ?? null,
      textures: memory.textures ?? null,
      rendererInfoOnly: true,
    },
    javascriptMemory: jsMemory || null,
    renderQuality: getRenderQualitySnapshot(),
    streaming: streamingStats
      ? {
        focusSector: streamingStats.focusSector,
        activeDetailed: streamingStats.activeDetailed,
        activeProxies: streamingStats.activeProxies,
        transitions: streamingStats.transitions,
        handoffs: streamingStats.handoffs,
      }
      : null,
    expansion: expansion?.getStats?.() ?? null,
    sampledAt: performance.now(),
  };
}

applyRenderQuality();
hud = createHud({
  renderer,
  camera,
  traffic,
  pedestrians,
  streamedAgents,
  streaming,
  expansion,
  city,
  quality: getRenderQualitySnapshot(),
  onQualityChange: setRenderQuality,
  onInteraction: () => {
    if (vehicleEmbodimentTransitionActive()) {
      vehicleEmbodimentState.duplicateEIgnored = true;
      return;
    }
    if (muniRideState?.active) {
      hud?.setMessage(`MUNI / ${String(muniRideState.phase || 'en-route').toUpperCase()} · ONE-STOP RIDE.`);
      return;
    }
    if (taxiRideState?.active) {
      hud?.setMessage(`TAXI / EN ROUTE · ${Math.ceil(Math.max(0, TAXI_RIDE_DURATION - taxiRideState.elapsed))}s.`);
      return;
    }
    if (traffic.isPlayerDriving?.()) {
      exitPlayerCar();
    } else if (controls.interiorMode) {
      performInteriorAction();
    } else {
      if (completeDeliveryRunAtPortal()) return;
      if (completeResidentFavorAtPortal()) return;
      const delivery = traffic.getNearestDeliveryService?.(controls.target, 3.8);
      if (delivery) {
        startDeliveryRunFromService(delivery);
        return;
      }
      const muni = traffic.getNearestTransitService?.(controls.target, 3.8, 2.8);
      if (muni) {
        startPlayerMuniRide(muni);
        return;
      }
      const taxi = traffic.getNearestTaxiService?.(controls.target, 3.8);
      if (taxi) {
        startPlayerTaxiRide(taxi);
        return;
      }
      const readyPortal = getInteractionPortal();
      if (readyPortal && readyPortal.distance <= readyPortal.radius) {
        enterNearestInterior();
      } else {
        const nearestCar = traffic.getNearestEnterableVehicle?.(controls.target, 3.8);
        if (nearestCar) {
          enterPlayerCar(nearestCar.index);
        } else if (talkToNearbyResident()) {
          return;
        } else {
          enterNearestInterior();
        }
      }
    }
  },
  onTouchMove: (code, pressed) => {
    if (taxiRideState?.active || muniRideState?.active) {
      controls.keys.delete(code.toLowerCase());
      return;
    }
    if (pressed) controls.keys.add(code.toLowerCase());
    else controls.keys.delete(code.toLowerCase());
  },
  onRestartGame: () => {
    clearPlayerVehicleEmbodiment();
    coopWaterfrontSession = null;
    networking?.leaveCoopSession?.();
    cityShift?.restart();
    hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
    hud?.setMessage('Waterfront Loop replayed · follow the amber beacon to the Welcome Center.');
    savePlayerProgress();
  },
});

let playerAvatar = null;
let playerBookingPoseUntil = 0;
// Inbound damage feedback v1: bounded camera kick + avatar hit-react driven
// by the authoritative combat loop; telemetry is read-only for QA gates.
const playerCameraImpulse = createPlayerCameraImpulse();
const playerAvatarPreviousPosition = new THREE.Vector3();
const playerAvatarFrameDisplacement = new THREE.Vector3();
const playerAvatarNextPosition = new THREE.Vector3();
let playerAvatarPositionReady = false;
const playerAvatarLocomotionState = {
  moving: false,
  facingYaw: 0,
  targetYaw: null,
  facingErrorRadians: null,
  displacementX: 0,
  displacementZ: 0,
  displacement: 0,
};
let lifeSim = null;
let networking = null;
let coopWaterfrontSession = null;
const rewardedCoopReceipts = new Set();
let audioContext = null;
let playerName = 'Traveler';
let drivingExitPose = null;
let playerLayerActive = false;
let engineAudio = null;
let windAudio = null;
let taxiRideState = null;
let muniRideState = null;
const combatAudio = createCombatAudio();
let lastVehicleDamageAt = null;
// The shared Traveler's lowest skinned shoe vertex sits within ~4 mm of its
// root; use the authoritative surface directly instead of floating the body by
// the legacy primitive-avatar offset.
const PLAYER_GROUND_OFFSET = 0;
const ON_FOOT_PLAYER_BODY_RADIUS = 1.05;
const ON_FOOT_PLAYER_CROWD_RADIUS = 0.72;
const PLAYER_FACING_DAMPING = 18;
const WALK_CAMERA_DISTANCE = 8.8;
const WALK_CAMERA_DISTANCE_MIN = 8;
const WALK_CAMERA_DISTANCE_MAX = 11;
const WALK_CAMERA_PITCH = 1.36;
const WALK_CAMERA_PITCH_MIN = 1.18;
const WALK_CAMERA_PITCH_MAX = 1.48;
const DRIVE_CAMERA_DISTANCE = 10.5;
const DRIVE_CAMERA_DISTANCE_MIN = 8.5;
const DRIVE_CAMERA_DISTANCE_MAX = 12;
const DRIVE_CAMERA_PITCH = 1.3;
const DRIVE_CAMERA_PITCH_MIN = 1.08;
const DRIVE_CAMERA_PITCH_MAX = 1.45;
const WALK_CAMERA_FOCUS_HEIGHT = 1.3;
const TRAVERSAL_CAMERA_TRANSITION_SECONDS = 0.42;
const PLAYER_PROGRESS_STORAGE_KEY = 'earth-online-player-progress-v1';
const PLAYER_PROGRESS_VERSION = 1;
const PLAYER_PROGRESS_AUTOSAVE_SECONDS = 1;
const VEHICLE_IMPOUND_RETRIEVAL_FEE = 45;
const VEHICLE_REGISTRATION_FEE = 60;
const TAXI_RIDE_FARE = 14;
const TAXI_RIDE_DURATION = 3.2;
const MUNI_RIDE_FARE = 3;
const TRAFFIC_CITATION_FINE = 18;
const TRAFFIC_CITATION_HEAT = 12;
const RECKLESS_COLLISION_HEAT = 10;
let progressSaveElapsed = 0;
let lastProgressSave = null;
let lastPublicWorldState = null;
let lastTrafficCitation = null;
let networkGameplayEventSequence = 0;
let latestNetworkGameplayEvent = null;
let networkMissionRevision = 0;
let networkMissionSignature = null;
const NETWORK_GAMEPLAY_EVENT_LIFETIME_MS = 4500;

function publishNetworkGameplayEvent({ kind, message } = {}) {
  if (!kind || !message) return null;
  const heatState = streetHeat?.getState?.() || {};
  networkGameplayEventSequence += 1;
  latestNetworkGameplayEvent = {
    id: `local-${Date.now().toString(36)}-${networkGameplayEventSequence}`,
    kind: String(kind),
    message: String(message).slice(0, 96),
    heat: Math.max(0, Math.min(100, Math.round(Number(heatState.heat) || 0))),
    wantedLevel: Math.max(0, Math.min(3, Math.round(Number(heatState.level) || 0))),
    expiresAt: performance.now() + NETWORK_GAMEPLAY_EVENT_LIFETIME_MS,
  };
  return latestNetworkGameplayEvent;
}

function readPlayerProgress() {
  try {
    const raw = window.localStorage?.getItem(PLAYER_PROGRESS_STORAGE_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    if (!snapshot || snapshot.version !== PLAYER_PROGRESS_VERSION) return null;
    if (!snapshot.life || !snapshot.cityShift) return null;
    return snapshot;
  } catch {
    try {
      window.localStorage?.removeItem(PLAYER_PROGRESS_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    return null;
  }
}

function savePlayerProgress() {
  if (!lifeSim?.exportState
    || !cityShift?.exportState
    || !combat?.exportState
    || !streetHeat?.exportState) return false;
  const snapshot = {
    version: PLAYER_PROGRESS_VERSION,
    savedAt: Date.now(),
    life: lifeSim.exportState(),
    cityShift: cityShift.exportState(),
    combat: combat.exportState(),
    streetHeat: streetHeat.exportState(),
    vehicle: traffic.exportPlayerVehicleState?.() ?? null,
    trafficAftermath: traffic.exportCollisionAftermathState?.() ?? null,
    pedestrianAftermath: pedestrians.exportCombatAftermathState?.() ?? null,
    garage: traffic.exportPlayerGarageState?.() ?? null,
    world: exportPlayerWorldState(),
  };
  try {
    window.localStorage?.setItem(PLAYER_PROGRESS_STORAGE_KEY, JSON.stringify(snapshot));
    lastProgressSave = { ok: true, savedAt: snapshot.savedAt };
    return true;
  } catch {
    lastProgressSave = { ok: false, savedAt: null };
    return false;
  }
}

function handlePlayerTrafficViolation(event) {
  if (event?.kind !== 'traffic-violation' || event.violation !== 'red-light') return false;
  const heatBefore = streetHeat?.getState?.().heat ?? 0;
  const heat = streetHeat?.reportIncident?.(TRAFFIC_CITATION_HEAT, {
    kind: 'traffic-violation',
    message: `RED LIGHT / citation $${TRAFFIC_CITATION_FINE} · heat +${TRAFFIC_CITATION_HEAT}.`,
    source: 'traffic-violation',
  });
  const transaction = lifeSim?.payTrafficCitation?.(
    TRAFFIC_CITATION_FINE,
    'Red-light citation',
  );
  if (!transaction) return false;
  lastTrafficCitation = {
    ...event,
    fine: TRAFFIC_CITATION_FINE,
    heatAdded: TRAFFIC_CITATION_HEAT,
    heatBefore,
    heatAfter: heat?.heat ?? heatBefore,
    transaction: { ...transaction },
  };
  hud?.setLifeState?.(lifeSim?.getState?.());
  hud?.setMessage(transaction.unpaid > 0
    ? `RED LIGHT / $${transaction.charged} paid · $${transaction.unpaid} unpaid · heat ${Math.round(heat?.heat ?? 0)}.`
    : `RED LIGHT / $${transaction.charged} citation paid · heat ${Math.round(heat?.heat ?? 0)}.`);
  savePlayerProgress();
  return true;
}

function handlePlayerVehicleCollision(event) {
  if (event?.kind === 'pursuit-contact' && event.playerDamage) {
    const contact = streetHeat?.reportVehicleResponderContact?.({
      responderId: event.responderId,
    });
    if (!contact) return false;
    lastVehicleDamageAt = event.playerDamage?.lastDamage?.at ?? lastVehicleDamageAt;
    savePlayerProgress();
    return {
      responderContact: true,
      contactNumber: contact.responderContacts,
    };
  }
  if (event?.kind !== 'reckless-collision' || !event.playerDamage || !event.victimDamage) {
    return false;
  }
  const heatBefore = streetHeat?.getState?.().heat ?? 0;
  const message = `RECKLESS COLLISION / ${event.victimLabel || 'vehicle'} struck · heat +${RECKLESS_COLLISION_HEAT}.`;
  const heat = streetHeat?.reportIncident?.(RECKLESS_COLLISION_HEAT, {
    kind: 'reckless-collision',
    message,
    source: 'reckless-collision',
  });
  lastVehicleDamageAt = event.playerDamage?.lastDamage?.at ?? lastVehicleDamageAt;
  hud?.setMessage(`${message} Integrity ${Math.round((event.playerDamage.ratio ?? 0) * 100)}%.`);
  savePlayerProgress();
  return {
    heatBefore,
    heatAfter: heat?.heat ?? heatBefore,
    heatAdded: RECKLESS_COLLISION_HEAT,
  };
}

function handlePlayerOnFootVehicleContact(event) {
  if (event?.kind !== 'on-foot-vehicle-contact'
    || !Number.isFinite(event.correctedPosition?.x)
    || !Number.isFinite(event.correctedPosition?.z)) return null;
  controls.target.x = event.correctedPosition.x;
  controls.target.z = event.correctedPosition.z;
  const collisionSafeTarget = streaming.resolveRoamPosition?.(controls.target);
  if (collisionSafeTarget && collisionSafeTarget !== controls.target) {
    controls.target.copy(collisionSafeTarget);
  }
  const surface = getTraversalSurfaceHeight(controls.target);
  if (Number.isFinite(surface)) controls.target.y = surface + QA_ROAM_CLEARANCE;
  let avatarSynchronized = false;
  if (playerAvatar?.visible
    && !controls.interiorMode
    && !traffic.isPlayerDriving?.()
    && !passengerRideActive()) {
    const avatarSurface = getTraversalSurfaceHeight(controls.target);
    const avatarGroundY = Number.isFinite(avatarSurface) ? avatarSurface : 0;
    playerAvatarNextPosition.set(
      controls.target.x,
      avatarGroundY + PLAYER_GROUND_OFFSET,
      controls.target.z,
    );
    playerAvatar.position.copy(playerAvatarNextPosition);
    playerAvatarPreviousPosition.copy(playerAvatarNextPosition);
    playerAvatar.updateMatrixWorld(true);
    avatarSynchronized = true;
  }
  const damaged = event.damaging === true
    && combat?.damagePlayer?.(event.damage, 'vehicle-impact') === true;
  if (damaged) {
    hud?.setMessage(
      `VEHICLE IMPACT / ${event.vehicleLabel || event.vehicleClass || 'traffic'} · -${Math.round(event.damage)} health.`,
    );
    savePlayerProgress();
  }
  return {
    blocked: true,
    damaged,
    avatarSynchronized,
    correctedPosition: { x: controls.target.x, z: controls.target.z },
    source: damaged ? 'vehicle-impact' : null,
    status: combat?.getState?.().status ?? null,
  };
}

function handlePlayerOnFootPedestrianContact(event) {
  if (event?.kind !== 'on-foot-pedestrian-contact'
    || !Number.isFinite(event.correctedPosition?.x)
    || !Number.isFinite(event.correctedPosition?.z)) return null;
  controls.target.x = event.correctedPosition.x;
  controls.target.z = event.correctedPosition.z;
  const collisionSafeTarget = streaming.resolveRoamPosition?.(controls.target);
  if (collisionSafeTarget && collisionSafeTarget !== controls.target) {
    controls.target.copy(collisionSafeTarget);
  }
  const surface = getTraversalSurfaceHeight(controls.target);
  if (Number.isFinite(surface)) controls.target.y = surface + QA_ROAM_CLEARANCE;
  let avatarSynchronized = false;
  if (playerAvatar?.visible
    && !controls.interiorMode
    && !traffic.isPlayerDriving?.()
    && !passengerRideActive()) {
    const avatarSurface = getTraversalSurfaceHeight(controls.target);
    const avatarGroundY = Number.isFinite(avatarSurface) ? avatarSurface : 0;
    playerAvatarNextPosition.set(
      controls.target.x,
      avatarGroundY + PLAYER_GROUND_OFFSET,
      controls.target.z,
    );
    playerAvatar.position.copy(playerAvatarNextPosition);
    playerAvatarPreviousPosition.copy(playerAvatarNextPosition);
    playerAvatar.updateMatrixWorld(true);
    avatarSynchronized = true;
  }
  return {
    blocked: true,
    avatarSynchronized,
    correctedPosition: { x: controls.target.x, z: controls.target.z },
  };
}

function restorePlayerProgress() {
  const snapshot = readPlayerProgress();
  if (!snapshot) return false;
  const previousLife = lifeSim?.exportState?.();
  const previousShift = cityShift?.exportState?.();
  const previousCombat = combat?.exportState?.();
  const previousStreetHeat = streetHeat?.exportState?.();
  const previousVehicle = traffic.exportPlayerVehicleState?.() ?? null;
  const previousTrafficAftermath = traffic.exportCollisionAftermathState?.() ?? null;
  const previousPedestrianAftermath = pedestrians.exportCombatAftermathState?.() ?? null;
  const previousGarage = traffic.exportPlayerGarageState?.() ?? null;
  const previousWorld = exportPlayerWorldState();
  const trafficAftermathSnapshot = snapshot.trafficAftermath ?? { version: 1, vehicles: [] };
  const pedestrianAftermathSnapshot = snapshot.pedestrianAftermath
    ?? { version: 1, residents: [] };
  const reservedVehicleIds = [
    snapshot.vehicle?.vehicleId,
    ...(Array.isArray(snapshot.garage?.slots)
      ? snapshot.garage.slots.map((slot) => slot?.vehicleId)
      : []),
  ].map((id) => Number(id)).filter((id) => Number.isInteger(id));
  const trafficAftermathValid = traffic.canImportCollisionAftermathState?.(
    trafficAftermathSnapshot,
    reservedVehicleIds,
  ) === true;
  const pedestrianAftermathValid = pedestrians.canImportCombatAftermathState?.(
    pedestrianAftermathSnapshot,
  ) === true;
  const lifeRestored = lifeSim?.importState?.(snapshot.life) === true;
  const shiftRestored = cityShift?.importState?.(snapshot.cityShift) === true;
  const combatRestored = snapshot.combat
    ? combat?.importState?.(snapshot.combat) === true
    : true;
  const streetHeatRestored = snapshot.streetHeat
    ? streetHeat?.importState?.(snapshot.streetHeat) === true
    : true;
  const worldRestored = snapshot.world
    ? importPlayerWorldState(snapshot.world)
    : true;
  const baseRestored = lifeRestored
    && shiftRestored
    && combatRestored
    && streetHeatRestored
    && worldRestored
    && trafficAftermathValid
    && pedestrianAftermathValid;
  const garageRestored = baseRestored && snapshot.garage
    ? traffic.importPlayerGarageState?.(snapshot.garage) === true
    : baseRestored;
  const vehicleRestored = garageRestored && snapshot.vehicle
    ? traffic.importPlayerVehicleState?.(snapshot.vehicle) === true
      && ((snapshot.vehicle.mode ?? 'driving') !== 'driving'
        || activatePlayerVehiclePresentation({ restored: true }) !== null)
    : garageRestored;
  const aftermathRestored = vehicleRestored
    ? traffic.importCollisionAftermathState?.(
      trafficAftermathSnapshot,
    ) === true
    : false;
  const pedestrianAftermathRestored = aftermathRestored
    ? pedestrians.importCombatAftermathState?.(pedestrianAftermathSnapshot) === true
    : false;
  if (baseRestored
    && garageRestored
    && vehicleRestored
    && aftermathRestored
    && pedestrianAftermathRestored) {
    lastProgressSave = { ok: true, savedAt: snapshot.savedAt || null, restored: true };
    return true;
  }
  if (previousLife) lifeSim?.importState?.(previousLife);
  if (previousShift) cityShift?.importState?.(previousShift);
  if (previousCombat) combat?.importState?.(previousCombat);
  if (previousStreetHeat) streetHeat?.importState?.(previousStreetHeat);
  if (previousWorld) importPlayerWorldState(previousWorld);
  if (previousGarage) traffic.importPlayerGarageState?.(previousGarage);
  if (previousVehicle && !traffic.isPlayerDriving?.()) {
    traffic.importPlayerVehicleState?.(previousVehicle);
    if ((previousVehicle.mode ?? 'driving') === 'driving') {
      activatePlayerVehiclePresentation({ restored: true });
    }
  }
  if (previousTrafficAftermath) {
    traffic.importCollisionAftermathState?.(previousTrafficAftermath);
  }
  if (previousPedestrianAftermath) {
    pedestrians.importCombatAftermathState?.(previousPedestrianAftermath);
  }
  return false;
}

function clearPlayerProgress() {
  try {
    window.localStorage?.removeItem(PLAYER_PROGRESS_STORAGE_KEY);
    lastProgressSave = null;
    return true;
  } catch {
    return false;
  }
}

lifeSim = createLifeSim({
  hud,
  city,
  traffic,
  pedestrians,
  onMessage: (message) => hud?.setMessage(message),
  getRestContext: () => getPlayerRestContext(),
  getMarketInteractionContext: () => getPlayerMarketInteractionContext(),
  getAmmoState: () => combat?.getState?.(),
  addReserveAmmo: (rounds) => combat?.addReserveAmmo?.(rounds),
});

hud.setOnlineAction((action) => {
  if (action && typeof action === 'object' && 'chat' in action) {
    networking?.sendChat(action.chat);
  } else {
    networking?.enableVoice?.();
  }
});

const controls = {
  target: new THREE.Vector3(28, 4, 38),
  focus: new THREE.Vector3(28, 4, 38),
  spherical: new THREE.Spherical(WALK_CAMERA_DISTANCE, WALK_CAMERA_PITCH, 0),
  yaw: 0,
  pitch: WALK_CAMERA_PITCH,
  distance: WALK_CAMERA_DISTANCE,
  cameraYaw: 0,
  cameraPitch: WALK_CAMERA_PITCH,
  cameraDistance: WALK_CAMERA_DISTANCE,
  pointerId: null,
  lastX: 0,
  lastY: 0,
  touchPoints: new Map(),
  pinchDistance: null,
  keys: new Set(),
  combatPointerId: null,
  combatTriggerPointerId: null,
  interiorMode: false,
  activePortal: null,
  exteriorSnapshot: null,
};
let traversalCameraMode = 'walk';
let traversalCameraTransitionRemaining = 0;

function exportPlayerWorldState() {
  const outdoor = playerLayerActive
    && !controls.interiorMode
    && traffic.isPlayerDriving?.() !== true;
  const orbitPitch = combatCameraState.active
    ? lastPublicWorldState?.pitch ?? combatCameraState.savedPitch
    : controls.pitch;
  const orbitDistance = combatCameraState.active
    ? lastPublicWorldState?.distance ?? combatCameraState.savedDistance
    : controls.distance;
  if (outdoor
    && Number.isFinite(controls.target.x)
    && Number.isFinite(controls.target.z)
    && Number.isFinite(controls.yaw)
    && Number.isFinite(orbitPitch)
    && Number.isFinite(orbitDistance)) {
    lastPublicWorldState = {
      mode: 'outdoor',
      x: controls.target.x,
      z: controls.target.z,
      yaw: THREE.MathUtils.euclideanModulo(controls.yaw + Math.PI, Math.PI * 2) - Math.PI,
      pitch: THREE.MathUtils.clamp(orbitPitch, 0.28, 2.45),
      distance: THREE.MathUtils.clamp(
        orbitDistance,
        WALK_CAMERA_DISTANCE_MIN,
        WALK_CAMERA_DISTANCE_MAX,
      ),
    };
  }
  return lastPublicWorldState ? { ...lastPublicWorldState } : null;
}

function importPlayerWorldState(snapshot) {
  if (!snapshot
    || snapshot.mode !== 'outdoor'
    || !Number.isFinite(snapshot.x)
    || !Number.isFinite(snapshot.z)
    || !Number.isFinite(snapshot.yaw)
    || !Number.isFinite(snapshot.pitch)
    || !Number.isFinite(snapshot.distance)
    || controls.interiorMode
    || traffic.isPlayerDriving?.() === true) {
    return false;
  }
  const surfaceHeight = getTraversalSurfaceHeight({ x: snapshot.x, z: snapshot.z });
  if (!Number.isFinite(surfaceHeight)) return false;
  const target = new THREE.Vector3(
    snapshot.x,
    surfaceHeight + QA_ROAM_CLEARANCE,
    snapshot.z,
  );
  const collisionSafeTarget = streaming.resolveRoamPosition?.(target) || target;
  const resolvedSurface = getTraversalSurfaceHeight(collisionSafeTarget);
  if (!Number.isFinite(resolvedSurface)) return false;
  collisionSafeTarget.y = resolvedSurface + QA_ROAM_CLEARANCE;
  controls.target.copy(collisionSafeTarget);
  controls.focus.copy(collisionSafeTarget);
  controls.yaw = THREE.MathUtils.euclideanModulo(snapshot.yaw + Math.PI, Math.PI * 2) - Math.PI;
  controls.pitch = THREE.MathUtils.clamp(
    snapshot.pitch,
    WALK_CAMERA_PITCH_MIN,
    WALK_CAMERA_PITCH_MAX,
  );
  controls.distance = THREE.MathUtils.clamp(
    snapshot.distance,
    WALK_CAMERA_DISTANCE_MIN,
    WALK_CAMERA_DISTANCE_MAX,
  );
  lastPublicWorldState = {
    mode: 'outdoor',
    x: controls.target.x,
    z: controls.target.z,
    yaw: controls.yaw,
    pitch: controls.pitch,
    distance: controls.distance,
  };
  snapCameraToControls();
  return true;
}

const combatCameraState = {
  active: false,
  justActivated: false,
  savedPitch: WALK_CAMERA_PITCH,
  savedDistance: WALK_CAMERA_DISTANCE,
  savedCameraPitch: WALK_CAMERA_PITCH,
  savedCameraDistance: WALK_CAMERA_DISTANCE,
};
const combatAimAnchor = new THREE.Vector3();
const combatAimPosition = new THREE.Vector3();
const combatAimLookTarget = new THREE.Vector3();
const combatGroundPosition = new THREE.Vector3();
const combatForward = new THREE.Vector3();
const combatRight = new THREE.Vector3();
const combatWeaponDirection = new THREE.Vector3();
const combatWeaponQuaternion = new THREE.Quaternion();
const combatWeaponParentQuaternion = new THREE.Quaternion();
const combatWeaponUp = new THREE.Vector3(0, 0, 1);
const combatWeaponMuzzleLocal = new THREE.Vector3(0, 0, 0.51);
const combatEmbodimentWorldA = new THREE.Vector3();
const combatEmbodimentWorldB = new THREE.Vector3();
const combatEmbodimentNdc = new THREE.Vector3();
const combatEmbodimentRay = new THREE.Vector3();
let playerWeapon = null;
let driveByRig = null;
const driveByState = {
  active: false,
  justActivated: false,
  aimYaw: 0,
  aimPitch: 0,
};
const driveByVehicleRight = new THREE.Vector3();
const driveByVehicleForward = new THREE.Vector3();
const driveByAimForward = new THREE.Vector3();
const driveByVisualWeaponDirection = new THREE.Vector3();
const driveByAimAnchor = new THREE.Vector3();
const driveByCameraPosition = new THREE.Vector3();
const driveByLookTarget = new THREE.Vector3();
const driveByMuzzleLocal = new THREE.Vector3(0, 0, 0.76);
const driveByWorldQuaternion = new THREE.Quaternion();
const driveByParentQuaternion = new THREE.Quaternion();
const driveByBox = new THREE.Box3();
const driveByScreenPoint = new THREE.Vector3();
const VEHICLE_EMBODIMENT_DURATION = 0.72;
const VEHICLE_EMBODIMENT_DOOR_ANGLE = 0.82;
const VEHICLE_EMBODIMENT_SAMPLE_LIMIT = 18;
const LOCAL_TRAVELER_ID = 'local-traveler';
const vehicleEmbodimentPosition = new THREE.Vector3();
const vehicleEmbodimentDoor = new THREE.Vector3();
const vehicleEmbodimentSeat = new THREE.Vector3();
const vehicleEmbodimentGround = new THREE.Vector3();
const vehicleEmbodimentStart = new THREE.Vector3();
const vehicleEmbodimentHip = new THREE.Vector3();
const vehicleEmbodimentRight = new THREE.Vector3();
const vehicleEmbodimentOrientation = new THREE.Quaternion();
const vehicleEmbodimentBox = new THREE.Box3();
const vehicleEmbodimentScreenPoint = new THREE.Vector3();
const vehicleEmbodimentCameraPrevious = new THREE.Vector3();
const vehicleEmbodimentState = {
  phase: 'grounded',
  elapsed: 0,
  duration: VEHICLE_EMBODIMENT_DURATION,
  startedAt: null,
  completedAt: null,
  replayed: false,
  duplicateEIgnored: false,
  vehicleId: null,
  vehicleClass: null,
  doorSide: 1,
  startPosition: new THREE.Vector3(),
  lastPose: null,
  sockets: null,
  samples: [],
  lastSampleProgress: -1,
  events: { theftIngressCount: 0 },
  cameraMaxStep: 0,
  cameraReady: false,
};

function vehicleEmbodimentTransitionActive() {
  return vehicleEmbodimentState.phase === 'entering'
    || vehicleEmbodimentState.phase === 'exiting';
}

function vehicleEmbodimentPhaseForQa() {
  if (vehicleEmbodimentState.phase === 'entering') return 'ingress';
  if (vehicleEmbodimentState.phase === 'exiting') return 'egress';
  return vehicleEmbodimentState.phase;
}

function vehicleRootForId(vehicleId) {
  return Number.isInteger(vehicleId) ? traffic.group?.children?.[vehicleId] ?? null : null;
}

function readVehicleEmbodimentPose(drivingState = null) {
  const state = drivingState?.index === vehicleEmbodimentState.vehicleId ? drivingState : null;
  const root = vehicleRootForId(vehicleEmbodimentState.vehicleId);
  const position = state?.position ?? root?.position ?? vehicleEmbodimentState.lastPose?.position;
  if (!position) return null;
  const pose = {
    position: {
      x: Number(position.x) || 0,
      y: Number(position.y) || 0,
      z: Number(position.z) || 0,
    },
    heading: Number.isFinite(state?.heading)
      ? state.heading
      : Number.isFinite(root?.rotation?.y) ? root.rotation.y : vehicleEmbodimentState.lastPose?.heading ?? 0,
    speed: Math.max(0, Number(state?.speed) || 0),
  };
  vehicleEmbodimentState.lastPose = pose;
  return pose;
}

function computeVehicleEmbodimentSockets(pose) {
  if (!pose) return null;
  const root = vehicleRootForId(vehicleEmbodimentState.vehicleId);
  const authored = root?.userData?.vehicleEmbodiment;
  const sideKey = vehicleEmbodimentState.doorSide < 0 ? 'left' : 'right';
  const authoredSeat = authored?.seats?.[sideKey];
  if (authoredSeat?.getWorldPosition) {
    root.updateWorldMatrix(true, true);
    authoredSeat.getWorldPosition(vehicleEmbodimentSeat);
    authoredSeat.getWorldQuaternion(vehicleEmbodimentOrientation);
  } else {
    const dimensions = vehiclePresentationDimensions(vehicleEmbodimentState.vehicleClass);
    vehicleEmbodimentRight.set(Math.cos(pose.heading), 0, -Math.sin(pose.heading));
    vehicleEmbodimentSeat.set(pose.position.x, pose.position.y + 0.08, pose.position.z)
      .addScaledVector(vehicleEmbodimentRight, vehicleEmbodimentState.doorSide * dimensions.halfWidth * 0.32);
    vehicleEmbodimentOrientation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, pose.heading);
  }
  vehicleEmbodimentRight.set(Math.cos(pose.heading), 0, -Math.sin(pose.heading));
  const dimensions = vehiclePresentationDimensions(vehicleEmbodimentState.vehicleClass);
  vehicleEmbodimentDoor.set(pose.position.x, pose.position.y, pose.position.z)
    .addScaledVector(
      vehicleEmbodimentRight,
      vehicleEmbodimentState.doorSide * (authored?.halfWidth ?? dimensions.halfWidth),
    );
  const doorSurface = getTraversalSurfaceHeight(vehicleEmbodimentDoor);
  vehicleEmbodimentDoor.y = (Number.isFinite(doorSurface) ? doorSurface : pose.position.y)
    + PLAYER_GROUND_OFFSET;
  vehicleEmbodimentGround.set(pose.position.x, pose.position.y, pose.position.z)
    .addScaledVector(
      vehicleEmbodimentRight,
      vehicleEmbodimentState.doorSide * (
        (authored?.halfWidth ?? dimensions.halfWidth) + ON_FOOT_PLAYER_BODY_RADIUS + 0.18
      ),
    );
  const groundSurface = getTraversalSurfaceHeight(vehicleEmbodimentGround);
  vehicleEmbodimentGround.y = (Number.isFinite(groundSurface) ? groundSurface : pose.position.y)
    + PLAYER_GROUND_OFFSET;
  return {
    seat: vehicleEmbodimentSeat.clone(),
    door: vehicleEmbodimentDoor.clone(),
    ground: vehicleEmbodimentGround.clone(),
    orientation: vehicleEmbodimentOrientation.clone(),
    surfaceY: Number.isFinite(groundSurface) ? groundSurface : pose.position.y,
  };
}

function setVehicleEmbodimentDoor(progress = 0) {
  const root = vehicleRootForId(vehicleEmbodimentState.vehicleId);
  const sideKey = vehicleEmbodimentState.doorSide < 0 ? 'left' : 'right';
  const authored = root?.userData?.vehicleEmbodiment;
  if (!authored?.doors) return 0;
  let selectedAngle = 0;
  for (const [key, door] of Object.entries(authored.doors)) {
    const active = key === sideKey;
    const angle = active ? VEHICLE_EMBODIMENT_DOOR_ANGLE * THREE.MathUtils.clamp(progress, 0, 1) : 0;
    door.pivot.rotation.y = angle * -door.side;
    door.pivot.userData.apertureAngle = angle;
    door.pivot.userData.traversal = angle / VEHICLE_EMBODIMENT_DOOR_ANGLE;
    door.aperture.visible = active && angle > 0.04;
    door.angle = angle;
    if (active) selectedAngle = angle;
  }
  root.updateWorldMatrix(true, true);
  return selectedAngle;
}

function beginVehicleEmbodimentPhase(phase, {
  vehicleId,
  vehicleClass,
  doorSide = 1,
  startPosition = null,
  pose = null,
  restored = false,
} = {}) {
  vehicleEmbodimentState.phase = restored ? 'seated' : phase;
  vehicleEmbodimentState.elapsed = restored ? VEHICLE_EMBODIMENT_DURATION : 0;
  vehicleEmbodimentState.startedAt = restored ? null : performance.now();
  vehicleEmbodimentState.completedAt = restored ? performance.now() : null;
  vehicleEmbodimentState.replayed = false;
  vehicleEmbodimentState.duplicateEIgnored = false;
  vehicleEmbodimentState.vehicleId = Number.isInteger(vehicleId) ? vehicleId : null;
  vehicleEmbodimentState.vehicleClass = vehicleClass ?? null;
  vehicleEmbodimentState.doorSide = doorSide < 0 ? -1 : 1;
  vehicleEmbodimentState.startPosition.copy(startPosition || playerAvatar?.position || controls.target);
  vehicleEmbodimentState.lastPose = pose ? {
    position: { ...pose.position },
    heading: Number(pose.heading) || 0,
    speed: Number(pose.speed) || 0,
  } : null;
  vehicleEmbodimentState.sockets = null;
  vehicleEmbodimentState.samples.length = 0;
  vehicleEmbodimentState.lastSampleProgress = -1;
  vehicleEmbodimentState.cameraMaxStep = 0;
  vehicleEmbodimentState.cameraReady = false;
  setVehicleEmbodimentDoor(0);
}

function clearPlayerVehicleEmbodiment({ keepVehicle = false } = {}) {
  setVehicleEmbodimentDoor(0);
  vehicleEmbodimentState.phase = 'grounded';
  vehicleEmbodimentState.elapsed = 0;
  vehicleEmbodimentState.startedAt = null;
  vehicleEmbodimentState.completedAt = performance.now();
  vehicleEmbodimentState.duplicateEIgnored = false;
  vehicleEmbodimentState.samples.length = 0;
  vehicleEmbodimentState.lastSampleProgress = -1;
  if (!keepVehicle) {
    vehicleEmbodimentState.vehicleId = null;
    vehicleEmbodimentState.vehicleClass = null;
    vehicleEmbodimentState.lastPose = null;
    vehicleEmbodimentState.sockets = null;
  }
  if (driveByRig) driveByRig.visible = false;
  driveByState.active = false;
  driveByState.justActivated = false;
}

function playerMoving() {
  return controls.keys.has('keyw')
    || controls.keys.has('keys')
    || controls.keys.has('keya')
    || controls.keys.has('keyd');
}

const COMBAT_WEAPON_MUZZLE_OFFSET = 0.51;
const COMBAT_WEAPON_SHOULDER_OFFSET = 0.36;
const COMBAT_WEAPON_HEIGHT = 1.55;
const COMBAT_SHOULDER_CAMERA_BACK = 6.2;
const COMBAT_SHOULDER_CAMERA_SIDE = -1.2;
const COMBAT_SHOULDER_LOOK_SIDE = 0;
const COMBAT_SHOULDER_CAMERA_HEIGHT = 2.62;
const COMBAT_SHOULDER_LOOK_HEIGHT = 1.35;
const COMBAT_SHOULDER_LOOK_DISTANCE = 24;
const COMBAT_SHOULDER_PITCH_SCALE = 4.6;

function createPlayerWeapon() {
  const handSocket = playerAvatar?.userData?.rightHand;
  if (!handSocket) return null;
  const root = new THREE.Group();
  root.name = 'Traveler hand-mounted low-poly sidearm';
  root.visible = false;
  root.frustumCulled = false;
  const gunMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8c5ca,
    roughness: 0.42,
    metalness: 0.78,
  });
  const gripMaterial = new THREE.MeshStandardMaterial({
    color: 0x222a2e,
    roughness: 0.58,
    metalness: 0.36,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: 0xffc86b,
    emissive: 0xd0672b,
    emissiveIntensity: 0.9,
    roughness: 0.34,
    metalness: 0.18,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.19, 0.52), gunMaterial);
  body.position.set(0, 0.015, 0.26);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.062, 0.34, 6), gripMaterial);
  barrel.rotation.x = Math.PI * 0.5;
  // Local tip is 0.51m from the root, matching COMBAT_WEAPON_MUZZLE_OFFSET.
  barrel.position.set(0, 0.005, 0.4);
  const barrelBand = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.06, 6), accentMaterial);
  barrelBand.rotation.x = Math.PI * 0.5;
  barrelBand.position.set(0, 0, 0.48);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.14), accentMaterial);
  sight.position.set(0, 0.145, 0.34);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.29, 0.16), gripMaterial);
  grip.position.set(0, -0.145, 0.14);
  grip.rotation.x = -0.16;
  root.add(body, barrel, barrelBand, sight, grip);
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = true;
    child.material.depthTest = true;
    child.material.depthWrite = true;
  });
  root.position.set(0, 0, 0.018);
  root.userData.handSocket = handSocket;
  root.userData.gripLocal = new THREE.Vector3(0, 0, 0);
  handSocket.add(root);
  return root;
}

function createDriveByRig() {
  const root = new THREE.Group();
  root.name = 'Traveler vehicle-window drive-by rig';
  root.visible = false;
  const sleeveMaterial = new THREE.MeshStandardMaterial({
    color: 0x5967a1,
    roughness: 0.78,
    metalness: 0.02,
  });
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: 0xe0aa7e,
    roughness: 0.72,
    metalness: 0.01,
  });
  const gunMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8c5ca,
    roughness: 0.42,
    metalness: 0.78,
  });
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x222a2e,
    roughness: 0.58,
    metalness: 0.36,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: 0xffc86b,
    emissive: 0xd0672b,
    emissiveIntensity: 0.85,
    roughness: 0.34,
    metalness: 0.18,
  });
  const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.24, 0.24), sleeveMaterial);
  upperArm.name = 'Drive-by upper arm';
  upperArm.position.set(-0.78, 1.18, 0.18);
  const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.2), sleeveMaterial);
  forearm.name = 'Drive-by forearm';
  forearm.position.set(-1.38, 1.2, 0.26);
  forearm.rotation.z = -0.12;
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.11, 7, 5), skinMaterial);
  hand.name = 'Drive-by hand socket';
  hand.position.set(-1.72, 1.2, 0.31);
  const weapon = new THREE.Group();
  weapon.name = 'Drive-by low-poly sidearm';
  weapon.position.copy(hand.position).add(new THREE.Vector3(0, 0.055, 0.035));
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.76), gunMaterial);
  body.position.set(0, 0.02, 0.38);
  const slideStripe = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.09, 0.54), accentMaterial);
  slideStripe.position.set(0, 0.185, 0.39);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.46, 6), darkMaterial);
  barrel.rotation.x = Math.PI * 0.5;
  barrel.position.set(0, 0.005, 0.57);
  const barrelBand = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.08, 6), accentMaterial);
  barrelBand.rotation.x = Math.PI * 0.5;
  barrelBand.position.set(0, 0, 0.72);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.24), accentMaterial);
  sight.position.set(0, 0.17, 0.46);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.4, 0.22), darkMaterial);
  grip.position.set(0, -0.22, 0.16);
  grip.rotation.x = -0.16;
  weapon.add(body, slideStripe, barrel, barrelBand, sight, grip);
  root.add(upperArm, forearm, hand, weapon);
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = true;
    child.frustumCulled = false;
  });
  root.userData.forearm = forearm;
  root.userData.upperArm = upperArm;
  root.userData.hand = hand;
  root.userData.weapon = weapon;
  root.userData.muzzleLocal = driveByMuzzleLocal;
  scene.add(root);
  return root;
}

function getTraversalSurfaceHeight(positionOrX, optionalZ) {
  const citySurface = city.getSurfaceHeight?.(positionOrX, optionalZ);
  if (Number.isFinite(citySurface)) return citySurface;
  const streamedSurface = streaming.getSurfaceHeight?.(positionOrX, optionalZ);
  return Number.isFinite(streamedSurface) ? streamedSurface : null;
}

function keepTraversalCameraAboveSurface(position, clearance = 0.42) {
  const surface = getTraversalSurfaceHeight(position);
  if (Number.isFinite(surface)) position.y = Math.max(position.y, surface + clearance);
  return position;
}

function resolveTraversalCameraFrame(focus, position, clearance = 0.42) {
  keepTraversalCameraAboveSurface(position, clearance);
  const citySafe = city.resolveCameraPosition?.(focus, position) || position;
  const streamedSafe = streaming.resolveCameraPosition?.(focus, citySafe) || citySafe;
  position.copy(streamedSafe);
  keepTraversalCameraAboveSurface(position, clearance);
  return position;
}

function getCombatGroundPosition(target = combatGroundPosition) {
  const drivingState = traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null;
  if (drivingState?.position) {
    target.set(drivingState.position.x, drivingState.position.y, drivingState.position.z);
    return target;
  }
  const surface = getTraversalSurfaceHeight(controls.target);
  const groundY = Number.isFinite(surface)
    ? surface
    : controls.target.y - QA_ROAM_CLEARANCE;
  target.set(controls.target.x, groundY, controls.target.z);
  return target;
}

function getCombatMuzzleOrigin(target, direction) {
  if (driveByRig?.visible && driveByRig.userData.weapon) {
    target.copy(driveByMuzzleLocal);
    driveByRig.userData.weapon.localToWorld(target);
    return true;
  }
  if (playerWeapon?.visible) {
    target.copy(combatWeaponMuzzleLocal);
    playerWeapon.localToWorld(target);
    return true;
  }
  getCombatGroundPosition(combatGroundPosition);
  combatForward.set(Math.sin(controls.yaw), 0, Math.cos(controls.yaw));
  combatRight.set(combatForward.z, 0, -combatForward.x);
  target.copy(combatGroundPosition)
    .addScaledVector(combatRight, COMBAT_WEAPON_SHOULDER_OFFSET)
    .y += COMBAT_WEAPON_HEIGHT;
  target.addScaledVector(direction, COMBAT_WEAPON_MUZZLE_OFFSET);
  return true;
}

function alignPlayerWeaponToCamera() {
  if (!playerWeapon?.visible) return;
  playerAvatar?.updateMatrixWorld?.(true);
  camera.getWorldDirection(combatWeaponDirection).normalize();
  combatWeaponQuaternion.setFromUnitVectors(combatWeaponUp, combatWeaponDirection);
  playerWeapon.parent?.getWorldQuaternion(combatWeaponParentQuaternion);
  combatWeaponParentQuaternion.invert();
  playerWeapon.quaternion.copy(combatWeaponParentQuaternion).multiply(combatWeaponQuaternion);
  playerWeapon.updateMatrixWorld(true);
}

function updatePlayerWeapon(combatState) {
  if (!playerWeapon) return;
  const drivingState = traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null;
  const vehicleAimAvailable = Boolean(drivingState && vehicleEmbodimentState.phase === 'seated');
  const visible = Boolean(
    combatState?.aiming
      && playerLayerActive
      && !controls.interiorMode
      && (!drivingState || vehicleAimAvailable)
      && !beautyMode
      && !qaCameraPose,
  );
  playerWeapon.visible = visible;
  if (playerAvatar?.userData?.nameTag) {
    playerAvatar.userData.nameTag.visible = !visible && combatState?.status !== 'downed';
  }
  if (!visible) return;
  // Keep the low-poly avatar's torso facing the same heading as the sidearm
  // while aiming, even when the player is standing still.
  if (playerAvatar && !drivingState) {
    setAvatarLook(playerAvatar, controls.yaw);
    playerAvatarLocomotionState.facingYaw = controls.yaw;
    setAvatarCombatPose(playerAvatar, {
      aiming: true,
      pitch: (combatCameraState.savedPitch - controls.pitch) * 0.6,
    });
  } else if (playerAvatar && drivingState) {
    // The post-traffic embodiment pass already applied the additive seated aim
    // pose once. This branch only solves the existing hand-mounted weapon.
    playerAvatar.updateMatrixWorld(true);
  }
  alignPlayerWeaponToCamera();
}

function projectCombatPoint(point, width, height) {
  combatEmbodimentNdc.copy(point).project(camera);
  return {
    x: (combatEmbodimentNdc.x * 0.5 + 0.5) * width,
    y: (-combatEmbodimentNdc.y * 0.5 + 0.5) * height,
    depth: combatEmbodimentNdc.z,
    visible: combatEmbodimentNdc.z >= -1 && combatEmbodimentNdc.z <= 1
      && combatEmbodimentNdc.x >= -1 && combatEmbodimentNdc.x <= 1
      && combatEmbodimentNdc.y >= -1 && combatEmbodimentNdc.y <= 1,
  };
}

function getCombatEmbodimentState() {
  const width = renderer.domElement.clientWidth || window.innerWidth || 1;
  const height = renderer.domElement.clientHeight || window.innerHeight || 1;
  const ud = playerAvatar?.userData;
  playerAvatar?.updateMatrixWorld?.(true);
  playerWeapon?.updateMatrixWorld?.(true);

  const partPoints = {};
  for (const [key, object] of Object.entries({
    head: ud?.head,
    torso: ud?.body,
    rightArm: ud?.rightArm,
    rightHand: ud?.rightHand,
  })) {
    if (!object?.getWorldPosition) continue;
    object.getWorldPosition(combatEmbodimentWorldA);
    partPoints[key] = projectCombatPoint(combatEmbodimentWorldA, width, height);
  }

  const silhouetteSamples = [];
  for (const object of [ud?.head, ud?.leftArm, ud?.rightArm, ud?.leftFoot, ud?.rightFoot]) {
    if (!object?.getWorldPosition) continue;
    object.getWorldPosition(combatEmbodimentWorldA);
    if (object === ud?.head) combatEmbodimentWorldA.y += 0.24;
    if (object === ud?.leftFoot || object === ud?.rightFoot) combatEmbodimentWorldA.y -= 0.1;
    silhouetteSamples.push(projectCombatPoint(combatEmbodimentWorldA, width, height));
  }
  const finiteSamples = silhouetteSamples.filter((sample) => (
    Number.isFinite(sample.x) && Number.isFinite(sample.y)
  ));
  const xs = finiteSamples.map((sample) => sample.x);
  const ys = finiteSamples.map((sample) => sample.y);
  const left = xs.length ? Math.min(...xs) : NaN;
  const right = xs.length ? Math.max(...xs) : NaN;
  const top = ys.length ? Math.min(...ys) : NaN;
  const bottom = ys.length ? Math.max(...ys) : NaN;

  const socket = ud?.rightHand;
  socket?.getWorldPosition?.(combatEmbodimentWorldA);
  playerWeapon?.getWorldPosition?.(combatEmbodimentWorldB);
  const gripSocketDistance = socket && playerWeapon
    ? combatEmbodimentWorldA.distanceTo(combatEmbodimentWorldB)
    : null;

  camera.getWorldDirection(combatEmbodimentRay).normalize();
  camera.getWorldPosition(combatEmbodimentWorldA);
  const convergence = {};
  for (const [key, distance] of [['near', 10], ['far', 30]]) {
    combatEmbodimentWorldB.copy(combatEmbodimentWorldA)
      .addScaledVector(combatEmbodimentRay, distance);
    const projected = projectCombatPoint(combatEmbodimentWorldB, width, height);
    convergence[key] = {
      distance,
      errorPx: Math.hypot(projected.x - width * 0.5, projected.y - height * 0.5),
    };
  }

  getCombatGroundPosition(combatGroundPosition);
  combatAimAnchor.set(
    combatGroundPosition.x,
    combatGroundPosition.y + 1.48,
    combatGroundPosition.z,
  );
  combatEmbodimentRay.copy(camera.position).sub(combatAimAnchor);
  const cameraDistance = combatEmbodimentRay.length();
  const blocker = cameraDistance > 1e-4
    ? getNearestCombatWorldBlocker(
      combatAimAnchor,
      combatEmbodimentRay.multiplyScalar(1 / cameraDistance),
      cameraDistance + 0.05,
    )
    : null;
  const insideVehicle = combatCameraVehicleClearance(camera.position) < 0.05;
  const cameraSurface = getTraversalSurfaceHeight(camera.position);
  const surfaceClearance = Number.isFinite(cameraSurface)
    ? camera.position.y - cameraSurface
    : null;
  const parts = {
    head: partPoints.head?.visible === true,
    torso: partPoints.torso?.visible === true,
    rightArm: partPoints.rightArm?.visible === true,
    rightHand: partPoints.rightHand?.visible === true,
  };
  const visiblePartCount = Object.values(parts).filter(Boolean).length;
  const weaponConnected = Boolean(socket && playerWeapon && playerWeapon.parent === socket);

  return {
    connected: Boolean(playerAvatar?.visible && weaponConnected && playerWeapon?.visible),
    avatar: {
      visible: Boolean(playerAvatar?.visible),
      screen: {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
        heightPx: bottom - top,
        centerX: (left + right) * 0.5,
        centerY: (top + bottom) * 0.5,
      },
      parts,
      visibilityRatio: visiblePartCount / 4,
    },
    weapon: {
      visible: Boolean(playerWeapon?.visible),
      connected: weaponConnected,
      gripSocketDistance,
    },
    reticle: { x: width * 0.5, y: height * 0.5 },
    convergence,
    camera: {
      collisionSafe: (!blocker || blocker.distance >= cameraDistance - 0.08)
        && (!Number.isFinite(surfaceClearance) || surfaceClearance >= 0.4)
        && !insideVehicle,
      insideBuilding: Boolean(blocker && blocker.distance < 0.2),
      insideVehicle,
      belowSurface: Number.isFinite(surfaceClearance) && surfaceClearance < 0.4,
      surface: cameraSurface,
      surfaceClearance,
      distance: cameraDistance,
    },
  };
}

function vehiclePresentationDimensions(vehicleClass) {
  return {
    halfWidth: vehicleClass === 'bus' || vehicleClass === 'truck' ? 1.55 : 1.15,
    halfLength: vehicleClass === 'bus' ? 5.2
      : vehicleClass === 'truck' ? 3.5
        : vehicleClass === 'van' || vehicleClass === 'suv' ? 2.7 : 2.45,
    roof: vehicleClass === 'bus' ? 3.1 : vehicleClass === 'truck' ? 2.5 : 1.9,
  };
}

function pointOutsideVehicleBody(point, drivingState, margin = 0) {
  if (!point || !drivingState?.position) return false;
  const heading = Number(drivingState.heading) || 0;
  const dx = point.x - drivingState.position.x;
  const dz = point.z - drivingState.position.z;
  const localX = dx * Math.cos(heading) - dz * Math.sin(heading);
  const localZ = dx * Math.sin(heading) + dz * Math.cos(heading);
  const localY = point.y - drivingState.position.y;
  const dimensions = vehiclePresentationDimensions(drivingState.class);
  return Math.abs(localX) >= dimensions.halfWidth + margin
    || Math.abs(localZ) >= dimensions.halfLength + margin
    || localY >= dimensions.roof + margin;
}

function pointOutsideVehicleWindow(point, drivingState, margin = 0.08) {
  if (!point || !drivingState?.position) return false;
  const halfWidth = drivingState.class === 'sedan' || drivingState.class === 'taxi' ? 0.925
    : drivingState.class === 'suv' ? 0.98
      : drivingState.class === 'pickup' ? 1.01
        : drivingState.class === 'van' ? 1 : vehiclePresentationDimensions(drivingState.class).halfWidth;
  const heading = Number(drivingState.heading) || 0;
  const dx = point.x - drivingState.position.x;
  const dz = point.z - drivingState.position.z;
  const localX = dx * Math.cos(heading) - dz * Math.sin(heading);
  return Math.abs(localX) >= halfWidth + margin;
}

function updateDriveByRig(combatState, drivingState) {
  const visible = Boolean(
    drivingState
      && combatState?.aiming
      && combatState?.status === 'running'
      && vehicleEmbodimentState.phase === 'seated'
      && playerLayerActive
      && !controls.interiorMode
      && !beautyMode
      && !qaCameraPose,
  );
  // The former disconnected arm/weapon prop remains detectable for regression
  // tooling but never renders. Drive-by presentation uses playerAvatar and its
  // existing right-hand playerWeapon exclusively.
  if (driveByRig) driveByRig.visible = false;
  driveByState.active = visible;
}

function updateDriveByCamera(dt, drivingState) {
  driveByAimForward.set(Math.sin(driveByState.aimYaw), 0, Math.cos(driveByState.aimYaw));
  driveByAimAnchor.set(
    drivingState.position.x,
    drivingState.position.y + 1.25,
    drivingState.position.z,
  );
  driveByCameraPosition.copy(driveByAimAnchor)
    .addScaledVector(driveByAimForward, -9);
  driveByVehicleRight.set(Math.cos(drivingState.heading), 0, -Math.sin(drivingState.heading));
  driveByVehicleForward.set(Math.sin(drivingState.heading), 0, Math.cos(drivingState.heading));
  const windowSide = driveByAimForward.dot(driveByVehicleRight) >= 0 ? 1 : -1;
  // Compose from the opposite rear quarter so the same-body shoulder, arm,
  // hand and sidearm read as one chain instead of collapsing along the view.
  driveByCameraPosition
    .addScaledVector(driveByVehicleForward, -3)
    .addScaledVector(driveByVehicleRight, -windowSide * 0.8);
  driveByCameraPosition.y = drivingState.position.y + 4.8;
  driveByLookTarget.copy(driveByAimAnchor)
    .addScaledVector(driveByAimForward, 24);
  driveByLookTarget.y += 0.4 + driveByState.aimPitch * 12;
  const citySafe = city.resolveCameraPosition?.(driveByAimAnchor, driveByCameraPosition)
    || driveByCameraPosition;
  const safeCamera = streaming.resolveCameraPosition?.(driveByAimAnchor, citySafe)
    || citySafe;
  if (driveByState.justActivated) camera.position.copy(safeCamera);
  else camera.position.lerp(safeCamera, 1 - Math.exp(-16 * dt));
  if (!pointOutsideVehicleBody(camera.position, drivingState, 0.35)) {
    camera.position.copy(safeCamera);
  }
  resolveTraversalCameraFrame(driveByAimAnchor, camera.position);
  camera.lookAt(driveByLookTarget);
  camera.updateMatrixWorld(true);
  controls.cameraDistance = camera.position.distanceTo(driveByAimAnchor);
  driveByState.justActivated = false;
  hud?.setCameraState({ mode: 'drive-by / shoulder', distance: controls.cameraDistance });
}

function getDriveByState() {
  const drivingState = traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null;
  const width = renderer.domElement.clientWidth || window.innerWidth || 1;
  const height = renderer.domElement.clientHeight || window.innerHeight || 1;
  const hand = playerAvatar?.userData?.rightHand;
  const weapon = playerWeapon;
  hand?.getWorldPosition?.(combatEmbodimentWorldA);
  weapon?.getWorldPosition?.(combatEmbodimentWorldB);
  const gripSocketDistance = hand && weapon
    ? combatEmbodimentWorldA.distanceTo(combatEmbodimentWorldB)
    : null;
  let muzzle = null;
  if (weapon) {
    combatEmbodimentWorldA.copy(combatWeaponMuzzleLocal);
    weapon.localToWorld(combatEmbodimentWorldA);
    muzzle = {
      x: combatEmbodimentWorldA.x,
      y: combatEmbodimentWorldA.y,
      z: combatEmbodimentWorldA.z,
    };
  }
  const vehicleRoot = drivingState ? traffic.group?.children?.[drivingState.index] : null;
  let vehicleScreen = null;
  if (vehicleRoot?.visible) {
    driveByBox.setFromObject(vehicleRoot);
    const points = [];
    for (const x of [driveByBox.min.x, driveByBox.max.x]) {
      for (const y of [driveByBox.min.y, driveByBox.max.y]) {
        for (const z of [driveByBox.min.z, driveByBox.max.z]) {
          driveByScreenPoint.set(x, y, z).project(camera);
          points.push({
            x: (driveByScreenPoint.x * 0.5 + 0.5) * width,
            y: (-driveByScreenPoint.y * 0.5 + 0.5) * height,
          });
        }
      }
    }
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    vehicleScreen = {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    };
    vehicleScreen.width = vehicleScreen.right - vehicleScreen.left;
    vehicleScreen.height = vehicleScreen.bottom - vehicleScreen.top;
    vehicleScreen.fullFrame = vehicleScreen.left >= 8
      && vehicleScreen.right <= width - 8
      && vehicleScreen.top >= 8
      && vehicleScreen.bottom <= height - 8;
  }
  const surface = getTraversalSurfaceHeight(camera.position);
  driveByAimAnchor.set(
    drivingState?.position?.x ?? controls.target.x,
    (drivingState?.position?.y ?? 0) + 1.25,
    drivingState?.position?.z ?? controls.target.z,
  );
  combatEmbodimentRay.copy(camera.position).sub(driveByAimAnchor);
  const cameraDistance = combatEmbodimentRay.length();
  const blocker = cameraDistance > 1e-4
    ? getNearestCombatWorldBlocker(
      driveByAimAnchor,
      combatEmbodimentRay.multiplyScalar(1 / cameraDistance),
      cameraDistance + 0.05,
    )
    : null;
  const surfaceClearance = Number.isFinite(surface) ? camera.position.y - surface : null;
  const insideVehicle = drivingState ? !pointOutsideVehicleBody(camera.position, drivingState) : false;
  return {
    active: driveByState.active,
    aiming: Boolean(combat?.getState?.().aiming && drivingState),
    avatarId: LOCAL_TRAVELER_ID,
    bodySource: 'player-avatar',
    bodyVisible: Boolean(playerAvatar?.visible),
    driverForearmVisible: Boolean(playerAvatar?.visible && playerAvatar.userData?.rightForearm?.visible !== false),
    weapon: {
      visible: Boolean(playerWeapon?.visible),
      connected: Boolean(weapon && weapon.parent === hand),
      parent: weapon?.parent === hand ? 'right-hand' : null,
      gripSocketDistance,
      gripDistance: gripSocketDistance,
    },
    muzzle: muzzle ? {
      ...muzzle,
      outsideVehicle: Boolean(drivingState && pointOutsideVehicleWindow(muzzle, drivingState)),
    } : null,
    reticle: { x: width * 0.5, y: height * 0.5 },
    vehicleScreen,
    camera: {
      collisionSafe: (!blocker || blocker.distance >= cameraDistance - 0.08)
        && (!Number.isFinite(surfaceClearance) || surfaceClearance >= 0.4)
        && !insideVehicle,
      insideWorld: Boolean(blocker && blocker.distance < 0.2),
      insideVehicle,
      surfaceClearance,
    },
  };
}

function startPlayerLayer() {
  const nameInput = document.querySelector('#player-name');
  playerName = nameInput?.value?.trim()?.slice(0, 18) || 'Traveler';
  if (!playerAvatar) {
    let paletteIndex = 0;
    for (let index = 0; index < playerName.length; index += 1) {
      paletteIndex += playerName.charCodeAt(index);
    }
    playerAvatar = createPlayerAvatar({
      name: playerName,
      paletteIndex: paletteIndex % 6,
      scale: 1,
    });
    playerAvatar.visible = false;
    scene.add(playerAvatar);
  }
  if (!playerWeapon) playerWeapon = createPlayerWeapon();
  if (!driveByRig) driveByRig = createDriveByRig();
  playerLayerActive = true;
  traversalCameraMode = 'walk';
  traversalCameraTransitionRemaining = 0;
  controls.distance = WALK_CAMERA_DISTANCE;
  controls.pitch = WALK_CAMERA_PITCH;
  snapCameraToControls();

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !audioContext) {
      audioContext = new AudioContextClass();
    }
    audioContext?.resume?.();
  } catch {
    audioContext = null;
  }

  if (!networking) {
    networking = createNetworking({
      scene,
      camera,
      traffic,
      hud,
      audioContext,
      getLocalState: getNetworkState,
      onChatMessage: (entry) => hud?.appendChat?.(entry),
      onPeerGameplayEvent: ({ peerId, peerName, event }) => {
        hud?.appendChat?.({
          name: peerName || 'Player',
          text: `INCIDENT · ${event?.message || 'Street activity reported.'}`,
          local: false,
          peerGameplayEvent: event?.id || null,
          peerGameplayPeer: peerId || null,
        });
      },
      onPeerGameplayEventClear: ({ peerId }) => hud?.clearPeerGameplayEvent?.(peerId),
      onCoopSessionChange: handleCoopSessionChange,
      onConnectionChange: () => {},
    });
  }
  networking?.setName(playerName);
  hud?.setLifeState?.(lifeSim?.getState());
}

function handleCoopSessionChange(nextSession, previousSession = coopWaterfrontSession) {
  const prior = previousSession || coopWaterfrontSession;
  coopWaterfrontSession = nextSession ? structuredClone(nextSession) : null;
  if (!nextSession) {
    if (prior?.sessionId && prior.status === 'running') {
      const failed = cityShift?.failCanonicalSession?.(
        prior.sessionId,
        'co-op-session-ended',
      );
      if (failed) {
        hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
        hud?.setMessage('CO-OP WATERFRONT LOOP ENDED / NO PAYOUT.');
        savePlayerProgress();
      }
    }
    return;
  }
  const applied = cityShift?.applyCanonicalProgress?.(nextSession);
  if (!applied) return;
  hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
  const members = Array.isArray(nextSession.members) ? nextSession.members.length : 1;
  if (applied.applied.length === 0) {
    hud?.setMessage(`CO-OP WATERFRONT LOOP / ${members}/2 PLAYERS · WAITING FOR ${
      String(nextSession.currentStepId || 'NEXT OBJECTIVE').replaceAll('-', ' ').toUpperCase()
    }.`);
  }
}

function getNetworkState() {
  const drivingState = traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null;
  const surface = getTraversalSurfaceHeight(controls.target);
  const groundY = Number.isFinite(surface) ? surface : 0;
  const position = drivingState
    ? drivingState.position
    : { x: controls.target.x, y: groundY + PLAYER_GROUND_OFFSET, z: controls.target.z };
  const yaw = drivingState ? drivingState.heading : controls.yaw;
  const mode = drivingState ? 'drive' : controls.interiorMode ? 'interior' : 'walk';
  const heatState = streetHeat?.getState?.() || {};
  const combatState = combat?.getState?.() || {};
  const health = Math.max(0, Math.min(100, Number(combatState.health) || 0));
  const healthBand = combatState.status === 'downed' || health <= 0
    ? 'downed'
    : health <= 30
      ? 'critical'
      : health < 75
        ? 'injured'
        : 'healthy';
  const activity = combatState.status === 'downed'
    ? 'downed'
    : heatState.pursuitActive
      ? 'pursuit'
      : combatState.aiming
        ? 'aiming'
        : drivingState
          ? 'driving'
          : playerMoving()
            ? 'walking'
            : heatState.heat > 0
              ? 'wanted'
              : lifeSim?.getState?.().workShift?.active
                ? 'working'
                : 'idle';
  if (latestNetworkGameplayEvent
    && (!heatState.lastEvent || heatState.lastEvent.kind !== latestNetworkGameplayEvent.kind)) {
    latestNetworkGameplayEvent = null;
  }
  const event = latestNetworkGameplayEvent
    && performance.now() <= latestNetworkGameplayEvent.expiresAt
    ? {
      id: latestNetworkGameplayEvent.id,
      kind: latestNetworkGameplayEvent.kind,
      message: latestNetworkGameplayEvent.message,
      heat: latestNetworkGameplayEvent.heat,
      wantedLevel: latestNetworkGameplayEvent.wantedLevel,
    }
    : null;
  const missionState = cityShift?.getState?.() || null;
  const missionSignature = missionState
    ? `${missionState.status}|${missionState.completedSteps}|${missionState.totalSteps}|${missionState.objective}`
    : null;
  if (missionSignature !== networkMissionSignature) {
    networkMissionSignature = missionSignature;
    networkMissionRevision += 1;
  }
  const mission = missionState
    && !(missionState.status === 'running' && missionState.completedSteps === 0)
    ? {
      revision: networkMissionRevision,
      status: missionState.status,
      completedSteps: missionState.completedSteps,
      totalSteps: missionState.totalSteps,
      objective: missionState.objective,
    }
    : null;
  const moveAxisX = (controls.keys.has('keyd') ? 1 : 0) - (controls.keys.has('keya') ? 1 : 0);
  const moveAxisZ = (controls.keys.has('keys') ? 1 : 0) - (controls.keys.has('keyw') ? 1 : 0);
  const moveLength = Math.hypot(moveAxisX, moveAxisZ);
  const normalizedX = moveLength > 0 ? moveAxisX / moveLength : 0;
  const normalizedZ = moveLength > 0 ? moveAxisZ / moveLength : 0;
  const forwardX = Math.sin(controls.yaw);
  const forwardZ = Math.cos(controls.yaw);
  const rightX = forwardZ;
  const rightZ = -forwardX;
  return {
    x: position.x,
    y: position.y,
    z: position.z,
    yaw,
    mode,
    moving: drivingState ? drivingState.speed > 0.5 : playerMoving(),
    vehicleId: drivingState?.index ?? null,
    vehicleClass: drivingState?.class ?? null,
    vehicleColor: drivingState?.color ?? null,
    coopMotion: {
      x: drivingState ? 0 : rightX * normalizedX + forwardX * normalizedZ,
      z: drivingState ? 0 : rightZ * normalizedX + forwardZ * normalizedZ,
      sprint: !drivingState
        && (controls.keys.has('shiftleft') || controls.keys.has('shiftright')),
    },
    gameplay: {
      heat: Math.max(0, Math.min(100, Math.round(Number(heatState.heat) || 0))),
      wantedLevel: Math.max(0, Math.min(3, Math.round(Number(heatState.level) || 0))),
      pursuitActive: heatState.pursuitActive === true,
      healthBand,
      activity,
      event,
    },
    mission,
  };
}

function enterPlayerCar(index) {
  if (vehicleEmbodimentTransitionActive()) {
    vehicleEmbodimentState.duplicateEIgnored = true;
    return false;
  }
  if (controls.interiorMode || traffic.isPlayerDriving?.() || index == null) return false;
  if (traffic.getImpoundedVehicleState?.()) {
    hud?.setMessage(`Retrieve your held vehicle at Ferry Building before taking another car · $${VEHICLE_IMPOUND_RETRIEVAL_FEE}.`);
    return false;
  }
  const entryStart = (playerAvatar?.visible ? playerAvatar.position : controls.target).clone();
  const entryRoot = vehicleRootForId(index);
  const entryHeading = Number(entryRoot?.rotation?.y) || 0;
  vehicleEmbodimentRight.set(Math.cos(entryHeading), 0, -Math.sin(entryHeading));
  const entrySide = entryRoot
    && vehicleEmbodimentStart.copy(entryStart).sub(entryRoot.position).dot(vehicleEmbodimentRight) < 0
    ? -1
    : 1;
  const entered = traffic.enterPlayerVehicle?.(index);
  if (!entered) return false;
  const theft = traffic.reportPlayerVehicleTheft?.();
  const theftHeat = theft?.reported
    ? streetHeat?.reportIncident?.(18, {
      kind: 'vehicle-theft',
      message: `Vehicle theft · ${theft.label} reported · heat +18.`,
      source: 'vehicle-theft',
    })
    : null;
  if (theft?.reported) vehicleEmbodimentState.events.theftIngressCount += 1;
  const state = activatePlayerVehiclePresentation({ entryStart, doorSide: entrySide });
  if (!state) return false;
  lastVehicleDamageAt = null;
  hud.setMessage(theft?.reported
    ? `Vehicle theft reported · heat ${theftHeat?.heat ?? 18} · W drive · E exit.`
    : theft?.reason === 'registered-owner'
      ? 'Registered vehicle · W accelerate · S brake · A/D steer · E exit.'
      : 'You got in. W accelerate · S brake · A/D steer · E exit.');
  return true;
}

function activatePlayerVehiclePresentation({ restored = false, entryStart = null, doorSide = 1 } = {}) {
  const state = traffic.getPlayerVehicleState?.();
  if (!state) return null;
  combat?.setAiming(false);
  combat?.setTriggerHeld(false);
  combat?.setEnabled(true);
  driveByState.active = false;
  driveByState.justActivated = false;
  driveByState.aimYaw = state.heading;
  driveByState.aimPitch = 0;
  beginVehicleEmbodimentPhase('entering', {
    vehicleId: state.index,
    vehicleClass: state.class,
    doorSide,
    startPosition: entryStart || playerAvatar?.position || controls.target,
    pose: state,
    restored,
  });
  lastVehicleDamageAt = state.damage?.lastDamage?.at ?? null;
  if (audioContext && !engineAudio) {
    try {
      audioContext.resume?.();
      engineAudio = createEngineAudio(audioContext);
      windAudio = createWindAudio(audioContext);
      engineAudio?.update(0, 0);
    } catch {
      engineAudio = null;
      windAudio = null;
    }
  }
  drivingExitPose = {
    pitch: controls.pitch,
    distance: controls.distance,
  };
  controls.target.set(state.position.x, state.position.y + 1.6, state.position.z);
  controls.yaw = state.heading + Math.PI;
  controls.pitch = DRIVE_CAMERA_PITCH;
  controls.distance = DRIVE_CAMERA_DISTANCE;
  if (restored) {
    traversalCameraMode = 'drive';
    traversalCameraTransitionRemaining = 0;
    snapCameraToControls();
  } else {
    beginTraversalCameraTransition('drive');
  }
  if (restored) hud?.setDriveState?.({ active: true, damage: state.damage });
  return state;
}

function exitPlayerCar() {
  if (vehicleEmbodimentTransitionActive()) {
    vehicleEmbodimentState.duplicateEIgnored = true;
    return false;
  }
  const priorState = traffic.getPlayerVehicleState?.();
  if (!priorState) return false;
  const exit = traffic.exitPlayerVehicle?.();
  if (!exit) return false;
  combat?.setAiming(false);
  combat?.setTriggerHeld(false);
  driveByState.active = false;
  driveByState.justActivated = false;
  if (driveByRig) driveByRig.visible = false;
  lastVehicleDamageAt = null;
  if (engineAudio) {
    engineAudio.stop();
    engineAudio = null;
  }
  if (windAudio) {
    windAudio.stop();
    windAudio = null;
  }
  const exitPose = {
    position: { x: exit.x, y: exit.y, z: exit.z },
    heading: exit.heading,
    speed: 0,
  };
  beginVehicleEmbodimentPhase('exiting', {
    vehicleId: priorState.index,
    vehicleClass: priorState.class,
    doorSide: vehicleEmbodimentState.doorSide,
    startPosition: playerAvatar?.position,
    pose: exitPose,
  });
  const exitSockets = computeVehicleEmbodimentSockets(exitPose);
  vehicleEmbodimentState.sockets = exitSockets;
  controls.target.set(
    exitSockets?.ground.x ?? exit.x,
    exitSockets?.surfaceY ?? exit.y,
    exitSockets?.ground.z ?? exit.z,
  );
  controls.yaw = exit.heading + Math.PI;
  controls.pitch = THREE.MathUtils.clamp(
    drivingExitPose?.pitch ?? WALK_CAMERA_PITCH,
    WALK_CAMERA_PITCH_MIN,
    WALK_CAMERA_PITCH_MAX,
  );
  controls.distance = THREE.MathUtils.clamp(
    drivingExitPose?.distance ?? WALK_CAMERA_DISTANCE,
    WALK_CAMERA_DISTANCE_MIN,
    WALK_CAMERA_DISTANCE_MAX,
  );
  drivingExitPose = null;
  beginTraversalCameraTransition('walk');
  combat?.setEnabled(true);
  hud.setMessage('You stepped back onto the avenue.');
  savePlayerProgress();
  return true;
}

function getPlayerVehicleRepairQuote() {
  const state = traffic.getPlayerVehicleState?.();
  const damage = state?.damage;
  if (!state || !damage) return null;
  const missing = Math.max(0, Number(damage.maxHealth) - Number(damage.health));
  const cost = missing > 0
    ? THREE.MathUtils.clamp(Math.ceil(8 + missing * 0.12), 12, 48)
    : 0;
  return {
    vehicleClass: state.class,
    missing: Math.round(missing * 10) / 10,
    cost,
    affordable: cost > 0 && lifeSim?.canAffordVehicleRepair?.(cost) === true,
  };
}

function repairCurrentPlayerVehicle(source = 'roadside-repair') {
  const quote = getPlayerVehicleRepairQuote();
  if (!quote || quote.cost <= 0) return { ok: false, reason: 'not-needed', quote };
  if (streetHeat?.getState?.().pursuitActive) {
    hud?.setMessage('REPAIR LOCKED / LOSE THE STREETHEAT TAIL OR SURRENDER.');
    return { ok: false, reason: 'pursuit-active', quote };
  }
  if (!quote.affordable) {
    lifeSim?.payVehicleRepair?.(quote.cost, quote.vehicleClass);
    return { ok: false, reason: 'insufficient-funds', quote };
  }
  const repair = traffic.repairPlayerVehicle?.(source) ?? null;
  if (!repair) return { ok: false, reason: 'unavailable', quote };
  if (!lifeSim?.payVehicleRepair?.(quote.cost, quote.vehicleClass)) {
    return { ok: false, reason: 'payment-failed', quote, repair };
  }
  hud?.setMessage(`Roadside repair complete · $${quote.cost} paid.`);
  return {
    ok: true,
    quote,
    repair,
    transaction: lifeSim?.getState?.().lastTransaction ?? null,
  };
}

function ferryImpoundContext() {
  return controls.interiorMode === true
    && String(controls.activePortal?.label || '').toLowerCase().includes('ferry building');
}

function retrieveImpoundedVehicleAtFerry() {
  const impounded = traffic.getImpoundedVehicleState?.();
  if (!impounded) return null;
  if (!ferryImpoundContext()) {
    hud?.setMessage(`Vehicle held at Ferry Building · enter the market hall, then press R · $${VEHICLE_IMPOUND_RETRIEVAL_FEE}.`);
    return false;
  }
  if (!lifeSim?.canAffordImpoundFee?.(VEHICLE_IMPOUND_RETRIEVAL_FEE)) {
    lifeSim?.payImpoundFee?.(VEHICLE_IMPOUND_RETRIEVAL_FEE, 'Ferry vehicle release');
    hud?.setLifeState?.(lifeSim?.getState?.());
    return false;
  }
  const previousLife = lifeSim?.exportState?.();
  const transaction = lifeSim?.payImpoundFee?.(
    VEHICLE_IMPOUND_RETRIEVAL_FEE,
    'Ferry vehicle release',
  );
  const pickup = controls.exteriorSnapshot?.target ?? controls.target;
  const retrieved = transaction
    ? traffic.retrieveImpoundedPlayerVehicle?.(pickup, controls.exteriorSnapshot?.yaw ?? 0)
    : null;
  if (!retrieved) {
    if (previousLife) lifeSim?.importState?.(previousLife);
    hud?.setLifeState?.(lifeSim?.getState?.());
    hud?.setMessage('Ferry vehicle release unavailable · no charge.');
    return false;
  }
  hud?.setLifeState?.(lifeSim?.getState?.());
  hud?.setMessage(`Vehicle released at Ferry pickup · $${VEHICLE_IMPOUND_RETRIEVAL_FEE} paid.`);
  savePlayerProgress();
  return true;
}

function settleLegalDebtAtFerry() {
  if (!ferryImpoundContext()) return null;
  const debt = Math.max(0, Math.round(Number(lifeSim?.getState?.().legalDebt) || 0));
  if (debt <= 0) return null;
  if (!lifeSim?.canAffordLegalDebt?.()) {
    lifeSim?.payLegalDebt?.('Ferry legal debt settlement');
    hud?.setLifeState?.(lifeSim?.getState?.());
    hud?.setMessage(`LEGAL DEBT / $${debt} due · earn cash before settlement.`);
    return false;
  }
  const transaction = lifeSim?.payLegalDebt?.('Ferry legal debt settlement');
  if (!transaction) return false;
  hud?.setLifeState?.(lifeSim?.getState?.());
  hud?.setMessage(`LEGAL DEBT CLEARED / $${transaction.debtBefore} paid.`);
  savePlayerProgress();
  return true;
}

function registerParkedVehicleAtFerry() {
  const registration = traffic.getPlayerVehicleRegistrationState?.();
  if (!registration) return null;
  if (!ferryImpoundContext()) return null;
  if (!registration.eligible) {
    hud?.setMessage('Only private vehicles can be registered at Ferry Building.');
    return false;
  }
  if (registration.registeredOwner) {
    hud?.setMessage('This vehicle is already registered to you.');
    return false;
  }
  const combatState = combat?.getState?.();
  if (combatState?.status !== 'running') {
    hud?.setMessage('Recover before using the Ferry registration desk.');
    return false;
  }
  if (streetHeat?.getState?.().pursuitActive) {
    hud?.setMessage('Lose the pursuit before registering a vehicle.');
    return false;
  }
  if (!lifeSim?.canAffordVehicleRegistration?.(VEHICLE_REGISTRATION_FEE)) {
    lifeSim?.payVehicleRegistration?.(
      VEHICLE_REGISTRATION_FEE,
      'Ferry vehicle registration',
    );
    hud?.setLifeState?.(lifeSim?.getState?.());
    return false;
  }
  const previousLife = lifeSim?.exportState?.();
  const transaction = lifeSim?.payVehicleRegistration?.(
    VEHICLE_REGISTRATION_FEE,
    'Ferry vehicle registration',
  );
  const registered = transaction
    ? traffic.registerParkedPlayerVehicle?.()
    : null;
  if (!registered) {
    if (previousLife) lifeSim?.importState?.(previousLife);
    hud?.setLifeState?.(lifeSim?.getState?.());
    hud?.setMessage('Ferry vehicle registration unavailable · no charge.');
    return false;
  }
  hud?.setLifeState?.(lifeSim?.getState?.());
  hud?.setMessage(`Vehicle registered · $${VEHICLE_REGISTRATION_FEE} paid · future entry is legal.`);
  savePlayerProgress();
  return true;
}

function handleFerryGarageAction() {
  if (!ferryImpoundContext()) return null;
  if (traffic.isPlayerDriving?.() || passengerRideActive()) {
    hud?.setMessage('Park and enter Ferry Building before using the garage.');
    return false;
  }
  if (traffic.getImpoundedVehicleState?.()) {
    hud?.setMessage('Resolve the Ferry impound hold before using the garage.');
    return false;
  }
  if (combat?.getState?.().status !== 'running') {
    hud?.setMessage('Recover before using the Ferry garage.');
    return false;
  }
  if (streetHeat?.getState?.().pursuitActive) {
    hud?.setMessage('Lose the pursuit before using the Ferry garage.');
    return false;
  }
  const parked = traffic.getPlayerVehicleRegistrationState?.();
  const garage = traffic.getPlayerGarageState?.();
  if (parked) {
    if (!parked.eligible || !parked.registeredOwner) {
      hud?.setMessage('Register this private vehicle before storing it.');
      return false;
    }
    if ((garage?.count ?? 0) >= (garage?.capacity ?? 2)) {
      hud?.setMessage('Ferry garage full · retrieve a vehicle before storing another.');
      return false;
    }
    const stored = traffic.storeParkedPlayerVehicleInGarage?.();
    if (!stored) {
      hud?.setMessage('Ferry garage storage unavailable.');
      return false;
    }
    hud?.setMessage(`Ferry garage · stored ${(stored.vehicle.class || 'vehicle').toUpperCase()} in slot ${stored.slot + 1}.`);
    savePlayerProgress();
    return true;
  }
  if (!garage?.count) {
    hud?.setMessage('Ferry garage empty · bring a registered vehicle to store.');
    return false;
  }
  const pickup = controls.exteriorSnapshot?.target ?? controls.target;
  const retrieved = traffic.retrievePlayerGarageVehicle?.(
    pickup,
    controls.exteriorSnapshot?.yaw ?? controls.yaw,
  );
  if (!retrieved) {
    hud?.setMessage('Ferry garage retrieval unavailable.');
    return false;
  }
  hud?.setMessage(`Ferry garage · slot ${retrieved.slot + 1} ready at curb.`);
  savePlayerProgress();
  return true;
}

function getTaxiDestination() {
  const portal = city?.portals?.find((entry) => (
    String(entry.label || '').toLowerCase().includes('ferry building market hall')
  ));
  if (!portal?.position) return null;
  return {
    label: portal.label,
    x: portal.position.x,
    z: portal.position.z,
  };
}

function getResidentFavorTarget(resident) {
  const portals = (city?.portals || [])
    .filter((portal) => (
      typeof portal?.id === 'string'
      && typeof portal?.label === 'string'
      && Number.isFinite(portal.position?.x)
      && Number.isFinite(portal.position?.z)
    ))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!portals.length) return null;
  const origin = resident?.position;
  const travelPortals = origin
    ? portals.filter((portal) => {
      const distance = Math.hypot(
        portal.position.x - origin.x,
        portal.position.z - origin.z,
      );
      return distance >= 35 && distance <= 520;
    })
    : portals;
  const candidates = travelPortals.length ? travelPortals : portals;
  let hash = 2166136261;
  for (const character of String(resident?.id || 'resident')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const portal = candidates[hash % candidates.length];
  return {
    id: portal.id,
    label: portal.label,
    x: portal.position.x,
    z: portal.position.z,
  };
}

function getDeliveryRunTarget(service) {
  const origin = service?.position;
  const streamedCandidates = origin
    ? [
      origin,
      { x: origin.x + 48, z: origin.z },
      { x: origin.x - 48, z: origin.z },
      { x: origin.x, z: origin.z + 48 },
      { x: origin.x, z: origin.z - 48 },
    ].map((probe) => streaming?.getNearestEnterablePortal?.(probe, 120))
      .filter(Boolean)
      .map((portal) => {
        const target = portal.approach ?? portal.position;
        return {
          portal,
          target,
          distance: target
            ? Math.hypot(target.x - origin.x, target.z - origin.z)
            : Infinity,
        };
      })
      .filter(({ portal, target, distance }) => (
        typeof portal.id === 'string'
        && typeof portal.label === 'string'
        && Number.isFinite(target?.x)
        && Number.isFinite(target?.z)
        && distance >= 16
        && distance <= 120
        && Math.abs(target.x - origin.x) >= 8
        && Math.abs(target.z - origin.z) >= 8
      ))
      .sort((a, b) => a.distance - b.distance || a.portal.id.localeCompare(b.portal.id))
    : [];
  const streamed = streamedCandidates[0];
  if (streamed) {
    return {
      id: streamed.portal.id,
      label: streamed.portal.label,
      x: streamed.target.x,
      z: streamed.target.z,
    };
  }
  const portals = (city?.portals || [])
    .filter((portal) => (
      typeof portal?.id === 'string'
      && typeof portal?.label === 'string'
      && Number.isFinite(portal.position?.x)
      && Number.isFinite(portal.position?.z)
    ))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!portals.length) return null;
  const travelPortals = origin
    ? portals.map((portal) => ({
      portal,
      distance: Math.hypot(
        portal.position.x - origin.x,
        portal.position.z - origin.z,
      ),
    })).filter(({ portal, distance }) => {
      const target = portal.approach ?? portal.position;
      return distance >= 16
        && distance <= 120
        && Math.abs(target.x - origin.x) >= 8
        && Math.abs(target.z - origin.z) >= 8;
    })
      .sort((a, b) => a.distance - b.distance || a.portal.id.localeCompare(b.portal.id))
    : [];
  const portal = travelPortals[0]?.portal;
  if (!portal) return null;
  return {
    id: portal.id,
    label: portal.label,
    x: portal.position.x,
    z: portal.position.z,
  };
}

function deliveryRunInputAvailable() {
  const combatState = combat?.getState?.();
  const heatState = streetHeat?.getState?.();
  return playerLayerActive
    && !controls.interiorMode
    && !traffic.isPlayerDriving?.()
    && !passengerRideActive()
    && !beautyMode
    && !qaCameraPose
    && combatState?.status === 'running'
    && combatState?.active === true
    && heatState?.pursuitActive !== true;
}

function completeDeliveryRunAtPortal() {
  const delivery = lifeSim?.getState?.().deliveryRun;
  if (!delivery?.active) return false;
  const portal = getInteractionPortal();
  if (!portal
    || portal.id !== delivery.target.id
    || portal.distance > portal.radius) return false;
  if (!deliveryRunInputAvailable()) {
    hud?.setMessage('Bay Parcel unavailable · recover and lose any StreetHeat tail first.');
    return true;
  }
  const completed = lifeSim?.completeDeliveryRun?.(portal.id);
  if (!completed) return true;
  hud?.setLifeState?.(lifeSim?.getState?.());
  savePlayerProgress();
  return true;
}

function startDeliveryRunFromService(candidate) {
  if (candidate?.index == null) return false;
  if (!deliveryRunInputAvailable()) {
    hud?.setMessage('Bay Parcel unavailable · be on foot, recovered, and clear of pursuit.');
    return true;
  }
  const lifeState = lifeSim?.getState?.();
  if (lifeState?.deliveryRun?.active) {
    hud?.setMessage(`BAY PARCEL ACTIVE · deliver to ${lifeState.deliveryRun.target.label}.`);
    return true;
  }
  if (lifeState?.workShift?.active || lifeState?.residentFavor?.active) {
    hud?.setMessage('Finish the active job before taking a Bay Parcel run.');
    return true;
  }
  if ((lifeState?.deliveryCooldownRemaining ?? 0) > 0) {
    hud?.setMessage(`Bay Parcel cooldown · ${Math.ceil(lifeState.deliveryCooldownRemaining)}s remaining.`);
    return true;
  }
  const target = getDeliveryRunTarget(candidate);
  if (!target) {
    hud?.setMessage('Bay Parcel unavailable · no delivery destination found.');
    return true;
  }
  const service = traffic.acceptDeliveryService?.(candidate.index);
  if (!service) return false;
  const started = lifeSim?.startDeliveryRun?.(service, target);
  hud?.setLifeState?.(lifeSim?.getState?.());
  if (started) savePlayerProgress();
  return true;
}

function residentFavorInputAvailable() {
  const combatState = combat?.getState?.();
  const heatState = streetHeat?.getState?.();
  return playerLayerActive
    && !controls.interiorMode
    && !traffic.isPlayerDriving?.()
    && !passengerRideActive()
    && !beautyMode
    && !qaCameraPose
    && combatState?.status === 'running'
    && combatState?.active === true
    && heatState?.pursuitActive !== true;
}

function talkToNearbyResident() {
  const resident = pedestrians?.getNearestPerson?.(
    controls.target,
    4.6,
    { includeDefeated: true },
  );
  if (!resident?.id) {
    hud?.setMessage('No one is close enough to talk to.');
    return false;
  }
  if (resident.combatDefeated) {
    hud?.setMessage('Resident unavailable · incapacitated after the street fight.');
    return true;
  }
  if (!residentFavorInputAvailable()) {
    hud?.setMessage('Resident chat unavailable · be on foot, recovered, and clear of pursuit.');
    return true;
  }
  const talked = lifeSim?.talkToNearestResident?.(controls.target, resident.id);
  hud?.setLifeState?.(lifeSim?.getState?.());
  if (talked) savePlayerProgress();
  return true;
}

function completeResidentFavorAtPortal() {
  const favor = lifeSim?.getState?.().residentFavor;
  if (!favor?.active) return false;
  const portal = getInteractionPortal();
  if (!portal
    || portal.id !== favor.target.id
    || portal.distance > portal.radius) return false;
  if (!residentFavorInputAvailable()) {
    hud?.setMessage('Resident favor unavailable · recover and lose any StreetHeat tail first.');
    return true;
  }
  const completed = lifeSim?.completeResidentFavor?.(portal.id);
  if (!completed) return true;
  hud?.setLifeState?.(lifeSim?.getState?.());
  savePlayerProgress();
  return true;
}

function startResidentFavorFromNearby() {
  const resident = pedestrians?.getNearestPerson?.(
    controls.target,
    4.6,
    { includeDefeated: true },
  );
  if (!resident?.id) return false;
  if (resident.combatDefeated) {
    hud?.setMessage('Resident unavailable · incapacitated after the street fight.');
    return true;
  }
  if (!residentFavorInputAvailable()) {
    hud?.setMessage('Resident favor unavailable · be on foot, recovered, and clear of pursuit.');
    return true;
  }
  const target = getResidentFavorTarget(resident);
  if (!target) {
    hud?.setMessage('Resident favor unavailable · no delivery destination found.');
    return true;
  }
  const started = lifeSim?.startResidentFavor?.(resident, target);
  hud?.setLifeState?.(lifeSim?.getState?.());
  if (started) savePlayerProgress();
  return true;
}

function passengerRideActive() {
  return taxiRideState?.active === true || muniRideState?.active === true;
}

function getPlayerTaxiRideState() {
  if (!taxiRideState?.active) return null;
  return {
    active: true,
    vehicleId: taxiRideState.vehicleId,
    class: taxiRideState.class,
    identity: taxiRideState.identity,
    fare: TAXI_RIDE_FARE,
    duration: TAXI_RIDE_DURATION,
    elapsed: taxiRideState.elapsed,
    remaining: Math.max(0, TAXI_RIDE_DURATION - taxiRideState.elapsed),
    destination: taxiRideState.destination.label,
  };
}

function getPlayerMuniRideState() {
  if (!muniRideState?.active) return null;
  const transit = traffic.getMuniRideState?.();
  return {
    active: true,
    vehicleId: muniRideState.vehicleId,
    class: muniRideState.class,
    identity: muniRideState.identity,
    fare: MUNI_RIDE_FARE,
    phase: transit?.phase ?? muniRideState.phase,
    elapsed: transit?.elapsed ?? muniRideState.elapsed,
    traveled: transit?.traveled ?? 0,
    road: transit?.road ?? null,
    position: transit?.position ?? null,
  };
}

function startPlayerMuniRide(candidate) {
  const combatState = combat?.getState?.();
  const heatState = streetHeat?.getState?.();
  const lifeState = lifeSim?.getState?.();
  if (candidate?.index != null && heatState?.pursuitActive) {
    hud?.setMessage('Muni unavailable · lose the StreetHeat tail first.');
    return false;
  }
  if (traffic.getImpoundedVehicleState?.()) {
    hud?.setMessage('Muni unavailable · resolve the Ferry impound hold first.');
    return false;
  }
  if (lifeState?.workShift?.active
    || lifeState?.residentFavor?.active
    || lifeState?.deliveryRun?.active) {
    hud?.setMessage('Finish the active job before boarding Muni.');
    return false;
  }
  const available = candidate?.index != null
    && !passengerRideActive()
    && playerLayerActive
    && !controls.interiorMode
    && !traffic.isPlayerDriving?.()
    && !playerMoving()
    && !beautyMode
    && !qaCameraPose
    && combatState?.status === 'running'
    && combatState?.active === true;
  if (!available) return false;
  if (!lifeSim?.canAffordMuniFare?.(MUNI_RIDE_FARE)) {
    lifeSim?.payMuniFare?.(MUNI_RIDE_FARE, 'Muni one-stop ride');
    hud?.setLifeState?.(lifeSim?.getState?.());
    return false;
  }
  const boarded = traffic.beginMuniRide?.(candidate.index);
  if (!boarded) return false;
  clearPlayerVehicleEmbodiment();
  controls.keys.clear();
  controls.combatPointerId = null;
  controls.combatTriggerPointerId = null;
  combat?.setAiming(false);
  combat?.setTriggerHeld(false);
  combat?.setEnabled(false);
  muniRideState = {
    active: true,
    vehicleId: boarded.vehicleId,
    class: boarded.class,
    identity: boarded.identity,
    phase: boarded.phase,
    elapsed: boarded.elapsed,
  };
  hud?.setMessage(`MUNI / ONE STOP · $${MUNI_RIDE_FARE} due on arrival.`);
  return true;
}

function updatePlayerMuniRide() {
  if (!muniRideState?.active) return null;
  const transit = traffic.getMuniRideState?.();
  if (!transit) {
    muniRideState = null;
    combat?.setEnabled(true);
    hud?.setMessage('Muni ride unavailable · no charge.');
    return null;
  }
  muniRideState.phase = transit.phase;
  muniRideState.elapsed = transit.elapsed;
  if (!transit.arrived) return getPlayerMuniRideState();
  const previousLife = lifeSim?.exportState?.();
  const transaction = lifeSim?.payMuniFare?.(MUNI_RIDE_FARE, 'Muni one-stop ride');
  const completed = transaction ? traffic.completeMuniRide?.() : null;
  if (!transaction || !completed) {
    if (previousLife) lifeSim?.importState?.(previousLife);
    traffic.cancelMuniRide?.();
    muniRideState = null;
    combat?.setEnabled(true);
    hud?.setLifeState?.(lifeSim?.getState?.());
    hud?.setMessage('Muni arrival unavailable · no charge.');
    return null;
  }
  const heading = Number(completed.heading) || 0;
  const exitX = completed.position.x + Math.cos(heading) * 3.1;
  const exitZ = completed.position.z - Math.sin(heading) * 3.1;
  const surface = getTraversalSurfaceHeight({ x: exitX, z: exitZ });
  controls.target.set(
    exitX,
    Number.isFinite(surface) ? surface + QA_ROAM_CLEARANCE : controls.target.y,
    exitZ,
  );
  controls.focus.copy(controls.target);
  controls.keys.clear();
  muniRideState = null;
  combat?.setEnabled(true);
  snapCameraToControls();
  hud?.setLifeState?.(lifeSim?.getState?.());
  hud?.setMessage(`MUNI ARRIVAL / ONE STOP · $${MUNI_RIDE_FARE} paid.`);
  savePlayerProgress();
  return {
    kind: 'muni-arrival',
    vehicle: completed,
    transaction,
  };
}

function startPlayerTaxiRide(candidate) {
  const combatState = combat?.getState?.();
  const heatState = streetHeat?.getState?.();
  if (candidate?.index != null && heatState?.pursuitActive) {
    hud?.setMessage('Taxi unavailable · lose the StreetHeat tail first.');
    return false;
  }
  const available = candidate?.index != null
    && !passengerRideActive()
    && playerLayerActive
    && !controls.interiorMode
    && !traffic.isPlayerDriving?.()
    && !playerMoving()
    && !beautyMode
    && !qaCameraPose
    && combatState?.status === 'running';
  if (!available) return false;
  if (!lifeSim?.canAffordTaxiFare?.(TAXI_RIDE_FARE)) {
    lifeSim?.payTaxiFare?.(TAXI_RIDE_FARE, 'Taxi to Ferry Building');
    hud?.setLifeState?.(lifeSim?.getState?.());
    return false;
  }
  const destination = getTaxiDestination();
  if (!destination) {
    hud?.setMessage('Taxi destination unavailable · no charge.');
    return false;
  }
  const boarded = traffic.beginTaxiRide?.(candidate.index);
  if (!boarded) return false;
  clearPlayerVehicleEmbodiment();
  controls.keys.clear();
  combat?.setEnabled(false);
  taxiRideState = {
    active: true,
    elapsed: 0,
    vehicleId: boarded.vehicleId,
    class: boarded.class,
    identity: boarded.identity,
    destination,
  };
  hud?.setMessage(`TAXI / FERRY BUILDING · $${TAXI_RIDE_FARE} due on arrival.`);
  return true;
}

function updatePlayerTaxiRide(dt) {
  if (!taxiRideState?.active || !Number.isFinite(dt) || dt <= 0) return null;
  taxiRideState.elapsed = Math.min(TAXI_RIDE_DURATION, taxiRideState.elapsed + dt);
  if (taxiRideState.elapsed < TAXI_RIDE_DURATION) return getPlayerTaxiRideState();
  const previousLife = lifeSim?.exportState?.();
  const destination = taxiRideState.destination;
  const transaction = lifeSim?.payTaxiFare?.(TAXI_RIDE_FARE, 'Taxi to Ferry Building');
  const completed = transaction ? traffic.completeTaxiRide?.() : null;
  if (!transaction || !completed) {
    if (previousLife) lifeSim?.importState?.(previousLife);
    traffic.cancelTaxiRide?.();
    taxiRideState = null;
    combat?.setEnabled(true);
    hud?.setLifeState?.(lifeSim?.getState?.());
    hud?.setMessage('Taxi ride unavailable · no charge.');
    return null;
  }
  const surface = getTraversalSurfaceHeight({ x: destination.x, z: destination.z });
  controls.target.set(
    destination.x,
    Number.isFinite(surface) ? surface + QA_ROAM_CLEARANCE : controls.target.y,
    destination.z,
  );
  controls.focus.copy(controls.target);
  controls.keys.clear();
  taxiRideState = null;
  combat?.setEnabled(true);
  snapCameraToControls();
  hud?.setLifeState?.(lifeSim?.getState?.());
  hud?.setMessage(`TAXI ARRIVAL / FERRY BUILDING · $${TAXI_RIDE_FARE} paid.`);
  savePlayerProgress();
  return {
    kind: 'taxi-arrival',
    vehicle: completed,
    transaction,
  };
}

function startPlayerWorkShift() {
  const combatState = combat?.getState?.();
  if (streetHeat?.getState?.().pursuitActive) {
    hud?.setMessage('Market shift unavailable · lose the StreetHeat tail or surrender.');
    return false;
  }
  const available = playerLayerActive
    && !controls.interiorMode
    && !traffic.isPlayerDriving?.()
    && !playerMoving()
    && !beautyMode
    && !qaCameraPose
    && combatState?.status === 'running';
  if (!available) {
    hud?.setMessage('Market shift unavailable · be on foot, still, and ready to work.');
    return false;
  }
  return lifeSim?.workShift?.() === true;
}

function buyPlayerMedkit() {
  const purchased = lifeSim?.buyMedkitAtMarket?.(controls.target) === true;
  hud?.setLifeState?.(lifeSim?.getState?.());
  if (purchased) savePlayerProgress();
  return purchased;
}

function eatPlayerAtMarket() {
  const ate = lifeSim?.eatAtMarket?.(controls.target) === true;
  hud?.setLifeState?.(lifeSim?.getState?.());
  if (ate) savePlayerProgress();
  return ate;
}

function buyPlayerAmmo() {
  if (!combatInputAvailable() || traffic.isPlayerDriving?.()) {
    hud?.setMessage('Buy ammunition on foot in the public realm.');
    return null;
  }
  const combatState = combat?.getState?.();
  if (!combatState || !combat?.addReserveAmmo) return null;
  if (combatState.status !== 'running' || combatState.active !== true) {
    hud?.setMessage('Restock ammunition after recovering.');
    return null;
  }
  const purchase = lifeSim?.buyAmmoAtMarket?.();
  if (!purchase) return null;
  const stock = purchase.stock;
  hud?.setLifeState?.(lifeSim?.getState?.());
  hud?.setMessage(`Ammunition purchased · +${stock.added} rounds · ${stock.reserveAmmo}/${stock.capacity} reserve.`);
  savePlayerProgress();
  return { purchase, stock };
}

function usePlayerMedkit() {
  const medkit = lifeSim?.getState?.().inventory?.medkit;
  if (!medkit || medkit.count <= 0) {
    lifeSim?.consumeMedkit?.();
    return { ok: false, reason: 'empty' };
  }
  if (!combatInputAvailable() || traffic.isPlayerDriving?.()) {
    hud?.setMessage('Use medkits on foot in the public realm.');
    return { ok: false, reason: 'unavailable' };
  }
  const before = combat?.getState?.();
  if (!before || before.status !== 'running' || before.health >= before.maxHealth) {
    hud?.setMessage('Health is already full.');
    return { ok: false, reason: 'full-health' };
  }
  if (!combat?.heal?.(medkit.heal)) {
    return { ok: false, reason: 'heal-failed' };
  }
  const consumed = lifeSim?.consumeMedkit?.();
  if (!consumed) return { ok: false, reason: 'consume-failed' };
  const after = combat.getState();
  hud?.setLifeState?.(lifeSim?.getState?.());
  hud?.setMessage(`Medkit used · health ${Math.round(after.health)} · ${consumed.remaining} left.`);
  return { ok: true, before, after, consumed };
}

function resetPlayerLocomotionFacing(position = null) {
  playerAvatarPositionReady = Boolean(position);
  if (position) playerAvatarPreviousPosition.copy(position);
  playerAvatarFrameDisplacement.set(0, 0, 0);
  playerAvatarLocomotionState.moving = false;
  playerAvatarLocomotionState.targetYaw = null;
  playerAvatarLocomotionState.facingErrorRadians = null;
  playerAvatarLocomotionState.displacementX = 0;
  playerAvatarLocomotionState.displacementZ = 0;
  playerAvatarLocomotionState.displacement = 0;
}

function updatePlayerLocomotionFacing(dt, position) {
  if (!playerAvatar || !position) return;
  if (!playerAvatarPositionReady) {
    resetPlayerLocomotionFacing(position);
    playerAvatarLocomotionState.facingYaw = playerAvatar.userData?.rig?.rotation?.y || 0;
    return;
  }
  playerAvatarFrameDisplacement.copy(position).sub(playerAvatarPreviousPosition);
  playerAvatarFrameDisplacement.y = 0;
  playerAvatarPreviousPosition.copy(position);
  const displacement = playerAvatarFrameDisplacement.length();
  const validMovement = displacement > 0.0005 && displacement < 1.2;
  playerAvatarLocomotionState.moving = validMovement;
  playerAvatarLocomotionState.displacementX = playerAvatarFrameDisplacement.x;
  playerAvatarLocomotionState.displacementZ = playerAvatarFrameDisplacement.z;
  playerAvatarLocomotionState.displacement = displacement;
  if (!validMovement) {
    playerAvatarLocomotionState.targetYaw = null;
    playerAvatarLocomotionState.facingErrorRadians = null;
    setAvatarLook(playerAvatar, playerAvatarLocomotionState.facingYaw);
    return;
  }
  const targetYaw = Math.atan2(
    playerAvatarFrameDisplacement.x,
    playerAvatarFrameDisplacement.z,
  );
  const currentYaw = playerAvatarLocomotionState.facingYaw;
  const facingYaw = dampAngle(currentYaw, targetYaw, PLAYER_FACING_DAMPING, dt);
  setAvatarLook(playerAvatar, facingYaw);
  playerAvatarLocomotionState.targetYaw = targetYaw;
  playerAvatarLocomotionState.facingYaw = facingYaw;
  playerAvatarLocomotionState.facingErrorRadians = Math.abs(
    THREE.MathUtils.euclideanModulo(targetYaw - facingYaw + Math.PI, Math.PI * 2) - Math.PI,
  );
}

function smoothVehicleEmbodimentStep(value) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function updatePlayerVehicleEmbodiment(dt, animationElapsed, drivingState = null) {
  const phase = vehicleEmbodimentState.phase;
  if (!['entering', 'seated', 'exiting'].includes(phase) || !playerAvatar) return false;
  const pose = readVehicleEmbodimentPose(drivingState);
  if (!pose) {
    clearPlayerVehicleEmbodiment();
    return false;
  }
  if (phase !== 'seated') {
    vehicleEmbodimentState.elapsed = Math.min(
      vehicleEmbodimentState.duration,
      vehicleEmbodimentState.elapsed + Math.max(0, Number(dt) || 0),
    );
  }
  const progress = phase === 'seated'
    ? 1
    : THREE.MathUtils.clamp(
      vehicleEmbodimentState.elapsed / vehicleEmbodimentState.duration,
      0,
      1,
    );
  const sockets = computeVehicleEmbodimentSockets(pose);
  if (!sockets) return false;
  vehicleEmbodimentState.sockets = sockets;

  let seatedBlend = 1;
  let doorOpen = 0;
  if (phase === 'entering') {
    const toDoor = smoothVehicleEmbodimentStep(progress / 0.44);
    if (progress < 0.44) {
      vehicleEmbodimentPosition.copy(vehicleEmbodimentState.startPosition).lerp(sockets.door, toDoor);
    } else {
      vehicleEmbodimentPosition.copy(sockets.door).lerp(
        sockets.seat,
        smoothVehicleEmbodimentStep((progress - 0.44) / 0.56),
      );
    }
    seatedBlend = smoothVehicleEmbodimentStep((progress - 0.28) / 0.62);
    doorOpen = progress < 0.12
      ? smoothVehicleEmbodimentStep(progress / 0.12)
      : progress > 0.82
        ? 1 - smoothVehicleEmbodimentStep((progress - 0.82) / 0.18)
        : 1;
  } else if (phase === 'exiting') {
    if (progress < 0.56) {
      vehicleEmbodimentPosition.copy(sockets.seat).lerp(
        sockets.door,
        smoothVehicleEmbodimentStep(progress / 0.56),
      );
    } else {
      vehicleEmbodimentPosition.copy(sockets.door).lerp(
        sockets.ground,
        smoothVehicleEmbodimentStep((progress - 0.56) / 0.44),
      );
    }
    seatedBlend = 1 - smoothVehicleEmbodimentStep((progress - 0.18) / 0.68);
    doorOpen = progress < 0.14
      ? smoothVehicleEmbodimentStep(progress / 0.14)
      : progress > 0.84
        ? 1 - smoothVehicleEmbodimentStep((progress - 0.84) / 0.16)
        : 1;
  } else {
    vehicleEmbodimentPosition.copy(sockets.seat);
    doorOpen = 0;
  }
  const doorAngle = setVehicleEmbodimentDoor(doorOpen);
  const hiddenForPresentation = controls.interiorMode
    || passengerRideActive()
    || beautyMode
    || Boolean(qaCameraPose);
  playerAvatar.visible = playerLayerActive && !hiddenForPresentation;
  if (playerAvatar.visible) {
    playerAvatar.position.copy(vehicleEmbodimentPosition);
    playerAvatar.quaternion.copy(sockets.orientation);
    animatePlayerAvatar(playerAvatar, {
      moving: false,
      speedRatio: 0,
      elapsed: animationElapsed,
      delta: Math.max(0, Number(dt) || 0),
    });
    setAvatarLook(playerAvatar, 0);
    const aiming = phase === 'seated' && combat?.getState?.().aiming === true;
    camera.getWorldDirection(combatWeaponDirection).normalize();
    vehicleEmbodimentRight.set(Math.cos(pose.heading), 0, -Math.sin(pose.heading));
    const windowSide = combatWeaponDirection.dot(vehicleEmbodimentRight) >= 0 ? 1 : -1;
    setAvatarVehiclePose(playerAvatar, {
      seatedBlend,
      transitionBlend: phase === 'seated' ? 0 : Math.sin(progress * Math.PI),
      steering: (controls.keys.has('keyd') ? 1 : 0) - (controls.keys.has('keya') ? 1 : 0),
      aiming,
      windowSide,
      aimPitch: driveByState.aimPitch,
    });
    const hips = playerAvatar.getObjectByName?.('Hips');
    if (hips?.getWorldPosition && seatedBlend > 0) {
      playerAvatar.updateMatrixWorld(true);
      hips.getWorldPosition(vehicleEmbodimentHip);
      playerAvatar.position.addScaledVector(
        vehicleEmbodimentSeat.copy(sockets.seat).sub(vehicleEmbodimentHip),
        seatedBlend,
      );
    }
    if (playerAvatar.userData?.nameTag) playerAvatar.userData.nameTag.visible = false;
    playerAvatar.updateMatrixWorld(true);
  }
  resetPlayerLocomotionFacing(playerAvatar.position);

  if (phase !== 'seated'
    && (vehicleEmbodimentState.lastSampleProgress < 0
      || progress - vehicleEmbodimentState.lastSampleProgress >= 0.055
      || progress >= 1)) {
    const sampleHip = playerAvatar.getObjectByName?.('Hips')?.getWorldPosition(vehicleEmbodimentHip)
      ?? playerAvatar.position;
    const seatResidual = sampleHip.distanceTo(sockets.seat);
    vehicleEmbodimentState.samples.push({
      phase: vehicleEmbodimentPhaseForQa(),
      progress,
      hip: { x: sampleHip.x, y: sampleHip.y, z: sampleHip.z },
      seatResidual,
      doorAngle,
    });
    if (vehicleEmbodimentState.samples.length > VEHICLE_EMBODIMENT_SAMPLE_LIMIT) {
      vehicleEmbodimentState.samples.shift();
    }
    vehicleEmbodimentState.lastSampleProgress = progress;
  }

  if (phase === 'entering' && progress >= 1) {
    vehicleEmbodimentState.phase = 'seated';
    vehicleEmbodimentState.completedAt = performance.now();
    setVehicleEmbodimentDoor(0);
  } else if (phase === 'exiting' && progress >= 1) {
    vehicleEmbodimentState.phase = 'grounded';
    vehicleEmbodimentState.completedAt = performance.now();
    setVehicleEmbodimentDoor(0);
    controls.target.set(sockets.ground.x, sockets.surfaceY, sockets.ground.z);
    playerAvatar.position.copy(sockets.ground);
    playerAvatar.quaternion.identity();
    animatePlayerAvatar(playerAvatar, { moving: false, speedRatio: 0, elapsed: animationElapsed, delta: 0 });
    setAvatarLook(playerAvatar, pose.heading + Math.PI);
    if (playerAvatar.userData?.shadow) playerAvatar.userData.shadow.visible = true;
    if (playerAvatar.userData?.nameTag) playerAvatar.userData.nameTag.visible = true;
    playerAvatar.updateMatrixWorld(true);
  }
  return true;
}

function updatePlayerLayer(dt, elapsed) {
  updatePlayerMuniRide();
  updatePlayerTaxiRide(dt);
  const passengerRiding = passengerRideActive();
  const drivingState = traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null;
  if (drivingState) {
    controls.target.set(drivingState.position.x, drivingState.position.y + 1.6, drivingState.position.z);
    controls.yaw = drivingState.heading + Math.PI;
    controls.pitch = THREE.MathUtils.clamp(
      controls.pitch,
      DRIVE_CAMERA_PITCH_MIN,
      DRIVE_CAMERA_PITCH_MAX,
    );
    controls.distance = THREE.MathUtils.clamp(
      controls.distance,
      DRIVE_CAMERA_DISTANCE_MIN,
      DRIVE_CAMERA_DISTANCE_MAX,
    );
    const inputLocked = vehicleEmbodimentState.phase !== 'seated';
    traffic.setPlayerInput?.(inputLocked ? { throttle: 0, brake: 1, steer: 0 } : {
      throttle: controls.keys.has('keyw') ? 1 : 0,
      brake: controls.keys.has('keys') || controls.keys.has('arrowdown') ? 1 : 0,
      steer: (controls.keys.has('keyd') ? 1 : 0) - (controls.keys.has('keya') ? 1 : 0),
    });
    engineAudio?.update(drivingState.speed, !inputLocked && controls.keys.has('keyw') ? 1 : 0);
    windAudio?.update(Math.min(1, drivingState.speed / 13));
    hud?.setDriveState?.({
      active: combat?.getState?.().aiming !== true,
      speed: drivingState.speed,
      heading: drivingState.heading,
      weather: weatherMode,
      damage: drivingState.damage,
      repairCost: getPlayerVehicleRepairQuote()?.cost ?? 0,
      repairLocked: streetHeat?.getState?.().pursuitActive === true,
    });
    const damageAt = drivingState.damage?.lastDamage?.at ?? null;
    if (damageAt !== null && damageAt !== lastVehicleDamageAt) {
      lastVehicleDamageAt = damageAt;
      hud?.setMessage(drivingState.damage?.disabled
        ? streetHeat?.getState?.().pursuitActive
          ? 'Vehicle disabled · repair locked during pursuit · S surrender / E exit.'
          : `Vehicle disabled · R roadside repair $${getPlayerVehicleRepairQuote()?.cost ?? 0} / E exit.`
        : `Vehicle impact · integrity ${Math.round((drivingState.damage?.ratio ?? 0) * 100)}%.`);
    }
    lifeSim?.noteDriving?.(dt);
  } else if (vehicleEmbodimentState.phase === 'exiting') {
    hud?.setDriveState?.({ active: false });
    traffic.setPlayerInput?.({ throttle: 0, brake: 0, steer: 0 });
  } else {
    hud?.setDriveState?.({ active: false });
    traffic.setPlayerInput?.({ throttle: 0, brake: 0, steer: 0 });
    if (playerAvatar && !controls.interiorMode) {
      // Beauty / QA locked cameras must not show the local Traveler nameplate
      // floating in hero road stills (critic pass 9/10 hard blocker).
      const hideAvatarForShot = beautyMode
        || (Boolean(qaCameraPose) && onFootPedestrianSpaceQaScenario?.captureFraming !== true)
        || passengerRiding;
      playerAvatar.visible = !hideAvatarForShot;
      if (!hideAvatarForShot) {
        const surface = getTraversalSurfaceHeight(controls.target);
        const groundY = Number.isFinite(surface) ? surface : 0;
        const nextAvatarPosition = playerAvatarNextPosition.set(
          controls.target.x,
          groundY + PLAYER_GROUND_OFFSET,
          controls.target.z,
        );
        playerAvatar.position.copy(nextAvatarPosition);
        const moving = playerMoving();
        const speedRatio = controls.keys.has('shiftleft') || controls.keys.has('shiftright') ? 1 : 0.58;
        animatePlayerAvatar(playerAvatar, { moving, speedRatio, elapsed, delta: dt });
        // Locomotion animation resets the authored root pose each frame; apply
        // world-facing after that layer so travel direction remains visible.
        updatePlayerLocomotionFacing(dt, nextAvatarPosition);
        if (performance.now() < playerBookingPoseUntil) {
          setAvatarSurrenderPose(playerAvatar);
        }
      } else {
        resetPlayerLocomotionFacing();
      }
    } else if (playerAvatar) {
      playerAvatar.visible = false;
      resetPlayerLocomotionFacing();
    }
  }
  networking?.update(dt, elapsed);
  pedestrians.setDayHour?.(lifeSim?.getState?.().clock ?? 7);
  const lifeEvent = lifeSim?.update(dt, {
    driving: Boolean(drivingState),
    moving: drivingState ? drivingState.speed > 0.5 : playerMoving(),
    interior: controls.interiorMode,
    downed: combat?.getState?.().status !== 'running',
    pursuitActive: streetHeat?.getState?.().pursuitActive === true,
    available: playerLayerActive && !beautyMode && !qaCameraPose && !passengerRiding,
    position: controls.target,
  });
  if (lifeEvent?.kind === 'work-complete'
    || lifeEvent?.kind === 'work-cancelled'
    || lifeEvent?.kind === 'favor-timeout'
    || lifeEvent?.kind === 'delivery-timeout') {
    savePlayerProgress();
  }
}

const PORTAL_NEARBY_RADIUS = 22;
const FEATURED_PORTAL_DISCOVERY_RADIUS = 48;

cityShift = createCityShift({
  scene,
  city,
  onStepAttempt: ({ step, stepIndex, totalSteps, interaction }) => {
    const networkState = networking?.getState?.();
    const coopSession = networking?.getCoopSession?.();
    if (networkState?.connected !== true
      || (!coopSession && (networkState.peerCount < 1 || stepIndex > 0))) return undefined;
    networking.submitCoopStep?.({
      stepIndex,
      stepId: step.id,
      totalSteps,
      context: interaction,
    });
    hud?.setMessage(`CO-OP / VALIDATING ${step.shortLabel.toUpperCase()}…`);
    return 'deferred';
  },
  onAdvance: ({
    message,
    completed,
    cashReward,
    source,
    sessionId,
    completionRevision,
  }) => {
    if (completed && cashReward > 0) {
      if (source === 'coop') {
        const receipt = `${sessionId}:${completionRevision}`;
        if (sessionId
          && Number.isInteger(completionRevision)
          && !rewardedCoopReceipts.has(receipt)) {
          rewardedCoopReceipts.add(receipt);
          lifeSim?.creditMissionReward?.(cashReward, 'Co-op Waterfront Loop payout');
        }
      } else {
        lifeSim?.creditMissionReward?.(cashReward, 'Waterfront Loop payout');
      }
    }
    hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
    hud?.setMessage(message);
    savePlayerProgress();
  },
});

function recoverPlayerAtWelcomeCenter() {
  const portal = city.portals?.find?.(
    (candidate) => String(candidate?.label || '').toLowerCase().includes('welcome center'),
  );
  const releasePoint = portal?.approachRoute?.[portal.approachRoute.length - 1]
    || portal?.position;
  if (!releasePoint) return false;
  return importPlayerWorldState({
    mode: 'outdoor',
    x: releasePoint.x,
    z: releasePoint.z,
    yaw: Number.isFinite(portal?.heading) ? portal.heading : Math.PI,
    pitch: lastPublicWorldState?.pitch ?? WALK_CAMERA_PITCH,
    distance: lastPublicWorldState?.distance ?? WALK_CAMERA_DISTANCE,
  });
}

streetHeat = createStreetHeat({
  scene,
  // Sampling is throttled inside the gameplay layer so the authored traffic
  // snapshot remains a cheap presentation signal instead of a new hot-loop
  // dependency.
  getTrafficSnapshot: () => traffic.getVehicleLifeSnapshot?.(),
  getPursuitResponder: () => traffic.getPursuitResponder?.(),
  getPursuitResponders: getSfpdPursuitResponders,
  getResponderPressureAuthority: ({ responderId }) => (
    sfpdOfficers.getPressureAuthority?.({ responderId })
  ),
  onEvent: ({
    kind,
    message,
    score,
    heatBefore = 0,
    reason = null,
    damage = 0,
    responderId = null,
    officerId = null,
    los = false,
    blocked = false,
  }) => {
    if (kind === 'responder-contact') {
      if (!traffic.isPlayerDriving?.()) {
        const damaged = combat?.damagePlayer?.(18, 'pursuit-contact');
        if (damaged && combat?.getState?.().status === 'downed') {
          streetHeat?.resolveArrest?.({
            wasDriving: false,
            reason: 'pursuit-defeat',
          });
          return;
        }
      }
    }
    if (kind === 'responder-pressure') {
      const fired = sfpdOfficers.registerPressureShot?.(
        responderId,
        getCombatGroundPosition(),
      ) === true;
      const damaged = fired && officerId
        ? combat?.damagePlayer?.(damage, `sfpd:${officerId}`)
        : false;
      if (damaged) {
        sfpdOfficers.recordDamage?.({
          targetId: 'player',
          source: 'officer',
          los,
          blocked,
        });
      }
      if (damaged && combat?.getState?.().status === 'downed') {
        streetHeat?.resolveArrest?.({
          wasDriving: false,
          reason: 'pursuit-defeat',
        });
        return;
      }
      if (damaged) savePlayerProgress();
    }
    if (kind === 'arrested') {
      sfpdOfficerQaScenario = null;
      clearSfpdResponderDeploymentHolds();
      sfpdOfficers.recordBooking?.();
      sfpdOfficers.clear?.({ resetDefeats: true });
      playerBookingPoseUntil = performance.now() + 5000;
      combat?.setTriggerHeld?.(false);
      combat?.setAiming?.(false);
      controls.combatPointerId = null;
      controls.combatTriggerPointerId = null;
      const voidedContracts = [];
      if (lifeSim?.cancelDeliveryRun?.('BAY PARCEL VOIDED · booking closed the active run.')) {
        voidedContracts.push('BAY PARCEL');
      }
      if (lifeSim?.cancelResidentFavor?.('FAVOR VOIDED · booking closed the active errand.')) {
        voidedContracts.push('FAVOR');
      }
      if (lifeSim?.cancelWorkShift?.('MARKET SHIFT VOIDED · booking ended the active shift.')) {
        voidedContracts.push('MARKET SHIFT');
      }
      let impounded = null;
      if (traffic.isPlayerDriving?.()) {
        if (vehicleEmbodimentTransitionActive()) clearPlayerVehicleEmbodiment({ keepVehicle: true });
        exitPlayerCar();
        impounded = traffic.impoundPlayerVehicle?.() ?? null;
      }
      clearPlayerVehicleEmbodiment();
      const pursuitDefeat = reason === 'pursuit-defeat';
      const recovered = pursuitDefeat
        ? combat?.recoverFromDowned?.(58, 'pursuit-booking') ?? null
        : null;
      const releasedAtWelcomeCenter = pursuitDefeat && recovered
        ? recoverPlayerAtWelcomeCenter()
        : false;
      traffic.setPursuitResponder?.({
        active: false,
        position: controls.target,
        playerVehicleId: null,
        level: 0,
        presentation: 'booking',
      });
      const wantedFine = THREE.MathUtils.clamp(
        Math.ceil(20 + Math.max(0, Number(heatBefore) || 0) * 1.5),
        20,
        120,
      );
      const transaction = lifeSim?.payWantedFine?.(wantedFine, 'StreetHeat booking');
      hud?.setLifeState?.(lifeSim?.getState?.());
      const paid = transaction?.charged ?? 0;
      const unpaid = transaction?.unpaid ?? 0;
      message = unpaid > 0
        ? `ARRESTED / $${paid} paid · $${unpaid} unpaid.`
        : releasedAtWelcomeCenter
          ? `BUSTED / $${paid} paid · released at Welcome Center.`
        : impounded
          ? `ARRESTED / $${paid} paid · vehicle held at Ferry.`
          : `ARRESTED / $${paid} paid · released roadside.`;
      if (voidedContracts.length > 0) {
        message += ` ${voidedContracts.join(' + ')} VOIDED.`;
      }
      savePlayerProgress();
    }
    if (kind === 'escaped') {
      sfpdOfficerQaScenario = null;
      clearSfpdResponderDeploymentHolds();
      sfpdOfficers.clear?.({ resetDefeats: true });
    }
    if (score) cityShift?.awardBonus?.(score);
    publishNetworkGameplayEvent({ kind, message });
    hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
    hud?.setMessage(message);
  },
});

const vehiclePedestrianImpactCandidates = [];
function updateVehiclePedestrianImpact() {
  const probe = traffic.getPlayerPedestrianImpactProbe?.();
  if (!probe) {
    traffic.resolvePlayerPedestrianImpact?.(vehiclePedestrianImpactCandidates);
    vehiclePedestrianImpactCandidates.length = 0;
    return null;
  }
  pedestrians.getVehicleImpactCandidates?.(probe, vehiclePedestrianImpactCandidates);
  const impact = traffic.resolvePlayerPedestrianImpact?.(vehiclePedestrianImpactCandidates);
  if (!impact) return null;
  const reaction = pedestrians.registerVehicleImpact?.(impact.residentId, {
    directionX: impact.directionX,
    directionZ: impact.directionZ,
  });
  if (!reaction) return null;
  lastVehicleDamageAt = impact.damage?.lastDamage?.at ?? lastVehicleDamageAt;
  combatAudio?.play?.('impact', { targetKind: 'pedestrian' });
  streetHeat?.reportIncident?.(14, {
    kind: 'pedestrian-impact',
    source: 'combat',
    message: reaction.defeated
      ? `Pedestrian impact · ${impact.residentLabel} incapacitated · heat +14.`
      : `Pedestrian impact · ${impact.residentLabel} staggered · heat +14.`,
  });
  const witness = pedestrians.getVehicleImpactWitness?.(impact.residentId, 18) ?? null;
  const witnessReaction = witness
    ? pedestrians.registerVehicleWitnessReaction?.(witness.id, {
      originX: witness.victimPosition.x,
      originZ: witness.victimPosition.z,
    }) ?? null
    : null;
  const witnessReport = witnessReaction
    ? streetHeat?.reportWitness?.({
      incidentId: traffic.getDiagnostics?.().pedestrianImpactEvents,
      witnessId: witness.id,
      witnessLabel: witness.label,
      victimId: impact.residentId,
    }) ?? null
    : null;
  if (reaction.defeated) {
    hud?.setMessage(`Pedestrian impact · ${impact.residentLabel} incapacitated.`);
  }
  savePlayerProgress();
  return {
    ...impact,
    reaction,
    witness: witnessReport?.reported
      ? { ...witness, reaction: witnessReaction, report: witnessReport }
      : null,
  };
}

const combatPedestrianCandidates = [];
function getCombatPedestrianCandidates(_origin, _maxRange, out = combatPedestrianCandidates) {
  pedestrians.getCombatCandidates?.(out);
  sfpdOfficers.getCombatCandidates?.(out);
  return out;
}

function getNearestCombatWorldBlocker(origin, direction, maxDistance) {
  const distanceLimit = Number(maxDistance);
  if (!origin || !direction || !Number.isFinite(distanceLimit) || distanceLimit <= 0) return null;
  const candidates = [
    city.getNearestRayBlocker?.(origin, direction, distanceLimit),
    streaming.getNearestRayBlocker?.(origin, direction, distanceLimit),
  ].filter((blocker) => (
    blocker
    && Number.isFinite(blocker.distance)
    && blocker.distance >= 0
    && blocker.distance <= distanceLimit
    && Number.isFinite(blocker.point?.x)
    && Number.isFinite(blocker.point?.y)
    && Number.isFinite(blocker.point?.z)
  ));
  candidates.sort((left, right) => (
    left.distance - right.distance
      || String(left.source || '').localeCompare(String(right.source || ''))
  ));
  const nearest = candidates[0];
  if (!nearest) return null;
  return {
    ...nearest,
    point: { x: nearest.point.x, y: nearest.point.y, z: nearest.point.z },
  };
}

function findSfpdQaResponderPosition({ blocked = false, distance = 17 } = {}) {
  const player = getCombatGroundPosition(new THREE.Vector3());
  const source = new THREE.Vector3();
  const target = new THREE.Vector3(player.x, player.y + 1.34, player.z);
  const ray = new THREE.Vector3();
  if (blocked) {
    source.set(player.x, player.y + 1.34, player.z);
    for (let index = 0; index < 72; index += 1) {
      const angle = (index / 72) * Math.PI * 2;
      ray.set(Math.sin(angle), 0, Math.cos(angle));
      const blocker = getNearestCombatWorldBlocker(source, ray, 24);
      if (!blocker || blocker.distance < 4 || blocker.distance > 20) continue;
      return {
        x: player.x + ray.x * 27,
        y: player.y,
        z: player.z + ray.z * 27,
      };
    }
  }
  let fallback = null;
  for (let index = 0; index < 24; index += 1) {
    const angle = (index / 24) * Math.PI * 2;
    source.set(
      player.x + Math.sin(angle) * distance,
      player.y + 1.36,
      player.z + Math.cos(angle) * distance,
    );
    ray.subVectors(target, source);
    const rayDistance = ray.length();
    ray.multiplyScalar(1 / Math.max(0.001, rayDistance));
    const blocker = getNearestCombatWorldBlocker(source, ray, rayDistance - 0.08);
    const matches = blocked ? Boolean(blocker) : !blocker;
    fallback = fallback || { x: source.x, y: player.y, z: source.z };
    if (matches) return { x: source.x, y: player.y, z: source.z };
  }
  return fallback || { x: player.x, y: player.y, z: player.z + distance };
}

function stageSfpdOfficerQa(scenario = {}) {
  const request = typeof scenario === 'string' ? { kind: scenario } : scenario;
  const kind = String(request?.kind || 'heat');
  if (!['heat', 'los', 'blocked', 'downed', 'surrender', 'escape', 'cycle'].includes(kind)) {
    return false;
  }
  if (!started) startExperience();
  qaCameraPose = null;
  // The unstaged verifier owns the non-flat grade proof. Deterministic visual
  // scenarios return to the authored core avenue so captures contain the
  // actual road, curb, and live responder car rather than a sparse streamed
  // proxy seam; the verifier then frames from its own surface sample.
  setQaRoamPose({ x: 28, z: 42 });
  clearSfpdResponderDeploymentHolds();
  sfpdOfficers.clear?.({ resetDefeats: true });
  sfpdOfficers.resetEvents?.();
  sfpdOfficerQaPressureDelay = 0.8;
  combat?.start?.();
  const requestedLevel = request?.level === 3 ? 3 : 2;
  const level = kind === 'cycle' ? 3 : requestedLevel;
  const heat = level === 3 ? 94 : 78;
  streetHeat?.importState?.({
    heat,
    pursuitActive: true,
    responderContacts: 0,
    responderContactLatched: false,
    nearMisses: 0,
    witnessReports: 0,
    combatHold: 2.8,
    theftHold: 0,
  });
  traffic.setPursuitResponder?.({
    active: true,
    position: controls.target,
    playerVehicleId: null,
    level,
  });
  const naturalResponders = (traffic.getPursuitResponders?.() || [])
    .slice()
    .sort((left, right) => left.id - right.id);
  const qaPlayerGround = getCombatGroundPosition(new THREE.Vector3());
  const usesDeterministicHandoff = true;
  if (usesDeterministicHandoff) {
    const desiredCount = level;
    const blocked = kind === 'blocked';
    const distance = kind === 'surrender'
      ? 8
        : kind === 'escape' ? 64
        : kind === 'blocked' ? 27
          : kind === 'heat' || kind === 'cycle' ? 12 : 17;
    const base = findSfpdQaResponderPosition({ blocked, distance });
    const angle = Math.atan2(base.x - controls.target.x, base.z - controls.target.z);
    const lateralX = Math.cos(angle);
    const lateralZ = -Math.sin(angle);
    const responders = [];
    for (let index = 0; index < desiredCount; index += 1) {
      const centeredDowned = kind === 'downed';
      const offset = blocked || centeredDowned
        ? 0
        : (index - (desiredCount - 1) * 0.5) * 1.5;
      const natural = naturalResponders[index];
      responders.push({
        active: true,
        id: natural?.id ?? 900 + index,
        slot: index,
        label: natural?.label || 'SFPD patrol unit',
        identity: natural?.identity || `sfpd-qa-${index + 1}`,
        position: {
          x: base.x + lateralX * offset,
          y: qaPlayerGround.y,
          z: base.z + lateralZ * offset,
        },
        heading: angle + Math.PI,
        dir: blocked ? -1 : centeredDowned ? 1 : index % 2 === 0 ? 1 : -1,
        speed: 0,
        distance: Math.hypot(
          base.x + lateralX * offset - qaPlayerGround.x,
          base.z + lateralZ * offset - qaPlayerGround.z,
        ),
        level,
        closing: false,
        qaSynthetic: true,
        qaHoldPosition: blocked || kind === 'los' || kind === 'downed',
      });
    }
    sfpdOfficerQaScenario = { kind, level, responders };
    // QA setup may place an already-settled patrol handoff; run only the
    // staged door-exit interpolation. No aim, shot, damage, or booking event
    // can be emitted during these pressure-free setup passes.
    for (let step = 0; step < 6; step += 1) {
      sfpdOfficers.update?.(0.1, step * 0.1, {
        active: true,
        level,
        responders,
        playerPosition: qaPlayerGround,
        outdoor: true,
        pressure: null,
      });
    }
  } else {
    sfpdOfficerQaScenario = { kind, level, responders: null };
  }
  return {
    ready: true,
    syntheticEvents: 0,
    kind,
    level,
  };
}

function snapshotSfpdOfficerQa() {
  const officerState = sfpdOfficers.getState?.() || {};
  const heat = streetHeat?.getState?.() || {};
  const responders = getSfpdPursuitResponders();
  return {
    heat: {
      level: heat.level ?? 0,
      responderCount: responders.length,
      pursuitActive: heat.pursuitActive === true,
    },
    officers: officerState.officers || [],
    vehicles: responders.map((responder) => ({
      id: responder.id,
      pursuit: responder.active === true,
      lightsOn: responder.active === true,
      speed: Math.round((Number(responder.speed) || 0) * 10) / 10,
      distanceToPlayer: Math.round((Number(responder.distance) || 0) * 10) / 10,
      deploymentHold: {
        requested: responder.deploymentHold?.requested === true,
        holding: responder.deploymentHold?.holding === true,
      },
    })),
    events: officerState.events || {
      aims: 0, shots: 0, damage: [], officerFires: [], bookings: 0,
    },
    blocker: officerState.blocker || { solid: false, cycles: 0 },
    resources: officerState.resources || {
      officerActors: 0, activeTimers: 0, activeListeners: 0, activeProjectiles: 0,
    },
    cleanup: {
      officers: officerState.resources?.officerActors ?? 0,
      stuckKits: heat.pursuitActive === true ? 0 : responders.length,
    },
    cleared: officerState.cleared === true,
  };
}

const sfpdOfficerQa = Object.freeze({
  stage: stageSfpdOfficerQa,
  snapshot: snapshotSfpdOfficerQa,
});

function resetOnFootVehicleImpactQaReaction() {
  const reaction = playerAvatar?.userData?.hitReaction;
  if (reaction) {
    reaction.pending = false;
    reaction.startElapsed = null;
    reaction.lastPhase = 1;
    reaction.lastWeight = 0;
    reaction.lastApplied = false;
  }
  const downed = playerAvatar?.userData?.hitReactionDowned;
  if (downed) downed.value = 0;
}

function stageOnFootVehicleImpactQa(scenario = {}) {
  const kind = String(scenario?.kind || 'high-speed');
  const allowed = new Set([
    'high-speed', 'low-speed', 'disabled', 'parallel', 'hidden', 'garage',
    'impounded', 'remote', 'downed', 'pursuit-responder',
  ]);
  if (!allowed.has(kind)) {
    traffic.stageOnFootVehicleImpactQa?.({ kind, referencePosition: controls.target });
    onFootVehicleImpactQaScenario = null;
    return { ready: false, syntheticEvents: 0, kind };
  }
  if (!started) startExperience();
  qaCameraPose = null;
  sfpdOfficerQaScenario = null;
  clearSfpdResponderDeploymentHolds();
  combat?.restart?.();
  resetOnFootVehicleImpactQaReaction();
  if (kind === 'pursuit-responder') {
    streetHeat?.importState?.({
      heat: 78,
      pursuitActive: true,
      responderContacts: 0,
      responderContactLatched: false,
      nearMisses: 0,
      witnessReports: 0,
      combatHold: 2.8,
      theftHold: 0,
    });
    traffic.setPursuitResponder?.({
      active: true,
      position: controls.target,
      playerVehicleId: null,
      level: 2,
    });
  } else {
    streetHeat?.restart?.();
    traffic.setPursuitResponder?.({
      active: false,
      position: controls.target,
      playerVehicleId: null,
      level: 0,
    });
  }
  const before = traffic.getOnFootVehicleContactDiagnostics?.().contacts ?? 0;
  const staged = traffic.stageOnFootVehicleImpactQa?.({
    kind,
    referencePosition: controls.target,
  });
  if (!staged?.playerPose) return { ready: false, syntheticEvents: 0, kind };
  onFootVehicleImpactQaScenario = { kind, vehicleId: staged.vehicleId };
  setQaRoamPose({
    ...staged.playerPose,
    pitch: 1.05,
    distance: 8.8,
  });
  if (kind === 'downed') combat?.damagePlayer?.(100, 'qa-on-foot-vehicle-impact-downed');
  const after = traffic.getOnFootVehicleContactDiagnostics?.().contacts ?? 0;
  return {
    ready: true,
    syntheticEvents: after - before,
    kind,
    vehicleId: staged.vehicleId,
  };
}

function getPlayerRenderedBodyBounds() {
  if (!playerAvatar?.visible) return null;
  const body = playerAvatar.getObjectByName?.('Shared skinned adult body');
  if (!body) return null;
  playerAvatar.updateWorldMatrix(true, true);
  body.skeleton?.update?.();
  const bounds = new THREE.Box3().setFromObject(body, true);
  if (bounds.isEmpty()) return null;
  const min = { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z };
  const max = { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z };
  const extentX = Math.max(
    Math.abs(min.x - playerAvatar.position.x),
    Math.abs(max.x - playerAvatar.position.x),
  );
  const extentZ = Math.max(
    Math.abs(min.z - playerAvatar.position.z),
    Math.abs(max.z - playerAvatar.position.z),
  );
  return {
    source: body.name,
    bounds: { min, max },
    width: max.x - min.x,
    depth: max.z - min.z,
    horizontalRadius: Math.hypot(extentX, extentZ),
    collisionRadius: ON_FOOT_PLAYER_BODY_RADIUS,
  };
}

function projectVehicleEmbodimentBounds(bounds) {
  if (!bounds?.min || !bounds?.max) return null;
  const width = renderer.domElement.clientWidth || window.innerWidth || 1;
  const height = renderer.domElement.clientHeight || window.innerHeight || 1;
  const points = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        vehicleEmbodimentScreenPoint.set(x, y, z).project(camera);
        points.push({
          x: (vehicleEmbodimentScreenPoint.x * 0.5 + 0.5) * width,
          y: (-vehicleEmbodimentScreenPoint.y * 0.5 + 0.5) * height,
          depth: vehicleEmbodimentScreenPoint.z,
        });
      }
    }
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const screen = {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
  screen.width = screen.right - screen.left;
  screen.height = screen.bottom - screen.top;
  screen.readable = screen.width >= 16 && screen.height >= 28
    && screen.right > 0 && screen.left < width
    && screen.bottom > 0 && screen.top < height
    && points.some((point) => point.depth >= -1 && point.depth <= 1);
  return screen;
}

function getVehicleEmbodimentSkinnedSample(renderedBody) {
  const body = playerAvatar?.getObjectByName?.('Shared skinned adult body');
  const position = body?.geometry?.attributes?.position;
  return {
    source: body?.name ?? null,
    skinnedVertexCount: Number(position?.count) || 0,
    bounds: renderedBody?.bounds ? structuredClone(renderedBody.bounds) : null,
  };
}

function getPlayerVehicleEmbodimentState() {
  const drivingState = traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null;
  const root = vehicleRootForId(vehicleEmbodimentState.vehicleId);
  const pose = readVehicleEmbodimentPose(drivingState);
  const sockets = pose ? computeVehicleEmbodimentSockets(pose) : vehicleEmbodimentState.sockets;
  if (sockets) vehicleEmbodimentState.sockets = sockets;
  playerAvatar?.updateWorldMatrix?.(true, true);
  const renderedBody = getPlayerRenderedBodyBounds();
  const screen = projectVehicleEmbodimentBounds(renderedBody?.bounds);
  const hipObject = playerAvatar?.getObjectByName?.('Hips')
    || playerAvatar?.userData?.rig
    || playerAvatar;
  const hip = hipObject?.getWorldPosition
    ? hipObject.getWorldPosition(vehicleEmbodimentStart)
    : playerAvatar?.position;
  const surface = playerAvatar ? getTraversalSurfaceHeight(playerAvatar.position) : null;
  const feetSurfaceDelta = renderedBody && Number.isFinite(surface)
    ? Math.abs(renderedBody.bounds.min.y - surface)
    : null;
  const vehicleBounds = root?.visible
    ? vehicleEmbodimentBox.setFromObject(root, true)
    : null;
  let avatarVehicleSat = null;
  if (renderedBody?.bounds && vehicleBounds && !vehicleBounds.isEmpty()) {
    avatarVehicleSat = Math.min(
      Math.min(renderedBody.bounds.max.x, vehicleBounds.max.x)
        - Math.max(renderedBody.bounds.min.x, vehicleBounds.min.x),
      Math.min(renderedBody.bounds.max.y, vehicleBounds.max.y)
        - Math.max(renderedBody.bounds.min.y, vehicleBounds.min.y),
      Math.min(renderedBody.bounds.max.z, vehicleBounds.max.z)
        - Math.max(renderedBody.bounds.min.z, vehicleBounds.min.z),
    );
  }
  const seatResidual = hip && sockets?.seat
    ? hip.distanceTo(sockets.seat)
    : null;
  const embodiment = root?.userData?.vehicleEmbodiment;
  const sideKey = vehicleEmbodimentState.doorSide < 0 ? 'left' : 'right';
  const door = embodiment?.doors?.[sideKey];
  const doorPivot = door?.pivot?.getWorldPosition
    ? door.pivot.getWorldPosition(new THREE.Vector3())
    : null;
  const width = renderer.domElement.clientWidth || window.innerWidth || 1;
  const height = renderer.domElement.clientHeight || window.innerHeight || 1;
  const cameraSurface = getTraversalSurfaceHeight(camera.position);
  const cameraSurfaceClearance = Number.isFinite(cameraSurface)
    ? camera.position.y - cameraSurface
    : null;
  const cameraInsideVehicle = Boolean(pose && !pointOutsideVehicleBody(camera.position, {
    ...pose,
    class: vehicleEmbodimentState.vehicleClass,
  }));
  const transitionProgress = ['entering', 'exiting'].includes(vehicleEmbodimentState.phase)
    ? THREE.MathUtils.clamp(
      vehicleEmbodimentState.elapsed / vehicleEmbodimentState.duration,
      0,
      1,
    )
    : vehicleEmbodimentState.phase === 'approach' ? 0 : 1;
  const occupying = ['entering', 'seated', 'exiting'].includes(vehicleEmbodimentState.phase);
  const driveBy = getDriveByState();
  return {
    phase: vehicleEmbodimentPhaseForQa(),
    transition: {
      phase: vehicleEmbodimentPhaseForQa(),
      internalPhase: vehicleEmbodimentState.phase,
      progress: transitionProgress,
      duration: vehicleEmbodimentState.duration,
      durationMs: vehicleEmbodimentState.duration * 1000,
      startedAt: vehicleEmbodimentState.startedAt,
      completedAt: vehicleEmbodimentState.completedAt,
      replayed: vehicleEmbodimentState.replayed,
      duplicateEIgnored: vehicleEmbodimentState.duplicateEIgnored,
      samples: vehicleEmbodimentState.samples.map((sample) => ({ ...sample, hip: { ...sample.hip } })),
    },
    avatar: {
      id: LOCAL_TRAVELER_ID,
      uuid: LOCAL_TRAVELER_ID,
      objectUuid: playerAvatar?.uuid ?? null,
      visible: Boolean(playerAvatar?.visible),
      hip: hip ? { x: hip.x, y: hip.y, z: hip.z } : null,
      feetSurfaceDelta,
      renderedBody: {
        source: 'player-avatar',
        meshName: renderedBody?.source ?? null,
        visible: Boolean(playerAvatar?.visible && renderedBody),
        hip: hip ? { x: hip.x, y: hip.y, z: hip.z } : null,
        bounds: renderedBody?.bounds ?? null,
        screen,
      },
      skinnedMeshSample: getVehicleEmbodimentSkinnedSample(renderedBody),
      seat: occupying ? { vehicleId: vehicleEmbodimentState.vehicleId, side: sideKey } : null,
    },
    vehicle: {
      id: vehicleEmbodimentState.vehicleId,
      vehicleId: vehicleEmbodimentState.vehicleId,
      class: vehicleEmbodimentState.vehicleClass,
      rootUuid: root?.uuid ?? null,
      visible: Boolean(root?.visible),
      private: root?.userData?.vehicleCategory === 'private',
      coreRoad: Boolean(pose && Math.abs(pose.position.x) <= 220 && Math.abs(pose.position.z) <= 220),
      distanceToAvatar: pose && playerAvatar
        ? Math.hypot(pose.position.x - playerAvatar.position.x, pose.position.z - playerAvatar.position.z)
        : null,
      occupantAvatarId: occupying ? LOCAL_TRAVELER_ID : null,
      position: pose?.position ? { ...pose.position } : null,
      heading: pose?.heading ?? null,
      speed: pose?.speed ?? 0,
      seat: sockets?.seat ? { x: sockets.seat.x, y: sockets.seat.y, z: sockets.seat.z } : null,
      cabin: embodiment?.cabin ? { ...embodiment.cabin } : null,
      door: {
        side: sideKey,
        name: door?.pivot?.name ?? null,
        visible: Boolean(root?.visible && door?.panel?.visible),
        angle: Number(door?.angle) || 0,
        apertureAngle: Number(door?.pivot?.userData?.apertureAngle) || 0,
        traversal: Number(door?.pivot?.userData?.traversal) || 0,
        pivot: doorPivot ? { x: doorPivot.x, y: doorPivot.y, z: doorPivot.z } : null,
        requiredOpenAngle: 0.75,
        pivotUuid: door?.pivot?.uuid ?? null,
        apertureUuid: door?.aperture?.uuid ?? null,
        apertureVisible: Boolean(door?.aperture?.visible),
        panelVisible: Boolean(door?.panel?.visible),
        maxTransitionAngle: vehicleEmbodimentState.samples.reduce(
          (maximum, sample) => Math.max(maximum, Number(sample.doorAngle) || 0),
          0,
        ),
      },
    },
    sockets: sockets ? {
      seat: { x: sockets.seat.x, y: sockets.seat.y, z: sockets.seat.z },
      door: { x: sockets.door.x, y: sockets.door.y, z: sockets.door.z },
      ground: { x: sockets.ground.x, y: sockets.ground.y, z: sockets.ground.z },
      surfaceY: sockets.surfaceY,
    } : null,
    clearance: {
      seatResidual,
      bodyShellPenetration: Number.isFinite(seatResidual)
        ? Math.max(0, seatResidual - 0.03)
        : 0,
      avatarVehicleSat,
    },
    driveBy: {
      ...driveBy,
      active: driveByState.active,
      avatarId: LOCAL_TRAVELER_ID,
      bodySource: 'player-avatar',
      bodyVisible: Boolean(playerAvatar?.visible),
      weapon: {
        ...driveBy.weapon,
        parent: playerWeapon?.parent === playerAvatar?.userData?.rightHand ? 'right-hand' : null,
        gripDistance: driveBy.weapon?.gripSocketDistance ?? null,
      },
    },
    camera: {
      safe: !cameraInsideVehicle
        && (!Number.isFinite(cameraSurfaceClearance) || cameraSurfaceClearance >= 0.4),
      insideVehicle: cameraInsideVehicle,
      belowSurface: Number.isFinite(cameraSurfaceClearance) && cameraSurfaceClearance < 0.4,
      surfaceClearance: cameraSurfaceClearance,
      maxStep: vehicleEmbodimentState.cameraMaxStep,
      viewport: { width, height },
    },
    legacyDriveByRigVisible: Boolean(driveByRig?.visible),
    events: { ...vehicleEmbodimentState.events },
    resources: {
      avatarActors: playerAvatar ? 1 : 0,
      weaponActors: playerWeapon ? 1 : 0,
      legacyDriveByRigs: driveByRig ? 1 : 0,
      transitionTimers: 0,
      transitionListeners: 0,
    },
  };
}

function stageVehicleEmbodimentQa({ kind = 'core-private', vehicleClass = null } = {}) {
  if (kind !== 'core-private' || traffic.isPlayerDriving?.() || passengerRideActive()
    || controls.interiorMode
    || (vehicleClass && !['sedan', 'suv', 'pickup', 'van'].includes(vehicleClass))) {
    return { ready: false, syntheticEvents: 0, kind };
  }
  if (!started) startExperience();
  qaCameraPose = null;
  beautyMode = false;
  app?.classList.remove('is-beauty');
  clearPlayerVehicleEmbodiment();
  const staged = traffic.stagePlayerVehicleEmbodimentQa?.({
    referencePosition: controls.target,
    preferredClass: vehicleClass,
  });
  if (!staged || staged.syntheticEvents !== 0) {
    return { ready: false, syntheticEvents: staged?.syntheticEvents ?? 0, kind };
  }
  const selected = {
    index: staged.vehicleId,
    root: vehicleRootForId(staged.vehicleId),
  };
  if (!selected.root) return { ready: false, syntheticEvents: 0, kind };
  const heading = Number(staged.heading) || 0;
  const authored = selected.root.userData.vehicleEmbodiment;
  const doorSide = 1;
  vehicleEmbodimentRight.set(Math.cos(heading), 0, -Math.sin(heading));
  vehicleEmbodimentPosition.copy(selected.root.position).addScaledVector(
    vehicleEmbodimentRight,
    doorSide * (authored.halfWidth + 0.72),
  );
  const surface = getTraversalSurfaceHeight(vehicleEmbodimentPosition);
  controls.target.set(
    vehicleEmbodimentPosition.x,
    Number.isFinite(surface) ? surface : selected.root.position.y,
    vehicleEmbodimentPosition.z,
  );
  controls.yaw = heading + Math.PI;
  controls.pitch = WALK_CAMERA_PITCH;
  controls.distance = WALK_CAMERA_DISTANCE;
  controls.keys.clear();
  beginVehicleEmbodimentPhase('approach', {
    vehicleId: selected.index,
    vehicleClass: selected.root.userData.vehicleClass,
    doorSide,
    startPosition: controls.target,
    pose: { position: selected.root.position, heading, speed: 0 },
  });
  vehicleEmbodimentState.events.theftIngressCount = 0;
  playerAvatar.visible = true;
  const avatarSurface = Number.isFinite(surface) ? surface : selected.root.position.y;
  playerAvatar.position.set(controls.target.x, avatarSurface + PLAYER_GROUND_OFFSET, controls.target.z);
  animatePlayerAvatar(playerAvatar, { moving: false, speedRatio: 0, elapsed, delta: 0 });
  setAvatarLook(playerAvatar, heading + Math.PI);
  if (playerAvatar.userData?.nameTag) playerAvatar.userData.nameTag.visible = true;
  playerAvatar.updateMatrixWorld(true);
  snapCameraToControls();
  vehicleEmbodimentCameraPrevious.copy(camera.position);
  vehicleEmbodimentState.cameraReady = true;
  return {
    ready: true,
    syntheticEvents: 0,
    kind,
    avatarId: LOCAL_TRAVELER_ID,
    vehicleId: selected.index,
  };
}

const vehicleEmbodimentQa = Object.freeze({
  stage: stageVehicleEmbodimentQa,
  snapshot: getPlayerVehicleEmbodimentState,
});

function snapshotOnFootVehicleImpactQa() {
  const diagnostics = traffic.getOnFootVehicleContactDiagnostics?.() || {};
  const renderedBody = getPlayerRenderedBodyBounds();
  const vehicle = traffic.getOnFootVehicleImpactQaState?.({
    position: controls.target,
    renderedBounds: renderedBody?.bounds,
  }) || null;
  const combatState = combat?.getState?.() || {};
  const kind = onFootVehicleImpactQaScenario?.kind ?? null;
  return {
    scenario: kind,
    player: {
      onFoot: !traffic.isPlayerDriving?.()
        && !controls.interiorMode
        && !passengerRideActive(),
      health: combatState.health ?? 0,
      status: combatState.status ?? null,
      position: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      feedback: getPlayerHitReactionTelemetry(playerAvatar),
      renderedBody,
      context: {
        interior: controls.interiorMode === true,
        passenger: passengerRideActive(),
        downed: combatState.status === 'downed',
      },
    },
    vehicle,
    thresholds: { damageSpeed: 4, radius: ON_FOOT_PLAYER_BODY_RADIUS, rearmGap: 0.75 },
    impact: {
      events: diagnostics.contacts ?? 0,
      damageEvents: diagnostics.damageContacts ?? 0,
      corrections: diagnostics.corrections ?? 0,
      latched: (diagnostics.latchCount ?? 0) > 0,
      finalOverlap: vehicle?.finalOverlap === true,
      lastContact: diagnostics.lastContact ?? null,
      lastCorrection: diagnostics.lastCorrection ?? null,
    },
    resources: {
      vehicleActors: vehicle?.actorCount ?? 0,
      activeTimers: 0,
      activeListeners: 0,
      activeProjectiles: 0,
    },
  };
}

const onFootVehicleImpactQa = Object.freeze({
  stage: stageOnFootVehicleImpactQa,
  snapshot: snapshotOnFootVehicleImpactQa,
});

function stageOnFootPedestrianSpaceQa({ kind = 'contact' } = {}) {
  const allowed = new Set(['contact', 'diagonal', 'empty', 'downed']);
  if (!allowed.has(kind)
    || traffic.isPlayerDriving?.()
    || passengerRideActive()
    || controls.interiorMode
    || vehicleEmbodimentTransitionActive()) {
    return { ready: false, syntheticEvents: 0, kind };
  }
  if (!started) startExperience();
  qaCameraPose = null;
  beautyMode = false;
  app?.classList.remove('is-beauty');
  sfpdOfficerQaScenario = null;
  onFootVehicleImpactQaScenario = null;
  controls.keys.clear();
  combat?.restart?.();
  const stagedKind = kind === 'downed' ? 'contact' : kind;
  const staged = pedestrians.stageOnFootPlayerContactQa?.({ kind: stagedKind });
  if (!staged?.ready || staged.syntheticEvents !== 0 || !staged.playerPose?.position) {
    onFootPedestrianSpaceQaScenario = null;
    return { ready: false, syntheticEvents: staged?.syntheticEvents ?? 0, kind };
  }
  setQaRoamPose({
    ...staged.playerPose.position,
    yaw: staged.playerPose.yaw,
    pitch: 1.12,
    distance: 9.2,
  });
  const baseline = pedestrians.getOnFootPlayerContactDiagnostics?.() || {};
  onFootPedestrianSpaceQaScenario = {
    kind,
    stagedKind,
    start: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    baselineContacts: Number(baseline.contacts) || 0,
    tConsumed: false,
  };
  if (kind === 'downed') combat?.damagePlayer?.(100, 'qa-on-foot-pedestrian-space');
  return {
    ready: true,
    syntheticEvents: 0,
    kind,
    residentId: staged.residentId,
    residentIndex: staged.residentIndex,
  };
}

function snapshotOnFootPedestrianSpaceQa() {
  const qa = pedestrians.getOnFootPlayerContactQaState?.() || {};
  const diagnostics = pedestrians.getOnFootPlayerContactDiagnostics?.() || {};
  const resident = qa.resident || null;
  const thresholds = diagnostics.thresholds || {};
  const combinedRadius = (Number(thresholds.defaultPlayerRadius) || ON_FOOT_PLAYER_CROWD_RADIUS)
    + (Number(thresholds.pedestrianRadius) || 0.46);
  const centerDistance = resident?.position
    ? Math.hypot(
      controls.target.x - resident.position.x,
      controls.target.z - resident.position.z,
    )
    : null;
  const finalClearance = Number.isFinite(centerDistance)
    ? centerDistance - combinedRadius
    : null;
  const scenario = onFootPedestrianSpaceQaScenario;
  const traveled = scenario
    ? Math.hypot(
      controls.target.x - scenario.start.x,
      controls.target.z - scenario.start.z,
    )
    : 0;
  const surface = getTraversalSurfaceHeight(controls.target);
  const combatState = combat?.getState?.() || {};
  return {
    scenario: scenario?.kind ?? null,
    player: {
      onFoot: !traffic.isPlayerDriving?.()
        && !controls.interiorMode
        && !passengerRideActive(),
      position: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      roadGrounded: Number.isFinite(surface)
        && Math.abs(controls.target.y - (surface + QA_ROAM_CLEARANCE)) <= 0.08,
      renderedBody: getPlayerRenderedBodyBounds(),
      context: {
        downed: combatState.status === 'downed',
        interior: controls.interiorMode === true,
        driving: traffic.isPlayerDriving?.() === true,
        passenger: passengerRideActive(),
      },
    },
    pedestrian: resident,
    collision: {
      active: Boolean(onFootPlayerCollisionProbeForQa()),
      events: Number(diagnostics.contacts) || 0,
      corrections: Number(diagnostics.corrections) || 0,
      rearmed: Number(diagnostics.rearmed) || 0,
      yields: Number(diagnostics.yields) || 0,
      latched: (Number(diagnostics.activeLatchCount) || 0) > 0,
      finalClearance,
      finalOverlap: Number.isFinite(finalClearance) ? finalClearance < -1e-4 : false,
      lastContact: diagnostics.lastContact ?? null,
      lastCorrection: diagnostics.lastCorrection ?? null,
      diagonalPassed: scenario?.kind === 'diagonal'
        && traveled >= 1
        && (Number(diagnostics.contacts) || 0) <= scenario.baselineContacts + 1,
      emptyPathClear: scenario?.kind === 'empty'
        && traveled >= 1
        && (Number(diagnostics.contacts) || 0) === scenario.baselineContacts,
    },
    interaction: { tConsumed: scenario?.tConsumed === true },
    resources: {
      pedestrianActors: Number(pedestrians.getStats?.().active) || 0,
      activeTimers: 0,
      activeListeners: 0,
      activeProjectiles: 0,
    },
  };
}

function onFootPlayerCollisionProbeForQa() {
  const diagnostics = pedestrians.getOnFootPlayerContactDiagnostics?.();
  return diagnostics?.lastProbe && onFootPedestrianSpaceQaScenario
    && combat?.getState?.().status === 'running'
    && !controls.interiorMode
    && !traffic.isPlayerDriving?.()
    && !passengerRideActive();
}

const onFootPedestrianSpaceQa = Object.freeze({
  stage: stageOnFootPedestrianSpaceQa,
  snapshot: snapshotOnFootPedestrianSpaceQa,
});

function dispatchCombatWitness({ incidentId, residentId } = {}) {
  if (!Number.isInteger(incidentId) || typeof residentId !== 'string') return null;
  const witness = pedestrians.getIncidentWitness?.(residentId, 18) ?? null;
  const reaction = witness
    ? pedestrians.registerWitnessReaction?.(witness.id, {
      originX: witness.victimPosition.x,
      originZ: witness.victimPosition.z,
    }) ?? null
    : null;
  const report = reaction
    ? streetHeat?.reportWitness?.({
      incidentId,
      witnessId: witness.id,
      witnessLabel: witness.label,
      victimId: residentId,
      incidentLabel: 'gunfire',
    }) ?? null
    : null;
  if (!report?.reported) return null;
  streetHeat?.reportIncident?.(8, {
    kind: 'witness-dispatch',
    source: 'combat',
    message: `${witness.label} called in the gunfire · heat +8.`,
  });
  savePlayerProgress();
  return { witness, reaction, report };
}

combat = createCombatLoop({
  scene,
  camera,
  getPlayerPosition: getCombatGroundPosition,
  getPlayerHeading: () => {
    const drivingState = traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null;
    return drivingState
      ? driveByState.aimYaw
      : controls.yaw;
  },
  getMuzzleOrigin: getCombatMuzzleOrigin,
  getPedestrianCandidates: getCombatPedestrianCandidates,
  getTrafficSnapshot: () => traffic.getVehicleLifeSnapshot?.(),
  getTrafficRoot: (index) => traffic.group?.children?.[index] || null,
  getNearestWorldBlocker: getNearestCombatWorldBlocker,
  streetHeat,
  onRecoil: (amount) => {
    if (traffic.isPlayerDriving?.()) {
      driveByState.aimPitch = THREE.MathUtils.clamp(
        driveByState.aimPitch + amount * 0.18,
        -0.36,
        0.25,
      );
    } else {
      controls.pitch = THREE.MathUtils.clamp(controls.pitch - amount, 0.28, 2.45);
    }
  },
  onEvent: ({ kind, message, targetKind, incidentId, residentId, vehicleId, source, amount }) => {
    combatAudio?.play?.(kind, { targetKind });
    if (kind === 'damage') {
      // Authoritative combat damage edge: queue the additive hit-react pose
      // and the bounded camera impulse. No health/economy mutation here.
      registerPlayerHitReaction(playerAvatar, { source, amount, downed: false });
      playerCameraImpulse.trigger({ source, amount, downed: false });
    }
    if (kind === 'downed') {
      registerPlayerHitReaction(playerAvatar, { source, amount: 0, downed: true });
      playerCameraImpulse.trigger({ source, amount: 0, downed: true });
    }
    if (kind === 'impact' && targetKind === 'traffic') {
      const result = traffic.damageTrafficVehicleFromCombat?.(vehicleId) ?? null;
      if (result?.damage) savePlayerProgress();
    }
    if (kind === 'impact' && targetKind === 'pedestrian') {
      if (dispatchCombatWitness({ incidentId, residentId })) return;
    }
    if (kind === 'shot') return;
    if (kind === 'defeat' && targetKind === 'pedestrian') {
      savePlayerProgress();
    } else if (kind === 'restart') {
      clearPlayerVehicleEmbodiment();
      pedestrians.clearCombatAftermathState?.();
      clearSfpdResponderDeploymentHolds();
      sfpdOfficers.clear?.({ resetDefeats: true });
      savePlayerProgress();
    }
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
    // Elevated plaza approach along the Market diagonal so the 45 m evidence
    // ray stays in the public corridor instead of clipping civic massing.
    id: 'sf-evidence:1:0:street-level',
    sectorKey: '1:0',
    entryPortalId: 'sf-portal:ew:0:0',
    camera: Object.freeze({ x: 320, z: -24 }),
    lookAt: Object.freeze({ x: 420, z: 48 }),
    cameraClearance: 9.5,
    lookHeight: 14,
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
    // Battery centerline (on-road) — mid-pyramid look so street + canyon + shaft read.
    id: 'sf-evidence:4:0:street-level',
    sectorKey: '4:0',
    entryPortalId: 'sf-portal:ew:3:0',
    camera: Object.freeze({ x: 1536, z: 228 }),
    lookAt: Object.freeze({ x: 1536, z: 96 }),
    lookHeight: 48,
    cameraClearance: 2.2,
  }),
  Object.freeze({
    // Proven on-road hill approach (pass11b) — look elevated into painted-lady mass.
    id: 'sf-evidence:0:4:street-level',
    sectorKey: '0:4',
    entryPortalId: 'sf-portal:ns:0:3',
    camera: Object.freeze({ x: 96, z: 1668 }),
    lookAt: Object.freeze({ x: -18, z: 1608 }),
    lookHeight: 16,
    cameraClearance: 2.2,
  }),
  Object.freeze({
    // Street approach that keeps Coit on the uphill axis (not sidewalk-skew).
    id: 'sf-evidence:4:4:street-level',
    sectorKey: '4:4',
    entryPortalId: 'sf-portal:ns:4:3',
    camera: Object.freeze({ x: 1528, z: 1504 }),
    lookAt: Object.freeze({ x: 1608, z: 1576 }),
  }),
  Object.freeze({
    // Close Lombard-gate approach — prior (-1404,516) hid gate behind greybox.
    id: 'sf-evidence:-4:1:street-level',
    sectorKey: '-4:1',
    entryPortalId: 'sf-portal:ew:-3:1',
    camera: Object.freeze({ x: -1536, z: 420 }),
    lookAt: Object.freeze({ x: -1542, z: 470 }),
    lookHeight: 10,
    cameraClearance: 2.25,
  }),
]);
let qaStreamingTour = null;

let sceneTransitioning = false;
const interiorShadowRefresh = {
  requests: 0,
  lastReason: null,
};

function requestInteriorShadowRefresh(reason) {
  // Interior rooms are now staged outside the exterior shadow camera volume,
  // so toggling them cannot change the cached directional atlas. Keep the
  // request telemetry for diagnostics without paying a full shadow render on
  // every enter/exit or flagship hotspot action.
  interiorShadowRefresh.requests += 1;
  interiorShadowRefresh.lastReason = reason;
}

const weatherModes = ['clear', 'fog', 'drizzle'];
let weatherIndex = 0;
let weatherMode = 'clear';
let beautyMode = false;
// Graded hill sectors need longer clear-weather sightlines so Coit and street
// grade stay readable without the marine layer wiping the uphill landmark.
const HILL_VIEW_FOG_SECTORS = Object.freeze({
  '4:0': Object.freeze({ fogNear: 110, fogFar: 520 }),
  '4:4': Object.freeze({ fogNear: 102, fogFar: 418 }),
  '0:4': Object.freeze({ fogNear: 120, fogFar: 480 }),
});

const lightingProfiles = {
  clear: {
    sun: 4.0,
    sunColor: new THREE.Color(0xffc48b),
    hemisphere: 1.0,
    skyColor: new THREE.Color(0xb7d7ef),
    groundColor: new THREE.Color(0x302824),
    skyTopColor: new THREE.Color(0x5b789e),
    skyHorizonColor: new THREE.Color(0xe3b8a0),
    skySunColor: new THREE.Color(0xffd0a0),
    rim: 0.36,
    rimColor: new THREE.Color(0x7ba9dc),
    fogColor: new THREE.Color(0x87999d),
    fogNear: 84,
    fogFar: 286,
    backgroundColor: new THREE.Color(0x4b667b),
    exposure: 1.12,
    environment: 0.3,
    bloom: 0.085,
    saturation: 1.12,
    contrast: 1.08,
    warmth: 0.03,
    wetness: 0,
    wetSurface: 0,
    weatherMix: 0,
    atmosphere: 0,
    vignette: 0.055,
    sunPulse: 0.06,
  },
  fog: {
    sun: 1.62,
    sunColor: new THREE.Color(0xdce1e3),
    hemisphere: 1.02,
    skyColor: new THREE.Color(0xc4d0d3),
    groundColor: new THREE.Color(0x4a4d4b),
    skyTopColor: new THREE.Color(0x64737f),
    skyHorizonColor: new THREE.Color(0x8d9998),
    skySunColor: new THREE.Color(0xa4acab),
    rim: 0.3,
    rimColor: new THREE.Color(0x9fb3be),
    fogColor: new THREE.Color(0x93a2a2),
    fogNear: 42,
    fogFar: 168,
    backgroundColor: new THREE.Color(0x16242d),
    exposure: 0.96,
    environment: 0.36,
    bloom: 0.095,
    saturation: 0.97,
    contrast: 0.99,
    warmth: -0.004,
    wetness: 0.12,
    wetSurface: 0,
    weatherMix: 0.68,
    atmosphere: 0.58,
    vignette: 0.085,
    sunPulse: 0.025,
  },
  drizzle: {
    sun: 0.92,
    sunColor: new THREE.Color(0xb8c8d0),
    hemisphere: 1.04,
    skyColor: new THREE.Color(0x9eb7c2),
    groundColor: new THREE.Color(0x343d3e),
    skyTopColor: new THREE.Color(0x536779),
    skyHorizonColor: new THREE.Color(0x8c9b9f),
    skySunColor: new THREE.Color(0xa7b4b4),
    rim: 0.26,
    rimColor: new THREE.Color(0x7995a3),
    fogColor: new THREE.Color(0x7f929b),
    fogNear: 58,
    fogFar: 222,
    backgroundColor: new THREE.Color(0x101f2b),
    exposure: 0.88,
    environment: 0.4,
    bloom: 0.072,
    saturation: 0.9,
    contrast: 1.02,
    warmth: -0.01,
    wetness: 1,
    wetSurface: 1,
    weatherMix: 1,
    atmosphere: 0.82,
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
    weatherMix: lightingProfiles.clear.weatherMix,
    atmosphere: lightingProfiles.clear.atmosphere,
    vignette: lightingProfiles.clear.vignette,
  },
};

// Time-of-day keyframes layered over the weather presentation. The life clock
// moves quickly, so a full 05:00-22:00 arc makes a short session visibly pass
// from morning through golden hour without touching the weather system.
const TIME_OF_DAY_STOPS = Object.freeze([
  Object.freeze({
    hour: 5,
    light: 0.4,
    exposure: 0.72,
    sunColor: 0xff9a70,
    hemisphere: 0.72,
    skyTop: 0x3c4c68,
    skyHorizon: 0xc98f7a,
    skySun: 0xffb08a,
    saturation: 0.95,
    warmth: 0.012,
  }),
  Object.freeze({
    hour: 7,
    light: 1,
    exposure: 1,
    sunColor: 0xffc48b,
    hemisphere: 1,
    skyTop: 0x5b789e,
    skyHorizon: 0xe3b8a0,
    skySun: 0xffd0a0,
    saturation: 1,
    warmth: 0.02,
  }),
  Object.freeze({
    hour: 12,
    light: 1.12,
    exposure: 1.07,
    sunColor: 0xfff0d8,
    hemisphere: 1.06,
    skyTop: 0x5f86ad,
    skyHorizon: 0xd3d8d4,
    skySun: 0xfff6e2,
    saturation: 1.02,
    warmth: -0.008,
  }),
  Object.freeze({
    hour: 17,
    light: 1.02,
    exposure: 1.04,
    sunColor: 0xffb066,
    hemisphere: 1,
    skyTop: 0x5878a0,
    skyHorizon: 0xe0a878,
    skySun: 0xffc080,
    saturation: 1.05,
    warmth: 0.024,
  }),
  Object.freeze({
    hour: 19.5,
    light: 0.34,
    exposure: 0.72,
    sunColor: 0xe8704f,
    hemisphere: 0.58,
    skyTop: 0x31445f,
    skyHorizon: 0xb06a5a,
    skySun: 0xff9d70,
    saturation: 0.92,
    warmth: 0.032,
  }),
  Object.freeze({
    hour: 22,
    light: 0.14,
    exposure: 0.62,
    sunColor: 0x8fa3c9,
    hemisphere: 0.48,
    skyTop: 0x111a2a,
    skyHorizon: 0x22314a,
    skySun: 0xb7c6e4,
    saturation: 0.85,
    warmth: -0.02,
  }),
]);

const timeOfDayTemps = {
  sunColor: new THREE.Color(),
  skyTop: new THREE.Color(),
  skyHorizon: new THREE.Color(),
  skySun: new THREE.Color(),
  scratchA: new THREE.Color(),
  scratchB: new THREE.Color(),
};

function sampleTimeOfDay(hour) {
  const safe = Number.isFinite(hour) ? hour : 7;
  const wrapped = ((safe % 24) + 24) % 24;
  const stops = TIME_OF_DAY_STOPS;
  let before = stops[stops.length - 1];
  let after = stops[0];
  if (wrapped <= stops[0].hour || wrapped >= stops[stops.length - 1].hour) {
    before = stops[stops.length - 1];
    after = stops[0];
    const spanWrap = (after.hour + 24 - before.hour) % 24;
    const rawWrap = ((wrapped - before.hour + 24) % 24) / Math.max(0.001, spanWrap);
    const blendWrap = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp(rawWrap, 0, 1), 0, 1);
    const lerpValueWrap = (a, b) => THREE.MathUtils.lerp(a, b, blendWrap);
    timeOfDayTemps.sunColor.copy(
      timeOfDayTemps.scratchA.set(before.sunColor).lerp(
        timeOfDayTemps.scratchB.set(after.sunColor),
        blendWrap,
      ),
    );
    timeOfDayTemps.skyTop.copy(
      timeOfDayTemps.scratchA.set(before.skyTop).lerp(
        timeOfDayTemps.scratchB.set(after.skyTop),
        blendWrap,
      ),
    );
    timeOfDayTemps.skyHorizon.copy(
      timeOfDayTemps.scratchA.set(before.skyHorizon).lerp(
        timeOfDayTemps.scratchB.set(after.skyHorizon),
        blendWrap,
      ),
    );
    timeOfDayTemps.skySun.copy(
      timeOfDayTemps.scratchA.set(before.skySun).lerp(
        timeOfDayTemps.scratchB.set(after.skySun),
        blendWrap,
      ),
    );
    return {
      light: lerpValueWrap(before.light, after.light),
      exposure: lerpValueWrap(before.exposure, after.exposure),
      hemisphere: lerpValueWrap(before.hemisphere, after.hemisphere),
      saturation: lerpValueWrap(before.saturation, after.saturation),
      warmth: lerpValueWrap(before.warmth, after.warmth),
      sunColor: timeOfDayTemps.sunColor,
      skyTop: timeOfDayTemps.skyTop,
      skyHorizon: timeOfDayTemps.skyHorizon,
      skySun: timeOfDayTemps.skySun,
    };
  }
  for (let index = 0; index < stops.length - 1; index += 1) {
      if (wrapped >= stops[index].hour && wrapped <= stops[index + 1].hour) {
        before = stops[index];
        after = stops[index + 1];
        break;
      }
    }
  const span = Math.max(0.001, after.hour - before.hour);
  const raw = (wrapped - before.hour) / span;
  const blend = THREE.MathUtils.smoothstep(raw, 0, 1);
  const lerpValue = (a, b) => THREE.MathUtils.lerp(a, b, blend);
  timeOfDayTemps.sunColor.copy(
    timeOfDayTemps.scratchA.set(before.sunColor).lerp(
      timeOfDayTemps.scratchB.set(after.sunColor),
      blend,
    ),
  );
  timeOfDayTemps.skyTop.copy(
    timeOfDayTemps.scratchA.set(before.skyTop).lerp(
      timeOfDayTemps.scratchB.set(after.skyTop),
      blend,
    ),
  );
  timeOfDayTemps.skyHorizon.copy(
    timeOfDayTemps.scratchA.set(before.skyHorizon).lerp(
      timeOfDayTemps.scratchB.set(after.skyHorizon),
      blend,
    ),
  );
  timeOfDayTemps.skySun.copy(
    timeOfDayTemps.scratchA.set(before.skySun).lerp(
      timeOfDayTemps.scratchB.set(after.skySun),
      blend,
    ),
  );
  return {
    light: lerpValue(before.light, after.light),
    exposure: lerpValue(before.exposure, after.exposure),
    hemisphere: lerpValue(before.hemisphere, after.hemisphere),
    saturation: lerpValue(before.saturation, after.saturation),
    warmth: lerpValue(before.warmth, after.warmth),
    sunColor: timeOfDayTemps.sunColor,
    skyTop: timeOfDayTemps.skyTop,
    skyHorizon: timeOfDayTemps.skyHorizon,
    skySun: timeOfDayTemps.skySun,
  };
}

function applyTimeOfDayPresentation(hour) {
  const sample = sampleTimeOfDay(hour);
  const interiorBlend = interiorPresentation.current;
  const exteriorKey = THREE.MathUtils.lerp(1, 0.08, interiorBlend);
  const exteriorFill = THREE.MathUtils.lerp(1, 0.42, interiorBlend);
  sun.intensity = Math.max(0.04, sun.intensity * sample.light * exteriorKey);
  sun.color.copy(sample.sunColor);
  hemisphere.intensity = Math.max(0.04, hemisphere.intensity * sample.hemisphere * exteriorFill);
  if (proceduralSkyMaterial?.uniforms) {
    proceduralSkyMaterial.uniforms.topColor.value.copy(sample.skyTop);
    proceduralSkyMaterial.uniforms.horizonColor.value.copy(sample.skyHorizon);
    proceduralSkyMaterial.uniforms.sunColor.value.copy(sample.skySun);
  }
  const beautyBoost = beautyMode ? 1 : 0;
  renderer.toneMappingExposure = Math.max(
    0.08,
    renderer.toneMappingExposure * sample.exposure * (1 + beautyBoost * 0.035),
  );
  cinematicGradePass.uniforms.uSaturation.value *= sample.saturation;
  cinematicGradePass.uniforms.uWarmth.value = THREE.MathUtils.lerp(
    cinematicGradePass.uniforms.uWarmth.value,
    sample.warmth,
    0.6,
  );
  const wrappedHour = ((hour % 24) + 24) % 24;
  // Dusk ramps 17→22, full night through dawn, then fades by 07:00.
  const nightAmount = wrappedHour >= 22 || wrappedHour < 5.5
    ? 1
    : wrappedHour < 7
      ? 1 - (wrappedHour - 5.5) / 1.5
      : wrappedHour < 17
        ? 0
        : (wrappedHour - 17) / 5;
  city.setNightLighting?.(nightAmount);
  streaming.setNightLighting?.(nightAmount);
  traffic.setNightLighting?.(nightAmount);
  expansion?.setNightLighting?.(nightAmount);
  nightFill.intensity = nightAmount * (2.1 + (Math.sin(performance.now() * 0.0012) * 0.06));
  nightFill.position.set(
    controls.target.x,
    (controls.target.y ?? 2) + 3.4,
    controls.target.z,
  );
  nightFill.color.setHSL(
    0.075,
    nightAmount > 0.2 ? 0.72 : 0.5,
    nightAmount > 0.2 ? 0.6 : 0.45,
  );
  // Soften and eventually drop sun shadows once street lamps own the fill.
  sun.castShadow = nightAmount < 0.88;
  sun.shadow.radius = THREE.MathUtils.lerp(2.2, 3.8, nightAmount);
  if (nightAmount > 0.35) renderer.shadowMap.needsUpdate = true;
}

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
    if (proceduralSkyMaterial.uniforms.uWeatherMix) {
      proceduralSkyMaterial.uniforms.uWeatherMix.value = THREE.MathUtils.lerp(
        from.weatherMix,
        profile.weatherMix,
        blend,
      );
    }
  }
  rim.intensity = THREE.MathUtils.lerp(from.rim, profile.rim, blend) * exteriorRim;
  rim.color.copy(from.rimColor).lerp(profile.rimColor, blend);
  scene.fog.color.copy(from.fogColor).lerp(profile.fogColor, blend);
  scene.fog.near = THREE.MathUtils.lerp(from.fogNear, profile.fogNear, blend);
  scene.fog.far = THREE.MathUtils.lerp(from.fogFar, profile.fogFar, blend);
  scene.background.copy(from.backgroundColor).lerp(profile.backgroundColor, blend);
  const beautyBoost = beautyMode ? 1 : 0;
  renderer.toneMappingExposure = THREE.MathUtils.lerp(from.exposure, profile.exposure, blend)
    * (1 + beautyBoost * 0.055);
  scene.environmentIntensity = THREE.MathUtils.lerp(from.environment, profile.environment, blend)
    * THREE.MathUtils.lerp(1, 1.1, interiorBlend);
  bloomPass.strength = THREE.MathUtils.lerp(from.bloom, profile.bloom, blend);
  cinematicGradePass.uniforms.uSaturation.value = THREE.MathUtils.lerp(
    from.saturation,
    profile.saturation,
    blend,
  ) * (1 + beautyBoost * 0.09);
  cinematicGradePass.uniforms.uContrast.value = THREE.MathUtils.lerp(
    from.contrast,
    profile.contrast,
    blend,
  ) * (1 + beautyBoost * 0.055);
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
  cinematicGradePass.uniforms.uAtmosphere.value = THREE.MathUtils.lerp(
    from.atmosphere,
    profile.atmosphere,
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
    weatherTransition.from.weatherMix = proceduralSkyMaterial.uniforms.uWeatherMix?.value ?? 0;
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
  weatherTransition.from.atmosphere = cinematicGradePass.uniforms.uAtmosphere.value;
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
  applyHillViewFogExtension(streaming.stats?.focusSector ?? null);
  if (weatherTransition.elapsed >= weatherTransition.duration) {
    weatherSurfaceTransition.active = false;
    weatherUniformTransition.active = false;
  }
}

function applyHillViewFogExtension(focusSector) {
  if (!scene.fog || weatherMode !== 'clear') return;
  const hillFog = HILL_VIEW_FOG_SECTORS[focusSector];
  if (!hillFog) return;
  scene.fog.near = Math.max(scene.fog.near, hillFog.fogNear);
  scene.fog.far = Math.max(scene.fog.far, hillFog.fogFar);
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
const traversalCameraRay = new THREE.Vector3();
const traversalCameraFocusTarget = new THREE.Vector3();
const onFootVehicleSweepStart = new THREE.Vector3();

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

function beginTraversalCameraTransition(mode) {
  traversalCameraMode = mode === 'drive' ? 'drive' : 'walk';
  traversalCameraTransitionRemaining = TRAVERSAL_CAMERA_TRANSITION_SECONDS;
  previousCameraTarget.copy(controls.target);
  cameraVelocity.set(0, 0, 0);
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
  const citySafeCamera = city.resolveCameraPosition?.(controls.focus, desiredCamera) || desiredCamera;
  const safeCamera = streaming.resolveCameraPosition?.(controls.focus, citySafeCamera) || citySafeCamera;
  camera.position.copy(safeCamera);
  if (!controls.interiorMode) resolveTraversalCameraFrame(controls.focus, camera.position);
  lookTarget.copy(controls.target);
  camera.lookAt(lookTarget);
  camera.updateMatrixWorld(true);
}

function readTraversalCameraState() {
  const driving = traffic.isPlayerDriving?.() === true;
  const actualDistance = camera.position.distanceTo(controls.focus);
  traversalCameraRay.copy(camera.position).sub(controls.focus);
  const rayLength = traversalCameraRay.length();
  const blocker = rayLength > 1e-5
    ? getNearestCombatWorldBlocker(
      controls.focus,
      traversalCameraRay.multiplyScalar(1 / rayLength),
      rayLength + 4,
    )
    : null;
  const avatarSurface = playerAvatar?.visible
    ? getTraversalSurfaceHeight(playerAvatar.position)
    : null;
  const cameraSurface = getTraversalSurfaceHeight(camera.position);
  return {
    mode: controls.interiorMode
      ? 'interior'
      : combatCameraState.active
        ? 'aim'
        : driving ? 'drive' : 'walk',
    requestedDistance: controls.distance,
    actualDistance,
    pitch: controls.pitch,
    yaw: controls.yaw,
    camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    cameraSurface,
    cameraSurfaceClearance: Number.isFinite(cameraSurface)
      ? camera.position.y - cameraSurface
      : null,
    focus: { x: controls.focus.x, y: controls.focus.y, z: controls.focus.z },
    blocker: blocker ? {
      source: blocker.source,
      distance: blocker.distance,
      clearance: blocker.distance - actualDistance,
    } : null,
    transition: {
      mode: traversalCameraMode,
      active: traversalCameraTransitionRemaining > 0,
      remaining: traversalCameraTransitionRemaining,
    },
    avatar: playerAvatar ? {
      visible: playerAvatar.visible,
      position: {
        x: playerAvatar.position.x,
        y: playerAvatar.position.y,
        z: playerAvatar.position.z,
      },
      groundResidual: Number.isFinite(avatarSurface)
        ? Math.abs(playerAvatar.position.y - (avatarSurface + PLAYER_GROUND_OFFSET))
        : null,
      locomotion: {
        moving: playerAvatarLocomotionState.moving,
        facingYaw: playerAvatar.userData?.rig?.rotation?.y
          ?? playerAvatarLocomotionState.facingYaw,
        targetYaw: playerAvatarLocomotionState.targetYaw,
        facingErrorRadians: playerAvatarLocomotionState.facingErrorRadians,
        displacement: {
          x: playerAvatarLocomotionState.displacementX,
          z: playerAvatarLocomotionState.displacementZ,
          length: playerAvatarLocomotionState.displacement,
        },
      },
    } : null,
  };
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
  const cameraClearance = Number.isFinite(spec.cameraClearance)
    ? spec.cameraClearance
    : QA_EVIDENCE_CAMERA_CLEARANCE;
  const lookHeight = Number.isFinite(spec.lookHeight)
    ? spec.lookHeight
    : QA_EVIDENCE_LOOK_HEIGHT;
  const cameraPosition = new THREE.Vector3(
    spec.camera.x,
    cameraSurface + cameraClearance,
    spec.camera.z,
  );
  const lookAt = new THREE.Vector3(
    spec.lookAt.x,
    lookSurface + lookHeight,
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
    customHeights: Number.isFinite(spec.cameraClearance) || Number.isFinite(spec.lookHeight),
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
  const surfaceHeight = getTraversalSurfaceHeight({ x, z });
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
  const hasView = ['yaw', 'pitch', 'distance'].some((key) => position?.[key] !== undefined);
  if (hasView) {
    if (!Number.isFinite(position?.yaw)
      || !Number.isFinite(position?.pitch)
      || !Number.isFinite(position?.distance)) {
      throw new TypeError('Roam view requires finite yaw, pitch, and distance values.');
    }
    controls.yaw = THREE.MathUtils.euclideanModulo(position.yaw + Math.PI, Math.PI * 2) - Math.PI;
    controls.pitch = THREE.MathUtils.clamp(position.pitch, 0.28, 2.45);
    controls.distance = THREE.MathUtils.clamp(position.distance, 12, 180);
    snapCameraToControls();
  }
  exportPlayerWorldState();
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
  if (!stop.customHeights) {
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
  const visiblePedestrianCount = pedestrians.getStats?.().visible ?? 0;
  if (coreSimulationActive || visiblePedestrianCount > 0) {
    verificationErrors.push('authored core pedestrian group remains active outside sector 0:0');
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
      trafficVisible: traffic.getStats?.().visible ?? 0,
      pedestriansVisible: visiblePedestrianCount,
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

function combatAimActive() {
  return Boolean(
    combat?.getState?.().aiming
      && playerLayerActive
      && !controls.interiorMode
      && !vehicleEmbodimentTransitionActive()
      && !beautyMode
      && !qaCameraPose,
  );
}

function syncCombatCameraMode() {
  const aiming = combatAimActive();
  if (aiming && !combatCameraState.active) {
    combatCameraState.active = true;
    const drivingState = traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null;
    combatCameraState.justActivated = !drivingState;
    driveByState.justActivated = Boolean(drivingState);
    if (drivingState) {
      driveByState.aimYaw = drivingState.heading;
      driveByState.aimPitch = 0;
    }
    combatCameraState.savedPitch = lastPublicWorldState?.pitch ?? controls.pitch;
    combatCameraState.savedDistance = lastPublicWorldState?.distance ?? controls.distance;
    combatCameraState.savedCameraPitch = controls.cameraPitch;
    combatCameraState.savedCameraDistance = controls.cameraDistance;
  } else if (!aiming && combatCameraState.active) {
    combatCameraState.active = false;
    combatCameraState.justActivated = false;
    driveByState.active = false;
    driveByState.justActivated = false;
    if (driveByRig) driveByRig.visible = false;
    // Keep the heading acquired during aim. Only the ordinary orbit pitch and
    // distance are restored; the next orbit frame eases back from the current
    // shoulder view without snapping the player to the pre-aim yaw.
    controls.pitch = combatCameraState.savedPitch;
    controls.distance = combatCameraState.savedDistance;
    controls.cameraYaw = controls.yaw;
    controls.cameraPitch = combatCameraState.savedCameraPitch;
    controls.cameraDistance = combatCameraState.savedCameraDistance;
    controls.focus.copy(controls.target);
    previousCameraTarget.copy(controls.target);
    cameraVelocity.set(0, 0, 0);
  }
  return aiming;
}

function combatCameraVehicleClearance(position) {
  let clearance = Infinity;
  for (const vehicle of traffic.getVehicleLifeSnapshot?.()?.vehicles || []) {
    if (vehicle?.visible === false || !vehicle?.position) continue;
    const dx = position.x - vehicle.position.x;
    const dz = position.z - vehicle.position.z;
    const heading = Number(vehicle.heading) || 0;
    const localX = dx * Math.cos(heading) - dz * Math.sin(heading);
    const localZ = dx * Math.sin(heading) + dz * Math.cos(heading);
    const halfWidth = vehicle.class === 'bus' || vehicle.class === 'truck' ? 1.55 : 1.15;
    const halfLength = vehicle.class === 'bus' ? 5.2
      : vehicle.class === 'truck' ? 3.5
        : vehicle.class === 'van' || vehicle.class === 'suv' ? 2.7 : 2.45;
    const outsideX = Math.max(0, Math.abs(localX) - halfWidth);
    const outsideZ = Math.max(0, Math.abs(localZ) - halfLength);
    const horizontal = Math.hypot(outsideX, outsideZ);
    const roof = (vehicle.position.y ?? 0) + (vehicle.class === 'bus' ? 3.1 : 1.9);
    const vertical = position.y > roof ? position.y - roof : 0;
    const candidate = Math.hypot(horizontal, vertical);
    if (candidate < clearance) clearance = candidate;
  }
  return clearance;
}

function updateCombatShoulderCamera(dt) {
  // The shoulder camera keeps a bounded pitch so vertical RMB/Q aim changes
  // the same center-screen ray used by combat without allowing a flip.
  controls.pitch = THREE.MathUtils.clamp(controls.pitch, 0.3, 1.35);
  getCombatGroundPosition(combatGroundPosition);
  combatForward.set(Math.sin(controls.yaw), 0, Math.cos(controls.yaw));
  combatRight.set(combatForward.z, 0, -combatForward.x);
  combatAimAnchor.set(
    combatGroundPosition.x,
    combatGroundPosition.y + 1.48,
    combatGroundPosition.z,
  );
  combatAimPosition.copy(combatAimAnchor)
    .addScaledVector(combatRight, COMBAT_SHOULDER_CAMERA_SIDE)
    .addScaledVector(combatForward, -COMBAT_SHOULDER_CAMERA_BACK);
  combatAimPosition.y = combatGroundPosition.y + COMBAT_SHOULDER_CAMERA_HEIGHT;
  combatAimLookTarget.copy(combatAimAnchor)
    .addScaledVector(combatRight, COMBAT_SHOULDER_LOOK_SIDE)
    .addScaledVector(combatForward, COMBAT_SHOULDER_LOOK_DISTANCE);
  combatAimLookTarget.y = THREE.MathUtils.clamp(
    combatGroundPosition.y + COMBAT_SHOULDER_LOOK_HEIGHT
      + (combatCameraState.savedPitch - controls.pitch) * COMBAT_SHOULDER_PITCH_SCALE,
    combatGroundPosition.y + 0.72,
    combatGroundPosition.y + 2.8,
  );
  const citySafeCamera = city.resolveCameraPosition?.(combatAimAnchor, combatAimPosition)
    || combatAimPosition;
  let safeCamera = streaming.resolveCameraPosition?.(combatAimAnchor, citySafeCamera)
    || citySafeCamera;
  if (combatCameraVehicleClearance(safeCamera) < 0.45) {
    combatAimPosition.copy(combatAimAnchor)
      .addScaledVector(combatRight, -COMBAT_SHOULDER_CAMERA_SIDE)
      .addScaledVector(combatForward, -COMBAT_SHOULDER_CAMERA_BACK);
    combatAimPosition.y = combatGroundPosition.y + COMBAT_SHOULDER_CAMERA_HEIGHT;
    const oppositeCitySafe = city.resolveCameraPosition?.(combatAimAnchor, combatAimPosition)
      || combatAimPosition;
    const oppositeSafe = streaming.resolveCameraPosition?.(combatAimAnchor, oppositeCitySafe)
      || oppositeCitySafe;
    if (combatCameraVehicleClearance(oppositeSafe) > combatCameraVehicleClearance(safeCamera)) {
      safeCamera = oppositeSafe;
    }
  }
  if (combatCameraState.justActivated) camera.position.copy(safeCamera);
  else camera.position.lerp(safeCamera, 1 - Math.exp(-18 * dt));
  if (combatCameraVehicleClearance(camera.position) < 0.35) camera.position.copy(safeCamera);
  resolveTraversalCameraFrame(combatAimAnchor, camera.position);
  combatCameraState.justActivated = false;
  camera.lookAt(combatAimLookTarget);
  camera.updateMatrixWorld(true);
  controls.cameraYaw = controls.yaw;
  controls.cameraPitch = controls.pitch;
  controls.cameraDistance = camera.position.distanceTo(combatAimAnchor);
  hud?.setCameraState({ mode: 'aim / shoulder', distance: controls.cameraDistance });
}

function updateRoamTarget(dt, qaTourActive, drivingActive, axis) {
  if (passengerRideActive()) return;
  const moveSpeed = controls.keys.has('shiftleft') || controls.keys.has('shiftright') ? 9.5 : 5.6;
  if (!qaTourActive
    && !drivingActive
    && combat?.getState?.().status === 'running'
    && axis.lengthSq() > 0) {
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
      city.resolveInteriorPosition?.(controls.target);
    } else {
      controls.target.y = THREE.MathUtils.clamp(controls.target.y, 2, 46);
    }
  }

  if (!controls.interiorMode) {
    const streamedSurface = getTraversalSurfaceHeight(controls.target);
    if (Number.isFinite(streamedSurface)) {
      // The core follows the same authored street grade as its asphalt meshes;
      // streamed sectors fall back to their continuous terrain datum.
      controls.target.y = THREE.MathUtils.damp(
        controls.target.y,
        streamedSurface + QA_ROAM_CLEARANCE,
        7,
        dt,
      );
    }
    const collisionSafeTarget = streaming.resolveRoamPosition?.(controls.target);
    if (collisionSafeTarget && collisionSafeTarget !== controls.target) {
      controls.target.copy(collisionSafeTarget);
    }
  }
}

function updateCamera(dt) {
  const aiming = syncCombatCameraMode();
  if (qaCameraPose) {
    previousCameraTarget.copy(controls.target);
    cameraVelocity.set(0, 0, 0);
    camera.position.copy(qaCameraPose.position);
    camera.lookAt(qaCameraPose.lookAt);
    camera.updateMatrixWorld(true);
    return;
  }
  const qaTourActive = updateQaStreamingTour(dt);
  const drivingActive = traffic.isPlayerDriving?.() === true;
  traversalCameraTransitionRemaining = Math.max(
    0,
    traversalCameraTransitionRemaining - Math.max(0, dt),
  );
  const transitionLocked = vehicleEmbodimentTransitionActive();
  const axis = cameraAxis.set(
    transitionLocked ? 0 : (controls.keys.has('keyd') ? 1 : 0) - (controls.keys.has('keya') ? 1 : 0),
    0,
    transitionLocked ? 0 : (controls.keys.has('keys') ? 1 : 0) - (controls.keys.has('keyw') ? 1 : 0),
  );
  // Apply the same on-foot target movement before either camera presentation;
  // aiming changes framing, not locomotion.
  updateRoamTarget(dt, qaTourActive, drivingActive || transitionLocked, axis);
  if (aiming) {
    const drivingState = drivingActive ? traffic.getPlayerVehicleState?.() : null;
    if (drivingState) updateDriveByCamera(dt, drivingState);
    else updateCombatShoulderCamera(dt);
    return;
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

  if (controls.interiorMode) {
    controls.pitch = THREE.MathUtils.clamp(controls.pitch, 0.28, 2.2);
    controls.distance = THREE.MathUtils.clamp(controls.distance, 3.1, 8.5);
  } else if (qaTourActive) {
    controls.pitch = THREE.MathUtils.clamp(controls.pitch, 0.28, 2.45);
    controls.distance = THREE.MathUtils.clamp(controls.distance, 12, 180);
  } else if (drivingActive) {
    controls.pitch = THREE.MathUtils.clamp(
      controls.pitch,
      DRIVE_CAMERA_PITCH_MIN,
      DRIVE_CAMERA_PITCH_MAX,
    );
    controls.distance = THREE.MathUtils.clamp(
      controls.distance,
      DRIVE_CAMERA_DISTANCE_MIN,
      DRIVE_CAMERA_DISTANCE_MAX,
    );
  } else {
    controls.pitch = THREE.MathUtils.clamp(
      controls.pitch,
      WALK_CAMERA_PITCH_MIN,
      WALK_CAMERA_PITCH_MAX,
    );
    controls.distance = THREE.MathUtils.clamp(
      controls.distance,
      WALK_CAMERA_DISTANCE_MIN,
      WALK_CAMERA_DISTANCE_MAX,
    );
  }
  traversalCameraFocusTarget.copy(controls.target);
  if (!controls.interiorMode && !qaTourActive && !drivingActive) {
    const surface = getTraversalSurfaceHeight(controls.target);
    if (Number.isFinite(surface)) {
      traversalCameraFocusTarget.y = surface + WALK_CAMERA_FOCUS_HEIGHT;
    }
  }
  controls.focus.lerp(traversalCameraFocusTarget, 1 - Math.exp(-13 * dt));
  controls.cameraYaw = dampAngle(controls.cameraYaw, controls.yaw, 18, dt);
  controls.cameraPitch = THREE.MathUtils.damp(controls.cameraPitch, controls.pitch, 18, dt);
  controls.cameraDistance = THREE.MathUtils.damp(controls.cameraDistance, controls.distance, 14, dt);
  controls.spherical.set(controls.cameraDistance, controls.cameraPitch, controls.cameraYaw);
  desiredCamera.copy(controls.focus).add(controlOffset.setFromSpherical(controls.spherical));
  const citySafeCamera = city.resolveCameraPosition?.(controls.focus, desiredCamera) || desiredCamera;
  const safeCamera = streaming.resolveCameraPosition?.(controls.focus, citySafeCamera) || citySafeCamera;
  const cameraFollowLambda = controls.interiorMode
    ? 18
    : qaTourActive
      ? 14
      : traversalCameraTransitionRemaining > 0 ? 8 : 12;
  camera.position.lerp(safeCamera, 1 - Math.exp(-cameraFollowLambda * dt));
  if (!controls.interiorMode && !qaTourActive) {
    resolveTraversalCameraFrame(controls.focus, camera.position);
  }
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

// Bounded inbound-damage camera kick, applied after the normal camera solve
// and re-clamped by the existing collision-safe resolver. Suppressed entirely
// under explicit QA camera poses, interiors, driving, and beauty shots; it
// never mutates controls.target or any persisted world/camera state.
function applyPlayerDamageCameraImpulse(dt) {
  const suppressed = Boolean(
    qaCameraPose
      || beautyMode
      || controls.interiorMode
      || traffic.isPlayerDriving?.() === true,
  );
  return playerCameraImpulse.apply(camera, dt, {
    suppressed,
    focus: controls.focus,
    resolveFrame: suppressed || controls.interiorMode
      ? null
      : resolveTraversalCameraFrame,
  });
}

function combatInputAvailable() {
  return Boolean(
    combat
      && playerLayerActive
      && !controls.interiorMode
      && !vehicleEmbodimentTransitionActive()
      && !passengerRideActive()
      && !beautyMode
      && (!qaCameraPose || Boolean(sfpdOfficerQaScenario)),
  );
}

function onFootSurrenderInputAvailable() {
  const heatState = streetHeat?.getState?.();
  return Boolean(
    playerLayerActive
      && !controls.interiorMode
      && !traffic.isPlayerDriving?.()
      && !passengerRideActive()
      && combat?.getState?.().status === 'running'
      && heatState?.pursuitActive
      && !beautyMode
      && (!qaCameraPose || Boolean(sfpdOfficerQaScenario)),
  );
}

function onFootPursuitActive() {
  return Boolean(
    !traffic.isPlayerDriving?.()
      && streetHeat?.getState?.().pursuitActive,
  );
}

const REST_ANCHOR_RADIUS = 4.6;
const restAnchorMatrix = new THREE.Matrix4();
const restAnchorPosition = new THREE.Vector3();

function getNearestRestAnchor(position = controls.target, radius = REST_ANCHOR_RADIUS) {
  let nearest = null;
  scene.updateMatrixWorld(true);
  scene.traverseVisible((object) => {
    if (!/bench/i.test(String(object.name || ''))) return;
    const consider = (anchorPosition, instanceId = null) => {
      const distance = Math.hypot(
        anchorPosition.x - position.x,
        anchorPosition.z - position.z,
      );
      if (distance > radius || (nearest && distance >= nearest.distance)) return;
      nearest = {
        label: object.name,
        distance,
        instanceId,
        position: {
          x: anchorPosition.x,
          y: anchorPosition.y,
          z: anchorPosition.z,
        },
      };
    };
    if (object.isInstancedMesh) {
      for (let index = 0; index < object.count; index += 1) {
        object.getMatrixAt(index, restAnchorMatrix);
        restAnchorPosition.setFromMatrixPosition(restAnchorMatrix).applyMatrix4(object.matrixWorld);
        consider(restAnchorPosition, index);
      }
      return;
    }
    object.getWorldPosition(restAnchorPosition);
    consider(restAnchorPosition);
  });
  return nearest;
}

function getPlayerRestContext() {
  const combatState = combat?.getState?.();
  const heatState = streetHeat?.getState?.();
  const lifeState = lifeSim?.getState?.();
  const anchor = getNearestRestAnchor();
  return {
    onFoot: traffic.isPlayerDriving?.() !== true && !passengerRideActive(),
    outdoor: playerLayerActive && !controls.interiorMode && !beautyMode && !qaCameraPose,
    stationary: !playerMoving(),
    recovered: combatState?.status === 'running' && combatState?.active === true,
    clearOfPursuit: heatState?.pursuitActive !== true,
    atRestAnchor: Boolean(anchor),
    activeContract: Boolean(
      lifeState?.workShift?.active
      || lifeState?.residentFavor?.active
      || lifeState?.deliveryRun?.active,
    ),
    anchor,
  };
}

function getPlayerMarketInteractionContext() {
  const combatState = combat?.getState?.();
  const heatState = streetHeat?.getState?.();
  const lifeState = lifeSim?.getState?.();
  return {
    onFoot: traffic.isPlayerDriving?.() !== true && !passengerRideActive(),
    outdoor: playerLayerActive && !controls.interiorMode && !beautyMode && !qaCameraPose,
    stationary: !playerMoving(),
    recovered: combatState?.status === 'running' && combatState?.active === true,
    clearOfPursuit: heatState?.pursuitActive !== true,
    activeContract: Boolean(
      lifeState?.workShift?.active
      || lifeState?.residentFavor?.active
      || lifeState?.deliveryRun?.active,
    ),
    position: {
      x: controls.target.x,
      y: controls.target.y,
      z: controls.target.z,
    },
  };
}

function restPlayerAtBench() {
  const combatState = combat?.getState?.();
  const heatState = streetHeat?.getState?.();
  const lifeState = lifeSim?.getState?.();
  if (traffic.isPlayerDriving?.()) {
    hud?.setMessage('Exit the vehicle before resting.');
    return false;
  }
  if (!playerLayerActive
    || controls.interiorMode
    || passengerRideActive()
    || beautyMode
    || qaCameraPose) {
    hud?.setMessage('Rest is available on foot at a public bench.');
    return false;
  }
  if (playerMoving()) {
    hud?.setMessage('Stop moving before resting.');
    return false;
  }
  if (combatState?.status !== 'running' || combatState?.active !== true) {
    hud?.setMessage('Recover before resting.');
    return false;
  }
  if (heatState?.pursuitActive) {
    hud?.setMessage('Lose the StreetHeat tail before resting.');
    return false;
  }
  if (lifeState?.workShift?.active
    || lifeState?.residentFavor?.active
    || lifeState?.deliveryRun?.active) {
    hud?.setMessage('Finish the active job before resting.');
    return false;
  }
  const anchor = getNearestRestAnchor();
  if (!anchor) {
    hud?.setMessage('Find a public bench before resting.');
    return false;
  }
  const rested = lifeSim?.rest?.() === true;
  hud?.setLifeState?.(lifeSim?.getState?.());
  if (rested) savePlayerProgress();
  return rested;
}

// Pointer Events only emit `pointerdown` for the first mouse button in a
// multi-button chord. A separate mousedown bridge keeps LMB fire reliable
// while RMB is held for aim (the normal pointer path still handles a solo
// click and touch/camera controls).
function onMouseDown(event) {
  if (event.button !== 0
    || !combatInputAvailable()
    || !combat?.getState?.().aiming
    || combat?.getState?.().triggerHeld) return;
  const result = combat.fire();
  if (result.fired) {
    event.preventDefault();
    combat.setTriggerHeld(true);
  }
}

function onMouseUp(event) {
  if (event.button !== 0 || !combat?.getState?.().triggerHeld) return;
  combat.setTriggerHeld(false);
}

function onPointerDown(event) {
  canvas.focus({ preventScroll: true });
  if (event.pointerType === 'mouse' && event.button === 2 && combatInputAvailable()) {
    controls.combatPointerId = event.pointerId;
    controls.lastX = event.clientX;
    controls.lastY = event.clientY;
    combat.setAiming(true);
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.pointerType === 'mouse'
    && event.button === 0
    && combatInputAvailable()
    && combat?.getState?.().aiming) {
    const result = combat.fire();
    if (result.fired) {
      event.preventDefault();
      controls.combatTriggerPointerId = event.pointerId;
      combat.setTriggerHeld(true);
      canvas.setPointerCapture(event.pointerId);
      return;
    }
  }
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
  if (event.pointerType === 'mouse'
    && controls.keys.has('keyq')
    && combatAimActive()) {
    if (traffic.isPlayerDriving?.()) {
      driveByState.aimYaw -= event.movementX * 0.0038;
      driveByState.aimPitch = THREE.MathUtils.clamp(
        driveByState.aimPitch - event.movementY * 0.0038 * 0.72,
        -0.36,
        0.25,
      );
    } else {
      controls.yaw -= event.movementX * 0.0038;
      controls.pitch += event.movementY * 0.0038 * 0.72;
    }
    return;
  }
  if (controls.combatPointerId === event.pointerId) {
    const dx = event.clientX - controls.lastX;
    const dy = event.clientY - controls.lastY;
    controls.lastX = event.clientX;
    controls.lastY = event.clientY;
    if (traffic.isPlayerDriving?.()) {
      driveByState.aimYaw -= dx * 0.0038;
      driveByState.aimPitch = THREE.MathUtils.clamp(
        driveByState.aimPitch - dy * 0.0038 * 0.72,
        -0.36,
        0.25,
      );
    } else {
      controls.yaw -= dx * 0.0038;
      controls.pitch += dy * 0.0038 * 0.72;
    }
    return;
  }
  if (controls.combatPointerId === event.pointerId
    || controls.combatTriggerPointerId === event.pointerId) return;
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
  if ((event.button === 2 && controls.combatPointerId === event.pointerId)
    || (event.type === 'pointercancel' && controls.combatPointerId === event.pointerId)) {
    controls.combatPointerId = null;
    combat?.setAiming(false);
    controls.combatTriggerPointerId = null;
    combat?.setTriggerHeld(false);
    if (canvas.hasPointerCapture(event.pointerId)
      && controls.combatTriggerPointerId == null) canvas.releasePointerCapture(event.pointerId);
    return;
  }
  if ((event.button === 0 && controls.combatTriggerPointerId === event.pointerId)
    || (event.type === 'pointercancel' && controls.combatTriggerPointerId === event.pointerId)) {
    controls.combatTriggerPointerId = null;
    combat?.setTriggerHeld(false);
    if (canvas.hasPointerCapture(event.pointerId)
      && controls.combatPointerId == null) canvas.releasePointerCapture(event.pointerId);
    return;
  }
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
  if (code === 'Escape' && sfpdOfficerQaScenario) {
    event.preventDefault();
    sfpdOfficerQaScenario = null;
    qaCameraPose = null;
    streetHeat?.restart?.();
    traffic.setPursuitResponder?.({
      active: false,
      position: controls.target,
      playerVehicleId: null,
      level: 0,
    });
    clearSfpdResponderDeploymentHolds();
    sfpdOfficers.clear?.({ resetDefeats: true });
    return;
  }
  // Escape is also an emergency exit from a player car.
  if (code === 'Escape' && traffic.isPlayerDriving?.()) {
    event.preventDefault();
    exitPlayerCar();
    return;
  }
  // Escape is an emergency exit from a room. It must remain actionable even
  // when a heavy streamed-sector frame has delayed the fade timer; otherwise
  // the interior can remain active after the visible handoff has completed.
  if (code === 'Escape' && controls.interiorMode) {
    event.preventDefault();
    exitInterior();
    return;
  }
  if (sceneTransitioning) {
    event.preventDefault();
    return;
  }
  if (muniRideState?.active) {
    event.preventDefault();
    if (code === 'KeyE' && !event.repeat) {
      hud?.setMessage(`MUNI / ${String(muniRideState.phase || 'en-route').toUpperCase()} · ONE-STOP RIDE.`);
    }
    return;
  }
  if (taxiRideState?.active) {
    event.preventDefault();
    if (code === 'KeyE' && !event.repeat) {
      hud?.setMessage(`TAXI / EN ROUTE · ${Math.ceil(Math.max(0, TAXI_RIDE_DURATION - taxiRideState.elapsed))}s.`);
    }
    return;
  }
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyH', 'KeyR', 'KeyC', 'KeyM', 'KeyV', 'KeyT', 'KeyF', 'KeyX', 'KeyQ', 'KeyY', 'KeyB', 'KeyG', 'KeyN'].includes(code)) event.preventDefault();
  if (code === 'KeyR' && !event.repeat) {
    if (ferryImpoundContext()) {
      const legalDebtHandled = settleLegalDebtAtFerry();
      if (legalDebtHandled !== null) return;
      const impoundHandled = retrieveImpoundedVehicleAtFerry();
      if (impoundHandled !== null) return;
      const registrationHandled = registerParkedVehicleAtFerry();
      if (registrationHandled !== null) return;
    }
    const drivingState = traffic.getPlayerVehicleState?.();
    if (drivingState?.damage?.disabled) {
      repairCurrentPlayerVehicle('roadside-repair');
    } else {
      const combatState = combat?.getState?.();
      if (!(combatInputAvailable() && combatState?.ammo < combatState?.magazineSize && combat.reload())) {
        cycleWeather();
      }
    }
  }
  if (code === 'KeyY' && !event.repeat && combatInputAvailable()) combat.reload();
  if (code === 'KeyQ' && combatInputAvailable()) combat.setAiming(true);
  if (code === 'KeyH' && !event.repeat) toggleBeautyMode();
  if (code === 'KeyC' && !event.repeat) setRenderQuality(renderQuality.mode === 'cinematic' ? 'auto' : 'cinematic');
  if (code === 'KeyM' && !event.repeat) hud?.toggleMap?.();
  if (code === 'KeyV' && !event.repeat) {
    networking?.enableVoice?.();
  }
  if (code === 'KeyT' && !event.repeat) {
    const handled = lifeSim?.isAtMarket?.(controls.target)
      ? eatPlayerAtMarket()
      : talkToNearbyResident();
    if (onFootPedestrianSpaceQaScenario) {
      onFootPedestrianSpaceQaScenario.tConsumed = handled === true;
    }
  }
  if (code === 'KeyB' && !event.repeat) buyPlayerMedkit();
  if (code === 'KeyN' && !event.repeat) buyPlayerAmmo();
  if (code === 'KeyG' && !event.repeat) {
    const garageHandled = handleFerryGarageAction();
    if (garageHandled === null) usePlayerMedkit();
  }
  if (code === 'KeyF' && !event.repeat) {
    startPlayerWorkShift();
  }
  if (code === 'KeyX' && !event.repeat) {
    if (sfpdOfficerQaScenario?.kind === 'surrender') {
      streetHeat?.resolveArrest?.({ wasDriving: false, reason: 'surrender' });
      return;
    }
    if (onFootSurrenderInputAvailable()) {
      hud?.setMessage('SURRENDER / HOLD X NEAR A RESPONDER · STAY STILL.');
    } else if (onFootPursuitActive()) {
      hud?.setMessage('SURRENDER UNAVAILABLE / RECOVER AND RETURN OUTSIDE.');
    } else {
      restPlayerAtBench();
    }
  }
  if (code === 'KeyE' && !event.repeat) {
    if (vehicleEmbodimentTransitionActive()) {
      vehicleEmbodimentState.duplicateEIgnored = true;
      hud?.setMessage(vehicleEmbodimentState.phase === 'entering'
        ? 'Getting seated…'
        : 'Stepping clear…');
      return;
    } else if (traffic.isPlayerDriving?.()) {
      exitPlayerCar();
    } else if (controls.interiorMode) {
      performInteriorAction();
    } else {
      if (completeDeliveryRunAtPortal()) return;
      if (completeResidentFavorAtPortal()) return;
      const delivery = traffic.getNearestDeliveryService?.(controls.target, 3.8);
      if (delivery) {
        startDeliveryRunFromService(delivery);
        return;
      }
      const muni = traffic.getNearestTransitService?.(controls.target, 3.8, 2.8);
      if (muni) {
        startPlayerMuniRide(muni);
        return;
      }
      const taxi = traffic.getNearestTaxiService?.(controls.target, 3.8);
      if (taxi) {
        startPlayerTaxiRide(taxi);
        return;
      }
      const readyPortal = getInteractionPortal();
      if (readyPortal && readyPortal.distance <= readyPortal.radius) {
        enterNearestInterior();
      } else {
        const nearestCar = traffic.getNearestEnterableVehicle?.(controls.target, 3.8);
        if (nearestCar) {
          enterPlayerCar(nearestCar.index);
        } else if (startResidentFavorFromNearby()) {
          return;
        } else {
          enterNearestInterior();
        }
      }
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
  if (code === 'KeyQ') combat?.setAiming(false);
}

function enterNearestInterior() {
  const combatState = combat?.getState?.();
  if (combatState?.status !== 'running') {
    hud.setMessage('INTERACTION LOCKED / RECOVER BEFORE ENTERING.');
    return false;
  }
  if (streetHeat?.getState?.().pursuitActive) {
    hud.setMessage('INTERIOR LOCKED / LOSE THE STREETHEAT TAIL OR SURRENDER.');
    return false;
  }
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
    controls.activePortal = {
      ...nearest,
      room: interior.room || nearest.room,
    };
    controls.interiorMode = true;
    clearPlayerVehicleEmbodiment();
    controls.target.copy(interior.target);
    controls.yaw = Math.PI;
    // Enter on an architectural eye-line that looks slightly upward. The
    // old downward pitch made the shared interior floor dominate the first
    // frame and hid the room's authored furniture behind the near edge of
    // the camera orbit.
    controls.pitch = 1.58;
    controls.distance = 5.35;
    setInteriorPresentationTarget(true, interior.room || nearest.room);
    snapCameraToControls();
    const shiftAdvance = cityShift?.onPortalEntered(nearest);
    const flagship = city.getInteriorState?.().flagship;
    const ferryEntry = String(nearest.label || '').toLowerCase().includes('ferry building');
    const registration = traffic.getPlayerVehicleRegistrationState?.();
    const garage = traffic.getPlayerGarageState?.();
    if (traffic.getImpoundedVehicleState?.() && ferryEntry) {
      hud.setMessage(`Ferry impound desk · press R to retrieve vehicle · $${VEHICLE_IMPOUND_RETRIEVAL_FEE}.`);
    } else if (ferryEntry && registration?.eligible && !registration.registeredOwner) {
      hud.setMessage(`Ferry registration desk · press R to register vehicle · $${VEHICLE_REGISTRATION_FEE}.`);
    } else if (ferryEntry && (registration?.registeredOwner || garage?.count > 0)) {
      hud.setMessage(registration?.registeredOwner
        ? `Ferry garage · press G to store vehicle · ${garage.count}/${garage.capacity} slots used.`
        : `Ferry garage · press G to retrieve vehicle · ${garage.count}/${garage.capacity} slots used.`);
    } else if (!shiftAdvance) {
      hud.setMessage(
        `Entered ${interior.label} · ${interior.roomLabel}. Press E or ESC to return.`,
      );
    }
  });
}

function performInteriorAction() {
  if (!controls.interiorMode) return;
  const combatState = combat?.getState?.();
  if (combatState?.status !== 'running') {
    hud.setMessage('INTERACTION LOCKED / RECOVER BEFORE USING THIS HOTSPOT.');
    return false;
  }
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
  const completeExit = () => {
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
  };
  if (sceneTransitioning) {
    // A delayed entry fade may still own the transition latch after the room
    // is already active. Complete the exit synchronously so input and QA
    // roaming cannot be stranded behind that stale latch.
    sceneTransitioning = false;
    sceneTransition.classList.remove('is-active');
    completeExit();
    return;
  }
  runSceneTransition(completeExit);
}

function updateInteraction() {
  if (muniRideState?.active) {
    hud.setInteraction({
      label: `MUNI / ONE STOP / $${MUNI_RIDE_FARE}`,
      prompt: `${String(muniRideState.phase || 'en-route').toUpperCase()} · STAY SEATED`,
      enabled: false,
    });
    return;
  }
  if (taxiRideState?.active) {
    hud.setInteraction({
      label: `TAXI / FERRY BUILDING / $${TAXI_RIDE_FARE}`,
      prompt: `EN ROUTE · ${Math.ceil(Math.max(0, TAXI_RIDE_DURATION - taxiRideState.elapsed))}s`,
      enabled: false,
    });
    return;
  }
  if (traffic.isPlayerDriving?.()) {
    const drivingState = traffic.getPlayerVehicleState?.();
    const heatState = streetHeat?.getState?.();
    const responderDistance = Number.isFinite(heatState?.responderDistance)
      ? ` · TAIL ${heatState.responderDistance.toFixed(1)} M`
      : '';
    const heatLabel = heatState?.pursuitActive
      ? ` · HEAT ${heatState.level}${responderDistance}`
      : heatState?.heat > 0
        ? ` · HEAT ${heatState.heat}`
        : '';
    hud.setInteraction({
      label: `DRIVING / ${(drivingState?.class || 'CAR').toUpperCase()} / ${Math.round(drivingState?.speed || 0)} KM/H${heatLabel}`,
      prompt: heatState?.pursuitActive
        ? 'E EXIT · WASD DRIVE · RMB AIM / LMB FIRE · BRAKE TO LOSE TAIL'
        : 'E EXIT · WASD DRIVE · RMB AIM / LMB FIRE',
      enabled: true,
    });
    return;
  }
  if (controls.interiorMode) {
    const legalDebt = ferryImpoundContext()
      ? Math.max(0, Math.round(Number(lifeSim?.getState?.().legalDebt) || 0))
      : 0;
    if (legalDebt > 0) {
      hud.setInteraction({
        label: `FERRY LEGAL DESK / $${legalDebt} DUE`,
        prompt: lifeSim?.canAffordLegalDebt?.()
          ? 'R  SETTLE LEGAL DEBT'
          : 'EARN CASH TO SETTLE',
        enabled: true,
      });
      return;
    }
    const registration = ferryImpoundContext()
      ? traffic.getPlayerVehicleRegistrationState?.()
      : null;
    if (registration?.eligible && !registration.registeredOwner) {
      hud.setInteraction({
        label: `FERRY REGISTRATION / $${VEHICLE_REGISTRATION_FEE}`,
        prompt: 'R  REGISTER PARKED VEHICLE',
        enabled: true,
      });
      return;
    }
    if (ferryImpoundContext()) {
      const garage = traffic.getPlayerGarageState?.();
      if (registration?.registeredOwner || garage?.count > 0) {
        hud.setInteraction({
          label: `FERRY GARAGE / ${garage?.count ?? 0}/${garage?.capacity ?? 2}`,
          prompt: registration?.registeredOwner
            ? 'G  STORE REGISTERED VEHICLE'
            : 'G  RETRIEVE NEXT VEHICLE',
          enabled: true,
        });
        return;
      }
    }
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
  const onFootHeat = streetHeat?.getState?.();
  if (onFootHeat?.pursuitActive && Number.isFinite(onFootHeat.responderDistance)) {
    const responder = traffic.getPursuitResponder?.();
    const responderDistances = onFootHeat.responderDistances.filter(Number.isFinite);
    const nearestResponderDistance = responderDistances.length
      ? Math.min(...responderDistances)
      : onFootHeat.responderDistance;
    const surrenderAvailable = onFootSurrenderInputAvailable();
    hud.setInteraction({
      label: `${String(responder?.label || 'TRAFFIC TAIL').toUpperCase()} / TAIL ${nearestResponderDistance.toFixed(1)} M`,
      prompt: !surrenderAvailable
        ? 'SURRENDER UNAVAILABLE · RECOVER OUTSIDE'
        : nearestResponderDistance <= 10
          ? 'HOLD X  SURRENDER · STAY STILL'
          : 'KEEP MOVING · BREAK CONTACT OR APPROACH TO SURRENDER',
      enabled: true,
    });
    return;
  }
  const activeFavor = lifeSim?.getState?.().residentFavor;
  const activeDelivery = lifeSim?.getState?.().deliveryRun;
  const deliveryPortal = activeDelivery?.active ? getInteractionPortal() : null;
  if (activeDelivery?.active
    && deliveryPortal?.id === activeDelivery.target.id
    && deliveryPortal.distance <= deliveryPortal.radius) {
    hud.setInteraction({
      label: `BAY PARCEL / ${activeDelivery.target.label}`,
      prompt: `E / TAP  DELIVER · $${activeDelivery.reward}`,
      enabled: true,
    });
    return;
  }
  const favorPortal = activeFavor?.active ? getInteractionPortal() : null;
  if (activeFavor?.active
    && favorPortal?.id === activeFavor.target.id
    && favorPortal.distance <= favorPortal.radius) {
    hud.setInteraction({
      label: `FAVOR DELIVERY / ${activeFavor.target.label}`,
      prompt: `E / TAP  DELIVER · $${activeFavor.reward}`,
      enabled: true,
    });
    return;
  }
  const delivery = traffic.getNearestDeliveryService?.(controls.target, 3.8);
  if (delivery) {
    hud.setInteraction({
      label: `BAY PARCEL / ${delivery.label.toUpperCase()} / ${delivery.distance.toFixed(1)} M`,
      prompt: activeDelivery?.active
        ? `DELIVERY ACTIVE · ${activeDelivery.target.label}`
        : 'E / TAP  ACCEPT · $32',
      enabled: true,
    });
    return;
  }
  const muni = traffic.getNearestTransitService?.(controls.target, 3.8, 2.8);
  if (muni) {
    hud.setInteraction({
      label: `MUNI / ${muni.distance.toFixed(1)} M / ONE STOP`,
      prompt: `E / TAP  BOARD · $${MUNI_RIDE_FARE}`,
      enabled: true,
    });
    return;
  }
  const taxi = traffic.getNearestTaxiService?.(controls.target, 3.8);
  if (taxi) {
    hud.setInteraction({
      label: `SF TAXI / ${taxi.distance.toFixed(1)} M / FERRY BUILDING`,
      prompt: `E / TAP  RIDE · $${TAXI_RIDE_FARE}`,
      enabled: true,
    });
    return;
  }
  const readyPortal = getInteractionPortal();
  if (readyPortal && readyPortal.distance <= readyPortal.radius) {
    const canEatHere = lifeSim?.canEat?.(controls.target);
    const canWorkHere = lifeSim?.canWork?.(controls.target);
    const lifePrompts = [canEatHere ? 'T EAT' : null, canWorkHere ? 'F WORK' : null]
      .filter(Boolean)
      .join(' · ');
    hud.setInteraction({
      label: `${readyPortal.featured ? 'FEATURED DOOR / ' : ''}${readyPortal.label} / ${readyPortal.distance.toFixed(1)} M`,
      prompt: lifePrompts ? `E / TAP  ENTER · ${lifePrompts}` : 'E / TAP  ENTER',
      enabled: true,
    });
    return;
  }
  const nearestCar = traffic.getNearestEnterableVehicle?.(controls.target, 3.8);
  if (nearestCar) {
    const carLabel = String(nearestCar.vehicle.cls || 'car').toUpperCase();
    hud.setInteraction({
      label: `PARKED ${carLabel} / ${nearestCar.distance.toFixed(1)} M`,
      prompt: nearestCar.distance <= 3.8 ? 'E / TAP  DRIVE' : 'APPROACH',
      enabled: nearestCar.distance <= 3.8,
    });
    return;
  }
  const nearbyResident = pedestrians.getNearestPerson?.(controls.target, 4.4);
  if (nearbyResident) {
    const residentLabel = nearbyResident.label || nearbyResident.job?.id || 'resident';
    hud.setInteraction({
      label: `${residentLabel.toUpperCase()} / ${nearbyResident.distance.toFixed(1)} M`,
      prompt: activeFavor?.active
        ? `FAVOR ACTIVE · ${activeFavor.target.label}`
        : 'T / TAP  TALK · E FAVOR',
      enabled: true,
    });
    return;
  }
  const nearest = readyPortal;
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
canvas.addEventListener('mousedown', onMouseDown);
canvas.addEventListener('mouseup', onMouseUp);
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener('wheel', onWheel, { passive: false });
canvas.addEventListener('keydown', onKeyDown);
canvas.addEventListener('keyup', onKeyUp);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => {
  controls.keys.clear();
  controls.combatPointerId = null;
  controls.combatTriggerPointerId = null;
  combat?.setAiming(false);
  combat?.setTriggerHeld(false);
});
document.addEventListener('visibilitychange', () => {
  controls.keys.clear();
  controls.combatPointerId = null;
  controls.combatTriggerPointerId = null;
  combat?.setAiming(false);
  combat?.setTriggerHeld(false);
  if (!document.hidden) {
    // Avoid treating time spent backgrounded as a real frame stall and
    // immediately downshifting quality when the tab becomes visible again.
    lastFrame = performance.now();
    clock.start();
    renderQuality.sampleTime = 0;
    renderQuality.sampleFrames = 0;
    renderQuality.hitchStreak = 0;
    renderQuality.lowFpsWindows = 0;
    renderQuality.healthyFpsWindows = 0;
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
const HUD_STATS_INTERVAL = 0.2;
let hudStatsElapsed = -Infinity;
let hudStatsFocusSector = null;
let cachedStreamingStats = null;
let cachedStreamedAgentStats = null;
let cachedTrafficStats = null;
let cachedPedestrianStats = null;

function startExperience() {
  if (!ready || started) return;

  started = true;
  // Loading and first-paint work are measured separately from the playable
  // frame budget. Do not let the boot overlay's initialization hitch poison
  // the 60 FPS telemetry window used by traversal QA.
  resetPerformanceTelemetry();
  startPlayerLayer();
  exportPlayerWorldState();
  canvas?.removeAttribute('inert');
  hudRoot?.removeAttribute('inert');
  bootOverlay?.classList.add('is-dismissed');
  app?.classList.add('is-live');
  canvas.focus({ preventScroll: true });
  cityShift?.start();
  streetHeat?.start();
  combat?.start();
  const restoredProgress = restorePlayerProgress();
  hud?.setGameState(cityShift?.getState(controls.target, controls.activePortal));
  // The world and current objective establish the opening context. Avoid a
  // long-lived center toast that obscures the player and first street view.
  hud?.setMessage(restoredProgress
    ? 'Progress restored · location, economy, combat kit, and Waterfront Loop resumed.'
    : null);
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
  const applicationFrameStart = performance.now();
  const profileFrameStart = frameProfileEnabled ? applicationFrameStart : 0;
  let profileStageStart = profileFrameStart;
  const profileMark = (name) => {
    if (!frameProfileEnabled) return;
    const mark = performance.now();
    recordFrameProfileStage(name, mark - profileStageStart);
    profileStageStart = mark;
  };
  const frameDelta = Math.min(Math.max(0, (now - lastFrame) / 1000), 0.25);
  const dt = Math.min(clock.getDelta(), 0.05);
  const motionDt = reducedMotionQuery?.matches ? 0 : dt;
  elapsed += motionDt;
  playerCameraImpulse.prepare(camera);
  onFootVehicleSweepStart.copy(controls.target);
  updateCamera(dt);
  if (['entering', 'seated', 'exiting'].includes(vehicleEmbodimentState.phase)) {
    if (vehicleEmbodimentState.cameraReady) {
      vehicleEmbodimentState.cameraMaxStep = Math.max(
        vehicleEmbodimentState.cameraMaxStep,
        camera.position.distanceTo(vehicleEmbodimentCameraPrevious),
      );
    }
    vehicleEmbodimentCameraPrevious.copy(camera.position);
    vehicleEmbodimentState.cameraReady = true;
  }
  applyPlayerDamageCameraImpulse(dt);
  updatePlayerLayer(motionDt, elapsed);
  exportPlayerWorldState();
  // The sky dome is intentionally compact so its shader remains cheap, but
  // streamed districts can sit kilometres from the origin. Keep the dome
  // centered on the active camera so its gradient/cloud field remains the
  // visible background instead of falling through to scene.background.
  if (proceduralSky) proceduralSky.position.copy(camera.position);
  profileMark('camera');
  const streamingFocus = controls.interiorMode && controls.exteriorSnapshot
    ? controls.exteriorSnapshot.target
    : controls.target;
  streaming.update?.(streamingFocus, camera, motionDt, elapsed);
  streamedAgents.update?.(streamingFocus, motionDt, elapsed);
  updateSunShadowFocus(
    streamingFocus,
    streaming.getFocusSectorKey?.() ?? streaming.stats.focusSector,
  );
  if (qaStreamingTour) observeQaTourSector(qaStreamingTour);
  profileMark('streaming');
  city.update?.(motionDt, elapsed);
  profileMark('city');
  // Keep one authoritative traffic simulation over the merged core + authored
  // road graph. Focus culling hides distant vehicle meshes without stopping
  // their lane, signal, collision, and handoff state while roaming.
  const focusSectorKey = streaming.getFocusSectorKey?.() ?? streaming.stats.focusSector;
  const coreSimulationActive = focusSectorKey === '0:0';
  traffic.group.visible = true;
  pedestrians.group.visible = true;
  // One active sector plus its immediate approach is enough for the player to
  // read lane behavior; the full merged simulation remains live off-screen.
  traffic.setFocus?.(streamingFocus, coreSimulationActive ? 280 : 220);
  // The authored pedestrian graph belongs to the core plate; outside it the
  // streamed representative pool owns the visible crowd. Keep the core
  // walkers simulated, but do not leak them across a district seam.
  pedestrians.setFocus?.(streamingFocus, coreSimulationActive ? 280 : 32);
  const pursuitVehicleState = traffic.isPlayerDriving?.()
    ? traffic.getPlayerVehicleState?.()
    : null;
  const pursuitHeatState = streetHeat?.getState?.();
  traffic.setPursuitResponder?.({
    active: Boolean(pursuitHeatState?.pursuitActive),
    position: pursuitVehicleState?.position ?? controls.target,
    playerVehicleId: pursuitVehicleState?.index ?? null,
    level: pursuitHeatState?.level ?? 1,
  });
  updateSfpdResponderDeploymentHolds({
    heatState: pursuitHeatState,
    driving: Boolean(pursuitVehicleState),
  });
  const onFootSweepDistance = Math.hypot(
    controls.target.x - onFootVehicleSweepStart.x,
    controls.target.z - onFootVehicleSweepStart.z,
  );
  traffic.setOnFootPlayerCollisionProbe?.({
    active: playerLayerActive
      && !pursuitVehicleState
      && !controls.interiorMode
      && !passengerRideActive()
      && !beautyMode
      && !qaCameraPose
      && !qaStreamingTour
      && !sfpdOfficerQaScenario
      && combat?.getState?.().status === 'running',
    start: onFootSweepDistance <= 1.25 ? onFootVehicleSweepStart : controls.target,
    end: controls.target,
    radius: ON_FOOT_PLAYER_BODY_RADIUS,
  });
  traffic.update?.(motionDt, elapsed);
  updateVehiclePedestrianImpact();
  // Traffic owns the vehicle transform and collision settlement. Resample the
  // authored seat/door sockets only after that authority has finished, then
  // place the single local Traveler in the same rendered frame.
  updatePlayerVehicleEmbodiment(
    dt,
    elapsed,
    traffic.isPlayerDriving?.() ? traffic.getPlayerVehicleState?.() : null,
  );
  profileMark('traffic');
  const onFootCrowdSweepDistance = Math.hypot(
    controls.target.x - onFootVehicleSweepStart.x,
    controls.target.z - onFootVehicleSweepStart.z,
  );
  pedestrians.setOnFootPlayerCollisionProbe?.({
    active: playerLayerActive
      && !traffic.isPlayerDriving?.()
      && !vehicleEmbodimentTransitionActive()
      && !controls.interiorMode
      && !passengerRideActive()
      && !beautyMode
      && !qaCameraPose
      && !qaStreamingTour
      && !sfpdOfficerQaScenario
      && !onFootVehicleImpactQaScenario
      && combat?.getState?.().status === 'running',
    start: onFootCrowdSweepDistance <= 1.25 ? onFootVehicleSweepStart : controls.target,
    end: controls.target,
    radius: ON_FOOT_PLAYER_CROWD_RADIUS,
  });
  pedestrians.update?.(motionDt, elapsed);
  sfpdOfficers.update?.(motionDt, elapsed, {
    active: Boolean(pursuitHeatState?.pursuitActive),
    level: pursuitHeatState?.level ?? 0,
    responders: getSfpdPursuitResponders(),
    playerPosition: getCombatGroundPosition(),
    outdoor: playerLayerActive
      && !controls.interiorMode
      && !traffic.isPlayerDriving?.()
      && !passengerRideActive()
      && !beautyMode,
    pressure: pursuitHeatState?.pressure ?? null,
  });
  profileMark('pedestrians');
  const gameState = cityShift?.update?.(motionDt, controls.target, controls.activePortal);
  if (started) {
    progressSaveElapsed += frameDelta;
    if (progressSaveElapsed >= PLAYER_PROGRESS_AUTOSAVE_SECONDS) {
      progressSaveElapsed = 0;
      savePlayerProgress();
    }
  }
  const drivingState = traffic.isPlayerDriving?.()
    ? traffic.getPlayerVehicleState?.()
    : null;
  const drivingSurrendering = Boolean(drivingState)
    && (controls.keys.has('keys') || controls.keys.has('arrowdown'));
  sfpdOfficerQaPressureDelay = Math.max(0, sfpdOfficerQaPressureDelay - motionDt);
  const sfpdResponseBeforeHeat = sfpdOfficers.getState?.();
  const expectedOnFootOfficers = !drivingState && pursuitHeatState?.level >= 2
    ? Math.min(
      pursuitHeatState.level,
      getSfpdPursuitResponders().filter((responder) => responder?.active).length,
    )
    : 0;
  const deployedOnFootOfficers = sfpdResponseBeforeHeat?.officers?.filter((officer) => (
    officer.visible && officer.live && officer.deploy?.state === 'deployed'
  )).length ?? 0;
  const streetHeatState = streetHeat?.update?.(motionDt, {
    driving: Boolean(drivingState),
    speed: drivingState?.speed ?? 0,
    position: drivingState?.position ?? controls.target,
    playerVehicleId: drivingState?.index ?? null,
    surrendering: drivingSurrendering,
    onFootSurrendering: !drivingState
      && onFootSurrenderInputAvailable()
      && controls.keys.has('keyx'),
    onFootMoving: !drivingState && playerMoving(),
    onFootResponsePending: expectedOnFootOfficers > 0
      && deployedOnFootOfficers < expectedOnFootOfficers,
    onFootPressureEligible: !drivingState
      && playerLayerActive
      && !controls.interiorMode
      && !passengerRideActive()
      && !beautyMode
      && (!qaCameraPose || Boolean(sfpdOfficerQaScenario))
      && sfpdOfficerQaPressureDelay <= 0
      && combat?.getState?.().status === 'running'
      && combat?.getState?.().active === true,
  });
  if (sfpdOfficerQaScenario && streetHeatState?.pursuitActive !== true) {
    sfpdOfficerQaScenario = null;
    qaCameraPose = null;
  }
  // Pressure state changes inside Street Heat. A zero-delta presentation pass
  // makes the >=0.4 s telegraph begin on the same frame as the lock without
  // advancing officer movement or any projectile lifetime twice.
  sfpdOfficers.update?.(0, elapsed, {
    active: Boolean(streetHeatState?.pursuitActive),
    level: streetHeatState?.level ?? 0,
    responders: getSfpdPursuitResponders(),
    playerPosition: getCombatGroundPosition(),
    outdoor: playerLayerActive
      && !controls.interiorMode
      && !traffic.isPlayerDriving?.()
      && !passengerRideActive()
      && !beautyMode,
    pressure: streetHeatState?.pressure ?? null,
  });
  traffic.setPursuitResponder?.({
    active: Boolean(streetHeatState?.pursuitActive),
    position: drivingState?.position ?? controls.target,
    playerVehicleId: drivingState?.index ?? null,
    level: streetHeatState?.level ?? 1,
  });
  updateSfpdResponderDeploymentHolds({
    heatState: streetHeatState,
    driving: Boolean(drivingState),
  });
  const combatState = combat?.update?.(motionDt, {
    active: playerLayerActive
      && !controls.interiorMode
      && !passengerRideActive()
      && !beautyMode
      && (!qaCameraPose || Boolean(sfpdOfficerQaScenario)),
    suspendRecovery: Boolean(streetHeatState?.pursuitActive),
  });
  updateCombatOverlay(combatState);
  updatePlayerWeapon(combatState);
  // Apply the inbound-damage overlay after locomotion and weapon posing.
  // Aiming uses a stronger arm kick; the sidearm is re-aligned below without
  // erasing that readable silhouette change.
  applyPlayerHitReaction(playerAvatar, {
    elapsed,
    delta: motionDt,
    downed: combatState?.status === 'downed',
    preserveAim: combatState?.aiming === true,
    enabled: Boolean(playerAvatar?.visible),
  });
  // The hit overlay deliberately moves the aiming arm. Re-solve only the
  // weapon's local quaternion so it remains hand-mounted and converged on the
  // reticle without erasing the visible arm recoil.
  if (combatState?.aiming) alignPlayerWeaponToCamera();
  updateDriveByRig(combatState, drivingState);
  const combatHudActive = Boolean(
    combatState?.aiming
      || combatState?.reloading
      || combatState?.hitConfirm
      || combatState?.status === 'downed',
  );
  hud?.setContextMode?.(
    controls.interiorMode
      ? 'interior'
      : combatHudActive
          ? 'combat'
          : drivingState
            ? 'driving'
          : 'traversal',
  );
  const displayedGameState = gameState && streetHeatState
    && (streetHeatState.pursuitActive || streetHeatState.heat > 0)
    ? { ...gameState, hint: streetHeatState.hint }
    : gameState;
  if (!cachedStreamingStats
    || elapsed - hudStatsElapsed >= HUD_STATS_INTERVAL
    || hudStatsFocusSector !== focusSectorKey) {
    cachedStreamingStats = streaming.stats;
    cachedStreamedAgentStats = streamedAgents.getStats?.() ?? null;
    cachedTrafficStats = coreSimulationActive ? traffic.getStats?.() ?? null : null;
    cachedPedestrianStats = coreSimulationActive ? pedestrians.getStats?.() ?? null : null;
    hudStatsElapsed = elapsed;
    hudStatsFocusSector = focusSectorKey;
  }
  const mapStreamingStats = cachedStreamingStats;
  const mapStreamedAgents = cachedStreamedAgentStats;
  const mapDistrict = coreSimulationActive
    ? 'Core district'
    : streaming.getSectorPresentation?.(mapStreamingStats.focusSector)?.presentation?.district
      || 'City grid';
  const mapVehicles = coreSimulationActive
    ? cachedTrafficStats?.active
    : mapStreamedAgents?.vehicles?.visible;
  const mapPedestrians = coreSimulationActive
    ? cachedPedestrianStats?.active
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
  hud.update?.(frameDelta, elapsed, displayedGameState, mapState);
  updateInteraction();
  // The city owns weather-aware materials and particles; this pass owns the
  // shared light/fog/exposure crossfade and runs after city.update(), which
  // otherwise reapplies its authored sun pulse every frame.
  updateInteriorPresentation(reducedMotionQuery?.matches ? 1 : frameDelta);
  updateWeatherPresentation(frameDelta, elapsed);
  applyTimeOfDayPresentation(lifeSim?.getState?.().clock ?? 7);
  profileMark('gameplay-ui-weather');
  if (!firstSceneFrameReady) {
    firstSceneFrameReady = sceneTexturesReadyForPrewarm();
  }
  if (firstSceneFrameReady) {
    if (postProcessingActive) composer.render();
    else renderer.render(scene, camera);
  } else {
    renderer.clear(true, true, true);
  }
  profileMark('render');
  if (frameProfileEnabled) frameProfile.frameCount += 1;
  updateAdaptiveQuality(frameDelta);
  recordPerformanceFrame(frameDelta, performance.now() - applicationFrameStart);
  profileMark('telemetry-quality');

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

window.__SF_TRAFFIC_RULES__ = { createTrafficRulesHarness };

// Keep diagnostics and deterministic import staging available to QA without
// exposing raw occupancy mutations that can bypass the main-owned
// ingress/egress phase machine. Imports remain supported, but synchronize the
// visible seated state atomically when they activate a driving record.
const publicTraffic = Object.freeze({
  ...traffic,
  enterPlayerVehicle: undefined,
  exitPlayerVehicle: undefined,
  importPlayerVehicleState(snapshot) {
    if (vehicleEmbodimentTransitionActive()) return false;
    const imported = traffic.importPlayerVehicleState?.(snapshot) === true;
    if (!imported) return false;
    if (traffic.isPlayerDriving?.()) {
      return activatePlayerVehiclePresentation({ restored: true }) !== null;
    }
    clearPlayerVehicleEmbodiment();
    return true;
  },
});

window.__SF_SIM__ = {
  scene,
  camera,
  renderer,
  composer,
  city,
  traffic: publicTraffic,
  pedestrians,
  sfpdOfficers,
  streamedAgents,
  streaming,
  expansion,
  cityShift,
  streetHeat,
  combat,
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
    if (onFootPedestrianSpaceQaScenario) {
      onFootPedestrianSpaceQaScenario.captureFraming = Boolean(qaCameraPose);
    }
  },
  setRoamPose(position) {
    return setQaRoamPose(position);
  },
  get playerAvatar() {
    return playerAvatar;
  },
  get networking() {
    return networking;
  },
  get lifeSim() {
    return lifeSim;
  },
  isDriving() {
    return traffic.isPlayerDriving?.() === true;
  },
  enterCar() {
    if (traffic.isPlayerDriving?.()) return false;
    const nearest = traffic.getNearestEnterableVehicle?.(controls.target, 3.8);
    return nearest ? enterPlayerCar(nearest.index) : false;
  },
  exitCar() {
    return exitPlayerCar();
  },
  setPlayerInput(input) {
    if (vehicleEmbodimentTransitionActive()) {
      traffic.setPlayerInput?.({ throttle: 0, brake: 1, steer: 0 });
      return false;
    }
    traffic.setPlayerInput?.(input);
    return true;
  },
  setTimeOfDay(hour) {
    return lifeSim?.setClock?.(hour) === true;
  },
  get timeOfDay() {
    return lifeSim?.getState?.().clock ?? 7;
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
  getTraversalCameraState() {
    return readTraversalCameraState();
  },
  launch() {
    startExperience();
    return document.querySelector('#boot-overlay')?.classList.contains('is-dismissed') ?? false;
  },
  getInteractionState() {
    return getQaInteractionState();
  },
  getStreetHeatState() {
    return streetHeat?.getState?.() ?? null;
  },
  getSfpdOfficerQa() {
    return sfpdOfficerQa;
  },
  sfpdOfficerQa,
  getOnFootVehicleImpactQa() {
    return onFootVehicleImpactQa;
  },
  getOnFootPedestrianSpaceQa() {
    return onFootPedestrianSpaceQa;
  },
  getPlayerVehicleEmbodimentState() {
    return getPlayerVehicleEmbodimentState();
  },
  getVehicleEmbodimentQa() {
    return vehicleEmbodimentQa;
  },
  getLastTrafficCitation() {
    return lastTrafficCitation ? structuredClone(lastTrafficCitation) : null;
  },
  getCombatState() {
    const state = combat?.getState?.();
    if (!state) return null;
    return {
      ...state,
      camera: {
        mode: driveByState.active
          ? 'drive-by-aim'
          : combatCameraState.active ? 'shoulder-aim' : 'orbit',
        distance: combatCameraState.active ? controls.cameraDistance : controls.distance,
        yaw: driveByState.active ? driveByState.aimYaw : controls.yaw,
        pitch: driveByState.active ? driveByState.aimPitch : controls.pitch,
      },
      weapon: {
        visible: Boolean(playerWeapon?.visible),
        name: playerWeapon?.name || 'Traveler low-poly sidearm',
        muzzleOffset: COMBAT_WEAPON_MUZZLE_OFFSET,
      },
      embodiment: getCombatEmbodimentState(),
      driveBy: getDriveByState(),
      damageFeedback: {
        reaction: getPlayerHitReactionTelemetry(playerAvatar),
        cameraImpulse: playerCameraImpulse.getTelemetry(),
      },
    };
  },
  getCombatAudioState() {
    return combatAudio?.getState?.() ?? null;
  },
  getCombatTargetState(id) {
    return combat?.getTargetState?.(id) ?? null;
  },
  getCombatWorldBlocker(origin, direction, maxDistance = 160) {
    return getNearestCombatWorldBlocker(origin, direction, maxDistance);
  },
  setCombatAim(aiming) {
    return combat?.setAiming?.(aiming) ?? false;
  },
  fireCombat() {
    return combat?.fire?.() ?? { fired: false, reason: 'unavailable' };
  },
  restartCombat() {
    return combat?.restart?.() ?? null;
  },
  reloadCombat() {
    return combat?.reload?.() ?? false;
  },
  damagePlayer(amount, source) {
    return combat?.damagePlayer?.(amount, source) ?? false;
  },
  damagePlayerVehicle(amount, source) {
    const damage = traffic.damagePlayerVehicle?.(amount, source) ?? null;
    if (damage) {
      hud?.setMessage(damage.disabled
        ? `Vehicle disabled · R roadside repair $${getPlayerVehicleRepairQuote()?.cost ?? 0} / E exit.`
        : `Vehicle integrity ${Math.round(damage.ratio * 100)}%.`);
    }
    return damage;
  },
  repairPlayerVehicle(source) {
    return repairCurrentPlayerVehicle(source);
  },
  getPlayerVehicleRepairQuote() {
    return getPlayerVehicleRepairQuote();
  },
  getImpoundRetrievalFee() {
    return VEHICLE_IMPOUND_RETRIEVAL_FEE;
  },
  getTaxiRideState() {
    return getPlayerTaxiRideState();
  },
  getTaxiFare() {
    return TAXI_RIDE_FARE;
  },
  getMuniRideState() {
    return getPlayerMuniRideState();
  },
  getMuniFare() {
    return MUNI_RIDE_FARE;
  },
  buyPlayerMedkit() {
    return buyPlayerMedkit();
  },
  buyPlayerAmmo() {
    return buyPlayerAmmo();
  },
  usePlayerMedkit() {
    return usePlayerMedkit();
  },
  saveProgress() {
    return savePlayerProgress();
  },
  restoreProgress() {
    return restorePlayerProgress();
  },
  clearSavedProgress() {
    return clearPlayerProgress();
  },
  getSavedProgress() {
    return {
      key: PLAYER_PROGRESS_STORAGE_KEY,
      snapshot: readPlayerProgress(),
      lastSave: lastProgressSave ? { ...lastProgressSave } : null,
    };
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
  getPerformanceSnapshot,
  resetPerformanceTelemetry,
  getFrameProfile,
  resetFrameProfile,
  get lastFrame() {
    return lastFrame;
  },
};
