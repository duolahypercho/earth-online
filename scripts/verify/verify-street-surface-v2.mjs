// Self-check for src/world/streets/street-surface-v2.js
//
// Runs headless under plain node: no browser, no DOM, no canvas, no new
// dependency. Exits non-zero on the first failed assertion group.
//
//   npm run verify:street-surface-v2
//
// What it proves, on a synthetic segment/intersection fixture:
//   1. the module contract (exports, layer list, mesh grouping)
//   2. the carriageway occupies EXACTLY segment.width and nothing wider
//   3. the curb has a real 0.15 m vertical face on every face quad
//   4. the road is cambered and gutter-channelled, i.e. not planar
//   5. the sidewalk starts at curb-top level and reaches half + sidewalkW
//   6. lane markings follow segment.lanes / segment.oneway exactly
//   7. markings are lifted off the carriageway by the documented offset and
//      junction paint clears segment paint
//   8. a signalised node gets crosswalk bands, stop bars, curb returns, ramps
//      and a junction pad; an unsignalised node gets no paint
//   9. approach carriageways are trimmed back to the pad (no overlap)
//  10. output is deterministic and does not mutate the source city
//  11. no NaN/Inf anywhere and every index is in range
//  12. the triangle budget per 100 m of street and per intersection holds
//  13. the THREE build stays on stock materials, 3 draw calls, polygonOffset

import * as THREE from 'three';
import * as mod from '../../src/world/streets/street-surface-v2.js';

const {
  STREET_SURFACE_V2_ID,
  STREET_SURFACE_V2_LAYERS,
  STREET_SURFACE_V2_MESH_GROUPS,
  STREET_SURFACE_V2_BUDGET,
  STREET_SURFACE_V2_DEFAULTS,
  resolveStreetSurfaceOptions,
  planSegmentMarkings,
  buildStreetSurfaceData,
  buildStreetSurfaceV2,
  disposeStreetSurfaceV2,
} = mod;

let checks = 0;
const failures = [];

