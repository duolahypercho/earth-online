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
const nearlyEqual = (a, b, epsilon = 0.02) => Math.abs(Number(a) - Number(b)) <= epsilon;

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
  await page.waitForTimeout(300);
}

async function reloadAndLaunch() {
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
}

async function getLifeEvidence() {
  return page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    saved: window.__SF_SIM__.getSavedProgress(),
    combat: window.__SF_SIM__.getCombatState(),
    driving: window.__SF_SIM__.isDriving(),
    interaction: window.__SF_SIM__.getInteractionState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  const market = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((entry) => {
      const label = String(entry.label || '').toLowerCase();
      return label.includes('ferry building market hall')
        || label.includes('market')
        || label.includes('cafe');
    });
    if (!portal) return null;
    const offsets = [[32, 32], [-32, 32], [32, -32], [-32, -32], [48, 0], [0, 48]];
    const outOfRange = offsets
      .map(([x, z]) => ({ x: portal.position.x + x, z: portal.position.z + z }))
      .find((position) => sim.lifeSim.canWork(position) === false);
    return {
      label: portal.label,
      position: { x: portal.position.x, y: portal.position.y, z: portal.position.z },
      outOfRange,
    };
  });
  assert(market?.position && market?.outOfRange, 'market and out-of-range work poses unavailable', market);

  const initial = await getLifeEvidence();
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), market.outOfRange);
  await page.waitForTimeout(60);
  await page.keyboard.press('f');
  await page.waitForTimeout(60);
  const outOfRange = await getLifeEvidence();
  assert(outOfRange.life?.workShift?.active === false
    && outOfRange.life?.cash === initial.life?.cash
    && outOfRange.life?.lastTransaction?.at === initial.life?.lastTransaction?.at,
  'out-of-range real F mutated or started work', { initial, outOfRange });

  const vehicleCandidate = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.class !== 'bike'
      && vehicle.damage?.disabled !== true
      && vehicle.action?.key === 'parked'
    )) || null);
  assert(vehicleCandidate?.id >= 0, 'parked vehicle unavailable for driving work refusal', vehicleCandidate);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), vehicleCandidate.position);
  await page.waitForTimeout(60);
  await page.keyboard.press('e');
  await page.waitForTimeout(80);
  const beforeDrivingF = await getLifeEvidence();
  await page.keyboard.press('f');
  await page.waitForTimeout(60);
  const drivingF = await getLifeEvidence();
  assert(beforeDrivingF.driving === true
    && drivingF.life?.workShift?.active === false
    && drivingF.life?.cash === beforeDrivingF.life?.cash
    && drivingF.life?.lastTransaction?.at === beforeDrivingF.life?.lastTransaction?.at,
  'driving real F started work or mutated the economy', { beforeDrivingF, drivingF });
  await page.keyboard.press('e');
  await page.waitForTimeout(80);

  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), market.position);
  await page.waitForTimeout(80);
  await page.keyboard.press('e');
  await page.waitForFunction(
    () => window.__SF_SIM__.getInteractionState()?.mode === 'interior',
    null,
    { timeout: 4000 },
  );
  const beforeInteriorF = await getLifeEvidence();
  await page.keyboard.press('f');
  await page.waitForTimeout(60);
  const interiorF = await getLifeEvidence();
  assert(interiorF.life?.workShift?.active === false
    && interiorF.life?.cash === beforeInteriorF.life?.cash
    && interiorF.life?.lastTransaction?.at === beforeInteriorF.life?.lastTransaction?.at,
  'interior real F started work or mutated the economy', { beforeInteriorF, interiorF });
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => window.__SF_SIM__.getInteractionState()?.mode === 'roam',
    null,
    { timeout: 4000 },
  );

  await page.evaluate((position) => {
    const sim = window.__SF_SIM__;
    sim.setRoamPose(position);
    sim.restartCombat();
    sim.damagePlayer(100, 'qa-work-shift');
  }, market.position);
  await page.waitForTimeout(80);
  const beforeDownedF = await getLifeEvidence();
  await page.keyboard.press('f');
  await page.waitForTimeout(60);
  const downedF = await getLifeEvidence();
  assert(beforeDownedF.combat?.status === 'downed'
    && downedF.life?.workShift?.active === false
    && downedF.life?.cash === beforeDownedF.life?.cash
    && downedF.life?.lastTransaction?.at === beforeDownedF.life?.lastTransaction?.at,
  'downed real F started work or mutated the economy', { beforeDownedF, downedF });
  await page.evaluate(() => window.__SF_SIM__.restartCombat());

  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), market.position);
  await page.waitForTimeout(80);
  const beforeCancel = await getLifeEvidence();
  await page.keyboard.press('f');
  await page.waitForTimeout(80);
  const startedForCancel = await getLifeEvidence();
  await page.keyboard.down('w');
  await page.waitForTimeout(90);
  await page.keyboard.up('w');
  await page.waitForTimeout(60);
  const cancelled = await getLifeEvidence();
  assert(startedForCancel.life?.workShift?.active === true
    && startedForCancel.life?.cash === beforeCancel.life?.cash
    && cancelled.life?.workShift?.active === false
    && cancelled.life?.cash === beforeCancel.life?.cash
    && cancelled.life?.lastTransaction?.at === beforeCancel.life?.lastTransaction?.at,
  'movement did not cancel a pending shift without payout', {
    beforeCancel,
    startedForCancel,
    cancelled,
  });

  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), market.position);
  await page.waitForTimeout(80);
  const beforeInterrupted = await getLifeEvidence();
  await page.keyboard.press('f');
  await page.waitForTimeout(1200);
  const activeBeforeReload = await getLifeEvidence();
  assert(activeBeforeReload.life?.workShift?.active === true
    && activeBeforeReload.life?.cash === beforeInterrupted.life?.cash
    && activeBeforeReload.saved?.snapshot?.life?.cash === beforeInterrupted.life?.cash,
  'in-progress shift paid or failed to autosave safely before reload', {
    beforeInterrupted,
    activeBeforeReload,
  });
  await reloadAndLaunch();
  const interruptedReload = await getLifeEvidence();
  assert(interruptedReload.life?.workShift?.active === false
    && interruptedReload.life?.workShift?.status === 'ready'
    && interruptedReload.life?.cash === beforeInterrupted.life?.cash
    && interruptedReload.life?.lastTransaction?.at === beforeInterrupted.life?.lastTransaction?.at,
  'reload did not cancel in-progress work without payout', interruptedReload);

  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), market.position);
  await page.waitForTimeout(80);
  const beforeComplete = await getLifeEvidence();
  await page.keyboard.press('f');
  await page.waitForTimeout(80);
  const started = await getLifeEvidence();
  await page.keyboard.press('f');
  await page.waitForTimeout(80);
  const duplicateStart = await getLifeEvidence();
  assert(started.life?.workShift?.active === true
    && started.life?.cash === beforeComplete.life?.cash
    && nearlyEqual(started.life?.needs?.energy, beforeComplete.life?.needs?.energy)
    && duplicateStart.life?.workShift?.active === true
    && duplicateStart.life?.cash === beforeComplete.life?.cash
    && duplicateStart.life?.lastTransaction?.at === beforeComplete.life?.lastTransaction?.at,
  'real F did not start one no-pay shift or duplicate F mutated it', {
    beforeComplete,
    started,
    duplicateStart,
  });
  await page.waitForFunction(
    (previousAt) => {
      const life = window.__SF_SIM__.lifeSim.getState();
      return life.workShift?.status === 'cooldown'
        && life.lastTransaction?.kind === 'work-wage'
        && life.lastTransaction?.at !== previousAt;
    },
    beforeComplete.life?.lastTransaction?.at ?? null,
    { timeout: 8000, polling: 40 },
  );
  const completed = await getLifeEvidence();
  assert(completed.life?.cash === started.life?.cash + 26
    && nearlyEqual(completed.life?.needs?.energy, started.life?.needs?.energy - 16)
    && nearlyEqual(completed.life?.needs?.hunger, started.life?.needs?.hunger + 9)
    && nearlyEqual(completed.life?.needs?.fun, started.life?.needs?.fun - 4)
    && completed.life?.lastTransaction?.kind === 'work-wage'
    && completed.life?.lastTransaction?.amount === 26
    && completed.life?.lastTransaction?.cashAfter === completed.life?.cash
    && completed.saved?.snapshot?.life?.lastTransaction?.at === completed.life?.lastTransaction?.at
    && completed.message.includes('MARKET SHIFT COMPLETE'),
  'completed shift did not apply one exact wage/needs transaction and immediate save', {
    started,
    completed,
  });

  const firstWageAt = completed.life?.lastTransaction?.at;
  await page.keyboard.press('f');
  await page.waitForTimeout(80);
  const cooldownRefusal = await getLifeEvidence();
  assert(cooldownRefusal.life?.workShift?.active === false
    && cooldownRefusal.life?.workShift?.cooldownRemaining > 0
    && cooldownRefusal.life?.cash === completed.life?.cash
    && cooldownRefusal.life?.lastTransaction?.at === firstWageAt,
  'cooldown did not block an immediate duplicate payout', cooldownRefusal);

  await reloadAndLaunch();
  const restoredComplete = await getLifeEvidence();
  assert(restoredComplete.life?.cash === completed.life?.cash
    && restoredComplete.life?.lastTransaction?.kind === 'work-wage'
    && restoredComplete.life?.lastTransaction?.at === firstWageAt
    && restoredComplete.life?.workShift?.cooldownRemaining > 0,
  'reload did not preserve the single wage and cooldown', restoredComplete);

  await page.waitForFunction(
    () => window.__SF_SIM__.lifeSim.getState()?.workShift?.status === 'ready',
    null,
    { timeout: 12000, polling: 50 },
  );
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), market.position);
  await page.waitForTimeout(80);
  const beforeSecond = await getLifeEvidence();
  await page.keyboard.press('f');
  await page.waitForFunction(
    (previousAt) => {
      const life = window.__SF_SIM__.lifeSim.getState();
      return life.workShift?.status === 'cooldown'
        && life.lastTransaction?.kind === 'work-wage'
        && life.lastTransaction?.at !== previousAt;
    },
    firstWageAt,
    { timeout: 8000, polling: 40 },
  );
  const secondComplete = await getLifeEvidence();
  assert(secondComplete.life?.cash === beforeSecond.life?.cash + 26
    && secondComplete.life?.lastTransaction?.kind === 'work-wage'
    && secondComplete.life?.lastTransaction?.at !== firstWageAt,
  'later real F did not complete exactly one second lawful shift', {
    beforeSecond,
    secondComplete,
  });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'work shift slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'work shift smoke passed'
      : 'work shift smoke failed',
    baseUrl,
    angle,
    market,
    outOfRange,
    drivingF,
    interiorF,
    downedF,
    cancelled,
    activeBeforeReload,
    interruptedReload,
    completed,
    cooldownRefusal,
    restoredComplete,
    secondComplete,
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
    life: window.__SF_SIM__?.lifeSim?.getState?.(),
    combat: window.__SF_SIM__?.getCombatState?.(),
    driving: window.__SF_SIM__?.isDriving?.(),
    interaction: window.__SF_SIM__?.getInteractionState?.(),
  })).catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
