import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mulberry32, ringArea, pointInPolygon, polygonBounds, terrainHeight, clamp, hashString } from './core.js';
import {
  createEnvironmentRig,
  classifyMaterialClass,
  envMapIntensityFor,
  computeSunShadowCamera,
  applySunShadowFit,
  keyFillBalance,
  recommendedExposure,
  wetSurfaceGrade,
  nightPracticalProfile,
  blackBodyColor,
  SHADOW_FIT_DEFAULTS,
  SHADOW_TEXEL_DENSITY_RANGE,
} from '../render/environment-ibl.js';
import {
  applyDetailMaps,
  applyRendererCapabilities,
  preloadDetailMaps,
  disposeAllDetailMaps,
  detailMapCacheStats,
  uvScalePerMetre,
} from '../render/detail-maps.js';
import {
  buildFacadeDepthBatch,
  FACADE_DEPTH_UV_METRES,
  FACADE_DEPTH_BUDGET,
  FACADE_DEPTH_SCREEN,
  FACADE_DEPTH_MIN_TIER,
  facadeDetailTierDistances,
} from '../world/buildings/facade-depth.js';
import { buildStreetSurfaceV2, STREET_SURFACE_V2_DEFAULTS } from '../world/streets/street-surface-v2.js';
import { buildGroundCoverage, disposeGroundCoverage } from '../world/ground-coverage.js';
import {
  createShadowCasterPolicy,
  createShadowCasterAudit,
  measureShadowCaster,
  summariseShadowCasterAudit,
  recommendShadowBias,
  SHADOW_ROLES,
  SHADOW_CASTER_VERSION,
  MEASURED_TEXEL_WORLD_SIZE,
  MEASURED_RING_RADIUS,
} from '../render/shadow-casters.js';
import {
  createCrowdPresentation,
  PEDESTRIAN_PRESENTATION_VERSION,
} from '../simulation/pedestrians/pedestrian-presentation.js';
import { createPassRuntime } from '../render/pass-registry.js';
import { PASSES } from '../render/passes/index.js';

const PALETTES = Object.freeze({
  painted: ['#c96b66', '#5f93a2', '#d4ad61', '#7486a8', '#c88455', '#89a876', '#b87892'],
  plaster: ['#f7d3ae', '#eda987', '#ffe0bd', '#e9b28f', '#f6d2a1'],
  brick: ['#e0925f', '#d96f4c', '#efa373', '#c05a3f', '#e2845a'],
  concrete: ['#e2ded2', '#cfc9ba', '#f1ece0', '#d8d3c4', '#e7e2d5'],
  clapboard: ['#9fc8e8', '#e8b98a', '#b5dca5', '#efb6c8', '#a9c4e8'],
  glass: ['#7fa7bd', '#6d98ad', '#a7c4cf', '#8eb2bf', '#789eae', '#9dbbc5', '#88aab8', '#b89a70', '#a88762', '#7ca99c'],
  // Bronze and sea-glass tower variants break the single-hue blue wall on
  // real-map slices while staying inside the soft low-poly grade.
  stone: ['#ddd4be', '#ccc0a8', '#e8dfca', '#d4c8b0', '#e0d6c2'],
});

const FACADE_STYLES = ['edwardian', 'modern-grid', 'bay-window', 'shopfront', 'loft', 'art-deco'];

function landmarkKind(building) {
  const name = String(building.name || '').toLowerCase();
  const tags = `${name} ${String(building.tourism || '')} ${String(building.amenity || '')}`.toLowerCase();
  if (tags.includes('transamerica')) return 'transamerica';
  if (tags.includes('coit') || tags.includes('telegraph hill')) return 'coit';
  if (tags.includes('ferry building') || tags.includes('ferry terminal')) return 'ferry';
  if (tags.includes('salesforce')) return 'salesforce';
  if (tags.includes('city hall') || tags.includes('civic center')) return 'city-hall';
  if (tags.includes('palace of fine arts')) return 'palace';
  if (tags.includes('mission dolores') || tags.includes('dolores basilica')) return 'mission-dolores';
  if (tags.includes('grace cathedral')) return 'cathedral';
  if (tags.includes('sfmoma')) return 'sfmoma';
  if (tags.includes('warfield')) return 'warfield';
  if (tags.includes('yerba buena')) return 'yerba';
  return null;
}

const BUILDING_UV_METRES_X = 12;
const BUILDING_UV_METRES_Y = 4.6;
const BUILDING_FOOTPRINT_EPSILON = 1e-4;
const HERO_FACADE_ATLAS_URL = '/assets/sf-market-kearny-hero-atlas-v1.png';
const HERO_FACADE_ATLAS_RESOLUTION = 1254;
const HERO_ROOF_CAP_STYLES = Object.freeze([
  { sampleU: 0.1, sampleV: 0.24, color: '#a89b85' },
  { sampleU: 0.08, sampleV: 0.28, color: '#52636b' },
  { sampleU: 0.12, sampleV: 0.25, color: '#b9b09e' },
  { sampleU: 0.16, sampleV: 0.28, color: '#aaa394' },
  { sampleU: 0.12, sampleV: 0.28, color: '#815e50' },
  { sampleU: 0.12, sampleV: 0.3, color: '#76584f' },
]);
const HERO_FACADE_IDS = Object.freeze(new Map([
  ['sf-building-132127809', { cell: 0, pattern: 'hearst-stone' }],
  ['sf-building-151183777', { cell: 1, pattern: 'market-bronze-glass' }],
  ['sf-building-132127810', { cell: 2, pattern: 'central-art-deco' }],
  ['sf-building-149335987', { cell: 3, pattern: 'market-limestone-grid' }],
  ['sf-building-149335979', { cell: 4, pattern: 'kearny-brick-stone' }],
  ['sf-building-149335988', { cell: 5, pattern: 'market-industrial-loft' }],
]));
const HERO_STREETWALL_PASS = 'hero-streetwall-grounding-v1';
const HERO_STREETWALL_CONTACT_TREATMENT = 'recessed-portal-reveal-v1';
const HERO_SIDEWALK_LIFE_PASS = 'hero-sidewalk-life-v5';
const GROUND_MATERIAL_PASS = 'sf-ground-materials-v1';
const GROUND_MATERIAL_ASSETS = Object.freeze({
  asphalt: Object.freeze({
    url: `${import.meta.env.BASE_URL}assets/sf-asphalt-surface-albedo-v1.png`,
    width: 1254,
    height: 1254,
    metersPerRepeat: 4,
    bumpScale: 0.032,
  }),
  sidewalk: Object.freeze({
    url: `${import.meta.env.BASE_URL}assets/sf-sidewalk-concrete-albedo-v1.png`,
    width: 1254,
    height: 1254,
    metersPerRepeat: 2.6,
    bumpScale: 0.018,
  }),
});
const GROUND_MATERIAL_ANISOTROPY = 8;

// --- Presentation upgrade passes --------------------------------------------
// Procedural detail maps are baked once at load and shared by every mesh that
// uses a surface class. 256 px per tile keeps the whole bake under half a
// second while still resolving above one texel per centimetre at the tile
// sizes these classes declare.
const DETAIL_MAP_PASS = 'detail-maps-v1';
const DETAIL_MAP_OPTIONS = Object.freeze({ resolution: 256 });
const DETAIL_MAP_CLASSES = Object.freeze([
  'brick', 'stucco', 'painted-concrete', 'glass-curtain', 'asphalt', 'sidewalk-concrete',
]);
// Building albedo already paints windows, courses and shadows at its own
// frequency, so a structured detail map on top of it would fight the painting.
// Textured facades therefore only take the fine plaster grain, while the
// untextured vertex-colour groups (which have no albedo at all) take the full
// class-specific relief.
const FACADE_DETAIL_BY_MATERIAL = Object.freeze({
  brick: 'brick',
  stone: 'painted-concrete',
  concrete: 'painted-concrete',
  plaster: 'stucco',
  painted: 'stucco',
  clapboard: 'stucco',
  glass: 'glass-curtain',
});
const TEXTURED_FACADE_DETAIL_CLASS = 'stucco';
// Mean of each class's baked roughness channel, measured from the module's own
// field. three multiplies `material.roughness` by the map, so a call site can
// keep its authored roughness and still gain per-texel variation.
const DETAIL_ROUGHNESS_MEAN = Object.freeze({
  brick: 0.816,
  stucco: 0.882,
  'painted-concrete': 0.685,
  'glass-curtain': 0.115,
  asphalt: 0.925,
  'sidewalk-concrete': 0.875,
  'dirty-metal': 0.415,
});
// Additive facade relief. The module caps itself per building and per scene;
// this is the scene allowance the renderer grants it.
const FACADE_DEPTH_PASS = 'facade-depth-1';
// Owned by the module, not re-typed here: the batch enforces this ceiling by
// lowering one global tier and then cutting whole distance rings, so the two
// numbers must never be allowed to drift apart.
const FACADE_DEPTH_SCENE_BUDGET = FACADE_DEPTH_BUDGET.sceneTriangleBudget;
const FACADE_DEPTH_SURFACES = Object.freeze({
  edwardian: Object.freeze({ detail: 'painted-concrete', color: '#e7ddcd' }),
  'modern-grid': Object.freeze({ detail: 'painted-concrete', color: '#d6d2c8' }),
  'bay-window': Object.freeze({ detail: 'painted-concrete', color: '#efe4d3' }),
  shopfront: Object.freeze({ detail: 'painted-concrete', color: '#dcd5c6' }),
  loft: Object.freeze({ detail: 'brick', color: '#c78a63' }),
  'art-deco': Object.freeze({ detail: 'stucco', color: '#e2d8c5' }),
});
const FACADE_DEPTH_GLASS = Object.freeze({ color: '#3f5a68', roughness: 0.16, metalness: 0.42 });
// Two vertical planes are pinned by subsystems this pass does not own, and the
// curb has to be built between them:
//
//   carriageway datum  = terrain + city.meta.streetDesign.roadLift
//       Curbside cars are placed on exactly this plane and the parked-car
//       partition contract re-derives it from source to within 2e-5 m.
//   footway surface    = carriageway datum + 0.045
//       Street lamps, sidewalk props and the hero bench are grounded here, and
//       the traffic simulation seats its hero actors on the same offset.
//
// So the exposed curb face is whatever fits: 45 mm above the datum plus the
// depth of the gutter pan cut below it. That is a real curb with a real gutter
// rather than the flat ribbon it replaces, but it is 77 mm, not the module's
// designed 150 mm. Raising it further means re-basing the footway offset in the
// traffic simulation and in the prop placements at the same time.
const LEGACY_SIDEWALK_LIFT = 0.045;
const STREET_GUTTER_DEPTH = 0.04;
const STREET_SURFACE_PASS = 'street-surface-v2';

/** Empty facade-relief diagnostics, so every reset path has the same shape. */
function createFacadeDepthDiagnostics() {
  return {
    pass: FACADE_DEPTH_PASS,
    drawCalls: 0,
    triangles: 0,
    buildings: 0,
    skipped: 0,
    styles: [],
    screen: null,
    tierDistances: null,
    tiers: null,
    requestedTiers: null,
    tierCeiling: null,
    ringCutDistance: null,
    sceneTriangleBudget: FACADE_DEPTH_SCENE_BUDGET,
  };
}

// A pedestrian that moves further than this in one step was re-seated by the
// simulation's local-life recycler, not walking. Two metres is well above the
// 2.2 m/s cruise at any plausible frame time and well below a block.
const CROWD_TELEPORT_METRES = 2;

const GROUND_COVERAGE_PASS = 'ground-coverage-v1';

// --- sun shadow fit ---------------------------------------------------------
//
// The shipped rig used a fixed +/-420 m orthographic box aimed at the world
// origin. On the two-kilometre real-map slice the player stands a kilometre or
// more from that origin, so every shadow texel landed outside the view: the map
// was enabled, had casters, and drew nothing anyone could see.
//
// `computeSunShadowCamera` fits the box to the visible slice of the view
// frustum instead (minimal bounding sphere, square box, centre snapped to whole
// texels). Its `texelsPerMetre` then depends only on `SUN_SHADOW_DISTANCE` and
// the map size, so the density is a number we can log once and reason about,
// and it does not swing with the time of day or with which way the player is
// facing.
const SUN_SHADOW_PASS = 'sun-shadow-fit-1';
const SUN_SHADOW_MAP_SIZE = 2048;
// 220 m of view depth at 2048 -> 5.21 texels/m (19.2 cm texels), inside the
// module's declared 2.5-12 texels/m band. Beyond this ring the city is carried
// by fog and by the environment dome, not by the shadow map.
const SUN_SHADOW_DISTANCE = SHADOW_FIT_DEFAULTS.shadowDistance;
// Fallback when the city has not declared its own tallest caster yet.
const SUN_SHADOW_DEFAULT_CASTER_HEIGHT = SHADOW_FIT_DEFAULTS.maxCasterHeight;
// The night key is not the sun. Below the horizon the solar direction would
// light the city from underneath, so the key is reflected to the anti-solar
// azimuth and lifted to a fixed altitude, which is where a full moon sits. It
// keeps the deterministic 0.3 intensity floor the day/night curve already
// applies, and `computeSunShadowCamera` still reports `castShadow` from the
// direction it is handed, so the night frame keeps soft moon shadows instead of
// the flat unshadowed pool it has now.
const NIGHT_KEY_ALTITUDE_DEG = 52;
// Refit only when something the fit actually reads has moved. Half a texel of
// camera travel is the point at which the snapped centre can step.
const SUN_SHADOW_REFIT_EPSILON = 0.05;

/** Detail-map `repeat` for UVs measured in tiles of `metresX` x `metresY`. */
function detailRepeatForUvTile(className, metresX, metresY) {
  const scale = uvScalePerMetre(className);
  return { x: metresX * scale.x, y: metresY * scale.y };
}

/** Surface class for a building shell that carries no albedo texture. */
function facadeDetailClass(materialKey) {
  return FACADE_DETAIL_BY_MATERIAL[materialKey] || 'stucco';
}

/** `material.roughness` that reproduces `target` through a class's ORM map. */
function detailRoughnessScale(className, target) {
  const mean = DETAIL_ROUGHNESS_MEAN[className] || 1;
  return clamp(target / mean, 0, 1);
}
const BISTRO_PARTITION_PASS = 'sf-world-partition-bistro-v1';
const BISTRO_PARTITION_CELL_SIZE = 140;
const BISTRO_PARTITION_ENTER_RADIUS = 420;
const BISTRO_PARTITION_EXIT_RADIUS = 520;
const BISTRO_PARTITION_AERIAL_HEIGHT = 500;
const BISTRO_PARTITION_UPDATE_INTERVAL = 8;
const PORTAL_PARTITION_PASS = 'sf-world-partition-portals-v1';
const PORTAL_PARTITION_CELL_SIZE = 140;
const PORTAL_PARTITION_ENTER_RADIUS = 420;
const PORTAL_PARTITION_EXIT_RADIUS = 520;
const PORTAL_PARTITION_AERIAL_HEIGHT = 500;
const PORTAL_PARTITION_UPDATE_INTERVAL = 8;
const PARKED_CAR_PARTITION_PASS = 'sf-world-partition-parked-cars-v1';
const PARKED_CAR_PARTITION_CELL_SIZE = 140;
const PARKED_CAR_PARTITION_ENTER_RADIUS = 420;
const PARKED_CAR_PARTITION_EXIT_RADIUS = 520;
const PARKED_CAR_PARTITION_AERIAL_HEIGHT = 500;
const PARKED_CAR_PARTITION_UPDATE_INTERVAL = 8;
const PARKED_CAR_DETAIL_PASS = 'sf-parked-car-wheel-depth-v2';
const PARKED_CAR_PALETTE = Object.freeze([
  0x7d4d4c,
  0x9a7a3e,
  0x46647a,
  0x4f7168,
  0x62586c,
  0x805c45,
  0xd7d3c8,
  0x718164,
]);
const PARKED_CAR_GLASS_PALETTE = Object.freeze([0x516a73, 0x47636c, 0x5c747b]);
const HERO_SIDEWALK_DONOR_RADIUS = 80;
const HERO_CURB_RHYTHM = Object.freeze({
  id: 'market-street-curb-rhythm',
  segmentId: 'sf-seg-308',
  streetId: 'sf-street-228196396',
  side: 1,
  t: Object.freeze([0.34, 0.39, 0.47, 0.63, 0.7, 0.75, 0.84]),
  kinds: Object.freeze(['planter', 'sign', 'cone', 'bench', 'hydrant', 'planter', 'cone']),
  presentationKinds: Object.freeze(['trash-can', 'sign', 'bike-rack', 'bench', 'hydrant', 'newspaper-box', 'cone']),
  lateralOffsets: Object.freeze([4.1, 3.96, 4.15, 4.38, 3.9, 4.1, 3.84]),
  presentationScales: Object.freeze([1, 1.15, 1, 1, 1.15, 1, 1.1]),
  rotationOffsets: Object.freeze([0.18, -Math.PI / 2, -Math.PI / 2, -Math.PI / 2, 0.12, -Math.PI / 2, -0.34]),
  clusters: Object.freeze(['entrance', 'entrance', 'entrance', 'intersection', 'intersection', 'intersection', 'intersection']),
});
const HERO_CURB_PRESENTATION_PROFILES = Object.freeze({
  'trash-can': Object.freeze({ collisionRadius: 0.46, halfExtents: Object.freeze({ x: 0.32, z: 0.32 }), circular: true }),
  'bike-rack': Object.freeze({ collisionRadius: 0.6, halfExtents: Object.freeze({ x: 0.54, z: 0.12 }), circular: false }),
  'newspaper-box': Object.freeze({ collisionRadius: 0.42, halfExtents: Object.freeze({ x: 0.28, z: 0.23 }), circular: false }),
  'pay-station': Object.freeze({ collisionRadius: 0.3, halfExtents: Object.freeze({ x: 0.22, z: 0.15 }), circular: false }),
});
const HERO_CURB_PRESENTATION_RESOURCES = Object.freeze({
  logicalProps: 0,
  drawGroups: 4,
  triangles: 520,
  geometries: 4,
  materials: 0,
  textures: 0,
  gpuInstances: 5,
  hiddenBaseInstances: 22,
  visibleAccentInstances: 5,
});
const HERO_CORRIDOR_PRESENTATION_RESOURCES = Object.freeze({
  logicalProps: 0,
  drawGroups: 3,
  triangles: 308,
  geometries: 3,
  materials: 0,
  textures: 0,
  gpuInstances: 3,
  hiddenBaseInstances: 12,
  visibleAccentInstances: 3,
});
const HERO_FRONTAGE_PRESENTATION_RESOURCES = Object.freeze({
  logicalProps: 0,
  drawGroups: 1,
  triangles: 212,
  geometries: 1,
  materials: 0,
  textures: 0,
  gpuInstances: 2,
  hiddenBaseInstances: 10,
  visibleAccentInstances: 2,
});
const HERO_FRONTAGE_PRESENTATION_OVERRIDES = Object.freeze(new Map([
  ['sf-building-149335979:planter-left', Object.freeze({
    id: 'market-pay-station-north',
    presentationKind: 'pay-station',
  })],
  ['sf-building-149335987:planter-right', Object.freeze({
    id: 'market-trash-can-south',
    presentationKind: 'trash-can',
  })],
]));
const HERO_SIDEWALK_ROLES = Object.freeze(new Map([
  ['sf-building-132127809', ['planter-left', 'planter-right', 'bench', 'sign']],
  ['sf-building-151183777', ['planter-left', 'planter-right', 'bench', 'hydrant']],
  ['sf-building-132127810', ['planter-left', 'planter-right', 'bench', 'sign']],
  ['sf-building-149335987', ['planter-left', 'planter-right', 'bench', 'hydrant']],
  ['sf-building-149335979', ['planter-left', 'planter-right', 'sign']],
  ['sf-building-149335988', ['planter-left', 'planter-right', 'sign', 'hydrant']],
]));
const HERO_BASE_COLORS = Object.freeze([
  '#756d61',
  '#33454d',
  '#827c70',
  '#7c776d',
  '#604a43',
  '#523f3a',
]);
const HERO_ROOF_PROFILES = Object.freeze(new Map([
  ['sf-building-132127809', {
    profile: 'hearst-stepped-penthouse', depth: 0.48, height: 0.95, color: '#8b7766',
    boxes: [{ w: 8, d: 5, h: 1.8 }, { w: 5, d: 3, h: 1.2, stack: true }],
  }],
  ['sf-building-151183777', {
    profile: 'market-metal-core', depth: 0.28, height: 0.45, color: '#38434a',
    boxes: [{ w: 3, d: 2, h: 1.5 }],
  }],
  ['sf-building-132127810', {
    profile: 'central-art-deco-crown', depth: 0.45, height: 1.1, color: '#b7aa91',
    boxes: [{ w: 8, d: 8, h: 2.2 }, { w: 5.5, d: 5.5, h: 1.8, stack: true }, { w: 3, d: 3, h: 1.4, stack: true }],
  }],
  ['sf-building-149335987', {
    profile: 'market-limestone-services', depth: 0.35, height: 0.65, color: '#a79d8b',
    boxes: [{ w: 7, d: 4, h: 1.6, dx: -1.2 }, { w: 2, d: 2, h: 1.2, dx: 3.2 }],
  }],
  ['sf-building-149335979', {
    profile: 'kearny-brick-stairhead', depth: 0.4, height: 0.8, color: '#765246',
    boxes: [{ w: 5, d: 3, h: 1.5 }, { w: 3, d: 2, h: 1.2, dx: 3.1 }],
  }],
  ['sf-building-149335988', {
    profile: 'market-loft-mechanical-row', depth: 0.35, height: 0.55, color: '#69514a',
    boxes: [
      { w: 8, d: 4, h: 1.2, dx: -8 },
      { w: 8, d: 4, h: 1.2 },
      { w: 8, d: 4, h: 1.2, dx: 8 },
    ],
  }],
]));

function createHeroStreetwallDiagnostics() {
  return {
    schemaVersion: 1,
    pass: HERO_STREETWALL_PASS,
    expectedIds: [...HERO_FACADE_IDS.keys()].sort(),
    treatedIds: [],
    portalStyledIds: [],
    wallEdges: 0,
    wallVertices: 0,
    contactTreatment: HERO_STREETWALL_CONTACT_TREATMENT,
    facadeNeutralVertices: 0,
    finite: false,
    sourceFootprintsUnchanged: false,
    sourcePortalsUnchanged: false,
    portalPositionsUnchanged: false,
    portalHeadingsUnchanged: false,
    portalPanelInstances: 0,
    portalFrameInstances: 0,
    portalCueInstances: 0,
    incremental: {
      drawGroups: 0,
      triangles: 0,
      geometries: 0,
      textures: 0,
      instances: 0,
    },
  };
}

function createHeroSidewalkDiagnostics(logicalProps = 0) {
  return {
    schemaVersion: 5,
    pass: HERO_SIDEWALK_LIFE_PASS,
    expectedIds: [...HERO_FACADE_IDS.keys()].sort(),
    treatedIds: [],
    donorRecords: 0,
    logicalPropsBefore: logicalProps,
    logicalPropsAfter: logicalProps,
    roles: { planter: 0, bench: 0, sign: 0, hydrant: 0, cone: 0 },
    entries: [],
    corridor: null,
    donorSelection: null,
    frontagePresentationOverrides: [],
    frontagePresentationResources: null,
    frontagePresentationTopologies: [],
    asphaltOverlaps: 0,
    absoluteAsphaltOverlaps: 0,
    additionalAsphaltIntrusions: 0,
    buildingOverlaps: 0,
    portalCorridorIntrusions: 0,
    sourceFootprintsUnchanged: false,
    sourcePortalsUnchanged: false,
    finite: false,
    incremental: {
      instances: 0,
      drawGroups: 0,
      triangles: 0,
      geometries: 0,
      materials: 0,
      textures: 0,
    },
  };
}

function createGroundMaterialDiagnostics(lifecycle = {}, enabled = false) {
  return {
    schemaVersion: 1,
    pass: GROUND_MATERIAL_PASS,
    enabled: false,
    failure: null,
    assets: Object.fromEntries(Object.entries(GROUND_MATERIAL_ASSETS).map(([key, asset]) => [key, {
      url: asset.url,
      width: asset.width,
      height: asset.height,
      actualWidth: null,
      actualHeight: null,
      loaded: false,
    }])),
    worldUvScale: {
      axis: 'world-xz',
      asphaltMetersPerRepeat: GROUND_MATERIAL_ASSETS.asphalt.metersPerRepeat,
      sidewalkMetersPerRepeat: GROUND_MATERIAL_ASSETS.sidewalk.metersPerRepeat,
    },
    uvAttributes: {
      count: 0,
      finite: false,
      asphalt: null,
      sidewalk: null,
    },
    materialBindings: {
      anisotropy: GROUND_MATERIAL_ANISOTROPY,
      asphalt: { mapEqualsBumpMap: false, bumpScale: GROUND_MATERIAL_ASSETS.asphalt.bumpScale },
      sidewalk: { mapEqualsBumpMap: false, bumpScale: GROUND_MATERIAL_ASSETS.sidewalk.bumpScale },
    },
    resourceDelta: {
      drawGroups: 0,
      triangles: 0,
      geometries: 0,
      materials: 0,
      textures: enabled ? 2 : 0,
      uvAttributes: enabled ? 2 : 0,
    },
    source: {
      segmentCount: 0,
      checksumBefore: null,
      checksumAfter: null,
      unchanged: false,
    },
    lifecycle: { ...lifecycle },
  };
}

function createWorldPartitionDiagnostics() {
  return {
    schemaVersion: 1,
    pass: BISTRO_PARTITION_PASS,
    enabled: false,
    failure: null,
    focusSource: 'controls-target',
    cellSizeMeters: BISTRO_PARTITION_CELL_SIZE,
    source: {
      instances: 0,
      triangles: 0,
      trianglesPerInstance: 0,
      recordsChecksum: null,
      recordsUnchanged: false,
      inputChecksumBefore: null,
      inputChecksumAfter: null,
      unchanged: false,
    },
    cells: { total: 0, active: 0, ids: [] },
    active: { instances: 0, hiddenInstances: 0, indices: [], aerial: false },
    hysteresis: {
      enterRadiusMeters: BISTRO_PARTITION_ENTER_RADIUS,
      exitRadiusMeters: BISTRO_PARTITION_EXIT_RADIUS,
      aerialHeightMeters: BISTRO_PARTITION_AERIAL_HEIGHT,
      updateIntervalFrames: BISTRO_PARTITION_UPDATE_INTERVAL,
      enters: 0,
      exits: 0,
    },
    mesh: {
      name: 'sf-partitioned-bistro-lights',
      capacity: 0,
      count: 0,
      submittedTriangles: 0,
      oneMesh: false,
      matricesFinite: false,
      colorsFinite: false,
    },
    updates: { checks: 0, compactions: 0, resets: 0 },
    resources: {
      drawGroups: 0,
      geometries: 0,
      materials: 0,
      textures: 0,
    },
  };
}

function createPortalPartitionDiagnostics() {
  return {
    schemaVersion: 1,
    pass: PORTAL_PARTITION_PASS,
    enabled: false,
    failure: null,
    focusSource: 'controls-target',
    source: {
      portals: 0,
      cells: 0,
      genericTriangles: 0,
      trianglesPerPortal: 60,
      recordsChecksum: null,
      recordsUnchanged: false,
      inputChecksumBefore: null,
      inputChecksumAfter: null,
      unchanged: false,
    },
    policy: {
      cellSizeMeters: PORTAL_PARTITION_CELL_SIZE,
      enterRadiusMeters: PORTAL_PARTITION_ENTER_RADIUS,
      exitRadiusMeters: PORTAL_PARTITION_EXIT_RADIUS,
      aerialHeightMeters: PORTAL_PARTITION_AERIAL_HEIGHT,
      updateIntervalFrames: PORTAL_PARTITION_UPDATE_INTERVAL,
    },
    cells: { total: 0, active: 0, ids: [] },
    active: {
      portals: 0,
      hiddenPortals: 0,
      indices: [],
      pinnedHeroIds: [],
      aerial: false,
    },
    batches: {
      panels: { name: 'building-portal-panels', capacity: 0, count: 0, submittedTriangles: 0 },
      frames: { name: 'building-portal-frames', capacity: 0, count: 0, submittedTriangles: 0 },
      lights: { name: 'building-portal-lights', capacity: 0, count: 0, submittedTriangles: 0 },
    },
    submittedTriangles: 0,
    hysteresis: { enters: 0, exits: 0 },
    updates: { checks: 0, compactions: 0, resets: 0 },
    lifecycle: { registrations: 0, disposals: 0 },
    resources: { drawGroups: 0, geometries: 0, materials: 0, textures: 0 },
  };
}

function createParkedCarPartitionDiagnostics() {
  return {
    schemaVersion: 3,
    pass: PARKED_CAR_PARTITION_PASS,
    enabled: false,
    failure: null,
    focusSource: 'controls-target',
    sourceGenerator: null,
    validationMode: null,
    expectedGolden: { enabled: false, spots: null, cells: null },
    source: {
      spots: 0,
      cells: 0,
      bodyTrianglesPerSpot: 156,
      cabTrianglesPerSpot: 20,
      trianglesPerSpot: 176,
      totalTriangles: 0,
      recordsChecksum: null,
      recordsUnchanged: false,
      inputChecksumBefore: null,
      inputChecksumAfter: null,
      unchanged: false,
      roadYSource: 'terrain.heightAt+roadLift',
      roadLiftMeters: 0,
      roadYExcludedFromRecordsChecksum: true,
    },
    policy: {
      cellSizeMeters: PARKED_CAR_PARTITION_CELL_SIZE,
      enterRadiusMeters: PARKED_CAR_PARTITION_ENTER_RADIUS,
      exitRadiusMeters: PARKED_CAR_PARTITION_EXIT_RADIUS,
      aerialHeightMeters: PARKED_CAR_PARTITION_AERIAL_HEIGHT,
      updateIntervalFrames: PARKED_CAR_PARTITION_UPDATE_INTERVAL,
    },
    cells: { total: 0, active: 0, ids: [] },
    active: { spots: 0, hiddenSpots: 0, indices: [], aerial: false, forceAll: false },
    batches: {
      bodies: {
        name: 'sf-partitioned-parked-car-bodies',
        capacity: 0,
        count: 0,
        submittedTriangles: 0,
        matricesFinite: false,
        colorsFinite: false,
      },
      cabs: {
        name: 'sf-partitioned-parked-car-cabs',
        capacity: 0,
        count: 0,
        submittedTriangles: 0,
        matricesFinite: false,
        colorsFinite: false,
      },
    },
    topology: {
      body: {
        vertexCount: 468,
        indexCount: 0,
        triangleCount: 156,
        indexed: false,
        finiteTriangleAreas: false,
        minTriangleArea: 0,
        minOutwardNormalDot: 0,
        vertexColors: true,
        roles: { paintHull: 20, wheelSideDiscs: 64, wheelTreads: 64, lamps: 8 },
        triangleRanges: {
          paintHull: { start: 0, count: 20 },
          wheelSideDiscs: { start: 20, count: 64 },
          wheelTreads: { start: 84, count: 64 },
          lamps: { start: 148, count: 8 },
        },
        vertexRanges: {
          paintHull: { start: 0, count: 60 },
          wheelSideDiscs: { start: 60, count: 192 },
          wheelTreads: { start: 252, count: 192 },
          lamps: { start: 444, count: 24 },
        },
        wheels: {
          count: 4,
          facesPerWheel: 2,
          segmentsPerFace: 8,
          triangleCount: 64,
          treadSegmentsPerWheel: 8,
          treadTrianglesPerWheel: 16,
          treadTriangleCount: 64,
          totalTriangleCount: 128,
          minOutwardNormalDot: 0,
          minTreadOutwardNormalDot: 0,
          outerFacePaintModulatedHubHighlight: true,
          colors: {
            composition: 'raw-geometry-tone-times-instance-paint-linear',
            rawGeometryTones: {
              paintModulatedHubHighlight: [1.18, 1.25, 1.3],
              outerFaceRadial: [0.18, 0.18, 0.19],
              innerFace: [0.12, 0.12, 0.13],
              tread: [0.1, 0.1, 0.11],
            },
            effectivePaletteProducts: [],
            productBounds: [0, 1],
            productsFinite: false,
            productsBounded: false,
            vertexColorSpace: 'linear-srgb',
            emissive: false,
          },
          contact: {
            normalizedLowestY: 0,
            bodyScaleYMeters: 0.58,
            bodyCenterAboveRoadMeters: 0.32,
            toleranceMeters: 0.000001,
            roadYSource: 'terrain.heightAt+roadLift',
            roadLiftMeters: 0,
            roadYExcludedFromRecordsChecksum: true,
            sourceSpotsChecked: 0,
            sourceRoadYFinite: false,
            minSourceRoadYMeters: 0,
            maxSourceRoadYMeters: 0,
            finite: false,
            minClearanceMeters: 0,
            maxClearanceMeters: 0,
            maxAbsClearanceMeters: 0,
            allOnRoadPlane: false,
          },
        },
      },
      cab: {
        vertexCount: 60,
        indexCount: 0,
        triangleCount: 20,
        indexed: false,
        finiteTriangleAreas: false,
        minTriangleArea: 0,
        minOutwardNormalDot: 0,
        vertexColors: true,
        roles: { sideWindows: 8, rearWindow: 2, roof: 2, windshield: 2, lowerSills: 6 },
      },
      cabVerticalOffsetMeters: 0.46,
      cabLongitudinalOffsetMeters: -0.18,
      distinctBodyCabMatrices: true,
    },
    visual: {
      pass: PARKED_CAR_DETAIL_PASS,
      bodyPalette: PARKED_CAR_PALETTE.map((value) => `#${value.toString(16).padStart(6, '0')}`),
      glassPalette: PARKED_CAR_GLASS_PALETTE.map((value) => `#${value.toString(16).padStart(6, '0')}`),
      hardEdgedHull: true,
      darkGlass: true,
      wheelCount: 4,
      wheelFacesPerWheel: 2,
      wheelSegmentsPerFace: 8,
      wheelTreadSegmentsPerWheel: 8,
      wheelTreadTrianglesPerWheel: 16,
      wheelTreadTriangleCount: 64,
      wheelTotalTriangleCount: 128,
      wheelRadiusMeters: 0.26,
      wheelContactClearanceMeters: 0,
      wheelLateralProtrusionMeters: 0.09,
      wheelThicknessMeters: 0.144,
      wheelAxleOffsetMeters: 1.248,
      wheelPaintModulatedHubHighlight: true,
      wheelEmissive: false,
      cabSurfaceTones: {},
      cabUniqueToneCount: 0,
    },
    submittedTriangles: 0,
    hysteresis: { enters: 0, exits: 0 },
    updates: { checks: 0, compactions: 0, resets: 0 },
    lifecycle: { registrations: 0, disposals: 0 },
    resources: { drawGroups: 0, geometries: 0, materials: 0, textures: 0 },
  };
}

function serializePortalPartitionRecords(records) {
  return JSON.stringify(records.map((record) => ({
    index: record.index,
    portalId: record.portalId,
    buildingId: record.buildingId,
    cellId: record.cellId,
    pinned: record.pinned,
    panelMatrix: [...record.panelMatrix],
    panelColor: [...record.panelColor],
    frameMatrices: record.frameMatrices.map((matrix) => [...matrix]),
    frameColors: record.frameColors.map((color) => [...color]),
    lightMatrix: [...record.lightMatrix],
  })));
}

function serializeParkedCarPartitionRecords(records) {
  return JSON.stringify(records.map((record) => ({
    index: record.index,
    x: record.x,
    z: record.z,
    heading: record.heading,
    cellId: record.cellId,
    bodyMatrix: [...record.bodyMatrix],
    bodyColor: [...record.bodyColor],
    cabMatrix: [...record.cabMatrix],
    cabColor: [...record.cabColor],
  })));
}

function createParkedCarHullGeometry({ compositeBody = false, segmentedCab = false } = {}) {
  const profile = [
    [-0.5, -0.5],
    [0.18, -0.5],
    [0.48, -0.32],
    [0.42, 0.18],
    [0.05, 0.5],
    [-0.5, 0.5],
  ];
  const vertices = [
    ...profile.map(([y, z]) => [-0.5, y, z]),
    ...profile.map(([y, z]) => [0.5, y, z]),
  ];
  const positions = [];
  const colors = [];
  const triangleOrigins = [];
  const triangleRoles = [];
  let geometryWheelMetadata = null;
  const roles = segmentedCab
    ? { sideWindows: 0, rearWindow: 0, roof: 0, windshield: 0, lowerSills: 0 }
    : { paintHull: 0, wheelSideDiscs: 0, wheelTreads: 0, lamps: 0 };
  const cabSurfaceTones = Object.freeze({
    sideWindows: [0.72, 0.88, 0.96],
    rearWindow: [0.52, 0.67, 0.75],
    roof: [0.34, 0.42, 0.46],
    windshield: [1.18, 1.38, 1.48],
    lowerSills: [0.43, 0.52, 0.56],
  });
  const appendTriangle = (
    a,
    b,
    c,
    color = [1, 1, 1],
    role = 'paintHull',
    outwardOrigin = [0, 0, 0],
    cornerColors = null,
  ) => {
    positions.push(...vertices[a], ...vertices[b], ...vertices[c]);
    if (cornerColors) {
      colors.push(...cornerColors[0], ...cornerColors[1], ...cornerColors[2]);
    } else {
      colors.push(...color, ...color, ...color);
    }
    triangleOrigins.push(outwardOrigin);
    triangleRoles.push(role);
    roles[role] = (roles[role] || 0) + 1;
  };
  for (let index = 1; index < profile.length - 1; index += 1) {
    const role = segmentedCab ? 'sideWindows' : 'paintHull';
    const color = segmentedCab ? cabSurfaceTones.sideWindows : [1, 1, 1];
    appendTriangle(6, 6 + index, 6 + index + 1, color, role);
    appendTriangle(0, index + 1, index, color, role);
  }
  for (let index = 0; index < profile.length; index += 1) {
    const next = (index + 1) % profile.length;
    const role = segmentedCab
      ? ['lowerSills', 'rearWindow', 'roof', 'windshield', 'lowerSills', 'lowerSills'][index]
      : 'paintHull';
    const color = segmentedCab ? cabSurfaceTones[role] : [1, 1, 1];
    appendTriangle(6 + index, index, next, color, role);
    appendTriangle(6 + index, next, 6 + next, color, role);
  }
  if (compositeBody) {
    // Vertex tones are multiplied by each InstancedMesh paint color in linear space.
    // The center tone is therefore a paint-modulated highlight, not a neutral silver hub.
    const rawWheelTones = Object.freeze({
      paintModulatedHubHighlight: Object.freeze([1.18, 1.25, 1.3]),
      outerFaceRadial: Object.freeze([0.18, 0.18, 0.19]),
      innerFace: Object.freeze([0.12, 0.12, 0.13]),
      tread: Object.freeze([0.1, 0.1, 0.11]),
    });
    const effectivePaletteProducts = PARKED_CAR_PALETTE.map((paintHex, paletteIndex) => {
      const instancePaint = new THREE.Color(paintHex);
      const instancePaintLinear = [instancePaint.r, instancePaint.g, instancePaint.b];
      const multiplyTone = (tone) => tone.map((channel, index) => (
        channel * instancePaintLinear[index]
      ));
      const hubHighlight = multiplyTone(rawWheelTones.paintModulatedHubHighlight);
      const tread = multiplyTone(rawWheelTones.tread);
      const products = [...instancePaintLinear, ...hubHighlight, ...tread];
      return {
        paletteIndex,
        paintHex,
        instancePaintLinear,
        hubHighlight,
        tread,
        finite: products.every(Number.isFinite),
        bounded: products.every((channel) => channel >= 0 && channel <= 1),
      };
    });
    const wheelCenterY = -0.1034482759;
    const wheelRadiusY = 0.4482758621;
    const wheelRadiusZ = 0.0666666667;
    const wheelInnerX = 0.47;
    const wheelOuterX = 0.55;
    const wheelSegments = 8;
    const wheelRings = [];
    const appendWheelFace = (x, centerZ, outwardSign, wheelCenterX, outerFace) => {
      const centerIndex = vertices.length;
      const origin = [wheelCenterX, wheelCenterY, centerZ];
      vertices.push([x, wheelCenterY, centerZ]);
      for (let segment = 0; segment < wheelSegments; segment += 1) {
        const angle = (segment / wheelSegments) * Math.PI * 2;
        vertices.push([
          x,
          wheelCenterY + Math.cos(angle) * wheelRadiusY,
          centerZ + Math.sin(angle) * wheelRadiusZ,
        ]);
      }
      const radialStart = centerIndex + 1;
      const radialIndices = [];
      for (let segment = 0; segment < wheelSegments; segment += 1) {
        const current = radialStart + segment;
        const next = radialStart + ((segment + 1) % wheelSegments);
        radialIndices.push(current);
        const cornerColors = outerFace
          ? [
            rawWheelTones.paintModulatedHubHighlight,
            rawWheelTones.outerFaceRadial,
            rawWheelTones.outerFaceRadial,
          ]
          : [rawWheelTones.innerFace, rawWheelTones.innerFace, rawWheelTones.innerFace];
        if (outwardSign > 0) {
          appendTriangle(
            centerIndex,
            current,
            next,
            rawWheelTones.innerFace,
            'wheelSideDiscs',
            origin,
            cornerColors,
          );
        } else {
          appendTriangle(
            centerIndex,
            next,
            current,
            rawWheelTones.innerFace,
            'wheelSideDiscs',
            origin,
            [cornerColors[0], cornerColors[2], cornerColors[1]],
          );
        }
      }
      return radialIndices;
    };
    for (const side of [-1, 1]) {
      for (const centerZ of [-0.32, 0.32]) {
        const wheelCenterX = side * ((wheelInnerX + wheelOuterX) * 0.5);
        const outerRing = appendWheelFace(side * wheelOuterX, centerZ, side, wheelCenterX, true);
        const innerRing = appendWheelFace(side * wheelInnerX, centerZ, -side, wheelCenterX, false);
        wheelRings.push({ side, centerZ, wheelCenterX, outerRing, innerRing });
      }
    }
    for (const wheel of wheelRings) {
      const origin = [wheel.wheelCenterX, wheelCenterY, wheel.centerZ];
      for (let segment = 0; segment < wheelSegments; segment += 1) {
        const next = (segment + 1) % wheelSegments;
        const outerCurrent = wheel.outerRing[segment];
        const outerNext = wheel.outerRing[next];
        const innerCurrent = wheel.innerRing[segment];
        const innerNext = wheel.innerRing[next];
        if (wheel.side > 0) {
          appendTriangle(
            outerCurrent,
            innerCurrent,
            innerNext,
            rawWheelTones.tread,
            'wheelTreads',
            origin,
          );
          appendTriangle(
            outerCurrent,
            innerNext,
            outerNext,
            rawWheelTones.tread,
            'wheelTreads',
            origin,
          );
        } else {
          appendTriangle(
            outerCurrent,
            innerNext,
            innerCurrent,
            rawWheelTones.tread,
            'wheelTreads',
            origin,
          );
          appendTriangle(
            outerCurrent,
            outerNext,
            innerNext,
            rawWheelTones.tread,
            'wheelTreads',
            origin,
          );
        }
      }
    }
    const appendLamp = (x, rear) => {
      const z = rear ? -0.501 : 0.501;
      const minX = x - 0.075;
      const maxX = x + 0.075;
      const minY = -0.12;
      const maxY = 0.05;
      const color = rear ? [1.8, 0.12, 0.08] : [1.55, 1.42, 1.05];
      const start = vertices.length;
      vertices.push(
        [minX, minY, z], [maxX, minY, z],
        [maxX, maxY, z], [minX, maxY, z],
      );
      if (rear) {
        appendTriangle(start, start + 2, start + 1, color, 'lamps');
        appendTriangle(start, start + 3, start + 2, color, 'lamps');
      } else {
        appendTriangle(start, start + 1, start + 2, color, 'lamps');
        appendTriangle(start, start + 2, start + 3, color, 'lamps');
      }
    };
    for (const x of [-0.31, 0.31]) {
      appendLamp(x, false);
      appendLamp(x, true);
    }
    geometryWheelMetadata = {
      count: 4,
      facesPerWheel: 2,
      segmentsPerFace: wheelSegments,
      triangleCount: roles.wheelSideDiscs,
      treadSegmentsPerWheel: wheelSegments,
      treadTrianglesPerWheel: wheelSegments * 2,
      treadTriangleCount: roles.wheelTreads,
      totalTriangleCount: roles.wheelSideDiscs + roles.wheelTreads,
      normalizedRadiusY: wheelRadiusY,
      normalizedRadiusZ: wheelRadiusZ,
      normalizedCenterY: wheelCenterY,
      normalizedOuterX: wheelOuterX,
      normalizedInnerX: wheelInnerX,
      minOutwardNormalDot: 0,
      minTreadOutwardNormalDot: 0,
      outerFacePaintModulatedHubHighlight: true,
      colors: {
        composition: 'raw-geometry-tone-times-instance-paint-linear',
        rawGeometryTones: Object.fromEntries(Object.entries(rawWheelTones).map(
          ([key, value]) => [key, [...value]],
        )),
        effectivePaletteProducts,
        productBounds: [0, 1],
        productsFinite: effectivePaletteProducts.every((entry) => entry.finite),
        productsBounded: effectivePaletteProducts.every((entry) => entry.bounded),
        vertexColorSpace: 'linear-srgb',
        emissive: false,
      },
      contact: {
        normalizedLowestY: wheelCenterY - wheelRadiusY,
        bodyScaleYMeters: 0.58,
        bodyCenterAboveRoadMeters: 0.32,
        toleranceMeters: 0.000001,
      },
    };
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (geometryWheelMetadata) {
    geometryWheelMetadata.contact.normalizedLowestY = geometry.boundingBox.min.y;
  }
  let minTriangleArea = Infinity;
  let minOutwardNormalDot = Infinity;
  let wheelMinOutwardNormalDot = Infinity;
  let wheelTreadMinOutwardNormalDot = Infinity;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  for (let offset = 0; offset < positions.length; offset += 9) {
    a.fromArray(positions, offset);
    b.fromArray(positions, offset + 3);
    c.fromArray(positions, offset + 6);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac);
    const twiceArea = normal.length();
    minTriangleArea = Math.min(minTriangleArea, twiceArea * 0.5);
    normal.normalize();
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      .sub(new THREE.Vector3().fromArray(triangleOrigins[offset / 9]));
    const outwardNormalDot = normal.dot(centroid);
    minOutwardNormalDot = Math.min(minOutwardNormalDot, outwardNormalDot);
    if (triangleRoles[offset / 9] === 'wheelSideDiscs') {
      wheelMinOutwardNormalDot = Math.min(wheelMinOutwardNormalDot, outwardNormalDot);
    } else if (triangleRoles[offset / 9] === 'wheelTreads') {
      wheelTreadMinOutwardNormalDot = Math.min(wheelTreadMinOutwardNormalDot, outwardNormalDot);
    }
  }
  if (geometryWheelMetadata) {
    geometryWheelMetadata.minOutwardNormalDot = wheelMinOutwardNormalDot;
    geometryWheelMetadata.minTreadOutwardNormalDot = wheelTreadMinOutwardNormalDot;
  }
  const triangleRanges = compositeBody ? {
    paintHull: { start: 0, count: roles.paintHull },
    wheelSideDiscs: { start: roles.paintHull, count: roles.wheelSideDiscs },
    wheelTreads: {
      start: roles.paintHull + roles.wheelSideDiscs,
      count: roles.wheelTreads,
    },
    lamps: {
      start: roles.paintHull + roles.wheelSideDiscs + roles.wheelTreads,
      count: roles.lamps,
    },
  } : null;
  const vertexRanges = triangleRanges ? Object.fromEntries(Object.entries(triangleRanges).map(
    ([role, range]) => [role, { start: range.start * 3, count: range.count * 3 }],
  )) : null;
  geometry.userData.parkedCarHull = {
    triangleCount: positions.length / 9,
    vertexCount: positions.length / 3,
    indexed: false,
    hardEdged: true,
    finiteTriangleAreas: Number.isFinite(minTriangleArea) && minTriangleArea > 0,
    minTriangleArea,
    minOutwardNormalDot,
    vertexColors: true,
    roles,
    triangleRanges,
    vertexRanges,
    wheels: geometryWheelMetadata,
    surfaceTones: segmentedCab ? cabSurfaceTones : null,
  };
  return geometry;
}

/**
 * Report the same shape `applyWorldXZUvs` returns for a geometry that already
 * carries world-XZ UVs (street-surface-v2 bakes them during construction), so
 * the SF ground-material contract keeps its evidence without rewriting the
 * attribute a second time.
 */
function describeWorldXZUvs(geometry, metersPerRepeat) {
  const uv = geometry?.getAttribute?.('uv');
  if (!uv) {
    return { itemSize: 0, vertexCount: 0, metersPerRepeat, range: null, repeat: null, finite: false };
  }
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  let finite = uv.count > 0 && Number.isFinite(metersPerRepeat) && metersPerRepeat > 0;
  for (let index = 0; index < uv.count; index += 1) {
    const u = uv.getX(index);
    const v = uv.getY(index);
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
    finite = finite && Number.isFinite(u) && Number.isFinite(v);
  }
  geometry.userData.worldUv = { axis: 'xz', metersPerRepeat };
  return {
    itemSize: uv.itemSize,
    vertexCount: uv.count,
    metersPerRepeat,
    range: uv.count > 0 ? { minU, maxU, minV, maxV } : null,
    repeat: uv.count > 0 ? { u: maxU - minU, v: maxV - minV } : null,
    finite,
  };
}

function applyWorldXZUvs(geometry, metersPerRepeat) {
  const position = geometry.getAttribute('position');
  const uv = new Float32Array(position.count * 2);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  let finite = position.count > 0 && Number.isFinite(metersPerRepeat) && metersPerRepeat > 0;
  for (let index = 0; index < position.count; index += 1) {
    const u = position.getX(index) / metersPerRepeat;
    const v = position.getZ(index) / metersPerRepeat;
    uv[index * 2] = u;
    uv[index * 2 + 1] = v;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
    finite = finite && Number.isFinite(u) && Number.isFinite(v);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.userData.worldUv = { axis: 'xz', metersPerRepeat };
  return {
    itemSize: 2,
    vertexCount: position.count,
    metersPerRepeat,
    range: position.count > 0 ? { minU, maxU, minV, maxV } : null,
    repeat: position.count > 0 ? { u: maxU - minU, v: maxV - minV } : null,
    finite,
  };
}

function polygonInteriorCenter(points) {
  let crossSum = 0;
  let centerX = 0;
  let centerZ = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.z - b.x * a.z;
    crossSum += cross;
    centerX += (a.x + b.x) * cross;
    centerZ += (a.z + b.z) * cross;
  }
  if (Math.abs(crossSum) > BUILDING_FOOTPRINT_EPSILON) {
    const center = { x: centerX / (3 * crossSum), z: centerZ / (3 * crossSum) };
    if (pointInPolygon(center, points)) return center;
  }
  const triangles = THREE.ShapeUtils.triangulateShape(
    points.map((point) => new THREE.Vector2(point.x, point.z)),
    [],
  );
  let best = null;
  for (const triangle of triangles) {
    const a = points[triangle[0]];
    const b = points[triangle[1]];
    const c = points[triangle[2]];
    const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z));
    if (!best || area > best.area) {
      best = { area, x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 };
    }
  }
  return best ? { x: best.x, z: best.z } : { ...points[0] };
}

function longestPolygonEdgeHeading(points) {
  let longest = { length: 0, heading: 0 };
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length > longest.length) longest = { length, heading: Math.atan2(dz, dx) };
  }
  return longest.heading;
}

function boxFootprintCorners(center, width, depth, heading, dx = 0, dz = 0) {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const offsetX = dx * cos - dz * sin;
  const offsetZ = dx * sin + dz * cos;
  const cx = center.x + offsetX;
  const cz = center.z + offsetZ;
  return [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ].map(([x, z]) => ({ x: cx + x * cos - z * sin, z: cz + x * sin + z * cos }));
}

function colorizeGeometry(geometry, hex, baseY = 0, topY = 1) {
  const baseColor = new THREE.Color(hex);
  const normals = geometry.attributes.normal;
  const positions = geometry.attributes.position;
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < geometry.attributes.position.count; i += 1) {
    const normalY = normals?.getY(i) || 0;
    const sideDirection = normals ? normals.getX(i) * 0.7 + normals.getZ(i) * 0.3 : 0;
    const heightRatio = clamp((positions.getY(i) - baseY) / Math.max(0.001, topY - baseY), 0, 1);
    const lightness = normalY > 0.5
      ? 0.1
      : normalY < -0.5 ? -0.2 : -0.16 + heightRatio * 0.13 + sideDirection * 0.025;
    const color = baseColor.clone().offsetHSL(0, normalY > 0.5 ? -0.05 : 0, lightness);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

function heroFacadeMaterialGroup(building) {
  const facade = building.facade || 'modern-grid';
  if (facade === 'loft' && building.material === 'brick') return 'brick';
  if (facade === 'loft' && building.material === 'glass') return 'glass';
  if (facade === 'modern-grid' && building.material === 'concrete') return 'concrete';
  return null;
}

function heroFacadeCell(building, group) {
  const authored = HERO_FACADE_IDS.get(building.id);
  if (authored) return authored;
  if (group === 'glass') return { cell: 1, pattern: 'market-bronze-glass' };
  if (group === 'concrete') {
    return hashString(`${building.id}-hero-atlas`) % 2 === 0
      ? { cell: 2, pattern: 'central-art-deco' }
      : { cell: 3, pattern: 'market-limestone-grid' };
  }
  const brickCells = [
    { cell: 0, pattern: 'hearst-stone' },
    { cell: 4, pattern: 'kearny-brick-stone' },
    { cell: 5, pattern: 'market-industrial-loft' },
  ];
  return brickCells[hashString(`${building.id}-hero-atlas`) % brickCells.length];
}

function remapPolygonFacadeToAtlas(geometry, footprintPointCount, cellIndex, streetwall = false) {
  const uv = geometry.attributes.uv;
  if (!uv || footprintPointCount < 3 || cellIndex < 0 || cellIndex > 5) {
    return {
      finite: false,
      wallEdges: 0,
      wallVertices: 0,
      facadeNeutralVertices: 0,
    };
  }
  const insetU = 1 / HERO_FACADE_ATLAS_RESOLUTION;
  const insetV = 1 / HERO_FACADE_ATLAS_RESOLUTION;
  const column = cellIndex % 3;
  const visualRow = Math.floor(cellIndex / 3);
  const uMin = column / 3 + insetU;
  const uMax = (column + 1) / 3 - insetU;
  // Texture UVs use a bottom-left origin after the image loader's Y flip.
  const vMin = visualRow === 0 ? 0.5 + insetV : insetV;
  const vMax = visualRow === 0 ? 1 - insetV : 0.5 - insetV;
  const roofStyle = HERO_ROOF_CAP_STYLES[cellIndex];
  const roofU = uMin + (uMax - uMin) * roofStyle.sampleU;
  const roofV = vMax - (vMax - vMin) * roofStyle.sampleV;
  for (let i = 0; i < footprintPointCount; i += 1) uv.setXY(i, roofU, roofV);
  for (let edge = 0; edge < footprintPointCount; edge += 1) {
    const start = footprintPointCount + edge * 4;
    uv.setXY(start, uMin, vMin);
    uv.setXY(start + 1, uMax, vMin);
    uv.setXY(start + 2, uMax, vMax);
    uv.setXY(start + 3, uMin, vMax);
  }
  const roofColor = new THREE.Color(roofStyle.color);
  const white = new THREE.Color(0xffffff);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < geometry.attributes.position.count; i += 1) {
    const color = i < footprintPointCount
      ? roofColor.clone().offsetHSL(0, 0, ((i * 17 + cellIndex * 7) % 5 - 2) * 0.012)
      : white;
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  uv.needsUpdate = true;
  return {
    finite: Array.from(uv.array).every(Number.isFinite) && Array.from(colors).every(Number.isFinite),
    wallEdges: footprintPointCount,
    wallVertices: footprintPointCount * 4,
    facadeNeutralVertices: streetwall ? footprintPointCount * 4 : 0,
  };
}

async function loadHeroFacadeTextures() {
  const texture = await new THREE.TextureLoader().loadAsync(HERO_FACADE_ATLAS_URL);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;

  const image = texture.image;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const r = pixels.data[i];
    const g = pixels.data[i + 1];
    const b = pixels.data[i + 2];
    const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const windowLike = luminance < 126 && b >= r * 0.72 && b >= g * 0.72;
    const glow = windowLike ? Math.round(150 + (126 - luminance) * 0.7) : 0;
    pixels.data[i] = glow;
    pixels.data[i + 1] = Math.round(glow * 0.84);
    pixels.data[i + 2] = Math.round(glow * 0.52);
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const nightTexture = new THREE.CanvasTexture(canvas);
  nightTexture.wrapS = THREE.ClampToEdgeWrapping;
  nightTexture.wrapT = THREE.ClampToEdgeWrapping;
  nightTexture.minFilter = THREE.LinearMipmapLinearFilter;
  nightTexture.magFilter = THREE.LinearFilter;
  nightTexture.anisotropy = 4;
  return { texture, nightTexture };
}

function signedFootprintArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

function normalizeBuildingFootprint(sourcePoints) {
  if (!Array.isArray(sourcePoints)) return null;
  const points = [];
  for (const point of sourcePoints) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.z)) return null;
    const previous = points.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.z - previous.z) > BUILDING_FOOTPRINT_EPSILON) {
      points.push({ x: point.x, z: point.z });
    }
  }
  if (points.length > 2) {
    const first = points[0];
    const last = points.at(-1);
    if (Math.hypot(first.x - last.x, first.z - last.z) <= BUILDING_FOOTPRINT_EPSILON) points.pop();
  }
  if (points.length < 3 || Math.abs(signedFootprintArea(points)) < BUILDING_FOOTPRINT_EPSILON) return null;
  return points;
}

function polygonExtrusionGeometry(points, height, baseY) {
  const signedArea = signedFootprintArea(points);
  const roofTriangles = THREE.ShapeUtils.triangulateShape(
    points.map((point) => new THREE.Vector2(point.x, point.z)),
    [],
  );
  if (roofTriangles.length !== points.length - 2) return null;

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const topY = baseY + height;
  // Roof vertices are separate from walls so the cap normal stays hard after
  // material-bucket merging. A stable facade-background texel keeps windows
  // and murals off horizontal roofs. The terrain-hidden bottom cap is omitted.
  for (const point of points) {
    positions.push(point.x, topY, point.z);
    normals.push(0, 1, 0);
    uvs.push(0.02, 0.2);
  }

  let renderedArea = 0;
  for (const triangle of roofTriangles) {
    const [a, b, c] = triangle;
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];
    const triangleSignedArea = ((pb.x - pa.x) * (pc.z - pa.z) - (pc.x - pa.x) * (pb.z - pa.z)) / 2;
    renderedArea += Math.abs(triangleSignedArea);
    // In X/Y/Z space, positive X/Z winding points downward, hence the swap.
    if (triangleSignedArea > 0) {
      indices.push(a, c, b);
    } else {
      indices.push(a, b, c);
    }
  }

  let perimeter = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const edgeLength = Math.hypot(dx, dz);
    const wallStart = positions.length / 3;
    const outwardX = signedArea > 0 ? dz / edgeLength : -dz / edgeLength;
    const outwardZ = signedArea > 0 ? -dx / edgeLength : dx / edgeLength;
    const u0 = perimeter / BUILDING_UV_METRES_X;
    const u1 = (perimeter + edgeLength) / BUILDING_UV_METRES_X;
    positions.push(
      a.x, baseY, a.z,
      b.x, baseY, b.z,
      b.x, topY, b.z,
      a.x, topY, a.z,
    );
    for (let vertex = 0; vertex < 4; vertex += 1) normals.push(outwardX, 0, outwardZ);
    uvs.push(
      u0, 0,
      u1, 0,
      u1, height / BUILDING_UV_METRES_Y,
      u0, height / BUILDING_UV_METRES_Y,
    );
    if (signedArea > 0) {
      indices.push(wallStart, wallStart + 2, wallStart + 1, wallStart, wallStart + 3, wallStart + 2);
    } else {
      indices.push(wallStart, wallStart + 1, wallStart + 2, wallStart, wallStart + 2, wallStart + 3);
    }
    perimeter += edgeLength;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return {
    geometry,
    renderedArea,
    triangleCount: indices.length / 3,
  };
}

function seededTexture(seed, draw, width = 128, height = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  draw(context, width, height, mulberry32(seed));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function drawFacade(context, width, height, random, style, material, { day = true, vivid = false } = {}) {
  const base = PALETTES[material] || PALETTES.plaster;
  let baseFill = base[Math.floor(random() * base.length)];
  if (vivid) {
    // Real-map slices get a gentle saturation lift on painted materials so
    // facades carry more hue variety; glass stays soft so towers keep the
    // stylized low-poly look.
    if (material !== 'glass') {
      const c = new THREE.Color(baseFill);
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      c.setHSL(hsl.h, clamp(hsl.s * 1.12 + 0.04, 0, 0.68), clamp(hsl.l, 0.45, 0.85));
      baseFill = `#${c.getHexString()}`;
    }
  } else if (material !== 'glass' && material !== 'concrete' && material !== 'stone') {
    // Gentle chroma lift on painted facades keeps the soft look while giving
    // painted cities a touch more saturation headroom.
    const c = new THREE.Color(baseFill);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h, clamp(hsl.s * 1.1 + 0.03, 0, 0.8), clamp(hsl.l, 0.45, 0.85));
    baseFill = `#${c.getHexString()}`;
  }
  context.fillStyle = baseFill;
  context.fillRect(0, 0, width, height);
  const vertical = style === 'modern-grid' || style === 'loft';
  const columns = vertical ? 3 + Math.floor(random() * 3) : 2 + Math.floor(random() * 2);
  const rows = Math.max(3, Math.floor((height / 128) * (3 + Math.floor(random() * 4))));
  const margin = 10;
  const gapX = (width - margin * 2) / columns;
  const gapY = (height - margin * 2) / rows;
  const lit = material === 'glass'
    ? ['#d8ecf7', '#e5f3fb', '#c2e0f0']
    : ['#ffd98f', '#ffc96a', '#ffe9ae', '#f0b967'];
  const cool = material === 'glass';
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const x = margin + col * gapX + random() * 5;
      const y = margin + row * gapY + random() * 4;
      const w = gapX * 0.62;
      const h = gapY * 0.62;
      const litWindow = random() < (day ? 0.24 : 0.48);
      context.fillStyle = cool ? (litWindow ? '#bfe0f2' : '#6f9fc4') : (litWindow ? lit[Math.floor(random() * lit.length)] : '#39434c');
      context.fillRect(x, y, w, h);
      if (cool && !litWindow) {
        context.fillStyle = 'rgba(255,255,255,0.24)';
        context.fillRect(x + w * 0.08, y + h * 0.08, w * 0.3, h * 0.2);
      }
      if (random() < 0.4) {
        context.fillStyle = 'rgba(0,0,0,0.18)';
        context.fillRect(x + w / 2, y, 2, h);
      }
    }
  }
  if (cool) {
    // Spandrel bands and mullions give glass towers an architectural grid so
    // large facades carry edge detail without raising saturation.
    context.fillStyle = 'rgba(30,45,60,0.26)';
    for (let row = 0; row <= rows; row += 1) {
      context.fillRect(0, Math.max(0, margin + row * gapY - 3), width, 3);
    }
    for (let col = 0; col <= columns; col += 1) {
      context.fillRect(Math.max(0, margin + col * gapX - 1), 0, 1.5, height);
    }
  }
  // Cornice + parapet bands.
  context.fillStyle = 'rgba(255,255,255,0.22)';
  context.fillRect(0, 0, width, 7);
  context.fillRect(0, height - 7, width, 7);
  context.fillStyle = 'rgba(60,45,35,0.28)';
  context.fillRect(0, 7, width, 3);
  const muralChance = vivid ? 0.24 : 0.06;
  // Glass towers skip murals: repeated bands read as giant stripes at height.
  const muralFacade = style === 'shopfront'
    || ((style === 'loft' || style === 'art-deco') && random() < 0.3)
    || random() < muralChance;
  if (material !== 'glass' && muralFacade) {
    const murals = vivid
      ? ['rgba(224,52,79,0.72)', 'rgba(217,47,143,0.72)', 'rgba(143,63,214,0.72)', 'rgba(47,159,214,0.66)', 'rgba(242,160,31,0.72)', 'rgba(63,191,111,0.66)', 'rgba(255,107,53,0.72)', 'rgba(255,92,168,0.72)']
      : ['rgba(224,80,66,0.58)', 'rgba(41,150,171,0.62)', 'rgba(232,164,44,0.58)', 'rgba(89,158,74,0.62)', 'rgba(151,86,178,0.62)', 'rgba(41,178,158,0.58)', 'rgba(235,97,158,0.58)'];
    context.fillStyle = murals[Math.floor(random() * murals.length)];
    context.fillRect(0, Math.floor(height * 0.36), width, Math.floor(height * 0.2));
    if (vivid && random() < 0.5) {
      // A second offset band reads as layered street art from the sidewalk.
      context.fillStyle = murals[Math.floor(random() * murals.length)];
      context.fillRect(Math.floor(width * 0.16), Math.floor(height * 0.3), Math.floor(width * 0.68), Math.floor(height * 0.1));
    }
  }
  if (style === 'art-deco') {
    context.fillStyle = 'rgba(120,90,60,0.5)';
    for (let i = 0; i < width; i += 18) {
      context.fillRect(i, 12, 8, 22);
    }
  }
  if (style === 'shopfront') {
    context.fillStyle = '#241f1d';
    context.fillRect(0, height - 30, width, 30);
    context.fillStyle = '#8a5a3a';
    context.fillRect(0, height - 30, width, 5);
    const storefrontColors = vivid
      ? ['#ff4d5e', '#ff8a3d', '#ffd23f', '#3fc96f', '#2fb3c9', '#4f7fe0', '#a95fd6', '#ff5ca8', '#f2e05a', '#ff7043']
      : ['#f7dca2', '#7fc0e5', '#f2b76c', '#8fd0a0', '#e994a6', '#c9adea'];
    const leftColor = storefrontColors[Math.floor(random() * storefrontColors.length)];
    let rightColor = storefrontColors[Math.floor(random() * storefrontColors.length)];
    while (rightColor === leftColor) rightColor = storefrontColors[Math.floor(random() * storefrontColors.length)];
    context.fillStyle = leftColor;
    context.fillRect(8, height - 24, (width - 16) / 2 - 4, 18);
    context.fillStyle = rightColor;
    context.fillRect((width - 16) / 2 + 8, height - 24, (width - 16) / 2 - 4, 18);
    // Saturated striped awning above the shopfront.
    const awningColors = vivid
      ? ['#e02f3f', '#ff5ca8', '#8f3fd6', '#1f9fbf', '#f2a01f', '#3f9f4f', '#ff7043', '#d92f8f']
      : ['#e04945', '#128f9e', '#e5a021', '#3d8f52', '#8a5fc0'];
    const awning = awningColors[Math.floor(random() * awningColors.length)];
    context.fillStyle = awning;
    for (let i = 0; i < width; i += 12) {
      context.fillRect(i, height - 34, 6, 8);
    }
    context.fillStyle = 'rgba(255,255,255,0.22)';
    for (let i = 0; i < width; i += 24) {
      context.fillRect(i, height - 34, 3, 8);
    }
    if (!day) {
      const neonColors = ['#ff5fa2', '#35d7d7', '#ffc43d'];
      const neon = neonColors[Math.floor(random() * neonColors.length)];
      context.shadowColor = neon;
      context.shadowBlur = 10;
      context.fillStyle = neon;
      context.fillRect(6, height - 46, width - 12, 7);
      const second = neonColors[(neonColors.indexOf(neon) + 1 + Math.floor(random() * 2)) % neonColors.length];
      context.shadowColor = second;
      context.fillStyle = second;
      context.fillRect(14, height - 58, Math.floor((width - 28) * 0.62), 4);
    }
  }
  if (style === 'bay-window') {
    context.fillStyle = 'rgba(90,70,55,0.35)';
    for (let col = 0; col < columns; col += 1) {
      context.fillRect(margin + col * gapX - 4, 8, 14, height - 16);
    }
  }
}

function drawAsphalt(context, width, height, random) {
  context.fillStyle = '#5b5a58';
  context.fillRect(0, 0, width, height);
  for (let i = 0; i < 140; i += 1) {
    context.fillStyle = random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.1)';
    context.fillRect(random() * width, random() * height, 2 + random() * 3, 1 + random() * 2);
  }
  for (let i = 0; i < 10; i += 1) {
    context.fillStyle = 'rgba(255,255,255,0.08)';
    const x = random() * width;
    const y = random() * height;
    context.beginPath();
    context.ellipse(x, y, 8 + random() * 14, 5 + random() * 8, random() * 3, 0, Math.PI * 2);
    context.fill();
  }
}

function drawSidewalk(context, width, height, random) {
  context.fillStyle = '#e2c79a';
  context.fillRect(0, 0, width, height);
  for (let i = 0; i < 30; i += 1) {
    context.fillStyle = 'rgba(140,120,100,0.1)';
    context.fillRect(random() * width, random() * height, 6 + random() * 16, 1.4);
  }
  context.strokeStyle = 'rgba(130,100,70,0.3)';
  context.lineWidth = 1.4;
  for (let y = 16; y < height; y += 32) {
    context.beginPath();
    context.moveTo(0, y + random() * 4);
    context.lineTo(width, y + random() * 4);
    context.stroke();
  }
}

function drawGround(context, width, height, random) {
  context.fillStyle = '#9fc38a';
  context.fillRect(0, 0, width, height);
  for (let i = 0; i < 60; i += 1) {
    context.fillStyle = random() < 0.5 ? 'rgba(110,140,95,0.3)' : 'rgba(198,214,176,0.28)';
    context.beginPath();
    context.ellipse(random() * width, random() * height, 16 + random() * 30, 10 + random() * 20, random() * 3, 0, Math.PI * 2);
    context.fill();
  }
}

function drawShadowAlpha(context, width, height) {
  const gradient = context.createRadialGradient(width / 2, height / 2, 4, width / 2, height / 2, width / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(0.62, 'rgba(0,0,0,0.72)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function quad(a, b, c, d, normals = true) {
  const n = new THREE.Vector3();
  const ab = new THREE.Vector3().subVectors(b, a);
  const ad = new THREE.Vector3().subVectors(d, a);
  n.crossVectors(ab, ad).normalize();
  const positions = [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z];
  const indices = [0, 1, 2, 0, 2, 3];
  const normalsArr = normals
    ? [n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z]
    : [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  return { positions, indices, normalsArr, count: 4 };
}

function pushQuad(attr, index, a, b, c, d, color = null) {
  const q = quad(a, b, c, d);
  for (let i = 0; i < q.count; i += 1) {
    attr.position.setXYZ(index + i, q.positions[i * 3], q.positions[i * 3 + 1], q.positions[i * 3 + 2]);
    attr.normal.setXYZ(index + i, q.normalsArr[i * 3], q.normalsArr[i * 3 + 1], q.normalsArr[i * 3 + 2]);
    if (color) attr.color.setXYZ(index + i, color.r, color.g, color.b);
  }
  for (const qi of q.indices) attr.index.push(index + qi);
}

function lineQuadAttrs(capacity = 0) {
  // Capacity is a quad count; every quad needs four vertices.
  const vertexCount = capacity * 4;
  return {
    position: new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
    normal: new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
    color: new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
    index: [],
  };
}

 function dynQuadAttrs() {
   // Dynamic quad buffers for counts that depend on segment lengths; avoids a
   // second pre-count pass and any overflow risk.
   return { position: [], normal: [], color: [], index: [] };
 }

 function pushQuadDyn(attrs, a, b, c, d, color = null) {
   const base = attrs.position.length / 3;
   const q = quad(a, b, c, d);
   for (let i = 0; i < q.count; i += 1) {
     attrs.position.push(q.positions[i * 3], q.positions[i * 3 + 1], q.positions[i * 3 + 2]);
     attrs.normal.push(q.normalsArr[i * 3], q.normalsArr[i * 3 + 1], q.normalsArr[i * 3 + 2]);
     if (color) attrs.color.push(color.r, color.g, color.b);
   }
   for (const qi of q.indices) attrs.index.push(base + qi);
 }

 function buildDynGeometry(attrs) {
   const geometry = new THREE.BufferGeometry();
   geometry.setAttribute('position', new THREE.Float32BufferAttribute(attrs.position, 3));
   geometry.setAttribute('normal', new THREE.Float32BufferAttribute(attrs.normal, 3));
   geometry.setAttribute('color', new THREE.Float32BufferAttribute(attrs.color, 3));
   geometry.setIndex(attrs.index);
   return geometry;
 }

 function pushStripDyn(attrs, p, q, width, yAt, color) {
   // Flat ribbon along p->q, `width` wide, following terrain via yAt.
   const dx = q.x - p.x;
   const dz = q.z - p.z;
   const length = Math.hypot(dx, dz);
   if (length < 0.01) return;
   const mx = (-dz / length) * (width / 2);
   const mz = (dx / length) * (width / 2);
   pushQuadDyn(attrs,
     { x: p.x + mx, y: yAt(p.x, p.z), z: p.z + mz },
     { x: q.x + mx, y: yAt(q.x, q.z), z: q.z + mz },
     { x: q.x - mx, y: yAt(q.x, q.z), z: q.z - mz },
     { x: p.x - mx, y: yAt(p.x, p.z), z: p.z - mz },
     color,
   );
 }

function buildAttrGeometry(attrs) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', attrs.position);
  geometry.setAttribute('normal', attrs.normal);
  geometry.setAttribute('color', attrs.color);
  geometry.setIndex(attrs.index);
  return geometry;
}

function finalizeAttrs(attr, count) {
  attr.position.count = count;
  attr.normal.count = count;
  attr.color.count = count;
  attr.position.needsUpdate = true;
  attr.normal.needsUpdate = true;
  attr.color.needsUpdate = true;
}

function colorFromHex(hex) {
  return new THREE.Color(hex);
}

function shade(color, amount) {
  const c = color.clone();
  if (amount >= 0) c.lerp(new THREE.Color('#ffffff'), amount);
  else c.lerp(new THREE.Color('#1a1a1a'), -amount);
  return c;
}

export class CityRenderer {
  constructor(container, { pixelRatioCap = 1.5 } = {}) {
    this.container = container;
    this.scene = new THREE.Scene();
    // Soft warm haze: closer fog start wraps distant blocks gently.
    this.scene.fog = new THREE.Fog(0xe2e8e2, 330, 1380);
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 4200);
    this.camera.position.set(180, 150, 260);
    const sceneCanvas = container.querySelector('#scene-canvas');
    this.renderer = new WebGPURenderer({
      antialias: true,
      powerPreference: 'high-performance',
      ...(sceneCanvas ? { canvas: sceneCanvas } : {}),
    });
    this.rendererBackend = 'initializing';
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.86;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    if (!sceneCanvas) container.appendChild(this.renderer.domElement);
    // A restrained filmic grade keeps the pastel material palette intact and
    // avoids turning large real-map facades into neon color fields.
    this.renderer.domElement.style.filter = 'saturate(1.16) contrast(1.04) brightness(1.01)';

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 620;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 4, 0);
    this.controls.enablePan = true;
    this.controls.panSpeed = 1.1;

    this.clock = new THREE.Clock();
    this.pickables = [];
    this.geometryCache = [];
    this.timeOfDay = 15;
    this.appliedTimeOfDay = null;
    this.appliedNightState = null;
    this.lightingPipelinesRendered = false;
    this.timeColors = {
      skyTopDay: new THREE.Color('#5f9fd1'),
      skyMidDay: new THREE.Color('#93c8e0'),
      skyBottomDay: new THREE.Color('#f6e7c9'),
      skyTopNight: new THREE.Color('#1e2450'),
      skyMidNight: new THREE.Color('#33396b'),
      skyBottomNight: new THREE.Color('#5b4a7d'),
      hemiDay: new THREE.Color('#e8f4ff'),
      hemiNight: new THREE.Color('#7c8cf2'),
      fogNight: new THREE.Color('#2a2e58'),
      fogDay: new THREE.Color('#cfe3ea'),
      fogDistant: new THREE.Color('#8a9fb8'),
      fogWarm: new THREE.Color('#ead9bd'),
      work: new THREE.Color(),
      sun: new THREE.Color(),
    };
    this.skyMesh = null;
    this.signalPhaseClock = 0;
    this.phaseClock = 0;
    this.terrain = null;
    this.city = null;
    this.streetFurniture = { props: 0, cars: 0, awnings: 0, bunting: 0 };
    this.sidewalkPropRecords = [];
    this.sidewalkPropRuntime = null;
    this.sidewalkPropDiagnostics = {
      bandViolations: 0,
      asphaltOverlaps: 0,
      heroFrontages: createHeroSidewalkDiagnostics(),
    };
    this.groundMaterialLifecycle = {
      textureAttemptCount: 0,
      textureFailureCount: 0,
      textureLoadCount: 0,
      textureLoadedCount: 0,
      buildCount: 0,
      clearCount: 0,
      disposeRequested: false,
      textureDisposeCount: 0,
      failedLoadTextureDisposeCount: 0,
      disposed: false,
    };
    this.groundMaterialDiagnostics = createGroundMaterialDiagnostics(this.groundMaterialLifecycle);
    this.groundMaterialTextures = null;
    this.groundMaterialTexturesReady = null;
    this.worldPartitionRuntime = null;
    this.worldPartitionDiagnostics = createWorldPartitionDiagnostics();
    this.portalPartitionRuntime = null;
    this.portalPartitionDiagnostics = createPortalPartitionDiagnostics();
    this.parkedCarPartitionRuntime = null;
    this.parkedCarPartitionDiagnostics = createParkedCarPartitionDiagnostics();
    this.buildingFootprintDiagnostics = {
      sourceCount: 0,
      polygonShells: 0,
      fallbacks: 0,
      finite: true,
      sourceArea: 0,
      renderedArea: 0,
      maxAreaRelativeError: 0,
      triangleCount: 0,
      triangleDelta: 0,
    };
    this.heroFacadeDiagnostics = {
      asset: HERO_FACADE_ATLAS_URL,
      heroes: [],
      drawGroups: 0,
      triangleDelta: 0,
      atlasLoaded: false,
      streetwall: createHeroStreetwallDiagnostics(),
    };
    this.nightEmissive = [];
    this.neonGlowMaterials = [];
    this.lampBulbs = [];
    this.lampLights = [];
    this.lightPools = [];
    this.neonLights = [];
    this.localLightCandidates = [];
    this.localLightPool = [];
    this.localLightUpdateClock = 0;
    this.localLightsNight = false;
    this.streetLampRecords = [];
    this.streetLampDiagnostics = {
      source: null,
      fixtureCount: 0,
      candidateCount: 0,
      maxLamps: 0,
      sourceOwnedCount: 0,
      bandViolations: 0,
      asphaltOverlaps: 0,
      pointLightPoolSize: 0,
    };
    this.terrainVisualScale = 1;
    // Image-based lighting rig (owns a PMREMGenerator and an LRU of prefiltered
    // targets). Created in initialize(), after renderer.init().
    this.envRig = null;
    this.envWeather = 'clear';
    this.envMaterialGroups = null;
    this.environmentDiagnostics = {
      pass: null,
      weather: 'clear',
      gradedMaterials: 0,
      envMapIntensity: null,
      lightRig: null,
      textureReady: false,
    };
    this.detailMapDiagnostics = { pass: DETAIL_MAP_PASS, anisotropy: null, ...detailMapCacheStats() };
    this.facadeDepthDiagnostics = createFacadeDepthDiagnostics();
    this.streetSurface = null;
    this.streetSurfaceDiagnostics = { pass: STREET_SURFACE_PASS, drawCalls: 0, triangles: 0, stats: null };
    this.groundCoverage = null;
    this.groundCoverageDiagnostics = { pass: GROUND_COVERAGE_PASS, built: false, drawCalls: 0, triangles: 0, stats: null };
    this.shadowCasterAudit = null;
    this.shadowCasterLogged = false;
    this.crowd = null;
    this.crowdDiagnostics = {
      pass: PEDESTRIAN_PRESENTATION_VERSION,
      source: null,
      agents: 0,
      skinned: 0,
      instanced: 0,
      far: 0,
      culled: 0,
      draws: 0,
      legacyBatchHidden: false,
    };
    this.crowdSunElevation = null;
    this.crowdPresentationFailed = false;
    /** Per-agent measured ground speed. Presentation state; never written back. */
    this.crowdTracks = new Map();
    this.crowdTrackStep = 0;
    this.legacyPedestrianBatchGroup = null;
    this.legacyPedestrianBatchVisible = true;
    this.buildFocus = null;

    this.sun = new THREE.DirectionalLight(0xffe0b0, 2.75);
    this.sun.position.set(-260, 380, 120);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SUN_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE);
    this.scene.add(this.sun);
    // A DirectionalLight aims at `light.target`, and three only reads that
    // target's world matrix. Keeping it in the graph is what lets the fit move
    // the aim point with the camera instead of leaving it pinned at the origin.
    this.scene.add(this.sun.target);
    // Everything else on `sun.shadow` - the orthographic extents, near/far,
    // bias and normalBias - is written every frame by `updateSunShadow()` from
    // `computeSunShadowCamera`. There are deliberately no hand-typed numbers
    // here: a constant `bias` is only correct at one sun altitude, because the
    // orthographic depth range it is expressed in swings by ~4x across a day.
    //
    // Direction *toward* the key light, unit length. Seeded from the placement
    // above and replaced by the solar model on the first `setTimeOfDay`.
    this.sunKeyDirection = this.sun.position.clone().normalize();
    this.shadowFit = null;
    this.shadowFitSignature = null;
    this.shadowFitLogged = false;
    this.maxCasterHeight = SUN_SHADOW_DEFAULT_CASTER_HEIGHT;
    this.shadowDiagnostics = {
      pass: SUN_SHADOW_PASS,
      fitted: false,
      mapSize: SUN_SHADOW_MAP_SIZE,
      shadowDistance: SUN_SHADOW_DISTANCE,
      texelsPerMetre: null,
      texelWorldSize: null,
      width: null,
      depthRange: null,
      normalBias: null,
      bias: null,
      castShadow: false,
      sunAltitudeDeg: null,
      maxCasterHeight: SUN_SHADOW_DEFAULT_CASTER_HEIGHT,
      densityRange: SHADOW_TEXEL_DENSITY_RANGE,
      refits: 0,
      warnings: [],
      // Written by `applyShadowCasterPolicyPass` once per city build.
      casterPolicy: null,
      casters: 0,
      castersExcluded: 0,
      // Written by `updateSunShadow` on every refit.
      biasPlan: null,
      fitNormalBias: null,
      fitBias: null,
    };
    this._shadowForward = new THREE.Vector3();
    this._shadowEye = new THREE.Vector3();

    this.hemi = new THREE.HemisphereLight(0xe9f6ff, 0x9fb47a, 1.38);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xfff2dc, 0.3);
    this.scene.add(this.ambient);
    this.rim = new THREE.DirectionalLight(0xcfe3f0, 0.6);
    this.rim.position.set(320, 240, -260);
    this.scene.add(this.rim);

    // Presentation passes are built after the world exists and are the only
    // sanctioned place for new scene content that is not owned by a legacy
    // renderer method. See src/render/pass-registry.js.
    this.passRuntime = createPassRuntime(PASSES);
    this.passDiagnostics = this.passRuntime.diagnostics;
    this.passContext = null;

    this.onResize = this.resize.bind(this);
    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  /**
   * The read-only view of the world a presentation pass is allowed to see.
   * Rebuilt per city so a pass can never hold a stale root or terrain.
   */
  createPassContext(root, city) {
    const renderer = this;
    return {
      root,
      city,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      rendererBackend: this.rendererBackend,
      terrain: this.terrain,
      heightAt: (x, z) => (this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0),
      isSanFrancisco: isSanFranciscoCity(city),
      seed: Number(city?.meta?.seedInt || 1),
      rng: (label) => mulberry32(hashString(`${city?.meta?.seed || 'city'}:${label}`)),
      focus: this.buildFocus,
      get hour() { return renderer.timeOfDay; },
      get weather() { return renderer.envWeather; },
      get day() { return renderer.day; },
      /** Keep a geometry on the renderer's disposal ledger. */
      registerGeometry: (geometry) => {
        if (geometry) this.geometryCache.push(geometry);
        return geometry;
      },
      /** Find a legacy renderer-owned group by name, e.g. 'sidewalk-props'. */
      legacyGroup: (name) => root.getObjectByName(name) || null,
    };
  }

  buildPresentationPasses(root, city) {
    this.passContext = this.createPassContext(root, city);
    const diagnostics = this.passRuntime.build(this.passContext);
    if (diagnostics.errors.length) {
      for (const error of diagnostics.errors) {
        console.warn(`[pass:${error.id}] ${error.phase} failed: ${error.message}`);
      }
    }
    return diagnostics;
  }

  async initialize() {
    await this.renderer.init();
    this.rendererBackend = this.renderer.backend?.isWebGPUBackend === true
      ? 'webgpu'
      : this.renderer.backend?.isWebGLBackend === true
        ? 'webgl2-fallback'
        : 'unknown';
    // Bake the shared detail maps at load rather than on the first frame, and
    // clamp their sampler anisotropy to what this backend really supports.
    const anisotropy = applyRendererCapabilities(this.renderer);
    preloadDetailMaps(DETAIL_MAP_CLASSES, DETAIL_MAP_OPTIONS);
    this.detailMapDiagnostics = { pass: DETAIL_MAP_PASS, anisotropy, ...detailMapCacheStats() };
    // One environment rig for the one renderer. PBR materials with no IBL have
    // no specular response at all, which is the single biggest reason the old
    // frames read as flat painted card.
    this.envRig = createEnvironmentRig(this.renderer, { scene: this.scene });
    await this.envRig.updateAsync({ hour: this.timeOfDay, weather: this.envWeather });
    return this.rendererBackend;
  }

  /** Weather bucket driving the sky/IBL model: 'clear' | 'fog' | 'drizzle'. */
  setWeather(kind) {
    const next = typeof kind === 'string' ? kind : 'clear';
    if (next === this.envWeather) return this.envWeather;
    this.envWeather = next;
    this.appliedTimeOfDay = null;
    this.appliedNightState = null;
    this.setTimeOfDay(this.timeOfDay);
    return this.envWeather;
  }

  /**
   * Push the recommended per-class `envMapIntensity` onto every material that
   * declared a class.
   *
   * On the node/WebGPU path `material.envMapIntensity` is only consulted when
   * the material owns an `envMap`; a material lit purely by `scene.environment`
   * shares the single global `scene.environmentIntensity` instead. Each graded
   * material is therefore pointed at the same prefiltered target the scene
   * uses, which costs no extra texture and makes per-class grading reach the
   * shader on both backends.
   */
  applyEnvironmentGrading(model, texture) {
    if (!model) return 0;
    if (!this.envMaterialGroups) {
      if (!this.root) return 0;
      const groups = new Map();
      this.root.traverse((object) => {
        const list = Array.isArray(object.material)
          ? object.material
          : object.material ? [object.material] : [];
        for (const material of list) {
          const envClass = material?.userData?.envClass;
          if (!envClass || !('envMapIntensity' in material)) continue;
          let bucket = groups.get(envClass);
          if (!bucket) {
            bucket = new Set();
            groups.set(envClass, bucket);
          }
          bucket.add(material);
        }
      });
      this.envMaterialGroups = groups;
    }
    const table = {};
    let graded = 0;
    for (const [envClass, materials] of this.envMaterialGroups) {
      const intensity = envMapIntensityFor(envClass, model);
      table[envClass] = intensity;
      // Roughness and albedo, not just reflection strength. A wet surface
      // narrows its specular lobe because water fills the micro-relief, and it
      // darkens because light entering the film is internally reflected rather
      // than scattered back out. `envMapIntensity` alone reads as dry paint
      // with a sheen, which is what the drizzle bucket looked like.
      let wet;
      try {
        wet = wetSurfaceGrade(envClass, model);
      } catch {
        wet = { roughnessScale: 1, colorScale: 1 };
      }
      for (const material of materials) {
        if (texture && material.envMap !== texture) {
          // Introducing an envMap where there was none changes the program.
          if (!material.envMap) material.needsUpdate = true;
          material.envMap = texture;
        }
        material.envMapIntensity = intensity;
        if ('roughness' in material) {
          if (!Number.isFinite(material.userData.dryRoughness)) {
            material.userData.dryRoughness = material.roughness;
          }
          material.roughness = clamp(material.userData.dryRoughness * wet.roughnessScale, 0, 1);
        }
        if (material.color) {
          if (!material.userData.dryColor) material.userData.dryColor = material.color.clone();
          material.color.copy(material.userData.dryColor).multiplyScalar(wet.colorScale);
        }
        graded += 1;
      }
    }
    this.environmentDiagnostics = {
      pass: model.version || null,
      weather: this.envWeather,
      gradedMaterials: graded,
      envMapIntensity: table,
      lightRig: model.lightRig ? { ...model.lightRig.scales } : null,
      textureReady: Boolean(texture),
    };
    return graded;
  }

  async loadGroundMaterialTextures() {
    const loader = new THREE.TextureLoader();
    this.groundMaterialLifecycle.textureAttemptCount += 1;
    const loadTexture = async (key) => {
      const asset = GROUND_MATERIAL_ASSETS[key];
      this.groundMaterialLifecycle.textureLoadCount += 1;
      const texture = await loader.loadAsync(asset.url);
      const image = texture.image;
      const actualWidth = Number(image?.naturalWidth || image?.videoWidth || image?.width || 0);
      const actualHeight = Number(image?.naturalHeight || image?.videoHeight || image?.height || 0);
      texture.name = `sf-ground-${key}-v1`;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = GROUND_MATERIAL_ANISOTROPY;
      texture.needsUpdate = true;
      return { key, texture, actualWidth, actualHeight };
    };
    const results = await Promise.allSettled([
        loadTexture('asphalt'),
        loadTexture('sidewalk'),
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    const invalid = results.find((result) => result.status === 'fulfilled'
      && (result.value.actualWidth !== GROUND_MATERIAL_ASSETS[result.value.key].width
        || result.value.actualHeight !== GROUND_MATERIAL_ASSETS[result.value.key].height));
    if (rejected || invalid) {
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        result.value.texture.dispose();
        this.groundMaterialLifecycle.failedLoadTextureDisposeCount += 1;
      }
      this.groundMaterialLifecycle.textureLoadCount = 0;
      this.groundMaterialLifecycle.textureLoadedCount = 0;
      this.groundMaterialLifecycle.textureFailureCount += 1;
      this.groundMaterialTexturesReady = null;
      const error = rejected?.reason || new Error(
        `${invalid.value.key}-dimensions:${invalid.value.actualWidth}x${invalid.value.actualHeight}`,
      );
      this.groundMaterialDiagnostics.failure = `texture-load:${error?.message || 'unknown'}`;
      this.syncGroundMaterialDiagnostics();
      throw error;
    }
    try {
      const [asphalt, sidewalk] = results.map((result) => result.value.texture);
      this.groundMaterialLifecycle.textureLoadedCount += 2;
      this.groundMaterialTextures = Object.freeze({ asphalt, sidewalk });
      this.groundMaterialDiagnostics.failure = null;
      this.syncGroundMaterialDiagnostics();
      if (this.groundMaterialLifecycle.disposeRequested) {
        this.disposeGroundMaterialTextures();
        throw new Error('renderer-disposed-during-ground-texture-load');
      }
      return this.groundMaterialTextures;
    } catch (error) {
      this.groundMaterialTexturesReady = null;
      this.groundMaterialLifecycle.textureFailureCount += 1;
      this.groundMaterialDiagnostics.failure = `texture-load:${error?.message || 'unknown'}`;
      this.syncGroundMaterialDiagnostics();
      throw error;
    }
  }

  ensureGroundMaterialTextures() {
    if (this.groundMaterialTextures) return Promise.resolve(this.groundMaterialTextures);
    if (!this.groundMaterialTexturesReady) {
      this.groundMaterialTexturesReady = this.loadGroundMaterialTextures();
    }
    return this.groundMaterialTexturesReady;
  }

  syncGroundMaterialDiagnostics() {
    this.groundMaterialDiagnostics.lifecycle = { ...this.groundMaterialLifecycle };
    if (!this.groundMaterialTextures) return;
    for (const [key, texture] of Object.entries(this.groundMaterialTextures)) {
      const image = texture.image;
      const actualWidth = Number(image?.naturalWidth || image?.videoWidth || image?.width || 0) || null;
      const actualHeight = Number(image?.naturalHeight || image?.videoHeight || image?.height || 0) || null;
      Object.assign(this.groundMaterialDiagnostics.assets[key], {
        actualWidth,
        actualHeight,
        loaded: actualWidth === GROUND_MATERIAL_ASSETS[key].width
          && actualHeight === GROUND_MATERIAL_ASSETS[key].height,
      });
    }
  }

  isGroundMaterialTexture(texture) {
    return Boolean(texture && this.groundMaterialTextures
      && Object.values(this.groundMaterialTextures).includes(texture));
  }

  disposeGroundMaterialTextures() {
    this.groundMaterialLifecycle.disposeRequested = true;
    if (!this.groundMaterialTextures || this.groundMaterialLifecycle.disposed) {
      this.syncGroundMaterialDiagnostics();
      return;
    }
    for (const texture of Object.values(this.groundMaterialTextures)) {
      texture.dispose();
      this.groundMaterialLifecycle.textureDisposeCount += 1;
    }
    this.groundMaterialLifecycle.disposed = true;
    this.syncGroundMaterialDiagnostics();
    this.groundMaterialTextures = null;
    this.groundMaterialTexturesReady = null;
  }

  disposeWorldPartitionRuntime() {
    if (this.worldPartitionRuntime?.mesh) this.worldPartitionRuntime.mesh.dispose();
    this.worldPartitionRuntime = null;
    this.worldPartitionDiagnostics = createWorldPartitionDiagnostics();
  }

  disposePortalPartitionRuntime() {
    const runtime = this.portalPartitionRuntime;
    if (runtime) {
      for (const mesh of [
        runtime.panels,
        runtime.frames,
        runtime.lights,
        runtime.storefrontGlass,
        runtime.storefrontTrim,
      ]) mesh?.dispose();
    }
    const disposals = (this.portalPartitionDiagnostics.lifecycle?.disposals || 0) + (runtime ? 1 : 0);
    this.portalPartitionRuntime = null;
    this.portalPartitionDiagnostics = createPortalPartitionDiagnostics();
    this.portalPartitionDiagnostics.lifecycle.disposals = disposals;
  }

  disposeParkedCarPartitionRuntime() {
    const runtime = this.parkedCarPartitionRuntime;
    if (runtime) {
      runtime.bodies?.dispose();
      runtime.cabs?.dispose();
    }
    const disposals = (this.parkedCarPartitionDiagnostics.lifecycle?.disposals || 0) + (runtime ? 1 : 0);
    this.parkedCarPartitionRuntime = null;
    this.parkedCarPartitionDiagnostics = createParkedCarPartitionDiagnostics();
    this.parkedCarPartitionDiagnostics.lifecycle.disposals = disposals;
  }

  resize() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    this.passRuntime.dispose();
    this.passContext = null;
    disposeGroundCoverage(this.groundCoverage);
    this.groundCoverage = null;
    this.disposeCrowdPresentation();
    this.disposeWorldPartitionRuntime();
    this.disposePortalPartitionRuntime();
    this.disposeParkedCarPartitionRuntime();
    for (const geometry of new Set(this.geometryCache)) geometry.dispose();
    this.disposeGroundMaterialTextures();
    this.scene.environment = null;
    this.envRig?.dispose();
    this.envRig = null;
    this.envMaterialGroups = null;
    disposeAllDetailMaps();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setCity(city) {
    this.city = city;
    const isSf = isSanFranciscoCity(city);
    const bounds = city?.meta?.bounds;
    const mapSpan = bounds
      ? Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
      : 0;
    // The procedural sandbox is only a few blocks wide, while the built-in
    // OSM slice spans roughly two kilometres. Scale atmospheric depth with the
    // loaded map so aerial views retain road and skyline contrast instead of
    // fading almost the entire city into the horizon colour.
    if (this.scene.fog) {
      this.scene.fog.near = Math.max(330, mapSpan * 0.55);
      this.scene.fog.far = Math.max(1380, mapSpan * 1.5);
    }
    // Tallest thing that can throw a shadow into the fitted box. The near
    // plane has to be pulled back by roughly `height / sin(altitude)`, so at a
    // low sun this is the difference between a complete tower shadow and one
    // that stops halfway down the block. Measured from the source heights, plus
    // an allowance for the roof clutter and the terrain the shells stand on.
    const buildingHeights = Array.isArray(city?.buildings)
      ? city.buildings.map((building) => Number(building?.height)).filter(Number.isFinite)
      : [];
    const tallest = buildingHeights.length ? Math.max(...buildingHeights) : 0;
    this.maxCasterHeight = clamp(
      tallest + 60,
      60,
      SHADOW_FIT_DEFAULTS.maxCasterHeight * 2,
    );
    this.shadowDiagnostics.maxCasterHeight = this.maxCasterHeight;
    this.shadowFitSignature = null;
    // The baked SF grid is intentionally a little compressed for data use.
    // A restrained render-only lift restores the stepped hill silhouette while
    // keeping every road/building query on the same height function.
    this.terrainVisualScale = isSf ? 1.12 : 1;
    const sourceHeightAt = city?.terrain?.heightAt;
    if (sourceHeightAt) {
      this.terrain = {
        ...city.terrain,
        heightAt: (x, z) => {
          const value = Number(sourceHeightAt(x, z));
          return Number.isFinite(value) ? value * this.terrainVisualScale : 0;
        },
      };
    } else {
      this.terrain = {
        heightAt: (x, z) => terrainHeight(x, z, Number(city?.meta?.seedInt || 1)) * this.terrainVisualScale,
      };
    }
  }

  async buildCity(city, { focus = null, day = true } = {}) {
    this.setCity(city);
    this.day = day;
    // Facade relief picks its LOD ring from where the player will actually be.
    this.buildFocus = focus && Number.isFinite(focus.x) && Number.isFinite(focus.z)
      ? { x: focus.x, z: focus.z }
      : { x: this.camera.position.x, z: this.camera.position.z };
    this.appliedTimeOfDay = null;
    this.appliedNightState = null;
    // Dispose old dynamic geometry only; static materials persist for rebuilds.
    // The crowd is parented to `city-root`, so it has to go before the root it
    // hangs off is replaced - `clearCity` normally does this first, but
    // `buildCity` must not depend on having been called through it.
    this.disposeCrowdPresentation();
    for (const geometry of new Set(this.geometryCache)) geometry.dispose();
    this.geometryCache = [];
    this.pickables = [];
    this.neonGlowMaterials = [];
    this.lampBulbs = [];
    this.lampLights = [];
    this.neonLights = [];
    this.lightPools = [];
    this.localLightCandidates = [];
    this.localLightPool = [];
    this.localLightUpdateClock = 0;
    this.localLightsNight = false;
    this.disposeWorldPartitionRuntime();
    this.disposeParkedCarPartitionRuntime();
    this.streetLampRecords = [];
    this.streetLampDiagnostics = {
      source: city?.meta?.generator || null,
      fixtureCount: 0,
      candidateCount: 0,
      maxLamps: 0,
      sourceOwnedCount: 0,
      bandViolations: 0,
      asphaltOverlaps: 0,
      pointLightPoolSize: 0,
    };
    this.streetFurniture = { props: 0, cars: 0, awnings: 0, bunting: 0 };
    this.envMaterialGroups = null;
    this.streetSurface = null;
    this.streetSurfaceDiagnostics = { pass: STREET_SURFACE_PASS, drawCalls: 0, triangles: 0, stats: null };
    this.facadeDepthDiagnostics = createFacadeDepthDiagnostics();
    this.sidewalkPropRecords = [];
    this.sidewalkPropRuntime = null;
    this.sidewalkPropDiagnostics = {
      bandViolations: 0,
      asphaltOverlaps: 0,
      heroFrontages: createHeroSidewalkDiagnostics(),
    };
    this.buildingFootprintDiagnostics = {
      sourceCount: 0,
      polygonShells: 0,
      fallbacks: 0,
      finite: true,
      sourceArea: 0,
      renderedArea: 0,
      maxAreaRelativeError: 0,
      triangleCount: 0,
      triangleDelta: 0,
    };
    const root = new THREE.Group();
    root.name = 'city-root';

    // Sky dome. The painted cloud shell that used to be added just inside it is
    // gone; see `makeSky` for why.
    root.add(this.makeSky(city));
    // Terrain base + park ground.
    //
    // This used to be `makeGround(city)`: a `PlaneGeometry` sized from
    // `city.meta.bounds` whose SAMPLE coordinates were offset by the bounds
    // centre but whose VERTICES never were, added to `city-root` at the world
    // origin. On the real slice (bounds x 577..2626, z -755..1407) that plane
    // spanned x +/-1284, z +/-1341 and so covered 33.5% of the map, containing
    // neither the slice centre nor any of the eight quality-card poses. Two
    // thirds of the world had nothing under it, and every ray that missed a
    // road ribbon or a building shell ran to `sky-dome`. That is what the hole
    // detector was measuring: 16.6% mean, 38.9% worst.
    //
    // `buildGroundCoverage` emits absolute world-metre vertices for the whole
    // slice plus a graded apron out to the fog horizon, in one draw call, so
    // the group MUST be added at identity.
    this.installGroundCoverage(root, city);
    this.buildTerrainContours(root, city);
    // OSM parks and water polygons on real maps.
    this.buildOsmParks(root, city);
    this.buildOsmWater(root, city);
    // Waterfront for the east edge.
    const water = this.makeWater(city);
    root.add(water);
    // Keep authored bay props under city-root so rebuilds dispose them with
    // the rest of the dynamic scene instead of leaking into the global scene.
    this.buildBayProps(root, city, city.meta.bounds);
    this.buildWaterfrontIdentity(root, city);

    // Buildings with per-facade canvas textures.
    this.roofBatch = { parapets: [], tanks: [], cells: [] };
    await this.buildBuildings(root, city);
    this.flushRoofDetails(root);
    // Soft contact shadows ground the buildings.
    this.buildContactShadows(root, city);
    // Roads, sidewalks, curbs, markings, crosswalks. SF surface assets stay
    // lazy so procedural verification worlds never fetch or allocate them.
    const usesSfGroundMaterials = (city.meta.generator === 'sf-builtin'
      || city.meta.generator === 'openstreetmap') && isSanFranciscoCity(city);
    if (usesSfGroundMaterials) await this.ensureGroundMaterialTextures();
    this.buildRoadNetwork(root, city);
    // Night neon trim along major avenues.
    this.buildStreetNeonTrim(root, city);
    // Festival bunting adds street-level color in daylight too.
    this.buildStreetBunting(root, city);
    // Utility poles and sagging wires along major avenues.
    this.buildUtilityLines(root, city);
    // Real SF transit routes get paired rails and restrained overhead wires;
    // generic/procedural maps do not inherit this city-specific clutter.
    this.buildTransitCues(root, city);
    // Signals with metadata.
    this.buildSignals(root, city);
    // Trees.
    this.buildTrees(root, city);
    // Curbside cars: saturated paint anchors the street-level color story.
    this.buildParkedCars(root, city);
    this.buildShopAwnings(root, city);
    this.installLocalLightPool(root);

    // Registered presentation passes see the finished world and add their own
    // content before the shadow policy pass gets the final word.
    this.buildPresentationPasses(root, city);

    // Last pass over the finished city: decide, per mesh, whether it is thick
    // enough for the shadow map to resolve. Everything above this line has
    // already written its own `castShadow`; this is the single place that gets
    // the final word, and it writes nothing else.
    this.applyShadowCasterPolicyPass(root);

    this.root = root;
    this.scene.add(root);
    this.camera.near = 0.5;
    this.camera.far = 4200;
    this.camera.updateProjectionMatrix();
    this.signalPhaseClock = 0;
    await this.prewarmLightingPipelines();
    return root;
  }

  async prewarmLightingPipelines() {
    if (typeof this.renderer.compileAsync !== 'function') return;
    const renderWarmup = !this.lightingPipelinesRendered
      && typeof this.renderer.renderAsync === 'function';
    const restoreHour = this.timeOfDay;
    this.appliedTimeOfDay = null;
    this.appliedNightState = null;
    this.setTimeOfDay(14);
    await this.renderer.compileAsync(this.scene, this.camera);
    if (renderWarmup) await this.renderer.renderAsync(this.scene, this.camera);
    this.setTimeOfDay(22);
    await this.renderer.compileAsync(this.scene, this.camera);
    if (renderWarmup) await this.renderer.renderAsync(this.scene, this.camera);
    this.setTimeOfDay(restoreHour);
    await this.renderer.compileAsync(this.scene, this.camera);
    if (renderWarmup) {
      await this.renderer.renderAsync(this.scene, this.camera);
      this.lightingPipelinesRendered = true;
    }
  }

  installMetricTileRoot(root, bounds) {
    for (const geometry of new Set(this.geometryCache)) geometry.dispose();
    this.geometryCache = [];
    this.city = null;
    this.root = root;
    this.scene.add(root);
    this.terrainVisualScale = 1;
    this.terrain = { heightAt: () => 0 };
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
    if (this.scene.fog) {
      this.scene.fog.near = Math.max(330, span * 0.55);
      this.scene.fog.far = Math.max(1380, span * 1.5);
    }
    this.camera.near = 0.5;
    this.camera.far = Math.max(2400, span * 2.2);
    this.camera.updateProjectionMatrix();
    return root;
  }

  clearCity() {
    // Everything this renderer allocates through a module goes back through
    // the same path the rest of the dynamic scene uses.
    this.passRuntime.dispose();
    this.passContext = null;
    disposeGroundCoverage(this.groundCoverage);
    this.groundCoverage = null;
    this.groundCoverageDiagnostics = { pass: GROUND_COVERAGE_PASS, built: false, drawCalls: 0, triangles: 0, stats: null };
    this.disposeCrowdPresentation();
    this.shadowCasterAudit = null;
    this.groundMaterialLifecycle.clearCount += 1;
    this.groundMaterialDiagnostics.enabled = false;
    this.syncGroundMaterialDiagnostics();
    this.disposeWorldPartitionRuntime();
    this.disposePortalPartitionRuntime();
    this.disposeParkedCarPartitionRuntime();
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((object) => {
        if (object.geometry) this.geometryCache.push(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
        for (const material of materials) {
          if (material.map && !this.isGroundMaterialTexture(material.map)) material.map.dispose();
          material.dispose();
        }
      });
      for (const entry of this.nightEmissive) {
        if (entry.nightTexture) entry.nightTexture.dispose();
      }
      if (this.contactShadowMaterial) this.contactShadowMaterial.dispose();
      this.nightEmissive = [];
      this.lampBulbs = [];
      this.lampLights = [];
      this.lightPools = [];
      this.neonLights = [];
      this.localLightCandidates = [];
      this.localLightPool = [];
      this.localLightUpdateClock = 0;
      this.localLightsNight = false;
      this.streetLampRecords = [];
      this.streetLampDiagnostics = {
        source: null,
        fixtureCount: 0,
        candidateCount: 0,
        maxLamps: 0,
        sourceOwnedCount: 0,
        bandViolations: 0,
        asphaltOverlaps: 0,
        pointLightPoolSize: 0,
      };
      this.sidewalkPropRecords = [];
      this.sidewalkPropRuntime = null;
      this.sidewalkPropDiagnostics = {
        bandViolations: 0,
        asphaltOverlaps: 0,
        heroFrontages: createHeroSidewalkDiagnostics(),
      };
      this.buildingFootprintDiagnostics = {
        sourceCount: 0,
        polygonShells: 0,
        fallbacks: 0,
        finite: true,
        sourceArea: 0,
        renderedArea: 0,
        maxAreaRelativeError: 0,
        triangleCount: 0,
        triangleDelta: 0,
      };
      this.heroFacadeDiagnostics = {
        asset: HERO_FACADE_ATLAS_URL,
        heroes: [],
        drawGroups: 0,
        triangleDelta: 0,
        atlasLoaded: false,
        streetwall: createHeroStreetwallDiagnostics(),
      };
      this.signalMeshes = [];
      this.envMaterialGroups = null;
      this.streetSurface = null;
      this.streetSurfaceDiagnostics = { pass: STREET_SURFACE_PASS, drawCalls: 0, triangles: 0, stats: null };
      this.facadeDepthDiagnostics = createFacadeDepthDiagnostics();
      this.root = null;
    }
  }

  /**
   * The sky dome.
   *
   * Until this pass a second, slightly smaller `SphereGeometry(1840)` shell
   * carrying a painted cloud texture was added immediately inside this dome. It
   * was unnamed, `MeshBasicMaterial`, `transparent`, and on the real-map
   * generators its opacity was `0.05`. It has been removed rather than fitted,
   * for three reasons:
   *
   *  1. At 0.05 it contributed nothing readable as cloud, but it was still the
   *     first surface a ray met through any gap in the world - which is exactly
   *     how it was found. The pale polygon in the street card was this shell,
   *     seen at 1.2 km through a hole in the footway, and the stray diagonal in
   *     the night card was its painted blob band crossing the frame.
   *  2. `scene.environment` now carries an analytic sky whose radiance, sun
   *     position and weather all come from one model. A hand-painted warm cloud
   *     band drawn over the top of it is a second, contradictory sky; nothing
   *     graded it with the hour, so at night it laid warm paint on a blue dome.
   *  3. It cost a full-screen transparent draw and a 512x256 canvas texture per
   *     city build to do that.
   *
   * The dome itself stays: it is the only background this scene has. It is now
   * named, so the next time something falls through the world the diagnosis is
   * in the report instead of having to be re-derived.
   */
  makeSky(city) {
    const bounds = city.meta.bounds;
    const skyCenterX = (bounds.minX + bounds.maxX) / 2;
    const skyCenterZ = (bounds.minZ + bounds.maxZ) / 2;
    const geometry = new THREE.SphereGeometry(1900, 32, 16);
    const colors = [];
    const positions = geometry.attributes.position.array;
    const top = new THREE.Color('#4f9fd6');
    const mid = new THREE.Color('#8cc8e2');
    const bottom = new THREE.Color('#ffe2b8');
    for (let i = 0; i < positions.length; i += 3) {
      const y = positions[i + 1] / 1900;
      const c = y > 0.08 ? top.clone().lerp(mid, clamp(y, 0, 1)) : bottom.clone().lerp(mid, 1 - clamp(-y, 0, 1) * 4);
      colors.push(c.r, c.g, c.b);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(geometry, material);
    // Deliberately left raycastable: a hole in the world should still be
    // reported, and now it is reported by name.
    sky.name = 'sky-dome';
    sky.position.set(skyCenterX, 0, skyCenterZ);
    sky.renderOrder = -10;
    this.geometryCache.push(geometry);
    this.skyMesh = sky;
    return sky;
  }

  /**
   * The ground carpet: one closed, world-positioned surface under everything.
   *
   * Replaces `makeGround`. See the call site in `buildCity` for why the old
   * base plane could not be repaired in place. Vertices are absolute world
   * metres, so the group is added at identity and never offset.
   *
   * `castShadow` stays false (a 29k-triangle carpet in the shadow map buys
   * nothing that the terrain contours and road surface do not already give),
   * and `receiveShadow` stays true, so this is not part of the caster set the
   * shadow policy below audits.
   */
  installGroundCoverage(root, city) {
    disposeGroundCoverage(this.groundCoverage);
    this.groundCoverage = null;
    this.groundCoverageDiagnostics = { pass: GROUND_COVERAGE_PASS, built: false, drawCalls: 0, triangles: 0, stats: null };
    try {
      const coverage = buildGroundCoverage(city, {
        heightAt: this.terrain?.heightAt ? (x, z) => this.terrain.heightAt(x, z) : null,
        palette: isSanFranciscoCity(city) ? 'sf' : 'stylised',
      });
      // No `maps.ground`. The SF ground textures are loaded lazily, later in
      // `buildCity`, so passing them here would texture the carpet on a rebuild
      // and leave it untextured on the first build - the same city rendering
      // two different ways. The carpet is a backstop under the paved surface;
      // its visible parts are yards, alleys and open land, which the vertex
      // palette already grades.
      root.add(coverage.group);
      this.geometryCache.push(coverage.geometry);
      this.groundCoverage = coverage;
      this.groundCoverageDiagnostics = {
        pass: GROUND_COVERAGE_PASS,
        built: true,
        drawCalls: coverage.drawCalls,
        triangles: coverage.stats?.triangles ?? 0,
        stats: coverage.stats,
      };
      return coverage;
    } catch (error) {
      // A missing carpet is a hole in the world, which is exactly what this
      // round is fixing, so say so loudly rather than rendering sky through
      // the pavement in silence.
      console.error(`[${GROUND_COVERAGE_PASS}] ground coverage failed to build; `
        + 'the world has no backstop surface and rays will reach the sky dome', error);
      this.groundCoverageDiagnostics.error = String(error?.message || error);
      return null;
    }
  }

  /**
   * Map a renderer `userData.kind` onto a shadow role.
   *
   * The name hints in `SHADOW_ROLE_HINTS` cover the meshes this renderer
   * names. It also merges whole classes of building into a handful of
   * city-wide, deliberately UNNAMED meshes (`buildings-textured`,
   * `buildings-flat`, `buildings-hero-textured`, ...), and those would fall
   * through to `unknown`. `unknown` is treated as a prop, which is the wrong
   * default for a merged streetwall, so the kind tag - which this renderer
   * already writes on every one of them - supplies the role instead.
   *
   * @returns {string|null} role, or null to let the module classify by name.
   */
  shadowRoleForMesh(object) {
    const kind = String(object?.userData?.kind || '');
    if (!kind) return null;
    if (kind === 'building' || kind === 'glass' || kind.startsWith('buildings-')
      || kind.startsWith('hero-building') || kind.startsWith('hero-roof')) {
      return SHADOW_ROLES.STRUCTURE;
    }
    if (kind === 'asphalt' || kind === 'sidewalk' || kind === 'roads'
      || kind === 'sidewalks' || kind === 'ground') {
      return SHADOW_ROLES.TERRAIN;
    }
    if (kind === 'road-markings') return SHADOW_ROLES.DECAL;
    return null;
  }

  /**
   * Shadow-caster admission, run once per city build.
   *
   * The measured caster set was 297 meshes, of which 143 had a smallest
   * bounding-box dimension under 0.35 m and 137 of those were shopfront
   * awnings - 0.14 m plates, 12 m long. At the fitted texel size an awning is
   * well under one shadow texel, and the `normalBias` the map needs to stay
   * free of slope acne is itself larger than the plate is thick, so the depth
   * comparison flips on sub-texel detail. That is the dark X-shaped banding
   * lying across real roadway in the night card. No bias serves both; at this
   * texel size exclusion is the only correct answer.
   *
   * Three deliberate constraints on how the policy is applied here:
   *
   *  1. **It can only take shadows away, never grant them.** Only meshes that
   *     already have `castShadow === true` are considered. Several modules
   *     switch casting off on purpose - `street-surface-v2` does it for the
   *     carriageway, because a flat road that shadows itself is pure acne -
   *     and a role-based promotion would silently undo that decision.
   *  2. **No `groundHeightAt`, so the ground-flush gate never runs.** That
   *     gate looks for a thin plate resting on the ground by aspect ratio, and
   *     this renderer merges whole classes of building into single city-wide
   *     meshes whose bounding box is ~2 km x 60 m x 2 km - a 30:1 "plate"
   *     sitting on the terrain. It would have excluded the entire streetwall.
   *     Nothing is lost: a real ground decal is ~1 cm thick and the thickness
   *     gate already refuses it.
   *  3. **No `ringCentre`, so the ring gate never runs.** The fitted box
   *     follows the camera; a build-time ring test would permanently silence
   *     every caster that happened to be far from the build focus.
   *
   * Not per-frame: this is a `Box3.setFromObject` per mesh. The texel size is
   * invariant to where the camera looks (see the `SUN_SHADOW_PASS` note), so
   * one pass describes every frame this build will draw.
   *
   * Writes exactly one property, `castShadow`. `receiveShadow` is untouched:
   * an awning that cannot cast should still be shaded by the wall above it.
   */
  applyShadowCasterPolicyPass(root) {
    const texelWorldSize = Number.isFinite(this.shadowFit?.texelWorldSize)
      ? this.shadowFit.texelWorldSize
      : MEASURED_TEXEL_WORLD_SIZE;
    const ringRadius = Number.isFinite(this.shadowFit?.halfExtent) && this.shadowFit.halfExtent > 0
      ? this.shadowFit.halfExtent
      : MEASURED_RING_RADIUS;
    let audit;
    try {
      const policy = createShadowCasterPolicy({ texelWorldSize, ringRadius });
      audit = createShadowCasterAudit();
      root.updateMatrixWorld(true);
      root.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh && !object.isBatchedMesh) return;
        if (object.castShadow !== true) return;
        const descriptor = measureShadowCaster(object);
        const role = this.shadowRoleForMesh(object);
        if (role) descriptor.role = role;
        const result = policy.decide(descriptor);
        object.castShadow = result.cast;
        audit.record(result, descriptor.name || object.userData?.kind || '(unnamed)');
      });
    } catch (error) {
      console.error(`[${SHADOW_CASTER_VERSION}] caster policy failed; the scene keeps `
        + 'the per-builder castShadow flags', error);
      return null;
    }
    this.shadowCasterAudit = audit;
    this.shadowDiagnostics.casterPolicy = audit.toJSON();
    this.shadowDiagnostics.casters = audit.casting;
    this.shadowDiagnostics.castersExcluded = audit.excluded;
    if (!this.shadowCasterLogged) {
      this.shadowCasterLogged = true;
      // Once, at startup. Deterministic: the histogram is ordered by the
      // module's declared code order, not by traversal order.
      console.info(summariseShadowCasterAudit(audit, SHADOW_CASTER_VERSION));
    }
    return audit;
  }

  buildTerrainContours(root, city) {
    const terrainType = String(city?.terrain?.type || city?.meta?.terrain?.type || '');
    const sfCity = isSanFranciscoCity(city);
    if (!sfCity && terrainType !== 'soft-hills') return;
    const bounds = city.meta.bounds;
    const columns = sfCity ? 30 : 22;
    const rows = sfCity ? 30 : 22;
    const heights = new Array((columns + 1) * (rows + 1));
    let min = Infinity;
    let max = -Infinity;
    const heightAt = (x, z) => this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0;
    for (let row = 0; row <= rows; row += 1) {
      const z = bounds.minZ + (bounds.maxZ - bounds.minZ) * (row / rows);
      for (let col = 0; col <= columns; col += 1) {
        const x = bounds.minX + (bounds.maxX - bounds.minX) * (col / columns);
        const y = heightAt(x, z);
        heights[row * (columns + 1) + col] = y;
        min = Math.min(min, y);
        max = Math.max(max, y);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 7) return;
    const contourCount = sfCity ? 8 : 6;
    const step = (max - min) / (contourCount + 1);
    const positions = [];
    const waterPolygons = (city.water || []).map((water) => water.polygon).filter(Boolean);
    const pointIsWater = (x, z) => waterPolygons.some((polygon) => pointInPolygon({ x, z }, polygon));
    const addEdge = (level, a, ay, b, by, hits) => {
      if ((ay < level && by >= level) || (by < level && ay >= level)) {
        const span = by - ay;
        const t = Math.abs(span) < 0.0001 ? 0.5 : clamp((level - ay) / span, 0, 1);
        hits.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: level + 0.09 });
      }
    };
    for (let contourIndex = 1; contourIndex <= contourCount; contourIndex += 1) {
      const level = min + step * contourIndex;
      for (let row = 0; row < rows; row += 1) {
        const z0 = bounds.minZ + (bounds.maxZ - bounds.minZ) * (row / rows);
        const z1 = bounds.minZ + (bounds.maxZ - bounds.minZ) * ((row + 1) / rows);
        for (let col = 0; col < columns; col += 1) {
          const x0 = bounds.minX + (bounds.maxX - bounds.minX) * (col / columns);
          const x1 = bounds.minX + (bounds.maxX - bounds.minX) * ((col + 1) / columns);
          if (pointIsWater((x0 + x1) * 0.5, (z0 + z1) * 0.5)) continue;
          const i00 = row * (columns + 1) + col;
          const i10 = i00 + 1;
          const i11 = i10 + columns + 1;
          const i01 = i00 + columns + 1;
          const hits = [];
          addEdge(level, { x: x0, z: z0 }, heights[i00], { x: x1, z: z0 }, heights[i10], hits);
          addEdge(level, { x: x1, z: z0 }, heights[i10], { x: x1, z: z1 }, heights[i11], hits);
          addEdge(level, { x: x1, z: z1 }, heights[i11], { x: x0, z: z1 }, heights[i01], hits);
          addEdge(level, { x: x0, z: z1 }, heights[i01], { x: x0, z: z0 }, heights[i00], hits);
          if (hits.length >= 2) {
            const a = hits[0];
            const b = hits[1];
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
          }
        }
      }
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: sfCity ? 0x8b755d : 0x647151,
      transparent: true,
      opacity: sfCity ? 0.18 : 0.13,
      depthWrite: false,
    });
    const contours = new THREE.LineSegments(geometry, material);
    contours.name = 'elevation-contours';
    contours.renderOrder = 1;
    root.add(contours);
    this.geometryCache.push(geometry, material);
  }

  makeWater(city) {
    const bounds = city.meta.bounds;
    const geometry = new THREE.PlaneGeometry(680, bounds.maxZ - bounds.minZ + 520);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x2f8fae,
      roughness: 0.24,
      metalness: 0.3,
      transparent: true,
      opacity: 0.96,
    });
    const water = new THREE.Mesh(geometry, material);
    water.position.set(bounds.maxX - 70, 0.5, (bounds.minZ + bounds.maxZ) / 2);
    water.receiveShadow = true;
    this.geometryCache.push(geometry);
    this.water = water;
    return water;
  }

  buildWaterfrontIdentity(root, city) {
    if (!isSanFranciscoCity(city) && !(city.water || []).length) return;
    const bounds = city.meta.bounds;
    const random = mulberry32(Number(city.meta.seedInt || 1) + 6011);
    const attrs = dynQuadAttrs();
    const waterX = bounds.maxX - 70;
    const spanZ = Math.max(40, bounds.maxZ - bounds.minZ - 20);
    // Short, sparse low-poly ripples make the bay legible without a heavy
    // normal-map or thousands of individual meshes.
    for (let i = 0; i < 96; i += 1) {
      const x = waterX - 270 + random() * 540;
      const z = bounds.minZ + 10 + random() * spanZ;
      const length = 3.5 + random() * 14;
      const width = 0.055 + random() * 0.055;
      const color = i % 3 === 0 ? new THREE.Color('#8bc4cb') : new THREE.Color('#5ea9ba');
      pushQuadDyn(attrs,
        { x: x - length / 2, y: 0.72 + random() * 0.02, z: z - width },
        { x: x + length / 2, y: 0.72 + random() * 0.02, z: z - width },
        { x: x + length / 2, y: 0.72 + random() * 0.02, z: z + width },
        { x: x - length / 2, y: 0.72 + random() * 0.02, z: z + width },
        color,
      );
    }
    const geometry = buildDynGeometry(attrs);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.48,
      roughness: 0.28,
      metalness: 0.18,
      depthWrite: false,
    });
    const ripples = new THREE.Mesh(geometry, material);
    ripples.name = 'bay-ripple-cards';
    ripples.renderOrder = 2;
    root.add(ripples);
    this.geometryCache.push(geometry, material);
  }

  buildOsmParks(root, city) {
    const parks = city.parks || [];
    if (!parks.length) return;
    const parkMaterial = new THREE.MeshStandardMaterial({ color: 0x9fc38a, roughness: 1, flatShading: true });
    const pathMaterial = new THREE.MeshStandardMaterial({ color: 0xdfc69c, roughness: 0.95, flatShading: true });
    const treeMaterial = new THREE.MeshStandardMaterial({ color: 0x4f7f4a, roughness: 0.9, flatShading: true });
    const random = mulberry32(Number(city.meta.seedInt || 1) + 7711);
    for (const park of parks) {
      const points = park.polygon;
      if (!points || points.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(points[0].x, points[0].z);
      for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i].x, points[i].z);
      shape.closePath();
      const geometry = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geometry, parkMaterial);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.03;
      mesh.receiveShadow = true;
      root.add(mesh);
      this.geometryCache.push(geometry);
      const pathGeo = new THREE.ShapeGeometry(shape);
      const path = new THREE.Mesh(pathGeo, pathMaterial);
      path.rotation.x = -Math.PI / 2;
      path.position.y = 0.045;
      path.receiveShadow = true;
      root.add(path);
      this.geometryCache.push(pathGeo);
      const bounds = polygonBounds(points);
      const count = Math.min(80, Math.max(6, Math.round((bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ) / 900)));
      for (let i = 0; i < count; i += 1) {
        const x = bounds.minX + random() * (bounds.maxX - bounds.minX);
        const z = bounds.minZ + random() * (bounds.maxZ - bounds.minZ);
        if (!pointInPolygon({ x, z }, points)) continue;
        const tree = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.4, 6), treeMaterial);
        tree.position.set(x, 1.2, z);
        tree.castShadow = true;
        root.add(tree);
        this.geometryCache.push(tree.geometry);
      }
    }
  }

  buildOsmWater(root, city) {
    const waters = city.water || [];
    if (!waters.length) return;
    const waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f8fae,
      roughness: 0.24,
      metalness: 0.3,
      transparent: true,
      opacity: 0.94,
    });
    for (const water of waters) {
      const points = water.polygon;
      if (!points || points.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(points[0].x, points[0].z);
      for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i].x, points[i].z);
      shape.closePath();
      const geometry = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geometry, waterMaterial);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.16;
      mesh.receiveShadow = true;
      root.add(mesh);
      this.geometryCache.push(geometry);
    }
  }

  buildBayProps(scene, city, bounds) {
    // The bay bridge silhouette belongs to the SF waterfront slice. Keeping
    // it out of procedural maps removes the old center-frame pole/arm that
    // read as an accidental obstruction in aerial and street captures.
    if (!isSanFranciscoCity(city) && !(city.water || []).length) return;
    const y = 0.52;
    const towerX = bounds.maxX - 220;
    const towerZ = (bounds.minZ + bounds.maxZ) / 2 + 40;
    const towerHeight = clamp((bounds.maxZ - bounds.minZ) * 0.09, 28, 52);
    const towerMaterial = new THREE.MeshStandardMaterial({
      color: 0x8a9399,
      roughness: 0.6,
      metalness: 0.55,
      flatShading: true,
    });
    const deckMaterial = new THREE.MeshStandardMaterial({
      color: 0xb25f4a,
      roughness: 0.8,
      flatShading: true,
    });
    const towerGeometry = new THREE.BoxGeometry(3.8, towerHeight, 3.8);
    const left = new THREE.Mesh(towerGeometry, towerMaterial);
    left.position.set(towerX - 74, y + towerHeight / 2, towerZ);
    const right = new THREE.Mesh(towerGeometry, towerMaterial);
    right.position.set(towerX + 74, y + towerHeight / 2, towerZ);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(184, 3.4, 7), deckMaterial);
    deck.position.set(towerX, y + 4.0, towerZ);
    scene.add(left, right, deck);
    const cableMaterial = new THREE.LineBasicMaterial({ color: 0xdfe6ea, transparent: true, opacity: 0.85 });
    for (let i = 0; i <= 10; i += 1) {
      const t = i / 10;
      const points = [];
      const sag = 14;
      for (let s = 0; s <= 10; s += 1) {
        const st = s / 10;
        points.push(new THREE.Vector3(
          towerX - 74 + 148 * st,
          y + towerHeight + (Math.sin(st * Math.PI) * -sag * 0.75) + (t - 0.5) * 2,
          towerZ - 4.2 + t * 8.4,
        ));
      }
      const cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), cableMaterial);
      scene.add(cable);
      this.geometryCache.push(cable.geometry);
    }
    this.geometryCache.push(towerGeometry, deck.geometry);
    const boatMaterial = new THREE.MeshStandardMaterial({
      color: 0xcfd6d8,
      roughness: 0.6,
      flatShading: true,
    });
    const boatRandom = mulberry32(Number(city.meta.seedInt || 1) + 44);
    for (let i = 0; i < 5; i += 1) {
      const boat = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.BoxGeometry(7, 1.6, 2.6), boatMaterial);
      hull.position.y = 0.8;
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 1.8, 1.8), deckMaterial);
      cabin.position.set(-0.4, 2.3, 0);
      boat.add(hull, cabin);
      boat.position.set(
        towerX - 140 + boatRandom() * 260,
        y,
        bounds.minZ + 40 + boatRandom() * (bounds.maxZ - bounds.minZ - 80),
      );
      boat.rotation.y = boatRandom() * Math.PI;
      scene.add(boat);
      this.geometryCache.push(hull.geometry, cabin.geometry);
    }
  }

  async buildBuildings(root, city) {
    const flatGroups = new Map();
    // Buildings that ended up with a true polygon shell are the only ones that
    // get additive facade relief: the module works from `building.polygon`, and
    // on an AABB fallback shell the trim would not sit on the rendered wall.
    const depthCandidates = [];
    const depthBaseY = new Map();
    // Textured facades are bucketed by (facade, material, vivid, variety) so
    // hundreds of real-map buildings share ~90 cached day/night texture pairs
    // and merge into one mesh per bucket instead of one mesh per building.
    const textureGroups = new Map();
    const heroTextureGroups = new Map();
    const heroRoofEntries = [];
    const facadeSeed = Number(city.meta.seedInt || 1);
    const random = mulberry32(facadeSeed);
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    let heroTextures = null;
    if (realMap) {
      try {
        heroTextures = await loadHeroFacadeTextures();
      } catch (error) {
        console.warn(`Hero facade atlas unavailable: ${error.message}`);
      }
    }
    this.heroFacadeDiagnostics = {
      asset: HERO_FACADE_ATLAS_URL,
      heroes: [],
      drawGroups: 0,
      triangleDelta: 0,
      atlasLoaded: Boolean(heroTextures),
      streetwall: createHeroStreetwallDiagnostics(),
    };
    const footprintDiagnostics = {
      sourceCount: realMap ? city.buildings.length : 0,
      polygonShells: 0,
      fallbacks: 0,
      finite: true,
      sourceArea: 0,
      renderedArea: 0,
      maxAreaRelativeError: 0,
      triangleCount: 0,
      triangleDelta: 0,
    };

    for (const building of city.buildings) {
      const sourcePoints = Array.isArray(building.polygon) ? building.polygon : [];
      const footprint = realMap ? normalizeBuildingFootprint(sourcePoints) : null;
      const points = footprint || sourcePoints;
      if (points.length < 3) {
        if (realMap) {
          footprintDiagnostics.fallbacks += 1;
          footprintDiagnostics.finite = false;
        }
        continue;
      }
      const landmarkKey = landmarkKind(building);
      if (landmarkKey && !realMap) {
        const minX = Math.min(...points.map((p) => p.x));
        const maxX = Math.max(...points.map((p) => p.x));
        const minZ = Math.min(...points.map((p) => p.z));
        const maxZ = Math.max(...points.map((p) => p.z));
        const width = maxX - minX;
        const depth = maxZ - minZ;
        const height = building.height;
        const baseY = this.terrain?.heightAt ? this.terrain.heightAt((minX + maxX) / 2, (minZ + maxZ) / 2) : 0;
        this.buildLandmark(root, landmarkKey, building, width, depth, height, baseY, minX, minZ);
        continue;
      }
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minZ = Math.min(...points.map((p) => p.z));
      const maxZ = Math.max(...points.map((p) => p.z));
      const width = maxX - minX;
      const depth = maxZ - minZ;
      if (width < 2 || depth < 2) continue;
      const height = building.height;
      const baseY = this.terrain?.heightAt ? this.terrain.heightAt((minX + maxX) / 2, (minZ + maxZ) / 2) : 0;
      const center = new THREE.Vector3((minX + maxX) / 2, baseY + height / 2, (minZ + maxZ) / 2);
      const isFlat = building.type === 'warehouse' || building.type === 'civic' || building.type === 'park';
      const textureRoll = random();
      const useTexture = HERO_FACADE_IDS.has(building.id) || (!isFlat && textureRoll < 0.88);
      const materialKey = building.material;
      const sourceArea = footprint ? Math.abs(signedFootprintArea(footprint)) : ringArea(points);
      let shell = footprint ? polygonExtrusionGeometry(footprint, height, baseY) : null;
      const shellAreaError = shell && sourceArea > BUILDING_FOOTPRINT_EPSILON
        ? Math.abs(shell.renderedArea - sourceArea) / sourceArea
        : Infinity;
      if (shell && (!Number.isFinite(shellAreaError) || shellAreaError > 0.001)) {
        shell.geometry.dispose();
        shell = null;
      }
      const footprintMode = realMap && shell ? 'polygon-footprint' : 'legacy-aabb';
      if (footprintMode === 'polygon-footprint') {
        depthCandidates.push(building);
        depthBaseY.set(building.id, baseY);
      }
      let geometry;
      let renderedArea;
      let triangleCount;
      if (shell) {
        geometry = shell.geometry;
        renderedArea = shell.renderedArea;
        triangleCount = shell.triangleCount;
        footprintDiagnostics.polygonShells += 1;
      } else {
        geometry = new THREE.BoxGeometry(width, height, depth);
        geometry.translate(center.x, baseY + height / 2, center.z);
        renderedArea = width * depth;
        triangleCount = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
        if (realMap) footprintDiagnostics.fallbacks += 1;
      }
      if (realMap) {
        const relativeError = sourceArea > BUILDING_FOOTPRINT_EPSILON
          ? Math.abs(renderedArea - sourceArea) / sourceArea
          : renderedArea > BUILDING_FOOTPRINT_EPSILON ? 1 : 0;
        footprintDiagnostics.sourceArea += sourceArea;
        footprintDiagnostics.renderedArea += renderedArea;
        footprintDiagnostics.maxAreaRelativeError = Math.max(footprintDiagnostics.maxAreaRelativeError, relativeError);
        footprintDiagnostics.triangleCount += triangleCount;
        footprintDiagnostics.triangleDelta += triangleCount - 12;
        footprintDiagnostics.finite = footprintDiagnostics.finite
          && Number.isFinite(sourceArea)
          && Number.isFinite(renderedArea)
          && Number.isFinite(relativeError)
          && Array.from(geometry.attributes.position.array).every(Number.isFinite);
      }
      if (footprint && HERO_ROOF_PROFILES.has(building.id)) {
        heroRoofEntries.push({
          id: building.id,
          points: footprint.map((point) => ({ ...point })),
          baseY,
          height,
          profile: HERO_ROOF_PROFILES.get(building.id),
        });
      }

      if (useTexture) {
        const facadeStyle = building.facade || 'modern-grid';
        const atlasGroupKey = realMap && footprintMode === 'polygon-footprint' && heroTextures
          ? heroFacadeMaterialGroup(building)
          : null;
        if (atlasGroupKey) {
          const atlasCell = heroFacadeCell(building, atlasGroupKey);
          const isHeroStreetwall = HERO_FACADE_IDS.has(building.id);
          const remap = remapPolygonFacadeToAtlas(
            geometry,
            footprint.length,
            atlasCell.cell,
            isHeroStreetwall,
          );
          let atlasGroup = heroTextureGroups.get(atlasGroupKey);
          if (!atlasGroup) {
            atlasGroup = { geoms: [], material: atlasGroupKey, buildingIds: [], patternKeys: new Set() };
            heroTextureGroups.set(atlasGroupKey, atlasGroup);
          }
          atlasGroup.geoms.push(geometry);
          atlasGroup.buildingIds.push(building.id);
          atlasGroup.patternKeys.add(atlasCell.pattern);
          this.geometryCache.push(geometry);
          if (HERO_FACADE_IDS.has(building.id)) {
            const streetwall = {
              atlasCell: atlasCell.cell,
              wallEdges: remap.wallEdges,
              wallVertices: remap.wallVertices,
              contactTreatment: HERO_STREETWALL_CONTACT_TREATMENT,
              facadeNeutralVertices: remap.facadeNeutralVertices,
              finite: remap.finite,
            };
            this.heroFacadeDiagnostics.heroes.push({
              id: building.id,
              footprintMode,
              finite: remap.finite,
              roofline: true,
              cornice: true,
              parapet: true,
              patternKeys: [atlasCell.pattern],
              presentation: 'atlas-baked',
              cell: atlasCell.cell,
              streetwall,
              entrance: null,
            });
            const diagnostics = this.heroFacadeDiagnostics.streetwall;
            diagnostics.treatedIds.push(building.id);
            diagnostics.wallEdges += streetwall.wallEdges;
            diagnostics.wallVertices += streetwall.wallVertices;
            diagnostics.facadeNeutralVertices += streetwall.facadeNeutralVertices;
          }
          continue;
        }
        const varietyCount = realMap ? 6 : 2;
        const variety = Math.floor(hashString(`${facadeStyle}-${building.material}-${building.id}`) % varietyCount);
        const vividFacade = building.type === 'shop' || facadeStyle === 'shopfront';
        const key = `${facadeStyle}|${building.material}|${vividFacade ? 1 : 0}|${variety}`;
        const bucketKey = `${key}|${footprintMode}`;
        let group = textureGroups.get(bucketKey);
        if (!group) {
          group = {
            geoms: [],
            facadeStyle,
            material: building.material,
            vivid: vividFacade,
            variety,
            textureKey: key,
            footprintMode,
          };
          textureGroups.set(bucketKey, group);
        }
        if (footprintMode === 'legacy-aabb') {
          const repeatY = Math.max(1, Math.round(height / BUILDING_UV_METRES_Y));
          const repeatX = Math.max(1, Math.round(width / BUILDING_UV_METRES_X));
          // Preserve the legacy per-face repeat for procedural and malformed
          // source fallbacks; polygon shells already carry metric wall UVs.
          const uv = geometry.attributes.uv;
          for (let i = 0; i < uv.count; i += 1) {
            uv.setX(i, uv.getX(i) * repeatX);
            uv.setY(i, uv.getY(i) * repeatY);
          }
        }
        group.geoms.push(geometry);
        this.geometryCache.push(geometry);
        // Legacy rooftop props are placed from the AABB and can float outside
        // a corrected polygon shell. Keep them only on the box fallback until
        // roof details consume the source polygon contract directly.
        if (footprintMode === 'legacy-aabb') {
          this.addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, building.material, random);
        }
        continue;
      }

      // Flat-shaded vertex-color building, merged by material.
      const bucketKey = `${materialKey}|${footprintMode}`;
      let group = flatGroups.get(bucketKey);
      if (!group) {
        group = {
          geoms: [],
          colors: PALETTES[materialKey] || PALETTES.plaster,
          buildingIds: [],
          material: materialKey,
          footprintMode,
        };
        flatGroups.set(bucketKey, group);
      }
      // Per-face jitter + roof tone.
      const positions = geometry.attributes.position.array;
      const normals = geometry.attributes.normal.array;
      const faceColors = [];
      const colorList = group.colors;
      for (let i = 0; i < geometry.attributes.position.count; i += 1) {
        const r = mulberry32(facadeSeed + building.id.length + i);
        const baseColor = colorList[Math.floor(r() * colorList.length)];
        const isTop = normals[i * 3 + 1] > 0.5
          || Math.abs(positions[i * 3 + 1] - (baseY + height)) < 0.01;
        const c = isTop ? shade(colorFromHex(baseColor), -0.34) : shade(colorFromHex(baseColor), (r() - 0.5) * 0.14);
        faceColors.push(c.r, c.g, c.b);
      }
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(faceColors, 3));
      group.geoms.push(geometry);
      group.buildingIds.push(building.id);
      this.geometryCache.push(geometry);
      if (footprintMode === 'legacy-aabb') {
        this.addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, building.material, random);
      }
    }

    this.buildingFootprintDiagnostics = footprintDiagnostics;

    for (const [key, group] of heroTextureGroups) {
      const merged = mergeGeometries(group.geoms, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const heroRoughness = key === 'glass' ? 0.32 : key === 'concrete' ? 0.64 : 0.72;
      const material = new THREE.MeshStandardMaterial({
        map: heroTextures.texture,
        vertexColors: true,
        emissive: 0xffd29a,
        emissiveMap: heroTextures.nightTexture,
        emissiveIntensity: 0,
        roughness: heroRoughness,
        metalness: key === 'glass' ? 0.22 : 0.04,
        flatShading: true,
      });
      // The atlas already paints the openings, so these facades only take the
      // fine plaster grain: a structured relief map would fight the painting.
      if (key !== 'glass') {
        this.applyFacadeDetail(material, TEXTURED_FACADE_DETAIL_CLASS, {
          useAoMap: false,
          normalScale: 0.45,
          roughnessScale: detailRoughnessScale(TEXTURED_FACADE_DETAIL_CLASS, heroRoughness),
        });
      }
      material.userData.envClass = classifyMaterialClass(
        key === 'glass' ? { kind: 'glass' } : { material: key },
      );
      this.nightEmissive.push({
        material,
        texture: heroTextures.texture,
        nightTexture: heroTextures.nightTexture,
        nightIntensity: key === 'glass' ? 0.2 : 0.28,
      });
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = {
        kind: 'buildings-hero-textured',
        material: key,
        footprintMode: 'polygon-footprint',
        buildingIds: group.buildingIds,
        patternKeys: [...group.patternKeys],
      };
      root.add(mesh);
      this.pickables.push(mesh);
      this.geometryCache.push(merged);
      this.heroFacadeDiagnostics.drawGroups += 1;
    }
    this.heroFacadeDiagnostics.heroes.sort((a, b) => a.id.localeCompare(b.id));
    const streetwall = this.heroFacadeDiagnostics.streetwall;
    streetwall.treatedIds.sort();
    streetwall.finite = streetwall.treatedIds.length === streetwall.expectedIds.length
      && streetwall.treatedIds.every((id, index) => id === streetwall.expectedIds[index])
      && this.heroFacadeDiagnostics.heroes.every((hero) => hero.streetwall?.finite === true)
      && [
        streetwall.wallEdges,
        streetwall.wallVertices,
        streetwall.facadeNeutralVertices,
      ].every(Number.isFinite);
    streetwall.sourceFootprintsUnchanged = streetwall.finite;

    for (const [key, group] of flatGroups) {
      const merged = mergeGeometries(group.geoms, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.72,
        metalness: 0.04,
        flatShading: true,
      });
      // No albedo texture here, so this group can carry the full class relief:
      // brick courses, plaster grain, cavity occlusion.
      const flatDetailClass = facadeDetailClass(group.material);
      this.applyFacadeDetail(material, flatDetailClass, {
        aoMapIntensity: 0.8,
        roughnessScale: detailRoughnessScale(flatDetailClass, 0.72),
      });
      material.userData.envClass = classifyMaterialClass({ material: group.material });
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = {
        kind: 'buildings-flat',
        material: group.material,
        footprintMode: group.footprintMode,
      };
      root.add(mesh);
      this.pickables.push(mesh);
      // Per-building pick metadata via spatial map in main.
    }

    for (const [key, group] of textureGroups) {
      const merged = mergeGeometries(group.geoms, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const textureSeed = facadeSeed + hashString(group.textureKey) * 17;
      const dayRnd = mulberry32(textureSeed);
      const texture = seededTexture(textureSeed, (context, w, h) => {
        drawFacade(context, w, h, dayRnd, group.facadeStyle, group.material, { day: true, vivid: group.vivid });
      }, 128, 192);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      const nightRnd = mulberry32(textureSeed);
      const nightTexture = seededTexture(textureSeed + 31, (context, w, h) => {
        drawFacade(context, w, h, nightRnd, group.facadeStyle, group.material, { day: false, vivid: group.vivid });
      }, 128, 192);
      nightTexture.wrapS = THREE.RepeatWrapping;
      nightTexture.wrapT = THREE.RepeatWrapping;
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        emissive: 0xfff0b8,
        emissiveMap: nightTexture,
        emissiveIntensity: 0,
        roughness: 0.68,
        metalness: 0.06,
        flatShading: true,
      });
      this.applyFacadeDetail(material, TEXTURED_FACADE_DETAIL_CLASS, {
        useAoMap: false,
        normalScale: 0.5,
        roughnessScale: detailRoughnessScale(TEXTURED_FACADE_DETAIL_CLASS, 0.68),
      });
      material.userData.envClass = classifyMaterialClass({
        material: group.material,
        facade: group.facadeStyle,
      });
      const nightIntensity = (group.material === 'glass' ? 0.26 : 0.34)
        + (hashString(`${group.textureKey}-night`) % 18) / 100;
      this.nightEmissive.push({ material, texture, nightTexture, nightIntensity });
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = {
        kind: 'buildings-textured',
        facade: group.textureKey,
        footprintMode: group.footprintMode,
      };
      root.add(mesh);
      this.pickables.push(mesh);
      this.geometryCache.push(merged);
    }
    this.buildHeroGroundingBatch(root, heroRoofEntries, city);
    this.buildHeroRoofBatches(root, heroRoofEntries, heroTextures);
    this.buildFacadeRelief(root, depthCandidates, depthBaseY);
  }

  /**
   * Attach the shared detail maps to a facade material. Building shells carry
   * metric wall UVs (one unit per BUILDING_UV_METRES_X/Y), so the repeat is
   * derived from that tile and is identical for every mesh in a merged batch.
   */
  applyFacadeDetail(material, className, options = {}) {
    return applyDetailMaps(material, className, {
      ...DETAIL_MAP_OPTIONS,
      repeat: detailRepeatForUvTile(className, BUILDING_UV_METRES_X, BUILDING_UV_METRES_Y),
      useMetalnessMap: false,
      ...options,
    });
  }

  /** Shared material for one facade-relief (style, role) batch. */
  facadeReliefMaterial(style, role) {
    this.facadeReliefMaterials = this.facadeReliefMaterials || new Map();
    const key = `${style}:${role}`;
    const cached = this.facadeReliefMaterials.get(key);
    if (cached) return cached;
    let material;
    if (role === 'glass') {
      // Recessed panes: dark, smooth, and almost entirely carried by the
      // environment. This is where IBL earns its place.
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(FACADE_DEPTH_GLASS.color),
        roughness: FACADE_DEPTH_GLASS.roughness,
        metalness: FACADE_DEPTH_GLASS.metalness,
      });
      material.userData.envClass = 'facade-glass';
    } else {
      const surface = FACADE_DEPTH_SURFACES[style] || FACADE_DEPTH_SURFACES['modern-grid'];
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(surface.color),
        roughness: 0.74,
        metalness: 0.03,
      });
      // Real geometry with no albedo of its own: take the full class relief.
      this.applyFacadeDetail(material, surface.detail, {
        aoMapIntensity: 0.75,
        roughnessScale: detailRoughnessScale(surface.detail, 0.74),
      });
      material.userData.envClass = 'facade-masonry';
    }
    material.name = `facade-relief-${key}`;
    this.facadeReliefMaterials.set(key, material);
    return material;
  }

  /**
   * Additive facade relief: cornices, plinths, string courses, window reveals,
   * sills, pilasters and recessed shopfront glazing. The module merges every
   * building into one geometry per (style, role), so the whole city costs at
   * most twelve extra draw calls.
   */
  buildFacadeRelief(root, buildings, baseYById) {
    this.facadeReliefMaterials = new Map();
    const diagnostics = createFacadeDepthDiagnostics();
    if (!buildings.length) {
      this.facadeDepthDiagnostics = diagnostics;
      return null;
    }
    const view = this.buildFocus || this.camera.position;
    // Screen-space tiering. The module scores a building by how many pixels one
    // reference storey covers, so it needs the real lens and the real viewport;
    // left unset it silently falls back to its 50 deg / 720 px reference screen
    // and the rings land in the wrong place on any other window.
    //
    // The height is taken in CSS pixels rather than drawing-buffer pixels on
    // purpose: the pixel ratio is capped at 1.5 and varies by machine, and the
    // module's declared per-tier budgets are measured against a 720 px screen.
    // Tying the tier to the device pixel ratio would make the same city build
    // to a different triangle count on two machines showing the same view.
    const screen = this.facadeDepthScreen();
    // The tier FLOOR, stated explicitly at the call site rather than left to
    // the module default, because it is the thing that decides coverage.
    //
    // Measured on the real slice: from this build focus the distance ring alone
    // scored `off:582 far:88 mid:27 near:3` - 83% of the city emitted no relief
    // at all while 88% of the triangle allowance went unspent, and every one of
    // the eight buildings within 90 m of the night capture eye scored `off`
    // because they are 574-663 m from the ring CENTRE. The ring centre is
    // `buildFocus`, which is scored once at build time and never rescored, so
    // distance can only ever be a refinement here; it must not be allowed to
    // decide whether a building carries construction at all.
    const batch = buildFacadeDepthBatch(buildings, {
      viewPoint: { x: view.x, z: view.z },
      fov: screen.fov,
      viewportHeight: screen.viewportHeight,
      minTier: FACADE_DEPTH_MIN_TIER,
      baseYFor: (building) => baseYById.get(building.id) ?? 0,
      sceneTriangleBudget: FACADE_DEPTH_SCENE_BUDGET,
    });
    for (const group of batch.groups) {
      const mesh = new THREE.Mesh(group.geometry, this.facadeReliefMaterial(group.style, group.role));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = `facade-relief-${group.key}`;
      mesh.userData = {
        kind: 'buildings-facade-relief',
        style: group.style,
        role: group.role,
        buildingIds: group.buildingIds,
      };
      root.add(mesh);
      this.geometryCache.push(group.geometry);
      diagnostics.styles.push({
        key: group.key,
        triangles: group.triangles,
        buildings: group.buildingIds.length,
      });
    }
    diagnostics.drawCalls = batch.drawCalls;
    diagnostics.triangles = batch.triangles;
    diagnostics.buildings = batch.buildings.length;
    diagnostics.skipped = batch.skipped;
    // The evidence that the tier is uniform in distance. `tierCeiling` is the
    // one global tier the batch had to fall back to in order to fit the scene
    // budget, and `ringCutDistance` is the radius past which whole rings were
    // dropped. Both are uniform moves: neither can leave one building detailed
    // and its neighbour at the same distance bare, which is the artifact the
    // old per-building skip produced.
    diagnostics.screen = screen;
    diagnostics.tierDistances = facadeDetailTierDistances(screen);
    diagnostics.tiers = batch.tiers;
    diagnostics.requestedTiers = batch.requestedTiers;
    diagnostics.tierCeiling = batch.tierCeiling;
    diagnostics.tierFloor = batch.tierFloor;
    diagnostics.minTier = FACADE_DEPTH_MIN_TIER;
    diagnostics.styleSources = batch.styleSources;
    diagnostics.ringCutDistance = batch.ringCutDistance;
    diagnostics.sceneTriangleBudget = batch.sceneTriangleBudget;
    this.facadeDepthDiagnostics = diagnostics;
    return batch;
  }

  /**
   * The screen the facade tier is scored against: the live lens, and the canvas
   * height in CSS pixels. Falls back to the module's reference screen before
   * the canvas has been laid out.
   */
  facadeDepthScreen() {
    const height = this.renderer?.domElement?.clientHeight
      || this.container?.clientHeight
      || 0;
    return {
      fov: Number.isFinite(this.camera?.fov) && this.camera.fov > 0
        ? this.camera.fov
        : FACADE_DEPTH_SCREEN.fov,
      viewportHeight: height > 0 ? height : FACADE_DEPTH_SCREEN.viewportHeight,
    };
  }

  buildHeroGroundingBatch(root, sourceEntries, city) {
    const expectedIds = [...HERO_FACADE_IDS.keys()].sort();
    const diagnostics = {
      pass: 'hero-base-occlusion-v1',
      expectedIds,
      builtIds: [],
      skippedIds: [],
      entries: [],
      sourceEdges: 0,
      renderedEdges: 0,
      skippedRoadEdges: 0,
      vertices: 0,
      triangles: 0,
      drawGroups: 0,
      geometries: 0,
      textures: 0,
      bandHeightMeters: 0.12,
      outwardOffsetMeters: 0.012,
      finite: true,
      roadChecks: 0,
      roadIntrusions: 0,
      sourceFootprintsUnchanged: true,
      sourcePortalsUnchanged: true,
      incremental: { drawGroups: 1, triangles: 94, geometries: 1, textures: 0 },
    };
    const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    const positions = [];
    const normals = [];
    const colors = [];
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);

    const overlapsAsphalt = (point) => city.segments.some((segment) => {
      if (!Array.isArray(segment.points) || segment.points.length < 2) return false;
      const halfWidth = Math.max(0, Number(segment.width || 0) / 2);
      if (halfWidth <= 0) return false;
      for (let index = 1; index < segment.points.length; index += 1) {
        if (pointToSegmentDistance(point, segment.points[index - 1], segment.points[index]) < halfWidth) return true;
      }
      return false;
    });
    const pushVertex = (point, normal, color) => {
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(color.r, color.g, color.b);
    };

    for (const id of expectedIds) {
      const entry = byId.get(id);
      if (!entry?.points?.length) {
        diagnostics.skippedIds.push(id);
        continue;
      }
      const signedArea = signedFootprintArea(entry.points);
      const cellIndex = HERO_FACADE_IDS.get(id).cell;
      const topColor = new THREE.Color(HERO_BASE_COLORS[cellIndex]);
      const bottomColor = topColor.clone().offsetHSL(0, -0.03, -0.14);
      let entryFinite = Number.isFinite(signedArea) && Math.abs(signedArea) > BUILDING_FOOTPRINT_EPSILON;
      for (let index = 0; index < entry.points.length; index += 1) {
        const a = entry.points[index];
        const b = entry.points[(index + 1) % entry.points.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (!Number.isFinite(length) || length <= BUILDING_FOOTPRINT_EPSILON) {
          entryFinite = false;
          continue;
        }
        const outwardX = signedArea > 0 ? dz / length : -dz / length;
        const outwardZ = signedArea > 0 ? -dx / length : dx / length;
        const normal = { x: outwardX, y: 0, z: outwardZ };
        const offset = diagnostics.outwardOffsetMeters;
        const heightAt = (point) => (this.terrain?.heightAt ? this.terrain.heightAt(point.x, point.z) : entry.baseY);
        const aBottom = { x: a.x + outwardX * offset, y: heightAt(a) + roadLift + 0.018, z: a.z + outwardZ * offset };
        const bBottom = { x: b.x + outwardX * offset, y: heightAt(b) + roadLift + 0.018, z: b.z + outwardZ * offset };
        const aTop = { ...aBottom, y: aBottom.y + diagnostics.bandHeightMeters };
        const bTop = { ...bBottom, y: bBottom.y + diagnostics.bandHeightMeters };
        const midpoint = { x: (aBottom.x + bBottom.x) / 2, z: (aBottom.z + bBottom.z) / 2 };
        diagnostics.roadChecks += 1;
        if (overlapsAsphalt(midpoint)) {
          diagnostics.skippedRoadEdges += 1;
          continue;
        }
        pushVertex(aBottom, normal, bottomColor);
        pushVertex(bTop, normal, topColor);
        pushVertex(bBottom, normal, bottomColor);
        pushVertex(aBottom, normal, bottomColor);
        pushVertex(aTop, normal, topColor);
        pushVertex(bTop, normal, topColor);
        diagnostics.renderedEdges += 1;
      }
      diagnostics.sourceEdges += entry.points.length;
      diagnostics.builtIds.push(id);
      diagnostics.entries.push({ id, sourceVertexCount: entry.points.length, finite: entryFinite });
      diagnostics.finite = diagnostics.finite && entryFinite;
    }

    diagnostics.vertices = positions.length / 3;
    diagnostics.triangles = diagnostics.vertices / 3;
    diagnostics.finite = diagnostics.finite
      && expectedIds.length === diagnostics.builtIds.length
      && diagnostics.skippedIds.length === 0
      && [...positions, ...normals, ...colors].every(Number.isFinite);
    if (positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.94,
        metalness: 0,
        flatShading: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'hero-building-base-occlusion';
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'hero-building-base-occlusion', buildingIds: diagnostics.builtIds };
      root.add(mesh);
      this.geometryCache.push(geometry, material);
      diagnostics.drawGroups = 1;
      diagnostics.geometries = 1;
    }
    this.heroGroundDiagnostics = diagnostics;
  }

  buildHeroRoofBatches(root, sourceEntries, heroTextures) {
    const expectedIds = [...HERO_ROOF_PROFILES.keys()].sort();
    const diagnostics = {
      expectedIds,
      builtIds: [],
      skippedIds: [],
      entries: [],
      sourceEdges: 0,
      parapetTriangles: 0,
      mechanicalBoxes: 0,
      mechanicalTriangles: 0,
      triangleDelta: 0,
      drawGroups: 0,
      geometries: 0,
      textures: 0,
      finite: true,
      normalsFinite: true,
      minNormalLength: Infinity,
      maxNormalLength: 0,
      maxFootprintOvershootMeters: 0,
      minRoofClearanceMeters: Infinity,
      materialPass: 'hero-roof-grounding-v1',
      atlasUrl: HERO_FACADE_ATLAS_URL,
      atlasTextureShared: false,
      uvFinite: true,
      uvWithinAssignedCell: true,
      parapetFaceTriangles: { outer: 0, inner: 0, top: 0 },
      mechanicalColorVertices: 0,
      shadowCasters: 0,
      shadowReceivers: 0,
      materialCount: 0,
      incremental: { drawGroups: 0, triangles: 0, geometries: 0, textures: 0 },
      pbr: {
        parapet: { roughness: 0.84, metalness: 0.02 },
        mechanical: { roughness: 0.7, metalness: 0.14 },
      },
    };
    const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    const parapetPositions = [];
    const parapetNormals = [];
    const parapetColors = [];
    const parapetUvs = [];
    const mechanicalGeometries = [];
    const clearance = 0.025;

    const appendTriangle = (a, b, c, expectedNormal, color, triangleUvs) => {
      const ab = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
      const ac = new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z);
      const normal = ab.cross(ac).normalize();
      let vertices = [a, b, c];
      let uvs = triangleUvs;
      if (normal.dot(expectedNormal) < 0) {
        vertices = [a, c, b];
        uvs = [triangleUvs[0], triangleUvs[2], triangleUvs[1]];
        normal.multiplyScalar(-1);
      }
      for (let index = 0; index < vertices.length; index += 1) {
        const vertex = vertices[index];
        parapetPositions.push(vertex.x, vertex.y, vertex.z);
        parapetNormals.push(normal.x, normal.y, normal.z);
        parapetColors.push(color.r, color.g, color.b);
        parapetUvs.push(uvs[index].u, uvs[index].v);
      }
      const normalLength = normal.length();
      diagnostics.minNormalLength = Math.min(diagnostics.minNormalLength, normalLength);
      diagnostics.maxNormalLength = Math.max(diagnostics.maxNormalLength, normalLength);
    };
    const appendQuad = (a, b, c, d, expectedNormal, color, quadUvs) => {
      appendTriangle(a, b, c, expectedNormal, color, [quadUvs[0], quadUvs[1], quadUvs[2]]);
      appendTriangle(a, c, d, expectedNormal, color, [quadUvs[0], quadUvs[2], quadUvs[3]]);
    };

    for (const id of expectedIds) {
      const entry = byId.get(id);
      if (!entry) {
        diagnostics.skippedIds.push(id);
        continue;
      }
      const { points, baseY, height, profile } = entry;
      const signedArea = signedFootprintArea(points);
      const center = polygonInteriorCenter(points);
      const heading = longestPolygonEdgeHeading(points);
      const roofY = baseY + height;
      const parapetBaseY = roofY + clearance;
      const parapetTopY = parapetBaseY + profile.height;
      const color = new THREE.Color(profile.color);
      const innerColor = color.clone().offsetHSL(0, -0.02, -0.12);
      const topColor = color.clone().offsetHSL(0, -0.05, 0.1);
      const cellIndex = HERO_FACADE_IDS.get(id).cell;
      const cellColumn = cellIndex % 3;
      const visualRow = Math.floor(cellIndex / 3);
      const cellUMin = cellColumn / 3 + 1 / HERO_FACADE_ATLAS_RESOLUTION;
      const cellUMax = (cellColumn + 1) / 3 - 1 / HERO_FACADE_ATLAS_RESOLUTION;
      const cellVMin = visualRow === 0 ? 0.5 + 1 / HERO_FACADE_ATLAS_RESOLUTION : 1 / HERO_FACADE_ATLAS_RESOLUTION;
      const cellVMax = visualRow === 0 ? 1 - 1 / HERO_FACADE_ATLAS_RESOLUTION : 0.5 - 1 / HERO_FACADE_ATLAS_RESOLUTION;
      const roofStyle = HERO_ROOF_CAP_STYLES[cellIndex];
      const roofU = cellUMin + (cellUMax - cellUMin) * roofStyle.sampleU;
      const roofV = cellVMax - (cellVMax - cellVMin) * roofStyle.sampleV;
      const patchHalfU = Math.min(0.012, (roofU - cellUMin) * 0.75, (cellUMax - roofU) * 0.75);
      const patchHalfV = Math.min(0.006, (roofV - cellVMin) * 0.75, (cellVMax - roofV) * 0.75);
      const outerUvs = [
        { u: cellUMin, v: cellVMax - 0.05 },
        { u: cellUMax, v: cellVMax - 0.05 },
        { u: cellUMax, v: cellVMax - 0.008 },
        { u: cellUMin, v: cellVMax - 0.008 },
      ];
      const patchUvs = [
        { u: roofU - patchHalfU, v: roofV - patchHalfV },
        { u: roofU + patchHalfU, v: roofV - patchHalfV },
        { u: roofU + patchHalfU, v: roofV + patchHalfV },
        { u: roofU - patchHalfU, v: roofV + patchHalfV },
      ];
      diagnostics.uvWithinAssignedCell = diagnostics.uvWithinAssignedCell
        && [...outerUvs, ...patchUvs].every((uv) => (
          uv.u >= cellUMin && uv.u <= cellUMax && uv.v >= cellVMin && uv.v <= cellVMax
        ));
      let contained = true;

      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const edgeLength = Math.hypot(dx, dz);
        const unitX = dx / edgeLength;
        const unitZ = dz / edgeLength;
        const outwardX = signedArea > 0 ? dz / edgeLength : -dz / edgeLength;
        const outwardZ = signedArea > 0 ? -dx / edgeLength : dx / edgeLength;
        const inwardX = -outwardX;
        const inwardZ = -outwardZ;
        let depth = profile.depth;
        let along = Math.min(Math.max(depth * 0.16, 0.025), edgeLength * 0.12);
        let innerA;
        let innerB;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          innerA = { x: a.x + unitX * along + inwardX * depth, z: a.z + unitZ * along + inwardZ * depth };
          innerB = { x: b.x - unitX * along + inwardX * depth, z: b.z - unitZ * along + inwardZ * depth };
          if (pointInPolygon(innerA, points) && pointInPolygon(innerB, points)) break;
          depth *= 0.66;
          along *= 1.08;
        }
        if (!pointInPolygon(innerA, points) || !pointInPolygon(innerB, points)) contained = false;

        const outerBottomA = { x: a.x, y: parapetBaseY, z: a.z };
        const outerBottomB = { x: b.x, y: parapetBaseY, z: b.z };
        const outerTopA = { x: a.x, y: parapetTopY, z: a.z };
        const outerTopB = { x: b.x, y: parapetTopY, z: b.z };
        const innerBottomA = { x: innerA.x, y: parapetBaseY, z: innerA.z };
        const innerBottomB = { x: innerB.x, y: parapetBaseY, z: innerB.z };
        const innerTopA = { x: innerA.x, y: parapetTopY, z: innerA.z };
        const innerTopB = { x: innerB.x, y: parapetTopY, z: innerB.z };
        const outward = new THREE.Vector3(outwardX, 0, outwardZ);
        const inward = outward.clone().multiplyScalar(-1);
        appendQuad(outerBottomA, outerBottomB, outerTopB, outerTopA, outward, color, outerUvs);
        appendQuad(innerBottomB, innerBottomA, innerTopA, innerTopB, inward, innerColor, patchUvs);
        appendQuad(outerTopA, outerTopB, innerTopB, innerTopA, new THREE.Vector3(0, 1, 0), topColor, patchUvs);
        diagnostics.parapetFaceTriangles.outer += 2;
        diagnostics.parapetFaceTriangles.inner += 2;
        diagnostics.parapetFaceTriangles.top += 2;
      }

      let stackTop = roofY + clearance;
      let highestTop = parapetTopY;
      for (let index = 0; index < profile.boxes.length; index += 1) {
        const spec = profile.boxes[index];
        let width = spec.w;
        let depth = spec.d;
        let offsetX = spec.dx || 0;
        let offsetZ = spec.dz || 0;
        let corners = [];
        for (let attempt = 0; attempt < 12; attempt += 1) {
          corners = boxFootprintCorners(center, width, depth, heading, offsetX, offsetZ);
          if (corners.every((corner) => pointInPolygon(corner, points))) break;
          width *= 0.78;
          depth *= 0.78;
          offsetX *= 0.72;
          offsetZ *= 0.72;
        }
        if (!corners.every((corner) => pointInPolygon(corner, points))) contained = false;
        const cos = Math.cos(heading);
        const sin = Math.sin(heading);
        const boxX = center.x + offsetX * cos - offsetZ * sin;
        const boxZ = center.z + offsetX * sin + offsetZ * cos;
        const base = spec.stack ? stackTop : roofY + clearance;
        const geometry = new THREE.BoxGeometry(width, spec.h, depth);
        geometry.rotateY(-heading);
        geometry.translate(boxX, base + spec.h / 2, boxZ);
        colorizeGeometry(
          geometry,
          index % 2 === 0 ? profile.color : color.clone().offsetHSL(0, -0.04, 0.08),
          base,
          base + spec.h,
        );
        mechanicalGeometries.push(geometry);
        diagnostics.mechanicalColorVertices += geometry.attributes.color.count;
        stackTop = Math.max(stackTop, base + spec.h);
        highestTop = Math.max(highestTop, base + spec.h);
      }

      diagnostics.sourceEdges += points.length;
      diagnostics.parapetTriangles += points.length * 6;
      diagnostics.mechanicalBoxes += profile.boxes.length;
      diagnostics.mechanicalTriangles += profile.boxes.length * 12;
      diagnostics.minRoofClearanceMeters = Math.min(diagnostics.minRoofClearanceMeters, clearance);
      diagnostics.maxFootprintOvershootMeters = contained ? diagnostics.maxFootprintOvershootMeters : Infinity;
      diagnostics.builtIds.push(id);
      diagnostics.entries.push({
        id,
        sourceVertexCount: points.length,
        profile: profile.profile,
        parapetDepth: profile.depth,
        parapetHeight: profile.height,
        mechanicalBoxCount: profile.boxes.length,
        centroid: { x: center.x, y: highestTop, z: center.z },
      });
    }

    if (parapetPositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(parapetPositions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(parapetNormals, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(parapetColors, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(parapetUvs, 2));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({
        map: heroTextures?.texture || null,
        vertexColors: true,
        roughness: 0.84,
        metalness: 0.02,
        flatShading: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'hero-roof-parapets';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'hero-roof-parapets', buildingIds: diagnostics.builtIds };
      root.add(mesh);
      this.geometryCache.push(geometry, material);
      diagnostics.drawGroups += 1;
      diagnostics.geometries += 1;
      diagnostics.shadowCasters += mesh.castShadow ? 1 : 0;
      diagnostics.shadowReceivers += mesh.receiveShadow ? 1 : 0;
      diagnostics.materialCount += 1;
      diagnostics.atlasTextureShared = material.map === heroTextures?.texture;
    }

    if (mechanicalGeometries.length) {
      const geometry = mergeGeometries(mechanicalGeometries, false);
      for (const source of mechanicalGeometries) source.dispose();
      if (geometry) {
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.7,
          metalness: 0.14,
          flatShading: true,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'hero-roof-mechanical';
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { kind: 'hero-roof-mechanical', buildingIds: diagnostics.builtIds };
        root.add(mesh);
        this.geometryCache.push(geometry, material);
        diagnostics.drawGroups += 1;
        diagnostics.geometries += 1;
        diagnostics.shadowCasters += mesh.castShadow ? 1 : 0;
        diagnostics.shadowReceivers += mesh.receiveShadow ? 1 : 0;
        diagnostics.materialCount += 1;
        const normal = geometry.attributes.normal;
        for (let i = 0; i < normal.count; i += 1) {
          const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
          diagnostics.minNormalLength = Math.min(diagnostics.minNormalLength, length);
          diagnostics.maxNormalLength = Math.max(diagnostics.maxNormalLength, length);
        }
      }
    }

    diagnostics.triangleDelta = diagnostics.parapetTriangles + diagnostics.mechanicalTriangles;
    diagnostics.uvFinite = parapetUvs.every(Number.isFinite);
    diagnostics.finite = [parapetPositions, parapetNormals, parapetColors, parapetUvs]
      .every((values) => values.every(Number.isFinite))
      && Number.isFinite(diagnostics.maxFootprintOvershootMeters);
    diagnostics.normalsFinite = parapetNormals.every(Number.isFinite)
      && Number.isFinite(diagnostics.minNormalLength)
      && Number.isFinite(diagnostics.maxNormalLength);
    this.heroRoofDiagnostics = diagnostics;
  }

  buildLandmark(root, kind, building, width, depth, height, baseY, minX, minZ) {
    const cx = minX + width / 2;
    const cz = minZ + depth / 2;
    const base = new THREE.MeshStandardMaterial({ color: 0xdfe4e6, roughness: 0.55, metalness: 0.12, flatShading: true });
    const glass = new THREE.MeshStandardMaterial({ color: 0x8fb7d8, roughness: 0.28, metalness: 0.45, flatShading: true });
    const warm = new THREE.MeshStandardMaterial({ color: 0xe7cfa8, roughness: 0.6, metalness: 0.05, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x4a5a6a, roughness: 0.5, metalness: 0.25, flatShading: true });
    const terracotta = new THREE.MeshStandardMaterial({ color: 0xb66f5a, roughness: 0.72, flatShading: true });
    const slate = new THREE.MeshStandardMaterial({ color: 0x65717c, roughness: 0.62, metalness: 0.18, flatShading: true });
    const group = new THREE.Group();
    if (kind === 'transamerica') {
      const span = Math.max(width, depth);
      const pyramid = new THREE.ConeGeometry(span * 0.62, height * 0.94, 4);
      pyramid.rotateY(Math.PI / 4);
      const mesh = new THREE.Mesh(pyramid, warm);
      mesh.position.set(cx, baseY + height * 0.47, cz);
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(span * 0.72, height * 0.08, span * 0.72), dark);
      plinth.position.set(cx, baseY + height * 0.045, cz);
      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.18, Math.max(3.5, height * 0.13), 5), dark);
      antenna.position.set(cx, baseY + height + Math.max(1.6, height * 0.065), cz);
      group.add(mesh, plinth, antenna);
      this.geometryCache.push(pyramid, plinth.geometry, antenna.geometry, warm, dark);
    } else if (kind === 'coit') {
      const span = Math.max(width, depth);
      const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(span * 0.52, span * 0.68, height * 0.12, 10), terracotta);
      shoulder.position.set(cx, baseY + height * 0.06, cz);
      const shaft = new THREE.CylinderGeometry(span * 0.2, span * 0.3, height * 0.72, 12);
      const shaftMesh = new THREE.Mesh(shaft, base);
      shaftMesh.position.set(cx, baseY + height * 0.48, cz);
      const cap = new THREE.CylinderGeometry(span * 0.08, span * 0.2, height * 0.18, 12);
      const capMesh = new THREE.Mesh(cap, dark);
      capMesh.position.set(cx, baseY + height * 0.9, cz);
      group.add(shoulder, shaftMesh, capMesh);
      this.geometryCache.push(shoulder.geometry, shaft, cap, base, dark, terracotta);
    } else if (kind === 'ferry') {
      const hall = new THREE.BoxGeometry(width, height * 0.72, depth);
      hall.translate(cx, baseY + height * 0.36, cz);
      const hallMesh = new THREE.Mesh(hall, warm);
      const towerWidth = Math.min(width * 0.2, 10);
      const towerDepth = Math.min(depth * 0.2, 10);
      const tower = new THREE.BoxGeometry(towerWidth, height, towerDepth);
      tower.translate(cx, baseY + height / 2, cz);
      const towerMesh = new THREE.Mesh(tower, base);
      const roof = new THREE.ConeGeometry(Math.max(towerWidth, towerDepth) * 0.82, Math.max(5.2, height * 0.12), 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(cx, baseY + height + Math.max(2.3, height * 0.055), cz);
      const roofMesh = new THREE.Mesh(roof, dark);
      const clock = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(2.8, towerWidth * 0.42), Math.min(2.8, towerWidth * 0.42), 0.16, 16), slate);
      clock.rotation.x = Math.PI / 2;
      clock.position.set(cx, baseY + height * 0.66, cz - towerDepth * 0.52);
      group.add(hallMesh, towerMesh, roofMesh, clock);
      this.geometryCache.push(hall, tower, roof, clock.geometry, warm, base, dark, slate);
    } else if (kind === 'salesforce') {
      const taper = new THREE.CylinderGeometry(Math.max(width, depth) * 0.3, Math.max(width, depth) * 0.55, height, 4);
      taper.rotateY(Math.PI / 4);
      const mesh = new THREE.Mesh(taper, glass);
      mesh.position.set(cx, baseY + height / 2, cz);
      const crown = new THREE.BoxGeometry(Math.max(width, depth) * 0.34, height * 0.03, Math.max(width, depth) * 0.34);
      crown.translate(cx, baseY + height * 0.99, cz);
      const crownMesh = new THREE.Mesh(crown, dark);
      group.add(mesh, crownMesh);
      this.geometryCache.push(taper, crown, glass, dark);
    } else if (kind === 'city-hall') {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.55, depth), warm);
      wing.position.set(cx, baseY + height * 0.275, cz);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.max(width, depth) * 0.28, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), slate);
      dome.position.set(cx, baseY + height * 0.72, cz);
      const lantern = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(width, depth) * 0.08, Math.max(width, depth) * 0.11, height * 0.2, 8), dark);
      lantern.position.set(cx, baseY + height * 0.9, cz);
      group.add(wing, dome, lantern);
      this.geometryCache.push(wing.geometry, dome.geometry, lantern.geometry, warm, slate, dark);
    } else if (kind === 'palace') {
      const hall = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.32, depth), warm);
      hall.position.set(cx, baseY + height * 0.16, cz);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.max(width, depth) * 0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), base);
      dome.position.set(cx, baseY + height * 0.37, cz);
      const colCount = Math.min(8, Math.max(4, Math.round(width / 4)));
      const colGeometry = new THREE.CylinderGeometry(0.22, 0.28, height * 0.42, 6);
      for (let i = 0; i < colCount; i += 1) {
        const x = minX + (width * (i + 0.5)) / colCount;
        const col = new THREE.Mesh(colGeometry, base);
        col.position.set(x, baseY + height * 0.21, minZ - depth * 0.18);
        group.add(col);
      }
      group.add(hall, dome);
      this.geometryCache.push(hall.geometry, dome.geometry, colGeometry, warm, base);
    } else if (kind === 'mission-dolores') {
      const nave = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.62, depth), warm);
      nave.position.set(cx, baseY + height * 0.31, cz);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(width, depth) * 0.5, height * 0.22, 4), terracotta);
      roof.rotation.y = Math.PI / 4;
      roof.position.set(cx, baseY + height * 0.73, cz);
      const bellGeometry = new THREE.CylinderGeometry(Math.max(width, depth) * 0.13, Math.max(width, depth) * 0.17, height * 0.7, 6);
      const leftBell = new THREE.Mesh(bellGeometry, base);
      const rightBell = new THREE.Mesh(bellGeometry, base);
      leftBell.position.set(cx - width * 0.31, baseY + height * 0.35, cz);
      rightBell.position.set(cx + width * 0.31, baseY + height * 0.35, cz);
      group.add(nave, roof, leftBell, rightBell);
      this.geometryCache.push(nave.geometry, roof.geometry, bellGeometry, warm, terracotta, base);
    } else if (kind === 'cathedral') {
      const nave = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.56, depth), slate);
      nave.position.set(cx, baseY + height * 0.28, cz);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(width, depth) * 0.56, height * 0.24, 4), dark);
      roof.rotation.y = Math.PI / 4;
      roof.position.set(cx, baseY + height * 0.68, cz);
      const spireGeometry = new THREE.ConeGeometry(Math.max(width, depth) * 0.1, height * 0.5, 4);
      const leftSpire = new THREE.Mesh(spireGeometry, slate);
      const rightSpire = new THREE.Mesh(spireGeometry, slate);
      leftSpire.position.set(cx - width * 0.28, baseY + height * 0.56, cz);
      rightSpire.position.set(cx + width * 0.28, baseY + height * 0.56, cz);
      group.add(nave, roof, leftSpire, rightSpire);
      this.geometryCache.push(nave.geometry, roof.geometry, spireGeometry, slate, dark);
    } else if (kind === 'sfmoma' || kind === 'warfield' || kind === 'yerba') {
      const hall = new THREE.Mesh(new THREE.BoxGeometry(width, height * 0.72, depth), kind === 'warfield' ? terracotta : warm);
      hall.position.set(cx, baseY + height * 0.36, cz);
      const crown = new THREE.Mesh(new THREE.BoxGeometry(width * 0.74, height * 0.22, depth * 0.74), kind === 'sfmoma' ? glass : slate);
      crown.position.set(cx, baseY + height * 0.83, cz);
      group.add(hall, crown);
      this.geometryCache.push(hall.geometry, crown.geometry, warm, terracotta, glass, slate);
    } else {
      const box = new THREE.BoxGeometry(width, height, depth);
      box.translate(cx, baseY + height / 2, cz);
      const mesh = new THREE.Mesh(box, base);
      group.add(mesh);
      this.geometryCache.push(box, base);
    }
    group.userData = { kind: 'building', id: building.id, buildingId: building.id };
    group.position.y = 0;
    root.add(group);
    this.pickables.push(group);
  }

  buildContactShadows(root, city) {
    const alphaTexture = seededTexture(2048, (context, width, height) => {
      drawShadowAlpha(context, width, height);
    }, 64, 64);
    alphaTexture.wrapS = THREE.ClampToEdgeWrapping;
    alphaTexture.wrapT = THREE.ClampToEdgeWrapping;
    const material = new THREE.MeshBasicMaterial({
      color: 0x0d1711,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      alphaMap: alphaTexture,
    });
    this.contactShadowMaterial = material;
    // One merged plane-set replaces one mesh per building (700+ draw calls -> 1).
    const positions = [];
    const uvs = [];
    const normals = [];
    const indices = [];
    for (const building of city.buildings) {
      const points = building.polygon;
      if (points.length < 4) continue;
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minZ = Math.min(...points.map((p) => p.z));
      const maxZ = Math.max(...points.map((p) => p.z));
      if (maxX - minX < 2 || maxZ - minZ < 2) continue;
      const y = this.terrain?.heightAt ? this.terrain.heightAt((minX + maxX) / 2, (minZ + maxZ) / 2) : 0;
      const width = maxX - minX + 2.2;
      const depth = maxZ - minZ + 2.2;
      const baseIndex = positions.length / 3;
      positions.push(
        minX - 1.1, y + 0.052, minZ - 1.1,
        minX - 1.1 + width, y + 0.052, minZ - 1.1,
        minX - 1.1 + width, y + 0.052, minZ - 1.1 + depth,
        minX - 1.1, y + 0.052, minZ - 1.1 + depth,
      );
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      uvs.push(0.04, 0.04, 0.96, 0.04, 0.96, 0.96, 0.04, 0.96);
      indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
    }
    this.geometryCache.push(alphaTexture);
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    mesh.name = 'contact-shadows';
    root.add(mesh);
    this.geometryCache.push(geometry);
  }

  addRoofDetails(root, building, width, depth, height, baseY, minX, minZ, material, random) {
    // Roof props are accumulated into this.roofBatch and flushed once per
    // build so parapets/tanks/cells cost three draw calls total, not one each.
    const batch = this.roofBatch;
    const topY = baseY + height;
    const cx = minX + width / 2;
    const cz = minZ + depth / 2;
    const parapet = new THREE.BoxGeometry(width + 0.5, 0.42, depth + 0.5);
    parapet.translate(cx, topY + 0.14, cz);
    const parapetColor = shade(colorFromHex(PALETTES[material]?.[0] || '#cfc9bb'), -0.2);
    const positionCount = parapet.attributes.position.count;
    const colors = new Float32Array(positionCount * 3);
    for (let i = 0; i < positionCount; i += 1) {
      colors[i * 3] = parapetColor.r;
      colors[i * 3 + 1] = parapetColor.g;
      colors[i * 3 + 2] = parapetColor.b;
    }
    parapet.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    batch.parapets.push(parapet);
    if ((building.type === 'rowhouse' || building.type === 'midrise') && random() < 0.42) {
      const tankR = 0.9 + random() * 0.5;
      const tankH = 1.4 + random() * 0.9;
      const tank = new THREE.CylinderGeometry(tankR * 0.82, tankR, tankH, 8);
      tank.translate(cx + width * (random() - 0.5) * 0.36, topY + 0.28 + tankH / 2, cz + depth * (random() - 0.5) * 0.36);
      batch.tanks.push(tank);
    } else if (building.type === 'tower' && random() < 0.6) {
      const cellH = 2.6 + random() * 2;
      const cell = new THREE.CylinderGeometry(0.5, 0.55, cellH, 6);
      cell.translate(cx + width * 0.22, topY + cellH / 2 + 0.3, cz + depth * 0.18);
      batch.cells.push(cell);
    }
  }

  flushRoofDetails(root) {
    const batch = this.roofBatch;
    this.roofBatch = null;
    if (!batch) return;
    if (batch.parapets.length) {
      const merged = mergeGeometries(batch.parapets, false);
      batch.parapets.length = 0;
      if (merged) {
        merged.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true });
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = true;
        root.add(mesh);
        this.geometryCache.push(merged, material);
      }
    }
    if (batch.tanks.length) {
      const merged = mergeGeometries(batch.tanks, false);
      batch.tanks.length = 0;
      if (merged) {
        merged.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: '#b5725a', roughness: 0.55, metalness: 0.25, flatShading: true });
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = true;
        root.add(mesh);
        this.geometryCache.push(merged, material);
      }
    }
    if (batch.cells.length) {
      const merged = mergeGeometries(batch.cells, false);
      batch.cells.length = 0;
      if (merged) {
        merged.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: '#c4beb4', roughness: 0.5, metalness: 0.5, flatShading: true });
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = true;
        root.add(mesh);
        this.geometryCache.push(merged, material);
      }
    }
  }

  /**
   * Solve the street cross-section against the two vertical planes the rest of
   * the runtime already pins (see LEGACY_SIDEWALK_LIFT above).
   *
   * The carriageway datum is left exactly where the legacy flat ribbon was, so
   * curbside cars keep contacting it. The curb face is then sized so the curb
   * top - and therefore the footway - lands exactly on the legacy pavement
   * plane, so every lamp, bench, sign and seated actor keeps standing on the
   * surface it was placed against. Nothing in the scene moves vertically; the
   * curb and the gutter appear in the space between the two planes.
   */
  streetSurfaceLift(city) {
    const defaults = STREET_SURFACE_V2_DEFAULTS;
    const datum = Number(city?.meta?.streetDesign?.roadLift ?? defaults.roadLift);
    const gutterDepth = STREET_GUTTER_DEPTH;
    // curbTop = (datum - gutterDepth) + curbFaceHeight - curbTopFall
    const curbFaceHeight = LEGACY_SIDEWALK_LIFT + gutterDepth + defaults.curbTopFall;
    const footway = datum + LEGACY_SIDEWALK_LIFT;
    return { datum, gutterDepth, curbFaceHeight, footway, exposedCurbFace: curbFaceHeight };
  }

  buildRoadNetwork(root, city) {
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const sfGroundMaterials = realMap && isSanFranciscoCity(city);
    const sourceSegmentsBefore = sfGroundMaterials ? JSON.stringify(city.segments) : null;
    const asphaltTexture = sfGroundMaterials ? this.groundMaterialTextures.asphalt : null;
    const sidewalkTexture = sfGroundMaterials ? this.groundMaterialTextures.sidewalk : null;
    const lift = this.streetSurfaceLift(city);

    // One pass builds the whole street surface: cambered carriageway, gutter
    // pan, vertical curb face, curb top, cross-falling footway, mitred bends,
    // filleted junction pads, kerb ramps, and paint (edge lines, centre lines,
    // dashed dividers, stop bars, zebra bands). It replaces every legacy road
    // ribbon - running both would double coplanar geometry.
    const street = buildStreetSurfaceV2(city, {
      roadLift: lift.datum,
      gutterDepth: lift.gutterDepth,
      curbFaceHeight: lift.curbFaceHeight,
      heightAt: this.terrain?.heightAt ? (x, z) => this.terrain.heightAt(x, z) : null,
      palette: sfGroundMaterials ? 'sf' : 'stylised',
      inferNodes: realMap,
      maps: { carriageway: asphaltTexture, concrete: sidewalkTexture },
    });
    this.streetSurface = street;
    root.add(street.group);

    // Detail maps. The module bakes world-XZ UVs over its own metres-per-repeat
    // per mesh group, so the detail repeat is derived from that same tile.
    const uvMetres = street.data.options.uvMetersPerRepeat;
    if (street.materials.carriageway) {
      const material = street.materials.carriageway;
      applyDetailMaps(material, 'asphalt', {
        ...DETAIL_MAP_OPTIONS,
        repeat: detailRepeatForUvTile('asphalt', uvMetres.carriageway, uvMetres.carriageway),
        useMetalnessMap: false,
        normalScale: 0.9,
        aoMapIntensity: 0.55,
        roughnessScale: detailRoughnessScale('asphalt', 0.94),
      });
      material.metalness = 0;
      material.userData.envClass = classifyMaterialClass({ kind: 'asphalt' });
    }
    if (street.materials.concrete) {
      const material = street.materials.concrete;
      applyDetailMaps(material, 'sidewalk-concrete', {
        ...DETAIL_MAP_OPTIONS,
        repeat: detailRepeatForUvTile('sidewalk-concrete', uvMetres.concrete, uvMetres.concrete),
        useMetalnessMap: false,
        normalScale: 0.85,
        aoMapIntensity: 0.6,
        roughnessScale: detailRoughnessScale('sidewalk-concrete', 0.94),
      });
      material.metalness = 0;
      material.userData.envClass = classifyMaterialClass({ kind: 'sidewalk' });
    }
    if (street.materials.markings) {
      // Paint is not a tiled surface: it keeps its authored roughness and only
      // takes the environment grading.
      street.materials.markings.userData.envClass = classifyMaterialClass({ kind: 'sidewalk' });
    }

    for (const mesh of Object.values(street.meshes)) {
      if (mesh.userData.kind === 'roads' || mesh.userData.kind === 'sidewalks') this.pickables.push(mesh);
    }
    for (const geometry of Object.values(street.geometries)) this.geometryCache.push(geometry);

    // Keep pickable geometry references for click metadata. `curbs` and
    // `crosswalks` are no longer separate meshes: the curb is part of the
    // concrete group and the zebra bands are part of the marking group.
    this.roadMeshes = {
      asphalt: street.meshes.carriageway || null,
      sidewalk: street.meshes.concrete || null,
      curbs: street.meshes.concrete || null,
      crosswalks: street.meshes.markings || null,
      markings: street.meshes.markings || null,
    };
    this.streetSurfaceDiagnostics = {
      pass: STREET_SURFACE_PASS,
      drawCalls: street.drawCalls,
      triangles: street.stats.trianglesTotal,
      trianglesPer100m: street.stats.trianglesPer100m,
      trianglesPerIntersection: street.stats.trianglesPerIntersection,
      nodes: street.stats.nodes,
      segments: street.stats.segments,
      nonFinite: street.stats.nonFinite,
      budget: street.stats.budget,
      datumRoadLift: lift.datum,
      footwayLift: lift.footway,
      exposedCurbFace: lift.exposedCurbFace,
      gutterDepth: lift.gutterDepth,
      stats: street.stats,
    };

    if (!sfGroundMaterials) {
      this.groundMaterialDiagnostics = createGroundMaterialDiagnostics(this.groundMaterialLifecycle);
      this.syncGroundMaterialDiagnostics();
      return;
    }
    const asphaltUvDiagnostics = describeWorldXZUvs(
      street.geometries.carriageway,
      GROUND_MATERIAL_ASSETS.asphalt.metersPerRepeat,
    );
    const sidewalkUvDiagnostics = describeWorldXZUvs(
      street.geometries.concrete,
      GROUND_MATERIAL_ASSETS.sidewalk.metersPerRepeat,
    );
    const asphaltMaterial = street.materials.carriageway;
    const sidewalkMaterial = street.materials.concrete;
    this.groundMaterialLifecycle.buildCount += 1;
    this.groundMaterialDiagnostics = createGroundMaterialDiagnostics(this.groundMaterialLifecycle, true);
    this.groundMaterialDiagnostics.enabled = true;
    this.groundMaterialDiagnostics.uvAttributes = {
      count: 2,
      finite: asphaltUvDiagnostics.finite && sidewalkUvDiagnostics.finite,
      asphalt: asphaltUvDiagnostics,
      sidewalk: sidewalkUvDiagnostics,
    };
    this.groundMaterialDiagnostics.materialBindings = {
      anisotropy: GROUND_MATERIAL_ANISOTROPY,
      asphalt: {
        mapEqualsBumpMap: asphaltMaterial.map === asphaltMaterial.bumpMap,
        bumpScale: asphaltMaterial.bumpScale,
      },
      sidewalk: {
        mapEqualsBumpMap: sidewalkMaterial.map === sidewalkMaterial.bumpMap,
        bumpScale: sidewalkMaterial.bumpScale,
      },
    };
    const sourceSegmentsAfter = JSON.stringify(city.segments);
    this.groundMaterialDiagnostics.source = {
      segmentCount: city.segments.length,
      checksumBefore: hashString(sourceSegmentsBefore),
      checksumAfter: hashString(sourceSegmentsAfter),
      unchanged: sourceSegmentsBefore === sourceSegmentsAfter,
    };
    this.syncGroundMaterialDiagnostics();
    const diagnostics = this.groundMaterialDiagnostics;
    diagnostics.failure = diagnostics.assets.asphalt.loaded
      && diagnostics.assets.sidewalk.loaded
      && diagnostics.uvAttributes.count === 2
      && diagnostics.uvAttributes.finite
      && diagnostics.materialBindings.asphalt.mapEqualsBumpMap
      && diagnostics.materialBindings.sidewalk.mapEqualsBumpMap
      && diagnostics.source.unchanged
      && diagnostics.lifecycle.textureLoadCount === 2
      && diagnostics.lifecycle.textureLoadedCount === 2
      && diagnostics.lifecycle.textureDisposeCount === 0
      ? null
      : 'sf-ground-materials-contract';
  }

  buildSignals(root, city) {
    this.signalMeshes = [];
    const lampGeometry = new THREE.SphereGeometry(0.16, 8, 6);
    this.geometryCache.push(lampGeometry);
    this.buildStreetLamps(root, city);
    for (const signal of city.signals) {
      const group = new THREE.Group();
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.12, 4.1, 6),
        new THREE.MeshStandardMaterial({ color: 0x3c454b, roughness: 0.55, metalness: 0.45 }),
      );
      pole.position.y = 2.05;
      group.add(pole);
      const housing = new THREE.Mesh(
        new THREE.BoxGeometry(0.62, 1.5, 0.42),
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.45, metalness: 0.4 }),
      );
      housing.position.y = 3.7;
      group.add(housing);
      const lampMaterials = [
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, emissive: 0x000000, emissiveIntensity: 0 }),
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, emissive: 0x000000, emissiveIntensity: 0 }),
        new THREE.MeshStandardMaterial({ color: 0x2b2f33, emissive: 0x000000, emissiveIntensity: 0 }),
      ];
      const positions = [3.18, 3.62, 4.06];
      for (let i = 0; i < 3; i += 1) {
        const lamp = new THREE.Mesh(lampGeometry, lampMaterials[i]);
        lamp.position.set(0, positions[i], 0.24);
        group.add(lamp);
      }
      group.position.set(signal.position.x, 0, signal.position.z);
      group.userData = { kind: 'signal', id: signal.id, signalId: signal.id };
      root.add(group);
      this.pickables.push(group);
      this.signalMeshes.push({ group, signal, lampMaterials });
      this.geometryCache.push(pole.geometry, housing.geometry);
      for (const material of lampMaterials) this.geometryCache.push(material);
    }
  }

  buildStreetLamps(root, city) {
    const poleGeometry = new THREE.CylinderGeometry(0.07, 0.1, 5.4, 6);
    const bulbGeometry = new THREE.SphereGeometry(0.22, 8, 6);
    const poleMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a434a,
      roughness: 0.55,
      metalness: 0.5,
    });
    const bulbMaterial = new THREE.MeshStandardMaterial({
      color: 0xffe9b8,
      emissive: 0xffcf7a,
      emissiveIntensity: 0.16,
      roughness: 0.4,
    });
    this.geometryCache.push(poleGeometry, bulbGeometry);
    const maxLamps = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap' ? 240 : 900;
    const placement = collectStreetLampRecords(city, { maxLamps });
    this.streetLampRecords = placement.records;
    this.streetLampDiagnostics = {
      source: city.meta.generator || null,
      maxLamps,
      ...placement.diagnostics,
      pointLightPoolSize: 0,
    };
    const group = new THREE.Group();
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);
    for (const record of this.streetLampRecords) {
      const { x, z } = record;
      const pole = new THREE.Mesh(poleGeometry, poleMaterial);
      pole.position.y = 2.7;
      const bulb = new THREE.Mesh(bulbGeometry, bulbMaterial);
      bulb.position.y = 5.5;
      const lamp = new THREE.Group();
      lamp.add(pole, bulb);
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0) + roadLift + 0.04;
      lamp.position.set(x, y, z);
      lamp.rotation.y = record.rotation;
      lamp.userData = {
        kind: 'street-lamp',
        source: 'segment-polyline',
        segmentId: record.segmentId,
        streetId: record.streetId,
        side: record.side,
      };
      group.add(lamp);
      this.lampBulbs.push(bulb);
      this.localLightCandidates.push({
        x,
        y: y + 4.8,
        z,
        color: 0xffc46a,
        intensity: 0.72,
        distance: 28,
        decay: 2.1,
      });
    }
    group.name = 'street-lamps';
    root.add(group);
  }

  installLocalLightPool(root) {
    // WebGPU currently evaluates every PointLight against the scene. Keep all
    // authored emissive fixtures, but reserve real illumination for a small
    // camera-local pool so city density does not multiply frame cost.
    const poolSize = Math.min(3, this.localLightCandidates.length);
    const group = new THREE.Group();
    group.name = 'local-light-pool';
    for (let i = 0; i < poolSize; i += 1) {
      const light = new THREE.PointLight(0xffffff, 0, 28, 2);
      light.name = `local-night-light-${i + 1}`;
      // Keep the three-light layout resident across day/night transitions so
      // WebGPU does not rebuild the lighting pipeline when dusk begins.
      light.visible = true;
      group.add(light);
      this.localLightPool.push(light);
    }
    root.add(group);
    // Preserve the public diagnostics aliases while all local sources share
    // one bounded pool.
    this.lampLights = this.localLightPool;
    this.lightPools = this.localLightPool;
    if (this.streetLampDiagnostics) {
      this.streetLampDiagnostics.pointLightPoolSize = this.localLightPool.length;
    }
  }

  updateLocalLightPool(delta, force = false) {
    if (!this.localLightPool.length) return;
    if (!this.localLightsNight) {
      for (const light of this.localLightPool) {
        light.intensity = 0;
        light.visible = true;
      }
      return;
    }
    this.localLightUpdateClock += delta;
    if (!force && this.localLightUpdateClock < 0.25) return;
    this.localLightUpdateClock = 0;
    const camera = this.camera.position;
    const nearest = this.localLightCandidates
      .map((candidate) => ({
        candidate,
        distanceSq: (candidate.x - camera.x) ** 2 + (candidate.z - camera.z) ** 2,
      }))
      .sort((a, b) => a.distanceSq - b.distanceSq)
      .slice(0, this.localLightPool.length);
    for (let i = 0; i < this.localLightPool.length; i += 1) {
      const light = this.localLightPool[i];
      const candidate = nearest[i]?.candidate;
      if (!candidate) {
        light.intensity = 0;
        light.visible = true;
        continue;
      }
      light.position.set(candidate.x, candidate.y, candidate.z);
      light.color.set(candidate.color);
      light.distance = candidate.distance;
      light.decay = candidate.decay;
      light.intensity = candidate.intensity;
      light.visible = true;
    }
  }

  buildStreetNeonTrim(root, city) {
    if (city.meta.generator !== 'procedural') return;
    const bounds = city.meta.bounds;
    const colors = ['#ff5fa2', '#35d7d7', '#ffc43d', '#8dff5f', '#c08fff', '#ff7a45'];
    const trim = [];
    const random = mulberry32(Number(city.meta.seedInt || 1) + 2201);
    for (const street of city.streets) {
      if (street.highway !== 'primary' && street.highway !== 'secondary') continue;
      if (trim.length >= 120) break;
      const axis = street.axis;
      const position = street.position;
      const rangeStart = bounds[axis === 'x' ? 'minZ' : 'minX'] + 24;
      const rangeEnd = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 24;
      const length = rangeEnd - rangeStart;
      if (length < 40) continue;
      for (const side of [-1, 1]) {
        const offset = position + side * (street.asphaltWidth / 2 + street.sidewalkW + 0.5);
        const x = axis === 'x' ? offset : rangeStart + length / 2;
        const z = axis === 'z' ? offset : rangeStart + length / 2;
        trim.push({
          x,
          z,
          axis,
          length,
          color: colors[Math.floor(random() * colors.length)],
        });
        if (trim.length >= 120) break;
      }
    }
    if (!trim.length) return;
    const geometry = new THREE.BoxGeometry(1, 0.14, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      fog: false,
      depthWrite: false,
    });
    material.userData = { dayOpacity: 0.16, nightOpacity: 0.92 };
    this.neonGlowMaterials.push(material);
    const strips = new THREE.InstancedMesh(geometry, material, trim.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < trim.length; i += 1) {
      const entry = trim[i];
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(entry.x, entry.z) : 0) + 0.12;
      dummy.position.set(entry.x, y, entry.z);
      dummy.rotation.set(0, entry.axis === 'x' ? 0 : 0, 0);
      dummy.scale.set(entry.axis === 'x' ? 0.16 : entry.length, 1, entry.axis === 'x' ? entry.length : 0.16);
      dummy.updateMatrix();
      strips.setMatrixAt(i, dummy.matrix);
      color.set(entry.color);
      strips.setColorAt(i, color);
    }
    strips.instanceMatrix.needsUpdate = true;
    if (strips.instanceColor) strips.instanceColor.needsUpdate = true;
    root.add(strips);
    this.geometryCache.push(geometry);
  }

  buildStreetBunting(root, city) {
    // Authored festival flags suit the procedural showcase but look like
    // floating signs when projected onto arbitrary OSM curb geometry.
    if (city.meta.generator !== 'procedural') return;
    const bounds = city.meta.bounds;
    const colors = ['#e5484d', '#12a594', '#ffb224', '#30a46c', '#8e4ec6', '#ff5c8a', '#f2c14e'];
    const flags = [];
    const random = mulberry32(Number(city.meta.seedInt || 1) + 3301);
    const classes = new Set(['primary', 'secondary']);
    if (city.meta.generator === 'procedural') {
      for (const street of city.streets) {
        if (!classes.has(street.highway)) continue;
        if (flags.length >= 320) break;
        const axis = street.axis;
        const position = street.position;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 26;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 26;
        for (let v = start; v < end; v += 3.6 + random() * 2.4) {
          if (flags.length >= 320) break;
          if (random() < 0.18) continue;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 1.1) : v;
          const z = axis === 'z' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 1.1) : v;
          if (Math.abs(x) > bounds.maxX - 4 || Math.abs(z) > bounds.maxZ - 4) continue;
          flags.push({
            x,
            z,
            axis,
            runId: street.id,
            color: colors[Math.floor(random() * colors.length)],
          });
        }
      }
    } else {
      for (const segment of city.segments || []) {
        if (flags.length >= 480) break;
        if (!['primary', 'secondary', 'tertiary'].includes(segment.highway)) continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 36 || length > 420) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const count = Math.min(10, Math.max(4, Math.round(length / 14)));
        for (let i = 0; i < count; i += 1) {
          if (flags.length >= 480) break;
          if (random() < 0.1) continue;
          const t = (i + 0.5) / count;
          const side = (i % 2 === 0 ? 1 : -1);
          const offset = segment.width / 2 + segment.sidewalkW * 0.5;
          const x = a.x + dx * t + nx * offset * side;
          const z = a.z + dz * t + nz * offset * side;
          flags.push({
            x,
            z,
            axis: Math.abs(dx) > Math.abs(dz) ? 'x' : 'z',
            runId: segment.streetId,
            color: colors[Math.floor(random() * colors.length)],
          });
        }
      }
    }
    if (!flags.length) return;
    this.streetFurniture.bunting = flags.length;
    // Sagging festival wires connect flags into continuous street decor.
    const wirePoints = [];
    const sortedFlags = [...flags].sort((a, b) => {
      if (a.runId !== b.runId) return String(a.runId).localeCompare(String(b.runId));
      if (a.axis !== b.axis) return a.axis === 'x' ? -1 : 1;
      return a.axis === 'x' ? a.z - b.z : a.x - b.x;
    });
    for (let i = 1; i < sortedFlags.length; i += 1) {
      const a = sortedFlags[i - 1];
      const b = sortedFlags[i];
      if (a.runId !== b.runId || a.axis !== b.axis) continue;
      const dist = a.axis === 'x' ? Math.abs(b.z - a.z) : Math.abs(b.x - a.x);
      if (dist < 1.2 || dist > 7) continue;
      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      const y1 = (this.terrain?.heightAt ? this.terrain.heightAt(a.x, a.z) : 0) + 3.45;
      const y2 = (this.terrain?.heightAt ? this.terrain.heightAt(b.x, b.z) : 0) + 3.45;
      const sagY = (y1 + y2) / 2 - 0.55;
      wirePoints.push(a.x, y1, a.z, midX, sagY, midZ);
      wirePoints.push(midX, sagY, midZ, b.x, y2, b.z);
    }
    if (wirePoints.length && city.meta.generator === 'openstreetmap') {
      const wireGeometry = new THREE.BufferGeometry();
      wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wirePoints, 3));
      const wireMaterial = new THREE.LineBasicMaterial({ color: 0x6b4a3a, transparent: true, opacity: 0.55 });
      root.add(new THREE.LineSegments(wireGeometry, wireMaterial));
      this.geometryCache.push(wireGeometry, wireMaterial);
    }
    const geometry = new THREE.BoxGeometry(0.72, 0.5, 0.05);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.7,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, flags.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < flags.length; i += 1) {
      const flag = flags[i];
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(flag.x, flag.z) : 0) + 3.35;
      dummy.position.set(flag.x, y, flag.z);
      dummy.rotation.set(0, flag.axis === 'x' ? Math.PI / 2 : 0, 0);
      dummy.scale.set(1.7, 1.7, 1.7);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(flag.color);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    root.add(mesh);
    this.geometryCache.push(geometry);
  }

  buildUtilityLines(root, city) {
    // Utility poles are a generic-city cue. SF streets receive purpose-built
    // transit wire runs below; skipping the old utility arm forest keeps a
    // single foreground pole from owning the hero composition.
    if (city.meta.generator === 'procedural' || isSanFranciscoCity(city)) return;
    const bounds = city.meta.bounds;
    const random = mulberry32(Number(city.meta.seedInt || 1) + 881);
    const poles = [];
    const wirePoints = [];
    const connectWire = (prev, cur) => {
      const dist = Math.hypot(cur.x - prev.x, cur.z - prev.z);
      if (dist > 95) return;
      const y1 = (this.terrain?.heightAt ? this.terrain.heightAt(prev.x, prev.z) : 0) + 5.6;
      const y2 = (this.terrain?.heightAt ? this.terrain.heightAt(cur.x, cur.z) : 0) + 5.6;
      const midX = (prev.x + cur.x) / 2;
      const midZ = (prev.z + cur.z) / 2;
      const sagY = (y1 + y2) / 2 - 0.8;
      wirePoints.push(prev.x, y1, prev.z, midX, sagY, midZ);
      wirePoints.push(midX, sagY, midZ, cur.x, y2, cur.z);
    };
    if (city.meta.generator === 'procedural') {
      for (const street of city.streets) {
        if (street.highway !== 'primary' && street.highway !== 'secondary') continue;
        if (poles.length >= 36) break;
        const axis = street.axis;
        const position = street.position;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 20;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 20;
        let prev = null;
        for (let v = start; v < end; v += 70 + random() * 40) {
          if (poles.length >= 36) break;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 0.8) : v;
          const z = axis === 'z' ? position + side * (street.asphaltWidth / 2 + street.sidewalkW + 0.8) : v;
          if (Math.abs(x) > bounds.maxX - 3 || Math.abs(z) > bounds.maxZ - 3) continue;
          poles.push({ x, z });
          if (prev) connectWire(prev, { x, z });
          prev = { x, z };
        }
      }
    } else {
      // Real maps: follow road polylines and drop poles along the curbside.
      const eligible = new Set(['primary', 'secondary', 'tertiary']);
      const maxPoles = 32;
      const seenStreets = new Set();
      for (const segment of city.segments || []) {
        if (poles.length >= maxPoles) break;
        if (!eligible.has(segment.highway)) continue;
        const length = polylineLength(segment.points);
        if (length < 46 || length > 520) continue;
        // One pole run per named street keeps the pattern legible.
        if (seenStreets.has(segment.streetId)) continue;
        seenStreets.add(segment.streetId);
        const side = random() < 0.5 ? -1 : 1;
        const spacing = 46 + random() * 22;
        const steps = Math.max(2, Math.floor(length / spacing));
        let prev = null;
        for (let s = 0; s <= steps; s += 1) {
          if (poles.length >= maxPoles) break;
          const t = s / steps;
          const point = pointAlongPolyline(segment.points, t * length);
          const offset = segment.width / 2 + segment.sidewalkW + 0.9;
          const x = point.x + point.nx * offset * side;
          const z = point.z + point.nz * offset * side;
          if (x < bounds.minX + 2 || x > bounds.maxX - 2 || z < bounds.minZ + 2 || z > bounds.maxZ - 2) continue;
          poles.push({ x, z, heading: Math.atan2(point.tx, point.tz) });
          if (prev) connectWire(prev, { x, z });
          prev = { x, z };
        }
      }
    }
    if (!poles.length && !wirePoints.length) return;
    if (poles.length) {
      const poleGeometry = new THREE.CylinderGeometry(0.07, 0.1, 6.6, 5);
      const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x6b513c, roughness: 0.8, flatShading: true });
      const armGeometry = new THREE.BoxGeometry(0.72, 0.06, 0.09);
      const armMaterial = new THREE.MeshStandardMaterial({ color: 0x5a4434, roughness: 0.85, flatShading: true });
      const instanced = new THREE.InstancedMesh(poleGeometry, poleMaterial, poles.length);
      const arms = new THREE.InstancedMesh(armGeometry, armMaterial, poles.length);
      const dummy = new THREE.Object3D();
      for (let i = 0; i < poles.length; i += 1) {
        const pole = poles[i];
        dummy.position.set(pole.x, (this.terrain?.heightAt ? this.terrain.heightAt(pole.x, pole.z) : 0) + 3.3, pole.z);
        dummy.rotation.set(0, pole.heading || 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        instanced.setMatrixAt(i, dummy.matrix);
        dummy.position.y = (this.terrain?.heightAt ? this.terrain.heightAt(pole.x, pole.z) : 0) + 5.45;
        dummy.updateMatrix();
        arms.setMatrixAt(i, dummy.matrix);
      }
      instanced.instanceMatrix.needsUpdate = true;
      arms.instanceMatrix.needsUpdate = true;
      instanced.castShadow = true;
      root.add(instanced, arms);
      this.geometryCache.push(poleGeometry, poleMaterial, armGeometry, armMaterial);
    }
    if (wirePoints.length && city.meta.generator === 'openstreetmap') {
      const wireGeometry = new THREE.BufferGeometry();
      wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wirePoints, 3));
      const wireMaterial = new THREE.LineBasicMaterial({ color: 0x3d3028, transparent: true, opacity: 0.32 });
      root.add(new THREE.LineSegments(wireGeometry, wireMaterial));
      this.geometryCache.push(wireGeometry, wireMaterial);
    }
  }

  buildTransitCues(root, city) {
    if (!isSanFranciscoCity(city)) return;
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.45);
    const cablePattern = /california|powell|hyde|mason|cable\s*car/i;
    const trolleyPattern = /market|geary|church|judah|van\s*ness|king|third|3rd|mission|embarcadero|stockton/i;
    const routes = [];
    const seen = new Set();
    for (const segment of city.segments || []) {
      if (!segment.points || segment.points.length < 2) continue;
      if (['motorway', 'trunk', 'footway', 'cycleway', 'pedestrian', 'steps'].includes(segment.highway)) continue;
      const name = String(segment.streetName || segment.name || '');
      const cable = cablePattern.test(name);
      const trolley = cable || trolleyPattern.test(name);
      if (!trolley) continue;
      const key = `${segment.streetId || segment.id}-${segment.points[0].x.toFixed(1)}-${segment.points[0].z.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ segment, cable });
      if (routes.length >= 40) break;
    }
    if (!routes.length) return;

    const railAttrs = dynQuadAttrs();
    const tieAttrs = dynQuadAttrs();
    const railColor = new THREE.Color('#747b7b');
    const tieColor = new THREE.Color('#a49782');
    let tieCount = 0;
    const wirePoints = [];
    const supportPositions = new Map();
    const heightAt = (x, z) => this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0;
    const yAtRail = (x, z) => heightAt(x, z) + roadLift + 0.105;
    const addTrackSegment = (segment, cable) => {
      const points = segment.points;
      const offset = cable
        ? clamp(segment.width * 0.24, 1.05, 1.42)
        : clamp(segment.width * 0.2, 1.05, 1.62);
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 5) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const leftA = { x: a.x + nx * offset, z: a.z + nz * offset };
        const leftB = { x: b.x + nx * offset, z: b.z + nz * offset };
        const rightA = { x: a.x - nx * offset, z: a.z - nz * offset };
        const rightB = { x: b.x - nx * offset, z: b.z - nz * offset };
        pushStripDyn(railAttrs, leftA, leftB, 0.055, yAtRail, railColor);
        pushStripDyn(railAttrs, rightA, rightB, 0.055, yAtRail, railColor);
        const ties = Math.min(14, Math.max(2, Math.floor(length / 6.5)));
        for (let tieIndex = 1; tieIndex < ties; tieIndex += 1) {
          if (tieCount >= 360) break;
          const t = tieIndex / ties;
          const cx = a.x + dx * t;
          const cz = a.z + dz * t;
          const near = { x: cx + nx * (offset + 0.2), z: cz + nz * (offset + 0.2) };
          const far = { x: cx - nx * (offset + 0.2), z: cz - nz * (offset + 0.2) };
          pushStripDyn(tieAttrs, near, far, 0.045, yAtRail, tieColor);
          tieCount += 1;
          if (tieIndex % 5 === 0) {
            const key = `${Math.round(cx / 12)}:${Math.round(cz / 12)}`;
            if (!supportPositions.has(key) && supportPositions.size < 20) {
              supportPositions.set(key, { x: cx + nx * (offset + 2.1), z: cz + nz * (offset + 2.1) });
            }
          }
        }
        const wireOffsets = [0];
        for (const wireOffset of wireOffsets) {
          const wa = { x: a.x + nx * wireOffset, z: a.z + nz * wireOffset };
          const wb = { x: b.x + nx * wireOffset, z: b.z + nz * wireOffset };
          const y1 = heightAt(wa.x, wa.z) + roadLift + 7.0;
          const y2 = heightAt(wb.x, wb.z) + roadLift + 7.0;
          const midX = (wa.x + wb.x) * 0.5;
          const midZ = (wa.z + wb.z) * 0.5;
          const sag = Math.min(1.0, 0.22 + length * 0.006);
          const midY = (y1 + y2) * 0.5 - sag;
          wirePoints.push(wa.x, y1, wa.z, midX, midY, midZ, midX, midY, midZ, wb.x, y2, wb.z);
        }
      }
    };
    for (const route of routes) addTrackSegment(route.segment, route.cable);

    const railGeometry = buildDynGeometry(railAttrs);
    const railMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.52,
      metalness: 0.62,
      flatShading: true,
    });
    const rails = new THREE.Mesh(railGeometry, railMaterial);
    rails.name = 'sf-transit-rails';
    rails.renderOrder = 2;
    rails.receiveShadow = true;
    root.add(rails);
    this.geometryCache.push(railGeometry, railMaterial);
    if (tieAttrs.position.length) {
      const tieGeometry = buildDynGeometry(tieAttrs);
      const tieMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.86,
        flatShading: true,
      });
      const ties = new THREE.Mesh(tieGeometry, tieMaterial);
      ties.name = 'sf-transit-ties';
      ties.renderOrder = 2;
      root.add(ties);
      this.geometryCache.push(tieGeometry, tieMaterial);
    }
    if (wirePoints.length) {
      const wireGeometry = new THREE.BufferGeometry();
      wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wirePoints, 3));
      const wireMaterial = new THREE.LineBasicMaterial({
        color: 0x3d3735,
        transparent: true,
        opacity: 0.22,
      });
      const wires = new THREE.LineSegments(wireGeometry, wireMaterial);
      wires.name = 'sf-transit-overhead';
      root.add(wires);
      this.geometryCache.push(wireGeometry, wireMaterial);
    }
    if (supportPositions.size) {
      const supportGeometry = new THREE.CylinderGeometry(0.045, 0.065, 7.15, 5);
      const supportMaterial = new THREE.MeshStandardMaterial({
        color: 0x554d49,
        roughness: 0.74,
        metalness: 0.28,
        flatShading: true,
      });
      const supports = new THREE.InstancedMesh(supportGeometry, supportMaterial, supportPositions.size);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      let index = 0;
      for (const support of supportPositions.values()) {
        position.set(support.x, heightAt(support.x, support.z) + roadLift + 3.55, support.z);
        matrix.compose(position, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        supports.setMatrixAt(index, matrix);
        index += 1;
      }
      supports.instanceMatrix.needsUpdate = true;
      supports.castShadow = true;
      supports.name = 'sf-transit-supports';
      root.add(supports);
      this.geometryCache.push(supportGeometry, supportMaterial);
    }
  }

  buildTrees(root, city) {
    const random = mulberry32(Number(city.meta.seedInt) + 991);
    const treeData = [];
    const bounds = city.meta.bounds;
    if (city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap') {
      // Dense sidewalk trees along real polylines, like a real SF street.
      for (const segment of city.segments || []) {
        if (treeData.length >= 700) break;
        if (!['primary', 'secondary', 'tertiary', 'residential'].includes(segment.highway)) continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 18 || length > 360) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const spacing = segment.highway === 'primary' || segment.highway === 'secondary' ? 17 : 14;
        const count = Math.min(20, Math.max(2, Math.round(length / spacing)));
        for (let i = 0; i < count; i += 1) {
          if (treeData.length >= 700) break;
          if (random() < 0.08) continue;
          const t = (i + 0.5) / count;
          const side = i % 2 === 0 ? 1 : -1;
          const offset = segment.width / 2 + segment.sidewalkW * 0.55;
          treeData.push({
            x: a.x + dx * t + nx * offset * side,
            z: a.z + dz * t + nz * offset * side,
            scale: 0.8 + random() * 0.6,
          });
        }
      }
    } else {
      for (const street of city.streets) {
        const perpendicular = street.axis === 'x' ? 'z' : 'x';
        const position = street.position;
        const spacing = street.highway === 'primary' || street.highway === 'secondary' ? 36 : 27;
        const start = bounds[perpendicular === 'z' ? 'minZ' : 'minX'] + 18;
        const end = bounds[perpendicular === 'z' ? 'maxZ' : 'maxX'] - 18;
        for (let v = start; v < end; v += spacing + random() * 18) {
          if (random() < 0.04) continue;
          const side = random() < 0.5 ? -1 : 1;
          const sidewalkHalf = street.sidewalkW + street.asphaltWidth / 2 + 1.6;
          const x = street.axis === 'x' ? position + side * sidewalkHalf : v;
          const z = street.axis === 'z' ? position + side * sidewalkHalf : v;
          if (Math.abs(x) > bounds.maxX - 8 || Math.abs(z) > bounds.maxZ - 8) continue;
          treeData.push({ x, z, scale: 0.8 + random() * 0.6 });
        }
      }
    }
    for (const block of city.blocks) {
      if (block.landUse !== 'park') continue;
      const area = ringArea(block.polygon);
      const count = Math.max(6, Math.min(18, Math.round(area / 380)));
      for (let i = 0; i < count; i += 1) {
        const x = block.polygon[0].x + random() * (block.polygon[1].x - block.polygon[0].x);
        const z = block.polygon[0].z + random() * (block.polygon[3].z - block.polygon[0].z);
        if (pointInPolygon({ x, z }, block.polygon)) treeData.push({ x, z, scale: 1.0 + random() * 0.9, park: true });
      }
    }
    // Trees are instanced: hundreds of low-poly trees cost three draw calls.
    const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.24, 1.5, 5);
    const canopyGeometry = new THREE.ConeGeometry(1.25, 2.6, 7);
    const topGeometry = new THREE.SphereGeometry(0.55, 6, 5);
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x7a5a44, roughness: 0.9, flatShading: true });
    const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0x7ba265, roughness: 0.85, flatShading: true });
    const topMaterial = new THREE.MeshStandardMaterial({ color: 0x93b56f, roughness: 0.85, flatShading: true });
    const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, treeData.length);
    const canopyMesh = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, treeData.length);
    const topMesh = new THREE.InstancedMesh(topGeometry, topMaterial, treeData.length);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    for (let i = 0; i < treeData.length; i += 1) {
      const tree = treeData[i];
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(tree.x, tree.z) : 0) + 0.05;
      position.set(tree.x, y + 0.75 * tree.scale, tree.z);
      scale.set(tree.scale, tree.scale, tree.scale);
      matrix.compose(position, quaternion, scale);
      trunkMesh.setMatrixAt(i, matrix);
      position.y = y + 2.5 * tree.scale;
      matrix.compose(position, quaternion, scale);
      canopyMesh.setMatrixAt(i, matrix);
      position.y = y + 3.1 * tree.scale;
      matrix.compose(position, quaternion, scale);
      topMesh.setMatrixAt(i, matrix);
    }
    trunkMesh.castShadow = true;
    canopyMesh.castShadow = true;
    topMesh.castShadow = true;
    root.add(trunkMesh, canopyMesh, topMesh);
    this.geometryCache.push(trunkGeometry, canopyGeometry, topGeometry);
    this.buildSidewalkProps(root, city, random);
  }

  buildSidewalkProps(root, city, random) {
    const planterColor = new THREE.MeshStandardMaterial({ color: 0x8a5f46, roughness: 0.85, flatShading: true });
    const leafColor = new THREE.MeshStandardMaterial({ color: 0x4f7f4a, roughness: 0.85, flatShading: true });
    const benchColor = new THREE.MeshStandardMaterial({ color: 0x6f5c48, roughness: 0.8, flatShading: true });
    const hydrantColor = new THREE.MeshStandardMaterial({ color: 0xc9483a, roughness: 0.55, metalness: 0.3, flatShading: true });
    const coneColor = new THREE.MeshStandardMaterial({ color: 0xff7a1f, roughness: 0.6, flatShading: true });
    const signPoleColor = new THREE.MeshStandardMaterial({ color: 0x4b4f54, roughness: 0.6, metalness: 0.4, flatShading: true });
    const signBoardColors = ['#e85d4a', '#2f9fb0', '#e5a72f', '#4f9e58', '#8a5fc0'];
    const signBoardMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, flatShading: true });
    const props = [];
    const bounds = city.meta.bounds;
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const maxProps = realMap ? 900 : 1000;
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);
    const pushProp = (x, z, placement = null) => {
      if (props.length >= maxProps) return;
      const y = (this.terrain?.heightAt ? this.terrain.heightAt(x, z) : 0) + roadLift + 0.04;
      const roll = random();
      const rotation = placement?.rotation ?? random() * Math.PI;
      const base = { x, y, z, rotation, placement };
      if (roll < 0.45) {
        const flowerColors = ['#e84393', '#ff4f6d', '#ffd23f', '#7a5cff'];
        const flowers = [];
        for (let f = 0; f < 3; f += 1) {
          flowers.push({
            x: (random() - 0.5) * 0.7,
            z: (random() - 0.5) * 0.7,
            color: flowerColors[Math.floor(random() * flowerColors.length)],
          });
        }
        props.push({ kind: 'planter', ...base, flowers });
      } else if (roll < 0.62) {
        props.push({ kind: 'bench', ...base });
      } else if (roll < 0.78) {
        props.push({ kind: 'hydrant', ...base });
      } else if (roll < 0.9) {
        props.push({ kind: 'cone', ...base });
      } else {
        props.push({
          kind: 'sign',
          ...base,
          color: signBoardColors[Math.floor(random() * signBoardColors.length)],
        });
      }
    };
    if (realMap) {
      const roadCellSize = 64;
      const roadCells = new Map();
      const cellKey = (x, z) => `${x}:${z}`;
      for (const segment of city.segments || []) {
        const points = segment.points || [];
        if (points.length < 2) continue;
        const halfWidth = Number(segment.width || 0) / 2 + 0.3;
        const minX = Math.min(...points.map((point) => point.x)) - halfWidth;
        const maxX = Math.max(...points.map((point) => point.x)) + halfWidth;
        const minZ = Math.min(...points.map((point) => point.z)) - halfWidth;
        const maxZ = Math.max(...points.map((point) => point.z)) + halfWidth;
        for (let gx = Math.floor(minX / roadCellSize); gx <= Math.floor(maxX / roadCellSize); gx += 1) {
          for (let gz = Math.floor(minZ / roadCellSize); gz <= Math.floor(maxZ / roadCellSize); gz += 1) {
            const key = cellKey(gx, gz);
            if (!roadCells.has(key)) roadCells.set(key, []);
            roadCells.get(key).push(segment);
          }
        }
      }
      const distanceToSegmentPolyline = (point, segment) => {
        let distance = Infinity;
        for (let index = 1; index < segment.points.length; index += 1) {
          distance = Math.min(distance, pointToSegmentDistance(point, segment.points[index - 1], segment.points[index]));
        }
        return distance;
      };
      const overlapsOtherAsphalt = (x, z, owner) => {
        const nearby = roadCells.get(cellKey(Math.floor(x / roadCellSize), Math.floor(z / roadCellSize))) || [];
        return nearby.some((segment) => segment !== owner
          && segment.streetId !== owner.streetId
          && !['pedestrian', 'footway', 'cycleway'].includes(segment.highway)
          && distanceToSegmentPolyline({ x, z }, segment) < Number(segment.width || 0) / 2 + 0.3);
      };
      for (const segment of city.segments || []) {
        if (props.length >= maxProps) break;
        if (segment.highway === 'pedestrian' || segment.highway === 'footway' || segment.highway === 'cycleway' || segment.highway === 'motorway') continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 24 || length > 460) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const count = Math.min(8, Math.max(2, Math.round(length / 36)));
        for (let i = 0; i < count; i += 1) {
          if (props.length >= maxProps) break;
          if (random() < 0.25) continue;
          const t = (i + 0.5) / count;
          const side = i % 2 === 0 ? 1 : -1;
          const sidewalkWidth = Number(side > 0
            ? segment.sidewalkLeft ?? segment.sidewalkW
            : segment.sidewalkRight ?? segment.sidewalkW) || 0;
          if (sidewalkWidth < 0.8) continue;
          const minOffset = Number(segment.width || 0) / 2 + 0.3;
          const maxOffset = Number(segment.width || 0) / 2 + sidewalkWidth - 0.3;
          if (maxOffset < minOffset) continue;
          const offset = minOffset + (maxOffset - minOffset) * 0.58;
          const x = a.x + dx * t + nx * offset * side;
          const z = a.z + dz * t + nz * offset * side;
          if (overlapsOtherAsphalt(x, z, segment)) continue;
          pushProp(x, z, {
            segmentId: segment.id,
            streetId: segment.streetId,
            side,
            lateralOffset: offset,
            minOffset,
            maxOffset,
            rotation: Math.atan2(dx, dz),
            overlapsAsphalt: false,
          });
        }
      }
    } else {
      for (const street of city.streets) {
        if (props.length >= maxProps) break;
        if (street.highway === 'pedestrian' || street.highway === 'footway' || street.highway === 'cycleway') continue;
        const axis = street.axis;
        const position = street.position;
        const sidewalk = street.sidewalkW + street.asphaltWidth / 2 + 1.5;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 22;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 22;
        for (let v = start; v < end; v += 26 + random() * 14) {
          if (props.length >= maxProps) break;
          if (random() < 0.22) continue;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * sidewalk : v;
          const z = axis === 'z' ? position + side * sidewalk : v;
          if (Math.abs(x) > bounds.maxX - 6 || Math.abs(z) > bounds.maxZ - 6) continue;
          pushProp(x, z);
        }
      }
    }
    const group = new THREE.Group();
    group.name = 'sidewalk-props';
    const mergePropGeometry = (sources) => {
      const merged = mergeGeometries(sources, false);
      for (const source of sources) source.dispose();
      return merged;
    };
    const trashCanGeometry = mergePropGeometry([
      new THREE.CylinderGeometry(0.28, 0.3, 0.86, 8).translate(0, 0.43, 0),
      new THREE.TorusGeometry(0.275, 0.03, 4, 8).rotateX(Math.PI / 2).translate(0, 0.88, 0),
      new THREE.CylinderGeometry(0.3, 0.3, 0.08, 8).translate(0, 0.9, 0),
      new THREE.BoxGeometry(0.28, 0.24, 0.025).translate(0, 0.62, 0.3025),
    ]);
    trashCanGeometry.name = 'sf-trash-can-140t';
    const rackPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.48, 0.06, 0),
      new THREE.Vector3(-0.48, 0.48, 0),
      new THREE.Vector3(-0.36, 0.78, 0),
      new THREE.Vector3(0, 0.9, 0),
      new THREE.Vector3(0.36, 0.78, 0),
      new THREE.Vector3(0.48, 0.48, 0),
      new THREE.Vector3(0.48, 0.06, 0),
    ]);
    const bikeRackGeometry = mergePropGeometry([
      new THREE.TubeGeometry(rackPath, 8, 0.06, 6, false),
      new THREE.BoxGeometry(0.2, 0.04, 0.16).translate(-0.48, 0.02, 0),
      new THREE.BoxGeometry(0.2, 0.04, 0.16).translate(0.48, 0.02, 0),
    ]);
    bikeRackGeometry.name = 'sf-bike-rack-120t';
    const newspaperBoxGeometry = mergePropGeometry([
      new THREE.BoxGeometry(0.3, 0.38, 0.24).translate(0, 0.19, 0),
      new THREE.BoxGeometry(0.52, 0.72, 0.42).translate(0, 0.74, 0),
      new THREE.BoxGeometry(0.56, 0.1, 0.46).translate(0, 1.15, 0),
      new THREE.BoxGeometry(0.38, 0.28, 0.03).translate(0, 0.78, 0.225),
    ]);
    newspaperBoxGeometry.name = 'sf-newspaper-box-48t';
    const payStationGeometry = mergePropGeometry([
      new THREE.BoxGeometry(0.34, 0.08, 0.3).translate(0, 0.04, 0),
      new THREE.CylinderGeometry(0.1, 0.12, 0.78, 6).translate(0, 0.47, 0),
      new THREE.BoxGeometry(0.34, 0.48, 0.18).translate(0, 0.94, 0),
      new THREE.BoxGeometry(0.4, 0.06, 0.23).translate(0, 1.2, 0.025),
      new THREE.BoxGeometry(0.18, 0.22, 0.015).translate(0, 0.96, 0.098),
    ]);
    payStationGeometry.name = 'sf-pay-station-72t';
    const geometries = {
      planter: new THREE.BoxGeometry(0.8, 0.55, 0.8),
      leaf: new THREE.SphereGeometry(0.55, 6, 5),
      flower: new THREE.SphereGeometry(0.09, 5, 4),
      bench: new THREE.BoxGeometry(1.6, 0.1, 0.62),
      benchBack: new THREE.BoxGeometry(1.6, 0.55, 0.08),
      hydrant: new THREE.CylinderGeometry(0.18, 0.22, 0.75, 6),
      cone: new THREE.CylinderGeometry(0.02, 0.2, 0.55, 6),
      coneBand: new THREE.CylinderGeometry(0.13, 0.16, 0.1, 6),
      signPole: new THREE.BoxGeometry(0.08, 1.5, 0.08),
      signBoard: new THREE.BoxGeometry(0.62, 0.42, 0.06),
      trashCan: trashCanGeometry,
      bikeRack: bikeRackGeometry,
      newspaperBox: newspaperBoxGeometry,
      payStation: payStationGeometry,
    };
    const flowerMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const color = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    const batches = [];
    const presentationOwner = (prop) => prop.parent || prop;
    const matrixFor = (prop, yOffset, xOffset = 0, zOffset = 0) => {
      const requestedScale = Number(prop.presentationScale
        ?? prop.placement?.presentationScale
        ?? prop.parent?.presentationScale
        ?? prop.parent?.placement?.presentationScale
        ?? 1);
      const presentationScale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1;
      const sin = Math.sin(prop.rotation);
      const cos = Math.cos(prop.rotation);
      position.set(
        prop.x + (xOffset * cos + zOffset * sin) * presentationScale,
        prop.y + yOffset * presentationScale,
        prop.z + (-xOffset * sin + zOffset * cos) * presentationScale,
      );
      quaternion.setFromAxisAngle(up, prop.rotation);
      const owner = presentationOwner(prop);
      const baseHidden = owner.presentationKind && owner.presentationKind !== owner.kind;
      scale.setScalar(baseHidden ? 0 : presentationScale);
      return matrix.compose(position, quaternion, scale);
    };
    const addBatch = ({ name, geometry, material, records, y, x = 0, z = 0, colorFor = null, castShadow = true }) => {
      if (!records.length) return;
      const mesh = new THREE.InstancedMesh(geometry, material, records.length);
      mesh.name = name;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = castShadow;
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        mesh.setMatrixAt(i, matrixFor(record, y, x, z));
        if (colorFor) mesh.setColorAt(i, color.set(colorFor(record)));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      batches.push({ mesh, records, y, x, z, colorFor });
    };
    const planters = props.filter((prop) => prop.kind === 'planter');
    const benches = props.filter((prop) => prop.kind === 'bench');
    const hydrants = props.filter((prop) => prop.kind === 'hydrant');
    const cones = props.filter((prop) => prop.kind === 'cone');
    const signs = props.filter((prop) => prop.kind === 'sign');
    const flowers = planters.flatMap((prop) => prop.flowers.map((flower) => ({
      ...prop,
      parent: prop,
      flowerX: flower.x,
      flowerZ: flower.z,
      color: flower.color,
    })));
    addBatch({ name: 'planter-pots', geometry: geometries.planter, material: planterColor, records: planters, y: 0.28 });
    addBatch({ name: 'planter-leaves', geometry: geometries.leaf, material: leafColor, records: planters, y: 1.05 });
    addBatch({ name: 'planter-flowers', geometry: geometries.flower, material: flowerMaterial, records: flowers, y: 1.32, x: 0, z: 0, colorFor: (prop) => prop.color, castShadow: false });
    if (flowers.length) {
      const flowerMesh = group.getObjectByName('planter-flowers');
      for (let i = 0; i < flowers.length; i += 1) {
        flowerMesh.setMatrixAt(i, matrixFor(flowers[i], 1.32, flowers[i].flowerX, flowers[i].flowerZ));
      }
      flowerMesh.instanceMatrix.needsUpdate = true;
    }
    const accentSpecs = Object.freeze([
      { kind: 'trash-can', name: 'sf-trash-cans', geometry: trashCanGeometry, color: '#3f514b', capacity: 2 },
      { kind: 'bike-rack', name: 'sf-bike-racks', geometry: bikeRackGeometry, color: '#8d9699' },
      { kind: 'newspaper-box', name: 'sf-newspaper-boxes', geometry: newspaperBoxGeometry, color: '#d5a22d' },
      { kind: 'pay-station', name: 'sf-pay-stations', geometry: payStationGeometry, color: '#506b73' },
    ]);
    const accentMeshes = new Map();
    for (const spec of accentSpecs) {
      const capacity = spec.capacity || 1;
      const mesh = new THREE.InstancedMesh(spec.geometry, signBoardMaterial, capacity);
      mesh.name = spec.name;
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let index = 0; index < capacity; index += 1) mesh.setColorAt(index, color.set(spec.color));
      mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      accentMeshes.set(spec.kind, { mesh, color: spec.color });
    }
    const refreshAccentMatrices = () => {
      for (const [kind, accent] of accentMeshes) {
        const records = props.filter((prop) => prop.presentationKind === kind);
        accent.mesh.count = Math.min(records.length, accent.mesh.instanceMatrix.count);
        accent.mesh.visible = accent.mesh.count > 0;
        if (!accent.mesh.count) continue;
        for (let index = 0; index < accent.mesh.count; index += 1) {
          const prop = records[index];
          const requestedScale = Number(prop.presentationScale ?? prop.placement?.presentationScale ?? 1);
          const presentationScale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1;
          position.set(prop.x, prop.y, prop.z);
          quaternion.setFromAxisAngle(up, prop.rotation);
          scale.setScalar(presentationScale);
          accent.mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
          accent.mesh.setColorAt(index, color.set(accent.color));
        }
        accent.mesh.instanceMatrix.needsUpdate = true;
        accent.mesh.instanceColor.needsUpdate = true;
        accent.mesh.computeBoundingBox();
        accent.mesh.computeBoundingSphere();
      }
    };
    const refreshMatrices = (movedProps) => {
      const moved = new Set(movedProps);
      for (const flower of flowers) {
        if (!moved.has(flower.parent)) continue;
        flower.x = flower.parent.x;
        flower.y = flower.parent.y;
        flower.z = flower.parent.z;
        flower.rotation = flower.parent.rotation;
        flower.placement = flower.parent.placement;
      }
      for (const batch of batches) {
        let updated = false;
        for (let i = 0; i < batch.records.length; i += 1) {
          const record = batch.records[i];
          if (!moved.has(record) && !moved.has(record.parent)) continue;
          batch.mesh.setMatrixAt(i, matrixFor(record, batch.y, batch.x, batch.z));
          if (batch.colorFor) batch.mesh.setColorAt(i, color.set(batch.colorFor(record)));
          updated = true;
        }
        if (updated) batch.mesh.instanceMatrix.needsUpdate = true;
        if (updated && batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      }
      refreshAccentMatrices();
    };
    addBatch({ name: 'bench-seats', geometry: geometries.bench, material: benchColor, records: benches, y: 0.45 });
    addBatch({ name: 'bench-backs', geometry: geometries.benchBack, material: benchColor, records: benches, y: 0.8, z: -0.28 });
    addBatch({ name: 'hydrants', geometry: geometries.hydrant, material: hydrantColor, records: hydrants, y: 0.4 });
    addBatch({ name: 'traffic-cones', geometry: geometries.cone, material: coneColor, records: cones, y: 0.28 });
    addBatch({ name: 'traffic-cone-bands', geometry: geometries.coneBand, material: signPoleColor, records: cones, y: 0.24 });
    addBatch({ name: 'street-sign-poles', geometry: geometries.signPole, material: signPoleColor, records: signs, y: 0.75 });
    addBatch({ name: 'street-sign-boards', geometry: geometries.signBoard, material: signBoardMaterial, records: signs, y: 1.55, colorFor: (prop) => prop.color });
    this.geometryCache.push(...Object.values(geometries));
    this.streetFurniture.props = props.length;
    this.sidewalkPropRecords = props.map((prop) => ({
      kind: prop.kind,
      x: prop.x,
      z: prop.z,
      ...(prop.placement || {}),
    }));
    this.sidewalkPropDiagnostics = {
      bandViolations: this.sidewalkPropRecords.filter((record) => record.segmentId
        && (record.lateralOffset < record.minOffset - 1e-6 || record.lateralOffset > record.maxOffset + 1e-6)).length,
      asphaltOverlaps: this.sidewalkPropRecords.filter((record) => record.overlapsAsphalt).length,
      heroFrontages: createHeroSidewalkDiagnostics(props.length),
    };
    this.sidewalkPropRuntime = {
      props,
      refreshMatrices,
      accentMeshes,
      presentationResources: { ...HERO_CURB_PRESENTATION_RESOURCES },
    };
    root.add(group);
  }

  stageHeroSidewalkLife(portals, city) {
    const runtime = this.sidewalkPropRuntime;
    const logicalPropsBefore = runtime?.props?.length || 0;
    const diagnostics = createHeroSidewalkDiagnostics(logicalPropsBefore);
    this.sidewalkPropDiagnostics.heroFrontages = diagnostics;
    const reject = (stage, details = null) => {
      diagnostics.failure = { stage, details };
      return false;
    };
    if (!runtime || logicalPropsBefore !== 900 || !Array.isArray(portals) || !Array.isArray(city?.buildings)) {
      return reject('runtime-contract');
    }

    const expectedIds = diagnostics.expectedIds;
    const heroPortals = expectedIds.map((id) => portals.find((portal) => portal.buildingId === id));
    const heroBuildings = expectedIds.map((id) => city.buildings.find((building) => building.id === id));
    if (heroPortals.some((portal) => !portal) || heroBuildings.some((building) => !building)) {
      return reject('hero-source-contract');
    }

    const propRadius = Object.freeze({ planter: 0.57, bench: 0.86, sign: 0.35, hydrant: 0.3, cone: 0.21 });
    const vehicleRoads = [];
    const sourceRoads = [];
    for (const segment of city.segments || []) {
      const points = Array.isArray(segment?.points) ? segment.points : [];
      if (points.length < 2) continue;
      sourceRoads.push(segment);
      if (['pedestrian', 'footway', 'cycleway', 'motorway'].includes(segment.highway)) continue;
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1];
        const b = points[index];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length <= 1e-6) continue;
        vehicleRoads.push({
          segment,
          a,
          b,
          dx,
          dz,
          length,
          tx: dx / length,
          tz: dz / length,
          nx: -dz / length,
          nz: dx / length,
          halfWidth: Number(segment.width || 0) / 2,
        });
      }
    }

    const closestPoint = (point, a, b) => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      const t = lengthSq > 0
        ? clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq, 0, 1)
        : 0;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      return { x, z, t, distance: Math.hypot(point.x - x, point.z - z) };
    };
    const boundaryDistance = (point, polygon) => {
      if (!Array.isArray(polygon) || polygon.length < 3) return Infinity;
      let distance = Infinity;
      for (let index = 0; index < polygon.length; index += 1) {
        distance = Math.min(distance, pointToSegmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]));
      }
      return pointInPolygon(point, polygon) ? -distance : distance;
    };
    const sidewalkWidthFor = (segment, side) => Number(side > 0
      ? segment.sidewalkLeft ?? segment.sidewalkW
      : segment.sidewalkRight ?? segment.sidewalkW) || 0;
    const roleKind = (role) => role.startsWith('planter') ? 'planter' : role;
    const edgeFor = (building, portal) => {
      const polygon = building.polygon || [];
      const edgeIndex = Number(portal.sourceMetadata?.edgeIndex);
      const a = polygon[edgeIndex];
      const b = polygon[(edgeIndex + 1) % polygon.length];
      if (!a || !b) return null;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (!Number.isFinite(length) || length <= 1e-6) return null;
      return {
        a,
        b,
        length,
        tx: dx / length,
        tz: dz / length,
        midpoint: { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 },
      };
    };
    const ownerFor = (edge) => {
      let best = null;
      for (const road of vehicleRoads) {
        for (const side of [-1, 1]) {
          const sidewalkWidth = sidewalkWidthFor(road.segment, side);
          const radius = propRadius.bench;
          const minOffset = road.halfWidth + 0.3 + radius;
          const maxOffset = road.halfWidth + sidewalkWidth - 0.3 - radius;
          if (maxOffset < minOffset) continue;
          const projection = closestPoint(edge.midpoint, road.a, road.b);
          const lateralOffset = (minOffset + maxOffset) * 0.5;
          const point = {
            x: projection.x + road.nx * lateralOffset * side,
            z: projection.z + road.nz * lateralOffset * side,
          };
          const distance = pointToSegmentDistance(point, edge.a, edge.b);
          const endpointClearance = Math.min(projection.t * road.length, (1 - projection.t) * road.length) - radius;
          const score = distance + (endpointClearance < 0.3 ? 1000 : 0);
          if (!best || score < best.score) best = { road, side, distance, score };
        }
      }
      return best;
    };
    const sourceSegmentFor = (portal, edge) => {
      const streetId = portal.sourceMetadata?.street?.id;
      const candidates = sourceRoads.filter((segment) => String(segment.streetId) === String(streetId));
      const pool = candidates.length ? candidates : sourceRoads;
      return pool.map((segment) => ({
        segment,
        distance: Math.min(...segment.points.slice(1).map((point, index) => (
          pointToSegmentDistance(edge.midpoint, segment.points[index], point)
        ))),
      })).sort((left, right) => left.distance - right.distance || String(left.segment.id).localeCompare(String(right.segment.id)))[0]?.segment || null;
    };
    const sourceOffsetLayout = (roles, edgeLength) => {
      const half = edgeLength * 0.5;
      const extras = roles.filter((role) => !role.startsWith('planter'));
      const extraOffsets = new Map();
      if (extras.length === 1) {
        const radius = propRadius[roleKind(extras[0])];
        extraOffsets.set(extras[0], half - radius - 0.22);
      } else if (extras.length === 2) {
        extraOffsets.set(extras[0], -half + propRadius[roleKind(extras[0])] + 0.22);
        extraOffsets.set(extras[1], half - propRadius[roleKind(extras[1])] - 0.22);
      }
      let planterOffset = Math.min(2.55, half * 0.32);
      for (const [role, offset] of extraOffsets) {
        const radius = propRadius[roleKind(role)];
        const available = Math.abs(offset) - radius - propRadius.planter - 0.28;
        planterOffset = Math.min(planterOffset, available);
      }
      planterOffset = Math.max(0.76, planterOffset);
      return new Map([
        ['planter-left', -planterOffset],
        ['planter-right', planterOffset],
        ...extraOffsets,
      ]);
    };

    const footprintSnapshot = JSON.stringify(heroBuildings.map((building) => ({ id: building.id, polygon: building.polygon })));
    const portalSnapshot = JSON.stringify(heroPortals.map((portal) => ({
      id: portal.id,
      buildingId: portal.buildingId,
      position: portal.position,
      approach: portal.approach,
      heading: portal.heading,
      sourceMetadata: portal.sourceMetadata,
    })));
    const heroEdges = heroBuildings.map((building, index) => edgeFor(building, heroPortals[index]));
    if (heroEdges.some((edge) => !edge)) return reject('hero-edge-contract');
    const corridorSegment = (city.segments || []).find((segment) => segment.id === HERO_CURB_RHYTHM.segmentId);
    const corridorRoad = vehicleRoads.find((road) => road.segment === corridorSegment);
    const corridorSidewalkWidth = sidewalkWidthFor(corridorSegment, HERO_CURB_RHYTHM.side);
    if (!corridorRoad
      || corridorSegment.streetId !== HERO_CURB_RHYTHM.streetId
      || corridorSegment.points?.length !== 2
      || Number(corridorSegment.width) !== 6.4
      || corridorSidewalkWidth !== 2.4) return reject('corridor-source-contract');
    const corridorSourceRecord = () => ({
      id: corridorSegment.id,
      streetId: corridorSegment.streetId,
      endpoints: corridorSegment.points.map((point) => ({ x: point.x, z: point.z })),
      widthMeters: Number(corridorSegment.width),
      sidewalkWidthMeters: corridorSidewalkWidth,
    });
    const corridorSourceSnapshot = JSON.stringify(corridorSourceRecord());
    const selected = [];
    const occupied = runtime.props.map((prop) => ({
      x: prop.x,
      z: prop.z,
      radius: propRadius[prop.kind] || 0.25,
    }));
    const portalCapsuleRadius = 0.6;
    const minimumPortalClearance = 1.2;
    const minimumInterPropClearance = 0.2;

    const measureCandidate = (candidate, radius, ownerStreetId) => {
      let asphaltClearance = Infinity;
      let absoluteAsphaltClearance = Infinity;
      let asphaltOverlap = false;
      for (const road of vehicleRoads) {
        const clearance = pointToSegmentDistance(candidate, road.a, road.b) - road.halfWidth - radius;
        absoluteAsphaltClearance = Math.min(absoluteAsphaltClearance, clearance);
        if (String(road.segment.streetId) === String(ownerStreetId)) continue;
        if (clearance < 0.3) asphaltOverlap = true;
        asphaltClearance = Math.min(asphaltClearance, clearance);
      }
      let buildingClearance = Infinity;
      for (const building of city.buildings) {
        buildingClearance = Math.min(buildingClearance, boundaryDistance(candidate, building.polygon) - radius);
      }
      let portalCorridorClearance = Infinity;
      for (const portal of heroPortals) {
        portalCorridorClearance = Math.min(
          portalCorridorClearance,
          pointToSegmentDistance(candidate, portal.position, portal.approach) - radius - portalCapsuleRadius,
        );
      }
      let interPropClearance = Infinity;
      for (const prop of occupied) {
        interPropClearance = Math.min(interPropClearance, Math.hypot(candidate.x - prop.x, candidate.z - prop.z) - radius - prop.radius);
      }
      return {
        asphaltClearance,
        absoluteAsphaltClearance,
        asphaltOverlap,
        buildingClearance,
        portalCorridorClearance,
        interPropClearance,
      };
    };

    for (let heroIndex = 0; heroIndex < expectedIds.length; heroIndex += 1) {
      const id = expectedIds[heroIndex];
      const portal = heroPortals[heroIndex];
      const building = heroBuildings[heroIndex];
      const edge = heroEdges[heroIndex];
      const roles = HERO_SIDEWALK_ROLES.get(id);
      const offsets = sourceOffsetLayout(roles, edge.length);
      const vehicleOwner = ownerFor(edge);
      const preferredPlacementMode = vehicleOwner?.distance <= 6 ? 'vehicle-sidewalk-band' : 'source-frontage-ribbon';
      const sourceOwner = sourceSegmentFor(portal, edge);
      const entryPlacements = [];

      for (const role of roles) {
        const kind = roleKind(role);
        const presentationOverride = HERO_FRONTAGE_PRESENTATION_OVERRIDES.get(`${id}:${role}`) || null;
        const presentationKind = presentationOverride?.presentationKind || kind;
        const radius = propRadius[kind];
        const baseOffset = offsets.get(role);
        const baselineAsphaltClearance = Math.min(
          measureCandidate(portal.position, radius, null).absoluteAsphaltClearance,
          measureCandidate(portal.approach, radius, null).absoluteAsphaltClearance,
        );
        const minimumAbsoluteAsphaltClearance = baselineAsphaltClearance < 0.3
          ? baselineAsphaltClearance - 1e-6
          : 0.3;
        let accepted = null;
        const alongAdjustments = [
          0, 0.18, -0.18, 0.36, -0.36, 0.54, -0.54,
          0.9, -0.9, 1.5, -1.5, 2.1, -2.1, 2.7, -2.7, 3.3, -3.3,
        ];
        const ribbonOffsets = [1.65, 1.9, 1.4, 2.1, 1.15];
        const bandFractions = [0.18, 0.5, 0.82];
        const placementModes = preferredPlacementMode === 'vehicle-sidewalk-band'
          ? ['vehicle-sidewalk-band', 'source-frontage-ribbon']
          : ['source-frontage-ribbon'];
        for (const placementMode of placementModes) {
          if (accepted) break;
          for (const alongAdjustment of alongAdjustments) {
            if (accepted) break;
            const sourceOffset = baseOffset + alongAdjustment;
            const sourcePoint = {
              x: edge.midpoint.x + edge.tx * sourceOffset,
              z: edge.midpoint.z + edge.tz * sourceOffset,
            };
            const sourceEndpointClearance = edge.length * 0.5 - Math.abs(sourceOffset) - radius;
            if (sourceEndpointClearance < 0.15) continue;
            const attempts = placementMode === 'vehicle-sidewalk-band' ? bandFractions : ribbonOffsets;
            for (const attempt of attempts) {
            let point;
            let rotation;
            let ownerSegment;
            let side;
            let lateralOffset;
            let minOffset;
            let maxOffset;
            let sidewalkWidth;
            let roadEndpointClearance = Infinity;
            if (placementMode === 'vehicle-sidewalk-band') {
              const { road } = vehicleOwner;
              ownerSegment = road.segment;
              side = vehicleOwner.side;
              sidewalkWidth = sidewalkWidthFor(ownerSegment, side);
              minOffset = road.halfWidth + 0.3 + radius;
              maxOffset = road.halfWidth + sidewalkWidth - 0.3 - radius;
              if (maxOffset < minOffset) continue;
              lateralOffset = minOffset + (maxOffset - minOffset) * attempt;
              const projection = closestPoint(sourcePoint, road.a, road.b);
              roadEndpointClearance = Math.min(projection.t * road.length, (1 - projection.t) * road.length) - radius;
              if (roadEndpointClearance < 0.3) continue;
              point = {
                x: projection.x + road.nx * lateralOffset * side,
                z: projection.z + road.nz * lateralOffset * side,
              };
              rotation = Math.atan2(road.dx, road.dz);
            } else {
              ownerSegment = sourceOwner;
              side = 1;
              sidewalkWidth = 1.2;
              minOffset = 1;
              maxOffset = 2.2;
              lateralOffset = attempt;
              point = {
                x: sourcePoint.x + portal.normal.x * lateralOffset,
                z: sourcePoint.z + portal.normal.z * lateralOffset,
              };
              rotation = Math.atan2(edge.tx, edge.tz);
            }
            const measure = measureCandidate(point, radius, ownerSegment?.streetId);
            if (measure.asphaltOverlap
              || measure.asphaltClearance < 0.3
              || measure.absoluteAsphaltClearance < minimumAbsoluteAsphaltClearance
              || measure.buildingClearance < 0.15
              || measure.portalCorridorClearance < minimumPortalClearance
              || measure.interPropClearance < minimumInterPropClearance) continue;
            const terrainHeightMeters = this.terrain?.heightAt ? this.terrain.heightAt(point.x, point.z) : 0;
            const roadLiftMeters = Number(city.meta.streetDesign?.roadLift ?? 0.5);
            const y = terrainHeightMeters + roadLiftMeters + 0.04;
            accepted = {
              kind,
              presentationKind,
              presentationOverrideId: presentationOverride?.id || null,
              presentationScale: 1,
              role,
              x: point.x,
              y,
              z: point.z,
              rotation,
              radius,
              placement: {
                heroFrontageId: id,
                role,
                placementMode,
                segmentId: ownerSegment?.id || null,
                streetId: ownerSegment?.streetId || null,
                side,
                lateralOffset,
                minOffset,
                maxOffset,
                overlapsAsphalt: measure.absoluteAsphaltClearance < 0.3,
              },
              report: {
                kind,
                logicalKind: kind,
                presentationKind,
                presentationOverrideId: presentationOverride?.id || null,
                geometryProfile: presentationOverride ? `sf-${presentationKind}-v1` : `base-${kind}`,
                groundPivoted: true,
                baseInstanceHidden: presentationKind !== kind,
                role,
                placementMode,
                position: { x: point.x, y, z: point.z },
                rotation,
                ownerSegmentId: ownerSegment?.id || null,
                ownerStreetId: ownerSegment?.streetId || null,
                sourceEdgeOffsetMeters: sourceOffset,
                sourceEndpointClearanceMeters: sourceEndpointClearance,
                roadEndpointClearanceMeters: roadEndpointClearance,
                band: {
                  side,
                  lateralOffsetMeters: lateralOffset,
                  minimumOffsetMeters: minOffset,
                  maximumOffsetMeters: maxOffset,
                  sidewalkWidthMeters: sidewalkWidth,
                  fullyContained: lateralOffset >= minOffset - 1e-6 && lateralOffset <= maxOffset + 1e-6,
                },
                terrain: {
                  heightMeters: terrainHeightMeters,
                  roadLiftMeters,
                  groundedY: y,
                  finite: Number.isFinite(terrainHeightMeters) && Number.isFinite(y),
                },
                asphaltClearanceMeters: measure.asphaltClearance,
                asphaltClearanceScope: 'non-owner-street',
                absoluteAsphaltClearanceMeters: measure.absoluteAsphaltClearance,
                baselineAsphaltClearanceMeters: baselineAsphaltClearance,
                inheritedSourceAsphaltOverlap: baselineAsphaltClearance < 0.3,
                additionalAsphaltIntrusion: measure.absoluteAsphaltClearance < minimumAbsoluteAsphaltClearance,
                buildingClearanceMeters: measure.buildingClearance,
                portalCorridorClearanceMeters: measure.portalCorridorClearance,
                interPropClearanceMeters: measure.interPropClearance,
              },
            };
              break;
            }
          }
        }
        if (!accepted) return reject('hero-placement', { id, role });
        selected.push(accepted);
        entryPlacements.push(accepted.report);
        if (presentationOverride) {
          diagnostics.frontagePresentationOverrides.push({
            id: presentationOverride.id,
            heroFrontageId: id,
            role,
            logicalKind: kind,
            presentationKind,
            position: { x: accepted.x, y: accepted.y, z: accepted.z },
            groundPivoted: true,
            baseInstanceHidden: true,
            hiddenBaseComponents: {
              'planter-pots': 1,
              'planter-leaves': 1,
              'planter-flowers': 3,
            },
          });
        }
        occupied.push({ x: accepted.x, z: accepted.z, radius });
      }

      const finiteValues = entryPlacements.flatMap((placement) => [
        placement.position.x,
        placement.position.y,
        placement.position.z,
        placement.rotation,
        placement.sourceEdgeOffsetMeters,
        placement.sourceEndpointClearanceMeters,
        placement.band.lateralOffsetMeters,
        placement.band.minimumOffsetMeters,
        placement.band.maximumOffsetMeters,
        placement.terrain.heightMeters,
        placement.terrain.groundedY,
        placement.asphaltClearanceMeters,
        placement.absoluteAsphaltClearanceMeters,
        placement.baselineAsphaltClearanceMeters,
        placement.buildingClearanceMeters,
        placement.portalCorridorClearanceMeters,
        placement.interPropClearanceMeters,
      ]).filter((value) => value !== Infinity);
      diagnostics.entries.push({
        id,
        sourceEdgeIndex: portal.sourceMetadata.edgeIndex,
        sourceEdgeLength: edge.length,
        ownerSegmentIds: [...new Set(entryPlacements.map((placement) => placement.ownerSegmentId).filter(Boolean))].sort(),
        placements: entryPlacements,
        minimumAsphaltClearanceMeters: Math.min(...entryPlacements.map((placement) => placement.asphaltClearanceMeters)),
        minimumAbsoluteAsphaltClearanceMeters: Math.min(...entryPlacements.map((placement) => placement.absoluteAsphaltClearanceMeters)),
        minimumBuildingClearanceMeters: Math.min(...entryPlacements.map((placement) => placement.buildingClearanceMeters)),
        minimumPortalCorridorClearanceMeters: Math.min(...entryPlacements.map((placement) => placement.portalCorridorClearanceMeters)),
        minimumInterPropClearanceMeters: Math.min(...entryPlacements.map((placement) => placement.interPropClearanceMeters)),
        finite: finiteValues.every(Number.isFinite) && entryPlacements.every((placement) => placement.terrain.finite),
      });
    }

    if (selected.length !== 23) return reject('hero-placement-count', {
      expected: 23,
      actual: selected.length,
    });
    const footprintHalfExtents = Object.freeze({
      planter: { x: propRadius.planter, z: propRadius.planter },
      bench: { x: 0.8, z: 0.31 },
      sign: { x: 0.31, z: 0.04 },
      hydrant: { x: 0.22, z: 0.22 },
      cone: { x: 0.2, z: 0.2 },
    });
    const corridorPlacements = [];
    for (let index = 0; index < HERO_CURB_RHYTHM.t.length; index += 1) {
      const sourceT = HERO_CURB_RHYTHM.t[index];
      const kind = HERO_CURB_RHYTHM.kinds[index];
      const presentationKind = HERO_CURB_RHYTHM.presentationKinds[index];
      const presentationProfile = HERO_CURB_PRESENTATION_PROFILES[presentationKind] || null;
      const baseRadius = presentationProfile?.collisionRadius ?? propRadius[kind];
      const lateralOffset = HERO_CURB_RHYTHM.lateralOffsets[index];
      const presentationScale = HERO_CURB_RHYTHM.presentationScales[index];
      const rotationOffset = HERO_CURB_RHYTHM.rotationOffsets[index];
      const cluster = HERO_CURB_RHYTHM.clusters[index];
      const effectiveRadius = baseRadius * presentationScale;
      const halfExtents = presentationProfile?.halfExtents ?? footprintHalfExtents[kind];
      const circularFootprint = presentationProfile?.circular
        ?? ['planter', 'hydrant', 'cone'].includes(kind);
      const footprintLateralRadius = circularFootprint
        ? halfExtents.x * presentationScale
        : (
          Math.abs(Math.cos(rotationOffset)) * halfExtents.x
          + Math.abs(Math.sin(rotationOffset)) * halfExtents.z
        ) * presentationScale;
      const pedestrianLaneMeters = corridorRoad.halfWidth + corridorSidewalkWidth
        - lateralOffset - footprintLateralRadius;
      const minOffset = corridorRoad.halfWidth + 0.3 + effectiveRadius;
      const maxOffset = corridorRoad.halfWidth + corridorSidewalkWidth - 0.3 - effectiveRadius;
      const sourceEndpointClearance = Math.min(
        sourceT * corridorRoad.length,
        (1 - sourceT) * corridorRoad.length,
      ) - effectiveRadius;
      const point = {
        x: corridorRoad.a.x + corridorRoad.dx * sourceT
          + corridorRoad.nx * lateralOffset * HERO_CURB_RHYTHM.side,
        z: corridorRoad.a.z + corridorRoad.dz * sourceT
          + corridorRoad.nz * lateralOffset * HERO_CURB_RHYTHM.side,
      };
      const measure = measureCandidate(point, effectiveRadius, HERO_CURB_RHYTHM.streetId);
      const ownerAsphaltClearance = pointToSegmentDistance(point, corridorRoad.a, corridorRoad.b)
        - corridorRoad.halfWidth - effectiveRadius;
      const failedGate = [
        ['minimum-band-offset', lateralOffset - minOffset],
        ['maximum-band-offset', maxOffset - lateralOffset],
        ['pedestrian-lane', pedestrianLaneMeters - 0.9],
        ['source-endpoint', sourceEndpointClearance - 0.3],
        ['owner-asphalt', ownerAsphaltClearance - 0.3],
        ['other-asphalt-overlap', measure.asphaltOverlap ? -1 : 0],
        ['other-asphalt', measure.asphaltClearance - 0.3],
        ['absolute-asphalt', measure.absoluteAsphaltClearance - 0.3],
        ['building', measure.buildingClearance - 0.15],
        ['portal-corridor', measure.portalCorridorClearance - minimumPortalClearance],
        ['inter-prop', measure.interPropClearance - minimumInterPropClearance],
      ].find(([, margin]) => margin < -1e-6);
      if (failedGate) {
        diagnostics.corridor = {
          id: HERO_CURB_RHYTHM.id,
          finite: false,
          failure: { index, kind, gate: failedGate[0], marginMeters: failedGate[1] },
        };
        return reject('corridor-placement-gate', diagnostics.corridor.failure);
      }
      const terrainHeightMeters = this.terrain?.heightAt ? this.terrain.heightAt(point.x, point.z) : 0;
      const roadLiftMeters = Number(city.meta.streetDesign?.roadLift ?? 0.5);
      const y = terrainHeightMeters + roadLiftMeters + 0.04;
      if (![point.x, point.z, y, terrainHeightMeters].every(Number.isFinite)) {
        return reject('corridor-non-finite-terrain', { index, kind, point, y, terrainHeightMeters });
      }
      const report = {
        kind,
        logicalKind: kind,
        presentationKind,
        geometryProfile: presentationProfile ? `sf-${presentationKind}-v1` : `base-${kind}`,
        groundPivoted: true,
        baseInstanceHidden: presentationKind !== kind,
        role: kind,
        placementMode: 'vehicle-sidewalk-band',
        position: { x: point.x, y, z: point.z },
        rotation: Math.atan2(corridorRoad.dx, corridorRoad.dz) + rotationOffset,
        presentationScale,
        rotationOffsetRadians: rotationOffset,
        cluster,
        baseCollisionRadiusMeters: baseRadius,
        effectiveCollisionRadiusMeters: effectiveRadius,
        footprintLateralRadiusMeters: footprintLateralRadius,
        pedestrianLaneMeters,
        sourceT,
        lateralOffsetMeters: lateralOffset,
        sourceEndpointClearanceMeters: sourceEndpointClearance,
        roadEndpointClearanceMeters: sourceEndpointClearance,
        ownerSegmentId: corridorSegment.id,
        ownerStreetId: corridorSegment.streetId,
        band: {
          side: HERO_CURB_RHYTHM.side,
          lateralOffsetMeters: lateralOffset,
          minimumOffsetMeters: minOffset,
          maximumOffsetMeters: maxOffset,
          sidewalkWidthMeters: corridorSidewalkWidth,
          fullyContained: true,
        },
        terrain: {
          heightMeters: terrainHeightMeters,
          roadLiftMeters,
          groundedY: y,
          finite: true,
        },
        ownerAsphaltClearanceMeters: ownerAsphaltClearance,
        otherAsphaltClearanceMeters: measure.asphaltClearance,
        asphaltClearanceMeters: measure.asphaltClearance,
        asphaltClearanceScope: 'non-owner-street',
        absoluteAsphaltClearanceMeters: measure.absoluteAsphaltClearance,
        baselineAsphaltClearanceMeters: measure.absoluteAsphaltClearance,
        inheritedSourceAsphaltOverlap: false,
        additionalAsphaltIntrusion: false,
        buildingClearanceMeters: measure.buildingClearance,
        portalCorridorClearanceMeters: measure.portalCorridorClearance,
        interPropClearanceMeters: measure.interPropClearance,
      };
      selected.push({
        kind,
        presentationKind,
        role: kind,
        x: point.x,
        y,
        z: point.z,
        rotation: report.rotation,
        radius: effectiveRadius,
        presentationScale,
        placement: {
          corridorId: HERO_CURB_RHYTHM.id,
          role: kind,
          logicalKind: kind,
          presentationKind,
          presentationScale,
          rotationOffsetRadians: rotationOffset,
          cluster,
          effectiveCollisionRadiusMeters: effectiveRadius,
          pedestrianLaneMeters,
          sourceT,
          placementMode: 'vehicle-sidewalk-band',
          segmentId: corridorSegment.id,
          streetId: corridorSegment.streetId,
          side: HERO_CURB_RHYTHM.side,
          lateralOffset,
          minOffset,
          maxOffset,
          overlapsAsphalt: false,
        },
        report,
      });
      corridorPlacements.push(report);
      occupied.push({ x: point.x, z: point.z, radius: effectiveRadius });
    }
    if (selected.length !== 30 || corridorPlacements.length !== 7) {
      return reject('corridor-placement-count', {
        expectedSelected: 30,
        actualSelected: selected.length,
        expectedCorridor: 7,
        actualCorridor: corridorPlacements.length,
      });
    }
    const corridorRoles = corridorPlacements.reduce((counts, placement) => {
      counts[placement.kind] += 1;
      return counts;
    }, { planter: 0, bench: 0, sign: 0, hydrant: 0, cone: 0 });
    const corridorPresentationRoles = corridorPlacements.reduce((counts, placement) => {
      counts[placement.presentationKind] = (counts[placement.presentationKind] || 0) + 1;
      return counts;
    }, {});
    const corridorSpacing = corridorPlacements.slice(1).map((placement, index) => Math.hypot(
      placement.position.x - corridorPlacements[index].position.x,
      placement.position.z - corridorPlacements[index].position.z,
    ));
    diagnostics.corridor = {
      id: HERO_CURB_RHYTHM.id,
      segmentId: corridorSegment.id,
      streetId: corridorSegment.streetId,
      side: HERO_CURB_RHYTHM.side,
      t: [...HERO_CURB_RHYTHM.t],
      logicalKinds: [...HERO_CURB_RHYTHM.kinds],
      visualKinds: [...HERO_CURB_RHYTHM.presentationKinds],
      lateralOffsetsMeters: [...HERO_CURB_RHYTHM.lateralOffsets],
      presentationScales: [...HERO_CURB_RHYTHM.presentationScales],
      rotationOffsetsRadians: [...HERO_CURB_RHYTHM.rotationOffsets],
      clusters: [...HERO_CURB_RHYTHM.clusters],
      donorRecords: corridorPlacements.length,
      roles: corridorRoles,
      presentationRoles: corridorPresentationRoles,
      presentationReplacementCount: corridorPlacements.filter((placement) => placement.baseInstanceHidden).length,
      hiddenBaseInstances: HERO_CORRIDOR_PRESENTATION_RESOURCES.hiddenBaseInstances,
      visibleAccentInstances: HERO_CORRIDOR_PRESENTATION_RESOURCES.visibleAccentInstances,
      presentationResources: { ...HERO_CORRIDOR_PRESENTATION_RESOURCES },
      source: { ...corridorSourceRecord(), unchanged: false },
      sourceSnapshotUnchanged: false,
      placements: corridorPlacements,
      minimumSpacingMeters: Math.min(...corridorSpacing),
      minimumSourceEndpointClearanceMeters: Math.min(...corridorPlacements.map((placement) => placement.sourceEndpointClearanceMeters)),
      minimumOwnerAsphaltClearanceMeters: Math.min(...corridorPlacements.map((placement) => placement.ownerAsphaltClearanceMeters)),
      minimumOtherAsphaltClearanceMeters: Math.min(...corridorPlacements.map((placement) => placement.otherAsphaltClearanceMeters)),
      minimumAbsoluteAsphaltClearanceMeters: Math.min(...corridorPlacements.map((placement) => placement.absoluteAsphaltClearanceMeters)),
      minimumBuildingClearanceMeters: Math.min(...corridorPlacements.map((placement) => placement.buildingClearanceMeters)),
      minimumPortalCorridorClearanceMeters: Math.min(...corridorPlacements.map((placement) => placement.portalCorridorClearanceMeters)),
      minimumInterPropClearanceMeters: Math.min(...corridorPlacements.map((placement) => placement.interPropClearanceMeters)),
      minimumPedestrianLaneMeters: Math.min(...corridorPlacements.map((placement) => placement.pedestrianLaneMeters)),
      finite: corridorPlacements.every((placement) => placement.terrain.finite
        && placement.pedestrianLaneMeters >= 0.9
        && [
          placement.position.x,
          placement.position.y,
          placement.position.z,
          placement.rotation,
          placement.rotationOffsetRadians,
          placement.presentationScale,
          placement.effectiveCollisionRadiusMeters,
          placement.footprintLateralRadiusMeters,
          placement.pedestrianLaneMeters,
        ].every(Number.isFinite))
        && corridorSpacing.every(Number.isFinite),
    };
    const donorPools = new Map(['planter', 'bench', 'sign', 'hydrant', 'cone'].map((kind) => [kind, []]));
    for (let index = 0; index < runtime.props.length; index += 1) {
      const prop = runtime.props[index];
      if (!donorPools.has(prop.kind) || prop.placement?.heroFrontageId || prop.placement?.corridorId) continue;
      const distanceToHeroEdges = Math.min(...heroEdges.map((edge) => (
        pointToSegmentDistance(prop, edge.a, edge.b)
      )));
      const distanceToCorridor = pointToSegmentDistance(prop, corridorRoad.a, corridorRoad.b);
      const donorDistance = Math.min(distanceToHeroEdges, distanceToCorridor);
      if (distanceToHeroEdges < HERO_SIDEWALK_DONOR_RADIUS
        || distanceToCorridor < HERO_SIDEWALK_DONOR_RADIUS) continue;
      donorPools.get(prop.kind).push({
        prop,
        index,
        donorDistance,
        distanceToHeroEdges,
        distanceToCorridor,
      });
    }
    for (const pool of donorPools.values()) pool.sort((left, right) => (
      right.donorDistance - left.donorDistance
      || right.distanceToHeroEdges - left.distanceToHeroEdges
      || right.distanceToCorridor - left.distanceToCorridor
      || left.index - right.index
    ));
    const requiredByKind = selected.reduce((counts, placement) => {
      counts[placement.kind] += 1;
      return counts;
    }, { planter: 0, bench: 0, sign: 0, hydrant: 0, cone: 0 });
    const insufficientDonorPool = [...donorPools]
      .find(([kind, pool]) => pool.length < requiredByKind[kind]);
    if (insufficientDonorPool) {
      const [kind, pool] = insufficientDonorPool;
      return reject('donor-pool-capacity', {
        kind,
        available: pool.length,
        required: requiredByKind[kind],
      });
    }

    const donorOffsets = { planter: 0, bench: 0, sign: 0, hydrant: 0, cone: 0 };
    const movedDonors = [];
    const donorOrigins = [];
    for (const placement of selected) {
      const donorRecord = donorPools.get(placement.kind)[donorOffsets[placement.kind]++];
      const donor = donorRecord.prop;
      const donorOrigin = {
        index: donorRecord.index,
        position: { x: donor.x, z: donor.z },
        alreadyStaged: false,
        distanceToHeroEdgesMeters: donorRecord.distanceToHeroEdges,
        distanceToCorridorMeters: donorRecord.distanceToCorridor,
        minimumDistanceMeters: donorRecord.donorDistance,
      };
      placement.report.donorOrigin = donorOrigin;
      donorOrigins.push(donorOrigin);
      donor.x = placement.x;
      donor.y = placement.y;
      donor.z = placement.z;
      donor.rotation = placement.rotation;
      donor.presentationScale = placement.presentationScale || 1;
      donor.presentationKind = placement.presentationKind || donor.kind;
      donor.placement = placement.placement;
      movedDonors.push(donor);
    }
    runtime.refreshMatrices(movedDonors);
    const accentPresentationCounts = runtime.props.reduce((counts, prop) => {
      if (!HERO_CURB_PRESENTATION_PROFILES[prop.presentationKind]) return counts;
      counts[prop.presentationKind] = (counts[prop.presentationKind] || 0) + 1;
      return counts;
    }, {});
    const accentRuntimeValid = runtime.accentMeshes?.size === 4
      && [...runtime.accentMeshes].every(([kind, accent]) => (
        HERO_CURB_PRESENTATION_PROFILES[kind]
        && accent.mesh.count === accentPresentationCounts[kind]
        && accent.mesh.visible === (accent.mesh.count > 0)
        && accent.mesh.instanceMatrix
      ))
      && Object.keys(accentPresentationCounts).length === runtime.accentMeshes.size
      && accentPresentationCounts['trash-can'] === 2
      && accentPresentationCounts['bike-rack'] === 1
      && accentPresentationCounts['newspaper-box'] === 1
      && accentPresentationCounts['pay-station'] === 1;
    this.sidewalkPropRecords = runtime.props.map((prop) => ({
      kind: prop.kind,
      x: prop.x,
      z: prop.z,
      ...(prop.placement || {}),
    }));
    this.sidewalkPropDiagnostics.asphaltOverlaps = this.sidewalkPropRecords
      .filter((record) => record.overlapsAsphalt).length;
    const footprintAfter = JSON.stringify(heroBuildings.map((building) => ({ id: building.id, polygon: building.polygon })));
    const portalAfter = JSON.stringify(heroPortals.map((portal) => ({
      id: portal.id,
      buildingId: portal.buildingId,
      position: portal.position,
      approach: portal.approach,
      heading: portal.heading,
      sourceMetadata: portal.sourceMetadata,
    })));
    const corridorSourceAfter = JSON.stringify(corridorSourceRecord());
    diagnostics.corridor.sourceSnapshotUnchanged = corridorSourceSnapshot === corridorSourceAfter;
    diagnostics.corridor.source.unchanged = diagnostics.corridor.sourceSnapshotUnchanged;
    diagnostics.treatedIds = diagnostics.entries.map((entry) => entry.id).sort();
    diagnostics.donorRecords = selected.length;
    diagnostics.logicalPropsAfter = runtime.props.length;
    diagnostics.roles = requiredByKind;
    diagnostics.frontagePresentationOverrides = diagnostics.frontagePresentationOverrides
      .sort((left, right) => left.id.localeCompare(right.id));
    diagnostics.frontagePresentationResources = { ...HERO_FRONTAGE_PRESENTATION_RESOURCES };
    diagnostics.frontagePresentationTopologies = [...new Set(
      diagnostics.frontagePresentationOverrides.map((override) => override.presentationKind),
    )].sort().map((kind) => {
      const mesh = runtime.accentMeshes?.get(kind)?.mesh || null;
      return {
        kind,
        meshName: mesh?.name || null,
        indexCount: mesh?.geometry?.index?.count || 0,
        triangleCount: (mesh?.geometry?.index?.count || 0) / 3,
        vertexCount: mesh?.geometry?.getAttribute('position')?.count || 0,
        instanceCapacity: mesh?.instanceMatrix?.count || 0,
        visibleInstances: mesh?.count || 0,
      };
    });
    diagnostics.incremental = {
      instances: HERO_CURB_PRESENTATION_RESOURCES.gpuInstances,
      drawGroups: HERO_CURB_PRESENTATION_RESOURCES.drawGroups,
      triangles: HERO_CURB_PRESENTATION_RESOURCES.triangles,
      geometries: HERO_CURB_PRESENTATION_RESOURCES.geometries,
      materials: HERO_CURB_PRESENTATION_RESOURCES.materials,
      textures: HERO_CURB_PRESENTATION_RESOURCES.textures,
    };
    diagnostics.donorSelection = {
      strategy: 'same-kind-farthest-v3',
      alreadyStagedExcluded: true,
      distanceScope: 'hero-edges-and-corridor-segment',
      minimumRequiredDistanceMeters: HERO_SIDEWALK_DONOR_RADIUS,
      selectedRecords: donorOrigins.length,
      poolKinds: [...donorPools.keys()].sort(),
      availableByKind: Object.fromEntries([...donorPools].map(([kind, pool]) => [kind, pool.length])),
      requiredByKind: { ...requiredByKind },
      selectedByKind: { ...requiredByKind },
      minimumHeroEdgeDistanceMeters: Math.min(...donorOrigins.map((origin) => origin.distanceToHeroEdgesMeters)),
      minimumCorridorDistanceMeters: Math.min(...donorOrigins.map((origin) => origin.distanceToCorridorMeters)),
      finite: donorOrigins.every((origin) => [
        origin.position.x,
        origin.position.z,
        origin.distanceToHeroEdgesMeters,
        origin.distanceToCorridorMeters,
        origin.minimumDistanceMeters,
      ].every(Number.isFinite)),
    };
    const allPlacementReports = [
      ...diagnostics.entries.flatMap((entry) => entry.placements),
      ...diagnostics.corridor.placements,
    ];
    diagnostics.absoluteAsphaltOverlaps = allPlacementReports.filter((placement) => (
      placement.absoluteAsphaltClearanceMeters < 0.3
    )).length;
    diagnostics.additionalAsphaltIntrusions = allPlacementReports.filter((placement) => (
      placement.additionalAsphaltIntrusion
    )).length;
    diagnostics.asphaltOverlaps = diagnostics.absoluteAsphaltOverlaps;
    diagnostics.buildingOverlaps = allPlacementReports.filter((placement) => (
      placement.buildingClearanceMeters < 0.15
    )).length;
    diagnostics.portalCorridorIntrusions = allPlacementReports.filter((placement) => (
      placement.portalCorridorClearanceMeters < minimumPortalClearance
    )).length;
    diagnostics.sourceFootprintsUnchanged = footprintSnapshot === footprintAfter;
    diagnostics.sourcePortalsUnchanged = portalSnapshot === portalAfter;
    diagnostics.finite = diagnostics.entries.every((entry) => entry.finite)
      && diagnostics.corridor.finite
      && diagnostics.corridor.sourceSnapshotUnchanged
      && accentRuntimeValid
      && diagnostics.frontagePresentationOverrides.length === HERO_FRONTAGE_PRESENTATION_OVERRIDES.size
      && diagnostics.frontagePresentationOverrides.every((override) => (
        HERO_FRONTAGE_PRESENTATION_OVERRIDES.get(`${override.heroFrontageId}:${override.role}`)?.id === override.id
        && override.logicalKind === 'planter'
        && HERO_FRONTAGE_PRESENTATION_OVERRIDES.get(`${override.heroFrontageId}:${override.role}`)?.presentationKind
          === override.presentationKind
        && override.groundPivoted
        && override.baseInstanceHidden
        && override.hiddenBaseComponents['planter-pots'] === 1
        && override.hiddenBaseComponents['planter-leaves'] === 1
        && override.hiddenBaseComponents['planter-flowers'] === 3
      ))
      && diagnostics.frontagePresentationTopologies.length === 2
      && diagnostics.frontagePresentationTopologies.some((topology) => (
        topology.kind === 'pay-station'
        && topology.meshName === 'sf-pay-stations'
        && topology.indexCount === 216
        && topology.triangleCount === 72
        && topology.vertexCount === 136
        && topology.instanceCapacity === 1
        && topology.visibleInstances === 1
      ))
      && diagnostics.frontagePresentationTopologies.some((topology) => (
        topology.kind === 'trash-can'
        && topology.meshName === 'sf-trash-cans'
        && topology.indexCount === 420
        && topology.triangleCount === 140
        && topology.instanceCapacity === 2
        && topology.visibleInstances === 2
      ))
      && diagnostics.donorSelection.finite
      && diagnostics.donorSelection.minimumHeroEdgeDistanceMeters >= HERO_SIDEWALK_DONOR_RADIUS
      && diagnostics.donorSelection.minimumCorridorDistanceMeters >= HERO_SIDEWALK_DONOR_RADIUS
      && diagnostics.additionalAsphaltIntrusions === 0
      && diagnostics.buildingOverlaps === 0
      && diagnostics.portalCorridorIntrusions === 0;
    return diagnostics.finite;
  }

  buildParkedCars(root, city) {
    const random = mulberry32(Number(city.meta.seedInt || 1) + 711);
    const spots = [];
    const bounds = city.meta.bounds;
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const maxCars = realMap ? 520 : 800;
    const roadLift = Number(city.meta.streetDesign?.roadLift ?? 0.5);
    const classes = new Set(['primary', 'secondary', 'tertiary', 'residential']);
    if (realMap) {
      for (const segment of city.segments || []) {
        if (spots.length >= maxCars) break;
        if (!classes.has(segment.highway)) continue;
        const a = segment.points[0];
        const b = segment.points[segment.points.length - 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 24 || length > 420) continue;
        const nx = -dz / length;
        const nz = dx / length;
        const heading = Math.atan2(dx, dz);
        const count = Math.min(12, Math.max(3, Math.round(length / 18)));
        for (let i = 0; i < count; i += 1) {
          if (spots.length >= maxCars) break;
          if (random() < 0.06) continue;
          const t = (i + 0.5) / count;
          const side = i % 2 === 0 ? 1 : -1;
          // Park inside the striped stall lane, not on the sidewalk.
          const offset = segment.width / 2 - 1.3;
          spots.push({
            x: a.x + dx * t + nx * offset * side,
            z: a.z + dz * t + nz * offset * side,
            heading,
          });
        }
      }
    } else {
      for (const street of city.streets) {
        if (spots.length >= maxCars) break;
        if (!classes.has(street.highway)) continue;
        const axis = street.axis;
        const position = street.position;
        const sidewalk = street.sidewalkW + street.asphaltWidth / 2 + 1.4;
        const start = bounds[axis === 'x' ? 'minZ' : 'minX'] + 24;
        const end = bounds[axis === 'x' ? 'maxZ' : 'maxX'] - 24;
        for (let v = start; v < end; v += 15 + random() * 9) {
          if (spots.length >= maxCars) break;
          if (random() < 0.18) continue;
          const side = random() < 0.5 ? -1 : 1;
          const x = axis === 'x' ? position + side * sidewalk : v;
          const z = axis === 'z' ? position + side * sidewalk : v;
          if (Math.abs(x) > bounds.maxX - 6 || Math.abs(z) > bounds.maxZ - 6) continue;
          spots.push({ x, z, heading: axis === 'x' ? (side > 0 ? 0 : Math.PI) : (side > 0 ? Math.PI / 2 : -Math.PI / 2) });
          if (spots.length >= maxCars) break;
        }
        if (spots.length >= maxCars) break;
      }
    }
    if (!spots.length) return;
    this.streetFurniture.cars = spots.length;
    const sourceSnapshotBefore = JSON.stringify(spots.map(({ x, z, heading }) => ({ x, z, heading })));
    const partitionSf = realMap && isSanFranciscoCity(city);
    const bodyGeometry = createParkedCarHullGeometry({ compositeBody: true });
    const cabGeometry = createParkedCarHullGeometry({ segmentedCab: true });
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.46,
      metalness: 0.34,
      emissive: 0x000000,
      emissiveIntensity: 0,
      flatShading: true,
      vertexColors: true,
    });
    const cabMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.18,
      metalness: 0.42,
      flatShading: true,
      vertexColors: true,
    });
    const bodies = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, spots.length);
    const cabs = new THREE.InstancedMesh(cabGeometry, cabMaterial, spots.length);
    bodies.name = partitionSf ? 'sf-partitioned-parked-car-bodies' : 'parked-car-bodies';
    cabs.name = partitionSf ? 'sf-partitioned-parked-car-cabs' : 'parked-car-cabs';
    bodies.userData.worldPartitionPass = partitionSf ? PARKED_CAR_PARTITION_PASS : null;
    cabs.userData.worldPartitionPass = partitionSf ? PARKED_CAR_PARTITION_PASS : null;
    const bodyMatrix = new THREE.Matrix4();
    const cabMatrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const bodyScale = new THREE.Vector3(1.8, 0.58, 3.9);
    const cabScale = new THREE.Vector3(1.5, 0.5, 1.7);
    const bodyPosition = new THREE.Vector3();
    const cabPosition = new THREE.Vector3();
    const cabOffset = new THREE.Vector3();
    const bodyColor = new THREE.Color();
    const cabColor = new THREE.Color();
    const records = [];
    const cellMap = new Map();
    for (let i = 0; i < spots.length; i += 1) {
      const spot = spots[i];
      const roadY = (this.terrain?.heightAt ? this.terrain.heightAt(spot.x, spot.z) : 0) + roadLift;
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.heading);
      bodyPosition.set(spot.x, roadY + 0.32, spot.z);
      cabOffset.set(0, 0, -0.18).applyQuaternion(quaternion);
      cabPosition.set(spot.x + cabOffset.x, roadY + 0.78, spot.z + cabOffset.z);
      bodyMatrix.compose(bodyPosition, quaternion, bodyScale);
      cabMatrix.compose(cabPosition, quaternion, cabScale);
      bodyColor.set(PARKED_CAR_PALETTE[Math.floor(random() * PARKED_CAR_PALETTE.length)]);
      cabColor.set(PARKED_CAR_GLASS_PALETTE[Math.floor(random() * PARKED_CAR_GLASS_PALETTE.length)]);
      bodies.setMatrixAt(i, bodyMatrix);
      cabs.setMatrixAt(i, cabMatrix);
      bodies.setColorAt(i, bodyColor);
      cabs.setColorAt(i, cabColor);
      const cellX = Math.floor(spot.x / PARKED_CAR_PARTITION_CELL_SIZE);
      const cellZ = Math.floor(spot.z / PARKED_CAR_PARTITION_CELL_SIZE);
      const cellId = `${cellX}:${cellZ}`;
      records.push({
        index: i,
        x: spot.x,
        z: spot.z,
        heading: spot.heading,
        cellId,
        // Presentation contact truth is source-derived and intentionally excluded
        // from serializeParkedCarPartitionRecords so the established checksum stays stable.
        roadY,
        bodyMatrix: new Float32Array(bodyMatrix.elements),
        bodyColor: new Float32Array([bodyColor.r, bodyColor.g, bodyColor.b]),
        cabMatrix: new Float32Array(cabMatrix.elements),
        cabColor: new Float32Array([cabColor.r, cabColor.g, cabColor.b]),
      });
      let cell = cellMap.get(cellId);
      if (!cell) {
        cell = {
          id: cellId,
          x: (cellX + 0.5) * PARKED_CAR_PARTITION_CELL_SIZE,
          z: (cellZ + 0.5) * PARKED_CAR_PARTITION_CELL_SIZE,
          indices: [],
        };
        cellMap.set(cellId, cell);
      }
      cell.indices.push(i);
    }
    bodies.instanceMatrix.needsUpdate = true;
    cabs.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (cabs.instanceColor) cabs.instanceColor.needsUpdate = true;
    bodies.castShadow = true;
    bodies.receiveShadow = true;
    cabs.castShadow = true;
    cabs.receiveShadow = true;
    root.add(bodies, cabs);
    this.geometryCache.push(bodyGeometry, cabGeometry);
    if (!partitionSf) return;
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cabs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodies.instanceColor.setUsage(THREE.DynamicDrawUsage);
    cabs.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const recordsSnapshot = serializeParkedCarPartitionRecords(records);
    const sourceSnapshotAfter = JSON.stringify(spots.map(({ x, z, heading }) => ({ x, z, heading })));
    this.parkedCarPartitionRuntime = {
      root,
      bodies,
      cabs,
      records,
      cells: [...cellMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
      activeCellIds: new Set(),
      activeMask: new Uint8Array(records.length),
      frame: 0,
      sourceGenerator: city.meta.generator,
      goldenMode: city.meta.generator === 'sf-builtin',
      roadLiftMeters: roadLift,
      sourceInputChecksumBefore: hashString(sourceSnapshotBefore),
      sourceInputChecksumAfter: hashString(sourceSnapshotAfter),
      sourceInputUnchanged: sourceSnapshotBefore === sourceSnapshotAfter,
      recordsChecksum: hashString(recordsSnapshot),
      recordsFinite: records.every((record) => Number.isFinite(record.roadY)
        && [
          ...record.bodyMatrix,
          ...record.bodyColor,
          ...record.cabMatrix,
          ...record.cabColor,
        ].every(Number.isFinite)),
      bodyTrianglesPerSpot: (bodyGeometry.index?.count
        ?? bodyGeometry.getAttribute('position').count) / 3,
      cabTrianglesPerSpot: (cabGeometry.index?.count
        ?? cabGeometry.getAttribute('position').count) / 3,
      bodyHull: { ...bodyGeometry.userData.parkedCarHull },
      cabHull: { ...cabGeometry.userData.parkedCarHull },
      boundsCenter: new THREE.Vector3(),
    };
    this.updateParkedCarPartition(true, true);
  }

  updateParkedCarPartition(force = false, resetHysteresis = false, forceAll = false) {
    const runtime = this.parkedCarPartitionRuntime;
    if (!runtime?.bodies || !runtime?.cabs) return false;
    runtime.frame += 1;
    if (!force && runtime.frame % PARKED_CAR_PARTITION_UPDATE_INTERVAL !== 0) return false;
    if (resetHysteresis) runtime.activeCellIds.clear();
    const focus = this.controls.target;
    const aerial = forceAll
      || Math.abs(this.camera.position.y - focus.y) >= PARKED_CAR_PARTITION_AERIAL_HEIGHT;
    const nextActiveCellIds = new Set();
    runtime.activeMask.fill(0);
    let enters = 0;
    let exits = 0;
    for (const cell of runtime.cells) {
      const wasActive = runtime.activeCellIds.has(cell.id);
      const radius = wasActive ? PARKED_CAR_PARTITION_EXIT_RADIUS : PARKED_CAR_PARTITION_ENTER_RADIUS;
      const edgeX = Math.max(0, Math.abs(cell.x - focus.x) - PARKED_CAR_PARTITION_CELL_SIZE * 0.5);
      const edgeZ = Math.max(0, Math.abs(cell.z - focus.z) - PARKED_CAR_PARTITION_CELL_SIZE * 0.5);
      const active = aerial || Math.hypot(edgeX, edgeZ) <= radius;
      if (!active) {
        if (wasActive) exits += 1;
        continue;
      }
      if (!wasActive) enters += 1;
      nextActiveCellIds.add(cell.id);
      for (const index of cell.indices) runtime.activeMask[index] = 1;
    }
    let membershipChanged = nextActiveCellIds.size !== runtime.activeCellIds.size;
    if (!membershipChanged) {
      for (const cellId of nextActiveCellIds) {
        if (!runtime.activeCellIds.has(cellId)) {
          membershipChanged = true;
          break;
        }
      }
    }
    if (!force && !resetHysteresis && !membershipChanged) return false;
    const activeIndices = [];
    for (let index = 0; index < runtime.activeMask.length; index += 1) {
      if (runtime.activeMask[index]) activeIndices.push(index);
    }
    const bodyMatrixArray = runtime.bodies.instanceMatrix.array;
    const bodyColorArray = runtime.bodies.instanceColor.array;
    const cabMatrixArray = runtime.cabs.instanceMatrix.array;
    const cabColorArray = runtime.cabs.instanceColor.array;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let targetIndex = 0; targetIndex < activeIndices.length; targetIndex += 1) {
      const record = runtime.records[activeIndices[targetIndex]];
      bodyMatrixArray.set(record.bodyMatrix, targetIndex * 16);
      bodyColorArray.set(record.bodyColor, targetIndex * 3);
      cabMatrixArray.set(record.cabMatrix, targetIndex * 16);
      cabColorArray.set(record.cabColor, targetIndex * 3);
      for (const matrix of [record.bodyMatrix, record.cabMatrix]) {
        const x = matrix[12];
        const y = matrix[13];
        const z = matrix[14];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    for (const mesh of [runtime.bodies, runtime.cabs]) {
      mesh.count = activeIndices.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (!mesh.boundingSphere) mesh.boundingSphere = new THREE.Sphere();
      if (activeIndices.length) {
        runtime.boundsCenter.set(
          (minX + maxX) * 0.5,
          (minY + maxY) * 0.5,
          (minZ + maxZ) * 0.5,
        );
        const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 + 2.2;
        mesh.boundingSphere.set(runtime.boundsCenter, radius);
      } else {
        mesh.boundingSphere.set(this.controls.target, 0);
      }
    }
    runtime.activeCellIds = nextActiveCellIds;

    const previous = this.parkedCarPartitionDiagnostics;
    const bodyTriangles = runtime.bodyTrianglesPerSpot;
    const cabTriangles = runtime.cabTrianglesPerSpot;
    const trianglesPerSpot = bodyTriangles + cabTriangles;
    const wheelContact = runtime.bodyHull.wheels.contact;
    const contactClearances = runtime.records.map((record) => {
      const bodyCenterY = record.bodyMatrix[13];
      const bodyScaleY = record.bodyMatrix[5];
      return bodyCenterY + wheelContact.normalizedLowestY * bodyScaleY - record.roadY;
    });
    const sourceRoadYs = runtime.records.map((record) => record.roadY);
    const minContactClearance = Math.min(...contactClearances);
    const maxContactClearance = Math.max(...contactClearances);
    const maxAbsContactClearance = Math.max(...contactClearances.map(Math.abs));
    const contactFinite = contactClearances.length === runtime.records.length
      && contactClearances.every(Number.isFinite);
    const sourceRoadYFinite = sourceRoadYs.length === runtime.records.length
      && sourceRoadYs.every(Number.isFinite);
    const contactDiagnostics = {
      ...wheelContact,
      roadYSource: 'terrain.heightAt+roadLift',
      roadLiftMeters: runtime.roadLiftMeters,
      roadYExcludedFromRecordsChecksum: true,
      sourceSpotsChecked: contactClearances.length,
      sourceRoadYFinite,
      minSourceRoadYMeters: Math.min(...sourceRoadYs),
      maxSourceRoadYMeters: Math.max(...sourceRoadYs),
      finite: contactFinite && sourceRoadYFinite,
      minClearanceMeters: minContactClearance,
      maxClearanceMeters: maxContactClearance,
      maxAbsClearanceMeters: maxAbsContactClearance,
      allOnRoadPlane: contactFinite && sourceRoadYFinite
        && maxAbsContactClearance <= wheelContact.toleranceMeters,
    };
    const recordsUnchanged = force || resetHysteresis
      ? hashString(serializeParkedCarPartitionRecords(runtime.records)) === runtime.recordsChecksum
      : previous.source.recordsUnchanged === true;
    const diagnostics = createParkedCarPartitionDiagnostics();
    diagnostics.enabled = true;
    diagnostics.sourceGenerator = runtime.sourceGenerator;
    diagnostics.validationMode = runtime.goldenMode ? 'sf-builtin-golden' : 'live-osm-structural';
    diagnostics.expectedGolden = {
      enabled: runtime.goldenMode,
      spots: runtime.goldenMode ? 520 : null,
      cells: runtime.goldenMode ? 93 : null,
    };
    diagnostics.source = {
      spots: runtime.records.length,
      cells: runtime.cells.length,
      bodyTrianglesPerSpot: bodyTriangles,
      cabTrianglesPerSpot: cabTriangles,
      trianglesPerSpot,
      totalTriangles: runtime.records.length * trianglesPerSpot,
      recordsChecksum: runtime.recordsChecksum,
      recordsUnchanged,
      inputChecksumBefore: runtime.sourceInputChecksumBefore,
      inputChecksumAfter: runtime.sourceInputChecksumAfter,
      unchanged: runtime.sourceInputUnchanged,
      roadYSource: 'terrain.heightAt+roadLift',
      roadLiftMeters: runtime.roadLiftMeters,
      roadYExcludedFromRecordsChecksum: true,
    };
    diagnostics.cells = {
      total: runtime.cells.length,
      active: nextActiveCellIds.size,
      ids: [...nextActiveCellIds].sort(),
    };
    diagnostics.active = {
      spots: activeIndices.length,
      hiddenSpots: runtime.records.length - activeIndices.length,
      indices: activeIndices,
      aerial,
      forceAll,
    };
    diagnostics.batches = {
      bodies: {
        name: runtime.bodies.name,
        capacity: runtime.records.length,
        count: runtime.bodies.count,
        submittedTriangles: runtime.bodies.count * bodyTriangles,
        matricesFinite: runtime.recordsFinite,
        colorsFinite: runtime.recordsFinite,
      },
      cabs: {
        name: runtime.cabs.name,
        capacity: runtime.records.length,
        count: runtime.cabs.count,
        submittedTriangles: runtime.cabs.count * cabTriangles,
        matricesFinite: runtime.recordsFinite,
        colorsFinite: runtime.recordsFinite,
      },
    };
    diagnostics.topology = {
      body: {
        vertexCount: runtime.bodyHull.vertexCount,
        indexCount: 0,
        triangleCount: runtime.bodyHull.triangleCount,
        indexed: runtime.bodyHull.indexed,
        finiteTriangleAreas: runtime.bodyHull.finiteTriangleAreas,
        minTriangleArea: runtime.bodyHull.minTriangleArea,
        minOutwardNormalDot: runtime.bodyHull.minOutwardNormalDot,
        vertexColors: runtime.bodyHull.vertexColors,
        roles: { ...runtime.bodyHull.roles },
        triangleRanges: Object.fromEntries(Object.entries(runtime.bodyHull.triangleRanges || {}).map(
          ([role, range]) => [role, { ...range }],
        )),
        vertexRanges: Object.fromEntries(Object.entries(runtime.bodyHull.vertexRanges || {}).map(
          ([role, range]) => [role, { ...range }],
        )),
        wheels: {
          ...runtime.bodyHull.wheels,
          colors: {
            ...runtime.bodyHull.wheels.colors,
            rawGeometryTones: Object.fromEntries(Object.entries(
              runtime.bodyHull.wheels.colors.rawGeometryTones,
            ).map(([role, tone]) => [role, [...tone]])),
            effectivePaletteProducts: runtime.bodyHull.wheels.colors.effectivePaletteProducts.map(
              (entry) => ({
                ...entry,
                instancePaintLinear: [...entry.instancePaintLinear],
                hubHighlight: [...entry.hubHighlight],
                tread: [...entry.tread],
              }),
            ),
            productBounds: [...runtime.bodyHull.wheels.colors.productBounds],
          },
          contact: contactDiagnostics,
        },
      },
      cab: {
        vertexCount: runtime.cabHull.vertexCount,
        indexCount: 0,
        triangleCount: runtime.cabHull.triangleCount,
        indexed: runtime.cabHull.indexed,
        finiteTriangleAreas: runtime.cabHull.finiteTriangleAreas,
        minTriangleArea: runtime.cabHull.minTriangleArea,
        minOutwardNormalDot: runtime.cabHull.minOutwardNormalDot,
        vertexColors: runtime.cabHull.vertexColors,
        roles: { ...runtime.cabHull.roles },
        surfaceTones: Object.fromEntries(Object.entries(runtime.cabHull.surfaceTones || {}).map(
          ([role, tone]) => [role, [...tone]],
        )),
      },
      cabVerticalOffsetMeters: 0.46,
      cabLongitudinalOffsetMeters: -0.18,
      distinctBodyCabMatrices: true,
    };
    diagnostics.visual.cabSurfaceTones = Object.fromEntries(Object.entries(runtime.cabHull.surfaceTones || {}).map(
      ([role, tone]) => [role, [...tone]],
    ));
    diagnostics.visual.cabUniqueToneCount = new Set(
      Object.values(diagnostics.visual.cabSurfaceTones).map((tone) => tone.join(',')),
    ).size;
    diagnostics.visual.wheelCount = runtime.bodyHull.wheels.count;
    diagnostics.visual.wheelFacesPerWheel = runtime.bodyHull.wheels.facesPerWheel;
    diagnostics.visual.wheelSegmentsPerFace = runtime.bodyHull.wheels.segmentsPerFace;
    diagnostics.visual.wheelTreadSegmentsPerWheel = runtime.bodyHull.wheels.treadSegmentsPerWheel;
    diagnostics.visual.wheelTreadTrianglesPerWheel = runtime.bodyHull.wheels.treadTrianglesPerWheel;
    diagnostics.visual.wheelTreadTriangleCount = runtime.bodyHull.wheels.treadTriangleCount;
    diagnostics.visual.wheelTotalTriangleCount = runtime.bodyHull.wheels.totalTriangleCount;
    diagnostics.visual.wheelRadiusMeters = Number(
      (runtime.bodyHull.wheels.normalizedRadiusY * 0.58).toFixed(6),
    );
    diagnostics.visual.wheelContactClearanceMeters = Number(
      contactDiagnostics.maxAbsClearanceMeters.toFixed(6),
    ) || 0;
    diagnostics.visual.wheelLateralProtrusionMeters = Number(
      ((runtime.bodyHull.wheels.normalizedOuterX - 0.5) * 1.8).toFixed(6),
    );
    diagnostics.visual.wheelThicknessMeters = Number(
      ((runtime.bodyHull.wheels.normalizedOuterX - runtime.bodyHull.wheels.normalizedInnerX) * 1.8)
        .toFixed(6),
    );
    diagnostics.visual.wheelAxleOffsetMeters = Number((0.32 * 3.9).toFixed(6));
    diagnostics.visual.wheelPaintModulatedHubHighlight =
      runtime.bodyHull.wheels.outerFacePaintModulatedHubHighlight;
    diagnostics.visual.wheelEmissive = runtime.bodyHull.wheels.colors.emissive;
    diagnostics.submittedTriangles = activeIndices.length * trianglesPerSpot;
    diagnostics.hysteresis = {
      enters: previous.hysteresis.enters + enters,
      exits: previous.hysteresis.exits + exits,
    };
    diagnostics.updates = {
      checks: previous.updates.checks + 1,
      compactions: previous.updates.compactions + 1,
      resets: previous.updates.resets + (resetHysteresis ? 1 : 0),
    };
    diagnostics.lifecycle = {
      registrations: previous.lifecycle.registrations || 1,
      disposals: previous.lifecycle.disposals,
    };
    diagnostics.resources = { drawGroups: 2, geometries: 2, materials: 2, textures: 0 };
    const sourceCountContract = runtime.goldenMode
      ? diagnostics.source.spots === 520 && diagnostics.source.cells === 93
      : diagnostics.source.spots > 0
        && diagnostics.source.spots <= 520
        && diagnostics.source.cells > 0
        && diagnostics.source.cells <= diagnostics.source.spots;
    const wheelColorDiagnostics = diagnostics.topology.body.wheels.colors;
    const rawWheelTones = wheelColorDiagnostics.rawGeometryTones;
    const effectiveColorProductsContract =
      wheelColorDiagnostics.composition === 'raw-geometry-tone-times-instance-paint-linear'
      && wheelColorDiagnostics.vertexColorSpace === 'linear-srgb'
      && wheelColorDiagnostics.emissive === false
      && wheelColorDiagnostics.productsFinite
      && wheelColorDiagnostics.productsBounded
      && wheelColorDiagnostics.productBounds[0] === 0
      && wheelColorDiagnostics.productBounds[1] === 1
      && wheelColorDiagnostics.effectivePaletteProducts.length === PARKED_CAR_PALETTE.length
      && wheelColorDiagnostics.effectivePaletteProducts.every((entry, paletteIndex) => (
        entry.paletteIndex === paletteIndex
        && entry.paintHex === PARKED_CAR_PALETTE[paletteIndex]
        && entry.finite
        && entry.bounded
        && [
          ...entry.instancePaintLinear,
          ...entry.hubHighlight,
          ...entry.tread,
        ].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)
        && entry.hubHighlight.every((channel, index) => Math.abs(
          channel - rawWheelTones.paintModulatedHubHighlight[index]
            * entry.instancePaintLinear[index]
        ) < 1e-12)
        && entry.tread.every((channel, index) => Math.abs(
          channel - rawWheelTones.tread[index] * entry.instancePaintLinear[index]
        ) < 1e-12)
      ));
    diagnostics.failure = sourceCountContract
      && diagnostics.source.unchanged
      && diagnostics.source.recordsUnchanged
      && diagnostics.source.roadYSource === 'terrain.heightAt+roadLift'
      && diagnostics.source.roadLiftMeters === runtime.roadLiftMeters
      && diagnostics.source.roadYExcludedFromRecordsChecksum
      && diagnostics.source.totalTriangles
        === diagnostics.source.spots * diagnostics.source.trianglesPerSpot
      && diagnostics.source.bodyTrianglesPerSpot === 156
      && diagnostics.source.cabTrianglesPerSpot === 20
      && diagnostics.source.trianglesPerSpot === 176
      && diagnostics.source.trianglesPerSpot <= 176
      && diagnostics.topology.body.finiteTriangleAreas
      && diagnostics.topology.cab.finiteTriangleAreas
      && diagnostics.topology.body.minOutwardNormalDot > 0
      && diagnostics.topology.cab.minOutwardNormalDot > 0
      && diagnostics.topology.body.vertexColors
      && diagnostics.topology.body.roles.paintHull === 20
      && diagnostics.topology.body.roles.wheelSideDiscs === 64
      && diagnostics.topology.body.roles.wheelTreads === 64
      && diagnostics.topology.body.roles.lamps === 8
      && diagnostics.topology.body.triangleRanges.paintHull.start === 0
      && diagnostics.topology.body.triangleRanges.paintHull.count === 20
      && diagnostics.topology.body.triangleRanges.wheelSideDiscs.start === 20
      && diagnostics.topology.body.triangleRanges.wheelSideDiscs.count === 64
      && diagnostics.topology.body.triangleRanges.wheelTreads.start === 84
      && diagnostics.topology.body.triangleRanges.wheelTreads.count === 64
      && diagnostics.topology.body.triangleRanges.lamps.start === 148
      && diagnostics.topology.body.triangleRanges.lamps.count === 8
      && diagnostics.topology.body.vertexRanges.paintHull.start === 0
      && diagnostics.topology.body.vertexRanges.paintHull.count === 60
      && diagnostics.topology.body.vertexRanges.wheelSideDiscs.start === 60
      && diagnostics.topology.body.vertexRanges.wheelSideDiscs.count === 192
      && diagnostics.topology.body.vertexRanges.wheelTreads.start === 252
      && diagnostics.topology.body.vertexRanges.wheelTreads.count === 192
      && diagnostics.topology.body.vertexRanges.lamps.start === 444
      && diagnostics.topology.body.vertexRanges.lamps.count === 24
      && diagnostics.topology.body.wheels.count === 4
      && diagnostics.topology.body.wheels.facesPerWheel === 2
      && diagnostics.topology.body.wheels.segmentsPerFace === 8
      && diagnostics.topology.body.wheels.triangleCount === 64
      && diagnostics.topology.body.wheels.treadSegmentsPerWheel === 8
      && diagnostics.topology.body.wheels.treadTrianglesPerWheel === 16
      && diagnostics.topology.body.wheels.treadTriangleCount === 64
      && diagnostics.topology.body.wheels.totalTriangleCount === 128
      && diagnostics.topology.body.wheels.minOutwardNormalDot > 0
      && diagnostics.topology.body.wheels.minTreadOutwardNormalDot > 0
      && diagnostics.topology.body.wheels.outerFacePaintModulatedHubHighlight
      && effectiveColorProductsContract
      && diagnostics.topology.body.wheels.contact.sourceSpotsChecked === diagnostics.source.spots
      && diagnostics.topology.body.wheels.contact.roadYSource === 'terrain.heightAt+roadLift'
      && diagnostics.topology.body.wheels.contact.roadLiftMeters === runtime.roadLiftMeters
      && diagnostics.topology.body.wheels.contact.roadYExcludedFromRecordsChecksum
      && diagnostics.topology.body.wheels.contact.sourceRoadYFinite
      && diagnostics.topology.body.wheels.contact.finite
      && diagnostics.topology.body.wheels.contact.allOnRoadPlane
      && diagnostics.topology.body.wheels.contact.maxAbsClearanceMeters <= 0.000001
      && diagnostics.topology.cab.vertexColors
      && diagnostics.topology.cab.roles.sideWindows === 8
      && diagnostics.topology.cab.roles.rearWindow === 2
      && diagnostics.topology.cab.roles.roof === 2
      && diagnostics.topology.cab.roles.windshield === 2
      && diagnostics.topology.cab.roles.lowerSills === 6
      && diagnostics.visual.pass === PARKED_CAR_DETAIL_PASS
      && diagnostics.visual.wheelCount === 4
      && diagnostics.visual.wheelFacesPerWheel === 2
      && diagnostics.visual.wheelSegmentsPerFace === 8
      && diagnostics.visual.wheelTreadSegmentsPerWheel === 8
      && diagnostics.visual.wheelTreadTrianglesPerWheel === 16
      && diagnostics.visual.wheelTreadTriangleCount === 64
      && diagnostics.visual.wheelTotalTriangleCount === 128
      && Math.abs(diagnostics.visual.wheelRadiusMeters - 0.26) < 1e-9
      && Math.abs(diagnostics.visual.wheelContactClearanceMeters) < 1e-9
      && diagnostics.visual.wheelLateralProtrusionMeters >= 0.09 - 1e-9
      && Math.abs(diagnostics.visual.wheelThicknessMeters - 0.144) < 1e-9
      && diagnostics.visual.wheelPaintModulatedHubHighlight
      && diagnostics.visual.wheelEmissive === false
      && diagnostics.visual.cabUniqueToneCount === 5
      && runtime.bodies.material.vertexColors === true
      && runtime.bodies.material.emissive.getHex() === 0
      && runtime.bodies.material.emissiveIntensity === 0
      && runtime.cabs.material.vertexColors === true
      && diagnostics.cells.total === diagnostics.source.cells
      && diagnostics.active.spots + diagnostics.active.hiddenSpots === diagnostics.source.spots
      && diagnostics.active.indices.length === diagnostics.active.spots
      && diagnostics.active.indices.every((index) => Number.isInteger(index)
        && index >= 0 && index < diagnostics.source.spots)
      && diagnostics.batches.bodies.capacity === diagnostics.source.spots
      && diagnostics.batches.cabs.capacity === diagnostics.source.spots
      && diagnostics.batches.bodies.count === diagnostics.batches.cabs.count
      && diagnostics.batches.bodies.count === diagnostics.active.spots
      && diagnostics.batches.bodies.count <= diagnostics.batches.bodies.capacity
      && diagnostics.batches.bodies.matricesFinite
      && diagnostics.batches.bodies.colorsFinite
      && diagnostics.batches.cabs.matricesFinite
      && diagnostics.batches.cabs.colorsFinite
      && runtime.bodies.parent === runtime.root
      && runtime.cabs.parent === runtime.root
      ? null
      : 'sf-world-partition-parked-cars-contract';
    this.parkedCarPartitionDiagnostics = diagnostics;
    return true;
  }

  buildShopAwnings(root, city) {
    const random = mulberry32(Number(city.meta.seedInt || 1) + 401);
    const realMap = city.meta.generator === 'sf-builtin' || city.meta.generator === 'openstreetmap';
    const partitionSf = realMap && isSanFranciscoCity(city);
    const snapshotPartitionSource = partitionSf
      ? () => JSON.stringify({
        meta: city.meta,
        buildings: city.buildings,
        streets: city.streets,
        segments: city.segments,
      })
      : null;
    const sourceInputChecksumBefore = snapshotPartitionSource
      ? hashString(snapshotPartitionSource())
      : null;
    const awningColors = ['#e04945', '#128f9e', '#e5a021', '#3d8f52', '#8a5fc0', '#d95f5f', '#3f8f9e'];
    const materials = [];
    const neonSigns = [];
    const neonPanels = [];
    const bistroLights = [];
    const group = new THREE.Group();
    group.name = 'shopfront-awnings';
    let count = 0;
    const maxAwnings = realMap ? 320 : 140;
    let lastAwning = null;
    for (const building of city.buildings) {
      if (building.type !== 'shop' && building.facade !== 'shopfront') continue;
      const points = building.polygon;
      if (!points || points.length < 4) continue;
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minZ = Math.min(...points.map((p) => p.z));
      const maxZ = Math.max(...points.map((p) => p.z));
      if (maxX - minX < 6 || maxZ - minZ < 6) continue;
      let face = 'z';
      let side = 1;
      if (realMap && !building.facingStreet) {
        const near = this.nearestRoadSegment(city, { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 });
        if (near) {
          const a = near.points[0];
          const b = near.points[near.points.length - 1];
          const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
          if (horizontal) {
            face = 'z';
            side = a.z > (minZ + maxZ) / 2 ? 1 : -1;
          } else {
            face = 'x';
            side = a.x > (minX + maxX) / 2 ? 1 : -1;
          }
        }
      } else if (building.facingStreet) {
        const street = city.streets.find((s) => s.name === building.facingStreet);
        if (street?.axis === 'x') {
          face = 'x';
          side = Math.abs(minX - street.position) < Math.abs(maxX - street.position) ? -1 : 1;
        } else if (street?.axis === 'z') {
          face = 'z';
          side = Math.abs(minZ - street.position) < Math.abs(maxZ - street.position) ? -1 : 1;
        }
      }
      const colorHex = awningColors[Math.floor(random() * awningColors.length)];
      const material = new THREE.MeshStandardMaterial({
        color: colorHex,
        roughness: 0.7,
        metalness: 0.05,
        flatShading: true,
        emissive: colorHex,
        emissiveIntensity: 0,
      });
      materials.push(material);
      const length = Math.min(12, Math.max(4, face === 'x' ? maxZ - minZ : maxX - minX));
      const awning = new THREE.Mesh(new THREE.BoxGeometry(length, 0.14, 1.25), material);
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const baseY = (this.terrain?.heightAt ? this.terrain.heightAt(cx, cz) : 0) + 2.7;
      if (face === 'x') {
        awning.rotation.y = Math.PI / 2;
        awning.position.set(side > 0 ? maxX + 1.15 : minX - 1.15, baseY, cz);
      } else {
        awning.position.set(cx, baseY, side > 0 ? maxZ + 1.15 : minZ - 1.15);
      }
      awning.castShadow = true;
      group.add(awning);
      lastAwning = awning;
      count += 1;
      if (neonSigns.length < 400) {
        const neonColors = ['#ff5fa2', '#35d7d7', '#ffc43d', '#8dff5f', '#c08fff', '#ff7a45'];
        const signLength = Math.min(9, Math.max(3, face === 'x' ? maxZ - minZ : maxX - minX) * 0.56);
        const signX = face === 'x'
          ? (side > 0 ? maxX + 0.42 : minX - 0.42)
          : cx;
        const signZ = face === 'x'
          ? cz
          : (side > 0 ? maxZ + 0.42 : minZ - 0.42);
        const rotationY = face === 'x' ? Math.PI / 2 : 0;
        neonSigns.push({
          x: signX,
          y: baseY + 1.05,
          z: signZ,
          rotationY,
          scaleX: signLength,
          color: neonColors[Math.floor(random() * neonColors.length)],
        });
      }
      if (neonPanels.length < 260) {
        const panelColors = ['#e5484d', '#12a594', '#ffb224', '#30a46c', '#8e4ec6', '#ff5c8a'];
        const panelLength = Math.min(14, Math.max(5, face === 'x' ? maxZ - minZ : maxX - minX) * 0.82);
        const panelX = face === 'x'
          ? (side > 0 ? maxX + 0.34 : minX - 0.34)
          : cx;
        const panelZ = face === 'x'
          ? cz
          : (side > 0 ? maxZ + 0.34 : minZ - 0.34);
        neonPanels.push({
          x: panelX,
          y: baseY - 0.9,
          z: panelZ,
          rotationY: face === 'x' ? Math.PI / 2 : 0,
          length: panelLength,
          color: panelColors[Math.floor(random() * panelColors.length)],
        });
      }
      if (bistroLights.length < 1500) {
        const lightColors = ['#ffd166', '#ff8fab', '#7bdff2', '#b8f2e6', '#ffa69e', '#fcf6bd'];
        const span = face === 'x' ? maxZ - minZ : maxX - minX;
        const lightCount = Math.min(18, Math.max(3, Math.round(span / 1.5)));
        const start = -Math.min(6, span / 2);
        for (let l = 0; l < lightCount; l += 1) {
          const offset = start + (span / Math.max(1, lightCount - 1)) * l;
          const x = face === 'x'
            ? (side > 0 ? maxX + 0.85 : minX - 0.85)
            : cx + offset;
          const z = face === 'x'
            ? cz + offset
            : (side > 0 ? maxZ + 0.85 : minZ - 0.85);
          bistroLights.push({
            x,
            y: baseY + 0.55,
            z,
            color: lightColors[Math.floor(random() * lightColors.length)],
          });
        }
      }
      if (count >= maxAwnings) break;
    }
    if (count) {
      root.add(group);
      this.streetFurniture.awnings = count;
      this.geometryCache.push(lastAwning.geometry);
      for (const material of materials) {
        this.nightEmissive.push({ material, texture: null, nightTexture: null });
      }
    }
    if (neonSigns.length) {
      const signGeometry = new THREE.BoxGeometry(1, 0.92, 0.14);
      const signMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
      const signs = new THREE.InstancedMesh(signGeometry, signMaterial, neonSigns.length);
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      for (let i = 0; i < neonSigns.length; i += 1) {
        const sign = neonSigns[i];
        dummy.position.set(sign.x, sign.y, sign.z);
        dummy.rotation.set(0, sign.rotationY, 0);
        dummy.scale.set(sign.scaleX, 1, 1);
        dummy.updateMatrix();
        signs.setMatrixAt(i, dummy.matrix);
        color.set(sign.color);
        signs.setColorAt(i, color);
      }
      signs.instanceMatrix.needsUpdate = true;
      if (signs.instanceColor) signs.instanceColor.needsUpdate = true;
      root.add(signs);
      this.geometryCache.push(signGeometry);
      const lightCount = Math.min(96, neonSigns.length);
      for (let i = 0; i < lightCount; i += 1) {
        const sign = neonSigns[i];
        this.localLightCandidates.push({
          x: sign.x,
          y: sign.y - 0.5,
          z: sign.z,
          color: sign.color,
          intensity: 2.8,
          distance: 20,
          decay: 1.7,
        });
      }
    }
    if (neonPanels.length) {
      const panelGeometry = new THREE.BoxGeometry(1, 2.8, 0.12);
      const panelMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.16,
        fog: false,
        depthWrite: false,
      });
      panelMaterial.userData = { dayOpacity: 0.16, nightOpacity: 1 };
      this.neonGlowMaterials.push(panelMaterial);
      const panels = new THREE.InstancedMesh(panelGeometry, panelMaterial, neonPanels.length);
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      for (let i = 0; i < neonPanels.length; i += 1) {
        const panel = neonPanels[i];
        dummy.position.set(panel.x, panel.y, panel.z);
        dummy.rotation.set(0, panel.rotationY, 0);
        dummy.scale.set(panel.length, 1, 1);
        dummy.updateMatrix();
        panels.setMatrixAt(i, dummy.matrix);
        color.set(panel.color);
        panels.setColorAt(i, color);
      }
      panels.instanceMatrix.needsUpdate = true;
      if (panels.instanceColor) panels.instanceColor.needsUpdate = true;
      root.add(panels);
      this.geometryCache.push(panelGeometry);
    }
    if (bistroLights.length) {
      const bistroGeometry = new THREE.SphereGeometry(0.06, 6, 5);
      const bistroMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.55,
        fog: false,
      });
      bistroMaterial.userData = { dayOpacity: 0.55, nightOpacity: 1 };
      this.neonGlowMaterials.push(bistroMaterial);
      const lights = new THREE.InstancedMesh(bistroGeometry, bistroMaterial, bistroLights.length);
      lights.name = partitionSf ? 'sf-partitioned-bistro-lights' : 'bistro-lights';
      lights.userData = partitionSf
        ? { kind: 'sf-partitioned-bistro-lights', partition: BISTRO_PARTITION_PASS }
        : { kind: 'bistro-lights' };
      if (partitionSf) lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      const records = [];
      const cellMap = new Map();
      const sourceSnapshot = JSON.stringify(bistroLights);
      for (let i = 0; i < bistroLights.length; i += 1) {
        const light = bistroLights[i];
        dummy.position.set(light.x, light.y, light.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        color.set(light.color);
        lights.setMatrixAt(i, dummy.matrix);
        lights.setColorAt(i, color);
        const cellX = Math.floor(light.x / BISTRO_PARTITION_CELL_SIZE);
        const cellZ = Math.floor(light.z / BISTRO_PARTITION_CELL_SIZE);
        const cellId = `${cellX}:${cellZ}`;
        const record = {
          index: i,
          cellId,
          matrix: new Float32Array(dummy.matrix.elements),
          color: new Float32Array([color.r, color.g, color.b]),
        };
        records.push(record);
        let cell = cellMap.get(cellId);
        if (!cell) {
          cell = {
            id: cellId,
            x: (cellX + 0.5) * BISTRO_PARTITION_CELL_SIZE,
            z: (cellZ + 0.5) * BISTRO_PARTITION_CELL_SIZE,
            indices: [],
          };
          cellMap.set(cellId, cell);
        }
        cell.indices.push(i);
      }
      root.add(lights);
      this.geometryCache.push(bistroGeometry);
      if (!partitionSf) {
        lights.instanceMatrix.needsUpdate = true;
        if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
        return;
      }
      lights.instanceColor.setUsage(THREE.DynamicDrawUsage);
      const trianglesPerInstance = (bistroGeometry.index?.count
        ?? bistroGeometry.getAttribute('position').count) / 3;
      const sourceChecksum = hashString(sourceSnapshot);
      this.worldPartitionRuntime = {
        mesh: lights,
        records,
        cells: [...cellMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
        activeCellIds: new Set(),
        activeMask: new Uint8Array(records.length),
        frame: 0,
        lastFocusCellX: null,
        lastFocusCellZ: null,
        lastAerial: null,
        boundsCenter: new THREE.Vector3(),
        sourceChecksum,
        recordsChecksumVerified: hashString(sourceSnapshot) === sourceChecksum,
        sourceInputChecksumBefore,
        sourceInputChecksumAfter: hashString(snapshotPartitionSource()),
        recordsFinite: records.every((record) => record.matrix.every(Number.isFinite)
          && record.color.every(Number.isFinite)),
        trianglesPerInstance,
      };
      this.updateWorldPartition(true);
    }
  }

  updateWorldPartition(force = false, resetHysteresis = false) {
    const runtime = this.worldPartitionRuntime;
    if (!runtime?.mesh) return false;
    runtime.frame += 1;
    if (!force && runtime.frame % BISTRO_PARTITION_UPDATE_INTERVAL !== 0) return false;
    if (resetHysteresis) {
      runtime.activeCellIds.clear();
      runtime.lastFocusCellX = null;
      runtime.lastFocusCellZ = null;
      runtime.lastAerial = null;
    }
    const focus = this.controls.target;
    const focusCellX = Math.floor(focus.x / BISTRO_PARTITION_CELL_SIZE);
    const focusCellZ = Math.floor(focus.z / BISTRO_PARTITION_CELL_SIZE);
    const aerial = Math.abs(this.camera.position.y - focus.y) >= BISTRO_PARTITION_AERIAL_HEIGHT;
    this.worldPartitionDiagnostics.updates.checks += 1;

    const nextActiveCellIds = new Set();
    const activeIndices = [];
    runtime.activeMask.fill(0);
    let enters = 0;
    let exits = 0;
    for (const cell of runtime.cells) {
      const wasActive = runtime.activeCellIds.has(cell.id);
      const radius = wasActive ? BISTRO_PARTITION_EXIT_RADIUS : BISTRO_PARTITION_ENTER_RADIUS;
      const edgeX = Math.max(0, Math.abs(cell.x - focus.x) - BISTRO_PARTITION_CELL_SIZE * 0.5);
      const edgeZ = Math.max(0, Math.abs(cell.z - focus.z) - BISTRO_PARTITION_CELL_SIZE * 0.5);
      const active = aerial || Math.hypot(edgeX, edgeZ) <= radius;
      if (!active) {
        if (wasActive) exits += 1;
        continue;
      }
      if (!wasActive) enters += 1;
      nextActiveCellIds.add(cell.id);
      for (const index of cell.indices) runtime.activeMask[index] = 1;
    }
    for (let index = 0; index < runtime.activeMask.length; index += 1) {
      if (runtime.activeMask[index]) activeIndices.push(index);
    }
    let membershipChanged = nextActiveCellIds.size !== runtime.activeCellIds.size;
    if (!membershipChanged) {
      for (const cellId of nextActiveCellIds) {
        if (!runtime.activeCellIds.has(cellId)) {
          membershipChanged = true;
          break;
        }
      }
    }
    if (!force && !resetHysteresis && !membershipChanged) {
      runtime.lastFocusCellX = focusCellX;
      runtime.lastFocusCellZ = focusCellZ;
      runtime.lastAerial = aerial;
      return false;
    }
    const matrixArray = runtime.mesh.instanceMatrix.array;
    const colorArray = runtime.mesh.instanceColor.array;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let targetIndex = 0; targetIndex < activeIndices.length; targetIndex += 1) {
      const record = runtime.records[activeIndices[targetIndex]];
      matrixArray.set(record.matrix, targetIndex * 16);
      colorArray.set(record.color, targetIndex * 3);
      const x = record.matrix[12];
      const y = record.matrix[13];
      const z = record.matrix[14];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    runtime.mesh.count = activeIndices.length;
    runtime.mesh.instanceMatrix.needsUpdate = true;
    if (runtime.mesh.instanceColor) runtime.mesh.instanceColor.needsUpdate = true;
    if (!runtime.mesh.boundingSphere) runtime.mesh.boundingSphere = new THREE.Sphere();
    if (activeIndices.length) {
      runtime.boundsCenter.set(
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5,
      );
      const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 + 0.06;
      runtime.mesh.boundingSphere.set(runtime.boundsCenter, radius);
    } else {
      runtime.mesh.boundingSphere.set(this.controls.target, 0);
    }
    runtime.activeCellIds = nextActiveCellIds;
    runtime.lastFocusCellX = focusCellX;
    runtime.lastFocusCellZ = focusCellZ;
    runtime.lastAerial = aerial;

    const diagnostics = createWorldPartitionDiagnostics();
    diagnostics.enabled = true;
    diagnostics.source = {
      instances: runtime.records.length,
      triangles: runtime.records.length * runtime.trianglesPerInstance,
      trianglesPerInstance: runtime.trianglesPerInstance,
      recordsChecksum: runtime.sourceChecksum,
      recordsUnchanged: runtime.recordsChecksumVerified,
      inputChecksumBefore: runtime.sourceInputChecksumBefore,
      inputChecksumAfter: runtime.sourceInputChecksumAfter,
      unchanged: runtime.sourceInputChecksumBefore === runtime.sourceInputChecksumAfter,
    };
    diagnostics.cells = {
      total: runtime.cells.length,
      active: nextActiveCellIds.size,
      ids: [...nextActiveCellIds].sort(),
    };
    diagnostics.active = {
      instances: activeIndices.length,
      hiddenInstances: runtime.records.length - activeIndices.length,
      indices: activeIndices,
      aerial,
    };
    diagnostics.hysteresis.enters = this.worldPartitionDiagnostics.hysteresis.enters + enters;
    diagnostics.hysteresis.exits = this.worldPartitionDiagnostics.hysteresis.exits + exits;
    diagnostics.mesh = {
      name: runtime.mesh.name,
      capacity: runtime.records.length,
      count: runtime.mesh.count,
      submittedTriangles: runtime.mesh.count * runtime.trianglesPerInstance,
      oneMesh: runtime.mesh.parent === this.root || runtime.mesh.parent?.name === 'city-root',
      matricesFinite: runtime.recordsFinite,
      colorsFinite: runtime.recordsFinite,
    };
    diagnostics.updates = {
      checks: this.worldPartitionDiagnostics.updates.checks,
      compactions: this.worldPartitionDiagnostics.updates.compactions + 1,
      resets: (this.worldPartitionDiagnostics.updates.resets || 0) + (resetHysteresis ? 1 : 0),
    };
    diagnostics.failure = diagnostics.source.instances > 0
      && diagnostics.source.unchanged
      && diagnostics.source.recordsUnchanged
      && diagnostics.mesh.oneMesh
      && diagnostics.mesh.matricesFinite
      && diagnostics.mesh.colorsFinite
      && diagnostics.mesh.count <= diagnostics.mesh.capacity
      ? null
      : 'sf-world-partition-bistro-contract';
    this.worldPartitionDiagnostics = diagnostics;
    return true;
  }

  registerPortalPartition({
    group,
    panels,
    frames,
    lights,
    storefrontGlass,
    storefrontTrim,
    records,
    sourceSnapshotBefore,
    sourceSnapshotAfter,
  }) {
    this.disposePortalPartitionRuntime();
    if (!group || !panels || !frames || !lights || !records?.length) return false;
    const cells = new Map();
    for (const record of records) {
      const cellX = Math.floor(record.x / PORTAL_PARTITION_CELL_SIZE);
      const cellZ = Math.floor(record.z / PORTAL_PARTITION_CELL_SIZE);
      const cellId = `${cellX}:${cellZ}`;
      record.cellId = cellId;
      let cell = cells.get(cellId);
      if (!cell) {
        cell = {
          id: cellId,
          x: (cellX + 0.5) * PORTAL_PARTITION_CELL_SIZE,
          z: (cellZ + 0.5) * PORTAL_PARTITION_CELL_SIZE,
          indices: [],
        };
        cells.set(cellId, cell);
      }
      cell.indices.push(record.index);
    }
    const recordsSnapshot = serializePortalPartitionRecords(records);
    for (const mesh of [panels, frames, lights]) {
      mesh.frustumCulled = true;
      mesh.userData.worldPartitionPass = PORTAL_PARTITION_PASS;
    }
    this.portalPartitionRuntime = {
      group,
      panels,
      frames,
      lights,
      storefrontGlass,
      storefrontTrim,
      records,
      cells: [...cells.values()].sort((left, right) => left.id.localeCompare(right.id)),
      activeCellIds: new Set(),
      activeMask: new Uint8Array(records.length),
      frame: 0,
      sourceInputChecksumBefore: hashString(sourceSnapshotBefore),
      sourceInputChecksumAfter: hashString(sourceSnapshotAfter),
      sourceInputUnchanged: sourceSnapshotBefore === sourceSnapshotAfter,
      recordsChecksum: hashString(recordsSnapshot),
      recordsFinite: records.every((record) => [
        ...record.panelMatrix,
        ...record.panelColor,
        ...record.frameMatrices.flatMap((matrix) => [...matrix]),
        ...record.frameColors.flatMap((color) => [...color]),
        ...record.lightMatrix,
      ].every(Number.isFinite)),
      boundsCenter: new THREE.Vector3(),
    };
    this.updatePortalPartition(true, true);
    return true;
  }

  updatePortalPartition(force = false, resetHysteresis = false, forceAll = false) {
    const runtime = this.portalPartitionRuntime;
    if (!runtime?.panels || !runtime?.frames || !runtime?.lights) return false;
    runtime.frame += 1;
    if (!force && runtime.frame % PORTAL_PARTITION_UPDATE_INTERVAL !== 0) return false;
    if (resetHysteresis) runtime.activeCellIds.clear();
    const focus = this.controls.target;
    const aerial = forceAll
      || Math.abs(this.camera.position.y - focus.y) >= PORTAL_PARTITION_AERIAL_HEIGHT;
    const nextActiveCellIds = new Set();
    runtime.activeMask.fill(0);
    let enters = 0;
    let exits = 0;
    for (const cell of runtime.cells) {
      const wasActive = runtime.activeCellIds.has(cell.id);
      const radius = wasActive ? PORTAL_PARTITION_EXIT_RADIUS : PORTAL_PARTITION_ENTER_RADIUS;
      const edgeX = Math.max(0, Math.abs(cell.x - focus.x) - PORTAL_PARTITION_CELL_SIZE * 0.5);
      const edgeZ = Math.max(0, Math.abs(cell.z - focus.z) - PORTAL_PARTITION_CELL_SIZE * 0.5);
      const active = aerial || Math.hypot(edgeX, edgeZ) <= radius;
      if (!active) {
        if (wasActive) exits += 1;
        continue;
      }
      if (!wasActive) enters += 1;
      nextActiveCellIds.add(cell.id);
      for (const index of cell.indices) runtime.activeMask[index] = 1;
    }
    for (const record of runtime.records) {
      if (record.pinned) runtime.activeMask[record.index] = 1;
    }
    let membershipChanged = nextActiveCellIds.size !== runtime.activeCellIds.size;
    if (!membershipChanged) {
      for (const cellId of nextActiveCellIds) {
        if (!runtime.activeCellIds.has(cellId)) {
          membershipChanged = true;
          break;
        }
      }
    }
    if (!force && !resetHysteresis && !membershipChanged) return false;
    const activeIndices = [];
    for (let index = 0; index < runtime.activeMask.length; index += 1) {
      if (runtime.activeMask[index]) activeIndices.push(index);
    }
    const panelMatrices = runtime.panels.instanceMatrix.array;
    const panelColors = runtime.panels.instanceColor.array;
    const frameMatrices = runtime.frames.instanceMatrix.array;
    const frameColors = runtime.frames.instanceColor.array;
    const lightMatrices = runtime.lights.instanceMatrix.array;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let targetIndex = 0; targetIndex < activeIndices.length; targetIndex += 1) {
      const record = runtime.records[activeIndices[targetIndex]];
      panelMatrices.set(record.panelMatrix, targetIndex * 16);
      panelColors.set(record.panelColor, targetIndex * 3);
      lightMatrices.set(record.lightMatrix, targetIndex * 16);
      for (let framePart = 0; framePart < 3; framePart += 1) {
        const frameTarget = targetIndex * 3 + framePart;
        frameMatrices.set(record.frameMatrices[framePart], frameTarget * 16);
        frameColors.set(record.frameColors[framePart], frameTarget * 3);
      }
      const x = record.panelMatrix[12];
      const y = record.panelMatrix[13];
      const z = record.panelMatrix[14];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
    runtime.panels.count = activeIndices.length;
    runtime.frames.count = activeIndices.length * 3;
    runtime.lights.count = activeIndices.length;
    for (const mesh of [runtime.panels, runtime.frames, runtime.lights]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (!mesh.boundingSphere) mesh.boundingSphere = new THREE.Sphere();
      if (activeIndices.length) {
        runtime.boundsCenter.set(
          (minX + maxX) * 0.5,
          (minY + maxY) * 0.5,
          (minZ + maxZ) * 0.5,
        );
        mesh.boundingSphere.set(
          runtime.boundsCenter,
          Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 + 4,
        );
      } else {
        mesh.boundingSphere.set(focus, 0);
      }
    }
    runtime.activeCellIds = nextActiveCellIds;
    const previous = this.portalPartitionDiagnostics;
    const recordsChecksumVerified = force
      ? hashString(serializePortalPartitionRecords(runtime.records)) === runtime.recordsChecksum
      : previous.source?.recordsUnchanged === true;
    const pinnedHeroIds = runtime.records
      .filter((record) => record.pinned)
      .map((record) => record.buildingId)
      .sort();
    const diagnostics = createPortalPartitionDiagnostics();
    diagnostics.enabled = true;
    diagnostics.source = {
      portals: runtime.records.length,
      cells: runtime.cells.length,
      genericTriangles: runtime.records.length * 60,
      trianglesPerPortal: 60,
      recordsChecksum: runtime.recordsChecksum,
      recordsUnchanged: recordsChecksumVerified,
      inputChecksumBefore: runtime.sourceInputChecksumBefore,
      inputChecksumAfter: runtime.sourceInputChecksumAfter,
      unchanged: runtime.sourceInputUnchanged
        && runtime.sourceInputChecksumBefore === runtime.sourceInputChecksumAfter,
    };
    diagnostics.cells = {
      total: runtime.cells.length,
      active: nextActiveCellIds.size,
      ids: [...nextActiveCellIds].sort(),
    };
    diagnostics.active = {
      portals: activeIndices.length,
      hiddenPortals: runtime.records.length - activeIndices.length,
      indices: activeIndices,
      pinnedHeroIds,
      aerial,
      forceAll,
    };
    diagnostics.batches = {
      panels: {
        name: runtime.panels.name,
        capacity: runtime.records.length,
        count: runtime.panels.count,
        submittedTriangles: runtime.panels.count * 12,
      },
      frames: {
        name: runtime.frames.name,
        capacity: runtime.records.length * 3,
        count: runtime.frames.count,
        submittedTriangles: runtime.frames.count * 12,
      },
      lights: {
        name: runtime.lights.name,
        capacity: runtime.records.length,
        count: runtime.lights.count,
        submittedTriangles: runtime.lights.count * 12,
      },
    };
    diagnostics.submittedTriangles = activeIndices.length * 60;
    diagnostics.hysteresis = {
      enters: (previous.hysteresis?.enters || 0) + enters,
      exits: (previous.hysteresis?.exits || 0) + exits,
    };
    diagnostics.updates = {
      checks: (previous.updates?.checks || 0) + 1,
      compactions: (previous.updates?.compactions || 0) + 1,
      resets: (previous.updates?.resets || 0) + (resetHysteresis ? 1 : 0),
    };
    diagnostics.lifecycle = {
      registrations: (previous.lifecycle?.registrations || 0) + (previous.enabled ? 0 : 1),
      disposals: previous.lifecycle?.disposals || 0,
    };
    const oneGroup = runtime.group.parent === this.root
      && [runtime.panels, runtime.frames, runtime.lights].every((mesh) => mesh.parent === runtime.group);
    diagnostics.failure = diagnostics.source.portals === 700
      && diagnostics.source.unchanged
      && diagnostics.source.recordsUnchanged
      && runtime.recordsFinite
      && pinnedHeroIds.length === HERO_FACADE_IDS.size
      && oneGroup
      && runtime.panels.count <= diagnostics.batches.panels.capacity
      && runtime.frames.count <= diagnostics.batches.frames.capacity
      && runtime.lights.count <= diagnostics.batches.lights.capacity
      ? null
      : 'sf-world-partition-portals-contract';
    this.portalPartitionDiagnostics = diagnostics;
    return true;
  }

  nearestRoadSegment(city, point) {
    let best = null;
    let bestDistance = Infinity;
    for (const segment of city.segments || []) {
      if (segment.highway === 'pedestrian' || segment.highway === 'footway' || segment.highway === 'cycleway') continue;
      const a = segment.points[0];
      const b = segment.points[segment.points.length - 1];
      const d = pointToSegmentDistance(point, a, b);
      if (d < bestDistance) {
        bestDistance = d;
        best = segment;
      }
    }
    return bestDistance < 46 ? best : null;
  }

  setTimeOfDay(hour) {
    this.timeOfDay = hour;
    const night = hour >= 19.5 || hour <= 6;
    const previousHour = this.appliedTimeOfDay;
    const previousNight = this.appliedNightState;
    const wrappedDelta = previousHour == null
      ? Infinity
      : Math.min(Math.abs(hour - previousHour), 24 - Math.abs(hour - previousHour));
    if (previousNight === night && wrappedDelta < 0.02) return;
    this.appliedTimeOfDay = hour;
    this.appliedNightState = night;

    const nightFactor = clamp((hour - 6) / 4, 0, 1) * clamp((20 - hour) / 4, 0, 1);
    const golden = Math.max(0, 1 - Math.abs(hour - 8.2) / 3.5) * 0.7;
    if (this.skyMesh && previousNight !== night) {
      const positions = this.skyMesh.geometry.attributes.position.array;
      const colors = this.skyMesh.geometry.attributes.color.array;
      const top = night ? this.timeColors.skyTopNight : this.timeColors.skyTopDay;
      const mid = night ? this.timeColors.skyMidNight : this.timeColors.skyMidDay;
      const bottom = night ? this.timeColors.skyBottomNight : this.timeColors.skyBottomDay;
      const c = this.timeColors.work;
      for (let i = 0; i < positions.length; i += 3) {
        const y = positions[i + 1] / 1900;
        if (y > 0.08) c.copy(top).lerp(mid, clamp(y, 0, 1));
        else c.copy(bottom).lerp(mid, 1 - clamp(-y, 0, 1) * 4);
        colors[i] = c.r;
        colors[i + 1] = c.g;
        colors[i + 2] = c.b;
      }
      this.skyMesh.geometry.attributes.color.needsUpdate = true;
    }
    this.sun.intensity = 0.3 + nightFactor * 2.7 + golden * 0.7;
    this.sun.color.copy(this.timeColors.sun.setHSL(0.09 + (1 - nightFactor) * 0.02, 0.55, 0.82));
    this.hemi.color.copy(this.timeColors.hemiDay).lerp(this.timeColors.hemiNight, 1 - nightFactor);
    this.hemi.intensity = 0.55 + nightFactor * 0.8;
    this.ambient.intensity = 0.08 + nightFactor * 0.26;
    this.rim.intensity = 0.1 + nightFactor * 0.55;
    // Image-based lighting. The rig re-prefilters only when the quantised hour
    // or the weather bucket changes; every other call is a Map lookup, and this
    // path is already gated to hour moves of at least 0.02 h.
    const environment = this.envRig
      ? this.envRig.update({ hour, weather: this.envWeather, scene: this.scene })
      : null;
    if (environment?.texture) {
      // The hemisphere/ambient pair was faking a sky bounce. The environment
      // now delivers that fill with correct directionality, so both are scaled
      // back hard in daylight or the scene is lit twice and contact shadows
      // wash out. The key light is barely trimmed: IBL supplements it.
      //
      // `keyFillBalance` then fixes the *ratio*. Measured on the 11:00 clear
      // card the rig above delivers key 1.13 against fill 1.61 - a key/fill of
      // 0.70, so a cast shadow can only be a hue shift, never a value change.
      // The correction preserves key+fill (the frame does not get darker) and
      // fades to 1 through civil twilight.
      const scales = environment.lightRig.scales;
      const balance = keyFillBalance(environment.model);
      this.sun.intensity *= scales.sun * balance.apply.sunScale;
      this.hemi.intensity *= balance.apply.hemiScale;
      this.ambient.intensity *= balance.apply.ambientScale;
      this.rim.intensity *= balance.apply.rimScale;
      this.scene.environmentIntensity = balance.apply.environmentIntensity;
      this.applyEnvironmentGrading(environment.model, environment.texture);
      // The key light now stands where the sky says the sun is. The hand-rolled
      // placement it replaces sat at a fixed azimuth, so the shadows in the
      // golden-hour card ran in a different direction from the sun visible in
      // the environment - the kind of mismatch that reads as "painted" no
      // matter how good the geometry is.
      this.setKeyDirectionFromSun(environment.model.sun, environment.model.daylight);
      // The key crosses zero at the horizon, because the direct beam does. The
      // day/night curve above only reaches its 0.3 floor at 20:00, an hour
      // after sunset, which would have left a bright key swinging overhead
      // through the ~40 minutes of civil twilight where the direction hands
      // over from sun to moon. `daylight` saturates at +/-6 deg, so this is 1
      // in daylight, 1 in night, and 0 exactly at sunrise and sunset - and it
      // is already 1 at the golden-hour card's +6.61 deg, which is untouched.
      // Squared rather than absolute so the envelope is smooth through the
      // crossing as well as zero at it, which is what keeps the direction
      // hand-over from being visible: the key is at a few per cent of its
      // strength exactly where it rotates fastest.
      this.sun.intensity *= (2 * environment.model.daylight - 1) ** 2;
      // The rim exists to fake the anti-sun sky bounce (which is why the module
      // cuts it hardest as the environment takes that job over). A fixed world
      // direction made it the anti-sun of nothing once the key started moving,
      // so it is aimed opposite the key, at a shallow angle.
      this.aimRimOppositeKey();
      if (environment.lightRig.shadow && 'intensity' in this.sun.shadow) {
        // Soften the map under an overcast dome instead of stamping a hard
        // clear-sky edge through fog or drizzle.
        this.sun.shadow.intensity = environment.lightRig.shadow.intensity;
      }
    }
    // The fit reads the key direction, so it has to be refreshed whenever the
    // hour moves, not only when the camera does.
    this.updateSunShadow({ force: true });
    if (previousNight !== night) {
      // Occupancy, intensity and colour temperature per emissive group instead
      // of one shared intensity for every window in the city. The quality gate
      // rejects a night frame carried solely by uniformly emissive windows, and
      // a single value is exactly that. Deterministic in the group index, so a
      // pinned capture hour reproduces the same lit pattern.
      const practicals = nightPracticalProfile({ hour, weather: this.envWeather });
      let emissiveIndex = 0;
      for (const entry of this.nightEmissive) {
        emissiveIndex += 1;
        const base = entry.nightIntensity ?? (entry.texture || entry.nightTexture ? 0.5 : 0.9);
        const roll = ((Math.imul(emissiveIndex, 2654435761) >>> 8) % 1000) / 1000;
        const lit = night && roll < practicals.windows.occupancy;
        const [lo, hi] = practicals.windows.intensityRange;
        entry.material.emissiveIntensity = lit ? base * (lo + (hi - lo) * roll) : 0;
        if (lit && entry.material.emissive) {
          const kelvin = roll > 1 - practicals.windows.coolShare ? 4900 : 2650;
          const [r, g, b] = blackBodyColor(kelvin);
          entry.material.emissive.setRGB(r * 0.42, g * 0.42, b * 0.42, THREE.LinearSRGBColorSpace);
        }
      }
      for (const material of this.neonGlowMaterials) {
        material.opacity = night ? material.userData.nightOpacity : (material.userData.dayOpacity ?? 0.18);
      }
      for (const bulb of this.lampBulbs) {
        bulb.material.emissiveIntensity = night ? 1.2 : 0.12;
      }
      this.localLightsNight = night;
      this.updateLocalLightPool(0, true);
    }
    if (this.water?.material) {
      this.water.material.color.set(night ? 0x1d5270 : 0x2f8fae);
      this.water.material.emissive.set(night ? 0x07192d : 0x062b35);
      this.water.material.emissiveIntensity = night ? 0.42 : 0.08;
    }
    const fogColor = this.timeColors.work;
    if (nightFactor < 0.28) fogColor.copy(this.timeColors.fogNight);
    else fogColor.copy(this.timeColors.fogDay).lerp(this.timeColors.fogDistant, 1 - nightFactor);
    // Daylight haze leans warm to match the key light.
    if (nightFactor >= 0.28) {
      fogColor.copy(this.timeColors.fogWarm).lerp(this.timeColors.fogDay, nightFactor * 0.4);
    }
    this.scene.fog.color.copy(fogColor);
    if (this.scene.background) this.scene.background.copy(fogColor);
    // Exposure follows measured scene illuminance instead of a two-state switch.
    // Between clear noon and 21:30 the illuminance this rig delivers falls 87x;
    // 0.82 -> 0.88 cannot carry that, which is why the night card crushed and
    // golden hour muddied. The curve is partial adaptation clamped to
    // 0.68..1.24: monotone in illuminance, and still compressed enough that
    // night does not render as day.
    this.nightBoost = null;
    this.renderer.toneMappingExposure = environment
      ? recommendedExposure(environment.model).exposure
      : (night ? 0.88 : 0.82);
  }

  /**
   * Point the key light where the sky model says the sun is.
   *
   * In daylight this is the solar direction itself, so the shadows agree with
   * the environment that lit the frame. Below the horizon the solar direction
   * points underground and would light the city from beneath, so the key is
   * reflected to the anti-solar azimuth and lifted to `NIGHT_KEY_ALTITUDE_DEG`
   * - roughly where a full moon stands - and keeps the 0.3 intensity floor the
   * day/night curve already applies.
   *
   * The two are crossfaded on the model's own `daylight` term, which saturates
   * at +/-6 deg (civil twilight). Switching on the sign of `sun.y` instead
   * would snap the key through 180 deg of azimuth at sunrise and sunset, and
   * the clock runs a whole day in 40 seconds. The band is wide enough to be
   * smooth and narrow enough that the golden-hour card, at +6.61 deg, is
   * already fully saturated and gets the pure solar direction.
   *
   * Deterministic: a function of the solar direction and the daylight term
   * alone, with no clock and no seed.
   *
   * @param {{x:number,y:number,z:number}} sun Direction toward the sun.
   * @param {number} [daylight] 1 in daylight, 0 below civil twilight.
   */
  setKeyDirectionFromSun(sun, daylight = null) {
    if (!sun || !Number.isFinite(sun.x) || !Number.isFinite(sun.y) || !Number.isFinite(sun.z)) return;
    const solarLength = Math.hypot(sun.x, sun.y, sun.z);
    if (!(solarLength > 1e-6)) return;
    const solar = { x: sun.x / solarLength, y: sun.y / solarLength, z: sun.z / solarLength };

    const altitude = (NIGHT_KEY_ALTITUDE_DEG * Math.PI) / 180;
    const cosAltitude = Math.cos(altitude);
    const horizontal = Math.hypot(solar.x, solar.z);
    // Anti-solar azimuth at a fixed altitude.
    const moon = horizontal > 1e-6
      ? {
        x: (-solar.x / horizontal) * cosAltitude,
        y: Math.sin(altitude),
        z: (-solar.z / horizontal) * cosAltitude,
      }
      : { x: 0, y: 1, z: 0 };

    const weight = Number.isFinite(daylight)
      ? clamp(daylight, 0, 1)
      : (solar.y > 0 ? 1 : 0);
    const x = solar.x * weight + moon.x * (1 - weight);
    const y = solar.y * weight + moon.y * (1 - weight);
    const z = solar.z * weight + moon.z * (1 - weight);
    if (Math.hypot(x, y, z) < 1e-4) {
      this.sunKeyDirection.set(moon.x, moon.y, moon.z).normalize();
      return;
    }
    this.sunKeyDirection.set(x, y, z).normalize();
  }

  /**
   * Put the rim light on the anti-key side of the scene at a shallow altitude.
   * It casts no shadow; only its direction matters.
   */
  aimRimOppositeKey() {
    const key = this.sunKeyDirection;
    const horizontal = Math.hypot(key.x, key.z);
    const altitude = (28 * Math.PI) / 180;
    const cosAltitude = Math.cos(altitude);
    const x = horizontal > 1e-6 ? (-key.x / horizontal) * cosAltitude : 0;
    const z = horizontal > 1e-6 ? (-key.z / horizontal) * cosAltitude : -cosAltitude;
    this.rim.position.set(x * 420, Math.sin(altitude) * 420, z * 420);
  }

  /**
   * Fit the sun's orthographic shadow camera to the visible slice of the view
   * frustum, and copy the fit onto the light.
   *
   * Called from `update()` every frame so the box tracks the player, and again
   * from `renderFrame()` so a caller that repositions the camera after
   * `update()` (the QA card harness pins its pose there) still renders with a
   * box fitted to the pose it is about to draw. The refit is guarded by a
   * signature, so the second call is a handful of comparisons unless something
   * actually moved.
   *
   * All of the geometry lives in `computeSunShadowCamera`, which is pure and
   * self-checked; this method only supplies the current camera and key
   * direction and records what came back.
   *
   * @param {{force?: boolean}} [options]
   * @returns {Readonly<object>|null} the fit, or null when the fit is unchanged.
   */
  updateSunShadow({ force = false } = {}) {
    const camera = this.camera;
    const key = this.sunKeyDirection;
    if (!camera || !key) return null;
    const forward = camera.getWorldDirection(this._shadowForward);
    // The fit throws on a degenerate lens rather than returning silent
    // nonsense, which is right for a pure function and wrong for the render
    // loop. Refuse the frame instead: the light keeps its last good fit.
    if (!Number.isFinite(forward.x) || forward.lengthSq() < 1e-12) return null;
    if (!Number.isFinite(camera.aspect) || camera.aspect <= 0) return null;
    if (!Number.isFinite(camera.fov) || camera.fov <= 0 || camera.fov >= 180) return null;
    if (!Number.isFinite(camera.near) || camera.near <= 0 || camera.near >= SUN_SHADOW_DISTANCE) return null;
    if (!Number.isFinite(key.x) || key.lengthSq() < 1e-12) return null;
    // World position, not local: `getWorldDirection` above has already brought
    // the matrix up to date, and this stays correct if the camera is ever
    // parented to a vehicle or player rig.
    const eye = camera.getWorldPosition(this._shadowEye);
    if (!Number.isFinite(eye.x) || !Number.isFinite(eye.y) || !Number.isFinite(eye.z)) return null;
    const signature = `${Math.round(eye.x / SUN_SHADOW_REFIT_EPSILON)},`
      + `${Math.round(eye.y / SUN_SHADOW_REFIT_EPSILON)},`
      + `${Math.round(eye.z / SUN_SHADOW_REFIT_EPSILON)},`
      + `${forward.x.toFixed(4)},${forward.y.toFixed(4)},${forward.z.toFixed(4)},`
      + `${camera.fov},${camera.aspect.toFixed(5)},${camera.near},`
      + `${key.x.toFixed(5)},${key.y.toFixed(5)},${key.z.toFixed(5)},`
      + `${this.maxCasterHeight}`;
    if (!force && signature === this.shadowFitSignature) return null;
    this.shadowFitSignature = signature;

    const fit = computeSunShadowCamera({
      cameraPosition: { x: eye.x, y: eye.y, z: eye.z },
      cameraDirection: { x: forward.x, y: forward.y, z: forward.z },
      fovDeg: camera.fov,
      aspect: camera.aspect,
      sunDirection: { x: key.x, y: key.y, z: key.z },
      shadowDistance: SUN_SHADOW_DISTANCE,
      cameraNear: camera.near,
      mapSize: SUN_SHADOW_MAP_SIZE,
      maxCasterHeight: this.maxCasterHeight,
    });
    applySunShadowFit(this.sun, fit);
    // The fit's own bias pair was calibrated while 143 sub-texel meshes were
    // still in the caster set - the one acne source a normal offset cannot fix
    // at any magnitude - so it carries 1.25 texels of normalBias. With the
    // caster policy above removing those meshes the residual acne is ordinary
    // slope acne, which the slope formula prices at 1.0 texel; the 0.25 texels
    // handed back are paid at the contact line, where the character and street
    // dimensions are scored. `bias` is recomputed here every refit rather than
    // held constant because it is expressed in the orthographic depth range,
    // which swings ~4x between noon and golden hour.
    const biasPlan = recommendShadowBias({
      texelWorldSize: fit.texelWorldSize,
      depthRange: fit.depthRange,
      mapSize: SUN_SHADOW_MAP_SIZE,
      sunAltitudeDeg: fit.sunAltitudeDeg,
    });
    if (Number.isFinite(biasPlan.normalBias)) this.sun.shadow.normalBias = biasPlan.normalBias;
    if (Number.isFinite(biasPlan.bias)) this.sun.shadow.bias = biasPlan.bias;
    this.sun.shadow.needsUpdate = true;
    this.shadowFit = fit;
    const diagnostics = this.shadowDiagnostics;
    diagnostics.fitted = true;
    diagnostics.refits += 1;
    diagnostics.texelsPerMetre = fit.texelsPerMetre;
    diagnostics.texelWorldSize = fit.texelWorldSize;
    diagnostics.width = fit.width;
    diagnostics.depthRange = fit.depthRange;
    // Report what is actually on the light, not what the fit proposed.
    diagnostics.normalBias = this.sun.shadow.normalBias;
    diagnostics.bias = this.sun.shadow.bias;
    diagnostics.fitNormalBias = fit.normalBias;
    diagnostics.fitBias = fit.bias;
    diagnostics.biasPlan = {
      normalBiasTexels: biasPlan.normalBiasTexels,
      depthBiasTexels: biasPlan.depthBiasTexels,
      holdsReceiverSlopeToDeg: biasPlan.holdsReceiverSlopeToDeg,
      peterPanMetres: biasPlan.peterPanMetres,
      contactLeakMetres: biasPlan.contactLeakMetres,
      minCasterThickness: biasPlan.minCasterThickness,
      warnings: biasPlan.warnings,
    };
    diagnostics.castShadow = fit.castShadow;
    diagnostics.sunAltitudeDeg = fit.sunAltitudeDeg;
    diagnostics.maxCasterHeight = this.maxCasterHeight;
    diagnostics.warnings = fit.warnings;
    if (!this.shadowFitLogged) {
      this.shadowFitLogged = true;
      // Once, at startup. The density is invariant to the sun and to which way
      // the camera faces, so a single line describes every frame the app will
      // ever draw at this map size and shadow distance.
      console.info(
        `[${SUN_SHADOW_PASS}] shadow map ${SUN_SHADOW_MAP_SIZE}x${SUN_SHADOW_MAP_SIZE} `
        + `over ${SUN_SHADOW_DISTANCE} m of view depth: `
        + `${fit.texelsPerMetre.toFixed(3)} texels/m `
        + `(${(fit.texelWorldSize * 100).toFixed(1)} cm texels, ${fit.width.toFixed(1)} m box), `
        + `normalBias ${this.sun.shadow.normalBias} m `
        + `(${biasPlan.normalBiasTexels} texel, holds receivers to `
        + `${biasPlan.holdsReceiverSlopeToDeg} deg), bias ${this.sun.shadow.bias} `
        + `(${biasPlan.depthBiasTexels} texel = ${biasPlan.depthPullbackMetres} m pull-back) `
        + `over ${fit.depthRange.toFixed(0)} m of depth; caster thickness floor `
        + `${biasPlan.minCasterThickness} m`,
      );
    }
    return fit;
  }

  /**
   * Crowd presentation: a mirror of the pedestrian simulation, never a second
   * copy of it.
   *
   * WHERE THE PEDESTRIANS ACTUALLY LIVE. `TrafficSim` (src/citygen/traffic.js)
   * owns them. On the canonical route `buildCity` constructs it with the real
   * SF slice, `buildSidewalkPaths` yields 6 260 curbside polylines from
   * `city.segments`, and 48 walkers are spawned from them - which is also what
   * `verify:citygen-actors` gates on (`pedestrians === 48`). They are NOT
   * missing. Path, arc position, direction, identity and speed stay in
   * `traffic.pedestrians`; this method reads them and writes nothing back.
   *
   * The legacy `pedestrian-batch` InstancedMeshes keep being written by the
   * simulation - every existing check reads their instance matrices - but once
   * this crowd is actually drawing, the batch group is hidden so the two do not
   * occupy the same space. Visibility is presentation, not simulation state.
   */
  ensureCrowdPresentation() {
    if (this.crowd) return this.crowd;
    try {
      // The plane the crowd stands on. `terrain.heightAt` is BARE GROUND; the
      // pavement is `streetDesign.roadLift + 45 mm` above it - see
      // `streetSurfaceLift` - which is where the kerb top, the street lamps, the
      // sidewalk props and the seated hero actors already are. Sampling bare
      // terrain sank the entire crowd 42 cm into the pavement.
      const crowdFootwayLift = this.streetSurfaceLift(this.city || {}).footway;
      this.crowd = createCrowdPresentation({
        // Under `city-root`, not the scene. Interior mode hides every visible
        // child of `city-root` plus `traffic.group` (main.js `enterBuilding`);
        // a crowd hanging directly off the scene would keep walking through
        // the shop interior. It cannot live under `traffic.group` either -
        // `verify:citygen-actors` counts the meshes named `pedestrian-*` in
        // there and expects exactly the simulation's own eleven.
        parent: this.root || this.scene,
        // The simulation's own footway datum, not a second one: TrafficSim's
        // `pedestrianGroundY` puts walkers on the same plane.
        sampleGround: (x, z) => (this.terrain?.heightAt
          ? this.terrain.heightAt(x, z) + crowdFootwayLift
          : crowdFootwayLift),
        readAgent: (source, index, out) => this.readPedestrianAgent(source, index, out),
      });
      this.crowdDiagnostics.pass = this.crowd.version;
    } catch (error) {
      console.error(`[${PEDESTRIAN_PRESENTATION_VERSION}] crowd presentation failed to build; `
        + 'the simulation keeps its existing instanced batch', error);
      this.crowd = null;
      this.crowdPresentationFailed = true;
    }
    return this.crowd;
  }

  /**
   * Read one simulation pedestrian into the presentation's snapshot record.
   *
   * Read-only by construction: it touches `group.position`, `group.rotation`
   * and `userData.walk`, and assigns only to `out`.
   *
   * Two departures from `defaultReadAgent`, both so the mirror does not
   * contradict the thing it mirrors:
   *
   *  1. `walk.bobOffset` is subtracted out of `y`. The simulation already adds
   *     a gait bob to the group position; the presentation runs its own gait,
   *     so passing the summed value through would bob the crowd twice.
   *  2. `speed` is the distance the simulation actually moved this agent,
   *     divided by the step - not `pedestrian.speed`, which is a nominal
   *     cruise figure that stays at 1.3-2.2 m/s even for the curb actors that
   *     are standing, turning or seated. The gait phase is an odometer driven
   *     by this number, so a standing agent must report zero or its feet
   *     skate on the spot.
   */
  readPedestrianAgent(source, index, out) {
    const group = source?.group;
    const position = group?.position;
    // Ambient walkers own no batch slot, so they carry their own stable
    // presentation id. Falling through to the array index would hand an agent a
    // new face and a new outfit every time the array is rebuilt.
    const id = source?.presentationId ?? source?.instanceIndex ?? index;
    const bob = group?.userData?.walk?.bobOffset || 0;
    const x = Number(position?.x ?? 0);
    const y = Number(position?.y ?? 0) - bob;
    const z = Number(position?.z ?? 0);
    let record = this.crowdTracks.get(id);
    if (!record) {
      record = { x, z, speed: Math.max(0, Number(source?.speed) || 0) };
      this.crowdTracks.set(id, record);
    } else {
      const step = this.crowdTrackStep;
      const jump = Math.hypot(x - record.x, z - record.z);
      if (jump > CROWD_TELEPORT_METRES) {
        // `recyclePedestriansNearFocus` moves an agent to a new path when the
        // player walks away from it. That is a teleport, not locomotion:
        // dividing it by the step would read as a sprint and burst the gait
        // into the brisk clip for a frame. Re-seat the track instead.
        record.speed = Math.max(0, Number(source?.speed) || 0);
      } else if (step > 1e-4) {
        const moved = jump / step;
        // One-pole smoothing at ~8 Hz. Raw per-frame displacement is noisy
        // enough to flicker the walk/idle threshold on a stationary agent.
        const alpha = clamp(step * 8, 0, 1);
        record.speed += (Math.min(moved, 4) - record.speed) * alpha;
      }
      record.x = x;
      record.z = z;
    }
    out.id = id;
    out.seed = id;
    out.x = x;
    out.y = y;
    out.z = z;
    out.heading = Number(group?.rotation?.y ?? 0);
    out.speed = record.speed;
    out.active = true;
    // The curb vignette's bench actor is seated in the simulation. The
    // presentation rig has no seated clip, so it cannot reproduce the pose;
    // what it can do is refuse to walk on the spot. `'sit'` forces the blend
    // fully to idle regardless of measured speed. See the known-limits note.
    out.pose = source?.heroCurbBehavior?.poseKind === 'bench-seated' ? 'sit' : 'walk';
    // What the agent is DOING, when the simulation models it: 'wait', 'talk',
    // 'phone', 'browse', 'carry', 'stand'. Presentation reads it to pick an
    // upper-body overlay and writes nothing back.
    out.activity = source?.activity ?? null;
    // When the simulation reports its own instantaneous ground speed, prefer it
    // over the measured displacement: it is exact, and it falls to zero on the
    // frame the agent stops rather than ~125 ms later.
    if (Number.isFinite(source?.groundSpeed)) out.speed = Math.max(0, source.groundSpeed);
    return out;
  }

  /**
   * Drive the crowd from the simulation's own array, once per frame, from the
   * one existing loop. Creates no loop, no renderer and no clock.
   */
  updateCrowdPresentation(traffic, delta) {
    // Every agent the simulation wants mirrored: the 48 logical pedestrians plus
    // the ambient sidewalk pool TrafficSim maintains alongside them. Ambient
    // walkers own no instanced-batch slot and no gameplay hooks, so
    // `traffic.pedestrians` - and every check that pins its length - is
    // unchanged; they exist only to be drawn.
    const agents = typeof traffic?.presentationAgents === 'function'
      ? traffic.presentationAgents()
      : traffic?.pedestrians;
    if (!Array.isArray(agents) || !agents.length) {
      if (this.crowd) this.crowd.update([], delta, this.camera);
      this.restoreLegacyPedestrianBatch();
      return null;
    }
    if (this.crowdPresentationFailed) return null;
    const crowd = this.ensureCrowdPresentation();
    if (!crowd) return null;
    this.crowdTrackStep = Math.max(0, delta);
    // Contact-shadow density follows the key light the shadow fit reports.
    const altitude = Number.isFinite(this.shadowFit?.sunAltitudeDeg)
      ? this.shadowFit.sunAltitudeDeg
      : null;
    if (altitude !== null && altitude !== this.crowdSunElevation) {
      this.crowdSunElevation = altitude;
      crowd.setSunElevation(altitude);
    }
    const stats = crowd.update(agents, delta, this.camera);
    const drawing = (stats.skinned + stats.instanced + stats.far) > 0;
    // Hand over only once the replacement is demonstrably drawing something.
    // A silent failure here would empty the streets, which is worse than two
    // crowds in the same place.
    if (drawing) this.hideLegacyPedestrianBatch(traffic);
    else this.restoreLegacyPedestrianBatch();
    const diagnostics = this.crowdDiagnostics;
    diagnostics.source = 'traffic.pedestrians';
    diagnostics.agents = stats.agents;
    diagnostics.skinned = stats.skinned;
    diagnostics.instanced = stats.instanced;
    diagnostics.far = stats.far;
    diagnostics.culled = stats.culled;
    diagnostics.draws = stats.draws;
    diagnostics.grounded = stats.grounded;
    diagnostics.maxFootGroundSpeed = stats.maxFootGroundSpeed;
    diagnostics.activities = stats.activities;
    diagnostics.activityOverlays = stats.activityOverlays;
    diagnostics.uniqueAppearances = stats.uniqueAppearances;
    return stats;
  }

  /** Presentation-only: stop the simulation's own instanced batch drawing. */
  hideLegacyPedestrianBatch(traffic) {
    const group = traffic?.pedestrianBatch?.group;
    if (!group || group === this.legacyPedestrianBatchGroup) return;
    this.restoreLegacyPedestrianBatch();
    this.legacyPedestrianBatchGroup = group;
    this.legacyPedestrianBatchVisible = group.visible;
    group.visible = false;
    this.crowdDiagnostics.legacyBatchHidden = true;
  }

  /** Put the simulation's batch back exactly as it was found. */
  restoreLegacyPedestrianBatch() {
    const group = this.legacyPedestrianBatchGroup;
    if (!group) return;
    group.visible = this.legacyPedestrianBatchVisible;
    this.legacyPedestrianBatchGroup = null;
    this.legacyPedestrianBatchVisible = true;
    this.crowdDiagnostics.legacyBatchHidden = false;
  }

  disposeCrowdPresentation() {
    this.restoreLegacyPedestrianBatch();
    if (this.crowd) {
      this.crowd.dispose();
      this.crowd = null;
    }
    this.crowdTracks.clear();
    this.crowdSunElevation = null;
    this.crowdPresentationFailed = false;
    this.crowdDiagnostics = {
      pass: PEDESTRIAN_PRESENTATION_VERSION,
      source: null,
      agents: 0,
      skinned: 0,
      instanced: 0,
      far: 0,
      culled: 0,
      draws: 0,
      legacyBatchHidden: false,
    };
  }

  pick(pointer) {
    this.raycaster = this.raycaster || new THREE.Raycaster();
    this.raycaster.setFromCamera(pointer, this.camera);
    const objects = this.pickables;
    const hits = this.raycaster.intersectObjects(objects, true);
    return hits.length ? hits[0] : null;
  }

  update(delta, { time = null, traffic = null, players = null } = {}) {
    this.phaseClock += delta;
    this.signalPhaseClock += delta;
    this.controls.update();
    if (time != null) this.setTimeOfDay(time);
    this.updateLocalLightPool(delta);
    this.updateWorldPartition();
    this.updatePortalPartition();
    this.updateParkedCarPartition();
    if (this.signalMeshes) {
      for (const entry of this.signalMeshes) {
        const offset = entry.signal.phaseOffset || 0;
        const local = Math.floor((this.signalPhaseClock + offset) / 8) % 4;
        const red = local === 0 || local === 1;
        const yellow = local === 2;
        const green = local === 3;
        const colors = [0xe0443a, 0xe8b23a, 0x5bbf6a];
        for (let i = 0; i < 3; i += 1) {
          const on = i === 0 ? red : i === 1 ? yellow : green;
          entry.lampMaterials[i].emissive.set(on ? colors[i] : 0x000000);
          entry.lampMaterials[i].emissiveIntensity = on ? 1.0 : 0.05;
          entry.lampMaterials[i].color.set(on ? colors[i] : 0x2b2f33);
        }
      }
    }
    if (traffic) {
      traffic.update(delta);
      // Mirror the simulation's pedestrians. This runs after `traffic.update`
      // so the crowd shows the state of this frame, not the previous one.
      this.updateCrowdPresentation(traffic, delta);
    }
    if (players) players.update(delta);
    if (this.passContext) this.passRuntime.update(this.passContext, delta);
    if (this.water && this.water.material) {
      const wave = Math.sin(this.phaseClock * 0.6) * 0.05;
      this.water.position.y = 0.45 + wave;
    }
    // The night exposure ramp is gone: `recommendedExposure` is already a
    // continuous function of the clock, so a separate 1.2 s fade would fight it.
    // Track the camera. The box is 220 m across, so it has to follow the
    // player; a fixed box aimed at the world origin is what made the shadow map
    // invisible on a two-kilometre map.
    this.updateSunShadow();
  }

  renderFrame() {
    // Second, guarded call. `update()` is the canonical driver, but anything
    // that moves the camera between `update()` and the draw would otherwise
    // render one frame behind the fit. The signature check makes this free when
    // nothing has moved.
    this.updateSunShadow();
    this.renderer.render(this.scene, this.camera);
  }

  setWalkMode(enabled) {
    this.controls.enabled = !enabled;
    if (enabled) this.controls.enableRotate = false;
    else this.controls.enableRotate = true;
  }
}

const STREET_LAMP_CLASSES = Object.freeze(['primary', 'secondary', 'tertiary', 'residential']);
const STREET_LAMP_SPACING = Object.freeze({
  primary: 32,
  secondary: 34,
  tertiary: 42,
  residential: 50,
});

/**
 * Derive authored lamp fixtures from the active street contract. Real maps
 * must follow source polylines; the old axis/position shortcut silently
 * collapsed OSM roads onto z=0 because OSM streets intentionally have no
 * grid axis. Records carry their source segment and measured sidewalk band
 * so QA can reject presentation-only or asphalt placements.
 */
function collectStreetLampRecords(city, { maxLamps = 240 } = {}) {
  const generator = city?.meta?.generator || 'unknown';
  const realMap = generator === 'sf-builtin' || generator === 'openstreetmap';
  if (!realMap) return collectProceduralLampRecords(city, maxLamps);

  const segments = Array.isArray(city?.segments) ? city.segments : [];
  const eligible = segments.filter((segment) => STREET_LAMP_CLASSES.includes(segment.highway)
    && Array.isArray(segment.points) && segment.points.length >= 2);
  const byClass = new Map(STREET_LAMP_CLASSES.map((highway) => [highway, []]));
  const seen = new Set();
  let generatedCount = 0;
  let culledAsphaltOverlaps = 0;
  let polylineSegments = 0;

  const distanceToPolyline = (point, points) => {
    let distance = Infinity;
    for (let index = 1; index < points.length; index += 1) {
      distance = Math.min(distance, pointToSegmentDistance(point, points[index - 1], points[index]));
    }
    return distance;
  };
  const overlapsOtherAsphalt = (point, owner) => eligible.some((segment) => {
    if (segment === owner || segment.streetId === owner.streetId) return false;
    const width = Number(segment.width || 0);
    return width > 0 && distanceToPolyline(point, segment.points) < width / 2 + 0.3;
  });

  for (const segment of eligible) {
    const points = segment.points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.z));
    if (points.length < 2) continue;
    if (points.length > 2) polylineSegments += 1;
    const length = polylineLength(points);
    if (!Number.isFinite(length) || length < 18) continue;
    const leftWidth = Math.max(0, Number(segment.sidewalkLeft ?? segment.sidewalkW ?? 0));
    const rightWidth = Math.max(0, Number(segment.sidewalkRight ?? segment.sidewalkW ?? 0));
    const sides = [];
    if (leftWidth >= 0.8) sides.push({ side: 1, width: leftWidth });
    if (rightWidth >= 0.8) sides.push({ side: -1, width: rightWidth });
    if (!sides.length) continue;
    const spacingMeters = STREET_LAMP_SPACING[segment.highway] || 42;
    const count = Math.max(1, Math.round(length / spacingMeters));
    const queue = byClass.get(segment.highway);
    for (let index = 0; index < count; index += 1) {
      const along = ((index + 0.5) / count) * length;
      const point = pointAlongPolyline(points, along);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
      const placement = sides[index % sides.length];
      const minOffset = Number(segment.width || 0) / 2 + 0.3;
      const maxOffset = Number(segment.width || 0) / 2 + placement.width - 0.3;
      if (maxOffset < minOffset) continue;
      const lateralOffset = minOffset + (maxOffset - minOffset) * 0.58;
      const x = point.x + point.nx * lateralOffset * placement.side;
      const z = point.z + point.nz * lateralOffset * placement.side;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      generatedCount += 1;
      const key = `${Math.round(x * 10)}:${Math.round(z * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (overlapsOtherAsphalt({ x, z }, segment)) {
        culledAsphaltOverlaps += 1;
        continue;
      }
      queue.push({
        x,
        z,
        rotation: Math.atan2(point.tx, point.tz),
        segmentId: segment.id,
        streetId: segment.streetId,
        streetName: segment.streetName || '',
        highway: segment.highway,
        side: placement.side,
        sidewalkWidth: placement.width,
        lateralOffset,
        minOffset,
        maxOffset,
        distanceAlong: Number(along.toFixed(3)),
        spacingMeters,
        source: 'segment-polyline',
        overlapsAsphalt: false,
      });
    }
  }

  // Interleave classes before applying the global cap. This keeps the
  // bounded population representative of primary through residential roads,
  // independent of source element ordering.
  const cursors = new Map(STREET_LAMP_CLASSES.map((highway) => [highway, 0]));
  const records = [];
  let added = true;
  while (records.length < maxLamps && added) {
    added = false;
    for (const highway of STREET_LAMP_CLASSES) {
      if (records.length >= maxLamps) break;
      const queue = byClass.get(highway);
      const cursor = cursors.get(highway);
      if (cursor >= queue.length) continue;
      records.push(queue[cursor]);
      cursors.set(highway, cursor + 1);
      added = true;
    }
  }

  const classCounts = Object.fromEntries(STREET_LAMP_CLASSES.map((highway) => [
    highway,
    records.filter((record) => record.highway === highway).length,
  ]));
  const sideCounts = {
    left: records.filter((record) => record.side === 1).length,
    right: records.filter((record) => record.side === -1).length,
  };
  return {
    records,
    diagnostics: {
      fixtureCount: records.length,
      candidateCount: records.length,
      generatedCount,
      culledAsphaltOverlaps,
      polylineSegments,
      sourceOwnedCount: records.filter((record) => record.segmentId && record.streetId).length,
      bandViolations: records.filter((record) => (
        record.lateralOffset < record.minOffset - 1e-6
        || record.lateralOffset > record.maxOffset + 1e-6
      )).length,
      asphaltOverlaps: records.filter((record) => record.overlapsAsphalt).length,
      classCounts,
      sideCounts,
    },
  };
}

function collectProceduralLampRecords(city, maxLamps) {
  const positions = new Map();
  const bounds = city?.meta?.bounds || {};
  for (const signal of city?.signals || []) {
    const x = Number(signal.position?.x);
    const z = Number(signal.position?.z);
    if (Number.isFinite(x) && Number.isFinite(z)) positions.set(`${x.toFixed(1)},${z.toFixed(1)}`, {
      x,
      z,
      rotation: 0,
      source: 'signal',
    });
  }
  for (const street of city?.streets || []) {
    if (positions.size >= maxLamps) break;
    if (street.highway !== 'primary' && street.highway !== 'secondary') continue;
    const axis = street.axis;
    if (axis !== 'x' && axis !== 'z') continue;
    const position = Number(street.position);
    const count = 6;
    for (let index = 1; index < count; index += 1) {
      if (positions.size >= maxLamps) break;
      const t = index / count;
      const x = axis === 'x' ? position : bounds.minX + (bounds.maxX - bounds.minX) * t;
      const z = axis === 'z' ? position : bounds.minZ + (bounds.maxZ - bounds.minZ) * t;
      const lateral = street.sidewalkW + street.asphaltWidth / 2 + 0.9;
      const side = index % 2 === 0 ? 1 : -1;
      const lampX = axis === 'x' ? position + side * lateral : x;
      const lampZ = axis === 'z' ? position + side * lateral : z;
      if (!Number.isFinite(lampX) || !Number.isFinite(lampZ)) continue;
      positions.set(`${lampX.toFixed(1)},${lampZ.toFixed(1)}`, {
        x: lampX,
        z: lampZ,
        rotation: axis === 'x' ? Math.PI / 2 : 0,
        source: 'procedural-grid',
      });
    }
  }
  const records = [...positions.values()].slice(0, maxLamps);
  return {
    records,
    diagnostics: {
      fixtureCount: records.length,
      candidateCount: records.length,
      generatedCount: records.length,
      culledAsphaltOverlaps: 0,
      polylineSegments: 0,
      sourceOwnedCount: 0,
      bandViolations: 0,
      asphaltOverlaps: 0,
      classCounts: {},
      sideCounts: {},
    },
  };
}

function isSanFranciscoCity(city) {
  const name = String(city?.meta?.name || '');
  const seed = String(city?.meta?.seed || '');
  return city?.meta?.generator === 'sf-builtin'
    || (city?.meta?.generator === 'openstreetmap' && /san\s*francisco/i.test(name))
    || /^sf(?:[-_ ]|$)/i.test(seed);
}

function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

function polylineLength(points) {
  let length = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return length;
}

function pointAlongPolyline(points, distance) {
  let remaining = distance;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segLength = Math.hypot(dx, dz);
    if (segLength <= 0) continue;
    if (remaining <= segLength) {
      const t = remaining / segLength;
      return {
        x: a.x + dx * t,
        z: a.z + dz * t,
        tx: dx / segLength,
        tz: dz / segLength,
        nx: -dz / segLength,
        nz: dx / segLength,
      };
    }
    remaining -= segLength;
  }
  const last = points[points.length - 2] || points[0];
  const end = points[points.length - 1];
  const dx = end.x - last.x;
  const dz = end.z - last.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: end.x, z: end.z, tx: dx / length, tz: dz / length, nx: -dz / length, nz: dx / length };
}
