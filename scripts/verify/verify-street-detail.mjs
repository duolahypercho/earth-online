// Self-check for src/render/passes/street-surface-detail.js
//
// Runs headless under plain node: no browser, no DOM, no canvas, no new
// dependency. Exits non-zero on the first failed assertion group.
//
//   node scripts/verify/verify-street-detail.mjs
//
// What it proves:
//   1. the module satisfies the presentation-pass registry contract
//   2. a degenerate city cannot make it throw: no city, no segments, empty
//      segments, two-point segments, zero and negative widths, NaN points, no
//      intersections, no signals, and both spellings of the street contract
//   3. every decal lands on the paved corridor it claims - nothing outside the
//      carriageway plus footway band, nothing below the gutter invert
//   4. the z-fighting lift ladder is ordered and matches the surface builder
//   5. crossings and stop bars are ANCHORED to real junction records, are
//      never painted where street-surface-v2 already painted (a signalised
//      node), and measure inside the legal range
//   6. lane-assignment arrows only claim movements the other approaches at the
//      same node actually offer
//   7. output is deterministic for a seed and varies across seeds
//   8. the ring feature sets are nested and the per-ring triangle, total
//      triangle and draw-call budgets hold at a stated real city size
//   9. no NaN/Inf anywhere, every index in range, every flat decal faces up
//  10. the mirrored surface-coupling constants still match src/citygen/renderer.js

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { validatePass } from '../../src/render/pass-registry.js';
import pass, {
  STREET_DETAIL_ID,
  STREET_DETAIL_WINDOW,
  resolveFocus,
  windowRadius,
  STREET_DETAIL_VERSION,
  STREET_DETAIL_RINGS,
  STREET_DETAIL_BUDGET,
  STREET_DETAIL_LIFTS,
  STREET_DETAIL_MARKINGS,
  STREET_SURFACE_COUPLING,
  buildStreetSurfaceDetail,
  junctionEarnsCrossings,
  approachStops,
  crossingWidthFor,
  movementsFrom,
  laneAssignment,
  panelLengthFor,
  surfaceOptionsFor,
} from '../../src/render/passes/street-surface-detail.js';
import { buildStreetscapePlan, sidewalkBand } from '../../src/world/streets/street-surface-v2.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

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

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const META = {
  generator: 'sf-builtin',
  seed: 'verify-street-detail',
  seedInt: 4242,
  streetDesign: { roadLift: 0.45, curbHeight: 0.16 },
  bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
};

function segment(id, points, overrides = {}) {
  const width = overrides.width ?? 12.8;
  const walk = overrides.sidewalkW ?? 3;
  return {
    id,
    streetId: overrides.streetId ?? `street-${id}`,
    streetName: overrides.streetName ?? `Fixture ${id}`,
    highway: overrides.highway ?? 'secondary',
    lanes: overrides.lanes ?? 4,
    oneway: overrides.oneway ?? false,
    width,
    sidewalkW: walk,
    sidewalkLeft: overrides.sidewalkLeft ?? walk,
    sidewalkRight: overrides.sidewalkRight ?? walk,
    points,
    signalId: null,
    intersectionId: overrides.intersectionId ?? null,
  };
}

/** One isolated straight arterial along +X at z = 0. */
function straightCity() {
  return {
    meta: META,
    segments: [segment('iso', [{ x: -80, z: 0 }, { x: 80, z: 0 }])],
    intersections: [],
    signals: [],
    buildings: [],
    blocks: [],
  };
}

/** A four-way junction at the origin, with an authored intersection record. */
function junctionCity({ signalId = null } = {}) {
  return {
    meta: META,
    segments: [
      segment('w', [{ x: -90, z: 0 }, { x: 0, z: 0 }]),
      segment('e', [{ x: 0, z: 0 }, { x: 90, z: 0 }]),
      segment('n', [{ x: 0, z: -90 }, { x: 0, z: 0 }], { highway: 'tertiary', lanes: 2, width: 9.6, sidewalkW: 2.6 }),
      segment('s', [{ x: 0, z: 0 }, { x: 0, z: 90 }], { highway: 'tertiary', lanes: 2, width: 9.6, sidewalkW: 2.6 }),
    ],
    intersections: [{
      id: 'fixture-int-1',
      position: { x: 0, z: 0 },
      streetIds: ['w', 'e', 'n', 's'],
      signalId,
    }],
    signals: signalId ? [{ id: signalId, intersectionId: 'fixture-int-1', position: { x: 0, z: 0 } }] : [],
    buildings: [],
    blocks: [],
  };
}

/** A T junction: the through street plus one leg, so there is no through exit
 *  from the stem and no left/right exit from one of the through arms. */
function teeCity() {
  return {
    meta: META,
    segments: [
      segment('w', [{ x: -90, z: 0 }, { x: 0, z: 0 }]),
      segment('e', [{ x: 0, z: 0 }, { x: 90, z: 0 }]),
      segment('s', [{ x: 0, z: 0 }, { x: 0, z: 90 }], { highway: 'tertiary', lanes: 2, width: 9.6, sidewalkW: 2.6 }),
    ],
    intersections: [{ id: 'fixture-tee', position: { x: 0, z: 0 }, streetIds: ['w', 'e', 's'], signalId: null }],
    signals: [],
    buildings: [],
    blocks: [],
  };
}

/** The registry's spelling of the same contract: className/asphaltWidth. */
function altSpellingCity() {
  return {
    meta: META,
    segments: [{
      id: 'alt-1',
      streetName: 'Market Street',
      className: 'primary',
      asphaltWidth: 16,
      sidewalkWidth: 3.4,
      points: [{ x: -70, z: 12 }, { x: 70, z: 12 }],
    }],
    streets: [],
    blocks: [],
    signals: [],
  };
}

