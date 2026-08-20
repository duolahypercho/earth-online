// facade-articulation — presentation pass.
//
// Owner: Terrain/buildings
// Goal:  Constructed facade depth: window reveals, frames, sills, cornices,
//        storefront bands.
//
// Contract: see src/render/pass-registry.js. Build from the city contract in
// `ctx`; never mutate simulation state, never create a renderer or loop.
//
// ---------------------------------------------------------------------------
// What this pass does, and why it takes the wall over rather than adding to it
// ---------------------------------------------------------------------------
//
// The building shell is a flat extruded prism carrying a tiled canvas texture.
// That texture is a *metric wallpaper*: one 128 px tile every 12 m x 4.6 m,
// with three to six painted window rows inside each tile, so its "windows"
// have no relation to the building's storeys and land every 0.8-1.5 m of wall.
// Additive trim laid over it cannot fix that, and real openings laid over it
// produce two disagreeing grids, which is worse than either.
//
// So the pass clads: `buildFacadeArticulationBatch` emits a contiguous
// partition of every visible wall -- base, spandrels, piers, openings, cap --
// standing 140-260 mm proud of the shell, and the painted grid is covered.
// Every element is real geometry with real depth: a window is four reveal
// returns, a frame ring, a pane set back behind the frame, mullion and transom
// bars, a projecting sill and a drip recess cut under it.
//
// The whole build-up sits OUTSIDE the shell wall, which is the only
// arrangement that works: the shell is opaque and is still drawn, so an
// opening cut inward shows the shell's painted texture at the bottom of the
// hole instead of glass. See the depth-stack note in facade-depth.js.
//
// Because the pass now owns the visible wall it also takes over from the
// legacy additive relief (`userData.kind === 'buildings-facade-relief'`), which
// would otherwise z-fight with it at the cornice and the glazing bands. Those
// meshes are hidden while this pass is built and restored on dispose. The
// permanent fix belongs in the renderer's call site and is requested there.
//
// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------
//
// Rings, radii and per-ring triangle caps live in FACADE_ARTICULATION_RINGS
// (src/world/buildings/facade-depth.js) and are reported in `diagnostics`:
//
//   near   <=  78 m   <=  22 buildings   base 6000 tri/building
//   mid    <= 175 m   <=  56 buildings   base 2000 tri/building
//   far    <= 380 m   <= 180 buildings   base  640 tri/building
//   beyond            <= 900 buildings   base   48 tri/building
//
// The base cap is scaled by the greater of the building's wall area and its
// edge count; see `articulationTriangleCap`. Per-window geometry stops at
// 175 m. Scene ceiling is 330,000 triangles and 48 draw calls, enforced by
// uniform outside-in ring demotion. Measured on the real 700 building slice
// from the street capture pose: 181,236 triangles, 29 draw calls, 0 demotions,
// 700/700 buildings articulated.
//
// Captures run through a software GL backend, so the pass also renders before
// the shell (`renderOrder = -1`): the cladding wins the depth test first and
// the shell fragments behind it are rejected early instead of being shaded
// twice.
//
// ---------------------------------------------------------------------------
// LOD centre
// ---------------------------------------------------------------------------
//
// `ctx.focus` is the renderer's *build* focus: it is sampled once, when the
// city is built, and the player then walks away from it. Measured on the
// current capture set the street pose stands ~600 m from it, which is exactly
// how a fully articulated ring ends up centred on nobody. The pass therefore
// takes the build focus as its starting centre and re-centres on the live
// camera in `update` once it has moved past a threshold: 25 m for the
// near/mid `detail` zone, 90 m for the `far`/silhouette `bulk` zone. A rebuild
// is a few hundred milliseconds and happens at most once per threshold
// crossing; `diagnostics.refreshes` and `diagnostics.lastRefreshMs` record it.
import * as THREE from 'three';
import {
  FACADE_ARTICULATION_BUDGET,
  FACADE_ARTICULATION_ROLES,
  FACADE_MATERIAL_CLASS_NAMES,
  FACADE_DEPTH_UV_METRES,
  FACADE_ARTICULATION_RINGS,
  FACADE_ARTICULATION_VERSION,
  FACADE_GLASS_MATERIAL,
  FACADE_INTERIOR_MATERIAL,
  FACADE_MATERIAL_CLASSES,
  FACADE_FRAME_MATERIAL,
  buildFacadeArticulationBatch,
  disposeFacadeArticulation,
  facadeFootprintMetrics,
} from '../../world/buildings/facade-depth.js';
import { applyDetailMaps, repeatForSurface } from '../detail-maps.js';

