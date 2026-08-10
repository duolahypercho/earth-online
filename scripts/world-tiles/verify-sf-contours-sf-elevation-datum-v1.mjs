/**
 * Verify the fail-closed provenance lock for the legacy DataSF contours.
 *
 * This performs no network requests and authorizes no vertical transformation.
 * It hashes and scans the checked-in GeoJSON, then tests that hazardous claim
 * mutations are rejected by the same contract verifier.
 *
 * Usage: node scripts/world-tiles/verify-sf-contours-sf-elevation-datum-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-contours-sf-elevation-datum-v1.lock.json');
const lockBytes = readFileSync(LOCK_PATH);
const lock = JSON.parse(lockBytes);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const close = (actual, expected, label) => assert(Math.abs(actual - expected) <= 1e-12, `${label}: expected ${expected}, got ${actual}`);

const EXPECTED_SCOPE = 'This lock records the checked-in DataSF contour source, its documented feet unit and 2001 lineage, and the absence of an authoritative vertical-datum conversion. It authorizes only source-unit normalization to metres for legacy diagnostic use. It does not establish NAVD88 equivalence or authorize a datum offset, production terrain, runtime, manifest, rendering, water, collision, or navigation use.';

const EXPECTED_LOCAL_SOURCE = Object.freeze({
  path: 'public/data/sf/sf-contours.geojson',
  byteLength: 187713239,
  sha256: '84cd967c25299cd57656d9d5ae7e37ab2a28119cdbd15ed8b0a55579300799bd',
  topLevelType: 'FeatureCollection',
  topLevelKeysInOrder: ['type', 'features'],
  embeddedCrs: 'absent',
  featureCount: 14151,
  geometryTypesAndCounts: { LineString: 14151 },
  propertyKeysSorted: ['elevation', 'isoline_ty', 'objectid', 'shape__len'],
  propertyStorageTypes: {
    elevation: 'string',
    isoline_ty: 'string',
    objectid: 'string',
    shape__len: 'string',
  },
  elevationStatisticsSourceFeet: {
    minimum: -40,
    maximum: 915,
    uniqueValueCount: 192,
    allFinite: true,
    allMultiplesOfFive: true,
    contourIntervalFeet: 5,
  },
  isolineTypeCounts: {
    '800 - Normal': 2774,
    '810 - Depression': 244,
    '820 - Intermediate Normal': 10466,
    '830 - Intermediate Depression': 667,
  },
});

const EXPECTED_DATA_SF = Object.freeze({
  authority: 'City and County of San Francisco DataSF',
  publicDatasetId: 'rnbg-2qxw',
  apiViewId: '6d73-6c4f',
  publicDatasetUrl: 'https://data.sfgov.org/d/rnbg-2qxw',
  apiViewUrl: 'https://data.sfgov.org/Energy-and-Environment/Elevation-Contours/6d73-6c4f',
  geoJsonExportUrl: 'https://data.sfgov.org/api/geospatial/6d73-6c4f?method=export&format=GeoJSON',
  metadataUrl: 'https://data.sfgov.org/api/views/6d73-6c4f',
  metadataRetrievedAtUtc: '2026-08-10T18:59:29.076Z',
  metadataByteLength: 9629,
  metadataSha256: 'ece8c9299bb9ed35f79fc13868287e8d6c11c1a470ffd858bd15fe0d2dfbb64c',
  metadataRowsUpdatedAtUnix: 1697580218,
  metadataViewLastModifiedAtUnix: 1739315179,
  exactDescription: 'Elevation contours with a five-foot interval for San Francisco mainland and Treasure Island/Yerba Island. Based on San Francisco Elevation Datum.',
  elevationColumnDescription: '',
  verticalDatumDetail: 'No vertical datum, geoid, vertical coordinate epoch, or conversion is supplied by the current DataSF view metadata.',
});

const EXPECTED_ARCHIVAL_FGDC = Object.freeze({
  authorityRole: 'secondary archival evidence; not a replacement for City Surveyor authority',
  catalogId: 'ark28722-s7pc8g',
  archiveUrl: 'https://spatial.lib.berkeley.edu/public/ark28722-s7pc8g/data.zip',
  archiveRetrievedOn: '2026-08-10',
  archiveByteLength: 50072966,
  archiveSha256: '7157854b0cf18d344fc69195b2cef4791c6660aeb9f3c49497c86c692cc99925',
  embeddedMetadataPath: 'phys_contours_wgs.shp.xml',
  embeddedMetadataByteLength: 121555,
  embeddedMetadataSha256: 'eb71379188eb72526bcace20ddc8c73ee2e16b66a995df95aaace3d452bb6663',
  embeddedMetadataStandard: 'FGDC-STD-001-1998 with ESRI Metadata Profile',
  cityOrigin: 'City and County of San Francisco Department of Telecommunications',
  publicationDate: 'May 2001',
  timePeriod: 'May 2001',
  exactPurpose: 'Developed from Digital Elevation Model used for 2001 orthophotography.',
  exactAbstract: 'Physical Features - Elevation contours with a five-foot interval for San Francisco mainland and Treasure Island/Yerba Island.  Based on San Francisco Elevation Datum. ',
  elevationAttribute: {
    label: 'ELEVATION',
    type: 'Double',
    exactDefinition: 'Elevation of contour in feet ',
    exactDefinitionSource: 'San Francisco Elevation Datum',
    fieldUnit: 'feet',
    footRealization: 'not declared; the vertical field is not identified as international foot or US survey foot',
  },
  verticalReferenceFindings: {
    datum: 'not declared beyond the name San Francisco Elevation Datum',
    geoidModel: 'not declared',
    verticalCoordinateEpoch: 'not declared',
    verticalAccuracy: 'none',
    altitudeResolution: 1,
    altitudeEncoding: 'Explicit elevation coordinate included with horizontal coordinates',
  },
  horizontalHistory: {
    sourceProjectedCrsName: 'NAD_1983_StatePlane_California_III_FIPS_0403_Feet',
    sourceHorizontalDatum: 'North American Datum of 1983',
    sourceEllipsoid: 'Geodetic Reference System 80',
    sourceProjection: 'Lambert Conformal Conic',
    sourcePlanarUnit: 'survey feet',
    sourceRealizationOrCoordinateEpoch: 'not declared',
    reprojectionDate: '20061206',
    reprojectionMethod: 'NAD_1983_To_WGS_1984_1',
    archivePrj: 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
  },
});

const EXPECTED_CITY_SURVEYOR = Object.freeze({
  authority: 'City and County of San Francisco Public Works, City Surveyor',
  benchmarkStatementUrl: 'https://bsm.sfdpw.org/subdivision/benchmark/benchplan.asp',
  benchmarkStatementRetrievedOn: '2026-08-10',
  benchmarkStatementByteLength: 206819,
  benchmarkStatementSha256: 'bb71ba276c834178f6fa5966190e61f4788a5cef27a6cfa2fd2e76e8fc69478d',
  geodeticNetworkUrl: 'https://sfpublicworks.org/services/ccsf-geodetic-network',
  geodeticNetworkRetrievedOn: '2026-08-10',
  geodeticNetworkByteLength: 56739,
  geodeticNetworkSha256: '51c063253eb00f711972e1de67eb6a0fba5c024f3d166274fa4346465f32e3d6',
  establishedNetwork: 'The City & County of San Francisco performed precise Leveling Surveys in 2013 and 2014 to recover NAVD88 and establish CCSF-VD13.',
  supersession: 'CCSF-VD13 supersedes the Old City Datum.',
  exactNominalEstimate: 'CCSF-VD13 (feet) - 11.35 feet = old City Datum in feet.',
  exactUnsupportedConversionWarning: "The actual differences on old City Datum benchmarks are found to vary between 11.2' and 11.5' or greater due to subsidence and lack of maintenance and are not acceptable for converting to CCSF-VD13. Again, converting from old City Datum heights to CCSF-VD13 is not supported.",
  dataSetIdentityFinding: "The cited City Surveyor pages do not explicitly state that the 2001 contour product's named San Francisco Elevation Datum is the Old City Datum or a particular benchmark realization.",
});

const EXPECTED_CLAIMS = Object.freeze({
  sourceElevation: {
    storedUnit: 'feet',
    storedUnitRealization: 'not declared',
    positiveDirection: 'assumed positive-up from ordinary contour-elevation semantics; not separately declared by the metadata',
    namedReference: 'San Francisco Elevation Datum',
    verticalDatum: 'unresolved',
    geoidModel: 'unresolved',
    verticalCoordinateEpoch: 'unresolved',
    verticalAccuracy: 'not supplied; archival FGDC value is none',
    navd88Equivalent: false,
    oldCityDatumEquivalent: false,
  },
  unitNormalizationOnly: {
    enabled: true,
    sourceUnit: 'documented feet',
    targetUnit: 'metres',
    metresPerFoot: 0.3048,
    equation: 'H_source_metres = H_source_feet * 0.3048',
    meaning: 'numeric unit normalization only; it preserves the unresolved source datum and is not a vertical-datum transformation',
    precisionLimitation: 'The source metadata says feet but does not identify the field as international foot or US survey foot; 0.3048 is retained solely as the existing deterministic project arithmetic.',
  },
  unsupportedDiagnosticContext: {
    conversionEnabled: false,
    cityNominalOffsetFeet: 11.35,
    cityNominalOffsetMetresAtPoint3048: 3.45948,
    cityObservedOldBenchmarkDifferenceFeet: { minimum: 11.2, maximum: 11.5, maximumQualifier: 'or greater' },
    cityObservedOldBenchmarkDifferenceMetresAtPoint3048: { minimum: 3.41376, maximum: 3.5052, maximumQualifier: 'or greater' },
    nominalEquationIfAndOnlyIfFutureAuthorityEstablishesIdentity: 'H_CCSF-VD13_feet = H_oldCityDatum_feet + 11.35',
    signConventionContext: 'The nominal diagnostic offset would be added to an Old City Datum height to estimate CCSF-VD13; this lock does not establish that the contour heights are Old City Datum or apply that offset.',
    status: 'unsupported diagnostic context only; City Surveyor explicitly does not support converting old City Datum heights to CCSF-VD13',
  },
});

const EXPECTED_PROHIBITIONS = Object.freeze({
  verticalDatumConversion: 'prohibited',
  applyNominalOffsetMetres: false,
  navd88Equivalence: false,
  oldCityDatumEquivalence: false,
  ccsfVd13Equivalence: false,
  productionTerrain: false,
  terrainManifest: false,
  runtime: false,
  rendering: false,
  water: false,
  collision: false,
  navigation: false,
  surveyOrSafetyUse: false,
});

const EXPECTED_LIMITATIONS = Object.freeze({
  identity: "No cited authority explicitly equates this 2001 product's San Francisco Elevation Datum with Old City Datum, CCSF-VD13, NAVD88, NGVD29, a named benchmark network, or a vertical CRS realization.",
  conversion: "The City Surveyor's 11.35-foot value is an estimate for historical context, not an approved transform. The City explicitly says old benchmark differences vary and conversion to CCSF-VD13 is unsupported.",
  generalization: 'Five-foot contours derived from a 2001 orthophotography DEM cannot be treated as a one-metre 2023 bare-earth DEM or as surveyed local control.',
  runtimeProcessing: 'Downstream gridding, interpolation, smoothing, rounding, phase choice, or shoreline masking can add differences that are not datum evidence.',
  nextRequiredAuthority: 'Obtain City Surveyor documentation tying this exact 2001 product and its benchmark realization to a vertical datum, plus a location- and epoch-appropriate Ferry-area transformation/control surface with uncertainty, before any NAVD88 conversion or production use.',
});

const EXPECTED_AUTHORITY_RECEIPTS = Object.freeze({
  retrievedOn: '2026-08-10',
  hashAlgorithm: 'SHA-256 over exact retrieved response or archive bytes',
  archivalEvidenceClassification: 'The Berkeley ZIP/XML receipts preserve City-origin FGDC metadata as secondary archival evidence; they do not supersede current City authority.',
});

function verifyContract(candidate) {
  assert.equal(candidate.schemaVersion, 1, 'Unsupported contour datum lock schema');
  assert.equal(candidate.kind, 'earth-legacy-elevation-provenance-source-lock', 'Unexpected contour datum lock kind');
  assert.equal(candidate.status, 'source-locked-datum-unresolved-conversion-prohibited', 'Datum must remain unresolved and conversion prohibited');
  assert.equal(candidate.id, 'sf-contours-sf-elevation-datum-v1', 'Contour datum lock identity drifted');
  assert.equal(candidate.scope, EXPECTED_SCOPE, 'Scope authorization or prohibition drifted');
  assert.deepEqual(candidate.localSource, EXPECTED_LOCAL_SOURCE, 'Local source receipt, schema, or statistics drifted');
  assert.deepEqual(candidate.sourceEvidence.dataSf, EXPECTED_DATA_SF, 'DataSF identities, metadata receipt, or limitations drifted');
  assert.notEqual(candidate.sourceEvidence.dataSf.publicDatasetId, candidate.sourceEvidence.dataSf.apiViewId, 'Public and API view IDs must remain distinct');
  assert.match(candidate.sourceEvidence.dataSf.publicDatasetUrl, new RegExp(`${candidate.sourceEvidence.dataSf.publicDatasetId}$`), 'Public URL/ID mismatch');
  assert.match(candidate.sourceEvidence.dataSf.metadataUrl, new RegExp(`${candidate.sourceEvidence.dataSf.apiViewId}$`), 'Metadata URL/API view mismatch');
  assert.deepEqual(candidate.sourceEvidence.archivalFgdc, EXPECTED_ARCHIVAL_FGDC, 'Secondary archival FGDC evidence drifted');
  assert.deepEqual(candidate.sourceEvidence.citySurveyor, EXPECTED_CITY_SURVEYOR, 'City Surveyor authority receipt or warning drifted');
  assert.deepEqual(candidate.claims, EXPECTED_CLAIMS, 'Contour datum claims drifted');
  assert.deepEqual(candidate.prohibitions, EXPECTED_PROHIBITIONS, 'Fail-closed prohibitions drifted');
  assert.deepEqual(candidate.limitations, EXPECTED_LIMITATIONS, 'Limitations drifted or were weakened');
  assert.deepEqual(candidate.authorityReceipts, EXPECTED_AUTHORITY_RECEIPTS, 'Authority receipt classification drifted or was weakened');
  assert.equal(candidate.claims.sourceElevation.verticalDatum, 'unresolved', 'Vertical datum must remain unresolved');
  assert.equal(candidate.claims.sourceElevation.navd88Equivalent, false, 'Contour source must not become NAVD88-equivalent');
  assert.equal(candidate.claims.sourceElevation.oldCityDatumEquivalent, false, 'Old City Datum identity is not established');
  assert.equal(candidate.claims.unitNormalizationOnly.metresPerFoot, 0.3048, 'Existing deterministic unit arithmetic drifted');
  assert.equal(candidate.claims.unsupportedDiagnosticContext.conversionEnabled, false, 'Diagnostic context must never enable conversion');
  close(candidate.claims.unsupportedDiagnosticContext.cityNominalOffsetFeet * 0.3048, candidate.claims.unsupportedDiagnosticContext.cityNominalOffsetMetresAtPoint3048, 'Nominal diagnostic arithmetic');
  close(candidate.claims.unsupportedDiagnosticContext.cityObservedOldBenchmarkDifferenceFeet.minimum * 0.3048, candidate.claims.unsupportedDiagnosticContext.cityObservedOldBenchmarkDifferenceMetresAtPoint3048.minimum, 'Diagnostic range minimum arithmetic');
  close(candidate.claims.unsupportedDiagnosticContext.cityObservedOldBenchmarkDifferenceFeet.maximum * 0.3048, candidate.claims.unsupportedDiagnosticContext.cityObservedOldBenchmarkDifferenceMetresAtPoint3048.maximum, 'Diagnostic range maximum arithmetic');
  assert(candidate.claims.unsupportedDiagnosticContext.cityObservedOldBenchmarkDifferenceFeet.minimum < candidate.claims.unsupportedDiagnosticContext.cityNominalOffsetFeet, 'Nominal value must remain inside the cited diagnostic range');
  assert(candidate.claims.unsupportedDiagnosticContext.cityNominalOffsetFeet < candidate.claims.unsupportedDiagnosticContext.cityObservedOldBenchmarkDifferenceFeet.maximum, 'Nominal value must remain inside the cited diagnostic range');
  assert.match(candidate.claims.unsupportedDiagnosticContext.nominalEquationIfAndOnlyIfFutureAuthorityEstablishesIdentity, /\+ 11\.35$/, 'Diagnostic sign must remain explicit');
  assert.match(candidate.sourceEvidence.citySurveyor.exactUnsupportedConversionWarning, /not acceptable for converting/, 'City no-conversion warning is required');
  assert.match(candidate.sourceEvidence.citySurveyor.exactUnsupportedConversionWarning, /not supported/, 'City unsupported-conversion conclusion is required');
  assert.equal(candidate.integrationStatus.artifactBuilt, false, 'No terrain artifact may be implied');
  assert.equal(candidate.integrationStatus.terrainManifestChanged, false, 'Terrain manifests must remain unchanged');
  assert.equal(candidate.integrationStatus.runtimeChanged, false, 'Runtime must remain unchanged');
  assert.equal(candidate.integrationStatus.productionClaim, false, 'No production claim may be made');
  assert.equal(candidate.integrationStatus.decision, 'provenance-and-limitation lock only', 'Integration decision drifted');
}

function assertRejected(label, mutate, messagePattern) {
  const candidate = structuredClone(lock);
  mutate(candidate);
  assert.throws(() => verifyContract(candidate), messagePattern, label);
}

verifyContract(lock);

const sourceBytes = readFileSync(path.join(ROOT, lock.localSource.path));
assert.equal(sourceBytes.length, lock.localSource.byteLength, 'Checked-in contour byte length drifted');
assert.equal(sha256(sourceBytes), lock.localSource.sha256, 'Checked-in contour SHA-256 drifted');
const source = JSON.parse(sourceBytes);
assert.equal(source.type, lock.localSource.topLevelType, 'GeoJSON top-level type drifted');
assert.deepEqual(Object.keys(source), lock.localSource.topLevelKeysInOrder, 'GeoJSON top-level schema or key order drifted');
assert.equal(Object.hasOwn(source, 'crs'), false, 'GeoJSON must not silently gain an embedded CRS claim');
assert.equal(lock.localSource.embeddedCrs, 'absent', 'Lock embedded-CRS finding drifted');
assert.equal(source.features.length, lock.localSource.featureCount, 'Contour feature count drifted');

const geometryTypesAndCounts = {};
const isolineTypeCounts = {};
const elevations = new Set();
let minimum = Infinity;
let maximum = -Infinity;
for (const [index, feature] of source.features.entries()) {
  assert.equal(feature.type, 'Feature', `Feature ${index} type drifted`);
  assert(feature.geometry, `Feature ${index} geometry missing`);
  geometryTypesAndCounts[feature.geometry.type] = (geometryTypesAndCounts[feature.geometry.type] || 0) + 1;
  assert.deepEqual(Object.keys(feature.properties).sort(), lock.localSource.propertyKeysSorted, `Feature ${index} property schema drifted`);
  for (const [property, storageType] of Object.entries(lock.localSource.propertyStorageTypes)) assert.equal(typeof feature.properties[property], storageType, `Feature ${index} ${property} storage type drifted`);
  const elevation = Number(feature.properties.elevation);
  assert(Number.isFinite(elevation), `Feature ${index} has non-finite elevation`);
  assert(elevation % lock.localSource.elevationStatisticsSourceFeet.contourIntervalFeet === 0, `Feature ${index} elevation is not a five-foot multiple`);
  elevations.add(elevation);
  minimum = Math.min(minimum, elevation);
  maximum = Math.max(maximum, elevation);
  const isolineType = feature.properties.isoline_ty;
  isolineTypeCounts[isolineType] = (isolineTypeCounts[isolineType] || 0) + 1;
}
assert.deepEqual(geometryTypesAndCounts, lock.localSource.geometryTypesAndCounts, 'Geometry-type counts drifted');
assert.deepEqual(isolineTypeCounts, lock.localSource.isolineTypeCounts, 'Isoline-type counts drifted');
assert.deepEqual({
  minimum,
  maximum,
  uniqueValueCount: elevations.size,
  allFinite: true,
  allMultiplesOfFive: true,
  contourIntervalFeet: lock.localSource.elevationStatisticsSourceFeet.contourIntervalFeet,
}, lock.localSource.elevationStatisticsSourceFeet, 'Elevation statistics drifted');

assertRejected('NAVD88 promotion must fail', (candidate) => {
  candidate.claims.sourceElevation.verticalDatum = 'NAVD88';
  candidate.claims.sourceElevation.navd88Equivalent = true;
}, /claims drifted|Vertical datum/);
assertRejected('Conversion enablement must fail', (candidate) => {
  candidate.claims.unsupportedDiagnosticContext.conversionEnabled = true;
  candidate.prohibitions.applyNominalOffsetMetres = true;
}, /claims drifted|prohibitions drifted/);
assertRejected('Wrong vertical field unit must fail', (candidate) => {
  candidate.sourceEvidence.archivalFgdc.elevationAttribute.fieldUnit = 'metres';
}, /archival FGDC evidence drifted/);
assertRejected('Wrong unit-normalization factor must fail', (candidate) => {
  candidate.claims.unitNormalizationOnly.metresPerFoot = 0.3048006096012192;
}, /claims drifted|unit arithmetic/);
assertRejected('Wrong nominal sign must fail', (candidate) => {
  candidate.claims.unsupportedDiagnosticContext.nominalEquationIfAndOnlyIfFutureAuthorityEstablishesIdentity = 'H_CCSF-VD13_feet = H_oldCityDatum_feet - 11.35';
}, /claims drifted|sign/);
assertRejected('Wrong diagnostic range must fail', (candidate) => {
  candidate.claims.unsupportedDiagnosticContext.cityObservedOldBenchmarkDifferenceFeet.minimum = 11.5;
  candidate.claims.unsupportedDiagnosticContext.cityObservedOldBenchmarkDifferenceFeet.maximum = 11.2;
}, /claims drifted|range/);
assertRejected('Public/API ID conflation must fail', (candidate) => {
  candidate.sourceEvidence.dataSf.publicDatasetId = candidate.sourceEvidence.dataSf.apiViewId;
}, /DataSF identities|distinct/);
assertRejected('Metadata URL/view mismatch must fail', (candidate) => {
  candidate.sourceEvidence.dataSf.metadataUrl = 'https://data.sfgov.org/api/views/rnbg-2qxw';
}, /DataSF identities|mismatch/);
assertRejected('Coordinated local-source receipt and statistics drift must fail', (candidate) => {
  candidate.localSource.path = 'public/data/sf/replacement-contours.geojson';
  candidate.localSource.byteLength = 100;
  candidate.localSource.sha256 = '0'.repeat(64);
  candidate.localSource.featureCount = 1;
  candidate.localSource.geometryTypesAndCounts.LineString = 1;
  candidate.localSource.elevationStatisticsSourceFeet = {
    minimum: 0,
    maximum: 0,
    uniqueValueCount: 1,
    allFinite: true,
    allMultiplesOfFive: true,
    contourIntervalFeet: 5,
  };
}, /Local source receipt/);
assertRejected('Coordinated limitation weakening must fail', (candidate) => {
  candidate.limitations.identity = 'The contour datum identity is established.';
  candidate.limitations.conversion = 'The conversion is approved.';
}, /Limitations drifted or were weakened/);
assertRejected('Appended runtime authorization in scope must fail', (candidate) => {
  candidate.scope += ' Runtime integration is authorized.';
}, /Scope authorization or prohibition drifted/);
assertRejected('Authority classification weakening must fail', (candidate) => {
  candidate.authorityReceipts.archivalEvidenceClassification = 'The Berkeley archive is primary authority and supersedes City authority.';
}, /Authority receipt classification drifted or was weakened/);

process.stdout.write(`${JSON.stringify({
  result: 'DataSF contour datum-unresolved provenance lock passed',
  lockSha256: sha256(lockBytes),
  sourceSha256: sha256(sourceBytes),
  features: source.features.length,
  elevationSourceFeet: { minimum, maximum, uniqueValues: elevations.size, contourInterval: 5 },
  verticalDatum: lock.claims.sourceElevation.verticalDatum,
  conversionEnabled: lock.claims.unsupportedDiagnosticContext.conversionEnabled,
  adversarialCases: 12,
}, null, 2)}\n`);
