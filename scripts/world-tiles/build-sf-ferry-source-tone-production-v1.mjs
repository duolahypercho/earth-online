#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1,
  SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
} from '../../src/sf-map/building-presentation-contract.js';
import {
  buildSfMetricTile,
  loadSfMetricSharedInputs,
  loadSfMetricVerifiedTerrainSourceDigests,
} from './build-ferry-production-tile-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TILE = Object.freeze({ id: 'epsg26910-1441-10893', gridEasting: 1441, gridNorthing: 10893 });
const AUTHORIZATION_PATH = 'public/data/world/source-locks/sf-ferry-source-tone-production-authorization-v1.lock.json';
const OUTPUT_DIRECTORY = `public/data/world/production-artifacts/sf-metric-tiles-v1/${TILE.id}`;
const STEM = TILE.id;
const WRITE = process.argv.includes('--write');

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);

async function lockedJson(record, label) {
  const bytes = await readFile(path.join(ROOT, record.path));
  assert.equal(sha256(bytes), record.sha256, `${label} SHA-256 drifted`);
  return { bytes, value: JSON.parse(bytes) };
}
async function lockedBytes(record, label) {
  const bytes = await readFile(path.join(ROOT, record.path));
  assert.equal(sha256(bytes), record.sha256, `${label} SHA-256 drifted`);
  return { bytes };
}

const authorizationBytes = await readFile(path.join(ROOT, AUTHORIZATION_PATH));
const authorization = JSON.parse(authorizationBytes);
const authorizationSha256 = sha256(authorizationBytes);
assert.equal(authorization.kind, 'sf-building-source-tone-production-authorization');
assert.equal(authorization.id, 'sf-ferry-source-tone-production-authorization-v1');
assert.equal(authorization.status, 'production-authorized-bounded-ferry-mixed-mode');
assert.equal(authorization.productionWriteEnabled, true);
assert.equal(authorization.productionPromotionAuthorized, true);
assert.equal(authorization.tile.id, TILE.id);
assert.deepEqual(authorization.tile.gridIndex, [TILE.gridEasting, TILE.gridNorthing]);
assert.equal(authorization.presentation.contractSha256, SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1);
assert.equal(authorization.presentation.policySha256, SF_BUILDING_SOURCE_TONE_CONTRACT_V1.derivation.policySha256);
assert.equal(authorization.boundaryMask.id, 'source-tone-legacy-grid-boundary-mask-v1');
assert.deepEqual(authorization.boundaryMask.legacyNeighbourSides, ['south', 'west']);
assert.equal(authorization.boundaryMask.residencyInput, false);

const [legacyGlb, legacyReceipt, proofManifest, proofGlb, proofMetricReceipt, proofReceipt, seamLedger, qaScript] = await Promise.all([
  lockedBytes(authorization.legacyReference.glb, 'legacy GLB'),
  lockedJson(authorization.legacyReference.receipt, 'legacy receipt'),
  lockedJson(authorization.candidateProof.manifest, 'source-tone proof manifest'),
  lockedBytes(authorization.candidateProof.glb, 'source-tone proof GLB'),
  lockedJson(authorization.candidateProof.metricReceipt, 'source-tone proof metric receipt'),
  lockedJson(authorization.candidateProof.proofReceipt, 'source-tone proof receipt'),
  lockedBytes(authorization.boundaryMask.seamLedger, 'building seam ledger'),
  lockedBytes(authorization.qaEvidence.script, 'boundary QA script'),
]);
void legacyReceipt; void proofManifest; void proofMetricReceipt; void seamLedger; void qaScript;
assert.equal(proofGlb.bytes.length, authorization.candidateProof.glb.bytes);
assert.equal(proofReceipt.value.productionPromotionAuthorized, false, 'authorization must derive from a write-disabled proof');
assert.equal(proofReceipt.value.invariants.productionGeometryLedgerExact, true);
assert.equal(proofReceipt.value.ledgers.candidateGeometrySha256, authorization.presentation.geometryLedgerSha256);
assert.equal(proofReceipt.value.ledgers.sourceRecordsSha256, authorization.presentation.sourceRecordsSha256);
assert.equal(proofReceipt.value.ledgers.sourceToneAttributeSha256, authorization.presentation.sourceToneAttributeSha256);

