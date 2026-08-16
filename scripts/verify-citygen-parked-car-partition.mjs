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
page.on('pageerror', (error) => errors.push(error.message));

const PASS = 'sf-world-partition-parked-cars-v1';
const EXPECTED_RECORDS_CHECKSUM = 3449863488;
const EXPECTED_INPUT_CHECKSUM = 3863393818;
const EXPECTED_POSES = Object.freeze({
  sf: { spots: 94, cells: 17, triangles: 9024 },
  night: { spots: 99, cells: 18, triangles: 9504 },
  aerial: { spots: 520, cells: 93, triangles: 49920 },
});
const EXPECTED_BODY_PALETTE = Object.freeze([
  '#7d4d4c', '#9a7a3e', '#46647a', '#4f7168', '#62586c', '#805c45', '#d7d3c8', '#718164',
]);
const EXPECTED_GLASS_PALETTE = Object.freeze(['#516a73', '#47636c', '#5c747b']);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];

function hashString(value = '') {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function serializeRecords(records) {
  return JSON.stringify(records.map((record) => ({
    index: record.index,
    x: record.x,
    z: record.z,
    heading: record.heading,
    cellId: record.cellId,
    bodyMatrix: record.bodyMatrix,
    bodyColor: record.bodyColor,
    cabMatrix: record.cabMatrix,
    cabColor: record.cabColor,
  })));
}

async function comparePngs(left, right) {
  return page.evaluate(async ({ leftBase64, rightBase64 }) => {
    const decode = async (base64) => createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const [a, b] = await Promise.all([decode(leftBase64), decode(rightBase64)]);
    const canvas = new OffscreenCanvas(a.width, a.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(a, 0, 0);
    const first = context.getImageData(0, 0, a.width, a.height).data;
    context.clearRect(0, 0, a.width, a.height);
    context.drawImage(b, 0, 0);
    const second = context.getImageData(0, 0, b.width, b.height).data;
    let changedPixels = 0;
    let channelDelta = 0;
    for (let index = 0; index < first.length; index += 4) {
      const delta = Math.abs(first[index] - second[index])
        + Math.abs(first[index + 1] - second[index + 1])
        + Math.abs(first[index + 2] - second[index + 2]);
      if (delta > 18) changedPixels += 1;
      channelDelta += delta;
    }
    return { width: a.width, height: a.height, changedPixels, channelDelta };
  }, { leftBase64: left.toString('base64'), rightBase64: right.toString('base64') });
}

async function ready() {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const api = window.__CITYGEN__;
    const state = api?.getState?.();
    const renderer = api?.getRenderer?.();
    return state?.generator === 'sf-builtin'
      && state?.buildings === 700
      && !state?.busy
      && renderer?.root
      && renderer?.parkedCarPartitionDiagnostics?.enabled;
  }, { timeout: 60000 });
}

async function samplePose(name, hour) {
  await page.evaluate(({ name, hour }) => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    api.setTime(hour);
    api.setCameraPose(name);
    renderer.controls.update();
    renderer.updateParkedCarPartition(true, true);
    renderer.renderFrame();
  }, { name, hour });
  return page.evaluate(() => window.__PARKED_CAR_PARTITION_SNAPSHOT__());
}

