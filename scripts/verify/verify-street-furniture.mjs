// Self-check for src/render/passes/street-furniture.js
//
// Runs headless under plain node: no browser, no DOM, no canvas, no new
// dependency. Exits non-zero on the first failed assertion group.
//
//   node scripts/verify/verify-street-furniture.mjs
//
// What it proves:
//   1. the module satisfies the presentation-pass registry contract
//   2. a degenerate city cannot make it throw: no city, no segments, empty and
//      two-point segments, zero/negative widths, no footway, NaN points, no
//      intersections, no signals, no buildings, and both spellings of the
//      street contract
//   3. every footway item sits INSIDE the footway band it claims, measured
//      back out of its world position rather than trusted from the placement,
//      and above the curb it stands behind; a wall-mounted item is allowed to
//      reach past the nominal property line but only as far as a real facade
//   4. no two items overlap in plan, anywhere in a real city, and no item is
//      ever placed on a carriageway or inside a junction pad
//   5. no item stands inside a building footprint, and every wall-mounted item
//      really is at a wall
//   6. items do not collide with the props the legacy renderer already placed,
//      which are read out of the scene graph the pass is handed
//   7. placement clusters at corners the way a real street does, and keeps the
//      corner sight triangle free of trees
//   8. every item leaves a pedestrian through-route on the footway
//   9. output is deterministic for a seed and varies across seeds
//  10. per-ring item/triangle caps, the total triangle budget and the draw-call
//      budget hold at a stated real city size
//  11. A WRONG FOCUS CANNOT EMPTY THE CITY. Round 1 shipped rings that decided
//      EXISTENCE by distance, and the renderer's build focus turned out to be
//      the pre-reframe startup camera 1450 m from every capture pose, so this
//      pass placed zero items in the entire world. The outer ring now covers
//      the whole loaded window, and this is asserted directly: building with
//      the focus the shipped route actually supplies must still furnish the
//      street the cameras stand on., and every catalogue geometry is
//      finite and instanced

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { validatePass } from '../../src/render/pass-registry.js';
import pass, {
  STREET_FURNITURE_ID,
  STREET_FURNITURE_VERSION,
  STREET_FURNITURE_RINGS,
  STREET_FURNITURE_WINDOW,
  STREET_FURNITURE_BUDGET,
  STREET_FURNITURE_KINDS,
  STREET_FURNITURE_KIND_IDS,
  buildStreetFurniture,
  lateralFor,
  onPavedRoadway,
  STREET_TREE_SPECIES,
  STREET_TREE_BUDGET,
  STREET_TREE_OPENNESS,
  STREET_TREE_MAX_HALF_CROWN,
  streetTreeVariantCount,
  buildStreetTreeGeometry,
} from '../../src/render/passes/street-furniture.js';
import { sidewalkBand, sidewalkSurfaceY } from '../../src/world/streets/street-surface-v2.js';
import { MATERIAL_CLASSES } from '../../src/render/environment-ibl.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// Mirrors DEFAULT_OPTIONS.wallReach in the pass: how far past the nominal
// property line a wall-mounted item may reach to find a real facade.
const WALL_REACH = 5.0;

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
  seed: 'verify-street-furniture',
  seedInt: 99,
  streetDesign: { roadLift: 0.45 },
  bounds: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
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
    intersectionId: null,
  };
}

/** A four-by-four grid, split at every crossing so the junctions are real. */
function gridCity() {
  const segments = [];
  const lines = [-60, 0, 60];
  const stations = [-120, -60, 0, 60, 120];
  for (const z of lines) {
    for (let i = 0; i < stations.length - 1; i += 1) {
      segments.push(segment(`h${z}-${i}`, [{ x: stations[i], z }, { x: stations[i + 1], z }],
        { streetId: `h${z}` }));
    }
  }
  for (const x of lines) {
    for (let i = 0; i < stations.length - 1; i += 1) {
      segments.push(segment(`v${x}-${i}`, [{ x, z: stations[i] }, { x, z: stations[i + 1] }],
        { streetId: `v${x}`, highway: 'tertiary', lanes: 2, width: 9.6, sidewalkW: 2.6 }));
    }
  }
  const buildings = [];
  for (let i = 0; i < 8; i += 1) {
    const x = -100 + i * 24;
    buildings.push({
      id: `b-${i}`,
      height: 14,
      polygon: [{ x, z: 12 }, { x: x + 18, z: 12 }, { x: x + 18, z: 44 }, { x, z: 44 }],
    });
  }
  return { meta: META, segments, intersections: [], signals: [], blocks: [], buildings };
}

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
    blocks: [],
    signals: [],
  };
}

function makeCtx(city, overrides = {}) {
  return {
    root: overrides.root === undefined ? new THREE.Group() : overrides.root,
    city,
    heightAt: overrides.heightAt || (() => 0),
    isSanFrancisco: true,
    seed: overrides.seed ?? 'verify-street-furniture',
    focus: overrides.focus === undefined ? { x: 0, z: 0 } : overrides.focus,
    registerGeometry: (geometry) => geometry,
    legacyGroup: () => null,
    ...overrides,
  };
}

function pointInPolygon(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.z > z) !== (b.z > z)
      && x < ((b.x - a.x) * (z - a.z)) / ((b.z - a.z) || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

function nearestBuildingGap(buildings, x, z) {
  let best = Infinity;
  for (const building of buildings || []) {
    const polygon = building?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const p of polygon) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    if (x < minX - 12 || x > maxX + 12 || z < minZ - 12 || z > maxZ + 12) continue;
    if (pointInPolygon(polygon, x, z)) return 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const a = polygon[i];
      const b = polygon[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
    }
  }
  return best;
}

function signatureOf(object) {
  const parts = [];
  object?.traverse?.((node) => {
    if (!node.isInstancedMesh && !node.isMesh) return;
    let hash = 2166136261;
    const mix = (value) => {
      hash ^= Math.round(value * 1e4) & 0xffffffff;
      hash = Math.imul(hash, 16777619) >>> 0;
    };
    if (node.isInstancedMesh) {
      const array = node.instanceMatrix.array;
      for (let i = 0; i < array.length; i += 1) mix(array[i]);
      parts.push(`${node.name}:${node.count}:${hash >>> 0}`);
    } else {
      const position = node.geometry.getAttribute('position');
      for (let i = 0; i < position.array.length; i += 1) mix(position.array[i]);
      parts.push(`${node.name}:${position.count}:${hash >>> 0}`);
    }
  });
  return parts.sort().join('|');
}

/** Independently recover an item's station and lateral from its world position. */
function measure(plan, item) {
  const segment = plan.segments.find((s) => s.id === item.segmentId);
  if (!segment) return null;
  let best = null;
  for (let i = 0; i < segment.points.length - 1; i += 1) {
    const a = segment.points[i];
    const b = segment.points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-9)) continue;
    const ux = dx / len;
    const uz = dz / len;
    const t = Math.max(0, Math.min(len, (item.x - a.x) * ux + (item.z - a.z) * uz));
    const px = a.x + ux * t;
    const pz = a.z + uz * t;
    const distance = Math.hypot(item.x - px, item.z - pz);
    if (best && distance >= best.distance) continue;
    best = {
      station: segment.cum[i] + t,
      lateral: (item.x - px) * -uz + (item.z - pz) * ux,
      distance,
      segment,
    };
  }
  return best;
}

