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
      roads.push({
        id: `osm-road-${roadId++}`,
        name,
        highway: profile.class,
        lanes: Math.max(1, Number(tags.lanes) || profile.lanes),
        laneW: profile.laneW,
        sidewalkW: parseSidewalk(tags, profile),
        asphaltWidth: (Number(tags.width) || (Math.max(1, Number(tags.lanes) || profile.lanes) * profile.laneW)),
        oneway: tags.oneway === 'yes' ? 'increasing'
          : tags.oneway === '-1' ? 'decreasing'
            : tags.junction === 'roundabout' ? 'increasing' : 'both',
        maxspeed: tags.maxspeed ? String(tags.maxspeed) : '',
        cycleway: tags.cycleway ? String(tags.cycleway) : '',
        points,
      });
    } else if (tags.building && points.length >= 3) {
      const area = Math.abs(polygonArea(points));
      if (area < 24) continue;
      const height = Number(tags.height) || Number(tags['building:height'])
        || (Number(tags.levels) || defaultLevels(area)) * 3.15;
      const type = inferBuildingType(tags, area);
      buildings.push({
        id: `osm-building-${buildingId++}`,
        name: tags.name || '',
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
  for (const block of blocks) {
    const buildingPoints = block.buildings
      .map((id) => buildings.find((b) => b.id === id))
      .filter(Boolean)
      .flatMap((b) => b.polygon);
    const minX = Math.min(...buildingPoints.map((p) => p.x));
    const maxX = Math.max(...buildingPoints.map((p) => p.x));
    const minZ = Math.min(...buildingPoints.map((p) => p.z));
    const maxZ = Math.max(...buildingPoints.map((p) => p.z));
    block.polygon = [
      { x: minX - 6, z: minZ - 6 },
      { x: maxX + 6, z: minZ - 6 },
      { x: maxX + 6, z: maxZ + 6 },
      { x: minX - 6, z: maxZ + 6 },
    ];
    const nearest = segments
      .map((segment, index) => ({ index, d: Math.hypot(segment.points[0].x - (minX + maxX) / 2, segment.points[0].z - (minZ + maxZ) / 2) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    block.streets = nearest.map((n) => segments[n.index].streetId);
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
    oneway: road.oneway,
    sidewalkW: road.sidewalkW,
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

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area / 2;
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
  if (tags.amenity || tags.tourism || tags.building === 'public') return 'civic';
  if (tags.building === 'warehouse' || tags.building === 'industrial') return 'warehouse';
  if (tags.building === 'residential' && area > 700) return 'midrise';
  if (tags.building === 'residential') return 'rowhouse';
  if (tags.shop || tags.building === 'retail') return 'shop';
  if (area > 1800) return 'tower';
  return 'midrise';
}

function inferUsage(type, tags) {
  if (type === 'tower') return 'office';
  if (type === 'rowhouse') return 'residential';
  if (type === 'civic') return 'civic';
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
