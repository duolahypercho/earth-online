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

await page.addInitScript(() => {
  const request = window.requestAnimationFrame.bind(window);
  const tracker = { requests: 0, callbacks: 0 };
  window.__CITYGEN_INTERIOR_QA_RAF__ = tracker;
  window.requestAnimationFrame = (callback) => {
    tracker.requests += 1;
    return request((now) => {
      tracker.callbacks += 1;
      callback(now);
    });
  };
});

const REQUIRED_APIS = [
  'getBuildingPortals',
  'getInteriorCoverage',
  'getInteriorState',
  'enterBuilding',
  'exitBuilding',
  'setInteriorView',
  'getRenderer',
];

const baseline = () => page.evaluate(() => {
  const api = window.__CITYGEN__;
  const renderer = api.getRenderer();
  const root = renderer.root;
  const canvas = renderer.renderer?.domElement || document.querySelector('canvas');
  window.__CITYGEN_INTERIOR_QA_BASELINE__ = {
    renderer,
    root,
    canvas,
    childVisibility: new Map(root.children.map((child) => [child.uuid, child.visible])),
    trafficVisible: api.getTraffic()?.group?.visible ?? null,
  };
  const objects = { meshes: 0, groups: 0 };
  root.traverse((object) => {
    if (object.isMesh) objects.meshes += 1;
    if (object.isGroup) objects.groups += 1;
  });
  return {
    backend: renderer.rendererBackend,
    canvases: document.querySelectorAll('canvas').length,
    sceneCanvases: document.querySelectorAll('#scene-canvas').length,
    objects,
    drawCalls: renderer.renderer.info.render.drawCalls,
    triangles: renderer.renderer.info.render.triangles,
    geometries: renderer.renderer.info.memory.geometries,
    textures: renderer.renderer.info.memory.textures,
  };
});

const runtimeSnapshot = () => page.evaluate(() => {
  const api = window.__CITYGEN__;
  const renderer = api.getRenderer();
  const root = renderer.root;
  const reference = window.__CITYGEN_INTERIOR_QA_BASELINE__;
  const objects = { meshes: 0, groups: 0 };
  const interiorGroups = [];
  root.traverse((object) => {
    if (object.isMesh) objects.meshes += 1;
    if (object.isGroup) objects.groups += 1;
    if (object.name === 'active-building-interior') interiorGroups.push(object);
  });
  const activeGroup = interiorGroups[0] || null;
  const activeMeshes = [];
  activeGroup?.traverse((object) => {
    if (object.isMesh) activeMeshes.push(object);
  });
  const categories = [...new Set(activeMeshes.map((mesh) => mesh.userData?.category).filter(Boolean))].sort();
  const materialFingerprint = activeMeshes.map((mesh) => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return materials.map((surface) => ({
      node: mesh.name,
      category: mesh.userData?.category || null,
      color: surface?.color?.getHexString?.() || null,
      emissive: surface?.emissive?.getHexString?.() || null,
      roughness: surface?.roughness ?? null,
      metalness: surface?.metalness ?? null,
      opacity: surface?.opacity ?? null,
      transparent: surface?.transparent ?? null,
    }));
  }).flat().sort((a, b) => `${a.node}:${a.category}`.localeCompare(`${b.node}:${b.category}`));
  const childVisibility = [...reference.childVisibility.entries()];
  return {
    identity: {
      renderer: renderer === reference.renderer,
      root: root === reference.root,
      canvas: (renderer.renderer?.domElement || document.querySelector('canvas')) === reference.canvas,
    },
    canvases: document.querySelectorAll('canvas').length,
    sceneCanvases: document.querySelectorAll('#scene-canvas').length,
    objects,
    interiorGroups: interiorGroups.length,
    activeInterior: activeGroup ? {
      meshNodes: activeMeshes.length,
      categories,
      declaredCategories: activeGroup.userData?.propCategories || [],
      materialFingerprint,
      exteriorVisibleChildren: root.children.filter((child) => child !== activeGroup && child.visible).length,
    } : null,
    visibilityRestored: childVisibility.every(([uuid, visible]) => root.children.find((child) => child.uuid === uuid)?.visible === visible),
    trafficVisible: api.getTraffic()?.group?.visible ?? null,
    baselineTrafficVisible: reference.trafficVisible,
    drawCalls: renderer.renderer.info.render.drawCalls,
    triangles: renderer.renderer.info.render.triangles,
    geometries: renderer.renderer.info.memory.geometries,
    textures: renderer.renderer.info.memory.textures,
    raf: { ...window.__CITYGEN_INTERIOR_QA_RAF__ },
    interior: api.getInteriorState(),
    state: api.getState(),
  };
});

const resetRafCounter = () => page.evaluate(() => {
  window.__CITYGEN_INTERIOR_QA_RAF__.requests = 0;
  window.__CITYGEN_INTERIOR_QA_RAF__.callbacks = 0;
});

function vector(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const [x, y, z] = value;
    return { x, y, z };
  }
  if (value && typeof value === 'object') return { x: value.x, y: value.y, z: value.z };
  return null;
}