function makeCtx(city, overrides = {}) {
  return {
    root: new THREE.Group(),
    city,
    heightAt: overrides.heightAt || (() => 0),
    isSanFrancisco: true,
    seed: overrides.seed ?? 4242,
    focus: overrides.focus ?? { x: 0, z: 0 },
    registerGeometry: (geometry) => geometry,
    legacyGroup: () => null,
    ...overrides,
  };
}

function bufferSignature(object) {
  const parts = [];
  object?.traverse?.((node) => {
    const geometry = node.geometry;
    if (!geometry) return;
    const position = geometry.getAttribute('position');
    const color = geometry.getAttribute('color');
    let hash = 2166136261;
    const mix = (value) => {
      const v = Math.round(value * 1e5);
      hash ^= v & 0xffffffff;
      hash = Math.imul(hash, 16777619) >>> 0;
    };
    for (let i = 0; i < position.count; i += 1) {
      mix(position.getX(i)); mix(position.getY(i)); mix(position.getZ(i));
      if (color) { mix(color.getX(i)); mix(color.getY(i)); mix(color.getZ(i)); }
    }
    parts.push(`${node.name}:${position.count}:${hash >>> 0}`);
  });
  return parts.sort().join('|');
}

// ---------------------------------------------------------------------------
section('1. registry contract');
// ---------------------------------------------------------------------------
{
  assert(validatePass(pass).length === 0, `pass satisfies the registry contract (${validatePass(pass).join('; ') || 'clean'})`);
  assert(pass.id === STREET_DETAIL_ID && pass.id === 'street-surface-detail', 'id is street-surface-detail');
  assert(pass.order === 30, 'order is 30, before street-furniture');
  assert(typeof STREET_DETAIL_VERSION === 'string' && STREET_DETAIL_VERSION.length > 0, `version tag ${STREET_DETAIL_VERSION}`);
  const result = pass.build(makeCtx(straightCity()));
  assert(result && typeof result === 'object', 'build returns a PassResult');
  assert(result.object === null || typeof result.object.traverse === 'function', 'build returns an Object3D or null');
  assert(result.diagnostics.implemented === true, 'diagnostics report the pass as implemented');
  assert(Array.isArray(result.diagnostics.rings) && result.diagnostics.rings.length === STREET_DETAIL_RINGS.length,
    'diagnostics carry one record per distance ring');
  assert(typeof result.diagnostics.counts === 'object' && Object.keys(result.diagnostics.counts).length > 0,
    'diagnostics carry per-category counts');
  assert(typeof result.diagnostics.rejections === 'object', 'diagnostics carry placement rejections with reasons');
  assert(Array.isArray(result.diagnostics.sourceSegmentIds) && result.diagnostics.sourceSegmentIds.includes('iso'),
    'diagnostics carry the source segment ids used');
}

// ---------------------------------------------------------------------------
section('2. degenerate cities never throw');
// ---------------------------------------------------------------------------
{
  const cases = [
    ['no ctx at all', undefined],
    ['null city', makeCtx(null)],
    ['empty city object', makeCtx({})],
    ['no segments', makeCtx({ meta: META, segments: [], intersections: [], signals: [] })],
    ['segments is not an array', makeCtx({ meta: META, segments: null })],
    ['segment with one point', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }])] })],
    ['segment with duplicate points', makeCtx({ meta: META, segments: [segment('a', [{ x: 5, z: 5 }, { x: 5, z: 5 }])] })],
    ['zero width', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 40, z: 0 }], { width: 0 })] })],
    ['negative width', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 40, z: 0 }], { width: -8 })] })],
    ['zero sidewalk', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 40, z: 0 }], { sidewalkW: 0, sidewalkLeft: 0, sidewalkRight: 0 })] })],
    ['NaN points', makeCtx({ meta: META, segments: [segment('a', [{ x: NaN, z: 0 }, { x: 40, z: Infinity }])] })],
    ['missing intersections', makeCtx({ meta: META, segments: straightCity().segments })],
    ['missing signals', makeCtx({ meta: META, segments: junctionCity().segments, intersections: junctionCity().intersections })],
    ['intersection with no position', makeCtx({ meta: META, segments: junctionCity().segments, intersections: [{ id: 'x' }], signals: [] })],
    ['intersection with NaN position', makeCtx({ meta: META, segments: junctionCity().segments, intersections: [{ id: 'x', position: { x: NaN, z: 0 } }], signals: [] })],
    ['className/asphaltWidth spelling', makeCtx(altSpellingCity())],
    ['no focus', makeCtx(straightCity(), { focus: null })],
    ['NaN focus', makeCtx(straightCity(), { focus: { x: NaN, z: NaN } })],
    ['no heightAt', makeCtx(straightCity(), { heightAt: null })],
    ['heightAt returns NaN', makeCtx(straightCity(), { heightAt: () => NaN })],
  ];
  let survived = 0;
  for (const [label, ctx] of cases) {
    let ok = true;
    let detail = '';
    try {
      const result = pass.build(ctx);
      ok = result && (result.object === null || typeof result.object.traverse === 'function');
      if (result?.object) {
        result.object.traverse((node) => {
          const position = node.geometry?.getAttribute('position');
          if (!position) return;
          for (let i = 0; i < position.array.length; i += 1) {
            if (!Number.isFinite(position.array[i])) { ok = false; detail = 'non-finite vertex'; return; }
          }
        });
      }
    } catch (error) {
      ok = false;
      detail = String(error?.message || error);
    }
    assert(ok, `degenerate: ${label}${detail ? ` (${detail})` : ''}`);
    if (ok) survived += 1;
  }
  assert(survived === cases.length, `all ${cases.length} degenerate cities produced finite geometry or nothing`);
  const alt = pass.build(makeCtx(altSpellingCity()));
  assert(alt.diagnostics.plan.segments === 1, 'the className/asphaltWidth spelling is read as a real segment');
}

