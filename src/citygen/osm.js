import { HIGHWAY_PROFILE, hashString, mulberry32, terrainHeight, CITY_SCHEMA_VERSION } from './core.js';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const METERS_PER_DEG_LAT = 110574;

const ROAD_KEYS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service',
  'pedestrian', 'footway', 'cycleway', 'path',
]);

function metersPerDegLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

export function projectPoint(lat, lon, center) {
  return {
    x: (lon - center.lon) * metersPerDegLon(center.lat),
    z: (lat - center.lat) * METERS_PER_DEG_LAT,
  };
}

export async function geocodePlace(query) {
  const direct = parseLatLon(query);
  if (direct) {
    return {
      lat: direct.lat,
      lon: direct.lon,
      radius: direct.radius,
      name: `${direct.lat.toFixed(4)},${direct.lon.toFixed(4)}`,
    };
  }
  const attempts = [
    async () => {
      const url = new URL(NOMINATIM_URL);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '1');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
        const results = await response.json();
        if (!Array.isArray(results) || !results.length) throw new Error('Place not found');
        const first = results[0];
        return { lat: Number(first.lat), lon: Number(first.lon), name: first.display_name };
      } finally {
        clearTimeout(timer);
      }
    },
    async () => {
      const url = new URL('https://photon.komoot.io/api/');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '1');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) throw new Error(`Photon HTTP ${response.status}`);
        const json = await response.json();
        const feature = json?.features?.[0];
        if (!feature) throw new Error('Place not found');
        const [lon, lat] = feature.geometry.coordinates;
        const props = feature.properties || {};
        return { lat: Number(lat), lon: Number(lon), name: props.name || props.city || props.state || 'OSM City' };
      } finally {
        clearTimeout(timer);
      }
    },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || 'Could not geocode place');
}

export async function fetchOsmCity({ query = 'San Francisco, CA', radius = 850 } = {}) {
  const place = await geocodePlace(query);
  const center = { lat: place.lat, lon: place.lon };
  if (place.radius) radius = place.radius;
  if (radius > 2200) radius = 2200;
  const dLat = radius / METERS_PER_DEG_LAT;
  const dLon = radius / metersPerDegLon(center.lat);
  const bbox = [
    (center.lat - dLat).toFixed(6),
    (center.lon - dLon).toFixed(6),
    (center.lat + dLat).toFixed(6),
    (center.lon + dLon).toFixed(6),
  ];
  const overpass = `
    [out:json][timeout:45];
    (
      way["highway"](${bbox.join(',')});
      way["building"](${bbox.join(',')});
      way["building:part"](${bbox.join(',')});
      way["landuse"~"^(grass|forest|park|recreation_ground|meadow|village_green)$"](${bbox.join(',')});
      way["leisure"~"^(park|garden|playground|recreation_ground)$"](${bbox.join(',')});
      way["natural"~"^(water|beach|bay)$"](${bbox.join(',')});
      node["highway"="traffic_signals"](${bbox.join(',')});
      node["highway"="crossing"](${bbox.join(',')});
    );
    out geom 2000;
  `;
  let json;
  let lastError = null;
  for (const endpoint of OVERPASS_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const url = new URL(endpoint);
      url.searchParams.set('data', overpass);
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
      json = await response.json();
      if (Array.isArray(json?.elements) && json.elements.length) break;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!json) {
    throw new Error(lastError?.message || 'Overpass returned no data');
  }
  return osmJsonToCity(json, { center, name: place.name, source: 'openstreetmap' });
}

export function parseLatLon(value) {
  const match = String(value || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)(?:\s*[,;]\s*(\d+))?$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const radius = match[3] ? Number(match[3]) : null;
  if (radius != null && (!Number.isFinite(radius) || radius < 50 || radius > 5000)) return null;
  return { lat, lon, radius };
}

