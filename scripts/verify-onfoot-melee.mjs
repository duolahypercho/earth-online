import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const chrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(chrome).then(() => chrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const vehicleDiagnosticOnly = process.env.SF_QA_VEHICLE_DIAGNOSTIC === '1';
const captureDir = process.env.SF_QA_CAPTURE_DIR || '.qa-onfoot-melee';
const reportPath = join(captureDir, 'report.json');
const captures = Object.fromEntries([
  ['approach', '00-approach.png'], ['windup', '01-windup.png'], ['contact', '02-contact.png'],
  ['stagger', '03-stagger.png'], ['recovered', '04-recovered.png'], ['miss', '05-miss.png'],
  ['officer', '06-officer.png'], ['wall', '07-wall.png'],
].map(([key, file]) => [key, join(captureDir, file)]));

if (process.platform !== 'darwin' || angle !== 'metal' || !executablePath) {
  throw new Error('verify-onfoot-melee requires macOS System Chrome and SF_QA_ANGLE=metal.');
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
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};

page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('/favicon.ico')) consoleErrors.push(message.text());
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) httpErrors.push(`${response.status()} ${response.url()}`);
});
page.on('requestfailed', (request) => {
  if (!request.url().endsWith('/favicon.ico')) requestFailures.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
});

async function launch() {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null, { timeout: 15000 });
  await page.locator('canvas').focus();
  await page.waitForTimeout(250);
}

async function snapshot() {
  return page.evaluate(() => {
    const qa = window.__SF_SIM__?.getOnFootMeleeQa?.();
    return qa?.snapshot?.() ?? { contractError: 'window.__SF_SIM__.getOnFootMeleeQa().snapshot() is required' };
  });
}

async function stage(kind) {
  const result = await page.evaluate((requestedKind) => {
    const qa = window.__SF_SIM__?.getOnFootMeleeQa?.();
    if (!qa || typeof qa.stage !== 'function' || typeof qa.snapshot !== 'function') {
      return { contractError: 'getOnFootMeleeQa() must expose frozen stage() and snapshot()' };
    }
    return qa.stage({ kind: requestedKind });
  }, kind);
  if (result?.contractError) throw new Error(result.contractError);
  assert(result?.ready === true && result?.syntheticEvents === 0,
    `${kind} stage was unavailable or mutated measured gameplay`, result);
  return result;
}

const point = (value) => Number.isFinite(value?.x) && Number.isFinite(value?.y) && Number.isFinite(value?.z);
const distance = (left, right) => point(left) && point(right)
  ? Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) : Infinity;
const melee = (state) => state?.melee ?? {};
const target = (state) => state?.target ?? {};
const resources = (state) => state?.resources ?? {};
const events = (state) => Number(melee(state).events ?? melee(state).strikes ?? 0);
const consequences = (state) => Number(melee(state).consequences ?? 0);
const witnesses = (state) => Number(state?.witness?.events ?? melee(state).witnessEvents ?? 0);
const heatEvents = (state) => Number(state?.heat?.events ?? melee(state).heatEvents ?? 0);

async function raf() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

async function waitFor(predicate, message, timeout = 4000) {
  try {
    await page.waitForFunction(predicate, null, { timeout, polling: 16 });
    return true;
  } catch {
    assert(false, message, await snapshot());
    return false;
  }
}

async function tapPrimary() {
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('canvas is required for real pointer input');
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.5;
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
    window.__onFootMeleeTapProbe = probe;
    document.addEventListener('pointerdown', observe, true);
    document.addEventListener('pointerup', observe, true);
    document.addEventListener('mousedown', observe, true);
    document.addEventListener('mouseup', observe, true);
  });
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(30);
  await page.mouse.up({ button: 'left' });
  const probe = await page.evaluate(() => window.__onFootMeleeTapProbe ?? null);
  assert(Number.isFinite(probe?.down) && Number.isFinite(probe?.up) && probe.up >= probe.down
    && probe.up - probe.down <= 180,
  'melee positive input was not a <=180ms LMB tap', probe);
}

async function fireGunRound() {
  const box = await page.locator('canvas').boundingBox();
  if (!box) throw new Error('canvas is required for real RMB/LMB input');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(25);
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(55);
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
}

async function realKey(key, duration = 60) {
  await page.locator('canvas').focus();
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
}

