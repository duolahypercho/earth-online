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
const report = { render: {} };

page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
    errors.push(message.text());
  }
});
await page.addInitScript(() => {
  const request = window.requestAnimationFrame.bind(window);
  window.__CITYGEN_FOOTPRINT_RAF__ = { requests: 0, callbacks: 0 };
  window.requestAnimationFrame = (callback) => {
    window.__CITYGEN_FOOTPRINT_RAF__.requests += 1;
    return request((now) => {
      window.__CITYGEN_FOOTPRINT_RAF__.callbacks += 1;
      callback(now);
    });
  };
});

const sampleRenderer = () => page.evaluate(() => {
  const api = window.__CITYGEN__;
  const renderer = api.getRenderer();
  return {
    identity: {
      renderer: renderer === window.__CITYGEN_FOOTPRINT_IDENTITY__.renderer,
      root: renderer.root === window.__CITYGEN_FOOTPRINT_IDENTITY__.root,
      scene: renderer.scene === window.__CITYGEN_FOOTPRINT_IDENTITY__.scene,
      canvas: renderer.renderer.domElement === window.__CITYGEN_FOOTPRINT_IDENTITY__.canvas,
    },
    drawCalls: renderer.renderer.info.render.drawCalls,
    triangles: renderer.renderer.info.render.triangles,
    geometries: renderer.renderer.info.memory.geometries,
    textures: renderer.renderer.info.memory.textures,
  };
});