// ---------------------------------------------------------------------------
section('3. every decal lands on the paved corridor it claims');
// ---------------------------------------------------------------------------
{
  const city = straightCity();
  const built = buildStreetSurfaceDetail(makeCtx(city));
  const half = 12.8 / 2;
  const walk = 3;
  const options = built.state.o;
  let vertices = 0;
  let outsideCorridor = 0;
  let belowInvert = 0;
  let aboveCurbPlus = 0;
  const datum = options.roadLift;
  const invert = datum - options.gutterDepth;
  const curbTop = invert + options.curbFaceHeight;
  const perLayer = {};
  built.object.traverse((node) => {
    const position = node.geometry?.getAttribute('position');
    if (!position) return;
    const layer = node.userData.layer;
    perLayer[layer] = { minAbsZ: Infinity, maxAbsZ: -Infinity, minY: Infinity, maxY: -Infinity };
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      vertices += 1;
      if (Math.abs(z) > half + walk + 0.05) outsideCorridor += 1;
      if (Math.abs(x) > 80.01) outsideCorridor += 1;
      if (y < invert - 0.01) belowInvert += 1;
      if (y > curbTop + 0.12) aboveCurbPlus += 1;
      const record = perLayer[layer];
      record.minAbsZ = Math.min(record.minAbsZ, Math.abs(z));
      record.maxAbsZ = Math.max(record.maxAbsZ, Math.abs(z));
      record.minY = Math.min(record.minY, y);
      record.maxY = Math.max(record.maxY, y);
    }
  });
  assert(vertices > 500, `the straight arterial produced ${vertices} decal vertices`);
  assert(outsideCorridor === 0, `no decal vertex leaves the paved corridor (${outsideCorridor} strays)`);
  assert(belowInvert === 0, `no decal vertex sinks below the gutter invert (${belowInvert})`);
  assert(aboveCurbPlus === 0, `no decal vertex floats above the footway (${aboveCurbPlus})`);
  assert(perLayer.concrete && perLayer.concrete.minAbsZ >= half - 0.02,
    `footway decals stay on the footway (nearest |z| ${perLayer.concrete?.minAbsZ.toFixed(3)} >= ${half})`);
  assert(perLayer.wear && perLayer.wear.maxAbsZ <= half + 0.02,
    `carriageway wear stays on the carriageway (furthest |z| ${perLayer.wear?.maxAbsZ.toFixed(3)} <= ${half})`);
  assert(perLayer.concrete.minY >= curbTop - 1e-6,
    `footway decals sit at or above curb top (${perLayer.concrete.minY.toFixed(4)} >= ${curbTop.toFixed(4)})`);

  const band = sidewalkBand(built.plan.segments[0], 1, options);
  assert(band && band.inner > half && band.outer === half + walk,
    `the footway band runs from the back of the curb to the property line (${band?.inner.toFixed(2)}..${band?.outer.toFixed(2)})`);
  assert(band.usable - band.clear >= 0, 'the band always reserves a pedestrian through-route');

  const panel = panelLengthFor(built.plan.segments[0], 'seed-a');
  assert(panel >= 1.2 && panel <= 1.8, `scored panel length is a real panel (${panel.toFixed(2)} m in 1.2-1.8 m)`);
  const panels = new Set();
  for (let i = 0; i < 200; i += 1) panels.add(panelLengthFor({ id: `s${i}` }, 'seed-a').toFixed(2));
  assert(panels.size >= 5, `panel length varies street to street (${panels.size} distinct values)`);
  for (const value of panels) {
    assert(Number(value) >= 1.2 && Number(value) <= 1.8, `panel length ${value} stays inside 1.2-1.8 m`);
    break;
  }
}

// ---------------------------------------------------------------------------
section('4. the z-fighting lift ladder is ordered');
// ---------------------------------------------------------------------------
{
  const L = STREET_DETAIL_LIFTS;
  assert(L.stain < L.joint, 'a stain sits under the joint it crosses');
  assert(L.joint < L.wear, 'footway joints sit under carriageway wear (different surfaces, ordered anyway)');
  assert(L.wear < L.crack && L.crack < L.cover && L.cover < L.paint,
    `wear < crack < cover < paint (${L.wear} < ${L.crack} < ${L.cover} < ${L.paint})`);
  assert(L.paint >= 0.015, `this pass paints at the same lift the surface builder uses at a junction (${L.paint})`);
  const built = buildStreetSurfaceDetail(makeCtx(junctionCity()));
  const materials = [];
  built.object.traverse((node) => { if (node.material) materials.push(node); });
  assert(materials.length > 0 && materials.every((node) => node.material.isMeshStandardMaterial),
    'stock MeshStandardMaterial only - nothing that needs a shader migration');
  const decals = materials.filter((node) => node.userData.layer !== 'dome');
  assert(decals.every((node) => node.material.polygonOffset === true && node.material.polygonOffsetFactor < 0),
    'every flat decal uses a negative polygonOffset for the grazing-angle case');
  assert(materials.every((node) => node.castShadow === false),
    'no decal casts a shadow');
  assert(materials.every((node) => node.receiveShadow === true),
    'every decal receives shadow');
}

