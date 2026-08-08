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
const explorerUi = installExplorerUi();
const locationForm = explorerUi.locationForm;
const locationInput = explorerUi.locationInput;
const loadingHud = explorerUi.loadingHud;
const loadingTitle = explorerUi.loadingTitle;
const loadingDetail = explorerUi.loadingDetail;
const fieldGuide = explorerUi.fieldGuide;
const guideToggle = explorerUi.guideToggle;
const inspectorKind = explorerUi.inspectorKind;
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
  busy: false,
};

let pillTimer = null;

function installExplorerUi() {
  const toolbar = document.querySelector('.toolbar');
  const styleTools = toolbar.querySelector('[data-toolbar="styles"]');
  const actionTools = toolbar.querySelector('[data-toolbar="actions"]');
  const brand = document.querySelector('.brand');
  const inspectorHead = document.querySelector('.inspector-head');
  const inspectorHeading = inspectorHead.querySelector('h2');

  brand.querySelector('.brand-mark').textContent = '37°';
  brand.querySelector('h1').textContent = 'CITYGEN / FIELD MAP';
  brand.insertAdjacentHTML('afterbegin', '<span class="brand-pulse" aria-hidden="true"></span>');

  styleTools.setAttribute('aria-label', 'Procedural city styles');
  styleTools.insertAdjacentHTML('afterbegin', '<span class="tool-label">Generate</span>');
  actionTools.setAttribute('aria-label', 'Explorer actions');
  actionTools.insertAdjacentHTML('afterbegin', '<span class="tool-label">Tools</span>');

  const locationForm = document.createElement('form');
  locationForm.className = 'city-search';
  locationForm.setAttribute('role', 'search');
  locationForm.setAttribute('aria-label', 'Search for a real city');
  locationForm.innerHTML = `
    <label class="sr-only" for="location-search">Search city or coordinates</label>
    <span class="search-glyph" aria-hidden="true"></span>
    <input id="location-search" type="search" placeholder="Find any city…" autocomplete="off" spellcheck="false" aria-describedby="location-search-help" />
    <span id="location-search-help" class="sr-only">Enter a city, or latitude, longitude and optional radius. Press slash to focus.</span>
    <kbd aria-hidden="true">/</kbd>
    <button type="submit" aria-label="Load real city">GO</button>
  `;
  toolbar.insertBefore(locationForm, styleTools);

  const guideToggle = document.createElement('button');
  guideToggle.type = 'button';
  guideToggle.className = 'action guide-toggle';
  guideToggle.dataset.action = 'guide';
  guideToggle.textContent = '?';
  guideToggle.title = 'Show field guide (?)';
  guideToggle.setAttribute('aria-label', 'Show explorer controls');
  guideToggle.setAttribute('aria-controls', 'field-guide');
  guideToggle.setAttribute('aria-expanded', 'true');
  actionTools.append(guideToggle);

  const fieldGuide = document.createElement('aside');
  fieldGuide.id = 'field-guide';
  fieldGuide.className = 'field-guide';
  fieldGuide.setAttribute('aria-label', 'Explorer field guide');
  fieldGuide.innerHTML = `
    <header><span>FIELD GUIDE</span><button type="button" data-action="guide-close" aria-label="Close field guide">×</button></header>
    <p>Build a district, inspect its systems, then drop to street level.</p>
    <dl>
      <div><dt><kbd>Drag</kbd></dt><dd>Orbit camera</dd></div>
      <div><dt><kbd>Click</kbd></dt><dd>Inspect a feature</dd></div>
      <div><dt><kbd>M</kbd></dt><dd>Orbit / walk</dd></div>
      <div><dt><kbd>WASD</kbd></dt><dd>Move or drive</dd></div>
      <div><dt><kbd>E</kbd></dt><dd>Enter nearest car</dd></div>
      <div><dt><kbd>Esc</kbd></dt><dd>Exit current mode</dd></div>
    </dl>
    <button type="button" class="guide-cta" data-action="guide-dismiss">Got it — start exploring</button>
  `;
  app.append(fieldGuide);

  const loadingHud = document.createElement('div');
  loadingHud.className = 'loading-hud';
  loadingHud.setAttribute('role', 'status');
  loadingHud.setAttribute('aria-live', 'polite');
  loadingHud.innerHTML = `
    <div class="loading-card">
      <span class="loading-radar" aria-hidden="true"></span>
      <div><p>GENERATING SECTOR</p><strong>Plotting streets…</strong><span>Assembling the city model</span></div>
    </div>
  `;
  app.append(loadingHud);
  const loadingTitle = loadingHud.querySelector('strong');
  const loadingDetail = loadingHud.querySelector('.loading-card div > span');

  const inspectorKind = document.createElement('p');
  inspectorKind.id = 'inspector-kind';
  inspectorKind.className = 'inspector-kind';
  inspectorKind.textContent = 'FEATURE DATA';
  inspectorHead.insertBefore(inspectorKind, inspectorHeading);

  const osmFormEl = document.querySelector('#osm-form');
  const osmInput = document.querySelector('#osm-city');
  osmInput.setAttribute('list', 'city-suggestions');
  osmInput.insertAdjacentHTML('afterend', `
    <datalist id="city-suggestions">
      <option value="San Francisco, CA"></option>
      <option value="New York, NY"></option>
      <option value="Tokyo, Japan"></option>
      <option value="Barcelona, Spain"></option>
      <option value="Lisbon, Portugal"></option>
    </datalist>
    <div class="location-presets" aria-label="Suggested locations">
      <span>Quick coordinates</span>
      <button type="button" data-location="San Francisco, CA">San Francisco</button>
      <button type="button" data-location="New York, NY">New York</button>
      <button type="button" data-location="Tokyo, Japan">Tokyo</button>
      <button type="button" data-location="Barcelona, Spain">Barcelona</button>
    </div>
  `);
  document.querySelector('[data-action="osm"]').textContent = 'Find city';
  document.querySelector('[data-action="regenerate"]').textContent = 'Remix';
  document.querySelector('[data-action="place"]').textContent = 'Build';
  document.querySelector('[data-action="seed"]').setAttribute('aria-keyshortcuts', 'S');
  document.querySelector('[data-action="regenerate"]').setAttribute('aria-keyshortcuts', 'G');

  return {
    locationForm,
    locationInput: locationForm.querySelector('input'),
    loadingHud,
    loadingTitle,
    loadingDetail,
    fieldGuide,
    guideToggle,
    inspectorKind,
    osmForm: osmFormEl,
  };
}

