#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSfDataSfFerryHeightSidecarV1 } from './build-sf-datasf-ferry-height-sidecar-v1.mjs';

const ROOT = process.cwd();
const RECEIPT_PATH = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-ferry-height-sidecar-v1/sf-datasf-ferry-height-sidecar-v1.receipt.json');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const [landedBytes, manifestBefore, rebuilt] = await Promise.all([
  readFile(RECEIPT_PATH),
  readFile(MANIFEST_PATH),
  buildSfDataSfFerryHeightSidecarV1({ write: false }),
]);
assert(landedBytes.equals(rebuilt.bytes), 'DataSF Ferry height sidecar is not byte deterministic');
assert.equal(rebuilt.receipt.status, 'preview-source-height-sidecar-only-not-production');
assert.equal(rebuilt.receipt.productionWriteEnabled, false);
assert.equal(rebuilt.receipt.productionPromotionAuthorized, false);
assert.equal(rebuilt.receipt.runtimeIntegrationEnabled, false);
assert.equal(rebuilt.receipt.claims.absoluteVerticalPlacement, false);
assert.equal(rebuilt.receipt.claims.verticalDatumReconciled, false);
assert.equal(rebuilt.receipt.coverage.highConfidenceMatches, 11);
assert.equal(rebuilt.receipt.coverage.topVerticesIfApplied, 111);
assert.equal(rebuilt.receipt.invariants.everyMatchMapsToCurrentSourceRecord, true);
assert.equal(rebuilt.receipt.invariants.everyRecordMatchesHeightPreview, true);
assert.equal(rebuilt.receipt.productionReference.presentation.mode, 'source-tone-v1');
assert.equal(rebuilt.receipt.tile.runtimeUnitsPerMetre, 1);
const manifestAfter = await readFile(MANIFEST_PATH);
assert(manifestAfter.equals(manifestBefore), 'Sidecar verification mutated the production manifest');
assert(!manifestAfter.toString('utf8').toLowerCase().includes('datasf'), 'DataSF preview evidence leaked into the production manifest');

process.stdout.write(`${JSON.stringify({ result: 'SF DataSF Ferry height sidecar passed', receipt: { path: path.relative(ROOT, RECEIPT_PATH), bytes: landedBytes.length, sha256: sha256(landedBytes) }, highConfidenceMatches: 11, topVerticesIfApplied: 111, productionManifestMutation: false, productionPromotionAuthorized: false }, null, 2)}\n`);
