import * as THREE from 'three';
import {
  generateCity,
  describeCity,
  lookupAt,
  ringArea,
  clamp,
  planBuildingPlacement,
  proposeBuildingPlacement,
  removeBuildingById,
  exportCityMetadata,
  importCityMetadata,
} from './core.js';
import { CityRenderer } from './renderer.js';
import { fetchOsmCity } from './osm.js';
import { loadSfData } from './sf-data.js';
import { TrafficSim } from './traffic.js';
import './styles.css';

const app = document.querySelector('#app');
const canvasHost = app;
const cityNameEl = document.querySelector('#city-name');
const readoutBuildings = document.querySelector('#readout-buildings');
const readoutBlocks = document.querySelector('#readout-blocks');
const readoutStreets = document.querySelector('#readout-streets');
const readoutOneway = document.querySelector('#readout-oneway');
const readoutSignals = document.querySelector('#readout-signals');
const readoutSeed = document.querySelector('#readout-seed');
const readoutClock = document.querySelector('#readout-clock');
const readoutCash = document.querySelector('#readout-cash');
const inspector = document.querySelector('#inspector');
const inspectorTitle = document.querySelector('#inspector-title');
const inspectorFields = document.querySelector('#inspector-fields');
const inspectorClose = document.querySelector('#inspector-close');
const minimapCanvas = document.querySelector('#minimap-canvas');
const osmOverlay = document.querySelector('#osm-overlay');
const osmForm = document.querySelector('#osm-form');
const osmCityInput = document.querySelector('#osm-city');
const osmProgress = document.querySelector('#osm-progress');
const osmFetchButton = document.querySelector('[data-action="osm-go"]');
const osmSfButton = document.querySelector('[data-action="sf-builtin"]');
const osmCancelButton = document.querySelector('[data-action="osm-cancel"]');
const osmResult = document.querySelector('#osm-result');
const osmResultTitle = document.querySelector('#osm-result-title');
const osmResultDetail = document.querySelector('#osm-result-detail');
const statusPill = document.querySelector('#status-pill');
const statusPillText = document.querySelector('#status-pill-text');
const inspectorEmpty = document.querySelector('#inspector-empty');
const placeChip = document.querySelector('#place-chip');
const osmStatus = document.querySelector('#osm-status');
const hintEl = document.querySelector('.hint span');

const state = {
  style: 'sanfrancisco',
  seed: 731,
  day: true,
  clock: 9.0,
  cash: 1250,
  sandboxStats: {
    buildingsPlaced: 0,
    blocksTouched: new Set(),
  },
  mode: 'orbit',
  placement: false,
  addedBuildings: [],
  city: null,
  renderer: null,
  traffic: null,
  ghost: null,
  vehicle: null,
  vehicleSpeed: 0,
  vehicleSteer: 0,
  player: {
    x: 0,
    z: 0,
    yaw: Math.PI * 0.15,
    pitch: -0.16,
    keys: new Set(),
    lastPointer: null,
  },
  errors: [],
};

let pillTimer = null;

function showPill(message, kind = 'error', timeoutMs = 6000) {
  if (!message) return;
  statusPillText.textContent = message;
  statusPill.classList.toggle('is-info', kind === 'info');
  statusPill.hidden = false;
  if (pillTimer) clearTimeout(pillTimer);
  if (timeoutMs > 0) pillTimer = setTimeout(() => { statusPill.hidden = true; }, timeoutMs);
}

function reportError(message, source) {
  const entry = `${message}${source ? ` (${source})` : ''}`;
  if (state.errors.includes(entry)) return;
  state.errors.push(entry);
  if (state.errors.length > 30) state.errors.shift();
  console.error(`${source || 'citygen'}:`, message);
  showPill(entry);
}

window.addEventListener('error', (event) => reportError(event.message || 'Unknown error', 'page'));
window.addEventListener('unhandledrejection', (event) => reportError(event.reason?.message || String(event.reason), 'async'));

function syncDayTheme() {
  document.body.dataset.day = state.day ? 'true' : 'false';
}

function makeCity(style, seed) {
  return generateCity({ seed, style, extent: 660 });
}

function fmt(value) {
  return Number(value).toLocaleString('en-US');
}

const MINIMAP = {
  css: 148,
  pad: 10,
  bitmap: null,
  bounds: null,
  scale: 1,
  transform: new DOMMatrix(),
};

function minimapTrace(context, polygon) {
  context.moveTo(polygon[0].x, polygon[0].z);
  for (let i = 1; i < polygon.length; i += 1) context.lineTo(polygon[i].x, polygon[i].z);
  context.closePath();
}

function drawMinimapBase(city) {
  const bounds = city.meta.bounds;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) || 1;
  const scale = (MINIMAP.css - 2 * MINIMAP.pad) / span;
  MINIMAP.bounds = bounds;
  MINIMAP.scale = scale;
  MINIMAP.transform = new DOMMatrix()
    .translate(MINIMAP.pad, MINIMAP.css - MINIMAP.pad)
    .scale(scale, -scale)
    .translate(-bounds.minX, -bounds.minZ);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (!MINIMAP.bitmap) {
    MINIMAP.bitmap = document.createElement('canvas');
    MINIMAP.bitmap.width = MINIMAP.css * dpr;
    MINIMAP.bitmap.height = MINIMAP.css * dpr;
  }
  const context = MINIMAP.bitmap.getContext('2d');
  const px = MINIMAP.bitmap.width / MINIMAP.css;
  const t = MINIMAP.transform;
  // Background in device space, then world-space transform for geometry.
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, MINIMAP.bitmap.width, MINIMAP.bitmap.height);
  context.fillStyle = '#cfe0cf';
  context.fillRect(0, 0, MINIMAP.bitmap.width, MINIMAP.bitmap.height);
  context.setTransform(px * t.a, px * t.b, px * t.c, px * t.d, px * t.e, px * t.f);
  const cssWidth = (widthCss) => widthCss / scale;

  // Blocks
  for (const block of city.blocks) {
    if (!block.polygon?.length) continue;
    context.fillStyle = block.landUse === 'park' ? '#a8cf9d' : '#e7dfc9';
    context.beginPath();
    minimapTrace(context, block.polygon);
    context.fill();
  }
  for (const park of city.parks || []) {
    if (!park.polygon?.length) continue;
    context.fillStyle = '#93c58a';
    context.beginPath();
    minimapTrace(context, park.polygon);
    context.fill();
  }
  for (const water of city.water || []) {
    if (!water.polygon?.length) continue;
    context.fillStyle = '#8fb9d9';
    context.beginPath();
    minimapTrace(context, water.polygon);
    context.fill();
  }

  // Streets follow actual road geometry, not the generator's axis grid.
  const roadStyle = {
    primary: ['#e8a45c', 5],
    secondary: ['#d7c47d', 4],
    tertiary: ['#cdc7ae', 3],
    residential: ['#b4b7aa', 2.4],
    service: ['#bcbfb4', 2],
    pedestrian: ['#d3cdbb', 1.6],
    footway: ['#d3cdbb', 1.4],
    path: ['#d3cdbb', 1.2],
    cycleway: ['#9fbfae', 1.6],
  };
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const ordered = [...city.segments].sort((a, b) => {
    const rank = (segment) => (segment.highway === 'primary' ? 4 : segment.highway === 'secondary' ? 3 : segment.highway === 'tertiary' ? 2 : 1);
    return rank(a) - rank(b);
  });
  for (const segment of ordered) {
    const [stroke, widthCss] = roadStyle[segment.highway] || ['#b4b7aa', 2];
    const points = segment.points;
    if (!points?.length) continue;
    context.strokeStyle = stroke;
    context.lineWidth = cssWidth(Math.max(widthCss, (segment.width || 6) * scale * 0.8));
    context.beginPath();
    context.moveTo(points[0].x, points[0].z);
    for (let i = 1; i < points.length; i += 1) context.lineTo(points[i].x, points[i].z);
    context.stroke();
  }

  context.fillStyle = '#d96a4f';
  for (const signal of city.signals) {
    context.beginPath();
    context.arc(signal.position.x, signal.position.z, 2 / scale, 0, Math.PI * 2);
    context.fill();
  }
}

