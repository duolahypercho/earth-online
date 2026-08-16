import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
  SF_MAP_LEGACY_BUILDING_PRESENTATION,
  collectSourceToneAttributeBytes,
  normalizeTilePresentation,
  verifyParsedGlbMetricContract,
  verifyParsedGlbPresentation,
  verifyProductionPresentationAuthorization,
  verifyReceiptPresentation,
  verifyScenePresentation,
} from './building-presentation-contract.js';
import {
  SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1,
  applyLegacyBuildingPresentation,
  applySourceToneBuildingPresentation,
} from './building-presentation-material.js';
import './styles.css';

const BASE_URL = import.meta.env.BASE_URL;
const FALLBACK_TILE = {
  id: 'epsg26910-1441-10893',
  gridIndex: [1441, 10893],
  origin: [553344, 4182912, 0],
  size: 384,
  glb: 'data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.lod0.glb',
  glbSha256: 'sha256:ca6021f03d8335f80b0ebcaab9b50320f6f302b2ab8a1b886cd9995a45074310',
  glbSha256Hex: 'ca6021f03d8335f80b0ebcaab9b50320f6f302b2ab8a1b886cd9995a45074310',
  receipt: 'data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.receipt.json',
  receiptSha256: 'sha256:fdba34c57b6af539a5a2d53bc185f3dd091ede4323f836c7716c619bf07c15fd',
  receiptSha256Hex: 'fdba34c57b6af539a5a2d53bc185f3dd091ede4323f836c7716c619bf07c15fd',
  presentation: SF_MAP_LEGACY_BUILDING_PRESENTATION,
  source: 'verified Ferry fallback',
};

// This is deliberately a small, public runtime index. Each committed entry needs:
// { id, originEpsg26910VerticalMetres, lod0: { path }, receipt?: { path } }.
// Origins stay in EPSG:26910; this viewer subtracts the anchor origin exactly once.
const MANIFEST_PATHS = [
  'data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json',
  'data/world/production-artifacts/sf-metric-tiles.manifest.json',
  'data/world/production-artifacts/metric-tiles.manifest.json',
];
const STREAM_RADIUS_METRES = 880;
const RETAIN_RADIUS_METRES = 1040;
const FERRY = new THREE.Vector3(98.056, 3.467, 336.015);

const element = (selector) => document.querySelector(selector);
const canvas = element('#map-canvas');
const landmark = element('.landmark');
const loadState = element('#load-state');
const loadedCount = element('#loaded-count');
const loadedTiles = element('#loaded-tiles');
const loading = element('#loading');
const loadProgress = element('#load-progress');
const streamSource = element('#stream-source');
const tileAnchor = element('#tile-anchor');
const tileExtent = element('#tile-extent');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07100f);
scene.fog = new THREE.FogExp2(0x07100f, 0.00145);

const camera = new THREE.PerspectiveCamera(43, window.innerWidth / window.innerHeight, 0.5, 2400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;
controls.minDistance = 24;
controls.maxDistance = 1200;
controls.maxPolarAngle = Math.PI * 0.485;

// Keep the fill deliberately below the key: the source buildings are simple
// OSM extrusions, so their trustworthy silhouette needs light-side separation
// rather than an invented facade treatment.
scene.add(new THREE.HemisphereLight(0xc8dfd1, 0x101715, 0.96));
const sun = new THREE.DirectionalLight(0xffe6bd, 3.6);
sun.position.set(-280, 430, -210);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -460;
sun.shadow.camera.right = 460;
sun.shadow.camera.top = 460;
sun.shadow.camera.bottom = -460;
sun.shadow.bias = -0.00012;
sun.shadow.normalBias = 0.025;
sun.shadow.camera.far = 1400;
scene.add(sun);
scene.add(sun.target);

// Ferry's waterfront camera looks into the shadow-facing side of the simple
// source extrusions. A bounded, non-shadow-casting daylight fill preserves the
// real silhouette while giving those vertical faces a stable readable lift.
// Its azimuth follows the camera around the local focus, so orbiting does not
// make the source buildings disappear into a black key-shadow.
const viewFill = new THREE.DirectionalLight(0xb9d7e4, 0.72);
viewFill.castShadow = false;
scene.add(viewFill);
scene.add(viewFill.target);

const perimeter = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(FALLBACK_TILE.size, 0.05, FALLBACK_TILE.size)),
  new THREE.LineBasicMaterial({ color: 0xd7ff48, transparent: true, opacity: 0.34 }),
);
perimeter.position.set(FALLBACK_TILE.size / 2, -2.7, FALLBACK_TILE.size / 2);
scene.add(perimeter);

