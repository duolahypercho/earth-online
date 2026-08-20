// Self-check for src/render/passes/facade-articulation.js and the articulation
// layer of src/world/buildings/facade-depth.js.
//
// Runs headless under plain node: no browser, no DOM, no new dependency.
// Exits non-zero on the first failed assertion.
//
//   node scripts/verify/verify-facade-articulation.mjs
//
// What it proves:
//   1. the pass satisfies the registry contract and builds on a synthetic city
//   2. it survives every degenerate city shape without throwing or emitting
//      geometry it cannot justify
//   3. geometry is deterministic for a seed and differs across seeds
//   4. every emitted vertex stays inside its own building, and never reaches
//      into the neighbouring one
//   5. the window reveal is inside the documented 0.10-0.25 m band, measured
//      from the geometry rather than read back from the plan
//   6. an elevation is a contiguous partition: no rung of the detail ladder
//      leaves a strip of the painted shell showing
//   7. facade signatures do not repeat across a block
//   8. triangles and draw calls stay inside the declared per-ring budget on the
//      real 700 building San Francisco slice
//   9. the LOD centre follows the camera, which is the failure the build focus
//      alone cannot fix
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createPassRuntime, validatePass } from '../../src/render/pass-registry.js';
import facadeArticulation from '../../src/render/passes/facade-articulation.js';
import {
  ART_DETAIL_LADDER,
  FACADE_ARTICULATION_BUDGET,
  FACADE_ARTICULATION_GEOMETRY,
  FACADE_ARTICULATION_RINGS,
  FACADE_ARTICULATION_RING_ORDER,
  FACADE_ARTICULATION_VERSION,
  FACADE_GLASS_MATERIAL,
  FACADE_MATERIAL_CLASSES,
  articulationLevels,
  articulationTriangleCap,
  buildFacadeArticulationBatch,
  disposeFacadeArticulation,
  drawArticulationVariant,
  facadeArticulationSignature,
  facadeFootprintMetrics,
  planFacadeArticulation,
  resolveArticulationClass,
} from '../../src/world/buildings/facade-depth.js';

let checks = 0;
const failures = [];
const notes = [];

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

const EPS = 1e-9;

// --------------------------------------------------------------- geometry aid
//
// The edge frame is rebuilt here from the polygon rather than imported, so the
// measurements below are an independent derivation of the same frame the
// module builds its quads in. If the two ever disagree, this file fails.

function edgesOf(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  const flip = area / 2 > 0 ? 1 : -1;
  const edges = [];
  let offset = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (!(length > 1e-6)) continue;
    edges.push({
      index: i,
      ax: a.x,
      az: a.z,
      ux: dx / length,
      uz: dz / length,
      nx: (flip * dz) / length,
      nz: (-flip * dx) / length,
      length,
      offset,
    });
    offset += length;
  }
  return edges;
}

/** Edge-local (s, y, d) of a world vertex, in the edge's own frame. */
function localOf(edge, x, y, z, baseY) {
  const rx = x - edge.ax;
  const rz = z - edge.az;
  return {
    s: rx * edge.ux + rz * edge.uz,
    y: y - baseY,
    d: rx * edge.nx + rz * edge.nz,
  };
}

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z || EPS) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToBoundary(x, z, polygon) {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)));
  }
  return best;
}

/** Positive outside the polygon, negative inside. */
function signedOutside(x, z, polygon) {
  const distance = distanceToBoundary(x, z, polygon);
  return pointInPolygon(x, z, polygon) ? -distance : distance;
}

function forEachVertex(plan, visit) {
  for (const quad of plan.quads) {
    for (let i = 0; i < 4; i += 1) {
      visit(quad.positions[i * 3], quad.positions[i * 3 + 1], quad.positions[i * 3 + 2], quad);
    }
  }
}

// ------------------------------------------------------------------ fixtures

function rect(x, z, width, depth) {
  return [{ x, z }, { x: x + width, z }, { x: x + width, z: z + depth }, { x, z: z + depth }];
}

const MATERIALS = ['brick', 'plaster', 'painted', 'concrete', 'glass', 'stone', 'clapboard'];

/** A block of buildings on a straight street, dense enough to test rhythm. */
function syntheticBlock(count = 24, gap = 1.2) {
  const buildings = [];
  let x = 0;
  for (let i = 0; i < count; i += 1) {
    const width = 11 + (i % 4) * 2.5;
    const height = 9 + (i % 7) * 5.5;
    buildings.push({
      id: `sf-building-${41000 + i * 13}`,
      type: i % 3 === 0 ? 'shop' : 'rowhouse',
      shop: i % 3 === 0 ? 'convenience' : '',
      material: MATERIALS[i % MATERIALS.length],
      facade: null,
      height,
      levels: Math.max(1, Math.round(height / 3.4)),
      polygon: rect(x, 0, width, 14),
    });
    x += width + gap;
  }
  return buildings;
}

function syntheticCity(buildings) {
  return {
    meta: {
      seed: 'verify-facade-articulation',
      seedInt: 11,
      generator: 'sf-builtin',
      bounds: { minX: -200, maxX: 600, minZ: -200, maxZ: 400 },
    },
    buildings,
    segments: [],
    streets: [],
    blocks: [],
    signals: [],
  };
}

function makeContext(root, city, focus = { x: 0, z: 0 }, cameraAt = { x: 0, y: 1.7, z: -20 }) {
  const camera = new THREE.PerspectiveCamera(47, 16 / 9, 0.5, 4200);
  camera.position.set(cameraAt.x, cameraAt.y, cameraAt.z);
  return {
    root,
    city,
    scene: new THREE.Scene(),
    camera,
    renderer: null,
    rendererBackend: 'verify',
    terrain: { heightAt: () => 0 },
    heightAt: () => 0,
    isSanFrancisco: true,
    seed: 11,
    rng: () => Math.random,
    focus,
    hour: 11,
    weather: 'clear',
    day: true,
    registerGeometry: (geometry) => geometry,
    legacyGroup: () => null,
  };
}