function minimapProject(x, z) {
  const t = MINIMAP.transform;
  return { x: t.a * x + t.c * z + t.e, y: t.b * x + t.d * z + t.f };
}

function drawMinimap(city) {
  if (!city || !state.renderer) return;
  if (!MINIMAP.bitmap) drawMinimapBase(city);
  const context = minimapCanvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const sizePx = MINIMAP.css * dpr;
  if (minimapCanvas.width !== sizePx) {
    minimapCanvas.width = sizePx;
    minimapCanvas.height = sizePx;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, MINIMAP.css, MINIMAP.css);
  if (MINIMAP.bitmap) {
    context.drawImage(MINIMAP.bitmap, 0, 0, MINIMAP.css, MINIMAP.css);
  }

  const camera = state.renderer.camera.position;
  const target = state.renderer.controls?.target;
  const pos = minimapProject(camera.x, camera.z);

  // View direction wedge points toward the controls target.
  if (target) {
    const aim = minimapProject(target.x, target.z);
    const angle = Math.atan2(aim.y - pos.y, aim.x - pos.x);
    context.fillStyle = 'rgba(28, 42, 51, 0.18)';
    context.beginPath();
    context.moveTo(pos.x, pos.y);
    context.arc(pos.x, pos.y, 22, angle - 0.42, angle + 0.42);
    context.closePath();
    context.fill();
  }

  context.fillStyle = '#ffffff';
  context.strokeStyle = '#1c2a33';
  context.lineWidth = 1.6;
  context.beginPath();
  context.arc(pos.x, pos.y, 3.6, 0, Math.PI * 2);
  context.fill();
  context.stroke();
}

function updateReadout(city) {
  const stats = describeCity(city);
  cityNameEl.textContent = city.meta.name;
  readoutBuildings.textContent = `${fmt(stats.buildings)} buildings`;
  readoutBlocks.textContent = `${fmt(stats.blocks)} blocks`;
  readoutStreets.textContent = `${fmt(stats.streets)} streets`;
  readoutOneway.textContent = `${fmt(stats.oneWayStreets)} one-way`;
  readoutSignals.textContent = `${fmt(stats.signals)} signals`;
  readoutClock.textContent = formatClock(state.clock);
  readoutCash.textContent = `$${fmt(state.cash)}`;
  readoutSeed.textContent = city.meta.generator === 'procedural'
    ? `seed ${stats.seed}`
    : city.meta.generator === 'sf-builtin'
      ? 'real San Francisco OSM'
      : 'real OSM';
}

