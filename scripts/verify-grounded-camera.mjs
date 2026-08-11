import { access, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const outputDir = process.env.SF_GROUNDED_CAMERA_DIR || '.qa-grounded-camera';
const viewport = { width: 1280, height: 720 };

if (process.platform !== 'darwin') {
  throw new Error('verify-grounded-camera requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-grounded-camera requires SF_QA_ANGLE=metal, received ${angle}`);
}
if (!executablePath) {
  throw new Error(`System Chrome is required for the Apple Metal gate: ${systemChrome}`);
}

await mkdir(outputDir, { recursive: true });
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
const captures = [];

const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};
const distance2d = (left, right) => Math.hypot(
  Number(left?.x) - Number(right?.x),
  Number(left?.z) - Number(right?.z),
);
const angleDifference = (left, right) => Math.atan2(
  Math.sin(Number(left) - Number(right)),
  Math.cos(Number(left) - Number(right)),
);

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
    requestErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
  }
});

async function launch() {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return typeof sim?.getTraversalCameraState === 'function'
      && sim.playerAvatar?.visible === true
      && sim.getTraversalCameraState()?.mode === 'walk';
  }, null, { timeout: 10000, polling: 25 });
  await page.waitForTimeout(700);
  await page.locator('#scene-canvas').focus();
}

async function waitForSettledCamera(mode) {
  await page.waitForFunction((expectedMode) => {
    const state = window.__SF_SIM__?.getTraversalCameraState?.();
    return state?.mode === expectedMode && state?.transition?.active === false;
  }, mode, { timeout: 5000, polling: 20 });
  await page.waitForTimeout(180);
}

