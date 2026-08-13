/** Prove deterministic terrain ownership at the EPSG:26910 550,000 m boundary. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSfMetricTile } from './build-ferry-production-tile-v1.mjs';
import { openGeoTiffWindowReader } from './geotiff-window-reader-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TILE = { gridEasting: 1432, gridNorthing: 10894 };
const TILE_MIN_E = TILE.gridEasting * 384;
const TILE_MIN_N = TILE.gridNorthing * 384;
const NORTHING = TILE_MIN_N + 192;
const WEST_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-3dep-ca-sanfrancisco-b23-x54y419-v1.lock.json');
const EAST_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const q = (value) => Math.round(value * 1e6) / 1e6;

async function sampleLock(lockPath, easting, northing) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const reader = await openGeoTiffWindowReader(path.join(ROOT, lock.raster.localRawCache));
  try {
    const pixel = reader.modelToPixel(easting, northing);
    const window = await reader.readWindow({ column: Math.floor(pixel.column), row: Math.floor(pixel.row), width: 1, height: 1 });
    assert(Number.isFinite(window.values[0]) && window.values[0] !== window.nodata, `${lock.id} boundary sample is invalid`);
    return window.values[0];
  } finally {
    await reader.close();
  }
}

function terrainHeightsAt(positions, localEasting, localNorthing) {
  const heights = [];
  for (let index = 0; index < positions.length; index += 3) {
    if (positions[index] === localEasting && positions[index + 2] === localNorthing) heights.push(positions[index + 1]);
  }
  assert(heights.length, `Terrain mesh has no vertex at ${localEasting},${localNorthing}`);
  return [...new Set(heights)];
}

const built = await buildSfMetricTile({ tile: TILE, write: false });
assert.deepEqual(built.receipt.source.geoTiffs.map(({ ownershipCell }) => ownershipCell).sort(), ['54,418', '55,418'], 'Boundary tile must bind both canonical terrain cells');
const positions = built.categories.terrain.positions;
const boundaryEasting = 550_000;
const westHeight = q(await sampleLock(WEST_LOCK_PATH, boundaryEasting, NORTHING));
const eastHeight = q(await sampleLock(EAST_LOCK_PATH, boundaryEasting + 1, NORTHING));
const meshBoundaryHeights = terrainHeightsAt(positions, boundaryEasting - TILE_MIN_E, NORTHING - TILE_MIN_N);
const meshEastHeights = terrainHeightsAt(positions, boundaryEasting + 1 - TILE_MIN_E, NORTHING - TILE_MIN_N);
assert.deepEqual(meshBoundaryHeights, [westHeight], 'Exact 550,000 m boundary must use the west terrain cell');
assert.deepEqual(meshEastHeights, [eastHeight], 'First metre east of the boundary must use the east terrain cell');
for (const feature of built.packageDescriptor.sourceFeatures) {
  const [easting, northing] = feature.transformedPositionEpsg26910VerticalMetres;
  const expectedCell = `${Math.floor((easting - 1e-7) / 10_000)},${Math.floor((northing - 1e-7) / 10_000)}`;
  const receiptSource = built.receipt.source.geoTiffs.find(({ elevationSourceLockId }) => elevationSourceLockId === feature.elevationSourceLockId);
  assert.equal(receiptSource?.ownershipCell, expectedCell, `Feature ${feature.sourceFeatureId} violates canonical terrain ownership`);
}
console.log(JSON.stringify({ result: 'SF cross-raster terrain ownership passed', tile: built.receipt.tile.identity, boundaryEasting, northing: NORTHING, westHeight, eastHeight, terrainSources: built.receipt.source.geoTiffs.map(({ ownershipCell, sha256 }) => ({ ownershipCell, sha256 })) }, null, 2));