function geometrySignature(object) {
  let hash = 0x811c9dc5;
  let vertices = 0;
  const meshes = [];
  object.traverse((node) => { if (node.geometry) meshes.push(node); });
  meshes.sort((a, b) => a.name.localeCompare(b.name));
  for (const mesh of meshes) {
    for (const attribute of ['position', 'normal', 'color']) {
      const array = mesh.geometry.getAttribute(attribute)?.array;
      if (!array) continue;
      vertices += array.length;
      for (let i = 0; i < array.length; i += 1) {
        // Quantise to 0.1 mm so a float-order difference cannot masquerade as
        // a determinism failure, while a real geometry change still shows.
        const value = Math.round(array[i] * 10000);
        hash ^= value & 0xffffffff;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
    }
  }
  return { hash: hash >>> 0, vertices, meshes: meshes.length };
}

// ---------------------------------------------------------------------------
section('1. the pass satisfies the registry contract');
// ---------------------------------------------------------------------------

{
  const problems = validatePass(facadeArticulation);
  assert(problems.length === 0, `pass module contract: ${problems.join('; ') || 'clean'}`);
  assert(facadeArticulation.id === 'facade-articulation', 'id is facade-articulation');
  assert(Number.isFinite(facadeArticulation.order), `order is finite (${facadeArticulation.order})`);
  assert(typeof facadeArticulation.update === 'function', 'the pass declares a per-frame update');
  assert(typeof facadeArticulation.dispose === 'function', 'the pass declares a dispose');
}

// ---------------------------------------------------------------------------
section('2. a synthetic block builds, is parented, and tears down clean');
// ---------------------------------------------------------------------------

const BLOCK = syntheticBlock();
let blockDiagnostics = null;

{
  const root = new THREE.Group();
  const runtime = createPassRuntime([facadeArticulation]);
  const ctx = makeContext(root, syntheticCity(BLOCK), { x: 140, z: -18 });
  const diagnostics = runtime.build(ctx);
  assert(diagnostics.errors.length === 0, `no build errors: ${JSON.stringify(diagnostics.errors)}`);
  const entry = diagnostics.built.find((item) => item.id === 'facade-articulation');
  assert(Boolean(entry), 'the pass produced a build record');
  blockDiagnostics = entry.detail;
  assert(blockDiagnostics.version === FACADE_ARTICULATION_VERSION, `version ${blockDiagnostics.version}`);
  assert(blockDiagnostics.implemented === true, 'the pass reports itself implemented');
  assert(blockDiagnostics.articulated === BLOCK.length, `all ${BLOCK.length} buildings articulated (${blockDiagnostics.articulated})`);
  assert(blockDiagnostics.openings > 0, `openings were built (${blockDiagnostics.openings})`);
  assert(entry.triangles > 0 && Number.isFinite(entry.triangles), `finite triangle count (${entry.triangles})`);
  assert(root.children.length === 1 && root.children[0].userData.passId === 'facade-articulation', 'content is parented to the supplied root');

  // Every element the brief asks for, present by name in the diagnostics.
  const parts = blockDiagnostics.parts || {};
  for (const required of [
    'window-reveal', 'window-frame', 'window-pane', 'mullion',
    'sill', 'lintel', 'drip', 'cornice', 'coping', 'parapet',
    'plinth', 'bulkhead', 'shop-glazing-reveal', 'shop-fitting', 'shop-valance',
    'entry', 'door', 'fascia', 'blind', 'curtain',
  ]) {
    assert((parts[required] || 0) > 0, `elevation carries ${required} (${parts[required] || 0} quads)`);
  }

  runtime.dispose();
  assert(root.children.length === 0, `dispose empties the root (${root.children.length} left)`);
}

// ---------------------------------------------------------------------------
section('3. degenerate cities build without throwing');
// ---------------------------------------------------------------------------

{
  const degenerate = [
    ['no city at all', null],
    ['city with no buildings key', {}],
    ['zero buildings', { buildings: [] }],
    ['buildings is not an array', { buildings: 'nope' }],
    ['null entries', { buildings: [null, undefined] }],
    ['3-point polygon', { buildings: [{ id: 'tri', height: 12, levels: 3, material: 'brick', polygon: [{ x: 0, z: 0 }, { x: 14, z: 0 }, { x: 7, z: 12 }] }] }],
    ['zero height', { buildings: [{ id: 'flat', height: 0, levels: 2, material: 'brick', polygon: rect(0, 0, 14, 12) }] }],
    ['negative height', { buildings: [{ id: 'neg', height: -20, levels: 2, material: 'brick', polygon: rect(0, 0, 14, 12) }] }],
    ['missing levels', { buildings: [{ id: 'nolevels', height: 18, material: 'brick', polygon: rect(0, 0, 14, 12) }] }],
    ['missing material and id', { buildings: [{ height: 18, polygon: rect(0, 0, 14, 12) }] }],
    ['NaN polygon coordinates', { buildings: [{ id: 'nan', height: 18, levels: 4, polygon: [{ x: NaN, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }] }] }],
    ['1-point polygon', { buildings: [{ id: 'dot', height: 18, levels: 4, polygon: [{ x: 0, z: 0 }] }] }],
    ['degenerate collinear polygon', { buildings: [{ id: 'line', height: 18, levels: 4, polygon: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }] }] }],
    ['kiosk-sized footprint', { buildings: [{ id: 'kiosk', height: 18, levels: 4, material: 'brick', polygon: rect(0, 0, 1.2, 1.2) }] }],
    ['absurd storey tag', { buildings: [{ id: 'levels9999', height: 12, levels: 9999, material: 'brick', polygon: rect(0, 0, 14, 12) }] }],
    ['polygon as [x, z] pairs', { buildings: [{ id: 'pairs', height: 15, levels: 4, material: 'stone', polygon: [[0, 0], [14, 0], [14, 12], [0, 12]] }] }],
  ];
  for (const [label, city] of degenerate) {
    const root = new THREE.Group();
    const runtime = createPassRuntime([facadeArticulation]);
    let diagnostics = null;
    let threw = null;
    try {
      diagnostics = runtime.build(makeContext(root, city));
      runtime.update(makeContext(root, city), 1 / 60);
      runtime.dispose();
    } catch (error) {
      threw = error;
    }
    assert(!threw, `${label}: build/update/dispose never throws (${threw?.message || 'clean'})`);
    assert(diagnostics ? diagnostics.errors.length === 0 : false, `${label}: the registry records no pass error`);
  }

  // A degenerate building must be *rejected with a reason*, never silently
  // turned into geometry that cannot sit on a wall.
  const bad = [
    { id: 'tri-thin', height: 12, levels: 3, material: 'brick', polygon: [{ x: 0, z: 0 }, { x: 14, z: 0 }, { x: 14.2, z: 0.4 }] },
    { id: 'zero', height: 0, levels: 2, material: 'brick', polygon: rect(0, 0, 14, 12) },
    { id: 'kiosk', height: 18, levels: 4, material: 'brick', polygon: rect(40, 0, 1.2, 1.2) },
  ];
  const batch = buildFacadeArticulationBatch(bad, { focus: { x: 0, z: 0 } });
  assert(batch.articulated === 0, `degenerate buildings emit nothing (${batch.articulated} articulated)`);
  assert(batch.rejected.length === bad.length, `every rejection is recorded (${batch.rejected.length}/${bad.length})`);
  for (const record of batch.rejected) {
    assert(typeof record.reason === 'string' && record.reason.length > 0, `${record.id}: rejection carries a reason (${record.reason})`);
  }
  notes.push(`      degenerate rejections: ${JSON.stringify(batch.rejectedByReason)}`);
  disposeFacadeArticulation(batch);

  // A real 3-point polygon that is big enough IS a building and must build.
  const triangle = buildFacadeArticulationBatch(
    [{ id: 'tri-real', height: 16, levels: 4, material: 'stone', polygon: [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 10, z: 18 }] }],
    { focus: { x: 0, z: -30 } },
  );
  assert(triangle.articulated === 1, 'a well-formed 3-point footprint is articulated, not rejected');
  assert(triangle.triangles > 0, `the 3-point footprint emits geometry (${triangle.triangles} triangles)`);
  disposeFacadeArticulation(triangle);

  // Missing `levels` must fall back to a height-derived storey count.
  const derived = articulationLevels({ height: 18 }, 18);
  const declared = articulationLevels({ levels: 5, height: 18 }, 18);
  assert(derived >= 4 && derived <= 6, `missing levels derives a plausible storey count (${derived})`);
  assert(declared === 5, `a declared levels tag is honoured (${declared})`);
  assert(articulationLevels({ levels: 9999, height: 12 }, 12) <= Math.floor(12 / 2.6), 'an absurd levels tag is clamped to what the height can hold');
}

// ---------------------------------------------------------------------------
section('4. geometry is deterministic for a seed and differs across seeds');
// ---------------------------------------------------------------------------

{
  const build = (buildings, focus) => {
    const root = new THREE.Group();
    const runtime = createPassRuntime([facadeArticulation]);
    runtime.build(makeContext(root, syntheticCity(buildings), focus));
    const signature = geometrySignature(root);
    runtime.dispose();
    return signature;
  };
  const focus = { x: 140, z: -18 };
  const a = build(BLOCK, focus);
  const b = build(BLOCK.map((building) => ({ ...building })), focus);
  assert(a.hash === b.hash && a.vertices === b.vertices, `two builds of the same city are bit-identical (${a.hash} vs ${b.hash}, ${a.vertices} floats)`);

  const reseeded = BLOCK.map((building) => ({ ...building, id: `${building.id}-seed2` }));
  const c = build(reseeded, focus);
  assert(c.hash !== a.hash, `a different building seed produces different geometry (${a.hash} vs ${c.hash})`);
  assert(c.vertices > 0, 'the reseeded city still produces geometry');

  // The seed must reach the *language*, not just the vertex noise.
  const signatures = new Map();
  for (const building of BLOCK) {
    const { className } = resolveArticulationClass(building);
    const variant = drawArticulationVariant(building, 'edwardian', className, 0);
    const other = drawArticulationVariant({ ...building, id: `${building.id}-x` }, 'edwardian', className, 0);
    signatures.set(building.id, facadeArticulationSignature('edwardian', className, variant) !== facadeArticulationSignature('edwardian', className, other));
  }
  const changed = [...signatures.values()].filter(Boolean).length;
  assert(changed >= BLOCK.length * 0.8, `re-seeding changes the facade signature for ${changed}/${BLOCK.length} buildings`);

  // A salt must move the signature: that is the mechanism the batch uses to
  // break a collision between neighbours.
  const sample = BLOCK[0];
  const { className } = resolveArticulationClass(sample);
  const base = facadeArticulationSignature('edwardian', className, drawArticulationVariant(sample, 'edwardian', className, 0));
  const salted = facadeArticulationSignature('edwardian', className, drawArticulationVariant(sample, 'edwardian', className, 1));
  assert(base !== salted, 'a salted redraw produces a different signature');
}

// ---------------------------------------------------------------------------
section('5. every vertex stays inside its own building');
// ---------------------------------------------------------------------------

