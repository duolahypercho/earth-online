import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
  SF_MAP_LEGACY_BUILDING_PRESENTATION,
  collectSourceToneAttributeBytes,
  normalizeTilePresentation,
  verifyParsedGlbMetricContract,
  verifyParsedGlbPresentation,
  verifyReceiptPresentation,
  verifyScenePresentation,
} from '../src/sf-map/building-presentation-contract.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN_PATH = path.join(ROOT, 'src/sf-map/main.js');
const MATERIAL_PATH = path.join(ROOT, 'src/sf-map/building-presentation-material.js');
const MANIFEST_PATH = path.join(ROOT, 'public/data/world/production-artifacts/sf-metric-tiles-v1/sf-metric-tiles-v1.manifest.json');
const PROOF_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-building-source-tone-production-proof-v1');

function expectReject(action, pattern) {
  assert.throws(action, pattern);
}

function attribute(values, options = {}) {
  return {
    array: options.array || new Uint8Array(values),
    itemSize: options.itemSize ?? 1,
    normalized: options.normalized ?? false,
    count: options.count ?? values.length,
  };
}

function sceneFixture({ tone = attribute([0, 1, 2]), positionCount = 3, leak = false, includeBuildings = true } = {}) {
  const nodes = [];
  if (includeBuildings) nodes.push({
    isMesh: true,
    material: { name: 'buildings-night' },
    geometry: { getAttribute: (name) => (name === 'position' ? { count: positionCount } : name === '_sf_source_tone_v1' ? tone : undefined) },
  });
  nodes.push({
    isMesh: true,
    material: { name: 'terrain-night' },
    geometry: { getAttribute: (name) => (name === 'position' ? { count: 3 } : name === '_sf_source_tone_v1' && leak ? attribute([0, 0, 0]) : undefined) },
  });
  return { traverse: (visit) => nodes.forEach(visit) };
}

async function readGlbJson(relativePath) {
  const handle = await open(path.join(ROOT, relativePath), 'r');
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    assert.equal(bytesRead, header.length, `${relativePath} has a truncated GLB header`);
    assert.equal(header.readUInt32LE(0), 0x46546c67, `${relativePath} is not a GLB`);
    assert.equal(header.readUInt32LE(4), 2, `${relativePath} is not GLB v2`);
    const jsonLength = header.readUInt32LE(12);
    assert.equal(header.readUInt32LE(16), 0x4e4f534a, `${relativePath} does not start with a JSON chunk`);
    const json = Buffer.alloc(jsonLength);
    assert.equal((await handle.read(json, 0, jsonLength, 20)).bytesRead, jsonLength, `${relativePath} has a truncated JSON chunk`);
    return JSON.parse(json.toString('utf8').trim());
  } finally {
    await handle.close();
  }
}

const sourceDescriptor = normalizeTilePresentation({
  mode: 'source-tone-v1',
  productionWriteEnabled: true,
  productionPromotionAuthorized: true,
  contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
}, 'synthetic-source-tile');
const sourceReceipt = {
  presentation: {
    mode: 'source-tone-v1',
    productionWriteEnabled: true,
    productionPromotionAuthorized: true,
    contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1,
    ledgers: { sourceToneAttributeSha256: `sha256:${'0'.repeat(64)}` },
  },
};

assert.deepEqual(normalizeTilePresentation(null), SF_MAP_LEGACY_BUILDING_PRESENTATION);
assert.equal(normalizeTilePresentation({ mode: 'legacy' }).mode, 'legacy');
expectReject(() => normalizeTilePresentation({ mode: 'source-tone-v1', productionWriteEnabled: false, productionPromotionAuthorized: false, contract: SF_BUILDING_SOURCE_TONE_CONTRACT_V1 }, 'candidate'), /not production-authorized/);
expectReject(() => normalizeTilePresentation({ mode: 'source-tone-v1', productionWriteEnabled: true, productionPromotionAuthorized: true, contract: { ...SF_BUILDING_SOURCE_TONE_CONTRACT_V1, schema: 'wrong' } }, 'candidate'), /does not match/);
assert.equal(verifyReceiptPresentation({}, SF_MAP_LEGACY_BUILDING_PRESENTATION).mode, 'legacy');
assert.equal(verifyReceiptPresentation(sourceReceipt, sourceDescriptor).mode, 'source-tone-v1');
expectReject(() => verifyReceiptPresentation({ presentation: { ...sourceReceipt.presentation, productionWriteEnabled: false } }, sourceDescriptor, 'candidate'), /not authorized/);
expectReject(() => verifyReceiptPresentation({ presentation: { ...sourceReceipt.presentation, contract: { ...SF_BUILDING_SOURCE_TONE_CONTRACT_V1, schema: 'wrong' } } }, sourceDescriptor, 'candidate'), /does not match/);

