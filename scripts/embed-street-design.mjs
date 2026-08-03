/**
 * Embed / refresh meta.streetDesign inside public/data/sf/sf-city.json(+.gz)
 * without regenerating roads from OSM.
 *
 * Usage:
 *   node scripts/embed-street-design.mjs
 *   node scripts/embed-street-design.mjs --preset=wide
 *   node scripts/embed-street-design.mjs --street=4.2 --sidewalk=2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  createStreetDesign,
  streetDesignToMapMeta,
  STREET_PRESETS,
} from '../src/realmap/street-design.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'public', 'data', 'sf', 'sf-city.json');

function parseArgs(argv) {
  const partial = {};
  for (const arg of argv) {
    if (arg.startsWith('--preset=')) partial.preset = arg.slice('--preset='.length);
    else if (arg.startsWith('--street=')) partial.streetScale = Number(arg.slice('--street='.length));
    else if (arg.startsWith('--sidewalk=')) partial.sidewalkScale = Number(arg.slice('--sidewalk='.length));
    else if (arg.startsWith('--streetScale=')) partial.streetScale = Number(arg.slice('--streetScale='.length));
    else if (arg.startsWith('--sidewalkScale=')) partial.sidewalkScale = Number(arg.slice('--sidewalkScale='.length));
  }
  if ((partial.streetScale != null || partial.sidewalkScale != null) && !partial.preset) {
    partial.preset = 'custom';
  }
  return partial;
}

function main() {
  const cliPartial = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(OUTPUT_PATH)) {
    console.error(`Missing ${OUTPUT_PATH}. Run npm run build:realmap-assets first.`);
    process.exit(1);
  }

  console.log(`Reading ${OUTPUT_PATH}…`);
  const city = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  const existing = city.meta?.streetDesign || {};
  // Only preserve street/sidewalk knobs from map meta — building clearance is derived.
  const design = createStreetDesign({
    preset: cliPartial.preset || existing.preset,
    streetScale: cliPartial.streetScale ?? existing.streetScale,
    sidewalkScale: cliPartial.sidewalkScale ?? existing.sidewalkScale,
    curbScale: cliPartial.curbScale ?? existing.curbScale,
    roadSurfaceLift: cliPartial.roadSurfaceLift ?? existing.roadSurfaceLift,
    overrides: existing.overrides,
    ...cliPartial,
    ...(cliPartial.preset && STREET_PRESETS[cliPartial.preset]
      ? {
          streetScale: STREET_PRESETS[cliPartial.preset].streetScale,
          sidewalkScale: STREET_PRESETS[cliPartial.preset].sidewalkScale,
        }
      : {}),
  });

  city.meta = city.meta || {};
  city.meta.streetDesign = streetDesignToMapMeta(design);

  console.log('Writing streetDesign into map meta:', {
    preset: city.meta.streetDesign.preset,
    streetScale: city.meta.streetDesign.streetScale,
    sidewalkScale: city.meta.streetDesign.sidewalkScale,
    overrideCount: city.meta.streetDesign.summary?.overrideCount || 0,
    residential: city.meta.streetDesign.sections?.residential,
  });

  const json = JSON.stringify(city);
  fs.writeFileSync(OUTPUT_PATH, json);
  fs.writeFileSync(`${OUTPUT_PATH}.gz`, zlib.gzipSync(json, { level: 9 }));
  console.log(`Updated ${OUTPUT_PATH} and ${OUTPUT_PATH}.gz`);
}

main();
