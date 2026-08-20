// street-furniture - presentation pass.
//
// Owner: Terrain/streets. Contract: src/render/pass-registry.js.
//
// WHAT THIS FIXES
//
// At pedestrian eye level the shipped street has almost nothing on it. The
// legacy renderer places at most a couple of hundred props across a whole
// city and a single alternating tree line, so a hero frame contains no
// hydrant, no meter, no sign pole, no bollard, no bin, no rack, no news box,
// no shelter, no bench, no planter and no mailbox. An empty footway reads as a
// grey slab no matter how well the slab itself is built.
//
// This pass furnishes the footway city-wide from the street contract:
//
//   * every item is placed inside the footway band of the segment it claims,
//     between the back of the curb and a reserved pedestrian through-route,
//     and is rejected with a recorded reason when it does not fit;
//   * placement clusters the way a real street does - corners carry the sign
//     poles, the hydrant, the bollards and the news boxes; mid-block carries
//     meters, trees, bins and racks; a transit stop earns a shelter and a flag;
//   * nothing overlaps: items are tested against each other, against the
//     building footprints in the city contract, and against the props the
//     legacy renderer has ALREADY put in the world at build time, which are
//     read out of the scene graph rather than guessed at;
//   * street trees carry a real pit - soil and a cast grate - so a trunk never
//     grows straight out of a concrete slab.
//
// BUDGET. Items are instanced per (kind, level of detail) so a kind costs one
// draw call per level, and each item is assigned to a distance ring from
// `ctx.focus` that decides its level of detail and whether it exists at all.
// The QA capture path is a software GL backend, so the ring radii and the caps
// below are deliberately conservative; both the measurement and the cap are in
// the diagnostics this pass returns.
//
// Determinism: no Math.random, no Date.now. Every choice is a hash of a source
// id, so two builds of one city are bit-identical.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  buildStreetscapePlan,
  sidewalkBand,
  sidewalkSurfaceY,
  streetStationAt,
  streetRandom,
  streetHash32,
} from '../../world/streets/street-surface-v2.js';
import { surfaceOptionsFor } from './street-surface-detail.js';

export const STREET_FURNITURE_ID = 'street-furniture';
export const STREET_FURNITURE_VERSION = 'street-furniture-v1';

/**
 * Distance rings from `ctx.focus`. `lod` selects the geometry variant; `kinds`
 * is null for "every kind", or the restricted set a far ring carries.
 */
export const STREET_FURNITURE_RINGS = Object.freeze([
  Object.freeze({ id: 'near', radius: 80, lod: 0, pitchScale: 1, maxItems: 900, maxTriangles: 90000, kinds: null }),
  Object.freeze({ id: 'mid', radius: 200, lod: 1, pitchScale: 1.35, maxItems: 2200, maxTriangles: 90000, kinds: null }),
  Object.freeze({
    id: 'far',
    radius: 440,
    lod: 2,
    pitchScale: 2.4,
    maxItems: 3200,
    maxTriangles: 70000,
    // Only the silhouettes that still read at 200-440 m.
    kinds: Object.freeze(['tree', 'signPole', 'transitShelter', 'busStopFlag', 'payStation']),
  }),
]);

export const STREET_FURNITURE_BUDGET = Object.freeze({
  maxTriangles: 260000,
  maxDrawCalls: 48,
  rings: STREET_FURNITURE_RINGS,
});

/**
 * Where in the footway band a kind belongs.
 *   curb     - the furnishing strip against the back of the curb
 *   mid      - the middle of a wide footway
 *   building - hard against the property line, and only if a wall is there
 */
const ZONES = Object.freeze({ CURB: 'curb', MID: 'mid', BUILDING: 'building' });

/**
 * The furniture catalogue. `radius` is the plan footprint used for the overlap
 * test, `minWalk` the narrowest footway the kind may stand on, `gap` the
 * along-street spacing when a run of this kind is laid out, and `weight` the
 * relative chance per street class rank band (service/residential/collector/
 * arterial).
 */
export const STREET_FURNITURE_KINDS = Object.freeze({
  hydrant: { zone: ZONES.CURB, radius: 0.34, depth: 0.22, minWalk: 1.3, gap: 70, height: 0.78, weight: [1, 2, 2, 2], corner: 3 },
  parkingMeter: { zone: ZONES.CURB, radius: 0.2, depth: 0.11, minWalk: 1.2, gap: 6.5, height: 1.25, weight: [0, 2, 5, 5], corner: 0 },
  payStation: { zone: ZONES.CURB, radius: 0.3, depth: 0.16, minWalk: 1.5, gap: 60, height: 1.5, weight: [0, 1, 2, 3], corner: 1 },
  signPole: { zone: ZONES.CURB, radius: 0.16, depth: 0.06, minWalk: 1.1, gap: 34, height: 2.6, weight: [1, 2, 2, 2], corner: 5 },
  bollard: { zone: ZONES.CURB, radius: 0.16, depth: 0.09, minWalk: 1.2, gap: 1.6, height: 0.92, weight: [1, 1, 1, 1], corner: 2 },
  wasteBin: { zone: ZONES.CURB, radius: 0.36, depth: 0.32, minWalk: 1.6, gap: 45, height: 0.94, weight: [1, 2, 3, 4], corner: 3 },
  bikeRack: { zone: ZONES.CURB, radius: 0.55, depth: 0.1, minWalk: 1.6, gap: 24, height: 0.9, weight: [0, 1, 3, 3], corner: 1 },
  newsBox: { zone: ZONES.CURB, radius: 0.32, depth: 0.22, minWalk: 1.6, gap: 1.0, height: 1.18, weight: [0, 1, 2, 3], corner: 3 },
  mailbox: { zone: ZONES.CURB, radius: 0.42, depth: 0.24, minWalk: 1.7, gap: 120, height: 1.2, weight: [0, 1, 2, 2], corner: 2 },
  tree: { zone: ZONES.CURB, radius: 0.62, depth: 0.55, minWalk: 1.8, gap: 11, height: 6.4, weight: [1, 5, 5, 4], corner: 0, through: 0.95 },
  planter: { zone: ZONES.MID, radius: 0.55, depth: 0.34, minWalk: 2.2, gap: 40, height: 0.8, weight: [0, 1, 2, 2], corner: 1 },
  bench: { zone: ZONES.MID, radius: 0.9, depth: 0.3, minWalk: 2.3, gap: 55, height: 0.86, weight: [0, 2, 2, 2], corner: 0 },
  transitShelter: { zone: ZONES.CURB, radius: 2.1, depth: 0.66, minWalk: 2.45, gap: 210, height: 2.6, weight: [0, 1, 2, 3], corner: 0, through: 0.9 },
  busStopFlag: { zone: ZONES.CURB, radius: 0.18, depth: 0.06, minWalk: 1.2, gap: 210, height: 2.9, weight: [0, 1, 2, 3], corner: 0 },
  standpipe: { zone: ZONES.BUILDING, radius: 0.22, depth: 0.12, minWalk: 1.6, gap: 34, height: 1.05, weight: [0, 2, 3, 4], corner: 0 },
  wallMeter: { zone: ZONES.BUILDING, radius: 0.18, depth: 0.1, minWalk: 1.4, gap: 26, height: 1.5, weight: [0, 3, 3, 3], corner: 0 },
});

