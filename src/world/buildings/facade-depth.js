/**
 * Additive facade construction depth for city buildings.
 *
 * The city shell is a flat extruded prism with a painted window grid. That
 * reads as a prototype because every architectural element that should cast a
 * local shadow -- a window reveal, a sill, a string course, a cornice, a
 * shopfront head, a bay -- is texture instead of geometry. This module returns
 * *additive* geometry that sits on top of the untouched shell and gives those
 * elements real depth.
 *
 * Contract with the rest of the world:
 *  - It never moves, rescales, re-origins or re-indexes the source shell. The
 *    footprint polygon, the base elevation and the height are read-only inputs
 *    and every emitted vertex is clamped into the building's own
 *    footprint-AABB + height box (expanded horizontally by at most
 *    `maxProjection`, which is a caller-owned budget, default 0.45 m).
 *  - It is deterministic: all variation is drawn from a seed derived from the
 *    building id, and every random draw happens before any level-of-detail
 *    branching, so the same building produces the same facade at every LOD.
 *  - It is pure: `planFacadeDepth` needs no three.js, no DOM, no canvas and no
 *    GPU. `buildFacadeDepth` / `buildFacadeDepthBatch` only turn that plan into
 *    `THREE.BufferGeometry`.
 *  - It is merge friendly: geometry is grouped by (style, role) so a whole city
 *    of facade depth costs at most 12 extra draw calls, and it uses the same UV
 *    parameterisation as the shell so it can share the shell's facade texture.
 *
 * Triangle cost per building, by level of detail (hard caps, enforced):
 *
 *   lod    cap    what it buys
 *   off      0    nothing; the shell texture carries the facade
 *   far     64    cornice / parapet cap + ground plinth on up to 4 edges
 *   mid    512    + string courses, shopfront glazing line and door recess,
 *                   bays, and the first 24 recessed window openings
 *   near  1664    + sills, lintels, pilasters, and up to 60 recessed window
 *                   openings on 6 edges, 5 storeys deep
 *
 * Integration sketch (the renderer owns the call site, this module does not):
 *
 *   const depth = buildFacadeDepthBatch(city.buildings, {
 *     viewPoint: { x: camera.position.x, z: camera.position.z },
 *     baseYFor: (b) => this.terrain?.heightAt?.(centroidX(b), centroidZ(b)) ?? 0,
 *   });
 *   for (const group of depth.groups) {
 *     const material = group.role === 'glass'
 *       ? this.facadeGlassMaterial          // dark, low roughness, envMap
 *       : this.facadeMaterialFor(group.style); // the shell's own wall material
 *     const mesh = new THREE.Mesh(group.geometry, material);
 *     mesh.castShadow = true;
 *     mesh.receiveShadow = true;
 *     root.add(mesh);                        // world space: identity transform
 *   }
 *
 * Geometry is emitted in world space with the shell's UV parameterisation
 * (12 m x 4.6 m per tile), so a structure group can share the building's
 * existing facade texture without any remapping.
 *
 * Scene budget for 700 visible buildings: the reference LOD mix
 * (16 near / 96 mid / 588 far) costs 113,408 triangles against a 120,000
 * triangle allowance. Only the storeys a street-level camera can actually read
 * are detailed; tall towers get their lowest storeys and keep the texture above.
 */
import * as THREE from 'three';

export const FACADE_DEPTH_VERSION = 'facade-depth-1';

/** Facade style vocabulary, mirrored from the renderer's FACADE_STYLES. */
export const FACADE_DEPTH_STYLES = Object.freeze([
  'edwardian',
  'modern-grid',
  'bay-window',
  'shopfront',
  'loft',
  'art-deco',
]);

/** Geometry roles. Each role is one merged draw call per style. */
export const FACADE_DEPTH_ROLES = Object.freeze(['structure', 'glass']);

export const FACADE_DEPTH_LODS = Object.freeze(['off', 'far', 'mid', 'near']);

/** Shell UV parameterisation, matched to the renderer's building extrusion. */
export const FACADE_DEPTH_UV_METRES = Object.freeze({ x: 12, y: 4.6 });

/** Default outward projection allowance, in metres, for the whole module. */
export const FACADE_DEPTH_MAX_PROJECTION = 0.45;

export const FACADE_DEPTH_BUDGET = Object.freeze({
  visibleBuildings: 700,
  trianglesPerBuilding: Object.freeze({ off: 0, far: 64, mid: 512, near: 1664 }),
  // A plausible street-level distribution of 700 visible buildings.
  referenceMix: Object.freeze({ near: 16, mid: 96, far: 588 }),
  referenceTriangles: 16 * 1664 + 96 * 512 + 588 * 64,
  sceneTriangleBudget: 120000,
  // Worst case if every visible building were forced to mid detail.
  allMidTriangles: 700 * 512,
  maxDrawCalls: FACADE_DEPTH_STYLES.length * FACADE_DEPTH_ROLES.length,
});

/** Distance thresholds, in metres, used when the caller passes a view point. */
export const FACADE_DEPTH_LOD_DISTANCES = Object.freeze({ near: 60, mid: 140, far: 320 });

/**
 * Per-style construction language. `revealDepth` is the window recess and is
 * held inside the 0.10-0.25 m band the brief calls for.
 */
