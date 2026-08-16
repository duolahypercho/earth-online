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

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
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
  await page.waitForTimeout(500);

  const setup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((candidate) => {
      const label = String(candidate.label || '').toLowerCase();
      return label.includes('ferry') || label.includes('market') || label.includes('cafe');
    });
    if (!portal?.position) return { found: false };
    sim.setRoamPose({ x: portal.position.x, z: portal.position.z });
    const before = sim.lifeSim.getState();
    sim.lifeSim.addCash(-before.cash);
    return {
      found: true,
      position: { x: portal.position.x, y: portal.position.y, z: portal.position.z },
      before,
      zeroCash: sim.lifeSim.getState(),
    };
  });
  assert(setup.found === true, 'market portal unavailable for inventory purchase', setup);

  await page.keyboard.press('b');
  await page.waitForTimeout(120);
  const refused = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(refused.life.cash === 0
    && refused.life.inventory.medkit.count === 0
    && refused.message.includes('$28'),
  'real B purchase did not refuse cleanly with insufficient funds', refused);

  await page.keyboard.press('g');
  await page.waitForTimeout(80);
  const emptyUse = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(emptyUse.life.inventory.medkit.count === 0
    && emptyUse.combat.health === emptyUse.combat.maxHealth
    && emptyUse.message.includes('No medkits'),
  'empty medkit input mutated health or inventory', emptyUse);

  const outsideMarket = await page.evaluate(({ cash, market }) => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(cash);
    sim.setRoamPose({ x: market.x + 80, z: market.z + 80 });
    const before = sim.lifeSim.getState();
    const purchased = sim.lifeSim.buyMedkitAtMarket(market);
    const after = sim.lifeSim.getState();
    sim.setRoamPose(market);
    return { before, purchased, after };
  }, { cash: setup.before.cash, market: setup.position });
  assert(outsideMarket.purchased === false
    && outsideMarket.after.cash === outsideMarket.before.cash
    && outsideMarket.after.inventory.medkit.count === outsideMarket.before.inventory.medkit.count,
  'medkit purchase succeeded away from a market or mutated inventory', outsideMarket);

  await page.keyboard.press('b');
  await page.waitForTimeout(120);
  const purchased = await page.evaluate(() => window.__SF_SIM__.lifeSim.getState());
  assert(purchased.inventory.medkit.count === 1
    && purchased.cash === setup.before.cash - purchased.inventory.medkit.cost
    && purchased.lastTransaction?.kind === 'inventory-purchase'
    && purchased.lastTransaction?.amount === -purchased.inventory.medkit.cost,
  'real B purchase did not add one medkit and record the cash transaction', purchased);

  const capacity = await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    const second = sim.lifeSim.buyMedkitAtMarket(position);
    const third = sim.lifeSim.buyMedkitAtMarket(position);
    const beforeFourth = sim.lifeSim.getState();
    const fourth = sim.lifeSim.buyMedkitAtMarket(position);
    return { second, third, beforeFourth, fourth, afterFourth: sim.lifeSim.getState() };
  }, setup.position);
  assert(capacity.second === true
    && capacity.third === true
    && capacity.fourth === false
    && capacity.beforeFourth.inventory.medkit.count === capacity.beforeFourth.inventory.medkit.capacity
    && capacity.afterFourth.cash === capacity.beforeFourth.cash,
  'medkit capacity did not cap inventory without charging cash', capacity);

  const damaged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.damagePlayer(60, 'qa-inventory');
    return { life: sim.lifeSim.getState(), combat: sim.getCombatState() };
  });
  await page.keyboard.press('g');
  await page.waitForTimeout(100);
  const healed = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(damaged.combat.health === 40
    && healed.combat.health === 85
    && healed.life.inventory.medkit.count === 2
    && healed.message.includes('Medkit used'),
  'real G input did not consume one medkit and heal combat health by 45', { damaged, healed });

  await page.keyboard.press('g');
  await page.waitForTimeout(80);
  const full = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
  }));
  await page.keyboard.press('g');
  await page.waitForTimeout(80);
  const fullRefusal = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    hud: document.querySelector('.hud__life-inventory')?.textContent || '',
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(full.combat.health === full.combat.maxHealth
    && full.life.inventory.medkit.count === 1
    && fullRefusal.combat.health === full.combat.health
    && fullRefusal.life.inventory.medkit.count === full.life.inventory.medkit.count
    && fullRefusal.message.includes('already full')
    && fullRefusal.hud.includes('MEDKIT / 1 OF 3'),
  'full-health medkit input consumed inventory or failed to update HUD', { full, fullRefusal });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'inventory slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'inventory smoke passed'
      : 'inventory smoke failed',
    baseUrl,
    angle,
    setup,
    refused,
    emptyUse,
    outsideMarket,
    purchased,
    capacity,
    damaged,
    healed,
    full,
    fullRefusal,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'inventory smoke passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'inventory smoke failed',
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
