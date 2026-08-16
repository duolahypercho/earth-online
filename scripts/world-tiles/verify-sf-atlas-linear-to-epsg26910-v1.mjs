/**
 * Verify the preview-only pointwise bridge from sf-atlas-linear-v1 to the
 * separately locked generic EPSG:26910 operation. This contains no terrain,
 * runtime, manifest-writing, or vertical-datum work.
 *
 * Usage: node scripts/world-tiles/verify-sf-atlas-linear-to-epsg26910-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_RELATIVE_PATH = 'public/data/world/source-locks/sf-ferry-sf-atlas-linear-to-epsg26910-v1.lock.json';
const LOCK_PATH = path.join(ROOT, LOCK_RELATIVE_PATH);
const lockBytes = readFileSync(LOCK_PATH);
const lock = JSON.parse(lockBytes);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const close = (actual, expected, tolerance, label) => assert(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}, tolerance ${tolerance}`);
const clone = (value) => JSON.parse(JSON.stringify(value));

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function readHash(relativePath) {
  return sha256(readFileSync(path.join(ROOT, relativePath)));
}

function assertVector(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, `${label} shape drifted`);
  actual.forEach((value, index) => close(value, expected[index], tolerance, `${label}[${index}]`));
}

function assertCanonicalManifestBounds(actual, computed, verification, pathPrefix, label) {
  assert.equal(actual.length, 4, `${label} shape drifted`);
  assert.equal(verification.canonicalDecimalPlaces, 13, 'Manifest canonical decimal precision drifted');
  assert.equal(verification.rawFormulaMaximumAbsoluteDeltaDegrees, 2e-14, 'Manifest raw formula maximum delta bound drifted');
  assert.equal(verification.allOtherComponentsRawExact, true, 'All non-exception manifest components must remain raw-exact');
  const permitted = new Map(verification.permittedNonzeroRawDeltas.map(({ path: receiptPath, actualMinusComputedDegrees }) => [receiptPath, actualMinusComputedDegrees]));
  return actual.map((value, index) => {
    assert.equal(value.toFixed(verification.canonicalDecimalPlaces), computed[index].toFixed(verification.canonicalDecimalPlaces), `${label}[${index}] must recompute exactly at canonical precision from local bounds`);
    const delta = value - computed[index];
    assert(Math.abs(delta) <= verification.rawFormulaMaximumAbsoluteDeltaDegrees, `${label}[${index}] raw IEEE-754 serialization delta exceeds the declared compatibility bound`);
    const receiptPath = `${pathPrefix}[${index}]`;
    if (permitted.has(receiptPath)) assert.equal(delta, permitted.get(receiptPath), `${receiptPath} must retain its exact permitted one-ULP serialization delta`);
    else assert.equal(delta, 0, `${receiptPath} must remain raw-exact; only named compatibility exceptions are permitted`);
    return { path: receiptPath, actualMinusComputedDegrees: delta };
  });
}

function forwardFromHorizontalLock(lonDegrees, latDegrees, horizontalLock) {
  const [, projection] = horizontalLock.claims.operation.authorityPath;
  const parameters = projection.parameters;
  const ellipsoid = projection.ellipsoidFromEpsg4269;
  const a = ellipsoid.semiMajorAxisMetres;
  const inverseFlattening = ellipsoid.inverseFlattening;
  const flattening = 1 / inverseFlattening;
  const e2 = flattening * (2 - flattening);
  const ep2 = e2 / (1 - e2);
  const deg = Math.PI / 180;
  const phi = latDegrees * deg;
  const lon0 = parameters.longitudeOfNaturalOriginDegrees * deg;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * sinPhi ** 2);
  const t = tanPhi ** 2;
  const c = ep2 * cosPhi ** 2;
  const aa = cosPhi * (lonDegrees * deg - lon0);
  const meridionalArc = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const easting = parameters.falseEastingMetres + parameters.scaleFactor * n * (aa
    + (1 - t + c) * aa ** 3 / 6
    + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120);
  const northing = parameters.falseNorthingMetres + parameters.scaleFactor * (meridionalArc + n * tanPhi * (aa ** 2 / 2
    + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24
    + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720));
  return [easting, northing];
}

function inverseFromHorizontalLock(easting, northing, horizontalLock) {
  const [, projection] = horizontalLock.claims.operation.authorityPath;
  const parameters = projection.parameters;
  const ellipsoid = projection.ellipsoidFromEpsg4269;
  const a = ellipsoid.semiMajorAxisMetres;
  const inverseFlattening = ellipsoid.inverseFlattening;
  const flattening = 1 / inverseFlattening;
  const e2 = flattening * (2 - flattening);
  const ep2 = e2 / (1 - e2);
  const deg = Math.PI / 180;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const m = (northing - parameters.falseNorthingMetres) / parameters.scaleFactor;
  const mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sinPhi1 ** 2);
  const r1 = a * (1 - e2) / (1 - e2 * sinPhi1 ** 2) ** 1.5;
  const t1 = tanPhi1 ** 2;
  const c1 = ep2 * cosPhi1 ** 2;
  const d = (easting - parameters.falseEastingMetres) / (n1 * parameters.scaleFactor);
  const latitude = phi1 - (n1 * tanPhi1 / r1) * (d ** 2 / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720);
  const longitude = parameters.longitudeOfNaturalOriginDegrees * deg + (d
    - (1 + 2 * t1 + c1) * d ** 3 / 6
    + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 **2) * d ** 5 / 120) / cosPhi1;
  return [longitude / deg, latitude / deg];
}

function localToLonLat([east, north], frame) {
  const [anchorLon, anchorLat] = frame.anchorWgs84LonLatDegrees;
  const [metresPerDegreeLon, metresPerDegreeLat] = frame.metersPerDegreeLonLat;
  return [anchorLon + east / metresPerDegreeLon, anchorLat + north / metresPerDegreeLat];
}

function lonLatToLocal([lon, lat], frame) {
  const [anchorLon, anchorLat] = frame.anchorWgs84LonLatDegrees;
  const [metresPerDegreeLon, metresPerDegreeLat] = frame.metersPerDegreeLonLat;
  return [(lon - anchorLon) * metresPerDegreeLon, (lat - anchorLat) * metresPerDegreeLat];
}

function localToEn(local, candidateLock, horizontalLock) {
  return forwardFromHorizontalLock(...localToLonLat(local, candidateLock.localFrame), horizontalLock);
}

function cornerPoints(bounds) {
  const [west, south, east, north] = bounds;
  return [[west, south], [east, south], [west, north], [east, north]];
}

function subtract(a, b) {
  return a.map((value, index) => value - b[index]);
}

function add(a, b) {
  return a.map((value, index) => value + b[index]);
}

function magnitude(vector) {
  return Math.hypot(...vector);
}

function gridConvergence(local, candidateLock, horizontalLock) {
  const base = localToEn(local, candidateLock, horizontalLock);
  const east = localToEn([local[0] + 1, local[1]], candidateLock, horizontalLock);
  const north = localToEn([local[0], local[1] + 1], candidateLock, horizontalLock);
  const eastStep = subtract(east, base);
  const northStep = subtract(north, base);
  const degrees = 180 / Math.PI;
  const angle = (vector) => Math.atan2(vector[1], vector[0]) * degrees;
  return {
    localEastNorthMetres: local,
    positiveEastGridAngleDegrees: angle(eastStep),
    positiveNorthGridAngleDegrees: angle(northStep),
    eastStepGridMetres: magnitude(eastStep),
    northStepGridMetres: magnitude(northStep),
    orthogonalityErrorDegrees: Math.abs((angle(northStep) - angle(eastStep)) - 90),
  };
}

function parallelogramEvidence(bounds, candidateLock, horizontalLock) {
  const [southwest, southeast, northwest, northeast] = cornerPoints(bounds).map((local) => localToEn(local, candidateLock, horizontalLock));
  const predictedNortheast = subtract(add(southeast, northwest), southwest);
  const parallelogramResidual = subtract(northeast, predictedNortheast);
  const closure = add(add(add(subtract(southeast, southwest), subtract(northeast, southeast)), subtract(northwest, northeast)), subtract(southwest, northwest));
  return { parallelogramResidual, closure };
}

function solve3(matrix, right) {
  const augmented = matrix.map((row, rowIndex) => [...row, right[rowIndex]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    assert(Math.abs(divisor) > 1e-12, 'Affine normal matrix became singular');
    for (let index = column; index < 4; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index < 4; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[3]);
}

function affineMaxResidual(bounds, candidateLock, horizontalLock) {
  const [west, south, east, north] = bounds;
  const center = [(west + east) / 2, (south + north) / 2];
  const halfSpan = [(east - west) / 2, (north - south) / 2];
  const samples = [];
  for (let xIndex = 0; xIndex <= 2; xIndex += 1) for (let zIndex = 0; zIndex <= 2; zIndex += 1) {
    const local = [west + (east - west) * xIndex / 2, south + (north - south) * zIndex / 2];
    samples.push({ local, basis: [1, (local[0] - center[0]) / halfSpan[0], (local[1] - center[1]) / halfSpan[1]], en: localToEn(local, candidateLock, horizontalLock) });
  }
  const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const easting = [0, 0, 0];
  const northing = [0, 0, 0];
  for (const sample of samples) for (let row = 0; row < 3; row += 1) {
    easting[row] += sample.basis[row] * sample.en[0];
    northing[row] += sample.basis[row] * sample.en[1];
    for (let column = 0; column < 3; column += 1) normal[row][column] += sample.basis[row] * sample.basis[column];
  }
  const eastingCoefficients = solve3(normal, easting);
  const northingCoefficients = solve3(normal, northing);
  return Math.max(...samples.map((sample) => magnitude([
    sample.en[0] - (eastingCoefficients[0] + eastingCoefficients[1] * sample.basis[1] + eastingCoefficients[2] * sample.basis[2]),
    sample.en[1] - (northingCoefficients[0] + northingCoefficients[1] * sample.basis[1] + northingCoefficients[2] * sample.basis[2]),
  ])));
}

function combinedEdgeLengths(bounds, candidateLock, horizontalLock) {
  const [southwest, southeast, northwest, northeast] = cornerPoints(bounds).map((local) => localToEn(local, candidateLock, horizontalLock));
  return {
    south: magnitude(subtract(southeast, southwest)),
    east: magnitude(subtract(northeast, southeast)),
    north: magnitude(subtract(northeast, northwest)),
    west: magnitude(subtract(northwest, southwest)),
  };
}

function validate(candidateLock, { checkExternalHashes = true } = {}) {
  assert.equal(candidateLock.schemaVersion, 1, 'Unsupported local-frame bridge schema');
  assert.equal(candidateLock.kind, 'earth-preview-local-frame-bridge-lock', 'Unexpected bridge lock kind');
  assert.equal(candidateLock.status, 'preview-only-pointwise-conversion-not-for-runtime', 'Bridge must remain preview-only');
  assert.equal(candidateLock.id, 'sf-ferry-sf-atlas-linear-to-epsg26910-v1', 'Bridge lock identity drifted');
  assert.match(candidateLock.scope, /not a surveyed control transformation/, 'Scope must prohibit a survey-control interpretation');
  assert.match(candidateLock.scope, /not a rectilinear UTM tile grid/, 'Scope must prohibit a rectilinear-grid interpretation');
  assert.deepEqual(candidateLock.localFrame.axisOrder, ['east', 'north', 'up'], 'Local axis order drifted');
  assert.deepEqual(candidateLock.localFrame.anchorWgs84LonLatDegrees, [-122.4194, 37.778], 'Local anchor drifted');
  assert.deepEqual(candidateLock.localFrame.metersPerDegreeLonLat, [87986.24747640654, 110574], 'Local scales drifted');
  assert.equal(candidateLock.localFrame.formula.longitudeDegrees, 'anchorLongitudeDegrees + localEastMetres / metersPerDegreeLongitude', 'Longitude formula drifted');
  assert.equal(candidateLock.localFrame.formula.latitudeDegrees, 'anchorLatitudeDegrees + localNorthMetres / metersPerDegreeLatitude', 'Latitude formula drifted');
  assert.equal(candidateLock.localFrame.formula.localEastMetres, '(longitudeDegrees - anchorLongitudeDegrees) * metersPerDegreeLongitude', 'Inverse east formula drifted');
  assert.equal(candidateLock.localFrame.formula.localNorthMetres, '(latitudeDegrees - anchorLatitudeDegrees) * metersPerDegreeLatitude', 'Inverse north formula drifted');
  assert.deepEqual(candidateLock.localFrame.runtimeHorizontalConvention, {
    runtimeAxes: { x: 'east', z: 'north', y: 'height-excluded' },
    bridgeInput: 'runtime [x, z] is local [east, north] in metres',
    bridgeOutput: 'runtime [x, z] is local [east, north] in metres',
    verticalInputOrOutput: false,
  }, 'Runtime horizontal convention or vertical exclusion drifted');
  assert.deepEqual(candidateLock.conversion.pipeline, ['sf-atlas-linear-v1 local [east, north] metres', 'linear local-to-[longitude, latitude] degrees', 'sf-ferry-3dep-2023-horizontal-crs-v1 generic WGS84-to-EPSG:26910 [easting, northing] metres'], 'Pipeline drifted');
  assert.deepEqual(candidateLock.conversion.inversePipeline, ['sf-ferry-3dep-2023-horizontal-crs-v1 generic EPSG:26910 [easting, northing] to WGS84 [longitude, latitude] degrees', 'linear [longitude, latitude]-to-local [east, north] metres'], 'Inverse pipeline drifted');
  assert.equal(candidateLock.conversion.direction, 'bidirectional-pointwise-preview-only', 'Bridge direction drifted');
  assert.equal(candidateLock.conversion.pointwiseOnly, true, 'Bridge must remain pointwise-only');
  assert.equal(candidateLock.conversion.isRectilinearUtmGrid, false, 'Bridge must explicitly reject a rectilinear UTM grid');
  assert.equal(candidateLock.conversion.verticalBridge, false, 'Bridge must make no vertical connection');
  assert.equal(candidateLock.conversion.runtimeUse, 'prohibited', 'Bridge must not authorize runtime use');
  assert.equal(candidateLock.conversion.terrainManifestPromotion, 'prohibited', 'Bridge must not authorize manifest promotion');
  assert.equal(candidateLock.conversion.surveyControl, 'not established', 'Bridge must not claim surveyed control');
  assert.equal(candidateLock.conversion.subMetreClaim, false, 'Bridge must not make a sub-metre claim');
  assert.equal(candidateLock.sourceEvidence.horizontalOperation.targetCrs, 'EPSG:26910', 'Target CRS drifted');
  assert.equal(candidateLock.sourceEvidence.horizontalOperation.combinedAccuracyMetres, 4, 'Generic horizontal accuracy drifted');
  assert.deepEqual(candidateLock.sourceEvidence.manifestWgsBoundsVerification.permittedNonzeroRawDeltas, [
    { path: 'sf-local-6-5.grid.wgs84Bounds[2]', actualMinusComputedDegrees: 1.4210854715202004e-14 },
    { path: 'sf-local-6-5.grid.wgs84BuildBounds[2]', actualMinusComputedDegrees: 1.4210854715202004e-14 },
  ], 'Permitted raw manifest serialization exceptions drifted');
  assert.match(candidateLock.sourceEvidence.manifestWgsBoundsVerification.interpretation, /serialization-only/, 'Raw manifest delta must remain serialization-only');
  assert.match(candidateLock.sourceEvidence.manifestWgsBoundsVerification.interpretation, /not a spatial-accuracy allowance/, 'Raw manifest delta must not become an accuracy allowance');

  const horizontalLock = readJson(candidateLock.sourceEvidence.horizontalOperation.path);
  assert.equal(readHash(candidateLock.sourceEvidence.horizontalOperation.path), candidateLock.sourceEvidence.horizontalOperation.sha256, 'Horizontal-lock receipt hash drifted');
  assert.equal(horizontalLock.id, 'sf-ferry-3dep-2023-horizontal-crs-v1', 'Referenced horizontal lock identity drifted');
  assert.equal(horizontalLock.claims.target.crs, 'EPSG:26910', 'Referenced target CRS drifted');
  assert.equal(horizontalLock.claims.operation.combinedAccuracyMetres, 4, 'Referenced generic horizontal accuracy drifted');
  assert.match(horizontalLock.claims.operation.normalizedEnInversePipeline, /^\+proj=pipeline \+step \+inv \+proj=utm \+zone=10 \+ellps=GRS80/, 'Referenced generic horizontal inverse path drifted');

  if (checkExternalHashes) {
    assert.equal(readHash(candidateLock.sourceEvidence.atlas.path), candidateLock.sourceEvidence.atlas.sha256, 'sf-atlas receipt hash drifted');
    assert.equal(readHash(candidateLock.sourceEvidence.city.path), candidateLock.sourceEvidence.city.sha256, 'sf-city receipt hash drifted');
    assert.equal(readHash(candidateLock.sourceEvidence.cityGzip.path), candidateLock.sourceEvidence.cityGzip.sha256, 'sf-city gzip receipt hash drifted');
  }
  const atlas = readJson(candidateLock.sourceEvidence.atlas.path);
  const city = readJson(candidateLock.sourceEvidence.city.path);
  assert.deepEqual([atlas.meta.center.lon, atlas.meta.center.lat], candidateLock.sourceEvidence.atlas.meta.centerLonLatDegrees, 'sf-atlas anchor evidence drifted');
  assert.deepEqual([atlas.meta.projection.metersPerDegreeLon, atlas.meta.projection.metersPerDegreeLat], candidateLock.sourceEvidence.atlas.meta.metersPerDegreeLonLat, 'sf-atlas scale evidence drifted');
  assert.deepEqual([city.meta.center.lon, city.meta.center.lat], candidateLock.sourceEvidence.city.meta.centerLonLatDegrees, 'sf-city anchor evidence drifted');
  assert.deepEqual([city.meta.projection.metersPerDegreeLon, city.meta.projection.metersPerDegreeLat], candidateLock.sourceEvidence.city.meta.metersPerDegreeLonLat, 'sf-city scale evidence drifted');
  assert.equal(city.meta.sources[0].sha256, candidateLock.sourceEvidence.city.meta.atlasArtifactDeclaredSha256, 'sf-city derived atlas-artifact receipt drifted');
  assert.equal(candidateLock.sourceEvidence.city.meta.atlasArtifactDeclaredSha256, candidateLock.sourceEvidence.atlas.sha256, 'sf-city declared atlas-artifact receipt must match the pinned sf-atlas artifact');
  assert.match(candidateLock.sourceEvidence.city.meta.atlasArtifactDeclarationNote, /digestFile\(ATLAS_PATH\)/, 'sf-city atlas-artifact provenance note drifted');
  assert(gunzipSync(readFileSync(path.join(ROOT, candidateLock.sourceEvidence.cityGzip.path))).equals(readFileSync(path.join(ROOT, candidateLock.sourceEvidence.city.path))), 'sf-city gzip must decompress to byte-identical raw sf-city JSON');
  const buildRealmapSource = readFileSync(path.join(ROOT, 'scripts/build-realmap-assets.mjs'), 'utf8');
  const buildAtlasSource = readFileSync(path.join(ROOT, 'scripts/build-sf-atlas.mjs'), 'utf8');
  assert.match(buildRealmapSource, /function round1\(value\)\s*\{\s*return Math\.round\(value \* 10\) \/ 10;/s, 'sf-city 0.1 m horizontal-coordinate quantization source drifted');
  assert.match(buildRealmapSource, /points: flatPoints\(simplify\(road\.points, 3\.2\)\)/, 'sf-city ordinary-road simplification source drifted');
  assert.match(buildAtlasSource, /record\.points = simplify\(record\.points, 2\.5\);/, 'sf-atlas ordinary-road simplification source drifted');
  assert.match(buildAtlasSource, /detailRecord\.points = simplify\(detailRecord\.points, 1\.2\);/, 'sf-atlas detail-road simplification source drifted');
  assert.deepEqual(candidateLock.geometryPrecisionDebt, {
    sfCityHorizontalCoordinateQuantizationMetres: 0.1,
    atlasRoadSimplificationMetres: { ordinaryRoads: 2.5, detailRoads: 1.2 },
    sfCityRoadSimplificationMetres: { ordinaryRoads: 3.2 },
    recovery: 'The bridge cannot recover original OSM geometry, pre-simplification atlas geometry, survey control, or any precision removed by sf-city 0.1 m quantization and road simplification.',
  }, 'Geometry precision debt drifted');
  for (const road of [...city.roads, ...city.detailRoads]) for (const coordinate of road.points) close(coordinate * 10, Math.round(coordinate * 10), 1e-9, 'sf-city horizontal coordinate must remain 0.1 m quantized');

  const expectedIds = ['sf-local-5-4', 'sf-local-5-5', 'sf-local-6-4', 'sf-local-6-5'];
  assert.deepEqual(candidateLock.plannedTiles.map(({ id }) => id), expectedIds, 'Planned 2x2 tile order drifted');
  assert.deepEqual(candidateLock.sourceEvidence.plannedManifests.map(({ id }) => id), expectedIds, 'Planned manifest order drifted');
  const rawManifestDeltas = [];
  for (const receipt of candidateLock.sourceEvidence.plannedManifests) {
    if (checkExternalHashes) assert.equal(readHash(receipt.path), receipt.sha256, `${receipt.id} manifest receipt hash drifted`);
    const manifest = readJson(receipt.path);
    const tile = candidateLock.plannedTiles.find(({ id }) => id === receipt.id);
    assert.equal(manifest.id, receipt.id, `${receipt.id} manifest identity drifted`);
    assert.equal(manifest.grid.localFrame.name, candidateLock.localFrame.name, `${receipt.id} frame name drifted`);
    assert.deepEqual(manifest.grid.localFrame.axisOrder, candidateLock.localFrame.axisOrder, `${receipt.id} frame axes drifted`);
    assert.deepEqual(manifest.grid.localFrame.anchorWgs84, [...candidateLock.localFrame.anchorWgs84LonLatDegrees, 0], `${receipt.id} frame anchor drifted`);
    assert.deepEqual(manifest.grid.localFrame.metersPerDegree, candidateLock.localFrame.metersPerDegreeLonLat, `${receipt.id} frame scale drifted`);
    const [minEast, minNorth, maxEast, maxNorth] = manifest.grid.localBoundsMeters;
    const [buildMinEast, buildMinNorth, buildMaxEast, buildMaxNorth] = manifest.grid.localBuildBoundsMeters;
    const wgsBounds = [...localToLonLat([minEast, minNorth], candidateLock.localFrame), ...localToLonLat([maxEast, maxNorth], candidateLock.localFrame)];
    const wgsBuildBounds = [...localToLonLat([buildMinEast, buildMinNorth], candidateLock.localFrame), ...localToLonLat([buildMaxEast, buildMaxNorth], candidateLock.localFrame)];
    rawManifestDeltas.push(...assertCanonicalManifestBounds(manifest.grid.wgs84Bounds, wgsBounds, candidateLock.sourceEvidence.manifestWgsBoundsVerification, `${receipt.id}.grid.wgs84Bounds`, `${receipt.id} WGS bounds`));
    rawManifestDeltas.push(...assertCanonicalManifestBounds(manifest.grid.wgs84BuildBounds, wgsBuildBounds, candidateLock.sourceEvidence.manifestWgsBoundsVerification, `${receipt.id}.grid.wgs84BuildBounds`, `${receipt.id} WGS build bounds`));
    assert.deepEqual(manifest.world.wgs84Anchor, [...localToLonLat(manifest.grid.localOriginMeters.slice(0, 2), candidateLock.localFrame), 0], `${receipt.id} world anchor must recompute from local origin`);
    const expectedCore = cornerPoints(manifest.grid.localBoundsMeters);
    const expectedBuffer = cornerPoints(manifest.grid.localBuildBoundsMeters);
    for (const [type, expectedLocals] of [['coreCorners', expectedCore], ['buildBufferCorners', expectedBuffer]]) {
      const points = tile[type];
      assert.deepEqual(points.map(({ id }) => id), ['southwest', 'southeast', 'northwest', 'northeast'], `${receipt.id} ${type} order drifted`);
      assert.equal(points.length, 4, `${receipt.id} must record every ${type} point`);
      points.forEach((point, index) => {
        assert.deepEqual(point.localEastNorthMetres, expectedLocals[index], `${receipt.id} ${type} local corner drifted`);
        const lonLat = localToLonLat(point.localEastNorthMetres, candidateLock.localFrame);
        const en = forwardFromHorizontalLock(...lonLat, horizontalLock);
        const localRoundTrip = lonLatToLocal(lonLat, candidateLock.localFrame);
        const inverseLonLat = inverseFromHorizontalLock(...en, horizontalLock);
        const inverseLocalRoundTrip = lonLatToLocal(inverseLonLat, candidateLock.localFrame);
        assertVector(point.lonLatDegrees, lonLat, 1e-13, `${receipt.id} ${type} local-to-WGS vector`);
        assertVector(point.epsg26910EnMetres, en, 1e-7, `${receipt.id} ${type} WGS-to-EPSG26910 vector`);
        assertVector(localRoundTrip, point.localEastNorthMetres, 1e-8, `${receipt.id} ${type} local-linear inverse round trip`);
        assertVector(inverseLonLat, point.lonLatDegrees, 2e-9, `${receipt.id} ${type} generic horizontal inverse round trip`);
        assertVector(inverseLocalRoundTrip, point.localEastNorthMetres, 0.001, `${receipt.id} ${type} generic horizontal-to-local inverse round trip`);
      });
    }
  }
  assert.deepEqual(rawManifestDeltas.filter(({ actualMinusComputedDegrees }) => actualMinusComputedDegrees !== 0), [
    { path: 'sf-local-6-5.grid.wgs84Bounds[2]', actualMinusComputedDegrees: 1.4210854715202004e-14 },
    { path: 'sf-local-6-5.grid.wgs84BuildBounds[2]', actualMinusComputedDegrees: 1.4210854715202004e-14 },
  ], 'Exactly the two documented raw manifest serialization deltas must remain non-zero');

  const numerical = candidateLock.numericalEvidence;
  const coreBounds = numerical.combinedCoreBoundsEastNorthMetres;
  const buildBounds = numerical.combinedBuildBufferBoundsEastNorthMetres;
  assert.deepEqual(coreBounds, [1920, 1536, 2688, 2304], 'Combined core bounds drifted');
  assert.deepEqual(buildBounds, [1904, 1520, 2704, 2320], 'Combined build-buffer bounds drifted');
  const convergencePoints = cornerPoints(coreBounds);
  assert.equal(numerical.gridConvergenceAtCoreCorners.length, 4, 'Grid convergence must cover all combined core corners');
  numerical.gridConvergenceAtCoreCorners.forEach((record, index) => {
    const computed = gridConvergence(convergencePoints[index], candidateLock, horizontalLock);
    assert.deepEqual(record.localEastNorthMetres, computed.localEastNorthMetres, 'Convergence local sample drifted');
    for (const key of ['positiveEastGridAngleDegrees', 'positiveNorthGridAngleDegrees', 'eastStepGridMetres', 'northStepGridMetres', 'orthogonalityErrorDegrees']) close(record[key], computed[key], 1e-9, `Convergence ${key}`);
  });
  const coreEvidence = parallelogramEvidence(coreBounds, candidateLock, horizontalLock);
  const buildEvidence = parallelogramEvidence(buildBounds, candidateLock, horizontalLock);
  assertVector(numerical.nonRectilinearity.coreParallelogramResidualEnMetres, coreEvidence.parallelogramResidual, 1e-8, 'Core parallelogram residual');
  close(numerical.nonRectilinearity.coreParallelogramResidualMagnitudeMetres, magnitude(coreEvidence.parallelogramResidual), 1e-8, 'Core parallelogram residual magnitude');
  assertVector(numerical.nonRectilinearity.buildBufferParallelogramResidualEnMetres, buildEvidence.parallelogramResidual, 1e-8, 'Build-buffer parallelogram residual');
  close(numerical.nonRectilinearity.buildBufferParallelogramResidualMagnitudeMetres, magnitude(buildEvidence.parallelogramResidual), 1e-8, 'Build-buffer parallelogram residual magnitude');
  assert(numerical.nonRectilinearity.coreParallelogramResidualMagnitudeMetres > 0, 'Non-rectilinearity evidence must remain non-zero');
  assert(numerical.nonRectilinearity.buildBufferParallelogramResidualMagnitudeMetres > 0, 'Build-buffer non-rectilinearity evidence must remain non-zero');
  assertVector(numerical.closure.coreResidualEnMetres, coreEvidence.closure, 1e-12, 'Core perimeter closure');
  assertVector(numerical.closure.buildBufferResidualEnMetres, buildEvidence.closure, 1e-12, 'Build-buffer perimeter closure');
  close(numerical.affineResidual.coreMaxResidualMagnitudeMetres, affineMaxResidual(coreBounds, candidateLock, horizontalLock), 1e-8, 'Core affine max residual');
  close(numerical.affineResidual.buildBufferMaxResidualMagnitudeMetres, affineMaxResidual(buildBounds, candidateLock, horizontalLock), 1e-8, 'Build-buffer affine max residual');
  assert(numerical.affineResidual.coreMaxResidualMagnitudeMetres > 0, 'Core affine residual must remain non-zero');
  assert(numerical.affineResidual.buildBufferMaxResidualMagnitudeMetres > 0, 'Build-buffer affine residual must remain non-zero');
  assert.deepEqual(numerical.combinedProjectedEdgeLengthsMetres, {
    method: 'Straight-line Euclidean lengths between consecutive pointwise generic EPSG:26910 corner vectors in the order south, east, north, west. They evidence non-rectilinearity and are not survey distances.',
    core: combinedEdgeLengths(coreBounds, candidateLock, horizontalLock),
    buildBuffer: combinedEdgeLengths(buildBounds, candidateLock, horizontalLock),
  }, 'Combined projected edge-length evidence drifted');
}

validate(lock);

const adversarialCases = [
  ['axis-order', (candidate) => { candidate.localFrame.axisOrder = ['north', 'east', 'up']; }],
  ['longitude-sign-formula', (candidate) => { candidate.localFrame.formula.longitudeDegrees = 'anchorLongitudeDegrees - localEastMetres / metersPerDegreeLongitude'; }],
  ['anchor', (candidate) => { candidate.localFrame.anchorWgs84LonLatDegrees[0] += 0.000001; }],
  ['scale', (candidate) => { candidate.localFrame.metersPerDegreeLonLat[0] += 1; }],
  ['rectilinear-promotion', (candidate) => { candidate.conversion.isRectilinearUtmGrid = true; }],
];
for (const [name, mutate] of adversarialCases) {
  const candidate = clone(lock);
  mutate(candidate);
  assert.throws(() => validate(candidate, { checkExternalHashes: false }), undefined, `Adversarial ${name} drift must be rejected`);
}
assert.throws(() => assertCanonicalManifestBounds(
  [-122.39757840793227, 37.79189114981822, -122.39321408951872 + 1e-10, 37.795363937272775],
  [-122.39757840793227, 37.79189114981822, -122.39321408951872, 37.795363937272775],
  lock.sourceEvidence.manifestWgsBoundsVerification,
  'sf-local-5-4.grid.wgs84Bounds',
  'Adversarial manifest bounds',
), undefined, 'Raw manifest-bound drift beyond the declared serialization allowance must be rejected');
assert.throws(() => assertCanonicalManifestBounds(
  [-122.39757840793227, 37.79189114981822, -122.39321408951872 + 1.4210854715202004e-14, 37.795363937272775],
  [-122.39757840793227, 37.79189114981822, -122.39321408951872, 37.795363937272775],
  lock.sourceEvidence.manifestWgsBoundsVerification,
  'sf-local-5-4.grid.wgs84Bounds',
  'Adversarial unpermitted one-ULP manifest bounds',
), undefined, 'An unpermitted one-ULP manifest-bound drift must be rejected');

process.stdout.write(`${JSON.stringify({
  result: 'sf-atlas-linear-v1 to generic EPSG:26910 preview bridge lock passed',
  lockSha256: sha256(lockBytes),
  pointwiseOnly: lock.conversion.pointwiseOnly,
  rectilinearUtmGrid: lock.conversion.isRectilinearUtmGrid,
  horizontalAccuracyMetres: lock.sourceEvidence.horizontalOperation.combinedAccuracyMetres,
  plannedTiles: lock.plannedTiles.map(({ id }) => id),
  nonRectilinearityMetres: lock.numericalEvidence.nonRectilinearity.coreParallelogramResidualMagnitudeMetres,
  affineResidualMetres: lock.numericalEvidence.affineResidual.coreMaxResidualMagnitudeMetres,
  adversarialCases: adversarialCases.map(([name]) => name),
}, null, 2)}\n`);
