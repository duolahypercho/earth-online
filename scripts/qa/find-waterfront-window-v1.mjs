// Offline search for a world window of the built-in San Francisco extract that
// actually contains the shoreline corridor.
//
// Evidence only. This script parses the SAME prebuilt slice the runtime loads
// (`public/data/sf/sf-city.json`) and replicates `loadSfData`'s windowing maths
// exactly, so it can answer "does this window contain shoreline geometry"
// WITHOUT booting a browser or drawing a frame. It makes no visual claim: what
// the frame looks like is decided at runtime and must be probed there
// (scripts/qa/probe-waterfront-window-v1.mjs).
//
//   node --max-old-space-size=1024 scripts/qa/find-waterfront-window-v1.mjs
//
// Env: SF_QA_CANDIDATES="x,z,r;x,z,r"  explicit windows instead of the search.
import { readFileSync } from 'node:fs';

const DATA = 'public/data/sf/sf-city.json';
// Mirrors src/citygen/sf-data.js: roads by midpoint within radius*1.25,
// buildings by centroid within radius, capped in file order.
const MAX_BUILDINGS = Number(process.env.SF_QA_MAX_BUILDINGS || 900);
// The shoreline street. "Southern Embarcadero Freeway" is a motorway three
// kilometres inland of the card's subject and must never be mistaken for it.
const SHORE_NAME = /embarcadero/i;
const NOT_SHORE = /freeway/i;

const city = JSON.parse(readFileSync(DATA, 'utf8'));
const roads = city.roads || [];
const buildings = city.detailBuildings || [];

function points(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
}
function mid(flat) {
  const p = points(flat);
  return p[Math.floor(p.length / 2)];
}

function slice(center, radius) {
  const roadSlice = [];
  for (const road of roads) {
    const p = points(road.points);
    if (p.length < 2) continue;
    const m = p[Math.floor(p.length / 2)];
    if (Math.hypot(m.x - center[0], m.z - center[1]) > radius * 1.25) continue;
    roadSlice.push({ road, p });
  }
  const bldSlice = [];
  for (const building of buildings) {
    if (bldSlice.length >= MAX_BUILDINGS) break;
    const c = building.centroid;
    if (!c) continue;
    if (Math.hypot(c[0] - center[0], c[1] - center[1]) > radius) continue;
    bldSlice.push(building);
  }
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  const note = (x, z) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  };
  for (const entry of roadSlice) for (const pt of entry.p) note(pt.x, pt.z);
  for (const building of bldSlice) for (const pt of points(building.points)) note(pt.x, pt.z);
  if (!Number.isFinite(minX)) return null;
  const bounds = { minX: minX - 30, maxX: maxX + 30, minZ: minZ - 30, maxZ: maxZ + 30 };
  const shore = roadSlice.filter((entry) => SHORE_NAME.test(entry.road.name || '')
    && !NOT_SHORE.test(entry.road.name || '') && entry.road.highway !== 'motorway');
  // src/citygen/renderer.js makeWater(): a 680 m x (depthZ+520) plane centred
  // at bounds.maxX - 70. It is an edge-of-window water body, not a surveyed
  // shoreline; the runtime probe is what decides whether it reads as one.
  const waterX = bounds.maxX - 70;
  const waterSpanX = [waterX - 340, waterX + 340];
  let shorePoints = 0;
  let shoreEastOfWaterEdge = 0;
  for (const entry of shore) {
    for (const pt of entry.p) {
      shorePoints += 1;
      if (pt.x > waterSpanX[0]) shoreEastOfWaterEdge += 1;
    }
  }
  let roadPoints = 0;
  let roadUnderWater = 0;
  for (const entry of roadSlice) {
    for (const pt of entry.p) {
      roadPoints += 1;
      if (pt.x > waterSpanX[0]) roadUnderWater += 1;
    }
  }
  return {
    center, radius,
    roads: roadSlice.length,
    buildings: bldSlice.length,
    bounds: {
      minX: +bounds.minX.toFixed(1), maxX: +bounds.maxX.toFixed(1),
      minZ: +bounds.minZ.toFixed(1), maxZ: +bounds.maxZ.toFixed(1),
    },
    shoreSegments: shore.length,
    shoreNames: [...new Set(shore.map((entry) => entry.road.name))].slice(0, 4),
    waterPlaneX: +waterX.toFixed(1),
    waterPlaneSpanX: waterSpanX.map((v) => +v.toFixed(1)),
    shorePointsInsideWaterFootprint: shorePoints ? +(shoreEastOfWaterEdge / shorePoints).toFixed(3) : null,
    roadPointsInsideWaterFootprint: roadPoints ? +(roadUnderWater / roadPoints).toFixed(3) : null,
    tallestBuildingM: bldSlice.reduce((m, b) => Math.max(m, Number(b.height) || 0), 0),
  };
}

const explicit = (process.env.SF_QA_CANDIDATES || '').split(';').map((s) => s.trim()).filter(Boolean)
  .map((s) => s.split(',').map(Number)).filter((a) => a.length === 3 && a.every(Number.isFinite));

const candidates = explicit.length
  ? explicit.map(([x, z, r]) => [[x, z], r])
  : (() => {
    // Sample centres along the real shoreline street itself.
    const shore = roads.filter((r) => SHORE_NAME.test(r.name || '') && !NOT_SHORE.test(r.name || '')
      && r.highway !== 'motorway');
    const seen = new Set();
    const out = [];
    for (const road of shore) {
      const m = mid(road.points);
      const key = `${Math.round(m.x / 200)},${Math.round(m.z / 200)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const radius of [520, 720]) out.push([[Math.round(m.x), Math.round(m.z)], radius]);
    }
    out.push([[1600, 400], 720]); // the boot window, for comparison
    return out;
  })();

const rows = [];
for (const [center, radius] of candidates) {
  const result = slice(center, radius);
  if (result) rows.push(result);
}
rows.sort((a, b) => (b.shoreSegments - a.shoreSegments) || (b.buildings - a.buildings));
console.log(JSON.stringify(rows, null, 2));
