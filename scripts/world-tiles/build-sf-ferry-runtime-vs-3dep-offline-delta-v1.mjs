/**
 * Build a bounded, offline-only comparison between the live SF contour-grid
 * sampler and the checked-in Ferry 3DEP engineering-preview buffer.
 *
 * This deliberately does not feed terrain back into the renderer.  It is a
 * datum/phase diagnostic, not a terrain conversion or an acceptance test.
 *
 * Usage: node scripts/world-tiles/build-sf-ferry-runtime-vs-3dep-offline-delta-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ID = 'sf-ferry-runtime-vs-3dep-offline-delta-v1';
const OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts', ID);
const JSON_NAME = `${ID}.json`;
const CSV_NAME = `${ID}.csv`;

const PATHS = Object.freeze({
  elevation: 'public/data/sf/sf-elevation.json',
  elevationGzip: 'public/data/sf/sf-elevation.json.gz',
  elevationBuilder: 'scripts/build-sf-elevation.mjs',
  runtimeMain: 'src/realmap/main.js',
  heroStreetscape: 'src/realmap/hero-streetscape.js',
  heroShoreline: 'src/realmap/hero-shoreline.js',
  verifyHeroShoreline: 'scripts/verify-hero-shoreline.mjs',
  contours: 'public/data/sf/sf-contours.geojson',
  city: 'public/data/sf/sf-city.json',
  cityGzip: 'public/data/sf/sf-city.json.gz',
  shoreline: 'public/data/sf/sf-shoreline.geojson',
  sourceLock: 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json',
  horizontalLock: 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json',
  localBridgeLock: 'public/data/world/source-locks/sf-ferry-sf-atlas-linear-to-epsg26910-v1.lock.json',
  verticalContextLock: 'public/data/world/source-locks/sf-ferry-3dep-2023-vertical-water-reference-v1.lock.json',
  region: 'public/data/world/regions/sf-ferry-building-hero.region.json',
  parent: 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-parent-v1/sf-ferry-3dep-2x2-parent-preview-v1.f32le',
  parentReceipt: 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-parent-v1/sf-ferry-3dep-2x2-parent-preview-v1.receipt.json',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const number = (value, label) => {
  assert(Number.isFinite(value), `${label} must be finite`);
  return value;
};
const relative = (key) => PATHS[key];
const HERO_STREETSCAPE_ROAD_IDS = Object.freeze([26769726, 88463826, 88463827, 88463831, 283512618, 850162147]);
const HERO_STREETSCAPE_ROAD_NAMES = Object.freeze({ 26769726: 'Ferry Plaza', 88463826: 'The Embarcadero', 88463827: 'The Embarcadero', 88463831: 'Mission Street', 283512618: 'The Embarcadero', 850162147: 'The Embarcadero' });

async function readInput(key) {
  const bytes = await readFile(path.join(ROOT, relative(key)));
  return { path: relative(key), bytes, sha256: sha256(bytes), byteLength: bytes.length };
}

function sourceRecord(city, name) {
  const result = city?.meta?.sources?.find((candidate) => candidate?.name === name);
  assert(result, `sf-city.json is missing source record: ${name}`);
  return result;
}

function pointInFlatRing(x, z, flat) {
  let inside = false;
  for (let index = 0, previous = flat.length - 2; index < flat.length; previous = index, index += 2) {
    const ax = flat[index]; const az = flat[index + 1];
    const bx = flat[previous]; const bz = flat[previous + 1];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

function elevationBuilderBoundary0Land(city, x, z) {
  // This intentionally mirrors build-sf-elevation.mjs exactly: its rasterizer
  // assigns `flatBoundary = boundary[0] || []`, not a union of city rings.
  const ring = city.boundary?.[0] || [];
  return ring.length >= 6 && pointInFlatRing(x, z, ring);
}

/** Exact runtime `elevationAt` arithmetic for the asset-loaded branch. */
export function runtimeElevationAt(terrainData, x, z) {
  if (!terrainData?.grid) return 0;
  const { originX, originZ, cellSize, width, height, grid } = terrainData;
  const gx = (x - originX) / cellSize;
  const gz = (z - originZ) / cellSize;
  const x0 = Math.floor(gx); const z0 = Math.floor(gz);
  const tx = gx - x0; const tz = gz - z0;
  const sample = (column, row) => {
    if (column < 0 || column >= width || row < 0 || row >= height) return 0;
    // This is intentionally JS-falsy semantics from src/realmap/main.js:
    // 0, null, undefined, NaN, false, and '' become 0; negative values stay.
    return grid[row * width + column] || 0;
  };
  const a = sample(x0, z0); const b = sample(x0 + 1, z0);
  const c = sample(x0, z0 + 1); const d = sample(x0 + 1, z0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export function decodeFloat32LittleEndian(bytes) {
  assert.equal(bytes.length % 4, 0, 'f32le byte length must be divisible by four');
  const values = new Float32Array(bytes.length / 4);
  for (let index = 0; index < values.length; index += 1) values[index] = bytes.readFloatLE(index * 4);
  return values;
}

function genericForward(horizontalLock, lonDegrees, latDegrees) {
  const projection = horizontalLock.claims.operation.authorityPath[1];
  const parameters = projection.parameters;
  const { semiMajorAxisMetres: a, inverseFlattening } = projection.ellipsoidFromEpsg4269;
  const f = 1 / inverseFlattening; const e2 = f * (2 - f); const ep2 = e2 / (1 - e2);
  const radians = Math.PI / 180; const k0 = parameters.scaleFactor;
  const lon0 = parameters.longitudeOfNaturalOriginDegrees * radians; const phi = latDegrees * radians;
  const sinPhi = Math.sin(phi); const cosPhi = Math.cos(phi); const tanPhi = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * sinPhi ** 2); const t = tanPhi ** 2; const c = ep2 * cosPhi ** 2;
  const aa = cosPhi * (lonDegrees * radians - lon0);
  const m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  return [
    parameters.falseEastingMetres + k0 * n * (aa + (1 - t + c) * aa ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120),
    parameters.falseNorthingMetres + k0 * (m + n * tanPhi * (aa ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720)),
  ];
}

function genericInverse(horizontalLock, easting, northing) {
  const projection = horizontalLock.claims.operation.authorityPath[1];
  const parameters = projection.parameters;
  const { semiMajorAxisMetres: a, inverseFlattening } = projection.ellipsoidFromEpsg4269;
  const f = 1 / inverseFlattening; const e2 = f * (2 - f); const ep2 = e2 / (1 - e2);
  const radians = Math.PI / 180; const k0 = parameters.scaleFactor;
  const lon0 = parameters.longitudeOfNaturalOriginDegrees * radians;
  const m = (northing - parameters.falseNorthingMetres) / k0;
  const mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinPhi1 = Math.sin(phi1); const cosPhi1 = Math.cos(phi1); const tanPhi1 = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sinPhi1 ** 2);
  const r1 = a * (1 - e2) / (1 - e2 * sinPhi1 ** 2) ** 1.5;
  const t1 = tanPhi1 ** 2; const c1 = ep2 * cosPhi1 ** 2;
  const d = (easting - parameters.falseEastingMetres) / (n1 * k0);
  const latitude = phi1 - (n1 * tanPhi1 / r1) * (d ** 2 / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720);
  const longitude = lon0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
    + (5 - 2 * t1 + 28 * c1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / cosPhi1;
  return [longitude / radians, latitude / radians];
}

function localToEn(bridgeLock, horizontalLock, x, z) {
  const frame = bridgeLock.localFrame;
  const [anchorLongitude, anchorLatitude] = frame.anchorWgs84LonLatDegrees;
  const [metresPerDegreeLongitude, metresPerDegreeLatitude] = frame.metersPerDegreeLonLat;
  const lon = anchorLongitude + x / metresPerDegreeLongitude;
  const lat = anchorLatitude + z / metresPerDegreeLatitude;
  return { lonLatDegrees: [lon, lat], enMetres: genericForward(horizontalLock, lon, lat) };
}

function enToLocal(bridgeLock, horizontalLock, easting, northing) {
  const frame = bridgeLock.localFrame;
  const [lon, lat] = genericInverse(horizontalLock, easting, northing);
  const [anchorLongitude, anchorLatitude] = frame.anchorWgs84LonLatDegrees;
  const [metresPerDegreeLongitude, metresPerDegreeLatitude] = frame.metersPerDegreeLonLat;
  return { lonLatDegrees: [lon, lat], localEastNorthMetres: [(lon - anchorLongitude) * metresPerDegreeLongitude, (lat - anchorLatitude) * metresPerDegreeLatitude] };
}

export function bilinear3dep(parent, receipt, east, north) {
  const [width, height] = receipt.raster.dimensionsPixels;
  const [column0, row0] = [receipt.raster.nativePixelWindow.column, receipt.raster.nativePixelWindow.row];
  const [originX, originY] = [receipt.raster.affine.coefficients[2], receipt.raster.affine.coefficients[5]];
  // The parent affine locates PixelIsArea edges.  Each native value represents
  // its one-metre area, so its interpolation centre is edge + [0.5, -0.5].
  // This half-cell convention is explicit rather than silently conflating the
  // runtime contour-grid phase with the 3DEP pixel-area phase.
  const sourceColumnCenter = east - originX - 0.5;
  const sourceRowCenter = originY - north - 0.5;
  const column = sourceColumnCenter - column0;
  const row = sourceRowCenter - row0;
  const left = Math.floor(column); const top = Math.floor(row);
  const tx = column - left; const ty = row - top;
  const neighborCoordinates = [[left, top], [left + 1, top], [left, top + 1], [left + 1, top + 1]];
  const values = neighborCoordinates.map(([localColumn, localRow]) => {
    if (localColumn < 0 || localColumn >= width || localRow < 0 || localRow >= height) return null;
    const value = parent[localRow * width + localColumn];
    return Number.isFinite(value) && value !== receipt.raster.nodata ? value : null;
  });
  const neighbours = neighborCoordinates.map(([localColumn, localRow], index) => ({
    localColumn, localRow, nativeColumn: column0 + localColumn, nativeRow: row0 + localRow, valueMetres: values[index],
  }));
  if (values.some((value) => value === null)) {
    return { eligible: false, heightMetres: null, reason: 'outside-parent-or-nodata-neighbour', nativePixelIsAreaNeighbors: neighbours, fractionalPixelCenterCoordinates: [column, row] };
  }
  const [a, b, c, d] = values;
  return {
    eligible: true,
    heightMetres: (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty,
    reason: 'four-finite-non-nodata-pixelisarea-neighbours', nativePixelIsAreaNeighbors: neighbours,
    fractionalPixelCenterCoordinates: [column, row],
  };
}

function summary(records) {
  const valid = records.filter((record) => Number.isFinite(record.rawRuntimeMinus3depMetres));
  const deltas = valid.map((record) => record.rawRuntimeMinus3depMetres);
  return {
    recordCount: records.length,
    inspected3depCount: valid.length,
    unavailable3depCount: records.length - valid.length,
    rawRuntimeMinus3depMetres: deltas.length ? {
      min: Math.min(...deltas), max: Math.max(...deltas), mean: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
    } : null,
  };
}

function descriptiveConstantFit(records, sampleSet) {
  const valid = records.filter((record) => record.sampleSet === sampleSet && record.elevationBuilderBoundary0AllFour3depNeighbourCentersLand && record.threeDepEligible && Number.isFinite(record.rawRuntimeMinus3depMetres));
  const mean = valid.length ? valid.reduce((sum, record) => sum + record.rawRuntimeMinus3depMetres, 0) / valid.length : null;
  const rms = mean === null ? null : Math.sqrt(valid.reduce((sum, record) => sum + (record.rawRuntimeMinus3depMetres - mean) ** 2, 0) / valid.length);
  return {
    kind: 'leastSquaresDescriptiveOnly',
    population: `${sampleSet} only; records whose four finite, non-nodata PixelIsArea neighbours are all within elevation builder boundary[0]`,
    sampleSet,
    recordCount: valid.length,
    constantMetres: mean,
    rootMeanSquareResidualMetres: rms,
    appliedToRuntimeHeights: false,
    appliedTo3depHeights: false,
    verticalConversion: false,
    terrainAdjustment: false,
    note: 'This arithmetic describes this fixed offline sample set only. It is not a datum conversion, alignment, correction, or approved height adjustment.',
  };
}

function maskSummaries(records) {
  const queryPointLand = records.filter((record) => record.elevationBuilderBoundary0QueryPointLand);
  const strictFourNeighbourLand = records.filter((record) => record.elevationBuilderBoundary0AllFour3depNeighbourCentersLand);
  const waterOrOutside = records.filter((record) => !record.elevationBuilderBoundary0QueryPointLand);
  const nodata = records.filter((record) => !record.threeDepEligible);
  return {
    elevationBuilderBoundary0QueryPointLand: summary(queryPointLand),
    elevationBuilderBoundary0AllFour3depNeighbourCentersLand: summary(strictFourNeighbourLand),
    elevationBuilderBoundary0WaterOrOutsideQueryPoint: summary(waterOrOutside),
    nodataOrOutsideParent: summary(nodata),
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).includes(',') ? JSON.stringify(String(value)) : String(value);
}

function toCsv(records) {
  const headers = ['id', 'sampleSet', 'xMetres', 'zMetres', 'eastingMetres', 'northingMetres', 'runtimeHeightMetres', 'threeDepInspectedHeightMetres', 'threeDepEligible', 'threeDepReason', 'elevationBuilderBoundary0QueryPointLand', 'elevationBuilderBoundary0AllFour3depNeighbourCentersLand', 'elevationBuilderBoundary0LandMask', 'rawRuntimeMinus3depMetres'];
  const lines = [headers.join(',')];
  for (const record of records) lines.push(headers.map((header) => csvCell(record[header])).join(','));
  return `${lines.join('\n')}\n`;
}

function namedRoadMidpoint(city, id) {
  const road = (city.detailRoads || []).find((candidate) => Number(candidate.id) === id);
  assert(road, `pinned city snapshot is missing hero-streetscape road ${id}`);
  assert.equal(road.name, HERO_STREETSCAPE_ROAD_NAMES[id], `hero-streetscape road ${id} name drifted`);
  assert(Array.isArray(road.points) && road.points.length === 4 && road.points.every(Number.isFinite), `hero-streetscape road ${id} must remain one finite source segment`);
  return {
    xMetres: (road.points[0] + road.points[2]) / 2,
    zMetres: (road.points[1] + road.points[3]) / 2,
    namedSource: { kind: 'sf-city.detailRoads-segment-midpoint', id: road.id, name: road.name, selection: 'FERRY_BUILDING_STREETSCAPE_SOURCE.roadIds exact order' },
  };
}

function makeRecords({ elevation, city, parent, receipt, bridgeLock, horizontalLock, region }) {
  const ferryBuilding = (city.detailBuildings || []).find((candidate) => Number(candidate.id) === 558731934);
  assert(ferryBuilding && ferryBuilding.name === 'San Francisco Ferry Building', 'pinned city snapshot must contain Ferry Building way 558731934');
  assert.deepEqual(ferryBuilding.centroid, [2290.3, 1937.6], 'Ferry Building centroid source evidence drifted');
  const roads = HERO_STREETSCAPE_ROAD_IDS.map((id) => namedRoadMidpoint(city, id));
  const named = [
    { id: 'hero-launch', sampleSet: 'named', xMetres: region.liveRuntime.launchPositionMeters[0], zMetres: region.liveRuntime.launchPositionMeters[1], namedSource: { kind: 'region-liveRuntime-launchPositionMeters', id: region.id } },
    { id: 'ferry-clock-tower', sampleSet: 'named', xMetres: region.liveRuntime.landmarks[0].positionMeters[0], zMetres: region.liveRuntime.landmarks[0].positionMeters[1], namedSource: { kind: 'region-liveRuntime-landmarks[0]', id: region.liveRuntime.landmarks[0].id } },
    { id: 'ferry-building-centroid', sampleSet: 'named', xMetres: ferryBuilding.centroid[0], zMetres: ferryBuilding.centroid[1], namedSource: { kind: 'sf-city.detailBuildings-centroid', id: ferryBuilding.id, name: ferryBuilding.name } },
    ...roads.map((road) => ({ id: `hero-streetscape-road-${road.namedSource.id}-midpoint`, sampleSet: 'named', ...road })),
    { id: 'shoreline-land-probe', sampleSet: 'named', xMetres: 2380, zMetres: 1880, namedSource: { kind: 'pinned-hero-shoreline-verifier-land-probe', id: 'verify-hero-shoreline:2380,1880' } },
    { id: 'bay-water-probe', sampleSet: 'named', xMetres: 2400, zMetres: 1880, namedSource: { kind: 'pinned-hero-shoreline-verifier-bay-probe', id: 'verify-hero-shoreline:2400,1880' } },
  ];
  const canonical24 = [];
  for (let z = 1536, row = 0; z <= 2304; z += 24, row += 1) for (let x = 1920, column = 0; x <= 2688; x += 24, column += 1) canonical24.push({ id: `canonical-24m-${column}-${row}`, sampleSet: 'canonical-24m-2x2', xMetres: x, zMetres: z });
  const hero16 = [];
  for (let z = 1728, row = 0; z <= 2112; z += 16, row += 1) for (let x = 2144, column = 0; x <= 2528; x += 16, column += 1) hero16.push({ id: `hero-16m-${column}-${row}`, sampleSet: 'hero-16m', xMetres: x, zMetres: z });
  return [...named, ...canonical24, ...hero16].map((sample) => {
    const bridge = localToEn(bridgeLock, horizontalLock, sample.xMetres, sample.zMetres);
    const inspected = bilinear3dep(parent, receipt, ...bridge.enMetres);
    const runtimeHeightMetres = runtimeElevationAt(elevation, sample.xMetres, sample.zMetres);
    const threeDepInspectedHeightMetres = inspected.heightMetres;
    const neighboursWithLandMask = inspected.nativePixelIsAreaNeighbors.map((neighbour) => {
      const easting = receipt.raster.affine.coefficients[2] + neighbour.nativeColumn + 0.5;
      const northing = receipt.raster.affine.coefficients[5] - neighbour.nativeRow - 0.5;
      const inverse = enToLocal(bridgeLock, horizontalLock, easting, northing);
      return [
        neighbour.localColumn, neighbour.localRow, neighbour.nativeColumn, neighbour.nativeRow,
        neighbour.valueMetres, elevationBuilderBoundary0Land(city, ...inverse.localEastNorthMetres),
      ];
    });
    const elevationBuilderBoundary0QueryPointLand = elevationBuilderBoundary0Land(city, sample.xMetres, sample.zMetres);
    // This classification is deliberately independent of terrain eligibility:
    // a nodata or OOB elevation must not silently change a boundary predicate.
    const elevationBuilderBoundary0AllFour3depNeighbourCentersLand = neighboursWithLandMask.every((neighbour) => neighbour[5]);
    return {
      ...sample,
      eastingMetres: bridge.enMetres[0], northingMetres: bridge.enMetres[1], lonLatDegrees: bridge.lonLatDegrees,
      runtimeHeightMetres, threeDepInspectedHeightMetres, threeDepEligible: inspected.eligible, threeDepReason: inspected.reason,
      threeDepNativePixelIsAreaNeighbors: neighboursWithLandMask,
      threeDepFractionalPixelCenterCoordinates: inspected.fractionalPixelCenterCoordinates,
      elevationBuilderBoundary0QueryPointLand,
      elevationBuilderBoundary0AllFour3depNeighbourCentersLand,
      elevationBuilderBoundary0LandMask: elevationBuilderBoundary0QueryPointLand ? 'land' : 'water-or-outside',
      rawRuntimeMinus3depMetres: inspected.eligible ? runtimeHeightMetres - threeDepInspectedHeightMetres : null,
    };
  });
}

export async function buildSfFerryRuntimeVs3depOfflineDelta({ write = true, outputDir = OUTPUT_DIR } = {}) {
  const keys = Object.keys(PATHS);
  const inputs = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await readInput(key)])));
  const elevation = JSON.parse(inputs.elevation.bytes); const city = JSON.parse(inputs.city.bytes);
  const sourceLock = JSON.parse(inputs.sourceLock.bytes); const horizontalLock = JSON.parse(inputs.horizontalLock.bytes);
  const bridgeLock = JSON.parse(inputs.localBridgeLock.bytes); const verticalLock = JSON.parse(inputs.verticalContextLock.bytes);
  const receipt = JSON.parse(inputs.parentReceipt.bytes); const region = JSON.parse(inputs.region.bytes);
  const parent = decodeFloat32LittleEndian(inputs.parent.bytes);
  assert.equal(inputs.parent.byteLength, receipt.raster.byteLength, '3DEP parent byte length drifted from receipt');
  assert.equal(receipt.raster.sampleEncoding, 'float32-le', '3DEP parent receipt must declare float32 little-endian');
  assert.equal(receipt.raster.affine.rasterType, 'PixelIsArea', '3DEP parent receipt must retain PixelIsArea');
  assert.equal(receipt.raster.sampleCount, parent.length, '3DEP parent sample count drifted from receipt');
  assert.equal(receipt.raster.byteLength, receipt.raster.sampleCount * 4, '3DEP parent byte order/sample count contract drifted');
  assert.equal(inputs.parent.sha256, receipt.raster.sha256, '3DEP parent hash drifted from receipt');
  assert.equal(inputs.sourceLock.sha256, receipt.source.sourceLockSha256, '3DEP source lock hash drifted from receipt');
  assert.equal(inputs.horizontalLock.sha256, receipt.horizontalReference.lockSha256, '3DEP horizontal lock hash drifted from receipt');
  assert.equal(sourceLock.raster.sha256, receipt.source.lockedRawSha256, '3DEP raw hash claim drifted between lock and receipt');
  assert.equal(sourceLock.raster.sha256, receipt.source.actualRawSha256, '3DEP actual raw hash claim drifted between lock and receipt');
  assert.equal(sourceLock.raster.bytes, receipt.source.sourceBytes, '3DEP raw byte count claim drifted between lock and receipt');
  assert.equal(receipt.source.rawHashBytesRead, receipt.source.sourceBytes, '3DEP receipt did not hash the claimed raw byte count');
  assert.equal(verticalLock.id, 'sf-ferry-3dep-2023-vertical-water-reference-v1');
  assert.equal(region.id, 'sf-ferry-building-hero');
  assert.equal(elevation.grid.length, elevation.width * elevation.height, 'runtime elevation grid dimensions are inconsistent');
  assert(Buffer.from(gunzipSync(inputs.elevationGzip.bytes)).equals(inputs.elevation.bytes), 'runtime elevation gzip does not decompress to its pinned raw JSON');
  assert(Buffer.from(gunzipSync(inputs.cityGzip.bytes)).equals(inputs.city.bytes), 'city gzip does not decompress to its pinned raw JSON');
  assert(Array.isArray(city.boundary?.[0]) && city.boundary[0].length >= 6, 'elevation builder boundary[0] is unavailable');
  const elevationBuilderSource = inputs.elevationBuilder.bytes.toString('utf8');
  assert.match(inputs.heroStreetscape.bytes.toString('utf8'), /FERRY_BUILDING_STREETSCAPE_SOURCE[\s\S]*?roadIds:\s*Object\.freeze\(\[26769726, 88463826, 88463827, 88463831, 283512618, 850162147\]\)/, 'hero-streetscape source road set drifted');
  assert.match(inputs.heroShoreline.bytes.toString('utf8'), /sha256:\s*'a3023288edff7a91f84f20ca54fc55693b2f6a4fa4fb396807378f31be80f01d'/, 'hero shoreline source digest declaration drifted');
  assert.match(inputs.verifyHeroShoreline.bytes.toString('utf8'), /assert\.equal\(mask\.isLand\(2380, 1880\), true/, 'pinned shoreline land probe selection drifted');
  assert.match(inputs.verifyHeroShoreline.bytes.toString('utf8'), /assert\.equal\(mask\.isLand\(2400, 1880\), false/, 'pinned shoreline Bay probe selection drifted');
  assert.match(elevationBuilderSource, /const flatBoundary = boundary\[0\] \|\| \[\];/, 'elevation builder boundary[0] predicate drifted');
  assert.match(elevationBuilderSource, /const smooth = new Float64Array\(grid\);[\s\S]*?for \(let z = 1; z < height - 1; z \+= 1\)[\s\S]*?for \(let x = 1; x < width - 1; x \+= 1\)[\s\S]*?for \(let dz = -1; dz <= 1; dz \+= 1\)[\s\S]*?for \(let dx = -1; dx <= 1; dx \+= 1\)/, 'elevation builder interior 3x3 smoothing semantics drifted');
  assert.match(elevationBuilderSource, /Math\.round\(value \* 10\) \/ 10/, 'elevation builder 0.1 m rounding semantics drifted');
  for (const value of elevation.grid) {
    assert(Number.isFinite(value), 'loaded runtime elevation grid must be finite');
    assert(Math.abs(value * 10 - Math.round(value * 10)) <= 1e-9, 'loaded runtime elevation grid must remain 0.1 m quantized');
  }
  assert.match(inputs.runtimeMain.bytes.toString('utf8'), /function elevationAt\(x, z\)[\s\S]*?if \(cx < 0 \|\| cx >= width \|\| cz < 0 \|\| cz >= height\) return 0;[\s\S]*?return grid\[cz \* width \+ cx\] \|\| 0;[\s\S]*?return \(a \* \(1 - tx\) \+ b \* tx\) \* \(1 - tz\) \+ \(c \* \(1 - tx\) \+ d \* tx\) \* tz;/, 'runtime elevationAt behavior diverged from this diagnostic transcription');
  assert.equal(elevation.meta.source.sha256, inputs.contours.sha256, 'runtime elevation source metadata does not hash the supplied contours');
  const shorelineSource = sourceRecord(city, 'SF Shoreline and Islands (DataSF)');
  assert.equal(shorelineSource.sha256, inputs.shoreline.sha256, 'city shoreline source record does not hash supplied DataSF shoreline');
  assert.equal(bridgeLock.sourceEvidence.city.sha256, inputs.city.sha256, 'local bridge no longer locks this city snapshot');
  assert.equal(bridgeLock.sourceEvidence.horizontalOperation.sha256, inputs.horizontalLock.sha256, 'local bridge no longer locks this horizontal operation');
  assert.equal(bridgeLock.conversion.pointwiseOnly, true, 'local bridge must remain pointwise-only');
  assert.equal(bridgeLock.conversion.verticalBridge, false, 'local bridge must not create a vertical bridge');
  assert.equal(bridgeLock.conversion.runtimeUse, 'prohibited', 'local bridge must remain runtime-prohibited');
  assert.equal(bridgeLock.conversion.terrainManifestPromotion, 'prohibited', 'local bridge must remain manifest-prohibited');
  assert.deepEqual(bridgeLock.localFrame.axisOrder, ['east', 'north', 'up'], 'local bridge axes drifted');
  assert.deepEqual(elevation.meta.center, { lat: bridgeLock.localFrame.anchorWgs84LonLatDegrees[1], lon: bridgeLock.localFrame.anchorWgs84LonLatDegrees[0] }, 'runtime elevation and local bridge anchors differ');
  assert.deepEqual([elevation.meta.projection.metersPerDegreeLon, elevation.meta.projection.metersPerDegreeLat], bridgeLock.localFrame.metersPerDegreeLonLat, 'runtime elevation and local bridge scales differ');
  const [anchorLon, anchorLat] = bridgeLock.localFrame.anchorWgs84LonLatDegrees;
  assert.deepEqual(localToEn(bridgeLock, horizontalLock, 0, 0).lonLatDegrees, [anchorLon, anchorLat], 'local origin must map to bridge anchor');
  const eastAxis = localToEn(bridgeLock, horizontalLock, 1, 0).lonLatDegrees;
  const northAxis = localToEn(bridgeLock, horizontalLock, 0, 1).lonLatDegrees;
  assert(eastAxis[0] > anchorLon && eastAxis[1] === anchorLat, 'local east axis/sign must increase longitude only');
  assert(northAxis[1] > anchorLat && northAxis[0] === anchorLon, 'local north axis/sign must increase latitude only');
  const forwardVector = horizontalLock.testVectors.find((vector) => vector.id === 'ferry-grid-anchor');
  assert(forwardVector, 'horizontal lock Ferry forward vector is unavailable');
  const checkedEn = genericForward(horizontalLock, ...forwardVector.inputLonLatDegrees);
  assert(Math.abs(checkedEn[0] - forwardVector.forwardEnMetres[0]) <= 0.002 && Math.abs(checkedEn[1] - forwardVector.forwardEnMetres[1]) <= 0.002, 'generic horizontal forward vector drifted');
  assert.equal(horizontalLock.claims.operation.combinedAccuracyMetres, 4, 'this diagnostic must retain the generic 4 m operation limit');

  const records = makeRecords({ elevation, city, parent, receipt, bridgeLock, horizontalLock, region });
  const aggregateSummaries = maskSummaries(records);
  const bySampleSet = Object.fromEntries(['named', 'canonical-24m-2x2', 'hero-16m'].map((sampleSet) => [sampleSet, maskSummaries(records.filter((record) => record.sampleSet === sampleSet))]));
  const artifact = {
    schemaVersion: 1,
    kind: 'offline-runtime-versus-3dep-terrain-delta-diagnostic',
    id: ID,
    status: 'offline-diagnostic-not-for-runtime-manifest-rendering-water-collision-or-navigation',
    scope: {
      offline: true, runtime: 'not-used', manifest: 'not-used', rendering: 'not-used', water: 'not-used', collision: 'not-used', navigation: 'not-used',
      decision: 'diagnostic-only; no height is changed or approved by this artifact',
    },
    inputs: Object.fromEntries(keys.map((key) => [key, { path: inputs[key].path, sha256: inputs[key].sha256, byteLength: inputs[key].byteLength }])),
    runtimeSampler: {
      implementation: 'exact arithmetic transcription of src/realmap/main.js elevationAt asset-loaded branch',
      sourcePath: 'src/realmap/main.js',
      sourceSha256: inputs.runtimeMain.sha256,
      loadedAsset: { cellSizeMetres: elevation.cellSize, width: elevation.width, height: elevation.height, originXMetres: elevation.originX, originZMetres: elevation.originZ },
      sourceConstruction: 'build-sf-elevation.mjs rasterizes contour samples, applies one 3x3 interior smoothing pass, then rounds every emitted grid value to 0.1 m.',
      interpolation: 'bilinear over grid array indices at origin + integer-cell-size phase; not cell-centre shifted',
      falsyAndOutOfBounds: 'sample(cx,cz) returns 0 out of bounds; in bounds it returns grid[index] || 0, so JS-falsy values (including 0 and NaN) become 0. Bilinear interpolation can blend an in-bounds neighbour with an OOB zero.',
      phaseAmbiguity: 'The contour-grid builder assigns samples by floor((projected-origin)/cellSize) but its runtime sampler uses those indices directly as interpolation anchors. The source does not state whether the intended physical support is cell centres or corners; this diagnostic preserves runtime arithmetic and does not resolve that half-cell ambiguity.',
      elevationBuilderLandPredicate: 'build-sf-elevation.mjs uses only sf-city.json boundary[0] via flatBoundary = boundary[0] || []; this diagnostic mirrors that exact one-ring predicate for point and four-neighbour classifications.',
    },
    threeDepSampler: {
      artifact: 'checked-in parent f32le only; raw GeoTIFF is not opened',
      interpolation: 'bilinear only when all four surrounding native PixelIsArea parent samples are finite and not equal to nodata',
      pixelIsAreaConvention: 'parent affine denotes area edges; interpolation centres are affine edge coordinates plus [0.5 m east, -0.5 m north]',
      nativeNeighbourTupleOrder: ['parentLocalColumn', 'parentLocalRow', 'nativeColumn', 'nativeRow', 'valueMetres-or-null', 'elevationBuilderBoundary0LandAtPixelCentre'],
      nodata: receipt.raster.nodata,
      horizontalBridge: 'pointwise sf-atlas-linear-v1 → locked generic WGS84/NAD83 → EPSG:26910; retained 4 m generic operation limit',
    },
    limitations: [
      'The horizontal operation is generic and locked at 4 m; no realization, coordinate epoch, sub-metre, surveyed, or seamless-alignment claim is made.',
      'Runtime contour-grid 3x3 smoothing, 0.1 m rounding, and unresolved half-cell phase differ from 3DEP native one-metre PixelIsArea samples.',
      'No vertical transformation is applied. The vertical lock is contextual only; its station reference is 6.50 km away and must not be called a local Ferry tidal transfer.',
      '3DEP is bare earth, not a water surface, bathymetry, collision mesh, navigable surface, render mesh, or runtime terrain.',
      'Land/water-or-outside labels are only the elevation builder\'s first embedded DataSF-derived city boundary ring (`boundary[0]`), not a union shoreline predicate, 3DEP nodata, or hydrographic inference.',
    ],
    sampleSets: {
      named: {
        count: namedCount(records),
        points: records.filter((record) => record.sampleSet === 'named').map((record) => record.id),
        selection: {
          region: ['liveRuntime.launchPositionMeters', 'liveRuntime.landmarks[0]'],
          building: { collection: 'sf-city.detailBuildings', id: 558731934, field: 'centroid', expectedName: 'San Francisco Ferry Building' },
          roads: { collection: 'sf-city.detailRoads', ids: HERO_STREETSCAPE_ROAD_IDS, field: 'length-midpoint', sourcePath: PATHS.heroStreetscape, source: 'FERRY_BUILDING_STREETSCAPE_SOURCE.roadIds' },
          probes: { verifierPath: PATHS.verifyHeroShoreline, shorelineClassifierPath: PATHS.heroShoreline, points: ['verify-hero-shoreline:2380,1880', 'verify-hero-shoreline:2400,1880'] },
        },
      },
      canonical24m2x2: { boundsMetres: [1920, 1536, 2688, 2304], spacingMetres: 24, inclusiveDimensions: [33, 33], count: 1089 },
      hero16m: { boundsMetres: region.liveRuntime.localBoundsMeters, spacingMetres: 16, inclusiveDimensions: [25, 25], count: 625 },
    },
    records,
    summaries: { aggregate: aggregateSummaries, bySampleSet },
    leastSquaresDescriptiveOnly: {
      aggregate: null,
      named: null,
      canonical24m2x2: descriptiveConstantFit(records, 'canonical-24m-2x2'),
      hero16m: descriptiveConstantFit(records, 'hero-16m'),
      note: 'No aggregate or named fit is emitted: named points and the two grid densities overlap, so combining them would double-weight locations.',
    },
    csv: { path: path.posix.join('public/data/world/preview-artifacts', ID, CSV_NAME), columns: ['id', 'sampleSet', 'xMetres', 'zMetres', 'eastingMetres', 'northingMetres', 'runtimeHeightMetres', 'threeDepInspectedHeightMetres', 'threeDepEligible', 'threeDepReason', 'elevationBuilderBoundary0QueryPointLand', 'elevationBuilderBoundary0AllFour3depNeighbourCentersLand', 'elevationBuilderBoundary0LandMask', 'rawRuntimeMinus3depMetres'] },
  };
  const artifactBytes = jsonBytes(artifact); const csvBytes = Buffer.from(toCsv(records));
  if (write) {
    await mkdir(outputDir, { recursive: true });
    await Promise.all([writeFile(path.join(outputDir, JSON_NAME), artifactBytes), writeFile(path.join(outputDir, CSV_NAME), csvBytes)]);
  }
  return { artifact, artifactBytes, csvBytes };
}

function namedCount(records) { return records.filter((record) => record.sampleSet === 'named').length; }

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const { artifact, artifactBytes, csvBytes } = await buildSfFerryRuntimeVs3depOfflineDelta();
  process.stdout.write(`${JSON.stringify({ result: 'offline Ferry runtime-vs-3DEP delta diagnostic built', id: artifact.id, jsonSha256: sha256(artifactBytes), csvSha256: sha256(csvBytes), records: artifact.records.length, summaries: artifact.summaries, leastSquaresDescriptiveOnly: artifact.leastSquaresDescriptiveOnly }, null, 2)}\n`);
}
