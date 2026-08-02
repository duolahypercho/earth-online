import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data', 'sf');
const CONTOURS_PATH = process.env.SF_CONTOURS
  || path.join(OUT_DIR, 'sf-contours.geojson');
const CONTOURS_URL = process.env.SF_CONTOURS_URL
  || 'https://data.sfgov.org/api/geospatial/6d73-6c4f?method=export&format=GeoJSON';
const OUTPUT_PATH = path.join(OUT_DIR, 'sf-elevation.json');
const CENTER = { lat: 37.778, lon: -122.4194 };
const METERS_PER_DEG_LAT = 110574;
const METERS_PER_DEG_LON = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);
const MAX_GRID_DIMENSION = 640;

function project(lat, lon) {
  return {
    x: (lon - CENTER.lon) * METERS_PER_DEG_LON,
    z: (lat - CENTER.lat) * METERS_PER_DEG_LAT,
  };
}

async function ensureContours() {
  if (fs.existsSync(CONTOURS_PATH)) return;
  console.log(`Downloading SF elevation contours from ${CONTOURS_URL}`);
  const response = await fetch(CONTOURS_URL);
  if (!response.ok) throw new Error(`Contour download failed: ${response.status}`);
  fs.mkdirSync(path.dirname(CONTOURS_PATH), { recursive: true });
  fs.writeFileSync(CONTOURS_PATH, Buffer.from(await response.arrayBuffer()));
}

function digestFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sampleElevations(features) {
  const samples = [];
  for (const feature of features) {
    if (feature.geometry?.type !== 'LineString') continue;
    const rawElevation = Number(feature.properties?.elevation);
    if (!Number.isFinite(rawElevation)) continue;
    const coordinates = feature.geometry.coordinates;
    if (!coordinates?.length) continue;
    const projected = coordinates.map(([lon, lat]) => project(lat, lon));
    const step = 14;
    for (let i = 0; i < projected.length - 1; i += 1) {
      const a = projected[i];
      const b = projected[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const count = Math.max(1, Math.floor(length / step));
      for (let s = 0; s < count; s += 1) {
        const t = count === 1 ? 0 : s / count;
        samples.push({
          x: a.x + (b.x - a.x) * t,
          z: a.z + (b.z - a.z) * t,
          elevation: rawElevation * 0.3048,
        });
      }
    }
  }
  return samples;
}

function pointInFlatRing(point, flat) {
  let inside = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const ax = flat[i];
    const az = flat[i + 1];
    const bx = flat[j];
    const bz = flat[j + 1];
    if ((az > point.z) !== (bz > point.z)
      && point.x < (bx - ax) * (point.z - az) / (bz - az) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

function rasterize(samples, boundary, width, height, originX, originZ, cellSize) {
  const grid = new Float64Array(width * height);
  const counts = new Uint32Array(width * height);
  for (const sample of samples) {
    const x = Math.floor((sample.x - originX) / cellSize);
    const z = Math.floor((sample.z - originZ) / cellSize);
    if (x < 0 || x >= width || z < 0 || z >= height) continue;
    const index = z * width + x;
    grid[index] += sample.elevation;
    counts[index] += 1;
  }
  for (let index = 0; index < grid.length; index += 1) {
    if (counts[index] > 0) grid[index] /= counts[index];
  }

  const flatBoundary = boundary[0] || [];
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = z * width + x;
      if (counts[index] > 0) continue;
      if (flatBoundary.length && !pointInFlatRing({
        x: originX + (x + 0.5) * cellSize,
        z: originZ + (z + 0.5) * cellSize,
      }, flatBoundary)) {
        grid[index] = 0;
      } else {
        grid[index] = NaN;
      }
    }
  }

  // Propagate known elevations into land cells that fall between contour
  // lines (parks, plazas, and contour-dense spots) until the grid is covered.
  let remaining = 0;
  for (let index = 0; index < grid.length; index += 1) {
    if (!Number.isFinite(grid[index]) || (counts[index] === 0 && flatBoundary.length
      && pointInFlatRing({
        x: originX + ((index % width) + 0.5) * cellSize,
        z: originZ + (Math.floor(index / width) + 0.5) * cellSize,
      }, flatBoundary))) remaining += 1;
  }
  let guard = 0;
  while (remaining > 0 && guard < 80) {
    guard += 1;
    const updates = [];
    for (let z = 0; z < height; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = z * width + x;
        if (counts[index] > 0 || (flatBoundary.length && !pointInFlatRing({
          x: originX + (x + 0.5) * cellSize,
          z: originZ + (z + 0.5) * cellSize,
        }, flatBoundary))) continue;
        if (!Number.isFinite(grid[index])) {
          const neighbours = [];
          for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
            if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
            const value = grid[nz * width + nx];
            if (Number.isFinite(value)) neighbours.push(value);
          }
          if (neighbours.length) updates.push({ index, value: neighbours.reduce((a, b) => a + b, 0) / neighbours.length });
        }
      }
    }
    for (const update of updates) grid[update.index] = update.value;
    remaining = updates.length;
  }
  for (let index = 0; index < grid.length; index += 1) {
    if (!Number.isFinite(grid[index])) grid[index] = 0;
  }

  const smooth = new Float64Array(grid);
  for (let z = 1; z < height - 1; z += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          sum += grid[(z + dz) * width + (x + dx)];
          count += 1;
        }
      }
      smooth[z * width + x] = sum / count;
    }
  }
  return { grid: smooth, width, height, originX, originZ, cellSize };
}

