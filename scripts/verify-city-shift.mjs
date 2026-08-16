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
  await page.waitForTimeout(500);

  const completion = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.cityShift.restart();
    const before = sim.lifeSim.getState();
    const advances = sim.cityShift.steps.map((step) => {
      const result = step.kind === 'portal'
        ? sim.cityShift.onPortalEntered(step.portal)
        : sim.cityShift.onHotspotUsed({ id: step.hotspotId });
      return result ? { completed: result.completed, stepId: result.step?.id || null } : null;
    });
    const mission = sim.cityShift.getState();
    const after = sim.lifeSim.getState();
    const finalStep = sim.cityShift.steps.at(-1);
    const duplicateAdvance = sim.cityShift.onPortalEntered(finalStep.portal);
    const afterDuplicate = sim.lifeSim.getState();
    return {
      before,
      advances,
      mission,
      after,
      duplicateAdvance,
      afterDuplicate,
      hud: {
        tag: document.querySelector('.hud__mission-tag')?.textContent || '',
        restartHidden: document.querySelector('.hud__mission-restart')?.hidden ?? true,
      },
    };
  });
  await page.waitForTimeout(120);
  const completionHud = await page.evaluate(() => ({
    tag: document.querySelector('.hud__mission-tag')?.textContent || '',
    restartHidden: document.querySelector('.hud__mission-restart')?.hidden ?? true,
  }));
  assert(completion.advances.every(Boolean), 'one or more authored mission steps did not advance', completion);
  assert(completion.mission.status === 'complete'
    && completion.mission.completedSteps === completion.mission.totalSteps,
  'mission did not reach complete state', completion.mission);
  assert(completion.mission.cashReward > 0
    && completion.after.cash === completion.before.cash + completion.mission.cashReward
    && completion.after.lastTransaction?.kind === 'mission-reward'
    && completion.after.lastTransaction?.amount === completion.mission.cashReward,
  'mission completion did not produce one durable cash payout', completion);
  assert(completion.duplicateAdvance === null
    && completion.afterDuplicate.cash === completion.after.cash
    && completion.afterDuplicate.lastTransaction?.at === completion.after.lastTransaction?.at,
  'completed mission accepted a duplicate terminal step or paid twice', completion);
  assert(completionHud.tag === 'COMPLETE' && completionHud.restartHidden === false,
    'completion HUD did not expose replay state', completionHud);

  const failure = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.cityShift.restart();
    const before = sim.lifeSim.getState();
    sim.cityShift.update(500, null, null);
    const mission = sim.cityShift.getState();
    const after = sim.lifeSim.getState();
    return { before, mission, after };
  });
  await page.waitForTimeout(120);
  const failureHud = await page.evaluate(() => ({
    tag: document.querySelector('.hud__mission-tag')?.textContent || '',
    restartHidden: document.querySelector('.hud__mission-restart')?.hidden ?? true,
    restartDisabled: document.querySelector('.hud__mission-restart')?.disabled ?? true,
  }));
  assert(failure.mission.status === 'failed'
    && failure.mission.failureReason === 'time-limit'
    && failure.mission.elapsed === failure.mission.timeLimit,
  'time limit did not produce a deterministic mission failure', failure.mission);
  assert(failure.after.cash === failure.before.cash
    && failure.after.lastTransaction?.kind === 'mission-reward',
  'failed mission paid cash or corrupted the prior reward transaction', failure);
  assert(failureHud.tag === 'FAILED'
    && failureHud.restartHidden === false
    && failureHud.restartDisabled === false,
  'failure HUD did not expose replay state', failureHud);

  await page.locator('.hud__mission-restart').click();
  await page.waitForTimeout(100);
  const replay = await page.evaluate(() => window.__SF_SIM__.cityShift.getState());
  assert(replay.status === 'running' && replay.completedSteps === 0 && replay.elapsed < 1,
    'replay control did not reset the failed shift', replay);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'mission slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'city shift smoke passed'
      : 'city shift smoke failed',
    baseUrl,
    angle,
    completion: { ...completion, hud: completionHud },
    failure: { ...failure, hud: failureHud },
    replay,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'city shift smoke passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'city shift smoke failed',
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
