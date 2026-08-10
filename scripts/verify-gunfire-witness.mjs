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
  if (message.type() === 'error' && !message.text().includes('/favicon.ico')) consoleErrors.push(message.text());
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
  await page.waitForTimeout(450);
}

async function stageWitnessedShot() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const residents = sim.pedestrians.getCombatCandidates([]);
    const angles = Array.from({ length: 24 }, (_entry, index) => index * Math.PI / 12);
    const pair = residents.map((victim) => {
      const witness = sim.pedestrians.getIncidentWitness(victim.id, 18);
      const root = sim.pedestrians.group.children[victim.groupIndex];
      if (!witness?.id || !root) return null;
      const victimPosition = { x: root.position.x, y: root.position.y, z: root.position.z };
      const target = { x: victimPosition.x, y: victimPosition.y + 1.18, z: victimPosition.z };
      for (const radius of [6, 8, 10, 12]) {
        for (const angle of angles) {
          const cameraOrigin = {
            x: target.x + Math.cos(angle) * radius,
            y: victimPosition.y + 1.6,
            z: target.z + Math.sin(angle) * radius,
          };
          const dx = target.x - cameraOrigin.x;
          const dy = target.y - cameraOrigin.y;
          const dz = target.z - cameraOrigin.z;
          const distance = Math.hypot(dx, dy, dz);
          const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
          const targetEntry = distance - (Number(victim.radius) || 0.72);
          const actorInFront = residents.some((other) => {
            if (other.id === victim.id || !other.mesh?.visible) return false;
            const ox = other.mesh.position.x - cameraOrigin.x;
            const oy = other.mesh.position.y + (Number(other.height) || 1.18) - cameraOrigin.y;
            const oz = other.mesh.position.z - cameraOrigin.z;
            const centerDistance = ox * direction.x + oy * direction.y + oz * direction.z;
            if (centerDistance <= 0 || centerDistance >= distance) return false;
            const perpendicularSquared = ox * ox + oy * oy + oz * oz - centerDistance * centerDistance;
            const radiusSquared = (Number(other.radius) || 0.72) ** 2;
            if (perpendicularSquared > radiusSquared) return false;
            const entry = centerDistance - Math.sqrt(Math.max(0, radiusSquared - perpendicularSquared));
            return entry < targetEntry - 0.05;
          });
          if (actorInFront) continue;
          const blocker = sim.getCombatWorldBlocker(
            cameraOrigin,
            direction,
            Math.max(0.1, distance - 0.35),
          );
          if (!blocker) return { victim, witness, victimPosition, target, cameraOrigin };
        }
      }
      return null;
    }).find(Boolean);
    if (!pair) return null;
    const victimRoot = sim.pedestrians.group.children[pair.victim.groupIndex];
    const victimPosition = pair.victimPosition;
    const player = { x: pair.cameraOrigin.x, z: pair.cameraOrigin.z };
    sim.setRoamPose(player);
    sim.pedestrians.setQaWitnessAnchor(pair.victim.id, victimPosition);
    sim.pedestrians.update(0.001, performance.now() / 1000);
    sim.streetHeat.restart();
    sim.combat.restart();
    sim.resetPerformanceTelemetry?.();
    return {
      victim: { id: pair.victim.id, groupIndex: pair.victim.groupIndex },
      witness: {
        id: pair.witness.id,
        label: pair.witness.label,
        distance: pair.witness.distance,
        position: pair.witness.position,
      },
      victimPosition,
      target: pair.target,
      cameraOrigin: pair.cameraOrigin,
      player,
    };
  });
}

async function aimAndClick(stage) {
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.().aiming === true,
    null, { timeout: 3000, polling: 20 });
  await page.evaluate(({ cameraOrigin, target, victim, victimPosition }) => {
    const sim = window.__SF_SIM__;
    sim.pedestrians.setQaWitnessAnchor?.(victim.id, victimPosition);
    const root = sim.pedestrians.group.children[victim.groupIndex];
    root.position.set(victimPosition.x, victimPosition.y, victimPosition.z);
    root.visible = true;
    root.updateMatrixWorld(true);
    sim.camera.position.set(cameraOrigin.x, cameraOrigin.y, cameraOrigin.z);
    sim.camera.lookAt(target.x, target.y, target.z);
    sim.camera.updateMatrixWorld(true);
  }, stage);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
}

async function releaseAim() {
  await page.mouse.up({ button: 'right' });
}