async function capture(path, label) {
  // Framing is intentionally capture-only. Measurement and real input happen
  // before this function, and the normal camera is restored before either can
  // resume. Candidate selection works from actual posed mesh bounds, with a
  // clear city/streaming ray to each body centre and lower body.
  const framing = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getOnFootMeleeQa?.()?.snapshot?.();
    const scene = sim?.scene;
    const camera = sim?.camera;
    const avatar = sim?.playerAvatar;
    const opponent = state?.target?.objectUuid ? scene?.getObjectByProperty?.('uuid', state.target.objectUuid) : null;
    if (!sim || !scene || !camera || !avatar || !opponent || typeof sim.setCameraPose !== 'function') return null;
    scene.updateMatrixWorld(true);
    const boundsFor = (root) => {
      const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
      let vertices = 0;
      root.traverse((node) => {
        if (!node.visible || !node.isMesh || !node.geometry?.attributes?.position) return;
        const local = node.position.clone();
        const position = node.geometry.attributes.position;
        for (let index = 0; index < position.count; index += 1) {
          if (node.isSkinnedMesh && typeof node.getVertexPosition === 'function') node.getVertexPosition(index, local);
          else local.set(position.getX(index), position.getY(index), position.getZ(index));
          local.applyMatrix4(node.matrixWorld);
          bounds.min.x = Math.min(bounds.min.x, local.x); bounds.min.y = Math.min(bounds.min.y, local.y); bounds.min.z = Math.min(bounds.min.z, local.z);
          bounds.max.x = Math.max(bounds.max.x, local.x); bounds.max.y = Math.max(bounds.max.y, local.y); bounds.max.z = Math.max(bounds.max.z, local.z);
          vertices += 1;
        }
      });
      return { ...bounds, vertices };
    };
    const player = boundsFor(avatar);
    const targetBody = boundsFor(opponent);
    if (!player.vertices || !targetBody.vertices) return null;
    const midpoint = {
      x: (player.min.x + player.max.x + targetBody.min.x + targetBody.max.x) / 4,
      y: (player.min.y + player.max.y + targetBody.min.y + targetBody.max.y) / 4,
      z: (player.min.z + player.max.z + targetBody.min.z + targetBody.max.z) / 4,
    };
    const playerCenter = { x: (player.min.x + player.max.x) / 2, y: (player.min.y + player.max.y) / 2, z: (player.min.z + player.max.z) / 2 };
    const targetCenter = { x: (targetBody.min.x + targetBody.max.x) / 2, y: (targetBody.min.y + targetBody.max.y) / 2, z: (targetBody.min.z + targetBody.max.z) / 2 };
    const behind = Math.atan2(playerCenter.x - targetCenter.x, playerCenter.z - targetCenter.z);
    const Vector3 = camera.position.constructor;
    const screen = { width: 1280, height: 720 };
    const corners = (bounds) => [
      [bounds.min.x, bounds.min.y, bounds.min.z], [bounds.min.x, bounds.min.y, bounds.max.z],
      [bounds.min.x, bounds.max.y, bounds.min.z], [bounds.min.x, bounds.max.y, bounds.max.z],
      [bounds.max.x, bounds.min.y, bounds.min.z], [bounds.max.x, bounds.min.y, bounds.max.z],
      [bounds.max.x, bounds.max.y, bounds.min.z], [bounds.max.x, bounds.max.y, bounds.max.z],
    ];
    const projection = (testCamera, bounds) => {
      const values = corners(bounds).map(([x, y, z]) => new Vector3(x, y, z).project(testCamera));
      if (values.some((value) => value.z < -1 || value.z > 1)) return null;
      const xs = values.map((value) => (value.x * 0.5 + 0.5) * screen.width);
      const ys = values.map((value) => (-value.y * 0.5 + 0.5) * screen.height);
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), height: Math.max(...ys) - Math.min(...ys) };
    };
    const lowerVisible = (testCamera, bounds) => {
      const foot = new Vector3((bounds.min.x + bounds.max.x) / 2, bounds.min.y + 0.08, (bounds.min.z + bounds.max.z) / 2).project(testCamera);
      const x = (foot.x * 0.5 + 0.5) * screen.width;
      const y = (-foot.y * 0.5 + 0.5) * screen.height;
      return foot.z >= -1 && foot.z <= 1 && x >= 20 && x <= screen.width - 20 && y >= 20 && y <= screen.height - 20;
    };
    const clearRay = (origin, endpoint) => {
      const dx = endpoint.x - origin.x; const dy = endpoint.y - origin.y; const dz = endpoint.z - origin.z;
      const length = Math.hypot(dx, dy, dz);
      if (length <= 0.12) return false;
      return !sim.getCombatWorldBlocker?.(origin, { x: dx / length, y: dy / length, z: dz / length }, length - 0.08);
    };
    const bodyClear = (origin, bounds) => clearRay(origin, {
      x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2, z: (bounds.min.z + bounds.max.z) / 2,
    }) && clearRay(origin, {
      x: (bounds.min.x + bounds.max.x) / 2, y: bounds.min.y + 0.16, z: (bounds.min.z + bounds.max.z) / 2,
    });
    const offsets = [-1.25, -1.0, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1.0, 1.25];
    for (const elevation of [2.15, 2.65, 3.15]) for (const radius of [6.8, 7.6, 8.4]) for (const offset of offsets) {
      const heading = behind + offset;
      const position = { x: midpoint.x + Math.sin(heading) * radius, y: Math.min(player.min.y, targetBody.min.y) + elevation, z: midpoint.z + Math.cos(heading) * radius };
      const lookAt = { x: midpoint.x, y: midpoint.y + 0.02, z: midpoint.z };
      const testCamera = camera.clone();
      testCamera.position.set(position.x, position.y, position.z);
      testCamera.lookAt(lookAt.x, lookAt.y, lookAt.z);
      testCamera.updateMatrixWorld(true);
      const playerProjection = projection(testCamera, player);
      const targetProjection = projection(testCamera, targetBody);
      const inFrame = (rect) => rect && rect.left >= 20 && rect.right <= screen.width - 20
        && rect.top >= 20 && rect.bottom <= screen.height - 20 && rect.height >= 110 && rect.height <= 320;
      if (inFrame(playerProjection) && inFrame(targetProjection)
        && lowerVisible(testCamera, player) && lowerVisible(testCamera, targetBody)
        && bodyClear(position, player) && bodyClear(position, targetBody)) {
        return { position, lookAt, playerProjection, targetProjection, player, target: targetBody };
      }
    }
    return { player, target: targetBody, rejected: true };
  });
  assert(framing?.position && framing?.lookAt, `${label} capture had no unobstructed full-body rear-three-quarter camera`, framing);
  const hudState = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const canvas = sim?.renderer?.domElement;
    const app = canvas?.parentElement;
    if (!canvas || !app) return null;
    for (const child of [...app.children]) {
      if (child === canvas) continue;
      child.dataset.qaMeleeCaptureVisibility = child.style.visibility;
      child.style.visibility = 'hidden';
    }
    return {
      localNameTagVisible: sim.playerAvatar?.userData?.nameTag?.visible === true,
      visiblePanels: [...app.children].filter((child) => child !== canvas && getComputedStyle(child).visibility !== 'hidden').length,
    };
  });
  assert(hudState?.localNameTagVisible === false && hudState?.visiblePanels === 0,
    `${label} capture exposed a local nameplate or HUD panel`, hudState);
  try {
    if (framing?.position) {
      await page.evaluate((pose) => window.__SF_SIM__?.setCameraPose?.(pose.position, pose.lookAt), framing);
      await raf();
    }
    await page.screenshot({ path });
  } finally {
    await page.evaluate(() => {
      const sim = window.__SF_SIM__;
      sim?.setCameraPose?.(null, null);
      const canvas = sim?.renderer?.domElement;
      const app = canvas?.parentElement;
      for (const child of [...(app?.children || [])]) {
        if (child === canvas || !('qaMeleeCaptureVisibility' in child.dataset)) continue;
        child.style.visibility = child.dataset.qaMeleeCaptureVisibility;
        delete child.dataset.qaMeleeCaptureVisibility;
      }
    });
    await raf();
  }
}