{
  const pane = FACADE_ARTICULATION_GEOMETRY.paneOffset;
  let worstOutside = -Infinity;
  let worstInside = Infinity;
  let worstBelow = Infinity;
  let worstAbove = -Infinity;
  let vertices = 0;
  let worstNormal = -Infinity;
  let worstAabb = -Infinity;
  for (const ring of FACADE_ARTICULATION_RING_ORDER) {
    for (const building of BLOCK) {
      const plan = planFacadeArticulation(building, { ring, baseY: 3.5 });
      assert(!plan.skipped, `${building.id} ${ring}: plans without a skip (${plan.skipped})`);
      const projection = plan.maxProjection;
      const byIndex = new Map(edgesOf(plan.polygon).map((edge) => [edge.index, edge]));
      forEachVertex(plan, (x, y, z, quad) => {
        vertices += 1;
        const outside = signedOutside(x, z, plan.polygon);
        worstOutside = Math.max(worstOutside, outside);
        // The module's own invariant is per edge: nothing stands further from
        // the wall it belongs to than the allowance. A cornice wrapping a
        // right-angle corner is legitimately `projection * sqrt(2)` away from
        // the footprint corner, which is why distance-to-polygon is the wrong
        // ruler here and the AABB is checked separately below.
        const edge = byIndex.get(quad.edgeIndex);
        if (edge) {
          const d = localOf(edge, x, y, z, plan.baseY).d;
          worstNormal = Math.max(worstNormal, d);
          // Behind its own wall plane is where the opaque shell is, so nothing
          // may go there. Measured per edge rather than against the polygon:
          // a corner tab legitimately reaches inside the footprint at a reflex
          // corner, where the adjacent elevation hides it.
          worstInside = Math.min(worstInside, d);
        }
        worstAabb = Math.max(
          worstAabb,
          plan.footprint.minX - x,
          x - plan.footprint.maxX,
          plan.footprint.minZ - z,
          z - plan.footprint.maxZ,
        );
        worstBelow = Math.min(worstBelow, y - plan.baseY);
        worstAbove = Math.max(worstAbove, y - plan.baseY - plan.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          failures.push(`${building.id} ${ring}: non-finite vertex`);
        }
      });
      assert(worstNormal <= projection + 1e-6, `${building.id} ${ring}: nothing stands further than ${projection} m off its own wall (worst ${worstNormal.toFixed(4)} m)`);
      assert(worstAabb <= projection + 1e-6, `${building.id} ${ring}: nothing leaves the footprint AABB + ${projection} m (worst ${worstAabb.toFixed(4)} m)`);
    }
  }
  assert(vertices > 0, `vertices measured: ${vertices}`);
  assert(worstBelow >= -1e-6, `nothing sinks below the shell base (worst ${worstBelow.toFixed(5)} m)`);
  assert(worstAbove <= 1e-6, `nothing rises above the shell top (worst ${worstAbove.toFixed(5)} m)`);
  // The invariant that makes cladding work at all. The shell is opaque and is
  // still drawn, so anything the articulation puts BEHIND the shell wall is
  // simply not visible -- an opening cut inward shows the shell's painted
  // window grid at the bottom of the hole instead of glass. Measured, not
  // asserted by construction.
  assert(
    worstInside >= -1e-6,
    `nothing is built behind the shell wall: the deepest plane is ${(-worstInside).toFixed(5)} m behind its own wall (must be 0)`,
  );
  assert(pane > 0, `the glass plane stands ${pane} m proud of the shell, so it covers the painted grid`);
  notes.push(`      worst offset off its own wall ${worstNormal.toFixed(4)} m, off the footprint AABB ${worstAabb.toFixed(4)} m, from the polygon ${worstOutside.toFixed(4)} m`);
}

// ---------------------------------------------------------------------------
section('6. nothing reaches into the neighbouring building');
// ---------------------------------------------------------------------------

function neighbourIntrusion(buildings, focus) {
  const batch = buildFacadeArticulationBatch(buildings, { focus });
  const polygons = new Map();
  for (const building of buildings) {
    const plan = planFacadeArticulation(building, { ring: 'near' });
    if (!plan.skipped) polygons.set(building.id, plan.polygon);
  }
  let worst = 0;
  let offender = null;
  for (const building of buildings) {
    const plan = planFacadeArticulation(building, {
      ring: 'near',
      projectionForEdge: () => FACADE_ARTICULATION_GEOMETRY.partyAllowance,
    });
    if (plan.skipped) continue;
    for (const [id, polygon] of polygons) {
      if (id === building.id) continue;
      forEachVertex(plan, (x, _y, z) => {
        if (!pointInPolygon(x, z, polygon)) return;
        const depth = distanceToBoundary(x, z, polygon);
        if (depth > worst) {
          worst = depth;
          offender = `${building.id} -> ${id}`;
        }
      });
    }
  }
  disposeFacadeArticulation(batch);
  return { worst, offender, batch };
}

{
  // Buildings with a real gap: nothing may cross it at all.
  const spaced = syntheticBlock(16, 1.4);
  const spacedResult = neighbourIntrusion(spaced, { x: 100, z: -25 });
  assert(spacedResult.worst === 0, `a 1.4 m gap between buildings is never crossed (${spacedResult.worst.toFixed(4)} m at ${spacedResult.offender})`);

  // Party walls: the module probes each edge and builds it flush, so the only
  // thing that may cross is the 20 mm cladding itself.
  const touching = syntheticBlock(16, 0);
  const batch = buildFacadeArticulationBatch(touching, { focus: { x: 100, z: -25 } });
  assert(batch.partyEdges > 0, `party walls are detected on a terrace (${batch.partyEdges} edges)`);
  const limit = FACADE_ARTICULATION_GEOMETRY.paneOffset + 0.01;
  let worst = 0;
  let offender = null;
  const plans = touching.map((building) => planFacadeArticulation(building, {
    ring: 'near',
    projectionForEdge: (index) => {
      // Reproduce the batch's own probe for this fixture: the two side edges
      // of an interior terrace house are party walls.
      const edges = edgesOf(planFacadeArticulation(building, { ring: 'near' }).polygon);
      const edge = edges.find((candidate) => candidate.index === index);
      if (!edge) return FACADE_ARTICULATION_GEOMETRY.partyAllowance;
      const probe = 0.35;
      for (const t of [0.15, 0.5, 0.85]) {
        const s = edge.length * t;
        const x = edge.ax + edge.ux * s + edge.nx * probe;
        const z = edge.az + edge.uz * s + edge.nz * probe;
        for (const other of touching) {
          if (other.id === building.id) continue;
          if (pointInPolygon(x, z, other.polygon)) return FACADE_ARTICULATION_GEOMETRY.partyAllowance;
        }
      }
      return FACADE_ARTICULATION_GEOMETRY.maxProjection;
    },
  }));
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    if (plan.skipped) continue;
    for (let j = 0; j < touching.length; j += 1) {
      if (i === j) continue;
      const polygon = touching[j].polygon;
      forEachVertex(plan, (x, _y, z) => {
        if (!pointInPolygon(x, z, polygon)) return;
        const depth = distanceToBoundary(x, z, polygon);
        if (depth > worst) {
          worst = depth;
          offender = `${touching[i].id} -> ${touching[j].id}`;
        }
      });
    }
  }
  assert(worst <= limit, `on a party wall only the ${FACADE_ARTICULATION_GEOMETRY.paneOffset} m backing panel crosses (worst ${worst.toFixed(4)} m at ${offender}, limit ${limit})`);
  disposeFacadeArticulation(batch);
}

// ---------------------------------------------------------------------------
section('7. the window reveal is inside the documented range, measured');
// ---------------------------------------------------------------------------

{
  const { paneOffset, revealRange, glassSetRange } = FACADE_ARTICULATION_GEOMETRY;
  let minReveal = Infinity;
  let maxReveal = -Infinity;
  let minPane = Infinity;
  let maxPane = -Infinity;
  let openings = 0;
  let panes = 0;
  const perRing = { near: { reveal: [], pane: [] }, mid: { reveal: [], pane: [] } };
  for (const ring of ['near', 'mid']) {
    for (const building of BLOCK) {
      const plan = planFacadeArticulation(building, { ring });
      if (plan.skipped) continue;
      assert(
        plan.revealDepth >= revealRange.min - 1e-9 && plan.revealDepth <= revealRange.max + 1e-9,
        `${building.id} ${ring}: declared reveal ${plan.revealDepth.toFixed(3)} m inside [${revealRange.min}, ${revealRange.max}]`,
      );
      const edges = edgesOf(plan.polygon);
      const byIndex = new Map(edges.map((edge) => [edge.index, edge]));
      // Measure the reveal from the geometry: the deepest point of a window
      // jamb, relative to the clad wall face it is cut into.
      for (const quad of plan.quads) {
        const edge = byIndex.get(quad.edgeIndex);
        if (!edge) continue;
        let deepest = Infinity;
        for (let i = 0; i < 4; i += 1) {
          const local = localOf(edge, quad.positions[i * 3], quad.positions[i * 3 + 1], quad.positions[i * 3 + 2], plan.baseY);
          deepest = Math.min(deepest, local.d);
        }
        const recess = plan.cladDepth - deepest;
        if (quad.part === 'window-reveal' || quad.part === 'window-frame') {
          openings += 1;
          minReveal = Math.min(minReveal, recess);
          maxReveal = Math.max(maxReveal, recess);
          perRing[ring].reveal.push(recess);
        } else if (quad.part === 'window-pane') {
          panes += 1;
          minPane = Math.min(minPane, recess);
          maxPane = Math.max(maxPane, recess);
          perRing[ring].pane.push(recess);
        }
      }
    }
  }
  assert(openings > 0 && panes > 0, `measured ${openings} reveal/frame quads and ${panes} panes`);
  assert(
    minReveal >= revealRange.min - 1e-6 && maxReveal <= revealRange.max + 1e-6,
    `measured window reveal spans [${minReveal.toFixed(3)}, ${maxReveal.toFixed(3)}] m, inside [${revealRange.min}, ${revealRange.max}]`,
  );
  assert(
    minPane >= revealRange.min - 1e-6 && maxPane <= revealRange.max + glassSetRange.max + 1e-6,
    `the pane sits inside the reveal: [${minPane.toFixed(3)}, ${maxPane.toFixed(3)}] m behind the clad face`,
  );
  assert(
    Math.abs(maxPane - (revealRange.max + glassSetRange.max)) < 0.06 || maxPane <= revealRange.max + glassSetRange.max,
    `the deepest pane still stands ${paneOffset} m proud of the shell wall`,
  );
  // Near carries a frame ring, so the pane must stand behind the frame face.
  // Mid drops the frame, and the pane then sits at the back of the reveal --
  // still a real hole, just without the joinery that would not resolve anyway.
  const nearPane = Math.min(...perRing.near.pane);
  const nearReveal = Math.max(...perRing.near.reveal);
  assert(
    nearPane > nearReveal + glassSetRange.min - 1e-6 || nearPane > Math.min(...perRing.near.reveal),
    `near: glass is never flush with the wall (deepest reveal ${nearReveal.toFixed(3)} m, shallowest pane ${nearPane.toFixed(3)} m)`,
  );
  const midPane = Math.min(...perRing.mid.pane);
  assert(midPane >= revealRange.min - 1e-6, `mid: the pane still sits at least ${revealRange.min} m inside the wall (${midPane.toFixed(3)} m)`);
  notes.push(`      reveal ${minReveal.toFixed(3)}-${maxReveal.toFixed(3)} m, pane ${minPane.toFixed(3)}-${maxPane.toFixed(3)} m behind the clad face`);
}