async function evidence(witnessId = null) {
  return page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    return {
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      witness: id ? sim.pedestrians.getWitnessState(id) : null,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  }, witnessId);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.getStats().visible > 1,
    null, { timeout: 15000, polling: 40 });

  const stage = await stageWitnessedShot();
  assert(stage?.victim?.id && stage?.witness?.id, 'no visible victim/witness pair was available', stage);
  if (!stage?.victim?.id || !stage?.witness?.id) throw new Error('gunfire witness staging failed');
  const before = await evidence(stage.witness.id);
  await aimAndClick(stage);
  await page.waitForFunction(() => window.__SF_SIM__.getStreetHeatState().witnessReports === 1,
    null, { timeout: 5000, polling: 20 });
  const impact = await evidence(stage.witness.id);
  assert(impact.combat.hits === before.combat.hits + 1
    && impact.heat.heat === 22
    && impact.heat.witnessReports === 1
    && impact.heat.lastWitnessEvent?.victimId === stage.victim.id
    && impact.heat.lastWitnessEvent?.witnessId === stage.witness.id
    && impact.heat.lastWitnessEvent?.message.includes('gunfire')
    && impact.witness?.active === true
    && impact.witness?.reaction === 'phone-flee'
    && impact.saved.snapshot?.streetHeat?.heat <= 22
    && impact.saved.snapshot?.streetHeat?.heat >= 21.5
    && impact.saved.snapshot?.streetHeat?.witnessReports === 1
    && impact.message.includes('called in the gunfire'),
  'real RMB/LMB pedestrian hit did not produce one +22 witness dispatch', { stage, before, impact });

  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(80);
  await page.mouse.up({ button: 'left' });
  const duplicate = await evidence(stage.witness.id);
  assert(duplicate.combat.shots === impact.combat.shots
    && duplicate.heat.heat <= impact.heat.heat
    && duplicate.heat.heat >= impact.heat.heat - 1
    && duplicate.heat.witnessReports === 1
    && duplicate.witness.count === impact.witness.count,
  'held/duplicate fire input duplicated the witness incident', { impact, duplicate });
  await releaseAim();

  await page.waitForTimeout(1300);
  const moved = await evidence(stage.witness.id);
  assert(moved.witness.displacement >= 1.2
    && moved.witness.displacement <= 4.4
    && moved.witness.groundError <= 0.05,
  'witness phone-flee reaction was not bounded and grounded', moved.witness);
  const savedBeforeReload = await page.evaluate(() => {
    window.__SF_SIM__.saveProgress();
    return window.__SF_SIM__.getSavedProgress().snapshot.streetHeat;
  });

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await evidence(stage.witness.id);
  assert(restored.heat.heat <= savedBeforeReload.heat
    && restored.heat.heat >= savedBeforeReload.heat - 4
    && restored.heat.witnessReports === 1
    && restored.heat.lastWitnessEvent === null
    && restored.witness?.active === false,
  'reload did not preserve report state while clearing transient reaction', restored);

  const isolated = await stageWitnessedShot();
  assert(isolated?.victim?.id, 'no isolated victim was available', isolated);
  if (!isolated?.victim?.id) throw new Error('isolated victim staging failed');
  await page.evaluate((stage) => {
    const sim = window.__SF_SIM__;
    sim.pedestrians.setQaSolo(stage.victim.groupIndex, { forceWalk: false });
    sim.pedestrians.setQaWitnessAnchor(stage.victim.id, stage.victimPosition);
    sim.pedestrians.update(0.001, performance.now() / 1000);
  }, isolated);
  await aimAndClick(isolated);
  await page.waitForTimeout(250);
  await releaseAim();
  const noWitness = await evidence();
  assert(noWitness.combat.hits === 1
    && noWitness.heat.heat >= 12.5
    && noWitness.heat.heat <= 14
    && noWitness.heat.witnessReports === 0
    && noWitness.heat.lastWitnessEvent === null,
  'isolated pedestrian hit created a witness report', noWitness);

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.pedestrians.setQaSolo();
    sim.pedestrians.setQaWitnessAnchor();
    sim.pedestrians.update(0.001, performance.now() / 1000);
  });
  const defeatedWitnesses = await stageWitnessedShot();
  assert(defeatedWitnesses?.victim?.id,
    'no victim was available for defeated-witness refusal', defeatedWitnesses);
  if (!defeatedWitnesses?.victim?.id) throw new Error('defeated-witness staging failed');
  const defeatedCount = await page.evaluate((stage) => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.combat.restart();
    const residents = sim.pedestrians.getCombatCandidates([]);
    let defeatedCount = 0;
    for (const resident of residents) {
      if (resident.id === stage.victim.id) continue;
      const root = sim.pedestrians.group.children[resident.groupIndex];
      if (Math.hypot(
        root.position.x - stage.victimPosition.x,
        root.position.z - stage.victimPosition.z,
      ) > 18) continue;
      root.userData.combatDefeated = true;
      root.userData.combatDisabled = true;
      defeatedCount += 1;
    }
    sim.pedestrians.setQaWitnessAnchor(stage.victim.id, stage.victimPosition);
    sim.setRoamPose(stage.player);
    return defeatedCount;
  }, defeatedWitnesses);
  assert(defeatedCount > 0,
    'no nearby witnesses were available for defeated-witness refusal', {
      defeatedWitnesses,
      defeatedCount,
    });
  await aimAndClick(defeatedWitnesses);
  await page.waitForTimeout(250);
  await releaseAim();
  const defeatedRefusal = await evidence();
  assert(defeatedRefusal.combat.hits === 1
    && defeatedRefusal.heat.witnessReports === 0
    && defeatedRefusal.heat.lastWitnessEvent === null,
  'defeated witnesses produced a gunfire report', defeatedRefusal);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1200);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(performance.applicationP99FrameMs <= 16.67,
    'application p99 exceeded 16.67 ms', performance);
  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    victimId: stage.victim.id,
    witnessId: stage.witness.id,
    firstImpact: {
      heat: impact.heat.heat,
      reports: impact.heat.witnessReports,
      reaction: impact.witness,
    },
    moved: moved.witness,
    restored: { heat: restored.heat, witness: restored.witness },
    isolated: { heat: noWitness.heat, combat: noWitness.combat },
    defeatedRefusal: { heat: defeatedRefusal.heat, combat: defeatedRefusal.combat },
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