// Independently reject hidden roots, ungrounded figures, or a fake target
// snapshot.  This samples actual posed SkinnedMesh vertices after skinning.
async function sceneGeometry() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getOnFootMeleeQa?.()?.snapshot?.();
    const scene = sim?.scene;
    const avatar = sim?.playerAvatar;
    const opponent = state?.target?.objectUuid ? scene?.getObjectByProperty?.('uuid', state.target.objectUuid) : null;
    if (!scene || !avatar || !opponent) return null;
    scene.updateMatrixWorld(true);
    const collect = (root) => {
      const vertices = [];
      let skinned = 0;
      root.traverse((node) => {
        if (!node.visible || !node.isMesh || !node.geometry?.attributes?.position) return;
        if (node.isSkinnedMesh) skinned += 1;
        const local = node.position.clone();
        const position = node.geometry.attributes.position;
        for (let index = 0; index < position.count; index += 1) {
          if (node.isSkinnedMesh && typeof node.getVertexPosition === 'function') node.getVertexPosition(index, local);
          else local.set(position.getX(index), position.getY(index), position.getZ(index));
          vertices.push(local.clone().applyMatrix4(node.matrixWorld));
        }
      });
      const bounds = vertices.reduce((result, value) => ({
        min: { x: Math.min(result.min.x, value.x), y: Math.min(result.min.y, value.y), z: Math.min(result.min.z, value.z) },
        max: { x: Math.max(result.max.x, value.x), y: Math.max(result.max.y, value.y), z: Math.max(result.max.z, value.z) },
      }), { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } });
      return { skinned, vertices: vertices.length, bounds, worldVertices: vertices };
    };
    const player = collect(avatar);
    const targetBody = collect(opponent);
    // The authored contact point sits below the right-forearm pivot. Sampling
    // that posed bone is independent of the QA snapshot's reported distance
    // and remains meaningful when the hand socket itself is only a rig marker.
    const forearm = avatar.userData?.rightForearm;
    const handPoint = forearm?.localToWorld?.(forearm.position.clone().set(0, -0.39, 0)) ?? null;
    let minimumVertexSeparation = Infinity;
    for (const left of player.worldVertices) {
      for (const right of targetBody.worldVertices) {
        minimumVertexSeparation = Math.min(minimumVertexSeparation, left.distanceTo(right));
      }
    }
    const handTargetDistance = handPoint
      ? targetBody.worldVertices.reduce((minimum, vertex) => Math.min(minimum, handPoint.distanceTo(vertex)), Infinity)
      : Infinity;
    const horizontalGap = Math.hypot(
      Math.max(0, Math.max(player.bounds.min.x - targetBody.bounds.max.x, targetBody.bounds.min.x - player.bounds.max.x)),
      Math.max(0, Math.max(player.bounds.min.z - targetBody.bounds.max.z, targetBody.bounds.min.z - player.bounds.max.z)),
    );
    const summary = ({ worldVertices, ...body }) => body;
    return {
      player: summary(player), target: summary(targetBody), horizontalGap, minimumVertexSeparation,
      handPoint: handPoint ? { x: handPoint.x, y: handPoint.y, z: handPoint.z } : null,
      handSource: forearm?.name || null,
      handTargetDistance,
    };
  });
}

