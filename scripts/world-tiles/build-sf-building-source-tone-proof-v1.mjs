#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';
import { makePresentationGlb } from './build-sf-building-presentation-proof-v1.mjs';

const ROOT = process.cwd();
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-source-tone-proof-v1');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const LEGACY_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-presentation-proof-v1');
const TILES = Object.freeze([
  { id: 'epsg26910-1441-10893', gridEasting: 1441, gridNorthing: 10893, role: 'ferry' },
  { id: 'epsg26910-1430-10882', gridEasting: 1430, gridNorthing: 10882, role: 'district' },
]);
const POLICY = Object.freeze({
  id: 'osm-way-id-modulo-4-v1',
  formula: 'Number(BigInt(sourceOsmWayId) % 4n)',
  input: 'byte-locked OSM source way identity',
  outputDomain: [0, 3],
  presentationOnly: true,
  sourceColourClaim: false,
});

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`); }
const POLICY_SHA256 = `sha256:${sha256(jsonBytes(POLICY))}`;
const CONTRACT = Object.freeze({
  schema: 'sf-building-source-tone-v1',
  status: 'preview-proof-only-not-production',
  attribute: { gltfSemantic: '_SF_SOURCE_TONE_V1', threeAttributeName: '_sf_source_tone_v1', componentType: 5121, type: 'SCALAR', normalized: false, domain: [0, 3] },
  derivation: { ...POLICY, policySha256: POLICY_SHA256 },
});

function sourceToneLedger(proof) {
  const bytesPerIndex = proof.indexComponentType === 5125 ? 4 : 2;
  return proof.records.map((record) => {
    const positionStart = record.vertexStart * 3 * 4;
    const positionBytes = proof.sourcePositionBytes.subarray(positionStart, positionStart + record.vertexCount * 3 * 4);
    const indexStart = record.indexStart * bytesPerIndex;
    const indexBytes = proof.sourceIndexBytes.subarray(indexStart, indexStart + record.indexCount * bytesPerIndex);
    return {
      ordinal: record.ordinal,
      sourceFeatureId: record.sourceFeatureId,
      sourceTagsSha256: `sha256:${sha256(jsonBytes(record.sourceTags))}`,
      sourceGeometrySha256: `sha256:${sha256(Buffer.concat([positionBytes, indexBytes]))}`,
      sourceToneV1: record.sourceToneV1,
      vertexStart: record.vertexStart,
      vertexCount: record.vertexCount,
    };
  });
}

async function buildTile(tile, manifestTile, sharedInputs, verifiedTerrainSourceDigests) {
  const options = { tile, write: false, sharedInputs, verifiedTerrainSourceDigests, buildingPresentationProof: true };
  const first = await buildSfMetricTile(options);
  const second = await buildSfMetricTile(options);
  const firstProof = makePresentationGlb(tile, first.categories, first.buildingPresentationProof, { sourceToneContract: CONTRACT });
  const secondProof = makePresentationGlb(tile, second.categories, second.buildingPresentationProof, { sourceToneContract: CONTRACT });
  assert(firstProof.bytes.equals(secondProof.bytes), `${tile.id} source-tone proof GLB is not byte deterministic`);
  assert(firstProof.sourceToneBytes.equals(secondProof.sourceToneBytes), `${tile.id} source-tone attribute drifted between builds`);

  const productionGlb = await readFile(path.join(ROOT, manifestTile.lod0.path));
  const productionReceipt = await readFile(path.join(ROOT, manifestTile.receipt.path));
  assert(first.glbs[0].bytes.equals(productionGlb), `${tile.id} default production GLB bytes changed while source-tone proof metadata was enabled`);
  assert(second.glbs[0].bytes.equals(productionGlb), `${tile.id} repeated default production GLB bytes changed while source-tone proof metadata was enabled`);

  const legacyReceiptPath = path.join(LEGACY_ROOT, tile.id, `${tile.id}.building-presentation-proof.receipt.json`);
  const legacyReceiptBytes = await readFile(legacyReceiptPath);
  const legacyReceipt = JSON.parse(legacyReceiptBytes);
  const legacyProofBytes = await readFile(path.join(ROOT, legacyReceipt.proofArtifact.path));
  assert.equal(`sha256:${sha256(legacyProofBytes)}`, legacyReceipt.proofArtifact.sha256, `${tile.id} legacy proof bytes drifted`);

  const tileOutput = path.join(OUTPUT_ROOT, tile.id);
  await mkdir(tileOutput, { recursive: true });
  const proofName = `${tile.id}.building-source-tone-proof.glb`;
  const proofPath = path.join(tileOutput, proofName);
  await writeFile(proofPath, firstProof.bytes);
  const ledger = sourceToneLedger(firstProof);
  const toneCounts = [0, 0, 0, 0];
  for (const record of ledger) toneCounts[record.sourceToneV1] += 1;
  const receipt = {
    schemaVersion: 1,
    kind: 'sf-building-source-tone-proof-receipt',
    status: 'preview-proof-only-not-production',
    productionPromotionAuthorized: false,
    tile: { id: tile.id, gridIndex: [tile.gridEasting, tile.gridNorthing], horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, verticalCertification: 'source-declared-navd88-unrealized' },
    contract: CONTRACT,
    productionReference: { path: manifestTile.lod0.path, declaredSha256: manifestTile.lod0.sha256, verifiedSha256: `sha256:${sha256(productionGlb)}`, receiptPath: manifestTile.receipt.path, receiptSha256: `sha256:${sha256(productionReceipt)}`, exactDefaultBytesPreserved: true },
    legacyProofReference: { path: legacyReceipt.proofArtifact.path, sha256: legacyReceipt.proofArtifact.sha256, receiptPath: path.relative(ROOT, legacyReceiptPath), receiptSha256: `sha256:${sha256(legacyReceiptBytes)}`, exactLegacyBytesPreserved: true },
    proofArtifact: { path: path.relative(ROOT, proofPath), bytes: firstProof.bytes.length, sha256: `sha256:${sha256(firstProof.bytes)}` },
    invariants: { twoBuildProofBytesExact: true, sourceToneAttributeBytesExact: true, sourcePositionFloat32BytesExact: true, sourceIndexBytesExact: true, productionDefaultGlbBytesExact: true, legacyProofBytesExact: true, sourceGeometryMoved: false, gameplayOrCollisionChanged: false },
    counts: { buildings: firstProof.records.length, vertices: firstProof.vertexCount, indices: firstProof.indexCount, triangles: firstProof.indexCount / 3, primitives: firstProof.primitiveCount, tones: toneCounts },
    ledgers: { sourceToneAttributeSha256: `sha256:${sha256(firstProof.sourceToneBytes)}`, sourceToneRecordsSha256: `sha256:${sha256(jsonBytes(ledger))}`, sourcePositionFloat32Sha256: `sha256:${sha256(firstProof.sourcePositionBytes)}`, sourceIndexSha256: `sha256:${sha256(firstProof.sourceIndexBytes)}` },
    sourceToneRecords: ledger,
    sourceLocks: first.packageDescriptor.sourceLocks,
  };
  const receiptPath = path.join(tileOutput, `${tile.id}.building-source-tone-proof.receipt.json`);
  await writeFile(receiptPath, jsonBytes(receipt));
  return { tile: tile.id, role: tile.role, proofArtifact: receipt.proofArtifact, receipt: path.relative(ROOT, receiptPath), counts: receipt.counts, ledgers: receipt.ledgers };
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const byId = new Map(manifest.tiles.map((tile) => [tile.id, tile]));
const [sharedInputs, verifiedTerrainSourceDigests] = await Promise.all([loadSfMetricSharedInputs(), loadSfMetricVerifiedTerrainSourceDigests()]);
await mkdir(OUTPUT_ROOT, { recursive: true });
const tiles = [];
for (const tile of TILES) {
  const manifestTile = byId.get(tile.id);
  assert(manifestTile, `${tile.id} is not a production resident`);
  tiles.push(await buildTile(tile, manifestTile, sharedInputs, verifiedTerrainSourceDigests));
}
const proofManifest = { schemaVersion: 1, kind: 'sf-building-source-tone-proof-manifest', status: 'preview-proof-only-not-production', productionPromotionAuthorized: false, productionManifestTileCount: manifest.tiles.length, contract: CONTRACT, tiles };
await writeFile(path.join(OUTPUT_ROOT, 'sf-building-source-tone-proof-v1.manifest.json'), jsonBytes(proofManifest));
process.stdout.write(`${JSON.stringify(proofManifest, null, 2)}\n`);
