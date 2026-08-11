import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const chrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(chrome).then(() => chrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const captureDir = process.env.SF_QA_CAPTURE_DIR || '.qa-pedestrian-melee-response';
const reportPath = join(captureDir, 'report.json');
const capturePaths = Object.fromEntries([
  ['approach', '00-approach.png'],
  ['windup', '01-windup.png'],
  ['contact', '02-counter-contact.png'],
  ['recovery', '03-recovery.png'],
  ['evade', '04-evade-whiff.png'],
  ['blocked', '05-blocked.png'],
].map(([key, file]) => [key, join(captureDir, file)]));

if (process.platform !== 'darwin' || angle !== 'metal' || !executablePath) {
  throw new Error('verify-pedestrian-melee-response requires macOS System Chrome and SF_QA_ANGLE=metal.');
}
await mkdir(captureDir, { recursive: true });

const browser = await chromium.launch({
  headless: process.env.SF_QA_HEADLESS !== 'false',
  executablePath,
  args: ['--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestFailures = [];
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail == null ? {} : { detail }) });
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
page.on('requestfailed', (request) => {
  if (!request.url().endsWith('/favicon.ico')) {
    requestFailures.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
  }
});

const xzDistance = (left, right) => (
  Number.isFinite(left?.x) && Number.isFinite(left?.z)
    && Number.isFinite(right?.x) && Number.isFinite(right?.z)
    ? Math.hypot(left.x - right.x, left.z - right.z)
    : Infinity
);

async function launch() {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null, { timeout: 15000 });
  await page.locator('canvas').focus();
  await page.addStyleTag({ content: '.hud { display: none !important; }' });
  await page.waitForTimeout(250);
}

async function snapshot() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const qa = sim?.getPedestrianMeleeResponseQa?.();
    return {
      qa: qa?.snapshot?.() ?? null,
      combat: sim?.getCombatState?.() ?? null,
      melee: sim?.getMeleeState?.() ?? null,
      heat: sim?.streetHeat?.getState?.() ?? null,
      resources: {
        geometries: sim?.renderer?.info?.memory?.geometries ?? null,
        textures: sim?.renderer?.info?.memory?.textures ?? null,
        programs: sim?.renderer?.info?.programs?.length ?? null,
      },
    };
  });
}

async function stage(kind) {
  const result = await page.evaluate((requested) => {
    const qa = window.__SF_SIM__?.getPedestrianMeleeResponseQa?.();
    if (!qa || typeof qa.stage !== 'function' || typeof qa.snapshot !== 'function') {
      return { contractError: 'getPedestrianMeleeResponseQa() must expose stage() and snapshot()' };
    }
    return qa.stage({ kind: requested });
  }, kind);
  if (result?.contractError) throw new Error(result.contractError);
  assert(result?.ready === true && result?.syntheticEvents === 0,
    `${kind} stage was unavailable or synthesized a measured event`, result);
  await page.evaluate(() => new Promise((resolve) => (
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  )));
  return result;
}

