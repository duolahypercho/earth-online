import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import './styles.css';

const TILE_PATH = `${import.meta.env.BASE_URL}data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.lod0.glb`;
const RECEIPT_PATH = `${import.meta.env.BASE_URL}data/world/production-artifacts/ferry-production-tile-v1/ferry-production-tile-v1.receipt.json`;
const FERRY = new THREE.Vector3(98.056, 3.467, 336.015);

const canvas = document.querySelector('#map-canvas');
const landmark = document.querySelector('.landmark');
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

const camera = new THREE.PerspectiveCamera(43, window.innerWidth / window.innerHeight, 0.5, 1800);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;
controls.minDistance = 24;
controls.maxDistance = 760;
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
  new THREE.EdgesGeometry(new THREE.BoxGeometry(384, 0.05, 384)),
  new THREE.LineBasicMaterial({ color: 0xd7ff48, transparent: true, opacity: 0.34 }),
);
perimeter.position.set(192, -2.7, 192);
scene.add(perimeter);

const views = {
  ferry: { position: [-8, 158, 475], target: [119, 8, 292] },
  district: { position: [-42, 240, 505], target: [185, 9, 190] },
  plan: { position: [192, 570, 192.01], target: [192, 0, 192] },
};

function setView(name, immediate = false) {
  const view = views[name];
  if (!view) return;
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
  const duration = 720;
  const move = (now) => {
    const linear = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - linear) ** 3;
    camera.position.lerpVectors(startPosition, destination, eased);
    controls.target.lerpVectors(startTarget, target, eased);
    if (linear < 1) requestAnimationFrame(move);
  };
  requestAnimationFrame(move);
}

setView('ferry', true);
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

const receiptPromise = fetch(RECEIPT_PATH).then((response) => {
  if (!response.ok) throw new Error(`Receipt HTTP ${response.status}`);
  return response.json();
});

const loader = new GLTFLoader();
loader.load(
  TILE_PATH,
  async (gltf) => {
    const tile = gltf.scene;
    tile.name = 'Ferry metric tile LOD0';
    tile.traverse((node) => {
      if (!node.isMesh) return;
      node.receiveShadow = true;
      node.castShadow = node.material?.name === 'buildings-night';
      if (node.material?.name === 'terrain-night') node.material.color.setHex(0x18382f);
      if (node.material?.name === 'roads-night') node.material.color.setHex(0xa8b89d);
      if (node.material?.name === 'buildings-night') node.material.color.setHex(0xb87842);
    });
    scene.add(tile);

    const receipt = await receiptPromise;
    document.querySelector('#road-count').textContent = receipt.counts.emittedRoadWays;
    document.querySelector('#building-count').textContent = receipt.counts.emittedBuildingWays;
    document.querySelector('#terrain-resolution').textContent = `${receipt.deterministicInputs.terrainGridStepMetres} m grid`;
    document.querySelector('#load-state').textContent = 'Verified tile loaded';
    document.querySelector('#load-progress').style.width = '100%';
    window.setTimeout(() => document.querySelector('#loading').classList.add('is-done'), 280);
    window.__SF_MAP_VIEWER__ = Object.freeze({ tile, receipt, ferryPosition: FERRY.clone(), setView });
  },
  (event) => {
    if (!event.total) return;
    document.querySelector('#load-progress').style.width = `${Math.round((event.loaded / event.total) * 100)}%`;
  },
  (error) => {
    document.querySelector('#load-state').textContent = 'Tile load failed';
    document.querySelector('.loading p').textContent = error.message;
    console.error(error);
  },
);

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  controls.update(clock.getDelta());
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
