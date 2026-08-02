import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  createRoadAuthoringDocument,
  addRoadTemplate,
  addRoadStroke,
  makeLineSegment,
  resolveAutomaticNetwork,
  compileRoadNetwork,
} from '../../vendor/three-roads/core.js';
import {
  buildRoadSurfaceModel,
  meshRoadSurfaceModel,
} from '../../vendor/three-roads/mesher.js';
import { SIGNAL_PERIOD, signalPhaseAt } from '../signals.js';
import './styles.css';

const app = document.querySelector('#app');
const mapCanvas = document.querySelector('#map-canvas');
const sceneCanvas = document.querySelector('#scene-canvas');
const bootOverlay = document.querySelector('#boot-overlay');
const bootStatus = document.querySelector('#boot-status');
const bootBar = document.querySelector('#boot-bar');
const launchButton = document.querySelector('#launch-button');
const buildOverlay = document.querySelector('#build-overlay');
const buildBar = document.querySelector('#build-bar');
const buildStatus = document.querySelector('#build-status');
const buildStage = document.querySelector('#build-stage');
const buildTitle = document.querySelector('#build-title');
const hud = document.querySelector('#hud');
const modeLabel = document.querySelector('#mode-label');
const readoutVertices = document.querySelector('#readout-vertices');
const readoutArea = document.querySelector('#readout-area');
const readoutSelected = document.querySelector('#readout-selected');
const readoutMission = document.querySelector('#readout-mission');
const hint = document.querySelector('#hint');
const inspector = document.querySelector('#inspector');
const inspectorTitle = document.querySelector('#inspector-title');
const inspectorFields = document.querySelector('#inspector-fields');
const inspectorClose = document.querySelector('#inspector-close');

const publicAsset = (path) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
const DATA_URL = publicAsset('data/sf/sf-city.json.gz');
const DATA_FALLBACK_URL = publicAsset('data/sf/sf-city.json');
const ELEVATION_URL = publicAsset('data/sf/sf-elevation.json.gz');
const ELEVATION_FALLBACK_URL = publicAsset('data/sf/sf-elevation.json');

let cityData = null;
let terrainData = null;
let region = [];
let mapCamera = { x: 0, z: 0, scale: 1 };
let activeTool = 'draw';
let drawCursor = null;
let mapDirty = true;
let mapPointer = null;
let viewportWidth = 0;
let viewportHeight = 0;

const roadPalette = {
  motorway: '#e28a3f',
  trunk: '#e8a13f',
  primary: '#f0c96a',
  secondary: '#e6e0c8',
  tertiary: '#d8d4c4',
  unclassified: '#c9c8bf',
  residential: '#c3c5bd',
  living_street: '#c3c5bd',
  service: '#aeb3ad',
  pedestrian: '#c8bfa8',
  footway: '#b9c0b2',
  cycleway: '#b8c9ad',
  path: '#aeb7aa',
};

const ROAD_ORDER = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'pedestrian',
  'footway',
  'cycleway',
  'path',
];

const PRESETS = {
  downtown: [
    [560, 420], [2320, 420], [2380, 1180], [3260, 1180],
    [3260, 2280], [2180, 2280], [1480, 1660], [560, 1660],
  ],
  mission: [
    [-1150, -1420], [-520, -1420], [-520, -330], [-180, -330],
    [-180, 120], [-980, 120], [-1150, -420],
  ],
  'north-beach': [
    [1240, 1900], [1520, 1900], [1520, 2180], [2380, 2180],
    [2380, 3220], [1880, 3220], [1500, 2740], [1240, 2400],
  ],
  presidio: [
    [-2600, 1080], [-1380, 1080], [-1180, 1480], [-1260, 2240], [-2260, 2440],
  ],
  sunset: [
    [-3400, -2460], [-2240, -2460], [-2180, -1260], [-2500, -820], [-3400, -820],
  ],
};

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area / 2);
}

function polygonCentroid(points) {
  let x = 0;
  let z = 0;
  for (const point of points) {
    x += point.x;
    z += point.z;
  }
  return { x: x / points.length, z: z / points.length };
}

function regionSpan(points) {
  const bounds = bboxOfPoints(points);
  return Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 800);
}

function positionSkyDomeAt(centroid, span) {
  if (!skyDome) return;
  const radius = Math.max(1800, span * 0.95);
  skyDome.position.set(centroid.x, elevationAt(centroid.x, centroid.z), centroid.z);
  skyDome.scale.setScalar(radius / 1300);
}

function resolveCameraPose(pose) {
  if (!pose) return null;
  const elevationAware = pose.elevationAware !== false;
  const resolved = {};
  if (pose.position?.length >= 3) {
    const [x, y, z] = pose.position;
    resolved.position = elevationAware
      ? [x, elevationAt(x, z) + y, z]
      : [x, y, z];
  }
  if (pose.target?.length >= 3) {
    const [x, y, z] = pose.target;
    resolved.target = elevationAware
      ? [x, elevationAt(x, z) + y, z]
      : [x, y, z];
  }
  return resolved;
}

let cachedCameraAnalysis = null;

function regionBBoxFromPoints(points) {
  return bboxOfPoints(points.length ? points : [{ x: 0, z: 0 }]);
}

function roadsForCameraAnalysis() {
  if (selectedRoadsForHit?.length) return selectedRoadsForHit;
  if (!cityData || region.length < 3) return [];
  const bounds = regionBBoxFromPoints(region);
  return fullCityMode ? selectAllRoads(bounds) : selectRoads(bounds);
}

function buildingsForCameraAnalysis() {
  if (!cityData || region.length < 3) return { detailed: [], coarse: [] };
  const bounds = regionBBoxFromPoints(region);
  return selectBuildings(bounds);
}

function countBuildingsNearSegment(a, b, buildings, radius = 28) {
  let count = 0;
  const midX = (a.x + b.x) / 2;
  const midZ = (a.z + b.z) / 2;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const nx = -dz / length;
  const nz = dx / length;
  const sample = (building) => {
    const [cx, cz] = building.centroid;
    const along = (cx - midX) * (dx / length) + (cz - midZ) * (dz / length);
    if (Math.abs(along) > length * 0.65) return false;
    const perp = Math.abs((cx - midX) * nx + (cz - midZ) * nz);
    return perp <= radius;
  };
  for (const building of buildings.detailed) {
    if (sample(building)) count += 1;
  }
  for (const building of buildings.coarse) {
    if (sample(building)) count += 1;
  }
  return count;
}

function analyzeRegionCameraTargets() {
  const points = region.length >= 3 ? region : [{ x: 0, z: 0 }];
  const regionKey = points.map((point) => `${Math.round(point.x)}:${Math.round(point.z)}`).join('|');
  if (cachedCameraAnalysis?.regionKey === regionKey) return cachedCameraAnalysis;

  const centroid = polygonCentroid(points);
  const bounds = regionBBoxFromPoints(points);
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 800);
  const buildings = buildingsForCameraAnalysis();
  const roads = roadsForCameraAnalysis();
  const isFullCity = polygonArea(points) / 1e6 > 12;

  let skylineTarget = { x: centroid.x, z: centroid.z, height: 80 };
  let landmarkFound = false;
  for (const spec of SF_LANDMARK_SPECS) {
    const resolved = resolveSfLandmark(spec);
    if (!landmarkVisibleInRegion(resolved.x, resolved.z, bounds, isFullCity)) continue;
    skylineTarget = { x: resolved.x, z: resolved.z, height: resolved.height };
    landmarkFound = true;
    break;
  }
  if (!landmarkFound) {
    const ranked = [];
    for (const building of buildings.detailed) {
      ranked.push({
        x: building.centroid[0],
        z: building.centroid[1],
        height: Math.max(12, Number(building.height) || 12),
      });
    }
    for (const building of buildings.coarse) {
      ranked.push({
        x: building.centroid[0],
        z: building.centroid[1],
        height: Math.max(8, Number(building.height) || 8),
      });
    }
    ranked.sort((a, b) => b.height - a.height);
    const top = ranked.slice(0, 10);
    if (top.length) {
      let wx = 0;
      let wz = 0;
      let wh = 0;
      let weightSum = 0;
      for (const entry of top) {
        const weight = entry.height * entry.height;
        wx += entry.x * weight;
        wz += entry.z * weight;
        wh += entry.height * weight;
        weightSum += weight;
      }
      skylineTarget = {
        x: wx / weightSum,
        z: wz / weightSum,
        height: wh / weightSum,
      };
    }
  }

  const corridorWeights = { primary: 3.2, secondary: 2.4, tertiary: 1.6, unclassified: 1.1, residential: 0.8 };
  let bestCorridor = null;
  let bestCorridorScore = 0;
  for (const road of roads) {
    const weight = corridorWeights[road.highway] || 0;
    if (weight <= 0) continue;
    const roadPts = roadPoints(road);
    for (let i = 0; i < roadPts.length - 1; i += 1) {
      const a = roadPts[i];
      const b = roadPts[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 48) continue;
      const density = countBuildingsNearSegment(a, b, buildings, 36);
      // Reject waterfront/bridge strips — canyon must be flanked by real massing.
      if (density < 10) continue;
      const midElev = elevationAt((a.x + b.x) / 2, (a.z + b.z) / 2);
      if (midElev < SEA_LEVEL_Y + 1.5) continue;
      const score = length * weight * (1 + density * 0.35);
      if (score > bestCorridorScore) {
        bestCorridorScore = score;
        bestCorridor = { a, b, length, road, density };
      }
    }
  }

  cachedCameraAnalysis = {
    regionKey,
    centroid,
    bounds,
    span,
    skylineTarget,
    bestCorridor,
  };
  return cachedCameraAnalysis;
}

function makeCameraPose(position, target, elevationAware = true) {
  return { elevationAware, position, target };
}

function getSuggestedCameraPoses() {
  const analysis = analyzeRegionCameraTargets();
  const { centroid, span, skylineTarget, bestCorridor } = analysis;
  const viewDx = skylineTarget.x - centroid.x;
  const viewDz = skylineTarget.z - centroid.z;
  const viewLen = Math.hypot(viewDx, viewDz) || span;
  const viewNx = viewDx / viewLen;
  const viewNz = viewDz / viewLen;
  // elevationAware poses treat Y as height ABOVE terrain. Do not pre-add
  // elevationAt() here or resolveCameraPose will double-count and fling the
  // camera into the sky (broken canyon/drizzle frames).
  const heroDistance = THREE.MathUtils.clamp(span * 0.42, 220, 680);
  const heroHeight = THREE.MathUtils.clamp(span * 0.16, 90, 240);
  const heroCamX = skylineTarget.x - viewNx * heroDistance;
  const heroCamZ = skylineTarget.z - viewNz * heroDistance;
  const heroTargetLift = Math.min(120, skylineTarget.height * 0.42);
  const hero = makeCameraPose(
    [heroCamX, heroHeight, heroCamZ],
    [skylineTarget.x, heroTargetLift, skylineTarget.z],
    true,
  );

  let canyon = hero;
  let street = hero;
  if (bestCorridor) {
    const { a, b } = bestCorridor;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    const dirX = dx / length;
    const dirZ = dz / length;
    const midX = (a.x + b.x) / 2;
    const midZ = (a.z + b.z) / 2;
    const lateral = countBuildingsNearSegment(a, b, buildingsForCameraAnalysis(), 22);
    const side = lateral > 0 && ((midX + (-dirZ) * 18 - centroid.x) ** 2 + (midZ + dirX * 18 - centroid.z) ** 2)
      < ((midX - (-dirZ) * 18 - centroid.x) ** 2 + (midZ - dirX * 18 - centroid.z) ** 2)
      ? 1 : -1;
    const offsetX = -dirZ * side * 11;
    const offsetZ = dirX * side * 11;
    // Street-level first (proven walk canyon), then canyon = same corridor
    // slightly elevated so beauty frames never collapse to road-strip abstracts.
    const streetBack = Math.min(bestCorridor.length * 0.12, 48);
    const streetX = midX + offsetX * 0.2 - dirX * streetBack;
    const streetZ = midZ + offsetZ * 0.2 - dirZ * streetBack;
    const streetLook = Math.min(bestCorridor.length * 0.38, 140);
    street = makeCameraPose(
      [streetX, 1.72, streetZ],
      [midX + dirX * streetLook, 2.4, midZ + dirZ * streetLook],
      true,
    );
    const canyonHeight = 9.5;
    const canyonBack = Math.min(bestCorridor.length * 0.18, 70);
    const lookAhead = Math.min(bestCorridor.length * 0.42, 160);
    const canyonX = midX + offsetX * 0.15 - dirX * canyonBack;
    const canyonZ = midZ + offsetZ * 0.15 - dirZ * canyonBack;
    canyon = makeCameraPose(
      [canyonX, canyonHeight, canyonZ],
      [midX + dirX * lookAhead, 3.2, midZ + dirZ * lookAhead],
      true,
    );
  }

  const night = makeCameraPose(
    [heroCamX, heroHeight * 0.92, heroCamZ],
    [skylineTarget.x, heroTargetLift * 0.72, skylineTarget.z],
    true,
  );

  return { hero, canyon, street, night };
}

function pointInFlatRing(point, flat) {
  let inside = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const ax = flat[i];
    const az = flat[i + 1];
    const bx = flat[j];
    const bz = flat[j + 1];
    if ((az > point.z) !== (bz > point.z)
      && point.x < (bx - ax) * (point.z - az) / (bz - az) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInRegion(point) {
  return region.length >= 3 && pointInFlatRing(point, flatRegion());
}

function flatRegion() {
  const flat = [];
  for (const point of region) flat.push(point.x, point.z);
  return flat;
}

function roadPoints(road) {
  const points = [];
  for (let i = 0; i < road.points.length; i += 2) {
    points.push({ x: road.points[i], z: road.points[i + 1] });
  }
  return points;
}

function bboxOfPoints(points) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  return { minX, minZ, maxX, maxZ };
}

function intersectsRegionBBox(road, regionBBox) {
  const points = road.points;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const z = points[i + 1];
    if (x >= regionBBox.minX && x <= regionBBox.maxX && z >= regionBBox.minZ && z <= regionBBox.maxZ) {
      return true;
    }
  }
  return false;
}

function setStatus(overlay, status, progress = null) {
  const statusNode = overlay === 'boot' ? bootStatus : buildStatus;
  const barNode = overlay === 'boot' ? bootBar : buildBar;
  statusNode.textContent = status;
  if (progress !== null && barNode) barNode.style.width = `${Math.round(progress * 100)}%`;
}

async function fetchCityData() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`gzip data ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      const text = await new Response(stream).text();
      return JSON.parse(text);
    }
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (gzipError) {
    console.warn('gzip load failed, falling back to raw JSON', gzipError);
    const response = await fetch(DATA_FALLBACK_URL);
    if (!response.ok) throw new Error(`raw data ${response.status}`);
    return response.json();
  }
}

async function fetchElevationData() {
  try {
    const response = await fetch(ELEVATION_URL);
    if (!response.ok) throw new Error(`gzip elevation ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      const text = await new Response(stream).text();
      return JSON.parse(text);
    }
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (gzipError) {
    console.warn('gzip elevation failed, falling back to raw JSON', gzipError);
    const response = await fetch(ELEVATION_FALLBACK_URL);
    if (!response.ok) throw new Error(`raw elevation ${response.status}`);
    return response.json();
  }
}

function elevationAt(x, z) {
  if (!terrainData?.grid) return 0;
  const { originX, originZ, cellSize, width, height, grid } = terrainData;
  const gx = (x - originX) / cellSize;
  const gz = (z - originZ) / cellSize;
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const tx = gx - x0;
  const tz = gz - z0;
  const sample = (cx, cz) => {
    if (cx < 0 || cx >= width || cz < 0 || cz >= height) return 0;
    return grid[cz * width + cx] || 0;
  };
  const a = sample(x0, z0);
  const b = sample(x0 + 1, z0);
  const c = sample(x0, z0 + 1);
  const d = sample(x0 + 1, z0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

async function loadCity() {
  setStatus('boot', 'Fetching real San Francisco OSM data…', 0.1);
  cityData = await fetchCityData();
  setStatus('boot', 'Fetching real San Francisco elevation contours…', 0.45);
  terrainData = await fetchElevationData();
  setStatus('boot', `Decoding ${formatNumber(cityData.meta.counts.roads)} roads and ${formatNumber(cityData.meta.counts.coarseBuildings + cityData.meta.counts.detailBuildings)} buildings…`, 0.75);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const boundary = cityData.boundary[0];
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < boundary.length; i += 2) {
    minX = Math.min(minX, boundary[i]);
    maxX = Math.max(maxX, boundary[i]);
    minZ = Math.min(minZ, boundary[i + 1]);
    maxZ = Math.max(maxZ, boundary[i + 1]);
  }
  const width = maxX - minX;
  const height = maxZ - minZ;
  mapCamera = {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
    scale: Math.min(viewportWidth / width, viewportHeight / height) * 0.86,
  };
  setStatus('boot', `Ready · ${cityData.meta.counts.detailRoads} detailed streets · ${cityData.meta.counts.signals} signals`, 1);
  launchButton.disabled = false;
  launchButton.textContent = 'Enter Map Lab';
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewportWidth = window.innerWidth;
  viewportHeight = window.innerHeight;
  mapCanvas.width = Math.round(viewportWidth * dpr);
  mapCanvas.height = Math.round(viewportHeight * dpr);
  mapCanvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  mapDirty = true;
}

function worldToScreen(point) {
  return {
    x: viewportWidth / 2 + (point.x - mapCamera.x) * mapCamera.scale,
    y: viewportHeight / 2 + (point.z - mapCamera.z) * mapCamera.scale,
  };
}

function screenToWorld(x, y) {
  return {
    x: mapCamera.x + (x - viewportWidth / 2) / mapCamera.scale,
    z: mapCamera.z + (y - viewportHeight / 2) / mapCamera.scale,
  };
}

function drawRoadLayer(ctx) {
  if (!cityData) return;
  const left = mapCamera.x - viewportWidth / 2 / mapCamera.scale;
  const right = mapCamera.x + viewportWidth / 2 / mapCamera.scale;
  const top = mapCamera.z - viewportHeight / 2 / mapCamera.scale;
  const bottom = mapCamera.z + viewportHeight / 2 / mapCamera.scale;

  const classPaths = new Map();
  for (const cls of ROAD_ORDER) {
    classPaths.set(cls, { path: new Path2D(), count: 0 });
  }

  const visible = cityData.roads;
  for (let i = 0; i < visible.length; i += 1) {
    const road = visible[i];
    const points = road.points;
    let onScreen = false;
    for (let j = 0; j < points.length; j += 2) {
      if (points[j] >= left && points[j] <= right && points[j + 1] >= top && points[j + 1] <= bottom) {
        onScreen = true;
        break;
      }
    }
    if (!onScreen) continue;
    const cls = roadPalette[road.highway] ? road.highway : 'service';
    const entry = classPaths.get(cls) || classPaths.get('service');
    entry.count += 1;
    const path = entry.path;
    for (let j = 0; j < points.length - 2; j += 2) {
      const sx = worldToScreen({ x: points[j], z: points[j + 1] });
      const ex = worldToScreen({ x: points[j + 2], z: points[j + 3] });
      if (j === 0) path.moveTo(sx.x, sx.y);
      path.lineTo(ex.x, ex.y);
    }
  }

  const widthByClass = {
    motorway: 7,
    trunk: 6,
    primary: 5,
    secondary: 4,
    tertiary: 3.2,
    unclassified: 2.6,
    residential: 2.4,
    living_street: 2.2,
    service: 1.8,
    pedestrian: 1.6,
    footway: 1.2,
    cycleway: 1.2,
    path: 1,
  };

  for (const cls of ROAD_ORDER) {
    const entry = classPaths.get(cls);
    if (!entry || entry.count === 0) continue;
    ctx.strokeStyle = roadPalette[cls];
    ctx.lineWidth = widthByClass[cls] || 2;
    ctx.globalAlpha = cls === 'residential' || cls === 'service' ? 0.4 : 0.55;
    ctx.stroke(entry.path);
  }
  ctx.globalAlpha = 1;
}

function drawBoundary(ctx) {
  if (!cityData) return;
  for (const ring of cityData.boundary) {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i += 2) {
      const point = worldToScreen({ x: ring[i], z: ring[i + 1] });
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
  }
  ctx.fillStyle = 'rgba(150, 178, 150, 0.28)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(214, 232, 220, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawSignals(ctx) {
  if (!cityData) return;
  for (const signal of cityData.signals) {
    const point = worldToScreen({ x: signal[0], z: signal[1] });
    if (point.x < -10 || point.x > viewportWidth + 10 || point.y < -10 || point.y > viewportHeight + 10) continue;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb454';
    ctx.fill();
  }
}

function drawRegion(ctx) {
  if (region.length < 2) return;
  ctx.beginPath();
  for (let i = 0; i < region.length; i += 1) {
    const point = worldToScreen(region[i]);
    if (i === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
  if (drawCursor) {
    const cursor = worldToScreen(drawCursor);
    ctx.lineTo(cursor.x, cursor.y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(127, 212, 193, 0.18)';
  ctx.fill();
  ctx.strokeStyle = '#7fd4c1';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([10, 8]);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 0; i < region.length; i += 1) {
    const point = worldToScreen(region[i]);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#f2a65a' : '#dbe8ec';
    ctx.strokeStyle = '#0d1b22';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }
}

function drawMap() {
  if (!mapDirty) return;
  mapDirty = false;
  const ctx = mapCanvas.getContext('2d');
  ctx.clearRect(0, 0, viewportWidth, viewportHeight);
  const gradient = ctx.createRadialGradient(
    viewportWidth / 2, viewportHeight / 2, 0,
    viewportWidth / 2, viewportHeight / 2, Math.max(viewportWidth, viewportHeight) * 0.75,
  );
  gradient.addColorStop(0, '#264c5e');
  gradient.addColorStop(1, '#10242e');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);
  drawBoundary(ctx);
  drawRoadLayer(ctx);
  drawSignals(ctx);
  drawRegion(ctx);
  drawScale(ctx);
}

function drawScale(ctx) {
  const meters = 2000;
  const px = meters * mapCamera.scale;
  const x = 24;
  const y = viewportHeight - 28;
  ctx.strokeStyle = 'rgba(219, 232, 236, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.stroke();
  ctx.fillStyle = 'rgba(219, 232, 236, 0.9)';
  ctx.font = '11px system-ui';
  ctx.fillText(`2 km`, x + px / 2 - 10, y - 8);
}

function scheduleMapDraw() {
  mapDirty = true;
  requestAnimationFrame(drawMap);
}

function updateReadout() {
  readoutVertices.textContent = `${region.length} vertices`;
  readoutArea.textContent = region.length >= 3 ? `${(polygonArea(region) / 1e6).toFixed(2)} km²` : '— km²';
  const buildButton = document.querySelector('[data-action="build"]');
  buildButton.disabled = region.length < 3;
  document.querySelector('[data-action="undo"]').disabled = region.length === 0;
}

function setRegion(points) {
  region = points.map(([x, z]) => ({ x, z }));
  updateReadout();
  scheduleMapDraw();
}

function applyPreset(name) {
  if (name === 'city') {
    const flat = cityData.boundary[0];
    setRegion(Array.from({ length: flat.length / 2 }, (_, i) => [flat[i * 2], flat[i * 2 + 1]]));
  } else if (PRESETS[name]) {
    setRegion(PRESETS[name]);
  }
}

function mapPointerPosition(event) {
  const rect = mapCanvas.getBoundingClientRect();
  return screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
}

function setupMapInteractions() {
  mapCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const before = mapPointerPosition(event);
    const factor = Math.exp(-event.deltaY * 0.0012);
    mapCamera.scale = THREE.MathUtils.clamp(mapCamera.scale * factor, 0.06, 60);
    const after = screenToWorld(event.clientX - mapCanvas.getBoundingClientRect().left, event.clientY - mapCanvas.getBoundingClientRect().top);
    mapCamera.x += before.x - after.x;
    mapCamera.z += before.z - after.z;
    scheduleMapDraw();
  }, { passive: false });

  mapCanvas.addEventListener('pointerdown', (event) => {
    if (event.button === 1 || activeTool === 'pan') {
      mapPointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        panning: true,
        startX: mapCamera.x,
        startZ: mapCamera.z,
      };
      mapCanvas.setPointerCapture(event.pointerId);
      return;
    }
    if (activeTool !== 'draw') return;
    const world = mapPointerPosition(event);
    region.push(world);
    drawCursor = null;
    updateReadout();
    scheduleMapDraw();
  });

  mapCanvas.addEventListener('pointermove', (event) => {
    if (mapPointer?.panning) {
      const dx = event.clientX - mapPointer.x;
      const dy = event.clientY - mapPointer.y;
      mapCamera.x = mapPointer.startX - dx / mapCamera.scale;
      mapCamera.z = mapPointer.startZ - dy / mapCamera.scale;
      scheduleMapDraw();
      return;
    }
    if (activeTool === 'draw') {
      drawCursor = mapPointerPosition(event);
      scheduleMapDraw();
    }
  });

  const endPointer = (event) => {
    if (mapPointer?.id === event.pointerId) mapPointer = null;
  };
  mapCanvas.addEventListener('pointerup', endPointer);
  mapCanvas.addEventListener('pointercancel', endPointer);

  mapCanvas.addEventListener('dblclick', () => {
    if (activeTool === 'draw' && region.length >= 3) {
      drawCursor = null;
      updateReadout();
      scheduleMapDraw();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (document.body.classList.contains('is-city')) return;
    if (event.key === 'Enter' && activeTool === 'draw' && region.length >= 3) {
      drawCursor = null;
      updateReadout();
      scheduleMapDraw();
    } else if (event.key === 'Escape' && activeTool === 'draw') {
      region.pop();
      updateReadout();
      scheduleMapDraw();
    }
  });
}

function setupToolbar() {
  document.querySelectorAll('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      activeTool = button.dataset.tool;
      document.querySelectorAll('[data-tool]').forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
      modeLabel.textContent = activeTool === 'draw' ? 'Drawing boundary' : 'Panning map';
      hint.textContent = activeTool === 'draw'
        ? 'Click to place boundary vertices · double-click or Enter to close · Esc to cancel'
        : 'Drag to pan · scroll to zoom · draw to define the build area';
    });
  });

  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  });

  document.querySelector('[data-action="undo"]').addEventListener('click', () => {
    region.pop();
    updateReadout();
    scheduleMapDraw();
  });
  document.querySelector('[data-action="clear"]').addEventListener('click', () => {
    region = [];
    updateReadout();
    scheduleMapDraw();
  });
  document.querySelector('[data-action="build"]').addEventListener('click', () => {
    if (region.length >= 3) buildCity().catch((error) => console.error('Build failed', error));
  });
  document.querySelectorAll('[data-city-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.cityMode === 'drive') {
        if (!setCityMode('drive')) {
          hint.textContent = 'Approach a car and press E to drive';
        }
      } else {
        setCityMode(button.dataset.cityMode);
      }
    });
  });
  document.querySelector('[data-action="tour"]')?.addEventListener('click', () => {
    if (startPhotoTour()) {
      setCityMode('walk');
      hint.textContent = 'Photo tour started · visit the marked real San Francisco landmarks';
    }
  });
  document.querySelector('[data-action="back"]').addEventListener('click', () => {
    if (interiorState) exitInterior();
    if (document.pointerLockElement) document.exitPointerLock();
    if (driveIndex >= 0 && trafficState?.vehicles[driveIndex]) trafficState.vehicles[driveIndex].manual = false;
    driveIndex = -1;
    cityMode = 'orbit';
    controls.enabled = true;
    document.body.classList.remove('is-city');
    document.querySelector('[data-action="back"]').hidden = true;
    document.querySelector('[data-action="build"]').hidden = false;
    document.querySelector('[data-toolbar="city"]').hidden = true;
    hud.inert = false;
  });
  inspectorClose.addEventListener('click', () => {
    inspector.hidden = true;
  });
}

function setBuildProgress(stage, status, progress) {
  buildStage.textContent = stage;
  buildStatus.textContent = status;
  if (progress !== null) buildBar.style.width = `${Math.round(progress * 100)}%`;
}

