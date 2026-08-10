import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parse from 'osm-pbf-parser';
import through from 'through2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'sf');
const PBF_PATH = process.env.SF_PBF || path.join(ROOT, 'public', 'data', 'sf', 'SanFrancisco.osm.pbf');
const DOWNLOAD_URL = process.env.SF_PBF_URL || 'https://download.bbbike.org/osm/bbbike/SanFrancisco/SanFrancisco.osm.pbf';

const CENTER = { lat: 37.778, lon: -122.4194 };
const METERS_PER_DEG_LAT = 110574;
const METERS_PER_DEG_LON = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);

const CITY_BBOX = {
  minLat: 37.6403,
  maxLat: 37.9297,
  minLon: -123.1738,
  maxLon: -122.2815,
};

// Dense urban peninsula: sidewalk/lane-level detail streams across the real
// street grid (Mission → Marina, Ocean Beach approach → Embarcadero) instead
// of only a NE downtown postage stamp.
const DETAIL_BBOX = {
  minLat: 37.735,
  maxLat: 37.811,
  minLon: -122.515,
  maxLon: -122.365,
};

const ROAD_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'pedestrian',
  'footway',
  'cycleway',
  'path',
]);

function project(lat, lon) {
  return {
    x: (lon - CENTER.lon) * METERS_PER_DEG_LON,
    z: (lat - CENTER.lat) * METERS_PER_DEG_LAT,
  };
}

