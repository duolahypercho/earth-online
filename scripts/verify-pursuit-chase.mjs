import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const viewport = { width: 1280, height: 720 };
const outputDir = resolve('.qa-pursuit-chase');
const captures = {
  activeRouting: join(outputDir, 'active-routing.png'),
  secondContact: join(outputDir, 'second-contact.png'),
  arrestedCleared: join(outputDir, 'arrested-cleared.png'),
};

await mkdir(outputDir, { recursive: true });

if (process.platform !== 'darwin') {
  throw new Error('verify-pursuit-chase requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-pursuit-chase requires SF_QA_ANGLE=metal, received ${angle}`);
}
if (!executablePath) {
  throw new Error(`System Chrome is required for the Apple Metal gate: ${systemChrome}`);
}

const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  executablePath,
  args: [
    '--disable-dev-shm-usage',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport });
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestErrors = [];
let renderer = null;
let staging = null;
let isolatedSurrenderNegative = null;
let samples = [];
let performanceSnapshot = null;

const finite = (value) => Number.isFinite(value);
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail == null ? {} : { detail }) });
};
const angleDifference = (left, right) => Math.atan2(
  Math.sin(Number(left) - Number(right)),
  Math.cos(Number(left) - Number(right)),
);

function watchPageDiagnostics(targetPage) {
  targetPage.on('pageerror', (error) => consoleErrors.push(error.message));
  targetPage.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('/favicon.ico')) {
      consoleErrors.push(message.text());
    }
  });
  targetPage.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  targetPage.on('requestfailed', (request) => {
    if (!request.url().endsWith('/favicon.ico')) {
      requestErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
    }
  });
}

watchPageDiagnostics(page);

async function launch(targetPage = page) {
  await targetPage.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await targetPage.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await targetPage.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await targetPage.locator('#launch-button').click();
  await targetPage.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await targetPage.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return typeof sim?.traffic?.getPursuitChaseDiagnostics === 'function'
      && typeof sim?.traffic?.getVehicleLifeSnapshot === 'function'
      && typeof sim?.getStreetHeatState === 'function'
      && typeof sim?.getPerformanceSnapshot === 'function';
  }, null, { timeout: 12000, polling: 25 });
  await targetPage.waitForTimeout(700);
  await targetPage.locator('#scene-canvas').focus();
}

async function readEvidence(targetPage = page) {
  return targetPage.evaluate(() => {
    const sim = window.__SF_SIM__;
    const player = sim.traffic.getPlayerVehicleState?.() ?? null;
    const fleet = sim.traffic.getVehicleLifeSnapshot?.()?.vehicles ?? [];
    return {
      driving: sim.isDriving?.() === true,
      player,
      playerLife: Number.isInteger(player?.index)
        ? fleet.find((vehicle) => vehicle.id === player.index) ?? null
        : null,
      heat: sim.getStreetHeatState?.() ?? null,
      heatPersisted: sim.streetHeat?.exportState?.() ?? null,
      responders: sim.traffic.getPursuitResponders?.() ?? [],
      chase: sim.traffic.getPursuitChaseDiagnostics?.() ?? null,
      diagnostics: sim.traffic.getDiagnostics?.() ?? null,
      citation: sim.getLastTrafficCitation?.() ?? null,
      life: sim.lifeSim?.getState?.() ?? null,
      resources: {
        geometries: sim.renderer?.info?.memory?.geometries ?? null,
        textures: sim.renderer?.info?.memory?.textures ?? null,
        streaming: (() => {
          const stats = sim.streaming?.getStats?.() ?? null;
          return stats ? {
            focusSector: stats.focusSector ?? null,
            populationPending: stats.populationPending ?? null,
            handoffPending: stats.handoffs?.pending ?? null,
          } : null;
        })(),
      },
      performance: sim.getPerformanceSnapshot?.() ?? null,
      message: document.querySelector('.hud__message-text')?.textContent || '',
    };
  });
}

async function waitForWorldSettled(timeout = 15000) {
  const settled = await page.waitForFunction(() => {
    const stats = window.__SF_SIM__?.streaming?.getStats?.();
    return stats
      && stats.populationPending === 0
      && stats.handoffs?.pending === 0;
  }, null, { timeout, polling: 50 }).then(() => true).catch(() => false);
  await page.waitForTimeout(800);
  return { settled, evidence: await readEvidence() };
}

