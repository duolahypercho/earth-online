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
  args: ['--disable-dev-shm-usage', `--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'],
  executablePath,
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
  if (message.type() === 'error' && !message.text().includes('/favicon.ico')) consoleErrors.push(message.text());
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
  await page.waitForTimeout(300);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await launch();
  await page.evaluate(() => window.__SF_SIM__.clearSavedProgress());

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

  const outside = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = { life: sim.lifeSim.getState(), combat: sim.getCombatState() };
    const result = sim.lifeSim.buyAmmoAtMarket(
      { x: 99999, z: 99999 },
      before.combat.reserveAmmo,
      before.combat.reserveCapacity,
    );
    return {
      before,
      result,
      after: { life: sim.lifeSim.getState(), combat: sim.getCombatState() },
    };
  });
  assert(outside.result === null
    && outside.after.life.cash === outside.before.life.cash
    && outside.after.combat.reserveAmmo === outside.before.combat.reserveAmmo,
  'outside-market ammunition purchase mutated cash or reserve', outside);

  const setup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((candidate) => {
      const label = String(candidate.label || '').toLowerCase();
      return label.includes('ferry') || label.includes('market') || label.includes('cafe');
    });
    sim.setRoamPose({ x: portal.position.x, z: portal.position.z });
    const before = sim.lifeSim.getState();
    sim.lifeSim.addCash(-before.cash);
    return { position: portal.position, before, zeroCash: sim.lifeSim.getState() };
  });
  await page.keyboard.press('n');
  const refused = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(refused.life.cash === 0
    && refused.combat.reserveAmmo === 48
    && refused.message.includes('$32'),
  'zero-cash ammunition purchase mutated state or lacked price feedback', refused);

  await page.evaluate((cash) => window.__SF_SIM__.lifeSim.addCash(cash), setup.before.cash);
  const downedBefore = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.damagePlayer(100, 'qa-ammo-economy');
    return { life: sim.lifeSim.getState(), combat: sim.getCombatState() };
  });
  await page.keyboard.press('n');
  const downedRefusal = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(downedBefore.combat.status === 'downed'
    && downedRefusal.combat.status === 'downed'
    && downedRefusal.life.cash === downedBefore.life.cash
    && downedRefusal.life.lastTransaction === downedBefore.life.lastTransaction
    && downedRefusal.combat.reserveAmmo === downedBefore.combat.reserveAmmo
    && downedRefusal.message.includes('after recovering'),
  'downed market input charged cash or mutated reserve before stock refusal', { downedBefore, downedRefusal });
  await page.evaluate(() => window.__SF_SIM__.restartCombat());

  await page.evaluate(() => window.__SF_SIM__.streetHeat.reportIncident(36, {
    source: 'combat',
    notify: false,
  }));
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState()?.pursuitActive === true,
    null, { timeout: 5000, polling: 25 });
  const pursuitBefore = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  const rawPursuitPurchase = await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    const combat = sim.getCombatState();
    return sim.lifeSim.buyAmmoAtMarket(position, combat.reserveAmmo, combat.reserveCapacity);
  }, setup.position);
  await page.keyboard.press('n');
  await page.waitForTimeout(80);
  const pursuitRefusal = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    save: window.__SF_SIM__.getSavedProgress(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(rawPursuitPurchase === null
    && pursuitRefusal.heat.pursuitActive === true
    && pursuitRefusal.life.cash === pursuitBefore.life.cash
    && pursuitRefusal.life.activity === pursuitBefore.life.activity
    && pursuitRefusal.life.lastTransaction?.at === pursuitBefore.life.lastTransaction?.at
    && pursuitRefusal.combat.reserveAmmo === pursuitBefore.combat.reserveAmmo
    && pursuitRefusal.save.snapshot?.life?.cash === pursuitBefore.life.cash
    && pursuitRefusal.save.snapshot?.life?.lastTransaction?.at === pursuitBefore.life.lastTransaction?.at
    && pursuitRefusal.save.snapshot?.combat?.reserveAmmo === pursuitBefore.combat.reserveAmmo
    && pursuitRefusal.message.includes('clear of pursuit'),
  'active pursuit raw/real N restock mutated combat, economy, or persistence', {
    pursuitBefore,
    rawPursuitPurchase,
    pursuitRefusal,
  });
  await page.evaluate(() => window.__SF_SIM__.streetHeat.restart());

  const activeWork = await page.evaluate(() => window.__SF_SIM__.lifeSim.workShift());
  const contractBefore = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
  }));
  await page.keyboard.press('n');
  await page.waitForTimeout(60);
  const contractRefusal = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(activeWork === true
    && contractRefusal.life.cash === contractBefore.life.cash
    && contractRefusal.life.lastTransaction?.at === contractBefore.life.lastTransaction?.at
    && contractRefusal.combat.reserveAmmo === contractBefore.combat.reserveAmmo
    && contractRefusal.message.includes('Market counter unavailable'),
  'active contract allowed a real N ammunition purchase', { contractBefore, contractRefusal });
  await page.evaluate(() => window.__SF_SIM__.lifeSim.cancelWorkShift('QA cleanup'));

  const rawAuthorizedPurchase = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = { life: sim.lifeSim.getState(), combat: sim.getCombatState() };
    const purchase = sim.lifeSim.buyAmmoAtMarket({ x: 99999, z: 99999 }, 0, 999);
    return {
      before,
      purchase,
      after: { life: sim.lifeSim.getState(), combat: sim.getCombatState() },
    };
  });
  assert(rawAuthorizedPurchase.purchase?.rounds === 24
    && rawAuthorizedPurchase.purchase?.stock?.added === 24
    && rawAuthorizedPurchase.after.combat.reserveAmmo === rawAuthorizedPurchase.before.combat.reserveAmmo + 24
    && rawAuthorizedPurchase.after.life.cash === rawAuthorizedPurchase.before.life.cash - 32
    && rawAuthorizedPurchase.after.life.lastTransaction?.kind === 'ammo-purchase',
  'valid raw purchase did not atomically stock authoritative reserve and charge once', rawAuthorizedPurchase);

  const purchases = [];
  for (let index = 0; index < 2; index += 1) {
    await page.keyboard.press('n');
    purchases.push(await page.evaluate(() => ({
      life: window.__SF_SIM__.lifeSim.getState(),
      combat: window.__SF_SIM__.getCombatState(),
      hud: document.querySelector('#combat-ammo')?.textContent || '',
      message: document.querySelector('.hud__message-text')?.textContent || '',
    })));
  }
  const stocked = purchases.at(-1);
  assert(purchases.map((entry) => entry.combat.reserveAmmo).join(',') === '96,120'
    && stocked.life.cash === 44
    && stocked.life.lastTransaction?.kind === 'ammo-purchase'
    && stocked.life.lastTransaction?.amount === -32
    && stocked.message.includes('120/120 reserve'),
  'real market purchases did not charge cash and fill reserve in 24-round boxes', purchases);

  const forgedFullPurchase = await page.evaluate(() => window.__SF_SIM__.lifeSim.buyAmmoAtMarket(
    { x: 99999, z: 99999 },
    0,
    999,
  ));
  await page.keyboard.press('n');
  const capped = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(forgedFullPurchase === null
    && capped.life.cash === stocked.life.cash
    && capped.combat.reserveAmmo === 120
    && capped.message.includes('reserve full')
    && capped.save.snapshot?.combat?.reserveAmmo === 120,
  'reserve-cap refusal charged cash, exceeded capacity, or missed immediate save', capped);

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    inventoryHud: document.querySelector('.hud__life-inventory')?.textContent || '',
  }));
  assert(restored.life.cash === 44
    && restored.life.lastTransaction?.kind === 'ammo-purchase'
    && restored.combat.reserveAmmo === 120
    && restored.combat.reserveCapacity === 120
    && restored.inventoryHud.includes('AMMO / N BUY $32'),
  'ammo purchase did not survive immediate reload or update inventory HUD', restored);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(performance.applicationHardBudgetMet === true, 'ammo economy exceeded application frame budget', performance);
  assert(consoleErrors.length === 0, 'console errors detected', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors detected', httpErrors);

  const result = {
    result: failures.length === 0 ? 'ammo economy smoke passed' : 'ammo economy smoke failed',
    baseUrl,
    angle,
    renderer,
    outside,
    refused,
    downedRefusal,
    pursuitRefusal,
    contractRefusal,
    rawAuthorizedPurchase,
    purchases,
    forgedFullPurchase,
    capped,
    restored,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'ammo economy smoke failed',
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