const [sharedInputs, verifiedTerrainSourceDigests] = await Promise.all([
  loadSfMetricSharedInputs(),
  loadSfMetricVerifiedTerrainSourceDigests(),
]);
const buildOptions = { tile: TILE, write: false, sharedInputs, verifiedTerrainSourceDigests };
const [legacy, first, second] = await Promise.all([
  buildSfMetricTile(buildOptions),
  buildSfMetricTile({ ...buildOptions, buildingSourceToneProof: true }),
  buildSfMetricTile({ ...buildOptions, buildingSourceToneProof: true }),
]);
assert(legacy.glbs[0].bytes.equals(legacyGlb.bytes), 'default Ferry builder no longer matches the authorized legacy reference');
assert(first.glbs[0].bytes.equals(second.glbs[0].bytes), 'authorized source-tone GLB rebuild is not deterministic');
assert(jsonBytes(first.receipt).equals(jsonBytes(second.receipt)), 'authorized source-tone receipt rebuild is not deterministic');
assert(jsonBytes(first.packageDescriptor).equals(jsonBytes(second.packageDescriptor)), 'authorized source-tone package rebuild is not deterministic');
assert(first.glbs[0].bytes.equals(proofGlb.bytes), 'authorized source-tone rebuild no longer matches its reviewed proof bytes');

const authorizationReference = {
  id: authorization.id,
  path: AUTHORIZATION_PATH,
  sha256: authorizationSha256,
};
const boundaryMask = authorization.boundaryMask;
const authorizedPresentation = {
  ...first.receipt.presentation,
  status: 'production-authorized-bounded-ferry-mixed-mode',
  productionWriteEnabled: true,
  productionPromotionAuthorized: true,
  authorization: authorizationReference,
  boundaryMask,
  geometryLedgerSha256: authorization.presentation.geometryLedgerSha256,
};
const artifactPath = `${OUTPUT_DIRECTORY}/${STEM}.lod0.glb`;
const receiptPath = `${OUTPUT_DIRECTORY}/${STEM}.receipt.json`;
const packagePath = `${OUTPUT_DIRECTORY}/${STEM}.package.json`;
const receipt = structuredClone(first.receipt);
receipt.lods[0].path = artifactPath;
receipt.presentation = authorizedPresentation;
receipt.productionAuthorization = authorizationReference;
const packageDescriptor = structuredClone(first.packageDescriptor);
packageDescriptor.presentation = authorizedPresentation;
packageDescriptor.productionAuthorization = authorizationReference;
const glbBytes = first.glbs[0].bytes;
const receiptBytes = jsonBytes(receipt);
const packageBytes = jsonBytes(packageDescriptor);

if (WRITE) {
  const output = path.join(ROOT, OUTPUT_DIRECTORY);
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(path.join(ROOT, artifactPath), glbBytes),
    writeFile(path.join(ROOT, receiptPath), receiptBytes),
    writeFile(path.join(ROOT, packagePath), packageBytes),
  ]);
}

const manifestEntry = {
  id: TILE.id,
  gridIndex: [TILE.gridEasting, TILE.gridNorthing],
  originEpsg26910VerticalMetres: authorization.tile.originEpsg26910VerticalMetres,
  lod0: { path: artifactPath, sha256: sha256(glbBytes) },
  receipt: { path: receiptPath, sha256: sha256(receiptBytes) },
  presentation: {
    mode: 'source-tone-v1',
    productionWriteEnabled: true,
    productionPromotionAuthorized: true,
    contractSha256: SF_BUILDING_SOURCE_TONE_CONTRACT_SHA256_V1,
    contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
    authorization: authorizationReference,
    boundaryMask,
  },
};

if (!WRITE) {
  const manifestPath = 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json';
  const [landedGlb, landedReceipt, landedPackage, manifestBytes] = await Promise.all([
    readFile(path.join(ROOT, artifactPath)),
    readFile(path.join(ROOT, receiptPath)),
    readFile(path.join(ROOT, packagePath)),
    readFile(path.join(ROOT, manifestPath)),
  ]);
  assert(landedGlb.equals(glbBytes), 'landed authorized source-tone GLB differs from its deterministic rebuild');
  assert(landedReceipt.equals(receiptBytes), 'landed authorized source-tone receipt differs from its deterministic rebuild');
  assert(landedPackage.equals(packageBytes), 'landed authorized source-tone package differs from its deterministic rebuild');
  const landedEntry = JSON.parse(manifestBytes).tiles.find(({ id }) => id === TILE.id);
  assert.deepEqual(canonical(landedEntry), canonical(manifestEntry), 'production manifest Ferry entry differs from its authorized deterministic rebuild');
}

process.stdout.write(`${JSON.stringify({
  result: 'SF Ferry source-tone production artifact built',
  write: WRITE,
  authorization: authorizationReference,
  artifact: { path: artifactPath, sha256: sha256(glbBytes), bytes: glbBytes.length },
  receipt: { path: receiptPath, sha256: sha256(receiptBytes), bytes: receiptBytes.length },
  package: { path: packagePath, sha256: sha256(packageBytes), bytes: packageBytes.length },
  manifestEntry,
  legacyFallbackPreserved: true,
  productionPromotionAuthorized: true,
  landedBytesAndManifestVerified: !WRITE,
}, null, 2)}\n`);
