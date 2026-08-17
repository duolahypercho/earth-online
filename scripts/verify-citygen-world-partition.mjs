// Fail-closed contract verifier for the SF bistro-light world partition.
// This covers the canonical renderer only; it must never create a second
// renderer, scene, clock, or world root to test partitioning.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const report = { poses: {}, captures: [], cpu: null };
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
});

const EXPECTED = Object.freeze({
  pass: 'sf-world-partition-bistro-v1',
  instances: 1502,
  triangles: 72096,
  trianglesPerInstance: 48,
  cellSizeMeters: 140,
  enterRadiusMeters: 420,
  exitRadiusMeters: 520,
  aerialHeightMeters: 500,
  updateIntervalFrames: 8,
  portals: 700,
  poses: {
    sf: { active: 238, cells: 16, submittedTriangles: 11424 },
    night: { active: 235, cells: 15, submittedTriangles: 11280 },
    aerial: { active: 1502, cells: 69, submittedTriangles: 72096 },
  },
});

async function installSnapshot(target) {
  await target.evaluate((source) => {
    window.__CITYGEN_PARTITION_SNAPSHOT__ = (0, eval)(`(${source})`);
  }, snapshotPartition.toString());
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function waitForCanonical(target) {
  await target.goto(url, { waitUntil: 'load', timeout: 60000 });
  await target.waitForFunction(() => {
    const api = window.__CITYGEN__;
    const state = api?.getState?.();
    const renderer = api?.getRenderer?.();
    const diagnostics = renderer?.worldPartitionDiagnostics;
    return state?.generator === 'sf-builtin' && state?.buildings === 700 && !state?.busy
      && renderer?.root && diagnostics?.pass === 'sf-world-partition-bistro-v1' && diagnostics?.enabled;
  }, { timeout: 60000 });
  await target.waitForTimeout(300);
}

async function setPoseAndSample(pose, hour) {
  await page.evaluate(({ pose: requestedPose, hour: requestedHour }) => {
    const api = window.__CITYGEN__;
    api.setTime(requestedHour);
    api.setCameraPose(requestedPose);
    const renderer = api.getRenderer();
    renderer.controls.update();
    renderer.updateWorldPartition(true, true);
    renderer.renderFrame();
  }, { pose, hour });
  await page.waitForTimeout(120);
  return page.evaluate(() => window.__CITYGEN_PARTITION_SNAPSHOT__());
}

function assertCore(sample, label) {
  const diagnostics = sample.diagnostics;
  assert.equal(sample.backend, 'webgpu', `${label}: WebGPU backend`);
  assert.equal(diagnostics.schemaVersion, 1, `${label}: schema version`);
  assert.equal(diagnostics.pass, EXPECTED.pass, `${label}: partition pass`);
  assert.equal(diagnostics.enabled, true, `${label}: partition enabled`);
  assert.equal(diagnostics.failure, null, `${label}: partition has no contract failure`);
  assert.equal(diagnostics.focusSource, 'controls-target', `${label}: controls target is the source of truth`);
  assert.equal(diagnostics.cellSizeMeters, EXPECTED.cellSizeMeters, `${label}: cell size`);
  assert.deepEqual({
    enterRadiusMeters: diagnostics.hysteresis.enterRadiusMeters,
    exitRadiusMeters: diagnostics.hysteresis.exitRadiusMeters,
    aerialHeightMeters: diagnostics.hysteresis.aerialHeightMeters,
    updateIntervalFrames: diagnostics.hysteresis.updateIntervalFrames,
  }, {
    enterRadiusMeters: EXPECTED.enterRadiusMeters,
    exitRadiusMeters: EXPECTED.exitRadiusMeters,
    aerialHeightMeters: EXPECTED.aerialHeightMeters,
    updateIntervalFrames: EXPECTED.updateIntervalFrames,
  }, `${label}: exact hysteresis policy`);
  assert.deepEqual(diagnostics.resources, { drawGroups: 0, geometries: 0, materials: 0, textures: 0 },
    `${label}: partition adds no rendering resources`);
  assert.equal(diagnostics.source.instances, EXPECTED.instances, `${label}: source instances`);
  assert.equal(diagnostics.source.triangles, EXPECTED.triangles, `${label}: source triangles`);
  assert.equal(diagnostics.source.trianglesPerInstance, EXPECTED.trianglesPerInstance, `${label}: source triangles per instance`);
  assert.ok((typeof diagnostics.source.recordsChecksum === 'string' && diagnostics.source.recordsChecksum.length > 0)
    || Number.isFinite(diagnostics.source.recordsChecksum), `${label}: source checksum is present`);
  assert.equal(diagnostics.source.unchanged, true, `${label}: source records unchanged`);
  assert.equal(diagnostics.source.recordsUnchanged, true, `${label}: records checksum remains unchanged`);
  assert.ok(Number.isFinite(diagnostics.source.inputChecksumBefore), `${label}: input checksum before is finite`);
  assert.equal(diagnostics.source.inputChecksumAfter, diagnostics.source.inputChecksumBefore,
    `${label}: partition preserves the source input checksum`);
  assert.equal(diagnostics.cells.total, 69, `${label}: exact partition-cell total`);
  assert.equal(diagnostics.active.instances + diagnostics.active.hiddenInstances, EXPECTED.instances,
    `${label}: active and hidden instances cover source`);
  assert.equal(diagnostics.active.indices.length, diagnostics.active.instances, `${label}: active-index length`);
  assert.equal(new Set(diagnostics.active.indices).size, diagnostics.active.indices.length, `${label}: active indices unique`);
  assert.ok(diagnostics.active.indices.every((index) => Number.isInteger(index) && index >= 0 && index < EXPECTED.instances),
    `${label}: active indices are source indices`);
  assert.equal(diagnostics.mesh.name, 'sf-partitioned-bistro-lights', `${label}: mesh name`);
  assert.equal(diagnostics.mesh.capacity, EXPECTED.instances, `${label}: mesh capacity`);
  assert.equal(diagnostics.mesh.count, diagnostics.active.instances, `${label}: mesh count follows active instances`);
  assert.equal(diagnostics.mesh.submittedTriangles, diagnostics.mesh.count * EXPECTED.trianglesPerInstance,
    `${label}: submitted triangles use exact sphere topology`);
  assert.equal(diagnostics.mesh.oneMesh, true, `${label}: exactly one existing mesh is retained`);
  assert.equal(diagnostics.mesh.matricesFinite, true, `${label}: compacted matrices finite`);
  assert.equal(diagnostics.mesh.colorsFinite, true, `${label}: compacted colors finite`);
  assert.equal(sample.partitionMeshes.length, 1, `${label}: one partition mesh in canonical root`);
  assert.deepEqual(sample.partitionMeshes[0], {
    name: 'sf-partitioned-bistro-lights',
    kind: 'sf-partitioned-bistro-lights',
    instanced: true,
    count: diagnostics.mesh.count,
    capacity: EXPECTED.instances,
    matricesFinite: true,
    colorsFinite: true,
    instanceColorExists: true,
    instanceColorDynamic: true,
  }, `${label}: live mesh matches diagnostics`);
  assert.deepEqual(sample.identity, {
    renderer: true, scene: true, canvas: true, roots: 1, oneSceneCanvas: 1, animationLoopAttached: true,
  },
    `${label}: one canonical renderer/scene/canvas/root/loop`);
  assert.equal(sample.interiors.registered, EXPECTED.portals, `${label}: all building portals still registered`);
  assert.equal(sample.interiors.functional, EXPECTED.portals, `${label}: all building portals still functional`);
}

function assertPose(sample, label) {
  assertCore(sample, label);
  const expected = EXPECTED.poses[label];
  assert.equal(sample.diagnostics.active.instances, expected.active, `${label}: exact active bistro lights`);
  assert.equal(sample.diagnostics.cells.active, expected.cells, `${label}: exact active cells`);
  assert.equal(sample.diagnostics.mesh.submittedTriangles, expected.submittedTriangles,
    `${label}: exact submitted triangles`);
  assert.equal(sample.diagnostics.active.aerial, label === 'aerial', `${label}: aerial state`);
}

try {
  await waitForCanonical(page);
  await installSnapshot(page);
  const initial = await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    window.__CITYGEN_WORLD_PARTITION_IDENTITY__ = {
      renderer,
      scene: renderer.scene,
      canvas: renderer.renderer.domElement,
    };
    return window.__CITYGEN_PARTITION_SNAPSHOT__();
  });
  assertCore(initial, 'initial');

  report.poses.sf = await setPoseAndSample('sf', 14);
  assertPose(report.poses.sf, 'sf');
  await page.screenshot({ path: '.qa-citygen-world-partition-sf.png' });
  report.captures.push('.qa-citygen-world-partition-sf.png');

  report.poses.night = await setPoseAndSample('night', 22);
  assertPose(report.poses.night, 'night');
  await page.screenshot({ path: '.qa-citygen-world-partition-night.png' });
  report.captures.push('.qa-citygen-world-partition-night.png');

  report.poses.aerial = await setPoseAndSample('aerial', 14);
  assertPose(report.poses.aerial, 'aerial');
  await page.screenshot({ path: '.qa-citygen-world-partition-aerial.png' });
  report.captures.push('.qa-citygen-world-partition-aerial.png');

  const compactedEquivalence = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    api.setTime(14);
    api.setCameraPose('aerial');
    renderer.controls.update();
    renderer.updateWorldPartition(true, true);
    const mesh = renderer.worldPartitionRuntime.mesh;
    const allMatrices = new Float32Array(mesh.instanceMatrix.array);
    const allColors = new Float32Array(mesh.instanceColor.array);
    api.setCameraPose('sf');
    renderer.controls.update();
    renderer.updateWorldPartition(true, true);
    const indices = [...renderer.worldPartitionDiagnostics.active.indices];
    let matrixMismatches = 0;
    let colorMismatches = 0;
    for (let target = 0; target < indices.length; target += 1) {
      const source = indices[target];
      for (let component = 0; component < 16; component += 1) {
        if (mesh.instanceMatrix.array[target * 16 + component] !== allMatrices[source * 16 + component]) matrixMismatches += 1;
      }
      for (let component = 0; component < 3; component += 1) {
        if (mesh.instanceColor.array[target * 3 + component] !== allColors[source * 3 + component]) colorMismatches += 1;
      }
    }
    return { instances: indices.length, matrixMismatches, colorMismatches, restored: window.__CITYGEN_PARTITION_SNAPSHOT__() };
  });
  assert.equal(compactedEquivalence.instances, EXPECTED.poses.sf.active,
    'compacted candidate: expected SF instance count');
  assert.equal(compactedEquivalence.matrixMismatches, 0,
    'compacted candidate: matrices exactly match force-all source ordering');
  assert.equal(compactedEquivalence.colorMismatches, 0,
    'compacted candidate: colors exactly match force-all source ordering');
  assertPose(compactedEquivalence.restored, 'sf');

  // Fresh-page determinism is intentionally checked independently of live actor state.
  const secondPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const secondErrors = [];
  secondPage.on('pageerror', (error) => secondErrors.push(error.message));
  await waitForCanonical(secondPage);
  await installSnapshot(secondPage);
  const fresh = await secondPage.evaluate(() => {
    window.__CITYGEN__.setTime(14);
    window.__CITYGEN__.setCameraPose('sf');
    const renderer = window.__CITYGEN__.getRenderer();
    renderer.controls.update();
    renderer.updateWorldPartition(true, true);
    renderer.renderFrame();
    return window.__CITYGEN_PARTITION_SNAPSHOT__();
  });
  assertPose(fresh, 'sf');
  assert.deepEqual({
    checksum: fresh.diagnostics.source.recordsChecksum,
    indices: fresh.diagnostics.active.indices,
    cells: fresh.diagnostics.cells.ids,
    active: fresh.diagnostics.active.instances,
  }, {
    checksum: report.poses.sf.diagnostics.source.recordsChecksum,
    indices: report.poses.sf.diagnostics.active.indices,
    cells: report.poses.sf.diagnostics.cells.ids,
    active: report.poses.sf.diagnostics.active.instances,
  }, 'fresh page: partition source and hero selection deterministic');
  assert.deepEqual(secondErrors, [], 'fresh page: no errors');
  await secondPage.close();

  const boundary = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    api.setTime(14);
    api.setCameraPose('sf');
    const renderer = api.getRenderer();
    const controls = renderer.controls;
    const camera = renderer.camera;
    const original = {
      camera: camera.position.toArray(),
      target: controls.target.toArray(),
      fov: camera.fov,
    };
    const cell = renderer.worldPartitionRuntime.cells.find((entry) => entry.indices.length > 0);
    const cameraOffset = camera.position.clone().sub(controls.target);
    const probe = (edgeDistance, reset = false, normal = false) => {
      // Both probes stay in the same 140m focus cell: dx and dz are each
      // within [280,420), while their combined cell-edge distance crosses
      // the 520m exit radius.
      const dx = edgeDistance === 419 ? 300 : edgeDistance === 510 ? 390 : 400;
      const dz = Math.sqrt(edgeDistance * edgeDistance - dx * dx);
      controls.target.set(cell.x + 70 + dx, original.target[1], cell.z + 70 + dz);
      camera.position.copy(controls.target).add(cameraOffset);
      camera.lookAt(controls.target);
      controls.update();
      if (!normal) renderer.updateWorldPartition(true, reset);
      else for (let index = 0; index < 8; index += 1) renderer.updateWorldPartition(false);
      return {
        snapshot: window.__CITYGEN_PARTITION_SNAPSHOT__(),
        focusCell: `${Math.floor(controls.target.x / 140)}:${Math.floor(controls.target.z / 140)}`,
      };
    };
    const entered = probe(419, true);
    const held = probe(510);
    const exited = probe(521, false, true);
    const previous = new Set(held.snapshot.diagnostics.active.indices);
    const next = new Set(exited.snapshot.diagnostics.active.indices);
    const culled = [...previous].filter((index) => !next.has(index));
    const records = renderer.worldPartitionRuntime.records;
    const viewportHeight = renderer.renderer.domElement.height || 720;
    const view = camera.matrixWorldInverse.elements;
    const projection = camera.projectionMatrix.elements;
    const projectedRadius = (record) => {
      const x = record.matrix[12];
      const y = record.matrix[13];
      const z = record.matrix[14];
      const viewZ = view[2] * x + view[6] * y + view[10] * z + view[14];
      const clipX = projection[0] * (view[0] * x + view[4] * y + view[8] * z + view[12])
        + projection[8] * viewZ + projection[12];
      const clipY = projection[5] * (view[1] * x + view[5] * y + view[9] * z + view[13])
        + projection[9] * viewZ + projection[13];
      const clipW = -viewZ;
      if (!(clipW > 0)) return { visible: false, radius: 0 };
      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;
      const radius = 0.06 * Math.abs(projection[5]) * viewportHeight / (2 * clipW);
      return { visible: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1, radius };
    };
    const visibleCulled = culled.map((index) => projectedRadius(records[index])).filter((entry) => entry.visible);
    camera.position.fromArray(original.camera);
    controls.target.fromArray(original.target);
    camera.fov = original.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.update();
    renderer.updateWorldPartition(true, true);
    return {
      cellId: cell.id,
      entered, held, exited,
      culled: culled.length,
      maxVisibleCulledRadius: Math.max(0, ...visibleCulled.map((entry) => entry.radius)),
      restored: window.__CITYGEN_PARTITION_SNAPSHOT__(),
    };
  });
  assert.equal(boundary.entered.focusCell, boundary.held.focusCell,
    'same-cell threshold: 419m and 510m remain in one focus cell');
  assert.equal(boundary.held.focusCell, boundary.exited.focusCell,
    'same-cell threshold: 510m and 521m remain in one focus cell');
  assert.ok(boundary.entered.snapshot.diagnostics.cells.ids.includes(boundary.cellId),
    '419m boundary: newly entered cell is active');
  assert.ok(boundary.held.snapshot.diagnostics.cells.ids.includes(boundary.cellId),
    '510m boundary: active cell remains retained by hysteresis');
  assert.ok(!boundary.exited.snapshot.diagnostics.cells.ids.includes(boundary.cellId),
    '521m boundary: cell cleanly exits after hysteresis range');
  assert.ok(boundary.held.snapshot.diagnostics.hysteresis.enters >= boundary.entered.snapshot.diagnostics.hysteresis.enters,
    'boundary sweep: enter counter monotonic');
  assert.ok(boundary.exited.snapshot.diagnostics.hysteresis.exits > boundary.held.snapshot.diagnostics.hysteresis.exits,
    'boundary sweep: exit counter records the post-radius cull');
  assert.ok(boundary.culled > 0, 'boundary sweep: exercises real culling');
  assert.ok(boundary.maxVisibleCulledRadius < 1.25,
    `boundary sweep: no culled bistro bulb projects at >=1.25px (${boundary.maxVisibleCulledRadius})`);
  assertPose(boundary.restored, 'sf');
  await page.screenshot({ path: '.qa-citygen-world-partition-boundary.png' });
  report.captures.push('.qa-citygen-world-partition-boundary.png');

  report.cpu = await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    const controls = renderer.controls;
    const camera = renderer.camera;
    const baseTarget = controls.target.clone();
    const baseCameraOffset = camera.position.clone().sub(controls.target);
    const measure = (enabled) => {
      const updates = [];
      const renders = [];
      const activeCounts = [];
      const compactionsBefore = renderer.worldPartitionDiagnostics.updates.compactions;
      const original = renderer.updateWorldPartition;
      if (!enabled) renderer.updateWorldPartition = () => false;
      try {
        for (let index = 0; index < 180; index += 1) {
          // Change membership on every eighth normal runtime check. This
          // measures real compacting work, not the static no-op fast path.
          const side = Math.floor(index / 8) % 2;
          controls.target.copy(baseTarget);
          controls.target.x += side ? 700 : 0;
          camera.position.copy(controls.target).add(baseCameraOffset);
          camera.lookAt(controls.target);
          const updateStarted = performance.now();
          renderer.update(1 / 60, { time: 14 });
          updates.push(performance.now() - updateStarted);
          activeCounts.push(renderer.worldPartitionDiagnostics.active.instances);
          const renderStarted = performance.now();
          renderer.renderFrame();
          renders.push(performance.now() - renderStarted);
        }
      } finally {
        renderer.updateWorldPartition = original;
      }
      return {
        updates,
        renders,
        activeCounts: [...new Set(activeCounts)].sort((left, right) => left - right),
        compactions: renderer.worldPartitionDiagnostics.updates.compactions - compactionsBefore,
      };
    };
    renderer.updateWorldPartition(true, true);
    const off = measure(false);
    controls.target.copy(baseTarget);
    camera.position.copy(controls.target).add(baseCameraOffset);
    camera.lookAt(controls.target);
    renderer.updateWorldPartition(true, true);
    const on = measure(true);
    window.__CITYGEN__.setCameraPose('sf');
    renderer.controls.update();
    renderer.updateWorldPartition(true, true);
    return { off, on, final: window.__CITYGEN_PARTITION_SNAPSHOT__() };
  });
  const updateP95DeltaMs = percentile(report.cpu.on.updates, 0.95) - percentile(report.cpu.off.updates, 0.95);
  assert.ok(Number.isFinite(updateP95DeltaMs) && updateP95DeltaMs <= 0.35,
    `partition update p95 overhead <=0.35ms (${updateP95DeltaMs.toFixed(3)}ms)`);
  assert.equal(report.cpu.on.updates.length, 180, 'CPU: exact enabled update samples');
  assert.equal(report.cpu.off.updates.length, 180, 'CPU: exact disabled update samples');
  assert.equal(report.cpu.on.renders.length, 180, 'CPU: exact enabled render samples');
  assert.equal(report.cpu.off.renders.length, 180, 'CPU: exact disabled render samples');
  assertPose(report.cpu.final, 'sf');
  report.cpu = {
    frames: 180,
    updateP95DeltaMs: Number(updateP95DeltaMs.toFixed(4)),
    enabled: {
      medianMs: Number(percentile(report.cpu.on.updates, 0.5).toFixed(4)),
      p90Ms: Number(percentile(report.cpu.on.updates, 0.9).toFixed(4)),
      p95Ms: Number(percentile(report.cpu.on.updates, 0.95).toFixed(4)),
      maxMs: Number(Math.max(...report.cpu.on.updates).toFixed(4)),
      compactions: report.cpu.on.compactions,
      activeCounts: report.cpu.on.activeCounts,
    },
    disabled: {
      medianMs: Number(percentile(report.cpu.off.updates, 0.5).toFixed(4)),
      p90Ms: Number(percentile(report.cpu.off.updates, 0.9).toFixed(4)),
      p95Ms: Number(percentile(report.cpu.off.updates, 0.95).toFixed(4)),
      maxMs: Number(Math.max(...report.cpu.off.updates).toFixed(4)),
    },
    // Render samples are retained as evidence only; no presentation-frame-rate
    // conclusion is inferred from synchronous renderer CPU timing.
    renderP95DeltaMs: Number((percentile(report.cpu.on.renders, 0.95) - percentile(report.cpu.off.renders, 0.95)).toFixed(4)),
  };

  const rebuilt = await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const identity = window.__CITYGEN_WORLD_PARTITION_IDENTITY__;
    const oldMesh = renderer.worldPartitionRuntime.mesh;
    let oldMeshDisposed = false;
    oldMesh.addEventListener('dispose', () => { oldMeshDisposed = true; });
    await api.loadBuiltinSf();
    api.setTime(14);
    api.setCameraPose('sf');
    renderer.controls.update();
    renderer.updateWorldPartition(true, true);
    renderer.renderFrame();
    return {
      snapshot: window.__CITYGEN_PARTITION_SNAPSHOT__(),
      sameRenderer: renderer === identity.renderer,
      sameScene: renderer.scene === identity.scene,
      sameCanvas: renderer.renderer.domElement === identity.canvas,
      oldMeshDisposed,
      oldMeshUnreachable: !(() => {
        let found = false;
        renderer.scene.traverse((object) => { if (object === oldMesh) found = true; });
        return found;
      })(),
      replacementMesh: renderer.worldPartitionRuntime.mesh !== oldMesh,
    };
  });
  assertPose(rebuilt.snapshot, 'sf');
  assert.deepEqual({ renderer: rebuilt.sameRenderer, scene: rebuilt.sameScene, canvas: rebuilt.sameCanvas },
    { renderer: true, scene: true, canvas: true }, 'rebuild: canonical renderer/scene/canvas retained');
  assert.deepEqual({
    disposed: rebuilt.oldMeshDisposed,
    unreachable: rebuilt.oldMeshUnreachable,
    replaced: rebuilt.replacementMesh,
  }, { disposed: true, unreachable: true, replaced: true },
  'rebuild: old partition mesh emits disposal and is no longer reachable');
  assert.equal(rebuilt.snapshot.diagnostics.source.recordsChecksum, report.poses.sf.diagnostics.source.recordsChecksum,
    'rebuild: source checksum unchanged');
  assert.deepEqual(errors, [], 'canonical page: no errors');
  console.log(JSON.stringify({
    poses: Object.fromEntries(Object.entries(report.poses).map(([label, sample]) => [label, {
      active: sample.diagnostics.active.instances,
      cells: sample.diagnostics.cells.active,
      submittedTriangles: sample.diagnostics.mesh.submittedTriangles,
      checksum: sample.diagnostics.source.recordsChecksum,
    }])),
    captures: report.captures,
    cpu: report.cpu,
  }, null, 2));
} finally {
  await browser.close();
}

