import { CITY_SCHEMA_VERSION, hashString, terrainHeight } from './core.js';

const DATA_URL = '/data/sf/sf-city.json.gz';
const DATA_FALLBACK_URL = '/data/sf/sf-city.json';

/**
 * Load the repo's prebuilt real San Francisco OSM slice and convert it to the
 * CityGen metadata model. The full city is 70k+ buildings, so we select a
 * bounded district slice that stays realtime-renderable.
 */
export async function loadSfData({ center = [1600, 400], radius = 720, maxBuildings = 900 } = {}) {
  const json = await fetchWithFallback();
  const detail = json.detailBuildings || [];
  const roads = json.roads || [];
  const signals = json.signals || [];
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
      material: inferMaterial(building),
      facade: inferFacade(building),
      landmark: Boolean(building.name && (building.amenity || building.tourism)),
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
  }

  const allPoints = [...segments.flatMap((s) => s.points), ...cityBuildings.flatMap((b) => b.polygon)];
  const minX = Math.min(...allPoints.map((p) => p.x)) - 30;
  const maxX = Math.max(...allPoints.map((p) => p.x)) + 30;
  const minZ = Math.min(...allPoints.map((p) => p.z)) - 30;
  const maxZ = Math.max(...allPoints.map((p) => p.z)) + 30;
  const seedInt = hashString('san-francisco-builtin');
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
    terrain: { type: 'sf-flat', seed: seedInt, heightAt: (x, z) => terrainHeight(x, z, seedInt) * 0.05 },
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

function inferMaterial(building) {
  const material = String(building.material || '').toLowerCase();
  if (material.includes('brick')) return 'brick';
  if (material.includes('concrete')) return 'concrete';
  if (material.includes('wood')) return 'clapboard';
  if (material.includes('stone')) return 'stone';
  if (Number(building.levels || 0) >= 8) return 'glass';
  return 'plaster';
}

function inferFacade(building) {
  const name = String(building.name || '');
  if (name.includes('Transamerica')) return 'art-deco';
  if (building.shop || String(building.building).includes('retail')) return 'shopfront';
  if (String(building.amenity || '') === 'place_of_worship') return 'edwardian';
  return Number(building.levels || 0) >= 8 ? 'modern-grid' : 'bay-window';
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