function setExplorerBusy(busy, title = 'Plotting streets…', detail = 'Assembling the city model') {
  state.busy = busy;
  app.setAttribute('aria-busy', String(busy));
  document.body.classList.toggle('is-generating', busy);
  loadingHud.hidden = !busy;
  loadingTitle.textContent = title;
  loadingDetail.textContent = detail;
  document.querySelectorAll('.toolbar button, .toolbar input').forEach((control) => {
    control.disabled = busy;
  });
  if (!busy) syncUndoButton();
}

function setFieldGuide(open, { remember = false } = {}) {
  fieldGuide.hidden = !open;
  guideToggle.setAttribute('aria-expanded', String(open));
  guideToggle.classList.toggle('is-active', open);
  if (remember) {
    try {
      localStorage.setItem('citygen-field-guide-seen', 'true');
    } catch {
      // The guide still works when persistent storage is unavailable.
    }
  }
}

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
  document.querySelectorAll('.preset').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.preset === city.meta.style);
  });
  drawMinimap(city);
  syncUndoButton();
  resetInspector(`Select a building, road, sidewalk, signal, or block in ${city.meta.name}.`);
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
  if (state.busy) return { ok: false, reason: 'A city is already loading' };
  setExplorerBusy(true, 'Reading city archive…', file.name);
  try {
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
    showPill(`Imported ${city.meta.name}`, 'info', 2400);
    return { ok: true, city };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    setExplorerBusy(false);
  }
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
function showInspector(title, sections, kind = 'Feature') {
  inspectorKind.textContent = `${kind.toUpperCase()} DATA`;
  inspector.dataset.kind = kind.toLowerCase();
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
  inspectorKind.textContent = 'FEATURE DATA';
  delete inspector.dataset.kind;
  inspectorTitle.textContent = 'Inspector';
  inspectorTitle.removeAttribute('title');
  inspectorFields.replaceChildren();
  inspectorEmpty.hidden = false;
  inspectorEmpty.textContent = message || 'Nothing selected. Click a building, street, signal, or block.';
  delete inspector.dataset.copyText;
  inspector.hidden = false;
}