function assertSceneState(state, geometry, label) {
  assert(state?.player?.visible === true && state?.player?.grounded === true
    && target(state).visible === true && target(state).grounded === true,
  `${label} did not expose two visible grounded bodies`, state);
  assert(geometry?.player?.skinned > 0 && geometry?.target?.skinned > 0
    && geometry.player.vertices > 0 && geometry.target.vertices > 0
    && Number.isFinite(geometry.horizontalGap) && geometry.horizontalGap >= 0
    && Number.isFinite(geometry.minimumVertexSeparation) && geometry.minimumVertexSeparation >= 0.01
    && Number.isFinite(state?.player?.surfaceDelta) && state.player.surfaceDelta <= 0.03
    && Number.isFinite(target(state)?.surfaceDelta) && target(state).surfaceDelta <= 0.03,
  `${label} scene geometry did not expose posed SkinnedMesh bodies with finite separation`, geometry);
}

function assertTimeline(samples) {
  const timeline = samples.map((entry) => melee(entry));
  const phases = timeline.map((entry) => entry.phase);
  const firstWindup = phases.indexOf('windup');
  const firstContact = phases.indexOf('contact');
  const firstRecovery = phases.findIndex((phase) => phase === 'recovery' || phase === 'recovered');
  assert(samples.length >= 10 && firstWindup >= 0 && firstContact > firstWindup && firstRecovery > firstContact,
    'melee phase samples were not monotonic windup → contact → recovery over >=10 RAFs', { phases });
  const strike = melee(samples[firstContact]).strike ?? {};
  const windupMs = Number(strike.windupMs ?? strike.contactAtMs - strike.startedAtMs);
  const contactMs = Number(strike.contactMs ?? strike.contactAtMs - strike.startedAtMs);
  const totalMs = Number(strike.totalMs ?? strike.recoveredAtMs - strike.startedAtMs);
  assert(windupMs >= 100 && windupMs <= 220 && contactMs >= 180 && contactMs <= 330
    && totalMs >= 450 && totalMs <= 750,
  'melee timing exceeded windup/contact/total bounds', { windupMs, contactMs, totalMs, strike });
}

