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

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => window.__CITYGEN__?.getState().webgpu && window.__CITYGEN__?.getState().pedestrians === 48,
    { timeout: 30000 },
  );
  const positionSamples = [await page.evaluate(() => window.__CITYGEN__.getTraffic().pedestrians
    .map((pedestrian) => pedestrian.group.position.toArray()))];
  for (let sample = 0; sample < 3; sample += 1) {
    await page.waitForTimeout(250);
    positionSamples.push(await page.evaluate(() => window.__CITYGEN__.getTraffic().pedestrians
      .map((pedestrian) => pedestrian.group.position.toArray())));
  }
  const report = await page.evaluate((samples) => {
    const traffic = window.__CITYGEN__.getTraffic();
    const batch = traffic.pedestrianBatch;
    const parts = Object.values(batch?.parts || {});
    const matricesFinite = parts.every((mesh) => [...mesh.instanceMatrix.array].every(Number.isFinite));
    const colorsFinite = parts.every((mesh) => mesh === batch.parts.shadow
      || (mesh.instanceColor && [...mesh.instanceColor.array].every(Number.isFinite)));
    const moved = traffic.pedestrians.map((pedestrian, index) => samples.slice(1)
      .reduce((distance, positions, sampleIndex) => {
        const start = samples[sampleIndex][index];
        const end = positions[index];
        return distance + Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
      }, 0));
    const heroCurbLife = traffic.getHeroCurbLifeDiagnostics?.();
    const shoeGroundErrors = traffic.pedestrians.flatMap((pedestrian, index) => [0, 1].map((side) => {
      const matrixOffset = (index * 2 + side) * 16;
      const soleY = batch.parts.shoes.instanceMatrix.array[matrixOffset + 13] - 0.05;
      const groundY = pedestrian.group.position.y - (pedestrian.group.userData.walk.bobOffset || 0);
      return Math.abs(soleY - groundY);
    }));
    let pedestrianSceneMeshes = 0;
    traffic.group.traverse((object) => {
      if (object.isMesh && object.name.startsWith('pedestrian-')) pedestrianSceneMeshes += 1;
    });
    return {
      backend: window.__CITYGEN__.getState().rendererBackend,
      pedestrians: traffic.pedestrians.length,
      batchParts: parts.length,
      partNames: Object.keys(batch.parts),
      instanceCounts: parts.map((mesh) => mesh.count),
      instanceColorCounts: parts.map((mesh) => mesh.instanceColor?.count || 0),
      presentationTriangles: parts.reduce((total, mesh) => total
        + (mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3) * mesh.count, 0),
      logicalSceneAttachments: traffic.pedestrians.filter((pedestrian) => pedestrian.group.parent).length,
      pedestrianSceneMeshes,
      matricesFinite,
      colorsFinite,
      movedPedestrians: moved.filter((distance) => distance > 0.1).length,
      stationaryIndices: moved
        .map((distance, index) => ({ distance, index }))
        .filter(({ distance }) => distance <= 0.1)
        .map(({ index }) => index),
      heroCurbSitter: heroCurbLife?.actors?.find((actor) => actor.role === 'bench-sitter') || null,
      maxMovement: Number(Math.max(...moved).toFixed(3)),
      finiteGaits: traffic.pedestrians.every((pedestrian) => Number.isFinite(pedestrian.group.userData.walk.gait)),
      articulatedGaits: traffic.pedestrians
        .filter((pedestrian) => Math.abs(pedestrian.group.userData.walk.gait) > 0.2).length,
      maxShoeGroundError: Number(Math.max(...shoeGroundErrors).toFixed(6)),
      appearanceVariants: new Set(traffic.pedestrians.map((pedestrian) =>
        JSON.stringify(pedestrian.group.userData.appearance))).size,
    };
  }, positionSamples);
  assert.equal(report.backend, 'webgpu');
  assert.equal(report.pedestrians, 48);
  assert.equal(report.batchParts, 11);
  assert.deepEqual(report.partNames, [
    'torso', 'head', 'hair', 'face', 'upperArms', 'forearms', 'hands', 'thighs', 'shins', 'shoes', 'shadow',
  ]);
  assert.deepEqual(report.instanceCounts, [48, 48, 48, 48, 96, 96, 96, 96, 96, 96, 48]);
  assert.deepEqual(report.instanceColorCounts, [48, 48, 48, 48, 96, 96, 96, 96, 96, 96, 0]);
  assert.ok(report.presentationTriangles <= 15000, `pedestrian triangles ${report.presentationTriangles}`);
  assert.equal(report.logicalSceneAttachments, 0);
  assert.equal(report.pedestrianSceneMeshes, 11);
  assert.equal(report.matricesFinite, true);
  assert.equal(report.colorsFinite, true);
  assert.equal(report.finiteGaits, true);
  assert.ok(report.articulatedGaits >= 36, `articulated gaits ${report.articulatedGaits}`);
  assert.ok(report.maxShoeGroundError <= 0.01, `shoe grounding error ${report.maxShoeGroundError}`);
  assert.ok(report.appearanceVariants >= 6, `appearance variants ${report.appearanceVariants}`);
  assert.equal(report.movedPedestrians, 47);
  assert.deepEqual(report.stationaryIndices, [36]);
  assert.equal(report.heroCurbSitter?.instanceIndex, 36);
  assert.equal(report.heroCurbSitter?.poseKind, 'bench-seated');
  assert.equal(report.heroCurbSitter?.seatedPoseMatrices?.finite, true);
  assert.deepEqual(errors, []);
  await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    api.setTime(14);
    const cityRenderer = api.getRenderer();
    const traffic = api.getTraffic();
    const { writePedestrianInstance, commitPedestrianBatch } = await import('/src/citygen/actors.js');
    const pedestrian = traffic.pedestrians.reduce((nearest, candidate) => {
      const distance = candidate.group.position.distanceToSquared(cityRenderer.controls.target);
      return !nearest || distance < nearest.distance ? { candidate, distance } : nearest;
    }, null).candidate;
    const baseY = pedestrian.group.position.y - (pedestrian.group.userData.walk.bobOffset || 0);
    const anchor = { x: pedestrian.group.position.x, y: baseY, z: pedestrian.group.position.z };
    const offsets = [[-1.8, 0], [-0.6, 0], [0.6, 0], [1.8, 0], [-1.2, 1.35], [1.2, 1.35]];
    const gaits = [-0.82, -0.45, -0.16, 0.22, 0.52, 0.86];
    const staged = traffic.pedestrians.slice(0, 6);
    traffic.update = () => {};
    staged.forEach((actor, actorIndex) => {
      actor.group.position.set(anchor.x + offsets[actorIndex][0], anchor.y, anchor.z + offsets[actorIndex][1]);
      actor.group.rotation.y = 0;
      actor.group.userData.walk.gait = gaits[actorIndex];
      actor.group.userData.walk.bobOffset = 0;
      writePedestrianInstance(traffic.pedestrianBatch, actor.instanceIndex, actor);
    });
    commitPedestrianBatch(traffic.pedestrianBatch, traffic.pedestrians.length);
    window.__ACTOR_QA__ = { anchor, actorIndices: staged.map((actor) => actor.instanceIndex) };
    cityRenderer.camera.position.set(
      anchor.x + 1.2,
      anchor.y + 2.15,
      anchor.z + 8.2,
    );
    cityRenderer.controls.target.set(anchor.x, anchor.y + 0.9, anchor.z + 0.45);
    cityRenderer.controls.update();
    document.querySelectorAll('.brand, .toolbar, .readout, .hint, .inspector, .minimap, .place-chip, .status-pill')
      .forEach((element) => { element.style.display = 'none'; });
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: '.qa-citygen-actors.png' });
  await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    const traffic = api.getTraffic();
    const cityRenderer = api.getRenderer();
    const { writePedestrianInstance, commitPedestrianBatch } = await import('/src/citygen/actors.js');
    for (const actorIndex of window.__ACTOR_QA__.actorIndices) {
      const actor = traffic.pedestrians[actorIndex];
      actor.group.userData.walk.gait *= -1;
      writePedestrianInstance(traffic.pedestrianBatch, actor.instanceIndex, actor);
    }
    commitPedestrianBatch(traffic.pedestrianBatch, traffic.pedestrians.length);
    const { anchor } = window.__ACTOR_QA__;
    cityRenderer.camera.position.set(anchor.x - 1.2, anchor.y + 2.15, anchor.z - 8.2);
    cityRenderer.controls.target.set(anchor.x, anchor.y + 0.9, anchor.z + 0.45);
    cityRenderer.controls.update();
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: '.qa-citygen-actors-rear.png' });
  console.log(JSON.stringify({ result: 'PASS', url, report, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
