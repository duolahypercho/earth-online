import * as THREE from 'three';
import { generateCity, describeCity, lookupAt, ringArea, clamp } from './core.js';
import { CityRenderer } from './renderer.js';
import { fetchOsmCity } from './osm.js';
import { TrafficSim } from './traffic.js';
import './styles.css';

const app = document.querySelector('#app');
const canvasHost = app;
const cityNameEl = document.querySelector('#city-name');
const readoutBuildings = document.querySelector('#readout-buildings');
const readoutBlocks = document.querySelector('#readout-blocks');
const readoutStreets = document.querySelector('#readout-streets');
const readoutSeed = document.querySelector('#readout-seed');
const inspector = document.querySelector('#inspector');
const inspectorTitle = document.querySelector('#inspector-title');
const inspectorFields = document.querySelector('#inspector-fields');
const inspectorClose = document.querySelector('#inspector-close');
const minimapCanvas = document.querySelector('#minimap-canvas');
const osmOverlay = document.querySelector('#osm-overlay');
const osmCityInput = document.querySelector('#osm-city');
const osmStatus = document.querySelector('#osm-status');

const state = {
  style: 'sanfrancisco',
  seed: 731,
  day: true,
  mode: 'orbit',
  city: null,
  renderer: null,
  traffic: null,
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
  readoutSeed.textContent = `seed ${stats.seed}`;
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

async function buildCity(city) {
  state.city = city;
  state.renderer.clearCity();
  await state.renderer.buildCity(city, { day: state.day });
  if (state.traffic) {
    state.traffic.dispose();
  }
  state.traffic = new TrafficSim(state.renderer, city, { count: city.meta.generator === 'openstreetmap' ? 14 : 26 });
  state.collision = buildCollisionGrid(city);
  frameCityCamera(city);
  updateReadout(city);
  drawMinimap(city);
}

function setMode(mode) {
  state.mode = mode;
  document.querySelector('[data-action="mode"]').textContent = mode === 'orbit' ? 'Orbit' : 'Walk';
  if (mode === 'walk') {
    state.player.x = 0;
    state.player.z = 0;
    state.player.yaw = Math.PI * 0.12;
    state.player.pitch = -0.12;
    state.renderer.setWalkMode(true);
  } else {
    state.renderer.setWalkMode(false);
    frameCityCamera(state.city);
  }
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
  await buildCity(makeCity(style, seed));
}

async function fetchRealCity(query) {
  osmStatus.textContent = 'Contacting OpenStreetMap…';
  try {
    const city = await fetchOsmCity({ query, radius: 850 });
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
      signalMeta: (state.city?.signals || [])[0] || null,
      streetMeta: (state.city?.streets || [])[0] || null,
      generator: state.city?.meta?.generator || null,
      errors: state.errors,
      mode: () => state.mode,
    }),
    generate,
    setTime: (hour) => {
      state.renderer.setTimeOfDay(hour);
    },
    setMode,
    frameCityCamera,
    inspectWorld,
  };
  await generate('sanfrancisco', 731);

  const pointer = new THREE.Vector2();
  renderer.renderer.domElement.addEventListener('pointerdown', (event) => {
    if (state.mode === 'walk') {
      state.player.lastPointer = { x: event.clientX, y: event.clientY };
      return;
    }
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    const hit = renderer.pick(pointer);
    const world = hit?.point || new THREE.Vector3();
    inspectWorld(world, hit);
  });
  renderer.renderer.domElement.addEventListener('pointermove', (event) => {
    if (state.mode !== 'walk' || !state.player.lastPointer) return;
    const dx = event.clientX - state.player.lastPointer.x;
    const dy = event.clientY - state.player.lastPointer.y;
    state.player.lastPointer = { x: event.clientX, y: event.clientY };
    state.player.yaw -= dx * 0.0035;
    state.player.pitch = clamp(state.player.pitch + dy * 0.003, -1.1, 1.0);
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
  document.querySelector('[data-action="mode"]').addEventListener('click', () => {
    setMode(state.mode === 'orbit' ? 'walk' : 'orbit');
  });
  document.querySelector('[data-action="time"]').addEventListener('click', () => {
    state.day = !state.day;
    document.querySelector('[data-action="time"]').textContent = state.day ? 'Day' : 'Night';
    state.renderer.setTimeOfDay(state.day ? 15 : 21.5);
  });
  document.querySelector('[data-action="osm"]').addEventListener('click', () => {
    osmOverlay.hidden = false;
    osmStatus.textContent = '';
  });
  document.querySelector('[data-action="osm-go"]').addEventListener('click', async () => {
    await fetchRealCity(osmCityInput.value.trim() || 'San Francisco, CA');
  });
  document.querySelector('[data-action="osm-cancel"]').addEventListener('click', () => {
    osmOverlay.hidden = true;
  });
  inspectorClose.addEventListener('click', () => {
    inspector.hidden = true;
  });
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if (key === 'escape') inspector.hidden = true;
    if (key === 'm') setMode(state.mode === 'orbit' ? 'walk' : 'orbit');
    state.player.keys.add(key);
  });
  window.addEventListener('keyup', (event) => {
    state.player.keys.delete(event.key.toLowerCase());
  });

  let last = performance.now();
  function loop(now) {
    const delta = Math.min(0.05, (now - last) / 1000);
    last = now;
    updatePlayer(delta);
    state.renderer.update(delta, {
      time: state.day ? 15 : 21.5,
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
