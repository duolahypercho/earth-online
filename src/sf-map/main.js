import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
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

scene.add(new THREE.HemisphereLight(0xc8dfd1, 0x101715, 1.55));
const sun = new THREE.DirectionalLight(0xffe6bd, 3.25);
sun.position.set(-180, 310, -90);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -260;
sun.shadow.camera.right = 260;
sun.shadow.camera.top = 260;
sun.shadow.camera.bottom = -260;
sun.shadow.bias = -0.00008;
scene.add(sun);

const perimeter = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(FALLBACK_TILE.size, 0.05, FALLBACK_TILE.size)),
  new THREE.LineBasicMaterial({ color: 0xd7ff48, transparent: true, opacity: 0.34 }),
);
perimeter.position.set(FALLBACK_TILE.size / 2, -2.7, FALLBACK_TILE.size / 2);
scene.add(perimeter);

const views = {
  ferry: { position: [-8, 158, 475], target: [119, 8, 292] },
  district: { position: [-42, 240, 505], target: [185, 9, 190] },
  plan: { position: [192, 570, 192.01], target: [192, 0, 192] },
};
const viewFogDensity = { ferry: 0.00145, district: 0.00055, plan: 0.00018 };
let activeView = 'ferry';
let viewTransitionSequence = 0;
const DISTRICT_FIT_TARGET_RESIDENTS = 4;
const DISTRICT_FIT_MIN_DISTANCE_METRES = 180;
const DISTRICT_FIT_MAX_DISTANCE_METRES = 2800;
const DISTRICT_FIT_FRAME_MARGIN = 2.15;
let districtOverviewView = null;
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

function fitDistrictCameraToVerifiedResidents() {
  if (activeView !== 'district' || districtFit.status !== 'awaiting-verified-residents') return;
  const verifiedResidents = [...tileStates.values()]
    .filter((state) => state.scene)
    .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id));
  if (verifiedResidents.length < DISTRICT_FIT_TARGET_RESIDENTS) return;

  const priorBatch = districtFit.previousBatchTileIds
    .map((id) => tileStates.get(id))
    .filter((state) => state?.scene);
  const batch = priorBatch.length === DISTRICT_FIT_TARGET_RESIDENTS
    ? priorBatch
    : verifiedResidents.slice(0, DISTRICT_FIT_TARGET_RESIDENTS);
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
  views.district = { position: camera.position.toArray(), target: target.toArray() };
  viewFogDensity.district = Math.min(0.00055, 0.45 / distance);
  districtFit.fitCount += 1;
  districtFit.status = 'fitted';
  districtFit.batchTileIds = batch.map((state) => state.descriptor.id);
  districtFit.residentBounds = { ...bounds };
  districtFit.cameraTarget = target.toArray();
  districtFit.cameraDistance = distance;
  districtFit.cameraDirection = direction.toArray();
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
  };
  requestAnimationFrame(move);
  if (name === 'district') requestAnimationFrame(fitDistrictCameraToVerifiedResidents);
}