async function main() {
  await ensureContours();
  const features = JSON.parse(fs.readFileSync(CONTOURS_PATH, 'utf8')).features || [];
  console.log(`Contour features ${features.length}`);
  const samples = sampleElevations(features);
  console.log(`Elevation samples ${samples.length}`);

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const sample of samples) {
    minX = Math.min(minX, sample.x);
    maxX = Math.max(maxX, sample.x);
    minZ = Math.min(minZ, sample.z);
    maxZ = Math.max(maxZ, sample.z);
  }
  const padding = 600;
  minX -= padding;
  maxX += padding;
  minZ -= padding;
  maxZ += padding;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const cellSize = Math.max(18, Math.max(spanX, spanZ) / MAX_GRID_DIMENSION);
  const width = Math.ceil(spanX / cellSize);
  const height = Math.ceil(spanZ / cellSize);
  const boundary = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'sf-city.json'), 'utf8')).boundary || [];
  const { grid, ...metaGrid } = rasterize(samples, boundary, width, height, minX, minZ, cellSize);
  const rounded = [];
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  for (const value of grid) {
    const roundedValue = Math.round(value * 10) / 10;
    rounded.push(roundedValue);
    minElevation = Math.min(minElevation, roundedValue);
    maxElevation = Math.max(maxElevation, roundedValue);
  }
  const asset = {
    meta: {
      generatedAt: new Date().toISOString(),
      center: CENTER,
      projection: { metersPerDegreeLat: METERS_PER_DEG_LAT, metersPerDegreeLon: METERS_PER_DEG_LON },
      cellSize,
      width,
      height,
      minElevation,
      maxElevation,
      source: {
        name: 'SF Elevation Contours (DataSF)',
        license: 'Open Data Commons PDDL 1.0',
        licenseUrl: 'https://opendatacommons.org/licenses/pddl/1-0/',
        attribution: 'City and County of San Francisco',
        url: CONTOURS_URL,
        sha256: digestFile(CONTOURS_PATH),
      },
    },
    ...metaGrid,
    grid: rounded,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(asset);
  fs.writeFileSync(OUTPUT_PATH, json);
  fs.writeFileSync(`${OUTPUT_PATH}.gz`, zlib.gzipSync(json, { level: 9 }));
  console.log(`Wrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2)} MB, gz ${(fs.statSync(`${OUTPUT_PATH}.gz`).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(JSON.stringify({ width, height, cellSize, minElevation, maxElevation }));
}

await main();