const ZONES = ['detail', 'bulk'];

/** Environment class per material class, for the renderer's IBL grading. */
const ENV_CLASS = Object.freeze({
  brick: 'facade-masonry',
  stone: 'facade-masonry',
  concrete: 'facade-masonry',
  plaster: 'facade-painted',
  painted: 'facade-painted',
  clapboard: 'facade-painted',
  'curtain-wall': 'facade-metal',
});

/** Live pass state. A pass module is a singleton, so this is its whole world. */
const state = {
  group: null,
  zoneGroups: new Map(),
  zoneBatches: new Map(),
  materials: new Map(),
  centres: new Map(),
  buildings: [],
  baseYFor: null,
  preserveIds: new Set(),
  hiddenLegacy: [],
  refreshes: 0,
  lastRefreshMs: 0,
  litMaterials: [],
  nightLevel: -1,
  diagnostics: { version: FACADE_ARTICULATION_VERSION, implemented: true },
};

/**
 * How lit the interiors are, from the clock. 0 in daylight, 1 after dark, with
 * an hour of ramp at each end so dusk and dawn cards land in between rather
 * than snapping. `ctx.day === false` forces full night for a caller that drives
 * the state directly instead of the hour.
 */
function nightLevelFor(ctx) {
  if (ctx?.day === false) return 1;
  const hour = Number(ctx?.hour);
  if (!Number.isFinite(hour)) return 0;
  if (hour <= 6) return 1;
  if (hour < 7.2) return (7.2 - hour) / 1.2;
  if (hour >= 20.2) return 1;
  if (hour > 18.2) return (hour - 18.2) / 2;
  return 0;
}

/** Apply the clock to the lit-glass bucket. No allocation in the steady state. */
function applyNightLevel(level) {
  const quantised = Math.round(level * 20) / 20;
  if (quantised === state.nightLevel) return false;
  state.nightLevel = quantised;
  for (const material of state.litMaterials) {
    material.emissiveIntensity = FACADE_GLASS_MATERIAL.nightEmissiveIntensity * quantised;
  }
  // Diagnostics are only rebuilt on an LOD refresh, so the clock has to write
  // its own field or a reader sees the level from the last time the camera
  // moved rather than the level the materials are actually at.
  if (state.diagnostics) state.diagnostics.nightLevel = quantised;
  return true;
}

function emptyDiagnostics(reason) {
  return {
    version: FACADE_ARTICULATION_VERSION,
    implemented: true,
    reason,
    centre: null,
    centreSource: null,
    sourceBuildings: 0,
    articulated: 0,
    openings: 0,
    bands: 0,
    triangles: 0,
    drawCalls: 0,
    rings: {},
    rejected: [],
    rejectedByReason: {},
    signatures: { total: 0, unique: 0, uniqueRatio: 1, neighbourCollisions: 0, resignatured: 0 },
    budget: {
      sceneTriangleBudget: FACADE_ARTICULATION_BUDGET.sceneTriangleBudget,
      maxDrawCalls: FACADE_ARTICULATION_BUDGET.maxDrawCalls,
      withinBudget: true,
      demotions: 0,
    },
    supersededLegacyMeshes: 0,
    refreshes: 0,
    lastRefreshMs: 0,
  };
}

