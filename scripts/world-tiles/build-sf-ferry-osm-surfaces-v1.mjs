/**
 * Build a deterministic, preview-only OSM surface extract for the Ferry area.
 *
 * This intentionally does not update an atlas, city asset, runtime module, or
 * tile manifest. It is a lossless-enough source record for visual experiments:
 * source IDs, tags, node sequences, relation roles, and polygon holes remain
 * explicit in the emitted JSON.
 *
 * Usage: node scripts/world-tiles/build-sf-ferry-osm-surfaces-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import parse from 'osm-pbf-parser';
import through from 'through2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW_PBF = path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'public/data/world/preview-artifacts/sf-ferry-osm-surfaces-v1');
const ARTIFACT_NAME = 'sf-ferry-osm-surfaces-v1.json';
const RECEIPT_NAME = 'sf-ferry-osm-surfaces-v1.receipt.json';
const KEY_WAY_IDS = [1144255938, 979811996, 196662099, 196662083, 196662092, 196662089, 196662084, 196667183, 196662072, 1215872882];
const RELATION_ID = 2642389;
const EARTH_RADIUS_METRES = 6371008.8;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');

function sortedTags(tags = {}) {
  return Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)));
}

async function scanPbf(onItems) {
  await new Promise((resolve, reject) => {
    fs.createReadStream(RAW_PBF)
      .pipe(parse())
      .pipe(through.obj((items, _encoding, callback) => {
        try { onItems(items); callback(); } catch (error) { callback(error); }
      }))
      .on('finish', resolve)
      .on('error', reject);
  });
}

/** Read only the exact objects needed, in three bounded-memory PBF passes. */
export async function readFerryOsmSource() {
  let relation = null;
  await scanPbf((items) => {
    for (const item of items) if (item.type === 'relation' && item.id === RELATION_ID) relation = item;
  });
  assert(relation, `Required OSM relation ${RELATION_ID} was not found`);
  const relationWayIds = relation.members.filter((member) => member.type === 'way').map((member) => member.id);
  const selectedWayIds = new Set([...KEY_WAY_IDS, ...relationWayIds]);
  const ways = new Map();
  const nodeIds = new Set();
  await scanPbf((items) => {
    for (const item of items) {
      if (item.type !== 'way' || !selectedWayIds.has(item.id)) continue;
      ways.set(item.id, { type: 'way', id: item.id, tags: sortedTags(item.tags), refs: [...item.refs] });
      for (const ref of item.refs) nodeIds.add(ref);
    }
  });
  assert.equal(ways.size, selectedWayIds.size, 'One or more requested OSM ways were not found');
  const nodes = new Map();
  await scanPbf((items) => {
    for (const item of items) {
      if (item.type === 'node' && nodeIds.has(item.id)) nodes.set(item.id, { lon: item.lon, lat: item.lat });
    }
  });
  assert.equal(nodes.size, nodeIds.size, 'One or more OSM node references could not be resolved');
  return {
    relation: { type: 'relation', id: relation.id, tags: sortedTags(relation.tags), members: relation.members.map(({ type, id, role = '' }) => ({ type, id, role })) },
    ways,
    nodes,
  };
}