function formatClock(hour) {
  const rounded = Math.floor(hour * 4) / 4;
  const whole = Math.floor(rounded);
  const minutes = Math.round((rounded - whole) * 60);
  const suffix = whole >= 12 ? 'PM' : 'AM';
  const display = ((whole + 11) % 12) + 1;
  return `${display}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function frameCityCamera(city) {
  const bounds = city.meta.bounds;
  state.renderer.camera.fov = 52;
  state.renderer.camera.updateProjectionMatrix();
  const buildings = city.buildings || [];
  let cx = 0;
  let cz = 0;
  let count = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const building of buildings.slice(0, 1200)) {
    const xs = building.polygon?.map((p) => p.x) || [];
    const zs = building.polygon?.map((p) => p.z) || [];
    if (!xs.length) continue;
    const bx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const bz = (Math.min(...zs) + Math.max(...zs)) / 2;
    cx += bx;
    cz += bz;
    count += 1;
    minX = Math.min(minX, bx);
    maxX = Math.max(maxX, bx);
    minZ = Math.min(minZ, bz);
    maxZ = Math.max(maxZ, bz);
  }
  if (count === 0) {
    cx = (bounds.minX + bounds.maxX) / 2;
    cz = (bounds.minZ + bounds.maxZ) / 2;
    minX = bounds.minX;
    maxX = bounds.maxX;
    minZ = bounds.minZ;
    maxZ = bounds.maxZ;
  } else {
    cx /= count;
    cz /= count;
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 160);
  const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
  const distance = realMap ? Math.max(320, span * 0.62) : Math.max(160, span * 0.62);
  const eyeX = cx + distance * 0.72;
  const eyeZ = cz + distance * 0.92;
  const targetY = state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(cx, cz) + 10 : 10;
  const groundEyeY = state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(eyeX, eyeZ) : 0;
  const eyeY = Math.max(groundEyeY + 8, targetY + span * 0.3);
  state.renderer.camera.position.set(eyeX, eyeY, eyeZ);
  state.renderer.controls.target.set(cx, targetY, cz);
  state.renderer.controls.update();
  state.renderer.controls.maxDistance = span * 1.8;
  state.renderer.controls.minDistance = 4;
}

function buildCollisionGrid(city, cell = 2) {
  const bounds = city.meta.bounds;
  const width = Math.ceil((bounds.maxX - bounds.minX) / cell);
  const depth = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
  const grid = new Uint8Array(width * depth);
  const mark = (x, z) => {
    const gx = Math.floor((x - bounds.minX) / cell);
    const gz = Math.floor((z - bounds.minZ) / cell);
    if (gx >= 0 && gx < width && gz >= 0 && gz < depth) grid[gz * width + gx] = 1;
  };
  const markRect = (minX, maxX, minZ, maxZ) => {
    for (let x = Math.max(bounds.minX, minX); x < Math.min(bounds.maxX, maxX); x += cell) {
      for (let z = Math.max(bounds.minZ, minZ); z < Math.min(bounds.maxZ, maxZ); z += cell) {
        mark(x, z);
      }
    }
  };
  for (const building of city.buildings) {
    const minX = Math.min(...building.polygon.map((p) => p.x));
    const maxX = Math.max(...building.polygon.map((p) => p.x));
    const minZ = Math.min(...building.polygon.map((p) => p.z));
    const maxZ = Math.max(...building.polygon.map((p) => p.z));
    markRect(minX - 0.35, maxX + 0.35, minZ - 0.35, maxZ + 0.35);
  }
  for (const block of city.blocks) {
    if (block.landUse !== 'park') continue;
    const minX = Math.min(...block.polygon.map((p) => p.x));
    const maxX = Math.max(...block.polygon.map((p) => p.x));
    const minZ = Math.min(...block.polygon.map((p) => p.z));
    const maxZ = Math.max(...block.polygon.map((p) => p.z));
    markRect(minX - 0.2, maxX + 0.2, minZ - 0.2, maxZ + 0.2);
  }
  return { grid, width, depth, cell, bounds, isBlocked(x, z) {
    const gx = Math.floor((x - this.bounds.minX) / this.cell);
    const gz = Math.floor((z - this.bounds.minZ) / this.cell);
    if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.depth) return true;
    return this.grid[gz * this.width + gx] === 1;
  } };
}

async function buildCity(city, { reframe = true } = {}) {
  state.city = city;
  MINIMAP.bitmap = null;
  if (state.vehicle) toggleVehicle(false);
  state.renderer.clearCity();
  await state.renderer.buildCity(city, { day: state.day });
  if (state.traffic) {
    state.traffic.dispose();
  }
  state.traffic = new TrafficSim(state.renderer, city, { count: city.meta.generator === 'openstreetmap' ? 14 : 26 });
  state.collision = buildCollisionGrid(city);
  if (reframe) frameCityCamera(city);
  updateReadout(city);
  drawMinimap(city);
  syncUndoButton();
}

function makeGhost() {
  const group = new THREE.Group();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x35d07f,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(box.geometry),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
  );
  group.add(box, edges);
  group.visible = false;
  state.renderer.scene.add(group);
  state.ghost = { group, box, edges };
}

function updateGhost(x, z) {
  if (!state.ghost || !state.city) return;
  const result = planBuildingPlacement(state.city, x, z, { commit: false });
  if (!result.ok || !result.building) {
    state.ghost.group.visible = false;
    showPlaceChip(result.reason || 'Off buildable block', false);
    return;
  }
  const points = result.building.polygon;
  const width = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
  const depth = Math.max(...points.map((p) => p.z)) - Math.min(...points.map((p) => p.z));
  const y = state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(x, z) : 0;
  state.ghost.box.scale.set(width, result.building.height, depth);
  state.ghost.box.position.set(x, y + result.building.height / 2, z);
  state.ghost.edges.scale.copy(state.ghost.box.scale);
  state.ghost.edges.position.copy(state.ghost.box.position);
  state.ghost.box.material.color.set('#35d07f');
  state.ghost.box.material.opacity = 0.32;
  state.ghost.group.visible = true;
  const block = state.city.blocks.find((b) => b.id === result.building.blockId);
  const street = result.street?.name || result.building.facingStreet;
  const context = `${block?.district || ''}${street ? ` · ${street}` : ''}`.trim();
  const size = `${width.toFixed(0)}×${depth.toFixed(0)} m`;
  showPlaceChip(`Ready to build · ${result.building.typeLabel} ${size}${context ? ` · ${context}` : ''}`, true);
}

async function placeAt(x, z) {
  const result = proposeBuildingPlacement(state.city, x, z);
  if (!result.ok) {
    if (state.ghost) {
      state.ghost.box.material.color.set('#e5484d');
      state.ghost.box.material.opacity = 0.5;
    }
    showPlaceChip(result.reason || 'Cannot build here', false);
    showPill(result.reason || 'Cannot build here', 'error', 2600);
    return false;
  }
  state.addedBuildings.push(result.building.id);
  state.sandboxStats.buildingsPlaced += 1;
  state.sandboxStats.blocksTouched.add(result.building.blockId);
  state.cash += Math.round(result.building.height * 4 + 150);
  await buildCity(state.city, { reframe: false });
  updateGhost(x, z);
  showPill(`Built ${result.building.typeLabel} · +$${Math.round(result.building.height * 4 + 150)}`, 'info', 2200);
  return true;
}

async function undoLastAdded() {
  const id = state.addedBuildings.pop();
  if (!id) {
    if (state.placement) showPill('Nothing to undo', 'info', 1600);
    return;
  }
  removeBuildingById(state.city, id);
  await buildCity(state.city, { reframe: false });
  showPill(`Removed building · ${state.addedBuildings.length} placement${state.addedBuildings.length === 1 ? '' : 's'} left to undo`, 'info', 2200);
}

function syncPlacementState() {
  document.querySelector('[data-action="place"]').classList.toggle('is-active', state.placement);
  syncUndoButton();
  if (placeChip) placeChip.hidden = !state.placement;
  if (state.placement) showPlaceChip('Hover a block to preview a footprint', null);
  hintEl.textContent = state.vehicle
    ? 'Drive mode · W throttle · S brake · A/D steer · E exit'
    : state.placement
      ? 'Add mode · click a block to build · drag orbit · Esc to exit'
      : state.mode === 'walk'
        ? 'Walk mode · WASD move · E enter a car · M orbit'
        : 'Drag orbit · click inspect · WASD walk · E enter a car · Esc exit';
}

function syncUndoButton() {
  document.querySelector('[data-action="undo"]').disabled = state.addedBuildings.length === 0;
}

function togglePlacement(force = null) {
  state.placement = force == null ? !state.placement : force;
  if (state.placement && state.mode !== 'orbit') setMode('orbit');
  if (!state.placement && state.ghost) state.ghost.group.visible = false;
  syncPlacementState();
}

function exportMetadata() {
  const payload = exportCityMetadata(state.city);
  if (!payload) return null;
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const safeName = String(payload.name || 'city').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  anchor.href = url;
  anchor.download = `${safeName}-citygen.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return text;
}

async function importMetadataFile(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Not valid JSON' };
  }
  const city = importCityMetadata(payload);
  if (!city) return { ok: false, reason: 'Missing blocks, streets, or buildings' };
  state.style = city.meta.style || 'osm';
  state.seed = String(city.meta.seed ?? state.seed);
  state.addedBuildings = [];
  state.sandboxStats.buildingsPlaced = 0;
  state.sandboxStats.blocksTouched.clear();
  await buildCity(city);
  return { ok: true, city };
}

