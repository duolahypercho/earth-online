/**
 * CityGen core — deterministic procedural city + rich metadata model.
 *
 * The generated city is intentionally city-agnostic ("any city"): district
 * names, street naming, and zoning are driven by a seeded style profile so
 * the same generator can make SF-flavored, grid, garden-city, or old-town
 * maps. Real OSM cities are converted into this same model by osm.js.
 */

export const CITY_SCHEMA_VERSION = 1;

export const HIGHWAY_PROFILE = Object.freeze({
  motorway: { lanes: 4, laneW: 3.5, sidewalk: 0, class: 'motorway' },
  trunk: { lanes: 4, laneW: 3.4, sidewalk: 1.6, class: 'trunk' },
  primary: { lanes: 4, laneW: 3.3, sidewalk: 2.6, class: 'primary' },
  secondary: { lanes: 3, laneW: 3.25, sidewalk: 2.5, class: 'secondary' },
  tertiary: { lanes: 2, laneW: 3.2, sidewalk: 2.4, class: 'tertiary' },
  unclassified: { lanes: 2, laneW: 3.15, sidewalk: 2.3, class: 'unclassified' },
  residential: { lanes: 2, laneW: 3.1, sidewalk: 2.3, class: 'residential' },
  living_street: { lanes: 2, laneW: 2.9, sidewalk: 2.2, class: 'living_street' },
  service: { lanes: 1, laneW: 3.0, sidewalk: 0.8, class: 'service' },
  pedestrian: { lanes: 1, laneW: 3.4, sidewalk: 0, class: 'pedestrian' },
  footway: { lanes: 1, laneW: 2.0, sidewalk: 0, class: 'footway' },
  cycleway: { lanes: 1, laneW: 2.2, sidewalk: 0, class: 'cycleway' },
});

export const BUILDING_TYPES = Object.freeze({
  // These are real-ish story counts. The old minimums produced 6-13 m
  // buildings next to full-size cars, which read as toys; the floor is
  // raised so the massing reads like a city from the sidewalk.
  tower: { label: 'Tower', heights: [8, 18], density: 0.82 },
  midrise: { label: 'Mid-rise', heights: [4, 9], density: 0.9 },
  rowhouse: { label: 'Rowhouse', heights: [3, 5], density: 0.88 },
  warehouse: { label: 'Warehouse', heights: [2, 4], density: 0.78 },
  shop: { label: 'Shopfront', heights: [2, 4], density: 0.72 },
  civic: { label: 'Civic', heights: [3, 7], density: 0.95 },
  landmark: { label: 'Landmark', heights: [9, 20], density: 1.0 },
  park: { label: 'Park', heights: [0, 0], density: 0 },
});

/** Deterministic PRNG used for every city seed. */
export function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(value = '') {
  let hash = 2166136261;
  for (let i = 0; i < String(value).length; i += 1) {
    hash ^= String(value).charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function ringArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area / 2);
}