export const STREET_FURNITURE_KIND_IDS = Object.freeze(Object.keys(STREET_FURNITURE_KINDS));

const PALETTE = Object.freeze({
  hydrantBody: '#b23a2c',
  hydrantCap: '#c9c6bd',
  meterPole: '#63676a',
  meterHead: '#8b9094',
  poleGrey: '#7c8083',
  signWhite: '#eae6dc',
  signRed: '#a8342a',
  signGreen: '#2f5f45',
  signBlue: '#2b4c78',
  bollardBlack: '#3c3f42',
  binGreen: '#3f5346',
  binGrey: '#6d6f6d',
  rackSteel: '#9aa0a4',
  newsBoxNeutral: '#c9ccce',
  newsBoxA: '#2f5d86',
  newsBoxB: '#8a5c2c',
  newsBoxC: '#6a6f73',
  mailboxBlue: '#2b4c78',
  benchWood: '#8a6440',
  benchFrame: '#4d5154',
  planterConcrete: '#b9b3a4',
  planterSoil: '#4a3d30',
  shelterGlass: '#9fb6c4',
  shelterFrame: '#5b6064',
  shelterRoof: '#787d80',
  standpipeBrass: '#9a7c3c',
  standpipeBody: '#8e3a30',
  meterBoxGrey: '#8d908c',
  trunk: '#6f5b46',
  canopyA: '#5f7f47',
  canopyB: '#6d8b4e',
  canopyC: '#516f3c',
  pitSoil: '#3f362c',
  pitGrate: '#5a5c58',
});

const UP = Object.freeze({ x: 0, y: 1, z: 0 });

/** Kinds thick enough for a shadow map texel to resolve. */
const SHADOW_CASTING_KINDS = new Set([
  'tree', 'transitShelter', 'bench', 'planter', 'mailbox', 'newsBox',
  'wasteBin', 'payStation', 'hydrant', 'bikeRack',
]);

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToLinear(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  ];
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// item geometry
// ---------------------------------------------------------------------------
//
// Every kind is a small merged geometry with a baked vertex colour, built once
// per pass build and shared by every instance of that kind at that level of
// detail. Instances add their own tint through `InstancedMesh.setColorAt`, so
// two hydrants can differ without a second draw call.