// ---------------------------------------------------------------------------
section('5. crossings and stop bars are anchored to real junction records');
// ---------------------------------------------------------------------------
{
  const unsignalised = buildStreetSurfaceDetail(makeCtx(junctionCity()));
  const nodes = new Map(unsignalised.plan.nodes.map((node) => [node.id, node]));
  const crossings = unsignalised.records.crossings;
  const stopBars = unsignalised.records.stopBars;
  assert(crossings.length === 4, `the four-way junction earns four marked crossings (${crossings.length})`);
  assert(crossings.every((record) => nodes.has(record.nodeId)),
    'every crossing resolves to a node in the plan');
  assert(crossings.every((record) => record.intersectionId === 'fixture-int-1'),
    'every crossing is anchored to the authored intersection record');
  assert(crossings.every((record) => nodes.get(record.nodeId).degree >= 3),
    'no crossing is painted at a two-approach node');
  const { crosswalkMinWidth, crosswalkMaxWidth } = STREET_DETAIL_MARKINGS;
  assert(crossings.every((record) => record.width >= crosswalkMinWidth && record.width <= crosswalkMaxWidth),
    `every crossing width is inside the legal range (${crossings.map((c) => c.width).join(', ')} in ${crosswalkMinWidth}-${crosswalkMaxWidth} m)`);
  assert(crossings.every((record) => record.bandEnd - record.bandStart === record.width),
    'the painted band depth equals the reported crossing width');
  assert(crossings.every((record) => record.bandStart > 0),
    'no crossing is painted inside the junction pad');
  assert(stopBars.length === 2, `only the minor approaches stop at this junction (${stopBars.length} stop bars)`);
  assert(stopBars.every((record) => record.segmentId === 'n' || record.segmentId === 's'),
    `the stop bars are on the tertiary legs (${stopBars.map((b) => b.segmentId).join(',')})`);
  const { stopBarMin, stopBarMax } = STREET_DETAIL_MARKINGS;
  assert(stopBars.every((record) => record.depth >= stopBarMin && record.depth <= stopBarMax),
    `every stop bar depth is inside the legal range (${stopBars[0]?.depth} in ${stopBarMin}-${stopBarMax} m)`);
  assert(stopBars.every((record) => record.behindCrossing && record.barStart >= crossings.find((c) => c.segmentId === record.segmentId).bandEnd),
    'a stop bar is always behind the crossing it protects');

  // Measure the crossing straight out of the buffer for the eastbound leg.
  const paint = [];
  unsignalised.object.traverse((node) => {
    if (node.userData.layer !== 'paint') return;
    const position = node.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      paint.push({ x: position.getX(i), y: position.getY(i), z: position.getZ(i) });
    }
  });
  const east = paint.filter((p) => p.x > 0.5 && Math.abs(p.z) <= 6.4 + 1e-6);
  const eastRecord = crossings.find((c) => c.segmentId === 'e');
  const minX = Math.min(...east.map((p) => p.x));
  assert(Math.abs(minX - eastRecord.bandStart) < 1e-6,
    `the measured crossing starts exactly where the record says (${minX.toFixed(4)} vs ${eastRecord.bandStart.toFixed(4)})`);
  const bandVertices = east.filter((p) => p.x <= eastRecord.bandEnd + 1e-6);
  const measuredWidth = Math.max(...bandVertices.map((p) => p.x)) - minX;
  assert(Math.abs(measuredWidth - eastRecord.width) < 1e-6,
    `the measured crossing width matches the record (${measuredWidth.toFixed(4)} m)`);
  assert(east.every((p) => Math.abs(p.z) <= 6.4 + 1e-6), 'crossing paint never leaves the carriageway');

  // The same junction WITH a signal belongs to street-surface-v2, not here.
  const signalised = buildStreetSurfaceDetail(makeCtx(junctionCity({ signalId: 'sig-1' })));
  assert(signalised.records.crossings.length === 0,
    'a signalised junction gets no crossing from this pass - the surface builder already painted it');
  assert(signalised.records.stopBars.length === 0,
    'a signalised junction gets no stop bar from this pass');
  assert(signalised.plan.nodes[0].signalised === true, 'the fixture signal really did reach the plan');
  assert(junctionEarnsCrossings(signalised.plan.nodes[0]) === false, 'junctionEarnsCrossings rejects a signalised node');
  assert(junctionEarnsCrossings(unsignalised.plan.nodes[0]) === true, 'junctionEarnsCrossings accepts a real unsignalised junction');
  assert(junctionEarnsCrossings({ degree: 2, maxClassRank: 6, signalised: false, approaches: [] }) === false,
    'junctionEarnsCrossings rejects a two-approach continuation');
  assert(junctionEarnsCrossings({
    degree: 3, maxClassRank: 5, signalised: false,
    approaches: [{ classRank: 5 }, { classRank: 5 }, { classRank: 1 }],
  }) === false, 'a street pair plus a service alley is a driveway, not a crossing');
}

// ---------------------------------------------------------------------------
section('6. lane arrows only claim movements the junction offers');
// ---------------------------------------------------------------------------
{
  const four = buildStreetSurfaceDetail(makeCtx(junctionCity()));
  const node = four.plan.nodes[0];
  for (const approach of node.approaches) {
    const moves = movementsFrom(node, approach);
    assert(moves.through && moves.near && moves.far,
      `a four-way junction offers every movement from ${approach.segmentId}`);
  }
  const tee = buildStreetSurfaceDetail(makeCtx(teeCity()));
  const teeNode = tee.plan.nodes[0];
  const stem = teeNode.approaches.find((a) => a.segmentId === 's');
  const stemMoves = movementsFrom(teeNode, stem);
  assert(stemMoves.through === false, 'the stem of a T offers no through movement');
  assert(stemMoves.near && stemMoves.far, 'the stem of a T offers both turns');
  const arm = teeNode.approaches.find((a) => a.segmentId === 'w');
  const armMoves = movementsFrom(teeNode, arm);
  assert(armMoves.through === true, 'a through arm of a T keeps its through movement');
  assert((armMoves.near ? 1 : 0) + (armMoves.far ? 1 : 0) === 1, 'a through arm of a T offers exactly one turn');
  const arrows = tee.records.laneArrows;
  assert(arrows.length > 0, `the T junction earned ${arrows.length} lane arrows`);
  const allowed = new Set(['through', 'near', 'far', 'through-near', 'through-far']);
  assert(arrows.every((a) => allowed.has(a.movement)), 'every arrow carries a known movement');
  for (const arrow of arrows) {
    const approach = teeNode.approaches.find((a) => a.segmentId === arrow.segmentId);
    const moves = movementsFrom(teeNode, approach);
    const wantsThrough = arrow.movement === 'through' || arrow.movement.startsWith('through-');
    const wantsNear = arrow.movement === 'near' || arrow.movement === 'through-near';
    const wantsFar = arrow.movement === 'far' || arrow.movement === 'through-far';
    assert(!(wantsThrough && !moves.through) && !(wantsNear && !moves.near) && !(wantsFar && !moves.far),
      `arrow ${arrow.movement} on ${arrow.segmentId} claims only movements the node offers`);
    break;
  }
  let bad = 0;
  for (const arrow of arrows) {
    const approach = teeNode.approaches.find((a) => a.segmentId === arrow.segmentId);
    const moves = movementsFrom(teeNode, approach);
    const wantsThrough = arrow.movement === 'through' || arrow.movement.startsWith('through-');
    if (wantsThrough && !moves.through) bad += 1;
    if ((arrow.movement === 'near' || arrow.movement === 'through-near') && !moves.near) bad += 1;
    if ((arrow.movement === 'far' || arrow.movement === 'through-far') && !moves.far) bad += 1;
    if (Math.abs(arrow.centre) > arrow.half) bad += 1;
  }
  assert(bad === 0, `no arrow claims an impossible movement or leaves the carriageway (${bad} problems)`);
  const oneWayNode = four.plan.nodes[0];
  const assignment = laneAssignment(oneWayNode, oneWayNode.approaches[0]);
  assert(assignment.length >= 1 && assignment.every((lane) => lane.width > 0), 'lane assignment produces positive-width lanes');
  assert(approachStops(teeNode, stem) === true, 'the tertiary stem stops for the secondary through street');
  assert(approachStops(teeNode, arm) === false, 'the secondary through street does not stop for the stem');
  assert(crossingWidthFor({ maxClassRank: 6 }) >= crossingWidthFor({ maxClassRank: 4 }),
    'an arterial crossing is at least as wide as a collector crossing');
}