setView('ferry', true);
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

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
  const origin = raw.originEpsg26910VerticalMetres || raw.tileOriginEpsg26910VerticalMetres || raw.origin;
  const lod0 = raw.lod0 || raw.lods?.find((lod) => lod.level === 0) || raw.artifacts?.lod0;
  const glb = artifactPathAndHash(raw.glb) || artifactPathAndHash(raw.visual) || artifactPathAndHash(raw.asset) || artifactPathAndHash(lod0);
  const receipt = artifactPathAndHash(raw.receipt) || artifactPathAndHash(raw.buildReceipt);
  if (!Array.isArray(origin) || origin.length < 2 || !glb || !receipt) return null;
  if (![origin[0], origin[1], origin[2] ?? 0].every(Number.isFinite)) return null;
  return {
    id: raw.id || raw.identity || `metric-tile-${index + 1}`,
    gridIndex: raw.gridIndex || raw.grid?.index || null,
    origin: [origin[0], origin[1], origin[2] ?? 0],
    size: raw.tileSizeMetres || raw.tiling?.tileSizeMetres || raw.grid?.tileSizeMeters || 384,
    glb: glb.path,
    glbSha256: glb.sha256.declared,
    glbSha256Hex: glb.sha256.hex,
    receipt: receipt.path,
    receiptSha256: receipt.sha256.declared,
    receiptSha256Hex: receipt.sha256.hex,
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
    const glbArtifact = await fetchVerifiedBytes(descriptor.glb, descriptor.glbSha256Hex, `${descriptor.id} GLB`);
    state.integrity.glb = { expectedSha256: descriptor.glbSha256, actualSha256: glbArtifact.actualSha256, status: 'verified' };
    const gltf = await gltfLoader.parseAsync(glbArtifact.bytes, resourcePathFor(descriptor.glb));
    tile = gltf.scene;
    tile.name = `${descriptor.id} metric tile LOD0`;
    tile.position.copy(descriptor.offset);
    tile.scale.setScalar(1);
    tile.traverse((node) => {
      if (!node.isMesh) return;
      node.receiveShadow = true;
      node.castShadow = node.material?.name === 'buildings-night';
      if (node.material?.name === 'terrain-night') node.material.color.setHex(0x18382f);
      if (node.material?.name === 'roads-night') {
        node.material.color.setHex(0xa8b89d);
        node.material.polygonOffset = true;
        node.material.polygonOffsetFactor = -2;
        node.material.polygonOffsetUnits = -2;
        node.renderOrder = 2;
      }
      if (node.material?.name === 'buildings-night') node.material.color.setHex(0xb87842);
      if (node.material?.name === 'water-osm-coastline-night') {
        node.material.color.setHex(0x0a5870);
        node.material.roughness = 0.22;
        node.material.metalness = 0.18;
      }
      if (node.material?.name === 'coastline-osm-night') node.material.color.setHex(0x35a8b7);
    });
    const receiptArtifact = await fetchVerifiedBytes(descriptor.receipt, descriptor.receiptSha256Hex, `${descriptor.id} receipt`);
    const receipt = JSON.parse(new TextDecoder().decode(receiptArtifact.bytes));
    verifyReceiptDescriptor(receipt, descriptor);
    state.integrity.receipt = { expectedSha256: descriptor.receiptSha256, actualSha256: receiptArtifact.actualSha256, status: 'verified' };
    state.scene = tile;
    scene.add(tile);
    updateReceipt(state, receipt);
    boundedPush(streamDiagnostics.completed, { id: descriptor.id, result: 'verified-and-resident' });
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

async function initialiseStream() {
  const { tiles, source } = await discoverTiles();
  const anchor = tiles.find((tile) => tile.id === FALLBACK_TILE.id) || tiles[0];
  anchorOrigin = anchor.origin;
  tileDescriptors = tiles.map((tile) => ({
    ...tile,
    offset: new THREE.Vector3(tile.origin[0] - anchorOrigin[0], tile.origin[2] - anchorOrigin[2], tile.origin[1] - anchorOrigin[1]),
  }));
  fitOverviewViews(tileDescriptors);
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
        oneActiveLoad: !activeLoad || Boolean(streamDiagnostics.activeTileId),
        activeLoadCount: activeLoad ? 1 : 0,
        queuePolicy: `distance buckets of ${STREAM_QUEUE_BUCKET_METRES} metres, then lexical tile id`,
        distanceReference: 'controls.target horizontal coordinates',
        focusWorldPosition: [controls.target.x, controls.target.z],
        activeTileId: streamDiagnostics.activeTileId,
        queuedCount: streamDiagnostics.queuedCount,
        queueOrder: streamDiagnostics.lastQueue.map((entry) => ({ ...entry })),
        admissions: streamDiagnostics.admissions.map((entry) => ({ ...entry })),
        completed: streamDiagnostics.completed.map((entry) => ({ ...entry })),
        districtFit: {
          targetResidents: DISTRICT_FIT_TARGET_RESIDENTS,
          frameMargin: DISTRICT_FIT_FRAME_MARGIN,
          epoch: districtFit.epoch,
          fitCount: districtFit.fitCount,
          oneTimeStatus: districtFit.status,
          batchTileIds: [...districtFit.batchTileIds],
          residentBounds: districtFit.residentBounds && { ...districtFit.residentBounds },
          cameraTarget: districtFit.cameraTarget && [...districtFit.cameraTarget],
          cameraDistance: districtFit.cameraDistance,
          cameraDirection: districtFit.cameraDirection && [...districtFit.cameraDirection],
        },
        tiles: [...tileStates.values()].slice(0, STREAM_DIAGNOSTIC_LIMIT).map((state) => ({
          id: state.descriptor.id,
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
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
