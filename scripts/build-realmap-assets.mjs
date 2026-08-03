import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  createStreetDesign,
  streetDesignToMapMeta,
} from '../src/realmap/street-design.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'sf');
const ATLAS_PATH = path.join(OUT_DIR, 'sf-atlas.json');
const SHORELINE_PATH = process.env.SF_SHORELINE
  || path.join(OUT_DIR, 'sf-shoreline.geojson');
const SHORELINE_URL = process.env.SF_SHORELINE_URL
  || 'https://data.sfgov.org/api/geospatial/txuc-3kzm?method=export&format=GeoJSON';
const OUTPUT_PATH = path.join(OUT_DIR, 'sf-city.json');

const CENTER = { lat: 37.778, lon: -122.4194 };
const METERS_PER_DEG_LAT = 110574;
const METERS_PER_DEG_LON = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);

function project(lat, lon) {
  return {
    x: (lon - CENTER.lon) * METERS_PER_DEG_LON,
    z: (lat - CENTER.lat) * METERS_PER_DEG_LAT,
  };
}

function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.z - a.z;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dy));
}

function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDistance = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = pointToSegmentDistance(points[i], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance <= tolerance) return [first, last];
  const left = simplify(points.slice(0, index + 1), tolerance);
  const right = simplify(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

function ringArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area / 2);
}

function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function flatPoints(points) {
  const output = [];
  for (const point of points) {
    output.push(round1(point.x), round1(point.z));
  }
  return output;
}

function pointInsideBoundary(point, rings) {
  return rings.some((ring) => pointInPolygon(point, ring));
}

function polylineInsideBoundary(points, rings) {
  return points.some((point) => pointInsideBoundary(point, rings));
}

async function ensureShoreline() {
  if (fs.existsSync(SHORELINE_PATH)) {
    console.log('Using existing shoreline:', SHORELINE_PATH);
    return;
  }
  console.log(`Downloading SF shoreline from ${SHORELINE_URL}`);
  const response = await fetch(SHORELINE_URL);
  if (!response.ok) {
    throw new Error(`Shoreline download failed: ${response.status} ${response.statusText}`);
  }
  fs.mkdirSync(path.dirname(SHORELINE_PATH), { recursive: true });
  fs.writeFileSync(SHORELINE_PATH, Buffer.from(await response.arrayBuffer()));
}

function digestFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
  await ensureShoreline();
  if (!fs.existsSync(ATLAS_PATH)) {
    throw new Error(`Missing atlas. Run scripts/build-sf-atlas.mjs first: ${ATLAS_PATH}`);
  }

  const atlas = JSON.parse(fs.readFileSync(ATLAS_PATH, 'utf8'));
  const shoreline = JSON.parse(fs.readFileSync(SHORELINE_PATH, 'utf8'));

  const boundaryRings = [];
  for (const feature of shoreline.features ?? []) {
    const geometry = feature.geometry;
    const polygons = geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
    for (const polygon of polygons) {
      for (const rawRing of polygon) {
        const ring = rawRing.map(([lon, lat]) => project(lat, lon));
        const simplified = simplify(ring, 5);
        if (simplified.length >= 4) boundaryRings.push(simplified);
      }
    }
  }
  boundaryRings.sort((a, b) => ringArea(b) - ringArea(a));
  const boundary = boundaryRings.map(flatPoints);

  const cityRoads = [];
  const detailRoads = [];
  for (const road of atlas.roads ?? []) {
    if (!road.points?.length || !polylineInsideBoundary(road.points, boundaryRings)) continue;
    cityRoads.push({
      id: road.id,
      name: road.name || '',
      highway: road.highway || '',
      oneway: Boolean(road.oneway),
      lanes: road.lanes || 1,
      maxspeed: road.maxspeed || '',
      surface: road.surface || '',
      sidewalk: road.sidewalk || '',
      layer: road.layer || '0',
      bridge: Boolean(road.bridge),
      tunnel: Boolean(road.tunnel),
      points: flatPoints(simplify(road.points, 3.2)),
    });
  }
  for (const road of atlas.detailRoads ?? []) {
    if (!road.points?.length || !polylineInsideBoundary(road.points, boundaryRings)) continue;
    detailRoads.push({
      id: road.id,
      name: road.name || '',
      highway: road.highway || '',
      oneway: Boolean(road.oneway),
      lanes: road.lanes || 1,
      maxspeed: road.maxspeed || '',
      surface: road.surface || '',
      sidewalk: road.sidewalk || '',
      layer: road.layer || '0',
      bridge: Boolean(road.bridge),
      tunnel: Boolean(road.tunnel),
      points: flatPoints(road.points),
    });
  }

  // Keep peninsula-wide detail roads, but budget footprint meshes so the
  // browser pack stays downloadable. Prefer named / amenity / taller parcels.
  const DETAIL_BUILDING_CAP = Number(process.env.SF_DETAIL_BUILDING_CAP || 28000);
  const detailCandidates = [];
  for (const building of atlas.detailBuildings ?? []) {
    if (!building.centroid || !pointInsideBoundary(building.centroid, boundaryRings)) continue;
    const name = building.name || '';
    const amenity = building.amenity || '';
    const levels = Math.max(1, Math.round(building.levels || 1));
    const height = Math.round((Number(building.height) || 0) * 10) / 10;
    const area = Math.round(building.area || 0);
    const priority = (name ? 40 : 0)
      + (amenity ? 30 : 0)
      + Math.min(levels, 20)
      + Math.min(height / 4, 25)
      + Math.min(area / 120, 20);
    detailCandidates.push({
      priority,
      record: {
        id: building.id,
        name,
        addr: building.addr || '',
        building: building.building || 'yes',
        amenity,
        levels,
        height,
        area,
        centroid: [round1(building.centroid.x), round1(building.centroid.z)],
        points: flatPoints(building.points || []),
      },
    });
  }
  detailCandidates.sort((left, right) => right.priority - left.priority);
  const detailBuildings = detailCandidates
    .slice(0, DETAIL_BUILDING_CAP)
    .map((entry) => entry.record);
  console.log(`Detail buildings kept ${detailBuildings.length}/${detailCandidates.length} (cap ${DETAIL_BUILDING_CAP})`);

  const coarseBuildings = [];
  for (const building of atlas.buildings ?? []) {
    if (!building.centroid || !pointInsideBoundary(building.centroid, boundaryRings)) continue;
    coarseBuildings.push({
      id: building.id,
      name: building.name || '',
      addr: building.addr || '',
      building: building.building || 'yes',
      amenity: building.amenity || '',
      levels: Math.max(1, Math.round(building.levels || 1)),
      height: Math.round((Number(building.height) || 0) * 10) / 10,
      area: Math.round(building.area || 0),
      centroid: [round1(building.centroid.x), round1(building.centroid.z)],
    });
  }

  const signals = [];
  for (const signal of atlas.signals ?? []) {
    if (signal && pointInsideBoundary(signal, boundaryRings)) {
      signals.push([round1(signal.x), round1(signal.z)]);
    }
  }

  const streetDesign = streetDesignToMapMeta(createStreetDesign());

  const city = {
    meta: {
      generatedAt: new Date().toISOString(),
      center: CENTER,
      projection: atlas.meta.projection,
      boundaryRings: boundary.length,
      detailBBox: atlas.meta?.detailBBox || null,
      /** Street/sidewalk sizing knobs — consumed by realmap Full City */
      streetDesign,
      counts: {
        roads: cityRoads.length,
        detailRoads: detailRoads.length,
        detailBuildings: detailBuildings.length,
        detailBuildingCandidates: detailCandidates.length,
        coarseBuildings: coarseBuildings.length,
        signals: signals.length,
      },
      sources: [
        {
          name: 'OpenStreetMap San Francisco extract (bbbike)',
          license: 'ODbL 1.0',
          licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
          attribution: '© OpenStreetMap contributors',
          url: 'https://download.bbbike.org/osm/bbbike/SanFrancisco/',
          sha256: digestFile(ATLAS_PATH),
        },
        {
          name: 'SF Shoreline and Islands (DataSF)',
          license: 'Open Data Commons PDDL 1.0',
          licenseUrl: 'https://opendatacommons.org/licenses/pddl/1-0/',
          attribution: 'City and County of San Francisco',
          url: SHORELINE_URL,
          sha256: digestFile(SHORELINE_PATH),
        },
      ],
    },
    boundary,
    roads: cityRoads,
    detailRoads,
    detailBuildings,
    coarseBuildings,
    signals,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(city);
  fs.writeFileSync(OUTPUT_PATH, json);
  fs.writeFileSync(`${OUTPUT_PATH}.gz`, zlib.gzipSync(json, { level: 9 }));
  const outputSize = fs.statSync(OUTPUT_PATH).size;
  const gzSize = fs.statSync(`${OUTPUT_PATH}.gz`).size;
  console.log(`Wrote ${OUTPUT_PATH} (${(outputSize / 1024 / 1024).toFixed(2)} MB, gz ${(gzSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(JSON.stringify(city.meta.counts));
}

await main();