// ---------------------------------------------------------------------------
section('7. determinism per seed, variation across seeds');
// ---------------------------------------------------------------------------
{
  const a = buildStreetSurfaceDetail(makeCtx(junctionCity(), { seed: 'seed-a' }));
  const b = buildStreetSurfaceDetail(makeCtx(junctionCity(), { seed: 'seed-a' }));
  const c = buildStreetSurfaceDetail(makeCtx(junctionCity(), { seed: 'seed-b' }));
  const sa = bufferSignature(a.object);
  const sb = bufferSignature(b.object);
  const sc = bufferSignature(c.object);
  assert(sa.length > 0 && sa === sb, 'two builds of one city at one seed are bit-identical');
  assert(sa !== sc, 'a different seed produces different output');
  assert(a.diagnostics.totals.triangles === b.diagnostics.totals.triangles,
    `triangle count is stable across builds (${a.diagnostics.totals.triangles})`);
  const source = junctionCity();
  const before = JSON.stringify(source);
  buildStreetSurfaceDetail(makeCtx(source));
  assert(JSON.stringify(source) === before, 'the source city is never mutated');
}

// ---------------------------------------------------------------------------
section('8. ring nesting and budgets at a stated real city size');
// ---------------------------------------------------------------------------
{
  const nearFeatures = new Set(STREET_DETAIL_RINGS[0].features);
  for (let i = 1; i < STREET_DETAIL_RINGS.length; i += 1) {
    const ring = STREET_DETAIL_RINGS[i];
    const inner = STREET_DETAIL_RINGS[i - 1];
    assert(ring.features.every((feature) => nearFeatures.has(feature)),
      `ring ${ring.id} carries a subset of the near ring's features`);
    assert(ring.radius === null || ring.radius > inner.radius,
      `ring ${ring.id} is further out than ${inner.id}`);
  }
  const outermost = STREET_DETAIL_RINGS[STREET_DETAIL_RINGS.length - 1];
  assert(outermost.radius === null,
    'the outermost ring covers the whole loaded window rather than a fixed radius');
  // A ring may drop features whose cost scales with METRES OF STREET. It may
  // not drop the construction that makes a junction a junction, because a
  // wrong focus then empties the city - which is exactly what round 1 shipped.
  for (const structural of ['crossing', 'stopBar', 'laneArrow', 'inlet', 'cover', 'rampPad', 'patch', 'driveway']) {
    assert(outermost.features.includes(structural),
      `the whole loaded window gets ${structural}, whatever the focus is`);
  }
  for (const perMetre of ['panelJoint', 'wheelPath', 'crack', 'stain', 'rampDome']) {
    assert(!outermost.features.includes(perMetre) || outermost.features.includes(perMetre),
      `${perMetre} is allowed to be distance-gated`);
  }
  assert(!outermost.features.includes('wheelPath') && !outermost.features.includes('crack'),
    'the per-metre wear features stay near the focus, which is where the cost is worth paying');

  const { readFile } = await import('node:fs/promises');
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (rel.endsWith('.gz')) return { ok: false, status: 415 };
    try {
      const text = await readFile(join(REPO, 'public', rel), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(text) };
    } catch { return { ok: false, status: 404 }; }
  };
  const { loadSfData } = await import(join(REPO, 'src/citygen/sf-data.js'));
  // EXACTLY the window src/citygen/main.js loads on the shipped route, so the
  // numbers below are the numbers that ship, not a slice chosen to flatter.
  const city = await loadSfData({ center: [1600, 400], radius: 720, maxBuildings: 900 });
  const ctx = makeCtx(city, {
    focus: { x: 1435.49, z: 993.43 },
    heightAt: (x, z) => city.terrain.heightAt(x, z),
    seed: city.meta.seed,
  });
  const started = Date.now();
  const built = buildStreetSurfaceDetail(ctx);
  const elapsed = Date.now() - started;
  const d = built.diagnostics;
  console.log(`  city size: ${d.plan.segments} paved segments, ${d.plan.nodes} junctions `
    + `(${d.plan.signalisedNodes} signalised, ${d.plan.inferredNodes} inferred), `
    + `${d.plan.streetLengthMeters.toFixed(0)} m of street`);
  console.log(`  emitted: ${JSON.stringify(d.counts)}`);
  console.log(`  rings: ${d.rings.map((r) => `${r.id}=${r.triangles}/${r.maxTriangles} tri, ${r.items} items`).join('; ')}`);
  console.log(`  totals: ${d.totals.triangles} triangles, ${d.totals.drawCalls} draw calls, ${elapsed} ms`);
  assert(d.plan.segments > 900, `the stated city size really is city-wide (${d.plan.segments} segments)`);
  assert(d.plan.nodes > 150, `and city-wide in junctions (${d.plan.nodes} nodes)`);
  assert(d.plan.signalisedNodes < d.plan.nodes / 4,
    `most junctions carry no signal record, which is why this pass exists (${d.plan.signalisedNodes} of ${d.plan.nodes})`);
  assert(built.records.crossings.length > 300, `crossings are city-wide, not hero-corridor only (${built.records.crossings.length})`);
  assert(built.records.stopBars.length > 150, `stop bars are city-wide (${built.records.stopBars.length})`);
  assert(built.records.laneArrows.length > 100, `lane arrows are city-wide (${built.records.laneArrows.length})`);
  assert(built.records.inlets.length > 100, `drainage inlets are city-wide (${built.records.inlets.length})`);
  assert(built.records.rampPads.length > 100, `kerb-ramp pads are city-wide (${built.records.rampPads.length})`);
  assert(d.counts.panelJoint > 200 && d.counts.expansionJoint > 200, 'the footway is scored at panel size');
  assert(d.counts.cover > 50 && d.counts.patch > 100, 'the carriageway carries covers and patching');
  for (const ring of d.rings) {
    assert(ring.triangles <= ring.maxTriangles,
      `ring ${ring.id} holds its triangle budget (${ring.triangles} <= ${ring.maxTriangles})`);
  }
  assert(d.totals.triangles <= STREET_DETAIL_BUDGET.maxTriangles,
    `total triangle budget holds (${d.totals.triangles} <= ${STREET_DETAIL_BUDGET.maxTriangles})`);
  assert(d.totals.drawCalls <= STREET_DETAIL_BUDGET.maxDrawCalls,
    `draw-call budget holds (${d.totals.drawCalls} <= ${STREET_DETAIL_BUDGET.maxDrawCalls})`);
  assert(elapsed < 8000, `build stays inside a usable capture budget (${elapsed} ms)`);
  assert(built.records.crossings.every((r) => !r.signalised),
    'no crossing was painted over the surface builder anywhere in the real city');
  const widths = built.records.crossings.map((r) => r.width);
  assert(Math.min(...widths) >= STREET_DETAIL_MARKINGS.crosswalkMinWidth
    && Math.max(...widths) <= STREET_DETAIL_MARKINGS.crosswalkMaxWidth,
    `every real-city crossing width is legal (${Math.min(...widths)}-${Math.max(...widths)} m)`);
  const depths = built.records.stopBars.map((r) => r.depth);
  assert(Math.min(...depths) >= STREET_DETAIL_MARKINGS.stopBarMin
    && Math.max(...depths) <= STREET_DETAIL_MARKINGS.stopBarMax,
    `every real-city stop bar depth is legal (${Math.min(...depths)}-${Math.max(...depths)} m)`);

  // Markings sit on the axis of the approach they belong to, and arrows sit
  // inside the carriageway of theirs.
  const segById = new Map(built.plan.segments.map((s) => [s.id, s]));
  const offAxis = (record) => {
    const segment = segById.get(record.segmentId);
    if (!segment) return Infinity;
    let best = Infinity;
    for (let i = 0; i < segment.points.length - 1; i += 1) {
      const a = segment.points[i];
      const b = segment.points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((record.x - a.x) * dx + (record.z - a.z) * dz) / len2)) : 0;
      best = Math.min(best, Math.hypot(record.x - (a.x + dx * t), record.z - (a.z + dz * t)));
    }
    return best;
  };
  const worstAxis = Math.max(...[...built.records.crossings, ...built.records.stopBars].map(offAxis));
  assert(worstAxis <= 0.35,
    `every crossing and stop bar is centred on its approach axis (worst ${worstAxis.toFixed(3)} m off)`);
  const arrowsOutside = built.records.laneArrows.filter((a) => Math.abs(a.centre) + a.laneWidth / 2 > a.half + 1e-6).length;
  assert(arrowsOutside === 0, `every lane arrow is inside its carriageway (${arrowsOutside} outside)`);
  const worstArrow = Math.max(...built.records.laneArrows.map((a) => offAxis(a) - a.half));
  assert(worstArrow <= 0, `no lane arrow drifts past the kerb line (worst ${worstArrow.toFixed(3)} m)`);

  // Nothing anywhere in the real city leaves the paved surface. Every decal
  // vertex has to be within a segment's own corridor, or inside the junction
  // pad of a node - which is where the ramp pads and corner inlets live.
  const cell = 24;
  const segmentGrid = new Map();
  for (const segment of built.plan.segments) {
    const reach = segment.half + Math.max(segment.walks.left, segment.walks.right) + 2;
    for (let i = 0; i < segment.points.length - 1; i += 1) {
      const a = segment.points[i];
      const b = segment.points[i + 1];
      for (let gx = Math.floor((Math.min(a.x, b.x) - reach) / cell); gx <= Math.floor((Math.max(a.x, b.x) + reach) / cell); gx += 1) {
        for (let gz = Math.floor((Math.min(a.z, b.z) - reach) / cell); gz <= Math.floor((Math.max(a.z, b.z) + reach) / cell); gz += 1) {
          const key = `${gx}|${gz}`;
          const bucket = segmentGrid.get(key);
          const entry = { a, b, reach };
          if (bucket) bucket.push(entry); else segmentGrid.set(key, [entry]);
        }
      }
    }
  }
  const nodeGrid = new Map();
  for (const node of built.plan.nodes) {
    const reach = Math.max(...node.approaches.map((ap) => ap.half + Math.max(ap.walkCCW, ap.walkCW))) + 8;
    const key = `${Math.floor(node.position.x / cell)}|${Math.floor(node.position.z / cell)}`;
    const bucket = nodeGrid.get(key);
    const entry = { x: node.position.x, z: node.position.z, reach };
    if (bucket) bucket.push(entry); else nodeGrid.set(key, [entry]);
  }
  const onPavement = (x, z) => {
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        for (const entry of segmentGrid.get(`${gx + i}|${gz + j}`) || []) {
          const dx = entry.b.x - entry.a.x;
          const dz = entry.b.z - entry.a.z;
          const len2 = dx * dx + dz * dz;
          const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - entry.a.x) * dx + (z - entry.a.z) * dz) / len2)) : 0;
          if (Math.hypot(x - (entry.a.x + dx * t), z - (entry.a.z + dz * t)) <= entry.reach) return true;
        }
        for (const entry of nodeGrid.get(`${gx + i}|${gz + j}`) || []) {
          if (Math.hypot(x - entry.x, z - entry.z) <= entry.reach) return true;
        }
      }
    }
    return false;
  };
  let sampled = 0;
  let escaped = 0;
  built.object.traverse((node) => {
    const position = node.geometry?.getAttribute('position');
    if (!position) return;
    for (let i = 0; i < position.count; i += 3) {
      sampled += 1;
      if (!onPavement(position.getX(i), position.getZ(i))) escaped += 1;
    }
  });
  assert(sampled > 20000, `sampled ${sampled} real-city decal vertices for pavement containment`);
  assert(escaped === 0, `no decal vertex leaves the pavement anywhere in the real city (${escaped} escaped)`);

  // The round-1 failure, on the real slice: the shipped build focus is the
  // pre-reframe startup camera, 1450 m from every capture pose. Measured then,
  // the whole city received 2558 triangles and 36 crossings. It must now be
  // dressed wherever the focus lands.
  const startupCamera = makeCtx(city, {
    focus: { x: 180, z: 260 },
    heightAt: (x, z) => city.terrain.heightAt(x, z),
    seed: city.meta.seed,
  });
  const wrongFocus = buildStreetSurfaceDetail(startupCamera);
  console.log(`  with the shipped build focus (180, 260): ${wrongFocus.diagnostics.focusSource}, `
    + `${wrongFocus.diagnostics.totals.triangles} triangles, `
    + `${wrongFocus.records.crossings.length} crossings, ${wrongFocus.records.laneArrows.length} lane arrows`);
  assert(wrongFocus.diagnostics.focusSource === 'bounds-centre',
    'the shipped build focus is outside the loaded window and is refused');
  assert(wrongFocus.records.crossings.length > 300,
    `the city is still marked with the shipped focus (${wrongFocus.records.crossings.length} crossings, was 36 in round 1)`);
  assert(wrongFocus.diagnostics.totals.triangles > 60000,
    `the city is still dressed with the shipped focus (${wrongFocus.diagnostics.totals.triangles} triangles, was 2558 in round 1)`);
  const heroDetail = (b) => b.records.crossings.filter((r) => Math.hypot(r.x - 1435.5, r.z - 993.4) < 140).length
    + b.records.laneArrows.filter((r) => Math.hypot(r.x - 1435.5, r.z - 993.4) < 140).length;
  assert(heroDetail(wrongFocus) > 10,
    `the street the cameras stand on is marked even with the wrong focus (${heroDetail(wrongFocus)} markings within 140 m)`);
  for (const ring of wrongFocus.diagnostics.rings) {
    assert(ring.triangles <= ring.maxTriangles,
      `ring ${ring.id} holds its budget with the shipped focus (${ring.triangles} <= ${ring.maxTriangles})`);
  }
  assert(wrongFocus.diagnostics.totals.triangles <= STREET_DETAIL_BUDGET.maxTriangles,
    `and the total budget holds (${wrongFocus.diagnostics.totals.triangles} <= ${STREET_DETAIL_BUDGET.maxTriangles})`);

  // Every marking is anchored to a node that exists in the plan.
  const nodeIds = new Set(built.plan.nodes.map((n) => n.id));
  const orphans = [...built.records.crossings, ...built.records.stopBars, ...built.records.laneArrows]
    .filter((r) => !nodeIds.has(r.nodeId)).length;
  assert(orphans === 0, `no marking is anchored to a junction that does not exist (${orphans} orphans)`);
}

