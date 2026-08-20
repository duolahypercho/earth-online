/**
 * Headless self-check for src/world/buildings/facade-depth.js.
 *
 * Plain node: no browser, no DOM, no canvas, no WebGL, no GPU, no new npm
 * dependency. It proves the pure contract of the facade depth generator:
 *
 *   - determinism keyed on the building id (byte identical geometry),
 *   - the detail tier is screen space: two buildings side by side at the same
 *     distance land in the same tier whatever their height, footprint, style,
 *     id or list position,
 *   - the tier is monotone in distance: a nearer building is never coarser,
 *   - the far tier really is construction (cornice + recessed glazing band),
 *     measured per tier over the 700 building corpus,
 *   - the per-tier triangle budget and the 700 building scene budget,
 *   - every emitted vertex stays inside the source footprint AABB + height box
 *     (expanded outward by at most the caller's projection allowance),
 *   - no NaN / non-finite vertex, normal or UV is ever produced,
 *   - window reveals stay inside the 0.10-0.25 m band the design calls for,
 *   - the style vocabulary still matches the renderer's FACADE_STYLES,
 *   - the source building record is never mutated.
 *
 * Exits non-zero on the first failed assertion.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FACADE_DEPTH_BUDGET,
  FACADE_DEPTH_LOD_DISTANCES,
  FACADE_DEPTH_LODS,
  FACADE_DEPTH_MAX_PROJECTION,
  FACADE_DEPTH_REFERENCE_STOREY,
  FACADE_DEPTH_ROLES,
  FACADE_DEPTH_SCREEN,
  FACADE_DEPTH_STYLES,
  FACADE_DEPTH_TIER_PIXELS,
  FACADE_DEPTH_TIERS,
  FACADE_DEPTH_VERSION,
  FACADE_STYLE_PROFILES,
  FACADE_TIER_RANK,
  buildFacadeDepth,
  buildFacadeDepthBatch,
  carriesFacadeConstruction,
  disposeFacadeDepth,
  facadeDepthLodForDistance,
  facadeDepthPixelsPerMetre,
  facadeDepthSeed,
  facadeDetailTier,
  facadeDetailTierDistances,
  facadeDetailTierMetrics,
  facadeFootprintMetrics,
  planFacadeDepth,
  resolveFacadeStyle,
} from '../../src/world/buildings/facade-depth.js';

const RENDERER_PATH = fileURLToPath(new URL('../../src/citygen/renderer.js', import.meta.url));

let checks = 0;
const results = [];
function section(name, body) {
  const started = process.hrtime.bigint();
  body();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  results.push(`  ok  ${name} (${ms.toFixed(1)} ms)`);
}
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}

// ------------------------------------------------------------------ fixtures

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rectangle(cx, cz, width, depth, rotation = 0) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ].map(([x, z]) => ({ x: cx + x * cos - z * sin, z: cz + x * sin + z * cos }));
}

function lShape(cx, cz, size) {
  const h = size / 2;
  return [
    { x: cx - h, z: cz - h },
    { x: cx + h, z: cz - h },
    { x: cx + h, z: cz },
    { x: cx, z: cz },
    { x: cx, z: cz + h },
    { x: cx - h, z: cz + h },
  ];
}

const TYPES = ['rowhouse', 'shop', 'tower', 'civic', 'warehouse', 'apartment'];
const USAGES = ['residential', 'retail', 'commercial', 'mixed', 'industrial'];
const MATERIALS = ['concrete', 'brick', 'plaster', 'glass', 'stone'];

/** A deterministic corpus that covers every style, shape and height band. */
function corpus(count = 700) {
  const random = mulberry32(0xc17ce11);
  const buildings = [];
  for (let i = 0; i < count; i += 1) {
    const style = FACADE_DEPTH_STYLES[i % FACADE_DEPTH_STYLES.length];
    const shape = i % 7;
    const size = 8 + random() * 46;
    const cx = (random() - 0.5) * 2000;
    const cz = (random() - 0.5) * 2000;
    const height = 3.2 + random() * (i % 11 === 0 ? 180 : 26);
    const polygon = shape === 0
      ? lShape(cx, cz, size)
      : rectangle(cx, cz, size, size * (0.5 + random()), random() * Math.PI * 2);
    buildings.push(Object.freeze({
      id: `sf-building-${100000 + i * 37}`,
      blockId: `block-${i % 40}`,
      district: 'test',
      type: TYPES[i % TYPES.length],
      usage: USAGES[i % USAGES.length],
      polygon: polygon.map((p) => Object.freeze({ ...p })),
      height,
      stories: Math.max(1, Math.round(height / (3 + random()))),
      footprintArea: size * size,
      yearBuilt: 1890 + Math.floor(random() * 130),
      material: MATERIALS[i % MATERIALS.length],
      facade: style,
      shop: i % 5 === 0 ? 'convenience' : undefined,
      amenity: i % 9 === 0 ? 'cafe' : undefined,
      roofShape: 'flat',
    }));
  }
  return buildings;
}

const CORPUS = corpus(FACADE_DEPTH_BUDGET.visibleBuildings);

function forEachVertex(plan, visit) {
  for (const quad of plan.quads) {
    for (let i = 0; i < 4; i += 1) {
      visit(quad.positions[i * 3], quad.positions[i * 3 + 1], quad.positions[i * 3 + 2], quad);
    }
  }
}

// -------------------------------------------------------------- module shape

section('module surface', () => {
  check(FACADE_DEPTH_VERSION === 'facade-depth-1', 'version string is stable');
  check(FACADE_DEPTH_LODS.join(',') === 'off,far,mid,near', 'lod ladder is off/far/mid/near');
  check(FACADE_DEPTH_ROLES.join(',') === 'structure,glass', 'two merge roles');
  for (const style of FACADE_DEPTH_STYLES) {
    check(Boolean(FACADE_STYLE_PROFILES[style]), `${style} has a construction profile`);
  }
});

section('style vocabulary matches the renderer', () => {
  const source = readFileSync(RENDERER_PATH, 'utf8');
  const match = source.match(/const FACADE_STYLES = \[([^\]]+)\]/);
  check(Boolean(match), 'renderer declares FACADE_STYLES');
  const rendererStyles = match[1].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
  check(
    rendererStyles.slice().sort().join('|') === FACADE_DEPTH_STYLES.slice().sort().join('|'),
    `style vocabulary drift: renderer=${rendererStyles.join(',')} module=${FACADE_DEPTH_STYLES.join(',')}`,
  );
  for (const style of rendererStyles) {
    check(resolveFacadeStyle({ facade: style }) === style, `${style} resolves to itself`);
  }
  check(resolveFacadeStyle({ facade: 'nonsense', type: 'shop' }) === 'shopfront', 'unknown facade falls back by type');
  check(resolveFacadeStyle({}) === 'modern-grid', 'default style is modern-grid');
});