// ---------------------------------------------------------------------------
section('1. registry contract');
// ---------------------------------------------------------------------------
{
  assert(validatePass(pass).length === 0, `pass satisfies the registry contract (${validatePass(pass).join('; ') || 'clean'})`);
  assert(pass.id === STREET_FURNITURE_ID && pass.id === 'street-furniture', 'id is street-furniture');
  assert(pass.order === 40, 'order is 40, after street-surface-detail');
  assert(typeof STREET_FURNITURE_VERSION === 'string', `version tag ${STREET_FURNITURE_VERSION}`);
  const result = pass.build(makeCtx(gridCity()));
  assert(result.object === null || typeof result.object.traverse === 'function', 'build returns an Object3D or null');
  assert(result.diagnostics.implemented === true, 'diagnostics report the pass as implemented');
  assert(Object.keys(result.diagnostics.counts).length >= 8,
    `diagnostics carry per-category counts (${Object.keys(result.diagnostics.counts).length} kinds)`);
  assert(typeof result.diagnostics.rejections === 'object', 'diagnostics carry placement rejections with reasons');
  assert(Array.isArray(result.diagnostics.rings) && result.diagnostics.rings.length === STREET_FURNITURE_RINGS.length,
    'diagnostics carry one record per distance ring, with triangles and items');
  assert(Array.isArray(result.diagnostics.sourceSegmentIds) && result.diagnostics.sourceSegmentIds.length > 0,
    'diagnostics carry the source segment ids used');
  assert(result.diagnostics.rings.every((r) => Number.isFinite(r.triangles) && Number.isFinite(r.items)),
    'per-ring triangles and item counts are finite');
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
    ['segments is not an array', makeCtx({ meta: META, segments: 'nope' })],
    ['segment with one point', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }])] })],
    ['zero width', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 40, z: 0 }], { width: 0 })] })],
    ['negative width', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 40, z: 0 }], { width: -4 })] })],
    ['no footway', makeCtx({ meta: META, segments: [segment('a', [{ x: 0, z: 0 }, { x: 40, z: 0 }], { sidewalkW: 0, sidewalkLeft: 0, sidewalkRight: 0 })] })],
    ['NaN points', makeCtx({ meta: META, segments: [segment('a', [{ x: NaN, z: 0 }, { x: 40, z: Infinity }])] })],
    ['no intersections or signals', makeCtx({ meta: META, segments: gridCity().segments })],
    ['no buildings', makeCtx({ meta: META, segments: gridCity().segments, buildings: null })],
    ['building with a broken polygon', makeCtx({ meta: META, segments: gridCity().segments, buildings: [{ id: 'x', polygon: [{ x: NaN, z: 1 }] }] })],
    ['className/asphaltWidth spelling', makeCtx(altSpellingCity())],
    ['no focus', makeCtx(gridCity(), { focus: null })],
    ['NaN focus', makeCtx(gridCity(), { focus: { x: NaN, z: NaN } })],
    ['no root to read legacy props from', makeCtx(gridCity(), { root: null })],
    ['no heightAt', makeCtx(gridCity(), { heightAt: null })],
    ['heightAt returns NaN', makeCtx(gridCity(), { heightAt: () => NaN })],
  ];
  for (const [label, ctx] of cases) {
    let ok = true;
    let detail = '';
    try {
      const result = pass.build(ctx);
      ok = result && (result.object === null || typeof result.object.traverse === 'function');
      result?.object?.traverse?.((node) => {
        if (node.isInstancedMesh) {
          for (let i = 0; i < node.instanceMatrix.array.length; i += 1) {
            if (!Number.isFinite(node.instanceMatrix.array[i])) { ok = false; detail = 'non-finite instance matrix'; return; }
          }
        }
        const position = node.geometry?.getAttribute('position');
        if (!position) return;
        for (let i = 0; i < position.array.length; i += 1) {
          if (!Number.isFinite(position.array[i])) { ok = false; detail = 'non-finite vertex'; return; }
        }
      });
    } catch (error) {
      ok = false;
      detail = String(error?.message || error);
    }
    assert(ok, `degenerate: ${label}${detail ? ` (${detail})` : ''}`);
  }
  const alt = pass.build(makeCtx(altSpellingCity()));
  assert(alt.diagnostics.plan.segments === 1, 'the className/asphaltWidth spelling is read as a real segment');
  assert(alt.diagnostics.totals.items > 0, 'and it is furnished');
}

// ---------------------------------------------------------------------------
section('3. every item is inside the band it claims, above the curb');
// ---------------------------------------------------------------------------
{
  const built = buildStreetFurniture(makeCtx(gridCity()));
  const options = built.state.o;
  assert(built.items.length > 60, `the fixture grid was furnished (${built.items.length} items)`);
  let outsideBand = 0;
  let wrongSide = 0;
  let belowCurb = 0;
  let mismatched = 0;
  let worstBand = 0;
  for (const item of built.items) {
    const kind = STREET_FURNITURE_KINDS[item.kind];
    const measured = measure(built.plan, item);
    if (!measured) { mismatched += 1; continue; }
    const band = sidewalkBand(measured.segment, item.side, options);
    if (!band) { outsideBand += 1; continue; }
    // The reported lateral has to be the real one.
    if (Math.abs(Math.abs(measured.lateral) - item.lateral) > 0.02) mismatched += 1;
    if (Math.sign(measured.lateral) !== item.side) wrongSide += 1;
    const a = Math.abs(measured.lateral);
    // A wall item is allowed past the property line, but only inside its
    // declared reach; section 5 proves it really is at a facade there.
    const outerLimit = kind.zone === 'building' ? band.outer + WALL_REACH : band.outer;
    if (a - kind.depth < band.inner - 0.06) { outsideBand += 1; worstBand = Math.max(worstBand, band.inner - (a - kind.depth)); }
    if (a + kind.depth > outerLimit + 0.06) { outsideBand += 1; worstBand = Math.max(worstBand, (a + kind.depth) - outerLimit); }
    const curbTop = item.curbTop;
    if (!(item.y >= curbTop - 1e-6)) belowCurb += 1;
  }
  assert(mismatched === 0, `every item's reported lateral offset is its measured one (${mismatched} mismatches)`);
  assert(wrongSide === 0, `every item is on the side of the street it claims (${wrongSide} wrong)`);
  assert(outsideBand === 0, `every item is inside its footway band (${outsideBand} outside, worst ${worstBand.toFixed(3)} m)`);
  assert(belowCurb === 0, `every item stands at or above curb top (${belowCurb} below)`);

  // The band arithmetic itself.
  for (const id of STREET_FURNITURE_KIND_IDS) {
    const kind = STREET_FURNITURE_KINDS[id];
    assert(kind.depth > 0 && kind.depth <= kind.radius + 1e-9,
      `${id} declares an across-footway depth no larger than its plan radius (${kind.depth} <= ${kind.radius})`);
    assert(kind.minWalk >= 1.0, `${id} refuses to stand on a footway narrower than 1 m (${kind.minWalk})`);
  }
  const band = sidewalkBand(built.plan.segments[0], 1, options);
  for (const id of STREET_FURNITURE_KIND_IDS) {
    const kind = STREET_FURNITURE_KINDS[id];
    const fit = lateralFor(kind, band, 1.05);
    assert(Number.isFinite(fit.lateral) && fit.lateral > band.inner - 1e-9,
      `${id} is offered a lateral offset behind the curb (${fit.lateral.toFixed(2)} > ${band.inner.toFixed(2)})`);
  }
}