function assertCore(snapshot, label) {
  const diagnostics = snapshot.diagnostics;
  assert.equal(diagnostics.schemaVersion, 1, `${label}: schema version`);
  assert.equal(diagnostics.pass, PASS, `${label}: pass identity`);
  assert.equal(diagnostics.enabled, true, `${label}: partition enabled`);
  assert.equal(diagnostics.failure, null, `${label}: no partition failure`);
  assert.equal(diagnostics.focusSource, 'controls-target', `${label}: focus source`);
  assert.equal(diagnostics.sourceGenerator, 'sf-builtin', `${label}: explicit built-in SF source mode`);
  assert.equal(diagnostics.validationMode, 'sf-builtin-golden', `${label}: exact golden validation mode`);
  assert.deepEqual(diagnostics.expectedGolden, { enabled: true, spots: 520, cells: 93 },
    `${label}: exact built-in golden contract`);
  assert.deepEqual(diagnostics.source, {
    spots: 520,
    cells: 93,
    bodyTrianglesPerSpot: 76,
    cabTrianglesPerSpot: 20,
    trianglesPerSpot: 96,
    totalTriangles: 49920,
    recordsChecksum: diagnostics.source.recordsChecksum,
    recordsUnchanged: true,
    inputChecksumBefore: diagnostics.source.inputChecksumBefore,
    inputChecksumAfter: diagnostics.source.inputChecksumBefore,
    unchanged: true,
  }, `${label}: exact immutable 520-car source contract`);
  assert.equal(Number.isInteger(diagnostics.source.recordsChecksum), true, `${label}: records checksum is an integer`);
  assert.equal(Number.isInteger(diagnostics.source.inputChecksumBefore), true, `${label}: input checksum is an integer`);
  assert.equal(diagnostics.source.recordsChecksum, EXPECTED_RECORDS_CHECKSUM,
    `${label}: exact parked-car record checksum`);
  assert.equal(diagnostics.source.inputChecksumBefore, EXPECTED_INPUT_CHECKSUM,
    `${label}: exact immutable spot-source checksum`);
  assert.deepEqual(diagnostics.policy, {
    cellSizeMeters: 140,
    enterRadiusMeters: 420,
    exitRadiusMeters: 520,
    aerialHeightMeters: 500,
    updateIntervalFrames: 8,
  }, `${label}: exact partition policy`);
  assert.equal(diagnostics.cells.total, 93, `${label}: exact cell count`);
  assert.equal(diagnostics.cells.ids.length, diagnostics.cells.active, `${label}: active cell ids match count`);
  assert.equal(new Set(diagnostics.cells.ids).size, diagnostics.cells.ids.length, `${label}: active cell ids are unique`);
  assert.equal(diagnostics.active.spots + diagnostics.active.hiddenSpots, 520, `${label}: all logical cars retained`);
  assert.equal(diagnostics.active.indices.length, diagnostics.active.spots, `${label}: active indices match count`);
  assert.equal(new Set(diagnostics.active.indices).size, diagnostics.active.indices.length, `${label}: active indices unique`);
  assert.ok(diagnostics.active.indices.every((index) => Number.isInteger(index) && index >= 0 && index < 520),
    `${label}: active indices stay inside source`);
  assert.deepEqual({
    vertexCount: diagnostics.topology.body.vertexCount,
    indexCount: diagnostics.topology.body.indexCount,
    triangleCount: diagnostics.topology.body.triangleCount,
    indexed: diagnostics.topology.body.indexed,
    finiteTriangleAreas: diagnostics.topology.body.finiteTriangleAreas,
    vertexColors: diagnostics.topology.body.vertexColors,
    roles: diagnostics.topology.body.roles,
  }, {
    vertexCount: 228,
    indexCount: 0,
    triangleCount: 76,
    indexed: false,
    finiteTriangleAreas: true,
    vertexColors: true,
    roles: { paintHull: 20, tires: 48, lamps: 8 },
  }, `${label}: exact composite body hull and baked cue roles`);
  assert.deepEqual({
    vertexCount: diagnostics.topology.cab.vertexCount,
    indexCount: diagnostics.topology.cab.indexCount,
    triangleCount: diagnostics.topology.cab.triangleCount,
    indexed: diagnostics.topology.cab.indexed,
    finiteTriangleAreas: diagnostics.topology.cab.finiteTriangleAreas,
  }, {
    vertexCount: 60,
    indexCount: 0,
    triangleCount: 20,
    indexed: false,
    finiteTriangleAreas: true,
  }, `${label}: exact authored cab hull`);
  assert.equal(diagnostics.topology.body.minTriangleArea, 0.012750000000000001,
    `${label}: exact minimum body triangle area`);
  assert.equal(diagnostics.topology.body.minOutwardNormalDot, 0.07499999999999996,
    `${label}: exact minimum outward body normal dot`);
  assert.equal(diagnostics.topology.cab.minTriangleArea, 0.06119999999999999,
    `${label}: exact minimum cab triangle area`);
  assert.equal(diagnostics.topology.cab.minOutwardNormalDot, 0.4108891828726513,
    `${label}: exact minimum outward cab normal dot`);
  assert.deepEqual({
    cabVerticalOffsetMeters: diagnostics.topology.cabVerticalOffsetMeters,
    cabLongitudinalOffsetMeters: diagnostics.topology.cabLongitudinalOffsetMeters,
    distinctBodyCabMatrices: diagnostics.topology.distinctBodyCabMatrices,
  }, {
    cabVerticalOffsetMeters: 0.46,
    cabLongitudinalOffsetMeters: -0.18,
    distinctBodyCabMatrices: true,
  }, `${label}: exact body/cab separation`);
  assert.ok(diagnostics.source.trianglesPerSpot <= 100,
    `${label}: composite parked car stays within 100 triangles (${diagnostics.source.trianglesPerSpot})`);
  assert.deepEqual(diagnostics.visual, {
    bodyPalette: [...EXPECTED_BODY_PALETTE],
    glassPalette: [...EXPECTED_GLASS_PALETTE],
    hardEdgedHull: true,
    darkGlass: true,
  }, `${label}: exact parked-car visual identity`);
  assert.deepEqual(diagnostics.resources,
    { drawGroups: 2, geometries: 2, materials: 2, textures: 0 },
    `${label}: exact two-batch source resources`);
  for (const [key, name] of [
    ['bodies', 'sf-partitioned-parked-car-bodies'],
    ['cabs', 'sf-partitioned-parked-car-cabs'],
  ]) {
    const batch = diagnostics.batches[key];
    assert.equal(batch.name, name, `${label}: ${key} mesh name`);
    assert.equal(batch.capacity, 520, `${label}: ${key} capacity`);
    assert.equal(batch.count, diagnostics.active.spots, `${label}: ${key} compacted count`);
    const trianglesPerInstance = key === 'bodies' ? 76 : 20;
    assert.equal(batch.submittedTriangles, diagnostics.active.spots * trianglesPerInstance,
      `${label}: ${key} submitted triangles`);
    assert.equal(batch.matricesFinite, true, `${label}: ${key} matrices finite`);
    assert.equal(batch.colorsFinite, true, `${label}: ${key} colors finite`);
  }
  assert.equal(diagnostics.submittedTriangles, diagnostics.active.spots * 96,
    `${label}: combined submitted triangles`);
  assert.deepEqual(snapshot.identity,
    { renderer: true, scene: true, canvas: true, roots: 1, sceneCanvas: 1, loop: true },
    `${label}: one canonical runtime`);
  assert.deepEqual(snapshot.coverage, { registered: 700, functional: 700, accessible: 700 },
    `${label}: all building portals remain enterable`);
  assert.deepEqual(snapshot.traffic, { cars: 42, pedestrians: 48, batchedCars: 42 },
    `${label}: traffic and pedestrians unchanged`);
  assert.deepEqual(snapshot.sourceMode, {
    stateGenerator: 'sf-builtin',
    runtimeGenerator: 'sf-builtin',
    runtimeGoldenMode: true,
  }, `${label}: runtime and public state independently confirm golden SF mode`);
  assert.equal(snapshot.streetFurnitureCars, 520, `${label}: logical street-furniture count unchanged`);
  assert.deepEqual(snapshot.partitionMeshes.map((mesh) => mesh.name).sort(), [
    'sf-partitioned-parked-car-bodies',
    'sf-partitioned-parked-car-cabs',
  ], `${label}: exactly two parked-car meshes`);
  assert.ok(snapshot.partitionMeshes.every((mesh) => mesh.instanced
    && mesh.pass === PASS
    && mesh.parent === 'city-root'), `${label}: both batches share the canonical world root`);
  const bodyMesh = snapshot.partitionMeshes.find((mesh) => mesh.name === 'sf-partitioned-parked-car-bodies');
  const cabMesh = snapshot.partitionMeshes.find((mesh) => mesh.name === 'sf-partitioned-parked-car-cabs');
  assert.deepEqual({
    colorVertices: bodyMesh?.colorVertices,
    positionVertices: bodyMesh?.positionVertices,
    normalVertices: bodyMesh?.normalVertices,
    materialVertexColors: bodyMesh?.materialVertexColors,
    triangles: bodyMesh?.triangles,
  }, {
    colorVertices: 228,
    positionVertices: 228,
    normalVertices: 228,
    materialVertexColors: true,
    triangles: 76,
  },
  `${label}: composite body uses one vertex-colored geometry/material batch`);
  assert.deepEqual({
    colorVertices: cabMesh?.colorVertices,
    positionVertices: cabMesh?.positionVertices,
    normalVertices: cabMesh?.normalVertices,
    materialVertexColors: cabMesh?.materialVertexColors,
    triangles: cabMesh?.triangles,
  }, {
    colorVertices: 60,
    positionVertices: 60,
    normalVertices: 60,
    materialVertexColors: false,
    triangles: 20,
  },
  `${label}: cab remains the second and final material batch`);
  assert.deepEqual(snapshot.resourceProof, {
    meshes: 2,
    uniqueGeometries: 2,
    uniqueMaterials: 2,
    textureMaps: 0,
  }, `${label}: live parked meshes independently prove 2 geometries, 2 materials, and 0 maps`);
}