/** The LOD centre. The live camera wins; the build focus is the fallback. */
function resolveCentre(ctx, preferCamera) {
  const camera = ctx?.camera?.position;
  if (preferCamera && camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
    return { centre: { x: camera.x, z: camera.z }, source: 'camera' };
  }
  const focus = ctx?.focus;
  if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.z)) {
    return { centre: { x: focus.x, z: focus.z }, source: 'focus' };
  }
  if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
    return { centre: { x: camera.x, z: camera.z }, source: 'camera' };
  }
  return { centre: { x: 0, z: 0 }, source: 'origin' };
}

/**
 * One material per (class, role). Created once per city and reused across
 * every LOD refresh, so a rebuild costs geometry only.
 *
 * Colour lives in the geometry's vertex colours -- palette tint multiplied by
 * the geometric weathering response -- so one merged draw call carries a whole
 * street of different building colours and the material itself stays white.
 */
function materialFor(className, role) {
  const key = `${className}|${role}`;
  const cached = state.materials.get(key);
  if (cached) return cached;
  const classDef = FACADE_MATERIAL_CLASSES[className] || FACADE_MATERIAL_CLASSES.plaster;
  let material;
  if (role === 'glass' || role === 'glass-lit') {
    // Glass is a DIELECTRIC. Round 1 gave it metalness 0.26-0.42 with a dark
    // base colour, which kills the diffuse term and tints the specular by that
    // same dark colour -- the result was a pure black pane at golden hour and a
    // black storefront band in daylight. metalness 0 restores both halves of
    // the physical answer: the interior ramp baked into vertex colour shows
    // through the 4% normal-incidence reflectance, and the Fresnel term takes
    // the environment reflection up toward 100% as the view angle goes
    // grazing. That is the "reflectivity that varies with view angle".
    material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: FACADE_GLASS_MATERIAL.roughness,
      metalness: FACADE_GLASS_MATERIAL.metalness,
    });
    if (role === 'glass-lit') {
      // The lit bucket. The shell's own emissive night texture is behind the
      // cladding now and cannot be seen, so without this the night card loses
      // every lit window on a clad building. Intensity is driven from the
      // clock in `update`.
      material.emissive = new THREE.Color(FACADE_GLASS_MATERIAL.emissive);
      material.emissiveIntensity = 0;
    }
    material.userData.envClass = 'facade-glass';
  } else if (role === 'interior') {
    // Blinds, curtains, shop fittings and plant-floor louvres: matte, opaque,
    // and standing in the glazing cavity behind the pane.
    material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: FACADE_INTERIOR_MATERIAL.roughness,
      metalness: FACADE_INTERIOR_MATERIAL.metalness,
    });
    material.userData.envClass = 'facade-painted';
  } else if (role === 'frame') {
    material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: FACADE_FRAME_MATERIAL.roughness,
      metalness: FACADE_FRAME_MATERIAL.metalness,
    });
    material.userData.envClass = 'facade-metal';
  } else {
    material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: classDef.roughness,
      metalness: classDef.metalness,
    });
    // High-frequency surface. UVs are baked in units of the shell's own
    // 12 m x 4.6 m tile, so the repeat is stated in those units once.
    try {
      applyDetailMaps(material, classDef.surface, {
        repeat: repeatForSurface(classDef.surface, FACADE_DEPTH_UV_METRES.x, FACADE_DEPTH_UV_METRES.y),
        roughnessScale: classDef.roughness,
        metalnessScale: classDef.metalness,
        normalScale: classDef.detail,
        aoMapIntensity: 0.7,
      });
      material.userData.detailClass = classDef.surface;
    } catch (error) {
      // A backend without canvas or DataTexture support must not take the
      // whole facade down; the flat material is still correct, just plainer.
      material.userData.detailError = String(error?.message || error);
    }
    material.userData.envClass = ENV_CLASS[className] || 'facade-masonry';
  }
  material.name = `facade-articulation-${key}`;
  material.userData.articulationClass = className;
  material.userData.articulationRole = role;
  state.materials.set(key, material);
  if (role === 'glass-lit') {
    state.litMaterials.push(material);
    material.emissiveIntensity = FACADE_GLASS_MATERIAL.nightEmissiveIntensity * Math.max(0, state.nightLevel);
  }
  return material;
}

