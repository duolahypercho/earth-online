import * as THREE from 'three';
import {
  DISTRICT_MASSING_LIMITS,
  generateDistrictMassing,
  getPalette,
  getSharedGeometryPools,
} from './district_massing.js';

const DEFAULT_SECTOR_SIZE = 384;
const DEFAULT_DETAIL_RADIUS = 1;
const DEFAULT_PROXY_RADIUS = 3;
const MAX_BACKGROUND_STATES = 96;
const MAX_HANDOFF_QUEUE = 32;
const MAX_DETAILED_SECTORS = 12;
const MAX_PROXY_SECTORS = 44;
const MAX_BACKGROUND_UPDATES_PER_TICK = 8;
const MAX_DETAIL_RADIUS = 2;
const MAX_PROXY_RADIUS = 4;
const DETAIL_STYLES = Object.freeze(['box', 'setback', 'tapered', 'rowhouse']);
const STREAMING_ROAD_WIDTH = 12;
// Opt-in QA travel uses this one bounded east/west civic avenue. It is wider
// than the regular grid road so a trailing camera can show public space and
// façades together instead of looking down a 12 m service gap. Generated lots
// that would overlap this span are withheld only while the QA route is active.
const QA_PUBLIC_CORRIDOR_WIDTH = 56;
const QA_PUBLIC_CORRIDOR_HALF_WIDTH = QA_PUBLIC_CORRIDOR_WIDTH * 0.5;
const QA_PUBLIC_CORRIDOR_CLEARANCE = 2;
const GROUND_EDGE_OVERLAP = 12;
const GROUND_TRANSITION_DEPTH = 42;
const GROUND_SURFACE_OFFSET = 0.014;
const WATERFRONT_EDGE_DISTANCE = 260;
const WATERFRONT_TIDAL_INSET = 18;
const WATERFRONT_WATER_EXTENT = 248;
const WATERFRONT_SURFACE_OFFSET = 0.036;
const STREAMING_GRID_DIVISIONS = DISTRICT_MASSING_LIMITS.detail.columns;
const SIDEWALK_WIDTH = 4;
const SIDEWALK_HEIGHT = 0.14;
const SIDEWALK_FURNISHING_WIDTH = 0.72;
const SIDEWALK_JOINT_SPACING = 6;
const SIDEWALK_JOINT_WIDTH = 0.035;
const GUTTER_WIDTH = 0.52;
const PARKING_LANE_DEPTH = 2.2;
const PARKING_EDGE_WIDTH = 0.075;
const PARKING_EDGE_DASH_LENGTH = 2.4;
const PARKING_EDGE_DASH_GAP = 3.6;
const SURFACE_PATCH_SIZE = 8;
const ROAD_MARKING_PATCH_SIZE = 2;
const ROAD_MARKING_SURFACE_OFFSET = 0.026;
const CROSSWALK_STRIPE_WIDTH = 0.45;
const CROSSWALK_STRIPE_GAP = 0.35;
const CROSSWALK_CURB_INSET = 0.15;
const CROSSWALK_INTERSECTION_SETBACK = 0.6;
const CENTER_MARK_WIDTH = 0.15;
const CENTER_MARK_LENGTH = 3;
// A regular 9 m dash cadence keeps lane-paint rhythm consistent when the same
// street crosses from one streamed slot into the next instead of restarting
// its pattern at every sector edge.
const CENTER_MARK_GAP = 6;
const ROAD_ASPHALT_COLOR = new THREE.Color(0x454a4b);
const ROAD_MARKING_COLOR = new THREE.Color(0xfff3d6);
const ROAD_GUTTER_COLOR = new THREE.Color(0x343a3b);
const PARKING_EDGE_COLOR = new THREE.Color(0xa8aaa4);
const SIDEWALK_WALK_COLOR = new THREE.Color(0xb7b1a6);
const SIDEWALK_FURNISHING_COLOR = new THREE.Color(0x92958d);
const SIDEWALK_JOINT_COLOR = new THREE.Color(0x777b77);
const SIDEWALK_TACTILE_COLOR = new THREE.Color(0xc4a75d);
const FRONTAGE_PLINTH_COLOR = new THREE.Color(0x77766e);
const FRONTAGE_FRAME_COLOR = new THREE.Color(0x4e5959);
const FRONTAGE_GLASS_COLOR = new THREE.Color(0x38515a);
const FRONTAGE_DOOR_COLOR = new THREE.Color(0x674b40);
const FRONTAGE_TRANSOM_COLOR = new THREE.Color(0xb4aa99);
const BLOCK_INFILL_COLORS = Object.freeze([
  new THREE.Color(0x59645d),
  new THREE.Color(0x696b64),
]);
const TRANSIT_STOP_X = 72.05;
const TRANSIT_STOP_Z = -25.15;
const STREAMING_STREETLIGHT_HEIGHT = 4.2;
const STREAMING_STREETLIGHT_CAPACITY = 32;
const STREAMING_STREETSCAPE_CAPACITY = 48;
const STREETSCAPE_PARK_DISTRICTS = new Set([
  'Golden Gate',
  'Presidio',
  'Presidio Heights',
  'Richmond',
]);
const STREETSCAPE_WINDSWEPT_DISTRICTS = new Set([
  'Marina / Fisherman’s Wharf',
  'Outer Sunset',
  'Sunset',
]);
const STREETSCAPE_URBAN_DISTRICTS = new Set([
  'Bayview',
  'Financial District',
  'Mission Bay',
  'SoMa',
]);
const STREETSCAPE_PROFILES = Object.freeze({
  park: Object.freeze({
    extraCadence: 3,
    skipCadence: 0,
    scaleX: 1.02,
    scaleY: 1.14,
    scaleZ: 1.02,
    tint: 0xe2eadc,
    pavingTint: 0xd8dfd2,
  }),
  windswept: Object.freeze({
    extraCadence: 0,
    skipCadence: 6,
    scaleX: 1.22,
    scaleY: 0.82,
    scaleZ: 0.78,
    tint: 0xd8dfcf,
    pavingTint: 0xd9d4c6,
  }),
  urban: Object.freeze({
    extraCadence: 0,
    skipCadence: 4,
    scaleX: 0.88,
    scaleY: 0.9,
    scaleZ: 0.88,
    tint: 0xd5dbd0,
    pavingTint: 0xcbd1d0,
  }),
  neighborhood: Object.freeze({
    extraCadence: 0,
    skipCadence: 0,
    scaleX: 0.96,
    scaleY: 1,
    scaleZ: 0.96,
    tint: 0xeff0df,
    pavingTint: 0xddd6ca,
  }),
});
const CABLE_ROUTE_DISTRICTS = new Set([
  'Civic Center',
  'Pacific Heights',
  'North Beach',
  'Presidio Heights',
  'Presidio',
]);
const HERO_BLOCK_SECTOR_KEY = '1:0';
// The hero slice follows the four 64 m Civic Center frontage cells immediately
// east of the authored-core seam. Each cell leaves the 12 m cross street open
// so the pooled road mesh, storefronts, and corners read as one block system.
const HERO_FRONTAGE_SEGMENTS = Object.freeze([
  Object.freeze({ minX: -184, maxX: -136 }),
  Object.freeze({ minX: -120, maxX: -72 }),
  Object.freeze({ minX: -56, maxX: -8 }),
  Object.freeze({ minX: 8, maxX: 56 }),
]);
const HERO_FRONTAGE_COLORS = Object.freeze({
  paving: new THREE.Color(0x68716c),
  pavingInset: new THREE.Color(0x59635f),
  planter: new THREE.Color(0x53615b),
  planterSoil: new THREE.Color(0x493e31),
  curb: new THREE.Color(0xb1ab9d),
  stone: new THREE.Color(0x9c8e7d),
  stoneLight: new THREE.Color(0xc8bca8),
  stoneDark: new THREE.Color(0x665e57),
  roof: new THREE.Color(0x3d4648),
  window: new THREE.Color(0x263b42),
  windowLight: new THREE.Color(0x82918d),
  door: new THREE.Color(0x4b3530),
  transit: new THREE.Color(0xa64249),
  transitLight: new THREE.Color(0xe9d8b3),
});
// Four lower faces, four upper faces, and one street entrance. This remains a
// fixed per-slot allocation: 36 buildings × 9 planes, with no runtime growth.
const STREAMING_FACADE_LAYERS_PER_BUILDING = 9;
const STREAMING_FACADE_CAPACITY = DISTRICT_MASSING_LIMITS.detail.maxBuildings
  * STREAMING_FACADE_LAYERS_PER_BUILDING;
const FACADE_SURFACE_OFFSET = 0.045;
const FACADE_ENTRANCE_SURFACE_OFFSET = 0.072;
const STREAMING_FACADE_ATLAS_URL = new URL(
  '../assets/streaming/sf-facade-atlas.jpg',
  import.meta.url,
).href;
const FACADE_CELLS_BY_PALETTE = Object.freeze({
  victorian: Object.freeze([0]),
  'masonry-warm': Object.freeze([0, 1]),
  'brick-industrial': Object.freeze([1]),
  stucco: Object.freeze([2, 0]),
  'modern-white': Object.freeze([2, 3]),
  'concrete-mid': Object.freeze([2, 3]),
  'glass-tower': Object.freeze([3, 1]),
  'limestone-tower': Object.freeze([3, 2]),
  'steel-tower': Object.freeze([3, 1]),
  'masonry-cool': Object.freeze([3, 2]),
});
const FACADE_BAY_WIDTH_BY_CELL = Object.freeze([4.6, 4.8, 4.2, 4.35]);
const FACADE_ENTRANCE_WIDTH_BY_CELL = Object.freeze([3.8, 4.6, 3.5, 4.2]);
// Palette still chooses a compatible facade family; this small deterministic
// offset keeps neighboring districts legible where their palettes overlap.
const DISTRICT_FACADE_CELL_OFFSETS = Object.freeze({
  'Financial District': 1,
  SoMa: 0,
  'North Beach': 1,
  'Pacific Heights': 0,
  'Marina / Fisherman’s Wharf': 1,
  Sunset: 0,
  'Outer Sunset': 1,
  Richmond: 0,
  Mission: 1,
  'Castro / Noe Valley': 0,
  'Civic Center': 1,
  Presidio: 0,
  'Presidio Heights': 1,
  Bayview: 0,
  Excelsior: 1,
  'Mission Bay': 0,
  'Golden Gate': 1,
});
const DETAIL_RETENTION_DISTANCE = 2;
// The authored core's public streaming datum is Y=0, but its visible terrain
// is graded. Keep the first generated apron on that same shallow visual grade
// instead of exposing a vertical step before the streamed tile reaches its
// own terrain datum.
const AUTHORED_CORE_GRADE_X = 0.022;
const AUTHORED_CORE_GRADE_Z = 0.042;
const AUTHORED_CORE_GROUND_OFFSET = -0.16;
const MASSING_CAPACITY_STATS = Object.freeze({
  detailMaxBuildings: DISTRICT_MASSING_LIMITS.detail.maxBuildings,
  detailInstanceCapacityPerStyle: DISTRICT_MASSING_LIMITS.detail.maxBuildings,
  detailStyles: DETAIL_STYLES,
  detailFacadePlaneCapacity: STREAMING_FACADE_CAPACITY,
  detailFacadePlanesPerBuilding: STREAMING_FACADE_LAYERS_PER_BUILDING,
  proxyMaxBuildings: DISTRICT_MASSING_LIMITS.proxy.maxBuildings,
  proxyInstanceCapacity: DISTRICT_MASSING_LIMITS.proxy.maxBuildings,
});
const HANDOFF_DIRECTIONS = [
  { id: 'east', x: 1, z: 0 },
  { id: 'north', x: 0, z: 1 },
  { id: 'west', x: -1, z: 0 },
  { id: 'south', x: 0, z: -1 },
];

// A 121 km² local-space footprint, close to San Francisco's land area. The
// outline is deliberately coarse: it is a streaming boundary, not survey
// geometry. District GIS data can later refine the shoreline sector by sector.
const SF_FOOTPRINT = [
  [-2850, -5250],
  [2050, -5250],
  [2920, -3950],
  [3450, -1550],
  [3360, 850],
  [2420, 3250],
  [850, 5050],
  [-950, 5350],
  [-2600, 4200],
  [-3400, 1750],
  [-3540, -1850],
].map(([x, z]) => [x * 1.5, z * 1.32]);

function hashSector(x, z) {
  let hash = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b);
  hash ^= Math.imul(z ^ 0xc2b2ae35, 0x27d4eb2f);
  hash ^= hash >>> 15;
  return hash >>> 0;
}

function seededValue(seed, index) {
  let value = seed + Math.imul(index + 1, 0x6d2b79f5);
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function parseSectorKey(key) {
  const [x, z] = String(key).split(':').map(Number);
  return Number.isInteger(x) && Number.isInteger(z) ? { x, z } : null;
}

function distanceToBuildingVolume(point, volume) {
  const dx = Math.max(volume.min.x - point.x, 0, point.x - volume.max.x);
  const dy = Math.max(volume.min.y - point.y, 0, point.y - volume.max.y);
  const dz = Math.max(volume.min.z - point.z, 0, point.z - volume.max.z);
  return Math.hypot(dx, dy, dz);
}

function segmentBuildingIntersectionDistance(origin, direction, length, volume) {
  let near = 0;
  let far = length;
  for (const axis of ['x', 'y', 'z']) {
    const component = direction[axis];
    if (Math.abs(component) < 1e-8) {
      if (origin[axis] < volume.min[axis] || origin[axis] > volume.max[axis]) {
        return null;
      }
      continue;
    }
    const inverse = 1 / component;
    let first = (volume.min[axis] - origin[axis]) * inverse;
    let second = (volume.max[axis] - origin[axis]) * inverse;
    if (first > second) [first, second] = [second, first];
    near = Math.max(near, first);
    far = Math.min(far, second);
    if (near > far) return null;
  }
  return near <= length && far >= 0 ? Math.max(0, near) : null;
}

function portalIdBetween(keyA, keyB) {
  const a = parseSectorKey(keyA);
  const b = parseSectorKey(keyB);
  if (!a || !b || Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== 1) return null;
  if (a.z === b.z) return `sf-portal:ew:${Math.min(a.x, b.x)}:${a.z}`;
  return `sf-portal:ns:${a.x}:${Math.min(a.z, b.z)}`;
}

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    const intersects = ((zi > z) !== (zj > z))
      && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonArea(polygon) {
  let doubleArea = 0;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    doubleArea += polygon[previous][0] * polygon[index][1]
      - polygon[index][0] * polygon[previous][1];
  }
  return Math.abs(doubleArea) * 0.5;
}

function polygonSignedArea(polygon) {
  let doubleArea = 0;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    doubleArea += polygon[previous][0] * polygon[index][1]
      - polygon[index][0] * polygon[previous][1];
  }
  return doubleArea * 0.5;
}

function createWaterfrontEdges(footprint) {
  const outwardNormalSign = polygonSignedArea(footprint) > 0 ? -1 : 1;
  return footprint.map((end, index) => {
    const start = footprint[(index + footprint.length - 1) % footprint.length];
    const deltaX = end[0] - start[0];
    const deltaZ = end[1] - start[1];
    const length = Math.hypot(deltaX, deltaZ) || 1;
    return Object.freeze({
      start: Object.freeze({ x: start[0], z: start[1] }),
      end: Object.freeze({ x: end[0], z: end[1] }),
      deltaX,
      deltaZ,
      lengthSquared: deltaX * deltaX + deltaZ * deltaZ,
      outwardNormal: Object.freeze({
        x: (-deltaZ / length) * outwardNormalSign,
        z: (deltaX / length) * outwardNormalSign,
      }),
    });
  });
}

function getWaterfrontEdge(x, z, edges) {
  let closest = null;
  let closestDistanceSquared = Number.POSITIVE_INFINITY;
  edges.forEach((edge) => {
    const t = edge.lengthSquared > 0
      ? THREE.MathUtils.clamp(
        ((x - edge.start.x) * edge.deltaX + (z - edge.start.z) * edge.deltaZ)
          / edge.lengthSquared,
        0,
        1,
      )
      : 0;
    const pointX = edge.start.x + edge.deltaX * t;
    const pointZ = edge.start.z + edge.deltaZ * t;
    const distanceSquared = (x - pointX) ** 2 + (z - pointZ) ** 2;
    if (distanceSquared < closestDistanceSquared) {
      closestDistanceSquared = distanceSquared;
      closest = {
        x: pointX,
        z: pointZ,
        distance: Math.sqrt(distanceSquared),
        start: edge.start,
        end: edge.end,
        outwardNormal: edge.outwardNormal,
      };
    }
  });
  return closest;
}

function districtForPosition(x, z) {
  if (z < -3600) return x < -900 ? 'Outer Sunset' : x > 1500 ? 'Bayview' : 'Excelsior';
  if (z < -1900) return x < -1200 ? 'Sunset' : x > 1300 ? 'Mission Bay' : 'Mission';
  if (z < -350) return x < -1200 ? 'Richmond' : x > 1500 ? 'SoMa' : 'Castro / Noe Valley';
  if (z < 1250) return x < -1200 ? 'Presidio Heights' : x > 1450 ? 'Financial District' : 'Civic Center';
  if (z < 2700) return x < -700 ? 'Presidio' : x > 1300 ? 'North Beach' : 'Pacific Heights';
  return x > 450 ? 'Marina / Fisherman’s Wharf' : 'Golden Gate';
}

function absoluteTerrainForPosition(x, z) {
  const ridge = Math.sin((x + 850) * 0.00072) * 42;
  const crossSlope = Math.cos((z - 600) * 0.00058) * 31;
  return ridge + crossSlope + 34;
}