function showStreetInspector(segment, { sidewalk = false } = {}) {
  if (!segment) return false;
  const street = state.city.streets.find((candidate) => candidate.id === segment.streetId);
  const name = street?.name || segment.streetName || 'Unnamed street';
  const direction = segment.oneway === 'both' ? 'Two-way' : `One-way (${segment.oneway})`;
  const sidewalkWidth = Number(segment.sidewalkW || 0);
  if (sidewalk) {
    showInspector(`${name} sidewalk`, {
      'Sidewalk': {
        'Street': name,
        'Clear width': sidewalkWidth > 0 ? `${sidewalkWidth.toFixed(1)} m each side` : 'No mapped sidewalk',
        'Edges': sidewalkWidth > 0 ? 'Both sides' : '—',
        'Surface': 'Paved',
        'Segment': segment.id,
      },
      'Street context': {
        'Road class': segment.highway,
        'Carriageway': `${Number(segment.width || 0).toFixed(1)} m`,
        'Full corridor': `${(Number(segment.width || 0) + sidewalkWidth * 2).toFixed(1)} m`,
        'Traffic': direction,
        'Crossing signal': segment.signalId || 'None on segment',
      },
    }, 'Sidewalk');
    return true;
  }
  showInspector(name, {
    'Road': {
      'Segment': segment.id,
      'Street ID': segment.streetId,
      'Class': segment.highway,
      'Lanes': segment.lanes,
      'Traffic': direction,
      'Speed limit': segment.maxspeed || '—',
    },
    'Right of way': {
      'Asphalt': `${Number(segment.width || 0).toFixed(1)} m`,
      'Sidewalk': sidewalkWidth > 0 ? `${sidewalkWidth.toFixed(1)} m each side` : 'None mapped',
      'Cycleway': segment.cycleway || '—',
      'Traffic signal': segment.signalId || 'None on segment',
    },
  }, 'Road');
  return true;
}

