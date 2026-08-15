/**
 * All-25, write-disabled native-pixel fallback parity gate.
 *
 * This verifier deliberately keeps candidate outputs in memory only while
 * compacting their evidence.  It proves deterministic duplicate GLB, receipt,
 * and package bytes for the 25 source-ready fallback tiles, then compares
 * every available 4-neighbour edge against either an in-memory candidate or a
 * byte-locked resident artifact.  The compact canonical receipt is evidence
 * only; it never enables production writes.
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
const RECEIPT_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-production-parity-v1.receipt.json');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-native-pixel-fallback-production-parity-v1.lock.json');
const PRODUCTION_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const PRODUCTION_MANIFEST_PATH = path.join(PRODUCTION_ROOT, 'sf-metric-tiles-v1.manifest.json');
const PRODUCTION_MODE = 'per-native-pixel-fallback-production-v1';
const TILE_SIZE = 384;
const TILE_KEYS = [
  ...Array.from({ length: 24 }, (_, index) => [1417 + index, 10867]),
  [1440, 10868],
];
const TILE_ID = ([easting, northing]) => `epsg26910-${easting}-${northing}`;
const EXPECTED_RESIDENT_IDS = [
  'epsg26910-1420-10868', 'epsg26910-1421-10868', 'epsg26910-1422-10868', 'epsg26910-1423-10868',
  'epsg26910-1424-10868', 'epsg26910-1425-10868', 'epsg26910-1426-10868', 'epsg26910-1427-10868',
  'epsg26910-1428-10868', 'epsg26910-1429-10868', 'epsg26910-1430-10868', 'epsg26910-1431-10868',
  'epsg26910-1432-10868', 'epsg26910-1433-10868', 'epsg26910-1434-10868', 'epsg26910-1435-10868',
  'epsg26910-1436-10868', 'epsg26910-1437-10868', 'epsg26910-1438-10868', 'epsg26910-1439-10868',
  'epsg26910-1440-10869',
];
const EXPECTED_CANDIDATE_CANDIDATE_SEAM_KEYS = [
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
const EXPECTED_CANDIDATE_RESIDENT_SEAM_KEYS = [
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
const DISAGREEMENT_POLICY = {
  status: 'report-only',
  rationale: 'original finite pixels remain authoritative; CaliforniaGaps disagreement is diagnostic evidence only',
  interpolation: 'none',
  verticalAccuracyClaim: 'none',
  statistics: 'record maxBothFiniteDisagreementMetres and p99BothFiniteDisagreementMetres per tile',
  promotionEffect: 'does-not-count-as-source-agreement',
};
const PROMOTION_PREREQUISITES = [
  {
    id: 'internal-source-switch-continuity-audit-v1',
    status: 'required-not-exercised',
    requirement: 'Exercise an internal source-switch continuity audit where adjacent native samples intentionally cross original and CaliforniaGaps authority.',
  },
  {
    id: 'cross-source-seam-gate-v1',
    status: 'required-not-exercised',
    requirement: 'Exercise and exact-compare at least one cross-source candidate/resident seam before claiming cross-source production readiness.',
  },
  {
    id: 'canonical-production-mosaic-receipt-schema-v1',
    status: 'required-not-exercised',
    requirement: 'Promote only after standard production mosaic verifiers consume the per-native-pixel receipt schema.',
  },
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (bytes) => `sha256:${sha256(bytes)}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stableBytes = (value) => Buffer.from(JSON.stringify(value));
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');

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
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binOffset = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing');
  const binLength = bytes.readUInt32LE(binOffset);
  assert.equal(binOffset + 8 + binLength, bytes.length, 'GLB BIN chunk length mismatch');
  return { gltf, bin: bytes.subarray(binOffset + 8) };
}

function readPositions(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  assert(accessor?.type === 'VEC3' && accessor.componentType === 5126, 'Terrain positions must be float32 VEC3');
  const view = gltf.bufferViews[accessor.bufferView];
  assert(view, 'Terrain position buffer view missing');
  const stride = view.byteStride ?? 12;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const points = [];
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = base + index * stride;
    const x = bin.readFloatLE(offset);
    const y = bin.readFloatLE(offset + 4);
    const z = bin.readFloatLE(offset + 8);
    assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'GLB emitted non-finite terrain position');
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
      assert(Number.isInteger(along), `${side} edge has a non-integer sample coordinate ${along}`);
      const key = floatBits(along);
      const record = { along, alongBits: key, yBits: floatBits(point.y) };
      const existing = edge.get(key);
      if (existing) assert.equal(existing.yBits, record.yBits, `${side} duplicated edge height differs at ${along}`);
      else edge.set(key, record);
    }
  }
  const records = [...edge.values()].sort((a, b) => a.along - b.along);
  assert.equal(records.length, TILE_SIZE + 1, `${side} edge must expose exactly 385 native samples`);
  for (let index = 0; index < records.length; index += 1) assert.equal(records[index].along, index, `${side} edge sample ${index} is not one metre apart`);
  return records;
}

function tileGrid(tile) {
  return { easting: tile[0], northing: tile[1], minE: tile[0] * TILE_SIZE, minN: tile[1] * TILE_SIZE };
}

function edgeRecords(proof, side, grid) {
  const records = proof?.sharedEdgeSamples?.[side];
  assert(Array.isArray(records), `Missing ${side} source-aware edge ledger`);
  assert.equal(records.length, TILE_SIZE + 1, `${side} source-aware edge must expose 385 samples`);
  const { minE, minN } = tileGrid(grid);
  const sorted = [...records].sort((a, b) => {
    const aa = side === 'north' || side === 'south' ? a.modelEastingMetres : a.modelNorthingMetres;
    const bb = side === 'north' || side === 'south' ? b.modelEastingMetres : b.modelNorthingMetres;
    return aa - bb;
  });
  for (let index = 0; index < sorted.length; index += 1) {
    const record = sorted[index];
    const along = side === 'north' || side === 'south' ? record.modelEastingMetres - minE : record.modelNorthingMetres - minN;
    assert.equal(along, index, `${side} source ledger sample ${index} is not one metre apart`);
    assert(Number.isFinite(record.sampledSourceDeclaredNavd88UnrealizedMetres), `${side} source ledger height is non-finite`);
    assert(record.sourceLockId && record.elevationSourceLockId && record.rasterSha256, `${side} source ledger authority is incomplete`);
  }
  return sorted;
}

function compactCounts(counts) {
  return {
    uniqueNativeSampleCoordinates: counts.uniqueNativeSampleCoordinates,
    originalFiniteSamples: counts.originalFiniteSamples,
    californiaGapsFallbackSamples: counts.californiaGapsFallbackSamples,
    sourceSampleCounts: Object.fromEntries(Object.entries(counts.sourceSampleCounts).sort(([a], [b]) => a.localeCompare(b))),
    sourceProbeStats: Object.fromEntries(Object.entries(counts.sourceProbeStats).sort(([a], [b]) => a.localeCompare(b))),
    bothFiniteSourceComparisons: counts.bothFiniteSourceComparisons,
    maxBothFiniteDisagreementMetres: counts.maxBothFiniteDisagreementMetres,
    p99BothFiniteDisagreementMetres: counts.p99BothFiniteDisagreementMetres,
  };
}

function assertCandidateProof(result, grid, authorization) {
  const id = TILE_ID(grid);
  const proof = result.terrainSelectionProof;
  assert(proof, `${id} did not expose native-pixel source proof`);
  assert.equal(proof.mode, PRODUCTION_MODE, `${id} terrain selection mode drifted`);
  assert.equal(proof.status, 'provisional-vertical-unrealized', `${id} vertical status drifted`);
  assert.equal(proof.verticalCertification, 'source-declared-navd88-unrealized', `${id} vertical certification drifted`);
  assert.equal(proof.selectionPolicyName, authorization.authorization.policy.name, `${id} selection policy drifted`);
  assert.equal(proof.selectionPolicyHash, authorization.authorization.policy.sha256, `${id} selection policy hash drifted`);
  assert.equal(proof.selectionPolicy.interpolation, 'none', `${id} proof allows interpolation`);
  assert.equal(proof.records.length, proof.counts.uniqueNativeSampleCoordinates, `${id} sample ledger count drifted`);
  assert.equal(result.receipt.tile.identity, id, `${id} receipt identity drifted`);
  assert.equal(result.receipt.tile.scale, 1, `${id} receipt scale drifted`);
  assert.equal(result.receipt.deterministicInputs.terrainGridStepMetres, 1, `${id} terrain lattice drifted`);
  assert.equal(result.receipt.deterministicInputs.terrainSelectionMode, PRODUCTION_MODE, `${id} receipt mode drifted`);
  assert.equal(result.receipt.terrainSelectionEvidence?.sampleLedgerSha256, proof.sampleLedgerSha256, `${id} receipt omitted sample-ledger hash`);
  assert.equal(result.receipt.terrainOwnershipAuthorization?.productionWriteEnabled, false, `${id} preview enabled production writes`);
  let chosenSamples = 0;
  for (const stats of Object.values(proof.counts.sourceProbeStats)) {
    assert.equal(stats.nonFiniteCount, 0, `${id} source ${stats.sourceLockId} has non-finite probes`);
    assert.equal(stats.outsideWindowCount, 0, `${id} source ${stats.sourceLockId} lost source coverage`);
    assert(stats.finiteCount + stats.noDataCount >= stats.chosenCount, `${id} source ${stats.sourceLockId} probe accounting under-runs chosen samples`);
    chosenSamples += stats.chosenCount;
  }
  assert.equal(chosenSamples, proof.counts.uniqueNativeSampleCoordinates, `${id} chosen source accounting does not cover every sample exactly once`);
  const authSourceIds = new Set(authorization.authorization.sources.map(({ sourceLock }) => sourceLock.id));
  for (const record of proof.records) {
    assert(authSourceIds.has(record.sourceLockId), `${id} sample selected an unauthorized source ${record.sourceLockId}`);
    assert(Number.isInteger(record.nativePixel.column) && Number.isInteger(record.nativePixel.row), `${id} sample native pixel is incomplete`);
    if (record.sourceRole === 'californiagaps-fallback') {
      assert.equal(record.fallbackOriginalReason, 'nodata', `${id} fallback was not caused by original NoData`);
      assert(record.fallbackFromSourceLockId, `${id} fallback omitted original source binding`);
    }
  }
  return proof;
}

async function readResident(tileId, authorizationByElevation) {
  const dir = path.join(PRODUCTION_ROOT, tileId);
  const glbPath = path.join(dir, `${tileId}.lod0.glb`);
  const receiptPath = path.join(dir, `${tileId}.receipt.json`);
  const packagePath = path.join(dir, `${tileId}.package.json`);
  const [glbBytes, receiptBytes, packageBytes] = await Promise.all([readFile(glbPath), readFile(receiptPath), readFile(packagePath)]);
  const receipt = JSON.parse(receiptBytes);
  assertCanonicalJson(receiptBytes, receipt, `${tileId} resident receipt`);
  assert.equal(receipt.tile.identity, tileId, `${tileId} resident receipt identity drifted`);
  assert.equal(receipt.status, 'provisional-vertical-unrealized', `${tileId} resident vertical status drifted`);
  assert.equal(receipt.tile.scale, 1, `${tileId} resident scale drifted`);
  const sourceByCell = new Map();
  for (const source of receipt.source?.geoTiffs ?? []) {
    assert(source.ownershipCell && source.elevationSourceLockId && source.sha256, `${tileId} resident source authority is incomplete`);
    assert(!sourceByCell.has(source.ownershipCell), `${tileId} resident has duplicate terrain authority for ${source.ownershipCell}`);
    const elevationAuthorization = authorizationByElevation.get(source.elevationSourceLockId);
    let sourceLockId = elevationAuthorization?.sourceLock?.id;
    if (!sourceLockId) {
      const elevationPath = path.join(ROOT, 'public/data/world/source-locks', `${source.elevationSourceLockId}.lock.json`);
      const elevationLock = JSON.parse(await readFile(elevationPath));
      sourceLockId = elevationLock.sourceLock?.id;
    }
    assert(sourceLockId, `${tileId} cannot resolve source lock for ${source.elevationSourceLockId}`);
    sourceByCell.set(source.ownershipCell, {
      sourceLockId,
      elevationSourceLockId: source.elevationSourceLockId,
      rasterSha256: source.sha256,
    });
  }
  return {
    id: tileId,
    glbBytes,
    receipt,
    packageBytes,
    glbSha256: hash(glbBytes),
    receiptSha256: hash(receiptBytes),
    packageSha256: hash(packageBytes),
    sourceByCell,
  };
}

function sourceCellAt(easting, northing) {
  return `${Math.floor((easting - 1e-7) / 10000)},${Math.floor((northing - 1e-7) / 10000)}`;
}

function residentEdge(resident, side) {
  const edge = glbEdge(resident.glbBytes, side);
  const tileParts = resident.id.match(/epsg26910-(\d+)-(\d+)/);
  assert(tileParts, `${resident.id} resident tile identity is invalid`);
  const minE = Number(tileParts[1]) * TILE_SIZE;
  const minN = Number(tileParts[2]) * TILE_SIZE;
  return edge.map((sample) => {
    const easting = minE + (side === 'north' || side === 'south' ? sample.along : side === 'east' ? TILE_SIZE : 0);
    const northing = minN + (side === 'north' || side === 'south' ? (side === 'north' ? TILE_SIZE : 0) : sample.along);
    const authority = resident.sourceByCell.get(sourceCellAt(easting, northing));
    assert(authority, `${resident.id} has no source authority for edge cell ${sourceCellAt(easting, northing)}`);
    return { ...sample, easting, northing, ...authority };
  });
}

function candidateEdge(proof, glbBytes, side, grid) {
  const records = edgeRecords(proof, side, grid);
  const glb = glbEdge(glbBytes, side);
  assert.equal(glb.length, records.length, `${TILE_ID(grid)} ${side} GLB/source edge counts differ`);
  return records.map((record, index) => {
    return {
      ...glb[index],
      easting: record.modelEastingMetres,
      northing: record.modelNorthingMetres,
      sourceLockId: record.sourceLockId,
      elevationSourceLockId: record.elevationSourceLockId,
      rasterSha256: record.rasterSha256,
    };
  });
}

function compareSeam(left, leftSide, right, rightSide, label, kind) {
  const leftSamples = left(leftSide);
  const rightSamples = right(rightSide);
  assert.equal(leftSamples.length, TILE_SIZE + 1, `${label} left edge sample count drifted`);
  assert.equal(rightSamples.length, TILE_SIZE + 1, `${label} right edge sample count drifted`);
  let sameSourceSamples = 0;
  let crossSourceSamples = 0;
  const ledger = [];
  for (let index = 0; index <= TILE_SIZE; index += 1) {
    const a = leftSamples[index];
    const b = rightSamples[index];
    assert.equal(a.alongBits, b.alongBits, `${label} horizontal edge coordinate bits differ at ${index}`);
    assert.equal(a.yBits, b.yBits, `${label} exact float32 height bits differ at ${index}`);
    const sameSource = a.sourceLockId === b.sourceLockId;
    if (sameSource) {
      sameSourceSamples += 1;
      assert.equal(a.elevationSourceLockId, b.elevationSourceLockId, `${label} same-source elevation authority differs at ${index}`);
      assert.equal(a.rasterSha256, b.rasterSha256, `${label} same-source raster authority differs at ${index}`);
    } else crossSourceSamples += 1;
    ledger.push({
      index,
      alongBits: a.alongBits,
      heightBits: a.yBits,
      leftSourceLockId: a.sourceLockId,
      leftElevationSourceLockId: a.elevationSourceLockId,
      leftRasterSha256: a.rasterSha256,
      rightSourceLockId: b.sourceLockId,
      rightElevationSourceLockId: b.elevationSourceLockId,
      rightRasterSha256: b.rasterSha256,
    });
  }
  return {
    kind,
    samples: TILE_SIZE + 1,
    exactFloat32Bits: true,
    sameSourceSamples,
    crossSourceSamples,
    sourceAuthoritySampleLedgerSha256: hash(stableBytes(ledger)),
  };
}

function neighbour(grid, direction) {
  const [easting, northing] = grid;
  if (direction === 'west') return [easting - 1, northing];
  if (direction === 'east') return [easting + 1, northing];
  if (direction === 'south') return [easting, northing - 1];
  return [easting, northing + 1];
}

const OPPOSITE = { west: 'east', east: 'west', south: 'north', north: 'south' };
const seamKey = ({ leftTileId, leftSide, rightTileId, rightSide }) => `${leftTileId}|${leftSide}->${rightTileId}|${rightSide}`;

async function pathExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function buildParity() {
  const startedAt = Date.now();
  const [planBytes, authBytes, sharedInputs, verifiedTerrainSourceDigests, authorization, productionManifestBytes] = await Promise.all([
    readFile(PLAN_PATH), readFile(AUTH_PATH), loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests(), loadSfNativePixelFallbackAuthorization(), readFile(PRODUCTION_MANIFEST_PATH),
  ]);
  const plan = JSON.parse(planBytes);
  assertCanonicalJson(planBytes, plan, 'SF coverage plan');
  const auth = authorization.authorization;
  assert.equal(auth.productionWriteEnabled, false, 'Native-pixel authorization must remain write-disabled');
  assert.equal(auth.promotionGate.requiredTileCount, TILE_KEYS.length, 'Native-pixel authorization tile count drifted');
  const authSha256 = hash(authBytes);
  const planSha256 = hash(planBytes);
  const expectedIds = TILE_KEYS.map(TILE_ID);
  for (const id of expectedIds) {
    const planned = plan.tiles.find((tile) => tile.id === id);
    assert(planned, `${id} is absent from the locked coverage plan`);
    assert.equal(planned.sourceReadiness?.buildReady, false, `${id} unexpectedly claims production terrain readiness`);
    assert.match(planned.sourceReadiness?.terrainElevation ?? '', /californiagaps/, `${id} is not marked CaliforniaGaps fallback-source-ready`);
  }

  const candidateDirs = expectedIds.map((id) => path.join(PRODUCTION_ROOT, id));
  for (const dir of candidateDirs) assert.equal(await pathExists(dir), false, `${path.basename(dir)} candidate directory already exists; refusing to audit a resident as a preview`);

  const authorizationByElevation = new Map(auth.sources.map((source) => [source.elevationAuthorization.id, source]));
  const candidateMap = new Map();
  const residentCache = new Map();
  const residentHashesBefore = new Map();

  for (const grid of TILE_KEYS) {
    const id = TILE_ID(grid);
    const options = { tile: { gridEasting: grid[0], gridNorthing: grid[1] }, write: false, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PRODUCTION_MODE };
    const first = await buildSfMetricTile(options);
    const second = await buildSfMetricTile(options);
    assert.equal(first.glbs.length, 1, `${id} emitted an unexpected LOD count`);
    assert.equal(second.glbs.length, 1, `${id} duplicate emitted an unexpected LOD count`);
    assert.equal(Buffer.compare(first.glbs[0].bytes, second.glbs[0].bytes), 0, `${id} duplicate write:false GLB bytes differ`);
    const firstReceiptBytes = jsonBytes(first.receipt);
    const secondReceiptBytes = jsonBytes(second.receipt);
    const firstPackageBytes = jsonBytes(first.packageDescriptor);
    const secondPackageBytes = jsonBytes(second.packageDescriptor);
    assert.equal(Buffer.compare(firstReceiptBytes, secondReceiptBytes), 0, `${id} duplicate write:false receipt bytes differ`);
    assert.equal(Buffer.compare(firstPackageBytes, secondPackageBytes), 0, `${id} duplicate write:false package bytes differ`);
    const proof = assertCandidateProof(first, grid, authorization);
    // Keep only the compact edge ledger and one GLB buffer in memory.  The
    // full per-native-pixel records remain bound by sampleLedgerSha256.
    const edges = Object.fromEntries(['south', 'north', 'west', 'east'].map((side) => [side, candidateEdge(proof, first.glbs[0].bytes, side, grid)]));
    const summary = {
      id,
      gridIndex: grid,
      boundsEpsg26910Metres: [grid[0] * TILE_SIZE, grid[1] * TILE_SIZE, (grid[0] + 1) * TILE_SIZE, (grid[1] + 1) * TILE_SIZE],
      mode: proof.mode,
      status: proof.status,
      verticalCertification: proof.verticalCertification,
      productionWriteEnabled: false,
      glbSha256: hash(first.glbs[0].bytes),
      duplicateGlbSha256: hash(second.glbs[0].bytes),
      glbBytes: first.glbs[0].bytes.length,
      receiptSha256: hash(firstReceiptBytes),
      duplicateReceiptSha256: hash(secondReceiptBytes),
      packageSha256: hash(firstPackageBytes),
      duplicatePackageSha256: hash(secondPackageBytes),
      sampleLedgerSha256: proof.sampleLedgerSha256,
      sharedEdgeLedgerSha256: proof.sharedEdgeLedgerSha256,
      sourceLocks: proof.sourceLocks,
      counts: compactCounts(proof.counts),
      edges,
    };
    // The full proof records are intentionally released after their hashes,
    // counts, and 385-sample edge ledgers are captured.  This keeps the
    // 25-tile audit bounded while the canonical receipt still binds every
    // source sample through sampleLedgerSha256.
    candidateMap.set(id, { grid, summary });
    process.stdout.write(`${JSON.stringify({ progress: 'candidate', tile: id, glbSha256: summary.glbSha256, samples: summary.counts.uniqueNativeSampleCoordinates })}\n`);
  }

  const residentIds = new Set();
  for (const grid of TILE_KEYS) for (const direction of ['west', 'east', 'south', 'north']) {
    const neighbourGrid = neighbour(grid, direction);
    const neighbourId = TILE_ID(neighbourGrid);
    if (candidateMap.has(neighbourId)) continue;
    const neighbourDir = path.join(PRODUCTION_ROOT, neighbourId);
    const glbPath = path.join(neighbourDir, `${neighbourId}.lod0.glb`);
    const receiptPath = path.join(neighbourDir, `${neighbourId}.receipt.json`);
    const packagePath = path.join(neighbourDir, `${neighbourId}.package.json`);
    if (!(await pathExists(glbPath)) || !(await pathExists(receiptPath)) || !(await pathExists(packagePath))) continue;
    residentIds.add(neighbourId);
  }
  for (const id of [...residentIds].sort()) {
    const resident = await readResident(id, authorizationByElevation);
    residentCache.set(id, resident);
    residentHashesBefore.set(id, { glbSha256: resident.glbSha256, receiptSha256: resident.receiptSha256, packageSha256: resident.packageSha256 });
  }
  assert.deepEqual([...residentIds].sort(), [...EXPECTED_RESIDENT_IDS].sort(), 'Resident ID inventory drifted from the source-locked 21-tile audit set');

  const seams = [];
  const expectedResidentSeamCount = TILE_KEYS.reduce((count, grid) => count + ['west', 'east', 'south', 'north'].filter((direction) => {
    const neighbourId = TILE_ID(neighbour(grid, direction));
    return !candidateMap.has(neighbourId) && residentCache.has(neighbourId);
  }).length, 0);
  const candidateEdgeAccessor = (candidate, side) => () => candidate.summary.edges[side];
  const residentEdgeAccessor = (resident, side) => () => residentEdge(resident, side);
  for (const grid of TILE_KEYS) {
    const id = TILE_ID(grid);
    const candidate = candidateMap.get(id);
    for (const direction of ['east', 'north', 'west', 'south']) {
      const neighbourGrid = neighbour(grid, direction);
      const neighbourId = TILE_ID(neighbourGrid);
      const neighbourCandidate = candidateMap.get(neighbourId);
      const neighbourResident = residentCache.get(neighbourId);
      if (!neighbourCandidate && !neighbourResident) continue;
      if (neighbourCandidate && (direction === 'west' || direction === 'south')) continue;
      const kind = neighbourCandidate ? 'candidate-candidate' : 'candidate-existing-resident';
      const result = compareSeam(candidateEdgeAccessor(candidate, direction), direction, neighbourCandidate ? candidateEdgeAccessor(neighbourCandidate, OPPOSITE[direction]) : residentEdgeAccessor(neighbourResident, OPPOSITE[direction]), OPPOSITE[direction], `${id}/${neighbourId} ${direction}`, kind);
      seams.push({ leftTileId: id, leftSide: direction, rightTileId: neighbourId, rightSide: OPPOSITE[direction], ...result, rightArtifactSha256: neighbourCandidate?.summary.glbSha256 ?? neighbourResident.glbSha256 });
    }
  }
  assert.equal(seams.filter(({ kind }) => kind === 'candidate-candidate').length, 24, 'Candidate/candidate seam count drifted');
  assert.equal(seams.filter(({ kind }) => kind === 'candidate-existing-resident').length, expectedResidentSeamCount, 'Candidate/resident seam count drifted');
  assert.equal(seams.length, 24 + expectedResidentSeamCount, 'All-25 seam count drifted');
  assert.equal(seams.reduce((sum, seam) => sum + seam.samples, 0), seams.length * (TILE_SIZE + 1), 'Seam sample accounting drifted');
  assert.deepEqual(seams.filter(({ kind }) => kind === 'candidate-candidate').map(seamKey).sort(), [...EXPECTED_CANDIDATE_CANDIDATE_SEAM_KEYS].sort(), 'Candidate/candidate seam key inventory drifted');
  assert.deepEqual(seams.filter(({ kind }) => kind === 'candidate-existing-resident').map(seamKey).sort(), [...EXPECTED_CANDIDATE_RESIDENT_SEAM_KEYS].sort(), 'Candidate/resident seam key inventory drifted');
  const crossSourceSeamSamples = seams.reduce((sum, seam) => sum + seam.crossSourceSamples, 0);
  assert.equal(crossSourceSeamSamples, 0, 'This milestone must explicitly record zero exercised cross-source seam samples');

  const residentByteIdentity = {};
  for (const id of [...residentIds].sort()) {
    const resident = residentCache.get(id);
    const after = await readResident(id, authorizationByElevation);
    const before = residentHashesBefore.get(id);
    assert.deepEqual({ glbSha256: after.glbSha256, receiptSha256: after.receiptSha256, packageSha256: after.packageSha256 }, before, `${id} resident bytes changed during write:false parity`);
    residentByteIdentity[id] = before;
  }
  const productionManifestAfter = await readFile(PRODUCTION_MANIFEST_PATH);
  assert.equal(Buffer.compare(productionManifestBytes, productionManifestAfter), 0, 'Production tile manifest changed during write:false parity');

  for (const dir of candidateDirs) assert.equal(await pathExists(dir), false, `${path.basename(dir)} candidate directory was written by write:false parity`);
  const tiles = [...candidateMap.values()].map(({ summary }) => ({ ...summary, edges: undefined })).map((summary) => { delete summary.edges; return summary; }).sort((a, b) => a.id.localeCompare(b.id));
  const sourceLocks = auth.sources.map((source) => ({
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
  const receipt = {
    schemaVersion: 1,
    kind: 'sf-native-pixel-fallback-production-parity-receipt',
    id: 'sf-native-pixel-fallback-production-parity-v1',
    status: 'byte-locked-all-25-source-aware-seam-parity',
    verticalCertification: 'source-declared-navd88-unrealized',
    coordinateReference: { horizontal: { crs: 'EPSG:26910', unit: 'metre' }, vertical: { datum: 'source-declared-navd88-unrealized', unit: 'metre' }, runtimeFrame: 'provisional-utm-source-declared-navd88-unrealized' },
    scale: { runtimeUnitsPerMetre: 1, horizontalScale: 1, verticalScale: 1, verticalExaggeration: 0 },
    productionWriteEnabled: false,
    promotionGate: { status: 'passed-all-25-source-aware-seam-parity', requiredTileCount: TILE_KEYS.length, evidenceReceiptSha256: null },
    policy: { mode: PRODUCTION_MODE, name: auth.policy.name, sha256: auth.policy.sha256, definition: auth.policy.definition },
    disagreementPolicy: DISAGREEMENT_POLICY,
    crossSourceSeamAudit: { samples: crossSourceSeamSamples, productionReadiness: 'unproven-no-cross-source-seam-exercised' },
    promotionPrerequisites: PROMOTION_PREREQUISITES,
    authorization: { id: auth.id, path: relative(AUTH_PATH), sha256: authSha256, status: auth.status, productionWriteEnabled: auth.productionWriteEnabled },
    coveragePlan: { path: relative(PLAN_PATH), sha256: planSha256, fallbackTileCount: TILE_KEYS.length, tileIds: expectedIds },
    sourceLocks,
    counts: {
      candidateTileCount: TILE_KEYS.length,
      duplicateBuildCount: TILE_KEYS.length,
      candidateArtifactCount: TILE_KEYS.length,
      candidateCandidateSeamCount: seams.filter(({ kind }) => kind === 'candidate-candidate').length,
      candidateExistingResidentSeamCount: seams.filter(({ kind }) => kind === 'candidate-existing-resident').length,
      seamCount: seams.length,
      seamSampleCount: seams.reduce((sum, seam) => sum + seam.samples, 0),
      exactFloat32SeamCount: seams.filter(({ exactFloat32Bits }) => exactFloat32Bits).length,
      crossSourceSeamSamples,
    },
    auditInventory: {
      residentIds: [...EXPECTED_RESIDENT_IDS],
      candidateCandidateSeamKeys: [...EXPECTED_CANDIDATE_CANDIDATE_SEAM_KEYS],
      candidateExistingResidentSeamKeys: [...EXPECTED_CANDIDATE_RESIDENT_SEAM_KEYS],
    },
    tiles,
    seams: seams.sort((a, b) => `${a.leftTileId}/${a.leftSide}`.localeCompare(`${b.leftTileId}/${b.leftSide}`)),
    residentByteIdentity,
    outputContract: { buildWrite: false, glbArtifactsWritten: false, productionManifestChanged: false, productionTileManifestPath: relative(PRODUCTION_MANIFEST_PATH) },
  };
  // The lock binds the final canonical receipt bytes.  Keeping the receipt's
  // optional evidence field null avoids an impossible self-hash cycle.
  const finalReceiptBytes = jsonBytes(receipt);
  const finalReceiptSha256 = hash(finalReceiptBytes);
  const lock = {
    schemaVersion: 1,
    kind: 'sf-native-pixel-fallback-production-parity-lock',
    id: 'sf-native-pixel-fallback-production-parity-v1',
    status: 'byte-locked-all-25-source-aware-seam-parity',
    verticalCertification: receipt.verticalCertification,
    productionWriteEnabled: false,
    promotionGate: { status: receipt.promotionGate.status, requiredTileCount: TILE_KEYS.length, evidenceReceiptPath: relative(RECEIPT_PATH), evidenceReceiptSha256: finalReceiptSha256 },
    policy: receipt.policy,
    disagreementPolicy: DISAGREEMENT_POLICY,
    crossSourceSeamAudit: receipt.crossSourceSeamAudit,
    promotionPrerequisites: PROMOTION_PREREQUISITES,
    authorization: receipt.authorization,
    coveragePlan: receipt.coveragePlan,
    sourceLocks: sourceLocks.map(({ role, cellKey, sourceLockId, sourceLockSha256, elevationAuthorizationId, elevationAuthorizationSha256, rasterSha256 }) => ({ role, cellKey, sourceLockId, sourceLockSha256, elevationAuthorizationId, elevationAuthorizationSha256, rasterSha256 })),
    audited: {
      tileIds: expectedIds,
      residentIds: [...EXPECTED_RESIDENT_IDS],
      candidateCandidateSeamKeys: [...EXPECTED_CANDIDATE_CANDIDATE_SEAM_KEYS],
      candidateExistingResidentSeamKeys: [...EXPECTED_CANDIDATE_RESIDENT_SEAM_KEYS],
      seamCount: seams.length,
      seamSampleCount: receipt.counts.seamSampleCount,
      exactFloat32SeamCount: receipt.counts.exactFloat32SeamCount,
      crossSourceSeamSamples,
    },
    writeGate: { productionWriteEnabled: false, reason: 'Standard production mosaic verifiers still require canonical per-pixel receipt schema promotion; this lock is validation evidence only.' },
  };
  const lockBytes = jsonBytes(lock);
  await Promise.all([writeFile(RECEIPT_PATH, finalReceiptBytes), writeFile(LOCK_PATH, lockBytes)]);
  const [writtenReceipt, writtenLock] = await Promise.all([readFile(RECEIPT_PATH), readFile(LOCK_PATH)]);
  assert.equal(Buffer.compare(writtenReceipt, finalReceiptBytes), 0, 'Written parity receipt bytes changed');
  assert.equal(Buffer.compare(writtenLock, lockBytes), 0, 'Written parity lock bytes changed');
  return {
    result: 'SF native-pixel fallback all-25 production parity passed',
    durationMs: Date.now() - startedAt,
    durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    receiptPath: relative(RECEIPT_PATH),
    receiptSha256: finalReceiptSha256,
    lockPath: relative(LOCK_PATH),
    lockSha256: hash(lockBytes),
    authorizationSha256: authSha256,
    planSha256,
    productionWriteEnabled: false,
    candidateTileCount: TILE_KEYS.length,
    candidateGlbHashes: Object.fromEntries(tiles.map((tile) => [tile.id, tile.glbSha256])),
    counts: receipt.counts,
    seamCounts: { candidateCandidate: 24, candidateExistingResident: expectedResidentSeamCount, total: seams.length, samples: receipt.counts.seamSampleCount },
    crossSourceSeamSamples,
    crossSourceProductionReadiness: 'unproven-no-cross-source-seam-exercised',
    disagreementPolicy: DISAGREEMENT_POLICY.status,
    residentByteIdentityCount: Object.keys(residentByteIdentity).length,
    candidateArtifactDirectoriesWritten: false,
    productionManifestChanged: false,
  };
}

export async function verifySfNativePixelFallbackProductionParity() {
  return buildParity();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifySfNativePixelFallbackProductionParity();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
