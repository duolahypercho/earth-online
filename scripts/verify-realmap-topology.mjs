/**
 * Topology fidelity gate: assert the OSM city asset still carries real named
 * SF corridors at expected local-metre positions (OpenStreetMap ground truth —
 * not Google tiles). Side-by-side map matching starts here.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const gzPath = path.join(ROOT, 'public/data/sf/sf-city.json.gz');
const jsonPath = path.join(ROOT, 'public/data/sf/sf-city.json');

function loadCity() {
  if (existsSync(gzPath)) {
    return JSON.parse(gunzipSync(readFileSync(gzPath)).toString('utf8'));
  }
  if (existsSync(jsonPath)) {
    return JSON.parse(readFileSync(jsonPath, 'utf8'));
  }
  throw new Error('Missing public/data/sf/sf-city.json(.gz). Run npm run build:realmap-assets.');
}

function roadPoints(road) {
  const flat = road.points;
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
}

function corridorHits(roads, namePattern, expected, radius = 420) {
  const re = new RegExp(namePattern, 'i');
  const matches = roads.filter((road) => re.test(String(road.name || '')));
  assert(matches.length > 0, `Missing named corridor matching /${namePattern}/`);
  let nearest = Infinity;
  for (const road of matches) {
    for (const point of roadPoints(road)) {
      const distance = Math.hypot(point.x - expected.x, point.z - expected.z);
      if (distance < nearest) nearest = distance;
    }
  }
  assert(
    nearest <= radius,
    `${namePattern} nearest sample is ${nearest.toFixed(0)} m from expected (${expected.x},${expected.z}); want ≤ ${radius} m`,
  );
  return { namePattern, hits: matches.length, nearestM: Math.round(nearest) };
}

const city = loadCity();
const roads = [...(city.detailRoads || []), ...(city.roads || [])];
const byId = new Map();
for (const road of roads) {
  if (!byId.has(road.id)) byId.set(road.id, road);
}
const uniqueRoads = [...byId.values()];

assert(uniqueRoads.length >= 50000, `Expected ≥50k OSM roads, got ${uniqueRoads.length}`);
assert((city.detailRoads || []).length >= 20000, `Expected peninsula detailRoads coverage, got ${(city.detailRoads || []).length}`);

// Expected anchors are local metres from atlas center (37.778, -122.4194),
// sampled from the live OSM asset (corridor midpoints / known crossings).
const reports = [
  corridorHits(uniqueRoads, '^Market Street$', { x: 200, z: -40 }, 600),
  corridorHits(uniqueRoads, '^Mission Street$', { x: -700, z: -900 }, 800),
  corridorHits(uniqueRoads, '^Castro Street$', { x: -1340, z: -1200 }, 900),
  corridorHits(uniqueRoads, '^Haight Street$', { x: -1612, z: -752 }, 500),
  corridorHits(uniqueRoads, '^Geary (Boulevard|Street)$', { x: -2800, z: 480 }, 900),
  corridorHits(uniqueRoads, 'Embarcadero', { x: 2200, z: 400 }, 900),
  corridorHits(uniqueRoads, '^California Street$', { x: 800, z: 1000 }, 800),
  corridorHits(uniqueRoads, '^Columbus Avenue$', { x: 1000, z: 2400 }, 900),
  corridorHits(uniqueRoads, '^Judah Street$', { x: -4500, z: -1840 }, 900),
  corridorHits(uniqueRoads, '^Fillmore Street$', { x: -1259, z: 1100 }, 800),
];

const result = {
  result: 'realmap OSM topology fidelity passed',
  roadCount: uniqueRoads.length,
  detailRoadCount: (city.detailRoads || []).length,
  detailBuildingCount: (city.detailBuildings || []).length,
  corridors: reports,
  detailBBox: city.meta?.detailBBox || city.meta?.detailBbox || null,
  attribution: '© OpenStreetMap contributors',
};
console.log(JSON.stringify(result, null, 2));
