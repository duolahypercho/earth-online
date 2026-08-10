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
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(350);
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      life: sim.lifeSim.getState(),
      heat: sim.getStreetHeatState(),
      driving: sim.isDriving(),
      vehicle: sim.traffic.getPlayerVehicleState(),
      impound: sim.traffic.getImpoundedVehicleState(),
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function waitForDeliveryDwell() {
  await page.waitForFunction(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.some((vehicle) => (
      vehicle.identity?.category === 'delivery'
      && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.service === 'delivery'
      && vehicle.stop?.dwellRemaining >= 6
      && vehicle.damage?.disabled !== true
    )), null, { timeout: 70000, polling: 40 });
  return page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'delivery'
      && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.service === 'delivery'
      && vehicle.stop?.dwellRemaining >= 6
      && vehicle.damage?.disabled !== true
    )) || null);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  if (angle === 'metal') {
    assert(/metal/i.test(renderer || ''), 'Metal renderer was required but not reported', {
      angle,
      renderer,
    });
  }

  const service = await waitForDeliveryDwell();
  assert(service?.position && service.stop?.service === 'delivery',
    'no real delivery dwell was available for the contract fixture', service);
  if (!service?.position) throw new Error('delivery service unavailable');
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), service.position);
  await page.waitForFunction(({ position, vehicleId }) => {
    const sim = window.__SF_SIM__;
    const delivery = sim.traffic.getNearestDeliveryService(
      sim.getInteractionState().target,
      3.8,
    );
    if (delivery?.index !== vehicleId || !(delivery?.dwellRemaining > 0)) return false;
    const probes = [
      position,
      { x: position.x + 48, z: position.z },
      { x: position.x - 48, z: position.z },
      { x: position.x, z: position.z + 48 },
      { x: position.x, z: position.z - 48 },
    ];
    return probes.some((probe) => {
      const portal = sim.streaming.getNearestEnterablePortal(probe, 120);
      const target = portal?.approach ?? portal?.position;
      const distance = target
        ? Math.hypot(target.x - position.x, target.z - position.z)
        : Infinity;
      return distance >= 16
        && distance <= 120
        && Math.abs(target.x - position.x) >= 8
        && Math.abs(target.z - position.z) >= 8;
    });
  }, { position: service.position, vehicleId: service.id }, { timeout: 5000, polling: 25 });
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.lifeSim.getState().deliveryRun?.active === true,
    null, { timeout: 3000, polling: 25 });
  const started = await evidence();
  assert(started.life.deliveryRun?.service?.vehicleId === service.id
    && started.saved.snapshot?.life?.deliveryRun?.service?.vehicleId === service.id,
  'real E did not start and save the delivery contract', { service, started });

  const candidates = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles
    .filter((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    ))
    .slice(0, 1));
  assert(candidates.length === 1, 'a private car was unavailable for pursuit setup', candidates);

  const enterCandidate = async (candidate) => {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
    await page.waitForTimeout(50);
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true,
      null, { timeout: 3000, polling: 25 });
  };
  await enterCandidate(candidates[0]);
  const staged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.reportIncident(18, { source: 'combat', notify: false });
    return {
      resolved: sim.streetHeat.resolveArrest({ wasDriving: true, reason: 'surrender' }),
      delivery: sim.lifeSim.getState().deliveryRun,
      heat: sim.getStreetHeatState(),
    };
  });
  assert(staged.resolved?.arrests === 1
    && staged.delivery === null
    && staged.heat?.pursuitActive === false,
  'production booking event did not resolve the active pursuit', staged);
  const arrested = await evidence();
  const fineAt = arrested.life.lastTransaction?.at;
  assert(arrested.heat?.heat === 0
    && arrested.heat?.pursuitActive === false
    && arrested.driving === false
    && arrested.impound?.mode === 'impounded'
    && arrested.life.deliveryRun === null
    && arrested.life.deliveryCooldownRemaining > 0
    && arrested.life.lastTransaction?.kind === 'wanted-fine'
    && arrested.message.includes('BAY PARCEL VOIDED')
    && arrested.saved.snapshot?.life?.deliveryRun === null
    && arrested.saved.snapshot?.life?.deliveryCooldownRemaining > 0,
  'booking did not atomically void and save the paid delivery contract', { staged, arrested });

  await page.evaluate((target) => window.__SF_SIM__.setRoamPose(target), started.life.deliveryRun.target);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const afterDestination = await evidence();
  assert(afterDestination.life.deliveryRun === null
    && afterDestination.life.lastTransaction?.kind === 'wanted-fine'
    && afterDestination.life.lastTransaction?.at === fineAt
    && afterDestination.life.cash === arrested.life.cash,
  'voided contract remained collectible at its former destination', {
    arrested,
    afterDestination,
  });

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await evidence();
  assert(restored.life.deliveryRun === null
    && restored.life.deliveryCooldownRemaining > 0
    && restored.life.lastTransaction?.kind === 'wanted-fine'
    && restored.life.lastTransaction?.at === fineAt
    && restored.life.cash === arrested.life.cash
    && restored.heat?.pursuitActive === false,
  'reload restored or paid the booking-voided contract', { arrested, restored });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'arrest-contract slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'arrest contract consequence passed'
      : 'arrest contract consequence failed',
    baseUrl,
    angle,
    renderer,
    service,
    started,
    staged,
    arrested,
    afterDestination,
    restored,
    performance,
    failures,
    consoleErrors,
    httpErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