function smoothstep(edge0, edge1, value) {
  const normalized = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

export function createSanFranciscoSectorCatalog({
  sectorSize = DEFAULT_SECTOR_SIZE,
  footprint = SF_FOOTPRINT,
  maxCachedDescriptors = 256,
} = {}) {
  const descriptors = new Map();
  const xs = footprint.map(([x]) => x);
  const zs = footprint.map(([, z]) => z);
  const minSectorX = Math.floor(Math.min(...xs) / sectorSize);
  const maxSectorX = Math.ceil(Math.max(...xs) / sectorSize);
  const minSectorZ = Math.floor(Math.min(...zs) / sectorSize);
  const maxSectorZ = Math.ceil(Math.max(...zs) / sectorSize);
  const originElevation = absoluteTerrainForPosition(0, 0);
  const waterfrontEdges = createWaterfrontEdges(footprint);

  const getSurfaceHeight = (positionOrX, optionalZ) => {
    const x = typeof positionOrX === 'number' ? positionOrX : positionOrX?.x;
    const z = typeof positionOrX === 'number' ? optionalZ : positionOrX?.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    if (!pointInPolygon(x, z, footprint)) return null;

    // The current authored district was built around local Y=0. Keep that
    // entire hero sector flat, then blend smoothly into the city-scale hills
    // over the next sector so travel never hits a vertical datum step.
    const distanceFromCore = Math.max(Math.abs(x), Math.abs(z));
    const coreBlend = smoothstep(sectorSize * 0.5, sectorSize * 1.5, distanceFromCore);
    const terrainHeight = absoluteTerrainForPosition(x, z) - originElevation;
    const shoreline = getWaterfrontEdge(x, z, waterfrontEdges);
    // Pull the last 260 m of land toward a restrained tidal shelf. It creates
    // a legible waterfront grade without altering the authored core datum or
    // introducing a sector-local height discontinuity.
    const shoreBlend = shoreline
      ? 1 - smoothstep(20, WATERFRONT_EDGE_DISTANCE, shoreline.distance)
      : 0;
    const tidalShelf = -5 + Math.sin((x - z) * 0.0014) * 0.65;
    return THREE.MathUtils.lerp(terrainHeight, tidalShelf, shoreBlend) * coreBlend;
  };

  const isValid = (sectorX, sectorZ) => {
    const centerX = sectorX * sectorSize;
    const centerZ = sectorZ * sectorSize;
    return pointInPolygon(centerX, centerZ, footprint);
  };

  const get = (sectorX, sectorZ) => {
    if (!isValid(sectorX, sectorZ)) return null;
    const key = `${sectorX}:${sectorZ}`;
    if (descriptors.has(key)) {
      const cached = descriptors.get(key);
      descriptors.delete(key);
      descriptors.set(key, cached);
      return cached;
    }
    const seed = hashSector(sectorX, sectorZ);
    const center = Object.freeze({
      x: sectorX * sectorSize,
      z: sectorZ * sectorSize,
    });
    const shoreline = getWaterfrontEdge(center.x, center.z, waterfrontEdges);
    const waterfront = shoreline && shoreline.distance <= WATERFRONT_EDGE_DISTANCE
      ? Object.freeze({
        distance: shoreline.distance,
        point: Object.freeze({ x: shoreline.x, z: shoreline.z }),
        start: Object.freeze(shoreline.start),
        end: Object.freeze(shoreline.end),
        outwardNormal: Object.freeze(shoreline.outwardNormal),
      })
      : null;
    const descriptor = Object.freeze({
      key,
      sectorX,
      sectorZ,
      center,
      seed,
      district: districtForPosition(center.x, center.z),
      elevation: getSurfaceHeight(center) ?? 0,
      waterfront,
      // Generated massing is an honest placeholder. Surveyed geometry can
      // replace it through registerSectorFactory without changing streaming.
      source: key === '0:0' ? 'authored-core' : 'generated-massing',
    });
    descriptors.set(key, descriptor);
    while (descriptors.size > maxCachedDescriptors) {
      descriptors.delete(descriptors.keys().next().value);
    }
    return descriptor;
  };

  let totalSectors = 0;
  for (let sectorZ = minSectorZ; sectorZ <= maxSectorZ; sectorZ += 1) {
    for (let sectorX = minSectorX; sectorX <= maxSectorX; sectorX += 1) {
      if (isValid(sectorX, sectorZ)) totalSectors += 1;
    }
  }

  return {
    sectorSize,
    bounds: Object.freeze({ minSectorX, maxSectorX, minSectorZ, maxSectorZ }),
    totalSectors,
    footprintAreaKm2: polygonArea(footprint) / 1_000_000,
    originElevation,
    maxCachedDescriptors,
    get,
    getSurfaceHeight,
    containsPosition(x, z) {
      return Number.isFinite(x) && Number.isFinite(z) && pointInPolygon(x, z, footprint);
    },
    isValid,
    sectorAt(position) {
      return {
        x: Math.round(position.x / sectorSize),
        z: Math.round(position.z / sectorSize),
      };
    },
    get loadedDescriptorCount() {
      return descriptors.size;
    },
  };
}

function appendSurfaceQuad(positions, a, b, c, d, colors = null, color = null) {
  positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  if (colors && color) {
    for (let vertex = 0; vertex < 6; vertex += 1) {
      colors.push(color.r, color.g, color.b);
    }
  }
}

function getAnchoredStops(minimum, maximum, maximumStep) {
  const stops = [minimum];
  const firstAnchor = Math.ceil((minimum + 1e-7) / maximumStep) * maximumStep;
  for (let value = firstAnchor; value < maximum - 1e-7; value += maximumStep) {
    if (value > minimum + 1e-7) stops.push(value);
  }
  stops.push(maximum);
  return stops;
}

function appendHorizontalRect(
  positions,
  minX,
  maxX,
  y,
  minZ,
  maxZ,
  maximumStep = SURFACE_PATCH_SIZE,
  colors = null,
  color = null,
) {
  const xs = getAnchoredStops(minX, maxX, maximumStep);
  const zs = getAnchoredStops(minZ, maxZ, maximumStep);
  for (let zIndex = 0; zIndex < zs.length - 1; zIndex += 1) {
    for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
      appendSurfaceQuad(
        positions,
        [xs[xIndex], y, zs[zIndex]],
        [xs[xIndex], y, zs[zIndex + 1]],
        [xs[xIndex + 1], y, zs[zIndex + 1]],
        [xs[xIndex + 1], y, zs[zIndex]],
        colors,
        color,
      );
    }
  }
}

function getStreetGridLines(sectorSize) {
  const half = sectorSize * 0.5;
  const step = sectorSize / STREAMING_GRID_DIVISIONS;
  return Array.from(
    { length: STREAMING_GRID_DIVISIONS + 1 },
    (_, index) => -half + step * index,
  );
}

function getStreetWidth(line, centerWidth) {
  return Math.abs(line) < 0.001 ? centerWidth : STREAMING_ROAD_WIDTH;
}

function createRoadLatticeGeometry(
  sectorSize,
  eastWestWidth = STREAMING_ROAD_WIDTH,
  northSouthWidth = STREAMING_ROAD_WIDTH,
) {
  const half = sectorSize * 0.5;
  const lines = getStreetGridLines(sectorSize);
  const positions = [];
  const colors = [];

  // Horizontal streets own every intersection. Vertical streets are split
  // into the gaps between them so the one pooled mesh has no coplanar overlap.
  const horizontalIntervals = lines.map((line) => {
    const roadHalf = getStreetWidth(line, eastWestWidth) * 0.5;
    const minZ = Math.max(-half, line - roadHalf);
    const maxZ = Math.min(half, line + roadHalf);
    for (let index = 0; index < lines.length - 1; index += 1) {
      appendHorizontalRect(
        positions,
        lines[index],
        lines[index + 1],
        0,
        minZ,
        maxZ,
        SURFACE_PATCH_SIZE,
        colors,
        ROAD_ASPHALT_COLOR,
      );
    }
    return [minZ, maxZ];
  });

  const verticalRanges = [];
  let rangeStart = -half;
  horizontalIntervals.forEach(([minZ, maxZ]) => {
    if (minZ > rangeStart) verticalRanges.push([rangeStart, minZ]);
    rangeStart = Math.max(rangeStart, maxZ);
  });
  if (rangeStart < half) verticalRanges.push([rangeStart, half]);

  lines.forEach((line) => {
    const roadHalf = getStreetWidth(line, northSouthWidth) * 0.5;
    const minX = Math.max(-half, line - roadHalf);
    const maxX = Math.min(half, line + roadHalf);
    verticalRanges.forEach(([minZ, maxZ]) => {
      appendHorizontalRect(
        positions,
        minX,
        maxX,
        0,
        minZ,
        maxZ,
        SURFACE_PATCH_SIZE,
        colors,
        ROAD_ASPHALT_COLOR,
      );
    });
  });

  appendRoadMarkings(
    positions,
    colors,
    sectorSize,
    eastWestWidth,
    northSouthWidth,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function appendCuboid(
  positions,
  minX,
  maxX,
  minY,
  maxY,
  minZ,
  maxZ,
  colors = null,
  color = null,
) {
  appendHorizontalRect(
    positions,
    minX,
    maxX,
    maxY,
    minZ,
    maxZ,
    SURFACE_PATCH_SIZE,
    colors,
    color,
  );
  const xs = getAnchoredStops(minX, maxX, SURFACE_PATCH_SIZE);
  const zs = getAnchoredStops(minZ, maxZ, SURFACE_PATCH_SIZE);
  for (let zIndex = 0; zIndex < zs.length - 1; zIndex += 1) {
    for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
      appendSurfaceQuad(positions,
        [xs[xIndex], minY, zs[zIndex + 1]],
        [xs[xIndex], minY, zs[zIndex]],
        [xs[xIndex + 1], minY, zs[zIndex]],
        [xs[xIndex + 1], minY, zs[zIndex + 1]],
        colors,
        color);
    }
  }
  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    appendSurfaceQuad(positions,
      [xs[xIndex], minY, maxZ],
      [xs[xIndex + 1], minY, maxZ],
      [xs[xIndex + 1], maxY, maxZ],
      [xs[xIndex], maxY, maxZ],
      colors,
      color);
    appendSurfaceQuad(positions,
      [xs[xIndex + 1], minY, minZ],
      [xs[xIndex], minY, minZ],
      [xs[xIndex], maxY, minZ],
      [xs[xIndex + 1], maxY, minZ],
      colors,
      color);
  }
  for (let zIndex = 0; zIndex < zs.length - 1; zIndex += 1) {
    appendSurfaceQuad(positions,
      [maxX, minY, zs[zIndex + 1]],
      [maxX, minY, zs[zIndex]],
      [maxX, maxY, zs[zIndex]],
      [maxX, maxY, zs[zIndex + 1]],
      colors,
      color);
    appendSurfaceQuad(positions,
      [minX, minY, zs[zIndex]],
      [minX, minY, zs[zIndex + 1]],
      [minX, maxY, zs[zIndex + 1]],
      [minX, maxY, zs[zIndex]],
      colors,
      color);
  }
}

function appendTriangle(positions, a, b, c, colors = null, color = null) {
  positions.push(...a, ...b, ...c);
  if (colors && color) {
    for (let vertex = 0; vertex < 3; vertex += 1) {
      colors.push(color.r, color.g, color.b);
    }
  }
}

function appendRadialFrustum(
  positions,
  colors,
  minY,
  maxY,
  bottomRadius,
  topRadius,
  color,
  sides = 6,
  phase = Math.PI / 6,
) {
  for (let side = 0; side < sides; side += 1) {
    const angle = phase + side / sides * Math.PI * 2;
    const nextAngle = phase + (side + 1) / sides * Math.PI * 2;
    const bottom = [Math.cos(angle) * bottomRadius, minY, Math.sin(angle) * bottomRadius];
    const nextBottom = [
      Math.cos(nextAngle) * bottomRadius,
      minY,
      Math.sin(nextAngle) * bottomRadius,
    ];
    const top = [Math.cos(angle) * topRadius, maxY, Math.sin(angle) * topRadius];
    const nextTop = [
      Math.cos(nextAngle) * topRadius,
      maxY,
      Math.sin(nextAngle) * topRadius,
    ];
    appendSurfaceQuad(positions, bottom, top, nextTop, nextBottom, colors, color);
    appendTriangle(
      positions,
      [0, maxY, 0],
      nextTop,
      top,
      colors,
      color,
    );
  }
}

function appendFlatMarking(positions, colors, minX, maxX, minZ, maxZ) {
  appendHorizontalRect(
    positions,
    minX,
    maxX,
    ROAD_MARKING_SURFACE_OFFSET,
    minZ,
    maxZ,
    ROAD_MARKING_PATCH_SIZE,
    colors,
    ROAD_MARKING_COLOR,
  );
}

function appendRoadMarkings(
  positions,
  colors,
  sectorSize,
  eastWestWidth,
  northSouthWidth,
  surfaceY = 0,
) {
  const lines = getStreetGridLines(sectorSize);
  const half = sectorSize * 0.5;
  const stripePitch = CROSSWALK_STRIPE_WIDTH + CROSSWALK_STRIPE_GAP;
  const crossingWidth = CROSSWALK_STRIPE_WIDTH * 5 + CROSSWALK_STRIPE_GAP * 4;
  const appendClippedMarking = (minX, maxX, minZ, maxZ) => {
    const clippedMinX = Math.max(-half, minX);
    const clippedMaxX = Math.min(half, maxX);
    const clippedMinZ = Math.max(-half, minZ);
    const clippedMaxZ = Math.min(half, maxZ);
    if (clippedMaxX <= clippedMinX || clippedMaxZ <= clippedMinZ) return;
    appendFlatMarking(
      positions,
      colors,
      clippedMinX,
      clippedMaxX,
      clippedMinZ,
      clippedMaxZ,
    );
  };

  // Boundary junctions are clipped to the local half-tile. The adjoining
  // tile contributes the complementary half, so crosswalks continue through
  // every streamed road seam without duplicate coplanar paint.
  lines.forEach((zLine) => {
    lines.forEach((xLine) => {
      const verticalRoadHalf = getStreetWidth(xLine, northSouthWidth) * 0.5;
      const horizontalRoadHalf = getStreetWidth(zLine, eastWestWidth) * 0.5;
      const verticalCrossingLength = verticalRoadHalf * 2 - CROSSWALK_CURB_INSET * 2;
      const horizontalCrossingLength = horizontalRoadHalf * 2 - CROSSWALK_CURB_INSET * 2;
      for (let stripe = 0; stripe < 5; stripe += 1) {
        const stripeOffset = -crossingWidth * 0.5
          + CROSSWALK_STRIPE_WIDTH * 0.5
          + stripe * stripePitch;
        for (const side of [-1, 1]) {
          const crossingZ = zLine
            + side * (
              horizontalRoadHalf + CROSSWALK_INTERSECTION_SETBACK + crossingWidth * 0.5
            );
          appendClippedMarking(
            xLine - verticalCrossingLength * 0.5,
            xLine + verticalCrossingLength * 0.5,
            crossingZ + stripeOffset - CROSSWALK_STRIPE_WIDTH * 0.5,
            crossingZ + stripeOffset + CROSSWALK_STRIPE_WIDTH * 0.5,
          );
          const crossingX = xLine
            + side * (
              verticalRoadHalf + CROSSWALK_INTERSECTION_SETBACK + crossingWidth * 0.5
            );
          appendClippedMarking(
            crossingX + stripeOffset - CROSSWALK_STRIPE_WIDTH * 0.5,
            crossingX + stripeOffset + CROSSWALK_STRIPE_WIDTH * 0.5,
            zLine - horizontalCrossingLength * 0.5,
            zLine + horizontalCrossingLength * 0.5,
          );
        }
      }
    });
  });

  // Each slot owns the half of a boundary dash that lies inside its extent.
  // The neighboring slot contributes the other half, which removes the bare
  // stripe at streaming seams without coplanar overlap.
  lines.forEach((line) => {
    for (let interval = 0; interval < lines.length - 1; interval += 1) {
      const horizontalStart = lines[interval]
        + getStreetWidth(lines[interval], northSouthWidth) * 0.5
        + CROSSWALK_STRIPE_WIDTH;
      const horizontalEnd = lines[interval + 1]
        - getStreetWidth(lines[interval + 1], northSouthWidth) * 0.5
        - CROSSWALK_STRIPE_WIDTH;
      for (
        let markStart = horizontalStart;
        markStart + CENTER_MARK_LENGTH <= horizontalEnd;
        markStart += CENTER_MARK_LENGTH + CENTER_MARK_GAP
      ) {
        appendClippedMarking(
          markStart,
          markStart + CENTER_MARK_LENGTH,
          line - CENTER_MARK_WIDTH * 0.5,
          line + CENTER_MARK_WIDTH * 0.5,
        );
      }

      const verticalStart = lines[interval]
        + getStreetWidth(lines[interval], eastWestWidth) * 0.5
        + CROSSWALK_STRIPE_WIDTH;
      const verticalEnd = lines[interval + 1]
        - getStreetWidth(lines[interval + 1], eastWestWidth) * 0.5
        - CROSSWALK_STRIPE_WIDTH;
      for (
        let markStart = verticalStart;
        markStart + CENTER_MARK_LENGTH <= verticalEnd;
        markStart += CENTER_MARK_LENGTH + CENTER_MARK_GAP
      ) {
        appendClippedMarking(
          line - CENTER_MARK_WIDTH * 0.5,
          line + CENTER_MARK_WIDTH * 0.5,
          markStart,
          markStart + CENTER_MARK_LENGTH,
        );
      }
    }
  });
}

function appendRoadEdgeDetails(
  positions,
  colors,
  sectorSize,
  eastWestWidth,
  northSouthWidth,
  surfaceY = 0,
) {
  const lines = getStreetGridLines(sectorSize);
  const half = sectorSize * 0.5;
  const appendDetail = (minX, maxX, minZ, maxZ, color) => {
    const clippedMinX = Math.max(-half, minX);
    const clippedMaxX = Math.min(half, maxX);
    const clippedMinZ = Math.max(-half, minZ);
    const clippedMaxZ = Math.min(half, maxZ);
    if (clippedMaxX <= clippedMinX || clippedMaxZ <= clippedMinZ) return;
    appendHorizontalRect(
      positions,
      clippedMinX,
      clippedMaxX,
      surfaceY,
      clippedMinZ,
      clippedMaxZ,
      SURFACE_PATCH_SIZE,
      colors,
      color,
    );
  };
  const appendParkingDashes = (start, end, appendDash) => {
    for (
      let dashStart = start + 0.8;
      dashStart < end - 0.8;
      dashStart += PARKING_EDGE_DASH_LENGTH + PARKING_EDGE_DASH_GAP
    ) {
      appendDash(dashStart, Math.min(end - 0.8, dashStart + PARKING_EDGE_DASH_LENGTH));
    }
  };

  lines.forEach((zLine) => {
    const roadHalf = getStreetWidth(zLine, eastWestWidth) * 0.5;
    for (let interval = 0; interval < lines.length - 1; interval += 1) {
      const start = lines[interval]
        + getStreetWidth(lines[interval], northSouthWidth) * 0.5;
      const end = lines[interval + 1]
        - getStreetWidth(lines[interval + 1], northSouthWidth) * 0.5;
      if (end <= start) continue;
      for (const side of [-1, 1]) {
        const curb = zLine + side * roadHalf;
        appendDetail(
          start,
          end,
          Math.min(curb, curb - side * GUTTER_WIDTH),
          Math.max(curb, curb - side * GUTTER_WIDTH),
          ROAD_GUTTER_COLOR,
        );
        const parkingEdge = curb - side * PARKING_LANE_DEPTH;
        appendParkingDashes(start, end, (dashStart, dashEnd) => appendDetail(
          dashStart,
          dashEnd,
          parkingEdge - PARKING_EDGE_WIDTH * 0.5,
          parkingEdge + PARKING_EDGE_WIDTH * 0.5,
          PARKING_EDGE_COLOR,
        ));
      }
    }
  });

  lines.forEach((xLine) => {
    const roadHalf = getStreetWidth(xLine, northSouthWidth) * 0.5;
    for (let interval = 0; interval < lines.length - 1; interval += 1) {
      const start = lines[interval]
        + getStreetWidth(lines[interval], eastWestWidth) * 0.5;
      const end = lines[interval + 1]
        - getStreetWidth(lines[interval + 1], eastWestWidth) * 0.5;
      if (end <= start) continue;
      for (const side of [-1, 1]) {
        const curb = xLine + side * roadHalf;
        appendDetail(
          Math.min(curb, curb - side * GUTTER_WIDTH),
          Math.max(curb, curb - side * GUTTER_WIDTH),
          start,
          end,
          ROAD_GUTTER_COLOR,
        );
        const parkingEdge = curb - side * PARKING_LANE_DEPTH;
        appendParkingDashes(start, end, (dashStart, dashEnd) => appendDetail(
          parkingEdge - PARKING_EDGE_WIDTH * 0.5,
          parkingEdge + PARKING_EDGE_WIDTH * 0.5,
          dashStart,
          dashEnd,
          PARKING_EDGE_COLOR,
        ));
      }
    }
  });
}