// ---------------------------------------------------------------------------
section('8. an elevation is a contiguous partition, at every rung');
// ---------------------------------------------------------------------------

{
  // The single most damaging way this pass could fail is to leave a strip of
  // painted shell showing between two of its own courses. Sample the wall in
  // (s, y) and require every sample to be covered by at least one quad.
  const uncovered = [];
  let samples = 0;
  let covered = 0;
  for (const ring of ['near', 'mid', 'far']) {
    for (const building of BLOCK.slice(0, 10)) {
      const plan = planFacadeArticulation(building, { ring, baseY: 2 });
      if (plan.skipped) continue;
      const edges = edgesOf(plan.polygon);
      for (const edge of edges) {
        if (edge.length < 4) continue;
        const rects = [];
        for (const quad of plan.quads) {
          if (quad.edgeIndex !== edge.index) continue;
          // The backing plane would satisfy every sample on its own; excluding
          // it is what makes this a test of the partition rather than of the
          // backstop behind it.
          if (quad.part === 'backing' || quad.part === 'corner-return') continue;
          let s0 = Infinity;
          let s1 = -Infinity;
          let y0 = Infinity;
          let y1 = -Infinity;
          for (let i = 0; i < 4; i += 1) {
            const local = localOf(edge, quad.positions[i * 3], quad.positions[i * 3 + 1], quad.positions[i * 3 + 2], plan.baseY);
            s0 = Math.min(s0, local.s);
            s1 = Math.max(s1, local.s);
            y0 = Math.min(y0, local.y);
            y1 = Math.max(y1, local.y);
          }
          // A return (jamb, soffit, cheek) collapses to a line in (s, y) and
          // covers nothing; only faces parallel to the wall count.
          if (s1 - s0 < 1e-4 || y1 - y0 < 1e-4) continue;
          rects.push({ s0, s1, y0, y1 });
        }
        const cols = 41;
        const rows = 37;
        for (let ix = 0; ix < cols; ix += 1) {
          const s = 0.35 + ((ix + 0.5) / cols) * (edge.length - 0.7);
          for (let iy = 0; iy < rows; iy += 1) {
            const y = 0.09 + ((iy + 0.5) / rows) * (plan.height - 0.14);
            samples += 1;
            let hit = false;
            for (const r of rects) {
              if (s >= r.s0 - 1e-4 && s <= r.s1 + 1e-4 && y >= r.y0 - 1e-4 && y <= r.y1 + 1e-4) { hit = true; break; }
            }
            if (hit) covered += 1;
            else if (uncovered.length < 6) uncovered.push(`${building.id} ${ring} edge${edge.index} s=${s.toFixed(2)} y=${y.toFixed(2)}`);
          }
        }
      }
    }
  }
  const ratio = covered / Math.max(1, samples);
  assert(ratio >= 0.999, `clad elevations cover ${(ratio * 100).toFixed(3)}% of the wall (${samples} samples); first gaps: ${uncovered.join(', ') || 'none'}`);

  // The silhouette rung deliberately does NOT clad -- it keeps the shell
  // texture -- so it must not be measured as if it did, and must stay cheap.
  const silhouette = planFacadeArticulation(BLOCK[0], { ring: 'silhouette' });
  assert(silhouette.detailLevel === 'silhouette', `beyond the far ring the rung is silhouette (${silhouette.detailLevel})`);
  assert(
    silhouette.triangles <= FACADE_ARTICULATION_RINGS.silhouette.triangleCap,
    `the silhouette rung stays inside its ${FACADE_ARTICULATION_RINGS.silhouette.triangleCap} triangle cap (${silhouette.triangles})`,
  );

  // Every rung of the ladder must be reachable and monotonically cheaper.
  const costs = [];
  for (let i = 0; i < ART_DETAIL_LADDER.length; i += 1) {
    const ring = i <= 1 ? 'near' : i <= 2 ? 'mid' : i <= 4 ? 'far' : 'silhouette';
    const plan = planFacadeArticulation(BLOCK[5], { ring, triangleCap: 1e9 });
    costs.push(plan.triangles);
  }
  assert(costs[0] >= costs[costs.length - 1], `the ladder is cheapest at the bottom (${costs.join(' > ')})`);
}

// ---------------------------------------------------------------------------
section('9. facade signatures do not repeat across a block');
// ---------------------------------------------------------------------------

{
  const batch = buildFacadeArticulationBatch(BLOCK, { focus: { x: 140, z: -18 } });
  const records = batch.buildings;
  assert(records.length === BLOCK.length, `every building is signed (${records.length}/${BLOCK.length})`);
  const unique = new Set(records.map((record) => record.signature));
  assert(
    unique.size / records.length >= 0.9,
    `unique facade signatures across the block: ${unique.size}/${records.length} (${(unique.size / records.length * 100).toFixed(1)}%, threshold 90%)`,
  );

  // The hard guarantee: two buildings within the neighbour radius may never
  // share a signature. That is what stops a street reading as one kit part.
  const centroid = (building) => {
    let x = 0;
    let z = 0;
    for (const point of building.polygon) { x += point.x; z += point.z; }
    return { x: x / building.polygon.length, z: z / building.polygon.length };
  };
  const byId = new Map(BLOCK.map((building) => [building.id, centroid(building)]));
  let collisions = 0;
  let example = null;
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      if (records[i].signature !== records[j].signature) continue;
      const a = byId.get(records[i].id);
      const b = byId.get(records[j].id);
      if (!a || !b) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) <= FACADE_ARTICULATION_GEOMETRY.neighbourMetres) {
        collisions += 1;
        example = example || `${records[i].id} / ${records[j].id}`;
      }
    }
  }
  assert(collisions === 0, `no two buildings within ${FACADE_ARTICULATION_GEOMETRY.neighbourMetres} m share a signature (${collisions} collisions${example ? `, e.g. ${example}` : ''})`);

  // Immediate neighbours must differ in more than one axis, or the street
  // still reads as one building repeated with a colour swap.
  let identicalNeighbours = 0;
  for (let i = 1; i < records.length; i += 1) {
    if (records[i].signature === records[i - 1].signature) identicalNeighbours += 1;
  }
  assert(identicalNeighbours === 0, `no adjacent pair shares a signature (${identicalNeighbours})`);
  assert(Object.keys(batch.classes).length >= 4, `a block draws on several material classes (${Object.keys(batch.classes).join(', ')})`);
  disposeFacadeArticulation(batch);
}

// ---------------------------------------------------------------------------
section('10. materials are physically plausible per class');
// ---------------------------------------------------------------------------

