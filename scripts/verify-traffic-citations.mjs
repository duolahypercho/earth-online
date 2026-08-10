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
  await page.waitForTimeout(250);
}

async function reloadAndLaunch() {
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      driving: sim.isDriving(),
      vehicle: sim.traffic.getPlayerVehicleState(),
      diagnostics: sim.traffic.getDiagnostics(),
      citation: sim.getLastTrafficCitation(),
      heat: sim.getStreetHeatState(),
      life: sim.lifeSim.getState(),
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function approachAndStop(steerCode = null) {
  await page.keyboard.down('w');
  await page.waitForFunction(() => {
    const signal = window.__SF_SIM__.traffic.getPlayerVehicleState()?.signalAhead;
    return signal && signal.distance > 0 && signal.distance < 24;
  }, null, { timeout: 30000, polling: 20 });
  await page.keyboard.up('w');
  if (steerCode) await page.keyboard.down(steerCode);
  await page.keyboard.down('s');
  await page.waitForFunction(() => {
    const vehicle = window.__SF_SIM__.traffic.getPlayerVehicleState();
    return vehicle?.signalAhead?.distance > 0 && vehicle.speed < 0.3;
  }, null, { timeout: 8000, polling: 20 });
  await page.keyboard.up('s');
  return evidence();
}

async function crossCurrentSignal(expectedCount, steerCode = null) {
  const approach = await page.evaluate(() => {
    const vehicle = window.__SF_SIM__.traffic.getPlayerVehicleState();
    return {
      nodeIndex: vehicle?.signalAhead?.nodeIndex ?? null,
      road: vehicle?.road ?? null,
      heading: vehicle?.heading ?? null,
    };
  });
  if (steerCode) await page.keyboard.down(steerCode);
  await page.keyboard.down('w');
  await page.waitForFunction((count) => (
    window.__SF_SIM__.traffic.getDiagnostics().playerRedLightViolations >= count
  ), expectedCount, { timeout: 12000, polling: 15 }).catch(() => null);
  if (steerCode) {
    await page.waitForFunction((baseline) => {
      const vehicle = window.__SF_SIM__.traffic.getPlayerVehicleState();
      return vehicle?.road !== baseline.road
        || Math.abs((vehicle?.heading ?? baseline.heading) - baseline.heading) > 0.08;
    }, approach, { timeout: 8000, polling: 15 }).catch(() => null);
  }
  await page.keyboard.up('w');
  if (steerCode) await page.keyboard.up(steerCode);
  return { ...approach, state: await evidence() };
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();

  await page.waitForTimeout(900);
  const passive = await evidence();
  assert(passive.driving === false
    && passive.diagnostics?.playerRedLightViolations === 0
    && passive.life?.lastTransaction == null,
  'AI traffic or on-foot play generated a player citation', passive);

  const candidate = await page.evaluate(() => window.__SF_SIM__.traffic
    .getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    )) || null);
  assert(candidate?.id >= 0, 'no parked private vehicle was available for the citation drive', candidate);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), candidate.position);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true, null, { timeout: 3000 });
  const entered = await evidence();
  assert(entered.vehicle?.index === candidate.id
    && entered.vehicle?.theft?.reported === true,
  'real E did not enter the selected private vehicle', { candidate, entered });

  const greenStop = await approachAndStop();
  await page.waitForFunction(() => {
    const signal = window.__SF_SIM__.traffic.getPlayerVehicleState()?.signalAhead;
    return signal?.phase === 'green' && signal.remaining >= 5.5;
  }, null, { timeout: 30000, polling: 25 });
  const greenNode = await page.evaluate(
    () => window.__SF_SIM__.traffic.getPlayerVehicleState()?.signalAhead?.nodeIndex,
  );
  await page.keyboard.down('w');
  await page.waitForFunction((nodeIndex) => {
    const signal = window.__SF_SIM__.traffic.getPlayerVehicleState()?.signalAhead;
    return !signal || signal.nodeIndex !== nodeIndex || signal.distance < -0.5;
  }, greenNode, { timeout: 10000, polling: 15 });
  await page.keyboard.up('w');
  const greenCrossing = await evidence();
  assert(greenStop.diagnostics?.playerRedLightViolations === 0
    && greenCrossing.diagnostics?.playerRedLightViolations === 0
    && greenCrossing.life?.lastTransaction == null,
  'real green crossing generated a citation', { greenStop, greenCrossing });

  const firstRedStop = await approachAndStop('a');
  await page.waitForFunction(() => (
    window.__SF_SIM__.traffic.getPlayerVehicleState()?.signalAhead?.phase === 'red'
      && window.__SF_SIM__.traffic.getPlayerVehicleState()?.signalAhead?.remaining >= 5.5
  ), null, { timeout: 30000, polling: 20 });
  const beforeFirst = await evidence();
  const first = await crossCurrentSignal(1, 'a');
  assert(first.state.diagnostics?.playerRedLightViolations === 1
    && first.state.citation?.nodeIndex === first.nodeIndex
    && first.state.citation?.phase === 'red'
    && Math.abs(first.state.citation?.turnSide) === 1
    && first.state.citation?.heatAdded === 12
    && first.state.citation?.heatAfter === first.state.citation?.heatBefore + 12
    && first.state.citation?.transaction?.kind === 'traffic-citation'
    && first.state.citation?.transaction?.due === 18
    && first.state.citation?.transaction?.charged === 18
    && first.state.life?.cash === beforeFirst.life.cash - 18
    && (first.state.vehicle?.road !== first.road
      || Math.abs(first.state.vehicle?.heading - first.heading) > 0.08)
    && first.state.message.includes('RED LIGHT'),
  'real W+steer red turn did not create exactly one $18/+12 citation', {
    firstRedStop,
    beforeFirst,
    first,
  });

  await page.keyboard.down('w');
  await page.waitForTimeout(650);
  await page.keyboard.up('w');
  const samePass = await evidence();
  assert(samePass.diagnostics?.playerRedLightViolations === 1
    && samePass.life?.lastTransaction?.at === first.state.life?.lastTransaction?.at,
  'holding through the same red crossing duplicated the citation', samePass);

  const secondRedStop = await approachAndStop();
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.lifeSim.addCash(-sim.lifeSim.getState().cash);
  });
  await page.waitForFunction(() => (
    window.__SF_SIM__.traffic.getPlayerVehicleState()?.signalAhead?.phase === 'red'
      && window.__SF_SIM__.traffic.getPlayerVehicleState()?.signalAhead?.remaining >= 5.5
  ), null, { timeout: 30000, polling: 20 });
  const beforeSecond = await evidence();
  const second = await crossCurrentSignal(2);
  assert(second.nodeIndex !== first.nodeIndex
    && second.state.diagnostics?.playerRedLightViolations === 2
    && second.state.citation?.nodeIndex === second.nodeIndex
    && second.state.citation?.transaction?.kind === 'traffic-citation'
    && second.state.citation?.transaction?.due === 18
    && second.state.citation?.transaction?.charged === 0
    && second.state.citation?.transaction?.unpaid === 18
    && second.state.life?.cash === 0
    && second.state.life?.legalDebt === 18
    && beforeSecond.life?.cash === 0,
  'later distinct red crossing did not record one zero-cash unpaid citation', {
    secondRedStop,
    beforeSecond,
    second,
  });

  const saved = second.state.saved?.snapshot;
  const savedTransactionAt = saved?.life?.lastTransaction?.at;
  const savedHeat = saved?.streetHeat?.heat;
  await reloadAndLaunch();
  const restored = await evidence();
  assert(restored.life?.cash === 0
    && restored.life?.legalDebt === 18
    && restored.life?.lastTransaction?.kind === 'traffic-citation'
    && restored.life?.lastTransaction?.at === savedTransactionAt
    && restored.life?.lastTransaction?.unpaid === 18
    && restored.diagnostics?.playerRedLightViolations === 0
    && restored.citation === null
    && restored.heat?.heat <= savedHeat
    && restored.heat?.heat >= savedHeat - 6,
  'reload replayed or lost the saved citation/StreetHeat state', { saved, restored });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'traffic citation slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'traffic citation smoke passed'
      : 'traffic citation smoke failed',
    baseUrl,
    angle,
    candidate: candidate ? { id: candidate.id, class: candidate.class } : null,
    passive: {
      driving: passive.driving,
      violations: passive.diagnostics?.playerRedLightViolations,
    },
    greenCrossing: {
      vehicle: greenCrossing.vehicle,
      violations: greenCrossing.diagnostics?.playerRedLightViolations,
      transaction: greenCrossing.life?.lastTransaction,
    },
    first: {
      vehicle: first.state.vehicle,
      violations: first.state.diagnostics?.playerRedLightViolations,
      citation: first.state.citation,
      heat: first.state.heat,
      cash: first.state.life?.cash,
    },
    samePass: {
      vehicle: samePass.vehicle,
      violations: samePass.diagnostics?.playerRedLightViolations,
      transaction: samePass.life?.lastTransaction,
    },
    second: {
      vehicle: second.state.vehicle,
      violations: second.state.diagnostics?.playerRedLightViolations,
      citation: second.state.citation,
      heat: second.state.heat,
      life: second.state.life,
    },
    restored: {
      vehicle: restored.vehicle,
      violations: restored.diagnostics?.playerRedLightViolations,
      citation: restored.citation,
      heat: restored.heat,
      life: restored.life,
    },
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await page.keyboard.up('w').catch(() => {});
  await page.keyboard.up('s').catch(() => {});
  await browser.close();
}