verifyParsedGlbPresentation({ parser: { json: { extras: { presentation: SF_BUILDING_SOURCE_TONE_CONTRACT_V1 } } } }, sourceDescriptor);
verifyParsedGlbPresentation({ parser: { json: { extras: {} } } }, SF_MAP_LEGACY_BUILDING_PRESENTATION);
expectReject(() => verifyParsedGlbPresentation({ parser: { json: { extras: {} } } }, sourceDescriptor, 'candidate'), /GLB presentation contract/);
const metricDescriptor = { id: 'synthetic-source-tile', origin: [553344, 4182912, 0] };
const metricGltf = { parser: { json: { extras: { tileId: metricDescriptor.id, horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, tileOriginEpsg26910VerticalMetres: metricDescriptor.origin } } } };
verifyParsedGlbMetricContract(metricGltf, metricDescriptor);
expectReject(() => verifyParsedGlbMetricContract({ parser: { json: { extras: { ...metricGltf.parser.json.extras, unitsPerMetre: 0.5 } } } }, metricDescriptor), /identity\/CRS\/scale/);
expectReject(() => verifyParsedGlbMetricContract({ parser: { json: { extras: { ...metricGltf.parser.json.extras, tileOriginEpsg26910VerticalMetres: [0, 0, 0] } } } }, metricDescriptor), /metric origin/);
verifyScenePresentation(sceneFixture(), sourceDescriptor);
verifyScenePresentation(sceneFixture({ tone: null }), SF_MAP_LEGACY_BUILDING_PRESENTATION);
expectReject(() => verifyScenePresentation(sceneFixture({ tone: null }), sourceDescriptor, 'candidate'), /missing position or tone/);
expectReject(() => verifyScenePresentation(sceneFixture({ tone: attribute([0, 1, 2], { array: new Uint16Array([0, 1, 2]) }) }), sourceDescriptor, 'candidate'), /not UINT8/);
expectReject(() => verifyScenePresentation(sceneFixture({ tone: attribute([0, 1, 2], { normalized: true }) }), sourceDescriptor, 'candidate'), /not UINT8/);
expectReject(() => verifyScenePresentation(sceneFixture({ tone: attribute([0, 1], { count: 2 }), positionCount: 3 }), sourceDescriptor, 'candidate'), /not UINT8/);
expectReject(() => verifyScenePresentation(sceneFixture({ tone: attribute([0, 4, 2]) }), sourceDescriptor, 'candidate'), /outside 0\.\.3/);
expectReject(() => verifyScenePresentation(sceneFixture({ leak: true }), sourceDescriptor, 'candidate'), /leaked onto a non-building/);
expectReject(() => verifyScenePresentation(sceneFixture({ includeBuildings: false }), sourceDescriptor, 'candidate'), /contains no building mesh/);
expectReject(() => verifyScenePresentation(sceneFixture(), SF_MAP_LEGACY_BUILDING_PRESENTATION, 'legacy'), /legacy mesh carries/);