function tint(geometry, hex) {
  const [r, g, b] = hexToLinear(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  if (!geometry.getAttribute('uv')) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geometry;
}

function box(w, h, d, hex, x = 0, y = 0, z = 0) {
  return tint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
}

function cyl(rTop, rBottom, h, sides, hex, x = 0, y = 0, z = 0) {
  return tint(new THREE.CylinderGeometry(rTop, rBottom, h, sides).translate(x, y, z), hex);
}

function cone(r, h, sides, hex, x = 0, y = 0, z = 0) {
  return tint(new THREE.ConeGeometry(r, h, sides).translate(x, y, z), hex);
}

function assemble(parts) {
  const merged = mergeGeometries(parts.filter(Boolean), false);
  for (const part of parts) part?.dispose?.();
  if (merged) merged.computeBoundingSphere();
  return merged;
}

/**
 * The catalogue geometry, by kind and level of detail.
 * Local frame: origin on the footway, +Y up, -Z toward the carriageway (an
 * item is rotated so -Z faces the road), +X along the street.
 */
function buildCatalogue(lod) {
  const coarse = lod > 0;
  const sides = coarse ? 5 : 8;
  const g = {};

  g.hydrant = assemble([
    cyl(0.16, 0.19, 0.62, sides, PALETTE.hydrantBody, 0, 0.31, 0),
    cyl(0.11, 0.15, 0.13, sides, PALETTE.hydrantBody, 0, 0.68, 0),
    coarse ? null : cyl(0.075, 0.075, 0.06, 6, PALETTE.hydrantCap, 0, 0.76, 0),
    coarse ? null : cyl(0.055, 0.055, 0.1, 5, PALETTE.hydrantCap, 0, 0.44, -0.16).rotateX(Math.PI / 2),
    coarse ? null : cyl(0.055, 0.055, 0.1, 5, PALETTE.hydrantCap, 0, 0.44, 0.16).rotateX(Math.PI / 2),
    box(0.34, 0.05, 0.34, PALETTE.hydrantBody, 0, 0.025, 0),
  ]);

  g.parkingMeter = assemble([
    cyl(0.032, 0.04, 1.05, coarse ? 4 : 6, PALETTE.meterPole, 0, 0.525, 0),
    box(0.12, 0.28, 0.16, PALETTE.meterHead, 0, 1.18, 0),
    coarse ? null : box(0.09, 0.11, 0.01, PALETTE.signWhite, 0, 1.22, -0.085),
  ]);

  g.payStation = assemble([
    cyl(0.05, 0.06, 0.75, coarse ? 4 : 6, PALETTE.meterPole, 0, 0.375, 0),
    box(0.34, 0.62, 0.22, PALETTE.meterHead, 0, 1.06, 0),
    coarse ? null : box(0.24, 0.2, 0.012, PALETTE.signWhite, 0, 1.2, -0.115),
    box(0.36, 0.06, 0.24, PALETTE.meterPole, 0, 1.4, 0),
  ]);

  g.signPole = assemble([
    cyl(0.032, 0.038, 2.6, coarse ? 4 : 6, PALETTE.poleGrey, 0, 1.3, 0),
    // Street-name blade, both directions, at the height a real blade sits.
    box(0.9, 0.16, 0.012, PALETTE.signGreen, 0.42, 2.42, 0),
    coarse ? null : box(0.012, 0.16, 0.9, PALETTE.signGreen, 0, 2.24, 0.42),
    // Regulatory plate below it.
    box(0.32, 0.42, 0.012, PALETTE.signWhite, 0, 1.82, -0.03),
    coarse ? null : box(0.26, 0.26, 0.012, PALETTE.signRed, 0, 1.34, -0.03),
  ]);

  g.bollard = assemble([
    cyl(0.075, 0.085, 0.86, coarse ? 4 : 6, PALETTE.bollardBlack, 0, 0.43, 0),
    coarse ? null : cyl(0.055, 0.078, 0.07, 6, PALETTE.bollardBlack, 0, 0.89, 0),
    coarse ? null : cyl(0.09, 0.09, 0.05, 6, PALETTE.rackSteel, 0, 0.6, 0),
  ]);

  g.wasteBin = assemble([
    cyl(0.29, 0.26, 0.82, sides, PALETTE.binGreen, 0, 0.41, 0),
    cyl(0.31, 0.31, 0.07, sides, PALETTE.binGrey, 0, 0.86, 0),
    coarse ? null : box(0.26, 0.2, 0.02, PALETTE.binGrey, 0, 0.62, -0.27),
  ]);

  g.bikeRack = assemble([
    box(0.06, 0.86, 0.06, PALETTE.rackSteel, -0.44, 0.43, 0),
    box(0.06, 0.86, 0.06, PALETTE.rackSteel, 0.44, 0.43, 0),
    box(0.94, 0.06, 0.06, PALETTE.rackSteel, 0, 0.86, 0),
    coarse ? null : box(0.2, 0.05, 0.2, PALETTE.rackSteel, -0.44, 0.025, 0),
    coarse ? null : box(0.2, 0.05, 0.2, PALETTE.rackSteel, 0.44, 0.025, 0),
  ]);

  g.newsBox = assemble([
    box(0.44, 0.78, 0.4, PALETTE.newsBoxNeutral, 0, 0.51, 0),
    box(0.46, 0.1, 0.42, PALETTE.newsBoxC, 0, 1.0, 0),
    coarse ? null : box(0.3, 0.3, 0.014, PALETTE.signWhite, 0, 0.72, -0.205),
    box(0.1, 0.24, 0.1, PALETTE.newsBoxC, -0.14, 0.12, 0),
    box(0.1, 0.24, 0.1, PALETTE.newsBoxC, 0.14, 0.12, 0),
  ]);

  g.mailbox = assemble([
    box(0.52, 0.72, 0.44, PALETTE.mailboxBlue, 0, 0.68, 0),
    cyl(0.26, 0.26, 0.52, coarse ? 4 : 8, PALETTE.mailboxBlue, 0, 1.04, 0).rotateZ(Math.PI / 2),
    box(0.1, 0.32, 0.1, PALETTE.benchFrame, -0.18, 0.16, 0),
    box(0.1, 0.32, 0.1, PALETTE.benchFrame, 0.18, 0.16, 0),
  ]);

  g.bench = assemble([
    box(1.72, 0.07, 0.16, PALETTE.benchWood, 0, 0.44, -0.16),
    box(1.72, 0.07, 0.16, PALETTE.benchWood, 0, 0.44, 0.02),
    coarse ? null : box(1.72, 0.07, 0.16, PALETTE.benchWood, 0, 0.44, 0.2),
    box(1.72, 0.16, 0.07, PALETTE.benchWood, 0, 0.72, 0.28),
    box(0.08, 0.44, 0.5, PALETTE.benchFrame, -0.76, 0.22, 0.04),
    box(0.08, 0.44, 0.5, PALETTE.benchFrame, 0.76, 0.22, 0.04),
  ]);

  g.planter = assemble([
    box(1.05, 0.62, 0.66, PALETTE.planterConcrete, 0, 0.31, 0),
    box(0.9, 0.06, 0.52, PALETTE.planterSoil, 0, 0.63, 0),
    coarse ? null : cone(0.26, 0.5, 5, PALETTE.canopyA, 0, 0.9, 0),
  ]);

  g.transitShelter = assemble([
    box(0.09, 2.45, 0.09, PALETTE.shelterFrame, -1.9, 1.22, -0.5),
    box(0.09, 2.45, 0.09, PALETTE.shelterFrame, 1.9, 1.22, -0.5),
    box(0.09, 2.45, 0.09, PALETTE.shelterFrame, -1.9, 1.22, 0.5),
    box(0.09, 2.45, 0.09, PALETTE.shelterFrame, 1.9, 1.22, 0.5),
    box(4.1, 0.12, 1.3, PALETTE.shelterRoof, 0, 2.5, 0),
    box(3.8, 1.9, 0.05, PALETTE.shelterGlass, 0, 1.4, 0.52),
    coarse ? null : box(0.9, 1.9, 0.05, PALETTE.shelterGlass, -1.6, 1.4, -0.52),
    coarse ? null : box(1.7, 0.07, 0.34, PALETTE.benchWood, 0.4, 0.5, 0.32),
    coarse ? null : box(0.07, 0.5, 0.34, PALETTE.shelterFrame, -0.42, 0.25, 0.32),
  ]);

  g.busStopFlag = assemble([
    cyl(0.03, 0.036, 2.8, coarse ? 4 : 6, PALETTE.poleGrey, 0, 1.4, 0),
    box(0.42, 0.62, 0.014, PALETTE.signBlue, 0, 2.5, -0.03),
    coarse ? null : box(0.3, 0.12, 0.014, PALETTE.signWhite, 0, 2.62, -0.04),
  ]);

  g.standpipe = assemble([
    cyl(0.055, 0.055, 0.95, coarse ? 4 : 6, PALETTE.standpipeBody, 0, 0.48, 0),
    cyl(0.05, 0.05, 0.16, coarse ? 4 : 6, PALETTE.standpipeBrass, 0, 0.86, -0.09).rotateX(Math.PI / 2),
    coarse ? null : cyl(0.05, 0.05, 0.16, 6, PALETTE.standpipeBrass, 0, 0.68, -0.09).rotateX(Math.PI / 2),
    box(0.2, 0.05, 0.2, PALETTE.standpipeBody, 0, 0.025, 0),
  ]);

  g.wallMeter = assemble([
    box(0.3, 0.42, 0.16, PALETTE.meterBoxGrey, 0, 1.32, 0),
    cyl(0.03, 0.03, 0.42, coarse ? 4 : 6, PALETTE.meterPole, 0, 0.9, 0),
    coarse ? null : cyl(0.09, 0.09, 0.04, 8, PALETTE.signWhite, 0, 1.38, -0.09).rotateX(Math.PI / 2),
  ]);

  g.tree = assemble([
    cyl(0.11, 0.17, 2.5, coarse ? 4 : 6, PALETTE.trunk, 0, 1.25, 0),
    cone(1.45, 2.6, coarse ? 5 : 7, PALETTE.canopyA, 0, 3.9, 0),
    cone(1.15, 2.1, coarse ? 5 : 7, PALETTE.canopyB, 0.22, 4.9, -0.14),
    lod > 1 ? null : cone(0.85, 1.7, 6, PALETTE.canopyC, -0.2, 5.6, 0.16),
  ]);

  return g;
}

// ---------------------------------------------------------------------------
// occupancy
// ---------------------------------------------------------------------------

/** Uniform grid of plan circles. Everything placed is tested against it. */
function makeOccupancy(cell = 2.5) {
  return { cell, map: new Map(), count: 0 };
}

function occupancyKey(grid, x, z) {
  return `${Math.floor(x / grid.cell)}|${Math.floor(z / grid.cell)}`;
}

function occupancyHit(grid, x, z, radius) {
  const gx = Math.floor(x / grid.cell);
  const gz = Math.floor(z / grid.cell);
  const reach = Math.ceil((radius + grid.cell) / grid.cell);
  for (let i = -reach; i <= reach; i += 1) {
    for (let j = -reach; j <= reach; j += 1) {
      const bucket = grid.map.get(`${gx + i}|${gz + j}`);
      if (!bucket) continue;
      for (const c of bucket) {
        const dx = c.x - x;
        const dz = c.z - z;
        const rr = c.r + radius;
        if (dx * dx + dz * dz < rr * rr) return c;
      }
    }
  }
  return null;
}

function occupancyAdd(grid, x, z, radius, tag) {
  const key = occupancyKey(grid, x, z);
  const circle = { x, z, r: radius, tag };
  const bucket = grid.map.get(key);
  if (bucket) bucket.push(circle); else grid.map.set(key, [circle]);
  grid.count += 1;
  // A circle wider than a cell has to be registered in the cells it reaches,
  // otherwise a big item (a shelter) can be straddled by a small one.
  const reach = Math.ceil(radius / grid.cell);
  if (reach > 0) {
    const gx = Math.floor(x / grid.cell);
    const gz = Math.floor(z / grid.cell);
    for (let i = -reach; i <= reach; i += 1) {
      for (let j = -reach; j <= reach; j += 1) {
        if (i === 0 && j === 0) continue;
        const k = `${gx + i}|${gz + j}`;
        const b = grid.map.get(k);
        if (b) b.push(circle); else grid.map.set(k, [circle]);
      }
    }
  }
  return circle;
}

/**
 * Register everything the legacy renderer has already put in the world so this
 * pass cannot plant a bollard inside an existing tree.
 *
 * The scene is read, not guessed at: this walks `ctx.root` at build time and
 * takes the world-space centre of every small, low mesh and instanced mesh.
 * Dynamic content (pedestrians, vehicles) is skipped by name because its
 * build-time position is not where it will be, and anything above head height
 * (roof props, parapets) cannot conflict with a footway.
 */
const DYNAMIC_NAME = /ped|crowd|actor|npc|vehicle|car|traffic|bird|cloud/i;

function seedOccupancyFromScene(state, root) {
  if (!root || typeof root.traverse !== 'function') return 0;
  const grid = state.occupancy;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  let added = 0;
  root.traverse((node) => {
    if (added >= state.options.maxSceneOccupancy) return;
    if (!node.isMesh && !node.isInstancedMesh) return;
    if (DYNAMIC_NAME.test(String(node.name || ''))) return;
    if (DYNAMIC_NAME.test(String(node.userData?.kind || ''))) return;
    const geometry = node.geometry;
    if (!geometry) return;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    if (!sphere || !Number.isFinite(sphere.radius)) return;
    node.updateWorldMatrix(true, false);
    const scaleFactor = Math.max(
      Math.abs(node.scale?.x ?? 1), Math.abs(node.scale?.y ?? 1), Math.abs(node.scale?.z ?? 1),
    );
    const radius = sphere.radius * (Number.isFinite(scaleFactor) ? scaleFactor : 1);
    // Too small to matter, or a whole-city surface rather than a prop.
    if (!(radius > 0.08 && radius < 8)) return;
    const record = (m) => {
      position.copy(sphere.center).applyMatrix4(m);
      if (position.y > 6) return;
      occupancyAdd(grid, position.x, position.z, Math.min(radius, 2.4), 'legacy');
      added += 1;
    };
    if (node.isInstancedMesh) {
      const count = Math.min(node.count ?? 0, state.options.maxSceneOccupancy - added);
      for (let i = 0; i < count; i += 1) {
        node.getMatrixAt(i, matrix);
        matrix.premultiply(node.matrixWorld);
        record(matrix);
      }
    } else {
      record(node.matrixWorld);
    }
  });
  return added;
}

/** Axis-aligned footprint index over the building contract. */
function buildBuildingIndex(city) {
  const cell = 24;
  const map = new Map();
  let count = 0;
  for (const building of city?.buildings || []) {
    const polygon = building?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of polygon) {
      const x = Number(p?.x);
      const z = Number(p?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) continue;
    const boxRecord = { minX, maxX, minZ, maxZ, polygon };
    count += 1;
    for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
      for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz += 1) {
        const key = `${gx}|${gz}`;
        const bucket = map.get(key);
        if (bucket) bucket.push(boxRecord); else map.set(key, [boxRecord]);
      }
    }
  }
  return { cell, map, count };
}

