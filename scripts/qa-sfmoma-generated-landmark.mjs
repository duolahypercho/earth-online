import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://127.0.0.1:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
});

const output = {
  front: '.qa-sfmoma-generated-front.png',
  orbit: '.qa-sfmoma-generated-orbit.png',
  rear: '.qa-sfmoma-generated-rear.png',
};

try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const state = window.__CITYGEN__?.getState?.();
    return state?.webgpu && state?.buildings >= 700 && !state?.busy;
  }, null, { timeout: 90000 });
  await page.addStyleTag({
    content: `
      #app > :not(#scene-canvas) { display: none !important; }
      #scene-canvas { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; }
      html, body, #app { margin: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; background: #a9c8dc !important; }
    `,
  });

  const setup = await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const traffic = api.getTraffic();
    const module = await import('/src/citygen/landmarks/sfmoma-generated-v1.js');
    const asset = module.createSfmomaGeneratedLandmark();
    window.__SFMOMA_QA__ = {
      asset,
      cityRootVisible: renderer.root.visible,
      trafficVisible: traffic?.group?.visible,
      cameraPosition: renderer.camera.position.clone(),
      cameraQuaternion: renderer.camera.quaternion.clone(),
      cameraFov: renderer.camera.fov,
      target: renderer.controls.target.clone(),
    };
    renderer.root.visible = false;
    if (traffic?.group) traffic.group.visible = false;
    renderer.scene.add(asset.root);
    asset.root.visible = false;
    renderer.scene.fog.near = 90;
    renderer.scene.fog.far = 220;
    renderer.camera.near = 0.1;
    renderer.camera.far = 300;
    renderer.camera.fov = 37;
    renderer.camera.updateProjectionMatrix();
    renderer.renderer.toneMappingExposure = 0.96;
    api.setClock(15);
    return {
      backend: renderer.rendererBackend,
      stats: asset.stats,
      diagnostics: asset.getDiagnostics(),
      canvasCount: document.querySelectorAll('canvas').length,
      sceneCanvasCount: document.querySelectorAll('#scene-canvas').length,
    };
  });

  assert.equal(setup.backend, 'webgpu');
  assert.equal(setup.canvasCount, 2);
  assert.equal(setup.sceneCanvasCount, 1);
  assert.ok(setup.stats.drawCalls <= 42);
  assert.ok(setup.stats.triangles <= 48000);
  assert.equal(setup.diagnostics.source.presentationOnly, true);

  await page.waitForTimeout(600);
  const hiddenBaseline = await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    return {
      drawCalls: renderer.renderer.info.render.drawCalls,
      triangles: renderer.renderer.info.render.triangles,
    };
  });
  await page.evaluate(() => {
    window.__SFMOMA_QA__.asset.root.visible = true;
  });

  const capture = async (path, position, target, fov) => {
    await page.evaluate(({ position: nextPosition, target: nextTarget, fov: nextFov }) => {
      const renderer = window.__CITYGEN__.getRenderer();
      renderer.camera.position.set(...nextPosition);
      renderer.camera.fov = nextFov;
      renderer.camera.lookAt(...nextTarget);
      renderer.camera.updateProjectionMatrix();
      renderer.controls.target.set(...nextTarget);
      renderer.controls.update();
    }, { position, target, fov });
    await page.waitForTimeout(900);
    await page.screenshot({ path });
  };

  await capture(output.front, [43, 16, 58], [0, 14.8, 0], 39);
  await capture(output.orbit, [-45, 20, 55], [-0.5, 15.0, 0], 39);
  await capture(output.rear, [-43, 22, -55], [0, 15.0, 0], 40);

  const runtime = await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    return {
      drawCalls: renderer.renderer.info.render.drawCalls,
      triangles: renderer.renderer.info.render.triangles,
      geometries: renderer.renderer.info.memory.geometries,
      textures: renderer.renderer.info.memory.textures,
      rootCount: renderer.scene.children.filter((child) => child.name === 'SFMOMA generated landmark v1').length,
      canvasIdentity: renderer.renderer.domElement === document.querySelector('#scene-canvas'),
    };
  });
  assert.equal(runtime.rootCount, 1);
  assert.equal(runtime.canvasIdentity, true);
  // Canonical WebGPU accounting includes the main pass plus shadow submissions.
  assert.ok(runtime.drawCalls - hiddenBaseline.drawCalls <= setup.stats.drawCalls * 2,
    `preview draw-call delta ${runtime.drawCalls - hiddenBaseline.drawCalls}`);
  assert.ok(runtime.triangles - hiddenBaseline.triangles <= setup.stats.triangles * 2,
    `preview triangle delta ${runtime.triangles - hiddenBaseline.triangles}`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', setup, hiddenBaseline, runtime, output }, null, 2));
} finally {
  await browser.close();
}
