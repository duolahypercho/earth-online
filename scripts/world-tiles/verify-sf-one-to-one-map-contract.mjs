/**
 * Offline gate for the SF 1:1 coordinate contract. Pass a production package
 * descriptor path to validate it: `node ...verify-sf-one-to-one-map-contract.mjs path/to/package.json`.
 * Without a package, this only verifies the contract and its adversarial test fixtures;
 * it deliberately does not claim that any map artifact has passed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGeoTiffWindowReader } from './geotiff-window-reader-v1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'public/data/world/contracts/sf-one-to-one-map.contract.json');
const SOURCE_LOCKS_DIR = path.join(ROOT, 'public/data/world/source-locks');
const RUNTIME_FRAME = 'production-utm-navd88';
const PROVISIONAL_RUNTIME_FRAME = 'provisional-utm-source-declared-navd88-unrealized';
const AXES = { x: 'east', y: 'up', z: 'north' };
const SCALE = { runtimeUnitsPerMetre: 1, horizontalScale: 1, verticalScale: 1, verticalExaggeration: 0 };
const TILING = { scheme: 'rectilinear-utm', tileSizeMetres: 384, sourceBufferMetres: 16 };
const TRANSFORM_LOCK = {
  id: 'sf-ferry-3dep-2023-horizontal-crs-v1',
  path: ['EPSG:1188-inverse', 'EPSG:26910-projection'],
  absoluteHorizontalAccuracyFloorMetres: 4,
  nad83Realization: 'not-claimed',
  coordinateEpoch: 'not-claimed',
};
const ACCURACY_QUALIFICATION = {
  absoluteHorizontalAccuracyFloorMetres: 4,
  nad83Realization: 'not-claimed',
  coordinateEpoch: 'not-claimed',
  lodErrorIsRelativeToTransformedSource: true,
};
const REQUIRED_PROVENANCE = [
  'sourceId', 'sourceFeatureId', 'publisher', 'license', 'retrievedAt',
  'nativeHorizontalCrs', 'nativeVerticalDatum', 'sourceLockId',
  'horizontalTransformLockId', 'verticalMode', 'verticalTransformLockId', 'elevationSourceLockId',
  'elevationSampleEvidence', 'sourceGeometryHash', 'nativeHorizontalPosition',
  'transformedPositionEpsg26910VerticalMetres', 'runtimePositionMetres',
];
const PACKAGE_KEYS = [
  'schemaVersion', 'kind', 'status', 'contractId', 'coordinateReference', 'verticalCertification', 'runtimeAxes',
  'scale', 'tiling', 'tileOriginEpsg26910VerticalMetres', 'sourceFeatures', 'lods',
  'authorizedHorizontalTransform', 'accuracyQualification', 'sourceLocks',
];
const FEATURE_KEYS = REQUIRED_PROVENANCE;
const SOURCE_LOCK_KEYS = ['id', 'path', 'sha256', 'purpose'];
const ELEVATION_SAMPLE_EVIDENCE_KEYS = ['rasterSha256', 'nativePixelWindow', 'compressedTileIndices', 'compressedTileBytesRead', 'sampleMethod', 'sampledSourceDeclaredNavd88UnrealizedMetres', 'sampleWindowSha256', 'evidenceSha256'];
const LOD_KEYS = [
  'level', 'runtimeFrame', 'scale', 'translationMetres',
  'maxHorizontalDeviationMetres', 'maxVerticalDeviationMetres', 'artifactHash',
];
const HASH = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_DEPENDENCY = /(?:preview|linear)/i;
const POSITION_TOLERANCE_METRES = 1e-6;

const loadJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function assertExactKeys(value, allowed, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...allowed].sort(), `${name} has missing or unknown fields`);
}

function assertPosition(name, value) {
  assert(Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber), `${name} must be a finite position triple`);
}

function assertHash(name, value) {
  assert(typeof value === 'string' && HASH.test(value), `${name} must be sha256:<64 lowercase hex characters>`);
}

function assertDate(name, value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), `${name} must be an ISO YYYY-MM-DD date`);
  assert(!Number.isNaN(Date.parse(`${value}T00:00:00Z`)), `${name} must be a real calendar date`);
}

function assertNoForbiddenDependency(name, value) {
  if (typeof value === 'string') assert(!FORBIDDEN_DEPENDENCY.test(value), `${name} may not use preview or linear dependencies`);
  if (Array.isArray(value)) value.forEach((item, index) => assertNoForbiddenDependency(`${name}[${index}]`, item));
  if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => assertNoForbiddenDependency(`${name}.${key}`, item));
}

function realSourceLockResolver(descriptor) {
  assert(typeof descriptor.path === 'string' && descriptor.path.startsWith('public/data/world/source-locks/'), 'Source lock path must be below public/data/world/source-locks');
  assert(!descriptor.path.includes('..'), 'Source lock path may not traverse directories');
  const candidate = path.resolve(ROOT, descriptor.path);
  const resolved = realpathSync(candidate);
  assert(resolved.startsWith(`${realpathSync(SOURCE_LOCKS_DIR)}${path.sep}`), 'Source lock must resolve below public/data/world/source-locks');
  const bytes = readFileSync(resolved);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256, `Source lock bytes do not match ${descriptor.id}`);
  const lock = JSON.parse(bytes.toString('utf8'));
  assert.equal(lock.id, descriptor.id, 'Source lock descriptor id does not match lock');
  return lock;
}

function assertLockPurpose(descriptor, lock) {
  if (descriptor.purpose === 'geometry') {
    assert.equal(lock.status, 'production-horizontal-geometry-authorized', `Geometry source lock ${lock.id} is not production authorized`);
    assert.equal(lock.scope, 'production-horizontal-geometry-authorized', `Geometry source lock ${lock.id} has an unauthorized scope`);
    assert(typeof lock.sourceId === 'string' && lock.sourceId.length > 0, `Geometry source lock ${lock.id} must bind an exact source id`);
    assert(typeof lock.nativeHorizontalCrs === 'string' && lock.nativeHorizontalCrs.length > 0, `Geometry source lock ${lock.id} must bind an exact native horizontal CRS`);
    assert(['NAVD88', 'not-provided-by-2d-source'].includes(lock.nativeVerticalDatum), `Geometry source lock ${lock.id} must declare either NAVD88 or an explicitly 2D source`);
    if (lock.nativeVerticalDatum === 'not-provided-by-2d-source') {
      const raw = lock.source?.snapshot;
      assert(raw && typeof raw.localPath === 'string' && raw.localPath.startsWith('public/data/'), `Geometry source lock ${lock.id} must identify raw source bytes`);
      const rawBytes = readFileSync(path.resolve(ROOT, raw.localPath));
      assert.equal(rawBytes.length, raw.bytes, `Geometry source bytes do not match ${lock.id}`);
      assert.equal(createHash('sha256').update(rawBytes).digest('hex'), raw.sha256, `Geometry source hash does not match ${lock.id}`);
    }
  } else if (descriptor.purpose === 'horizontal-coordinate-operation') {
    assert.equal(lock.kind, 'earth-horizontal-crs-source-lock', `Horizontal lock ${lock.id} has the wrong kind`);
    assert.equal(lock.status, 'source-locked-generic-operation-only', `Horizontal lock ${lock.id} is not the authorized generic operation`);
    assert.equal(lock.claims?.operation?.combinedAccuracyMetres, 4, `Horizontal lock ${lock.id} must preserve the 4 m floor`);
  } else if (descriptor.purpose === 'vertical-datum-transform') {
    assert.equal(lock.status, 'production-vertical-datum-transform-authorized', `Vertical lock ${lock.id} is not production authorized`);
    assert.equal(lock.targetVerticalDatum, 'NAVD88', `Vertical lock ${lock.id} must target NAVD88`);
  } else if (descriptor.purpose === 'terrain-elevation') {
    assert.equal(lock.status, 'source-declared-navd88-unrealized-elevation-sampling-authorized', `Terrain elevation lock ${lock.id} is not honestly limited to source-declared elevation sampling`);
    assert.equal(lock.scope, 'provisional-elevation-sampling-only-vertical-production-prohibited', `Terrain elevation lock ${lock.id} has an unauthorized scope`);
    assert.equal(lock.targetVerticalDatum, 'source-declared-navd88-unrealized', `Terrain elevation lock ${lock.id} must not claim realized NAVD88`);
    assert.match(lock.sourceRaster?.sha256 || '', /^[a-f0-9]{64}$/, `Terrain elevation lock ${lock.id} must bind exact raster bytes`);
    const sourceDescriptor = lock.sourceLock;
    assert(sourceDescriptor && typeof sourceDescriptor.path === 'string' && sourceDescriptor.path.startsWith('public/data/world/source-locks/'), `Terrain elevation lock ${lock.id} must bind its source lock`);
    const sourceBytes = readFileSync(path.resolve(ROOT, sourceDescriptor.path));
    assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), sourceDescriptor.sha256, `Terrain elevation source lock bytes do not match ${lock.id}`);
    const sourceLock = JSON.parse(sourceBytes.toString('utf8'));
    assert.equal(sourceLock.id, sourceDescriptor.id, `Terrain elevation source lock id does not match ${lock.id}`);
    assert.equal(sourceLock.coordinateReference?.vertical?.declaredByProductMetadata, 'NAVD88', `Terrain elevation source lock ${lock.id} lacks its source metadata declaration`);
    assert.match(sourceLock.coordinateReference?.vertical?.geoidAndEpochStatus || '', /not locked/, `Terrain elevation source lock ${lock.id} must retain the unresolved geoid/epoch limitation`);
    assert.equal(sourceLock.raster?.sha256, lock.sourceRaster.sha256, `Terrain elevation raster bytes do not match ${lock.id}`);
    const rawRasterPath = path.resolve(ROOT, sourceLock.raster?.localRawCache || '');
    assert(existsSync(rawRasterPath), `Terrain elevation lock ${lock.id} requires the byte-locked raw raster on disk`);
    const rawRasterBytes = readFileSync(rawRasterPath);
    assert.equal(createHash('sha256').update(rawRasterBytes).digest('hex'), lock.sourceRaster.sha256, `Terrain elevation raster file hash does not match ${lock.id}`);
  } else {
    assert.fail(`Unsupported source lock purpose: ${descriptor.purpose}`);
  }
}

async function assertTerrainSampleComputation(evidence, elevationLock) {
  assert.equal(evidence.sampleMethod, 'direct-native-pixel-float32-le', 'Only the reproducible direct native-pixel sample method is authorized while vertical realization is unresolved');
  const sourceLock = JSON.parse(readFileSync(path.resolve(ROOT, elevationLock.sourceLock.path), 'utf8'));
  const reader = await openGeoTiffWindowReader(path.resolve(ROOT, sourceLock.raster.localRawCache));
  try {
    const { column, row, width, height } = evidence.nativePixelWindow;
    assert.equal(width, 1, 'Unrealized source-declared samples must use one direct native pixel');
    assert.equal(height, 1, 'Unrealized source-declared samples must use one direct native pixel');
    const window = await reader.readWindow({ column, row, width, height });
    const windowBytes = Buffer.allocUnsafe(4);
    windowBytes.writeFloatLE(window.values[0]);
    assert.deepEqual(evidence.compressedTileIndices, window.tileIndices, 'Terrain sample tile evidence does not match the actual GeoTIFF window read');
    assert.equal(evidence.compressedTileBytesRead, window.bytesRead, 'Terrain sample compressed byte evidence does not match the actual GeoTIFF window read');
    assert.equal(evidence.sampleWindowSha256, `sha256:${createHash('sha256').update(windowBytes).digest('hex')}`, 'Terrain sample window bytes do not match the actual GeoTIFF computation');
    assert.equal(evidence.sampledSourceDeclaredNavd88UnrealizedMetres, window.values[0], 'Terrain sampled elevation does not match the actual GeoTIFF computation');
  } finally { await reader.close(); }
}

export function validateContract(contract) {
  assertExactKeys(contract, ['schemaVersion', 'kind', 'id', 'status', 'scope', 'coordinateReference', 'authorizedHorizontalTransform', 'runtimeAxes', 'scale', 'tiling', 'featureIntegrity', 'lod', 'accuracy', 'provenance'], 'Contract');
  assert.equal(contract.schemaVersion, 1, 'Unsupported contract schemaVersion');
  assert.equal(contract.kind, 'sf-one-to-one-map-contract', 'Unexpected contract kind');
  assert.equal(contract.id, 'sf-one-to-one-reality-v1', 'Unexpected contract id');
  assert.equal(contract.coordinateReference?.horizontal?.crs, 'EPSG:26910', 'Horizontal CRS must be EPSG:26910');
  assertExactKeys(contract.coordinateReference, ['horizontal', 'vertical', 'runtimeFrame'], 'Contract coordinateReference');
  assertExactKeys(contract.coordinateReference.horizontal, ['crs', 'name', 'unit', 'authority'], 'Contract horizontal reference');
  assert.equal(contract.coordinateReference?.horizontal?.unit, 'metre', 'Horizontal unit must be metre');
  assert.equal(contract.coordinateReference?.vertical?.datum, 'NAVD88', 'Production vertical datum target must remain NAVD88');
  assertExactKeys(contract.coordinateReference.vertical, ['datum', 'quantity', 'unit', 'missingDatumPolicy'], 'Contract vertical reference');
  assert.equal(contract.coordinateReference?.vertical?.quantity, 'orthometric-height', 'Vertical quantity must be orthometric height');
  assert.equal(contract.coordinateReference?.vertical?.unit, 'metre', 'Vertical unit must be metre');
  assert.equal(contract.coordinateReference?.vertical?.missingDatumPolicy, 'realized-navd88-or-provisional-source-declared-elevation-or-reject-source', 'Vertical datum policy must preserve the unresolved-elevation limitation');
  assert.equal(contract.coordinateReference?.runtimeFrame, RUNTIME_FRAME, 'Preview frames are not a production frame');
  assertExactKeys(contract.authorizedHorizontalTransform, ['id', 'path', 'absoluteHorizontalAccuracyFloorMetres', 'nad83Realization', 'coordinateEpoch', 'note'], 'Authorized horizontal transform');
  assert.deepEqual(contract.authorizedHorizontalTransform, { ...TRANSFORM_LOCK, note: 'EPSG:26910 establishes metre coordinates and not an absolute source-alignment guarantee.' }, 'Authorized horizontal transform drifted');
  assert.deepEqual(contract.runtimeAxes, AXES, 'Runtime axes must be x=east, y=up, z=north');
  assert.equal(contract.scale?.runtimeUnitsPerMetre, 1, 'Runtime scale must be one unit per metre');
  assert.equal(contract.scale?.horizontalScale, 1, 'Horizontal scale must be 1');
  assert.equal(contract.scale?.verticalScale, 1, 'Vertical scale must be 1');
  assert.equal(contract.scale?.verticalExaggeration, 0, 'Vertical exaggeration must be 0');
  assert.equal(contract.scale?.globalRepositioningAllowed, false, 'Global repositioning is prohibited');
  assert.equal(contract.scale?.globalRescalingAllowed, false, 'Global rescaling is prohibited');
  assert.equal(contract.tiling?.scheme, 'rectilinear-utm', 'Tiles must use the rectilinear UTM grid');
  assert.equal(contract.tiling?.tileSizeMetres, 384, 'Tiles must be 384 m');
  assert.equal(contract.tiling?.sourceBufferMetres, 16, 'Source buffer must be 16 m');
  assert.equal(contract.featureIntegrity?.sourceFeaturePositions, 'unchanged-after-crs-transform', 'Source positions must not drift');
  assertExactKeys(contract.featureIntegrity, ['sourceFeaturePositions', 'allowedOperations', 'prohibitedOperations', 'topologyRepair'], 'Feature integrity');
  assert.deepEqual(contract.featureIntegrity.prohibitedOperations, ['preview-frame-placement', 'art-directed-global-offset', 'global-scale', 'vertical-exaggeration'], 'Feature-integrity prohibitions drifted');
  assert.equal(contract.lod?.permittedChange, 'topology-only-within-error-budget; package may declare any contiguous available LOD range beginning at LOD0', 'LOD availability policy drifted');
  assert.equal(contract.accuracy?.claim, 'source-qualified', 'Accuracy must be source-qualified');
  assert.equal(contract.accuracy?.absoluteHorizontalAccuracyFloorMetres, 4, 'The current source alignment floor is 4 m');
  assert.equal(contract.accuracy?.lodErrorIsNotAbsoluteAccuracy, true, 'LOD error may not be presented as absolute accuracy');
  assert.deepEqual(contract.provenance?.requiredForEverySourceFeature, REQUIRED_PROVENANCE, 'Source provenance fields drifted');
  assert.deepEqual(contract.provenance?.sourceLockDescriptor, SOURCE_LOCK_KEYS, 'Source-lock descriptor fields drifted');
  assert.equal(contract.provenance?.sourceLockDirectory, 'public/data/world/source-locks', 'Source locks must stay in the checked-in directory');
  assert.equal(contract.provenance?.rejectWhenVerticalDatumMissing, false, 'Two-dimensional geometry must be handled only through terrain sampling');
  assert.equal(contract.provenance?.twoDimensionalGeometryPolicy, 'A source without a native vertical datum is valid only in terrain-sampled-source-declared-navd88-unrealized mode with a byte-locked provisional terrain elevation source and per-feature source-window computation evidence. It cannot certify a vertically production-ready or fully production 1:1 tile until a realized NAVD88 source is separately locked.', 'Two-dimensional geometry policy drifted');
  return contract;
}

export async function validateMapPackage(mapPackage, { resolveLock = realSourceLockResolver } = {}) {
  assertExactKeys(mapPackage, PACKAGE_KEYS, 'Map package');
  assert.equal(mapPackage.schemaVersion, 1, 'Unsupported package schemaVersion');
  assert.equal(mapPackage.kind, 'sf-one-to-one-map-package', 'Unexpected package kind');
  assert(['production-vertical-certified', 'provisional-vertical-unrealized'].includes(mapPackage.status), 'Package vertical certification status is required');
  assert.equal(mapPackage.contractId, 'sf-one-to-one-reality-v1', 'Package must identify this contract');
  assert.deepEqual(mapPackage.authorizedHorizontalTransform, TRANSFORM_LOCK, 'Package must use the authorized generic transform lock');
  assert.deepEqual(mapPackage.accuracyQualification, ACCURACY_QUALIFICATION, 'Package accuracy qualification must preserve the 4 m floor and unclaimed realization/epoch');
  assert.equal(mapPackage.coordinateReference?.horizontal?.crs, 'EPSG:26910', 'Package horizontal CRS must be EPSG:26910');
  assert.equal(mapPackage.coordinateReference?.horizontal?.unit, 'metre', 'Package horizontal unit must be metre');
  assert(['NAVD88', 'source-declared-navd88-unrealized'].includes(mapPackage.coordinateReference?.vertical?.datum), 'Package vertical datum must be NAVD88 or honestly source-declared unresolved');
  assert.equal(mapPackage.coordinateReference?.vertical?.unit, 'metre', 'Package vertical unit must be metre');
  assert([RUNTIME_FRAME, PROVISIONAL_RUNTIME_FRAME].includes(mapPackage.coordinateReference?.runtimeFrame), 'Package must use an approved non-preview coordinate frame');
  assert.deepEqual(mapPackage.runtimeAxes, AXES, 'Package runtime axes drifted');
  assert.deepEqual(mapPackage.scale, SCALE, 'Package scale or vertical exaggeration drifted');
  assert.deepEqual(mapPackage.tiling, TILING, 'Package tiling drifted');
  assertPosition('tileOriginEpsg26910VerticalMetres', mapPackage.tileOriginEpsg26910VerticalMetres);
  if (mapPackage.status === 'production-vertical-certified') {
    assert.equal(mapPackage.coordinateReference.vertical.datum, 'NAVD88', 'A vertically certified package must use NAVD88');
    assert.equal(mapPackage.coordinateReference.runtimeFrame, RUNTIME_FRAME, 'A vertically certified package must use the production runtime frame');
    assert.equal(mapPackage.verticalCertification, 'realized-navd88', 'A vertically certified package must state realized NAVD88');
  } else {
    assert.equal(mapPackage.coordinateReference.vertical.datum, 'source-declared-navd88-unrealized', 'A provisional package must not claim realized NAVD88');
    assert.equal(mapPackage.coordinateReference.runtimeFrame, PROVISIONAL_RUNTIME_FRAME, 'A provisional package must use the provisional runtime frame');
    assert.equal(mapPackage.verticalCertification, 'source-declared-navd88-unrealized', 'A provisional package must retain its unresolved vertical status');
  }
  assert(Array.isArray(mapPackage.sourceLocks) && mapPackage.sourceLocks.length >= 2, 'Package needs checked-in source lock descriptors');
  const locks = new Map();
  for (const descriptor of mapPackage.sourceLocks) {
    assertExactKeys(descriptor, SOURCE_LOCK_KEYS, 'Source lock descriptor');
    assert(typeof descriptor.id === 'string' && descriptor.id.length > 0, 'Source lock id is required');
    assertHash('Source lock descriptor sha256', `sha256:${descriptor.sha256}`);
    assert(!locks.has(descriptor.id), `Duplicate source lock: ${descriptor.id}`);
    const lock = resolveLock(descriptor);
    assertLockPurpose(descriptor, lock);
    locks.set(descriptor.id, { descriptor, lock });
  }
  const horizontal = locks.get(mapPackage.authorizedHorizontalTransform.id);
  assert(horizontal && horizontal.descriptor.purpose === 'horizontal-coordinate-operation', 'Authorized horizontal transform must reference its checked-in operation lock');
  assert(Array.isArray(mapPackage.sourceFeatures) && mapPackage.sourceFeatures.length > 0, 'Package needs source-feature provenance');
  for (const sourceFeature of mapPackage.sourceFeatures) {
    assertExactKeys(sourceFeature, FEATURE_KEYS, 'Source feature');
    assertNoForbiddenDependency('Source feature', sourceFeature);
    for (const field of ['sourceId', 'sourceFeatureId', 'publisher', 'license', 'nativeHorizontalCrs', 'nativeVerticalDatum', 'sourceLockId', 'horizontalTransformLockId', 'verticalMode', 'verticalTransformLockId', 'elevationSourceLockId']) assert(typeof sourceFeature[field] === 'string' && sourceFeature[field].length > 0, `Source feature is missing provenance: ${field}`);
    const sourceLock = locks.get(sourceFeature.sourceLockId);
    assert(sourceLock?.descriptor.purpose === 'geometry', 'Feature must reference a production-authorized geometry source lock');
    assert.equal(sourceFeature.sourceId, sourceLock.lock.sourceId, 'Feature source id must match its production geometry lock');
    assert.equal(sourceFeature.nativeHorizontalCrs, sourceLock.lock.nativeHorizontalCrs, 'Feature native horizontal CRS must match its production geometry lock');
    assert.equal(sourceFeature.nativeVerticalDatum, sourceLock.lock.nativeVerticalDatum, 'Feature native vertical datum must match its geometry source lock');
    assert.equal(sourceFeature.horizontalTransformLockId, mapPackage.authorizedHorizontalTransform.id, 'Feature must use the exact authorized horizontal transform lock');
    assert.equal(locks.get(sourceFeature.horizontalTransformLockId)?.descriptor.purpose, 'horizontal-coordinate-operation', 'Feature horizontal transform lock is not authorized');
    if (sourceFeature.verticalMode === 'native-navd88') {
      assert.equal(sourceFeature.nativeVerticalDatum, 'NAVD88', 'native-navd88 requires a source-native NAVD88 declaration');
      assert.equal(sourceFeature.verticalTransformLockId, 'identity-navd88', 'native-navd88 must use identity-navd88');
      assert.equal(sourceFeature.elevationSourceLockId, 'not-applicable', 'native-navd88 must not use terrain elevation');
      assert.equal(sourceFeature.elevationSampleEvidence, 'not-applicable', 'native-navd88 must not supply terrain evidence');
    } else if (sourceFeature.verticalMode === 'terrain-sampled-source-declared-navd88-unrealized') {
      assert.equal(sourceFeature.nativeVerticalDatum, 'not-provided-by-2d-source', 'Terrain-sampled geometry must not fake a native vertical datum');
      assert.equal(mapPackage.status, 'provisional-vertical-unrealized', 'Source-declared terrain samples must not certify vertical production');
      assert.equal(sourceFeature.verticalTransformLockId, 'terrain-sample-source-declared-navd88-unrealized', 'Terrain-sampled geometry must identify its unresolved vertical source status');
      const elevationLock = locks.get(sourceFeature.elevationSourceLockId);
      assert.equal(elevationLock?.descriptor.purpose, 'terrain-elevation', 'Terrain-sampled geometry requires an authorized terrain elevation lock');
      assertExactKeys(sourceFeature.elevationSampleEvidence, ELEVATION_SAMPLE_EVIDENCE_KEYS, 'Terrain elevation sample evidence');
      assert.equal(sourceFeature.elevationSampleEvidence.rasterSha256, elevationLock.lock.sourceRaster.sha256, 'Terrain sample must bind the authorized terrain raster bytes');
      assertExactKeys(sourceFeature.elevationSampleEvidence.nativePixelWindow, ['column', 'row', 'width', 'height'], 'Terrain native pixel window');
      for (const key of ['column', 'row', 'width', 'height']) assert(Number.isInteger(sourceFeature.elevationSampleEvidence.nativePixelWindow[key]) && sourceFeature.elevationSampleEvidence.nativePixelWindow[key] >= 0, `Terrain native pixel window ${key} must be a non-negative integer`);
      assert(Array.isArray(sourceFeature.elevationSampleEvidence.compressedTileIndices) && sourceFeature.elevationSampleEvidence.compressedTileIndices.length > 0 && sourceFeature.elevationSampleEvidence.compressedTileIndices.every(Number.isInteger), 'Terrain sample must identify the compressed source tile(s) read');
      assert(Number.isSafeInteger(sourceFeature.elevationSampleEvidence.compressedTileBytesRead) && sourceFeature.elevationSampleEvidence.compressedTileBytesRead > 0, 'Terrain sample must record compressed source bytes read');
      assert(typeof sourceFeature.elevationSampleEvidence.sampleMethod === 'string' && sourceFeature.elevationSampleEvidence.sampleMethod.length > 0, 'Terrain sample method is required');
      assert(isFiniteNumber(sourceFeature.elevationSampleEvidence.sampledSourceDeclaredNavd88UnrealizedMetres), 'Terrain sample must record its source-declared unresolved height');
      assertHash('elevationSampleEvidence.sampleWindowSha256', sourceFeature.elevationSampleEvidence.sampleWindowSha256);
      assertHash('elevationSampleEvidence.evidenceSha256', sourceFeature.elevationSampleEvidence.evidenceSha256);
      if (resolveLock === realSourceLockResolver) await assertTerrainSampleComputation(sourceFeature.elevationSampleEvidence, elevationLock.lock);
      assert.equal(sourceFeature.transformedPositionEpsg26910VerticalMetres[2], sourceFeature.elevationSampleEvidence.sampledSourceDeclaredNavd88UnrealizedMetres, 'Terrain-sampled transformed height must equal the recorded source-window computation');
    } else if (sourceFeature.verticalMode === 'vertical-transform-navd88') {
      assert.notEqual(sourceFeature.nativeVerticalDatum, 'unknown', 'Source vertical datum must be known for a datum transform');
      assert.equal(sourceFeature.elevationSourceLockId, 'not-applicable', 'Vertical transform must not use terrain elevation');
      assert.equal(sourceFeature.elevationSampleEvidence, 'not-applicable', 'Vertical transform must not supply terrain evidence');
      assert.equal(locks.get(sourceFeature.verticalTransformLockId)?.descriptor.purpose, 'vertical-datum-transform', 'Feature vertical transform lock is not authorized');
    } else assert.fail(`Unsupported feature vertical mode: ${sourceFeature.verticalMode}`);
    assertDate('sourceFeature.retrievedAt', sourceFeature.retrievedAt);
    assertHash('sourceFeature.sourceGeometryHash', sourceFeature.sourceGeometryHash);
    assertPosition('sourceFeature.nativeHorizontalPosition', sourceFeature.nativeHorizontalPosition);
    assertPosition('sourceFeature.transformedPositionEpsg26910VerticalMetres', sourceFeature.transformedPositionEpsg26910VerticalMetres);
    assertPosition('sourceFeature.runtimePositionMetres', sourceFeature.runtimePositionMetres);
    const transformed = sourceFeature.transformedPositionEpsg26910VerticalMetres;
    const origin = mapPackage.tileOriginEpsg26910VerticalMetres;
    const expectedRuntime = [transformed[0] - origin[0], transformed[2] - origin[2], transformed[1] - origin[1]];
    for (let index = 0; index < 3; index += 1) assert(Math.abs(sourceFeature.runtimePositionMetres[index] - expectedRuntime[index]) <= POSITION_TOLERANCE_METRES, 'Runtime position must equal [east-originEast, height-originHeight, north-originNorth] without scale or offset');
  }
  assert(Array.isArray(mapPackage.lods) && mapPackage.lods.length >= 1, 'Package must declare at least its available LOD0');
  assert.deepEqual(mapPackage.lods.map(({ level }) => level), Array.from({ length: mapPackage.lods.length }, (_, level) => level), 'Declared LOD levels must be contiguous and begin at LOD0');
  for (const lod of mapPackage.lods) {
    assertExactKeys(lod, LOD_KEYS, `LOD ${lod.level}`);
    assert.equal(lod.runtimeFrame, mapPackage.coordinateReference.runtimeFrame, `LOD ${lod.level} must stay in the package runtime frame`);
    assert.deepEqual(lod.scale, [1, 1, 1], `LOD ${lod.level} may not rescale`);
    assert.deepEqual(lod.translationMetres, [0, 0, 0], `LOD ${lod.level} may not relocate`);
    assert(isFiniteNumber(lod.maxHorizontalDeviationMetres) && lod.maxHorizontalDeviationMetres >= 0 && lod.maxHorizontalDeviationMetres <= 0.5, `LOD ${lod.level} horizontal error exceeds contract`);
    assert(isFiniteNumber(lod.maxVerticalDeviationMetres) && lod.maxVerticalDeviationMetres >= 0 && lod.maxVerticalDeviationMetres <= 0.25, `LOD ${lod.level} vertical error exceeds contract`);
    assertHash(`LOD ${lod.level} artifactHash`, lod.artifactHash);
  }
  return mapPackage;
}

function positiveFixture() {
  const origin = [551000, 4180000, 10];
  const transformed = [551012.5, 4180014.25, 27.5];
  const hash = `sha256:${'a'.repeat(64)}`;
  const horizontalLockHash = 'd5a86d211be380eec4bc03ff5e97dbef4dfaf2866578ab5330c90c7b586fcc21';
  const geometryLockHash = 'b'.repeat(64);
  return {
    schemaVersion: 1, kind: 'sf-one-to-one-map-package', status: 'provisional-vertical-unrealized', contractId: 'sf-one-to-one-reality-v1',
    coordinateReference: { horizontal: { crs: 'EPSG:26910', unit: 'metre' }, vertical: { datum: 'source-declared-navd88-unrealized', unit: 'metre' }, runtimeFrame: PROVISIONAL_RUNTIME_FRAME }, verticalCertification: 'source-declared-navd88-unrealized',
    runtimeAxes: AXES, scale: SCALE, tiling: TILING, tileOriginEpsg26910VerticalMetres: origin,
    authorizedHorizontalTransform: TRANSFORM_LOCK, accuracyQualification: ACCURACY_QUALIFICATION,
    sourceLocks: [
      { id: 'fixture-production-geometry-v1', path: 'public/data/world/source-locks/fixture-production-geometry-v1.lock.json', sha256: geometryLockHash, purpose: 'geometry' },
      { id: 'sf-ferry-3dep-2023-horizontal-crs-v1', path: 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json', sha256: horizontalLockHash, purpose: 'horizontal-coordinate-operation' },
      { id: 'fixture-terrain-elevation-v1', path: 'public/data/world/source-locks/fixture-terrain-elevation-v1.lock.json', sha256: 'c'.repeat(64), purpose: 'terrain-elevation' },
    ],
    sourceFeatures: [{
      sourceId: 'authoritative-example', sourceFeatureId: 'feature-001', publisher: 'example-authority', license: 'documented-license', retrievedAt: '2026-08-12', nativeHorizontalCrs: 'EPSG:4326', nativeVerticalDatum: 'not-provided-by-2d-source', sourceLockId: 'fixture-production-geometry-v1', horizontalTransformLockId: 'sf-ferry-3dep-2023-horizontal-crs-v1', verticalMode: 'terrain-sampled-source-declared-navd88-unrealized', verticalTransformLockId: 'terrain-sample-source-declared-navd88-unrealized', elevationSourceLockId: 'fixture-terrain-elevation-v1', elevationSampleEvidence: { rasterSha256: '9cc9c03f4ddaf8ec6712951b980157ea02293c7723761466e6e60f21147a9424', nativePixelWindow: { column: 1019, row: 9992, width: 1, height: 1 }, compressedTileIndices: [381], compressedTileBytesRead: 443008, sampleMethod: 'direct-native-pixel-float32-le', sampledSourceDeclaredNavd88UnrealizedMetres: 11.382290840148926, sampleWindowSha256: 'sha256:2cf59d63ccd657f4230ffbcf1dbb67cc1b220727f545bc4ee2f2ab76e626e8ce', evidenceSha256: hash }, sourceGeometryHash: hash, nativeHorizontalPosition: [-122.4, 37.79, 0], transformedPositionEpsg26910VerticalMetres: [551012.5, 4180014.25, 11.382290840148926], runtimePositionMetres: [12.5, 1.3822908401489258, 14.25],
    }],
    lods: [0, 1, 2].map((level) => ({ level, runtimeFrame: PROVISIONAL_RUNTIME_FRAME, scale: [1, 1, 1], translationMetres: [0, 0, 0], maxHorizontalDeviationMetres: 0.5, maxVerticalDeviationMetres: 0.25, artifactHash: hash })),
  };
}

function fixtureLockResolver(descriptor) {
  const locks = {
    'fixture-production-geometry-v1': { id: 'fixture-production-geometry-v1', status: 'production-horizontal-geometry-authorized', scope: 'production-horizontal-geometry-authorized', nativeVerticalDatum: 'not-provided-by-2d-source', sourceId: 'authoritative-example', nativeHorizontalCrs: 'EPSG:4326', source: { snapshot: { localPath: 'public/data/sf/SanFrancisco.osm.pbf', bytes: 32742133, sha256: 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae' } } },
    'fixture-native-navd88-geometry-v1': { id: 'fixture-native-navd88-geometry-v1', status: 'production-horizontal-geometry-authorized', scope: 'production-horizontal-geometry-authorized', nativeVerticalDatum: 'NAVD88', sourceId: 'native-navd88-example', nativeHorizontalCrs: 'EPSG:26910' },
    'sf-ferry-3dep-2023-horizontal-crs-v1': { id: 'sf-ferry-3dep-2023-horizontal-crs-v1', kind: 'earth-horizontal-crs-source-lock', status: 'source-locked-generic-operation-only', claims: { operation: { combinedAccuracyMetres: 4 } } },
    'fixture-terrain-elevation-v1': { id: 'fixture-terrain-elevation-v1', status: 'source-declared-navd88-unrealized-elevation-sampling-authorized', scope: 'provisional-elevation-sampling-only-vertical-production-prohibited', targetVerticalDatum: 'source-declared-navd88-unrealized', sourceLock: { id: 'sf-ferry-3dep-2023', path: 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json', sha256: '3751942da71cf0714827f809803ffb44dc1143430e350f8d0b1bd23da6da651b' }, sourceRaster: { sha256: '9cc9c03f4ddaf8ec6712951b980157ea02293c7723761466e6e60f21147a9424' } },
  };
  const lock = locks[descriptor.id];
  assert(lock, `Unknown fixture lock ${descriptor.id}`);
  return lock;
}

function expectRejected(name, mutator) {
  const candidate = clone(positiveFixture());
  mutator(candidate);
  return assert.rejects(() => validateMapPackage(candidate, { resolveLock: fixtureLockResolver }), undefined, `${name} mutation must be rejected`);
}

function nativeNavd88Fixture() {
  const candidate = clone(positiveFixture());
  candidate.sourceLocks.push({ id: 'fixture-native-navd88-geometry-v1', path: 'public/data/world/source-locks/fixture-native-navd88-geometry-v1.lock.json', sha256: 'e'.repeat(64), purpose: 'geometry' });
  Object.assign(candidate.sourceFeatures[0], {
    sourceId: 'native-navd88-example', nativeHorizontalCrs: 'EPSG:26910', nativeVerticalDatum: 'NAVD88',
    sourceLockId: 'fixture-native-navd88-geometry-v1', verticalMode: 'native-navd88', verticalTransformLockId: 'identity-navd88',
    elevationSourceLockId: 'not-applicable', elevationSampleEvidence: 'not-applicable', nativeHorizontalPosition: [551012.5, 4180014.25, 27.5],
  });
  Object.assign(candidate, { status: 'production-vertical-certified', verticalCertification: 'realized-navd88', coordinateReference: { horizontal: { crs: 'EPSG:26910', unit: 'metre' }, vertical: { datum: 'NAVD88', unit: 'metre' }, runtimeFrame: RUNTIME_FRAME } });
  candidate.lods.forEach((lod) => { lod.runtimeFrame = RUNTIME_FRAME; });
  return candidate;
}

function lod0OnlyFixture() {
  const candidate = clone(positiveFixture());
  candidate.lods = [candidate.lods[0]];
  return candidate;
}

function realProvisionalSampleEvidence() {
  return {
    rasterSha256: '9cc9c03f4ddaf8ec6712951b980157ea02293c7723761466e6e60f21147a9424',
    nativePixelWindow: { column: 1019, row: 9992, width: 1, height: 1 },
    compressedTileIndices: [381], compressedTileBytesRead: 443008,
    sampleMethod: 'direct-native-pixel-float32-le',
    sampledSourceDeclaredNavd88UnrealizedMetres: 11.382290840148926,
    sampleWindowSha256: 'sha256:2cf59d63ccd657f4230ffbcf1dbb67cc1b220727f545bc4ee2f2ab76e626e8ce',
    evidenceSha256: `sha256:${'a'.repeat(64)}`,
  };
}

const contract = validateContract(loadJson(CONTRACT_PATH));
const packagePath = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : null;
if (packagePath) await validateMapPackage(loadJson(packagePath));
await validateMapPackage(positiveFixture(), { resolveLock: fixtureLockResolver });
await validateMapPackage(nativeNavd88Fixture(), { resolveLock: fixtureLockResolver });
await validateMapPackage(lod0OnlyFixture(), { resolveLock: fixtureLockResolver });
const realElevationDescriptor = { id: 'sf-ferry-3dep-terrain-elevation-authorized-v1', path: 'public/data/world/source-locks/sf-ferry-3dep-terrain-elevation-authorized-v1.lock.json', sha256: '7ff0e3c8d171036af707c7e4445cde66a100af41251de0b8955ee881484fc619', purpose: 'terrain-elevation' };
const realElevationLock = realSourceLockResolver(realElevationDescriptor);
assertLockPurpose(realElevationDescriptor, realElevationLock);
await assertTerrainSampleComputation(realProvisionalSampleEvidence(), realElevationLock);
const wrongComputedSample = realProvisionalSampleEvidence();
wrongComputedSample.sampleWindowSha256 = `sha256:${'0'.repeat(64)}`;
await assert.rejects(() => assertTerrainSampleComputation(wrongComputedSample, realElevationLock), /sample window bytes/, 'Wrong GeoTIFF sample-window computation evidence must be rejected');
await expectRejected('wrong CRS', (candidate) => { candidate.coordinateReference.horizontal.crs = 'EPSG:3857'; });
await expectRejected('wrong unit', (candidate) => { candidate.coordinateReference.horizontal.unit = 'foot'; });
await expectRejected('wrong axis', (candidate) => { candidate.runtimeAxes.z = 'south'; });
await expectRejected('vertical exaggeration', (candidate) => { candidate.scale.verticalExaggeration = 1.25; });
await expectRejected('preview frame', (candidate) => { candidate.coordinateReference.runtimeFrame = 'preview-local-frame'; });
await expectRejected('preview source', (candidate) => { candidate.sourceFeatures[0].sourceId = 'sf-atlas-linear-v1'; });
await expectRejected('bad hash', (candidate) => { candidate.sourceFeatures[0].sourceGeometryHash = 'sha256:fixture'; });
await expectRejected('position relocation', (candidate) => { candidate.sourceFeatures[0].runtimePositionMetres[0] += 1; });
await expectRejected('LOD rescale', (candidate) => { candidate.lods[1].scale = [0.2, 0.2, 0.2]; });
await expectRejected('LOD frame', (candidate) => { candidate.lods[1].runtimeFrame = 'preview-local-frame'; });
await expectRejected('LOD translation', (candidate) => { candidate.lods[1].translationMetres = [1, 0, 0]; });
await expectRejected('LOD gap', (candidate) => { candidate.lods = [candidate.lods[0], { ...candidate.lods[2], level: 2 }]; });
await expectRejected('missing coordinate evidence', (candidate) => { delete candidate.sourceFeatures[0].transformedPositionEpsg26910VerticalMetres; });
await expectRejected('unauthorized transform', (candidate) => { candidate.authorizedHorizontalTransform.id = 'direct-utm-preview-bridge'; });
await expectRejected('unsupported absolute accuracy', (candidate) => { candidate.accuracyQualification.absoluteHorizontalAccuracyFloorMetres = 0.5; });
await expectRejected('missing accuracy qualification', (candidate) => { delete candidate.accuracyQualification; });
await expectRejected('disguised atlas source', (candidate) => { candidate.sourceFeatures[0].sourceId = 'sf-atlas'; candidate.sourceFeatures[0].nativeHorizontalCrs = 'sf-atlas'; });
await expectRejected('preview-only lock', (candidate) => { candidate.sourceLocks[0].id = 'sf-ferry-sf-atlas-linear-to-epsg26910-v1'; candidate.sourceFeatures[0].sourceLockId = 'sf-ferry-sf-atlas-linear-to-epsg26910-v1'; });
await expectRejected('two-dimensional source fakes NAVD88', (candidate) => { candidate.sourceFeatures[0].nativeVerticalDatum = 'NAVD88'; });
await expectRejected('terrain sample missing elevation lock', (candidate) => { candidate.sourceFeatures[0].elevationSourceLockId = 'not-applicable'; });
await expectRejected('terrain sample missing evidence', (candidate) => { candidate.sourceFeatures[0].elevationSampleEvidence = 'not-applicable'; });
await expectRejected('wrong terrain raster hash', (candidate) => { candidate.sourceFeatures[0].elevationSampleEvidence.rasterSha256 = '0'.repeat(64); });
await expectRejected('unrealized terrain falsely certified', (candidate) => { candidate.status = 'production-vertical-certified'; candidate.verticalCertification = 'realized-navd88'; candidate.coordinateReference.vertical.datum = 'NAVD88'; candidate.coordinateReference.runtimeFrame = RUNTIME_FRAME; candidate.lods.forEach((lod) => { lod.runtimeFrame = RUNTIME_FRAME; }); });
await expectRejected('arbitrary per-feature transform', (candidate) => { candidate.sourceFeatures[0].horizontalTransform = { id: 'unlocked-per-feature-transform' }; });

console.log(JSON.stringify({
  result: 'SF 1:1 map contract passed',
  contract: contract.id,
  packageArtifactVerified: Boolean(packagePath),
  packageArtifact: packagePath ? path.relative(ROOT, packagePath) : null,
  negativeFixtures: ['wrong-crs', 'wrong-unit', 'wrong-axis', 'vertical-exaggeration', 'preview-frame', 'preview-source', 'bad-hash', 'position-relocation', 'lod-rescale', 'lod-frame', 'lod-translation', 'lod-gap', 'missing-coordinate-evidence', 'unauthorized-transform', 'unsupported-absolute-accuracy', 'missing-accuracy-qualification', 'disguised-atlas-source', 'preview-only-lock', 'two-dimensional-source-fakes-navd88', 'terrain-sample-missing-elevation-lock', 'terrain-sample-missing-evidence', 'wrong-terrain-raster-hash', 'wrong-geotiff-sample-window-computation', 'unrealized-terrain-falsely-certified', 'arbitrary-per-feature-transform'],
}, null, 2));