function createSidewalkGeometry(
  sectorSize,
  eastWestWidth = STREAMING_ROAD_WIDTH,
  northSouthWidth = STREAMING_ROAD_WIDTH,
) {
  const lines = getStreetGridLines(sectorSize);
  const positions = [];
  const colors = [];
  const appendPaving = (minX, maxX, minY, maxY, minZ, maxZ, color) => {
    appendCuboid(positions, minX, maxX, minY, maxY, minZ, maxZ, colors, color);
  };
  const appendTopDetail = (minX, maxX, minZ, maxZ, color) => {
    appendHorizontalRect(
      positions,
      minX,
      maxX,
      SIDEWALK_HEIGHT + 0.008,
      minZ,
      maxZ,
      ROAD_MARKING_PATCH_SIZE,
      colors,
      color,
    );
  };

  // A single low storefront rhythm keeps the space between curb and the
  // generated building footprints intentional even when a lot is sparse.
  // It is written into the pooled sidewalk geometry so every detailed sector
  // gets the same kit without another material, mesh, or instance budget.
  const appendFrontageEdge = (
    minX,
    maxX,
    minZ,
    maxZ,
    edge,
    variant,
  ) => {
    const horizontal = edge === 'south' || edge === 'north';
    const alongMin = (horizontal ? minX : minZ) + SIDEWALK_WIDTH + 0.72;
    const alongMax = (horizontal ? maxX : maxZ) - SIDEWALK_WIDTH - 0.72;
    if (alongMax - alongMin < 9) return;
    const frontageDepth = 0.62;
    let depthMin;
    let depthMax;
    if (horizontal) {
      if (edge === 'south') {
        depthMin = minZ + SIDEWALK_WIDTH + 0.16;
        depthMax = depthMin + frontageDepth;
      } else {
        depthMax = maxZ - SIDEWALK_WIDTH - 0.16;
        depthMin = depthMax - frontageDepth;
      }
    } else if (edge === 'west') {
      depthMin = minX + SIDEWALK_WIDTH + 0.16;
      depthMax = depthMin + frontageDepth;
    } else {
      depthMax = maxX - SIDEWALK_WIDTH - 0.16;
      depthMin = depthMax - frontageDepth;
    }

    const appendEdgeCuboid = (
      edgeMin,
      edgeMax,
      minY,
      maxY,
      color,
      extraDepthMin = depthMin,
      extraDepthMax = depthMax,
    ) => {
      if (horizontal) {
        appendPaving(
          edgeMin,
          edgeMax,
          minY,
          maxY,
          extraDepthMin,
          extraDepthMax,
          color,
        );
      } else {
        appendPaving(
          extraDepthMin,
          extraDepthMax,
          minY,
          maxY,
          edgeMin,
          edgeMax,
          color,
        );
      }
    };

    const moduleWidth = 7.2;
    const moduleGap = 1.25;
    const moduleCount = Math.max(
      1,
      Math.floor((alongMax - alongMin + moduleGap) / (moduleWidth + moduleGap)),
    );
    const usedSpan = moduleCount * moduleWidth + (moduleCount - 1) * moduleGap;
    const start = alongMin + Math.max(0, (alongMax - alongMin - usedSpan) * 0.5);
    appendEdgeCuboid(
      alongMin,
      alongMax,
      0.16,
      0.38,
      FRONTAGE_PLINTH_COLOR,
    );

    for (let module = 0; module < moduleCount; module += 1) {
      const moduleStart = start + module * (moduleWidth + moduleGap);
      const moduleEnd = moduleStart + moduleWidth;
      const isDoor = (module + variant) % 4 === 1;
      const panelColor = isDoor ? FRONTAGE_DOOR_COLOR : FRONTAGE_GLASS_COLOR;
      const panelInset = isDoor ? 1.58 : 0.48;
      appendEdgeCuboid(
        moduleStart,
        moduleStart + 0.18,
        0.38,
        1.86,
        FRONTAGE_FRAME_COLOR,
      );
      appendEdgeCuboid(
        moduleEnd - 0.18,
        moduleEnd,
        0.38,
        1.86,
        FRONTAGE_FRAME_COLOR,
      );
      appendEdgeCuboid(
        moduleStart + panelInset,
        moduleEnd - panelInset,
        0.5,
        1.56,
        panelColor,
      );
      appendEdgeCuboid(
        moduleStart + 0.18,
        moduleEnd - 0.18,
        1.58,
        1.78,
        FRONTAGE_TRANSOM_COLOR,
      );
      appendEdgeCuboid(
        moduleStart - 0.04,
        moduleStart + 0.22,
        1.78,
        1.98,
        FRONTAGE_FRAME_COLOR,
      );
    }
  };

  // Split every raised sidewalk ring into a curbside furnishing band and a
  // pedestrian clear zone. Muted block infill then turns unoccupied parcels
  // into intentional planted/hardscape space instead of exposed ground voids.
  for (let row = 0; row < STREAMING_GRID_DIVISIONS; row += 1) {
    const minZ = lines[row]
      + getStreetWidth(lines[row], eastWestWidth) * 0.5;
    const maxZ = lines[row + 1]
      - getStreetWidth(lines[row + 1], eastWestWidth) * 0.5;
    for (let column = 0; column < STREAMING_GRID_DIVISIONS; column += 1) {
      const minX = lines[column]
        + getStreetWidth(lines[column], northSouthWidth) * 0.5;
      const maxX = lines[column + 1]
        - getStreetWidth(lines[column + 1], northSouthWidth) * 0.5;
      if (maxX - minX <= SIDEWALK_WIDTH * 2
        || maxZ - minZ <= SIDEWALK_WIDTH * 2) continue;

      appendPaving(minX, maxX, GROUND_SURFACE_OFFSET, SIDEWALK_HEIGHT,
        minZ, minZ + SIDEWALK_FURNISHING_WIDTH, SIDEWALK_FURNISHING_COLOR);
      appendPaving(minX, maxX, GROUND_SURFACE_OFFSET, SIDEWALK_HEIGHT,
        minZ + SIDEWALK_FURNISHING_WIDTH, minZ + SIDEWALK_WIDTH,
        SIDEWALK_WALK_COLOR);
      appendPaving(minX, maxX, GROUND_SURFACE_OFFSET, SIDEWALK_HEIGHT,
        maxZ - SIDEWALK_WIDTH, maxZ - SIDEWALK_FURNISHING_WIDTH,
        SIDEWALK_WALK_COLOR);
      appendPaving(minX, maxX, GROUND_SURFACE_OFFSET, SIDEWALK_HEIGHT,
        maxZ - SIDEWALK_FURNISHING_WIDTH, maxZ, SIDEWALK_FURNISHING_COLOR);
      appendPaving(minX, minX + SIDEWALK_FURNISHING_WIDTH,
        GROUND_SURFACE_OFFSET, SIDEWALK_HEIGHT,
        minZ + SIDEWALK_WIDTH, maxZ - SIDEWALK_WIDTH,
        SIDEWALK_FURNISHING_COLOR);
      appendPaving(minX + SIDEWALK_FURNISHING_WIDTH, minX + SIDEWALK_WIDTH,
        GROUND_SURFACE_OFFSET, SIDEWALK_HEIGHT,
        minZ + SIDEWALK_WIDTH, maxZ - SIDEWALK_WIDTH, SIDEWALK_WALK_COLOR);
      appendPaving(maxX - SIDEWALK_WIDTH, maxX - SIDEWALK_FURNISHING_WIDTH,
        GROUND_SURFACE_OFFSET, SIDEWALK_HEIGHT,
        minZ + SIDEWALK_WIDTH, maxZ - SIDEWALK_WIDTH, SIDEWALK_WALK_COLOR);
      appendPaving(maxX - SIDEWALK_FURNISHING_WIDTH, maxX,
        GROUND_SURFACE_OFFSET, SIDEWALK_HEIGHT,
        minZ + SIDEWALK_WIDTH, maxZ - SIDEWALK_WIDTH,
        SIDEWALK_FURNISHING_COLOR);

      appendHorizontalRect(
        positions,
        minX + SIDEWALK_WIDTH,
        maxX - SIDEWALK_WIDTH,
        GROUND_SURFACE_OFFSET + 0.018,
        minZ + SIDEWALK_WIDTH,
        maxZ - SIDEWALK_WIDTH,
        SURFACE_PATCH_SIZE,
        colors,
        BLOCK_INFILL_COLORS[(row + column) % BLOCK_INFILL_COLORS.length],
      );

      appendFrontageEdge(minX, maxX, minZ, maxZ, 'south', row * 5 + column);
      appendFrontageEdge(minX, maxX, minZ, maxZ, 'north', row * 5 + column + 1);
      appendFrontageEdge(minX, maxX, minZ, maxZ, 'west', row * 7 + column + 2);
      appendFrontageEdge(minX, maxX, minZ, maxZ, 'east', row * 7 + column + 3);

      for (
        let jointX = minX + SIDEWALK_JOINT_SPACING;
        jointX < maxX - SIDEWALK_JOINT_SPACING * 0.5;
        jointX += SIDEWALK_JOINT_SPACING
      ) {
        appendTopDetail(
          jointX - SIDEWALK_JOINT_WIDTH * 0.5,
          jointX + SIDEWALK_JOINT_WIDTH * 0.5,
          minZ,
          minZ + SIDEWALK_WIDTH,
          SIDEWALK_JOINT_COLOR,
        );
        appendTopDetail(
          jointX - SIDEWALK_JOINT_WIDTH * 0.5,
          jointX + SIDEWALK_JOINT_WIDTH * 0.5,
          maxZ - SIDEWALK_WIDTH,
          maxZ,
          SIDEWALK_JOINT_COLOR,
        );
      }
      for (
        let jointZ = minZ + SIDEWALK_JOINT_SPACING;
        jointZ < maxZ - SIDEWALK_JOINT_SPACING * 0.5;
        jointZ += SIDEWALK_JOINT_SPACING
      ) {
        appendTopDetail(
          minX,
          minX + SIDEWALK_WIDTH,
          jointZ - SIDEWALK_JOINT_WIDTH * 0.5,
          jointZ + SIDEWALK_JOINT_WIDTH * 0.5,
          SIDEWALK_JOINT_COLOR,
        );
        appendTopDetail(
          maxX - SIDEWALK_WIDTH,
          maxX,
          jointZ - SIDEWALK_JOINT_WIDTH * 0.5,
          jointZ + SIDEWALK_JOINT_WIDTH * 0.5,
          SIDEWALK_JOINT_COLOR,
        );
      }

      const tactileSize = 0.82;
      const tactileInset = 0.22;
      for (const xSide of [-1, 1]) {
        for (const zSide of [-1, 1]) {
          const tactileMinX = xSide < 0
            ? minX + tactileInset
            : maxX - tactileInset - tactileSize;
          const tactileMinZ = zSide < 0
            ? minZ + tactileInset
            : maxZ - tactileInset - tactileSize;
          appendTopDetail(
            tactileMinX,
            tactileMinX + tactileSize,
            tactileMinZ,
            tactileMinZ + tactileSize,
            SIDEWALK_TACTILE_COLOR,
          );
        }
      }
    }
  }

  appendRoadEdgeDetails(
    positions,
    colors,
    sectorSize,
    eastWestWidth,
    northSouthWidth,
    GROUND_SURFACE_OFFSET + 0.006,
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createStreetlightGeometry() {
  const positions = [];
  appendCuboid(positions, -0.08, 0.08, 0, STREAMING_STREETLIGHT_HEIGHT, -0.08, 0.08);
  appendCuboid(positions, -0.07, 0.07, 4.02, 4.16, 0.02, 0.76);
  appendCuboid(positions, -0.18, 0.18, 3.92, 4.12, 0.64, 1.02);
  // Bench, bin, and route plaque are one compound fixture. They make the
  // existing streetlight instance readable at eye height without a new mesh.
  appendCuboid(positions, 0.34, 1.42, 0.42, 0.55, -0.28, 0.28);
  appendCuboid(positions, 0.42, 0.55, 0, 0.44, -0.22, -0.08);
  appendCuboid(positions, 1.2, 1.33, 0, 0.44, -0.22, -0.08);
  appendCuboid(positions, -0.62, -0.28, 0.08, 0.94, 0.18, 0.54);
  appendCuboid(positions, -0.24, 0.24, 2.18, 2.72, -0.035, 0.035);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createStreetscapeGeometry() {
  const positions = [];
  const colors = [];
  const planter = new THREE.Color(0x59615d);
  const planterEdge = new THREE.Color(0x899087);
  const soil = new THREE.Color(0x493a2d);
  const trunk = new THREE.Color(0x73543a);
  const foliageLower = new THREE.Color(0x4d7557);
  const foliageUpper = new THREE.Color(0x688963);

  // Planter, trunk, and a two-stage hexagonal crown are one vertex-colored
  // geometry. Each streamed slot can therefore add a full curbside tree rhythm
  // for one draw call instead of separate planter, bark, and foliage batches.
  appendCuboid(positions, -0.64, 0.64, 0, 0.42, -0.64, 0.64, colors, planter);
  appendCuboid(positions, -0.7, 0.7, 0.38, 0.5, -0.7, -0.52, colors, planterEdge);
  appendCuboid(positions, -0.7, 0.7, 0.38, 0.5, 0.52, 0.7, colors, planterEdge);
  appendCuboid(positions, -0.7, -0.52, 0.38, 0.5, -0.52, 0.52, colors, planterEdge);
  appendCuboid(positions, 0.52, 0.7, 0.38, 0.5, -0.52, 0.52, colors, planterEdge);
  appendHorizontalRect(
    positions,
    -0.5,
    0.5,
    0.505,
    -0.5,
    0.5,
    SURFACE_PATCH_SIZE,
    colors,
    soil,
  );
  appendRadialFrustum(positions, colors, 0.48, 3.2, 0.18, 0.13, trunk);
  appendRadialFrustum(positions, colors, 2.68, 3.6, 0.62, 1.54, foliageLower);
  appendRadialFrustum(positions, colors, 3.6, 5.38, 1.54, 0.24, foliageUpper);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function getStreetscapeProfile(district) {
  if (STREETSCAPE_PARK_DISTRICTS.has(district)) return STREETSCAPE_PROFILES.park;
  if (STREETSCAPE_WINDSWEPT_DISTRICTS.has(district)) {
    return STREETSCAPE_PROFILES.windswept;
  }
  if (STREETSCAPE_URBAN_DISTRICTS.has(district)) return STREETSCAPE_PROFILES.urban;
  return STREETSCAPE_PROFILES.neighborhood;
}

function createPublicRealmCueGeometry() {
  const positions = [];
  // Compact curb-aligned shelter: a shallow roof, framed rear wall, bench,
  // and freestanding stop blade stay wholly inside the east sidewalk.
  appendCuboid(positions, 70.5, 73.62, 2.76, 2.98, -28.45, -21.85);
  appendCuboid(positions, 73.34, 73.56, 0, 2.76, -28.18, -27.96);
  appendCuboid(positions, 73.34, 73.56, 0, 2.76, -25.27, -25.05);
  appendCuboid(positions, 73.34, 73.56, 0, 2.76, -22.34, -22.12);
  appendCuboid(positions, 73.32, 73.58, 2.48, 2.7, -28.18, -22.12);
  appendCuboid(positions, 72.12, 73.18, 0.43, 0.62, -27.15, -23.25);
  appendCuboid(positions, 73.0, 73.18, 0, 0.46, -27.0, -26.78);
  appendCuboid(positions, 73.0, 73.18, 0, 0.46, -23.62, -23.4);
  appendCuboid(positions, 70.42, 70.62, 0, 3.38, -20.92, -20.72);
  appendCuboid(positions, 70.23, 70.81, 2.55, 3.2, -20.98, -20.66);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createPublicRealmTrimGeometry() {
  const positions = [];
  // Light inset panels, roof fascia, bench edge, and route-board face make the
  // red frame read as transit furniture rather than a rail or road barrier.
  appendCuboid(positions, 73.19, 73.33, 0.72, 2.4, -27.86, -25.4);
  appendCuboid(positions, 73.19, 73.33, 0.72, 2.4, -24.92, -22.46);
  appendCuboid(positions, 70.43, 73.55, 2.67, 2.75, -28.36, -28.16);
  appendCuboid(positions, 72.04, 73.22, 0.58, 0.68, -27.2, -23.2);
  appendCuboid(positions, 70.29, 70.75, 2.63, 3.09, -21.0, -20.64);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createHeroBlockGeometry() {
  const positions = [];
  const colors = [];
  const palette = HERO_FRONTAGE_COLORS;
  const appendHeroCuboid = (
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    color,
  ) => appendCuboid(
    positions,
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    colors,
    color,
  );

  // Hardscape fills the four camera-facing blocks without covering the open
  // cross streets. The inset bands and small planters turn the old ground
  // wedges into a deliberately sparse civic block interior.
  HERO_FRONTAGE_SEGMENTS.forEach((segment, index) => {
    for (const [minZ, maxZ] of [[-124, -38], [38, 124]]) {
      appendHorizontalRect(
        positions,
        segment.minX,
        segment.maxX,
        0.025,
        minZ,
        maxZ,
        SURFACE_PATCH_SIZE,
        colors,
        palette.paving,
      );
      appendHorizontalRect(
        positions,
        segment.minX + 4,
        segment.maxX - 4,
        0.045,
        minZ + 4,
        maxZ - 4,
        SURFACE_PATCH_SIZE,
        colors,
        palette.pavingInset,
      );
      const planterX = segment.minX + 7 + (index % 2) * 18;
      const planterZ = minZ + (maxZ - minZ) * (index % 2 === 0 ? 0.34 : 0.66);
      appendHeroCuboid(
        planterX,
        planterX + 4.2,
        0.04,
        0.28,
        planterZ,
        planterZ + 2.2,
        palette.planter,
      );
      appendHeroCuboid(
        planterX + 0.32,
        planterX + 3.88,
        0.29,
        0.33,
        planterZ + 0.28,
        planterZ + 1.92,
        palette.planterSoil,
      );
    }
  });

  const appendFrontPanel = (minX, maxX, minY, maxY, faceZ, side, color) => {
    const minZ = side === 'south' ? faceZ : faceZ - 0.14;
    const maxZ = side === 'south' ? faceZ + 0.14 : faceZ;
    appendHeroCuboid(minX, maxX, minY, maxY, minZ, maxZ, color);
  };

  const appendFrontage = (segment, side, index) => {
    const isSouth = side === 'south';
    const nearZ = isSouth ? -38.6 : 30.25;
    const farZ = isSouth ? -30.25 : 38.6;
    const faceZ = isSouth ? farZ + 0.05 : nearZ - 0.05;
    const upperHeight = 8.2 + (index % 3) * 0.75;

    // A low ground-floor plinth bridges each generated lot to the curb. The
    // stepped upper wing, cornice, and side piers give the frontage a civic
    // street-wall silhouette without replacing the pooled tower massing.
    appendHeroCuboid(
      segment.minX,
      segment.maxX,
      0.16,
      5.15,
      nearZ,
      farZ,
      palette.stone,
    );
    appendHeroCuboid(
      segment.minX - 0.45,
      segment.maxX + 0.45,
      0.16,
      0.62,
      nearZ - 0.28,
      farZ + 0.28,
      palette.stoneDark,
    );
    appendHeroCuboid(
      segment.minX - 0.35,
      segment.maxX + 0.35,
      4.82,
      5.18,
      nearZ - 0.34,
      farZ + 0.34,
      palette.stoneLight,
    );
    appendHeroCuboid(
      segment.minX + 1.1,
      segment.maxX - 1.1,
      5.15,
      upperHeight,
      nearZ + 0.82,
      farZ - 0.82,
      index % 2 === 0 ? palette.stoneLight : palette.stone,
    );
    appendHeroCuboid(
      segment.minX - 0.7,
      segment.maxX + 0.7,
      upperHeight,
      upperHeight + 0.34,
      nearZ - 0.62,
      farZ + 0.62,
      palette.roof,
    );
    for (const cornerX of [segment.minX - 0.08, segment.maxX - 1.02]) {
      appendHeroCuboid(
        cornerX,
        cornerX + 1.1,
        0.16,
        upperHeight + 0.55,
        nearZ - 0.52,
        farZ + 0.52,
        palette.stoneDark,
      );
    }

    const panelWidth = 7.2;
    let panelIndex = 0;
    for (let x = segment.minX + 2.1; x + panelWidth <= segment.maxX - 1.2; x += 10.4) {
      const door = panelIndex % 3 === 1;
      appendFrontPanel(
        x,
        x + panelWidth,
        door ? 0.7 : 1.14,
        door ? 4.0 : 3.55,
        faceZ,
        side,
        door ? palette.door : palette.window,
      );
      appendFrontPanel(
        x + panelWidth * 0.47,
        x + panelWidth * 0.53,
        door ? 0.82 : 1.26,
        door ? 3.9 : 3.43,
        faceZ + (isSouth ? 0.145 : -0.145),
        side,
        palette.windowLight,
      );
      appendFrontPanel(
        x + 0.22,
        x + panelWidth - 0.22,
        3.72,
        3.9,
        faceZ + (isSouth ? 0.15 : -0.15),
        side,
        palette.stoneLight,
      );
      panelIndex += 1;
    }

    let upperPanelIndex = 0;
    for (let x = segment.minX + 3.2; x + 9.4 <= segment.maxX - 2.2; x += 12.2) {
      appendFrontPanel(
        x,
        x + 9.4,
        5.82,
        Math.min(upperHeight - 0.72, 7.7),
        faceZ + (isSouth ? -0.72 : 0.72),
        side,
        upperPanelIndex % 2 === 0 ? palette.window : palette.windowLight,
      );
      upperPanelIndex += 1;
    }
  };

  HERO_FRONTAGE_SEGMENTS.forEach((segment, index) => {
    appendFrontage(segment, 'south', index);
    appendFrontage(segment, 'north', index + 1);
  });

  // A single red-and-cream civic transit blade, bench, and cap sits in the
  // south sidewalk. Its compact frame is a stop cue, not another road rail.
  const cueX = -108;
  const cueZ = -29.15;
  appendHeroCuboid(cueX - 0.13, cueX + 0.13, 0.26, 3.35, cueZ - 0.13, cueZ + 0.13, palette.transit);
  appendHeroCuboid(cueX - 1.05, cueX + 1.05, 3.02, 3.72, cueZ - 0.18, cueZ + 0.18, palette.transit);
  appendHeroCuboid(cueX - 0.78, cueX + 0.78, 3.18, 3.55, cueZ - 0.25, cueZ - 0.18, palette.transitLight);
  appendHeroCuboid(cueX - 1.75, cueX + 1.75, 2.55, 2.72, cueZ - 0.7, cueZ + 0.7, palette.transit);
  appendHeroCuboid(cueX - 1.35, cueX + 1.35, 0.46, 0.62, cueZ - 0.58, cueZ + 0.58, palette.stoneDark);
  appendHeroCuboid(cueX - 1.18, cueX - 1.02, 0, 0.46, cueZ - 0.5, cueZ - 0.2, palette.roof);
  appendHeroCuboid(cueX + 1.02, cueX + 1.18, 0, 0.46, cueZ + 0.2, cueZ + 0.5, palette.roof);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createCableRouteGeometry(sectorSize) {
  const positions = [];
  const half = sectorSize * 0.5;
  // Twin rails and a single cross-street trolley span make the cable-car
  // corridor legible at distance while remaining two simple cuboid strips.
  appendCuboid(positions, -0.72, -0.58, 0.02, 0.065, -half, half);
  appendCuboid(positions, 0.58, 0.72, 0.02, 0.065, -half, half);
  appendCuboid(positions, -5.55, -5.38, 0, 7.55, -0.08, 0.08);
  appendCuboid(positions, 5.38, 5.55, 0, 7.55, -0.08, 0.08);
  appendCuboid(positions, -5.55, 5.55, 7.36, 7.5, -0.08, 0.08);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createGroundGeometry(sectorSize) {
  const positions = [];
  const half = sectorSize * 0.5;
  appendHorizontalRect(
    positions,
    -half,
    half,
    0,
    -half,
    half,
    SURFACE_PATCH_SIZE,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeGradeableGeometry(source) {
  const geometry = source.clone();
  geometry.userData.streamBasePositions = new Float32Array(
    geometry.getAttribute('position').array,
  );
  const colors = geometry.getAttribute('color');
  geometry.userData.streamBaseColors = colors
    ? new Float32Array(colors.array)
    : null;
  geometry.userData.streamGradeKey = null;
  geometry.userData.streamSurfaceRange = null;
  return geometry;
}

function applyDistrictPavingTint(geometry, profile) {
  const colors = geometry?.getAttribute('color');
  const base = geometry?.userData?.streamBaseColors;
  if (!colors || !base || base.length !== colors.array.length) return;
  streetscapeColorScratch.setHex(profile.pavingTint);
  const red = 0.78 + streetscapeColorScratch.r * 0.22;
  const green = 0.78 + streetscapeColorScratch.g * 0.22;
  const blue = 0.78 + streetscapeColorScratch.b * 0.22;
  for (let index = 0; index < colors.count; index += 1) {
    const offset = index * 3;
    colors.array[offset] = base[offset] * red;
    colors.array[offset + 1] = base[offset + 1] * green;
    colors.array[offset + 2] = base[offset + 2] * blue;
  }
  colors.needsUpdate = true;
}

function gradeSurfaceGeometry(geometry, descriptor, catalog) {
  if (!geometry) return null;
  if (geometry.userData.streamGradeKey === descriptor.key) {
    return geometry.userData.streamSurfaceRange;
  }
  const positions = geometry.getAttribute('position');
  const base = geometry.userData.streamBasePositions;
  if (!positions || !base || base.length !== positions.array.length) return null;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.count; index += 1) {
    const offset = index * 3;
    const worldX = descriptor.center.x + base[offset];
    const worldZ = descriptor.center.z + base[offset + 2];
    const sampled = catalog.getSurfaceHeight(worldX, worldZ);
    const surface = Number.isFinite(sampled) ? sampled : descriptor.elevation;
    positions.array[offset] = base[offset];
    positions.array[offset + 1] = base[offset + 1] + surface - descriptor.elevation;
    positions.array[offset + 2] = base[offset + 2];
    minimum = Math.min(minimum, surface);
    maximum = Math.max(maximum, surface);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const range = Object.freeze({
    minimum: Number.isFinite(minimum) ? minimum : descriptor.elevation,
    maximum: Number.isFinite(maximum) ? maximum : descriptor.elevation,
  });
  geometry.userData.streamGradeKey = descriptor.key;
  geometry.userData.streamSurfaceRange = range;
  return range;
}

function setTransitionGeometry(geometry, positions, color = null) {
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (color) {
    const colors = [];
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  } else {
    geometry.deleteAttribute('color');
  }
  if (positions.length) {
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  } else {
    geometry.boundingBox = new THREE.Box3();
    geometry.boundingSphere = new THREE.Sphere();
  }
}

function authoredCoreGroundHeight(x, z) {
  return x * AUTHORED_CORE_GRADE_X
    + z * AUTHORED_CORE_GRADE_Z
    + AUTHORED_CORE_GROUND_OFFSET;
}

function appendCoreTransitionSurface(
  positions,
  descriptor,
  side,
  sectorSize,
  catalog,
  width = null,
) {
  const half = sectorSize * 0.5;
  const outer = half + GROUND_EDGE_OVERLAP;
  const inner = half - GROUND_TRANSITION_DEPTH;
  const span = width == null ? half : width * 0.5;
  const height = (x, z) => {
    const worldX = descriptor.center.x + x;
    const worldZ = descriptor.center.z + z;
    const sampled = catalog.getSurfaceHeight(
      worldX,
      worldZ,
    );
    const terrainHeight = Number.isFinite(sampled) ? sampled : descriptor.elevation;
    let progress = 1;
    if (side === 'west') progress = (x + outer) / (outer - inner);
    else if (side === 'east') progress = (outer - x) / (outer - inner);
    else if (side === 'south') progress = (z + outer) / (outer - inner);
    else if (side === 'north') progress = (outer - z) / (outer - inner);
    const blend = smoothstep(0, 1, progress);
    return THREE.MathUtils.lerp(
      authoredCoreGroundHeight(worldX, worldZ),
      terrainHeight,
      blend,
    ) - descriptor.elevation + GROUND_SURFACE_OFFSET;
  };

  let minX;
  let maxX;
  let minZ;
  let maxZ;
  if (side === 'west') {
    minX = -outer;
    maxX = -inner;
    minZ = -span;
    maxZ = span;
  } else if (side === 'east') {
    minX = inner;
    maxX = outer;
    minZ = -span;
    maxZ = span;
  } else if (side === 'south') {
    minX = -span;
    maxX = span;
    minZ = -outer;
    maxZ = -inner;
  } else if (side === 'north') {
    minX = -span;
    maxX = span;
    minZ = inner;
    maxZ = outer;
  } else {
    return;
  }
  const xs = getAnchoredStops(minX, maxX, SURFACE_PATCH_SIZE);
  const zs = getAnchoredStops(minZ, maxZ, SURFACE_PATCH_SIZE);
  for (let zIndex = 0; zIndex < zs.length - 1; zIndex += 1) {
    for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
      const x0 = xs[xIndex];
      const x1 = xs[xIndex + 1];
      const z0 = zs[zIndex];
      const z1 = zs[zIndex + 1];
      appendSurfaceQuad(positions,
        [x0, height(x0, z0), z0],
        [x0, height(x0, z1), z1],
        [x1, height(x1, z1), z1],
        [x1, height(x1, z0), z0]);
    }
  }
}

function getCoreTransitionSides(descriptor, catalog, externalKeys) {
  const sides = [];
  HANDOFF_DIRECTIONS.forEach((direction) => {
    const neighbor = catalog.get(
      descriptor.sectorX + direction.x,
      descriptor.sectorZ + direction.z,
    );
    if (!neighbor || !externalKeys.has(neighbor.key)) return;
    if (direction.id === 'east' || direction.id === 'west'
      || direction.id === 'north' || direction.id === 'south') {
      sides.push(direction.id);
    }
  });
  return sides;
}

function updateCoreTransition(
  slot,
  descriptor,
  sectorSize,
  catalog,
  externalKeys,
  qaPublicCorridorActive = false,
) {
  const transition = slot.userData.coreTransition;
  if (!transition) return;
  const sides = getCoreTransitionSides(descriptor, catalog, externalKeys);
  const skirtPositions = [];
  const roadPositions = [];
  let skirtSideCount = 0;
  sides.forEach((side) => {
    // The generic west transition is a useful seam treatment elsewhere, but
    // reads as a filler wedge in the camera-facing Civic Center hero block.
    // Its road apron remains so the boundary still has a continuous datum.
    const suppressHeroSkirt = descriptor.key === HERO_BLOCK_SECTOR_KEY && side === 'west';
    if (!suppressHeroSkirt) {
      appendCoreTransitionSurface(skirtPositions, descriptor, side, sectorSize, catalog);
      skirtSideCount += 1;
    }
    const roadWidth = qaPublicCorridorActive && (side === 'east' || side === 'west')
      ? QA_PUBLIC_CORRIDOR_WIDTH
      : STREAMING_ROAD_WIDTH;
    appendCoreTransitionSurface(
      roadPositions,
      descriptor,
      side,
      sectorSize,
      catalog,
      roadWidth,
    );
  });
  setTransitionGeometry(transition.skirt.geometry, skirtPositions);
  setTransitionGeometry(transition.roadApron.geometry, roadPositions, ROAD_ASPHALT_COLOR);
  transition.skirt.visible = skirtSideCount > 0;
  transition.roadApron.visible = sides.length > 0;
}

function clipSegmentToSquare(start, end, extent) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let minimum = 0;
  let maximum = 1;
  for (const [origin, delta] of [[start.x, dx], [start.z, dz]]) {
    if (Math.abs(delta) < 1e-7) {
      if (origin < -extent || origin > extent) return null;
      continue;
    }
    const low = (-extent - origin) / delta;
    const high = (extent - origin) / delta;
    minimum = Math.max(minimum, Math.min(low, high));
    maximum = Math.min(maximum, Math.max(low, high));
    if (minimum > maximum) return null;
  }
  return {
    start: { x: start.x + dx * minimum, z: start.z + dz * minimum },
    end: { x: start.x + dx * maximum, z: start.z + dz * maximum },
  };
}

function updateWaterfrontTransition(slot, descriptor, sectorSize, catalog) {
  const waterfront = slot.userData.waterfront;
  const edge = descriptor.waterfront;
  if (!waterfront) return;
  if (!edge) {
    setTransitionGeometry(waterfront.geometry, []);
    waterfront.visible = false;
    return;
  }
  const clipped = clipSegmentToSquare(
    {
      x: edge.start.x - descriptor.center.x,
      z: edge.start.z - descriptor.center.z,
    },
    {
      x: edge.end.x - descriptor.center.x,
      z: edge.end.z - descriptor.center.z,
    },
    sectorSize * 0.5 + WATERFRONT_WATER_EXTENT,
  );
  if (!clipped) {
    setTransitionGeometry(waterfront.geometry, []);
    waterfront.visible = false;
    return;
  }
  const sampledSurface = catalog.getSurfaceHeight(edge.point);
  const waterY = (Number.isFinite(sampledSurface) ? sampledSurface : descriptor.elevation)
    - descriptor.elevation + WATERFRONT_SURFACE_OFFSET;
  const normal = edge.outwardNormal;
  const shoreStart = {
    x: clipped.start.x - normal.x * WATERFRONT_TIDAL_INSET,
    z: clipped.start.z - normal.z * WATERFRONT_TIDAL_INSET,
  };
  const shoreEnd = {
    x: clipped.end.x - normal.x * WATERFRONT_TIDAL_INSET,
    z: clipped.end.z - normal.z * WATERFRONT_TIDAL_INSET,
  };
  const waterStart = {
    x: clipped.start.x + normal.x * WATERFRONT_WATER_EXTENT,
    z: clipped.start.z + normal.z * WATERFRONT_WATER_EXTENT,
  };
  const waterEnd = {
    x: clipped.end.x + normal.x * WATERFRONT_WATER_EXTENT,
    z: clipped.end.z + normal.z * WATERFRONT_WATER_EXTENT,
  };
  const positions = [];
  appendSurfaceQuad(
    positions,
    [shoreStart.x, waterY, shoreStart.z],
    [shoreEnd.x, waterY, shoreEnd.z],
    [waterEnd.x, waterY, waterEnd.z],
    [waterStart.x, waterY, waterStart.z],
  );
  setTransitionGeometry(waterfront.geometry, positions);
  waterfront.visible = true;
}

let sharedStreamingFacadeAtlas = null;

function getStreamingFacadeAtlas() {
  if (sharedStreamingFacadeAtlas || typeof document === 'undefined') {
    return sharedStreamingFacadeAtlas;
  }
  sharedStreamingFacadeAtlas = new THREE.TextureLoader().load(STREAMING_FACADE_ATLAS_URL);
  sharedStreamingFacadeAtlas.name = 'Generated streamed SF facade atlas';
  sharedStreamingFacadeAtlas.colorSpace = THREE.SRGBColorSpace;
  sharedStreamingFacadeAtlas.wrapS = THREE.ClampToEdgeWrapping;
  sharedStreamingFacadeAtlas.wrapT = THREE.ClampToEdgeWrapping;
  sharedStreamingFacadeAtlas.minFilter = THREE.LinearMipmapLinearFilter;
  sharedStreamingFacadeAtlas.magFilter = THREE.LinearFilter;
  sharedStreamingFacadeAtlas.anisotropy = 4;
  return sharedStreamingFacadeAtlas;
}

function createDetailedBaseMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0.04,
  });
  material.name = 'Shared streamed palette massing material';
  return material;
}

function createFacadePlaneMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: getStreamingFacadeAtlas(),
    roughness: 0.74,
    metalness: 0.03,
  });
  material.name = 'Shared streamed physical-scale facade plane material';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `
        #include <common>
        attribute float facadeAtlasCell;
        attribute vec2 facadeRepeat;
        attribute float facadeLayer;
        attribute float facadeTone;
        attribute float facadeVariant;
        varying vec2 vStreamingFacadeUv;
        varying vec2 vStreamingFacadeRepeat;
        varying float vStreamingFacadeCell;
        varying float vStreamingFacadeLayer;
        varying float vStreamingFacadeTone;
        varying float vStreamingFacadeVariant;
      `,
    ).replace(
      '#include <uv_vertex>',
      `
        #include <uv_vertex>
        #ifdef USE_MAP
          vStreamingFacadeUv = uv;
          vStreamingFacadeRepeat = facadeRepeat;
          vStreamingFacadeCell = facadeAtlasCell;
          vStreamingFacadeLayer = facadeLayer;
          vStreamingFacadeTone = facadeTone;
          vStreamingFacadeVariant = facadeVariant;
        #endif
      `,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `
        #include <common>
        varying vec2 vStreamingFacadeUv;
        varying vec2 vStreamingFacadeRepeat;
        varying float vStreamingFacadeCell;
        varying float vStreamingFacadeLayer;
        varying float vStreamingFacadeTone;
        varying float vStreamingFacadeVariant;

        vec4 streamingFacadeModuleRect(float cell, float layer) {
          if (layer > 1.5) {
            return vec4(0.025, 0.010, 0.950, 0.205);
          }
          if (cell < 0.5) {
            return layer > 0.5
              ? vec4(0.400, 0.015, 0.200, 0.180)
              : vec4(0.345, 0.230, 0.310, 0.220);
          }
          if (cell < 1.5) {
            return layer > 0.5
              ? vec4(0.400, 0.010, 0.200, 0.215)
              : vec4(0.055, 0.250, 0.220, 0.190);
          }
          if (cell < 2.5) {
            return layer > 0.5
              ? vec4(0.420, 0.010, 0.170, 0.215)
              : vec4(0.060, 0.240, 0.210, 0.220);
          }
          return layer > 0.5
            ? vec4(0.410, 0.010, 0.200, 0.220)
            : vec4(0.070, 0.270, 0.160, 0.220);
        }
      `,
    ).replace(
      '#include <map_fragment>',
      `
        #ifdef USE_MAP
          float streamingCell = clamp(floor(vStreamingFacadeCell + 0.5), 0.0, 3.0);
          vec2 streamingCellOrigin = vec2(
            mod(streamingCell, 2.0),
            1.0 - floor(streamingCell * 0.5)
          ) * 0.5;
          vec2 streamingRepeat = max(vStreamingFacadeRepeat, vec2(1.0));
          vec2 streamingTiledUv = fract(
            min(vStreamingFacadeUv, vec2(0.999999)) * streamingRepeat
          );
          // District- and lot-seeded variants prevent a long run of pooled
          // facades from reading as one repeated photograph while preserving
          // the same physical bay and floor cadence.
          if (mod(floor(vStreamingFacadeVariant), 2.0) > 0.5) {
            streamingTiledUv.x = 1.0 - streamingTiledUv.x;
          }
          streamingTiledUv.y = fract(
            streamingTiledUv.y + floor(vStreamingFacadeVariant * 0.5) * 0.17
          );
          streamingTiledUv = mix(vec2(0.035), vec2(0.965), streamingTiledUv);
          vec4 streamingRect = streamingFacadeModuleRect(
            streamingCell,
            vStreamingFacadeLayer
          );
          vec2 streamingAtlasUv = streamingCellOrigin
            + (streamingRect.xy + streamingTiledUv * streamingRect.zw) * 0.5;
          vec4 sampledDiffuseColor = texture2D(map, streamingAtlasUv);
          sampledDiffuseColor.rgb *= mix(0.82, 1.12, vStreamingFacadeTone);
          diffuseColor *= sampledDiffuseColor;
        #endif
      `,
    );
  };
  material.customProgramCacheKey = () => 'streamed-sf-physical-facade-planes-v5';
  return material;
}