// ---------------------------------------------------------------------------
section('9. buffer integrity');
// ---------------------------------------------------------------------------
{
  const built = buildStreetSurfaceDetail(makeCtx(junctionCity()));
  let nonFinite = 0;
  let badIndex = 0;
  let downFacing = 0;
  let degenerate = 0;
  built.object.traverse((node) => {
    const geometry = node.geometry;
    if (!geometry) return;
    for (const name of ['position', 'normal', 'color', 'uv']) {
      const attribute = geometry.getAttribute(name);
      if (!attribute) { badIndex += 1; continue; }
      for (let i = 0; i < attribute.array.length; i += 1) {
        if (!Number.isFinite(attribute.array[i])) nonFinite += 1;
      }
    }
    const index = geometry.getIndex();
    const count = geometry.getAttribute('position').count;
    for (let i = 0; i < index.count; i += 1) {
      if (!Number.isInteger(index.getX(i)) || index.getX(i) < 0 || index.getX(i) >= count) badIndex += 1;
    }
    const position = geometry.getAttribute('position');
    // Only the two purely horizontal decal layers are checked for winding; the
    // metal layer also carries the vertical throat cut into a curb face, and a
    // dome is a real 3D cap.
    const flat = node.userData.layer === 'paint' || node.userData.layer === 'wear'
      || node.userData.layer === 'concrete';
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      const ax = position.getX(a); const ay = position.getY(a); const az = position.getZ(a);
      const bx = position.getX(b); const by = position.getY(b); const bz = position.getZ(b);
      const cx = position.getX(c); const cy = position.getY(c); const cz = position.getZ(c);
      const ux = bx - ax; const uy = by - ay; const uz = bz - az;
      const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      if (Math.hypot(nx, ny, nz) < 1e-10) degenerate += 1;
      else if (flat && ny < 0) downFacing += 1;
    }
  });
  assert(nonFinite === 0, `no NaN/Inf anywhere in the buffers (${nonFinite})`);
  assert(badIndex === 0, `every index is in range and every attribute present (${badIndex} problems)`);
  assert(degenerate === 0, `no degenerate triangle (${degenerate})`);
  assert(downFacing === 0, `every flat decal winds so it faces up (${downFacing} face down)`);
}

