import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parse from 'osm-pbf-parser';
import through from 'through2';
import {
  createFerryCard04PierDeck,
  disposeFerryCard04PierDeck,
  FERRY_CARD04_PIER_PRESENTATION,
  FERRY_CARD04_PIER_SOURCE,
} from '../src/realmap/hero-waterfront-structures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PBF_PATH = path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf');
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-osm-horizontal-geometry-v1.lock.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function scanPbf(onItems) {
  await new Promise((resolve, reject) => {
    fs.createReadStream(PBF_PATH).pipe(parse()).pipe(through.obj((items, _encoding, callback) => {
      try { onItems(items); callback(); } catch (error) { callback(error); }
    })).on('finish', resolve).on('error', reject);
  });
}

const pbfBytes = await readFile(PBF_PATH);
const lock = JSON.parse(await readFile(LOCK_PATH));
assert.equal(sha256(pbfBytes), FERRY_CARD04_PIER_SOURCE.rawPbfSha256, 'Module PBF digest drifted');
assert.equal(sha256(pbfBytes), lock.source.snapshot.sha256, 'Raw PBF does not match the source lock');
let sourceWay = null;
const nodeIds = new Set();
await scanPbf((items) => {
  for (const item of items) {
    if (item.type !== 'way' || item.id !== FERRY_CARD04_PIER_SOURCE.sourceWayId) continue;
    sourceWay = item;
    item.refs.forEach((id) => nodeIds.add(id));
  }
});
assert(sourceWay, 'OSM source pier way is absent');
assert.deepEqual(sourceWay.tags, FERRY_CARD04_PIER_SOURCE.tags, 'OSM pier tags drifted');
const nodes = new Map();
await scanPbf((items) => {
  for (const item of items) if (item.type === 'node' && nodeIds.has(item.id)) nodes.set(item.id, [item.lon, item.lat]);
});
const nativePrecision = (value) => Number(value.toFixed(7));
const coordinatesLonLat = sourceWay.refs.map((id) => nodes.get(id).map(nativePrecision));
assert(!coordinatesLonLat.some((point) => !point), 'OSM pier node is unresolved');
assert.deepEqual(coordinatesLonLat, FERRY_CARD04_PIER_SOURCE.coordinatesLonLat, 'Module horizontal OSM geometry drifted');
const geometryRecord = { type: 'way', id: sourceWay.id, tags: FERRY_CARD04_PIER_SOURCE.tags, nodeIds: sourceWay.refs, coordinatesLonLat };
assert.equal(sha256(JSON.stringify(geometryRecord)), FERRY_CARD04_PIER_SOURCE.geometrySha256, 'Module geometry digest drifted');

const mesh = createFerryCard04PierDeck({ elevationAt: () => 1.25 });
assert(mesh, 'Pier deck did not build');
assert.equal(mesh.userData.sourceWayId, 661723975);
assert.equal(mesh.userData.sourceAligned, true);
assert.equal(mesh.userData.presentationOnly, true);
assert.equal(mesh.userData.verticalStatus, 'presentation-only; vertically uncertified');
assert.equal(mesh.userData.affectsCollision, false);
assert.deepEqual(mesh.userData.exclusions, ['not bathymetry', 'not a seawall', 'not a boat', 'no railings', 'no piles']);
assert.equal(mesh.castShadow, false);
assert.equal(mesh.userData.renderBudget.maxTriangles, 256);
assert(mesh.userData.triangles <= FERRY_CARD04_PIER_PRESENTATION.renderBudget.maxTriangles);
const positions = mesh.geometry.getAttribute('position');
assert.equal(positions.count, (FERRY_CARD04_PIER_SOURCE.coordinatesLonLat.length - 1) * 2, 'Deck vertex count must retain the complete closed source outline');
assert(Math.abs(positions.getY(0) - 1.33) < 1e-6, 'Deck lift must be explicit and bounded above the supplied presentation surface');
disposeFerryCard04PierDeck(mesh);
console.log(JSON.stringify({
  result: 'passed',
  module: 'src/realmap/hero-waterfront-structures.js',
  sourceWayId: FERRY_CARD04_PIER_SOURCE.sourceWayId,
  rawPbfSha256: FERRY_CARD04_PIER_SOURCE.rawPbfSha256,
  geometrySha256: FERRY_CARD04_PIER_SOURCE.geometrySha256,
  horizontalGeometry: 'exact locked OSM polygon',
  vertical: FERRY_CARD04_PIER_PRESENTATION.verticalStatus,
  collision: false,
  renderBudget: mesh.userData.renderBudget,
  geometry: { vertices: mesh.userData.vertices, triangles: mesh.userData.triangles },
}, null, 2));
