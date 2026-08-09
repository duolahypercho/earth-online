import * as THREE from 'three';
import { SIGNAL_PERIOD, signalOffsetForPosition, signalPhaseAt } from './signals.js';
import { HYDE_MEASURED_GRADE } from './district_massing.js';

// Geographic references used for the authored signatures (geography only;
// no proprietary meshes or textures): OpenStreetMap/ODbL landmark and street
// data, DataSF Analysis Neighborhoods, USGS 3DEP elevation, NOAA shoreline,
// SFMTA/Port/NPS public maps. The client remains a stylized local-meter scene:
// +X is east, +Z is north, and the existing 384 m sectors remain authoritative.

const SECTOR_HALF = 192;
const ROAD_WIDTH = 12;
const SIDEWALK_WIDTH = 3.8;
const SURFACE_OFFSET = 0.018;
const ROAD_MARKING_OFFSET = 0.044;
const SIGNAL_UPDATE_INTERVAL = 0.05;
const MAX_DETAIL_BUILDINGS = 36;
const MAX_PROXY_BUILDINGS = 24;
const publicAsset = (path) => `${import.meta.env?.BASE_URL ?? '/'}${path.replace(/^\//, '')}`;
const SIGNAL_GROUPS = Object.freeze({ eastWest: 0, northSouth: 1 });
// Opt-in waterfront evidence composition.  This is published with the
// authored Embarcadero presentation for QA tooling; normal camera defaults
// and the runtime roam path remain unchanged.
const EMBARCADERO_C3_VIEW = Object.freeze({
  id: 'sf-evidence:3:0:embarcadero-c3',
  sectorKey: '3:0',
  camera: Object.freeze({ x: 1400, y: 28, z: 0 }),
  lookAt: Object.freeze({ x: 1030, y: 28, z: 12 }),
  composition: 'waterfront-landmarks',
});

const EXPANSION_SECTORS = Object.freeze([
  Object.freeze({
    key: '1:0',
    district: 'Civic Center / SoMa',
    tone: 'civic',
    // Van Ness · Franklin · Gough · Hyde grain + Market diagonal (traffic-budget 7-line).
    roadName: 'Market Street civic spine',
    roadLines: Object.freeze([-192, -132, -68, 0, 64, 132, 192]),
    diagonal: Object.freeze({ start: [-192, -154], end: [192, 74], width: 16, name: 'Market Street' }),
    heightRange: Object.freeze([18, 58]),
    styles: Object.freeze(['rowhouse', 'masonry', 'civic', 'masonry', 'rowhouse', 'civic']),
    palette: Object.freeze([0x9a6b5d, 0xb18a6d, 0x6d7e82, 0xc0b49f]),
    accent: 0x6d3f3b,
    landmark: 'civic-spine',
    treeCadence: 9,
    signalEvery: 1,
  }),
  Object.freeze({
    key: '4:0',
    district: 'Financial District',
    tone: 'financial',
    // Montgomery · Kearny · Sansome · Battery downtown (tower parcels need wider cells).
    roadName: 'Battery Street financial grid',
    roadLines: Object.freeze([-192, -124, -52, 16, 82, 142, 192]),
    heightRange: Object.freeze([45, 142]),
    styles: Object.freeze(['tower', 'tower', 'podium', 'tower', 'podium', 'tower']),
    palette: Object.freeze([0x3e5b64, 0x566e75, 0xb0a58f, 0x657278]),
    accent: 0x273c43,
    landmark: 'skyline',
    treeCadence: 0,
    signalEvery: 2,
  }),
  Object.freeze({
    key: '4:4',
    district: 'North Beach / Telegraph Hill',
    tone: 'north-beach',
    // Grant · Stockton · Powell · Columbus hill blocks.
    roadName: 'Columbus Avenue north beach grid',
    roadLines: Object.freeze([-192, -138, -76, -8, 56, 122, 192]),
    diagonal: Object.freeze({ start: [-192, -128], end: [192, 128], width: 13, name: 'Columbus Avenue' }),
    heightRange: Object.freeze([10, 32]),
    styles: Object.freeze(['rowhouse', 'stucco', 'rowhouse', 'italianate', 'rowhouse', 'stucco']),
    palette: Object.freeze([0x9e6a58, 0xc7a47d, 0xd6c4a3, 0x726d78]),
    accent: 0x8c4039,
    landmark: 'coit-tower',
    treeCadence: 12,
    signalEvery: 2,
  }),
  Object.freeze({
    key: '0:4',
    district: 'Pacific Heights',
    tone: 'pacific-heights',
    // Fillmore · Steiner · Pierce × California/Sacramento hill lots.
    roadName: 'California Street hill route',
    roadLines: Object.freeze([-192, -136, -72, -8, 60, 132, 192]),
    diagonal: Object.freeze({ start: [-192, -156], end: [192, 128], width: 11, name: 'California Street' }),
    heightRange: Object.freeze([12, 42]),
    styles: Object.freeze(['villa', 'rowhouse', 'villa', 'masonry', 'rowhouse', 'villa']),
    palette: Object.freeze([0xb89176, 0xd5c3a5, 0x88747c, 0xe0d7c7]),
    accent: 0x6e4f4b,
    landmark: 'hill-villas',
    treeCadence: 5,
    signalEvery: 2,
    grade: 0.11,
  }),
  Object.freeze({
    key: '-4:1',
    district: 'Presidio Heights / Presidio',
    tone: 'presidio',
    // Arguello · Spruce · Locust park-edge streets.
    roadName: 'Presidio park edge',
    roadLines: Object.freeze([-192, -144, -80, -12, 60, 132, 192]),
    heightRange: Object.freeze([6, 22]),
    styles: Object.freeze(['villa', 'villa', 'park', 'villa', 'park', 'villa']),
    palette: Object.freeze([0xb7aa8f, 0xd5c8aa, 0x798b80, 0x8e7869]),
    accent: 0x546b5e,
    landmark: 'presidio-gate',
    treeCadence: 3,
    signalEvery: 2,
    grade: 0.045,
  }),
  Object.freeze({
    key: '-3:-2',
    district: 'Mission District',
    tone: 'mission',
    // Mission · Valencia · Guerrero · Dolores × 16th/24th corridor.
    roadName: '24th Street Mission corridor',
    roadLines: Object.freeze([-192, -140, -78, -16, 48, 116, 192]),
    diagonal: Object.freeze({ start: [-192, -84], end: [192, 126], width: 14, name: 'Mission Street' }),
    heightRange: Object.freeze([8, 34]),
    styles: Object.freeze(['rowhouse', 'masonry', 'rowhouse', 'warehouse', 'rowhouse', 'masonry']),
    palette: Object.freeze([0x9b6052, 0xd0a06f, 0x6f7e86, 0xb75e4d]),
    accent: 0x7d3d36,
    landmark: 'mission-dolores',
    treeCadence: 11,
    signalEvery: 2,
    grade: 0.038,
  }),
  Object.freeze({
    key: '4:-4',
    district: 'Mission Bay',
    tone: 'mission-bay',
    // Larger SoMa/Mission Bay industrial parcels (~64 m) still street-by-street.
    roadName: 'Mission Bay waterfront grid',
    roadLines: Object.freeze([-192, -128, -64, 0, 64, 128, 192]),
    heightRange: Object.freeze([18, 64]),
    styles: Object.freeze(['podium', 'tower', 'warehouse', 'podium', 'tower', 'warehouse']),
    palette: Object.freeze([0x55777c, 0x9eaa9e, 0xb88267, 0x4e646a]),
    accent: 0x9a4b3c,
    landmark: 'mission-bay-crane',
    treeCadence: 8,
    signalEvery: 2,
  }),
  Object.freeze({
    key: '-5:-4',
    district: 'Outer Sunset',
    tone: 'outer-sunset',
    // Numbered avenues × Judah/Irving dune blocks.
    roadName: 'Sunset dune grid',
    roadLines: Object.freeze([-192, -150, -94, -34, 30, 106, 192]),
    heightRange: Object.freeze([5, 16]),
    styles: Object.freeze(['stucco', 'rowhouse', 'stucco', 'stucco', 'rowhouse', 'stucco']),
    palette: Object.freeze([0xcbb99a, 0xb49c8a, 0x8a8c82, 0xd6c7ab]),
    accent: 0x6f6a64,
    landmark: 'ocean-park-edge',
    treeCadence: 6,
    signalEvery: 2,
  }),
  Object.freeze({
    key: '3:3',
    district: 'Chinatown',
    tone: 'chinatown',
    // Grant · Stockton · Powell × Clay/Sacramento alley cadence.
    roadName: 'Grant Avenue Chinatown spine',
    roadLines: Object.freeze([-192, -128, -64, -8, 56, 120, 192]),
    heightRange: Object.freeze([10, 28]),
    styles: Object.freeze(['rowhouse', 'masonry', 'rowhouse', 'masonry', 'rowhouse', 'podium']),
    palette: Object.freeze([0x8c3a36, 0x2f6b4f, 0xb48a5a, 0xc9b48a]),
    accent: 0x8c1f1a,
    landmark: 'dragon-gate',
    treeCadence: 14,
    signalEvery: 2,
    grade: 0.055,
  }),
  Object.freeze({
    key: '2:3',
    district: 'Nob Hill',
    tone: 'nob-hill',
    // Taylor · Jones · Leavenworth × California cable ridge.
    roadName: 'California Street cable ridge',
    roadLines: Object.freeze([-192, -136, -72, -8, 60, 128, 192]),
    diagonal: Object.freeze({ start: [-192, -90], end: [192, -50], width: 12, name: 'California Street' }),
    heightRange: Object.freeze([14, 48]),
    styles: Object.freeze(['masonry', 'villa', 'masonry', 'civic', 'villa', 'masonry']),
    palette: Object.freeze([0xcfc4ad, 0xb8ad99, 0x6e5a58, 0xe0d7c7]),
    accent: 0x5a4542,
    landmark: 'grace-cathedral',
    treeCadence: 7,
    signalEvery: 2,
    grade: 0.10,
  }),
  Object.freeze({
    key: '1:4',
    district: 'Russian Hill',
    tone: 'russian-hill',
    // Hyde · Larkin · Polk × Lombard switchback blocks.
    roadName: 'Hyde Street hill grid',
    roadLines: Object.freeze([-192, -132, -68, -4, 64, 128, 192]),
    heightRange: Object.freeze([10, 30]),
    styles: Object.freeze(['rowhouse', 'stucco', 'rowhouse', 'stucco', 'rowhouse', 'villa']),
    palette: Object.freeze([0xd8c3a8, 0xc7b0d0, 0x9eb6a8, 0xe8dcc8]),
    accent: 0x7a5a62,
    landmark: 'lombard-switchback',
    treeCadence: 8,
    signalEvery: 2,
    grade: HYDE_MEASURED_GRADE,
  }),
  Object.freeze({
    key: '0:5',
    district: 'Marina',
    tone: 'marina',
    // Fillmore · Steiner · Pierce × Chestnut/Lombard flats.
    roadName: 'Chestnut Street Marina grid',
    roadLines: Object.freeze([-192, -128, -64, 0, 64, 128, 192]),
    heightRange: Object.freeze([8, 22]),
    styles: Object.freeze(['stucco', 'stucco', 'rowhouse', 'stucco', 'rowhouse', 'stucco']),
    palette: Object.freeze([0xe8e2d6, 0xd6cfc0, 0xb8c4b8, 0xcfc8ba]),
    accent: 0x6a7a72,
    landmark: 'palace-of-fine-arts',
    treeCadence: 6,
    signalEvery: 2,
    grade: 0.008,
  }),
  Object.freeze({
    key: '3:0',
    district: 'Embarcadero',
    tone: 'embarcadero',
    // Compressed downtown: Sansome · Battery · Front · Embarcadero cadence (~48 m).
    roadName: 'Sansome–Battery–Front tower grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    heightRange: Object.freeze([28, 120]),
    styles: Object.freeze(['tower', 'podium', 'tower', 'podium', 'tower', 'masonry']),
    palette: Object.freeze([0x3e5b64, 0xb0a58f, 0x566e75, 0x657278]),
    accent: 0x273c43,
    landmark: 'transamerica-pyramid',
    treeCadence: 10,
    signalEvery: 1,
    grade: 0.01,
  }),
  Object.freeze({
    key: '2:-1',
    district: 'SoMa / Design District',
    tone: 'soma-design',
    // Wider SoMa warehouse blocks (historically ~550×825 ft) compressed to ~64 m.
    roadName: 'Townsend–Brannan warehouse grid',
    roadLines: Object.freeze([-192, -128, -64, 0, 64, 128, 192]),
    heightRange: Object.freeze([10, 48]),
    styles: Object.freeze(['warehouse', 'masonry', 'podium', 'warehouse', 'masonry', 'tower']),
    palette: Object.freeze([0x8c5c4a, 0x3a3a3c, 0xb0a8a0, 0x5a6570]),
    accent: 0x2a2a2c,
    landmark: 'sfmoma-design',
    treeCadence: 12,
    signalEvery: 2,
    grade: 0.012,
  }),
  Object.freeze({
    key: '-5:0',
    district: 'Golden Gate Park',
    tone: 'golden-gate-park',
    // Park cross-drives: Stanyan · 8th/Conservatory · Transverse · Chain of Lakes cadence.
    roadName: 'JFK Drive / Transverse park grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    heightRange: Object.freeze([4, 14]),
    styles: Object.freeze(['park', 'park', 'villa', 'park', 'park', 'villa']),
    palette: Object.freeze([0x5f8468, 0x798b80, 0xb7aa8f, 0xd5c8aa]),
    accent: 0x456354,
    landmark: 'ggp-meadow',
    treeCadence: 2,
    signalEvery: 3,
    grade: 0.02,
  }),
  Object.freeze({
    key: '-5:1',
    district: 'Richmond',
    tone: 'richmond',
    // Numbered avenues × Fulton/Geary/Clement/California/Balboa (~48 m blocks).
    roadName: 'Geary Boulevard Richmond avenue grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    heightRange: Object.freeze([5, 16]),
    styles: Object.freeze(['stucco', 'rowhouse', 'stucco', 'stucco', 'rowhouse', 'stucco']),
    palette: Object.freeze([0xcbb99a, 0xb49c8a, 0x8a8c82, 0xd6c7ab]),
    accent: 0x6f6a64,
    landmark: 'richmond-row',
    treeCadence: 5,
    signalEvery: 2,
    grade: 0.018,
  }),
  Object.freeze({
    key: '-4:-2',
    district: 'Inner Sunset',
    tone: 'inner-sunset',
    // 9th–19th Ave × Judah/Irving/Kirkham block grain with N Judah spine.
    roadName: 'Judah–Irving Inner Sunset grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    heightRange: Object.freeze([5, 16]),
    styles: Object.freeze(['stucco', 'rowhouse', 'stucco', 'rowhouse', 'stucco', 'stucco']),
    palette: Object.freeze([0xcbb99a, 0xb89176, 0x8a8c82, 0xd6c7ab]),
    accent: 0x6f6a64,
    landmark: 'inner-sunset-n-judah',
    treeCadence: 6,
    signalEvery: 2,
    grade: 0.04,
  }),
  Object.freeze({
    key: '-2:-2',
    district: 'Twin Peaks',
    tone: 'twin-peaks',
    // Ridge roads denser near overlook; park cells keep open mid-blocks.
    roadName: 'Twin Peaks Boulevard ridge grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    heightRange: Object.freeze([4, 14]),
    styles: Object.freeze(['villa', 'park', 'villa', 'park', 'villa', 'park']),
    palette: Object.freeze([0xb7aa8f, 0x798b80, 0xd5c8aa, 0x8e7869]),
    accent: 0x546b5e,
    landmark: 'twin-peaks-overlook',
    treeCadence: 3,
    signalEvery: 2,
    grade: 0.12,
  }),
  Object.freeze({
    key: '-3:-1',
    district: 'Haight-Ashbury',
    tone: 'haight',
    // Haight × Ashbury/Clayton/Cole/Masonic Victorian grid.
    roadName: 'Haight Street Victorian grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    diagonal: Object.freeze({ start: [-192, -40], end: [192, 40], width: 12, name: 'Haight Street' }),
    heightRange: Object.freeze([8, 22]),
    styles: Object.freeze(['rowhouse', 'stucco', 'rowhouse', 'rowhouse', 'stucco', 'rowhouse']),
    palette: Object.freeze([0xd8c3a8, 0xc7b0d0, 0x9eb6a8, 0xe8dcc8, 0xb48a5a]),
    accent: 0x7a5a62,
    landmark: 'haight-ashbury-strip',
    treeCadence: 7,
    signalEvery: 2,
    grade: 0.035,
  }),
  Object.freeze({
    key: '-1:-2',
    district: 'Castro / Noe Valley',
    tone: 'castro',
    // Castro · Market · 18th hill grid with Noe Valley steps.
    roadName: 'Castro Street hill grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    diagonal: Object.freeze({ start: [-192, -96], end: [192, 96], width: 14, name: 'Market Street Castro' }),
    heightRange: Object.freeze([8, 24]),
    styles: Object.freeze(['rowhouse', 'stucco', 'rowhouse', 'villa', 'rowhouse', 'stucco']),
    palette: Object.freeze([0xd8c3a8, 0xc7b0d0, 0xb89176, 0xe8dcc8]),
    accent: 0x8c4039,
    landmark: 'castro-theatre-row',
    treeCadence: 6,
    signalEvery: 2,
    grade: 0.08,
  }),
  Object.freeze({
    key: '-1:1',
    district: 'Western Addition / Fillmore',
    tone: 'fillmore',
    // Fillmore · Geary · Eddy mid-rise corridor blocks.
    roadName: 'Fillmore Street corridor grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    heightRange: Object.freeze([10, 36]),
    styles: Object.freeze(['masonry', 'podium', 'rowhouse', 'masonry', 'podium', 'stucco']),
    palette: Object.freeze([0xb0a58f, 0x6d7e82, 0xc0b49f, 0x9a6b5d]),
    accent: 0x5a4542,
    landmark: 'fillmore-plaza',
    treeCadence: 8,
    signalEvery: 2,
    grade: 0.025,
  }),
  Object.freeze({
    key: '-4:2',
    district: 'Laurel Heights',
    tone: 'laurel-heights',
    // California · Euclid · Arguello residential edge south of Presidio.
    roadName: 'California Street Laurel Heights grid',
    roadLines: Object.freeze([-192, -144, -96, -48, 0, 48, 96, 144, 192]),
    heightRange: Object.freeze([8, 22]),
    styles: Object.freeze(['villa', 'rowhouse', 'villa', 'stucco', 'villa', 'rowhouse']),
    palette: Object.freeze([0xb89176, 0xd5c3a5, 0x88747c, 0xe0d7c7]),
    accent: 0x6e4f4b,
    landmark: 'laurel-heights-ridge',
    treeCadence: 5,
    signalEvery: 2,
    grade: 0.06,
  }),
]);

const EXPANSION_BY_KEY = new Map(EXPANSION_SECTORS.map((sector) => [sector.key, sector]));

const AUTHORED_INTERIOR_ARCHETYPES = Object.freeze({
  'Civic Center / SoMa': Object.freeze(['civic-lobby', 'transit', 'library']),
  'Financial District': Object.freeze(['financial-office', 'civic-lobby', 'library']),
  'North Beach / Telegraph Hill': Object.freeze(['cafe', 'rowhouse', 'coit']),
  'Pacific Heights': Object.freeze(['library', 'rowhouse', 'sunset-home']),
  'Presidio Heights / Presidio': Object.freeze(['presidio-barracks', 'sunset-home', 'library']),
  'Mission District': Object.freeze(['mission-workshop', 'market', 'cafe']),
  'Mission Bay': Object.freeze(['wharf-chandlery', 'market', 'transit']),
  'Outer Sunset': Object.freeze(['sunset-home', 'outer-sunset-cafe']),
  Chinatown: Object.freeze(['cafe', 'market', 'rowhouse']),
  'Nob Hill': Object.freeze(['library', 'sunset-home', 'civic-lobby']),
  'Russian Hill': Object.freeze(['rowhouse', 'sunset-home', 'cafe']),
  Marina: Object.freeze(['sunset-home', 'cafe', 'transit']),
  Embarcadero: Object.freeze(['financial-office', 'civic-lobby', 'library']),
  'SoMa / Design District': Object.freeze(['market', 'mission-workshop', 'transit']),
  'Golden Gate Park': Object.freeze(['library', 'cafe', 'sunset-home']),
  Richmond: Object.freeze(['sunset-home', 'cafe', 'market']),
  'Inner Sunset': Object.freeze(['outer-sunset-cafe', 'sunset-home', 'transit']),
  'Twin Peaks': Object.freeze(['sunset-home', 'library', 'cafe']),
  'Haight-Ashbury': Object.freeze(['cafe', 'rowhouse', 'market']),
  'Castro / Noe Valley': Object.freeze(['cafe', 'rowhouse', 'sunset-home']),
  'Western Addition / Fillmore': Object.freeze(['market', 'civic-lobby', 'rowhouse']),
  'Laurel Heights': Object.freeze(['sunset-home', 'library', 'cafe']),
});

function authoredInteriorArchetypeFor(blueprint, plan) {
  const profile = AUTHORED_INTERIOR_ARCHETYPES[blueprint.district]
    || AUTHORED_INTERIOR_ARCHETYPES['Civic Center / SoMa'];
  const seed = seededUnit(plan.buildingIndex + 97, plan.buildingIndex + 11);
  const style = plan.style || 'masonry';
  if (blueprint.district === 'Civic Center / SoMa') {
    // Keep civic lobbies dominant while still exposing transit/library variety
    // for enterable volume coverage across the Market spine.
    return seed < 0.55 ? 'civic-lobby' : seed < 0.8 ? 'transit' : 'library';
  }
  if (blueprint.district === 'Outer Sunset') {
    return Math.floor(seed * 2) % 2 === 0 ? 'sunset-home' : 'outer-sunset-cafe';
  }
  if (blueprint.district === 'Financial District' && style === 'tower') {
    return Math.floor(seed * 2) % 2 === 0 ? 'financial-office' : 'civic-lobby';
  }
  if (blueprint.district === 'Mission District' && style === 'warehouse') {
    return 'mission-workshop';
  }
  if (blueprint.district === 'North Beach / Telegraph Hill' && style === 'tower') {
    return 'coit';
  }
  return profile[Math.floor(seed * profile.length) % profile.length];
}

function parseKey(key) {
  const [x, z] = String(key).split(':').map(Number);
  return { x, z };
}

function seededUnit(seed, index = 0) {
  let value = (seed + Math.imul(index + 1, 0x6d2b79f5)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function createSharedResources() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const tower = new THREE.CylinderGeometry(0.5, 0.62, 1, 6);
  const canopy = new THREE.ConeGeometry(0.58, 1, 6);
  const trunk = new THREE.CylinderGeometry(0.11, 0.14, 1, 6);
  const pole = new THREE.CylinderGeometry(0.035, 0.05, 1, 6);
  const window = new THREE.BoxGeometry(1, 1, 1);
  const facadePanel = new THREE.PlaneGeometry(1, 1, 2, 2);
  const loadFacadePhoto = (assetPath) => {
    // Node invariant scripts construct the shared scene without a DOM. Keep
    // their material graph deterministic while allowing the browser path to
    // load the public photographic skins normally.
    if (typeof document === 'undefined') return null;
    const texture = new THREE.TextureLoader().load(publicAsset(assetPath));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 8;
    return texture;
  };
  const loadWaterTexture = () => {
    // Keep Node invariant runs deterministic while the browser receives the
    // authored seamless bay-water texture. Keep the projected C3 shoreline
    // to roughly 2.5–3 oblique cycles across z (rather than the prior eight
    // horizontal runs) while preserving the same single texture draw.
    if (typeof document === 'undefined') return null;
    const texture = new THREE.TextureLoader().load(publicAsset('assets/sf-bay-water-generated-v3.png'));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2.4, 2.8);
    texture.offset.set(0.23, 0.17);
    texture.center.set(0.5, 0.5);
    texture.rotation = 0.82;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  };
  const waterTexture = loadWaterTexture();
  const makeFacadePhotoMaterial = (texture, color, offsetX, repeatX) => {
    const map = texture?.clone?.() ?? null;
    if (map) {
      map.offset.x = offsetX;
      map.repeat.x = repeatX;
      map.needsUpdate = true;
    }
    return new THREE.MeshStandardMaterial({
      ...(map ? { map, bumpMap: map, bumpScale: 0.055 } : {}),
      color,
      roughness: 0.84,
      metalness: 0.01,
      side: THREE.DoubleSide,
    });
  };
  const makeFacadePhotoVariants = (texture, color, repeatX = 0.22) => (
    [0.01, 0.255, 0.5, 0.745].map((offsetX) => (
      makeFacadePhotoMaterial(texture, color, offsetX, repeatX)
    ))
  );
  const edwardianFacade = loadFacadePhoto('assets/sf-edwardian-facade.png');
  const edwardianFacadeAlt = loadFacadePhoto('assets/sf-edwardian-facade-2.png');
  const facadePaintedLadyPhotos = makeFacadePhotoVariants(edwardianFacade, 0xe7d4c5);
  const facadeStuccoPhotos = makeFacadePhotoVariants(edwardianFacadeAlt, 0xd8c7b1);
  const facadeBrickPhotos = makeFacadePhotoVariants(edwardianFacadeAlt, 0xc18268);
  const facadePhotoMaterials = [facadePaintedLadyPhotos, facadeStuccoPhotos, facadeBrickPhotos];
  const facadePhotoBaseColors = facadePhotoMaterials.map((family) => (
    family.map((material) => material.color.clone())
  ));
  const facadeNightMaterials = [
    new THREE.MeshStandardMaterial({
      name: 'Embarcadero warm night pane amber',
      color: 0xf4a45d,
      emissive: 0xff702c,
      emissiveIntensity: 0,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.42,
    }),
    new THREE.MeshStandardMaterial({
      name: 'Embarcadero cool night pane mint',
      color: 0xd6e2d8,
      emissive: 0x9fc9c0,
      emissiveIntensity: 0,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.4,
    }),
    new THREE.MeshStandardMaterial({
      name: 'Embarcadero warm night pane copper',
      color: 0xd88752,
      emissive: 0xe75525,
      emissiveIntensity: 0,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.46,
    }),
    new THREE.MeshStandardMaterial({
      name: 'Embarcadero cool night pane blue',
      color: 0x8b9da6,
      emissive: 0x536e7d,
      emissiveIntensity: 0,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.48,
    }),
  ];
  // Hero landmarks own a separate pane pool. Keeping these out of the
  // district-wide facadeNight array prevents the C3 occupancy treatment from
  // changing Hyde or any other streamed facade family.
  const landmarkNightMaterials = [
    new THREE.MeshStandardMaterial({
      name: 'Embarcadero landmark warm pane amber',
      color: 0xf4a45d,
      emissive: 0xff702c,
      emissiveIntensity: 0,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.42,
    }),
    new THREE.MeshStandardMaterial({
      name: 'Embarcadero landmark cool pane mint',
      color: 0xd6e2d8,
      emissive: 0x9fc9c0,
      emissiveIntensity: 0,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.4,
    }),
    new THREE.MeshStandardMaterial({
      name: 'Embarcadero landmark warm pane copper',
      color: 0xd88752,
      emissive: 0xe75525,
      emissiveIntensity: 0,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.46,
    }),
    new THREE.MeshStandardMaterial({
      name: 'Embarcadero landmark cool pane blue',
      color: 0x8b9da6,
      emissive: 0x536e7d,
      emissiveIntensity: 0,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.48,
    }),
  ];
  const materials = {
    road: new THREE.MeshStandardMaterial({ color: 0x3d4546, roughness: 0.94, metalness: 0.02 }),
    sidewalk: new THREE.MeshStandardMaterial({ color: 0xb8b2a8, roughness: 0.92 }),
    curb: new THREE.MeshStandardMaterial({ color: 0x87837b, roughness: 0.88 }),
    marking: new THREE.MeshStandardMaterial({ color: 0xf1dfb5, roughness: 0.8 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xd9ae4c, roughness: 0.82 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x3b4648, roughness: 0.76 }),
    window: new THREE.MeshStandardMaterial({
      color: 0x36535c,
      roughness: 0.26,
      metalness: 0.22,
      emissive: 0x0d2227,
      emissiveIntensity: 0.3,
    }),
    door: new THREE.MeshStandardMaterial({ color: 0x623f39, roughness: 0.55 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xd3b782, roughness: 0.62 }),
    tree: new THREE.MeshStandardMaterial({ color: 0x667a68, roughness: 0.88 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x5a4633, roughness: 0.96 }),
    signalHousing: new THREE.MeshStandardMaterial({ color: 0x24292b, roughness: 0.72, metalness: 0.18 }),
    red: new THREE.MeshStandardMaterial({ color: 0x551d25, emissive: 0x9f283a, emissiveIntensity: 0.2 }),
    amber: new THREE.MeshStandardMaterial({ color: 0x5b4520, emissive: 0xb98322, emissiveIntensity: 0.12 }),
    green: new THREE.MeshStandardMaterial({ color: 0x1d4a35, emissive: 0x1fa162, emissiveIntensity: 0.12 }),
    water: new THREE.MeshStandardMaterial({ color: 0x2f7686, roughness: 0.3, metalness: 0.18 }),
    foam: new THREE.MeshStandardMaterial({ color: 0xe1e4d7, roughness: 0.82 }),
    boardwalk: new THREE.MeshStandardMaterial({ color: 0x8f684c, roughness: 0.9 }),
    sand: new THREE.MeshStandardMaterial({ color: 0xc4b18c, roughness: 0.96 }),
    sandLight: new THREE.MeshStandardMaterial({ color: 0xd7c5a4, roughness: 0.98 }),
    sandWet: new THREE.MeshStandardMaterial({ color: 0x9f927e, roughness: 0.84 }),
    oceanRock: new THREE.MeshStandardMaterial({ color: 0x48545a, roughness: 0.98 }),
    park: new THREE.MeshStandardMaterial({ color: 0x5f8468, roughness: 0.94 }),
    landmarkStone: new THREE.MeshStandardMaterial({ color: 0xc2b69d, roughness: 0.78 }),
    landmarkBrick: new THREE.MeshStandardMaterial({ color: 0x875044, roughness: 0.84 }),
    landmarkOrange: new THREE.MeshStandardMaterial({ color: 0xa34835, roughness: 0.68 }),
    // Embarcadero hero landmarks use an explicit dark/copper palette instead
    // of the shared pale stone/brick proxy colors.  These materials stay
    // pooled in the expansion resource set and are animated by the same
    // setNightLighting lifecycle as the landmark panes below.
    landmarkDarkPodium: new THREE.MeshStandardMaterial({
      name: 'Embarcadero landmark dark podium',
      color: 0x586a72,
      roughness: 0.64,
      metalness: 0.16,
      fog: false,
    }),
    transamericaBody: new THREE.MeshStandardMaterial({
      name: 'Transamerica Pyramid dark glazing body',
      color: 0x1e3542,
      roughness: 0.3,
      metalness: 0.42,
      emissive: 0x07151d,
      emissiveIntensity: 0.04,
      fog: false,
    }),
    transamericaAccent: new THREE.MeshStandardMaterial({
      name: 'Transamerica Pyramid copper structural fins',
      color: 0xb45138,
      roughness: 0.48,
      metalness: 0.2,
      emissive: 0x2a0f0a,
      emissiveIntensity: 0.03,
      fog: false,
    }),
    salesforceGlass: new THREE.MeshStandardMaterial({
      name: 'Salesforce Tower dark blue glazing',
      color: 0x164356,
      roughness: 0.24,
      metalness: 0.46,
      emissive: 0x06131b,
      emissiveIntensity: 0.04,
      fog: false,
    }),
    salesforceAccent: new THREE.MeshStandardMaterial({
      name: 'Salesforce Tower warm structural ribs',
      color: 0xc37a45,
      roughness: 0.46,
      metalness: 0.18,
      emissive: 0x2c1408,
      emissiveIntensity: 0.03,
      fog: false,
    }),
    salesforceCrown: new THREE.MeshStandardMaterial({
      name: 'Salesforce Tower dark stepped crown',
      color: 0x293c49,
      roughness: 0.34,
      metalness: 0.3,
      emissive: 0x081822,
      emissiveIntensity: 0.04,
      fog: false,
    }),
    salesforceCap: new THREE.MeshStandardMaterial({
      name: 'Salesforce Tower crown cap copper',
      color: 0xd0a363,
      roughness: 0.42,
      metalness: 0.22,
      emissive: 0x321c0b,
      emissiveIntensity: 0.03,
      fog: false,
    }),
    roof: new THREE.MeshStandardMaterial({ color: 0x3b4648, roughness: 0.76 }),
    entryHeader: new THREE.MeshStandardMaterial({
      color: 0xc17a4b,
      roughness: 0.56,
      emissive: 0x4d2519,
      emissiveIntensity: 0.2,
    }),
    // Shared photographic skins keep the Hyde modules in the same Edwardian
    // visual language as the rest of the city while leaving the pooled
    // low-poly cornices, bays, awnings, and storefronts visible.
    facadePaintedLadyPhotos,
    facadeStuccoPhotos,
    facadeBrickPhotos,
    facadeNight: facadeNightMaterials,
    landmarkNight: landmarkNightMaterials,
    shorelineReflection: new THREE.MeshBasicMaterial({
      name: 'Embarcadero dedicated water-coupled reflection ribbons',
      color: 0xffffff,
      vertexColors: true,
      side: THREE.FrontSide,
      fog: false,
      transparent: true,
      opacity: 0.74,
      blending: THREE.NormalBlending,
      depthTest: true,
      depthWrite: false,
    }),
    shorelineWaterField: new THREE.MeshBasicMaterial({
      name: 'Embarcadero saturated low-poly water field',
      ...(waterTexture ? { map: waterTexture } : {}),
      color: 0xffffff,
      vertexColors: true,
      side: THREE.FrontSide,
      // This bounded authored field must retain its vertex-color facets in
      // the waterfront vista; the surrounding scene still supplies fog.
      fog: false,
      transparent: false,
      opacity: 1,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    }),
  };
  return {
    box,
    tower,
    canopy,
    trunk,
    pole,
    window,
    facadePanel,
    facadePhotoMaterials,
    facadePhotoBaseColors,
    materials,
  };
}

function appendQuad(positions, colors, a, b, c, d, color) {
  positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  if (colors && color) {
    for (let i = 0; i < 6; i += 1) colors.push(color.r, color.g, color.b);
  }
}

// Surface strips are viewed from above in the waterfront evidence pose. Keep
// their shared material FrontSide and normalize the authored vertex winding
// here, rather than masking a back-facing field with DoubleSide/depth cheats.
function appendUpwardQuad(positions, colors, a, b, c, d, color) {
  const abx = b[0] - a[0];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acz = c[2] - a[2];
  const normalY = abz * acx - abx * acz;
  if (normalY < 0) {
    appendQuad(positions, colors, a, d, c, b, color);
  } else {
    appendQuad(positions, colors, a, b, c, d, color);
  }
}

function appendTexturedQuad(positions, colors, uvs, a, b, c, d, color, ua, ub, uc, ud) {
  positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  if (colors && color) {
    for (let i = 0; i < 6; i += 1) colors.push(color.r, color.g, color.b);
  }
  if (uvs) uvs.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud);
}

// Textured water uses the same winding guard as the untextured field. Keep
// the optional UV stream local to the bay mesh so every other surface helper
// stays on its existing pooled geometry path.
function appendUpwardTexturedQuad(positions, colors, uvs, a, b, c, d, color, ua, ub, uc, ud) {
  const normalY = (p0, p1, p2) => {
    const abx = p1[0] - p0[0];
    const abz = p1[2] - p0[2];
    const acx = p2[0] - p0[0];
    const acz = p2[2] - p0[2];
    return abz * acx - abx * acz;
  };
  // A strongly curved final water edge can make one diagonal of a quad fold
  // even when the other diagonal remains upward. Choose the best of the two
  // diagonals and both windings so every emitted triangle stays FrontSide.
  const candidates = [
    { points: [a, b, c, a, c, d], colors: [color, color, color, color, color, color], uvs: [ua, ub, uc, ua, uc, ud] },
    { points: [a, d, c, a, c, b], colors: [color, color, color, color, color, color], uvs: [ua, ud, uc, ua, uc, ub] },
    { points: [a, b, d, b, c, d], colors: [color, color, color, color, color, color], uvs: [ua, ub, ud, ub, uc, ud] },
    { points: [a, d, b, d, c, b], colors: [color, color, color, color, color, color], uvs: [ua, ud, ub, ud, uc, ub] },
  ];
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = Math.min(
      normalY(candidate.points[0], candidate.points[1], candidate.points[2]),
      normalY(candidate.points[3], candidate.points[4], candidate.points[5]),
    );
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
    if (score >= 0) break;
  }
  positions.push(...best.points.flat());
  if (colors) best.colors.forEach((entry) => colors.push(entry.r, entry.g, entry.b));
  if (uvs) best.uvs.forEach((entry) => uvs.push(...entry));
}

function appendGradientQuad(positions, colors, a, b, c, d, ca, cb, cc, cd) {
  positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  if (colors) {
    colors.push(
      ca.r, ca.g, ca.b,
      cb.r, cb.g, cb.b,
      cc.r, cc.g, cc.b,
      ca.r, ca.g, ca.b,
      cc.r, cc.g, cc.b,
      cd.r, cd.g, cd.b,
    );
  }
}

// Reflection bands use a tapered wall-to-water profile. Preserve FrontSide
// normals while carrying the warm/cool-to-muted gradient through both
// triangles, so the diagonal split never reads as a painted road mark.
function appendUpwardGradientQuad(positions, colors, a, b, c, d, ca, cb, cc, cd) {
  const abx = b[0] - a[0];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acz = c[2] - a[2];
  const normalY = abz * acx - abx * acz;
  if (normalY < 0) {
    appendGradientQuad(positions, colors, a, d, c, b, ca, cd, cc, cb);
  } else {
    appendGradientQuad(positions, colors, a, b, c, d, ca, cb, cc, cd);
  }
}

function addStrip(positions, colors, start, end, width, surfaceAt, offset, color, segmentLength = 24) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const length = Math.hypot(dx, dz) || 1;
  const nx = -dz / length;
  const nz = dx / length;
  const segments = Math.max(1, Math.ceil(length / segmentLength));
  for (let index = 0; index < segments; index += 1) {
    const t0 = index / segments;
    const t1 = (index + 1) / segments;
    const ax = start[0] + dx * t0;
    const az = start[1] + dz * t0;
    const bx = start[0] + dx * t1;
    const bz = start[1] + dz * t1;
    const half = width * 0.5;
    const p0 = [ax - nx * half, surfaceAt(ax - nx * half, az - nz * half) + offset, az - nz * half];
    const p1 = [ax + nx * half, surfaceAt(ax + nx * half, az + nz * half) + offset, az + nz * half];
    const p2 = [bx + nx * half, surfaceAt(bx + nx * half, bz + nz * half) + offset, bz + nz * half];
    const p3 = [bx - nx * half, surfaceAt(bx - nx * half, bz - nz * half) + offset, bz - nz * half];
    appendQuad(positions, colors, p0, p1, p2, p3, color);
  }
}

function createSurfaceMesh(name, positions, colors, material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors?.length) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.userData.noShadow = true;
  return mesh;
}

function setInstanceMatrix(mesh, index, position, scale, heading = 0) {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(
    THREE.Object3D.DEFAULT_UP,
    heading,
  );
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    quaternion,
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
  mesh.setMatrixAt(index, matrix);
}

function createInstancedMesh(geometry, material, capacity, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeSurfaceAt(descriptor, catalog) {
  const baseY = descriptor.elevation;
  return (x, z) => {
    const sampled = catalog.getSurfaceHeight({
      x: descriptor.center.x + x,
      z: descriptor.center.z + z,
    });
    const terrain = Number.isFinite(sampled) ? sampled - baseY : 0;
    // The catalog owns the continuous hill signature, tidal shelf, and seam
    // datum. Authored overlays must query that same surface as pooled roads.
    return terrain;
  };
}

function addRoadsAndPublicRealm(root, blueprint, surfaceAt, shared) {
  const roadPositions = [];
  const sidewalkPositions = [];
  const markingPositions = [];
  const markingColors = [];
  const roadLines = blueprint.roadLines;
  const roadColor = new THREE.Color(0x3d4546);
  const sidewalkColor = new THREE.Color(0xb8b2a8);
  const markingColor = new THREE.Color(0xf1dfb5);
  const yellowColor = new THREE.Color(0xd9ae4c);
  roadLines.forEach((line) => {
    addStrip(roadPositions, null, [line, -SECTOR_HALF], [line, SECTOR_HALF], ROAD_WIDTH, surfaceAt, SURFACE_OFFSET, roadColor);
    addStrip(roadPositions, null, [-SECTOR_HALF, line], [SECTOR_HALF, line], ROAD_WIDTH, surfaceAt, SURFACE_OFFSET, roadColor);
    addStrip(sidewalkPositions, null, [line - ROAD_WIDTH * 0.5 - SIDEWALK_WIDTH, -SECTOR_HALF], [line - ROAD_WIDTH * 0.5, SECTOR_HALF], SIDEWALK_WIDTH, surfaceAt, SURFACE_OFFSET + 0.015, sidewalkColor);
    addStrip(sidewalkPositions, null, [line + ROAD_WIDTH * 0.5, -SECTOR_HALF], [line + ROAD_WIDTH * 0.5 + SIDEWALK_WIDTH, SECTOR_HALF], SIDEWALK_WIDTH, surfaceAt, SURFACE_OFFSET + 0.015, sidewalkColor);
    addStrip(sidewalkPositions, null, [-SECTOR_HALF, line - ROAD_WIDTH * 0.5 - SIDEWALK_WIDTH], [SECTOR_HALF, line - ROAD_WIDTH * 0.5], SIDEWALK_WIDTH, surfaceAt, SURFACE_OFFSET + 0.015, sidewalkColor);
    addStrip(sidewalkPositions, null, [-SECTOR_HALF, line + ROAD_WIDTH * 0.5], [SECTOR_HALF, line + ROAD_WIDTH * 0.5 + SIDEWALK_WIDTH], SIDEWALK_WIDTH, surfaceAt, SURFACE_OFFSET + 0.015, sidewalkColor);
    for (let along = -SECTOR_HALF + 10; along < SECTOR_HALF - 4; along += 10) {
      const dash = 3.2;
      addStrip(markingPositions, markingColors, [line - 0.12, along], [line - 0.12, along + dash], 0.14, surfaceAt, ROAD_MARKING_OFFSET, yellowColor, dash);
      addStrip(markingPositions, markingColors, [along, line - 0.12], [along + dash, line - 0.12], 0.14, surfaceAt, ROAD_MARKING_OFFSET, yellowColor, dash);
    }
  });
  if (blueprint.diagonal) {
    const { start, end, width } = blueprint.diagonal;
    addStrip(roadPositions, null, start, end, width, surfaceAt, SURFACE_OFFSET, roadColor);
    addStrip(sidewalkPositions, null, start, end, width * 0.28, surfaceAt, SURFACE_OFFSET + 0.015, sidewalkColor);
    addStrip(markingPositions, markingColors, start, end, 0.16, surfaceAt, ROAD_MARKING_OFFSET, markingColor, 8);
  }
  root.add(
    createSurfaceMesh('Authored expansion road mesh', roadPositions, null, shared.materials.road),
    createSurfaceMesh('Authored expansion sidewalk mesh', sidewalkPositions, null, shared.materials.sidewalk),
    createSurfaceMesh('Authored expansion lane and crosswalk markings', markingPositions, markingColors, shared.materials.marking),
  );

  const curbPositions = [];
  const curbColors = [];
  roadLines.forEach((line) => {
    addStrip(curbPositions, curbColors, [line - ROAD_WIDTH * 0.5 - 0.18, -SECTOR_HALF], [line - ROAD_WIDTH * 0.5 - 0.18, SECTOR_HALF], 0.18, surfaceAt, SURFACE_OFFSET + 0.09, new THREE.Color(0x87837b));
    addStrip(curbPositions, curbColors, [line + ROAD_WIDTH * 0.5 + 0.18, -SECTOR_HALF], [line + ROAD_WIDTH * 0.5 + 0.18, SECTOR_HALF], 0.18, surfaceAt, SURFACE_OFFSET + 0.09, new THREE.Color(0x87837b));
    addStrip(curbPositions, curbColors, [-SECTOR_HALF, line - ROAD_WIDTH * 0.5 - 0.18], [SECTOR_HALF, line - ROAD_WIDTH * 0.5 - 0.18], 0.18, surfaceAt, SURFACE_OFFSET + 0.09, new THREE.Color(0x87837b));
    addStrip(curbPositions, curbColors, [-SECTOR_HALF, line + ROAD_WIDTH * 0.5 + 0.18], [SECTOR_HALF, line + ROAD_WIDTH * 0.5 + 0.18], 0.18, surfaceAt, SURFACE_OFFSET + 0.09, new THREE.Color(0x87837b));
  });
  root.add(createSurfaceMesh('Authored expansion curb mesh', curbPositions, curbColors, shared.materials.curb));
}

function chooseStyle(blueprint, row, column, seed) {
  const index = (row * 5 + column * 3 + Math.floor(seed * 7)) % blueprint.styles.length;
  return blueprint.styles[index];
}

function createBuildingPlan(descriptor, blueprint, catalog) {
  const surfaceAt = makeSurfaceAt(descriptor, catalog);
  const lines = blueprint.roadLines;
  const plans = [];
  let buildingIndex = 0;
  for (let row = 0; row < lines.length - 1; row += 1) {
    for (let column = 0; column < lines.length - 1; column += 1) {
      const x0 = lines[column] + ROAD_WIDTH * 0.5 + SIDEWALK_WIDTH + 4;
      const x1 = lines[column + 1] - ROAD_WIDTH * 0.5 - SIDEWALK_WIDTH - 4;
      const z0 = lines[row] + ROAD_WIDTH * 0.5 + SIDEWALK_WIDTH + 4;
      const z1 = lines[row + 1] - ROAD_WIDTH * 0.5 - SIDEWALK_WIDTH - 4;
      if (x1 - x0 < 10 || z1 - z0 < 10) continue;
      const xJitter = (seededUnit(descriptor.seed, buildingIndex + 11) - 0.5) * Math.min(4, (x1 - x0) * 0.16);
      const zJitter = (seededUnit(descriptor.seed, buildingIndex + 37) - 0.5) * Math.min(4, (z1 - z0) * 0.16);
      const x = (x0 + x1) * 0.5 + xJitter;
      const z = (z0 + z1) * 0.5 + zJitter;
      const style = chooseStyle(blueprint, row, column, seededUnit(descriptor.seed, buildingIndex + 1));
      const width = Math.max(8, (x1 - x0) * (style === 'rowhouse' ? 0.78 : 0.84));
      const depth = Math.max(8, (z1 - z0) * (style === 'rowhouse' ? 0.78 : 0.84));
      const heightT = seededUnit(descriptor.seed, buildingIndex + 71);
      let height = THREE.MathUtils.lerp(blueprint.heightRange[0], blueprint.heightRange[1], heightT);
      if (style === 'rowhouse' || style === 'villa' || style === 'stucco') height = Math.min(height, blueprint.heightRange[0] + 20);
      if (style === 'tower') height = Math.max(height, blueprint.heightRange[0] + 30);
      if (style === 'park') continue;
      const heading = (row + column) % 2 === 0 ? 0 : Math.PI * 0.5;
      const baseY = surfaceAt(x, z);
      plans.push({
        id: `${descriptor.key}:authored-building:${buildingIndex}`,
        buildingIndex,
        x,
        z,
        width,
        depth,
        height,
        style,
        heading,
        baseY,
        floors: Math.max(1, Math.floor(height / (style === 'tower' ? 3.8 : 3.1))),
        label: `${blueprint.district} ${String(buildingIndex + 1).padStart(2, '0')}`,
      });
      buildingIndex += 1;
      if (plans.length >= MAX_DETAIL_BUILDINGS) return { plans, surfaceAt };
    }
  }
  return { plans, surfaceAt };
}

function addInstancedBuildings(detail, buildingPlans, blueprint, shared, surfaceAt) {
  // Keep the authored plan authoritative for footprints, entrances, and
  // district metadata, but isolate its old opaque mass pass. The pooled
  // renderer already supplies the visible facade treatment; submitting both
  // passes creates blank near-camera slabs and doubles the building walls.
  const authoredMassing = new THREE.Group();
  authoredMassing.name = 'Authored building plans (metadata-only render proxy)';
  authoredMassing.visible = false;
  const renderAuthoredMassing = false;
  const styleGeometry = {
    rowhouse: shared.box,
    masonry: shared.box,
    civic: shared.box,
    stucco: shared.box,
    villa: shared.box,
    warehouse: shared.box,
    podium: shared.box,
    tower: shared.tower,
  };
  const massMeshes = new Map();
  const entryMarkers = new THREE.Group();
  entryMarkers.name = 'Authored enterable doorway markers';
  const entryDoors = createInstancedMesh(
    shared.box,
    shared.materials.door,
    MAX_DETAIL_BUILDINGS,
    'Authored enterable doors',
  );
  const entryHeaders = createInstancedMesh(
    shared.box,
    shared.materials.entryHeader,
    MAX_DETAIL_BUILDINGS,
    'Authored doorway sign bands',
  );
  const entryLights = createInstancedMesh(
    shared.box,
    shared.materials.landmarkOrange,
    MAX_DETAIL_BUILDINGS,
    'Authored doorway lights',
  );
  entryDoors.castShadow = false;
  entryDoors.receiveShadow = false;
  entryHeaders.castShadow = false;
  entryHeaders.receiveShadow = false;
  entryLights.castShadow = false;
  entryLights.receiveShadow = false;
  entryMarkers.add(entryDoors, entryHeaders, entryLights);
  const roof = renderAuthoredMassing
    ? createInstancedMesh(shared.box, shared.materials.roof, MAX_DETAIL_BUILDINGS, 'Expansion building roof planes')
    : null;
  // Expansion massing used to spend its entire window budget on the street
  // frontage. That left the side faces of tall Pacific Heights and Mission
  // Bay blocks reading as blank color slabs from a cross street. Keep one
  // shared instanced draw, but reserve enough fixed slots for a restrained
  // front/side/rear rhythm on every authored building.
  const windowCapacity = MAX_DETAIL_BUILDINGS * 96;
  const windows = renderAuthoredMassing
    ? createInstancedMesh(shared.window, shared.materials.window, windowCapacity, 'Expansion facade window bands')
    : null;
  const doors = renderAuthoredMassing
    ? createInstancedMesh(shared.box, shared.materials.door, MAX_DETAIL_BUILDINGS, 'Expansion enterable doorway shells')
    : null;
  const trims = renderAuthoredMassing
    ? createInstancedMesh(shared.box, shared.materials.trim, MAX_DETAIL_BUILDINGS * 8, 'Expansion facade trim accents')
    : null;
  const windowColor = new THREE.Color(0x36535c);
  const doorColor = new THREE.Color(0x623f39);
  const trimColor = new THREE.Color(0xd3b782);
  const buildingVolumes = [];
  const volumePlan = [];

  buildingPlans.forEach((plan) => {
    if (renderAuthoredMassing) {
      if (!massMeshes.has(plan.style)) {
        const stylePaletteIndex = Math.max(0, Object.keys(styleGeometry).indexOf(plan.style));
        const styleColor = blueprint.palette[stylePaletteIndex % blueprint.palette.length];
        const mesh = createInstancedMesh(
          styleGeometry[plan.style] || shared.box,
          new THREE.MeshBasicMaterial({
            color: styleColor,
            fog: true,
          }),
          MAX_DETAIL_BUILDINGS,
          `Expansion ${plan.style} building massing`,
        );
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        massMeshes.set(plan.style, mesh);
        authoredMassing.add(mesh);
      }
      const mass = massMeshes.get(plan.style);
      const massIndex = mass.count;
      const massY = plan.baseY + plan.height * 0.5;
      setInstanceMatrix(mass, massIndex, [plan.x, massY, plan.z], [plan.width, plan.height, plan.depth], plan.heading);
      mass.count += 1;

      const roofIndex = roof.count;
      setInstanceMatrix(roof, roofIndex, [plan.x, plan.baseY + plan.height + 0.18, plan.z], [plan.width * 1.03, 0.26, plan.depth * 1.03], plan.heading);
      roof.count += 1;
    }

    const front = new THREE.Vector2(0, -1).rotateAround(new THREE.Vector2(), plan.heading);
    const tangent = new THREE.Vector2(1, 0).rotateAround(new THREE.Vector2(), plan.heading);
    const floorCount = Math.min(8, Math.max(2, plan.floors));
    const columnCount = Math.min(4, Math.max(2, Math.floor(plan.width / 7)));
    const addWindow = (position, scale, heading = plan.heading) => {
      if (!windows || windows.count >= windowCapacity) return;
      setInstanceMatrix(windows, windows.count, position, scale, heading);
      windows.count += 1;
    };
    const addTrim = (position, scale, heading = plan.heading) => {
      if (!trims || trims.count >= trims.instanceMatrix.count) return;
      setInstanceMatrix(trims, trims.count, position, scale, heading);
      trims.count += 1;
    };
    for (let floor = 0; floor < floorCount; floor += 1) {
      const y = plan.baseY + 2.4 + floor * (plan.height / (floorCount + 0.3));
      if (y > plan.baseY + plan.height - 1.1) continue;
      for (let column = 0; column < columnCount; column += 1) {
        const across = columnCount === 1 ? 0 : (column / (columnCount - 1) - 0.5) * plan.width * 0.68;
        const px = plan.x + tangent.x * across + front.x * (plan.depth * 0.5 + 0.035);
        const pz = plan.z + tangent.y * across + front.y * (plan.depth * 0.5 + 0.035);
        addWindow(
          [px, y, pz],
          [Math.max(0.8, plan.width / (columnCount * 2.6)), 0.86, 0.07],
        );
      }
    }

    const sideFloorCount = Math.min(6, floorCount);
    const sideColumnCount = Math.min(2, Math.max(1, Math.floor(plan.depth / 9)));
    for (let floor = 0; floor < sideFloorCount; floor += 1) {
      const y = plan.baseY + 2.4 + floor * (plan.height / (sideFloorCount + 0.3));
      if (y > plan.baseY + plan.height - 1.1) continue;
      for (let column = 0; column < sideColumnCount; column += 1) {
        const along = sideColumnCount === 1
          ? 0
          : (column / (sideColumnCount - 1) - 0.5) * plan.depth * 0.62;
        const sideWidth = Math.max(0.82, plan.depth / (sideColumnCount * 2.55));
        const leftX = plan.x - tangent.x * (plan.width * 0.5 + 0.035) + front.x * along;
        const leftZ = plan.z - tangent.y * (plan.width * 0.5 + 0.035) + front.y * along;
        const rightX = plan.x + tangent.x * (plan.width * 0.5 + 0.035) + front.x * along;
        const rightZ = plan.z + tangent.y * (plan.width * 0.5 + 0.035) + front.y * along;
        addWindow([leftX, y, leftZ], [0.07, 0.86, sideWidth], plan.heading - Math.PI * 0.5);
        addWindow([rightX, y, rightZ], [0.07, 0.86, sideWidth], plan.heading + Math.PI * 0.5);
      }
    }
    for (let floor = 0; floor < sideFloorCount; floor += 1) {
      const y = plan.baseY + 2.4 + floor * (plan.height / (sideFloorCount + 0.3));
      if (y > plan.baseY + plan.height - 1.1) continue;
      for (let column = 0; column < columnCount; column += 1) {
        const across = columnCount === 1 ? 0 : (column / (columnCount - 1) - 0.5) * plan.width * 0.68;
        const backX = plan.x - front.x * (plan.depth * 0.5 + 0.035) + tangent.x * across;
        const backZ = plan.z - front.y * (plan.depth * 0.5 + 0.035) + tangent.y * across;
        addWindow(
          [backX, y, backZ],
          [Math.max(0.8, plan.width / (columnCount * 2.6)), 0.86, 0.07],
          plan.heading,
        );
      }
    }
    // Keep the marker just proud of the pooled facade. The authored massing
    // is metadata-only, and the pooled facade plane can sit about a metre
    // beyond the authored footprint; this exterior offset prevents the entry
    // cue from disappearing into that generated shell while preserving the
    // same world-space point used by portal discovery and return paths.
    const doorX = plan.x + front.x * (plan.depth * 0.5 + 1.45);
    const doorZ = plan.z + front.y * (plan.depth * 0.5 + 1.45);
    setInstanceMatrix(
      entryDoors,
      entryDoors.count,
      [doorX, plan.baseY + 1.1, doorZ],
      [1.35, 2.3, 0.2],
      plan.heading,
    );
    setInstanceMatrix(
      entryHeaders,
      entryHeaders.count,
      [doorX, plan.baseY + 3.34, doorZ - front.y * 0.02],
      [2.08, 0.22, 0.28],
      plan.heading,
    );
    setInstanceMatrix(
      entryLights,
      entryLights.count,
      [doorX, plan.baseY + 3.68, doorZ - front.y * 0.06],
      [0.2, 0.12, 0.12],
      plan.heading,
    );
    entryDoors.count += 1;
    entryHeaders.count += 1;
    entryLights.count += 1;
    if (doors) {
      const doorIndex = doors.count;
      setInstanceMatrix(doors, doorIndex, [doorX, plan.baseY + 1.1, doorZ], [1.25, 2.2, 0.15], plan.heading);
      doors.count += 1;
    }
    addTrim([doorX, plan.baseY + 2.33, doorZ - front.y * 0.01], [1.58, 0.12, 0.22]);
    addTrim([doorX, plan.baseY + 0.06, doorZ], [1.55, 0.1, 0.55]);

    // A small, shared architectural-detail budget gives low-poly villas and
    // rowhouses a readable bay-and-cornice rhythm instead of a flat colored
    // slab. These are shallow silhouette cues, not a second facade system.
    const facadeStyle = plan.style === 'villa' || plan.style === 'rowhouse';
    if (facadeStyle) {
      const bayFloors = Math.min(3, floorCount);
      const bayColumns = Math.min(3, columnCount);
      for (let floor = 0; floor < bayFloors; floor += 1) {
        const y = plan.baseY + 1.55 + floor * (plan.height / (floorCount + 0.3));
        for (let column = 0; column < bayColumns; column += 1) {
          const across = bayColumns === 1
            ? 0
            : (column / (bayColumns - 1) - 0.5) * plan.width * 0.58;
          const px = plan.x + tangent.x * across + front.x * (plan.depth * 0.5 + 0.18);
          const pz = plan.z + tangent.y * across + front.y * (plan.depth * 0.5 + 0.18);
          addTrim(
            [px, y, pz],
            [Math.max(1.05, plan.width / (bayColumns * 2.2)), 0.12, 0.34],
          );
        }
      }
    }
    addTrim(
      [plan.x, plan.baseY + plan.height - 0.18, plan.z],
      [plan.width * 0.94, 0.18, 0.18],
    );
    addTrim(
      [plan.x, plan.baseY + 0.12, plan.z],
      [plan.width * 0.92, 0.14, plan.depth * 0.92],
    );

    const halfX = Math.abs(Math.cos(plan.heading)) * plan.width * 0.5 + Math.abs(Math.sin(plan.heading)) * plan.depth * 0.5;
    const halfZ = Math.abs(Math.sin(plan.heading)) * plan.width * 0.5 + Math.abs(Math.cos(plan.heading)) * plan.depth * 0.5;
    const interiorArchetype = authoredInteriorArchetypeFor(blueprint, plan);
    const volume = Object.freeze({
      id: plan.id,
      buildingIndex: plan.buildingIndex,
      sectorKey: plan.id.split(':authored-building:')[0],
      district: blueprint.district,
      quality: 'detail',
      architecturalFaces: 4,
      facadeAtlasCell: plan.buildingIndex % 4,
      geometryStyle: plan.style,
      frontageYaw: plan.heading,
      storefrontBand: true,
      floors: plan.floors,
      rooms: Object.freeze(Array.from({ length: Math.min(4, plan.floors) }, (_, floor) => ({
        id: `${plan.id}:room:${floor + 1}`,
        floor: floor + 1,
        state: 'district-archetype-room',
        walkable: true,
        archetype: interiorArchetype,
      }))),
      interiorState: 'district-archetype-room',
      interiorArchetype,
      collisionMode: 'aabb-shell',
      doorMesh: true,
      signposted: true,
      entrance: Object.freeze({
        x: doorX,
        y: plan.baseY + 0.8,
        z: doorZ,
        normalX: front.x,
        normalZ: front.y,
        returnPath: Object.freeze([
          Object.freeze({ x: doorX + front.x * 3.6, y: plan.baseY + 0.8, z: doorZ + front.y * 3.6 }),
          Object.freeze({ x: doorX + front.x * 8, y: plan.baseY + 0.8, z: doorZ + front.y * 8 }),
        ]),
      }),
      center: Object.freeze({ x: plan.x, y: plan.baseY + plan.height * 0.5, z: plan.z }),
      min: Object.freeze({ x: plan.x - halfX, y: plan.baseY, z: plan.z - halfZ }),
      max: Object.freeze({ x: plan.x + halfX, y: plan.baseY + plan.height, z: plan.z + halfZ }),
      label: plan.label,
    });
    buildingVolumes.push(volume);
    volumePlan.push(plan);
  });

  [roof, windows, doors, trims].filter(Boolean).forEach((mesh) => {
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    authoredMassing.add(mesh);
  });
  [entryDoors, entryHeaders, entryLights].forEach((mesh) => {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  });
  entryMarkers.userData.markerCount = entryDoors.count;
  detail.add(authoredMassing, entryMarkers);
  void windowColor;
  void doorColor;
  void trimColor;
  return {
    buildingVolumes,
    volumePlan,
    massMeshes,
    trimCount: trims?.count ?? 0,
    entryMarkerCount: entryDoors.count,
    renderGroup: authoredMassing,
  };
}

function translateAuthoredVolumeToWorld(volume, descriptor) {
  const translatePoint = (point) => Object.freeze({
    ...point,
    x: point.x + descriptor.center.x,
    y: point.y + descriptor.elevation,
    z: point.z + descriptor.center.z,
  });
  const entrance = volume.entrance
    ? Object.freeze({
      ...volume.entrance,
      ...translatePoint(volume.entrance),
      returnPath: Object.freeze(
        (volume.entrance.returnPath || []).map(translatePoint),
      ),
    })
    : null;
  return Object.freeze({
    ...volume,
    coordinateSpace: 'world',
    source: volume.source || 'authored-expansion',
    entryTrigger: volume.entryTrigger ? translatePoint(volume.entryTrigger) : null,
    entrance,
    center: volume.center ? translatePoint(volume.center) : null,
    min: volume.min ? translatePoint(volume.min) : null,
    max: volume.max ? translatePoint(volume.max) : null,
  });
}

function addDistrictPlaceCues(signature, blueprint, shared, surfaceAt) {
  let propCount = 0;
  const bump = () => { propCount += 1; };
  const addBox = (name, x, z, scale, material, baseOffset = 0, rotationY = 0) => {
    const baseY = surfaceAt(x, z);
    const mesh = new THREE.Mesh(shared.box, material);
    mesh.name = name;
    mesh.position.set(x, baseY + baseOffset + scale[1] * 0.5, z);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.rotation.y = rotationY;
    signature.add(mesh);
    bump();
    return mesh;
  };
  const addWindow = (name, x, y, z, scale) => {
    const mesh = new THREE.Mesh(shared.window, shared.materials.window);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    signature.add(mesh);
    bump();
    return mesh;
  };
  const addFinishedFrontage = (
    prefix,
    x,
    z,
    width,
    depth,
    height,
    bodyMaterial,
    roofMaterial = shared.materials.roof,
  ) => {
    const baseY = surfaceAt(x, z);
    addBox(`${prefix} plinth`, x, z, [width, 0.62, depth], shared.materials.landmarkStone);
    addBox(`${prefix} body`, x, z, [width * 0.96, height, depth * 0.92], bodyMaterial, 0.62);
    addBox(
      `${prefix} roof cap`,
      x,
      z,
      [width * 1.05, 0.42, depth * 1.04],
      roofMaterial,
      height + 0.62,
    );
    const columnCount = Math.max(2, Math.floor(width / 5.2));
    for (let column = 0; column < columnCount; column += 1) {
      const across = columnCount === 1
        ? 0
        : (column / (columnCount - 1) - 0.5) * width * 0.72;
      for (const [floorIndex, heightT] of [[0, 0.34], [1, 0.58]]) {
        addWindow(
          `${prefix} front window ${column}-${floorIndex}`,
          x + across,
          baseY + height * heightT,
          z - depth * 0.5 - 0.07,
          [Math.min(2.4, width / columnCount * 0.62), 1.05, 0.09],
        );
      }
    }
    for (const side of [-1, 1]) {
      for (let row = 0; row < 2; row += 1) {
        addWindow(
          `${prefix} side window ${side}-${row}`,
          x + side * (width * 0.5 + 0.07),
          baseY + height * (0.32 + row * 0.24),
          z,
          [0.09, 0.95, depth * 0.26],
        );
      }
    }
    addBox(
      `${prefix} grounded entrance`,
      x,
      z,
      [1.65, 2.35, 0.2],
      shared.materials.door,
      0.62,
    );
    const entrance = signature.children[signature.children.length - 1];
    entrance.position.z -= depth * 0.5 + 0.14;
    addBox(
      `${prefix} entrance header`,
      x,
      z,
      [2.05, 0.22, 0.24],
      shared.materials.entryHeader,
      3.18,
    );
    const header = signature.children[signature.children.length - 1];
    header.position.z -= depth * 0.5 + 0.16;
    addBox(
      `${prefix} entrance light`,
      x + width * 0.18,
      z,
      [0.18, 0.14, 0.14],
      shared.materials.landmarkOrange,
      3.42,
    );
    const light = signature.children[signature.children.length - 1];
    light.position.z -= depth * 0.5 + 0.18;
  };
  const addAwning = (name, x, z, width, colorMaterial = shared.materials.landmarkOrange) => {
    addBox(name, x, z, [width, 0.14, 1.35], colorMaterial, 2.95);
    addBox(`${name} valance`, x, z - 0.72, [width * 0.96, 0.08, 0.12], shared.materials.trim, 3.02);
  };
  const addCafeTable = (name, x, z) => {
    addBox(`${name} top`, x, z, [0.82, 0.07, 0.82], shared.materials.trim, 0.72);
    for (const [dx, dz] of [[-0.34, -0.34], [0.34, -0.34], [0.34, 0.34], [-0.34, 0.34]]) {
      addBox(`${name} leg`, x + dx, z + dz, [0.07, 0.72, 0.07], shared.materials.signalHousing);
    }
  };
  const addCypress = (name, x, z, scale = 1) => {
    const baseY = surfaceAt(x, z);
    const trunk = new THREE.Mesh(shared.trunk, shared.materials.trunk);
    trunk.name = `${name} trunk`;
    trunk.position.set(x, baseY + 2.2 * scale, z);
    trunk.scale.set(0.36 * scale, 4.4 * scale, 0.36 * scale);
    const canopy = new THREE.Mesh(shared.canopy, shared.materials.tree);
    canopy.name = `${name} canopy`;
    canopy.position.set(x, baseY + 6.2 * scale, z);
    canopy.scale.set(1.55 * scale, 4.1 * scale, 1.55 * scale);
    signature.add(trunk, canopy);
    propCount += 2;
  };

  if (blueprint.landmark === 'civic-spine') {
    addFinishedFrontage(
      'Civic Center Beaux-Arts hero hall',
      -36,
      -56,
      28,
      18,
      16,
      shared.materials.landmarkStone,
    );
    [-48, -36, -24].forEach((columnX, index) => {
      const column = new THREE.Mesh(shared.pole, shared.materials.landmarkStone);
      column.name = `Civic Center plaza column ${index + 1}`;
      column.position.set(columnX, surfaceAt(columnX, -62) + 5.5, -62);
      column.scale.set(0.55, 11, 0.55);
      signature.add(column);
      bump();
    });
    addBox('Civic Center plaza step terrace', -36, -66, [30, 0.48, 7], shared.materials.sidewalk);
    addBox('Civic Center plaza step riser', -36, -69, [30, 0.32, 1.2], shared.materials.landmarkStone, 0.48);
    addBox('Civic Center Muni shelter roof', -68, -52, [5.6, 0.22, 2.8], shared.materials.landmarkOrange, 3.05);
    addBox('Civic Center Muni shelter wall', -68, -52, [5.2, 2.6, 0.22], shared.materials.landmarkStone, 0.55);
    addBox('Civic Center Muni shelter bench', -68, -50.2, [4.2, 0.42, 0.72], shared.materials.trim, 0.55);
    addBox('Civic Center civic banner pole', -52, -48, [0.16, 7.2, 0.16], shared.materials.signalHousing);
    addBox('Civic Center civic banner', -50.4, -48, [2.8, 1.4, 0.08], shared.materials.landmarkOrange, 6.4);
  } else if (blueprint.landmark === 'skyline') {
    addFinishedFrontage(
      'Financial District canyon west wing',
      -34,
      36,
      24,
      18,
      48,
      shared.materials.window,
    );
    addFinishedFrontage(
      'Financial District canyon east wing',
      34,
      36,
      24,
      18,
      44,
      shared.materials.window,
    );
    addBox('Financial District plaza pocket', 0, 24, [16, 0.28, 12], shared.materials.sidewalk);
    addBox('Financial District plaza sculpture plinth', 0, 24, [2.4, 1.1, 2.4], shared.materials.landmarkStone, 0.28);
    addBox('Financial District plaza sculpture mass', 0, 24, [1.4, 2.8, 1.4], shared.materials.trim, 1.38);
    addBox('Financial District street planter west', -14, 52, [3.2, 0.72, 1.4], shared.materials.park);
    addBox('Financial District street planter east', 14, 52, [3.2, 0.72, 1.4], shared.materials.park);
    addBox('Financial District pocket bench', 0, 28, [3.6, 0.42, 0.72], shared.materials.trim, 0.28);
  } else if (blueprint.landmark === 'coit-tower') {
    // Roof must stay slate/stucco — landmarkOrange roof caps read as a scarlet
    // L-mass in the 4:4 hero frustum (pass12b critic hard blocker).
    addFinishedFrontage(
      'North Beach cafe rowhouse',
      42,
      -28,
      20,
      14,
      12,
      shared.materials.landmarkBrick,
      shared.materials.roof,
    );
    addFinishedFrontage(
      'North Beach Columbus italianate shoulder',
      -48,
      36,
      18,
      12,
      13,
      shared.materials.landmarkStone,
      shared.materials.roof,
    );
    addFinishedFrontage(
      'North Beach uphill stucco row',
      12,
      28,
      16,
      11,
      11,
      shared.materials.landmarkStone,
      shared.materials.roof,
    );
    addAwning('North Beach striped cafe awning west', 36, -28, 5.2);
    addAwning('North Beach striped cafe awning east', 48, -28, 5.2);
    addCafeTable('North Beach sidewalk cafe table 1', 38, -14);
    addCafeTable('North Beach sidewalk cafe table 2', 44, -12);
    addBox('North Beach cafe chair 1', 37.2, -13.2, [0.42, 0.72, 0.42], shared.materials.signalHousing, 0.55);
    addBox('North Beach cafe chair 2', 45.2, -11.2, [0.42, 0.72, 0.42], shared.materials.signalHousing, 0.55);
    addBox('North Beach projecting CAFE sign', 42, -28, [3.2, 0.62, 0.12], shared.materials.landmarkOrange, 4.1);
    addBox('North Beach cafe menu board', 48.8, -26, [0.72, 1.45, 0.12], shared.materials.trim, 0.55);
    addBox('North Beach Italianate lamp post', 30, -16, [0.14, 5.4, 0.14], shared.materials.signalHousing);
    addBox('North Beach Italianate lamp head', 30, -16, [0.52, 0.22, 0.52], shared.materials.landmarkOrange, 5.4);
  } else if (blueprint.landmark === 'hill-villas') {
    addFinishedFrontage(
      'Pacific Heights painted-lady frontage',
      24,
      -24,
      22,
      15,
      14,
      shared.materials.landmarkStone,
      shared.materials.landmarkOrange,
    );
    addBox('Pacific Heights bay window bay 1', 18, -24, [2.2, 1.2, 0.42], shared.materials.window, 2.4);
    addBox('Pacific Heights bay window bay 2', 24, -24, [2.2, 1.2, 0.42], shared.materials.window, 2.4);
    addBox('Pacific Heights bay window bay 3', 30, -24, [2.2, 1.2, 0.42], shared.materials.window, 2.4);
    addBox('Pacific Heights residential stoop', 14, 12, [4.2, 0.32, 2.4], shared.materials.landmarkOrange, 0.55);
    addBox('Pacific Heights hill terrace step', -18, 34, [12, 0.42, 2.2], shared.materials.sidewalk);
    addBox('Pacific Heights hill terrace riser', -18, 32, [12, 0.38, 1.1], shared.materials.landmarkStone, 0.42);
    addCypress('Pacific Heights mature street cypress', -12, 18, 0.88);
    addCypress('Pacific Heights mature street cypress 2', 8, 22, 0.82);
  } else if (blueprint.landmark === 'presidio-gate') {
    addFinishedFrontage(
      'Presidio barracks edge quarters',
      -38,
      -14,
      26,
      18,
      8,
      shared.materials.landmarkBrick,
      shared.materials.landmarkOrange,
    );
    addBox('Presidio park bench back', -18, -8, [3.8, 0.82, 0.22], shared.materials.landmarkStone, 0.55);
    addBox('Presidio park bench seat', -18, -7.2, [3.8, 0.18, 0.82], shared.materials.trim, 0.55);
    addBox('Presidio trail marker post', -12, -4, [0.16, 4.8, 0.16], shared.materials.signalHousing);
    addBox('Presidio trail marker sign', -10.4, -4, [2.4, 0.72, 0.1], shared.materials.landmarkOrange, 3.8);
    addBox('Presidio stone park edge wall', -24, -2, [38, 1.05, 0.72], shared.materials.landmarkStone, 0.55);
    [
      { x: -20, z: 18, scale: 1.28 },
      { x: -8, z: 22, scale: 1.42 },
      { x: 4, z: 20, scale: 1.22 },
      { x: -14, z: 32, scale: 1.36 },
    ].forEach(({ x, z, scale }, index) => {
      addCypress(`Presidio camera-legible cypress ${index + 1}`, x, z, scale);
    });
  }

  return propCount;
}

function expansionRoadHalfWidth() {
  return ROAD_WIDTH * 0.5;
}

function expansionSidewalkOffset() {
  return expansionRoadHalfWidth() + SIDEWALK_WIDTH * 0.55;
}

function isOnExpansionRoad(x, z, roadLines, diagonal = null) {
  const half = expansionRoadHalfWidth();
  for (const line of roadLines) {
    if (Math.abs(x - line) <= half) return true;
    if (Math.abs(z - line) <= half) return true;
  }
  if (diagonal) {
    const [startX, startZ] = diagonal.start;
    const [endX, endZ] = diagonal.end;
    const dx = endX - startX;
    const dz = endZ - startZ;
    const lenSq = dx * dx + dz * dz;
    if (lenSq > 0) {
      const t = THREE.MathUtils.clamp(
        ((x - startX) * dx + (z - startZ) * dz) / lenSq,
        0,
        1,
      );
      const closestX = startX + t * dx;
      const closestZ = startZ + t * dz;
      if (Math.hypot(x - closestX, z - closestZ) <= diagonal.width * 0.5) return true;
    }
  }
  return false;
}

function resolveExpansionTreePlacement(x, z, roadLines, diagonal = null) {
  let resolvedX = x;
  let resolvedZ = z;
  const half = expansionRoadHalfWidth();
  const curb = expansionSidewalkOffset();
  for (const line of roadLines) {
    if (Math.abs(resolvedX - line) <= half) {
      resolvedX = line + (resolvedX >= line ? curb : -curb);
    }
    if (Math.abs(resolvedZ - line) <= half) {
      resolvedZ = line + (resolvedZ >= line ? curb : -curb);
    }
  }
  if (isOnExpansionRoad(resolvedX, resolvedZ, roadLines, diagonal)) return null;
  return { x: resolvedX, z: resolvedZ };
}

function addStreetFurniture(detail, blueprint, shared, surfaceAt) {
  const trees = createInstancedMesh(shared.canopy, shared.materials.tree, 48, 'Expansion low-poly street trees');
  const trunks = createInstancedMesh(shared.trunk, shared.materials.trunk, 48, 'Expansion street tree trunks');
  const lights = createInstancedMesh(shared.pole, shared.materials.signalHousing, 64, 'Expansion streetlight poles');
  const treeCadence = blueprint.treeCadence || 0;
  let treeCount = 0;
  let lightCount = 0;
  for (let index = 0; index < blueprint.roadLines.length; index += 1) {
    const line = blueprint.roadLines[index];
    for (let along = -160; along <= 160; along += 32) {
      if (treeCadence && (Math.abs(along / 32 + index) % treeCadence === 0) && treeCount < 48) {
        const side = index % 2 ? 1 : -1;
        const candidate = resolveExpansionTreePlacement(
          line + side * expansionSidewalkOffset(),
          along,
          blueprint.roadLines,
          blueprint.diagonal || null,
        );
        if (!candidate) continue;
        const { x, z } = candidate;
        const y = surfaceAt(x, z);
        setInstanceMatrix(trunks, treeCount, [x, y + 1.1, z], [0.22, 2.2, 0.22]);
        setInstanceMatrix(trees, treeCount, [x, y + 2.5, z], [1.5, 2.1, 1.5]);
        treeCount += 1;
      }
    }
  }
  for (const line of blueprint.roadLines) {
    for (const along of [-160, 0, 160]) {
      if (lightCount >= 64) break;
      const x = line + (line % 128 === 0 ? 9 : -9);
      const y = surfaceAt(x, along);
      setInstanceMatrix(lights, lightCount, [x, y + 2.5, along], [0.08, 5, 0.08]);
      lightCount += 1;
    }
  }

  const signature = new THREE.Group();
  signature.name = `${blueprint.district} street identity props`;
  let signaturePropCount = 0;
  const hydrantBody = new THREE.CylinderGeometry(0.28, 0.34, 0.86, 8);
  const hydrantCap = new THREE.CylinderGeometry(0.18, 0.18, 0.12, 8);
  const hydrantNozzle = new THREE.CylinderGeometry(0.12, 0.12, 0.18, 8);
  const meterHead = new THREE.CylinderGeometry(0.2, 0.24, 0.38, 8);
  const wire = new THREE.CylinderGeometry(0.025, 0.025, 1, 6);
  const addHydrant = (x, z) => {
    const y = surfaceAt(x, z);
    const body = new THREE.Mesh(hydrantBody, shared.materials.landmarkOrange);
    body.position.set(x, y + 0.43, z);
    const cap = new THREE.Mesh(hydrantCap, shared.materials.landmarkOrange);
    cap.position.set(x, y + 0.91, z);
    const nozzle = new THREE.Mesh(hydrantNozzle, shared.materials.landmarkOrange);
    nozzle.position.set(x + 0.28, y + 0.58, z);
    nozzle.rotation.z = Math.PI * 0.5;
    signature.add(body, cap, nozzle);
    signaturePropCount += 1;
  };
  const addParkingMeter = (x, z) => {
    const y = surfaceAt(x, z);
    const post = new THREE.Mesh(shared.pole, shared.materials.signalHousing);
    post.position.set(x, y + 0.82, z);
    post.scale.set(1.5, 1.64, 1.5);
    const head = new THREE.Mesh(meterHead, shared.materials.trim);
    head.position.set(x, y + 1.72, z);
    head.rotation.z = Math.PI * 0.5;
    const cap = new THREE.Mesh(shared.box, shared.materials.signalHousing);
    cap.position.set(x, y + 1.94, z);
    cap.scale.set(0.28, 0.06, 0.16);
    signature.add(post, head, cap);
    signaturePropCount += 1;
  };
  const addTransitStop = (x, z) => {
    const y = surfaceAt(x, z);
    const post = new THREE.Mesh(shared.pole, shared.materials.signalHousing);
    post.position.set(x, y + 1.7, z);
    post.scale.set(1.7, 3.4, 1.7);
    const sign = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
    sign.position.set(x, y + 3.45, z);
    sign.scale.set(0.52, 0.62, 0.12);
    const routeBand = new THREE.Mesh(shared.box, shared.materials.trim);
    routeBand.position.set(x, y + 3.45, z - 0.08);
    routeBand.scale.set(0.38, 0.08, 0.14);
    signature.add(post, sign, routeBand);
    signaturePropCount += 1;
  };
  const addWire = (start, end) => {
    const segment = new THREE.Mesh(wire, shared.materials.signalHousing);
    const direction = end.clone().sub(start);
    segment.position.copy(start).add(end).multiplyScalar(0.5);
    segment.scale.y = direction.length();
    segment.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, direction.normalize());
    segment.castShadow = false;
    segment.receiveShadow = false;
    signature.add(segment);
    signaturePropCount += 1;
  };
  const routeCueConfig = Object.freeze({
    'civic-spine': Object.freeze({ label: 'MUNI · MARKET', color: 0x245b57, side: -1 }),
    skyline: Object.freeze({ label: 'BATTERY · FERRY', color: 0x2b4e63, side: 1 }),
    'coit-tower': Object.freeze({ label: 'TELEGRAPH HILL', color: 0x8f493c, side: -1 }),
    'hill-villas': Object.freeze({ label: 'CALIFORNIA CABLE', color: 0x8f3f36, side: 1 }),
    'presidio-gate': Object.freeze({ label: 'PRESIDIO GATE', color: 0x37614f, side: -1 }),
    'mission-dolores': Object.freeze({ label: '24TH · MISSION', color: 0x9b4e38, side: 1 }),
    'mission-bay-crane': Object.freeze({ label: 'PIER 70', color: 0x315b60, side: -1 }),
    'ocean-park-edge': Object.freeze({ label: 'OCEAN BEACH', color: 0x35647a, side: 1 }),
    'dragon-gate': Object.freeze({ label: 'GRANT · GATE', color: 0x8c1f1a, side: -1 }),
    'grace-cathedral': Object.freeze({ label: 'CALIFORNIA RIDGE', color: 0x8f7a5a, side: 1 }),
    'lombard-switchback': Object.freeze({ label: 'LOMBARD · HYDE', color: 0x7a5a62, side: -1 }),
    'palace-of-fine-arts': Object.freeze({ label: 'MARINA GREEN', color: 0x6a7a72, side: 1 }),
    'transamerica-pyramid': Object.freeze({ label: 'MONTGOMERY', color: 0x2b4e63, side: -1 }),
    'sfmoma-design': Object.freeze({ label: 'YERBA BUENA', color: 0x4a3a36, side: 1 }),
    'ggp-meadow': Object.freeze({ label: 'JFK · PARK', color: 0x37614f, side: -1 }),
    'richmond-row': Object.freeze({ label: 'GEARY · RICHMOND', color: 0x6f6a64, side: 1 }),
    'inner-sunset-n-judah': Object.freeze({ label: 'N JUDAH', color: 0x35647a, side: -1 }),
    'twin-peaks-overlook': Object.freeze({ label: 'TWIN PEAKS', color: 0x546b5e, side: 1 }),
    'haight-ashbury-strip': Object.freeze({ label: 'HAIGHT · ASHBURY', color: 0x7a5a62, side: -1 }),
    'castro-theatre-row': Object.freeze({ label: 'CASTRO · 18TH', color: 0x8c4039, side: 1 }),
    'fillmore-plaza': Object.freeze({ label: 'FILLMORE · GEARY', color: 0x5a4542, side: -1 }),
    'laurel-heights-ridge': Object.freeze({ label: 'CALIFORNIA · EUCLID', color: 0x6e4f4b, side: 1 }),
  })[blueprint.landmark] || null;
  const routeCueMaterials = new Map();
  const getRouteCueMaterial = (label, color) => {
    if (routeCueMaterials.has(label)) return routeCueMaterials.get(label);
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.22,
      roughness: 0.62,
      metalness: 0.12,
    });
    // Authored expansion is also used by the Node invariant harness, where
    // document is absent. Keep the colored plate there, and add real readable
    // route lettering only in the browser presentation.
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = 168;
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = '#f3dfb8';
        context.lineWidth = 9;
        context.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
        context.fillStyle = '#fff4dc';
        context.font = '700 48px Arial, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, canvas.width * 0.5, canvas.height * 0.53);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        // The canvas is intentionally non-power-of-two. Explicit filtering
        // avoids an incomplete mip chain on WebGL2 drivers and guarantees the
        // physical sign stays on its authored plate instead of turning pink.
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        material.map = texture;
        material.needsUpdate = true;
      }
    }
    routeCueMaterials.set(label, material);
    return material;
  };
  let routeCue = null;
  if (routeCueConfig) {
    // 8.2 m sits on the sidewalk edge of the authored vertical avenue. The
    // previous 10.6 m placement landed inside the first building shell, so
    // the route cue existed in metadata but was not readable in the street.
    const x = routeCueConfig.side * 8.2;
    const z = -34;
    const y = surfaceAt(x, z);
    const post = new THREE.Mesh(shared.pole, shared.materials.signalHousing);
    post.position.set(x, y + 1.68, z);
    post.scale.set(1.5, 3.36, 1.5);
    const sign = new THREE.Mesh(shared.box, getRouteCueMaterial(
      routeCueConfig.label,
      routeCueConfig.color,
    ));
    sign.position.set(x, y + 3.34, z);
    sign.scale.set(2.7, 0.7, 0.12);
    sign.userData.routeCue = routeCueConfig.label;
    const lowerBand = new THREE.Mesh(shared.box, shared.materials.trim);
    lowerBand.position.set(x, y + 2.86, z - 0.07);
    lowerBand.scale.set(1.96, 0.08, 0.14);
    signature.add(post, sign, lowerBand);
    signaturePropCount += 1;
    routeCue = routeCueConfig.label;
  }
  let cableCar = null;

  // California Street's cable-car infrastructure is a compact authored cue:
  // rails, paired overhead lines, a transit stop, and the curb hardware that
  // makes a Pacific Heights block read as San Francisco at street level.
  if (blueprint.landmark === 'hill-villas') {
    const railPositions = [];
    const railColor = new THREE.Color(0x6e625b);
    [-1.65, 1.65].forEach((railX) => {
      addStrip(
        railPositions,
        null,
        [railX, -178],
        [railX, 178],
        0.1,
        surfaceAt,
        SURFACE_OFFSET + 0.06,
        railColor,
        18,
      );
    });
    signature.add(createSurfaceMesh('California Street cable car rails', railPositions, null, shared.materials.signalHousing));
    signaturePropCount += 1;
    [-2.7, 2.7].forEach((cableX) => {
      const points = [
        new THREE.Vector3(cableX, surfaceAt(cableX, -178) + 7.2, -178),
        new THREE.Vector3(cableX, surfaceAt(cableX, -52) + 7.2, -52),
        new THREE.Vector3(cableX, surfaceAt(cableX, 52) + 6.65, 52),
        new THREE.Vector3(cableX, surfaceAt(cableX, 178) + 7.2, 178),
      ];
      for (let index = 0; index < points.length - 1; index += 1) {
        addWire(points[index], points[index + 1]);
      }
    });
    cableCar = new THREE.Group();
    cableCar.name = 'California Street moving cable car';
    const cableCarBody = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
    cableCarBody.position.y = 1.35;
    cableCarBody.scale.set(4.4, 1.8, 8.2);
    const cableCarLower = new THREE.Mesh(shared.box, shared.materials.signalHousing);
    cableCarLower.position.y = 0.36;
    cableCarLower.scale.set(3.65, 0.22, 7.55);
    const cableCarRoof = new THREE.Mesh(shared.box, shared.materials.trim);
    cableCarRoof.position.y = 2.36;
    cableCarRoof.scale.set(4.7, 0.25, 8.55);
    cableCar.add(cableCarBody, cableCarLower, cableCarRoof);
    for (const side of [-1, 1]) {
      for (const z of [-2.45, 0, 2.45]) {
        const windowPanel = new THREE.Mesh(shared.box, shared.materials.window);
        windowPanel.position.set(side * 2.24, 1.58, z);
        windowPanel.scale.set(0.09, 0.72, 1.18);
        cableCar.add(windowPanel);
      }
    }
    const frontWindow = new THREE.Mesh(shared.box, shared.materials.window);
    frontWindow.position.set(0, 1.58, -4.16);
    frontWindow.scale.set(2.45, 0.72, 0.09);
    const trolleyPole = new THREE.Mesh(shared.pole, shared.materials.signalHousing);
    trolleyPole.position.set(0.42, 4.36, 0);
    trolleyPole.scale.set(1.7, 4.0, 1.7);
    cableCar.add(frontWindow, trolleyPole);
    signature.add(cableCar);
    signaturePropCount += 1;
    addTransitStop(-10.6, -6);
    addParkingMeter(10.6, 42);
    addParkingMeter(-10.6, 104);
    addHydrant(10.6, 96);
    addHydrant(-10.6, -44);
  }
  signaturePropCount += addDistrictPlaceCues(signature, blueprint, shared, surfaceAt);
  signature.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = false;
      object.receiveShadow = false;
    }
  });
  detail.add(signature);
  trees.count = treeCount;
  trunks.count = treeCount;
  lights.count = lightCount;
  [trees, trunks, lights].forEach((mesh) => {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    detail.add(mesh);
  });
  return { treeCount, lightCount, signaturePropCount, cableCar, routeCue };
}

function addSignals(detail, blueprint, descriptor, surfaceAt, signalIntersections, shared) {
  const signalMeshes = [];
  const headGeometry = shared.box;
  const mastMesh = createInstancedMesh(
    shared.pole,
    shared.materials.signalHousing,
    Math.max(1, signalIntersections.length),
    `${blueprint.district} signal masts`,
  );
  const headMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.44,
    metalness: 0.06,
    emissive: 0xffffff,
    emissiveIntensity: 0.32,
    vertexColors: true,
  });
  const headMesh = createInstancedMesh(
    headGeometry,
    headMaterial,
    Math.max(3, signalIntersections.length * 3),
    `${blueprint.district} signal heads`,
  );
  mastMesh.castShadow = false;
  mastMesh.receiveShadow = false;
  headMesh.castShadow = false;
  headMesh.receiveShadow = false;
  const lightColors = {
    red: { on: new THREE.Color(0xff4053), off: new THREE.Color(0x2e1118) },
    amber: { on: new THREE.Color(0xffca4a), off: new THREE.Color(0x3a2b12) },
    green: { on: new THREE.Color(0x52e59a), off: new THREE.Color(0x103024) },
  };
  const headColor = new THREE.Color();
  signalIntersections.forEach((intersection, index) => {
    const x = intersection.position.x;
    const z = intersection.position.z;
    const y = surfaceAt(x, z);
    setInstanceMatrix(mastMesh, index, [x + 8.2, y + 2.5, z + 8.2], [1, 5, 1]);
    const headIndices = [];
    for (const [headIndex, [name, height]] of [
      ['red', 4.8],
      ['amber', 4.35],
      ['green', 3.9],
    ].entries()) {
      const instanceIndex = index * 3 + headIndex;
      setInstanceMatrix(
        headMesh,
        instanceIndex,
        [x + 8.2, y + height, z + 8.2],
        [0.18, 0.28, 0.18],
      );
      headColor.copy(lightColors[name].off);
      headMesh.setColorAt(instanceIndex, headColor);
      headIndices.push({ name, instanceIndex });
    }
    signalMeshes.push({
      headMesh,
      headIndices,
      lightColors,
      offset: signalOffsetForPosition(descriptor.center.x + x, descriptor.center.z + z),
      group: index % 2,
    });
  });
  mastMesh.count = signalIntersections.length;
  headMesh.count = signalIntersections.length * 3;
  mastMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;
  if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;
  mastMesh.computeBoundingSphere();
  headMesh.computeBoundingSphere();
  detail.add(mastMesh, headMesh);
  return signalMeshes;
}

function addLandmark(detail, blueprint, surfaceAt, shared, buildingVolumes, descriptor) {
  const group = new THREE.Group();
  group.name = `${blueprint.district} signature landmark`;
  const addSurfaceBox = (name, x, z, scale, material, baseOffset = 0, rotationY = 0) => {
    const mesh = new THREE.Mesh(shared.box, material);
    mesh.name = name;
    mesh.position.set(
      x,
      surfaceAt(x, z) + baseOffset + scale[1] * 0.5,
      z,
    );
    mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.rotation.y = rotationY;
    group.add(mesh);
    return mesh;
  };
  const addSurfaceStrip = (name, start, end, width, material, offset = 0.008, segmentLength = 32) => {
    const positions = [];
    addStrip(positions, null, start, end, width, surfaceAt, offset, null, segmentLength);
    const mesh = createSurfaceMesh(name, positions, null, material);
    group.add(mesh);
    return mesh;
  };
  let landmark = null;
  let landmarkVisualIdentity = null;
  if (blueprint.landmark === 'coit-tower') {
    // Telegraph Hill sits in the forward sightline of the North Beach stop.
    // A broad, terraced shoulder keeps Coit grounded in the neighborhood
    // silhouette while the shared six-sided tower reads as a cylinder rather
    // than a pointed needle.
    const x = 58;
    const z = 74;
    const base = surfaceAt(x, z);
    const hillBase = new THREE.Mesh(new THREE.CylinderGeometry(22, 30, 8, 8), shared.materials.park);
    hillBase.name = 'Telegraph Hill broad lower shoulder';
    hillBase.position.set(x, base + 4, z);
    hillBase.receiveShadow = true;
    const hillShoulder = new THREE.Mesh(new THREE.CylinderGeometry(16, 22, 5, 8), shared.materials.park);
    hillShoulder.name = 'Telegraph Hill terraced upper shoulder';
    hillShoulder.position.set(x, base + 10.5, z);
    hillShoulder.receiveShadow = true;
    group.add(hillBase, hillShoulder);
    const coitStone = shared.materials.landmarkStone.clone();
    coitStone.fog = false;
    const coitBand = shared.materials.landmarkOrange.clone();
    coitBand.fog = false;
    const coitWindow = shared.materials.window.clone();
    coitWindow.fog = false;
    const tower = new THREE.Mesh(shared.tower, coitStone);
    tower.name = 'Coit Tower cylindrical shaft';
    tower.position.set(x, base + 32, z);
    tower.scale.set(6.2, 38, 6.2);
    tower.castShadow = true;
    group.add(tower);
    const observationDeck = addSurfaceBox(
      'Coit Tower observation deck',
      x,
      z,
      [8.4, 1.35, 8.4],
      coitStone,
      50.4,
    );
    observationDeck.castShadow = true;
    const deckBand = addSurfaceBox(
      'Coit Tower observation deck band',
      x,
      z,
      [8.9, 0.24, 8.9],
      coitBand,
      50.15,
    );
    deckBand.castShadow = true;
    for (let bandIndex = 0; bandIndex < 4; bandIndex += 1) {
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(3.05 - bandIndex * 0.015, 0.07, 6, 24),
        coitBand,
      );
      band.name = `Coit Tower shaft band ${bandIndex + 1}`;
      band.rotation.x = Math.PI * 0.5;
      band.position.set(x, base + 18 + bandIndex * 7.2, z);
      band.castShadow = true;
      group.add(band);
    }
    for (let fluteIndex = 0; fluteIndex < 6; fluteIndex += 1) {
      const angle = (fluteIndex / 6) * Math.PI * 2;
      const flute = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 9.4, 0.2),
        coitStone,
      );
      flute.name = `Coit Tower shaft flute ${fluteIndex + 1}`;
      flute.position.set(
        x + Math.cos(angle) * 2.95,
        base + 28,
        z + Math.sin(angle) * 2.95,
      );
      flute.rotation.y = -angle;
      flute.castShadow = true;
      group.add(flute);
    }
    for (let slitIndex = 0; slitIndex < 8; slitIndex += 1) {
      const angle = (slitIndex / 8) * Math.PI * 2 + 0.18;
      const slit = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.42, 0.22),
        coitWindow,
      );
      slit.name = `Coit Tower slit window ${slitIndex + 1}`;
      slit.position.set(
        x + Math.cos(angle) * 3.05,
        base + 44,
        z + Math.sin(angle) * 3.05,
      );
      slit.rotation.y = -angle;
      group.add(slit);
    }
    const cap = addSurfaceBox('Coit Tower shallow cap', x, z, [7.8, 1.2, 7.8], coitStone, 51);
    cap.castShadow = true;
    const capBand = addSurfaceBox('Coit Tower cap band', x, z, [8.4, 0.22, 8.4], coitBand, 50.75);
    capBand.castShadow = true;
    [
      { x: 18, z: -18, width: 16, depth: 10, height: 8 },
      { x: 42, z: -14, width: 14, depth: 9, height: 7 },
    ].forEach((cafe, index) => {
      const building = new THREE.Mesh(shared.box, shared.materials.landmarkBrick);
      building.name = `North Beach Telegraph Hill cafe block ${index + 1}`;
      building.position.set(cafe.x, surfaceAt(cafe.x, cafe.z) + cafe.height * 0.5, cafe.z);
      building.scale.set(cafe.width, cafe.height, cafe.depth);
      building.castShadow = true;
      const cafeRoof = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
      cafeRoof.name = `North Beach Telegraph Hill cafe roof ${index + 1}`;
      cafeRoof.position.set(cafe.x, building.position.y + cafe.height * 0.5 + 0.35, cafe.z);
      cafeRoof.scale.set(cafe.width + 1.2, 0.32, cafe.depth + 0.8);
      const awning = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
      awning.name = `North Beach Telegraph Hill cafe awning ${index + 1}`;
      awning.position.set(cafe.x, building.position.y + 3.1, cafe.z - cafe.depth * 0.5 - 0.72);
      awning.scale.set(cafe.width * 0.82, 0.14, 1.2);
      group.add(building, cafeRoof, awning);
    });
    // Fisherman's Wharf / Pier 39 proxy cards north of Telegraph Hill.
    [
      { x: 120, z: 168, w: 20, d: 7, h: 5.5 },
      { x: 148, z: 172, w: 24, d: 8, h: 6.5 },
      { x: 172, z: 166, w: 18, d: 6, h: 5 },
    ].forEach(({ x: px, z: pz, w, d, h }, index) => {
      const pier = addSurfaceBox(`North Beach Wharf pier card ${index + 1}`, px, pz, [w, h, d], shared.materials.landmarkStone, 0.35);
      pier.castShadow = true;
      const finger = addSurfaceBox(`North Beach Wharf finger ${index + 1}`, px, pz + 9, [w * 0.65, 0.32, 11], shared.materials.boardwalk, 0.45);
      finger.castShadow = true;
    });
    landmark = { x, z, width: 12, depth: 12, height: 56, style: 'landmark', heading: 0, baseY: base, label: 'Coit Tower public museum' };
  } else if (blueprint.landmark === 'mission-dolores') {
    const x = 8;
    const z = 24;
    const base = surfaceAt(x, z);
    const nave = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
    nave.position.set(x, base + 6, z);
    nave.scale.set(15, 14, 30);
    nave.castShadow = true;
    group.add(nave);
    const bell = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
    bell.position.set(x - 8, base + 13, z - 3);
    bell.scale.set(4.5, 26, 5.5);
    bell.castShadow = true;
    const bellRight = bell.clone();
    bellRight.position.x = x + 8;
    const bellCap = new THREE.Mesh(new THREE.ConeGeometry(2.9, 3.4, 4), shared.materials.landmarkOrange);
    bellCap.position.set(x - 8, base + 28, z - 3);
    bellCap.rotation.y = Math.PI * 0.25;
    const bellCapRight = bellCap.clone();
    bellCapRight.position.x = x + 8;
    const facade = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
    facade.position.set(x, base + 8.4, z - 15.4);
    facade.scale.set(14, 4.8, 1.2);
    const frontGable = new THREE.Mesh(new THREE.ConeGeometry(7.8, 5.4, 4), shared.materials.landmarkOrange);
    frontGable.position.set(x, base + 15.5, z - 15.7);
    frontGable.rotation.y = Math.PI * 0.25;
    const roseWindow = new THREE.Mesh(shared.window, shared.materials.window);
    roseWindow.position.set(x, base + 10.2, z - 16.05);
    roseWindow.scale.set(3.1, 1.9, 0.08);
    const cross = new THREE.Mesh(shared.pole, shared.materials.landmarkOrange);
    cross.position.set(x, base + 19.8, z - 16.1);
    cross.scale.set(0.22, 2.2, 0.22);
    const crossBar = new THREE.Mesh(shared.pole, shared.materials.landmarkOrange);
    crossBar.position.set(x, base + 20.1, z - 16.1);
    crossBar.scale.set(0.75, 0.22, 0.22);
    group.add(bell, bellRight, bellCap, bellCapRight, facade, frontGable, roseWindow, cross, crossBar);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(8, 5, 4), shared.materials.landmarkOrange);
    roof.position.set(x, base + 14.5, z);
    roof.rotation.y = Math.PI * 0.25;
    group.add(roof);
    landmark = { x, z, width: 16, depth: 32, height: 28, style: 'landmark', heading: 0, baseY: base, label: 'Mission Dolores basilica' };
  } else if (blueprint.landmark === 'mission-bay-crane') {
    // Keep the industrial crane adjacent to a continuous channel edge and
    // inside the normal Mission Bay street-level frame. The deck, rails, and
    // a few containers provide a restrained Pier 70 working-waterfront cue.
    const x = 28;
    const z = 50;
    const base = surfaceAt(x, z);
    const mast = new THREE.Mesh(shared.pole, shared.materials.landmarkOrange);
    mast.name = 'Mission Bay Pier 70 crane mast';
    mast.position.set(x, surfaceAt(x, z) + 23, z);
    mast.scale.set(1, 46, 1);
    group.add(mast);
    const boom = addSurfaceBox('Mission Bay Pier 70 crane boom', x + 20, z, [44, 0.7, 0.7], shared.materials.landmarkOrange, 43.65);
    boom.castShadow = true;
    const warehouse = addSurfaceBox('Mission Bay Pier 70 warehouse', x + 34, z + 16, [38, 9, 24], shared.materials.landmarkStone);
    warehouse.castShadow = true;
    [48, 58, 68, 78].forEach((windowX, index) => {
      const window = addSurfaceBox(
        `Mission Bay Pier 70 warehouse south window ${index + 1}`,
        windowX,
        z + 4.1,
        [6, 2, 0.12],
        shared.materials.window,
        4.8,
      );
      window.castShadow = false;
      window.receiveShadow = false;
    });
    [56, 66, 76].forEach((windowZ, index) => {
      const window = addSurfaceBox(
        `Mission Bay Pier 70 warehouse west window ${index + 1}`,
        x + 14.9,
        windowZ,
        [0.12, 2, 5],
        shared.materials.window,
        4.8,
        Math.PI * 0.5,
      );
      window.castShadow = false;
      window.receiveShadow = false;
    });
    const promenade = addSurfaceBox('Mission Bay waterfront promenade', 36, 68, [14, 0.36, 40], shared.materials.sidewalk);
    promenade.receiveShadow = true;
    const promenadeEdge = addSurfaceBox('Mission Bay promenade water edge', 51, 68, [1.2, 0.5, 40], shared.materials.water, 0.09);
    promenadeEdge.receiveShadow = true;
    const channel = addSurfaceStrip('Mission Bay continuous bay channel water', [74, 110], [74, 172], 30, shared.materials.water, 0.14);
    channel.receiveShadow = true;
    const waterline = addSurfaceBox('Mission Bay continuous channel waterline', 89, 141, [0.7, 0.14, 62], shared.materials.water, 0.02);
    waterline.receiveShadow = true;
    // A short tidal inlet cuts into the open Pier 70 frontage and meets the
    // longer channel without painting over the existing road datum.
    const streetInlet = addSurfaceBox('Mission Bay street tidal inlet', 54, 48, [18, 0.14, 28], shared.materials.water);
    streetInlet.receiveShadow = true;
    const streetWaterline = addSurfaceBox('Mission Bay street tidal waterline', 54, 62, [18, 0.12, 0.6], shared.materials.water, 0.02);
    streetWaterline.receiveShadow = true;
    const pierDeck = addSurfaceBox('Mission Bay Pier 70 deck', 56, 68, [28, 0.42, 18], shared.materials.sidewalk, 0.12);
    pierDeck.receiveShadow = true;
    const pierEdge = addSurfaceBox('Mission Bay Pier 70 deck edge', 70, 68, [0.7, 0.58, 18], shared.materials.signalHousing, 0.42);
    pierEdge.castShadow = true;
    [-1, 1].forEach((side) => {
      const railX = 56 + side * 12;
      const rail = addSurfaceBox(`Mission Bay Pier 70 rail ${side < 0 ? 'land' : 'water'} side`, railX, 68, [0.18, 1.05, 18], shared.materials.signalHousing, 0.42);
      rail.castShadow = true;
      [60, 66, 72, 76].forEach((railZ) => {
        const post = addSurfaceBox('Mission Bay Pier 70 rail post', railX, railZ, [0.22, 1.3, 0.22], shared.materials.signalHousing, 0.42);
        post.castShadow = true;
      });
    });
    [
      { x: 49, z: 56, material: shared.materials.landmarkOrange, rotation: 0 },
      { x: 61, z: 56, material: shared.materials.landmarkBrick, rotation: 0 },
      { x: 49, z: 68, material: shared.materials.landmarkStone, rotation: 0 },
      { x: 61, z: 68, material: shared.materials.landmarkOrange, rotation: 0 },
      { x: 73, z: 56, material: shared.materials.landmarkBrick, rotation: Math.PI * 0.5 },
    ].forEach((container, index) => {
      const mesh = addSurfaceBox(
        `Mission Bay Pier 70 container ${index + 1}`,
        container.x,
        container.z,
        [10, 3, 5],
        container.material,
        0,
        container.rotation,
      );
      mesh.castShadow = true;
    });
    landmark = { x: x + 34, z: z + 16, width: 38, depth: 24, height: 9, style: 'warehouse', heading: 0, baseY: surfaceAt(x + 34, z + 16), label: 'Mission Bay rail warehouse' };
  } else if (blueprint.landmark === 'presidio-gate') {
    // Pass16: larger Lombard-class gate + meadow so −4:1 close approach reads Presidio.
    const x = -6;
    const z = 78;
    const base = surfaceAt(x, z);
    const park = addSurfaceBox('Presidio park edge meadow', -8, 104, [96, 0.34, 48], shared.materials.park);
    park.receiveShadow = true;
    const meadowShoulder = addSurfaceBox('Presidio meadow shoulder', -28, 92, [48, 0.44, 22], shared.materials.park, 0.02);
    meadowShoulder.receiveShadow = true;
    const left = addSurfaceBox('Presidio Lombard gate left pier', x - 8, z, [4.4, 16, 5.2], shared.materials.landmarkStone);
    const right = addSurfaceBox('Presidio Lombard gate right pier', x + 8, z, [4.4, 16, 5.2], shared.materials.landmarkStone);
    left.castShadow = true;
    right.castShadow = true;
    // Cap blocks on piers (arch gateway read).
    addSurfaceBox('Presidio Lombard gate left cap', x - 8, z, [5.2, 1.4, 6], shared.materials.landmarkStone, 16);
    addSurfaceBox('Presidio Lombard gate right cap', x + 8, z, [5.2, 1.4, 6], shared.materials.landmarkStone, 16);
    const beam = addSurfaceBox('Presidio Lombard gate beam', x, z, [28, 2.2, 4.2], shared.materials.landmarkOrange, 15.2);
    beam.castShadow = true;
    // PRESIDIO lettering plank on beam face.
    addSurfaceBox('Presidio Lombard gate sign plank', x, z + 2.4, [18, 1.6, 0.35], shared.materials.landmarkStone, 15.4);
    const gateGround = surfaceAt(x, z);
    const flagPole = new THREE.Mesh(shared.pole, shared.materials.landmarkStone);
    flagPole.name = 'Presidio Lombard gate flag pole';
    flagPole.position.set(x + 12.5, gateGround + 14, z + 1.2);
    flagPole.scale.set(0.2, 28, 0.2);
    flagPole.castShadow = true;
    const flag = addSurfaceBox('Presidio Lombard gate flag', x + 16.5, z + 1.2, [7.4, 2.4, 0.14], shared.materials.landmarkOrange, 24.5);
    flag.castShadow = true;
    group.add(flagPole);
    // Push a tall cypress screen into the Presidio landmark camera frustum
    // (lookAt ~ local +36,+86 from camera ~0,+26) so the cluster reads at scale.
    const addPresidioCypress = (treeX, treeZ, scale) => {
      const ground = surfaceAt(treeX, treeZ);
      const trunk = new THREE.Mesh(shared.trunk, shared.materials.trunk);
      trunk.name = 'Presidio park cypress trunk';
      trunk.position.set(treeX, ground + 4.2 * scale, treeZ);
      trunk.scale.set(0.55 * scale, 8.8 * scale, 0.55 * scale);
      trunk.castShadow = true;
      const canopy = new THREE.Mesh(shared.canopy, shared.materials.tree);
      canopy.name = 'Presidio park cypress canopy';
      canopy.position.set(treeX, ground + 12.8 * scale, treeZ);
      canopy.scale.set(1.55 * scale, 8.4 * scale, 1.55 * scale);
      canopy.castShadow = true;
      group.add(trunk, canopy);
    };
    [
      { x: -42, z: 42, scale: 2.35 },
      { x: -28, z: 46, scale: 2.55 },
      { x: -14, z: 50, scale: 2.45 },
      { x: 26, z: 44, scale: 2.25 },
      { x: 38, z: 48, scale: 2.15 },
      { x: 48, z: 54, scale: 2.05 },
      { x: -36, z: 62, scale: 2.2 },
      { x: 10, z: 66, scale: 2.1 },
      { x: 30, z: 72, scale: 2.0 },
      { x: -20, z: 86, scale: 2.3 },
      { x: 8, z: 90, scale: 2.15 },
      { x: -4, z: 96, scale: 2.4 },
    ].forEach(({ x: treeX, z: treeZ, scale }) => {
      addPresidioCypress(treeX, treeZ, scale);
    });
    // A few low barracks blocks keep the park edge legible as the Presidio's
    // former military campus instead of an empty green plane. These are
    // deliberately sparse silhouettes; the streamed massing owns the rest.
    [
      { x: -52, z: 146, width: 22, height: 7, depth: 30 },
      { x: 0, z: 158, width: 26, height: 8, depth: 34 },
      { x: 48, z: 146, width: 22, height: 7, depth: 30 },
    ].forEach((barracks) => {
      const building = new THREE.Mesh(shared.box, shared.materials.landmarkBrick);
      building.position.set(barracks.x, surfaceAt(barracks.x, barracks.z) + barracks.height * 0.5, barracks.z);
      building.scale.set(barracks.width, barracks.height, barracks.depth);
      building.castShadow = true;
      const roof = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
      roof.position.set(barracks.x, building.position.y + barracks.height * 0.5 + 0.7, barracks.z);
      roof.scale.set(barracks.width + 2.4, 1.2, barracks.depth + 2.4);
      roof.castShadow = true;
      group.add(building, roof);
    });
    // Stronger Golden Gate Bridge silhouette NW of the Presidio gate.
    [-70, -48].forEach((tx, index) => {
      const tower = addSurfaceBox(
        `Presidio GGB tower cue ${index + 1}`,
        tx,
        170,
        [5.5, 36 + index * 6, 5.5],
        shared.materials.landmarkOrange,
        2,
      );
      tower.castShadow = true;
    });
    const bridgeDeck = addSurfaceBox('Presidio GGB deck cue', -59, 170, [36, 1.4, 4], shared.materials.landmarkOrange, 22);
    bridgeDeck.castShadow = true;
    landmark = { x, z, width: 21, depth: 5, height: 14, style: 'landmark', heading: 0, baseY: base, label: 'Presidio Lombard gate' };
  } else if (blueprint.landmark === 'civic-spine') {
    const x = -108;
    const z = 60;
    const base = surfaceAt(x, z);
    // City Hall–scale dome: larger drum + gold lantern so 1:0 evidence reads Civic.
    const plinth = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
    plinth.position.set(x, base + 5.2, z);
    plinth.scale.set(26, 10.4, 20);
    plinth.castShadow = true;
    const roof = new THREE.Mesh(shared.box, shared.materials.roof);
    roof.position.set(x, base + 10.8, z);
    roof.scale.set(28, 1.4, 22);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(8.4, 9.2, 7.2, 12), shared.materials.landmarkStone);
    drum.position.set(x, base + 14.8, z);
    drum.castShadow = true;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(9.2, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), shared.materials.landmarkStone);
    dome.position.set(x, base + 19.6, z);
    dome.castShadow = true;
    const lantern = new THREE.Mesh(shared.pole, shared.materials.landmarkOrange);
    lantern.position.set(x, base + 26.2, z);
    lantern.scale.set(0.32, 4.2, 0.32);
    const lanternCap = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
    lanternCap.position.set(x, base + 28.6, z);
    lanternCap.scale.set(2.4, 0.55, 2.4);
    group.add(plinth, roof, drum, dome, lantern, lanternCap);
    [-92, -124].forEach((wingX, index) => {
      const wing = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
      wing.name = `Civic Center Muni pavilion wing ${index + 1}`;
      wing.position.set(wingX, base + 5.5, z);
      wing.scale.set(14, 11, 12);
      wing.castShadow = true;
      group.add(wing);
    });
    [-118, -98, -78].forEach((columnX, index) => {
      const column = new THREE.Mesh(shared.pole, shared.materials.landmarkStone);
      column.name = `Civic Center dome portico column ${index + 1}`;
      column.position.set(columnX, base + 5.8, z - 10);
      column.scale.set(0.62, 11.6, 0.62);
      column.castShadow = true;
      group.add(column);
    });
    const plazaSteps = new THREE.Mesh(shared.box, shared.materials.sidewalk);
    plazaSteps.name = 'Civic Center dome plaza terrace';
    plazaSteps.position.set(x, base + 0.28, z - 16);
    plazaSteps.scale.set(36, 0.56, 10);
    plazaSteps.receiveShadow = true;
    group.add(plazaSteps);
    landmark = { x, z, width: 20, depth: 16, height: 22, style: 'landmark', heading: 0, baseY: base, label: 'Civic Center Muni pavilion' };
  } else if (blueprint.landmark === 'ocean-park-edge') {
    // Work west from the avenue: a visible sand shelf, two low dune terraces,
    // a stone seawall, then one continuous Pacific water strip. The far strip
    // at the avenue end supplies a simple horizon cue without a large plane.
    const park = addSurfaceBox('Outer Sunset Ocean Park meadow', -8, 76, [44, 0.4, 36], shared.materials.park);
    park.receiveShadow = true;
    const beach = addSurfaceBox('Outer Sunset Pacific beach', -76, 76, [54, 0.22, 34], shared.materials.sand, 0.02);
    beach.receiveShadow = true;
    const foreshore = addSurfaceBox('Outer Sunset beach foreshore', -108, 82, [14, 0.14, 42], shared.materials.sand, 0.02);
    foreshore.receiveShadow = true;
    const dune = addSurfaceBox('Outer Sunset primary dune shoulder', -118, 82, [12, 1.5, 42], shared.materials.sand);
    dune.receiveShadow = true;
    const duneCrest = addSurfaceBox('Outer Sunset secondary dune crest', -122, 108, [10, 1.2, 28], shared.materials.sand);
    duneCrest.receiveShadow = true;
    const seawall = addSurfaceBox('Outer Sunset Pacific seawall', -136, 88, [2.4, 0.45, 50], shared.materials.landmarkStone);
    seawall.castShadow = true;
    const seawallCap = addSurfaceBox('Outer Sunset seawall cap', -136, 88, [3.2, 0.24, 52], shared.materials.trim, 0.45);
    seawallCap.castShadow = true;
    // The waterline needs to read from the avenue and waterfront QA poses.
    // Keep a shared low-poly shelf behind the dune, then layer three narrow
    // foam bands across its edge so the Pacific is not lost as a flat beige
    // horizon in the low-poly silhouette.
    const oceanShelf = addSurfaceBox('Outer Sunset Pacific water shelf', -177, 151, [54, 0.18, 86], shared.materials.water, 3.2);
    oceanShelf.receiveShadow = true;
    const ocean = addSurfaceStrip('Outer Sunset Pacific water', [-177, 110], [-177, 192], 52, shared.materials.water, 3.23, 20);
    ocean.receiveShadow = true;
    [-151, -158, -165].forEach((shoreX, index) => {
      const surf = addSurfaceStrip(
        `Outer Sunset Pacific surf band ${index + 1}`,
        [shoreX, 116 + index * 3],
        [shoreX, 186 - index * 3],
        1.05 - index * 0.16,
        shared.materials.foam,
        3.29 + index * 0.014,
        20,
      );
      surf.receiveShadow = true;
    });
    const waterline = addSurfaceBox('Outer Sunset visible Pacific waterline', -151, 151, [0.55, 0.14, 84], shared.materials.water, 3.26);
    waterline.receiveShadow = true;

    // Break the broad beach plate into readable dry, damp, and foreshore
    // shelves. The shallow offsets keep the layers watertight while giving
    // the road-scale camera a value break across the otherwise empty sand.
    const drySandShelf = addSurfaceStrip(
      'Outer Sunset dry sand shelf',
      [-82, 60],
      [-82, 194],
      24,
      shared.materials.sandLight,
      0.055,
      20,
    );
    drySandShelf.receiveShadow = true;
    const wetSandShelf = addSurfaceStrip(
      'Outer Sunset damp sand shelf',
      [-105, 62],
      [-105, 194],
      5.4,
      shared.materials.sandWet,
      0.09,
      20,
    );
    wetSandShelf.receiveShadow = true;
    [-148, -153, -158].forEach((shoreX, index) => {
      const nearshoreFoam = addSurfaceStrip(
        `Outer Sunset broken nearshore foam ${index + 1}`,
        [shoreX, 120 + index * 5],
        [shoreX, 182 - index * 4],
        1.45 - index * 0.18,
        shared.materials.foam,
        3.34 + index * 0.012,
        16,
      );
      nearshoreFoam.receiveShadow = true;
    });

    // Offset wave crests break the parallel-strip artifact at the road-scale
    // camera. They are intentionally sparse and polygonal: a handful of
    // angled foam plates gives the Pacific a readable rhythm without turning
    // the low-poly shoreline into a dense particle field.
    const waveCrestMaterial = shared.materials.foam.clone();
    waveCrestMaterial.name = 'Outer Sunset Pacific broken wave crest material';
    waveCrestMaterial.color.set(0xb5d1cf);
    waveCrestMaterial.roughness = 0.5;
    const waveFacetMaterial = shared.materials.water.clone();
    waveFacetMaterial.name = 'Outer Sunset Pacific low-poly water facet material';
    waveFacetMaterial.color.set(0x4c7f8b);
    waveFacetMaterial.roughness = 0.46;
    [
      { x: -164, z: 128, length: 15, angle: 0.12 },
      { x: -174, z: 143, length: 22, angle: -0.18 },
      { x: -159, z: 159, length: 12, angle: 0.24 },
      { x: -181, z: 177, length: 19, angle: -0.1 },
      { x: -166, z: 192, length: 14, angle: 0.16 },
    ].forEach(({ x, z, length, angle }, index) => {
      const crest = addSurfaceBox(
        `Outer Sunset Pacific broken wave crest ${index + 1}`,
        x,
        z,
        [length, 0.09, 0.34],
        waveCrestMaterial,
        3.38,
        angle,
      );
      crest.receiveShadow = false;
    });
    [
      { x: -168, z: 134, length: 11, width: 0.82, angle: -0.12 },
      { x: -181, z: 148, length: 16, width: 0.62, angle: 0.16 },
      { x: -165, z: 163, length: 9, width: 0.72, angle: -0.2 },
      { x: -182, z: 181, length: 14, width: 0.58, angle: 0.08 },
      { x: -170, z: 195, length: 10, width: 0.66, angle: -0.16 },
    ].forEach(({ x, z, length, width, angle }, index) => {
      const facet = addSurfaceBox(
        `Outer Sunset Pacific low-poly water facet ${index + 1}`,
        x,
        z,
        [length, 0.045, width],
        waveFacetMaterial,
        3.275,
        angle,
      );
      facet.receiveShadow = false;
    });

    // Three dark offshore rocks create the Seal Rocks / Pacific headland cue
    // that is missing from a flat teal horizon. They stay below the tower
    // silhouette so the landmark remains the strongest vertical read.
    const oceanRockGeometry = new THREE.IcosahedronGeometry(1, 1);
    [
      { x: -184, z: 150, scale: [3.7, 1.5, 2.4] },
      { x: -176, z: 171, scale: [2.5, 1.15, 1.8] },
      { x: -189, z: 188, scale: [4.2, 1.7, 2.8] },
    ].forEach(({ x, z, scale }, index) => {
      const rock = new THREE.Mesh(oceanRockGeometry, shared.materials.oceanRock);
      rock.name = `Outer Sunset Pacific Seal Rock ${index + 1}`;
      rock.position.set(x, surfaceAt(x, z) + 3.5 + scale[1] * 0.38, z);
      rock.scale.set(...scale);
      rock.rotation.y = index * 0.7;
      rock.castShadow = true;
      group.add(rock);
    });

    // A short Ocean Beach boardwalk makes the open sand read as a public
    // shoreline instead of an untextured plaza. Leave a gap at the cross
    // street so the authored road grid remains readable and traversable.
    const boardwalkSegments = [
      { z: 82, depth: 32 },
      { z: 150, depth: 64 },
    ];
    boardwalkSegments.forEach(({ z, depth }, segmentIndex) => {
      const deck = addSurfaceBox(
        `Ocean Beach boardwalk deck ${segmentIndex + 1}`,
        -104,
        z,
        [8.2, 0.34, depth],
        shared.materials.boardwalk,
        0.2,
      );
      deck.castShadow = true;
      const cap = addSurfaceBox(
        `Ocean Beach boardwalk cap ${segmentIndex + 1}`,
        -104,
        z,
        [8.8, 0.12, depth + 0.8],
        shared.materials.boardwalk,
        0.56,
      );
      cap.castShadow = true;
      [-108.15, -99.85].forEach((railX) => {
        const rail = addSurfaceBox(
          `Ocean Beach boardwalk rail ${segmentIndex + 1}`,
          railX,
          z,
          [0.16, 0.88, depth],
          shared.materials.landmarkStone,
          0.52,
        );
        rail.castShadow = true;
        const firstPost = z - depth * 0.5 + 1.2;
        const lastPost = z + depth * 0.5 - 1.2;
        for (let postZ = firstPost; postZ <= lastPost + 0.1; postZ += 14) {
          const post = addSurfaceBox(
            `Ocean Beach boardwalk rail post ${segmentIndex + 1}`,
            railX,
            postZ,
            [0.24, 1.28, 0.24],
            shared.materials.signalHousing,
            0.36,
          );
          post.castShadow = true;
        }
      });
      for (let plankZ = z - depth * 0.5 + 5; plankZ < z + depth * 0.5; plankZ += 9) {
        const plank = addSurfaceBox(
          `Ocean Beach boardwalk plank ${segmentIndex + 1}`,
          -104,
          plankZ,
          [8.1, 0.07, 0.22],
          shared.materials.boardwalk,
          0.62,
        );
        plank.castShadow = false;
      }
    });

    // A compact Pacific access pier supplies the hero line that the open
    // beach otherwise lacks. It follows the sampled grade across the seawall
    // and stops inside the authored water shelf instead of becoming a large
    // off-grid platform.
    const pierZ = 132;
    const pier = addSurfaceStrip(
      'Ocean Beach Pacific access pier deck',
      [-126, pierZ],
      [-188, pierZ],
      5.6,
      shared.materials.boardwalk,
      0.24,
      12,
    );
    pier.castShadow = true;
    const pierHead = addSurfaceBox('Ocean Beach Pacific access pier head', -184, pierZ, [10, 0.34, 7.2], shared.materials.boardwalk, 0.24);
    pierHead.castShadow = true;
    [-2.72, 2.72].forEach((railZ, sideIndex) => {
      const rail = addSurfaceBox(
        `Ocean Beach Pacific access pier rail ${sideIndex + 1}`,
        -157,
        pierZ + railZ,
        [62, 0.92, 0.16],
        shared.materials.signalHousing,
        0.58,
      );
      rail.castShadow = true;
      [-128, -144, -160, -176, -186].forEach((postX) => {
        const post = addSurfaceBox(
          `Ocean Beach Pacific access pier post ${sideIndex + 1}`,
          postX,
          pierZ + railZ,
          [0.22, 1.28, 0.22],
          shared.materials.signalHousing,
          0.36,
        );
        post.castShadow = true;
      });
    });
    const pierBeaconPole = addSurfaceBox('Ocean Beach Pacific pier beacon pole', -188, pierZ, [0.2, 3.4, 0.2], shared.materials.landmarkStone, 0.4);
    pierBeaconPole.castShadow = true;
    const pierBeacon = addSurfaceBox('Ocean Beach Pacific pier beacon', -186.8, pierZ, [1.6, 0.82, 0.12], shared.materials.landmarkOrange, 3.02);
    pierBeacon.castShadow = true;

    // A compact Sutro Baths / Cliff House lookout gives the north end of the
    // beach a recognizable San Francisco silhouette without importing a
    // proprietary landmark mesh. The stepped terrace, six-sided lookout,
    // and warm roof are intentionally readable from the road-scale camera.
    const sutroCliffWall = addSurfaceBox('Sutro Baths dark cliff plinth', -140, 184, [24, 1.55, 18], shared.materials.oceanRock, 0.02);
    sutroCliffWall.castShadow = true;
    [-136, -128].forEach((poolX, index) => {
      const pool = addSurfaceBox(
        `Sutro Baths ruined pool floor ${index + 1}`,
        poolX,
        184,
        [6.2, 0.08, 8.2],
        shared.materials.water,
        1.62,
      );
      pool.receiveShadow = true;
    });
    const sutroBase = addSurfaceBox('Sutro Baths cliff terrace', -140, 184, [20, 0.62, 14], shared.materials.landmarkStone, 0.18);
    sutroBase.castShadow = true;
    const sutroWing = addSurfaceBox('Sutro Baths low gallery', -140, 184, [15.5, 4.2, 9.4], shared.materials.landmarkStone, 0.64);
    sutroWing.castShadow = true;
    const sutroRoof = addSurfaceBox('Sutro Baths warm gallery roof', -140, 184, [17.2, 0.42, 10.4], shared.materials.landmarkOrange, 4.86);
    sutroRoof.castShadow = true;
    const sutroTower = new THREE.Mesh(shared.tower, shared.materials.landmarkStone);
    sutroTower.name = 'Sutro Baths six-sided lookout tower';
    sutroTower.position.set(-148.2, surfaceAt(-148.2, 184) + 7.2, 184);
    sutroTower.scale.set(3.35, 11.8, 3.35);
    sutroTower.castShadow = true;
    group.add(sutroTower);
    const sutroTowerBase = addSurfaceBox('Sutro Baths lookout tower base', -148.2, 184, [6.8, 1.9, 6.8], shared.materials.landmarkStone, 0.56);
    sutroTowerBase.castShadow = true;
    const sutroCap = addSurfaceBox('Sutro Baths lookout cap', -148.2, 184, [3.6, 0.28, 3.6], shared.materials.landmarkOrange, 13.72);
    sutroCap.castShadow = true;
    const sutroLanternBand = addSurfaceBox('Sutro Baths lookout lantern band', -148.2, 184, [5.2, 0.62, 5.2], shared.materials.landmarkOrange, 11.95);
    sutroLanternBand.castShadow = true;
    // Large dark openings and pale piers turn the gallery into a ruin-like
    // silhouette at distance; three tiny blue panes alone read as ordinary
    // windows and lose the Sutro reference in the haze.
    const sutroOpeningXs = [-145.5, -141.5, -137.5, -133.5];
    const sutroArchMaterial = shared.materials.landmarkStone.clone();
    sutroArchMaterial.side = THREE.DoubleSide;
    sutroOpeningXs.forEach((windowX, index) => {
      const galleryOpening = addSurfaceBox(
        `Sutro Baths arched gallery opening ${index + 1}`,
        windowX,
        179.12,
        [2.55, 2.08, 0.16],
        shared.materials.oceanRock,
        2.04,
      );
      galleryOpening.castShadow = false;
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(1.12, 0.16, 6, 12, Math.PI),
        sutroArchMaterial,
      );
      arch.name = `Sutro Baths gallery arch ${index + 1}`;
      arch.position.set(windowX, surfaceAt(-140, 184) + 4.1, 179.08);
      arch.castShadow = true;
      group.add(arch);
    });
    sutroOpeningXs.forEach((windowX, index) => {
      const galleryOpening = addSurfaceBox(
        `Sutro Baths north gallery opening ${index + 1}`,
        windowX,
        188.88,
        [2.55, 2.08, 0.16],
        shared.materials.oceanRock,
        2.04,
      );
      galleryOpening.castShadow = false;
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(1.12, 0.16, 6, 12, Math.PI),
        sutroArchMaterial,
      );
      arch.name = `Sutro Baths north gallery arch ${index + 1}`;
      arch.position.set(windowX, surfaceAt(-140, 184) + 4.1, 188.92);
      arch.castShadow = true;
      group.add(arch);
    });
    [-148, -147.8, -131.2].forEach((pillarX, index) => {
      const pillar = addSurfaceBox(
        `Sutro Baths gallery ruin pier ${index + 1}`,
        pillarX,
        179.02,
        [0.42, 2.9, 0.48],
        shared.materials.landmarkStone,
        1.9,
      );
      pillar.castShadow = true;
    });
    [-148, -147.8, -131.2].forEach((pillarX, index) => {
      const pillar = addSurfaceBox(
        `Sutro Baths north gallery ruin pier ${index + 1}`,
        pillarX,
        188.98,
        [0.42, 2.9, 0.48],
        shared.materials.landmarkStone,
        1.9,
      );
      pillar.castShadow = true;
    });
    const sutroFlagPole = addSurfaceBox('Sutro Baths lookout flag pole', -148.2, 184, [0.14, 3.2, 0.14], shared.materials.landmarkStone, 13.9);
    sutroFlagPole.castShadow = false;
    const sutroFlag = addSurfaceBox('Sutro Baths lookout flag', -146.8, 184, [1.7, 0.82, 0.1], shared.materials.landmarkOrange, 16.3);
    sutroFlag.castShadow = false;

    // The first arcade pass read as a small ordinary gallery at the hero
    // distance. Push a larger open ruin frame toward the camera: dark voids,
    // pale piers, and a broken lintel create the recognizable Sutro Baths
    // silhouette without importing a landmark mesh.
    const arcadeShadow = addSurfaceBox(
      'Sutro Baths open arcade shadow field',
      -140,
      178.78,
      [19.4, 5.35, 0.16],
      shared.materials.oceanRock,
      0.5,
    );
    arcadeShadow.castShadow = false;
    [-148.1, -144.1, -140.1, -136.1, -132.1].forEach((columnX, index) => {
      const column = addSurfaceBox(
        `Sutro Baths monumental arcade pier ${index + 1}`,
        columnX,
        178.62,
        [0.66, 5.7, 0.74],
        shared.materials.landmarkStone,
        0.52,
      );
      column.castShadow = true;
      const capital = addSurfaceBox(
        `Sutro Baths monumental arcade capital ${index + 1}`,
        columnX,
        178.62,
        [1.02, 0.32, 0.96],
        shared.materials.landmarkStone,
        6.05,
      );
      capital.castShadow = true;
    });
    [-145.9, -138.3, -130.7].forEach((lintelX, index) => {
      const lintel = addSurfaceBox(
        `Sutro Baths broken arcade lintel ${index + 1}`,
        lintelX,
        178.62,
        [6.3, 0.56, 0.82],
        shared.materials.landmarkStone,
        6.12,
      );
      lintel.castShadow = true;
    });
    [-154.5, -125.5].forEach((wingX, index) => {
      const wing = addSurfaceBox(
        `Sutro Baths ruined side mass ${index + 1}`,
        wingX,
        183.9,
        [3.7, 7.1, 5.8],
        shared.materials.oceanRock,
        0.34,
      );
      wing.castShadow = true;
      const wingCap = addSurfaceBox(
        `Sutro Baths ruined side cap ${index + 1}`,
        wingX,
        183.9,
        [4.2, 0.34, 6.25],
        shared.materials.landmarkStone,
        7.42,
      );
      wingCap.castShadow = true;
    });

    // Windbreak umbrellas add small-scale human colour to the sand without
    // turning the open beach into a repeated prop field.
    [
      { x: -91, z: 122, material: shared.materials.landmarkOrange },
      { x: -113, z: 146, material: shared.materials.trim },
      { x: -101, z: 176, material: shared.materials.landmarkOrange },
    ].forEach(({ x: umbrellaX, z: umbrellaZ, material }, index) => {
      const pole = new THREE.Mesh(shared.pole, shared.materials.signalHousing);
      pole.name = `Ocean Beach windbreak umbrella pole ${index + 1}`;
      pole.position.set(umbrellaX, surfaceAt(umbrellaX, umbrellaZ) + 1.65, umbrellaZ);
      pole.scale.set(0.09, 3.1, 0.09);
      const canopy = new THREE.Mesh(shared.canopy, material);
      canopy.name = `Ocean Beach windbreak umbrella canopy ${index + 1}`;
      canopy.position.set(umbrellaX, surfaceAt(umbrellaX, umbrellaZ) + 3.15, umbrellaZ);
      canopy.scale.set(1.75, 0.82, 1.75);
      canopy.rotation.y = index * 0.42;
      canopy.castShadow = true;
      group.add(pole, canopy);
    });

    // Human-scale beach furniture breaks the near sand without turning the
    // open shore into a prop carpet. Repeated pieces share instanced draws so
    // the authored landmark remains cheap during a streamed handoff.
    const benchSeat = createInstancedMesh(shared.box, shared.materials.boardwalk, 4, 'Ocean Beach public bench seats');
    const benchBack = createInstancedMesh(shared.box, shared.materials.boardwalk, 4, 'Ocean Beach public bench backs');
    const benchLeg = createInstancedMesh(shared.box, shared.materials.signalHousing, 8, 'Ocean Beach public bench legs');
    const beachBinGeometry = new THREE.CylinderGeometry(0.36, 0.42, 1, 8);
    const beachBinLidGeometry = new THREE.CylinderGeometry(0.42, 0.42, 0.12, 8);
    const beachBins = createInstancedMesh(beachBinGeometry, shared.materials.signalHousing, 4, 'Ocean Beach public bins');
    const beachBinLids = createInstancedMesh(beachBinLidGeometry, shared.materials.trim, 4, 'Ocean Beach public bin lids');
    const bikeLoopGeometry = new THREE.TorusGeometry(0.62, 0.075, 6, 12);
    const bikeLoops = createInstancedMesh(bikeLoopGeometry, shared.materials.signalHousing, 3, 'Ocean Beach bike rack loops');
    const benchPositions = [
      { x: -78, z: 108, heading: 0.08 },
      { x: -89, z: 145, heading: -0.05 },
      { x: -83, z: 177, heading: 0.1 },
    ];
    benchPositions.forEach(({ x, z, heading }, index) => {
      const y = surfaceAt(x, z);
      setInstanceMatrix(benchSeat, index, [x, y + 0.94, z], [4.4, 0.2, 0.46], heading);
      setInstanceMatrix(benchBack, index, [x, y + 1.62, z + 0.18], [4.4, 0.92, 0.2], heading);
      const legOffset = 1.35;
      setInstanceMatrix(benchLeg, index * 2, [x - legOffset, y + 0.42, z], [0.2, 0.84, 0.2], heading);
      setInstanceMatrix(benchLeg, index * 2 + 1, [x + legOffset, y + 0.42, z], [0.2, 0.84, 0.2], heading);
    });
    [
      [-73, 112],
      [-92, 151],
      [-79, 183],
    ].forEach(([x, z], index) => {
      const y = surfaceAt(x, z);
      setInstanceMatrix(beachBins, index, [x, y + 0.52, z], [1, 1, 1]);
      setInstanceMatrix(beachBinLids, index, [x, y + 1.06, z], [1, 1, 1]);
    });
    [-68, -86, -104].forEach((x, index) => {
      const z = 128 + index * 2.8;
      const y = surfaceAt(x, z);
      setInstanceMatrix(bikeLoops, index, [x, y + 0.82, z], [1, 1, 0.28]);
    });
    benchSeat.count = benchPositions.length;
    benchBack.count = benchPositions.length;
    benchLeg.count = benchPositions.length * 2;
    beachBins.count = 3;
    beachBinLids.count = 3;
    bikeLoops.count = 3;
    [benchSeat, benchBack, benchLeg, beachBins, beachBinLids, bikeLoops].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    });

    // A small Ocean Beach utility block gives the public realm a believable
    // service edge and adds a stronger color/value stop than another sand
    // plane. It is deliberately modest so the lifeguard station stays the
    // red focal prop.
    const restroom = addSurfaceBox('Ocean Beach public restroom block', -115, 132, [6.4, 2.7, 4.8], shared.materials.landmarkStone, 0.02);
    restroom.castShadow = true;
    const restroomRoof = addSurfaceBox('Ocean Beach public restroom roof', -115, 132, [6.9, 0.24, 5.3], shared.materials.boardwalk, 2.82);
    restroomRoof.castShadow = true;
    const restroomDoor = addSurfaceBox('Ocean Beach public restroom door', -111.72, 132, [0.12, 1.75, 0.92], shared.materials.door, 0.46);
    restroomDoor.castShadow = false;
    const restroomVent = addSurfaceBox('Ocean Beach public restroom vent band', -111.68, 132, [0.1, 0.42, 2.5], shared.materials.window, 1.8);
    restroomVent.castShadow = false;

    // The low, repetitive Sunset residential edge should remain visible
    // behind the park in wider approaches. Muted rowhouse masses plus a
    // single window rhythm are enough to distinguish the neighborhood from
    // an empty coastal test plate.
    const ridgeBodies = createInstancedMesh(shared.box, shared.materials.landmarkBrick, 7, 'Outer Sunset residential ridge');
    const ridgeRoofs = createInstancedMesh(shared.box, shared.materials.landmarkOrange, 7, 'Outer Sunset residential ridge roofs');
    const ridgeWindows = createInstancedMesh(shared.window, shared.materials.window, 14, 'Outer Sunset residential ridge windows');
    [-42, -28, -14, 0, 14, 28, 42].forEach((x, index) => {
      const z = 184 + (index % 2) * 5;
      const y = surfaceAt(x, z);
      const width = index % 3 === 0 ? 10.2 : 8.8;
      const height = 5.8 + (index % 3) * 0.7;
      setInstanceMatrix(ridgeBodies, index, [x, y + height * 0.5, z], [width, height, 7.2]);
      setInstanceMatrix(ridgeRoofs, index, [x, y + height + 0.18, z], [width + 0.5, 0.26, 7.6]);
      setInstanceMatrix(ridgeWindows, index * 2, [x - width * 0.23, y + 2.15, z - 3.64], [1.15, 1.0, 0.08]);
      setInstanceMatrix(ridgeWindows, index * 2 + 1, [x + width * 0.23, y + 2.15, z - 3.64], [1.15, 1.0, 0.08]);
    });
    ridgeBodies.count = 7;
    ridgeRoofs.count = 7;
    ridgeWindows.count = 14;
    [ridgeBodies, ridgeRoofs, ridgeWindows].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    });

    // Parked curbside cars make the Great Highway edge read as a lived public
    // road even when the active streamed traffic pool is looking elsewhere.
    // They use three shared instanced meshes and remain purely visual; live
    // lane ownership continues to belong to traffic.js.
    const parkedCarBodies = createInstancedMesh(shared.box, shared.materials.landmarkBrick, 3, 'Outer Sunset parked car bodies');
    const parkedCarRoofs = createInstancedMesh(shared.box, shared.materials.window, 3, 'Outer Sunset parked car windows');
    const parkedCarWheelGeometry = new THREE.CylinderGeometry(0.38, 0.38, 0.18, 8);
    parkedCarWheelGeometry.rotateZ(Math.PI * 0.5);
    const parkedCarWheels = createInstancedMesh(parkedCarWheelGeometry, shared.materials.signalHousing, 12, 'Outer Sunset parked car wheels');
    [108, 148, 188].forEach((z, index) => {
      const x = -43;
      const y = surfaceAt(x, z);
      setInstanceMatrix(parkedCarBodies, index, [x, y + 0.58, z], [2.35, 0.78, 4.6]);
      setInstanceMatrix(parkedCarRoofs, index, [x, y + 1.08, z], [1.55, 0.34, 2.55]);
      [-1, 1].forEach((wheelSide) => {
        [-1.45, 1.45].forEach((wheelAlong) => {
          setInstanceMatrix(
            parkedCarWheels,
            index * 4 + (wheelSide < 0 ? 0 : 2) + (wheelAlong < 0 ? 0 : 1),
            [x + wheelSide * 1.12, y + 0.42, z + wheelAlong],
            [1, 1, 1],
          );
        });
      });
    });
    parkedCarBodies.count = 3;
    parkedCarRoofs.count = 3;
    parkedCarWheels.count = 12;
    [parkedCarBodies, parkedCarRoofs, parkedCarWheels].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    });

    const accessPost = addSurfaceBox('Ocean Beach boardwalk access post', -99.1, 91, [0.2, 2.9, 0.2], shared.materials.landmarkStone, 0.28);
    accessPost.castShadow = true;
    const accessSign = addSurfaceBox('OCEAN BEACH boardwalk access sign', -98.35, 91, [3.4, 1.05, 0.16], shared.materials.landmarkOrange, 3.02);
    accessSign.castShadow = true;

    // Ocean Beach's N-Judah terminus and the Great Highway are the strongest
    // neighborhood-scale wayfinding cues missing from a generic beach plate.
    // Keep them compact and physical: a shelter roof, curb bench, transit
    // pole, and two readable plates survive the road-scale camera without
    // turning the landmark into HUD text.
    const createBeachWayfindingMaterial = (label, color) => {
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.16,
        roughness: 0.58,
        metalness: 0.08,
      });
      if (typeof document === 'undefined') return material;
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = 184;
      const context = canvas.getContext('2d');
      if (!context) return material;
      context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = '#f5e6c9';
      context.lineWidth = 10;
      context.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
      context.fillStyle = '#fff7e6';
      context.font = '700 50px Arial, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, canvas.width * 0.5, canvas.height * 0.53);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      material.map = texture;
      material.needsUpdate = true;
      return material;
    };
    const nJudahSignMaterial = createBeachWayfindingMaterial('N JUDAH · OCEAN BEACH', 0x315f72);
    const greatHighwaySignMaterial = createBeachWayfindingMaterial('GREAT HIGHWAY · PACIFIC', 0x8c4939);
    const sutroSignMaterial = createBeachWayfindingMaterial('SUTRO BATHS · CLIFF HOUSE', 0x52666a);
    const terminusX = -38;
    const terminusZ = 102;
    const shelterRoof = addSurfaceBox(
      'Ocean Beach N Judah terminus shelter roof',
      terminusX,
      terminusZ,
      [8.6, 0.22, 3.4],
      shared.materials.boardwalk,
      3.05,
    );
    shelterRoof.castShadow = true;
    [-3.7, 3.7].forEach((postOffset, index) => {
      const post = addSurfaceBox(
        `Ocean Beach N Judah shelter post ${index + 1}`,
        terminusX + postOffset,
        terminusZ,
        [0.18, 2.7, 0.18],
        shared.materials.signalHousing,
        0.3,
      );
      post.castShadow = true;
    });
    const shelterBench = addSurfaceBox(
      'Ocean Beach N Judah terminus bench',
      terminusX,
      terminusZ + 0.72,
      [6.2, 0.26, 0.52],
      shared.materials.boardwalk,
      0.82,
    );
    shelterBench.castShadow = true;
    const nJudahSign = addSurfaceBox(
      'Ocean Beach N Judah terminus route plate',
      terminusX - 3.2,
      terminusZ - 0.04,
      [4.2, 1.05, 0.14],
      nJudahSignMaterial,
      3.62,
    );
    nJudahSign.castShadow = false;
    const highwaySign = addSurfaceBox(
      'Great Highway Pacific wayfinding plate',
      -26,
      77,
      [4.8, 0.94, 0.14],
      greatHighwaySignMaterial,
      3.18,
    );
    highwaySign.castShadow = false;
    const sutroSign = addSurfaceBox(
      'Sutro Baths physical wayfinding plate',
      -140,
      175.18,
      [11.2, 1.18, 0.16],
      sutroSignMaterial,
      7.12,
    );
    sutroSign.castShadow = false;
    [-145.1, -134.9].forEach((postX, index) => {
      const post = addSurfaceBox(
        `Sutro Baths wayfinding sign post ${index + 1}`,
        postX,
        175.18,
        [0.18, 2.15, 0.18],
        shared.materials.signalHousing,
        5.02,
      );
      post.castShadow = true;
    });

    // The N-Judah is a street-running Muni line, not just a destination label.
    // A short, low-poly track throat, catenary span, and parked tram make the
    // route legible in the world while remaining a visual landmark: live
    // vehicle ownership and signal timing stay in traffic.js.
    const transitRailMaterial = new THREE.MeshStandardMaterial({
      color: 0x293538,
      roughness: 0.36,
      metalness: 0.68,
    });
    const transitWireMaterial = new THREE.MeshStandardMaterial({
      color: 0x3f4b4d,
      roughness: 0.42,
      metalness: 0.72,
    });
    const trackZ = terminusZ;
    [-1.12, 1.12].forEach((railOffset, index) => {
      const rail = addSurfaceStrip(
        `Ocean Beach N Judah rail ${index + 1}`,
        [-70, trackZ + railOffset],
        [28, trackZ + railOffset],
        0.16,
        transitRailMaterial,
        0.14,
        14,
      );
      rail.castShadow = true;
      rail.receiveShadow = true;
    });
    for (let sleeperX = -66; sleeperX <= 24; sleeperX += 9) {
      const sleeper = addSurfaceBox(
        'Ocean Beach N Judah track sleeper',
        sleeperX,
        trackZ,
        [1.45, 0.12, 3.35],
        shared.materials.boardwalk,
        0.08,
      );
      sleeper.castShadow = false;
    }
    [-60, -30, 0, 26].forEach((poleX, index) => {
      const pole = addSurfaceBox(
        `Ocean Beach N Judah catenary pole ${index + 1}`,
        poleX,
        trackZ,
        [0.18, 6.2, 0.18],
        transitWireMaterial,
        0.1,
      );
      pole.castShadow = true;
      const crossarm = addSurfaceBox(
        `Ocean Beach N Judah catenary crossarm ${index + 1}`,
        poleX,
        trackZ,
        [3.1, 0.1, 0.1],
        transitWireMaterial,
        6.12,
      );
      crossarm.castShadow = false;
    });
    [-60, -30, 0].forEach((wireStart, index) => {
      const wireEnd = [-30, 0, 26][index];
      const wire = new THREE.Mesh(shared.box, transitWireMaterial);
      wire.name = `Ocean Beach N Judah overhead wire ${index + 1}`;
      wire.position.set(
        (wireStart + wireEnd) * 0.5,
        surfaceAt((wireStart + wireEnd) * 0.5, trackZ) + 6.38,
        trackZ,
      );
      wire.scale.set(wireEnd - wireStart, 0.075, 0.075);
      wire.castShadow = false;
      group.add(wire);
    });

    const transitBodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xb95f43,
      roughness: 0.62,
      metalness: 0.1,
    });
    const transitStripeMaterial = new THREE.MeshStandardMaterial({
      color: 0xe7c47f,
      roughness: 0.48,
      metalness: 0.08,
    });
    const tram = new THREE.Group();
    tram.name = 'Ocean Beach N Judah low-poly Muni tram';
    const tramX = -52;
    const tramY = surfaceAt(tramX, trackZ);
    const tramBody = new THREE.Mesh(shared.box, transitBodyMaterial);
    tramBody.position.set(tramX, tramY + 1.24, trackZ);
    tramBody.scale.set(12.2, 1.58, 2.36);
    tramBody.castShadow = true;
    const tramRoof = new THREE.Mesh(shared.box, transitStripeMaterial);
    tramRoof.position.set(tramX, tramY + 2.09, trackZ);
    tramRoof.scale.set(12.65, 0.18, 2.52);
    tramRoof.castShadow = true;
    const tramWindowBand = new THREE.Mesh(shared.box, shared.materials.window);
    tramWindowBand.position.set(tramX, tramY + 1.66, trackZ - 1.2);
    tramWindowBand.scale.set(9.6, 0.56, 0.08);
    tramWindowBand.castShadow = false;
    [-4.25, -1.42, 1.42, 4.25].forEach((windowX, index) => {
      const window = new THREE.Mesh(shared.box, shared.materials.window);
      window.name = `Ocean Beach N Judah tram side window ${index + 1}`;
      window.position.set(tramX + windowX, tramY + 1.67, trackZ - 1.27);
      window.scale.set(2.08, 0.62, 0.08);
      window.castShadow = false;
      tram.add(window);
    });
    [-2.82, 2.82].forEach((doorX, index) => {
      const door = new THREE.Mesh(shared.box, transitStripeMaterial);
      door.name = `Ocean Beach N Judah tram side door ${index + 1}`;
      door.position.set(tramX + doorX, tramY + 1.12, trackZ - 1.285);
      door.scale.set(0.88, 1.18, 0.07);
      door.castShadow = false;
      tram.add(door);
    });
    const tramFront = new THREE.Mesh(shared.box, transitStripeMaterial);
    tramFront.position.set(tramX - 6.2, tramY + 1.2, trackZ);
    tramFront.scale.set(0.22, 1.16, 2.06);
    tramFront.castShadow = true;
    const tramFrontGlass = new THREE.Mesh(shared.box, shared.materials.window);
    tramFrontGlass.name = 'Ocean Beach N Judah tram front windshield';
    tramFrontGlass.position.set(tramX - 6.34, tramY + 1.68, trackZ);
    tramFrontGlass.scale.set(0.08, 0.62, 1.38);
    tramFrontGlass.castShadow = false;
    const tramBumper = new THREE.Mesh(shared.box, transitRailMaterial);
    tramBumper.position.set(tramX - 6.38, tramY + 0.55, trackZ);
    tramBumper.scale.set(0.16, 0.22, 1.28);
    tramBumper.castShadow = false;
    const tramRoutePlate = new THREE.Mesh(shared.box, nJudahSignMaterial);
    tramRoutePlate.name = 'Ocean Beach N Judah tram route plate';
    tramRoutePlate.position.set(tramX, tramY + 2.13, trackZ - 1.3);
    tramRoutePlate.scale.set(3.25, 0.42, 0.08);
    tramRoutePlate.castShadow = false;
    const tramLampMaterial = new THREE.MeshStandardMaterial({
      color: 0xffe5aa,
      emissive: 0xffb14a,
      emissiveIntensity: 0.72,
      roughness: 0.34,
    });
    const tramLamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), tramLampMaterial);
    tramLamp.name = 'Ocean Beach N Judah tram headlamp';
    tramLamp.position.set(tramX - 6.48, tramY + 0.82, trackZ - 0.58);
    tramLamp.castShadow = false;
    tram.add(
      tramBody,
      tramRoof,
      tramWindowBand,
      tramFront,
      tramFrontGlass,
      tramBumper,
      tramRoutePlate,
      tramLamp,
    );
    const tramWheelGeometry = new THREE.CylinderGeometry(0.4, 0.4, 0.16, 8);
    tramWheelGeometry.rotateX(Math.PI * 0.5);
    [-3.8, 3.8].forEach((wheelX) => {
      [-1, 1].forEach((side) => {
        const wheel = new THREE.Mesh(tramWheelGeometry, transitRailMaterial);
        wheel.name = `Ocean Beach N Judah tram exposed wheel ${wheelX < 0 ? 'rear' : 'front'} ${side < 0 ? 'near' : 'far'}`;
        wheel.position.set(tramX + wheelX, tramY + 0.42, trackZ + side * 1.25);
        wheel.castShadow = true;
        tram.add(wheel);
      });
    });
    // A small pantograph makes the parked vehicle belong to the overhead
    // system instead of reading as a disconnected red block.
    const pantographStem = new THREE.Mesh(shared.box, transitWireMaterial);
    pantographStem.name = 'Ocean Beach N Judah tram pantograph stem';
    pantographStem.position.set(tramX + 0.6, tramY + 4.2, trackZ);
    pantographStem.scale.set(0.1, 4.0, 0.1);
    pantographStem.castShadow = false;
    const pantographArm = new THREE.Mesh(shared.box, transitWireMaterial);
    pantographArm.name = 'Ocean Beach N Judah tram pantograph arm';
    pantographArm.position.set(tramX + 0.6, tramY + 6.18, trackZ);
    pantographArm.scale.set(1.7, 0.1, 0.1);
    pantographArm.castShadow = false;
    tram.add(pantographStem, pantographArm);
    group.add(tram);

    // Wind-bent dune clusters keep the seawall edge from reading as a single
    // hard line while staying deliberately smaller than street trees.
    [
      [-121, 72, 0.9],
      [-124, 94, 0.72],
      [-120, 134, 0.82],
      [-124, 164, 0.68],
      [-119, 184, 0.78],
    ].forEach(([grassX, grassZ, scale], index) => {
      const trunk = new THREE.Mesh(shared.trunk, shared.materials.trunk);
      trunk.name = `Ocean Beach dune grass stem ${index + 1}`;
      trunk.position.set(grassX, surfaceAt(grassX, grassZ) + 0.75 * scale, grassZ);
      trunk.scale.set(0.12 * scale, 1.5 * scale, 0.12 * scale);
      const tuft = new THREE.Mesh(shared.canopy, shared.materials.tree);
      tuft.name = `Ocean Beach dune grass tuft ${index + 1}`;
      tuft.position.set(grassX, surfaceAt(grassX, grassZ) + 1.65 * scale, grassZ);
      tuft.scale.set(0.7 * scale, 1.8 * scale, 0.7 * scale);
      tuft.rotation.z = (index % 2 ? -1 : 1) * 0.14;
      group.add(trunk, tuft);
    });

    const lifeguardDeck = addSurfaceBox('Ocean Beach lifeguard station deck', -132, 111, [6.6, 0.3, 5.4], shared.materials.landmarkStone, 0.08);
    lifeguardDeck.castShadow = true;
    const lifeguardCabin = addSurfaceBox('Ocean Beach low-poly lifeguard station', -132, 111, [4.1, 3.4, 3.4], shared.materials.landmarkOrange, 0.38);
    lifeguardCabin.castShadow = true;
    const lifeguardRoof = addSurfaceBox('Ocean Beach lifeguard station roof', -132, 111, [4.8, 0.32, 4.1], shared.materials.trim, 3.78);
    lifeguardRoof.castShadow = true;
    const lifeguardPole = addSurfaceBox('Ocean Beach lifeguard flag pole', -130.6, 111, [0.16, 3.8, 0.16], shared.materials.landmarkStone, 3.95);
    lifeguardPole.castShadow = true;
    const lifeguardFlag = addSurfaceBox('Ocean Beach lifeguard flag', -129.1, 111, [2.2, 1.05, 0.12], shared.materials.landmarkOrange, 6.18);
    lifeguardFlag.castShadow = true;
    [-1, 1].forEach((windowSide) => {
      const window = addSurfaceBox(
        `Ocean Beach lifeguard station window ${windowSide < 0 ? 'north' : 'south'}`,
        -129.86,
        111 + windowSide * 0.88,
        [0.1, 1.1, 0.72],
        shared.materials.window,
        1.85,
      );
      window.castShadow = false;
    });
    const streetOcean = addSurfaceBox('Outer Sunset street-side Pacific inlet', -68, 70, [22, 0.12, 18], shared.materials.water);
    streetOcean.receiveShadow = true;
    const streetOceanLine = addSurfaceBox('Outer Sunset street-side waterline', -68, 81, [22, 0.1, 0.6], shared.materials.water, 0.02);
    streetOceanLine.receiveShadow = true;
    const avenueOcean = addSurfaceStrip('Outer Sunset avenue Pacific horizon', [-188, 184], [-160, 184], 16, shared.materials.water, 0.55, 24);
    avenueOcean.receiveShadow = true;
  } else if (blueprint.landmark === 'dragon-gate') {
    // Chinatown: ceremonial paifang on Grant plus a tight Portsmouth Square void.
    const gateX = -64;
    const gateZ = -170;
    const base = surfaceAt(gateX, gateZ);
    const plazaX = -20;
    const plazaZ = -40;
    const plaza = addSurfaceBox('Portsmouth Square plaza void', plazaX, plazaZ, [34, 0.22, 28], shared.materials.sidewalk);
    plaza.receiveShadow = true;
    const green = addSurfaceBox('Portsmouth Square green band', plazaX, plazaZ + 2, [18, 0.16, 12], shared.materials.park, 0.08);
    green.receiveShadow = true;
    const leftPier = addSurfaceBox('Dragon Gate left pier', gateX - 5.2, gateZ, [2.4, 9.5, 2.6], shared.materials.landmarkStone);
    const rightPier = addSurfaceBox('Dragon Gate right pier', gateX + 5.2, gateZ, [2.4, 9.5, 2.6], shared.materials.landmarkStone);
    leftPier.castShadow = true;
    rightPier.castShadow = true;
    const beam = addSurfaceBox('Dragon Gate lintel beam', gateX, gateZ, [14.5, 1.4, 2.2], shared.materials.landmarkOrange, 9.2);
    beam.castShadow = true;
    const roof = addSurfaceBox('Dragon Gate tiled roof plate', gateX, gateZ, [16.5, 0.7, 3.4], shared.materials.landmarkOrange, 10.7);
    roof.castShadow = true;
    const ridge = addSurfaceBox('Dragon Gate ridge crest', gateX, gateZ, [17.2, 0.35, 0.7], shared.materials.landmarkBrick, 11.35);
    ridge.castShadow = true;
    [-4.2, 0, 4.2].forEach((offset, index) => {
      const lantern = addSurfaceBox(
        `Dragon Gate lantern ${index + 1}`,
        gateX + offset,
        gateZ - 1.1,
        [0.7, 1.1, 0.7],
        shared.materials.landmarkOrange,
        7.4,
      );
      lantern.castShadow = true;
    });
    // Dense canopy rhythm along Grant keeps Chinatown readable at street scale.
    for (let z = -150; z <= -20; z += 22) {
      const canopy = addSurfaceBox('Grant Avenue storefront canopy', gateX, z, [10.5, 0.28, 3.2], shared.materials.landmarkOrange, 3.6);
      canopy.castShadow = true;
    }
    landmark = {
      x: gateX,
      z: gateZ,
      width: 16,
      depth: 6,
      height: 12,
      style: 'landmark',
      heading: 0,
      baseY: base,
      label: 'Chinatown Dragon Gate',
    };
  } else if (blueprint.landmark === 'grace-cathedral') {
    // Nob Hill: long limestone nave + paired hotel crowns on the ridge.
    const x = -40;
    const z = -20;
    const base = surfaceAt(x, z);
    const nave = addSurfaceBox('Grace Cathedral nave', x, z, [18, 22, 46], shared.materials.landmarkStone);
    nave.castShadow = true;
    const tower = addSurfaceBox('Grace Cathedral west tower', x - 8, z - 18, [8, 34, 8], shared.materials.landmarkStone);
    tower.castShadow = true;
    const spire = new THREE.Mesh(new THREE.ConeGeometry(4.2, 8, 4), shared.materials.landmarkOrange);
    spire.name = 'Grace Cathedral spire';
    spire.position.set(x - 8, base + 40, z - 18);
    spire.rotation.y = Math.PI * 0.25;
    spire.castShadow = true;
    group.add(spire);
    const green = addSurfaceBox('Huntington park green', x + 8, z + 6, [28, 0.28, 22], shared.materials.park);
    green.receiveShadow = true;
    const fairmont = addSurfaceBox('Fairmont hotel crown mass', 80, -10, [22, 42, 20], shared.materials.landmarkStone);
    fairmont.castShadow = true;
    const fairmontRoof = addSurfaceBox('Fairmont mansard crown', 80, -10, [24, 4.5, 22], shared.materials.landmarkOrange, 42);
    fairmontRoof.castShadow = true;
    const mark = addSurfaceBox('Mark Hopkins hotel crown mass', 96, 8, [18, 38, 18], shared.materials.landmarkStone);
    mark.castShadow = true;
    const markRoof = addSurfaceBox('Mark Hopkins mansard crown', 96, 8, [20, 4.2, 20], shared.materials.landmarkOrange, 38);
    markRoof.castShadow = true;
    // Light cable-track cue on California ridge.
    const railPositions = [];
    addStrip(railPositions, null, [-170, -70], [170, -55], 0.16, surfaceAt, SURFACE_OFFSET + 0.05, null, 20);
    group.add(createSurfaceMesh('Nob Hill California cable slot', railPositions, null, shared.materials.signalHousing));
    landmark = {
      x,
      z,
      width: 20,
      depth: 48,
      height: 34,
      style: 'landmark',
      heading: 0,
      baseY: base,
      label: 'Grace Cathedral',
    };
  } else if (blueprint.landmark === 'lombard-switchback') {
    // Russian Hill: crooked Lombard garden street as prop path + stair park void.
    const x = 80;
    const z = 176;
    const base = surfaceAt(x, z);
    const park = addSurfaceBox('Ina Coolbrith stair park void', -20, 40, [22, 0.24, 18], shared.materials.park);
    park.receiveShadow = true;
    // Zigzag garden road prop — not part of the traffic spine graph.
    const zig = [
      [40, 168],
      [58, 176],
      [76, 168],
      [94, 176],
      [112, 184],
      [120, 192],
    ];
    for (let index = 1; index < zig.length; index += 1) {
      const start = zig[index - 1];
      const end = zig[index];
      const segment = addSurfaceStrip(
        `Lombard switchback segment ${index}`,
        start,
        end,
        9,
        shared.materials.sidewalk,
        0.05,
        10,
      );
      segment.receiveShadow = true;
      const hedge = addSurfaceStrip(
        `Lombard hedge band ${index}`,
        start,
        end,
        1.2,
        shared.materials.park,
        0.22,
        10,
      );
      hedge.receiveShadow = true;
    }
    // Stair-street cue down the hillside.
    for (let step = 0; step < 8; step += 1) {
      const stepZ = 40 - step * 3.2;
      const tread = addSurfaceBox(
        `Russian Hill stair tread ${step + 1}`,
        -20,
        stepZ,
        [6.5, 0.28, 2.4],
        shared.materials.landmarkStone,
        step * 0.35,
      );
      tread.castShadow = true;
    }
    const overlook = addSurfaceBox('Russian Hill overlook pad', x, z, [14, 0.4, 10], shared.materials.landmarkStone);
    overlook.castShadow = true;

    // Hyde encounter slice: three ordinary blocks (about 146 m from
    // z=-105 to z=41) sit on the existing raised sidewalks.  The modules are
    // shallow street-wall cues rather than a second massing system; each uses
    // the pooled box/window materials and follows the same local grade as the
    // streamed road surface.  Alternating families keep the corridor legible
    // at eye level without filling the whole Russian Hill sector with bespoke
    // meshes.
    const hydeGradeAt = (xAt, zAt, span = 12) => (
      (surfaceAt(xAt, zAt + span) - surfaceAt(xAt, zAt - span)) / (span * 2)
    );
    const hydeFacade = ({ family, side, z: facadeZ, width, height, body, roof, accent, photoMaterials, photoFamilyIndex }) => {
      const x = side < 0 ? -82 : -54;
      const facing = side < 0 ? 1 : -1;
      const baseY = surfaceAt(x, facadeZ);
      const facade = new THREE.Group();
      facade.name = `Hyde corridor ${family} facade ${facadeZ}`;
      facade.position.set(x, baseY, facadeZ);
      facade.userData.encounterGrade = HYDE_MEASURED_GRADE;
      facade.userData.measuredGrade = HYDE_MEASURED_GRADE;
      // Follow the sampled terrain grade at each block.  The shared profile
      // owns the exact vertical datum; using a local finite difference keeps
      // both ends of a long frontage seated on that datum with no float or
      // buried corner when the analytic terrain adds its gentle cross-slope.
      facade.rotation.x = -Math.atan(hydeGradeAt(x, facadeZ, width * 0.5));
      const part = (name, scale, px, py, pz, material, rotationY = 0) => {
        const mesh = new THREE.Mesh(shared.box, material);
        mesh.name = name;
        mesh.position.set(px, py + scale[1] * 0.5, pz);
        mesh.scale.set(scale[0], scale[1], scale[2]);
        mesh.rotation.y = rotationY;
        mesh.userData.facadeFamily = family;
        facade.add(mesh);
        return mesh;
      };

      part(`${family} grounded plinth`, [4.0, 0.42, width], 0, 0, 0, shared.materials.landmarkStone);
      part(`${family} body`, [3.5, height, width - 0.8], 0, 0.42, 0, body);
      part(`${family} roof cap`, [3.9, 0.34, width + 0.4], 0, 0.42 + height, 0, roof);

      const frontX = facing * 1.82;
      // The photo carries its own aligned window rhythm; suppress the old
      // flat front window bands so they do not fight the photographic skin.
      // Keep the low-poly body, cornice, and family-specific depth cues below.
      const photoBayWidth = 7.6;
      const photoBayHeight = height - 0.38;
      const photoBayCenters = [-12, -4, 4, 12];
      photoBayCenters.forEach((bayCenter, bayIndex) => {
        const photoPanel = new THREE.Mesh(
          shared.facadePanel,
          photoMaterials?.[bayIndex % photoMaterials.length] ?? shared.materials.landmarkStone,
        );
        photoPanel.name = `${family} road-facing Edwardian photo bay ${bayIndex + 1}`;
        photoPanel.position.set(
          frontX + facing * 0.045,
          0.42 + photoBayHeight * 0.5,
          bayCenter,
        );
        photoPanel.rotation.y = facing * Math.PI * 0.5;
        photoPanel.scale.set(photoBayWidth, photoBayHeight, 1);
        photoPanel.userData.facadeFamily = family;
        photoPanel.userData.facadePhoto = true;
        photoPanel.userData.photoBayWidth = photoBayWidth;
        facade.add(photoPanel);

        // Each bay has three outward depth layers: recessed photo, reveal
        // jambs, then projecting casing/sill. The 0.4 m gaps keep the four
        // crops distinct instead of creating a stretched repeating stripe.
        const revealX = frontX + facing * 0.14;
        const casingX = frontX + facing * 0.28;
        const edgeOffset = photoBayWidth * 0.5 + 0.09;
        part(`${family} photo bay ${bayIndex + 1} recessed reveal left`, [0.12, photoBayHeight, 0.08], revealX, 0.42, bayCenter - edgeOffset, shared.materials.trim);
        part(`${family} photo bay ${bayIndex + 1} recessed reveal right`, [0.12, photoBayHeight, 0.08], revealX, 0.42, bayCenter + edgeOffset, shared.materials.trim);
        part(`${family} photo bay ${bayIndex + 1} casing left`, [0.24, photoBayHeight + 0.16, 0.14], casingX, 0.34, bayCenter - edgeOffset, accent);
        part(`${family} photo bay ${bayIndex + 1} casing right`, [0.24, photoBayHeight + 0.16, 0.14], casingX, 0.34, bayCenter + edgeOffset, accent);
        part(`${family} photo bay ${bayIndex + 1} projecting sill`, [0.34, 0.16, photoBayWidth + 0.28], casingX, 0.42 + photoBayHeight - 0.2, bayCenter, shared.materials.trim);

        // Keep the photographic texture intact by day, but break its dense
        // repeated night stripe with a few deterministic, per-bay occupancy
        // panes. These are tiny pooled window meshes, hidden at day and never
        // large enough to read as a broad emissive slab.
        const bayHash = (salt) => {
          const value = Math.sin(
            (facadeZ * 0.73) + (side * 17.1) + (photoFamilyIndex * 29.7)
              + (bayIndex * 11.3) + (salt * 7.9),
          ) * 43758.5453;
          return value - Math.floor(value);
        };
        const litPaneCount = 1 + Math.floor(bayHash(1) * 3);
        for (let paneIndex = 0; paneIndex < litPaneCount; paneIndex += 1) {
          const pane = new THREE.Mesh(
            shared.window,
            shared.materials.facadeNight[(photoFamilyIndex + bayIndex + paneIndex) % shared.materials.facadeNight.length],
          );
          const paneHeight = 0.34 + bayHash(paneIndex + 2) * 0.38;
          const paneY = Math.min(
            0.42 + photoBayHeight - paneHeight * 0.7,
            1.55 + bayHash(paneIndex + 4) * 6.8,
          );
          pane.name = `${family} photo bay ${bayIndex + 1} sparse night pane ${paneIndex + 1}`;
          pane.position.set(
            frontX + facing * 0.105,
            paneY,
            bayCenter + (bayHash(paneIndex + 5) - 0.5) * 4.8,
          );
          pane.scale.set(0.04, paneHeight, 0.38 + bayHash(paneIndex + 6) * 0.42);
          pane.userData.facadeFamily = family;
          pane.userData.facadeNightOverlay = true;
          pane.userData.nightBay = bayIndex + 1;
          pane.userData.nightOccupancy = litPaneCount / 3;
          pane.castShadow = false;
          pane.receiveShadow = false;
          facade.add(pane);
        }
      });

      // A grounded threshold and a small family-specific street treatment
      // keep the frontage from reading as a blank colored slab.
      part(`${family} curb threshold`, [1.52, 0.18, 2.05], frontX + facing * 0.14, 0, 0, shared.materials.sidewalk);
      part(`${family} public doorway`, [0.14, 2.12, 1.12], frontX + facing * 0.2, 0.18, 0, shared.materials.door);
      part(`${family} entry header`, [0.18, 0.22, 1.52], frontX + facing * 0.24, 2.45, 0, shared.materials.entryHeader);
      if (family === 'painted-lady') {
        part('painted-lady cornice bay left', [0.34, 0.22, 6.6], frontX + facing * 0.34, 0.42 + height - 0.48, -12, accent);
        part('painted-lady cornice bay right', [0.34, 0.22, 6.6], frontX + facing * 0.34, 0.42 + height - 0.48, 12, accent);
      } else if (family === 'stucco') {
        part('stucco awning band', [0.36, 0.18, width * 0.72], frontX + facing * 0.24, 3.88, 0, accent);
        part('stucco balcony rail', [0.26, 0.1, width * 0.54], frontX + facing * 0.3, 6.55, 0, shared.materials.trim);
      } else {
        part('brick mercantile storefront band', [0.3, 1.28, width * 0.66], frontX + facing * 0.22, 0.72, 0, shared.materials.landmarkOrange);
        part('brick mercantile sign rail', [0.28, 0.18, width * 0.58], frontX + facing * 0.25, 3.88, 0, accent);
      }
      facade.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = !object.userData.facadeNightOverlay;
        object.receiveShadow = !object.userData.facadeNightOverlay;
      });
      group.add(facade);
    };

    [
      { z: -88, family: 'painted-lady', body: shared.materials.landmarkStone, roof: shared.materials.roof, accent: shared.materials.landmarkOrange, photoMaterials: shared.materials.facadePaintedLadyPhotos, photoFamilyIndex: 0 },
      { z: -32, family: 'stucco', body: shared.materials.trim, roof: shared.materials.roof, accent: shared.materials.landmarkStone, photoMaterials: shared.materials.facadeStuccoPhotos, photoFamilyIndex: 1 },
      { z: 24, family: 'brick-mercantile', body: shared.materials.landmarkBrick, roof: shared.materials.roof, accent: shared.materials.landmarkOrange, photoMaterials: shared.materials.facadeBrickPhotos, photoFamilyIndex: 2 },
    ].forEach((module) => {
      [-1, 1].forEach((side) => hydeFacade({ ...module, side, width: 34, height: side < 0 ? 11.2 : 9.6 }));
    });

    const hydeCurbWest = addSurfaceStrip(
      'Hyde corridor west curb cap',
      [-77.95, -106],
      [-77.95, 42],
      0.18,
      shared.materials.curb,
      SURFACE_OFFSET + 0.09,
      24,
    );
    const hydeCurbEast = addSurfaceStrip(
      'Hyde corridor east curb cap',
      [-58.05, -106],
      [-58.05, 42],
      0.18,
      shared.materials.curb,
      SURFACE_OFFSET + 0.09,
      24,
    );
    hydeCurbWest.userData.encounterGrade = HYDE_MEASURED_GRADE;
    hydeCurbEast.userData.encounterGrade = HYDE_MEASURED_GRADE;

    const hydeTree = (name, xTree, zTree, scale = 1) => {
      const tree = new THREE.Group();
      tree.name = name;
      tree.position.set(xTree, surfaceAt(xTree, zTree), zTree);
      tree.rotation.x = -Math.atan(hydeGradeAt(xTree, zTree, 4));
      const trunk = new THREE.Mesh(shared.trunk, shared.materials.trunk);
      trunk.name = `${name} grounded trunk`;
      trunk.position.y = 1.08 * scale;
      trunk.scale.set(0.24 * scale, 2.16 * scale, 0.24 * scale);
      const canopy = new THREE.Mesh(shared.canopy, shared.materials.tree);
      canopy.name = `${name} canopy`;
      canopy.position.y = 4.1 * scale;
      canopy.scale.set(2.15 * scale, 4.2 * scale, 2.15 * scale);
      tree.add(trunk, canopy);
      tree.userData.grounded = true;
      tree.userData.encounterGrade = HYDE_MEASURED_GRADE;
      group.add(tree);
    };
    [
      [-76.4, -76, 1.06],
      [-76.4, -20, 0.98],
      [-59.6, 4, 1.02],
      [-59.6, 36, 0.92],
    ].forEach(([treeX, treeZ, scale], index) => {
      hydeTree(`Hyde corridor street tree ${index + 1}`, treeX, treeZ, scale);
    });

    const hydeBench = (name, xBench, zBench, heading = 0) => {
      const bench = new THREE.Group();
      bench.name = name;
      bench.position.set(xBench, surfaceAt(xBench, zBench), zBench);
      bench.rotation.x = -Math.atan(hydeGradeAt(xBench, zBench, 2));
      bench.rotation.y = heading;
      const seat = new THREE.Mesh(shared.box, shared.materials.boardwalk);
      seat.name = `${name} seat`;
      seat.position.y = 0.78;
      seat.scale.set(0.9, 0.18, 3.2);
      const back = new THREE.Mesh(shared.box, shared.materials.boardwalk);
      back.name = `${name} back`;
      back.position.set(0, 1.38, 0.38);
      back.scale.set(0.9, 0.92, 3.2);
      const legA = new THREE.Mesh(shared.box, shared.materials.signalHousing);
      legA.position.set(0, 0.36, -1.06);
      legA.scale.set(0.7, 0.72, 0.18);
      const legB = legA.clone();
      legB.position.z = 0.82;
      bench.add(seat, back, legA, legB);
      bench.userData.grounded = true;
      group.add(bench);
    };
    hydeBench('Hyde corridor public bench north', -76.2, -54, Math.PI * 0.5);
    hydeBench('Hyde corridor public bench south', -59.8, 28, -Math.PI * 0.5);

    const hydrant = new THREE.Group();
    hydrant.name = 'Hyde corridor grounded hydrant';
    hydrant.position.set(-75.8, surfaceAt(-75.8, -4), -4);
    hydrant.rotation.x = -Math.atan(hydeGradeAt(-75.8, -4, 1));
    const hydrantBody = new THREE.Mesh(shared.trunk, shared.materials.landmarkOrange);
    hydrantBody.position.y = 0.58;
    hydrantBody.scale.set(3.2, 1.18, 3.2);
    const hydrantCap = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
    hydrantCap.position.y = 0.93;
    hydrantCap.scale.set(0.32, 0.12, 0.32);
    hydrant.add(hydrantBody, hydrantCap);
    hydrant.userData.grounded = true;
    group.add(hydrant);

    landmark = {
      x,
      z,
      width: 14,
      depth: 12,
      height: 6,
      style: 'landmark',
      heading: 0,
      baseY: base,
      label: 'Lombard Street switchback',
    };
  } else if (blueprint.landmark === 'palace-of-fine-arts') {
    // Marina: rotunda + colonnade, Marina Green lawn, north bay shelf.
    const x = -150;
    const z = 20;
    const base = surfaceAt(x, z);
    const lagoon = addSurfaceBox('Palace of Fine Arts lagoon', x + 18, z + 8, [36, 0.14, 28], shared.materials.water);
    lagoon.receiveShadow = true;
    const green = addSurfaceBox('Marina Green lawn strip', 0, 150, [180, 0.2, 36], shared.materials.park);
    green.receiveShadow = true;
    const rotunda = new THREE.Mesh(new THREE.CylinderGeometry(10, 12, 8, 10), shared.materials.landmarkStone);
    rotunda.name = 'Palace of Fine Arts rotunda drum';
    rotunda.position.set(x, base + 8, z);
    rotunda.castShadow = true;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(11, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), shared.materials.landmarkStone);
    dome.name = 'Palace of Fine Arts dome';
    dome.position.set(x, base + 14, z);
    dome.castShadow = true;
    group.add(rotunda, dome);
    [-22, -11, 0, 11, 22].forEach((offset, index) => {
      const column = addSurfaceBox(
        `Palace of Fine Arts colonnade ${index + 1}`,
        x + 28,
        z + offset,
        [1.4, 12, 1.4],
        shared.materials.landmarkStone,
      );
      column.castShadow = true;
    });
    const entablature = addSurfaceBox('Palace of Fine Arts colonnade beam', x + 28, z, [3.2, 1.2, 48], shared.materials.landmarkStone, 12);
    entablature.castShadow = true;
    // Thin north bay shelf + seawall for Marina Green frontage.
    const bay = addSurfaceStrip('Marina Green bay water shelf', [-180, 184], [180, 184], 22, shared.materials.water, 0.12, 28);
    bay.receiveShadow = true;
    const seawall = addSurfaceBox('Marina Green seawall', 0, 176, [180, 0.9, 1.4], shared.materials.landmarkStone, 0.05);
    seawall.castShadow = true;
    const promenade = addSurfaceBox('Marina Green promenade', 0, 168, [176, 0.28, 10], shared.materials.sidewalk);
    promenade.receiveShadow = true;
    // Fisherman's Wharf / Pier 39 proxy cards — NE bay silhouettes, not a full sector.
    [
      { x: 96, z: 188, w: 22, d: 8, h: 6 },
      { x: 128, z: 190, w: 18, d: 7, h: 5 },
      { x: 152, z: 186, w: 26, d: 9, h: 7 },
    ].forEach(({ x: px, z: pz, w, d, h }, index) => {
      const pier = addSurfaceBox(`Fishermans Wharf pier card ${index + 1}`, px, pz, [w, h, d], shared.materials.landmarkStone, 0.4);
      pier.castShadow = true;
      const finger = addSurfaceBox(`Fishermans Wharf finger ${index + 1}`, px, pz + 10, [w * 0.7, 0.35, 12], shared.materials.boardwalk, 0.5);
      finger.castShadow = true;
    });
    // Distant GGB tower cards NW of Marina Green.
    [-160, -140].forEach((tx, index) => {
      const tower = addSurfaceBox(
        `Marina GGB tower cue ${index + 1}`,
        tx,
        195,
        [4.5, 28 + index * 4, 4.5],
        shared.materials.landmarkOrange,
        1.2,
      );
      tower.castShadow = true;
    });
    const deck = addSurfaceBox('Marina GGB deck cue', -150, 195, [28, 1.2, 3.2], shared.materials.landmarkOrange, 14);
    deck.castShadow = true;
    landmark = {
      x,
      z,
      width: 28,
      depth: 28,
      height: 24,
      style: 'landmark',
      heading: 0,
      baseY: base,
      label: 'Palace of Fine Arts',
    };
  } else if (blueprint.landmark === 'transamerica-pyramid') {
    // Embarcadero street pack: pyramid, Redwood Park, block sidewalks, ferry
    // bulkhead, and pier sheds every ~48 m along the waterfront.
    const x = 40;
    const z = 90;
    const base = surfaceAt(x, z);
    // Anchor the pyramid on the west side of the centered waterfront vista.
    // Keep the existing canyon/park pack at its source coordinates while the
    // landmark itself shares the clear sightline ray through the z≈0 gap.
    const pyramidX = -120;
    const pyramidZ = 0;
    const pyramidBase = surfaceAt(pyramidX, pyramidZ);
    const podium = addSurfaceBox(
      'Transamerica plaza podium',
      pyramidX,
      pyramidZ,
      [32, 9, 32],
      shared.materials.landmarkDarkPodium,
    );
    podium.castShadow = true;
    // A stepped, warm stone base and contrasting dark-red tapered body keep
    // the pyramid readable as a landmark instead of a generic window proxy.
    const pyramidBaseTier = addSurfaceBox(
      'Transamerica plaza lower stepped tier',
      pyramidX,
      pyramidZ,
      [38, 2.2, 38],
      shared.materials.transamericaAccent,
      9,
    );
    pyramidBaseTier.castShadow = true;
    const pyramidUpperTier = addSurfaceBox(
      'Transamerica plaza upper stepped tier',
      pyramidX,
      pyramidZ,
      [30, 1.35, 30],
      shared.materials.landmarkDarkPodium,
      11.2,
    );
    pyramidUpperTier.castShadow = true;
    const pyramid = new THREE.Mesh(new THREE.ConeGeometry(18, 118, 4), shared.materials.transamericaBody);
    pyramid.name = 'Transamerica Pyramid tapered shaft';
    pyramid.position.set(pyramidX, pyramidBase + 9 + 59, pyramidZ);
    pyramid.rotation.y = Math.PI * 0.25;
    pyramid.castShadow = true;
    group.add(pyramid);
    [
      [-7.2, -7.2],
      [7.2, -7.2],
      [7.2, 7.2],
      [-7.2, 7.2],
    ].forEach(([edgeX, edgeZ], index) => {
      const fin = addSurfaceBox(
        `Transamerica Pyramid corner fin ${index + 1}`,
        pyramidX + edgeX,
        pyramidZ + edgeZ,
        [1.45, 86, 1.45],
        index % 2 ? shared.materials.landmarkDarkPodium : shared.materials.transamericaAccent,
        11.5,
      );
      fin.castShadow = true;
    });
    [
      { offset: 42, size: 22, material: shared.materials.transamericaAccent },
      { offset: 78, size: 14, material: shared.materials.landmarkDarkPodium },
    ].forEach(({ offset, size, material }, index) => {
      const belt = addSurfaceBox(
        `Transamerica Pyramid structural belt ${index + 1}`,
        pyramidX,
        pyramidZ,
        [size, 1.05, size],
        material,
        offset,
      );
      belt.castShadow = true;
    });
    const transamericaPaneRows = [18, 34, 50, 66, 82, 98];
    const transamericaPaneColumns = [-0.62, -0.21, 0.21, 0.62];
    transamericaPaneRows.forEach((row, rowIndex) => {
      const t = THREE.MathUtils.clamp((row - 9) / 118, 0, 1);
      const radius = Math.max(2.2, 18 * (1 - t));
      // Keep the upper rows separated in the long C3 view instead of
      // collapsing four panes into one bright center stripe as the pyramid
      // tapers.  The larger overlays remain bounded within the landmark
      // silhouette and use the existing pooled window geometry/materials.
      const paneRadius = Math.max(radius, 8);
      transamericaPaneColumns.forEach((column, columnIndex) => {
        const pane = new THREE.Mesh(
          shared.window,
          shared.materials.landmarkNight[(rowIndex * 3 + columnIndex) % shared.materials.landmarkNight.length],
        );
        pane.name = `Transamerica Pyramid sparse night pane ${rowIndex + 1}-${columnIndex + 1}`;
        pane.position.set(
          // C3 approaches from +X; place the overlay just beyond the
          // analytic cone surface so the depth-tested pane cannot disappear
          // behind the tapered body.
          pyramidX + radius + 0.2,
          pyramidBase + row,
          pyramidZ + paneRadius * column,
        );
        pane.scale.set(
          0.09,
          1.72 + ((rowIndex + columnIndex) % 3) * 0.42,
          2.0 + ((rowIndex * 2 + columnIndex) % 3) * 0.38,
        );
        pane.userData.landmarkNightPane = 'transamerica';
        pane.userData.facadeNightOverlay = true;
        pane.userData.cameraFacingSurface = '+X/cone';
        pane.material.depthTest = true;
        pane.castShadow = false;
        pane.receiveShadow = false;
        group.add(pane);
      });
    });
    const spire = new THREE.Mesh(shared.pole, shared.materials.transamericaAccent);
    spire.name = 'Transamerica Pyramid spire';
    spire.position.set(pyramidX, pyramidBase + 140, pyramidZ);
    spire.scale.set(1.15, 24, 1.15);
    spire.castShadow = true;
    group.add(spire);
    // Street-level canyon flanks on Sansome / Montgomery cues.
    [-48, 48].forEach((ox, index) => {
      const flank = addSurfaceBox(
        `Embarcadero canyon flank ${index + 1}`,
        x + ox,
        z - 20,
        [18, 48 + index * 12, 22],
        index ? shared.materials.window : shared.materials.landmarkStone,
      );
      flank.castShadow = true;
      const sidewalk = addSurfaceBox(
        `Embarcadero canyon sidewalk ${index + 1}`,
        x + ox,
        z - 36,
        [20, 0.16, 3.4],
        shared.materials.sidewalk,
      );
      sidewalk.receiveShadow = true;
    });
    const redwood = addSurfaceBox('Redwood Park pocket floor', 20, 70, [28, 0.22, 24], shared.materials.park);
    redwood.receiveShadow = true;
    [
      [10, 64], [18, 74], [28, 66], [22, 58], [14, 80],
    ].forEach(([treeX, treeZ], index) => {
      const trunk = new THREE.Mesh(shared.trunk, shared.materials.trunk);
      trunk.name = `Redwood Park trunk ${index + 1}`;
      trunk.position.set(treeX, surfaceAt(treeX, treeZ) + 3.4, treeZ);
      trunk.scale.set(0.6, 7.0, 0.6);
      trunk.castShadow = true;
      const canopy = new THREE.Mesh(shared.canopy, shared.materials.tree);
      canopy.name = `Redwood Park canopy ${index + 1}`;
      canopy.position.set(treeX, surfaceAt(treeX, treeZ) + 9.0, treeZ);
      canopy.scale.set(2.6, 4.6, 2.6);
      canopy.castShadow = true;
      group.add(trunk, canopy);
    });
    const promenade = addSurfaceBox('Embarcadero promenade', 168, 0, [10, 0.36, 340], shared.materials.sidewalk);
    promenade.receiveShadow = true;
    const seawall = addSurfaceBox('Embarcadero seawall', 176, 0, [1.4, 1.2, 340], shared.materials.landmarkStone, 0.05);
    seawall.castShadow = true;
    // The bay is a shallow low-poly field rather than one flat apron. Its
    // sampled ripple profile keeps the water connected to the wall while the
    // tiled, rotated photo texture carries the readable bay depth/reflections.
    // Keep the field immediately waterward of the authored frontage shells;
    // the 1m reveal still tucks beneath the irregular edge while avoiding
    // AABB interpenetration with the last enterable waterfront bay.
    const waterFieldStartX = 178;
    // Keep the far water bounded near the promenade and shape its final edge
    // per row. The irregular seam reads as an intentional dry pier edge while
    // preserving a dry foreground beyond it (including the benches/planters).
    const waterFieldEndX = 220;
    const waterFieldColumns = [178, 185, 194, 205, waterFieldEndX];
    const waterFieldBoundaryDrift = Object.freeze([
      -10, 14, -12, 18, -8, 16, -11, -6, 8,
      -12, -14, 20, -9, 18, -13, 16, -7,
    ]);
    const waterFieldBoundaryXAt = (zAt) => {
      const t = THREE.MathUtils.clamp(((zAt + 180) / 360) * (waterFieldBoundaryDrift.length - 1), 0, waterFieldBoundaryDrift.length - 1);
      const index = Math.min(waterFieldBoundaryDrift.length - 2, Math.floor(t));
      const mix = t - index;
      return waterFieldEndX + THREE.MathUtils.lerp(
        waterFieldBoundaryDrift[index],
        waterFieldBoundaryDrift[index + 1],
        mix,
      );
    };
    const waterFieldBoundaryMinX = waterFieldEndX + Math.min(...waterFieldBoundaryDrift);
    const waterFieldBoundaryMaxX = waterFieldEndX + Math.max(...waterFieldBoundaryDrift);
    const waterFieldTextureEndX = waterFieldBoundaryMaxX;
    const waterFieldRows = 16;
    const waterFieldRowSpacing = 360 / (waterFieldRows - 1);
    // Lift the authored field clear of the terrain so the mapped bay remains
    // visible across every facet. Ripple amplitudes stay bounded below the
    // neutral shore cap and expose the true minimum terrain clearance.
    const waterFieldBaseOffset = 0.45;
    const waterFieldRippleAmplitude = 0.018 + 0.012 + 0.008;
    const waterFieldHeightAt = (xAt, zAt) => (
      surfaceAt(xAt, zAt)
      + waterFieldBaseOffset
      + Math.sin((zAt * 0.11) + (xAt * 0.31)) * 0.018
      + Math.cos((zAt * 0.037) - (xAt * 0.17)) * 0.012
      + Math.sin((zAt * 0.22) + (xAt * 0.07)) * 0.008
    );
    // Keep vertex colors as a restrained depth tint; the generated texture,
    // not a high-chroma polygon fill, owns the visible water/reflection read.
    const waterFieldShallow = new THREE.Color(0xd2e2df);
    const waterFieldDeep = new THREE.Color(0x9ab8bd);
    const waterFieldPositions = [];
    const waterFieldColors = [];
    const waterFieldUvs = [];
    const waterFieldColorAt = (xAt, zAt) => {
      const depth = THREE.MathUtils.clamp((xAt - waterFieldStartX) / (waterFieldEndX - waterFieldStartX), 0, 1);
      const shade = 0.93 + Math.sin((zAt * 0.08) + (xAt * 0.13)) * 0.07;
      return waterFieldShallow.clone().lerp(waterFieldDeep, depth).multiplyScalar(shade);
    };
    const waterFieldUvAt = (xAt, zAt) => [
      (xAt - waterFieldStartX) / (waterFieldTextureEndX - waterFieldStartX),
      (zAt + 180) / 360,
    ];
    for (let column = 0; column < waterFieldColumns.length - 1; column += 1) {
      const x0 = waterFieldColumns[column];
      const boundaryColumn = column === waterFieldColumns.length - 2;
      for (let row = 0; row < waterFieldRows - 1; row += 1) {
        const z0 = -180 + row * waterFieldRowSpacing;
        const z1 = -180 + (row + 1) * waterFieldRowSpacing;
        const x1z0 = boundaryColumn ? waterFieldBoundaryXAt(z0) : waterFieldColumns[column + 1];
        const x1z1 = boundaryColumn ? waterFieldBoundaryXAt(z1) : waterFieldColumns[column + 1];
        const p00 = [x0, waterFieldHeightAt(x0, z0), z0];
        const p10 = [x1z0, waterFieldHeightAt(x1z0, z0), z0];
        const p11 = [x1z1, waterFieldHeightAt(x1z1, z1), z1];
        const p01 = [x0, waterFieldHeightAt(x0, z1), z1];
        appendUpwardTexturedQuad(
          waterFieldPositions,
          waterFieldColors,
          waterFieldUvs,
          p00,
          p10,
          p11,
          p01,
          waterFieldColorAt((x0 * 2 + x1z0 + x1z1) * 0.25, (z0 + z1) * 0.5),
          waterFieldUvAt(x0, z0),
          waterFieldUvAt(x1z0, z0),
          waterFieldUvAt(x1z1, z1),
          waterFieldUvAt(x0, z1),
        );
      }
    }
    const bay = createSurfaceMesh(
      'Embarcadero bay water shelf',
      waterFieldPositions,
      waterFieldColors,
      shared.materials.shorelineWaterField,
    );
    bay.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(waterFieldUvs, 2));
    bay.geometry.computeBoundingSphere();
    bay.receiveShadow = true;
    bay.castShadow = false;
    bay.userData.waterfrontShoreline = true;
    bay.userData.lowPolyWaterField = true;
    bay.userData.waterFieldColumns = waterFieldColumns.length;
    bay.userData.waterFieldRows = waterFieldRows;
    bay.userData.waterFieldBandCount = waterFieldColumns.length - 1;
    bay.userData.depthNormalVariation = true;
    bay.userData.waterTextureAsset = 'assets/sf-bay-water-generated-v3.png';
    bay.userData.waterTextureTiled = true;
    bay.userData.waterTextureRepeat = Object.freeze({ u: 2.4, v: 2.8 });
    bay.userData.waterTextureRotation = 0.82;
    bay.userData.waterTextureOffset = Object.freeze({ u: 0.23, v: 0.17 });
    bay.userData.waterFieldBaseOffset = waterFieldBaseOffset;
    bay.userData.waterFieldRippleAmplitude = waterFieldRippleAmplitude;
    bay.userData.minimumTerrainClearance = waterFieldBaseOffset - waterFieldRippleAmplitude;
    bay.userData.waterFieldEdgeIrregular = true;
    bay.userData.waterFieldBoundaryRange = Object.freeze({ minX: waterFieldBoundaryMinX, maxX: waterFieldBoundaryMaxX });
    bay.userData.waterFieldRange = Object.freeze({ startX: waterFieldStartX, endX: waterFieldEndX });
    group.add(bay);

    // A single neutral, low-profile bulkhead follows the same irregular edge
    // so dry foreground reads as a deliberate promenade/pier termination.
    const bulkheadPositions = [];
    const bulkheadWidthProfile = Object.freeze([
      1.1, 1.7, 1.25, 2.0, 1.0, 1.6, 1.15, 1.85, 1.05,
      1.55, 1.15, 1.9, 1.0, 1.65, 1.2, 1.8, 1.1,
    ]);
    const bulkheadTopProfile = Object.freeze([
      0.08, 0.14, 0.05, 0.12, 0.07, 0.16, 0.06, 0.13, 0.09,
      0.15, 0.05, 0.12, 0.08, 0.16, 0.06, 0.14, 0.09,
    ]);
    for (let row = 0; row < waterFieldRows - 1; row += 1) {
      const z0 = -180 + row * waterFieldRowSpacing;
      const z1 = -180 + (row + 1) * waterFieldRowSpacing;
      const edgeX0 = waterFieldBoundaryXAt(z0);
      const edgeX1 = waterFieldBoundaryXAt(z1);
      const width0 = bulkheadWidthProfile[row];
      const width1 = bulkheadWidthProfile[row + 1];
      const outerX0 = edgeX0 + width0;
      const outerX1 = edgeX1 + width1;
      const edgeTop0 = waterFieldHeightAt(edgeX0, z0) + bulkheadTopProfile[row];
      const edgeTop1 = waterFieldHeightAt(edgeX1, z1) + bulkheadTopProfile[row + 1];
      const outerTop0 = [outerX0, edgeTop0, z0];
      const outerTop1 = [outerX1, edgeTop1, z1];
      const edgeTop0Point = [edgeX0, edgeTop0, z0];
      const edgeTop1Point = [edgeX1, edgeTop1, z1];
      const outerBottom0 = [outerX0, surfaceAt(outerX0, z0) + SURFACE_OFFSET + 0.02, z0];
      const outerBottom1 = [outerX1, surfaceAt(outerX1, z1) + SURFACE_OFFSET + 0.02, z1];
      const edgeBottom0 = [edgeX0, surfaceAt(edgeX0, z0) + SURFACE_OFFSET + 0.02, z0];
      const edgeBottom1 = [edgeX1, surfaceAt(edgeX1, z1) + SURFACE_OFFSET + 0.02, z1];
      appendUpwardQuad(bulkheadPositions, null, edgeTop0Point, outerTop0, outerTop1, edgeTop1Point);
      appendQuad(bulkheadPositions, null, outerBottom0, outerTop0, outerTop1, outerBottom1);
      appendQuad(bulkheadPositions, null, edgeBottom1, edgeBottom0, edgeTop0Point, edgeTop1Point);
    }
    const bulkhead = createSurfaceMesh(
      'Embarcadero irregular dry promenade bulkhead cap',
      bulkheadPositions,
      null,
      shared.materials.landmarkStone,
    );
    bulkhead.castShadow = true;
    bulkhead.receiveShadow = true;
    bulkhead.userData.waterfrontShoreline = true;
    bulkhead.userData.lowProfileBulkhead = true;
    bulkhead.userData.continuous = true;
    bulkhead.userData.boundaryRange = Object.freeze({ minX: waterFieldBoundaryMinX, maxX: waterFieldBoundaryMaxX });
    bulkhead.userData.widthRange = Object.freeze({
      min: Math.min(...bulkheadWidthProfile),
      max: Math.max(...bulkheadWidthProfile),
    });
    bulkhead.userData.heightRange = Object.freeze({
      min: Math.min(...bulkheadTopProfile),
      max: Math.max(...bulkheadTopProfile),
    });
    bulkhead.userData.contactOffset = 0.02;
    group.add(bulkhead);
    // Replace the single straight wall/water seam with one continuous,
    // low-poly cap that follows the grade but varies its block edge in x/y.
    // The small waterward reveal keeps the wall legible from the fixed vista
    // while preserving the existing promenade, seawall, and shelf footprints.
    const shoreNodeCount = 17;
    const shoreNodeSpacing = 360 / (shoreNodeCount - 1);
    const shoreDrift = [0.02, -0.17, 0.28, -0.08, 0.19, -0.24, 0.11, 0.34, -0.13, 0.06, -0.27, 0.17, -0.04, 0.23, -0.16, 0.09, -0.02];
    const shoreHeights = [1.2, 1.58, 1.04, 1.46, 1.22, 1.74, 1.12, 1.54, 0.98, 1.66, 1.18, 1.5, 1.06, 1.72, 1.26, 1.58, 1.1];
    const shoreNodes = shoreDrift.map((drift, index) => {
      const zAt = -180 + index * shoreNodeSpacing;
      const backX = 178.42 + drift * 0.28;
      const outerX = 181.62 + drift * 0.62;
      const backY = surfaceAt(backX, zAt) + SURFACE_OFFSET + 0.016;
      const outerY = surfaceAt(outerX, zAt) + SURFACE_OFFSET + 0.016;
      return {
        z: zAt,
        backX,
        outerX,
        backY,
        outerY,
        height: shoreHeights[index],
      };
    });
    const shoreEdgePositions = [];
    for (let index = 0; index < shoreNodes.length - 1; index += 1) {
      const start = shoreNodes[index];
      const end = shoreNodes[index + 1];
      const backBottomStart = [start.backX, start.backY, start.z];
      const backBottomEnd = [end.backX, end.backY, end.z];
      const outerBottomStart = [start.outerX, start.outerY, start.z];
      const outerBottomEnd = [end.outerX, end.outerY, end.z];
      const backTopStart = [start.backX, start.backY + start.height, start.z];
      const backTopEnd = [end.backX, end.backY + end.height, end.z];
      const outerTopStart = [start.outerX, start.outerY + start.height * 0.92, start.z];
      const outerTopEnd = [end.outerX, end.outerY + end.height * 0.92, end.z];
      appendQuad(shoreEdgePositions, null, backTopStart, outerTopStart, outerTopEnd, backTopEnd);
      appendQuad(shoreEdgePositions, null, outerBottomStart, outerBottomEnd, outerTopEnd, outerTopStart);
      appendQuad(shoreEdgePositions, null, backBottomEnd, backBottomStart, backTopStart, backTopEnd);
      appendQuad(shoreEdgePositions, null, backBottomStart, outerBottomStart, outerTopStart, backTopStart);
      appendQuad(shoreEdgePositions, null, outerBottomEnd, backBottomEnd, backTopEnd, outerTopEnd);
    }
    const shoreEdge = createSurfaceMesh(
      'Embarcadero irregular low-poly shore edge',
      shoreEdgePositions,
      null,
      shared.materials.curb,
    );
    shoreEdge.castShadow = true;
    shoreEdge.userData.waterfrontShoreline = true;
    shoreEdge.userData.shoreEdgeNodeCount = shoreNodeCount;
    shoreEdge.userData.contactOffset = 0.034;
    group.add(shoreEdge);

    // Four connected, segmented ribbons carry alternating warm/cool
    // reflections from the seawall into the bounded water field. Shared node
    // positions make each ribbon continuous while the taper/drift keeps the
    // pooled draw from reading as a triangular or lane-marking decal.
    const shorelineRibbonSpecs = [
      { x: 181.5, z: -42, length: 8, width: 2.0, drift: [0, 0.8, -0.5, 0.2] },
      { x: 182.5, z: -12, length: 8, width: 1.8, drift: [0, -0.7, 0.6, -0.2] },
      { x: 183.5, z: 18, length: 8, width: 1.9, drift: [0, 0.9, -0.8, 0.3] },
      { x: 184.5, z: 48, length: 7, width: 1.5, drift: [0, -0.8, 0.7, -0.3] },
    ];
    const shorelineRibbonPositions = [];
    const shorelineRibbonColors = [];
    const shorelineWarm = new THREE.Color(0xe2b673);
    const shorelineWarmTail = new THREE.Color(0x315d6a);
    const shorelineCool = new THREE.Color(0x82cbd0);
    const shorelineCoolTail = new THREE.Color(0x214f60);
    shorelineRibbonSpecs.forEach(({ x: shoreX, z: ribbonZ, length, width, drift }, index) => {
      const sample = (xAt, zAt) => [xAt, waterFieldHeightAt(xAt, zAt) + 0.12, zAt];
      const isCool = index % 2 === 1;
      const head = isCool ? shorelineCool : shorelineWarm;
      const tail = isCool ? shorelineCoolTail : shorelineWarmTail;
      const nodeCount = drift.length;
      for (let node = 0; node < nodeCount - 1; node += 1) {
        const t0 = node / (nodeCount - 1);
        const t1 = (node + 1) / (nodeCount - 1);
        const x0 = shoreX + length * t0;
        const x1 = shoreX + length * t1;
        const z0 = ribbonZ + drift[node];
        const z1 = ribbonZ + drift[node + 1];
        const width0 = width * (1 - t0 * 0.68);
        const width1 = width * (1 - t1 * 0.68);
        const color0 = head.clone().lerp(tail, t0 * 0.72);
        const color1 = head.clone().lerp(tail, t1 * 0.72);
        appendUpwardGradientQuad(
          shorelineRibbonPositions,
          shorelineRibbonColors,
          sample(x0, z0 - width0 * 0.5),
          sample(x0, z0 + width0 * 0.5),
          sample(x1, z1 + width1 * 0.5),
          sample(x1, z1 - width1 * 0.5),
          color0,
          color0,
          color1,
          color1,
        );
      }
    });
    const shorelineGlints = createSurfaceMesh(
      'Embarcadero segmented shoreline reflection ribbons',
      shorelineRibbonPositions,
      shorelineRibbonColors,
      shared.materials.shorelineReflection,
    );
    shorelineGlints.receiveShadow = false;
    shorelineGlints.castShadow = false;
    shorelineGlints.userData.waterfrontShoreline = true;
    shorelineGlints.userData.shorelineRibbonCount = shorelineRibbonSpecs.length;
    shorelineGlints.userData.shorelineGlintCount = shorelineRibbonSpecs.length;
    shorelineGlints.userData.segmentCount = shorelineRibbonSpecs.length * 3;
    shorelineGlints.userData.nonPeriodic = true;
    shorelineGlints.userData.waterCoupledMaterial = true;
    shorelineGlints.userData.warmCoolVertexColors = true;
    shorelineGlints.userData.contactOffset = 0.12;
    group.add(shorelineGlints);
    for (let pier = -3; pier <= 3; pier += 1) {
      const pz = pier * 48;
      // Keep the central three fingers as a promenade/water sightline while
      // the outer sheds retain the authored pier rhythm. This is intentionally
      // scoped to sheds -1/0/+1; no global visibility or camera changes are
      // needed.
      if (Math.abs(pier) > 1) {
        const shed = addSurfaceBox(
          `Embarcadero pier shed ${pier}`,
          170,
          pz,
          [12, 7 + (Math.abs(pier) % 3), 18],
          shared.materials.landmarkStone,
        );
        shed.castShadow = true;
      }
      const finger = addSurfaceBox(
        `Embarcadero pier finger ${pier}`,
        182,
        pz,
        [14, 0.4, 8],
        shared.materials.boardwalk,
        0.2,
      );
      finger.castShadow = true;
    }
    const ferry = addSurfaceBox('Ferry Building nave cue', 168, -48, [16, 12, 36], shared.materials.landmarkStone);
    ferry.castShadow = true;
    const clock = addSurfaceBox('Ferry Building clock tower cue', 168, -48, [5.2, 28, 5.2], shared.materials.landmarkStone, 12);
    clock.castShadow = true;
    // The nave's bay-facing side is the dominant pale slab in the C3 view.
    // Keep the original nave and clock cue intact, but layer a grounded east
    // facade across its 72 m promenade frontage. Seven unequal bays keep no
    // one photo/glazing component large enough to read as another slab while
    // the central gap preserves the clock tower silhouette.
    const ferryEastFacade = new THREE.Group();
    ferryEastFacade.name = 'Ferry Building east glazed bay facade';
    ferryEastFacade.userData.waterfrontCorridor = 'embarcadero-164m-east-frontage';
    ferryEastFacade.userData.grounded = true;
    ferryEastFacade.userData.ferryEastFacade = Object.freeze({
      orientation: '+X/east',
      frontageMeters: 72,
      panelCount: 7,
      panelWidths: Object.freeze([8, 8.8, 9, 5.46, 11, 11, 9.94]),
      maxPanelWidth: 11,
      depthLayers: 3,
      sparseNightPaneCount: 14,
      centralClockGap: 5.4,
    });
    const ferryBayWidths = [8, 8.8, 9, 5.46, 11, 11, 9.94];
    const ferryBayGaps = [0.68, 0.68, 0.68, 5.4, 0.68, 0.68];
    const ferryFacadeMaterials = [
      shared.materials.salesforceGlass,
      shared.materials.landmarkDarkPodium,
      shared.materials.salesforceGlass,
      shared.materials.landmarkDarkPodium,
      shared.materials.salesforceGlass,
      shared.materials.landmarkDarkPodium,
      shared.materials.salesforceGlass,
    ];
    const ferryPanelHeight = 10.7;
    const ferryBaseX = 176.08;
    const ferryFrontageStart = -84;
    let ferryBayCursor = ferryFrontageStart;
    ferryBayWidths.forEach((bayWidth, bayIndex) => {
      const bayCenter = ferryBayCursor + bayWidth * 0.5;
      const baySurface = surfaceAt(ferryBaseX, bayCenter);
      const halfWidth = bayWidth * 0.5;
      const grade = (
        surfaceAt(ferryBaseX, bayCenter + halfWidth)
        - surfaceAt(ferryBaseX, bayCenter - halfWidth)
      ) / Math.max(bayWidth, 1);
      const bay = new THREE.Group();
      bay.name = `Ferry Building east glazed bay ${bayIndex + 1}`;
      bay.position.set(176.08, baySurface, bayCenter);
      bay.rotation.x = -Math.atan(grade);
      bay.userData.ferryEastFacade = true;
      bay.userData.ferryBayIndex = bayIndex;
      bay.userData.panelWidth = bayWidth;

      const ferryPart = (name, scale, px, py, pz, material) => {
        const mesh = new THREE.Mesh(shared.box, material);
        mesh.name = name;
        mesh.position.set(px, py + scale[1] * 0.5, pz);
        mesh.scale.set(scale[0], scale[1], scale[2]);
        mesh.userData.ferryEastFacade = true;
        mesh.userData.ferryBayIndex = bayIndex;
        bay.add(mesh);
        return mesh;
      };
      const lowerDoorHeight = 2.7;
      const lowerDoorWidth = Math.min(3.6, bayWidth * 0.52);
      const spandrelBottom = 3.18;
      const spandrelHeight = 0.62;
      const upperWindowBottom = spandrelBottom + spandrelHeight + 0.04;
      const upperWindowHeight = 5.6;
      const upperWindowWidth = Math.max(2.8, bayWidth - 1.08);
      const lowerDoor = new THREE.Mesh(shared.facadePanel, shared.materials.door);
      lowerDoor.name = `Ferry Building east glazed bay ${bayIndex + 1} lower door`;
      lowerDoor.position.set(0, 0.42 + lowerDoorHeight * 0.5, 0);
      lowerDoor.rotation.y = Math.PI * 0.5;
      lowerDoor.scale.set(lowerDoorWidth, lowerDoorHeight, 1);
      lowerDoor.userData.ferryEastFacade = true;
      lowerDoor.userData.lowerDoor = true;
      lowerDoor.userData.panelWidth = lowerDoorWidth;
      bay.add(lowerDoor);
      const panel = new THREE.Mesh(shared.facadePanel, ferryFacadeMaterials[bayIndex]);
      panel.name = `Ferry Building east glazed bay ${bayIndex + 1} dark panel`;
      panel.position.set(0, upperWindowBottom + upperWindowHeight * 0.5, 0);
      panel.rotation.y = Math.PI * 0.5;
      panel.scale.set(upperWindowWidth, upperWindowHeight, 1);
      panel.userData.ferryEastFacade = true;
      panel.userData.facadePhoto = false;
      panel.userData.darkGlazing = 'upper-window';
      panel.userData.panelWidth = upperWindowWidth;
      panel.userData.panelHeight = upperWindowHeight;
      bay.add(panel);
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} grounded east plinth`,
        [0.42, 0.42, bayWidth + 0.34],
        0.2,
        0,
        0,
        shared.materials.landmarkDarkPodium,
      );
      const edgeOffset = halfWidth + 0.11;
      // Recessed edge, projecting pilasters, and stone belts form the
      // Beaux-Arts three-layer depth stack without a full-height dark run.
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} recessed reveal left`,
        [0.12, ferryPanelHeight, 0.08],
        0.12,
        0.42,
        -edgeOffset,
        shared.materials.trim,
      );
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} recessed reveal right`,
        [0.12, ferryPanelHeight, 0.08],
        0.12,
        0.42,
        edgeOffset,
        shared.materials.trim,
      );
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} projecting casing left`,
        [0.22, ferryPanelHeight + 0.16, 0.14],
        0.28,
        0.34,
        -edgeOffset,
        shared.materials.salesforceAccent,
      );
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} projecting casing right`,
        [0.22, ferryPanelHeight + 0.16, 0.14],
        0.28,
        0.34,
        edgeOffset,
        shared.materials.salesforceAccent,
      );
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} projecting sill`,
        [0.3, 0.16, bayWidth + 0.26],
        0.26,
        spandrelBottom - 0.16,
        0,
        shared.materials.trim,
      );
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} warm stone mid-belt`,
        [0.34, spandrelHeight, bayWidth + 0.3],
        0.3,
        spandrelBottom,
        0,
        shared.materials.landmarkStone,
      );
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} upper window lintel`,
        [0.34, 0.18, upperWindowWidth + 0.3],
        0.3,
        upperWindowBottom + upperWindowHeight - 0.12,
        0,
        shared.materials.landmarkStone,
      );
      ferryPart(
        `Ferry Building bay ${bayIndex + 1} lower door lintel`,
        [0.28, 0.18, lowerDoorWidth + 0.34],
        0.28,
        0.42 + lowerDoorHeight - 0.12,
        0,
        shared.materials.landmarkStone,
      );
      const mullionCount = bayWidth >= 7.5 ? 1 : 0;
      for (let mullion = 0; mullion < mullionCount; mullion += 1) {
        ferryPart(
          `Ferry Building bay ${bayIndex + 1} upper window mullion`,
          [0.12, upperWindowHeight, 0.1],
          0.24,
          upperWindowBottom,
          0,
          shared.materials.salesforceAccent,
        );
      }

      // Two compact upper openings per bay establish day-time glazing. Their
      // smaller warm/cool overlays are driven by the existing night lifecycle.
      for (let paneIndex = 0; paneIndex < 2; paneIndex += 1) {
        const paneZ = (paneIndex === 0 ? -0.24 : 0.24) * upperWindowWidth;
        const opening = new THREE.Mesh(shared.window, shared.materials.window);
        opening.name = `Ferry Building bay ${bayIndex + 1} dark opening ${paneIndex + 1}`;
        opening.position.set(0.07, upperWindowBottom + 1.5 + paneIndex * 2.65, paneZ);
        opening.scale.set(0.08, 1.38, Math.min(1.15, upperWindowWidth * 0.18));
        opening.userData.ferryEastFacade = true;
        opening.userData.darkGlazing = true;
        bay.add(opening);
        const nightPane = new THREE.Mesh(
          shared.window,
          shared.materials.facadeNight[(bayIndex + paneIndex) % shared.materials.facadeNight.length],
        );
        nightPane.name = `Ferry Building bay ${bayIndex + 1} sparse night pane ${paneIndex + 1}`;
        nightPane.position.set(0.14, upperWindowBottom + 1.5 + paneIndex * 2.65, paneZ);
        nightPane.scale.set(0.05, 0.64, Math.min(0.46, upperWindowWidth * 0.07));
        nightPane.userData.ferryEastFacade = true;
        nightPane.userData.facadeNightOverlay = true;
        nightPane.castShadow = false;
        nightPane.receiveShadow = false;
        bay.add(nightPane);
      }
      ferryEastFacade.add(bay);
      ferryBayCursor += bayWidth + (ferryBayGaps[bayIndex] ?? 0);
    });
    const ferryCorniceBase = surfaceAt(ferryBaseX, -48);
    const ferryCorniceGrade = (
      surfaceAt(ferryBaseX, -12)
      - surfaceAt(ferryBaseX, -84)
    ) / 72;
    const steppedCornice = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
    steppedCornice.name = 'Ferry Building continuous stepped roof cornice';
    steppedCornice.position.set(0.38, ferryCorniceBase + 10.74, -48);
    steppedCornice.scale.set(0.38, 0.24, 72);
    steppedCornice.rotation.x = -Math.atan(ferryCorniceGrade);
    steppedCornice.userData.ferryEastFacade = true;
    steppedCornice.userData.steppedCornice = true;
    ferryEastFacade.add(steppedCornice);
    const steppedCorniceCap = new THREE.Mesh(shared.box, shared.materials.trim);
    steppedCorniceCap.name = 'Ferry Building continuous stepped cornice cap';
    steppedCorniceCap.position.set(0.54, ferryCorniceBase + 11.02, -48);
    steppedCorniceCap.scale.set(0.24, 0.14, 70.8);
    steppedCorniceCap.rotation.x = -Math.atan(ferryCorniceGrade);
    steppedCorniceCap.userData.ferryEastFacade = true;
    steppedCorniceCap.userData.steppedCornice = true;
    ferryEastFacade.add(steppedCorniceCap);
    group.add(ferryEastFacade);
    // Street trees / lamps along the promenade every block.
    for (let lz = -150; lz <= 150; lz += 24) {
      const lamp = addSurfaceBox(`Embarcadero lamp ${lz}`, 164, lz, [0.24, 4.2, 0.24], shared.materials.signalHousing, 0.2);
      lamp.castShadow = true;
    }

    // Bounded waterfront encounter slice: a 164 m east-frontage run from
    // the Sansome canyon toward the seawall. Four compact photo bays per
    // module keep every panel below 12 m while the pooled trims/reveals retain
    // a readable depth stack at street distance.
    const waterfrontGradeAt = (xAt, zAt, span = 10) => (
      (surfaceAt(xAt, zAt + span) - surfaceAt(xAt, zAt - span)) / (span * 2)
    );
    const waterfrontFacade = ({ family, z: facadeZ, height, photoMaterials, photoFamilyIndex, frontageWidth = 38 }) => {
      const facadeX = 154;
      const facing = -1;
      const width = frontageWidth;
      const narrowModule = width < 30;
      const bayCenters = narrowModule ? [-4.4, 4.4] : [-14.4, -4.8, 4.8, 14.4];
      const baseY = surfaceAt(facadeX, facadeZ);
      const facade = new THREE.Group();
      facade.name = `Embarcadero waterfront ${family} facade ${facadeZ}`;
      facade.position.set(facadeX, baseY, facadeZ);
      facade.rotation.x = -Math.atan(waterfrontGradeAt(facadeX, facadeZ, width * 0.5));
      facade.userData.waterfrontCorridor = 'embarcadero-164m-east-frontage';
      facade.userData.grounded = true;
      facade.userData.encounterGrade = blueprint.grade;
      const part = (name, scale, px, py, pz, material) => {
        const mesh = new THREE.Mesh(shared.box, material);
        mesh.name = name;
        mesh.position.set(px, py + scale[1] * 0.5, pz);
        mesh.scale.set(scale[0], scale[1], scale[2]);
        mesh.userData.waterfrontFacadeFamily = family;
        facade.add(mesh);
        return mesh;
      };
      part(`${family} grounded waterfront plinth`, [4.0, 0.42, width], 0, 0, 0, shared.materials.landmarkStone);
      part(`${family} waterfront body`, [3.6, height, width - 0.8], 0, 0.42, 0, family === 'painted-lady'
        ? shared.materials.landmarkStone
        : family === 'brick-mercantile' ? shared.materials.landmarkBrick : shared.materials.trim);
      part(`${family} waterfront roof cap`, [3.9, 0.34, width + 0.4], 0, 0.42 + height, 0, shared.materials.roof);

      const frontX = facing * 1.82;
      const photoBayWidth = narrowModule ? 7.6 : 8.4;
      const photoBayHeight = height - 0.38;
      bayCenters.forEach((bayCenter, bayIndex) => {
        const photoPanel = new THREE.Mesh(
          shared.facadePanel,
          photoMaterials[bayIndex % photoMaterials.length],
        );
        photoPanel.name = `${family} waterfront road-facing photo bay ${bayIndex + 1}`;
        photoPanel.position.set(frontX + facing * 0.045, 0.42 + photoBayHeight * 0.5, bayCenter);
        photoPanel.rotation.y = facing * Math.PI * 0.5;
        photoPanel.scale.set(photoBayWidth, photoBayHeight, 1);
        photoPanel.userData.facadePhoto = true;
        photoPanel.userData.waterfrontFacadeFamily = family;
        photoPanel.userData.photoBayWidth = photoBayWidth;
        facade.add(photoPanel);

        const revealX = frontX + facing * 0.14;
        const casingX = frontX + facing * 0.28;
        const edgeOffset = photoBayWidth * 0.5 + 0.09;
        part(`${family} waterfront bay ${bayIndex + 1} recessed reveal left`, [0.12, photoBayHeight, 0.08], revealX, 0.42, bayCenter - edgeOffset, shared.materials.trim);
        part(`${family} waterfront bay ${bayIndex + 1} recessed reveal right`, [0.12, photoBayHeight, 0.08], revealX, 0.42, bayCenter + edgeOffset, shared.materials.trim);
        part(`${family} waterfront bay ${bayIndex + 1} casing left`, [0.24, photoBayHeight + 0.16, 0.14], casingX, 0.34, bayCenter - edgeOffset, shared.materials.landmarkOrange);
        part(`${family} waterfront bay ${bayIndex + 1} casing right`, [0.24, photoBayHeight + 0.16, 0.14], casingX, 0.34, bayCenter + edgeOffset, shared.materials.landmarkOrange);
        part(`${family} waterfront bay ${bayIndex + 1} projecting sill`, [0.34, 0.16, photoBayWidth + 0.28], casingX, 0.42 + photoBayHeight - 0.2, bayCenter, shared.materials.trim);

        const bayHash = (salt) => {
          const value = Math.sin(
            (facadeZ * 0.61) + (photoFamilyIndex * 31.2) + (bayIndex * 13.4) + (salt * 7.1),
          ) * 43758.5453;
          return value - Math.floor(value);
        };
        const litPaneCount = 1 + Math.floor(bayHash(1) * 3);
        for (let paneIndex = 0; paneIndex < litPaneCount; paneIndex += 1) {
          const pane = new THREE.Mesh(
            shared.window,
            shared.materials.facadeNight[(photoFamilyIndex + bayIndex + paneIndex) % shared.materials.facadeNight.length],
          );
          const paneHeight = 0.34 + bayHash(paneIndex + 2) * 0.38;
          pane.name = `${family} waterfront bay ${bayIndex + 1} sparse night pane ${paneIndex + 1}`;
          pane.position.set(
            frontX + facing * 0.105,
            Math.min(0.42 + photoBayHeight - paneHeight * 0.7, 1.55 + bayHash(paneIndex + 4) * 6.8),
            bayCenter + (bayHash(paneIndex + 5) - 0.5) * 4.8,
          );
          pane.scale.set(0.04, paneHeight, 0.38 + bayHash(paneIndex + 6) * 0.42);
          pane.userData.facadeNightOverlay = true;
          pane.userData.waterfrontFacadeFamily = family;
          pane.castShadow = false;
          pane.receiveShadow = false;
          facade.add(pane);
        }
      });

      // The two outer painted-lady modules also need an east/bay-facing back
      // for the centered C3 vista. Reuse the shipped facade-photo atlas and
      // pooled trim/window geometry, but split the rear frontage into four
      // intentionally unequal bays so no single pale body face spans the
      // frame. The panel, reveal, casing, and sill offsets form three shallow
      // depth layers while the deterministic panes keep night occupancy
      // separated from the baked photo grid.
      const addBayFacingPaintedLadyBack = family === 'painted-lady'
        && (facadeZ === -60 || facadeZ === 60);
      if (addBayFacingPaintedLadyBack) {
        const rearBaySpecs = [
          { center: -14.45, width: 7.2 },
          { center: -5.1, width: 8.6 },
          { center: 4.95, width: 10.4 },
          { center: 14.45, width: 6.9 },
        ];
        const rearX = 1.82;
        const rearPanelHeight = height - 0.38;
        let rearNightPaneCount = 0;
        const rearHash = (bayIndex, paneIndex, salt) => {
          const value = Math.sin(
            (facadeZ * 0.47)
              + (bayIndex * 17.9)
              + (paneIndex * 23.7)
              + (salt * 11.3),
          ) * 43758.5453;
          return value - Math.floor(value);
        };
        rearBaySpecs.forEach((spec, bayIndex) => {
          const panel = new THREE.Mesh(
            shared.facadePanel,
            photoMaterials[(bayIndex + (facadeZ > 0 ? 1 : 0)) % photoMaterials.length],
          );
          panel.name = `${family} waterfront bay-facing back panel ${bayIndex + 1}`;
          panel.position.set(
            rearX + 0.045,
            0.42 + rearPanelHeight * 0.5,
            spec.center,
          );
          panel.rotation.y = Math.PI * 0.5;
          panel.scale.set(spec.width, rearPanelHeight, 1);
          panel.userData.facadePhoto = true;
          panel.userData.waterfrontFacadeFamily = family;
          panel.userData.bayFacingBack = true;
          panel.userData.photoBayWidth = spec.width;
          facade.add(panel);

          const edgeOffset = spec.width * 0.5 + 0.09;
          const revealX = rearX + 0.14;
          const casingX = rearX + 0.28;
          // Three explicit depth layers: recessed reveal, casing, and sill.
          part(
            `${family} waterfront back bay ${bayIndex + 1} recessed reveal left`,
            [0.12, rearPanelHeight, 0.08],
            revealX,
            0.42,
            spec.center - edgeOffset,
            shared.materials.trim,
          );
          part(
            `${family} waterfront back bay ${bayIndex + 1} recessed reveal right`,
            [0.12, rearPanelHeight, 0.08],
            revealX,
            0.42,
            spec.center + edgeOffset,
            shared.materials.trim,
          );
          part(
            `${family} waterfront back bay ${bayIndex + 1} casing left`,
            [0.24, rearPanelHeight + 0.16, 0.14],
            casingX,
            0.34,
            spec.center - edgeOffset,
            shared.materials.landmarkOrange,
          );
          part(
            `${family} waterfront back bay ${bayIndex + 1} casing right`,
            [0.24, rearPanelHeight + 0.16, 0.14],
            casingX,
            0.34,
            spec.center + edgeOffset,
            shared.materials.landmarkOrange,
          );
          part(
            `${family} waterfront back bay ${bayIndex + 1} projecting sill`,
            [0.34, 0.16, spec.width + 0.28],
            casingX,
            0.42 + rearPanelHeight - 0.2,
            spec.center,
            shared.materials.trim,
          );

          // Three separated panes per bay keep the rear occupancy sparse but
          // legible in night mode without another full-width stripe.
          for (let paneIndex = 0; paneIndex < 3; paneIndex += 1) {
            const pane = new THREE.Mesh(
              shared.window,
              shared.materials.facadeNight[
                (photoFamilyIndex + bayIndex + paneIndex + 1) % shared.materials.facadeNight.length
              ],
            );
            const paneHeight = 0.34 + rearHash(bayIndex, paneIndex, 2) * 0.38;
            pane.name = `${family} waterfront back bay ${bayIndex + 1} sparse night pane ${paneIndex + 1}`;
            pane.position.set(
              rearX + 0.39,
              Math.min(
                0.42 + rearPanelHeight - paneHeight * 0.7,
                1.55 + rearHash(bayIndex, paneIndex, 4) * 6.8,
              ),
              spec.center + (paneIndex - 1) * 0.82 + (rearHash(bayIndex, paneIndex, 5) - 0.5) * 0.36,
            );
            pane.scale.set(0.04, paneHeight, 0.34 + rearHash(bayIndex, paneIndex, 6) * 0.36);
            pane.userData.facadeNightOverlay = true;
            pane.userData.waterfrontFacadeFamily = family;
            pane.userData.bayFacingBack = true;
            pane.castShadow = false;
            pane.receiveShadow = false;
            facade.add(pane);
            rearNightPaneCount += 1;
          }
        });
        facade.userData.bayFacingBack = Object.freeze({
          orientation: '+X/east',
          panelCount: rearBaySpecs.length,
          panelWidths: Object.freeze(rearBaySpecs.map((spec) => spec.width)),
          maxPanelWidth: Math.max(...rearBaySpecs.map((spec) => spec.width)),
          depthLayers: 3,
          sparseNightPaneCount: rearNightPaneCount,
        });
      }

      part(`${family} waterfront entry threshold`, [1.52, 0.18, 2.05], frontX + facing * 0.14, 0, 0, shared.materials.sidewalk);
      part(`${family} waterfront public doorway`, [0.14, 2.12, 1.12], frontX + facing * 0.2, 0.18, 0, shared.materials.door);
      part(`${family} waterfront PUBLIC LOBBY sign`, [0.18, 0.22, 2.8], frontX + facing * 0.24, 2.45, 0, shared.materials.entryHeader);
      if (family === 'painted-lady') {
        part(`${family} waterfront bay cornice left`, [0.34, 0.22, 6.6], frontX + facing * 0.34, 0.42 + height - 0.48, bayCenters[0], shared.materials.landmarkOrange);
        part(`${family} waterfront bay cornice right`, [0.34, 0.22, 6.6], frontX + facing * 0.34, 0.42 + height - 0.48, bayCenters[bayCenters.length - 1], shared.materials.landmarkOrange);
      } else if (family === 'stucco') {
        part(`${family} waterfront awning band`, [0.36, 0.18, width * 0.72], frontX + facing * 0.24, 3.88, 0, shared.materials.landmarkStone);
        part(`${family} waterfront balcony rail`, [0.26, 0.1, width * 0.54], frontX + facing * 0.3, 6.55, 0, shared.materials.trim);
      } else {
        part(`${family} waterfront storefront band`, [0.3, 1.28, width * 0.66], frontX + facing * 0.22, 0.72, 0, shared.materials.landmarkOrange);
        part(`${family} waterfront sign rail`, [0.28, 0.18, width * 0.58], frontX + facing * 0.25, 3.88, 0, shared.materials.landmarkOrange);
      }
      facade.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = !object.userData.facadeNightOverlay;
        object.receiveShadow = !object.userData.facadeNightOverlay;
      });
      group.add(facade);
    };
    [
      { z: -60, family: 'painted-lady', height: 15.2, photoMaterials: shared.materials.facadePaintedLadyPhotos, photoFamilyIndex: 0 },
      { z: -20, family: 'brick-mercantile', height: 18.0, frontageWidth: 18, photoMaterials: shared.materials.facadeBrickPhotos, photoFamilyIndex: 2 },
      { z: 20, family: 'stucco', height: 16.0, frontageWidth: 18, photoMaterials: shared.materials.facadeStuccoPhotos, photoFamilyIndex: 1 },
      { z: 60, family: 'painted-lady', height: 17.4, photoMaterials: shared.materials.facadePaintedLadyPhotos, photoFamilyIndex: 0 },
    ].forEach((module) => waterfrontFacade(module));

    const corridorCurb = addSurfaceStrip(
      'Embarcadero waterfront encounter curb cap',
      [155, -84],
      [155, 84],
      0.22,
      shared.materials.curb,
      SURFACE_OFFSET + 0.09,
      24,
    );
    corridorCurb.userData.waterfrontCorridor = 'embarcadero-164m-east-frontage';

    // Salesforce Tower anchors the south end of the slice as the taller
    // glass hierarchy beside the shorter Transamerica pyramid.
    // Place the tower on the clear block immediately west of the waterfront
    // frontage.  The west-side anchor shares the centered gap ray with the
    // Transamerica podium while leaving generated shells and photo frontage
    // spatially disjoint.
    const salesforceX = -126;
    const salesforceZ = 48;
    const salesforceBase = surfaceAt(salesforceX, salesforceZ);
    const salesforceWorldX = descriptor.center.x + salesforceX;
    const salesforceWorldZ = descriptor.center.z + salesforceZ;
    // The fixed C3 camera sees this anchor along (+374,-48) in world X/Z,
    // not along the axis-aligned +X face. Keep the pane normal and tangent
    // explicit so depth-tested overlays sit on the visible radial shaft face.
    const salesforceFaceDeltaX = EMBARCADERO_C3_VIEW.camera.x - salesforceWorldX;
    const salesforceFaceDeltaZ = EMBARCADERO_C3_VIEW.camera.z - salesforceWorldZ;
    const salesforceFaceLength = Math.hypot(salesforceFaceDeltaX, salesforceFaceDeltaZ) || 1;
    const salesforceFaceNormal = Object.freeze({
      x: salesforceFaceDeltaX / salesforceFaceLength,
      z: salesforceFaceDeltaZ / salesforceFaceLength,
    });
    const salesforceFaceTangent = Object.freeze({
      x: -salesforceFaceNormal.z,
      z: salesforceFaceNormal.x,
    });
    const salesforcePodium = addSurfaceBox(
      'Salesforce Tower transit podium',
      salesforceX,
      salesforceZ,
      [36, 8, 30],
      shared.materials.landmarkDarkPodium,
    );
    salesforcePodium.castShadow = true;
    const salesforcePodiumBand = addSurfaceBox(
      'Salesforce Tower transit podium contrast band',
      salesforceX,
      salesforceZ,
      [34, 1.3, 28],
      shared.materials.salesforceAccent,
      8,
    );
    salesforcePodiumBand.castShadow = true;
    const salesforceShaftHeight = 108;
    const salesforceShaft = new THREE.Mesh(shared.tower, shared.materials.salesforceGlass);
    salesforceShaft.name = 'Salesforce Tower tapered glass shaft';
    salesforceShaft.position.set(salesforceX, salesforceBase + 8 + salesforceShaftHeight * 0.5, salesforceZ);
    salesforceShaft.scale.set(14, salesforceShaftHeight, 14);
    salesforceShaft.castShadow = true;
    group.add(salesforceShaft);
    // Four front ribs and three horizontal belts provide the vertical bay
    // rhythm that distinguishes Salesforce from the adjacent pyramid.
    // Widen only the decorative ribs inside the already-clear block.  The
    // anchor, podium, collision volume, and portals stay fixed while the
    // outer ribs give the tower a legible silhouette in the exact C3 vista.
    [-20, -6, 6, 20].forEach((zOffset, index) => {
      const rib = addSurfaceBox(
        `Salesforce Tower vertical facade rib ${index + 1}`,
        salesforceX + 6.4,
        salesforceZ + zOffset,
        [1.05, 94, 1.1],
        index % 2 ? shared.materials.landmarkDarkPodium : shared.materials.salesforceAccent,
        10,
      );
      rib.castShadow = true;
    });
    [28, 54, 80].forEach((offset, index) => {
      const belt = addSurfaceBox(
        `Salesforce Tower horizontal bay belt ${index + 1}`,
        salesforceX + 6.7,
        salesforceZ,
        [1.18, 1.05, 27],
        index === 1 ? shared.materials.salesforceCrown : shared.materials.salesforceAccent,
        offset,
      );
      belt.castShadow = true;
    });
    const salesforcePaneRows = [18, 34, 50, 66, 82, 98];
    const salesforcePaneColumns = [-0.65, -0.22, 0.22, 0.65];
    salesforcePaneRows.forEach((row, rowIndex) => {
      const t = THREE.MathUtils.clamp((row - 8) / salesforceShaftHeight, 0, 1);
      const radius = 14 * (0.62 - 0.12 * t);
      const paneRadius = Math.max(radius, 8);
      salesforcePaneColumns.forEach((column, columnIndex) => {
        const tangentOffset = paneRadius * column;
        // Approximate the six-sided shaft support along the C3 normal. The
        // 0.92 factor is the authored hex face support ratio; +0.4m is the
        // real surface offset that keeps depth-tested panes out of the glass.
        const radialSurface = Math.sqrt(
          Math.max(0, (radius * 0.92) ** 2 - tangentOffset ** 2),
        ) + 0.4;
        const pane = new THREE.Mesh(
          shared.window,
          shared.materials.landmarkNight[(rowIndex * 3 + columnIndex + 1) % shared.materials.landmarkNight.length],
        );
        pane.name = `Salesforce Tower sparse night pane ${rowIndex + 1}-${columnIndex + 1}`;
        pane.position.set(
          salesforceX + salesforceFaceNormal.x * radialSurface
            + salesforceFaceTangent.x * tangentOffset,
          salesforceBase + row,
          salesforceZ + salesforceFaceNormal.z * radialSurface
            + salesforceFaceTangent.z * tangentOffset,
        );
        pane.rotation.y = Math.atan2(-salesforceFaceNormal.z, salesforceFaceNormal.x);
        pane.scale.set(
          0.09,
          1.72 + ((rowIndex + columnIndex) % 3) * 0.42,
          2.0 + ((rowIndex * 2 + columnIndex) % 3) * 0.38,
        );
        pane.userData.landmarkNightPane = 'salesforce';
        pane.userData.facadeNightOverlay = true;
        pane.userData.cameraFacingSurface = 'C3-radial-hex-face';
        pane.material.depthTest = true;
        pane.castShadow = false;
        pane.receiveShadow = false;
        group.add(pane);
      });
    });
    const salesforceCrownHeight = 34;
    const salesforceCrown = new THREE.Mesh(shared.tower, shared.materials.salesforceCrown);
    salesforceCrown.name = 'Salesforce Tower stepped crown';
    salesforceCrown.position.set(
      salesforceX,
      salesforceBase + 8 + salesforceShaftHeight + salesforceCrownHeight * 0.5,
      salesforceZ,
    );
    salesforceCrown.scale.set(12, salesforceCrownHeight, 12);
    salesforceCrown.castShadow = true;
    group.add(salesforceCrown);
    const salesforceCrownShoulder = addSurfaceBox(
      'Salesforce Tower crown shoulder ring',
      salesforceX,
      salesforceZ,
      [24, 2.3, 26],
      shared.materials.salesforceAccent,
      150,
    );
    salesforceCrownShoulder.castShadow = true;
    const salesforceCrownCap = addSurfaceBox(
      'Salesforce Tower crown cap',
      salesforceX,
      salesforceZ,
      [16, 2.2, 18],
      shared.materials.salesforceCap,
      153,
    );
    salesforceCrownCap.castShadow = true;
    const salesforceBeacon = addSurfaceBox(
      'Salesforce Tower crown beacon base',
      salesforceX,
      salesforceZ,
      [8, 1.6, 8],
      shared.materials.salesforceAccent,
      170,
    );
    salesforceBeacon.castShadow = true;
    const salesforceSpire = new THREE.Mesh(shared.pole, shared.materials.salesforceAccent);
    salesforceSpire.name = 'Salesforce Tower crown spire';
    salesforceSpire.position.set(salesforceX, salesforceBase + 164, salesforceZ);
    salesforceSpire.scale.set(1.2, 18, 1.2);
    salesforceSpire.castShadow = true;
    group.add(salesforceSpire);
    landmarkVisualIdentity = Object.freeze({
      evidenceView: EMBARCADERO_C3_VIEW,
      transamerica: Object.freeze({
        dayMaterials: Object.freeze([
          shared.materials.transamericaBody.name,
          shared.materials.transamericaAccent.name,
          shared.materials.landmarkDarkPodium.name,
        ]),
        structuralCues: Object.freeze([
          'tapered-shaft',
          'four-corner-fins',
          'two-structural-belts',
          'spire',
        ]),
        nightPaneCount: 24,
        nightPaneGrid: '4x6',
        nightPanePalette: 'warm-cool-separated',
      }),
      salesforce: Object.freeze({
        dayMaterials: Object.freeze([
          shared.materials.salesforceGlass.name,
          shared.materials.salesforceAccent.name,
          shared.materials.salesforceCrown.name,
          shared.materials.salesforceCap.name,
        ]),
        structuralCues: Object.freeze([
          'tapered-glass-shaft',
          'four-vertical-ribs',
          'three-horizontal-belts',
          'stepped-crown-and-spire',
        ]),
        nightPaneCount: 24,
        nightPaneGrid: '4x6',
        nightPanePalette: 'warm-cool-separated',
      }),
    });
    group.userData.landmarkVisualIdentity = landmarkVisualIdentity;
    const salesforceDoorZ = salesforceZ - 15.16;
    const salesforceDoor = new THREE.Mesh(shared.box, shared.materials.door);
    salesforceDoor.name = 'Salesforce Transit Center public entrance door';
    salesforceDoor.position.set(salesforceX, salesforceBase + 1.1, salesforceDoorZ);
    salesforceDoor.scale.set(1.4, 2.2, 0.16);
    salesforceDoor.castShadow = false;
    const salesforceSign = new THREE.Mesh(shared.box, shared.materials.entryHeader);
    salesforceSign.name = 'Salesforce Transit Center PUBLIC LOBBY sign';
    salesforceSign.position.set(salesforceX, salesforceBase + 2.42, salesforceDoorZ);
    salesforceSign.scale.set(3.6, 0.2, 0.1);
    salesforceSign.castShadow = false;
    group.add(salesforceDoor, salesforceSign);
    const salesforceWorldY = descriptor.elevation + salesforceBase;
    buildingVolumes.push(Object.freeze({
      id: `${descriptor.key}:waterfront:salesforce-tower`,
      buildingIndex: buildingVolumes.length,
      sectorKey: descriptor.key,
      coordinateSpace: 'world',
      district: blueprint.district,
      quality: 'detail',
      source: 'authored-waterfront-entrance',
      architecturalFaces: 4,
      facadeAtlasCell: 3,
      geometryStyle: 'landmark',
      frontageYaw: 0,
      storefrontBand: true,
      floors: 62,
      rooms: Object.freeze([{
        id: `${descriptor.key}:waterfront:salesforce-room`,
        floor: 1,
        state: 'district-archetype-room',
        walkable: true,
        archetype: 'financial-office',
      }]),
      interiorState: 'district-archetype-room',
      interiorArchetype: 'financial-office',
      collisionMode: 'aabb-shell',
      doorMesh: true,
      signposted: true,
      entrance: Object.freeze({
        x: salesforceWorldX,
        y: salesforceWorldY + 1.1,
        z: descriptor.center.z + salesforceDoorZ,
        normalX: 0,
        normalZ: -1,
        returnPath: Object.freeze([
          Object.freeze({ x: salesforceWorldX, y: salesforceWorldY + 0.8, z: descriptor.center.z + salesforceDoorZ - 3.6 }),
          Object.freeze({ x: salesforceWorldX, y: salesforceWorldY + 0.8, z: descriptor.center.z + salesforceDoorZ - 8 }),
        ]),
      }),
      center: Object.freeze({ x: salesforceWorldX, y: salesforceWorldY + 8 + 145, z: salesforceWorldZ }),
      min: Object.freeze({ x: salesforceWorldX - 18, y: salesforceWorldY, z: salesforceWorldZ - 15 }),
      max: Object.freeze({ x: salesforceWorldX + 18, y: salesforceWorldY + 223, z: salesforceWorldZ + 15 }),
      label: 'Salesforce Transit Center Tower',
    }));
    // Promenade furniture remains in the same grade frame as the seawall and
    // facade frontage so two benches and four trees read as grounded public
    // realm instead of floating props.
    const waterfrontTree = (name, xTree, zTree, scale = 1) => {
      const tree = new THREE.Group();
      tree.name = name;
      tree.position.set(xTree, surfaceAt(xTree, zTree), zTree);
      tree.rotation.x = -Math.atan(waterfrontGradeAt(xTree, zTree, 4));
      const trunk = new THREE.Mesh(shared.trunk, shared.materials.trunk);
      trunk.position.y = 1.08 * scale;
      trunk.scale.set(0.24 * scale, 2.16 * scale, 0.24 * scale);
      const canopy = new THREE.Mesh(shared.canopy, shared.materials.tree);
      canopy.position.y = 4.1 * scale;
      canopy.scale.set(2.15 * scale, 4.2 * scale, 2.15 * scale);
      tree.add(trunk, canopy);
      tree.userData.grounded = true;
      tree.userData.waterfrontCorridor = 'embarcadero-164m-east-frontage';
      group.add(tree);
    };
    [[160, -68, 1.05], [160, -20, 0.96], [160, 28, 1.04], [160, 68, 0.94]].forEach(([tx, tz, scale], index) => {
      waterfrontTree(`Embarcadero waterfront street tree ${index + 1}`, tx, tz, scale);
    });
    const waterfrontBench = (name, xBench, zBench, heading) => {
      const bench = new THREE.Group();
      bench.name = name;
      bench.position.set(xBench, surfaceAt(xBench, zBench), zBench);
      bench.rotation.x = -Math.atan(waterfrontGradeAt(xBench, zBench, 2));
      bench.rotation.y = heading;
      const seat = new THREE.Mesh(shared.box, shared.materials.boardwalk);
      seat.position.y = 0.78;
      seat.scale.set(0.9, 0.18, 3.2);
      const back = new THREE.Mesh(shared.box, shared.materials.boardwalk);
      back.position.set(0, 1.38, 0.38);
      back.scale.set(0.9, 0.92, 3.2);
      const legA = new THREE.Mesh(shared.box, shared.materials.signalHousing);
      legA.position.set(0, 0.36, -1.06);
      legA.scale.set(0.7, 0.72, 0.18);
      const legB = legA.clone();
      legB.position.z = 0.82;
      bench.add(seat, back, legA, legB);
      bench.userData.grounded = true;
      bench.userData.waterfrontCorridor = 'embarcadero-164m-east-frontage';
      group.add(bench);
    };
    waterfrontBench('Embarcadero waterfront public bench south', 161, -42, Math.PI * 0.5);
    waterfrontBench('Embarcadero waterfront public bench north', 161, 42, Math.PI * 0.5);
    group.userData.waterfrontCorridor = Object.freeze({
      id: 'embarcadero-164m-east-frontage',
      startZ: -82,
      endZ: 82,
      centerX: 154,
      length: 164,
      source: 'Embarcadero seawall / pier grid',
      shorelineX: 176,
      evidenceView: EMBARCADERO_C3_VIEW,
    });
    landmark = {
      x: pyramidX,
      z: pyramidZ,
      width: 28,
      depth: 28,
      height: 140,
      style: 'landmark',
      heading: 0,
      baseY: pyramidBase,
      label: 'Transamerica Pyramid',
    };
  } else if (blueprint.landmark === 'sfmoma-design') {
    // SoMa Design District: museum massing, showroom strip, loading-dock character.
    const x = 40;
    const z = 120;
    const base = surfaceAt(x, z);
    const museum = addSurfaceBox('SFMOMA museum massing', x, z, [42, 24, 34], shared.materials.landmarkStone);
    museum.castShadow = true;
    const museumBand = addSurfaceBox('SFMOMA upper band', x, z, [46, 4, 36], shared.materials.window, 24);
    museumBand.castShadow = true;
    const showroom = addSurfaceBox('Design District showroom strip', 0, -40, [70, 9, 18], shared.materials.landmarkBrick);
    showroom.castShadow = true;
    for (let index = 0; index < 5; index += 1) {
      const bay = addSurfaceBox(
        `Design District glass bay ${index + 1}`,
        -28 + index * 14,
        -49.1,
        [10, 4.2, 0.16],
        shared.materials.window,
        2.4,
      );
      bay.castShadow = false;
    }
    const overpass = addSurfaceBox('SoMa freeway overpass slab', -120, -160, [70, 2.4, 14], shared.materials.landmarkStone, 8);
    overpass.castShadow = true;
    [-145, -120, -95].forEach((pierX, index) => {
      const pier = addSurfaceBox(
        `SoMa overpass pier ${index + 1}`,
        pierX,
        -160,
        [3.2, 8, 3.2],
        shared.materials.landmarkStone,
      );
      pier.castShadow = true;
    });
    // Loading-dock rhythm on the warehouse face.
    for (let index = 0; index < 4; index += 1) {
      const dock = addSurfaceBox(
        `SoMa loading dock ${index + 1}`,
        -20 + index * 12,
        -50.2,
        [8, 3.2, 0.2],
        shared.materials.signalHousing,
        0.2,
      );
      dock.castShadow = true;
      const apron = addSurfaceBox(
        `SoMa loading apron ${index + 1}`,
        -20 + index * 12,
        -54,
        [8, 0.18, 6],
        shared.materials.sidewalk,
      );
      apron.receiveShadow = true;
    }
    landmark = {
      x,
      z,
      width: 44,
      depth: 36,
      height: 28,
      style: 'landmark',
      heading: 0,
      baseY: base,
      label: 'SFMOMA / Yerba Buena massing',
    };
  } else if (blueprint.landmark === 'ggp-meadow') {
    // Block-level park: meadow cells, JFK promenade, Conservatory Drive loop,
    // Music Concourse museum band, and tree lines along each path edge.
    [
      [0, 24, 100, 70],
      [-80, -40, 48, 40],
      [72, -20, 44, 36],
      [40, 100, 56, 32],
    ].forEach(([mx, mz, mw, md], index) => {
      const meadow = addSurfaceBox(`Golden Gate Park meadow cell ${index + 1}`, mx, mz, [mw, 0.32, md], shared.materials.park);
      meadow.receiveShadow = true;
    });
    const jfk = addSurfaceStrip('Golden Gate Park JFK Promenade', [-170, 8], [170, 8], 8.5, shared.materials.sidewalk, 0.05, 20);
    jfk.receiveShadow = true;
    const jfkCurb = addSurfaceStrip('Golden Gate Park JFK curb band', [-170, 8], [170, 8], 10.2, shared.materials.curb, 0.02, 20);
    jfkCurb.receiveShadow = true;
    const transverse = addSurfaceStrip('Golden Gate Park Transverse Drive', [0, -160], [0, 160], 7.2, shared.materials.road, 0.04, 20);
    transverse.receiveShadow = true;
    const conservatoryDrive = addSurfaceStrip('Conservatory Drive East loop', [-90, 40], [-20, 70], 5.5, shared.materials.sidewalk, 0.05, 16);
    conservatoryDrive.receiveShadow = true;
    const conservatory = addSurfaceBox('Conservatory of Flowers mass', -48, 56, [32, 10, 18], shared.materials.landmarkStone);
    conservatory.castShadow = true;
    const wingL = addSurfaceBox('Conservatory west wing', -68, 56, [12, 7, 14], shared.materials.window, 1.5);
    wingL.castShadow = true;
    const wingR = addSurfaceBox('Conservatory east wing', -28, 56, [12, 7, 14], shared.materials.window, 1.5);
    wingR.castShadow = true;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(8.2, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), shared.materials.window);
    dome.name = 'Conservatory of Flowers dome';
    dome.position.set(-48, surfaceAt(-48, 56) + 12.2, 56);
    dome.castShadow = true;
    group.add(dome);
    // Music Concourse / museum band south of JFK.
    const concourse = addSurfaceBox('Music Concourse plaza', 48, -36, [56, 0.28, 28], shared.materials.sidewalk);
    concourse.receiveShadow = true;
    const deYoung = addSurfaceBox('de Young museum mass cue', 72, -48, [28, 14, 18], shared.materials.landmarkStone);
    deYoung.castShadow = true;
    const academy = addSurfaceBox('Academy of Sciences mass cue', 24, -48, [26, 12, 18], shared.materials.landmarkStone);
    academy.castShadow = true;
    // Tree lines along JFK and Transverse — every ~24 m like park allées.
    for (let t = -156; t <= 156; t += 24) {
      [
        [t, 14], [t, 2], [12, t], [-12, t],
      ].forEach(([tx, tz], index) => {
        if (Math.abs(tx) > 175 || Math.abs(tz) > 175) return;
        const trunk = new THREE.Mesh(shared.trunk, shared.materials.trunk);
        trunk.name = `GGP allée trunk ${t}:${index}`;
        trunk.position.set(tx, surfaceAt(tx, tz) + 1.7, tz);
        trunk.scale.set(1.05, 3.4, 1.05);
        trunk.castShadow = true;
        const canopy = new THREE.Mesh(shared.canopy, shared.materials.tree);
        canopy.name = `GGP allée canopy ${t}:${index}`;
        canopy.position.set(tx, surfaceAt(tx, tz) + 5.6, tz);
        canopy.scale.set(3.8, 3.2, 3.8);
        canopy.castShadow = true;
        group.add(trunk, canopy);
      });
    }
    // Path benches / lamp posts along the promenade sidewalk edge.
    for (let bx = -140; bx <= 140; bx += 36) {
      const bench = addSurfaceBox(`JFK Promenade bench ${bx}`, bx, 16, [1.8, 0.45, 0.5], shared.materials.trim, 0.2);
      bench.castShadow = true;
      const lamp = addSurfaceBox(`JFK Promenade lamp ${bx}`, bx + 8, 16, [0.22, 3.4, 0.22], shared.materials.signalHousing, 0.2);
      lamp.castShadow = true;
    }
    landmark = {
      x: -48, z: 56, width: 32, depth: 18, height: 16, style: 'landmark', heading: 0,
      baseY: surfaceAt(-48, 56), label: 'Conservatory of Flowers',
    };
  } else if (blueprint.landmark === 'richmond-row') {
    // Continuous Clement/Geary stucco rows with sidewalk apron, bay windows,
    // and corner storefronts every block (~48 m).
    const base = surfaceAt(0, 0);
    for (let block = -3; block <= 3; block += 1) {
      const rowZ = block * 48;
      for (let lot = 0; lot < 4; lot += 1) {
        const rowX = -72 + lot * 16 + (block % 2) * 4;
        const h = 8 + ((lot + block + 7) % 4);
        const house = addSurfaceBox(
          `Richmond block ${block} lot ${lot + 1}`,
          rowX,
          rowZ,
          [13.5, h, 10.5],
          lot % 2 === 0 ? shared.materials.sandLight : shared.materials.landmarkStone,
        );
        house.castShadow = true;
        const bay = addSurfaceBox(
          `Richmond bay ${block}-${lot}`,
          rowX,
          rowZ - 5.6,
          [3.8, 2.2, 1.0],
          shared.materials.window,
          2.8,
        );
        bay.castShadow = false;
        if (lot === 0) {
          const store = addSurfaceBox(
            `Richmond corner storefront ${block}`,
            rowX - 2,
            rowZ + 6.2,
            [8, 3.2, 1.2],
            shared.materials.window,
            0.4,
          );
          store.castShadow = false;
          const awning = addSurfaceBox(
            `Richmond awning ${block}`,
            rowX - 2,
            rowZ + 7.0,
            [8.4, 0.18, 1.6],
            shared.materials.trim,
            3.5,
          );
          awning.castShadow = true;
        }
      }
      const sidewalk = addSurfaceBox(
        `Richmond sidewalk apron block ${block}`,
        0,
        rowZ - 8.2,
        [160, 0.16, 3.2],
        shared.materials.sidewalk,
      );
      sidewalk.receiveShadow = true;
    }
    // Geary corridor wider paving cue through the mid-sector.
    const geary = addSurfaceStrip('Geary Boulevard corridor', [-180, 0], [180, 0], 14, shared.materials.road, 0.03, 24);
    geary.receiveShadow = true;
    landmark = {
      x: 0, z: 0, width: 90, depth: 14, height: 12, style: 'landmark', heading: 0, baseY: base, label: 'Richmond Geary / Clement rows',
    };
  } else if (blueprint.landmark === 'inner-sunset-n-judah') {
    // Judah corridor: twin tracks, platforms every block, slow-street houses.
    const z = -12;
    const base = surfaceAt(8, z);
    const tracks = addSurfaceStrip('N Judah twin tracks', [-180, z], [180, z], 4.4, shared.materials.road, 0.05, 20);
    tracks.receiveShadow = true;
    [-1.1, 1.1].forEach((offset, index) => {
      const rail = addSurfaceStrip(
        `N Judah rail ${index + 1}`,
        [-180, z + offset],
        [180, z + offset],
        0.22,
        shared.materials.trim,
        0.07,
        20,
      );
      rail.receiveShadow = true;
    });
    for (let stop = -2; stop <= 2; stop += 1) {
      const sx = stop * 72;
      const shelter = addSurfaceBox(`N Judah shelter ${stop}`, sx, z + 7, [9.5, 3.0, 3.2], shared.materials.landmarkStone, 0.2);
      shelter.castShadow = true;
      const roof = addSurfaceBox(`N Judah shelter roof ${stop}`, sx, z + 7, [10.8, 0.32, 3.8], shared.materials.roof, 3.2);
      roof.castShadow = true;
      const platform = addSurfaceBox(`N Judah platform ${stop}`, sx, z + 4.2, [14, 0.22, 3.6], shared.materials.sidewalk, 0.08);
      platform.receiveShadow = true;
      const pole = addSurfaceBox(`N Judah stop pole ${stop}`, sx - 5.2, z + 7, [0.18, 3.6, 0.18], shared.materials.signalHousing, 0.2);
      pole.castShadow = true;
    }
    // Slow residential frontages north of Judah.
    for (let block = -3; block <= 3; block += 1) {
      for (let lot = 0; lot < 3; lot += 1) {
        const hx = -96 + block * 48 + lot * 14;
        const house = addSurfaceBox(
          `Inner Sunset house ${block}-${lot}`,
          hx,
          36,
          [12, 7 + (lot % 3), 10],
          lot % 2 ? shared.materials.sandLight : shared.materials.landmarkStone,
        );
        house.castShadow = true;
      }
      const walk = addSurfaceBox(`Inner Sunset sidewalk ${block}`, block * 48, 28, [40, 0.14, 3.0], shared.materials.sidewalk);
      walk.receiveShadow = true;
    }
    landmark = {
      x: 8, z: z + 7, width: 12, depth: 5, height: 4, style: 'landmark', heading: 0, baseY: base, label: 'N Judah / Inner Sunset',
    };
  } else if (blueprint.landmark === 'twin-peaks-overlook') {
    const x = 0;
    const z = 48;
    const base = surfaceAt(x, z);
    // Stepped ridge meadow terraces + summit roads.
    [
      [0, 10, 90, 2.0],
      [0, 40, 70, 3.2],
      [0, 70, 50, 4.6],
    ].forEach(([mx, mz, mw, mh], index) => {
      const terrace = addSurfaceBox(`Twin Peaks terrace ${index + 1}`, mx, mz, [mw, mh, 34], shared.materials.park, index * 0.8);
      terrace.castShadow = true;
    });
    const ridgeRoad = addSurfaceStrip('Twin Peaks Blvd ridge road', [-40, -20], [40, 120], 6.5, shared.materials.road, 0.06, 16);
    ridgeRoad.receiveShadow = true;
    const overlook = addSurfaceBox('Twin Peaks overlook deck', x, z, [22, 0.5, 12], shared.materials.landmarkStone, 3.2);
    overlook.castShadow = true;
    const rail = addSurfaceBox('Twin Peaks overlook rail', x, z + 5.4, [20, 0.95, 0.24], shared.materials.trim, 3.7);
    rail.castShadow = true;
    const westPeak = addSurfaceBox('Twin Peaks west summit', -28, 84, [18, 10, 16], shared.materials.sand, 2);
    westPeak.castShadow = true;
    const eastPeak = addSurfaceBox('Twin Peaks east summit', 30, 92, [16, 12, 14], shared.materials.sand, 2.4);
    eastPeak.castShadow = true;
    for (let step = 0; step < 10; step += 1) {
      const tread = addSurfaceBox(
        `Twin Peaks stair ${step + 1}`,
        -12,
        20 - step * 3.5,
        [5.5, 0.28, 2.2],
        shared.materials.landmarkStone,
        3.2 - step * 0.28,
      );
      tread.castShadow = true;
    }
    landmark = {
      x, z, width: 22, depth: 12, height: 5, style: 'landmark', heading: 0, baseY: base + 3.2, label: 'Twin Peaks overlook',
    };
  } else if (blueprint.landmark === 'haight-ashbury-strip') {
    // Haight Street commercial strip with Victorian bay houses on side blocks.
    const base = surfaceAt(0, 0);
    const haight = addSurfaceStrip('Haight Street pavement', [-180, 0], [180, 0], 12, shared.materials.road, 0.03, 24);
    haight.receiveShadow = true;
    for (let side of [-1, 1]) {
      for (let lot = -5; lot <= 5; lot += 1) {
        const hx = lot * 28;
        const store = addSurfaceBox(
          `Haight storefront ${side}:${lot}`,
          hx,
          side * 10,
          [22, 5.5 + (Math.abs(lot) % 3), 8],
          lot % 2 ? shared.materials.sandLight : shared.materials.landmarkBrick,
        );
        store.castShadow = true;
        const bay = addSurfaceBox(
          `Haight Victorian bay ${side}:${lot}`,
          hx,
          side * 14.2,
          [6, 4.2, 1.4],
          shared.materials.window,
          4.5,
        );
        bay.castShadow = false;
        const awning = addSurfaceBox(
          `Haight awning ${side}:${lot}`,
          hx,
          side * 14.8,
          [18, 0.16, 1.8],
          shared.materials.trim,
          3.2,
        );
        awning.castShadow = true;
      }
      const walk = addSurfaceBox(`Haight sidewalk ${side}`, 0, side * 7.2, [340, 0.14, 3.4], shared.materials.sidewalk);
      walk.receiveShadow = true;
    }
    // Ashbury cross marker.
    const ashbury = addSurfaceBox('Ashbury corner plaza', 0, 0, [16, 0.2, 16], shared.materials.sidewalk, 0.08);
    ashbury.receiveShadow = true;
    landmark = {
      x: 0, z: 10, width: 24, depth: 10, height: 10, style: 'landmark', heading: 0, baseY: base, label: 'Haight-Ashbury strip',
    };
  } else if (blueprint.landmark === 'castro-theatre-row') {
    const base = surfaceAt(0, 20);
    const castro = addSurfaceStrip('Castro Street pavement', [0, -170], [0, 170], 11, shared.materials.road, 0.03, 24);
    castro.receiveShadow = true;
    for (let lot = -4; lot <= 4; lot += 1) {
      const hz = lot * 32;
      const house = addSurfaceBox(
        `Castro rowhouse ${lot}`,
        12,
        hz,
        [14, 9 + (Math.abs(lot) % 4), 11],
        lot % 2 ? shared.materials.sandLight : shared.materials.landmarkBrick,
      );
      house.castShadow = true;
      const bay = addSurfaceBox(`Castro bay ${lot}`, 18.2, hz, [1.2, 3.4, 5], shared.materials.window, 3);
      bay.castShadow = false;
    }
    const theatre = addSurfaceBox('Castro Theatre mass', -18, 24, [22, 16, 28], shared.materials.landmarkStone);
    theatre.castShadow = true;
    const marquee = addSurfaceBox('Castro Theatre marquee', -18, 38, [24, 1.4, 6], shared.materials.trim, 8);
    marquee.castShadow = true;
    const blade = addSurfaceBox('Castro Theatre blade sign', -18, 40, [2.2, 14, 1.2], shared.materials.window, 10);
    blade.castShadow = true;
    for (let step = 0; step < 8; step += 1) {
      const tread = addSurfaceBox(
        `Castro hill stair ${step + 1}`,
        40,
        -40 + step * 3.2,
        [6, 0.26, 2.4],
        shared.materials.landmarkStone,
        step * 0.4,
      );
      tread.castShadow = true;
    }
    landmark = {
      x: -18, z: 24, width: 22, depth: 28, height: 18, style: 'landmark', heading: 0, baseY: base, label: 'Castro Theatre row',
    };
  } else if (blueprint.landmark === 'fillmore-plaza') {
    const base = surfaceAt(0, 0);
    const fillmore = addSurfaceStrip('Fillmore Street pavement', [0, -170], [0, 170], 13, shared.materials.road, 0.03, 24);
    fillmore.receiveShadow = true;
    const geary = addSurfaceStrip('Geary at Fillmore pavement', [-170, 0], [170, 0], 14, shared.materials.road, 0.03, 24);
    geary.receiveShadow = true;
    const plaza = addSurfaceBox('Fillmore plaza paving', 24, 24, [36, 0.22, 36], shared.materials.sidewalk);
    plaza.receiveShadow = true;
    for (let i = 0; i < 4; i += 1) {
      const midrise = addSurfaceBox(
        `Fillmore midrise ${i + 1}`,
        -40 + (i % 2) * 50,
        -30 + Math.floor(i / 2) * 50,
        [22, 22 + i * 3, 18],
        i % 2 ? shared.materials.landmarkStone : shared.materials.window,
      );
      midrise.castShadow = true;
    }
    const jazz = addSurfaceBox('Fillmore jazz marque cue', 24, 40, [18, 8, 10], shared.materials.landmarkBrick);
    jazz.castShadow = true;
    landmark = {
      x: 24, z: 24, width: 36, depth: 36, height: 10, style: 'landmark', heading: 0, baseY: base, label: 'Fillmore plaza',
    };
  } else if (blueprint.landmark === 'laurel-heights-ridge') {
    const base = surfaceAt(0, 20);
    for (let block = -3; block <= 3; block += 1) {
      for (let lot = 0; lot < 3; lot += 1) {
        const hx = -90 + block * 48 + lot * 15;
        const villa = addSurfaceBox(
          `Laurel Heights villa ${block}-${lot}`,
          hx,
          20 + (block % 2) * 8,
          [13, 9 + lot, 12],
          lot % 2 ? shared.materials.sandLight : shared.materials.landmarkStone,
        );
        villa.castShadow = true;
      }
      const walk = addSurfaceBox(`Laurel Heights sidewalk ${block}`, block * 48, 8, [42, 0.14, 3.2], shared.materials.sidewalk);
      walk.receiveShadow = true;
    }
    const ridge = addSurfaceBox('Laurel Heights park edge', -120, 80, [40, 1.2, 60], shared.materials.park);
    ridge.castShadow = true;
    landmark = {
      x: 0, z: 20, width: 20, depth: 14, height: 12, style: 'landmark', heading: 0, baseY: base, label: 'Laurel Heights ridge',
    };
  } else if (blueprint.landmark === 'skyline' || blueprint.landmark === 'hill-villas') {
    // Villa pulled closer to the NS street (local x=0) for 0:4 east-facing hero.
    const x = blueprint.landmark === 'skyline' ? 0 : -18;
    const z = blueprint.landmark === 'skyline' ? 88 : 72;
    const base = surfaceAt(x, z);
    const skyline = blueprint.landmark === 'skyline';
    const height = skyline ? 176 : 26;
    const width = skyline ? 20 : 20;
    const depth = skyline ? 20 : 18;
    if (skyline) {
      // Pass15: readable Transamerica-class pyramid (not nested smooth cones).
      const pyramidRoot = new THREE.Group();
      pyramidRoot.name = 'Financial District Transamerica landmark';
      pyramidRoot.position.set(x, base, z);
      pyramidRoot.userData.fogExempt = true;
      const limestone = shared.materials.landmarkStone;
      const glazingMat = new THREE.MeshStandardMaterial({
        color: 0x1c2430,
        roughness: 0.28,
        metalness: 0.62,
        emissive: 0x0a1218,
        emissiveIntensity: 0.12,
      });
      const podium = new THREE.Mesh(shared.box, limestone);
      podium.name = 'Financial District Transamerica plaza podium';
      podium.position.set(0, 4, 0);
      podium.scale.set(width * 1.55, 8, depth * 1.55);
      podium.castShadow = true;
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(2.4, 15.2, 118, 4, 1, false, Math.PI * 0.25),
        limestone,
      );
      shaft.name = 'Financial District Transamerica pyramid shaft';
      shaft.position.y = 8 + 59;
      shaft.castShadow = true;
      pyramidRoot.add(podium, shaft);
      // Four recessed dark glazing faces — the SF pyramid read from street.
      const faceAngles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
      faceAngles.forEach((angle, index) => {
        const radial = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
        const tangent = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle));
        const bottom = radial.clone().multiplyScalar(14.6);
        const top = radial.clone().multiplyScalar(2.55);
        bottom.y = 12;
        top.y = 118;
        const hwB = 4.2;
        const hwT = 0.55;
        const verts = [
          bottom.clone().addScaledVector(tangent, -hwB),
          bottom.clone().addScaledVector(tangent, hwB),
          top.clone().addScaledVector(tangent, hwT),
          top.clone().addScaledVector(tangent, -hwT),
        ];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(
          verts.flatMap((v) => [v.x, v.y, v.z]),
          3,
        ));
        geo.setIndex([0, 1, 2, 0, 2, 3]);
        geo.computeVertexNormals();
        const panel = new THREE.Mesh(geo, glazingMat);
        panel.name = `Financial District Transamerica glazing ${index + 1}`;
        panel.castShadow = true;
        pyramidRoot.add(panel);
      });
      for (let tier = 0; tier < 14; tier += 1) {
        const t = tier / 13;
        const radius = THREE.MathUtils.lerp(15.0, 2.6, t);
        const band = new THREE.Mesh(
          new THREE.CylinderGeometry(radius + 0.12, radius + 0.12, 0.22, 4, 1, false, Math.PI * 0.25),
          glazingMat,
        );
        band.position.y = 14 + tier * 7.4;
        band.castShadow = true;
        pyramidRoot.add(band);
      }
      // Wing buttresses (Transamerica shoulders).
      [
        [-12.5, 0, 22, 8],
        [12.5, 0, 22, 8],
        [0, -12.5, 18, 7],
        [0, 12.5, 18, 7],
      ].forEach(([ox, oz, h, w], index) => {
        const wing = new THREE.Mesh(shared.box, limestone);
        wing.name = `Financial District Transamerica wing ${index + 1}`;
        wing.position.set(ox, 8 + h * 0.5, oz);
        wing.scale.set(ox === 0 ? w : 7.2, h, oz === 0 ? w : 7.2);
        wing.castShadow = true;
        pyramidRoot.add(wing);
      });
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(3.8, 16, 4, 1, false, Math.PI * 0.25),
        limestone,
      );
      crown.name = 'Financial District Transamerica crown';
      crown.position.y = 134;
      crown.rotation.y = Math.PI * 0.25;
      crown.castShadow = true;
      const spire = new THREE.Mesh(shared.pole, limestone);
      spire.name = 'Financial District Transamerica pyramid spire';
      spire.position.set(0, 148, 0);
      spire.scale.set(1.05, 26, 1.05);
      spire.castShadow = true;
      pyramidRoot.add(crown, spire);
      group.add(pyramidRoot);
      [-34, 34].forEach((offsetX, index) => {
        const flankPodium = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
        flankPodium.name = `Financial District canyon flank podium ${index + 1}`;
        flankPodium.position.set(offsetX, base + 3.2, 62);
        flankPodium.scale.set(18, 6.4, 16);
        flankPodium.castShadow = true;
        const flankTower = new THREE.Mesh(shared.box, shared.materials.window);
        flankTower.name = `Financial District canyon flank tower ${index + 1}`;
        flankTower.position.set(offsetX, base + 38, 62);
        flankTower.scale.set(16, 76, 16);
        flankTower.castShadow = true;
        const flankRoof = new THREE.Mesh(shared.box, shared.materials.roof);
        flankRoof.name = `Financial District canyon flank roof ${index + 1}`;
        flankRoof.position.set(offsetX, base + 78, 62);
        flankRoof.scale.set(17.2, 0.42, 17.2);
        flankRoof.castShadow = true;
        group.add(flankPodium, flankTower, flankRoof);
      });
    } else if (blueprint.landmark !== 'hill-villas') {
      const mass = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
      mass.position.set(x, base + height * 0.5, z);
      mass.scale.set(width, height, depth);
      mass.castShadow = true;
      group.add(mass);
    }
    if (blueprint.landmark === 'hill-villas') {
      // Pass17: painted-lady cream villa — porch/bays must read at 0:4 close approach.
      const villa = new THREE.Group();
      villa.name = 'Pacific Heights hill villa';
      villa.position.set(x, base, z);
      // Porch/bays face −Z toward the southbound hill evidence approach.
      villa.rotation.y = 0;
      const villaBodyMat = new THREE.MeshStandardMaterial({
        color: 0xf7ead0,
        roughness: 0.72,
        metalness: 0.03,
        emissive: 0x2a2218,
        emissiveIntensity: 0.08,
      });
      const villaAccentMat = shared.materials.landmarkOrange;
      const villaTrimMat = shared.materials.trim;
      const frontZ = -depth * 0.5;
      const hillPad = new THREE.Mesh(shared.box, shared.materials.sidewalk);
      hillPad.name = 'Pacific Heights villa hill terrace pad';
      hillPad.position.set(0, 0.42, depth * 0.08);
      hillPad.scale.set(width * 1.22, 0.84, depth * 1.18);
      hillPad.receiveShadow = true;
      const body = new THREE.Mesh(shared.box, villaBodyMat);
      body.name = 'Pacific Heights villa body';
      body.position.set(0, height * 0.5 + 0.35, 0);
      body.scale.set(width, height, depth);
      body.castShadow = true;
      body.receiveShadow = true;
      const foundation = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
      foundation.name = 'Pacific Heights villa foundation';
      foundation.position.set(0, 1.45, 0);
      foundation.scale.set(width * 1.06, 2.55, depth * 1.1);
      foundation.castShadow = true;
      for (const bandY of [7.8, 15.6, 22.8]) {
        const band = new THREE.Mesh(shared.box, villaAccentMat);
        band.name = 'Pacific Heights villa floor band';
        band.position.set(0, bandY, frontZ - 0.04);
        band.scale.set(width * 0.98, 0.28, 0.18);
        villa.add(band);
      }
      // Front-wall window grid so street approach never reads as blank cream slab.
      for (const colX of [-7.5, -3.75, 0, 3.75, 7.5]) {
        for (const rowY of [5.2, 10.4, 15.6, 20.8]) {
          const pane = new THREE.Mesh(shared.window, shared.materials.window);
          pane.position.set(colX, rowY, frontZ - 0.12);
          pane.scale.set(2.1, 1.45, 0.1);
          villa.add(pane);
        }
      }
      const porch = new THREE.Mesh(shared.box, villaAccentMat);
      porch.name = 'Pacific Heights villa porch deck';
      porch.position.set(0, 1.18, frontZ - 1.55);
      porch.scale.set(11.2, 0.42, 3.6);
      porch.castShadow = true;
      const porchStep = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
      porchStep.name = 'Pacific Heights villa porch step';
      porchStep.position.set(0, 0.72, frontZ - 3.05);
      porchStep.scale.set(9.6, 0.36, 1.55);
      porchStep.castShadow = true;
      const porchRail = new THREE.Mesh(shared.box, villaTrimMat);
      porchRail.position.set(0, 2.28, frontZ - 2.95);
      porchRail.scale.set(10.6, 0.2, 0.22);
      for (const postX of [-4.2, 0, 4.2]) {
        const post = new THREE.Mesh(shared.pole, villaTrimMat);
        post.position.set(postX, 1.95, frontZ - 2.9);
        post.scale.set(1.6, 1.85, 1.6);
        villa.add(post);
      }
      // Entry door under porch — Painted Lady cue.
      const door = new THREE.Mesh(shared.box, shared.materials.door);
      door.name = 'Pacific Heights villa entry door';
      door.position.set(0, 3.4, frontZ - 0.2);
      door.scale.set(2.4, 4.2, 0.22);
      door.castShadow = true;
      villa.add(door);
      // Bay boxes extrude from the wall; panes sit inset on each bay face.
      for (const bayX of [-6.8, 0, 6.8]) {
        const bay = new THREE.Mesh(shared.box, villaBodyMat);
        bay.name = 'Pacific Heights villa bay';
        bay.position.set(bayX, height * 0.52 + 0.35, frontZ - 0.85);
        bay.scale.set(4.6, height * 0.85, 1.65);
        bay.castShadow = true;
        villa.add(bay);
        const bayTrim = new THREE.Mesh(shared.box, villaAccentMat);
        bayTrim.position.set(bayX, height * 0.52 + 0.35, frontZ - 1.55);
        bayTrim.scale.set(4.85, height * 0.88, 0.14);
        villa.add(bayTrim);
        for (const rowY of [5.8, 11.6, 17.4, 22.8]) {
          const pane = new THREE.Mesh(shared.window, shared.materials.window);
          pane.position.set(bayX, rowY, frontZ - 1.72);
          pane.scale.set(2.7, 1.55, 0.1);
          villa.add(pane);
        }
      }
      for (const rowZ of [-5.4, 0, 5.4]) {
        const sideBay = new THREE.Mesh(shared.box, villaBodyMat);
        sideBay.position.set(width * 0.5 + 0.52, height * 0.5 + 0.35, rowZ);
        sideBay.scale.set(1.05, height * 0.72, 3.55);
        sideBay.castShadow = true;
        villa.add(sideBay);
        const sidePane = new THREE.Mesh(shared.window, shared.materials.window);
        sidePane.position.set(width * 0.5 + 1.02, 11.6, rowZ);
        sidePane.scale.set(0.08, 1.48, 2.4);
        villa.add(sidePane);
      }
      const cornice = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
      cornice.name = 'Pacific Heights villa cornice';
      cornice.position.set(0, height + 0.35, 0);
      cornice.scale.set(width * 1.06, 0.42, depth * 1.06);
      cornice.castShadow = true;
      const roofDeck = new THREE.Mesh(shared.box, shared.materials.landmarkOrange);
      roofDeck.name = 'Pacific Heights villa roof deck';
      roofDeck.position.set(0, height + 0.62, 0);
      roofDeck.scale.set(width * 1.02, 0.24, depth * 1.02);
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(11.8, 4.8, 4),
        shared.materials.landmarkOrange,
      );
      roof.name = 'Pacific Heights villa hip roof';
      roof.position.set(0, height + 3.02, 0);
      roof.rotation.y = Math.PI * 0.25;
      roof.castShadow = true;
      const chimney = new THREE.Mesh(shared.box, shared.materials.landmarkBrick);
      chimney.name = 'Pacific Heights villa chimney';
      chimney.position.set(5.4, height + 4.2, 2.2);
      chimney.scale.set(1.35, 3.0, 1.35);
      chimney.castShadow = true;
      villa.add(
        hillPad,
        body,
        foundation,
        porch,
        porchStep,
        porchRail,
        cornice,
        roofDeck,
        roof,
        chimney,
      );
      group.add(villa);
    }
    landmark = {
      x,
      z,
      width,
      depth,
      height,
      style: 'landmark',
      heading: 0,
      baseY: base,
      label: blueprint.landmark === 'skyline'
        ? 'Financial District pyramidal tower'
        : 'Pacific Heights hill villa',
    };
  } else {
    const tower = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
    tower.position.set(0, surfaceAt(0, 0) + 5, 0);
    tower.scale.set(12, 10, 12);
    group.add(tower);
    if (blueprint.landmark !== 'ocean-park-edge') {
      landmark = {
        x: 0,
        z: 0,
        width: 12,
        depth: 12,
        height: 10,
        style: 'landmark',
        heading: 0,
        baseY: surfaceAt(0, 0),
        label: `${blueprint.district} public building`,
      };
    }
  }
  detail.add(group);
  if (landmark) {
    const front = new THREE.Vector2(0, -1).rotateAround(new THREE.Vector2(), landmark.heading);
    const doorX = landmark.x + front.x * (landmark.depth * 0.5 + 0.16);
    const doorZ = landmark.z + front.y * (landmark.depth * 0.5 + 0.16);
    const worldX = descriptor.center.x;
    const worldZ = descriptor.center.z;
    const worldY = descriptor.elevation;
    const door = new THREE.Mesh(shared.box, shared.materials.door);
    door.name = `${landmark.label} public entrance door`;
    door.position.set(doorX, landmark.baseY + 1.1, doorZ);
    door.rotation.y = landmark.heading;
    door.scale.set(1.25, 2.2, 0.16);
    door.castShadow = false;
    const sign = new THREE.Mesh(shared.box, shared.materials.trim);
    sign.name = `${landmark.label} PUBLIC LOBBY sign`;
    sign.position.set(doorX, landmark.baseY + 2.4, doorZ);
    sign.rotation.y = landmark.heading;
    sign.scale.set(1.7, 0.18, 0.08);
    sign.castShadow = false;
    const landmarkInteriorArchetype = {
      'civic-spine': 'civic-lobby',
      skyline: 'financial-office',
      'coit-tower': 'coit',
      'hill-villas': 'sunset-home',
      'presidio-gate': 'presidio-barracks',
      'mission-dolores': 'mission-workshop',
      'mission-bay-crane': 'wharf-chandlery',
      'ocean-park-edge': 'outer-sunset-cafe',
      'dragon-gate': 'market',
      'grace-cathedral': 'library',
      'lombard-switchback': 'rowhouse',
      'palace-of-fine-arts': 'cafe',
      'transamerica-pyramid': 'financial-office',
      'sfmoma-design': 'mission-workshop',
      'ggp-meadow': 'library',
      'richmond-row': 'sunset-home',
      'inner-sunset-n-judah': 'transit',
      'twin-peaks-overlook': 'cafe',
      'haight-ashbury-strip': 'cafe',
      'castro-theatre-row': 'cafe',
      'fillmore-plaza': 'market',
      'laurel-heights-ridge': 'sunset-home',
    }[blueprint.landmark] || 'civic-lobby';
    detail.add(door, sign);
    buildingVolumes.push(Object.freeze({
      id: `${descriptor.key}:landmark:${blueprint.landmark}`,
      buildingIndex: buildingVolumes.length,
      sectorKey: descriptor.key,
      coordinateSpace: 'world',
      district: blueprint.district,
      quality: 'detail',
      source: 'authored-landmark',
      architecturalFaces: 4,
      facadeAtlasCell: 3,
      geometryStyle: 'landmark',
      frontageYaw: landmark.heading,
      storefrontBand: true,
      floors: Math.max(1, Math.floor(landmark.height / 3.2)),
      rooms: Object.freeze([{
        id: `${descriptor.key}:landmark-room`,
        floor: 1,
        state: 'district-archetype-room',
        walkable: true,
        archetype: landmarkInteriorArchetype,
      }]),
      interiorState: 'district-archetype-room',
      interiorArchetype: landmarkInteriorArchetype,
      collisionMode: 'aabb-shell',
      doorMesh: true,
      signposted: true,
      entrance: Object.freeze({
        x: worldX + doorX,
        y: worldY + landmark.baseY + 0.8,
        z: worldZ + doorZ,
        normalX: front.x,
        normalZ: front.y,
        returnPath: Object.freeze([
          Object.freeze({ x: worldX + doorX + front.x * 3.6, y: worldY + landmark.baseY + 0.8, z: worldZ + doorZ + front.y * 3.6 }),
          Object.freeze({ x: worldX + doorX + front.x * 8, y: worldY + landmark.baseY + 0.8, z: worldZ + doorZ + front.y * 8 }),
        ]),
      }),
      center: Object.freeze({ x: worldX + landmark.x, y: worldY + landmark.baseY + landmark.height * 0.5, z: worldZ + landmark.z }),
      min: Object.freeze({ x: worldX + landmark.x - landmark.width * 0.5, y: worldY + landmark.baseY, z: worldZ + landmark.z - landmark.depth * 0.5 }),
      max: Object.freeze({ x: worldX + landmark.x + landmark.width * 0.5, y: worldY + landmark.baseY + landmark.height, z: worldZ + landmark.z + landmark.depth * 0.5 }),
      label: landmark.label,
    }));
  }
  return landmarkVisualIdentity;
}

// Authored signatures are additive overlays on top of the existing pooled
// sector. Generated massing, roads, sidewalks, collision shells, and portals
// remain owned by streaming.js; this layer contributes only the high-value
// geographic cues that make a district read as San Francisco at a glance.
function createExpansionOverlay({ descriptor, blueprint, catalog, shared }) {
  const root = new THREE.Group();
  root.name = `Authored ${blueprint.district} signature overlay`;
  const detail = new THREE.Group();
  detail.name = `${blueprint.district} signature detail`;
  const proxy = new THREE.Group();
  proxy.name = `${blueprint.district} signature proxy`;
  root.add(detail, proxy);
  const surfaceAt = makeSurfaceAt(descriptor, catalog);
  const roadNetwork = createExpansionRoadNetworkForSector(descriptor, blueprint, catalog);
  const buildingPlan = createBuildingPlan(descriptor, blueprint, catalog);
  const buildingPass = addInstancedBuildings(
    detail,
    buildingPlan.plans,
    blueprint,
    shared,
    surfaceAt,
  );

  if (blueprint.diagonal) {
    const roadPositions = [];
    const markingPositions = [];
    const { start, end, width } = blueprint.diagonal;
    addStrip(
      roadPositions,
      null,
      start,
      end,
      width,
      surfaceAt,
      SURFACE_OFFSET,
      new THREE.Color(0x3b4446),
      20,
    );
    addStrip(
      roadPositions,
      null,
      start,
      end,
      width * 0.18,
      surfaceAt,
      SURFACE_OFFSET + 0.016,
      new THREE.Color(0xb5aea2),
      20,
    );
    addStrip(
      markingPositions,
      null,
      start,
      end,
      0.16,
      surfaceAt,
      ROAD_MARKING_OFFSET,
      new THREE.Color(0xf1dfb5),
      8,
    );
    detail.add(
      createSurfaceMesh(`${blueprint.diagonal.name} diagonal arterial`, roadPositions, null, shared.materials.road),
      createSurfaceMesh(`${blueprint.diagonal.name} center marking`, markingPositions, null, shared.materials.marking),
    );
    const diagonalCrosswalkPositions = [];
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const diagonalLength = Math.hypot(dx, dz) || 1;
    const alongX = dx / diagonalLength;
    const alongZ = dz / diagonalLength;
    const acrossX = -alongZ;
    const acrossZ = alongX;
    roadNetwork.crossings.filter((crossing) => crossing.diagonal).forEach((crossing) => {
      for (let stripe = -2; stripe <= 2; stripe += 1) {
        const centerX = crossing.x + alongX * stripe * 1.05;
        const centerZ = crossing.z + alongZ * stripe * 1.05;
        addStrip(
          diagonalCrosswalkPositions,
          null,
          [centerX - acrossX * (crossing.width * 0.5), centerZ - acrossZ * (crossing.width * 0.5)],
          [centerX + acrossX * (crossing.width * 0.5), centerZ + acrossZ * (crossing.width * 0.5)],
          0.42,
          surfaceAt,
          ROAD_MARKING_OFFSET + 0.008,
          new THREE.Color(0xf1dfb5),
          crossing.width,
        );
      }
    });
    if (diagonalCrosswalkPositions.length) {
      detail.add(createSurfaceMesh(`${blueprint.diagonal.name} diagonal crosswalks`, diagonalCrosswalkPositions, null, shared.materials.marking));
    }
  }

  const furniture = addStreetFurniture(detail, blueprint, shared, surfaceAt);
  const visibleSignalIntersections = roadNetwork.signalIntersections
    .filter((entry) => entry.world.signalized !== false);
  const signalMeshes = addSignals(
    detail,
    blueprint,
    descriptor,
    surfaceAt,
    visibleSignalIntersections,
    shared,
  );
  // Landmarks are real public buildings in the authored layer, so publish a
  // lightweight AABB/room descriptor alongside the visual cue. The pooled
  // sector keeps owning generated massing; streaming queries merge this
  // bounded list without changing generated building identity or capacity.
  // Geometry stays sector-local under the overlay group's translation, but
  // every public descriptor is canonical world-space data. Entry queries,
  // collision shells, and return paths must agree with the rendered doorway
  // after the pooled sector is placed at descriptor.center/elevation.
  const buildingVolumes = buildingPass.buildingVolumes.map((volume) => (
    translateAuthoredVolumeToWorld(volume, descriptor)
  ));
  const landmarkVisualIdentity = addLandmark(
    detail,
    blueprint,
    surfaceAt,
    shared,
    buildingVolumes,
    descriptor,
  );
  root.userData.buildingVolumes = Object.freeze(buildingVolumes);

  const proxyAnchor = new THREE.Mesh(shared.box, shared.materials.landmarkStone);
  proxyAnchor.name = `${blueprint.district} proxy landmark silhouette`;
  proxyAnchor.position.set(0, surfaceAt(0, 0) + 5, 0);
  proxyAnchor.scale.set(18, 10, 18);
  proxy.add(proxyAnchor);

  const presentation = Object.freeze({
    district: blueprint.district,
    cue: blueprint.roadName,
    landmark: blueprint.landmark,
    evidenceViews: landmarkVisualIdentity
      ? Object.freeze({ c3: EMBARCADERO_C3_VIEW })
      : null,
    landmarkVisualIdentity,
    roadNames: roadNetwork.roadNames,
    laneCount: roadNetwork.laneData.length,
    crossings: roadNetwork.crossings.length,
    signalCount: signalMeshes.length,
    buildingCount: buildingPass.volumePlan.length,
    authoredWindowCount: buildingPass.volumePlan.reduce((count, plan) => (
      count + Math.min(8, Math.max(2, plan.floors)) * Math.min(4, Math.max(2, Math.floor(plan.width / 7)))
    ), 0),
    architecturalTrimCount: buildingPass.trimCount,
    enterableDoorMarkerCount: buildingPass.entryMarkerCount,
    diagonalCrossingCount: roadNetwork.crossings.filter((crossing) => crossing.diagonal).length,
    waterfront: descriptor.waterfront
      ? Object.freeze({
        source: descriptor.waterfront.source || 'district-frontage',
        distance: descriptor.waterfront.distance,
        outwardNormal: Object.freeze({
          x: descriptor.waterfront.outwardNormal.x,
          z: descriptor.waterfront.outwardNormal.z,
        }),
      })
      : null,
    streetlightCount: furniture.lightCount,
    treeCount: furniture.treeCount,
    streetSignaturePropCount: furniture.signaturePropCount,
    heroRouteCue: furniture.routeCue,
    cableCarRoute: Boolean(furniture.cableCar),
    visibilityCell: `${descriptor.key}:signature-overlay`,
    geometryBudget: {
      diagonalRoadSegments: blueprint.diagonal ? 1 : 0,
      signalHeads: signalMeshes.length * 3,
      buildingMasses: buildingPass.volumePlan.length,
      architecturalTrims: buildingPass.trimCount,
      enterableDoorMarkers: buildingPass.entryMarkerCount,
      streetlights: furniture.lightCount,
      trees: furniture.treeCount,
      streetSignatureProps: furniture.signaturePropCount,
      heroRouteCue: Number(Boolean(furniture.routeCue)),
      cableCarRoute: Number(Boolean(furniture.cableCar)),
    },
  });

  const setActive = (active, quality = 'detail') => {
    root.visible = active;
    detail.visible = active && quality === 'detail';
    proxy.visible = active && quality !== 'detail';
  };
  const setWeather = (weather) => {
    shared.materials.road.roughness = weather === 'drizzle' ? 0.64 : weather === 'fog' ? 0.9 : 0.94;
    shared.materials.window.opacity = weather === 'fog' ? 0.78 : 1;
  };
  const setNightLighting = (amount = 0) => {
    const night = THREE.MathUtils.clamp(Number(amount) || 0, 0, 1);
    shared.materials.window.emissiveIntensity = THREE.MathUtils.lerp(0.22, 1.85, night);
    shared.materials.entryHeader.emissiveIntensity = THREE.MathUtils.lerp(0.16, 1.1, night);
    // Keep the two Embarcadero hero silhouettes dark and color-separated by
    // day.  Night raises only a restrained material-local response; the
    // separated warm/cool panes below remain the readable occupancy source.
    shared.materials.landmarkDarkPodium.emissiveIntensity = THREE.MathUtils.lerp(0.01, 0.05, night);
    shared.materials.transamericaBody.emissiveIntensity = THREE.MathUtils.lerp(0.04, 0.24, night);
    shared.materials.transamericaAccent.emissiveIntensity = THREE.MathUtils.lerp(0.03, 0.36, night);
    shared.materials.salesforceGlass.emissiveIntensity = THREE.MathUtils.lerp(0.04, 0.22, night);
    shared.materials.salesforceAccent.emissiveIntensity = THREE.MathUtils.lerp(0.03, 0.38, night);
    shared.materials.salesforceCrown.emissiveIntensity = THREE.MathUtils.lerp(0.04, 0.24, night);
    shared.materials.salesforceCap.emissiveIntensity = THREE.MathUtils.lerp(0.03, 0.34, night);
    if (shared.materials.shorelineReflection) {
      // MeshBasicMaterial has no emissive channel; use its base color and
      // normal alpha lifecycle to keep the vertex-colored bands legible.
      shared.materials.shorelineReflection.opacity = THREE.MathUtils.lerp(0.74, 0.96, night);
      shared.materials.shorelineReflection.color.setRGB(
        THREE.MathUtils.lerp(1.0, 0.94, night),
        THREE.MathUtils.lerp(1.0, 0.98, night),
        THREE.MathUtils.lerp(1.0, 1.08, night),
      );
    }
    if (shared.materials.shorelineWaterField) {
      shared.materials.shorelineWaterField.color.setRGB(
        THREE.MathUtils.lerp(1.0, 1.16, night),
        THREE.MathUtils.lerp(1.0, 1.28, night),
        THREE.MathUtils.lerp(1.0, 1.46, night),
      );
    }
    // At sunset the baked photo grid is only a dark architectural skin;
    // sparse per-bay panes below own the readable occupancy lights.
    const bakedGridBrightness = [0.16, 0.075, 0.2, 0.1];
    shared.facadePhotoMaterials.forEach((family, familyIndex) => {
      family.forEach((material, bayIndex) => {
        const base = shared.facadePhotoBaseColors[familyIndex][bayIndex];
        const nightBrightness = bakedGridBrightness[bayIndex];
        material.color.copy(base).multiplyScalar(THREE.MathUtils.lerp(1, nightBrightness, night));
      });
    });
    shared.materials.facadeNight.forEach((material, index) => {
      const occupancy = [0.52, 0.24, 0.7, 0.36][index];
      material.opacity = night * (0.08 + occupancy * 0.16);
      material.emissiveIntensity = night * (0.55 + occupancy * 0.45);
    });
    shared.materials.landmarkNight.forEach((material, index) => {
      const occupancy = [0.52, 0.24, 0.7, 0.36][index];
      material.opacity = night * (0.62 + occupancy * 0.28);
      material.emissiveIntensity = night * (2.0 + occupancy * 1.1);
    });
  };
  let lastSignalUpdate = -Infinity;
  const update = (dt, elapsed) => {
    void dt;
    const time = Number.isFinite(elapsed) ? elapsed : 0;
    if (furniture.cableCar) {
      // Keep the hero vehicle in the visible mid-block segment. A full
      // sector loop could cross the orbit camera's near field during a long
      // QA settle and turn the car into a frame-blocking foreground column.
      const localZ = ((time * 2.6 + 24) % 80) + 12;
      furniture.cableCar.position.set(0, surfaceAt(0, localZ), localZ);
    }
    if (time < lastSignalUpdate) lastSignalUpdate = -Infinity;
    if (time - lastSignalUpdate < SIGNAL_UPDATE_INTERVAL) return;
    lastSignalUpdate = time;
    const changedHeadMeshes = new Set();
    signalMeshes.forEach(({ headMesh, headIndices, lightColors, offset, group }) => {
      const phase = signalPhaseAt(group, time, offset);
      headIndices.forEach(({ name, instanceIndex }) => {
        const colors = lightColors[name];
        headMesh.setColorAt(instanceIndex, colors[name === phase ? 'on' : 'off']);
      });
      changedHeadMeshes.add(headMesh);
    });
    changedHeadMeshes.forEach((headMesh) => {
      if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;
    });
  };
  setActive(false, 'proxy');
  return {
    object3d: root,
    setActive,
    setWeather,
    setNightLighting,
    update,
    getPresentation() {
      return presentation;
    },
    buildingVolumes,
    stats: {
      district: blueprint.district,
      buildings: buildingVolumes.length,
      roads: roadNetwork.roads.length,
      intersections: roadNetwork.signalIntersections.length,
      signals: signalMeshes.length,
      trees: furniture.treeCount,
      streetlights: furniture.lightCount,
    },
  };
}

function trafficLinesForBlueprint(blueprint) {
  if (Array.isArray(blueprint.trafficRoadLines) && blueprint.trafficRoadLines.length >= 3) {
    return blueprint.trafficRoadLines;
  }
  const lines = blueprint.roadLines;
  // Dense ~48 m visual grids keep sidewalk/block readable, but the live
  // traffic graph samples seven arterials (edges included) so citywide merge
  // cost stays near the prior 7-line budget.
  if (!lines || lines.length <= 7) return lines;
  const last = lines.length - 1;
  const picks = new Set([0, last]);
  for (let step = 1; step <= 5; step += 1) {
    picks.add(Math.round((step / 6) * last));
  }
  return [...picks].sort((left, right) => left - right).map((index) => lines[index]);
}

function createExpansionRoadNetworkForSector(descriptor, blueprint, catalog) {
  const surfaceAt = makeSurfaceAt(descriptor, catalog);
  const roads = [];
  const laneData = [];
  const roadNames = [];
  const signalIntersections = [];
  const crossings = [];
  const spawnPoints = [];
  const lines = trafficLinesForBlueprint(blueprint);
  lines.forEach((line, index) => {
    const name = index === Math.floor(lines.length / 2) ? blueprint.roadName : `${blueprint.district} avenue ${index + 1}`;
    roadNames.push(name);
    roads.push({
      id: `${descriptor.key}:road:x:${index}`,
      start: new THREE.Vector3(descriptor.center.x + line, descriptor.elevation + surfaceAt(line, -192), descriptor.center.z - 192),
      end: new THREE.Vector3(descriptor.center.x + line, descriptor.elevation + surfaceAt(line, 192), descriptor.center.z + 192),
      lanes: 2,
      laneWidth: 2.62,
      speedLimit: blueprint.tone === 'financial' ? 20 : 25,
      name,
      district: blueprint.district,
    });
    laneData.push(
      { roadId: `${descriptor.key}:road:x:${index}`, offset: -2.62, direction: 'southbound', priority: 'through' },
      { roadId: `${descriptor.key}:road:x:${index}`, offset: 2.62, direction: 'northbound', priority: 'through' },
    );
  });
  lines.forEach((line, index) => {
    const name = index === Math.floor(lines.length / 2) ? blueprint.roadName : `${blueprint.district} street ${index + 1}`;
    roadNames.push(name);
    roads.push({
      id: `${descriptor.key}:road:z:${index}`,
      start: new THREE.Vector3(descriptor.center.x - 192, descriptor.elevation + surfaceAt(-192, line), descriptor.center.z + line),
      end: new THREE.Vector3(descriptor.center.x + 192, descriptor.elevation + surfaceAt(192, line), descriptor.center.z + line),
      lanes: 2,
      laneWidth: 2.62,
      speedLimit: blueprint.tone === 'north-beach' ? 20 : 25,
      name,
      district: blueprint.district,
    });
    laneData.push(
      { roadId: `${descriptor.key}:road:z:${index}`, offset: -2.62, direction: 'westbound', priority: 'through' },
      { roadId: `${descriptor.key}:road:z:${index}`, offset: 2.62, direction: 'eastbound', priority: 'through' },
    );
  });
  if (blueprint.diagonal) {
    const { start, end, width, name } = blueprint.diagonal;
    roads.push({
      id: `${descriptor.key}:road:diagonal`,
      start: new THREE.Vector3(descriptor.center.x + start[0], descriptor.elevation + surfaceAt(start[0], start[1]), descriptor.center.z + start[1]),
      end: new THREE.Vector3(descriptor.center.x + end[0], descriptor.elevation + surfaceAt(end[0], end[1]), descriptor.center.z + end[1]),
      lanes: 2,
      laneWidth: width / 4,
      speedLimit: 25,
      name,
      district: blueprint.district,
      diagonal: true,
    });
    laneData.push(
      { roadId: `${descriptor.key}:road:diagonal`, offset: -width * 0.18, direction: 'southwest', priority: 'arterial' },
      { roadId: `${descriptor.key}:road:diagonal`, offset: width * 0.18, direction: 'northeast', priority: 'arterial' },
    );
  }
  for (let xi = 0; xi < lines.length; xi += 1) {
    for (let zi = 0; zi < lines.length; zi += 1) {
      const x = lines[xi];
      const z = lines[zi];
      // Cadence is by block index so denser ~48 m grids do not force a signal
      // on every corner when signalEvery is 1 (which used to mean "always").
      const every = Math.max(1, blueprint.signalEvery || 2);
      const intersection = {
        id: `${descriptor.key}:junction:${x}:${z}`,
        x: descriptor.center.x + x,
        y: descriptor.elevation + surfaceAt(x, z),
        z: descriptor.center.z + z,
        district: blueprint.district,
        signalized: (xi + zi) % every === 0,
        priority: Math.abs(x) < 1 && Math.abs(z) < 1 ? 'arterial' : 'right-hand',
      };
      signalIntersections.push({ id: intersection.id, position: { x, z }, world: intersection });
      crossings.push({
        id: `${intersection.id}:crossing`,
        intersectionId: intersection.id,
        pedestrianSignal: intersection.signalized,
        width: ROAD_WIDTH - 0.3,
        curbRamps: true,
      });
    }
  }
  if (blueprint.diagonal) {
    const { start, end } = blueprint.diagonal;
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const seen = new Set();
    const addDiagonalJunction = (localX, localZ, source) => {
      const key = `${Math.round(localX * 100)}:${Math.round(localZ * 100)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const index = signalIntersections.length;
      const intersection = {
        id: `${descriptor.key}:junction:diagonal:${index}`,
        x: descriptor.center.x + localX,
        y: descriptor.elevation + surfaceAt(localX, localZ),
        z: descriptor.center.z + localZ,
        district: blueprint.district,
        signalized: index % (blueprint.signalEvery || 1) === 0,
        priority: 'arterial',
        diagonalConnector: true,
        source,
      };
      signalIntersections.push({
        id: intersection.id,
        position: { x: localX, z: localZ },
        world: intersection,
      });
      crossings.push({
        id: `${intersection.id}:crossing`,
        intersectionId: intersection.id,
        pedestrianSignal: intersection.signalized,
        width: Math.max(8, blueprint.diagonal.width - 0.3),
        curbRamps: true,
        diagonal: true,
        x: localX,
        z: localZ,
      });
    };
    if (Math.abs(dx) > 1e-6) {
      lines.forEach((line) => {
        const t = (line - start[0]) / dx;
        if (t > 0.015 && t < 0.985) addDiagonalJunction(line, start[1] + dz * t, `x:${line}`);
      });
    }
    if (Math.abs(dz) > 1e-6) {
      lines.forEach((line) => {
        const t = (line - start[1]) / dz;
        if (t > 0.015 && t < 0.985) addDiagonalJunction(start[0] + dx * t, line, `z:${line}`);
      });
    }
    addDiagonalJunction(start[0], start[1], 'diagonal-start');
    addDiagonalJunction(end[0], end[1], 'diagonal-end');
  }
  roads.forEach((road) => {
    const start = road.start;
    const end = road.end;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const direction = Math.abs(dx) >= Math.abs(dz)
      ? (dx >= 0 ? 'east' : 'west')
      : (dz >= 0 ? 'north' : 'south');
    spawnPoints.push({ id: `${road.id}:spawn`, roadId: road.id, x: start.x, y: start.y + 0.2, z: start.z, direction });
  });
  return {
    roads,
    intersections: signalIntersections.map((entry) => entry.world),
    signalIntersections,
    // Traffic only needs authored plans at live signals; unsignalized corners
    // stay in the intersection/crossing lists for graph connectivity.
    signalPlans: signalIntersections
      .filter((entry) => entry.world.signalized !== false)
      .map((entry) => ({
        id: entry.id,
        position: entry.world,
        cycleSeconds: SIGNAL_PERIOD,
        pedestrianLeadSeconds: 3.2,
        groups: SIGNAL_GROUPS,
        signalized: true,
      })),
    crossings,
    laneData,
    spawnPoints,
    roadNames: [...new Set(roadNames)],
    district: blueprint.district,
    sectorKey: descriptor.key,
  };
}

function createCoreEastConnector(catalog) {
  // Core road endpoints are at x=84; the authored city plate extends to x=98
  // for the curb apron, so the connector deliberately overlaps that apron.
  const startX = 84;
  const endX = 192;
  const z = 0;
  const startHeight = 0.022 * startX + 0.042 * z;
  const endHeight = catalog.getSurfaceHeight({ x: endX, z }) ?? 0;
  return {
    id: 'sf:core-east-connector',
    start: new THREE.Vector3(startX, startHeight, z),
    end: new THREE.Vector3(endX, endHeight, z),
    lanes: 2,
    laneWidth: 2.62,
    speedLimit: 25,
    name: 'Civic Center east connector',
    district: 'Civic Center / SoMa',
    connection: true,
  };
}

function createCoreEastConnectorVisual(catalog) {
  const root = new THREE.Group();
  root.name = 'Civic Center to SoMa east connector';
  const surfaceAt = (x, z) => {
    const terrain = catalog.getSurfaceHeight({ x, z });
    const coreGrade = 0.022 * x + 0.042 * z;
    const blend = THREE.MathUtils.clamp((x - 84) / (192 - 84), 0, 1);
    return Number.isFinite(terrain) ? THREE.MathUtils.lerp(coreGrade, terrain, blend) : coreGrade;
  };
  const roadPositions = [];
  const sidewalkPositions = [];
  const markingPositions = [];
  addStrip(
    roadPositions,
    null,
    [84, 0],
    [192, 0],
    ROAD_WIDTH,
    surfaceAt,
    SURFACE_OFFSET,
    new THREE.Color(0x3b4446),
    16,
  );
  addStrip(
    sidewalkPositions,
    null,
    [84, -ROAD_WIDTH * 0.5 - SIDEWALK_WIDTH],
    [192, -ROAD_WIDTH * 0.5 - SIDEWALK_WIDTH],
    SIDEWALK_WIDTH,
    surfaceAt,
    SURFACE_OFFSET + 0.015,
    new THREE.Color(0xb8b2a8),
    16,
  );
  addStrip(
    sidewalkPositions,
    null,
    [84, ROAD_WIDTH * 0.5 + SIDEWALK_WIDTH],
    [192, ROAD_WIDTH * 0.5 + SIDEWALK_WIDTH],
    SIDEWALK_WIDTH,
    surfaceAt,
    SURFACE_OFFSET + 0.015,
    new THREE.Color(0xb8b2a8),
    16,
  );
  addStrip(
    markingPositions,
    null,
    [84, 0],
    [192, 0],
    0.16,
    surfaceAt,
    ROAD_MARKING_OFFSET,
    new THREE.Color(0xf1dfb5),
    8,
  );
  root.add(
    createSurfaceMesh('Core east connector asphalt', roadPositions, null, new THREE.MeshStandardMaterial({ color: 0x3b4446, roughness: 0.94 })),
    createSurfaceMesh('Core east connector sidewalks', sidewalkPositions, null, new THREE.MeshStandardMaterial({ color: 0xb8b2a8, roughness: 0.92 })),
    createSurfaceMesh('Core east connector center marking', markingPositions, null, new THREE.MeshStandardMaterial({ color: 0xf1dfb5, roughness: 0.8 })),
  );
  return root;
}

function createGridSpineConnections(catalog) {
  const chains = [
    // Downtown E-W: Civic 1:0 -> Embarcadero 3:0 -> FiDi 4:0
    [[576, 0], [960, 0], [1152, 0], [1344, 0]],
    // FiDi north toward North Beach
    [[1536, 192], [1536, 576], [1536, 960], [1536, 1344]],
    // North Beach west through Russian Hill 1:4 to Pac Heights 0:4
    [[1344, 1536], [960, 1536], [576, 1536], [384, 1536], [192, 1536]],
    // Pac Heights west ring + Presidio approach
    [[-192, 1536], [-576, 1536], [-960, 1536], [-1344, 1536], [-1536, 1536], [-1536, 1152], [-1536, 768], [-1536, 576]],
    // Presidio south toward Mission band
    [[-1536, 192], [-1536, -192], [-1536, -576], [-1536, -768], [-1344, -768], [-960, -768]],
    // Mission east band and Mission Bay approach
    [[-960, -768], [-576, -768], [-192, -768], [192, -768], [576, -768], [960, -768], [1344, -768], [1536, -768], [1536, -1152], [1536, -1344]],
    // Outer south waterfront spine
    [[1344, -1536], [960, -1536], [576, -1536], [192, -1536], [-192, -1536], [-576, -1536], [-960, -1536], [-1344, -1536], [-1728, -1536]],
    // Pac Heights 0:4 north into Marina 0:5 (shared edge z=1728)
    [[-8, 1536], [-8, 1728], [0, 1728], [0, 1920], [0, 2016]],
    // Russian Hill 1:4 south/east toward Nob Hill 2:3 and Chinatown 3:3 ridge
    [[384, 1536], [384, 1344], [576, 1344], [768, 1344], [960, 1344], [1152, 1344]],
    // Nob Hill / Chinatown E-W spine at ridge centers
    [[576, 1152], [768, 1152], [960, 1152], [1152, 1152], [1344, 1152]],
    // Chinatown / Embarcadero N-S downtown stack (3:3 <-> 3:0 via 3:1/3:2 fill)
    [[1152, 1344], [1152, 1152], [1152, 960], [1152, 576], [1152, 192], [1152, 0]],
    // Chinatown east approach toward North Beach / FiDi north stack
    [[1152, 1344], [1344, 1344], [1536, 1344]],
    // SoMa Design 2:-1 from Civic east edge + downtown south spine
    [[576, 0], [576, -192], [576, -384], [768, -384], [960, -384]],
    [[576, -384], [576, -576], [768, -576], [960, -576], [960, -768]],
    // Western Addition / Fillmore −1:1 from Civic west Market approach
    [[384, 0], [192, 0], [0, 0], [-192, 0], [-384, 0], [-384, 192], [-384, 384]],
    // Fillmore north to Pac Heights / Geary corridor
    [[0, 1536], [0, 1152], [0, 768], [0, 384], [-192, 384], [-384, 384]],
    // Haight −3:−1 north of Mission band toward park edge
    [[-1152, -768], [-1152, -576], [-1152, -384], [-1152, -192], [-1152, 0]],
    // Laurel Heights −4:2 east spur from Presidio south ring
    [[-1536, 768], [-1344, 768], [-1152, 768], [-960, 768], [-768, 768]],
  ];
  const roads = [];
  const intersections = [];
  const crossings = [];
  const signalPlans = [];
  const laneData = [];
  const spawnPoints = [];
  const intersectionByKey = new Map();
  const sample = (x, z) => catalog.getSurfaceHeight({ x, z }) ?? 0;
  const ensureIntersection = (x, z) => {
    const key = `${x}:${z}`;
    if (intersectionByKey.has(key)) return intersectionByKey.get(key);
    const id = `sf:grid-spine:junction:${intersectionByKey.size}`;
    const world = {
      id,
      x,
      y: sample(x, z),
      z,
      district: 'San Francisco grid spine',
      signalized: false,
      priority: 'right-hand',
      connector: true,
    };
    const entry = { id, world, position: { x, z } };
    intersectionByKey.set(key, entry);
    intersections.push(world);
    crossings.push({
      id: `${id}:crossing`,
      intersectionId: id,
      pedestrianSignal: false,
      width: ROAD_WIDTH - 0.3,
      curbRamps: true,
      connector: true,
      x,
      z,
    });
    signalPlans.push({
      id,
      position: world,
      cycleSeconds: SIGNAL_PERIOD,
      pedestrianLeadSeconds: 0,
      signalized: false,
    });
    return entry;
  };
  chains.forEach((chain, chainIndex) => {
    for (let index = 1; index < chain.length; index += 1) {
      const startPoint = chain[index - 1];
      const endPoint = chain[index];
      const start = new THREE.Vector3(startPoint[0], sample(startPoint[0], startPoint[1]), startPoint[1]);
      const end = new THREE.Vector3(endPoint[0], sample(endPoint[0], endPoint[1]), endPoint[1]);
      const id = `sf:grid-spine:road:${chainIndex}:${index - 1}`;
      roads.push({
        id,
        start,
        end,
        lanes: 2,
        laneWidth: 2.62,
        speedLimit: 25,
        name: 'San Francisco streamed grid spine',
        district: 'San Francisco grid spine',
        connection: true,
      });
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const direction = Math.abs(dx) >= Math.abs(dz)
        ? (dx >= 0 ? 'east' : 'west')
        : (dz >= 0 ? 'north' : 'south');
      laneData.push(
        {
          roadId: id,
          offset: -2.62,
          direction: direction === 'east' ? 'westbound' : direction === 'west' ? 'eastbound' : 'southbound',
          priority: 'connector',
        },
        {
          roadId: id,
          offset: 2.62,
          direction: direction === 'east' ? 'eastbound' : direction === 'west' ? 'westbound' : 'northbound',
          priority: 'connector',
        },
      );
      spawnPoints.push({ id: `${id}:spawn`, roadId: id, x: start.x, y: start.y + 0.2, z: start.z, direction });
      ensureIntersection(start.x, start.z);
      ensureIntersection(end.x, end.z);
    }
  });
  return { roads, intersections, crossings, signalPlans, laneData, spawnPoints };
}

export function createSanFranciscoExpansionRoadNetwork({ catalog } = {}) {
  if (!catalog) throw new TypeError('createSanFranciscoExpansionRoadNetwork requires a sector catalog.');
  const networks = EXPANSION_SECTORS.flatMap((blueprint) => {
    const coordinates = parseKey(blueprint.key);
    const descriptor = catalog.get(coordinates.x, coordinates.z);
    return descriptor ? [createExpansionRoadNetworkForSector(descriptor, blueprint, catalog)] : [];
  });
  const connections = [createCoreEastConnector(catalog)];
  const spine = createGridSpineConnections(catalog);
  connections.push(...spine.roads);
  const coreConnection = connections[0];
  const connectionLaneData = [coreConnection].flatMap((road) => [
    { roadId: road.id, offset: -road.laneWidth, direction: 'westbound', priority: 'connector' },
    { roadId: road.id, offset: road.laneWidth, direction: 'eastbound', priority: 'connector' },
  ]);
  const connectionSpawnPoints = [coreConnection].map((road) => ({
    id: `${road.id}:spawn`,
    roadId: road.id,
    x: road.start.x,
    y: road.start.y + 0.2,
    z: road.start.z,
    direction: 'east',
  }));
  return {
    roads: [...connections, ...networks.flatMap((network) => network.roads)],
    intersections: [...spine.intersections, ...networks.flatMap((network) => network.intersections)],
    signalPlans: [...spine.signalPlans, ...networks.flatMap((network) => network.signalPlans)],
    crossings: [...spine.crossings, ...networks.flatMap((network) => network.crossings)],
    laneData: [...connectionLaneData, ...spine.laneData, ...networks.flatMap((network) => network.laneData)],
    spawnPoints: [...connectionSpawnPoints, ...spine.spawnPoints, ...networks.flatMap((network) => network.spawnPoints)],
    roadNames: [...new Set([
      ...connections.map((connection) => connection.name),
      ...spine.roads.map((road) => road.name),
      ...networks.flatMap((network) => network.roadNames),
    ])],
    networks,
    connections,
  };
}

export function createSanFranciscoExpansion({
  streaming,
  catalog = streaming?.catalog,
  scene = null,
} = {}) {
  if (!streaming || typeof streaming.registerSectorOverlay !== 'function') {
    throw new TypeError('createSanFranciscoExpansion requires a streaming instance with overlay support.');
  }
  if (!catalog) throw new TypeError('createSanFranciscoExpansion requires a sector catalog.');
  const shared = createSharedResources();
  const cache = new Map();
  const roadNetwork = createSanFranciscoExpansionRoadNetwork({ catalog });
  const registrations = [];
  const object3d = scene ? createCoreEastConnectorVisual(catalog) : null;
  if (object3d) scene.add(object3d);

  const ensureRuntime = (blueprint) => {
    let runtime = cache.get(blueprint.key);
    if (!runtime) {
      const coordinates = parseKey(blueprint.key);
      const descriptor = catalog.get(coordinates.x, coordinates.z);
      if (!descriptor) return null;
      runtime = createExpansionOverlay({ descriptor, blueprint, catalog, shared });
      cache.set(blueprint.key, runtime);
    }
    return runtime;
  };

  EXPANSION_SECTORS.forEach((blueprint) => {
    const coordinates = parseKey(blueprint.key);
    const descriptor = catalog.get(coordinates.x, coordinates.z);
    if (!descriptor) return;
    streaming.registerSectorOverlay(blueprint.key, ({ quality }) => {
      const runtime = ensureRuntime(blueprint);
      if (!runtime) return null;
      runtime.setActive(true, quality);
      return runtime;
    });
    registrations.push(blueprint.key);
  });

  const prewarmRenderResources = (renderer, camera) => {
    if (!scene || !renderer || !camera) return { available: false };
    // Civic/SoMa is the first authored handoff from the protected core. Its
    // signature overlay is already required at runtime; creating and drawing
    // it while the boot card is visible moves the one-time buffer upload out
    // of traversal without increasing the eventual authored-overlay cache.
    const blueprint = EXPANSION_BY_KEY.get('1:0');
    const descriptor = blueprint
      ? catalog.get(parseKey(blueprint.key).x, parseKey(blueprint.key).z)
      : null;
    const runtime = blueprint ? ensureRuntime(blueprint) : null;
    if (!runtime?.object3d || !descriptor) return { available: false };
    const root = runtime.object3d;
    if (!root.parent) scene.add(root);
    const previousFrustumCulling = [];
    root.traverse((object) => {
      previousFrustumCulling.push({ object, frustumCulled: object.frustumCulled });
      object.frustumCulled = false;
    });
    const previousPosition = root.position.clone();
    root.position.set(descriptor.center.x, descriptor.elevation, descriptor.center.z);
    runtime.setActive(true, 'detail');
    scene.updateMatrixWorld(true);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    runtime.setActive(false, 'proxy');
    root.position.copy(previousPosition);
    previousFrustumCulling.forEach(({ object, frustumCulled }) => {
      object.frustumCulled = frustumCulled;
    });
    return { available: true, sectorKey: blueprint.key };
  };

  const setNightLighting = (amount = 0) => {
    const night = THREE.MathUtils.clamp(Number(amount) || 0, 0, 1);
    shared.materials.window.emissiveIntensity = THREE.MathUtils.lerp(0.22, 1.85, night);
    shared.materials.entryHeader.emissiveIntensity = THREE.MathUtils.lerp(0.16, 1.1, night);
    if (shared.materials.shorelineReflection) {
      shared.materials.shorelineReflection.opacity = THREE.MathUtils.lerp(0.74, 0.96, night);
      shared.materials.shorelineReflection.color.setRGB(
        THREE.MathUtils.lerp(1.0, 0.94, night),
        THREE.MathUtils.lerp(1.0, 0.98, night),
        THREE.MathUtils.lerp(1.0, 1.08, night),
      );
    }
    if (shared.materials.shorelineWaterField) {
      shared.materials.shorelineWaterField.color.setRGB(
        THREE.MathUtils.lerp(1.0, 1.16, night),
        THREE.MathUtils.lerp(1.0, 1.28, night),
        THREE.MathUtils.lerp(1.0, 1.46, night),
      );
    }
    // Match the overlay treatment above so the baked grid stays subdued
    // while the bounded warm/cool panes remain the only bright occupancy cue.
    const bakedGridBrightness = [0.16, 0.075, 0.2, 0.1];
    shared.facadePhotoMaterials.forEach((family, familyIndex) => {
      family.forEach((material, bayIndex) => {
        const base = shared.facadePhotoBaseColors[familyIndex][bayIndex];
        const nightBrightness = bakedGridBrightness[bayIndex];
        material.color.copy(base).multiplyScalar(THREE.MathUtils.lerp(1, nightBrightness, night));
      });
    });
    shared.materials.facadeNight.forEach((material, index) => {
      const occupancy = [0.52, 0.24, 0.7, 0.36][index];
      material.opacity = night * (0.08 + occupancy * 0.16);
      material.emissiveIntensity = night * (0.55 + occupancy * 0.45);
    });
    shared.materials.landmarkNight.forEach((material, index) => {
      const occupancy = [0.52, 0.24, 0.7, 0.36][index];
      material.opacity = night * (0.62 + occupancy * 0.28);
      material.emissiveIntensity = night * (2.0 + occupancy * 1.1);
    });
    cache.forEach((runtime) => runtime.setNightLighting?.(night));
  };

  return {
    object3d,
    prewarmRenderResources,
    roadNetwork,
    setNightLighting,
    registeredSectorKeys: Object.freeze([...registrations]),
    getSectorBlueprint(key) {
      return EXPANSION_BY_KEY.get(key) || null;
    },
    getSectorRoadNetwork(key) {
      return roadNetwork.networks.find((network) => network.sectorKey === key) || null;
    },
    getAuthoredBuildingVolumes(key) {
      return cache.get(key)?.buildingVolumes || [];
    },
    getStats() {
      const sectorStats = [...cache.entries()].map(([key, runtime]) => ({ key, ...runtime.stats }));
      return {
        authoredSectors: registrations.length,
        cachedSectors: cache.size,
        activeAuthoredSectors: sectorStats.filter((entry) => runtimeIsVisible(cache.get(entry.key))).length,
        authoredBuildings: sectorStats.reduce((sum, entry) => sum + entry.buildings, 0),
        authoredRoads: roadNetwork.roads.length,
        signalizedIntersections: roadNetwork.signalPlans.filter((plan) => plan.signalized !== false).length,
        signalPlanCount: roadNetwork.signalPlans.length,
        laneRecords: roadNetwork.laneData.length,
        sectors: sectorStats,
      };
    },
  };
}

function runtimeIsVisible(runtime) {
  return Boolean(runtime?.object3d?.visible);
}

export { EXPANSION_SECTORS };