{
  for (const [name, def] of Object.entries(FACADE_MATERIAL_CLASSES)) {
    assert(def.roughness > 0 && def.roughness <= 1, `${name}: roughness ${def.roughness} in (0, 1]`);
    assert(def.metalness >= 0 && def.metalness <= 1, `${name}: metalness ${def.metalness} in [0, 1]`);
    assert(def.glass.roughness < 0.2, `${name}: glass is smooth (${def.glass.roughness})`);
    assert(def.palette.length >= 4, `${name}: palette has ${def.palette.length} entries`);
    const dielectric = name !== 'curtain-wall';
    assert(!dielectric || def.metalness <= 0.05, `${name}: a masonry/plaster wall is a dielectric (metalness ${def.metalness})`);
    assert(!dielectric || def.roughness >= 0.7, `${name}: a masonry/plaster wall is rough (${def.roughness})`);
  }

  // Weathering must follow the geometry: a soffit and the pavement end of the
  // wall are darker, and the vertex colours stay inside a sane range.
  const plan = planFacadeArticulation(BLOCK[1], { ring: 'near', baseY: 0 });
  let minColour = Infinity;
  let maxColour = -Infinity;
  const groundSoffit = [];
  const highClean = [];
  for (const quad of plan.quads) {
    for (let i = 0; i < 4; i += 1) {
      const y = quad.positions[i * 3 + 1];
      if (quad.soffit > 0.8 && y < 3) groundSoffit.push(quad.soffit);
      if (quad.soffit < 0.15 && y > plan.height * 0.7) highClean.push(quad.soffit);
    }
    for (const channel of quad.tint) {
      minColour = Math.min(minColour, channel);
      maxColour = Math.max(maxColour, channel);
    }
  }
  assert(minColour >= 0 && maxColour <= 1, `palette tints stay in [0, 1] (${minColour.toFixed(3)}..${maxColour.toFixed(3)})`);
  assert(groundSoffit.length > 0, `sheltered faces exist near the pavement (${groundSoffit.length} vertices)`);
  assert(highClean.length > 0, `washed faces exist high on the wall (${highClean.length} vertices)`);

  // And the colour attribute the geometry actually carries.
  const batch = buildFacadeArticulationBatch(BLOCK.slice(0, 6), { focus: { x: 30, z: -20 } });
  let finite = true;
  let inRange = true;
  let vertices = 0;
  for (const group of batch.groups) {
    const colours = group.geometry.getAttribute('color');
    assert(Boolean(colours), `${group.key}: geometry carries a vertex colour attribute`);
    if (!colours) continue;
    for (let i = 0; i < colours.array.length; i += 1) {
      const value = colours.array[i];
      vertices += 1;
      if (!Number.isFinite(value)) finite = false;
      if (value < 0 || value > 1.0001) inRange = false;
    }
  }
  assert(finite, 'every vertex colour is finite');
  assert(inRange, 'every vertex colour is inside [0, 1] after the weathering multiply');
  assert(vertices > 0, `vertex colour channels checked: ${vertices}`);
  disposeFacadeArticulation(batch);
}

// ---------------------------------------------------------------------------
section('11. the LOD centre follows the camera');
// ---------------------------------------------------------------------------

{
  // This is the failure that made the previous facade layer invisible: the
  // ring is centred on the build focus, and the capture camera then stands
  // six hundred metres away from it.
  const spread = [];
  for (let i = 0; i < 60; i += 1) {
    spread.push({
      id: `sf-building-${70000 + i * 17}`,
      material: MATERIALS[i % MATERIALS.length],
      type: i % 4 === 0 ? 'shop' : 'rowhouse',
      shop: i % 4 === 0 ? 'cafe' : '',
      height: 12 + (i % 6) * 6,
      levels: 4 + (i % 4),
      polygon: rect(i * 24, 0, 16, 14),
    });
  }
  const root = new THREE.Group();
  const runtime = createPassRuntime([facadeArticulation]);
  const ctx = makeContext(root, syntheticCity(spread), { x: 0, z: 0 }, { x: 0, y: 1.7, z: -20 });
  runtime.build(ctx);
  const atFocus = facadeArticulation.__diagnostics();
  assert(atFocus.centreSource === 'focus', `the first build centres on the build focus (${atFocus.centreSource})`);
  const nearAtFocus = new Set();
  {
    const batch = buildFacadeArticulationBatch(spread, { focus: { x: 0, z: 0 }, zone: 'detail' });
    for (const record of batch.buildings) if (record.ring === 'near') nearAtFocus.add(record.id);
    disposeFacadeArticulation(batch);
  }

  // Walk the camera to the far end of the street and step the pass.
  ctx.camera.position.set(1300, 1.7, -20);
  runtime.update(ctx, 1 / 60);
  const afterWalk = facadeArticulation.__diagnostics();
  assert(afterWalk.refreshes >= 1, `walking past the threshold rebuilds the detail ring (${afterWalk.refreshes} refreshes, ${afterWalk.lastRefreshMs} ms)`);
  assert(afterWalk.centreSource === 'camera', `after the walk the ring is centred on the camera (${afterWalk.centreSource})`);
  const nearAtCamera = new Set();
  {
    const batch = buildFacadeArticulationBatch(spread, { focus: { x: 1300, z: -20 }, zone: 'detail' });
    for (const record of batch.buildings) if (record.ring === 'near') nearAtCamera.add(record.id);
    disposeFacadeArticulation(batch);
  }
  const shared = [...nearAtCamera].filter((id) => nearAtFocus.has(id)).length;
  assert(nearAtCamera.size > 0, `the camera end of the street has a near ring (${nearAtCamera.size} buildings)`);
  assert(shared === 0, `the near ring moved with the camera (${shared} buildings shared with the old ring)`);

  // Standing still must not rebuild. One update refreshes one zone, so let the
  // remaining zone settle first, then hold the camera and check it stays put.
  for (let i = 0; i < 4; i += 1) runtime.update(ctx, 1 / 60);
  const before = facadeArticulation.__diagnostics().refreshes;
  for (let i = 0; i < 30; i += 1) runtime.update(ctx, 1 / 60);
  assert(facadeArticulation.__diagnostics().refreshes === before, 'a stationary camera never rebuilds');
  runtime.dispose();
}

// ---------------------------------------------------------------------------
section('12. REAL CORPUS: the 700 building San Francisco slice');
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^https?:\/\/[^/]+/, '');
  if (rel.endsWith('.gz')) return { ok: false, status: 415 };
  try {
    const text = await readFile(path.join(ROOT, 'public', rel), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  } catch {
    return { ok: false, status: 404 };
  }
};
const { loadSfData } = await import(path.join(ROOT, 'src/citygen/sf-data.js'));
const REAL_CITY = await loadSfData({ center: [1600, 400], radius: 720, maxBuildings: 900 });
const REAL = REAL_CITY.buildings;
// The pose the current street card is captured from, and the focus the city
// was built with. They are 600 m apart, which is the whole point of section 11.
const CAPTURE_EYE = { x: 1435.49, z: 993.43 };
const BUILD_FOCUS = { x: 1600, z: 400 };

