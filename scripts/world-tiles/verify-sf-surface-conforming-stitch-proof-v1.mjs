import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditConformingSurface, surfaceCategoriesFromGlb } from './surface-conforming-stitch-proof-utils-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const receiptPath = path.join(ROOT, 'public/data/world/preview-artifacts/sf-surface-conforming-stitch-proof-v1/sf-surface-conforming-stitch-proof-v1.receipt.json');
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
assert.equal(receipt.kind, 'sf-surface-conforming-stitch-proof'); assert.equal(receipt.status, 'proof-rejected-phase-a-fixed-diagonal-crossings', 'Phase A proof must remain fail-closed on fixed-diagonal crossings');
assert.equal(receipt.scope.committedTileCount, 8); assert.equal(receipt.scope.writeDisabled, true); assert.equal(receipt.validation.sourceC0FailsKnown, true); assert.equal(receipt.validation.candidatePasses, true); assert.equal(receipt.validation.phaseADiagonalConforming, false); assert.equal(receipt.validation.deterministicTwoBuilds, true); assert.equal(receipt.validation.zeroHorizontalAreaDrift, true);
let diagonalCrossings = 0; let baselineC0Findings = 0;
for (const entry of receipt.tiles) {
  assert(entry.baselineC0.c0Findings >= 0); assert(entry.conformingCandidate.worstC0Metres <= 1e-5); assert.equal(entry.conformingCandidate.tJunctionIncidences, 0); assert.equal(entry.conformingCandidate.positiveTerrainWaterOverlaps, 0); if (receipt.status !== 'proof-rejected-phase-a-fixed-diagonal-crossings') assert.equal(entry.conformingCandidate.fixedDiagonalCrossingTriangles, 0); assert.equal(entry.candidateLod0.sha256, entry.deterministicRepeatSha256);
  const [sourceBytes, candidateBytes] = await Promise.all([readFile(path.join(ROOT, entry.sourceLod0.path)), readFile(path.join(ROOT, entry.candidateLod0.path))]);
  assert.equal(sha(sourceBytes), entry.sourceLod0.sha256, `${entry.id} source artifact drifted`); assert.equal(sha(candidateBytes), entry.candidateLod0.sha256, `${entry.id} candidate artifact drifted`);
  const baselineAudit = auditConformingSurface(surfaceCategoriesFromGlb(sourceBytes, entry.id)); const candidateAudit = auditConformingSurface(surfaceCategoriesFromGlb(candidateBytes, entry.id));
  assert.deepEqual(baselineAudit, entry.baselineC0, `${entry.id} baseline audit evidence drifted`); assert.deepEqual(candidateAudit, entry.conformingCandidate, `${entry.id} candidate audit evidence drifted`);
  baselineC0Findings += baselineAudit.c0Findings; diagonalCrossings += candidateAudit.fixedDiagonalCrossingTriangles;
}
assert(baselineC0Findings > 0, 'Known source C0 failure was not reproduced'); assert(diagonalCrossings > 0, 'Rejected Phase A proof has no fixed-diagonal crossing evidence');
console.log(JSON.stringify({ result: 'rejected conforming stitch proof verified', status: receipt.status, tiles: receipt.tiles.length, insertedVertices: receipt.validation.totalInsertedVertices, diagonalCrossings }, null, 2));
