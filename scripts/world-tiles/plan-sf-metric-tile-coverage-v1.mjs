/** Build the deterministic, sparse 384 m tile plan for all locked DataSF land. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openGeoTiffWindowReader } from './geotiff-window-reader-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHORELINE_PATH = path.join(ROOT, 'public/data/sf/sf-shoreline.geojson');
const SHORELINE_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-datasf-shoreline-horizontal-geometry-v1.lock.json');
const HORIZONTAL_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023-horizontal-crs-v1.lock.json');
const TERRAIN_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-2023.lock.json');
const ELEVATION_LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-ferry-3dep-terrain-elevation-authorized-v1.lock.json');
const OUTPUT_PATH = path.join(ROOT, 'public/data/world/plans/sf-metric-tile-coverage-v1.json');
const TILE_SIZE = 384;
const SOURCE_BUFFER = 16;
const COASTAL_HALO_TILES = 1;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const relative = (filePath) => path.relative(ROOT, filePath).split(path.sep).join('/');
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function forward(lonDegrees, latDegrees, lock) {
  const projection = lock.claims.operation.authorityPath[1];
  const p = projection.parameters;
  const { semiMajorAxisMetres: a, inverseFlattening } = projection.ellipsoidFromEpsg4269;
  const f = 1 / inverseFlattening;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const radians = Math.PI / 180;
  const phi = latDegrees * radians;
  const lon0 = p.longitudeOfNaturalOriginDegrees * radians;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * sin ** 2);
  const t = tan ** 2;
  const c = ep2 * cos ** 2;
  const aa = cos * (lonDegrees * radians - lon0);
  const m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  return [
    p.falseEastingMetres + p.scaleFactor * n * (aa + (1 - t + c) * aa ** 3 / 6 + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5 / 120),
    p.falseNorthingMetres + p.scaleFactor * (m + n * tan * (aa ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * aa ** 4 / 24 + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6 / 720)),
  ];
}

function pointOnSegment(point, a, b) {
  const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  return Math.abs(cross) <= 1e-7 && point[0] >= Math.min(a[0], b[0]) - 1e-7 && point[0] <= Math.max(a[0], b[0]) + 1e-7
    && point[1] >= Math.min(a[1], b[1]) - 1e-7 && point[1] <= Math.max(a[1], b[1]) + 1e-7;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const a = ring[index]; const b = ring[index + 1];
    if (pointOnSegment(point, a, b)) return 'boundary';
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return Math.abs(value) <= 1e-7 ? 0 : Math.sign(value);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c); const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a); const cdB = orientation(c, d, b);
  return (abC !== abD && cdA !== cdB)
    || (abC === 0 && pointOnSegment(c, a, b)) || (abD === 0 && pointOnSegment(d, a, b))
    || (cdA === 0 && pointOnSegment(a, c, d)) || (cdB === 0 && pointOnSegment(b, c, d));
}

function pointInPolygon(point, polygon) {
  const outer = pointInRing(point, polygon[0]);
  if (outer === 'outside') return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole) !== 'outside');
}

function polygonIntersectsTile(polygon, bounds) {
  const [minE, minN, maxE, maxN] = bounds;
  const corners = [[minE, minN], [maxE, minN], [maxE, maxN], [minE, maxN]];
  if (corners.some((corner) => pointInPolygon(corner, polygon))) return true;
  if (polygon.some((ring) => ring.some(([e, n]) => e >= minE && e <= maxE && n >= minN && n <= maxN))) return true;
  const edges = corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]]);
  return polygon.some((ring) => ring.slice(0, -1).some((point, index) => edges.some(([a, b]) => segmentsIntersect(point, ring[index + 1], a, b))));
}

function tileKey(easting, northing) { return `${easting},${northing}`; }
function tileId(easting, northing) { return `epsg26910-${easting}-${northing}`; }

export async function buildSfMetricTileCoveragePlan() {
  const [shorelineBytes, shorelineLockBytes, horizontalLockBytes, terrainLockBytes, elevationLockBytes] = await Promise.all([
    readFile(SHORELINE_PATH), readFile(SHORELINE_LOCK_PATH), readFile(HORIZONTAL_LOCK_PATH), readFile(TERRAIN_LOCK_PATH), readFile(ELEVATION_LOCK_PATH),
  ]);
  const shorelineLock = JSON.parse(shorelineLockBytes);
  const horizontalLock = JSON.parse(horizontalLockBytes);
  const terrainLock = JSON.parse(terrainLockBytes);
  const shoreline = JSON.parse(shorelineBytes);
  assert.equal(sha256(shorelineBytes), shorelineLock.source.snapshot.sha256, 'DataSF shoreline bytes do not match their source lock');
  assert.equal(shorelineBytes.length, shorelineLock.source.snapshot.bytes, 'DataSF shoreline byte count does not match its source lock');
  assert.equal(shoreline.type, 'FeatureCollection', 'DataSF shoreline must be a FeatureCollection');
  assert.equal(shoreline.features.length, 1, 'Locked DataSF shoreline must contain exactly one feature');
  assert.equal(shoreline.features[0].geometry.type, 'MultiPolygon', 'Locked DataSF shoreline feature must be a MultiPolygon');
  const polygons = shoreline.features[0].geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(([lon, lat]) => forward(lon, lat, horizontalLock))));
  const landTiles = new Map();
  polygons.forEach((polygon, polygonIndex) => {
    const points = polygon[0];
    const minGridE = Math.floor(Math.min(...points.map(([e]) => e)) / TILE_SIZE);
    const maxGridE = Math.floor(Math.max(...points.map(([e]) => e)) / TILE_SIZE);
    const minGridN = Math.floor(Math.min(...points.map(([, n]) => n)) / TILE_SIZE);
    const maxGridN = Math.floor(Math.max(...points.map(([, n]) => n)) / TILE_SIZE);
    for (let gridN = minGridN; gridN <= maxGridN; gridN += 1) for (let gridE = minGridE; gridE <= maxGridE; gridE += 1) {
      const bounds = [gridE * TILE_SIZE, gridN * TILE_SIZE, (gridE + 1) * TILE_SIZE, (gridN + 1) * TILE_SIZE];
      if (!polygonIntersectsTile(polygon, bounds)) continue;
      const key = tileKey(gridE, gridN);
      const record = landTiles.get(key) ?? { gridEasting: gridE, gridNorthing: gridN, landPolygonIndices: [] };
      record.landPolygonIndices.push(polygonIndex);
      landTiles.set(key, record);
    }
  });
  const planned = new Map(landTiles);
  for (const tile of landTiles.values()) for (let dy = -COASTAL_HALO_TILES; dy <= COASTAL_HALO_TILES; dy += 1) for (let dx = -COASTAL_HALO_TILES; dx <= COASTAL_HALO_TILES; dx += 1) {
    const gridE = tile.gridEasting + dx; const gridN = tile.gridNorthing + dy; const key = tileKey(gridE, gridN);
    if (!planned.has(key)) planned.set(key, { gridEasting: gridE, gridNorthing: gridN, landPolygonIndices: [] });
  }
  const rasterBounds = terrainLock.raster.gridEnvelope.modelBoundsAtPixelIsAreaEdges;
  const terrainRasterBounds = [rasterBounds[0], rasterBounds[1], rasterBounds[2], rasterBounds[3]];
  const reader = await openGeoTiffWindowReader(path.join(ROOT, terrainLock.raster.localRawCache));
  const orderedTiles = [...planned.values()].sort((a, b) => a.gridNorthing - b.gridNorthing || a.gridEasting - b.gridEasting);
  const readiness = new Map();
  for (const tile of orderedTiles) {
    const minE = tile.gridEasting * TILE_SIZE; const minN = tile.gridNorthing * TILE_SIZE;
    const sourceBounds = [minE - SOURCE_BUFFER, minN - SOURCE_BUFFER, minE + TILE_SIZE + SOURCE_BUFFER, minN + TILE_SIZE + SOURCE_BUFFER];
    const insideRaster = sourceBounds[0] >= terrainRasterBounds[0] && sourceBounds[1] >= terrainRasterBounds[1]
      && sourceBounds[2] <= terrainRasterBounds[2] && sourceBounds[3] <= terrainRasterBounds[3];
    let terrainAvailable = false;
    let terrainReason = 'missing-authorized-1m-terrain-source';
    if (insideRaster) {
      const topLeft = reader.modelToPixel(sourceBounds[0], sourceBounds[3]); const bottomRight = reader.modelToPixel(sourceBounds[2], sourceBounds[1]);
      const column = Math.floor(topLeft.column); const row = Math.floor(topLeft.row); const right = Math.ceil(bottomRight.column) + 1; const bottom = Math.ceil(bottomRight.row) + 1;
      const window = await reader.readWindow({ column, row, width: right - column, height: bottom - row });
      terrainAvailable = window.values.every((value) => value !== window.nodata && Number.isFinite(value));
      terrainReason = terrainAvailable ? 'available-from-byte-locked-3dep-x55y419' : 'byte-locked-3dep-x55y419-contains-nodata';
    }
    readiness.set(tileKey(tile.gridEasting, tile.gridNorthing), { terrainAvailable, terrainReason });
  }
  await reader.close();
  const tiles = orderedTiles.map((tile) => {
    const minE = tile.gridEasting * TILE_SIZE; const minN = tile.gridNorthing * TILE_SIZE;
    const { terrainAvailable, terrainReason } = readiness.get(tileKey(tile.gridEasting, tile.gridNorthing));
    return {
      id: tileId(tile.gridEasting, tile.gridNorthing),
      gridIndex: [tile.gridEasting, tile.gridNorthing],
      boundsEpsg26910Metres: [minE, minN, minE + TILE_SIZE, minN + TILE_SIZE],
      inclusion: tile.landPolygonIndices.length ? 'land-intersection' : 'coastal-context-halo',
      landPolygonIndices: [...tile.landPolygonIndices].sort((a, b) => a - b),
      sourceReadiness: {
        horizontalGeometry: 'available-from-byte-locked-datasf-and-osm',
        terrainElevation: terrainReason,
        buildReady: terrainAvailable,
      },
    };
  });
  const projectedPoints = polygons.flat(2);
  const counts = {
    shorelinePolygons: polygons.length,
    landIntersectingTiles: tiles.filter(({ inclusion }) => inclusion === 'land-intersection').length,
    coastalContextTiles: tiles.filter(({ inclusion }) => inclusion === 'coastal-context-halo').length,
    totalPlannedTiles: tiles.length,
    buildReadyTiles: tiles.filter(({ sourceReadiness }) => sourceReadiness.buildReady).length,
    missingTerrainTiles: tiles.filter(({ sourceReadiness }) => !sourceReadiness.buildReady).length,
  };
  return {
    schemaVersion: 1,
    kind: 'sf-metric-tile-coverage-plan',
    id: 'sf-metric-tile-coverage-v1',
    status: counts.missingTerrainTiles ? 'horizontal-complete-terrain-sources-incomplete' : 'source-complete-build-pending',
    scope: 'all polygons in the locked DataSF Shoreline and Islands source, including remote San Francisco islands',
    coordinateReference: { horizontal: { crs: 'EPSG:26910', unit: 'metre' }, vertical: { status: 'not-certified-by-this-horizontal-coverage-plan' } },
    tiling: { scheme: 'rectilinear-utm', tileSizeMetres: TILE_SIZE, sourceBufferMetres: SOURCE_BUFFER, coastalContextHaloTiles: COASTAL_HALO_TILES },
    sources: {
      shoreline: { id: shorelineLock.id, path: relative(SHORELINE_LOCK_PATH), lockSha256: `sha256:${sha256(shorelineLockBytes)}`, artifactPath: relative(SHORELINE_PATH), artifactBytes: shorelineBytes.length, artifactSha256: `sha256:${sha256(shorelineBytes)}` },
      horizontalTransform: { id: horizontalLock.id, path: relative(HORIZONTAL_LOCK_PATH), lockSha256: `sha256:${sha256(horizontalLockBytes)}`, absoluteHorizontalAccuracyFloorMetres: 4 },
      availableTerrain: [{ id: JSON.parse(elevationLockBytes).id, path: relative(ELEVATION_LOCK_PATH), lockSha256: `sha256:${sha256(elevationLockBytes)}`, sourceLockPath: relative(TERRAIN_LOCK_PATH), sourceLockSha256: `sha256:${sha256(terrainLockBytes)}`, rasterBoundsEpsg26910Metres: terrainRasterBounds }],
    },
    landBoundsEpsg26910Metres: [Math.min(...projectedPoints.map(([e]) => e)), Math.min(...projectedPoints.map(([, n]) => n)), Math.max(...projectedPoints.map(([e]) => e)), Math.max(...projectedPoints.map(([, n]) => n))],
    counts,
    tiles,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = await buildSfMetricTileCoveragePlan();
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, stableJson(plan));
  process.stdout.write(`${JSON.stringify({ result: 'SF metric coverage plan written', path: relative(OUTPUT_PATH), status: plan.status, counts: plan.counts }, null, 2)}\n`);
}
