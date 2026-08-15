/**
 * Write-disabled internal source-switch continuity audit.
 *
 * This is a promotion prerequisite for the CaliforniaGaps fallback mosaic. It
 * builds the exact 25 source-ready candidate tiles once, in production source
 * selection mode with write:false, and audits every 1 m lattice neighbour whose
 * selected source authority changes inside each tile. The audit is deliberately
 * evidence-only: it reports source disagreement and continuity statistics, but
 * makes no vertical accuracy claim and never enables production writes.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildSfMetricTile,
  loadSfMetricSharedInputs,
  loadSfMetricVerifiedTerrainSourceDigests,
  loadSfNativePixelFallbackAuthorization,
} from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLAN_PATH = path.join(ROOT, 'public/data/world/plans/sf-metric-tile-coverage-v1.json');
const AUTH_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-production-authorization-v1.lock.json');
const PARITY_RECEIPT_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-production-parity-v1.receipt.json');
const PARITY_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-production-parity-v1.lock.json');
const RECEIPT_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-internal-source-switch-continuity-audit-v1.receipt.json');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-internal-source-switch-continuity-audit-v1.lock.json');
const PRODUCTION_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const SCRIPT_PATH = path.resolve(fileURLToPath(import.meta.url));
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const PACKAGE_SCRIPT_NAME = 'verify:sf-native-pixel-fallback-internal-source-switch-continuity';

const TILE_SIZE = 384;
const LATTICE_SIDE = TILE_SIZE + 1;
const LATTICE_SAMPLE_COUNT = LATTICE_SIDE ** 2;
const PRODUCTION_MODE = 'per-native-pixel-fallback-production-v1';
const AUDIT_ID = 'internal-source-switch-continuity-audit-v1';
const RECEIPT_ID = 'sf-native-pixel-fallback-internal-source-switch-continuity-audit-v1';
const WORST_EXEMPLAR_COUNT = 32;

// This inventory is intentionally repeated from the byte-locked parity
// milestone. The verifier also compares it to both the parity receipt and the
// coverage plan so a silent inventory expansion cannot pass.
const TILE_KEYS = [
  ...Array.from({ length: 24 }, (_, index) => [1417 + index, 10867]),
  [1440, 10868],
];
const TILE_ID = ([easting, northing]) => `epsg26910-${easting}-${northing}`;
const EXPECTED_ADJACENCY_PAIR_COUNT = TILE_KEYS.length * TILE_SIZE * LATTICE_SIDE * 2;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (bytes) => `sha256:${sha256(bytes)}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stableBytes = (value) => Buffer.from(JSON.stringify(value));
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const PACKAGE_SCRIPT_COMMAND = `node ${relative(SCRIPT_PATH)}`;
const q = (value) => Math.round(value * 1e6) / 1e6;

function assertCanonicalJson(bytes, value, label) {
  assert.equal(Buffer.compare(bytes, jsonBytes(value)), 0, `${label} JSON is not canonical byte-for-byte`);
}

function floatBits(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeFloatLE(value);
  return bytes.readUInt32LE(0);
}

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB declared length mismatch');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const jsonStart = 20;
  const gltf = JSON.parse(bytes.subarray(jsonStart, jsonStart + jsonLength).toString('utf8').trim());
  const binHeader = jsonStart + jsonLength;
  assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942, 'GLB BIN chunk missing');
  const binLength = bytes.readUInt32LE(binHeader);
  assert.equal(binHeader + 8 + binLength, bytes.length, 'GLB BIN chunk length mismatch');
  return { gltf, bin: bytes.subarray(binHeader + 8) };
}

function readPositions(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors?.[accessorIndex];
  assert(accessor?.type === 'VEC3' && accessor.componentType === 5126, 'Surface positions must be float32 VEC3');
  const view = gltf.bufferViews?.[accessor.bufferView];
  assert(view, 'Surface position buffer view missing');
  const stride = view.byteStride ?? 12;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const points = [];
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = base + index * stride;
    assert(offset + 12 <= bin.length, 'Surface position accessor exceeds GLB BIN');
    const x = bin.readFloatLE(offset);
    const y = bin.readFloatLE(offset + 4);
    const z = bin.readFloatLE(offset + 8);
    assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'GLB emitted a non-finite surface position');
    points.push({ x, y, z });
  }
  return points;
}

/**
 * Read every integer 1 m surface vertex from terrain and water primitives.
 * Independent cell polygons intentionally duplicate edge vertices; all such
 * duplicates must have exactly equal float32 heights for C0 continuity.
 */