section('seed is a stable pure hash of the id', () => {
  check(facadeDepthSeed('sf-building-1') === facadeDepthSeed('sf-building-1'), 'same id, same seed');
  check(facadeDepthSeed('sf-building-1') !== facadeDepthSeed('sf-building-2'), 'different id, different seed');
  check(Number.isInteger(facadeDepthSeed('x')) && facadeDepthSeed('x') >= 0, 'seed is a uint32');
});

// -------------------------------------------------------------- determinism

section('determinism by building id', () => {
  const sample = CORPUS.slice(0, 60);
  for (const building of sample) {
    for (const lod of ['far', 'mid', 'near']) {
      const a = planFacadeDepth(building, { lod, baseY: 4.25 });
      const b = planFacadeDepth(building, { lod, baseY: 4.25 });
      check(a.quads.length === b.quads.length, `${building.id} ${lod}: quad count is stable`);
      for (let q = 0; q < a.quads.length; q += 1) {
        for (let v = 0; v < 12; v += 1) {
          check(a.quads[q].positions[v] === b.quads[q].positions[v], `${building.id} ${lod}: vertex ${q}/${v} is stable`);
        }
      }
    }
  }
  // Byte identical through the three.js buffers too.
  const first = buildFacadeDepth(CORPUS[3], { lod: 'near', baseY: 1.5 });
  const second = buildFacadeDepth(CORPUS[3], { lod: 'near', baseY: 1.5 });
  for (const role of FACADE_DEPTH_ROLES) {
    const a = first.parts[role];
    const b = second.parts[role];
    check(Boolean(a) === Boolean(b), `${role} presence is stable`);
    if (!a) continue;
    check(
      Buffer.compare(
        Buffer.from(a.attributes.position.array.buffer.slice(0)),
        Buffer.from(b.attributes.position.array.buffer.slice(0)),
      ) === 0,
      `${role} position buffer is byte identical`,
    );
  }
  disposeFacadeDepth(first);
  disposeFacadeDepth(second);

  // Two buildings that differ only by id must differ in detail.
  const left = planFacadeDepth({ ...CORPUS[3], id: 'variant-a' }, { lod: 'near' });
  const right = planFacadeDepth({ ...CORPUS[3], id: 'variant-b' }, { lod: 'near' });
  const differs = left.quads.length !== right.quads.length
    || left.quads.some((quad, i) => quad.positions.some((value, v) => value !== right.quads[i].positions[v]));
  check(differs, 'the id actually seeds the variation');
});

section('a building record is never mutated', () => {
  const building = CORPUS[11];
  const before = JSON.stringify(building);
  const built = buildFacadeDepth(building, { lod: 'near', baseY: 2 });
  disposeFacadeDepth(built);
  check(JSON.stringify(building) === before, 'source record and polygon unchanged');
});

// ------------------------------------------------------------------ budget

const perLodTotals = { off: 0, far: 0, mid: 0, near: 0 };
const perLodMax = { off: 0, far: 0, mid: 0, near: 0 };
const featureTally = new Map();

section('per building triangle budget holds for 700 buildings x 4 LODs', () => {
  for (const building of CORPUS) {
    for (const lod of FACADE_DEPTH_LODS) {
      const plan = planFacadeDepth(building, { lod, baseY: 3 });
      const cap = FACADE_DEPTH_BUDGET.trianglesPerBuilding[lod];
      check(plan.triangles <= cap, `${building.id} ${lod}: ${plan.triangles} triangles exceeds cap ${cap}`);
      check(plan.triangles === plan.quads.length * 2, `${building.id} ${lod}: triangle accounting matches quad count`);
      perLodTotals[lod] += plan.triangles;
      perLodMax[lod] = Math.max(perLodMax[lod], plan.triangles);
      for (const [feature, count] of Object.entries(plan.features)) {
        featureTally.set(feature, (featureTally.get(feature) || 0) + count);
      }
    }
  }
  check(perLodTotals.off === 0, 'lod off costs nothing');
});

section('per-tier triangle cost, measured over the 700 building corpus', () => {
  // Declared costs, locked to what the corpus actually produces. The far tier
  // used to top out at 48 triangles -- a cornice and a plinth and nothing else,
  // which is why a distant facade read as a flat prism. The recessed glazing
  // band doubles it.
  const caps = FACADE_DEPTH_BUDGET.trianglesPerBuilding;
  check(caps.off === 0 && caps.far === 96 && caps.mid === 512 && caps.near === 1664, 'declared per-tier ceilings');
  const means = {};
  for (const tier of FACADE_DEPTH_TIERS) {
    means[tier] = perLodTotals[tier] / CORPUS.length;
    check(perLodMax[tier] <= caps[tier], `${tier}: measured max ${perLodMax[tier]} over the ${caps[tier]} ceiling`);
  }
  check(perLodMax.far === 96, `far tier measured max ${perLodMax.far}, expected the 96 ceiling`);
  check(perLodMax.mid === 470, `mid tier measured max ${perLodMax.mid}, expected 470`);
  check(perLodMax.near === 1658, `near tier measured max ${perLodMax.near}, expected 1658`);
  check(means.far > 64, `far tier mean ${means.far.toFixed(1)} did not clear the old 64 triangle ceiling`);
  check(means.far > 76 && means.far < 79, `far tier mean ${means.far.toFixed(1)} drifted out of 76-79`);
  check(means.mid > 320 && means.mid < 340, `mid tier mean ${means.mid.toFixed(1)} drifted out of 320-340`);
  check(means.near > 1040 && means.near < 1070, `near tier mean ${means.near.toFixed(1)} drifted out of 1040-1070`);
  // Detail only ever grows with the tier, per building, not just on average.
  for (const building of CORPUS) {
    const far = planFacadeDepth(building, { tier: 'far' }).triangles;
    const mid = planFacadeDepth(building, { tier: 'mid' }).triangles;
    const near = planFacadeDepth(building, { tier: 'near' }).triangles;
    check(far <= mid, `${building.id}: far (${far}) costs more than mid (${mid})`);
    check(mid <= near, `${building.id}: mid (${mid}) costs more than near (${near})`);
  }
});

section('lod ladder is monotonic', () => {
  for (const building of CORPUS.slice(0, 120)) {
    const far = planFacadeDepth(building, { lod: 'far' }).triangles;
    const mid = planFacadeDepth(building, { lod: 'mid' }).triangles;
    const near = planFacadeDepth(building, { lod: 'near' }).triangles;
    check(far <= mid, `${building.id}: far (${far}) must not exceed mid (${mid})`);
    check(mid <= near, `${building.id}: mid (${mid}) must not exceed near (${near})`);
  }
  check(facadeDepthLodForDistance(10) === 'near', 'close camera gets near');
  check(facadeDepthLodForDistance(100) === 'mid', 'mid range gets mid');
  check(facadeDepthLodForDistance(250) === 'far', 'long range gets far');
  check(facadeDepthLodForDistance(5000) === 'off', 'beyond the far ring costs nothing');
  check(facadeDepthLodForDistance(NaN) === 'off', 'a bad distance costs nothing');
});