export const FACADE_STYLE_PROFILES = Object.freeze({
  edwardian: Object.freeze({
    bayWidth: 3.1,
    windowRatio: 0.52,
    revealDepth: 0.16,
    sill: true,
    lintel: true,
    stringCourse: true,
    pilaster: false,
    bay: false,
    corniceHeight: 0.72,
    corniceProjection: 0.22,
    plinthHeight: 0.55,
    plinthProjection: 0.09,
    commercialGround: false,
  }),
  'modern-grid': Object.freeze({
    bayWidth: 3.8,
    windowRatio: 0.74,
    revealDepth: 0.12,
    sill: false,
    lintel: false,
    stringCourse: false,
    pilaster: false,
    bay: false,
    corniceHeight: 0.42,
    corniceProjection: 0.1,
    plinthHeight: 0.4,
    plinthProjection: 0.06,
    commercialGround: true,
  }),
  'bay-window': Object.freeze({
    bayWidth: 3.4,
    windowRatio: 0.55,
    revealDepth: 0.14,
    sill: true,
    lintel: true,
    stringCourse: true,
    pilaster: false,
    bay: true,
    bayProjection: 0.45,
    corniceHeight: 0.62,
    corniceProjection: 0.2,
    plinthHeight: 0.6,
    plinthProjection: 0.09,
    commercialGround: false,
  }),
  shopfront: Object.freeze({
    bayWidth: 3.2,
    windowRatio: 0.58,
    revealDepth: 0.18,
    sill: true,
    lintel: true,
    stringCourse: true,
    pilaster: false,
    bay: false,
    corniceHeight: 0.58,
    corniceProjection: 0.18,
    plinthHeight: 0.35,
    plinthProjection: 0.07,
    commercialGround: true,
  }),
  loft: Object.freeze({
    bayWidth: 4.4,
    windowRatio: 0.68,
    revealDepth: 0.22,
    sill: true,
    lintel: false,
    stringCourse: false,
    pilaster: false,
    bay: false,
    corniceHeight: 0.8,
    corniceProjection: 0.25,
    plinthHeight: 0.7,
    plinthProjection: 0.1,
    commercialGround: true,
  }),
  'art-deco': Object.freeze({
    bayWidth: 3.6,
    windowRatio: 0.5,
    revealDepth: 0.2,
    sill: true,
    lintel: true,
    stringCourse: true,
    pilaster: true,
    bay: false,
    corniceHeight: 0.9,
    corniceProjection: 0.24,
    plinthHeight: 0.65,
    plinthProjection: 0.1,
    commercialGround: true,
  }),
});

const LOD_CONFIG = Object.freeze({
  off: Object.freeze({
    edges: 0, storeys: 0, windows: 0,
    cornice: false, plinth: false, stringCourse: false, bay: false,
    shopfront: false, sill: false, lintel: false, pilaster: false,
  }),
  far: Object.freeze({
    edges: 4, storeys: 0, windows: 0,
    cornice: true, plinth: true, stringCourse: false, bay: false,
    shopfront: false, sill: false, lintel: false, pilaster: false,
  }),
  mid: Object.freeze({
    edges: 4, storeys: 3, windows: 24,
    cornice: true, plinth: true, stringCourse: true, bay: true,
    shopfront: true, sill: false, lintel: false, pilaster: false,
  }),
  near: Object.freeze({
    edges: 6, storeys: 5, windows: 60,
    cornice: true, plinth: true, stringCourse: true, bay: true,
    shopfront: true, sill: true, lintel: true, pilaster: true,
  }),
});

// Window column pitch is LOD independent on purpose: a lower LOD emits a
// prefix of the same openings, so approaching a building adds detail instead of
// sliding the existing detail sideways.
const MAX_BAYS_PER_EDGE = 8;
// Anything that would otherwise sit exactly on the shell base is lifted by
// this much so a horizontal face cannot z-fight with the sidewalk.
const GROUND_CLEARANCE = 0.03;
const MIN_EDGE_LENGTH = 3;
const MIN_PLAN_EXTENT = 3;
const MIN_BUILDING_HEIGHT = 3;
const MIN_WINDOW_WIDTH = 0.7;
const MIN_WINDOW_HEIGHT = 0.7;
const EPSILON = 1e-6;