export { maxspeedToKmh };
export function osmJsonToCity(json, { center, name = 'OSM City', source = 'openstreetmap' } = {}) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const roads = [];
  const buildings = [];
  const parks = [];
  const water = [];
  const signalNodes = [];
  let buildingId = 0;
  let roadId = 0;

  for (const element of elements) {
    const tags = element.tags || {};
    const points = (element.geometry || [])
      .map((node) => projectPoint(node.lat, node.lon, center))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
    if (element.type === 'node') {
      if (tags.highway === 'traffic_signals' || tags.highway === 'crossing') {
        const p = projectPoint(element.lat, element.lon, center);
        if (Number.isFinite(p.x) && Number.isFinite(p.z)) {
          signalNodes.push({ x: p.x, z: p.z, id: element.id, tags });
        }
      }
      continue;
    }
    if (element.type !== 'way') continue;
    if (points.length < 2) continue;

    const highway = tags.highway;
    if (highway && ROAD_KEYS.has(highway)) {
      const profile = HIGHWAY_PROFILE[highway] || HIGHWAY_PROFILE.residential;
      const name = tags.name || tags.ref || 'Unnamed Road';
      const lanes = Math.max(1, Number(tags.lanes) || profile.lanes);
      roads.push({
        id: `osm-road-${roadId++}`,
        name,
        highway: profile.class,
        lanes,
        laneW: profile.laneW,
        sidewalkW: parseSidewalk(tags, profile),
        sidewalkLeft: parseSidewalkSide(tags, 'left', profile),
        sidewalkRight: parseSidewalkSide(tags, 'right', profile),
        asphaltWidth: (Number(tags.width) || (lanes * profile.laneW)),
        oneway: tags.oneway === 'yes' ? 'increasing'
          : tags.oneway === '-1' ? 'decreasing'
            : tags.junction === 'roundabout' ? 'increasing' : 'both',
        maxspeed: parseMaxspeed(tags, profile),
        cycleway: parseCycleway(tags),
        points,
      });
    } else if (tags.building && points.length >= 3) {
      const area = Math.abs(polygonArea(points));
      if (area < 24) continue;
      const dims = buildingDims(points);
      if (dims.max > 180) {
        console.warn(`osm.js: large building footprint ${tags.name || '(unnamed)'} maxDim=${dims.max.toFixed(0)}m w=${dims.w.toFixed(0)} d=${dims.d.toFixed(0)}`);
      }
      const height = Number(tags.height) || Number(tags['building:height'])
        || (Number(tags.levels) || Number(tags['building:levels']) || defaultLevels(area)) * 3.15;
      const type = inferBuildingType(tags, area);
      buildings.push({
        id: `osm-building-${buildingId++}`,
        name: tags.name || '',
        address: formatAddress(tags),
        type,
        typeLabel: type,
        usage: inferUsage(type, tags),
        district: 'OSM',
        polygon: points,
        height: Math.max(3, height),
        stories: Math.max(1, Math.round(height / 3.15)),
        yearBuilt: tags.start_date ? Number(String(tags.start_date).match(/\d{4}/)?.[0] || 1900) : 1900,
        footprintArea: area,
        roofShape: tags['roof:shape'] || '',
        material: inferMaterial(tags, type),
        facade: inferFacade(tags, type),
        landmark: Boolean(tags.amenity || tags.tourism || tags.building === 'public'),
        shop: tags.shop ? String(tags.shop) : '',
        amenity: tags.amenity ? String(tags.amenity) : '',
        tourism: tags.tourism ? String(tags.tourism) : '',
      });
    } else if (points.length >= 3 && isPark(tags)) {
      parks.push({
        id: `osm-park-${parks.length}`,
        name: tags.name || '',
        polygon: points,
        kind: parkKind(tags),
      });
    } else if (points.length >= 3 && isWater(tags)) {
      water.push({
        id: `osm-water-${water.length}`,
        name: tags.name || '',
        polygon: points,
        kind: tags.natural || 'water',
      });
    }
  }

  const segments = [];
  for (const road of roads) {
    for (let i = 0; i < road.points.length - 1; i += 1) {
      segments.push({
        id: `osm-seg-${segments.length}`,
        streetId: road.id,
        streetName: road.name,
        highway: road.highway,
        lanes: road.lanes,
        oneway: road.oneway,
        width: road.asphaltWidth,
        sidewalkW: road.sidewalkW,
        sidewalkLeft: road.sidewalkLeft,
        sidewalkRight: road.sidewalkRight,
        maxspeed: road.maxspeed?.raw || '',
        maxspeedKmh: road.maxspeed?.kmh || 0,
        cycleway: road.cycleway || '',
        points: [road.points[i], road.points[i + 1]],
      });
    }
  }

  // Group buildings into synthetic blocks by 90m cells.
  const blockMap = new Map();
  const blocks = [];
  for (const building of buildings) {
    const cx = (Math.min(...building.polygon.map((p) => p.x)) + Math.max(...building.polygon.map((p) => p.x))) / 2;
    const cz = (Math.min(...building.polygon.map((p) => p.z)) + Math.max(...building.polygon.map((p) => p.z))) / 2;
    const key = `${Math.floor(cx / 90)}-${Math.floor(cz / 90)}`;
    let block = blockMap.get(key);
    if (!block) {
      block = {
        id: `osm-block-${blocks.length}`,
        district: 'OSM',
        polygon: [],
        streets: [],
        buildings: [],
        landUse: 'mixed',
      };
      blockMap.set(key, block);
      blocks.push(block);
    }
    block.buildings.push(building.id);
    building.blockId = block.id;
    building.facingStreet = '';
  }
  const segmentBounds = segments.map((segment) => {
    const xs = segment.points.map((p) => p.x);
    const zs = segment.points.map((p) => p.z);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  });
  for (const block of blocks) {
    const buildingPoints = block.buildings
      .map((id) => buildings.find((b) => b.id === id))
      .filter(Boolean)
      .flatMap((b) => b.polygon);
    const minX = Math.min(...buildingPoints.map((p) => p.x));
    const maxX = Math.max(...buildingPoints.map((p) => p.x));
    const minZ = Math.min(...buildingPoints.map((p) => p.z));
    const maxZ = Math.max(...buildingPoints.map((p) => p.z));
    const snapped = snapBlockToRoads(segments, segmentBounds, { minX, maxX, minZ, maxZ });
    block.polygon = [
      { x: snapped.minX, z: snapped.minZ },
      { x: snapped.maxX, z: snapped.minZ },
      { x: snapped.maxX, z: snapped.maxZ },
      { x: snapped.minX, z: snapped.maxZ },
    ];
    const roadNames = new Map(roads.map((road) => [road.id, road.name]));
    const namedSnap = snapped.streets.filter((id) => {
      const roadName = roadNames.get(id);
      return roadName && roadName !== 'Unnamed Road';
    });
    block.streets = [...new Set(namedSnap.length ? namedSnap : snapped.streets)];
    if (!block.streets.length) block.streets = segments
      .map((segment, index) => ({ index, d: Math.hypot(segment.points[0].x - (minX + maxX) / 2, segment.points[0].z - (minZ + maxZ) / 2) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4)
      .map((n) => segments[n.index].streetId);
    block.streets = [...new Set(block.streets)];
  }

  // Assign each OSM building the nearest named road as its facing street.
  const namedSegments = segments.filter((segment) => segment.streetName && segment.streetName !== 'Unnamed Road');
  for (const building of buildings) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of building.polygon) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    let bestName = '';
    let bestDistance = 40;
    for (const segment of namedSegments) {
      const a = segment.points[0];
      const b = segment.points[segment.points.length - 1];
      const distance = pointToSegmentDistance(center, a, b);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestName = segment.streetName;
      }
    }
    building.facingStreet = bestName;
    // Street-level address fallback for buildings without addr:* tags.
    if (!building.address && bestName) {
      const houseNum = Math.max(1, Math.round(Math.abs(building.id.split('-').pop() || buildingId) % 9900) + 100);
      building.address = `${houseNum} ${bestName}`;
    }
  }

  // Infer block land use from majority building usage within each block.
  for (const block of blocks) {
    const usageTally = {};
    for (const bid of block.buildings) {
      const b = buildings.find((bb) => bb.id === bid);
      if (!b) continue;
      const u = b.usage || 'mixed';
      usageTally[u] = (usageTally[u] || 0) + 1;
    }
    let best = 'mixed';
    let bestCount = 0;
    for (const [u, c] of Object.entries(usageTally)) {
      if (c > bestCount) { best = u; bestCount = c; }
    }
    block.landUse = bestCount > 0 ? best : 'mixed';
  }

  // Signals: prefer real OSM traffic-signal nodes, then fall back to junctions.
  const junctionKeys = new Map();
  for (const segment of segments) {
    for (const point of [segment.points[0], segment.points[segment.points.length - 1]]) {
      const key = `${Math.round(point.x / 3) * 3}-${Math.round(point.z / 3) * 3}`;
      if (!junctionKeys.has(key)) junctionKeys.set(key, []);
      junctionKeys.get(key).push(segment);
    }
  }
  const intersections = [];
  const signals = [];
  let signalId = 0;
  const signalNodesInRange = signalNodes.filter((node) => {
    const streetIds = nearbyStreetIds(segments, node.x, node.z, 12);
    return streetIds.length >= 1;
  });
  const usedJunctionKeys = new Set();
  for (const node of signalNodesInRange) {
    const key = `${Math.round(node.x / 3) * 3}-${Math.round(node.z / 3) * 3}`;
    usedJunctionKeys.add(key);
    const streetIds = nearbyStreetIds(segments, node.x, node.z, 12);
    const position = { x: node.x, z: node.z };
    const intersection = { id: `osm-int-${intersections.length}`, position, streetIds };
    intersections.push(intersection);
    const signal = {
      id: `osm-sig-${signalId++}`,
      intersectionId: intersection.id,
      streetIds,
      position: { x: node.x - 2.5, z: node.z - 2.5 },
      heading: 'north',
      phaseOffset: Math.round(node.x * 7 + node.z * 13) % 4,
      period: 8,
    };
    signals.push(signal);
    intersection.signalId = signal.id;
    intersection.signal = signal;
  }
  for (const [key, hits] of junctionKeys) {
    if (hits.length < 2 || usedJunctionKeys.has(key)) continue;
    const [xText, zText] = key.split('-');
    const position = { x: Number(xText), z: Number(zText) };
    const streetIds = [...new Set(hits.map((s) => s.streetId))];
    const major = hits.some((s) => ['primary', 'secondary', 'tertiary'].includes(s.highway));
    const intersection = { id: `osm-int-${intersections.length}`, position, streetIds };
    intersections.push(intersection);
    if (major) {
      const signal = {
        id: `osm-sig-${signalId++}`,
        intersectionId: intersection.id,
        streetIds,
        position: { x: position.x - 3, z: position.z - 3 },
        heading: 'north',
        phaseOffset: 0,
        period: 8,
      };
      signals.push(signal);
      intersection.signalId = signal.id;
      intersection.signal = signal;
    }
  }

  // Wire signal phases onto the road segments that approach each signal.
  for (const intersection of intersections) {
    if (!intersection.signal) continue;
    const p = intersection.position;
    for (const segment of segments) {
      if (segment.signalId) continue;
      for (const point of segment.points) {
        if (Math.hypot(point.x - p.x, point.z - p.z) < 14) {
          segment.signalId = intersection.signal.id;
          segment.intersectionId = intersection.id;
          break;
        }
      }
    }
  }

  const allPoints = [...roads.flatMap((r) => r.points), ...buildings.flatMap((b) => b.polygon)];
  const minX = Math.min(...allPoints.map((p) => p.x)) - 40;
  const maxX = Math.max(...allPoints.map((p) => p.x)) + 40;
  const minZ = Math.min(...allPoints.map((p) => p.z)) - 40;
  const maxZ = Math.max(...allPoints.map((p) => p.z)) + 40;
  const seedInt = hashString(name + String(center.lat));
  const streets = roads.map((road) => ({
    id: road.id,
    name: road.name,
    highway: road.highway,
    lanes: road.lanes,
    laneW: road.laneW,
    oneway: road.oneway,
    sidewalkW: road.sidewalkW,
    sidewalkLeft: road.sidewalkLeft,
    sidewalkRight: road.sidewalkRight,
    maxspeed: road.maxspeed?.raw || '',
    maxspeedKmh: road.maxspeed?.kmh || 0,
    maxspeedSource: road.maxspeed?.source || 'zone-default',
    cycleway: road.cycleway || '',
    asphaltWidth: road.asphaltWidth,
    orientation: 'osm',
    axis: 'osm',
    position: 0,
    blocks: [],
    signalIds: [],
  }));
  for (const signal of signals) {
    for (const streetId of signal.streetIds) {
      const street = streets.find((s) => s.id === streetId);
      if (street) street.signalIds.push(signal.id);
    }
  }
  for (const street of streets) {
    street.blocks = blocks.filter((b) => b.streets.includes(street.id)).map((b) => b.id);
  }
  const landUseBlocks = [];
  for (const park of parks) {
    const centroid = polygonCentroid(park.polygon);
    const block = {
      id: `osm-park-block-${landUseBlocks.length}`,
      district: 'OSM',
      polygon: park.polygon,
      streets: [],
      buildings: [],
      landUse: 'park',
      name: park.name || '',
      park: true,
      kind: park.kind,
    };
    const nearest = segments
      .map((segment, index) => ({ index, d: distanceToPoint(segment.points[0], centroid) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    block.streets = nearest.map((n) => segments[n.index].streetId);
    landUseBlocks.push(block);
  }
  const waterBlocks = [];
  for (const w of water) {
    waterBlocks.push({
      id: `osm-water-block-${waterBlocks.length}`,
      district: 'OSM',
      polygon: w.polygon,
      streets: [],
      buildings: [],
      landUse: 'water',
      name: w.name || '',
      water: true,
      kind: w.kind,
    });
  }
  return {
    schemaVersion: CITY_SCHEMA_VERSION,
    meta: {
      name: String(name).split(',')[0],
      seed: `${center.lat.toFixed(4)},${center.lon.toFixed(4)}`,
      seedInt,
      style: 'osm',
      generator: source,
      center,
      bounds: { minX, maxX, minZ, maxZ },
      terrain: { type: 'osm-flat', flattenNearRoads: false },
      streetDesign: { streetScale: 1, sidewalkScale: 1, curbHeight: 0.16, roadLift: 0.45 },
      generatedAt: new Date().toISOString(),
    },
    blocks,
    buildings,
    streets,
    segments,
    intersections,
    signals,
    parks: [...parks, ...landUseBlocks.map((block) => ({ id: block.id, name: block.name || '', polygon: block.polygon, kind: block.kind }))],
    water: waterBlocks.map((block) => ({ id: block.id, name: block.name || '', polygon: block.polygon, kind: block.kind })),
    terrain: {
      type: 'osm-flat',
      seed: seedInt,
      heightAt: (x, z) => terrainHeight(x, z, seedInt) * 0.12,
    },
  };
}

/** Largest edge-aligned dimension of a building polygon. */
function buildingDims(pts) {
  const xs = pts.map(p => p.x);
  const zs = pts.map(p => p.z);
  const w = Math.max(...xs) - Math.min(...xs);
  const d = Math.max(...zs) - Math.min(...zs);
  return { w, d, max: Math.max(w, d) };
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
}

/**
 * Shrink a block's rectangular envelope toward the roads that actually bound
 * it. The old +6 m padding ignored the road network, so blocks floated over
 * asphalt and street right-of-way; now each side snaps to the outer edge of
 * the nearest parallel segment (centerline + half asphalt + sidewalk) with a
 * small curb clearance. Falls back to the padded bounds when no road bounds a
 * side. `block.streets` comes from the same bounding segments.
 */
export function snapBlockToRoads(segments, segmentBounds, bounds, { buffer = 30, clearance = 1.8, minSide = 6 } = {}) {
  const inflated = {
    minX: bounds.minX - buffer,
    maxX: bounds.maxX + buffer,
    minZ: bounds.minZ - buffer,
    maxZ: bounds.maxZ + buffer,
  };
  const candidates = [];
  for (let i = 0; i < segments.length; i += 1) {
    const sb = segmentBounds[i];
    if (sb.maxX < inflated.minX || sb.minX > inflated.maxX || sb.maxZ < inflated.minZ || sb.minZ > inflated.maxZ) continue;
    candidates.push(segments[i]);
  }
  const snapSide = (side) => {
    let bestEdge = null;
    for (const segment of candidates) {
      const a = segment.points[0];
      const b = segment.points[segment.points.length - 1];
      const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
      if ((side === 'minZ' || side === 'maxZ') !== horizontal) continue;
      if (horizontal) {
        const overlapsX = Math.max(a.x, b.x) >= bounds.minX - 2 && Math.min(a.x, b.x) <= bounds.maxX + 2;
        if (!overlapsX) continue;
      } else {
        const overlapsZ = Math.max(a.z, b.z) >= bounds.minZ - 2 && Math.min(a.z, b.z) <= bounds.maxZ + 2;
        if (!overlapsZ) continue;
      }
      const d = distancePolylineToRect(segment.points, bounds);
      const halfRightOfWay = segment.width / 2 + segment.sidewalkW + clearance;
      if (d > buffer) continue;
      if (side === 'minX') {
        const candidateEdge = Math.max(a.x, b.x) + halfRightOfWay;
        if (candidateEdge < bounds.minX && (bestEdge === null || candidateEdge > bestEdge.edge)) bestEdge = { edge: candidateEdge, streetId: segment.streetId };
      } else if (side === 'maxX') {
        const candidateEdge = Math.min(a.x, b.x) - halfRightOfWay;
        if (candidateEdge > bounds.maxX && (bestEdge === null || candidateEdge < bestEdge.edge)) bestEdge = { edge: candidateEdge, streetId: segment.streetId };
      } else if (side === 'minZ') {
        const candidateEdge = Math.max(a.z, b.z) + halfRightOfWay;
        if (candidateEdge < bounds.minZ && (bestEdge === null || candidateEdge > bestEdge.edge)) bestEdge = { edge: candidateEdge, streetId: segment.streetId };
      } else {
        const candidateEdge = Math.min(a.z, b.z) - halfRightOfWay;
        if (candidateEdge > bounds.maxZ && (bestEdge === null || candidateEdge < bestEdge.edge)) bestEdge = { edge: candidateEdge, streetId: segment.streetId };
      }
    }
    return bestEdge;
  };
  const sides = { minX: snapSide('minX'), maxX: snapSide('maxX'), minZ: snapSide('minZ'), maxZ: snapSide('maxZ') };
  let minX = sides.minX ? sides.minX.edge : bounds.minX - 6;
  let maxX = sides.maxX ? sides.maxX.edge : bounds.maxX + 6;
  let minZ = sides.minZ ? sides.minZ.edge : bounds.minZ - 6;
  let maxZ = sides.maxZ ? sides.maxZ.edge : bounds.maxZ + 6;
  // Never let snapping invert or over-shrink the block; keep a usable interior.
  if (maxX - minX < minSide) {
    minX = bounds.minX - 3;
    maxX = bounds.maxX + 3;
  }
  if (maxZ - minZ < minSide) {
    minZ = bounds.minZ - 3;
    maxZ = bounds.maxZ + 3;
  }
  const streets = [...new Set([sides.minX, sides.maxX, sides.minZ, sides.maxZ]
    .filter(Boolean)
    .map((s) => s.streetId))];
  return { minX, maxX, minZ, maxZ, streets };
}

/** Minimum distance from a polyline to a rectangle (0 when it overlaps). */
function distancePolylineToRect(points, rect) {
  let best = Infinity;
  const clampToRect = (p) => ({
    x: Math.max(rect.minX, Math.min(rect.maxX, p.x)),
    z: Math.max(rect.minZ, Math.min(rect.maxZ, p.z)),
  });
  const inside = points.some((p) => p.x >= rect.minX && p.x <= rect.maxX && p.z >= rect.minZ && p.z <= rect.maxZ);
  if (inside) return 0;
  for (const p of points) {
    const c = clampToRect(p);
    best = Math.min(best, Math.hypot(p.x - c.x, p.z - c.z));
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const c = clampToRect(mid);
    best = Math.min(best, Math.hypot(mid.x - c.x, mid.z - c.z));
  }
  return best;
}

function parseSidewalk(tags, profile) {
  const raw = String(tags.sidewalk || '').toLowerCase();
  if (raw === 'no' || raw === 'none') return 0;
  if (raw === 'separate' || raw === 'both') return profile.sidewalk;
  const width = Number(tags.sidewalk_width || tags['sidewalk:both:width'] || tags['sidewalk:left:width'] || tags['sidewalk:right:width']);
  if (Number.isFinite(width) && width > 0) return width;
  const left = String(tags['sidewalk:left'] || '').toLowerCase();
  const right = String(tags['sidewalk:right'] || '').toLowerCase();
  if (left === 'no' && right === 'no') return 0;
  if (left === 'no' || right === 'no') return profile.sidewalk * 0.65;
  return profile.sidewalk;
}

/**
 * Per-side sidewalk width. Honors `sidewalk:left/right` presence/width tags
 * first, then falls back to the aggregate `sidewalk` tag, then to the
 * highway-class default. A side tagged `no`/`none` is always 0.
 */
function parseSidewalkSide(tags, side, profile) {
  const sideTag = String(tags[`sidewalk:${side}`] || '').toLowerCase();
  const sideWidth = Number(tags[`sidewalk:${side}:width`]);
  if (Number.isFinite(sideWidth) && sideWidth > 0) return sideWidth;
  if (sideTag === 'no' || sideTag === 'none') return 0;
  if (sideTag === 'yes' || sideTag === 'left' || sideTag === 'right' || sideTag === 'both') return profile.sidewalk;
  const aggregate = String(tags.sidewalk || '').toLowerCase();
  if (aggregate === 'no' || aggregate === 'none') return 0;
  if (aggregate === 'left' && side === 'right') return 0;
  if (aggregate === 'right' && side === 'left') return 0;
  if (aggregate === 'both' || aggregate === 'yes' || aggregate === 'separate') return profile.sidewalk;
  const bothWidth = Number(tags.sidewalk_width || tags['sidewalk:both:width']);
  if (Number.isFinite(bothWidth) && bothWidth > 0) return bothWidth;
  return profile.sidewalk;
}

/**
 * Normalized speed limit. OSM `maxspeed` is a raw tag ("30 mph", "50",
 * "DE:urban"); we keep the raw string for display and also expose a numeric
 * km/h value for gameplay. Zone defaults follow the highway class when the
 * tag is absent, so imported cities never ship empty speed metadata.
 */
function parseMaxspeed(tags, profile) {
  const raw = tags.maxspeed != null ? String(tags.maxspeed) : '';
  const kmh = maxspeedToKmh(raw);
  const zone = DEFAULT_MAXSPEED_KMH[profile.class] || 50;
  return { raw, kmh: kmh || zone, source: kmh ? 'osm' : 'zone-default' };
}

const DEFAULT_MAXSPEED_KMH = Object.freeze({
  motorway: 100,
  trunk: 90,
  primary: 60,
  secondary: 50,
  tertiary: 50,
  unclassified: 45,
  residential: 40,
  living_street: 20,
  service: 25,
  pedestrian: 10,
  footway: 6,
  cycleway: 20,
  path: 10,
});

function maxspeedToKmh(raw) {
  const value = String(raw || '').trim();
  if (!value) return 0;
  if (/^[A-Z]{2}:/.test(value)) return 0; // implicit zone signs (e.g. DE:urban)
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kph|knots)?$/i);
  if (!match) return 0;
  const speed = Number(match[1]);
  const unit = (match[2] || 'km/h').toLowerCase();
  if (unit === 'mph') return Math.round(speed * 1.609);
  if (unit === 'knots') return Math.round(speed * 1.852);
  return Math.round(speed);
}

