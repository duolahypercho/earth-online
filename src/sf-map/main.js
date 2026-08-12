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
  receipt: 'data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.receipt.json',
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
}

function setView(name, immediate = false) {
  const view = views[name];
  if (!view) return;
  scene.fog.density = name === 'plan' ? 0.00018 : name === 'district' ? 0.00055 : 0.00145;
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === name));
  const destination = new THREE.Vector3(...view.position);
  const target = new THREE.Vector3(...view.target);
  if (immediate) {
    camera.position.copy(destination);
    controls.target.copy(target);
    controls.update();
    return;
  }
  const startPosition = camera.position.clone();
  const startTarget = controls.target.clone();
  const started = performance.now();
  const move = (now) => {
    const fraction = Math.min(1, (now - started) / 720);
    const eased = 1 - (1 - fraction) ** 3;
    camera.position.lerpVectors(startPosition, destination, eased);
    controls.target.lerpVectors(startTarget, target, eased);
    if (fraction < 1) requestAnimationFrame(move);
  };
  requestAnimationFrame(move);
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

function manifestTile(raw, index) {
  const origin = raw.originEpsg26910VerticalMetres || raw.tileOriginEpsg26910VerticalMetres || raw.origin;
  const lod0 = raw.lod0 || raw.lods?.find((lod) => lod.level === 0) || raw.artifacts?.lod0;
  const glb = firstPath(raw.glb) || firstPath(raw.visual) || firstPath(raw.asset) || firstPath(lod0);
  const receipt = firstPath(raw.receipt) || firstPath(raw.buildReceipt);
  if (!Array.isArray(origin) || origin.length < 2 || !glb) return null;
  if (![origin[0], origin[1], origin[2] ?? 0].every(Number.isFinite)) return null;
  return {
    id: raw.id || raw.identity || `metric-tile-${index + 1}`,
    gridIndex: raw.gridIndex || raw.grid?.index || null,
    origin: [origin[0], origin[1], origin[2] ?? 0],
    size: raw.tileSizeMetres || raw.tiling?.tileSizeMetres || raw.grid?.tileSizeMeters || 384,
    glb: publicPath(glb),
    receipt: publicPath(receipt),
    source: 'runtime metric manifest',
  };
}

async function discoverTiles() {
  for (const path of MANIFEST_PATHS) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, { cache: 'no-cache' });
      if (!response.ok) continue;
      const manifest = await response.json();
      const records = manifest.tiles || manifest.entries || manifest.tileSet?.tiles || [];
      const tiles = records.map(manifestTile).filter(Boolean);
      if (tiles.length) return { tiles, source: `${path} (${tiles.length} committed)` };
    } catch {
      // A missing manifest is normal until adjacent metric packages are committed.
    }
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

function cameraDistanceToTile(tile) {
  const half = tile.size / 2;
  const centerX = tile.offset.x + half;
  const centerZ = tile.offset.z + half;
  return Math.hypot(camera.position.x - centerX, camera.position.z - centerZ);
}

const gltfLoader = new GLTFLoader();
const tileStates = new Map();
let tileDescriptors = [];
let anchorOrigin = FALLBACK_TILE.origin;
let streamingStarted = false;

function updateStats() {
  const states = [...tileStates.values()];
  const resident = states.filter((state) => state.scene).map((state) => state.descriptor.id);
  const pending = states.filter((state) => state.loading).length;
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

async function loadTile(state) {
  const { descriptor } = state;
  state.loading = true;
  updateStats();
  try {
    const gltf = await gltfLoader.loadAsync(`${BASE_URL}${descriptor.glb}`);
    const tile = gltf.scene;
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
    state.scene = tile;
    scene.add(tile);
    if (descriptor.receipt) {
      fetch(`${BASE_URL}${descriptor.receipt}`).then((response) => response.ok ? response.json() : null).then((receipt) => updateReceipt(state, receipt)).catch(() => {});
    }
  } catch (error) {
    state.error = error;
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
    const distance = cameraDistanceToTile(state.descriptor);
    if (distance <= STREAM_RADIUS_METRES && !state.scene && !state.loading && !state.error) loadTile(state);
    if (distance > RETAIN_RADIUS_METRES && state.scene) unloadTile(state);
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
  fitOverviewViews(tileDescriptors);
  for (const descriptor of tileDescriptors) tileStates.set(descriptor.id, { descriptor, scene: null, loading: false, receipt: null, error: null });
  tileAnchor.textContent = anchor.gridIndex ? anchor.gridIndex.join(' / ') : `${anchorOrigin[0]}E / ${anchorOrigin[1]}N`;
  tileExtent.textContent = `${anchor.size} × ${anchor.size} m`;
  streamSource.textContent = source.toUpperCase();
  updateStats();
  streamTiles();
  window.__SF_MAP_VIEWER__ = Object.freeze({
    get anchorOriginEpsg26910() { return [...anchorOrigin]; },
    get tileDescriptors() { return tileDescriptors.map(({ offset, ...tile }) => ({ ...tile, offset: offset.toArray() })); },
    get residentTileIds() { return [...tileStates.values()].filter((state) => state.scene).map((state) => state.descriptor.id); },
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
