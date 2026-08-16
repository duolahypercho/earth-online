import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE
  || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
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
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(900);

  const entry = await page.evaluate(async () => {
    const sim = window.__SF_SIM__;
    const life = sim.traffic.getVehicleLifeSnapshot().vehicles;
    const candidate = life.find((vehicle) => vehicle.action?.key === 'parked'
      && vehicle.identity?.category === 'private'
      && vehicle.damage?.state === 'clear');
    if (!candidate) return null;
    sim.setRoamPose({ x: candidate.position.x, z: candidate.position.z });
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    if (!sim.enterCar()) return null;
    const playerId = sim.traffic.getPlayerVehicleState()?.index;
    const victim = sim.traffic.getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.id !== playerId
      && vehicle.class !== 'bike'
      && vehicle.visible !== false
      && vehicle.action?.key !== 'parked'
      && !vehicle.damage?.disabled
      && vehicle.speed <= 8
      && Number.isFinite(vehicle.heading)
    ));
    if (!victim) return null;
    const snapshot = sim.traffic.exportPlayerVehicleState();
    snapshot.position = {
      x: victim.position.x - Math.sin(victim.heading) * 13.5,
      z: victim.position.z - Math.cos(victim.heading) * 13.5,
    };
    snapshot.heading = victim.heading;
    if (!sim.traffic.importPlayerVehicleState(snapshot)) return null;
    return sim.traffic.getPlayerVehicleState();
  });
  assert(entry?.index >= 0, 'could not enter and stage a collision candidate', entry);
  assert(entry?.damage?.state === 'clear' && entry.damage.ratio === 1,
    'entered vehicle did not start with clear damage state', entry);

  await page.keyboard.down('w');
  await page.waitForFunction(
    () => window.__SF_SIM__.traffic.getDiagnostics().collisionDamageEvents > 0,
    null,
    { timeout: 12000 },
  );
  await page.keyboard.up('w');
  const collision = await page.evaluate(() => ({
    state: window.__SF_SIM__.traffic.getPlayerVehicleState(),
    diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
  }));
  assert(collision.state?.damage?.lastDamage?.source === 'traffic-impact'
    && collision.state.damage.health < collision.state.damage.maxHealth,
  'real traffic collision did not damage the player vehicle', collision);
  assert(collision.diagnostics?.collisionDamageEvents > 0,
    'collision diagnostics did not record the real impact', collision.diagnostics);

  const damaged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim.traffic.getPlayerVehicleState();
    const result = sim.damagePlayerVehicle(state.damage.maxHealth * 0.35, 'qa-barrier-impact');
    return {
      result,
      state: sim.traffic.getPlayerVehicleState(),
      hud: document.querySelector('.hud__drive-mode')?.textContent || '',
    };
  });
  await page.waitForTimeout(250);
  const damagedHud = await page.locator('.hud__drive-mode').textContent();
  assert(damaged.result?.state === 'damaged' && damaged.result?.ratio < 0.7,
    'nonlethal follow-up impact did not enter damaged state', damaged);
  assert(damaged.state?.damage?.lastDamage?.source === 'qa-barrier-impact',
    'player vehicle did not retain damage source', damaged.state);
  assert(damagedHud?.includes('%'), 'drive HUD did not expose vehicle integrity', damagedHud);

  const disabled = await page.evaluate(async () => {
    const sim = window.__SF_SIM__;
    const result = sim.damagePlayerVehicle(200, 'qa-terminal-impact');
    sim.setPlayerInput({ throttle: 1, brake: 0, steer: 1 });
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    const state = sim.traffic.getPlayerVehicleState();
    const life = sim.traffic.getVehicleLifeSnapshot().vehicles.find(
      (vehicle) => vehicle.id === state.index,
    );
    return {
      result,
      state,
      life,
      hud: document.querySelector('.hud__drive-mode')?.textContent || '',
      diagnostics: sim.traffic.getDiagnostics(),
      cash: sim.lifeSim.getState().cash,
      quote: sim.getPlayerVehicleRepairQuote(),
    };
  });
  assert(disabled.result?.disabled === true && disabled.result?.health === 0,
    'terminal impact did not disable the vehicle', disabled.result);
  assert(disabled.state?.speed === 0 && disabled.state?.damage?.state === 'disabled',
    'disabled vehicle still moved under throttle', disabled.state);
  assert(disabled.life?.action?.key === 'vehicle-disabled'
    && disabled.life?.indicators?.hazard === true,
  'fleet snapshot did not expose disabled hazards/action', disabled.life);
  assert(disabled.hud.includes('DISABLED'), 'drive HUD did not expose disabled state', disabled.hud);
  assert(disabled.quote?.cost > 0 && disabled.hud.includes(`$${disabled.quote.cost}`),
    'disabled HUD did not expose a repair quote', disabled);
  assert(disabled.diagnostics?.vehicleDamageEvents >= 3
    && disabled.diagnostics?.collisionDamageEvents >= 1
    && disabled.diagnostics?.disabledVehicles === 1,
  'damage diagnostics did not count damage/disable transitions', disabled.diagnostics);

  const unaffordableBefore = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = sim.lifeSim.getState();
    sim.lifeSim.addCash(-before.cash);
    return { before, after: sim.lifeSim.getState() };
  });
  await page.keyboard.press('r');
  await page.waitForTimeout(120);
  const unaffordable = await page.evaluate(() => ({
    damage: window.__SF_SIM__.traffic.getPlayerVehicleState()?.damage || null,
    life: window.__SF_SIM__.lifeSim.getState(),
    diagnostics: window.__SF_SIM__.traffic.getDiagnostics(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(unaffordable.damage?.disabled === true
    && unaffordable.life.cash === 0
    && unaffordable.diagnostics?.vehicleRepairs === 0
    && unaffordable.message.includes(`costs $${disabled.quote.cost}`),
  'repair key did not refuse an unaffordable transaction', unaffordable);

  await page.evaluate((cash) => window.__SF_SIM__.lifeSim.addCash(cash), disabled.cash);

  await page.keyboard.press('r');
  await page.waitForTimeout(120);
  const repaired = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.exportPlayerVehicleState();
    snapshot.position.x -= Math.sin(snapshot.heading) * 32;
    snapshot.position.z -= Math.cos(snapshot.heading) * 32;
    const relocated = sim.traffic.importPlayerVehicleState(snapshot);
    return {
      result: sim.traffic.getPlayerVehicleState()?.damage || null,
      diagnostics: sim.traffic.getDiagnostics(),
      life: sim.lifeSim.getState(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
      relocated,
    };
  });
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.5,
    null,
    { timeout: 10000 },
  );
  await page.keyboard.up('w');
  const repairedMotion = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      state: sim.traffic.getPlayerVehicleState(),
      diagnostics: sim.traffic.getDiagnostics(),
      exited: sim.exitCar(),
    };
  });
  assert(repaired.relocated === true
    && repaired.result?.state === 'clear' && repaired.result?.ratio === 1,
    'repair did not restore full integrity', repaired.result);
  assert(repaired.message.includes(`$${disabled.quote.cost} paid`),
    'repair key did not expose recovery feedback', repaired.message);
  assert(repaired.life.cash === disabled.cash - disabled.quote.cost
    && repaired.life.lastTransaction?.kind === 'vehicle-repair'
    && repaired.life.lastTransaction?.amount === -disabled.quote.cost,
  'roadside repair did not record the quoted cash transaction', repaired.life);
  assert(repairedMotion.state?.speed > 0.5 && repairedMotion.state?.damage?.disabled === false,
    'repaired vehicle did not return to driving', repairedMotion.state);
  assert(repairedMotion.diagnostics?.disabledVehicles === 0
    && repairedMotion.diagnostics?.vehicleRepairs === 1,
  'repair diagnostics did not clear the disabled fleet count', repairedMotion.diagnostics);
  assert(repairedMotion.exited === true, 'player could not exit after repair', repairedMotion);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'vehicle damage slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'vehicle damage smoke passed'
      : 'vehicle damage smoke failed',
    baseUrl,
    angle,
    entry,
    collision,
    damaged: { ...damaged, hud: damagedHud },
    disabled,
    unaffordable: { ...unaffordable, setup: unaffordableBefore },
    repaired: { ...repaired, motion: repairedMotion },
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'vehicle damage smoke passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'vehicle damage smoke failed',
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