function readGlbLattice(bytes, tileId) {
  const { gltf, bin } = parseGlb(bytes);
  assert.equal(gltf.extras?.horizontalCrs, 'EPSG:26910', `${tileId} GLB horizontal CRS drifted`);
  assert.equal(gltf.extras?.runtimeFrame, 'provisional-utm-source-declared-navd88-unrealized', `${tileId} GLB vertical frame drifted`);
  assert.equal(gltf.extras?.unitsPerMetre, 1, `${tileId} GLB must retain one runtime unit per metre`);
  const lattice = new Map();
  let duplicateVertexCount = 0;
  const primitiveCounts = {};
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    const category = primitive.extras?.category;
    if (category !== 'terrain' && category !== 'water') continue;
    primitiveCounts[category] = (primitiveCounts[category] ?? 0) + 1;
    for (const point of readPositions(gltf, bin, primitive.attributes.POSITION)) {
      const x = Math.round(point.x);
      const z = Math.round(point.z);
      // Coastline booleans can emit fractional vertices. They are not part of
      // the native 1 m lattice audited here; integer vertices are exact after
      // the builder's six-decimal GLB quantization.
      if (Math.abs(point.x - x) > 1e-6 || Math.abs(point.z - z) > 1e-6) continue;
      assert(x >= 0 && x <= TILE_SIZE && z >= 0 && z <= TILE_SIZE, `${tileId} surface lattice vertex lies outside the tile`);
      const key = `${x},${z}`;
      const record = { x, z, y: point.y, yBits: floatBits(point.y) };
      const existing = lattice.get(key);
      if (existing) {
        duplicateVertexCount += 1;
        assert.equal(existing.yBits, record.yBits, `${tileId} duplicate surface vertex height differs at ${key}`);
      } else lattice.set(key, record);
    }
  }
  assert.equal(lattice.size, LATTICE_SAMPLE_COUNT, `${tileId} GLB must expose every integer 1 m surface sample exactly once after deduplication`);
  return { lattice, duplicateVertexCount, primitiveCounts };
}

function tileGrid(grid) {
  return { minE: grid[0] * TILE_SIZE, minN: grid[1] * TILE_SIZE };
}

function coordinateKey(easting, northing) {
  return `${easting},${northing}`;
}

function authorityKey(record) {
  return `${record.sourceLockId}|${record.elevationSourceLockId}|${record.rasterSha256}`;
}

function orderedProofRecords(proof, tileId) {
  assert(proof && Array.isArray(proof.records), `${tileId} did not expose source-selection records`);
  const keys = proof.records.map((record) => coordinateKey(record.modelEastingMetres, record.modelNorthingMetres));
  assert.equal(new Set(keys).size, keys.length, `${tileId} source-selection coordinates are not unique`);
  for (let index = 1; index < proof.records.length; index += 1) {
    const previous = proof.records[index - 1];
    const current = proof.records[index];
    assert(previous.modelNorthingMetres < current.modelNorthingMetres
      || (previous.modelNorthingMetres === current.modelNorthingMetres && previous.modelEastingMetres < current.modelEastingMetres), `${tileId} source-selection records are not deterministically northing/easting ordered`);
  }
  return proof.records;
}