async function tick() {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

function templateForRoad(road) {
  const cls = road.highway || 'residential';
  const lanes = Math.max(1, Number(road.lanes) || 1);
  if (cls === 'motorway' || cls === 'trunk') {
    return road.oneway ? 'sf-highway-1way' : 'sf-highway-2way';
  }
  if (cls === 'primary' || cls === 'secondary' || cls === 'tertiary' || cls === 'unclassified') {
    return road.oneway ? 'sf-arterial-1way' : 'sf-arterial-2way';
  }
  if (cls === 'pedestrian' || cls === 'footway' || cls === 'path' || cls === 'cycleway') {
    return 'sf-walk';
  }
  return road.oneway ? 'sf-local-1way' : (lanes >= 3 ? 'sf-local-wide-2way' : 'sf-local-2way');
}

function projectPointOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 0.0001) return null;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
  const px = a.x + dx * t;
  const pz = a.z + dz * t;
  return { t, point: { x: px, z: pz }, distance: Math.hypot(point.x - px, point.z - pz) };
}

function flatFromPoints(points) {
  const flat = [];
  for (const point of points) flat.push(Math.round(point.x * 10) / 10, Math.round(point.z * 10) / 10);
  return flat;
}

function splitRoadsAtJunctions(roads) {
  const junctionKeys = new Set();
  const junctionPoints = [];
  for (const road of roads) {
    const points = roadPoints(road);
    if (points.length < 2) continue;
    for (const point of [points[0], points[points.length - 1]]) {
      const key = `${Math.round(point.x * 2)},${Math.round(point.z * 2)}`;
      if (!junctionKeys.has(key)) {
        junctionKeys.add(key);
        junctionPoints.push(point);
      }
    }
  }

  const splitRoads = [];
  for (const road of roads) {
    const points = roadPoints(road);
    if (points.length < 2) continue;
    const cuts = new Map();
    for (const junction of junctionPoints) {
      let best = null;
      let bestS = 0;
      let walked = 0;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const segment = projectPointOnSegment(junction, a, b);
        if (!segment) {
          walked += Math.hypot(b.x - a.x, b.z - a.z);
          continue;
        }
        if (segment.distance <= 1.4 && segment.t > 0.04 && segment.t < 0.96) {
          const s = walked + segment.t * Math.hypot(b.x - a.x, b.z - a.z);
          if (!best || segment.distance < best.distance) {
            best = segment;
            bestS = s;
          }
        }
        walked += Math.hypot(b.x - a.x, b.z - a.z);
      }
      if (best) {
        const key = `${Math.round(bestS * 10)}`;
        if (!cuts.has(key)) {
          cuts.set(key, { s: bestS, point: best.point });
        }
      }
    }
    const sortedCuts = [...cuts.values()].sort((a, b) => a.s - b.s);
    if (sortedCuts.length === 0) {
      splitRoads.push(road);
      continue;
    }
    let current = [points[0]];
    let walked = 0;
    let cutIndex = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const segLength = Math.hypot(b.x - a.x, b.z - a.z);
      const segEnd = walked + segLength;
      while (cutIndex < sortedCuts.length && sortedCuts[cutIndex].s <= segEnd + 0.01) {
        const cut = sortedCuts[cutIndex];
        const t = segLength > 0 ? (cut.s - walked) / segLength : 0;
        const point = { x: a.x + (b.x - a.x) * Math.max(0, Math.min(1, t)), z: a.z + (b.z - a.z) * Math.max(0, Math.min(1, t)) };
        current.push(point);
        if (current.length >= 2) {
          splitRoads.push({
            ...road,
            id: `${road.id}-s${cutIndex}`,
            points: flatFromPoints(current),
          });
        }
        current = [point];
        cutIndex += 1;
      }
      current.push(b);
      walked = segEnd;
    }
    if (current.length >= 2) {
      splitRoads.push({
        ...road,
        id: `${road.id}-s${sortedCuts.length}`,
        points: flatFromPoints(current),
      });
    }
  }
  return splitRoads;
}

function makeLanes({ drivingLeft, drivingRight, sidewalk = true, width = 3 }) {
  const lanes = [];
  for (let i = drivingLeft; i > 0; i -= 1) {
    lanes.push({
      role: `reverse-${i}`,
      side: 'left',
      order: i,
      type: 'driving',
      width,
      access: ['car', 'bicycle', 'emergency'],
    });
  }
  if (sidewalk) {
    lanes.push({
      role: 'left-curb',
      side: 'left',
      order: drivingLeft + 1,
      type: 'border',
      width: 0.22,
      heights: [{ sOffset: 0, inner: 0, outer: 0.12 }],
      access: [],
      boundaryMarkings: [{ id: 'left-curb-face', kind: 'curb', boundary: 'outer', width: 0.14 }],
    });
    lanes.push({
      role: 'left-walk',
      side: 'left',
      order: drivingLeft + 2,
      type: 'sidewalk',
      width: 2.1,
      level: true,
      heights: [{ sOffset: 0, inner: 0.12, outer: 0.12 }],
      access: ['pedestrian'],
    });
  }
  for (let i = 1; i <= drivingRight; i += 1) {
    lanes.push({
      role: `forward-${i}`,
      side: 'right',
      order: i,
      type: 'driving',
      width,
      access: ['car', 'bicycle', 'emergency'],
    });
  }
  if (sidewalk) {
    lanes.push({
      role: 'right-curb',
      side: 'right',
      order: drivingRight + 1,
      type: 'border',
      width: 0.22,
      heights: [{ sOffset: 0, inner: 0, outer: 0.12 }],
      access: [],
      boundaryMarkings: [{ id: 'right-curb-face', kind: 'curb', boundary: 'outer', width: 0.14 }],
    });
    lanes.push({
      role: 'right-walk',
      side: 'right',
      order: drivingRight + 2,
      type: 'sidewalk',
      width: 2.1,
      level: true,
      heights: [{ sOffset: 0, inner: 0.12, outer: 0.12 }],
      access: ['pedestrian'],
    });
  }
  const rightDriving = lanes.filter((lane) => lane.type === 'driving' && lane.side === 'right');
  const leftDriving = lanes.filter((lane) => lane.type === 'driving' && lane.side === 'left');
  const twoWay = rightDriving.length > 0 && leftDriving.length > 0;
  rightDriving.forEach((lane, index) => {
    const kind = index === 0 ? (twoWay ? 'broken' : 'solid') : 'broken';
    lane.boundaryMarkings = lane.boundaryMarkings || [];
    lane.boundaryMarkings.push({
      id: `${lane.role}-center`,
      kind,
      boundary: 'inner',
      width: 0.12,
      laneChange: kind === 'broken' ? 'both' : 'none',
    });
  });
  leftDriving.forEach((lane, index) => {
    if (index === 0) return;
    lane.boundaryMarkings = lane.boundaryMarkings || [];
    lane.boundaryMarkings.push({
      id: `${lane.role}-line`,
      kind: 'broken',
      boundary: 'inner',
      width: 0.12,
      laneChange: 'both',
    });
  });
  return lanes;
}

function roadTemplates() {
  const templates = [
    {
      id: 'sf-local-2way',
      name: 'Local two-way street',
      designLimits: { designSpeedKph: 30, minimumHorizontalRadius: 4 },
      lanes: makeLanes({ drivingLeft: 1, drivingRight: 1, width: 2.9 }),
    },
    {
      id: 'sf-local-wide-2way',
      name: 'Wide local two-way street',
      designLimits: { designSpeedKph: 40, minimumHorizontalRadius: 6 },
      lanes: makeLanes({ drivingLeft: 1, drivingRight: 2, width: 3.1 }),
    },
    {
      id: 'sf-local-1way',
      name: 'One-way local street',
      designLimits: { designSpeedKph: 30, minimumHorizontalRadius: 4 },
      lanes: makeLanes({ drivingLeft: 0, drivingRight: 1, width: 3 }),
    },
    {
      id: 'sf-arterial-2way',
      name: 'Arterial two-way avenue',
      designLimits: { designSpeedKph: 50, minimumHorizontalRadius: 12 },
      lanes: makeLanes({ drivingLeft: 2, drivingRight: 2, width: 3.2 }),
    },
    {
      id: 'sf-arterial-1way',
      name: 'One-way avenue',
      designLimits: { designSpeedKph: 50, minimumHorizontalRadius: 12 },
      lanes: makeLanes({ drivingLeft: 0, drivingRight: 3, width: 3.2 }),
    },
    {
      id: 'sf-highway-2way',
      name: 'Divided highway',
      designLimits: { designSpeedKph: 90, minimumHorizontalRadius: 60 },
      lanes: [
        ...makeLanes({ drivingLeft: 3, drivingRight: 3, sidewalk: false, width: 3.5 }),
      ],
    },
    {
      id: 'sf-highway-1way',
      name: 'One-way highway',
      designLimits: { designSpeedKph: 90, minimumHorizontalRadius: 60 },
      lanes: makeLanes({ drivingLeft: 0, drivingRight: 4, sidewalk: false, width: 3.5 }),
    },
    {
      id: 'sf-walk',
      name: 'Pedestrian path',
      designLimits: { designSpeedKph: 10, minimumHorizontalRadius: 2 },
      lanes: [
        {
          role: 'walk',
          side: 'right',
          order: 1,
          type: 'sidewalk',
          width: 2.4,
          level: true,
          heights: [{ sOffset: 0, inner: 0.1, outer: 0.1 }],
          access: ['pedestrian'],
        },
      ],
    },
  ];
  return templates;
}

function selectBuildings(regionBBox) {
  const detailed = [];
  for (const building of cityData.detailBuildings) {
    const [x, z] = building.centroid;
    if (x >= regionBBox.minX && x <= regionBBox.maxX && z >= regionBBox.minZ && z <= regionBBox.maxZ
      && pointInRegion({ x, z })) {
      detailed.push(building);
    }
  }
  const coarse = [];
  for (const building of cityData.coarseBuildings) {
    const [x, z] = building.centroid;
    if (x >= regionBBox.minX && x <= regionBBox.maxX && z >= regionBBox.minZ && z <= regionBBox.maxZ
      && pointInRegion({ x, z })) {
      coarse.push(building);
      if (coarse.length >= 5000) break;
    }
  }
  return { detailed, coarse };
}

function selectRoads(regionBBox) {
  const selected = new Map();
  const detailIds = new Set();
  let detailCount = 0;
  for (const road of cityData.detailRoads) {
    if (!intersectsRegionBBox(road, regionBBox)) continue;
    const points = roadPoints(road);
    if (!points.some(pointInRegion)) continue;
    selected.set(road.id, road);
    detailIds.add(road.id);
    detailCount += 1;
    if (detailCount >= 3200) break;
  }

  let cityCount = 0;
  for (const cls of ROAD_ORDER) {
    if (selected.size >= 5200) break;
    for (const road of cityData.roads) {
      if (road.highway !== cls || detailIds.has(road.id) || selected.has(road.id)) continue;
      if (!intersectsRegionBBox(road, regionBBox)) continue;
      const points = roadPoints(road);
      if (!points.some(pointInRegion)) continue;
      selected.set(road.id, road);
      cityCount += 1;
      if (selected.size >= 5200) break;
    }
  }
  return [...selected.values()];
}

function selectAllRoads(regionBBox) {
  const selected = new Map();
  for (const road of cityData.detailRoads) {
    if (!intersectsRegionBBox(road, regionBBox)) continue;
    const points = roadPoints(road);
    if (!points.some(pointInRegion)) continue;
    selected.set(road.id, road);
  }
  for (const road of cityData.roads) {
    if (selected.has(road.id)) continue;
    if (!intersectsRegionBBox(road, regionBBox)) continue;
    const points = roadPoints(road);
    if (!points.some(pointInRegion)) continue;
    selected.set(road.id, road);
  }
  return [...selected.values()];
}

function selectSignals(regionBBox) {
  return cityData.signals.filter(([x, z]) => (
    x >= regionBBox.minX && x <= regionBBox.maxX && z >= regionBBox.minZ && z <= regionBBox.maxZ
    && pointInRegion({ x, z })
  ));
}

function buildRoadDocument(selectedRoads) {
  const templates = roadTemplates();
  let document = createRoadAuthoringDocument({
    id: 'sf-realmap',
    name: 'San Francisco real map sandbox',
  });
  for (const template of templates) document = addRoadTemplate(document, template);

  let skipped = 0;
  for (const road of selectedRoads) {
    const points = roadPoints(road);
    if (points.length < 2) {
      skipped += 1;
      continue;
    }
    let totalLength = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      totalLength += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
    }
    if (totalLength < 32) {
      skipped += 1;
      continue;
    }
    const geometry = [];
    let s = 0;
    let valid = true;
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.4) continue;
      if (length > 320) {
        // Long OSM ways are often freeway ramps with sparse nodes; split so the
        // automatic junction resolver can still find crossing streets.
        const steps = Math.ceil(length / 220);
        for (let step = 0; step < steps; step += 1) {
          const t0 = step / steps;
          const t1 = (step + 1) / steps;
          const ax = a.x + dx * t0;
          const az = a.z + dz * t0;
          const bx = a.x + dx * t1;
          const bz = a.z + dz * t1;
          const sx = bx - ax;
          const sz = bz - az;
          geometry.push(makeLineSegment(s, ax, az, Math.atan2(sz, sx), Math.hypot(sx, sz)));
          s += Math.hypot(sx, sz);
        }
      } else {
        geometry.push(makeLineSegment(s, a.x, a.z, Math.atan2(dz, dx), length));
        s += length;
      }
    }
    if (geometry.length === 0) {
      skipped += 1;
      continue;
    }
    document = addRoadStroke(document, {
      id: `road-${road.id}`,
      geometry,
      templateSpans: [{ templateId: templateForRoad(road), s: 0 }],
    });
  }
  return { document, skipped };
}

function compileSafely(selectedRoads, removed = new Set(), depth = 0) {
  let lastError = null;
  if (depth > 5) {
    throw new Error('Road graph could not converge for this boundary.');
  }
  const strategies = [
    { splitInteriorCrossings: false, snapTolerance: 0.7, junctionPortalSetback: 7 },
    { splitInteriorCrossings: false, snapTolerance: 0.5, junctionPortalSetback: 6 },
    { splitInteriorCrossings: false, snapTolerance: 0.32, junctionPortalSetback: 5 },
  ];
  let splitRoads = splitRoadsAtJunctions(selectedRoads)
    .filter((road) => !removed.has(`road-${road.id}`));

  const culpritFrom = (message) => {
    const tooShort = /Road ([\w-]+) is too short for its junction portal setbacks/.exec(message);
    if (tooShort) return tooShort[1];
    const duplicate = /Duplicate junction approach key ([\w-]+)/.exec(message);
    if (duplicate) return duplicate[1];
    return null;
  };

  const maxAttempts = 48;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let progressed = false;
    for (const options of strategies) {
      try {
        const { document } = buildRoadDocument(splitRoads);
        const automatic = resolveAutomaticNetwork(document, {
          junctionIdPrefix: 'sf-auto',
          ...options,
        });
        const compilation = compileRoadNetwork(automatic.document, { validationProfile: 'interactive' });
        if (!compilation.ok) {
          const critical = (compilation.diagnostics || []).filter((entry) => entry.severity === 'error');
          if (critical.length > 0) {
            lastError = new Error(`Road compiler rejected the region (${critical.length} diagnostics).`);
            console.error('REALMAP_DIAGNOSTICS', critical.map((entry) => `${entry.code} ${entry.message}`).join('\n'));
            const named = new Set();
            for (const diagnostic of critical) {
              for (const match of diagnostic.message.matchAll(/(?:road-|sf-auto\|)([\w-]+)/g)) {
                named.add(`road-${match[1]}`);
              }
            }
            let removedAny = false;
            for (const id of named) {
              if (splitRoads.some((road) => `road-${road.id}` === id)) {
                removed.add(id);
                splitRoads = splitRoads.filter((road) => `road-${road.id}` !== id);
                removedAny = true;
              }
            }
            if (removedAny) {
              progressed = true;
              break;
            }
            const shortest = [...splitRoads]
              .sort((left, right) => roadLengthOf(left) - roadLengthOf(right))
              .slice(0, 24);
            for (const road of shortest) {
              removed.add(`road-${road.id}`);
              splitRoads = splitRoads.filter((candidate) => candidate.id !== road.id);
            }
            console.warn(`Dropped ${shortest.length} short roads to satisfy OSM junction diagnostics`);
            progressed = true;
            break;
          }
        }
        return { compilation, roads: splitRoads };
      } catch (error) {
        lastError = error;
        console.error('Road resolution strategy failed', options, error.message);
        const culprit = culpritFrom(error.message);
        if (culprit && splitRoads.length > 1) {
          const before = splitRoads.length;
          removed.add(culprit);
          splitRoads = splitRoads.filter((road) => `road-${road.id}` !== culprit);
          if (splitRoads.length < before) {
            console.warn(`Removed ${culprit} to keep road compilation alive`);
            progressed = true;
            break;
          }
        }
      }
    }
    if (!progressed) break;
  }

  if (selectedRoads.length > 3200) {
    const robust = selectedRoads
      .filter((road) => !removed.has(`road-${road.id}`))
      .filter((road) => roadLengthOf(road) >= 24)
      .sort((left, right) => roadLengthOf(right) - roadLengthOf(left))
      .slice(0, 3200);
    if (robust.length === 0) {
      throw lastError || new Error('No road remains long enough to build junction topology.');
    }
    console.warn(`Reducing road set from ${selectedRoads.length} to ${robust.length} for a robust build`);
    return compileSafely(robust, removed, depth + 1);
  }
  throw lastError || new Error('Road graph could not be compiled for this boundary.');
}

function roadLengthOf(road) {
  const points = roadPoints(road);
  let length = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return length;
}

function toThreeCoordinates(source) {
  const result = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    result[i] = source[i];
    result[i + 1] = source[i + 2];
    result[i + 2] = source[i + 1];
  }
  return result;
}

function toThreeIndices(source) {
  const result = source.slice();
  for (let i = 0; i < result.length; i += 3) {
    const second = result[i + 1];
    result[i + 1] = result[i + 2];
    result[i + 2] = second;
  }
  return result;
}

const roadSurfaceColors = {
  road: 0x343a40,
  shoulder: 0x454b50,
  sidewalk: 0xa8a59c,
  cycleway: 0x8e3434,
  median: 0x596451,
  border: 0x8a8680,
};

const roadMarkingColors = {
  'marking-white': 0xf4f2ea,
  'marking-yellow': 0xf0c842,
  'marking-blue': 0x4389bd,
  'marking-red': 0xb83d38,
  'marking-none': 0x343a40,
};

const sandboxTextureCache = {};
const facadeWindowTextureCache = new Map();
const roadMaterialCache = new Map();

function proceduralSurfaceMap(kind, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const imageData = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const noise = hash - Math.floor(hash);
      if (kind === 'asphalt-normal') {
        imageData.data[i] = 128 + (noise - 0.5) * 48;
        imageData.data[i + 1] = 128 + ((Math.sin(x * 0.31 + y * 0.27) * 0.5 + 0.5) - 0.5) * 36;
        imageData.data[i + 2] = 228 + noise * 27;
      } else if (kind === 'asphalt-roughness') {
        const value = 208 + noise * 36;
        imageData.data[i] = value;
        imageData.data[i + 1] = value;
        imageData.data[i + 2] = value;
      } else {
        const brickX = Math.floor(x / 14);
        const brickY = Math.floor(y / 8);
        const brick = ((brickX + brickY) % 2) === 0;
        const edgeX = (x % 14) < 1 || (x % 14) > 12;
        const edgeY = (y % 8) < 1 || (y % 8) > 6;
        const mortar = edgeX || edgeY || noise > 0.88;
        const base = brick ? 148 + noise * 22 : 128 + noise * 16;
        imageData.data[i] = mortar ? 218 + noise * 18 : base + 10;
        imageData.data[i + 1] = mortar ? 212 + noise * 16 : base - 4;
        imageData.data[i + 2] = mortar ? 200 + noise * 14 : base - 18;
      }
      imageData.data[i + 3] = 255;
    }
  }
  context.putImageData(imageData, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = kind === 'asphalt-roughness' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  return texture;
}

function loadSandboxTextures() {
  if (typeof document === 'undefined' || sandboxTextureCache.loaded) return;
  sandboxTextureCache.loaded = true;
  const load = (key, url, repeatX, repeatY) => {
    const texture = new THREE.TextureLoader().load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    sandboxTextureCache[key] = texture;
  };
  load('asphalt', publicAsset('assets/sf-asphalt.png'), 92, 92);
  load('sidewalk', publicAsset('assets/sf-sidewalk.png'), 68, 68);
  load('plaster', publicAsset('assets/sf-facade-plaster.png'), 4.5, 3.2);
  load('edwardian', publicAsset('assets/sf-edwardian-facade.png'), 4.2, 3.4);
  load('edwardian2', publicAsset('assets/sf-edwardian-facade-2.png'), 4.2, 3.4);
  load('victorian', publicAsset('assets/sf-victorian-siding.png'), 4.8, 3.8);
  sandboxTextureCache.asphaltNormal = proceduralSurfaceMap('asphalt-normal');
  sandboxTextureCache.asphaltRoughness = proceduralSurfaceMap('asphalt-roughness');
  sandboxTextureCache.brickSidewalk = proceduralSurfaceMap('brick');
  sandboxTextureCache.brickSidewalk.repeat.set(24, 24);
}

function buildingFacadeStyle(building) {
  const cls = String(building.building || 'yes').toLowerCase();
  const amenity = String(building.amenity || '').toLowerCase();
  const height = Number(building.height) || 0;
  if (height >= 55 || cls === 'office' || cls === 'tower') return 'glass';
  if (cls === 'retail' || cls === 'commercial' || cls === 'warehouse' || amenity) return 'commercial';
  if (height >= 16 && height < 48) return (Number(building.id) || 0) % 2 === 0 ? 'edwardian' : 'edwardian2';
  const hash = (Number(building.id) || 0) % 3;
  if (hash === 0) return 'victorian';
  if (hash === 1) return 'edwardian';
  return 'plaster';
}

function facadePhotoTexture(style) {
  const key = style === 'edwardian2' ? 'edwardian2' : style;
  return sandboxTextureCache[key] || sandboxTextureCache.plaster || null;
}

function facadeWindowTexture(seed, style = 'plaster') {
  const key = `${style}-${seed % 6}`;
  if (facadeWindowTextureCache.has(key)) return facadeWindowTextureCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const variant = seed % 6;
  const palettes = {
    victorian: { base: '#8a7d6d', trim: '#ddd4c4', sash: '#2a2218', glass: ['#141c24', '#182028', '#1e2834'] },
    edwardian: { base: '#7d837c', trim: '#d8d0c0', sash: '#242018', glass: ['#121820', '#161e28', '#1c2630'] },
    edwardian2: { base: '#8c8070', trim: '#e0d4c0', sash: '#221c14', glass: ['#141820', '#182028', '#202c38'] },
    plaster: { base: '#9a9488', trim: '#e8dcc8', sash: '#282018', glass: ['#101820', '#142028', '#1a2838'] },
    commercial: { base: '#8f8678', trim: '#ece0cc', sash: '#1c1814', glass: ['#0e141c', '#121c28', '#182434'] },
    glass: { base: '#6f7f92', trim: '#c8d8e8', sash: '#101820', glass: ['#182838', '#1c3048', '#243850'] },
  };
  const palette = palettes[style] || palettes.plaster;
  context.fillStyle = palette.base;
  context.fillRect(0, 0, 256, 256);
  context.fillStyle = palette.trim;
  context.fillRect(0, 0, 256, 8);
  context.fillRect(0, 248, 256, 8);
  context.fillRect(0, 0, 8, 256);
  context.fillRect(248, 0, 8, 256);
  for (let row = 1; row <= 7; row += 1) {
    const bandY = row * 30 - 6;
    context.fillStyle = palette.trim;
    context.fillRect(8, bandY, 240, 2);
    for (let col = 1; col <= 9; col += 1) {
      const x = (col * 26) - 12 + ((row * 5 + col * 3 + variant) % 3);
      const y = bandY + 4;
      const warm = (row * 17 + col * 11 + variant * 29) % palette.glass.length;
      context.fillStyle = palette.trim;
      context.fillRect(x - 1, y - 1, 13, 20);
      context.fillStyle = palette.glass[warm];
      context.globalAlpha = style === 'glass' ? 0.96 : 0.92;
      context.fillRect(x, y, 11, 18);
      context.globalAlpha = 1;
      context.fillStyle = palette.sash;
      context.fillRect(x + 4, y, 2, 18);
      context.fillRect(x, y + 8, 11, 2);
      if ((row + col + variant) % 3 === 0) {
        context.globalAlpha = 0.38;
        context.fillStyle = '#060a10';
        context.fillRect(x + 1, y + 9, 9, 8);
        context.globalAlpha = 1;
      }
      if ((row + col + variant) % 5 === 0) {
        context.fillStyle = 'rgba(240,228,200,0.55)';
        context.fillRect(x + 1, y + 1, 4, 3);
      }
    }
  }
  context.fillStyle = 'rgba(24,20,16,0.78)';
  context.fillRect(0, 228, 256, 20);
  context.fillStyle = palette.trim;
  context.fillRect(0, 220, 256, 5);
  const storefrontCols = style === 'commercial' ? 6 : 8;
  for (let col = 0; col < storefrontCols; col += 1) {
    const panelX = col * (256 / storefrontCols) + 4;
    const panelW = (256 / storefrontCols) - 8;
    context.fillStyle = col % 2 === 0 ? '#3f3830' : '#564a3c';
    context.fillRect(panelX, 232, panelW, 16);
    context.fillStyle = 'rgba(180,210,220,0.35)';
    context.fillRect(panelX + 2, 234, panelW - 4, 10);
    context.fillStyle = palette.trim;
    context.fillRect(panelX, 232, 2, 16);
    context.fillRect(panelX + panelW - 2, 232, 2, 16);
  }
  context.fillStyle = palette.trim;
  context.fillRect(0, 206, 256, 6);
  context.fillRect(0, 198, 256, 3);
  if (style !== 'glass') {
    context.fillStyle = 'rgba(70,62,54,0.55)';
    for (let col = 0; col < 10; col += 1) {
      context.fillRect(col * 26 + 2, 198, 22, 8);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  facadeWindowTextureCache.set(key, texture);
  return texture;
}

function footprintPerimeter(points) {
  let perimeter = 0;
  for (let i = 0; i < points.length; i += 2) {
    const next = (i + 2) % points.length;
    perimeter += Math.hypot(points[next] - points[i], points[next + 1] - points[i + 1]);
  }
  return perimeter;
}

function makeRoadMaterial(materialClass) {
  if (roadMaterialCache.has(materialClass)) return roadMaterialCache.get(materialClass);
  const isMarking = materialClass.startsWith('marking-');
  const color = isMarking
    ? roadMarkingColors[materialClass] || 0xf4f2ea
    : roadSurfaceColors[materialClass] || 0x6f7478;
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: isMarking ? 0.58 : materialClass === 'border' ? 0.88 : 0.92,
    metalness: isMarking ? 0.02 : materialClass === 'border' ? 0 : 0.01,
    polygonOffset: isMarking,
    polygonOffsetFactor: isMarking ? -2 : 0,
    polygonOffsetUnits: isMarking ? -2 : 0,
    flatShading: materialClass === 'border',
  });
  material.name = materialClass;
  if (materialClass === 'road') {
    if (sandboxTextureCache.asphalt) {
      material.map = sandboxTextureCache.asphalt;
      material.color.set(0xffffff);
    }
    if (sandboxTextureCache.asphaltNormal) {
      material.normalMap = sandboxTextureCache.asphaltNormal;
      material.normalScale.set(0.32, 0.32);
    }
    if (sandboxTextureCache.asphaltRoughness) {
      material.roughnessMap = sandboxTextureCache.asphaltRoughness;
      material.roughness = 1;
    }
  } else if (materialClass === 'sidewalk') {
    const brick = (materialClass.length + 3) % 5 === 0;
    const sidewalkMap = brick && sandboxTextureCache.brickSidewalk
      ? sandboxTextureCache.brickSidewalk
      : sandboxTextureCache.sidewalk;
    if (sidewalkMap) {
      material.map = sidewalkMap;
      material.color.set(brick ? 0xf0ebe3 : 0xffffff);
      material.roughness = 0.86;
    }
  } else if (materialClass === 'border') {
    material.color.set(0x96918a);
  }
  roadMaterialCache.set(materialClass, material);
  return material;
}