function setMode(mode) {
  state.mode = mode;
  document.querySelector('[data-action="mode"]').textContent = mode === 'drive' ? 'Drive' : mode === 'orbit' ? 'Orbit' : 'Walk';
  if (mode === 'walk' && state.placement) togglePlacement(false);
  if (mode === 'orbit') {
    state.renderer.setWalkMode(false);
    frameCityCamera(state.city);
  } else {
    state.renderer.setWalkMode(true);
  }
  if (mode === 'walk') {
    state.player.x = 0;
    state.player.z = 0;
    state.player.yaw = Math.PI * 0.12;
    state.player.pitch = -0.12;
  }
  syncPlacementState();
}

function nearestVehicle(force = false) {
  if (!state.traffic?.cars?.length) return null;
  const candidates = state.traffic.cars.filter((car) => car.edge && !car.controlled);
  if (force && candidates.some((car) => !car.edge.signalId && car.pathIndex < car.edge.points.length - 1)) {
    const free = candidates.filter((car) => !car.edge.signalId && car.pathIndex < car.edge.points.length - 1);
    let best = null;
    let bestDistance = Infinity;
    for (const car of free) {
      const distance = Math.hypot(car.group.position.x - state.player.x, car.group.position.z - state.player.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = car;
      }
    }
    return best;
  }
  let best = null;
  let bestDistance = force ? Infinity : 14;
  for (const car of candidates) {
    const distance = Math.hypot(car.group.position.x - state.player.x, car.group.position.z - state.player.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = car;
    }
  }
  return best;
}

function toggleVehicle(force = null) {
  const enter = force == null ? !state.vehicle : Boolean(force);
  if (enter && !state.vehicle) {
    const car = nearestVehicle(force === true);
    if (!car) return false;
    state.vehicle = car;
    car.controlled = true;
    car.steerYaw = 0;
    state.vehicleSpeed = 0;
    state.vehicleSteer = 0;
    setMode('drive');
    return true;
  }
  if (state.vehicle) {
    const car = state.vehicle;
    const exitX = car.group.position.x;
    const exitZ = car.group.position.z;
    car.controlled = false;
    car.steerYaw = 0;
    state.vehicle = null;
    state.vehicleSpeed = 0;
    state.vehicleSteer = 0;
    setMode('walk');
    state.player.x = exitX;
    state.player.z = exitZ;
  }
  return true;
}

function updateVehicle(delta) {
  if (state.mode !== 'drive' || !state.vehicle || !state.traffic) return;
  const keys = state.player.keys;
  let throttle = 0;
  if (keys.has('w')) throttle += 1;
  if (keys.has('s')) throttle -= 0.65;
  if (keys.has('a')) state.vehicleSteer = clamp(state.vehicleSteer + delta * 2.4, -0.55, 0.55);
  if (keys.has('d')) state.vehicleSteer = clamp(state.vehicleSteer - delta * 2.4, -0.55, 0.55);
  if (!keys.has('a') && !keys.has('d')) state.vehicleSteer *= Math.max(0, 1 - delta * 5);
  state.vehicleSpeed = clamp(
    state.vehicleSpeed + throttle * 13 * delta - Math.sign(state.vehicleSpeed) * 4.5 * delta,
    0,
    22,
  );
  const car = state.vehicle;
  car.steerYaw = state.vehicleSteer;
  state.traffic.driveCar(car, state.vehicleSpeed, delta);
  const forward = new THREE.Vector3(Math.sin(car.group.rotation.y), 0, Math.cos(car.group.rotation.y));
  const camera = state.renderer.camera;
  const pos = car.group.position;
  camera.position.set(pos.x - forward.x * 7.2, pos.y + 3.1, pos.z - forward.z * 7.2);
  camera.lookAt(pos.x + forward.x * 8, pos.y + 0.8, pos.z + forward.z * 8);
  state.renderer.controls.target.set(pos.x + forward.x * 4, pos.y + 0.8, pos.z + forward.z * 4);
  state.renderer.controls.update();
}

function showPlaceChip(message, ok) {
  if (!placeChip) return;
  const strong = placeChip.querySelector('strong');
  const msg = placeChip.querySelector('.place-msg');
  strong.textContent = ok === true ? 'Ready' : ok === false ? 'Blocked' : 'Add';
  msg.textContent = message || '';
  placeChip.classList.toggle('is-ok', ok === true);
  placeChip.classList.toggle('is-bad', ok === false);
}

function addField(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value ?? '—';
  inspectorFields.append(dt, dd);
}

function addSection(label) {
  const dt = document.createElement('dt');
  dt.className = 'section';
  dt.textContent = label;
  inspectorFields.append(dt);
}

// sections: { [sectionName]: { [label]: value } } — rendered as grouped field sets.
function showInspector(title, sections) {
  inspectorTitle.textContent = title;
  inspectorTitle.setAttribute('title', title);
  inspectorFields.replaceChildren();
  const copyLines = [];
  for (const [section, fields] of Object.entries(sections)) {
    const entries = Object.entries(fields);
    if (!entries.length) continue;
    addSection(section);
    copyLines.push(section.toUpperCase());
    for (const [label, value] of entries) {
      addField(label, value);
      copyLines.push(`${label}: ${value ?? '—'}`);
    }
  }
  inspectorEmpty.hidden = true;
  inspector.dataset.copyText = [title, '', ...copyLines].join('\n');
  inspector.hidden = false;
}

function resetInspector(message) {
  inspectorTitle.textContent = 'Inspector';
  inspectorTitle.removeAttribute('title');
  inspectorFields.replaceChildren();
  inspectorEmpty.hidden = false;
  inspectorEmpty.textContent = message || 'Nothing selected. Click a building, street, signal, or block.';
  delete inspector.dataset.copyText;
  inspector.hidden = false;
}