const orderedMeshes = [
  { isMesh: true, material: { name: 'buildings-night' }, geometry: { getAttribute: (name) => name === '_sf_source_tone_v1' ? attribute([2, 3]) : name === 'position' ? { count: 2 } : undefined } },
  { isMesh: true, material: { name: 'buildings-night' }, geometry: { getAttribute: (name) => name === '_sf_source_tone_v1' ? attribute([0, 1]) : name === 'position' ? { count: 2 } : undefined } },
];
const orderedAssociations = new Map([[orderedMeshes[0], { primitives: 5 }], [orderedMeshes[1], { primitives: 2 }]]);
assert.deepEqual([...collectSourceToneAttributeBytes({
  scene: { traverse: (visit) => orderedMeshes.forEach(visit) },
  parser: { associations: orderedAssociations },
}, sourceDescriptor, 'ordered-fixture')], [0, 1, 2, 3], 'Source-tone payload bytes must follow GLTF primitive order rather than scene traversal order');
orderedAssociations.set(orderedMeshes[0], { primitives: 2 });
expectReject(() => collectSourceToneAttributeBytes({
  scene: { traverse: (visit) => orderedMeshes.forEach(visit) },
  parser: { associations: orderedAssociations },
}, sourceDescriptor, 'duplicate-fixture'), /primitive index 2 is duplicated/);

const [mainSource, materialSource, manifestBytes, proofManifestBytes] = await Promise.all([
  readFile(MAIN_PATH, 'utf8'),
  readFile(MATERIAL_PATH, 'utf8'),
  readFile(MANIFEST_PATH),
  readFile(path.join(PROOF_ROOT, 'sf-building-source-tone-production-proof-v1.manifest.json')),
]);
const manifest = JSON.parse(manifestBytes);
const proofManifest = JSON.parse(proofManifestBytes);
assert(manifest.tiles.every((tile) => tile.presentation == null), 'Current production tiles must remain legacy until promotion is authorized');
assert.equal(proofManifest.productionPromotionAuthorized, false);
for (let start = 0; start < manifest.tiles.length; start += 24) {
  await Promise.all(manifest.tiles.slice(start, start + 24).map(async (tile) => {
    const [glb, receipt] = await Promise.all([
      readGlbJson(tile.lod0.path),
      readFile(path.join(ROOT, tile.receipt.path), 'utf8').then(JSON.parse),
    ]);
    assert.equal(receipt.presentation, undefined, `${tile.id} production receipt unexpectedly declares presentation metadata`);
    assert.equal(glb.extras?.presentation, undefined, `${tile.id} production GLB unexpectedly declares presentation metadata`);
    assert.equal(glb.extras?.tileId, tile.id, `${tile.id} GLB tile identity drifted`);
    assert.equal(glb.extras?.horizontalCrs, 'EPSG:26910', `${tile.id} GLB CRS drifted`);
    assert.equal(glb.extras?.unitsPerMetre, 1, `${tile.id} GLB scale drifted`);
    assert.deepEqual(glb.extras?.tileOriginEpsg26910VerticalMetres, tile.originEpsg26910VerticalMetres, `${tile.id} GLB origin drifted`);
    for (const mesh of glb.meshes || []) for (const primitive of mesh.primitives || []) {
      assert.equal(primitive.attributes?._SF_SOURCE_TONE_V1, undefined, `${tile.id} legacy GLB unexpectedly carries a source-tone attribute`);
    }
  }));
}
for (const tile of proofManifest.tiles) {
  const receipt = JSON.parse(await readFile(path.join(ROOT, tile.receipt), 'utf8'));
  expectReject(() => normalizeTilePresentation({ mode: 'source-tone-v1', productionWriteEnabled: receipt.productionPromotionAuthorized, productionPromotionAuthorized: receipt.productionPromotionAuthorized, contract: receipt.contract }, tile.tile), /not production-authorized/);
  const metricReceipt = JSON.parse(await readFile(path.join(ROOT, tile.metricReceipt.path), 'utf8'));
  expectReject(() => verifyReceiptPresentation(metricReceipt, sourceDescriptor, tile.tile), /not authorized for production/);
  const authorizedMetricReceipt = structuredClone(metricReceipt);
  authorizedMetricReceipt.presentation.productionWriteEnabled = true;
  authorizedMetricReceipt.presentation.productionPromotionAuthorized = true;
  const authorizedDescriptorPresentation = normalizeTilePresentation({ mode: 'source-tone-v1', productionWriteEnabled: true, productionPromotionAuthorized: true, contract: receipt.contract }, tile.tile);
  const authorizedPresentationIntegrity = verifyReceiptPresentation(authorizedMetricReceipt, authorizedDescriptorPresentation, tile.tile);
  const candidateBytes = await readFile(path.join(ROOT, tile.artifact.path));
  const candidateGltf = await new GLTFLoader().parseAsync(candidateBytes.buffer.slice(candidateBytes.byteOffset, candidateBytes.byteOffset + candidateBytes.byteLength), '');
  const metricDescriptor = { id: tile.tile, origin: authorizedMetricReceipt.tile.originEpsg26910VerticalMetres };
  verifyParsedGlbMetricContract(candidateGltf, metricDescriptor, tile.tile);
  verifyParsedGlbPresentation(candidateGltf, authorizedDescriptorPresentation, tile.tile);
  verifyScenePresentation(candidateGltf.scene, authorizedDescriptorPresentation, tile.tile);
  const payload = collectSourceToneAttributeBytes(candidateGltf, authorizedDescriptorPresentation, tile.tile);
  assert.equal(`sha256:${createHash('sha256').update(payload).digest('hex')}`, authorizedPresentationIntegrity.sourceToneAttributeSha256, `${tile.tile} decoded Three attribute bytes do not match the metric receipt ledger`);
}

