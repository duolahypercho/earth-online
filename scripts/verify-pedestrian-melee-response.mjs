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

const distance3 = (left, right) => (
  Number.isFinite(left?.x) && Number.isFinite(left?.y) && Number.isFinite(left?.z)
    && Number.isFinite(right?.x) && Number.isFinite(right?.y) && Number.isFinite(right?.z)
    ? Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
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
  await page.evaluate(() => {
    window.__civilianCounterCameraPose = null;
  });
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
  // Let the locomotion layer settle after the real key-up.  The neutral beat
  // must be sampled from planted shoe vertices, not from a gait-transition
  // frame immediately after releasing W.
  await page.waitForTimeout(260);
  return snapshot();
}

async function beginRootTrace() {
  await page.evaluate(() => {
    const trace = { active: true, frames: [] };
    window.__civilianCounterRootTrace = trace;
    const sample = () => {
      const sim = window.__SF_SIM__;
      const qa = sim?.getPedestrianMeleeResponseQa?.();
      const state = qa?.snapshot?.();
      const resident = state?.resident?.objectUuid
        ? sim?.scene?.getObjectByProperty?.('uuid', state.resident.objectUuid) : null;
      if (trace.active && ['delay', 'windup', 'contact', 'recovery'].includes(state?.counter?.phase)) {
        trace.frames.push({
          phase: state.counter.phase,
          player: sim?.playerAvatar?.position ? {
            x: sim.playerAvatar.position.x, y: sim.playerAvatar.position.y, z: sim.playerAvatar.position.z,
          } : null,
          resident: resident?.position ? {
            x: resident.position.x, y: resident.position.y, z: resident.position.z,
          } : null,
        });
      }
      if (trace.active) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function endRootTrace() {
  return page.evaluate(() => {
    const trace = window.__civilianCounterRootTrace;
    if (!trace) return [];
    trace.active = false;
    return trace.frames;
  });
}

function assertRootTrace(frames) {
  assert(Array.isArray(frames) && frames.length >= 3,
    'counter acting root trace did not expose enough application frames', frames);
  for (const actor of ['player', 'resident']) {
    const values = frames.map((frame) => frame[actor]).filter(Boolean);
    assert(values.length >= 3, `counter acting root trace missing ${actor} roots`, frames);
    const origin = values[0];
    const finish = values[values.length - 1];
    const total = distance3(origin, finish);
    assert(Number.isFinite(total) && total <= 0.36,
      `counter acting ${actor} root translated beyond the grounded close budget`, { total, origin, finish });
    const axis = { x: finish.x - origin.x, y: finish.y - origin.y, z: finish.z - origin.z };
    const axisLength = Math.hypot(axis.x, axis.y, axis.z);
    let previousProgress = 0;
    for (let index = 1; index < values.length; index += 1) {
      const step = distance3(values[index - 1], values[index]);
      assert(Number.isFinite(step) && step <= 0.04,
        `counter acting ${actor} root moved >0.04m in one application frame`, { step, index, frames });
      if (axisLength > 0.005) {
        const progress = ((values[index].x - origin.x) * axis.x
          + (values[index].y - origin.y) * axis.y
          + (values[index].z - origin.z) * axis.z) / axisLength;
        assert(progress >= previousProgress - 0.006,
          `counter acting ${actor} root rewound during the grounded close`, { progress, previousProgress, index, frames });
        previousProgress = progress;
      }
    }
  }
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
    const scale = (object) => object?.scale ? {
      x: object.scale.x, y: object.scale.y, z: object.scale.z,
    } : null;
    const screen = (world) => {
      if (!world) return null;
      const projected = new sim.camera.position.constructor(world.x, world.y, world.z)
        .project(sim.camera);
      const width = sim.renderer?.domElement?.clientWidth || 1280;
      const height = sim.renderer?.domElement?.clientHeight || 720;
      return {
        x: (projected.x * 0.5 + 0.5) * width,
        y: (-projected.y * 0.5 + 0.5) * height,
        z: projected.z,
      };
    };
    const skinnedSole = (root, side) => {
      const feet = ['left', 'right'].map((name) => point(root?.userData?.[`${name}Foot`]));
      const footIndex = side === 'left' ? 0 : 1;
      const rootY = root?.position?.y;
      let lowest = null;
      let vertices = 0;
      root?.traverse?.((node) => {
        if (!node.visible || !node.isSkinnedMesh || !node.geometry?.attributes?.position
          || typeof node.getVertexPosition !== 'function') return;
        const position = node.geometry.attributes.position;
        const local = new sim.camera.position.constructor();
        for (let index = 0; index < position.count; index += 1) {
          node.getVertexPosition(index, local);
          const world = local.clone().applyMatrix4(node.matrixWorld);
          if (!feet[0] || !feet[1] || !Number.isFinite(rootY)) continue;
          const leftDistance = Math.hypot(world.x - feet[0].x, world.z - feet[0].z);
          const rightDistance = Math.hypot(world.x - feet[1].x, world.z - feet[1].z);
          const nearest = footIndex === 0 ? leftDistance : rightDistance;
          if (nearest > 0.32 || leftDistance === rightDistance
            || (footIndex === 0 ? leftDistance > rightDistance : rightDistance > leftDistance)
            || world.y > rootY + 0.35) continue;
          vertices += 1;
          if (!lowest || world.y < lowest.y) lowest = { x: world.x, y: world.y, z: world.z };
        }
      });
      return {
        world: lowest,
        screen: screen(lowest),
        supportY: Number.isFinite(rootY) ? rootY : null,
        supportDelta: lowest && Number.isFinite(rootY) ? lowest.y - rootY : null,
        support: { source: 'actor-root', collisionKind: 'staged-route-support', vertices },
      };
    };
    const parts = (root) => {
      const ud = root?.userData || {};
      const values = Object.fromEntries([
        'body', 'headPivot', 'leftArm', 'leftForearm', 'leftHand',
        'rightArm', 'rightForearm', 'rightHand', 'leftFoot', 'rightFoot',
      ].map((name) => {
        const world = point(ud[name]);
        return [name, { world, screen: screen(world), rotation: rotation(ud[name]), scale: scale(ud[name]) }];
      }));
      values.limbs = Object.fromEntries(['left', 'right'].map((side) => {
        const upper = values[`${side}Arm`]?.world;
        const elbow = values[`${side}Forearm`]?.world;
        const hand = values[`${side}Hand`]?.world;
        return [side, {
          upperArm: upper && elbow ? Math.hypot(upper.x - elbow.x, upper.y - elbow.y, upper.z - elbow.z) : Infinity,
          forearm: elbow && hand ? Math.hypot(elbow.x - hand.x, elbow.y - hand.y, elbow.z - hand.z) : Infinity,
          upperArmScale: values[`${side}Arm`]?.scale ?? null,
          forearmScale: values[`${side}Forearm`]?.scale ?? null,
        }];
      }));
      const soleValue = (side) => {
        return skinnedSole(root, side);
      };
      values.leftSole = soleValue('left');
      values.rightSole = soleValue('right');
      return values;
    };
    sim?.scene?.updateMatrixWorld?.(true);
    return {
      player: { uuid: player?.uuid ?? null, visible: player?.visible === true, position: point(player), parts: parts(player) },
      resident: { uuid: resident?.uuid ?? null, visible: resident?.visible === true, position: point(resident), parts: parts(resident) },
      damageFeedback: sim?.getCombatState?.()?.damageFeedback ?? null,
    };
  });
}

function poseSolesGrounded(pose) {
  return ['player', 'resident'].every((actor) => ['leftSole', 'rightSole'].every((foot) => {
    const delta = pose?.[actor]?.parts?.[foot]?.supportDelta;
    return Number.isFinite(delta) && Math.abs(delta) <= 0.03;
  }));
}

async function waitForGroundedPose(timeout = 1000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() <= deadline) {
    last = await poseSample();
    if (poseSolesGrounded(last)) return last;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  throw new Error(`staged sole grounding did not settle within ${timeout}ms: lastPose=${JSON.stringify(last)}`);
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
      const handSide = state.counter?.hand === 'left' ? 'left' : 'right';
      const hand = resident.userData?.[`${handSide}Hand`];
      const handPoint = hand?.getWorldPosition ? new V3().copy(hand.getWorldPosition(new V3())) : null;
      const candidate = (sign) => midpoint.clone().addScaledVector(side, 6.2 * sign).addScaledVector(axis, 0.8);
      const signedSide = handPoint
        ? (candidate(1).distanceTo(handPoint) <= candidate(-1).distanceTo(handPoint) ? 1 : -1)
        : (handSide === 'left' ? 1 : -1);
      const position = state.scenario === 'blocked'
        // Look back through the authored rowhouse's northeast corner. The
        // actors stand on adjacent exterior faces, leaving the solid corner
        // visibly between them without hiding either silhouette.
        ? midpoint.clone().add(new V3(5.3, 0, 5.3))
        : midpoint.clone().addScaledVector(side, 6.2 * signedSide).addScaledVector(axis, 0.8);
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

function screenDelta(left, right) {
  return left && right ? Math.hypot(left.x - right.x, left.y - right.y) : 0;
}

function rotationDelta(left, right) {
  return left && right
    ? Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
    : 0;
}

function assertFixedLimbSeries(label, poses, handSide = 'right', { acting = true } = {}) {
  const valid = poses.every((pose) => pose?.player?.visible && pose?.resident?.visible);
  assert(valid, `${label}: all acting beats must expose two visible posed bodies`, poses);
  for (const actor of ['player', 'resident']) {
    const neutral = poses[0]?.[actor];
    for (const pose of poses) {
      const current = pose?.[actor];
      for (const side of ['left', 'right']) {
        for (const segment of ['upperArm', 'forearm']) {
          const base = neutral?.parts?.limbs?.[side]?.[segment];
          const value = current?.parts?.limbs?.[side]?.[segment];
          assert(Number.isFinite(base) && base > 0 && Number.isFinite(value)
            && Math.abs(value / base - 1) <= 0.03,
          `${label}: ${actor} ${side} ${segment} length changed >3% from neutral`, { base, value });
        }
        for (const segment of ['Arm', 'Forearm']) {
          const base = neutral?.parts?.[`${side.toLowerCase()}${segment}`]?.scale;
          const value = current?.parts?.[`${side.toLowerCase()}${segment}`]?.scale;
          assert(base && value && ['x', 'y', 'z'].every((axis) => (
            Number.isFinite(base[axis]) && Number.isFinite(value[axis])
            && Math.abs(value[axis] / base[axis] - 1) <= 0.03
          )), `${label}: ${actor} ${side} ${segment} scale/telescoping changed >3%`, { base, value });
        }
      }
      for (const foot of ['leftSole', 'rightSole']) {
        const value = current?.parts?.[foot]?.world;
        const supportDelta = current?.parts?.[foot]?.supportDelta;
        assert(Number.isFinite(supportDelta) && Math.abs(supportDelta) <= 0.03,
          `${label}: ${actor} ${foot} hovered or sank beyond the raycast support`, {
            foot: value,
            supportY: current?.parts?.[foot]?.supportY,
            support: current?.parts?.[foot]?.support,
            supportDelta,
          });
      }
    }
  }
  if (!acting) return;
  const side = handSide === 'left' ? 'left' : 'right';
  const actingPart = `${side}Hand`;
  const armPart = `${side}Arm`;
  const windup = poses[1];
  const contact = poses[2];
  const recovery = poses[3];
  assert(screenDelta(windup?.resident?.parts?.[actingPart]?.screen, poses[0]?.resident?.parts?.[actingPart]?.screen) >= 2
    || rotationDelta(windup?.resident?.parts?.[armPart]?.rotation, poses[0]?.resident?.parts?.[armPart]?.rotation) >= 0.08,
  `${label}: windup did not produce a measurable screen/joint delta`, { poses });
  assert(screenDelta(contact?.resident?.parts?.[actingPart]?.screen, windup?.resident?.parts?.[actingPart]?.screen) >= 3
    || rotationDelta(contact?.resident?.parts?.[armPart]?.rotation, windup?.resident?.parts?.[armPart]?.rotation) >= 0.1,
  `${label}: contact did not produce a distinct acting delta`, { poses });
  assert(screenDelta(recovery?.resident?.parts?.[actingPart]?.screen, contact?.resident?.parts?.[actingPart]?.screen) >= 2
    || rotationDelta(recovery?.resident?.parts?.[armPart]?.rotation, contact?.resident?.parts?.[armPart]?.rotation) >= 0.06,
  `${label}: recovery did not visibly release the acting pose`, { poses });
}

async function intersectionProbe() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getPedestrianMeleeResponseQa?.()?.snapshot?.();
    const roots = [sim?.playerAvatar, state?.resident?.objectUuid
      ? sim?.scene?.getObjectByProperty?.('uuid', state.resident.objectUuid) : null];
    const collect = (root) => {
      const hands = ['leftHand', 'rightHand']
        .map((name) => root?.userData?.[name])
        .filter((hand) => hand?.getWorldPosition)
        .map((hand) => hand.getWorldPosition(new sim.camera.position.constructor()));
      const vertices = [];
      let skinnedMeshes = 0;
      root?.traverse?.((node) => {
        if (!node.visible || !node.isSkinnedMesh || !node.geometry?.attributes?.position
          || typeof node.getVertexPosition !== 'function') return;
        skinnedMeshes += 1;
        const position = node.geometry.attributes.position;
        const local = new sim.camera.position.constructor();
        for (let index = 0; index < position.count; index += 1) {
          node.getVertexPosition(index, local);
          const world = local.clone().applyMatrix4(node.matrixWorld);
          if (hands.some((hand) => hand.distanceTo(world) <= 0.22)) continue;
          vertices.push(world);
        }
      });
      return { vertices, skinnedMeshes };
    };
    const bodies = roots.map(collect);
    let minimumDistance = Infinity;
    let nearest = null;
    for (const left of bodies[0].vertices) for (const right of bodies[1].vertices) {
      const distance = left.distanceTo(right);
      if (distance < minimumDistance) {
        minimumDistance = distance;
        nearest = { left: { x: left.x, y: left.y, z: left.z }, right: { x: right.x, y: right.y, z: right.z } };
      }
    }
    return {
      minimumDistance,
      nearest,
      skinnedMeshes: bodies.map((body) => body.skinnedMeshes),
      vertexCounts: bodies.map((body) => body.vertices.length),
    };
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

async function capture(path, {
  reuseCamera = false,
  clearCamera = true,
  afterScreenshot = null,
} = {}) {
  const pose = reuseCamera
    ? await page.evaluate(() => window.__civilianCounterCameraPose ?? null)
    : await setCaptureCamera();
  assert(pose != null, 'capture camera could not frame the live player/resident pair');
  // The phase/event predicate has just landed.  Capture before any RAF or
  // diagnostic traversal so the PNG represents that exact authored beat.
  await page.screenshot({ path });
  const image = await stat(path);
  assert(image.size >= 100_000,
    'capture collapsed to a blank or near-empty frame', { path, bytes: image.size });
  const postScreenshot = typeof afterScreenshot === 'function'
    ? await afterScreenshot()
    : null;

  // Diagnostics intentionally follow the immutable screenshot.  Traversing
  // posed vertices and projecting framing corners can otherwise advance the
  // animation enough to capture a later pose than the event predicate.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const evidence = await page.evaluate(() => ({
    state: window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.(),
    playerVisible: window.__SF_SIM__?.playerAvatar?.visible === true,
  }));
  const framing = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getPedestrianMeleeResponseQa?.()?.snapshot?.();
    const resident = state?.resident?.objectUuid ? sim.scene?.getObjectByProperty?.('uuid', state.resident.objectUuid) : null;
    const V3 = sim?.camera?.position?.constructor;
    const cornersFor = (root) => {
      const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
      root?.traverse?.((node) => {
        if (!node.visible || !node.isMesh || !node.geometry?.attributes?.position) return;
        const pos = node.geometry.attributes.position;
        const local = node.position.clone();
        for (let index = 0; index < pos.count; index += 1) {
          if (node.isSkinnedMesh && node.getVertexPosition) node.getVertexPosition(index, local);
          else local.set(pos.getX(index), pos.getY(index), pos.getZ(index));
          const world = local.clone().applyMatrix4(node.matrixWorld);
          bounds.min.x = Math.min(bounds.min.x, world.x); bounds.min.y = Math.min(bounds.min.y, world.y); bounds.min.z = Math.min(bounds.min.z, world.z);
          bounds.max.x = Math.max(bounds.max.x, world.x); bounds.max.y = Math.max(bounds.max.y, world.y); bounds.max.z = Math.max(bounds.max.z, world.z);
        }
      });
      return bounds;
    };
    const project = (value) => {
      const point = new V3(value.x, value.y, value.z).project(sim.camera);
      return { x: (point.x * 0.5 + 0.5) * 1280, y: (-point.y * 0.5 + 0.5) * 720, z: point.z };
    };
    const body = (root) => {
      const bounds = cornersFor(root);
      let vertices = 0;
      let meshes = 0;
      let skinnedMeshes = 0;
      root?.traverse?.((node) => {
        if (!node.visible || !node.isMesh || !node.geometry?.attributes?.position) return;
        meshes += 1;
        if (node.isSkinnedMesh) skinnedMeshes += 1;
        vertices += node.geometry.attributes.position.count;
      });
      const corners = [
        [bounds.min.x, bounds.min.y, bounds.min.z], [bounds.min.x, bounds.min.y, bounds.max.z],
        [bounds.min.x, bounds.max.y, bounds.min.z], [bounds.min.x, bounds.max.y, bounds.max.z],
        [bounds.max.x, bounds.min.y, bounds.min.z], [bounds.max.x, bounds.min.y, bounds.max.z],
        [bounds.max.x, bounds.max.y, bounds.min.z], [bounds.max.x, bounds.max.y, bounds.max.z],
      ].map(([x, y, z]) => project({ x, y, z }));
      return {
        top: Math.min(...corners.map((point) => point.y)), bottom: Math.max(...corners.map((point) => point.y)),
        left: Math.min(...corners.map((point) => point.x)), right: Math.max(...corners.map((point) => point.x)),
        height: Math.max(...corners.map((point) => point.y)) - Math.min(...corners.map((point) => point.y)),
        groundY: bounds.min.y,
        rootY: root?.position?.y ?? null,
        inFront: corners.every((point) => point.z >= -1 && point.z <= 1),
        vertices,
        meshes,
        skinnedMeshes,
      };
    };
    return { player: body(sim?.playerAvatar), resident: body(resident) };
  });
  for (const [actor, body] of Object.entries(framing || {})) {
    assert(body && body.height >= 180 && body.height <= 320
      && body.left >= 20 && body.right <= 1260 && body.top >= 20 && body.bottom <= 700
      && body.inFront === true && Number.isFinite(body.groundY) && Number.isFinite(body.rootY)
      && body.meshes > 0 && body.vertices > 0
      && (actor !== 'resident' || body.skinnedMeshes > 0),
    `${actor} capture did not show a full 180–320px grounded body without clipping`, body);
  }
  assert(evidence.playerVisible && evidence.state?.captureFraming === true,
    'capture-only camera hid the live Traveler or lacked framing authority', evidence);
  if (clearCamera) {
    await page.evaluate(() => window.__SF_SIM__?.setCameraPose?.(null, null));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  return { evidence, framing, pose, postScreenshot };
}