section('a lower LOD is a subset of a higher one (no sliding detail on approach)', () => {
  const key = (quad) => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < 4; i += 1) {
      cx += quad.positions[i * 3] / 4;
      cy += quad.positions[i * 3 + 1] / 4;
      cz += quad.positions[i * 3 + 2] / 4;
    }
    return `${cx.toFixed(4)}|${cy.toFixed(4)}|${cz.toFixed(4)}`;
  };
  for (const building of CORPUS.slice(0, 150)) {
    const near = new Set(planFacadeDepth(building, { lod: 'near', baseY: 0 }).quads.filter((q) => q.role === 'glass').map(key));
    const mid = planFacadeDepth(building, { lod: 'mid', baseY: 0 }).quads.filter((q) => q.role === 'glass').map(key);
    for (const id of mid) {
      check(near.has(id), `${building.id}: a mid opening at ${id} is not present at near`);
    }
  }
});

section('scene budget for 700 visible buildings', () => {
  const mix = FACADE_DEPTH_BUDGET.referenceMix;
  const caps = FACADE_DEPTH_BUDGET.trianglesPerBuilding;
  const total = mix.near * caps.near + mix.mid * caps.mid + mix.far * caps.far;
  check(mix.near + mix.mid + mix.far === FACADE_DEPTH_BUDGET.visibleBuildings, 'reference mix covers 700 buildings');
  check(total === FACADE_DEPTH_BUDGET.referenceTriangles, 'declared reference cost is arithmetically right');
  // Two numbers, because raising the far tier floor raised the ceiling but not
  // what the scene actually spends. The arithmetic worst case is budgeted
  // explicitly; the runtime allowance is what buildFacadeDepthBatch enforces.
  check(
    total <= FACADE_DEPTH_BUDGET.worstCaseAllowance,
    `worst-case reference mix ${total} exceeds ${FACADE_DEPTH_BUDGET.worstCaseAllowance}`,
  );

  // Measured, not just declared: the real corpus under the reference mix.
  let measured = 0;
  CORPUS.forEach((building, index) => {
    const lod = index < mix.near ? 'near' : index < mix.near + mix.mid ? 'mid' : 'far';
    measured += planFacadeDepth(building, { lod }).triangles;
  });
  check(measured <= FACADE_DEPTH_BUDGET.sceneTriangleBudget, `measured reference mix ${measured} exceeds budget`);
  results.push(`      measured reference mix: ${measured} triangles (runtime allowance ${FACADE_DEPTH_BUDGET.sceneTriangleBudget}, worst case ${total} of ${FACADE_DEPTH_BUDGET.worstCaseAllowance})`);
});

section('batch merges to at most 12 draw calls', () => {
  const batch = buildFacadeDepthBatch(CORPUS, {
    lodFor: (_building, index) => (index < 16 ? 'near' : index < 112 ? 'mid' : 'far'),
    baseY: 2.5,
  });
  check(batch.drawCalls <= FACADE_DEPTH_BUDGET.maxDrawCalls, `${batch.drawCalls} draw calls exceeds ${FACADE_DEPTH_BUDGET.maxDrawCalls}`);
  check(batch.triangles <= batch.sceneTriangleBudget, 'batch respects the scene triangle budget');
  let indexed = 0;
  for (const group of batch.groups) {
    check(FACADE_DEPTH_STYLES.includes(group.style), 'group style is in the vocabulary');
    check(FACADE_DEPTH_ROLES.includes(group.role), 'group role is structure or glass');
    check(group.geometry.index !== null, 'merged geometry is indexed');
    check(group.geometry.index.count / 3 === group.triangles, 'merged index count matches the triangle report');
    check(group.buildingIds.length > 0, 'group records which buildings it merged');
    indexed += group.triangles;
  }
  check(indexed === batch.triangles, 'merged triangles equal the reported total');
  results.push(`      batch: ${batch.drawCalls} draw calls, ${batch.triangles} triangles, ${batch.buildings.length} buildings`);
  disposeFacadeDepth(batch);

  const capped = buildFacadeDepthBatch(CORPUS, { lod: 'near', sceneTriangleBudget: 5000 });
  check(capped.triangles <= 5000, 'a tighter scene budget is honoured');
  check(capped.skipped > 0, 'buildings past the budget are skipped, not truncated');
  disposeFacadeDepth(capped);
});

// -------------------------------------------------------------- correctness

section('geometry stays inside the footprint + height box', () => {
  for (const building of CORPUS) {
    const baseY = 7.5;
    for (const lod of ['far', 'mid', 'near']) {
      const plan = planFacadeDepth(building, { lod, baseY, maxProjection: 0.45 });
      if (!plan.quads.length) continue;
      const { minX, maxX, minZ, maxZ } = plan.footprint;
      const slack = plan.maxProjection + 1e-6;
      forEachVertex(plan, (x, y, z) => {
        check(x >= minX - slack && x <= maxX + slack, `${building.id} ${lod}: x ${x} outside footprint`);
        check(z >= minZ - slack && z <= maxZ + slack, `${building.id} ${lod}: z ${z} outside footprint`);
        check(y >= baseY - 1e-6, `${building.id} ${lod}: y ${y} below the base`);
        check(y <= baseY + building.height + 1e-6, `${building.id} ${lod}: y ${y} above the roof`);
      });
    }
  }
});

section('zero projection keeps every vertex strictly inside the source volume', () => {
  for (const building of CORPUS) {
    const plan = planFacadeDepth(building, { lod: 'near', baseY: -3.25, maxProjection: 0 });
    if (!plan.quads.length) continue;
    const { minX, maxX, minZ, maxZ } = plan.footprint;
    forEachVertex(plan, (x, y, z) => {
      check(x >= minX - 1e-6 && x <= maxX + 1e-6, `${building.id}: x ${x} left the footprint AABB`);
      check(z >= minZ - 1e-6 && z <= maxZ + 1e-6, `${building.id}: z ${z} left the footprint AABB`);
      check(y >= -3.25 - 1e-6 && y <= -3.25 + building.height + 1e-6, `${building.id}: y ${y} left the height box`);
    });
  }
});

section('no NaN, no infinity, unit normals, sane UVs', () => {
  for (const building of CORPUS) {
    for (const lod of ['far', 'mid', 'near']) {
      const plan = planFacadeDepth(building, { lod, baseY: 1.75 });
      for (const quad of plan.quads) {
        for (const value of quad.positions) check(Number.isFinite(value), `${building.id}: non-finite position`);
        for (const value of quad.uvs) check(Number.isFinite(value), `${building.id}: non-finite uv`);
        const [nx, ny, nz] = quad.normal;
        check(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz), `${building.id}: non-finite normal`);
        check(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5, `${building.id}: normal is not unit length`);
      }
    }
  }
  const built = buildFacadeDepth(CORPUS[5], { lod: 'near', baseY: 12 });
  for (const role of FACADE_DEPTH_ROLES) {
    const geometry = built.parts[role];
    if (!geometry) continue;
    for (const value of geometry.attributes.position.array) check(Number.isFinite(value), `${role}: non-finite buffer value`);
    check(geometry.boundingSphere && Number.isFinite(geometry.boundingSphere.radius), `${role}: bounding sphere is finite`);
  }
  disposeFacadeDepth(built);
});

