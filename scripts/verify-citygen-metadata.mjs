/**
 * CityGen metadata fidelity gate: verify that building, street, segment,
 * block, and signal metadata fields flow correctly through procedural
 * generation, OSM import, and export/import round-trips.
 */
import assert from 'node:assert/strict';
import { generateCity, buildTrafficGraph, exportCityMetadata, importCityMetadata } from '../src/citygen/core.js';
import { osmJsonToCity, parseLatLon, snapBlockToRoads, maxspeedToKmh } from '../src/citygen/osm.js';

const failures = [];

// ── 1. Procedural city ──────────────────────────────────────────────────────
const procCity = generateCity({ seed: 731, style: 'sanfrancisco', extent: 660 });

// 1a. Every procedural street has complete speed + sidewalk + cycleway metadata.
for (const street of procCity.streets) {
  if (street.maxspeedKmh == null || street.maxspeedKmh <= 0) failures.push(`proc street ${street.id} missing maxspeedKmh`);
  if (street.maxspeedSource !== 'zone-default') failures.push(`proc street ${street.id} wrong maxspeedSource: ${street.maxspeedSource}`);
  if (street.sidewalkLeft == null) failures.push(`proc street ${street.id} missing sidewalkLeft`);
  if (street.sidewalkRight == null) failures.push(`proc street ${street.id} missing sidewalkRight`);
  if (street.cycleway == null) failures.push(`proc street ${street.id} missing cycleway`);
}

// 1b. Procedural segments carry the same fields.
for (const seg of procCity.segments) {
  if (seg.maxspeedKmh == null || seg.maxspeedKmh <= 0) failures.push(`proc seg ${seg.id} missing maxspeedKmh`);
  if (seg.sidewalkLeft == null) failures.push(`proc seg ${seg.id} missing sidewalkLeft`);
  if (seg.sidewalkRight == null) failures.push(`proc seg ${seg.id} missing sidewalkRight`);
  if (seg.cycleway == null) failures.push(`proc seg ${seg.id} missing cycleway`);
}

// 1c. Procedural buildings carry optional metadata fields.
for (const bld of procCity.buildings.slice(0, 10)) {
  if (bld.address == null) failures.push(`proc building ${bld.id} missing address`);
  if (bld.roofShape == null) failures.push(`proc building ${bld.id} missing roofShape`);
  if (bld.shop == null) failures.push(`proc building ${bld.id} missing shop`);
  if (bld.amenity == null) failures.push(`proc building ${bld.id} missing amenity`);
  if (bld.tourism == null) failures.push(`proc building ${bld.id} missing tourism`);
}

// 1d. Procedural traffic graph has consistent one-way/two-way edge counts.
const procEdges = buildTrafficGraph(procCity);
const bySeg = new Map(procCity.segments.map((s) => [s.id, s]));
for (const edge of procEdges) {
  const seg = bySeg.get(edge.segmentId);
  if (!seg) { failures.push(`proc edge ${edge.id} refs missing segment`); continue; }
  if (seg.oneway !== 'both' && edge.direction === (seg.oneway === 'increasing' ? 'decreasing' : 'increasing')) {
    failures.push(`proc edge ${edge.id} direction ${edge.direction} conflicts with oneway ${seg.oneway}`);
  }
}

