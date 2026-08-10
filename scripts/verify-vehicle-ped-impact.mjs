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

async function launch(settleMs = 400) {
  await page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled,
    null,
    { timeout: 60000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => Boolean(window.__SF_SIM__), null, { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(settleMs);
}

async function evidence(residentId = null) {
  return page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const resident = id ? sim.pedestrians.getVehicleImpactCandidates({
      start: { x: -10000, z: -10000 },
      end: { x: 10000, z: 10000 },
      halfWidth: 10000,
    }, []).find((candidate) => candidate.id === id) || null : null;
    return {
      driving: sim.isDriving(),
      vehicle: sim.traffic.getPlayerVehicleState(),
      diagnostics: sim.traffic.getDiagnostics(),
      heat: sim.getStreetHeatState(),
      reaction: id ? sim.pedestrians.getVehicleImpactState(id) : null,
      resident,
      audio: sim.getCombatAudioState(),
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  }, residentId);
}

async function stagePlayerBehindLiveResident(fallbackResidents = []) {
  return page.evaluate((residentFallback) => {
    const sim = window.__SF_SIM__;
    const base = sim.traffic.exportPlayerVehicleState();
    if (!base || base.mode !== 'driving') return null;
    const baseReimported = sim.traffic.importPlayerVehicleState(structuredClone(base));
    const broadProbe = {
      start: { x: -10000, z: -10000 },
      end: { x: 10000, z: 10000 },
      halfWidth: 10000,
    };
    const visibleCandidates = sim.pedestrians.getVehicleImpactCandidates(broadProbe, []);
    const candidates = residentFallback.length ? residentFallback : visibleCandidates;
    const attempts = [];
    candidates.sort((a, b) => {
      const priority = (candidate) => candidate.activity === 'crossing:wait' ? 0
        : candidate.activity === 'paused' ? 1
          : candidate.activity === 'working' ? 2
            : candidate.activity === 'crossing:cross' ? 3 : 4;
      return priority(a) - priority(b);
    });
    for (const candidate of candidates) {
      const headings = [0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5, candidate.heading];
      for (const heading of headings) {
        if (!Number.isFinite(heading)) continue;
        const forwardX = Math.sin(heading);
        const forwardZ = Math.cos(heading);
        const snapshot = structuredClone(base);
        snapshot.position = {
          x: candidate.position.x - forwardX * 6.4,
          z: candidate.position.z - forwardZ * 6.4,
        };
        snapshot.heading = heading;
        if (!sim.traffic.importPlayerVehicleState(snapshot)) {
          if (attempts.length < 24) attempts.push({
            id: candidate.id,
            activity: candidate.activity,
            position: candidate.position,
            heading,
            imported: false,
          });
          continue;
        }
        const state = sim.traffic.getPlayerVehicleState();
        const actualForwardX = Math.sin(state.heading);
        const actualForwardZ = Math.cos(state.heading);
        const dx = candidate.position.x - state.position.x;
        const dz = candidate.position.z - state.position.z;
        const forward = dx * actualForwardX + dz * actualForwardZ;
        const lateral = Math.abs(dx * actualForwardZ - dz * actualForwardX);
        const signalDistance = Number(state.signalAhead?.distance);
        if (attempts.length < 24) attempts.push({
          id: candidate.id,
          activity: candidate.activity,
          heading,
          imported: true,
          forward,
          lateral,
          signalDistance,
          state,
        });
        if (forward < 5.2
          || forward > 7.5
          || lateral > 1.25
          || (Number.isFinite(signalDistance) && signalDistance <= forward + 1.5)) {
          sim.traffic.importPlayerVehicleState(structuredClone(base));
          continue;
        }
        return {
          resident: candidate,
          start: state.position,
          forward,
          lateral,
          vehicle: state,
        };
      }
    }
    return { failed: true, base, baseReimported, candidateCount: candidates.length, attempts };
  }, fallbackResidents);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.getStats().visible > 0,
    null, { timeout: 15000, polling: 40 });

  await page.waitForTimeout(900);
  const passive = await evidence();
  assert(passive.driving === false
    && passive.diagnostics.pedestrianImpactEvents === 0
    && passive.heat.heat === 0,
  'on-foot or AI traffic generated a pedestrian impact', passive);

  const crossingStaged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const probe = {
      start: { x: -10000, z: -10000 },
      end: { x: 10000, z: 10000 },
      halfWidth: 10000,
    };
    const startedAt = performance.now() / 1000;
    for (let step = 0; step < 2400; step += 1) {
      sim.pedestrians.update(0.05, startedAt + step * 0.05);
      const crossing = sim.pedestrians.getVehicleImpactCandidates(probe, [])
        .find((resident) => resident.activity === 'crossing:cross');
      if (crossing) return crossing;
    }
    return null;
  });
  assert(crossingStaged?.id, 'could not stage a live crosswalk resident', crossingStaged);
  if (!crossingStaged?.id) throw new Error('live crosswalk resident staging failed');

  const vehicleSelection = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const resident = sim.pedestrians.getNearestPerson({ x: 0, z: 0 }, 10000);
    const residents = sim.pedestrians.getVehicleImpactCandidates({
      start: { x: -10000, z: -10000 },
      end: { x: 10000, z: 10000 },
      halfWidth: 10000,
    }, []);
    residents.sort((a, b) => Number(b.activity === 'crossing:cross')
      - Number(a.activity === 'crossing:cross'));
    const candidates = sim.traffic.getVehicleLifeSnapshot().vehicles.filter((vehicle) => (
      vehicle.identity?.category === 'private'
      && vehicle.class !== 'bike'
      && vehicle.action?.key === 'parked'
      && vehicle.theft?.reported === false
    ));
    candidates.sort((a, b) => {
      const nearest = (vehicle) => residents.reduce((distance, candidate) => Math.min(
        distance,
        Math.hypot(
          candidate.position.x - vehicle.position.x,
          candidate.position.z - vehicle.position.z,
        ),
      ), Infinity);
      return nearest(a) - nearest(b);
    });
    return {
      vehicle: candidates[0] || null,
      resident,
      residents,
      pedestrianStats: sim.pedestrians.getStats(),
      roam: sim.getRoamState(),
    };
  });
  const privateVehicle = vehicleSelection.vehicle;
  assert(privateVehicle?.id >= 0, 'no parked private vehicle was available', privateVehicle);
  assert(vehicleSelection.resident?.id, 'no initial live resident was available', vehicleSelection);
  if (!Number.isInteger(privateVehicle?.id) || !vehicleSelection.resident?.id) {
    throw new Error(`initial vehicle/resident selection failed: ${JSON.stringify(vehicleSelection)}`);
  }
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), privateVehicle.position);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true,
    null, { timeout: 5000, polling: 25 });
  await stagePlayerBehindLiveResident(vehicleSelection.residents);
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.getVehicleImpactCandidates({
    start: { x: -10000, z: -10000 },
    end: { x: 10000, z: 10000 },
    halfWidth: 10000,
  }, []).length > 0, null, { timeout: 5000, polling: 25 });

  let stage = null;
  let lastStageAttempt = null;
  const stageDeadline = Date.now() + 15000;
  while (!stage?.resident && Date.now() < stageDeadline) {
    const attemptedStage = await stagePlayerBehindLiveResident();
    lastStageAttempt = attemptedStage;
    if (attemptedStage?.resident
      && attemptedStage.resident.activity === 'crossing:wait'
      && attemptedStage.forward >= 5.2
      && attemptedStage.forward <= 7.5
      && attemptedStage.lateral <= 1.38) {
      stage = attemptedStage;
    }
    if (!stage?.resident) {
      await page.evaluate(() => {
        const sim = window.__SF_SIM__;
        const startedAt = performance.now() / 1000;
        for (let step = 0; step < 180; step += 1) {
          sim.pedestrians.update(0.05, startedAt + step * 0.05);
        }
      });
      await page.waitForTimeout(40);
    }
  }
  assert(stage?.resident?.id, 'no live resident aligned with a legal player road path', stage);
  if (!stage?.resident?.id) {
    throw new Error(`vehicle-pedestrian impact staging failed: ${JSON.stringify(lastStageAttempt)}`);
  }

  await page.evaluate(() => window.__SF_SIM__.streetHeat.restart());
  const beforeImpact = await evidence(stage?.resident?.id);
  await page.keyboard.down('w');
  const impactObserved = await page.waitForFunction((eventCount) => (
    window.__SF_SIM__.traffic.getDiagnostics().pedestrianImpactEvents > eventCount
  ), beforeImpact.diagnostics.pedestrianImpactEvents,
  { timeout: 6000, polling: 10 }).then(() => true).catch(() => false);
  const impact = await evidence(stage.resident.id);
  const distanceObserved = await page.waitForFunction((start) => {
    const point = window.__SF_SIM__.traffic.getPlayerVehicleState()?.position;
    return point && Math.hypot(point.x - start.x, point.z - start.z) > 8;
  }, stage.start, { timeout: 6000, polling: 10 }).then(() => true).catch(() => false);
  await page.keyboard.up('w');
  const postDrive = await evidence(stage.resident.id);
  const displacement = postDrive.vehicle ? Math.hypot(
    postDrive.vehicle.position.x - stage.start.x,
    postDrive.vehicle.position.z - stage.start.z,
  ) : 0;
  const savedHeat = impact.saved?.snapshot?.streetHeat?.heat;
  assert(impactObserved
    && distanceObserved
    && displacement > 8
    && beforeImpact.vehicle.speed === 0
    && impact.diagnostics.pedestrianImpactEvents === beforeImpact.diagnostics.pedestrianImpactEvents + 1
    && impact.reaction?.count === beforeImpact.reaction?.count + 1
    && impact.reaction?.active === true
    && impact.vehicle.damage.lastDamage?.source === 'pedestrian-impact'
    && impact.vehicle.damage.health < beforeImpact.vehicle.damage.health
    && Math.abs(savedHeat - (beforeImpact.heat.heat + 14)) <= 0.05
    && impact.heat.lastEvent?.kind === 'pedestrian-impact'
    && impact.heat.heat <= savedHeat
    && impact.heat.heat >= savedHeat - 1
    && impact.audio?.cueCounts?.impact >= 1,
  'real W drive did not produce one complete pedestrian-impact consequence', {
    stage,
    beforeImpact,
    impact,
    postDrive,
    displacement,
    savedHeat,
  });

  await page.waitForTimeout(350);
  const latched = await evidence(stage.resident.id);
  assert(latched.diagnostics.pedestrianImpactEvents === impact.diagnostics.pedestrianImpactEvents
    && latched.reaction?.count === impact.reaction?.count,
  'overlap latch emitted a duplicate pedestrian impact', { impact, latched });

  await page.evaluate(() => window.__SF_SIM__.saveProgress());
  const persistedBeforeReload = await evidence(stage.resident.id);
  const savedDamage = persistedBeforeReload.vehicle.damage;
  const persistedHeat = persistedBeforeReload.saved?.snapshot?.streetHeat?.heat;
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch(40);
  const restored = await evidence(stage.resident.id);
  assert(restored.driving === true
    && restored.vehicle?.index === beforeImpact.vehicle.index
    && restored.vehicle?.damage?.health === savedDamage.health
    && restored.vehicle?.damage?.lastDamage?.source === 'pedestrian-impact'
    && restored.heat.heat <= persistedHeat
    && restored.heat.heat >= persistedHeat - 1
    && restored.diagnostics.pedestrianImpactEvents === 0
    && restored.reaction?.count === 0,
  'reload did not preserve damage/heat or replayed the transient impact', {
    impact,
    persistedBeforeReload,
    restored,
    savedDamage,
    savedHeat,
    persistedHeat,
  });

  const defensiveNegatives = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const probe = sim.traffic.getPlayerPedestrianImpactProbe();
    const before = sim.traffic.getDiagnostics().pedestrianImpactEvents;
    const farOffset = (probe?.halfWidth || 1) + 2.5;
    const nearMiss = probe ? sim.traffic.resolvePlayerPedestrianImpact([{
      id: 'qa-near-miss',
      label: 'Near miss resident',
      position: { x: probe.end.x, z: probe.end.z + farOffset },
      radius: 0.42,
      combatDefeated: false,
    }]) : 'missing-probe';
    const defeated = probe ? sim.traffic.resolvePlayerPedestrianImpact([{
      id: 'qa-defeated-resident',
      label: 'Defeated resident',
      position: { x: probe.end.x, z: probe.end.z },
      radius: 0.42,
      combatDefeated: true,
    }]) : 'missing-probe';
    return {
      probe,
      before,
      after: sim.traffic.getDiagnostics().pedestrianImpactEvents,
      nearMiss,
      defeated,
    };
  });
  assert(defensiveNegatives.probe
    && defensiveNegatives.nearMiss === null
    && defensiveNegatives.defeated === null
    && defensiveNegatives.after === defensiveNegatives.before,
  'near-miss or defeated resident produced an impact consequence', defensiveNegatives);

  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === false,
    null, { timeout: 3000, polling: 20 });
  await page.waitForTimeout(80);
  const onFootNegative = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = sim.traffic.getDiagnostics().pedestrianImpactEvents;
    const impact = sim.traffic.resolvePlayerPedestrianImpact([{
      id: 'qa-on-foot-resident',
      label: 'On-foot resident',
      position: { x: 0, z: 0 },
      radius: 0.42,
      combatDefeated: false,
    }]);
    return {
      impact,
      probe: sim.traffic.getPlayerPedestrianImpactProbe(),
      before,
      after: sim.traffic.getDiagnostics().pedestrianImpactEvents,
    };
  });
  assert(onFootNegative.impact === null
    && onFootNegative.probe === null
    && onFootNegative.after === onFootNegative.before,
  'on-foot player produced a vehicle-pedestrian impact', onFootNegative);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    (window.__SF_SIM__.getPerformanceSnapshot?.()?.applicationFrameCount || 0) >= 180
  ), null, { timeout: 10000, polling: 100 });
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'vehicle-pedestrian impact slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'vehicle pedestrian impact smoke passed'
      : 'vehicle pedestrian impact smoke failed',
    baseUrl,
    angle,
    privateVehicle,
    stage,
    beforeImpact,
    impact,
    postDrive,
    displacement,
    latched,
    persistedBeforeReload,
    restored,
    defensiveNegatives,
    onFootNegative,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'vehicle pedestrian impact smoke passed') process.exitCode = 1;
} finally {
  await browser.close();
}