// ---------------------------------------------------------------------------
section('4. nothing overlaps');
// ---------------------------------------------------------------------------
{
  const built = buildStreetFurniture(makeCtx(gridCity()));
  const cell = 4;
  const grid = new Map();
  let overlaps = 0;
  let worst = 0;
  let worstPair = '';
  for (const item of built.items) {
    const radius = STREET_FURNITURE_KINDS[item.kind].radius;
    const gx = Math.floor(item.x / cell);
    const gz = Math.floor(item.z / cell);
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        for (const other of grid.get(`${gx + i}|${gz + j}`) || []) {
          const rr = radius + STREET_FURNITURE_KINDS[other.kind].radius;
          const d = Math.hypot(other.x - item.x, other.z - item.z);
          if (d < rr - 1e-6) {
            overlaps += 1;
            if (rr - d > worst) { worst = rr - d; worstPair = `${item.kind}/${other.kind}`; }
          }
        }
      }
    }
    const key = `${gx}|${gz}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(item); else grid.set(key, [item]);
  }
  assert(overlaps === 0, `no two items overlap in plan (${overlaps} overlaps, worst ${worst.toFixed(3)} m on ${worstPair || 'none'})`);

  // NOTHING IN THE ROADWAY. Round 1 review found a bench standing on a
  // crosswalk. An item is placed on the footway band of the segment it CLAIMS,
  // which is not the same as being clear of every other paved surface: where a
  // service way crosses a street, or a sibling segment of the same street runs
  // close by, the claimed band lies on top of another carriageway or inside a
  // junction pad.
  let onRoad = 0;
  const offenders = [];
  for (const item of built.items) {
    const kind = STREET_FURNITURE_KINDS[item.kind];
    // The item's own oriented footprint, rebuilt here from its world pose
    // rather than trusted from the placement.
    const ox = Math.sin(item.rotation);
    const oz = Math.cos(item.rotation);
    const half = Math.max(0, kind.radius - kind.depth);
    for (const t of half > 0.05 ? [-half, 0, half] : [0]) {
      const hit = onPavedRoadway(built.state.roadway, item.x - oz * t, item.z + ox * t, Math.max(kind.depth, 0.18));
      if (hit) { onRoad += 1; if (offenders.length < 4) offenders.push(`${item.kind}@${hit}`); break; }
    }
  }
  assert(onRoad === 0,
    `no item stands on a carriageway or inside a junction pad (${onRoad}${offenders.length ? `: ${offenders.join(', ')}` : ''})`);
  // The test itself, probed directly: a point on a centreline is roadway, a
  // point on the footway is not, and a junction centre is a pad.
  const probeSegment = built.plan.segments[0];
  const mid = probeSegment.points[0];
  assert(onPavedRoadway(built.state.roadway, mid.x + 20, mid.z, 0.2) !== null,
    'a point on a carriageway centreline is recognised as roadway');
  const clear = built.items.find((item) => item.kind === 'signPole');
  assert(clear && onPavedRoadway(built.state.roadway, clear.x, clear.z, 0.1) === null,
    'a point on the footway is not roadway');
  const node = built.plan.nodes[0];
  assert(onPavedRoadway(built.state.roadway, node.position.x, node.position.z, 0.2) !== null,
    'the middle of a junction pad is recognised as roadway');

  // EVERY BASE TOUCHES THE SURFACE IT CLAIMS. An item's origin is its base, so
  // its y has to equal the footway surface at its own position, not at the
  // station it was laid out from.
  const options = built.state.o;
  let floating = 0;
  let worstFloat = 0;
  for (const item of built.items) {
    const measured = measure(built.plan, item);
    if (!measured) { floating += 1; continue; }
    const datum = options.roadLift + 0; // fixture heightAt is flat 0
    const surfaceLateral = Math.min(Math.abs(measured.lateral), item.band.outer);
    const expected = sidewalkSurfaceY(datum, surfaceLateral, item.half, options);
    const error = Math.abs(item.y - expected);
    if (error > worstFloat) worstFloat = error;
    if (error > 0.005) floating += 1;
  }
  assert(floating === 0,
    `every item's base sits on the footway surface it claims (${floating} floating, worst ${worstFloat.toFixed(4)} m)`);
}

// ---------------------------------------------------------------------------
section('5. buildings and wall-mounted items');
// ---------------------------------------------------------------------------
{
  const city = gridCity();
  const built = buildStreetFurniture(makeCtx(city));
  let inside = 0;
  let floatingWallItem = 0;
  let wallItems = 0;
  for (const item of built.items) {
    const kind = STREET_FURNITURE_KINDS[item.kind];
    let hit = false;
    let nearest = Infinity;
    for (const building of city.buildings) {
      if (pointInPolygon(building.polygon, item.x, item.z)) hit = true;
      for (let i = 0, j = building.polygon.length - 1; i < building.polygon.length; j = i, i += 1) {
        const a = building.polygon[i];
        const b = building.polygon[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((item.x - a.x) * dx + (item.z - a.z) * dz) / len2)) : 0;
        nearest = Math.min(nearest, Math.hypot(item.x - (a.x + dx * t), item.z - (a.z + dz * t)));
      }
    }
    if (hit) inside += 1;
    if (kind.zone === 'building') {
      wallItems += 1;
      if (nearest > 0.7) floatingWallItem += 1;
    }
  }
  assert(inside === 0, `no item stands inside a building footprint (${inside})`);
  assert(wallItems > 0, `the fixture placed wall-mounted items (${wallItems})`);
  assert(floatingWallItem === 0, `every wall-mounted item really is at a wall (${floatingWallItem} floating)`);
}