async function downloadPbf() {
  if (fs.existsSync(PBF_PATH)) return PBF_PATH;
  const temp = `${PBF_PATH}.part`;
  fs.mkdirSync(path.dirname(PBF_PATH), { recursive: true });
  console.log(`Downloading SF OSM extract from ${DOWNLOAD_URL}`);
  const response = await fetch(DOWNLOAD_URL);
  if (!response.ok) throw new Error(`PBF download failed: ${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, PBF_PATH);
  return PBF_PATH;
}

async function readPbf(pbfPath) {
  const nodes = new Map();
  const ways = [];
  const relations = [];
  await new Promise((resolve, reject) => {
    const parser = parse();
    fs.createReadStream(pbfPath)
      .pipe(parser)
      .pipe(through.obj((items, _enc, cb) => {
        for (const item of items) {
          if (item.type === 'node') {
            nodes.set(item.id, { lat: item.lat, lon: item.lon, tags: item.tags || {} });
          } else if (item.type === 'way') {
            ways.push({ id: item.id, tags: item.tags || {}, refs: item.refs || [] });
          } else if (item.type === 'relation') {
            relations.push({ id: item.id, tags: item.tags || {}, members: item.members || [] });
          }
        }
        cb();
      }))
      .on('finish', resolve)
      .on('error', reject);
  });
  return { nodes, ways, relations };
}

function wayPoints(nodes, refs) {
  const points = [];
  for (const ref of refs) {
    const node = nodes.get(ref);
    if (node) points.push(node);
  }
  return points;
}

function polylineBbox(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const point of points) {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

function intersects(bbox, other) {
  return bbox.minLat <= other.maxLat
    && bbox.maxLat >= other.minLat
    && bbox.minLon <= other.maxLon
    && bbox.maxLon >= other.minLon;
}

export function simplify(points, tolerance) {
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

export function simplifyClosedRing(points, tolerance) {
  if (points.length < 4) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const open = first && last && first.x === last.x && first.z === last.z
    ? points.slice(0, -1)
    : points;
  const simplified = simplify(open, tolerance);
  return simplified.length >= 3 ? simplified : open;
}

export function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

function laneCountForWay(tags, cls) {
  if (tags.lanes && /^\d+$/.test(tags.lanes)) return Number(tags.lanes);
  if (tags.lanes_forward && /^\d+$/.test(tags.lanes_forward)) return Number(tags.lanes_forward);
  if (tags.lanes_backward && /^\d+$/.test(tags.lanes_backward)) return Number(tags.lanes_backward);
  const defaults = {
    motorway: 4,
    trunk: 4,
    primary: 3,
    secondary: 3,
    tertiary: 2,
    unclassified: 2,
    residential: 2,
    living_street: 1,
    service: 1,
    pedestrian: 1,
    footway: 1,
    cycleway: 1,
    path: 1,
  };
  return defaults[cls] || 1;
}

function isOneWay(tags) {
  return tags.oneway === 'yes'
    || tags.oneway === '1'
    || tags.oneway === 'true'
    || tags.junction === 'roundabout'
    || tags.junction === 'circular';
}

function oneWayReverse(tags) {
  return tags.oneway === '-1';
}

function assembleBoundary(relations, waysById) {
  const relation = relations.find((candidate) => (
    candidate.tags.boundary === 'administrative'
    && candidate.tags.admin_level === '6'
    && candidate.tags.name === 'San Francisco'
  ));
  if (!relation) return [];
  const memberWays = relation.members
    .filter((member) => member.type === 'way' && waysById.has(member.id))
    .map((member) => ({ member, way: waysById.get(member.id) }));
  console.log('boundary member ways', memberWays.length, 'with points', memberWays.filter((entry) => entry.way.points.length >= 2).length);
  for (const member of relation.members.filter((candidate) => candidate.type === 'way')) {
    const way = waysById.get(member.id);
    console.log('  member', member.id, way ? way.points.length : 'missing');
  }
  for (const entry of memberWays) {
    const pts = entry.way.points;
    if (pts.length >= 2) {
      const first = project(pts[0].lat, pts[0].lon);
      const end = project(pts[pts.length - 1].lat, pts[pts.length - 1].lon);
      console.log('  bway', entry.way.id, pts.length, first.x.toFixed(1), first.z.toFixed(1), '->', end.x.toFixed(1), end.z.toFixed(1));
    }
  }
  const rings = [];
  const used = new Set();
  for (const entry of memberWays) {
    if (used.has(entry.way.id)) continue;
    const ring = [];
    let current = entry;
    used.add(current.way.id);
    const nodes = current.way.points;
    if (nodes.length >= 2) ring.push(...nodes.map((node) => project(node.lat, node.lon)));
    if (entry.way.id === memberWays[0].way.id) {
      console.log('first boundary way', entry.way.id, 'nodes', nodes.length, 'ring', ring.length, JSON.stringify(ring.slice(0, 2)));
    }
    let closed = ring.length >= 2 && samePoint(ring[0], ring[ring.length - 1]);
    let guard = 0;
    while (!closed && guard < 10000) {
      guard += 1;
      const last = ring[ring.length - 1];
      const nextEntry = memberWays.find((candidate) => {
        if (used.has(candidate.way.id)) return false;
        const candidateNodes = candidate.way.points;
        if (!candidateNodes.length) return false;
        const first = project(candidateNodes[0].lat, candidateNodes[0].lon);
        const end = project(candidateNodes[candidateNodes.length - 1].lat, candidateNodes[candidateNodes.length - 1].lon);
        return closeTo(last, first) || closeTo(last, end);
      });
      if (entry.way.id === memberWays[0].way.id && guard <= 2) {
        console.log('  next', nextEntry?.way.id, 'last', JSON.stringify(last));
      }
      if (!nextEntry) break;
      used.add(nextEntry.way.id);
      const candidateNodes = nextEntry.way.points;
      const first = project(candidateNodes[0].lat, candidateNodes[0].lon);
      const end = project(candidateNodes[candidateNodes.length - 1].lat, candidateNodes[candidateNodes.length - 1].lon);
      if (closeTo(last, end)) {
        for (let i = candidateNodes.length - 2; i >= 0; i -= 1) {
          ring.push(project(candidateNodes[i].lat, candidateNodes[i].lon));
        }
      } else {
        for (let i = 1; i < candidateNodes.length; i += 1) {
          ring.push(project(candidateNodes[i].lat, candidateNodes[i].lon));
        }
      }
      closed = closeTo(ring[0], ring[ring.length - 1]);
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings.map((ring) => simplify(ring, 1.5));
}

function closeTo(a, b, tolerance = 0.5) {
  return Math.hypot(a.x - b.x, a.z - b.z) <= tolerance;
}

function samePoint(a, b) {
  return closeTo(a, b, 0.001);
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area / 2);
}

function polygonCentroid(points) {
  let x = 0;
  let z = 0;
  for (const point of points) {
    x += point.x;
    z += point.z;
  }
  return { x: x / points.length, z: z / points.length };
}

function makeRoadRecord(way, cls, points) {
  const reverse = oneWayReverse(way.tags);
  const ordered = reverse ? [...points].reverse() : points;
  return {
    id: way.id,
    name: way.tags.name || way.tags.ref || '',
    highway: cls,
    oneway: isOneWay(way.tags),
    lanes: laneCountForWay(way.tags, cls),
    maxspeed: way.tags.maxspeed ? String(way.tags.maxspeed) : '',
    surface: way.tags.surface || '',
    sidewalk: way.tags.sidewalk || (cls === 'residential' || cls === 'primary' || cls === 'secondary' ? 'both' : ''),
    layer: way.tags.layer ? String(way.tags.layer) : '0',
    bridge: way.tags.bridge === 'yes',
    tunnel: way.tags.tunnel === 'yes',
    points: ordered.map((point) => project(point.lat, point.lon)),
  };
}

async function main() {
  const pbfPath = process.argv.includes('--download') ? null : PBF_PATH;
  const source = pbfPath && fs.existsSync(pbfPath)
    ? pbfPath
    : (await downloadPbf());
  console.log('Parsing PBF:', source);
  const { nodes, ways, relations } = await readPbf(source);
  console.log(`nodes=${nodes.size} ways=${ways.length} relations=${relations.length}`);

  const waysById = new Map(ways.map((way) => [way.id, way]));
  for (const way of ways) {
    way.points = wayPoints(nodes, way.refs);
  }
  const boundaryRelation = relations.find((candidate) => (
    candidate.tags.boundary === 'administrative'
    && candidate.tags.admin_level === '6'
    && candidate.tags.name === 'San Francisco'
  ));
  console.log('boundary relation', boundaryRelation?.id, boundaryRelation?.members?.length);
  const boundaryRings = assembleBoundary(relations, waysById);
  console.log(`boundary rings=${boundaryRings.length} first=${boundaryRings[0]?.length || 0}`);

  const cityRoads = [];
  const detailRoads = [];
  const buildings = [];
  const detailBuildings = [];
  const signals = [];
  let skippedNoGeometry = 0;

  for (const way of ways) {
    const tags = way.tags;
    const cls = tags.highway;
    if (!cls || !ROAD_CLASSES.has(cls)) continue;
    if (way.points.length < 2) {
      skippedNoGeometry += 1;
      continue;
    }
    const bbox = polylineBbox(way.points);
    if (!intersects(CITY_BBOX, bbox)) continue;
    const record = makeRoadRecord(way, cls, way.points);
    record.points = simplify(record.points, 2.5);
    cityRoads.push(record);
    if (intersects(DETAIL_BBOX, bbox)) {
      const detailRecord = makeRoadRecord(way, cls, way.points);
      detailRecord.points = simplify(detailRecord.points, 1.2);
      detailRoads.push(detailRecord);
    }
  }

  for (const way of ways) {
    if (!way.tags.building || way.points.length < 3) continue;
    const bbox = polylineBbox(way.points);
    if (!intersects(CITY_BBOX, bbox)) continue;
    const height = Number(way.tags.height || 0)
      || Number(way.tags['building:height'] || 0)
      || Number(way.tags['building:levels'] || 0) * 3.2;
    const localPoints = way.points.map((point) => project(point.lat, point.lon));
    const area = polygonArea(localPoints);
    if (!Number.isFinite(area) || area < 8) continue;
    const base = {
      id: way.id,
      name: way.tags.name || '',
      addr: [
        way.tags['addr:housenumber'] || '',
        way.tags['addr:street'] || '',
      ].filter(Boolean).join(' '),
      building: way.tags.building || 'yes',
      amenity: way.tags.amenity || way.tags.shop || way.tags.office || way.tags.tourism || '',
      levels: Number(way.tags['building:levels'] || 0) || 1,
      height,
      area,
      centroid: polygonCentroid(localPoints),
    };
    if (intersects(DETAIL_BBOX, bbox)) {
      detailBuildings.push({
        ...base,
        points: simplifyClosedRing(localPoints, 1.2),
      });
    } else {
      buildings.push(base);
    }
  }

  for (const node of nodes.values()) {
    if (node.tags.highway === 'traffic_signals'
      && node.lat >= DETAIL_BBOX.minLat && node.lat <= DETAIL_BBOX.maxLat
      && node.lon >= DETAIL_BBOX.minLon && node.lon <= DETAIL_BBOX.maxLon) {
      signals.push(project(node.lat, node.lon));
    }
  }

  const atlas = {
    meta: {
      generatedAt: new Date().toISOString(),
      center: CENTER,
      projection: {
        metersPerDegreeLat: METERS_PER_DEG_LAT,
        metersPerDegreeLon: METERS_PER_DEG_LON,
      },
      cityBBox: CITY_BBOX,
      detailBBox: DETAIL_BBOX,
      counts: {
        roads: cityRoads.length,
        detailRoads: detailRoads.length,
        buildings: buildings.length,
        detailBuildings: detailBuildings.length,
        signals: signals.length,
      },
    },
    boundary: boundaryRings,
    roads: cityRoads,
    detailRoads,
    buildings,
    detailBuildings,
    signals,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const output = path.join(OUT_DIR, 'sf-atlas.json');
  fs.writeFileSync(output, JSON.stringify(atlas));
  console.log(`Wrote ${output} (${(fs.statSync(output).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(JSON.stringify(atlas.meta.counts));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