async function tapPrimary() {
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('canvas is required for real pointer input');
  await page.evaluate(() => {
    const probe = { down: null, up: null };
    const observe = (event) => {
      if (event.button !== 0) return;
      if (event.type === 'pointerdown' || event.type === 'mousedown') probe.down ??= event.timeStamp;
      if (event.type === 'pointerup' || event.type === 'mouseup') {
        probe.up = event.timeStamp;
        document.removeEventListener('pointerdown', observe, true);
        document.removeEventListener('pointerup', observe, true);
        document.removeEventListener('mousedown', observe, true);
        document.removeEventListener('mouseup', observe, true);
      }
    };
    window.__civilianCounterTapProbe = probe;
    document.addEventListener('pointerdown', observe, true);
    document.addEventListener('pointerup', observe, true);
    document.addEventListener('mousedown', observe, true);
    document.addEventListener('mouseup', observe, true);
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(30);
  await page.mouse.up({ button: 'left' });
  const probe = await page.evaluate(() => window.__civilianCounterTapProbe);
  assert(Number.isFinite(probe?.down) && Number.isFinite(probe?.up)
    && probe.up >= probe.down && probe.up - probe.down <= 180,
  'counter setup was not initiated by a real <=180ms LMB tap', probe);
}

async function approachWithW() {
  const before = await snapshot();
  assert(xzDistance(before.qa?.player?.position, before.qa?.resident?.position) > 1.8,
    'stage must begin outside melee reach so real W owns approach', before.qa);
  await page.locator('canvas').focus();
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(() => {
      const state = window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.();
      const player = state?.player?.position;
      const resident = state?.resident?.position;
      if (![player?.x, player?.z, resident?.x, resident?.z].every(Number.isFinite)) return false;
      const distance = Math.hypot(player.x - resident.x, player.z - resident.z);
      return distance >= 1.18 && distance <= 1.25;
    }, null, { timeout: 5000, polling: 16 });
  } finally {
    await page.keyboard.up('w');
  }
  return snapshot();
}

async function poseSample() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getPedestrianMeleeResponseQa?.()?.snapshot?.();
    const resident = state?.resident?.objectUuid
      ? sim?.scene?.getObjectByProperty?.('uuid', state.resident.objectUuid)
      : null;
    const player = sim?.playerAvatar ?? null;
    const point = (object) => {
      if (!object?.getWorldPosition) return null;
      const out = new sim.camera.position.constructor();
      object.getWorldPosition(out);
      return { x: out.x, y: out.y, z: out.z };
    };
    const rotation = (object) => object?.rotation ? {
      x: object.rotation.x, y: object.rotation.y, z: object.rotation.z,
    } : null;
    const parts = (root) => {
      const ud = root?.userData || {};
      return Object.fromEntries([
        'body', 'headPivot', 'leftArm', 'leftForearm', 'leftHand',
        'rightArm', 'rightForearm', 'rightHand', 'leftFoot', 'rightFoot',
      ].map((name) => [name, { world: point(ud[name]), rotation: rotation(ud[name]) }]));
    };
    sim?.scene?.updateMatrixWorld?.(true);
    return {
      player: { uuid: player?.uuid ?? null, visible: player?.visible === true, parts: parts(player) },
      resident: { uuid: resident?.uuid ?? null, visible: resident?.visible === true, parts: parts(resident) },
      damageFeedback: sim?.getCombatState?.()?.damageFeedback ?? null,
    };
  });
}

async function setCaptureCamera() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getPedestrianMeleeResponseQa?.()?.snapshot?.();
    const avatar = sim?.playerAvatar;
    const resident = state?.resident?.objectUuid
      ? sim?.scene?.getObjectByProperty?.('uuid', state.resident.objectUuid) : null;
    if (!avatar || !resident || typeof sim.setCameraPose !== 'function') return null;
    const V3 = sim.camera.position.constructor;
    const existing = window.__civilianCounterCameraPose;
    if (!existing
      || existing.scenario !== state.scenario
      || existing.residentId !== state.resident?.id) {
      const midpoint = avatar.position.clone().add(resident.position).multiplyScalar(0.5);
      const axis = avatar.position.clone().sub(resident.position).setY(0).normalize();
      const side = new V3(axis.z, 0, -axis.x).normalize();
      const position = state.scenario === 'blocked'
        // Look back through the authored rowhouse's northeast corner. The
        // actors stand on adjacent exterior faces, leaving the solid corner
        // visibly between them without hiding either silhouette.
        ? midpoint.clone().add(new V3(5.3, 0, 5.3))
        : midpoint.clone().addScaledVector(side, 6.2).addScaledVector(axis, 0.8);
      position.y = Math.max(avatar.position.y, resident.position.y) + 2.9;
      const lookAt = midpoint.clone();
      lookAt.y += 0.95;
      window.__civilianCounterCameraPose = {
        scenario: state.scenario,
        residentId: state.resident?.id ?? null,
        position: { x: position.x, y: position.y, z: position.z },
        lookAt: { x: lookAt.x, y: lookAt.y, z: lookAt.z },
      };
    }
    const pose = window.__civilianCounterCameraPose;
    sim.setCameraPose(pose.position, pose.lookAt);
    return pose;
  });
}

async function warmScenarioResources() {
  // Warm both authored loci and their capture cameras without producing any
  // combat event. Resource stability is then measured across the real input
  // sequences instead of conflating sector/material compilation with leaks.
  for (const kind of ['blocked', 'positive', 'blocked', 'positive']) {
    await stage(kind);
    await setCaptureCamera();
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__SF_SIM__?.setCameraPose?.(null, null));
  }
  await page.waitForTimeout(600);
}

async function capture(path) {
  const pose = await setCaptureCamera();
  assert(pose != null, 'capture camera could not frame the live player/resident pair');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const evidence = await page.evaluate(() => ({
    state: window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.(),
    playerVisible: window.__SF_SIM__?.playerAvatar?.visible === true,
  }));
  assert(evidence.playerVisible && evidence.state?.captureFraming === true,
    'capture-only camera hid the live Traveler or lacked framing authority', evidence);
  await page.screenshot({ path });
  const image = await stat(path);
  assert(image.size >= 100_000,
    'capture collapsed to a blank or near-empty frame', { path, bytes: image.size });
  await page.evaluate(() => window.__SF_SIM__?.setCameraPose?.(null, null));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  return evidence;
}

async function waitForCounterPhase(phase, timeout = 7000) {
  await page.waitForFunction((expected) => (
    window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.()?.counter?.phase === expected
  ), phase, { timeout, polling: 16 });
  return snapshot();
}

async function runPositive() {
  const staged = await stage('positive');
  const approach = await approachWithW();
  await capture(capturePaths.approach);
  const before = await snapshot();
  await tapPrimary();
  await waitForCounterPhase('windup');
  const windup = await snapshot();
  const windupPose = await poseSample();
  await capture(capturePaths.windup);
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.()?.counter?.lastEvent != null
  ), null, { timeout: 3500, polling: 16 });
  const contact = await snapshot();
  const contactPose = await poseSample();
  await capture(capturePaths.contact);
  const event = contact.qa?.counter?.lastEvent;
  assert(event?.hit === true && event?.phase === 'contact' && event?.residentId === staged.residentId,
    'same live resident did not deliver one authoritative counter contact', { staged, event });
  assert(Number(before.combat?.health) - Number(contact.combat?.health) === 10
    && contact.combat?.lastEvent?.source === `civilian-melee:${staged.residentId}`,
  'counter did not remove exactly 10 health through the civilian-melee source', { before, contact });
  assert(Number(contact.combat?.ammo) === Number(before.combat?.ammo)
    && Number(contact.combat?.shots) === Number(before.combat?.shots),
  'civilian counter mutated firearm ammo or shot counters', { before, contact });
  assert(event?.timing?.recoveryDelayMs >= 250 && event?.timing?.recoveryDelayMs <= 900
    && event?.timing?.contactMs >= 180 && event?.timing?.contactMs <= 420,
  'counter timing fell outside recovery/windup contract', event?.timing);
  assert(Number.isFinite(event?.armChain?.contactGap)
    && event.armChain.contactGap >= 0
    && event.armChain.contactGap <= 0.1
    && Number.isFinite(event?.timing?.closingDistance)
    && event.timing.closingDistance >= 0
    && event.timing.closingDistance <= 0.36,
  'counter contact was not backed by the measured fist gap and bounded grounded close', event);
  assert(contact.combat?.damageFlash > 0
    && contact.combat?.damageFeedback?.reaction?.active === true
    && (contact.combat?.damageFeedback?.reaction?.bonesMoved?.length ?? 0) >= 2,
  'counter contact lacked visible player damage feedback', contact.combat?.damageFeedback);
  await waitForCounterPhase('recovery', 1000).catch(() => null);
  await capture(capturePaths.recovery);
  await page.waitForFunction(() => {
    const counter = window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.()?.counter;
    return counter?.phase === 'cooldown' && counter?.cooldownRemaining > 0;
  }, null, { timeout: 2000, polling: 16 });
  const cooldown = await snapshot();
  const healthAtContact = contact.combat?.health;
  await page.waitForTimeout(500);
  const held = await snapshot();
  assert(held.combat?.health === healthAtContact,
    'one counter attempt damaged the player more than once', { contact, held });
  return { staged, approach, before, windup, windupPose, contact, contactPose, cooldown, held };
}

async function runEvade() {
  await stage('evade');
  const before = await snapshot();
  await tapPrimary();
  await waitForCounterPhase('windup');
  await page.keyboard.down('s');
  try {
    await page.waitForFunction(() => {
      const state = window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.();
      const p = state?.player?.position;
      const r = state?.resident?.position;
      return Math.hypot(p.x - r.x, p.z - r.z) > 1.75;
    }, null, { timeout: 1500, polling: 16 });
  } finally {
    await page.keyboard.up('s');
  }
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.()?.counter?.lastEvent != null
  ), null, { timeout: 2000, polling: 16 });
  const after = await snapshot();
  await capture(capturePaths.evade);
  assert(after.qa?.counter?.lastEvent?.hit === false
    && after.qa?.counter?.lastEvent?.reason === 'evaded'
    && after.combat?.health === before.combat?.health,
  'real S evade did not produce a visible zero-damage whiff beyond 1.75m', { before, after });
  return { before, after };
}

async function runBlocked() {
  const staged = await stage('blocked');
  const before = await snapshot();
  await tapPrimary();
  await page.waitForTimeout(900);
  const after = await snapshot();
  await capture(capturePaths.blocked);
  assert(staged.wallBlocked === true && after.combat?.health === before.combat?.health
    && after.qa?.counter?.lastEvent?.hit !== true,
  'real wall-blocked input caused civilian counter damage or lacked a real blocker', { staged, before, after });
  return { staged, before, after };
}

async function runLifecycleNegatives() {
  await stage('positive');
  await approachWithW();
  await tapPrimary();
  await waitForCounterPhase('delay');
  const restartBefore = await snapshot();
  await page.evaluate(() => window.__SF_SIM__?.restartCombat?.());
  await page.waitForTimeout(1400);
  const restartAfter = await snapshot();
  assert(restartAfter.combat?.health === restartBefore.combat?.health
    && ['idle', 'cooldown'].includes(restartAfter.qa?.counter?.phase)
    && restartAfter.qa?.counter?.lastEvent == null,
  'combat restart allowed a pending civilian counter to damage or replay', { restartBefore, restartAfter });

  await stage('defeated');
  const defeatedBefore = await snapshot();
  await tapPrimary();
  await page.waitForTimeout(1400);
  const defeatedAfter = await snapshot();
  assert(defeatedAfter.combat?.health === defeatedBefore.combat?.health
    && defeatedAfter.qa?.counter?.lastEvent == null
    && defeatedAfter.qa?.resident?.defeated === true,
  'defeated resident posed or emitted a civilian counter', { defeatedBefore, defeatedAfter });
  return { restartBefore, restartAfter, defeatedBefore, defeatedAfter };
}

let report;
try {
  await launch();
  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string' && /metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe)/i.test(renderer),
  'Apple Metal hardware renderer is required', { renderer, angle });

  await warmScenarioResources();
  const positive = await runPositive();
  const evade = await runEvade();
  const blocked = await runBlocked();
  const lifecycle = await runLifecycleNegatives();
  // Measure leak behavior only after every authored locus/effect has been
  // exercised once, then require the settled live scene to stop allocating.
  // Legitimate first-use sector/material compilation is not a leak.
  const resourcesBefore = (await snapshot()).resources;
  await page.waitForTimeout(1500);
  const resourcesAfter = (await snapshot()).resources;
  assert(Object.keys(resourcesBefore).every((key) => resourcesBefore[key] === resourcesAfter[key]),
    'civilian melee response grew renderer resources', { resourcesBefore, resourcesAfter });

  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0
  ) >= 180, null, { timeout: 12000, polling: 50 });
  const performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  assert(performance?.applicationFrameCount >= 180
    && Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'civilian melee response exceeded 16.67ms application p99', performance);
  assert(consoleErrors.length === 0 && httpErrors.length === 0 && requestFailures.length === 0,
    'runtime/network errors occurred during civilian melee response gate', {
      consoleErrors, httpErrors, requestFailures,
    });

  report = {
    pass: failures.length === 0 && consoleErrors.length === 0
      && httpErrors.length === 0 && requestFailures.length === 0,
    renderer, positive, evade, blocked, lifecycle,
    resources: { before: resourcesBefore, after: resourcesAfter },
    performance, captures: capturePaths,
    consoleErrors, httpErrors, requestFailures, failures,
  };
} catch (error) {
  failures.push({ message: error?.message || String(error), stack: error?.stack || null });
  report = {
    pass: false, captures: capturePaths,
    consoleErrors, httpErrors, requestFailures, failures,
  };
} finally {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

console.log(JSON.stringify({
  summary: {
    pass: report.pass,
    renderer: report.renderer ?? null,
    healthDelta: report.positive
      ? Number(report.positive.before.combat?.health) - Number(report.positive.contact.combat?.health)
      : null,
    counterEvent: report.positive?.contact?.qa?.counter?.lastEvent ?? null,
    applicationP99FrameMs: report.performance?.applicationP99FrameMs ?? null,
    failures,
  },
}, null, 2));

if (!report.pass) process.exitCode = 1;