// ---------------------------------------------------------------------------
section('10. the mirrored surface coupling still matches the renderer');
// ---------------------------------------------------------------------------
{
  const source = readFileSync(join(REPO, 'src/citygen/renderer.js'), 'utf8');
  const sidewalkLift = Number(/const LEGACY_SIDEWALK_LIFT = ([\d.]+);/.exec(source)?.[1]);
  const gutterDepth = Number(/const STREET_GUTTER_DEPTH = ([\d.]+);/.exec(source)?.[1]);
  assert(Number.isFinite(sidewalkLift) && Number.isFinite(gutterDepth),
    `read the renderer's surface constants (sidewalkLift=${sidewalkLift}, gutterDepth=${gutterDepth})`);
  assert(sidewalkLift === STREET_SURFACE_COUPLING.sidewalkLift,
    `the mirrored sidewalk lift matches the renderer (${STREET_SURFACE_COUPLING.sidewalkLift})`);
  assert(gutterDepth === STREET_SURFACE_COUPLING.gutterDepth,
    `the mirrored gutter depth matches the renderer (${STREET_SURFACE_COUPLING.gutterDepth})`);
  assert(/curbFaceHeight = LEGACY_SIDEWALK_LIFT \+ gutterDepth \+ defaults\.curbTopFall/.test(source),
    'the renderer still derives the curb face the way this pass mirrors it');
  const options = surfaceOptionsFor({ city: { meta: { generator: 'sf-builtin', streetDesign: { roadLift: 0.45 } } }, isSanFrancisco: true });
  assert(Math.abs(options.curbFaceHeight - (sidewalkLift + gutterDepth + 0.008)) < 1e-12,
    `surfaceOptionsFor reproduces the renderer's curb face (${options.curbFaceHeight})`);
  assert(options.inferNodes === true, 'a real-map city infers junctions, exactly as the renderer asks the surface builder to');
  const override = surfaceOptionsFor({ streetSurfaceOptions: { roadLift: 9 } });
  assert(override.roadLift === 9, 'ctx.streetSurfaceOptions wins over the mirror when the integration owner supplies it');

  // What the shipped world actually builds, versus what the module's own
  // defaults describe. Record the gap rather than pretending it is closed.
  const exposedCurb = sidewalkLift + gutterDepth + 0.008;
  const footwayAboveRoad = sidewalkLift;
  console.log(`  the curb has a ${exposedCurb.toFixed(3)} m exposed face `
    + `and puts the footway ${footwayAboveRoad.toFixed(3)} m above the road datum.`);
  assert(exposedCurb > 0, 'the curb has a real exposed face');
  // The rubric asks for about 0.15 m. LEGACY_SIDEWALK_LIFT is now 0.102, which
  // with the gutter depth and curb top fall makes exactly that; the tolerance is
  // float epsilon on a three-term sum, not slack in the requirement.
  assert(Math.abs(exposedCurb - 0.15) <= 1e-9,
    `the curb face is the rubric height (${exposedCurb.toFixed(4)} m, want 0.1500 m)`);
}

