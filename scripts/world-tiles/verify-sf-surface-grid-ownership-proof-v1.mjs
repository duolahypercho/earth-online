/** Verify the bounded non-production grid-ownership proof from its committed
 * preview bytes. It intentionally does not call a builder or inspect runtime
 * state. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSurfaceContinuity, measureHorizontalMovement } from './surface-grid-ownership-proof-utils-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-surface-grid-ownership-proof-v1');
const RECEIPT_PATH = path.join(OUTPUT_DIR, 'sf-surface-grid-ownership-proof-v1.receipt.json');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const receipt = JSON.parse(await readFile(RECEIPT_PATH, 'utf8'));
assert.equal(receipt.kind, 'sf-surface-grid-ownership-proof');
assert(['proof-passed-bounded-continuity-not-promoted', 'proof-rejected-residual-topology-or-near-grid-continuity'].includes(receipt.status));
assert.equal(receipt.nonPromotion, 'preview/proof only; not a production package, runtime asset, manifest entry, streaming input, or realized vertical datum claim');
assert.equal(receipt.scope.committedTileCount, 8); assert.equal(receipt.scope.baselineFindingsExpected, 6);
assert.equal(receipt.validation.baselineFindings, 6); assert.equal(receipt.validation.repairedFindings === 0, receipt.status === 'proof-passed-bounded-continuity-not-promoted');
assert.equal(receipt.validation.maxHorizontalDisplacementMetres, 0); assert.equal(receipt.validation.productionManifestUntouched, true);
assert.equal(receipt.validation.horizontalSurfaceTopologyIdentical, true);
let baselineFindings = 0; let repairedFindings = 0; let maximumHorizontalMovement = 0;
for (const tile of receipt.tiles) {
  const sourcePath = path.join(ROOT, tile.sourceLod0.path); const previewPath = path.join(ROOT, tile.previewLod0.path);
  assert(sourcePath.startsWith(`${ROOT}${path.sep}`) && previewPath.startsWith(`${ROOT}${path.sep}`), `${tile.id} path escapes workspace`);
  const [sourceBytes, previewBytes] = await Promise.all([readFile(sourcePath), readFile(previewPath)]);
  assert.equal(sha256(sourceBytes), tile.sourceLod0.sha256, `${tile.id} source hash drifted`); assert.equal(sha256(previewBytes), tile.previewLod0.sha256, `${tile.id} preview hash drifted`);
  const sourceAudit = auditSurfaceContinuity(sourceBytes, tile.id); const previewAudit = auditSurfaceContinuity(previewBytes, tile.id);
  const movement = measureHorizontalMovement(sourceAudit.vertices, previewAudit.vertices);
  assert.equal(sourceAudit.horizontalSurfaceTopologySha256, previewAudit.horizontalSurfaceTopologySha256, `${tile.id} horizontal surface topology drifted`);
  assert.equal(sourceAudit.horizontalSurfaceTopologySha256, tile.horizontalSurfaceTopologySha256, `${tile.id} horizontal topology hash evidence drifted`);
  assert.deepEqual({ violations: sourceAudit.violations, maxVerticalDiscontinuityMetres: sourceAudit.maxVerticalDeltaMetres, findings: sourceAudit.findings }, tile.sourceContinuity, `${tile.id} source evidence drifted`);
  assert.deepEqual({ violations: previewAudit.violations, maxVerticalDiscontinuityMetres: previewAudit.maxVerticalDeltaMetres, findings: previewAudit.findings }, tile.previewContinuity, `${tile.id} preview evidence drifted`);
  assert.deepEqual(movement, tile.horizontalMovement, `${tile.id} horizontal movement evidence drifted`);
  baselineFindings += sourceAudit.violations; repairedFindings += previewAudit.violations; maximumHorizontalMovement = Math.max(maximumHorizontalMovement, movement.maxHorizontalDisplacementMetres);
}
assert.equal(baselineFindings, 6); assert.equal(repairedFindings === 0, receipt.status === 'proof-passed-bounded-continuity-not-promoted'); assert.equal(maximumHorizontalMovement, receipt.validation.maxHorizontalDisplacementMetres);
console.log(JSON.stringify({ result: 'surface grid ownership proof verified', status: receipt.status, tiles: receipt.tiles.length, baselineFindings, repairedFindings, maxHorizontalDisplacementMetres: maximumHorizontalMovement, productionManifestUntouched: true }, null, 2));