function createSharedResources(sectorSize) {
  const geometryPools = getSharedGeometryPools();
  const detailedBuildingGeometry = geometryPools.box;
  const proxyBuildingGeometry = detailedBuildingGeometry.clone();
  const groundGeometry = createGroundGeometry(sectorSize);

  // Detailed massing keeps its actual district palette. The atlas is applied
  // only to compatible, outward-facing overlay planes, never stretched across
  // roofs, tapers, setbacks, or compound side faces.
  const detailedBaseMaterial = createDetailedBaseMaterial();

  const resources = {
    geometryPools,
    detailedBuildingGeometry,
    proxyBuildingGeometry,
    groundGeometry,
    detailedBaseMaterial,
    facadeGeometry: new THREE.PlaneGeometry(1, 1),
    facadeMaterial: createFacadePlaneMaterial(),
    proxyMaterial: new THREE.MeshLambertMaterial({ color: 0x767a7b, fog: true }),
    groundMaterial: new THREE.MeshStandardMaterial({
      color: 0x5b625f,
      roughness: 0.94,
      metalness: 0.02,
      fog: true,
    }),
    waterfrontMaterial: new THREE.MeshStandardMaterial({
      color: 0x3d7180,
      roughness: 0.34,
      metalness: 0.28,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    roadGeometry: createRoadLatticeGeometry(sectorSize),
    qaRoadGeometry: createRoadLatticeGeometry(sectorSize, QA_PUBLIC_CORRIDOR_WIDTH),
    sidewalkGeometry: createSidewalkGeometry(sectorSize),
    qaSidewalkGeometry: createSidewalkGeometry(sectorSize, QA_PUBLIC_CORRIDOR_WIDTH),
    sidewalkMaterial: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.01,
      fog: true,
      vertexColors: true,
    }),
    roadMaterial: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0.04,
      fog: true,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    streetlightGeometry: createStreetlightGeometry(),
    streetlightMaterial: new THREE.MeshStandardMaterial({
      color: 0x252b2d,
      roughness: 0.58,
      metalness: 0.62,
      fog: true,
    }),
    streetscapeGeometry: createStreetscapeGeometry(),
    streetscapeMaterial: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.02,
      fog: true,
      vertexColors: true,
    }),
    publicRealmCueGeometry: createPublicRealmCueGeometry(),
    publicRealmTrimGeometry: createPublicRealmTrimGeometry(),
    heroBlockGeometry: createHeroBlockGeometry(),
    cableRouteGeometry: createCableRouteGeometry(sectorSize),
    publicRealmCueMaterial: new THREE.MeshStandardMaterial({
      color: 0x963d42,
      roughness: 0.62,
      metalness: 0.22,
      fog: true,
    }),
    publicRealmTrimMaterial: new THREE.MeshStandardMaterial({
      color: 0xf0dfb9,
      roughness: 0.72,
      metalness: 0.04,
      fog: true,
    }),
    heroBlockMaterial: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.04,
      fog: true,
      vertexColors: true,
    }),
    cableRouteMaterial: new THREE.MeshStandardMaterial({
      color: 0x1c2528,
      roughness: 0.5,
      metalness: 0.72,
      fog: true,
    }),
  };
  return resources;
}