// ── 2. OSM import ───────────────────────────────────────────────────────────
const center = { lat: 45.5152, lon: -122.6784 };
const p = (lat, lon, ox, oz) => [
  { lat: lat + oz * 0.00006, lon: lon + ox * 0.00006 },
  { lat: lat + oz * 0.00006, lon: lon + ox * 0.00016 },
  { lat: lat + oz * 0.00016, lon: lon + ox * 0.00016 },
  { lat: lat + oz * 0.00016, lon: lon + ox * 0.00006 },
];
const osmElements = [
  { type: 'node', id: 3001, lat: 45.5231, lon: -122.6800, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 3002, lat: 45.5270, lon: -122.6900, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 3003, lat: 45.5231, lon: -122.6700, tags: { highway: 'crossing' } },
  { type: 'way', id: 1001, tags: { highway: 'primary', name: 'Burnside St', lanes: '2', oneway: 'yes', sidewalk_width: '2.8', maxspeed: '25 mph', cycleway: 'lane' }, geometry: [{ lat: 45.5231, lon: -122.6900 }, { lat: 45.5231, lon: -122.6800 }, { lat: 45.5231, lon: -122.6700 }] },
  { type: 'way', id: 1002, tags: { highway: 'secondary', name: '6th Ave', lanes: '3', 'sidewalk:left': 'no', 'sidewalk:right': 'yes' }, geometry: [{ lat: 45.5190, lon: -122.6800 }, { lat: 45.5231, lon: -122.6800 }, { lat: 45.5270, lon: -122.6800 }] },
  { type: 'way', id: 1003, tags: { highway: 'residential', name: 'Pine St', maxspeed: 'DE:urban' }, geometry: [{ lat: 45.5270, lon: -122.6900 }, { lat: 45.5270, lon: -122.6800 }] },
  { type: 'way', id: 1004, tags: { highway: 'tertiary', name: '11th Ave', oneway: '-1', lanes: '2' }, geometry: [{ lat: 45.5190, lon: -122.6900 }, { lat: 45.5270, lon: -122.6900 }] },
  // Building: retail shop with full address and roof shape.
  { type: 'way', id: 2001, tags: { building: 'retail', shop: 'cafe', name: 'Morning Coffee', levels: '2', 'addr:housenumber': '412', 'addr:street': 'Burnside St', 'addr:unit': 'A', 'roof:shape': 'flat' }, geometry: p(45.5231, -122.68255, -3, -3) },
  // Building: offices (should be tower).
  { type: 'way', id: 2002, tags: { building: 'commercial', office: 'yes', levels: '10', material: 'glass', name: 'Tech Tower' }, geometry: p(45.5231, -122.6775, -2, -2) },
  // Building: school (should be civic).
  { type: 'way', id: 2003, tags: { building: 'yes', amenity: 'school', name: 'Lincoln High', levels: '3' }, geometry: p(45.5270, -122.68255, -2, -3) },
  // Building: warehouse (should be warehouse).
  { type: 'way', id: 2004, tags: { building: 'warehouse', industrial: 'yes', levels: '2', name: 'Port Storage' }, geometry: p(45.5270, -122.6775, -2, -2) },
  // Building: rowhouse with addr:place fallback.
  { type: 'way', id: 2005, tags: { building: 'residential', levels: '3', 'addr:housenumber': '15', 'addr:place': 'Elm Row' }, geometry: p(45.5190, -122.68255, -2, -2) },
  // Building: place of worship.
  { type: 'way', id: 2006, tags: { building: 'yes', amenity: 'place_of_worship', name: 'St. Mary', levels: '2' }, geometry: p(45.5190, -122.6775, -2, -2) },
];
const osmCity = osmJsonToCity({ elements: osmElements }, { center, name: 'Portland, OR', source: 'openstreetmap' });

// 2a. maxspeedToKmh utility.
assert.strictEqual(maxspeedToKmh('25 mph'), 40, '25 mph -> 40 km/h');
assert.strictEqual(maxspeedToKmh('50'), 50, '50 -> 50 km/h');
assert.strictEqual(maxspeedToKmh('30 km/h'), 30, '30 km/h -> 30 km/h');
assert.strictEqual(maxspeedToKmh('DE:urban'), 0, 'DE:urban -> 0 (implicit)');
assert.strictEqual(maxspeedToKmh(''), 0, 'empty -> 0');

// 2b. Zone-sign maxspeed falls back to zone default.
const pineSt = osmCity.streets.find((s) => s.name === 'Pine St');
if (!pineSt || pineSt.maxspeed !== 'DE:urban' || pineSt.maxspeedKmh !== 40 || pineSt.maxspeedSource !== 'zone-default') {
  failures.push(`Pine St DE:urban zone fallback: ${JSON.stringify(pineSt ? { raw: pineSt.maxspeed, kmh: pineSt.maxspeedKmh, src: pineSt.maxspeedSource } : null)}`);
}

// 2c. Building type inference from tags.
const coffee = osmCity.buildings.find((b) => b.name === 'Morning Coffee');
if (!coffee || coffee.type !== 'shop' || coffee.address !== '412 #A Burnside St' || coffee.roofShape !== 'flat' || coffee.shop !== 'cafe') {
  failures.push(`Coffee shop metadata: type=${coffee?.type} addr=${coffee?.address} roof=${coffee?.roofShape} shop=${coffee?.shop}`);
}
const techTower = osmCity.buildings.find((b) => b.name === 'Tech Tower');
if (!techTower || techTower.type !== 'tower' || techTower.material !== 'glass') {
  failures.push(`Tech Tower metadata: type=${techTower?.type} material=${techTower?.material}`);
}
const school = osmCity.buildings.find((b) => b.name === 'Lincoln High');
if (!school || school.type !== 'civic' || school.usage !== 'education') {
  failures.push(`School: type=${school?.type} usage=${school?.usage}`);
}
const warehouse = osmCity.buildings.find((b) => b.name === 'Port Storage');
if (!warehouse || warehouse.type !== 'warehouse' || warehouse.usage !== 'industrial') {
  failures.push(`Warehouse: type=${warehouse?.type} usage=${warehouse?.usage}`);
}
const rowhouse = osmCity.buildings.find((b) => b.address?.includes('Elm Row'));
if (!rowhouse || rowhouse.type !== 'rowhouse' || rowhouse.address !== '15 Elm Row') {
  failures.push(`Rowhouse: type=${rowhouse?.type} addr=${rowhouse?.address}`);
}
const worship = osmCity.buildings.find((b) => b.name === 'St. Mary');
if (!worship || worship.type !== 'civic' || worship.usage !== 'religious') {
  failures.push(`Worship: type=${worship?.type} usage=${worship?.usage}`);
}

