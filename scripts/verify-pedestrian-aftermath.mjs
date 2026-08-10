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
  await page.waitForTimeout(400);
}

async function stageResident() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.streetHeat.restart();
    sim.combat.restart();
    const victim = sim.pedestrians.getCombatCandidates([])[0];
    if (!victim) return null;
    const root = sim.pedestrians.group.children[victim.groupIndex];
    const victimPosition = { x: root.position.x, y: root.position.y, z: root.position.z };
    const person = sim.pedestrians.getNearestPerson(victimPosition, 0.5);
    const player = { x: victimPosition.x, z: victimPosition.z - 8 };
    sim.setRoamPose(player);
    sim.pedestrians.setQaWitnessAnchor(victim.id, victimPosition);
    sim.pedestrians.update(0.001, performance.now() / 1000);
    return {
      id: victim.id,
      role: person?.role ?? null,
      groupIndex: victim.groupIndex,
      victimPosition,
      player,
    };
  });
}

async function aimAt(stage) {
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.evaluate(({ player, victimPosition }) => {
    const sim = window.__SF_SIM__;
    sim.camera.position.set(player.x, victimPosition.y + 1.6, player.z);
    sim.camera.lookAt(victimPosition.x, victimPosition.y + 1.18, victimPosition.z);
    sim.camera.updateMatrixWorld(true);
  }, stage);
}

