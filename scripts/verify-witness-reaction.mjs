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
let stageDiagnostic = null;
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

async function evidence(victimId = null, witnessId = null) {
  return page.evaluate(({ victim, witness }) => {
    const sim = window.__SF_SIM__;
    return {
      driving: sim.isDriving(),
      vehicle: sim.traffic.getPlayerVehicleState(),
      diagnostics: sim.traffic.getDiagnostics(),
      heat: sim.getStreetHeatState(),
      victim: victim ? sim.pedestrians.getVehicleImpactState(victim) : null,
      witness: witness ? sim.pedestrians.getVehicleWitnessState(witness) : null,
      saved: sim.getSavedProgress(),
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  }, { victim: victimId, witness: witnessId });
}

async function stagePlayerBehindWitnessedResident(fallbackResidents = []) {
  return page.evaluate((residentFallback) => {
    const sim = window.__SF_SIM__;
    const base = sim.traffic.exportPlayerVehicleState();
    if (!base || base.mode !== 'driving') return null;
    const broadProbe = {
      start: { x: -10000, z: -10000 },
      end: { x: 10000, z: 10000 },
      halfWidth: 10000,
    };
    const visibleResidents = sim.pedestrians.getVehicleImpactCandidates(broadProbe, []);
    const sourceResidents = visibleResidents.length ? visibleResidents : residentFallback;
    let candidates = sourceResidents
      .map((resident) => ({
        resident,
        witness: sim.pedestrians.getVehicleImpactWitness(resident.id, 18),
      }))
      .filter((entry) => visibleResidents.length === 0 || entry.witness?.id);
    let qaWitnessStaged = false;
    let qaWitnessDiagnostics = null;
    if (candidates.length === 0 && visibleResidents.length >= 2) {
      const resident = visibleResidents[0];
      const witnessResident = visibleResidents.find((entry) => entry.id !== resident.id);
      const anchored = witnessResident && sim.pedestrians.setQaWitnessAnchor(witnessResident.id, {
        x: resident.position.x + 4,
        y: resident.position.y,
        z: resident.position.z + 2,
      });
      if (anchored) {
        sim.pedestrians.update(0.001, performance.now() / 1000);
        const witness = sim.pedestrians.getVehicleImpactWitness(resident.id, 18);
        qaWitnessDiagnostics = {
          residentId: resident.id,
          witnessResidentId: witnessResident.id,
          anchored,
          witness,
        };
        if (witness) {
          candidates = [{ resident, witness }];
          qaWitnessStaged = true;
        }
      }
    }
    candidates.sort((a, b) => {
      const priority = (entry) => entry.resident.activity === 'crossing:wait' ? 0
        : entry.resident.activity === 'paused' ? 1
          : entry.resident.activity === 'working' ? 2 : 3;
      return priority(a) - priority(b)
        || (a.witness?.distance ?? Infinity) - (b.witness?.distance ?? Infinity);
    });
    for (const entry of candidates) {
      const candidate = entry.resident;
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
        if (!sim.traffic.importPlayerVehicleState(snapshot)) continue;
        const state = sim.traffic.getPlayerVehicleState();
        const actualForwardX = Math.sin(state.heading);
        const actualForwardZ = Math.cos(state.heading);
        const dx = candidate.position.x - state.position.x;
        const dz = candidate.position.z - state.position.z;
        const forward = dx * actualForwardX + dz * actualForwardZ;
        const lateral = Math.abs(dx * actualForwardZ - dz * actualForwardX);
        const signalDistance = Number(state.signalAhead?.distance);
        if (forward >= 5.2
          && forward <= 7.5
          && lateral <= 1.25
          && (!Number.isFinite(signalDistance) || signalDistance > forward + 1.5)) {
          sim.pedestrians.setQaWitnessAnchor(candidate.id, candidate.position);
          return {
            resident: candidate,
            witness: entry.witness,
            start: state.position,
            forward,
            lateral,
            qaWitnessStaged,
            needsWitnessRefresh: !entry.witness?.id,
          };
        }
        sim.traffic.importPlayerVehicleState(structuredClone(base));
      }
    }
    sim.traffic.importPlayerVehicleState(structuredClone(base));
    return {
      failed: true,
      candidateCount: candidates.length,
      visibleResidentCount: visibleResidents.length,
      qaWitnessDiagnostics,
    };
  }, fallbackResidents);
}

