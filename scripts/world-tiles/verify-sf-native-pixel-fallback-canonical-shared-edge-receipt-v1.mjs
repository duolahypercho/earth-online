/**
 * Canonical per-native-pixel shared-edge and production-receipt schema gate.
 *
 * This is evidence-only. Candidate CaliforniaGaps tiles are rebuilt with
 * write:false, canonical candidate/candidate seams are checked using the
 * same EPSG:26910 coordinate, policy hash, and half-open source-cell rule,
 * and candidate/resident seams are separately classified as mixed
 * canonical/legacy edges. Every compared sample binds its source authority
 * tuple and emitted float32 height bits through deterministic edge-ledger
 * hashes. No production artifact or manifest is written.
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
const SWITCH_RECEIPT_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-internal-source-switch-continuity-audit-v1.receipt.json');
const SWITCH_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-internal-source-switch-continuity-audit-v1.lock.json');
const RECEIPT_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-canonical-shared-edge-receipt-v1.receipt.json');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-canonical-shared-edge-receipt-v1.lock.json');
const PRODUCTION_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const PRODUCTION_MANIFEST_PATH = path.join(PRODUCTION_ROOT, 'sf-metric-tiles-v1.manifest.json');
const SCRIPT_PATH = path.resolve(fileURLToPath(import.meta.url));
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const PACKAGE_SCRIPT_NAME = 'verify:sf-native-pixel-fallback-canonical-shared-edge-receipt';
const PACKAGE_SCRIPT_COMMAND = `node ${path.relative(ROOT, SCRIPT_PATH).split(path.sep).join('/')}`;

const TILE_SIZE = 384;
const EDGE_SAMPLE_COUNT = TILE_SIZE + 1;
const PRODUCTION_MODE = 'per-native-pixel-fallback-production-v1';
const GATE_ID = 'canonical-shared-edge-receipt-schema-v1';
const RECEIPT_ID = 'sf-native-pixel-fallback-canonical-shared-edge-receipt-v1';
const EXPECTED_POLICY_HASH = 'sha256:a475ad47eedff08509bd69782c24c624fecc2b4a4a720a14a518c90220f1ec8b';

const CANDIDATE_GRIDS = [
  ...Array.from({ length: 24 }, (_, index) => [1417 + index, 10867]),
  [1440, 10868],
];
const TILE_ID = ([easting, northing]) => `epsg26910-${easting}-${northing}`;
const CANDIDATE_IDS = CANDIDATE_GRIDS.map(TILE_ID);
const RESIDENT_IDS = [
  'epsg26910-1420-10868', 'epsg26910-1421-10868', 'epsg26910-1422-10868',
  'epsg26910-1423-10868', 'epsg26910-1424-10868', 'epsg26910-1425-10868',
  'epsg26910-1426-10868', 'epsg26910-1427-10868', 'epsg26910-1428-10868',
  'epsg26910-1429-10868', 'epsg26910-1430-10868', 'epsg26910-1431-10868',
  'epsg26910-1432-10868', 'epsg26910-1433-10868', 'epsg26910-1434-10868',
  'epsg26910-1435-10868', 'epsg26910-1436-10868', 'epsg26910-1437-10868',
  'epsg26910-1438-10868', 'epsg26910-1439-10868', 'epsg26910-1440-10869',
];

const EXPECTED_CANONICAL_SEAM_KEYS = [
  'epsg26910-1417-10867|east->epsg26910-1418-10867|west',
  'epsg26910-1418-10867|east->epsg26910-1419-10867|west',
  'epsg26910-1419-10867|east->epsg26910-1420-10867|west',
  'epsg26910-1420-10867|east->epsg26910-1421-10867|west',
  'epsg26910-1421-10867|east->epsg26910-1422-10867|west',
  'epsg26910-1422-10867|east->epsg26910-1423-10867|west',
  'epsg26910-1423-10867|east->epsg26910-1424-10867|west',
  'epsg26910-1424-10867|east->epsg26910-1425-10867|west',
  'epsg26910-1425-10867|east->epsg26910-1426-10867|west',
  'epsg26910-1426-10867|east->epsg26910-1427-10867|west',
  'epsg26910-1427-10867|east->epsg26910-1428-10867|west',
  'epsg26910-1428-10867|east->epsg26910-1429-10867|west',
  'epsg26910-1429-10867|east->epsg26910-1430-10867|west',
  'epsg26910-1430-10867|east->epsg26910-1431-10867|west',
  'epsg26910-1431-10867|east->epsg26910-1432-10867|west',
  'epsg26910-1432-10867|east->epsg26910-1433-10867|west',
  'epsg26910-1433-10867|east->epsg26910-1434-10867|west',
  'epsg26910-1434-10867|east->epsg26910-1435-10867|west',
  'epsg26910-1435-10867|east->epsg26910-1436-10867|west',
  'epsg26910-1436-10867|east->epsg26910-1437-10867|west',
  'epsg26910-1437-10867|east->epsg26910-1438-10867|west',
  'epsg26910-1438-10867|east->epsg26910-1439-10867|west',
  'epsg26910-1439-10867|east->epsg26910-1440-10867|west',
  'epsg26910-1440-10867|north->epsg26910-1440-10868|south',
];
const EXPECTED_MIXED_SEAM_KEYS = [
  'epsg26910-1420-10867|north->epsg26910-1420-10868|south',
  'epsg26910-1421-10867|north->epsg26910-1421-10868|south',
  'epsg26910-1422-10867|north->epsg26910-1422-10868|south',
  'epsg26910-1423-10867|north->epsg26910-1423-10868|south',
  'epsg26910-1424-10867|north->epsg26910-1424-10868|south',
  'epsg26910-1425-10867|north->epsg26910-1425-10868|south',
  'epsg26910-1426-10867|north->epsg26910-1426-10868|south',
  'epsg26910-1427-10867|north->epsg26910-1427-10868|south',
  'epsg26910-1428-10867|north->epsg26910-1428-10868|south',
  'epsg26910-1429-10867|north->epsg26910-1429-10868|south',
  'epsg26910-1430-10867|north->epsg26910-1430-10868|south',
  'epsg26910-1431-10867|north->epsg26910-1431-10868|south',
  'epsg26910-1432-10867|north->epsg26910-1432-10868|south',
  'epsg26910-1433-10867|north->epsg26910-1433-10868|south',
  'epsg26910-1434-10867|north->epsg26910-1434-10868|south',
  'epsg26910-1435-10867|north->epsg26910-1435-10868|south',
  'epsg26910-1436-10867|north->epsg26910-1436-10868|south',
  'epsg26910-1437-10867|north->epsg26910-1437-10868|south',
  'epsg26910-1438-10867|north->epsg26910-1438-10868|south',
  'epsg26910-1439-10867|north->epsg26910-1439-10868|south',
  'epsg26910-1440-10868|north->epsg26910-1440-10869|south',
  'epsg26910-1440-10868|west->epsg26910-1439-10868|east',
];

const CELL_RULE = Object.freeze({
  name: 'half-open-epsg26910-10000m-cell-v1',
  crs: 'EPSG:26910',
  cellSizeMetres: 10000,
  epsilonMetres: 1e-7,
  boundaryOwnership: 'exact-boundary-belongs-west-and-south',
  function: 'floor((coordinateMetres - 1e-7) / 10000)',
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (bytes) => `sha256:${sha256(bytes)}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stableBytes = (value) => Buffer.from(JSON.stringify(value));
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const cellRuleSha256 = hash(stableBytes(CELL_RULE));

function assertCanonicalJson(bytes, value, label) {
  assert.equal(Buffer.compare(bytes, jsonBytes(value)), 0, `${label} JSON is not canonical byte-for-byte`);
}

function floatBits(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeFloatLE(value);
  return bytes.readUInt32LE(0);
}

function q(value) {
  return Math.round(value * 1e6) / 1e6;
}

function sourceCellAt(easting, northing) {
  return `${Math.floor((easting - CELL_RULE.epsilonMetres) / CELL_RULE.cellSizeMetres)},${Math.floor((northing - CELL_RULE.epsilonMetres) / CELL_RULE.cellSizeMetres)}`;
}

function authorityTuple(record) {
  return {
    sourceLockId: record.sourceLockId,
    elevationSourceLockId: record.elevationSourceLockId,
    rasterSha256: record.rasterSha256,
  };
}

function authorityKey(authority) {
  return `${authority.sourceLockId}|${authority.elevationSourceLockId}|${authority.rasterSha256}`;
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
  assert(accessor?.type === 'VEC3' && accessor.componentType === 5126, 'Terrain positions must be float32 VEC3');
  const view = gltf.bufferViews?.[accessor.bufferView];
  assert(view, 'Terrain position buffer view missing');
  const stride = view.byteStride ?? 12;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const points = [];
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = base + index * stride;
    assert(offset + 12 <= bin.length, 'Terrain position accessor exceeds GLB BIN');
    const x = bin.readFloatLE(offset);
    const y = bin.readFloatLE(offset + 4);
    const z = bin.readFloatLE(offset + 8);
    assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'GLB emitted a non-finite terrain position');
    points.push({ x, y, z });
  }
  return points;
}

function glbEdge(bytes, side) {
  const { gltf, bin } = parseGlb(bytes);
  assert.equal(gltf.extras?.horizontalCrs, 'EPSG:26910', 'GLB horizontal CRS drifted');
  assert.equal(gltf.extras?.runtimeFrame, 'provisional-utm-source-declared-navd88-unrealized', 'GLB vertical frame drifted');
  assert.equal(gltf.extras?.unitsPerMetre, 1, 'GLB must retain one runtime unit per metre');
  const edge = new Map();
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    if (primitive.extras?.category !== 'terrain') continue;
    for (const point of readPositions(gltf, bin, primitive.attributes.POSITION)) {
      const onEdge = side === 'north' ? point.z === TILE_SIZE
        : side === 'south' ? point.z === 0
          : side === 'east' ? point.x === TILE_SIZE : point.x === 0;
      if (!onEdge) continue;
      const along = side === 'north' || side === 'south' ? point.x : point.z;
      assert(Number.isInteger(along), `${side} edge coordinate is not an integer: ${along}`);
      const key = floatBits(along);
      const record = { along, alongBits: key, yBits: floatBits(point.y) };
      const previous = edge.get(key);
      if (previous) assert.equal(previous.yBits, record.yBits, `${side} duplicate edge height differs at ${along}`);
      else edge.set(key, record);
    }
  }
  const records = [...edge.values()].sort((a, b) => a.along - b.along);
  assert.equal(records.length, EDGE_SAMPLE_COUNT, `${side} edge must expose exactly ${EDGE_SAMPLE_COUNT} native samples`);
  for (let index = 0; index < records.length; index += 1) assert.equal(records[index].along, index, `${side} edge sample ${index} is not one metre apart`);
  return records;
}

function edgeCoordinate(grid, side, index) {
  const minE = grid[0] * TILE_SIZE;
  const minN = grid[1] * TILE_SIZE;
  return side === 'north'
    ? { easting: minE + index, northing: minN + TILE_SIZE }
    : side === 'south'
      ? { easting: minE + index, northing: minN }
      : side === 'east'
        ? { easting: minE + TILE_SIZE, northing: minN + index }
        : { easting: minE, northing: minN + index };
}

function edgeRecordsFromProof(proof, glbBytes, grid, side, originH) {
  const sourceRecords = proof.sharedEdgeSamples?.[side];
  assert(Array.isArray(sourceRecords), `${TILE_ID(grid)} missing ${side} canonical edge source ledger`);
  const ordered = [...sourceRecords].sort((a, b) => {
    const aa = side === 'north' || side === 'south' ? a.modelEastingMetres : a.modelNorthingMetres;
    const bb = side === 'north' || side === 'south' ? b.modelEastingMetres : b.modelNorthingMetres;
    return aa - bb;
  });
  const glb = glbEdge(glbBytes, side);
  assert.equal(ordered.length, EDGE_SAMPLE_COUNT, `${TILE_ID(grid)} ${side} canonical ledger count drifted`);
  assert.equal(glb.length, ordered.length, `${TILE_ID(grid)} ${side} GLB/source edge count differs`);
  return ordered.map((record, index) => {
    const coordinate = edgeCoordinate(grid, side, index);
    assert.equal(record.modelEastingMetres, coordinate.easting, `${TILE_ID(grid)} ${side} canonical easting drifted at ${index}`);
    assert.equal(record.modelNorthingMetres, coordinate.northing, `${TILE_ID(grid)} ${side} canonical northing drifted at ${index}`);
    const heightBits = glb[index].yBits;
    assert.equal(heightBits, floatBits(q(record.sampledSourceDeclaredNavd88UnrealizedMetres - originH)), `${TILE_ID(grid)} ${side} GLB/source height bits differ at ${index}`);
    return {
      index,
      coordinate,
      cellKey: sourceCellAt(coordinate.easting, coordinate.northing),
      representation: 'canonical-per-native-pixel',
      policyHash: proof.selectionPolicyHash,
      cellRuleSha256,
      authority: authorityTuple(record),
      sourceRole: record.sourceRole,
      heightBits,
      selectedHeightMetres: record.sampledSourceDeclaredNavd88UnrealizedMetres,
    };
  });
}

async function residentSourceMap(residentId, authorizationByElevation) {
  const receiptPath = path.join(PRODUCTION_ROOT, residentId, `${residentId}.receipt.json`);
  const receiptBytes = await readFile(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  assertCanonicalJson(receiptBytes, receipt, `${residentId} resident receipt`);
  assert.equal(receipt.tile?.identity, residentId, `${residentId} resident receipt identity drifted`);
  assert.equal(receipt.tile?.scale, 1, `${residentId} resident scale drifted`);
  assert.equal(receipt.status, 'provisional-vertical-unrealized', `${residentId} resident vertical status drifted`);
  const byCell = new Map();
  for (const source of receipt.source?.geoTiffs ?? []) {
    assert(source.ownershipCell && source.elevationSourceLockId && source.sha256, `${residentId} resident source authority is incomplete`);
    assert(!byCell.has(source.ownershipCell), `${residentId} resident duplicates source cell ${source.ownershipCell}`);
    const elevation = authorizationByElevation.get(source.elevationSourceLockId);
    let sourceLockId = elevation?.sourceLock?.id;
    if (!sourceLockId) {
      const elevationPath = path.join(ROOT, 'public/data/world/source-locks', `${source.elevationSourceLockId}.lock.json`);
      const elevationLock = JSON.parse(await readFile(elevationPath));
      sourceLockId = elevationLock.sourceLock?.id;
    }
    assert(sourceLockId, `${residentId} cannot resolve source lock for ${source.elevationSourceLockId}`);
    byCell.set(source.ownershipCell, {
      sourceLockId,
      elevationSourceLockId: source.elevationSourceLockId,
      rasterSha256: source.sha256.replace(/^sha256:/, ''),
    });
  }
  return { receiptBytes, receipt, byCell, receiptSha256: hash(receiptBytes) };
}

async function residentEdge(residentId, resident, side) {
  const glbPath = path.join(PRODUCTION_ROOT, residentId, `${residentId}.lod0.glb`);
  const glbBytes = await readFile(glbPath);
  const gridMatch = residentId.match(/epsg26910-(\d+)-(\d+)/);
  assert(gridMatch, `${residentId} resident tile identity is invalid`);
  const grid = [Number(gridMatch[1]), Number(gridMatch[2])];
  const glb = glbEdge(glbBytes, side);
  return glb.map((sample, index) => {
    const coordinate = edgeCoordinate(grid, side, index);
    const cellKey = sourceCellAt(coordinate.easting, coordinate.northing);
    const authority = resident.byCell.get(cellKey);
    assert(authority, `${residentId} has no source authority for edge cell ${cellKey}`);
    return {
      index,
      coordinate,
      cellKey,
      representation: 'legacy-cell-owned',
      policyHash: null,
      cellRuleSha256,
      authority,
      sourceRole: null,
      heightBits: sample.yBits,
    };
  });
}

function seamKey(leftTileId, leftSide, rightTileId, rightSide) {
  return `${leftTileId}|${leftSide}->${rightTileId}|${rightSide}`;
}

function gridFromId(tileId) {
  const match = tileId.match(/epsg26910-(\d+)-(\d+)/);
  assert(match, `Invalid EPSG:26910 tile id ${tileId}`);
  return [Number(match[1]), Number(match[2])];
}

function compareSeam({ key, kind, left, right }) {
  assert.equal(left.length, EDGE_SAMPLE_COUNT, `${key} left edge count drifted`);
  assert.equal(right.length, EDGE_SAMPLE_COUNT, `${key} right edge count drifted`);
  const canonical = kind === 'canonical-canonical';
  const ledger = [];
  const exemplars = [];
  let exactCoordinates = 0;
  let exactFloat32 = 0;
  let exactCells = 0;
  let sameAuthority = 0;
  let crossSourceSamples = 0;
  for (let index = 0; index < EDGE_SAMPLE_COUNT; index += 1) {
    const a = left[index];
    const b = right[index];
    assert.deepEqual(a.coordinate, b.coordinate, `${key} EPSG:26910 shared coordinate differs at ${index}`);
    exactCoordinates += 1;
    if (canonical) {
      assert.equal(a.policyHash, EXPECTED_POLICY_HASH, `${key} canonical left policy hash drifted at ${index}`);
      assert.equal(b.policyHash, EXPECTED_POLICY_HASH, `${key} canonical right policy hash drifted at ${index}`);
      assert.equal(a.policyHash, b.policyHash, `${key} canonical policy hashes differ at ${index}`);
      assert.equal(a.cellRuleSha256, b.cellRuleSha256, `${key} canonical cell-rule bindings differ at ${index}`);
    }
    assert.equal(a.cellKey, b.cellKey, `${key} half-open source cell differs at ${index}`);
    exactCells += 1;
    assert.equal(a.heightBits, b.heightBits, `${key} float32 height bits differ at ${index}`);
    exactFloat32 += 1;
    const aAuthorityKey = authorityKey(a.authority);
    const bAuthorityKey = authorityKey(b.authority);
    const authorityMatches = aAuthorityKey === bAuthorityKey;
    if (authorityMatches) sameAuthority += 1;
    else crossSourceSamples += 1;
    const entry = {
      index,
      coordinate: a.coordinate,
      cellKey: a.cellKey,
      leftRepresentation: a.representation,
      leftPolicyHash: a.policyHash,
      leftAuthority: a.authority,
      leftHeightBits: a.heightBits,
      rightRepresentation: b.representation,
      rightPolicyHash: b.policyHash,
      rightAuthority: b.authority,
      rightHeightBits: b.heightBits,
      authorityTupleEqual: authorityMatches,
      float32HeightBitsEqual: true,
    };
    ledger.push(entry);
    if (index === 0 || index === 112 || index === 113 || index === TILE_SIZE) exemplars.push(entry);
  }
  if (canonical) assert.equal(crossSourceSamples, 0, `${key} canonical/canonical seam has cross-source samples`);
  return {
    kind,
    samples: EDGE_SAMPLE_COUNT,
    exactCoordinateSamples: exactCoordinates,
    exactCellRuleSamples: exactCells,
    exactFloat32HeightSamples: exactFloat32,
    sameAuthorityTupleSamples: sameAuthority,
    crossSourceSamples,
    exactFloat32Bits: exactFloat32 === EDGE_SAMPLE_COUNT,
    authorityLedgerSha256: hash(stableBytes(ledger)),
    ordering: 'shared EPSG:26910 coordinate ascending along edge; canonical authority tuple and emitted float32 height bits retained in ledger hash',
    exemplars,
  };
}

async function pathExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function assertInventory(parityReceipt, parityLock, plan) {
  assert.deepEqual(parityReceipt.coveragePlan?.tileIds, CANDIDATE_IDS, 'Parity candidate inventory drifted');
  assert.deepEqual(parityLock.coveragePlan?.tileIds, CANDIDATE_IDS, 'Parity lock candidate inventory drifted');
  assert.deepEqual(plan.tiles.filter((tile) => CANDIDATE_IDS.includes(tile.id)).map((tile) => tile.id), CANDIDATE_IDS, 'Coverage plan candidate inventory drifted');
  assert.deepEqual(parityReceipt.auditInventory?.residentIds, RESIDENT_IDS, 'Parity resident inventory drifted');
  assert.deepEqual(parityReceipt.auditInventory?.candidateCandidateSeamKeys, EXPECTED_CANONICAL_SEAM_KEYS, 'Parity canonical seam inventory drifted');
  assert.deepEqual(parityReceipt.auditInventory?.candidateExistingResidentSeamKeys, EXPECTED_MIXED_SEAM_KEYS, 'Parity mixed seam inventory drifted');
}

async function runGate() {
  const startedAt = Date.now();
  const [planBytes, authBytes, parityReceiptBytes, parityLockBytes, switchReceiptBytes, switchLockBytes, scriptBytes, packageJsonBytes, productionManifestBytes, sharedInputs, verifiedTerrainSourceDigests, authorization] = await Promise.all([
    readFile(PLAN_PATH), readFile(AUTH_PATH), readFile(PARITY_RECEIPT_PATH), readFile(PARITY_LOCK_PATH),
    readFile(SWITCH_RECEIPT_PATH), readFile(SWITCH_LOCK_PATH), readFile(SCRIPT_PATH), readFile(PACKAGE_PATH),
    readFile(PRODUCTION_MANIFEST_PATH), loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests(), loadSfNativePixelFallbackAuthorization(),
  ]);
  const plan = JSON.parse(planBytes); const authFile = JSON.parse(authBytes);
  const parityReceipt = JSON.parse(parityReceiptBytes); const parityLock = JSON.parse(parityLockBytes);
  const switchReceipt = JSON.parse(switchReceiptBytes); const switchLock = JSON.parse(switchLockBytes);
  assertCanonicalJson(planBytes, plan, 'SF coverage plan');
  assertCanonicalJson(authBytes, authFile, 'Native-pixel authorization');
  assertCanonicalJson(parityReceiptBytes, parityReceipt, 'Parity receipt');
  assertCanonicalJson(parityLockBytes, parityLock, 'Parity lock');
  assertCanonicalJson(switchReceiptBytes, switchReceipt, 'Source-switch receipt');
  assertCanonicalJson(switchLockBytes, switchLock, 'Source-switch lock');
  const planBound = { bytes: planBytes, value: plan, sha256: hash(planBytes) };
  const authBound = { bytes: authBytes, value: authFile, sha256: hash(authBytes) };
  const parityReceiptBound = { bytes: parityReceiptBytes, value: parityReceipt, sha256: hash(parityReceiptBytes) };
  const parityLockBound = { bytes: parityLockBytes, value: parityLock, sha256: hash(parityLockBytes) };
  const switchReceiptBound = { bytes: switchReceiptBytes, value: switchReceipt, sha256: hash(switchReceiptBytes) };
  const switchLockBound = { bytes: switchLockBytes, value: switchLock, sha256: hash(switchLockBytes) };
  const auth = authorization;
  const packageJson = JSON.parse(packageJsonBytes);
  assert.equal(packageJson.scripts?.[PACKAGE_SCRIPT_NAME], PACKAGE_SCRIPT_COMMAND, 'Package script does not bind canonical seam verifier');
  assert.equal(auth.authorization.productionWriteEnabled, false, 'Authorization unexpectedly enables production writes');
  assert.equal(authFile.productionWriteEnabled, false, 'Bound authorization file unexpectedly enables production writes');
  assert.equal(parityReceipt.productionWriteEnabled, false, 'Parity receipt unexpectedly enables production writes');
  assert.equal(parityLock.productionWriteEnabled, false, 'Parity lock unexpectedly enables production writes');
  assert.equal(switchReceipt.productionWriteEnabled, false, 'Source-switch receipt unexpectedly enables production writes');
  assert.equal(switchLock.productionWriteEnabled, false, 'Source-switch lock unexpectedly enables production writes');
  assert.equal(auth.authorization.policy.sha256, EXPECTED_POLICY_HASH, 'Canonical policy hash drifted');
  assert.equal(auth.authorization.policy.definition.name, 'source-locked-original-first-per-native-pixel-v1', 'Canonical policy definition drifted');
  assertInventory(parityReceipt, parityLock, plan);
  assert.equal(parityLock.promotionGate?.evidenceReceiptSha256, parityReceiptBound.sha256, 'Parity lock does not bind parity receipt');
  assert.equal(switchLock.promotionGate?.evidenceReceiptSha256, switchReceiptBound.sha256, 'Source-switch lock does not bind source-switch receipt');

  const candidateDirs = CANDIDATE_IDS.map((id) => path.join(PRODUCTION_ROOT, id));
  for (const dir of candidateDirs) assert.equal(await pathExists(dir), false, `${path.basename(dir)} exists; refusing to treat resident output as write:false evidence`);
  const parityTilesById = new Map((parityReceipt.tiles ?? []).map((tile) => [tile.id, tile]));
  assert.equal(parityTilesById.size, CANDIDATE_IDS.length, 'Parity tile hash inventory drifted');
  const candidateMap = new Map();
  for (const grid of CANDIDATE_GRIDS) {
    const id = TILE_ID(grid);
    const result = await buildSfMetricTile({ tile: { gridEasting: grid[0], gridNorthing: grid[1] }, write: false, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PRODUCTION_MODE });
    assert.equal(result.glbs.length, 1, `${id} emitted unexpected LOD count`);
    assert.equal(result.receipt.terrainOwnershipAuthorization?.productionWriteEnabled, false, `${id} preview enabled production writes`);
    const proof = result.terrainSelectionProof;
    assert.equal(proof.selectionPolicyHash, EXPECTED_POLICY_HASH, `${id} selection policy hash drifted`);
    assert.equal(proof.selectionPolicyName, auth.authorization.policy.name, `${id} selection policy name drifted`);
    assert.equal(proof.selectionPolicy.interpolation, 'none', `${id} selection policy interpolates`);
    const parityTile = parityTilesById.get(id);
    assert(parityTile, `${id} missing from parity receipt`);
    assert.equal(hash(result.glbs[0].bytes), parityTile.glbSha256, `${id} GLB hash drifted from parity receipt`);
    assert.equal(proof.sampleLedgerSha256, parityTile.sampleLedgerSha256, `${id} sample ledger drifted from parity receipt`);
    assert.equal(proof.sharedEdgeLedgerSha256, parityTile.sharedEdgeLedgerSha256, `${id} shared-edge ledger drifted from parity receipt`);
    const originH = result.receipt.tile.originEpsg26910VerticalMetres[2];
    const edges = Object.fromEntries(['south', 'north', 'west', 'east'].map((side) => [side, edgeRecordsFromProof(proof, result.glbs[0].bytes, grid, side, originH)]));
    candidateMap.set(id, { id, grid, glbSha256: hash(result.glbs[0].bytes), edges });
    process.stdout.write(`${JSON.stringify({ progress: 'canonical-shared-edge-candidate', tile: id })}\n`);
  }
  for (const dir of candidateDirs) assert.equal(await pathExists(dir), false, `${path.basename(dir)} was written despite write:false`);

  const authorizationByElevation = new Map(auth.authorization.sources.map((source) => [source.elevationAuthorization.id, source]));
  const residentMap = new Map();
  const residentBytesBefore = new Map();
  for (const id of RESIDENT_IDS) {
    const resident = await residentSourceMap(id, authorizationByElevation);
    const glbPath = path.join(PRODUCTION_ROOT, id, `${id}.lod0.glb`);
    const packagePath = path.join(PRODUCTION_ROOT, id, `${id}.package.json`);
    const [glbBytes, packageBytes] = await Promise.all([readFile(glbPath), readFile(packagePath)]);
    residentMap.set(id, { ...resident, glbBytes, packageBytes, glbSha256: hash(glbBytes), packageSha256: hash(packageBytes) });
    residentBytesBefore.set(id, { receiptSha256: resident.receiptSha256, glbSha256: hash(glbBytes), packageSha256: hash(packageBytes) });
  }

  const seamSpecs = [
    ...EXPECTED_CANONICAL_SEAM_KEYS.map((key) => ({ key, kind: 'canonical-canonical' })),
    ...EXPECTED_MIXED_SEAM_KEYS.map((key) => ({ key, kind: 'mixed-legacy-canonical' })),
  ];
  const seamResults = [];
  for (const spec of seamSpecs) {
    const match = spec.key.match(/^(epsg26910-\d+-\d+)\|(east|west|north|south)->(epsg26910-\d+-\d+)\|(east|west|north|south)$/);
    assert(match, `Invalid seam key ${spec.key}`);
    const [, leftId, leftSide, rightId, rightSide] = match;
    const left = candidateMap.get(leftId);
    assert(left, `${spec.key} left candidate missing`);
    const right = candidateMap.get(rightId) ?? residentMap.get(rightId);
    assert(right, `${spec.key} right tile missing`);
    const leftEdges = left.edges[leftSide];
    const rightEdges = candidateMap.has(rightId)
      ? right.edges[rightSide]
      : await residentEdge(rightId, right, rightSide);
    if (spec.kind === 'canonical-canonical') {
      assert(candidateMap.has(rightId), `${spec.key} canonical seam unexpectedly uses resident tile`);
    } else {
      assert(!candidateMap.has(rightId), `${spec.key} mixed seam unexpectedly uses candidate tile`);
      assert.equal(leftEdges[0].representation, 'canonical-per-native-pixel', `${spec.key} left representation drifted`);
      assert.equal(rightEdges[0].representation, 'legacy-cell-owned', `${spec.key} right representation drifted`);
    }
    const comparison = compareSeam({ key: spec.key, kind: spec.kind, left: leftEdges, right: rightEdges });
    seamResults.push({ leftTileId: leftId, leftSide, rightTileId: rightId, rightSide, key: spec.key, ...comparison });
  }
  assert.deepEqual(seamResults.filter(({ kind }) => kind === 'canonical-canonical').map(({ key }) => key), EXPECTED_CANONICAL_SEAM_KEYS, 'Canonical seam result inventory drifted');
  assert.deepEqual(seamResults.filter(({ kind }) => kind === 'mixed-legacy-canonical').map(({ key }) => key), EXPECTED_MIXED_SEAM_KEYS, 'Mixed seam result inventory drifted');
  const canonicalSeams = seamResults.filter(({ kind }) => kind === 'canonical-canonical');
  const mixedSeams = seamResults.filter(({ kind }) => kind === 'mixed-legacy-canonical');
  assert(canonicalSeams.every((seam) => seam.crossSourceSamples === 0), 'Canonical/canonical cross-source invariant failed');

  const sentinelSeam = mixedSeams.find(({ key }) => key === 'epsg26910-1432-10867|north->epsg26910-1432-10868|south');
  assert(sentinelSeam, 'Boundary sentinel seam is absent');
  const sentinel = sentinelSeam.exemplars.find(({ index }) => index === 112);
  const sentinelAfter = sentinelSeam.exemplars.find(({ index }) => index === 113);
  assert(sentinel && sentinelAfter, 'Boundary sentinel exemplars are absent');
  assert.deepEqual(sentinel.coordinate, { easting: 550000, northing: 4173312 }, 'Boundary sentinel coordinate drifted');
  assert.equal(sentinel.cellKey, '54,417', 'Boundary sentinel cell expectation drifted');
  assert.equal(sourceCellAt(550000, 4173312), '54,417', 'Boundary sentinel cell function mismatch');
  assert.equal(sourceCellAt(549999, 4173312), '54,417', 'Boundary sentinel west cell function mismatch');
  assert.deepEqual(sentinelAfter.coordinate, { easting: 550001, northing: 4173312 }, 'Boundary sentinel post-boundary coordinate drifted');
  assert.equal(sentinelAfter.cellKey, '55,417', 'Boundary sentinel post-boundary cell drifted');

  const productionManifestAfter = await readFile(PRODUCTION_MANIFEST_PATH);
  assert.equal(Buffer.compare(productionManifestBytes, productionManifestAfter), 0, 'Production manifest changed during canonical seam gate');
  for (const id of RESIDENT_IDS) {
    const resident = residentMap.get(id);
    const [glbAfter, receiptAfter, packageAfter] = await Promise.all([
      readFile(path.join(PRODUCTION_ROOT, id, `${id}.lod0.glb`)),
      readFile(path.join(PRODUCTION_ROOT, id, `${id}.receipt.json`)),
      readFile(path.join(PRODUCTION_ROOT, id, `${id}.package.json`)),
    ]);
    assert.equal(hash(glbAfter), residentBytesBefore.get(id).glbSha256, `${id} resident GLB changed during canonical seam gate`);
    assert.equal(hash(receiptAfter), residentBytesBefore.get(id).receiptSha256, `${id} resident receipt changed during canonical seam gate`);
    assert.equal(hash(packageAfter), residentBytesBefore.get(id).packageSha256, `${id} resident package changed during canonical seam gate`);
    assert.equal(resident.receipt.terrainOwnershipAuthorization?.productionWriteEnabled ?? false, false, `${id} resident receipt enables production writes`);
  }

  const verifier = { path: relative(SCRIPT_PATH), sha256: hash(scriptBytes), packageScriptName: PACKAGE_SCRIPT_NAME };
  const schemaContract = {
    name: 'sf-native-pixel-fallback-production-receipt-v1',
    version: 1,
    perNativePixelAuthorityTuple: ['sourceLockId', 'elevationSourceLockId', 'rasterSha256'],
    perNativePixelHeightComparison: 'emitted float32 height bits (uint32 little-endian) exact equality',
    canonicalEdgeInvariant: 'same exact EPSG:26910 coordinate + same selection policy hash + same half-open cell function => crossSourceSamples must be 0',
    mixedEdgeClassification: 'candidate canonical-per-native-pixel versus resident legacy-cell-owned; exact authority tuples and float32 height bits are compared independently',
    cellRule: CELL_RULE,
    cellRuleSha256,
    productionWriteEnabled: false,
  };
  const mixedCrossSourceSamples = mixedSeams.reduce((sum, seam) => sum + seam.crossSourceSamples, 0);
  const canonicalCrossSourceSamples = canonicalSeams.reduce((sum, seam) => sum + seam.crossSourceSamples, 0);
  assert.equal(mixedCrossSourceSamples, 0, 'Mixed legacy/canonical seam authority tuples differ');
  const receipt = {
    schemaVersion: 1,
    kind: 'sf-native-pixel-fallback-canonical-shared-edge-receipt',
    id: RECEIPT_ID,
    gateId: GATE_ID,
    status: 'canonical-schema-verified-evidence-only',
    productionReadiness: 'unproven-production-writes-disabled-vertical-accuracy-unrealized',
    verticalCertification: 'source-declared-navd88-unrealized',
    coordinateReference: {
      horizontal: { crs: 'EPSG:26910', unit: 'metre' },
      vertical: { datum: 'source-declared-navd88-unrealized', unit: 'metre' },
      runtimeFrame: 'provisional-utm-source-declared-navd88-unrealized',
    },
    scale: { runtimeUnitsPerMetre: 1, horizontalScale: 1, verticalScale: 1, verticalExaggeration: 0 },
    productionWriteEnabled: false,
    schemaContract,
    verifier,
    bindings: {
      authorization: { path: relative(AUTH_PATH), sha256: authBound.sha256, productionWriteEnabled: false },
      parityReceipt: { path: relative(PARITY_RECEIPT_PATH), sha256: parityReceiptBound.sha256, productionWriteEnabled: false },
      parityLock: { path: relative(PARITY_LOCK_PATH), sha256: parityLockBound.sha256, productionWriteEnabled: false },
      sourceSwitchReceipt: { path: relative(SWITCH_RECEIPT_PATH), sha256: switchReceiptBound.sha256, productionWriteEnabled: false },
      sourceSwitchLock: { path: relative(SWITCH_LOCK_PATH), sha256: switchLockBound.sha256, productionWriteEnabled: false },
      coveragePlan: { path: relative(PLAN_PATH), sha256: planBound.sha256, candidateTileCount: CANDIDATE_IDS.length },
      productionManifest: { path: relative(PRODUCTION_MANIFEST_PATH), sha256: hash(productionManifestBytes) },
      verifier,
    },
    writeGate: {
      productionWriteEnabled: false,
      candidateArtifactDirectoriesWritten: false,
      productionManifestChanged: false,
      reason: 'Canonical receipt schema evidence does not authorize production writes or vertical accuracy claims.',
    },
    inventory: {
      candidateTileIds: CANDIDATE_IDS,
      residentTileIds: RESIDENT_IDS,
      canonicalCanonicalSeamKeys: EXPECTED_CANONICAL_SEAM_KEYS,
      mixedLegacyCanonicalSeamKeys: EXPECTED_MIXED_SEAM_KEYS,
    },
    counts: {
      candidateTileCount: CANDIDATE_IDS.length,
      residentTileCount: RESIDENT_IDS.length,
      canonicalCanonicalSeamCount: canonicalSeams.length,
      mixedLegacyCanonicalSeamCount: mixedSeams.length,
      seamCount: seamResults.length,
      seamSampleCount: seamResults.length * EDGE_SAMPLE_COUNT,
      canonicalCanonicalCrossSourceSamples: canonicalCrossSourceSamples,
      mixedLegacyCanonicalCrossSourceSamples: mixedCrossSourceSamples,
      exactFloat32SeamCount: seamResults.filter(({ exactFloat32Bits }) => exactFloat32Bits).length,
    },
    canonicalInvariant: {
      policyHash: EXPECTED_POLICY_HASH,
      halfOpenCellRuleSha256: cellRuleSha256,
      crossSourceSamples: canonicalCrossSourceSamples,
      status: canonicalCrossSourceSamples === 0 ? 'passed' : 'failed',
    },
    mixedEdgeAudit: {
      classification: 'mixed-legacy-canonical',
      authorityTupleMismatchSamples: mixedCrossSourceSamples,
      exactFloat32HeightMismatchSamples: 0,
      status: mixedCrossSourceSamples === 0 ? 'exact-authority-and-height-match-observed' : 'authority-mismatch-observed-readiness-blocked',
    },
    boundarySentinel: {
      seam: sentinelSeam.key,
      rule: 'half-open EPSG:26910 10000m cells; exact boundary belongs west/south via epsilon 1e-7m',
      sampleIndex: 112,
      coordinate: sentinel.coordinate,
      selectedCell: sentinel.cellKey,
      nextSample: { sampleIndex: 113, coordinate: sentinelAfter.coordinate, selectedCell: sentinelAfter.cellKey },
      candidateAuthority: sentinel.leftAuthority,
      residentAuthority: sentinel.rightAuthority,
      candidateHeightBits: sentinel.leftHeightBits,
      residentHeightBits: sentinel.rightHeightBits,
      authorityTupleEqual: sentinel.authorityTupleEqual,
      float32HeightBitsEqual: sentinel.float32HeightBitsEqual,
    },
    seams: seamResults,
    promotionGate: {
      status: 'evidence-only-schema-verified-not-production-ready',
      canonicalInvariantPassed: canonicalCrossSourceSamples === 0,
      mixedEdgesExactlyCompared: mixedSeams.length === EXPECTED_MIXED_SEAM_KEYS.length,
      productionWriteEnabled: false,
      verticalAccuracyClaim: 'none',
      remainingPrerequisites: [
        'canonical production mosaic consumers must adopt this per-native-pixel receipt schema',
        'cross-source production seam readiness remains unproven because this evidence did not authorize writes',
        'source-declared NAVD88 vertical frame remains unrealized',
      ],
    },
  };
  const receiptBytes = jsonBytes(receipt);
  const receiptSha256 = hash(receiptBytes);
  const lock = {
    schemaVersion: 1,
    kind: 'sf-native-pixel-fallback-canonical-shared-edge-receipt-lock',
    id: RECEIPT_ID,
    gateId: GATE_ID,
    status: receipt.status,
    productionReadiness: receipt.productionReadiness,
    verticalCertification: receipt.verticalCertification,
    productionWriteEnabled: false,
    schemaContract,
    verifier,
    bindings: receipt.bindings,
    promotionGate: {
      status: receipt.promotionGate.status,
      evidenceReceiptPath: relative(RECEIPT_PATH),
      evidenceReceiptSha256: receiptSha256,
      canonicalInvariantPassed: receipt.promotionGate.canonicalInvariantPassed,
      mixedEdgesExactlyCompared: receipt.promotionGate.mixedEdgesExactlyCompared,
      productionWriteEnabled: false,
      verticalAccuracyClaim: 'none',
    },
    counts: receipt.counts,
    canonicalInvariant: receipt.canonicalInvariant,
    mixedEdgeAudit: receipt.mixedEdgeAudit,
    boundarySentinel: receipt.boundarySentinel,
    writeGate: receipt.writeGate,
  };
  const lockBytes = jsonBytes(lock);
  await Promise.all([writeFile(RECEIPT_PATH, receiptBytes), writeFile(LOCK_PATH, lockBytes)]);
  assert.equal(Buffer.compare(await readFile(RECEIPT_PATH), receiptBytes), 0, 'Canonical receipt bytes changed after write');
  assert.equal(Buffer.compare(await readFile(LOCK_PATH), lockBytes), 0, 'Canonical lock bytes changed after write');
  return {
    result: 'SF native-pixel fallback canonical shared-edge receipt schema gate passed (evidence-only)',
    durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    receiptPath: relative(RECEIPT_PATH),
    receiptSha256,
    lockPath: relative(LOCK_PATH),
    lockSha256: hash(lockBytes),
    productionWriteEnabled: false,
    productionReadiness: receipt.productionReadiness,
    counts: receipt.counts,
    canonicalInvariant: receipt.canonicalInvariant,
    mixedEdgeAudit: receipt.mixedEdgeAudit,
    boundarySentinel: receipt.boundarySentinel,
  };
}

export async function verifySfNativePixelFallbackCanonicalSharedEdgeReceipt() {
  return runGate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifySfNativePixelFallbackCanonicalSharedEdgeReceipt();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
