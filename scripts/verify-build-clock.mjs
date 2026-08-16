/** Deterministic fixtures for SOURCE_DATE_EPOCH generator metadata. */
import assert from 'node:assert/strict';
import { canonicalBuildTimestamp } from './build-clock.mjs';
import { createAtlasMetadata } from './build-sf-atlas.mjs';
import { createCityMetadata } from './build-realmap-assets.mjs';
import { createStreetDesign, streetDesignToMapMeta } from '../src/realmap/street-design.js';

function generatedMetadata(sourceDateEpoch) {
  const generatedAt = canonicalBuildTimestamp({ sourceDateEpoch });
  const streetDesign = streetDesignToMapMeta(createStreetDesign(), { generatedAt });
  return {
    atlas: createAtlasMetadata({ generatedAt, counts: { roads: 1 } }),
    city: createCityMetadata({
      generatedAt,
      projection: { metres: 1 },
      boundaryRings: 1,
      detailBBox: null,
      streetDesign,
      counts: { roads: 1 },
      sources: [],
    }),
  };
}

const first = generatedMetadata('946684800');
const second = generatedMetadata('946684800');
const changed = generatedMetadata('946684801');
assert.deepEqual(first, second, 'The same SOURCE_DATE_EPOCH must produce byte-stable generator metadata');
assert.equal(JSON.stringify(first), JSON.stringify(second), 'The same SOURCE_DATE_EPOCH must serialize identically');
assert.equal(first.atlas.generatedAt, '2000-01-01T00:00:00.000Z');
assert.equal(first.city.generatedAt, first.atlas.generatedAt, 'Atlas and city metadata must share the canonical build timestamp');
assert.equal(first.city.streetDesign.generatedAt, first.city.generatedAt, 'streetDesign must share the sf-city build timestamp');
assert.equal(changed.atlas.generatedAt, '2000-01-01T00:00:01.000Z');
assert.equal(changed.city.generatedAt, '2000-01-01T00:00:01.000Z');
assert.equal(changed.city.streetDesign.generatedAt, '2000-01-01T00:00:01.000Z');
assert.equal(canonicalBuildTimestamp({ now: 0 }), '1970-01-01T00:00:00.000Z', 'Absent SOURCE_DATE_EPOCH must use the current clock');
for (const invalid of ['', '-1', '1.5', '1e3', 'not-a-number', '9007199254740992']) {
  assert.throws(() => canonicalBuildTimestamp({ sourceDateEpoch: invalid }), /SOURCE_DATE_EPOCH/, `Invalid SOURCE_DATE_EPOCH ${JSON.stringify(invalid)} must be rejected`);
}

process.stdout.write(`${JSON.stringify({
  result: 'SOURCE_DATE_EPOCH build clock verified',
  sameEpochTimestamp: first.atlas.generatedAt,
  changedEpochTimestamp: changed.atlas.generatedAt,
  streetDesignTimestamp: first.city.streetDesign.generatedAt,
  invalidCases: 6,
}, null, 2)}\n`);