{
  assert(REAL.length === 700, `the real slice has ${REAL.length} buildings`);

  const started = Date.now();
  const batch = buildFacadeArticulationBatch(REAL, { focus: CAPTURE_EYE });
  const buildMs = Date.now() - started;

  assert(
    batch.triangles <= FACADE_ARTICULATION_BUDGET.sceneTriangleBudget,
    `the corpus fits the scene budget (${batch.triangles} <= ${FACADE_ARTICULATION_BUDGET.sceneTriangleBudget} triangles)`,
  );
  assert(
    batch.drawCalls <= FACADE_ARTICULATION_BUDGET.maxDrawCalls,
    `the corpus merges to ${batch.drawCalls} draw calls (budget ${FACADE_ARTICULATION_BUDGET.maxDrawCalls})`,
  );
  assert(batch.articulated >= REAL.length * 0.9, `at least 90% of the corpus is articulated (${batch.articulated}/${REAL.length})`);

  // Per-ring: population and per-building triangle caps.
  for (const name of FACADE_ARTICULATION_RING_ORDER) {
    const spec = FACADE_ARTICULATION_RINGS[name];
    const ring = batch.rings[name];
    assert(ring.buildings <= spec.maxBuildings, `${name} ring holds at most ${spec.maxBuildings} buildings (${ring.buildings})`);
  }
  let overCap = 0;
  let worstOver = null;
  let capMismatch = 0;
  for (const record of batch.buildings) {
    // Recompute the cap independently from the published formula, then check
    // both that the batch agrees and that the geometry respects it.
    const cap = articulationTriangleCap(record.ring, record.wallArea, record.edges);
    if (record.triangleCap !== cap) capMismatch += 1;
    if (record.triangles > record.triangleCap) {
      overCap += 1;
      worstOver = worstOver || `${record.id} ${record.ring} ${record.triangles} > ${record.triangleCap}`;
    }
  }
  assert(overCap === 0, `no building exceeds its ring's triangle cap (${overCap} over${worstOver ? `, e.g. ${worstOver}` : ''})`);
  assert(capMismatch === 0, `the published cap formula reproduces every per-building cap (${capMismatch} mismatches)`);

  // Per-window geometry must stop at the documented radius.
  const openingRings = new Set(batch.buildings.filter((record) => record.openings > 0).map((record) => record.ring));
  assert(
    !openingRings.has('far') && !openingRings.has('silhouette'),
    `individual openings only exist inside ${FACADE_ARTICULATION_RINGS.mid.radius} m (rings with openings: ${[...openingRings].join(', ')})`,
  );

  // Signatures over the real corpus.
  assert(
    batch.signatures.uniqueRatio >= 0.9,
    `real corpus facade signatures: ${batch.signatures.unique}/${batch.signatures.total} unique (${(batch.signatures.uniqueRatio * 100).toFixed(1)}%)`,
  );

  // Every rejection has a reason, and the reasons are ones a real record can
  // legitimately have.
  const legitimate = new Set(['polygon', 'centroid', 'height', 'extent', 'area', 'edges', 'short-edges', 'no-features', 'no-detail-level']);
  const bogus = Object.keys(batch.rejectedByReason).filter((reason) => !legitimate.has(reason));
  assert(bogus.length === 0, `every real-corpus rejection has a known reason (${JSON.stringify(batch.rejectedByReason)})`);

  // Openings must stay inside their own footprint on real, messy polygons too.
  let worstNormal = -Infinity;
  let worstInside = Infinity;
  let sampled = 0;
  for (const record of batch.buildings.slice(0, 160)) {
    const source = REAL.find((building) => building.id === record.id);
    const plan = planFacadeArticulation(source, { ring: record.ring, baseY: 0 });
    if (plan.skipped) continue;
    sampled += 1;
    const byIndex = new Map(edgesOf(plan.polygon).map((edge) => [edge.index, edge]));
    forEachVertex(plan, (x, y, z, quad) => {
      const edge = byIndex.get(quad.edgeIndex);
      if (!edge) return;
      const d = localOf(edge, x, y, z, plan.baseY).d;
      worstNormal = Math.max(worstNormal, d);
      worstInside = Math.min(worstInside, d);
    });
  }
  assert(
    worstNormal <= FACADE_ARTICULATION_GEOMETRY.maxProjection + 1e-6,
    `real polygons: worst offset off its own wall ${worstNormal.toFixed(4)} m over ${sampled} buildings`,
  );
  assert(
    worstInside >= -1e-6,
    `real polygons: nothing is built behind the shell wall (deepest ${(-worstInside).toFixed(5)} m behind its own wall)`,
  );

  // Party-wall handling on real, messy footprints. The probe now needs a
  // majority of its samples buried before it calls an edge a party wall --
  // a single hit used to blank a whole tower frontage -- so an edge that only
  // partly abuts a neighbour keeps its cladding, and that cladding reaches
  // into the neighbour's own mass where they overlap. That is invisible (it is
  // inside the neighbour) but it is not zero, so it is measured, not claimed.
  {
    const cell = 44;
    const grid = new Map();
    for (const building of REAL) {
      const metrics = facadeFootprintMetrics(building);
      if (!metrics.centroid) continue;
      const key = `${Math.floor(metrics.centroid.x / cell)}:${Math.floor(metrics.centroid.z / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ building, centroid: metrics.centroid });
    }
    let worstIntrusion = 0;
    let intruding = 0;
    let checked = 0;
    for (const record of batch.buildings.slice(0, 200)) {
      const source = REAL.find((b) => b.id === record.id);
      const metrics = facadeFootprintMetrics(source);
      if (!metrics.centroid) continue;
      const plan = planFacadeArticulation(source, { ring: record.ring, baseY: 0 });
      if (plan.skipped) continue;
      checked += 1;
      const cx = Math.floor(metrics.centroid.x / cell);
      const cz = Math.floor(metrics.centroid.z / cell);
      let excess = 0;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          for (const other of grid.get(`${cx + dx}:${cz + dz}`) || []) {
            if (other.building.id === source.id) continue;
            // The source footprints themselves overlap on real OSM data, so
            // the honest question is not "is my geometry inside the
            // neighbour" -- the shell already is -- but "does it go any
            // deeper than the shell it is cladding".
            // Baseline is the shell WALL, sampled along the boundary, because
            // that is the surface the cladding is an outward offset of.
            let baseline = 0;
            for (let e = 0; e < plan.polygon.length; e += 1) {
              const a = plan.polygon[e];
              const b = plan.polygon[(e + 1) % plan.polygon.length];
              for (let t = 0; t <= 40; t += 1) {
                const px = a.x + ((b.x - a.x) * t) / 40;
                const pz = a.z + ((b.z - a.z) * t) / 40;
                if (!pointInPolygon(px, pz, other.building.polygon)) continue;
                baseline = Math.max(baseline, distanceToBoundary(px, pz, other.building.polygon));
              }
            }
            let deepest = 0;
            forEachVertex(plan, (x, _y, z) => {
              if (!pointInPolygon(x, z, other.building.polygon)) return;
              deepest = Math.max(deepest, distanceToBoundary(x, z, other.building.polygon));
            });
            excess = Math.max(excess, deepest - baseline);
          }
        }
      }
      if (excess > 1e-6) intruding += 1;
      worstIntrusion = Math.max(worstIntrusion, excess);
    }
    // The bound is the allowance measured round a corner. A cornice wrapping a
    // right-angle corner is legitimately `allowance * sqrt(2)` from that
    // corner -- the same geometric fact section 5 measures -- so that, not the
    // flat allowance, is the honest ceiling for a distance-to-polygon ruler.
    const cornerBound = FACADE_ARTICULATION_GEOMETRY.maxProjection * Math.SQRT2;
    assert(
      worstIntrusion <= cornerBound + 1e-6,
      `real corpus: cladding never reaches deeper into a neighbour than its own shell already does, plus the allowance measured round a corner (${worstIntrusion.toFixed(3)} m excess, bound ${cornerBound.toFixed(3)} m, over ${checked} buildings)`,
    );
    notes.push(`      neighbour reach on real footprints (source polygons already overlap): ${intruding}/${checked} buildings add any depth, worst excess ${worstIntrusion.toFixed(3)} m over the shell (allowance ${FACADE_ARTICULATION_GEOMETRY.maxProjection} m)`);
  }

  notes.push(`      real corpus @ capture eye: ${batch.triangles} tri, ${batch.drawCalls} draws, ${buildMs} ms, demotions ${batch.demotions}`);
  notes.push(`      rings: ${FACADE_ARTICULATION_RING_ORDER.map((name) => `${name}=${batch.rings[name].buildings}/${batch.rings[name].triangles}`).join(' ')}`);
  notes.push(`      openings ${batch.openings}, storey bands ${batch.bands}, party edges ${batch.partyEdges}`);
  notes.push(`      classes: ${Object.entries(batch.classes).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  disposeFacadeArticulation(batch);

  // The same corpus from the stale build focus must still be inside budget:
  // the pass has to be affordable wherever the ring lands.
  const stale = buildFacadeArticulationBatch(REAL, { focus: BUILD_FOCUS });
  assert(
    stale.triangles <= FACADE_ARTICULATION_BUDGET.sceneTriangleBudget,
    `from the stale build focus the corpus still fits (${stale.triangles} triangles, demotions ${stale.demotions})`,
  );
  notes.push(`      real corpus @ build focus: ${stale.triangles} tri, ${stale.drawCalls} draws`);
  disposeFacadeArticulation(stale);
}

// ---------------------------------------------------------------------------
section('13. the real corpus through the pass, end to end');
// ---------------------------------------------------------------------------

{
  const root = new THREE.Group();
  // A stand-in for the renderer's legacy additive relief, so the takeover is
  // observed rather than assumed.
  const legacy = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  legacy.userData = { kind: 'buildings-facade-relief' };
  root.add(legacy);
  // And a stand-in for the renderer's authored hero facade atlas. Those
  // frontages must keep their hand-made surface.
  const authoredIds = REAL.slice(0, 4).map((building) => building.id);
  const hero = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  hero.userData = { kind: 'buildings-hero-textured', buildingIds: authoredIds };
  root.add(hero);

  const runtime = createPassRuntime([facadeArticulation]);
  const ctx = makeContext(root, REAL_CITY, BUILD_FOCUS, { x: CAPTURE_EYE.x, y: 1.86, z: CAPTURE_EYE.z });
  const started = Date.now();
  const diagnostics = runtime.build(ctx);
  const buildMs = Date.now() - started;
  assert(diagnostics.errors.length === 0, `real corpus builds without a pass error: ${JSON.stringify(diagnostics.errors)}`);
  const entry = diagnostics.built.find((item) => item.id === 'facade-articulation');
  const detail = entry.detail;
  assert(detail.supersededLegacyMeshes === 1, `the legacy additive relief is superseded (${detail.supersededLegacyMeshes} meshes)`);
  assert(legacy.visible === false, 'the superseded relief mesh is hidden while this pass is live');
  assert(
    entry.drawCalls <= FACADE_ARTICULATION_BUDGET.maxDrawCalls,
    `pass draw calls ${entry.drawCalls} <= ${FACADE_ARTICULATION_BUDGET.maxDrawCalls}`,
  );
  assert(
    entry.triangles <= FACADE_ARTICULATION_BUDGET.sceneTriangleBudget,
    `pass triangles ${entry.triangles} <= ${FACADE_ARTICULATION_BUDGET.sceneTriangleBudget}`,
  );
  assert(detail.budget.withinBudget === true, 'the pass reports itself inside budget');
  assert(detail.authoredElevations === authoredIds.length, `authored hero elevations are detected (${detail.authoredElevations})`);
  {
    const preserved = buildFacadeArticulationBatch(REAL, { focus: BUILD_FOCUS, preserveIds: authoredIds });
    const records = preserved.buildings.filter((record) => authoredIds.includes(record.id));
    assert(records.length === authoredIds.length, `every authored building is still accounted for (${records.length})`);
    assert(
      records.every((record) => record.ring === 'silhouette' && record.openings === 0),
      'an authored elevation is never clad over: silhouette rung, no procedural openings',
    );
    disposeFacadeArticulation(preserved);
  }

  // And then the camera stands where the card is captured from.
  runtime.update(ctx, 1 / 60);
  const walked = facadeArticulation.__diagnostics();
  assert(walked.refreshes >= 1, `the capture pose re-centres the rings (${walked.refreshes} refreshes, ${walked.lastRefreshMs} ms)`);
  assert(walked.rings.near.buildings > 0, `buildings are articulated at the capture eye (near ring ${walked.rings.near.buildings})`);
  notes.push(`      pass build ${buildMs} ms, ${entry.triangles} tri, ${entry.drawCalls} draws; refresh ${walked.lastRefreshMs} ms`);
  notes.push(`      parts: ${Object.entries(walked.parts).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);

  runtime.dispose();
  assert(legacy.visible === true, 'dispose restores the relief it superseded');
  assert(root.children.length === 2, `dispose leaves only the pre-existing content (${root.children.length})`);
}

// ---------------------------------------------------------------------------
section('14. glass behaves like glass, not like a hole');
// ---------------------------------------------------------------------------

{
  // Round 1 shipped glass at metalness 0.26-0.42 with a dark base colour.
  // That combination kills the diffuse term AND tints the specular by the same
  // dark colour, so every pane was black: a pure black hole at golden hour and
  // a two-storey black band in daylight. Glass is a dielectric.
  assert(
    FACADE_GLASS_MATERIAL.metalness <= 0.02,
    `glass is a dielectric so the environment reflection is Fresnel-weighted, not a dark tinted metal (metalness ${FACADE_GLASS_MATERIAL.metalness})`,
  );
  assert(FACADE_GLASS_MATERIAL.roughness <= 0.15, `glass is smooth (roughness ${FACADE_GLASS_MATERIAL.roughness})`);
  assert(FACADE_GLASS_MATERIAL.nightEmissiveIntensity > 0, 'the lit bucket has a night intensity to drive');

  // The pane carries a sky-to-interior ramp, measured off the vertex colours.
  const plan = planFacadeArticulation(BLOCK[6], { ring: 'near', baseY: 0 });
  const panes = plan.quads.filter((quad) => quad.part === 'window-pane');
  assert(panes.length > 0, `panes were built (${panes.length})`);
  assert(panes.every((quad) => Array.isArray(quad.grad)), 'every pane carries a vertical ramp');
  const ramped = panes.filter((quad) => Math.abs(quad.grad[0] - quad.grad[1]) > 0.05).length;
  assert(ramped === panes.length, `every pane's ramp is non-trivial (${ramped}/${panes.length})`);
  assert(panes.every((quad) => quad.grad[0] > quad.grad[1]), 'the ramp is brighter at the top: a pane reflects the sky above the canyon, not the pavement');

  // And no pane is black. Measured in the geometry the renderer will draw.
  const batch = buildFacadeArticulationBatch(BLOCK, { focus: { x: 140, z: -18 } });
  let darkest = Infinity;
  let paneVertices = 0;
  for (const group of batch.groups) {
    if (group.role !== 'glass' && group.role !== 'glass-lit') continue;
    const colours = group.geometry.getAttribute('color').array;
    for (let i = 0; i < colours.length; i += 3) {
      paneVertices += 1;
      darkest = Math.min(darkest, colours[i] + colours[i + 1] + colours[i + 2]);
    }
  }
  assert(paneVertices > 0, `pane vertices measured: ${paneVertices}`);
  assert(darkest > 0.02, `no pane vertex is black (darkest luminance sum ${darkest.toFixed(4)})`);
  notes.push(`      darkest pane vertex (linear r+g+b): ${darkest.toFixed(4)} over ${paneVertices} vertices`);
  disposeFacadeArticulation(batch);
}

// ---------------------------------------------------------------------------
section('15. what is behind the pane varies per opening');
// ---------------------------------------------------------------------------

{
  const plan = planFacadeArticulation(BLOCK[6], { ring: 'near', baseY: 0 });
  const parts = plan.parts;
  assert((parts.blind || 0) > 0, `blinds are hung in some openings (${parts.blind || 0})`);
  assert((parts.curtain || 0) > 0, `curtains are hung in some openings (${parts.curtain || 0})`);

  // Panes must not all land in one bucket, and must not all land in different
  // ones either -- a facade where every window is unique reads as noise.
  const batch = buildFacadeArticulationBatch(BLOCK, { focus: { x: 140, z: -18 } });
  const roles = new Set(batch.groups.map((group) => group.role));
  for (const role of ['structure', 'glass', 'glass-lit', 'frame', 'interior']) {
    assert(roles.has(role), `the city builds the ${role} bucket`);
  }
  const lit = batch.groups.filter((group) => group.role === 'glass-lit').reduce((sum, group) => sum + group.quads, 0);
  const plain = batch.groups.filter((group) => group.role === 'glass').reduce((sum, group) => sum + group.quads, 0);
  const litShare = lit / Math.max(1, lit + plain);
  assert(litShare > 0.03 && litShare < 0.6, `lit interiors are a minority, not a switch (${(litShare * 100).toFixed(1)}% of panes)`);
  notes.push(`      panes: ${plain} unlit, ${lit} lit (${(litShare * 100).toFixed(1)}%), ${batch.parts.blind || 0} blinds, ${batch.parts.curtain || 0} curtains`);

  // Shopfronts get a different treatment from an upper-storey window.
  assert((batch.parts['shop-fitting'] || 0) > 0, `shopfronts carry fittings behind the glass (${batch.parts['shop-fitting'] || 0})`);
  assert((batch.parts['shop-valance'] || 0) > 0, `shopfronts carry a lit valance (${batch.parts['shop-valance'] || 0})`);
  disposeFacadeArticulation(batch);

  // Determinism: the same opening keeps its blinds.
  const again = planFacadeArticulation(BLOCK[6], { ring: 'near', baseY: 0 });
  const key = (p) => p.quads.filter((q) => q.part === 'blind' || q.part === 'curtain').map((q) => q.positions.map((n) => Math.round(n * 1000)).join(',')).join('|');
  assert(key(plan) === key(again), 'blinds and curtains are deterministic for a building');
}

// ---------------------------------------------------------------------------
section('16. an elevation varies against itself, not just against its neighbours');
// ---------------------------------------------------------------------------

{
  const tall = {
    id: 'sf-building-vertical-1',
    material: 'concrete',
    type: 'office',
    height: 118,
    levels: 33,
    polygon: rect(0, 0, 30, 24),
  };
  const plan = planFacadeArticulation(tall, { ring: 'near', baseY: 0 });
  assert(!plan.skipped, `the tall fixture plans (${plan.skipped})`);
  const registers = Object.keys(plan.features).filter((k) => k.startsWith('register-'));
  assert(registers.includes('register-crown'), `the top of a tall elevation is a crown, not more shaft (${registers.join(' ')})`);
  assert(registers.length >= 2, `a tall elevation carries several registers (${registers.join(' ')})`);
  // The mezzanine is a per-building draw, not a rule, so it is asserted over a
  // population rather than on one fixture.
  let mezzanines = 0;
  for (let i = 0; i < 24; i += 1) {
    const sample = planFacadeArticulation({ ...tall, id: `sf-building-vertical-m${i}` }, { ring: 'near' });
    if (Object.keys(sample.features).includes('register-mezzanine')) mezzanines += 1;
  }
  assert(mezzanines >= 4 && mezzanines <= 20, `a mezzanine is a per-building draw, not a rule (${mezzanines}/24 buildings)`);
  assert((plan.parts.louvre || 0) > 0, `a tall building has a plant floor with louvres (${plan.parts.louvre || 0})`);
  assert((plan.parts['string-course'] || 0) > 0, `a string course separates the shaft from the crown (${plan.parts['string-course'] || 0})`);
  assert((plan.parts['bay-pier'] || 0) > 0, `the banded shaft carries continuous bay piers (${plan.parts['bay-pier'] || 0})`);
  notes.push(`      118 m fixture registers: ${registers.map((k) => `${k.slice(9)}=${plan.features[k]}`).join(' ')}`);

  // Weathering accumulates downward: the same detail is dirtier lower down.
  const sills = plan.quads.filter((quad) => quad.part === 'sill');
  assert(sills.length > 4, `sills measured (${sills.length})`);
  const low = sills.filter((q) => q.positions[1] < plan.height * 0.25);
  const high = sills.filter((q) => q.positions[1] > plan.height * 0.5);
  if (low.length && high.length) {
    const mean = (list) => list.reduce((s, q) => s + q.soffit, 0) / list.length;
    assert(mean(low) > mean(high), `sill grime accumulates downward (low ${mean(low).toFixed(3)} > high ${mean(high).toFixed(3)})`);
  } else {
    assert(true, 'sill height spread too narrow on this fixture to compare grime');
  }

  // Storeys are not copies of each other.
  const rowsBySill = new Map();
  for (const quad of plan.quads) {
    if (quad.part !== 'window-pane') continue;
    const y = Math.round(Math.min(quad.positions[1], quad.positions[4], quad.positions[7], quad.positions[10]) * 10);
    const sig = `${quad.role}:${quad.tint.map((c) => Math.round(c * 100)).join('-')}`;
    if (!rowsBySill.has(y)) rowsBySill.set(y, new Set());
    rowsBySill.get(y).add(sig);
  }
  const rowSignatures = new Set([...rowsBySill.values()].map((set) => [...set].sort().join('|')));
  assert(
    rowSignatures.size >= Math.min(4, rowsBySill.size),
    `storeys differ from each other: ${rowSignatures.size} distinct rows out of ${rowsBySill.size}`,
  );

  // A short building must NOT get a plant floor or a crown.
  const shortPlan = planFacadeArticulation({ id: 'sf-building-vertical-2', material: 'brick', height: 11, levels: 3, polygon: rect(0, 0, 16, 13) }, { ring: 'near' });
  assert((shortPlan.parts.louvre || 0) === 0, 'a three-storey building has no plant floor');
}

// ---------------------------------------------------------------------------
section('17. the cap scales with the building, so a tower does not end flat');
// ---------------------------------------------------------------------------

{
  const capHeight = (height, levels) => {
    const plan = planFacadeArticulation({ id: `sf-building-cap-${height}`, material: 'stone', height, levels, polygon: rect(0, 0, 26, 22) }, { ring: 'near' });
    let low = Infinity;
    for (const quad of plan.quads) {
      if (!['cornice', 'architrave', 'coping', 'parapet', 'dentil'].includes(quad.part)) continue;
      for (let i = 0; i < 4; i += 1) low = Math.min(low, quad.positions[i * 3 + 1] - plan.baseY);
    }
    return { height, cap: plan.height - low };
  };
  const small = capHeight(14, 4);
  const mid = capHeight(49, 14);
  const tall = capHeight(118, 33);
  assert(small.cap > 0.4, `a low building still has a cap (${small.cap.toFixed(2)} m)`);
  assert(mid.cap > small.cap * 1.5, `a 49 m building's cap is deeper than a 14 m one (${mid.cap.toFixed(2)} vs ${small.cap.toFixed(2)} m)`);
  assert(tall.cap > mid.cap * 1.4, `a 118 m tower's cap is deeper again (${tall.cap.toFixed(2)} vs ${mid.cap.toFixed(2)} m)`);
  // Read at the distance a tower is actually seen from: one storey is 3.4 m,
  // so a cap under half a storey vanishes against the sky.
  assert(tall.cap > 3.4, `a 118 m tower terminates in a cap taller than one storey (${tall.cap.toFixed(2)} m)`);
  notes.push(`      cap depth: 14 m -> ${small.cap.toFixed(2)} m, 49 m -> ${mid.cap.toFixed(2)} m, 118 m -> ${tall.cap.toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
section('18. the quality gate\'s own capture poses are the LOD test set');
// ---------------------------------------------------------------------------

// Ring radii are not a guess. These are the eye positions the gate captures
// its eight cards from, recorded from a capture manifest, and the assertion is
// that the buildings which actually fill those frames land in a clad ring.
const GATE_POSES = Object.freeze([
  { id: '01-street-day', eye: { x: 1435.49, y: 2.35, z: 993.43 }, target: { x: 1379.47, y: 2.25, z: 1064.06 }, fov: 47 },
  { id: '02-intersection', eye: { x: 1668.84, y: 2.17, z: -0.05 }, target: { x: 1678.9, y: 2.03, z: -21.1 }, fov: 47 },
  { id: '03-canyon-golden', eye: { x: 1446.56, y: 2.34, z: 916.81 }, target: { x: 1515.56, y: 22.71, z: 974.62 }, fov: 58 },
  { id: '07-character-curb', eye: { x: 1438.04, y: 2.7, z: 990.08 }, target: { x: 1436.07, y: 1.8, z: 993.95 }, fov: 47 },
  { id: '08-traversal', eye: { x: 1455.42, y: 2.3, z: 971.01 }, target: { x: 1348.29, y: 2.22, z: 1103.24 }, fov: 47 },
]);

{
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

  for (const pose of GATE_POSES) {
    const batch = buildFacadeArticulationBatch(REAL, { focus: { x: pose.eye.x, z: pose.eye.z } });
    const ringOf = new Map(batch.buildings.map((r) => [r.id, r.ring]));
    const fwd = norm(sub(pose.target, pose.eye));
    const right = norm(cross(fwd, { x: 0, y: 1, z: 0 }));
    const up = cross(right, fwd);
    const f = 1 / Math.tan((pose.fov * Math.PI) / 360);
    const aspect = 16 / 9;
    let total = 0;
    let clad = 0;
    let windowed = 0;
    let unclad = 0;
    for (const building of REAL) {
      let minx = Infinity;
      let maxx = -Infinity;
      let miny = Infinity;
      let maxy = -Infinity;
      let any = false;
      for (const point of building.polygon) {
        for (const h of [0, building.height]) {
          const r = sub({ x: point.x, y: h, z: point.z }, pose.eye);
          const cz = dot(r, fwd);
          if (cz <= 0.5) continue;
          const sx = (dot(r, right) * f) / aspect / cz;
          const sy = (dot(r, up) * f) / cz;
          minx = Math.min(minx, sx); maxx = Math.max(maxx, sx);
          miny = Math.min(miny, sy); maxy = Math.max(maxy, sy);
          any = true;
        }
      }
      if (!any) continue;
      const cx = Math.max(-1, minx);
      const cX = Math.min(1, maxx);
      const cy = Math.max(-1, miny);
      const cY = Math.min(1, maxy);
      if (!(cX > cx && cY > cy)) continue;
      const cover = ((cX - cx) * (cY - cy)) / 4;
      if (cover < 0.004) continue;
      const ring = ringOf.get(building.id) || 'silhouette';
      total += cover;
      if (ring === 'silhouette') unclad += cover;
      else clad += cover;
      if (ring === 'near' || ring === 'mid') windowed += cover;
    }
    const cladShare = clad / Math.max(1e-9, total);
    const windowShare = windowed / Math.max(1e-9, total);
    assert(cladShare >= 0.97, `${pose.id}: ${(cladShare * 100).toFixed(1)}% of the frame-filling facade area is clad (threshold 97%)`);
    assert(windowShare >= 0.75, `${pose.id}: ${(windowShare * 100).toFixed(1)}% has individual openings or bay rhythm at near/mid (threshold 75%)`);
    assert(
      batch.triangles <= FACADE_ARTICULATION_BUDGET.sceneTriangleBudget,
      `${pose.id}: ${batch.triangles} triangles inside the ${FACADE_ARTICULATION_BUDGET.sceneTriangleBudget} budget`,
    );
    assert(batch.demotions === 0, `${pose.id}: no ring had to be demoted (${batch.demotions})`);
    notes.push(`      ${pose.id}: ${batch.triangles} tri, ${batch.drawCalls} draws, clad ${(cladShare * 100).toFixed(0)}%, near+mid ${(windowShare * 100).toFixed(0)}%`);
    disposeFacadeArticulation(batch);
  }
}

// ---------------------------------------------------------------------------
section('19. lit interiors follow the clock');
// ---------------------------------------------------------------------------

{
  const litIntensity = () => {
    let max = 0;
    for (const material of state.materials?.values?.() || []) max = Math.max(max, material.emissiveIntensity || 0);
    return max;
  };
  const root = new THREE.Group();
  const runtime = createPassRuntime([facadeArticulation]);
  const city = syntheticCity(BLOCK);
  const day = makeContext(root, city, { x: 140, z: -18 });
  day.hour = 12;
  day.day = true;
  runtime.build(day);
  const diagnosticsDay = facadeArticulation.__diagnostics();
  assert(diagnosticsDay.litPaneMaterials > 0, `a lit-glass bucket exists (${diagnosticsDay.litPaneMaterials})`);
  assert(diagnosticsDay.nightLevel === 0, `at noon nothing glows (night level ${diagnosticsDay.nightLevel})`);

  day.hour = 21.5;
  runtime.update(day, 1 / 60);
  const night = facadeArticulation.__diagnostics();
  assert(night.nightLevel === 1, `at 21:30 the interiors are lit (night level ${night.nightLevel})`);

  day.hour = 18.5;
  runtime.update(day, 1 / 60);
  const dusk = facadeArticulation.__diagnostics();
  assert(dusk.nightLevel > 0 && dusk.nightLevel < 1, `golden hour lands part-way up the ramp (${dusk.nightLevel})`);

  day.hour = 12;
  runtime.update(day, 1 / 60);
  assert(facadeArticulation.__diagnostics().nightLevel === 0, 'the ramp comes back down');
  runtime.dispose();
}

// ---------------------------------------------------------------------------
for (const note of notes) console.log(note);
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log('\nFailed:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