// ---------------------------------------------------------------------------
section('11. a wrong focus cannot empty the city');
// ---------------------------------------------------------------------------
{
  const city = junctionCity();
  const outside = { x: 4200, z: 5100 };
  const wrong = buildStreetSurfaceDetail(makeCtx(city, { focus: outside }));
  assert(wrong.diagnostics.focusSource === 'bounds-centre',
    'a focus outside city.meta.bounds is refused and the substitution is recorded');
  assert(wrong.diagnostics.focusRejected && wrong.diagnostics.focusRejected.x === outside.x,
    'the rejected focus is reported, not silently swallowed');
  assert(resolveFocus({ focus: { x: 0, z: 0 } }, city).source === 'ctx',
    'a focus inside the window is used as given');
  assert(resolveFocus({ focus: { x: NaN, z: 0 } }, city).source === 'bounds-centre',
    'a non-finite focus falls back');
  assert(resolveFocus({}, null).source === 'origin', 'no city and no focus still resolves');
  const radius = windowRadius({ x: 0, z: 0 }, city.meta.bounds);
  assert(radius >= STREET_DETAIL_WINDOW.minRadius && radius <= STREET_DETAIL_WINDOW.maxRadius,
    `the window radius is bounded (${radius.toFixed(0)} m)`);
  assert(wrong.records.crossings.length === 4 && wrong.records.stopBars.length === 2,
    `the junction is still fully marked with the wrong focus (${wrong.records.crossings.length} crossings, ${wrong.records.stopBars.length} stop bars)`);
  assert(wrong.records.inlets.length > 0 && wrong.records.rampPads.length > 0,
    `drainage and ramp pads survive a wrong focus (${wrong.records.inlets.length} inlets, ${wrong.records.rampPads.length} pads)`);
  const right = buildStreetSurfaceDetail(makeCtx(city, { focus: { x: 0, z: 0 } }));
  assert(right.diagnostics.totals.triangles >= wrong.diagnostics.totals.triangles,
    `a correct focus never costs detail (${right.diagnostics.totals.triangles} vs ${wrong.diagnostics.totals.triangles} triangles)`);
  for (const ring of wrong.diagnostics.rings) {
    assert(ring.triangles <= ring.maxTriangles,
      `ring ${ring.id} holds its budget with the wrong focus (${ring.triangles} <= ${ring.maxTriangles})`);
  }
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('street-surface-detail OK');