async function blockedInput(kind, message, options = {}) {
  await stage(kind);
  const before = await snapshot();
  if (options.gun) {
    const box = await page.locator('canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down({ button: 'right' });
    await tapPrimary();
    await page.mouse.up({ button: 'right' });
  } else if (options.drag) {
    const box = await page.locator('canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.5);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(box.x + box.width * 0.54, box.y + box.height * 0.5, { steps: 3 });
    await page.waitForTimeout(120);
    await page.mouse.up({ button: 'left' });
  } else {
    await tapPrimary();
  }
  await page.waitForTimeout(420);
  const after = await snapshot();
  assert(events(after) === events(before) && consequences(after) === consequences(before), message, { before, after });
  return { before, after };
}

async function assertCurrentContextBlocked(name, contextKey) {
  const before = await snapshot();
  assert(before?.player?.context?.[contextKey] === true,
    `${name} did not establish a live prohibited context`, before);
  await tapPrimary();
  await page.waitForTimeout(420);
  const after = await snapshot();
  assert(events(after) === events(before) && consequences(after) === consequences(before),
    `${name} LMB emitted an on-foot melee consequence`, { before, after });
  return { before, after };
}

async function stageLiveVehicleEmbodiment() {
  const staged = await page.evaluate(() => window.__SF_SIM__?.getVehicleEmbodimentQa?.()
    ?.stage?.({ kind: 'core-private' }) ?? null);
  assert(staged?.ready === true && staged?.syntheticEvents === 0,
    'existing vehicle embodiment seam could not stage a real private vehicle', staged);
  // The embodiment gate accepts E on the live canvas only after its normal
  // core-road placement update has completed; this is not a synthetic input.
  await page.locator('canvas').focus();
  const inspect = async (label) => page.evaluate(({ vehicleId, label: sampleLabel }) => {
    const sim = window.__SF_SIM__;
    const embodiment = sim?.getPlayerVehicleEmbodimentState?.() ?? null;
    const avatar = sim?.playerAvatar;
    const root = sim?.traffic?.group?.children?.[vehicleId] ?? null;
    const nearest = sim?.traffic?.getNearestEnterableVehicle?.(avatar?.position, 3.8) ?? null;
    const life = sim?.traffic?.getVehicleLifeSnapshot?.().vehicles?.find((vehicle) => vehicle.id === vehicleId) ?? null;
    const position = (value) => value ? { x: value.x, y: value.y, z: value.z } : null;
    const distance = avatar && root ? Math.hypot(avatar.position.x - root.position.x, avatar.position.z - root.position.z) : null;
    return {
      label: sampleLabel,
      vehicleId,
      embodiment: embodiment ? {
        phase: embodiment.phase,
        internalPhase: embodiment.transition?.internalPhase ?? null,
        vehicle: embodiment.vehicle ? { id: embodiment.vehicle.id ?? embodiment.vehicle.vehicleId ?? null, position: embodiment.vehicle.position ?? null } : null,
      } : null,
      playerAvatar: position(avatar?.position),
      publicControls: sim?.controls ? position(sim.controls.target) : null,
      interaction: sim?.getInteractionState?.() ?? null,
      heldRoot: root ? {
        visible: root.visible === true,
        position: position(root.position),
        vehicleClass: root.userData?.vehicleClass ?? null,
        embodiment: root.userData?.vehicleEmbodiment ? {
          class: root.userData.vehicleEmbodiment.class ?? null,
          halfWidth: root.userData.vehicleEmbodiment.halfWidth ?? null,
          halfLength: root.userData.vehicleEmbodiment.halfLength ?? null,
        } : null,
      } : null,
      avatarToHeldDistance: distance,
      life: life ? {
        id: life.id,
        position: life.position ?? null,
        action: life.action ?? null,
        stop: life.stop ?? null,
        parked: life.parked ?? null,
        speed: life.speed ?? null,
        disabled: life.damage?.disabled ?? null,
        identity: life.identity ?? null,
      } : null,
      nearest: nearest ? { id: nearest.index, distance: nearest.distance } : null,
    };
  }, { vehicleId: staged?.vehicleId, label });
  if (vehicleDiagnosticOnly) {
    const samples = [await inspect('0s')];
    await page.waitForTimeout(500); samples.push(await inspect('0.5s'));
    await page.waitForTimeout(1500); samples.push(await inspect('2s'));
    await page.waitForTimeout(4500); samples.push(await inspect('6.5s'));
    const report = { pass: failures.length === 0, diagnostic: 'vehicle-stage', staged, samples, failures };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    throw new Error('__vehicle_stage_diagnostic_complete__');
  }
  await page.waitForTimeout(180);
  try {
    await page.waitForFunction((vehicleId) => {
      const sim = window.__SF_SIM__;
      const state = sim?.getPlayerVehicleEmbodimentState?.();
      const nearest = sim?.traffic?.getNearestEnterableVehicle?.(sim?.playerAvatar?.position, 3.8);
      return state?.phase === 'approach' && nearest?.index === vehicleId;
    }, staged?.vehicleId, { timeout: 6500, polling: 16 });
  } catch {
    assert(false, 'vehicle embodiment staging did not expose the exact enterable private vehicle before real E',
      await inspect('readiness-timeout'));
  }
  return staged;
}

async function waitForEmbodimentPhase(phases, message) {
  try {
    await page.waitForFunction((accepted) => accepted.includes(
      window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.()?.phase,
    ), phases, { timeout: 5000, polling: 16 });
    return true;
  } catch {
    assert(false, message, await snapshot());
    return false;
  }
}

async function enterLiveInterior() {
  const portal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const candidate = sim?.city?.portals?.find((entry) => entry?.position && Number.isFinite(entry.radius));
    if (!candidate) return null;
    sim.setRoamPose?.({ x: candidate.position.x, z: candidate.position.z });
    return { id: candidate.id, position: candidate.position };
  });
  assert(portal?.id, 'no authoritative live interior portal was available', portal);
  await page.keyboard.press('e');
  await waitFor(() => window.__SF_SIM__?.getInteractionState?.().mode === 'interior',
    'real E did not enter the staged live interior', 5000);
  return portal;
}

