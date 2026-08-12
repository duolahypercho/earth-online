import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleMultipolygonRelation, readMultipolygonRelationsFromPbf } from './osm-multipolygon-relations-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW_PBF = path.join(ROOT, 'public/data/sf/SanFrancisco.osm.pbf');

const relation = (members, tags = { type: 'multipolygon', surface: 'paved' }) => ({ type: 'relation', id: 9001, tags, members });
const member = (id, role) => ({ type: 'way', id, role });
const way = (id, refs) => ({ type: 'way', id, tags: {}, refs });
const fixtureNodes = new Map([
  [1, { lon: 0, lat: 0 }], [2, { lon: 8, lat: 0 }], [3, { lon: 8, lat: 8 }], [4, { lon: 0, lat: 8 }],
  [5, { lon: 2, lat: 2 }], [6, { lon: 2, lat: 4 }], [7, { lon: 4, lat: 4 }], [8, { lon: 4, lat: 2 }],
  [20, { lon: 20, lat: 20 }], [21, { lon: 22, lat: 20 }], [22, { lon: 22, lat: 22 }], [23, { lon: 20, lat: 22 }],
  [30, { lon: 6, lat: 6 }], [31, { lon: 10, lat: 6 }], [32, { lon: 10, lat: 7 }], [33, { lon: 6, lat: 7 }],
  [40, { lon: 0, lat: 2 }], [41, { lon: 2, lat: 2 }], [42, { lon: 2, lat: 3 }], [43, { lon: 0, lat: 3 }],
]);

const fixtureWays = new Map([
  [100, way(100, [1, 2, 3])],
  [101, way(101, [1, 4, 3])], // must be reversed when stitched after way/100
  [200, way(200, [5, 6, 7])],
  [201, way(201, [5, 8, 7])], // must be reversed, then canonical winding reverses the completed hole
]);
const fixtureRelation = relation([member(100, 'outer'), member(101, 'outer'), member(200, 'inner'), member(201, 'inner')]);
const first = assembleMultipolygonRelation({ relation: fixtureRelation, ways: fixtureWays, nodes: fixtureNodes, transformCoordinate: ([lon, lat]) => [lon * 2, lat * 3] });
const second = assembleMultipolygonRelation({ relation: fixtureRelation, ways: fixtureWays, nodes: fixtureNodes, transformCoordinate: ([lon, lat]) => [lon * 2, lat * 3] });
assert.equal(first.complete, true);
assert.equal(first.coverage.relationComplete, true);
assert.deepEqual(first, second, 'assembly must be deterministic');
assert.equal(first.polygons.length, 1);
assert.equal(first.polygons[0].holes.length, 1);
assert.deepEqual(first.source.members, fixtureRelation.members, 'source relation IDs, order, and roles must survive');
assert.deepEqual(first.outerRings[0].sourceWayIds, [100, 101]);
assert(first.outerRings[0].signedArea > 0, 'outer winding must be canonical counter-clockwise');
assert(first.innerRings[0].signedArea < 0, 'inner winding must be canonical clockwise');
assert(first.outerRings[0].wayTraversals.some(({ wayId, reversed }) => wayId === 101 && reversed), 'source-way reversal must be explicit');

const blankRole = assembleMultipolygonRelation({ relation: relation([{ type: 'way', id: 300, role: '' }]), ways: new Map([[300, way(300, [1, 2, 3, 4, 1])]]), nodes: fixtureNodes });
assert.equal(blankRole.complete, true, 'OSM blank member roles must use documented outer semantics');

const missingWay = assembleMultipolygonRelation({ relation: fixtureRelation, ways: new Map([[100, fixtureWays.get(100)]]), nodes: fixtureNodes });
assert.equal(missingWay.complete, false);
assert.equal(missingWay.coverage.relationComplete, false);
assert(missingWay.errors.some(({ code }) => code === 'missing-member-way'));
assert.deepEqual(missingWay.polygons, [], 'incomplete relations must not leak partial polygons');

const missingNodeMap = new Map(fixtureNodes); missingNodeMap.delete(2);
const missingNode = assembleMultipolygonRelation({ relation: fixtureRelation, ways: fixtureWays, nodes: missingNodeMap });
assert.equal(missingNode.complete, false);
assert(missingNode.errors.some(({ code }) => code === 'missing-member-node'));
assert.deepEqual(missingNode.outerRings, [], 'missing nodes must fail closed');