async function captureMatchedPair(label, setup, hour) {
  const staged = await page.evaluate(({ setup, hour }) => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    let hiddenTreeMeshes = 0;
    api.setTime(hour);
    if (setup !== 'close') {
      api.setCameraPose(setup);
      renderer.controls.update();
    } else {
      api.setCameraPose('sf');
      const records = renderer.parkedCarPartitionRuntime.records;
      const stagedRecords = records.map((seed) => records.filter((record) => (
        Math.hypot(record.x - seed.x, record.z - seed.z) <= 20
      ))).sort((left, right) => right.length - left.length
        || left[0].index - right[0].index)[0];
      const record = stagedRecords[0];
      const centerX = stagedRecords.reduce((sum, candidate) => sum + candidate.x, 0) / stagedRecords.length;
      const centerZ = stagedRecords.reduce((sum, candidate) => sum + candidate.z, 0) / stagedRecords.length;
      const centerY = stagedRecords.reduce((sum, candidate) => sum + candidate.bodyMatrix[13], 0) / stagedRecords.length;
      const forwardX = Math.sin(record.heading);
      const forwardZ = Math.cos(record.heading);
      const sideX = forwardZ;
      const sideZ = -forwardX;
      renderer.controls.target.set(centerX, centerY + 0.42, centerZ);
      renderer.camera.position.set(
        centerX - forwardX * 12 + sideX * 24,
        centerY + 5,
        centerZ - forwardZ * 12 + sideZ * 24,
      );
      renderer.camera.fov = 44;
      renderer.camera.updateProjectionMatrix();
      renderer.camera.lookAt(renderer.controls.target);
      renderer.controls.update();
      renderer.root.traverse((object) => {
        const materialColor = object.material?.color?.getHex?.();
        if (object.name?.toLowerCase().includes('tree')
          || (object.isInstancedMesh
            && object.count >= 500
            && [0x7a5a44, 0x7ba265, 0x93b56f].includes(materialColor))) {
          object.visible = false;
          hiddenTreeMeshes += 1;
        }
      });
    }
    renderer.updateParkedCarPartition(true, true);
    const traffic = api.getTraffic?.();
    if (traffic?.group) traffic.group.visible = false;
    window.__PARKED_CAR_FROZEN_UPDATE__ = renderer.update;
    window.__PARKED_CAR_FORCE_UPDATE__ = renderer.updateParkedCarPartition.bind(renderer);
    renderer.update = () => {};
    const closeVisible = setup === 'close'
      ? renderer.parkedCarPartitionRuntime.records.filter((record) => {
        const body = renderer.camera.position.clone().set(
          record.bodyMatrix[12], record.bodyMatrix[13], record.bodyMatrix[14],
        ).project(renderer.camera);
        const cab = renderer.camera.position.clone().set(
          record.cabMatrix[12], record.cabMatrix[13], record.cabMatrix[14],
        ).project(renderer.camera);
        return Math.abs(body.x) <= 0.92 && Math.abs(body.y) <= 0.88 && body.z >= -1 && body.z <= 1
          && Math.abs(cab.x) <= 0.92 && Math.abs(cab.y) <= 0.88 && cab.z >= -1 && cab.z <= 1;
      }).length
      : null;
    return {
      active: renderer.parkedCarPartitionDiagnostics.active.spots,
      closeVisible,
      hiddenTreeMeshes,
    };
  }, { setup, hour });
  await page.waitForTimeout(180);
  const candidatePath = setup === 'close'
    ? '.qa-citygen-parked-cars.png'
    : `.qa-citygen-parked-car-partition-${label}-candidate.png`;
  const candidate = await page.screenshot({ path: candidatePath });
  if (setup === 'close') await page.screenshot({ path: '.qa-citygen-parked-cars-clean.png' });
  await page.evaluate(() => window.__PARKED_CAR_FORCE_UPDATE__(true, true, true));
  await page.waitForTimeout(180);
  const forceAll = await page.screenshot({ path: `.qa-citygen-parked-car-partition-${label}-force-all.png` });
  await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    renderer.update = window.__PARKED_CAR_FROZEN_UPDATE__;
    window.__PARKED_CAR_FORCE_UPDATE__(true, true, false);
    delete window.__PARKED_CAR_FROZEN_UPDATE__;
    delete window.__PARKED_CAR_FORCE_UPDATE__;
  });
  return { staged, diff: await comparePngs(candidate, forceAll), candidatePath };
}