async function waitForCounterPhase(phase, timeout = 7000) {
  await page.waitForFunction((expected) => (
    window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.()?.counter?.phase === expected
  ), phase, { timeout, polling: 16 });
  return snapshot();
}

async function runPositive() {
  const staged = await stage('positive');
  await approachWithW();
  const beforeInitialHit = await snapshot();
  const initiatingContacts = Number(beforeInitialHit.melee?.contacts ?? 0);
  assert(Number.isInteger(initiatingContacts) && initiatingContacts >= 0,
    'counter setup did not expose an integer initiating melee contact baseline', beforeInitialHit);
  await beginRootTrace();
  await tapPrimary();
  try {
    await page.waitForFunction(({ contacts, residentId, objectUuid }) => {
      const sim = window.__SF_SIM__;
      const state = sim?.getPedestrianMeleeResponseQa?.()?.snapshot?.();
      const melee = sim?.getMeleeState?.();
      return Number(melee?.contacts) === contacts + 1
        && melee?.lastReason === 'contact'
        && melee?.lastContact?.targetId === residentId
        && state?.resident?.id === residentId
        && state?.resident?.objectUuid === objectUuid;
    }, {
      contacts: initiatingContacts,
      residentId: staged.residentId,
      objectUuid: staged.residentObjectUuid,
    }, { timeout: 6000, polling: 8 });
  } catch (error) {
    const last = await snapshot();
    throw new Error(`initiating melee contact authority wait timed out: ${error.message}; lastSnapshot=${JSON.stringify(last)}`);
  }
  try {
    await page.waitForFunction(() => {
      const sim = window.__SF_SIM__;
      const state = sim?.getPedestrianMeleeResponseQa?.()?.snapshot?.();
      const melee = sim?.getMeleeState?.();
      return melee?.phase === 'idle' && state?.counter?.phase === 'awaiting-recovery';
    }, null, { timeout: 6000, polling: 8 });
  } catch (error) {
    const last = await snapshot();
    throw new Error(`initiating melee recovery/awaiting-recovery wait timed out: ${error.message}; lastSnapshot=${JSON.stringify(last)}`);
  }
  // 00-approach is the counter-ready neutral after the real initiating hit
  // has recovered, immediately before the resident enters counter windup.
  // Capture the counter-ready neutral before diagnostic/pose traversal.
  const approachCapture = await capture(capturePaths.approach, {
    clearCamera: false,
    afterScreenshot: poseSample,
  });
  const approach = await snapshot();
  const approachDistance = xzDistance(approach.qa?.player?.position, approach.qa?.resident?.position);
  assert(approach.qa?.resident?.id === staged.residentId
    && approach.qa?.resident?.objectUuid === staged.residentObjectUuid
    && Number.isFinite(approachDistance)
    && approachDistance >= 1.5 && approachDistance <= 1.9,
    'counter-ready neutral changed resident identity or fell outside grounded melee distance', {
    staged, approach: approach.qa, approachDistance,
  });
  const approachPose = approachCapture.postScreenshot;
  const before = approach;
  await waitForCounterPhase('windup');
  const windupCapture = await capture(capturePaths.windup, {
    reuseCamera: true,
    clearCamera: false,
    afterScreenshot: poseSample,
  });
  const windup = await snapshot();
  const windupPose = windupCapture.postScreenshot;
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.()?.counter?.lastEvent != null
  ), null, { timeout: 3500, polling: 16 });
  const contactCapture = await capture(capturePaths.contact, {
    reuseCamera: true,
    clearCamera: false,
    afterScreenshot: poseSample,
  });
  const contact = await snapshot();
  const contactPose = contactCapture.postScreenshot;
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
  await waitForCounterPhase('recovery', 1000);
  await page.waitForTimeout(300);
  const recoveryCapture = await capture(capturePaths.recovery, {
    reuseCamera: true,
    clearCamera: true,
    afterScreenshot: poseSample,
  });
  const recoveryPose = recoveryCapture.postScreenshot;
  await page.waitForFunction(() => {
    const counter = window.__SF_SIM__?.getPedestrianMeleeResponseQa?.()?.snapshot?.()?.counter;
    return counter?.phase === 'cooldown' && counter?.cooldownRemaining > 0;
  }, null, { timeout: 2000, polling: 16 });
  const cooldown = await snapshot();
  const rootTrace = await endRootTrace();
  assertRootTrace(rootTrace);
  const healthAtContact = contact.combat?.health;
  await page.waitForTimeout(500);
  const held = await snapshot();
  assert(held.combat?.health === healthAtContact,
    'one counter attempt damaged the player more than once', { contact, held });
  const handSide = event?.hand?.side || event?.hand?.hand || 'right';
  const capturePoseKey = (value) => JSON.stringify({ position: value?.pose?.position, lookAt: value?.pose?.lookAt });
  assert(new Set([approachCapture, windupCapture, contactCapture, recoveryCapture].map(capturePoseKey)).size === 1,
    'positive acting captures did not use one identical fixed three-quarter camera', {
      approach: approachCapture?.pose, windup: windupCapture?.pose,
      contact: contactCapture?.pose, recovery: recoveryCapture?.pose,
    });
  assertFixedLimbSeries('positive fixed-limb acting', [approachPose, windupPose, contactPose, recoveryPose], handSide);
  const intersections = await intersectionProbe();
  assert(intersections.skinnedMeshes?.every((count) => count > 0)
    && intersections.vertexCounts?.every((count) => count > 0)
    && Number.isFinite(intersections.minimumDistance)
    && intersections.minimumDistance >= 0.01,
  'positive acting pass produced non-hand posed SkinnedMesh penetration', intersections);
  return {
    staged, approach, approachPose, beforeInitialHit, before, windup, windupPose,
    contact, contactPose, recoveryPose, cooldown, held, intersections, rootTrace,
  };
}

