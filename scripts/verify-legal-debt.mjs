import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  args: ['--disable-dev-shm-usage', `--use-angle=${angle}`, '--enable-gpu', '--ignore-gpu-blocklist'],
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

async function reloadAndLaunch() {
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      life: sim.lifeSim.getState(),
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      driving: sim.isDriving(),
      vehicle: sim.traffic.getPlayerVehicleState(),
      impound: sim.traffic.getImpoundedVehicleState(),
      responders: sim.traffic.getPursuitResponders(),
      citation: sim.getLastTrafficCitation(),
      interaction: sim.getInteractionState(),
      saved: sim.getSavedProgress(),
      debtHud: document.querySelector('.hud__life-debt')?.textContent || '',
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function enterFerry(ferry) {
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), ferry.position);
  await page.waitForTimeout(80);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.getInteractionState()?.mode === 'interior',
    null, { timeout: 5000, polling: 20 });
  await page.waitForTimeout(700);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.getStats().visible > 3,
    null, { timeout: 15000, polling: 40 });

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  if (angle === 'metal') {
    assert(/metal/i.test(renderer || ''), 'Metal renderer was required but not reported', { angle, renderer });
  }

  const seededCitation = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(-sim.lifeSim.getState().cash);
    return sim.lifeSim.payTrafficCitation(18, 'Red-light citation');
  });
  const afterCitation = await evidence();
  assert(seededCitation?.kind === 'traffic-citation'
    && seededCitation.due === 18
    && seededCitation.charged === 0
    && seededCitation.unpaid === 18
    && afterCitation.life.cash === 0
    && afterCitation.life.legalDebt === 18,
  'zero-cash citation did not create persistent $18 legal debt', { seededCitation, afterCitation });

  const candidate = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    )) || null);
  assert(candidate?.id >= 0, 'no private vehicle was available for booking heat', candidate);
  if (!candidate?.position) throw new Error('first private vehicle unavailable');
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true, null, { timeout: 3000 });
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === false, null, { timeout: 3000 });
  const secondVehicle = await page.evaluate((firstId) => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.id !== firstId
      && vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    )) || null, candidate.id);
  assert(secondVehicle?.id >= 0, 'second private vehicle was unavailable for booking heat', secondVehicle);
  if (!secondVehicle?.position) throw new Error('second private vehicle unavailable');
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), secondVehicle.position);
  await page.keyboard.press('e');
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim.isDriving() && sim.getStreetHeatState().pursuitActive
      && sim.traffic.getPursuitResponders().length > 0;
  }, null, { timeout: 12000, polling: 25 });
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === false,
    null, { timeout: 3000, polling: 20 });
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim.getStreetHeatState().pursuitActive
      && sim.traffic.getPursuitResponders().length > 0;
  }, null, { timeout: 12000, polling: 25 });
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders()[0];
    sim.setRoamPose({ x: responder.position.x + 3, z: responder.position.z });
  });
  await page.waitForFunction(() => {
    const heat = window.__SF_SIM__.getStreetHeatState();
    return heat.pursuitActive && Math.min(...heat.responderDistances) <= 10;
  }, null, { timeout: 5000, polling: 20 });
  const beforeBooking = await evidence();
  await page.keyboard.down('x');
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().arrests === 1,
    null, { timeout: 5000, polling: 20 });
  await page.keyboard.up('x');
  const booked = await evidence();
  const bookingDue = booked.life.lastTransaction?.due ?? 0;
  assert(booked.life.lastTransaction?.kind === 'wanted-fine'
    && booked.life.lastTransaction?.charged === 0
    && booked.life.lastTransaction?.unpaid === bookingDue
    && booked.life.legalDebt === 18 + bookingDue
    && booked.heat.heat === 0
    && booked.responders.length === 0,
  'zero-cash on-foot booking did not accumulate unpaid legal debt once', { beforeBooking, booked });

  const mixedImpound = await page.evaluate(() => window.__SF_SIM__.traffic.impoundPlayerVehicle());
  assert(mixedImpound?.mode === 'impounded',
    'mixed legal-debt/impound state was unavailable for Ferry priority coverage', mixedImpound);

  const ferry = await page.evaluate(() => {
    const portal = window.__SF_SIM__.city.portals.find((entry) => (
      String(entry.label || '').toLowerCase().includes('ferry building market hall')
    ));
    return portal ? { label: portal.label, position: portal.position } : null;
  });
  assert(ferry?.position, 'Ferry legal desk portal was unavailable', ferry);
  if (!ferry?.position) throw new Error('Ferry portal unavailable');
  const debt = booked.life.legalDebt;
  await page.evaluate((cash) => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.lifeSim.exportState();
    snapshot.cash = cash;
    sim.lifeSim.importState(snapshot);
  }, debt - 1);
  await enterFerry(ferry);
  const beforeRefusal = await evidence();
  await page.keyboard.press('r');
  await page.waitForTimeout(100);
  const refused = await evidence();
  assert(refused.life.cash === beforeRefusal.life.cash
    && refused.life.legalDebt === debt
    && refused.life.lastTransaction?.at === beforeRefusal.life.lastTransaction?.at
    && refused.impound?.mode === 'impounded'
    && refused.impound?.vehicleId === mixedImpound?.vehicleId
    && refused.message.includes(`$${debt}`),
  'underfunded Ferry settlement mutated debt or consumed the impound action first', {
    mixedImpound, beforeRefusal, refused,
  });

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__SF_SIM__.getInteractionState()?.mode !== 'interior',
    null, { timeout: 5000, polling: 20 });
  await page.waitForTimeout(700);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), ferry.position);
  await page.waitForTimeout(80);
  await page.keyboard.press('f');
  await page.waitForFunction(() => window.__SF_SIM__.lifeSim.getState().workShift?.active === true,
    null, { timeout: 3000, polling: 20 });
  await page.waitForFunction(() => window.__SF_SIM__.lifeSim.getState().workShift?.status === 'cooldown',
    null, { timeout: 9000, polling: 20 });
  const earned = await evidence();
  assert(earned.life.lastTransaction?.kind === 'work-wage'
    && earned.life.lastTransaction?.amount === 26
    && earned.life.cash === debt + 25
    && earned.life.legalDebt === debt,
  'real Market Shift did not preserve debt while earning the settlement cash', earned);

  await reloadAndLaunch();
  const restoredDebt = await evidence();
  assert(restoredDebt.life.cash === earned.life.cash
    && restoredDebt.life.legalDebt === debt
    && restoredDebt.life.lastTransaction?.at === earned.life.lastTransaction?.at,
  'reload lost accumulated legal debt or replayed the wage', { earned, restoredDebt });

  await enterFerry(ferry);
  const beforePayment = await evidence();
  await page.keyboard.press('r');
  await page.waitForTimeout(120);
  const paid = await evidence();
  assert(paid.life.legalDebt === 0
    && paid.life.cash === beforePayment.life.cash - debt
    && paid.life.lastTransaction?.kind === 'legal-debt-payment'
    && paid.life.lastTransaction?.amount === -debt
    && paid.life.lastTransaction?.debtBefore === debt
    && paid.life.lastTransaction?.debtAfter === 0
    && paid.debtHud.includes('$0')
    && paid.message.includes('LEGAL DEBT CLEARED'),
  'funded Ferry R did not settle the exact debt atomically', { beforePayment, paid });

  const paymentAt = paid.life.lastTransaction?.at;
  await page.keyboard.press('r');
  await page.waitForTimeout(100);
  const repeated = await evidence();
  assert(repeated.life.cash === paid.life.cash
    && repeated.life.legalDebt === 0
    && repeated.life.lastTransaction?.at === paymentAt,
  'repeated Ferry R duplicated legal debt payment', repeated);

  await reloadAndLaunch();
  const restoredPaid = await evidence();
  assert(restoredPaid.life.cash === paid.life.cash
    && restoredPaid.life.legalDebt === 0
    && restoredPaid.life.lastTransaction?.kind === 'legal-debt-payment'
    && restoredPaid.life.lastTransaction?.at === paymentAt,
  'reload replayed or lost the settled legal debt state', restoredPaid);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1800);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'legal-debt slice exceeded application frame budget', performance);

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    renderer,
    citation: afterCitation,
    booking: booked,
    refusal: refused,
    earned,
    paid,
    restoredPaid,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await page.keyboard.up('w').catch(() => {});
  await page.keyboard.up('s').catch(() => {});
  await page.keyboard.up('x').catch(() => {});
  await page.mouse.up({ button: 'left' }).catch(() => {});
  await page.mouse.up({ button: 'right' }).catch(() => {});
  await browser.close();
}