function parseCycleway(tags) {
  return String(tags.cycleway || tags['cycleway:both'] || tags['cycleway:left'] || tags['cycleway:right'] || '');
}

/** Best-effort street address from OSM addr:* tags. */
function formatAddress(tags) {
  const house = tags['addr:housenumber'] ? String(tags['addr:housenumber']) : '';
  const unit = tags['addr:unit'] ? ` #${String(tags['addr:unit'])}` : '';
  const street = tags['addr:street'] ? String(tags['addr:street'])
    : (tags['addr:place'] ? String(tags['addr:place']) : '');
  if (house && street) return `${house}${unit} ${street}`;
  if (street) return street;
  if (house) return house;
  return '';
}

function isPark(tags) {
  return Boolean(
    (tags.landuse && ['grass', 'forest', 'park', 'recreation_ground', 'meadow', 'village_green'].includes(String(tags.landuse).toLowerCase()))
    || (tags.leisure && ['park', 'garden', 'playground', 'recreation_ground'].includes(String(tags.leisure).toLowerCase()))
  );
}

function parkKind(tags) {
  if (tags.landuse) return String(tags.landuse);
  return String(tags.leisure || 'park');
}

function isWater(tags) {
  return Boolean(tags.natural && ['water', 'beach', 'bay'].includes(String(tags.natural).toLowerCase()));
}