function createDetailedSlot(resources, sectorSize) {
  const group = new THREE.Group();
  group.name = 'Pooled detailed city sector';
  const ground = new THREE.Mesh(
    makeGradeableGeometry(resources.groundGeometry),
    resources.groundMaterial,
  );
  ground.name = 'Pooled continuously graded sector ground';
  ground.receiveShadow = true;
  group.add(ground);

  const roadGeometries = {
    normal: makeGradeableGeometry(resources.roadGeometry),
    transit: makeGradeableGeometry(resources.qaRoadGeometry),
  };
  // Generated blocks and public space now use the same complete 64 m grid.
  // Exact ±192 m edges meet the next graded slot without a plain ground gap.
  const roads = new THREE.Mesh(roadGeometries.normal, resources.roadMaterial);
  roads.name = 'Pooled seam-aligned six-by-six road lattice';
  roads.position.y = GROUND_SURFACE_OFFSET;
  roads.receiveShadow = true;
  group.add(roads);

  const sidewalkGeometries = {
    normal: makeGradeableGeometry(resources.sidewalkGeometry),
    transit: makeGradeableGeometry(resources.qaSidewalkGeometry),
  };
  const sidewalks = new THREE.Mesh(
    sidewalkGeometries.normal,
    resources.sidewalkMaterial,
  );
  sidewalks.name = 'Pooled six-by-six raised sidewalks and curbs';
  sidewalks.receiveShadow = true;
  group.add(sidewalks);

  const streetlights = new THREE.InstancedMesh(
    resources.streetlightGeometry,
    resources.streetlightMaterial,
    STREAMING_STREETLIGHT_CAPACITY,
  );
  streetlights.name = 'Pooled public-realm intersection streetlights';
  streetlights.userData.capacity = STREAMING_STREETLIGHT_CAPACITY;
  streetlights.count = 0;
  streetlights.castShadow = false;
  streetlights.receiveShadow = true;
  group.add(streetlights);

  const streetscape = new THREE.InstancedMesh(
    resources.streetscapeGeometry,
    resources.streetscapeMaterial,
    STREAMING_STREETSCAPE_CAPACITY,
  );
  streetscape.name = 'Pooled district-profiled sidewalk trees and planters';
  streetscape.userData.capacity = STREAMING_STREETSCAPE_CAPACITY;
  streetscape.count = 0;
  streetscape.castShadow = false;
  streetscape.receiveShadow = true;
  streetscape.frustumCulled = true;
  group.add(streetscape);

  const publicRealmCue = new THREE.Mesh(
    resources.publicRealmCueGeometry,
    resources.publicRealmCueMaterial,
  );
  publicRealmCue.name = 'Pooled Muni stop and shelter cue';
  publicRealmCue.castShadow = false;
  publicRealmCue.receiveShadow = true;
  const publicRealmTrim = new THREE.Mesh(
    resources.publicRealmTrimGeometry,
    resources.publicRealmTrimMaterial,
  );
  publicRealmTrim.name = 'Pooled Muni route board trim';
  publicRealmTrim.castShadow = false;
  publicRealmTrim.receiveShadow = true;
  const heroBlock = new THREE.Mesh(
    makeGradeableGeometry(resources.heroBlockGeometry),
    resources.heroBlockMaterial,
  );
  heroBlock.name = 'Pooled Civic Center authored hero block frontage';
  heroBlock.castShadow = false;
  heroBlock.receiveShadow = true;
  heroBlock.visible = false;
  const cableRoute = new THREE.Mesh(
    resources.cableRouteGeometry,
    resources.cableRouteMaterial,
  );
  cableRoute.name = 'District cable-car rail and trolley wire cue';
  cableRoute.castShadow = false;
  cableRoute.receiveShadow = false;
  cableRoute.visible = false;
  group.add(publicRealmCue, publicRealmTrim, heroBlock, cableRoute);

  const coreSkirt = new THREE.Mesh(new THREE.BufferGeometry(), resources.groundMaterial);
  coreSkirt.name = 'Generated core terrain transition skirt';
  coreSkirt.receiveShadow = true;
  coreSkirt.visible = false;
  group.add(coreSkirt);
  const coreRoadApron = new THREE.Mesh(new THREE.BufferGeometry(), resources.roadMaterial);
  coreRoadApron.name = 'Generated core road transition apron';
  coreRoadApron.receiveShadow = true;
  coreRoadApron.visible = false;
  group.add(coreRoadApron);
  const waterfront = new THREE.Mesh(
    new THREE.BufferGeometry(),
    resources.waterfrontMaterial,
  );
  waterfront.name = 'Generated clipped waterfront transition';
  waterfront.receiveShadow = true;
  waterfront.visible = false;
  group.add(waterfront);

  // One InstancedMesh per geometry style so massing can select box, setback,
  // tapered, or projecting-bay rowhouse silhouettes independently.
  const styleOrder = DETAIL_STYLES;
  const meshes = styleOrder.map((style) => {
    const geo = resources.geometryPools[style] || resources.geometryPools.box;
    const mesh = new THREE.InstancedMesh(
      geo,
      resources.detailedBaseMaterial,
      DISTRICT_MASSING_LIMITS.detail.maxBuildings,
    );
    mesh.userData.capacity = DISTRICT_MASSING_LIMITS.detail.maxBuildings;
    mesh.userData.geometryStyle = style;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    group.add(mesh);
    return mesh;
  });
  const facadeGeometry = resources.facadeGeometry.clone();
  facadeGeometry.setAttribute(
    'facadeAtlasCell',
    new THREE.InstancedBufferAttribute(new Float32Array(STREAMING_FACADE_CAPACITY), 1),
  );
  facadeGeometry.setAttribute(
    'facadeRepeat',
    new THREE.InstancedBufferAttribute(new Float32Array(STREAMING_FACADE_CAPACITY * 2), 2),
  );
  facadeGeometry.setAttribute(
    'facadeLayer',
    new THREE.InstancedBufferAttribute(new Float32Array(STREAMING_FACADE_CAPACITY), 1),
  );
  facadeGeometry.setAttribute(
    'facadeTone',
    new THREE.InstancedBufferAttribute(new Float32Array(STREAMING_FACADE_CAPACITY), 1),
  );
  facadeGeometry.setAttribute(
    'facadeVariant',
    new THREE.InstancedBufferAttribute(new Float32Array(STREAMING_FACADE_CAPACITY), 1),
  );
  const facades = new THREE.InstancedMesh(
    facadeGeometry,
    resources.facadeMaterial,
    STREAMING_FACADE_CAPACITY,
  );
  facades.name = 'Pooled physical-scale streamed facade planes';
  facades.userData.capacity = STREAMING_FACADE_CAPACITY;
  facades.count = 0;
  facades.castShadow = false;
  facades.receiveShadow = true;
  facades.frustumCulled = true;
  group.add(facades);
  group.userData.streamMeshes = meshes;
  group.userData.geometryStyles = styleOrder;
  group.userData.ground = ground;
  group.userData.facades = facades;
  group.userData.roads = roads;
  group.userData.roadGeometries = roadGeometries;
  group.userData.sidewalks = sidewalks;
  group.userData.sidewalkGeometries = sidewalkGeometries;
  group.userData.streetlights = streetlights;
  group.userData.streetscape = streetscape;
  group.userData.publicRealmCue = publicRealmCue;
  group.userData.publicRealmTrim = publicRealmTrim;
  group.userData.heroBlock = heroBlock;
  group.userData.cableRoute = cableRoute;
  group.userData.coreTransition = { skirt: coreSkirt, roadApron: coreRoadApron };
  group.userData.waterfront = waterfront;
  group.visible = false;
  return group;
}

function createProxySlot(resources) {
  const group = new THREE.Group();
  group.name = 'Pooled distant city sector proxy';
  const mesh = new THREE.InstancedMesh(
    resources.proxyBuildingGeometry,
    resources.proxyMaterial,
    DISTRICT_MASSING_LIMITS.proxy.maxBuildings,
  );
  mesh.userData.capacity = DISTRICT_MASSING_LIMITS.proxy.maxBuildings;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.geometryStyle = 'box';
  group.add(mesh);
  group.userData.streamMeshes = [mesh];
  // Distant proxies use only the box style; district massing still varies
  // building dimensions and palette colors but collapses all geometry
  // variants into the single pooled box mesh.
  group.userData.geometryStyles = ['box'];
  group.visible = false;
  return group;
}

const matrixScratch = new THREE.Matrix4();
const positionScratch = new THREE.Vector3();
const facadePositionScratch = new THREE.Vector3();
const quaternionScratch = new THREE.Quaternion();
const scaleScratch = new THREE.Vector3();
const streetscapeColorScratch = new THREE.Color();

function overlapsQaPublicCorridor(building) {
  return Math.abs(building.z) - building.depth * 0.5
    < QA_PUBLIC_CORRIDOR_HALF_WIDTH + QA_PUBLIC_CORRIDOR_CLEARANCE;
}

function getFacadeAtlasCell(building, district = '') {
  const cells = FACADE_CELLS_BY_PALETTE[building.paletteName] ?? [2];
  const styleOffset = Math.max(0, DETAIL_STYLES.indexOf(building.geometryStyle));
  const districtOffset = DISTRICT_FACADE_CELL_OFFSETS[district] ?? 0;
  return cells[(building.paletteIndex + styleOffset + districtOffset) % cells.length];
}

function getFacadeTone(building, district, face, layer) {
  const faceOffset = FACADE_FACES.indexOf(face) * 13 + layer * 7;
  const districtOffset = DISTRICT_FACADE_CELL_OFFSETS[district] ?? 0;
  return 0.42 + seededValue(
    Math.round(building.x * 17 + building.z * 31) + districtOffset * 97,
    faceOffset,
  ) * 0.44;
}

function getFacadeVariant(building, district, face, layer) {
  const faceOffset = FACADE_FACES.indexOf(face) * 19 + layer * 11;
  const districtOffset = DISTRICT_FACADE_CELL_OFFSETS[district] ?? 0;
  return Math.floor(seededValue(
    Math.round(building.x * 29 + building.z * 23) + districtOffset * 131,
    faceOffset,
  ) * 4);
}

function getPresentedBuildingZ(building, qaPublicCorridorActive) {
  if (!qaPublicCorridorActive || !overlapsQaPublicCorridor(building)) {
    return building.z;
  }
  // Preserve the full building instead of deleting both rows nearest the QA
  // avenue. Moving the lot outward places its frontage exactly on the
  // documented clearance edge and keeps the target/camera corridor empty.
  const side = building.z < 0 ? -1 : 1;
  return side * (
    QA_PUBLIC_CORRIDOR_HALF_WIDTH
    + QA_PUBLIC_CORRIDOR_CLEARANCE
    + building.depth * 0.5
  );
}

function getFrontageYaw(building, presentedZ, qaPublicCorridorActive) {
  if (qaPublicCorridorActive && overlapsQaPublicCorridor(building)) {
    return presentedZ < 0 ? Math.PI : 0;
  }
  // Geometry is authored with local -Z as its frontage (notably the rowhouse
  // projecting bay). Rotate that frontage toward the closer pooled cross
  // street. Ties prefer the east/west street, keeping orientation stable.
  if (Math.abs(presentedZ) <= Math.abs(building.x)) {
    return presentedZ < 0 ? Math.PI : 0;
  }
  return building.x < 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
}

const FACADE_FACES = Object.freeze(['front', 'back', 'left', 'right']);

function setFacadePlaneInstance(
  mesh,
  instanceIndex,
  building,
  presentedZ,
  frontageYaw,
  baseY,
  face,
  centerY,
  width,
  height,
  repeatX,
  repeatY,
  layer,
  segment,
  facadeCell,
  facadeTone,
  facadeVariant,
  surfaceOffset = FACADE_SURFACE_OFFSET,
) {
  if (!mesh || instanceIndex >= mesh.userData.capacity || height <= 0 || width <= 0) {
    return false;
  }
  const rowhouse = building.geometryStyle === 'rowhouse';
  const widthPosition = rowhouse ? Math.max(segment.widthPosition, 0.55) : segment.widthPosition;
  const depthPosition = rowhouse && face === 'front'
    ? Math.max(segment.depthPosition, 0.625)
    : segment.depthPosition;
  let localYaw = 0;
  let localX = 0;
  let localZ = 0;
  if (face === 'front') {
    localYaw = Math.PI;
    localZ = -building.depth * depthPosition - surfaceOffset;
  } else if (face === 'back') {
    localZ = building.depth * depthPosition + surfaceOffset;
  } else if (face === 'left') {
    localYaw = -Math.PI * 0.5;
    localX = -building.width * widthPosition - surfaceOffset;
  } else if (face === 'right') {
    localYaw = Math.PI * 0.5;
    localX = building.width * widthPosition + surfaceOffset;
  } else {
    return false;
  }
  quaternionScratch.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, frontageYaw);
  facadePositionScratch
    .set(localX, baseY + centerY, localZ)
    .applyQuaternion(quaternionScratch);
  facadePositionScratch.x += building.x;
  facadePositionScratch.z += presentedZ;
  quaternionScratch.setFromAxisAngle(
    THREE.Object3D.DEFAULT_UP,
    frontageYaw + localYaw,
  );
  scaleScratch.set(width, height, 1);
  matrixScratch.compose(facadePositionScratch, quaternionScratch, scaleScratch);
  mesh.setMatrixAt(instanceIndex, matrixScratch);
  mesh.geometry.getAttribute('facadeAtlasCell').setX(
    instanceIndex,
    facadeCell,
  );
  mesh.geometry.getAttribute('facadeRepeat').setXY(
    instanceIndex,
    Math.max(1, repeatX),
    Math.max(1, repeatY),
  );
  mesh.geometry.getAttribute('facadeLayer').setX(instanceIndex, layer);
  mesh.geometry.getAttribute('facadeTone').setX(instanceIndex, facadeTone);
  mesh.geometry.getAttribute('facadeVariant').setX(instanceIndex, facadeVariant);
  return true;
}

function populateFacadePlanes(
  mesh,
  instanceIndex,
  building,
  presentedZ,
  frontageYaw,
  baseY,
  district,
) {
  if (!mesh) return { instanceIndex, treatedFaces: 0 };
  const cell = getFacadeAtlasCell(building, district);
  const floorHeight = THREE.MathUtils.clamp(building.floorHeight || 3.2, 2.8, 4.2);
  const groundFloorHeight = Math.min(building.height * 0.42, floorHeight * 1.08);
  const topTrimHeight = Math.min(1.1, floorHeight * 0.26);
  const upperProfiles = {
    box: {
      bottom: groundFloorHeight,
      top: building.height - topTrimHeight,
      widthRatio: 0.94,
      depthRatio: 0.94,
      widthPosition: 0.502,
      depthPosition: 0.502,
    },
    setback: {
      bottom: Math.max(groundFloorHeight, building.height * 0.38),
      top: building.height - topTrimHeight,
      widthRatio: 0.79,
      depthRatio: 0.79,
      widthPosition: 0.421,
      depthPosition: 0.421,
    },
    tapered: {
      bottom: Math.max(groundFloorHeight, building.height * 0.52),
      top: building.height - topTrimHeight,
      widthRatio: 0.72,
      depthRatio: 0.72,
      widthPosition: 0.405,
      depthPosition: 0.405,
    },
    rowhouse: {
      bottom: Math.max(floorHeight * 0.95, building.height * 0.2),
      top: Math.min(building.height * 0.78, building.height - topTrimHeight),
      widthRatio: 0.52,
      depthRatio: 0.88,
      widthPosition: 0.55,
      depthPosition: 0.54,
    },
  };
  const upperProfile = upperProfiles[building.geometryStyle] || upperProfiles.box;
  const lowerProfiles = {
    box: {
      bottom: 0.12,
      top: upperProfile.bottom,
      widthRatio: 0.94,
      depthRatio: 0.94,
      widthPosition: 0.502,
      depthPosition: 0.502,
    },
    setback: {
      bottom: 0.12,
      top: upperProfile.bottom,
      widthRatio: 0.94,
      depthRatio: 0.94,
      widthPosition: 0.502,
      depthPosition: 0.502,
    },
    tapered: {
      bottom: 0.12,
      top: upperProfile.bottom,
      widthRatio: 0.86,
      depthRatio: 0.86,
      widthPosition: 0.465,
      depthPosition: 0.465,
    },
    rowhouse: {
      bottom: 0.12,
      top: upperProfile.bottom,
      widthRatio: 0.52,
      depthRatio: 0.88,
      widthPosition: 0.55,
      depthPosition: 0.54,
    },
  };
  const lowerProfile = lowerProfiles[building.geometryStyle] || lowerProfiles.box;
  const segments = [lowerProfile, upperProfile];
  let treatedFaces = 0;

  FACADE_FACES.forEach((face) => {
    let treated = false;
    segments.forEach((segment) => {
      const segmentHeight = segment.top - segment.bottom;
      if (segmentHeight < floorHeight * 0.48) return;
      const faceWidth = (face === 'front' || face === 'back')
        ? building.width * segment.widthRatio
        : building.depth * segment.depthRatio;
      const bayCount = Math.max(
        1,
        Math.round(faceWidth / FACADE_BAY_WIDTH_BY_CELL[cell]),
      );
      const floorCount = Math.max(1, Math.round(segmentHeight / floorHeight));
      if (setFacadePlaneInstance(
        mesh,
        instanceIndex,
        building,
        presentedZ,
        frontageYaw,
        baseY,
        face,
        segment.bottom + segmentHeight * 0.5,
        faceWidth,
        segmentHeight,
        bayCount,
        floorCount,
        face === 'front' && segment === lowerProfile ? 2 : 0,
        segment,
        cell,
        getFacadeTone(building, district, face, segment === lowerProfile ? 0 : 1),
        getFacadeVariant(building, district, face, segment === lowerProfile ? 0 : 1),
      )) {
        instanceIndex += 1;
        treated = true;
      }
    });
    if (treated) treatedFaces += 1;
  });

  const entranceHeight = Math.min(3.65, groundFloorHeight * 0.9);
  const entranceWidth = Math.min(
    FACADE_ENTRANCE_WIDTH_BY_CELL[cell],
    building.width * 0.34,
  );
  if (setFacadePlaneInstance(
    mesh,
    instanceIndex,
    building,
    presentedZ,
    frontageYaw,
    baseY,
    'front',
    0.08 + entranceHeight * 0.5,
    entranceWidth,
    entranceHeight,
    1,
    1,
    1,
    lowerProfile,
    cell,
    getFacadeTone(building, district, 'front', 2),
    getFacadeVariant(building, district, 'front', 2),
    FACADE_ENTRANCE_SURFACE_OFFSET,
  )) {
    instanceIndex += 1;
  }
  return { instanceIndex, treatedFaces };
}

