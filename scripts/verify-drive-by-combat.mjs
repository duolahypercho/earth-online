import { access, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const outputDir = process.env.SF_DRIVE_BY_COMBAT_DIR || '.qa-drive-by-combat';
const viewport = { width: 1280, height: 720 };

if (process.platform !== 'darwin') {
  throw new Error('verify-drive-by-combat requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-drive-by-combat requires SF_QA_ANGLE=metal, received ${angle}`);
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
let renderer = null;
let scenario = null;
let samples = [];
let performanceSnapshot = null;
let preAimClearance = null;

const finite = (value) => Number.isFinite(value);
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail == null ? {} : { detail }) });
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
    return typeof sim?.getCombatState === 'function'
      && typeof sim?.getCombatWorldBlocker === 'function'
      && typeof sim?.traffic?.getVehicleLifeSnapshot === 'function'
      && typeof sim?.pedestrians?.getCombatCandidates === 'function'
      && sim.playerAvatar?.visible === true;
  }, null, { timeout: 12000, polling: 25 });
  await page.waitForTimeout(700);
  await page.locator('#scene-canvas').focus();
}

async function capture(name) {
  const path = `${outputDir}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  captures.push(path);
  return path;
}

async function readPlayerVehicleClearance() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const vehicle = sim?.traffic?.getPlayerVehicleState?.();
    const root = Number.isInteger(vehicle?.index)
      ? sim.traffic.group?.children?.[vehicle.index]
      : null;
    if (!root?.visible) return null;
    const readBox = (object) => {
      const box = {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
      };
      object.updateWorldMatrix(true, true);
      object.traverse((mesh) => {
        if (!mesh?.isMesh || !mesh.visible || !mesh.geometry) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox?.();
        const bounds = mesh.geometry.boundingBox;
        if (!bounds) return;
        for (const x of [bounds.min.x, bounds.max.x]) {
          for (const y of [bounds.min.y, bounds.max.y]) {
            for (const z of [bounds.min.z, bounds.max.z]) {
              const point = mesh.position.clone().set(x, y, z).applyMatrix4(mesh.matrixWorld);
              box.min.x = Math.min(box.min.x, point.x);
              box.min.y = Math.min(box.min.y, point.y);
              box.min.z = Math.min(box.min.z, point.z);
              box.max.x = Math.max(box.max.x, point.x);
              box.max.y = Math.max(box.max.y, point.y);
              box.max.z = Math.max(box.max.z, point.z);
            }
          }
        }
      });
      return Number.isFinite(box.min.x) ? box : null;
    };
    const own = readBox(root);
    if (!own) return null;
    let minimum = Infinity;
    let nearestId = null;
    for (let index = 0; index < sim.traffic.group.children.length; index += 1) {
      if (index === vehicle.index) continue;
      const otherRoot = sim.traffic.group.children[index];
      if (!otherRoot?.visible || otherRoot.userData?.qaDriveByHidden === true) continue;
      const other = readBox(otherRoot);
      if (!other) continue;
      const gapX = Math.max(own.min.x - other.max.x, other.min.x - own.max.x, 0);
      const gapY = Math.max(own.min.y - other.max.y, other.min.y - own.max.y, 0);
      const gapZ = Math.max(own.min.z - other.max.z, other.min.z - own.max.z, 0);
      const gap = Math.hypot(gapX, gapY, gapZ);
      if (gap < minimum) {
        minimum = gap;
        nearestId = index;
      }
    }
    return { minimum, nearestId };
  });
}

async function beginQaPracticeDrive() {
  const prepared = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const vehicle = sim.traffic.getVehicleLifeSnapshot().vehicles.find((candidate) => (
      candidate.class !== 'bike'
      && candidate.identity?.category === 'private'
      && candidate.action?.key === 'parked'
      && candidate.damage?.disabled !== true
    ));
    if (!vehicle?.position) return null;
    sim.setRoamPose(vehicle.position);
    return { id: vehicle.id, class: vehicle.class, identity: vehicle.identity };
  });
  if (!prepared) return null;
  await page.waitForTimeout(600);
  const entered = await page.evaluate(() => window.__SF_SIM__?.enterCar?.() === true);
  if (!entered) return { ...prepared, entered: false };
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true,
    null, { timeout: 3000, polling: 20 });
  const roadStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.exportPlayerVehicleState?.();
    if (!snapshot || snapshot.mode !== 'driving') return null;
    // Start close enough to the authored California/Market turn that real
    // W+A can cover 8m and change heading after the stop line, without the
    // traffic-citation path obscuring the combat consequence under test.
    snapshot.position = { x: 28, z: 48 };
    snapshot.heading = 0;
    snapshot.theftReported = false;
    const imported = sim.traffic.importPlayerVehicleState?.(snapshot) === true;
    return {
      imported,
      resetSnapshot: snapshot,
      state: sim.traffic.getPlayerVehicleState?.() ?? null,
    };
  });
  return { ...prepared, entered, roadStage };
}

async function runPracticeTurn(start) {
  await page.locator('#scene-canvas').focus();
  await page.keyboard.down('w');
  await page.keyboard.down('a');
  try {
    await page.waitForFunction((origin) => {
      const state = window.__SF_SIM__?.traffic?.getPlayerVehicleState?.();
      if (!state) return false;
      const displacement = Math.hypot(
        state.position.x - origin.position.x,
        state.position.z - origin.position.z,
      );
      const headingChange = Math.abs(Math.atan2(
        Math.sin(state.heading - origin.heading),
        Math.cos(state.heading - origin.heading),
      ));
      return displacement >= 8 && state.speed >= 2 && headingChange >= 0.18;
    }, start, { timeout: 16000, polling: 20 });
  } finally {
    await page.keyboard.up('a').catch(() => {});
    await page.keyboard.up('w').catch(() => {});
  }
  return page.evaluate(() => window.__SF_SIM__?.traffic?.getPlayerVehicleState?.() ?? null);
}

async function finishQaScenario(prepared, predicted) {
  return page.evaluate(({ resetSnapshot, predictedState }) => {
    const sim = window.__SF_SIM__;
    const reset = structuredClone(resetSnapshot);
    reset.theftReported = false;
    if (sim.traffic.importPlayerVehicleState?.(reset) !== true) return null;
    const resetVehicle = sim.traffic.getPlayerVehicleState?.();
    if (!resetVehicle || sim.exitCar?.() !== true) return null;

    const candidates = sim.pedestrians.getCombatCandidates?.([]) || [];
    const forward = {
      x: Math.sin(predictedState.heading),
      z: Math.cos(predictedState.heading),
    };
    const right = { x: forward.z, z: -forward.x };
    let staged = null;
    for (const victim of candidates) {
      const root = sim.pedestrians.group?.children?.[victim.groupIndex];
      if (!root?.visible) continue;
      for (const distance of [16, 18, 20]) {
        for (const lateral of [0, 2.8, -2.8, 5, -5]) {
          const x = predictedState.position.x + forward.x * distance + right.x * lateral;
          const z = predictedState.position.z + forward.z * distance + right.z * lateral;
          const surface = sim.city?.getSurfaceHeight?.({ x, z })
            ?? sim.streaming?.getSurfaceHeight?.({ x, z });
          if (!Number.isFinite(surface)
            || Math.abs(surface - predictedState.position.y) > 1.2) continue;
          const victimPosition = { x, y: surface, z };
          if (sim.pedestrians.setQaWitnessAnchor?.(victim.id, victimPosition) !== true) continue;
          root.position.set(x, surface, z);
          root.visible = true;
          root.updateMatrixWorld(true);
          sim.pedestrians.update?.(0.001, performance.now() / 1000);
          const witness = sim.pedestrians.getIncidentWitness?.(victim.id, 18) ?? null;
          if (!witness?.id) continue;
          const origin = {
            x: predictedState.position.x,
            y: predictedState.position.y + 2.35,
            z: predictedState.position.z,
          };
          const target = { x, y: surface + 1.18, z };
          const dx = target.x - origin.x;
          const dy = target.y - origin.y;
          const dz = target.z - origin.z;
          const rayDistance = Math.hypot(dx, dy, dz);
          const blocker = sim.getCombatWorldBlocker?.(
            origin,
            { x: dx / rayDistance, y: dy / rayDistance, z: dz / rayDistance },
            Math.max(0.1, rayDistance - 0.4),
          );
          if (blocker) continue;
          staged = {
            victim: {
              id: String(victim.id ?? victim.residentId),
              groupIndex: victim.groupIndex,
              label: victim.label,
            },
            witness: {
              id: witness.id,
              label: witness.label,
              distance: witness.distance,
            },
            victimPosition,
            target,
            predictedShotOrigin: origin,
            predictedDistance: rayDistance,
          };
          break;
        }
        if (staged) break;
      }
      if (staged) break;
    }
    if (!staged) return null;

    const parked = sim.traffic.getVehicleLifeSnapshot().vehicles.find(
      (vehicle) => vehicle.id === resetVehicle.index,
    );
    if (!parked?.position) return null;
    sim.setRoamPose(parked.position);
    sim.streetHeat?.restart?.();
    sim.combat?.restart?.();
    sim.pedestrians.setQaWitnessAnchor?.(staged.victim.id, staged.victimPosition);
    sim.pedestrians.update?.(0.001, performance.now() / 1000);
    const hiddenVehicleIds = [];
    for (const vehicle of sim.traffic.getVehicleLifeSnapshot().vehicles) {
      if (vehicle.id === resetVehicle.index || vehicle.visible !== true || !vehicle.position) continue;
      if (Math.hypot(
        vehicle.position.x - predictedState.position.x,
        vehicle.position.z - predictedState.position.z,
      ) > 14) continue;
      const root = sim.traffic.group?.children?.[vehicle.id];
      if (!root) continue;
      root.visible = false;
      root.scale.setScalar(0.001);
      root.updateMatrixWorld(true);
      root.userData.qaDriveByHidden = true;
      hiddenVehicleIds.push(vehicle.id);
    }
    return {
      ...staged,
      vehicle: {
        id: resetVehicle.index,
        class: resetVehicle.class,
        position: parked.position,
        heading: parked.heading,
      },
      hiddenVehicleIds,
      roam: sim.getRoamState?.() ?? null,
    };
  }, { resetSnapshot: prepared.roadStage.resetSnapshot, predictedState: predicted });
}

async function startRecorder() {
  await page.evaluate(() => {
    const token = {};
    const recorder = { token, active: true, samples: [] };
    window.__SF_DRIVE_BY_RECORDER__ = recorder;
    const sample = () => {
      if (window.__SF_DRIVE_BY_RECORDER__?.token !== token || !recorder.active) return;
      const sim = window.__SF_SIM__;
      const vehicle = sim?.traffic?.getPlayerVehicleState?.() ?? null;
      const combat = sim?.getCombatState?.() ?? null;
      const lifeVehicle = Number.isInteger(vehicle?.index)
        ? sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => entry.id === vehicle.index)
        : null;
      const driveBy = combat?.driveBy ?? sim?.getDriveByCombatState?.() ?? null;
      recorder.samples.push({
        at: performance.now(),
        driving: sim?.isDriving?.() === true,
        vehicle,
        aiming: combat?.aiming === true,
        shots: combat?.shots ?? null,
        hits: combat?.hits ?? null,
        driveBy,
        indicators: lifeVehicle?.indicators ?? null,
        heat: sim?.getStreetHeatState?.() ?? null,
        responders: sim?.traffic?.getPursuitResponders?.() ?? [],
      });
      if (recorder.samples.length < 900) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopRecorder() {
  return page.evaluate(() => {
    const recorder = window.__SF_DRIVE_BY_RECORDER__;
    if (!recorder) return [];
    recorder.active = false;
    return recorder.samples.map((sample) => structuredClone(sample));
  });
}

async function projectVictim(victim) {
  return page.evaluate(({ groupIndex }) => {
    const sim = window.__SF_SIM__;
    const root = sim.pedestrians?.group?.children?.[groupIndex];
    if (!root?.visible) return null;
    root.updateWorldMatrix(true);
    const world = root.position.clone();
    world.y += 1.18;
    const projected = world.clone().project(sim.camera);
    return {
      x: (projected.x + 1) * window.innerWidth * 0.5,
      y: (1 - projected.y) * window.innerHeight * 0.5,
      depth: projected.z,
      visible: projected.z >= -1 && projected.z <= 1
        && projected.x >= -1 && projected.x <= 1
        && projected.y >= -1 && projected.y <= 1,
      world: { x: world.x, y: world.y, z: world.z },
    };
  }, victim);
}

async function aimAtVictim(victim, canvas) {
  let pointer = { x: canvas.x + canvas.width * 0.5, y: canvas.y + canvas.height * 0.5 };
  let projection = null;
  for (let index = 0; index < 10; index += 1) {
    projection = await projectVictim(victim);
    if (projection?.visible
      && Math.abs(projection.x - viewport.width / 2) <= 5
      && Math.abs(projection.y - viewport.height / 2) <= 5) break;
    if (!projection || !finite(projection.x) || !finite(projection.y)) break;
    const correctionX = Math.max(-120, Math.min(120, projection.x - viewport.width / 2));
    const correctionY = Math.max(-90, Math.min(90, projection.y - viewport.height / 2));
    pointer = {
      x: Math.max(canvas.x + 8, Math.min(canvas.x + canvas.width - 8, pointer.x + correctionX)),
      y: Math.max(canvas.y + 8, Math.min(canvas.y + canvas.height - 8, pointer.y + correctionY)),
    };
    await page.mouse.move(pointer.x, pointer.y, { steps: 3 });
    await page.waitForTimeout(35);
  }
  return projection;
}

async function readEvidence(victim, witnessId) {
  return page.evaluate(({ target, witness }) => {
    const sim = window.__SF_SIM__;
    const combat = sim.getCombatState?.() ?? null;
    const driveBy = combat?.driveBy ?? sim.getDriveByCombatState?.() ?? null;
    const vehicle = sim.traffic.getPlayerVehicleState?.() ?? null;
    const vehicleRoot = Number.isInteger(vehicle?.index)
      ? sim.traffic.group?.children?.[vehicle.index]
      : null;
    const canvas = sim.renderer?.domElement;
    const width = canvas?.clientWidth || window.innerWidth;
    const height = canvas?.clientHeight || window.innerHeight;

    const nodeVisible = (node, root) => {
      let current = node;
      while (current) {
        if (current.visible === false) return false;
        if (current === root) return true;
        current = current.parent;
      }
      return false;
    };
    const readLocalBounds = (root) => {
      if (!root) return null;
      root.updateWorldMatrix(true, true);
      const inverse = root.matrixWorld.clone().invert();
      const min = { x: Infinity, y: Infinity, z: Infinity };
      const max = { x: -Infinity, y: -Infinity, z: -Infinity };
      let count = 0;
      root.traverse((mesh) => {
        if (!mesh?.isMesh || !mesh.geometry || !nodeVisible(mesh, root)) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox?.();
        const box = mesh.geometry.boundingBox;
        if (!box) return;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const point = box.min.clone().set(x, y, z)
                .applyMatrix4(mesh.matrixWorld)
                .applyMatrix4(inverse);
              min.x = Math.min(min.x, point.x);
              min.y = Math.min(min.y, point.y);
              min.z = Math.min(min.z, point.z);
              max.x = Math.max(max.x, point.x);
              max.y = Math.max(max.y, point.y);
              max.z = Math.max(max.z, point.z);
              count += 1;
            }
          }
        }
      });
      return count ? { min, max } : null;
    };
    const bounds = readLocalBounds(vehicleRoot);
    const pointRelation = (position) => {
      if (!position || !vehicleRoot || !bounds) return null;
      const point = sim.camera.position.clone().set(position.x, position.y, position.z);
      const local = vehicleRoot.worldToLocal(point);
      const inside = local.x >= bounds.min.x && local.x <= bounds.max.x
        && local.y >= bounds.min.y && local.y <= bounds.max.y
        && local.z >= bounds.min.z && local.z <= bounds.max.z;
      const outsideX = Math.max(bounds.min.x - local.x, 0, local.x - bounds.max.x);
      const outsideY = Math.max(bounds.min.y - local.y, 0, local.y - bounds.max.y);
      const outsideZ = Math.max(bounds.min.z - local.z, 0, local.z - bounds.max.z);
      return {
        inside,
        clearance: Math.hypot(outsideX, outsideY, outsideZ),
        local: { x: local.x, y: local.y, z: local.z },
      };
    };
    const projectVehicle = (root) => {
      if (!root?.visible) return null;
      root.updateWorldMatrix(true, true);
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      let count = 0;
      root.traverse((mesh) => {
        if (!mesh?.isMesh || !mesh.geometry || !nodeVisible(mesh, root)) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox?.();
        const box = mesh.geometry.boundingBox;
        if (!box) return;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const point = box.min.clone().set(x, y, z).applyMatrix4(mesh.matrixWorld).project(sim.camera);
              if (![point.x, point.y, point.z].every(Number.isFinite)
                || point.z < -1.05 || point.z > 1.05) continue;
              const screenX = (point.x + 1) * width * 0.5;
              const screenY = (1 - point.y) * height * 0.5;
              left = Math.min(left, screenX);
              right = Math.max(right, screenX);
              top = Math.min(top, screenY);
              bottom = Math.max(bottom, screenY);
              count += 1;
            }
          }
        }
      });
      return count ? {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
        margin: Math.min(left, top, width - right, height - bottom),
        pointCount: count,
      } : null;
    };
    const muzzle = driveBy?.muzzle?.position
      ?? (Number.isFinite(driveBy?.muzzle?.x)
        && Number.isFinite(driveBy?.muzzle?.y)
        && Number.isFinite(driveBy?.muzzle?.z) ? driveBy.muzzle : null)
      ?? driveBy?.weapon?.muzzle?.position
      ?? driveBy?.weapon?.muzzlePosition
      ?? null;
    const traversal = sim.getTraversalCameraState?.() ?? null;
    const focus = traversal?.focus
      ? sim.camera.position.clone().set(traversal.focus.x, traversal.focus.y, traversal.focus.z)
      : null;
    const cameraDelta = focus ? sim.camera.position.clone().sub(focus) : null;
    const cameraDistance = cameraDelta?.length?.() ?? 0;
    const cameraBlocker = cameraDistance > 0.1
      ? sim.getCombatWorldBlocker?.(
        focus,
        cameraDelta.clone().multiplyScalar(1 / cameraDistance),
        Math.max(0.01, cameraDistance - 0.08),
      ) ?? null
      : null;
    const cameraSurface = sim.city?.getSurfaceHeight?.(sim.camera.position)
      ?? sim.streaming?.getSurfaceHeight?.(sim.camera.position);
    const reticleElement = document.querySelector('.combat-reticle');
    const reticleRect = reticleElement?.getBoundingClientRect?.() ?? null;
    const reticleStyle = reticleElement ? getComputedStyle(reticleElement) : null;
    const victimRoot = sim.pedestrians.group?.children?.[target.groupIndex];
    const responders = sim.traffic.getPursuitResponders?.() ?? [];
    const fleet = sim.traffic.getVehicleLifeSnapshot?.()?.vehicles ?? [];
    return {
      combat,
      driveBy,
      vehicle,
      lifeVehicle: Number.isInteger(vehicle?.index)
        ? sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => entry.id === vehicle.index)
        : null,
      vehicleScreen: projectVehicle(vehicleRoot),
      camera: {
        position: { x: sim.camera.position.x, y: sim.camera.position.y, z: sim.camera.position.z },
        surface: Number.isFinite(cameraSurface) ? cameraSurface : null,
        surfaceClearance: Number.isFinite(cameraSurface)
          ? sim.camera.position.y - cameraSurface
          : null,
        blocker: cameraBlocker,
        vehicleRelation: pointRelation(sim.camera.position),
      },
      muzzle: { position: muzzle, vehicleRelation: pointRelation(muzzle) },
      reticle: reticleRect ? {
        visible: reticleStyle?.display !== 'none'
          && reticleStyle?.visibility !== 'hidden'
          && Number(reticleStyle?.opacity) > 0.01,
        x: (reticleRect.left + reticleRect.right) * 0.5,
        y: (reticleRect.top + reticleRect.bottom) * 0.5,
      } : null,
      targetState: sim.getCombatTargetState?.(target.id) ?? null,
      targetReaction: victimRoot ? {
        visible: victimRoot.visible,
        hitCount: victimRoot.userData?.combatHitCount ?? 0,
        reaction: victimRoot.userData?.combatReaction ?? null,
        reactionSource: victimRoot.userData?.combatReactionSource ?? null,
      } : null,
      witness: sim.pedestrians.getWitnessState?.(witness) ?? null,
      heat: sim.getStreetHeatState?.() ?? null,
      responders,
      responderVehicles: responders.map((responder) => ({
        responder,
        vehicle: fleet.find((entry) => entry.id === responder.id) ?? null,
      })),
    };
  }, { target: victim, witness: witnessId });
}

function verifyDriveByEmbodiment(label, evidence) {
  const driveBy = evidence?.driveBy;
  const weapon = driveBy?.weapon;
  const camera = driveBy?.camera;
  assert(driveBy && typeof driveBy === 'object',
    `${label}: getCombatState().driveBy telemetry is missing`, evidence?.combat);
  if (!driveBy) return;
  assert(driveBy.active === true && driveBy.aiming === true,
    `${label}: drive-by aim was not active`, driveBy);
  assert(driveBy?.driverForearmVisible === true,
    `${label}: the driver's aiming forearm was not visible at the window`, driveBy);
  assert(weapon?.visible === true
    && weapon?.connected === true
    && finite(weapon?.gripSocketDistance)
    && weapon.gripSocketDistance <= 0.08,
  `${label}: sidearm was not visibly connected to the driver socket`, weapon);
  assert(evidence.muzzle?.position
    && evidence.muzzle?.vehicleRelation?.inside === false
    && Number(evidence.muzzle?.vehicleRelation?.clearance) >= 0.02,
  `${label}: muzzle did not clear the live vehicle body`, evidence.muzzle);
  assert(driveBy?.muzzle?.outsideVehicle === true
    || weapon?.muzzle?.outsideVehicle === true,
  `${label}: product telemetry did not confirm an outside-vehicle muzzle`, driveBy);
  assert(evidence.reticle?.visible === true
    && Math.abs(evidence.reticle.x - viewport.width / 2) <= 2
    && Math.abs(evidence.reticle.y - viewport.height / 2) <= 2,
  `${label}: combat reticle was not centered at 1280x720`, evidence.reticle);
  assert(evidence.vehicleScreen?.pointCount >= 16
    && evidence.vehicleScreen.margin >= 12
    && evidence.vehicleScreen.width >= 180
    && evidence.vehicleScreen.height >= 80,
  `${label}: player car was clipped or not fully readable`, evidence.vehicleScreen);
  assert(evidence.camera?.blocker == null
    && evidence.camera?.vehicleRelation?.inside === false
    && finite(evidence.camera?.surfaceClearance)
    && evidence.camera.surfaceClearance >= 0.9,
  `${label}: drive-by camera penetrated world/vehicle geometry or fell below the street`, evidence.camera);
  assert(camera?.collisionSafe === true
    && camera?.insideWorld === false
    && camera?.insideVehicle === false,
  `${label}: product drive-by camera telemetry was not fail-closed`, camera);
}

