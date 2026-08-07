import { CITY_SCHEMA_VERSION, hashString, terrainHeight } from './core.js';

const DATA_URL = '/data/sf/sf-city.json.gz';
const DATA_FALLBACK_URL = '/data/sf/sf-city.json';
const ELEVATION_URL = '/data/sf/sf-elevation.json';
const ELEVATION_FALLBACK_URL = '/data/sf/sf-elevation.json.gz';

/**
 * Load the repo's prebuilt real San Francisco OSM slice and convert it to the
 * CityGen metadata model. The full city is 70k+ buildings, so we select a
 * bounded district slice that stays realtime-renderable.
 */
export async function loadSfData({ center = [1600, 400], radius = 720, maxBuildings = 900 } = {}) {
  const json = await fetchWithFallback();
  let elevation = null;
  try {
    elevation = await fetchElevation();
  } catch {
    elevation = null;
  }
  const detail = json.detailBuildings || [];
  const roads = json.roads || [];
  const signals = json.signals || [];
  const green = json.parks || json.green || json.landuse || [];
  const buildings = [];
  const roadSlice = [];

  for (const road of roads) {
    const points = flatToPoints(road.points);
    if (points.length < 2) continue;
    const mid = points[Math.floor(points.length / 2)];
    if (Math.hypot(mid.x - center[0], mid.z - center[1]) > radius * 1.25) continue;
    roadSlice.push(road);
  }
  for (const building of detail) {
    if (buildings.length >= maxBuildings) break;
    const centroid = building.centroid || [
      (Math.min(...building.points.filter((_, i) => i % 2 === 0)) + Math.max(...building.points.filter((_, i) => i % 2 === 0))) / 2,
      (Math.min(...building.points.filter((_, i) => i % 2 === 1)) + Math.max(...building.points.filter((_, i) => i % 2 === 1))) / 2,
    ];
    if (Math.hypot(centroid[0] - center[0], centroid[1] - center[1]) > radius) continue;
    buildings.push(building);
  }

  const cityBuildings = buildings.map((building) => {
    const polygon = flatToPoints(building.points);
    if (polygon.length < 3) polygon.push(polygon[0]);
    const area = polygonArea(polygon);
    const height = Number(building.height) || (Number(building.levels) || defaultLevels(area)) * 3.2;
    const type = inferType(building);
    return {
      id: `sf-building-${building.id}`,
      blockId: '',
      district: 'San Francisco',
      type,
      typeLabel: type,
      usage: inferUsage(type),
      name: building.name || '',
      address: building.addr || '',
      polygon,
      height: Math.max(3, height),
      stories: Math.max(1, Math.round(height / 3.2)),
      footprintArea: area,
      yearBuilt: 1900,
      density: 0.9,
      material: inferMaterial(building, type),
      facade: inferFacade(building, type),
      landmark: Boolean(building.name && (building.amenity || building.tourism)),
      shop: building.shop ? String(building.shop) : '',
      amenity: building.amenity ? String(building.amenity) : '',
      tourism: building.tourism ? String(building.tourism) : '',
      roofShape: building.roofShape || '',
      facingStreet: '',
    };
  });

  const streets = [];
  const segments = [];
  for (const road of roadSlice) {
    const points = flatToPoints(road.points);
    const highway = normalizeHighway(road.highway);
    const lanes = Math.max(1, Number(road.lanes) || (highway === 'residential' ? 2 : 4));
    const sidewalkW = road.sidewalk === 'no' ? 0 : highway === 'residential' ? 2.2 : highway === 'service' ? 0.8 : 2.5;
    const streetId = `sf-street-${road.id}`;
    const street = {
      id: streetId,
      name: road.name || `SF Rd ${road.id}`,
      highway,
      lanes,
      oneway: road.oneway ? (road.oneway === -1 ? 'decreasing' : 'increasing') : 'both',
      sidewalkW,
      maxspeed: road.maxspeed ? String(road.maxspeed) : '',
      cycleway: road.cycleway ? String(road.cycleway) : '',
      asphaltWidth: lanes * 3.2,
      orientation: 'osm',
      axis: 'osm',
      position: 0,
      blocks: [],
      signalIds: [],
    };
    streets.push(street);
    for (let i = 0; i < points.length - 1; i += 1) {
      segments.push({
        id: `sf-seg-${segments.length}`,
        streetId,
        streetName: street.name,
        highway,
        lanes,
        oneway: street.oneway,
        width: street.asphaltWidth,
        sidewalkW,
        points: [points[i], points[i + 1]],
        signalId: null,
        intersectionId: null,
        maxspeed: street.maxspeed || '',
        cycleway: street.cycleway || '',
      });
    }
  }

  // Block grouping via 80m cells.
  const blockMap = new Map();
  const blocks = [];
  for (const building of cityBuildings) {
    const [x, z] = centroidOf(building.polygon);
    const key = `${Math.floor(x / 80)}-${Math.floor(z / 80)}`;
    let block = blockMap.get(key);
    if (!block) {
      block = { id: `sf-block-${blocks.length}`, district: 'San Francisco', polygon: [], streets: [], buildings: [], landUse: 'mixed' };
      blockMap.set(key, block);
      blocks.push(block);
    }
    block.buildings.push(building.id);
    building.blockId = block.id;
  }
  for (const building of cityBuildings) {
    const [cx, cz] = centroidOf(building.polygon);
    building.facingStreet = nearestStreetName(segments, { x: cx, z: cz }, 28) || '';
  }
  for (const block of blocks) {
    const points = block.buildings.map((id) => cityBuildings.find((b) => b.id === id)).filter(Boolean).flatMap((b) => b.polygon);
    const minX = Math.min(...points.map((p) => p.x)) - 8;
    const maxX = Math.max(...points.map((p) => p.x)) + 8;
    const minZ = Math.min(...points.map((p) => p.z)) - 8;
    const maxZ = Math.max(...points.map((p) => p.z)) + 8;
    block.polygon = [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
    block.streets = [];
  }

  // Signals near district roads.
  const intersections = [];
  const districtSignals = [];
  for (const signal of signals.slice(0, 120)) {
    const x = signal[0];
    const z = signal[1];
    if (Math.hypot(x - center[0], z - center[1]) > radius * 1.3) continue;
    const streetIds = nearbyStreetIds(segments, x, z, 10);
    if (!streetIds.length) continue;
    const intersection = { id: `sf-int-${intersections.length}`, position: { x, z }, streetIds };
    intersections.push(intersection);
    districtSignals.push({
      id: `sf-sig-${districtSignals.length}`,
      intersectionId: intersection.id,
      streetIds,
      position: { x: x - 3, z: z - 3 },
      heading: 'north',
      phaseOffset: 0,
      period: 8,
    });
    intersection.signalId = districtSignals[districtSignals.length - 1].id;
    intersection.signal = districtSignals[districtSignals.length - 1];
    for (const streetId of streetIds) {
      const street = streets.find((s) => s.id === streetId);
      if (street && !street.signalIds.includes(intersection.signalId)) street.signalIds.push(intersection.signalId);
    }
  }

  const allPoints = [...segments.flatMap((s) => s.points), ...cityBuildings.flatMap((b) => b.polygon)];
  const minX = Math.min(...allPoints.map((p) => p.x)) - 30;
  const maxX = Math.max(...allPoints.map((p) => p.x)) + 30;
  const minZ = Math.min(...allPoints.map((p) => p.z)) - 30;
  const maxZ = Math.max(...allPoints.map((p) => p.z)) + 30;
  const seedInt = hashString('san-francisco-builtin');
  const elevationGrid = elevation;
  const heightAt = (x, z) => {
    if (elevationGrid) {
      const gx = Math.floor((x - elevationGrid.originX) / elevationGrid.cellSize);
      const gz = Math.floor((z - elevationGrid.originZ) / elevationGrid.cellSize);
      if (gx >= 0 && gx < elevationGrid.width && gz >= 0 && gz < elevationGrid.height) {
        const value = elevationGrid.grid[gz * elevationGrid.width + gx];
        if (Number.isFinite(value)) return value * 0.28;
      }
    }
    return terrainHeight(x, z, seedInt) * 0.05;
  };
  const parks = [];
  const water = [];
  for (const area of green) {
    if (!area || !Array.isArray(area.points)) continue;
    const points = flatToPoints(area.points);
    if (points.length < 3) continue;
    const cx = (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2;
    const cz = (Math.min(...points.map((p) => p.z)) + Math.max(...points.map((p) => p.z))) / 2;
    if (Math.hypot(cx - center[0], cz - center[1]) > radius * 1.35) continue;
    const kind = String(area.kind || area.landuse || area.leisure || 'park').toLowerCase();
    if (kind === 'water' || kind === 'bay' || kind === 'beach') {
      water.push({ id: `sf-water-${water.length}`, name: area.name || '', polygon: points, kind });
    } else {
      parks.push({ id: `sf-park-${parks.length}`, name: area.name || '', polygon: points, kind });
    }
  }
  return {
    schemaVersion: CITY_SCHEMA_VERSION,
    meta: {
      name: 'San Francisco (real OSM)',
      seed: 'sf-builtin',
      seedInt,
      style: 'osm',
      generator: 'sf-builtin',
      center: { x: center[0], z: center[1] },
      bounds: { minX, maxX, minZ, maxZ },
      terrain: { type: 'sf-flat', flattenNearRoads: false },
      streetDesign: { streetScale: 1, sidewalkScale: 1, curbHeight: 0.16, roadLift: 0.45 },
      generatedAt: new Date().toISOString(),
    },
    blocks,
    buildings: cityBuildings,
    streets,
    segments,
    intersections,
    signals: districtSignals,
    parks,
    water,
    terrain: {
      type: 'sf-elevation',
      seed: seedInt,
      flattenNearRoads: true,
      heightAt,
    },
  };
}

async function fetchWithFallback() {
  try {
    const response = await fetch(DATA_URL, { headers: { 'Accept-Encoding': 'gzip' } });
    if (response.ok) return await response.json();
  } catch {
    // fall through
  }
  const response = await fetch(DATA_FALLBACK_URL);
  if (!response.ok) throw new Error(`SF data load failed: ${response.status}`);
  return response.json();
}

async function fetchElevation() {
  try {
    const response = await fetch(ELEVATION_URL, { headers: { 'Accept-Encoding': 'gzip' } });
    if (response.ok) {
      const json = await response.json();
      if (Array.isArray(json?.grid)) return json;
    }
  } catch {
    // fall through
  }
  const response = await fetch(ELEVATION_FALLBACK_URL);
  if (!response.ok) throw new Error(`SF elevation load failed: ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  const decompressed = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(decompressed);
}

function flatToPoints(flat) {
  const points = [];
  for (let i = 0; i < flat.length - 1; i += 2) {
    const x = Number(flat[i]);
    const z = Number(flat[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(z)) points.push({ x, z });
  }
  return points;
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

function centroidOf(points) {
  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
}

function defaultLevels(area) {
  if (area > 2600) return 8;
  if (area > 1200) return 5;
  if (area > 450) return 3;
  return 2;
}

function normalizeHighway(highway) {
  const value = String(highway || '').toLowerCase();
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'pedestrian'].includes(value)) return value;
  return 'residential';
}

function inferType(building) {
  if (building.amenity || building.tourism || building.name === 'Transamerica Pyramid') return 'civic';
  const buildingType = String(building.building || '');
  if (buildingType.includes('warehouse')) return 'warehouse';
  if (Number(building.levels || 0) >= 7 || (building.height || 0) >= 24) return 'tower';
  if (buildingType.includes('retail') || building.shop) return 'shop';
  return buildingType.includes('residential') ? 'rowhouse' : 'midrise';
}

function inferUsage(type) {
  return type === 'tower' ? 'office'
    : type === 'rowhouse' ? 'residential'
      : type === 'civic' ? 'civic'
        : type === 'warehouse' ? 'industrial' : 'retail';
}

function inferMaterial(building, type) {
  const material = String(building.material || '').toLowerCase();
  if (material.includes('brick')) return 'brick';
  if (material.includes('concrete')) return 'concrete';
  if (material.includes('wood')) return 'clapboard';
  if (material.includes('stone')) return 'stone';
  const hash = hashString(`sf-material-${building.id}-${building.name || ''}`);
  if (type === 'rowhouse') {
    return ['painted', 'painted', 'clapboard', 'brick', 'plaster', 'stone'][hash % 6];
  }
  if (type === 'shop') {
    return ['painted', 'brick', 'plaster', 'stone', 'clapboard', 'brick'][hash % 6];
  }
  if (type === 'tower') {
    return ['glass', 'concrete', 'brick', 'painted', 'glass', 'concrete'][hash % 6];
  }
  if (type === 'civic') {
    return ['stone', 'stone', 'concrete', 'painted', 'brick', 'plaster'][hash % 6];
  }
  if (type === 'warehouse') {
    return ['brick', 'brick', 'concrete', 'painted', 'stone', 'plaster'][hash % 6];
  }
  return ['painted', 'brick', 'concrete', 'glass', 'stone', 'plaster'][hash % 6];
}

function inferFacade(building, type) {
  const name = String(building.name || '');
  if (name.includes('Transamerica') || type === 'landmark') return 'art-deco';
  if (building.shop || String(building.building).includes('retail')) return 'shopfront';
  if (String(building.amenity || '') === 'place_of_worship') return 'edwardian';
  const hash = hashString(`sf-facade-${building.id}-${building.name || ''}`);
  if (type === 'rowhouse') return hash % 2 === 0 ? 'bay-window' : 'edwardian';
  if (type === 'shop') return 'shopfront';
  if (type === 'tower') return hash % 2 === 0 ? 'modern-grid' : 'loft';
  if (type === 'civic') return hash % 2 === 0 ? 'edwardian' : 'art-deco';
  if (type === 'warehouse') return hash % 2 === 0 ? 'loft' : 'modern-grid';
  return ['modern-grid', 'shopfront', 'loft', 'art-deco', 'bay-window'][hash % 5];
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

function nearestStreetName(segments, point, maxDistance = 40) {
  let best = null;
  let bestDistance = maxDistance;
  for (const segment of segments) {
    if (!segment.streetName) continue;
    const a = segment.points[0];
    const b = segment.points[segment.points.length - 1];
    const distance = pointToSegmentDistance(point, a, b);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = segment.streetName;
    }
  }
  return best;
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