function assertRenderBudget(sample, label) {
  assert.ok(Number.isFinite(sample.drawCalls), `${label}: renderer drawCalls is finite`);
  assert.ok(sample.triangles <= 580000, `${label}: triangles <=580000 (${sample.triangles})`);
  assert.ok(sample.geometries <= 440, `${label}: geometries <=440 (${sample.geometries})`);
  assert.ok(sample.textures <= 302, `${label}: textures <=302 (${sample.textures})`);
  assert.deepEqual(sample.identity, { renderer: true, root: true, scene: true, canvas: true },
    `${label}: canonical renderer, root, scene, and canvas remain unchanged`);
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const api = window.__CITYGEN__;
    const state = api?.getState?.();
    return typeof api?.getCity === 'function'
      && typeof api?.getRenderer === 'function'
      && typeof api?.setCameraPose === 'function'
      && state?.generator === 'sf-builtin'
      && state?.buildings === 700
      && !state?.busy;
  }, { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.waitForFunction(() => Boolean(window.__CITYGEN__?.getRenderer?.().buildingFootprintDiagnostics),
    { timeout: 15000 }).catch(() => {});

  const runtime = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const city = api.getCity();
    const canvas = renderer.renderer?.domElement;
    window.__CITYGEN_FOOTPRINT_IDENTITY__ = {
      renderer,
      root: renderer.root,
      scene: renderer.scene,
      canvas,
    };

    const polygonFailures = [];
    let polygonAreaMin = Infinity;
    let polygonAreaMax = 0;
    let validPolygons = 0;
    for (const building of city.buildings) {
      const polygon = building.polygon;
      if (!Array.isArray(polygon) || polygon.length < 3) {
        polygonFailures.push({ id: building.id, reason: 'fewer-than-three-points' });
        continue;
      }
      if (!polygon.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.z))) {
        polygonFailures.push({ id: building.id, reason: 'non-finite-coordinate' });
        continue;
      }
      let doubleArea = 0;
      for (let index = 0; index < polygon.length; index += 1) {
        const point = polygon[index];
        const next = polygon[(index + 1) % polygon.length];
        doubleArea += point.x * next.z - next.x * point.z;
      }
      const area = Math.abs(doubleArea) / 2;
      if (!Number.isFinite(area) || area <= 0) {
        polygonFailures.push({ id: building.id, reason: 'non-positive-area', area });
        continue;
      }
      validPolygons += 1;
      polygonAreaMin = Math.min(polygonAreaMin, area);
      polygonAreaMax = Math.max(polygonAreaMax, area);
    }

    const footprintMeshes = [];
    renderer.root.traverse((object) => {
      if (!object.isMesh || typeof object.userData?.footprintMode !== 'string') return;
      footprintMeshes.push({
        name: object.name || '(unnamed)',
        mode: object.userData.footprintMode,
        count: Number(object.count) || 1,
      });
    });
    const footprintModeCounts = footprintMeshes.reduce((counts, mesh) => {
      counts[mesh.mode] = (counts[mesh.mode] || 0) + 1;
      return counts;
    }, {});
    const diagnostics = renderer.buildingFootprintDiagnostics || null;
    return {
      backend: renderer.rendererBackend,
      state: api.getState(),
      city: {
        sourceCount: city.buildings.length,
        validPolygons,
        polygonFailures: polygonFailures.slice(0, 12),
        polygonAreaMin,
        polygonAreaMax,
      },
      diagnostics: diagnostics ? {
        sourceCount: diagnostics.sourceCount,
        polygonShells: diagnostics.polygonShells,
        fallbacks: diagnostics.fallbacks,
        finite: diagnostics.finite,
        maxAreaRelativeError: diagnostics.maxAreaRelativeError,
      } : null,
      footprintMeshCount: footprintMeshes.length,
      modeCounts: footprintModeCounts,
      canvases: document.querySelectorAll('canvas').length,
      sceneCanvases: document.querySelectorAll('#scene-canvas').length,
      rootOccurrences: renderer.scene.children.filter((child) => child === renderer.root).length,
    };
  });
  report.runtime = runtime;

  assert.equal(runtime.backend, 'webgpu', 'canonical renderer uses WebGPU');
  assert.equal(runtime.state.generator, 'sf-builtin', 'canonical source is sf-builtin');
  assert.equal(runtime.state.buildings, 700, 'canonical state reports 700 buildings');
  assert.equal(runtime.city.sourceCount, 700, 'getCity exposes 700 source buildings');
  assert.equal(runtime.city.validPolygons, 700, 'all getCity building polygons are finite with positive area');
  assert.deepEqual(runtime.city.polygonFailures, [], 'getCity building polygons have no invalid entries');
  assert.ok(runtime.city.polygonAreaMin > 0, 'smallest source polygon has positive area');
  assert.equal(runtime.sceneCanvases, 1, 'exactly one canonical scene canvas exists');
  assert.equal(runtime.canvases, 2, 'canonical scene and minimap are the only canvases');
  assert.equal(runtime.rootOccurrences, 1, 'world root is attached to the scene exactly once');

  assert.ok(runtime.diagnostics,
    'getRenderer().buildingFootprintDiagnostics is required; renderer footprint contract is absent');
  assert.equal(runtime.diagnostics.sourceCount, 700, 'renderer footprint diagnostics sourceCount is 700');
  assert.equal(runtime.diagnostics.polygonShells + runtime.diagnostics.fallbacks, 700,
    'polygon shells plus explicit fallbacks cover all 700 buildings');
  assert.ok(runtime.diagnostics.polygonShells >= 690,
    `renderer uses polygon shells for at least 690 buildings (${runtime.diagnostics.polygonShells})`);
  assert.ok(runtime.diagnostics.fallbacks <= 10,
    `renderer uses no more than 10 fallbacks (${runtime.diagnostics.fallbacks})`);
  assert.equal(runtime.diagnostics.finite, true, 'renderer footprint geometry is finite');
  assert.ok(Number.isFinite(runtime.diagnostics.maxAreaRelativeError),
    'renderer max polygon-shell area relative error is finite');
  assert.ok(runtime.diagnostics.maxAreaRelativeError <= 0.01,
    `renderer polygon-shell max area relative error <=0.01 (${runtime.diagnostics.maxAreaRelativeError})`);

  assert.ok(runtime.footprintMeshCount > 0,
    'building render meshes expose explicit userData.footprintMode metadata');
  assert.ok((runtime.modeCounts['polygon-footprint'] || 0) > 0,
    'valid-polygon building render meshes use polygon-footprint mode');
  assert.equal(runtime.modeCounts['legacy-aabb'] || 0, 0,
    'no valid-polygon building render mesh uses legacy-aabb mode');

  await page.addStyleTag({
    content: '.brand,.toolbar,.readout,.hint,.minimap,.inspector,.status-pill,.osm-overlay{display:none!important}',
  });
  await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const city = api.getCity();
    const candidates = (city.segments || []).map((segment) => {
      const first = segment.points?.[0];
      const last = segment.points?.at(-1);
      const length = first && last ? Math.hypot(last.x - first.x, last.z - first.z) : 0;
      const name = String(segment.streetName || '').toLowerCase();
      const identity = name.includes('market') ? 3 : name.includes('embarcadero') ? 2 : name.includes('powell') ? 1 : 0;
      return { segment, length, score: identity * 10000 + length };
    }).filter((candidate) => candidate.length >= 12).sort((a, b) => b.score - a.score);
    const segment = candidates[0]?.segment;
    if (!segment) throw new Error('No source-valid street segment is available for footprint capture');
    const first = segment.points[0];
    const last = segment.points.at(-1);
    const dx = last.x - first.x;
    const dz = last.z - first.z;
    const length = Math.hypot(dx, dz);
    const nx = -dz / length;
    const nz = dx / length;
    const eye = { x: first.x + dx * 0.16 + nx * 1.2, z: first.z + dz * 0.16 + nz * 1.2 };
    const target = { x: first.x + dx * 0.82, z: first.z + dz * 0.82 };
    const eyeY = (renderer.terrain?.heightAt?.(eye.x, eye.z) || 0) + 2.35;
    const targetY = (renderer.terrain?.heightAt?.(target.x, target.z) || 0) + 2.0;
    renderer.camera.fov = 48;
    renderer.camera.updateProjectionMatrix();
    renderer.camera.position.set(eye.x, eyeY, eye.z);
    renderer.camera.lookAt(target.x, targetY, target.z);
    renderer.controls.target.set(target.x, targetY, target.z);
    renderer.controls.update();
  });
  await page.waitForTimeout(500);
  const street = await sampleRenderer();
  await page.screenshot({ path: '.qa-citygen-footprints-street.png' });
  report.render.street = street;
  assertRenderBudget(street, 'street');

  await page.evaluate(() => window.__CITYGEN__.setCameraPose('aerial'));
  await page.waitForTimeout(500);
  const aerial = await sampleRenderer();
  await page.screenshot({ path: '.qa-citygen-footprints-aerial.png' });
  report.render.aerial = aerial;
  assertRenderBudget(aerial, 'aerial');

  await page.evaluate(() => {
    window.__CITYGEN_FOOTPRINT_RAF__.requests = 0;
    window.__CITYGEN_FOOTPRINT_RAF__.callbacks = 0;
  });
  await page.waitForTimeout(500);
  const loop = await page.evaluate(() => ({ ...window.__CITYGEN_FOOTPRINT_RAF__ }));
  report.loop = loop;
  assert.ok(loop.callbacks > 0, 'canonical animation loop remains active');
  assert.ok(loop.callbacks <= 75, `one canonical animation loop remains bounded (${loop.callbacks} callbacks/500ms)`);
  assert.deepEqual(errors, [], 'canonical footprint render emits no browser errors');

  console.log(JSON.stringify({
    result: 'PASS',
    url,
    ...report,
    screenshots: [
      '.qa-citygen-footprints-street.png',
      '.qa-citygen-footprints-aerial.png',
    ],
    errors,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', url, error: error.message, ...report, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