// ---------------------------------------------------------------- primitives

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** FNV-1a over the building id: stable across runs, machines and processes. */
export function facadeDepthSeed(id) {
  const text = String(id ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash ^ 0x9e3779b9) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolve a building record to one of the six supported facade styles. */
export function resolveFacadeStyle(building) {
  const declared = building?.facade;
  if (FACADE_DEPTH_STYLES.includes(declared)) return declared;
  const type = String(building?.type || '');
  if (type === 'shop' || building?.shop) return 'shopfront';
  if (type === 'rowhouse') return 'bay-window';
  if (type === 'warehouse') return 'loft';
  if (type === 'civic' || type === 'landmark') return 'art-deco';
  return 'modern-grid';
}

/** True when the ground floor should read as retail rather than residential. */
export function hasStreetLevelTrade(building) {
  if (!building) return false;
  if (building.shop) return true;
  if (building.amenity) return true;
  if (building.type === 'shop') return true;
  if (building.usage === 'retail' || building.usage === 'commercial' || building.usage === 'mixed') return true;
  return building.facade === 'shopfront';
}

/** Pick a level of detail from a camera distance in metres. */
export function facadeDepthLodForDistance(distance, distances = FACADE_DEPTH_LOD_DISTANCES) {
  const d = Number(distance);
  if (!Number.isFinite(d)) return 'off';
  if (d <= distances.near) return 'near';
  if (d <= distances.mid) return 'mid';
  if (d <= distances.far) return 'far';
  return 'off';
}

function normalisePolygon(polygon) {
  const points = [];
  if (!Array.isArray(polygon)) return points;
  for (const raw of polygon) {
    const x = Number(Array.isArray(raw) ? raw[0] : raw?.x);
    const z = Number(Array.isArray(raw) ? raw[1] : raw?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    const previous = points[points.length - 1];
    if (previous && Math.hypot(x - previous.x, z - previous.z) < 1e-4) continue;
    points.push({ x, z });
  }
  while (points.length > 2 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].z - points[points.length - 1].z) < 1e-4) {
    points.pop();
  }
  return points.length >= 3 ? points : [];
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

function buildEdges(points) {
  const area = signedArea(points);
  const flip = area > 0 ? 1 : -1;
  const edges = [];
  let offset = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (!(length > EPSILON)) continue;
    const ux = dx / length;
    const uz = dz / length;
    edges.push({
      index: i,
      ax: a.x,
      az: a.z,
      ux,
      uz,
      nx: flip * uz,
      nz: -flip * ux,
      length,
      offset,
    });
    offset += length;
  }
  return edges;
}

// ------------------------------------------------------------------ planning

/**
 * A quad emitter that fixes its own winding. Corners are given in edge-local
 * (s, y, d) coordinates: s runs along the edge, y is world height, d is the
 * outward offset from the wall plane (negative is a recess). The face normal is
 * recomputed with Newell's method and the corner order is reversed when it
 * disagrees with the hint, so no call site can emit a backfacing quad.
 */
class QuadSink {
  constructor(context) {
    this.context = context;
    this.quads = [];
    this.triangles = 0;
    this.pending = null;
    this.counts = Object.create(null);
  }

  begin() {
    this.pending = [];
    return this;
  }

  /** Commit the pending feature only if it fits the remaining budget. */
  commit(feature) {
    const pending = this.pending || [];
    this.pending = null;
    const cost = pending.length * 2;
    if (!pending.length) return false;
    if (this.triangles + cost > this.context.triangleCap) return false;
    for (const quad of pending) this.quads.push(quad);
    this.triangles += cost;
    this.counts[feature] = (this.counts[feature] || 0) + 1;
    return true;
  }

  abort() {
    this.pending = null;
  }

  quad(role, edge, corners, hint) {
    const ctx = this.context;
    const positions = new Array(12);
    const uvs = new Array(8);
    for (let i = 0; i < 4; i += 1) {
      const [s, y, d] = corners[i];
      const point = ctx.place(edge, s, y, d);
      positions[i * 3] = point[0];
      positions[i * 3 + 1] = point[1];
      positions[i * 3 + 2] = point[2];
      uvs[i * 2] = (edge.offset + s) / ctx.uvMetres.x;
      uvs[i * 2 + 1] = (point[1] - ctx.baseY) / ctx.uvMetres.y;
    }
    // Newell normal of the placed quad.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4;
      const x0 = positions[i * 3];
      const y0 = positions[i * 3 + 1];
      const z0 = positions[i * 3 + 2];
      const x1 = positions[j * 3];
      const y1 = positions[j * 3 + 1];
      const z1 = positions[j * 3 + 2];
      nx += (y0 - y1) * (z0 + z1);
      ny += (z0 - z1) * (x0 + x1);
      nz += (x0 - x1) * (y0 + y1);
    }
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) return; // degenerate after clamping: drop it.
    nx /= len;
    ny /= len;
    nz /= len;
    const hintWorld = ctx.direction(edge, hint);
    if (nx * hintWorld[0] + ny * hintWorld[1] + nz * hintWorld[2] < 0) {
      // Reverse winding (and the normal) rather than trusting the call site.
      for (let i = 0; i < 2; i += 1) {
        const a = i;
        const b = 3 - i;
        for (let k = 0; k < 3; k += 1) {
          const tmp = positions[a * 3 + k];
          positions[a * 3 + k] = positions[b * 3 + k];
          positions[b * 3 + k] = tmp;
        }
        for (let k = 0; k < 2; k += 1) {
          const tmp = uvs[a * 2 + k];
          uvs[a * 2 + k] = uvs[b * 2 + k];
          uvs[b * 2 + k] = tmp;
        }
      }
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const value of positions) {
      if (!Number.isFinite(value)) return;
    }
    (this.pending || this.quads).push({ role, positions, uvs, normal: [nx, ny, nz] });
  }
}

/**
 * Placement context: converts edge-local (s, y, d) into world space and clamps
 * every vertex into the building's own AABB, expanded outward by at most
 * `maxProjection`. This is what makes the "never leaves the source volume"
 * invariant hold by construction instead of by convention.
 */