function latticeSelections(result, grid, authorization, tileId) {
  const proof = result.terrainSelectionProof;
  orderedProofRecords(proof, tileId);
  assert.equal(proof.mode, PRODUCTION_MODE, `${tileId} source-selection mode drifted`);
  assert.equal(proof.status, 'provisional-vertical-unrealized', `${tileId} vertical status drifted`);
  assert.equal(proof.verticalCertification, 'source-declared-navd88-unrealized', `${tileId} vertical certification drifted`);
  assert.equal(proof.selectionPolicyName, authorization.authorization.policy.name, `${tileId} selection policy drifted`);
  assert.equal(proof.selectionPolicyHash, authorization.authorization.policy.sha256, `${tileId} selection policy hash drifted`);
  assert.equal(proof.selectionPolicy.interpolation, 'none', `${tileId} source selection unexpectedly interpolates`);
  assert.equal(proof.records.length, proof.counts.uniqueNativeSampleCoordinates, `${tileId} source ledger count drifted`);
  assert.equal(result.receipt.tile.identity, tileId, `${tileId} receipt identity drifted`);
  assert.equal(result.receipt.tile.scale, 1, `${tileId} receipt scale drifted`);
  assert.equal(result.receipt.deterministicInputs.terrainGridStepMetres, 1, `${tileId} terrain lattice step drifted`);
  assert.equal(result.receipt.deterministicInputs.terrainSelectionMode, PRODUCTION_MODE, `${tileId} receipt selection mode drifted`);
  assert.equal(result.receipt.terrainOwnershipAuthorization?.productionWriteEnabled, false, `${tileId} unexpectedly enables production writes`);

  const authorizedSources = new Map(authorization.authorization.sources.map((source) => [source.sourceLock.id, source]));
  const allByCoordinate = new Map();
  const { minE, minN } = tileGrid(grid);
  for (const record of proof.records) {
    assert(Number.isFinite(record.sampledSourceDeclaredNavd88UnrealizedMetres), `${tileId} source-selection record has a non-finite chosen height`);
    assert(record.sourceLockId && record.elevationSourceLockId && record.rasterSha256, `${tileId} source-selection record authority is incomplete`);
    const source = authorizedSources.get(record.sourceLockId);
    assert(source, `${tileId} selected an unauthorized source ${record.sourceLockId}`);
    assert.equal(record.elevationSourceLockId, source.elevationAuthorization.id, `${tileId} selected elevation authorization drifted for ${record.sourceLockId}`);
    assert.equal(record.rasterSha256, source.rasterSha256.replace(/^sha256:/, ''), `${tileId} selected raster authority drifted for ${record.sourceLockId}`);
    if (record.sourceRole === 'californiagaps-fallback') {
      assert.equal(record.fallbackOriginalReason, 'nodata', `${tileId} CaliforniaGaps selection was not caused by original NoData`);
      assert(record.fallbackFromSourceLockId, `${tileId} fallback record omitted original authority`);
    }
    if (!Number.isInteger(record.modelEastingMetres) || !Number.isInteger(record.modelNorthingMetres)) continue;
    if (record.modelEastingMetres < minE || record.modelEastingMetres > minE + TILE_SIZE || record.modelNorthingMetres < minN || record.modelNorthingMetres > minN + TILE_SIZE) continue;
    const key = coordinateKey(record.modelEastingMetres, record.modelNorthingMetres);
    assert(!allByCoordinate.has(key), `${tileId} has duplicate lattice source record ${key}`);
    allByCoordinate.set(key, record);
  }
  assert.equal(allByCoordinate.size, LATTICE_SAMPLE_COUNT, `${tileId} source ledger must expose exactly 385x385 in-tile lattice samples`);
  for (let z = 0; z <= TILE_SIZE; z += 1) for (let x = 0; x <= TILE_SIZE; x += 1) {
    const key = coordinateKey(minE + x, minN + z);
    const record = allByCoordinate.get(key);
    assert(record, `${tileId} source ledger is missing lattice sample ${key}`);
    assert(Number.isFinite(record.sampledSourceDeclaredNavd88UnrealizedMetres), `${tileId} lattice sample ${key} is non-finite`);
  }
  return { proof, selections: allByCoordinate };
}

function p99(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)];
}

function summary(values) {
  let maxMetres = 0;
  for (const value of values) maxMetres = Math.max(maxMetres, value);
  return {
    count: values.length,
    maxMetres,
    p99Metres: p99(values),
  };
}

function pairSort(a, b) {
  const tile = a.tileId.localeCompare(b.tileId);
  if (tile) return tile;
  if (a.from.z !== b.from.z) return a.from.z - b.from.z;
  if (a.from.x !== b.from.x) return a.from.x - b.from.x;
  return (a.orientation === 'horizontal' ? 0 : 1) - (b.orientation === 'horizontal' ? 0 : 1);
}