try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await launch();
  await page.waitForFunction(() => window.__SF_SIM__.pedestrians.getStats().visible > 1,
    null, { timeout: 15000, polling: 40 });
  await page.waitForTimeout(900);

  const passive = await evidence();
  assert(passive.driving === false
    && passive.heat?.witnessReports === 0
    && passive.diagnostics?.pedestrianImpactEvents === 0,
  'on-foot or AI activity created a witness report', passive);

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

  const selection = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const residents = sim.pedestrians.getVehicleImpactCandidates({
      start: { x: -10000, z: -10000 },
      end: { x: 10000, z: 10000 },
      halfWidth: 10000,
    }, []);
    const candidates = sim.traffic.getVehicleLifeSnapshot().vehicles.filter((entry) => (
      entry.identity?.category === 'private'
      && entry.class !== 'bike'
      && entry.action?.key === 'parked'
      && entry.theft?.reported === false
    ));
    candidates.sort((a, b) => {
      const nearest = (entry) => residents.reduce((distance, resident) => Math.min(
        distance,
        Math.hypot(
          resident.position.x - entry.position.x,
          resident.position.z - entry.position.z,
        ),
      ), Infinity);
      return nearest(a) - nearest(b);
    });
    return { vehicle: candidates[0] || null, residents };
  });
  const vehicle = selection.vehicle;
  assert(vehicle?.id >= 0, 'no parked private vehicle was available', vehicle);
  await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), vehicle.position);
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__.isDriving() === true,
    null, { timeout: 5000, polling: 25 });

  let stage = null;
  const deadline = Date.now() + 15000;
  while (!(stage?.resident && stage?.witness) && Date.now() < deadline) {
    stage = await stagePlayerBehindWitnessedResident(selection.residents);
    if (!(stage?.resident && stage?.witness)) {
      await page.evaluate(() => {
        const sim = window.__SF_SIM__;
        const start = performance.now() / 1000;
        for (let index = 0; index < 120; index += 1) {
          sim.pedestrians.update(0.05, start + index * 0.05);
        }
      });
      await page.waitForTimeout(40);
    }
  }
  assert(stage?.resident?.id && stage?.witness?.id,
    'no road-aligned victim with a live witness was available', stage);
  if (!stage?.resident?.id || !stage?.witness?.id) {
    throw new Error(`witness staging failed: ${JSON.stringify(stage)}`);
  }

  const alignedStage = await page.evaluate(({ residentId, residentY }) => {
    const sim = window.__SF_SIM__;
    const vehicleState = sim.traffic.getPlayerVehicleState();
    if (!vehicleState || !Number.isFinite(vehicleState.heading)) return null;
    const position = {
      x: vehicleState.position.x + Math.sin(vehicleState.heading) * 6.4,
      y: residentY,
      z: vehicleState.position.z + Math.cos(vehicleState.heading) * 6.4,
    };
    if (!sim.pedestrians.setQaWitnessAnchor(residentId, position)) return null;
    sim.pedestrians.update(0.001, performance.now() / 1000);
    return {
      position,
      witness: sim.pedestrians.getVehicleImpactWitness(residentId, 18),
    };
  }, { residentId: stage.resident.id, residentY: stage.resident.position.y });
  assert(alignedStage?.witness?.id,
    'road-projected victim alignment did not retain a live witness', alignedStage);
  if (!alignedStage?.witness?.id) {
    throw new Error(`aligned witness staging failed: ${JSON.stringify(alignedStage)}`);
  }
  stage.resident.position = alignedStage.position;
  stage.witness = alignedStage.witness;

  await page.evaluate(() => window.__SF_SIM__.streetHeat.restart());
  const before = await evidence(stage.resident.id, stage.witness.id);
  stageDiagnostic = { stage, before };
  await page.keyboard.down('w');
  await page.waitForFunction((count) => (
    window.__SF_SIM__.traffic.getDiagnostics().pedestrianImpactEvents > count
  ), before.diagnostics.pedestrianImpactEvents, { timeout: 6000, polling: 10 });
  await page.keyboard.up('w');
  await page.evaluate(() => window.__SF_SIM__.pedestrians.setQaWitnessAnchor());
  const impactState = await page.evaluate(() => window.__SF_SIM__.getStreetHeatState());
  const witnessId = impactState.lastWitnessEvent?.witnessId;
  const impact = await evidence(stage.resident.id, witnessId);
  const savedHeat = impact.saved?.snapshot?.streetHeat?.heat;
  assert(impact.diagnostics.pedestrianImpactEvents === before.diagnostics.pedestrianImpactEvents + 1
    && impact.victim?.count === before.victim?.count + 1
    && impact.heat?.witnessReports === 1
    && impact.heat?.lastEvent?.kind === 'pedestrian-impact'
    && impact.heat?.lastWitnessEvent?.kind === 'witness-report'
    && impact.heat?.lastWitnessEvent?.victimId === stage.resident.id
    && witnessId !== stage.resident.id
    && impact.witness?.active === true
    && impact.witness?.remaining >= 1.2
    && impact.witness?.reaction === 'phone-flee'
    && impact.saved?.snapshot?.streetHeat?.witnessReports === 1
    && Math.abs(savedHeat - 14) <= 0.05
    && impact.message.includes('called in the impact'),
  'real impact did not produce one readable persisted witness report', {
    stage,
    before,
    impact,
    witnessId,
    savedHeat,
  });

  const witnessStart = impact.witness?.position;
  await page.waitForTimeout(350);
  const latched = await evidence(stage.resident.id, witnessId);
  assert(latched.diagnostics.pedestrianImpactEvents === impact.diagnostics.pedestrianImpactEvents
    && latched.heat?.witnessReports === 1
    && latched.witness?.count === impact.witness?.count,
  'continued overlap duplicated the witness report', { impact, latched });
  await page.waitForTimeout(900);
  const fleeing = await evidence(stage.resident.id, witnessId);
  const witnessDisplacement = Math.hypot(
    fleeing.witness?.position.x - witnessStart.x,
    fleeing.witness?.position.z - witnessStart.z,
  );
  assert(fleeing.witness?.active === true
    && witnessDisplacement >= 1.2
    && witnessDisplacement <= 4.4
    && fleeing.witness.displacement <= 4.4
    && fleeing.witness.groundError <= 0.05,
  'witness flee/phone reaction was not readable, bounded, and grounded', {
    impact,
    fleeing,
    witnessDisplacement,
  });

  await page.evaluate(() => window.__SF_SIM__.saveProgress());
  const persisted = await evidence(stage.resident.id, witnessId);
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await launch(40);
  const restored = await evidence(stage.resident.id, witnessId);
  assert(restored.heat?.witnessReports === 1
    && restored.heat?.lastWitnessEvent === null
    && restored.saved?.snapshot?.streetHeat?.witnessReports === 1
    && restored.diagnostics?.pedestrianImpactEvents === 0
    && (restored.witness?.count || 0) === 0,
  'reload did not preserve the report count or replayed transient witness state', {
    persisted,
    restored,
  });

  const defensive = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const before = sim.getStreetHeatState();
    return {
      before,
      invalidIncident: sim.streetHeat.reportWitness({
        incidentId: 0,
        witnessId: 'resident-02',
        victimId: 'resident-01',
      }),
      sameActor: sim.streetHeat.reportWitness({
        incidentId: 99,
        witnessId: 'resident-01',
        victimId: 'resident-01',
      }),
      missingReaction: sim.pedestrians.registerVehicleWitnessReaction('missing-resident', {}),
      after: sim.getStreetHeatState(),
    };
  });
  assert(defensive.invalidIncident === null
    && defensive.sameActor === null
    && defensive.missingReaction === null
    && defensive.after.witnessReports === defensive.before.witnessReports,
  'invalid, same-actor, or missing witness input mutated report state', defensive);

  await page.evaluate(() => window.__SF_SIM__.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    (window.__SF_SIM__.getPerformanceSnapshot?.()?.applicationFrameCount || 0) >= 180
  ), null, { timeout: 10000, polling: 100 });
  const performance = await page.evaluate(
    () => window.__SF_SIM__.getPerformanceSnapshot?.() || null,
  );
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'witness reaction slice exceeded application frame budget', performance);

  const result = {
    result: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0
      ? 'witness reaction smoke passed'
      : 'witness reaction smoke failed',
    baseUrl,
    angle,
    vehicle: { id: vehicle?.id, class: vehicle?.class },
    stage,
    before,
    impact,
    latched,
    fleeing,
    persisted,
    restored,
    defensive,
    performance,
    consoleErrors,
    httpErrors,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || consoleErrors.length || httpErrors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  const browserEvidence = await page.evaluate(() => ({
    heat: window.__SF_SIM__?.getStreetHeatState?.(),
    diagnostics: window.__SF_SIM__?.traffic?.getDiagnostics?.(),
    vehicle: window.__SF_SIM__?.traffic?.getPlayerVehicleState?.(),
  })).catch(() => null);
  console.error(JSON.stringify({ ...browserEvidence, stageDiagnostic }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
