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
  let buildingId = 0;
  let roadId = 0;

  for (const element of elements) {
    const tags = element.tags || {};
    if (element.type !== 'way') continue;
    const points = (element.geometry || [])
      .map((node) => projectPoint(node.lat, node.lon, center))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
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
        sidewalkW: Number(tags.sidewalk_width) || profile.sidewalk,
        asphaltWidth: (Number(tags.width) || (Math.max(1, Number(tags.lanes) || profile.lanes) * profile.laneW)),
        oneway: tags.oneway === 'yes' ? 'increasing'
          : tags.oneway === '-1' ? 'decreasing'
            : tags.junction === 'roundabout' ? 'increasing' : 'both',
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
        material: inferMaterial(tags, type),
        facade: inferFacade(tags, type),
        landmark: Boolean(tags.amenity || tags.tourism || tags.building === 'public'),
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

  // Signals where roads converge.
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
  for (const [key, hits] of junctionKeys) {
    if (hits.length < 2) continue;
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
  for (const street of streets) {
    street.blocks = blocks.filter((b) => b.streets.includes(street.id)).map((b) => b.id);
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
