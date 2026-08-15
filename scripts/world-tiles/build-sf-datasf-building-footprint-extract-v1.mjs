#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const LOCK_PATH = path.join(ROOT, 'public/data/world/source-locks/sf-datasf-building-footprints-2023-v1.lock.json');
const OUTPUT_ROOT = path.join(ROOT, 'public/data/world/preview-artifacts/sf-datasf-building-footprints-v1');

const EXPECTED_HEADER = Object.freeze([
  'sf16_bldgid', 'area_id', 'mblr', 'p2010_name', 'p2010_zminn88ft', 'p2010_zmaxn88ft',
  'gnd_cells50cm', 'gnd_mincm', 'gnd_maxcm', 'gnd_rangecm', 'gnd_meancm', 'gnd_stdcm',
  'gnd_varietycm', 'gnd_majoritycm', 'gnd_minoritycm', 'gnd_mediancm', 'cells50cm_1st',
  'mincm_1st', 'maxcm_1st', 'rangecm_1st', 'meancm_1st', 'stdcm_1st', 'varietycm_1st',
  'majoritycm_1st', 'minoritycm_1st', 'mediancm_1st', 'hgt_cells50cm', 'hgt_mincm',
  'hgt_maxcm', 'hgt_rangecm', 'hgt_meancm', 'hgt_stdcm', 'hgt_varietycm',
  'hgt_majoritycm', 'hgt_minoritycm', 'hgt_mediancm', 'gnd_min_m', 'median_1st_m',
  'hgt_median_m', 'gnd1st_delta', 'peak_1st_m', 'globalid', 'shape', 'data_as_of',
  'data_loaded_at',
]);

const EXTRACT_FIELDS = Object.freeze([
  'sf16_bldgid', 'area_id', 'mblr', 'p2010_name', 'p2010_zminn88ft', 'p2010_zmaxn88ft',
  'gnd_min_m', 'median_1st_m', 'hgt_median_m', 'gnd1st_delta', 'peak_1st_m', 'globalid',
  'shape', 'data_as_of', 'data_loaded_at',
]);

const REGIONS = Object.freeze([
  {
    id: 'ferry',
    tileId: 'epsg26910-1441-10893',
    gridIndex: [1441, 10893],
    wgs84Bounds: [-122.39412884053405, 37.79199340457852, -122.38973919965629, 37.795476793828165],
  },
  {
    id: 'district',
    tileId: 'epsg26910-1430-10882',
    gridIndex: [1430, 10882],
    wgs84Bounds: [-122.44238805620932, 37.75416199101486, -122.43800288641724, 37.75764362832815],
  },
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function* parseCsvRows(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let row = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;

  const finishField = () => { row.push(field); field = ''; };
  const finishRow = () => { const complete = row; row = []; return complete; };

  for await (const chunk of stream) {
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];
      if (inQuotes) {
        if (character === '"') { inQuotes = false; afterQuote = true; }
        else field += character;
        continue;
      }
      if (afterQuote) {
        if (character === '"') { field += '"'; inQuotes = true; afterQuote = false; continue; }
        afterQuote = false;
      }
      if (character === '"') {
        assert.equal(field.length, 0, 'Unexpected quote inside an unquoted CSV field');
        inQuotes = true;
      } else if (character === ',') {
        finishField();
      } else if (character === '\n') {
        finishField();
        yield finishRow();
      } else if (character !== '\r') {
        field += character;
      }
    }
  }
  assert.equal(inQuotes, false, 'CSV ended inside a quoted field');
  if (field.length || row.length) { finishField(); yield finishRow(); }
}

