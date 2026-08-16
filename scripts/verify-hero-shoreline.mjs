import assert from 'node:assert/strict';
import cityData from '../public/data/sf/sf-city.json' with { type: 'json' };
import {
  createFerryHeroShorelineMask,
  FERRY_SHORELINE_SOURCE,
} from '../src/realmap/hero-shoreline.js';

const bounds = { minX: 2128, minZ: 1712, maxX: 2544, maxZ: 2128 };
const mask = createFerryHeroShorelineMask(cityData, bounds);
const diagnostics = mask.getDiagnostics();

assert.equal(diagnostics.source.sha256, FERRY_SHORELINE_SOURCE.sha256, 'DataSF shoreline source digest changed');
assert.equal(diagnostics.sourceRingCount, 24, 'Unexpected source shoreline ring count');
assert(diagnostics.tileRingCount >= 1, 'Ferry tile must intersect the shoreline source');
assert(diagnostics.tileVertexCount >= 20, 'Ferry shoreline segment is too coarse for a source-aligned clip');
assert(diagnostics.clippedSegmentCount >= 20, 'Ferry shoreline transition lacks the source-aligned clipped segments');
assert.equal(mask.isLand(2380, 1880), true, 'Existing waterfront QA position must remain source land');
assert.equal(mask.isLand(2400, 1880), false, 'Known Bay point must not retain ground');
assert.equal(mask.isLand(2420, 1760), false, 'Southern Bay point must not retain ground');
const clamped = mask.nearestLandPoint(2400, 1880, 0.55);
assert.equal(clamped.clamped, true, 'Water player pose must clamp to the source shoreline');
assert.equal(mask.isLand(clamped.x, clamped.z), true, 'Water clamp must land on a source-backed land point');
console.log(JSON.stringify({ result: 'hero shoreline verification passed', diagnostics, clamped }, null, 2));