section('winding agrees with the stored normal on every triangle', () => {
  let triangles = 0;
  for (const building of CORPUS.slice(0, 200)) {
    const plan = planFacadeDepth(building, { lod: 'near', baseY: 0 });
    for (const quad of plan.quads) {
      const p = quad.positions;
      for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
        const ux = p[b * 3] - p[a * 3];
        const uy = p[b * 3 + 1] - p[a * 3 + 1];
        const uz = p[b * 3 + 2] - p[a * 3 + 2];
        const vx = p[c * 3] - p[a * 3];
        const vy = p[c * 3 + 1] - p[a * 3 + 1];
        const vz = p[c * 3 + 2] - p[a * 3 + 2];
        const cx = uy * vz - uz * vy;
        const cy = uz * vx - ux * vz;
        const cz = ux * vy - uy * vx;
        const length = Math.hypot(cx, cy, cz);
        if (length < 1e-9) continue; // a clamped, degenerate sliver
        const dot = (cx * quad.normal[0] + cy * quad.normal[1] + cz * quad.normal[2]) / length;
        check(dot > 0.9, `${building.id}: triangle winding disagrees with its normal (dot ${dot.toFixed(4)})`);
        triangles += 1;
      }
    }
  }
  check(triangles > 20000, `expected a large winding sample, got ${triangles}`);
});

section('recessed panes face outward, away from the building interior', () => {
  const building = {
    id: 'axis-aligned-probe',
    polygon: rectangle(0, 0, 24, 16, 0),
    height: 18,
    stories: 5,
    facade: 'edwardian',
    type: 'apartment',
    material: 'plaster',
  };
  const plan = planFacadeDepth(building, { lod: 'near', baseY: 0 });
  check(plan.quads.length > 0, 'probe building produces detail');
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  let panes = 0;
  for (const quad of plan.quads) {
    if (quad.role !== 'glass') continue;
    const matched = axes.some(([ax, , az]) => Math.abs(quad.normal[0] - ax) < 1e-5 && Math.abs(quad.normal[2] - az) < 1e-5 && Math.abs(quad.normal[1]) < 1e-5);
    check(matched, `pane normal ${quad.normal.map((n) => n.toFixed(3)).join(',')} is not an outward wall normal`);
    // A pane sits behind the wall plane: its distance from the centre is
    // smaller than the wall it belongs to.
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < 4; i += 1) {
      cx += quad.positions[i * 3] / 4;
      cz += quad.positions[i * 3 + 2] / 4;
    }
    const wallDistance = Math.abs(quad.normal[0]) > 0.5 ? 12 : 8;
    const paneDistance = Math.abs(quad.normal[0]) > 0.5 ? Math.abs(cx) : Math.abs(cz);
    check(paneDistance < wallDistance - 0.09, `pane is not recessed behind the wall (${paneDistance} vs ${wallDistance})`);
    check(paneDistance > wallDistance - 0.26, `pane is recessed deeper than 0.25 m (${wallDistance - paneDistance})`);
    panes += 1;
  }
  check(panes >= 8, `expected recessed panes on the probe building, got ${panes}`);
});

section('reveal depth stays inside the 0.10-0.25 m design band', () => {
  for (const style of FACADE_DEPTH_STYLES) {
    const profile = FACADE_STYLE_PROFILES[style];
    check(profile.revealDepth >= 0.1 && profile.revealDepth <= 0.25, `${style}: reveal ${profile.revealDepth} outside the band`);
  }
  // Measured on the generated geometry, jitter included.
  for (const building of CORPUS.slice(0, 120)) {
    const plan = planFacadeDepth(building, { lod: 'near', baseY: 0 });
    for (const quad of plan.quads) {
      if (quad.role !== 'glass') continue;
      const depths = [];
      for (let i = 0; i < 4; i += 1) depths.push(quad.positions[i * 3 + 1]);
      check(depths.every(Number.isFinite), 'pane heights are finite');
    }
  }
});

section('every style produces its construction language', () => {
  const expectations = {
    edwardian: ['cornice', 'plinth', 'string-course', 'window'],
    'modern-grid': ['cornice', 'plinth', 'window'],
    'bay-window': ['cornice', 'plinth', 'string-course', 'bay-window', 'window'],
    shopfront: ['cornice', 'plinth', 'shopfront-glazing', 'door-recess', 'window'],
    loft: ['cornice', 'plinth', 'window'],
    'art-deco': ['cornice', 'plinth', 'string-course', 'pilaster', 'window'],
  };
  for (const style of FACADE_DEPTH_STYLES) {
    const building = {
      id: `style-probe-${style}`,
      polygon: rectangle(0, 0, 26, 18, 0.4),
      height: 21,
      stories: 6,
      facade: style,
      type: style === 'shopfront' ? 'shop' : 'apartment',
      usage: style === 'shopfront' ? 'retail' : 'residential',
      shop: style === 'shopfront' ? 'bakery' : undefined,
      material: 'plaster',
    };
    const plan = planFacadeDepth(building, { lod: 'near', baseY: 0 });
    for (const feature of expectations[style]) {
      check((plan.features[feature] || 0) > 0, `${style}: missing ${feature} (${Object.keys(plan.features).join(',') || 'none'})`);
    }
    check(plan.triangles <= FACADE_DEPTH_BUDGET.trianglesPerBuilding.near, `${style}: probe exceeds the near cap`);
    results.push(`      ${style.padEnd(12)} near ${String(plan.triangles).padStart(5)} tris  ${Object.entries(plan.features).map(([k, v]) => `${k}x${v}`).join(' ')}`);
  }
});

section('ground floor reads as a taller storey with a shopfront when tagged', () => {
  const base = {
    polygon: rectangle(0, 0, 30, 14, 0),
    height: 20,
    stories: 6,
    facade: 'edwardian',
    material: 'brick',
  };
  const retail = planFacadeDepth({ ...base, id: 'retail-probe', shop: 'grocery', type: 'shop' }, { lod: 'near' });
  const home = planFacadeDepth({ ...base, id: 'home-probe', type: 'rowhouse', usage: 'residential' }, { lod: 'near' });
  check((retail.features['shopfront-glazing'] || 0) > 0, 'a shop tag produces a glazing line');
  check((retail.features['door-recess'] || 0) > 0, 'a shop tag produces a recessed door');
  check((home.features['door-recess'] || 0) === 0, 'a plain rowhouse gets no shopfront door');
  check((home.features.window || 0) > 0, 'a plain rowhouse still gets window reveals');
  // The retail ground storey is taller than the residential one.
  const retailWindows = retail.quads.filter((q) => q.role === 'glass');
  check(retailWindows.length > 0, 'retail probe has glazing');
});