async function runEvade() {
  await stage('evade');
  const neutralPose = await poseSample();
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
  const pose = await poseSample();
  const captureEvidence = await capture(capturePaths.evade);
  assert(after.qa?.counter?.lastEvent?.hit === false
    && after.qa?.counter?.lastEvent?.reason === 'evaded'
    && after.combat?.health === before.combat?.health,
  'real S evade did not produce a visible zero-damage whiff beyond 1.75m', { before, after });
  assertFixedLimbSeries('evade fixed-limb body', [neutralPose, pose], 'right', { acting: false });
  const intersections = await intersectionProbe();
  assert(intersections.skinnedMeshes?.every((count) => count > 0)
    && intersections.vertexCounts?.every((count) => count > 0)
    && Number.isFinite(intersections.minimumDistance)
    && intersections.minimumDistance >= 0.01,
  'evade capture produced non-hand posed SkinnedMesh penetration', intersections);
  return { before, after, neutralPose, pose, captureEvidence, intersections };
}

async function runBlocked() {
  const staged = await stage('blocked');
  // The blocked locus inherits the prior evade locomotion blend.  Observe
  // actual posed SkinnedMesh soles until that transient settles before the
  // real input; this does not mutate product state or relax the ±.03 gate.
  const neutralPose = await waitForGroundedPose(1000);
  const before = await snapshot();
  await tapPrimary();
  await page.waitForTimeout(900);
  const after = await snapshot();
  const pose = await poseSample();
  const captureEvidence = await capture(capturePaths.blocked);
  assert(staged.wallBlocked === true && after.combat?.health === before.combat?.health
    && after.qa?.counter?.lastEvent?.hit !== true,
  'real wall-blocked input caused civilian counter damage or lacked a real blocker', { staged, before, after });
  assertFixedLimbSeries('blocked fixed-limb body', [neutralPose, pose], 'right', { acting: false });
  const intersections = await intersectionProbe();
  assert(intersections.skinnedMeshes?.every((count) => count > 0)
    && intersections.vertexCounts?.every((count) => count > 0)
    && Number.isFinite(intersections.minimumDistance)
    && intersections.minimumDistance >= 0.01,
  'blocked capture produced non-hand posed SkinnedMesh penetration', intersections);
  return { staged, before, after, neutralPose, pose, captureEvidence, intersections };
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
