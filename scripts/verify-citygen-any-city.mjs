import { writeFile } from 'node:fs/promises';
import { osmJsonToCity } from '../src/citygen/osm.js';
import { planBuildingPlacement, proposeBuildingPlacement, removeBuildingById } from '../src/citygen/core.js';

// Deterministic proof that the same CityGen OSM importer used for San
// Francisco also converts an arbitrary city's road/building tags into the
// full metadata model without any public Overpass dependency.
const center = { lat: 45.5152, lon: -122.6784 };
const points = (lat, lon, offsetX, offsetZ) => [
  { lat: lat + offsetZ * 0.00006, lon: lon + offsetX * 0.00006 },
  { lat: lat + offsetZ * 0.00006, lon: lon + offsetX * 0.00016 },
  { lat: lat + offsetZ * 0.00016, lon: lon + offsetX * 0.00016 },
  { lat: lat + offsetZ * 0.00016, lon: lon + offsetX * 0.00006 },
];

const elements = [
  // Burnside St: named one-way primary with a real sidewalk width.
  {
    type: 'way',
    id: 1001,
    tags: { highway: 'primary', name: 'Burnside St', lanes: '2', oneway: 'yes', sidewalk_width: '2.8' },
    geometry: [
      { lat: 45.5231, lon: -122.6900 },
      { lat: 45.5231, lon: -122.6800 },
      { lat: 45.5231, lon: -122.6700 },
    ],
  },
  // Two-way secondary crossing it.
  {
    type: 'way',
    id: 1002,
    tags: { highway: 'secondary', name: '6th Ave', lanes: '3' },
    geometry: [
      { lat: 45.5190, lon: -122.6800 },
      { lat: 45.5231, lon: -122.6800 },
      { lat: 45.5270, lon: -122.6800 },
    ],
  },
  // Residential streets for a second intersection.
  {
    type: 'way',
    id: 1003,
    tags: { highway: 'residential', name: 'Pine St' },
    geometry: [
      { lat: 45.5270, lon: -122.6900 },
      { lat: 45.5270, lon: -122.6800 },
      { lat: 45.5270, lon: -122.6700 },
    ],
  },
  {
    type: 'way',
    id: 1004,
    tags: { highway: 'tertiary', name: '11th Ave', oneway: '-1' },
    geometry: [
      { lat: 45.5190, lon: -122.6900 },
      { lat: 45.5270, lon: -122.6900 },
      { lat: 45.5310, lon: -122.6900 },
    ],
  },
  // Buildings with realistic shop/residential/levels tags.
  {
    type: 'way',
    id: 2001,
    tags: { building: 'retail', shop: 'cafe', name: 'Morning Coffee', levels: '2' },
    geometry: points(45.5231, -122.68255, -2, -2),
  },
  {
    type: 'way',
    id: 2002,
    tags: { building: 'residential', 'building:architecture': 'victorian', levels: '3' },
    geometry: points(45.5231, -122.68255, 2, -2),
  },
  {
    type: 'way',
    id: 2003,
    tags: { building: 'apartments', levels: '5', material: 'brick' },
    geometry: points(45.5231, -122.68255, -2, 2),
  },
  {
    type: 'way',
    id: 2004,
    tags: { building: 'commercial', levels: '9' },
    geometry: points(45.5231, -122.68255, 2, 2),
  },
];

const city = osmJsonToCity({ elements }, { center, name: 'Portland, OR', source: 'openstreetmap' });
const failures = [];
let placementPoint = null;
for (const block of city.blocks) {
  if (block.landUse === 'park' || !block.polygon?.length) continue;
  const xs = block.polygon.map((p) => p.x);
  const zs = block.polygon.map((p) => p.z);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  if (planBuildingPlacement(city, cx, cz).ok) {
    placementPoint = { x: cx, z: cz };
    break;
  }
  for (let dx = -8; dx <= 8; dx += 4) {
    for (let dz = -8; dz <= 8; dz += 4) {
      if (planBuildingPlacement(city, cx + dx, cz + dz).ok) {
        placementPoint = { x: cx + dx, z: cz + dz };
        break;
      }
    }
    if (placementPoint) break;
  }
  if (placementPoint) break;
}
let addedBuilding = null;
let afterRemoveCount = city.buildings.length;
if (placementPoint) {
  const originalCount = city.buildings.length;
  const placed = proposeBuildingPlacement(city, placementPoint.x, placementPoint.z);
  if (placed.ok) {
    addedBuilding = {
      id: placed.building.id,
      blockId: placed.building.blockId,
      district: placed.building.district,
      type: placed.building.typeLabel,
      material: placed.building.material,
      facade: placed.building.facade,
      height: placed.building.height,
      address: placed.building.address,
    };
    removeBuildingById(city, placed.building.id);
    afterRemoveCount = city.buildings.length;
    if (afterRemoveCount !== originalCount) failures.push('dynamic add/undo count mismatch');
  } else {
    failures.push('dynamic add rejected inside a buildable block');
  }
} else {
  failures.push('no buildable block found for dynamic add');
}
const checks = {
  name: city.meta.name,
  generator: city.meta.generator,
  center: city.meta.center,
  buildings: city.buildings.length,
  streets: city.streets.length,
  segments: city.segments.length,
  signals: city.signals.length,
  oneWayStreets: city.streets.filter((street) => street.oneway !== 'both').length,
  sidewalkCoverage: city.segments.filter((segment) => segment.sidewalkW > 0).length,
  streetMetadata: city.streets.slice(0, 4).map((street) => ({
    name: street.name,
    highway: street.highway,
    oneway: street.oneway,
    lanes: street.lanes,
    sidewalkW: street.sidewalkW,
    asphaltWidth: street.asphaltWidth,
  })),
  buildingMetadata: city.buildings.map((building) => ({
    id: building.id,
    type: building.typeLabel,
    usage: building.usage,
    material: building.material,
    facade: building.facade,
    stories: building.stories,
    height: building.height,
  })),
  signalMetadata: city.signals.map((signal) => ({
    id: signal.id,
    streets: signal.streetIds,
    period: signal.period,
  })),
  dynamicAdd: addedBuilding ? {
    ok: true,
    building: addedBuilding,
    afterRemoveCount,
  } : { ok: false },
  errors: [],
};

if (checks.buildings < 4) failures.push('buildings < 4');
if (checks.streets < 4) failures.push('streets < 4');
if (checks.segments < 8) failures.push('segments < 8');
if (checks.oneWayStreets < 2) failures.push('one-way metadata missing');
if (!checks.sidewalkCoverage) failures.push('sidewalk metadata missing');
if (!checks.signalMetadata.length) failures.push('signals missing');
if (!checks.buildingMetadata.some((b) => b.material !== 'plaster')) failures.push('materials not type-aware');
if (!checks.buildingMetadata.some((b) => b.facade === 'shopfront')) failures.push('shopfront facade missing');
if (!checks.buildingMetadata.some((b) => b.facade === 'edwardian')) failures.push('rowhouse facade missing');
if (!checks.dynamicAdd.ok) failures.push('dynamic add missing');
if (failures.length) {
  checks.errors = failures;
  console.error(JSON.stringify({ result: 'FAIL', checks }, null, 2));
  process.exitCode = 1;
} else {
  await writeFile('.qa-citygen-any-city.json', JSON.stringify(checks, null, 2));
  console.log(JSON.stringify({ result: 'PASS', checks }, null, 2));
}