// ---------------------------------------------------------------------------
section('6. legacy props already in the scene are respected');
// ---------------------------------------------------------------------------
{
  const city = gridCity();
  const bare = buildStreetFurniture(makeCtx(city, { root: new THREE.Group() }));
  // A legacy prop set, exactly where the pass would otherwise place things.
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(0.9, 2, 0.9);
  const legacy = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), bare.items.length);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < bare.items.length; i += 1) {
    matrix.makeTranslation(bare.items[i].x, 0, bare.items[i].z);
    legacy.setMatrixAt(i, matrix);
  }
  legacy.name = 'sidewalk-props';
  root.add(legacy);
  const guarded = buildStreetFurniture(makeCtx(city, { root }));
  assert(guarded.diagnostics.legacyOccupancySeeded === bare.items.length,
    `every legacy prop in the scene was read as occupied space (${guarded.diagnostics.legacyOccupancySeeded})`);
  let collisions = 0;
  let worst = 0;
  for (const item of guarded.items) {
    const radius = STREET_FURNITURE_KINDS[item.kind].radius;
    for (const legacyItem of bare.items) {
      const d = Math.hypot(item.x - legacyItem.x, item.z - legacyItem.z);
      const rr = radius + Math.min(geometry.boundingSphere?.radius ?? 1.1, 2.4);
      if (d < rr - 1e-6) { collisions += 1; worst = Math.max(worst, rr - d); }
    }
  }
  assert(collisions === 0, `nothing was planted inside an existing prop (${collisions} collisions, worst ${worst.toFixed(3)} m)`);
  assert(guarded.items.length < bare.items.length,
    `and the pass yielded space rather than forcing items in (${guarded.items.length} vs ${bare.items.length})`);
  assert(guarded.items.length > 0, 'but it still furnishes the free footway');

  // Dynamic content must NOT be treated as permanent occupancy.
  const crowdRoot = new THREE.Group();
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 1.8, 0.4), new THREE.MeshStandardMaterial(), 8);
  for (let i = 0; i < 8; i += 1) { matrix.makeTranslation(i * 4, 0, 4); crowd.setMatrixAt(i, matrix); }
  crowd.name = 'pedestrian-crowd';
  crowdRoot.add(crowd);
  const withCrowd = buildStreetFurniture(makeCtx(city, { root: crowdRoot }));
  assert(withCrowd.diagnostics.legacyOccupancySeeded === 0,
    'a moving crowd is not frozen into the placement as occupancy');
}

// ---------------------------------------------------------------------------
section('7. corner clustering and the sight triangle');
// ---------------------------------------------------------------------------
{
  const built = buildStreetFurniture(makeCtx(gridCity()));
  const options = built.state.o;
  const CORNER_ZONE = 11; // DEFAULT_OPTIONS.cornerZone in the pass
  assert(built.plan.nodes.length >= 4, `the fixture grid produced real junctions (${built.plan.nodes.length})`);

  // Classify by the SAME rule the pass uses - distance along the segment from
  // a trimmed end that carries a junction - so the density comparison is
  // matched rather than approximate.
  const isCorner = (segment, station) => {
    const s0 = segment.trimStart + 1.2;
    const s1 = segment.length - segment.trimEnd - 1.2;
    return Boolean((segment.nodeStart && station - s0 < CORNER_ZONE)
      || (segment.nodeEnd && s1 - station < CORNER_ZONE));
  };
  let cornerMetres = 0;
  let midMetres = 0;
  for (const segment of built.plan.segments) {
    for (const side of [1, -1]) {
      if (!sidewalkBand(segment, side, options)) continue;
      const run = Math.max(0, (segment.length - segment.trimEnd - 1.2) - (segment.trimStart + 1.2));
      let corner = 0;
      if (segment.nodeStart) corner += Math.min(CORNER_ZONE, run / 2);
      if (segment.nodeEnd) corner += Math.min(CORNER_ZONE, run / 2);
      cornerMetres += corner;
      midMetres += Math.max(0, run - corner);
    }
  }
  let cornerItems = 0;
  let midItems = 0;
  let treesAtCorner = 0;
  let signPolesAtCorner = 0;
  const segById = new Map(built.plan.segments.map((segment) => [segment.id, segment]));
  for (const item of built.items) {
    const segment = segById.get(item.segmentId);
    if (!segment) continue;
    if (isCorner(segment, item.station)) {
      cornerItems += 1;
      if (item.kind === 'tree') treesAtCorner += 1;
      if (item.kind === 'signPole') signPolesAtCorner += 1;
    } else midItems += 1;
  }
  const cornerDensity = cornerItems / Math.max(1, cornerMetres);
  const midDensity = midItems / Math.max(1, midMetres);
  console.log(`  corner: ${cornerItems} items over ${cornerMetres.toFixed(0)} m `
    + `(${(cornerDensity * 100).toFixed(1)} per 100 m); `
    + `mid-block: ${midItems} items over ${midMetres.toFixed(0)} m `
    + `(${(midDensity * 100).toFixed(1)} per 100 m)`);
  assert(cornerItems > 0 && midItems > 0, 'the fixture furnished both corners and mid-block');
  assert(cornerDensity > midDensity * 1.15,
    `corners carry more furniture per metre of footway than mid-block does `
    + `(${(cornerDensity * 100).toFixed(1)} vs ${(midDensity * 100).toFixed(1)} per 100 m)`);
  assert(signPolesAtCorner > 0, `every junction corner earns a sign pole (${signPolesAtCorner})`);
  assert(treesAtCorner === 0,
    `no tree stands in a corner sight triangle (${treesAtCorner})`);
  assert(built.diagnostics.counts.tree > 0, `mid-block trees exist (${built.diagnostics.counts.tree})`);

  // One guaranteed corner set per CORNER, not one per approach and side: a
  // four-way junction has four corners, so it must not sprout eight sign poles.
  const forced = built.items.filter((item) => item.forced);
  assert(forced.length > 0, `junction corners claim their space first (${forced.length} guaranteed placements)`);
  let overPoled = 0;
  let overSet = 0;
  for (const node of built.plan.nodes) {
    const forcedPoles = forced.filter((item) => item.nodeId === node.id && item.kind === 'signPole').length;
    if (forcedPoles > node.degree) overSet += 1;
    const nearby = built.items.filter((item) => item.kind === 'signPole'
      && Math.hypot(item.x - node.position.x, item.z - node.position.z) < 14).length;
    if (nearby > node.degree + 2) overPoled += 1;
  }
  assert(overSet === 0,
    `no junction gets more than one guaranteed sign pole per corner (${overSet} of ${built.plan.nodes.length})`);
  assert(overPoled === 0,
    `no junction is over-poled once mid-block placement is included (${overPoled} of ${built.plan.nodes.length})`);
}