const views = {
  ferry: { position: [430, 132, 292], target: [119, 8, 292] },
  district: { position: [-42, 240, 505], target: [185, 9, 190] },
  plan: { position: [192, 570, 192.01], target: [192, 0, 192] },
};
const viewFogDensity = { ferry: 0.00145, district: 0.00055, plan: 0.00018 };
let activeView = 'ferry';
let viewTransitionSequence = 0;
const SUN_LOCAL_OFFSET = new THREE.Vector3(-280, 430, -210);
const VIEW_FILL_DISTANCE_METRES = 360;
const VIEW_FILL_HEIGHT_METRES = 220;
const VIEW_FILL_INTENSITY = Object.freeze({ ferry: 0.72, district: 0.46, plan: 0.28 });
const viewFillHorizontal = new THREE.Vector3();
const LOCAL_SHADOW_REFIT_METRES = 72;
const PLAN_LOADING_RENDER_INTERVAL_MS = 250;
const localShadowTarget = new THREE.Vector3(Infinity, Infinity, Infinity);
const BUILDING_PALETTE = Object.freeze([
  new THREE.Color(0xc7ad8a), // sun-worn sandstone
  new THREE.Color(0xaa765c), // muted terracotta
  new THREE.Color(0x77858c), // cool concrete
  new THREE.Color(0x8b6456), // weathered brick
]);
const PRESENTATION_POLICY = Object.freeze({
  version: 'sf-map-render-depth-v2',
  buildingToneCount: BUILDING_PALETTE.length,
  paletteWorldCellMetres: 62,
  roadColor: '#53615e',
  waterNormalResponse: 'world-up-view-space-v1',
  shadows: 'local Ferry/District directional shadow frustum only; Plan retains readable unshadowed overview',
  lightingFill: 'camera-facing neutral daylight fill; non-shadow-casting and presentation-only',
  lightingFillIntensities: VIEW_FILL_INTENSITY,
  planLoadingRenderIntervalMs: PLAN_LOADING_RENDER_INTERVAL_MS,
});
const DISTRICT_FIT_TARGET_RESIDENTS = 4;
const DISTRICT_FIT_MIN_DISTANCE_METRES = 180;
const DISTRICT_FIT_MAX_DISTANCE_METRES = 2800;
const DISTRICT_FIT_FRAME_MARGIN = 2.15;
let districtOverviewView = null;
let districtFitDescriptors = [];
const districtFit = {
  epoch: 0,
  fitCount: 0,
  status: 'inactive',
  batchTileIds: [],
  previousBatchTileIds: [],
  residentBounds: null,
  cameraTarget: null,
  cameraDistance: null,
  cameraDirection: null,
};
const explicitViewResidency = {
  epoch: 0,
  lastPrune: null,
};

function refitViewFill() {
  viewFillHorizontal.copy(camera.position).sub(controls.target);
  viewFillHorizontal.y = 0;
  if (viewFillHorizontal.lengthSq() < 1e-6) viewFillHorizontal.set(1, 0, 0);
  else viewFillHorizontal.normalize();
  viewFill.position.copy(controls.target)
    .addScaledVector(viewFillHorizontal, VIEW_FILL_DISTANCE_METRES);
  viewFill.position.y = controls.target.y + VIEW_FILL_HEIGHT_METRES;
  viewFill.target.position.copy(controls.target);
  viewFill.target.updateMatrixWorld();
  viewFill.intensity = VIEW_FILL_INTENSITY[activeView] ?? VIEW_FILL_INTENSITY.ferry;
}

function refitLocalSunShadow(force = false) {
  // A city-sized Plan view cannot truthfully fit a useful single shadow map.
  // Ferry and District instead receive a stable local frustum centred on the
  // stream focus. This only changes illumination, never the metric tile data.
  refitViewFill();
  if (activeView === 'plan') {
    sun.castShadow = false;
    return;
  }
  if (!force && localShadowTarget.distanceToSquared(controls.target) < LOCAL_SHADOW_REFIT_METRES ** 2) return;
  sun.castShadow = true;
  localShadowTarget.copy(controls.target);
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).add(SUN_LOCAL_OFFSET);
  sun.target.updateMatrixWorld();
  sun.shadow.camera.updateProjectionMatrix();
  renderer.shadowMap.needsUpdate = true;
}

function applyBuildingPresentation(material) {
  applyLegacyBuildingPresentation(material, {
    palette: BUILDING_PALETTE,
    paletteWorldCellMetres: PRESENTATION_POLICY.paletteWorldCellMetres,
  });
}

function applyWaterPresentation(material) {
  if (material.userData.sfMapWaterNormalResponse === 'world-up-view-space-v1') return;
  const compileMaterial = material.onBeforeCompile;
  material.onBeforeCompile = (shader, webglRenderer) => {
    compileMaterial.call(material, shader, webglRenderer);
    const normalMarker = '#include <normal_fragment_maps>';
    if (!shader.fragmentShader.includes(normalMarker)) {
      throw new Error('SF map water shader is missing Three normal_fragment_maps');
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      normalMarker,
      `${normalMarker}\n  normal = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));`,
    );
  };
  material.customProgramCacheKey = () => 'sf-map-water-world-up-v1';
  material.userData.sfMapWaterNormalResponse = 'world-up-view-space-v1';
  material.needsUpdate = true;
}

function copyView(view) {
  return { position: [...view.position], target: [...view.target] };
}

function fitOverviewViews(descriptors) {
  if (!descriptors.length) return;
  const minX = Math.min(...descriptors.map(({ offset }) => offset.x));
  const minZ = Math.min(...descriptors.map(({ offset }) => offset.z));
  const maxX = Math.max(...descriptors.map(({ offset, size }) => offset.x + size));
  const maxZ = Math.max(...descriptors.map(({ offset, size }) => offset.z + size));
  const centerX = (minX + maxX) / 2; const centerZ = (minZ + maxZ) / 2;
  const width = maxX - minX; const depth = maxZ - minZ; const span = Math.max(width, depth);
  const verticalFov = THREE.MathUtils.degToRad(camera.fov); const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const planHeight = Math.max(depth / (2 * Math.tan(verticalFov / 2)), width / (2 * Math.tan(horizontalFov / 2))) * 1.12;
  views.plan = { position: [centerX, planHeight, centerZ + 0.01], target: [centerX, 0, centerZ] };
  views.district = { position: [centerX - span * 0.72, span * 0.62, centerZ + span * 0.58], target: [centerX, 8, centerZ] };
  districtOverviewView = copyView(views.district);
  const districtDistance = span * Math.hypot(0.72, 0.62, 0.58);
  viewFogDensity.plan = Math.min(0.00018, 0.28 / planHeight);
  viewFogDensity.district = Math.min(0.00055, 0.45 / districtDistance);
  camera.far = Math.max(2400, planHeight * 1.5, span * 2.5);
  camera.updateProjectionMatrix();
  controls.maxDistance = Math.max(1200, span * 1.4);
}

