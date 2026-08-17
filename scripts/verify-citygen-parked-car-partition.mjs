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
  sf: { spots: 94, cells: 17, triangles: 16544 },
  night: { spots: 99, cells: 18, triangles: 17424 },
  aerial: { spots: 520, cells: 93, triangles: 91520 },
});
const EXPECTED_BODY_PALETTE = Object.freeze([
  '#7d4d4c', '#9a7a3e', '#46647a', '#4f7168', '#62586c', '#805c45', '#d7d3c8', '#718164',
]);
const EXPECTED_GLASS_PALETTE = Object.freeze(['#516a73', '#47636c', '#5c747b']);
const HEAD_C9FC541_RENDER_BASELINE = Object.freeze({
  drawGroups: 2,
  geometries: 2,
  materials: 2,
  textures: 0,
  bodyTrianglesPerSpot: 92,
  cabTrianglesPerSpot: 20,
  trianglesPerSpot: 112,
});
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

async function captureHeadC9fc541Baseline(setup, hour) {
  const proof = await page.evaluate(({ setup, hour }) => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const runtime = renderer.parkedCarPartitionRuntime;
    const bodies = runtime.bodies;
    const cabs = runtime.cabs;
    const original = {
      bodyGeometry: bodies.geometry,
      cabGeometry: cabs.geometry,
      cabMaterial: cabs.material,
    };
    const bodyPosition = bodies.geometry.getAttribute('position');
    const bodyColor = bodies.geometry.getAttribute('color');
    const cabPosition = cabs.geometry.getAttribute('position');
    const positions = [];
    const colors = [];
    const appendSourceTriangle = (triangleIndex, sourcePosition, sourceColor, overrideColor = null) => {
      const positionOffset = triangleIndex * 9;
      const colorOffset = triangleIndex * 9;
      for (let index = 0; index < 9; index += 1) positions.push(sourcePosition.array[positionOffset + index]);
      if (overrideColor) {
        for (let index = 0; index < 3; index += 1) colors.push(...overrideColor);
      } else {
        for (let index = 0; index < 9; index += 1) colors.push(sourceColor.array[colorOffset + index]);
      }
    };
    // HEAD c9fc541 is the immediately preceding presentation: the same
    // 20-triangle paint hull and 64 radial wheel-face triangles, followed by
    // the same eight lamp triangles. The candidate inserts 64 tread-ring
    // triangles between the wheel faces and lamps.
    for (let triangle = 0; triangle < 84; triangle += 1) {
      appendSourceTriangle(triangle, bodyPosition, bodyColor,
        triangle >= 20 ? [0.16, 0.16, 0.17] : null);
    }
    for (let triangle = 148; triangle < 156; triangle += 1) {
      appendSourceTriangle(triangle, bodyPosition, bodyColor);
    }
    const oldBodyGeometry = bodies.geometry.clone();
    oldBodyGeometry.setAttribute('position', new bodyPosition.constructor(new Float32Array(positions), 3));
    oldBodyGeometry.setAttribute('color', new bodyColor.constructor(new Float32Array(colors), 3));
    oldBodyGeometry.deleteAttribute('normal');
    oldBodyGeometry.computeVertexNormals();
    oldBodyGeometry.computeBoundingBox();
    oldBodyGeometry.computeBoundingSphere();
    const oldCabGeometry = cabs.geometry.clone();
    oldCabGeometry.computeVertexNormals();
    const oldCabMaterial = cabs.material.clone();
    bodies.geometry = oldBodyGeometry;
    cabs.geometry = oldCabGeometry;
    cabs.material = oldCabMaterial;
    window.__PARKED_CAR_HEAD_BASELINE_ORIGINAL__ = original;
    renderer.renderFrame();
    return {
      bodyTriangles: (oldBodyGeometry.getAttribute('position').count / 3),
      cabTriangles: (oldCabGeometry.getAttribute('position').count / 3),
      bodyVertices: oldBodyGeometry.getAttribute('position').count,
      cabVertices: oldCabGeometry.getAttribute('position').count,
      setup,
      hour,
      wheelFaceColorsExact: colors.slice(20 * 9, 84 * 9).every((value, index) => (
        Math.abs(value - [0.16, 0.16, 0.17][index % 3]) <= 1e-7
      )),
      wheelFaceColorSample: [...colors.slice(20 * 9, 20 * 9 + 3)],
    };
  }, { setup, hour });
  const baselinePath = setup === 'close'
    ? '.qa-citygen-parked-car-details-baseline.png'
    : setup === 'wheel-depth'
      ? '.qa-citygen-parked-car-wheel-depth-baseline.png'
      : setup === 'wheel-depth-night'
        ? '.qa-citygen-parked-car-wheel-depth-night-baseline.png'
        : '.qa-citygen-parked-car-details-night-baseline.png';
  const baseline = await page.screenshot({ path: baselinePath });
  const restored = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const runtime = renderer.parkedCarPartitionRuntime;
    const temporary = {
      bodyGeometry: runtime.bodies.geometry,
      cabGeometry: runtime.cabs.geometry,
      cabMaterial: runtime.cabs.material,
    };
    // The current presentation is restored by the page-side references kept
    // on the window; this avoids touching source records or partition state.
    const saved = window.__PARKED_CAR_HEAD_BASELINE_ORIGINAL__;
    runtime.bodies.geometry = saved.bodyGeometry;
    runtime.cabs.geometry = saved.cabGeometry;
    runtime.cabs.material = saved.cabMaterial;
    temporary.bodyGeometry.dispose();
    temporary.cabGeometry.dispose();
    temporary.cabMaterial.dispose();
    renderer.renderFrame();
    return {
      bodyGeometry: runtime.bodies.geometry === saved.bodyGeometry,
      cabGeometry: runtime.cabs.geometry === saved.cabGeometry,
      cabMaterial: runtime.cabs.material === saved.cabMaterial,
      resourceProof: {
        meshes: 2,
        geometries: new Set([runtime.bodies.geometry, runtime.cabs.geometry]).size,
        materials: new Set([runtime.bodies.material, runtime.cabs.material]).size,
        maps: new Set([runtime.bodies.material.map, runtime.cabs.material.map].filter(Boolean)).size,
      },
    };
  });
  return { baselinePath, baseline, proof, restored };
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
  assert.equal(diagnostics.schemaVersion, 3, `${label}: schema version`);
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
    bodyTrianglesPerSpot: 156,
    cabTrianglesPerSpot: 20,
    trianglesPerSpot: 176,
    totalTriangles: 91520,
    recordsChecksum: diagnostics.source.recordsChecksum,
    recordsUnchanged: true,
    inputChecksumBefore: diagnostics.source.inputChecksumBefore,
    inputChecksumAfter: diagnostics.source.inputChecksumBefore,
    unchanged: true,
    roadYSource: 'terrain.heightAt+roadLift',
    roadLiftMeters: diagnostics.source.roadLiftMeters,
    roadYExcludedFromRecordsChecksum: true,
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
    vertexCount: 468,
    indexCount: 0,
    triangleCount: 156,
    indexed: false,
    finiteTriangleAreas: true,
    vertexColors: true,
    roles: { paintHull: 20, wheelSideDiscs: 64, wheelTreads: 64, lamps: 8 },
  }, `${label}: exact composite body hull, radial wheel discs, tread rings, and lamp roles`);
  assert.deepEqual(diagnostics.topology.body.triangleRanges, {
    paintHull: { start: 0, count: 20 },
    wheelSideDiscs: { start: 20, count: 64 },
    wheelTreads: { start: 84, count: 64 },
    lamps: { start: 148, count: 8 },
  }, `${label}: exact body triangle role ranges`);
  assert.deepEqual(diagnostics.topology.body.vertexRanges, {
    paintHull: { start: 0, count: 60 },
    wheelSideDiscs: { start: 60, count: 192 },
    wheelTreads: { start: 252, count: 192 },
    lamps: { start: 444, count: 24 },
  }, `${label}: exact body vertex role ranges`);
  const {
    minOutwardNormalDot,
    minTreadOutwardNormalDot,
    outerFacePaintModulatedHubHighlight,
    contact,
    colors,
    ...wheelTopology
  } = diagnostics.topology.body.wheels;
  assert.deepEqual(wheelTopology, {
    count: 4,
    facesPerWheel: 2,
    segmentsPerFace: 8,
    triangleCount: 64,
    treadSegmentsPerWheel: 8,
    treadTrianglesPerWheel: 16,
    treadTriangleCount: 64,
    totalTriangleCount: 128,
    normalizedRadiusY: 0.4482758621,
    normalizedRadiusZ: 0.0666666667,
    normalizedCenterY: -0.1034482759,
    normalizedOuterX: 0.55,
    normalizedInnerX: 0.47,
  }, `${label}: exact radial wheel-disc and tread-ring topology contract`);
  assert.ok(Number.isFinite(minOutwardNormalDot) && minOutwardNormalDot > 0,
    `${label}: wheel-disc normals face outward`);
  assert.ok(Number.isFinite(minTreadOutwardNormalDot) && minTreadOutwardNormalDot > 0,
    `${label}: tread-ring normals face outward`);
  assert.equal(colors.composition, 'raw-geometry-tone-times-instance-paint-linear',
    `${label}: wheel tones declare linear paint multiplication`);
  assert.deepEqual(colors.rawGeometryTones, {
    paintModulatedHubHighlight: [1.18, 1.25, 1.3],
    outerFaceRadial: [0.18, 0.18, 0.19],
    innerFace: [0.12, 0.12, 0.13],
    tread: [0.1, 0.1, 0.11],
  }, `${label}: exact raw wheel geometry tones`);
  assert.deepEqual({
    vertexColorSpace: 'linear-srgb',
    emissive: false,
  }, { vertexColorSpace: colors.vertexColorSpace, emissive: colors.emissive },
  `${label}: exact non-emissive wheel tones`);
  assert.equal(colors.effectivePaletteProducts.length, 8,
    `${label}: effective wheel products cover all eight paint palette entries`);
  for (const product of colors.effectivePaletteProducts) {
    assert.ok(product.finite && product.bounded, `${label}: palette product ${product.paletteIndex} is finite/bounded`);
    assert.deepEqual(product.hubHighlight,
      product.instancePaintLinear.map((value, index) => value * colors.rawGeometryTones.paintModulatedHubHighlight[index]),
      `${label}: hub highlight is paint-modulated, not neutral silver`);
    assert.deepEqual(product.tread,
      product.instancePaintLinear.map((value, index) => value * colors.rawGeometryTones.tread[index]),
      `${label}: tread is paint-modulated and dark`);
  }
  assert.deepEqual(colors.productBounds, [0, 1], `${label}: effective wheel product bounds`);
  assert.equal(colors.productsFinite, true, `${label}: effective wheel products finite`);
  assert.equal(colors.productsBounded, true, `${label}: effective wheel products bounded`);
  assert.equal(outerFacePaintModulatedHubHighlight, true,
    `${label}: paint-modulated hub highlight is restricted to outer wheel faces`);
  assert.deepEqual(contact, {
    normalizedLowestY: diagnostics.topology.body.wheels.contact.normalizedLowestY,
    bodyScaleYMeters: 0.58,
    bodyCenterAboveRoadMeters: 0.32,
    toleranceMeters: 1e-6,
    roadYSource: 'terrain.heightAt+roadLift',
    roadLiftMeters: contact.roadLiftMeters,
    roadYExcludedFromRecordsChecksum: true,
    sourceSpotsChecked: 520,
    sourceRoadYFinite: true,
    minSourceRoadYMeters: contact.minSourceRoadYMeters,
    maxSourceRoadYMeters: contact.maxSourceRoadYMeters,
    finite: true,
    minClearanceMeters: contact.minClearanceMeters,
    maxClearanceMeters: contact.maxClearanceMeters,
    maxAbsClearanceMeters: contact.maxAbsClearanceMeters,
    allOnRoadPlane: true,
  }, `${label}: exact all-source wheel contact contract`);
  assert.ok(Math.abs(contact.normalizedLowestY - (-0.1034482759 - 0.4482758621)) <= 5e-9,
    `${label}: wheel/tread lowest normalized Y is exact (${contact.normalizedLowestY})`);
  assert.ok(contact.maxAbsClearanceMeters <= contact.toleranceMeters,
    `${label}: wheel contact clearance remains within tolerance`);
  assert.deepEqual({
    vertexCount: diagnostics.topology.cab.vertexCount,
    indexCount: diagnostics.topology.cab.indexCount,
    triangleCount: diagnostics.topology.cab.triangleCount,
    indexed: diagnostics.topology.cab.indexed,
    finiteTriangleAreas: diagnostics.topology.cab.finiteTriangleAreas,
    vertexColors: diagnostics.topology.cab.vertexColors,
    roles: diagnostics.topology.cab.roles,
    surfaceTones: diagnostics.topology.cab.surfaceTones,
  }, {
    vertexCount: 60,
    indexCount: 0,
    triangleCount: 20,
    indexed: false,
    finiteTriangleAreas: true,
    vertexColors: true,
    roles: { sideWindows: 8, rearWindow: 2, roof: 2, windshield: 2, lowerSills: 6 },
    surfaceTones: {
      sideWindows: [0.72, 0.88, 0.96],
      rearWindow: [0.52, 0.67, 0.75],
      roof: [0.34, 0.42, 0.46],
      windshield: [1.18, 1.38, 1.48],
      lowerSills: [0.43, 0.52, 0.56],
    },
  }, `${label}: exact authored cab hull`);
  assert.ok(Number.isFinite(diagnostics.topology.body.minTriangleArea)
    && diagnostics.topology.body.minTriangleArea > 0,
  `${label}: body triangles have finite positive area`);
  assert.ok(Number.isFinite(diagnostics.topology.body.minOutwardNormalDot)
    && diagnostics.topology.body.minOutwardNormalDot > 0,
  `${label}: body normals face outward`);
  assert.ok(Number.isFinite(diagnostics.topology.cab.minTriangleArea)
    && diagnostics.topology.cab.minTriangleArea > 0,
  `${label}: cab triangles have finite positive area`);
  assert.ok(Number.isFinite(diagnostics.topology.cab.minOutwardNormalDot)
    && diagnostics.topology.cab.minOutwardNormalDot > 0,
  `${label}: cab normals face outward`);
  assert.deepEqual({
    cabVerticalOffsetMeters: diagnostics.topology.cabVerticalOffsetMeters,
    cabLongitudinalOffsetMeters: diagnostics.topology.cabLongitudinalOffsetMeters,
    distinctBodyCabMatrices: diagnostics.topology.distinctBodyCabMatrices,
  }, {
    cabVerticalOffsetMeters: 0.46,
    cabLongitudinalOffsetMeters: -0.18,
    distinctBodyCabMatrices: true,
  }, `${label}: exact body/cab separation`);
  assert.equal(diagnostics.source.trianglesPerSpot, 176,
    `${label}: detailed parked car uses the exact 176-triangle authored budget`);
  assert.deepEqual(diagnostics.visual, {
    pass: 'sf-parked-car-wheel-depth-v2',
    bodyPalette: [...EXPECTED_BODY_PALETTE],
    glassPalette: [...EXPECTED_GLASS_PALETTE],
    hardEdgedHull: true,
    darkGlass: true,
    wheelCount: 4,
    wheelFacesPerWheel: 2,
    wheelSegmentsPerFace: 8,
    wheelRadiusMeters: 0.26,
    wheelContactClearanceMeters: 0,
    wheelLateralProtrusionMeters: 0.09,
    wheelAxleOffsetMeters: 1.248,
    wheelTreadSegmentsPerWheel: 8,
    wheelTreadTrianglesPerWheel: 16,
    wheelTreadTriangleCount: 64,
    wheelTotalTriangleCount: 128,
    wheelThicknessMeters: 0.144,
    wheelPaintModulatedHubHighlight: true,
    wheelEmissive: false,
    cabSurfaceTones: {
      sideWindows: [0.72, 0.88, 0.96],
      rearWindow: [0.52, 0.67, 0.75],
      roof: [0.34, 0.42, 0.46],
      windshield: [1.18, 1.38, 1.48],
      lowerSills: [0.43, 0.52, 0.56],
    },
    cabUniqueToneCount: 5,
  }, `${label}: exact parked-car visual identity`);
  assert.deepEqual(diagnostics.resources,
    { drawGroups: 2, geometries: 2, materials: 2, textures: 0 },
    `${label}: exact two-batch source resources`);
  assert.deepEqual(diagnostics.resources, {
    drawGroups: HEAD_C9FC541_RENDER_BASELINE.drawGroups,
    geometries: HEAD_C9FC541_RENDER_BASELINE.geometries,
    materials: HEAD_C9FC541_RENDER_BASELINE.materials,
    textures: HEAD_C9FC541_RENDER_BASELINE.textures,
  }, `${label}: candidate preserves HEAD c9fc541 resource/draw baseline`);
  assert.equal(diagnostics.source.bodyTrianglesPerSpot
    - HEAD_C9FC541_RENDER_BASELINE.bodyTrianglesPerSpot, 64,
  `${label}: wheel-depth detail adds exactly 64 body triangles per spot over HEAD c9fc541`);
  assert.equal(diagnostics.source.cabTrianglesPerSpot
    - HEAD_C9FC541_RENDER_BASELINE.cabTrianglesPerSpot, 0,
  `${label}: cab triangle cost remains unchanged from HEAD c9fc541`);
  assert.equal(diagnostics.source.trianglesPerSpot
    - HEAD_C9FC541_RENDER_BASELINE.trianglesPerSpot, 64,
  `${label}: wheel-depth detail delta is exactly 64 triangles per parked spot`);
  for (const [key, name] of [
    ['bodies', 'sf-partitioned-parked-car-bodies'],
    ['cabs', 'sf-partitioned-parked-car-cabs'],
  ]) {
    const batch = diagnostics.batches[key];
    assert.equal(batch.name, name, `${label}: ${key} mesh name`);
    assert.equal(batch.capacity, 520, `${label}: ${key} capacity`);
    assert.equal(batch.count, diagnostics.active.spots, `${label}: ${key} compacted count`);
    const trianglesPerInstance = key === 'bodies' ? 156 : 20;
    assert.equal(batch.submittedTriangles, diagnostics.active.spots * trianglesPerInstance,
      `${label}: ${key} submitted triangles`);
    assert.equal(batch.matricesFinite, true, `${label}: ${key} matrices finite`);
    assert.equal(batch.colorsFinite, true, `${label}: ${key} colors finite`);
  }
  assert.equal(diagnostics.submittedTriangles, diagnostics.active.spots * 176,
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
  assert.ok(snapshot.wheelGeometry?.finite, `${label}: wheel geometry positions and first instance transform are finite`);
  assert.ok(snapshot.wheelGeometry?.localMinY < -0.5,
    `${label}: transformed wheel geometry extends below the paint hull (${snapshot.wheelGeometry?.localMinY})`);
  assert.ok(snapshot.wheelGeometry?.localAbsX >= 0.55,
    `${label}: transformed wheel geometry has the authored lateral disc extent (${snapshot.wheelGeometry?.localAbsX})`);
  assert.ok(snapshot.wheelGeometry?.worldMinY < snapshot.wheelGeometry?.bodyCenterY,
    `${label}: transformed wheel geometry reaches below the body center for ground contact`);
  assert.deepEqual({
    records: snapshot.wheelContactProof?.records,
    wheelVertices: snapshot.wheelContactProof?.wheelVertices,
    finite: snapshot.wheelContactProof?.finite,
  }, {
    records: 520,
    wheelVertices: 384,
    finite: true,
  }, `${label}: every source record has finite wheel contact/normal proof`);
  assert.ok(snapshot.wheelContactProof.maxAbsRoadPlaneErrorMeters <= 2e-5,
    `${label}: every transformed wheel contacts its independently reconstructed road plane (${snapshot.wheelContactProof.maxAbsRoadPlaneErrorMeters})`);
  assert.ok(snapshot.wheelContactProof.minClearanceMeters >= -2e-5
    && snapshot.wheelContactProof.maxClearanceMeters <= 2e-5,
  `${label}: no wheel is below or floating above its road plane`);
  assert.equal(snapshot.wheelContactProof.sourceRoadY?.roadYSource,
    'terrain.heightAt+roadLift', `${label}: contact proof uses independent source road-Y`);
  assert.equal(snapshot.wheelContactProof.sourceRoadY?.roadYExcludedFromRecordsChecksum, true,
    `${label}: derived source road-Y never mutates record identity/checksum`);
  assert.equal(snapshot.wheelContactProof.sourceRoadY?.finite, true,
    `${label}: all independent source road-Y samples are finite`);
  assert.ok(snapshot.wheelContactProof.minOutwardFaceNormalDot > 0.99,
    `${label}: wheel-disc winding produces outward-facing unit normals`);
  assert.ok(Math.abs(diagnostics.topology.body.wheels.minOutwardNormalDot
    - snapshot.wheelContactProof.minOutwardCentroidDotMeters) <= 1e-6,
  `${label}: production wheel minOutwardNormalDot matches independent centroid-origin geometry proof`);
  assert.ok(snapshot.wheelContactProof.minOutwardTreadNormalDot > 0.2,
    `${label}: tread sidewall winding produces outward radial normals (${snapshot.wheelContactProof.minOutwardTreadNormalDot})`);
  assert.equal(snapshot.wheelContactProof.treadContinuity, true,
    `${label}: every tread segment has continuous inner/outer ring vertices`);
  assert.equal(snapshot.wheelContactProof.faceRimContinuity, true,
    `${label}: face rims and tread rims share exact coordinates and multiplicity`);
  assert.equal(snapshot.wheelContactProof.colorProof, true,
    `${label}: hub cue is outer-face-only and tread colors are dark/non-emissive`);
  assert.deepEqual(snapshot.wheelContactProof.effectiveColorProof, {
    entries: 8,
    finite: true,
    bounded: true,
    productsMatchSourcePaint: true,
  }, `${label}: effective hub/tread tones match each source paint instance`);
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
    colorVertices: 468,
    positionVertices: 468,
    normalVertices: 468,
    materialVertexColors: true,
    triangles: 156,
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
    materialVertexColors: true,
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
  const closeComposition = ['close', 'close-night', 'wheel-depth', 'wheel-depth-night'].includes(setup);
  const staged = await page.evaluate(({ setup, hour, closeComposition }) => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    let hiddenTreeMeshes = 0;
    api.setTime(hour);
    if (!['close', 'close-night', 'wheel-depth', 'wheel-depth-night'].includes(setup)) {
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
      const depthShot = setup === 'wheel-depth' || setup === 'wheel-depth-night';
      const rearDistance = depthShot ? 4.5 : 12;
      const sideDistance = depthShot ? 8 : 24;
      renderer.camera.position.set(
        centerX - forwardX * rearDistance + sideX * sideDistance,
        centerY + (depthShot ? 2.8 : 5),
        centerZ - forwardZ * rearDistance + sideZ * sideDistance,
      );
      renderer.camera.fov = depthShot ? 42 : 44;
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
    const closeVisible = closeComposition
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
    const viewportWidth = renderer.renderer.domElement.width || 1280;
    const projectedWidths = closeComposition
      ? renderer.parkedCarPartitionRuntime.records.map((record) => {
        const center = renderer.camera.position.clone().set(
          record.bodyMatrix[12], record.bodyMatrix[13], record.bodyMatrix[14],
        );
        const forwardX = Math.sin(record.heading);
        const forwardZ = Math.cos(record.heading);
        const sideX = forwardZ;
        const sideZ = -forwardX;
        const left = center.clone().set(
          center.x - sideX * 2.2, center.y, center.z - sideZ * 2.2,
        ).project(renderer.camera);
        const right = center.clone().set(
          center.x + sideX * 2.2, center.y, center.z + sideZ * 2.2,
        ).project(renderer.camera);
        const projectedCenter = center.clone().project(renderer.camera);
        if (projectedCenter.z < -1 || projectedCenter.z > 1
          || Math.abs(projectedCenter.x) > 1 || Math.abs(projectedCenter.y) > 1) return null;
        return Math.abs(right.x - left.x) * viewportWidth * 0.5;
      }).filter((width) => Number.isFinite(width))
      : [];
    return {
      active: renderer.parkedCarPartitionDiagnostics.active.spots,
      closeVisible,
      maxProjectedCarWidthPixels: Math.max(0, ...projectedWidths),
      hiddenTreeMeshes,
    };
  }, { setup, hour, closeComposition });
  await page.waitForTimeout(180);
  const candidatePath = setup === 'close'
    ? '.qa-citygen-parked-car-details.png'
    : setup === 'close-night'
      ? '.qa-citygen-parked-car-details-night.png'
      : setup === 'wheel-depth'
        ? '.qa-citygen-parked-car-wheel-depth.png'
        : setup === 'wheel-depth-night'
          ? '.qa-citygen-parked-car-wheel-depth-night.png'
          : `.qa-citygen-parked-car-partition-${label}-candidate.png`;
  const candidate = await page.screenshot({ path: candidatePath });
  if (setup === 'close') {
    await page.screenshot({ path: '.qa-citygen-parked-cars.png' });
    await page.screenshot({ path: '.qa-citygen-parked-cars-clean.png' });
  }
    const historicalBaseline = closeComposition
      ? await captureHeadC9fc541Baseline(setup, hour)
    : null;
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
  return {
    staged,
    diff: await comparePngs(candidate, forceAll),
    candidatePath,
    historicalBaseline: historicalBaseline
      ? {
        path: historicalBaseline.baselinePath,
        proof: historicalBaseline.proof,
        restored: historicalBaseline.restored,
        diff: await comparePngs(candidate, historicalBaseline.baseline),
      }
      : null,
  };
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
    closeNight: await captureMatchedPair('close-night', 'close-night', 22),
    wheelDepth: await captureMatchedPair('wheel-depth', 'wheel-depth', 14),
    wheelDepthNight: await captureMatchedPair('wheel-depth-night', 'wheel-depth-night', 22),
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
  assert.equal(visualParity.close.candidatePath, '.qa-citygen-parked-car-details.png',
    'day close parked-car composition is captured at the required detail path');
  assert.ok(visualParity.close.staged.closeVisible >= 4,
    `close 3/4 composition projects at least four complete body/cab pairs (${visualParity.close.staged.closeVisible})`);
  assert.ok(visualParity.close.staged.hiddenTreeMeshes >= 3,
    `close 3/4 composition hides the three tree instancers (${visualParity.close.staged.hiddenTreeMeshes})`);
  assert.equal(visualParity.closeNight.candidatePath, '.qa-citygen-parked-car-details-night.png',
    'night close parked-car composition is captured at the required detail path');
  assert.ok(visualParity.closeNight.staged.closeVisible >= 4,
    `night close 3/4 composition projects at least four complete body/cab pairs (${visualParity.closeNight.staged.closeVisible})`);
  assert.ok(visualParity.closeNight.staged.hiddenTreeMeshes >= 3,
    `night close 3/4 composition hides the three tree instancers (${visualParity.closeNight.staged.hiddenTreeMeshes})`);
  for (const [label, evidence] of [
    ['wheel-depth', visualParity.wheelDepth],
    ['wheel-depth-night', visualParity.wheelDepthNight],
  ]) {
    assert.equal(evidence.candidatePath, label === 'wheel-depth'
      ? '.qa-citygen-parked-car-wheel-depth.png'
      : '.qa-citygen-parked-car-wheel-depth-night.png',
    `${label}: deterministic natural curb depth shot path`);
    assert.ok(evidence.staged.closeVisible >= 2,
      `${label}: depth shot retains at least two complete parked cars (${evidence.staged.closeVisible})`);
    assert.ok(evidence.staged.maxProjectedCarWidthPixels >= 300
      && evidence.staged.maxProjectedCarWidthPixels <= 450,
    `${label}: foreground car occupies 300–450px for wheel/hub review (${evidence.staged.maxProjectedCarWidthPixels.toFixed(2)}px)`);
    assert.ok(evidence.staged.hiddenTreeMeshes >= 3,
      `${label}: depth shot is free of tree instancer obstruction (${evidence.staged.hiddenTreeMeshes})`);
    assert.ok(evidence.historicalBaseline?.path.endsWith(
      label === 'wheel-depth' ? 'wheel-depth-baseline.png' : 'wheel-depth-night-baseline.png',
    ), `${label}: c9fc541 baseline retained beside candidate`);
    assert.equal(evidence.historicalBaseline.proof.wheelFaceColorsExact, true,
      `${label}: c9fc541 baseline raw wheel-face colors are exact paint-neutral tire tones`);
    assert.ok(evidence.historicalBaseline.diff.changedPixels > 0,
      `${label}: tread-depth candidate differs from c9fc541 baseline`);
  }
  for (const [label, evidence] of [['day', visualParity.close], ['night', visualParity.closeNight]]) {
    assert.deepEqual(evidence.historicalBaseline.proof, {
      bodyTriangles: 92,
      cabTriangles: 20,
      bodyVertices: 276,
      cabVertices: 60,
      setup: label === 'day' ? 'close' : 'close-night',
      hour: label === 'day' ? 14 : 22,
      wheelFaceColorsExact: true,
      wheelFaceColorSample: [0.16, 0.16, 0.17],
    }, `${label}: exact HEAD c9fc541 92/20 baseline topology with segmented cab`);
    assert.deepEqual(evidence.historicalBaseline.restored, {
      bodyGeometry: true,
      cabGeometry: true,
      cabMaterial: true,
      resourceProof: { meshes: 2, geometries: 2, materials: 2, maps: 0 },
    }, `${label}: current presentation/resources restored after baseline capture`);
    assert.ok(evidence.historicalBaseline.diff.changedPixels > 0,
      `${label}: detailed candidate changes pixels against the retained HEAD c9fc541 baseline`);
    assert.ok(evidence.historicalBaseline.diff.changedPixels < 600000,
      `${label}: candidate/baseline comparison remains bounded (${evidence.historicalBaseline.diff.changedPixels})`);
  }

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
  assert.equal(osmDiagnostics.source.trianglesPerSpot, 176, 'live OSM keeps exact authored topology cost');
  assert.equal(osmDiagnostics.source.totalTriangles, osmDiagnostics.source.spots * 176,
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
    baselineComparison: Object.fromEntries(['close', 'closeNight', 'wheelDepth', 'wheelDepthNight'].map((name) => [name, {
      path: visualParity[name].historicalBaseline.path,
      bodyTriangles: visualParity[name].historicalBaseline.proof.bodyTriangles,
      cabTriangles: visualParity[name].historicalBaseline.proof.cabTriangles,
      changedPixels: visualParity[name].historicalBaseline.diff.changedPixels,
      channelDelta: visualParity[name].historicalBaseline.diff.channelDelta,
      restored: visualParity[name].historicalBaseline.restored,
    }])),
    depthDayNightDiff: {
      day: visualParity.wheelDepth.diff,
      night: visualParity.wheelDepthNight.diff,
      dayBaseline: visualParity.wheelDepth.historicalBaseline.diff,
      nightBaseline: visualParity.wheelDepthNight.historicalBaseline.diff,
    },
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
  const bodyPosition = runtime.bodies.geometry?.getAttribute?.('position');
  let localMinY = Infinity;
  let localAbsX = 0;
  let finite = Boolean(bodyPosition && bodyPosition.count);
  for (let index = 0; index < (bodyPosition?.count || 0); index += 1) {
    const x = bodyPosition.getX(index);
    const y = bodyPosition.getY(index);
    localMinY = Math.min(localMinY, y);
    localAbsX = Math.max(localAbsX, Math.abs(x));
    finite = finite && Number.isFinite(x) && Number.isFinite(y)
      && Number.isFinite(bodyPosition.getZ(index));
  }
  const firstBodyMatrix = runtime.bodies.instanceMatrix?.array;
  const bodyCenterY = firstBodyMatrix?.[13];
  const bodyYScale = firstBodyMatrix
    ? Math.hypot(firstBodyMatrix[4], firstBodyMatrix[5], firstBodyMatrix[6])
    : NaN;
  const wheelPositionStart = 20 * 9;
  const wheelDiscEnd = 84 * 9;
  const wheelTreadEnd = 148 * 9;
  const wheelDiscPositions = bodyPosition?.array?.slice(wheelPositionStart, wheelDiscEnd) || [];
  const wheelTreadPositions = bodyPosition?.array?.slice(wheelDiscEnd, wheelTreadEnd) || [];
  const wheelPositions = bodyPosition?.array?.slice(wheelPositionStart, wheelTreadEnd) || [];
  let wheelNormalMinOutwardDot = Infinity;
  let wheelCentroidMinOutwardDot = Infinity;
  let wheelNormalFinite = wheelDiscPositions.length === 64 * 9;
  for (let offset = 0; offset < wheelDiscPositions.length; offset += 9) {
    const triangleIndex = offset / 9;
    const ax = wheelDiscPositions[offset];
    const ay = wheelDiscPositions[offset + 1];
    const az = wheelDiscPositions[offset + 2];
    const bx = wheelDiscPositions[offset + 3];
    const by = wheelDiscPositions[offset + 4];
    const bz = wheelDiscPositions[offset + 5];
    const cx = wheelDiscPositions[offset + 6];
    const cy = wheelDiscPositions[offset + 7];
    const cz = wheelDiscPositions[offset + 8];
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    const centerX = (ax + bx + cx) / 3;
    const wheelFaceIndex = triangleIndex % 16;
    const outwardSign = (Math.sign(centerX) || 0) * (wheelFaceIndex < 8 ? 1 : -1);
    const dot = length > 0 ? (nx / length) * outwardSign : -Infinity;
    wheelNormalMinOutwardDot = Math.min(wheelNormalMinOutwardDot, dot);
    const wheelIndex = Math.floor(triangleIndex / 16);
    const wheelSide = wheelIndex >= 2 ? 1 : -1;
    const wheelCenterZ = wheelIndex % 2 === 0 ? -0.32 : 0.32;
    const wheelCenterX = wheelSide * 0.51;
    const normalLength = length || 1;
    const centroidX = (ax + bx + cx) / 3;
    const centroidY = (ay + by + cy) / 3;
    const centroidZ = (az + bz + cz) / 3;
    const centroidDot = (nx * (centroidX - wheelCenterX)
      + ny * (centroidY + 0.1034482759)
      + nz * (centroidZ - wheelCenterZ)) / normalLength;
    wheelCentroidMinOutwardDot = Math.min(wheelCentroidMinOutwardDot, centroidDot);
    wheelNormalFinite = wheelNormalFinite && [ax, ay, az, bx, by, bz, cx, cy, cz, length, dot]
      .every(Number.isFinite);
  }
  let treadNormalMinOutwardDot = Infinity;
  let treadNormalFinite = wheelTreadPositions.length === 64 * 9;
  let treadContinuity = true;
  for (let wheelIndex = 0; wheelIndex < 4; wheelIndex += 1) {
    const side = wheelIndex >= 2 ? 1 : -1;
    const centerZ = wheelIndex % 2 === 0 ? -0.32 : 0.32;
    const outer = new Map();
    const inner = new Map();
    const faceOuter = new Map();
    const faceInner = new Map();
    let rimCoordinatesFinite = true;
    for (let localTriangle = 0; localTriangle < 16; localTriangle += 1) {
      const offset = (wheelIndex * 16 + localTriangle) * 9;
      const faceOuterSide = localTriangle < 8;
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const x = wheelDiscPositions[offset + vertex * 3];
        const y = wheelDiscPositions[offset + vertex * 3 + 1];
        const z = wheelDiscPositions[offset + vertex * 3 + 2];
        if (Math.abs(y + 0.1034482759) < 1e-6 && Math.abs(z - centerZ) < 1e-6) continue;
        const expectedX = side * (faceOuterSide ? 0.55 : 0.47);
        rimCoordinatesFinite = rimCoordinatesFinite && Math.abs(x - expectedX) <= 1e-5;
        const key = `${x.toFixed(6)}:${y.toFixed(6)}:${z.toFixed(6)}`;
        const target = faceOuterSide ? faceOuter : faceInner;
        target.set(key, (target.get(key) || 0) + 1);
      }
    }
    for (let localTriangle = 0; localTriangle < 16; localTriangle += 1) {
      const offset = (wheelIndex * 16 + localTriangle) * 9;
      const points = [
        [wheelTreadPositions[offset], wheelTreadPositions[offset + 1], wheelTreadPositions[offset + 2]],
        [wheelTreadPositions[offset + 3], wheelTreadPositions[offset + 4], wheelTreadPositions[offset + 5]],
        [wheelTreadPositions[offset + 6], wheelTreadPositions[offset + 7], wheelTreadPositions[offset + 8]],
      ];
      const [a, b, c] = points;
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const length = Math.hypot(...normal);
      const centroid = points.reduce((sum, point) => [
        sum[0] + point[0] / 3, sum[1] + point[1] / 3, sum[2] + point[2] / 3,
      ], [0, 0, 0]);
      const radial = [0, centroid[1] + 0.1034482759, centroid[2] - centerZ];
      const radialLength = Math.hypot(radial[1], radial[2]);
      const radialDot = length > 0 && radialLength > 0
        ? (normal[1] * radial[1] + normal[2] * radial[2]) / (length * radialLength)
        : -Infinity;
      treadNormalMinOutwardDot = Math.min(treadNormalMinOutwardDot, radialDot);
      treadNormalFinite = treadNormalFinite && points.flat().every(Number.isFinite)
        && Number.isFinite(length) && Number.isFinite(radialDot);
      for (const [x, y, z] of points) {
        const isOuter = Math.abs(Math.abs(x) - 0.55) < 1e-5;
        const expectedX = side * (isOuter ? 0.55 : 0.47);
        rimCoordinatesFinite = rimCoordinatesFinite && Math.abs(x - expectedX) <= 1e-5;
        const key = `${x.toFixed(6)}:${y.toFixed(6)}:${z.toFixed(6)}`;
        const target = isOuter ? outer : inner;
        target.set(key, (target.get(key) || 0) + 1);
      }
    }
    const outerKeys = [...outer.keys()].sort();
    const innerKeys = [...inner.keys()].sort();
    const profileKey = (key) => key.split(':').slice(1).join(':');
    const outerProfiles = outerKeys.map(profileKey).sort();
    const innerProfiles = innerKeys.map(profileKey).sort();
    const faceOuterProfiles = [...faceOuter.keys()].map(profileKey).sort();
    const faceInnerProfiles = [...faceInner.keys()].map(profileKey).sort();
    treadContinuity = treadContinuity
      && outer.size === 8
      && inner.size === 8
      && outerProfiles.every((key, index) => key === innerProfiles[index])
      && faceOuter.size === 8
      && faceInner.size === 8
      && outerProfiles.every((key, index) => key === faceOuterProfiles[index])
      && innerProfiles.every((key, index) => key === faceInnerProfiles[index])
      && [...faceOuter.values()].every((count) => count === 2)
      && [...faceInner.values()].every((count) => count === 2)
      && [...outer.values()].every((count) => count >= 2)
      && [...inner.values()].every((count) => count >= 2)
      && rimCoordinatesFinite
      && side !== 0;
  }
  const bodyColor = runtime.bodies.geometry?.getAttribute?.('color');
  const approxColor = (offset, expected) => expected.every((value, index) => (
    Math.abs(bodyColor.array[offset + index] - value) <= 1e-6
  ));
  let wheelColorProof = Boolean(bodyColor && bodyColor.count >= 468);
  let outerHubCueCount = 0;
  let hubCueOutsideOuter = false;
  if (wheelColorProof) {
    for (let triangle = 0; triangle < 128; triangle += 1) {
      const triangleStart = (20 + triangle) * 9;
      const local = triangle % 16;
      const role = triangle < 64 ? 'face' : 'tread';
      const expected = role === 'tread'
        ? [0.1, 0.1, 0.11]
        : triangle % 16 < 8
          ? null
          : [0.12, 0.12, 0.13];
      if (expected && !approxColor(triangleStart, expected)) wheelColorProof = false;
      if (role === 'tread') {
        for (let vertex = 0; vertex < 3; vertex += 1) {
          if (!approxColor(triangleStart + vertex * 3, [0.1, 0.1, 0.11])) wheelColorProof = false;
          if (approxColor(triangleStart + vertex * 3, [1.18, 1.25, 1.3])) hubCueOutsideOuter = true;
        }
      } else if (local < 8) {
        if (approxColor(triangleStart, [1.18, 1.25, 1.3])) outerHubCueCount += 1;
        if (!approxColor(triangleStart + 3, [0.18, 0.18, 0.19])
          || !approxColor(triangleStart + 6, [0.18, 0.18, 0.19])) wheelColorProof = false;
      } else {
        for (let vertex = 0; vertex < 3; vertex += 1) {
          if (!approxColor(triangleStart + vertex * 3, [0.12, 0.12, 0.13])) wheelColorProof = false;
          if (approxColor(triangleStart + vertex * 3, [1.18, 1.25, 1.3])) hubCueOutsideOuter = true;
        }
      }
    }
  }
  const wheelDiagnosticsColors = renderer.parkedCarPartitionDiagnostics.topology.body.wheels.colors;
  const effectiveProducts = wheelDiagnosticsColors?.effectivePaletteProducts || [];
  const effectiveColorProof = {
    entries: effectiveProducts.length,
    finite: true,
    bounded: true,
    productsMatchSourcePaint: true,
  };
  for (const product of effectiveProducts) {
    const sourcePaint = runtime.records.find((record) => record.bodyColor.every((value, index) => (
      Math.abs(value - product.instancePaintLinear[index]) <= 1e-6
    )))?.bodyColor;
    const hub = sourcePaint?.map((value, index) => (
      value * wheelDiagnosticsColors.rawGeometryTones.paintModulatedHubHighlight[index]
    )) || [];
    const tread = sourcePaint?.map((value, index) => (
      value * wheelDiagnosticsColors.rawGeometryTones.tread[index]
    )) || [];
    effectiveColorProof.finite = effectiveColorProof.finite
      && product.finite && hub.every(Number.isFinite) && tread.every(Number.isFinite);
    effectiveColorProof.bounded = effectiveColorProof.bounded
      && product.bounded && [...hub, ...tread].every((value) => value >= 0 && value <= 1);
    effectiveColorProof.productsMatchSourcePaint = effectiveColorProof.productsMatchSourcePaint
      && sourcePaint?.length === 3
      && product.hubHighlight.every((value, index) => Math.abs(value - hub[index]) <= 1e-6)
      && product.tread.every((value, index) => Math.abs(value - tread[index]) <= 1e-6);
  }
  let wheelContactFinite = true;
  let wheelContactMaxAbsError = 0;
  let wheelContactMinClearance = Infinity;
  let wheelContactMaxClearance = -Infinity;
  const city = api.getCity();
  const roadLiftMeters = Number(city?.meta?.streetDesign?.roadLift ?? 0.5);
  let sourceRoadYFinite = true;
  let minSourceRoadY = Infinity;
  let maxSourceRoadY = -Infinity;
  for (const record of runtime.records) {
    const matrix = record.bodyMatrix;
    let minWorldY = Infinity;
    for (let offset = 0; offset < wheelPositions.length; offset += 3) {
      const x = wheelPositions[offset];
      const y = wheelPositions[offset + 1];
      const z = wheelPositions[offset + 2];
      const worldY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      minWorldY = Math.min(minWorldY, worldY);
      wheelContactFinite = wheelContactFinite && Number.isFinite(worldY);
    }
    const terrainHeight = renderer.terrain?.heightAt ? renderer.terrain.heightAt(record.x, record.z) : 0;
    const roadPlaneY = terrainHeight + roadLiftMeters;
    sourceRoadYFinite = sourceRoadYFinite && Number.isFinite(terrainHeight) && Number.isFinite(roadPlaneY);
    minSourceRoadY = Math.min(minSourceRoadY, roadPlaneY);
    maxSourceRoadY = Math.max(maxSourceRoadY, roadPlaneY);
    const clearance = minWorldY - roadPlaneY;
    wheelContactMaxAbsError = Math.max(wheelContactMaxAbsError, Math.abs(clearance));
    wheelContactMinClearance = Math.min(wheelContactMinClearance, clearance);
    wheelContactMaxClearance = Math.max(wheelContactMaxClearance, clearance);
  }
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
    wheelGeometry: {
      finite: finite && Number.isFinite(bodyCenterY) && Number.isFinite(bodyYScale),
      localMinY,
      localAbsX,
      bodyCenterY,
      worldMinY: bodyCenterY + localMinY * bodyYScale,
    },
    wheelContactProof: {
      records: runtime.records.length,
      finite: wheelContactFinite && wheelNormalFinite && treadNormalFinite && sourceRoadYFinite,
      wheelVertices: wheelPositions.length / 3,
      maxAbsRoadPlaneErrorMeters: wheelContactMaxAbsError,
      minClearanceMeters: wheelContactMinClearance,
      maxClearanceMeters: wheelContactMaxClearance,
      minOutwardFaceNormalDot: wheelNormalMinOutwardDot,
      minOutwardCentroidDotMeters: wheelCentroidMinOutwardDot,
      minOutwardTreadNormalDot: treadNormalMinOutwardDot,
      treadContinuity,
      faceRimContinuity: treadContinuity,
      colorProof: wheelColorProof && outerHubCueCount === 32 && !hubCueOutsideOuter,
      effectiveColorProof,
      sourceRoadY: {
        roadYSource: 'terrain.heightAt+roadLift',
        roadLiftMeters,
        finite: sourceRoadYFinite,
        sourceRoadYFinite,
        minSourceRoadYMeters: minSourceRoadY,
        maxSourceRoadYMeters: maxSourceRoadY,
        roadYExcludedFromRecordsChecksum: true,
      },
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