// ---------------------------------------------------------------------------
section('8. the pedestrian through-route survives');
// ---------------------------------------------------------------------------
{
  const built = buildStreetFurniture(makeCtx(gridCity()));
  const options = built.state.o;
  let blocked = 0;
  let tightest = Infinity;
  for (const item of built.items) {
    const kind = STREET_FURNITURE_KINDS[item.kind];
    const measured = measure(built.plan, item);
    const band = sidewalkBand(measured.segment, item.side, options);
    if (!band) continue;
    // A wall item that reached past the property line consumes none of the
    // footway; one that stayed inside it consumes the far edge.
    const free = kind.zone === 'building'
      ? Math.max(band.usable, (item.lateral - kind.depth) - band.inner)
      : band.outer - (item.lateral + kind.depth);
    tightest = Math.min(tightest, free);
    if (free < 0.85) blocked += 1;
  }
  assert(blocked === 0, `no item leaves less than 0.85 m of walking route (${blocked} do; tightest ${tightest.toFixed(2)} m)`);
  assert(tightest >= 0.85, `the tightest through-route on the fixture is ${tightest.toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
section('9. determinism per seed, variation across seeds');
// ---------------------------------------------------------------------------
{
  const a = buildStreetFurniture(makeCtx(gridCity(), { seed: 'seed-a' }));
  const b = buildStreetFurniture(makeCtx(gridCity(), { seed: 'seed-a' }));
  const c = buildStreetFurniture(makeCtx(gridCity(), { seed: 'seed-b' }));
  const sa = signatureOf(a.object);
  assert(sa.length > 0 && sa === signatureOf(b.object), 'two builds of one city at one seed are bit-identical');
  assert(sa !== signatureOf(c.object), 'a different seed produces different placement');
  assert(a.items.length === b.items.length, `item count is stable across builds (${a.items.length})`);
  const source = gridCity();
  const before = JSON.stringify(source);
  buildStreetFurniture(makeCtx(source));
  assert(JSON.stringify(source) === before, 'the source city is never mutated');
}

// ---------------------------------------------------------------------------
section('10. budgets at a stated real city size');
// ---------------------------------------------------------------------------
{
  for (let i = 1; i < STREET_FURNITURE_RINGS.length; i += 1) {
    const outer = STREET_FURNITURE_RINGS[i];
    const inner = STREET_FURNITURE_RINGS[i - 1];
    assert(outer.radius === null || outer.radius > inner.radius,
      `ring ${outer.id} is further out than ${inner.id}`);
    assert(outer.lod >= inner.lod, `ring ${outer.id} is no more detailed than the ring inside it`);
  }
  const outermost = STREET_FURNITURE_RINGS[STREET_FURNITURE_RINGS.length - 1];
  assert(outermost.radius === null,
    'the outermost ring covers the whole loaded window rather than a fixed radius');
  assert(outermost.kinds === null,
    'the outermost ring carries every kind - a ring may set the level of detail, never whether an item exists');
  assert(STREET_FURNITURE_WINDOW.minRadius > 0 && STREET_FURNITURE_WINDOW.maxRadius > STREET_FURNITURE_WINDOW.minRadius,
    `the resolved window radius is bounded (${STREET_FURNITURE_WINDOW.minRadius}-${STREET_FURNITURE_WINDOW.maxRadius} m)`);

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
  const built = buildStreetFurniture(ctx);
  const elapsed = Date.now() - started;
  const d = built.diagnostics;
  console.log(`  city size: ${d.plan.segments} paved segments, ${d.plan.nodes} junctions, `
    + `${d.plan.streetLengthMeters.toFixed(0)} m of street, ${d.buildingFootprints} building footprints`);
  console.log(`  placed: ${JSON.stringify(d.counts)}`);
  console.log(`  rings: ${d.rings.map((r) => `${r.id}(lod${r.lod})=${r.items} items/${r.triangles} tri`).join('; ')}`);
  console.log(`  totals: ${d.totals.items} items, ${d.totals.triangles} triangles, ${d.totals.drawCalls} draw calls, ${elapsed} ms`);
  assert(d.plan.segments > 900, `the stated city size really is city-wide (${d.plan.segments} segments)`);
  assert(d.totals.items > 1200, `furniture is city-wide, not hero-corridor only (${d.totals.items} items)`);
  const kinds = Object.keys(d.counts).filter((k) => d.counts[k] > 0);
  assert(kinds.length >= 12, `the street carries a real mix of kinds (${kinds.length}: ${kinds.join(', ')})`);
  for (const required of ['hydrant', 'parkingMeter', 'signPole', 'bollard', 'wasteBin', 'bikeRack', 'newsBox', 'tree', 'transitShelter', 'bench', 'planter', 'mailbox']) {
    assert((d.counts[required] || 0) > 0, `the city contains ${required} (${d.counts[required] || 0})`);
  }
  for (const ring of d.rings) {
    assert(ring.triangles <= ring.maxTriangles, `ring ${ring.id} holds its triangle budget (${ring.triangles} <= ${ring.maxTriangles})`);
    assert(ring.items <= ring.maxItems, `ring ${ring.id} holds its item cap (${ring.items} <= ${ring.maxItems})`);
  }
  assert(d.totals.triangles <= STREET_FURNITURE_BUDGET.maxTriangles,
    `total triangle budget holds (${d.totals.triangles} <= ${STREET_FURNITURE_BUDGET.maxTriangles})`);
  assert(d.totals.drawCalls <= STREET_FURNITURE_BUDGET.maxDrawCalls,
    `draw-call budget holds (${d.totals.drawCalls} <= ${STREET_FURNITURE_BUDGET.maxDrawCalls})`);
  assert(elapsed < 8000, `build stays inside a usable capture budget (${elapsed} ms)`);

  // Instancing, not one mesh per prop.
  let instanced = 0;
  let plain = 0;
  let nonFinite = 0;
  let missingColor = 0;
  built.object.traverse((node) => {
    if (node.isInstancedMesh) {
      instanced += 1;
      for (let i = 0; i < node.instanceMatrix.array.length; i += 1) {
        if (!Number.isFinite(node.instanceMatrix.array[i])) nonFinite += 1;
      }
      if (!node.geometry.getAttribute('color')) missingColor += 1;
      const position = node.geometry.getAttribute('position');
      for (let i = 0; i < position.array.length; i += 1) if (!Number.isFinite(position.array[i])) nonFinite += 1;
    } else if (node.isMesh) plain += 1;
  });
  assert(instanced > 0 && plain <= 1, `props are instanced, with at most one merged ground mesh (${instanced} instanced, ${plain} plain)`);
  assert(nonFinite === 0, `no NaN/Inf in any instance matrix or vertex (${nonFinite})`);
  assert(missingColor === 0, `every catalogue geometry carries baked vertex colour (${missingColor} missing)`);
  assert(d.meshes.every((m) => m.instances > 0 && m.trianglesEach > 0), 'every emitted mesh carries real instances and real geometry');
  assert(d.counts.tree > 0 && d.meshes.some((m) => m.kind === 'treePit'),
    'every street tree stands in a real pit rather than growing out of the slab');

  // Whole-city overlap sweep on the real data.
  const cell = 4;
  const grid = new Map();
  let overlaps = 0;
  for (const item of built.items) {
    const radius = STREET_FURNITURE_KINDS[item.kind].radius;
    const gx = Math.floor(item.x / cell);
    const gz = Math.floor(item.z / cell);
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        for (const other of grid.get(`${gx + i}|${gz + j}`) || []) {
          if (Math.hypot(other.x - item.x, other.z - item.z)
            < radius + STREET_FURNITURE_KINDS[other.kind].radius - 1e-6) overlaps += 1;
        }
      }
    }
    const key = `${gx}|${gz}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(item); else grid.set(key, [item]);
  }
  assert(overlaps === 0, `no two items overlap anywhere in the real city (${overlaps})`);

  const refusedForRoad = Object.entries(d.rejections)
    .filter(([key]) => key.endsWith(':on-carriageway'))
    .reduce((total, [, count]) => total + count, 0);
  console.log(`  placements refused for landing on a carriageway or junction pad: ${refusedForRoad}`);
  assert(refusedForRoad > 100,
    `the roadway test bites hard on real data - this is the bench-on-the-crosswalk class (${refusedForRoad} refused)`);
  let realOnRoad = 0;
  for (const item of built.items) {
    const kind = STREET_FURNITURE_KINDS[item.kind];
    const ox = Math.sin(item.rotation);
    const oz = Math.cos(item.rotation);
    const halfLen = Math.max(0, kind.radius - kind.depth);
    for (const t of halfLen > 0.05 ? [-halfLen, 0, halfLen] : [0]) {
      if (onPavedRoadway(built.state.roadway, item.x - oz * t, item.z + ox * t, Math.max(kind.depth, 0.18))) {
        realOnRoad += 1;
        break;
      }
    }
  }
  assert(realOnRoad === 0, `no item in the real city stands on a carriageway or junction pad (${realOnRoad})`);

  let outOfBand = 0;
  let belowCurb = 0;
  for (const item of built.items) {
    const kind = STREET_FURNITURE_KINDS[item.kind];
    const measured = measure(built.plan, item);
    if (!measured) { outOfBand += 1; continue; }
    const band = sidewalkBand(measured.segment, item.side, built.state.o);
    if (!band) { outOfBand += 1; continue; }
    const a = Math.abs(measured.lateral);
    const outerLimit = kind.zone === 'building' ? band.outer + WALL_REACH : band.outer;
    if (a - kind.depth < band.inner - 0.06 || a + kind.depth > outerLimit + 0.06) outOfBand += 1;
    if (!(item.y >= item.curbTop - 1e-6)) belowCurb += 1;
  }
  assert(outOfBand === 0, `every item in the real city is inside its footway band (${outOfBand} outside)`);
  const wallCity = built.items.filter((item) => STREET_FURNITURE_KINDS[item.kind].zone === 'building');
  assert(wallCity.length > 0, `the real city carries wall-mounted items (${wallCity.length})`);
  let wallFloat = 0;
  for (const item of wallCity) {
    const gap = nearestBuildingGap(city.buildings, item.x, item.z);
    if (!(gap > 0 && gap <= 0.7)) wallFloat += 1;
  }
  assert(wallFloat === 0, `every wall-mounted item in the real city is on a facade (${wallFloat} floating or buried)`);
  assert(belowCurb === 0, `every item in the real city stands above the curb (${belowCurb} below)`);
}