function createPlacement(bounds, baseY, height, maxProjection, uvMetres, triangleCap) {
  const minX = bounds.minX - maxProjection;
  const maxX = bounds.maxX + maxProjection;
  const minZ = bounds.minZ - maxProjection;
  const maxZ = bounds.maxZ + maxProjection;
  const minY = baseY;
  const maxY = baseY + height;
  return {
    baseY,
    uvMetres,
    triangleCap,
    // `y` is a local height above the shell base; the caller never has to
    // carry the terrain sample around.
    place(edge, s, y, d) {
      const x = edge.ax + edge.ux * s + edge.nx * d;
      const z = edge.az + edge.uz * s + edge.nz * d;
      return [clamp(x, minX, maxX), clamp(baseY + y, minY, maxY), clamp(z, minZ, maxZ)];
    },
    direction(edge, hint) {
      switch (hint) {
        case 'out': return [edge.nx, 0, edge.nz];
        case 'in': return [-edge.nx, 0, -edge.nz];
        case 'up': return [0, 1, 0];
        case 'down': return [0, -1, 0];
        case 'along': return [edge.ux, 0, edge.uz];
        case 'against': return [-edge.ux, 0, -edge.uz];
        default: return [edge.nx, 0, edge.nz];
      }
    },
  };
}

/** Horizontal band with a real soffit: projecting ledge or recessed groove. */
function emitLedge(sink, edge, s0, s1, yBottom, yTop, depth, role = 'structure') {
  if (!(s1 - s0 > EPSILON) || !(yTop - yBottom > EPSILON) || Math.abs(depth) < 1e-3) return;
  const outer = depth;
  sink.quad(role, edge, [[s0, yBottom, outer], [s0, yTop, outer], [s1, yTop, outer], [s1, yBottom, outer]], 'out');
  // Top surface of a projecting ledge faces up; the top of a groove is the
  // soffit of the wall above it and faces down.
  sink.quad(role, edge, [[s0, yTop, 0], [s1, yTop, 0], [s1, yTop, outer], [s0, yTop, outer]], depth > 0 ? 'up' : 'down');
  sink.quad(role, edge, [[s0, yBottom, 0], [s1, yBottom, 0], [s1, yBottom, outer], [s0, yBottom, outer]], depth > 0 ? 'down' : 'up');
}

/** Recessed opening: four reveal returns plus the pane set back in the hole. */
function emitReveal(sink, edge, s0, s1, y0, y1, depth, paneRole = 'glass') {
  const d = -Math.abs(depth);
  sink.quad(paneRole, edge, [[s0, y0, d], [s0, y1, d], [s1, y1, d], [s1, y0, d]], 'out');
  sink.quad('structure', edge, [[s0, y0, 0], [s0, y1, 0], [s0, y1, d], [s0, y0, d]], 'along');
  sink.quad('structure', edge, [[s1, y0, 0], [s1, y1, 0], [s1, y1, d], [s1, y0, d]], 'against');
  sink.quad('structure', edge, [[s0, y1, 0], [s1, y1, 0], [s1, y1, d], [s0, y1, d]], 'down');
  sink.quad('structure', edge, [[s0, y0, 0], [s1, y0, 0], [s1, y0, d], [s0, y0, d]], 'up');
}

function storeyLayout(building, height, commercial) {
  let stories = Math.round(Number(building?.stories));
  const capacity = Math.max(1, Math.floor(height / 2.5));
  if (!Number.isFinite(stories) || stories < 1) stories = Math.max(1, Math.round(height / 3.4));
  stories = clamp(stories, 1, Math.min(capacity, 60));
  if (stories === 1) {
    return { stories: 1, floors: [0], tops: [height] };
  }
  const preferred = commercial ? 4.4 : 3.6;
  const room = height - 2.5 * (stories - 1);
  const ground = clamp(preferred, 2.5, Math.max(2.5, room));
  const upper = (height - ground) / (stories - 1);
  const floors = [0];
  const tops = [ground];
  for (let i = 1; i < stories; i += 1) {
    floors.push(ground + (i - 1) * upper);
    tops.push(ground + i * upper);
  }
  tops[tops.length - 1] = height;
  return { stories, floors, tops };
}

/** Deterministic per-building variation, drawn before any LOD branching. */
function drawVariant(building, style) {
  const random = mulberry32(facadeDepthSeed(building?.id));
  const profile = FACADE_STYLE_PROFILES[style];
  return {
    bayWidth: profile.bayWidth * (0.9 + random() * 0.22),
    windowRatio: clamp(profile.windowRatio * (0.94 + random() * 0.14), 0.4, 0.86),
    revealDepth: clamp(profile.revealDepth * (0.88 + random() * 0.26), 0.1, 0.25),
    corniceHeight: profile.corniceHeight * (0.9 + random() * 0.24),
    plinthHeight: profile.plinthHeight * (0.88 + random() * 0.3),
    sillLift: 0.85 + random() * 0.32,
    doorPick: random(),
    bayColumns: random() < 0.45 ? 1 : 2,
    bayStoreys: 2 + Math.floor(random() * 2),
    pilasterPick: random(),
    shopHead: 0.28 + random() * 0.18,
  };
}

/**
 * Pure facade plan. No three.js, no DOM. Returns quads in world space with the
 * shell's own UV parameterisation, plus exact triangle accounting.
 *
 * @param {object} building city.buildings[i] shaped record
 * @param {object} [options]
 * @param {'off'|'far'|'mid'|'near'} [options.lod='near']
 * @param {number} [options.baseY=0] ground elevation of the shell base
 * @param {number} [options.maxProjection=0.45] outward projection allowance (m)
 * @param {number} [options.triangleCap] override the per-LOD triangle cap
 * @param {{x:number,y:number}} [options.uvMetres]
 */