function pointInPolygon(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.z > z) !== (b.z > z)
      && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-12) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToPolygon(polygon, x, z) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-12 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1) : 0;
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Distance from (x, z) to the nearest building footprint; 0 when inside one.
 *
 * The polygon is tested, not its bounding box. A diagonal or L-shaped block -
 * and this city has plenty, including transit-station footprints hundreds of
 * metres across - has a bounding box that swallows whole streets, and an
 * AABB test on that box rejects every placement in the neighbourhood.
 */
function buildingDistance(index, x, z) {
  const gx = Math.floor(x / index.cell);
  const gz = Math.floor(z / index.cell);
  let best = Infinity;
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const bucket = index.map.get(`${gx + i}|${gz + j}`);
      if (!bucket) continue;
      for (const b of bucket) {
        const dx = Math.max(b.minX - x, 0, x - b.maxX);
        const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
        const boxDistance = Math.hypot(dx, dz);
        if (boxDistance >= best) continue;
        if (boxDistance === 0 && pointInPolygon(b.polygon, x, z)) return 0;
        const d = distanceToPolygon(b.polygon, x, z);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

/** Class band index used by the weight table: service, residential, collector, arterial. */
function classBand(classRank) {
  if (classRank <= 2) return 0;
  if (classRank === 3) return 1;
  if (classRank === 4) return 2;
  return 3;
}

function ringFor(state, x, z) {
  const dx = x - state.focus.x;
  const dz = z - state.focus.z;
  const d2 = dx * dx + dz * dz;
  for (const ring of state.rings) {
    if (d2 <= ring.radius * ring.radius) return ring;
  }
  return null;
}

function reject(state, kind, reason) {
  const key = `${kind}:${reason}`;
  state.rejections[key] = (state.rejections[key] || 0) + 1;
}

/**
 * Choose a kind for one slot. Deterministic: a single 0..1 draw against the
 * cumulative weight of the kinds that are legal here, in catalogue order.
 */
function chooseKind(state, context, draw) {
  const { band, classRank, atCorner, ring, lastAt, station, buildingGap, wallReach } = context;
  let total = 0;
  const legal = [];
  for (const id of STREET_FURNITURE_KIND_IDS) {
    const kind = STREET_FURNITURE_KINDS[id];
    if (ring.kinds && !ring.kinds.includes(id)) continue;
    if (band.walk < kind.minWalk) continue;
    if (kind.zone === ZONES.MID && band.usable - kind.depth * 2 < 1.0) continue;
    if (kind.zone === ZONES.BUILDING && !(buildingGap <= wallReach)) continue;
    const since = station - (lastAt[id] ?? -1e9);
    if (since < kind.gap) continue;
    const weight = atCorner ? kind.corner : kind.weight[classBand(classRank)];
    if (!(weight > 0)) continue;
    total += weight;
    legal.push({ id, kind, weight });
  }
  if (!legal.length) return null;
  let cursor = draw * total;
  for (const entry of legal) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry;
  }
  return legal[legal.length - 1];
}

/**
 * Lateral offset (magnitude, from the centreline) for a kind inside a band,
 * and the through-route the placement has to leave behind it.
 *
 * `depth` is the item's half-extent ACROSS the footway, which is not its plan
 * radius: a bench is 1.7 m long and 0.6 m deep, and using the length to decide
 * whether it fits across a 2.5 m footway would reject every bench in the city.
 */
export function lateralFor(kind, band, throughRoute) {
  const through = Number.isFinite(kind.through) ? kind.through : throughRoute;
  const limit = band.outer - through;
  // A wall item starts its search at the far end of its reach and walks in to
  // the first station that is clear of, but touching, a facade.
  if (kind.zone === ZONES.BUILDING) {
    return { lateral: band.outer + (Number.isFinite(kind.reach) ? kind.reach : 3.0) - kind.depth, limit: band.outer, nearest: band.inner + kind.depth };
  }
  const nearest = band.inner + kind.depth + 0.1;
  if (kind.zone === ZONES.MID) {
    const wanted = band.inner + Math.max(kind.depth + 0.1, band.usable * 0.5);
    return { lateral: Math.min(wanted, limit - kind.depth), limit, nearest };
  }
  return { lateral: band.inner + kind.depth + 0.06, limit, nearest };
}

function placeItem(state, spec) {
  const { segment, side, station, kindId, kind, band, ring, forced = false } = spec;
  const o = state.o;
  const wallReach = state.options.wallReach;
  const fit = lateralFor({ ...kind, reach: wallReach }, band, state.options.throughRoute);
  const lateral = fit.lateral;
  if (lateral - kind.depth < band.inner - 0.05) { reject(state, kindId, 'inside-curb'); return null; }
  if (kind.zone !== ZONES.BUILDING) {
    if (lateral + kind.depth > band.outer + 0.05) { reject(state, kindId, 'past-property-line'); return null; }
    if (lateral + kind.depth > fit.limit + 1e-6) { reject(state, kindId, 'blocks-through-route'); return null; }
  }
  const st = streetStationAt(segment, station, false);
  const nx = st.nx * st.miter;
  const nz = st.nz * st.miter;
  let placedLateral = lateral;
  if (kind.zone === ZONES.BUILDING) {
    // Snap to the facade. The authored footway band and the authored building
    // footprint routinely overlap - the band is a nominal width, not a
    // survey - so a wall item parked at the nominal property line is often
    // buried in the wall. Walk inward until the item is just clear of the
    // footprint, and give up rather than leave it standing in open footway.
    const floor = band.inner + kind.depth + 0.05;
    const ceiling = band.outer + wallReach;
    let snapped = null;
    for (let probe = Math.min(lateral, ceiling); probe >= floor; probe -= 0.12) {
      const px = st.x + nx * side * probe;
      const pz = st.z + nz * side * probe;
      const gap = buildingDistance(state.buildings, px, pz);
      if (gap > 0.02 && gap <= 0.55) { snapped = probe; break; }
      if (gap > 0.55) break;
    }
    if (snapped === null) { reject(state, kindId, 'no-facade'); return null; }
    placedLateral = snapped;
  }
  const x = st.x + nx * side * placedLateral;
  const z = st.z + nz * side * placedLateral;
  if (occupancyHit(state.occupancy, x, z, kind.radius)) { reject(state, kindId, 'overlap'); return null; }
  // A wall-mounted kind is allowed to stand hard against a facade, but never
  // INSIDE one: the footway band can overlap a building footprint where the
  // authored footway is wider than the real setback, and an item placed there
  // would be buried in the wall rather than fixed to it.
  const insideBuilding = buildingDistance(state.buildings, x, z);
  const clearance = kind.zone === ZONES.BUILDING ? 0.02 : 0.15;
  if (insideBuilding <= clearance) { reject(state, kindId, 'inside-building'); return null; }
  const datum = state.datum(x, z);
  // Beyond the property line the item still stands at footway level, not on
  // an extrapolated cross-fall.
  const surfaceLateral = Math.min(placedLateral, band.outer);
  const y = sidewalkSurfaceY(datum, surfaceLateral, segment.half, o);
  const curbTop = sidewalkSurfaceY(datum, segment.half, segment.half, o);
  const zone = kind.zone;
  if (!(y >= curbTop - 1e-6)) { reject(state, kindId, 'below-curb'); return null; }
  const rng = streetRandom(`${state.seedTag}:item:${segment.id}:${side}:${Math.round(station * 100)}:${kindId}`);
  // -Z of the item faces the carriageway.
  const facing = Math.atan2(side * nx, side * nz);
  const spin = kindId === 'tree' || kindId === 'hydrant' || kindId === 'bollard' || kindId === 'wasteBin'
    ? (rng() - 0.5) * Math.PI
    : (rng() - 0.5) * 0.06;
  const scale = kindId === 'tree' ? 0.82 + rng() * 0.5 : 0.965 + rng() * 0.07;
  occupancyAdd(state.occupancy, x, z, kind.radius, kindId);
  const item = {
    kind: kindId,
    lod: ring.lod,
    ring: ring.id,
    x,
    y,
    z,
    rotation: facing + spin,
    scale,
    tintSeed: rng(),
    segmentId: segment.id,
    side,
    station,
    lateral: placedLateral,
    zone,
    // True when this is one of the placements a junction corner is guaranteed:
    // exactly one set per corner, claimed before the mid-block walk runs.
    forced,
    nodeId: forced ? spec.nodeId ?? null : null,
    band: { inner: band.inner, outer: band.outer, walk: band.walk },
    half: segment.half,
    curbTop,
  };
  state.items.push(item);
  state.counts[kindId] = (state.counts[kindId] || 0) + 1;
  state.usedSegments.add(segment.id);
  const ringRecord = state.ringRecords[state.rings.indexOf(ring)];
  ringRecord.items += 1;
  return item;
}

/**
 * Walk one side of one segment and furnish it.
 *
 * The corner zone - the first and last `cornerZone` metres, where the segment
 * meets a junction - draws from the corner weights, which is what puts the
 * sign poles, hydrants, bollards and news boxes at corners and keeps trees,
 * meters and benches out of the sight triangle.
 */
function furnishSide(state, segment, side) {
  const o = state.o;
  const band = sidewalkBand(segment, side, o, state.options.throughRoute);
  if (!band) { reject(state, 'side', 'no-footway'); return; }
  const s0 = segment.trimStart + 1.2;
  const s1 = segment.length - segment.trimEnd - 1.2;
  if (s1 - s0 < 2) { reject(state, 'side', 'no-run'); return; }
  const cornerZone = state.options.cornerZone;
  const lastAt = {};
  const rng = streetRandom(`${state.seedTag}:furnish:${segment.id}:${side}`);
  const basePitch = segment.classRank >= 5 ? 4.2 : segment.classRank >= 4 ? 5.0 : 6.4;
  let station = s0 + rng() * 1.5;
  let guard = 0;
  while (station < s1 && guard < 4000) {
    guard += 1;
    const st = streetStationAt(segment, station, false);
    const nx = st.nx * st.miter;
    const nz = st.nz * st.miter;
    const probeLateral = band.inner + band.usable * 0.5;
    const px = st.x + nx * side * probeLateral;
    const pz = st.z + nz * side * probeLateral;
    const ring = ringFor(state, px, pz);
    if (!ring) { reject(state, 'slot', 'out-of-range'); station += 12; continue; }
    if (ring.items >= ring.maxItems) { reject(state, 'slot', 'ring-item-cap'); station += 12; continue; }
    const atStartCorner = segment.nodeStart && station - s0 < cornerZone;
    const atEndCorner = segment.nodeEnd && s1 - station < cornerZone;
    const atCorner = Boolean(atStartCorner || atEndCorner);
    const buildingGap = buildingDistance(state.buildings, st.x + nx * side * band.outer, st.z + nz * side * band.outer);
    const choice = chooseKind(state, {
      band, classRank: segment.classRank, atCorner, ring, lastAt, station, buildingGap,
      wallReach: state.options.wallReach,
    }, rng());
    if (!choice) { reject(state, 'slot', atCorner ? 'no-legal-corner-kind' : 'no-legal-kind'); station += basePitch; continue; }
    const placed = placeItem(state, {
      segment, side, station, kindId: choice.id, kind: choice.kind, band, ring,
    });
    if (placed) {
      lastAt[choice.id] = station;
      station += Math.max(0.9, choice.kind.radius * 2 + 0.5) + basePitch * ring.pitchScale * (0.6 + rng() * 0.7);
    } else {
      station += 1.6 + rng();
    }
  }
}

/**
 * The corner itself. Every junction corner in a real city carries a sign pole,
 * and about half carry a hydrant; those are placed first, before the mid-block
 * walk, so the corner always wins the space.
 */
function furnishCorners(state) {
  for (const node of state.plan.nodes) {
    for (const approach of node.approaches) {
      const segment = approach.segment;
      if (!segment) continue;
      // One placement per CORNER, not per (approach, side). The approaches
      // round a node are sorted by angle, so corner k is bounded by approach
      // k's counter-clockwise side and approach k+1's clockwise side; visiting
      // only the counter-clockwise side visits every corner exactly once.
      // Visiting both sides is what turns a four-way junction into eight sign
      // poles instead of four.
      const ccwSide = approach.atStart ? 1 : -1;
      for (const side of [ccwSide]) {
        const band = sidewalkBand(segment, side, state.o, state.options.throughRoute);
        if (!band) continue;
        const ringProbe = streetStationAt(segment, approach.atStart
          ? approach.trim + 1.4
          : segment.length - approach.trim - 1.4, false);
        const nx = ringProbe.nx * ringProbe.miter;
        const nz = ringProbe.nz * ringProbe.miter;
        const lateralProbe = band.inner + band.usable * 0.5;
        const ring = ringFor(state,
          ringProbe.x + nx * side * lateralProbe,
          ringProbe.z + nz * side * lateralProbe);
        if (!ring) continue;
        const hash = streetHash32(`${state.seedTag}:corner:${node.id}:${segment.id}:${side}`);
        const wanted = [];
        if (!ring.kinds || ring.kinds.includes('signPole')) wanted.push('signPole');
        if (hash % 5 === 0 && (!ring.kinds || ring.kinds.includes('hydrant'))) wanted.push('hydrant');
        if (hash % 3 === 0 && (!ring.kinds || ring.kinds.includes('bollard'))) wanted.push('bollard');
        let offset = 1.3;
        for (const kindId of wanted) {
          const kind = STREET_FURNITURE_KINDS[kindId];
          if (band.walk < kind.minWalk) { reject(state, kindId, 'corner-too-narrow'); continue; }
          const station = approach.atStart
            ? approach.trim + offset
            : segment.length - approach.trim - offset;
          if (station < 0.3 || station > segment.length - 0.3) { reject(state, kindId, 'corner-no-room'); continue; }
          placeItem(state, { segment, side, station, kindId, kind, band, ring, forced: true, nodeId: node.id });
          offset += kind.radius * 2 + 0.9;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tree pits
// ---------------------------------------------------------------------------

const PIT_LIFTS = Object.freeze({ soil: 0.005, grate: 0.012 });

function makeFlatBuffer() {
  return { positions: [], normals: [], colors: [], uvs: [], indices: [], triangles: 0 };
}

function pushFlatQuad(buffer, points, linearColor) {
  const base = buffer.positions.length / 3;
  // Force counter-clockwise seen from above so the face points up.
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  const ring = area < 0 ? [...points].reverse() : points;
  for (const p of ring) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
    buffer.positions.push(p.x, p.y, p.z);
    buffer.normals.push(0, 1, 0);
    buffer.colors.push(linearColor[0], linearColor[1], linearColor[2]);
    buffer.uvs.push(p.x * 0.5, p.z * 0.5);
  }
  for (let i = 1; i < ring.length - 1; i += 1) {
    buffer.indices.push(base, base + i, base + i + 1);
    buffer.triangles += 1;
  }
}

/**
 * A tree pit: soil, a cast frame and its slats. Without it a trunk grows
 * straight out of a concrete slab, which is the single most obvious tell that
 * a street was placed rather than built.
 */
function emitTreePit(state, buffer, item, detailed) {
  const o = state.o;
  const half = state.options.pitSize / 2;
  const c = Math.cos(item.rotation);
  const s = Math.sin(item.rotation);
  const at = (a, b, lift) => {
    const x = item.x + c * a + s * b;
    const z = item.z - s * a + c * b;
    const datum = state.datum(x, z);
    return { x, y: sidewalkSurfaceY(datum, item.lateral, item.half, o) + lift, z };
  };
  const soil = hexToLinear(PALETTE.pitSoil);
  pushFlatQuad(buffer, [
    at(-half, -half, PIT_LIFTS.soil), at(half, -half, PIT_LIFTS.soil),
    at(half, half, PIT_LIFTS.soil), at(-half, half, PIT_LIFTS.soil),
  ], soil);
  if (!detailed) return;
  const grate = hexToLinear(PALETTE.pitGrate);
  const rail = 0.09;
  for (const [a0, a1, b0, b1] of [
    [-half, half, -half, -half + rail],
    [-half, half, half - rail, half],
    [-half, -half + rail, -half + rail, half - rail],
    [half - rail, half, -half + rail, half - rail],
  ]) {
    pushFlatQuad(buffer, [
      at(a0, b0, PIT_LIFTS.grate), at(a1, b0, PIT_LIFTS.grate),
      at(a1, b1, PIT_LIFTS.grate), at(a0, b1, PIT_LIFTS.grate),
    ], grate);
  }
  const slats = 5;
  for (let i = 0; i < slats; i += 1) {
    const b = -half + rail + ((half - rail) * 2 * (i + 0.5)) / slats;
    pushFlatQuad(buffer, [
      at(-half + rail, b - 0.028, PIT_LIFTS.grate), at(half - rail, b - 0.028, PIT_LIFTS.grate),
      at(half - rail, b + 0.028, PIT_LIFTS.grate), at(-half + rail, b + 0.028, PIT_LIFTS.grate),
    ], grate);
  }
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

function instanceTint(kindId, t) {
  if (kindId === 'newsBox') {
    const palettes = [[0.24, 0.36, 0.62], [0.55, 0.34, 0.16], [0.36, 0.39, 0.42], [0.58, 0.2, 0.18]];
    return palettes[Math.floor(t * palettes.length) % palettes.length];
  }
  if (kindId === 'tree') {
    return [0.86 + t * 0.2, 0.9 + t * 0.22, 0.82 + t * 0.2];
  }
  if (kindId === 'wasteBin') {
    return t < 0.5 ? [1, 1, 1] : [0.78, 0.82, 0.86];
  }
  const k = 0.9 + t * 0.2;
  return [k, k, k];
}

const DEFAULT_OPTIONS = Object.freeze({
  cornerZone: 11,
  throughRoute: 1.35,
  pitSize: 1.06,
  // How far past the property line a wall-mounted item may reach to find a
  // facade. The authored footway width is nominal, so the real building face
  // is often a couple of metres behind it.
  wallReach: 5.0,
  maxSceneOccupancy: 6000,
});

function makeState(plan, focus, ctx, options, seedTag) {
  const rings = STREET_FURNITURE_RINGS.map((ring) => ({ ...ring, items: 0, triangles: 0 }));
  const o = plan.options;
  const heightAt = o.heightAt;
  return {
    plan,
    o,
    focus,
    options,
    // Seed prefix: one seed is bit-identical run to run, two seeds differ.
    seedTag: String(seedTag ?? 'city'),
    rings,
    ringRecords: rings.map((ring) => ({ id: ring.id, radius: ring.radius, lod: ring.lod, items: 0, triangles: 0 })),
    items: [],
    counts: {},
    rejections: {},
    usedSegments: new Set(),
    occupancy: makeOccupancy(2.5),
    buildings: buildBuildingIndex(plan.city),
    datum: heightAt ? (x, z) => o.roadLift + heightAt(x, z) : () => o.roadLift,
  };
}

function segmentReach(focus, segment) {
  let best = Infinity;
  for (let i = 0; i < segment.points.length - 1; i += 1) {
    const a = segment.points[i];
    const b = segment.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = 0;
    if (len2 > 1e-9) t = clamp(((focus.x - a.x) * dx + (focus.z - a.z) * dz) / len2, 0, 1);
    const d = Math.hypot(focus.x - (a.x + dx * t), focus.z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

export function buildStreetFurniture(ctx, overrides = {}) {
  const startedAt = Date.now();
  const city = ctx?.city;
  const options = { ...DEFAULT_OPTIONS, ...(overrides.placement || {}) };
  const surfaceOptions = surfaceOptionsFor(ctx, overrides.surface || {});
  const plan = buildStreetscapePlan(city, surfaceOptions);
  const bounds = city?.meta?.bounds;
  const focus = ctx?.focus && Number.isFinite(ctx.focus.x) && Number.isFinite(ctx.focus.z)
    ? { x: ctx.focus.x, z: ctx.focus.z }
    : bounds
      ? { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 }
      : { x: 0, z: 0 };
  const state = makeState(plan, focus, ctx, options, ctx?.seed ?? city?.meta?.seed ?? 'city');
  const legacyOccupancy = seedOccupancyFromScene(state, ctx?.root);

  // Corners first: they are the highest-value placements and must win the
  // space before the mid-block walk consumes it.
  furnishCorners(state);
  const farRadius = state.rings[state.rings.length - 1].radius;
  for (const segment of plan.segments) {
    if (segmentReach(focus, segment) > farRadius) { reject(state, 'segment', 'out-of-range'); continue; }
    for (const side of [1, -1]) furnishSide(state, segment, side);
  }

  // Geometry, one variant per level of detail actually used.
  const lodsUsed = new Set(state.items.map((item) => item.lod));
  const catalogue = new Map();
  for (const lod of [...lodsUsed].sort()) catalogue.set(lod, buildCatalogue(lod));
  const triangleOf = (kindId, lod) => {
    const geometry = catalogue.get(lod)?.[kindId];
    if (!geometry) return 0;
    const index = geometry.getIndex();
    return Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3);
  };

  // Ring triangle caps. Items are dropped from the tail of the ring, which is
  // the furthest-along-the-street placement, so a cap never leaves a hole at a
  // corner.
  const kept = [];
  for (const item of state.items) {
    const ringIndex = state.rings.findIndex((ring) => ring.id === item.ring);
    const ring = state.rings[ringIndex];
    const triangles = triangleOf(item.kind, item.lod);
    if (ring.triangles + triangles > ring.maxTriangles) {
      reject(state, item.kind, 'ring-triangle-cap');
      state.counts[item.kind] -= 1;
      continue;
    }
    ring.triangles += triangles;
    state.ringRecords[ringIndex].triangles += triangles;
    kept.push(item);
  }
  state.items = kept;

  const group = new THREE.Group();
  group.name = STREET_FURNITURE_ID;
  group.userData = { kind: 'street-furniture', version: STREET_FURNITURE_VERSION };

  const propMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.74, metalness: 0.14,
  });
  const foliageMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0,
  });
  const groundMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.05,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });

  const buckets = new Map();
  for (const item of state.items) {
    const key = `${item.kind}:${item.lod}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item); else buckets.set(key, [item]);
  }

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const positionVector = new THREE.Vector3();
  const scaleVector = new THREE.Vector3();
  const color = new THREE.Color();
  const meshes = [];
  let triangles = 0;
  for (const key of [...buckets.keys()].sort()) {
    const items = buckets.get(key);
    const [kindId, lodText] = key.split(':');
    const lod = Number(lodText);
    const geometry = catalogue.get(lod)?.[kindId];
    if (!geometry) { reject(state, kindId, 'no-geometry'); continue; }
    const material = kindId === 'tree' ? foliageMaterial : propMaterial;
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      positionVector.set(item.x, item.y, item.z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), item.rotation);
      scaleVector.set(item.scale, item.scale, item.scale);
      matrix.compose(positionVector, quaternion, scaleVector);
      mesh.setMatrixAt(i, matrix);
      const [r, g, b] = instanceTint(kindId, item.tintSeed);
      color.setRGB(r, g, b);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = `${STREET_FURNITURE_ID}:${key}`;
    // Shadow policy. Every extra caster is an extra shadow-map draw call, and
    // the QA capture path is a software GL backend, so only kinds with real
    // bulk cast, and only inside the two detailed rings. A 32 mm meter pole
    // could not resolve in the shadow map anyway - see the renderer's shadow
    // caster policy, which gets the final word after this pass.
    mesh.castShadow = lod < 2 && SHADOW_CASTING_KINDS.has(kindId);
    mesh.receiveShadow = true;
    mesh.userData = { kind: 'street-furniture', pass: STREET_FURNITURE_ID, itemKind: kindId, lod };
    group.add(mesh);
    const perItem = triangleOf(kindId, lod);
    triangles += perItem * items.length;
    meshes.push({ kind: kindId, lod, instances: items.length, trianglesEach: perItem, drawCalls: 1 });
  }

  // Tree pits, merged into one ground decal mesh.
  const pitBuffer = makeFlatBuffer();
  for (const item of state.items) {
    if (item.kind !== 'tree') continue;
    emitTreePit(state, pitBuffer, item, item.lod < 2);
  }
  if (pitBuffer.triangles > 0) {
    const pitGeometry = new THREE.BufferGeometry();
    pitGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pitBuffer.positions, 3));
    pitGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(pitBuffer.normals, 3));
    pitGeometry.setAttribute('color', new THREE.Float32BufferAttribute(pitBuffer.colors, 3));
    pitGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(pitBuffer.uvs, 2));
    pitGeometry.setIndex(pitBuffer.indices);
    pitGeometry.computeBoundingSphere();
    const pitMesh = new THREE.Mesh(pitGeometry, groundMaterial);
    pitMesh.name = `${STREET_FURNITURE_ID}:tree-pits`;
    pitMesh.castShadow = false;
    pitMesh.receiveShadow = true;
    pitMesh.renderOrder = 2;
    pitMesh.userData = { kind: 'road-markings', pass: STREET_FURNITURE_ID, itemKind: 'treePit' };
    group.add(pitMesh);
    triangles += pitBuffer.triangles;
    meshes.push({ kind: 'treePit', lod: 0, instances: 1, trianglesEach: pitBuffer.triangles, drawCalls: 1 });
  }

  // Release geometry for kinds that ended up with no instances.
  for (const [lod, set] of catalogue) {
    for (const [kindId, geometry] of Object.entries(set)) {
      if (!buckets.has(`${kindId}:${lod}`)) geometry?.dispose?.();
    }
  }

  const drawCalls = meshes.length;
  const segmentIds = [...state.usedSegments];
  const diagnostics = {
    version: STREET_FURNITURE_VERSION,
    implemented: true,
    focus,
    plan: plan.stats,
    counts: state.counts,
    rejections: state.rejections,
    legacyOccupancySeeded: legacyOccupancy,
    buildingFootprints: state.buildings.count,
    rings: state.ringRecords.map((record, i) => ({
      ...record,
      maxItems: state.rings[i].maxItems,
      maxTriangles: state.rings[i].maxTriangles,
      withinBudget: record.triangles <= state.rings[i].maxTriangles
        && record.items <= state.rings[i].maxItems,
      kinds: state.rings[i].kinds ? [...state.rings[i].kinds] : 'all',
    })),
    meshes,
    totals: {
      items: state.items.length,
      triangles,
      drawCalls,
      withinTriangleBudget: triangles <= STREET_FURNITURE_BUDGET.maxTriangles,
      withinDrawCallBudget: drawCalls <= STREET_FURNITURE_BUDGET.maxDrawCalls,
    },
    sourceSegmentIds: segmentIds.slice(0, 256),
    sourceSegmentCount: segmentIds.length,
    buildMs: Date.now() - startedAt,
  };
  return { object: state.items.length ? group : null, diagnostics, items: state.items, plan, state };
}

export default {
  id: STREET_FURNITURE_ID,
  order: 40,
  build(ctx) {
    const result = buildStreetFurniture(ctx);
    return { object: result.object, diagnostics: result.diagnostics };
  },
};