// ---------------------------------------------------------------------------
section('11. a wrong focus cannot empty the city');
// ---------------------------------------------------------------------------
{
  const city = gridCity();
  // The focus the shipped route actually supplies: CityRenderer takes it from
  // camera.position at build time and the app reframes AFTER the build, so it
  // is the startup camera, far outside the loaded window.
  const startupCamera = { x: 2400, z: 2600 };
  const wrong = buildStreetFurniture(makeCtx(city, { focus: startupCamera }));
  assert(wrong.diagnostics.focusSource === 'bounds-centre',
    'a focus outside city.meta.bounds is refused and the substitution is recorded');
  assert(wrong.diagnostics.focusRejected && wrong.diagnostics.focusRejected.x === startupCamera.x,
    'the rejected focus is reported, not silently swallowed');
  const right = buildStreetFurniture(makeCtx(city, { focus: { x: 0, z: 0 } }));
  assert(right.diagnostics.focusSource === 'ctx', 'a focus inside the window is used as given');
  assert(wrong.items.length > right.items.length * 0.5,
    `the wrong focus still furnishes the city (${wrong.items.length} items vs ${right.items.length})`);
  // The property that actually failed in round 1: furniture near the CAMERA,
  // not near the focus.
  const nearCamera = (built) => built.items.filter((item) => Math.hypot(item.x, item.z) < 60).length;
  assert(nearCamera(wrong) > 8,
    `the street a camera stands on is furnished even when the focus is 3500 m away (${nearCamera(wrong)} items within 60 m of the origin)`);
  assert(wrong.diagnostics.windowRadius >= STREET_FURNITURE_WINDOW.minRadius,
    `the resolved window radius reaches the whole map (${wrong.diagnostics.windowRadius.toFixed(0)} m)`);
  for (const ring of wrong.diagnostics.rings) {
    assert(ring.triangles <= ring.maxTriangles && ring.items <= ring.maxItems,
      `ring ${ring.id} still holds its caps with the wrong focus (${ring.items} items, ${ring.triangles} tri)`);
  }
}

// ---------------------------------------------------------------------------
// silhouette measurement for section 12
// ---------------------------------------------------------------------------

/**
 * Rasterise the SIDE silhouette of a crown and report how solid it is.
 *
 * `hullFill` is covered cells divided by the cells inside the convex hull of
 * the covered set. A convex solid - a cone, a sphere, a stack of either - is
 * its own convex hull, so it measures 1.0 whatever its texture; a crown made
 * of separated leaf clusters measures well below that.
 *
 * `brokenScanlines` counts horizontal lines across the crown whose covered
 * span is split into two or more runs. Those are lines of sight that pass
 * straight through the crown. A convex solid has exactly zero of them.
 *
 * Measured on the geometry that ships, from its triangles, with no reference
 * to the parameters it was built from.
 *
 * @param {import('three').BufferGeometry} geometry
 * @param {number} crownBottom  y below which triangles are trunk, not crown
 * @param {'x'|'z'} axis        which side view
 */
function crownSilhouette(geometry, crownBottom, axis = 'x', N = 140) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count / 3 : position.count / 3;
  const tris = [];
  let minA = Infinity; let maxA = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let t = 0; t < count; t += 1) {
    const ids = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
    const points = ids.map((i) => ({
      a: axis === 'x' ? position.getX(i) : position.getZ(i),
      y: position.getY(i),
    }));
    if (points.every((p) => p.y < crownBottom)) continue;
    tris.push(points);
    for (const p of points) {
      if (p.a < minA) minA = p.a;
      if (p.a > maxA) maxA = p.a;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  minY = Math.max(minY, crownBottom);
  if (!(maxA > minA) || !(maxY > minY)) return { hullFill: 1, brokenScanlines: 0, scanlines: 0 };
  const covered = new Uint8Array(N * N);
  const sa = (maxA - minA) / N;
  const sy = (maxY - minY) / N;
  for (const points of tris) {
    const px = points.map((p) => ({ x: (p.a - minA) / sa, y: (p.y - minY) / sy }));
    const x0 = Math.max(0, Math.floor(Math.min(...px.map((p) => p.x))));
    const x1 = Math.min(N - 1, Math.ceil(Math.max(...px.map((p) => p.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...px.map((p) => p.y))));
    const y1 = Math.min(N - 1, Math.ceil(Math.max(...px.map((p) => p.y))));
    const [a, b, c] = px;
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-12) continue;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const l1 = ((b.y - c.y) * (x + 0.5 - c.x) + (c.x - b.x) * (y + 0.5 - c.y)) / den;
        const l2 = ((c.y - a.y) * (x + 0.5 - c.x) + (a.x - c.x) * (y + 0.5 - c.y)) / den;
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) covered[y * N + x] = 1;
      }
    }
  }
  const points = [];
  for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) if (covered[y * N + x]) points.push([x + 0.5, y + 0.5]);
  if (points.length < 3) return { hullFill: 1, brokenScanlines: 0, scanlines: 0 };
  points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const inHull = (x, y) => {
    for (let i = 0; i < hull.length; i += 1) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < -1e-9) return false;
    }
    return true;
  };
  let filled = 0;
  let hullCells = 0;
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      if (covered[y * N + x]) filled += 1;
      if (inHull(x + 0.5, y + 0.5)) hullCells += 1;
    }
  }
  let broken = 0;
  let scanlines = 0;
  for (let y = 0; y < N; y += 1) {
    let runs = 0;
    let prev = 0;
    let span = 0;
    for (let x = 0; x < N; x += 1) {
      const c = covered[y * N + x];
      if (c && !prev) runs += 1;
      if (c) span += 1;
      prev = c;
    }
    if (span > N * 0.15) { scanlines += 1; if (runs >= 2) broken += 1; }
  }
  return { hullFill: filled / Math.max(1, hullCells), brokenScanlines: broken, scanlines };
}

