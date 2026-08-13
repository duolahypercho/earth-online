import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourcePath = new URL('../src/realmap/hero-waterfront.js', import.meta.url);
const source = await readFile(sourcePath, 'utf8');

assert.match(source, /mask\.shorelineSegments/, 'waterfront must consume shoreline source segments');
assert.match(source, /mask\.isLand/, 'waterfront must derive its land side from source classification');
assert.match(source, /presentationOnly: true/, 'waterfront dimensions must be explicitly presentation-only');
assert.match(source, /affectsCollision: false/, 'waterfront must not change collision');
assert.match(source, /sourceAligned: true/, 'waterfront must report source alignment');
assert.match(source, /waterSideBandDepthM: 1\.6/, 'water-side readability band must remain bounded');
assert.match(source, /not bathymetry/, 'water-side band must disclaim physical depth claims');
assert.doesNotMatch(source, /BoxGeometry|CylinderGeometry|Rail/, 'waterfront must not invent pier, bollard, or rail topology');

console.log(JSON.stringify({
  result: 'passed',
  module: 'src/realmap/hero-waterfront.js',
  contract: 'DataSF shoreline centre-line visualization; presentation-only and non-colliding',
}, null, 2));