function inspectWorld(point, hit) {
  const city = state.city;
  const x = point.x;
  const z = point.z;
  const hitKind = hit?.object?.userData?.kind;
  const near = lookupAt(city, x, z, { maxBuildingDistance: 8 });
  if (hitKind === 'signal' || near.signal) {
    const signal = city.signals.find((s) => s.id === hit?.object?.userData?.id) || near.signal;
    if (signal) {
      const streets = signal.streetIds.map((id) => city.streets.find((s) => s.id === id)?.name || id);
      showInspector(`Signal ${signal.id}`, {
        'Signal': {
          'Intersection': signal.intersectionId,
          'Streets': streets.join(' × '),
          'Phase period': `${signal.period}s`,
          'Phase offset': `${signal.phaseOffset}s`,
          'Heading': `${signal.heading}°`,
          'Position': `${Math.round(x)}, ${Math.round(z)}`,
        },
        'Operations': {
          'Control': 'Timed traffic signal',
          'Cycle': `${signal.period}s`,
          'Offset': `${signal.phaseOffset}s`,
        },
      }, 'Signal');
      return;
    }
  }
  if (hitKind === 'sidewalks') {
    showStreetInspector(near.street || nearestSegment(city, x, z), { sidewalk: true });
    return;
  }
  if (hitKind === 'roads') {
    showStreetInspector(near.street || nearestSegment(city, x, z));
    return;
  }
  const building = city.buildings.find((b) => b.id === hit?.object?.userData?.buildingId);
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
    }, 'Building');
    return;
  }
  const segment = near.street || nearestSegment(city, x, z);
  if (segment && near.streetDistance < 18) {
    showStreetInspector(segment);
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
    }, 'Block');
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
  }, 'City');
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
  if (state.busy) return;
  const label = style === 'sanfrancisco' ? 'San Francisco' : style === 'gridiron' ? 'Gridiron' : 'Garden city';
  setExplorerBusy(true, `Generating ${label}…`, `Resolving seed ${seed} into streets, blocks, and buildings`);
  state.style = style;
  state.seed = seed;
  state.addedBuildings = [];
  state.sandboxStats.buildingsPlaced = 0;
  state.sandboxStats.blocksTouched.clear();
  state.cash = 1250;
  state.clock = 9;
  togglePlacement(false);
  try {
    await buildCity(makeCity(style, seed));
    showPill(`${label} ready · seed ${seed}`, 'info', 1800);
  } finally {
    setExplorerBusy(false);
  }
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
  if (osmBusy || state.busy) return;
  const label = query || 'San Francisco, CA';
  locationInput.value = label;
  setOsmBusy(true, `Geocoding ${label}… then fetching roads and footprints. Can take ~45s.`);
  setExplorerBusy(true, `Locating ${label}…`, 'Contacting OpenStreetMap, then assembling local geometry');
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
  } finally {
    setExplorerBusy(false);
  }
}

