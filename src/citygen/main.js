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
const osmCityInput = document.querySelector('#osm-city');
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

function makeCity(style, seed) {
  return generateCity({ seed, style, extent: 660 });
}

function fmt(value) {
  return Number(value).toLocaleString('en-US');
}

function drawMinimap(city) {
  if (!city) return;
  const context = minimapCanvas.getContext('2d');
  const size = minimapCanvas.width;
  const bounds = city.meta.bounds;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const scale = (size - 24) / span;
  const toX = (x) => 12 + (x - bounds.minX) * scale;
  const toY = (z) => size - 12 - (z - bounds.minZ) * scale;
  context.clearRect(0, 0, size, size);
  context.fillStyle = '#cfe0cf';
  context.fillRect(0, 0, size, size);

  context.fillStyle = 'rgba(90, 132, 170, 0.65)';
  context.fillRect(toX(bounds.maxX - 40), 0, size, size);

  for (const block of city.blocks) {
    context.fillStyle = block.landUse === 'park' ? 'rgba(122, 168, 106, 0.85)' : 'rgba(232, 224, 205, 0.85)';
    context.beginPath();
    context.moveTo(toX(block.polygon[0].x), toY(block.polygon[0].z));
    for (let i = 1; i < block.polygon.length; i += 1) {
      context.lineTo(toX(block.polygon[i].x), toY(block.polygon[i].z));
    }
    context.closePath();
    context.fill();
  }

  const roadColor = {
    primary: '#e8a45c',
    secondary: '#d7c47d',
    tertiary: '#c9c4ad',
    residential: '#aeb1a5',
    service: '#b7bab0',
  };
  context.lineCap = 'round';
  for (const street of city.streets) {
    context.strokeStyle = roadColor[street.highway] || '#aeb1a5';
    context.lineWidth = street.highway === 'primary' ? 4 : street.highway === 'secondary' ? 3.2 : 2.4;
    const axis = street.axis;
    const position = street.position;
    const a = axis === 'x' ? { x: position, z: bounds.minZ } : { x: bounds.minX, z: position };
    const b = axis === 'x' ? { x: position, z: bounds.maxZ } : { x: bounds.maxX, z: position };
    context.beginPath();
    context.moveTo(toX(a.x), toY(a.z));
    context.lineTo(toX(b.x), toY(b.z));
    context.stroke();
  }

  context.fillStyle = '#d96a4f';
  for (const signal of city.signals) {
    context.beginPath();
    context.arc(toX(signal.position.x), toY(signal.position.z), 2.8, 0, Math.PI * 2);
    context.fill();
  }
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
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  state.renderer.camera.position.set(span * 0.34, span * 0.27, span * 0.52);
  state.renderer.controls.target.set(0, 8, 0);
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
}

async function placeAt(x, z) {
  const result = proposeBuildingPlacement(state.city, x, z);
  if (!result.ok) {
    if (state.ghost) {
      state.ghost.box.material.color.set('#e5484d');
      state.ghost.box.material.opacity = 0.5;
    }
    return false;
  }
  state.addedBuildings.push(result.building.id);
  state.sandboxStats.buildingsPlaced += 1;
  state.sandboxStats.blocksTouched.add(result.building.blockId);
  state.cash += Math.round(result.building.height * 4 + 150);
  await buildCity(state.city, { reframe: false });
  updateGhost(x, z);
  return true;
}

async function undoLastAdded() {
  const id = state.addedBuildings.pop();
  if (!id) return;
  removeBuildingById(state.city, id);
  await buildCity(state.city, { reframe: false });
}

