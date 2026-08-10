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
      mission: sim.cityShift.getState(),
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      driving: sim.isDriving(),
      vehicle: sim.traffic.getPlayerVehicleState(),
      roam: sim.getRoamState(),
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
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

  const setup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.damagePlayer(35, 'qa-replay-integrity');
    sim.lifeSim.addCash(-sim.lifeSim.getState().cash);
    const citation = sim.lifeSim.payTrafficCitation(18, 'Replay integrity citation');
    const candidate = sim.traffic.getVehicleLifeSnapshot().vehicles.find((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.eligible === true
      && vehicle.theft?.reported === false
    )) || null;
    return { citation, candidate };
  });
  assert(setup.citation?.unpaid === 18 && setup.candidate?.position,
    'consequence fixture could not create debt and a private vehicle', setup);
  if (!setup.candidate?.position) throw new Error('private vehicle unavailable');

  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), setup.candidate.position);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true, null, { timeout: 3000 });
  await page.keyboard.down('w');
  await page.waitForTimeout(450);
  await page.keyboard.up('w');
  const staged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const vehicleDamage = sim.damagePlayerVehicle(35, 'qa-replay-integrity');
    sim.streetHeat.reportIncident(18, { source: 'combat', notify: false });
    sim.cityShift.update(500, null, null);
    sim.saveProgress();
    return {
      vehicleDamage,
      evidence: {
        life: sim.lifeSim.getState(),
        mission: sim.cityShift.getState(),
        combat: sim.getCombatState(),
        heat: sim.getStreetHeatState(),
        driving: sim.isDriving(),
        vehicle: sim.traffic.getPlayerVehicleState(),
        saved: sim.getSavedProgress(),
      },
    };
  });
  assert(staged.evidence.mission.status === 'failed'
    && staged.evidence.driving === true
    && staged.evidence.vehicle?.theft?.reported === true
    && staged.evidence.vehicle?.damage?.health < staged.evidence.vehicle?.damage?.maxHealth
    && staged.evidence.combat.health === 65
    && staged.evidence.life.cash === 0
    && staged.evidence.life.legalDebt === 18
    && staged.evidence.heat.pursuitActive === true
    && staged.evidence.heat.heat >= 30,
  'failed mission did not coexist with the consequence bundle', staged);

  const replayButton = page.locator('.hud__mission-restart');
  await replayButton.waitFor({ state: 'visible', timeout: 3000 });
  await replayButton.click();
  await page.waitForTimeout(80);
  const replayed = await evidence();
  assert(replayed.mission.status === 'running'
    && replayed.mission.completedSteps === 0
    && replayed.driving === true
    && replayed.vehicle?.index === staged.evidence.vehicle?.index
    && replayed.vehicle?.damage?.health === staged.evidence.vehicle?.damage?.health
    && replayed.vehicle?.theft?.reported === true
    && replayed.combat.health === staged.evidence.combat.health
    && replayed.combat.ammo === staged.evidence.combat.ammo
    && replayed.combat.reserveAmmo === staged.evidence.combat.reserveAmmo
    && replayed.life.cash === staged.evidence.life.cash
    && replayed.life.legalDebt === staged.evidence.life.legalDebt
    && replayed.life.lastTransaction?.at === staged.evidence.life.lastTransaction?.at
    && replayed.heat.pursuitActive === true
    && replayed.heat.heat >= staged.evidence.heat.heat - 2
    && replayed.message.includes('Waterfront Loop replayed')
    && replayed.saved.snapshot?.cityShift?.status === 'running'
    && replayed.saved.snapshot?.combat?.health === replayed.combat.health
    && replayed.saved.snapshot?.vehicle?.vehicleId === replayed.vehicle?.index
    && replayed.saved.snapshot?.vehicle?.damage?.health === replayed.vehicle?.damage?.health
    && replayed.saved.snapshot?.streetHeat?.pursuitActive === true,
  'real Replay click reset or failed to save a non-mission consequence', {
    staged: staged.evidence,
    replayed,
  });

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await evidence();
  assert(restored.mission.status === 'running'
    && restored.mission.completedSteps === 0
    && restored.driving === true
    && restored.vehicle?.index === replayed.vehicle?.index
    && restored.vehicle?.damage?.health === replayed.vehicle?.damage?.health
    && restored.vehicle?.theft?.reported === true
    && restored.combat.health >= replayed.combat.health
    && restored.combat.health < restored.combat.maxHealth
    && restored.combat.ammo === replayed.combat.ammo
    && restored.combat.reserveAmmo === replayed.combat.reserveAmmo
    && restored.life.cash === replayed.life.cash
    && restored.life.legalDebt === replayed.life.legalDebt
    && restored.life.lastTransaction?.at === replayed.life.lastTransaction?.at
    && restored.heat.pursuitActive === true
    && restored.heat.heat > 0,
  'reload did not preserve the consequence-safe Replay snapshot', { replayed, restored });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'Replay integrity slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'replay consequence integrity passed'
      : 'replay consequence integrity failed',
    baseUrl,
    angle,
    renderer,
    setup,
    staged,
    replayed,
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