function assertFiniteVector(value, label) {
  const point = vector(value);
  assert.ok(point, `${label} must be a { x, y, z } vector`);
  assert.ok([point.x, point.y, point.z].every(Number.isFinite), `${label} must be finite`);
  return point;
}

function activeBuildingId(interior) {
  return interior?.activeBuildingId
    ?? interior?.active?.buildingId
    ?? interior?.active?.id
    ?? null;
}

function playerPosition(interior, state) {
  return interior?.player
    ?? interior?.playerPosition
    ?? state?.player
    ?? state?.playerPosition
    ?? null;
}

function assertNoRuntimeReplacement(snapshot, label) {
  assert.deepEqual(snapshot.identity, { renderer: true, root: true, canvas: true }, `${label}: canonical runtime identity`);
  assert.equal(snapshot.sceneCanvases, 1, `${label}: one canonical scene canvas`);
  assert.equal(snapshot.canvases, 2, `${label}: one scene canvas plus one 2D minimap canvas`);
}

function assertBoundedDelta(before, after, label) {
  assert.ok(after.drawCalls <= before.drawCalls + 64,
    `${label}: interior draw delta is bounded (${after.drawCalls - before.drawCalls})`);
  assert.ok(after.objects.meshes <= before.objects.meshes + 128,
    `${label}: interior mesh delta is bounded (${after.objects.meshes - before.objects.meshes})`);
  assert.ok(after.geometries <= before.geometries + 96,
    `${label}: interior geometry delta is bounded (${after.geometries - before.geometries})`);
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState?.().webgpu
      && window.__CITYGEN__?.getState?.().generator === 'sf-builtin'
      && window.__CITYGEN__?.getState?.().buildings === 700,
    { timeout: 30000 },
  );

  const missing = await page.evaluate((names) => names.filter((name) => typeof window.__CITYGEN__?.[name] !== 'function'), REQUIRED_APIS);
  assert.deepEqual(
    missing,
    [],
    `canonical interior API is incomplete; missing ${missing.join(', ')}. `
      + 'Implement it on window.__CITYGEN__ in the canonical / runtime before enabling this verifier.',
  );

  const portalReport = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const first = api.getBuildingPortals();
    const second = api.getBuildingPortals();
    return {
      first,
      deterministic: JSON.stringify(first) === JSON.stringify(second),
      coverage: api.getInteriorCoverage(),
    };
  });
  const portals = portalReport.first;
  assert.ok(Array.isArray(portals), 'getBuildingPortals() must return an array');
  assert.equal(portals.length, 700, 'SF registers one portal for each of 700 buildings');
  assert.equal(new Set(portals.map((portal) => portal.buildingId)).size, 700, 'SF portal building ids are unique');
  assert.equal(portalReport.deterministic, true, 'portal metadata is deterministic within the canonical runtime');
  assert.equal(portalReport.coverage?.registered, 700, 'coverage reports 700 registered portals');
  assert.equal(portalReport.coverage?.functional, 700, 'coverage reports 700 functional interiors');
  assert.equal(portalReport.coverage?.missing, 0, 'coverage reports no missing interiors');
  assert.equal(portalReport.coverage?.accessible, 700, 'all portal approach cells are physically walkable');
  portals.forEach((portal, index) => {
    assert.equal(typeof portal.buildingId, 'string', `portal ${index} has a building id`);
    assert.ok(portal.buildingId.length > 0, `portal ${index} building id is non-empty`);
    assertFiniteVector(portal.position, `portal ${portal.buildingId} position`);
    assertFiniteVector(portal.normal, `portal ${portal.buildingId} normal`);
    assertFiniteVector(portal.approach, `portal ${portal.buildingId} approach`);
    const rooms = portal.interior?.rooms ?? portal.descriptor?.rooms;
    assert.ok(Array.isArray(rooms), `portal ${portal.buildingId} provides an interior room descriptor array`);
    assert.equal(rooms.length, 1, `portal ${portal.buildingId} has exactly one generated ground-floor room`);
  });

  // Let the canonical exterior finish its first lazy WebGPU uploads before
  // measuring the streamed-interior delta.
  await page.waitForTimeout(1000);
  const before = await baseline();
  assert.equal(before.backend, 'webgpu', 'canonical SF is using the WebGPU renderer');
  assert.equal(before.sceneCanvases, 1, 'canonical SF starts with one scene canvas');
  assert.equal(before.canvases, 2, 'canonical SF has one scene canvas plus one 2D minimap canvas');
  const sampleIndexes = [0, Math.floor(portals.length / 2), portals.length - 1];
  const samples = [];
  let firstMaterialFingerprint = null;

  for (const index of sampleIndexes) {
    const portal = portals[index];
    await page.evaluate(async (buildingId) => {
      await window.__CITYGEN__.enterBuilding(buildingId);
    }, portal.buildingId);
    await page.waitForTimeout(120);
    const entered = await runtimeSnapshot();
    assertNoRuntimeReplacement(entered, `entry ${portal.buildingId}`);
    assert.equal(activeBuildingId(entered.interior), portal.buildingId, `entry ${portal.buildingId}: active building`);
    assert.equal(entered.interiorGroups, 1, `entry ${portal.buildingId}: exactly one active interior group`);
    assertBoundedDelta(before, entered, `entry ${portal.buildingId}`);
    assert.ok(entered.activeInterior.meshNodes <= 40, `entry ${portal.buildingId}: <=40 active meshes`);
    assert.ok(entered.drawCalls <= 40, `entry ${portal.buildingId}: <=40 active draw calls`);
    assert.equal(entered.activeInterior.exteriorVisibleChildren, 0, `entry ${portal.buildingId}: exterior partition is hidden`);
    assert.equal(entered.trafficVisible, false, `entry ${portal.buildingId}: traffic is hidden`);
    const requiredCategories = ['ceiling', 'door', 'floor', 'glass', 'greenery', 'grounding', 'lighting', 'reception', 'seating', 'signage', 'trim', 'wall'];
    assert.ok(entered.activeInterior.categories.length >= 12, `entry ${portal.buildingId}: at least 12 rendered prop categories`);
    assert.deepEqual(entered.activeInterior.declaredCategories, entered.activeInterior.categories,
      `entry ${portal.buildingId}: declared categories match rendered categories`);
    requiredCategories.forEach((category) => assert.ok(entered.activeInterior.categories.includes(category),
      `entry ${portal.buildingId}: rendered ${category} category`));
    if (!firstMaterialFingerprint) firstMaterialFingerprint = entered.activeInterior.materialFingerprint;
    if (index === sampleIndexes[0]) {
      await page.addStyleTag({ content: '.brand,.toolbar,.readout,.hint,.minimap,.inspector,.status-pill{display:none!important}' });
      await page.screenshot({ path: '.qa-citygen-interior.png' });
      await page.evaluate(() => window.__CITYGEN__.setInteriorView('entrance'));
      await page.waitForTimeout(80);
      await page.screenshot({ path: '.qa-citygen-interior-entrance.png' });
      await page.evaluate(() => window.__CITYGEN__.setInteriorView('lobby'));
    }

    await resetRafCounter();
    await page.waitForTimeout(500);
    const raf = await runtimeSnapshot();
    assert.ok(raf.raf.callbacks <= 75,
      `entry ${portal.buildingId}: one canonical animation loop remains bounded (${raf.raf.callbacks} callbacks/500ms)`);

    await page.evaluate(async () => {
      await window.__CITYGEN__.exitBuilding();
    });
    await page.waitForTimeout(120);
    const exited = await runtimeSnapshot();
    assertNoRuntimeReplacement(exited, `exit ${portal.buildingId}`);
    assert.equal(activeBuildingId(exited.interior), null, `exit ${portal.buildingId}: no active building`);
    assert.equal(exited.interiorGroups, 0, `exit ${portal.buildingId}: active interior group is disposed`);
    assert.equal(exited.visibilityRestored, true, `exit ${portal.buildingId}: exterior visibility map is restored`);
    assert.equal(exited.trafficVisible, exited.baselineTrafficVisible, `exit ${portal.buildingId}: traffic visibility is restored`);
    const player = assertFiniteVector(playerPosition(exited.interior, exited.state),
      `exit ${portal.buildingId}: public interior/player position`);
    const approach = assertFiniteVector(portal.approach, `portal ${portal.buildingId} approach`);
    const exitDistance = Math.hypot(player.x - approach.x, player.y - approach.y, player.z - approach.z);
    assert.ok(exitDistance <= 0.75,
      `exit ${portal.buildingId}: player returns to portal approach (${exitDistance.toFixed(3)}m)`);
    samples.push({
      buildingId: portal.buildingId,
      exitDistance: Number(exitDistance.toFixed(3)),
      drawDelta: exited.drawCalls - before.drawCalls,
      meshDelta: exited.objects.meshes - before.objects.meshes,
      rafCallbacks: raf.raf.callbacks,
    });
  }

  const repeatPortal = portals[sampleIndexes[0]];
  const cycleMemory = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await page.evaluate((buildingId) => window.__CITYGEN__.enterBuilding(buildingId), repeatPortal.buildingId);
    await page.waitForTimeout(80);
    const entered = await runtimeSnapshot();
    assert.deepEqual(entered.activeInterior.materialFingerprint, firstMaterialFingerprint,
      `repeat cycle ${cycle + 1}: deterministic material palette`);
    cycleMemory.push({ geometries: entered.geometries, textures: entered.textures });
    await page.evaluate(() => window.__CITYGEN__.exitBuilding());
    await page.waitForTimeout(80);
    const exited = await runtimeSnapshot();
    assert.equal(exited.interiorGroups, 0, `repeat cycle ${cycle + 1}: interior disposed`);
  }
  const warmedMemory = cycleMemory[1];
  for (const memory of cycleMemory.slice(2)) {
    assert.deepEqual(memory, warmedMemory, 'repeat entry does not grow geometry or texture memory after warm-up');
  }

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    result: 'PASS',
    url,
    coverage: portalReport.coverage,
    baseline: before,
    samples,
    cycleMemory,
    errors,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
