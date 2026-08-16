/**
 * Verify the fail-closed, descriptive HPND 267 / Ferry 3DEP point-sample QA lock.
 *
 * This verifier performs no network access and authorizes no runtime, manifest,
 * terrain, contour, water, survey, or safety use.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-hpnd267-3dep-qa-v1.lock.json');
const lockBytes = readFileSync(LOCK_PATH);
const lock = JSON.parse(lockBytes);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const close = (actual, expected, tolerance, label) => assert(
  Math.abs(actual - expected) <= tolerance,
  `${label}: expected ${expected}, got ${actual}, tolerance ${tolerance}`,
);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function readReceipt(relativePath) {
  const bytes = readFileSync(path.join(ROOT, relativePath));
  return { bytes, byteLength: bytes.length, sha256: sha256(bytes) };
}

function dmsToDegrees({ degrees, minutes, seconds, hemisphere }) {
  const magnitude = degrees + minutes / 60 + seconds / 3600;
  return hemisphere === 'S' || hemisphere === 'W' ? -magnitude : magnitude;
}

function forwardFromHorizontalLock(lonDegrees, latDegrees, horizontalLock) {
  const [, projection] = horizontalLock.claims.operation.authorityPath;
  const parameters = projection.parameters;
  const ellipsoid = projection.ellipsoidFromEpsg4269;
  const a = ellipsoid.semiMajorAxisMetres;
  const flattening = 1 / ellipsoid.inverseFlattening;
  const e2 = flattening * (2 - flattening);
  const ep2 = e2 / (1 - e2);
  const degreesToRadians = Math.PI / 180;
  const phi = latDegrees * degreesToRadians;
  const lon0 = parameters.longitudeOfNaturalOriginDegrees * degreesToRadians;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * sinPhi ** 2);
  const t = tanPhi ** 2;
  const c = ep2 * cosPhi ** 2;
  const aa = cosPhi * (lonDegrees * degreesToRadians - lon0);
  const meridionalArc = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  return [
    parameters.falseEastingMetres + parameters.scaleFactor * n * (aa
      + (1 - t + c) * aa ** 3 / 6
      + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120),
    parameters.falseNorthingMetres + parameters.scaleFactor * (meridionalArc + n * tanPhi * (aa ** 2 / 2
      + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24
      + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720)),
  ];
}

function haversineDistanceMetres([lon1, lat1], [lon2, lat2]) {
  const radians = Math.PI / 180;
  const latitudeDelta = (lat2 - lat1) * radians;
  const longitudeDelta = (lon2 - lon1) * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(haversine));
}

const EXPECTED_AUTHORITY_RECEIPTS = [
  { id: 'ccsf-geodetic-network-page', title: 'CCSF Geodetic Network', url: 'https://sfpublicworks.org/services/ccsf-geodetic-network', bytes: 56739, sha256: '51c063253eb00f711972e1de67eb6a0fba5c024f3d166274fa4346465f32e3d6' },
  { id: 'ccsf-hpnd-coordinate-list', title: 'High Precision Network Densification (HPND) Coordinate List', url: 'https://sfpublicworks.org/sites/default/files/Geodetic%20Network/CCSF%20HPND%20Densification%20Coordinate%20List.docx', bytes: 67051, sha256: 'c0934ff792f4a54ddd79483db2241fda8ed0f44b1c2979d910357f6b5885bbdc' },
  { id: 'ccsf-cs13-point-descriptions', title: 'CCSF-CS13 Primary and Densification Point Descriptions', url: 'https://sfpublicworks.org/sites/default/files/Geodetic%20Network/CCSF-CS13%20Primary%20%26%20Densification%20Points%20061716%20JTM.xlsx', bytes: 1845905, sha256: 'ca800d485e2a5a0376b74f3b93987fe0e8eef1f52b702a4c7f65fc850d007002' },
  { id: 'ccsf-vd13-benchmark-heights', title: 'CCSF Vertical Datum of 2013 Benchmark List, NAVD88 Datum as Recovered by CCSF in 2013', url: 'https://sfpublicworks.org/sites/default/files/Geodetic%20Network/CCSF-VD13%20Benchmarks-NAVD88%20Heights.docx', bytes: 91771, sha256: '2df9fde0a3dffdd650fa018184ffa844ac04f6971c02a1b4e0b1346f22d5d1a5' },
  { id: 'ccsf-2013-leveling-report', title: 'City and County of San Francisco 2013 NAVD88 Vertical Datum Second Order Leveling Network Survey', url: 'https://sfpublicworks.org/sites/default/files/Geodetic%20Network/Report%202013%20CCSF%20Second%20Order%20Leveling%20Survey%20v2%20(1).docx', bytes: 3051461, sha256: 'a15c24a9d49c5ff82c0cf072f4e76a3bee1b3eb01f313c245668df712d6165ea' },
  { id: 'ccsf-datums-reference', title: 'CCSF Datums, Coordinate Systems, Reference Frames and Acronyms', url: 'https://sfpublicworks.org/sites/default/files/Geodetic%20Network/Datum-H-V%20Simplified%20CCSF%20Version%204.3_0.docx', bytes: 37953, sha256: '0f2233ac89dba8e6cd378509f4c9175b34457b19af618705492a7c0565f38c48' },
];

const EXPECTED_DEPENDENCIES = {
  sourceLock: { path: 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json', bytes: 5360, sha256: '3751942da71cf0714827f809803ffb44dc1143430e350f8d0b1bd23da6da651b' },
  horizontalLock: { path: 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json', bytes: 9611, sha256: 'd5a86d211be380eec4bc03ff5e97dbef4dfaf2866578ab5330c90c7b586fcc21' },
  verticalReferenceLock: { path: 'public/data/world/source-locks/sf-ferry-3dep-2023-vertical-water-reference-v1.lock.json', bytes: 8740, sha256: 'fc054af8c2117c19b759e1c1b7150046d207c0ebd839975639b786446a2d2165' },
  parentPreviewReceipt: { path: 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-parent-v1/sf-ferry-3dep-2x2-parent-preview-v1.receipt.json', bytes: 8611, sha256: '8d34df70e93f92fb7b5076f3ee0260bd6c8605ca92de14703a2eb39e835419be' },
  parentPreviewFloat32: { path: 'public/data/world/preview-artifacts/sf-ferry-3dep-2x2-parent-v1/sf-ferry-3dep-2x2-parent-preview-v1.f32le', bytes: 2621160, sha256: '4975b5f6542d0ff87af840d04cfaf25ab08398889da441efb043b0fae4fafcdc' },
};

const EXPECTED_SCOPE = 'This lock records one reproducible, descriptive point-sample residual between official CCSF HPND point 267 and the checked-in Ferry 3DEP engineering preview. It is QA evidence only. It does not establish 3DEP accuracy, a datum transformation, an old City Datum pairing or offset, a contour conversion, a terrain correction, a water reference, a survey result, or authority for runtime, manifest, production, navigation, flood, or safety use.';

const EXPECTED_NETWORK_ACCURACY_CONTEXT = {
  pointSpecificAccuracyClaim: false,
  publishedNetworkContext: 'The CCSF benchmark list says relative accuracy of undisturbed benchmarks is expected to be 1-2 millimetres; the 2013 leveling report says the recovered datum is within 0.016 metres at 95% confidence. Neither statement is a point-specific present-day uncertainty for HPND 267.',
  presentRecoveryOrStability: 'No post-setting recovery, current stability, or subsidence assessment for HPND 267 is established by these receipts.',
};

const EXPECTED_SELECTED_OPERATION = 'sf-ferry-3dep-2023-horizontal-crs-v1 generic WGS84-to-EPSG:26910 path';
const EXPECTED_RESIDUAL_INTERPRETATION = 'A descriptive difference between a bare-earth DEM sample and a physical sidewalk monument height under a generic 4 metre horizontal operation; it is not an accuracy, bias, correction, or datum-transform estimate.';

const EXPECTED_LIMITATIONS = {
  parentVerticalDatumUnresolvedMustRemainTrue: true,
  descriptivePointSampleQaOnly: true,
  threeDepAccuracyClaim: false,
  combinedUncertaintyClaim: false,
  oldCityDatumPairing: false,
  oldCityDatumOffset: false,
  contourDatumEquivalence: false,
  contourConversion: false,
  terrainOffsetOrCorrection: false,
  runtimeUse: false,
  manifestPromotion: false,
  productionTerrainAuthorization: false,
  waterOrTidalDatumTransfer: false,
  geoidModelClaim: false,
  verticalCoordinateEpochClaim: false,
  horizontalRealizationOrEpochMatchClaim: false,
  surveyOrSafetyUse: false,
  surfaceMismatch: 'HPND 267 is a physical monument in concrete sidewalk; the 3DEP product is a bare-earth DEM. Their descriptive residual is not a common-surface validation.',
  nextRequiredAuthority: 'A production use requires producer-authoritative realization/epoch/geoid metadata, a point-specific monument recovery and stability assessment, a defined common-surface reduction, and an uncertainty budget. Any historical contour conversion additionally requires an official dual-datum tie or a new City-approved survey.',
};

function validate(candidate, { verifyRepositoryBytes = true } = {}) {
  assert.equal(candidate.schemaVersion, 1, 'Unsupported HPND 267 QA lock schema');
  assert.equal(candidate.kind, 'earth-terrain-point-sample-qa-control-lock', 'Unexpected HPND 267 lock kind');
  assert.equal(candidate.status, 'qa-only-descriptive-point-sample-not-for-runtime', 'Lock must remain descriptive QA only');
  assert.equal(candidate.id, 'sf-ferry-hpnd267-3dep-qa-v1', 'HPND 267 lock identity drifted');
  assert.equal(candidate.scope, EXPECTED_SCOPE, 'Safety-critical scope drifted');
  assert.equal(candidate.authorityReceipts.retrievedOn, '2026-08-10', 'Authority retrieval date drifted');
  assert.equal(candidate.authorityReceipts.hashAlgorithm, 'SHA-256 over the exact retrieved response bytes', 'Authority receipt hash method drifted');
  assert.deepEqual(candidate.authorityReceipts.items, EXPECTED_AUTHORITY_RECEIPTS, 'Official CCSF receipt set drifted');
  assert.deepEqual(candidate.repositoryDependencies, EXPECTED_DEPENDENCIES, 'Repository dependency receipts drifted');

  const point = candidate.sourceEvidence.hpnd267;
  assert.deepEqual({
    pointId: point.pointId,
    status: point.status,
    monumentType: point.monumentType,
    location: point.location,
    setOrRecovered: point.setOrRecovered,
  }, {
    pointId: '267',
    status: 'SET',
    monumentType: 'ANCHOR SCREW WITH WASHER STAMPED "CCSF CONTROL 267"',
    location: 'EMBARCADERO BETWEEN MISSION AND MARKET',
    setOrRecovered: { date: '2015-01-23', crewCodes: ['MM', 'NDK', 'PNC', 'JTM'] },
  }, 'HPND 267 identity or monument evidence drifted');
  assert.match(point.description, /33 feet southerly of the Ferry Building's southerly face/, 'Ferry proximity description drifted');
  assert.match(point.description, /easterly concrete sidewalk/, 'Monument surface description drifted');
  assert.deepEqual(point.formalCoordinate.latitudeDms, { sourceText: '37-47-40.36019', degrees: 37, minutes: 47, seconds: 40.36019, hemisphere: 'N' }, 'Official latitude DMS drifted');
  assert.deepEqual(point.formalCoordinate.longitudeDms, { sourceText: '122-23-34.79930', degrees: 122, minutes: 23, seconds: 34.7993, hemisphere: 'W' }, 'Official longitude DMS drifted');
  assert.equal(point.formalCoordinate.geometricDatum, 'NAD83 (2011) Epoch 2010.00', 'Point geometric datum drifted');
  assert.equal(point.formalCoordinate.projectedCoordinateSystem, 'CCSF-CS13', 'Point projected frame drifted');
  assert.deepEqual(point.formalCoordinate.ccsfCs13UsSurveyFeet, { northing: 94965.87, easting: 173951.22 }, 'Official CCSF-CS13 coordinates drifted');
  assert.equal(point.formalCoordinate.ellipsoidHeightUsSurveyFeet, -96.4, 'Official ellipsoid height drifted');
  const normalizedLonLat = [dmsToDegrees(point.formalCoordinate.longitudeDms), dmsToDegrees(point.formalCoordinate.latitudeDms)];
  assert.deepEqual(normalizedLonLat, point.formalCoordinate.normalizedLonLatDegrees, 'DMS-to-decimal normalization drifted');

  const vertical = point.verticalControl;
  assert.equal(vertical.datum, 'CCSF 2013 NAVD88 Vertical Datum (CCSF-VD13)', 'Control vertical datum drifted');
  assert.deepEqual(vertical.sourcePublishedHeight, { usSurveyFeet: 10.348, metres: 3.154 }, 'Published HPND 267 height drifted');
  assert.equal(vertical.heightCode, 'L', 'HPND 267 must remain a directly leveled control');
  assert.equal(vertical.heightCodeDefinition, 'Based on CCSF 2013 High Precision Leveling Network', 'Height code definition drifted');
  assert.deepEqual(vertical.exactConversion, {
    usSurveyFootMetresNumerator: 1200,
    usSurveyFootMetresDenominator: 3937,
    metresPerUsSurveyFoot: 0.3048006096012192,
    heightMetres: 3.1540767081534162,
    publishedMetreRoundingDelta: 0.00007670815341609338,
  }, 'US survey foot conversion receipt drifted');
  const metresPerUsSurveyFoot = vertical.exactConversion.usSurveyFootMetresNumerator / vertical.exactConversion.usSurveyFootMetresDenominator;
  assert.equal(metresPerUsSurveyFoot, vertical.exactConversion.metresPerUsSurveyFoot, 'US survey foot factor must recompute exactly');
  const controlHeightMetres = vertical.sourcePublishedHeight.usSurveyFeet * metresPerUsSurveyFoot;
  assert.equal(controlHeightMetres, vertical.exactConversion.heightMetres, 'HPND 267 exact metric height must recompute');
  close(controlHeightMetres - vertical.sourcePublishedHeight.metres, vertical.exactConversion.publishedMetreRoundingDelta, 1e-15, 'Published metre rounding delta');
  assert.deepEqual(point.networkAccuracyContext, EXPECTED_NETWORK_ACCURACY_CONTEXT, 'Network accuracy and stability context drifted');

  assert.deepEqual(candidate.sourceEvidence.approvedVerticalReference, {
    path: EXPECTED_DEPENDENCIES.verticalReferenceLock.path,
    sha256: EXPECTED_DEPENDENCIES.verticalReferenceLock.sha256,
    bytes: EXPECTED_DEPENDENCIES.verticalReferenceLock.bytes,
    productMetadataDeclaration: 'NAVD88',
    purposeHere: 'This dependency supplies the approved product-metadata NAVD88 declaration and its limitations only. No water or tidal-datum content is applied to the point sample.',
  }, 'Approved vertical-reference dependency drifted');

  assert.deepEqual(candidate.limitations, EXPECTED_LIMITATIONS, 'Fail-closed limitations object drifted');
  assert.deepEqual(candidate.integrationStatus, {
    qaArtifactOnly: true,
    terrainArtifactChanged: false,
    terrainManifestChanged: false,
    runtimeChanged: false,
    waterChanged: false,
    productionClaim: false,
  }, 'Integration status must remain fail closed');

  if (!verifyRepositoryBytes) return;
  for (const [id, expected] of Object.entries(EXPECTED_DEPENDENCIES)) {
    const actual = readReceipt(expected.path);
    assert.equal(actual.byteLength, expected.bytes, `${id} byte length drifted`);
    assert.equal(actual.sha256, expected.sha256, `${id} SHA-256 drifted`);
  }

  const sourceLock = readJson(EXPECTED_DEPENDENCIES.sourceLock.path);
  const horizontalLock = readJson(EXPECTED_DEPENDENCIES.horizontalLock.path);
  const verticalReferenceLock = readJson(EXPECTED_DEPENDENCIES.verticalReferenceLock.path);
  const parentReceipt = readJson(EXPECTED_DEPENDENCIES.parentPreviewReceipt.path);
  assert.equal(sourceLock.coordinateReference.vertical.declaredByProductMetadata, 'NAVD88', 'Parent source product declaration drifted');
  assert.equal(horizontalLock.id, 'sf-ferry-3dep-2023-horizontal-crs-v1', 'Generic horizontal lock identity drifted');
  assert.equal(horizontalLock.claims.operation.combinedAccuracyMetres, 4, 'Generic horizontal accuracy drifted');
  assert.equal(horizontalLock.claims.target.nad83Realization, 'not claimed; EPSG:26910 is generic NAD83', 'Horizontal realization must remain unclaimed');
  assert.equal(verticalReferenceLock.claims.dem.verticalDatum, 'NAVD88', 'Approved vertical-reference declaration drifted');
  assert.equal(verticalReferenceLock.claims.dem.geoidModel, 'not claimed; no model is present in the product XML or embedded GeoTIFF keys', 'Geoid must remain unclaimed');
  assert.equal(verticalReferenceLock.claims.dem.verticalCoordinateEpoch, 'not claimed; NAVD88 is declared, but no vertical coordinate epoch is supplied', 'Vertical epoch must remain unclaimed');
  assert.equal(parentReceipt.verticalDatumUnresolved, true, 'Parent preview verticalDatumUnresolved finding must remain true');

  const comparison = candidate.comparison;
  assert.equal(comparison.horizontalOperation.sourcePointFrame, point.formalCoordinate.geometricDatum, 'Point-frame receipt drifted');
  assert.equal(comparison.horizontalOperation.selectedOperation, EXPECTED_SELECTED_OPERATION, 'Selected generic horizontal operation prose drifted');
  assert.equal(comparison.horizontalOperation.targetCrs, 'EPSG:26910', 'Comparison target CRS drifted');
  assert.equal(comparison.horizontalOperation.combinedAccuracyMetres, 4, 'Comparison must retain the generic 4 metre horizontal accuracy');
  assert.equal(comparison.horizontalOperation.realizationOrEpochMatch, 'not established', 'Realization/epoch match must remain unclaimed');
  assert.equal(comparison.horizontalOperation.subMetreClaim, false, 'Comparison must not make a sub-metre claim');
  const projectedEn = forwardFromHorizontalLock(...normalizedLonLat, horizontalLock);
  projectedEn.forEach((value, index) => close(value, comparison.horizontalOperation.projectedEnMetres[index], 1e-9, `Projected EN[${index}]`));

  const raster = comparison.pixelIsAreaBilinearSample;
  assert.equal(parentReceipt.raster.affine.rasterType, 'PixelIsArea', 'Parent raster must remain PixelIsArea');
  assert.equal(raster.pixelReference, 'PixelIsArea edge affine; subtract 0.5 pixel in both axes to address sample centers', 'Pixel-center convention drifted');
  assert.deepEqual(raster.parentWindowPixelOrigin, [parentReceipt.raster.nativePixelWindow.column, parentReceipt.raster.nativePixelWindow.row], 'Parent-window pixel origin drifted');
  const [scaleX, , edgeX, , scaleY, edgeY] = parentReceipt.raster.affine.coefficients;
  assert.deepEqual(raster.parentWindowModelNorthwestEdgeMetres, [
    edgeX + parentReceipt.raster.nativePixelWindow.column * scaleX,
    edgeY + parentReceipt.raster.nativePixelWindow.row * scaleY,
  ], 'Parent-window model edge drifted');
  const sampleColumn = (projectedEn[0] - raster.parentWindowModelNorthwestEdgeMetres[0]) / scaleX - 0.5;
  const sampleRow = (projectedEn[1] - raster.parentWindowModelNorthwestEdgeMetres[1]) / scaleY - 0.5;
  close(sampleColumn, raster.parentSampleColumnRow[0], 1e-9, 'Parent sample column');
  close(sampleRow, raster.parentSampleColumnRow[1], 1e-9, 'Parent sample row');
  const lowerColumn = Math.floor(sampleColumn);
  const lowerRow = Math.floor(sampleRow);
  assert.deepEqual([lowerColumn, lowerRow], raster.lowerParentSampleIndexColumnRow, 'Lower sample index drifted');
  const fractions = [sampleColumn - lowerColumn, sampleRow - lowerRow];
  fractions.forEach((value, index) => close(value, raster.fractionsEastSouth[index], 1e-12, `Bilinear fraction[${index}]`));

  const artifactBytes = readFileSync(path.join(ROOT, EXPECTED_DEPENDENCIES.parentPreviewFloat32.path));
  const dataView = new DataView(artifactBytes.buffer, artifactBytes.byteOffset, artifactBytes.byteLength);
  const width = parentReceipt.raster.nativePixelWindow.width;
  const expectedNeighbors = [
    { id: 'northwest', parentColumnRow: [lowerColumn, lowerRow] },
    { id: 'northeast', parentColumnRow: [lowerColumn + 1, lowerRow] },
    { id: 'southwest', parentColumnRow: [lowerColumn, lowerRow + 1] },
    { id: 'southeast', parentColumnRow: [lowerColumn + 1, lowerRow + 1] },
  ];
  assert.equal(raster.neighbors.length, 4, 'Exactly four sample neighbors are required');
  const values = raster.neighbors.map((neighbor, index) => {
    assert.equal(neighbor.id, expectedNeighbors[index].id, `Neighbor ${index} identity drifted`);
    assert.deepEqual(neighbor.parentColumnRow, expectedNeighbors[index].parentColumnRow, `${neighbor.id} parent index drifted`);
    assert.deepEqual(neighbor.sourceColumnRow, [
      parentReceipt.raster.nativePixelWindow.column + neighbor.parentColumnRow[0],
      parentReceipt.raster.nativePixelWindow.row + neighbor.parentColumnRow[1],
    ], `${neighbor.id} source index drifted`);
    const [column, row] = neighbor.parentColumnRow;
    const value = dataView.getFloat32((row * width + column) * 4, true);
    assert.equal(value, neighbor.valueMetres, `${neighbor.id} float32 value drifted`);
    assert.notEqual(value, parentReceipt.raster.nodata, `${neighbor.id} must not be nodata`);
    return value;
  });
  const [eastFraction, southFraction] = fractions;
  const northValue = values[0] * (1 - eastFraction) + values[1] * eastFraction;
  const southValue = values[2] * (1 - eastFraction) + values[3] * eastFraction;
  const interpolated = northValue * (1 - southFraction) + southValue * southFraction;
  close(interpolated, raster.interpolated3depMetres, 1e-12, 'Interpolated 3DEP sample');
  assert.equal(comparison.controlHeightMetres, controlHeightMetres, 'Comparison control height drifted');
  assert.equal(comparison.residual.definition, 'interpolated 3DEP sample minus HPND 267 CCSF-VD13 control height', 'Residual sign definition drifted');
  close(interpolated - controlHeightMetres, comparison.residual.metres, 1e-12, '3DEP/control residual');
  assert.equal(comparison.residual.interpretation, EXPECTED_RESIDUAL_INTERPRETATION, 'Safety-critical residual interpretation drifted');

  const [west, south, east, north] = sourceLock.requestedCoverageWgs84;
  assert(normalizedLonLat[0] >= west && normalizedLonLat[0] <= east && normalizedLonLat[1] >= south && normalizedLonLat[1] <= north, 'HPND 267 must remain inside the locked Ferry extent');
  const extentCenter = [(west + east) / 2, (south + north) / 2];
  close(haversineDistanceMetres(normalizedLonLat, extentCenter), comparison.pointToLockedExtentCenterDistanceMetres, 1e-9, 'Point-to-extent-center distance');
}

validate(lock);

const adversarialCases = [
  ['production status', (candidate) => { candidate.status = 'production-approved'; }, /descriptive QA only/],
  ['modeled height', (candidate) => { candidate.sourceEvidence.hpnd267.verticalControl.heightCode = 'G'; }, /directly leveled control/],
  ['old-datum pairing', (candidate) => { candidate.limitations.oldCityDatumPairing = true; }, /limitations object drifted/],
  ['runtime authorization', (candidate) => { candidate.limitations.runtimeUse = true; }, /limitations object drifted/],
  ['resolved parent datum', (candidate) => { candidate.limitations.parentVerticalDatumUnresolvedMustRemainTrue = false; }, /limitations object drifted/],
  ['appended accuracy authorization', (candidate) => { candidate.limitations.accuracyClaim = true; }, /limitations object drifted/],
  ['contour conversion authorization', (candidate) => { candidate.limitations.contourConversion = true; }, /limitations object drifted/],
  ['production authorization', (candidate) => { candidate.limitations.productionTerrainAuthorization = true; }, /limitations object drifted/],
  ['water or tide transfer', (candidate) => { candidate.limitations.waterOrTidalDatumTransfer = true; }, /limitations object drifted/],
  ['geoid and epoch claim', (candidate) => { candidate.limitations.geoidModelClaim = true; candidate.limitations.verticalCoordinateEpochClaim = true; }, /limitations object drifted/],
  ['survey and safety authorization', (candidate) => { candidate.limitations.surveyOrSafetyUse = true; }, /limitations object drifted/],
  ['weakened contradictory scope', (candidate) => { candidate.scope += ' Runtime correction is authorized.'; }, /scope drifted/],
  ['contradictory network accuracy', (candidate) => { candidate.sourceEvidence.hpnd267.networkAccuracyContext.publishedNetworkContext += ' This proves point accuracy.'; }, /Network accuracy and stability context drifted/],
  ['weakened residual interpretation', (candidate) => { candidate.comparison.residual.interpretation += ' Use this as a terrain correction.'; }, /residual interpretation drifted/],
  ['neighbor index', (candidate) => { candidate.comparison.pixelIsAreaBilinearSample.neighbors[0].parentColumnRow[0] += 1; }, /parent index drifted/],
  ['residual sign', (candidate) => { candidate.comparison.residual.metres *= -1; }, /3DEP\/control residual/],
];
for (const [name, mutate, expectedError] of adversarialCases) {
  const candidate = clone(lock);
  mutate(candidate);
  assert.throws(() => validate(candidate), expectedError, `Adversarial mutation must fail closed: ${name}`);
}

process.stdout.write(`${JSON.stringify({
  result: 'Ferry HPND 267 descriptive 3DEP point-sample QA lock passed',
  lockSha256: sha256(lockBytes),
  pointId: lock.sourceEvidence.hpnd267.pointId,
  normalizedLonLatDegrees: lock.sourceEvidence.hpnd267.formalCoordinate.normalizedLonLatDegrees,
  controlHeightMetres: lock.comparison.controlHeightMetres,
  interpolated3depMetres: lock.comparison.pixelIsAreaBilinearSample.interpolated3depMetres,
  residualMetres: lock.comparison.residual.metres,
  parentVerticalDatumUnresolved: true,
  adversarialMutationCount: adversarialCases.length,
  authorizedUse: 'descriptive point-sample QA only',
}, null, 2)}\n`);
