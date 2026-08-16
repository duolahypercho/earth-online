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

const BASELINE = Object.freeze({
  // This is the last committed vehicle-batch baseline. The authored hull is
  // intentionally compared to this immutable presentation contract instead
  // of hiding a regression behind a broad triangle cap.
  commit: '3993385',
  vehicleTriangles: 12936,
  renderer: { drawCalls: 594, geometries: 401, textures: 259 },
});

const finiteArray = (array) => Array.from(array || []).every(Number.isFinite);

function hullGeometryReport(geometry) {
  const position = geometry?.attributes?.position;
  const normal = geometry?.attributes?.normal;
  const index = geometry?.index;
  const positions = position?.array || [];
  const normals = normal?.array || [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      bounds.min[axis] = Math.min(bounds.min[axis], positions[i + axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], positions[i + axis]);
    }
  }
  let minArea = Infinity;
  let normalLengthError = 0;
  const normalFacets = new Set();
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i]; const ay = positions[i + 1]; const az = positions[i + 2];
    const bx = positions[i + 3]; const by = positions[i + 4]; const bz = positions[i + 5];
    const cx = positions[i + 6]; const cy = positions[i + 7]; const cz = positions[i + 8];
    const abx = bx - ax; const aby = by - ay; const abz = bz - az;
    const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    minArea = Math.min(minArea, Math.hypot(nx, ny, nz) * 0.5);
    const dominant = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
    if (dominant > 1e-7) {
      if (Math.abs(nx) === dominant) normalFacets.add(nx > 0 ? 'side+' : 'side-');
      if (Math.abs(ny) === dominant) normalFacets.add(ny > 0 ? 'top' : 'bottom');
      if (Math.abs(nz) === dominant) normalFacets.add(nz > 0 ? 'front' : 'rear');
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    normalLengthError = Math.max(normalLengthError, Math.abs(Math.hypot(
      normals[i], normals[i + 1], normals[i + 2],
    ) - 1));
  }
  const metadata = geometry?.userData?.vehicleHull || null;
  return {
    name: geometry?.name || '',
    metadata,
    indexed: Boolean(index),
    vertexCount: position?.count || 0,
    triangleCount: index ? index.count / 3 : (position?.count || 0) / 3,
    positionFinite: finiteArray(positions),
    normalFinite: finiteArray(normals),
    bounds,
    minTriangleArea: minArea,
    normalLengthError,
    normalFacets: [...normalFacets].sort(),
  };
}