async function startCameraRecorder() {
  await page.evaluate(() => {
    const token = {};
    const recorder = { token, active: true, samples: [] };
    window.__SF_GROUNDED_CAMERA_RECORDER__ = recorder;
    const sample = () => {
      if (window.__SF_GROUNDED_CAMERA_RECORDER__?.token !== token || !recorder.active) return;
      const sim = window.__SF_SIM__;
      const state = sim?.getTraversalCameraState?.();
      const vehicle = sim?.traffic?.getPlayerVehicleState?.() ?? null;
      if (state) {
        recorder.samples.push({
          at: performance.now(),
          mode: state.mode,
          requestedDistance: state.requestedDistance,
          actualDistance: state.actualDistance,
          yaw: state.yaw,
          pitch: state.pitch,
          camera: state.camera,
          focus: state.focus,
          transition: state.transition,
          vehicleHeading: vehicle?.heading ?? null,
          vehicleSpeed: vehicle?.speed ?? null,
        });
      }
      if (recorder.samples.length < 1800) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopCameraRecorder() {
  return page.evaluate(() => {
    const recorder = window.__SF_GROUNDED_CAMERA_RECORDER__;
    if (!recorder) return [];
    recorder.active = false;
    return recorder.samples.map((sample) => ({ ...sample }));
  });
}

function summarizeTransition(samples) {
  let maxCameraStep = 0;
  let maxYawStep = 0;
  let sampledSteps = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const prior = samples[index - 1];
    const next = samples[index];
    const deltaMs = next.at - prior.at;
    if (!(deltaMs > 0 && deltaMs <= 80)) continue;
    maxCameraStep = Math.max(maxCameraStep, Math.hypot(
      next.camera.x - prior.camera.x,
      next.camera.y - prior.camera.y,
      next.camera.z - prior.camera.z,
    ));
    maxYawStep = Math.max(maxYawStep, Math.abs(angleDifference(next.yaw, prior.yaw)));
    sampledSteps += 1;
  }
  return {
    sampleCount: samples.length,
    sampledSteps,
    maxCameraStep,
    maxYawStep,
    transitionSeen: samples.some((sample) => sample.transition?.active === true),
    modes: [...new Set(samples.map((sample) => sample.mode))],
  };
}

async function measureComposition() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim.getTraversalCameraState?.();
    const canvas = document.querySelector('#scene-canvas');
    const width = canvas?.clientWidth || window.innerWidth;
    const height = canvas?.clientHeight || window.innerHeight;
    const camera = sim.camera;

    const ancestorsVisible = (mesh, root) => {
      let node = mesh;
      while (node) {
        if (node.visible === false) return false;
        if (node === root) return true;
        node = node.parent;
      }
      return false;
    };
    const projectPoint = (point) => {
      const ndc = point.clone().project(camera);
      if (![ndc.x, ndc.y, ndc.z].every(Number.isFinite)) return null;
      return {
        x: (ndc.x + 1) * width * 0.5,
        y: (1 - ndc.y) * height * 0.5,
        z: ndc.z,
      };
    };
    const projectObject = (root) => {
      if (!root?.visible) return null;
      root.updateWorldMatrix(true, true);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let pointCount = 0;
      root.traverse((mesh) => {
        if (!mesh?.isMesh || !mesh.geometry || !ancestorsVisible(mesh, root)) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox?.();
        const box = mesh.geometry.boundingBox;
        if (!box) return;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const projected = projectPoint(box.min.clone().set(x, y, z).applyMatrix4(mesh.matrixWorld));
              if (!projected || projected.z < -1.05 || projected.z > 1.05) continue;
              minX = Math.min(minX, projected.x);
              minY = Math.min(minY, projected.y);
              maxX = Math.max(maxX, projected.x);
              maxY = Math.max(maxY, projected.y);
              pointCount += 1;
            }
          }
        }
      });
      if (!pointCount) return null;
      return {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX,
        height: maxY - minY,
        margin: Math.min(minX, minY, width - maxX, height - maxY),
        pointCount,
      };
    };

    const playerBounds = projectObject(sim.playerAvatar);
    const vehicle = sim.traffic?.getPlayerVehicleState?.() ?? null;
    const vehicleRoot = Number.isInteger(vehicle?.index)
      ? sim.traffic?.group?.children?.[vehicle.index]
      : null;
    const vehicleBounds = projectObject(vehicleRoot);
    const vehicleSurface = vehicleRoot && Number.isFinite(vehicle?.position?.y)
      ? vehicle.position.y
      : null;
    const wheelGroup = vehicleRoot?.children?.[1] ?? null;
    const wheels = [];
    if (wheelGroup?.visible !== false) {
      for (const wheel of wheelGroup?.children || []) {
        if (!wheel?.isMesh || !ancestorsVisible(wheel, vehicleRoot)) continue;
        if (!wheel.geometry.boundingBox) wheel.geometry.computeBoundingBox?.();
        const box = wheel.geometry.boundingBox;
        if (!box) continue;
        wheel.updateWorldMatrix(true, false);
        let worldMinY = Infinity;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const world = box.min.clone().set(x, y, z).applyMatrix4(wheel.matrixWorld);
              worldMinY = Math.min(worldMinY, world.y);
            }
          }
        }
        const center = projectPoint(wheel.getWorldPosition(wheel.position.clone()));
        wheels.push({
          x: center?.x ?? null,
          y: center?.y ?? null,
          onScreen: Boolean(center
            && center.z >= -1 && center.z <= 1
            && center.x >= 0 && center.x <= width
            && center.y >= 0 && center.y <= height),
          contactResidual: Number.isFinite(vehicleSurface)
            ? Math.abs(worldMinY - vehicleSurface)
            : null,
        });
      }
    }
    const contactShadow = vehicleRoot?.getObjectByName?.('Vehicle contact shadow') ?? null;

    const dx = state.camera.x - state.focus.x;
    const dy = state.camera.y - state.focus.y;
    const dz = state.camera.z - state.focus.z;
    const armDistance = Math.hypot(dx, dy, dz);
    const direction = armDistance > 1e-6
      ? { x: dx / armDistance, y: dy / armDistance, z: dz / armDistance }
      : null;
    const rayLimit = Math.max(0.01, armDistance - 0.08);
    const coreBlocker = direction
      ? sim.city?.getNearestRayBlocker?.(state.focus, direction, rayLimit) ?? null
      : null;
    const streamedBlocker = direction
      ? sim.streaming?.getNearestRayBlocker?.(state.focus, direction, rayLimit) ?? null
      : null;
    const forward = camera.getWorldDirection(camera.position.clone());
    const forwardLength = Math.hypot(forward.x, forward.z);
    const vehicleForward = vehicle
      ? { x: Math.sin(vehicle.heading), z: Math.cos(vehicle.heading) }
      : null;
    const headingDot = vehicle && forwardLength > 1e-6
      ? (forward.x * vehicleForward.x + forward.z * vehicleForward.z) / forwardLength
      : null;
    const headingError = vehicle
      ? Math.abs(Math.atan2(
        Math.sin(state.yaw - (vehicle.heading + Math.PI)),
        Math.cos(state.yaw - (vehicle.heading + Math.PI)),
      ))
      : null;

    return {
      state,
      viewport: { width, height },
      playerBounds,
      vehicle: vehicle ? {
        index: vehicle.index,
        class: vehicle.class,
        position: vehicle.position,
        heading: vehicle.heading,
        speed: vehicle.speed,
      } : null,
      vehicleBounds,
      vehicleGroundResidual: vehicleRoot && Number.isFinite(vehicleSurface)
        ? Math.abs(vehicleRoot.position.y - vehicleSurface)
        : null,
      wheels,
      contactShadow: contactShadow ? {
        visible: ancestorsVisible(contactShadow, vehicleRoot),
        name: contactShadow.name,
      } : null,
      headingDot,
      headingError,
      arm: {
        distance: armDistance,
        coreBlocker,
        streamedBlocker,
      },
    };
  });
}