function resetDistrictFit() {
  districtFit.epoch += 1;
  districtFit.previousBatchTileIds = [...districtFit.batchTileIds];
  districtFit.status = 'awaiting-verified-residents';
  districtFit.batchTileIds = [];
  districtFit.residentBounds = null;
  districtFit.cameraTarget = null;
  districtFit.cameraDistance = null;
  districtFit.cameraDirection = null;
  if (districtOverviewView) views.district = copyView(districtOverviewView);
}

function residentDescriptorBounds(states) {
  const minX = Math.min(...states.map(({ descriptor }) => descriptor.offset.x));
  const minZ = Math.min(...states.map(({ descriptor }) => descriptor.offset.z));
  const maxX = Math.max(...states.map(({ descriptor }) => descriptor.offset.x + descriptor.size));
  const maxZ = Math.max(...states.map(({ descriptor }) => descriptor.offset.z + descriptor.size));
  return { minX, minZ, maxX, maxZ, width: maxX - minX, depth: maxZ - minZ };
}

function selectDistrictFitDescriptors(descriptors) {
  const overview = districtOverviewView || views.district;
  const overviewTarget = new THREE.Vector3(...overview.target);
  const byGridIndex = new Map(descriptors
    .filter((descriptor) => Array.isArray(descriptor.gridIndex) && descriptor.gridIndex.length === 2)
    .map((descriptor) => [descriptor.gridIndex.join('/'), descriptor]));
  const candidates = [];
  for (const descriptor of descriptors) {
    if (!Array.isArray(descriptor.gridIndex) || descriptor.gridIndex.length !== 2) continue;
    const [gridX, gridZ] = descriptor.gridIndex;
    const east = byGridIndex.get([gridX + 1, gridZ].join('/'));
    const north = byGridIndex.get([gridX, gridZ + 1].join('/'));
    const northEast = byGridIndex.get([gridX + 1, gridZ + 1].join('/'));
    const block = [descriptor, east, north, northEast];
    if (!block.every(Boolean) || !block.every((tile) => tile.size === descriptor.size)) continue;
    const bounds = residentDescriptorBounds(block.map((candidate) => ({ descriptor: candidate })));
    // Grid indices alone are not enough: only an exact metric 2×2 footprint
    // is eligible to frame the District camera.
    if (bounds.width !== descriptor.size * 2 || bounds.depth !== descriptor.size * 2) continue;
    const center = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
    candidates.push({
      descriptors: block.sort((left, right) => left.id.localeCompare(right.id)),
      distanceSquared: center.distanceToSquared(overviewTarget),
    });
  }
  candidates.sort((left, right) => left.distanceSquared - right.distanceSquared
    || left.descriptors.map(({ id }) => id).join('/').localeCompare(right.descriptors.map(({ id }) => id).join('/')));
  return candidates[0]?.descriptors || [];
}

function fitDistrictCameraToVerifiedResidents() {
  if (activeView !== 'district' || districtFit.status !== 'awaiting-verified-residents') return;
  // Arrival order depends on byte verification and parse timing. Select one
  // compact source footprint before any loads start, then wait for exactly
  // that footprint to become resident. If a complete metric block cannot be
  // sourced, leave the overview framing in place rather than fitting sparse
  // cache residue.
  if (districtFitDescriptors.length !== DISTRICT_FIT_TARGET_RESIDENTS) {
    districtFit.status = 'no-compact-source-batch';
    return;
  }
  const batch = districtFitDescriptors.map(({ id }) => tileStates.get(id));
  if (!batch.every((state) => state?.scene && focusDistanceToTile(state.descriptor) <= STREAM_RADIUS_METRES)) return;
  const bounds = residentDescriptorBounds(batch);
  const target = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 8, (bounds.minZ + bounds.maxZ) / 2);
  const overview = districtOverviewView || views.district;
  const direction = new THREE.Vector3(...overview.position).sub(new THREE.Vector3(...overview.target)).normalize();
  const right = new THREE.Vector3(0, 1, 0).cross(direction).normalize();
  const up = direction.clone().cross(right).normalize();
  const corners = [
    [bounds.minX, bounds.minZ], [bounds.minX, bounds.maxZ],
    [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ],
  ];
  const halfWidth = Math.max(...corners.map(([x, z]) => Math.abs(new THREE.Vector3(x - target.x, 0, z - target.z).dot(right))));
  const halfHeight = Math.max(...corners.map(([x, z]) => Math.abs(new THREE.Vector3(x - target.x, 0, z - target.z).dot(up))));
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const fitDistance = DISTRICT_FIT_FRAME_MARGIN * Math.max(
    halfWidth / Math.tan(horizontalFov / 2),
    halfHeight / Math.tan(verticalFov / 2),
  );
  const distance = THREE.MathUtils.clamp(fitDistance, DISTRICT_FIT_MIN_DISTANCE_METRES, Math.min(DISTRICT_FIT_MAX_DISTANCE_METRES, controls.maxDistance));
  viewTransitionSequence += 1;
  camera.position.copy(target).addScaledVector(direction, distance);
  controls.target.copy(target);
  controls.update();
  refitLocalSunShadow(true);
  views.district = { position: camera.position.toArray(), target: target.toArray() };
  viewFogDensity.district = Math.min(0.00055, 0.45 / distance);
  scene.fog.density = viewFogDensity.district;
  districtFit.fitCount += 1;
  districtFit.status = 'fitted';
  districtFit.batchTileIds = batch.map((state) => state.descriptor.id);
  districtFit.residentBounds = { ...bounds };
  districtFit.cameraTarget = target.toArray();
  districtFit.cameraDistance = distance;
  districtFit.cameraDirection = direction.toArray();
  settleExplicitViewResidency('district');
}

