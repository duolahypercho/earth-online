import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSfTaxiModel } from './createSfTaxiModel.js';

const canvas = document.querySelector('#scene');
const status = document.querySelector('#status');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2430);
scene.fog = new THREE.Fog(0x1a2430, 12, 28);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 80);
camera.position.set(4.2, 2.4, 5.4);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.7, 0);
controls.enableDamping = true;

const hemi = new THREE.HemisphereLight(0xd9e7ff, 0x2a2418, 0.85);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffe0b0, 1.35);
key.position.set(4, 7, 3);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9ec4ff, 0.35);
fill.position.set(-5, 3, -2);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(8, 48),
  new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.95, metalness: 0.02 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const taxi = createSfTaxiModel({ castShadow: true, receiveShadow: true });
scene.add(taxi);

status.textContent = 'SF Taxi · img2threejs · orbit to inspect';

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  taxi.userData.tick?.(dt);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