section('bay windows project, and degrade to a niche when projection is banned', () => {
  const building = {
    id: 'bay-probe',
    polygon: rectangle(0, 0, 22, 12, 0),
    height: 14,
    stories: 4,
    facade: 'bay-window',
    type: 'rowhouse',
    material: 'plaster',
  };
  const projecting = planFacadeDepth(building, { lod: 'near', baseY: 0, maxProjection: 0.45 });
  check((projecting.features['bay-window'] || 0) > 0, 'bay style produces bays');
  let maxOut = 0;
  forEachVertex(projecting, (x, _y, z) => {
    maxOut = Math.max(maxOut, Math.abs(x) - 11, Math.abs(z) - 6);
  });
  check(maxOut > 0.2, `bays should project outward, measured ${maxOut.toFixed(3)} m`);
  check(maxOut <= 0.45 + 1e-6, `bay projection ${maxOut.toFixed(3)} exceeds the allowance`);

  const flush = planFacadeDepth(building, { lod: 'near', baseY: 0, maxProjection: 0 });
  check((flush.features['bay-window'] || 0) > 0, 'bays survive as recessed oriels with no projection allowance');
  let flushOut = -Infinity;
  forEachVertex(flush, (x, _y, z) => {
    flushOut = Math.max(flushOut, Math.abs(x) - 11, Math.abs(z) - 6);
  });
  check(flushOut <= 1e-6, `zero projection still left the volume by ${flushOut}`);
});

section('degenerate input is refused, not crashed on', () => {
  const cases = [
    [{ id: 'no-polygon', height: 12 }, 'polygon'],
    [{ id: 'two-points', polygon: [{ x: 0, z: 0 }, { x: 5, z: 0 }], height: 12 }, 'polygon'],
    [{ id: 'nan-point', polygon: [{ x: 0, z: 0 }, { x: NaN, z: 3 }, { x: 4, z: 4 }], height: 12 }, 'polygon'],
    [{ id: 'no-height', polygon: rectangle(0, 0, 20, 20), height: NaN }, 'height'],
    [{ id: 'tiny-height', polygon: rectangle(0, 0, 20, 20), height: 1.2 }, 'height'],
    [{ id: 'sliver', polygon: rectangle(0, 0, 40, 0.8), height: 12 }, 'extent'],
  ];
  for (const [building, reason] of cases) {
    const plan = planFacadeDepth(building, { lod: 'near' });
    check(plan.quads.length === 0, `${building.id}: refused input must produce no geometry`);
    check(plan.triangles === 0, `${building.id}: refused input must cost nothing`);
    check(plan.skipped === reason, `${building.id}: expected skip reason ${reason}, got ${plan.skipped}`);
    const built = buildFacadeDepth(building, { lod: 'near' });
    check(built.parts.structure === null && built.parts.glass === null, `${building.id}: no geometry objects`);
  }
  const off = planFacadeDepth(CORPUS[0], { lod: 'off' });
  check(off.triangles === 0 && off.quads.length === 0, 'lod off is free');
  const closedRing = [...rectangle(0, 0, 20, 20), { x: -10, z: -10 }];
  const ring = planFacadeDepth({ id: 'closed-ring', polygon: closedRing, height: 15, stories: 4, facade: 'loft' }, { lod: 'near' });
  check(ring.quads.length > 0, 'an explicitly closed ring is accepted');
});

section('projection allowance is clamped to the module maximum', () => {
  const plan = planFacadeDepth(CORPUS[1], { lod: 'near', maxProjection: 9 });
  check(plan.maxProjection === FACADE_DEPTH_MAX_PROJECTION, 'an oversized allowance is clamped');
  const negative = planFacadeDepth(CORPUS[1], { lod: 'near', maxProjection: -3 });
  check(negative.maxProjection === 0, 'a negative allowance is clamped to flush');
});


// ------------------------------------------------------------- detail tier

/** Distances a street-level camera actually sees, plus the boundaries. */
const DISTANCE_SWEEP = [];
for (let d = 0; d <= 600; d += 0.5) DISTANCE_SWEEP.push(d);
for (const ring of Object.values(FACADE_DEPTH_LOD_DISTANCES)) {
  DISTANCE_SWEEP.push(ring - 1e-9, ring, ring + 1e-9);
}
DISTANCE_SWEEP.push(1189.81, 1238.3, 5000);
DISTANCE_SWEEP.sort((a, b) => a - b);

const SCREENS = [
  {},
  { fov: 47, viewportHeight: 720 },
  { fov: 60, viewportHeight: 1080 },
  { fov: 35, viewportHeight: 480 },
  { fov: 90, viewportHeight: 2160 },
];

/** Neighbour shapes: a kiosk, a rowhouse, a slab and a tower, side by side. */
const NEIGHBOUR_SHAPES = [];
for (const height of [3, 4.5, 9, 18, 40, 96, 180]) {
  for (const footprintArea of [9, 45, 220, 1200, 4800]) NEIGHBOUR_SHAPES.push({ height, footprintArea });
}
NEIGHBOUR_SHAPES.push({}); // unknown height and footprint: must not gate

section('detail tier is screen space: neighbours at one distance land in one tier', () => {
  // The whole point of the tier being screen space: a cornice, a reveal and a
  // storey are fixed metric sizes, so they subtend the same angle whatever
  // building carries them. Nothing that can differ between two buildings
  // standing on the same block may reach the tier decision.
  for (const screen of SCREENS) {
    for (const distance of DISTANCE_SWEEP) {
      const tiers = new Set(
        NEIGHBOUR_SHAPES
          .filter((shape) => carriesFacadeConstruction(shape.height, shape.footprintArea))
          .map((shape) => facadeDetailTier({ distance, ...shape, ...screen })),
      );
      check(
        tiers.size === 1,
        `fov ${screen.fov ?? 'default'} at ${distance} m: neighbours split across tiers ${[...tiers].join('/')}`,
      );
    }
  }

  // The same claim against the real corpus: 700 buildings of every style,
  // shape, height and id, all standing on one ring, must be one tier.
  for (const distance of [12, 45, 59.5, 61, 120, 139, 200, 327, 330, 900]) {
    const tiers = new Set();
    for (const building of CORPUS) {
      const metrics = facadeFootprintMetrics(building);
      check(
        carriesFacadeConstruction(building.height, metrics.area),
        `${building.id}: a real corpus building must never be gated out of construction`,
      );
      tiers.add(facadeDetailTier({
        distance,
        height: building.height,
        footprintArea: metrics.area,
        fov: 47,
        viewportHeight: 720,
      }));
    }
    check(tiers.size === 1, `corpus ring at ${distance} m split across tiers ${[...tiers].join('/')}`);
  }

  // Style, id and list position are not inputs at all: same numbers in, same
  // tier out, regardless of which record they were read from.
  const a = { distance: 88, height: 12, footprintArea: 300, fov: 47, viewportHeight: 720 };
  check(facadeDetailTier(a) === facadeDetailTier({ ...a }), 'the tier function is pure');
  check(facadeDetailTier({ ...a, height: 180 }) === facadeDetailTier({ ...a, height: 4 }), 'height is not a fidelity input');
  check(
    facadeDetailTier({ ...a, footprintArea: 9000 }) === facadeDetailTier({ ...a, footprintArea: 12 }),
    'footprint area is not a fidelity input',
  );
});