function sourceSwitchPairs({ tileId, grid, selections, glbLattice, originH, crossPairs, withinDeltas, withinPairCountByTile }) {
  const { minE, minN } = tileGrid(grid);
  const perTile = { crossSourcePairCount: 0, originalFallbackPairCount: 0, withinSourcePairCount: 0, crossDeltas: [], withinDeltas: [] };
  const directions = [
    { orientation: 'horizontal', dx: 1, dz: 0 },
    { orientation: 'vertical', dx: 0, dz: 1 },
  ];
  for (let z = 0; z <= TILE_SIZE; z += 1) for (let x = 0; x <= TILE_SIZE; x += 1) {
    const left = selections.get(coordinateKey(minE + x, minN + z));
    assert(left, `${tileId} missing source sample at ${x},${z}`);
    for (const direction of directions) {
      if (x + direction.dx > TILE_SIZE || z + direction.dz > TILE_SIZE) continue;
      const right = selections.get(coordinateKey(minE + x + direction.dx, minN + z + direction.dz));
      assert(right, `${tileId} missing adjacent source sample at ${x + direction.dx},${z + direction.dz}`);
      const delta = Math.abs(left.sampledSourceDeclaredNavd88UnrealizedMetres - right.sampledSourceDeclaredNavd88UnrealizedMetres);
      assert(Number.isFinite(delta), `${tileId} adjacent source delta is non-finite`);
      const leftAuthority = authorityKey(left);
      const rightAuthority = authorityKey(right);
      const leftGlb = glbLattice.get(`${x},${z}`);
      const rightGlb = glbLattice.get(`${x + direction.dx},${z + direction.dz}`);
      assert(leftGlb && rightGlb, `${tileId} GLB lattice omitted adjacent sample ${x},${z}`);
      assert.equal(leftGlb.yBits, floatBits(q(left.sampledSourceDeclaredNavd88UnrealizedMetres - originH)), `${tileId} GLB height/source quantization mismatch at ${x},${z}`);
      assert.equal(rightGlb.yBits, floatBits(q(right.sampledSourceDeclaredNavd88UnrealizedMetres - originH)), `${tileId} GLB height/source quantization mismatch at ${x + direction.dx},${z + direction.dz}`);
      if (leftAuthority === rightAuthority) {
        withinDeltas.push(delta);
        perTile.withinDeltas.push(delta);
        perTile.withinSourcePairCount += 1;
        continue;
      }
      const leftRole = left.sourceRole;
      const rightRole = right.sourceRole;
      const roleChanged = leftRole !== rightRole;
      const pair = {
        tileId,
        gridIndex: grid,
        orientation: direction.orientation,
        from: { x, z, easting: minE + x, northing: minN + z },
        to: { x: x + direction.dx, z: z + direction.dz, easting: minE + x + direction.dx, northing: minN + z + direction.dz },
        authorityChange: roleChanged ? `${leftRole}->${rightRole}` : 'source-lock-change',
        leftSourceLockId: left.sourceLockId,
        leftElevationSourceLockId: left.elevationSourceLockId,
        leftRasterSha256: left.rasterSha256,
        leftSourceRole: leftRole,
        leftHeightMetres: left.sampledSourceDeclaredNavd88UnrealizedMetres,
        leftGlbYBits: leftGlb.yBits,
        rightSourceLockId: right.sourceLockId,
        rightElevationSourceLockId: right.elevationSourceLockId,
        rightRasterSha256: right.rasterSha256,
        rightSourceRole: rightRole,
        rightHeightMetres: right.sampledSourceDeclaredNavd88UnrealizedMetres,
        rightGlbYBits: rightGlb.yBits,
        deltaMetres: delta,
      };
      assert.equal(pair.leftGlbYBits, floatBits(q(pair.leftHeightMetres - originH)), `${tileId} left cross-source GLB height mismatch at ${x},${z}`);
      assert.equal(pair.rightGlbYBits, floatBits(q(pair.rightHeightMetres - originH)), `${tileId} right cross-source GLB height mismatch at ${x + direction.dx},${z + direction.dz}`);
      crossPairs.push(pair);
      perTile.crossDeltas.push(delta);
      perTile.crossSourcePairCount += 1;
      if (roleChanged && new Set([leftRole, rightRole]).size === 2 && new Set([leftRole, rightRole]).has('original') && new Set([leftRole, rightRole]).has('californiagaps-fallback')) perTile.originalFallbackPairCount += 1;
    }
  }
  withinPairCountByTile[tileId] = perTile.withinSourcePairCount;
  return perTile;
}

async function pathExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function readBoundJson(filePath, label) {
  const bytes = await readFile(filePath);
  const value = JSON.parse(bytes);
  assertCanonicalJson(bytes, value, label);
  return { bytes, value, sha256: hash(bytes) };
}

function assertLockedInventory(plan, parityReceipt, parityLock) {
  const expectedIds = TILE_KEYS.map(TILE_ID);
  assert.deepEqual(parityReceipt.coveragePlan?.tileIds, expectedIds, 'Parity receipt candidate inventory drifted');
  assert.deepEqual(parityLock.coveragePlan?.tileIds, expectedIds, 'Parity lock candidate inventory drifted');
  assert.deepEqual(plan.tiles.filter((tile) => expectedIds.includes(tile.id)).map((tile) => tile.id), expectedIds, 'Coverage plan candidate inventory drifted');
  for (const id of expectedIds) {
    const tile = plan.tiles.find((entry) => entry.id === id);
    assert(tile, `${id} is absent from the locked coverage plan`);
    assert.equal(tile.sourceReadiness?.buildReady, false, `${id} unexpectedly claims production readiness`);
    assert.match(tile.sourceReadiness?.terrainElevation ?? '', /californiagaps/, `${id} is not CaliforniaGaps fallback-source-ready`);
  }
}

