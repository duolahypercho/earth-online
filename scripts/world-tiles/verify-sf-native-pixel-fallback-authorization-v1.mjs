/**
 * Source-aware, fail-closed authorization proof for native-pixel fallback.
 *
 * This verifier deliberately builds only in memory.  It validates the
 * byte-locked authorization, proves builder/provenance parity on the Ferry
 * expansion seam, and confirms that the disabled production write gate cannot
 * create an output directory.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildSfMetricTile,
  loadSfMetricSharedInputs,
  loadSfMetricVerifiedTerrainSourceDigests,
  loadSfNativePixelFallbackAuthorization,
} from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROOF_MODE = 'per-native-pixel-fallback-proof-v1';
const PRODUCTION_MODE = 'per-native-pixel-fallback-production-v1';
const TILE = (gridEasting, gridNorthing) => ({ gridEasting, gridNorthing });
const CANDIDATE_TILE = TILE(1420, 10867);
const EAST_TILE = TILE(1421, 10867);
const NORTH_TILE = TILE(1420, 10868);
const NORTH_ARTIFACT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/epsg26910-1420-10868/epsg26910-1420-10868.lod0.glb');
const WRITE_PROBE_DIR = '/tmp/sf-native-pixel-fallback-production-write-must-not-exist-i35';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function floatBits(value) {
  const bytes = Buffer.allocUnsafe(4); bytes.writeFloatLE(value); return bytes.readUInt32LE(0);
}

function edgeRecords(proof, side, tile) {
  const samples = proof.sharedEdgeSamples?.[side] ?? [];
  const atBoundary = (record) => side === 'north' ? record.modelNorthingMetres === tile.gridNorthing * 384 + 384
    : side === 'south' ? record.modelNorthingMetres === tile.gridNorthing * 384
      : side === 'east' ? record.modelEastingMetres === tile.gridEasting * 384 + 384
        : record.modelEastingMetres === tile.gridEasting * 384;
  return samples.filter((record) => atBoundary(record)).sort((a, b) => {
    const aAlong = side === 'north' || side === 'south' ? a.modelEastingMetres : a.modelNorthingMetres;
    const bAlong = side === 'north' || side === 'south' ? b.modelEastingMetres : b.modelNorthingMetres;
    return aAlong - bAlong;
  });
}

function assertProofSchema(result, authorization, label, expectedMode = PROOF_MODE) {
  const proof = result.terrainSelectionProof;
  assert(proof, `${label} did not expose terrain selection proof`);
  assert.equal(proof.mode, expectedMode, `${label} proof mode drifted`);
  assert.equal(proof.verticalCertification, 'source-declared-navd88-unrealized', `${label} vertical certification drifted`);
  assert.equal(proof.selectionPolicyName, authorization.authorization.policy.name, `${label} policy name drifted`);
  assert.equal(proof.selectionPolicyHash, authorization.authorization.policy.sha256, `${label} policy hash drifted`);
  const counts = proof.counts;
  assert(Number.isInteger(counts.uniqueNativeSampleCoordinates) && counts.uniqueNativeSampleCoordinates > 0, `${label} proof has no native samples`);
  assert(Number.isInteger(counts.bothFiniteSourceComparisons) && counts.bothFiniteSourceComparisons >= 0, `${label} disagreement count missing`);
  assert(Number.isFinite(counts.maxBothFiniteDisagreementMetres) && Number.isFinite(counts.p99BothFiniteDisagreementMetres), `${label} disagreement statistics missing`);
  assert(counts.p99BothFiniteDisagreementMetres <= counts.maxBothFiniteDisagreementMetres, `${label} p99 disagreement exceeds max`);
  assert.equal(proof.sampleLedgerSha256, `sha256:${sha256(Buffer.from(JSON.stringify(proof.records)))}`, `${label} sample ledger digest drifted`);
  assert.equal(proof.sharedEdgeLedgerSha256, `sha256:${sha256(Buffer.from(JSON.stringify(proof.sharedEdgeSamples)))}`, `${label} shared-edge ledger digest drifted`);
  const authorizedIds = new Set(authorization.authorization.sources.map(({ sourceLock }) => sourceLock.id));
  for (const [sourceLockId, stats] of Object.entries(counts.sourceProbeStats)) {
    assert(authorizedIds.has(sourceLockId), `${label} references an unauthorized source ${sourceLockId}`);
    assert.equal(stats.finiteCount + stats.noDataCount + stats.nonFiniteCount + stats.outsideWindowCount, counts.uniqueNativeSampleCoordinates, `${label} source accounting does not cover every native sample`);
    assert(Number.isInteger(stats.chosenCount) && stats.chosenCount >= 0, `${label} chosen count missing for ${sourceLockId}`);
  }
  const requiredSampleFields = authorization.authorization.evidence.requiredSampleFields;
  for (const record of proof.records) {
    assert(authorizedIds.has(record.sourceLockId), `${label} sample source is not authorized`);
    for (const field of requiredSampleFields) assert(Object.hasOwn(record, field), `${label} sample omitted required field ${field}`);
    assert(record.elevationSourceLockId && record.rasterSha256 && record.nativePixel, `${label} sample source evidence is incomplete`);
    assert(Number.isFinite(record.sampledSourceDeclaredNavd88UnrealizedMetres), `${label} sample height is not finite`);
    if (record.sourceRole === 'californiagaps-fallback') {
      assert.equal(record.fallbackOriginalReason, 'nodata', `${label} fallback cause drifted`);
      assert(record.fallbackFromSourceLockId && record.fallbackOriginalNativePixel, `${label} fallback source evidence is incomplete`);
    }
  }
  return proof;
}

function compareSourceAwareEdges(leftProof, leftSide, leftTile, rightProof, rightSide, rightTile, label) {
  const left = edgeRecords(leftProof, leftSide, leftTile); const right = edgeRecords(rightProof, rightSide, rightTile);
  assert.equal(left.length, 385, `${label} left edge sample count drifted`);
  assert.equal(right.length, 385, `${label} right edge sample count drifted`);
  let sameSourceSamples = 0; let crossSourceSamples = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]; const b = right[index];
    assert.equal(floatBits(a.sampledSourceDeclaredNavd88UnrealizedMetres), floatBits(b.sampledSourceDeclaredNavd88UnrealizedMetres), `${label} exact source height bits differ at ${index}`);
    const sameSource = a.sourceLockId === b.sourceLockId;
    if (sameSource) {
      sameSourceSamples += 1;
      assert.equal(a.elevationSourceLockId, b.elevationSourceLockId, `${label} same-source elevation authority differs at ${index}`);
      assert.equal(a.rasterSha256, b.rasterSha256, `${label} same-source raster authority differs at ${index}`);
    } else {
      crossSourceSamples += 1;
      assert(a.sourceLockId && b.sourceLockId, `${label} cross-source authority is incomplete at ${index}`);
    }
  }
  assert.equal(sameSourceSamples + crossSourceSamples, 385, `${label} seam source accounting does not partition samples`);
  return { samples: 385, sameSourceSamples, crossSourceSamples };
}

async function assertRejectedProductionWrite(sharedInputs, verifiedTerrainSourceDigests) {
  await assert.rejects(
    buildSfMetricTile({ tile: CANDIDATE_TILE, outputDir: WRITE_PROBE_DIR, write: true, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PRODUCTION_MODE }),
    /production write is not enabled|production authorization/i,
    'Disabled native-pixel authorization must reject production writes',
  );
  await assert.rejects(access(WRITE_PROBE_DIR), 'Disabled native-pixel production write created an output directory');
}

export async function verifySfNativePixelFallbackAuthorization() {
  const authorization = await loadSfNativePixelFallbackAuthorization();
  assert.equal(authorization.authorization.productionWriteEnabled, false, 'i35 authorization must remain write-disabled until promotion');
  assert.equal(authorization.authorization.promotionGate.status, 'pending-all-25-source-aware-seam-parity', 'i35 promotion gate must remain pending');
  assert.equal(authorization.authorization.promotionGate.evidenceReceiptSha256, null, 'Pending promotion gate must not advertise an evidence receipt');
  assert.deepEqual([...new Set(authorization.authorization.sources.map(({ cellKey }) => cellKey))].sort(), ['54,417', '55,417'], 'Authorization source cells drifted from locked raster bounds');
  const [sharedInputs, verifiedTerrainSourceDigests, committedNorth] = await Promise.all([
    loadSfMetricSharedInputs(),
    loadSfMetricVerifiedTerrainSourceDigests(),
    readFile(NORTH_ARTIFACT),
  ]);
  const candidateOptions = { tile: CANDIDATE_TILE, write: false, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PROOF_MODE };
  const [candidate, candidateRepeat] = await Promise.all([buildSfMetricTile(candidateOptions), buildSfMetricTile(candidateOptions)]);
  assert.equal(Buffer.compare(candidate.glbs[0].bytes, candidateRepeat.glbs[0].bytes), 0, 'i35 candidate proof is not byte-deterministic');
  const candidateProof = assertProofSchema(candidate, authorization, 'Candidate');
  const east = await buildSfMetricTile({ tile: EAST_TILE, write: false, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PROOF_MODE });
  const eastProof = assertProofSchema(east, authorization, 'East candidate');
  const north = await buildSfMetricTile({ tile: NORTH_TILE, write: false, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PROOF_MODE });
  const northProof = assertProofSchema(north, authorization, 'North resident');
  assert.equal(Buffer.compare(north.glbs[0].bytes, committedNorth), 0, 'Native-pixel proof changed the resident north artifact bytes');
  const northSeam = compareSourceAwareEdges(candidateProof, 'north', CANDIDATE_TILE, northProof, 'south', NORTH_TILE, 'Candidate/north source-aware seam');
  const eastSeam = compareSourceAwareEdges(candidateProof, 'east', CANDIDATE_TILE, eastProof, 'west', EAST_TILE, 'Candidate/east source-aware seam');
  const productionPreview = await buildSfMetricTile({ tile: CANDIDATE_TILE, write: false, sharedInputs, verifiedTerrainSourceDigests, terrainSelectionMode: PRODUCTION_MODE });
  assert.equal(Buffer.compare(productionPreview.glbs[0].bytes, candidate.glbs[0].bytes), 0, 'Authorized production mode preview diverged from proof mode');
  const productionProof = assertProofSchema(productionPreview, authorization, 'Production preview', PRODUCTION_MODE);
  assert.equal(productionProof.sampleLedgerSha256, candidateProof.sampleLedgerSha256, 'Production preview sample ledger diverged from proof mode');
  assert.equal(productionProof.sharedEdgeLedgerSha256, candidateProof.sharedEdgeLedgerSha256, 'Production preview edge ledger diverged from proof mode');
  assert.equal(productionPreview.receipt.deterministicInputs.terrainSelectionMode, PRODUCTION_MODE, 'Production preview omitted its terrain selection mode');
  assert.equal(productionPreview.receipt.deterministicInputs.terrainSampling, 'source-locked-original-first-per-native-pixel-with-californiagaps-nodata-fallback-v1', 'Production preview retained the cell-owned sampling claim');
  assert.equal(productionPreview.receipt.terrainSelectionEvidence.sampleLedgerSha256, productionProof.sampleLedgerSha256, 'Production receipt omitted the sample ledger digest');
  assert.equal(productionPreview.receipt.terrainSelectionEvidence.sharedEdgeLedgerSha256, productionProof.sharedEdgeLedgerSha256, 'Production receipt omitted the edge ledger digest');
  assert.deepEqual(productionPreview.packageDescriptor.terrainSelectionEvidence, productionPreview.receipt.terrainSelectionEvidence, 'Production package selection evidence diverged from receipt');
  assert.deepEqual(productionPreview.packageDescriptor.terrainOwnershipAuthorization, productionPreview.receipt.terrainOwnershipAuthorization, 'Production package authorization evidence diverged from receipt');
  assert.deepEqual(productionPreview.receipt.terrainOwnershipAuthorization.sources, authorization.authorization.sources, 'Production receipt omitted bound authorization sources');
  for (const source of productionPreview.receipt.source.geoTiffs) {
    assert.equal(Object.hasOwn(source, 'ownershipCell'), false, 'Per-pixel candidate source falsely claims exclusive cell ownership');
    assert(['54,417', '55,417'].includes(source.candidateCell), 'Per-pixel candidate source cell is not derived from its locked raster');
    assert.equal(source.ownershipMode, 'per-native-pixel-selection-candidate', 'Per-pixel candidate source ownership mode drifted');
  }
  assert.deepEqual(authorization.authorization.evidence.seamCounts, Object.keys(northSeam).filter((key) => key !== 'samples'), 'Source-aware seam counter contract drifted');
  await assertRejectedProductionWrite(sharedInputs, verifiedTerrainSourceDigests);
  const output = {
    result: 'SF native-pixel fallback authorization passed',
    authorizationId: authorization.authorization.id,
    authorizationSha256: authorization.authorizationSha256,
    authorizationStatus: authorization.authorization.status,
    productionWriteEnabled: authorization.authorization.productionWriteEnabled,
    policyName: authorization.authorization.policy.name,
    policySha256: authorization.authorization.policy.sha256,
    verticalCertification: authorization.authorization.verticalCertification,
    residentNorthArtifactSha256: `sha256:${sha256(committedNorth)}`,
    candidateProofArtifactSha256: `sha256:${sha256(candidate.glbs[0].bytes)}`,
    candidateCounts: candidateProof.counts,
    sourceAwareSeams: { north: northSeam, east: eastSeam },
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifySfNativePixelFallbackAuthorization();
