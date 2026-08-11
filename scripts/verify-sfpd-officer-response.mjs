import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const captureDir = process.env.SF_QA_CAPTURE_DIR || '.qa-sfpd-officer-response';

if (process.platform !== 'darwin') {
  throw new Error('verify-sfpd-officer-response requires macOS and an Apple Metal GPU.');
}
if (angle !== 'metal') {
  throw new Error(`verify-sfpd-officer-response requires SF_QA_ANGLE=metal, received ${angle}`);
}
if (!executablePath) {
  throw new Error(`System Chrome is required for the Apple Metal gate: ${systemChrome}`);
}

await mkdir(captureDir, { recursive: true });
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestFailures = [];
const captures = {
  organicDeploy: join(captureDir, 'organic-deploy.png'),
  exposed: join(captureDir, 'exposed.png'),
  blocked: join(captureDir, 'blocked.png'),
  downed: join(captureDir, 'downed.png'),
  cleared: join(captureDir, 'cleared.png'),
};

const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};
const ids = (snapshot) => (Array.isArray(snapshot?.officers) ? snapshot.officers : [])
  .map((officer) => officer.id).sort();
const finite = (value) => Number.isFinite(value);
const sameIds = (left, right) => JSON.stringify(left) === JSON.stringify(right);

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
    requestFailures.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  }
});

async function launch() {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.clear());
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function snapshot() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const qa = sim?.getSfpdOfficerQa?.() || sim?.sfpdOfficerQa;
    if (!qa || typeof qa.snapshot !== 'function') {
      return { contractError: 'window.__SF_SIM__.getSfpdOfficerQa().snapshot() is required' };
    }
    return qa.snapshot();
  });
}

async function stage(scenario) {
  const result = await page.evaluate(async (requestedScenario) => {
    const sim = window.__SF_SIM__;
    const qa = sim?.getSfpdOfficerQa?.() || sim?.sfpdOfficerQa;
    if (!qa || typeof qa.stage !== 'function' || typeof qa.snapshot !== 'function') {
      return { contractError: 'window.__SF_SIM__.getSfpdOfficerQa() must expose stage() and snapshot()' };
    }
    return qa.stage(requestedScenario);
  }, scenario);
  assert(!result?.contractError && result?.ready === true && result?.syntheticEvents === 0,
    `QA stage ${scenario.kind} must be ready and synthetic-event free`, { scenario, result });
  return result;
}

async function waitFor(predicate, arg, message, timeout = 7000) {
  try {
    await page.waitForFunction(({ test, value }) => {
      const sim = window.__SF_SIM__;
      const qa = sim?.getSfpdOfficerQa?.() || sim?.sfpdOfficerQa;
      return Boolean(qa?.snapshot && window.__SFPD_OFFICER_QA_PREDICATES__?.[test]?.(qa.snapshot(), value));
    }, { test: predicate, value: arg }, { timeout, polling: 25 });
    return true;
  } catch {
    assert(false, message, await snapshot());
    return false;
  }
}

async function installPredicates() {
  await page.evaluate(() => {
    window.__SFPD_OFFICER_QA_PREDICATES__ = {
      heat: (state, expected) => state?.heat?.level === expected
        && state?.heat?.responderCount === expected
        && state?.officers?.filter((officer) => officer.visible && officer.live).length === expected,
      damage: (state, expected) => (state?.events?.damage?.length || 0) === expected,
      downed: (state, officerId) => state?.officers?.some((officer) => officer.id === officerId
        && officer.state === 'downed' && officer.live === false),
      anyDowned: (state) => state?.officers?.some((officer) => officer.state === 'downed'
        && officer.live === false && officer.defeated === true),
      booking: (state, expected) => state?.events?.bookings === expected,
      aim: (state, expected) => (state?.events?.aims || 0) >= expected,
      blockedCycles: (state, expected) => state?.blocker?.solid === true
        && state.blocker.cycles >= expected,
      cleared: (state) => state?.cleared === true && state?.officers?.length === 0
        && state?.heat?.responderCount === 0,
    };
  });
}

async function captureHudFree(path, minLowerEdgeFraction = 0.01) {
  // Let the regular renderer consume the staged camera pose before recording
  // evidence; an immediate capture can otherwise catch a cleared compositor.
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'sfpd-officer-qa-hud-free-capture';
    style.textContent = '.hud, #hud, .hud__message, .hud__crosshair { visibility: hidden !important; }';
    document.head.append(style);
  });
  const png = await page.screenshot({ path });
  await page.evaluate(() => document.querySelector('#sfpd-officer-qa-hud-free-capture')?.remove());
  const pixels = await page.evaluate(async (base64) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('captured PNG decode timed out')), 2500);
    const image = new Image();
    image.onload = () => {
      clearTimeout(timeout);
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, Math.floor(image.height * 0.5), image.width,
        Math.ceil(image.height * 0.5)).data;
      let edgePixels = 0;
      let samples = 0;
      for (let y = 2; y < image.height * 0.5 - 2; y += 4) {
        for (let x = 2; x < image.width - 2; x += 4) {
          const index = (y * image.width + x) * 4;
          const next = index + 16;
          const luma = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
          const adjacent = data[next] * 0.2126 + data[next + 1] * 0.7152 + data[next + 2] * 0.0722;
          samples += 1;
          if (Math.abs(luma - adjacent) >= 18) edgePixels += 1;
        }
      }
      resolve({ lowerEdgeFraction: samples ? edgePixels / samples : 0, samples });
    };
    image.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('could not decode captured PNG'));
    };
    image.src = `data:image/png;base64,${base64}`;
  }), png.toString('base64'));
  assert(pixels.lowerEdgeFraction >= minLowerEdgeFraction,
    'HUD-free evidence frame was visually empty or sky-only', {
      path,
      minLowerEdgeFraction,
      pixels,
    });
  return pixels;
}

async function frameOfficersOnRoad(label, { requireParent = false, maxOfficers = 2 } = {}) {
  const composition = await page.evaluate(({ frameLabel, needsParent, limit }) => {
    const sim = window.__SF_SIM__;
    const qa = sim.getSfpdOfficerQa?.() || sim.sfpdOfficerQa;
    const state = qa?.snapshot?.();
    let officers = (state?.officers || []).filter((officer) => officer.live && officer.visible);
    if (needsParent) {
      officers = officers.filter((officer) => {
        const root = sim.traffic?.group?.children?.[officer.parentVehicleId];
        const position = root?.getWorldPosition?.(new root.position.constructor());
        const kit = root?.children?.find((child) => child.name === 'SFPD pursuit response kit');
        return root?.userData?.pursuitResponder === true && kit?.visible === true
          && position && Math.hypot(position.x - officer.position.x, position.z - officer.position.z) <= 12;
      });
    }
    officers = officers.slice(0, limit);
    if (!officers.length || !sim.camera || typeof sim.setCameraPose !== 'function') return null;
    const surfaceAt = (position) => {
      const city = sim.city?.getSurfaceHeight?.(position);
      if (Number.isFinite(city)) return city;
      const streamed = sim.streaming?.getSurfaceHeight?.(position);
      return Number.isFinite(streamed) ? streamed : null;
    };
    const player = sim.getRoamState?.().target;
    if (!player) return null;
    const officerCenter = officers.reduce((result, officer) => ({
      x: result.x + officer.position.x / officers.length,
      y: result.y + officer.position.y / officers.length,
      z: result.z + officer.position.z / officers.length,
    }), { x: 0, y: 0, z: 0 });
    const pairedRoots = needsParent ? officers.map((officer) => {
      const root = sim.traffic?.group?.children?.[officer.parentVehicleId];
      return root?.getWorldPosition?.(new root.position.constructor()) || null;
    }).filter(Boolean) : [];
    const center = pairedRoots.length === officers.length
      ? pairedRoots.reduce((result, position) => ({
        x: result.x + position.x / (officers.length * 2),
        y: result.y + position.y / (officers.length * 2),
        z: result.z + position.z / (officers.length * 2),
      }), {
        x: officerCenter.x * 0.5,
        y: officerCenter.y * 0.5,
        z: officerCenter.z * 0.5,
      })
      : officerCenter;
    const fromPlayerX = center.x - player.x;
    const fromPlayerZ = center.z - player.z;
    const distance = Math.hypot(fromPlayerX, fromPlayerZ) || 1;
    const retreat = needsParent
      ? Math.min(20, Math.max(14, distance * 0.78))
      : Math.min(10, Math.max(6.5, distance * 0.52));
    const cameraFoot = {
      x: center.x - (fromPlayerX / distance) * retreat,
      z: center.z - (fromPlayerZ / distance) * retreat,
    };
    const cameraSurface = surfaceAt(cameraFoot);
    const centerSurface = surfaceAt(center);
    if (!Number.isFinite(cameraSurface) || !Number.isFinite(centerSurface)) return null;
    const cameraPosition = { x: cameraFoot.x, y: cameraSurface + 1.72, z: cameraFoot.z };
    const lookAt = { x: center.x, y: centerSurface + 0.78, z: center.z };
    sim.setCameraPose(cameraPosition, lookAt);
    sim.camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    sim.camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    sim.camera.updateMatrixWorld(true);
    const project = (point) => {
      const projected = new sim.camera.position.constructor(point.x, point.y, point.z)
        .project(sim.camera);
      return { x: (projected.x + 1) * 0.5, y: (1 - projected.y) * 0.5, z: projected.z };
    };
    const feet = officers.map((officer) => project(officer.position));
    const torsos = officers.map((officer) => project({
      x: officer.position.x, y: officer.position.y + 0.95, z: officer.position.z,
    }));
    const parents = officers.map((officer) => {
      const root = sim.traffic?.group?.children?.[officer.parentVehicleId] || null;
      const position = root?.getWorldPosition?.(new root.position.constructor());
      const kit = root?.children?.find((child) => child.name === 'SFPD pursuit response kit');
      return {
        officerId: officer.id,
        parentVehicleId: officer.parentVehicleId,
        actual: Boolean(root && position),
        pursuit: root?.userData?.pursuitResponder === true,
        kitVisible: kit?.visible === true,
        distance: position ? Math.hypot(position.x - officer.position.x, position.z - officer.position.z) : null,
        projection: position ? project(position) : null,
      };
    });
    return {
      label: frameLabel,
      cameraPosition,
      lookAt,
      cameraSurface,
      clearance: cameraPosition.y - cameraSurface,
      feet,
      torsos,
      parents,
    };
  }, { frameLabel: label, needsParent: requireParent, limit: maxOfficers });
  assert(composition && finite(composition.clearance) && composition.clearance >= 1.45
    && composition.clearance <= 2.1
    && composition.feet.every((foot, index) => foot.x >= 0.06 && foot.x <= 0.94
      && foot.y >= 0.48 && foot.y <= 0.92 && foot.z >= -1 && foot.z <= 1
      && composition.torsos[index].y < foot.y)
    && (!requireParent || composition.parents.every((parent) => parent.actual && parent.pursuit && parent.kitVisible
      && finite(parent.distance) && parent.distance <= 12
      && parent.projection.x >= 0.02 && parent.projection.x <= 0.98
      && parent.projection.y >= 0.02 && parent.projection.y <= 0.98
      && parent.projection.z >= -1 && parent.projection.z <= 1)),
  `${label} camera did not frame officer feet contacting the road in the lower image`, composition);
  return composition;
}

async function findNonFlatGrade() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const surfaceAt = (position) => {
      const city = sim.city?.getSurfaceHeight?.(position);
      if (Number.isFinite(city)) return { height: city, source: 'city' };
      const streaming = sim.streaming?.getSurfaceHeight?.(position);
      return Number.isFinite(streaming) ? { height: streaming, source: 'streaming' } : null;
    };
    const seeds = [sim.getRoamState?.().target, ...(sim.getStreamingEvidenceStops?.() || [])
      .map((stop) => stop.lookAt || stop.position)].filter(Boolean);
    const offsets = [-24, -12, 0, 12, 24];
    const candidates = [];
    for (const seed of seeds) {
      for (const dx of offsets) {
        for (const dz of offsets) {
          const position = { x: seed.x + dx, z: seed.z + dz };
          const center = surfaceAt(position);
          const east = surfaceAt({ x: position.x + 8, z: position.z });
          const north = surfaceAt({ x: position.x, z: position.z + 8 });
          if (!center || !east || !north) continue;
          candidates.push({
            position,
            surface: center,
            gradeSpan: Math.max(Math.abs(east.height - center.height), Math.abs(north.height - center.height)),
          });
        }
      }
    }
    candidates.sort((left, right) => right.gradeSpan - left.gradeSpan);
    return candidates[0] || null;
  });
}

async function verifyAuthoritativeGround(state, label, grade = null) {
  const liveOfficers = Array.isArray(state?.officers)
    ? state.officers.filter((officer) => officer.live && officer.visible) : [];
  const samples = await page.evaluate((officers) => {
    const sim = window.__SF_SIM__;
    return officers.map((officer) => {
      const position = officer.position;
      const city = sim.city?.getSurfaceHeight?.({ x: position.x, z: position.z });
      const streaming = sim.streaming?.getSurfaceHeight?.({ x: position.x, z: position.z });
      const surface = Number.isFinite(city) ? city : streaming;
      let footY = Infinity;
      let meshCount = 0;
      sim.scene?.traverse?.((object) => {
        if (object?.userData?.sfpdOfficerId !== officer.id || !object.traverse) return;
        object.updateMatrixWorld?.(true);
        object.traverse((mesh) => {
          mesh?.geometry?.computeBoundingBox?.();
          const box = mesh?.geometry?.boundingBox;
          if (!mesh?.isMesh || !box?.min || !box?.max) return;
          meshCount += 1;
          for (const x of [box.min.x, box.max.x]) {
            for (const y of [box.min.y, box.max.y]) {
              for (const z of [box.min.z, box.max.z]) {
                const vertex = new mesh.position.constructor(x, y, z).applyMatrix4(mesh.matrixWorld);
                footY = Math.min(footY, vertex.y);
              }
            }
          }
        });
      });
      return {
        id: officer.id,
        rootY: position.y,
        citySurface: Number.isFinite(city) ? city : null,
        streamingSurface: Number.isFinite(streaming) ? streaming : null,
        surface: Number.isFinite(surface) ? surface : null,
        delta: Number.isFinite(surface) ? Math.abs(position.y - surface) : null,
        footY: Number.isFinite(footY) ? footY : null,
        footDelta: Number.isFinite(surface) && Number.isFinite(footY)
          ? Math.abs(footY - surface) : null,
        meshCount,
      };
    });
  }, liveOfficers);
  assert(liveOfficers.length > 0 && samples.every((sample) => finite(sample.surface)
    && finite(sample.delta) && sample.delta <= 0.03
    && sample.meshCount > 0 && finite(sample.footDelta) && sample.footDelta <= 0.03),
  `${label} officer roots or rendered feet were not grounded to authoritative city/streaming surface heights`, { grade, samples });
  if (grade) {
    assert(finite(grade.gradeSpan) && grade.gradeSpan >= 0.08,
      'direct officer deployment did not use a verifiably non-flat terrain sample', grade);
  }
  return samples;
}

async function aimAndFire() {
  await page.locator('canvas').focus();
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.().aiming === true,
    null, { timeout: 3000 });
  await page.mouse.click(640, 360, { button: 'left' });
  await page.mouse.up({ button: 'right' });
}

async function assertStableLevel(level) {
  await waitFor('heat', level, `Heat ${level} did not expose exactly ${level} live visible officers`);
  const first = await snapshot();
  await page.waitForTimeout(450);
  const second = await snapshot();
  if (!Array.isArray(first.officers) || !Array.isArray(second.officers)) {
    assert(false, `Heat ${level} snapshot did not expose the required officers array`, { first, second });
    return second;
  }
  assert(sameIds(ids(first), ids(second)) && ids(first).length === level,
    `Heat ${level} officer IDs were not stable`, { first, second });
  assert(first.officers.every((officer) => officer.live && officer.visible
    && Number.isInteger(officer.parentVehicleId)
    && officer.deploy?.state === 'deployed'
    && finite(officer.deploy?.vehicleSpeed) && officer.deploy.vehicleSpeed <= 2
    && finite(officer.deploy?.distance) && officer.deploy.distance <= 15
    && finite(officer.deploy?.exitClearance) && officer.deploy.exitClearance >= 0.05
    && officer.deploy?.bodyVehicleOverlap === false
    && officer.morphology?.human === true
    && officer.morphology?.uniform === true
    && officer.morphology?.badge === true
    && officer.morphology?.belt === true
    && officer.morphology?.weapon === true
    && officer.morphology?.grounded === true),
  `Heat ${level} officer vehicle handoff, morphology, or grounding contract failed`, first);
  assert(first.officers.every((officer) => finite(officer.surfaceDelta)
    && Math.abs(officer.surfaceDelta) <= 0.03
    && first.vehicles?.some((vehicle) => vehicle.id === officer.parentVehicleId
      && vehicle.pursuit === true && vehicle.lightsOn === true)),
  `Heat ${level} officers were not paired to a live lit SFPD responder vehicle`, first);
  await verifyAuthoritativeGround(first, `Heat ${level}`);
  return second;
}

function resourceVector(state) {
  const resource = state.resources || {};
  return {
    officerActors: resource.officerActors,
    activeTimers: resource.activeTimers,
    activeListeners: resource.activeListeners,
    activeProjectiles: resource.activeProjectiles,
  };
}

function sameResources(left, right) {
  return Object.keys(left).every((key) => finite(left[key]) && left[key] === right[key]);
}

try {
  await launch();
  await installPredicates();
  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string'
    && /apple.*metal|metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe)/i.test(renderer),
  'a verified Apple Metal hardware renderer was required; software rendering is rejected', { angle, renderer });

  // This is deliberately not a QA scenario. It proves that ordinary StreetHeat
  // escalation can recruit, settle, and deploy an officer before any staging.
  const directGrade = await findNonFlatGrade();
  assert(directGrade?.position && directGrade?.gradeSpan >= 0.08,
    'could not find a non-flat authoritative terrain sample for direct officer deployment', directGrade);
  if (!directGrade?.position) throw new Error('non-flat terrain sample unavailable for direct officer deployment');
  await page.evaluate((grade) => {
    const sim = window.__SF_SIM__;
    sim.streetHeat?.restart?.();
    sim.restartCombat?.();
    sim.streetHeat?.reportIncident?.(96, {
      kind: 'direct-officer-deployment-proof',
      source: 'combat',
      notify: false,
    });
  }, directGrade);
  const directDeployTrace = [];
  for (let tick = 0; tick < 100; tick += 1) {
    const current = await snapshot();
    directDeployTrace.push(current);
    if (current.officers?.some((officer) => officer.deploy?.state === 'deployed')
      && directDeployTrace.some((state) => state.officers?.some((officer) => (
        officer.deploy?.state === 'waiting-for-stop' || officer.deploy?.state === 'exiting'
      )))) break;
    await page.waitForTimeout(120);
  }
  const directDeployment = [...directDeployTrace].reverse().find((state) => (
    state.officers?.some((officer) => officer.live && officer.visible
      && officer.deploy?.state === 'deployed')
  )) || directDeployTrace.at(-1);
  assert(directDeployTrace.some((state) => state.heat?.level >= 2)
    && directDeployTrace.some((state) => state.officers?.some((officer) => (
    officer.deploy?.state === 'waiting-for-stop' || officer.deploy?.state === 'exiting'
  ))) && directDeployment?.officers?.some((officer) => (
    officer.live && officer.visible && officer.deploy?.state === 'deployed'
  )), 'direct StreetHeat responders did not visibly settle and deploy from their vehicles', directDeployTrace);
  const directGroundSamples = await verifyAuthoritativeGround(
    directDeployment,
    'Direct StreetHeat deployment',
  );
  try {
    await page.waitForFunction(() => {
      const sim = window.__SF_SIM__;
      const qa = sim.getSfpdOfficerQa?.() || sim.sfpdOfficerQa;
      return (qa?.snapshot?.().officers || []).some((officer) => {
        if (!officer.live || !officer.visible) return false;
        const root = sim.traffic?.group?.children?.[officer.parentVehicleId];
        const position = root?.getWorldPosition?.(new root.position.constructor());
        const kit = root?.children?.find((child) => child.name === 'SFPD pursuit response kit');
        return root?.userData?.pursuitResponder === true && kit?.visible === true
          && position && Math.hypot(position.x - officer.position.x, position.z - officer.position.z) <= 12;
      });
    }, null, { timeout: 30000, polling: 50 });
  } catch {
    assert(false, 'unstaged StreetHeat never produced an actual nearby officer-parent SFPD pair',
      await snapshot());
  }
  const organicDeployComposition = await frameOfficersOnRoad('organic-deploy', {
    requireParent: true,
    maxOfficers: 1,
  });
  const organicDeployPixels = await captureHudFree(captures.organicDeploy);
  await page.evaluate(() => window.__SF_SIM__?.streetHeat?.restart?.());
  await waitFor('cleared', null, 'direct StreetHeat reset did not remove deployed officers');

  // From here deterministic staging is permitted. It is deliberately moved
  // onto a measured grade so its officer roots cannot pass on player-y alone.
  await page.evaluate((grade) => window.__SF_SIM__?.setRoamPose?.(grade.position), directGrade);

  await stage({ kind: 'heat', level: 2 });
  const heatTwo = await assertStableLevel(2);
  if (!Array.isArray(heatTwo.officers)) {
    throw new Error('SFPD officer QA telemetry contract is unavailable; refusing to measure unstaged gameplay.');
  }
  await stage({ kind: 'heat', level: 3 });
  const heatThree = await assertStableLevel(3);

  await stage({ kind: 'los' });
  const exposedComposition = await frameOfficersOnRoad('exposed');
  const losBefore = await snapshot();
  await waitFor('aim', (losBefore.events?.aims || 0) + 1,
    'an exposed officer did not telegraph its aim before firing');
  const aiming = await snapshot();
  assert(aiming.officers?.some((officer) => officer.aim?.telegraphActive === true
    && finite(officer.aim?.startedAt) && officer.aim?.weaponMuzzle === true),
  'exposed officer did not present a readable armed aim telegraph', { losBefore, aiming });
  await page.waitForTimeout(420);
  const telegraphHold = await snapshot();
  assert((telegraphHold.events?.damage?.length || 0) === (losBefore.events?.damage?.length || 0),
    'officer damaged the player before the required 0.4 s telegraph', { losBefore, aiming, telegraphHold });
  const exposedPixels = await captureHudFree(captures.exposed);
  await waitFor('damage', (losBefore.events?.damage?.length || 0) + 1,
    'an exposed officer did not produce exactly one damage event after telegraphing');
  const losAfter = await snapshot();
  const losDamage = losAfter.events?.damage?.at(-1);
  assert(losDamage?.source === 'officer' && losDamage?.los === true && losDamage?.blocked !== true,
    'officer damage did not follow an aimed, clear-LOS real shot', { losBefore, aiming, losAfter });

  await stage({ kind: 'blocked' });
  const blockedComposition = await frameOfficersOnRoad('blocked');
  const blockedBefore = await snapshot();
  await waitFor('blockedCycles', (blockedBefore.blocker?.cycles || 0) + 3,
    'blocked scenario did not complete three officer fire cycles', 10000);
  const blockedPixels = await captureHudFree(captures.blocked);
  const blockedAfter = await snapshot();
  assert(blockedAfter.blocker?.solid === true
    && blockedAfter.blocker?.cycles >= (blockedBefore.blocker?.cycles || 0) + 3
    && (blockedAfter.events?.damage?.length || 0) === (blockedBefore.events?.damage?.length || 0),
  'a solid city blocker did not prevent officer damage for three real-fire cycles', {
    blockedBefore,
    blockedAfter,
  });

  await stage({ kind: 'downed' });
  const downedComposition = await frameOfficersOnRoad('downed');
  const downedBefore = await snapshot();
  let downedPixels = null;
  const availableTarget = downedBefore.officers?.find((officer) => officer.live && officer.visible);
  assert(availableTarget?.id, 'downed scenario did not expose a live officer target', downedBefore);
  if (availableTarget?.id) {
    await aimAndFire();
    await waitFor('anyDowned', null, 'real RMB/LMB could not hit and down one officer');
    const downed = await snapshot();
    const target = downed.officers?.find((officer) => officer.state === 'downed'
      && officer.live === false && officer.defeated === true);
    assert(target?.id, 'player fire did not leave any officer in the required downed state', downed);
    // The downed pose makes the lower road band intentionally sparse; its
    // independent road/feet projection check above remains mandatory.
    downedPixels = await captureHudFree(captures.downed, 0.008);
    const firesAtDown = (downed.events?.officerFires || []).filter((event) => event.officerId === target?.id).length;
    await page.waitForTimeout(900);
    const downedStable = await snapshot();
    assert((downedStable.events?.officerFires || []).filter((event) => event.officerId === target?.id).length === firesAtDown,
      'a downed officer fired afterward', { target, downed, downedStable });
    const beforeTarget = downedBefore.officers?.find((officer) => officer.id === target?.id);
    assert(beforeTarget?.targetable === true
      && downed.officers?.some((officer) => officer.id === target?.id
        && officer.targetable === false && officer.defeated === true
        && officer.state === 'downed' && Math.abs(officer.surfaceDelta) <= 0.03),
    'a player-shot officer was not targetable before, or was not grounded/non-targetable after defeat', {
      beforeTarget,
      target,
      downed,
    });
  }

  await stage({ kind: 'surrender' });
  const surrenderBefore = await snapshot();
  await page.locator('canvas').focus();
  await page.keyboard.press('x');
  await waitFor('booking', (surrenderBefore.events?.bookings || 0) + 1,
    'real X did not book the player exactly once');
  await page.keyboard.press('x');
  await page.waitForTimeout(180);
  const surrendered = await snapshot();
  assert(surrendered.events?.bookings === (surrenderBefore.events?.bookings || 0) + 1,
    'real X duplicated the surrender booking', { surrenderBefore, surrendered });

  await stage({ kind: 'escape' });
  await page.keyboard.press('Escape');
  await waitFor('cleared', null, 'Escape did not remove all officers');
  const escaped = await snapshot();
  assert(escaped.cleanup?.officers === 0 && escaped.cleanup?.stuckKits === 0,
    'Escape cleared counts but leaked an officer actor or SFPD kit', escaped);

  await stage({ kind: 'heat', level: 3 });
  await assertStableLevel(3);
  await page.evaluate(() => window.__SF_SIM__?.streetHeat?.restart?.());
  await waitFor('cleared', null, 'street-heat reset did not remove all officers');
  const reset = await snapshot();
  assert(reset.cleanup?.officers === 0 && reset.cleanup?.stuckKits === 0,
    'street-heat reset cleared counts but leaked an officer actor or SFPD kit', reset);

  const cycles = [];
  for (let index = 0; index < 10; index += 1) {
    await stage({ kind: 'cycle' });
    await waitFor('heat', 3, `cycle ${index + 1} did not start three officers`);
    await page.keyboard.press('Escape');
    await waitFor('cleared', null, `cycle ${index + 1} did not clear officers`);
    cycles.push(await snapshot());
  }
  await page.evaluate(() => window.__SF_SIM__?.setCameraPose?.(null, null));
  const clearedPixels = await captureHudFree(captures.cleared);
  const resources = cycles.map(resourceVector);
  assert(resources.length === 10 && resources.every((entry) => sameResources(resources[0], entry)),
    'ten officer start/stop cycles grew resource usage', resources);

  // Measure under the actual expensive mix: pursuit car, deployed officers,
  // an exposed LOS encounter, and a held player aim input.
  await stage({ kind: 'heat', level: 3 });
  await assertStableLevel(3);
  await stage({ kind: 'los' });
  await page.locator('canvas').focus();
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.().aiming === true,
    null, { timeout: 3000 });
  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0
  ) >= 180, null, { timeout: 12000, polling: 50 });
  await page.mouse.up({ button: 'right' });
  const performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  assert(performance?.applicationFrameCount >= 180
    && finite(performance?.applicationP99FrameMs) && performance.applicationP99FrameMs <= 16.67,
    'SFPD officer response exceeded the 16.67 ms application p99 budget', performance);
  assert(consoleErrors.length === 0, 'console errors leaked during officer response verification', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors leaked during officer response verification', httpErrors);
  assert(requestFailures.length === 0, 'failed requests leaked during officer response verification', requestFailures);

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0
      && httpErrors.length === 0 && requestFailures.length === 0,
    baseUrl,
    angle,
    renderer,
    directDeployment: {
      grade: directGrade,
      trace: directDeployTrace,
      ground: directGroundSamples,
      composition: organicDeployComposition,
      pixels: organicDeployPixels,
    },
    heatTwo,
    heatThree,
    los: { before: losBefore, aiming, after: losAfter },
    composition: {
      exposed: { camera: exposedComposition, pixels: exposedPixels },
      blocked: { camera: blockedComposition, pixels: blockedPixels },
      downed: { camera: downedComposition, pixels: downedPixels },
      cleared: { pixels: clearedPixels },
    },
    blocked: { before: blockedBefore, after: blockedAfter },
    escape: escaped,
    reset,
    cycles: resources,
    performance,
    captures,
    consoleErrors,
    httpErrors,
    requestFailures,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'SFPD officer response verifier failed',
    error: error.message,
    stack: error.stack,
    consoleErrors,
    httpErrors,
    requestFailures,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
