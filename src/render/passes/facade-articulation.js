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
//   near   <=  85 m   <=  26 buildings   base 6000 tri/building
//   mid    <= 200 m   <=  72 buildings   base 2300 tri/building
//   far    <= 420 m   <= 300 buildings   base  820 tri/building
//   beyond            <= 900 buildings   base   48 tri/building
//
// The radius is measured to the NEAREST POINT OF THE FOOTPRINT. The centroid
// is the wrong question and round 2 shipped it: an eleven storey frontage 61 m
// from the eye, filling most of one capture card, had its centroid at 87 m and
// was therefore built at the mid ring's rung.
//
// The base cap is scaled by the greater of the building's wall area and its
// edge count, and then by SCREEN COVERAGE -- how much of the reference frame
// the elevation fills; see `articulationTriangleCap` and
// `articulationScreenCoverage`. Without that term a 160 m tower carrying
// 23,000 m2 of wall gets the same 14,400 triangles whether it is four metres
// from the eye or three hundred, which buys four glazed storeys and forty-six
// flat glazing bands: the uniform grid round 2 was rejected for.
//
// Scene ceiling is 330,000 triangles and 48 draw calls. It is held by giving
// up the coverage bonus first -- that takes triangles off the two or three
// buildings holding the most of them and leaves the rest of the city alone --
// and only then by uniform outside-in ring demotion. Measured on the real 700
// building slice from the street capture pose: 317,378 triangles, 20 draw
// calls, 0 coverage cuts, 0 demotions, 700/700 buildings articulated.
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
  preserveSurvey: null,
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
    glazedStoreys: 0,
    bandedStoreys: 0,
    glazedStoreyShare: 0,
    maxCoverage: 0,
    budget: {
      sceneTriangleBudget: FACADE_ARTICULATION_BUDGET.sceneTriangleBudget,
      maxDrawCalls: FACADE_ARTICULATION_BUDGET.maxDrawCalls,
      withinBudget: true,
      demotions: 0,
      coverageCuts: 0,
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

/**
 * This zone's share of the scene triangle budget.
 *
 * The two zones are built by separate calls, and each call enforces the budget
 * it is handed. Handing both of them the whole scene budget -- which is what
 * happened until wave C -- bounds neither the sum nor anything else: measured
 * on the real slice at the round 4 capture centre the pair came to 350,536
 * triangles against a 330,000 "ceiling", with zero coverage cuts and zero
 * demotions recorded, because neither call had any reason to cut.
 *
 * The detail zone (near + mid) takes first claim, and takes it from a STATIC
 * number so its rung assignment does not move when the background happens to
 * be busy -- a facade that changes rung because a block three hundred metres
 * away came into range is a pop. The bulk zone takes what is left, floored at
 * the background's guaranteed share. Detail is always built or refreshed with
 * the other zone's batch already in `state`, so the arithmetic is exact.
 */
function zoneTriangleBudget(zone) {
  const scene = FACADE_ARTICULATION_BUDGET.sceneTriangleBudget;
  const floor = FACADE_ARTICULATION_BUDGET.bulkTriangleFloor;
  if (zone === 'detail') return Math.max(0, scene - floor);
  const detail = state.zoneBatches.get('detail');
  return Math.max(floor, scene - (detail ? detail.triangles : 0));
}

/** Build (or rebuild) one zone's merged meshes around `centre`. */
function buildZone(zone, centre) {
  const startedAt = Date.now();
  const batch = buildFacadeArticulationBatch(state.buildings, {
    focus: centre,
    zone,
    baseYFor: state.baseYFor,
    preserveIds: state.preserveIds,
    sceneTriangleBudget: zoneTriangleBudget(zone),
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
 * Buildings whose elevation is authored somewhere else.
 *
 * Preserving a frontage means it is forced to the silhouette rung: no
 * cladding, no openings, no reveals, only a cornice and a plinth over the
 * shell's tiled wallpaper. That is the right answer for a hand-authored
 * elevation and a catastrophe for anything else, so the test for "authored"
 * has to be exact.
 *
 * Round 4 it was not. This read every id off every `buildings-hero-textured`
 * mesh, but the renderer puts a building on that mesh whenever its facade and
 * material land on one of six SHARED atlas cells -- a procedural fill, not an
 * authored elevation. Measured on the 700 building slice that is 139
 * candidates, and at the round 4 capture eye they held 64.2% of the frame's
 * screen coverage, including the 115 m building 6.4 m from the camera that
 * fills the whole hero card. All five reviewers described exactly that: "the
 * nearest and largest surface ... an articulation-free smear with no windows,
 * mullions or reveals at all". The near tier was not failing to build depth;
 * it was being told not to build any.
 *
 * Two tests, in order:
 *
 *  1. `userData.authoredBuildingIds` -- the explicit contract. If the renderer
 *     names its authored frontages, that answer is used and nothing else is.
 *     THIS IS THE FIX THE RENDERER OWNER SHOULD LAND; everything below is a
 *     bridge until it does.
 *  2. `userData.patternKeys` -- the atlas cells the merged group draws from.
 *     An authored frontage owns its cell. A group carrying more buildings than
 *     cells is sharing them, which is a procedural fill by definition, and
 *     none of its ids are preserved.
 *
 * A group that declares neither keeps the old behaviour, which is the
 * conservative direction: it preserves an authored surface it cannot identify
 * rather than cladding over one.
 */
function authoredElevations(root) {
  const ids = new Set();
  const survey = { groups: 0, candidates: 0, declared: 0, inferredAuthored: 0, sharedAtlasSkipped: 0, source: 'none' };
  if (!root?.traverse) return { ids, survey };
  root.traverse((object) => {
    if (object.userData?.kind !== 'buildings-hero-textured') return;
    const buildingIds = Array.isArray(object.userData.buildingIds) ? object.userData.buildingIds : [];
    survey.groups += 1;
    survey.candidates += buildingIds.length;

    // 1. The declared contract. If the renderer names its authored frontages,
    //    that answer is authoritative and nothing else is consulted.
    const declared = Array.isArray(object.userData.authoredBuildingIds)
      ? object.userData.authoredBuildingIds
      : null;
    if (declared) {
      for (const id of declared) ids.add(id);
      survey.declared += declared.length;
      survey.source = survey.source === 'inferred' ? 'mixed' : 'declared';
      return;
    }

    // 2. The atlas-cell test. `patternKeys` is the set of atlas cells this
    //    merged group draws from. A hand-authored frontage owns its cell; a
    //    procedurally atlassed one shares a handful of cells across many
    //    buildings, and a group carrying more buildings than cells is
    //    therefore a procedural fill whatever its mesh is called.
    const patternKeys = Array.isArray(object.userData.patternKeys) ? object.userData.patternKeys : null;
    if (patternKeys && buildingIds.length > patternKeys.length) {
      survey.sharedAtlasSkipped += buildingIds.length;
      return;
    }
    for (const id of buildingIds) ids.add(id);
    survey.inferredAuthored += buildingIds.length;
    if (buildingIds.length) survey.source = survey.source === 'declared' ? 'mixed' : 'inferred';
  });
  return { ids, survey };
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
  let coverageCuts = 0;
  let glazedStoreys = 0;
  let bandedStoreys = 0;
  let maxCoverage = 0;
  for (const batch of batches) {
    triangles += batch.triangles;
    drawCalls += batch.drawCalls;
    openings += batch.openings;
    bands += batch.bands;
    articulated += batch.articulated;
    demotions = Math.max(demotions, batch.demotions);
    coverageCuts = Math.max(coverageCuts, batch.coverageCuts || 0);
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
    for (const record of batch.buildings) {
      signatures.add(record.signature);
      glazedStoreys += record.glazedStoreys || 0;
      bandedStoreys += record.bandedStoreys || 0;
      maxCoverage = Math.max(maxCoverage, record.coverage || 0);
    }
  }
  const budget = FACADE_ARTICULATION_BUDGET;
  const zoneTriangles = {
    detail: detail ? detail.triangles : 0,
    bulk: bulk ? bulk.triangles : 0,
  };
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
    // The number the round 2 review was really about: how much of the elevation
    // is built as individual openings rather than one flat glazing band per
    // storey. A clad ring with a starved opening budget reads as a printed
    // grid, and only this ratio says so.
    glazedStoreys,
    bandedStoreys,
    glazedStoreyShare: glazedStoreys + bandedStoreys > 0
      ? glazedStoreys / (glazedStoreys + bandedStoreys)
      : 0,
    maxCoverage,
    rings,
    features,
    parts,
    classes,
    rejected,
    rejectedByReason,
    partyEdges,
    preservedAuthored,
    authoredElevations: state.preserveIds.size,
    // How that number was reached. `candidates` is every id published on a
    // `buildings-hero-textured` mesh; `sharedAtlasSkipped` is the ones that
    // turned out to be a procedural atlas fill and are now clad normally.
    preserve: state.preserveSurvey || { groups: 0, candidates: 0, declared: 0, inferredAuthored: 0, sharedAtlasSkipped: 0, source: 'none' },
    signatures: {
      total: articulated,
      unique: signatures.size,
      uniqueRatio: articulated ? signatures.size / articulated : 1,
      neighbourCollisions: collisions,
      resignatured,
    },
    budget: {
      sceneTriangleBudget: budget.sceneTriangleBudget,
      bulkTriangleFloor: budget.bulkTriangleFloor,
      // What each zone was actually allowed, and what it spent. The sum is
      // bounded by `sceneTriangleBudget` by construction; these are here so a
      // reader can see WHICH zone is close to its share rather than only that
      // the total fits.
      zoneBudgets: { detail: Math.max(0, budget.sceneTriangleBudget - budget.bulkTriangleFloor), bulk: zoneTriangles.bulk ? Math.max(budget.bulkTriangleFloor, budget.sceneTriangleBudget - zoneTriangles.detail) : 0 },
      zoneTriangles,
      maxDrawCalls: budget.maxDrawCalls,
      withinBudget: triangles <= budget.sceneTriangleBudget && drawCalls <= budget.maxDrawCalls,
      demotions,
      // Steps of the screen-coverage bonus this frame had to hand back before
      // it fit. This is given up before any ring is demoted.
      coverageCuts,
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
  state.preserveSurvey = null;
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

    const authored = authoredElevations(ctx?.root);
    state.preserveIds = authored.ids;
    state.preserveSurvey = authored.survey;
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