async function verifyIsolatedSurrenderLatchNegative(testPage) {
  const candidate = await testPage.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.setWeather?.('clear');
    sim.streetHeat?.restart?.();
    sim.combat?.restart?.();
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => (
      entry.class !== 'bike'
      && entry.identity?.category === 'private'
      && entry.action?.key === 'parked'
      && entry.damage?.disabled !== true
      && entry.theft?.eligible === true
    ));
    if (!vehicle?.position) return null;
    sim.setRoamPose(vehicle.position);
    return { id: vehicle.id, position: vehicle.position };
  });
  if (!candidate) return { passed: false, reason: 'no-private-candidate' };
  await testPage.waitForTimeout(350);

  const setup = await testPage.evaluate(() => {
    const sim = window.__SF_SIM__;
    const entered = sim.enterCar?.() === true;
    const player = sim.traffic.getPlayerVehicleState?.();
    if (!entered || !player?.position) return { entered, player };
    const imported = sim.streetHeat.importState?.({
      heat: 30,
      pursuitActive: true,
      responderContacts: 0,
      responderContactLatched: false,
      nearMisses: 0,
      witnessReports: 0,
      combatHold: 0,
      theftHold: 0,
    }) === true;
    const original = sim.traffic.getPursuitResponders;
    const probe = { distance: 6, original };
    window.__SF_SURRENDER_NEGATIVE__ = probe;
    sim.traffic.getPursuitResponders = () => {
      const state = sim.traffic.getPlayerVehicleState?.();
      if (!state?.position) return [];
      return [{
        active: true,
        id: 900001,
        distance: probe.distance,
        position: {
          x: state.position.x + probe.distance,
          z: state.position.z,
        },
      }];
    };
    return { entered, imported, player: sim.traffic.getPlayerVehicleState?.() ?? null };
  });

  let latched = null;
  let distant = null;
  try {
    if (!setup?.entered || !setup?.imported) {
      return { passed: false, candidate, setup, reason: 'setup-failed' };
    }
    await testPage.waitForFunction(() => {
      const sim = window.__SF_SIM__;
      const heat = sim?.getStreetHeatState?.();
      return sim?.isDriving?.() === true
        && heat?.pursuitActive === true
        && heat.responderDistances.length > 0
        && heat.responderDistances.every((distance) => distance <= 10);
    }, null, { timeout: 4000, polling: 20 });

    await testPage.locator('#scene-canvas').focus();
    await testPage.keyboard.down('s');
    await testPage.waitForFunction(() => {
      const heat = window.__SF_SIM__?.getStreetHeatState?.();
      return heat?.arrests === 0 && heat?.arrestHold > 0;
    }, null, { timeout: 1000, polling: 10 });
    latched = await readEvidence(testPage);

    await testPage.evaluate(() => {
      window.__SF_SURRENDER_NEGATIVE__.distance = 100;
    });
    await testPage.waitForFunction(() => {
      const heat = window.__SF_SIM__?.getStreetHeatState?.();
      return heat?.responderDistances?.length > 0
        && heat.responderDistances.every((distance) => distance >= 99.5);
    }, null, { timeout: 2000, polling: 10 });
    await testPage.waitForTimeout(1500);
    distant = await readEvidence(testPage);
    const passed = distant.driving === true
      && distant.player?.speed <= 1.2
      && distant.heat?.pursuitActive === true
      && distant.heat?.arrests === 0
      && distant.heat?.arrestHold === 0
      && distant.heat?.safeElapsed >= 1.2
      && distant.heat?.responderDistances?.length > 0
      && distant.heat.responderDistances.every((distance) => distance >= 99.5);
    return {
      passed,
      candidate,
      setup,
      latched: summarizeEvidence(latched),
      distant: summarizeEvidence(distant),
    };
  } finally {
    await testPage.keyboard.up('s').catch(() => {});
    await testPage.evaluate(() => {
      const sim = window.__SF_SIM__;
      const probe = window.__SF_SURRENDER_NEGATIVE__;
      if (probe?.original) sim.traffic.getPursuitResponders = probe.original;
      delete window.__SF_SURRENDER_NEGATIVE__;
      sim.streetHeat?.restart?.();
      sim.traffic.setPursuitResponder?.({ active: false });
      sim.combat?.restart?.();
      if (sim.isDriving?.()) sim.exitCar?.();
    }).catch(() => {});
    await testPage.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === false,
      null, { timeout: 3000, polling: 20 }).catch(() => {});
    await testPage.waitForTimeout(350);
  }
}