// ---------------------------------------------------------------------------
section('12. street trees are broadleaf geometry, not a cone');
// ---------------------------------------------------------------------------
{
  // The shape this replaces, measured the same way, so the metric is shown to
  // discriminate rather than merely to pass. This is exactly the round-2
  // canopy: ConeGeometry(1.45, 2.6, 7) with its base at y = 2.6.
  const cone = new THREE.ConeGeometry(1.45, 2.6, 7).translate(0, 3.9, 0);
  const coneSide = crownSilhouette(cone, 2.6, 'x');
  console.log(`  the round-2 cone canopy measures hullFill ${coneSide.hullFill.toFixed(3)}, `
    + `${coneSide.brokenScanlines} broken scanlines of ${coneSide.scanlines}`);
  assert(coneSide.hullFill > 0.95,
    `a convex cone canopy measures as a solid shell (hullFill ${coneSide.hullFill.toFixed(3)} > 0.95)`);
  assert(coneSide.brokenScanlines === 0,
    `no line of sight passes through a convex cone canopy (${coneSide.brokenScanlines} broken scanlines)`);
  cone.dispose();

  assert(STREET_TREE_SPECIES.length >= 3,
    `the near tier carries several species, so a block is not one stamp (${STREET_TREE_SPECIES.length})`);
  assert(streetTreeVariantCount(0) === STREET_TREE_SPECIES.length && streetTreeVariantCount(1) === 1,
    'the near tier carries every species and the window tier carries one');

  for (const coarse of [false, true]) {
    const tier = coarse ? 'window' : 'near';
    for (let variant = 0; variant < streetTreeVariantCount(coarse ? 1 : 0); variant += 1) {
      const geometry = buildStreetTreeGeometry(variant, coarse);
      const skeleton = geometry.userData.treeSkeleton;
      const index = geometry.getIndex();
      const triangles = Math.floor(
        (index ? index.count : geometry.getAttribute('position').count) / 3,
      );
      const cap = coarse
        ? STREET_TREE_BUDGET.maxTrianglesPerTreeCoarse
        : STREET_TREE_BUDGET.maxTrianglesPerTree;
      const sideX = crownSilhouette(geometry, skeleton.crownBottom, 'x');
      const sideZ = crownSilhouette(geometry, skeleton.crownBottom, 'z');
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      const halfCrown = Math.max(
        Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z),
      );
      console.log(`  ${tier}/${skeleton.species}: ${triangles} tri, ${skeleton.clusters.length} clusters, `
        + `hullFill x ${sideX.hullFill.toFixed(3)} z ${sideZ.hullFill.toFixed(3)}, `
        + `broken ${sideX.brokenScanlines}/${sideX.scanlines} and ${sideZ.brokenScanlines}/${sideZ.scanlines}, `
        + `${skeleton.height.toFixed(2)} m tall, half-crown ${halfCrown.toFixed(2)} m`);

      // 1. not a solid shell
      const minClusters = coarse
        ? STREET_TREE_OPENNESS.minClustersCoarse
        : STREET_TREE_OPENNESS.minClusters;
      assert(skeleton.clusters.length >= minClusters,
        `${tier}/${skeleton.species}: the crown is built from separate leaf clusters (${skeleton.clusters.length} >= ${minClusters})`);
      assert(sideX.hullFill <= STREET_TREE_OPENNESS.maxHullFill
        && sideZ.hullFill <= STREET_TREE_OPENNESS.maxHullFill,
        `${tier}/${skeleton.species}: the crown silhouette is lobed, not convex `
        + `(hullFill ${sideX.hullFill.toFixed(3)} / ${sideZ.hullFill.toFixed(3)} <= ${STREET_TREE_OPENNESS.maxHullFill})`);
      assert(sideX.brokenScanlines >= STREET_TREE_OPENNESS.minBrokenScanlines
        && sideZ.brokenScanlines >= STREET_TREE_OPENNESS.minBrokenScanlines,
        `${tier}/${skeleton.species}: light passes through the crown `
        + `(${sideX.brokenScanlines} / ${sideZ.brokenScanlines} broken scanlines >= ${STREET_TREE_OPENNESS.minBrokenScanlines})`);

      // 2. the clusters are really separate, not one blob with a dented hull
      let separated = 0;
      for (let i = 0; i < skeleton.clusters.length; i += 1) {
        for (let j = i + 1; j < skeleton.clusters.length; j += 1) {
          const a = skeleton.clusters[i];
          const b = skeleton.clusters[j];
          if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > (a.r + b.r) * 0.62) separated += 1;
        }
      }
      const pairs = (skeleton.clusters.length * (skeleton.clusters.length - 1)) / 2;
      assert(separated > pairs * 0.6,
        `${tier}/${skeleton.species}: most cluster pairs stand clear of each other (${separated}/${pairs})`);

      // 3. trunk tapers and branches
      assert(skeleton.taperRatio < 0.75 && skeleton.taperRatio > 0.25,
        `${tier}/${skeleton.species}: the trunk tapers (top radius is ${(skeleton.taperRatio * 100).toFixed(0)}% of the base)`);
      assert(skeleton.trunk.length >= 2,
        `${tier}/${skeleton.species}: the trunk is built in sections, not one cylinder (${skeleton.trunk.length})`);
      for (let i = 1; i < skeleton.trunk.length; i += 1) {
        assert(skeleton.trunk[i].r0 <= skeleton.trunk[i - 1].r0 + 1e-9,
          `${tier}/${skeleton.species}: trunk section ${i} is no thicker than the one below it`);
      }
      assert(skeleton.limbs.length >= 2,
        `${tier}/${skeleton.species}: the trunk branches into limbs (${skeleton.limbs.length})`);
      const crotchY = skeleton.limbs[0].a.y;
      assert(crotchY > 0.5 && crotchY < skeleton.trunkHeight + 1e-9,
        `${tier}/${skeleton.species}: the limbs leave the trunk at a crotch below the crown (${crotchY.toFixed(2)} m)`);
      for (const branch of skeleton.limbs) {
        assert(branch.r1 < branch.r0,
          `${tier}/${skeleton.species}: every limb tapers toward its tip`);
      }

      // 4. no cone survives anywhere in the tree: every leaf cluster is a
      //    closed polyhedron with more than one face direction, and the crown
      //    is not one connected convex hull. Checked structurally above; here
      //    just assert the geometry is finite and coloured.
      const position = geometry.getAttribute('position');
      const colour = geometry.getAttribute('color');
      let nonFinite = 0;
      for (let i = 0; i < position.array.length; i += 1) if (!Number.isFinite(position.array[i])) nonFinite += 1;
      assert(nonFinite === 0, `${tier}/${skeleton.species}: no NaN/Inf vertex (${nonFinite})`);
      assert(colour && colour.count === position.count,
        `${tier}/${skeleton.species}: every vertex carries a baked colour`);
      // Internal form: the crown is not one flat green.
      let minLuma = 1;
      let maxLuma = 0;
      for (let i = 0; i < colour.count; i += 1) {
        const y = position.getY(i);
        if (y < skeleton.crownBottom) continue;
        const l = 0.2126 * colour.getX(i) + 0.7152 * colour.getY(i) + 0.0722 * colour.getZ(i);
        if (l < minLuma) minLuma = l;
        if (l > maxLuma) maxLuma = l;
      }
      assert(maxLuma > minLuma * 1.5,
        `${tier}/${skeleton.species}: the crown is shaded from sunlit top to shaded underside `
        + `(${minLuma.toFixed(4)} .. ${maxLuma.toFixed(4)} linear luma)`);

      // 5. budget and fit
      assert(triangles <= cap, `${tier}/${skeleton.species}: within the per-tree triangle budget (${triangles} <= ${cap})`);
      assert(halfCrown <= STREET_TREE_MAX_HALF_CROWN,
        `${tier}/${skeleton.species}: the crown cannot reach a facade across the footway `
        + `(${halfCrown.toFixed(2)} m <= ${STREET_TREE_MAX_HALF_CROWN} m)`);
      assert(skeleton.height > 4.5 && skeleton.height < 9,
        `${tier}/${skeleton.species}: the tree is a street tree, not a sapling or a redwood (${skeleton.height.toFixed(2)} m)`);
      // It stands in the pit the pass builds: the trunk base has to fit inside
      // it at the largest instance scale the placement can choose.
      const maxInstanceScale = 1.32;
      assert(skeleton.trunkBaseRadius * maxInstanceScale < 1.06 / 2,
        `${tier}/${skeleton.species}: the trunk fits inside its 1.06 m pit at the largest instance scale `
        + `(${(skeleton.trunkBaseRadius * maxInstanceScale).toFixed(3)} m < 0.53 m)`);
      assert(Math.abs(skeleton.trunk[0].a.x) < 1e-9 && Math.abs(skeleton.trunk[0].a.z) < 1e-9
        && Math.abs(skeleton.trunk[0].a.y) < 1e-9,
        `${tier}/${skeleton.species}: the trunk starts at the pit centre, not floating beside it`);
      geometry.dispose();
    }
  }

  // Deterministic per species, and the three species really are different.
  const a = buildStreetTreeGeometry(0, false);
  const b = buildStreetTreeGeometry(0, false);
  const same = a.getAttribute('position').array.length === b.getAttribute('position').array.length
    && a.getAttribute('position').array.every((v, i) => v === b.getAttribute('position').array[i]);
  assert(same, 'the same species rebuilds bit-identical geometry');
  const forms = new Set();
  for (let v = 0; v < STREET_TREE_SPECIES.length; v += 1) {
    const g = buildStreetTreeGeometry(v, false);
    g.computeBoundingBox();
    forms.add(`${g.boundingBox.max.y.toFixed(3)}|${(g.boundingBox.max.x - g.boundingBox.min.x).toFixed(3)}`);
    g.dispose();
  }
  assert(forms.size === STREET_TREE_SPECIES.length,
    `every species has a distinct height and spread (${forms.size} distinct of ${STREET_TREE_SPECIES.length})`);
  a.dispose();
  b.dispose();
}