const branchWays = new Map(fixtureWays); branchWays.set(102, way(102, [1, 20, 3]));
const branch = assembleMultipolygonRelation({ relation: relation([member(100, 'outer'), member(101, 'outer'), member(102, 'outer')]), ways: branchWays, nodes: fixtureNodes });
assert.equal(branch.complete, false);
assert(branch.errors.some(({ code }) => code === 'ambiguous-ring-junction'));

const open = assembleMultipolygonRelation({ relation: relation([member(100, 'outer')]), ways: fixtureWays, nodes: fixtureNodes });
assert.equal(open.complete, false);
assert(open.errors.some(({ code }) => code === 'open-ring'));

const unsupportedRole = assembleMultipolygonRelation({ relation: relation([{ type: 'way', id: 100, role: 'outline' }]), ways: fixtureWays, nodes: fixtureNodes });
assert.equal(unsupportedRole.complete, false);
assert(unsupportedRole.errors.some(({ code }) => code === 'unsupported-member-role'));

const exteriorHoleWays = new Map([[300, way(300, [1, 2, 3, 4, 1])], [301, way(301, [20, 21, 22, 23, 20])]]);
const exteriorHole = assembleMultipolygonRelation({ relation: relation([member(300, 'outer'), member(301, 'inner')]), ways: exteriorHoleWays, nodes: fixtureNodes });
assert.equal(exteriorHole.complete, false);
assert(exteriorHole.errors.some(({ code }) => code === 'unassigned-inner-ring'));
assert.deepEqual(exteriorHole.polygons, []);

const crossingHoleWays = new Map([[300, way(300, [1, 2, 3, 4, 1])], [302, way(302, [30, 31, 32, 33, 30])]]);
const crossingHole = assembleMultipolygonRelation({ relation: relation([member(300, 'outer'), member(302, 'inner')]), ways: crossingHoleWays, nodes: fixtureNodes });
assert.equal(crossingHole.complete, false, 'a hole that starts inside but crosses an outer boundary must fail closed');
assert(crossingHole.errors.some(({ code }) => code === 'unassigned-inner-ring'));

const touchingHoleWays = new Map([[300, way(300, [1, 2, 3, 4, 1])], [303, way(303, [40, 41, 42, 43, 40])]]);
const touchingHole = assembleMultipolygonRelation({ relation: relation([member(300, 'outer'), member(303, 'inner')]), ways: touchingHoleWays, nodes: fixtureNodes });
assert.equal(touchingHole.complete, false, 'a hole that touches an outer boundary must fail closed');
assert(touchingHole.errors.some(({ code, boundaryIntersection }) => code === 'unassigned-inner-ring' && boundaryIntersection === 'touch'));

const real = await readMultipolygonRelationsFromPbf({ pbfPath: RAW_PBF, relationIds: [2642389], transformCoordinate: ([lon, lat]) => [lon, lat] });
assert.equal(real.coverageComplete, true, 'real Ferry relation must assemble completely from raw PBF');
assert.deepEqual(real.missingRelationIds, []);
assert.equal(real.relations[0].source.id, 2642389);
assert.deepEqual(real.relations[0].source.members, [member(196670578, 'outer'), member(196670580, 'inner'), member(196670579, 'inner')]);
assert.equal(real.relations[0].polygons.length, 1);
assert.equal(real.relations[0].polygons[0].holes.length, 2);
assert(real.relations[0].outerRings[0].signedArea > 0);
assert(real.relations[0].innerRings.every(({ signedArea }) => signedArea < 0));

const missingReal = await readMultipolygonRelationsFromPbf({ pbfPath: RAW_PBF, relationIds: [2642389, -999999] });
assert.equal(missingReal.coverageComplete, false);
assert.deepEqual(missingReal.missingRelationIds, [-999999]);

process.stdout.write(`${JSON.stringify({ result: 'OSM multipolygon relation assembly verified', fixtureWayReversal: true, failClosedCases: 8, realFerryRelation: 2642389, realOuterRings: real.relations[0].outerRings.length, realInnerRings: real.relations[0].innerRings.length }, null, 2)}\n`);
