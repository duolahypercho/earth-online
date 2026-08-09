import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
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
const consoleErrors = [];
const httpErrors = [];
const failures = [];
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

let responderId = null;
let perfStartedAt = 0;
let perfFrameStart = null;

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled,
    { timeout: 30000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 15000 },
  );
  await page.waitForTimeout(1200);

  const initial = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      driving: sim.isDriving?.() === true,
      simReady: Boolean(sim.traffic && sim.combat && sim.streetHeat),
    };
  });
  assert(initial.simReady, 'public simulation API did not initialize', initial);
  assert(initial.driving === false, 'smoke must start on foot', initial);
  assert(initial.heat?.heat === 0, 'street heat did not start at zero', initial.heat);
  assert(initial.heat?.pursuitActive === false, 'street heat started in pursuit', initial.heat);

  // Stage a parked, visible traffic actor at a stable eight-metre shot. The
  // camera pose is only a QA staging aid; the shot still goes through the
  // public combat raycast, reaction, and StreetHeat ingress APIs.
  const setup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.getVehicleLifeSnapshot();
    const candidate = snapshot.vehicles.find((vehicle) => (
      vehicle.visible
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
    )) || snapshot.vehicles.find((vehicle) => vehicle.visible && vehicle.class !== 'bike');
    if (!candidate) throw new Error('no visible light traffic target for combat smoke');
    const root = sim.traffic.group.children[candidate.id];
    if (!root?.position) throw new Error(`traffic root ${candidate.id} unavailable`);
    const player = {
      x: root.position.x - Math.sin(root.rotation.y) * 8,
      z: root.position.z - Math.cos(root.rotation.y) * 8,
    };
    const target = {
      x: root.position.x,
      y: root.position.y + 0.82,
      z: root.position.z,
    };
    sim.setRoamPose(player);
    sim.setCombatAim(true);
    sim.resetPerformanceTelemetry?.();
    return {
      id: candidate.id,
      class: candidate.class,
      label: candidate.identity?.label || candidate.class,
      player,
      target,
    };
  });
  perfStartedAt = Date.now();
  perfFrameStart = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot()?.frameCount ?? null);

  const shotResults = [];
  for (let index = 0; index < 4; index += 1) {
    if (index > 0) await page.waitForTimeout(240);
    const shot = await page.evaluate((pose) => {
      const sim = window.__SF_SIM__;
      const root = sim.traffic.group.children[pose.id];
      const target = {
        x: root.position.x,
        y: root.position.y + 0.82,
        z: root.position.z,
      };
      sim.camera.position.set(pose.player.x, root.position.y + 1.6, pose.player.z);
      sim.camera.lookAt(target.x, target.y, target.z);
      sim.camera.updateMatrixWorld(true);
      const fire = sim.fireCombat();
      return {
        fire,
        combat: sim.getCombatState(),
        heat: sim.getStreetHeatState(),
      };
    }, setup);
    shotResults.push(shot);
  }

  const afterShots = shotResults.at(-1);
  assert(shotResults.some((shot) => shot.fire?.fired === true), 'no shot fired', shotResults);
  assert(shotResults.some((shot) => shot.fire?.hit === true), 'no combat hit registered', shotResults);
  assert(afterShots.combat?.shots > 0, 'combat state reports zero shots', afterShots.combat);
  assert(afterShots.combat?.hits > 0, 'combat state reports zero hits', afterShots.combat);
  assert(afterShots.heat?.heat > initial.heat.heat, 'combat shots did not increase numeric StreetHeat', {
    before: initial.heat,
    after: afterShots.heat,
  });
  assert(afterShots.heat?.pursuitActive === true, 'real hits did not escalate StreetHeat into pursuit', afterShots.heat);
  assert(shotResults[0].heat?.pursuitActive === false, 'StreetHeat was already active before shot sequence', shotResults[0].heat);

  await page.waitForFunction(
    () => {
      const sim = window.__SF_SIM__;
      const heat = sim.getStreetHeatState?.();
      const responder = sim.traffic.getPursuitResponder?.();
      return heat?.pursuitActive === true
        && responder?.active === true
        && Number.isFinite(responder.distance)
        && Number.isInteger(responder.id);
    },
    { timeout: 5000, polling: 100 },
  );
  const pursuit = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const heat = sim.getStreetHeatState();
    const responder = sim.traffic.getPursuitResponder();
    const life = sim.traffic.getVehicleLifeSnapshot().vehicles.find(
      (vehicle) => vehicle.id === responder.id,
    );
    const interaction = document.querySelector('.hud__interaction');
    return {
      heat,
      responder,
      life,
      interaction: {
        hidden: interaction?.hidden ?? null,
        availability: interaction?.dataset.availability || null,
        text: interaction && !interaction.hidden ? interaction.textContent.trim() : null,
      },
    };
  });
  responderId = pursuit.responder.id;
  assert(pursuit.heat?.pursuitActive === true, 'pursuit state dropped before responder sample', pursuit.heat);
  assert(Number.isFinite(pursuit.heat?.responderDistance), 'StreetHeat responder distance is not finite', pursuit.heat);
  assert(Number.isInteger(pursuit.responder?.id), 'responder id is not an integer', pursuit.responder);
  assert(pursuit.responder?.active === true, 'traffic responder is not active', pursuit.responder);
  assert(pursuit.responder?.position
    && [pursuit.responder.position.x, pursuit.responder.position.y, pursuit.responder.position.z]
      .every(Number.isFinite), 'responder position is not finite', pursuit.responder);
  assert(pursuit.life?.visible === true, 'responder life record is not visible', pursuit.life);
  assert(pursuit.life?.action?.key === 'pursuit-responder', 'responder action is not exposed', pursuit.life);
  assert(pursuit.life?.indicators?.hazard === true, 'responder hazard indicator is not active', pursuit.life);

  // Break contact by moving the on-foot player far outside the responder's
  // nearby radius. Real RAF frames then drive StreetHeat's normal hold/cool/
  // escape window; no test-only heat mutation or traffic teleport is used.
  await page.evaluate((pose) => {
    const sim = window.__SF_SIM__;
    sim.setCombatAim(false);
    // Stay inside the core street pocket so the real escape window is tested
    // without turning this smoke into a distant-sector streaming soak.
    sim.setRoamPose({ x: pose.player.x + 40, z: pose.player.z + 40 });
  }, setup);
  await page.waitForFunction(
    () => {
      const sim = window.__SF_SIM__;
      const heat = sim.getStreetHeatState?.();
      const responder = sim.traffic.getPursuitResponder?.();
      return heat?.pursuitActive === false
        && responder?.active === false
        && responder?.id === null
        && responder?.distance === null;
    },
    { timeout: 10000, polling: 100 },
  );
  await page.waitForTimeout(500);
  const escaped = await page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const heat = sim.getStreetHeatState();
    const responder = sim.traffic.getPursuitResponder();
    const life = sim.traffic.getVehicleLifeSnapshot().vehicles.find((vehicle) => vehicle.id === id);
    const interaction = document.querySelector('.hud__interaction');
    return {
      heat,
      responder,
      life,
      interaction: {
        hidden: interaction?.hidden ?? null,
        availability: interaction?.dataset.availability || null,
        text: interaction && !interaction.hidden ? interaction.textContent.trim() : null,
      },
    };
  }, responderId);
  assert(escaped.heat?.pursuitActive === false, 'escape did not clear pursuitActive', escaped.heat);
  assert(escaped.heat?.lastEvent?.kind === 'escaped', 'escape event was not emitted', escaped.heat);
  assert(escaped.responder?.active === false && escaped.responder.id === null,
    'responder did not clear after escape', escaped.responder);
  assert(escaped.life?.pursuit === null, 'ordinary traffic still exposes pursuit metadata', escaped.life);
  assert(escaped.life?.action?.key !== 'pursuit-responder', 'ordinary traffic action remained responder', escaped.life);

  const minimumDiagnosticMs = 30000;
  const remainingMs = Math.max(0, minimumDiagnosticMs - (Date.now() - perfStartedAt));
  if (remainingMs > 0) await page.waitForTimeout(remainingMs);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  const perfFrameEnd = performance?.frameCount ?? null;
  assert(Number.isFinite(performance?.averageFrameMs), '30s FPS diagnostic has no average frame time', performance);
  assert(Number.isFinite(performance?.applicationP99FrameMs), '30s FPS diagnostic has no application p99', performance);
  assert(perfFrameStart === null || perfFrameEnd === null || perfFrameEnd > perfFrameStart,
    'performance frame counter did not advance', { perfFrameStart, perfFrameEnd });

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'combat pursuit smoke passed'
      : 'combat pursuit smoke failed',
    baseUrl,
    angle,
    target: setup,
    shots: {
      count: afterShots.combat?.shots ?? null,
      hits: afterShots.combat?.hits ?? null,
      results: shotResults.map((shot) => shot.fire),
    },
    pursuit,
    escaped,
    performance: {
      wallClockMs: Date.now() - perfStartedAt,
      frameCountDelta: perfFrameStart === null || perfFrameEnd === null
        ? null
        : perfFrameEnd - perfFrameStart,
      snapshot: performance,
    },
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'combat pursuit smoke passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'combat pursuit smoke failed',
    error: error.message,
    consoleErrors,
    httpErrors,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
