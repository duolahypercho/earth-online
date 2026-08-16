/** Fail-closed verifier for the isolated adaptive terrain LOD proof. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { semanticPayload } from './build-sf-lod1-adaptive-proof-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROOF_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-lod1-adaptive-proof-v1');
const PROOF_PATH = path.join(PROOF_DIR, 'sf-lod1-adaptive-proof-v1.receipt.json');
const METRIC_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1');
const FERRY_ROOT = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const CONTRACT_PATH = path.join(ROOT, 'public/data/world/contracts/sf-one-to-one-map.contract.json');
const SAMPLE = Object.freeze([
  'epsg26910-1440-10892', 'epsg26910-1440-10893', 'epsg26910-1441-10893', 'epsg26910-1440-10894',
]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes) => `sha256:${sha256(bytes)}`;
const productionStem = (id) => id === 'epsg26910-1441-10893' ? 'ferry-production-tile-v1' : id;
const productionDir = (id) => id === 'epsg26910-1441-10893' ? FERRY_ROOT : path.join(METRIC_ROOT, id);

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic mismatch');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version mismatch');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length mismatch');
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'GLB JSON chunk missing');
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binOffset = 20 + jsonLength; const binLength = bytes.readUInt32LE(binOffset);
  assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, 'GLB BIN chunk missing');
  assert.equal(gltf.buffers[0].byteLength, binLength, 'GLB buffer byteLength does not include required padding');
  return gltf;
}

async function production(id) {
  const dir = productionDir(id); const stem = productionStem(id);
  const [glb, receipt, mapPackage] = await Promise.all([
    readFile(path.join(dir, `${stem}.lod0.glb`)),
    readFile(path.join(dir, `${stem}.receipt.json`)),
    readFile(path.join(dir, `${stem}.package.json`)),
  ]);
  const receiptJson = JSON.parse(receipt); const packageJson = JSON.parse(mapPackage);
  assert.equal(receiptJson.tile.identity, id, `wrong LOD0 receipt tile ${id}`);
  assert.equal(receiptJson.lods[0].artifactHash, digest(glb), `${id} receipt LOD0 hash drifted`);
  assert.equal(packageJson.lods[0].artifactHash, digest(glb), `${id} package LOD0 hash drifted`);
  for (const lock of packageJson.sourceLocks) assert.equal(sha256(await readFile(path.join(ROOT, lock.path))), lock.sha256, `${id} source lock drifted: ${lock.id}`);
  return { id, dir, stem, glb, receipt, mapPackage, packageJson };
}

const [proof, contract, manifest] = await Promise.all([
  readFile(PROOF_PATH, 'utf8').then(JSON.parse),
  readFile(CONTRACT_PATH, 'utf8').then(JSON.parse),
  readFile(MANIFEST_PATH, 'utf8').then(JSON.parse),
]);
assert.equal(proof.kind, 'sf-lod1-adaptive-terrain-proof');
assert.equal(proof.id, 'sf-lod1-adaptive-proof-v1');
assert(['proof-passed-not-promoted', 'proof-rejected-contract-error-budget', 'proof-rejected-source-surface-ambiguity', 'proof-rejected-continuous-overlay-unproven', 'proof-rejected-refinement-not-converged'].includes(proof.status), `unknown proof status ${proof.status}`);
assert.equal(proof.nonPromotion, 'preview/proof only; not a production package, runtime asset, manifest entry, or streaming input');
assert.deepEqual(proof.coordinateFrame, { horizontalCrs: 'EPSG:26910', runtimeFrame: 'provisional-utm-source-declared-navd88-unrealized', unitsPerMetre: 1, scale: [1, 1, 1], translationMetres: [0, 0, 0], verticalStatus: 'provisional-source-declared-navd88-unrealized' });
assert.equal(proof.validation.maxHorizontalDeviationMetres, 0);
assert(proof.validation.maxAdaptiveVerticalDeviationMetresExcludingSourceAmbiguities <= contract.lod.maxVerticalDeviationMetres, 'Adaptive surface itself exceeds the vertical budget');
assert.equal(proof.status, 'proof-rejected-source-surface-ambiguity', 'Inherited LOD0 terrain/water ambiguity must reject promotion explicitly');
assert(proof.validation.sampledAmbiguities > 0, 'Source-surface ambiguity rejection needs measured ambiguity evidence');
assert.equal(proof.validation.contractBudgets.maxHorizontalDeviationMetres, contract.lod.maxHorizontalDeviationMetres);
assert.equal(proof.validation.contractBudgets.maxVerticalDeviationMetres, contract.lod.maxVerticalDeviationMetres);
assert.equal(proof.validation.deterministicRebuild, true);
assert.equal(proof.validation.noTJunctions, true);
assert.equal(proof.validation.phaseStableTileBoundaryHeights, true);
assert.equal(typeof proof.validation.refinementConverged, 'boolean');
assert.equal(proof.validation.seams.length, 3);
for (const seam of proof.validation.seams) { assert.equal(seam.samples, 385); assert.equal(seam.maxVerticalDifferenceMetres, 0); }
assert.deepEqual(proof.sample.tiles, SAMPLE);
assert.equal(proof.tiles.length, SAMPLE.length);
assert.equal(proof.sourceBinding.length, SAMPLE.length);
assert.equal(proof.budgets.qualification, 'arithmetic projection from this four-tile proof sample only; not a citywide forecast or promotion claim');
assert(!JSON.stringify(manifest).includes('sf-lod1-adaptive-proof-v1'), 'adaptive proof leaked into runtime manifest');

const sources = await Promise.all(SAMPLE.map(production));
for (const [index, tile] of proof.tiles.entries()) {
  const source = sources[index]; const binding = proof.sourceBinding[index];
  assert.equal(tile.id, source.id); assert.equal(binding.id, source.id);
  const artifact = await readFile(path.join(ROOT, tile.artifact.path));
  assert.equal(digest(artifact), tile.artifact.sha256, `${tile.id} adaptive artifact hash drifted`);
  assert.equal(artifact.length, tile.artifact.bytes, `${tile.id} adaptive artifact bytes drifted`);
  const gltf = parseGlb(artifact);
  assert.equal(gltf.extras.tileId, tile.id); assert.equal(gltf.extras.lod, 1); assert.equal(gltf.extras.lodPolicy, 'adaptive-4m-2m-1m-proof-v1');
  assert.equal(gltf.extras.horizontalCrs, 'EPSG:26910'); assert.equal(gltf.extras.unitsPerMetre, 1); assert.equal(gltf.extras.runtimeFrame, 'provisional-utm-source-declared-navd88-unrealized');
  for (const category of ['coastline', 'roads', 'buildings']) assert.equal(digest(semanticPayload(artifact, category)), digest(semanticPayload(source.glb, category)), `${tile.id} ${category} semantic payload changed`);
  assert.equal(binding.lod0.sha256, digest(source.glb)); assert.equal(binding.receipt.sha256, digest(source.receipt)); assert.equal(binding.mapPackage.sha256, digest(source.mapPackage));
  assert.equal(binding.lod0.path.endsWith('.lod0.glb'), true); assert(!JSON.stringify(manifest).includes(tile.artifact.path), `${tile.id} adaptive artifact leaked into runtime manifest`);
  for (const step of ['1', '2', '4']) { assert(tile.cellsByStepMetres[step].patches > 0, `${tile.id} missing ${step}m cells`); assert(tile.cellsByStepMetres[step].triangles > 0, `${tile.id} missing ${step}m triangles`); }
  assert.equal(tile.triangles, Object.values(tile.cellsByStepMetres).reduce((sum, level) => sum + level.triangles, 0), `${tile.id} triangle totals drifted`);
  assert(tile.measuredSourceSurfaceVertices >= 385 ** 2, `${tile.id} did not evaluate all integer source samples`);
  assert(tile.maxVerticalDeviationMetres >= 0);
  assert(Number.isInteger(tile.refinementIterations) && tile.refinementIterations >= 0 && tile.refinementIterations <= 8, `${tile.id} refinement iterations drifted`);
  assert.equal(typeof tile.refinementConverged, 'boolean');
  assert(tile.refinementStopReason, `${tile.id} refinement stop reason missing`);
}

if (proof.validation.maxVerticalDeviationMetres > contract.lod.maxVerticalDeviationMetres) {
  assert.equal(proof.validation.continuousProven, false, 'sample rejection cannot claim continuous proof');
  assert(proof.validation.continuousTriangleOverlayCheck.startsWith('not-run'), 'sample rejection must not claim continuous overlay');
}
console.log(JSON.stringify({ result: 'adaptive LOD proof verified', status: proof.status, tiles: proof.tiles.length, maxVerticalDeviationMetres: proof.validation.maxVerticalDeviationMetres, continuousMaxVerticalDeviationMetres: proof.validation.continuousMaxVerticalDeviationMetres, seamSamples: proof.validation.seams.map((seam) => seam.samples), productionManifestUntouched: true }, null, 2));