function verifyClearCamera(label, measurement) {
  assert(measurement.arm.coreBlocker == null && measurement.arm.streamedBlocker == null,
    `${label} camera arm penetrated a core or streamed blocker`, measurement.arm);
  assert(measurement.state?.blocker == null
    || Number(measurement.state.blocker.clearance) >= -0.05,
  `${label} traversal snapshot reported the camera beyond its blocker`, measurement.state?.blocker);
}

function verifyWalkComposition(label, measurement) {
  assert(measurement.state?.mode === 'walk', `${label} did not report walk camera mode`, measurement.state);
  assert(measurement.state?.requestedDistance >= 8 && measurement.state.requestedDistance <= 11,
    `${label} requested walk camera distance left the 8-11m contract`, measurement.state);
  assert(measurement.state?.actualDistance >= 8 && measurement.state.actualDistance <= 11,
    `${label} actual walk camera distance left the 8-11m contract`, measurement.state);
  assert(measurement.state?.avatar?.visible === true
    && Number(measurement.state.avatar.groundResidual) <= 0.05,
  `${label} player was hidden or not grounded within 5cm`, measurement.state?.avatar);
  assert(measurement.playerBounds?.height >= 100
    && measurement.playerBounds?.margin >= 16,
  `${label} player was not a readable >=100px full-body composition`, measurement.playerBounds);
  verifyClearCamera(label, measurement);
}

async function captureHudFree(name) {
  const hud = await page.evaluate(() => {
    document.querySelector('#app')?.classList.add('is-beauty');
    const combatOverlay = document.querySelector('.combat-overlay');
    if (combatOverlay) combatOverlay.style.visibility = 'hidden';
    return Boolean(document.querySelector('.hud'));
  });
  assert(hud, 'HUD root was unavailable before a clean capture');
  await page.waitForTimeout(260);
  const opacity = await page.locator('.hud').evaluate((element) => getComputedStyle(element).opacity);
  assert(Number(opacity) === 0, `HUD was still visible in ${name} capture`, { opacity });
  const path = `${outputDir}/${name}.png`;
  await page.screenshot({ path });
  captures.push(path);
  await page.evaluate(() => {
    document.querySelector('#app')?.classList.remove('is-beauty');
    const combatOverlay = document.querySelector('.combat-overlay');
    if (combatOverlay) combatOverlay.style.visibility = '';
  });
  await page.waitForTimeout(30);
}

