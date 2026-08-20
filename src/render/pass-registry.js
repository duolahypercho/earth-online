// Presentation pass registry.
//
// The canonical renderer builds the world, then hands the finished city root to
// a fixed, ordered list of *presentation passes*. A pass is a pure module: it
// receives a context describing the city and returns scene content plus its own
// diagnostics. It never creates a renderer, an animation loop, a scene root, or
// its own clock, and it never writes simulation state.
//
// The list is static (`./passes/index.js`) so a pass cannot appear by accident,
// and so plain `node` verifiers can import the same runtime the browser uses.
//
// Contract for a pass module's default export:
//
//   {
//     id: 'street-furniture',        // unique, kebab-case
//     order: 40,                     // ascending build order
//     enabled?: (ctx) => boolean,    // optional gate, defaults to true
//     build(ctx): PassResult,        // required; must not throw for bad input
//     update?(ctx, delta): void,     // optional per-frame work, no allocation
//     dispose?(): void,              // optional extra teardown
//   }
//
// `PassResult` is either `null`, a `THREE.Object3D`, or
// `{ object?: Object3D|null, diagnostics?: object }`.
//
// A pass that throws is disabled and recorded; it can never take the world down
// with it.

export const PASS_RUNTIME_VERSION = 'pass-runtime-v1';

// A pass that throws this many times during update is switched off for the
// remainder of the session rather than logging once per frame forever.
const MAX_UPDATE_FAILURES = 3;

function countTriangles(object) {
  let triangles = 0;
  let drawCalls = 0;
  object.traverse((node) => {
    const geometry = node.geometry;
    if (!geometry) return;
    const instances = Number.isFinite(node.count) ? Math.max(1, node.count) : 1;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    const verts = index ? index.count : position ? position.count : 0;
    triangles += Math.floor(verts / 3) * instances;
    drawCalls += 1;
  });
  return { triangles, drawCalls };
}

function normalizeResult(result) {
  if (!result) return { object: null, diagnostics: {} };
  if (typeof result.traverse === 'function') return { object: result, diagnostics: {} };
  return {
    object: result.object && typeof result.object.traverse === 'function' ? result.object : null,
    diagnostics: result.diagnostics && typeof result.diagnostics === 'object' ? result.diagnostics : {},
  };
}

function disposeObject(object) {
  object.traverse((node) => {
    if (node.geometry?.dispose) node.geometry.dispose();
    const materials = Array.isArray(node.material)
      ? node.material
      : node.material
        ? [node.material]
        : [];
    for (const material of materials) {
      if (material.map?.dispose) material.map.dispose();
      if (material.normalMap?.dispose) material.normalMap.dispose();
      if (material.roughnessMap?.dispose) material.roughnessMap.dispose();
      if (material.dispose) material.dispose();
    }
  });
  object.parent?.remove(object);
}

/**
 * Validate a pass module shape. Returns an array of human-readable problems;
 * empty means the module satisfies the contract.
 */
export function validatePass(pass) {
  const problems = [];
  if (!pass || typeof pass !== 'object') return ['pass is not an object'];
  if (typeof pass.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(pass.id)) {
    problems.push(`id must be kebab-case, got ${JSON.stringify(pass.id)}`);
  }
  if (!Number.isFinite(pass.order)) problems.push(`${pass.id}: order must be a finite number`);
  if (typeof pass.build !== 'function') problems.push(`${pass.id}: build must be a function`);
  if (pass.update != null && typeof pass.update !== 'function') {
    problems.push(`${pass.id}: update must be a function when present`);
  }
  if (pass.dispose != null && typeof pass.dispose !== 'function') {
    problems.push(`${pass.id}: dispose must be a function when present`);
  }
  if (pass.enabled != null && typeof pass.enabled !== 'function') {
    problems.push(`${pass.id}: enabled must be a function when present`);
  }
  return problems;
}

/**
 * Build a runtime over a pass list. The runtime owns nothing but the objects
 * its passes returned, so the caller keeps full control of the scene graph.
 */
export function createPassRuntime(passes) {
  const list = [...passes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const invalid = [];
  const active = [];
  for (const pass of list) {
    const problems = validatePass(pass);
    if (problems.length) invalid.push(...problems);
    else active.push(pass);
  }
  /** @type {Map<string, {pass: object, object: import('three').Object3D|null, failures: number}>} */
  const built = new Map();
  const diagnostics = {
    version: PASS_RUNTIME_VERSION,
    registered: active.map((pass) => pass.id),
    invalid,
    built: [],
    skipped: [],
    errors: [],
    totals: { triangles: 0, drawCalls: 0, buildMs: 0 },
  };

  function build(ctx) {
    diagnostics.built = [];
    diagnostics.skipped = [];
    diagnostics.errors = [];
    diagnostics.totals = { triangles: 0, drawCalls: 0, buildMs: 0 };
    built.clear();
    for (const pass of active) {
      let enabled = true;
      try {
        enabled = pass.enabled ? pass.enabled(ctx) !== false : true;
      } catch (error) {
        enabled = false;
        diagnostics.errors.push({ id: pass.id, phase: 'enabled', message: String(error?.message || error) });
      }
      if (!enabled) {
        diagnostics.skipped.push(pass.id);
        continue;
      }
      const startedAt = Date.now();
      let normalized;
      try {
        normalized = normalizeResult(pass.build(ctx));
      } catch (error) {
        diagnostics.errors.push({ id: pass.id, phase: 'build', message: String(error?.message || error) });
        continue;
      }
      const buildMs = Date.now() - startedAt;
      const { object, diagnostics: passDiagnostics } = normalized;
      let counts = { triangles: 0, drawCalls: 0 };
      if (object) {
        object.name = object.name || `pass:${pass.id}`;
        object.userData.passId = pass.id;
        counts = countTriangles(object);
        ctx.root?.add(object);
      }
      built.set(pass.id, { pass, object, failures: 0 });
      diagnostics.built.push({
        id: pass.id,
        order: pass.order,
        buildMs,
        triangles: counts.triangles,
        drawCalls: counts.drawCalls,
        detail: passDiagnostics,
      });
      diagnostics.totals.triangles += counts.triangles;
      diagnostics.totals.drawCalls += counts.drawCalls;
      diagnostics.totals.buildMs += buildMs;
    }
    return diagnostics;
  }

  function update(ctx, delta) {
    for (const entry of built.values()) {
      if (!entry.pass.update || entry.failures >= MAX_UPDATE_FAILURES) continue;
      try {
        entry.pass.update(ctx, delta);
      } catch (error) {
        entry.failures += 1;
        diagnostics.errors.push({
          id: entry.pass.id,
          phase: 'update',
          message: String(error?.message || error),
          disabled: entry.failures >= MAX_UPDATE_FAILURES,
        });
      }
    }
  }

  function dispose() {
    for (const entry of built.values()) {
      try {
        entry.pass.dispose?.();
      } catch (error) {
        diagnostics.errors.push({ id: entry.pass.id, phase: 'dispose', message: String(error?.message || error) });
      }
      if (entry.object) disposeObject(entry.object);
    }
    built.clear();
    diagnostics.built = [];
    diagnostics.totals = { triangles: 0, drawCalls: 0, buildMs: 0 };
  }

  return { build, update, dispose, diagnostics, passes: active };
}