function polygonCentroid(points) {
  let x = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    z += p.z;
  }
  return { x: x / points.length, z: z / points.length };
}

function distanceToPoint(p, target) {
  return Math.hypot(p.x - target.x, p.z - target.z);
}

function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 0.0001) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

function nearbyStreetIds(segments, x, z, tolerance) {
  const found = new Set();
  for (const segment of segments) {
    if (found.size >= 4) break;
    for (const point of segment.points) {
      if (Math.hypot(point.x - x, point.z - z) <= tolerance) {
        found.add(segment.streetId);
        break;
      }
    }
  }
  return [...found];
}

function defaultLevels(area) {
  if (area > 2600) return 8;
  if (area > 1200) return 5;
  if (area > 450) return 3;
  return 2;
}

function inferBuildingType(tags, area) {
  const civicAmenities = new Set([
    'school', 'university', 'college', 'hospital', 'place_of_worship',
    'library', 'townhall', 'courthouse', 'fire_station', 'police',
    'community_centre', 'public_building',
  ]);
  if (tags.amenity && civicAmenities.has(tags.amenity)) return 'civic';
  if (tags.tourism || tags.building === 'public') return 'civic';
  if (tags.office) return 'tower';
  if (tags.industrial || tags.building === 'warehouse' || tags.building === 'industrial') return 'warehouse';
  if (tags.building === 'residential' && area > 700) return 'midrise';
  if (tags.building === 'residential') return 'rowhouse';
  if (tags.shop || tags.building === 'retail') return 'shop';
  const buildingUse = tags['building:use'];
  if (buildingUse === 'residential' && area > 700) return 'midrise';
  if (buildingUse === 'residential') return 'rowhouse';
  if (buildingUse === 'commercial' || buildingUse === 'retail') return 'shop';
  if (buildingUse === 'industrial') return 'warehouse';
  if (buildingUse === 'civic' || buildingUse === 'public') return 'civic';
  if (buildingUse === 'office') return 'tower';
  if (area > 1800) return 'tower';
  return 'midrise';
}

