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
  await page.waitForTimeout(350);

  const candidates = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles
    .filter((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    ))
    .slice(0, 2));
  assert(candidates.length === 2, 'two private vehicles were not available for arrest setup', candidates);

  const enterCandidate = async (candidate) => {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
    await page.waitForTimeout(50);
    await page.keyboard.press('e');
    return page.evaluate(() => ({
      driving: window.__SF_SIM__.isDriving(),
      vehicle: window.__SF_SIM__.traffic.getPlayerVehicleState(),
      heat: window.__SF_SIM__.getStreetHeatState(),
      thefts: window.__SF_SIM__.traffic.getDiagnostics().vehicleThefts,
    }));
  };

  const firstTheft = await enterCandidate(candidates[0]);
  assert(firstTheft.driving === true
    && firstTheft.heat?.heat === 18
    && firstTheft.thefts === 1,
  'first real E theft did not add exactly 18 heat', firstTheft);
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 0.5,
    null,
    { timeout: 8000 },
  );
  await page.keyboard.up('w');
  await page.keyboard.press('e');

  const secondTheft = await enterCandidate(candidates[1]);
  assert(secondTheft.driving === true
    && secondTheft.heat?.heat === 36
    && secondTheft.heat?.pursuitActive === true
    && secondTheft.thefts === 2,
  'second real E theft did not start the exact 36-heat pursuit', secondTheft);
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponder?.();
    return sim.getStreetHeatState()?.pursuitActive === true
      && responder?.active === true
      && Number.isFinite(responder.position?.x)
      && Number.isFinite(responder.position?.z);
  }, null, { timeout: 10000, polling: 50 });

  const stageAtResponder = () => page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponder();
    const responderRoot = sim.traffic.group.children[responder.id];
    const snapshot = sim.traffic.exportPlayerVehicleState();
    snapshot.position = { x: responder.position.x, z: responder.position.z };
    snapshot.heading = responderRoot.rotation.y;
    return {
      imported: sim.traffic.importPlayerVehicleState(snapshot),
      responder,
      vehicle: sim.traffic.getPlayerVehicleState(),
    };
  });

  const negativeStage = await stageAtResponder();
  assert(negativeStage.imported === true, 'could not stage player vehicle beside live responder', negativeStage);
  await page.keyboard.down('w');
  await page.waitForFunction(
    () => (window.__SF_SIM__.traffic.getPlayerVehicleState()?.speed || 0) > 1.3,
    null,
    { timeout: 4000 },
  );
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  const releasedBeforeDwell = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    driving: window.__SF_SIM__.isDriving(),
    cash: window.__SF_SIM__.lifeSim.getState().cash,
  }));
  assert(releasedBeforeDwell.heat?.arrests === 0
    && releasedBeforeDwell.heat?.pursuitActive === true
    && releasedBeforeDwell.driving === true
    && releasedBeforeDwell.cash === 140,
  'moving before the responder dwell caused an arrest or fine', releasedBeforeDwell);

  const arrestStage = await stageAtResponder();
  assert(arrestStage.imported === true, 'could not restage stopped vehicle for arrest', arrestStage);
  await page.keyboard.down('s');
  await page.waitForFunction(
    () => window.__SF_SIM__.getStreetHeatState()?.arrests === 1,
    null,
    { timeout: 5000, polling: 25 },
  );
  await page.keyboard.up('s');
  const arrested = await page.evaluate((vehicleId) => {
    const sim = window.__SF_SIM__;
    const life = sim.lifeSim.getState();
    const heat = sim.getStreetHeatState();
    const responder = sim.traffic.getPursuitResponder();
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((item) => item.id === vehicleId);
    return {
      heat,
      responder,
      driving: sim.isDriving(),
      vehicle,
      life,
      message: document.querySelector('.hud__message-text')?.textContent || '',
      saved: sim.getSavedProgress(),
    };
  }, candidates[1].id);
  const transaction = arrested.life?.lastTransaction;
  assert(arrested.heat?.heat === 0
    && arrested.heat?.pursuitActive === false
    && arrested.heat?.lastEvent?.kind === 'arrested'
    && arrested.heat?.arrests === 1
    && arrested.responder?.active === false
    && arrested.driving === false,
  'arrest did not atomically clear pursuit/responder/driving state', arrested);
  assert(arrested.vehicle?.action?.key === 'impounded',
    'arrest did not transfer the player vehicle to Ferry impound', arrested.vehicle);
  assert(transaction?.kind === 'wanted-fine'
    && transaction.due >= 20
    && transaction.due <= 120
    && transaction.charged === transaction.due
    && transaction.unpaid === 0
    && arrested.life.cash === 140 - transaction.charged,
  'arrest fine was not an atomic bounded cash transaction', { transaction, life: arrested.life });
  assert(arrested.message.includes('ARRESTED / $')
    && arrested.saved?.snapshot?.streetHeat?.heat === 0
    && arrested.saved?.snapshot?.vehicle?.mode === 'impounded'
    && arrested.saved?.snapshot?.vehicle?.vehicleId === candidates[1].id,
  'arrest feedback or immediate cleared-state save was missing', arrested);

  await page.waitForTimeout(600);
  const oneShot = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    transaction: window.__SF_SIM__.lifeSim.getState().lastTransaction,
  }));
  assert(oneShot.heat?.arrests === 1
    && oneShot.transaction?.at === transaction?.at,
  'arrest event or fine repeated after pursuit cleared', oneShot);

  const qaRelease = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const impounded = sim.traffic.getImpoundedVehicleState();
    return impounded
      ? sim.traffic.retrieveImpoundedPlayerVehicle(impounded.position, impounded.heading)
      : null;
  });
  assert(qaRelease?.mode === 'parked',
    'arrest regression setup could not release the impounded test vehicle', qaRelease);
  const sameVehicle = await enterCandidate({ position: qaRelease?.position });
  assert(sameVehicle.driving === true
    && sameVehicle.heat?.heat === 0
    && sameVehicle.thefts === 2,
  're-entering the already reported vehicle duplicated theft heat', sameVehicle);

  const zeroCash = await page.evaluate(async () => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(-sim.lifeSim.getState().cash);
    sim.streetHeat.restart();
    sim.streetHeat.reportIncident(36, {
      kind: 'qa-booking-pursuit',
      source: 'combat',
      notify: false,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const responder = sim.traffic.getPursuitResponder();
    return { responder, before: sim.lifeSim.getState() };
  });
  assert(zeroCash.before?.cash === 0 && zeroCash.responder?.active === true,
    'zero-cash pursuit setup failed', zeroCash);
  const zeroCashStage = await stageAtResponder();
  assert(zeroCashStage.imported === true, 'zero-cash vehicle arrest staging failed', zeroCashStage);
  await page.keyboard.down('s');
  await page.waitForFunction(
    () => window.__SF_SIM__.getStreetHeatState()?.arrests === 1,
    null,
    { timeout: 5000, polling: 25 },
  );
  await page.keyboard.up('s');
  const zeroCashArrest = await page.evaluate(() => ({
    heat: window.__SF_SIM__.getStreetHeatState(),
    life: window.__SF_SIM__.lifeSim.getState(),
    driving: window.__SF_SIM__.isDriving(),
  }));
  assert(zeroCashArrest.life?.cash === 0
    && zeroCashArrest.life?.lastTransaction?.kind === 'wanted-fine'
    && zeroCashArrest.life?.lastTransaction?.charged === 0
    && zeroCashArrest.life?.lastTransaction?.unpaid >= 20,
  'zero-cash arrest did not clamp payment without negative cash', zeroCashArrest);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'arrest slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'arrest smoke passed'
      : 'arrest smoke failed',
    baseUrl,
    angle,
    candidates: candidates.map(({ id, class: vehicleClass, position }) => ({
      id,
      class: vehicleClass,
      position,
    })),
    firstTheft,
    secondTheft,
    releasedBeforeDwell,
    arrested,
    oneShot,
    sameVehicle,
    zeroCashArrest,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  console.error(JSON.stringify(await page.evaluate(() => ({
    heat: window.__SF_SIM__?.getStreetHeatState?.(),
    responder: window.__SF_SIM__?.traffic?.getPursuitResponder?.(),
    vehicle: window.__SF_SIM__?.traffic?.getPlayerVehicleState?.(),
    driving: window.__SF_SIM__?.isDriving?.(),
  })).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