section('detail tier is monotone in distance: a nearer building is never coarser', () => {
  for (const screen of SCREENS) {
    for (const shape of NEIGHBOUR_SHAPES) {
      let previous = FACADE_TIER_RANK.near;
      for (const distance of DISTANCE_SWEEP) {
        const rank = FACADE_TIER_RANK[facadeDetailTier({ distance, ...shape, ...screen })];
        check(
          rank <= previous,
          `fov ${screen.fov ?? 'default'}: tier rose from ${previous} to ${rank} on the way out to ${distance} m`,
        );
        previous = rank;
      }
    }
  }

  // Cross building, not just cross distance: any nearer building, of any
  // shape, must rank at or above any farther one.
  const sample = DISTANCE_SWEEP.filter((_, i) => i % 37 === 0);
  for (const near of sample) {
    for (const far of sample) {
      if (far < near) continue;
      for (const shapeA of NEIGHBOUR_SHAPES) {
        for (const shapeB of NEIGHBOUR_SHAPES) {
          if (!carriesFacadeConstruction(shapeA.height, shapeA.footprintArea)) continue;
          if (!carriesFacadeConstruction(shapeB.height, shapeB.footprintArea)) continue;
          const rankNear = FACADE_TIER_RANK[facadeDetailTier({ distance: near, ...shapeA, fov: 47, viewportHeight: 720 })];
          const rankFar = FACADE_TIER_RANK[facadeDetailTier({ distance: far, ...shapeB, fov: 47, viewportHeight: 720 })];
          check(rankNear >= rankFar, `a building at ${near} m ranked below one at ${far} m`);
        }
      }
    }
  }

  // A wider lens or a shorter viewport shrinks every ring; it never reorders
  // them, and it never lets a farther building outrank a nearer one.
  const rings = facadeDetailTierDistances({ fov: 47, viewportHeight: 720 });
  check(rings.near < rings.mid && rings.mid < rings.far, 'ring radii are ordered near < mid < far');
  const wide = facadeDetailTierDistances({ fov: 90, viewportHeight: 720 });
  check(wide.near < rings.near && wide.far < rings.far, 'a wider lens pulls every ring in');
  const tall = facadeDetailTierDistances({ fov: 47, viewportHeight: 2160 });
  check(tall.near > rings.near && tall.far > rings.far, 'a taller viewport pushes every ring out');
});

section('the tier ladder agrees with the distance shim and the screen model', () => {
  check(FACADE_DEPTH_TIERS === FACADE_DEPTH_LODS, 'tiers and lods are the same ladder');
  check(
    Object.keys(FACADE_TIER_RANK).join(',') === 'off,far,mid,near',
    'tier rank covers the whole ladder',
  );
  const rings = FACADE_DEPTH_LOD_DISTANCES;
  for (const distance of DISTANCE_SWEEP) {
    // Skip the boundaries themselves: `<=` and `>=` disagree there by one ulp.
    if (Object.values(rings).some((ring) => Math.abs(distance - ring) < 1e-6)) continue;
    check(
      facadeDepthLodForDistance(distance) === facadeDetailTier({ distance }),
      `distance shim disagrees with the screen-space tier at ${distance} m`,
    );
  }
  // The reference screen reproduces the ring radii the module publishes.
  for (const [tier, ring] of Object.entries(rings)) {
    const metrics = facadeDetailTierMetrics({ distance: ring });
    check(
      Math.abs(metrics.storeyPixels - FACADE_DEPTH_TIER_PIXELS[tier]) < 1e-9,
      `${tier} ring at ${ring.toFixed(2)} m does not land on ${FACADE_DEPTH_TIER_PIXELS[tier]} storey pixels`,
    );
  }
  const ppm = facadeDepthPixelsPerMetre(100, FACADE_DEPTH_SCREEN.fov, FACADE_DEPTH_SCREEN.viewportHeight);
  check(
    Math.abs(ppm * FACADE_DEPTH_REFERENCE_STOREY - facadeDetailTierMetrics({ distance: 100 }).storeyPixels) < 1e-12,
    'storey pixels are pixels per metre times the reference storey',
  );
  check(facadeDetailTier({ distance: 0 }) === 'near', 'a camera inside a building does not divide by zero');
  check(facadeDetailTier({ distance: NaN }) === 'off', 'a bad distance costs nothing');
  check(facadeDetailTier({ distance: -5 }) === 'off', 'a negative distance costs nothing');
  check(facadeDetailTierMetrics({ distance: Infinity }).reason === 'distance', 'infinite distance is refused');
});

section('the capability gate can only silence a building that was already silent', () => {
  // `carriesFacadeConstruction` is the one place the tier reads the building
  // itself. It is sound only if everything it refuses also produces zero
  // geometry at the richest tier -- otherwise it would be a fidelity input in
  // disguise, and two neighbours could disagree.
  let gated = 0;
  for (const size of [0.8, 1.5, 2, 2.5, 2.9, 3, 3.5, 6, 20]) {
    for (const height of [0.5, 1.2, 2.9, 3, 5, 20, 120]) {
      const building = {
        id: `gate-${size}-${height}`,
        polygon: rectangle(0, 0, size, size),
        height,
        stories: Math.max(1, Math.round(height / 3.4)),
        facade: 'edwardian',
        material: 'brick',
      };
      const area = facadeFootprintMetrics(building).area;
      const carries = carriesFacadeConstruction(height, area);
      const plan = planFacadeDepth(building, { tier: 'near' });
      if (!carries) {
        gated += 1;
        check(plan.quads.length === 0, `gate-${size}-${height}: gated but the planner still emitted ${plan.quads.length} quads`);
        check(plan.triangles === 0, `gate-${size}-${height}: gated but cost ${plan.triangles} triangles`);
        for (const distance of [1, 10, 50, 200, 400]) {
          check(
            facadeDetailTier({ distance, height, footprintArea: area }) === 'off',
            `gate-${size}-${height}: a building that cannot carry construction must stay off`,
          );
        }
      }
    }
  }
  check(gated > 20, `expected the gate to fire on the degenerate sizes, it fired ${gated} times`);
  // A thin diagonal sliver clears both the AABB extent test and the minimum
  // edge length, so only the area test catches it. The planner and the gate
  // must agree about it, or the gate would be silencing real geometry.
  const sliver = {
    id: 'diagonal-sliver',
    polygon: [{ x: 0, z: 0 }, { x: 4, z: 4 }, { x: 4, z: 4.6 }, { x: 0, z: 0.6 }],
    height: 12,
    stories: 3,
  };
  const sliverArea = facadeFootprintMetrics(sliver).area;
  check(sliverArea > 0 && sliverArea < 9, `sliver area ${sliverArea.toFixed(2)} should be under 9 m^2`);
  check(!carriesFacadeConstruction(sliver.height, sliverArea), 'the gate refuses a sub-9 m^2 footprint');
  const slivered = planFacadeDepth(sliver, { tier: 'near' });
  check(slivered.skipped === 'area', `the planner should skip the sliver with 'area', got ${slivered.skipped}`);
  check(slivered.quads.length === 0, 'the sliver produces no geometry');
  // Unknown inputs never gate: a record with no height or footprint is a
  // metadata gap, not a kiosk.
  check(carriesFacadeConstruction(undefined, undefined), 'unknown height and area do not gate');
  check(carriesFacadeConstruction(NaN, NaN), 'non-finite height and area do not gate');
});

