/**
 * Offline gate for the SF 1:1 coordinate contract. Pass a production package
 * descriptor path to validate it: `node ...verify-sf-one-to-one-map-contract.mjs path/to/package.json`.
 * Without a package, this only verifies the contract and its adversarial test fixtures;
 * it deliberately does not claim that any map artifact has passed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONTRACT_PATH = path.join(ROOT, 'public/data/world/contracts/sf-one-to-one-map.contract.json');
const SOURCE_LOCKS_DIR = path.join(ROOT, 'public/data/world/source-locks');
const RUNTIME_FRAME = 'production-utm-navd88';
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
  'horizontalTransformLockId', 'verticalTransformLockId', 'sourceGeometryHash', 'nativePosition',
  'transformedPositionEpsg26910Navd88Metres', 'runtimePositionMetres',
];
const PACKAGE_KEYS = [
  'schemaVersion', 'kind', 'contractId', 'coordinateReference', 'runtimeAxes',
  'scale', 'tiling', 'tileOriginEpsg26910Navd88Metres', 'sourceFeatures', 'lods',
  'authorizedHorizontalTransform', 'accuracyQualification', 'sourceLocks',
];
const FEATURE_KEYS = REQUIRED_PROVENANCE;
const SOURCE_LOCK_KEYS = ['id', 'path', 'sha256', 'purpose'];
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
    assert.equal(lock.status, 'production-geometry-authorized', `Geometry source lock ${lock.id} is not production authorized`);
    assert.equal(lock.scope, 'production-geometry-authorized', `Geometry source lock ${lock.id} has an unauthorized scope`);
    assert.equal(lock.verticalDatum, 'NAVD88', `Geometry source lock ${lock.id} must declare NAVD88`);
    assert(typeof lock.sourceId === 'string' && lock.sourceId.length > 0, `Geometry source lock ${lock.id} must bind an exact source id`);
    assert(typeof lock.nativeHorizontalCrs === 'string' && lock.nativeHorizontalCrs.length > 0, `Geometry source lock ${lock.id} must bind an exact native horizontal CRS`);
  } else if (descriptor.purpose === 'horizontal-coordinate-operation') {
    assert.equal(lock.kind, 'earth-horizontal-crs-source-lock', `Horizontal lock ${lock.id} has the wrong kind`);
    assert.equal(lock.status, 'source-locked-generic-operation-only', `Horizontal lock ${lock.id} is not the authorized generic operation`);
    assert.equal(lock.claims?.operation?.combinedAccuracyMetres, 4, `Horizontal lock ${lock.id} must preserve the 4 m floor`);
  } else if (descriptor.purpose === 'vertical-datum-transform') {
    assert.equal(lock.status, 'production-vertical-datum-transform-authorized', `Vertical lock ${lock.id} is not production authorized`);
    assert.equal(lock.targetVerticalDatum, 'NAVD88', `Vertical lock ${lock.id} must target NAVD88`);
  } else {
    assert.fail(`Unsupported source lock purpose: ${descriptor.purpose}`);
  }
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
  assert.equal(contract.coordinateReference?.vertical?.datum, 'NAVD88', 'Vertical datum must be NAVD88');
  assertExactKeys(contract.coordinateReference.vertical, ['datum', 'quantity', 'unit', 'missingDatumPolicy'], 'Contract vertical reference');
  assert.equal(contract.coordinateReference?.vertical?.quantity, 'orthometric-height', 'Vertical quantity must be orthometric height');
  assert.equal(contract.coordinateReference?.vertical?.unit, 'metre', 'Vertical unit must be metre');
  assert.equal(contract.coordinateReference?.vertical?.missingDatumPolicy, 'reject-source', 'Vertical datum policy must fail closed');
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
  assert.equal(contract.lod?.permittedChange, 'topology-only-within-error-budget', 'LOD may simplify topology only');
  assert.equal(contract.accuracy?.claim, 'source-qualified', 'Accuracy must be source-qualified');
  assert.equal(contract.accuracy?.absoluteHorizontalAccuracyFloorMetres, 4, 'The current source alignment floor is 4 m');
  assert.equal(contract.accuracy?.lodErrorIsNotAbsoluteAccuracy, true, 'LOD error may not be presented as absolute accuracy');
  assert.deepEqual(contract.provenance?.requiredForEverySourceFeature, REQUIRED_PROVENANCE, 'Source provenance fields drifted');
  assert.deepEqual(contract.provenance?.sourceLockDescriptor, SOURCE_LOCK_KEYS, 'Source-lock descriptor fields drifted');
  assert.equal(contract.provenance?.sourceLockDirectory, 'public/data/world/source-locks', 'Source locks must stay in the checked-in directory');
  assert.equal(contract.provenance?.rejectWhenVerticalDatumMissing, true, 'Missing vertical datums must be rejected');
  return contract;
}

export function validateMapPackage(mapPackage, { resolveLock = realSourceLockResolver } = {}) {
  assertExactKeys(mapPackage, PACKAGE_KEYS, 'Map package');
  assert.equal(mapPackage.schemaVersion, 1, 'Unsupported package schemaVersion');
  assert.equal(mapPackage.kind, 'sf-one-to-one-map-package', 'Unexpected package kind');
  assert.equal(mapPackage.contractId, 'sf-one-to-one-reality-v1', 'Package must identify this contract');
  assert.deepEqual(mapPackage.authorizedHorizontalTransform, TRANSFORM_LOCK, 'Package must use the authorized generic transform lock');
  assert.deepEqual(mapPackage.accuracyQualification, ACCURACY_QUALIFICATION, 'Package accuracy qualification must preserve the 4 m floor and unclaimed realization/epoch');
  assert.equal(mapPackage.coordinateReference?.horizontal?.crs, 'EPSG:26910', 'Package horizontal CRS must be EPSG:26910');
  assert.equal(mapPackage.coordinateReference?.horizontal?.unit, 'metre', 'Package horizontal unit must be metre');
  assert.equal(mapPackage.coordinateReference?.vertical?.datum, 'NAVD88', 'Package vertical datum must be NAVD88');
  assert.equal(mapPackage.coordinateReference?.vertical?.unit, 'metre', 'Package vertical unit must be metre');
  assert.equal(mapPackage.coordinateReference?.runtimeFrame, RUNTIME_FRAME, 'Package must not use a preview coordinate frame');
  assert.deepEqual(mapPackage.runtimeAxes, AXES, 'Package runtime axes drifted');
  assert.deepEqual(mapPackage.scale, SCALE, 'Package scale or vertical exaggeration drifted');
  assert.deepEqual(mapPackage.tiling, TILING, 'Package tiling drifted');
  assertPosition('tileOriginEpsg26910Navd88Metres', mapPackage.tileOriginEpsg26910Navd88Metres);
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
    for (const field of ['sourceId', 'sourceFeatureId', 'publisher', 'license', 'nativeHorizontalCrs', 'nativeVerticalDatum', 'sourceLockId', 'horizontalTransformLockId', 'verticalTransformLockId']) assert(typeof sourceFeature[field] === 'string' && sourceFeature[field].length > 0, `Source feature is missing provenance: ${field}`);
    const sourceLock = locks.get(sourceFeature.sourceLockId);
    assert(sourceLock?.descriptor.purpose === 'geometry', 'Feature must reference a production-authorized geometry source lock');
    assert.equal(sourceFeature.sourceId, sourceLock.lock.sourceId, 'Feature source id must match its production geometry lock');
    assert.equal(sourceFeature.nativeHorizontalCrs, sourceLock.lock.nativeHorizontalCrs, 'Feature native horizontal CRS must match its production geometry lock');
    assert.equal(sourceFeature.horizontalTransformLockId, mapPackage.authorizedHorizontalTransform.id, 'Feature must use the exact authorized horizontal transform lock');
    assert.equal(locks.get(sourceFeature.horizontalTransformLockId)?.descriptor.purpose, 'horizontal-coordinate-operation', 'Feature horizontal transform lock is not authorized');
    if (sourceFeature.verticalTransformLockId === 'identity-navd88') assert.equal(sourceLock.lock.verticalDatum, 'NAVD88', 'identity-navd88 requires a geometry source lock declaring NAVD88');
    else assert.equal(locks.get(sourceFeature.verticalTransformLockId)?.descriptor.purpose, 'vertical-datum-transform', 'Feature vertical transform lock is not authorized');
    assertDate('sourceFeature.retrievedAt', sourceFeature.retrievedAt);
    assertHash('sourceFeature.sourceGeometryHash', sourceFeature.sourceGeometryHash);
    assert.notEqual(sourceFeature.nativeVerticalDatum, 'unknown', 'Source vertical datum must be known');
    assertPosition('sourceFeature.nativePosition', sourceFeature.nativePosition);
    assertPosition('sourceFeature.transformedPositionEpsg26910Navd88Metres', sourceFeature.transformedPositionEpsg26910Navd88Metres);
    assertPosition('sourceFeature.runtimePositionMetres', sourceFeature.runtimePositionMetres);
    const transformed = sourceFeature.transformedPositionEpsg26910Navd88Metres;
    const origin = mapPackage.tileOriginEpsg26910Navd88Metres;
    const expectedRuntime = [transformed[0] - origin[0], transformed[2] - origin[2], transformed[1] - origin[1]];
    for (let index = 0; index < 3; index += 1) assert(Math.abs(sourceFeature.runtimePositionMetres[index] - expectedRuntime[index]) <= POSITION_TOLERANCE_METRES, 'Runtime position must equal [east-originEast, height-originHeight, north-originNorth] without scale or offset');
  }
  assert(Array.isArray(mapPackage.lods) && mapPackage.lods.length === 3, 'Package requires exactly LOD 0-2 descriptors');
  assert.deepEqual(mapPackage.lods.map(({ level }) => level), [0, 1, 2], 'LOD levels must be 0, 1, 2');
  for (const lod of mapPackage.lods) {
    assertExactKeys(lod, LOD_KEYS, `LOD ${lod.level}`);
    assert.equal(lod.runtimeFrame, RUNTIME_FRAME, `LOD ${lod.level} must stay in the production runtime frame`);
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
    schemaVersion: 1, kind: 'sf-one-to-one-map-package', contractId: 'sf-one-to-one-reality-v1',
    coordinateReference: { horizontal: { crs: 'EPSG:26910', unit: 'metre' }, vertical: { datum: 'NAVD88', unit: 'metre' }, runtimeFrame: RUNTIME_FRAME },
    runtimeAxes: AXES, scale: SCALE, tiling: TILING, tileOriginEpsg26910Navd88Metres: origin,
    authorizedHorizontalTransform: TRANSFORM_LOCK, accuracyQualification: ACCURACY_QUALIFICATION,
    sourceLocks: [
      { id: 'fixture-production-geometry-v1', path: 'public/data/world/source-locks/fixture-production-geometry-v1.lock.json', sha256: geometryLockHash, purpose: 'geometry' },
      { id: 'sf-ferry-3dep-2023-horizontal-crs-v1', path: 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json', sha256: horizontalLockHash, purpose: 'horizontal-coordinate-operation' },
    ],
    sourceFeatures: [{
      sourceId: 'authoritative-example', sourceFeatureId: 'feature-001', publisher: 'example-authority', license: 'documented-license', retrievedAt: '2026-08-12', nativeHorizontalCrs: 'EPSG:4326', nativeVerticalDatum: 'NAVD88', sourceLockId: 'fixture-production-geometry-v1', horizontalTransformLockId: 'sf-ferry-3dep-2023-horizontal-crs-v1', verticalTransformLockId: 'identity-navd88', sourceGeometryHash: hash, nativePosition: [-122.4, 37.79, 27.5], transformedPositionEpsg26910Navd88Metres: transformed, runtimePositionMetres: [12.5, 17.5, 14.25],
    }],
    lods: [0, 1, 2].map((level) => ({ level, runtimeFrame: RUNTIME_FRAME, scale: [1, 1, 1], translationMetres: [0, 0, 0], maxHorizontalDeviationMetres: 0.5, maxVerticalDeviationMetres: 0.25, artifactHash: hash })),
  };
}

function fixtureLockResolver(descriptor) {
  const locks = {
    'fixture-production-geometry-v1': { id: 'fixture-production-geometry-v1', status: 'production-geometry-authorized', scope: 'production-geometry-authorized', verticalDatum: 'NAVD88', sourceId: 'authoritative-example', nativeHorizontalCrs: 'EPSG:4326' },
    'sf-ferry-3dep-2023-horizontal-crs-v1': { id: 'sf-ferry-3dep-2023-horizontal-crs-v1', kind: 'earth-horizontal-crs-source-lock', status: 'source-locked-generic-operation-only', claims: { operation: { combinedAccuracyMetres: 4 } } },
  };
  const lock = locks[descriptor.id];
  assert(lock, `Unknown fixture lock ${descriptor.id}`);
  return lock;
}

function expectRejected(name, mutator) {
  const candidate = clone(positiveFixture());
  mutator(candidate);
  assert.throws(() => validateMapPackage(candidate, { resolveLock: fixtureLockResolver }), undefined, `${name} mutation must be rejected`);
}

const contract = validateContract(loadJson(CONTRACT_PATH));
const packagePath = process.argv[2] ? path.resolve(ROOT, process.argv[2]) : null;
if (packagePath) validateMapPackage(loadJson(packagePath));
validateMapPackage(positiveFixture(), { resolveLock: fixtureLockResolver });
expectRejected('wrong CRS', (candidate) => { candidate.coordinateReference.horizontal.crs = 'EPSG:3857'; });
expectRejected('wrong unit', (candidate) => { candidate.coordinateReference.horizontal.unit = 'foot'; });
expectRejected('wrong axis', (candidate) => { candidate.runtimeAxes.z = 'south'; });
expectRejected('vertical exaggeration', (candidate) => { candidate.scale.verticalExaggeration = 1.25; });
expectRejected('preview frame', (candidate) => { candidate.coordinateReference.runtimeFrame = 'preview-local-frame'; });
expectRejected('preview source', (candidate) => { candidate.sourceFeatures[0].sourceId = 'sf-atlas-linear-v1'; });
expectRejected('bad hash', (candidate) => { candidate.sourceFeatures[0].sourceGeometryHash = 'sha256:fixture'; });
expectRejected('position relocation', (candidate) => { candidate.sourceFeatures[0].runtimePositionMetres[0] += 1; });
expectRejected('LOD rescale', (candidate) => { candidate.lods[1].scale = [0.2, 0.2, 0.2]; });
expectRejected('LOD frame', (candidate) => { candidate.lods[1].runtimeFrame = 'preview-local-frame'; });
expectRejected('LOD translation', (candidate) => { candidate.lods[1].translationMetres = [1, 0, 0]; });
expectRejected('missing coordinate evidence', (candidate) => { delete candidate.sourceFeatures[0].transformedPositionEpsg26910Navd88Metres; });
expectRejected('unauthorized transform', (candidate) => { candidate.authorizedHorizontalTransform.id = 'direct-utm-preview-bridge'; });
expectRejected('unsupported absolute accuracy', (candidate) => { candidate.accuracyQualification.absoluteHorizontalAccuracyFloorMetres = 0.5; });
expectRejected('missing accuracy qualification', (candidate) => { delete candidate.accuracyQualification; });
expectRejected('disguised atlas source', (candidate) => { candidate.sourceFeatures[0].sourceId = 'sf-atlas'; candidate.sourceFeatures[0].nativeHorizontalCrs = 'sf-atlas'; });
expectRejected('preview-only lock', (candidate) => { candidate.sourceLocks[0].id = 'sf-ferry-sf-atlas-linear-to-epsg26910-v1'; candidate.sourceFeatures[0].sourceLockId = 'sf-ferry-sf-atlas-linear-to-epsg26910-v1'; });

console.log(JSON.stringify({
  result: 'SF 1:1 map contract passed',
  contract: contract.id,
  packageArtifactVerified: Boolean(packagePath),
  packageArtifact: packagePath ? path.relative(ROOT, packagePath) : null,
  negativeFixtures: ['wrong-crs', 'wrong-unit', 'wrong-axis', 'vertical-exaggeration', 'preview-frame', 'preview-source', 'bad-hash', 'position-relocation', 'lod-rescale', 'lod-frame', 'lod-translation', 'missing-coordinate-evidence', 'unauthorized-transform', 'unsupported-absolute-accuracy', 'missing-accuracy-qualification', 'disguised-atlas-source', 'preview-only-lock'],
}, null, 2));
