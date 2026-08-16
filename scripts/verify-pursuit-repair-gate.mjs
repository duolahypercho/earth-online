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
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(500);

  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  if (angle === 'metal') {
    assert(typeof renderer === 'string' && /metal/i.test(renderer) && !/swiftshader|software/i.test(renderer),
      'Metal renderer was not active', renderer);
  }

  const staged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const candidate = sim.traffic.getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.action?.key === 'parked'
      && vehicle.identity?.category === 'private'
      && !vehicle.damage?.disabled
    ));
    if (!candidate) return null;
    sim.setRoamPose({ x: candidate.position.x, z: candidate.position.z });
    return { id: candidate.id };
  });
  assert(staged?.id >= 0, 'could not stage a private vehicle for the repair gate', staged);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving(), null, { timeout: 5000 });

  const setup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.reportIncident(36, 'qa-pursuit-repair-gate');
    const state = sim.traffic.getPlayerVehicleState();
    sim.damagePlayerVehicle(state.damage.maxHealth + 10, 'qa-pursuit-terminal');
    sim.saveProgress();
    return {
      damage: sim.traffic.getPlayerVehicleState().damage,
      heat: sim.getStreetHeatState(),
      life: sim.lifeSim.getState(),
      diagnostics: sim.traffic.getDiagnostics(),
      quote: sim.getPlayerVehicleRepairQuote(),
    };
  });
  assert(setup.damage?.disabled === true && setup.heat?.pursuitActive === true,
    'deterministic setup did not reach disabled pursuit state', setup);
  await page.waitForTimeout(150);
  const drivePrompt = await page.locator('.hud__drive-mode').textContent();
  assert(drivePrompt?.includes('REPAIR LOCKED') && drivePrompt.includes('S SURRENDER'),
    'drive HUD still advertised roadside repair during pursuit', drivePrompt);

  const directRepair = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = sim.traffic.getPlayerVehicleState().damage;
    const result = sim.traffic.repairPlayerVehicle('qa-direct-pursuit-bypass');
    const indexedRepairExposed = typeof sim.traffic.repairVehicle === 'function';
    const after = sim.traffic.getPlayerVehicleState().damage;
    return { before, result, indexedRepairExposed, after, diagnostics: sim.traffic.getDiagnostics() };
  });
  assert(directRepair.result === null
    && directRepair.indexedRepairExposed === false
    && directRepair.after?.disabled === true
    && directRepair.after.health === directRepair.before.health
    && directRepair.diagnostics?.vehicleRepairs === setup.diagnostics?.vehicleRepairs,
  'raw traffic repair API bypassed the pursuit lock', directRepair);

  await page.keyboard.press('r');
  await page.waitForTimeout(160);
  const blocked = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      damage: sim.traffic.getPlayerVehicleState().damage,
      heat: sim.getStreetHeatState(),
      life: sim.lifeSim.getState(),
      diagnostics: sim.traffic.getDiagnostics(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
  assert(blocked.damage?.disabled === true
    && blocked.damage.health === setup.damage.health
    && blocked.damage.lastDamage?.source === setup.damage.lastDamage?.source,
  'R repaired or rewrote disabled vehicle state during pursuit', { setup, blocked });
  assert(blocked.life.cash === setup.life.cash
    && blocked.life.lastTransaction?.at === setup.life.lastTransaction?.at
    && blocked.diagnostics?.vehicleRepairs === setup.diagnostics?.vehicleRepairs,
  'blocked repair mutated cash, transaction, or repair diagnostics', { setup, blocked });
  assert(blocked.heat?.pursuitActive === true
    && blocked.heat.heat === setup.heat.heat
    && blocked.message.includes('REPAIR LOCKED'),
  'blocked repair mutated pursuit or omitted refusal feedback', { setup, blocked });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(2400);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'pursuit repair gate exceeded the application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'pursuit repair gate passed'
      : 'pursuit repair gate failed',
    baseUrl,
    angle,
    renderer,
    setup,
    drivePrompt,
    directRepair,
    blocked,
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