function disposeZone(zone) {
  const group = state.zoneGroups.get(zone);
  if (!group) return;
  for (const child of [...group.children]) {
    child.geometry?.dispose?.();
    group.remove(child);
  }
}

/** Build (or rebuild) one zone's merged meshes around `centre`. */
function buildZone(zone, centre) {
  const startedAt = Date.now();
  const batch = buildFacadeArticulationBatch(state.buildings, {
    focus: centre,
    zone,
    baseYFor: state.baseYFor,
    preserveIds: state.preserveIds,
  });
  disposeZone(zone);
  let group = state.zoneGroups.get(zone);
  if (!group) {
    group = new THREE.Group();
    group.name = `facade-articulation-${zone}`;
    state.zoneGroups.set(zone, group);
    state.group.add(group);
  }
  for (const entry of batch.groups) {
    const geometry = entry.geometry;
    // `aoMap` samples uv1; the articulation bakes one UV set, so uv1 shares
    // the same buffer rather than duplicating it.
    const uv = geometry.getAttribute('uv');
    if (uv && !geometry.getAttribute('uv1')) geometry.setAttribute('uv1', uv);
    const mesh = new THREE.Mesh(geometry, materialFor(entry.className, entry.role));
    // Only the detail zone casts. Its reveals, sills and cornices are what
    // self-shadow at eye level; adding the far ring to the shadow map costs
    // a second pass over ~80,000 triangles that resolves to nothing.
    mesh.castShadow = zone === 'detail' && entry.role !== 'glass';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // Draw the cladding before the shell it covers so the software backend
    // rejects the shell's fragments on depth instead of shading them.
    mesh.renderOrder = -1;
    mesh.name = `facade-articulation-${entry.key}`;
    mesh.userData = {
      kind: 'buildings-facade-articulation',
      zone,
      className: entry.className,
      role: entry.role,
      buildingIds: entry.buildingIds,
    };
    group.add(mesh);
  }
  state.zoneBatches.set(zone, batch);
  state.centres.set(zone, centre);
  return { batch, ms: Date.now() - startedAt };
}

/**
 * Buildings whose elevation is authored somewhere else. The renderer merges a
 * hand-made facade atlas onto a handful of hero frontages and publishes their
 * ids on the merged mesh; cladding procedural windows over a hand-authored
 * photographic facade would be a straight downgrade, so those keep their
 * surface and take the silhouette rung's roofline only.
 */
function authoredElevations(root) {
  const ids = new Set();
  if (!root?.traverse) return ids;
  root.traverse((object) => {
    if (object.userData?.kind !== 'buildings-hero-textured') return;
    for (const id of object.userData.buildingIds || []) ids.add(id);
  });
  return ids;
}

/**
 * Hide the legacy additive relief. It is a strict subset of what this pass
 * emits (cornice, plinth, glazing bands) and lands on exactly the same lines,
 * so leaving it visible buys nothing and costs z-fighting. Reversible: every
 * hidden mesh is restored in `dispose`.
 */
function supersedeLegacyRelief(root) {
  state.hiddenLegacy = [];
  if (!root?.traverse) return 0;
  root.traverse((object) => {
    if (object.userData?.kind === 'buildings-facade-relief' && object.visible) {
      object.visible = false;
      state.hiddenLegacy.push(object);
    }
  });
  return state.hiddenLegacy.length;
}