const snapshot = () => page.evaluate(() => {
  const api = window.__CITYGEN__;
  const traffic = api.getTraffic();
  const renderer = api.getRenderer();
  const batch = traffic.vehicleBatch;
  const allMatricesFinite = Object.values(batch.parts)
    .every((mesh) => [...mesh.instanceMatrix.array].every(Number.isFinite));
  const bodyColorsFinite = batch.parts.body.instanceColor
    && [...batch.parts.body.instanceColor.array].every(Number.isFinite);
  const perPartColorsFinite = ['body', 'cab', 'taxiTopper', 'transitWindows']
    .every((part) => batch.parts[part].instanceColor
      && [...batch.parts[part].instanceColor.array].every(Number.isFinite));
  const movingCarIndex = traffic.cars.reduce(
    (best, car, index, cars) => (car.speed > cars[best].speed ? index : best), 0,
  );
  batch.parts.body.getMatrixAt(movingCarIndex, batch.partMatrix);
  const car = traffic.cars[movingCarIndex];
  const vehicleTriangles = Object.values(batch.parts).reduce((total, mesh) => total
    + (mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3) * mesh.count, 0);
  const geometrySet = [...new Set(Object.values(batch.parts).map((mesh) => mesh.geometry))];
  const geometries = Object.fromEntries(Object.entries(batch.parts).map(([name, mesh]) => [name, mesh.geometry]));
  const materials = Object.fromEntries(Object.entries(batch.parts).map(([name, mesh]) => [name, mesh.material]));
  const instanceMatrixFinite = Object.fromEntries(Object.entries(batch.parts)
    .map(([name, mesh]) => [name, [...mesh.instanceMatrix.array].every(Number.isFinite)]));
  const instanceColorsFinite = Object.fromEntries(Object.entries(batch.parts)
    .map(([name, mesh]) => [name, !mesh.instanceColor || [...mesh.instanceColor.array].every(Number.isFinite)]));
  return {
    backend: renderer.rendererBackend,
    diagnostics: traffic.getVehicleBatchDiagnostics(),
    allMatricesFinite,
    bodyColorsFinite,
    perPartColorsFinite,
    bodyColorCount: batch.parts.body.instanceColor?.count || 0,
    stableIndices: traffic.cars.map((entry) => entry.instanceIndex),
    busIndices: traffic.cars.flatMap((entry, index) => entry.kind === 'bus' ? [index] : []),
    topperIndices: traffic.cars
      .flatMap((entry) => entry.group.userData.rig.topperInstanceIndex >= 0
        ? [entry.group.userData.rig.topperInstanceIndex]
        : []),
    movingCarIndex,
    movingCarPosition: car.group.position.toArray(),
    movingBodyMatrix: batch.partMatrix.toArray(),
    drawCalls: renderer.renderer.info.render.drawCalls,
    rendererGeometries: renderer.renderer.info.memory.geometries,
    vehicleTriangles,
    baselineVehicleTriangles: 12936,
    uniqueGeometryCount: geometrySet.length,
    geometryIdentity: {
      bodyCabShared: geometries.body === geometries.cab,
      boxPartsShared: geometries.taxiTopper === geometries.transitWindows
        && geometries.transitWindows === geometries.headlights,
      wheelHubDistinct: geometries.tires !== geometries.hubs,
    },
    geometryReports: Object.fromEntries(Object.entries(batch.parts).map(([name, mesh]) => [name, {
      name: mesh.geometry.name,
      vertexCount: mesh.geometry.attributes.position?.count || 0,
      indexed: Boolean(mesh.geometry.index),
      userData: mesh.geometry.userData?.vehicleHull || null,
    }])),
    hullAttributes: {
      positions: Array.from(batch.parts.body.geometry.attributes.position?.array || []),
      normals: Array.from(batch.parts.body.geometry.attributes.normal?.array || []),
    },
    uniqueBatchMaterialCount: new Set(Object.values(materials)).size,
    batchMaterialsHaveNoMaps: Object.values(materials).every((material) => !material.map),
    rendererTriangles: renderer.renderer.info.render.triangles,
    rendererTextures: renderer.renderer.info.memory.textures,
    instanceMatrixFinite,
    instanceColorsFinite,
  };
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu
      && window.__CITYGEN__?.getState().generator === 'sf-builtin'
      && window.__CITYGEN__?.getTraffic()?.cars?.length === 42,
    { timeout: 30000 },
  );
  await page.evaluate(() => window.__CITYGEN__.setCameraPose('sf'));
  await page.waitForTimeout(1400);

  const before = await snapshot();
  const expectedIndices = Array.from({ length: 42 }, (_, index) => index);
  assert.equal(before.backend, 'webgpu');
  assert.equal(before.diagnostics.logicalCars, 42);
  assert.deepEqual(before.diagnostics.kinds, { sedan: 28, taxi: 6, truck: 4, bus: 4 });
  assert.equal(before.diagnostics.meshes, 259);
  assert.equal(before.diagnostics.instancedMeshes, 7);
  assert.equal(before.diagnostics.geometries, 4);
  assert.equal(before.diagnostics.materials, 133);
  assert.deepEqual(before.diagnostics.instances, {
    body: 42,
    cab: 42,
    taxiTopper: 10,
    transitWindows: 4,
    headlights: 84,
    tires: 168,
    hubs: 168,
  });
  assert.equal(before.diagnostics.sfTransit.logicalInstances, 4);
  assert.deepEqual(before.diagnostics.sfTransit.styles, {
    'muni-coach': 2,
    'cable-car-inspired': 2,
  });
  assert.deepEqual(before.diagnostics.sfTransit.identities.map((entry) => entry.carIndex), before.busIndices);
  assert.deepEqual(before.diagnostics.sfTransit.identities.map((entry) => entry.ordinal), [0, 1, 2, 3]);
  assert.deepEqual(before.diagnostics.sfTransit.identities.map((entry) => entry.windowInstanceIndex), [0, 1, 2, 3]);
  assert.deepEqual(before.diagnostics.sfTransit.identities.map((entry) => entry.id), [
    'muni-red-silver-coach',
    'muni-heritage-burgundy',
    'muni-red-silver-coach',
    'muni-heritage-burgundy',
  ]);
  assert.deepEqual(before.topperIndices.toSorted((a, b) => a - b), Array.from({ length: 10 }, (_, index) => index));
  assert.equal(new Set(before.diagnostics.sfTransit.identities.map((entry) => entry.topperInstanceIndex)).size, 4);
  assert.equal(before.diagnostics.frustumSafe, true);
  assert.equal(before.allMatricesFinite, true);
  assert.equal(before.bodyColorsFinite, true);
  assert.equal(before.perPartColorsFinite, true);
  assert.equal(before.bodyColorCount, 42);
  assert.deepEqual(before.stableIndices, expectedIndices);
  assert.equal(before.uniqueGeometryCount, 4);
  assert.deepEqual(before.geometryIdentity, {
    bodyCabShared: true,
    boxPartsShared: true,
    wheelHubDistinct: true,
  });
  assert.equal(before.uniqueBatchMaterialCount, 7);
  assert.equal(before.batchMaterialsHaveNoMaps, true);
  assert.equal(before.vehicleTriangles, 13608);
  assert.equal(before.vehicleTriangles - BASELINE.vehicleTriangles, 672);
  assert.deepEqual(before.instanceMatrixFinite, {
    body: true, cab: true, taxiTopper: true, transitWindows: true,
    headlights: true, tires: true, hubs: true,
  });
  assert.deepEqual(before.instanceColorsFinite, {
    body: true, cab: true, taxiTopper: true, transitWindows: true,
    headlights: true, tires: true, hubs: true,
  });

  const hull = hullGeometryReport({
    name: before.geometryReports.body.name,
    userData: { vehicleHull: before.geometryReports.body.userData },
    attributes: {
      position: { array: before.hullAttributes.positions, count: before.hullAttributes.positions.length / 3 },
      normal: { array: before.hullAttributes.normals, count: before.hullAttributes.normals.length / 3 },
    },
    index: before.geometryReports.body.indexed ? {} : null,
  });
  assert.equal(hull.name, 'sf-low-poly-vehicle-hull-v1');
  assert.equal(hull.metadata.id, 'sf-low-poly-vehicle-hull-v1');
  assert.equal(hull.metadata.version, 1);
  assert.equal(hull.metadata.triangleCount, 20);
  assert.equal(hull.metadata.vertexCount, 60);
  assert.equal(hull.metadata.profilePointCount, 6);
  assert.equal(hull.metadata.indexed, false);
  assert.equal(hull.metadata.hardEdged, true);
  assert.equal(hull.metadata.frontAxis, '+z');
  assert.deepEqual(hull.metadata.normalizedBounds.min, [-0.5, -0.5, -0.5]);
  assert.ok(Math.abs(hull.metadata.normalizedBounds.max[0] - 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.metadata.normalizedBounds.max[1] - 0.48) <= 1e-5);
  assert.ok(Math.abs(hull.metadata.normalizedBounds.max[2] - 0.5) <= 1e-6);
  assert.deepEqual(hull.metadata.features, ['sloped-nose', 'roof-shoulder', 'rear-rake']);
  assert.equal(hull.indexed, false);
  assert.equal(hull.vertexCount, 60);
  assert.equal(hull.triangleCount, 20);
  assert.equal(hull.positionFinite, true);
  assert.equal(hull.normalFinite, true);
  assert.ok(hull.minTriangleArea > 1e-4, `hull min triangle area ${hull.minTriangleArea}`);
  assert.ok(hull.normalLengthError <= 1e-4, `hull normal length error ${hull.normalLengthError}`);
  assert.deepEqual(hull.normalFacets, ['bottom', 'front', 'rear', 'side+', 'side-', 'top']);
  assert.ok(Math.abs(hull.bounds.min[0] + 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.bounds.max[0] - 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.bounds.min[1] + 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.bounds.max[1] - 0.48) <= 1e-5);
  assert.ok(Math.abs(hull.bounds.min[2] + 0.5) <= 1e-6);
  assert.ok(Math.abs(hull.bounds.max[2] - 0.5) <= 1e-6);

  await page.waitForTimeout(750);
  const after = await snapshot();
  const movedDistance = Math.hypot(...after.movingCarPosition.map((value, index) => value - before.movingCarPosition[index]));
  const matrixDelta = Math.max(...after.movingBodyMatrix.map((value, index) => Math.abs(value - before.movingBodyMatrix[index])));
  assert.ok(movedDistance >= 0.2, `sampled logical car moved ${movedDistance.toFixed(3)}m`);
  assert.ok(matrixDelta >= 0.01, `batched body matrix changed by ${matrixDelta.toFixed(4)}`);
  assert.deepEqual(after.stableIndices, expectedIndices);

  const animation = await page.evaluate(() => {
    const traffic = window.__CITYGEN__.getTraffic();
    const car = traffic.cars[0];
    const rig = car.group.userData.rig;
    const saved = {
      speed: car.speed,
      braking: car.braking,
      corner: car.corner,
      turnSide: car.turnSide,
      nextEdge: car.nextEdge,
      phase: traffic.phase,
      spin: rig.spin,
      bobTime: rig.bobTime,
      bodyY: rig.body.position.y,
      bodyLean: rig.body.rotation.z,
    };
    rig.spin = 0;
    rig.bobTime = 0;
    rig.body.rotation.z = 0;
    car.speed = 6;
    car.braking = true;
    car.corner = {};
    car.turnSide = 1;
    car.nextEdge = car.edge;
    traffic.phase = 0;
    traffic.animateCar(car, 0.25);
    const left = {
      spin: rig.spin,
      bob: rig.body.position.y,
      lean: rig.body.rotation.z,
      tail: rig.taillightMat.emissiveIntensity,
      active: rig.turnSignals.left[0].emissiveIntensity,
      inactive: rig.turnSignals.right[0].emissiveIntensity,
    };
    car.braking = false;
    car.speed = 0;
    car.turnSide = -1;
    rig.body.rotation.z = 0;
    traffic.phase = 0;
    traffic.animateCar(car, 0.25);
    const right = {
      lean: rig.body.rotation.z,
      tail: rig.taillightMat.emissiveIntensity,
      active: rig.turnSignals.right[0].emissiveIntensity,
      inactive: rig.turnSignals.left[0].emissiveIntensity,
    };
    Object.assign(car, {
      speed: saved.speed,
      braking: saved.braking,
      corner: saved.corner,
      turnSide: saved.turnSide,
      nextEdge: saved.nextEdge,
    });
    traffic.phase = saved.phase;
    rig.spin = saved.spin;
    rig.bobTime = saved.bobTime;
    rig.body.position.y = saved.bodyY;
    rig.body.rotation.z = saved.bodyLean;
    return { left, right };
  });
  assert.ok(Math.abs(animation.left.spin - 5) <= 1e-6);
  assert.notEqual(animation.left.bob, 0);
  assert.ok(Math.abs(animation.left.lean + 0.035) <= 1e-6);
  assert.equal(animation.left.tail, 1.6);
  assert.equal(animation.left.active, 1.5);
  assert.equal(animation.left.inactive, 0);
  assert.ok(Math.abs(animation.right.lean - 0.035) <= 1e-6);
  assert.equal(animation.right.tail, 0.85);
  assert.equal(animation.right.active, 1.5);
  assert.equal(animation.right.inactive, 0);

  assert.ok(after.drawCalls <= 1200, `full SF draw calls ${after.drawCalls}`);
  assert.ok(after.rendererGeometries <= 450, `renderer geometries ${after.rendererGeometries}`);
  assert.equal(after.vehicleTriangles - BASELINE.vehicleTriangles, 672);
  assert.ok(after.vehicleTriangles - BASELINE.vehicleTriangles <= 1000,
    `vehicle triangle delta ${after.vehicleTriangles - BASELINE.vehicleTriangles}`);
  assert.deepEqual(errors, []);
  const screenshotState = await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const traffic = api.getTraffic();
    const target = renderer.controls.target;
    const camera = renderer.camera;
    // Freeze only the final evidence composition. The motion, signal, and
    // matrix assertions above run against the live simulation first.
    traffic.update = () => {};
    const dx = target.x - camera.position.x;
    const dz = target.z - camera.position.z;
    const length = Math.hypot(dx, dz) || 1;
    const forward = { x: dx / length, z: dz / length };
    const right = { x: -forward.z, z: forward.x };
    const offsets = [[-5, 6], [0, 9], [5, 12], [-8, 16], [8, 20], [-3, 25], [4, 30], [0, 36]];
    const staged = traffic.cars.slice(0, offsets.length);
    staged.forEach((car, index) => {
      const [lateral, distance] = offsets[index];
      const x = target.x + forward.x * distance + right.x * lateral;
      const z = target.z + forward.z * distance + right.z * lateral;
      const y = renderer.terrain?.heightAt ? renderer.terrain.heightAt(x, z) : 0;
      car.group.position.set(x, y, z);
      car.group.rotation.y = Math.atan2(forward.x, forward.z);
    });
    const { writeVehicleInstance, commitVehicleBatch } = await import('/src/citygen/actors.js');
    staged.forEach((car) => writeVehicleInstance(traffic.vehicleBatch, car));
    commitVehicleBatch(traffic.vehicleBatch, traffic.cars.length);
    renderer.camera.lookAt(target.x, target.y, target.z);
    renderer.controls.update();
    document.querySelectorAll('.brand, .toolbar, .readout, .hint, .inspector, .minimap, .place-chip, .status-pill, .field-guide, .loading-hud, #osm-overlay')
      .forEach((element) => { element.style.display = 'none'; });
    return { stagedTraffic: staged.length, camera: camera.position.toArray(), target: target.toArray() };
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.qa-citygen-vehicle-silhouettes.png' });
  console.log(JSON.stringify({
    result: 'PASS',
    url,
    structure: before.diagnostics,
    synchronization: {
      movedDistance: Number(movedDistance.toFixed(3)),
      matrixDelta: Number(matrixDelta.toFixed(4)),
      stableIndices: true,
    },
    animation,
    render: {
      drawCalls: after.drawCalls,
      triangles: after.rendererTriangles,
      geometries: after.rendererGeometries,
      textures: after.rendererTextures,
      vehicleTriangles: after.vehicleTriangles,
      baselineCommit: BASELINE.commit,
      vehicleTriangleDelta: after.vehicleTriangles - BASELINE.vehicleTriangles,
    },
    screenshot: { path: '.qa-citygen-vehicle-silhouettes.png', ...screenshotState },
    errors,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