async function runAudit() {
  const startedAt = Date.now();
  const [planBound, authBound, parityReceiptBound, parityLockBound, scriptBytes, packageBytes, sharedInputs, verifiedTerrainSourceDigests, authorization] = await Promise.all([
    readBoundJson(PLAN_PATH, 'SF coverage plan'),
    readBoundJson(AUTH_PATH, 'Native-pixel authorization'),
    readBoundJson(PARITY_RECEIPT_PATH, 'Native-pixel parity receipt'),
    readBoundJson(PARITY_LOCK_PATH, 'Native-pixel parity lock'),
    readFile(SCRIPT_PATH),
    readFile(PACKAGE_PATH),
    loadSfMetricSharedInputs(),
    loadSfMetricVerifiedTerrainSourceDigests(),
    loadSfNativePixelFallbackAuthorization(),
  ]);
  const packageJson = JSON.parse(packageBytes);
  assert.equal(packageJson.scripts?.[PACKAGE_SCRIPT_NAME], PACKAGE_SCRIPT_COMMAND, 'Package script does not bind this verifier path');
  const verifier = { path: relative(SCRIPT_PATH), sha256: hash(scriptBytes), packageScriptName: PACKAGE_SCRIPT_NAME };
  assert.equal(authorization.authorization.productionWriteEnabled, false, 'Native-pixel authorization unexpectedly enables writes');
  assert.equal(parityReceiptBound.value.productionWriteEnabled, false, 'Parity receipt unexpectedly enables writes');
  assert.equal(parityLockBound.value.productionWriteEnabled, false, 'Parity lock unexpectedly enables writes');
  assert.equal(parityLockBound.value.promotionGate?.evidenceReceiptSha256, parityReceiptBound.sha256, 'Parity lock does not bind current parity receipt bytes');
  assertLockedInventory(planBound.value, parityReceiptBound.value, parityLockBound.value);
  assert.equal(authorization.authorization.promotionGate?.requiredTileCount, TILE_KEYS.length, 'Authorization candidate count drifted');
  const parityPrerequisite = parityReceiptBound.value.promotionPrerequisites?.find(({ id }) => id === AUDIT_ID);
  const parityLockPrerequisite = parityLockBound.value.promotionPrerequisites?.find(({ id }) => id === AUDIT_ID);
  assert.equal(parityPrerequisite?.status, 'required-not-exercised', 'Parity receipt prerequisite status must remain unchanged by this evidence-only audit');
  assert.equal(parityLockPrerequisite?.status, 'required-not-exercised', 'Parity lock prerequisite status must remain unchanged by this evidence-only audit');

  const expectedIds = TILE_KEYS.map(TILE_ID);
  const parityTilesById = new Map((parityReceiptBound.value.tiles ?? []).map((tile) => [tile.id, tile]));
  assert.equal(parityTilesById.size, TILE_KEYS.length, 'Parity receipt candidate tile hash inventory drifted');
  assert.deepEqual([...parityTilesById.keys()].sort(), [...expectedIds].sort(), 'Parity receipt tile IDs drifted from the locked candidate inventory');
  const candidateDirs = expectedIds.map((id) => path.join(PRODUCTION_ROOT, id));
  for (const dir of candidateDirs) assert.equal(await pathExists(dir), false, `${path.basename(dir)} already exists; refusing to treat a resident artifact as write:false evidence`);

  const authorizedSourceById = new Map(authorization.authorization.sources.map((source) => [source.sourceLock.id, source]));
  const tiles = [];
  const crossPairs = [];
  const withinDeltas = [];
  const withinPairCountByTile = {};
  let duplicateVertexCount = 0;
  let glbCorrespondenceCount = 0;
  let originalFallbackPairCount = 0;

  for (const grid of TILE_KEYS) {
    const tileId = TILE_ID(grid);
    const parityTile = parityTilesById.get(tileId);
    assert(parityTile, `${tileId} is absent from the parity receipt hash inventory`);
    const result = await buildSfMetricTile({
      tile: { gridEasting: grid[0], gridNorthing: grid[1] },
      write: false,
      sharedInputs,
      verifiedTerrainSourceDigests,
      terrainSelectionMode: PRODUCTION_MODE,
    });
    assert.equal(result.glbs.length, 1, `${tileId} emitted an unexpected LOD count`);
    assert.equal(result.receipt.terrainOwnershipAuthorization?.productionWriteEnabled, false, `${tileId} receipt enables production writes`);
    const { proof, selections } = latticeSelections(result, grid, authorization, tileId);
    const candidateGlbSha256 = hash(result.glbs[0].bytes);
    assert.equal(candidateGlbSha256, parityTile.glbSha256, `${tileId} GLB hash drifted from the bound parity receipt`);
    assert.equal(proof.sampleLedgerSha256, parityTile.sampleLedgerSha256, `${tileId} sample-ledger hash drifted from the bound parity receipt`);
    assert.equal(proof.sharedEdgeLedgerSha256, parityTile.sharedEdgeLedgerSha256, `${tileId} shared-edge ledger hash drifted from the bound parity receipt`);
    for (const sourceId of proof.sourceLocks) assert(authorizedSourceById.has(sourceId), `${tileId} proof binds an unauthorized source lock ${sourceId}`);
    const glbInfo = readGlbLattice(result.glbs[0].bytes, tileId);
    const originH = result.receipt.tile.originEpsg26910VerticalMetres[2];
    const { minE, minN } = tileGrid(grid);
    for (let z = 0; z <= TILE_SIZE; z += 1) for (let x = 0; x <= TILE_SIZE; x += 1) {
      const selection = selections.get(coordinateKey(minE + x, minN + z));
      const actual = glbInfo.lattice.get(`${x},${z}`);
      assert(actual, `${tileId} GLB omitted lattice sample ${x},${z}`);
      assert.equal(actual.yBits, floatBits(q(selection.sampledSourceDeclaredNavd88UnrealizedMetres - originH)), `${tileId} GLB quantized height does not correspond to selected source at ${x},${z}`);
      glbCorrespondenceCount += 1;
    }
    duplicateVertexCount += glbInfo.duplicateVertexCount;
    const perTile = sourceSwitchPairs({ tileId, grid, selections, glbLattice: glbInfo.lattice, originH, crossPairs, withinDeltas, withinPairCountByTile });
    originalFallbackPairCount += perTile.originalFallbackPairCount;
    tiles.push({
      id: tileId,
      gridIndex: grid,
      mode: proof.mode,
      status: proof.status,
      verticalCertification: proof.verticalCertification,
      productionWriteEnabled: false,
      glbSha256: candidateGlbSha256,
      glbBytes: result.glbs[0].bytes.length,
      sampleLedgerSha256: proof.sampleLedgerSha256,
      sharedEdgeLedgerSha256: proof.sharedEdgeLedgerSha256,
      sourceLocks: [...proof.sourceLocks],
      sourceSelectionCounts: {
        uniqueNativeSampleCoordinates: proof.counts.uniqueNativeSampleCoordinates,
        originalFiniteSamples: proof.counts.originalFiniteSamples,
        californiaGapsFallbackSamples: proof.counts.californiaGapsFallbackSamples,
      },
      glbLattice: {
        uniqueIntegerSurfaceSamples: glbInfo.lattice.size,
        duplicateVertexCount: glbInfo.duplicateVertexCount,
        primitiveCounts: glbInfo.primitiveCounts,
        exactHeightCorrespondenceSamples: LATTICE_SAMPLE_COUNT,
      },
      sourceSwitches: {
        pairCount: perTile.crossSourcePairCount,
        originalFallbackPairCount: perTile.originalFallbackPairCount,
        crossSourceDelta: summary(perTile.crossDeltas),
        withinSourceBaseline: summary(perTile.withinDeltas),
      },
    });
    process.stdout.write(`${JSON.stringify({ progress: 'internal-source-switch-audit', tile: tileId, crossSourcePairs: perTile.crossSourcePairCount, originalFallbackPairs: perTile.originalFallbackPairCount })}\n`);
  }

  for (const dir of candidateDirs) assert.equal(await pathExists(dir), false, `${path.basename(dir)} was written despite write:false`);
  assert.equal(tiles.length, TILE_KEYS.length, 'Candidate tile count drifted');
  assert.equal(glbCorrespondenceCount, TILE_KEYS.length * LATTICE_SAMPLE_COUNT, 'GLB lattice correspondence count drifted');
  assert.equal(crossPairs.length + withinDeltas.length, EXPECTED_ADJACENCY_PAIR_COUNT, 'Exhaustive horizontal/vertical adjacency accounting drifted');
  assert(crossPairs.length > 0, 'No internal source-switch neighbour pair was exercised');
  assert(originalFallbackPairCount > 0, 'No adjacent original/CaliforniaGaps source switch was exercised');

  const crossSummary = summary(crossPairs.map((pair) => pair.deltaMetres));
  const withinSummary = summary(withinDeltas);
  const ratio = {
    maxCrossToWithin: withinSummary.maxMetres > 0 ? crossSummary.maxMetres / withinSummary.maxMetres : null,
    p99CrossToWithin: withinSummary.p99Metres > 0 ? crossSummary.p99Metres / withinSummary.p99Metres : null,
    denominator: 'same-tile adjacent pairs with unchanged chosen source authority; report-only, no acceptance threshold',
  };
  assert.deepEqual(crossPairs, [...crossPairs].sort(pairSort), 'Cross-source neighbour ledger ordering is not deterministic');
  const crossPairLedgerSha256 = hash(stableBytes(crossPairs));
  const sourceLocks = authorization.authorization.sources.map((source) => ({
    role: source.role,
    cellKey: source.cellKey,
    sourceLockId: source.sourceLock.id,
    sourceLockPath: source.sourceLock.path,
    sourceLockSha256: source.sourceLock.sha256,
    elevationAuthorizationId: source.elevationAuthorization.id,
    elevationAuthorizationPath: source.elevationAuthorization.path,
    elevationAuthorizationSha256: source.elevationAuthorization.sha256,
    rasterSha256: source.rasterSha256,
  }));
  const sourceSwitchCounts = Object.fromEntries([...new Set(crossPairs.map((pair) => pair.authorityChange))].sort().map((kind) => [kind, crossPairs.filter((pair) => pair.authorityChange === kind).length]));
  const crossSourceNeighbourPairExemplars = [...crossPairs]
    .sort((a, b) => b.deltaMetres - a.deltaMetres || pairSort(a, b))
    .slice(0, WORST_EXEMPLAR_COUNT);
  const prerequisiteState = {
    id: AUDIT_ID,
    evidenceStatus: 'exercised-evidence-only',
    parityReceiptStatusBeforeAndAfter: parityPrerequisite.status,
    parityLockStatusBeforeAndAfter: parityLockPrerequisite.status,
    closesParityPromotionPrerequisite: false,
    note: 'This audit does not modify the existing parity receipt or lock. Their prerequisite remains required-not-exercised until a deliberate production-promotion update.',
  };

  const receipt = {
    schemaVersion: 1,
    kind: 'sf-native-pixel-fallback-internal-source-switch-continuity-audit-receipt',
    id: RECEIPT_ID,
    auditId: AUDIT_ID,
    status: 'evidence-only-internal-source-switch-continuity-audit-passed',
    productionReadiness: 'unproven-visual-metric-acceptability-not-established',
    verticalCertification: 'source-declared-navd88-unrealized',
    coordinateReference: {
      horizontal: { crs: 'EPSG:26910', unit: 'metre' },
      vertical: { datum: 'source-declared-navd88-unrealized', unit: 'metre' },
      runtimeFrame: 'provisional-utm-source-declared-navd88-unrealized',
    },
    scale: { runtimeUnitsPerMetre: 1, horizontalScale: 1, verticalScale: 1, verticalExaggeration: 0 },
    productionWriteEnabled: false,
    verifier,
    promotionPrerequisiteState: prerequisiteState,
    auditContract: {
      buildWrite: false,
      selectionMode: PRODUCTION_MODE,
      candidateTileCount: TILE_KEYS.length,
      nativeLattice: '385x385 samples per 384m tile; adjacent horizontal/vertical pairs at 1m spacing',
      sourceAuthorityChange: 'sourceLockId/elevationSourceLockId/rasterSha256 tuple differs',
      exhaustivePairLedger: 'all source-changing adjacent pairs are checked in-memory; canonical evidence binds the sorted ledger by count and SHA-256 and retains deterministic worst-N exemplars',
      c0Rule: 'all duplicate terrain/water integer lattice vertices must have identical float32 height bits; every lattice coordinate must be present',
      glbHeightRule: 'each selected source float32 height is q(..., 6 decimal places), then compared by emitted GLB float32 bits',
      verticalAccuracyClaim: 'none',
      metricVisualAcceptability: 'not established by this evidence-only audit',
    },
    bindings: {
      authorization: { path: relative(AUTH_PATH), sha256: authBound.sha256, productionWriteEnabled: false },
      parityReceipt: { path: relative(PARITY_RECEIPT_PATH), sha256: parityReceiptBound.sha256, productionWriteEnabled: false },
      parityLock: { path: relative(PARITY_LOCK_PATH), sha256: parityLockBound.sha256, productionWriteEnabled: false },
      coveragePlan: { path: relative(PLAN_PATH), sha256: planBound.sha256, candidateTileCount: TILE_KEYS.length },
      verifier,
    },
    sourceLocks,
    counts: {
      candidateTileCount: TILE_KEYS.length,
      buildCount: TILE_KEYS.length,
      sourceSelectionLatticeSamples: TILE_KEYS.length * LATTICE_SAMPLE_COUNT,
      glbExactHeightCorrespondenceSamples: glbCorrespondenceCount,
      glbDuplicateIntegerSurfaceVertices: duplicateVertexCount,
      totalAdjacentPairCount: EXPECTED_ADJACENCY_PAIR_COUNT,
      crossSourceNeighbourPairCount: crossPairs.length,
      originalFallbackNeighbourPairCount: originalFallbackPairCount,
      withinSourceNeighbourPairCount: withinDeltas.length,
      sourceSwitchKinds: sourceSwitchCounts,
    },
    statistics: {
      crossSourceNeighbourDeltaMetres: crossSummary,
      withinSourceNeighbourBaselineMetres: withinSummary,
      crossToWithinRatios: ratio,
      interpretation: 'Report-only diagnostics. No max, p99, or ratio is treated as an accuracy or promotion threshold.',
    },
    determinism: {
      sourceSelectionRecordOrder: 'northing ascending, then easting ascending',
      crossSourcePairOrder: 'tile id ascending, row-major from coordinate, horizontal before vertical',
      candidateTileOrder: expectedIds,
      candidateArtifactDirectoriesWritten: false,
      productionWriteEnabled: false,
    },
    tiles: tiles.sort((a, b) => a.id.localeCompare(b.id)),
    crossSourceNeighbourPairExemplars,
    ledgers: {
      crossSourceNeighbourPairCount: crossPairs.length,
      crossSourceNeighbourPairSha256: crossPairLedgerSha256,
      ordering: 'tile id ascending, row-major from coordinate, horizontal before vertical',
      storage: 'full sorted ledger checked in-memory; receipt retains count/hash plus deterministic worst-32 exemplars',
    },
    outputContract: {
      candidateArtifactsWritten: false,
      productionManifestChanged: false,
      productionWriteEnabled: false,
      evidenceReceiptPath: relative(RECEIPT_PATH),
    },
  };
  const receiptBytes = jsonBytes(receipt);
  const receiptSha256 = hash(receiptBytes);
  const lock = {
    schemaVersion: 1,
    kind: 'sf-native-pixel-fallback-internal-source-switch-continuity-audit-lock',
    id: RECEIPT_ID,
    auditId: AUDIT_ID,
    status: 'evidence-only-internal-source-switch-continuity-audit-passed',
    productionReadiness: receipt.productionReadiness,
    verticalCertification: receipt.verticalCertification,
    productionWriteEnabled: false,
    verifier,
    promotionPrerequisiteState: prerequisiteState,
    promotionGate: {
      status: 'evidence-only-unproven-visual-metric-acceptability',
      requirementId: AUDIT_ID,
      evidenceReceiptPath: relative(RECEIPT_PATH),
      evidenceReceiptSha256: receiptSha256,
      verticalAccuracyClaim: 'none',
    },
    bindings: receipt.bindings,
    sourceLocks,
    candidateTileIds: expectedIds,
    counts: receipt.counts,
    statistics: receipt.statistics,
    ledgers: receipt.ledgers,
    writeGate: {
      productionWriteEnabled: false,
      candidateArtifactDirectoriesWritten: false,
      reason: 'This is read-only promotion evidence. Visual/metric acceptability and canonical production mosaic promotion remain unproven.',
    },
  };
  const lockBytes = jsonBytes(lock);
  await Promise.all([writeFile(RECEIPT_PATH, receiptBytes), writeFile(LOCK_PATH, lockBytes)]);
  const [writtenReceipt, writtenLock] = await Promise.all([readFile(RECEIPT_PATH), readFile(LOCK_PATH)]);
  assert.equal(Buffer.compare(writtenReceipt, receiptBytes), 0, 'Written continuity receipt bytes changed');
  assert.equal(Buffer.compare(writtenLock, lockBytes), 0, 'Written continuity lock bytes changed');
  return {
    result: 'SF native-pixel fallback internal source-switch continuity audit passed (evidence-only)',
    durationMs: Date.now() - startedAt,
    durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    auditId: AUDIT_ID,
    receiptPath: relative(RECEIPT_PATH),
    receiptSha256,
    lockPath: relative(LOCK_PATH),
    lockSha256: hash(lockBytes),
    productionWriteEnabled: false,
    productionReadiness: receipt.productionReadiness,
    counts: receipt.counts,
    statistics: receipt.statistics,
    bindings: receipt.bindings,
  };
}

export async function verifySfNativePixelFallbackInternalSourceSwitchContinuityAudit() {
  return runAudit();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifySfNativePixelFallbackInternalSourceSwitchContinuityAudit();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
