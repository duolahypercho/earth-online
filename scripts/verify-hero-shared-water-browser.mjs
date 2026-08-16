import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

function collectUnexpectedError(errors, message) {
  const knownRoadFallback = /^(REALMAP_DIAGNOSTICS compilation-failed|Whole-model mesh failed|Junction mesh still failing)/;
  if (!knownRoadFallback.test(message)) errors.push(message);
}

function assertHeroWaterState(label, state) {
  assert.equal(state.atmosphere.active, true, `${label}: hero atmosphere is inactive`);
  assert.equal(state.atmosphere.waterSurfaces.city, 1, `${label}: expected one runtime Bay surface`);
  assert.equal(state.atmosphere.waterSurfaces.shared, 1, `${label}: runtime Bay surface is not shared`);
  assert.equal(state.atmosphere.waterSurfaces.atmosphereRoot, 0, `${label}: local atmosphere water mesh regressed`);
  assert.equal(state.atmosphere.water.adopted, true, `${label}: shared Bay adapter is inactive`);
  assert.equal(state.atmosphere.water.shaderCompatible, true, `${label}: shipped MeshStandard shader did not compile`);
  assert.equal(state.atmosphere.water.meshIdentity, true, `${label}: shared mesh identity changed`);
  assert.equal(state.atmosphere.water.geometryIdentity, true, `${label}: shared geometry identity changed`);
  assert.equal(state.atmosphere.water.materialIdentity, true, `${label}: shared material identity changed`);
  assert.equal(state.atmosphere.water.mapIdentity, true, `${label}: shared map identity changed`);
}

async function buildPresetThroughStableContext(page, preset) {
  const label = preset || 'hero-rebuild';
  let mainFrameNavigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.waitForLoadState('load', { timeout: 30000 });
    await page.waitForFunction(() => window.__SF_REALMAP__?.getData?.()?.roads?.length > 0, { timeout: 60000 });
    await page.waitForTimeout(350);
    const navigationAtLaunch = mainFrameNavigations;
    try {
      await page.evaluate(({ nextPreset }) => {
        if (nextPreset) window.__SF_REALMAP__.applyPreset(nextPreset);
        window.__SF_SHARED_WATER_QA_BUILD__ = { status: 'running', result: null, error: null };
        Promise.resolve(window.__SF_REALMAP__.build()).then((result) => {
          window.__SF_SHARED_WATER_QA_BUILD__ = { status: 'done', result: result || null, error: null };
        }).catch((error) => {
          window.__SF_SHARED_WATER_QA_BUILD__ = {
            status: 'failed',
            result: null,
            error: error?.message || String(error),
          };
        });
      }, { nextPreset: preset });
    } catch (error) {
      if (/Execution context was destroyed|Cannot find context/i.test(error.message) && attempt < 3) continue;
      throw error;
    }

    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (mainFrameNavigations !== navigationAtLaunch) break;
      let status = null;
      try {
        status = await page.evaluate(() => window.__SF_SHARED_WATER_QA_BUILD__ || null);
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/i.test(error.message)) throw error;
      }
      if (status?.status === 'failed') throw new Error(`${label}: build failed: ${status.error}`);
      if (status?.status === 'done') return status.result;
      await page.waitForTimeout(250).catch(() => {});
    }
    if (mainFrameNavigations === navigationAtLaunch) {
      throw new Error(`${label}: build did not complete within 240000 ms`);
    }
  }
  throw new Error(`${label}: build context navigated during all 3 attempts`);
}