function indexedMeshToGeometries(sourceMesh) {
  if (!sourceMesh?.positions?.length) return [];
  const classRanges = new Map();
  for (const range of sourceMesh.semanticRanges || []) {
    const entry = classRanges.get(range.materialClass) || [];
    entry.push(range);
    classRanges.set(range.materialClass, entry);
  }
  const sourceIndices = toThreeIndices(sourceMesh.indices);
  const results = [];
  for (const [materialClass, ranges] of classRanges) {
    const indexCount = ranges.reduce((sum, range) => sum + range.indexCount, 0);
    const indices = new (sourceIndices instanceof Uint32Array ? Uint32Array : Uint16Array)(indexCount);
    let offset = 0;
    for (const range of ranges) {
      indices.set(sourceIndices.subarray(range.indexStart, range.indexStart + range.indexCount), offset);
      offset += range.indexCount;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(toThreeCoordinates(sourceMesh.positions), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(toThreeCoordinates(sourceMesh.normals), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(sourceMesh.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    results.push({ geometry, materialClass });
  }
  return results;
}

const ROAD_SURFACE_LIFT = 0.06;

function applyTerrainToMesh(mesh) {
  const positions = mesh.geometry.attributes.position;
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    positions.setY(i, elevationAt(x, z) + ROAD_SURFACE_LIFT);
  }
  positions.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
}

function buildingColor(building) {
  const cls = building.building || 'yes';
  const height = Number(building.height) || 0;
  if (height >= 80) return 0x5f6f82;
  if (height >= 40) return 0x8895a3;
  if (cls === 'retail' || cls === 'commercial' || cls === 'warehouse' || cls === 'industrial') return 0x8a7d68;
  if (cls === 'civic' || cls === 'public' || cls === 'school' || cls === 'hospital') return 0x9a8f78;
  if (cls === 'yes' || cls === 'residential' || cls === 'apartments') {
    const hash = (Number(building.id) || 0) % 5;
    const palette = [0x8f8d82, 0x967f6a, 0x7f8a83, 0xa08a77, 0x777f88];
    return palette[hash];
  }
  return 0x7d8581;
}

function buildingRoofColor(building) {
  const hash = (Number(building.id) || 0) % 7;
  const palette = [0x565d60, 0x625650, 0x50585a, 0x6a5e52, 0x4c5559, 0x605a50, 0x575e5c];
  return palette[hash];
}

function buildingGroundY(building) {
  let minY = Infinity;
  for (let i = 0; i < building.points.length; i += 2) {
    minY = Math.min(minY, elevationAt(building.points[i], building.points[i + 1]));
  }
  return Number.isFinite(minY) ? minY : elevationAt(building.centroid[0], building.centroid[1]);
}

function projectBuildingFacadeUVs(geometry) {
  geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(norm.getX(i));
    const ny = Math.abs(norm.getY(i));
    const nz = Math.abs(norm.getZ(i));
    if (ny >= nx && ny >= nz) {
      uvs[i * 2] = x * 0.045;
      uvs[i * 2 + 1] = z * 0.045;
    } else if (nx >= nz) {
      uvs[i * 2] = z * 0.11;
      uvs[i * 2 + 1] = y * 0.22;
    } else {
      uvs[i * 2] = x * 0.11;
      uvs[i * 2 + 1] = y * 0.22;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function createDetailBuildingMesh(building, groundY = 0) {
  const points = [];
  for (let i = 0; i < building.points.length; i += 2) {
    points.push(new THREE.Vector2(building.points[i], building.points[i + 1]));
  }
  if (points.length < 3) return null;
  const shape = new THREE.Shape(points);
  const buildingHeight = Math.max(3, Math.min(Number(building.height) || 12, 320));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: buildingHeight,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, groundY + buildingHeight + 0.15, 0);
  projectBuildingFacadeUVs(geometry);
  const style = buildingFacadeStyle(building);
  const seed = Number(building.id) || 0;
  // Always use the synchronous procedural facade atlas as the base map.
  // Async photo textures often arrive after meshing and previously left walls black.
  const windowTexture = facadeWindowTexture(seed, style).clone();
  windowTexture.wrapS = THREE.RepeatWrapping;
  windowTexture.wrapT = THREE.RepeatWrapping;
  windowTexture.repeat.set(1.35, 1.15);
  windowTexture.needsUpdate = true;
  const photoTexture = facadePhotoTexture(style);
  const photoReady = Boolean(photoTexture?.image && photoTexture.image.width > 0);
  const material = new THREE.MeshStandardMaterial({
    color: style === 'glass' ? 0xb8d0e4 : 0xffffff,
    roughness: style === 'glass' ? 0.18 : 0.74,
    metalness: style === 'glass' ? 0.42 : 0.03,
    flatShading: false,
    map: windowTexture,
  });
  if (photoReady && style !== 'glass') {
    // Slight warm tint from the photographic atlas without replacing window UVs.
    material.color.set(buildingColor(building));
    material.color.lerp(new THREE.Color(0xffffff), 0.55);
  } else if (style !== 'glass') {
    material.color.set(buildingColor(building));
    material.color.lerp(new THREE.Color(0xffffff), 0.35);
  }
  material.emissiveMap = windowTexture;
  material.emissive = new THREE.Color(0x000000);
  material.emissiveIntensity = 0;
  windowMaterials.push(material);
  const roofMaterial = new THREE.MeshStandardMaterial({
    color: buildingRoofColor(building),
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
  });
  // ExtrudeGeometry groups after rotateX(+PI/2): group 0 = lids (roof/floor),
  // group 1 = vertical sides. Put the facade atlas on the sides.
  const mesh = new THREE.Mesh(geometry, [roofMaterial, material]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = {
    type: 'building',
    building,
    label: building.name || 'Unnamed building',
    facadeStyle: style,
  };
  return mesh;
}

function createCoarseBuildings(buildings) {
  const count = buildings.length;
  if (count === 0) return { mesh: null, materials: [] };
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.04,
    flatShading: true,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const seedRandom = (seed) => {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  };
  for (let i = 0; i < count; i += 1) {
    const building = buildings[i];
    const height = Math.max(2.5, Math.min(Number(building.height) || 8, 280));
    const size = Math.max(3.5, Math.min(Math.sqrt(building.area || 160), 42));
    dummy.position.set(
      building.centroid[0],
      elevationAt(building.centroid[0], building.centroid[1]) + height / 2 + 0.15,
      building.centroid[1],
    );
    dummy.rotation.set(0, seedRandom(building.id || i) * Math.PI, 0);
    dummy.scale.set(size, height, size);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    color.set(buildingColor(building));
    mesh.setColorAt(i, color);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData = { type: 'building-instances', buildings };
  return { mesh, materials: [material] };
}

const SEA_LEVEL_Y = -1.8;

function createGround(regionPoints) {
  const bounds = bboxOfPoints(regionPoints);
  const flat = [];
  for (const point of regionPoints) flat.push(point.x, point.z);
  const spanX = Math.max(40, bounds.maxX - bounds.minX);
  const spanZ = Math.max(40, bounds.maxZ - bounds.minZ);
  const cell = THREE.MathUtils.clamp(Math.max(spanX, spanZ) / 72, 18, 48);
  const cols = Math.max(8, Math.ceil(spanX / cell));
  const rows = Math.max(8, Math.ceil(spanZ / cell));
  const positions = [];
  const colors = [];
  const indices = [];
  const lowColor = new THREE.Color(0x8a8578);
  const midColor = new THREE.Color(0x9a9588);
  const highColor = new THREE.Color(0x6d7874);
  const color = new THREE.Color();
  const heightSamples = [];
  const noise = (x, z) => {
    const value = Math.sin(x * 0.018 + z * 0.023) * 4.71
      + Math.sin(x * 0.041 - z * 0.017) * 2.83
      + Math.sin((x + z) * 0.007) * 5.1;
    return value / 12.64;
  };
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const x = bounds.minX + (col / cols) * spanX;
      const z = bounds.minZ + (row / rows) * spanZ;
      const inside = pointInFlatRing({ x, z }, flat);
      let elevation = elevationAt(x, z);
      if (!Number.isFinite(elevation)) elevation = 0;
      // Keep land at true elevation so roads/buildings (also elevation-sampled)
      // stay flush. Underwater cells are culled from the index buffer below.
      const y = inside && elevation > SEA_LEVEL_Y + 0.05
        ? elevation - 0.04
        : SEA_LEVEL_Y - 0.8;
      positions.push(x, y, z);
      heightSamples.push(inside ? elevation : SEA_LEVEL_Y);
      const t = THREE.MathUtils.clamp(Math.max(0, elevation) / 180, 0, 1);
      color.copy(lowColor).lerp(midColor, Math.min(1, t * 1.4));
      if (t > 0.7) color.lerp(highColor, (t - 0.7) / 0.3);
      color.offsetHSL(0, 0, noise(x, z) * 0.08);
      if (!inside) color.set(0x1a4556);
      colors.push(color.r, color.g, color.b);
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const a = row * (cols + 1) + col;
      const b = a + 1;
      const c = a + (cols + 1);
      const d = c + 1;
      const land = [heightSamples[a], heightSamples[b], heightSamples[c], heightSamples[d]]
        .filter((value) => value > SEA_LEVEL_Y).length;
      if (land < 2) continue;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0,
    vertexColors: true,
    flatShading: true,
  });
  const ground = new THREE.Mesh(geometry, material);
  ground.receiveShadow = true;
  ground.userData = { type: 'ground' };
  return ground;
}

function createWaterPlane(regionPoints) {
  const bounds = bboxOfPoints(regionPoints);
  const width = Math.max(bounds.maxX - bounds.minX, 800) + 1400;
  const height = Math.max(bounds.maxZ - bounds.minZ, 800) + 1400;
  const geometry = new THREE.PlaneGeometry(width, height, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: 0x1a4d63,
    roughness: 0.22,
    metalness: 0.18,
  });
  const water = new THREE.Mesh(geometry, material);
  water.position.set(
    (bounds.minX + bounds.maxX) / 2,
    SEA_LEVEL_Y,
    (bounds.minZ + bounds.maxZ) / 2,
  );
  water.userData = { type: 'water' };
  return water;
}

const SF_LANDMARK_SPECS = [
  { match: 'transamerica pyramid', kind: 'transamerica', fallback: [1473.7, 1900.5], height: 260 },
  { match: 'salesforce tower', kind: 'salesforce', fallback: [1974.5, 1302.6], height: 326 },
  { match: 'coit tower', kind: 'coit', fallback: [1193, 2695.4], height: 64 },
];

const SF_LANDMARK_SKIP = new Set(SF_LANDMARK_SPECS.map((spec) => spec.match));

function resolveSfLandmark(spec) {
  if (cityData?.detailBuildings) {
    for (const building of cityData.detailBuildings) {
      const name = (building.name || '').toLowerCase();
      if (name.includes(spec.match)) {
        return {
          x: building.centroid[0],
          z: building.centroid[1],
          height: Math.max(12, Number(building.height) || spec.height),
        };
      }
    }
  }
  return { x: spec.fallback[0], z: spec.fallback[1], height: spec.height };
}

function landmarkVisibleInRegion(x, z, regionBBox, isFullCity) {
  if (isFullCity) return true;
  const margin = 180;
  return x >= regionBBox.minX - margin
    && x <= regionBBox.maxX + margin
    && z >= regionBBox.minZ - margin
    && z <= regionBBox.maxZ + margin;
}

function createTransamericaSilhouette(x, z, targetHeight) {
  const baseY = elevationAt(x, z);
  const tower = new THREE.Group();
  tower.name = 'Transamerica Pyramid silhouette';
  tower.position.set(x, baseY, z);
  const height = Math.min(320, Math.max(160, targetHeight * 0.96));
  const limestone = new THREE.MeshStandardMaterial({
    color: 0xd8d0c4,
    roughness: 0.82,
    metalness: 0.04,
    flatShading: true,
  });
  const windowPanel = new THREE.MeshStandardMaterial({
    color: 0x4a6888,
    roughness: 0.24,
    metalness: 0.36,
    emissive: 0x000000,
    emissiveIntensity: 0,
  });
  windowMaterials.push(windowPanel);
  const baseRadius = height * 0.145;
  const topRadius = height * 0.038;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(topRadius, baseRadius, height * 0.86, 4, 1, false, Math.PI * 0.25),
    limestone,
  );
  shaft.position.y = height * 0.43;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  tower.add(shaft);
  for (let tier = 0; tier < 10; tier += 1) {
    const progress = tier / 9;
    const radius = THREE.MathUtils.lerp(baseRadius, topRadius, progress);
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(radius + 0.5, radius + 0.5, height * 0.012, 4, 1, false, Math.PI * 0.25),
      windowPanel,
    );
    band.position.y = height * 0.08 + progress * height * 0.74;
    tower.add(band);
  }
  const crown = new THREE.Mesh(
    new THREE.ConeGeometry(topRadius * 1.55, height * 0.14, 4, 1, false, Math.PI * 0.25),
    limestone,
  );
  crown.position.y = height * 0.93;
  crown.castShadow = true;
  tower.add(crown);
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, height * 0.05, 8), limestone);
  spire.position.y = height * 0.99;
  tower.add(spire);
  tower.userData = { type: 'landmark', label: 'Transamerica Pyramid' };
  return tower;
}

function createSalesforceSilhouette(x, z, targetHeight) {
  const baseY = elevationAt(x, z);
  const tower = new THREE.Group();
  tower.name = 'Salesforce Tower silhouette';
  tower.position.set(x, baseY, z);
  const height = Math.min(320, Math.max(180, targetHeight * 0.96));
  const width = height * 0.17;
  const glassBright = new THREE.MeshStandardMaterial({
    color: 0x7eb0d0,
    roughness: 0.16,
    metalness: 0.46,
    emissive: 0x000000,
    emissiveIntensity: 0,
  });
  const glassDark = new THREE.MeshStandardMaterial({
    color: 0x3a5878,
    roughness: 0.2,
    metalness: 0.4,
    emissive: 0x000000,
    emissiveIntensity: 0,
  });
  windowMaterials.push(glassBright, glassDark);
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.92, width), glassBright);
  shaft.position.y = height * 0.46;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  tower.add(shaft);
  for (let tier = 0; tier < 14; tier += 1) {
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(width * 1.02, height * 0.01, width * 1.02),
      tier % 2 ? glassDark : glassBright,
    );
    band.position.y = height * 0.08 + tier * height * 0.058;
    tower.add(band);
  }
  const crown = new THREE.Mesh(new THREE.BoxGeometry(width * 0.82, height * 0.06, width * 0.82), glassDark);
  crown.position.y = height * 0.97;
  tower.add(crown);
  tower.userData = { type: 'landmark', label: 'Salesforce Tower' };
  return tower;
}

function createCoitSilhouette(x, z, targetHeight) {
  const baseY = elevationAt(x, z);
  const tower = new THREE.Group();
  tower.name = 'Coit Tower silhouette';
  tower.position.set(x, baseY, z);
  const height = Math.max(52, Math.min(96, targetHeight));
  const concrete = new THREE.MeshStandardMaterial({
    color: 0xb8ad98,
    roughness: 0.94,
    metalness: 0,
    flatShading: true,
    fog: false,
  });
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(height * 0.028, height * 0.038, height * 0.82, 18),
    concrete,
  );
  stem.position.y = height * 0.41;
  stem.castShadow = true;
  stem.receiveShadow = true;
  tower.add(stem);
  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(height * 0.034, height * 0.032, height * 0.07, 18),
    concrete,
  );
  deck.position.y = height * 0.84;
  tower.add(deck);
  const crown = new THREE.Mesh(
    new THREE.CylinderGeometry(height * 0.026, height * 0.031, height * 0.11, 18),
    concrete,
  );
  crown.position.y = height * 0.93;
  tower.add(crown);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(height * 0.024, height * 0.028, height * 0.04, 18),
    concrete,
  );
  cap.position.y = height * 0.99;
  tower.add(cap);
  tower.userData = { type: 'landmark', label: 'Coit Tower' };
  return tower;
}

function createSfLandmarkSilhouettes(regionBBox, isFullCity) {
  const group = new THREE.Group();
  group.name = 'SF landmark silhouettes';
  for (const spec of SF_LANDMARK_SPECS) {
    const resolved = resolveSfLandmark(spec);
    if (!landmarkVisibleInRegion(resolved.x, resolved.z, regionBBox, isFullCity)) continue;
    let landmark = null;
    if (spec.kind === 'transamerica') landmark = createTransamericaSilhouette(resolved.x, resolved.z, resolved.height);
    else if (spec.kind === 'salesforce') landmark = createSalesforceSilhouette(resolved.x, resolved.z, resolved.height);
    else if (spec.kind === 'coit') landmark = createCoitSilhouette(resolved.x, resolved.z, resolved.height);
    if (landmark) group.add(landmark);
  }
  return group;
}

function createSignalGroup(position, index) {
  const group = new THREE.Group();
  const poleMaterial = new THREE.MeshStandardMaterial({
    color: 0x31383d,
    roughness: 0.6,
    metalness: 0.55,
  });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 4.6, 8), poleMaterial);
  pole.position.y = 2.3;
  pole.castShadow = true;
  group.add(pole);

  const arm = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 0.12), poleMaterial);
  arm.position.set(1.2, 4.35, 0);
  arm.rotation.y = Math.atan2(position.z, position.x) * 0.15;
  arm.castShadow = true;
  group.add(arm);

  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.86, 0.28),
    new THREE.MeshStandardMaterial({ color: 0x171b1d, roughness: 0.4, metalness: 0.5 }),
  );
  housing.position.set(2.22, 3.45, 0);
  group.add(housing);

  const lamps = [];
  const lampColors = [0xff4747, 0xffb027, 0x43d17a];
  const lampMaterial = new THREE.MeshStandardMaterial({
    color: 0x22262a,
    emissive: 0x000000,
    emissiveIntensity: 1,
    roughness: 0.3,
  });
  for (let i = 0; i < 3; i += 1) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.105, 10, 8), lampMaterial.clone());
    lamp.position.set(2.22, 3.72 - i * 0.28, 0.17);
    lamp.userData = { colorIndex: i, lampColor: lampColors[i] };
    group.add(lamp);
    lamps.push(lamp);
  }
  group.position.set(position[0], elevationAt(position[0], position[1]), position[1]);
  group.userData = {
    type: 'signal',
    signal: { position, index },
    offset: ((position[0] * 0.041 + position[1] * 0.027) % SIGNAL_PERIOD + SIGNAL_PERIOD) % SIGNAL_PERIOD,
    lamps,
  };
  return group;
}

function createCrosswalks(signals, roads) {
  const group = new THREE.Group();
  group.name = 'Real map zebra crossings';
  const stripeMaterial = new THREE.MeshStandardMaterial({
    color: 0xf8f6ee,
    roughness: 0.62,
    metalness: 0.01,
  });
  const stripeGeometry = new THREE.BoxGeometry(0.58, 0.045, 7.4);
  const placements = [];
  for (const signal of signals) {
    let best = null;
    let bestDistance = 9;
    for (const road of roads) {
      const points = roadPoints(road);
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((signal[0] - a.x) * dx + (signal[1] - a.z) * dz) / lengthSq));
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const distance = Math.hypot(px - signal[0], pz - signal[1]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = {
            position: { x: px, z: pz },
            heading: Math.atan2(dz, dx),
            direction: { x: dx, z: dz },
          };
        }
      }
    }
    if (!best) continue;
    const length = Math.hypot(best.direction.x, best.direction.z) || 1;
    const roadX = best.direction.x / length;
    const roadZ = best.direction.z / length;
    for (let i = 0; i < 7; i += 1) {
      const offset = (i - 3) * 0.58;
      placements.push({
        x: best.position.x + roadX * offset,
        z: best.position.z + roadZ * offset,
        heading: best.heading + Math.PI * 0.5,
      });
    }
  }
  const mesh = new THREE.InstancedMesh(stripeGeometry, stripeMaterial, placements.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < placements.length; i += 1) {
    const placement = placements[i];
    dummy.position.set(placement.x, elevationAt(placement.x, placement.z) + 0.09, placement.z);
    dummy.rotation.set(0, placement.heading, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  group.userData = { type: 'crosswalks', stripes: placements.length };
  return group;
}

function createOneWayArrows(roads) {
  const arrows = [];
  const arrowGeometry = new THREE.ConeGeometry(0.5, 1.1, 3);
  const arrowMaterial = new THREE.MeshStandardMaterial({
    color: 0xf4f2ea,
    roughness: 0.48,
    metalness: 0.04,
  });
  const up = new THREE.Vector3(0, 1, 0);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color(0xf4f2ea);
  for (const road of roads) {
    if (!road.oneway) continue;
    const points = roadPoints(road);
    let length = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
    }
    const step = 22;
    const count = Math.max(1, Math.floor(length / step));
    for (let c = 0; c < count; c += 1) {
      const target = ((c + 0.5) / count) * length;
      let walked = 0;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const segLength = Math.hypot(b.x - a.x, b.z - a.z);
        if (walked + segLength >= target) {
          const t = segLength > 0 ? (target - walked) / segLength : 0;
          const px = a.x + (b.x - a.x) * t;
          const pz = a.z + (b.z - a.z) * t;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const direction = new THREE.Vector3(dx, 0, dz).normalize();
          arrows.push({
            road,
            position: new THREE.Vector3(px, elevationAt(px, pz) + 0.11, pz),
            direction,
          });
          break;
        }
        walked += segLength;
      }
    }
  }
  const mesh = new THREE.InstancedMesh(arrowGeometry, arrowMaterial, arrows.length);
  for (let i = 0; i < arrows.length; i += 1) {
    dummy.position.copy(arrows[i].position);
    dummy.quaternion.setFromUnitVectors(up, arrows[i].direction);
    dummy.scale.set(1.15, 0.22, 1.15);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, color);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildPaths(roads) {
  const paths = [];
  const vehicleClasses = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service']);
  for (const road of roads) {
    if (!vehicleClasses.has(road.highway)) continue;
    const points = roadPoints(road);
    if (points.length < 2) continue;
    const length = points.slice(0, -1).reduce((sum, a, i) => sum + Math.hypot(points[i + 1].x - a.x, points[i + 1].z - a.z), 0);
    if (length < 14) continue;
    const direction = road.oneway ? [1] : [1, -1];
    for (const dir of direction) {
      const ordered = dir === 1 ? points : [...points].reverse();
      paths.push({
        id: `p-${road.id}-${dir}`,
        road,
        points: ordered,
        length,
        dir,
        signalStops: [],
      });
    }
  }
  return paths;
}

function connectPaths(paths) {
  const startIndex = new Map();
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    const key = `${Math.round(path.points[0].x / 2)},${Math.round(path.points[0].z / 2)}`;
    const bucket = startIndex.get(key) || [];
    bucket.push(i);
    startIndex.set(key, bucket);
  }
  for (const path of paths) {
    const end = path.points[path.points.length - 1];
    const candidates = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const key = `${Math.round(end.x / 2) + dx},${Math.round(end.z / 2) + dz}`;
        const bucket = startIndex.get(key);
        if (bucket) candidates.push(...bucket);
      }
    }
    const unique = [...new Set(candidates)];
    path.next = unique;
  }
}

let vehiclePartGeometries = null;
const vehicleWindshieldMaterial = new THREE.MeshStandardMaterial({
  color: 0x6a8fa8,
  roughness: 0.14,
  metalness: 0.52,
  flatShading: true,
});

function getVehiclePartGeometries() {
  if (vehiclePartGeometries) return vehiclePartGeometries;
  vehiclePartGeometries = {
    chassis: new THREE.BoxGeometry(2.0, 0.38, 4.45),
    body: new THREE.BoxGeometry(1.96, 0.54, 3.78),
    cabin: new THREE.BoxGeometry(1.72, 0.5, 1.88),
    hood: new THREE.BoxGeometry(1.84, 0.26, 1.15),
    windshield: new THREE.BoxGeometry(1.58, 0.44, 0.08),
    rearWindow: new THREE.BoxGeometry(1.52, 0.36, 0.07),
    sideWindow: new THREE.BoxGeometry(0.06, 0.32, 1.05),
    wheel: new THREE.CylinderGeometry(0.38, 0.38, 0.24, 8),
    wheelHub: new THREE.CylinderGeometry(0.18, 0.18, 0.26, 6),
    truckBed: new THREE.BoxGeometry(2.0, 1.08, 2.55),
    bumper: new THREE.BoxGeometry(2.04, 0.16, 0.24),
    taxiSign: new THREE.BoxGeometry(0.78, 0.14, 0.42),
    roof: new THREE.BoxGeometry(1.64, 0.1, 1.62),
  };
  return vehiclePartGeometries;
}

function createVehicle(color, variant) {
  const group = new THREE.Group();
  const parts = getVehiclePartGeometries();
  const bodyColor = new THREE.Color(color);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: bodyColor,
    roughness: 0.36,
    metalness: 0.48,
    flatShading: true,
  });
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x121618,
    roughness: 0.58,
    metalness: 0.32,
    flatShading: true,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: 0x252b30,
    roughness: 0.52,
    metalness: 0.38,
    flatShading: true,
  });
  const glassMaterial = vehicleWindshieldMaterial.clone();
  glassMaterial.color.set(0x7a9cb8);
  const chassis = new THREE.Mesh(parts.chassis, trimMaterial);
  chassis.position.y = 0.4;
  chassis.castShadow = true;
  group.add(chassis);
  const body = new THREE.Mesh(parts.body, bodyMaterial);
  body.position.set(0, 0.76, variant === 'truck' ? 0.2 : 0.1);
  body.castShadow = true;
  group.add(body);
  if (variant === 'truck') {
    const bed = new THREE.Mesh(parts.truckBed, bodyMaterial);
    bed.position.set(0, 1.18, 1.0);
    bed.castShadow = true;
    group.add(bed);
    const cabin = new THREE.Mesh(parts.cabin, darkMaterial);
    cabin.position.set(0, 1.08, -0.58);
    cabin.castShadow = true;
    group.add(cabin);
    const windshield = new THREE.Mesh(parts.windshield, glassMaterial);
    windshield.position.set(0, 1.12, -0.22);
    windshield.castShadow = true;
    group.add(windshield);
  } else {
    const hood = new THREE.Mesh(parts.hood, bodyMaterial);
    hood.position.set(0, 0.82, -1.38);
    hood.castShadow = true;
    group.add(hood);
    const cabin = new THREE.Mesh(parts.cabin, darkMaterial);
    cabin.position.set(0, 1.12, 0.38);
    cabin.castShadow = true;
    group.add(cabin);
    const roof = new THREE.Mesh(parts.roof, bodyMaterial);
    roof.position.set(0, 1.38, 0.38);
    roof.castShadow = true;
    group.add(roof);
    const windshield = new THREE.Mesh(parts.windshield, glassMaterial);
    windshield.position.set(0, 1.14, -0.2);
    windshield.castShadow = true;
    group.add(windshield);
    const rearWindow = new THREE.Mesh(parts.rearWindow, glassMaterial);
    rearWindow.position.set(0, 1.1, 0.98);
    group.add(rearWindow);
    for (const sx of [-0.98, 0.98]) {
      const sideWindow = new THREE.Mesh(parts.sideWindow, glassMaterial);
      sideWindow.position.set(sx, 1.08, 0.38);
      group.add(sideWindow);
    }
  }
  const bumperFront = new THREE.Mesh(parts.bumper, trimMaterial);
  bumperFront.position.set(0, 0.5, -2.28);
  bumperFront.castShadow = true;
  group.add(bumperFront);
  const bumperRear = new THREE.Mesh(parts.bumper, trimMaterial);
  bumperRear.position.set(0, 0.5, 2.28);
  group.add(bumperRear);
  if (variant === 'taxi') {
    const sign = new THREE.Mesh(parts.taxiSign, new THREE.MeshStandardMaterial({
      color: 0xf0c842,
      roughness: 0.45,
      metalness: 0.08,
      flatShading: true,
    }));
    sign.position.set(0, 1.46, 0.12);
    group.add(sign);
  }
  for (const [wx, wz] of [[-0.98, 1.4], [0.98, 1.4], [-0.98, -1.4], [0.98, -1.4]]) {
    const wheel = new THREE.Mesh(parts.wheel, darkMaterial);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(wx, 0.38, wz);
    wheel.castShadow = true;
    group.add(wheel);
    const hub = new THREE.Mesh(parts.wheelHub, trimMaterial);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(wx, 0.38, wz);
    group.add(hub);
  }
  const headlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xffe7b0,
    emissive: 0xffd98a,
    emissiveIntensity: 0.85,
  });
  vehicleHeadlightMaterials.push(headlightMaterial);
  for (const hx of [-0.62, 0.62]) {
    const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.08), headlightMaterial);
    headlight.position.set(hx, 0.72, -2.32);
    group.add(headlight);
  }
  for (const hx of [-0.62, 0.62]) {
    const taillight = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.06), new THREE.MeshStandardMaterial({
      color: 0xc83838,
      emissive: 0x901818,
      emissiveIntensity: 0.35,
    }));
    taillight.position.set(hx, 0.7, 2.32);
    group.add(taillight);
  }
  group.scale.setScalar(1.2);
  return group;
}