function populateStreetlights(
  mesh,
  qaPublicCorridorActive,
  descriptor,
  catalog,
  sectorSize,
) {
  if (!mesh) return;
  const internalLines = getStreetGridLines(sectorSize).slice(1, -1);
  let count = 0;
  const placeFixture = (localX, localZ, yaw) => {
    if (count >= mesh.userData.capacity) return;
    const sampled = catalog.getSurfaceHeight(
      descriptor.center.x + localX,
      descriptor.center.z + localZ,
    );
    const surfaceOffset = (Number.isFinite(sampled) ? sampled : descriptor.elevation)
      - descriptor.elevation;
    positionScratch.set(localX, surfaceOffset + SIDEWALK_HEIGHT, localZ);
    quaternionScratch.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    scaleScratch.set(1, 1, 1);
    matrixScratch.compose(positionScratch, quaternionScratch, scaleScratch);
    mesh.setMatrixAt(count, matrixScratch);
    count += 1;
  };
  internalLines.forEach((zLine, row) => {
    // The temporary transit corridor stays structurally clear. Its furniture
    // returns with the ordinary 12 m street before any evidence stop resolves.
    if (qaPublicCorridorActive && Math.abs(zLine) < 0.001) return;
    internalLines.forEach((xLine, column) => {
      if (count >= mesh.userData.capacity) return;
      const xSide = (row + column) % 2 === 0 ? 1 : -1;
      const zSide = row % 2 === 0 ? 1 : -1;
      const localX = xLine
        + xSide * (getStreetWidth(xLine, STREAMING_ROAD_WIDTH) * 0.5
          + SIDEWALK_WIDTH * 0.55);
      const localZ = zLine
        + zSide * (getStreetWidth(
          zLine,
          qaPublicCorridorActive ? QA_PUBLIC_CORRIDOR_WIDTH : STREAMING_ROAD_WIDTH,
        ) * 0.5 + SIDEWALK_WIDTH * 0.55);
      placeFixture(localX, localZ, zSide > 0 ? Math.PI : 0);
    });
  });
  if (!qaPublicCorridorActive) {
    const curbOffset = STREAMING_ROAD_WIDTH * 0.5 + SIDEWALK_WIDTH * 0.55;
    [
      [-128, -64, 1, 1],
      [0, -128, -1, -1],
      [128, 64, 1, 1],
      [0, 128, -1, -1],
      [-64, 0, 1, -1],
      [64, 0, -1, 1],
      [0, 0, -1, 1],
    ].forEach(([xLine, zLine, xSide, zSide]) => {
      placeFixture(
        xLine + xSide * curbOffset,
        zLine + zSide * curbOffset,
        zSide > 0 ? Math.PI : 0,
      );
    });
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  quaternionScratch.identity();
}

function populateStreetscape(
  mesh,
  qaPublicCorridorActive,
  descriptor,
  catalog,
  sectorSize,
) {
  if (!mesh) return;
  const lines = getStreetGridLines(sectorSize);
  const profile = getStreetscapeProfile(descriptor.district);
  let count = 0;

  const placeTree = (localX, localZ, yaw, size, tintVariation) => {
    if (count >= mesh.userData.capacity) return;
    const worldX = descriptor.center.x + localX;
    const worldZ = descriptor.center.z + localZ;
    if (typeof catalog.containsPosition === 'function'
      && !catalog.containsPosition(worldX, worldZ)) return;
    // Keep the authored shelter's approach and bench clear while using trees
    // to frame it from the neighboring curb segments in roaming captures.
    if (Math.hypot(localX - TRANSIT_STOP_X, localZ - TRANSIT_STOP_Z) < 7.5) return;
    const sampled = catalog.getSurfaceHeight(worldX, worldZ);
    const surfaceOffset = (Number.isFinite(sampled) ? sampled : descriptor.elevation)
      - descriptor.elevation;
    positionScratch.set(localX, surfaceOffset + SIDEWALK_HEIGHT, localZ);
    quaternionScratch.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    scaleScratch.set(
      profile.scaleX * size,
      profile.scaleY * size,
      profile.scaleZ * size,
    );
    matrixScratch.compose(positionScratch, quaternionScratch, scaleScratch);
    mesh.setMatrixAt(count, matrixScratch);
    streetscapeColorScratch.setHex(profile.tint).multiplyScalar(tintVariation);
    mesh.setColorAt(count, streetscapeColorScratch);
    count += 1;
  };

  for (let row = 0; row < STREAMING_GRID_DIVISIONS; row += 1) {
    const minZ = lines[row]
      + getStreetWidth(
        lines[row],
        qaPublicCorridorActive ? QA_PUBLIC_CORRIDOR_WIDTH : STREAMING_ROAD_WIDTH,
      ) * 0.5;
    const maxZ = lines[row + 1]
      - getStreetWidth(
        lines[row + 1],
        qaPublicCorridorActive ? QA_PUBLIC_CORRIDOR_WIDTH : STREAMING_ROAD_WIDTH,
      ) * 0.5;
    for (let column = 0; column < STREAMING_GRID_DIVISIONS; column += 1) {
      const blockIndex = row * STREAMING_GRID_DIVISIONS + column;
      if (profile.skipCadence
        && (blockIndex + descriptor.seed) % profile.skipCadence === 0) continue;
      const minX = lines[column]
        + getStreetWidth(lines[column], STREAMING_ROAD_WIDTH) * 0.5;
      const maxX = lines[column + 1]
        - getStreetWidth(lines[column + 1], STREAMING_ROAD_WIDTH) * 0.5;
      if (maxX - minX <= SIDEWALK_WIDTH * 2
        || maxZ - minZ <= SIDEWALK_WIDTH * 2) continue;

      const along = 0.34 + seededValue(descriptor.seed, blockIndex * 5) * 0.32;
      const horizontal = seededValue(descriptor.seed, blockIndex * 5 + 1) < 0.5;
      const positiveSide = seededValue(descriptor.seed, blockIndex * 5 + 2) < 0.5;
      const size = 0.9 + seededValue(descriptor.seed, blockIndex * 5 + 3) * 0.18;
      const windYaw = (seededValue(descriptor.seed, blockIndex * 5 + 4) - 0.5) * 0.36;
      const yaw = profile === STREETSCAPE_PROFILES.windswept
        ? windYaw
        : seededValue(descriptor.seed, blockIndex * 5 + 4) * Math.PI;
      const localX = horizontal
        ? THREE.MathUtils.lerp(minX, maxX, along)
        : (positiveSide ? maxX - 1.45 : minX + 1.45);
      const localZ = horizontal
        ? (positiveSide ? maxZ - 1.45 : minZ + 1.45)
        : THREE.MathUtils.lerp(minZ, maxZ, along);
      placeTree(
        localX,
        localZ,
        yaw,
        size,
        0.94 + seededValue(descriptor.seed, blockIndex * 7 + 17) * 0.1,
      );

      if (profile.extraCadence
        && (blockIndex + descriptor.seed) % profile.extraCadence === 0) {
        const extraX = horizontal
          ? THREE.MathUtils.lerp(minX, maxX, 1 - along)
          : (positiveSide ? minX + 1.45 : maxX - 1.45);
        const extraZ = horizontal
          ? (positiveSide ? minZ + 1.45 : maxZ - 1.45)
          : THREE.MathUtils.lerp(minZ, maxZ, 1 - along);
        placeTree(extraX, extraZ, yaw + Math.PI * 0.5, size * 0.92, 0.98);
      }
    }
  }

  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  quaternionScratch.identity();
}

function populatePublicRealmCues(group, descriptor, catalog) {
  const cue = group.userData.publicRealmCue;
  const trim = group.userData.publicRealmTrim;
  const cable = group.userData.cableRoute;
  if (!cue || !trim || !cable) return;
  const sampledStop = catalog.getSurfaceHeight(
    descriptor.center.x + TRANSIT_STOP_X,
    descriptor.center.z + TRANSIT_STOP_Z,
  );
  const stopOffset = (Number.isFinite(sampledStop) ? sampledStop : descriptor.elevation)
    - descriptor.elevation;
  cue.position.y = stopOffset + GROUND_SURFACE_OFFSET;
  trim.position.y = cue.position.y;
  const sampledCable = catalog.getSurfaceHeight(descriptor.center);
  const cableOffset = (Number.isFinite(sampledCable) ? sampledCable : descriptor.elevation)
    - descriptor.elevation;
  cable.position.y = cableOffset + GROUND_SURFACE_OFFSET;
  cable.visible = CABLE_ROUTE_DISTRICTS.has(descriptor.district);
}

function createBuildingVolume(
  descriptor,
  building,
  buildingIndex,
  presentedZ,
  frontageYaw,
  buildingBaseY,
  architecturalFaces,
  quality,
  district,
) {
  const rowhouse = building.geometryStyle === 'rowhouse';
  const localHalfX = building.width * (rowhouse ? 0.56 : 0.5);
  const localHalfZ = building.depth * (rowhouse ? 0.66 : 0.5);
  const quarterTurn = Math.abs(Math.sin(frontageYaw)) > 0.5;
  const halfX = quarterTurn ? localHalfZ : localHalfX;
  const halfZ = quarterTurn ? localHalfX : localHalfZ;
  const centerX = descriptor.center.x + building.x;
  const centerZ = descriptor.center.z + presentedZ;
  const minimumY = descriptor.elevation + buildingBaseY;
  const entranceNormal = new THREE.Vector3(0, 0, -1)
    .applyAxisAngle(THREE.Object3D.DEFAULT_UP, frontageYaw);
  const entranceOffset = entranceNormal.clone()
    .multiplyScalar(building.depth * (rowhouse ? 0.66 : 0.5) + 0.34);
  return Object.freeze({
    id: `${descriptor.key}:building:${buildingIndex}`,
    buildingIndex,
    sectorKey: descriptor.key,
    district,
    quality,
    architecturalFaces,
    facadeAtlasCell: quality === 'detail' ? getFacadeAtlasCell(building, district) : null,
    geometryStyle: building.geometryStyle,
    frontageYaw,
    storefrontBand: quality === 'detail',
    entrance: Object.freeze({
      x: centerX + entranceOffset.x,
      y: minimumY + 0.72,
      z: centerZ + entranceOffset.z,
      normalX: entranceNormal.x,
      normalZ: entranceNormal.z,
    }),
    center: Object.freeze({
      x: centerX,
      y: minimumY + building.height * 0.5,
      z: centerZ,
    }),
    min: Object.freeze({
      x: centerX - halfX,
      y: minimumY,
      z: centerZ - halfZ,
    }),
    max: Object.freeze({
      x: centerX + halfX,
      y: minimumY + building.height,
      z: centerZ + halfZ,
    }),
  });
}

function isBuildingFootprintOnLand(
  catalog,
  descriptor,
  building,
  presentedZ,
  frontageYaw,
) {
  if (typeof catalog.containsPosition !== 'function') return true;
  const rowhouse = building.geometryStyle === 'rowhouse';
  const halfWidth = building.width * (rowhouse ? 0.56 : 0.5);
  const halfDepth = building.depth * (rowhouse ? 0.66 : 0.5);
  const cosine = Math.cos(frontageYaw);
  const sine = Math.sin(frontageYaw);
  for (const [localX, localZ] of [
    [-halfWidth, -halfDepth],
    [-halfWidth, halfDepth],
    [halfWidth, -halfDepth],
    [halfWidth, halfDepth],
  ]) {
    const worldX = descriptor.center.x + building.x + localX * cosine + localZ * sine;
    const worldZ = descriptor.center.z + presentedZ - localX * sine + localZ * cosine;
    if (!catalog.containsPosition(worldX, worldZ)) return false;
  }
  return true;
}

function populateSlot(
  group,
  descriptor,
  sectorSize,
  quality,
  catalog,
  externalKeys,
  resources,
  qaPublicCorridorActive = false,
) {
  const meshes = group.userData.streamMeshes;
  const facades = quality === 'detail' ? group.userData.facades : null;
  const styleOrder = group.userData.geometryStyles || DETAIL_STYLES;
  const styleIndex = {};
  styleOrder.forEach((s, idx) => { styleIndex[s] = idx; });

  // Reset instance counts so recycled slots do not leak stale transforms.
  const counts = meshes.map(() => 0);
  meshes.forEach((mesh) => { mesh.count = 0; });
  let facadeCount = 0;
  if (facades) facades.count = 0;

  const buildings = generateDistrictMassing(descriptor, sectorSize, quality);

  const colorScratch = new THREE.Color();
  let atlasFrontageBuildings = 0;
  let architecturalFaceCount = 0;
  let excludedWaterfrontBuildings = 0;
  const buildingVolumes = [];
  buildings.forEach((building, buildingIndex) => {
    const presentedZ = getPresentedBuildingZ(building, qaPublicCorridorActive);
    const frontageYaw = getFrontageYaw(building, presentedZ, qaPublicCorridorActive);
    if (!isBuildingFootprintOnLand(
      catalog,
      descriptor,
      building,
      presentedZ,
      frontageYaw,
    )) {
      excludedWaterfrontBuildings += 1;
      return;
    }
    const meshIdx = styleIndex[building.geometryStyle] ?? 0;
    const mesh = meshes[meshIdx];
    if (!mesh) return;
    const instanceIndex = counts[meshIdx];
    if (instanceIndex >= mesh.userData.capacity) return;

    // The massing always retains its district palette. Atlas detail is added
    // separately to UV-safe frontage planes, so incompatible shapes remain
    // readable instead of receiving stretched windows or doors.
    const palette = getPalette(building.paletteName);
    if (palette && palette.colors.length) {
      const hex = palette.colors[building.paletteIndex % palette.colors.length];
      colorScratch.set(hex);
      mesh.setColorAt(instanceIndex, colorScratch);
    }

    const sampledSurface = catalog.getSurfaceHeight(
      descriptor.center.x + building.x,
      descriptor.center.z + presentedZ,
    );
    const buildingBaseY = (Number.isFinite(sampledSurface)
      ? sampledSurface
      : descriptor.elevation) - descriptor.elevation;
    quaternionScratch.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, frontageYaw);
    positionScratch.set(building.x, buildingBaseY, presentedZ);
    scaleScratch.set(
      building.width,
      quality === 'detail' ? building.height : building.height * 0.82,
      building.depth,
    );
    matrixScratch.compose(positionScratch, quaternionScratch, scaleScratch);
    mesh.setMatrixAt(instanceIndex, matrixScratch);
    counts[meshIdx] += 1;
    const facadeResult = populateFacadePlanes(
      facades,
      facadeCount,
      building,
      presentedZ,
      frontageYaw,
      buildingBaseY,
      descriptor.district,
    );
    facadeCount = facadeResult.instanceIndex;
    architecturalFaceCount += facadeResult.treatedFaces;
    if (facadeResult.treatedFaces === FACADE_FACES.length) {
      atlasFrontageBuildings += 1;
    }
    buildingVolumes.push(createBuildingVolume(
      descriptor,
      building,
      buildingIndex,
      presentedZ,
      frontageYaw,
      buildingBaseY,
      facadeResult.treatedFaces,
      quality,
      descriptor.district,
    ));
  });

  meshes.forEach((mesh, index) => {
    mesh.count = counts[index];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  });
  if (facades) {
    facades.count = facadeCount;
    facades.instanceMatrix.needsUpdate = true;
    ['facadeAtlasCell', 'facadeRepeat', 'facadeLayer', 'facadeTone', 'facadeVariant'].forEach((attributeName) => {
      facades.geometry.getAttribute(attributeName).needsUpdate = true;
    });
    facades.computeBoundingSphere();
  }
  quaternionScratch.identity();
  const surfaceRange = gradeSurfaceGeometry(
    group.userData.ground?.geometry,
    descriptor,
    catalog,
  );
  if (group.userData.roads) {
    const geometry = qaPublicCorridorActive
      ? group.userData.roadGeometries.transit
      : group.userData.roadGeometries.normal;
    gradeSurfaceGeometry(geometry, descriptor, catalog);
    group.userData.roads.geometry = geometry;
  }
  if (group.userData.sidewalks) {
    const geometry = qaPublicCorridorActive
      ? group.userData.sidewalkGeometries.transit
      : group.userData.sidewalkGeometries.normal;
    gradeSurfaceGeometry(geometry, descriptor, catalog);
    applyDistrictPavingTint(geometry, getStreetscapeProfile(descriptor.district));
    group.userData.sidewalks.geometry = geometry;
  }
  const heroBlock = group.userData.heroBlock;
  const heroBlockActive = quality === 'detail' && descriptor.key === HERO_BLOCK_SECTOR_KEY;
  if (heroBlock) {
    heroBlock.visible = heroBlockActive;
    if (heroBlockActive) {
      gradeSurfaceGeometry(heroBlock.geometry, descriptor, catalog);
    }
  }
  populateStreetlights(
    group.userData.streetlights,
    qaPublicCorridorActive,
    descriptor,
    catalog,
    sectorSize,
  );
  populateStreetscape(
    group.userData.streetscape,
    qaPublicCorridorActive,
    descriptor,
    catalog,
    sectorSize,
  );
  populatePublicRealmCues(group, descriptor, catalog);
  group.position.set(descriptor.center.x, descriptor.elevation, descriptor.center.z);
  updateCoreTransition(
    group,
    descriptor,
    sectorSize,
    catalog,
    externalKeys,
    qaPublicCorridorActive,
  );
  updateWaterfrontTransition(group, descriptor, sectorSize, catalog);
  group.userData.sectorKey = descriptor.key;
  group.userData.quality = quality;
  group.userData.district = descriptor.district;
  group.userData.buildingVolumes = Object.freeze(buildingVolumes);
  group.userData.presentation = Object.freeze({
    sectorKey: descriptor.key,
    district: descriptor.district,
    quality,
    mode: quality === 'detail'
      ? (qaPublicCorridorActive ? 'transit-corridor' : 'normal-detail')
      : 'proxy',
    normalPresentation: quality === 'detail' && !qaPublicCorridorActive,
    buildingCount: buildingVolumes.length,
    generatedBuildingCount: buildings.length,
    excludedWaterfrontBuildings,
    atlasFrontageBuildings,
    architecturalFaceCount,
    requiredArchitecturalFaceCount: buildingVolumes.length * FACADE_FACES.length,
    facadePlaneCount: facadeCount,
    heroBlock: heroBlockActive
      ? Object.freeze({
        sectorKey: HERO_BLOCK_SECTOR_KEY,
        frontageSegmentCount: HERO_FRONTAGE_SEGMENTS.length * 2,
        civicCue: 'civic-center-muni-blade',
        westTransitionSkirtSuppressed: true,
      })
      : null,
    roadGridDivisions: quality === 'detail' ? STREAMING_GRID_DIVISIONS : 0,
    sidewalkBlockCount: quality === 'detail'
      ? STREAMING_GRID_DIVISIONS * STREAMING_GRID_DIVISIONS
      : 0,
    crosswalkCount: quality === 'detail'
      ? (STREAMING_GRID_DIVISIONS - 1) ** 2 * 4
      : 0,
    crosswalkSeamJunctionCount: quality === 'detail'
      ? (STREAMING_GRID_DIVISIONS + 1) ** 2 - (STREAMING_GRID_DIVISIONS - 1) ** 2
      : 0,
    crosswalkStripeCount: quality === 'detail'
      ? (STREAMING_GRID_DIVISIONS - 1) ** 2 * 4 * 5
      : 0,
    crosswalkStripesPerCrossing: quality === 'detail' ? 5 : 0,
    crosswalkStripeWidth: quality === 'detail' ? CROSSWALK_STRIPE_WIDTH : 0,
    crosswalkStripeGap: quality === 'detail' ? CROSSWALK_STRIPE_GAP : 0,
    crosswalkCurbInset: quality === 'detail' ? CROSSWALK_CURB_INSET : 0,
    crosswalkIntersectionSetback: quality === 'detail'
      ? CROSSWALK_INTERSECTION_SETBACK
      : 0,
    crosswalkLongDimensions: quality === 'detail'
      ? Object.freeze({
        eastWestRoad: (
          qaPublicCorridorActive ? QA_PUBLIC_CORRIDOR_WIDTH : STREAMING_ROAD_WIDTH
        ) - CROSSWALK_CURB_INSET * 2,
        northSouthRoad: STREAMING_ROAD_WIDTH - CROSSWALK_CURB_INSET * 2,
      })
      : null,
    centerMarkLength: quality === 'detail' ? CENTER_MARK_LENGTH : 0,
    centerMarkGap: quality === 'detail' ? CENTER_MARK_GAP : 0,
    roadSurfaceOffset: quality === 'detail' ? GROUND_SURFACE_OFFSET : 0,
    markingRoadOffset: quality === 'detail' ? ROAD_MARKING_SURFACE_OFFSET : 0,
    surfacePatchMaximum: quality === 'detail' ? SURFACE_PATCH_SIZE : 0,
    markingPatchMaximum: quality === 'detail' ? ROAD_MARKING_PATCH_SIZE : 0,
    storefrontBandCount: quality === 'detail' ? buildingVolumes.length : 0,
    streetlightCount: group.userData.streetlights?.count ?? 0,
    streetscapeCount: group.userData.streetscape?.count ?? 0,
    streetscapeCapacity: quality === 'detail' ? STREAMING_STREETSCAPE_CAPACITY : 0,
    streetscapeProfile: quality === 'detail'
      ? Object.keys(STREETSCAPE_PROFILES).find(
        (profileName) => STREETSCAPE_PROFILES[profileName]
          === getStreetscapeProfile(descriptor.district),
      )
      : null,
    surfaceRange,
    waterfront: descriptor.waterfront
      ? Object.freeze({
        distance: Math.round(descriptor.waterfront.distance * 10) / 10,
        waterExtent: WATERFRONT_WATER_EXTENT,
        tidalInset: WATERFRONT_TIDAL_INSET,
      })
      : null,
    seamTreatment: quality === 'detail' ? 'continuous sampled boundary' : null,
  });
  group.visible = true;
}