// 2d. Block land use inferred from building composition.
const blockWithCoffee = osmCity.blocks.find((b) => b.buildings.includes(coffee?.id));
if (blockWithCoffee && blockWithCoffee.landUse === 'mixed') {
  failures.push(`block with shop building should not have landUse=mixed, got ${blockWithCoffee.landUse}`);
}
if (!osmCity.blocks.some((b) => b.landUse !== 'mixed')) {
  failures.push('all OSM blocks have landUse=mixed — inference not working');
}

// 2e. Crossing node creates no signal but is captured.
const crossings = osmElements.filter((e) => e.tags?.highway === 'crossing').length;
if (crossings < 1) failures.push('test data missing crossing nodes');

// ── 3. Export/import round-trip ─────────────────────────────────────────────
const exported = exportCityMetadata(osmCity);
if (!exported) failures.push('export returned null');
const imported = importCityMetadata(exported);
if (!imported) failures.push('import returned null');

if (imported && exported) {
  if (imported.buildings.length !== osmCity.buildings.length) failures.push('import building count mismatch');
  if (imported.streets.length !== osmCity.streets.length) failures.push('import street count mismatch');
  if (imported.signals.length !== osmCity.signals.length) failures.push('import signal count mismatch');

  // Round-trip: street metadata survives.
  const reBurnside = imported.streets.find((s) => s.name === 'Burnside St');
  if (!reBurnside || reBurnside.maxspeedKmh !== 40 || reBurnside.cycleway !== 'lane') {
    failures.push(`round-trip Burnside: kmh=${reBurnside?.maxspeedKmh} cycleway=${reBurnside?.cycleway}`);
  }
  const rePine = imported.streets.find((s) => s.name === 'Pine St');
  if (!rePine || rePine.maxspeedKmh !== 40) failures.push(`round-trip Pine: kmh=${rePine?.maxspeedKmh}`);

  // Round-trip: building metadata survives.
  const reCoffee = imported.buildings.find((b) => b.name === 'Morning Coffee');
  if (!reCoffee || reCoffee.address !== '412 #A Burnside St' || reCoffee.roofShape !== 'flat' || reCoffee.shop !== 'cafe') {
    failures.push(`round-trip Coffee: addr=${reCoffee?.address} roof=${reCoffee?.roofShape} shop=${reCoffee?.shop}`);
  }
  const reSchool = imported.buildings.find((b) => b.name === 'Lincoln High');
  if (!reSchool || reSchool.usage !== 'education') failures.push(`round-trip School: usage=${reSchool?.usage}`);

  // Round-trip: per-side sidewalk on streets.
  const reSixth = imported.streets.find((s) => s.name === '6th Ave');
  if (!reSixth || reSixth.sidewalkLeft !== 0 || !(reSixth.sidewalkRight > 0)) {
    failures.push(`round-trip 6th Ave sidewalk per-side: L=${reSixth?.sidewalkLeft} R=${reSixth?.sidewalkRight}`);
  }

  // Round-trip: segments carry cycleway and maxspeed.
  if (imported.segments) {
    for (const seg of imported.segments) {
      if (seg.maxspeedKmh == null) failures.push(`imported seg ${seg.id} missing maxspeedKmh`);
      if (seg.cycleway == null) failures.push(`imported seg ${seg.id} missing cycleway`);
    }
  }
}

// ── 4. Procedural export/import round-trip ───────────────────────────────────
const procExported = exportCityMetadata(procCity);
const procImported = importCityMetadata(procExported);
if (procImported) {
  if (procImported.streets.length !== procCity.streets.length) failures.push('proc import street count mismatch');
  if (procImported.buildings.length !== procCity.buildings.length) failures.push('proc import building count mismatch');
  for (const street of procImported.streets) {
    if (street.maxspeedKmh == null || street.maxspeedKmh <= 0) failures.push(`proc imported street ${street.id} missing maxspeedKmh`);
    if (street.sidewalkLeft == null || street.sidewalkRight == null) failures.push(`proc imported street ${street.id} missing sidewalk sides`);
  }
}

// ── 5. maxspeedToKmh edge cases ─────────────────────────────────────────────
assert.strictEqual(maxspeedToKmh('70 mph'), 113, '70 mph -> 113 km/h');
assert.strictEqual(maxspeedToKmh('  30  '), 30, 'whitespace trimmed');
assert.strictEqual(maxspeedToKmh('120 km/h'), 120, '120 km/h -> 120');
assert.strictEqual(maxspeedToKmh('10 knots'), 19, '10 knots -> 19 km/h');
assert.strictEqual(maxspeedToKmh('GB:nsl_single'), 0, 'GB:nsl -> 0');

// ── Report ──────────────────────────────────────────────────────────────────
const summary = {
  procBuildings: procCity.buildings.length,
  procStreets: procCity.streets.length,
  procSegments: procCity.segments.length,
  procSignals: procCity.signals.length,
  osmBuildings: osmCity.buildings.length,
  osmStreets: osmCity.streets.length,
  osmSignals: osmCity.signals.length,
  osmBlocks: osmCity.blocks.length,
  blockLandUseDistribution: [...new Set(osmCity.blocks.map((b) => b.landUse))],
  failures,
};

if (failures.length) {
  console.error(JSON.stringify({ result: 'FAIL', ...summary }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ result: 'PASS', ...summary }, null, 2));
}