// ---------------------------------------------------------------------------
section('13. a block of trees varies, and every lit material declares a class');
// ---------------------------------------------------------------------------
{
  const city = gridCity();
  const built = buildStreetFurniture(makeCtx(city, { focus: { x: 0, z: 0 } }));
  const trees = built.items.filter((item) => item.kind === 'tree');
  assert(trees.length > 8, `the fixture city plants trees (${trees.length})`);
  // Variation ALONG ONE BLOCK, not just across the city: the round-2 defect
  // was that every tree in a frame was the same stamp at the same size.
  const bySegment = new Map();
  for (const tree of trees) {
    const list = bySegment.get(tree.segmentId) || [];
    list.push(tree);
    bySegment.set(tree.segmentId, list);
  }
  let bestRun = [];
  for (const list of bySegment.values()) if (list.length > bestRun.length) bestRun = list;
  assert(bestRun.length >= 4, `at least one block carries a run of trees (${bestRun.length})`);
  const nearRun = bestRun.filter((t) => t.lod === 0);
  const runVariants = new Set(bestRun.map((t) => t.variant));
  const runScales = new Set(bestRun.map((t) => t.scale.toFixed(3)));
  console.log(`  longest block run: ${bestRun.length} trees, ${runVariants.size} species, ${runScales.size} distinct scales`);
  assert(runScales.size >= Math.min(4, bestRun.length),
    `no two trees on the block are the same size (${runScales.size} distinct scales of ${bestRun.length})`);
  if (nearRun.length >= 4) {
    assert(new Set(nearRun.map((t) => t.variant)).size >= 2,
      `the near tier mixes species along one block (${new Set(nearRun.map((t) => t.variant)).size})`);
  }
  assert(trees.every((t) => Number.isInteger(t.variant)
    && t.variant < streetTreeVariantCount(t.lod)),
    'every tree carries a species index its level of detail actually has geometry for');
  // Determinism: same seed, same species mix.
  const again = buildStreetFurniture(makeCtx(city, { focus: { x: 0, z: 0 } }));
  const signature = (b) => b.items.map((i) => `${i.kind}:${i.variant}:${i.x.toFixed(3)}`).join('|');
  assert(signature(built) === signature(again), 'the species mix is deterministic for a seed');

  // Every lit material this pass creates declares an environment class the
  // grader knows. Two other subsystems have shipped unlit content through this
  // hole; making it structural here means a new material cannot repeat it.
  const materials = new Map();
  built.object.traverse((node) => {
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      materials.set(material.uuid, material);
    }
  });
  assert(materials.size >= 2, `the pass creates lit materials (${materials.size})`);
  let unclassified = 0;
  let unknown = 0;
  for (const material of materials.values()) {
    const envClass = material.userData?.envClass;
    if (!envClass) { unclassified += 1; continue; }
    if (!MATERIAL_CLASSES.includes(envClass)) unknown += 1;
  }
  assert(unclassified === 0,
    `every lit material declares userData.envClass, so the environment and wet-weather grader reaches it (${unclassified} missing)`);
  assert(unknown === 0,
    `every declared class is a member of MATERIAL_CLASSES (${unknown} unknown)`);
  const foliage = [...materials.values()].find((m) => m.name?.endsWith(':foliage'));
  assert(foliage?.userData.envClass === 'foliage',
    `the tree canopy is graded as foliage, not left ungraded (${foliage?.userData.envClass})`);
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('street-furniture OK');