async function verifyRepeatedHeroBuild() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') collectUnexpectedError(errors, message.text());
  });
  try {
    await page.goto(`${baseUrl}/realmap.html?place=ferry-building&mode=walk`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(
      () => window.__SF_REALMAP__?.getPlayerPosition?.() != null
        && window.__SF_REALMAP__?.getHeroAtmosphere?.().water?.shaderCompatible === true,
      { timeout: 60000 },
    );
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => ({
      atmosphere: window.__SF_REALMAP__.getHeroAtmosphere(),
      drawCalls: window.__SF_REALMAP__.getBuildState().renderStats?.drawCalls ?? window.__SF_REALMAP__.getPerf().drawCalls,
      shoreline: window.__SF_REALMAP__.getPerf().heroShoreline,
    }));
    assertHeroWaterState('first hero build', before);
    const rebuildResult = await buildPresetThroughStableContext(page, null);
    assert.equal(rebuildResult?.error, undefined, 'hero rebuild returned an error');
    await page.waitForFunction(
      () => window.__SF_REALMAP__?.getPlayerPosition?.() != null
        && window.__SF_REALMAP__?.getHeroAtmosphere?.().water?.shaderCompatible === true,
      { timeout: 60000 },
    );
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({
      atmosphere: window.__SF_REALMAP__.getHeroAtmosphere(),
      drawCalls: window.__SF_REALMAP__.getBuildState().renderStats?.drawCalls ?? window.__SF_REALMAP__.getPerf().drawCalls,
      shoreline: window.__SF_REALMAP__.getPerf().heroShoreline,
    }));
    assertHeroWaterState('second hero build', after);
    assert.equal(after.shoreline.mask.source.sha256, before.shoreline.mask.source.sha256, 'hero rebuild changed shoreline source digest');
    assert.equal(after.shoreline.mask.sourceRingCount, before.shoreline.mask.sourceRingCount, 'hero rebuild changed shoreline rings');
    assert.equal(after.shoreline.transition.landInsetM, before.shoreline.transition.landInsetM, 'hero rebuild changed shoreline transition');
    assert.equal(errors.length, 0, `repeated hero build browser errors: ${errors.join(' | ')}`);
    return { before, after, errors };
  } finally {
    await context.close();
  }
}

async function buildPreset(preset, expectedFullCity) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    collectUnexpectedError(errors, message.text());
  });
  try {
    await page.goto(`${baseUrl}/realmap.html`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__SF_REALMAP__?.getData?.()?.roads?.length > 0, { timeout: 60000 });
    const result = await buildPresetThroughStableContext(page, preset);
    assert.equal(result?.error, undefined, `${preset}: build returned an error`);
    await page.waitForFunction(
      ({ fullCity }) => window.__SF_REALMAP__?.getBuildState?.().isCity === true
        && window.__SF_REALMAP__?.getPerf?.().fullCity === fullCity,
      { fullCity: expectedFullCity },
      { timeout: 240000 },
    );
    await page.waitForTimeout(1200);
    const state = await page.evaluate(() => ({
      perf: window.__SF_REALMAP__.getPerf(),
      atmosphere: window.__SF_REALMAP__.getHeroAtmosphere(),
    }));
    assert.equal(state.perf.fullCity, expectedFullCity, `${preset}: full-city classification drifted`);
    assert.equal(state.atmosphere.active, false, `${preset}: hero atmosphere activated outside a hero tile`);
    assert.equal(state.atmosphere.water, null, `${preset}: shared Bay adapter activated outside a hero tile`);
    assert.equal(state.atmosphere.waterSurfaces.city, 1, `${preset}: expected one existing broad Bay surface`);
    assert.equal(state.atmosphere.waterSurfaces.shared, 1, `${preset}: broad Bay surface lost its shared identity`);
    assert.equal(state.atmosphere.waterSurfaces.atmosphereRoot, 0, `${preset}: local atmosphere water mesh regressed`);
    assert.equal(errors.length, 0, `${preset}: browser errors: ${errors.join(' | ')}`);
    return {
      preset,
      fullCity: state.perf.fullCity,
      atmosphere: state.atmosphere,
      drawCalls: state.perf.drawCalls,
      errors,
    };
  } finally {
    await context.close();
  }
}

try {
  const repeatedHeroBuild = await verifyRepeatedHeroBuild();
  const nonHero = await buildPreset('downtown', false);
  const fullCity = await buildPreset('city', true);
  console.log(JSON.stringify({
    result: 'shared Bay water full-city/non-hero regression passed',
    repeatedHeroBuild,
    nonHero,
    fullCity,
  }, null, 2));
} finally {
  await browser.close();
}