export function planFacadeDepth(building, options = {}) {
  const lod = FACADE_DEPTH_LODS.includes(options.lod) ? options.lod : 'near';
  const style = resolveFacadeStyle(building);
  const profile = FACADE_STYLE_PROFILES[style];
  const config = LOD_CONFIG[lod];
  const cap = Number.isFinite(options.triangleCap)
    ? Math.max(0, options.triangleCap)
    : FACADE_DEPTH_BUDGET.trianglesPerBuilding[lod];
  const maxProjection = Number.isFinite(options.maxProjection)
    ? clamp(options.maxProjection, 0, FACADE_DEPTH_MAX_PROJECTION)
    : FACADE_DEPTH_MAX_PROJECTION;
  const uvMetres = options.uvMetres || FACADE_DEPTH_UV_METRES;
  const baseY = Number.isFinite(options.baseY) ? options.baseY : 0;
  const height = Number(building?.height);

  const empty = {
    id: building?.id ?? null,
    style,
    lod,
    quads: [],
    triangles: 0,
    features: {},
    bounds: null,
    baseY,
    height: Number.isFinite(height) ? height : 0,
    maxProjection,
    skipped: 'empty',
  };

  const points = normalisePolygon(building?.polygon);
  if (!points.length) return { ...empty, skipped: 'polygon' };
  if (!Number.isFinite(height) || height < MIN_BUILDING_HEIGHT) return { ...empty, skipped: 'height' };
  if (cap <= 0 || lod === 'off') return { ...empty, skipped: 'lod-off' };

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
  const planExtent = Math.min(maxX - minX, maxZ - minZ);
  if (!(planExtent >= MIN_PLAN_EXTENT)) return { ...empty, skipped: 'extent' };

  const allEdges = buildEdges(points);
  if (!allEdges.length) return { ...empty, skipped: 'edges' };

  const variant = drawVariant(building, style);
  // A tagged shop or amenity earns a real recessed entrance; a style whose
  // ground floor is glazed by convention only earns the glazing line.
  const tagged = hasStreetLevelTrade(building);
  const commercial = tagged || profile.commercialGround;
  const layout = storeyLayout(building, height, commercial);
  // Inward recesses can never eat more than a fifth of the plan thickness, so
  // a reveal cannot punch through a narrow building.
  const inwardLimit = Math.max(0.05, Math.min(0.45, planExtent * 0.2));
  const reveal = Math.min(variant.revealDepth, inwardLimit);

  const placement = createPlacement({ minX, maxX, minZ, maxZ }, baseY, height, maxProjection, uvMetres, cap);
  const sink = new QuadSink(placement);

  const ranked = allEdges.slice().sort((a, b) => (b.length - a.length) || (a.index - b.index));
  const edges = ranked.filter((edge) => edge.length >= MIN_EDGE_LENGTH).slice(0, config.edges);
  if (!edges.length) return { ...empty, skipped: 'short-edges' };
  const primary = edges[0];

  const project = (value) => Math.min(value, maxProjection);
  const grooveOr = (value, groove) => (project(value) >= 0.02 ? project(value) : groove);

  // 1. Cornice / parapet cap at the roofline. Cheapest, highest silhouette
  //    value: it is what stops a roof edge reading as a cut-off box.
  if (config.cornice) {
    const corniceHeight = Math.min(variant.corniceHeight, height * 0.12);
    const depth = grooveOr(profile.corniceProjection, -Math.min(0.08, inwardLimit));
    for (const edge of edges) {
      sink.begin();
      emitLedge(sink, edge, 0, edge.length, height - corniceHeight, height, depth);
      sink.commit('cornice');
    }
  }

  // 2. Ground plinth: the base course that gives the wall a foot.
  if (config.plinth) {
    const plinthHeight = Math.min(variant.plinthHeight, height * 0.14);
    const depth = grooveOr(profile.plinthProjection, -Math.min(0.05, inwardLimit));
    for (const edge of edges) {
      sink.begin();
      // Lifted off the base plane so the plinth soffit cannot z-fight with the
      // sidewalk or the terrain sample the shell sits on.
      emitLedge(sink, edge, 0, edge.length, GROUND_CLEARANCE, plinthHeight, depth);
      sink.commit('plinth');
    }
  }

  // 3. Ground floor: shopfront glazing line and a recessed door for anything
  //    with a shop or amenity tag, on the street-facing (longest) edge.
  const groundTop = layout.tops[0];
  const shopWindows = commercial && config.shopfront && groundTop > 2.6 && primary.length >= 4;
  if (shopWindows) {
    const head = groundTop - Math.max(0.5, variant.shopHead * 1.6);
    const cill = Math.min(0.65, groundTop * 0.18);
    const inset = Math.min(0.9, primary.length * 0.08);
    const s0 = inset;
    const s1 = primary.length - inset;
    const glazingDepth = Math.min(0.22, inwardLimit);
    if (s1 - s0 > 1.2 && head - cill > 1.2) {
      sink.begin();
      emitReveal(sink, primary, s0, s1, cill, head, glazingDepth, 'glass');
      sink.commit('shopfront-glazing');

      // Door recess: a deeper hole so the entrance reads from the sidewalk.
      const doorWidth = clamp((s1 - s0) * 0.16, 1, 1.8);
      const doorCentre = s0 + (s1 - s0) * (0.2 + variant.doorPick * 0.6);
      const d0 = clamp(doorCentre - doorWidth / 2, s0, s1 - doorWidth);
      const doorHeight = Math.min(2.4, head - 0.15);
      const doorDepth = Math.min(0.35, inwardLimit);
      if (tagged && doorHeight > 1.9) {
        sink.begin();
        emitReveal(sink, primary, d0, d0 + doorWidth, GROUND_CLEARANCE, doorHeight, doorDepth, 'glass');
        // Threshold floor of the recess, held just off the sidewalk plane.
        sink.quad('structure', primary, [[d0, GROUND_CLEARANCE, 0], [d0 + doorWidth, GROUND_CLEARANCE, 0], [d0 + doorWidth, GROUND_CLEARANCE, -doorDepth], [d0, GROUND_CLEARANCE, -doorDepth]], 'up');
        sink.commit('door-recess');
      }
    }
  }

  // 4. String courses between storeys, for the older styles.
  if (config.stringCourse && profile.stringCourse && layout.stories > 1) {
    const depth = grooveOr(0.14, -Math.min(0.06, inwardLimit));
    const last = Math.min(layout.stories - 1, config.storeys);
    for (const edge of edges) {
      for (let storey = 1; storey <= last; storey += 1) {
        const y = layout.floors[storey];
        if (!(y > 0.6) || y + 0.3 > height) continue;
        sink.begin();
        emitLedge(sink, edge, 0, edge.length, y - 0.15, y + 0.15, depth);
        sink.commit('string-course');
      }
    }
  }

  // 5. Bay windows. San Francisco's signature: a projecting three-sided oriel
  //    over the upper storeys. With a zero projection allowance it degrades to
  //    a recessed oriel niche rather than disappearing.
  if (config.bay && profile.bay && layout.stories > 1) {
    const projection = project(profile.bayProjection || 0.4);
    const depth = projection >= 0.08 ? projection : -Math.min(0.25, inwardLimit);
    const bayEdges = edges.slice(0, 2);
    const topStorey = Math.min(layout.stories - 1, config.storeys, variant.bayStoreys);
    for (const edge of bayEdges) {
      const columns = Math.min(variant.bayColumns, Math.max(1, Math.floor(edge.length / 4.5)));
      const pitch = edge.length / columns;
      const width = Math.min(pitch * 0.6, 3);
      if (width < 1.4 || topStorey < 1) continue;
      const splay = Math.min(width * 0.2, 0.5);
      for (let column = 0; column < columns; column += 1) {
        const centre = (column + 0.5) * pitch;
        const s0 = centre - width / 2;
        const s1 = centre + width / 2;
        const yBottom = layout.floors[1];
        const yTop = Math.min(layout.tops[topStorey], height - 0.2);
        if (!(yTop - yBottom > 2)) continue;
        sink.begin();
        // Front pane and the two splayed cheeks, per storey, plus caps.
        for (let storey = 1; storey <= topStorey; storey += 1) {
          const y0 = Math.max(yBottom, layout.floors[storey]) + 0.18;
          const y1 = Math.min(yTop, layout.tops[storey]) - 0.18;
          if (!(y1 - y0 > 0.8)) continue;
          sink.quad('glass', edge, [[s0 + splay, y0, depth], [s0 + splay, y1, depth], [s1 - splay, y1, depth], [s1 - splay, y0, depth]], 'out');
          sink.quad('glass', edge, [[s0, y0, 0], [s0, y1, 0], [s0 + splay, y1, depth], [s0 + splay, y0, depth]], 'against');
          sink.quad('glass', edge, [[s1, y0, 0], [s1, y1, 0], [s1 - splay, y1, depth], [s1 - splay, y0, depth]], 'along');
        }
        sink.quad('structure', edge, [[s0, yBottom, 0], [s1, yBottom, 0], [s1 - splay, yBottom, depth], [s0 + splay, yBottom, depth]], depth > 0 ? 'down' : 'up');
        sink.quad('structure', edge, [[s0, yTop, 0], [s1, yTop, 0], [s1 - splay, yTop, depth], [s0 + splay, yTop, depth]], depth > 0 ? 'up' : 'down');
        sink.commit('bay-window');
      }
    }
  }

  // 6. Pilasters: vertical fins between bays, art-deco only.
  if (config.pilaster && profile.pilaster) {
    const depth = project(0.12);
    if (depth >= 0.04) {
      for (const edge of edges.slice(0, 2)) {
        const columns = clamp(Math.floor(edge.length / variant.bayWidth), 1, MAX_BAYS_PER_EDGE);
        const pitch = edge.length / columns;
        const width = clamp(pitch * 0.12, 0.25, 0.6);
        const yTop = Math.max(0, height - Math.min(variant.corniceHeight, height * 0.12));
        for (let column = 1; column < columns; column += 1) {
          const s0 = column * pitch - width / 2;
          const s1 = s0 + width;
          if (s0 < 0.1 || s1 > edge.length - 0.1 || yTop < 3) continue;
          sink.begin();
          sink.quad('structure', edge, [[s0, GROUND_CLEARANCE, depth], [s0, yTop, depth], [s1, yTop, depth], [s1, GROUND_CLEARANCE, depth]], 'out');
          sink.quad('structure', edge, [[s0, GROUND_CLEARANCE, 0], [s0, yTop, 0], [s0, yTop, depth], [s0, GROUND_CLEARANCE, depth]], 'against');
          sink.quad('structure', edge, [[s1, GROUND_CLEARANCE, 0], [s1, yTop, 0], [s1, yTop, depth], [s1, GROUND_CLEARANCE, depth]], 'along');
          sink.commit('pilaster');
        }
      }
    }
  }

  // 7. Recessed window openings with sills and lintels. Emitted last and per
  //    window, so the budget trims whole windows rather than half a facade.
  let windowsLeft = config.windows;
  if (windowsLeft > 0) {
    const sillDepth = project(0.12);
    const lintelDepth = project(0.09);
    const topStorey = Math.min(layout.stories - 1, config.storeys);
    for (const edge of edges) {
      if (windowsLeft <= 0) break;
      const columns = clamp(Math.floor((edge.length - 1) / variant.bayWidth), 1, MAX_BAYS_PER_EDGE);
      const pitch = edge.length / columns;
      const width = Math.min(variant.bayWidth * variant.windowRatio, pitch * 0.72, 2.6);
      if (width < MIN_WINDOW_WIDTH) continue;
      for (let storey = 0; storey <= topStorey; storey += 1) {
        if (windowsLeft <= 0) break;
        if (storey === 0 && shopWindows) continue;
        const floorY = layout.floors[storey];
        const storeyHeight = layout.tops[storey] - floorY;
        if (!(storeyHeight > 2.2)) continue;
        const sillY = floorY + clamp(storeyHeight * 0.26, 0.7, variant.sillLift);
        let windowHeight = Math.min(storeyHeight * 0.56, 2.3);
        windowHeight = Math.min(windowHeight, floorY + storeyHeight - 0.3 - sillY);
        if (windowHeight < MIN_WINDOW_HEIGHT) continue;
        const headY = sillY + windowHeight;
        if (headY > height - 0.15) continue;
        for (let column = 0; column < columns; column += 1) {
          if (windowsLeft <= 0) break;
          const centre = (column + 0.5) * pitch;
          const s0 = centre - width / 2;
          const s1 = centre + width / 2;
          if (s0 < 0.25 || s1 > edge.length - 0.25) continue;
          sink.begin();
          emitReveal(sink, edge, s0, s1, sillY, headY, reveal, 'glass');
          if (config.sill && profile.sill && sillDepth >= 0.03) {
            emitLedge(sink, edge, s0 - 0.14, s1 + 0.14, sillY - 0.12, sillY, sillDepth);
          }
          if (config.lintel && profile.lintel && lintelDepth >= 0.03 && headY + 0.18 < height) {
            emitLedge(sink, edge, s0 - 0.1, s1 + 0.1, headY, headY + 0.14, lintelDepth);
          }
          if (sink.commit('window')) windowsLeft -= 1;
          else { windowsLeft = 0; break; }
        }
      }
    }
  }

  let boundsMinX = Infinity;
  let boundsMaxX = -Infinity;
  let boundsMinY = Infinity;
  let boundsMaxY = -Infinity;
  let boundsMinZ = Infinity;
  let boundsMaxZ = -Infinity;
  for (const quad of sink.quads) {
    for (let i = 0; i < 4; i += 1) {
      const x = quad.positions[i * 3];
      const y = quad.positions[i * 3 + 1];
      const z = quad.positions[i * 3 + 2];
      boundsMinX = Math.min(boundsMinX, x);
      boundsMaxX = Math.max(boundsMaxX, x);
      boundsMinY = Math.min(boundsMinY, y);
      boundsMaxY = Math.max(boundsMaxY, y);
      boundsMinZ = Math.min(boundsMinZ, z);
      boundsMaxZ = Math.max(boundsMaxZ, z);
    }
  }

  return {
    id: building?.id ?? null,
    style,
    lod,
    quads: sink.quads,
    triangles: sink.triangles,
    features: { ...sink.counts },
    bounds: sink.quads.length
      ? { minX: boundsMinX, maxX: boundsMaxX, minY: boundsMinY, maxY: boundsMaxY, minZ: boundsMinZ, maxZ: boundsMaxZ }
      : null,
    footprint: { minX, maxX, minZ, maxZ },
    baseY,
    height,
    maxProjection,
    storeys: layout.stories,
    skipped: sink.quads.length ? null : 'no-features',
  };
}