function summarizeEvidence(evidence) {
  if (!evidence) return null;
  const player = evidence.player;
  const heat = evidence.heat;
  const chase = evidence.chase;
  return {
    driving: evidence.driving,
    player: player ? {
      index: player.index,
      road: player.road,
      speed: player.speed,
      heading: player.heading,
      position: player.position,
      signalAhead: player.signalAhead,
      theft: player.theft,
      damage: player.damage,
    } : null,
    heat: heat ? {
      heat: heat.heat,
      level: heat.level,
      pursuitActive: heat.pursuitActive,
      responderIds: heat.responderIds,
      responderDistances: heat.responderDistances,
      responderContacts: heat.responderContacts,
      arrestHold: heat.arrestHold,
      arrests: heat.arrests,
      safeElapsed: heat.safeElapsed,
      lastEvent: heat.lastEvent,
    } : null,
    responderContactLatched: evidence.heatPersisted?.responderContactLatched ?? null,
    chase: chase ? {
      active: chase.active,
      level: chase.level,
      routeDecisions: chase.routeDecisions,
      routeFallbacks: chase.routeFallbacks,
      lastDecision: chase.lastDecision,
      responders: chase.responders,
    } : null,
    citation: evidence.citation,
    diagnostics: evidence.diagnostics ? {
      vehicleThefts: evidence.diagnostics.vehicleThefts,
      playerRedLightViolations: evidence.diagnostics.playerRedLightViolations,
      pursuitRouteDecisions: evidence.diagnostics.pursuitRouteDecisions,
      pursuitRouteFallbacks: evidence.diagnostics.pursuitRouteFallbacks,
      lastPlayerCollision: evidence.diagnostics.lastPlayerCollision,
    } : null,
    resources: evidence.resources,
    message: evidence.message,
  };
}

async function prepareDeterministicRoadStart() {
  const candidate = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.setWeather?.('clear');
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => (
      entry.class !== 'bike'
      && entry.identity?.category === 'private'
      && entry.action?.key === 'parked'
      && entry.damage?.disabled !== true
      && entry.theft?.eligible === true
    ));
    if (!vehicle?.position) return null;
    sim.setRoamPose(vehicle.position);
    return { id: vehicle.id, class: vehicle.class, identity: vehicle.identity };
  });
  if (!candidate) return null;
  await page.waitForTimeout(350);

  const qaEntered = await page.evaluate(() => window.__SF_SIM__?.enterCar?.() === true);
  if (!qaEntered) return { candidate, qaEntered: false };
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true,
    null, { timeout: 4000, polling: 20 });

  const imported = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.exportPlayerVehicleState?.();
    if (!snapshot || snapshot.mode !== 'driving') return null;
    snapshot.position = { x: 28, z: 38 };
    snapshot.heading = 0;
    snapshot.theftReported = false;
    return {
      ok: sim.traffic.importPlayerVehicleState?.(snapshot) === true,
      state: sim.traffic.getPlayerVehicleState?.() ?? null,
    };
  });
  if (!imported?.ok) return { candidate, qaEntered, imported };

  // Wait before measurement so the first real W+A crosses a known red phase
  // while the four-second theft hold is still active. No gameplay mutation is
  // performed after the real E below starts the measured phase.
  await page.waitForFunction(() => {
    const signal = window.__SF_SIM__?.traffic?.getPlayerVehicleState?.()?.signalAhead;
    return signal?.phase === 'red' && signal.remaining >= 7;
  }, null, { timeout: 35000, polling: 25 });

  const finalized = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.exportPlayerVehicleState?.();
    if (!snapshot || snapshot.mode !== 'driving') return null;
    snapshot.position = { x: 28, z: 38 };
    snapshot.heading = 0;
    snapshot.theftReported = false;
    if (sim.traffic.importPlayerVehicleState?.(snapshot) !== true) return null;
    const staged = sim.traffic.getPlayerVehicleState?.();
    sim.streetHeat?.restart?.();
    sim.combat?.restart?.();
    if (sim.exitCar?.() !== true) return null;
    const parked = sim.traffic.getVehicleLifeSnapshot().vehicles.find(
      (vehicle) => vehicle.id === staged.index,
    );
    if (!parked?.position) return null;
    sim.setRoamPose(parked.position);
    return {
      vehicleId: staged.index,
      class: staged.class,
      position: parked.position,
      heading: staged.heading,
      signal: staged.signalAhead,
      baseline: {
        thefts: sim.traffic.getDiagnostics?.().vehicleThefts ?? null,
        citations: sim.traffic.getDiagnostics?.().playerRedLightViolations ?? null,
        routeDecisions: sim.traffic.getDiagnostics?.().pursuitRouteDecisions ?? null,
        routeFallbacks: sim.traffic.getDiagnostics?.().pursuitRouteFallbacks ?? null,
      },
    };
  });
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === false,
    null, { timeout: 3000, polling: 20 });
  await page.waitForTimeout(120);
  return { candidate, qaEntered, imported, finalized };
}

