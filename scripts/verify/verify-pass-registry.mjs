// Self-check for src/render/pass-registry.js and every registered pass.
//
// Runs headless under plain node: no browser, no DOM, no new dependency.
//
//   npm run verify:passes
//
// What it proves:
//   1. every registered pass satisfies the module contract
//   2. ids are unique and build order is total and stable
//   3. a synthetic city builds every pass without throwing
//   4. a pass that throws is isolated, recorded, and cannot stop the world
//   5. built content is parented to the supplied root and removed on dispose
//   6. two builds of the same city produce identical geometry counts
//   7. the whole pass set stays inside its triangle and draw-call budget
import * as THREE from 'three';
import { createPassRuntime, validatePass } from '../../src/render/pass-registry.js';
import { PASSES } from '../../src/render/passes/index.js';

// Budget for everything the pass layer adds on top of the legacy renderer.
// Raising it is a deliberate act that needs matched performance evidence.
const TRIANGLE_BUDGET = 3_200_000;
const DRAW_CALL_BUDGET = 320;

let checks = 0;
const failures = [];
function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

/** A small but structurally real city: a block of buildings on a straight street. */
function syntheticCity() {
  const buildings = [];
  for (let i = 0; i < 12; i += 1) {
    const x = -60 + i * 10;
    buildings.push({
      id: `sf-building-${1000 + i}`,
      height: 8 + (i % 5) * 6,
      levels: 2 + (i % 5),
      material: i % 2 ? 'brick' : 'stucco',
      polygon: [
        { x, z: 8 }, { x: x + 8, z: 8 }, { x: x + 8, z: 22 }, { x, z: 22 },
      ],
    });
  }
  const segments = [{
    id: 'sf-seg-1',
    streetName: 'Market Street',
    className: 'primary',
    asphaltWidth: 12.8,
    sidewalkWidth: 2.5,
    points: [{ x: -80, z: 0 }, { x: 80, z: 0 }],
  }];
  return {
    meta: { seed: 'verify-pass-registry', seedInt: 7, generator: 'sf-builtin', bounds: { minX: -120, maxX: 120, minZ: -60, maxZ: 60 } },
    buildings,
    segments,
    streets: segments,
    blocks: [],
    signals: [],
  };
}

function makeContext(root, city) {
  return {
    root,
    city,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 4200),
    renderer: null,
    rendererBackend: 'verify',
    terrain: { heightAt: () => 0 },
    heightAt: () => 0,
    isSanFrancisco: true,
    seed: 7,
    rng: () => { let t = 0x9e3779b9; return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; },
    focus: { x: 0, z: 0 },
    hour: 11,
    weather: 'clear',
    day: true,
    registerGeometry: (geometry) => geometry,
    legacyGroup: () => null,
  };
}

// 1-2. contract and ordering
const ids = new Set();
for (const pass of PASSES) {
  const problems = validatePass(pass);
  check(`contract ${pass?.id}`, problems.length === 0, problems.join('; '));
  check(`unique id ${pass?.id}`, !ids.has(pass.id));
  ids.add(pass.id);
}
check('at least one pass registered', PASSES.length > 0);

const sorted = [...PASSES].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
const runtimeOrder = createPassRuntime(PASSES).passes.map((p) => p.id);
check('build order is the declared order', runtimeOrder.join(',') === sorted.map((p) => p.id).join(','), runtimeOrder.join(','));

// 3, 5, 7. real build against a synthetic city
const city = syntheticCity();
const root = new THREE.Group();
const runtime = createPassRuntime(PASSES);
const ctx = makeContext(root, city);
const diagnostics = runtime.build(ctx);
check('no build errors', diagnostics.errors.length === 0, JSON.stringify(diagnostics.errors));
for (const entry of diagnostics.built) {
  check(`${entry.id} reports finite counts`, Number.isFinite(entry.triangles) && Number.isFinite(entry.drawCalls));
}
for (const child of root.children) {
  check(`${child.userData.passId} content is parented to the supplied root`, child.parent === root);
}
check(
  `triangle budget (${diagnostics.totals.triangles} <= ${TRIANGLE_BUDGET})`,
  diagnostics.totals.triangles <= TRIANGLE_BUDGET,
);
check(
  `draw-call budget (${diagnostics.totals.drawCalls} <= ${DRAW_CALL_BUDGET})`,
  diagnostics.totals.drawCalls <= DRAW_CALL_BUDGET,
);

const builtSnapshot = diagnostics.built.map(({ id, triangles, drawCalls, detail }) => ({ id, triangles, drawCalls, detail }));
const totalsSnapshot = { ...diagnostics.totals };
const builtCount = builtSnapshot.length;

// 6. determinism
const rootB = new THREE.Group();
const runtimeB = createPassRuntime(PASSES);
const diagnosticsB = runtimeB.build(makeContext(rootB, syntheticCity()));
const signature = (d) => d.built.map((e) => `${e.id}:${e.triangles}:${e.drawCalls}`).join('|');
check('two builds are geometrically identical', signature(diagnostics) === signature(diagnosticsB), `${signature(diagnostics)} != ${signature(diagnosticsB)}`);

// 5. teardown
runtime.dispose();
check('dispose empties the root', root.children.length === 0, `${root.children.length} left`);
runtimeB.dispose();

// 4. isolation of a hostile pass
const hostile = {
  id: 'hostile-verify-only',
  order: 999,
  build() { throw new Error('boom'); },
};
const guardedRoot = new THREE.Group();
const guarded = createPassRuntime([...PASSES, hostile]);
const guardedDiagnostics = guarded.build(makeContext(guardedRoot, syntheticCity()));
check('a throwing pass is recorded', guardedDiagnostics.errors.some((e) => e.id === 'hostile-verify-only'));
check('a throwing pass does not stop the others', guardedDiagnostics.built.length === builtCount, `${guardedDiagnostics.built.length} != ${builtCount}`);
guarded.dispose();

const updateFailures = { id: 'hostile-update', order: 998, build: () => null, update() { throw new Error('per-frame boom'); } };
const updateRuntime = createPassRuntime([updateFailures]);
const updateCtx = makeContext(new THREE.Group(), city);
updateRuntime.build(updateCtx);
for (let i = 0; i < 10; i += 1) updateRuntime.update(updateCtx, 1 / 60);
check(
  'a repeatedly failing update is switched off',
  updateRuntime.diagnostics.errors.filter((e) => e.phase === 'update').length === 3,
  String(updateRuntime.diagnostics.errors.filter((e) => e.phase === 'update').length),
);

console.log(JSON.stringify({
  passes: diagnostics.registered,
  built: builtSnapshot,
  totals: totalsSnapshot,
}, null, 2));

if (failures.length) {
  console.error(`\nFAIL ${failures.length}/${checks}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nPASS ${checks} checks`);