try {
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

  const prepared = await beginQaPracticeDrive();
  assert(prepared?.entered === true && prepared?.roadStage?.imported === true,
    'QA could not prepare an existing private vehicle on the deterministic core road', prepared);
  if (!prepared?.roadStage?.imported) throw new Error('drive-by vehicle setup failed');
  const predicted = await runPracticeTurn(prepared.roadStage.state);
  assert(predicted?.speed >= 2
    && distance2d(predicted?.position, prepared.roadStage.state?.position) >= 8
    && Math.abs(angleDifference(predicted?.heading, prepared.roadStage.state?.heading)) >= 0.18,
  'QA practice chord did not establish a moving turn trajectory', { prepared, predicted });
  scenario = await finishQaScenario(prepared, predicted);
  assert(scenario?.victim?.id && scenario?.witness?.id && Number.isInteger(scenario?.vehicle?.id),
    'QA could not stage a live unoccluded target/witness ahead of the practiced turn', scenario);
  if (!scenario?.victim?.id) throw new Error('drive-by target/witness setup failed');
  await page.waitForTimeout(500);
  await page.locator('#scene-canvas').focus();

  const initial = await readEvidence(scenario.victim, scenario.witness.id);
  assert(initial?.heat?.heat === 0 && initial?.combat?.shots === 0,
    'measured drive-by phase did not begin from clear heat/combat state', initial);
  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await startRecorder();

  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true,
    null, { timeout: 4000, polling: 20 });
  const entered = await readEvidence(scenario.victim, scenario.witness.id);
  assert(entered?.vehicle?.index === scenario.vehicle.id
    && entered?.heat?.heat >= 17.5
    && entered?.heat?.heat < 30
    && entered?.heat?.pursuitActive === false,
  'real E did not enter/report the staged private car before the shot', entered);

  const measuredStart = entered.vehicle;
  await page.keyboard.down('w');
  await page.keyboard.down('a');
  await page.waitForFunction((origin) => {
    const state = window.__SF_SIM__?.traffic?.getPlayerVehicleState?.();
    if (!state) return false;
    return state.speed >= 2
      && Math.hypot(state.position.x - origin.position.x, state.position.z - origin.position.z) >= 8
      && Math.abs(Math.atan2(
        Math.sin(state.heading - origin.heading),
        Math.cos(state.heading - origin.heading),
      )) >= 0.18;
  }, measuredStart, { timeout: 16000, polling: 20 });
  preAimClearance = await readPlayerVehicleClearance();
  assert(preAimClearance?.minimum >= 0.35,
    'the measured player vehicle overlapped another live traffic body before aiming',
    preAimClearance);
  const preAim = await readEvidence(scenario.victim, scenario.witness.id);
  await capture('moving-turn');

  const lockedPair = await page.evaluate(({ victim, victimPosition }) => {
    const sim = window.__SF_SIM__;
    const witness = sim?.pedestrians?.getIncidentWitness?.(victim.id, 18) ?? null;
    if (!witness?.id || sim.pedestrians.setQaWitnessAnchor?.(witness.id, witness.position) !== true) {
      return null;
    }
    const root = sim.pedestrians.group?.children?.[victim.groupIndex];
    if (!root?.visible) return null;
    root.position.set(victimPosition.x, victimPosition.y, victimPosition.z);
    root.updateMatrixWorld(true);
    return witness;
  }, { victim: scenario.victim, victimPosition: scenario.victimPosition });
  assert(lockedPair?.id,
    'QA could not lock a live witness beside the moving drive-by target',
    lockedPair);
  if (lockedPair?.id) scenario.witness = lockedPair;

  const canvas = await page.locator('#scene-canvas').boundingBox();
  if (!canvas) throw new Error('scene canvas bounds unavailable for real RMB/LMB input');
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => {
    const combat = window.__SF_SIM__?.getCombatState?.();
    const driveBy = combat?.driveBy ?? window.__SF_SIM__?.getDriveByCombatState?.();
    return combat?.aiming === true && driveBy?.active === true && driveBy?.aiming === true;
  }, null, { timeout: 5000, polling: 20 });
  const projection = await aimAtVictim(scenario.victim, canvas);
  assert(projection?.visible === true
    && Math.abs(projection.x - viewport.width / 2) <= 5
    && Math.abs(projection.y - viewport.height / 2) <= 5,
  'real RMB mouse movement could not align the staged live target with the reticle', projection);
  const aimed = await readEvidence(scenario.victim, scenario.witness.id);
  verifyDriveByEmbodiment('moving aim', aimed);
  await capture('drive-by-aim');

  let projectionBeforeShot = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    projectionBeforeShot = await aimAtVictim(scenario.victim, canvas);
    if (projectionBeforeShot?.visible === true
      && Math.abs(projectionBeforeShot.x - viewport.width / 2) <= 12
      && Math.abs(projectionBeforeShot.y - viewport.height / 2) <= 12) break;
    await page.waitForTimeout(16);
  }
  assert(projectionBeforeShot?.visible === true
    && Math.abs(projectionBeforeShot.x - viewport.width / 2) <= 12
    && Math.abs(projectionBeforeShot.y - viewport.height / 2) <= 12,
  'the moving target left the center ray before the real LMB press', projectionBeforeShot);
  const beforeShot = await readEvidence(scenario.victim, scenario.witness.id);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  const targetHit = await page.waitForFunction(({ shots, hits, victimId }) => {
    const sim = window.__SF_SIM__;
    const combat = sim?.getCombatState?.();
    return combat?.shots === shots + 1
      && combat?.hits === hits + 1
      && combat?.lastHit?.targetId === victimId;
  }, {
    shots: beforeShot.combat.shots,
    hits: beforeShot.combat.hits,
    victimId: scenario.victim.id,
  }, { timeout: 2500, polling: 20 }).then(() => true).catch(() => false);
  const pursuitReady = await page.waitForFunction((victimId) => {
    const sim = window.__SF_SIM__;
    return sim?.getStreetHeatState?.()?.pursuitActive === true
      && sim?.traffic?.getPursuitResponders?.()?.length > 0
      && sim?.getCombatState?.()?.lastHit?.targetId === victimId;
  }, scenario.victim.id, { timeout: 3000, polling: 20 }).then(() => true).catch(() => false);
  const impact = await readEvidence(scenario.victim, scenario.witness.id);
  verifyDriveByEmbodiment('impact', impact);
  await capture('drive-by-impact');

  assert(targetHit
    && impact.combat.shots === beforeShot.combat.shots + 1
    && impact.combat.ammo === beforeShot.combat.ammo - 1
    && impact.combat.hits === beforeShot.combat.hits + 1
    && impact.combat.lastHit?.targetId === scenario.victim.id,
  'real LMB did not produce exactly one shot/ammo/target-hit delta', { beforeShot, impact });
  assert(impact.targetState?.hits === (beforeShot.targetState?.hits ?? 0) + 1
    && impact.targetReaction?.hitCount === (beforeShot.targetReaction?.hitCount ?? 0) + 1
    && ['hit-react', 'staggered'].includes(impact.targetReaction?.reaction),
  'the staged live resident did not visibly register the drive-by hit', {
    before: beforeShot.targetReaction,
    after: impact.targetReaction,
    targetState: impact.targetState,
  });
  assert(pursuitReady
    && impact.heat?.heat >= 30
    && impact.heat?.pursuitActive === true
    && impact.heat?.witnessReports >= 1
    && impact.witness?.active === true,
  'the drive-by hit/witness did not cross the pursuit threshold', {
    before: beforeShot.heat,
    after: impact.heat,
    witness: impact.witness,
  });
  assert(impact.responders.length >= 1
    && impact.responders.every((responder) => responder.active === true)
    && impact.responderVehicles.some(({ responder, vehicle }) => (
      impact.lifeVehicle?.id !== responder.id
      && finite(responder.distance)
      && responder.distance > 0
      && vehicle?.visible === true
      && vehicle?.pursuit?.active === true
    )),
  'pursuit began without a distinct visible live traffic responder', {
    responders: impact.responders,
    responderVehicles: impact.responderVehicles,
  });

  await page.waitForFunction(() => (
    (window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0) >= 180
  ), null, { timeout: 12000, polling: 50 });
  performanceSnapshot = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  samples = await stopRecorder();

  const aimSamples = samples.filter((sample) => sample.aiming && sample.vehicle);
  const aimStart = aimSamples[0]?.vehicle;
  const aimEnd = aimSamples.at(-1)?.vehicle;
  const movingAimSamples = aimSamples.filter((sample) => (
    sample.vehicle.speed >= 2
      && (sample.indicators?.left === true || sample.indicators?.right === true)
      && sample.driveBy?.active === true
  ));
  assert(distance2d(preAim.vehicle?.position, measuredStart.position) >= 8
    && preAim.vehicle?.speed >= 2
    && Math.abs(angleDifference(preAim.vehicle?.heading, measuredStart.heading)) >= 0.18,
  'measured real W+A did not cover 8m at speed with a heading change', {
    start: measuredStart,
    preAim: preAim.vehicle,
  });
  assert(aimSamples.length >= 8
    && movingAimSamples.length >= 6
    && distance2d(aimStart?.position, aimEnd?.position) >= 0.35,
  'throttle/steer motion did not continue while real RMB aim was active', {
    aimSampleCount: aimSamples.length,
    movingAimSampleCount: movingAimSamples.length,
    aimStart,
    aimEnd,
  });
  assert(performanceSnapshot?.applicationFrameCount >= 180
    && finite(performanceSnapshot?.applicationP99FrameMs)
    && performanceSnapshot.applicationP99FrameMs <= 16.67,
  'moving drive-by verification exceeded the 16.67ms application p99 budget', performanceSnapshot);
  assert(consoleErrors.length === 0, 'page/console errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestErrors.length === 0, 'request failures occurred', requestErrors);

  const summarizeEvidence = (evidence) => ({
    combat: evidence?.combat ? {
      aiming: evidence.combat.aiming,
      shots: evidence.combat.shots,
      hits: evidence.combat.hits,
      misses: evidence.combat.misses,
      ammo: evidence.combat.ammo,
      lastHit: evidence.combat.lastHit,
      lastReaction: evidence.combat.lastReaction,
      camera: evidence.combat.camera,
    } : null,
    driveBy: evidence?.driveBy ?? null,
    vehicle: evidence?.vehicle ?? null,
    indicators: evidence?.lifeVehicle?.indicators ?? null,
    vehicleScreen: evidence?.vehicleScreen ?? null,
    camera: evidence?.camera ?? null,
    muzzle: evidence?.muzzle ?? null,
    reticle: evidence?.reticle ?? null,
    targetState: evidence?.targetState ?? null,
    targetReaction: evidence?.targetReaction ?? null,
    witness: evidence?.witness ?? null,
    heat: evidence?.heat ? {
      heat: evidence.heat.heat,
      level: evidence.heat.level,
      pursuitActive: evidence.heat.pursuitActive,
      witnessReports: evidence.heat.witnessReports,
      lastWitnessEvent: evidence.heat.lastWitnessEvent,
    } : null,
    responders: evidence?.responders ?? [],
    responderVehicles: evidence?.responderVehicles ?? [],
  });
  const report = {
    result: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestErrors.length === 0
      ? 'moving drive-by combat gate passed'
      : 'moving drive-by combat gate failed',
    baseUrl,
    angle,
    renderer,
    viewport,
    contract: {
      inputs: 'real E + held W+A + real RMB mouse aim + real LMB',
      minimumDriveDistance: 8,
      minimumSpeed: 2,
      minimumHeadingChange: 0.18,
      applicationP99FrameMs: 16.67,
    },
    scenario,
    measured: {
      initial: summarizeEvidence(initial),
      entered: summarizeEvidence(entered),
      start: measuredStart,
      preAim: summarizeEvidence(preAim),
      preAimClearance,
      projection,
      aimed: summarizeEvidence(aimed),
      projectionBeforeShot,
      beforeShot: summarizeEvidence(beforeShot),
      impact: summarizeEvidence(impact),
    },
    samples: {
      count: samples.length,
      aimCount: aimSamples.length,
      movingAimCount: movingAimSamples.length,
      aimDistance: distance2d(aimStart?.position, aimEnd?.position),
    },
    captures,
    performance: performanceSnapshot,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'moving drive-by combat gate passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'moving drive-by combat gate failed',
    error: error.message,
    stack: error.stack,
    renderer,
    scenario,
    captures,
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
  await page.keyboard.up('w').catch(() => {});
  await page.mouse.up({ button: 'left' }).catch(() => {});
  await page.mouse.up({ button: 'right' }).catch(() => {});
  await page.evaluate(() => {
    const recorder = window.__SF_DRIVE_BY_RECORDER__;
    if (recorder) recorder.active = false;
  }).catch(() => {});
  await browser.close();
}