async function stageClearCombatTarget() {
  await page.evaluate(() => {
    window.__SF_SIM__?.setRoamPose?.({ x: 28, z: 38 });
  });
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const residents = sim.pedestrians?.getCombatCandidates?.([]) || [];
    const angles = Array.from({ length: 24 }, (_entry, index) => index * Math.PI / 12);
    let stage = null;
    for (const victim of residents) {
      const root = victim?.mesh;
      if (!root?.visible) continue;
      const victimPosition = { x: root.position.x, y: root.position.y, z: root.position.z };
      const target = { x: root.position.x, y: root.position.y + 1.18, z: root.position.z };
      for (const radius of [6, 8, 10, 12]) {
        for (const angle of angles) {
          const origin = {
            x: target.x + Math.cos(angle) * radius,
            y: victimPosition.y + 1.6,
            z: target.z + Math.sin(angle) * radius,
          };
          const dx = target.x - origin.x;
          const dy = target.y - origin.y;
          const dz = target.z - origin.z;
          const distance = Math.hypot(dx, dy, dz);
          const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
          const targetEntry = distance - (Number(victim.radius) || 0.72);
          const actorInFront = residents.some((other) => {
            if (other.id === victim.id || !other.mesh?.visible) return false;
            const ox = other.mesh.position.x - origin.x;
            const oy = other.mesh.position.y + (Number(other.height) || 1.18) - origin.y;
            const oz = other.mesh.position.z - origin.z;
            const centerDistance = ox * direction.x + oy * direction.y + oz * direction.z;
            if (centerDistance <= 0 || centerDistance >= distance) return false;
            const perpendicularSquared = ox * ox + oy * oy + oz * oz
              - centerDistance * centerDistance;
            const radiusSquared = (Number(other.radius) || 0.72) ** 2;
            if (perpendicularSquared > radiusSquared) return false;
            const entry = centerDistance
              - Math.sqrt(Math.max(0, radiusSquared - perpendicularSquared));
            return entry < targetEntry - 0.05;
          });
          if (actorInFront) continue;
          const blocker = sim.getCombatWorldBlocker?.(
            origin,
            direction,
            Math.max(0.1, distance - 0.35),
          );
          if (!blocker) {
            stage = {
              victim: {
                id: String(victim.id ?? victim.residentId),
                groupIndex: victim.groupIndex,
              },
              victimPosition,
              target,
              origin,
            };
            break;
          }
        }
        if (stage) break;
      }
      if (stage) break;
    }
    if (!stage) return null;
    sim.setRoamPose({ x: stage.origin.x, z: stage.origin.z });
    sim.pedestrians.setQaWitnessAnchor?.(stage.victim.id, stage.victimPosition);
    sim.pedestrians.update?.(0.001, performance.now() / 1000);
    sim.streetHeat?.restart?.();
    sim.combat?.restart?.();
    return stage;
  });
}

