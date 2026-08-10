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
const nearlyEqual = (a, b, epsilon = 0.12) => (
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

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      driving: sim.isDriving(),
      life: sim.lifeSim.getState(),
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
      resources: {
        geometries: sim.renderer.info.memory.geometries,
        textures: sim.renderer.info.memory.textures,
      },
    };
  });
}

function unchanged(before, after) {
  return after.life.cash === before.life.cash
    && after.life.inventory.medkit.count === before.life.inventory.medkit.count
    && after.life.activity === before.life.activity
    && after.life.lastTransaction?.at === before.life.lastTransaction?.at
    && nearlyEqual(after.life.needs.hunger, before.life.needs.hunger, 1.5)
    && nearlyEqual(after.life.needs.fun, before.life.needs.fun, 1.5);
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

  const setup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((candidate) => {
      const label = String(candidate?.label || '').toLowerCase();
      return candidate?.position
        && (label.includes('ferry') || label.includes('market') || label.includes('cafe'));
    });
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((candidate) => (
      candidate.action?.key === 'parked'
      && candidate.identity?.category === 'private'
      && candidate.damage?.disabled !== true
    ));
    if (!portal?.position || !vehicle?.position) return null;
    sim.setRoamPose(vehicle.position);
    return {
      market: { x: portal.position.x, y: portal.position.y, z: portal.position.z },
      vehicleId: vehicle.id,
    };
  });
  assert(setup?.vehicleId >= 0, 'market or parked vehicle fixture unavailable', setup);

  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving(), null, { timeout: 5000 });
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), setup.market);
  await page.waitForTimeout(80);
  const drivingBefore = await evidence();
  const directDriving = await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    return {
      canEat: sim.lifeSim.canEat(position),
      ate: sim.lifeSim.eatAtMarket(position),
      bought: sim.lifeSim.buyMedkitAtMarket(position),
    };
  }, setup.market);
  await page.keyboard.press('t');
  await page.keyboard.press('b');
  await page.waitForTimeout(40);
  const drivingAfter = await evidence();
  assert(directDriving.canEat === false
    && directDriving.ate === false
    && directDriving.bought === false
    && unchanged(drivingBefore, drivingAfter)
    && drivingAfter.driving === true
    && drivingAfter.message.includes('Market counter unavailable'),
  'driving market input or direct API mutated life/economy state', {
    directDriving,
    drivingBefore,
    drivingAfter,
  });

  await page.keyboard.press('e');
  await page.waitForFunction(() => !window.__SF_SIM__.isDriving(), null, { timeout: 5000 });
  const remoteApi = await page.evaluate((market) => {
    const sim = window.__SF_SIM__;
    sim.setRoamPose({ x: market.x + 80, z: market.z + 80 });
    const before = sim.lifeSim.getState();
    const canEat = sim.lifeSim.canEat(market);
    const ate = sim.lifeSim.eatAtMarket(market);
    const bought = sim.lifeSim.buyMedkitAtMarket(market);
    return { before, canEat, ate, bought, after: sim.lifeSim.getState() };
  }, setup.market);
  assert(remoteApi.canEat === false
    && remoteApi.ate === false
    && remoteApi.bought === false
    && remoteApi.after.cash === remoteApi.before.cash
    && remoteApi.after.inventory.medkit.count === remoteApi.before.inventory.medkit.count
    && remoteApi.after.lastTransaction?.at === remoteApi.before.lastTransaction?.at,
  'forged market coordinates bypassed the authoritative player position', remoteApi);
  await page.evaluate((position) => {
    window.__SF_SIM__.setRoamPose(position);
    window.__SF_SIM__.restartCombat();
  }, setup.market);
  await page.waitForTimeout(80);

  const downedBefore = await evidence();
  await page.evaluate(() => window.__SF_SIM__.damagePlayer(100, 'qa-market-context'));
  await page.keyboard.press('t');
  await page.keyboard.press('b');
  await page.waitForTimeout(40);
  const downedAfter = await evidence();
  assert(downedAfter.combat.status === 'downed'
    && unchanged(downedBefore, downedAfter),
  'downed market input mutated life/economy state', { downedBefore, downedAfter });
  await page.evaluate(() => window.__SF_SIM__.restartCombat());

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.streetHeat.reportIncident(36, { source: 'combat', notify: false });
  });
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState()?.pursuitActive === true,
    null, { timeout: 10000, polling: 25 });
  const pursuitBefore = await evidence();
  await page.keyboard.press('t');
  await page.keyboard.press('b');
  await page.waitForTimeout(40);
  const pursuitAfter = await evidence();
  assert(pursuitAfter.heat.pursuitActive === true && unchanged(pursuitBefore, pursuitAfter),
    'pursuit market input mutated life/economy state', { pursuitBefore, pursuitAfter });
  await page.evaluate(() => window.__SF_SIM__.streetHeat.restart());

  const contracts = [];
  for (const kind of ['work', 'favor', 'delivery']) {
    const started = await page.evaluate(({ kind, position }) => {
      const sim = window.__SF_SIM__;
      if (kind === 'work') return sim.lifeSim.workShift();
      if (kind === 'favor') return sim.lifeSim.startResidentFavor(
        { id: 'qa-market-resident', label: 'QA Resident', role: 'resident' },
        { id: 'qa-market-target', label: 'QA Target', x: position.x + 20, z: position.z + 20 },
      );
      return sim.lifeSim.startDeliveryRun(
        { vehicleId: 999, identity: 'qa-delivery', label: 'QA Delivery' },
        { id: 'qa-delivery-target', label: 'QA Target', x: position.x + 20, z: position.z + 20 },
      );
    }, { kind, position: setup.market });
    assert(Boolean(started), `${kind} contract fixture did not start`, started);
    const before = await evidence();
    await page.keyboard.press('t');
    await page.keyboard.press('b');
    await page.waitForTimeout(35);
    const after = await evidence();
    assert(unchanged(before, after), `${kind} contract allowed a market mutation`, { before, after });
    contracts.push({ kind, before, after });
    await page.evaluate((activeKind) => {
      const life = window.__SF_SIM__.lifeSim;
      if (activeKind === 'work') life.cancelWorkShift('QA cleanup');
      if (activeKind === 'favor') life.cancelResidentFavor('QA cleanup');
      if (activeKind === 'delivery') life.cancelDeliveryRun('QA cleanup');
    }, kind);
  }

  await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    sim.setRoamPose(position);
    sim.restartCombat();
    sim.streetHeat.restart();
  }, setup.market);
  await page.waitForTimeout(100);
  const mealBefore = await evidence();
  await page.keyboard.press('t');
  await page.waitForTimeout(35);
  const mealAfter = await evidence();
  assert(mealAfter.life.cash === mealBefore.life.cash - 9
    && nearlyEqual(mealAfter.life.needs.hunger, Math.max(0, mealBefore.life.needs.hunger - 42))
    && nearlyEqual(mealAfter.life.needs.fun, Math.min(100, mealBefore.life.needs.fun + 6))
    && mealAfter.life.activity === 'eat:market',
  'valid on-foot T did not apply exactly one market meal', { mealBefore, mealAfter });

  const medkitBefore = await evidence();
  await page.keyboard.press('b');
  await page.waitForTimeout(35);
  const medkitAfter = await evidence();
  assert(medkitAfter.life.cash === medkitBefore.life.cash - medkitBefore.life.inventory.medkit.cost
    && medkitAfter.life.inventory.medkit.count === medkitBefore.life.inventory.medkit.count + 1
    && medkitAfter.life.lastTransaction?.kind === 'inventory-purchase'
    && medkitAfter.life.lastTransaction?.amount === -medkitBefore.life.inventory.medkit.cost,
  'valid on-foot B did not buy exactly one medkit', { medkitBefore, medkitAfter });

  await page.keyboard.down('b');
  await page.waitForTimeout(180);
  await page.keyboard.up('b');
  await page.waitForTimeout(30);
  const held = await evidence();
  assert(held.life.cash === medkitAfter.life.cash - medkitAfter.life.inventory.medkit.cost
    && held.life.inventory.medkit.count === medkitAfter.life.inventory.medkit.count + 1,
  'held B repeated more than its initial non-repeat purchase', { medkitAfter, held });
  assert(held.resources.geometries === mealBefore.resources.geometries
    && held.resources.textures === mealBefore.resources.textures,
  'market context gate changed renderer resource counts', { mealBefore, held });

  const saved = await page.evaluate(() => window.__SF_SIM__.getSavedProgress());
  assert(saved?.snapshot?.life?.cash === held.life.cash
    && saved.snapshot.life.inventory.medkits === held.life.inventory.medkit.count
    && saved.snapshot.life.lastTransaction?.at === held.life.lastTransaction?.at,
  'successful market mutation was not saved immediately', { held, saved });

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(100);
  const restored = await evidence();
  assert(restored.life.cash === saved.snapshot.life.cash
    && restored.life.inventory.medkit.count === saved.snapshot.life.inventory.medkits
    && restored.life.lastTransaction?.at === saved.snapshot.life.lastTransaction?.at,
  'reload lost or replayed the saved market state', { saved, restored });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(2400);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'market context gate exceeded the application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'market context gate passed'
      : 'market context gate failed',
    baseUrl,
    angle,
    renderer,
    setup,
    directDriving,
    remoteApi,
    drivingBefore,
    drivingAfter,
    downedBefore,
    downedAfter,
    pursuitBefore,
    pursuitAfter,
    contracts,
    mealBefore,
    mealAfter,
    medkitBefore,
    medkitAfter,
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