function setView(name, immediate = false) {
  if (name === 'district') resetDistrictFit();
  const view = views[name];
  if (!view) return;
  activeView = name;
  scene.fog.density = viewFogDensity[name] ?? viewFogDensity.ferry;
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === name));
  const destination = new THREE.Vector3(...view.position);
  const target = new THREE.Vector3(...view.target);
  if (immediate) {
    camera.position.copy(destination);
    controls.target.copy(target);
    controls.update();
    refitLocalSunShadow(true);
    if (name === 'district') fitDistrictCameraToVerifiedResidents();
    return;
  }
  const startPosition = camera.position.clone();
  const startTarget = controls.target.clone();
  const started = performance.now();
  const transition = ++viewTransitionSequence;
  const move = (now) => {
    if (transition !== viewTransitionSequence) return;
    const fraction = Math.min(1, (now - started) / 720);
    const eased = 1 - (1 - fraction) ** 3;
    camera.position.lerpVectors(startPosition, destination, eased);
    controls.target.lerpVectors(startTarget, target, eased);
    if (fraction < 1) requestAnimationFrame(move);
    else {
      refitLocalSunShadow(true);
      settleExplicitViewResidency(name);
    }
  };
  requestAnimationFrame(move);
}

setView('ferry', true);
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
controls.addEventListener('change', () => refitLocalSunShadow());

function publicPath(path) {
  if (!path) return null;
  return path.replace(/^public\//, '').replace(/^\//, '');
}

function firstPath(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  return value.path || value.url || value.visual || value.asset || null;
}

function sha256Declaration(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(?:sha256:)?([a-f0-9]{64})$/i);
  if (!match) return null;
  return Object.freeze({ declared: value, hex: match[1].toLowerCase() });
}

function artifactPathAndHash(value) {
  const path = firstPath(value);
  const sha256 = sha256Declaration(value?.sha256);
  return path && sha256 ? { path: publicPath(path), sha256 } : null;
}

function manifestTile(raw, index) {
  const id = raw.id || raw.identity || `metric-tile-${index + 1}`;
  const origin = raw.originEpsg26910VerticalMetres || raw.tileOriginEpsg26910VerticalMetres || raw.origin;
  const lod0 = raw.lod0 || raw.lods?.find((lod) => lod.level === 0) || raw.artifacts?.lod0;
  const glb = artifactPathAndHash(raw.glb) || artifactPathAndHash(raw.visual) || artifactPathAndHash(raw.asset) || artifactPathAndHash(lod0);
  const receipt = artifactPathAndHash(raw.receipt) || artifactPathAndHash(raw.buildReceipt);
  if (!Array.isArray(origin) || origin.length < 2 || !glb || !receipt) return null;
  if (![origin[0], origin[1], origin[2] ?? 0].every(Number.isFinite)) return null;
  return {
    id,
    gridIndex: raw.gridIndex || raw.grid?.index || null,
    origin: [origin[0], origin[1], origin[2] ?? 0],
    size: raw.tileSizeMetres || raw.tiling?.tileSizeMetres || raw.grid?.tileSizeMeters || 384,
    glb: glb.path,
    glbSha256: glb.sha256.declared,
    glbSha256Hex: glb.sha256.hex,
    receipt: receipt.path,
    receiptSha256: receipt.sha256.declared,
    receiptSha256Hex: receipt.sha256.hex,
    presentation: normalizeTilePresentation(raw.presentation, id),
    source: 'runtime metric manifest',
  };
}

async function discoverTiles() {
  for (const path of MANIFEST_PATHS) {
    const response = await fetch(`${BASE_URL}${path}`, { cache: 'no-cache' });
    if (!response.ok) continue;
    const manifest = await response.json();
    const records = manifest.tiles || manifest.entries || manifest.tileSet?.tiles || [];
    const tiles = records.map(manifestTile);
    if (tiles.length && tiles.every(Boolean)) return { tiles, source: `${path} (${tiles.length} committed)` };
    if (records.length) throw new Error(`${path} contains a tile without a byte-locked GLB and receipt`);
  }
  return { tiles: [FALLBACK_TILE], source: 'verified Ferry fallback (manifest not committed)' };
}

function disposeObject(root) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry?.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) material?.dispose();
  });
}

// Streaming follows the map focus, not the overview camera.  At full-city
// scale the camera can be kilometres away from the district it is framing;
// OrbitControls.target remains the stable, local-world focus in that case.
function focusDistanceToTile(tile) {
  const half = tile.size / 2;
  const centerX = tile.offset.x + half;
  const centerZ = tile.offset.z + half;
  return Math.hypot(controls.target.x - centerX, controls.target.z - centerZ);
}

const gltfLoader = new GLTFLoader();
const tileStates = new Map();
let tileDescriptors = [];
let anchorOrigin = FALLBACK_TILE.origin;
let streamingStarted = false;
let activeLoad = null;
let queueSequence = 0;
const STREAM_QUEUE_BUCKET_METRES = 96;
const STREAM_DIAGNOSTIC_LIMIT = 64;
const streamDiagnostics = {
  admissions: [],
  completed: [],
  lastQueue: [],
  queuedCount: 0,
  activeTileId: null,
};