function buildTraffic(selectedRoads, signals) {
  const paths = buildPaths(selectedRoads);
  connectPaths(paths);
  for (const path of paths) {
    for (const [sx, sz] of signals) {
      const point = { x: sx, z: sz };
      let best = Infinity;
      let bestS = -1;
      for (let i = 0; i < path.points.length - 1; i += 1) {
        const a = path.points[i];
        const b = path.points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const segLength = Math.hypot(dx, dz);
        if (segLength === 0) continue;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / (segLength * segLength)));
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const distance = Math.hypot(px - point.x, pz - point.z);
        if (distance < 9 && distance < best) {
          best = distance;
          bestS = i + t;
        }
      }
      if (bestS >= 0) path.signalStops.push({ s: bestS, offset: ((sx * 0.041 + sz * 0.027) % SIGNAL_PERIOD + SIGNAL_PERIOD) % SIGNAL_PERIOD });
    }
  }
  const colors = [0xd84a3a, 0x2f6fb5, 0xe0b32e, 0x4a9e77, 0xdfe1e4, 0x8e5a9e, 0xc98a3d, 0x3f8f8f];
  const variants = ['car', 'sedan', 'truck', 'taxi'];
  const vehicles = [];
  const count = Math.min(150, Math.max(36, Math.floor(paths.length * 0.08)));
  for (let i = 0; i < count; i += 1) {
    if (paths.length === 0) break;
    const path = paths[i % paths.length];
    const mesh = createVehicle(colors[i % colors.length], variants[i % variants.length]);
    const pose = pathPosition(path, (i / count) * path.length);
    mesh.position.copy(pose.position);
    mesh.rotation.set(0, pose.heading, 0);
    vehicles.push({
      mesh,
      path,
      s: (i / count) * path.length,
      speed: 0,
      targetSpeed: 6.5 + ((i * 7919) % 40) / 10,
      maxSpeed: 11,
      stopped: false,
    });
  }
  return { vehicles, paths };
}

function createRoadMeshes(compilation) {
  const arrowFreeNetwork = {
    ...compilation.network,
    roads: compilation.network.roads.map((road) => ({
      ...road,
      markings: (road.markings || []).filter((marking) => marking.kind !== 'arrow'),
    })),
  };
  let surface;
  try {
    surface = buildRoadSurfaceModel(arrowFreeNetwork, compilation.physicalTopology, {
      maxSegmentLength: 4,
      maxChordError: 0.02,
      junctionTessellationStep: 1.6,
    });
  } catch (error) {
    console.error('Road surface mesher failed on dense profile', error.message);
    surface = buildRoadSurfaceModel(arrowFreeNetwork, compilation.physicalTopology, {
      maxSegmentLength: 6,
      maxChordError: 0.03,
      junctionTessellationStep: 2.4,
    });
  }
  let bundle;
  try {
    bundle = meshRoadSurfaceModel(surface);
  } catch (error) {
    console.error('Whole-model mesh failed, retrying without junction patches', error.message);
    surface.junctionPatches = [];
    surface.decals = [];
    surface.markings = (surface.markings || []).filter((marking) => {
      const owner = String(marking.ownerId || '');
      return !owner.startsWith('junction') && !owner.startsWith('sf-auto');
    });
    bundle = meshRoadSurfaceModel(surface);
  }
  const group = new THREE.Group();
  const surfaceParts = indexedMeshToGeometries(bundle.surface);
  for (const part of surfaceParts) {
    const mesh = new THREE.Mesh(part.geometry, makeRoadMaterial(part.materialClass));
    applyTerrainToMesh(mesh);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `Real map road surface ${part.materialClass}`;
    group.add(mesh);
  }
  if (bundle.markings.positions.length > 0) {
    const markingParts = indexedMeshToGeometries(bundle.markings);
    for (const part of markingParts) {
      const mesh = new THREE.Mesh(part.geometry, makeRoadMaterial(part.materialClass));
      applyTerrainToMesh(mesh);
      mesh.name = `Real map road markings ${part.materialClass}`;
      group.add(mesh);
    }
  }
  group.userData = { type: 'roads', compilation };
  return group;
}

const SIMPLE_ROAD_CONFIG = {
  motorway: { width: 13.5, color: 0x454c52 },
  trunk: { width: 12, color: 0x4a5157 },
  primary: { width: 10.5, color: 0x52585e },
  secondary: { width: 9, color: 0x585f65 },
  tertiary: { width: 7.5, color: 0x5c646a },
  unclassified: { width: 6.5, color: 0x626970 },
  residential: { width: 6, color: 0x636b72 },
  living_street: { width: 5, color: 0x697078 },
  service: { width: 4.5, color: 0x6b7279 },
  pedestrian: { width: 3.6, color: 0x85857d },
  footway: { width: 2.4, color: 0x8b8b84 },
  cycleway: { width: 2.2, color: 0x8b8b84 },
  path: { width: 2, color: 0x8b8b84 },
};

function roadSegmentCount(roads) {
  let count = 0;
  for (const road of roads) {
    count += Math.max(0, road.points.length / 2 - 1);
  }
  return count;
}

function createSimpleRoadMeshes(roads) {
  const group = new THREE.Group();
  const classes = new Map();
  for (const road of roads) {
    const cls = SIMPLE_ROAD_CONFIG[road.highway] ? road.highway : 'service';
    const entry = classes.get(cls) || { roads: [], count: 0 };
    entry.roads.push(road);
    entry.count += Math.max(0, road.points.length / 2 - 1);
    classes.set(cls, entry);
  }
  const geometry = new THREE.PlaneGeometry(1, 1);
  for (const [cls, entry] of classes) {
    if (!entry.count) continue;
    const config = SIMPLE_ROAD_CONFIG[cls];
    const material = new THREE.MeshStandardMaterial({
      color: config.color,
      roughness: 0.95,
      metalness: 0.01,
    });
    if (sandboxTextureCache.asphalt) {
      material.map = sandboxTextureCache.asphalt;
      material.color.set(0xcccccc);
    }
    if (sandboxTextureCache.asphaltNormal) {
      material.normalMap = sandboxTextureCache.asphaltNormal;
      material.normalScale.set(0.28, 0.28);
    }
    if (sandboxTextureCache.asphaltRoughness) {
      material.roughnessMap = sandboxTextureCache.asphaltRoughness;
      material.roughness = 1;
    } else {
      material.roughness = 0.92;
    }
    const positions = [];
    const indices = [];
    let vertexOffset = 0;
    for (const road of entry.roads) {
      const points = roadPoints(road);
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.4) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const half = config.width / 2;
        const a1 = { x: a.x + nx * half, z: a.z + nz * half };
        const a2 = { x: a.x - nx * half, z: a.z - nz * half };
        const b1 = { x: b.x + nx * half, z: b.z + nz * half };
        const b2 = { x: b.x - nx * half, z: b.z - nz * half };
        positions.push(
          a1.x, elevationAt(a1.x, a1.z) + ROAD_SURFACE_LIFT, a1.z,
          a2.x, elevationAt(a2.x, a2.z) + ROAD_SURFACE_LIFT, a2.z,
          b1.x, elevationAt(b1.x, b1.z) + ROAD_SURFACE_LIFT, b1.z,
          b2.x, elevationAt(b2.x, b2.z) + ROAD_SURFACE_LIFT, b2.z,
        );
        indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset + 2, vertexOffset + 1, vertexOffset + 3);
        vertexOffset += 4;
      }
    }
    if (!positions.length) continue;
    const meshGeometry = new THREE.BufferGeometry();
    meshGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const uvs = [];
    const repeat = Math.max(1, Math.floor(entry.roads.reduce((sum, road) => sum + roadLengthOf(road), 0) / 90));
    for (let i = 0; i < vertexOffset; i += 1) uvs.push(i % 2 === 0 ? 0 : 1, ((i / 4) * repeat) % 200);
    meshGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    meshGeometry.setIndex(indices);
    meshGeometry.computeVertexNormals();
    const mesh = new THREE.Mesh(meshGeometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `Simple real road ${cls}`;
    group.add(mesh);
  }
  group.userData = { type: 'simple-roads', segments: roadSegmentCount(roads) };
  return group;
}

function createCableCarTracks(roads) {
  const group = new THREE.Group();
  group.name = 'Cable car tracks';
  const trackMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a9098,
    roughness: 0.42,
    metalness: 0.72,
    flatShading: true,
  });
  const eligibleClasses = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);
  const positions = [];
  const indices = [];
  const railPositions = [];
  const railIndices = [];
  let vertexOffset = 0;
  let railOffset = 0;
  const trackHalf = 0.22;
  const railHalf = 0.04;
  for (const road of roads) {
    if (!eligibleClasses.has(road.highway)) continue;
    const points = roadPoints(road);
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 24) continue;
      const grade = Math.abs(elevationAt(b.x, b.z) - elevationAt(a.x, a.z)) / length;
      const northSouth = Math.abs(dz) > Math.abs(dx) * 1.15;
      if (!northSouth || grade < 0.085) continue;
      const nx = -dz / length;
      const nz = dx / length;
      const a1 = { x: a.x + nx * trackHalf, z: a.z + nz * trackHalf };
      const a2 = { x: a.x - nx * trackHalf, z: a.z - nz * trackHalf };
      const b1 = { x: b.x + nx * trackHalf, z: b.z + nz * trackHalf };
      const b2 = { x: b.x - nx * trackHalf, z: b.z - nz * trackHalf };
      positions.push(
        a1.x, elevationAt(a1.x, a1.z) + ROAD_SURFACE_LIFT + 0.03, a1.z,
        a2.x, elevationAt(a2.x, a2.z) + ROAD_SURFACE_LIFT + 0.03, a2.z,
        b1.x, elevationAt(b1.x, b1.z) + ROAD_SURFACE_LIFT + 0.03, b1.z,
        b2.x, elevationAt(b2.x, b2.z) + ROAD_SURFACE_LIFT + 0.03, b2.z,
      );
      indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2, vertexOffset + 2, vertexOffset + 1, vertexOffset + 3);
      vertexOffset += 4;
      for (const side of [-1, 1]) {
        const ox = nx * side * (trackHalf - railHalf);
        const oz = nz * side * (trackHalf - railHalf);
        railPositions.push(
          a.x + ox, elevationAt(a.x + ox, a.z + oz) + ROAD_SURFACE_LIFT + 0.06, a.z + oz,
          b.x + ox, elevationAt(b.x + ox, b.z + oz) + ROAD_SURFACE_LIFT + 0.06, b.z + oz,
        );
        railIndices.push(railOffset, railOffset + 1);
        railOffset += 2;
      }
    }
  }
  if (positions.length) {
    const trackGeometry = new THREE.BufferGeometry();
    trackGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    trackGeometry.setIndex(indices);
    trackGeometry.computeVertexNormals();
    const trackMesh = new THREE.Mesh(trackGeometry, trackMaterial);
    trackMesh.castShadow = true;
    trackMesh.receiveShadow = true;
    group.add(trackMesh);
  }
  if (railPositions.length) {
    const railGeometry = new THREE.BufferGeometry();
    railGeometry.setAttribute('position', new THREE.Float32BufferAttribute(railPositions, 3));
    railGeometry.setIndex(railIndices);
    const railMesh = new THREE.LineSegments(railGeometry, new THREE.LineBasicMaterial({ color: 0x4a5058, linewidth: 1 }));
    group.add(railMesh);
  }
  group.userData = { type: 'cable-car-tracks', segments: indices.length / 6 };
  return group;
}

function createSimpleSidewalkMeshes(roads) {
  const sidewalkClasses = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian']);
  const concreteSegments = [];
  const brickSegments = [];
  for (const road of roads) {
    if (!sidewalkClasses.has(road.highway)) continue;
    const points = roadPoints(road);
    const offset = roadHalfWidth(road);
    for (const side of [offsetPolyline(points, offset), offsetPolyline(points, -offset)]) {
      for (let i = 0; i < side.length - 1; i += 1) {
        const a = side[i];
        const b = side[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.4) continue;
        const segment = { a, b, dx, dz, length };
        if ((Math.floor(a.x + a.z + road.id) % 3) === 0) brickSegments.push(segment);
        else concreteSegments.push(segment);
      }
    }
  }
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 0.05, 1);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const dummy = new THREE.Object3D();
  const addSidewalkBatch = (segments, map, tint) => {
    if (!segments.length) return;
    const material = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 0.88,
      metalness: 0.01,
    });
    if (map) {
      material.map = map;
      material.color.set(0xffffff);
    }
    const mesh = new THREE.InstancedMesh(geometry, material, segments.length);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const direction = new THREE.Vector3(segment.dx / segment.length, 0, segment.dz / segment.length);
      dummy.position.set(
        (segment.a.x + segment.b.x) / 2,
        elevationAt((segment.a.x + segment.b.x) / 2, (segment.a.z + segment.b.z) / 2) + ROAD_SURFACE_LIFT + 0.01,
        (segment.a.z + segment.b.z) / 2,
      );
      dummy.quaternion.setFromUnitVectors(zAxis, direction);
      dummy.scale.set(3.2, 1, segment.length);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  addSidewalkBatch(concreteSegments, sandboxTextureCache.sidewalk, 0xc8c2b8);
  addSidewalkBatch(brickSegments, sandboxTextureCache.brickSidewalk, 0xe8dcc8);
  group.userData = { type: 'simple-sidewalks', segments: concreteSegments.length + brickSegments.length };
  return group;
}

function createStreetCorridorPads(roads) {
  const corridorClasses = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);
  const segments = [];
  for (const road of roads) {
    if (!corridorClasses.has(road.highway)) continue;
    const points = roadPoints(road);
    const padOffset = roadHalfWidth(road) + 4.8;
    const padWidth = 6.4;
    for (const offset of [padOffset, -padOffset]) {
      const centerline = offsetPolyline(points, offset);
      for (let i = 0; i < centerline.length - 1; i += 1) {
        const a = centerline[i];
        const b = centerline[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.8) continue;
        segments.push({ a, b, dx, dz, length, width: padWidth, brick: (Math.floor(a.x + a.z + road.id + offset) % 4) !== 0 });
      }
    }
  }
  const group = new THREE.Group();
  group.name = 'Street corridor sidewalk pads';
  const geometry = new THREE.BoxGeometry(1, 0.06, 1);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const dummy = new THREE.Object3D();
  const addPadBatch = (batch, map, tint) => {
    if (!batch.length) return;
    const material = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 0.86,
      metalness: 0.01,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    if (map) {
      material.map = map;
      material.color.set(0xffffff);
    }
    const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
    for (let index = 0; index < batch.length; index += 1) {
      const segment = batch[index];
      const direction = new THREE.Vector3(segment.dx / segment.length, 0, segment.dz / segment.length);
      dummy.position.set(
        (segment.a.x + segment.b.x) / 2,
        elevationAt((segment.a.x + segment.b.x) / 2, (segment.a.z + segment.b.z) / 2) + ROAD_SURFACE_LIFT + 0.02,
        (segment.a.z + segment.b.z) / 2,
      );
      dummy.quaternion.setFromUnitVectors(zAxis, direction);
      dummy.scale.set(segment.width, 1, segment.length);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  addPadBatch(segments.filter((segment) => !segment.brick), sandboxTextureCache.sidewalk, 0xd0cac0);
  addPadBatch(segments.filter((segment) => segment.brick), sandboxTextureCache.brickSidewalk, 0xece0cc);
  group.userData = { type: 'street-corridor-pads', segments: segments.length };
  return group;
}

function createBuildingFrontagePads(buildings) {
  const pads = [];
  for (const building of buildings.detailed) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < building.points.length; i += 2) {
      minX = Math.min(minX, building.points[i]);
      maxX = Math.max(maxX, building.points[i]);
      minZ = Math.min(minZ, building.points[i + 1]);
      maxZ = Math.max(maxZ, building.points[i + 1]);
    }
    if (!Number.isFinite(minX)) continue;
    const inset = 2.8;
    pads.push({
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      width: Math.max(6, maxX - minX + inset * 2),
      depth: Math.max(6, maxZ - minZ + inset * 2),
      brick: (Number(building.id) || 0) % 11 === 0,
    });
  }
  for (const building of buildings.coarse) {
    const size = Math.max(5, Math.min(Math.sqrt(building.area || 160), 36));
    pads.push({
      cx: building.centroid[0],
      cz: building.centroid[1],
      width: size + 5.6,
      depth: size + 5.6,
      brick: (Number(building.id) || 0) % 13 === 0,
    });
  }
  const group = new THREE.Group();
  group.name = 'Building frontage plaza pads';
  if (!pads.length) {
    group.userData = { type: 'building-frontage-pads', pads: 0 };
    return group;
  }
  const geometry = new THREE.BoxGeometry(1, 0.035, 1);
  const dummy = new THREE.Object3D();
  const addBatch = (batch, map, tint) => {
    if (!batch.length) return;
    const material = new THREE.MeshStandardMaterial({
      color: tint,
      roughness: 0.92,
      metalness: 0.01,
    });
    if (map) {
      material.map = map;
      material.color.set(0xffffff);
    }
    const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
    for (let index = 0; index < batch.length; index += 1) {
      const pad = batch[index];
      dummy.position.set(
        pad.cx,
        elevationAt(pad.cx, pad.cz) + ROAD_SURFACE_LIFT - 0.04,
        pad.cz,
      );
      dummy.rotation.set(0, ((pad.cx * 17 + pad.cz * 31) % 628) / 628 * 0.08, 0);
      dummy.scale.set(pad.width, 1, pad.depth);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  addBatch(pads.filter((pad) => !pad.brick), sandboxTextureCache.sidewalk, 0xb8b2a8);
  addBatch(pads.filter((pad) => pad.brick), sandboxTextureCache.brickSidewalk, 0xc8c0b6);
  group.userData = { type: 'building-frontage-pads', pads: pads.length };
  return group;
}

function queueDetailRoadChunk(focus) {
  if (!fullCityMode || !cityData?.detailRoads?.length) return;
  const radius = 640;
  const candidates = [];
  for (const road of cityData.detailRoads) {
    if (detailRoadCompiledIds.has(road.id)) continue;
    const points = roadPoints(road);
    let nearestDistance = Infinity;
    for (const point of points) {
      const distance = Math.hypot(point.x - focus.x, point.z - focus.z);
      if (distance < nearestDistance) nearestDistance = distance;
    }
    if (nearestDistance <= radius && points.some(pointInRegion)) candidates.push({ road, nearestDistance });
  }
  candidates.sort((a, b) => a.nearestDistance - b.nearestDistance);
  const chunk = candidates.slice(0, 260).map((entry) => entry.road);
  if (chunk.length < 24) return;
  detailRoadQueue.push(chunk);
  detailRoadStreamStats.pendingRoads += chunk.length;
}

async function loadNextDetailRoadChunk() {
  if (roadStreamingInFlight || !detailRoadQueue.length) return;
  roadStreamingInFlight = true;
  const chunk = detailRoadQueue.shift();
  try {
    const { compilation } = compileSafely(chunk);
    const meshes = createRoadMeshes(compilation);
    detailRoadStreamGroup?.add(meshes);
    for (const road of chunk) detailRoadCompiledIds.add(road.id);
    detailRoadStreamStats.loadedChunks += 1;
    detailRoadStreamStats.compiledRoads += chunk.length;
    detailRoadStreamStats.pendingRoads -= chunk.length;
  } catch (error) {
    console.warn('Detail road chunk compile skipped', error.message);
    detailRoadStreamStats.pendingRoads -= chunk.length;
  } finally {
    roadStreamingInFlight = false;
  }
}

function updateRoadStreaming(focus) {
  if (!fullCityMode || !detailRoadStreamGroup) return;
  if (!detailRoadQueue.length) queueDetailRoadChunk(focus);
  if (!roadStreamingInFlight && detailRoadQueue.length) {
    loadNextDetailRoadChunk();
  }
}

let renderer;
let scene;
let camera;
let controls;
let sun;
let moonFill;
let nightAmbient;
let ssaoPassRef = null;
let cityRoot;
let trafficState = null;
let signalGroups = [];
let coarseBuildingMesh = null;
let detailBuildingMeshes = [];
let roadMeshes = null;
let selectedRoadsForHit = [];
let frameTime = 0;
let fpsSamples = [];
let lastFrameTime = performance.now();
const moveKeys = new Set();
let cityMode = 'orbit';
let cityFlatRegion = [];
let playerState = null;
let playerAvatarGroup = null;
let playerYaw = 0;
let playerPitch = -0.12;
let pointerLockActive = false;
let collisionAabbs = [];
let collisionCells = new Map();
let pedestrianGroup = null;
let pedestrianState = [];
let treeGroup = null;
let furnitureGroup = null;
let hillVegetationGroup = null;
let doorwayGroup = null;
let streetfrontGroup = null;
let rooftopGroup = null;
let driveIndex = -1;
let missionState = null;
let composer = null;
let skyDome = null;
let sceneTriangleCount = 0;
let weatherIndex = 0;
let weatherMode = 'clear';
let timeOfDay = 'day';
let timeIndex = 0;
let interiorGroup = null;
let interiorState = null;
let interiorLight = null;
let interiorResidents = [];
let hemisphereLight = null;
let fullCityMode = false;
let simpleRoadSegments = 0;
let simpleSidewalkSegments = 0;
let detailRoadStreamGroup = null;
let detailRoadQueue = [];
let detailRoadCompiledIds = new Set();
let detailRoadStreamStats = { loadedChunks: 0, compiledRoads: 0, pendingRoads: 0 };
let roadStreamingInFlight = false;
let sandboxAudio = null;
let audioEnabled = true;
let rainGroup = null;
let rainPositions = null;
let rainVelocities = null;
const windowMaterials = [];
const streetLightMaterials = [];
const vehicleHeadlightMaterials = [];
const CELL_SIZE = 24;

const WEATHER_MODES = {
  clear: {
    label: 'CLEAR',
    background: 0xa8c8dc,
    fogColor: 0xb8d0e0,
    fogNear: 320,
    fogFar: 2200,
    sunIntensity: 3.55,
    sunColor: 0xffcc88,
    exposure: 1.12,
    skyTop: 0x3a7aad,
    skyMid: 0x6eaed0,
    skyHorizon: 0xe8c898,
    skySun: 0xffc070,
  },
  fog: {
    label: 'PACIFIC FOG',
    background: 0xaab6bd,
    fogColor: 0xaab6bd,
    fogNear: 120,
    fogFar: 1400,
    sunIntensity: 1.45,
    sunColor: 0xdfe7ea,
    exposure: 0.96,
    skyTop: 0x9fb3bc,
    skyMid: 0xb0c0c8,
    skyHorizon: 0xc3c8c4,
    skySun: 0xd7d3c8,
  },
  drizzle: {
    label: 'PACIFIC DRIZZLE',
    background: 0x758a93,
    fogColor: 0x758a93,
    fogNear: 150,
    fogFar: 1600,
    sunIntensity: 1.9,
    sunColor: 0xc8c5b8,
    exposure: 1.02,
    skyTop: 0x667f89,
    skyMid: 0x7a9098,
    skyHorizon: 0x9a9d95,
    skySun: 0xb5a98c,
  },
};

const TIME_OF_DAY_MODES = {
  day: {
    label: 'DAY',
    background: 0xa8c8dc,
    fogColor: 0xb8d0e0,
    fogNear: 320,
    fogFar: 2200,
    sunColor: 0xffcc88,
    sunIntensity: 3.55,
    sunPosition: [420, 620, 380],
    hemisphereSky: 0xb8dff0,
    hemisphereGround: 0x5a5648,
    hemisphereIntensity: 0.92,
    exposure: 1.12,
    skyTop: 0x3a7aad,
    skyMid: 0x6eaed0,
    skyHorizon: 0xe8c898,
    skySun: 0xffc070,
    night: 0,
  },
  dusk: {
    label: 'DUSK',
    background: 0x6f7784,
    fogColor: 0x727a86,
    fogNear: 320,
    fogFar: 2100,
    sunColor: 0xff9c6b,
    sunIntensity: 1.55,
    sunPosition: [180, 210, 420],
    hemisphereSky: 0x8ba7c9,
    hemisphereGround: 0x4a3f48,
    hemisphereIntensity: 0.72,
    exposure: 1.0,
    skyTop: 0x3b5474,
    skyHorizon: 0xd89070,
    skySun: 0xffa66e,
    night: 0.42,
  },
  night: {
    label: 'NIGHT',
    background: 0x101826,
    fogColor: 0x152033,
    fogNear: 280,
    fogFar: 1900,
    sunColor: 0x8aa4c8,
    sunIntensity: 0.28,
    sunPosition: [-420, 120, -380],
    hemisphereSky: 0x243652,
    hemisphereGround: 0x141820,
    hemisphereIntensity: 0.55,
    exposure: 1.08,
    skyTop: 0x0c1524,
    skyHorizon: 0x243448,
    skySun: 0xb8c8e0,
    night: 1,
  },
  dawn: {
    label: 'DAWN',
    background: 0x9aa8b5,
    fogColor: 0x9aa8b5,
    fogNear: 340,
    fogFar: 2200,
    sunColor: 0xffb98a,
    sunIntensity: 1.85,
    sunPosition: [520, 180, 320],
    hemisphereSky: 0xbad0e4,
    hemisphereGround: 0x6b5b50,
    hemisphereIntensity: 0.85,
    exposure: 1.06,
    skyTop: 0x6f8ba8,
    skyHorizon: 0xe6b390,
    skySun: 0xffc79b,
    night: 0.28,
  },
};

function roadHalfWidth(road) {
  const cls = road.highway || 'residential';
  const half = {
    motorway: 16,
    trunk: 14,
    primary: 12,
    secondary: 10.5,
    tertiary: 8.5,
    unclassified: 7,
    residential: 6.5,
    living_street: 5.5,
    service: 5,
    pedestrian: 3.5,
    footway: 2.5,
    cycleway: 2.5,
    path: 2,
  }[cls] ?? 6.5;
  return half + 2.1;
}

function cellKey(cellX, cellZ) {
  return `${cellX},${cellZ}`;
}

function insertCollisionBox(box) {
  const minX = Math.floor(box.min.x / CELL_SIZE);
  const maxX = Math.floor(box.max.x / CELL_SIZE);
  const minZ = Math.floor(box.min.z / CELL_SIZE);
  const maxZ = Math.floor(box.max.z / CELL_SIZE);
  for (let x = minX; x <= maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      const key = cellKey(x, z);
      const bucket = collisionCells.get(key) || [];
      bucket.push(box);
      collisionCells.set(key, bucket);
    }
  }
  collisionAabbs.push(box);
}

