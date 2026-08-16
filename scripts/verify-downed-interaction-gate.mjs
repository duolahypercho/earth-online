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
page.on('requestfailed', (request) => {
  if (!request.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  }
});

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.getState();
    return {
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      interior: sim.city.getInteriorState(),
      interaction: sim.getInteractionState(),
      shift: sim.cityShift.getState(),
      life,
      roam: sim.getRoamState(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
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

  const portalStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.restartCombat();
    const portal = sim.city.portals.find((entry) => /welcome center/i.test(entry.label));
    const approach = portal?.approachRoute?.[portal.approachRoute.length - 1] || portal?.position;
    if (!portal || !approach) return null;
    sim.setRoamPose(approach);
    return { id: portal.id, label: portal.label, approach };
  });
  assert(portalStage?.id, 'Welcome Center portal staging was unavailable', portalStage);
  await page.waitForFunction((portalId) => {
    const interaction = window.__SF_SIM__.getInteractionState();
    return interaction.portal?.id === portalId && interaction.portal.enabled;
  }, portalStage.id, { timeout: 5000, polling: 25 });

  await page.evaluate(() => window.__SF_SIM__.damagePlayer(100, 'qa-downed-interaction'));
  await page.waitForFunction(() => window.__SF_SIM__.getCombatState().status === 'downed',
    null, { timeout: 3000, polling: 20 });
  const beforeKeyboard = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(100);
  const keyboardRefusal = await evidence();
  const keyboardDisplacement = Math.hypot(
    keyboardRefusal.roam.target.x - beforeKeyboard.roam.target.x,
    keyboardRefusal.roam.target.z - beforeKeyboard.roam.target.z,
  );
  assert(keyboardRefusal.combat.status === 'downed'
    && keyboardRefusal.interior.active === false
    && keyboardRefusal.interaction.mode === 'roam'
    && keyboardRefusal.shift.completedSteps === beforeKeyboard.shift.completedSteps
    && keyboardRefusal.shift.score === beforeKeyboard.shift.score
    && keyboardRefusal.life.cash === beforeKeyboard.life.cash
    && keyboardRefusal.life.lastTransaction?.at === beforeKeyboard.life.lastTransaction?.at
    && keyboardRefusal.heat.heat === beforeKeyboard.heat.heat
    && keyboardDisplacement <= 0.05
    && keyboardRefusal.message.includes('RECOVER BEFORE ENTERING'),
  'downed real E entered or mutated the portal interaction', {
    beforeKeyboard,
    keyboardRefusal,
    keyboardDisplacement,
  });

  await page.locator('.hud__interaction').click();
  await page.waitForTimeout(100);
  const touchRefusal = await evidence();
  assert(touchRefusal.interior.active === false
    && touchRefusal.shift.completedSteps === beforeKeyboard.shift.completedSteps
    && touchRefusal.life.cash === beforeKeyboard.life.cash
    && touchRefusal.message.includes('RECOVER BEFORE ENTERING'),
  'downed touch interaction entered or mutated the portal', touchRefusal);

  await page.keyboard.down('e');
  await page.waitForTimeout(220);
  await page.keyboard.up('e');
  const heldRefusal = await evidence();
  assert(heldRefusal.interior.active === false
    && heldRefusal.shift.completedSteps === beforeKeyboard.shift.completedSteps,
  'held downed E bypassed or duplicated the portal refusal', heldRefusal);

  await page.evaluate(() => window.__SF_SIM__.restartCombat());
  await page.waitForFunction(() => {
    const combat = window.__SF_SIM__.getCombatState();
    return combat.status === 'running' && combat.active === true;
  },
    null, { timeout: 3000, polling: 20 });
  await page.waitForFunction((portalId) => {
    const interaction = window.__SF_SIM__.getInteractionState();
    return interaction.portal?.id === portalId && interaction.portal.enabled;
  }, portalStage.id, { timeout: 5000, polling: 25 });
  await page.locator('canvas').focus();
  await page.keyboard.press('e');
  await page.waitForTimeout(700);
  const entered = await evidence();
  assert(entered.interior.active === true
    && entered.interior.portalId === portalStage.id
    && entered.shift.completedSteps === beforeKeyboard.shift.completedSteps + 1,
  'recovered real E did not enter and advance the Welcome Center once', {
    portalStage,
    beforeKeyboard,
    entered,
  });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.combat.setEnabled(true);
    sim.damagePlayer(100, 'qa-downed-hotspot');
  });
  await page.waitForFunction(() => window.__SF_SIM__.getCombatState().status === 'downed',
    null, { timeout: 3000, polling: 20 });
  const beforeHotspot = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(100);
  const hotspotRefusal = await evidence();
  assert(hotspotRefusal.interior.active === true
    && hotspotRefusal.interaction.mode === 'interior'
    && hotspotRefusal.shift.completedSteps === beforeHotspot.shift.completedSteps
    && hotspotRefusal.shift.score === beforeHotspot.shift.score
    && hotspotRefusal.life.cash === beforeHotspot.life.cash
    && hotspotRefusal.life.lastTransaction?.at === beforeHotspot.life.lastTransaction?.at
    && hotspotRefusal.message.includes('RECOVER BEFORE USING THIS HOTSPOT'),
  'downed interior E exited or advanced a hotspot', { beforeHotspot, hotspotRefusal });

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__SF_SIM__.getInteractionState().mode === 'roam',
    null, { timeout: 5000, polling: 25 });
  const escaped = await evidence();
  assert(escaped.interior.active === false && escaped.combat.status === 'downed',
    'Escape did not remain an emergency interior exit while downed', escaped);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1800);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(Number.isFinite(performance.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'downed interaction gate exceeded the application frame budget', performance);

  const report = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'downed interaction gate passed'
      : 'downed interaction gate failed',
    angle,
    renderer,
    portalStage,
    beforeKeyboard,
    keyboardRefusal,
    keyboardDisplacement,
    touchRefusal,
    heldRefusal,
    entered,
    beforeHotspot,
    hotspotRefusal,
    escaped,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