export function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonBounds(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

export function rectPolygon(minX, maxX, minZ, maxZ) {
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
}

/**
 * Smooth periodic terrain. Deterministic, bounded, and cheap enough to call
 * per-vertex at build time.
 */
export function terrainHeight(x, z, seed) {
  const sx = Math.sin(x * 0.0061 + seed * 0.13) * 0.5
    + Math.sin(x * 0.0141 + z * 0.0047 + seed * 0.071) * 0.5;
  const sz = Math.sin(z * 0.0053 + seed * 0.19) * 0.6
    + Math.sin(x * 0.0037 + z * 0.0111 + seed * 0.043) * 0.4;
  const s2 = Math.sin((x + z) * 0.0023 + seed * 0.31) * 0.8
    + Math.sin((x - z) * 0.0031 + seed * 0.17) * 0.7;
  return (sx * 4.2 + sz * 5.4 + s2 * 6.5) * 0.32 + 2.2;
}

function smooth(value, a, b) {
  if (value <= a) return 0;
  if (value >= b) return 1;
  const t = (value - a) / (b - a);
  return t * t * (3 - 2 * t);
}

function flattenTerrain(x, z, seed, streetLines) {
  let flatten = 0;
  const threshold = 7.5;
  const hard = 2.2;
  for (const line of streetLines) {
    const d = distanceToSegment({ x, z }, line.a, line.b);
    const influence = 1 - smooth(d, hard, threshold);
    if (influence > flatten) flatten = influence;
  }
  const t = smooth(flatten, 0.1, 1);
  return terrainHeight(x, z, seed) * (1 - t * 0.62);
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

function makeStreetLines(vertical, horizontal) {
  const lines = [];
  for (const x of vertical) lines.push({ a: { x, z: horizontal[0] }, b: { x, z: horizontal[horizontal.length - 1] } });
  for (const z of horizontal) lines.push({ a: { x: vertical[0], z }, b: { x: vertical[vertical.length - 1], z } });
  return lines;
}

function pickStreetNames(random, style, index, isVertical) {
  const verticalNames = style.verticalNames;
  const horizontalNames = style.horizontalNames;
  if (isVertical) {
    const named = verticalNames[index];
    if (named) return named;
    return `${index + 1}${index === 0 ? 'st' : index === 1 ? 'nd' : index === 2 ? 'rd' : 'th'} Ave`;
  }
  const named = horizontalNames[index];
  if (named) return named;
  return `${style.namePrefix} ${String.fromCharCode(65 + (index % 26))} St`;
}

function classifyRoad(type) {
  const profile = HIGHWAY_PROFILE[type] || HIGHWAY_PROFILE.residential;
  return {
    highway: profile.class,
    lanes: profile.lanes,
    laneW: profile.laneW,
    sidewalkW: profile.sidewalk,
    asphaltWidth: profile.lanes * profile.laneW,
  };
}

function buildGridStreets(city, random, style) {
  const vertical = [];
  const horizontal = [];
  const vCount = 9 + Math.floor(random() * 3);
  const hCount = 10 + Math.floor(random() * 3);
  let x = -style.extent / 2;
  let z = -style.extent / 2;
  for (let i = 0; i < vCount; i += 1) {
    vertical.push(Math.round(x));
    x += 54 + random() * 34;
  }
  for (let i = 0; i < hCount; i += 1) {
    horizontal.push(Math.round(z));
    z += 48 + random() * 34;
  }
  // Push the last streets near the intended edge so the map is tidy.
  if (vertical.length > 1) vertical[vertical.length - 1] = Math.round(style.extent / 2);
  if (horizontal.length > 1) horizontal[horizontal.length - 1] = Math.round(style.extent / 2);

  const streets = [];
  const vNames = vertical.map((value, index) => ({
    id: `v-${index}`,
    name: pickStreetNames(random, style, index, true),
    orientation: 'vertical',
    axis: 'x',
    position: value,
  }));
  const hNames = horizontal.map((value, index) => ({
    id: `h-${index}`,
    name: pickStreetNames(random, style, index, false),
    orientation: 'horizontal',
    axis: 'z',
    position: value,
  }));

  for (let i = 0; i < vertical.length; i += 1) {
    const type = i === Math.floor(vertical.length / 2) ? 'primary'
      : i === 0 || i === vertical.length - 1 ? 'tertiary'
        : random() < 0.16 ? 'secondary' : 'residential';
    streets.push({
      ...vNames[i],
      highway: type,
      ...classifyRoad(type),
      oneway: random() < 0.22 ? (random() < 0.5 ? 'increasing' : 'decreasing') : 'both',
      blocks: [],
      signalIds: [],
    });
  }
  for (let i = 0; i < horizontal.length; i += 1) {
    const type = i === Math.floor(horizontal.length / 2) ? 'secondary'
      : i === 0 || i === horizontal.length - 1 ? 'tertiary'
        : random() < 0.14 ? 'secondary' : 'residential';
    streets.push({
      ...hNames[i],
      highway: type,
      ...classifyRoad(type),
      oneway: random() < 0.2 ? (random() < 0.5 ? 'increasing' : 'decreasing') : 'both',
      blocks: [],
      signalIds: [],
    });
  }
  return { streets, vertical, horizontal, streetLines: makeStreetLines(vertical, horizontal) };
}

function assignDistrict(ix, iy, vCount, hCount, style) {
  const east = ix / Math.max(1, vCount - 1);
  const north = 1 - iy / Math.max(1, hCount - 1);
  if (east > 0.62 && north > 0.55) return style.districts[0] || 'North Beach';
  if (east > 0.55 && north > 0.25) return style.districts[1] || 'Financial';
  if (east > 0.45 && north <= 0.25) return style.districts[2] || 'SoMa';
  if (east <= 0.45 && north <= 0.45) return style.districts[3] || 'Mission';
  if (east <= 0.35 && north > 0.6) return style.districts[4] || 'Presidio';
  return style.districts[5] || 'Sunset';
}

function buildingHeightFor(type, random, district, iy, hCount) {
  const spec = BUILDING_TYPES[type];
  let min = spec.heights[0];
  let max = spec.heights[1];
  if (type === 'tower' && district === 'Financial') {
    min = 8;
    max = 17;
  } else if (type === 'tower' && district === 'SoMa') {
    min = 6;
    max = 13;
  } else if ((type === 'midrise' || type === 'shop') && district === 'North Beach') {
    max = Math.min(max, 5);
  }
  if (iy === hCount - 2 && type === 'landmark') {
    min = 12;
    max = 18;
  }
  const stories = Math.round(min + random() * (max - min));
  return {
    stories,
    height: stories * (type === 'warehouse' ? 3.4 : type === 'tower' ? 3.8 : 3.15) + (random() < 0.35 ? 1.5 : 0),
  };
}

function buildBlocksAndBuildings(city, random, style, grid) {
  const { streets, vertical, horizontal } = grid;
  const byAxis = { x: [], z: [] };
  for (const street of streets) {
    byAxis[street.axis].push(street);
  }
  const vSorted = [...byAxis.x].sort((a, b) => a.position - b.position);
  const hSorted = [...byAxis.z].sort((a, b) => a.position - b.position);
  const blocks = [];
  const buildings = [];
  let blockId = 0;
  let buildingId = 0;

  const landmarkCells = new Set();
  const parkIndex = Math.floor(random() * 5);
  const towerIx = Math.floor(vSorted.length * 0.68);
  const towerIy = Math.floor(hSorted.length * 0.32);
  landmarkCells.add(`${towerIx}-${towerIy}`);
  landmarkCells.add(`${Math.floor(vSorted.length * 0.5)}-${Math.floor(hSorted.length * 0.5)}`);

  for (let ix = 0; ix < vSorted.length - 1; ix += 1) {
    for (let iy = 0; iy < hSorted.length - 1; iy += 1) {
      const west = vSorted[ix];
      const east = vSorted[ix + 1];
      const south = hSorted[iy];
      const north = hSorted[iy + 1];
      const district = assignDistrict(ix, iy, vSorted.length, hSorted.length, style);
      const block = {
        id: `b-${blockId}`,
        district,
        polygon: rectPolygon(
          west.position + west.asphaltWidth / 2 + west.sidewalkW + 1.2,
          east.position - east.asphaltWidth / 2 - east.sidewalkW - 1.2,
          south.position + south.asphaltWidth / 2 + south.sidewalkW + 1.2,
          north.position - north.asphaltWidth / 2 - north.sidewalkW - 1.2,
        ),
        streets: [west.id, east.id, south.id, north.id],
        buildings: [],
      };
      blockId += 1;
      if (block.polygon[0].x >= block.polygon[1].x - 4 || block.polygon[0].z >= block.polygon[3].z - 4) continue;
      blocks.push(block);

      const isPark = `${ix}-${iy}` === `${Math.floor(vSorted.length * 0.28)}-${parkIndex}` && iy < hSorted.length - 3;
      const isLandmark = landmarkCells.has(`${ix}-${iy}`);
      const cellKey = `${ix}-${iy}`;
      if (isPark) {
        block.landUse = 'park';
        block.buildings = [];
        continue;
      }

      // Subdivide the block into parcels along its longest side.
      const w = block.polygon[1].x - block.polygon[0].x;
      const d = block.polygon[3].z - block.polygon[0].z;
      const alongX = w >= d;
      const divisions = Math.min(6, 2 + Math.floor(random() * 4));
      const cuts = [];
      let cursor = 0;
      for (let i = 0; i < divisions; i += 1) {
        const frac = (i + 1) / divisions;
        const jitter = (random() - 0.5) * 0.09;
        const next = clamp(frac + jitter, 0.06, 0.94);
        cuts.push(Math.max(cursor + 0.035, next));
        cursor = next;
      }
      const parcelRects = [];
      let start = 0;
      for (let i = 0; i < divisions; i += 1) {
        const end = i === divisions - 1 ? 1 : cuts[i];
        if (alongX) {
          parcelRects.push({
            minX: block.polygon[0].x + (block.polygon[1].x - block.polygon[0].x) * start,
            maxX: block.polygon[0].x + (block.polygon[1].x - block.polygon[0].x) * end,
            minZ: block.polygon[0].z,
            maxZ: block.polygon[3].z,
          });
        } else {
          parcelRects.push({
            minX: block.polygon[0].x,
            maxX: block.polygon[1].x,
            minZ: block.polygon[0].z + (block.polygon[3].z - block.polygon[0].z) * start,
            maxZ: block.polygon[0].z + (block.polygon[3].z - block.polygon[0].z) * end,
          });
        }
        start = end;
      }

      for (let p = 0; p < parcelRects.length; p += 1) {
        const rect = parcelRects[p];
        const parcelW = rect.maxX - rect.minX;
        const parcelD = rect.maxZ - rect.minZ;
        if (parcelW < 6 || parcelD < 6) continue;
        const roll = random();
        let type = 'midrise';
        if (district === 'Financial' || district === 'SoMa') {
          type = roll < 0.4 ? 'tower' : roll < 0.62 ? 'midrise' : roll < 0.86 ? 'shop' : 'warehouse';
        } else if (district === 'North Beach' || district === 'Mission') {
          type = roll < 0.52 ? 'rowhouse' : roll < 0.7 ? 'midrise' : roll < 0.88 ? 'shop' : 'warehouse';
        } else if (district === 'Presidio' || district === 'Sunset') {
          type = roll < 0.66 ? 'rowhouse' : roll < 0.84 ? 'midrise' : 'shop';
        }
        if (isLandmark) {
          type = cellKey === `${towerIx}-${towerIy}` ? 'landmark' : 'civic';
        }
        const spec = BUILDING_TYPES[type];
        const heightInfo = buildingHeightFor(type, random, district, iy, hSorted.length);
        const inset = type === 'rowhouse' ? 1.1 : type === 'shop' ? 1.4 : 0.8;
        const setFront = 1.8 + random() * 2.4;
        const setBack = type === 'rowhouse' ? 2.2 + random() * 2.4 : 1.6 + random() * 2.2;
        const setSide = 1.2 + random() * 1.6;
        const footprint = {
          minX: rect.minX + setSide,
          maxX: rect.maxX - (rect.maxX - rect.minX > 15 ? setSide : 0.4),
          minZ: rect.minZ + setBack,
          maxZ: rect.maxZ - setFront,
        };
        if (footprint.maxX - footprint.minX < 4 || footprint.maxZ - footprint.minZ < 4) continue;
        const polygon = rectPolygon(footprint.minX, footprint.maxX, footprint.minZ, footprint.maxZ);
        const building = {
          id: `bu-${buildingId}`,
          blockId: block.id,
          district,
          type,
          typeLabel: spec.label,
          usage: type === 'tower' ? 'office'
            : type === 'rowhouse' ? 'residential'
              : type === 'civic' ? 'civic'
                : type === 'landmark' ? 'landmark'
                  : type === 'warehouse' ? 'industrial' : 'retail',
          name: landmarkName(type, district, buildingId, random),
          polygon,
          ...heightInfo,
          footprintArea: ringArea(polygon),
          yearBuilt: 1875 + Math.floor(random() * 145),
          density: spec.density,
          material: style.materials[Math.floor(random() * style.materials.length)],
          facade: style.facades[Math.floor(random() * style.facades.length)],
          landmark: isLandmark,
          facingStreet: p === 0 ? south.name : p === parcelRects.length - 1 ? north.name : (random() < 0.5 ? west.name : east.name),
        };
        buildings.push(building);
        block.buildings.push(building.id);
        buildingId += 1;
      }
    }
  }
  return { blocks, buildings };
}

function landmarkName(type, district, index, random) {
  if (type === 'landmark') {
    const names = ['Transamerica Spire', 'Bayview Beacon', 'City Pavilion', 'Summit Exchange'];
    return names[index % names.length];
  }
  if (type === 'civic') {
    const names = ['Civic Hall', 'Central Library', 'County Museum', 'Transit Hub'];
    return names[Math.floor(random() * names.length)];
  }
  return '';
}

function buildSignalsAndIntersections(city, random, grid) {
  const { streets, vertical, horizontal } = grid;
  const vSorted = streets.filter((s) => s.axis === 'x').sort((a, b) => a.position - b.position);
  const hSorted = streets.filter((s) => s.axis === 'z').sort((a, b) => a.position - b.position);
  const intersections = [];
  const signals = [];
  let signalId = 0;
  const majorV = new Set(vSorted.filter((s) => s.highway === 'primary' || s.highway === 'secondary').map((s) => s.id));
  const majorH = new Set(hSorted.filter((s) => s.highway === 'primary' || s.highway === 'secondary').map((s) => s.id));
  for (const v of vSorted) {
    for (const h of hSorted) {
      const intersection = {
        id: `i-${v.id}-${h.id}`,
        position: { x: v.position, z: h.position },
        streetIds: [v.id, h.id],
      };
      intersections.push(intersection);
      v.signalIds.push(null);
      h.signalIds.push(null);
      if ((majorV.has(v.id) && majorH.has(h.id)) || (v.highway === 'primary' && h.highway !== 'service')) {
        const signal = {
          id: `s-${signalId}`,
          intersectionId: intersection.id,
          streetIds: [v.id, h.id],
          position: { x: v.position - 3.2, z: h.position - 3.2 },
          heading: v.position > 0 ? 'north' : 'west',
          phaseOffset: Math.round(random() * 3) / 4,
          period: 8,
        };
        signals.push(signal);
        intersection.signalId = signal.id;
        intersection.signal = signal;
        v.signalIds[v.signalIds.length - 1] = signal.id;
        h.signalIds[h.signalIds.length - 1] = signal.id;
        signalId += 1;
      }
    }
  }
  return { intersections, signals };
}

function buildRoadSegments(city, grid, intersections) {
  const { streets, vertical, horizontal } = grid;
  const vSorted = streets.filter((s) => s.axis === 'x').sort((a, b) => a.position - b.position);
  const hSorted = streets.filter((s) => s.axis === 'z').sort((a, b) => a.position - b.position);
  const segments = [];
  let segmentId = 0;
  for (const v of vSorted) {
    for (let i = 0; i < hSorted.length - 1; i += 1) {
      const a = { x: v.position, z: hSorted[i].position };
      const b = { x: v.position, z: hSorted[i + 1].position };
      const intersection = intersections.find((it) => it.position.x === a.x && it.position.z === a.z);
      segments.push({
        id: `seg-v-${segmentId++}`,
        streetId: v.id,
        streetName: v.name,
        highway: v.highway,
        lanes: v.lanes,
        oneway: v.oneway,
        width: v.asphaltWidth,
        sidewalkW: v.sidewalkW,
        points: [a, b],
        signalId: intersection?.signal?.id || null,
        intersectionId: intersection?.id || null,
      });
    }
  }
  for (const h of hSorted) {
    for (let i = 0; i < vSorted.length - 1; i += 1) {
      const a = { x: vSorted[i].position, z: h.position };
      const b = { x: vSorted[i + 1].position, z: h.position };
      const intersection = intersections.find((it) => it.position.x === a.x && it.position.z === a.z);
      segments.push({
        id: `seg-h-${segmentId++}`,
        streetId: h.id,
        streetName: h.name,
        highway: h.highway,
        lanes: h.lanes,
        oneway: h.oneway,
        width: h.asphaltWidth,
        sidewalkW: h.sidewalkW,
        points: [a, b],
        signalId: intersection?.signal?.id || null,
        intersectionId: intersection?.id || null,
      });
    }
  }
  return segments;
}

/**
 * Generate a city as plain data. Every visual, block, street, and signal is
 * derived from `seed`, so the same seed always produces the same map.
 */
export function generateCity({ seed = 731, style = 'sanfrancisco', extent = 640 } = {}) {
  const seedInt = Math.abs(hashString(String(seed)) % 2147483647) || 731;
  const random = mulberry32(seedInt);
  const styles = {
    sanfrancisco: {
      name: 'San Francisco',
      districts: ['North Beach', 'Financial', 'SoMa', 'Mission', 'Presidio', 'Sunset'],
      verticalNames: ['Presidio Ave', 'Van Ness Blvd', 'Gough St', 'Franklin St', 'Polk St', '1st Ave', '3rd Ave', '5th Ave', '8th Ave', 'Great Hwy'],
      horizontalNames: ['Chestnut St', 'Green St', 'Union St', 'Market St', 'Mission St', 'Valencia St', 'Castro St', 'Haight St', 'Divisadero St', 'Taraval St'],
      materials: ['plaster', 'brick', 'concrete', 'clapboard', 'glass', 'stone'],
      facades: ['edwardian', 'modern-grid', 'bay-window', 'shopfront', 'loft', 'art-deco'],
      namePrefix: 'Civic',
      extent,
      density: 1.15,
    },
    gridiron: {
      name: 'Grid City',
      districts: ['Old Town', 'Midtown', 'Southside', 'Eastside', 'Northside', 'Westend'],
      verticalNames: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
      horizontalNames: ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'],
      materials: ['brick', 'stone', 'concrete', 'plaster'],
      facades: ['modern-grid', 'shopfront', 'loft', 'art-deco'],
      namePrefix: 'Main',
      extent,
      density: 0.9,
    },
    garden: {
      name: 'Garden City',
      districts: ['Grove', 'Meadow', 'Orchard', 'River', 'Hillcrest', 'Fairview'],
      verticalNames: ['Willow Ave', 'Cedar Ave', 'Birch Ave', 'Oak Ave', 'Maple Ave', 'Pine Ave'],
      horizontalNames: ['Meadow St', 'Orchard St', 'River St', 'Grove St', 'Hillcrest St'],
      materials: ['clapboard', 'stone', 'plaster', 'brick'],
      facades: ['edwardian', 'bay-window', 'shopfront'],
      namePrefix: 'Cedar',
      extent,
      density: 0.7,
    },
  };
  const styleProfile = styles[style] || styles.sanfrancisco;
  const grid = buildGridStreets(null, random, styleProfile);
  // Apply real street proportions before blocks are carved: full-size cars
  // need curb-to-curb asphalt, not unscaled OSM centerlines.
  const streetScale = 1.9;
  const sidewalkScale = 1.35;
  for (const street of grid.streets) {
    street.asphaltWidth = Number((street.asphaltWidth * streetScale).toFixed(2));
    street.sidewalkW = Number((street.sidewalkW * sidewalkScale).toFixed(2));
  }
  const city = {
    schemaVersion: CITY_SCHEMA_VERSION,
    meta: {
      name: styleProfile.name,
      seed: String(seed),
      seedInt,
      style,
      generator: 'procedural',
      center: { x: 0, z: 0 },
      bounds: { minX: -extent / 2, maxX: extent / 2, minZ: -extent / 2, maxZ: extent / 2 },
      terrain: { type: 'soft-hills', flattenNearRoads: true },
      streetDesign: {
        streetScale,
        sidewalkScale,
        curbHeight: 0.16,
        roadLift: 0.5,
      },
      generatedAt: new Date().toISOString(),
    },
    blocks: [],
    buildings: [],
    streets: grid.streets,
    segments: [],
    intersections: [],
    signals: [],
    terrain: { type: 'soft-hills', streetLines: grid.streetLines, seed: seedInt },
  };
  const blocksAndBuildings = buildBlocksAndBuildings(city, random, styleProfile, grid);
  city.blocks = blocksAndBuildings.blocks;
  city.buildings = blocksAndBuildings.buildings;
  const signals = buildSignalsAndIntersections(city, random, grid);
  city.intersections = signals.intersections;
  city.signals = signals.signals;
  city.segments = buildRoadSegments(city, grid, signals.intersections);
  // Terrain helper used by the renderer and player.
  city.terrain.heightAt = (x, z) => flattenTerrain(x, z, seedInt, grid.streetLines);
  for (const street of city.streets) {
    street.blocks = city.blocks
      .filter((b) => b.streets.includes(street.id))
      .map((b) => b.id);
  }
  return city;
}

/** Hover/pick metadata lookup: nearest building, block, street, or signal. */
export function lookupAt(city, x, z, { maxBuildingDistance = 1e9 } = {}) {
  let building = null;
  let best = maxBuildingDistance;
  for (const candidate of city.buildings) {
    if (pointInPolygon({ x, z }, candidate.polygon)) {
      building = candidate;
      best = 0;
      break;
    }
    const d = distanceToPolygon({ x, z }, candidate.polygon);
    if (d < best) {
      best = d;
      building = candidate;
    }
  }
  const block = city.blocks.find((b) => pointInPolygon({ x, z }, b.polygon)) || null;
  let street = null;
  let streetDistance = Infinity;
  for (const candidate of city.segments) {
    for (let i = 0; i < candidate.points.length - 1; i += 1) {
      const d = distanceToSegment({ x, z }, candidate.points[i], candidate.points[i + 1]);
      if (d < streetDistance) {
        streetDistance = d;
        street = candidate;
      }
    }
  }
  let signal = null;
  for (const candidate of city.signals) {
    if (Math.hypot(candidate.position.x - x, candidate.position.z - z) < 2.8) {
      signal = candidate;
      break;
    }
  }
  return {
    building: building?.landmark ? building : null,
    block,
    street: street && streetDistance < 16 ? street : null,
    streetDistance,
    signal,
  };
}

function distanceToPolygon(point, points) {
  let best = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const d = distanceToSegment(point, points[i], points[(i + 1) % points.length]);
    if (d < best) best = d;
  }
  return best;
}

/** Directed lane edges for cars: right-hand lane offsets respecting one-way. */
export function buildTrafficGraph(city) {
  const edges = [];
  for (const segment of city.segments) {
    if (segment.highway === 'pedestrian' || segment.highway === 'footway' || segment.highway === 'cycleway') continue;
    const offset = Math.max(1.15, segment.width / 2 - 1.45);
    const directions = segment.oneway === 'increasing' ? [1] : segment.oneway === 'decreasing' ? [-1] : [1, -1];
    for (const dir of directions) {
      // Edges enter and leave intersections on the street centerline so the
      // graph is connected at every crossing. The lane offset only applies
      // along the straight portion of the block.
      const vertical = segment.streetId.startsWith('v');
      let points = segment.points.map((p, index, list) => {
        const atEnd = index === 0 || index === list.length - 1;
        // Right-hand traffic: on a vertical street (+x forward) the driver
        // sits at -z; on a horizontal street (+z forward) the driver sits at
        // +x. The old code applied the same sign to both axes, so horizontal
        // streets drove on the wrong side.
        const lane = vertical
          ? (dir > 0 ? -offset : offset)
          : (dir > 0 ? offset : -offset);
        return {
          x: p.x + (vertical && !atEnd ? lane : 0),
          z: p.z + (!vertical && !atEnd ? lane : 0),
        };
      });
      // Grid segments are exactly two vertices, which would put every car on
      // the centerline. Insert a mid-block vertex with the real lane offset
      // so traffic visibly drives on the correct side of the road.
      if (points.length === 2) {
        const lane = vertical
          ? (dir > 0 ? -offset : offset)
          : (dir > 0 ? offset : -offset);
        points = [
          points[0],
          {
            x: (points[0].x + points[1].x) / 2 + (vertical ? 0 : lane),
            z: (points[0].z + points[1].z) / 2 + (vertical ? lane : 0),
          },
          points[1],
        ];
      }
      if (dir < 0) points.reverse();
      edges.push({
        id: `${segment.id}-${dir > 0 ? 'fwd' : 'rev'}`,
        streetId: segment.streetId,
        streetName: segment.streetName,
        highway: segment.highway,
        points,
        signalId: dir > 0 ? segment.signalId : segment.signalId,
      });
    }
  }
  // Connection map by endpoint coordinates.
  const byEnd = new Map();
  for (const edge of edges) {
    const last = edge.points[edge.points.length - 1];
    const key = `${Math.round(last.x / 2) * 2}-${Math.round(last.z / 2) * 2}`;
    if (!byEnd.has(key)) byEnd.set(key, []);
    byEnd.get(key).push(edge);
  }
  for (const edge of edges) {
    const first = edge.points[0];
    const key = `${Math.round(first.x / 2) * 2}-${Math.round(first.z / 2) * 2}`;
    edge.outgoing = (byEnd.get(key) || []).filter((e) => e.id !== edge.id);
  }
  return edges;
}

export function describeCity(city) {
  const stats = {
    name: city?.meta?.name || 'City',
    generator: city?.meta?.generator || 'unknown',
    seed: city?.meta?.seed,
    blocks: city?.blocks?.length || 0,
    buildings: city?.buildings?.length || 0,
    streets: city?.streets?.length || 0,
    segments: city?.segments?.length || 0,
    signals: city?.signals?.length || 0,
    intersections: city?.intersections?.length || 0,
  };
  const oneway = (city?.streets || []).filter((s) => s.oneway !== 'both').length;
  stats.oneWayStreets = oneway;
  stats.areaKm2 = Number((((city?.meta?.bounds?.maxX || 0) - (city?.meta?.bounds?.minX || 0))
    * ((city?.meta?.bounds?.maxZ || 0) - (city?.meta?.bounds?.minZ || 0)) / 1e6).toFixed(2));
  return stats;
}
