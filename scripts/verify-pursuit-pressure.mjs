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

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      responders: sim.traffic.getPursuitResponders(),
      life: sim.lifeSim.getState(),
      saved: sim.getSavedProgress(),
      resources: {
        geometries: sim.renderer.info.memory.geometries,
        textures: sim.renderer.info.memory.textures,
      },
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function stageInPressureBand(distance = 24) {
  return page.evaluate((targetDistance) => {
    const sim = window.__SF_SIM__;
    const responders = sim.traffic.getPursuitResponders();
    const responder = responders.slice().sort((a, b) => a.id - b.id)[0];
    if (!responder?.position) return null;
    sim.setRoamPose({ x: responder.position.x + targetDistance, z: responder.position.z });
    return { id: responder.id, position: responder.position, targetDistance };
  }, distance);
}

async function stageClearOfResponders(distance = 55) {
  return page.evaluate((clearance) => {
    const sim = window.__SF_SIM__;
    const responders = sim.traffic.getPursuitResponders();
    if (!responders.length) return null;
    const x = Math.max(...responders.map((entry) => entry.position.x)) + clearance;
    const z = Math.max(...responders.map((entry) => entry.position.z)) + clearance;
    sim.setRoamPose({ x, z });
    return { x, z, ids: responders.map((entry) => entry.id) };
  }, distance);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(250);

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

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.restartCombat();
    sim.streetHeat.reportIncident(42, { source: 'combat', notify: false });
  });
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().level === 1
    && window.__SF_SIM__.traffic.getPursuitResponders().length === 1,
  null, { timeout: 10000, polling: 25 });
  const levelOneStage = await stageInPressureBand();
  const levelOneBefore = await evidence();
  await page.waitForTimeout(950);
  const levelOneAfter = await evidence();
  assert(levelOneAfter.heat.level === 1
    && levelOneAfter.heat.pressure.count === 0
    && levelOneAfter.combat.health === levelOneBefore.combat.health,
  'HEAT 1 produced ranged pressure', { levelOneStage, levelOneBefore, levelOneAfter });

  await page.evaluate(() => window.__SF_SIM__.streetHeat.reportIncident(30, {
    source: 'combat',
    notify: false,
  }));
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().level === 2
    && window.__SF_SIM__.traffic.getPursuitResponders().length === 2,
  null, { timeout: 10000, polling: 25 });
  const levelTwoStage = await stageInPressureBand();
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().pressure.phase === 'locking',
    null, { timeout: 4000, polling: 20 });
  const levelTwoLock = await evidence();
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().pressure.count === 1,
    null, { timeout: 5000, polling: 20 });
  const levelTwoHit = await evidence();
  assert(levelTwoLock.combat.health === levelOneAfter.combat.health
    && levelTwoLock.heat.pressure.lock > 0
    && levelTwoHit.combat.health === levelTwoLock.combat.health - 8
    && levelTwoHit.combat.lastEvent?.source === 'pursuit-pressure'
    && levelTwoHit.heat.responderContacts === 0
    && levelTwoHit.heat.pressure.phase === 'cooldown',
  'HEAT 2 pressure did not telegraph then apply exactly 8 health', {
    levelTwoStage,
    levelTwoLock,
    levelTwoHit,
  });
  await page.waitForTimeout(900);
  const levelTwoCooldown = await evidence();
  assert(levelTwoCooldown.heat.pressure.count === 1
    && levelTwoCooldown.combat.health === levelTwoHit.combat.health,
  'HEAT 2 pressure repeated inside its cooldown', { levelTwoHit, levelTwoCooldown });

  await stageClearOfResponders();
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.__SF_SIM__.streetHeat.reportIncident(35, {
    source: 'combat',
    notify: false,
  }));
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().level === 3
    && window.__SF_SIM__.traffic.getPursuitResponders().length === 3,
  null, { timeout: 10000, polling: 25 });
  const levelThreeStage = await stageInPressureBand();
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().pressure.phase === 'locking',
    null, { timeout: 5000, polling: 20 });
  const levelThreeLock = await evidence();
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().pressure.count === 2,
    null, { timeout: 5000, polling: 20 });
  const levelThreeHit = await evidence();
  assert(levelThreeLock.combat.health === levelTwoHit.combat.health
    && levelThreeHit.combat.health === levelThreeLock.combat.health - 10
    && levelThreeHit.combat.lastEvent?.source === 'pursuit-pressure'
    && levelThreeHit.heat.responderContacts === 0,
  'HEAT 3 pressure did not telegraph then apply exactly 10 health', {
    levelThreeStage,
    levelThreeLock,
    levelThreeHit,
  });

  await page.waitForTimeout(1800);
  const cancelStage = await stageInPressureBand();
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().pressure.phase === 'locking',
    null, { timeout: 5000, polling: 20 });
  const beforeCancel = await evidence();
  const clearStage = await stageClearOfResponders();
  await page.waitForTimeout(900);
  const cancelled = await evidence();
  assert(cancelled.heat.pressure.count === beforeCancel.heat.pressure.count
    && cancelled.combat.health === beforeCancel.combat.health
    && cancelled.heat.pressure.phase === 'idle',
  'leaving the pressure band did not cancel the telegraph', {
    cancelStage,
    clearStage,
    beforeCancel,
    cancelled,
  });

  const saved = await page.evaluate(() => {
    window.__SF_SIM__.saveProgress();
    return window.__SF_SIM__.getSavedProgress();
  });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(80);
  const restored = await evidence();
  assert(restored.combat.health === saved.snapshot.combat.health
    && restored.heat.heat <= Math.ceil(saved.snapshot.streetHeat.heat)
    && restored.heat.pursuitActive === true
    && restored.heat.pressure.count === 0
    && restored.heat.pressure.phase === 'idle',
  'reload lost pressure damage or replayed transient pressure state', { saved, restored });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(2400);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'pressure gate exceeded the application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'pursuit pressure passed'
      : 'pursuit pressure failed',
    baseUrl,
    angle,
    renderer,
    levelOneStage,
    levelOneBefore,
    levelOneAfter,
    levelTwoStage,
    levelTwoLock,
    levelTwoHit,
    levelTwoCooldown,
    levelThreeStage,
    levelThreeLock,
    levelThreeHit,
    cancelStage,
    clearStage,
    beforeCancel,
    cancelled,
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
