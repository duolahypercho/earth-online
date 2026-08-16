// Fail-closed verifier for the hero-facade presentation contract.
//
// The canonical renderer must expose `renderer.heroFacadeDiagnostics`
// describing the audited hero buildings (exact six source IDs), each built
// from its source polygon footprint with a finite shell whose roofline,
// cornice, and parapet are represented, plus the pattern keys and draw-group
// budget the hero regrouping costs. Until that contract lands, this gate
// fails closed by design.
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

const HERO_IDS = Object.freeze([
  'sf-building-132127809',
  'sf-building-132127810',
  'sf-building-149335979',
  'sf-building-149335987',
  'sf-building-149335988',
  'sf-building-151183777',
]);

// Render budget caps are grounded in the f90aac3 baseline measured on the
// canonical `sf` pose at time 14 (608-609 draw calls, ~530,940 triangles,
// 413 geometries, 298 textures; aerial 1,143 / 549,402). The hero slice may
// add at most its bounded triangle delta (<=5,000, enforced via diagnostics)
// plus a small headroom for hero draw groups and frame jitter; anything above
// these caps is a regression, not an accepted cost.
const HERO_POSE_CAPS = Object.freeze({ drawCalls: 621, triangles: 537000 });
const AERIAL_POSE_CAPS = Object.freeze({ drawCalls: 1149, triangles: 550000 });

const sampleRenderer = () => page.evaluate(() => {
  const renderer = window.__CITYGEN__.getRenderer();
  return {
    identity: {
      renderer: renderer === window.__CITYGEN_HERO_IDENTITY__.renderer,
      root: renderer.root === window.__CITYGEN_HERO_IDENTITY__.root,
      scene: renderer.scene === window.__CITYGEN_HERO_IDENTITY__.scene,
      canvas: renderer.renderer.domElement === window.__CITYGEN_HERO_IDENTITY__.canvas,
    },
    drawCalls: renderer.renderer.info.render.drawCalls,
    triangles: renderer.renderer.info.render.triangles,
    geometries: renderer.renderer.info.memory.geometries,
    textures: renderer.renderer.info.memory.textures,
  };
});