function buildCollisionGrid(detailMeshes, coarseMesh) {
  collisionAabbs = [];
  collisionCells = new Map();
  for (const mesh of detailMeshes) {
    const box = new THREE.Box3().setFromObject(mesh);
    insertCollisionBox(box);
  }
  if (coarseMesh?.geometry) {
    coarseMesh.geometry.computeBoundingBox();
  }
  if (coarseMesh?.geometry?.boundingBox) {
    const matrix = new THREE.Matrix4();
    const corners = [];
    const source = coarseMesh.geometry.boundingBox;
    for (const [x, y, z] of [
      [source.min.x, source.min.y, source.min.z],
      [source.max.x, source.min.y, source.min.z],
      [source.min.x, source.max.y, source.min.z],
      [source.min.x, source.min.y, source.max.z],
      [source.max.x, source.max.y, source.min.z],
      [source.min.x, source.max.y, source.max.z],
      [source.max.x, source.min.y, source.max.z],
      [source.max.x, source.max.y, source.max.z],
    ]) corners.push(new THREE.Vector3(x, y, z));
    const count = coarseMesh.count;
    for (let i = 0; i < count; i += 1) {
      coarseMesh.getMatrixAt(i, matrix);
      const worldCorners = corners.map((point) => point.clone().applyMatrix4(matrix));
      insertCollisionBox(new THREE.Box3().setFromPoints(worldCorners));
    }
  }
}

function collisionBoxesNear(x, z, radius) {
  const minX = Math.floor((x - radius) / CELL_SIZE);
  const maxX = Math.floor((x + radius) / CELL_SIZE);
  const minZ = Math.floor((z - radius) / CELL_SIZE);
  const maxZ = Math.floor((z + radius) / CELL_SIZE);
  const boxes = [];
  const seen = new Set();
  for (let cx = minX; cx <= maxX; cx += 1) {
    for (let cz = minZ; cz <= maxZ; cz += 1) {
      const bucket = collisionCells.get(cellKey(cx, cz));
      if (!bucket) continue;
      for (const box of bucket) {
        if (!seen.has(box)) {
          seen.add(box);
          boxes.push(box);
        }
      }
    }
  }
  return boxes;
}

function nearestRegionPoint(x, z) {
  let bestDistance = Infinity;
  let best = { x, z };
  for (let i = 0; i < region.length; i += 1) {
    const a = region[i];
    const b = region[(i + 1) % region.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { x: px, z: pz };
    }
  }
  return best;
}

function resolvePlayerPosition(x, z, radius = 0.5) {
  let resolvedX = x;
  let resolvedZ = z;
  for (let pass = 0; pass < 2; pass += 1) {
    const boxes = collisionBoxesNear(resolvedX, resolvedZ, radius + 1);
    for (const box of boxes) {
      const closestX = THREE.MathUtils.clamp(resolvedX, box.min.x, box.max.x);
      const closestZ = THREE.MathUtils.clamp(resolvedZ, box.min.z, box.max.z);
      const dx = resolvedX - closestX;
      const dz = resolvedZ - closestZ;
      const distance = Math.hypot(dx, dz);
      if (distance < radius && distance > 0.0001) {
        const push = (radius - distance) / distance;
        resolvedX += dx * push;
        resolvedZ += dz * push;
      } else if (distance <= 0.0001) {
        const centerX = (box.min.x + box.max.x) * 0.5;
        const centerZ = (box.min.z + box.max.z) * 0.5;
        const awayX = resolvedX - centerX;
        const awayZ = resolvedZ - centerZ;
        const awayLength = Math.hypot(awayX, awayZ) || 1;
        resolvedX += (awayX / awayLength) * radius;
        resolvedZ += (awayZ / awayLength) * radius;
      }
    }
  }
  if (region.length >= 3 && !pointInFlatRing({ x: resolvedX, z: resolvedZ }, cityFlatRegion)) {
    const nearest = nearestRegionPoint(resolvedX, resolvedZ);
    resolvedX = nearest.x;
    resolvedZ = nearest.z;
  }
  return { x: resolvedX, z: resolvedZ };
}

function createSandboxPlayerAvatar() {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x3f6f8f,
    roughness: 0.72,
    metalness: 0.02,
    flatShading: true,
  });
  const legMaterial = new THREE.MeshStandardMaterial({
    color: 0x2f3a44,
    roughness: 0.8,
    flatShading: true,
  });
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9a37e,
    roughness: 0.62,
  });
  const hairMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b2623,
    roughness: 0.78,
  });
  const legs = new THREE.Group();
  legs.name = 'player-legs';
  const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.2), legMaterial);
  leftLeg.position.set(-0.12, 0.275, 0);
  const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.2), legMaterial);
  rightLeg.position.set(0.12, 0.275, 0);
  legs.add(leftLeg, rightLeg);
  legs.position.y = 0;
  group.add(legs);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.62, 0.3), bodyMaterial);
  body.position.y = 0.92;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), skinMaterial);
  head.position.y = 1.42;
  head.castShadow = true;
  group.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.175, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMaterial);
  hair.position.y = 1.46;
  group.add(hair);
  const armLeft = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.16), bodyMaterial);
  armLeft.position.set(-0.34, 1.05, 0);
  armLeft.castShadow = true;
  const armRight = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.16), bodyMaterial);
  armRight.position.set(0.34, 1.05, 0);
  armRight.castShadow = true;
  group.add(armLeft, armRight);
  group.userData = { type: 'player', legs, leftLeg, rightLeg };
  return group;
}

function initPlayer(position) {
  if (!playerAvatarGroup) {
    playerAvatarGroup = createSandboxPlayerAvatar();
    scene.add(playerAvatarGroup);
  }
  const resolved = resolvePlayerPosition(position.x, position.z, 0.5);
  playerState = {
    x: resolved.x,
    z: resolved.z,
    yaw: Math.atan2(0 - position.x, 0 - position.z),
    pitch: -0.12,
    walking: 0,
  };
  playerYaw = playerState.yaw;
  playerPitch = playerState.pitch;
  playerAvatarGroup.position.set(resolved.x, elevationAt(resolved.x, resolved.z), resolved.z);
}

function updatePlayerWalk(dt) {
  if (!playerState) return;
  const speed = moveKeys.has('shiftleft') || moveKeys.has('shiftright') ? 9 : 5.2;
  const forward = new THREE.Vector3(Math.sin(playerYaw), 0, Math.cos(playerYaw));
  const right = new THREE.Vector3(Math.cos(playerYaw), 0, -Math.sin(playerYaw));
  const move = new THREE.Vector3();
  if (moveKeys.has('w')) move.add(forward);
  if (moveKeys.has('s')) move.sub(forward);
  if (moveKeys.has('d')) move.add(right);
  if (moveKeys.has('a')) move.sub(right);
  const moving = move.lengthSq() > 0;
  if (moving) {
    move.normalize().multiplyScalar(speed * dt);
    const resolved = resolvePlayerPosition(playerState.x + move.x, playerState.z + move.z, 0.5);
    playerState.x = resolved.x;
    playerState.z = resolved.z;
    playerState.walking += dt * 6;
  }
  const legs = playerAvatarGroup.userData.legs;
  if (legs) {
    const swing = moving ? Math.sin(playerState.walking) * 0.42 : 0;
    legs.userData = legs.userData || {};
    legs.rotation.x = swing * 0.5;
    legs.children[0].rotation.x = swing;
    legs.children[1].rotation.x = -swing;
  }
  playerAvatarGroup.position.set(playerState.x, elevationAt(playerState.x, playerState.z), playerState.z);
  playerAvatarGroup.rotation.y = playerYaw;
  camera.position.set(playerState.x, elevationAt(playerState.x, playerState.z) + 1.68, playerState.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(playerPitch, playerYaw, 0);
}

function createPedestrianAvatar(palette) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.55, 0.24),
    new THREE.MeshStandardMaterial({ color: palette.top, roughness: 0.8, flatShading: true }),
  );
  body.position.y = 0.9;
  body.castShadow = true;
  const legs = new THREE.Group();
  const legMaterial = new THREE.MeshStandardMaterial({ color: palette.bottom, roughness: 0.85, flatShading: true });
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.45, 0.15), legMaterial);
  left.position.set(-0.1, 0.225, 0);
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.45, 0.15), legMaterial);
  right.position.set(0.1, 0.225, 0);
  legs.add(left, right);
  group.add(legs);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 10, 8),
    new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.65 }),
  );
  head.position.y = 1.38;
  head.castShadow = true;
  group.add(head);
  group.userData = { legs, left, right };
  return group;
}

function offsetPolyline(points, offset) {
  const result = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next.x - previous.x;
    let dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    result.push({ x: points[i].x - dz * offset, z: points[i].z + dx * offset });
  }
  return result;
}

function buildSidewalkPaths(roads) {
  const paths = [];
  const classes = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian']);
  for (const road of roads) {
    if (!classes.has(road.highway)) continue;
    const points = roadPoints(road);
    if (points.length < 2) continue;
    const offset = roadHalfWidth(road);
    const sides = [
      offsetPolyline(points, offset),
      offsetPolyline(points, -offset),
    ];
    for (const side of sides) {
      let length = 0;
      for (let i = 0; i < side.length - 1; i += 1) {
        length += Math.hypot(side[i + 1].x - side[i].x, side[i + 1].z - side[i].z);
      }
      if (length < 16) continue;
      paths.push({ points: side, length, speed: 1.05 + Math.random() * 0.7 });
    }
  }
  return paths;
}

function pointAlongPath(points, s) {
  const clamped = Math.max(0, Math.min(points.length > 1 ? pathLength(points) - 0.01 : 0, s));
  let walked = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (walked + length >= clamped) {
      const t = length > 0 ? (clamped - walked) / length : 0;
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        heading: Math.atan2(b.z - a.z, b.x - a.x),
      };
    }
    walked += length;
  }
  const last = points[points.length - 1];
  const previous = points[points.length - 2] || last;
  return { x: last.x, z: last.z, heading: Math.atan2(last.z - previous.z, last.x - previous.x) };
}

function pathLength(points) {
  let length = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return length;
}

function createPedestrianSystem(roads) {
  const paths = buildSidewalkPaths(roads);
  if (pedestrianGroup) {
    cityRoot.remove(pedestrianGroup);
    pedestrianGroup = null;
  }
  pedestrianGroup = new THREE.Group();
  pedestrianGroup.name = 'Real map sidewalk pedestrians';
  cityRoot.add(pedestrianGroup);
  pedestrianState = [];
  const palettes = [
    { top: 0x3f6f8f, bottom: 0x2f3a44, skin: 0xd9a37e },
    { top: 0x9d4f46, bottom: 0x27313a, skin: 0x8d5f43 },
    { top: 0x5b7a63, bottom: 0x333c45, skin: 0xf0c8a0 },
    { top: 0x6b4e7a, bottom: 0x242d35, skin: 0x7d4a33 },
    { top: 0x8a5a2b, bottom: 0x2d2f31, skin: 0xe8b48f },
    { top: 0x3f8f8f, bottom: 0x1f333a, skin: 0xd8a989 },
  ];
  const count = Math.min(320, Math.max(50, Math.floor(paths.length * 0.18)));
  for (let i = 0; i < count && paths.length; i += 1) {
    const path = paths[i % paths.length];
    const avatar = createPedestrianAvatar(palettes[i % palettes.length]);
    const s = Math.random() * path.length;
    const pose = pointAlongPath(path.points, s);
    avatar.position.set(pose.x, elevationAt(pose.x, pose.z), pose.z);
    avatar.rotation.y = pose.heading;
    pedestrianGroup.add(avatar);
    pedestrianState.push({
      mesh: avatar,
      path,
      s,
      speed: path.speed * (0.85 + Math.random() * 0.3),
      phase: Math.random() * Math.PI * 2,
    });
  }
}

function updatePedestrians(dt) {
  for (const person of pedestrianState) {
    person.s = (person.s + person.speed * dt) % person.path.length;
    const pose = pointAlongPath(person.path.points, person.s);
    person.mesh.position.set(pose.x, elevationAt(pose.x, pose.z), pose.z);
    person.mesh.rotation.y = pose.heading;
    const swing = Math.sin(performance.now() * 0.008 + person.phase) * 0.4;
    person.mesh.userData.left.rotation.x = swing;
    person.mesh.userData.right.rotation.x = -swing;
  }
}

let treePartGeometries = null;

function createStreetTreeCanopyGeometry() {
  const lobes = [
    { x: 0, y: 0.08, z: 0, sx: 1.55, sy: 0.48, sz: 1.35, ry: 0.15 },
    { x: 0.62, y: 0.18, z: 0.28, sx: 1.05, sy: 0.38, sz: 0.95, ry: 0.95 },
    { x: -0.58, y: 0.12, z: -0.22, sx: 1.12, sy: 0.42, sz: 1.05, ry: -0.72 },
    { x: 0.18, y: 0.22, z: -0.55, sx: 0.92, sy: 0.36, sz: 0.88, ry: 1.35 },
    { x: -0.24, y: 0.28, z: 0.52, sx: 0.86, sy: 0.34, sz: 0.78, ry: -1.18 },
    { x: 0.44, y: 0.14, z: -0.42, sx: 1.18, sy: 0.4, sz: 1.02, ry: 2.05 },
  ];
  const parts = lobes.map((lobe) => {
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    geometry.scale(lobe.sx, lobe.sy, lobe.sz);
    geometry.rotateY(lobe.ry);
    geometry.translate(lobe.x, lobe.y, lobe.z);
    return geometry;
  });
  return mergeGeometries(parts);
}

function getTreePartGeometries() {
  if (treePartGeometries) return treePartGeometries;
  treePartGeometries = {
    trunk: new THREE.CylinderGeometry(0.18, 0.28, 1.65, 6),
    canopy: createStreetTreeCanopyGeometry(),
  };
  return treePartGeometries;
}

function createStreetTrees(roads) {
  if (treeGroup) {
    cityRoot.remove(treeGroup);
    treeGroup = null;
  }
  treeGroup = new THREE.Group();
  treeGroup.name = 'Real map street trees';
  cityRoot.add(treeGroup);
  const positions = [];
  const highwayTreeChance = {
    motorway: 0,
    trunk: 0,
    primary: 0.75,
    secondary: 0.9,
    tertiary: 1,
    residential: 1,
    living_street: 1,
    service: 0.5,
  };
  for (const road of roads) {
    if (!highwayTreeChance[road.highway]) continue;
    const points = roadPoints(road);
    let length = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
    }
    const spacing = road.highway === 'primary' || road.highway === 'secondary' ? 18 : 22;
    const count = Math.min(52, Math.floor(length / spacing));
    for (let c = 0; c < count; c += 1) {
      if (positions.length >= 820) break;
      const target = ((c + 0.5 + Math.random() * 0.3) / count) * length;
      let walked = 0;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const segLength = Math.hypot(b.x - a.x, b.z - a.z);
        if (walked + segLength >= target) {
          const t = segLength > 0 ? (target - walked) / segLength : 0;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len = Math.hypot(dx, dz) || 1;
          const side = c % 2 === 0 ? 1 : -1;
          const edgeOffset = roadHalfWidth(road) + 0.65;
          positions.push({ x: x - dz / len * side * edgeOffset, z: z + dx / len * side * edgeOffset, scale: 0.75 + Math.random() * 0.5 });
          break;
        }
        walked += segLength;
      }
    }
  }
  const parts = getTreePartGeometries();
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x6a4a33, roughness: 0.95, flatShading: true });
  const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0x4f7d4f, roughness: 0.9, flatShading: true });
  const trunks = new THREE.InstancedMesh(parts.trunk, trunkMaterial, positions.length);
  const canopies = new THREE.InstancedMesh(parts.canopy, canopyMaterial, positions.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i];
    const ground = elevationAt(position.x, position.z);
    const rotY = (i * 17) % 360 * (Math.PI / 180);
    dummy.position.set(position.x, ground + 0.82, position.z);
    dummy.scale.set(position.scale, position.scale, position.scale);
    dummy.rotation.set(0, rotY, 0);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(position.x, ground + 2.75, position.z);
    const canopyJitter = 0.88 + (i % 7) * 0.035;
    dummy.scale.set(
      position.scale * (0.94 + (i % 5) * 0.04) * canopyJitter,
      position.scale * (0.9 + (i % 4) * 0.05),
      position.scale * (0.96 + (i % 6) * 0.035) * canopyJitter,
    );
    dummy.rotation.set(0.04 + (i % 3) * 0.03, rotY + 0.35 + (i % 8) * 0.11, 0.02 - (i % 4) * 0.015);
    dummy.updateMatrix();
    canopies.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.28 + (i % 5) * 0.012, 0.38, 0.28 + (i % 4) * 0.04);
    canopies.setColorAt(i, color);
  }
  trunks.castShadow = true;
  trunks.receiveShadow = true;
  canopies.castShadow = true;
  canopies.instanceColor.needsUpdate = true;
  treeGroup.add(trunks, canopies);
}

function createStreetFurniture(roads) {
  if (furnitureGroup) {
    cityRoot.remove(furnitureGroup);
    furnitureGroup = null;
  }
  furnitureGroup = new THREE.Group();
  furnitureGroup.name = 'Real map street furniture';
  cityRoot.add(furnitureGroup);
  const spots = [];
  const classes = new Set(['primary', 'secondary', 'tertiary', 'residential', 'living_street']);
  for (const road of roads) {
    if (!classes.has(road.highway)) continue;
    const points = roadPoints(road);
    let length = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
    }
    const count = Math.min(22, Math.floor(length / 36));
    for (let c = 0; c < count && spots.length < 720; c += 1) {
      const target = ((c + 0.35 + Math.random() * 0.3) / count) * length;
      let walked = 0;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const segLength = Math.hypot(b.x - a.x, b.z - a.z);
        if (walked + segLength >= target) {
          const t = segLength > 0 ? (target - walked) / segLength : 0;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len = Math.hypot(dx, dz) || 1;
          const side = c % 2 === 0 ? 1 : -1;
          const kind = ((c + road.id) % 11);
          spots.push({
            x: x - dz / len * side * (roadHalfWidth(road) + 1.1),
            z: z + dx / len * side * (roadHalfWidth(road) + 1.1),
            heading: Math.atan2(dx, dz),
            kind,
          });
          break;
        }
        walked += segLength;
      }
    }
  }

  const benchGeometry = new THREE.BoxGeometry(1.2, 0.12, 0.5);
  const benchLegGeometry = new THREE.BoxGeometry(0.08, 0.5, 0.4);
  const lightPoleGeometry = new THREE.CylinderGeometry(0.06, 0.09, 3.6, 6);
  const lightHeadGeometry = new THREE.BoxGeometry(0.5, 0.12, 0.22);
  const hydrantGeometry = new THREE.CylinderGeometry(0.09, 0.13, 0.62, 6);
  const planterGeometry = new THREE.BoxGeometry(0.85, 0.55, 0.85);
  const trashGeometry = new THREE.CylinderGeometry(0.26, 0.22, 0.62, 8);
  const bicycleGeometry = new THREE.BoxGeometry(0.32, 0.72, 1.1);
  const signalPoleGeometry = new THREE.CylinderGeometry(0.05, 0.07, 3.2, 6);
  const signalHeadGeometry = new THREE.BoxGeometry(0.22, 0.58, 0.16);
  const benchMaterial = new THREE.MeshStandardMaterial({ color: 0x5b4a33, roughness: 0.85, flatShading: true });
  const benchLegMaterial = new THREE.MeshStandardMaterial({ color: 0x31383d, roughness: 0.6, metalness: 0.4, flatShading: true });
  const lightMaterial = new THREE.MeshStandardMaterial({ color: 0x2e3336, roughness: 0.5, metalness: 0.6, flatShading: true });
  const headMaterial = new THREE.MeshStandardMaterial({
    color: 0x22262a,
    emissive: 0x1a1713,
    emissiveIntensity: 0.35,
    roughness: 0.45,
  });
  streetLightMaterials.push(headMaterial);
  const hydrantMaterial = new THREE.MeshStandardMaterial({ color: 0xa33f3f, roughness: 0.55, metalness: 0.3, flatShading: true });
  const planterMaterial = new THREE.MeshStandardMaterial({ color: 0x6d5a45, roughness: 0.88, metalness: 0.02, flatShading: true });
  const trashMaterial = new THREE.MeshStandardMaterial({ color: 0x2f363a, roughness: 0.6, metalness: 0.35, flatShading: true });
  const bicycleMaterial = new THREE.MeshStandardMaterial({ color: 0x7a5b3c, roughness: 0.6, metalness: 0.18, flatShading: true });
  const signalPoleMaterial = new THREE.MeshStandardMaterial({ color: 0x2a3034, roughness: 0.55, metalness: 0.5, flatShading: true });
  const signalHeadMaterial = new THREE.MeshStandardMaterial({
    color: 0x181c1e,
    emissive: 0x331818,
    emissiveIntensity: 0.6,
    roughness: 0.35,
    metalness: 0.4,
  });
  const dummy = new THREE.Object3D();
  const benches = new THREE.InstancedMesh(benchGeometry, benchMaterial, spots.length);
  const benchLegs = new THREE.InstancedMesh(benchLegGeometry, benchLegMaterial, spots.length * 2);
  const lightPoles = new THREE.InstancedMesh(lightPoleGeometry, lightMaterial, spots.length);
  const lightHeads = new THREE.InstancedMesh(lightHeadGeometry, headMaterial, spots.length);
  const hydrants = new THREE.InstancedMesh(hydrantGeometry, hydrantMaterial, spots.length);
  const planters = new THREE.InstancedMesh(planterGeometry, planterMaterial, spots.length);
  const trashBins = new THREE.InstancedMesh(trashGeometry, trashMaterial, spots.length);
  const bicycles = new THREE.InstancedMesh(bicycleGeometry, bicycleMaterial, spots.length);
  const signalPoles = new THREE.InstancedMesh(signalPoleGeometry, signalPoleMaterial, spots.length);
  const signalHeads = new THREE.InstancedMesh(signalHeadGeometry, signalHeadMaterial, spots.length);
  let benchIndex = 0;
  let legIndex = 0;
  let lightIndex = 0;
  let hydrantIndex = 0;
  let planterIndex = 0;
  let trashIndex = 0;
  let bicycleIndex = 0;
  let signalIndex = 0;
  for (let s = 0; s < spots.length; s += 1) {
    const spot = spots[s];
    const kind = spot.kind;
    if (kind === 0 || kind === 1) {
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 0.55, spot.z);
      dummy.rotation.set(0, spot.heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      benches.setMatrixAt(benchIndex++, dummy.matrix);
      for (const offset of [-0.45, 0.45]) {
        const leg = new THREE.Object3D();
        leg.position.set(spot.x, elevationAt(spot.x, spot.z) + 0.25, spot.z + offset);
        leg.rotation.set(0, 0, 0);
        leg.scale.set(1, 1, 1);
        leg.updateMatrix();
        benchLegs.setMatrixAt(legIndex++, leg.matrix);
      }
    } else if (kind === 2 || kind === 3) {
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 1.8, spot.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      lightPoles.setMatrixAt(lightIndex, dummy.matrix);
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 3.72, spot.z);
      dummy.rotation.set(0, spot.heading, 0);
      dummy.updateMatrix();
      lightHeads.setMatrixAt(lightIndex, dummy.matrix);
      lightIndex += 1;
    } else if (kind === 4) {
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 0.31, spot.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      hydrants.setMatrixAt(hydrantIndex, dummy.matrix);
      hydrantIndex += 1;
    } else if (kind === 5) {
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 0.28, spot.z);
      dummy.rotation.set(0, spot.heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      planters.setMatrixAt(planterIndex++, dummy.matrix);
    } else if (kind === 6) {
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 0.31, spot.z);
      dummy.rotation.set(0, spot.heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      trashBins.setMatrixAt(trashIndex++, dummy.matrix);
    } else if (kind === 7 || kind === 8) {
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 1.6, spot.z);
      dummy.rotation.set(0, spot.heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      signalPoles.setMatrixAt(signalIndex, dummy.matrix);
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 3.42, spot.z);
      dummy.rotation.set(0, spot.heading, 0);
      dummy.updateMatrix();
      signalHeads.setMatrixAt(signalIndex, dummy.matrix);
      signalIndex += 1;
    } else {
      dummy.position.set(spot.x, elevationAt(spot.x, spot.z) + 0.36, spot.z);
      dummy.rotation.set(0, spot.heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      bicycles.setMatrixAt(bicycleIndex++, dummy.matrix);
    }
  }
  if (lightIndex) {
    lightPoles.count = lightIndex;
    lightHeads.count = lightIndex;
    lightPoles.instanceMatrix.needsUpdate = true;
    lightHeads.instanceMatrix.needsUpdate = true;
    furnitureGroup.add(lightPoles, lightHeads);
  }
  if (benchIndex) {
    benches.count = benchIndex;
    benchLegs.count = legIndex;
    benches.instanceMatrix.needsUpdate = true;
    benchLegs.instanceMatrix.needsUpdate = true;
    furnitureGroup.add(benches, benchLegs);
  }
  if (hydrantIndex) {
    hydrants.count = hydrantIndex;
    hydrants.instanceMatrix.needsUpdate = true;
    furnitureGroup.add(hydrants);
  }
  if (planterIndex) {
    planters.count = planterIndex;
    planters.instanceMatrix.needsUpdate = true;
    planters.castShadow = true;
    planters.receiveShadow = true;
    furnitureGroup.add(planters);
  }
  if (trashIndex) {
    trashBins.count = trashIndex;
    trashBins.instanceMatrix.needsUpdate = true;
    trashBins.castShadow = true;
    trashBins.receiveShadow = true;
    furnitureGroup.add(trashBins);
  }
  if (bicycleIndex) {
    bicycles.count = bicycleIndex;
    bicycles.instanceMatrix.needsUpdate = true;
    bicycles.castShadow = true;
    bicycles.receiveShadow = true;
    furnitureGroup.add(bicycles);
  }
  if (signalIndex) {
    signalPoles.count = signalIndex;
    signalHeads.count = signalIndex;
    signalPoles.instanceMatrix.needsUpdate = true;
    signalHeads.instanceMatrix.needsUpdate = true;
    signalPoles.castShadow = true;
    signalHeads.castShadow = true;
    furnitureGroup.add(signalPoles, signalHeads);
  }
}