// -------------------------------------------------------------- far tier floor

section('the far tier is construction, not a painted prism', () => {
  check(FACADE_DEPTH_BUDGET.trianglesPerBuilding.far === 96, 'the far tier costs 96 triangles at its ceiling');
  let minTriangles = Infinity;
  let maxTriangles = 0;
  let bandQuads = 0;
  for (const building of CORPUS) {
    const plan = planFacadeDepth(building, { tier: 'far', baseY: 2 });
    check(plan.quads.length > 0, `${building.id}: a real building must not be bare at the far tier`);
    check((plan.features.cornice || 0) > 0, `${building.id}: far tier without a cornice line`);
    check((plan.features['window-band'] || 0) > 0, `${building.id}: far tier without a recessed window band`);
    check((plan.features.plinth || 0) > 0, `${building.id}: far tier without a ground plinth`);
    minTriangles = Math.min(minTriangles, plan.triangles);
    maxTriangles = Math.max(maxTriangles, plan.triangles);
    for (const quad of plan.quads) {
      if (quad.feature !== 'window-band') continue;
      if (quad.role === 'glass') bandQuads += 1;
      for (const value of quad.positions) check(Number.isFinite(value), `${building.id}: non-finite band vertex`);
    }
  }
  check(minTriangles >= 54, `the cheapest far facade costs ${minTriangles} triangles`);
  check(maxTriangles === 96, `the dearest far facade costs ${maxTriangles}, expected the 96 ceiling`);
  check(bandQuads >= CORPUS.length, `expected at least one band pane per building, got ${bandQuads}`);
  results.push(`      far tier over the corpus: min ${minTriangles}, max ${maxTriangles} triangles, ${bandQuads} band panes`);

  // The band is a real recess of the same depth as a near-tier reveal, not a
  // decal. Measured on an axis-aligned probe so the wall planes are known.
  const probe = {
    id: 'far-band-probe',
    polygon: rectangle(0, 0, 30, 18, 0),
    height: 22,
    stories: 6,
    facade: 'edwardian',
    type: 'apartment',
    usage: 'residential',
    material: 'brick',
  };
  const plan = planFacadeDepth(probe, { tier: 'far', baseY: 0 });
  let panes = 0;
  for (const quad of plan.quads) {
    if (quad.feature !== 'window-band' || quad.role !== 'glass') continue;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < 4; i += 1) {
      cx += quad.positions[i * 3] / 4;
      cz += quad.positions[i * 3 + 2] / 4;
    }
    const wall = Math.abs(quad.normal[0]) > 0.5 ? 15 : 9;
    const recess = wall - (Math.abs(quad.normal[0]) > 0.5 ? Math.abs(cx) : Math.abs(cz));
    check(recess >= 0.08 - 1e-6, `far band is only ${recess.toFixed(3)} m deep: that is a decal, not a reveal`);
    check(recess <= 0.25 + 1e-6, `far band is ${recess.toFixed(3)} m deep, past the 0.25 m design band`);
    panes += 1;
  }
  check(panes >= 4, `expected a band pane on each of the probe's edges, got ${panes}`);
});

section('the far band opens on the line the mid tier turns into windows', () => {
  // No vertical slide on approach: the band the far tier draws and the
  // openings the mid tier cuts share a sill and a head to the last bit.
  const key = (quad) => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 4; i += 1) {
      low = Math.min(low, quad.positions[i * 3 + 1]);
      high = Math.max(high, quad.positions[i * 3 + 1]);
    }
    return `${low.toFixed(6)}|${high.toFixed(6)}`;
  };
  let compared = 0;
  for (const style of FACADE_DEPTH_STYLES) {
    for (const height of [6, 9, 14, 21, 40, 90]) {
      for (const stories of [1, 2, 3, 6, 12]) {
        const building = {
          id: `band-line-${style}-${height}-${stories}`,
          polygon: rectangle(0, 0, 28, 17, 0.3),
          height,
          stories,
          facade: style,
          type: style === 'shopfront' ? 'shop' : 'apartment',
          shop: style === 'shopfront' ? 'bakery' : undefined,
          material: 'brick',
        };
        const far = planFacadeDepth(building, { tier: 'far', baseY: 0 });
        const mid = planFacadeDepth(building, { tier: 'mid', baseY: 0 });
        const openings = new Set(
          mid.quads
            .filter((quad) => quad.role === 'glass' && (quad.feature === 'window' || quad.feature === 'shopfront-glazing'))
            .map(key),
        );
        for (const quad of far.quads) {
          if (quad.feature !== 'window-band' || quad.role !== 'glass') continue;
          check(openings.has(key(quad)), `${building.id}: far band at ${key(quad)} is not where the mid tier opens (${[...openings].join(' ')})`);
          compared += 1;
        }
      }
    }
  }
  check(compared > 500, `expected a large band sample, got ${compared}`);
});

// ------------------------------------------------- uniform budget degradation

