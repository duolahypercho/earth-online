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
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(350);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await launch();

  const market = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((candidate) => {
      const label = String(candidate.label || '').toLowerCase();
      return label.includes('ferry') || label.includes('market') || label.includes('cafe');
    });
    if (!portal?.position) return null;
    sim.setRoamPose({ x: portal.position.x, z: portal.position.z });
    return { x: portal.position.x, y: portal.position.y, z: portal.position.z };
  });
  assert(Boolean(market), 'market portal unavailable for persistence setup', market);
  await page.keyboard.press('b');
  await page.keyboard.press('b');
  const combatSetup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.damagePlayer(35, 'qa-persistence');
    sim.setCombatAim(true);
    return {
      fired: sim.fireCombat(),
      combat: sim.getCombatState(),
    };
  });
  assert(combatSetup.fired?.fired === true
    && combatSetup.combat.health === 65
    && combatSetup.combat.ammo === 11,
  'persistence setup did not mutate real combat health and ammunition', combatSetup);
  const progressed = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const first = sim.cityShift.steps[0];
    const second = sim.cityShift.steps[1];
    const advance1 = sim.cityShift.onPortalEntered(first.portal);
    const advance2 = sim.cityShift.onHotspotUsed({ id: second.hotspotId });
    return { advance1: Boolean(advance1), advance2: Boolean(advance2) };
  });
  await page.evaluate(() => window.__SF_SIM__.setCombatAim(false));
  await page.waitForTimeout(80);
  const worldSetup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const target = sim.getRoamState().target;
    sim.setRoamPose({
      x: target.x,
      z: target.z,
      yaw: 1.234,
      pitch: 1.24,
      distance: 12,
    });
    return {
      roam: sim.getRoamState(),
      camera: sim.getCombatState().camera,
    };
  });
  await page.mouse.move(640, 360);
  await page.keyboard.down('q');
  await page.mouse.move(640, 650, { steps: 4 });
  await page.waitForTimeout(1300);
  const aimedAutosave = await page.evaluate(() => ({
    combat: window.__SF_SIM__.getCombatState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  await page.keyboard.up('q');
  await page.waitForTimeout(80);
  const heatSetup = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const heat = sim.streetHeat.reportIncident(36, { source: 'combat', notify: false });
    const saved = sim.saveProgress();
    return { heat, saved };
  });
  assert(heatSetup.saved === true
    && heatSetup.heat.pursuitActive === true
    && heatSetup.heat.heat === 36,
  'persistence setup did not save a valid StreetHeat pursuit', heatSetup);
  const beforeReload = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    roam: window.__SF_SIM__.getRoamState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(progressed.advance1 && progressed.advance2
    && beforeReload.life.cash === 84
    && beforeReload.life.inventory.medkit.count === 2
    && beforeReload.mission.completedSteps === 2
    && beforeReload.combat.health === 65
    && beforeReload.combat.ammo === 11
    && beforeReload.save.snapshot?.combat?.health === 65
    && beforeReload.save.snapshot?.combat?.ammo === 11
    && beforeReload.heat.pursuitActive === true
    && beforeReload.save.snapshot?.streetHeat?.pursuitActive === true
    && beforeReload.save.snapshot?.streetHeat?.heat > 0
    && Math.abs(beforeReload.save.snapshot?.world?.x - worldSetup.roam.target.x) < 0.01
    && Math.abs(beforeReload.save.snapshot?.world?.z - worldSetup.roam.target.z) < 0.01
    && Math.abs(beforeReload.save.snapshot?.world?.yaw - 1.234) < 0.001
    && Math.abs(beforeReload.save.snapshot?.world?.pitch - 1.24) < 0.001
    && Math.abs(beforeReload.save.snapshot?.world?.distance - 11) < 0.001
    && aimedAutosave.combat.camera.mode === 'shoulder-aim'
    && Math.abs(aimedAutosave.combat.camera.pitch - 1.24) > 0.04
    && Math.abs(aimedAutosave.save.snapshot?.world?.pitch - 1.24) < 0.001
    && Math.abs(aimedAutosave.save.snapshot?.world?.distance - 11) < 0.001,
  'autosave setup did not capture economy, combat kit, mission, and outdoor world progress', {
    progressed,
    heatSetup,
    worldSetup,
    aimedAutosave,
    beforeReload,
  });

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restored = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    roam: window.__SF_SIM__.getRoamState(),
    save: window.__SF_SIM__.getSavedProgress(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
    inventoryHud: document.querySelector('.hud__life-inventory')?.textContent || '',
  }));
  assert(restored.life.cash === beforeReload.life.cash
    && restored.life.inventory.medkit.count === beforeReload.life.inventory.medkit.count
    && restored.life.lastTransaction?.kind === 'inventory-purchase'
    && restored.mission.status === 'running'
    && restored.mission.completedSteps === 2
    && restored.mission.cashReward === 0
    && restored.combat.health >= beforeReload.combat.health
    && restored.combat.health < restored.combat.maxHealth
    && restored.combat.recovering === false
    && restored.combat.ammo === beforeReload.combat.ammo
    && restored.combat.reserveAmmo === beforeReload.combat.reserveAmmo
    && restored.heat.pursuitActive === true
    && restored.heat.heat > 0
    && Math.abs(restored.roam.target.x - beforeReload.save.snapshot.world.x) < 0.05
    && Math.abs(restored.roam.target.z - beforeReload.save.snapshot.world.z) < 0.05
    && Math.abs(restored.combat.camera.yaw - beforeReload.save.snapshot.world.yaw) < 0.001
    && Math.abs(restored.combat.camera.pitch - beforeReload.save.snapshot.world.pitch) < 0.001
    && Math.abs(restored.combat.camera.distance - beforeReload.save.snapshot.world.distance) < 0.001
    && restored.message.includes('Progress restored')
    && restored.inventoryHud.includes('MEDKIT / 2 OF 3'),
  'reload did not restore the validated player progress snapshot', { beforeReload, restored });

  const completed = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const advances = sim.cityShift.steps.slice(sim.cityShift.getState().completedSteps).map((step) => (
      step.kind === 'portal'
        ? sim.cityShift.onPortalEntered(step.portal)
        : sim.cityShift.onHotspotUsed({ id: step.hotspotId })
    ));
    return {
      advances: advances.map(Boolean),
      life: sim.lifeSim.getState(),
      mission: sim.cityShift.getState(),
    };
  });
  assert(completed.advances.every(Boolean)
    && completed.mission.status === 'complete'
    && completed.mission.cashReward > 0
    && completed.life.cash === restored.life.cash + completed.mission.cashReward
    && completed.life.lastTransaction?.kind === 'mission-reward',
  'resumed mission did not complete with one payout before persistence', completed);
  await page.waitForTimeout(1100);
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restoredComplete = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
  }));
  assert(restoredComplete.mission.status === 'complete'
    && restoredComplete.life.cash === completed.life.cash
    && restoredComplete.life.lastTransaction?.kind === 'mission-reward'
    && restoredComplete.life.lastTransaction?.at === completed.life.lastTransaction?.at,
  'restoring a completed mission duplicated or lost its payout', { completed, restoredComplete });

  const beforeReplay = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    roam: window.__SF_SIM__.getRoamState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  await page.locator('.hud__mission-restart').click();
  await page.waitForTimeout(80);
  const replayed = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    roam: window.__SF_SIM__.getRoamState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(replayed.mission.status === 'running'
    && replayed.mission.completedSteps === 0
    && replayed.life.cash === beforeReplay.life.cash
    && replayed.life.legalDebt === beforeReplay.life.legalDebt
    && replayed.life.inventory.medkit.count === beforeReplay.life.inventory.medkit.count
    && replayed.life.lastTransaction?.kind === beforeReplay.life.lastTransaction?.kind
    && replayed.life.lastTransaction?.at === beforeReplay.life.lastTransaction?.at
    && replayed.combat.health === beforeReplay.combat.health
    && replayed.combat.ammo === beforeReplay.combat.ammo
    && replayed.combat.reserveAmmo === beforeReplay.combat.reserveAmmo
    && replayed.heat.pursuitActive === beforeReplay.heat.pursuitActive
    && replayed.heat.heat > 0
    && replayed.heat.heat <= beforeReplay.heat.heat
    && replayed.heat.heat >= beforeReplay.heat.heat - 2
    && Math.hypot(
      replayed.roam.target.x - beforeReplay.roam.target.x,
      replayed.roam.target.z - beforeReplay.roam.target.z,
    ) < 0.05
    && replayed.save.snapshot?.combat?.health === replayed.combat.health
    && replayed.save.snapshot?.combat?.ammo === replayed.combat.ammo
    && replayed.save.snapshot?.streetHeat?.pursuitActive === replayed.heat.pursuitActive
    && replayed.save.snapshot?.streetHeat?.heat > 0,
  'Replay changed consequences outside the City Shift or failed to save immediately', {
    beforeReplay,
    replayed,
  });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restoredReplay = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    heat: window.__SF_SIM__.getStreetHeatState(),
    roam: window.__SF_SIM__.getRoamState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(restoredReplay.mission.status === 'running'
    && restoredReplay.mission.completedSteps === 0
    && restoredReplay.life.cash === replayed.life.cash
    && restoredReplay.life.legalDebt === replayed.life.legalDebt
    && restoredReplay.life.inventory.medkit.count === replayed.life.inventory.medkit.count
    && restoredReplay.life.lastTransaction?.at === replayed.life.lastTransaction?.at
    && restoredReplay.combat.health >= replayed.combat.health
    && restoredReplay.combat.health < restoredReplay.combat.maxHealth
    && restoredReplay.combat.ammo === replayed.combat.ammo
    && restoredReplay.combat.reserveAmmo === replayed.combat.reserveAmmo
    && restoredReplay.heat.pursuitActive === replayed.heat.pursuitActive
    && restoredReplay.heat.heat > 0
    && Math.hypot(
      restoredReplay.roam.target.x - replayed.roam.target.x,
      restoredReplay.roam.target.z - replayed.roam.target.z,
    ) < 0.05,
  'Replay did not persist mission-only restart semantics across reload', {
    replayed,
    restoredReplay,
  });

  const storageKey = restored.save.key;
  const legacySnapshot = await page.evaluate(({ key }) => {
    const snapshot = JSON.parse(window.localStorage.getItem(key));
    delete snapshot.world;
    window.localStorage.setItem(key, JSON.stringify(snapshot));
    return snapshot;
  }, { key: storageKey });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const restoredLegacy = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    roam: window.__SF_SIM__.getRoamState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(restoredLegacy.life.cash === restoredReplay.life.cash
    && restoredLegacy.mission.status === 'running'
    && restoredLegacy.mission.completedSteps === 0
    && restoredLegacy.combat.health >= restoredReplay.combat.health
    && restoredLegacy.combat.health < restoredLegacy.combat.maxHealth
    && restoredLegacy.combat.ammo === restoredReplay.combat.ammo
    && restoredLegacy.combat.reserveAmmo === restoredReplay.combat.reserveAmmo
    && restoredLegacy.save.snapshot?.world === undefined
    && Math.hypot(
      restoredLegacy.roam.target.x - beforeReload.save.snapshot.world.x,
      restoredLegacy.roam.target.z - beforeReload.save.snapshot.world.z,
    ) > 1,
  'legacy v1 snapshot without world state did not restore compatible progress at the default spawn', {
    legacySnapshot,
    restoredLegacy,
  });

  const invalidWorldSnapshot = await page.evaluate(({ key }) => {
    const snapshot = JSON.parse(window.localStorage.getItem(key));
    snapshot.world = {
      mode: 'outdoor',
      x: 999999,
      z: 999999,
      yaw: 0,
      pitch: 1,
      distance: 24,
    };
    window.localStorage.setItem(key, JSON.stringify(snapshot));
    return snapshot;
  }, { key: storageKey });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const rejectedWorld = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    roam: window.__SF_SIM__.getRoamState(),
    message: document.querySelector('.hud__message-text')?.textContent || '',
  }));
  assert(rejectedWorld.life.cash === 140
    && rejectedWorld.life.inventory.medkit.count === 0
    && rejectedWorld.mission.status === 'running'
    && rejectedWorld.mission.completedSteps === 0
    && rejectedWorld.combat.health === rejectedWorld.combat.maxHealth
    && rejectedWorld.combat.ammo === rejectedWorld.combat.magazineSize
    && rejectedWorld.roam.target.x === 28
    && rejectedWorld.roam.target.z === 38
    && !rejectedWorld.message.includes('Progress restored'),
  'out-of-bounds world state did not atomically reject the whole progress snapshot', {
    invalidWorldSnapshot,
    rejectedWorld,
  });

  await page.evaluate(() => window.__SF_SIM__.clearSavedProgress());
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.evaluate(({ key }) => window.localStorage.setItem(key, '{malformed-json'), { key: storageKey });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch();
  const corrupted = await page.evaluate(() => ({
    life: window.__SF_SIM__.lifeSim.getState(),
    mission: window.__SF_SIM__.cityShift.getState(),
    combat: window.__SF_SIM__.getCombatState(),
    save: window.__SF_SIM__.getSavedProgress(),
  }));
  assert(corrupted.life.cash === 140
    && corrupted.life.inventory.medkit.count === 0
    && corrupted.mission.status === 'running'
    && corrupted.mission.completedSteps === 0
    && corrupted.combat.health === corrupted.combat.maxHealth
    && corrupted.combat.ammo === corrupted.combat.magazineSize
    && corrupted.combat.reserveAmmo === 48
    && corrupted.save.snapshot === null,
  'malformed save did not fall back to clean validated defaults', corrupted);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForTimeout(4000);
  const performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot?.() || null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'persistence slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'persistence smoke passed'
      : 'persistence smoke failed',
    baseUrl,
    angle,
    market,
    progressed,
    heatSetup,
    aimedAutosave,
    beforeReload,
    restored,
    completed,
    restoredComplete,
    restoredReplay,
    restoredLegacy,
    rejectedWorld,
    corrupted,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'persistence smoke passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'persistence smoke failed',
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