function createHillVegetation(regionPoints) {
  if (hillVegetationGroup) {
    cityRoot.remove(hillVegetationGroup);
    hillVegetationGroup = null;
  }
  hillVegetationGroup = new THREE.Group();
  hillVegetationGroup.name = 'Real map hill vegetation';
  cityRoot.add(hillVegetationGroup);
  const flat = flatRegion();
  const bounds = bboxOfPoints(regionPoints);
  const spots = [];
  const random = (seed) => {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  };
  let guard = 0;
  while (spots.length < 7600 && guard < 180000) {
    guard += 1;
    const seed = guard * 7919;
    const x = bounds.minX + random(seed) * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + random(seed + 17) * (bounds.maxZ - bounds.minZ);
    if (!pointInFlatRing({ x, z }, flat)) continue;
    const elevation = elevationAt(x, z);
    if (elevation < 32) continue;
    const boxes = collisionBoxesNear(x, z, 2.2);
    let blocked = false;
    for (const box of boxes) {
      const cx = THREE.MathUtils.clamp(x, box.min.x, box.max.x);
      const cz = THREE.MathUtils.clamp(z, box.min.z, box.max.z);
      if (Math.hypot(x - cx, z - cz) < 2.2) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const kind = random(seed + 31) > 0.12 ? 'tree' : 'rock';
    spots.push({
      x,
      z,
      elevation,
      kind,
      scale: kind === 'tree' ? 0.42 + random(seed + 43) * 1.25 : 0.4 + random(seed + 51) * 1.1,
      layer: random(seed + 57) > 0.5 ? 'under' : 'main',
      grass: kind === 'tree' && random(seed + 71) > 0.5,
    });
  }
  const parts = getTreePartGeometries();
  const grassGeometry = new THREE.ConeGeometry(0.28, 0.7, 5);
  const rockGeometry = new THREE.DodecahedronGeometry(0.9, 0);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x5f4633, roughness: 0.95, flatShading: true });
  const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0x3f6b45, roughness: 0.92, flatShading: true });
  const grassMaterial = new THREE.MeshStandardMaterial({ color: 0x6d8a4e, roughness: 0.95, flatShading: true });
  const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x7c7b73, roughness: 0.9, flatShading: true });
  const trees = spots.filter((spot) => spot.kind === 'tree');
  const rocks = spots.filter((spot) => spot.kind === 'rock');
  const grasses = spots.filter((spot) => spot.grass);
  const trunks = new THREE.InstancedMesh(parts.trunk, trunkMaterial, trees.length);
  const canopies = new THREE.InstancedMesh(parts.canopy, canopyMaterial, trees.length);
  const grassMeshes = new THREE.InstancedMesh(grassGeometry, grassMaterial, grasses.length);
  const rockMeshes = new THREE.InstancedMesh(rockGeometry, rockMaterial, rocks.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < trees.length; i += 1) {
    const spot = trees[i];
    const rotY = random(i + 9) * Math.PI;
    dummy.position.set(spot.x, spot.elevation + 0.82, spot.z);
    dummy.scale.setScalar(spot.scale);
    dummy.rotation.set(0, rotY, 0);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(spot.x, spot.elevation + 2.85, spot.z);
    dummy.scale.set(spot.scale * 1.04, spot.scale * 0.92, spot.scale * 1.06);
    dummy.rotation.set(0.05, rotY + 0.35, 0.03);
    dummy.updateMatrix();
    canopies.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.28 + random(i) * 0.06, 0.38, 0.28 + random(i + 3) * 0.1);
    canopies.setColorAt(i, color);
  }
  let grassIndex = 0;
  for (const spot of grasses) {
    dummy.position.set(spot.x + (random(spot.x * 3) - 0.5) * 0.8, spot.elevation + 0.28, spot.z + (random(spot.z * 5) - 0.5) * 0.8);
    dummy.scale.setScalar(spot.scale * 0.8);
    dummy.rotation.set(random(spot.x + 21) * 0.5, random(spot.z + 23) * Math.PI, random(spot.x + 29) * 0.4);
    dummy.updateMatrix();
    grassMeshes.setMatrixAt(grassIndex, dummy.matrix);
    color.setHSL(0.26 + random(spot.x + spot.z) * 0.08, 0.4, 0.36 + random(spot.x + 7) * 0.12);
    grassMeshes.setColorAt(grassIndex, color);
    grassIndex += 1;
  }
  for (let i = 0; i < rocks.length; i += 1) {
    const spot = rocks[i];
    dummy.position.set(spot.x, spot.elevation + 0.35, spot.z);
    dummy.scale.set(spot.scale, spot.scale * 0.7, spot.scale * 0.8);
    dummy.rotation.set(random(i + 5) * 0.4, random(i + 7) * Math.PI, random(i + 13) * 0.4);
    dummy.updateMatrix();
    rockMeshes.setMatrixAt(i, dummy.matrix);
  }
  trunks.castShadow = true;
  trunks.receiveShadow = true;
  canopies.castShadow = true;
  canopies.instanceColor.needsUpdate = true;
  grassMeshes.castShadow = true;
  grassMeshes.receiveShadow = true;
  rockMeshes.castShadow = true;
  rockMeshes.receiveShadow = true;
  hillVegetationGroup.add(trunks, canopies, grassMeshes, rockMeshes);
}

function createBuildingDoorways(buildings) {
  if (doorwayGroup) {
    cityRoot.remove(doorwayGroup);
    doorwayGroup = null;
  }
  doorwayGroup = new THREE.Group();
  doorwayGroup.name = 'Real map building doorways';
  cityRoot.add(doorwayGroup);
  const doorMaterial = new THREE.MeshStandardMaterial({
    color: 0x2c2620,
    roughness: 0.62,
    metalness: 0.08,
  });
  const lintelMaterial = new THREE.MeshStandardMaterial({
    color: 0x6b5a48,
    roughness: 0.7,
    metalness: 0.05,
  });
  const doorGeometry = new THREE.PlaneGeometry(1.05, 2.15);
  const lintelGeometry = new THREE.BoxGeometry(1.3, 0.14, 0.18);
  let count = 0;
  for (const building of buildings) {
    if (!building.points || building.points.length < 6) continue;
    const points = buildingFootprintPoints(building);
    const entrance = buildingEntrancePoint(building);
    if (!entrance) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    const center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    const dx = entrance.x - center.x;
    const dz = entrance.z - center.z;
    const length = Math.hypot(dx, dz) || 1;
    const face = { x: dx / length, z: dz / length };
    const groundY = buildingGroundY(building);
    const door = new THREE.Mesh(doorGeometry, doorMaterial);
    door.position.set(
      entrance.x - face.x * 0.28,
      groundY + 1.08,
      entrance.z - face.z * 0.28,
    );
    door.rotation.y = Math.atan2(face.x, face.z);
    door.castShadow = true;
    doorwayGroup.add(door);
    const lintel = new THREE.Mesh(lintelGeometry, lintelMaterial);
    lintel.position.set(
      entrance.x - face.x * 0.28,
      groundY + 2.22,
      entrance.z - face.z * 0.28,
    );
    lintel.rotation.y = Math.atan2(face.x, face.z);
    lintel.castShadow = true;
    doorwayGroup.add(lintel);
    count += 1;
    if (count >= 1600) break;
  }
}

function createStreetfrontDetails(buildings) {
  if (streetfrontGroup) {
    cityRoot.remove(streetfrontGroup);
    streetfrontGroup = null;
  }
  streetfrontGroup = new THREE.Group();
  streetfrontGroup.name = 'Real map streetfront details';
  cityRoot.add(streetfrontGroup);
  const awningMaterial = new THREE.MeshStandardMaterial({
    color: 0xc56a4a,
    roughness: 0.78,
    metalness: 0.02,
  });
  const signMaterial = new THREE.MeshStandardMaterial({
    color: 0x22262a,
    roughness: 0.5,
    metalness: 0.1,
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x27424e,
    roughness: 0.18,
    metalness: 0.4,
    transparent: true,
    opacity: 0.82,
  });
  const handleMaterial = new THREE.MeshStandardMaterial({
    color: 0x9aa2a6,
    roughness: 0.32,
    metalness: 0.72,
  });
  const tableTopMaterial = new THREE.MeshStandardMaterial({
    color: 0x7a6754,
    roughness: 0.8,
    metalness: 0.03,
  });
  const tableLegMaterial = new THREE.MeshStandardMaterial({
    color: 0x33383c,
    roughness: 0.5,
    metalness: 0.5,
  });
  const chairMaterial = new THREE.MeshStandardMaterial({
    color: 0x565044,
    roughness: 0.78,
    metalness: 0.02,
  });
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 128;
  signCanvas.height = 32;
  const signContext = signCanvas.getContext('2d');
  const signTexture = new THREE.CanvasTexture(signCanvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;
  signTexture.needsUpdate = true;
  let count = 0;
  for (const building of buildings) {
    if (!building.points || building.points.length < 6) continue;
    const entrance = buildingEntrancePoint(building);
    if (!entrance) continue;
    const points = buildingFootprintPoints(building);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    const center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    const dx = entrance.x - center.x;
    const dz = entrance.z - center.z;
    const length = Math.hypot(dx, dz) || 1;
    const face = { x: dx / length, z: dz / length };
    const normal = { x: -face.z, z: face.x };
    const width = Math.min(5.5, Math.max(2.2, (maxX - minX) * 0.55));
    const groundY = buildingGroundY(building);
    const entranceX = entrance.x - face.x * 0.28;
    const entranceZ = entrance.z - face.z * 0.28;

    const awning = new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, 1.1), awningMaterial);
    awning.position.set(entranceX + face.x * 0.72, groundY + 2.45, entranceZ + face.z * 0.72);
    awning.rotation.y = Math.atan2(face.x, face.z);
    awning.castShadow = true;
    streetfrontGroup.add(awning);

    const storefront = new THREE.Mesh(new THREE.BoxGeometry(width * 0.86, 1.35, 0.12), glassMaterial);
    storefront.position.set(
      entranceX + face.x * 0.2,
      groundY + 1.15,
      entranceZ + face.z * 0.2,
    );
    storefront.rotation.y = Math.atan2(face.x, face.z);
    streetfrontGroup.add(storefront);

    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.05), handleMaterial);
    handle.position.set(
      entranceX + normal.x * 0.5 + face.x * 0.42,
      groundY + 1.2,
      entranceZ + normal.z * 0.5 + face.z * 0.42,
    );
    handle.rotation.y = Math.atan2(face.x, face.z);
    streetfrontGroup.add(handle);

    if ((count % 2) === 0) {
      const tableX = entranceX + normal.x * width * 0.42 + face.x * 1.5;
      const tableZ = entranceZ + normal.z * width * 0.42 + face.z * 1.5;
      const table = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.06, 0.85), tableTopMaterial);
      table.position.set(tableX, groundY + 0.72, tableZ);
      table.rotation.y = Math.atan2(face.x, face.z);
      table.castShadow = true;
      streetfrontGroup.add(table);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.72, 6), tableLegMaterial);
      leg.position.set(tableX, groundY + 0.36, tableZ);
      streetfrontGroup.add(leg);
      for (const [cx, cz] of [[0.5, 0.35], [-0.5, 0.35]]) {
        const chair = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), chairMaterial);
        chair.position.set(tableX + normal.x * cx * 0.9, groundY + 0.42, tableZ + normal.z * cx * 0.9 + face.z * cz);
        chair.rotation.y = Math.atan2(face.x, face.z);
        chair.castShadow = true;
        streetfrontGroup.add(chair);
      }
    }

    signContext.fillStyle = '#f0e9d8';
    signContext.fillRect(0, 0, 128, 32);
    signContext.fillStyle = '#4a3d2f';
    signContext.font = 'bold 20px sans-serif';
    signContext.textAlign = 'center';
    const name = (building.name || 'SF').slice(0, 14).toUpperCase();
    signContext.fillText(name || 'SF', 64, 22);
    signTexture.needsUpdate = true;
    const signMaterialWithMap = signMaterial.clone();
    signMaterialWithMap.map = signTexture;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.62, 0.55), signMaterialWithMap);
    sign.position.set(
      entranceX + normal.x * width * 0.22 + face.x * 0.12,
      groundY + 2.95,
      entranceZ + normal.z * width * 0.22 + face.z * 0.12,
    );
    sign.rotation.y = Math.atan2(face.x, face.z);
    streetfrontGroup.add(sign);
    count += 1;
    if (count >= 600) break;
  }
}

function createRooftopDetails(buildings) {
  if (rooftopGroup) {
    cityRoot.remove(rooftopGroup);
    rooftopGroup = null;
  }
  rooftopGroup = new THREE.Group();
  rooftopGroup.name = 'Real map rooftop details';
  cityRoot.add(rooftopGroup);
  const candidates = [];
  for (const building of buildings) {
    const height = Number(building.height) || 0;
    if (height < 5 || !building.points || building.points.length < 6) continue;
    const points = buildingFootprintPoints(building);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    const width = maxX - minX;
    const depth = maxZ - minZ;
    if (width < 4 || depth < 4) continue;
    candidates.push({
      x: (minX + maxX) / 2,
      z: (minZ + maxZ) / 2,
      y: buildingGroundY(building) + height,
      scale: 0.7 + ((Number(building.id) || 0) % 10) / 12,
      kind: (Number(building.id) || 0) % 3,
    });
  }
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const tankGeometry = new THREE.CylinderGeometry(0.5, 0.55, 1, 8);
  const boxMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a5155,
    roughness: 0.78,
    metalness: 0.28,
    flatShading: true,
  });
  const tankMaterial = new THREE.MeshStandardMaterial({
    color: 0x6a6258,
    roughness: 0.62,
    metalness: 0.45,
    flatShading: true,
  });
  const boxes = new THREE.InstancedMesh(boxGeometry, boxMaterial, candidates.length);
  const tanks = new THREE.InstancedMesh(tankGeometry, tankMaterial, candidates.length);
  const dummy = new THREE.Object3D();
  let boxIndex = 0;
  let tankIndex = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const kind = candidate.kind;
    if (kind === 0 || kind === 1) {
      dummy.position.set(
        candidate.x + ((i % 3) - 1) * candidate.scale * 1.8,
        candidate.y + 1.1,
        candidate.z + ((i % 2) * 2 - 1) * candidate.scale * 1.4,
      );
      dummy.scale.set(candidate.scale * 3.2, candidate.scale * 1.6, candidate.scale * 2.4);
      dummy.rotation.set(0, (i % 4) * 0.31, 0);
      dummy.updateMatrix();
      boxes.setMatrixAt(boxIndex++, dummy.matrix);
    } else {
      dummy.position.set(candidate.x, candidate.y + 1.3, candidate.z);
      dummy.scale.set(candidate.scale * 1.7, candidate.scale * 1.4, candidate.scale * 1.7);
      dummy.rotation.set(0, (i % 6) * 0.22, 0);
      dummy.updateMatrix();
      tanks.setMatrixAt(tankIndex++, dummy.matrix);
    }
  }
  if (boxIndex) {
    boxes.count = boxIndex;
    boxes.instanceMatrix.needsUpdate = true;
    boxes.castShadow = true;
    boxes.receiveShadow = true;
    rooftopGroup.add(boxes);
  }
  if (tankIndex) {
    tanks.count = tankIndex;
    tanks.instanceMatrix.needsUpdate = true;
    tanks.castShadow = true;
    tanks.receiveShadow = true;
    rooftopGroup.add(tanks);
  }
  rooftopGroup.userData = { boxes: boxIndex, tanks: tankIndex };
}

function nearestVehicle(position) {
  if (!trafficState) return null;
  let best = null;
  let bestDistance = 260;
  for (let i = 0; i < trafficState.vehicles.length; i += 1) {
    const vehicle = trafficState.vehicles[i];
    const distance = Math.hypot(vehicle.mesh.position.x - position.x, vehicle.mesh.position.z - position.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { index: i, vehicle, distance };
    }
  }
  return best;
}

function distanceToPolygon(point, points) {
  let bestDistance = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq)) : 0;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    bestDistance = Math.min(bestDistance, Math.hypot(point.x - px, point.z - pz));
  }
  return bestDistance;
}

function buildingFootprintPoints(building) {
  const points = [];
  for (let i = 0; i < building.points.length; i += 2) {
    points.push({ x: building.points[i], z: building.points[i + 1] });
  }
  return points;
}

function nearestEnterableBuilding(position, radius = 4.2) {
  let best = null;
  let bestDistance = radius;
  for (const mesh of detailBuildingMeshes) {
    const building = mesh.userData?.building;
    if (!building?.points) continue;
    const points = buildingFootprintPoints(building);
    const distance = distanceToPolygon(position, points);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { building, mesh, distance, points };
    }
  }
  return best;
}

function buildingEntrancePoint(building) {
  const points = buildingFootprintPoints(building);
  if (!points.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  let best = null;
  let bestDistance = Infinity;
  for (const point of points) {
    const distance = Math.hypot(point.x - center.x, point.z - center.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  if (!best) return null;
  const dx = best.x - center.x;
  const dz = best.z - center.z;
  const length = Math.hypot(dx, dz) || 1;
  return {
    x: best.x + (dx / length) * 2.6,
    z: best.z + (dz / length) * 2.6,
  };
}

function interiorMaterials() {
  return {
    floor: null,
    wall: null,
    ceiling: null,
    wood: null,
    metal: null,
    accent: null,
    counter: null,
    soft: null,
  };
}

function interiorArchetypeFor(building) {
  const text = [
    building?.amenity,
    building?.building,
    building?.name,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/cafe|coffee|restaurant|bar|bakery|fast_food/.test(text)) return 'cafe';
  if (/office|bank|financial|government|library|hospital|civic/.test(text)) return 'office';
  if (/market|supermarket|retail|shop|store|mall/.test(text)) return 'market';
  if (/residential|house|apartment|home|yes/.test(text)) return 'rowhouse';
  const hash = (Number(building?.id) || 0) % 4;
  return ['cafe', 'office', 'rowhouse', 'market'][hash];
}

const INTERIOR_ARCHETYPES = {
  cafe: {
    floor: 0x9a7d5d,
    wall: 0xe6dfcf,
    ceiling: 0xd9d2c2,
    wood: 0x7a4d2f,
    metal: 0x2e3336,
    accent: 0xb34b36,
    counter: 0x8a5a35,
    soft: 0xd9a05a,
    light: 0xffd9a0,
    warm: 0xffb46b,
  },
  office: {
    floor: 0x8b929b,
    wall: 0xe7ebee,
    ceiling: 0xdfe4e8,
    wood: 0x5f5148,
    metal: 0x3a4249,
    accent: 0x4b718f,
    counter: 0x6f645c,
    soft: 0x7fa4b8,
    light: 0xdff1f7,
    warm: 0x9fc4d8,
  },
  rowhouse: {
    floor: 0xb08a63,
    wall: 0xe8dcc6,
    ceiling: 0xe1d5c0,
    wood: 0x6a4f36,
    metal: 0x3d3a35,
    accent: 0x8a6f4d,
    counter: 0x7d5c3d,
    soft: 0xd4b98a,
    light: 0xffdfa8,
    warm: 0xf2bd78,
  },
  market: {
    floor: 0xaa9a7d,
    wall: 0xf0e7d4,
    ceiling: 0xe7dcc6,
    wood: 0x7a5a35,
    metal: 0x45423b,
    accent: 0x7d6d4a,
    counter: 0x8c6a3d,
    soft: 0xd8b24f,
    light: 0xffe6b0,
    warm: 0xe0b96a,
  },
};

function setInteriorMaterials(materials, archetype) {
  const config = INTERIOR_ARCHETYPES[archetype] || INTERIOR_ARCHETYPES.cafe;
  materials.floor = new THREE.MeshStandardMaterial({ color: config.floor, roughness: 0.85, metalness: 0.02 });
  materials.wall = new THREE.MeshStandardMaterial({ color: config.wall, roughness: 0.92, metalness: 0.01 });
  materials.ceiling = new THREE.MeshStandardMaterial({ color: config.ceiling, roughness: 0.95 });
  materials.wood = new THREE.MeshStandardMaterial({ color: config.wood, roughness: 0.8, metalness: 0.02 });
  materials.metal = new THREE.MeshStandardMaterial({ color: config.metal, roughness: 0.5, metalness: 0.6 });
  materials.accent = new THREE.MeshStandardMaterial({ color: config.accent, roughness: 0.7, metalness: 0.02 });
  materials.counter = new THREE.MeshStandardMaterial({ color: config.counter, roughness: 0.82, metalness: 0.02 });
  materials.soft = new THREE.MeshStandardMaterial({ color: config.soft, roughness: 0.9, metalness: 0.01 });
  return config;
}

function addInteriorShell(group, width, depth, materials) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), materials.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.08;
  floor.receiveShadow = true;
  group.add(floor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), materials.ceiling);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 3.0;
  group.add(ceiling);
  const wallArray = [materials.wall];
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.0, depth), wallArray[0]);
  leftWall.position.set(-width / 2, 1.5, 0);
  leftWall.castShadow = true;
  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.0, depth), wallArray[0]);
  rightWall.position.set(width / 2, 1.5, 0);
  rightWall.castShadow = true;
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(width, 3.0, 0.16), wallArray[0]);
  backWall.position.set(0, 1.5, -depth / 2);
  backWall.castShadow = true;
  const frontLeft = new THREE.Mesh(new THREE.BoxGeometry(width * 0.5, 3.0, 0.16), wallArray[0]);
  frontLeft.position.set(-width * 0.25, 1.5, depth / 2);
  frontLeft.castShadow = true;
  const frontRight = new THREE.Mesh(new THREE.BoxGeometry(width * 0.5, 3.0, 0.16), wallArray[0]);
  frontRight.position.set(width * 0.25, 1.5, depth / 2);
  frontRight.castShadow = true;
  group.add(leftWall, rightWall, backWall, frontLeft, frontRight);
}

function addInteriorLight(group, config, position = null) {
  const light = new THREE.PointLight(config.light, 18, 10, 1.6);
  light.position.set(position?.[0] ?? 0, position?.[1] ?? 2.7, position?.[2] ?? 0);
  light.castShadow = true;
  group.add(light);
  return light;
}

function addBox(group, geometry, material, x, y, z, rotation = null) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  if (rotation) mesh.rotation.y = rotation;
  mesh.castShadow = true;
  group.add(mesh);
  return mesh;
}

function interiorResidentPalette(seed) {
  const palettes = [
    { top: 0x3f6f8f, bottom: 0x2f3a44, skin: 0xd9a37e },
    { top: 0x9d4f46, bottom: 0x27313a, skin: 0x8d5f43 },
    { top: 0x5b7a63, bottom: 0x333c45, skin: 0xf0c8a0 },
    { top: 0x8a5a2b, bottom: 0x2d2f31, skin: 0xe8b48f },
  ];
  return palettes[Math.abs(seed) % palettes.length];
}

function createInteriorResident(seed, archetype) {
  const group = new THREE.Group();
  const palette = interiorResidentPalette(seed);
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: palette.top, roughness: 0.78, flatShading: true });
  const legMaterial = new THREE.MeshStandardMaterial({ color: palette.bottom, roughness: 0.85, flatShading: true });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.65 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.5, 0.22), bodyMaterial);
  body.position.y = 0.82;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), skinMaterial);
  head.position.y = 1.25;
  head.castShadow = true;
  const legs = new THREE.Group();
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.42, 0.14), legMaterial);
  left.position.set(-0.09, 0.21, 0);
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.42, 0.14), legMaterial);
  right.position.set(0.09, 0.21, 0);
  legs.add(left, right);
  group.add(body, head, legs);
  const roles = archetype === 'cafe' ? ['Barista', 'Regular']
    : archetype === 'office' ? ['Analyst', 'Receptionist', 'Director']
      : archetype === 'market' ? ['Stock clerk', 'Shopper', 'Cashier']
        : ['Resident', 'Neighbor', 'Lodger'];
  const actions = ['working', 'reading', 'chatting', 'serving', 'stocking', 'resting'];
  const role = roles[Math.abs(seed) % roles.length];
  const action = actions[Math.abs(seed * 3 + 7) % actions.length];
  group.userData = {
    type: 'interior-resident',
    role,
    action,
    mood: Math.abs(seed * 7 + 3) % 4 === 0 ? 'focused' : Math.abs(seed * 7 + 3) % 4 === 1 ? 'pleasant' : 'busy',
    choice: `${action} in the ${archetype} room`,
    schedule: ['morning', 'midday', 'evening', 'late-night'][Math.abs(seed * 5 + 13) % 4],
    phase: (seed % 1000) / 1000,
  };
  return group;
}

function interiorResidentPosition(width, depth, seed, index) {
  const x = -width * 0.3 + ((seed % 7) / 7) * width * 0.6;
  const z = -depth * 0.2 + (((seed * 3 + index * 7) % 9) / 9) * depth * 0.6;
  return { x, z };
}

function addInteriorResidents(group, width, depth, archetype, building) {
  const count = archetype === 'office' || archetype === 'market' ? 3 : 2;
  const residents = [];
  const seedBase = Number(building?.id) || 0;
  for (let i = 0; i < count; i += 1) {
    const seed = seedBase + i * 131;
    const avatar = createInteriorResident(seed, archetype);
    const position = interiorResidentPosition(width, depth, seed, i);
    avatar.position.set(position.x, 0.04, position.z);
    avatar.rotation.y = ((seed % 360) / 360) * Math.PI * 2;
    group.add(avatar);
    residents.push({ mesh: avatar, baseX: position.x, baseZ: position.z });
  }
  return residents;
}

function updateInteriorResidents(dt) {
  for (const resident of interiorResidents) {
    const data = resident.mesh.userData;
    const visible = residentScheduleActive(data.schedule, timeOfDay);
    resident.mesh.visible = visible;
    if (!visible) continue;
    const swing = Math.sin(performance.now() * 0.0012 + data.phase * Math.PI * 2) * 0.08;
    resident.mesh.rotation.y += dt * 0.05;
    resident.mesh.position.x = resident.baseX + Math.cos(performance.now() * 0.0006 + data.phase * 8) * 0.12;
    resident.mesh.position.z = resident.baseZ + Math.sin(performance.now() * 0.0006 + data.phase * 8) * 0.1;
    resident.mesh.position.y = 0.04 + Math.max(0, swing);
  }
}

function residentScheduleActive(schedule, timeOfDay) {
  if (!schedule) return true;
  if (schedule === 'morning') return timeOfDay === 'day' || timeOfDay === 'dawn';
  if (schedule === 'midday') return timeOfDay === 'day' || timeOfDay === 'dusk';
  if (schedule === 'evening') return timeOfDay === 'dusk' || timeOfDay === 'night';
  if (schedule === 'late-night') return timeOfDay === 'night' || timeOfDay === 'dawn';
  return true;
}