function snapshotPartition() {
  const api = window.__CITYGEN__;
  const renderer = api.getRenderer();
  const meshes = [];
  renderer.root.traverse((object) => {
    if (object?.userData?.kind === 'sf-partitioned-bistro-lights' || object?.name === 'sf-partitioned-bistro-lights') {
      const matrix = object.instanceMatrix?.array || [];
      const color = object.instanceColor?.array || [];
      meshes.push({
        name: object.name,
        kind: object.userData?.kind || null,
        instanced: Boolean(object.isInstancedMesh),
        count: object.count,
        capacity: object.instanceMatrix?.count || 0,
        matricesFinite: Array.from(matrix).every(Number.isFinite),
        colorsFinite: Array.from(color).every(Number.isFinite),
        instanceColorExists: Boolean(object.instanceColor),
        instanceColorDynamic: object.instanceColor?.usage === 35048,
      });
    }
  });
  const identity = window.__CITYGEN_WORLD_PARTITION_IDENTITY__;
  return {
    backend: renderer.rendererBackend,
    diagnostics: structuredClone(renderer.worldPartitionDiagnostics),
    partitionMeshes: meshes,
    interiors: api.getInteriorCoverage(),
    identity: {
      renderer: !identity || renderer === identity.renderer,
      scene: !identity || renderer.scene === identity.scene,
      canvas: !identity || renderer.renderer.domElement === identity.canvas,
      roots: renderer.scene.children.filter((child) => child.name === 'city-root').length,
      oneSceneCanvas: document.querySelectorAll('#scene-canvas').length,
      animationLoopAttached: typeof renderer.renderer._animation?._animationLoop === 'function'
        && renderer.renderer._animation?._requestId != null,
    },
  };
}
