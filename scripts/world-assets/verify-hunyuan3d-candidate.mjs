import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importCandidate } from './import-hunyuan3d-candidate.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function paddedJson(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const padding = (4 - (body.length % 4)) % 4;
  return Buffer.concat([body, Buffer.alloc(padding, 0x20)]);
}

function makeMinimalTriangleGlb({ externalUri = false, vertexCount = 3 } = {}) {
  const positions = Buffer.alloc(vertexCount * 12);
  const json = {
    asset: { version: '2.0', generator: 'hunyuan3d-candidate-fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.length, ...(externalUri ? { uri: 'https://example.invalid/external.bin' } : {}) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 }],
    accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: vertexCount, type: 'VEC3' }],
  };
  const jsonChunk = paddedJson(json);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + 8 + jsonChunk.length + 8 + positions.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(positions.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binaryHeader, positions]);
}

function validProvenance(digest) {
  return {
    schemaVersion: 'hunyuan3d-candidate-v1',
    candidateId: 'fixture-street-lamp-v1',
    assetRole: 'street-furniture',
    geospatialAuthority: false,
    content: { sha256: digest },
    model: {
      family: 'Hunyuan3D-2.1',
      name: 'fixture-model',
      checkpoint: 'fixture-checkpoint',
      sourceRepository: 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1',
    },
    license: {
      id: 'Tencent Hunyuan 3D 2.1 Community License Agreement',
      sourceUrl: 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE',
      reviewedAt: '2026-08-10',
    },
    rights: { inputRights: 'confirmed', outputRights: 'pending-human-review', distributionAllowed: false },
    input: { digestSha256: 'a'.repeat(64) },
    prompt: 'A fictional test street lamp, used only to verify the quarantine gate.',
    seed: 1234,
    environment: {
      generatorVersion: 'fixture-v1',
      runtime: 'remote CUDA worker',
      operatingSystem: 'Linux',
      gpu: 'fixture GPU',
      cuda: '12.8',
      generatedAt: '2026-08-10T00:00:00.000Z',
    },
    coordinate: { upAxis: '+Y', unit: 'meters', forwardAxis: '-Z' },
    budgets: { maxBytes: 4096, maxVertices: 3, maxTriangles: 1, maxImages: 1, maxTextureDimension: 1024 },
    review: { status: 'quarantined', promotionApproved: false },
  };
}

async function expectRejected(name, action, pattern) {
  await assert.rejects(action, pattern, name);
}

const root = await mkdtemp(join(tmpdir(), 'hunyuan3d-candidate-'));
const quarantine = join(root, 'private-quarantine');
const validGlb = makeMinimalTriangleGlb();
const validGlbPath = join(root, 'valid.glb');
const validProvenancePath = join(root, 'valid.provenance.json');
await writeFile(validGlbPath, validGlb);
await writeFile(validProvenancePath, `${JSON.stringify(validProvenance(sha256(validGlb)), null, 2)}\n`);

const imported = await importCandidate({
  glbPath: resolve(validGlbPath),
  provenancePath: resolve(validProvenancePath),
  quarantineDir: quarantine,
});
assert.equal(imported.receipt.review.status, 'quarantined');
assert.equal(imported.receipt.review.promotionApproved, false);
assert.equal(imported.receipt.geospatialAuthority, false);
assert.equal(imported.receipt.glbStats.vertices, 3);
assert.equal(imported.receipt.glbStats.triangles, 1);
assert.equal(imported.receipt.imported, true);
await access(imported.glbTarget);
await access(imported.provenanceTarget);
await access(imported.receiptTarget);
assert.ok(!imported.glbTarget.includes(`${resolve(process.cwd(), 'public')}/`), 'fixture must never write to public');

const idempotent = await importCandidate({
  glbPath: resolve(validGlbPath),
  provenancePath: resolve(validProvenancePath),
  quarantineDir: quarantine,
});
assert.equal(idempotent.receipt.imported, false, 'same digest is idempotent');

async function writeCase(name, glb, provenance) {
  const glbPath = join(root, `${name}.glb`);
  const provenancePath = join(root, `${name}.json`);
  await writeFile(glbPath, glb);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { glbPath: resolve(glbPath), provenancePath: resolve(provenancePath) };
}

const badDigest = validProvenance('0'.repeat(64));
const badDigestCase = await writeCase('bad-digest', validGlb, badDigest);
await expectRejected('content digest mismatch', () => importCandidate({ ...badDigestCase, quarantineDir: quarantine }), /content\.sha256 does not match/);

const externalGlb = makeMinimalTriangleGlb({ externalUri: true });
const externalCase = await writeCase('external-uri', externalGlb, validProvenance(sha256(externalGlb)));
await expectRejected('external GLB URI', () => importCandidate({ ...externalCase, quarantineDir: quarantine }), /uri is forbidden/);

const roadRole = validProvenance(sha256(validGlb));
roadRole.assetRole = 'authoritative-road';
const roadRoleCase = await writeCase('road-role', validGlb, roadRole);
await expectRejected('authoritative role', () => importCandidate({ ...roadRoleCase, quarantineDir: quarantine }), /assetRole.*not permitted/);

const geospatial = validProvenance(sha256(validGlb));
geospatial.geospatialAuthority = true;
const geospatialCase = await writeCase('geospatial', validGlb, geospatial);
await expectRejected('geospatial authority', () => importCandidate({ ...geospatialCase, quarantineDir: quarantine }), /geospatialAuthority must be false/);

const badCoordinate = validProvenance(sha256(validGlb));
badCoordinate.coordinate.forwardAxis = '+Z';
const badCoordinateCase = await writeCase('bad-coordinate', validGlb, badCoordinate);
await expectRejected('coordinate declaration', () => importCandidate({ ...badCoordinateCase, quarantineDir: quarantine }), /coordinate must declare/);

const promoted = validProvenance(sha256(validGlb));
promoted.review = { status: 'approved', promotionApproved: true };
const promotedCase = await writeCase('promoted', validGlb, promoted);
await expectRejected('promoted review status', () => importCandidate({ ...promotedCase, quarantineDir: quarantine }), /review must remain quarantined/);

const twoTriangleGlb = makeMinimalTriangleGlb({ vertexCount: 6 });
const budgetBreach = validProvenance(sha256(twoTriangleGlb));
budgetBreach.budgets.maxBytes = 4096;
budgetBreach.budgets.maxVertices = 6;
budgetBreach.budgets.maxTriangles = 1;
const budgetBreachCase = await writeCase('budget-breach', twoTriangleGlb, budgetBreach);
await expectRejected('triangle budget breach', () => importCandidate({ ...budgetBreachCase, quarantineDir: quarantine }), /triangle count 2 exceeds maxTriangles 1/);

const storedReceipt = JSON.parse(await readFile(imported.receiptTarget, 'utf8'));
assert.equal(storedReceipt.contentSha256, sha256(validGlb));
console.log(JSON.stringify({ result: 'passed', tempRoot: root, receipt: storedReceipt }, null, 2));
