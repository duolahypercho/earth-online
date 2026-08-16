/** Adversarial verifier for the checked-in, preview-only Ferry OSM surface artifact. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFerryOsmSurfaceArtifact, readFerryOsmSource } from './build-sf-ferry-osm-surfaces-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-ferry-osm-surfaces-v1');
const ARTIFACT_PATH = path.join(OUTPUT, 'sf-ferry-osm-surfaces-v1.json');
const RECEIPT_PATH = path.join(OUTPUT, 'sf-ferry-osm-surfaces-v1.receipt.json');
const RAW_PBF_PATH = path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf');
const KEY_WAY_IDS = [1144255938, 979811996, 196662099, 196662083, 196662092, 196662089, 196662084, 196667183, 196662072, 1215872882];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function assertClosedRing(ring, label) {
  assert(ring.nodeIds.length >= 4, `${label} must have at least four source nodes`);
  assert.equal(ring.nodeIds[0], ring.nodeIds.at(-1), `${label} node topology must close`);
  assert.deepEqual(ring.coordinatesLonLat[0], ring.coordinatesLonLat.at(-1), `${label} coordinates must close`);
}

function assertSourceWaysMatch(rawRecords, source) {
  for (const record of rawRecords) {
    const sourceWay = source.ways.get(record.source.id);
    assert(sourceWay, `Preserved source way ${record.source.id} is absent from the raw PBF`);
    assert.deepEqual(record.source, { type: 'way', id: sourceWay.id, tags: sourceWay.tags }, `sourceWays tags/type/ID drifted for way ${sourceWay.id}`);
    assert.deepEqual(record.geometry.nodeIds, sourceWay.refs, `sourceWays node topology drifted for way ${sourceWay.id}`);
    assert.deepEqual(record.geometry.coordinatesLonLat, sourceWay.refs.map((nodeId) => [source.nodes.get(nodeId).lon, source.nodes.get(nodeId).lat]), `sourceWays coordinates drifted for way ${sourceWay.id}`);
  }
}

const [artifactBytes, receiptBytes, rawPbfBytes] = await Promise.all([readFile(ARTIFACT_PATH), readFile(RECEIPT_PATH), readFile(RAW_PBF_PATH)]);
const artifact = JSON.parse(artifactBytes); const receipt = JSON.parse(receiptBytes);
assert.equal(artifact.status, 'preview-artifact-not-for-runtime-or-manifest-promotion');
assert.equal(artifact.previewOnly, true);
assert.deepEqual(artifact.scope, { renderOnly: true, collision: 'none', navigation: 'none', productionUse: 'prohibited', runtimePlacement: 'none', manifestPromotion: 'prohibited' });
assert.equal(artifact.rights.license, 'ODbL-1.0');
assert.match(artifact.rights.attribution, /OpenStreetMap contributors/);
assert.equal(artifact.source.rawPbf.bytes, rawPbfBytes.length);
assert.equal(artifact.source.rawPbf.sha256, sha256(rawPbfBytes));
assert.equal(receipt.artifact.bytes, artifactBytes.length);
assert.equal(receipt.artifact.sha256, sha256(artifactBytes));
assert.deepEqual(receipt.rawPbf, artifact.source.rawPbf);
assert.deepEqual(artifact.requestedKeyWayIds, KEY_WAY_IDS);
assert.equal(artifact.requestedRelationId, 2642389);
assert.equal(artifact.surfaceRecords.length, 11);
for (const [index, record] of artifact.surfaceRecords.entries()) assert.equal(record.renderOrder, index, 'Render order must be explicit and contiguous');

const reparsed = await readFerryOsmSource();
const wayRecords = artifact.surfaceRecords.slice(0, KEY_WAY_IDS.length);
for (const [index, record] of wayRecords.entries()) {
  const id = KEY_WAY_IDS[index]; const sourceWay = reparsed.ways.get(id);
  assert.equal(record.recordId, `way/${id}`); assert.deepEqual(record.source, { type: 'way', id, tags: sourceWay.tags });
  assert.equal(record.geometry.rings.length, 1); assert.deepEqual(record.geometry.holes, []); assertClosedRing(record.geometry.rings[0], `way/${id}`);
  assert.deepEqual(record.geometry.rings[0].nodeIds, sourceWay.refs, `way/${id} source node order drifted`);
  assert.deepEqual(record.geometry.rings[0].coordinatesLonLat, sourceWay.refs.map((nodeId) => [reparsed.nodes.get(nodeId).lon, reparsed.nodes.get(nodeId).lat]), `way/${id} source coordinates drifted`);
  assert(record.areaSquareMetres.net > 0, `way/${id} needs a positive area`);
}
const relation = artifact.surfaceRecords.at(-1);
assert.equal(relation.recordId, 'relation/2642389');
assert.deepEqual(relation.source, { type: 'relation', id: 2642389, tags: reparsed.relation.tags, members: reparsed.relation.members });
assert.deepEqual(relation.topology.relationMembers, reparsed.relation.members, 'Relation member IDs, types, order, and roles must remain exact');
assert.deepEqual(relation.topology.outerWayIds, [196670578]);
assert.deepEqual(relation.topology.innerWayIds, [196670580, 196670579]);
assert.equal(relation.geometry.rings.length, 1); assert.equal(relation.geometry.holes.length, 2);
for (const ring of relation.geometry.rings) assertClosedRing(ring, 'relation outer ring');
for (const hole of relation.geometry.holes) assertClosedRing(hole, 'relation inner hole');
assert(relation.areaSquareMetres.outer > relation.areaSquareMetres.holes, 'Relation holes must reduce, not exceed, the outer area');
assert.equal(relation.areaSquareMetres.net, relation.areaSquareMetres.outer - relation.areaSquareMetres.holes);
const allSourceWayIds = artifact.sourceWays.map(({ source }) => source.id).sort((a, b) => a - b);
assert.deepEqual(allSourceWayIds, [...new Set([...KEY_WAY_IDS, 196670578, 196670580, 196670579])].sort((a, b) => a - b), 'Every key and relation-member way must be preserved');
assertSourceWaysMatch(artifact.sourceWays, reparsed);
const adversarialSourceWays = structuredClone(artifact.sourceWays);
const relationMemberRecord = adversarialSourceWays.find(({ source }) => source.id === 196670580);
relationMemberRecord.source.tags.adversarialMutation = 'must-not-pass';
assert.throws(() => assertSourceWaysMatch(adversarialSourceWays, reparsed), /sourceWays tags\/type\/ID drifted for way 196670580/, 'Adversarial relation-member tag mutation must be rejected');

const rebuilt = await buildFerryOsmSurfaceArtifact({ write: false });
assert(artifactBytes.equals(rebuilt.artifactBytes), 'Deterministic rebuild differs from checked-in artifact');
assert(receiptBytes.equals(jsonBytes(rebuilt.receipt)), 'Deterministic rebuild receipt differs from checked-in receipt');
process.stdout.write(`${JSON.stringify({ result: 'Ferry OSM surface preview verified adversarially', deterministicRebuild: true, artifactSha256: receipt.artifact.sha256, rawPbfSha256: receipt.rawPbf.sha256, sourceWaysPreserved: receipt.counts.sourceWaysPreserved, relationHoles: receipt.counts.relationHoles, previewOnly: artifact.previewOnly }, null, 2)}\n`);