function createPool(scene, createSlot) {
  const available = [];
  const inUse = new Set();
  let created = 0;
  let reused = 0;

  const acquire = () => {
    let object = available.pop();
    if (!object) {
      object = createSlot();
      scene.add(object);
      created += 1;
    } else {
      reused += 1;
    }
    object.visible = true;
    inUse.add(object);
    return object;
  };

  const release = (object) => {
    if (!object || !inUse.delete(object)) return;
    object.visible = false;
    object.userData.sectorKey = null;
    available.push(object);
  };

  return {
    acquire,
    release,
    get stats() {
      return { created, reused, active: inUse.size, parked: available.length };
    },
  };
}

export function createSanFranciscoStreaming({
  scene,
  catalog = createSanFranciscoSectorCatalog(),
  detailRadius = DEFAULT_DETAIL_RADIUS,
  proxyRadius = DEFAULT_PROXY_RADIUS,
  maxDetailed = 12,
  maxProxies = 44,
  backgroundUpdatesPerTick = 4,
  updateInterval = 0.22,
  externalDetailedKeys = ['0:0'],
  externalProtectionRadius = 0.3,
} = {}) {
  if (!scene) throw new Error('createSanFranciscoStreaming requires a Three.js scene.');
  if (proxyRadius <= detailRadius) throw new Error('proxyRadius must be greater than detailRadius.');

  // Bound descriptor scans as well as rendered pools so an accidental large
  // radius cannot turn one streaming tick into whole-city work.
  const effectiveDetailRadius = THREE.MathUtils.clamp(
    Math.floor(Number.isFinite(detailRadius) ? detailRadius : DEFAULT_DETAIL_RADIUS),
    0,
    MAX_DETAIL_RADIUS,
  );
  const effectiveProxyRadius = THREE.MathUtils.clamp(
    Math.floor(Number.isFinite(proxyRadius) ? proxyRadius : DEFAULT_PROXY_RADIUS),
    effectiveDetailRadius + 1,
    MAX_PROXY_RADIUS,
  );
  const effectiveBackgroundUpdatesPerTick = THREE.MathUtils.clamp(
    Math.floor(Number.isFinite(backgroundUpdatesPerTick) ? backgroundUpdatesPerTick : 4),
    1,
    MAX_BACKGROUND_UPDATES_PER_TICK,
  );
  const effectiveUpdateInterval = THREE.MathUtils.clamp(
    Number.isFinite(updateInterval) ? updateInterval : 0.22,
    0.05,
    2,
  );

  const detailedBudget = THREE.MathUtils.clamp(
    Math.floor(maxDetailed),
    1,
    MAX_DETAILED_SECTORS,
  );
  const proxyBudget = THREE.MathUtils.clamp(
    Math.floor(maxProxies),
    1,
    MAX_PROXY_SECTORS,
  );
  const resources = createSharedResources(catalog.sectorSize);
  const detailedPool = createPool(
    scene,
    () => createDetailedSlot(resources, catalog.sectorSize),
  );
  const proxyPool = createPool(scene, () => createProxySlot(resources));
  const runtimeSectors = new Map();
  const backgroundStates = new Map();
  const handoffQueue = [];
  const sectorFactories = new Map();
  const externalKeys = new Set(externalDetailedKeys);
  const frustum = new THREE.Frustum();
  const projectionView = new THREE.Matrix4();
  const visibilitySphere = new THREE.Sphere(new THREE.Vector3(), catalog.sectorSize * 0.72);
  const lastFocus = new THREE.Vector3(Number.NaN, 0, Number.NaN);
  const movement = new THREE.Vector3();
  let accumulator = effectiveUpdateInterval;
  let focusSector = { x: 0, z: 0 };
  let elapsedTime = 0;
  let transitionedSectors = 0;
  let backgroundCursor = 0;
  let backgroundUpdateCount = 0;
  let weather = 'clear';
  let qaPublicCorridorActive = false;
  let protectedCoreKey = null;
  let protectionActive = false;
  let streamedAgentStatsProvider = null;
  let retainedDetailSectors = 0;
  let prefetchedDetailSectors = 0;
  const handoffStats = {
    queued: 0,
    completed: 0,
    dropped: 0,
    deferred: 0,
    pending: 0,
    vehicleAgents: 0,
    pedestrianAgents: 0,
    conservationError: 0,
    destinationsCreated: 0,
    elapsedClamps: 0,
    lastPortalId: null,
  };

  const trimBackgroundStates = () => {
    while (backgroundStates.size > MAX_BACKGROUND_STATES) {
      const queuedKeys = new Set(handoffQueue.flatMap((handoff) => [handoff.fromKey, handoff.toKey]));
      const evictableKey = [...backgroundStates.keys()].find(
        (key) => !runtimeSectors.has(key) && !queuedKeys.has(key),
      );
      if (!evictableKey) break;
      backgroundStates.delete(evictableKey);
    }
  };

  const ensureBackgroundState = (descriptor) => {
    const existing = backgroundStates.get(descriptor.key);
    if (existing) {
      backgroundStates.delete(descriptor.key);
      backgroundStates.set(descriptor.key, existing);
      return existing;
    }
    const trafficClock = seededValue(descriptor.seed, 301) + elapsedTime * 0.018;
    const pedestrianClock = seededValue(descriptor.seed, 302) + elapsedTime * 0.006;
    const portalIds = {};
    HANDOFF_DIRECTIONS.forEach((direction) => {
      const neighbor = catalog.get(
        descriptor.sectorX + direction.x,
        descriptor.sectorZ + direction.z,
      );
      portalIds[direction.id] = neighbor
        ? portalIdBetween(descriptor.key, neighbor.key)
        : null;
    });
    const state = {
      stateId: `sf-sim:${descriptor.key}`,
      key: descriptor.key,
      vehicleCount: 14 + Math.floor(seededValue(descriptor.seed, 311) * 20),
      pedestrianCount: 28 + Math.floor(seededValue(descriptor.seed, 312) * 50),
      trafficClock,
      pedestrianClock,
      trafficPhase: trafficClock % 1,
      pedestrianPhase: pedestrianClock % 1,
      trafficCycle: Math.floor(trafficClock),
      pedestrianCycle: Math.floor(pedestrianClock),
      portalIds: Object.freeze(portalIds),
      updatedAt: elapsedTime,
      handoffRevision: 0,
    };
    backgroundStates.set(descriptor.key, state);
    trimBackgroundStates();
    return state;
  };

  const queueHandoff = (source, descriptor, kind, cycle, count) => {
    if (handoffQueue.length >= MAX_HANDOFF_QUEUE) {
      handoffStats.deferred += 1;
      return;
    }
    const directionStart = (descriptor.seed + cycle + (kind === 'pedestrian' ? 2 : 0)) % 4;
    for (let offset = 0; offset < HANDOFF_DIRECTIONS.length; offset += 1) {
      const direction = HANDOFF_DIRECTIONS[(directionStart + offset) % HANDOFF_DIRECTIONS.length];
      const target = catalog.get(
        descriptor.sectorX + direction.x,
        descriptor.sectorZ + direction.z,
      );
      if (!target) continue;
      const portalId = portalIdBetween(descriptor.key, target.key);
      handoffQueue.push({
        fromKey: descriptor.key,
        toKey: target.key,
        targetDescriptor: target,
        portalId,
        kind,
        count,
      });
      handoffStats.queued += 1;
      handoffStats.pending = handoffQueue.length;
      return;
    }
  };

  const processHandoffs = () => {
    while (handoffQueue.length) {
      const handoff = handoffQueue[0];
      const source = backgroundStates.get(handoff.fromKey);
      const destinationExisted = backgroundStates.has(handoff.toKey);
      const target = ensureBackgroundState(handoff.targetDescriptor);
      handoffQueue.shift();
      if (!source || !target) {
        // The queue protects both states from eviction, so this branch is an
        // invariant alarm rather than an expected lossy fallback.
        handoffStats.dropped += 1;
        continue;
      }
      const countField = handoff.kind === 'vehicle' ? 'vehicleCount' : 'pedestrianCount';
      const transferable = Math.min(handoff.count, Math.max(0, source[countField] - 1));
      const before = source.vehicleCount + source.pedestrianCount
        + target.vehicleCount + target.pedestrianCount;
      source[countField] -= transferable;
      target[countField] += transferable;
      source.handoffRevision += 1;
      target.handoffRevision += 1;
      const after = source.vehicleCount + source.pedestrianCount
        + target.vehicleCount + target.pedestrianCount;
      handoffStats.conservationError += Math.abs(after - before);
      handoffStats.completed += 1;
      if (!destinationExisted) handoffStats.destinationsCreated += 1;
      handoffStats[handoff.kind === 'vehicle' ? 'vehicleAgents' : 'pedestrianAgents']
        += transferable;
      handoffStats.lastPortalId = handoff.portalId;
    }
    handoffStats.pending = 0;
    trimBackgroundStates();
  };

  const registerSectorFactory = (key, factory) => {
    if (typeof factory !== 'function') throw new TypeError('Sector factory must be a function.');
    sectorFactories.set(key, factory);
  };

  const releaseSector = (runtime) => {
    if (!runtime) return;
    if (runtime.custom) {
      runtime.custom.setActive?.(false);
      runtime.custom.unload?.();
    } else if (runtime.quality === 'detail') {
      detailedPool.release(runtime.object);
    } else {
      proxyPool.release(runtime.object);
    }
    runtimeSectors.delete(runtime.descriptor.key);
    transitionedSectors += 1;
  };

  const activateSector = (descriptor, quality) => {
    const simulationState = ensureBackgroundState(descriptor);
    if (externalKeys.has(descriptor.key)) {
      runtimeSectors.set(descriptor.key, {
        descriptor,
        quality: 'external-detail',
        object: null,
        custom: true,
        simulationState,
      });
      return;
    }

    const factory = sectorFactories.get(descriptor.key);
    if (factory) {
      const custom = factory({ descriptor, quality, weather });
      custom?.setActive?.(true, quality);
      runtimeSectors.set(descriptor.key, {
        descriptor,
        quality,
        object: custom?.object3d || null,
        custom,
        simulationState,
      });
      return;
    }

    const pool = quality === 'detail' ? detailedPool : proxyPool;
    const object = pool.acquire();
    populateSlot(
      object,
      descriptor,
      catalog.sectorSize,
      quality,
      catalog,
      externalKeys,
      resources,
      qaPublicCorridorActive,
    );
    runtimeSectors.set(descriptor.key, {
      descriptor,
      quality,
      object,
      custom: null,
      simulationState,
    });
  };

  const transitionSector = (descriptor, quality) => {
    const current = runtimeSectors.get(descriptor.key);
    if (current?.quality === quality || (current?.quality === 'external-detail' && quality === 'detail')) return;
    if (current) releaseSector(current);
    activateSector(descriptor, quality);
    transitionedSectors += 1;
  };

  const getQaPublicCorridor = () => ({
    active: qaPublicCorridorActive,
    id: 'sf-qa-civic-east-west',
    centerZ: 0,
    width: QA_PUBLIC_CORRIDOR_WIDTH,
    clearance: QA_PUBLIC_CORRIDOR_CLEARANCE,
  });

  const getSectorPresentation = (key) => {
    const runtime = runtimeSectors.get(key);
    if (!runtime) {
      return {
        sectorKey: key,
        active: false,
        detailed: false,
        presentation: null,
      };
    }
    const presentation = runtime.object?.userData?.presentation ?? null;
    return {
      sectorKey: key,
      active: true,
      detailed: runtime.quality === 'detail' || runtime.quality === 'external-detail',
      quality: runtime.quality,
      source: runtime.descriptor.source,
      presentation: presentation
        ? {
          ...presentation,
          surfaceRange: presentation.surfaceRange
            ? { ...presentation.surfaceRange }
            : null,
        }
        : null,
    };
  };

  const getNearestEnterablePortal = (position, maxDistance = 22) => {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return null;
    let nearest = null;
    let nearestDistance = Number.isFinite(maxDistance) ? maxDistance : Infinity;
    const roomKinds = ['cafe', 'market', 'loft', 'civic', 'coit', 'ferry'];
    runtimeSectors.forEach((runtime) => {
      if (runtime.quality !== 'detail' || !runtime.object) return;
      const volumes = runtime.object.userData?.buildingVolumes ?? [];
      volumes.forEach((volume) => {
        const entrance = volume.entrance;
        if (!entrance) return;
        const distance = Math.hypot(
          position.x - entrance.x,
          position.z - entrance.z,
        );
        if (distance >= nearestDistance) return;
        let variantSeed = 17;
        for (const character of volume.id) {
          variantSeed = (variantSeed * 31 + character.charCodeAt(0)) >>> 0;
        }
        const roomKind = roomKinds[variantSeed % roomKinds.length];
        nearestDistance = distance;
        nearest = {
          id: `sf-streamed-portal:${volume.id}`,
          label: `${volume.district} ${volume.buildingIndex + 1} Public Lobby`,
          position: {
            x: entrance.x,
            y: entrance.y,
            z: entrance.z,
          },
          approach: {
            x: entrance.x + entrance.normalX * 3.6,
            y: entrance.y,
            z: entrance.z + entrance.normalZ * 3.6,
          },
          radius: 4.8,
          featured: false,
          door: true,
          signposted: true,
          roomKind,
          variantSeed,
          sectorKey: volume.sectorKey,
          buildingId: volume.id,
          district: volume.district,
          source: 'generated-massing',
          distance,
        };
      });
    });
    return nearest;
  };

  const getPublicRealmPoint = (position) => {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
      return null;
    }
    const coordinates = catalog.sectorAt(position);
    const descriptor = catalog.get(coordinates.x, coordinates.z);
    const surfaceHeight = catalog.getSurfaceHeight(position);
    if (!descriptor || !Number.isFinite(surfaceHeight)) return null;
    const localX = position.x - descriptor.center.x;
    const localZ = position.z - descriptor.center.z;
    const lines = getStreetGridLines(catalog.sectorSize);
    const nearestX = lines.reduce((nearest, line) => (
      Math.abs(localX - line) < Math.abs(localX - nearest) ? line : nearest
    ), lines[0]);
    const nearestZ = lines.reduce((nearest, line) => (
      Math.abs(localZ - line) < Math.abs(localZ - nearest) ? line : nearest
    ), lines[0]);
    const northSouthWidth = getStreetWidth(nearestX, STREAMING_ROAD_WIDTH);
    const eastWestWidth = getStreetWidth(
      nearestZ,
      qaPublicCorridorActive ? QA_PUBLIC_CORRIDOR_WIDTH : STREAMING_ROAD_WIDTH,
    );
    const northSouthRoad = Math.abs(localX - nearestX) <= northSouthWidth * 0.5;
    const eastWestRoad = Math.abs(localZ - nearestZ) <= eastWestWidth * 0.5;
    return {
      sectorKey: descriptor.key,
      surfaceHeight,
      local: { x: localX, z: localZ },
      mode: qaPublicCorridorActive ? 'transit-corridor' : 'normal-detail',
      onRoad: northSouthRoad || eastWestRoad,
      atIntersection: northSouthRoad && eastWestRoad,
      nearestRoadLines: { x: nearestX, z: nearestZ },
      roadWidths: { northSouth: northSouthWidth, eastWest: eastWestWidth },
      streetlightHeight: STREAMING_STREETLIGHT_HEIGHT,
    };
  };

  const validateDetailedView = (
    cameraPosition,
    lookAt,
    {
      minimumClearance = 3,
      forwardLength = 45,
      treatmentRadius = 120,
    } = {},
  ) => {
    if (!cameraPosition || !lookAt
      || !['x', 'y', 'z'].every(
        (axis) => Number.isFinite(cameraPosition[axis]) && Number.isFinite(lookAt[axis]),
      )) {
      throw new TypeError('validateDetailedView requires finite camera and lookAt coordinates.');
    }
    const direction = {
      x: lookAt.x - cameraPosition.x,
      y: lookAt.y - cameraPosition.y,
      z: lookAt.z - cameraPosition.z,
    };
    const directionLength = Math.hypot(direction.x, direction.y, direction.z);
    if (directionLength < 1e-6) {
      throw new RangeError('validateDetailedView requires a non-zero view direction.');
    }
    direction.x /= directionLength;
    direction.y /= directionLength;
    direction.z /= directionLength;

    let minimumBuildingClearance = Number.POSITIVE_INFINITY;
    let nearestBuilding = null;
    let forwardHit = null;
    let checkedBuildingVolumes = 0;
    let nearbyBuildingCount = 0;
    let nearbyProxyCount = 0;
    let untreatedFaceCount = 0;
    const untreatedBuildings = [];
    const nearbyAtlasCells = new Set();
    const nearbySilhouettes = new Set();
    let nearbyStorefrontBands = 0;

    runtimeSectors.forEach((runtime) => {
      const volumes = runtime.object?.userData?.buildingVolumes ?? [];
      volumes.forEach((volume) => {
        checkedBuildingVolumes += 1;
        const clearance = distanceToBuildingVolume(cameraPosition, volume);
        if (clearance < minimumBuildingClearance) {
          minimumBuildingClearance = clearance;
          nearestBuilding = {
            id: volume.id,
            sectorKey: volume.sectorKey,
            distance: clearance,
          };
        }
        const hitDistance = segmentBuildingIntersectionDistance(
          cameraPosition,
          direction,
          forwardLength,
          volume,
        );
        if (hitDistance != null
          && (!forwardHit || hitDistance < forwardHit.distance)) {
          forwardHit = {
            id: volume.id,
            sectorKey: volume.sectorKey,
            distance: hitDistance,
          };
        }
        if (clearance <= treatmentRadius) {
          nearbyBuildingCount += 1;
          const isProxy = volume.quality === 'proxy';
          if (isProxy) nearbyProxyCount += 1;
          const missingFaces = isProxy
            ? FACADE_FACES.length
            : Math.max(0, FACADE_FACES.length - volume.architecturalFaces);
          untreatedFaceCount += missingFaces;
          if (missingFaces > 0 && untreatedBuildings.length < 12) {
            untreatedBuildings.push({
              id: volume.id,
              sectorKey: volume.sectorKey,
              quality: volume.quality,
              missingFaces,
              distance: clearance,
            });
          }
        }
        if (clearance <= Math.min(80, treatmentRadius) && volume.quality === 'detail') {
          if (Number.isInteger(volume.facadeAtlasCell)) {
            nearbyAtlasCells.add(volume.facadeAtlasCell);
          }
          if (volume.geometryStyle) nearbySilhouettes.add(volume.geometryStyle);
          if (volume.storefrontBand) nearbyStorefrontBands += 1;
        }
      });
    });

    const finiteClearance = Number.isFinite(minimumBuildingClearance)
      ? minimumBuildingClearance
      : null;
    const clearancePass = finiteClearance != null
      && finiteClearance >= minimumClearance;
    const rayPass = forwardHit == null;
    const treatmentPass = nearbyBuildingCount > 0
      && nearbyProxyCount === 0
      && untreatedFaceCount === 0;
    return {
      valid: clearancePass && rayPass && treatmentPass,
      checkedBuildingVolumes,
      cameraClearance: {
        required: minimumClearance,
        actual: finiteClearance,
        clear: clearancePass,
        nearestBuilding,
      },
      forwardRay: {
        length: forwardLength,
        clear: rayPass,
        hit: forwardHit,
      },
      nearbyTreatment: {
        radius: treatmentRadius,
        buildingCount: nearbyBuildingCount,
        proxyCount: nearbyProxyCount,
        untreatedFaceCount,
        complete: treatmentPass,
        untreatedBuildings,
      },
      nearbyVariety: {
        radius: Math.min(80, treatmentRadius),
        atlasCells: [...nearbyAtlasCells].sort(),
        silhouettes: [...nearbySilhouettes].sort(),
        storefrontBands: nearbyStorefrontBands,
      },
    };
  };

  const setQaPublicCorridorActive = (active) => {
    const next = active === true;
    if (next === qaPublicCorridorActive) return getQaPublicCorridor();
    qaPublicCorridorActive = next;
    // Repaint in-use pooled slots in place. This changes neither streaming
    // focus nor allocation, so handoffs and the hard detail/proxy caps remain
    // authoritative while QA framing switches between normal and avenue views.
    runtimeSectors.forEach((runtime) => {
      if (runtime.custom || !runtime.object) return;
      populateSlot(
        runtime.object,
        runtime.descriptor,
        catalog.sectorSize,
        runtime.quality,
        catalog,
        externalKeys,
        resources,
        qaPublicCorridorActive,
      );
    });
    return getQaPublicCorridor();
  };

  const isVisibleOrImminent = (descriptor, camera, sectorDistance) => {
    if (sectorDistance <= effectiveDetailRadius + 1) return true;
    if (!camera) return sectorDistance <= effectiveProxyRadius;
    visibilitySphere.center.set(descriptor.center.x, descriptor.elevation + 38, descriptor.center.z);
    if (frustum.intersectsSphere(visibilitySphere)) return true;
    if (movement.lengthSq() < 1) return false;
    const toSectorX = descriptor.center.x - lastFocus.x;
    const toSectorZ = descriptor.center.z - lastFocus.z;
    const length = Math.hypot(toSectorX, toSectorZ) || 1;
    return (toSectorX * movement.x + toSectorZ * movement.z) / length > 0.62;
  };

  const updateBackground = (candidateDescriptors) => {
    if (!candidateDescriptors.length) return;
    for (let count = 0; count < effectiveBackgroundUpdatesPerTick; count += 1) {
      const descriptor = candidateDescriptors[backgroundCursor % candidateDescriptors.length];
      backgroundCursor += 1;
      const state = ensureBackgroundState(descriptor);
      const previousTrafficCycle = state.trafficCycle;
      const previousPedestrianCycle = state.pedestrianCycle;
      state.trafficClock = seededValue(descriptor.seed, 301) + elapsedTime * 0.018;
      state.pedestrianClock = seededValue(descriptor.seed, 302) + elapsedTime * 0.006;
      state.trafficPhase = state.trafficClock % 1;
      state.pedestrianPhase = state.pedestrianClock % 1;
      state.trafficCycle = Math.floor(state.trafficClock);
      state.pedestrianCycle = Math.floor(state.pedestrianClock);
      state.updatedAt = elapsedTime;
      if (state.trafficCycle > previousTrafficCycle) {
        queueHandoff(
          state,
          descriptor,
          'vehicle',
          state.trafficCycle,
          Math.min(2, state.trafficCycle - previousTrafficCycle),
        );
      }
      if (state.pedestrianCycle > previousPedestrianCycle) {
        queueHandoff(
          state,
          descriptor,
          'pedestrian',
          state.pedestrianCycle,
          Math.min(3, state.pedestrianCycle - previousPedestrianCycle),
        );
      }
      backgroundUpdateCount += 1;
    }
    processHandoffs();
  };

  const reconcile = (position, camera) => {
    focusSector = catalog.sectorAt(position);
    const focusKey = `${focusSector.x}:${focusSector.z}`;
    const focusDescriptor = catalog.get(focusSector.x, focusSector.z);
    protectedCoreKey = externalKeys.has(focusKey) ? focusKey : null;
    if (protectedCoreKey && focusDescriptor) {
      const distanceFromSectorCenter = Math.max(
        Math.abs(position.x - focusDescriptor.center.x),
        Math.abs(position.z - focusDescriptor.center.z),
      );
      protectionActive = distanceFromSectorCenter
        < catalog.sectorSize * externalProtectionRadius;
    } else {
      protectionActive = false;
    }
    if (camera) {
      camera.updateMatrixWorld();
      projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projectionView);
    }

    const desired = [];
    const backgroundCandidates = [];
    for (let dz = -effectiveProxyRadius - 1; dz <= effectiveProxyRadius + 1; dz += 1) {
      for (let dx = -effectiveProxyRadius - 1; dx <= effectiveProxyRadius + 1; dx += 1) {
        const descriptor = catalog.get(focusSector.x + dx, focusSector.z + dz);
        if (!descriptor) continue;
        const sectorDistance = Math.max(Math.abs(dx), Math.abs(dz));
        backgroundCandidates.push(descriptor);
        if (sectorDistance > effectiveProxyRadius) continue;
        // External sectors carry authored skyline composition. Keep generated
        // massing parked while the traveler is in the protected central
        // aperture, but continue descriptor/background prefetch above. The
        // normal ring appears well before the traveler reaches the seam.
        if (protectionActive && !externalKeys.has(descriptor.key)) continue;
        const distanceMeters = Math.hypot(
          descriptor.center.x - position.x,
          descriptor.center.z - position.z,
        );
        const ahead = movement.lengthSq() > 1
          && (descriptor.center.x - position.x) * movement.x
            + (descriptor.center.z - position.z) * movement.z > 0;
        const current = runtimeSectors.get(descriptor.key);
        const isRetainedDetail = current?.quality === 'detail'
          && sectorDistance <= DETAIL_RETENTION_DISTANCE;
        const isPrefetchedDetail = sectorDistance === effectiveDetailRadius + 1
          && ahead
          && distanceMeters < catalog.sectorSize * (effectiveDetailRadius + 1.15);
        const detailPriority = sectorDistance <= effectiveDetailRadius
          ? 0
          : isRetainedDetail
            ? 1
            : isPrefetchedDetail
              ? 2
              : null;
        const requestedQuality = detailPriority == null ? 'proxy' : 'detail';
        // Keep the original proxy visibility admission for distant authored
        // sectors, but once admitted budget them by their effective runtime
        // quality. activateSector() always resolves external keys as detail.
        if (requestedQuality === 'proxy'
          && !isVisibleOrImminent(descriptor, camera, sectorDistance)) continue;
        const isExternalDetail = externalKeys.has(descriptor.key);
        const quality = isExternalDetail ? 'detail' : requestedQuality;
        desired.push({
          descriptor,
          quality,
          distanceMeters,
          isExternalDetail,
          detailPriority,
        });
      }
    }

    desired.sort((a, b) => {
      // An admitted authored sector has no generated fallback. Reserve it a
      // bounded detail slot instead of letting it escape the cap as a proxy
      // or disappear behind a full generated-detail selection.
      if (a.isExternalDetail !== b.isExternalDetail) return a.isExternalDetail ? -1 : 1;
      if (a.quality === 'detail' && b.quality === 'detail'
        && a.detailPriority !== b.detailPriority) {
        return a.detailPriority - b.detailPriority;
      }
      const distanceDelta = a.distanceMeters - b.distanceMeters;
      return Math.abs(distanceDelta) > 1e-6
        ? distanceDelta
        : a.descriptor.key.localeCompare(b.descriptor.key);
    });
    let detailedCount = 0;
    let proxyCount = 0;
    const selected = [];
    desired.forEach((item) => {
      if (item.quality === 'detail') {
        if (detailedCount >= detailedBudget) return;
        detailedCount += 1;
      } else {
        if (proxyCount >= proxyBudget) return;
        proxyCount += 1;
      }
      selected.push(item);
    });
    retainedDetailSectors = selected.filter((item) => item.detailPriority === 1).length;
    prefetchedDetailSectors = selected.filter((item) => item.detailPriority === 2).length;

    // Park sectors before acquiring replacements. This keeps pool allocation
    // bounded by the active budgets even during a fast cross-city teleport.
    const desiredKeys = new Set(selected.map((item) => item.descriptor.key));
    [...runtimeSectors.values()].forEach((runtime) => {
      if (!desiredKeys.has(runtime.descriptor.key)) releaseSector(runtime);
    });
    selected.forEach((item) => {
      const current = runtimeSectors.get(item.descriptor.key);
      const matches = current?.quality === item.quality
        || (current?.quality === 'external-detail' && item.quality === 'detail');
      if (current && !matches) releaseSector(current);
    });
    selected.forEach((item) => transitionSector(item.descriptor, item.quality));
    updateBackground(backgroundCandidates);
  };

  const update = (position, camera, dt = 0, elapsed = undefined) => {
    if (!position) return;
    const requestedElapsed = Number.isFinite(elapsed)
      ? elapsed
      : elapsedTime + Math.max(0, dt);
    if (requestedElapsed < elapsedTime) handoffStats.elapsedClamps += 1;
    elapsedTime = Math.max(elapsedTime, requestedElapsed);
    if (Number.isFinite(lastFocus.x)) movement.copy(position).sub(lastFocus);
    else movement.set(0, 0, 0);
    lastFocus.copy(position);
    accumulator += Math.max(0, dt);
    const currentSector = catalog.sectorAt(position);
    const crossedSector = currentSector.x !== focusSector.x || currentSector.z !== focusSector.z;
    if (!crossedSector && accumulator < effectiveUpdateInterval) return;
    accumulator = 0;
    reconcile(position, camera);
  };

  const setWeather = (mode) => {
    weather = ['clear', 'fog', 'drizzle'].includes(mode) ? mode : 'clear';
    resources.groundMaterial.color.set(weather === 'drizzle' ? 0x3d4948 : weather === 'fog' ? 0x66706d : 0x5b625f);
    resources.groundMaterial.roughness = weather === 'drizzle' ? 0.72 : 0.94;
    resources.groundMaterial.metalness = weather === 'drizzle' ? 0 : 0.02;
    resources.waterfrontMaterial.color.set(
      weather === 'drizzle' ? 0x315c68 : weather === 'fog' ? 0x58727a : 0x3d7180,
    );
    resources.waterfrontMaterial.roughness = weather === 'drizzle' ? 0.2 : 0.34;
    resources.waterfrontMaterial.metalness = weather === 'drizzle' ? 0.42 : 0.28;
    // Keep the vertex-authored warm-white paint white in every weather mode;
    // wetness is conveyed by roughness instead of tinting the shared multiplier.
    resources.roadMaterial.color.setHex(0xffffff);
    resources.roadMaterial.roughness = weather === 'drizzle' ? 0.62 : weather === 'fog' ? 0.9 : 0.86;
    resources.roadMaterial.metalness = weather === 'drizzle' ? 0 : 0.04;
    resources.sidewalkMaterial.color.set(
      weather === 'drizzle' ? 0x89908d : weather === 'fog' ? 0xf0ede7 : 0xffffff,
    );
    resources.sidewalkMaterial.roughness = weather === 'drizzle' ? 0.74 : 0.94;
    resources.streetscapeMaterial.roughness = weather === 'drizzle' ? 0.68 : 0.9;
    resources.detailedBaseMaterial.roughness = weather === 'drizzle' ? 0.66 : weather === 'fog' ? 0.84 : 0.78;
    resources.proxyMaterial.color.set(
      weather === 'drizzle' ? 0x595e5f : weather === 'fog' ? 0x828485 : 0x767a7b,
    );
    runtimeSectors.forEach((runtime) => runtime.custom?.setWeather?.(weather));
  };

  const prefetch = (position, radius = effectiveDetailRadius + 1) => {
    const center = catalog.sectorAt(position);
    const descriptors = [];
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const descriptor = catalog.get(center.x + dx, center.z + dz);
        if (descriptor) descriptors.push(descriptor);
      }
    }
    return descriptors;
  };

  const setStreamedAgentStatsProvider = (provider) => {
    if (provider !== null && typeof provider !== 'function') {
      throw new TypeError('Streamed agent stats provider must be a function or null.');
    }
    streamedAgentStatsProvider = provider;
  };

  const getStats = () => {
    const detailed = [...runtimeSectors.values()]
      .filter((runtime) => runtime.quality === 'detail' || runtime.quality === 'external-detail').length;
    const proxies = [...runtimeSectors.values()].filter((runtime) => runtime.quality === 'proxy').length;
    return {
      model: '384 m sector grid / near detail / frustum-aware proxy ring / bounded coarse background',
      sectorSize: catalog.sectorSize,
      totalCitySectors: catalog.totalSectors,
      footprintAreaKm2: Math.round(catalog.footprintAreaKm2 * 10) / 10,
      localOriginElevation: catalog.get(0, 0)?.elevation ?? 0,
      sourceDatumElevation: Math.round(catalog.originElevation * 100) / 100,
      qaPublicCorridor: getQaPublicCorridor(),
      protectedCoreKey,
      externalProtectionRadius,
      protectionActive,
      descriptorMetadataLoaded: catalog.loadedDescriptorCount,
      maxDescriptorMetadata: catalog.maxCachedDescriptors,
      focusSector: `${focusSector.x}:${focusSector.z}`,
      activeDetailed: detailed,
      activeProxies: proxies,
      activeRuntimeSectors: runtimeSectors.size,
      enterableBuildings: [...runtimeSectors.values()]
        .filter((runtime) => runtime.quality === 'detail')
        .reduce((count, runtime) => count + (runtime.object?.userData?.buildingVolumes?.length ?? 0), 0),
      enterableSectors: [...runtimeSectors.values()]
        .filter((runtime) => runtime.quality === 'detail' && (runtime.object?.userData?.buildingVolumes?.length ?? 0) > 0)
        .length,
      maxDetailed: detailedBudget,
      maxProxies: proxyBudget,
      effectiveLod: {
        detailRadius: effectiveDetailRadius,
        proxyRadius: effectiveProxyRadius,
        descriptorScanDiameter: (effectiveProxyRadius + 1) * 2 + 1,
        backgroundUpdatesPerTick: effectiveBackgroundUpdatesPerTick,
        updateInterval: effectiveUpdateInterval,
      },
      streamingContinuity: {
        retainedDetailSectors,
        prefetchedDetailSectors,
        detailRetentionDistance: DETAIL_RETENTION_DISTANCE,
      },
      massingCapacity: MASSING_CAPACITY_STATS,
      backgroundStates: backgroundStates.size,
      maxBackgroundStates: MAX_BACKGROUND_STATES,
      backgroundUpdates: backgroundUpdateCount,
      coarsePopulation: [...backgroundStates.values()].reduce(
        (totals, state) => {
          totals.vehicles += state.vehicleCount;
          totals.pedestrians += state.pedestrianCount;
          return totals;
        },
        { vehicles: 0, pedestrians: 0 },
      ),
      handoffs: { ...handoffStats },
      maxHandoffQueue: MAX_HANDOFF_QUEUE,
      transitions: transitionedSectors,
      detailedPool: detailedPool.stats,
      proxyPool: proxyPool.stats,
      streamedAgents: streamedAgentStatsProvider?.() ?? null,
      weather,
    };
  };

  update(new THREE.Vector3(0, 0, 0), null, effectiveUpdateInterval, 0);

  return {
    catalog,
    update,
    setWeather,
    setQaPublicCorridorActive,
    getQaPublicCorridor,
    getSectorPresentation,
    getNearestEnterablePortal,
    getPublicRealmPoint,
    validateDetailedView,
    prefetch,
    setStreamedAgentStatsProvider,
    registerSectorFactory,
    getPortalId(keyA, keyB) {
      return portalIdBetween(keyA, keyB);
    },
    getSectorSimulationState(key) {
      const coordinates = parseSectorKey(key);
      if (!coordinates) return null;
      const descriptor = catalog.get(coordinates.x, coordinates.z);
      if (!descriptor) return null;
      const state = ensureBackgroundState(descriptor);
      return {
        ...state,
        portalIds: { ...state.portalIds },
      };
    },
    getSurfaceHeight(position) {
      return catalog.getSurfaceHeight(position);
    },
    isSectorActive(key) {
      return runtimeSectors.has(key);
    },
    isSectorDetailed(key) {
      const quality = runtimeSectors.get(key)?.quality;
      return quality === 'detail' || quality === 'external-detail';
    },
    getStats,
    get stats() {
      return getStats();
    },
  };
}