try {
  await ready();
  await page.addStyleTag({
    content: '.brand,.toolbar,.readout,.hint,.minimap,.inspector,.status-pill,.osm-overlay{display:none!important}',
  });
  await page.evaluate((source) => {
    window.__PARKED_CAR_PARTITION_SNAPSHOT__ = (0, eval)(`(${source})`);
    const renderer = window.__CITYGEN__.getRenderer();
    window.__PARKED_CAR_PARTITION_IDENTITY__ = {
      renderer,
      scene: renderer.scene,
      root: renderer.root,
      canvas: renderer.renderer.domElement,
      animationLoop: renderer.renderer._animation?._animationLoop,
    };
  }, snapshot.toString());

  const baseline = await page.evaluate(() => ({
    portals: window.__CITYGEN__.getBuildingPortals(),
    records: window.__CITYGEN__.getRenderer().parkedCarPartitionRuntime.records.map((record) => ({
      index: record.index,
      x: record.x,
      z: record.z,
      heading: record.heading,
      cellId: record.cellId,
      bodyMatrix: [...record.bodyMatrix],
      bodyColor: [...record.bodyColor],
      cabMatrix: [...record.cabMatrix],
      cabColor: [...record.cabColor],
    })),
    diagnostics: structuredClone(window.__CITYGEN__.getRenderer().parkedCarPartitionDiagnostics),
  }));
  assert.equal(baseline.records.length, 520, 'source exposes exactly 520 parked-car records');
  assert.deepEqual(baseline.records.map((record) => record.index), Array.from({ length: 520 }, (_, index) => index),
    'source record indices are exact and contiguous');
  assert.ok(baseline.records.every((record) => Number.isFinite(record.x)
    && Number.isFinite(record.z)
    && Number.isFinite(record.heading)
    && typeof record.cellId === 'string'
    && record.bodyMatrix.length === 16
    && record.cabMatrix.length === 16
    && record.bodyColor.length === 3
    && record.cabColor.length === 3
    && [...record.bodyMatrix, ...record.cabMatrix, ...record.bodyColor, ...record.cabColor].every(Number.isFinite)),
  'all source records are finite and structurally exact');
  assert.equal(hashString(serializeRecords(baseline.records)), baseline.diagnostics.source.recordsChecksum,
    'independent FNV-1a record checksum matches diagnostics');
  assert.ok(baseline.records.every((record) => {
    const bodyCabMatrixDistinct = record.bodyMatrix.some((value, index) => value !== record.cabMatrix[index]);
    const bodyCabColorDistinct = record.bodyColor.some((value, index) => value !== record.cabColor[index]);
    const verticalOffset = record.cabMatrix[13] - record.bodyMatrix[13];
    const expectedCabX = record.x - Math.sin(record.heading) * 0.18;
    const expectedCabZ = record.z - Math.cos(record.heading) * 0.18;
    return bodyCabMatrixDistinct
      && bodyCabColorDistinct
      && Math.abs(verticalOffset - 0.46) < 1e-4
      && Math.abs(record.bodyMatrix[12] - record.x) < 2e-4
      && Math.abs(record.bodyMatrix[14] - record.z) < 2e-4
      && Math.abs(record.cabMatrix[12] - expectedCabX) < 2e-4
      && Math.abs(record.cabMatrix[14] - expectedCabZ) < 2e-4;
  }), 'every authored hull has distinct body/cab transforms and colors with exact offsets');

  const poses = {
    sf: await samplePose('sf', 14),
    night: await samplePose('night', 22),
    aerial: await samplePose('aerial', 14),
  };
  for (const [name, result] of Object.entries(poses)) {
    assertCore(result, name);
    const expected = EXPECTED_POSES[name];
    assert.deepEqual({
      spots: result.diagnostics.active.spots,
      cells: result.diagnostics.cells.active,
      triangles: result.diagnostics.submittedTriangles,
    }, expected, `${name}: exact measured reset visibility`);
    assert.equal(result.diagnostics.active.aerial, name === 'aerial', `${name}: aerial state`);
    assert.equal(result.diagnostics.active.forceAll, false, `${name}: reset pose is not force-all`);
    assert.deepEqual(result.portals, baseline.portals, `${name}: portal registry remains byte-stable`);
  }

  const forceEquivalence = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const runtime = renderer.parkedCarPartitionRuntime;
    api.setCameraPose('aerial');
    renderer.updateParkedCarPartition(true, true, true);
    const all = {
      bodyMatrix: new Float32Array(runtime.bodies.instanceMatrix.array),
      bodyColor: new Float32Array(runtime.bodies.instanceColor.array),
      cabMatrix: new Float32Array(runtime.cabs.instanceMatrix.array),
      cabColor: new Float32Array(runtime.cabs.instanceColor.array),
    };
    api.setCameraPose('sf');
    renderer.controls.update();
    renderer.updateParkedCarPartition(true, true);
    let mismatches = 0;
    for (let target = 0; target < renderer.parkedCarPartitionDiagnostics.active.indices.length; target += 1) {
      const source = renderer.parkedCarPartitionDiagnostics.active.indices[target];
      const record = runtime.records[source];
      for (let element = 0; element < 16; element += 1) {
        const bodyValue = runtime.bodies.instanceMatrix.array[target * 16 + element];
        const cabValue = runtime.cabs.instanceMatrix.array[target * 16 + element];
        if (bodyValue !== record.bodyMatrix[element] || bodyValue !== all.bodyMatrix[source * 16 + element]) mismatches += 1;
        if (cabValue !== record.cabMatrix[element] || cabValue !== all.cabMatrix[source * 16 + element]) mismatches += 1;
      }
      for (let element = 0; element < 3; element += 1) {
        const bodyValue = runtime.bodies.instanceColor.array[target * 3 + element];
        const cabValue = runtime.cabs.instanceColor.array[target * 3 + element];
        if (bodyValue !== record.bodyColor[element] || bodyValue !== all.bodyColor[source * 3 + element]) mismatches += 1;
        if (cabValue !== record.cabColor[element] || cabValue !== all.cabColor[source * 3 + element]) mismatches += 1;
      }
    }
    return { mismatches, snapshot: window.__PARKED_CAR_PARTITION_SNAPSHOT__() };
  });
  assert.equal(forceEquivalence.mismatches, 0,
    'candidate body/cab matrices and colors are byte-identical to source and force-all');
  assertCore(forceEquivalence.snapshot, 'force equivalence restore');

  const hysteresis = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const runtime = renderer.parkedCarPartitionRuntime;
    const cell = runtime.cells.find((candidate) => candidate.indices.length > 0);
    const controls = renderer.controls;
    const camera = renderer.camera;
    const original = {
      camera: camera.position.toArray(),
      target: controls.target.toArray(),
      fov: camera.fov,
    };
    const cameraOffset = camera.position.clone().sub(controls.target);
    const probe = (edgeDistance, reset = false, natural = false) => {
      const dx = edgeDistance === 419 ? 300 : edgeDistance === 510 ? 390 : 400;
      const dz = Math.sqrt(edgeDistance * edgeDistance - dx * dx);
      controls.target.set(cell.x + 70 + dx, original.target[1], cell.z + 70 + dz);
      camera.position.copy(controls.target).add(cameraOffset);
      camera.lookAt(controls.target);
      controls.update();
      if (natural) {
        for (let frame = 0; frame < 8; frame += 1) renderer.updateParkedCarPartition(false);
      } else {
        renderer.updateParkedCarPartition(true, reset);
      }
      return {
        diagnostics: structuredClone(renderer.parkedCarPartitionDiagnostics),
        focusCell: `${Math.floor(controls.target.x / 140)}:${Math.floor(controls.target.z / 140)}`,
      };
    };
    const entered = probe(419, true);
    const held = probe(510);
    const exited = probe(521, false, true);
    const heldSet = new Set(held.diagnostics.active.indices);
    const exitedSet = new Set(exited.diagnostics.active.indices);
    const culled = [...heldSet].filter((index) => !exitedSet.has(index));
    camera.updateMatrixWorld(true);
    const viewportHeight = renderer.renderer.domElement.height || 720;
    const projectionScale = Math.abs(camera.projectionMatrix.elements[5]);
    const visibleCulled = [];
    for (const index of culled) {
      const record = runtime.records[index];
      const point = camera.position.clone().set(record.bodyMatrix[12], record.bodyMatrix[13], record.bodyMatrix[14]);
      const viewPoint = point.clone().applyMatrix4(camera.matrixWorldInverse);
      const projected = point.clone().project(camera);
      if (viewPoint.z < 0 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1) {
        visibleCulled.push(2 * 2.2 * projectionScale * viewportHeight / (2 * -viewPoint.z));
      }
    }
    camera.position.fromArray(original.camera);
    controls.target.fromArray(original.target);
    camera.fov = original.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.update();
    renderer.updateParkedCarPartition(true, true);
    return {
      cellId: cell.id,
      entered,
      held,
      exited,
      culled: culled.length,
      maxVisibleCulledDiameterPixels: Math.max(0, ...visibleCulled),
      restored: window.__PARKED_CAR_PARTITION_SNAPSHOT__(),
    };
  });
  assert.equal(hysteresis.entered.focusCell, hysteresis.held.focusCell,
    '419m and 510m probes remain inside one focus cell');
  assert.equal(hysteresis.held.focusCell, hysteresis.exited.focusCell,
    '510m and 521m probes remain inside one focus cell');
  assert.ok(hysteresis.entered.diagnostics.cells.ids.includes(hysteresis.cellId), '419m cell naturally enters');
  assert.ok(hysteresis.held.diagnostics.cells.ids.includes(hysteresis.cellId), '510m cell remains held');
  assert.ok(!hysteresis.exited.diagnostics.cells.ids.includes(hysteresis.cellId), '521m cell naturally exits');
  assert.ok(hysteresis.exited.diagnostics.hysteresis.exits > hysteresis.held.diagnostics.hysteresis.exits,
    'natural 521m update records a real cell exit');
  assert.ok(hysteresis.culled > 0, 'hysteresis boundary exercises real parked-car culling');
  assert.ok(hysteresis.maxVisibleCulledDiameterPixels <= 8,
    `culled car projected pop stays <=8px (${hysteresis.maxVisibleCulledDiameterPixels.toFixed(3)}px)`);
  assertCore(hysteresis.restored, 'hysteresis restore');

  const visualParity = {
    sf: await captureMatchedPair('sf', 'sf', 14),
    night: await captureMatchedPair('night', 'night', 22),
    close: await captureMatchedPair('close', 'close', 14),
  };
  for (const [label, evidence] of Object.entries(visualParity)) {
    assert.equal(evidence.diff.width, 1280, `${label}: matched capture width`);
    assert.equal(evidence.diff.height, 720, `${label}: matched capture height`);
    assert.ok(evidence.staged.active > 0 && evidence.staged.active < 520,
      `${label}: candidate capture exercises real partitioning`);
    assert.ok(evidence.diff.changedPixels <= 20000,
      `${label}: candidate/force-all changed pixels remain below 2.2% (${evidence.diff.changedPixels})`);
    assert.ok(evidence.diff.channelDelta <= 2500000,
      `${label}: candidate/force-all channel delta remains bounded (${evidence.diff.channelDelta})`);
  }
  assert.equal(visualParity.close.candidatePath, '.qa-citygen-parked-cars.png',
    'close parked-car composition is captured at the required path');
  assert.ok(visualParity.close.staged.closeVisible >= 4,
    `close 3/4 composition projects at least four complete body/cab pairs (${visualParity.close.staged.closeVisible})`);
  assert.ok(visualParity.close.staged.hiddenTreeMeshes >= 3,
    `close 3/4 composition hides the three tree instancers (${visualParity.close.staged.hiddenTreeMeshes})`);

  const lifecycle = await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const identity = window.__PARKED_CAR_PARTITION_IDENTITY__;
    const oldRuntime = renderer.parkedCarPartitionRuntime;
    const oldMeshes = [oldRuntime.bodies, oldRuntime.cabs];
    const oldGeometries = oldMeshes.map((mesh) => mesh.geometry);
    const oldMaterials = oldMeshes.map((mesh) => mesh.material);
    const oldMaps = oldMaterials.map((material) => material.map).filter(Boolean);
    const meshDisposeEvents = oldMeshes.map(() => 0);
    const geometryDisposeEvents = oldGeometries.map(() => 0);
    const materialDisposeEvents = oldMaterials.map(() => 0);
    oldMeshes.forEach((mesh, index) => mesh.addEventListener('dispose', () => { meshDisposeEvents[index] += 1; }));
    oldGeometries.forEach((geometry, index) => geometry.addEventListener('dispose', () => {
      geometryDisposeEvents[index] += 1;
    }));
    oldMaterials.forEach((material, index) => material.addEventListener('dispose', () => {
      materialDisposeEvents[index] += 1;
    }));
    await api.loadBuiltinSf();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (renderer.parkedCarPartitionRuntime?.bodies !== oldMeshes[0] && !api.getState().busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    api.setTime(14);
    api.setCameraPose('sf');
    renderer.controls.update();
    renderer.updateParkedCarPartition(true, true);
    const reachability = { meshes: false, geometries: false, materials: false, maps: false };
    renderer.scene.traverse((object) => {
      if (oldMeshes.includes(object)) reachability.meshes = true;
      if (oldGeometries.includes(object.geometry)) reachability.geometries = true;
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      if (materials.some((material) => oldMaterials.includes(material))) reachability.materials = true;
      if (materials.some((material) => oldMaps.includes(material.map))) reachability.maps = true;
    });
    const newRuntime = renderer.parkedCarPartitionRuntime;
    const newMeshes = [newRuntime.bodies, newRuntime.cabs];
    const newGeometries = newMeshes.map((mesh) => mesh.geometry);
    const newMaterials = newMeshes.map((mesh) => mesh.material);
    return {
      disposalEvents: {
        meshes: meshDisposeEvents,
        geometries: geometryDisposeEvents,
        materials: materialDisposeEvents,
      },
      oldResourceCounts: {
        meshes: new Set(oldMeshes).size,
        geometries: new Set(oldGeometries).size,
        materials: new Set(oldMaterials).size,
        maps: new Set(oldMaps).size,
      },
      newResourceCounts: {
        meshes: new Set(newMeshes).size,
        geometries: new Set(newGeometries).size,
        materials: new Set(newMaterials).size,
        maps: new Set(newMaterials.map((material) => material.map).filter(Boolean)).size,
      },
      reachability,
      replacements: {
        meshes: newMeshes.every((resource) => !oldMeshes.includes(resource)),
        geometries: newGeometries.every((resource) => !oldGeometries.includes(resource)),
        materials: newMaterials.every((resource) => !oldMaterials.includes(resource)),
      },
      lifecycle: structuredClone(renderer.parkedCarPartitionDiagnostics.lifecycle),
      sameRenderer: renderer === identity.renderer,
      sameScene: renderer.scene === identity.scene,
      sameCanvas: renderer.renderer.domElement === identity.canvas,
      snapshot: window.__PARKED_CAR_PARTITION_SNAPSHOT__(),
      records: renderer.parkedCarPartitionRuntime.records.map((record) => ({
        index: record.index,
        x: record.x,
        z: record.z,
        heading: record.heading,
        cellId: record.cellId,
        bodyMatrix: [...record.bodyMatrix],
        bodyColor: [...record.bodyColor],
        cabMatrix: [...record.cabMatrix],
        cabColor: [...record.cabColor],
      })),
    };
  });
  assert.deepEqual(lifecycle.oldResourceCounts,
    { meshes: 2, geometries: 2, materials: 2, maps: 0 },
    'pre-rebuild parked presentation owns exactly two meshes/geometries/materials and zero maps');
  assert.deepEqual(lifecycle.disposalEvents,
    { meshes: [1, 1], geometries: [1, 1], materials: [1, 1] },
    'clear/rebuild disposes every old parked mesh, geometry, and material exactly once');
  assert.deepEqual(lifecycle.reachability,
    { meshes: false, geometries: false, materials: false, maps: false },
    'no old parked mesh or resource reference remains reachable from the scene');
  assert.deepEqual(lifecycle.newResourceCounts,
    { meshes: 2, geometries: 2, materials: 2, maps: 0 },
    'rebuild installs exactly one fresh two-batch parked presentation');
  assert.deepEqual(lifecycle.replacements,
    { meshes: true, geometries: true, materials: true },
    'rebuild replaces every parked mesh, geometry, and material reference once');
  assert.deepEqual(lifecycle.lifecycle, { registrations: 1, disposals: 1 },
    'partition lifecycle records one old disposal and one replacement registration');
  assert.deepEqual({ renderer: lifecycle.sameRenderer, scene: lifecycle.sameScene, canvas: lifecycle.sameCanvas },
    { renderer: true, scene: true, canvas: true }, 'rebuild preserves renderer, scene, and canvas identity');
  assert.deepEqual(lifecycle.records, baseline.records, 'rebuild reproduces all 520 records byte-for-byte');
  assert.deepEqual(lifecycle.snapshot.portals, baseline.portals, 'rebuild preserves all portal records byte-for-byte');
  assertCore(lifecycle.snapshot, 'rebuild');

  const cpu = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const controls = renderer.controls;
    const baseTarget = controls.target.clone();
    const cameraOffset = renderer.camera.position.clone().sub(controls.target);
    const measure = (enabled) => {
      const times = [];
      const activeCounts = new Set();
      const compactionsBefore = renderer.parkedCarPartitionDiagnostics.updates.compactions;
      for (let frame = 0; frame < 180; frame += 1) {
        controls.target.copy(baseTarget);
        controls.target.x += (Math.floor(frame / 8) % 3) * 520;
        renderer.camera.position.copy(controls.target).add(cameraOffset);
        renderer.camera.lookAt(controls.target);
        const started = performance.now();
        if (enabled) renderer.updateParkedCarPartition(false);
        times.push(performance.now() - started);
        if (enabled) activeCounts.add(renderer.parkedCarPartitionDiagnostics.active.spots);
      }
      return {
        times,
        activeCounts: [...activeCounts].sort((left, right) => left - right),
        compactions: enabled
          ? renderer.parkedCarPartitionDiagnostics.updates.compactions - compactionsBefore
          : 0,
      };
    };
    renderer.updateParkedCarPartition(true, true);
    const off = measure(false);
    renderer.updateParkedCarPartition(true, true);
    const on = measure(true);
    api.setCameraPose('sf');
    renderer.controls.update();
    renderer.updateParkedCarPartition(true, true);
    return { off, on, final: window.__PARKED_CAR_PARTITION_SNAPSHOT__() };
  });
  const offP95 = percentile(cpu.off.times, 0.95);
  const onP95 = percentile(cpu.on.times, 0.95);
  const p95DeltaMs = onP95 - offP95;
  assert.equal(cpu.off.times.length, 180, 'CPU: exact disabled samples');
  assert.equal(cpu.on.times.length, 180, 'CPU: exact enabled samples');
  assert.ok(cpu.on.compactions >= 10, `CPU: moving focus performs real compactions (${cpu.on.compactions})`);
  assert.ok(cpu.on.activeCounts.length >= 2, `CPU: moving focus covers distinct active counts (${cpu.on.activeCounts})`);
  assert.ok(Number.isFinite(p95DeltaMs) && p95DeltaMs <= 0.35,
    `CPU: moving-focus parked-car overhead <=0.35ms (${p95DeltaMs.toFixed(4)}ms)`);
  assertCore(cpu.final, 'CPU restore');

  const osmPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const osmErrors = [];
  osmPage.on('pageerror', (error) => osmErrors.push(error.message));
  await osmPage.goto(url, { waitUntil: 'load', timeout: 60000 });
  await osmPage.waitForFunction(() => {
    const api = window.__CITYGEN__;
    return api?.getState?.().generator === 'sf-builtin'
      && api?.getRenderer?.().parkedCarPartitionDiagnostics?.enabled;
  }, { timeout: 60000 });
  await osmPage.route('**/*', (route) => route.abort());
  const osmStructural = await osmPage.evaluate(async () => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const city = api.getCity();
    const sourceSnapshot = JSON.stringify({
      meta: city.meta,
      segments: city.segments,
      buildings: city.buildings,
      streets: city.streets,
    });
    const openStreetMapCity = {
      ...city,
      meta: { ...city.meta, generator: 'openstreetmap' },
    };
    const identity = {
      renderer,
      scene: renderer.scene,
      canvas: renderer.renderer.domElement,
    };
    renderer.clearCity();
    await renderer.buildCity(openStreetMapCity, { day: true });
    renderer.updateParkedCarPartition(true, true);
    const runtime = renderer.parkedCarPartitionRuntime;
    const meshes = [runtime.bodies, runtime.cabs];
    return {
      diagnostics: structuredClone(renderer.parkedCarPartitionDiagnostics),
      runtime: {
        sourceGenerator: runtime.sourceGenerator,
        goldenMode: runtime.goldenMode,
        records: runtime.records.length,
        cells: runtime.cells.length,
      },
      resources: {
        meshes: new Set(meshes).size,
        geometries: new Set(meshes.map((mesh) => mesh.geometry)).size,
        materials: new Set(meshes.map((mesh) => mesh.material)).size,
        maps: new Set(meshes.map((mesh) => mesh.material.map).filter(Boolean)).size,
      },
      identity: {
        renderer: renderer === identity.renderer,
        scene: renderer.scene === identity.scene,
        canvas: renderer.renderer.domElement === identity.canvas,
        roots: renderer.scene.children.filter((object) => object.name === 'city-root').length,
      },
      inputStillUnchanged: sourceSnapshot === JSON.stringify({
        meta: city.meta,
        segments: city.segments,
        buildings: city.buildings,
        streets: city.streets,
      }),
    };
  });
  await osmPage.close();
  const osmDiagnostics = osmStructural.diagnostics;
  assert.equal(osmDiagnostics.failure, null, 'live OSM structural mode accepts the in-memory SF source');
  assert.equal(osmDiagnostics.sourceGenerator, 'openstreetmap', 'live OSM exposes its generator explicitly');
  assert.equal(osmDiagnostics.validationMode, 'live-osm-structural', 'live OSM uses structural validation mode');
  assert.deepEqual(osmDiagnostics.expectedGolden, { enabled: false, spots: null, cells: null },
    'live OSM never claims the built-in 520/93 golden source');
  assert.deepEqual(osmStructural.runtime, {
    sourceGenerator: 'openstreetmap',
    goldenMode: false,
    records: osmDiagnostics.source.spots,
    cells: osmDiagnostics.source.cells,
  }, 'runtime independently confirms non-golden live OSM mode');
  assert.ok(osmDiagnostics.source.spots > 0 && osmDiagnostics.source.spots <= 520,
    `live OSM structural spot count stays bounded (${osmDiagnostics.source.spots})`);
  assert.ok(osmDiagnostics.source.cells > 0 && osmDiagnostics.source.cells <= osmDiagnostics.source.spots,
    `live OSM structural cell count stays bounded (${osmDiagnostics.source.cells})`);
  assert.equal(osmDiagnostics.source.trianglesPerSpot, 96, 'live OSM keeps exact authored topology cost');
  assert.equal(osmDiagnostics.source.totalTriangles, osmDiagnostics.source.spots * 96,
    'live OSM total triangles derive from its structural source count');
  assert.equal(osmDiagnostics.source.recordsUnchanged, true, 'live OSM records checksum stays unchanged');
  assert.equal(osmDiagnostics.source.unchanged, true, 'live OSM input checksum stays unchanged');
  assert.equal(osmDiagnostics.active.spots + osmDiagnostics.active.hiddenSpots, osmDiagnostics.source.spots,
    'live OSM active and hidden counts preserve every source record');
  assert.equal(osmDiagnostics.active.indices.length, osmDiagnostics.active.spots,
    'live OSM active indices match active count');
  assert.ok(osmDiagnostics.active.indices.every((index) => Number.isInteger(index)
    && index >= 0 && index < osmDiagnostics.source.spots), 'live OSM active indices stay in source bounds');
  assert.equal(osmDiagnostics.batches.bodies.capacity, osmDiagnostics.source.spots,
    'live OSM body capacity derives from source spots');
  assert.equal(osmDiagnostics.batches.cabs.capacity, osmDiagnostics.source.spots,
    'live OSM cab capacity derives from source spots');
  assert.equal(osmDiagnostics.batches.bodies.count, osmDiagnostics.active.spots,
    'live OSM body batch matches active source count');
  assert.equal(osmDiagnostics.batches.cabs.count, osmDiagnostics.active.spots,
    'live OSM cab batch matches active source count');
  assert.ok(osmDiagnostics.batches.bodies.matricesFinite && osmDiagnostics.batches.bodies.colorsFinite
    && osmDiagnostics.batches.cabs.matricesFinite && osmDiagnostics.batches.cabs.colorsFinite,
  'live OSM matrices and colors remain finite');
  assert.deepEqual(osmStructural.resources, { meshes: 2, geometries: 2, materials: 2, maps: 0 },
    'live OSM structural mode retains exactly two resource batches and zero maps');
  assert.deepEqual(osmStructural.identity, { renderer: true, scene: true, canvas: true, roots: 1 },
    'live OSM structural probe remains inside the canonical renderer and world root');
  assert.equal(osmStructural.inputStillUnchanged, true, 'live OSM presentation leaves the in-memory SF source untouched');
  assert.deepEqual(osmErrors, [], 'live OSM structural probe has no browser errors');

  assert.deepEqual(errors, [], 'no browser page errors');
  console.log(JSON.stringify({
    result: 'PASS',
    url,
    source: {
      spots: baseline.records.length,
      cells: baseline.diagnostics.source.cells,
      recordsChecksum: baseline.diagnostics.source.recordsChecksum,
      inputChecksum: baseline.diagnostics.source.inputChecksumBefore,
      triangles: baseline.diagnostics.source.totalTriangles,
    },
    poses: Object.fromEntries(Object.entries(poses).map(([name, result]) => [name, {
      spots: result.diagnostics.active.spots,
      cells: result.diagnostics.cells.active,
      triangles: result.diagnostics.submittedTriangles,
    }])),
    hysteresis: {
      culled: hysteresis.culled,
      maxVisibleCulledDiameterPixels: hysteresis.maxVisibleCulledDiameterPixels,
    },
    visualParity: Object.fromEntries(Object.entries(visualParity).map(([name, evidence]) => [name, evidence.diff])),
    closeComposition: visualParity.close.staged,
    cpu: { offP95, onP95, p95DeltaMs, compactions: cpu.on.compactions, activeCounts: cpu.on.activeCounts },
    liveOsmStructural: {
      spots: osmDiagnostics.source.spots,
      cells: osmDiagnostics.source.cells,
      validationMode: osmDiagnostics.validationMode,
      expectedGolden: osmDiagnostics.expectedGolden,
    },
    screenshot: '.qa-citygen-parked-cars.png',
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}

function snapshot() {
  const api = window.__CITYGEN__;
  const renderer = api.getRenderer();
  const runtime = renderer.parkedCarPartitionRuntime;
  const identity = window.__PARKED_CAR_PARTITION_IDENTITY__;
  const traffic = api.getTraffic();
  const batch = traffic.getVehicleBatchDiagnostics();
  const partitionMeshes = [];
  renderer.root.traverse((object) => {
    if (object.userData?.worldPartitionPass === 'sf-world-partition-parked-cars-v1') {
      partitionMeshes.push({
        name: object.name,
        instanced: Boolean(object.isInstancedMesh),
        pass: object.userData.worldPartitionPass,
        parent: object.parent?.name || null,
        colorVertices: object.geometry?.getAttribute?.('color')?.count || 0,
        positionVertices: object.geometry?.getAttribute?.('position')?.count || 0,
        normalVertices: object.geometry?.getAttribute?.('normal')?.count || 0,
        materialVertexColors: Boolean(object.material?.vertexColors),
        triangles: (object.geometry?.index?.count ?? object.geometry?.getAttribute?.('position')?.count ?? 0) / 3,
        geometryRef: object.geometry,
        materialRef: object.material,
        mapRef: object.material?.map || null,
      });
    }
  });
  const partitionGeometries = new Set(partitionMeshes.map((entry) => entry.geometryRef));
  const partitionMaterials = new Set(partitionMeshes.map((entry) => entry.materialRef));
  const textureMaps = new Set(partitionMeshes
    .map((entry) => entry.mapRef)
    .filter(Boolean));
  const coverage = api.getInteriorCoverage();
  return {
    diagnostics: structuredClone(renderer.parkedCarPartitionDiagnostics),
    coverage: {
      registered: coverage.registered,
      functional: coverage.functional,
      accessible: coverage.accessible,
    },
    traffic: {
      cars: traffic.cars.length,
      pedestrians: traffic.pedestrians.length,
      batchedCars: batch.logicalCars,
    },
    streetFurnitureCars: renderer.streetFurniture.cars,
    partitionMeshes: partitionMeshes.map(({ geometryRef, materialRef, mapRef, ...entry }) => entry),
    resourceProof: {
      meshes: partitionMeshes.length,
      uniqueGeometries: partitionGeometries.size,
      uniqueMaterials: partitionMaterials.size,
      textureMaps: textureMaps.size,
    },
    sourceMode: {
      stateGenerator: api.getState().generator,
      runtimeGenerator: runtime.sourceGenerator,
      runtimeGoldenMode: runtime.goldenMode,
    },
    portals: api.getBuildingPortals(),
    identity: {
      renderer: renderer === identity.renderer,
      scene: renderer.scene === identity.scene,
      canvas: renderer.renderer.domElement === identity.canvas,
      roots: renderer.scene.children.filter((object) => object.name === 'city-root').length,
      sceneCanvas: document.querySelectorAll('#scene-canvas').length,
      loop: renderer.renderer._animation?._animationLoop === identity.animationLoop
        && typeof identity.animationLoop === 'function',
    },
    runtime: {
      records: runtime.records.length,
      cells: runtime.cells.length,
    },
  };
}