function inferUsage(type, tags) {
  if (type === 'tower') return tags.office ? 'office' : 'office';
  if (type === 'rowhouse') return 'residential';
  if (type === 'civic') {
    if (tags.amenity === 'place_of_worship') return 'religious';
    if (tags.amenity === 'school' || tags.amenity === 'university' || tags.amenity === 'college') return 'education';
    if (tags.amenity === 'hospital') return 'healthcare';
    return 'civic';
  }
  if (type === 'warehouse') return 'industrial';
  if (type === 'shop') return 'retail';
  return 'mixed';
}

function inferMaterial(tags, type) {
  const material = String(tags.material || tags.building_material || '').toLowerCase();
  if (material.includes('brick')) return 'brick';
  if (material.includes('concrete')) return 'concrete';
  if (material.includes('wood') || material.includes('clap')) return 'clapboard';
  if (material.includes('stone')) return 'stone';
  if (material.includes('glass')) return 'glass';
  const hash = hashString(`osm-material-${tags.id || ''}-${tags.name || ''}-${type || ''}`);
  if (type === 'rowhouse') return ['painted', 'painted', 'clapboard', 'brick', 'plaster', 'stone'][hash % 6];
  if (type === 'shop') return ['painted', 'brick', 'plaster', 'stone', 'clapboard', 'brick'][hash % 6];
  if (type === 'tower') return ['glass', 'concrete', 'brick', 'painted', 'glass', 'concrete'][hash % 6];
  if (type === 'civic') return ['stone', 'stone', 'concrete', 'painted', 'brick', 'plaster'][hash % 6];
  if (type === 'warehouse') return ['brick', 'brick', 'concrete', 'painted', 'stone', 'plaster'][hash % 6];
  return ['painted', 'brick', 'concrete', 'glass', 'stone', 'plaster'][hash % 6];
}

function inferFacade(tags, type) {
  const style = String(tags['building:architecture'] || '').toLowerCase();
  if (style.includes('art')) return 'art-deco';
  if (style.includes('modern')) return 'modern-grid';
  if (style.includes('victorian') || style.includes('edward')) return 'edwardian';
  if (tags.shop) return 'shopfront';
  const hash = hashString(`osm-facade-${tags.id || ''}-${tags.name || ''}-${type || ''}`);
  if (type === 'rowhouse') return hash % 2 === 0 ? 'bay-window' : 'edwardian';
  if (type === 'shop') return 'shopfront';
  if (type === 'tower') return hash % 2 === 0 ? 'modern-grid' : 'loft';
  if (type === 'civic') return hash % 2 === 0 ? 'edwardian' : 'art-deco';
  if (type === 'warehouse') return hash % 2 === 0 ? 'loft' : 'modern-grid';
  return ['modern-grid', 'shopfront', 'loft', 'art-deco', 'bay-window'][hash % 5];
}
