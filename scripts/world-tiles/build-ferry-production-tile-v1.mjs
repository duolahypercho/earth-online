/**
 * Deterministically bake the first native UTM SF production tile.
 *
 * The geometry is emitted as standards-compliant GLB with Three.js axes
 * (x=east, y=up, z=north). OSM is used only for two-dimensional plan geometry;
 * every height is sampled from the byte-locked USGS 3DEP GeoTIFF.
 *
 * Usage: node scripts/world-tiles/build-ferry-production-tile-v1.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import parse from 'osm-pbf-parser';
import through from 'through2';
import { ShapeUtils, Vector2 } from 'three';
import { openGeoTiffWindowReader } from './geotiff-window-reader-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PBF_PATH = path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf');
const TERRAIN_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const HORIZONTAL_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json');
const GEOMETRY_AUTH_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-osm-horizontal-geometry-v1.lock.json');
const ELEVATION_AUTH_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-terrain-elevation-authorized-v1.lock.json');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'public/data/world/production-artifacts/ferry-production-tile-v1');
const TILE = Object.freeze({ id: 'epsg26910-1441-10893', minE: 553344, minN: 4182912, size: 384, originH: 0, sourceBuffer: 16 });
const TERRAIN_STEP = 1;
const PROVISIONAL_FRAME = 'provisional-utm-source-declared-navd88-unrealized';
const RETRIEVED_AT = '2026-08-02';
const ROAD_LIFT = 0.035;
const PBF_SHA256 = 'dda3821dd92f8d8bf34abe503ac81f20a439ee02a210a9d68d2c7c5d66fb0cae';
const RASTER_SHA256 = '9cc9c03f4ddaf8ec6712951b980157ea02293c7723761466e6e60f21147a9424';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const stableBytes = (value) => Buffer.from(JSON.stringify(value));
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const q = (value) => Math.round(value * 1e6) / 1e6;
const sortedTags = (tags = {}) => Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)));

async function sha256File(filePath) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filePath)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

async function scanPbf(onItems) {
  await new Promise((resolve, reject) => fs.createReadStream(PBF_PATH).pipe(parse()).pipe(through.obj((items, _encoding, callback) => {
    try { onItems(items); callback(); } catch (error) { callback(error); }
  })).on('finish', resolve).on('error', reject));
}

function forward(lonDegrees, latDegrees, lock) {
  const projection = lock.claims.operation.authorityPath[1];
  const p = projection.parameters; const { semiMajorAxisMetres: a, inverseFlattening } = projection.ellipsoidFromEpsg4269;
  const f = 1 / inverseFlattening; const e2 = f * (2 - f); const ep2 = e2 / (1 - e2); const radians = Math.PI / 180;
  const phi = latDegrees * radians; const lon0 = p.longitudeOfNaturalOriginDegrees * radians;
  const sin = Math.sin(phi); const cos = Math.cos(phi); const tan = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * sin ** 2); const t = tan ** 2; const c = ep2 * cos ** 2; const aa = cos * (lonDegrees * radians - lon0);
  const m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  return [p.falseEastingMetres + p.scaleFactor * n * (aa + (1 - t + c) * aa ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120),
    p.falseNorthingMetres + p.scaleFactor * (m + n * tan * (aa ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720))];
}

function inverse(easting, northing, lock) {
  const projection = lock.claims.operation.authorityPath[1]; const p = projection.parameters;
  const { semiMajorAxisMetres: a, inverseFlattening } = projection.ellipsoidFromEpsg4269;
  const f = 1 / inverseFlattening; const e2 = f * (2 - f); const ep2 = e2 / (1 - e2); const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const m = (northing - p.falseNorthingMetres) / p.scaleFactor; const mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + 151 * e1 ** 3 / 96 * Math.sin(6 * mu) + 1097 * e1 ** 4 / 512 * Math.sin(8 * mu);
  const sin = Math.sin(phi1); const cos = Math.cos(phi1); const tan = Math.tan(phi1); const n1 = a / Math.sqrt(1 - e2 * sin ** 2); const r1 = a * (1 - e2) / (1 - e2 * sin ** 2) ** 1.5;
  const t1 = tan ** 2; const c1 = ep2 * cos ** 2; const d = (easting - p.falseEastingMetres) / (n1 * p.scaleFactor);
  const lat = phi1 - n1 * tan / r1 * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24 + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720);
  const lon = p.longitudeOfNaturalOriginDegrees * Math.PI / 180 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / cos;
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

async function readOsmFeatures(horizontalLock) {
  const corners = [[TILE.minE - TILE.sourceBuffer, TILE.minN - TILE.sourceBuffer], [TILE.minE + TILE.size + TILE.sourceBuffer, TILE.minN + TILE.size + TILE.sourceBuffer]].map(([e, n]) => inverse(e, n, horizontalLock));
  const bounds = { west: Math.min(...corners.map((v) => v[0])), east: Math.max(...corners.map((v) => v[0])), south: Math.min(...corners.map((v) => v[1])), north: Math.max(...corners.map((v) => v[1])) };
  const nearbyNodeIds = new Set();
  await scanPbf((items) => { for (const item of items) if (item.type === 'node' && item.lon >= bounds.west && item.lon <= bounds.east && item.lat >= bounds.south && item.lat <= bounds.north) nearbyNodeIds.add(item.id); });
  const ways = new Map(); const requiredNodeIds = new Set();
  await scanPbf((items) => { for (const item of items) {
    if (item.type !== 'way' || (!item.tags?.highway && !item.tags?.building) || !item.refs.some((id) => nearbyNodeIds.has(id))) continue;
    ways.set(item.id, { id: item.id, tags: sortedTags(item.tags), refs: [...item.refs] }); for (const id of item.refs) requiredNodeIds.add(id);
  } });
  const nodes = new Map();
  await scanPbf((items) => { for (const item of items) if (item.type === 'node' && requiredNodeIds.has(item.id)) nodes.set(item.id, { lon: item.lon, lat: item.lat }); });
  assert.equal(nodes.size, requiredNodeIds.size, 'Selected OSM way has an unresolved node');
  const features = [...ways.values()].map((way) => ({ ...way, en: way.refs.map((id) => forward(nodes.get(id).lon, nodes.get(id).lat, horizontalLock)), lonLat: way.refs.map((id) => [nodes.get(id).lon, nodes.get(id).lat]) }))
    .filter((way) => way.en.some(([e, n]) => e >= TILE.minE - TILE.sourceBuffer && e <= TILE.minE + TILE.size + TILE.sourceBuffer && n >= TILE.minN - TILE.sourceBuffer && n <= TILE.minN + TILE.size + TILE.sourceBuffer))
    .sort((a, b) => a.id - b.id);
  return { bounds, features };
}

async function openTerrain(sourceLock) {
  const rawPath = path.join(ROOT, sourceLock.raster.localRawCache); const raw = await sha256File(rawPath);
  assert.equal(raw.sha256, sourceLock.raster.sha256, 'GeoTIFF hash does not match lock'); assert.equal((await stat(rawPath)).size, sourceLock.raster.bytes);
  const reader = await openGeoTiffWindowReader(rawPath); const a = reader.modelToPixel(TILE.minE - TILE.sourceBuffer - 2, TILE.minN + TILE.size + TILE.sourceBuffer + 2); const b = reader.modelToPixel(TILE.minE + TILE.size + TILE.sourceBuffer + 2, TILE.minN - TILE.sourceBuffer - 2);
  const column = Math.floor(a.column); const row = Math.floor(a.row); const right = Math.ceil(b.column) + 1; const bottom = Math.ceil(b.row) + 1;
  const window = await reader.readWindow({ column, row, width: right - column, height: bottom - row });
  const pixelWindow = (e, n) => { const pixel = reader.modelToPixel(e, n); return { column: Math.floor(pixel.column), row: Math.floor(pixel.row), width: 1, height: 1 }; };
  const sample = (e, n) => { const pixel = pixelWindow(e, n); const x = pixel.column - window.column; const y = pixel.row - window.row; assert(x >= 0 && y >= 0 && x < window.width && y < window.height, 'Terrain sample outside buffered window'); const value = window.values[y * window.width + x]; assert(value !== window.nodata && Number.isFinite(value), 'Invalid terrain sample'); return value; };
  const evidence = async (e, n) => { const nativePixelWindow = pixelWindow(e, n); const direct = await reader.readWindow(nativePixelWindow); const value = direct.values[0]; const bytes = Buffer.allocUnsafe(4); bytes.writeFloatLE(value); return { rasterSha256: RASTER_SHA256, nativePixelWindow, compressedTileIndices: direct.tileIndices, compressedTileBytesRead: direct.bytesRead, sampleMethod: 'direct-native-pixel-float32-le', sampledSourceDeclaredNavd88UnrealizedMetres: value, sampleWindowSha256: `sha256:${sha256(bytes)}` }; };
  return { reader, window, sample, evidence, raw };
}

function category() { return { positions: [], indices: [], sourceIds: new Set() }; }
function vertex(target, e, h, n) { target.positions.push(q(e - TILE.minE), q(h - TILE.originH), q(n - TILE.minN)); return target.positions.length / 3 - 1; }
function triangle(target, a, b, c) { target.indices.push(a, b, c); }
function inside([e, n]) { return e >= TILE.minE && e <= TILE.minE + TILE.size && n >= TILE.minN && n <= TILE.minN + TILE.size; }

function clipSegment(a, b) {
  let t0 = 0; let t1 = 1; const dx = b[0] - a[0]; const dy = b[1] - a[1];
  for (const [p, qv] of [[-dx, a[0] - TILE.minE], [dx, TILE.minE + TILE.size - a[0]], [-dy, a[1] - TILE.minN], [dy, TILE.minN + TILE.size - a[1]]]) {
    if (p === 0 && qv < 0) return null; if (p === 0) continue; const r = qv / p; if (p < 0) { if (r > t1) return null; t0 = Math.max(t0, r); } else { if (r < t0) return null; t1 = Math.min(t1, r); }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

function clipPolygon(points) {
  let output = points.slice();
  const edges = [([e]) => e >= TILE.minE, ([e]) => e <= TILE.minE + TILE.size, (([, n]) => n >= TILE.minN), (([, n]) => n <= TILE.minN + TILE.size)];
  const intersect = (a, b, edge) => {
    if (edge === 0 || edge === 1) { const x = edge === 0 ? TILE.minE : TILE.minE + TILE.size; const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + t * (b[1] - a[1])]; }
    const y = edge === 2 ? TILE.minN : TILE.minN + TILE.size; const t = (y - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y];
  };
  for (let edge = 0; edge < 4; edge += 1) { const input = output; output = []; if (!input.length) break; let a = input.at(-1);
    for (const b of input) { if (edges[edge](b)) { if (!edges[edge](a)) output.push(intersect(a, b, edge)); output.push(b); } else if (edges[edge](a)) output.push(intersect(a, b, edge)); a = b; }
  }
  return output;
}

function roadWidth(tags) {
  const explicit = Number.parseFloat(tags.width); if (Number.isFinite(explicit) && explicit > 0 && explicit < 60) return explicit;
  const lanes = Number.parseInt(tags.lanes, 10); const base = { motorway: 24, trunk: 18, primary: 14, secondary: 11, tertiary: 9, residential: 7, service: 5, pedestrian: 5, footway: 2.2, path: 1.8, cycleway: 2.2, steps: 2.2 }[tags.highway] ?? 5;
  return Number.isFinite(lanes) ? Math.max(base, lanes * 3.2) : base;
}

function buildingHeight(tags) {
  const height = Number.parseFloat(tags.height); if (Number.isFinite(height) && height >= 2 && height <= 500) return height;
  const levels = Number.parseFloat(tags['building:levels']); return Number.isFinite(levels) && levels > 0 ? Math.min(500, levels * 3.2) : 9.6;
}

function bakeGeometry(features, sample) {
  const terrain = category(); const roads = category(); const buildings = category();
  const side = TILE.size / TERRAIN_STEP + 1;
  for (let z = 0; z < side; z += 1) for (let x = 0; x < side; x += 1) vertex(terrain, TILE.minE + x * TERRAIN_STEP, sample(TILE.minE + x * TERRAIN_STEP, TILE.minN + z * TERRAIN_STEP), TILE.minN + z * TERRAIN_STEP);
  for (let z = 0; z < side - 1; z += 1) for (let x = 0; x < side - 1; x += 1) { const a = z * side + x; triangle(terrain, a, a + side, a + 1); triangle(terrain, a + 1, a + side, a + side + 1); }
  for (const way of features.filter((item) => item.tags.highway)) {
    let emitted = false; const half = roadWidth(way.tags) / 2;
    for (let i = 0; i < way.en.length - 1; i += 1) { const clipped = clipSegment(way.en[i], way.en[i + 1]); if (!clipped) continue; const [a, b] = clipped; const length = Math.hypot(b[0] - a[0], b[1] - a[1]); if (length < 0.05) continue;
      const ox = -(b[1] - a[1]) / length * half; const oz = (b[0] - a[0]) / length * half; const corners = [[a[0] + ox, a[1] + oz], [a[0] - ox, a[1] - oz], [b[0] + ox, b[1] + oz], [b[0] - ox, b[1] - oz]].map(([e, n]) => [Math.max(TILE.minE, Math.min(TILE.minE + TILE.size, e)), Math.max(TILE.minN, Math.min(TILE.minN + TILE.size, n))]);
      const base = roads.positions.length / 3; for (const [e, n] of corners) vertex(roads, e, sample(e, n) + ROAD_LIFT, n); triangle(roads, base, base + 1, base + 2); triangle(roads, base + 2, base + 1, base + 3); emitted = true;
    } if (emitted) roads.sourceIds.add(way.id);
  }
  for (const way of features.filter((item) => item.tags.building && item.refs[0] === item.refs.at(-1))) {
    const ring = clipPolygon(way.en.slice(0, -1)); if (ring.length < 3) continue; const faces = ShapeUtils.triangulateShape(ring.map(([e, n]) => new Vector2(e, n)), []); if (!faces.length) continue;
    const height = buildingHeight(way.tags); const floor = ring.map(([e, n]) => sample(e, n)); const bottom = []; const top = [];
    for (let i = 0; i < ring.length; i += 1) { bottom.push(vertex(buildings, ring[i][0], floor[i], ring[i][1])); top.push(vertex(buildings, ring[i][0], floor[i] + height, ring[i][1])); }
    for (const face of faces) { triangle(buildings, top[face[0]], top[face[2]], top[face[1]]); }
    for (let i = 0; i < ring.length; i += 1) { const j = (i + 1) % ring.length; triangle(buildings, bottom[i], bottom[j], top[i]); triangle(buildings, top[i], bottom[j], top[j]); }
    buildings.sourceIds.add(way.id);
  }
  assert(buildings.sourceIds.has(558731934), 'Ferry Building OSM way 558731934 was not baked');
  return { terrain, roads, buildings };
}

function geometryBounds(categories) {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (const data of Object.values(categories)) for (let index = 0; index < data.positions.length; index += 3) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], data.positions[index + axis]); max[axis] = Math.max(max[axis], data.positions[index + axis]); }
  return { min, max };
}

function makeGlb(categories, level) {
  const names = ['terrain', 'roads', 'buildings']; const chunks = []; const bufferViews = []; const accessors = []; const primitives = [];
  let offset = 0; const pad = () => { const count = (4 - offset % 4) % 4; if (count) { chunks.push(Buffer.alloc(count)); offset += count; } };
  const addView = (bytes, target) => { pad(); const index = bufferViews.length; bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target }); chunks.push(bytes); offset += bytes.length; return index; };
  for (let material = 0; material < names.length; material += 1) { const data = categories[names[material]]; const positions = Buffer.alloc(data.positions.length * 4); data.positions.forEach((v, i) => positions.writeFloatLE(v, i * 4)); const indices = Buffer.alloc(data.indices.length * 4); data.indices.forEach((v, i) => indices.writeUInt32LE(v, i * 4));
    const positionView = addView(positions, 34962); const indexView = addView(indices, 34963); const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < data.positions.length; index += 3) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], data.positions[index + axis]); max[axis] = Math.max(max[axis], data.positions[index + axis]); }
    const positionAccessor = accessors.length; accessors.push({ bufferView: positionView, componentType: 5126, count: data.positions.length / 3, type: 'VEC3', min, max });
    const indexAccessor = accessors.length; accessors.push({ bufferView: indexView, componentType: 5125, count: data.indices.length, type: 'SCALAR', min: [0], max: [data.positions.length / 3 - 1] });
    primitives.push({ attributes: { POSITION: positionAccessor }, indices: indexAccessor, material, mode: 4, extras: { category: names[material], sourceOsmWayIds: [...data.sourceIds].sort((a, b) => a - b) } });
  }
  pad(); const bin = Buffer.concat(chunks); const gltf = { asset: { version: '2.0', generator: 'build-ferry-production-tile-v1' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: `${TILE.id}-lod${level}` }], meshes: [{ name: `ferry-production-tile-lod${level}`, primitives }], materials: [
    { name: 'terrain-night', pbrMetallicRoughness: { baseColorFactor: [0.055, 0.075, 0.085, 1], metallicFactor: 0, roughnessFactor: 1 } },
    { name: 'roads-night', pbrMetallicRoughness: { baseColorFactor: [0.105, 0.12, 0.135, 1], metallicFactor: 0, roughnessFactor: 0.92 } },
    { name: 'buildings-night', pbrMetallicRoughness: { baseColorFactor: [0.34, 0.28, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.86 } },
  ], buffers: [{ byteLength: bin.length }], bufferViews, accessors, extras: { tileId: TILE.id, lod: level, runtimeFrame: PROVISIONAL_FRAME, horizontalCrs: 'EPSG:26910', verticalCertification: 'source-declared-navd88-unrealized', tileOriginEpsg26910VerticalMetres: [TILE.minE, TILE.minN, TILE.originH], originTupleOrder: ['easting', 'northing', 'vertical'], vertexAxes: { x: 'eastMinusOriginEasting', y: 'verticalMinusOriginVertical', z: 'northMinusOriginNorthing' }, unitsPerMetre: 1 } };
  let json = Buffer.from(JSON.stringify(gltf)); const jsonPad = (4 - json.length % 4) % 4; if (jsonPad) json = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]); const total = 12 + 8 + json.length + 8 + bin.length; const out = Buffer.alloc(total); out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8); out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20); const at = 20 + json.length; out.writeUInt32LE(bin.length, at); out.writeUInt32LE(0x004e4942, at + 4); bin.copy(out, at + 8); return out;
}

function centroid(points) { const unique = points.at(0)[0] === points.at(-1)[0] && points.at(0)[1] === points.at(-1)[1] ? points.slice(0, -1) : points; return [unique.reduce((s, p) => s + p[0], 0) / unique.length, unique.reduce((s, p) => s + p[1], 0) / unique.length]; }

function representativeEn(feature) {
  if (feature.tags.building) {
    const ring = clipPolygon(feature.en.slice(0, feature.refs[0] === feature.refs.at(-1) ? -1 : undefined));
    if (ring.length >= 3) return centroid(ring);
  }
  const points = [];
  for (let index = 0; index < feature.en.length - 1; index += 1) { const segment = clipSegment(feature.en[index], feature.en[index + 1]); if (segment) points.push(...segment); }
  assert(points.length, `Emitted OSM way ${feature.id} has no in-tile representative point`);
  return centroid(points);
}

export async function buildFerryProductionTile({ outputDir = DEFAULT_OUTPUT_DIR, write = true, finalizeDescriptor = false } = {}) {
  const [pbfHash, terrainLockBytes, horizontalLockBytes, geometryAuthBytes, elevationAuthBytes] = await Promise.all([sha256File(PBF_PATH), readFile(TERRAIN_LOCK_PATH), readFile(HORIZONTAL_LOCK_PATH), readFile(GEOMETRY_AUTH_PATH), readFile(ELEVATION_AUTH_PATH)]);
  assert.equal(pbfHash.sha256, PBF_SHA256, 'OSM PBF hash mismatch'); const terrainLock = JSON.parse(terrainLockBytes); const horizontalLock = JSON.parse(horizontalLockBytes);
  const { bounds, features } = await readOsmFeatures(horizontalLock); const terrainSource = await openTerrain(terrainLock);
  try {
    const baseGeometry = bakeGeometry(features, terrainSource.sample); const geometries = [baseGeometry]; const categories = baseGeometry;
    const included = features.filter((feature) => (feature.tags.highway && categories.roads.sourceIds.has(feature.id)) || (feature.tags.building && categories.buildings.sourceIds.has(feature.id)));
    const glbs = geometries.map((geometry, level) => ({ level, name: `ferry-production-tile-v1.lod${level}.glb`, bytes: makeGlb(geometry, level), geometry }));
    const lods = glbs.map(({ level, bytes, name, geometry }) => ({ level, runtimeFrame: PROVISIONAL_FRAME, scale: [1, 1, 1], translationMetres: [0, 0, 0], maxHorizontalDeviationMetres: level < 2 ? 0.000002 : 0, maxVerticalDeviationMetres: level < 2 ? 0.000002 : 0, artifactHash: `sha256:${sha256(bytes)}`, path: `${relative(outputDir)}/${name}`, bytes: bytes.length, boundsLocalMetres: geometryBounds(geometry), meshStats: Object.fromEntries(Object.entries(geometry).map(([categoryName, data]) => [categoryName, { vertices: data.positions.length / 3, indices: data.indices.length, triangles: data.indices.length / 3, sourceOsmWayCount: data.sourceIds.size }])) }));
    const sourceFeatures = [];
    for (const feature of included) { const en = representativeEn(feature); const native = inverse(en[0], en[1], horizontalLock); const evidencePayload = await terrainSource.evidence(en[0], en[1]); const elevationSampleEvidence = { ...evidencePayload, evidenceSha256: `sha256:${sha256(stableBytes(evidencePayload))}` }; const height = elevationSampleEvidence.sampledSourceDeclaredNavd88UnrealizedMetres;
      sourceFeatures.push({ sourceId: 'bbbike-sanfrancisco-osm-pbf', sourceFeatureId: `way/${feature.id}`, publisher: 'OpenStreetMap contributors; BBBike extract service', license: 'ODbL-1.0', retrievedAt: RETRIEVED_AT, nativeHorizontalCrs: 'EPSG:4326', nativeVerticalDatum: 'not-provided-by-2d-source', sourceLockId: 'sf-ferry-osm-horizontal-geometry-v1', horizontalTransformLockId: 'sf-ferry-3dep-2023-horizontal-crs-v1', verticalMode: 'terrain-sampled-source-declared-navd88-unrealized', verticalTransformLockId: 'terrain-sample-source-declared-navd88-unrealized', elevationSourceLockId: 'sf-ferry-3dep-terrain-elevation-authorized-v1', elevationSampleEvidence, sourceGeometryHash: `sha256:${sha256(stableBytes({ type: 'way', id: feature.id, tags: feature.tags, nodeIds: feature.refs, coordinatesLonLat: feature.lonLat.map(([lon, lat]) => [q(lon), q(lat)]) }))}`, nativeHorizontalPosition: [q(native[0]), q(native[1]), 0], transformedPositionEpsg26910VerticalMetres: [q(en[0]), q(en[1]), height], runtimePositionMetres: [q(en[0] - TILE.minE), q(height - TILE.originH), q(en[1] - TILE.minN)] });
    }
    const packageDescriptor = { schemaVersion: 1, kind: 'sf-one-to-one-map-package', status: 'provisional-vertical-unrealized', contractId: 'sf-one-to-one-reality-v1', coordinateReference: { horizontal: { crs: 'EPSG:26910', unit: 'metre' }, vertical: { datum: 'source-declared-navd88-unrealized', unit: 'metre' }, runtimeFrame: PROVISIONAL_FRAME }, verticalCertification: 'source-declared-navd88-unrealized', runtimeAxes: { x: 'east', y: 'up', z: 'north' }, scale: { runtimeUnitsPerMetre: 1, horizontalScale: 1, verticalScale: 1, verticalExaggeration: 0 }, tiling: { scheme: 'rectilinear-utm', tileSizeMetres: 384, sourceBufferMetres: 16 }, tileOriginEpsg26910VerticalMetres: [TILE.minE, TILE.minN, TILE.originH], authorizedHorizontalTransform: { id: 'sf-ferry-3dep-2023-horizontal-crs-v1', path: ['EPSG:1188-inverse', 'EPSG:26910-projection'], absoluteHorizontalAccuracyFloorMetres: 4, nad83Realization: 'not-claimed', coordinateEpoch: 'not-claimed' }, accuracyQualification: { absoluteHorizontalAccuracyFloorMetres: 4, nad83Realization: 'not-claimed', coordinateEpoch: 'not-claimed', lodErrorIsRelativeToTransformedSource: true }, sourceLocks: [
      { id: 'sf-ferry-osm-horizontal-geometry-v1', path: relative(GEOMETRY_AUTH_PATH), sha256: sha256(geometryAuthBytes), purpose: 'geometry' }, { id: 'sf-ferry-3dep-2023-horizontal-crs-v1', path: relative(HORIZONTAL_LOCK_PATH), sha256: sha256(horizontalLockBytes), purpose: 'horizontal-coordinate-operation' }, { id: 'sf-ferry-3dep-terrain-elevation-authorized-v1', path: relative(ELEVATION_AUTH_PATH), sha256: sha256(elevationAuthBytes), purpose: 'terrain-elevation' },
    ], sourceFeatures, lods: lods.map(({ path: _path, bytes: _bytes, boundsLocalMetres: _bounds, meshStats: _stats, ...lod }) => lod) };
    const receipt = { schemaVersion: 1, kind: 'ferry-production-tile-build-receipt', id: 'ferry-production-tile-v1', status: 'provisional-vertical-unrealized', tile: { identity: TILE.id, gridIndex: [TILE.minE / TILE.size, TILE.minN / TILE.size], boundsEpsg26910Metres: [TILE.minE, TILE.minN, TILE.minE + TILE.size, TILE.minN + TILE.size], originEpsg26910VerticalMetres: [TILE.minE, TILE.minN, TILE.originH], originTupleOrder: ['easting', 'northing', 'vertical'], runtimeFrame: PROVISIONAL_FRAME, vertexAxes: { x: 'eastMinusOriginEasting', y: 'verticalMinusOriginVertical', z: 'northMinusOriginNorthing' }, scale: 1 }, source: { osmPbf: { path: relative(PBF_PATH), bytes: pbfHash.bytes, sha256: pbfHash.sha256, queryBoundsWgs84: bounds }, geoTiff: { path: terrainLock.raster.localRawCache, bytes: terrainSource.raw.bytes, sha256: terrainSource.raw.sha256, verticalCertification: 'source-declared-navd88-unrealized', reader: 'geotiff-window-reader-v1', window: { column: terrainSource.window.column, row: terrainSource.window.row, width: terrainSource.window.width, height: terrainSource.window.height } } }, counts: { osmCandidateWays: features.length, emittedRoadWays: categories.roads.sourceIds.size, emittedBuildingWays: categories.buildings.sourceIds.size, packageSourceFeatures: sourceFeatures.length, terrainVertices: categories.terrain.positions.length / 3, roadVertices: categories.roads.positions.length / 3, buildingVertices: categories.buildings.positions.length / 3 }, ferryBuilding: { sourceFeatureId: 'way/558731934', present: categories.buildings.sourceIds.has(558731934) }, lods, relationCoverage: { implemented: false, statement: 'This first tile bakes tagged closed building ways and highway ways only; unassembled OSM multipolygon relations are not represented or claimed as coverage.' }, deterministicInputs: { availableLods: [0], terrainGridStepMetres: TERRAIN_STEP, terrainSampling: 'direct-native-pixel-float32-le', lod0Construction: 'native 1 m indexed terrain plus merged OSM road and building primitives', lod0DeviationMetres: 0, geometryQuantizationDecimalPlaces: 6, buildingHeightPolicy: 'OSM height, else building:levels*3.2m, else 9.6m', roadWidthPolicy: 'OSM width, else deterministic highway-class/lanes table' } };
    if (write) { await mkdir(outputDir, { recursive: true }); await Promise.all([rm(path.join(outputDir, 'ferry-production-tile-v1.lod1.glb'), { force: true }), rm(path.join(outputDir, 'ferry-production-tile-v1.lod2.glb'), { force: true })]); await Promise.all([...glbs.map((glb) => writeFile(path.join(outputDir, glb.name), glb.bytes)), writeFile(path.join(outputDir, 'ferry-production-tile-v1.receipt.json'), jsonBytes(receipt)), writeFile(path.join(outputDir, 'ferry-production-tile-v1.package.json'), jsonBytes(packageDescriptor))]); }
    return { outputDir, glbs, receipt, packageDescriptor, categories };
  } finally { await terrainSource.reader.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const finalizeDescriptor = process.argv.includes('--finalize-descriptor'); const result = await buildFerryProductionTile({ finalizeDescriptor });
  process.stdout.write(`${JSON.stringify({ result: 'Ferry production tile baked', tile: result.receipt.tile, status: result.receipt.status, counts: result.receipt.counts, lods: result.receipt.lods.map(({ level, artifactHash, path: artifactPath }) => ({ level, artifactHash, path: artifactPath })) }, null, 2)}\n`);
}