function assert(condition, message) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL ${message}`);
  }
}

function near(a, b, tolerance = 1e-9) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

function makeSegment(id, points, overrides = {}) {
  const width = overrides.width ?? 12;
  const walk = overrides.sidewalkW ?? 3;
  return {
    id,
    streetId: `street-${id}`,
    streetName: `Fixture ${id}`,
    highway: overrides.highway ?? 'primary',
    lanes: overrides.lanes ?? 4,
    oneway: overrides.oneway ?? false,
    width,
    sidewalkW: walk,
    sidewalkLeft: overrides.sidewalkLeft ?? walk,
    sidewalkRight: overrides.sidewalkRight ?? walk,
    points,
    signalId: null,
    intersectionId: overrides.intersectionId ?? null,
    maxspeedKmh: 40,
  };
}

const META = { generator: 'openstreetmap', streetDesign: { streetScale: 1, sidewalkScale: 1, curbHeight: 0.16, roadLift: 0.45 } };

// One isolated straight 100 m arterial: the reference cross-section and the
// street the per-100 m triangle budget is measured on.
function straightCity() {
  return {
    meta: META,
    segments: [makeSegment('iso', [{ x: 200, z: 0 }, { x: 300, z: 0 }])],
    intersections: [],
  };
}

// Signalised four-way: 12 m arterial east/west, 9 m residential north/south.
function junctionCity(signalId = 'sig-1', extra = {}) {
  return {
    meta: META,
    segments: [
      makeSegment('w', [{ x: -60, z: 0 }, { x: 0, z: 0 }]),
      makeSegment('e', [{ x: 0, z: 0 }, { x: 60, z: 0 }]),
      makeSegment('n', [{ x: 0, z: -60 }, { x: 0, z: 0 }], { highway: 'residential', lanes: 2, width: 9, sidewalkW: 2.5 }),
      makeSegment('s', [{ x: 0, z: 0 }, { x: 0, z: 60 }], { highway: 'residential', lanes: 2, width: 9, sidewalkW: 2.5, ...extra }),
    ],
    intersections: [{ id: 'i1', position: { x: 0, z: 0 }, streetIds: ['w', 'e', 'n', 's'], signalId }],
  };
}

const ROAD_LIFT = META.streetDesign.roadLift;
const O = resolveStreetSurfaceOptions({ meta: META });

function componentRange(layer, comp) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = comp; i < layer.positions.length; i += 3) {
    min = Math.min(min, layer.positions[i]);
    max = Math.max(max, layer.positions[i]);
  }
  return { min, max };
}

function quadHeights(layer) {
  const out = [];
  const quadCount = layer.positions.length / 12;
  for (let q = 0; q < quadCount; q += 1) {
    const base = q * 12;
    const ys = [0, 1, 2, 3].map((k) => layer.positions[base + k * 3 + 1]);
    out.push(Math.max(...ys) - Math.min(...ys));
  }
  return out;
}

// ---------------------------------------------------------------------------

section('1. module contract');
assert(STREET_SURFACE_V2_ID === 'street-surface-v2', 'module id is street-surface-v2');
assert(STREET_SURFACE_V2_LAYERS.length === 7, 'seven geometry layers are declared');
{
  const grouped = Object.values(STREET_SURFACE_V2_MESH_GROUPS).flat().sort();
  assert(JSON.stringify(grouped) === JSON.stringify([...STREET_SURFACE_V2_LAYERS].sort()),
    'every layer is assigned to exactly one mesh group');
  assert(Object.keys(STREET_SURFACE_V2_MESH_GROUPS).length <= STREET_SURFACE_V2_BUDGET.maxDrawCalls,
    `mesh groups (${Object.keys(STREET_SURFACE_V2_MESH_GROUPS).length}) stay inside the ${STREET_SURFACE_V2_BUDGET.maxDrawCalls} draw-call budget`);
}
assert(O.roadLift === ROAD_LIFT, 'roadLift is read from city.meta.streetDesign (0.45)');
assert(STREET_SURFACE_V2_DEFAULTS.curbFaceHeight === 0.15, 'default curb face height is 0.15 m');
assert(STREET_SURFACE_V2_DEFAULTS.markingLift === 0.012, 'default marking lift is 12 mm');
assert(STREET_SURFACE_V2_DEFAULTS.junctionPaintLift === 0.015,
  'junction paint sits 3 mm above segment paint so crossings do not fight edge lines');

section('2. straight arterial cross-section');
const straight = buildStreetSurfaceData(straightCity());
const S = straight.layers;
const HALF = 6;
{
  const z = componentRange(S.carriageway, 2);
  assert(near(z.min, -HALF) && near(z.max, HALF),
    `carriageway spans exactly segment.width (12 m): z in [${z.min}, ${z.max}]`);
  const y = componentRange(S.carriageway, 1);
  assert(near(y.max, ROAD_LIFT + O.crossSlope * HALF),
    `crown is datum + crossSlope*half = ${ROAD_LIFT + O.crossSlope * HALF} m`);
  assert(near(y.min, ROAD_LIFT - O.gutterDepth),
    `gutter invert is datum - gutterDepth = ${ROAD_LIFT - O.gutterDepth} m`);
  const ys = new Set();
  for (let i = 1; i < S.carriageway.positions.length; i += 3) ys.add(S.carriageway.positions[i].toFixed(6));
  assert(ys.size >= 3, `carriageway is not planar: ${ys.size} distinct surface heights across the section`);
  assert(y.max - y.min > 0.1, 'crown-to-gutter relief is over 100 mm');
}
{
  const heights = quadHeights(S.curbFace);
  const distinct = [...new Set(heights.map((h) => h.toFixed(9)))];
  assert(distinct.length === 1 && near(Number(distinct[0]), 0.15, 1e-9),
    `every one of the ${heights.length} curb face quads is exactly 0.15 m tall`);
  const y = componentRange(S.curbFace, 1);
  assert(near(y.min, ROAD_LIFT - O.gutterDepth), 'curb face starts at the gutter invert (no crack at the road edge)');
  assert(near(y.max, ROAD_LIFT - O.gutterDepth + 0.15), 'curb top sits 0.15 m above the invert');
}
{
  const zTop = componentRange(S.curbTop, 2);
  assert(near(Math.max(-zTop.min, zTop.max), HALF + O.curbTopWidth),
    'curb top runs from the carriageway edge outward by curbTopWidth');
  const zWalk = componentRange(S.sidewalk, 2);
  assert(near(Math.max(-zWalk.min, zWalk.max), HALF + 3),
    'sidewalk outer edge is at half + sidewalkW (9 m)');
  const yWalk = componentRange(S.sidewalk, 1);
  assert(near(yWalk.min, ROAD_LIFT - O.gutterDepth + 0.15 + O.curbTopFall),
    'sidewalk starts at curb-top level');
  assert(yWalk.max > yWalk.min, 'sidewalk cross-falls toward the curb instead of being flat');
}

section('3. lane markings from lanes / oneway');
{
  const twoWayFour = planSegmentMarkings(makeSegment('a', [{ x: 0, z: 0 }, { x: 10, z: 0 }]), O);
  const roles = twoWayFour.map((l) => `${l.role}:${l.paint}:${l.dashed ? 'dash' : 'solid'}`);
  assert(twoWayFour.length === 6,
    `two-way 4-lane 12 m arterial gets 6 marking lines (${roles.join(', ')})`);
  assert(twoWayFour.filter((l) => l.role === 'centre').length === 2
    && twoWayFour.filter((l) => l.role === 'centre').every((l) => l.paint === 'yellow' && !l.dashed),
    'a 4-lane two-way street gets a solid double-yellow centre');
  assert(twoWayFour.filter((l) => l.role === 'divider').length === 2
    && twoWayFour.filter((l) => l.role === 'divider').every((l) => l.dashed),
    'lane dividers are dashed, one per direction');
  assert(twoWayFour.filter((l) => l.role === 'edge').length === 2, 'both edge lines are present');

  const twoWayTwo = planSegmentMarkings(makeSegment('b', [{ x: 0, z: 0 }, { x: 10, z: 0 }], { lanes: 2, width: 9 }), O);
  assert(twoWayTwo.length === 3 && twoWayTwo.filter((l) => l.role === 'centre').length === 1
    && twoWayTwo[2].u === 0 && !twoWayTwo[2].dashed,
    'two-way 2-lane street gets a single solid centre line and no dividers');

  const oneWayThree = planSegmentMarkings(
    makeSegment('c', [{ x: 0, z: 0 }, { x: 10, z: 0 }], { lanes: 3, oneway: true, width: 10.5 }), O);
  assert(oneWayThree.length === 4 && oneWayThree.filter((l) => l.role === 'centre').length === 0
    && oneWayThree.filter((l) => l.role === 'divider' && l.dashed).length === 2,
    'one-way 3-lane street gets no centre line and 2 dashed dividers');

  const service = planSegmentMarkings(
    makeSegment('d', [{ x: 0, z: 0 }, { x: 10, z: 0 }], { highway: 'service', width: 5, lanes: 2 }), O);
  assert(service.length === 0, 'service roads are left unmarked');

  const alley = planSegmentMarkings(
    makeSegment('e', [{ x: 0, z: 0 }, { x: 10, z: 0 }], { width: 4, lanes: 2 }), O);
  assert(alley.length === 0, 'streets narrower than 2 * minMarkedHalfWidth are left unmarked');
}
{
  // Solid lines follow the station list (100 m at maxStep 6 -> 17 spans);
  // dashed lines use a 3 m mark / 6 m gap cycle -> 12 dashes per 100 m.
  const solidSpans = Math.ceil(100 / O.maxStep);
  const dashes = Math.ceil((100 - 0.4) / (O.dashMark + O.dashGap));
  const expected = 4 * solidSpans + 2 * dashes;
  assert(straight.stats.markingQuads === expected,
    `100 m of two-way 4-lane street emits ${expected} marking quads (4 solid x ${solidSpans} spans + 2 dashed x ${dashes})`);
  assert(straight.stats.markingLines === 6 && straight.stats.dashedLines === 2,
    'marking stats report 6 lines of which 2 are dashed');
}
{
  // Every marking vertex is markingLift above the cambered carriageway sampled
  // at the same lateral station - not above a flat plane.
  const layer = S.marking;
  let worst = 0;
  for (let i = 0; i < layer.positions.length; i += 3) {
    const u = layer.positions[i + 2];
    const a = Math.min(Math.abs(u), HALF);
    const crown = O.crossSlope * HALF;
    const gutterStart = HALF - O.gutterWidth;
    let surface;
    if (a <= gutterStart) surface = ROAD_LIFT + crown * (1 - a / HALF);
    else {
      const lip = ROAD_LIFT + crown * (1 - gutterStart / HALF);
      const t = (a - gutterStart) / (HALF - gutterStart);
      surface = lip + ((ROAD_LIFT - O.gutterDepth) - lip) * t;
    }
    worst = Math.max(worst, Math.abs((layer.positions[i + 1] - surface) - O.markingLift));
  }
  assert(worst < 1e-9, `all marking vertices sit exactly ${O.markingLift * 1000} mm above the cambered surface (max error ${worst.toExponential(2)})`);
}

section('4. signalised junction');
const junction = buildStreetSurfaceData(junctionCity('sig-1'));
{
  const st = junction.stats;
  assert(st.nodes === 1 && st.junctionPads === 1, 'the four-way node produces one junction pad');
  assert(st.corners === 4, `all four corners get a curb return (${st.corners})`);
  assert(st.ramps === 4, `all four corners get a kerb ramp (${st.ramps})`);
  assert(st.crosswalkBands === 4, `each approach gets a crosswalk band aligned to it (${st.crosswalkBands})`);
  assert(st.stopBars === 4, `each approach gets a stop bar (${st.stopBars})`);
  assert(st.triangles.ramp > 0 && st.triangles.curbFace > 0, 'ramp and curb-return geometry is non-empty');
}
{
  // The approach carriageways are trimmed back so only the pad fills the node.
  const layer = junction.layers.carriageway;
  let apexOnly = true;
  let inside = 0;
  for (let i = 0; i < layer.positions.length; i += 3) {
    const x = layer.positions[i];
    const z = layer.positions[i + 2];
    if (Math.hypot(x, z) > 2) continue;
    inside += 1;
    if (!(near(x, 0, 1e-9) && near(z, 0, 1e-9))) apexOnly = false;
  }
  assert(inside > 0 && apexOnly,
    `only the junction-pad crown sits inside the node (all ${inside} inner vertices are the apex)`);
}
{
  const unsignalised = buildStreetSurfaceData(junctionCity(null));
  assert(unsignalised.stats.crosswalkBands === 0 && unsignalised.stats.stopBars === 0,
    'an unsignalised node gets no crosswalks and no stop bars');
  assert(unsignalised.stats.corners === 4 && unsignalised.stats.junctionPads === 1,
    'an unsignalised node still gets curb returns and a junction pad');
}
{
  // A one-way approach that flows AWAY from the node must not get a stop bar.
  const away = buildStreetSurfaceData(junctionCity('sig-1', { oneway: true }));
  assert(away.stats.stopBars === 3 && away.stats.crosswalkBands === 4,
    'a one-way leg flowing out of the node is striped but gets no stop bar');
}
{
  // Presentation-only node inference: opt-in, never signalised, no new topology.
  const unlisted = junctionCity('sig-1');
  unlisted.intersections = [];
  const off = buildStreetSurfaceData(unlisted);
  assert(off.stats.nodes === 0 && off.stats.junctionPads === 0,
    'with inferNodes off, a node missing from city.intersections gets no junction treatment');
  const on = buildStreetSurfaceData(unlisted, { inferNodes: true });
  assert(on.stats.nodes === 1 && on.stats.corners === 4 && on.stats.ramps === 4 && on.stats.junctionPads === 1,
    'with inferNodes on, four shared centreline endpoints become one junction with four curb returns');
  assert(on.stats.crosswalkBands === 0 && on.stats.stopBars === 0,
    'inferred nodes are never treated as signalised');
  assert(JSON.stringify(unlisted.segments.map((seg) => seg.points))
    === JSON.stringify(junctionCity('sig-1').segments.map((seg) => seg.points)),
    'node inference reads endpoints only and never edits a centreline');
}
{
  const walkY = componentRange(junction.layers.sidewalk, 1);
  const rampY = componentRange(junction.layers.ramp, 1);
  assert(rampY.min < walkY.min + 1e-9 && rampY.max > ROAD_LIFT,
    'kerb ramps descend from footway level down to the gutter');
}

section('5. determinism, source integrity, numeric health');
{
  const cityA = junctionCity('sig-1');
  const snapshot = JSON.stringify({ segments: cityA.segments, intersections: cityA.intersections });
  const first = buildStreetSurfaceData(cityA);
  const second = buildStreetSurfaceData(junctionCity('sig-1'));
  const serialise = (d) => JSON.stringify(STREET_SURFACE_V2_LAYERS.map((n) => d.layers[n].positions
    .concat(d.layers[n].normals, d.layers[n].colors, d.layers[n].uvs, d.layers[n].indices)));
  assert(serialise(first) === serialise(second), 'two builds of the same city are bit-identical');
  assert(JSON.stringify({ segments: cityA.segments, intersections: cityA.intersections }) === snapshot,
    'building does not mutate city.segments or city.intersections');
}
{
  assert(junction.stats.nonFinite === 0 && straight.stats.nonFinite === 0,
    'no NaN/Inf position, normal, uv or colour, and every index is in range');
  let unit = 0;
  for (const name of STREET_SURFACE_V2_LAYERS) {
    const layer = junction.layers[name];
    for (let i = 0; i < layer.normals.length; i += 3) {
      const len = Math.hypot(layer.normals[i], layer.normals[i + 1], layer.normals[i + 2]);
      unit = Math.max(unit, Math.abs(len - 1));
    }
    if (layer.positions.length) {
      assert(layer.indices.length === layer.triangles * 3, `${name}: index count matches the reported triangle count`);
    }
  }
  assert(unit < 1e-6, 'every emitted normal is unit length');
}
{
  const sloped = buildStreetSurfaceData(straightCity(), { heightAt: (x) => x * 0.01 });
  const y = componentRange(sloped.layers.carriageway, 1);
  assert(near(y.min, ROAD_LIFT - O.gutterDepth + 2.0, 1e-9) && near(y.max, ROAD_LIFT + 0.12 + 3.0, 1e-9),
    'the whole cross-section rides the supplied terrain height function');
}

section('6. triangle budget');
{
  const st = straight.stats;
  assert(near(st.streetLengthMeters, 100, 1e-9), 'the reference street is 100 m of presented carriageway');
  console.log(`       measured: ${st.trianglesPer100m.toFixed(0)} triangles per 100 m of two-way 4-lane street`);
  console.log(`       measured: ${junction.stats.trianglesPerIntersection.toFixed(0)} triangles per signalised four-way node`);
  assert(st.trianglesPer100m <= STREET_SURFACE_V2_BUDGET.maxTrianglesPer100m,
    `street cost ${st.trianglesPer100m.toFixed(0)} tri/100 m is inside the ${STREET_SURFACE_V2_BUDGET.maxTrianglesPer100m} budget`);
  assert(st.trianglesPer100m >= 300,
    'the street cost is not silently collapsing to a flat ribbon (>= 300 tri/100 m of real construction)');
  assert(junction.stats.trianglesPerIntersection <= STREET_SURFACE_V2_BUDGET.maxTrianglesPerIntersection,
    `junction cost ${junction.stats.trianglesPerIntersection.toFixed(0)} tri is inside the ${STREET_SURFACE_V2_BUDGET.maxTrianglesPerIntersection} budget`);
  assert(straight.stats.budget.withinTrianglesPer100m && junction.stats.budget.withinTrianglesPerIntersection,
    'the reported budget flags agree with the measured cost');
}

section('7. THREE build (stock materials only, WebGL2-safe)');
{
  const built = buildStreetSurfaceV2(junctionCity('sig-1'));
  assert(built.drawCalls === 3 && built.group.children.length === 3,
    'the build produces exactly three meshes / draw calls');
  for (const material of Object.values(built.materials)) {
    assert(material.isMeshStandardMaterial === true && material.type === 'MeshStandardMaterial',
      `${material.type} is a stock MeshStandardMaterial (no ShaderMaterial, no onBeforeCompile)`);
    assert(typeof material.onBeforeCompile === 'function' && material.onBeforeCompile.length <= 3
      && !Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile'),
      `${material.name || material.type}: onBeforeCompile is untouched`);
  }
  const paint = built.materials.markings;
  assert(paint.polygonOffset === true && paint.polygonOffsetFactor === -4 && paint.polygonOffsetUnits === -8,
    'marking material uses polygonOffset factor -4 / units -8 against grazing-angle z-fighting');
  assert(built.meshes.markings.renderOrder === 2, 'markings draw after the road surface');
  for (const [name, geometry] of Object.entries(built.geometries)) {
    const position = geometry.getAttribute('position');
    assert(position && geometry.getAttribute('normal') && geometry.getAttribute('color') && geometry.getAttribute('uv'),
      `${name} geometry carries position, normal, color and uv`);
    assert(geometry.boundingSphere && Number.isFinite(geometry.boundingSphere.radius),
      `${name} bounding sphere is finite`);
    assert(geometry.index.count % 3 === 0 && geometry.index.count > 0, `${name} index buffer is triangulated`);
  }
  const uv = built.geometries.carriageway.getAttribute('uv');
  const pos = built.geometries.carriageway.getAttribute('position');
  assert(near(uv.getX(0), pos.getX(0) / O.uvMetersPerRepeat.carriageway, 1e-4),
    'uvs are world XZ over metersPerRepeat, matching the renderer ground-material convention');
  disposeStreetSurfaceV2(built);
  assert(built.group.children.length === 0, 'dispose releases the group contents');
  assert(THREE.REVISION.length > 0, `built against three r${THREE.REVISION}`);
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('street-surface-v2 OK');