function boundsLonLat(rings) {
  const coordinates = rings.flatMap((ring) => ring.coordinatesLonLat);
  const lons = coordinates.map(([lon]) => lon); const lats = coordinates.map(([, lat]) => lat);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

function localFrameFor(rings) {
  const bounds = boundsLonLat(rings);
  return { originLonLat: [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2] };
}

function toLocal([lon, lat], frame) {
  const [originLon, originLat] = frame.originLonLat;
  const radians = Math.PI / 180;
  return [EARTH_RADIUS_METRES * Math.cos(originLat * radians) * (lon - originLon) * radians, EARTH_RADIUS_METRES * (lat - originLat) * radians];
}

function signedAreaSquareMetres(coordinatesLonLat, frame) {
  let twiceArea = 0;
  for (let index = 0; index < coordinatesLonLat.length - 1; index += 1) {
    const [ax, az] = toLocal(coordinatesLonLat[index], frame);
    const [bx, bz] = toLocal(coordinatesLonLat[index + 1], frame);
    twiceArea += ax * bz - bx * az;
  }
  return twiceArea / 2;
}

function areaSummary(rings, holes) {
  const frame = localFrameFor([...rings, ...holes]);
  const outerAreaSquareMetres = rings.reduce((sum, ring) => sum + Math.abs(signedAreaSquareMetres(ring.coordinatesLonLat, frame)), 0);
  const holesAreaSquareMetres = holes.reduce((sum, hole) => sum + Math.abs(signedAreaSquareMetres(hole.coordinatesLonLat, frame)), 0);
  const bounds = boundsLonLat([...rings, ...holes]);
  const localCorners = [[bounds.west, bounds.south], [bounds.east, bounds.north]].map((coordinate) => toLocal(coordinate, frame));
  return {
    localFrame: frame,
    boundsWgs84: bounds,
    boundsLocalMetres: { minX: Math.min(...localCorners.map(([x]) => x)), minZ: Math.min(...localCorners.map(([, z]) => z)), maxX: Math.max(...localCorners.map(([x]) => x)), maxZ: Math.max(...localCorners.map(([, z]) => z)) },
    areaSquareMetres: { outer: outerAreaSquareMetres, holes: holesAreaSquareMetres, net: outerAreaSquareMetres - holesAreaSquareMetres },
  };
}

function wayRing(way, nodes, role = 'outer') {
  const coordinatesLonLat = way.refs.map((nodeId) => {
    const node = nodes.get(nodeId);
    assert(node, `Missing node ${nodeId} referenced by OSM way ${way.id}`);
    return [node.lon, node.lat];
  });
  assert(way.refs.length >= 4, `OSM way ${way.id} is too short to represent an area`);
  assert.equal(way.refs[0], way.refs.at(-1), `OSM way ${way.id} is not a closed area ring`);
  return { role, sourceWayIds: [way.id], nodeIds: [...way.refs], coordinatesLonLat };
}

function assembleRelationRings(relation, ways, nodes, role) {
  const members = relation.members.filter((member) => member.type === 'way' && member.role === role);
  // The source relation currently uses one closed way per ring. Keeping this
  // narrow, lossless representation avoids silently inventing a stitch order.
  return members.map((member) => wayRing(ways.get(member.id), nodes, role));
}

function materialFamily(tags) {
  const value = tags.surface;
  const map = { concrete: 'concrete', 'concrete:plates': 'concrete_plates', bricks: 'bricks', paving_stones: 'paving_stones', wood: 'wood', paved: 'paved' };
  assert(map[value], `No approved material family for OSM surface=${JSON.stringify(value)}`);
  return map[value];
}

function sourceWayRecord(way, nodes) {
  return { source: { type: way.type, id: way.id, tags: way.tags }, geometry: { nodeIds: [...way.refs], coordinatesLonLat: way.refs.map((nodeId) => [nodes.get(nodeId).lon, nodes.get(nodeId).lat]) } };
}

export async function buildFerryOsmSurfaceArtifact({ outputDir = DEFAULT_OUTPUT_DIR, write = true } = {}) {
  const rawPbfStat = await stat(RAW_PBF);
  const rawPbfBytes = await readFile(RAW_PBF);
  assert.equal(rawPbfBytes.length, rawPbfStat.size, 'Raw PBF byte count changed while reading');
  const source = await readFerryOsmSource();
  assert.equal(source.relation.tags.type, 'multipolygon', 'Ferry relation must retain its source multipolygon type');
  assert.deepEqual(source.relation.members.map(({ type, id, role }) => ({ type, id, role })), [
    { type: 'way', id: 196670578, role: 'outer' }, { type: 'way', id: 196670580, role: 'inner' }, { type: 'way', id: 196670579, role: 'inner' },
  ], 'Ferry relation membership/holes changed from the explicit source contract');
  const sourceWays = [...source.ways.values()].sort((a, b) => a.id - b.id).map((way) => sourceWayRecord(way, source.nodes));
  const surfaceRecords = KEY_WAY_IDS.map((id, renderOrder) => {
    const way = source.ways.get(id); const ring = wayRing(way, source.nodes);
    return {
      recordId: `way/${id}`, renderOrder, source: { type: way.type, id: way.id, tags: way.tags }, materialFamily: materialFamily(way.tags),
      ownership: { semantics: 'source-record-order-only; no clipping, offset, or overlap resolution encoded' },
      geometry: { kind: 'polygon', rings: [ring], holes: [] }, topology: { sourceWayIds: [way.id], sourceNodeIds: [...way.refs] }, ...areaSummary([ring], []),
    };
  });
  const outerRings = assembleRelationRings(source.relation, source.ways, source.nodes, 'outer');
  const holes = assembleRelationRings(source.relation, source.ways, source.nodes, 'inner');
  surfaceRecords.push({
    recordId: `relation/${RELATION_ID}`, renderOrder: surfaceRecords.length,
    source: { type: source.relation.type, id: source.relation.id, tags: source.relation.tags, members: source.relation.members }, materialFamily: materialFamily(source.relation.tags),
    ownership: { semantics: 'source-record-order-only; no clipping, offset, or overlap resolution encoded' },
    geometry: { kind: 'multipolygon', rings: outerRings, holes }, topology: { relationMembers: source.relation.members, outerWayIds: outerRings.flatMap((ring) => ring.sourceWayIds), innerWayIds: holes.flatMap((ring) => ring.sourceWayIds) }, ...areaSummary(outerRings, holes),
  });
  const artifact = {
    schemaVersion: 1, id: 'sf-ferry-osm-surfaces-v1', kind: 'openstreetmap-surface-geometry-preview', status: 'preview-artifact-not-for-runtime-or-manifest-promotion', previewOnly: true,
    scope: { renderOnly: true, collision: 'none', navigation: 'none', productionUse: 'prohibited', runtimePlacement: 'none', manifestPromotion: 'prohibited' },
    rights: { source: 'OpenStreetMap contributors', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', notice: 'OpenStreetMap data is available under the Open Database License (ODbL). This derived preview must retain attribution and comply with applicable ODbL share-alike obligations.' },
    source: { rawPbf: { path: relative(RAW_PBF), bytes: rawPbfBytes.length, sha256: sha256(rawPbfBytes), format: 'OSM PBF' }, coordinateReference: { horizontal: 'WGS 84 as carried by OpenStreetMap PBF coordinates', coordinateOrder: ['longitude', 'latitude'] } },
    localFrameFormula: { id: 'spherical-equirectangular-local-v1', earthRadiusMetres: EARTH_RADIUS_METRES, origin: 'per-record center of its WGS84 bounds', radiansPerDegree: Math.PI / 180, xMetres: 'R * cos(originLatitudeRadians) * (longitudeDegrees - originLongitudeDegrees) * radiansPerDegree', zMetres: 'R * (latitudeDegrees - originLatitudeDegrees) * radiansPerDegree', yMetres: 'not supplied by this 2D surface artifact' },
    requestedKeyWayIds: KEY_WAY_IDS, requestedRelationId: RELATION_ID, sourceWays, surfaceRecords,
    limitations: ['Preview-only visual-source artifact; it is not referenced by runtime code, city data, atlas data, or tile manifests.', 'No elevation, collision, physics, navigation, ownership clipping, render offset, or production suitability is supplied or implied.', 'Areas and local coordinates use the declared local approximation and are not a survey, legal, or precision-geodesy claim.'],
  };
  const artifactBytes = jsonBytes(artifact);
  const receipt = {
    schemaVersion: 1, id: 'sf-ferry-osm-surfaces-v1-receipt', status: artifact.status, previewOnly: true,
    artifact: { path: `${relative(outputDir)}/${ARTIFACT_NAME}`, bytes: artifactBytes.length, sha256: sha256(artifactBytes) }, rawPbf: artifact.source.rawPbf,
    counts: { requestedKeyWays: KEY_WAY_IDS.length, sourceWaysPreserved: sourceWays.length, surfaceRecords: surfaceRecords.length, relationOuterRings: outerRings.length, relationHoles: holes.length },
    limitations: artifact.limitations,
  };
  if (write) {
    await mkdir(outputDir, { recursive: true });
    await Promise.all([writeFile(path.join(outputDir, ARTIFACT_NAME), artifactBytes), writeFile(path.join(outputDir, RECEIPT_NAME), jsonBytes(receipt))]);
  }
  return { artifact, artifactBytes, receipt, artifactPath: path.join(outputDir, ARTIFACT_NAME), receiptPath: path.join(outputDir, RECEIPT_NAME) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildFerryOsmSurfaceArtifact();
  process.stdout.write(`${JSON.stringify({ result: 'Ferry OSM surface preview built', artifact: relative(result.artifactPath), receipt: relative(result.receiptPath), artifactSha256: result.receipt.artifact.sha256, rawPbfSha256: result.receipt.rawPbf.sha256, surfaceRecords: result.receipt.counts.surfaceRecords, relationHoles: result.receipt.counts.relationHoles }, null, 2)}\n`);
}
