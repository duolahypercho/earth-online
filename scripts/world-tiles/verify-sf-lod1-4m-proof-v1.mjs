/** Fail-closed verifier for the explicitly non-promoted 4 m LOD1 proof. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROOF_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-lod1-4m-proof-v1');
const PROOF_PATH = path.join(PROOF_DIR, 'sf-lod1-4m-proof-v1.receipt.json');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const CONTRACT_PATH = path.join(ROOT, 'public/data/world/contracts/sf-one-to-one-map.contract.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes) => `sha256:${sha256(bytes)}`;

function parseGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'Proof artifact GLB magic mismatch'); assert.equal(bytes.readUInt32LE(4), 2, 'Proof artifact GLB version mismatch'); assert.equal(bytes.readUInt32LE(8), bytes.length, 'Proof artifact GLB length mismatch');
  const jsonLength = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'Proof artifact GLB JSON chunk missing'); return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
}

const [proof, contract, manifest] = await Promise.all([readFile(PROOF_PATH, 'utf8').then(JSON.parse), readFile(CONTRACT_PATH, 'utf8').then(JSON.parse), readFile(MANIFEST_PATH, 'utf8').then(JSON.parse)]);
assert.equal(proof.kind, 'sf-lod1-4m-terrain-proof'); assert.equal(proof.status, 'proof-rejected-contract-error-budget', '4m proof must remain rejected when it exceeds the contract');
assert.equal(proof.nonPromotion, 'preview/proof only; not a production package, runtime asset, manifest entry, or streaming input'); assert.equal(proof.terrainGridStepMetres, 4);
assert.deepEqual(proof.coordinateFrame, { horizontalCrs: 'EPSG:26910', runtimeFrame: 'provisional-utm-source-declared-navd88-unrealized', unitsPerMetre: 1, scale: [1, 1, 1], translationMetres: [0, 0, 0], verticalStatus: 'provisional-source-declared-navd88-unrealized' });
assert.equal(proof.validation.contractEligible, false); assert.equal(proof.validation.maxHorizontalDeviationMetres, 0); assert(proof.validation.maxVerticalDeviationMetres > contract.lod.maxVerticalDeviationMetres, 'Rejected proof must demonstrate the real vertical-budget exceedance');
assert.equal(proof.validation.continuousSupremumQualification, 'maximum among measured LOD0 surface vertices; a lower bound sufficient to reject this proof, not a claimed continuous triangle-overlay supremum');
assert.equal(proof.validation.seamEvidenceQualification, 'phase-locked terrain/water edge-height equality at 4m samples; edge triangle topology, ordering, coastline geometry, and full bytes are not claimed identical');
assert.equal(proof.validation.nonTerrainGeometry, 'serialized position/index payloads for coastline, roads, and buildings match source LOD0 exactly; GLB JSON, materials, primitive extras, and chunk layout are not claimed identical');
assert.deepEqual(proof.validation.contractBudgets, { maxHorizontalDeviationMetres: contract.lod.maxHorizontalDeviationMetres, maxVerticalDeviationMetres: contract.lod.maxVerticalDeviationMetres });
assert.equal(proof.validation.deterministicRebuild, true); assert.equal(proof.validation.seams.length, 3); for (const seam of proof.validation.seams) { assert.equal(seam.samples, 97); assert.equal(seam.maxVerticalDifferenceMetres, 0); }
assert.equal(proof.tiles.length, 4); assert.equal(proof.sourceBinding.length, 4);
for (const [index, tile] of proof.tiles.entries()) {
  assert.equal(tile.id, proof.sourceBinding[index].id, 'Proof/source tile ordering drifted'); assert.equal(tile.maxHorizontalDeviationMetres, 0); assert(tile.maxVerticalDeviationMetres > 0.25, `${tile.id} no longer demonstrates a meaningful 4m error`); assert(tile.measuredSourceSurfaceVertices >= 385 ** 2, `${tile.id} skipped source-surface vertices`);
  const glb = await readFile(path.join(ROOT, tile.artifact.path)); assert.equal(digest(glb), tile.artifact.sha256, `${tile.id} proof artifact hash drifted`); assert.equal(glb.length, tile.artifact.bytes, `${tile.id} proof artifact bytes drifted`);
  const gltf = parseGlb(glb); assert.equal(gltf.extras.tileId, tile.id); assert.equal(gltf.extras.lod, 1); assert.equal(gltf.extras.horizontalCrs, 'EPSG:26910'); assert.equal(gltf.extras.unitsPerMetre, 1); assert.equal(gltf.extras.runtimeFrame, 'provisional-utm-source-declared-navd88-unrealized');
  const source = proof.sourceBinding[index]; for (const entry of ['lod0', 'receipt', 'mapPackage']) assert.equal(digest(await readFile(path.join(ROOT, source[entry].path))), source[entry].sha256, `${tile.id} source ${entry} drifted`);
  for (const lock of source.sourceLocks) assert.equal(sha256(await readFile(path.join(ROOT, lock.path))), lock.sha256, `${tile.id} source lock drifted: ${lock.id}`);
  assert(!JSON.stringify(manifest).includes(tile.artifact.path), `${tile.id} proof artifact leaked into the production manifest`);
}
console.log(JSON.stringify({ result: 'LOD1 proof rejection verified', status: proof.status, maxVerticalDeviationMetres: proof.validation.maxVerticalDeviationMetres, contractLimitMetres: contract.lod.maxVerticalDeviationMetres, productionManifestUntouched: true }, null, 2));