const receiptFetch = mainSource.indexOf('const receiptArtifact = await fetchVerifiedBytes(');
const receiptVerify = mainSource.indexOf('verifyReceiptPresentation(receipt, descriptor.presentation');
const glbFetch = mainSource.indexOf('const glbArtifact = await fetchVerifiedBytes(');
const glbParse = mainSource.indexOf('gltfLoader.parseAsync(glbArtifact.bytes');
const metricGlbVerify = mainSource.indexOf('verifyParsedGlbMetricContract(gltf, descriptor');
const glbVerify = mainSource.indexOf('verifyParsedGlbPresentation(gltf, descriptor.presentation');
assert(receiptFetch >= 0 && receiptVerify > receiptFetch && glbFetch > receiptVerify && glbParse > glbFetch && metricGlbVerify > glbParse && glbVerify > metricGlbVerify, 'Receipt authorization must be verified before GLB fetch/parsing and metric/presentation validation');
assert(mainSource.includes('collectSourceToneAttributeBytes(gltf, descriptor.presentation, descriptor.id)'));
assert(mainSource.includes('source-tone attribute SHA-256 does not match its receipt ledger'));
assert(mainSource.includes("material.customProgramCacheKey = () => 'sf-map-building-palette-v1'"));
assert(mainSource.includes("import { applySourceToneBuildingPresentation } from './building-presentation-material.js'"));
assert(mainSource.includes("if (descriptor.presentation.mode === 'source-tone-v1') applySourceToneBuildingPresentation(node.material, {"));
assert(mainSource.includes('policySha256: SF_BUILDING_SOURCE_TONE_CONTRACT_V1.derivation.policySha256'));
assert(materialSource.includes('attribute float _sf_source_tone_v1;'));
assert(materialSource.includes('vec3 sfWorldFaceNormal = normalize(cross(sfDx, sfDy));'));
assert(materialSource.includes('float sfFacadeContrast = mix(0.52, 1.26'));
assert(materialSource.includes('sf-map-building-source-tone-v1:${policySha256}'));

process.stdout.write(`${JSON.stringify({
  result: 'SF map presentation contract passed',
  productionManifestTiles: manifest.tiles.length,
  productionPresentationModes: { legacyImplicit: manifest.tiles.length, sourceToneV1: 0 },
  productionGlbHeadersAndReceiptsAudited: manifest.tiles.length,
  proofArtifactsRejectedForProduction: proofManifest.tiles.length,
  sourceTonePolicySha256: SF_BUILDING_SOURCE_TONE_CONTRACT_V1.derivation.policySha256,
  verified: ['authorization before GLB fetch/parse', 'positive Three GLTFLoader source-tone path', 'decoded attribute SHA-256 receipt binding in explicit primitive order', 'GLB root metric identity/origin/scale', 'distinct shader cache keys', 'exact receipt/GLB contract', 'UINT8 scalar domain and count', 'no attribute leakage', 'legacy compatibility'],
}, null, 2)}\n`);