function assertRenderBudget(sample, label, caps) {
  assert.ok(Number.isFinite(sample.drawCalls), `${label}: renderer drawCalls is finite`);
  assert.ok(sample.drawCalls <= caps.drawCalls,
    `${label}: drawCalls <=${caps.drawCalls} (${sample.drawCalls})`);
  assert.ok(sample.triangles <= caps.triangles,
    `${label}: triangles <=${caps.triangles} (${sample.triangles})`);
  assert.ok(sample.geometries <= 430, `${label}: geometries <=430 (${sample.geometries})`);
  assert.ok(sample.textures <= 305, `${label}: textures <=305 (${sample.textures})`);
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
      && typeof api?.setTime === 'function'
      && state?.generator === 'sf-builtin'
      && state?.buildings === 700
      && !state?.busy;
  }, { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__CITYGEN__.setTime(14));
  await page.waitForTimeout(300);

  const runtime = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const canvas = renderer.renderer?.domElement;
    window.__CITYGEN_HERO_IDENTITY__ = {
      renderer,
      root: renderer.root,
      scene: renderer.scene,
      canvas,
    };
    // Facade budget comparisons must not vary with moving actor culling.
    // The normal live-world capture remains covered by the simulation gates.
    const traffic = api.getTraffic?.();
    if (traffic?.group) traffic.group.visible = false;
    const hero = renderer.heroFacadeDiagnostics || null;
    const footprint = renderer.buildingFootprintDiagnostics || null;
    return {
      backend: renderer.rendererBackend,
      time: api.getState().clock,
      hero: hero ? {
        heroes: Array.isArray(hero.heroes) ? hero.heroes.map((entry) => ({
          id: entry?.id,
          footprintMode: entry?.footprintMode,
          finite: entry?.finite,
          roofline: entry?.roofline,
          cornice: entry?.cornice,
          parapet: entry?.parapet,
          patternKeys: Array.isArray(entry?.patternKeys) ? [...entry.patternKeys] : null,
        })) : null,
        drawGroups: hero.drawGroups,
        triangleDelta: hero.triangleDelta,
      } : null,
      footprint: footprint ? {
        sourceCount: footprint.sourceCount,
        polygonShells: footprint.polygonShells,
        fallbacks: footprint.fallbacks,
        finite: footprint.finite,
        maxAreaRelativeError: footprint.maxAreaRelativeError,
        triangleDelta: footprint.triangleDelta,
      } : null,
      canvases: document.querySelectorAll('canvas').length,
      sceneCanvases: document.querySelectorAll('#scene-canvas').length,
      rootOccurrences: renderer.scene.children.filter((child) => child === renderer.root).length,
    };
  });
  report.runtime = runtime;

  assert.equal(runtime.backend, 'webgpu', 'canonical renderer uses WebGPU');
  assert.equal(runtime.sceneCanvases, 1, 'exactly one canonical scene canvas exists');
  assert.ok(runtime.canvases <= 2, 'canonical scene and minimap are the only canvases');
  assert.equal(runtime.rootOccurrences, 1, 'world root is attached to the scene exactly once');

  assert.ok(runtime.footprint,
    'getRenderer().buildingFootprintDiagnostics is required; footprint contract is absent');
  assert.equal(runtime.footprint.sourceCount, 700, 'footprint diagnostics sourceCount is 700');
  assert.equal(runtime.footprint.polygonShells + runtime.footprint.fallbacks, 700,
    'polygon shells plus explicit fallbacks cover all 700 buildings');
  assert.equal(runtime.footprint.finite, true, 'footprint geometry is finite');
  assert.ok(Number.isFinite(runtime.footprint.maxAreaRelativeError),
    'footprint max area relative error is finite');
  assert.ok(runtime.footprint.maxAreaRelativeError <= 0.001,
    `footprint max area relative error <=0.001 (${runtime.footprint.maxAreaRelativeError})`);

  assert.ok(runtime.hero,
    'getRenderer().heroFacadeDiagnostics is required; hero facade contract is absent');
  assert.ok(Array.isArray(runtime.hero.heroes), 'hero diagnostics expose a heroes list');
  assert.equal(runtime.hero.heroes.length, 6, 'hero diagnostics cover exactly six buildings');

  const heroIds = runtime.hero.heroes.map((entry) => entry.id);
  assert.equal(new Set(heroIds).size, 6, 'hero diagnostics contain no duplicate ids');
  assert.deepEqual([...heroIds].sort(), [...HERO_IDS].sort(),
    'hero diagnostics cover the exact audited building id set');

  const patternKeyUnion = new Set();
  for (const entry of runtime.hero.heroes) {
    const label = entry.id;
    assert.equal(entry.footprintMode, 'polygon-footprint',
      `${label}: hero shell uses its source polygon footprint`);
    assert.equal(entry.finite, true, `${label}: hero shell geometry is finite`);
    assert.equal(entry.roofline, true, `${label}: hero roofline is represented`);
    assert.equal(entry.cornice, true, `${label}: hero cornice is represented`);
    assert.equal(entry.parapet, true, `${label}: hero parapet is represented`);
    assert.ok(Array.isArray(entry.patternKeys) && entry.patternKeys.length > 0,
      `${label}: hero reports at least one facade pattern key`);
    for (const key of entry.patternKeys) {
      assert.ok(typeof key === 'string' && key.length > 0,
        `${label}: facade pattern keys are non-empty strings`);
      patternKeyUnion.add(key);
    }
  }
  assert.ok(patternKeyUnion.size >= 3,
    `hero facades use at least three distinct pattern keys (${patternKeyUnion.size})`);

  assert.ok(Number.isFinite(runtime.hero.drawGroups), 'hero draw-group count is finite');
  assert.ok(runtime.hero.drawGroups <= 3,
    `hero facades merge into no more than three draw groups (${runtime.hero.drawGroups})`);
  assert.ok(Number.isFinite(runtime.hero.triangleDelta), 'hero triangle delta is finite');
  // Audited UV/material regrouping may add zero triangles; anything positive
  // must stay inside the bounded delta cap either way.
  assert.ok(runtime.hero.triangleDelta <= 5000,
    `hero facade triangle delta <=5000 (${runtime.hero.triangleDelta})`);
  report.zeroNewTriangles = runtime.hero.triangleDelta === 0;

  await page.addStyleTag({
    content: '.brand,.toolbar,.readout,.hint,.minimap,.inspector,.status-pill,.osm-overlay{display:none!important}',
  });
  await page.evaluate(() => window.__CITYGEN__.setCameraPose('sf'));
  await page.waitForTimeout(600);
  const hero = await sampleRenderer();
  await page.screenshot({ path: '.qa-citygen-hero-facades.png' });
  report.render.hero = hero;
  assertRenderBudget(hero, 'hero', HERO_POSE_CAPS);

  await page.evaluate(() => window.__CITYGEN__.setCameraPose('aerial'));
  await page.waitForTimeout(500);
  const aerial = await sampleRenderer();
  report.render.aerial = aerial;
  assertRenderBudget(aerial, 'aerial', AERIAL_POSE_CAPS);

  assert.deepEqual(errors, [], 'hero facade render emits no browser errors');

  console.log(JSON.stringify({
    result: 'PASS',
    url,
    ...report,
    screenshots: ['.qa-citygen-hero-facades.png'],
    errors,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    result: 'FAIL',
    url,
    message: error.message,
    ...report,
    errors,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