function inspectWorld(point, hit) {
  const city = state.city;
  const x = point.x;
  const z = point.z;
  const hitKind = hit?.object?.userData?.kind;
  if (hitKind === 'signal') {
    const signal = city.signals.find((s) => s.id === hit.object.userData.id);
    if (signal) {
      const streets = signal.streetIds.map((id) => city.streets.find((s) => s.id === id)?.name || id);
      showInspector(`Signal ${signal.id}`, {
        'Signal': {
          'Intersection': signal.intersectionId,
          'Streets': streets.join(' × '),
          'Phase period': `${signal.period}s`,
          'Phase offset': `${signal.phaseOffset}s`,
          'Heading': signal.heading,
          'Position': `${Math.round(x)}, ${Math.round(z)}`,
        },
      });
      return;
    }
  }
  const building = city.buildings.find((b) => b.id === hit?.object?.userData?.buildingId);
  const near = lookupAt(city, x, z);
  const effectiveBuilding = building || near.building || nearestBuilding(city, x, z);
  if (effectiveBuilding) {
    showInspector(effectiveBuilding.name || effectiveBuilding.typeLabel, {
      'Building': {
        'Name': effectiveBuilding.name || '—',
        'Type': effectiveBuilding.typeLabel,
        'Usage': effectiveBuilding.usage,
        'Address': effectiveBuilding.address || `${Math.round(x)}, ${Math.round(z)}`,
        'Landmark': effectiveBuilding.landmark ? 'Yes' : 'No',
      },
      'Block': {
        'ID': effectiveBuilding.id,
        'Block': effectiveBuilding.blockId,
        'District': effectiveBuilding.district,
        'Facing': effectiveBuilding.facingStreet || '—',
      },
      'Form': {
        'Stories': effectiveBuilding.stories,
        'Height': `${effectiveBuilding.height.toFixed(1)} m`,
        'Footprint': `${fmt(Math.round(effectiveBuilding.footprintArea))} m²`,
      },
      'Character': {
        'Built': effectiveBuilding.yearBuilt,
        'Material': effectiveBuilding.material,
        'Facade': effectiveBuilding.facade,
        'Shop': effectiveBuilding.shop || '—',
        'Amenity': effectiveBuilding.amenity || '—',
      },
    });
    return;
  }
  const segment = near.street || nearestSegment(city, x, z);
  if (segment && near.streetDistance < 18) {
    const street = city.streets.find((s) => s.id === segment.streetId);
    showInspector(street?.name || segment.streetName, {
      'Street': {
        'ID': segment.id,
        'Street': segment.streetId,
        'Highway': segment.highway,
        'Lanes': segment.lanes,
        'Traffic': segment.oneway === 'both' ? 'Two-way' : `One-way (${segment.oneway})`,
        'Max speed': segment.maxspeed || '—',
      },
      'Section': {
        'Asphalt': `${segment.width.toFixed(1)} m`,
        'Sidewalk': `${segment.sidewalkW.toFixed(1)} m`,
        'Cycleway': segment.cycleway || '—',
        'Signal': segment.signalId || 'none',
      },
    });
    return;
  }
  const block = near.block || city.blocks.find((b) => pointInPolygonBox(b, x, z));
  if (block) {
    showInspector(`Block ${block.id}`, {
      'Block': {
        'District': block.district,
        'Land use': block.landUse || 'mixed',
        'Buildings': fmt(block.buildings.length),
        'Streets': block.streets.map((id) => city.streets.find((s) => s.id === id)?.name || id).join(' · '),
        'Position': `${Math.round(x)}, ${Math.round(z)}`,
      },
    });
    return;
  }
  showInspector('City', {
    'City': {
      'Name': city.meta.name,
      'Generator': city.meta.generator,
      'Buildings': fmt(city.buildings.length),
      'Streets': fmt(city.streets.length),
      'Signals': fmt(city.signals.length),
    },
  });
}

function nearestBuilding(city, x, z) {
  let best = null;
  let distance = Infinity;
  for (const building of city.buildings) {
    const cx = (Math.min(...building.polygon.map((p) => p.x)) + Math.max(...building.polygon.map((p) => p.x))) / 2;
    const cz = (Math.min(...building.polygon.map((p) => p.z)) + Math.max(...building.polygon.map((p) => p.z))) / 2;
    const d = Math.hypot(cx - x, cz - z);
    if (d < distance) {
      distance = d;
      best = building;
    }
  }
  return distance < 24 ? best : null;
}

function nearestSegment(city, x, z) {
  let best = null;
  let distance = Infinity;
  for (const segment of city.segments) {
    const a = segment.points[0];
    const b = segment.points[segment.points.length - 1];
    const d = distanceToSegment({ x, z }, a, b);
    if (d < distance) {
      distance = d;
      best = segment;
    }
  }
  return distance < 24 ? best : null;
}

function pointerWorld(pointer) {
  const renderer = state.renderer;
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, renderer.camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const point = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, point)) return point;
  return null;
}