function createGeneratedInterior(building) {
  const points = buildingFootprintPoints(building);
  if (!points.length) return null;
  const bounds = points.reduce((acc, point) => ({
    minX: Math.min(acc.minX, point.x),
    maxX: Math.max(acc.maxX, point.x),
    minZ: Math.min(acc.minZ, point.z),
    maxZ: Math.max(acc.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const width = Math.min(9, Math.max(4, bounds.maxX - bounds.minX));
  const depth = Math.min(9, Math.max(4, bounds.maxZ - bounds.minZ));
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const floorY = Math.min(
    ...points.map((point) => elevationAt(point.x, point.z)),
  );
  const group = new THREE.Group();
  group.position.set(centerX, floorY, centerZ);
  const materials = interiorMaterials();
  const archetype = interiorArchetypeFor(building);
  const config = setInteriorMaterials(materials, archetype);
  addInteriorShell(group, width, depth, materials);
  const halfW = width / 2;
  const halfD = depth / 2;

  if (archetype === 'cafe') {
    const counter = addBox(group, new THREE.BoxGeometry(2.2, 1.0, 0.75), materials.counter, -halfW * 0.55, 1.0, -halfD * 0.35);
    addBox(group, new THREE.BoxGeometry(2.4, 0.07, 0.95), materials.accent, counter.position.x, 1.53, counter.position.z);
    addBox(group, new THREE.BoxGeometry(0.42, 0.72, 0.42), materials.metal, -halfW * 0.55, 0.8, -halfD * 0.05);
    for (const [x, z] of [[halfW * 0.25, halfD * 0.1], [halfW * 0.25, -halfD * 0.35]]) {
      addBox(group, new THREE.BoxGeometry(0.85, 0.08, 0.85), materials.wood, x, 0.66, z);
      addBox(group, new THREE.BoxGeometry(0.85, 0.5, 0.08), materials.metal, x, 1.05, z - 0.45);
    }
    addBox(group, new THREE.BoxGeometry(0.05, 0.3, 1.5), materials.soft, -halfW * 0.15, 2.0, -halfD * 0.7, Math.PI * 0.5);
    addBox(group, new THREE.CylinderGeometry(0.09, 0.12, 0.95, 8), materials.metal, -halfW * 0.7, 0.95, halfD * 0.35);
    addBox(group, new THREE.ConeGeometry(0.26, 0.28, 8), materials.accent, -halfW * 0.7, 1.5, halfD * 0.35);
  } else if (archetype === 'office') {
    addBox(group, new THREE.BoxGeometry(1.5, 0.75, 0.72), materials.wood, halfW * 0.2, 0.75, halfD * 0.3);
    addBox(group, new THREE.BoxGeometry(0.42, 0.55, 0.08), materials.metal, halfW * 0.2, 1.2, halfD * 0.3 + 0.45);
    addBox(group, new THREE.BoxGeometry(0.42, 0.08, 0.42), materials.metal, halfW * 0.2, 0.78, halfD * 0.3 + 0.42);
    addBox(group, new THREE.BoxGeometry(width * 0.72, 0.08, 0.4), materials.wood, 0, 2.05, -halfD * 0.6);
    addBox(group, new THREE.PlaneGeometry(1.1, 0.85), new THREE.MeshStandardMaterial({ color: 0x6a8f9f, roughness: 0.6 }), -halfW * 0.25, 2.2, -halfD / 2 + 0.09);
    addBox(group, new THREE.BoxGeometry(0.5, 1.6, 0.4), materials.accent, -halfW * 0.65, 1.05, halfD * 0.2);
  } else if (archetype === 'rowhouse') {
    addBox(group, new THREE.BoxGeometry(1.6, 0.28, 0.9), materials.wood, -halfW * 0.3, 0.55, halfD * 0.2);
    addBox(group, new THREE.BoxGeometry(1.2, 0.28, 0.9), materials.wood, halfW * 0.25, 0.55, -halfD * 0.25);
    addBox(group, new THREE.BoxGeometry(0.7, 0.08, 0.35), materials.accent, -halfW * 0.3, 0.69, halfD * 0.2);
    addBox(group, new THREE.BoxGeometry(0.55, 0.08, 0.35), materials.accent, halfW * 0.25, 0.69, -halfD * 0.25);
    addBox(group, new THREE.BoxGeometry(width * 0.6, 0.08, 0.35), materials.wood, 0, 2.1, -halfD * 0.62);
    addBox(group, new THREE.BoxGeometry(0.75, 0.7, 0.75), materials.soft, -halfW * 0.55, 0.9, -halfD * 0.2);
  } else {
    addBox(group, new THREE.BoxGeometry(2.4, 1.0, 0.8), materials.counter, -halfW * 0.35, 1.0, -halfD * 0.2);
    addBox(group, new THREE.BoxGeometry(2.6, 0.07, 1.0), materials.accent, -halfW * 0.35, 1.53, -halfD * 0.2);
    addBox(group, new THREE.BoxGeometry(width * 0.7, 1.0, 0.35), materials.wood, 0, 1.4, halfD * 0.3);
    addBox(group, new THREE.BoxGeometry(0.9, 1.2, 0.35), materials.soft, halfW * 0.4, 1.3, -halfD * 0.35);
    addBox(group, new THREE.BoxGeometry(0.42, 0.72, 0.42), materials.metal, -halfW * 0.35, 0.8, halfD * 0.15);
  }

  addInteriorLight(group, config);
  interiorResidents = addInteriorResidents(group, width, depth, archetype, building);
  group.userData.residents = interiorResidents;

  group.userData = {
    type: 'interior',
    building,
    archetype,
    residents: interiorResidents,
    centerX,
    centerZ,
    floorY,
    heading: Math.atan2(centerX, centerZ),
  };
  return group;
}

function enterNearestBuilding() {
  if (interiorState || !playerState) return false;
  const nearest = nearestEnterableBuilding(playerState);
  if (!nearest) return false;
  const room = createGeneratedInterior(nearest.building);
  if (!room) return false;
  const archetype = room.userData.archetype;
  interiorResidents = room.userData.residents || [];
  interiorGroup = room;
  cityRoot.add(interiorGroup);
  const data = room.userData;
  interiorState = {
    building: nearest.building,
    archetype,
    room,
    entrance: {
      x: playerState.x,
      z: playerState.z,
    },
    yaw: playerYaw,
  };
  interiorLight = room.children.find((child) => child.isPointLight) || null;
  if (document.pointerLockElement) document.exitPointerLock();
  pointerLockActive = false;
  cityMode = 'interior';
  if (playerAvatarGroup) playerAvatarGroup.visible = false;
  camera.position.set(data.centerX, data.floorY + 1.55, data.centerZ - 1.7);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(-0.08, Math.atan2(0, 1), 0);
  updateCityReadout();
  return true;
}

function exitInterior() {
  if (!interiorState) return false;
  if (interiorGroup) {
    cityRoot.remove(interiorGroup);
    interiorGroup = null;
  }
  interiorLight = null;
  interiorResidents = [];
  cityMode = 'walk';
  if (playerAvatarGroup) playerAvatarGroup.visible = true;
  const entrance = interiorState.entrance;
  const resolved = resolvePlayerPosition(entrance.x, entrance.z, 0.5);
  playerState.x = resolved.x;
  playerState.z = resolved.z;
  playerYaw = interiorState.yaw;
  playerState.yaw = playerYaw;
  interiorState = null;
  updateCityReadout();
  return true;
}

function setCityMode(mode) {
  if (mode !== 'interior' && interiorState) exitInterior();
  if (mode === 'interior') {
    return enterNearestBuilding();
  }
  if (mode === 'drive') {
    if (!playerState || !trafficState?.vehicles.length) return false;
    const nearest = nearestVehicle(playerState);
    if (!nearest) return false;
    if (driveIndex >= 0 && driveIndex !== nearest.index) {
      trafficState.vehicles[driveIndex].manual = false;
    }
    driveIndex = nearest.index;
    trafficState.vehicles[driveIndex].manual = true;
    cityMode = 'drive';
  } else if (mode === 'walk') {
    if (driveIndex >= 0 && trafficState?.vehicles[driveIndex]) {
      trafficState.vehicles[driveIndex].manual = false;
      driveIndex = -1;
    }
    if (!playerState) {
      const centroid = polygonCentroid(region);
      initPlayer({ x: centroid.x, z: centroid.z });
    }
    // Face along the nearest OSM road so street beauty frames see a canyon,
    // not empty water or the back of a block.
    const paths = trafficState?.paths || [];
    if (playerState && paths.length) {
      let best = null;
      let bestDist = Infinity;
      for (const path of paths) {
        for (let i = 0; i < path.points.length - 1; i += 1) {
          const a = path.points[i];
          const b = path.points[i + 1];
          const midX = (a.x + b.x) * 0.5;
          const midZ = (a.z + b.z) * 0.5;
          const dist = Math.hypot(midX - playerState.x, midZ - playerState.z);
          if (dist < bestDist) {
            bestDist = dist;
            best = { a, b, midX, midZ };
          }
        }
      }
      if (best) {
        playerState.x = best.midX;
        playerState.z = best.midZ;
        playerYaw = Math.atan2(best.b.x - best.a.x, best.b.z - best.a.z);
        playerState.yaw = playerYaw;
        playerPitch = -0.06;
        if (playerAvatarGroup) {
          playerAvatarGroup.position.set(
            playerState.x,
            elevationAt(playerState.x, playerState.z),
            playerState.z,
          );
        }
      }
    }
    cityMode = 'walk';
  } else {
    if (driveIndex >= 0 && trafficState?.vehicles[driveIndex]) {
      trafficState.vehicles[driveIndex].manual = false;
      driveIndex = -1;
    }
    cityMode = 'orbit';
    controls.enabled = true;
    if (document.pointerLockElement) document.exitPointerLock();
    if (playerState) {
      controls.target.set(playerState.x, 0, playerState.z);
      camera.position.set(playerState.x - 22, 16, playerState.z - 24);
    }
  }
  document.querySelectorAll('[data-city-mode]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.cityMode === cityMode);
  });
  const driveButton = document.querySelector('[data-city-mode="drive"]');
  driveButton.disabled = !trafficState?.vehicles.length;
  modeLabel.textContent = cityMode === 'walk' ? 'Walking the streets'
    : cityMode === 'drive' ? 'Driving real roads'
      : cityMode === 'interior' ? `Inside ${interiorState?.building?.name || 'a building'}`
        : 'Exploring generated city';
  hint.textContent = cityMode === 'interior'
    ? 'E or Esc returns to the street'
    : cityMode === 'walk'
      ? 'W A S D walk · Shift sprint · E enter a car or building · Esc return to orbit'
    : cityMode === 'drive'
      ? 'W accelerate · S brake · E exit the car'
      : 'Drag orbit · scroll zoom · W A S D pan · click buildings, streets, or signals';
  updateCityReadout();
  return true;
}

function updateDrivenVehicle(dt) {
  if (!trafficState || driveIndex < 0) return;
  const vehicle = trafficState.vehicles[driveIndex];
  if (!vehicle) return;
  let target = 0;
  if (moveKeys.has('w')) target = vehicle.maxSpeed;
  else if (moveKeys.has('s')) target = -2.5;
  const acceleration = target > vehicle.speed ? 5.5 : -8.5;
  vehicle.speed = THREE.MathUtils.clamp(vehicle.speed + acceleration * dt, -2.5, vehicle.maxSpeed);
  vehicle.s = Math.max(0, Math.min(vehicle.path.length, vehicle.s + vehicle.speed * dt));
  if (vehicle.s >= vehicle.path.length - 0.05) {
    const end = vehicle.path.points[vehicle.path.points.length - 1];
    const heading = vehicle.path.points.length > 1
      ? Math.atan2(end.z - vehicle.path.points[vehicle.path.points.length - 2].z, end.x - vehicle.path.points[vehicle.path.points.length - 2].x)
      : 0;
    let bestNext = null;
    let bestScore = -Infinity;
    for (const nextIndex of vehicle.path.next || []) {
      const next = trafficState.paths[nextIndex];
      if (!next) continue;
      const nextStart = next.points[0];
      if (Math.hypot(nextStart.x - end.x, nextStart.z - end.z) > 4) continue;
      const nextHeading = next.points.length > 1
        ? Math.atan2(next.points[1].z - nextStart.z, next.points[1].x - nextStart.x)
        : 0;
      let turn = Math.abs(heading - nextHeading);
      turn = Math.min(turn, Math.PI * 2 - turn);
      const score = -turn;
      if (score > bestScore) {
        bestScore = score;
        bestNext = next;
      }
    }
    if (bestNext) {
      vehicle.path = bestNext;
      vehicle.s = 0;
    } else {
      vehicle.s = 0.5;
    }
  }
  const state = pathPosition(vehicle.path, vehicle.s);
  vehicle.mesh.position.copy(state.position);
  vehicle.mesh.rotation.set(0, state.heading, 0);
  const forward = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
  const behind = vehicle.mesh.position.clone().sub(forward.clone().multiplyScalar(9));
  behind.y = elevationAt(behind.x, behind.z) + 3.6;
  camera.position.lerp(behind, Math.min(1, dt * 5));
  camera.lookAt(vehicle.mesh.position.clone().add(forward.clone().multiplyScalar(14)));
}

function updateCityReadout() {
  const mode = document.querySelector('#readout-mode');
  const people = document.querySelector('#readout-people');
  const car = document.querySelector('#readout-car');
  mode.textContent = `${cityMode.toUpperCase()} · ${WEATHER_MODES[weatherMode].label} · ${TIME_OF_DAY_MODES[timeOfDay].label}`;
  people.textContent = `${pedestrianState.length} people`;
  car.textContent = cityMode === 'interior'
    ? interiorState?.building?.name || 'INTERIOR'
    : driveIndex >= 0
    ? `DRIVING / ${trafficState.vehicles[driveIndex].speed.toFixed(1)} M/S`
    : nearestVehicle(playerState || { x: 0, z: 0 }) ? 'E TO DRIVE' : '—';
  if (readoutMission) {
    readoutMission.textContent = missionState
      ? `TOUR ${missionState.visitedCount}/${missionState.landmarks.length}`
      : 'TOUR —';
  }
}

function startPhotoTour() {
  if (!detailBuildingMeshes.length) return null;
  const knownNames = [
    'transamerica',
    'ferry building',
    'coit tower',
    'city hall',
    'golden gate',
    'union square',
    'palace of fine',
    'de young',
    'california academy',
  ];
  const candidates = [];
  for (const mesh of detailBuildingMeshes) {
    const building = mesh.userData?.building;
    if (!building?.name || !building.centroid) continue;
    const lower = building.name.toLowerCase();
    const rank = knownNames.findIndex((name) => lower.includes(name));
    if (rank >= 0) candidates.push({ building, rank });
  }
  candidates.sort((a, b) => a.rank - b.rank || (Number(b.building.height) || 0) - (Number(a.building.height) || 0));
  if (candidates.length < 2) {
    const fallback = detailBuildingMeshes
      .filter((mesh) => mesh.userData?.building?.name && mesh.userData.building.centroid)
      .map((mesh) => ({
        building: mesh.userData.building,
        rank: 99,
      }))
      .sort((a, b) => (Number(b.building.height) || 0) - (Number(a.building.height) || 0))
      .slice(0, 4);
    candidates.push(...fallback);
  }
  const landmarks = candidates.slice(0, 4).map(({ building }) => ({
    id: building.id,
    name: building.name,
    x: building.centroid[0],
    z: building.centroid[1],
    visited: false,
  }));
  missionState = {
    landmarks,
    visitedCount: 0,
    complete: false,
    startedAt: performance.now(),
  };
  updateCityReadout();
  return missionState;
}

function updateMission() {
  if (!missionState || !playerState) return;
  let changed = false;
  for (const landmark of missionState.landmarks) {
    if (landmark.visited) continue;
    const distance = Math.hypot(playerState.x - landmark.x, playerState.z - landmark.z);
    if (distance < 28) {
      landmark.visited = true;
      missionState.visitedCount += 1;
      changed = true;
    }
  }
  if (changed) {
    missionState.complete = missionState.visitedCount >= missionState.landmarks.length;
    updateCityReadout();
  }
}

function createNoiseBuffer(audioContext, seconds = 2) {
  const buffer = audioContext.createBuffer(1, audioContext.sampleRate * seconds, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function ensureSandboxAudio() {
  if (sandboxAudio) {
    sandboxAudio.context?.resume?.();
    return sandboxAudio;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  const context = new AudioContextClass();
  const master = context.createGain();
  master.gain.value = 0.8;
  master.connect(context.destination);

  const noiseBuffer = createNoiseBuffer(context);
  const trafficSource = context.createBufferSource();
  trafficSource.buffer = noiseBuffer;
  trafficSource.loop = true;
  const trafficFilter = context.createBiquadFilter();
  trafficFilter.type = 'bandpass';
  trafficFilter.frequency.value = 240;
  trafficFilter.Q.value = 0.4;
  const trafficGain = context.createGain();
  trafficGain.gain.value = 0;
  trafficSource.connect(trafficFilter).connect(trafficGain).connect(master);
  trafficSource.start();

  const windSource = context.createBufferSource();
  windSource.buffer = noiseBuffer;
  windSource.loop = true;
  windSource.playbackRate.value = 0.35;
  const windFilter = context.createBiquadFilter();
  windFilter.type = 'lowpass';
  windFilter.frequency.value = 420;
  const windGain = context.createGain();
  windGain.gain.value = 0;
  windSource.connect(windFilter).connect(windGain).connect(master);
  windSource.start();

  const interiorOscillator = context.createOscillator();
  interiorOscillator.frequency.value = 120;
  const interiorGain = context.createGain();
  interiorGain.gain.value = 0;
  interiorOscillator.connect(interiorGain).connect(master);
  interiorOscillator.start();

  sandboxAudio = {
    context,
    master,
    trafficGain,
    windGain,
    interiorGain,
    muted: false,
    mode: 'day',
  };
  updateSandboxAudio();
  return sandboxAudio;
}

function toggleSandboxAudio() {
  const audio = ensureSandboxAudio();
  if (!audio) return null;
  audioEnabled = !audioEnabled;
  audio.muted = !audioEnabled;
  const target = audioEnabled ? 0.8 : 0;
  audio.master.gain.setTargetAtTime(target, audio.context.currentTime, 0.08);
  return { muted: audio.muted, enabled: audioEnabled };
}

function updateSandboxAudio() {
  const audio = sandboxAudio;
  if (!audio || !audio.context) return;
  const now = audio.context.currentTime;
  const night = TIME_OF_DAY_MODES[timeOfDay]?.night ?? 0;
  const fog = weatherMode === 'fog' ? 1 : weatherMode === 'drizzle' ? 0.55 : 0;
  const interior = cityMode === 'interior' ? 1 : 0;
  const traffic = cityMode === 'interior' ? 0.1 : 0.5 + night * 0.18 + fog * 0.08;
  const wind = 0.16 + night * 0.05 + fog * 0.22 + (weatherMode === 'drizzle' ? 0.16 : 0);
  audio.trafficGain.gain.setTargetAtTime(traffic * 0.045, now, 0.25);
  audio.windGain.gain.setTargetAtTime(wind * 0.05, now, 0.3);
  audio.interiorGain.gain.setTargetAtTime(interior * 0.028, now, 0.18);
  audio.mode = cityMode === 'interior' ? 'interior' : timeOfDay;
}

function setupScene() {
  const context = sceneCanvas.getContext('webgl2', {
    alpha: false,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  if (!context) {
    setBuildProgress('ERROR', 'WebGL2 is required for the 3D sandbox.', 1);
    throw new Error('WebGL2 unavailable');
  }
  renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, context });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa8c8dc);
  scene.fog = new THREE.Fog(0xb8d0e0, 320, 2200);
  skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(1300, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x3a7aad) },
        midColor: { value: new THREE.Color(0x6eaed0) },
        horizonColor: { value: new THREE.Color(0xe8c898) },
        sunColor: { value: new THREE.Color(0xffc070) },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 horizonColor;
        uniform vec3 sunColor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y;
          float tLow = clamp(pow(max(h, 0.0), 0.42), 0.0, 1.0);
          float tHigh = clamp(pow(max(h, 0.0), 0.88), 0.0, 1.0);
          vec3 color = mix(horizonColor, midColor, tLow);
          color = mix(color, topColor, tHigh);
          float sunGlow = clamp(1.0 - distance(normalize(vWorldPosition), normalize(vec3(-0.32, 0.38, -0.28))) * 2.8, 0.0, 1.0);
          color += sunColor * sunGlow * sunGlow * 0.38;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    }),
  );
  skyDome.name = 'Real map gradient sky';
  skyDome.renderOrder = -10;
  scene.add(skyDome);

  hemisphereLight = new THREE.HemisphereLight(0xb8dff0, 0x5a5648, 0.92);
  scene.add(hemisphereLight);

  sun = new THREE.DirectionalLight(0xffcc88, 3.55);
  sun.position.set(420, 620, 380);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -420;
  sun.shadow.camera.right = 420;
  sun.shadow.camera.top = 420;
  sun.shadow.camera.bottom = -420;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 1600;
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 0.028;
  sun.shadow.radius = 2.2;
  scene.add(sun);
  moonFill = new THREE.DirectionalLight(0x88a8d0, 0);
  moonFill.position.set(280, 520, 220);
  scene.add(moonFill);
  nightAmbient = new THREE.AmbientLight(0x445566, 0);
  scene.add(nightAmbient);
  const fillLight = new THREE.DirectionalLight(0x88a8c8, 0.42);
  fillLight.position.set(-280, 320, -220);
  scene.add(fillLight);

  camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 1, 4200);
  controls = new OrbitControls(camera, sceneCanvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.minDistance = 6;
  controls.maxDistance = 1800;
  controls.target.set(0, 0, 0);
  controls.update();
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight, 16);
    ssaoPass.kernelRadius = 0.65;
    ssaoPass.minDistance = 0.006;
    ssaoPass.maxDistance = 0.075;
    ssaoPassRef = ssaoPass;
    composer.addPass(ssaoPass);
    const smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
    composer.addPass(smaaPass);
    composer.addPass(new OutputPass());
  } catch (error) {
    console.warn('Post-processing disabled', error.message);
    composer = null;
  }
  createRainSystem();
}

function createRainSystem() {
  if (!scene || rainGroup) return rainGroup;
  const streakCount = 3200;
  rainPositions = new Float32Array(streakCount * 6);
  rainVelocities = new Float32Array(streakCount);
  const spread = 460;
  const streakLength = 7.5;
  for (let i = 0; i < streakCount; i += 1) {
    const base = i * 6;
    const x = (Math.random() - 0.5) * spread;
    const y = Math.random() * 190;
    const z = (Math.random() - 0.5) * spread;
    rainPositions[base] = x;
    rainPositions[base + 1] = y;
    rainPositions[base + 2] = z;
    rainPositions[base + 3] = x + 1.8;
    rainPositions[base + 4] = y - streakLength;
    rainPositions[base + 5] = z + 0.9;
    rainVelocities[i] = 42 + Math.random() * 48;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0xd8e4f0,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
  });
  rainGroup = new THREE.LineSegments(geometry, material);
  rainGroup.name = 'Pacific drizzle rain';
  rainGroup.visible = false;
  rainGroup.frustumCulled = false;
  scene.add(rainGroup);
  return rainGroup;
}

function updateRain(dt) {
  if (!rainGroup || !rainPositions || !camera) return;
  const active = weatherMode === 'drizzle';
  rainGroup.visible = active;
  if (!active) return;
  rainGroup.position.copy(camera.position);
  const windX = 16;
  const windZ = 9;
  const spread = 460;
  const height = 190;
  const streakLength = 7.5;
  for (let i = 0; i < rainVelocities.length; i += 1) {
    const base = i * 6;
    rainPositions[base + 1] -= rainVelocities[i] * dt;
    rainPositions[base + 4] -= rainVelocities[i] * dt;
    rainPositions[base] += windX * dt;
    rainPositions[base + 2] += windZ * dt;
    rainPositions[base + 3] += windX * dt;
    rainPositions[base + 5] += windZ * dt;
    if (rainPositions[base + 1] < -18) {
      const x = (Math.random() - 0.5) * spread;
      const y = height * Math.random();
      const z = (Math.random() - 0.5) * spread;
      rainPositions[base] = x;
      rainPositions[base + 1] = y;
      rainPositions[base + 2] = z;
      rainPositions[base + 3] = x + 1.8;
      rainPositions[base + 4] = y - streakLength;
      rainPositions[base + 5] = z + 0.9;
    }
  }
  rainGroup.geometry.attributes.position.needsUpdate = true;
}

function setWeatherMode(mode) {
  const config = WEATHER_MODES[mode];
  if (!config) return weatherMode;
  weatherMode = mode;
  scene.background.set(config.background);
  scene.fog.color.set(config.fogColor);
  scene.fog.near = config.fogNear;
  scene.fog.far = config.fogFar;
  sun.color.set(config.sunColor);
  sun.intensity = config.sunIntensity;
  renderer.toneMappingExposure = config.exposure;
  if (skyDome?.material?.uniforms) {
    skyDome.material.uniforms.topColor.value.set(config.skyTop);
    if (skyDome.material.uniforms.midColor) {
      skyDome.material.uniforms.midColor.value.set(config.skyMid ?? config.skyTop);
    }
    skyDome.material.uniforms.horizonColor.value.set(config.skyHorizon);
    skyDome.material.uniforms.sunColor.value.set(config.skySun);
  }
  if (scene && !rainGroup) createRainSystem();
  if (rainGroup) rainGroup.visible = mode === 'drizzle';
  return weatherMode;
}

function setTimeOfDay(mode) {
  const config = TIME_OF_DAY_MODES[mode];
  if (!config) return timeOfDay;
  timeOfDay = mode;
  scene.background.set(config.background);
  scene.fog.color.set(config.fogColor);
  scene.fog.near = config.fogNear;
  scene.fog.far = config.fogFar;
  sun.color.set(config.sunColor);
  sun.intensity = config.sunIntensity;
  sun.position.set(config.sunPosition[0], config.sunPosition[1], config.sunPosition[2]);
  if (hemisphereLight) {
    hemisphereLight.color.set(config.hemisphereSky);
    hemisphereLight.groundColor.set(config.hemisphereGround);
    hemisphereLight.intensity = config.hemisphereIntensity;
  }
  renderer.toneMappingExposure = config.exposure;
  if (skyDome?.material?.uniforms) {
    skyDome.material.uniforms.topColor.value.set(config.skyTop);
    if (skyDome.material.uniforms.midColor) {
      skyDome.material.uniforms.midColor.value.set(config.skyMid ?? config.skyTop);
    }
    skyDome.material.uniforms.horizonColor.value.set(config.skyHorizon);
    skyDome.material.uniforms.sunColor.value.set(config.skySun);
  }
  updateNightGlow(config.night);
  return timeOfDay;
}

function updateNightGlow(amount) {
  const night = THREE.MathUtils.clamp(amount, 0, 1);
  // Keep ambient night dark; let windows/streetlights carry the glow.
  const windowGlow = night * 1.35;
  for (const material of windowMaterials) {
    if (!material) continue;
    material.emissive.set(0xffd9a0);
    material.emissiveIntensity = windowGlow;
    material.needsUpdate = true;
  }
  for (const material of streetLightMaterials) {
    if (!material) continue;
    material.emissive.set(0xffe8b8);
    material.emissiveIntensity = 0.35 + night * 2.4;
    material.needsUpdate = true;
  }
  for (const material of vehicleHeadlightMaterials) {
    if (!material) continue;
    material.emissive.set(0xfff8d8);
    material.emissiveIntensity = 0.55 + night * 2.2;
    material.needsUpdate = true;
  }
  if (moonFill) moonFill.intensity = night * 0.35;
  if (nightAmbient) nightAmbient.intensity = night * 0.18;
  if (ssaoPassRef) ssaoPassRef.enabled = night < 0.65;
}

function updateSignals(time) {
  for (const group of signalGroups) {
    const data = group.userData;
    const phase = signalPhaseAt(0, time, data.offset);
    for (const lamp of data.lamps) {
      const colorIndex = lamp.userData.colorIndex;
      const active = phase === 'green' ? colorIndex === 2
        : phase === 'yellow' ? colorIndex === 1
          : colorIndex === 0;
      lamp.material.emissive.set(active ? lamp.userData.lampColor : 0x000000);
      lamp.material.color.set(active ? lamp.userData.lampColor : 0x22262a);
    }
  }
}

function pathPosition(path, s) {
  const clamped = Math.max(0, Math.min(path.length - 0.01, s));
  let walked = 0;
  for (let i = 0; i < path.points.length - 1; i += 1) {
    const a = path.points[i];
    const b = path.points[i + 1];
    const segLength = Math.hypot(b.x - a.x, b.z - a.z);
    if (walked + segLength >= clamped) {
      const t = segLength > 0 ? (clamped - walked) / segLength : 0;
      return {
        position: new THREE.Vector3(
          a.x + (b.x - a.x) * t,
          elevationAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) + ROAD_SURFACE_LIFT + 0.04,
          a.z + (b.z - a.z) * t,
        ),
        heading: Math.atan2(b.z - a.z, b.x - a.x),
      };
    }
    walked += segLength;
  }
  const a = path.points[path.points.length - 2];
  const b = path.points[path.points.length - 1];
  return {
    position: new THREE.Vector3(b.x, elevationAt(b.x, b.z) + ROAD_SURFACE_LIFT + 0.04, b.z),
    heading: Math.atan2(b.z - a.z, b.x - a.x),
  };
}

function updateTraffic(dt, time) {
  if (!trafficState) return;
  for (const vehicle of trafficState.vehicles) {
    if (vehicle.manual) continue;
    const path = vehicle.path;
    let target = vehicle.targetSpeed;
    let stopAt = Infinity;
    for (const stop of path.signalStops) {
      if (stop.s > vehicle.s && stop.s - vehicle.s < 14) {
        const phase = signalPhaseAt(0, time, stop.offset);
        if (phase === 'red') {
          stopAt = stop.s - 2.2;
          target = 0;
          break;
        }
      }
    }
    if (!Number.isFinite(stopAt)) {
      const lookahead = path.points[path.points.length - 1];
      const distanceToEnd = path.length - vehicle.s;
      if (distanceToEnd < 12) target = Math.min(target, 4 + distanceToEnd * 0.45);
    }
    const acceleration = target > vehicle.speed ? 2.4 : -5.2;
    vehicle.speed = THREE.MathUtils.clamp(vehicle.speed + acceleration * dt, 0, vehicle.maxSpeed);
    vehicle.s = Math.min(vehicle.s + vehicle.speed * dt, path.length);

    if (vehicle.s >= path.length - 0.05) {
      const end = path.points[path.points.length - 1];
      const heading = vehicle.path.points.length > 1
        ? Math.atan2(end.z - path.points[path.points.length - 2].z, end.x - path.points[path.points.length - 2].x)
        : 0;
      let bestNext = null;
      let bestScore = -Infinity;
      for (const nextIndex of path.next || []) {
        const next = trafficState.paths[nextIndex];
        if (!next) continue;
        const nextStart = next.points[0];
        if (Math.hypot(nextStart.x - end.x, nextStart.z - end.z) > 4) continue;
        const nextHeading = next.points.length > 1
          ? Math.atan2(next.points[1].z - nextStart.z, next.points[1].x - nextStart.x)
          : 0;
        let turn = Math.abs(heading - nextHeading);
        turn = Math.min(turn, Math.PI * 2 - turn);
        const score = -turn + Math.random() * 0.4;
        if (score > bestScore) {
          bestScore = score;
          bestNext = next;
        }
      }
      if (bestNext) {
        vehicle.path = bestNext;
        vehicle.s = 0;
      } else {
        vehicle.s = 0.5;
      }
    }

    const state = pathPosition(vehicle.path, vehicle.s);
    vehicle.mesh.position.copy(state.position);
    vehicle.mesh.rotation.set(0, state.heading, 0);
  }
}