function wktBounds(wkt) {
  assert.match(wkt, /^MULTIPOLYGON\s*\(\(/, 'DataSF shape is not a WKT MULTIPOLYGON');
  const coordinate = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
  let minLongitude = Infinity; let minLatitude = Infinity;
  let maxLongitude = -Infinity; let maxLatitude = -Infinity;
  let count = 0; let match;
  while ((match = coordinate.exec(wkt)) !== null) {
    const longitude = Number(match[1]); const latitude = Number(match[2]);
    assert(Number.isFinite(longitude) && Number.isFinite(latitude), 'DataSF WKT contains a non-finite coordinate');
    minLongitude = Math.min(minLongitude, longitude); maxLongitude = Math.max(maxLongitude, longitude);
    minLatitude = Math.min(minLatitude, latitude); maxLatitude = Math.max(maxLatitude, latitude); count += 1;
  }
  assert(count >= 4, 'DataSF WKT contains too few coordinates');
  return [minLongitude, minLatitude, maxLongitude, maxLatitude];
}

function intersects(left, right) {
  return !(left[2] < right[0] || left[0] > right[2] || left[3] < right[1] || left[1] > right[3]);
}

function finiteSourceNumber(value, field, buildingId) {
  if (value === '') return null;
  const number = Number(value);
  assert(Number.isFinite(number), `${buildingId} ${field} is not finite`);
  return number;
}

function summarize(features) {
  const numericFields = ['p2010_zminn88ft', 'p2010_zmaxn88ft', 'gnd_min_m', 'median_1st_m', 'hgt_median_m', 'gnd1st_delta', 'peak_1st_m'];
  const completeness = Object.fromEntries(numericFields.map((field) => [field, features.filter((feature) => feature.source[field] !== '').length]));
  const heightValues = features.map((feature) => finiteSourceNumber(feature.source.hgt_median_m, 'hgt_median_m', feature.source.sf16_bldgid)).filter((value) => value !== null);
  return {
    features: features.length,
    completeness,
    medianHeightMetres: heightValues.length ? { min: Math.min(...heightValues), max: Math.max(...heightValues) } : null,
  };
}

function sourcePathFromArguments(lock) {
  const sourceIndex = process.argv.indexOf('--source');
  if (sourceIndex >= 0) {
    assert(process.argv[sourceIndex + 1], '--source requires a literal CSV path');
    return path.resolve(process.argv[sourceIndex + 1]);
  }
  if (process.env.SF_DATASF_BUILDING_FOOTPRINTS_CSV) return path.resolve(process.env.SF_DATASF_BUILDING_FOOTPRINTS_CSV);
  return path.join(ROOT, lock.source.snapshot.localPath);
}

export async function buildDataSfBuildingFootprintExtracts({ sourcePath, write = true } = {}) {
  const lockBytes = await readFile(LOCK_PATH); const lock = JSON.parse(lockBytes);
  assert.equal(lock.kind, 'earth-building-geometry-height-source-lock');
  assert.equal(lock.status, 'preview-source-authorized-not-production');
  const csvPath = sourcePath ?? sourcePathFromArguments(lock);
  const sourceStat = await stat(csvPath);
  assert.equal(sourceStat.size, lock.source.snapshot.bytes, 'DataSF CSV byte length differs from the source lock');
  assert.equal(await hashFile(csvPath), lock.source.snapshot.sha256, 'DataSF CSV SHA-256 differs from the source lock');

  const selected = new Map(REGIONS.map((region) => [region.id, []]));
  let header; let rowCount = 0;
  for await (const values of parseCsvRows(csvPath)) {
    if (!header) {
      header = values;
      assert.deepEqual(header, EXPECTED_HEADER, 'DataSF CSV schema/order differs from the source lock');
      continue;
    }
    if (values.length === 1 && values[0] === '') continue;
    rowCount += 1;
    assert.equal(values.length, header.length, `DataSF CSV row ${rowCount} has ${values.length} fields instead of ${header.length}`);
    const row = Object.fromEntries(header.map((field, index) => [field, values[index]]));
    assert(row.sf16_bldgid && row.globalid && row.shape, `DataSF CSV row ${rowCount} is missing required identity/geometry`);
    assert.equal(row.data_as_of, '2023/09/11 12:00:00 PM', `${row.sf16_bldgid} data_as_of drifted`);
    assert.equal(row.data_loaded_at, '2026/08/14 10:21:32 AM', `${row.sf16_bldgid} data_loaded_at drifted`);
    const bounds = wktBounds(row.shape);
    for (const region of REGIONS) if (intersects(bounds, region.wgs84Bounds)) {
      selected.get(region.id).push({
        source: Object.fromEntries(EXTRACT_FIELDS.map((field) => [field, row[field]])),
        wgs84Bounds: bounds,
      });
    }
  }
  assert.equal(rowCount, lock.source.snapshot.rowsExcludingHeader, 'DataSF CSV row count differs from the source lock');

  const outputs = [];
  for (const region of REGIONS) {
    const features = selected.get(region.id).sort((left, right) => left.source.sf16_bldgid.localeCompare(right.source.sf16_bldgid) || left.source.globalid.localeCompare(right.source.globalid));
    assert(features.length > 0, `${region.id} DataSF extract is empty`);
    const extract = {
      schemaVersion: 1,
      kind: 'sf-datasf-building-footprint-extract',
      status: 'preview-source-evidence-only-not-production',
      sourceLock: { id: lock.id, path: path.relative(ROOT, LOCK_PATH), sha256: `sha256:${sha256(lockBytes)}` },
      region: { id: region.id, tileId: region.tileId, gridIndex: region.gridIndex, horizontalCrs: 'EPSG:26910', unitsPerMetre: 1, selectionBoundsWgs84: region.wgs84Bounds },
      selectionRule: 'include a source WKT MULTIPOLYGON when its exact parsed EPSG:4326 bounding box intersects the tile selection bounding box',
      verticalClaim: 'field-level DataSF declarations retained; no reconciliation with production terrain and no absolute runtime placement claim',
      prohibitedClaims: ['facade-material', 'window-inventory', 'door-inventory', 'floor-plan', 'occupancy', 'survey-grade-accuracy', 'production-runtime-promotion'],
      summary: summarize(features),
      features,
    };
    const bytes = jsonBytes(extract);
    const fileName = `${region.tileId}.datasf-building-footprints.json`;
    if (write) { await mkdir(OUTPUT_ROOT, { recursive: true }); await writeFile(path.join(OUTPUT_ROOT, fileName), bytes); }
    outputs.push({ id: region.id, tileId: region.tileId, path: path.relative(ROOT, path.join(OUTPUT_ROOT, fileName)), bytes: bytes.length, sha256: `sha256:${sha256(bytes)}`, features: features.length, extractBytes: bytes });
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'sf-datasf-building-footprint-extract-manifest',
    status: 'preview-source-evidence-only-not-production',
    source: { id: lock.id, bytes: lock.source.snapshot.bytes, sha256: `sha256:${lock.source.snapshot.sha256}`, rows: rowCount, columns: header.length },
    claims: { horizontalFootprints: 'source WKT only', heightFields: 'source fields retained verbatim', productionGeometryChanged: false, runtimeChanged: false, gameplayChanged: false, facadeSemanticsSupplied: false, verticalReconciliationComplete: false },
    extracts: outputs.map(({ extractBytes, ...output }) => output),
  };
  const manifestBytes = jsonBytes(manifest);
  if (write) await writeFile(path.join(OUTPUT_ROOT, 'sf-datasf-building-footprints-v1.manifest.json'), manifestBytes);
  return { lock, lockBytes, manifest, manifestBytes, outputs };
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await buildDataSfBuildingFootprintExtracts();
  process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
}