try {
  await launch();

  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string'
    && /apple.*metal|metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe)/i.test(renderer),
  'a verified Apple Metal hardware renderer was required; software rendering is rejected', {
    angle,
    renderer,
  });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.setWeather?.('clear');
    sim.streetHeat?.restart?.();
    sim.combat?.restart?.();
    sim.resetPerformanceTelemetry?.();
  });
  await waitForSettledCamera('walk');

  const walkBefore = await measureComposition();
  verifyWalkComposition('initial', walkBefore);
  const walkStart = await page.evaluate(() => window.__SF_SIM__.getRoamState().target);
  await startCameraRecorder();
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('w');
  try {
    await page.waitForFunction((start) => {
      const target = window.__SF_SIM__?.getRoamState?.().target;
      return target && Math.hypot(target.x - start.x, target.z - start.z) >= 30;
    }, walkStart, { timeout: 8000, polling: 20 });
  } finally {
    await page.keyboard.up('w').catch(() => {});
    await page.keyboard.up('ShiftLeft').catch(() => {});
  }
  const walkSamples = await stopCameraRecorder();
  await page.waitForTimeout(320);
  const walkAfter = await measureComposition();
  const walkDisplacement = distance2d(walkStart, walkAfter.state?.avatar?.position);
  verifyWalkComposition('post-traversal', walkAfter);
  assert(walkDisplacement >= 30,
    'real Shift+W traversal did not cover at least 30m', { walkStart, walkAfter, walkDisplacement });
  assert(walkSamples.length >= 30
    && walkSamples.every((sample) => sample.requestedDistance >= 8
      && sample.requestedDistance <= 11),
  'walk camera left its requested-distance contract during real traversal', {
    count: walkSamples.length,
    min: Math.min(...walkSamples.map((sample) => sample.requestedDistance)),
    max: Math.max(...walkSamples.map((sample) => sample.requestedDistance)),
  });
  await captureHudFree('walk-after-30m');

  const parked = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const roam = sim.getRoamState?.().target || { x: 0, z: 0 };
    const candidates = sim.traffic.getVehicleLifeSnapshot().vehicles.filter((candidate) => (
      candidate.visible !== false
      && candidate.class !== 'bike'
      && candidate.identity?.category === 'private'
      && candidate.action?.key === 'parked'
      && candidate.damage?.disabled !== true
    ));
    if (!candidates.length) {
      candidates.push(...sim.traffic.getVehicleLifeSnapshot().vehicles.filter((candidate) => (
      candidate.class !== 'bike'
      && candidate.identity?.category === 'private'
      && candidate.action?.key === 'parked'
      && candidate.damage?.disabled !== true
      )));
    }
    const vehicle = candidates.sort((left, right) => (
      Math.hypot(left.position.x - roam.x, left.position.z - roam.z)
      - Math.hypot(right.position.x - roam.x, right.position.z - roam.z)
    ))[0];
    if (!vehicle?.position) return null;
    sim.setRoamPose(vehicle.position);
    return vehicle;
  });
  assert(parked?.id >= 0, 'no parked private vehicle was available for real E/W driving', parked);
  if (!parked?.position) throw new Error('grounded camera vehicle staging failed');
  await page.waitForTimeout(850);
  await page.locator('#scene-canvas').focus();

  await startCameraRecorder();
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true,
    null, { timeout: 3000, polling: 20 });
  await waitForSettledCamera('drive');
  const enterSamples = await stopCameraRecorder();
  const enterTransition = summarizeTransition(enterSamples);
  assert(enterTransition.transitionSeen
    && enterTransition.sampledSteps >= 8
    && enterTransition.maxCameraStep <= 3.25,
  'walk-to-drive camera transition snapped instead of blending', enterTransition);

  const publicRoadStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.exportPlayerVehicleState?.();
    if (!snapshot || snapshot.mode !== 'driving') return null;
    snapshot.position = { x: 28, z: 38 };
    snapshot.heading = 0;
    return {
      imported: sim.traffic.importPlayerVehicleState?.(snapshot) === true,
      state: sim.traffic.getPlayerVehicleState?.() ?? null,
    };
  });
  assert(publicRoadStage?.imported === true
    && Math.hypot(
      publicRoadStage.state.position.x - 28,
      publicRoadStage.state.position.z - 38,
    ) <= 6.5,
  'the entered SUV could not be QA-staged onto the authored Ferry public road', publicRoadStage);
  if (!publicRoadStage?.imported) throw new Error('grounded camera public-road staging failed');
  await page.waitForTimeout(1200);

  const driveStart = await page.evaluate(() => window.__SF_SIM__.traffic.getPlayerVehicleState().position);
  await page.keyboard.down('w');
  try {
    await page.waitForFunction((start) => {
      const state = window.__SF_SIM__?.traffic?.getPlayerVehicleState?.();
      return state?.speed >= 2
        && Math.hypot(state.position.x - start.x, state.position.z - start.z) >= 8;
    }, driveStart, { timeout: 12000, polling: 20 });
  } finally {
    await page.keyboard.up('w').catch(() => {});
  }
  await page.waitForTimeout(320);
  const drive = await measureComposition();
  assert(drive.state?.mode === 'drive'
    && drive.state.requestedDistance >= 8.5 && drive.state.requestedDistance <= 12
    && drive.state.actualDistance >= 8.5 && drive.state.actualDistance <= 12,
  'driving camera left the 8.5-12m distance contract', drive.state);
  assert(drive.state?.avatar?.visible === false,
    'on-foot avatar remained visible through the player vehicle', drive.state?.avatar);
  assert(drive.vehicleBounds?.margin >= 16
    && drive.vehicleBounds?.height >= 55,
  'player car was clipped, off-screen, or unreadably small', drive.vehicleBounds);
  assert(drive.vehicleGroundResidual <= 0.05,
    'player car root was not grounded within 5cm', drive.vehicleGroundResidual);
  assert(drive.wheels.length >= 4
    && drive.wheels.filter((wheel) => wheel.onScreen).length >= 4,
  'the grounded drive frame did not retain four readable wheels', drive.wheels);
  assert(drive.wheels.every((wheel) => Number(wheel.contactResidual) <= 0.2)
    && drive.contactShadow?.visible === true,
  'vehicle wheel soles exceeded the 20cm authored contact envelope or lost their contact shadow', {
    wheels: drive.wheels,
    contactShadow: drive.contactShadow,
  });
  assert(drive.headingDot >= 0.9 && drive.headingError <= 0.18,
    'driving camera lost the vehicle heading', {
      headingDot: drive.headingDot,
      headingError: drive.headingError,
      vehicle: drive.vehicle,
      camera: drive.state,
    });
  verifyClearCamera('driving', drive);
  await captureHudFree('driving-full-car');

  await page.keyboard.down('s');
  try {
    await page.waitForFunction(() => (
      (window.__SF_SIM__?.traffic?.getPlayerVehicleState?.()?.speed ?? 1) <= 0.35
    ), null, { timeout: 5000, polling: 20 });
  } finally {
    await page.keyboard.up('s').catch(() => {});
  }
  const exitHeading = await page.evaluate(() => window.__SF_SIM__.traffic.getPlayerVehicleState().heading);
  await startCameraRecorder();
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === false,
    null, { timeout: 3000, polling: 20 });
  await waitForSettledCamera('walk');
  const exitSamples = await stopCameraRecorder();
  const exitTransition = summarizeTransition(exitSamples);
  const afterExit = await measureComposition();
  assert(exitTransition.transitionSeen
    && exitTransition.sampledSteps >= 8
    && exitTransition.maxCameraStep <= 3.25,
  'drive-to-walk camera transition snapped instead of blending', exitTransition);
  assert(Math.abs(angleDifference(afterExit.state?.yaw, exitHeading + Math.PI)) <= 0.18,
    'drive-to-walk transition lost the vehicle heading', { exitHeading, afterExit: afterExit.state });
  verifyWalkComposition('post-drive exit', afterExit);

  const combatStage = await stageClearCombatTarget();
  assert(combatStage?.victim?.id, 'no unobstructed live pedestrian was available for combat control', combatStage);
  if (!combatStage?.victim?.id) throw new Error('combat shoulder staging failed');
  await page.waitForTimeout(250);
  const combatBefore = await page.evaluate(() => window.__SF_SIM__.getCombatState());
  const canvasBox = await page.locator('#scene-canvas').boundingBox();
  if (!canvasBox) throw new Error('scene canvas bounds unavailable');
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.().aiming === true,
    null, { timeout: 3000, polling: 20 });
  await page.evaluate((stage) => {
    const sim = window.__SF_SIM__;
    sim.pedestrians.setQaWitnessAnchor?.(stage.victim.id, stage.victimPosition);
    const root = sim.pedestrians.group.children[stage.victim.groupIndex];
    root.position.set(stage.victimPosition.x, stage.victimPosition.y, stage.victimPosition.z);
    root.visible = true;
    root.updateMatrixWorld(true);
    sim.camera.position.set(stage.origin.x, stage.origin.y, stage.origin.z);
    sim.camera.lookAt(stage.target.x, stage.target.y, stage.target.z);
    sim.camera.updateMatrixWorld(true);
  }, combatStage);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForFunction((beforeHits) => (
    window.__SF_SIM__?.getCombatState?.().hits === beforeHits + 1
  ), combatBefore.hits, { timeout: 3000, polling: 20 });
  await page.waitForTimeout(80);
  const combatAfter = await page.evaluate((victimId) => ({
    combat: window.__SF_SIM__.getCombatState(),
    target: window.__SF_SIM__.getCombatTargetState(victimId),
    traversal: window.__SF_SIM__.getTraversalCameraState(),
  }), combatStage.victim.id);
  assert(combatAfter.combat.shots === combatBefore.shots + 1
    && combatAfter.combat.hits === combatBefore.hits + 1
    && combatAfter.combat.camera?.mode === 'shoulder-aim'
    && combatAfter.combat.weapon?.visible === true
    && combatAfter.traversal?.mode === 'aim'
    && combatAfter.target?.hits >= 1,
  'real RMB/LMB no longer registered through the combat shoulder camera', {
    combatBefore,
    combatAfter,
  });
  await page.mouse.up({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getTraversalCameraState?.().mode === 'walk',
    null, { timeout: 3000, polling: 20 });

  await page.waitForTimeout(1800);
  const performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'grounded camera verification exceeded the 16.67ms application p99 budget', performance);
  assert(consoleErrors.length === 0, 'page/console errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestErrors.length === 0, 'request failures occurred', requestErrors);

  const report = {
    result: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestErrors.length === 0
      ? 'grounded camera gate passed'
      : 'grounded camera gate failed',
    baseUrl,
    angle,
    renderer,
    walk: {
      displacement: walkDisplacement,
      before: walkBefore,
      after: walkAfter,
      samples: summarizeTransition(walkSamples),
    },
    transitions: { enter: enterTransition, exit: exitTransition },
    drive,
    afterExit,
    combat: { stage: combatStage, before: combatBefore, after: combatAfter },
    captures,
    performance,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'grounded camera gate passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'grounded camera gate failed',
    error: error.message,
    stack: error.stack,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await page.keyboard.up('w').catch(() => {});
  await page.keyboard.up('s').catch(() => {});
  await page.keyboard.up('ShiftLeft').catch(() => {});
  await page.mouse.up({ button: 'left' }).catch(() => {});
  await page.mouse.up({ button: 'right' }).catch(() => {});
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
