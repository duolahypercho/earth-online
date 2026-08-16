/**
 * Fail-closed, write:false proof for the CaliforniaGaps native-pixel fallback.
 *
 * This is deliberately a preview verifier.  It may build in memory, but it
 * never writes GLB/package/receipt artifacts to a production directory.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROOF_MODE = 'per-native-pixel-fallback-proof-v1';
const TILE = (gridEasting, gridNorthing) => ({ gridEasting, gridNorthing });
const NORTH_TILE = TILE(1420, 10868);
const CANDIDATE_TILE = TILE(1420, 10867);
const EAST_TILE = TILE(1421, 10867);
const NORTH_ARTIFACT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/epsg26910-1420-10868/epsg26910-1420-10868.lod0.glb');
const REJECTED_RECEIPT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-native-pixel-fallback-proof-v1/rejected-receipt.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB declared length mismatch');
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binOffset = 20 + jsonLength; assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing');
  const binLength = bytes.readUInt32LE(binOffset); assert.equal(binOffset + 8 + binLength, bytes.length, 'GLB BIN length mismatch');
  return { gltf, bin: bytes.subarray(binOffset + 8) };
}

function readPositions(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex]; assert(accessor?.type === 'VEC3' && accessor.componentType === 5126, 'GLB positions must be float32 VEC3');
  const view = gltf.bufferViews[accessor.bufferView]; assert(view, 'GLB position buffer view missing');
  const stride = view.byteStride ?? 12; const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const points = [];
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = base + index * stride; const x = bin.readFloatLE(offset); const y = bin.readFloatLE(offset + 4); const z = bin.readFloatLE(offset + 8);
    assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'GLB emitted a non-finite position');
    points.push({ x, y, z });
  }
  return points;
}

function floatBits(value) { const bytes = Buffer.allocUnsafe(4); bytes.writeFloatLE(value); return bytes.readUInt32LE(0); }

function terrainEdge(bytes, side, size = 384) {
  const { gltf, bin } = parseGlb(bytes); const edge = new Map();
  assert.equal(gltf.extras?.unitsPerMetre, 1, 'GLB must retain one runtime unit per metre');
  assert.equal(gltf.extras?.runtimeFrame, 'provisional-utm-source-declared-navd88-unrealized', 'GLB vertical frame drifted');
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    if (primitive.extras?.category !== 'terrain') continue;
    for (const point of readPositions(gltf, bin, primitive.attributes.POSITION)) {
      const onEdge = side === 'north' ? point.z === size : side === 'south' ? point.z === 0 : side === 'east' ? point.x === size : point.x === 0;
      if (!onEdge) continue;
      const along = side === 'north' || side === 'south' ? point.x : point.z;
      const key = floatBits(along);
      const existing = edge.get(key);
      const record = { along, y: point.y, alongBits: floatBits(along), yBits: floatBits(point.y) };
      if (existing) assert.equal(existing.yBits, record.yBits, `Terrain edge height duplicated with different float bits at ${along}`);
      else edge.set(key, record);
    }
  }
  const records = [...edge.values()].sort((a, b) => a.along - b.along);
  assert.equal(records.length, size + 1, `${side} terrain edge must expose exactly ${size + 1} native samples`);
  for (let index = 0; index < records.length; index += 1) assert.equal(records[index].along, index, `${side} terrain edge sample ${index} is not one metre apart`);
  return records;
}

function assertExactSharedEdge(leftBytes, leftSide, rightBytes, rightSide, label) {
  const left = terrainEdge(leftBytes, leftSide); const right = terrainEdge(rightBytes, rightSide); assert.equal(left.length, right.length, `${label} edge sample counts differ`);
  for (let index = 0; index < left.length; index += 1) {
    assert.equal(left[index].alongBits, right[index].alongBits, `${label} horizontal edge coordinate bits differ at ${index}`);
    assert.equal(left[index].yBits, right[index].yBits, `${label} height bits differ at ${index}`);
  }
  return { samples: left.length, first: left[0], last: left.at(-1) };
}

function assertProofAccounting(result, label) {
  const proof = result.terrainSelectionProof; assert(proof, `${label} did not expose native-pixel proof accounting`);
  assert.equal(proof.mode, PROOF_MODE, `${label} proof mode drifted`);
  assert.equal(proof.status, 'provisional-vertical-unrealized', `${label} vertical status must remain provisional`);
  assert.equal(proof.verticalCertification, 'source-declared-navd88-unrealized', `${label} vertical certification drifted`);
  assert.equal(proof.selectionPolicyName, 'source-locked-original-first-per-native-pixel-v1', `${label} selection policy drifted`);
  assert.match(proof.selectionPolicyHash, /^sha256:[0-9a-f]{64}$/, `${label} selection policy hash missing`);
  assert.equal(proof.selectionPolicy.interpolation, 'none', `${label} proof must reject interpolation`);
  assert(proof.counts.uniqueNativeSampleCoordinates > 0, `${label} has no audited samples`);
  assert.equal(proof.counts.sourceProbeStats[Object.keys(proof.counts.sourceProbeStats).find((id) => id.includes('sanfrancisco'))]?.nonFiniteCount ?? 0, 0, `${label} original source has non-finite probes`);
  for (const record of proof.records) {
    assert(record.sourceLockId && record.elevationSourceLockId, `${label} sample is missing source-lock binding`);
    assert(Number.isInteger(record.nativePixel.column) && Number.isInteger(record.nativePixel.row), `${label} sample is missing native pixel binding`);
    assert(Number.isFinite(record.sampledSourceDeclaredNavd88UnrealizedMetres), `${label} sample value is non-finite`);
    if (record.sourceRole === 'californiagaps-fallback') {
      assert.equal(record.fallbackOriginalReason, 'nodata', `${label} CaliforniaGaps sample was not caused by original NoData`);
      assert(record.fallbackFromSourceLockId, `${label} fallback sample is missing original source binding`);
    }
  }
  for (const stats of Object.values(proof.counts.sourceProbeStats)) {
    assert.equal(stats.nonFiniteCount, 0, `${label} source ${stats.sourceLockId} has non-finite probes`);
    assert.equal(stats.outsideWindowCount, 0, `${label} source ${stats.sourceLockId} lost source coverage`);
    assert.equal(stats.finiteCount + stats.noDataCount, proof.counts.uniqueNativeSampleCoordinates, `${label} source ${stats.sourceLockId} accounting does not cover every sample`);
  }
  return proof;
}

async function runProof() {
  const [sharedInputs, verifiedTerrainSourceDigests, committedNorth] = await Promise.all([
    loadSfMetricSharedInputs(),
    loadSfMetricVerifiedTerrainSourceDigests(),
    readFile(NORTH_ARTIFACT),
  ]);
  const defaultNorth = await buildSfMetricTile({ tile: NORTH_TILE, write: false, sharedInputs, verifiedTerrainSourceDigests });
  assert.equal(defaultNorth.glbs[0].bytes.length, committedNorth.length, 'Existing default north artifact byte length changed');
  assert.equal(Buffer.compare(defaultNorth.glbs[0].bytes, committedNorth), 0, 'Existing default north artifact bytes changed');
  assert.equal(sha256(defaultNorth.glbs[0].bytes), sha256(committedNorth), 'Existing default north artifact hash changed');

  const candidateOptions = { tile: CANDIDATE_TILE, write: false, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PROOF_MODE };
  const [candidate, candidateRepeat] = await Promise.all([buildSfMetricTile(candidateOptions), buildSfMetricTile(candidateOptions)]);
  assert.equal(Buffer.compare(candidate.glbs[0].bytes, candidateRepeat.glbs[0].bytes), 0, 'Candidate proof builds are not byte-deterministic');
  assert.equal(sha256(candidate.glbs[0].bytes), sha256(candidateRepeat.glbs[0].bytes), 'Candidate proof hash changed between builds');
  const candidateProof = assertProofAccounting(candidate, 'Candidate');
  const east = await buildSfMetricTile({ tile: EAST_TILE, write: false, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PROOF_MODE });
  const eastProof = assertProofAccounting(east, 'East candidate');
  const northEdge = assertExactSharedEdge(candidate.glbs[0].bytes, 'north', committedNorth, 'south', 'Candidate north/committed south');
  const horizontalEdge = assertExactSharedEdge(candidate.glbs[0].bytes, 'east', east.glbs[0].bytes, 'west', 'Candidate east/east-candidate west');
  assert.equal(northEdge.samples, 385, 'North seam must compare 385 samples'); assert.equal(horizontalEdge.samples, 385, 'Horizontal seam must compare 385 samples');
  const sharedEdge = {
    north: { sourceLockIds: [...new Set(candidateProof.sharedEdgeSamples.north.map(({ sourceLockId }) => sourceLockId))], samples: candidateProof.sharedEdgeSamples.north.length, first: candidateProof.sharedEdgeSamples.north[0], last: candidateProof.sharedEdgeSamples.north.at(-1) },
    east: { sourceLockIds: [...new Set(eastProof.sharedEdgeSamples.west.map(({ sourceLockId }) => sourceLockId))], samples: eastProof.sharedEdgeSamples.west.length, first: eastProof.sharedEdgeSamples.west[0], last: eastProof.sharedEdgeSamples.west.at(-1) },
  };
  assert.equal(sharedEdge.north.samples, 385, 'Proof north edge source accounting must expose 385 samples');
  assert.equal(sharedEdge.east.samples, 385, 'Proof horizontal edge source accounting must expose 385 samples');
  return {
    result: 'SF native-pixel fallback proof passed',
    mode: PROOF_MODE,
    status: candidateProof.status,
    verticalCertification: candidateProof.verticalCertification,
    selectionPolicyName: candidateProof.selectionPolicyName,
    selectionPolicyHash: candidateProof.selectionPolicyHash,
    defaultNorthArtifactSha256: `sha256:${sha256(committedNorth)}`,
    candidateArtifactSha256: `sha256:${sha256(candidate.glbs[0].bytes)}`,
    candidateCounts: candidateProof.counts,
    sharedEdge,
  };
}

export async function verifySfNativePixelFallbackProof() {
  try {
    const receipt = await runProof();
    console.log(JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    const rejected = { result: 'SF native-pixel fallback proof rejected', mode: PROOF_MODE, status: 'rejected', error: String(error?.stack ?? error) };
    await mkdir(path.dirname(REJECTED_RECEIPT), { recursive: true });
    await writeFile(REJECTED_RECEIPT, `${JSON.stringify(rejected, null, 2)}\n`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifySfNativePixelFallbackProof();
}