// ------------------------------------------------------------------ geometry

function geometryFromQuads(quads) {
  const count = quads.length;
  if (!count) return null;
  const positions = new Float32Array(count * 12);
  const normals = new Float32Array(count * 12);
  const uvs = new Float32Array(count * 8);
  const index = count * 4 > 65535 ? new Uint32Array(count * 6) : new Uint16Array(count * 6);
  for (let q = 0; q < count; q += 1) {
    const quad = quads[q];
    positions.set(quad.positions, q * 12);
    uvs.set(quad.uvs, q * 8);
    for (let v = 0; v < 4; v += 1) {
      normals[q * 12 + v * 3] = quad.normal[0];
      normals[q * 12 + v * 3 + 1] = quad.normal[1];
      normals[q * 12 + v * 3 + 2] = quad.normal[2];
    }
    const base = q * 4;
    const i = q * 6;
    index[i] = base;
    index[i + 1] = base + 1;
    index[i + 2] = base + 2;
    index[i + 3] = base;
    index[i + 4] = base + 2;
    index[i + 5] = base + 3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Build the additive facade geometry for one building.
 *
 * @returns {{
 *   id: *, style: string, lod: string, triangles: number,
 *   parts: { structure: THREE.BufferGeometry|null, glass: THREE.BufferGeometry|null },
 *   plan: object
 * }}
 */
export function buildFacadeDepth(building, options = {}) {
  const plan = planFacadeDepth(building, options);
  const structure = [];
  const glass = [];
  for (const quad of plan.quads) (quad.role === 'glass' ? glass : structure).push(quad);
  return {
    id: plan.id,
    style: plan.style,
    lod: plan.lod,
    triangles: plan.triangles,
    parts: {
      structure: geometryFromQuads(structure),
      glass: geometryFromQuads(glass),
    },
    plan,
  };
}

function resolveLod(building, options, index) {
  if (typeof options.lodFor === 'function') {
    const chosen = options.lodFor(building, index);
    if (FACADE_DEPTH_LODS.includes(chosen)) return chosen;
  }
  if (FACADE_DEPTH_LODS.includes(options.lod)) return options.lod;
  const view = options.viewPoint;
  if (view && Number.isFinite(view.x) && Number.isFinite(view.z)) {
    const polygon = normalisePolygon(building?.polygon);
    if (!polygon.length) return 'off';
    let cx = 0;
    let cz = 0;
    for (const point of polygon) {
      cx += point.x;
      cz += point.z;
    }
    cx /= polygon.length;
    cz /= polygon.length;
    return facadeDepthLodForDistance(
      Math.hypot(cx - view.x, cz - view.z),
      options.lodDistances || FACADE_DEPTH_LOD_DISTANCES,
    );
  }
  return 'near';
}

/**
 * Build merged facade depth for a set of buildings.
 *
 * Geometry is merged per (style, role), so the whole city costs at most
 * `FACADE_DEPTH_BUDGET.maxDrawCalls` (12) additional draw calls.
 *
 * @param {Array<object>} buildings
 * @param {object} [options]
 * @param {'off'|'far'|'mid'|'near'} [options.lod]
 * @param {(building:object, index:number)=>string} [options.lodFor]
 * @param {{x:number,z:number}} [options.viewPoint] distance driven LOD
 * @param {(building:object)=>number} [options.baseYFor] terrain sample per building
 * @param {number} [options.baseY]
 * @param {number} [options.maxProjection]
 * @param {number} [options.sceneTriangleBudget] stop adding detail past this
 */
export function buildFacadeDepthBatch(buildings, options = {}) {
  const list = Array.isArray(buildings) ? buildings : [];
  const sceneBudget = Number.isFinite(options.sceneTriangleBudget)
    ? options.sceneTriangleBudget
    : FACADE_DEPTH_BUDGET.sceneTriangleBudget;
  const buckets = new Map();
  const perBuilding = [];
  let triangles = 0;
  let skipped = 0;
  for (let index = 0; index < list.length; index += 1) {
    const building = list[index];
    const lod = resolveLod(building, options, index);
    if (lod === 'off') {
      skipped += 1;
      continue;
    }
    const baseY = typeof options.baseYFor === 'function'
      ? Number(options.baseYFor(building))
      : options.baseY;
    const plan = planFacadeDepth(building, {
      lod,
      baseY: Number.isFinite(baseY) ? baseY : 0,
      maxProjection: options.maxProjection,
      uvMetres: options.uvMetres,
    });
    if (!plan.quads.length) {
      skipped += 1;
      continue;
    }
    if (triangles + plan.triangles > sceneBudget) {
      skipped += 1;
      continue;
    }
    triangles += plan.triangles;
    perBuilding.push({ id: plan.id, style: plan.style, lod: plan.lod, triangles: plan.triangles });
    for (const quad of plan.quads) {
      const key = `${plan.style}:${quad.role}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, style: plan.style, role: quad.role, quads: [], buildingIds: [] };
        buckets.set(key, bucket);
      }
      bucket.quads.push(quad);
      if (bucket.buildingIds[bucket.buildingIds.length - 1] !== plan.id) bucket.buildingIds.push(plan.id);
    }
  }
  const groups = [];
  const orderedKeys = Array.from(buckets.keys()).sort();
  for (const key of orderedKeys) {
    const bucket = buckets.get(key);
    const geometry = geometryFromQuads(bucket.quads);
    if (!geometry) continue;
    groups.push({
      key,
      style: bucket.style,
      role: bucket.role,
      geometry,
      triangles: bucket.quads.length * 2,
      quads: bucket.quads.length,
      buildingIds: bucket.buildingIds.slice(),
    });
  }
  return {
    version: FACADE_DEPTH_VERSION,
    groups,
    drawCalls: groups.length,
    triangles,
    buildings: perBuilding,
    skipped,
    sceneTriangleBudget: sceneBudget,
  };
}

/** Release every geometry produced by build* helpers. */
export function disposeFacadeDepth(result) {
  if (!result) return;
  if (result.parts) {
    for (const geometry of Object.values(result.parts)) geometry?.dispose?.();
  }
  if (Array.isArray(result.groups)) {
    for (const group of result.groups) group.geometry?.dispose?.();
  }
}