async function enterLiveTaxi() {
  await waitFor(() => window.__SF_SIM__?.traffic?.getVehicleLifeSnapshot?.().vehicles?.some((vehicle) => (
    vehicle.identity?.category === 'taxi' && vehicle.action?.key === 'at-stop'
      && vehicle.stop?.service === 'taxi' && vehicle.stop?.dwellRemaining >= 2.2
  )), 'no real taxi service became available for passenger melee negative', 35000);
  const taxi = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const candidate = sim?.traffic?.getVehicleLifeSnapshot?.().vehicles?.find((vehicle) => (
      vehicle.identity?.category === 'taxi' && vehicle.action?.key === 'at-stop'
        && vehicle.stop?.service === 'taxi' && vehicle.stop?.dwellRemaining >= 2.2
    ));
    if (candidate) sim.setRoamPose?.(candidate.position);
    return candidate ? { id: candidate.id, position: candidate.position } : null;
  });
  assert(taxi?.id >= 0, 'real taxi service was unavailable after readiness wait', taxi);
  await page.keyboard.press('e');
  await waitFor(() => window.__SF_SIM__?.getTaxiRideState?.()?.active === true,
    'real E did not enter the live taxi passenger state', 5000);
  return taxi;
}

try {
  await launch();
  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string' && /metal/i.test(renderer) && !/(swiftshader|software|llvmpipe)/i.test(renderer),
  'Apple Metal hardware rendering is required', { renderer, angle });

  if (vehicleDiagnosticOnly) {
    await stage('contact');
    await stageLiveVehicleEmbodiment();
  }

  const contexts = {};
  // Passenger evidence needs an unheated normal traffic simulation: earlier
  // melee consequences legitimately make taxi service unavailable. This uses
  // only the existing at-stop service and real E input, then lets its normal
  // short ride complete before the deterministic melee measurements begin.
  await stage('contact');
  await enterLiveTaxi();
  contexts.passenger = await assertCurrentContextBlocked('passenger', 'passenger');
  await waitFor(() => window.__SF_SIM__?.getTaxiRideState?.() === null,
    'live taxi passenger ride did not finish after the melee negative', 6000);

  await stage('contact');
  const approachBefore = await snapshot();
  assert(Number(approachBefore?.target?.distance) > 1.8,
    'contact staging must begin outside melee reach so real W owns the approach', approachBefore);
  await page.keyboard.down('w');
  await waitFor(() => {
    const state = window.__SF_SIM__?.getOnFootMeleeQa?.()?.snapshot?.();
    const targetDistance = Number(state?.target?.distance);
    return state?.player?.onFoot === true && targetDistance >= 1.18 && targetDistance <= 1.25;
  }, 'real W did not approach the live melee target');
  await page.keyboard.up('w');
  const approach = await snapshot();
  const approachGeometry = await sceneGeometry();
  assert(approach?.player?.id === approachBefore?.player?.id && target(approach).id === target(approachBefore).id,
    'approach changed Traveler or live target identity', { approachBefore, approach });
  assertSceneState(approach, approachGeometry, 'approach');
  await capture(captures.approach, 'approach');

  const beforeStrike = await snapshot();
  const ammoBefore = Number(beforeStrike?.combat?.ammo);
  await tapPrimary();
  const samples = [];
  let contactGeometry = null;
  for (let index = 0; index < 36; index += 1) {
    await raf();
    samples.push(await snapshot());
    if (melee(samples.at(-1)).phase === 'windup' && !captures.windupDone) {
      await capture(captures.windup, 'windup');
      captures.windupDone = true;
    }
    if (melee(samples.at(-1)).phase === 'contact' && !captures.contactDone) {
      // Freeze the independently posed-mesh observation on the same RAF as
      // the measured contact. Sampling after the full strike sequence would
      // inspect a legitimately recovered arm, not the contact pose.
      contactGeometry = await sceneGeometry();
      await capture(captures.contact, 'contact');
      captures.contactDone = true;
    }
  }
  const contact = samples.find((state) => melee(state).phase === 'contact') ?? await snapshot();
  const stagger = await snapshot();
  contactGeometry ??= await sceneGeometry();
  assertTimeline(samples);
  assert(captures.windupDone === true && captures.contactDone === true,
    'melee did not visibly expose windup and contact phases', samples.map((state) => melee(state).phase));
  assert(contact?.player?.id === beforeStrike?.player?.id && target(contact).id === target(beforeStrike).id
    && events(contact) === events(beforeStrike) + 1 && consequences(contact) === consequences(beforeStrike) + 1
    && witnesses(contact) === witnesses(beforeStrike) + 1 && heatEvents(contact) === heatEvents(beforeStrike) + 1
    && Number(contact?.combat?.ammo) === ammoBefore && target(contact)?.stagger?.active === true
    && melee(contact)?.armChain?.avatarId === contact?.player?.id
    && melee(contact)?.armChain?.visible === true
    && Number.isFinite(contactGeometry?.handTargetDistance) && contactGeometry.handTargetDistance <= 0.7,
  'real LMB melee did not create exactly one non-ammo strike consequence and target stagger', { beforeStrike, contact });
  assertSceneState(contact, contactGeometry, 'contact');
  await capture(captures.stagger, 'stagger');
  await waitFor(() => {
    const state = window.__SF_SIM__?.getOnFootMeleeQa?.()?.snapshot?.();
    return state?.target?.stagger?.active === false && state?.target?.recovered === true;
  }, 'target did not recover from the real melee stagger', 3000);
  const recovered = await snapshot();
  await capture(captures.recovered, 'recovered');

  // Create a real missing round in a separate contact run, then press Y while
  // an actual melee windup is active.  The first positive remains an isolated
  // zero-ammo-cost strike; this verifies reload cannot overlap a strike.
  await stage('contact');
  await page.keyboard.down('w');
  await waitFor(() => {
    const state = window.__SF_SIM__?.getOnFootMeleeQa?.()?.snapshot?.();
    const targetDistance = Number(state?.target?.distance);
    return targetDistance >= 1.18 && targetDistance <= 1.25;
  }, 'real W did not establish the reload-overlap melee range');
  await page.keyboard.up('w');
  const reloadRoundBefore = await snapshot();
  await fireGunRound();
  const reloadRoundAfter = await snapshot();
  assert(Number(reloadRoundAfter?.combat?.ammo) === Number(reloadRoundBefore?.combat?.ammo) - 1
    && Number(reloadRoundAfter?.combat?.shots) === Number(reloadRoundBefore?.combat?.shots) + 1
    && events(reloadRoundAfter) === events(reloadRoundBefore),
  'real RMB+LMB gun control did not create exactly one missing round without a melee event', {
    reloadRoundBefore, reloadRoundAfter,
  });
  await page.waitForTimeout(120);
  const reloadWindupBefore = await snapshot();
  await tapPrimary();
  await waitFor(() => window.__SF_SIM__?.getOnFootMeleeQa?.()?.snapshot?.().melee?.phase === 'windup',
    'real LMB did not enter windup before the reload-overlap negative');
  await page.keyboard.press('y');
  const reloadDuringWindup = await page.evaluate(() => ({
    melee: window.__SF_SIM__?.getOnFootMeleeQa?.()?.snapshot?.().melee ?? null,
    combat: window.__SF_SIM__?.getCombatState?.() ?? null,
  }));
  assert(reloadDuringWindup?.melee?.active === true
    && reloadDuringWindup?.melee?.phase === 'windup'
    && reloadDuringWindup?.combat?.reloading === false
    && Number(reloadDuringWindup?.combat?.ammo) === Number(reloadWindupBefore?.combat?.ammo),
  'real Y started or overlapped a reload during an active melee windup', reloadDuringWindup);
  await page.waitForTimeout(700);

  const miss = await blockedInput('miss', '>=1.9m LMB miss produced a melee consequence');
  await capture(captures.miss, 'miss');
  const wall = await blockedInput('wall-blocked', 'wall-blocked LMB produced a melee consequence');
  await capture(captures.wall, 'wall-blocked');
  const drag = await blockedInput('contact', 'pointer drag/orbit produced a melee consequence', { drag: true });
  const gun = await blockedInput('contact', 'RMB+LMB gun control emitted a melee consequence', { gun: true });
  const officer = await stage('officer');
  const officerBefore = await snapshot();
  await tapPrimary();
  try {
    await page.waitForFunction((expected) => Number(
      window.__SF_SIM__?.getOnFootMeleeQa?.()?.snapshot?.().melee?.events,
    ) === expected, events(officerBefore) + 1, { timeout: 4000, polling: 16 });
  } catch {
    assert(false, 'real LMB did not expose the staged live officer melee result', await snapshot());
  }
  const officerAfter = await snapshot();
  assert(target(officerAfter).kind === 'officer' && Number(officerAfter?.combat?.ammo) === Number(officerBefore?.combat?.ammo),
    'officer melee was not unarmed against a live officer target', { officer, officerBefore, officerAfter });
  await capture(captures.officer, 'officer');

  // These are established through normal live product seams.  Do not accept
  // a melee scenario label as evidence for a prohibited player context.
  await stage('contact');
  await page.evaluate(() => window.__SF_SIM__?.damagePlayer?.(100, 'qa-melee-downed'));
  contexts.downed = await assertCurrentContextBlocked('downed', 'downed');
  await page.evaluate(() => window.__SF_SIM__?.restartCombat?.());

  await stage('contact');
  await enterLiveInterior();
  contexts.interior = await assertCurrentContextBlocked('interior', 'interior');
  await page.keyboard.press('Escape');
  await waitFor(() => window.__SF_SIM__?.getInteractionState?.().mode === 'roam',
    'Escape did not restore the live interior context', 5000);
  // The public mode changes at the start of the fade; wait for the normal
  // scene transition to settle before a later deterministic QA pose request.
  await page.waitForTimeout(700);

  await stage('contact');
  await stageLiveVehicleEmbodiment();
  await page.keyboard.press('e');
  await waitForEmbodimentPhase(['ingress', 'entering'], 'real E did not begin a vehicle transition');
  contexts.vehicleTransition = await assertCurrentContextBlocked('vehicle transition', 'vehicleTransition');
  await waitForEmbodimentPhase(['seated'], 'vehicle transition did not reach seated driving state');
  contexts.driving = await assertCurrentContextBlocked('driving', 'driving');
  await page.keyboard.press('e');
  await waitForEmbodimentPhase(['grounded'], 'real E did not exit the driving state');

  const samplesForResources = [
    approach, beforeStrike, contact, stagger, recovered, miss.after, wall.after, drag.after, gun.after, officerAfter,
    contexts.downed?.after, contexts.interior?.after, contexts.vehicleTransition?.after,
    contexts.driving?.after, contexts.passenger?.after,
  ]
    .map(resources);
  assert(samplesForResources.every((sample) => Object.keys(samplesForResources[0]).every((key) => (
    Number.isFinite(sample[key]) && sample[key] === samplesForResources[0][key]
  ))), 'melee flow grew runtime resources', samplesForResources);

  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0
  ) >= 180, null, { timeout: 12000, polling: 50 });
  const performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  assert(performance?.applicationFrameCount >= 180 && Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'on-foot melee exceeded the 16.67 ms application p99 budget', performance);
  assert(consoleErrors.length === 0 && httpErrors.length === 0 && requestFailures.length === 0,
    'runtime errors leaked during on-foot melee verification', { consoleErrors, httpErrors, requestFailures });

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0 && httpErrors.length === 0 && requestFailures.length === 0,
    renderer, approach: { before: approachBefore, state: approach, geometry: approachGeometry },
    contact, contactGeometry, stagger, recovered,
    reloadOverlap: { roundBefore: reloadRoundBefore, roundAfter: reloadRoundAfter, duringWindup: reloadDuringWindup },
    miss, wall, drag, gun, officer: officerAfter, contexts,
    performance, captures, consoleErrors, httpErrors, requestFailures, failures,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    summary: {
      pass: report.pass,
      renderer,
      approachDistance: approach?.target?.distance,
      contact: {
        events: events(contact),
        witnesses: witnesses(contact),
        heatEvents: heatEvents(contact),
        handTargetDistance: contactGeometry?.handTargetDistance,
      },
      applicationP99FrameMs: performance?.applicationP99FrameMs,
      failures,
    },
  }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  if (error.message !== '__vehicle_stage_diagnostic_complete__') {
    console.error(JSON.stringify({ result: 'on-foot melee verifier failed', error: error.message, failures }, null, 2));
    process.exitCode = 1;
  }
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