function syncPlacementState() {
  document.querySelector('[data-action="place"]').classList.toggle('is-active', state.placement);
  hintEl.textContent = state.vehicle
    ? 'Drive mode · W throttle · S brake · A/D steer · E exit'
    : state.placement
      ? 'Add mode · click a block to build · drag orbit · Esc to exit'
      : state.mode === 'walk'
        ? 'Walk mode · WASD move · E enter a car · M orbit'
        : 'Drag orbit · click inspect · WASD walk · E enter a car · Esc exit';
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

function addField(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value ?? '—';
  inspectorFields.append(dt, dd);
}

function showInspector(title, fields) {
  inspectorTitle.textContent = title;
  inspectorFields.replaceChildren();
  for (const [label, value] of Object.entries(fields)) addField(label, value);
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
        'Intersection': signal.intersectionId,
        'Streets': streets.join(' × '),
        'Phase period': `${signal.period}s`,
        'Phase offset': `${signal.phaseOffset}s`,
        'Heading': signal.heading,
        'Position': `${Math.round(x)}, ${Math.round(z)}`,
      });
      return;
    }
  }
  const building = city.buildings.find((b) => b.id === hit?.object?.userData?.buildingId);
  const near = lookupAt(city, x, z);
  const effectiveBuilding = building || near.building || nearestBuilding(city, x, z);
  if (effectiveBuilding) {
    showInspector(effectiveBuilding.name || effectiveBuilding.typeLabel, {
      'ID': effectiveBuilding.id,
      'Type': effectiveBuilding.typeLabel,
      'Usage': effectiveBuilding.usage,
      'District': effectiveBuilding.district,
      'Block': effectiveBuilding.blockId,
      'Address': `${Math.round(x)}, ${Math.round(z)}`,
      'Stories': effectiveBuilding.stories,
      'Height': `${effectiveBuilding.height.toFixed(1)} m`,
      'Footprint': `${fmt(Math.round(effectiveBuilding.footprintArea))} m²`,
      'Built': effectiveBuilding.yearBuilt,
      'Material': effectiveBuilding.material,
      'Facade': effectiveBuilding.facade,
      'Facing': effectiveBuilding.facingStreet || '—',
    });
    return;
  }
  const segment = near.street || nearestSegment(city, x, z);
  if (segment && near.streetDistance < 18) {
    const street = city.streets.find((s) => s.id === segment.streetId);
    showInspector(street?.name || segment.streetName, {
      'ID': segment.id,
      'Street': segment.streetId,
      'Highway': segment.highway,
      'Lanes': segment.lanes,
      'Traffic': segment.oneway === 'both' ? 'Two-way' : `One-way (${segment.oneway})`,
      'Asphalt': `${segment.width.toFixed(1)} m`,
      'Sidewalk': `${segment.sidewalkW.toFixed(1)} m`,
      'Signal': segment.signalId || 'none',
    });
    return;
  }
  const block = near.block || city.blocks.find((b) => pointInPolygonBox(b, x, z));
  if (block) {
    showInspector(`Block ${block.id}`, {
      'District': block.district,
      'Land use': block.landUse || 'mixed',
      'Buildings': fmt(block.buildings.length),
      'Streets': block.streets.map((id) => city.streets.find((s) => s.id === id)?.name || id).join(' · '),
      'Position': `${Math.round(x)}, ${Math.round(z)}`,
    });
    return;
  }
  showInspector('City', {
    'Name': city.meta.name,
    'Generator': city.meta.generator,
    'Buildings': fmt(city.buildings.length),
    'Streets': fmt(city.streets.length),
    'Signals': fmt(city.signals.length),
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

async function fetchRealCity(query) {
  osmStatus.textContent = 'Contacting OpenStreetMap… this can take up to 45s.';
  try {
    const city = await fetchOsmCity({ query, radius: 520 });
    if (!city.buildings.length && !city.segments.length) throw new Error('No map data returned');
    await buildCity(city);
    osmOverlay.hidden = true;
  } catch (error) {
    state.errors.push(`OSM failed: ${error.message}`);
    osmStatus.textContent = `Could not fetch ${query}. Showing procedural fallback.`;
    await generate(state.style, state.seed);
    osmOverlay.hidden = true;
  }
}

async function loadBuiltinSf() {
  osmStatus.textContent = 'Loading prebuilt real San Francisco data…';
  try {
    const city = await loadSfData({ center: [1600, 400], radius: 720, maxBuildings: 900 });
    await buildCity(city);
    osmOverlay.hidden = true;
  } catch (error) {
    state.errors.push(`SF built-in failed: ${error.message}`);
    osmStatus.textContent = `Could not load built-in SF. ${error.message}`;
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
      errors: state.errors,
      mode: () => state.mode,
    }),
    generate,
    setTime: (hour) => {
      state.renderer.setTimeOfDay(hour);
    },
    setDay: (day) => {
      state.day = Boolean(day);
      document.querySelector('[data-action="time"]').textContent = state.day ? 'Day' : 'Night';
    },
    setClock: (hour) => {
      state.clock = clamp(Number(hour) || 9, 0, 24);
      state.day = state.clock >= 6 && state.clock < 20;
      state.renderer.setTimeOfDay(state.clock);
      document.querySelector('[data-action="time"]').textContent = state.day ? 'Day' : 'Night';
      updateReadout(state.city);
    },
    setCameraPose: (pose) => {
      const camera = state.renderer.camera;
      const controls = state.renderer.controls;
      if (pose === 'street') {
        const city = state.city;
        const primary = city.streets.find((street) => street.highway === 'primary');
        const axis = primary?.axis || 'x';
        const position = primary?.position || 0;
        const bounds = city.meta.bounds;
        const along = (bounds.maxZ - bounds.minZ) / 2 - 60;
        const eye = axis === 'x'
          ? { x: position - 9, z: -along * 0.18 }
          : { x: -along * 0.18, z: position - 9 };
        const target = axis === 'x'
          ? { x: position + 8, z: -along * 0.82 }
          : { x: -along * 0.82, z: position + 8 };
        camera.position.set(eye.x, 2.9, eye.z);
        camera.lookAt(target.x, 0.9, target.z);
        controls.target.set(target.x, 0.9, target.z);
      } else if (pose === 'aerial') {
        camera.position.set(90, 230, 140);
        camera.lookAt(0, 8, 0);
        controls.target.set(0, 8, 0);
      } else if (pose === 'night') {
        const city = state.city;
        // Frame an actual storefront on a major avenue so neon, awnings,
        // lamps, and traffic fill the frame instead of a dark residential wall.
        const avenue = city.streets.find((street) => street.highway === 'primary' || street.highway === 'secondary');
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
        let eye;
        let target;
        if (faceAxis === 'x') {
          const side = (street?.position ?? 0) > centerX ? 1 : -1;
          eye = { x: side > 0 ? maxX + 15 : minX - 15, z: centerZ };
          target = { x: side > 0 ? maxX + 0.6 : minX - 0.6, z: centerZ };
        } else {
          const side = (street?.position ?? 0) > centerZ ? 1 : -1;
          eye = { x: centerX, z: side > 0 ? maxZ + 15 : minZ - 15 };
          target = { x: centerX, z: side > 0 ? maxZ + 0.6 : minZ - 0.6 };
        }
        const eyeY = (state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(eye.x, eye.z) : 0) + 2.8;
        camera.position.set(eye.x, eyeY, eye.z);
        camera.lookAt(target.x, baseY + 3.6, target.z);
        controls.target.set(target.x, baseY + 3.6, target.z);
      } else if (pose === 'sf') {
        const city = state.renderer.city || state.city;
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
              if (Math.hypot(cx - mid.x, cz - mid.z) < 140) count += 1;
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
          const eyeX = a.x - dx * 0.16 + nx * 9 * side;
          const eyeZ = a.z - dz * 0.16 + nz * 9 * side;
          const targetX = b.x - dx * 0.08;
          const targetZ = b.z - dz * 0.08;
          const eyeY = (state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(eyeX, eyeZ) : 0) + 2.6;
          const targetY = (state.renderer.terrain?.heightAt ? state.renderer.terrain.heightAt(targetX, targetZ) : 0) + 1.4;
          camera.position.set(eyeX, eyeY, eyeZ);
          camera.lookAt(targetX, targetY, targetZ);
          controls.target.set(targetX, targetY, targetZ);
        }
      } else {
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
  };
  await generate('sanfrancisco', 731);
  makeGhost();

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
      if (point) placeAt(point.x, point.z);
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
    osmOverlay.hidden = false;
    osmStatus.textContent = '';
  });
  document.querySelector('[data-action="osm-go"]').addEventListener('click', async () => {
    await fetchRealCity(osmCityInput.value.trim() || 'San Francisco, CA');
  });
  document.querySelector('[data-action="sf-builtin"]').addEventListener('click', async () => {
    await loadBuiltinSf();
  });
  document.querySelector('[data-action="osm-cancel"]').addEventListener('click', () => {
    osmOverlay.hidden = true;
  });
  inspectorClose.addEventListener('click', () => {
    inspector.hidden = true;
  });
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if (key === 'escape') {
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
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot().catch((error) => {
  state.errors.push(error.message);
  console.error(error);
});