function pointInPolygonBox(block, x, z) {
  if (!block.polygon?.length) return false;
  return x >= Math.min(...block.polygon.map((p) => p.x)) - 0.1
    && x <= Math.max(...block.polygon.map((p) => p.x)) + 0.1
    && z >= Math.min(...block.polygon.map((p) => p.z)) - 0.1
    && z <= Math.max(...block.polygon.map((p) => p.z)) + 0.1;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

async function generate(style, seed) {
  state.style = style;
  state.seed = seed;
  state.addedBuildings = [];
  state.sandboxStats.buildingsPlaced = 0;
  state.sandboxStats.blocksTouched.clear();
  state.cash = 1250;
  state.clock = 9;
  togglePlacement(false);
  await buildCity(makeCity(style, seed));
}

let osmBusy = false;
let osmResultTimer = null;

function setOsmBusy(busy, statusText) {
  osmBusy = busy;
  osmFetchButton.disabled = busy;
  osmSfButton.disabled = busy;
  osmCancelButton.disabled = busy;
  osmCityInput.disabled = busy;
  osmProgress.hidden = !busy;
  osmStatus.classList.remove('is-error');
  osmStatus.textContent = statusText || '';
}

function openOsmPanel() {
  osmForm.hidden = false;
  osmResult.hidden = true;
  osmStatus.classList.remove('is-error');
  osmStatus.textContent = '';
  osmOverlay.hidden = false;
  osmCityInput.focus();
  osmCityInput.select();
}

function showOsmResult(city) {
  const stats = describeCity(city);
  const source = city.meta.generator === 'sf-builtin'
    ? 'built-in San Francisco OSM extract'
    : `OpenStreetMap · ${city.meta.center ? `${city.meta.center.lat.toFixed(4)}, ${city.meta.center.lon.toFixed(4)}` : 'network'}`;
  osmResultTitle.textContent = `${city.meta.name} loaded`;
  osmResultDetail.textContent = `${fmt(stats.buildings)} buildings · ${fmt(stats.streets)} streets · ${fmt(stats.blocks)} blocks · ${fmt(stats.signals)} signals — ${source}`;
  osmForm.hidden = true;
  osmResult.hidden = false;
  setOsmBusy(false, '');
  // Auto-dismiss so camera QA screenshots are never occluded.
  if (osmResultTimer) clearTimeout(osmResultTimer);
  osmResultTimer = setTimeout(() => { osmOverlay.hidden = true; }, 3200);
  showPill(`Real map loaded: ${city.meta.name}`, 'info', 3000);
}

async function fetchRealCity(query) {
  if (osmBusy) return;
  const label = query || 'San Francisco, CA';
  setOsmBusy(true, `Geocoding ${label}… then fetching roads and footprints. Can take ~45s.`);
  try {
    const city = await fetchOsmCity({ query: label, radius: 520 });
    if (!city.buildings.length && !city.segments.length) throw new Error('No map data returned');
    await buildCity(city);
    showOsmResult(city);
  } catch (error) {
    reportError(`Real map fetch failed: ${error.message}`, 'osm');
    setOsmBusy(false, '');
    osmStatus.classList.add('is-error');
    osmStatus.textContent = `Could not fetch “${label}”: ${error.message}. Check the query and connection, then try again.`;
  }
}

async function loadBuiltinSf() {
  if (osmBusy) return;
  setOsmBusy(true, 'Loading prebuilt San Francisco OSM extract…');
  try {
    const city = await loadSfData({ center: [1600, 400], radius: 720, maxBuildings: 900 });
    await buildCity(city);
    showOsmResult(city);
  } catch (error) {
    reportError(`Built-in SF failed: ${error.message}`, 'sf-builtin');
    setOsmBusy(false, '');
    osmStatus.classList.add('is-error');
    osmStatus.textContent = `Could not load built-in San Francisco: ${error.message}`;
  }
}

function updatePlayer(delta) {
  const player = state.player;
  if (state.mode !== 'walk') return;
  const speed = 5.6 * delta;
  let dx = 0;
  let dz = 0;
  if (player.keys.has('w')) { dx += Math.sin(player.yaw); dz += Math.cos(player.yaw); }
  if (player.keys.has('s')) { dx -= Math.sin(player.yaw); dz -= Math.cos(player.yaw); }
  if (player.keys.has('a')) { dx += Math.cos(player.yaw); dz -= Math.sin(player.yaw); }
  if (player.keys.has('d')) { dx -= Math.cos(player.yaw); dz += Math.sin(player.yaw); }
  const length = Math.hypot(dx, dz);
  if (length > 0) {
    dx = (dx / length) * speed;
    dz = (dz / length) * speed;
    const nextX = player.x + dx;
    const nextZ = player.z + dz;
    if (!state.collision.isBlocked(nextX, player.z)) player.x = nextX;
    if (!state.collision.isBlocked(player.x, nextZ)) player.z = nextZ;
  }
  const y = state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(player.x, player.z) : 0;
  const camera = state.renderer.camera;
  camera.position.set(
    player.x - Math.sin(player.yaw) * Math.cos(player.pitch) * 4.2,
    y + 2.1 + Math.sin(player.pitch) * 3.6,
    player.z - Math.cos(player.yaw) * Math.cos(player.pitch) * 4.2,
  );
  state.renderer.controls.target.set(player.x, y + 1.6, player.z);
  state.renderer.controls.update();
}

async function boot() {
  const renderer = new CityRenderer(canvasHost, { pixelRatioCap: 1.4 });
  state.renderer = renderer;
  window.__CITYGEN__ = {
    getCity: () => state.city,
    getRenderer: () => state.renderer,
    getTraffic: () => state.traffic,
    getState: () => ({
      buildings: state.city?.buildings?.length || 0,
      blocks: state.city?.blocks?.length || 0,
      streets: state.city?.streets?.length || 0,
      signals: state.city?.signals?.length || 0,
      oneWayStreets: (state.city?.streets || []).filter((s) => s.oneway !== 'both').length,
      avgBuildingHeight: (() => {
        const list = state.city?.buildings || [];
        return list.length ? Number((list.reduce((sum, b) => sum + (b.height || 0), 0) / list.length).toFixed(1)) : 0;
      })(),
      avgStreetWidth: (() => {
        const list = state.city?.streets || [];
        return list.length ? Number((list.reduce((sum, s) => sum + (s.asphaltWidth || 0), 0) / list.length).toFixed(1)) : 0;
      })(),
      signalMeta: (state.city?.signals || [])[0] || null,
      streetMeta: (state.city?.streets || [])[0] || null,
      generator: state.city?.meta?.generator || null,
      placedBuildings: state.addedBuildings.length,
      webgl2: Boolean(state.renderer?.renderer?.capabilities?.isWebGL2),
      vehicle: Boolean(state.vehicle),
      vehicleSpeed: Math.round(state.vehicleSpeed),
      clock: state.clock,
      cash: state.cash,
      day: state.day,
      buildingsPlaced: state.sandboxStats.buildingsPlaced,
      blocksTouched: state.sandboxStats.blocksTouched.size,
      furniture: state.renderer?.streetFurniture || null,
      pedestrians: state.traffic?.pedestrians?.length || 0,
      errors: state.errors,
      mode: () => state.mode,
    }),
    generate,
    setTime: (hour) => {
      const value = clamp(Number(hour) || 9, 0, 24);
      state.clock = value;
      state.day = value >= 6 && value < 20;
      state.renderer.setTimeOfDay(value);
      document.querySelector('[data-action="time"]').textContent = state.day ? 'Day' : 'Night';
      syncDayTheme();
      updateReadout(state.city);
    },
    setDay: (day) => {
      state.day = Boolean(day);
      document.querySelector('[data-action="time"]').textContent = state.day ? 'Day' : 'Night';
      syncDayTheme();
    },
    setClock: (hour) => {
      state.clock = clamp(Number(hour) || 9, 0, 24);
      state.day = state.clock >= 6 && state.clock < 20;
      state.renderer.setTimeOfDay(state.clock);
      document.querySelector('[data-action="time"]').textContent = state.day ? 'Day' : 'Night';
      syncDayTheme();
      updateReadout(state.city);
    },
    setCameraPose: (pose) => {
      const camera = state.renderer.camera;
      const controls = state.renderer.controls;
      const setFov = (fov) => {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      };
      if (pose === 'street') {
        const city = state.city;
        const primary = city.streets.find((street) => street.highway === 'primary');
        const axis = primary?.axis || 'x';
        const position = primary?.position || 0;
        const bounds = city.meta.bounds;
        const along = (bounds.maxZ - bounds.minZ) / 2 - 60;
        setFov(48);
        const eye = axis === 'x'
          ? { x: position - 7.5, z: -along * 0.2 }
          : { x: -along * 0.2, z: position - 7.5 };
        const target = axis === 'x'
          ? { x: position + 7.5, z: -along * 0.8 }
          : { x: -along * 0.8, z: position + 7.5 };
        const eyeY = (state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(eye.x, eye.z) : 0) + 2.25;
        const targetY = (state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(target.x, target.z) : 0) + 1.1;
        camera.position.set(eye.x, eyeY, eye.z);
        camera.lookAt(target.x, targetY, target.z);
        controls.target.set(target.x, targetY, target.z);
      } else if (pose === 'aerial') {
        setFov(52);
        camera.position.set(90, 230, 140);
        camera.lookAt(0, 8, 0);
        controls.target.set(0, 8, 0);
      } else if (pose === 'night') {
        setFov(52);
        const city = state.city;
        // Street-corridor night shot: stand on the facing street centerline,
        // 30-45m down-street, and look along the avenue so shopfronts,
        // lamps, signals, and traffic fill the frame.
        const avenue = city.streets.find((street) => street.highway === 'primary' || street.highway === 'secondary' || street.highway === 'tertiary');
        const shops = city.buildings
          .filter((building) => building.type === 'shop' || building.facade === 'shopfront')
          .map((building) => {
            const xs = building.polygon.map((p) => p.x);
            const zs = building.polygon.map((p) => p.z);
            const width = Math.max(...xs) - Math.min(...xs);
            const depth = Math.max(...zs) - Math.min(...zs);
            return { building, width, depth, area: width * depth };
          })
          .sort((a, b) => b.area - a.area);
        const shop = shops.find((entry) => entry.width >= 7 || entry.depth >= 7)?.building
          || shops[0]?.building
          || city.buildings[0];
        const xs = shop.polygon.map((p) => p.x);
        const zs = shop.polygon.map((p) => p.z);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minZ = Math.min(...zs);
        const maxZ = Math.max(...zs);
        const centerX = (minX + maxX) / 2;
        const centerZ = (minZ + maxZ) / 2;
        const street = city.streets.find((s) => s.name === shop.facingStreet) || avenue;
        const faceAxis = street?.axis || 'x';
        const baseY = state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(centerX, centerZ) : 0;
        const side = faceAxis === 'x'
          ? ((street?.position ?? 0) > centerX ? 1 : -1)
          : ((street?.position ?? 0) > centerZ ? 1 : -1);
        const downStreet = faceAxis === 'x'
          ? { x: centerX, z: centerZ - 34 * side }
          : { x: centerX - 34 * side, z: centerZ };
        const eye = faceAxis === 'x'
          ? { x: centerX + (street?.position ?? centerX) - centerX + 8 * side, z: centerZ - 34 * side }
          : { x: centerX - 34 * side, z: centerZ + (street?.position ?? centerZ) - centerZ + 8 * side };
        const eyeY = (state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(eye.x, eye.z) : 0) + 5.6;
        camera.position.set(eye.x, eyeY, eye.z);
        camera.lookAt(downStreet.x, baseY + 2.6, downStreet.z);
        controls.target.set(downStreet.x, baseY + 2.6, downStreet.z);
      } else if (pose === 'sf') {
        const city = state.renderer.city || state.city;
        const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
        const candidates = (city.segments || []).filter((segment) => {
          if (segment.highway === 'pedestrian' || segment.highway === 'footway' || segment.highway === 'cycleway') return false;
          if (!segment.streetName) return false;
          const a = segment.points[0];
          const b = segment.points[segment.points.length - 1];
          return Math.hypot(b.x - a.x, b.z - a.z) > 70;
        }).sort((a, b) => {
          const len = (segment) => Math.hypot(segment.points.at(-1).x - segment.points[0].x, segment.points.at(-1).z - segment.points[0].z);
          const density = (segment) => {
            const mid = segment.points[Math.floor(segment.points.length / 2)] || segment.points[0];
            let count = 0;
            for (const building of city.buildings || []) {
              const xs = building.polygon?.map((p) => p.x) || [];
              const zs = building.polygon?.map((p) => p.z) || [];
              if (!xs.length) continue;
              const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
              const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
              if (Math.hypot(cx - mid.x, cz - mid.z) < 110) count += 1;
            }
            return count;
          };
          const shopCount = (segment) => {
            const mid = segment.points[Math.floor(segment.points.length / 2)] || segment.points[0];
            let count = 0;
            for (const building of city.buildings || []) {
              if (building.type !== 'shop' && building.facade !== 'shopfront') continue;
              const xs = building.polygon?.map((p) => p.x) || [];
              const zs = building.polygon?.map((p) => p.z) || [];
              if (!xs.length) continue;
              const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
              const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
              if (Math.hypot(cx - mid.x, cz - mid.z) < 110) count += 1;
            }
            return count;
          };
          const rank = (segment) => density(segment) * 1000
            + shopCount(segment) * 260
            + (segment.highway === 'primary' || segment.highway === 'secondary' ? 3 : segment.highway === 'tertiary' ? 2 : 1) * 10
            + Math.min(10, len(segment) / 40);
          return rank(b) - rank(a);
        });
        const segment = candidates[0] || city.segments[0];
        if (segment) {
          const a = segment.points[0];
          const b = segment.points[segment.points.length - 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const length = Math.hypot(dx, dz) || 1;
          const nx = -dz / length;
          const nz = dx / length;
          const side = (segment.points[0].x + segment.points[0].z) % 2 === 0 ? 1 : -1;
          const eyeX = a.x - dx * 0.24 + nx * (realMap ? 13 : 11) * side;
          const eyeZ = a.z - dz * 0.24 + nz * (realMap ? 13 : 11) * side;
          const targetX = b.x - dx * 0.05;
          const targetZ = b.z - dz * 0.05;
          setFov(46);
          const eyeY = (state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(eyeX, eyeZ) : 0) + 3.4;
          const targetY = (state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(targetX, targetZ) : 0) + 2.0;
          camera.position.set(eyeX, eyeY, eyeZ);
          camera.lookAt(targetX, targetY, targetZ);
          controls.target.set(targetX, targetY, targetZ);
        }
      } else {
        setFov(52);
        frameCityCamera(state.city);
      }
      controls.update();
    },
    setMode,
    frameCityCamera,
    inspectWorld,
    planPlacement: (x, z) => planBuildingPlacement(state.city, x, z, { commit: false }),
    placeBuildingAt: async (x, z) => placeAt(x, z),
    undoLastAdded: async () => undoLastAdded(),
    togglePlacement,
    enterVehicle: (force = false) => toggleVehicle(force),
    exitVehicle: () => toggleVehicle(false),
    exportMetadata,
    importMetadata: async (payload) => {
      const city = importCityMetadata(payload);
      if (!city) return { ok: false, reason: 'Invalid metadata payload' };
      state.style = city.meta.style || 'osm';
      state.seed = String(city.meta.seed ?? state.seed);
      state.addedBuildings = [];
      state.sandboxStats.buildingsPlaced = 0;
      state.sandboxStats.blocksTouched.clear();
      await buildCity(city);
      return { ok: true, city };
    },
  };
  await generate('sanfrancisco', 731);
  makeGhost();
  syncDayTheme();
  resetInspector();

  // Crisp minimap: physical pixels backing a 148px CSS box.
  const minimapDpr = Math.min(window.devicePixelRatio || 1, 2);
  minimapCanvas.width = MINIMAP.css * minimapDpr;
  minimapCanvas.height = MINIMAP.css * minimapDpr;
  minimapCanvas.setAttribute('role', 'button');
  minimapCanvas.setAttribute('tabindex', '0');
  minimapCanvas.setAttribute('aria-label', 'City minimap: click to fly the camera to a spot');

  const pointer = new THREE.Vector2();
  renderer.renderer.domElement.addEventListener('pointerdown', (event) => {
    if (state.mode === 'walk') {
      state.player.lastPointer = { x: event.clientX, y: event.clientY };
      return;
    }
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    if (state.placement) {
      const point = pointerWorld(pointer);
      if (point) placeAt(point.x, point.z).catch((error) => reportError(error.message, 'placement'));
      return;
    }
    const hit = renderer.pick(pointer);
    const world = hit?.point || new THREE.Vector3();
    inspectWorld(world, hit);
  });
  renderer.renderer.domElement.addEventListener('pointermove', (event) => {
    if (state.mode === 'walk') {
      if (!state.player.lastPointer) return;
      const dx = event.clientX - state.player.lastPointer.x;
      const dy = event.clientY - state.player.lastPointer.y;
      state.player.lastPointer = { x: event.clientX, y: event.clientY };
      state.player.yaw -= dx * 0.0035;
      state.player.pitch = clamp(state.player.pitch + dy * 0.003, -1.1, 1.0);
      return;
    }
    if (state.placement) {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
      const point = pointerWorld(pointer);
      if (point) updateGhost(point.x, point.z);
    }
  });
  window.addEventListener('pointerup', () => {
    state.player.lastPointer = null;
  });

  document.querySelectorAll('.preset').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.preset').forEach((b) => b.classList.remove('is-active'));
      button.classList.add('is-active');
      generate(button.dataset.preset, state.seed);
    });
  });
  document.querySelector('[data-action="regenerate"]').addEventListener('click', () => {
    const seed = Math.floor(Math.random() * 99999);
    generate(state.style, seed);
  });
  document.querySelector('[data-action="seed"]').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(String(state.seed)).catch(() => {});
  });
  document.querySelector('[data-action="export"]').addEventListener('click', () => {
    exportMetadata();
  });
  document.querySelector('[data-action="import"]').addEventListener('click', () => {
    document.querySelector('#import-file').click();
  });
  document.querySelector('#import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await importMetadataFile(file);
    event.target.value = '';
  });
  document.querySelector('[data-action="mode"]').addEventListener('click', () => {
    if (state.vehicle) toggleVehicle(false);
    else setMode(state.mode === 'orbit' ? 'walk' : 'orbit');
  });
  document.querySelector('[data-action="time"]').addEventListener('click', () => {
    window.__CITYGEN__.setDay(!state.day);
  });
  document.querySelector('[data-action="place"]').addEventListener('click', () => {
    togglePlacement();
  });
  document.querySelector('[data-action="undo"]').addEventListener('click', async () => {
    await undoLastAdded();
  });
  document.querySelector('[data-action="osm"]').addEventListener('click', () => {
    openOsmPanel();
  });
  osmForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await fetchRealCity(osmCityInput.value.trim() || 'San Francisco, CA');
  });
  osmSfButton.addEventListener('click', async () => {
    await loadBuiltinSf();
  });
  osmCancelButton.addEventListener('click', () => {
    if (osmBusy) return;
    osmOverlay.hidden = true;
  });
  document.querySelector('[data-action="osm-done"]').addEventListener('click', () => {
    if (osmResultTimer) clearTimeout(osmResultTimer);
    osmOverlay.hidden = true;
  });
  document.querySelector('[data-action="osm-retry"]').addEventListener('click', () => {
    if (osmResultTimer) clearTimeout(osmResultTimer);
    openOsmPanel();
  });
  inspectorClose.addEventListener('click', () => {
    inspector.hidden = true;
  });
  const inspectorCopy = document.querySelector('#inspector-copy');
  inspectorCopy.addEventListener('click', async () => {
    const text = inspector.dataset.copyText || inspectorTitle.textContent || '';
    const label = inspectorCopy.querySelector('span');
    try {
      await navigator.clipboard.writeText(text);
      inspectorCopy.classList.remove('is-fail');
      inspectorCopy.classList.add('is-ok');
      label.textContent = 'Copied';
      setTimeout(() => {
        inspectorCopy.classList.remove('is-ok');
        label.textContent = 'Copy';
      }, 1400);
    } catch {
      inspectorCopy.classList.remove('is-ok');
      inspectorCopy.classList.add('is-fail');
      label.textContent = 'Copy failed';
      setTimeout(() => {
        inspectorCopy.classList.remove('is-fail');
        label.textContent = 'Copy';
      }, 1600);
    }
  });
  minimapCanvas.addEventListener('click', (event) => {
    if (!state.city) return;
    const rect = minimapCanvas.getBoundingClientRect();
    const cssX = ((event.clientX - rect.left) / rect.width) * MINIMAP.css;
    const cssY = ((event.clientY - rect.top) / rect.height) * MINIMAP.css;
    const inv = MINIMAP.transform.inverse();
    const worldX = inv.a * cssX + inv.c * cssY + inv.e;
    const worldZ = inv.b * cssX + inv.d * cssY + inv.f;
    const y = state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(worldX, worldZ) : 0;
    if (state.mode !== 'orbit') setMode('orbit');
    state.renderer.controls.target.set(worldX, y + 6, worldZ);
    state.renderer.camera.position.set(worldX + 70, y + 48, worldZ + 70);
    state.renderer.camera.lookAt(worldX, y + 4, worldZ);
    state.renderer.controls.update();
  });
  minimapCanvas.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && state.city) {
      event.preventDefault();
      // Fly to the city center when activated by keyboard.
      minimapCanvas.dispatchEvent(new MouseEvent('click', { clientX: rectCenter().x, clientY: rectCenter().y, bubbles: true }));
    }
  });
  function rectCenter() {
    const rect = minimapCanvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const typing = event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA');
    if (typing) {
      if (key === 'escape') event.target.blur();
      else return;
    }
    if (key === 'escape') {
      if (!osmOverlay.hidden) {
        if (!osmBusy) osmOverlay.hidden = true;
        return;
      }
      if (state.placement) togglePlacement(false);
      else if (state.vehicle) toggleVehicle(false);
      else inspector.hidden = true;
    }
    if (key === 'e') toggleVehicle();
    if (key === 'm') {
      if (state.vehicle) toggleVehicle(false);
      else setMode(state.mode === 'orbit' ? 'walk' : 'orbit');
    }
    state.player.keys.add(key);
  });
  window.addEventListener('keyup', (event) => {
    state.player.keys.delete(event.key.toLowerCase());
  });

  let last = performance.now();
  let lastMinimapSecond = -1;
  function loop(now) {
    const delta = Math.min(0.05, (now - last) / 1000);
    last = now;
    state.clock = (state.clock + delta * 0.6) % 24;
    updatePlayer(delta);
    updateVehicle(delta);
    state.renderer.update(delta, {
      time: state.clock,
      traffic: state.traffic,
    });
    state.renderer.renderFrame();
    const second = Math.floor(now / 1000);
    if (second !== lastMinimapSecond) {
      lastMinimapSecond = second;
      if (state.city) drawMinimap(state.city);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot().catch((error) => {
  reportError(error.message, 'boot');
});