async function startRecorder() {
  await page.evaluate(() => {
    const token = {};
    const recorder = { token, active: true, samples: [] };
    window.__SF_PURSUIT_CHASE_RECORDER__ = recorder;
    const sample = () => {
      if (window.__SF_PURSUIT_CHASE_RECORDER__?.token !== token || !recorder.active) return;
      const sim = window.__SF_SIM__;
      const player = sim?.traffic?.getPlayerVehicleState?.() ?? null;
      const fleet = sim?.traffic?.getVehicleLifeSnapshot?.()?.vehicles ?? [];
      recorder.samples.push({
        at: performance.now(),
        player,
        playerRoute: Number.isInteger(player?.index)
          ? fleet.find((vehicle) => vehicle.id === player.index)?.route ?? null
          : null,
        heat: sim?.getStreetHeatState?.() ?? null,
        heatPersisted: sim?.streetHeat?.exportState?.() ?? null,
        chase: sim?.traffic?.getPursuitChaseDiagnostics?.() ?? null,
      });
      if (recorder.samples.length < 7200) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopRecorder() {
  return page.evaluate(() => {
    const recorder = window.__SF_PURSUIT_CHASE_RECORDER__;
    if (!recorder) return [];
    recorder.active = false;
    return recorder.samples.map((sample) => structuredClone(sample));
  });
}

async function crossPreparedRedTurn(baselineCitations) {
  const before = await readEvidence();
  await page.keyboard.down('a');
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(({ citationCount, road, heading }) => {
      const sim = window.__SF_SIM__;
      const player = sim?.traffic?.getPlayerVehicleState?.();
      const diagnostics = sim?.traffic?.getDiagnostics?.();
      return diagnostics?.playerRedLightViolations >= citationCount + 1
        && player
        && player.road !== road
        && Math.abs(Math.atan2(
          Math.sin(player.heading - heading),
          Math.cos(player.heading - heading),
        )) >= 0.35;
    }, {
      citationCount: baselineCitations,
      road: before.player.road,
      heading: before.player.heading,
    }, { timeout: 16000, polling: 15 });
  } finally {
    await page.keyboard.up('a').catch(() => {});
    await page.keyboard.up('w').catch(() => {});
  }
  return { before, after: await readEvidence() };
}

async function driveThroughTurn(steerKey, before) {
  await page.keyboard.down(steerKey);
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(({ road, heading }) => {
      const player = window.__SF_SIM__?.traffic?.getPlayerVehicleState?.();
      return player && player.road !== road && Math.abs(Math.atan2(
        Math.sin(player.heading - heading),
        Math.cos(player.heading - heading),
      )) >= 0.35;
    }, { road: before.player.road, heading: before.player.heading }, {
      timeout: 26000,
      polling: 15,
    });
  } finally {
    await page.keyboard.up(steerKey).catch(() => {});
    await page.keyboard.up('w').catch(() => {});
  }
  return readEvidence();
}

async function driveTowardResponderUntilContact(
  responderId,
  minimumContacts = 1,
  timeout = 30000,
) {
  const deadline = Date.now() + timeout;
  let heldSteer = null;
  const setSteer = async (next) => {
    if (heldSteer === next) return;
    if (heldSteer) await page.keyboard.up(heldSteer).catch(() => {});
    heldSteer = next;
    if (heldSteer) await page.keyboard.down(heldSteer);
  };
  await page.keyboard.down('w');
  try {
    while (Date.now() < deadline) {
      const state = await page.evaluate((id) => {
        const sim = window.__SF_SIM__;
        const player = sim?.traffic?.getPlayerVehicleState?.();
        const chase = sim?.traffic?.getPursuitChaseDiagnostics?.();
        const responder = chase?.responders?.find((entry) => entry.id === id) ?? null;
        const heat = sim?.getStreetHeatState?.();
        return { player, responder, heat, chase };
      }, responderId);
      if (state.heat?.responderContacts >= minimumContacts) return { ready: true, state };
      if (!state.heat?.pursuitActive || !state.player || !state.responder) {
        return { ready: false, state };
      }
      const dx = state.responder.position.x - state.player.position.x;
      const dz = state.responder.position.z - state.player.position.z;
      const desiredHeading = Math.atan2(dx, dz);
      const error = angleDifference(desiredHeading, state.player.heading);
      await setSteer(error > 0.22 ? 'd' : error < -0.22 ? 'a' : null);
      await page.waitForTimeout(90);
    }
    const state = await page.evaluate((id) => {
      const sim = window.__SF_SIM__;
      const chase = sim?.traffic?.getPursuitChaseDiagnostics?.();
      return {
        player: sim?.traffic?.getPlayerVehicleState?.() ?? null,
        responder: chase?.responders?.find((entry) => entry.id === id) ?? null,
        heat: sim?.getStreetHeatState?.() ?? null,
        chase,
      };
    }, responderId);
    return {
      ready: state.heat?.responderContacts >= minimumContacts,
      state,
    };
  } finally {
    await setSteer(null);
    await page.keyboard.up('w').catch(() => {});
  }
}

function analyzeSamples(recorded, initialResponderIds) {
  const active = recorded.filter((sample) => sample.heat?.pursuitActive && sample.chase?.active);
  const decisionMap = new Map();
  const roadTransitions = [];
  const teleportViolations = [];
  const identityViolations = [];
  const illegalRoutes = [];
  const duplicateDecisionViolations = [];
  let previousPlayerRoad = null;
  let previousPlayerRoute = null;
  let previousIds = null;
  let previousLevel = null;
  let previousDecisionCount = null;
  let previousDecisionKey = null;
  const previousResponder = new Map();
  let minimumDistance = Infinity;
  let maximumDistance = 0;

  for (const sample of recorded) {
    const playerRoad = sample.player?.road;
    if (Number.isInteger(playerRoad)
      && Number.isInteger(previousPlayerRoad)
      && playerRoad !== previousPlayerRoad) {
      roadTransitions.push({
        at: sample.at,
        fromRoad: previousPlayerRoad,
        toRoad: playerRoad,
        plannedRoad: previousPlayerRoute?.targetRoad ?? null,
        plannedDir: previousPlayerRoute?.targetDir ?? null,
        inTurn: previousPlayerRoute?.inTurn === true,
      });
    }
    if (Number.isInteger(playerRoad)) previousPlayerRoad = playerRoad;
    previousPlayerRoute = sample.playerRoute;
    if (!sample.heat?.pursuitActive || !sample.chase?.active) continue;

    const decision = sample.chase.lastDecision;
    const decisionCount = Number(sample.chase.routeDecisions);
    const decisionKey = Number.isInteger(decision?.vehicleId) && Number.isInteger(decision?.revision)
      ? `${decision.vehicleId}:${decision.revision}`
      : null;
    if (finite(decisionCount) && finite(previousDecisionCount)) {
      if (decisionCount < previousDecisionCount) {
        duplicateDecisionViolations.push({
          at: sample.at,
          reason: 'counter-regressed',
          previousDecisionCount,
          decisionCount,
        });
      } else if (decisionCount > previousDecisionCount && decisionKey === previousDecisionKey) {
        duplicateDecisionViolations.push({
          at: sample.at,
          reason: 'counter-incremented-without-new-revision',
          previousDecisionCount,
          decisionCount,
          decisionKey,
        });
      }
    }
    if (Number.isInteger(decision?.vehicleId) && Number.isInteger(decision?.revision)) {
      decisionMap.set(decisionKey, decision);
    }
    if (finite(decisionCount)) previousDecisionCount = decisionCount;
    if (decisionKey) previousDecisionKey = decisionKey;
    const ids = sample.chase.responders.map((responder) => responder.id).sort((a, b) => a - b);
    const level = sample.chase.level;
    if (previousIds) {
      const expectedStable = level === previousLevel
        ? previousIds.every((id) => ids.includes(id)) && ids.every((id) => previousIds.includes(id))
        : level > previousLevel
          ? previousIds.every((id) => ids.includes(id))
          : ids.every((id) => previousIds.includes(id));
      if (!expectedStable) identityViolations.push({ at: sample.at, previousLevel, level, previousIds, ids });
    }
    if (!initialResponderIds.every((id) => ids.includes(id))) {
      identityViolations.push({ at: sample.at, reason: 'initial-responder-lost', ids });
    }
    previousIds = ids;
    previousLevel = level;

    for (const responder of sample.chase.responders) {
      if (responder.route && responder.routeLegal !== true) {
        illegalRoutes.push({ at: sample.at, responder });
      }
      minimumDistance = Math.min(minimumDistance, Number(responder.targetDistance));
      maximumDistance = Math.max(maximumDistance, Number(responder.targetDistance));
      const prior = previousResponder.get(responder.id);
      if (prior) {
        const dt = Math.max(0.001, (sample.at - prior.at) / 1000);
        const displacement = Math.hypot(
          responder.position.x - prior.position.x,
          responder.position.z - prior.position.z,
        );
        const speed = Math.max(Number(prior.speed) || 0, Number(responder.speed) || 0);
        const allowed = Math.max(0.75, speed * dt * 2.5 + 0.35);
        if (displacement > allowed) {
          teleportViolations.push({
            id: responder.id,
            at: sample.at,
            dt,
            speed,
            displacement,
            allowed,
            from: prior.position,
            to: responder.position,
          });
        }
      }
      previousResponder.set(responder.id, {
        at: sample.at,
        speed: responder.speed,
        position: responder.position,
      });
    }
  }

  return {
    activeSampleCount: active.length,
    decisions: [...decisionMap.values()],
    roadTransitions,
    teleportViolations,
    identityViolations,
    illegalRoutes,
    duplicateDecisionViolations,
    distinctDecisionRoads: [...new Set(
      [...decisionMap.values()].map((decision) => `${decision.fromRoad}:${decision.toRoad}`),
    )],
    minimumDistance: finite(minimumDistance) ? minimumDistance : null,
    maximumDistance: finite(maximumDistance) ? maximumDistance : null,
  };
}

try {
  const negativePage = await browser.newPage({ viewport });
  watchPageDiagnostics(negativePage);
  try {
    await launch(negativePage);
    isolatedSurrenderNegative = await verifyIsolatedSurrenderLatchNegative(negativePage);
  } finally {
    await negativePage.close();
  }
  assert(isolatedSurrenderNegative?.passed === true,
    'isolated surrender latch did not cancel fail-closed at 100m',
    isolatedSurrenderNegative);
  if (!isolatedSurrenderNegative?.passed) {
    throw new Error('isolated surrender latch negative failed');
  }

  await launch();
  renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string'
    && /apple.*metal|metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe|angle \(.*(swiftshader|software))/i.test(renderer),
  'a verified Apple Metal hardware renderer was required; software rendering is rejected', {
    angle,
    renderer,
  });

  staging = await prepareDeterministicRoadStart();
  assert(staging?.qaEntered === true
    && staging?.imported?.ok === true
    && Number.isInteger(staging?.finalized?.vehicleId)
    && staging.finalized.signal?.phase === 'red'
    && staging.finalized.signal?.remaining >= 7,
  'deterministic private-car/red-signal staging failed before measurement', staging);
  if (!Number.isInteger(staging?.finalized?.vehicleId)) throw new Error('pursuit chase staging failed');

  const initialWorld = await waitForWorldSettled();
  const initial = initialWorld.evidence;
  assert(initial.driving === false
    && initial.heat?.heat === 0
    && initial.heat?.pursuitActive === false
    && initial.chase?.active === false,
  'measured phase did not start on foot with clear StreetHeat', summarizeEvidence(initial));
  const resourceBaseline = initial.resources;
  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await startRecorder();

  // From this point through surrender, every gameplay mutation comes from
  // physical keyboard input. There are no direct heat, pursuit, pose, route,
  // responder, vehicle-state, or clock calls in the measured phase.
  await page.locator('#scene-canvas').focus();
  await page.keyboard.press('e');
  await page.waitForFunction((vehicleId) => {
    const sim = window.__SF_SIM__;
    return sim?.isDriving?.() === true
      && sim?.traffic?.getPlayerVehicleState?.()?.index === vehicleId;
  }, staging.finalized.vehicleId, { timeout: 4000, polling: 20 });
  const entered = await readEvidence();
  assert(entered.player?.index === staging.finalized.vehicleId
    && entered.player?.theft?.reported === true
    && entered.heat?.heat === 18
    && entered.heat?.pursuitActive === false
    && entered.diagnostics?.vehicleThefts === staging.finalized.baseline.thefts + 1,
  'real E did not produce exactly one normal vehicle-theft incident before pursuit', summarizeEvidence(entered));

  const firstTurn = await crossPreparedRedTurn(staging.finalized.baseline.citations);
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim?.getStreetHeatState?.()?.pursuitActive === true
      && sim?.traffic?.getPursuitChaseDiagnostics?.()?.active === true
      && sim?.traffic?.getPursuitChaseDiagnostics?.()?.responders?.length > 0;
  }, null, { timeout: 10000, polling: 20 });
  const pursuitStart = await readEvidence();
  const initialResponderIds = pursuitStart.chase.responders.map((responder) => responder.id).sort((a, b) => a - b);
  assert(firstTurn.after.diagnostics?.playerRedLightViolations
      === staging.finalized.baseline.citations + 1
    && firstTurn.after.citation?.heatAdded === 12
    && firstTurn.after.citation?.turnSide !== 0
    && firstTurn.after.player?.road !== firstTurn.before.player?.road
    && Math.abs(angleDifference(
      firstTurn.after.player?.heading,
      firstTurn.before.player?.heading,
    )) >= 0.35
    && firstTurn.after.citation?.heatBefore >= 17
    && firstTurn.after.citation?.heatBefore <= 18
    && firstTurn.after.citation?.heatAfter
      === firstTurn.after.citation?.heatBefore + firstTurn.after.citation?.heatAdded
    && pursuitStart.heat?.pursuitActive === true
    && initialResponderIds.length === pursuitStart.heat?.level,
  'real W+A red turn did not start the normal 18+12 StreetHeat pursuit', {
    firstTurn: summarizeEvidence(firstTurn.after),
    pursuitStart: summarizeEvidence(pursuitStart),
  });

  await page.waitForTimeout(180);
  const beforeSecondTurn = await readEvidence();
  const secondTurn = await driveThroughTurn('d', beforeSecondTurn);
  assert(secondTurn.player?.road !== beforeSecondTurn.player?.road
    && Math.abs(angleDifference(secondTurn.player?.heading, beforeSecondTurn.player?.heading)) >= 0.35,
  'real W+D did not complete a second graph-routed player turn', {
    before: beforeSecondTurn.player,
    after: secondTurn.player,
  });
  // Read-only responder bearing guides physical W/A/D input to the first
  // contact. This proves the marked actor is reachable without posing either
  // vehicle; the post-rearm contact below is separately responder-owned.
  const firstContactAttempt = await driveTowardResponderUntilContact(initialResponderIds[0]);
  const firstContact = await readEvidence();
  assert(firstContactAttempt.ready
    && firstContact.heat?.responderContacts === 1
    && firstContact.heatPersisted?.responderContactLatched === true
    && firstContact.player?.damage?.lastDamage?.source === 'pursuit-contact'
    && firstContact.chase?.responders?.every((responder) => (
      responder.route == null || responder.routeLegal === true
    )),
  'real W/A/D could not reach one stable live responder for initial contact', {
    attempt: firstContactAttempt,
    evidence: summarizeEvidence(firstContact),
  });
  if (!firstContactAttempt.ready) throw new Error('initial live responder contact failed');
  assert(firstContact.chase?.routeDecisions >= 1,
    'active pursuit capture requires a target-aware route decision',
    summarizeEvidence(firstContact));
  await page.screenshot({ path: captures.activeRouting });

  // Real throttle/steer creates a full >=8.5m separation. This must re-arm the
  // global contact latch without replacing the initial responder.
  await page.keyboard.down('w');
  await page.keyboard.down('a');
  const rearmed = await page.waitForFunction((ids) => {
    const sim = window.__SF_SIM__;
    const heat = sim?.getStreetHeatState?.();
    const chase = sim?.traffic?.getPursuitChaseDiagnostics?.();
    return heat?.pursuitActive === true
      && sim?.streetHeat?.exportState?.()?.responderContactLatched === false
      && heat.responderDistances.length > 0
      && Math.min(...heat.responderDistances) >= 8.5
      && ids.every((id) => chase?.responders?.some((responder) => responder.id === id));
  }, initialResponderIds, { timeout: 18000, polling: 20 }).then(() => true).catch(() => false);
  await page.keyboard.up('a');
  const separated = await readEvidence();
  assert(rearmed
    && separated.heatPersisted?.responderContactLatched === false
    && Math.min(...(separated.heat?.responderDistances ?? [0])) >= 8.5,
  'real W+A separation did not re-arm pursuit contact beyond 8.5m', summarizeEvidence(separated));
  if (!rearmed) throw new Error('pursuit contact rearm failed');

  // After separation, real W/A/D closes on the retained responder again. This
  // keeps the normal getaway clock active while proving a second physical
  // contact without posing either vehicle or mutating the chase.
  await page.keyboard.up('w');
  const secondContactAttempt = await driveTowardResponderUntilContact(
    initialResponderIds[0],
    2,
  );
  const secondContact = await readEvidence();
  assert(secondContactAttempt.ready
    && secondContact.heat?.responderContacts === 2
    && secondContact.heatPersisted?.responderContactLatched === true
    && secondContact.player?.damage?.lastDamage?.source === 'pursuit-contact',
  'the same routed pursuit did not re-contact after full separation', summarizeEvidence(secondContact));
  if (!secondContactAttempt.ready) throw new Error('routed responder recontact failed');
  await page.screenshot({ path: captures.secondContact });

  await page.keyboard.down('s');
  const surrendered = await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim?.getStreetHeatState?.()?.arrests === 1
      && sim?.getStreetHeatState?.()?.pursuitActive === false
      && sim?.isDriving?.() === false;
  }, null, { timeout: 9000, polling: 20 }).then(() => true).catch(() => false);
  await page.keyboard.up('s');
  const cleared = await readEvidence();
  assert(surrendered
    && cleared.heat?.heat === 0
    && cleared.heat?.pursuitActive === false
    && cleared.chase?.active === false
    && cleared.chase?.responders?.length === 0
    && cleared.driving === false,
  'real S surrender did not atomically clear pursuit, responders, and driving', summarizeEvidence(cleared));
  await page.screenshot({ path: captures.arrestedCleared });

  await page.waitForFunction(() => (
    (window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0) >= 180
  ), null, { timeout: 12000, polling: 50 });
  await page.waitForTimeout(600);
  performanceSnapshot = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.() ?? null);
  samples = await stopRecorder();
  const analysis = analyzeSamples(samples, initialResponderIds);
  const postClearWorld = await waitForWorldSettled();
  const resourceFinal = postClearWorld.evidence.resources;
  await page.waitForTimeout(1200);
  const resourceStable = (await readEvidence()).resources;

  assert(analysis.roadTransitions.length >= 2
    && analysis.roadTransitions.slice(0, 2).every((turn) => (
      Number.isInteger(turn.toRoad)
      && turn.plannedRoad === turn.toRoad
      && (turn.plannedDir === 1 || turn.plannedDir === -1)
    )),
  'RAF evidence did not retain two distinct graph road transitions', analysis.roadTransitions);
  assert(analysis.decisions.length >= 2
    && analysis.distinctDecisionRoads.length >= 2
    && analysis.decisions.some((decision) => initialResponderIds.includes(decision.vehicleId)),
  'two distinct revisioned pursuit road decisions were not observed', {
    decisions: analysis.decisions,
    distinctDecisionRoads: analysis.distinctDecisionRoads,
  });
  assert(analysis.duplicateDecisionViolations.length === 0,
    'pursuit routing duplicated a decision without advancing its revision',
    analysis.duplicateDecisionViolations);
  assert(analysis.illegalRoutes.length === 0,
    'a responder exposed a route that failed the authoritative legality check', analysis.illegalRoutes);
  assert(analysis.identityViolations.length === 0,
    'pursuit responder identity churned without a matching level transition', analysis.identityViolations);
  assert(analysis.teleportViolations.length === 0,
    'a responder moved farther than its speed/frame envelope permits', analysis.teleportViolations);
  assert(finite(analysis.minimumDistance)
    && finite(analysis.maximumDistance)
    && analysis.maximumDistance >= 8.5
    && analysis.minimumDistance <= 5.5,
  'recorded responder distances did not prove separation and physical re-contact', analysis);
  assert(initialWorld.settled
    && postClearWorld.settled
    && finite(resourceBaseline.geometries)
    && finite(resourceBaseline.textures)
    && resourceStable.geometries === resourceFinal.geometries
    && resourceStable.textures === resourceFinal.textures,
  'world did not settle or renderer resources kept growing after pursuit teardown', {
    baseline: resourceBaseline,
    final: resourceFinal,
    stable: resourceStable,
    initialWorldSettled: initialWorld.settled,
    postClearWorldSettled: postClearWorld.settled,
  });
  assert(performanceSnapshot?.applicationFrameCount >= 180
    && finite(performanceSnapshot?.applicationP99FrameMs)
    && performanceSnapshot.applicationP99FrameMs <= 16.67,
  'pursuit chase exceeded the 16.67ms application p99 budget', performanceSnapshot);
  assert(consoleErrors.length === 0, 'page/console errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestErrors.length === 0, 'request failures occurred', requestErrors);

  const report = {
    result: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestErrors.length === 0
      ? 'pursuit chase gate passed'
      : 'pursuit chase gate failed',
    baseUrl,
    angle,
    renderer,
    viewport,
    captures,
    isolatedSurrenderNegative,
    contract: {
      measuredInputs: 'real E + real W+A red turn + real W+D turn + real W/A separation + real S surrender',
      directMeasuredHeatOrPursuitMutation: false,
      contactRadius: 5.5,
      rearmRadius: 8.5,
      minimumApplicationFrames: 180,
      applicationP99FrameMs: 16.67,
    },
    staging,
    measured: {
      initial: summarizeEvidence(initial),
      entered: summarizeEvidence(entered),
      firstTurn: summarizeEvidence(firstTurn.after),
      pursuitStart: summarizeEvidence(pursuitStart),
      secondTurn: summarizeEvidence(secondTurn),
      firstContact: summarizeEvidence(firstContact),
      separated: summarizeEvidence(separated),
      secondContact: summarizeEvidence(secondContact),
      cleared: summarizeEvidence(cleared),
    },
    analysis,
    resources: {
      baseline: resourceBaseline,
      final: resourceFinal,
      stable: resourceStable,
      initialWorldSettled: initialWorld.settled,
      postClearWorldSettled: postClearWorld.settled,
    },
    performance: performanceSnapshot,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'pursuit chase gate passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'pursuit chase gate failed',
    error: error.message,
    stack: error.stack,
    renderer,
    staging,
    isolatedSurrenderNegative,
    sampleCount: samples.length,
    performance: performanceSnapshot,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await page.keyboard.up('a').catch(() => {});
  await page.keyboard.up('d').catch(() => {});
  await page.keyboard.up('s').catch(() => {});
  await page.keyboard.up('w').catch(() => {});
  await page.evaluate(() => {
    const recorder = window.__SF_PURSUIT_CHASE_RECORDER__;
    if (recorder) recorder.active = false;
  }).catch(() => {});
  await browser.close();
}