function boundedPush(items, value) {
  items.push(value);
  if (items.length > STREAM_DIAGNOSTIC_LIMIT) items.shift();
}

function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is required for source-locked tile streaming');
  return globalThis.crypto.subtle.digest('SHA-256', bytes).then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
}

async function fetchVerifiedBytes(path, expectedSha256, label) {
  const response = await fetch(`${BASE_URL}${path}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${label} fetch failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  return { bytes, actualSha256 };
}

function loadPriority(state) {
  return [state.queueDistanceBucket, state.descriptor.id];
}

function compareQueuedStates(left, right) {
  const [leftBucket, leftId] = loadPriority(left);
  const [rightBucket, rightId] = loadPriority(right);
  return leftBucket - rightBucket || leftId.localeCompare(rightId);
}

function shouldLoadState(state) {
  return activeView === 'plan' || focusDistanceToTile(state.descriptor) <= STREAM_RADIUS_METRES;
}

function updateQueueDiagnostics() {
  const queued = [...tileStates.values()].filter((state) => state.queued).sort(compareQueuedStates);
  streamDiagnostics.queuedCount = queued.length;
  streamDiagnostics.lastQueue = queued.slice(0, STREAM_DIAGNOSTIC_LIMIT).map((state) => ({
    id: state.descriptor.id,
    distanceBucket: state.queueDistanceBucket,
    sequence: state.queueSequence,
  }));
}

function updateStats() {
  const states = [...tileStates.values()];
  const resident = states.filter((state) => state.scene).map((state) => state.descriptor.id);
  const pending = states.filter((state) => state.loading || state.queued).length;
  loadedCount.textContent = `${resident.length} / ${tileDescriptors.length}`;
  loadedTiles.textContent = resident.length ? resident.join(' · ') : pending ? 'Loading nearby tiles…' : 'No tile in stream radius';
  loadState.textContent = pending ? `Streaming ${pending} tile${pending === 1 ? '' : 's'}…` : `${resident.length} metric tile${resident.length === 1 ? '' : 's'} resident`;
}

function updateReceipt(state, receipt) {
  if (!receipt) return;
  state.receipt = receipt;
  const loaded = [...tileStates.values()].filter((entry) => entry.scene && entry.receipt);
  element('#road-count').textContent = loaded.reduce((sum, entry) => sum + (entry.receipt.counts?.emittedRoadWays || 0), 0) || '—';
  element('#building-count').textContent = loaded.reduce((sum, entry) => sum + (entry.receipt.counts?.emittedBuildingWays || 0), 0) || '—';
  const terrainStep = receipt.deterministicInputs?.terrainGridStepMetres;
  element('#terrain-resolution').textContent = terrainStep ? `${terrainStep} m grid` : 'source-declared';
}

function verifyReceiptDescriptor(receipt, descriptor) {
  const tile = receipt?.tile;
  if (!tile || receipt.kind !== 'sf-metric-tile-build-receipt' || tile.identity !== descriptor.id) {
    throw new Error(`${descriptor.id} receipt identity does not match the manifest tile`);
  }
  if (tile.scale !== 1 || !Array.isArray(tile.originEpsg26910VerticalMetres)
    || tile.originEpsg26910VerticalMetres[0] !== descriptor.origin[0]
    || tile.originEpsg26910VerticalMetres[1] !== descriptor.origin[1]
    || tile.originEpsg26910VerticalMetres[2] !== descriptor.origin[2]) {
    throw new Error(`${descriptor.id} receipt does not preserve the 1 unit = 1 metre origin contract`);
  }
  if (Array.isArray(descriptor.gridIndex) && (!Array.isArray(tile.gridIndex)
    || tile.gridIndex[0] !== descriptor.gridIndex[0] || tile.gridIndex[1] !== descriptor.gridIndex[1])) {
    throw new Error(`${descriptor.id} receipt grid index does not match the manifest tile`);
  }
  const bounds = tile.boundsEpsg26910Metres;
  if (!Array.isArray(bounds) || bounds.length !== 4
    || bounds[0] !== descriptor.origin[0] || bounds[1] !== descriptor.origin[1]
    || bounds[2] - bounds[0] !== descriptor.size || bounds[3] - bounds[1] !== descriptor.size) {
    throw new Error(`${descriptor.id} receipt bounds do not match the metric tile size and origin`);
  }
}

function resourcePathFor(path) {
  const url = new URL(`${BASE_URL}${path}`, window.location.href).href;
  return url.slice(0, url.lastIndexOf('/') + 1);
}

async function loadTile(state) {
  const { descriptor } = state;
  updateStats();
  let tile = null;
  try {
    const receiptArtifact = await fetchVerifiedBytes(descriptor.receipt, descriptor.receiptSha256Hex, `${descriptor.id} receipt`);
    const receipt = JSON.parse(new TextDecoder().decode(receiptArtifact.bytes));
    verifyReceiptDescriptor(receipt, descriptor);
    const presentationIntegrity = verifyReceiptPresentation(receipt, descriptor.presentation, descriptor.id);
    state.integrity.receipt = { expectedSha256: descriptor.receiptSha256, actualSha256: receiptArtifact.actualSha256, status: 'verified' };
    state.integrity.presentation = presentationIntegrity;
    if (descriptor.presentation.mode === 'source-tone-v1') {
      const authorizationReference = descriptor.presentation.authorization;
      const authorizationArtifact = await fetchVerifiedBytes(
        publicPath(authorizationReference.path),
        authorizationReference.sha256.slice('sha256:'.length),
        `${descriptor.id} presentation authorization`,
      );
      const authorization = JSON.parse(new TextDecoder().decode(authorizationArtifact.bytes));
      state.integrity.authorization = verifyProductionPresentationAuthorization(authorization, descriptor, presentationIntegrity, descriptor.id);
      state.integrity.authorization.actualSha256 = `sha256:${authorizationArtifact.actualSha256}`;
    }
    const glbArtifact = await fetchVerifiedBytes(descriptor.glb, descriptor.glbSha256Hex, `${descriptor.id} GLB`);
    state.integrity.glb = { expectedSha256: descriptor.glbSha256, actualSha256: glbArtifact.actualSha256, status: 'verified' };
    const gltf = await gltfLoader.parseAsync(glbArtifact.bytes, resourcePathFor(descriptor.glb));
    verifyParsedGlbMetricContract(gltf, descriptor, descriptor.id);
    verifyParsedGlbPresentation(gltf, descriptor.presentation, descriptor.id);
    tile = gltf.scene;
    verifyScenePresentation(tile, descriptor.presentation, descriptor.id);
    if (descriptor.presentation.mode === 'source-tone-v1') {
      const sourceToneBytes = collectSourceToneAttributeBytes(gltf, descriptor.presentation, descriptor.id);
      const actualSourceToneSha256 = `sha256:${await sha256Hex(sourceToneBytes)}`;
      if (actualSourceToneSha256 !== presentationIntegrity.sourceToneAttributeSha256) {
        throw new Error(`${descriptor.id} source-tone attribute SHA-256 does not match its receipt ledger`);
      }
      state.integrity.presentation.actualSourceToneAttributeSha256 = actualSourceToneSha256;
    }
    tile.name = `${descriptor.id} metric tile LOD0`;
    tile.position.copy(descriptor.offset);
    tile.scale.setScalar(1);
    tile.traverse((node) => {
      if (!node.isMesh) return;
      node.receiveShadow = true;
      node.castShadow = node.material?.name === 'buildings-night';
      if (node.material?.name === 'terrain-night') node.material.color.setHex(0x1d473a);
      if (node.material?.name === 'roads-night') {
        node.material.color.setHex(0x53615e);
        node.material.roughness = 0.96;
        node.material.polygonOffset = true;
        node.material.polygonOffsetFactor = -2;
        node.material.polygonOffsetUnits = -2;
        node.renderOrder = 2;
      }
      if (node.material?.name === 'buildings-night') {
        if (descriptor.presentation.mode === 'source-tone-v1') applySourceToneBuildingPresentation(node.material, {
          palette: BUILDING_PALETTE,
          policySha256: SF_BUILDING_SOURCE_TONE_CONTRACT_V1.derivation.policySha256,
          boundaryMask: {
            ...SF_SOURCE_TONE_LEGACY_GRID_BOUNDARY_MASK_V1,
            sceneTileOriginMetres: [descriptor.offset.x, descriptor.offset.z],
            sides: descriptor.presentation.boundaryMask.legacyNeighbourSides,
            legacyPalette: BUILDING_PALETTE,
          },
        });
        else applyBuildingPresentation(node.material);
      }
      if (node.material?.name === 'water-osm-coastline-night') {
        node.material.color.setHex(0x0a5870);
        node.material.roughness = 0.22;
        node.material.metalness = 0.18;
        applyWaterPresentation(node.material);
      }
      if (node.material?.name === 'coastline-osm-night') node.material.color.setHex(0x2f7f8c);
    });
    state.scene = tile;
    scene.add(tile);
    updateReceipt(state, receipt);
    boundedPush(streamDiagnostics.completed, { id: descriptor.id, result: 'verified-and-resident', presentationMode: descriptor.presentation.mode });
    fitDistrictCameraToVerifiedResidents();
  } catch (error) {
    tile && disposeObject(tile);
    state.error = error;
    state.integrity.failure = error.message;
    boundedPush(streamDiagnostics.completed, { id: descriptor.id, result: 'rejected', reason: error.message });
    console.error(`Unable to stream ${descriptor.id}`, error);
  } finally {
    state.loading = false;
    updateStats();
    if (!streamingStarted) {
      streamingStarted = true;
      loadProgress.style.width = '100%';
      window.setTimeout(() => loading.classList.add('is-done'), 280);
    }
  }
}

function nextQueuedState() {
  const candidates = [];
  for (const state of tileStates.values()) {
    if (!state.queued) continue;
    if (!shouldLoadState(state)) {
      state.queued = false;
      continue;
    }
    candidates.push(state);
  }
  return candidates.sort(compareQueuedStates)[0] || null;
}

function pumpLoadQueue() {
  if (activeLoad) return;
  const state = nextQueuedState();
  updateQueueDiagnostics();
  if (!state) return;
  state.queued = false;
  state.loading = true;
  streamDiagnostics.activeTileId = state.descriptor.id;
  boundedPush(streamDiagnostics.admissions, {
    id: state.descriptor.id,
    distanceBucket: state.queueDistanceBucket,
    sequence: state.queueSequence,
  });
  activeLoad = loadTile(state).finally(() => {
    activeLoad = null;
    streamDiagnostics.activeTileId = null;
    updateQueueDiagnostics();
    pumpLoadQueue();
  });
}

function unloadTile(state) {
  if (!state.scene) return;
  scene.remove(state.scene);
  disposeObject(state.scene);
  state.scene = null;
  state.receipt = null;
  const residentWithReceipts = [...tileStates.values()].filter((entry) => entry.scene && entry.receipt);
  element('#road-count').textContent = residentWithReceipts.reduce((sum, entry) => sum + (entry.receipt.counts?.emittedRoadWays || 0), 0) || '—';
  element('#building-count').textContent = residentWithReceipts.reduce((sum, entry) => sum + (entry.receipt.counts?.emittedBuildingWays || 0), 0) || '—';
  updateStats();
}

// Preset captures must not inherit cache-only tiles from a prior named view.
// This deliberately does not run during free orbit/pan, where RETAIN_RADIUS_METRES
// remains the streaming hysteresis contract.
function settleExplicitViewResidency(name) {
  if (name !== activeView || name === 'plan') return;
  const prunedTileIds = [];
  for (const state of tileStates.values()) {
    const shouldLoad = focusDistanceToTile(state.descriptor) <= STREAM_RADIUS_METRES;
    if (!shouldLoad && state.queued) state.queued = false;
    if (!shouldLoad && state.scene) {
      prunedTileIds.push(state.descriptor.id);
      unloadTile(state);
    }
  }
  explicitViewResidency.epoch += 1;
  explicitViewResidency.lastPrune = {
    view: name,
    focusWorldPosition: [controls.target.x, controls.target.z],
    prunedTileIds,
  };
  updateQueueDiagnostics();
  streamTiles();
  if (name === 'district') fitDistrictCameraToVerifiedResidents();
}

function streamTiles() {
  for (const state of tileStates.values()) {
    const distance = focusDistanceToTile(state.descriptor);
    const shouldLoad = activeView === 'plan' || distance <= STREAM_RADIUS_METRES;
    const shouldRetain = activeView === 'plan' || distance <= RETAIN_RADIUS_METRES;
    if (shouldLoad && !state.scene && !state.loading && !state.queued && !state.error) {
      state.queued = true;
      state.queueSequence = ++queueSequence;
      state.queueDistanceBucket = Math.floor(distance / STREAM_QUEUE_BUCKET_METRES);
    }
    if (!shouldLoad && state.queued) state.queued = false;
    if (!shouldRetain && state.scene) unloadTile(state);
  }
  updateQueueDiagnostics();
  pumpLoadQueue();
}

function verifyStaticPresentationAdjacency(descriptors) {
  const byGrid = new Map(descriptors.filter(({ gridIndex }) => Array.isArray(gridIndex)).map((descriptor) => [descriptor.gridIndex.join('/'), descriptor]));
  const directions = [
    ['west', -1, 0], ['east', 1, 0], ['south', 0, -1], ['north', 0, 1],
  ];
  for (const descriptor of descriptors) {
    if (descriptor.presentation.mode !== 'source-tone-v1') continue;
    if (!Array.isArray(descriptor.gridIndex)) throw new Error(`${descriptor.id} source-tone presentation requires a metric grid index`);
    const legacyNeighbours = directions.flatMap(([side, dx, dz]) => {
      const neighbour = byGrid.get([descriptor.gridIndex[0] + dx, descriptor.gridIndex[1] + dz].join('/'));
      return neighbour?.presentation.mode === 'legacy' ? [{ side, id: neighbour.id }] : [];
    });
    const sides = legacyNeighbours.map(({ side }) => side).sort();
    const ids = legacyNeighbours.map(({ id }) => id).sort();
    if (JSON.stringify(sides) !== JSON.stringify(descriptor.presentation.boundaryMask.legacyNeighbourSides)
      || JSON.stringify(ids) !== JSON.stringify(descriptor.presentation.boundaryMask.legacyNeighbourTileIds)) {
      throw new Error(`${descriptor.id} static source-tone boundary mask no longer matches manifest adjacency`);
    }
  }
}

async function initialiseStream() {
  const { tiles, source } = await discoverTiles();
  const anchor = tiles.find((tile) => tile.id === FALLBACK_TILE.id) || tiles[0];
  anchorOrigin = anchor.origin;
  tileDescriptors = tiles.map((tile) => ({
    ...tile,
    offset: new THREE.Vector3(tile.origin[0] - anchorOrigin[0], tile.origin[2] - anchorOrigin[2], tile.origin[1] - anchorOrigin[1]),
  }));
  verifyStaticPresentationAdjacency(tileDescriptors);
  fitOverviewViews(tileDescriptors);
  districtFitDescriptors = selectDistrictFitDescriptors(tileDescriptors);
  for (const descriptor of tileDescriptors) {
    tileStates.set(descriptor.id, {
      descriptor,
      scene: null,
      loading: false,
      queued: false,
      queueSequence: 0,
      queueDistanceBucket: null,
      receipt: null,
      error: null,
      integrity: {
        glb: { expectedSha256: descriptor.glbSha256, status: 'pending' },
        receipt: { expectedSha256: descriptor.receiptSha256, status: 'pending' },
        presentation: { mode: descriptor.presentation.mode, status: 'pending' },
        metric: { originSubtractions: 1, sceneScale: 1, units: 'metres' },
      },
    });
  }
  tileAnchor.textContent = anchor.gridIndex ? anchor.gridIndex.join(' / ') : `${anchorOrigin[0]}E / ${anchorOrigin[1]}N`;
  tileExtent.textContent = `${anchor.size} × ${anchor.size} m`;
  streamSource.textContent = source.toUpperCase();
  updateStats();
  streamTiles();
  window.__SF_MAP_VIEWER__ = Object.freeze({
    get anchorOriginEpsg26910() { return [...anchorOrigin]; },
    get tileDescriptors() { return tileDescriptors.map(({ offset, ...tile }) => ({ ...tile, offset: offset.toArray() })); },
    get residentTileIds() { return [...tileStates.values()].filter((state) => state.scene).map((state) => state.descriptor.id); },
    get streamingDiagnostics() {
      return {
        activeView,
        oneActiveLoad: !activeLoad || Boolean(streamDiagnostics.activeTileId),
        activeLoadCount: activeLoad ? 1 : 0,
        queuePolicy: `distance buckets of ${STREAM_QUEUE_BUCKET_METRES} metres, then lexical tile id`,
        distanceReference: 'controls.target horizontal coordinates',
        focusWorldPosition: [controls.target.x, controls.target.z],
        camera: {
          position: camera.position.toArray(),
          target: controls.target.toArray(),
          fovDegrees: camera.fov,
          nearMetres: camera.near,
          farMetres: camera.far,
        },
        activeTileId: streamDiagnostics.activeTileId,
        queuedCount: streamDiagnostics.queuedCount,
        queueOrder: streamDiagnostics.lastQueue.map((entry) => ({ ...entry })),
        admissions: streamDiagnostics.admissions.map((entry) => ({ ...entry })),
        completed: streamDiagnostics.completed.map((entry) => ({ ...entry })),
        districtFit: {
          targetResidents: DISTRICT_FIT_TARGET_RESIDENTS,
          frameMargin: DISTRICT_FIT_FRAME_MARGIN,
          selection: 'nearest-complete-source-2x2-metric-block',
          candidateTileIds: districtFitDescriptors.map(({ id }) => id),
          epoch: districtFit.epoch,
          fitCount: districtFit.fitCount,
          oneTimeStatus: districtFit.status,
          batchTileIds: [...districtFit.batchTileIds],
          residentBounds: districtFit.residentBounds && { ...districtFit.residentBounds },
          cameraTarget: districtFit.cameraTarget && [...districtFit.cameraTarget],
          cameraDistance: districtFit.cameraDistance,
          cameraDirection: districtFit.cameraDirection && [...districtFit.cameraDirection],
        },
        explicitViewResidency: {
          epoch: explicitViewResidency.epoch,
          lastPrune: explicitViewResidency.lastPrune && {
            ...explicitViewResidency.lastPrune,
            focusWorldPosition: [...explicitViewResidency.lastPrune.focusWorldPosition],
            prunedTileIds: [...explicitViewResidency.lastPrune.prunedTileIds],
          },
        },
        presentation: {
          ...PRESENTATION_POLICY,
          activeViewShadowed: activeView !== 'plan',
          localShadowTarget: localShadowTarget.toArray(),
          viewFill: {
            intensity: viewFill.intensity,
            position: viewFill.position.toArray(),
            target: viewFill.target.position.toArray(),
            castShadow: viewFill.castShadow,
          },
          materialPrograms: {
            buildings: 'sf-map-building-palette-v1',
            sourceToneBuildings: `sf-map-building-source-tone-v1:${SF_BUILDING_SOURCE_TONE_CONTRACT_V1.derivation.policySha256}`,
            water: 'sf-map-water-world-up-v1',
            roads: 'single muted asphalt material',
          },
          performance: {
            drawCalls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            programCount: renderer.info.programs?.length ?? 0,
            pixelRatio: renderer.getPixelRatio(),
          },
        },
        metricContract: {
          runtimeUnitsPerMetre: 1,
          sceneScale: 1,
          originSubtractions: 1,
          sourceLockedDescriptors: tileDescriptors.every((descriptor) => Boolean(descriptor.glbSha256Hex && descriptor.receiptSha256Hex)),
        },
        tiles: [...tileStates.values()].slice(0, STREAM_DIAGNOSTIC_LIMIT).map((state) => ({
          id: state.descriptor.id,
          presentationMode: state.descriptor.presentation.mode,
          resident: Boolean(state.scene),
          queued: state.queued,
          loading: state.loading,
          integrity: JSON.parse(JSON.stringify(state.integrity)),
        })),
      };
    },
    ferryPosition: FERRY.clone(),
    setView,
  });
}

initialiseStream();

const clock = new THREE.Clock();
let lastStreamCheck = 0;
let lastPlanLoadingRender = -Infinity;
function animate(now = 0) {
  requestAnimationFrame(animate);
  controls.update(clock.getDelta());
  if (now - lastStreamCheck > 350) {
    streamTiles();
    lastStreamCheck = now;
  }
  const marker = FERRY.clone().project(camera);
  const markerVisible = marker.z > -1 && marker.z < 1 && Math.abs(marker.x) < 0.92 && Math.abs(marker.y) < 0.88;
  landmark.classList.toggle('is-visible', markerVisible);
  if (markerVisible) {
    landmark.style.left = `${(marker.x * 0.5 + 0.5) * window.innerWidth}px`;
    landmark.style.top = `${(-marker.y * 0.5 + 0.5) * window.innerHeight}px`;
  }
  // The byte-verified queue remains strictly one-at-a-time.  While its Plan
  // overview is deliberately admitting every committed tile, avoid spending
  // every animation frame redrawing the growing city.  The completed Plan is
  // still rendered normally; this only gives verified IO/parse work a bounded
  // presentation-frame budget during the load phase.
  const planStillLoading = activeView === 'plan' && (activeLoad || streamDiagnostics.queuedCount > 0);
  if (!planStillLoading || now - lastPlanLoadingRender >= PLAN_LOADING_RENDER_INTERVAL_MS) {
    renderer.render(scene, camera);
    lastPlanLoadingRender = now;
  }
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
