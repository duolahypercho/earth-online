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
page.on('requestfailed', (request) => {
  if (!request.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  }
});

async function launch() {
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(450);
}

async function stagePublicTarget() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const residents = sim.pedestrians.getCombatCandidates([]);
    const pair = residents.map((victim) => ({
      victim,
      witness: sim.pedestrians.getIncidentWitness(victim.id, 18),
    })).find((entry) => entry.witness?.id);
    if (!pair) return null;
    const root = sim.pedestrians.group.children[pair.victim.groupIndex];
    const victimPosition = { x: root.position.x, y: root.position.y, z: root.position.z };
    const dx = pair.witness.position.x - victimPosition.x;
    const dz = pair.witness.position.z - victimPosition.z;
    const length = Math.hypot(dx, dz) || 1;
    const player = {
      x: victimPosition.x - (dx / length) * 8,
      z: victimPosition.z - (dz / length) * 8,
    };
    sim.setRoamPose(player);
    sim.pedestrians.setQaWitnessAnchor(pair.victim.id, victimPosition);
    sim.pedestrians.update(0.001, performance.now() / 1000);
    return { victimPosition, player, victimId: pair.victim.id, witnessId: pair.witness.id };
  });
}

async function fireAt(stage) {
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.evaluate(({ player, victimPosition }) => {
    const sim = window.__SF_SIM__;
    sim.camera.position.set(player.x, victimPosition.y + 1.6, player.z);
    sim.camera.lookAt(victimPosition.x, victimPosition.y + 1.18, victimPosition.z);
    sim.camera.updateMatrixWorld(true);
  }, stage);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(280);
}

async function evidence() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      heat: sim.getStreetHeatState(),
      combat: sim.getCombatState(),
      responders: sim.traffic.getPursuitResponders(),
      interaction: sim.getInteractionState(),
      roam: sim.getRoamState(),
      interior: sim.city.getInteriorState(),
      cash: sim.lifeSim.getState().cash,
      transaction: sim.lifeSim.getState().lastTransaction,
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
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

  await page.evaluate(() => {
    window.__SF_SIM__.streetHeat.restart();
    window.__SF_SIM__.combat.restart();
    window.__SF_SIM__.resetPerformanceTelemetry?.();
  });
  const stage = await stagePublicTarget();
  assert(stage?.victimId && stage?.witnessId, 'public gunfire target was unavailable', stage);
  if (!stage?.victimId) throw new Error('public gunfire staging failed');
  await fireAt(stage);
  await fireAt(stage);
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim.getCombatState().hits >= 2
      && sim.getStreetHeatState().pursuitActive
      && sim.traffic.getPursuitResponders().length > 0;
  }, null, { timeout: 12000, polling: 25 });
  const pursuit = await evidence();
  assert(pursuit.heat.heat >= 30
    && pursuit.heat.pursuitActive === true
    && pursuit.responders.length >= 1,
  'real gunfire did not produce a live pursuit', { stage, pursuit });

  const portalStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((entry) => /welcome center/i.test(entry.label));
    const approach = portal?.approachRoute?.[portal.approachRoute.length - 1] || portal?.position;
    if (!portal || !approach) return null;
    sim.setRoamPose(approach);
    return { id: portal.id, label: portal.label, approach };
  });
  assert(portalStage?.id, 'Welcome Center portal staging was unavailable', portalStage);
  await page.waitForFunction((portalId) => {
    const interaction = window.__SF_SIM__.getInteractionState();
    return interaction.portal?.id === portalId && interaction.portal.enabled;
  }, portalStage.id, { timeout: 5000, polling: 25 });
  const beforeRefusal = await evidence();
  await page.keyboard.press('e');
  await page.waitForTimeout(500);
  const refused = await evidence();
  const refusalDisplacement = Math.hypot(
    refused.roam.target.x - beforeRefusal.roam.target.x,
    refused.roam.target.z - beforeRefusal.roam.target.z,
  );
  assert(refused.interaction.mode === 'roam'
    && refused.interior.active === false
    && refusalDisplacement <= 0.05
    && refused.heat.pursuitActive === true
    && refused.responders.length >= 1
    && /INTERIOR LOCKED/.test(refused.message),
  'real E entered or displaced the player through a pursuit-locked portal', {
    portalStage,
    beforeRefusal,
    refused,
    refusalDisplacement,
  });
  assert(refused.cash === beforeRefusal.cash
    && refused.transaction?.at === beforeRefusal.transaction?.at,
  'pursuit portal refusal mutated the economy', { beforeRefusal, refused });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders()[0];
    sim.setRoamPose({ x: responder.position.x + 3, z: responder.position.z });
  });
  await page.waitForFunction(() => {
    const heat = window.__SF_SIM__.getStreetHeatState();
    return heat.pursuitActive && Math.min(...heat.responderDistances) <= 10;
  }, null, { timeout: 5000, polling: 25 });
  await page.keyboard.down('x');
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().arrests === 1,
    null, { timeout: 5000, polling: 25 });
  await page.keyboard.up('x');
  const cleared = await evidence();
  assert(cleared.heat.pursuitActive === false
    && cleared.responders.length === 0,
  'normal on-foot surrender did not clear the portal pursuit', cleared);

  await page.evaluate((approach) => window.__SF_SIM__.setRoamPose(approach), portalStage.approach);
  await page.waitForFunction((portalId) => {
    const interaction = window.__SF_SIM__.getInteractionState();
    return interaction.portal?.id === portalId && interaction.portal.enabled;
  }, portalStage.id, { timeout: 5000, polling: 25 });
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.getInteractionState().mode === 'interior',
    null, { timeout: 5000, polling: 25 });
  const entered = await evidence();
  assert(entered.interior.active === true
    && entered.interaction.mode === 'interior'
    && entered.interior.portalId === portalStage.id,
  'the same real E portal entry remained blocked after pursuit cleared', { portalStage, entered });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__SF_SIM__.getInteractionState().mode === 'roam',
    null, { timeout: 5000, polling: 25 });

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1600);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(Number.isFinite(performance.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'pursuit interior gate exceeded the application frame budget', performance);

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    renderer,
    stage,
    pursuit,
    portalStage,
    beforeRefusal,
    refused,
    refusalDisplacement,
    cleared,
    entered,
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
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
