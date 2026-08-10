import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
if (!executablePath) throw new Error(`System Chrome is required: ${systemChrome}`);

const angle = process.env.SF_QA_ANGLE || 'metal';
const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  executablePath,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};
const nearlyEqual = (a, b, epsilon = 0.08) => (
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon
);

page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('/favicon.ico')) {
    consoleErrors.push(message.text());
  }
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${response.status()} ${response.url()}`);
  }
});

async function lifeEvidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      driving: sim.isDriving(),
      life: sim.lifeSim.getState(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
      resources: {
        geometries: sim.renderer.info.memory.geometries,
        textures: sim.renderer.info.memory.textures,
      },
    };
  });
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(300);

  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(angle === 'metal'
    && typeof renderer === 'string'
    && /metal/i.test(renderer)
    && !/swiftshader|software|llvmpipe/i.test(renderer),
  'a verified hardware Metal renderer was not active', { angle, renderer });

  const staged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const candidate = sim.traffic.getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.action?.key === 'parked'
      && vehicle.identity?.category === 'private'
      && vehicle.damage?.disabled !== true
      && vehicle.combatEligible !== false
    ));
    if (!candidate) return null;
    sim.setRoamPose(candidate.position);
    return { id: candidate.id, position: candidate.position };
  });
  assert(staged?.id >= 0, 'could not stage a parked private vehicle', staged);

  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving(), null, { timeout: 5000 });
  const direct = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = sim.lifeSim.getState();
    const result = sim.lifeSim.rest();
    const after = sim.lifeSim.getState();
    return { before, result, after };
  });
  assert(direct.result === false
    && direct.after.activity === direct.before.activity
    && direct.after.clock === direct.before.clock
    && direct.after.needs.energy === direct.before.needs.energy,
  'context-free LifeSim rest bypassed the product gate', direct);
  const beforeBlocked = await lifeEvidence();
  await page.keyboard.press('x');
  await page.waitForTimeout(40);
  const blocked = await lifeEvidence();

  assert(blocked.driving === true, 'X unexpectedly exited the active vehicle', blocked);
  assert(blocked.message.includes('Exit the vehicle before resting.'),
    'driving X omitted the rest refusal feedback', blocked);
  assert(blocked.life.activity === beforeBlocked.life.activity
    && blocked.life.clock - beforeBlocked.life.clock < 0.05
    && blocked.life.needs.energy <= beforeBlocked.life.needs.energy + 0.08
    && blocked.life.cash === beforeBlocked.life.cash
    && blocked.life.lastTransaction?.at === beforeBlocked.life.lastTransaction?.at,
  'driving X mutated rest, time, or economy state', { beforeBlocked, blocked });

  await page.keyboard.press('e');
  await page.waitForFunction(() => !window.__SF_SIM__.isDriving(), null, { timeout: 5000 });
  const beforeNoAnchor = await lifeEvidence();
  await page.keyboard.press('x');
  await page.waitForTimeout(30);
  const noAnchor = await lifeEvidence();
  assert(noAnchor.life.activity === beforeNoAnchor.life.activity
    && noAnchor.life.clock - beforeNoAnchor.life.clock < 0.05
    && noAnchor.message.includes('Find a public bench before resting.'),
  'outdoor X away from a bench applied rest or omitted anchor guidance', {
    beforeNoAnchor,
    noAnchor,
  });
  const anchor = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.scene.updateMatrixWorld(true);
    let found = null;
    sim.scene.traverseVisible((object) => {
      if (found || object.isInstancedMesh || !/bench/i.test(String(object.name || ''))) return;
      const elements = object.matrixWorld?.elements;
      if (!elements) return;
      found = { label: object.name, x: elements[12], y: elements[13], z: elements[14] };
    });
    if (found) sim.setRoamPose(found);
    return found;
  });
  assert(anchor, 'no visible authored bench anchor was available', anchor);
  await page.waitForTimeout(500);

  const beforeMoving = await lifeEvidence();
  await page.keyboard.down('w');
  await page.waitForTimeout(80);
  await page.keyboard.press('x');
  await page.waitForTimeout(30);
  await page.keyboard.up('w');
  const moving = await lifeEvidence();
  assert(moving.life.activity === beforeMoving.life.activity
    && moving.life.clock - beforeMoving.life.clock < 0.05
    && moving.message.includes('Stop moving before resting.'),
  'moving X applied rest or omitted refusal feedback', { beforeMoving, moving });

  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), anchor);
  await page.waitForTimeout(100);
  const beforeRest = await lifeEvidence();
  await page.keyboard.press('x');
  await page.waitForTimeout(30);
  const rested = await lifeEvidence();
  assert(rested.driving === false
    && rested.life.activity === 'rest:bench'
    && rested.life.needs.energy === Math.min(100, beforeRest.life.needs.energy + 26)
    && nearlyEqual(rested.life.needs.hunger, Math.min(100, beforeRest.life.needs.hunger + 5), 0.05)
    && nearlyEqual(rested.life.needs.social, Math.max(0, beforeRest.life.needs.social - 3), 0.05)
    && nearlyEqual(rested.life.needs.fun, Math.max(0, beforeRest.life.needs.fun - 4), 0.05)
    && nearlyEqual(rested.life.clock, (beforeRest.life.clock + 0.5) % 24, 0.05)
    && rested.life.cash === beforeRest.life.cash
    && rested.life.lastTransaction?.at === beforeRest.life.lastTransaction?.at,
  'on-foot X did not apply exactly one normal rest', { beforeRest, rested });

  await page.keyboard.down('x');
  await page.waitForTimeout(220);
  await page.keyboard.up('x');
  await page.waitForTimeout(30);
  const held = await lifeEvidence();
  assert(held.life.activity === 'rest:bench'
    && held.message.includes('already well rested')
    && held.life.clock - rested.life.clock < 0.05
    && held.life.needs.energy >= rested.life.needs.energy - 0.08,
  'held or repeated X applied a second rest', { rested, held });

  assert(held.resources.geometries === beforeRest.resources.geometries
    && held.resources.textures === beforeRest.resources.textures,
  'rest gate changed renderer resource counts', { beforeRest, held });

  const saved = await page.evaluate(() => window.__SF_SIM__.getSavedProgress());
  assert(saved?.snapshot?.life?.lastActivity === 'rest:bench'
    && Math.abs(saved.snapshot.life.clock - rested.life.clock) < 0.05
    && saved.snapshot.life.cash === rested.life.cash,
  'successful rest was not saved immediately', { rested, saved });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(100);
  const restored = await lifeEvidence();
  assert(restored.life.activity === 'rest:bench'
    && restored.life.clock - saved.snapshot.life.clock < 0.05
    && restored.life.needs.energy >= saved.snapshot.life.needs.energy - 0.08
    && restored.life.cash === saved.snapshot.life.cash
    && restored.life.lastTransaction?.at === saved.snapshot.life.lastTransaction?.at,
  'reload lost or replayed the saved rest mutation', { saved, restored });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(2400);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'rest vehicle gate exceeded the application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'rest vehicle gate passed'
      : 'rest vehicle gate failed',
    baseUrl,
    angle,
    renderer,
    staged,
    direct,
    beforeBlocked,
    blocked,
    beforeNoAnchor,
    noAnchor,
    anchor,
    beforeMoving,
    moving,
    beforeRest,
    rested,
    held,
    saved,
    restored,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