async function loadBuiltinSf() {
  if (osmBusy || state.busy) return;
  setOsmBusy(true, 'Loading prebuilt San Francisco OSM extract…');
  setExplorerBusy(true, 'Opening San Francisco extract…', 'Building streets, terrain, and structures from local OSM data');
  try {
    const city = await loadSfData({ center: [1600, 400], radius: 720, maxBuildings: 900 });
    await buildCity(city);
    showOsmResult(city);
  } catch (error) {
    reportError(`Built-in SF failed: ${error.message}`, 'sf-builtin');
    setOsmBusy(false, '');
    osmStatus.classList.add('is-error');
    osmStatus.textContent = `Could not load built-in San Francisco: ${error.message}`;
  } finally {
    setExplorerBusy(false);
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
      state.clock = state.day ? 9 : 21;
      state.renderer.setTimeOfDay(state.clock);
      document.querySelector('[data-action="time"]').textContent = state.day ? 'Day' : 'Night';
      syncDayTheme();
      updateReadout(state.city);
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
        const bounds = state.city.meta.bounds;
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerZ = (bounds.minZ + bounds.maxZ) / 2;
        const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
        setFov(52);
        camera.position.set(centerX + span * 0.26, Math.max(230, span * 0.34), centerZ + span * 0.38);
        camera.lookAt(centerX, 12, centerZ);
        controls.target.set(centerX, 12, centerZ);
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
        const buildingBoxes = (city.buildings || []).map((building) => {
          const xs = building.polygon?.map((point) => point.x) || [];
          const zs = building.polygon?.map((point) => point.z) || [];
          return xs.length ? {
            minX: Math.min(...xs) - 4,
            maxX: Math.max(...xs) + 4,
            minZ: Math.min(...zs) - 4,
            maxZ: Math.max(...zs) + 4,
          } : null;
        }).filter(Boolean);
        const pointIsClear = (x, z) => !buildingBoxes.some((box) => (
          x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ
        ));
        const corridorIsClear = (segment) => {
          const a = segment.points[0];
          const b = segment.points[segment.points.length - 1];
          return [0.18, 0.34, 0.5, 0.66, 0.82].every((t) => (
            pointIsClear(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)
          ));
        };
        const candidates = (city.segments || []).filter((segment) => {
          if (segment.highway === 'pedestrian' || segment.highway === 'footway' || segment.highway === 'cycleway') return false;
          if (!segment.streetName) return false;
          const a = segment.points[0];
          const b = segment.points[segment.points.length - 1];
          return Math.hypot(b.x - a.x, b.z - a.z) > 70 && corridorIsClear(segment);
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
          const lateralOffset = realMap ? 0.35 : 1.2;
          const eyeX = a.x + dx * 0.2 + nx * lateralOffset * side;
          const eyeZ = a.z + dz * 0.2 + nz * lateralOffset * side;
          const targetX = a.x + dx * 0.78;
          const targetZ = a.z + dz * 0.78;
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
  let guideSeen = false;
  try {
    guideSeen = localStorage.getItem('citygen-field-guide-seen') === 'true';
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  setFieldGuide(!guideSeen);

  // Crisp minimap: physical pixels backing a 148px CSS box.
  const minimapDpr = Math.min(window.devicePixelRatio || 1, 2);
  minimapCanvas.width = MINIMAP.css * minimapDpr;
  minimapCanvas.height = MINIMAP.css * minimapDpr;
  minimapCanvas.setAttribute('role', 'button');
  minimapCanvas.setAttribute('tabindex', '0');
  minimapCanvas.setAttribute('aria-label', 'City minimap: click to fly the camera to a spot');

  const pointer = new THREE.Vector2();
  let inspectPointerStart = null;
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
    inspectPointerStart = { x: event.clientX, y: event.clientY, moved: false };
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
      return;
    }
    if (inspectPointerStart && Math.hypot(
      event.clientX - inspectPointerStart.x,
      event.clientY - inspectPointerStart.y,
    ) > 5) {
      inspectPointerStart.moved = true;
    }
  });
  window.addEventListener('pointerup', (event) => {
    state.player.lastPointer = null;
    if (!inspectPointerStart) return;
    const shouldInspect = !inspectPointerStart.moved
      && event.target === renderer.renderer.domElement
      && state.mode === 'orbit'
      && !state.placement;
    inspectPointerStart = null;
    if (!shouldInspect) return;
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    const hit = renderer.pick(pointer);
    const world = hit?.point || pointerWorld(pointer) || new THREE.Vector3();
    inspectWorld(world, hit);
  });

  document.querySelectorAll('.preset').forEach((button) => {
    button.addEventListener('click', async () => {
      document.querySelectorAll('.preset').forEach((b) => b.classList.remove('is-active'));
      button.classList.add('is-active');
      await generate(button.dataset.preset, state.seed);
    });
  });
  document.querySelector('[data-action="regenerate"]').addEventListener('click', async () => {
    const seed = Math.floor(Math.random() * 99999);
    await generate(state.style, seed);
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
    const result = await importMetadataFile(file);
    if (!result.ok) showPill(`Import failed: ${result.reason}`);
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
  locationForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = locationInput.value.trim();
    if (!query) {
      openOsmPanel();
      return;
    }
    osmCityInput.value = query;
    openOsmPanel();
    await fetchRealCity(query);
  });
  document.querySelectorAll('[data-location]').forEach((button) => {
    button.addEventListener('click', async () => {
      const query = button.dataset.location;
      osmCityInput.value = query;
      locationInput.value = query;
      await fetchRealCity(query);
    });
  });
  guideToggle.addEventListener('click', () => {
    setFieldGuide(fieldGuide.hidden);
  });
  fieldGuide.querySelector('[data-action="guide-close"]').addEventListener('click', () => {
    setFieldGuide(false);
  });
  fieldGuide.querySelector('[data-action="guide-dismiss"]').addEventListener('click', () => {
    setFieldGuide(false, { remember: true });
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
    if (key === '/') {
      event.preventDefault();
      locationInput.focus();
      return;
    }
    if (key === '?') {
      setFieldGuide(fieldGuide.hidden);
      return;
    }
    if (key === 'g' && !state.busy) {
      document.querySelector('[data-action="regenerate"]').click();
      return;
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
      if (state.city) {
        drawMinimap(state.city);
        readoutClock.textContent = formatClock(state.clock);
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot().catch((error) => {
  reportError(error.message, 'boot');
});