async function clickShot() {
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(260);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.getStats().visible > 1,
    null, { timeout: 15000, polling: 40 });

  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  if (angle === 'metal') {
    assert(Boolean(renderer)
      && /metal/i.test(renderer)
      && !/(swiftshader|software)/i.test(renderer),
    'Metal hardware renderer was required but not reported', { angle, renderer });
  }

  const stage = await stageResident();
  assert(stage?.id && stage?.role, 'no stable visible resident was available', stage);
  if (!stage?.id || !stage?.role) throw new Error('resident aftermath staging failed');
  const before = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      combat: sim.getCombatState(),
      heat: sim.getStreetHeatState(),
      life: sim.lifeSim.getState(),
    };
  });
  await aimAt(stage);
  await clickShot();
  await aimAt(stage);
  await clickShot();
  await page.mouse.up({ button: 'right' });
  const postShots = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const ledger = sim.pedestrians.exportCombatAftermathState();
    const record = ledger.residents[0] ?? null;
    const groupIndex = sim.pedestrians.group.children.findIndex((root) => (
      root.userData.combatDefeated === true || root.userData.combatDisabled === true
    ));
    const root = groupIndex >= 0 ? sim.pedestrians.group.children[groupIndex] : null;
    return {
      combat: sim.getCombatState(),
      target: record ? sim.getCombatTargetState(record.residentId) : null,
      ledger,
      savedLedger: sim.getSavedProgress().snapshot?.pedestrianAftermath ?? null,
      actual: record && root ? {
        id: record.residentId,
        role: record.role,
        groupIndex,
        victimPosition: { x: root.position.x, y: root.position.y, z: root.position.z },
      } : null,
    };
  });
  if (!postShots.actual) {
    throw new Error(`resident defeat did not register: ${JSON.stringify(postShots)}`);
  }
  const actual = postShots.actual;

  const defeated = await page.evaluate(({ id, role, groupIndex, victimPosition }) => {
    const sim = window.__SF_SIM__;
    const root = sim.pedestrians.group.children[groupIndex];
    const life = sim.lifeSim.getState();
    return {
      ledger: sim.pedestrians.exportCombatAftermathState(),
      saved: sim.getSavedProgress().snapshot,
      target: sim.getCombatTargetState(id),
      rootFlags: {
        defeated: root.userData.combatDefeated === true,
        disabled: root.userData.combatDisabled === true,
      },
      combatCandidate: sim.pedestrians.getCombatCandidates([])
        .some((entry) => entry.id === id),
      nearbyDefaultId: sim.pedestrians.getNearestPerson(victimPosition, 0.5)?.id ?? null,
      nearbyIncludingDefeatedId: sim.pedestrians.getNearestPerson(
        victimPosition,
        0.5,
        { includeDefeated: true },
      )?.id ?? null,
      expected: { id, role },
      heat: sim.getStreetHeatState(),
      life,
    };
  }, actual);
  assert(defeated.ledger.residents.length === 1
    && defeated.ledger.residents[0].residentId === actual.id
    && defeated.ledger.residents[0].role === actual.role
    && defeated.saved.pedestrianAftermath.residents[0].residentId === actual.id
    && defeated.target?.defeated === true
    && defeated.rootFlags.defeated
    && defeated.rootFlags.disabled
    && defeated.combatCandidate === false
    && defeated.nearbyDefaultId !== actual.id
    && defeated.nearbyIncludingDefeatedId === actual.id,
  'real two-shot defeat did not create one stable excluded resident record', defeated);

  const savedHeat = defeated.saved.streetHeat;
  const savedLife = defeated.saved.life;
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await page.evaluate(({ id, groupIndex, victimPosition }) => {
    const sim = window.__SF_SIM__;
    const root = sim.pedestrians.group.children[groupIndex];
    const life = sim.lifeSim.getState();
    return {
      ledger: sim.pedestrians.exportCombatAftermathState(),
      rootFlags: {
        defeated: root.userData.combatDefeated === true,
        disabled: root.userData.combatDisabled === true,
      },
      combatCandidate: sim.pedestrians.getCombatCandidates([])
        .some((entry) => entry.id === id),
      nearbyDefaultId: sim.pedestrians.getNearestPerson(victimPosition, 0.5)?.id ?? null,
      heat: sim.getStreetHeatState(),
      life,
    };
  }, actual);
  assert(restored.ledger.residents.length === 1
    && restored.ledger.residents[0].residentId === actual.id
    && restored.rootFlags.defeated
    && restored.rootFlags.disabled
    && restored.combatCandidate === false
    && restored.nearbyDefaultId !== actual.id
    && restored.heat.witnessReports === savedHeat.witnessReports
    && restored.heat.heat <= savedHeat.heat
    && restored.heat.heat >= savedHeat.heat - 2
    && restored.life.cash === savedLife.cash
    && JSON.stringify(restored.life.lastTransaction) === JSON.stringify(savedLife.lastTransaction),
  'reload did not preserve eligibility aftermath without replaying other consequences', restored);

  const malformed = await page.evaluate(({ id, role }) => {
    const sim = window.__SF_SIM__;
    const beforeLedger = sim.pedestrians.exportCombatAftermathState();
    const beforeLife = sim.lifeSim.exportState();
    const variants = [
      { version: 1, residents: [{ residentId: id, role }, { residentId: id, role }] },
      { version: 1, residents: [{ residentId: 'resident-unknown', role }] },
      { version: 1, residents: [{ residentId: id, role: `${role}-mismatch` }] },
    ];
    const directResults = variants.map((snapshot) => sim.pedestrians
      .importCombatAftermathState(snapshot));
    const afterDirect = sim.pedestrians.exportCombatAftermathState();
    const saved = structuredClone(sim.getSavedProgress().snapshot);
    saved.pedestrianAftermath = variants[1];
    window.localStorage.setItem('earth-online-player-progress-v1', JSON.stringify(saved));
    const restoredInvalid = sim.restoreProgress();
    return {
      directResults,
      restoredInvalid,
      beforeLedger,
      afterDirect,
      afterRestore: sim.pedestrians.exportCombatAftermathState(),
      lifeUnchanged: JSON.stringify(beforeLife) === JSON.stringify(sim.lifeSim.exportState()),
    };
  }, actual);
  assert(malformed.directResults.every((value) => value === false)
    && malformed.restoredInvalid === false
    && JSON.stringify(malformed.afterDirect) === JSON.stringify(malformed.beforeLedger)
    && JSON.stringify(malformed.afterRestore) === JSON.stringify(malformed.beforeLedger)
    && malformed.lifeUnchanged,
  'malformed pedestrian ledgers did not reject atomically', malformed);

  const compatibility = await page.evaluate((stageData) => {
    const sim = window.__SF_SIM__;
    const legacy = structuredClone(sim.getSavedProgress().snapshot);
    delete legacy.pedestrianAftermath;
    window.localStorage.setItem('earth-online-player-progress-v1', JSON.stringify(legacy));
    const legacyAccepted = sim.restoreProgress();
    const afterLegacy = sim.pedestrians.exportCombatAftermathState();
    sim.pedestrians.importCombatAftermathState({
      version: 1,
      residents: [{
        residentId: stageData.id,
        role: stageData.role,
      }],
    });
    sim.restartCombat();
    return {
      legacyAccepted,
      afterLegacy,
      afterRestart: sim.pedestrians.exportCombatAftermathState(),
      savedAfterRestart: sim.getSavedProgress().snapshot?.pedestrianAftermath,
    };
  }, actual);
  assert(compatibility.legacyAccepted === true
    && compatibility.afterLegacy.residents.length === 0
    && compatibility.afterRestart.residents.length === 0
    && compatibility.savedAfterRestart.residents.length === 0,
  'legacy restore or combat restart did not clear the durable ledger safely', compatibility);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(1200);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(performance.applicationP99FrameMs <= 16.67,
    'application p99 exceeded 16.67 ms', performance);

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0,
    angle,
    renderer,
    stage,
    actual,
    before: { combat: before.combat, heat: before.heat },
    defeated,
    restored,
    malformed,
    compatibility,
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