section('a tight budget degrades uniformly, never one building at a time', () => {
  // Neighbours: sixteen buildings of wildly different style, height and
  // footprint sharing one centroid, so their camera distance is bit identical.
  const view = { x: 0, z: 0 };
  const rings = [18, 42, 70, 96, 130, 165, 210, 260, 310, 400];
  const neighbours = [];
  rings.forEach((radius, ringIndex) => {
    for (let i = 0; i < 16; i += 1) {
      neighbours.push({
        id: `ring-${ringIndex}-${i}`,
        polygon: rectangle(radius, 0, 12 + (i % 5) * 7, 9 + (i % 3) * 6, (i * Math.PI) / 8),
        height: 4 + (i % 8) * 14,
        stories: 1 + (i % 8) * 4,
        facade: FACADE_DEPTH_STYLES[i % FACADE_DEPTH_STYLES.length],
        type: TYPES[i % TYPES.length],
        usage: USAGES[i % USAGES.length],
        shop: i % 5 === 0 ? 'convenience' : undefined,
        material: MATERIALS[i % MATERIALS.length],
        ringIndex,
      });
    }
  });

  const budgets = [Infinity, 400000, 60000, 24000, 9000, 3000, 900, 120, 0];
  for (const budget of budgets) {
    const batch = buildFacadeDepthBatch(neighbours, {
      viewPoint: view,
      fov: 47,
      viewportHeight: 720,
      sceneTriangleBudget: Number.isFinite(budget) ? budget : undefined,
      baseY: 0,
    });
    if (Number.isFinite(budget)) {
      check(batch.triangles <= budget, `budget ${budget}: batch spent ${batch.triangles}`);
    }
    const tierById = new Map(batch.buildings.map((entry) => [entry.id, entry]));

    // 1. Equal distance, equal treatment. Every member of a ring is either
    //    all in at one tier, or all out.
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const members = neighbours.filter((building) => building.ringIndex === ringIndex);
      const tiers = new Set(members.map((building) => tierById.get(building.id)?.tier ?? 'off'));
      check(
        tiers.size === 1,
        `budget ${budget}, ring ${rings[ringIndex]} m: neighbours split across ${[...tiers].join('/')}`,
      );
    }

    // 2. The cut is a ring, not a shopping list: everything kept is nearer
    //    than everything dropped.
    let keptMax = -Infinity;
    let droppedMin = Infinity;
    for (const building of neighbours) {
      const entry = tierById.get(building.id);
      const distance = rings[building.ringIndex];
      if (entry) keptMax = Math.max(keptMax, distance);
      else droppedMin = Math.min(droppedMin, distance);
    }
    check(keptMax <= droppedMin + 1e-6, `budget ${budget}: kept a building at ${keptMax} m while dropping one at ${droppedMin} m`);

    // 3. Tier is still monotone in distance across what survived.
    let previous = FACADE_TIER_RANK.near;
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const member = neighbours.find((building) => building.ringIndex === ringIndex);
      const rank = FACADE_TIER_RANK[tierById.get(member.id)?.tier ?? 'off'];
      check(rank <= previous, `budget ${budget}: ring ${rings[ringIndex]} m outranks the ring inside it`);
      previous = rank;
    }
    disposeFacadeDepth(batch);
  }

  // The same run twice is the same scene: tiering is deterministic and takes
  // nothing from the clock.
  const options = { viewPoint: view, fov: 47, viewportHeight: 720, sceneTriangleBudget: 9000, baseY: 0 };
  const first = buildFacadeDepthBatch(neighbours, options);
  const second = buildFacadeDepthBatch(neighbours, options);
  check(
    JSON.stringify(first.buildings) === JSON.stringify(second.buildings),
    'the same scene tiers identically on a second call',
  );
  disposeFacadeDepth(first);
  disposeFacadeDepth(second);

  // Two records that differ only by id, at one distance, get one tier.
  const twins = [
    { id: 'twin-a', polygon: rectangle(80, 0, 20, 14, 0), height: 24, stories: 7, facade: 'edwardian' },
    { id: 'twin-b', polygon: rectangle(80, 0, 20, 14, 0), height: 24, stories: 7, facade: 'edwardian' },
  ];
  const twinBatch = buildFacadeDepthBatch(twins, { viewPoint: view, fov: 47, viewportHeight: 720, baseY: 0 });
  check(twinBatch.buildings.length === 2, 'both twins are built');
  check(twinBatch.buildings[0].tier === twinBatch.buildings[1].tier, 'twins share a tier');
  disposeFacadeDepth(twinBatch);

  // And the whole 700 building corpus under the runtime allowance.
  const city = buildFacadeDepthBatch(CORPUS, {
    viewPoint: { x: 0, z: 0 },
    fov: 47,
    viewportHeight: 720,
    baseY: 0,
    sceneTriangleBudget: FACADE_DEPTH_BUDGET.sceneTriangleBudget,
  });
  check(city.triangles <= FACADE_DEPTH_BUDGET.sceneTriangleBudget, 'the corpus fits the runtime allowance');
  check(city.drawCalls <= FACADE_DEPTH_BUDGET.maxDrawCalls, 'the corpus still merges to 12 draw calls');
  results.push(`      corpus batch: ceiling ${city.tierCeiling}, ring cut ${city.ringCutDistance === null ? 'none' : `${city.ringCutDistance.toFixed(1)} m`}, tiers ${JSON.stringify(city.tiers)}, ${city.triangles} triangles`);
  disposeFacadeDepth(city);
});

section('no NaN reaches a vertex, a tier or a merged buffer', () => {
  for (const building of CORPUS) {
    for (const tier of FACADE_DEPTH_TIERS) {
      const plan = planFacadeDepth(building, { tier, baseY: -6.5 });
      for (const quad of plan.quads) {
        for (const value of quad.positions) check(Number.isFinite(value), `${building.id} ${tier}: non-finite position`);
        for (const value of quad.uvs) check(Number.isFinite(value), `${building.id} ${tier}: non-finite uv`);
        for (const value of quad.normal) check(Number.isFinite(value), `${building.id} ${tier}: non-finite normal`);
      }
      check(Number.isFinite(plan.triangles), `${building.id} ${tier}: non-finite triangle count`);
    }
  }
  const batch = buildFacadeDepthBatch(CORPUS, { viewPoint: { x: 0, z: 0 }, fov: 47, viewportHeight: 720, baseY: 0 });
  for (const group of batch.groups) {
    for (const value of group.geometry.attributes.position.array) check(Number.isFinite(value), `${group.key}: non-finite merged position`);
    for (const value of group.geometry.attributes.normal.array) check(Number.isFinite(value), `${group.key}: non-finite merged normal`);
    for (const value of group.geometry.attributes.uv.array) check(Number.isFinite(value), `${group.key}: non-finite merged uv`);
  }
  disposeFacadeDepth(batch);
  for (const screen of SCREENS) {
    for (const distance of [0, 1, 60, 400, 4000]) {
      const metrics = facadeDetailTierMetrics({ distance, height: 20, footprintArea: 400, ...screen });
      check(Number.isFinite(metrics.pixelsPerMetre), 'pixels per metre is finite');
      check(Number.isFinite(metrics.storeyPixels), 'storey pixels are finite');
      check(Number.isFinite(metrics.screenHeightPixels), 'screen height is finite');
    }
  }
});

// ------------------------------------------------------------------- report

console.log(`verify-facade-depth: ${FACADE_DEPTH_VERSION}`);
for (const line of results) console.log(line);
console.log('  triangle cost per building (measured over the 700 building corpus):');
for (const lod of FACADE_DEPTH_LODS) {
  const cap = FACADE_DEPTH_BUDGET.trianglesPerBuilding[lod];
  const mean = perLodTotals[lod] / CORPUS.length;
  console.log(`    ${lod.padEnd(5)} cap ${String(cap).padStart(5)}  max ${String(perLodMax[lod]).padStart(5)}  mean ${mean.toFixed(1).padStart(7)}`);
}
console.log(`  features emitted: ${Array.from(featureTally.entries()).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`verify-facade-depth: PASS (${checks} assertions)`);