function updateReadout3d() {
  const info = renderer.info.render;
  fpsSamples.push(performance.now());
  while (fpsSamples.length && fpsSamples[0] < performance.now() - 1000) fpsSamples.shift();
  const fps = fpsSamples.length;
  readoutVertices.textContent = `${fps} FPS`;
  readoutArea.textContent = `${formatNumber(info.calls)} draw calls`;
  readoutSelected.textContent = `${formatNumber(info.triangles)} tris`;
}

function countSceneTriangles(root) {
  let total = 0;
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    const index = object.geometry.index;
    total += (index ? index.count : object.geometry.attributes.position.count) / 3;
  });
  return Math.round(total);
}

function renderLoop() {
  if (!renderer || !scene || !camera) {
    requestAnimationFrame(renderLoop);
    return;
  }
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  const time = performance.now() / 1000;
  updateSignals(time);
  updateTraffic(dt, time);
  updatePedestrians(dt);
  if (cityMode === 'walk') {
    controls.enabled = false;
    updatePlayerWalk(dt);
  } else if (cityMode === 'interior') {
    controls.enabled = false;
    updateInteriorResidents(dt);
    if (interiorState?.room) {
      const data = interiorState.room.userData;
      camera.position.set(data.centerX, data.floorY + 1.55, data.centerZ - 1.7);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(-0.08, 0, 0);
    }
  } else if (cityMode === 'drive') {
    controls.enabled = false;
    updateDrivenVehicle(dt);
  } else {
    controls.enabled = true;
    const moveSpeed = 46;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const move = new THREE.Vector3();
    if (moveKeys.has('w')) move.add(forward);
    if (moveKeys.has('s')) move.sub(forward);
    if (moveKeys.has('d')) move.add(right);
    if (moveKeys.has('a')) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(moveSpeed * dt);
      controls.target.add(move);
      camera.position.add(move);
    }
    controls.update();
  }
  updateCityReadout();
  updateMission();
  updateSandboxAudio();
  const streamFocus = playerState
    ? { x: playerState.x, z: playerState.z }
    : { x: camera.position.x, z: camera.position.z };
  updateRoadStreaming(streamFocus);
  updateRain(dt);
  if (composer) composer.render();
  else renderer.render(scene, camera);
  updateReadout3d();
  requestAnimationFrame(renderLoop);
}

let threeDControlsBound = false;

function setup3DControls() {
  window.addEventListener('keydown', (event) => {
    moveKeys.add(event.key.toLowerCase());
    if (event.key === 'h') hud.inert = !hud.inert;
    if (event.key === 'm' && scene) toggleSandboxAudio();
    if (event.key === 'p' && scene) {
      if (startPhotoTour()) setCityMode('walk');
    }
    if (event.key === 'r' && scene) {
      const modes = Object.keys(WEATHER_MODES);
      weatherIndex = (weatherIndex + 1) % modes.length;
      setWeatherMode(modes[weatherIndex]);
    }
    if (event.key === 't' && scene) {
      const modes = Object.keys(TIME_OF_DAY_MODES);
      timeIndex = (timeIndex + 1) % modes.length;
      setTimeOfDay(modes[timeIndex]);
    }
    if (event.key === 'e' && cityMode === 'interior') {
      exitInterior();
    } else if (event.key === 'e' && cityMode === 'walk') {
      if (!enterNearestBuilding() && trafficState?.vehicles.length) {
        setCityMode('drive');
      }
    } else if (event.key === 'e' && cityMode === 'drive') {
      setCityMode('walk');
    } else if (event.key === 'escape' && cityMode !== 'orbit') {
      if (cityMode === 'interior') exitInterior();
      else setCityMode('orbit');
    }
  });
  window.addEventListener('keyup', (event) => moveKeys.delete(event.key.toLowerCase()));
  document.addEventListener('pointerlockchange', () => {
    pointerLockActive = document.pointerLockElement === sceneCanvas;
  });
  document.addEventListener('mousemove', (event) => {
    if (!pointerLockActive || cityMode !== 'walk') return;
    playerYaw -= event.movementX * 0.0022;
    playerPitch = THREE.MathUtils.clamp(playerPitch - event.movementY * 0.0022, -1.25, 1.25);
    if (playerState) {
      playerState.yaw = playerYaw;
      playerState.pitch = playerPitch;
    }
  });
  sceneCanvas.addEventListener('mousedown', () => {
    if (cityMode === 'walk' && !pointerLockActive && document.body.classList.contains('is-city')) {
      sceneCanvas.requestPointerLock();
    }
  });
  sceneCanvas.addEventListener('mousemove', (event) => {
    if (moveKeys.size || pointerLockActive || cityMode !== 'orbit') return;
    const rect = sceneCanvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const objects = [];
    if (coarseBuildingMesh) objects.push(coarseBuildingMesh);
    objects.push(...detailBuildingMeshes);
    objects.push(...signalGroups);
    if (roadMeshes) objects.push(...roadMeshes.children);
    const hits = raycaster.intersectObjects(objects, false);
    sceneCanvas.style.cursor = hits.length ? 'pointer' : 'grab';
  });

  sceneCanvas.addEventListener('click', (event) => {
    const rect = sceneCanvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const objects = [];
    if (coarseBuildingMesh) objects.push(coarseBuildingMesh);
    objects.push(...detailBuildingMeshes);
    objects.push(...signalGroups);
    if (roadMeshes) objects.push(...roadMeshes.children);
    const hits = raycaster.intersectObjects(objects, false);
    if (hits.length) {
      const hit = hits[0];
      if (hit.object.userData?.type === 'building') {
        showInspector('Building', hit.object.userData.building);
      } else if (hit.object.userData?.type === 'signal') {
        showInspector('Traffic signal', hit.object.userData.signal);
      } else if (hit.object.userData?.type === 'building-instances' && Number.isInteger(hit.instanceId)) {
        const building = coarseBuildingMesh.userData.buildings[hit.instanceId];
        showInspector('Building', building);
      } else {
        const point = hit.point;
        const road = findNearestRoad(point);
        if (road) showInspector('Street', { ...road, point: { x: point.x, z: point.z } });
      }
    }
  });
}

function findNearestRoad(point) {
  let best = null;
  let bestDistance = 8;
  for (const road of selectedRoadsForHit) {
    const points = roadPoints(road);
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLengthSq = dx * dx + dz * dz;
      const t = segLengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / segLengthSq)) : 0;
      const distance = Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = road;
      }
    }
  }
  return best;
}

function nearestCrossStreet(road, point) {
  let best = null;
  let bestDistance = 14;
  for (const candidate of selectedRoadsForHit) {
    if (candidate.id === road.id || !candidate.name) continue;
    const points = roadPoints(candidate);
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLengthSq = dx * dx + dz * dz;
      const t = segLengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / segLengthSq)) : 0;
      const distance = Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best;
}

function showInspector(type, data) {
  inspectorTitle.textContent = type;
  const fields = [];
  if (type === 'Building') {
    fields.push(['Name', data.name || 'Unnamed building']);
    fields.push(['Address', data.addr || '—']);
    fields.push(['Building type', data.building || 'yes']);
    fields.push(['Amenity', data.amenity || '—']);
    fields.push(['Height', `${formatNumber(Number(data.height) || 0, 1)} m`]);
    fields.push(['Levels', formatNumber(data.levels || 1)]);
    fields.push(['Footprint', `${formatNumber(data.area || 0)} m²`]);
    fields.push(['OSM way', String(data.id)]);
  } else if (type === 'Traffic signal') {
    fields.push(['Position', `${data.position[0].toFixed(1)}, ${data.position[1].toFixed(1)}`]);
    fields.push(['SFMTA signal', 'OSM traffic_signals node']);
    fields.push(['Phase', 'Shared 25.8 s cycle']);
  } else if (type === 'Street') {
    fields.push(['Name', data.name || 'Unnamed street']);
    const crossStreet = nearestCrossStreet(data, data.point || data);
    if (crossStreet) fields.push(['Cross street', crossStreet.name || 'Unnamed cross street']);
    fields.push(['Block', data.name
      ? `${data.name}${crossStreet?.name ? ` at ${crossStreet.name}` : ' block'}`
      : 'Unnamed block']);
    fields.push(['Class', data.highway || '—']);
    fields.push(['One way', data.oneway ? 'Yes' : 'No']);
    fields.push(['Lanes', String(data.lanes || 1)]);
    fields.push(['Max speed', data.maxspeed || '—']);
    fields.push(['Surface', data.surface || '—']);
    fields.push(['Sidewalk', data.sidewalk || '—']);
    fields.push(['Bridge', data.bridge ? 'Yes' : 'No']);
    fields.push(['Tunnel', data.tunnel ? 'Yes' : 'No']);
    fields.push(['OSM way', String(data.id)]);
  }
  inspectorFields.innerHTML = '';
  for (const [label, value] of fields) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    inspectorFields.append(dt, dd);
  }
  inspector.hidden = false;
}

async function buildCity() {
  const buildButton = document.querySelector('[data-action="build"]');
  buildButton.disabled = true;
  buildOverlay.hidden = false;
  const flat = flatRegion();
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    minX = Math.min(minX, flat[i]);
    maxX = Math.max(maxX, flat[i]);
    minZ = Math.min(minZ, flat[i + 1]);
    maxZ = Math.max(maxZ, flat[i + 1]);
  }
  const regionBBox = { minX, minZ, maxX, maxZ };
  fullCityMode = polygonArea(region) / 1e6 > 12;

  try {
    setBuildProgress('SELECTING', 'Finding real streets, blocks, and signals in your boundary…', 0.04);
    await tick();
    cachedCameraAnalysis = null;
    const selectedRoads = fullCityMode
      ? selectAllRoads(regionBBox)
      : selectRoads(regionBBox);
    const buildings = selectBuildings(regionBBox);
    const signals = selectSignals(regionBBox);
    const regionPoints = region.map(({ x, z }) => ({ x, z }));
    const streamFocus = polygonCentroid(regionPoints);
    readoutSelected.textContent = `${formatNumber(selectedRoads.length)} roads / ${formatNumber(buildings.detailed.length + buildings.coarse.length)} buildings / ${formatNumber(signals.length)} signals`;

    let usedRoads = selectedRoads;
    let compilation = null;
    if (!fullCityMode) {
      setBuildProgress('MESHING', 'Compiling lane-level road surfaces and junctions…', 0.16);
      await tick();
      ({ compilation, roads: usedRoads } = compileSafely(selectedRoads));
      setBuildProgress('MESHING', 'Resolving intersections and turn topology…', 0.3);
      await tick();
    }
    selectedRoadsForHit = usedRoads;

    if (!scene) {
      setupScene();
      if (!threeDControlsBound) {
        setup3DControls();
        threeDControlsBound = true;
      }
      setWeatherMode('clear');
      setTimeOfDay('day');
    }
    windowMaterials.length = 0;
    streetLightMaterials.length = 0;
    vehicleHeadlightMaterials.length = 0;
    if (cityRoot) {
      scene.remove(cityRoot);
      disposeRoot(cityRoot);
    }
    missionState = null;
    cityRoot = new THREE.Group();
    cityRoot.name = 'Real map generated city';
    scene.add(cityRoot);

    setBuildProgress('TERRAIN', 'Laying the land slab and bay water…', 0.4);
    await tick();
    cityRoot.add(createWaterPlane(regionPoints));
    cityRoot.add(createGround(regionPoints));

    setBuildProgress('ROADS', fullCityMode
      ? 'Laying the full real street network…'
      : 'Generating asphalt, markings, and sidewalks from OSM…', 0.5);
    await tick();
    if (fullCityMode) {
      const detailIds = new Set(cityData.detailRoads.map((road) => road.id));
      const simpleRoads = usedRoads.filter((road) => !detailIds.has(road.id));
      roadMeshes = createSimpleRoadMeshes(simpleRoads);
      cityRoot.add(roadMeshes);
      const sidewalks = createSimpleSidewalkMeshes(simpleRoads);
      cityRoot.add(sidewalks);
      cityRoot.add(createStreetCorridorPads(simpleRoads));
      simpleRoadSegments = roadMeshes.userData.segments || 0;
      simpleSidewalkSegments = sidewalks.userData.segments || 0;
      const detailed = usedRoads.filter((road) => detailIds.has(road.id));
      detailRoadStreamGroup = new THREE.Group();
      detailRoadStreamGroup.name = 'Streamed detail road chunks';
      cityRoot.add(detailRoadStreamGroup);
      detailRoadCompiledIds = new Set();
      detailRoadQueue = [];
      detailRoadStreamStats = { loadedChunks: 0, compiledRoads: 0, pendingRoads: 0 };
      roadStreamingInFlight = false;
      queueDetailRoadChunk(streamFocus);
    } else {
      roadMeshes = createRoadMeshes(compilation);
      cityRoot.add(roadMeshes);
      cityRoot.add(createSimpleSidewalkMeshes(usedRoads));
      cityRoot.add(createStreetCorridorPads(usedRoads));
    }
    cityRoot.add(createCableCarTracks(usedRoads));
    setBuildProgress('BLOCKS', 'Extruding footprints and raising block massing…', 0.66);
    await tick();
    detailBuildingMeshes = [];
    for (const building of buildings.detailed) {
      const landmarkName = (building.name || '').toLowerCase();
      if (SF_LANDMARK_SKIP.has(landmarkName)) continue;
      const mesh = createDetailBuildingMesh(building, buildingGroundY(building));
      if (mesh) {
        detailBuildingMeshes.push(mesh);
        cityRoot.add(mesh);
      }
    }
    const coarse = createCoarseBuildings(buildings.coarse);
    coarseBuildingMesh = coarse.mesh;
    if (coarseBuildingMesh) cityRoot.add(coarseBuildingMesh);
    cityRoot.add(createBuildingFrontagePads(buildings));
    cityRoot.add(createSfLandmarkSilhouettes(regionBBox, fullCityMode));
    createBuildingDoorways(buildings.detailed);
    createStreetfrontDetails(buildings.detailed);
    createRooftopDetails(buildings.detailed);

    setBuildProgress('SIGNALS', 'Hanging traffic lights at real signal nodes…', 0.78);
    await tick();
    signalGroups = [];
    for (let i = 0; i < signals.length; i += 1) {
      const group = createSignalGroup(signals[i], i);
      signalGroups.push(group);
      cityRoot.add(group);
    }
    cityRoot.add(createCrosswalks(signals, usedRoads));

    setBuildProgress('FLOW', 'Painting one-way arrows and starting traffic…', 0.9);
    await tick();
    cityRoot.add(createOneWayArrows(usedRoads));
    trafficState = buildTraffic(usedRoads, signals);
    for (const vehicle of trafficState.vehicles) cityRoot.add(vehicle.mesh);
    createPedestrianSystem(usedRoads);
    createStreetTrees(usedRoads);
    createStreetFurniture(usedRoads);
    updateNightGlow(TIME_OF_DAY_MODES[timeOfDay]?.night ?? 0);
    sceneTriangleCount = countSceneTriangles(cityRoot);

    const centroid = polygonCentroid(regionPoints);
    cityFlatRegion = flatRegion();
    buildCollisionGrid(detailBuildingMeshes, coarseBuildingMesh);
    createHillVegetation(regionPoints);
    const trafficStart = trafficState?.vehicles[0]?.mesh?.position;
    console.warn('trafficStart', trafficStart);
    initPlayer({
      x: trafficStart ? trafficStart.x : centroid.x,
      z: trafficStart ? trafficStart.z : centroid.z,
    });
    controls.target.set(centroid.x, elevationAt(centroid.x, centroid.z), centroid.z);
    camera.position.set(centroid.x - 170, elevationAt(centroid.x, centroid.z) + 190, centroid.z - 210);
    positionSkyDomeAt(centroid, regionSpan(regionPoints));
    sun.position.set(centroid.x + 420, 620, centroid.z + 380);
    sun.target.position.set(centroid.x, 0, centroid.z);
    sun.target.updateMatrixWorld();
    controls.update();

    setBuildProgress('DONE', `City ready · ${formatNumber(usedRoads.length)} streets · ${formatNumber(buildings.detailed.length + buildings.coarse.length)} buildings`, 1);
    await new Promise((resolve) => setTimeout(resolve, 650));
    buildOverlay.hidden = true;
    document.body.classList.add('is-city');
    document.querySelector('[data-action="back"]').hidden = false;
    document.querySelector('[data-action="build"]').hidden = true;
    document.querySelector('[data-toolbar="city"]').hidden = false;
    setCityMode('orbit');
    modeLabel.textContent = 'Exploring generated city';
    hint.textContent = 'Drag orbit · scroll zoom · WASD pan · click buildings, streets, or signals for OSM metadata';
  } catch (error) {
    console.error(error);
    setBuildProgress('ERROR', error.message || String(error), 1);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    buildOverlay.hidden = true;
    buildButton.disabled = false;
  }
}

function disposeRoot(root) {
  root.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of materials) material.dispose();
  });
  root.clear();
}

function start() {
  resize();
  loadSandboxTextures();
  window.addEventListener('resize', () => {
    resize();
    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      composer?.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
  });
  setupMapInteractions();
  setupToolbar();
  loadCity();

  launchButton.addEventListener('click', () => {
    bootOverlay.classList.add('is-dismissed');
    hud.inert = false;
    scheduleMapDraw();
    ensureSandboxAudio();
  });
  requestAnimationFrame(drawMap);

  window.__SF_REALMAP__ = {
    getData: () => cityData,
    getRegion: () => region,
    setRegion: (points) => setRegion(points),
    applyPreset: (name) => applyPreset(name),
    build: () => buildCity().catch((error) => {
      console.error('Real map build rejected', error);
      return { error: error.message || String(error) };
    }),
    getBuildState: () => {
      let renderStats = null;
      if (renderer && scene && camera) {
        renderer.info.reset();
        renderer.render(scene, camera);
        renderStats = {
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        };
      }
      return {
      isCity: document.body.classList.contains('is-city'),
      buildOverlayHidden: buildOverlay.hidden,
      selectedRoads: selectedRoadsForHit.length,
      fullCity: fullCityMode,
      simpleRoadSegments,
      simpleSidewalkSegments,
      roadStream: fullCityMode ? { ...detailRoadStreamStats } : null,
      signals: signalGroups.length,
      traffic: trafficState?.vehicles.length || 0,
      detailBuildings: detailBuildingMeshes.length,
      coarseBuildings: coarseBuildingMesh?.count || 0,
      mode: cityMode,
      pedestrians: pedestrianState.length,
      trees: treeGroup?.children[0]?.count || 0,
      furniture: furnitureGroup?.children.reduce((sum, mesh) => sum + (mesh.count || 0), 0) || 0,
      hillVegetation: hillVegetationGroup?.children.reduce((sum, mesh) => sum + (mesh.count || 0), 0) || 0,
      doorways: doorwayGroup?.children.length || 0,
      streetfronts: streetfrontGroup?.children.length || 0,
      rooftops: rooftopGroup?.userData
        ? rooftopGroup.userData.boxes + rooftopGroup.userData.tanks
        : 0,
      mission: missionState ? {
        complete: missionState.complete,
        visitedCount: missionState.visitedCount,
        total: missionState.landmarks.length,
        landmarks: missionState.landmarks.map((landmark) => ({
          name: landmark.name,
          visited: landmark.visited,
        })),
      } : null,
      crosswalks: cityRoot?.getObjectByName('Real map zebra crossings')?.children.length || 0,
      terrain: terrainData?.meta ? {
        cellSize: terrainData.meta.cellSize,
        width: terrainData.meta.width,
        height: terrainData.meta.height,
        minElevation: terrainData.meta.minElevation,
        maxElevation: terrainData.meta.maxElevation,
      } : null,
      weather: weatherMode,
      timeOfDay,
      player: playerState ? { x: playerState.x, z: playerState.z } : null,
      collisionVolumes: collisionAabbs.length,
      driveIndex,
      vehicleSpeed: driveIndex >= 0 && trafficState?.vehicles[driveIndex]
        ? trafficState.vehicles[driveIndex].speed
        : null,
      interior: interiorState ? {
        name: interiorState.building?.name || 'Unnamed building',
        address: interiorState.building?.addr || '',
        archetype: interiorState.archetype || null,
        residents: interiorResidents.map((resident) => ({
          role: resident.mesh.userData.role,
          action: resident.mesh.userData.action,
          mood: resident.mesh.userData.mood,
          choice: resident.mesh.userData.choice,
          schedule: resident.mesh.userData.schedule,
          visible: resident.mesh.visible,
        })),
      } : null,
      renderer: renderStats,
      geometryTriangles: sceneTriangleCount,
      };
    },
    setCityMode: (mode) => setCityMode(mode),
    getDriveIndex: () => driveIndex,
    enterNearestBuilding: () => enterNearestBuilding(),
    exitInterior: () => exitInterior(),
    startPhotoTour: () => startPhotoTour(),
    getMissionState: () => missionState,
    getInteriorState: () => interiorState ? {
      name: interiorState.building?.name || 'Unnamed building',
      address: interiorState.building?.addr || '',
      archetype: interiorState.archetype || null,
      residents: interiorResidents.map((resident) => ({
        role: resident.mesh.userData.role,
        action: resident.mesh.userData.action,
        mood: resident.mesh.userData.mood,
        choice: resident.mesh.userData.choice,
        schedule: resident.mesh.userData.schedule,
        visible: resident.mesh.visible,
      })),
      building: interiorState.building,
    } : null,
    getBuildingEntrance: (index = 0) => {
      const building = detailBuildingMeshes[index]?.userData?.building;
      return building ? buildingEntrancePoint(building) : null;
    },
    setCameraPose: (pose) => {
      if (!controls || !camera) return false;
      const resolved = resolveCameraPose(pose);
      if (resolved?.position) camera.position.set(resolved.position[0], resolved.position[1], resolved.position[2]);
      if (resolved?.target) controls.target.set(resolved.target[0], resolved.target[1], resolved.target[2]);
      controls.update();
      return true;
    },
    getCameraState: () => camera ? {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      timeOfDay,
      weatherMode,
      sunIntensity: sun?.intensity ?? null,
      sunPosition: sun ? [sun.position.x, sun.position.y, sun.position.z] : null,
    } : null,
    getSuggestedCameraPoses: () => getSuggestedCameraPoses(),
    setBeauty: (active) => {
      document.body.classList.toggle('is-beauty', Boolean(active));
      return Boolean(active);
    },
    setWeather: (mode) => setWeatherMode(mode),
    getWeather: () => weatherMode,
    setTimeOfDay: (mode) => setTimeOfDay(mode),
    getTimeOfDay: () => timeOfDay,
    ensureAudio: () => ensureSandboxAudio() ? true : false,
    toggleAudio: () => toggleSandboxAudio(),
    getAudioState: () => sandboxAudio ? {
      ready: sandboxAudio.context.state,
      muted: sandboxAudio.muted,
      mode: sandboxAudio.mode,
      trafficGain: Number(sandboxAudio.trafficGain.gain.value.toFixed(4)),
      windGain: Number(sandboxAudio.windGain.gain.value.toFixed(4)),
      interiorGain: Number(sandboxAudio.interiorGain.gain.value.toFixed(4)),
    } : null,
    getFrameDiagnostics: () => {
      if (!renderer || !scene || !camera) return null;
      if (composer) composer.render();
      else renderer.render(scene, camera);
      const gl = sceneCanvas.getContext('webgl2');
      if (!gl) return null;
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      let sum = 0;
      let bright = 0;
      let count = 0;
      let maxLuma = 0;
      for (let i = 0; i < data.length; i += 4 * 4) {
        const luma = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
        sum += luma;
        count += 1;
        maxLuma = Math.max(maxLuma, luma);
        if (luma > 80) bright += 1;
      }
      return {
        meanLuma: Number((sum / Math.max(1, count)).toFixed(1)),
        brightRatio: Number((bright / Math.max(1, count)).toFixed(4)),
        maxLuma: Number(maxLuma.toFixed(1)),
      };
    },
    getPlayerPosition: () => playerState ? { x: playerState.x, z: playerState.z } : null,
    getElevationAt: (x, z) => elevationAt(x, z),
    setPlayerPosition: (x, z) => {
      if (!playerState) return null;
      const resolved = { x, z };
      playerState.x = resolved.x;
      playerState.z = resolved.z;
      playerAvatarGroup.position.set(resolved.x, elevationAt(resolved.x, resolved.z), resolved.z);
      if (cityMode === 'walk') {
        camera.position.set(resolved.x, elevationAt(resolved.x, resolved.z) + 1.68, resolved.z);
      }
      return resolved;
    },
    getNearestVehicle: () => {
      const nearest = playerState ? nearestVehicle(playerState) : null;
      return nearest ? {
        index: nearest.index,
        distance: nearest.distance,
        position: { x: nearest.vehicle.mesh.position.x, z: nearest.vehicle.mesh.position.z },
      } : null;
    },
    getTrafficPositions: () => (trafficState?.vehicles || []).map((vehicle) => ({
      x: vehicle.mesh.position.x,
      z: vehicle.mesh.position.z,
    })),
    getTrafficPathDiagnostics: () => {
      if (!trafficState) return null;
      const oneWayPaths = new Map();
      const twoWayPaths = new Map();
      for (const path of trafficState.paths) {
        const roadId = path.road?.id;
        if (roadId == null) continue;
        const bucket = path.road.oneway ? oneWayPaths : twoWayPaths;
        const list = bucket.get(roadId) || [];
        list.push(path.dir);
        bucket.set(roadId, list);
      }
      const oneWayViolations = [...oneWayPaths.entries()].filter(([, dirs]) => dirs.length !== 1);
      const twoWayViolations = [...twoWayPaths.entries()].filter(([, dirs]) => dirs.length !== 2);
      return {
        oneWayRoads: oneWayPaths.size,
        twoWayRoads: twoWayPaths.size,
        oneWayViolations: oneWayViolations.length,
        twoWayViolations: twoWayViolations.length,
      };
    },
    getSignalLegalityDiagnostics: () => {
      if (!trafficState) return null;
      let stopsOnPath = 0;
      let stopsOffPath = 0;
      let redStopsChecked = 0;
      let redStopsHonored = 0;
      let greenStopsChecked = 0;
      let greenStopsIgnored = 0;
      const time = performance.now() / 1000;
      for (const path of trafficState.paths) {
        for (const stop of path.signalStops) {
          const onPath = stop.s >= 0 && stop.s <= path.length;
          if (onPath) stopsOnPath += 1;
          else stopsOffPath += 1;
          const phase = signalPhaseAt(0, time, stop.offset);
          if (phase === 'red') {
            redStopsChecked += 1;
            const near = path.length ? stop.s / path.length : 0;
            if (near >= 0 && near <= 1) redStopsHonored += 1;
          } else if (phase === 'green' || phase === 'yellow') {
            greenStopsChecked += 1;
            greenStopsIgnored += 1;
          }
        }
      }
      return {
        stopsOnPath,
        stopsOffPath,
        redStopsChecked,
        redStopsHonored,
        greenStopsChecked,
        greenStopsIgnored,
        legal: stopsOffPath === 0 && redStopsChecked === redStopsHonored && greenStopsChecked === greenStopsIgnored,
      };
    },
    showInspector,
  };
  renderLoop();
}

start();
