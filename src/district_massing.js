import * as THREE from 'three';

/**
 * District-aware procedural building massing for San Francisco streaming sectors.
 *
 * Each district profile encodes local architectural character: height ranges,
 * material palettes, lot fill ratios, geometry styles, and street spacing.
 * The generator is fully deterministic — given the same sector seed, it produces
 * the same placement, scale, and style assignment every time.
 */

// ── Simple seeded RNG (LCG) ──────────────────────────────────────────────
function mulberry32(seed) {
  let value = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return ((value >>> 0) / 4294967296);
  };
}

// ── Geometry variants ─────────────────────────────────────────────────────
// Each variant is a unit-size geometry (1×1×1) suitable for instanced rendering.
// The y-origin is at the bottom so scale.y directly controls building height.

function createBoxGeometry() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  return geo;
}

function createSetbackGeometry() {
  // Podium (bottom 35%) + narrower tower (top 65%)
  const geo = new THREE.BufferGeometry();
  const podiumH = 0.35;
  const towerH = 0.65;

  const positions = [];
  const indices = [];
  const pw = 0.5, pd = 0.5;
  const tw = 0.42, td = 0.42;
  const towerBaseY = podiumH;

  function addBoxFace(cx, cz, hw, hd, baseY, topY) {
    const i = positions.length / 3;
    positions.push(
      cx - hw, baseY, cz - hd, cx + hw, baseY, cz - hd,
      cx + hw, topY, cz - hd, cx - hw, topY, cz - hd,
      cx - hw, baseY, cz + hd, cx + hw, baseY, cz + hd,
      cx + hw, topY, cz + hd, cx - hw, topY, cz + hd,
    );
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    indices.push(i + 5, i + 4, i + 7, i + 5, i + 7, i + 6);
    indices.push(i + 4, i, i + 3, i + 4, i + 3, i + 7);
    indices.push(i + 1, i + 5, i + 6, i + 1, i + 6, i + 2);
    indices.push(i + 3, i + 2, i + 6, i + 3, i + 6, i + 7);
    indices.push(i + 4, i + 5, i + 1, i + 4, i + 1, i);
  }

  addBoxFace(0, 0, pw, pd, 0, podiumH);
  addBoxFace(0, 0, tw, td, towerBaseY, 1.0);

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createTaperedGeometry() {
  const geo = new THREE.BufferGeometry();
  const baseW = 0.5, baseD = 0.5;
  const topW = 0.38, topD = 0.38;

  const positions = new Float32Array([
    -baseW, 0, -baseD,  baseW, 0, -baseD,  baseW, 0, baseD,  -baseW, 0, baseD,
    -topW, 1, -topD,  topW, 1, -topD,  topW, 1, topD,  -topW, 1, topD,
  ]);

  const indices = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ];

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createRowhouseGeometry() {
  // One streamed slot represents a small attached-house run rather than one
  // implausibly wide Victorian. Three independently capped modules, projecting
  // bays, and party-wall fins establish the narrow San Francisco frontage
  // rhythm while retaining a single instanced draw call.
  const geo = new THREE.BufferGeometry();
  const positions = [];
  const indices = [];

  function addBox(minX, maxX, minY, maxY, minZ, maxZ) {
    const i = positions.length / 3;
    positions.push(
      minX, minY, minZ, maxX, minY, minZ,
      maxX, maxY, minZ, minX, maxY, minZ,
      minX, minY, maxZ, maxX, minY, maxZ,
      maxX, maxY, maxZ, minX, maxY, maxZ,
    );
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    indices.push(i + 5, i + 4, i + 7, i + 5, i + 7, i + 6);
    indices.push(i + 4, i, i + 3, i + 4, i + 3, i + 7);
    indices.push(i + 1, i + 5, i + 6, i + 1, i + 6, i + 2);
    indices.push(i + 3, i + 2, i + 6, i + 3, i + 6, i + 7);
    indices.push(i + 4, i + 5, i + 1, i + 4, i + 1, i);
  }

  addBox(-0.5, 0.5, 0, 0.86, -0.44, 0.5);
  [
    { center: -0.34, width: 0.28, cap: 0.94, bayTop: 0.77 },
    { center: 0, width: 0.3, cap: 0.99, bayTop: 0.81 },
    { center: 0.34, width: 0.28, cap: 0.92, bayTop: 0.75 },
  ].forEach(({ center, width, cap, bayTop }) => {
    const halfWidth = width * 0.5;
    addBox(center - halfWidth, center + halfWidth, 0.15, bayTop, -0.63, -0.44);
    addBox(
      center - halfWidth - 0.025,
      center + halfWidth + 0.025,
      bayTop,
      bayTop + 0.055,
      -0.655,
      -0.415,
    );
    addBox(
      center - width * 0.54,
      center + width * 0.54,
      0.86,
      cap,
      -0.49,
      0.53,
    );
  });
  for (const partyWallX of [-0.17, 0.17]) {
    addBox(partyWallX - 0.018, partyWallX + 0.018, 0.05, 0.91, -0.54, -0.4);
  }

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ── Shared geometry pools (created once) ──────────────────────────────────
let _sharedGeometries = null;

export function getSharedGeometryPools() {
  if (_sharedGeometries) return _sharedGeometries;
  _sharedGeometries = {
    box: createBoxGeometry(),
    setback: createSetbackGeometry(),
    tapered: createTaperedGeometry(),
    rowhouse: createRowhouseGeometry(),
  };
  return _sharedGeometries;
}

// ── Material palettes ─────────────────────────────────────────────────────

const PALETTES = {
  'glass-tower': {
    colors: [0x3e5c63, 0x4a6b73, 0x355158],
    roughness: [0.22, 0.30],
    metalness: [0.28, 0.42],
  },
  'limestone-tower': {
    colors: [0xcac0aa, 0xdbd3c0, 0xb8ad99],
    roughness: [0.64, 0.76],
    metalness: [0.04, 0.10],
  },
  'steel-tower': {
    colors: [0x4a5560, 0x5a6570, 0x3d4750],
    roughness: [0.38, 0.52],
    metalness: [0.55, 0.72],
  },
  'masonry-warm': {
    colors: [0x9f6658, 0xb78d69, 0xc49a75],
    roughness: [0.78, 0.88],
    metalness: [0.01, 0.04],
  },
  'masonry-cool': {
    colors: [0x75868a, 0x8a9b9f, 0x65757a],
    roughness: [0.76, 0.86],
    metalness: [0.02, 0.06],
  },
  'stucco': {
    colors: [0xd0b48a, 0xc8ab80, 0xddd2bd],
    roughness: [0.78, 0.88],
    metalness: [0.01, 0.03],
  },
  'victorian': {
    // Painted-lady accents stay warm and muted at distance; the previous
    // plum palette turned unfinished proxy sides into giant pink blocks.
    colors: [0x8b7267, 0xb3907c, 0x6e696e],
    roughness: [0.74, 0.84],
    metalness: [0.02, 0.05],
  },
  'brick-industrial': {
    colors: [0x8c5c4a, 0x7a5042, 0x9a6c58],
    roughness: [0.84, 0.94],
    metalness: [0.02, 0.06],
  },
  'modern-white': {
    colors: [0xd8d5cc, 0xe2dfd8, 0xccc8bf],
    roughness: [0.58, 0.70],
    metalness: [0.06, 0.14],
  },
  'concrete-mid': {
    colors: [0xb6afa4, 0xc4bdb2, 0xa8a196],
    roughness: [0.82, 0.92],
    metalness: [0.02, 0.06],
  },
};

// ── District profiles ─────────────────────────────────────────────────────

const DISTRICT_PROFILES = {
  'Financial District': {
    heightRange: [18, 160],
    minHeight: 12,
    maxHeight: 220,
    fillRatio: 0.88,
    streetGap: 12,
    palettes: ['glass-tower', 'limestone-tower', 'steel-tower'],
    geometryStyles: { setback: 0.35, tapered: 0.45, box: 0.20 },
    floorHeight: 3.8,
    name: 'Financial District',
  },
  SoMa: {
    heightRange: [12, 80],
    minHeight: 6,
    maxHeight: 110,
    fillRatio: 0.78,
    streetGap: 16,
    palettes: ['glass-tower', 'brick-industrial', 'masonry-cool', 'steel-tower'],
    geometryStyles: { box: 0.40, setback: 0.35, tapered: 0.25 },
    floorHeight: 3.5,
    name: 'SoMa',
  },
  'North Beach': {
    heightRange: [6, 22],
    minHeight: 4,
    maxHeight: 32,
    fillRatio: 0.92,
    streetGap: 9,
    palettes: ['stucco', 'masonry-warm', 'victorian'],
    geometryStyles: { box: 0.45, rowhouse: 0.55 },
    floorHeight: 3.1,
    name: 'North Beach',
  },
  'Pacific Heights': {
    heightRange: [8, 30],
    minHeight: 5,
    maxHeight: 44,
    fillRatio: 0.82,
    streetGap: 12,
    palettes: ['stucco', 'masonry-warm', 'victorian', 'modern-white'],
    geometryStyles: { box: 0.35, setback: 0.25, rowhouse: 0.40 },
    floorHeight: 3.3,
    name: 'Pacific Heights',
  },
  'Marina / Fisherman’s Wharf': {
    heightRange: [6, 22],
    minHeight: 4,
    maxHeight: 30,
    fillRatio: 0.72,
    streetGap: 12,
    palettes: ['stucco', 'modern-white', 'masonry-cool'],
    geometryStyles: { box: 0.80, rowhouse: 0.20 },
    floorHeight: 3.0,
    name: 'Marina',
  },
  Sunset: {
    heightRange: [5, 14],
    minHeight: 3,
    maxHeight: 18,
    fillRatio: 0.85,
    streetGap: 8,
    palettes: ['stucco', 'concrete-mid'],
    geometryStyles: { box: 0.85, rowhouse: 0.15 },
    floorHeight: 2.8,
    name: 'Sunset',
  },
  'Outer Sunset': {
    heightRange: [3, 8],
    minHeight: 3,
    maxHeight: 12,
    fillRatio: 0.72,
    streetGap: 8,
    palettes: ['stucco', 'concrete-mid'],
    geometryStyles: { box: 0.62, rowhouse: 0.38 },
    floorHeight: 2.7,
    name: 'Outer Sunset',
  },
  Richmond: {
    heightRange: [5, 16],
    minHeight: 3,
    maxHeight: 20,
    fillRatio: 0.84,
    streetGap: 8,
    palettes: ['stucco', 'masonry-warm', 'concrete-mid'],
    geometryStyles: { box: 0.82, rowhouse: 0.18 },
    floorHeight: 2.8,
    name: 'Richmond',
  },
  Mission: {
    heightRange: [5, 22],
    minHeight: 5,
    maxHeight: 30,
    fillRatio: 0.86,
    streetGap: 10,
    palettes: ['victorian', 'masonry-warm', 'brick-industrial'],
    geometryStyles: { box: 0.55, setback: 0.15, rowhouse: 0.30 },
    floorHeight: 3.1,
    name: 'Mission',
  },
  'Castro / Noe Valley': {
    heightRange: [6, 20],
    minHeight: 4,
    maxHeight: 26,
    fillRatio: 0.82,
    streetGap: 10,
    palettes: ['victorian', 'masonry-warm', 'stucco'],
    geometryStyles: { box: 0.45, rowhouse: 0.55 },
    floorHeight: 3.0,
    name: 'Castro / Noe Valley',
  },
  'Civic Center': {
    heightRange: [14, 50],
    minHeight: 8,
    maxHeight: 65,
    fillRatio: 0.76,
    streetGap: 14,
    // Beaux-Arts institutions share these blocks with older Tenderloin
    // masonry and brick. Carrying those neighboring fabric types into the
    // palette prevents an entire streamed avenue becoming one white facade.
    palettes: [
      'limestone-tower',
      'masonry-cool',
      'modern-white',
      'masonry-warm',
      'brick-industrial',
    ],
    geometryStyles: { box: 0.28, setback: 0.38, tapered: 0.18, rowhouse: 0.16 },
    floorHeight: 3.6,
    name: 'Civic Center',
  },
  Presidio: {
    heightRange: [5, 16],
    minHeight: 3,
    maxHeight: 22,
    fillRatio: 0.52,
    streetGap: 18,
    palettes: ['stucco', 'modern-white', 'masonry-cool'],
    geometryStyles: { box: 0.22, rowhouse: 0.52, setback: 0.26 },
    floorHeight: 2.9,
    name: 'Presidio',
  },
  'Presidio Heights': {
    heightRange: [8, 28],
    minHeight: 5,
    maxHeight: 35,
    fillRatio: 0.60,
    streetGap: 16,
    palettes: ['stucco', 'masonry-warm', 'modern-white'],
    geometryStyles: { box: 0.65, rowhouse: 0.20, setback: 0.15 },
    floorHeight: 3.2,
    name: 'Presidio Heights',
  },
  Bayview: {
    heightRange: [5, 20],
    minHeight: 3,
    maxHeight: 28,
    fillRatio: 0.70,
    streetGap: 14,
    palettes: ['brick-industrial', 'concrete-mid', 'stucco'],
    geometryStyles: { box: 0.85, setback: 0.15 },
    floorHeight: 3.0,
    name: 'Bayview',
  },
  Excelsior: {
    heightRange: [5, 16],
    minHeight: 3,
    maxHeight: 22,
    fillRatio: 0.82,
    streetGap: 8,
    palettes: ['stucco', 'concrete-mid', 'masonry-warm'],
    geometryStyles: { box: 0.82, rowhouse: 0.18 },
    floorHeight: 2.8,
    name: 'Excelsior',
  },
  'Mission Bay': {
    heightRange: [10, 55],
    minHeight: 6,
    maxHeight: 75,
    fillRatio: 0.65,
    streetGap: 16,
    palettes: ['glass-tower', 'modern-white', 'steel-tower'],
    geometryStyles: { box: 0.30, setback: 0.40, tapered: 0.30 },
    floorHeight: 3.5,
    name: 'Mission Bay',
  },
  'Golden Gate': {
    heightRange: [4, 14],
    minHeight: 2,
    maxHeight: 20,
    fillRatio: 0.25,
    streetGap: 24,
    palettes: ['stucco', 'modern-white'],
    geometryStyles: { box: 0.95, rowhouse: 0.05 },
    floorHeight: 2.9,
    name: 'Golden Gate',
  },
  Chinatown: {
    heightRange: [8, 24],
    minHeight: 6,
    maxHeight: 32,
    fillRatio: 0.90,
    streetGap: 8,
    palettes: ['masonry-warm', 'brick-industrial', 'victorian'],
    geometryStyles: { box: 0.40, rowhouse: 0.50, setback: 0.10 },
    floorHeight: 3.0,
    name: 'Chinatown',
  },
  'Nob Hill': {
    heightRange: [12, 40],
    minHeight: 8,
    maxHeight: 52,
    fillRatio: 0.78,
    streetGap: 14,
    palettes: ['limestone-tower', 'masonry-warm', 'stucco', 'modern-white'],
    geometryStyles: { setback: 0.35, box: 0.35, rowhouse: 0.20, tapered: 0.10 },
    floorHeight: 3.4,
    name: 'Nob Hill',
  },
  'Russian Hill': {
    heightRange: [8, 24],
    minHeight: 5,
    maxHeight: 32,
    fillRatio: 0.84,
    streetGap: 10,
    palettes: ['stucco', 'victorian', 'modern-white', 'masonry-warm'],
    geometryStyles: { box: 0.40, rowhouse: 0.50, setback: 0.10 },
    floorHeight: 3.1,
    name: 'Russian Hill',
  },
  Marina: {
    heightRange: [6, 18],
    minHeight: 4,
    maxHeight: 24,
    fillRatio: 0.72,
    streetGap: 12,
    palettes: ['modern-white', 'stucco', 'masonry-cool'],
    geometryStyles: { box: 0.70, rowhouse: 0.30 },
    floorHeight: 3.0,
    name: 'Marina',
  },
  Embarcadero: {
    heightRange: [20, 120],
    minHeight: 12,
    maxHeight: 180,
    fillRatio: 0.85,
    streetGap: 14,
    palettes: ['glass-tower', 'steel-tower', 'limestone-tower'],
    geometryStyles: { tapered: 0.40, setback: 0.35, box: 0.25 },
    floorHeight: 3.7,
    name: 'Embarcadero',
  },
  'Twin Peaks': {
    heightRange: [4, 14],
    minHeight: 2,
    maxHeight: 18,
    fillRatio: 0.28,
    streetGap: 22,
    palettes: ['stucco', 'modern-white', 'masonry-warm'],
    geometryStyles: { box: 0.7, rowhouse: 0.2, setback: 0.1 },
    floorHeight: 2.9,
    name: 'Twin Peaks',
  },
};

// Hyde's authored encounter uses one measured centerline datum.  The profile
// below compensates for the catalog's analytic cross-slope; callers that need
// the observable street grade should use HYDE_MEASURED_GRADE instead of the
// compensated profile value.
export const HYDE_MEASURED_GRADE = 0.07235;
export const HYDE_COMPENSATED_PROFILE_GRADE = 0.08163575;

// The authored expansion blueprint is intentionally reduced to the four
// geometry families the pooled renderer already supports. This keeps the
// district plan on the live streaming path without adding a second building
// renderer or duplicating every facade mesh in the authored overlay.
const AUTHORED_MASSING_BY_SECTOR = Object.freeze({
  '1:0': Object.freeze({
    source: 'authored-civic-center-plan',
    styleSequence: Object.freeze(['rowhouse', 'setback', 'box', 'setback', 'rowhouse', 'tapered']),
    paletteSequence: Object.freeze(['limestone-tower', 'masonry-cool', 'masonry-warm', 'brick-industrial']),
    fillRatio: 0.76,
    streetGap: 14,
    landmarkClearance: Object.freeze({ x: -108, z: 60, radius: 38 }),
  }),
  '4:0': Object.freeze({
    source: 'authored-financial-plan',
    styleSequence: Object.freeze(['tapered', 'setback', 'tapered', 'setback', 'tapered', 'setback']),
    paletteSequence: Object.freeze(['glass-tower', 'steel-tower', 'limestone-tower']),
    fillRatio: 0.88,
    streetGap: 12,
    heightRange: Object.freeze([24, 120]),
    minHeight: 16,
    maxHeight: 180,
    landmarkClearance: Object.freeze({ x: 64, z: 92, radius: 46 }),
  }),
  '4:4': Object.freeze({
    source: 'authored-north-beach-plan',
    styleSequence: Object.freeze(['rowhouse', 'rowhouse', 'rowhouse', 'box', 'rowhouse', 'rowhouse']),
    paletteSequence: Object.freeze(['stucco', 'masonry-warm', 'victorian']),
    heightRange: Object.freeze([5, 18]),
    minHeight: 5,
    maxHeight: 24,
    fillRatio: 0.92,
    streetGap: 9,
    grade: 0.075,
    landmarkClearance: Object.freeze({ x: 58, z: 74, radius: 44 }),
  }),
  '0:4': Object.freeze({
    source: 'authored-pacific-heights-plan',
    styleSequence: Object.freeze(['rowhouse', 'setback', 'rowhouse', 'rowhouse', 'setback', 'rowhouse']),
    paletteSequence: Object.freeze(['victorian', 'masonry-warm', 'stucco', 'modern-white']),
    heightRange: Object.freeze([7, 24]),
    minHeight: 6,
    maxHeight: 32,
    fillRatio: 0.82,
    streetGap: 12,
    grade: 0.11,
    landmarkClearance: Object.freeze({ x: -28, z: 72, radius: 42 }),
  }),
  '-4:1': Object.freeze({
    source: 'authored-presidio-plan',
    styleSequence: Object.freeze(['rowhouse', 'rowhouse', 'rowhouse', 'box', 'rowhouse', 'rowhouse']),
    paletteSequence: Object.freeze(['stucco', 'modern-white', 'masonry-cool']),
    heightRange: Object.freeze([4, 14]),
    minHeight: 3,
    maxHeight: 20,
    // The Presidio is a park-and-barracks edge, not a continuous urban wall.
    // The larger authored clearance keeps the gate and meadow legible while
    // this moderate fill preserves the existing detail-massing invariant.
    fillRatio: 0.52,
    streetGap: 18,
    grade: 0.045,
    landmarkClearance: Object.freeze({ x: -20, z: 100, radius: 56 }),
  }),
  '-3:-2': Object.freeze({
    source: 'authored-mission-plan',
    styleSequence: Object.freeze(['box', 'rowhouse', 'box', 'rowhouse', 'rowhouse', 'box']),
    paletteSequence: Object.freeze(['victorian', 'masonry-warm', 'brick-industrial']),
    heightRange: Object.freeze([5, 18]),
    minHeight: 5,
    maxHeight: 26,
    fillRatio: 0.70,
    grade: 0.038,
    landmarkClearance: Object.freeze({ x: 8, z: 24, radius: 42 }),
  }),
  '4:-4': Object.freeze({
    source: 'authored-mission-bay-plan',
    styleSequence: Object.freeze(['setback', 'tapered', 'box', 'setback', 'tapered', 'box']),
    paletteSequence: Object.freeze(['glass-tower', 'modern-white', 'steel-tower', 'brick-industrial']),
    grade: 0.006,
    landmarkClearance: Object.freeze({ x: 32, z: 64, radius: 52 }),
  }),
  '-5:-4': Object.freeze({
    source: 'authored-outer-sunset-plan',
    styleSequence: Object.freeze(['box', 'box', 'rowhouse', 'box', 'box', 'rowhouse']),
    paletteSequence: Object.freeze(['stucco', 'concrete-mid', 'stucco']),
    fillRatio: 0.54,
    grade: 0.012,
    landmarkClearance: Object.freeze({ x: 0, z: 128, radius: 56 }),
  }),
  '3:3': Object.freeze({
    source: 'authored-chinatown-plan',
    styleSequence: Object.freeze(['rowhouse', 'box', 'rowhouse', 'box', 'rowhouse', 'setback']),
    paletteSequence: Object.freeze(['masonry-warm', 'brick-industrial', 'victorian', 'masonry-cool']),
    heightRange: Object.freeze([8, 22]),
    minHeight: 6,
    maxHeight: 30,
    fillRatio: 0.90,
    grade: 0.055,
    landmarkClearance: Object.freeze({ x: -64, z: -170, radius: 34 }),
  }),
  '2:3': Object.freeze({
    source: 'authored-nob-hill-plan',
    styleSequence: Object.freeze(['setback', 'box', 'setback', 'rowhouse', 'setback', 'box']),
    paletteSequence: Object.freeze(['limestone-tower', 'masonry-warm', 'stucco', 'modern-white']),
    heightRange: Object.freeze([10, 36]),
    minHeight: 8,
    maxHeight: 48,
    fillRatio: 0.78,
    grade: 0.10,
    landmarkClearance: Object.freeze({ x: -40, z: -20, radius: 48 }),
  }),
  '1:4': Object.freeze({
    source: 'authored-russian-hill-plan',
    styleSequence: Object.freeze(['rowhouse', 'rowhouse', 'box', 'rowhouse', 'rowhouse', 'box']),
    paletteSequence: Object.freeze(['stucco', 'victorian', 'modern-white', 'masonry-warm']),
    heightRange: Object.freeze([7, 22]),
    minHeight: 5,
    maxHeight: 30,
    fillRatio: 0.84,
    // The analytic terrain contributes a -0.00928575 cross-slope along Hyde.
    // Apply the named compensation here; the measured public datum remains
    // HYDE_MEASURED_GRADE for road/facade metadata and QA sampling.
    grade: HYDE_COMPENSATED_PROFILE_GRADE,
    landmarkClearance: Object.freeze({ x: 80, z: 176, radius: 40 }),
  }),
  '0:5': Object.freeze({
    source: 'authored-marina-plan',
    styleSequence: Object.freeze(['box', 'rowhouse', 'box', 'box', 'rowhouse', 'box']),
    paletteSequence: Object.freeze(['modern-white', 'stucco', 'masonry-cool']),
    heightRange: Object.freeze([5, 16]),
    minHeight: 4,
    maxHeight: 22,
    fillRatio: 0.72,
    grade: 0.008,
    landmarkClearance: Object.freeze({ x: -150, z: 20, radius: 52 }),
  }),
  '3:0': Object.freeze({
    source: 'authored-embarcadero-plan',
    styleSequence: Object.freeze(['tapered', 'setback', 'box', 'tapered', 'setback', 'tapered']),
    paletteSequence: Object.freeze(['glass-tower', 'steel-tower', 'limestone-tower', 'modern-white']),
    heightRange: Object.freeze([20, 110]),
    minHeight: 12,
    maxHeight: 160,
    fillRatio: 0.85,
    grade: 0.01,
    // Embarcadero's authored landmarks now sit on the west-side C3 vista at
    // local (-120,0) / (-126,48). Keep the generated setback shell out of
    // that shared sightline; the previous east-frontage clearance no longer
    // covered the moved Salesforce anchor.
    landmarkClearance: Object.freeze({ x: -120, z: 24, radius: 34 }),
    // The fixed C3 ray crosses the four z≈32 lot slots before reaching the
    // west-side anchors. Keep those exact generated shells out of the
    // landmark sightline without blanketing the surrounding Embarcadero grid.
    landmarkClearances: Object.freeze([
      Object.freeze({ x: -96, z: 32, radius: 38 }),
      Object.freeze({ x: -32, z: 32, radius: 38 }),
      Object.freeze({ x: 32, z: 32, radius: 38 }),
      Object.freeze({ x: 96, z: 32, radius: 38 }),
    ]),
  }),
  '2:-1': Object.freeze({
    source: 'authored-soma-design-plan',
    styleSequence: Object.freeze(['box', 'setback', 'box', 'box', 'setback', 'tapered']),
    paletteSequence: Object.freeze(['brick-industrial', 'steel-tower', 'concrete-mid', 'modern-white']),
    heightRange: Object.freeze([8, 40]),
    minHeight: 6,
    maxHeight: 70,
    fillRatio: 0.70,
    grade: 0.012,
    landmarkClearance: Object.freeze({ x: 40, z: 120, radius: 46 }),
  }),
});

// Authored expansion sectors carry a more precise neighborhood identity than
// the broad city-scale position heuristic. Keep this contract shared by
// streamed massing and the representative traffic/pedestrian profiles so a
// Mission Bay sector cannot silently inherit SoMa or Castro morphology.
export const AUTHORED_DISTRICT_BY_SECTOR = Object.freeze({
  '1:0': 'Civic Center',
  '4:0': 'Financial District',
  '4:4': 'North Beach',
  '0:4': 'Pacific Heights',
  '-4:1': 'Presidio',
  '-3:-2': 'Mission',
  '4:-4': 'Mission Bay',
  '-5:-4': 'Outer Sunset',
  '3:3': 'Chinatown',
  '2:3': 'Nob Hill',
  '1:4': 'Russian Hill',
  '0:5': 'Marina',
  '3:0': 'Embarcadero',
  '2:-1': 'SoMa',
  '-5:0': 'Golden Gate',
  '-5:1': 'Richmond',
  '-4:-2': 'Sunset',
  '-2:-2': 'Twin Peaks',
  '-3:-1': 'Castro / Noe Valley',
  '-1:-2': 'Castro / Noe Valley',
  '-1:1': 'SoMa',
  '-4:2': 'Pacific Heights',
});

// ── Fallback profile ──────────────────────────────────────────────────────
const FALLBACK_PROFILE = Object.freeze({
  heightRange: [10, 35],
  minHeight: 5,
  maxHeight: 50,
  fillRatio: 0.75,
  streetGap: 14,
  palettes: ['masonry-cool', 'stucco', 'concrete-mid'],
  geometryStyles: { box: 0.80, setback: 0.20 },
  floorHeight: 3.2,
  name: 'Unknown',
});

// ── Lookup helpers ────────────────────────────────────────────────────────

export function getDistrictProfile(districtNameOrDescriptor) {
  const descriptorKey = typeof districtNameOrDescriptor === 'object'
    ? districtNameOrDescriptor?.key
    : null;
  const districtName = typeof districtNameOrDescriptor === 'object'
    ? districtNameOrDescriptor?.district
    : districtNameOrDescriptor;
  const baseProfile = DISTRICT_PROFILES[districtName] || FALLBACK_PROFILE;
  const authored = descriptorKey ? AUTHORED_MASSING_BY_SECTOR[descriptorKey] : null;
  return authored
    ? { ...baseProfile, ...authored }
    : baseProfile;
}

function pickGeometryStyle(styles, random) {
  const entries = Object.entries(styles);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [name, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return entries[0][0];
}

function pickPalette(palettes, random) {
  return palettes[Math.floor(random() * palettes.length)];
}

// ── Public API ────────────────────────────────────────────────────────────

export const DISTRICT_MASSING_LIMITS = Object.freeze({
  detail: Object.freeze({
    columns: 6,
    rows: 6,
    maxBuildings: 36,
  }),
  proxy: Object.freeze({
    columns: 5,
    rows: 5,
    maxBuildings: 25,
  }),
});

// Detailed lots and the streamed public-realm mesh share this envelope. The
// 12 m carriageway, two 4 m sidewalks, and a modest frontage setback keep every
// generated wall behind the curb instead of letting nominal lot fill overlap
// the street geometry.
const DETAIL_PUBLIC_REALM_GAP = 12 + 4 * 2 + 1.5 * 2;
const DETAIL_FOOTPRINT_BY_STYLE = Object.freeze({
  box: Object.freeze([0.72, 0.96, 0.74, 0.96]),
  setback: Object.freeze([0.68, 0.9, 0.7, 0.92]),
  tapered: Object.freeze([0.64, 0.86, 0.68, 0.9]),
  // The geometry itself contains three attached homes, so this fills a block
  // frontage while still reading as narrow individual addresses.
  rowhouse: Object.freeze([0.86, 0.98, 0.72, 0.9]),
});

function cellNoise(seed, candidateIndex, salt) {
  const value = Math.sin(
    (seed + candidateIndex * 131 + salt * 977) * 0.017453292519943295,
  ) * 43758.5453;
  return value - Math.floor(value);
}

export function generateDistrictMassing(descriptor, sectorSize, quality) {
  const profile = getDistrictProfile(descriptor);
  const random = mulberry32(descriptor.seed);

  const limits = quality === 'detail'
    ? DISTRICT_MASSING_LIMITS.detail
    : DISTRICT_MASSING_LIMITS.proxy;
  const columns = limits.columns;
  const rows = limits.rows;
  const blockStep = sectorSize / Math.max(columns, rows);
  const effectiveGap = quality === 'detail'
    ? Math.max(profile.streetGap, DETAIL_PUBLIC_REALM_GAP)
    : profile.streetGap * 1.25;
  const maxBlockSize = blockStep - effectiveGap;
  // Use the existing 6x6 slot budget consistently in detailed sectors. Dense
  // urban profiles approach a complete street wall, while low-fill park and
  // waterfront profiles retain their authored openness.
  const lotFillRatio = quality === 'detail'
    ? Math.min(0.96, profile.fillRatio * 1.18 + 0.07)
    : profile.fillRatio * 0.85;

  const buildings = [];
  let candidateIndex = 0;
  const landmarkClearances = [
    ...(profile.landmarkClearance ? [profile.landmarkClearance] : []),
    ...(profile.landmarkClearances || []),
  ];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      candidateIndex += 1;
      const lotChance = random();
      if (lotChance > lotFillRatio) continue;

      const cellIndex = row * columns + column;
      const authoredStyle = profile.styleSequence?.[cellIndex % profile.styleSequence.length];
      const geometryStyle = authoredStyle && profile.geometryStyles[authoredStyle]
        ? authoredStyle
        : pickGeometryStyle(profile.geometryStyles, random);
      const authoredPalette = profile.paletteSequence?.[
        cellIndex % profile.paletteSequence.length
      ];
      const paletteCandidate = authoredPalette && profile.palettes.includes(authoredPalette)
        ? authoredPalette
        : pickPalette(profile.palettes, random);
      const paletteRoll = profile.palettes.indexOf(paletteCandidate);
      const paletteName = profile.palettes[
        (paletteRoll + row + column * 2) % profile.palettes.length
      ];
      const palette = getPalette(paletteName);
      const paletteIndex = (
        Math.floor(random() * palette.colors.length) + row + column
      ) % palette.colors.length;

      const footprintRange = quality === 'detail'
        ? (DETAIL_FOOTPRINT_BY_STYLE[geometryStyle] || DETAIL_FOOTPRINT_BY_STYLE.box)
        : [0.65, 0.95, 0.65, 0.95];
      const widthFrac = THREE.MathUtils.lerp(
        footprintRange[0],
        footprintRange[1],
        random(),
      );
      const depthFrac = THREE.MathUtils.lerp(
        footprintRange[2],
        footprintRange[3],
        random(),
      );
      const width = maxBlockSize * widthFrac;
      const depth = maxBlockSize * depthFrac;

      const heightRhythm = (
        cellNoise(descriptor.seed >>> 0, candidateIndex, 3) - 0.5
      ) * (profile.maxHeight <= 60 ? 0.22 : 0.12);
      const heightT = THREE.MathUtils.clamp(random() + heightRhythm, 0, 1);
      const heightNoise = (random() - 0.5) * 8;
      const rawHeight = THREE.MathUtils.clamp(
        profile.heightRange[0]
          + heightT * (profile.heightRange[1] - profile.heightRange[0])
          + heightNoise,
        profile.minHeight,
        profile.maxHeight,
      );
      const minimumFloors = Math.max(1, Math.ceil(profile.minHeight / profile.floorHeight));
      const maximumFloors = Math.max(minimumFloors, Math.floor(profile.maxHeight / profile.floorHeight));
      const floorCount = THREE.MathUtils.clamp(
        Math.round(rawHeight / profile.floorHeight),
        minimumFloors,
        maximumFloors,
      );
      const height = floorCount * profile.floorHeight;

      const slotX = -sectorSize * 0.5 + blockStep * (column + 0.5);
      const slotZ = -sectorSize * 0.5 + blockStep * (row + 0.5);
      if (landmarkClearances.some((clearance) => (
        Math.hypot(slotX - clearance.x, slotZ - clearance.z) < clearance.radius
      ))) continue;
      const xSlack = Math.max(0, maxBlockSize - width);
      const zSlack = Math.max(0, maxBlockSize - depth);
      const x = slotX + (
        cellNoise(descriptor.seed >>> 0, candidateIndex, 11) - 0.5
      ) * xSlack * 0.72;
      const z = slotZ + (
        cellNoise(descriptor.seed >>> 0, candidateIndex, 19) - 0.5
      ) * zSlack * 0.72;

      buildings.push({
        x,
        z,
        width,
        depth,
        height,
        floorHeight: profile.floorHeight,
        geometryStyle,
        paletteName,
        paletteIndex,
      });
    }
  }

  return buildings;
}

export function getPalette(name) {
  return PALETTES[name] || PALETTES['masonry-cool'];
}

export function getDistrictNames() {
  return Object.keys(DISTRICT_PROFILES);
}
