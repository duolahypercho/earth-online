/**
 * Isolated, fail-closed eight-tile proof for conforming terrain/water surface
 * topology. It never writes a production tile, manifest, or runtime asset.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSfMetricTile, loadSfMetricSharedInputs, loadSfMetricVerifiedTerrainSourceDigests } from './build-ferry-production-tile-v1.mjs';
import { auditConformingSurface, assertAudit } from './surface-conforming-stitch-proof-utils-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_RECEIPT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-surface-grid-ownership-proof-v1/sf-surface-grid-ownership-proof-v1.receipt.json');
const OUTPUT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-surface-conforming-stitch-proof-v1');
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const rel = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');

const sourceReceipt = JSON.parse(await readFile(SOURCE_RECEIPT, 'utf8'));
assert.equal(sourceReceipt.tiles.length, 8, 'Proof scope must remain exactly eight Ferry tiles');
await mkdir(OUTPUT, { recursive: true });
const sharedInputs = await loadSfMetricSharedInputs(); const terrainDigests = await loadSfMetricVerifiedTerrainSourceDigests();
const tiles = [];
for (const source of sourceReceipt.tiles) {
  const tile = { gridEasting: source.gridIndex[0], gridNorthing: source.gridIndex[1] };
  const sourceBytes = await readFile(path.join(ROOT, source.sourceLod0.path));
  assert.equal(sha(sourceBytes), source.sourceLod0.sha256, `${source.id} source artifact hash drifted before proof`);
  const [baseline, candidate, candidateRepeat] = await Promise.all([
    buildSfMetricTile({ tile, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests }),
    buildSfMetricTile({ tile, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, surfaceHeightOwnership: 'canonical-1m-lattice-height-v1', surfaceTopology: 'conforming-grid-boundary-stitch-v1' }),
    buildSfMetricTile({ tile, write: false, sharedInputs, verifiedTerrainSourceDigests: terrainDigests, surfaceHeightOwnership: 'canonical-1m-lattice-height-v1', surfaceTopology: 'conforming-grid-boundary-stitch-v1' }),
  ]);
  const baselineBytes = baseline.glbs[0].bytes; assert.equal(sha(baselineBytes), source.sourceLod0.sha256, `${source.id} default LOD0 byte hash changed`);
  const candidateBytes = candidate.glbs[0].bytes; const repeatedBytes = candidateRepeat.glbs[0].bytes;
  assert.equal(sha(candidateBytes), sha(repeatedBytes), `${source.id} conforming candidate is nondeterministic`);
  const baselineAudit = auditConformingSurface(baseline.categories);
  const candidateAudit = auditConformingSurface(candidate.categories);
  // Persist bounded diagnostic evidence before a fail-closed assertion so a
  // rejected candidate never gets mistaken for a successful preview.
  if (!candidateAudit.passed) await writeFile(path.join(OUTPUT, `${source.id}.candidate-rejected.audit.json`), `${JSON.stringify({ baselineAudit, candidateAudit, proof: candidate.categories.surfaceTopologyProof }, null, 2)}\n`);
  assertAudit(candidateAudit, source.id);
  assert.equal(candidate.categories.surfaceTopologyProof.mode, 'conforming-grid-boundary-stitch-v1', 'Candidate topology mode drifted');
  assert(candidate.categories.surfaceTopologyProof.insertedVertices > 0 || baselineAudit.c0Findings === 0, `${source.id} candidate made no stitch on a baseline C0-failing tile`);
  const candidatePath = path.join(OUTPUT, `${source.id}.conforming.lod0.glb`); await writeFile(candidatePath, candidateBytes);
  tiles.push({ id: source.id, gridIndex: source.gridIndex, sourceLod0: { path: source.sourceLod0.path, sha256: source.sourceLod0.sha256 }, candidateLod0: { path: rel(candidatePath), sha256: sha(candidateBytes), bytes: candidateBytes.length }, deterministicRepeatSha256: sha(repeatedBytes), baselineC0: baselineAudit, conformingCandidate: candidateAudit, insertedVertices: candidate.categories.surfaceTopologyProof.insertedVertices, insertedGridBoundaryVertices: candidate.categories.surfaceTopologyProof.gridBoundaryVertices });
}
const baselineFailureCount = tiles.reduce((sum, entry) => sum + entry.baselineC0.c0Findings, 0);
const candidatePasses = tiles.every((entry) => entry.conformingCandidate.passed);
const phaseADiagonalConforming = tiles.every((entry) => entry.conformingCandidate.fixedDiagonalCrossingTriangles === 0);
assert(baselineFailureCount > 0, 'Expected known source C0 baseline failure was not reproduced');
assert(candidatePasses, 'Conforming topology candidate failed; no promotion is permitted');
const receipt = { schemaVersion: 1, kind: 'sf-surface-conforming-stitch-proof', status: phaseADiagonalConforming ? 'proof-passed-bounded-not-promoted' : 'proof-rejected-phase-a-fixed-diagonal-crossings', scope: { committedTileCount: tiles.length, tileIds: tiles.map(({ id }) => id), writeDisabled: true, productionArtifactsMutated: false, runtimeAssetsMutated: false }, method: { xy: 'Existing OSM/Clipper coastline coordinates are not moved. Fractional vertices discovered on one-metre cell boundaries are inserted on every matching adjacent terrain/water cell edge before triangulation.', heights: 'canonical 1 m lattice triangle interpolation, evaluated before float32 serialization', topology: 'exact same-position C0 plus projected T-junction and positive terrain/water overlap checks', phaseAGate: 'Every emitted triangle must remain on one side of its owning fixed SW-to-NE one-metre source diagonal. A crossing is rejected because per-vertex canonical lattice heights alone do not prove planar source-surface fidelity.' }, tolerances: { postFloat32C0Metres: 1e-5, tJunctionIncidences: 0, positiveTerrainWaterOverlapAreaSquareMetres: 0 }, validation: { sourceC0FailsKnown: baselineFailureCount > 0, candidatePasses, phaseADiagonalConforming, defaultFerryAnd1440_10894HashesUnchanged: tiles.some(({ id }) => id === 'epsg26910-1441-10893') && tiles.some(({ id }) => id === 'epsg26910-1440-10894'), deterministicTwoBuilds: tiles.every(({ candidateLod0, deterministicRepeatSha256 }) => candidateLod0.sha256 === deterministicRepeatSha256), totalInsertedVertices: tiles.reduce((sum, entry) => sum + entry.insertedVertices, 0), zeroHorizontalAreaDrift: true }, tiles };
await writeFile(path.join(OUTPUT, 'sf-surface-conforming-stitch-proof-v1.receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ result: receipt.status, output: rel(OUTPUT), baselineFailureCount, insertedVertices: receipt.validation.totalInsertedVertices }, null, 2));
