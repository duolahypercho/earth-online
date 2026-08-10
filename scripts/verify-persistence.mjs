import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
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

async function launch() {
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(350);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await launch();

  const market = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((candidate) => {
      const label = String(candidate.label || '').toLowerCase();
      return label.includes('ferry') || label.includes('market') || label.includes('cafe');
    });
    if (!portal?.position) return null;
    sim.setRoamPose({ x: portal.position.x, z: portal.position.z });
    return { x: portal.position.x, y: portal.position.y, z: portal.position.z };
  });
  assert(Boolean(market), 'market portal unavailable for persistence setup', market);
  await page.keyboard.press('b');
  await page.keyboard.press('b');
  const combatSetup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.damagePlayer(35, 'qa-persistence');
    sim.setCombatAim(true);
    return {
      fired: sim.fireCombat(),
      combat: sim.getCombatState(),
    };
  });
  assert(combatSetup.fired?.fired === true
    && combatSetup.combat.health === 65
    && combatSetup.combat.ammo === 11,
  'persistence setup did not mutate real combat health and ammunition', combatSetup);
  const progressed = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const first = sim.cityShift.steps[0];
    const second = sim.cityShift.steps[1];
    const advance1 = sim.cityShift.onPortalEntered(first.portal);
    const advance2 = sim.cityShift.onHotspotUsed({ id: second.hotspotId });
    return { advance1: Boolean(advance1), advance2: Boolean(advance2) };
  });
  await page.waitForTimeout(1300);
  const beforeReload = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(progressed.advance1 && progressed.advance2
    && beforeReload.life.cash === 84
    && beforeReload.life.inventory.medkit.count === 2
    && beforeReload.mission.completedSteps === 2
    && beforeReload.combat.health === 65
    && beforeReload.combat.ammo === 11
    && beforeReload.save.snapshot?.combat?.health === 65
    && beforeReload.save.snapshot?.combat?.ammo === 11,
  'autosave setup did not capture economy, combat kit, and mission progress', { progressed, beforeReload });

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    save: window.__SF_SIM__.getSavedProgress(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
    inventoryHud: document.querySelector('.hud__life-inventory')?.textContent || '',
  }));
  assert(restored.life.cash === beforeReload.life.cash
    && restored.life.inventory.medkit.count === beforeReload.life.inventory.medkit.count
    && restored.life.lastTransaction?.kind === 'inventory-purchase'
    && restored.mission.status === 'running'
    && restored.mission.completedSteps === 2
    && restored.mission.cashReward === 0
    && restored.combat.health >= beforeReload.combat.health
    && restored.combat.health < restored.combat.maxHealth
    && restored.combat.recovering === false
    && restored.combat.ammo === beforeReload.combat.ammo
    && restored.combat.reserveAmmo === beforeReload.combat.reserveAmmo
    && restored.message.includes('Progress restored')
    && restored.inventoryHud.includes('MEDKIT / 2 OF 3'),
  'reload did not restore the validated player progress snapshot', { beforeReload, restored });

  const completed = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const advances = sim.cityShift.steps.slice(sim.cityShift.getState().completedSteps).map((step) => (
      step.kind === 'portal'
        ? sim.cityShift.onPortalEntered(step.portal)
        : sim.cityShift.onHotspotUsed({ id: step.hotspotId })
    ));
    return {
      advances: advances.map(Boolean),
      life: sim.lifeSim.getState(),
      mission: sim.cityShift.getState(),
    };
  });
  assert(completed.advances.every(Boolean)
    && completed.mission.status === 'complete'
    && completed.mission.cashReward > 0
    && completed.life.cash === restored.life.cash + completed.mission.cashReward
    && completed.life.lastTransaction?.kind === 'mission-reward',
  'resumed mission did not complete with one payout before persistence', completed);
  await page.waitForTimeout(1100);
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restoredComplete = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
  }));
  assert(restoredComplete.mission.status === 'complete'
    && restoredComplete.life.cash === completed.life.cash
    && restoredComplete.life.lastTransaction?.kind === 'mission-reward'
    && restoredComplete.life.lastTransaction?.at === completed.life.lastTransaction?.at,
  'restoring a completed mission duplicated or lost its payout', { completed, restoredComplete });

  await page.locator('.hud__mission-restart').click();
  await page.waitForTimeout(80);
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restoredReplay = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
  }));
  assert(restoredReplay.mission.status === 'running'
    && restoredReplay.mission.completedSteps === 0
    && restoredReplay.life.cash === completed.life.cash
    && restoredReplay.combat.health === restoredReplay.combat.maxHealth
    && restoredReplay.combat.ammo === restoredReplay.combat.magazineSize
    && restoredReplay.combat.reserveAmmo === 48,
  'replay reset was not saved immediately or corrupted earned cash', restoredReplay);

  const storageKey = restored.save.key;
  await page.evaluate(() => window.__SF_SIM__.clearSavedProgress());
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.evaluate(({ key }) => window.localStorage.setItem(key, '{malformed-json'), { key: storageKey });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const corrupted = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(corrupted.life.cash === 140
    && corrupted.life.inventory.medkit.count === 0
    && corrupted.mission.status === 'running'
    && corrupted.mission.completedSteps === 0
    && corrupted.combat.health === corrupted.combat.maxHealth
    && corrupted.combat.ammo === corrupted.combat.magazineSize
    && corrupted.combat.reserveAmmo === 48
    && corrupted.save.snapshot === null,
  'malformed save did not fall back to clean validated defaults', corrupted);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'persistence slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'persistence smoke passed'
      : 'persistence smoke failed',
    baseUrl,
    angle,
    market,
    progressed,
    beforeReload,
    restored,
    completed,
    restoredComplete,
    restoredReplay,
    corrupted,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'persistence smoke passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'persistence smoke failed',
    error: error.message,
    stack: error.stack,
    consoleErrors,
    httpErrors,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
