/**
 * Verify the narrowly scoped, generic horizontal CRS lock for the Ferry 3DEP
 * GeoTIFF. This deliberately contains no terrain sampling or vertical work.
 *
 * Usage: node scripts/world-tiles/verify-ferry-3dep-horizontal-crs-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json');
const SOURCE_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const lockBytes = readFileSync(LOCK_PATH);
const lock = JSON.parse(lockBytes);
const sourceLock = JSON.parse(readFileSync(SOURCE_LOCK_PATH, 'utf8'));

const operation = lock.claims?.operation;
const [datumOperation, projectionOperation] = operation?.authorityPath || [];
const projectionParameters = projectionOperation?.parameters;
const ellipsoid = projectionOperation?.ellipsoidFromEpsg4269;
const A = ellipsoid?.semiMajorAxisMetres;
const INV_F = ellipsoid?.inverseFlattening;
const F = 1 / INV_F;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = projectionParameters?.scaleFactor;
const LON0 = projectionParameters?.longitudeOfNaturalOriginDegrees * Math.PI / 180;
const FALSE_EASTING = projectionParameters?.falseEastingMetres;
const FALSE_NORTHING = projectionParameters?.falseNorthingMetres;
const DEG = Math.PI / 180;

function meridionalArc(latitudeRadians) {
  return A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * latitudeRadians
    - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * latitudeRadians)
    + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * latitudeRadians)
    - (35 * E2 ** 3 / 3072) * Math.sin(6 * latitudeRadians));
}

function forward(lonDegrees, latDegrees) {
  const phi = latDegrees * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * sinPhi ** 2);
  const t = tanPhi ** 2;
  const c = EP2 * cosPhi ** 2;
  const aa = cosPhi * (lonDegrees * DEG - LON0);
  const m = meridionalArc(phi);
  const easting = FALSE_EASTING + K0 * n * (aa
    + (1 - t + c) * aa ** 3 / 6
    + (5 - 18 * t + t ** 2 + 72 * c - 58 * EP2) * aa ** 5 / 120);
  const northing = FALSE_NORTHING + K0 * (m + n * tanPhi * (aa ** 2 / 2
    + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24
    + (61 - 58 * t + t ** 2 + 600 * c - 330 * EP2) * aa ** 6 / 720));
  return [easting, northing];
}

function inverse(easting, northing) {
  const m = (northing - FALSE_NORTHING) / K0;
  const mu = m / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const n1 = A / Math.sqrt(1 - E2 * sinPhi1 ** 2);
  const r1 = A * (1 - E2) / (1 - E2 * sinPhi1 ** 2) ** 1.5;
  const t1 = tanPhi1 ** 2;
  const c1 = EP2 * cosPhi1 ** 2;
  const d = (easting - FALSE_EASTING) / (n1 * K0);
  const latitude = phi1 - (n1 * tanPhi1 / r1) * (d ** 2 / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) * d ** 6 / 720);
  const longitude = LON0 + (d
    - (1 + 2 * t1 + c1) * d ** 3 / 6
    + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5 / 120) / cosPhi1;
  return [longitude / DEG, latitude / DEG];
}

function close(actual, expected, tolerance, label) {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}, tolerance ${tolerance}`);
}

assert.equal(lock.schemaVersion, 1, 'Unsupported horizontal CRS lock schema');
assert.equal(lock.kind, 'earth-horizontal-crs-source-lock', 'Unexpected horizontal CRS lock kind');
assert.equal(lock.status, 'source-locked-generic-operation-only', 'Lock must remain generic-only');
assert.equal(lock.id, 'sf-ferry-3dep-2023-horizontal-crs-v1', 'Horizontal CRS lock identity drifted');
assert.match(lock.scope, /normalized OSM-style \[longitude, latitude\]/, 'Scope must state normalized OSM data order');
assert.match(lock.scope, /EPSG:4326's official CRS axis order remains \[latitude, longitude\]/, 'Scope must distinguish EPSG axis order');
assert.equal(lock.sourceEvidence.lockedGeoTiff.sha256, sourceLock.raster.sha256, 'GeoTIFF hash must match the parent source lock');
assert.equal(lock.sourceEvidence.usgsProductXml.sha256, sourceLock.source.productMetadataSha256, 'USGS XML hash must match the parent source lock');
assert.equal(lock.sourceEvidence.scienceBase.sha256, sourceLock.source.sciencebaseJsonSha256, 'ScienceBase hash must match the parent source lock');
assert.equal(lock.sourceEvidence.lockedGeoTiff.sourceLock, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json', 'Parent source-lock path drifted');
assert.deepEqual(lock.sourceEvidence.lockedGeoTiff.exactGeoKeys, { ProjectedCSTypeGeoKey: 26910, ProjLinearUnitsGeoKey: 9001 }, 'GeoTIFF GeoKeys drifted');
assert.equal(lock.sourceEvidence.usgsProductXml.exactHorizontalDeclaration, 'NAD83 / UTM zone 10N', 'USGS horizontal declaration drifted');
assert.match(lock.sourceEvidence.usgsProductXml.url, /^https:\/\/thor-f5\.er\.usgs\.gov\//, 'USGS product XML URL drifted');
assert.match(lock.sourceEvidence.scienceBase.url, /^https:\/\/www\.sciencebase\.gov\/catalog\/item\/66ce871ad34e98e8a92453cb\?format=json$/, 'ScienceBase URL drifted');
assert.deepEqual(lock.sourceEvidence.metadataLimits, {
  nad83Realization: 'not specified by the GeoTIFF GeoKeys, USGS product XML, or ScienceBase item',
  coordinateEpoch: 'not specified by the GeoTIFF GeoKeys, USGS product XML, or ScienceBase item',
  wgs84RealizationOrEpochForOsmCoordinates: "not specified by the repository's WGS84/OSM coordinate inputs",
}, 'Metadata limits must remain explicit');
assert.equal(lock.claims.input.crs, 'EPSG:4326', 'Input must remain EPSG:4326');
assert.equal(lock.claims.input.name, 'WGS 84 ensemble', 'Input CRS name drifted');
assert.deepEqual(lock.claims.input.officialCrsAxisOrder, ['latitude', 'longitude'], 'EPSG:4326 official axes drifted');
assert.deepEqual(lock.claims.input.normalizedDataOrder, ['longitude', 'latitude'], 'OSM data order drifted');
assert.equal(lock.claims.input.units, 'degree', 'Input units drifted');
assert.equal(lock.claims.input.realization, 'not claimed', 'Input realization must not be inferred');
assert.equal(lock.claims.input.coordinateEpoch, 'not claimed', 'Input coordinate epoch must not be inferred');
assert.equal(lock.claims.target.crs, 'EPSG:26910', 'Target must remain EPSG:26910');
assert.equal(lock.claims.target.name, 'NAD83 / UTM zone 10N', 'Target CRS name drifted');
assert.equal(lock.claims.target.baseCrs, 'EPSG:4269 NAD83', 'Target base CRS drifted');
assert.deepEqual(lock.claims.target.officialCrsAxisOrder, ['easting', 'northing'], 'Target official axes drifted');
assert.deepEqual(lock.claims.target.normalizedDataOrder, ['easting', 'northing'], 'Target data order drifted');
assert.equal(lock.claims.target.units, 'metre', 'Target units drifted');
assert.equal(lock.claims.target.areaOfUse.name, 'North America - 126°W to 120°W and NAD83 by country', 'EPSG:26910 area name drifted');
assert.deepEqual(lock.claims.target.areaOfUse.bboxWgs84, [-126, 30.54, -119.99, 81.8], 'EPSG:26910 area of use drifted');
assert.equal(lock.claims.target.nad83Realization, 'not claimed; EPSG:26910 is generic NAD83', 'A NAD83 realization must not be inferred');
assert.equal(lock.claims.target.coordinateEpoch, 'not claimed', 'A coordinate epoch must not be inferred');
assert.equal(operation.combinedName, 'Inverse of NAD83 to WGS 84 (1) + UTM zone 10N', 'Combined operation name drifted');
assert.equal(operation.combinedAccuracyMetres, 4, 'Combined operation accuracy drifted');
assert.deepEqual(operation.gridDependencies, [], 'The selected generic operation must remain grid-free');
assert.equal(datumOperation.authority, 'EPSG', 'Datum operation authority drifted');
assert.equal(datumOperation.code, 1188, 'Generic datum operation must remain EPSG:1188');
assert.equal(datumOperation.name, 'NAD83 to WGS 84 (1)', 'Datum operation name drifted');
assert.equal(datumOperation.use, 'inverse (WGS 84 to NAD83)', 'Datum operation direction drifted');
assert.equal(datumOperation.method, 'EPSG:9603 Geocentric translations (geog2D domain)', 'Datum operation method drifted');
assert.deepEqual(datumOperation.parametersMetres, { x: 0, y: 0, z: 0 }, 'EPSG:1188 zero translations drifted');
assert.equal(datumOperation.accuracyMetres, 4, 'Generic datum-operation accuracy drifted');
assert.equal(datumOperation.areaOfUse.name, 'North America - Canada and USA (CONUS, Alaska mainland)', 'EPSG:1188 area name drifted');
assert.deepEqual(datumOperation.areaOfUse.bboxWgs84, [-172.54, 23.81, -47.74, 86.46], 'EPSG:1188 area drifted');
assert.equal(projectionOperation.authority, 'EPSG', 'Projection authority drifted');
assert.equal(projectionOperation.code, 16010, 'UTM conversion must remain EPSG:16010');
assert.equal(projectionOperation.name, 'UTM zone 10N', 'Projection name drifted');
assert.equal(projectionOperation.method, 'EPSG:9807 Transverse Mercator', 'Projection method drifted');
assert.deepEqual(projectionParameters, {
  latitudeOfNaturalOriginDegrees: 0,
  longitudeOfNaturalOriginDegrees: -123,
  scaleFactor: 0.9996,
  falseEastingMetres: 500000,
  falseNorthingMetres: 0,
}, 'EPSG:16010 projection parameters drifted');
assert.deepEqual(ellipsoid, { semiMajorAxisMetres: 6378137, inverseFlattening: 298.257222101 }, 'EPSG:4269 ellipsoid constants drifted');
assert.equal(projectionOperation.areaOfUse.name, 'World - N hemisphere - 126°W to 120°W', 'EPSG:16010 area name drifted');
assert.deepEqual(projectionOperation.areaOfUse.bboxWgs84, [-126, 0, -120, 84], 'EPSG:16010 area drifted');
assert.equal(operation.normalizedLonLatForwardPipeline, '+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=utm +zone=10 +ellps=GRS80', 'Forward normalized pipeline drifted');
assert.equal(operation.normalizedEnInversePipeline, '+proj=pipeline +step +inv +proj=utm +zone=10 +ellps=GRS80 +step +proj=unitconvert +xy_in=rad +xy_out=deg', 'Inverse normalized pipeline drifted');
assert.match(operation.pipelineNote, /not a literal full EPSG axis-aware pipeline or a sub-millimetre realization claim/, 'Pipeline limitation must remain explicit');
assert.equal(lock.claims.rejectedCandidate.authority, 'EPSG', 'Rejected candidate authority drifted');
assert.equal(lock.claims.rejectedCandidate.code, 1739, 'HARN-assuming candidate must remain explicitly rejected');
assert.equal(lock.claims.rejectedCandidate.name, 'NAD83 to WGS 84 (43)', 'Rejected candidate name drifted');
assert.deepEqual(lock.claims.rejectedCandidate.ngsNadconSourceGridFiles, ['cnhpgn.las', 'cnhpgn.los'], 'NGS NADCON grid provenance drifted');
assert.equal(lock.claims.rejectedCandidate.projPackagedGrid, 'us_noaa_cnhpgn.tif', 'PROJ grid provenance drifted');
assert.match(lock.claims.rejectedCandidate.reason, /unsupported realization assumption/, 'Rejected-candidate reason drifted');
assert.equal(lock.authorityReceipts.retrievedOn, '2026-08-10', 'Authority receipt date drifted');
assert.equal(lock.authorityReceipts.epsg.length, 8, 'EPSG authority receipt count drifted');
for (const receipt of lock.authorityReceipts.epsg) {
  assert.match(receipt.url, /^https:\/\/epsg\.org\/api\/v1\//, 'EPSG receipt URL must remain official API');
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/, 'EPSG receipt SHA-256 must be lowercase hexadecimal');
}
assert.deepEqual(lock.authorityReceipts.epsg.map(({ url }) => url), [
  'https://epsg.org/api/v1/Transformation/1188',
  'https://epsg.org/api/v1/ProjectedCoordRefSystem/26910',
  'https://epsg.org/api/v1/GeodeticCoordRefSystem/4269',
  'https://epsg.org/api/v1/GeodeticCoordRefSystem/4326',
  'https://epsg.org/api/v1/Conversion/16010',
  'https://epsg.org/api/v1/Extent/1325',
  'https://epsg.org/api/v1/Extent/3864',
  'https://epsg.org/api/v1/Extent/1891',
], 'EPSG authority receipt URLs drifted');
assert.deepEqual(lock.authorityReceipts.epsg.map(({ sha256 }) => sha256), [
  'cf146f2131a178e9234d63079af9eaba1b8aa93d1c312033529bda4e9cc275e9',
  '3f02f0c4cbcbecf78a1dcb478797ff7dc124d026d58e3b9f6f2bffbc91c3e759',
  '557ca47a64a431614be23c954c700e00362a0230491cf75ab934c674383da9cd',
  '60083c9672a8178555cb3d5b7ef3bceb8a521550fbac2b623f17b98440daf407',
  'cdfc2cde615861558316b78538d1a4ebd42bc759b882c6ef25ddb403f3a117a3',
  'ed6fe4a4db075a153a4cef2e528edb57460ec6f715ecd2f0719e6fd70dceffae',
  'f5c5026f128fb9578b31b59b4432b23900bde8aaf09ac10a8ec2b5849c83e79b',
  'd7e5e3714d4bbbce4d6054f5a17b61dd3881ef1b23dda73e7b615126d5a56762',
], 'EPSG authority receipt SHA-256 values drifted');
assert.match(lock.authorityReceipts.noaa.url, /^https:\/\/geodesy\.noaa\.gov\//, 'NOAA receipt URL drifted');
assert.match(lock.authorityReceipts.usgs.url, /^https:\/\/www\.usgs\.gov\//, 'USGS receipt URL drifted');
assert.match(lock.authorityReceipts.proj.url, /^https:\/\/proj\.org\//, 'PROJ receipt URL drifted');
assert.equal(lock.testVectors.length, 3, 'Test-vector count drifted');
assert.deepEqual(lock.testVectors.map(({ id }) => id), ['requested-coverage-southwest', 'requested-coverage-northeast', 'ferry-grid-anchor'], 'Test-vector identifiers drifted');
assert.deepEqual(lock.testVectors[0].inputLonLatDegrees, [sourceLock.requestedCoverageWgs84[0], sourceLock.requestedCoverageWgs84[1]], 'Southwest vector must be requested-coverage southwest');
assert.deepEqual(lock.testVectors[1].inputLonLatDegrees, [sourceLock.requestedCoverageWgs84[2], sourceLock.requestedCoverageWgs84[3]], 'Northeast vector must be requested-coverage northeast');
for (const vector of lock.testVectors) {
  assert.equal(vector.inputLonLatDegrees.length, 2, `${vector.id} input vector shape drifted`);
  assert.equal(vector.forwardEnMetres.length, 2, `${vector.id} forward vector shape drifted`);
  assert.equal(vector.inverseLonLatDegrees.length, 2, `${vector.id} inverse vector shape drifted`);
  assert(vector.inputLonLatDegrees.every(Number.isFinite), `${vector.id} input vector must be finite`);
  assert(vector.forwardEnMetres.every(Number.isFinite), `${vector.id} forward vector must be finite`);
  assert(vector.inverseLonLatDegrees.every(Number.isFinite), `${vector.id} inverse vector must be finite`);
}
assert.equal(lock.integrationStatus.terrainArtifact, 'not-built', 'This verifier must not imply a terrain artifact');
assert.equal(lock.integrationStatus.verticalDatumClaim, false, 'This lock must make no vertical claim');

const checkedVectors = lock.testVectors.map((vector) => {
  const [easting, northing] = forward(...vector.inputLonLatDegrees);
  // The embedded transverse-Mercator series is a dependency-free verifier;
  // the vectors themselves were generated with PROJ. Keep the allowance well
  // below one millimetre while avoiding a false mismatch from series truncation.
  close(easting, vector.forwardEnMetres[0], 0.0002, `${vector.id} forward easting`);
  close(northing, vector.forwardEnMetres[1], 0.0002, `${vector.id} forward northing`);
  const [longitude, latitude] = inverse(...vector.forwardEnMetres);
  close(longitude, vector.inverseLonLatDegrees[0], 0.000000002, `${vector.id} inverse longitude`);
  close(latitude, vector.inverseLonLatDegrees[1], 0.000000002, `${vector.id} inverse latitude`);
  return {
    id: vector.id,
    forwardEnMetres: vector.forwardEnMetres,
    inverseLonLatDegrees: vector.inverseLonLatDegrees,
  };
});

const receipt = {
  result: 'Ferry 3DEP generic horizontal CRS source lock passed',
  lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
  operation: {
    datumTransformation: 'Inverse of EPSG:1188 NAD83 to WGS 84 (1)',
    projection: 'EPSG:16010 UTM zone 10N',
    gridDependencies: [],
    accuracyMetres: 4,
  },
  vectors: checkedVectors,
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