function collectDiagnostics(centre, centreSource) {
  const detail = state.zoneBatches.get('detail');
  const bulk = state.zoneBatches.get('bulk');
  const batches = [detail, bulk].filter(Boolean);
  const rings = {};
  for (const name of Object.keys(FACADE_ARTICULATION_RINGS)) {
    const spec = FACADE_ARTICULATION_RINGS[name];
    rings[name] = {
      radius: Number.isFinite(spec.radius) ? spec.radius : null,
      maxBuildings: spec.maxBuildings,
      triangleCap: spec.triangleCap,
      buildings: 0,
      triangles: 0,
    };
  }
  const rejected = [];
  const rejectedByReason = {};
  const features = {};
  const parts = {};
  const classes = {};
  const signatures = new Set();
  let triangles = 0;
  let drawCalls = 0;
  let openings = 0;
  let bands = 0;
  let articulated = 0;
  let demotions = 0;
  let partyEdges = 0;
  let preservedAuthored = 0;
  let collisions = 0;
  let resignatured = 0;
  for (const batch of batches) {
    triangles += batch.triangles;
    drawCalls += batch.drawCalls;
    openings += batch.openings;
    bands += batch.bands;
    articulated += batch.articulated;
    demotions = Math.max(demotions, batch.demotions);
    partyEdges += batch.partyEdges;
    preservedAuthored += batch.preservedAuthored;
    collisions += batch.signatures.neighbourCollisions;
    resignatured += batch.signatures.resignatured;
    for (const [name, ring] of Object.entries(batch.rings)) {
      rings[name].buildings += ring.buildings;
      rings[name].triangles += ring.triangles;
    }
    for (const entry of batch.rejected) if (rejected.length < 40) rejected.push(entry);
    for (const [reason, count] of Object.entries(batch.rejectedByReason)) {
      rejectedByReason[reason] = (rejectedByReason[reason] || 0) + count;
    }
    for (const [name, count] of Object.entries(batch.features)) features[name] = (features[name] || 0) + count;
    for (const [name, count] of Object.entries(batch.parts)) parts[name] = (parts[name] || 0) + count;
    for (const [name, count] of Object.entries(batch.classes)) classes[name] = (classes[name] || 0) + count;
    for (const record of batch.buildings) signatures.add(record.signature);
  }
  const budget = FACADE_ARTICULATION_BUDGET;
  return {
    version: FACADE_ARTICULATION_VERSION,
    implemented: true,
    centre,
    centreSource,
    sourceBuildings: state.buildings.length,
    articulated,
    openings,
    bands,
    triangles,
    drawCalls,
    rings,
    features,
    parts,
    classes,
    rejected,
    rejectedByReason,
    partyEdges,
    preservedAuthored,
    authoredElevations: state.preserveIds.size,
    signatures: {
      total: articulated,
      unique: signatures.size,
      uniqueRatio: articulated ? signatures.size / articulated : 1,
      neighbourCollisions: collisions,
      resignatured,
    },
    budget: {
      sceneTriangleBudget: budget.sceneTriangleBudget,
      maxDrawCalls: budget.maxDrawCalls,
      withinBudget: triangles <= budget.sceneTriangleBudget && drawCalls <= budget.maxDrawCalls,
      demotions,
      detailRefreshMetres: budget.detailRefreshMetres,
      bulkRefreshMetres: budget.bulkRefreshMetres,
    },
    supersededLegacyMeshes: state.hiddenLegacy.length,
    nightLevel: state.nightLevel,
    litPaneMaterials: state.litMaterials.length,
    refreshes: state.refreshes,
    lastRefreshMs: state.lastRefreshMs,
  };
}

function teardown() {
  for (const zone of ZONES) {
    disposeZone(zone);
    const batch = state.zoneBatches.get(zone);
    if (batch) disposeFacadeArticulation(batch);
  }
  state.zoneGroups.clear();
  state.zoneBatches.clear();
  state.centres.clear();
  state.buildings = [];
  state.baseYFor = null;
  state.preserveIds = new Set();
  state.refreshes = 0;
  state.lastRefreshMs = 0;
  state.group = null;
}

