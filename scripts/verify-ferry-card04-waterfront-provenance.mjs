/**
 * Audits the locked local sources at the fixed Ferry Card04 pose.
 *
 * This is deliberately a source diagnostic, not a mesh builder or runtime
 * contract.  It reports only physical OSM tags whose complete way geometry is
 * available inside the hero buffer.  In particular, ferry route relations are
 * not treated as piers or boats.
 *
 * Usage: node scripts/verify-ferry-card04-waterfront-provenance.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parse from 'osm-pbf-parser';
import through from 'through2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PBF_PATH = path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf');
const SHORELINE_PATH = path.join(ROOT, 'public/data/sf/sf-shoreline.geojson');
const OSM_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-osm-horizontal-geometry-v1.lock.json');
const SHORELINE_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-datasf-shoreline-horizontal-geometry-v1.lock.json');
const CARD04 = Object.freeze({ x: 2420, z: 1820 });
const HERO_BUFFER = Object.freeze({ minX: 2128, minZ: 1712, maxX: 2544, maxZ: 2128 });
const ATLAS_FRAME = Object.freeze({ lon: -122.4194, lat: 37.778, metresPerDegreeLon: 87986.24747640654, metresPerDegreeLat: 110574 });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const project = (lon, lat) => ({
  x: (lon - ATLAS_FRAME.lon) * ATLAS_FRAME.metresPerDegreeLon,
  z: (lat - ATLAS_FRAME.lat) * ATLAS_FRAME.metresPerDegreeLat,
});
const inBuffer = ({ x, z }) => x >= HERO_BUFFER.minX && x <= HERO_BUFFER.maxX && z >= HERO_BUFFER.minZ && z <= HERO_BUFFER.maxZ;
const rounded = (value) => Number(value.toFixed(3));

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index];
    const b = ring[previous];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx ** 2 + dz ** 2;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared)) : 0;
  const closest = { x: a.x + dx * t, z: a.z + dz * t };
  return { distanceM: Math.hypot(point.x - closest.x, point.z - closest.z), closest };
}

function shorelineAudit(shoreline) {
  const polygons = shoreline.features.flatMap((feature) => {
    const coordinates = feature.geometry?.type === 'MultiPolygon'
      ? feature.geometry.coordinates
      : feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates] : [];
    return coordinates.map((polygon) => polygon.map((ring) => ring.map(([lon, lat]) => project(lon, lat))));
  });
  assert(polygons.length, 'Locked DataSF file contains no usable polygons');
  let nearest = null;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const result = distanceToSegment(CARD04, ring[index], ring[index + 1]);
        if (!nearest || result.distanceM < nearest.distanceM) nearest = { ...result, a: ring[index], b: ring[index + 1] };
      }
    }
  }
  const sourceLand = polygons.some(([outer, ...holes]) => pointInRing(CARD04, outer) && !holes.some((hole) => pointInRing(CARD04, hole)));
  return {
    card04SourceLand: sourceLand,
    nearestRawDataSfSegment: {
      distanceM: rounded(nearest.distanceM),
      closestLocalMetres: { x: rounded(nearest.closest.x), z: rounded(nearest.closest.z) },
      aLocalMetres: { x: rounded(nearest.a.x), z: rounded(nearest.a.z) },
      bLocalMetres: { x: rounded(nearest.b.x), z: rounded(nearest.b.z) },
    },
  };
}

function classFor(tags = {}) {
  if (tags.amenity === 'ferry_terminal' || tags.building === 'terminal') return 'ferry-terminal-footprint';
  if (tags.man_made === 'pier') return 'pier';
  if (tags.man_made === 'seawall' || tags.barrier === 'seawall') return 'seawall';
  if (tags.seamark?.includes('boat') || tags.boat === 'yes') return 'boat';
  return null;
}

async function scanPbf(onItems) {
  await new Promise((resolve, reject) => {
    fs.createReadStream(PBF_PATH)
      .pipe(parse())
      .pipe(through.obj((items, _encoding, callback) => {
        try { onItems(items); callback(); } catch (error) { callback(error); }
      }))
      .on('finish', resolve)
      .on('error', reject);
  });
}

async function osmAudit() {
  const nodes = new Map();
  const boatNodes = [];
  await scanPbf((items) => {
    for (const item of items) {
      if (item.type !== 'node') continue;
      const local = project(item.lon, item.lat);
      if (!inBuffer(local)) continue;
      nodes.set(item.id, { ...local, lon: item.lon, lat: item.lat });
      if (classFor(item.tags) === 'boat') boatNodes.push({ id: item.id, tags: item.tags });
    }
  });
  const candidates = [];
  const incomplete = [];
  await scanPbf((items) => {
    for (const item of items) {
      if (item.type !== 'way') continue;
      const category = classFor(item.tags);
      if (!category || !item.refs.some((ref) => nodes.has(ref))) continue;
      const points = item.refs.map((ref) => nodes.get(ref));
      if (points.some((point) => !point)) {
        incomplete.push({ id: item.id, category });
        continue;
      }
      const nearestM = Math.min(...points.map((point) => Math.hypot(point.x - CARD04.x, point.z - CARD04.z)));
      const bounds = points.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x), minZ: Math.min(result.minZ, point.z),
        maxX: Math.max(result.maxX, point.x), maxZ: Math.max(result.maxZ, point.z),
      }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
      candidates.push({
        id: item.id,
        category,
        tags: Object.fromEntries(Object.entries(item.tags || {}).sort(([a], [b]) => a.localeCompare(b))),
        closed: item.refs[0] === item.refs.at(-1),
        nodeCount: points.length,
        nearestCard04VertexM: rounded(nearestM),
        localBoundsMetres: Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, rounded(value)])),
      });
    }
  });
  candidates.sort((a, b) => a.category.localeCompare(b.category) || a.nearestCard04VertexM - b.nearestCard04VertexM || a.id - b.id);
  return {
    completePhysicalWays: candidates,
    categoryCounts: Object.fromEntries(['ferry-terminal-footprint', 'pier', 'seawall', 'boat'].map((category) => [category, candidates.filter((record) => record.category === category).length])),
    sourceTaggedBoatNodes: boatNodes,
    incompletePhysicalWaysExcluded: incomplete,
  };
}

const [pbfBytes, shorelineBytes, osmLockBytes, shorelineLockBytes] = await Promise.all([
  readFile(PBF_PATH), readFile(SHORELINE_PATH), readFile(OSM_LOCK_PATH), readFile(SHORELINE_LOCK_PATH),
]);
const osmLock = JSON.parse(osmLockBytes);
const shorelineLock = JSON.parse(shorelineLockBytes);
assert.equal(sha256(pbfBytes), osmLock.source.snapshot.sha256, 'Raw PBF digest does not match the OSM source lock');
assert.equal(pbfBytes.length, osmLock.source.snapshot.bytes, 'Raw PBF byte count does not match the OSM source lock');
assert.equal(sha256(shorelineBytes), shorelineLock.source.snapshot.sha256, 'DataSF shoreline digest does not match its source lock');
assert.equal(shorelineBytes.length, shorelineLock.source.snapshot.bytes, 'DataSF shoreline byte count does not match its source lock');

const shoreline = shorelineAudit(JSON.parse(shorelineBytes));
const osm = await osmAudit();
assert.equal(shoreline.card04SourceLand, true, 'Card04 must remain raw DataSF source land');
assert(osm.completePhysicalWays.some(({ id, category }) => id === 558731934 && category === 'ferry-terminal-footprint'), 'The local raw PBF must retain Ferry Building terminal way/558731934');
assert(osm.completePhysicalWays.some(({ id, category }) => id === 661723975 && category === 'pier'), 'The local raw PBF must retain nearby pier way/661723975');
assert.equal(osm.categoryCounts.seawall, 0, 'Do not imply a source-tagged seawall where the locked PBF has none in the hero buffer');
assert.equal(osm.categoryCounts.boat, 0, 'Do not imply a source-tagged boat way where the locked PBF has none in the hero buffer');
assert.equal(osm.sourceTaggedBoatNodes.length, 0, 'Do not imply a source-tagged boat node where the locked PBF has none in the hero buffer');

console.log(JSON.stringify({
  result: 'passed',
  scope: 'bounded Card04 locked-source audit; no runtime placement or mesh authorization',
  card04LocalMetres: CARD04,
  heroBufferLocalMetres: HERO_BUFFER,
  provenance: {
    osm: { lock: path.relative(ROOT, OSM_LOCK_PATH), sha256: sha256(pbfBytes), bytes: pbfBytes.length },
    shoreline: { lock: path.relative(ROOT, SHORELINE_LOCK_PATH), sha256: sha256(shorelineBytes), bytes: shorelineBytes.length },
  },
  shoreline,
  osm,
  presentationLimits: [
    'DataSF supplies a horizontal shoreline only; it does not identify a seawall, pier height, bathymetry, tide, or water surface.',
    'OSM terminal and pier records support only their tagged horizontal outlines; this audit supplies no elevation, collision, navigation, boat placement, or runtime linkage.',
    'No source-tagged seawall or boat object was found in the Card04 hero buffer, so none may be presented from this audit.',
  ],
}, null, 2));