export default {
  id: 'facade-articulation',
  order: 20,

  build(ctx) {
    teardown();
    for (const object of state.hiddenLegacy) object.visible = true;
    state.hiddenLegacy = [];

    const buildings = Array.isArray(ctx?.city?.buildings) ? ctx.city.buildings : [];
    const group = new THREE.Group();
    group.name = 'facade-articulation';
    state.group = group;
    state.buildings = buildings;
    if (!buildings.length) {
      state.diagnostics = emptyDiagnostics('no-buildings');
      return { object: group, diagnostics: state.diagnostics };
    }

    const heightAt = typeof ctx?.heightAt === 'function' ? ctx.heightAt : null;
    // The shell base is sampled at the footprint centroid, exactly as the
    // renderer samples it, so the cladding cannot float or sink.
    const baseYCache = new Map();
    state.baseYFor = (building) => {
      if (baseYCache.has(building)) return baseYCache.get(building);
      let value = 0;
      if (heightAt) {
        const centroid = facadeFootprintMetrics(building).centroid;
        if (centroid) {
          const sample = Number(heightAt(centroid.x, centroid.z));
          if (Number.isFinite(sample)) value = sample;
        }
      }
      baseYCache.set(building, value);
      return value;
    };

    state.preserveIds = authoredElevations(ctx?.root);
    state.nightLevel = -1;

    // Create every material now, before the renderer walks the scene to cache
    // its IBL material groups. A material that first appears during an LOD
    // refresh would be built after that cache was taken and would never be
    // handed an environment map -- its glass would render unlit for the rest
    // of the session.
    for (const className of FACADE_MATERIAL_CLASS_NAMES) materialFor(className, 'structure');
    for (const role of FACADE_ARTICULATION_ROLES) {
      if (role !== 'structure') materialFor('shared', role);
    }

    // Start from the build focus. `update` re-centres on the live camera.
    const { centre, source } = resolveCentre(ctx, false);
    for (const zone of ZONES) buildZone(zone, centre);
    applyNightLevel(nightLevelFor(ctx));
    supersedeLegacyRelief(ctx?.root);
    state.diagnostics = collectDiagnostics(centre, source);
    return { object: group, diagnostics: state.diagnostics };
  },

  /**
   * Re-centre the LOD rings on the live camera. No allocation in the steady
   * state: the distance check is two subtractions per zone and returns.
   */
  update(ctx) {
    if (!state.group || !state.buildings.length) return;
    // Interior lighting follows the clock. Quantised to 1/20, so a frame that
    // does not cross a step writes nothing.
    applyNightLevel(nightLevelFor(ctx));
    const camera = ctx?.camera?.position;
    if (!camera || !Number.isFinite(camera.x) || !Number.isFinite(camera.z)) return;
    // Steady state: two subtractions and a hypot per zone, no allocation, no
    // diagnostics rebuild. Everything below only runs on a threshold crossing.
    let stale = null;
    for (const zone of ZONES) {
      const threshold = zone === 'detail'
        ? FACADE_ARTICULATION_BUDGET.detailRefreshMetres
        : FACADE_ARTICULATION_BUDGET.bulkRefreshMetres;
      const centre = state.centres.get(zone);
      if (!centre || Math.hypot(camera.x - centre.x, camera.z - centre.z) >= threshold) {
        // One zone per crossing: a single frame never pays for both.
        stale = zone;
        break;
      }
    }
    if (!stale) return;
    const previous = state.zoneBatches.get(stale);
    const { ms } = buildZone(stale, { x: camera.x, z: camera.z });
    if (previous) disposeFacadeArticulation(previous);
    state.refreshes += 1;
    state.lastRefreshMs = ms;
    const { centre, source } = resolveCentre(ctx, true);
    Object.assign(state.diagnostics, collectDiagnostics(centre, source));
  },

  dispose() {
    for (const object of state.hiddenLegacy) object.visible = true;
    state.hiddenLegacy = [];
    teardown();
    // Detail maps are shared with the renderer's own facade materials, so the
    // registry's blanket texture disposal must not reach them. Detach first.
    for (const material of state.materials.values()) {
      material.map = null;
      material.normalMap = null;
      material.roughnessMap = null;
      material.metalnessMap = null;
      material.aoMap = null;
      material.dispose?.();
    }
    state.materials.clear();
    state.litMaterials = [];
    state.nightLevel = -1;
  },

  /** Test seam: the live diagnostics without going through the registry. */
  __diagnostics() {
    return state.diagnostics;
  },
};
