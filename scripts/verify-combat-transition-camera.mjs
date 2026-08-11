import { access, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const outputDir = process.env.SF_COMBAT_TRANSITION_CAMERA_DIR
  || '.qa-combat-transition-camera';
const viewport = { width: 1280, height: 720 };
const minCameraSurfaceClearance = 0.9;
const minAvatarHeightPx = 220;
const maxAvatarHeightPx = 320;

if (process.platform !== 'darwin') {
  throw new Error('verify-combat-transition-camera requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-combat-transition-camera requires SF_QA_ANGLE=metal, received ${angle}`);
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
let stagedVehicle = null;
let exitFrame = null;
let aimFrame = null;
let samples = [];
let performanceSnapshot = null;
let shot = null;

const finite = (value) => Number.isFinite(value);
const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail == null ? {} : { detail }) });
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
      && typeof sim?.getCombatState === 'function'
      && typeof sim?.getCombatWorldBlocker === 'function'
      && typeof sim?.traffic?.getVehicleLifeSnapshot === 'function'
      && sim.playerAvatar?.visible === true
      && sim.getTraversalCameraState()?.mode === 'walk';
  }, null, { timeout: 12000, polling: 25 });
  await page.waitForTimeout(700);
  await page.locator('#scene-canvas').focus();
}

async function readVisualProxy(screenshotDataUrl) {
  return page.evaluate(async (imageUrl) => {
    const source = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('captured PNG could not be decoded'));
      image.src = imageUrl;
    });
    const width = 64;
    const height = 36;
    const probe = document.createElement('canvas');
    probe.width = width;
    probe.height = height;
    const context = probe.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const bins = new Map();
    const bottomBins = new Map();
    let opaque = 0;
    let luminanceSum = 0;
    let luminanceSquaredSum = 0;
    let edges = 0;
    let edgeComparisons = 0;
    let bottomEdges = 0;
    let bottomEdgeComparisons = 0;
    const luminances = new Float32Array(width * height);
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      luminances[index] = luminance;
      if (alpha >= 250) opaque += 1;
      luminanceSum += luminance;
      luminanceSquaredSum += luminance * luminance;
      const bin = `${red >> 5}:${green >> 5}:${blue >> 5}`;
      bins.set(bin, (bins.get(bin) || 0) + 1);
      const y = Math.floor(index / width);
      if (y >= Math.floor(height * 0.55)) {
        bottomBins.set(bin, (bottomBins.get(bin) || 0) + 1);
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (x > 0) {
          const edge = Math.abs(luminances[index] - luminances[index - 1]) >= 18;
          edges += edge ? 1 : 0;
          edgeComparisons += 1;
          if (y >= Math.floor(height * 0.55)) {
            bottomEdges += edge ? 1 : 0;
            bottomEdgeComparisons += 1;
          }
        }
        if (y > 0) {
          const edge = Math.abs(luminances[index] - luminances[index - width]) >= 18;
          edges += edge ? 1 : 0;
          edgeComparisons += 1;
          if (y >= Math.floor(height * 0.55)) {
            bottomEdges += edge ? 1 : 0;
            bottomEdgeComparisons += 1;
          }
        }
      }
    }
    const count = width * height;
    const mean = luminanceSum / count;
    const variance = Math.max(0, luminanceSquaredSum / count - mean * mean);
    const bottomCount = width * (height - Math.floor(height * 0.55));
    return {
      opaqueRatio: opaque / count,
      luminanceMean: mean,
      luminanceStdDev: Math.sqrt(variance),
      quantizedColorCount: bins.size,
      dominantBottomRatio: Math.max(0, ...bottomBins.values()) / bottomCount,
      edgeRatio: edgeComparisons ? edges / edgeComparisons : 0,
      bottomEdgeRatio: bottomEdgeComparisons ? bottomEdges / bottomEdgeComparisons : 0,
    };
  }, screenshotDataUrl);
}

async function capture(name) {
  const path = `${outputDir}/${name}.png`;
  const screenshot = await page.screenshot({ path, fullPage: false });
  const visual = await readVisualProxy(`data:image/png;base64,${screenshot.toString('base64')}`);
  captures.push({ path, visual });
  return { path, visual };
}

async function stageParkedVehicle() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const candidates = sim.traffic.getVehicleLifeSnapshot().vehicles.filter((vehicle) => {
      if (vehicle?.class === 'bike'
        || vehicle?.identity?.category !== 'private'
        || vehicle?.action?.key !== 'parked'
        || vehicle?.damage?.disabled === true
        || !vehicle?.position) return false;
      return true;
    });
    const candidate = candidates[0] ?? null;
    if (!candidate?.position) return null;
    const staged = sim.setRoamPose({
      x: candidate.position.x,
      z: candidate.position.z,
      yaw: Number(candidate.heading) || 0,
      pitch: 1.08,
      distance: 9.5,
    });
    return {
      id: candidate.id,
      class: candidate.class,
      identity: candidate.identity,
      position: candidate.position,
      staged,
    };
  });
}

async function startFrameRecorder() {
  await page.evaluate((options) => {
    const token = {};
    const recorder = {
      token,
      active: true,
      exitObserved: false,
      samples: [],
      vehicleBounds: new Map(),
    };
    window.__SF_COMBAT_TRANSITION_CAMERA_RECORDER__ = recorder;

    const nodeVisible = (node, root) => {
      let current = node;
      while (current) {
        if (current.visible === false) return false;
        if (current === root) return true;
        current = current.parent;
      }
      return false;
    };
    const readLocalBounds = (root, key) => {
      if (recorder.vehicleBounds.has(key)) return recorder.vehicleBounds.get(key);
      root.updateWorldMatrix(true, true);
      const inverseRoot = root.matrixWorld.clone().invert();
      const bounds = {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
      };
      let points = 0;
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
                .applyMatrix4(inverseRoot);
              bounds.min.x = Math.min(bounds.min.x, point.x);
              bounds.min.y = Math.min(bounds.min.y, point.y);
              bounds.min.z = Math.min(bounds.min.z, point.z);
              bounds.max.x = Math.max(bounds.max.x, point.x);
              bounds.max.y = Math.max(bounds.max.y, point.y);
              bounds.max.z = Math.max(bounds.max.z, point.z);
              points += 1;
            }
          }
        }
      });
      const result = points ? bounds : null;
      recorder.vehicleBounds.set(key, result);
      return result;
    };
    const containsPoint = (point, root, bounds, margin = 0.03) => {
      if (!point || !root || !bounds) return false;
      root.updateWorldMatrix(true, false);
      const local = root.worldToLocal(point.clone());
      return local.x >= bounds.min.x - margin && local.x <= bounds.max.x + margin
        && local.y >= bounds.min.y - margin && local.y <= bounds.max.y + margin
        && local.z >= bounds.min.z - margin && local.z <= bounds.max.z + margin;
    };
    const segmentHitsBounds = (start, end, root, bounds) => {
      if (!start || !end || !root || !bounds) return false;
      root.updateWorldMatrix(true, false);
      const localStart = root.worldToLocal(start.clone());
      const localEnd = root.worldToLocal(end.clone());
      const direction = localEnd.clone().sub(localStart);
      let near = 0;
      let far = 1;
      for (const axis of ['x', 'y', 'z']) {
        if (Math.abs(direction[axis]) < 1e-8) {
          if (localStart[axis] < bounds.min[axis] || localStart[axis] > bounds.max[axis]) {
            return false;
          }
          continue;
        }
        const inverse = 1 / direction[axis];
        let first = (bounds.min[axis] - localStart[axis]) * inverse;
        let second = (bounds.max[axis] - localStart[axis]) * inverse;
        if (first > second) [first, second] = [second, first];
        near = Math.max(near, first);
        far = Math.min(far, second);
        if (near > far) return false;
      }
      return far >= 0.02 && near <= 0.98;
    };
    const nearestWorldBlocker = (sim, origin, destination) => {
      const delta = destination.clone().sub(origin);
      const distance = delta.length();
      if (!(distance > 0.1)) return null;
      delta.multiplyScalar(1 / distance);
      const maxDistance = Math.max(0.01, distance - 0.08);
      const candidates = [
        sim.city?.getNearestRayBlocker?.(origin, delta, maxDistance),
        sim.streaming?.getNearestRayBlocker?.(origin, delta, maxDistance),
      ].filter((candidate) => Number.isFinite(candidate?.distance));
      candidates.sort((left, right) => left.distance - right.distance
        || String(left.source || '').localeCompare(String(right.source || '')));
      return candidates[0]
        ? { distance: candidates[0].distance, source: candidates[0].source || null }
        : null;
    };
    const avatarLineOfSight = (sim, roots) => {
      const avatar = sim.playerAvatar;
      const ud = avatar?.userData;
      if (!avatar?.visible || !ud) return null;
      avatar.updateMatrixWorld(true);
      const result = {};
      for (const [key, part] of Object.entries({
        head: ud.head,
        torso: ud.body,
        rightArm: ud.rightArm,
      })) {
        if (!part?.getWorldPosition) {
          result[key] = false;
          continue;
        }
        const point = part.getWorldPosition(sim.camera.position.clone());
        const worldBlocker = nearestWorldBlocker(sim, sim.camera.position, point);
        const vehicleBlocker = roots.some(({ root, bounds }) => (
          segmentHitsBounds(sim.camera.position, point, root, bounds)
        ));
        result[key] = !worldBlocker && !vehicleBlocker;
      }
      return result;
    };
    const sample = () => {
      if (window.__SF_COMBAT_TRANSITION_CAMERA_RECORDER__?.token !== token
        || !recorder.active) return;
      const sim = window.__SF_SIM__;
      const driving = sim?.isDriving?.() === true;
      if (!recorder.exitObserved && !driving) recorder.exitObserved = true;
      if (recorder.exitObserved && sim?.camera) {
        const traversal = sim.getTraversalCameraState?.() ?? null;
        const combat = sim.getCombatState?.() ?? null;
        const camera = sim.camera.position;
        const focus = traversal?.focus
          ? camera.clone().set(traversal.focus.x, traversal.focus.y, traversal.focus.z)
          : null;
        const surface = sim.city?.getSurfaceHeight?.(camera)
          ?? sim.streaming?.getSurfaceHeight?.(camera);
        const life = sim.traffic?.getVehicleLifeSnapshot?.()?.vehicles || [];
        const roots = [];
        const containingVehicles = [];
        for (const vehicle of life) {
          if (vehicle?.visible === false || !vehicle?.position) continue;
          if (Math.hypot(vehicle.position.x - camera.x, vehicle.position.z - camera.z) > 16) continue;
          const root = sim.traffic?.group?.children?.[vehicle.id];
          if (!root?.visible) continue;
          const bounds = readLocalBounds(root, vehicle.id);
          if (!bounds) continue;
          roots.push({ root, bounds });
          if (containsPoint(camera, root, bounds)) {
            containingVehicles.push({ id: vehicle.id, class: vehicle.class });
          }
        }
        const domReticle = document.querySelector('.combat-reticle');
        const domStyle = domReticle ? getComputedStyle(domReticle) : null;
        const domRect = domReticle?.getBoundingClientRect?.() ?? null;
        recorder.samples.push({
          at: performance.now(),
          mode: traversal?.mode ?? null,
          transition: traversal?.transition ?? null,
          camera: traversal?.camera ?? { x: camera.x, y: camera.y, z: camera.z },
          focus: traversal?.focus ?? null,
          surface: Number.isFinite(surface) ? surface : null,
          surfaceClearance: Number.isFinite(surface) ? camera.y - surface : null,
          voidProxy: !Number.isFinite(surface)
            || camera.y < surface + options.minCameraSurfaceClearance,
          worldBlocker: focus ? nearestWorldBlocker(sim, focus, camera) : null,
          telemetryBlocker: traversal?.blocker ?? null,
          containingVehicles,
          aiming: combat?.aiming === true,
          avatarLineOfSight: combat?.aiming === true ? avatarLineOfSight(sim, roots) : null,
          embodiment: combat?.aiming === true ? combat?.embodiment ?? null : null,
          domReticle: domRect ? {
            visible: domStyle?.display !== 'none'
              && domStyle?.visibility !== 'hidden'
              && Number(domStyle?.opacity) > 0.01,
            x: (domRect.left + domRect.right) * 0.5,
            y: (domRect.top + domRect.bottom) * 0.5,
          } : null,
        });
      }
      if (recorder.samples.length < 720) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { minCameraSurfaceClearance });
}

async function stopFrameRecorder() {
  return page.evaluate(() => {
    const recorder = window.__SF_COMBAT_TRANSITION_CAMERA_RECORDER__;
    if (!recorder) return [];
    recorder.active = false;
    return recorder.samples.map((sample) => structuredClone(sample));
  });
}

function verifyVisualProxy(label, visual) {
  assert(visual && Object.values(visual).every(finite),
    `${label}: canvas visual proxy was unavailable`, visual);
  if (!visual || !Object.values(visual).every(finite)) return;
  assert(visual.opaqueRatio >= 0.98,
    `${label}: canvas contained transparent/void output`, visual);
  assert(visual.quantizedColorCount >= 12
    && visual.luminanceStdDev >= 8
    && visual.edgeRatio >= 0.012
    && visual.bottomEdgeRatio >= 0.006
    && visual.dominantBottomRatio < 0.9,
  `${label}: canvas resembled a flat underside/void instead of a composed street frame`, visual);
}

function verifyFrameSamples(recorded) {
  assert(recorded.length >= 30,
    'fewer than 30 animation frames were sampled from exit through settled aim', {
      sampleCount: recorded.length,
    });
  assert(recorded.some((sample) => sample.transition?.active === true),
    'the drive-to-walk camera transition was not observed at animation-frame cadence');
  assert(recorded.some((sample) => sample.aiming),
    'the real RMB aim state was not observed at animation-frame cadence');
  assert(recorded.some((sample) => sample.aiming && sample.transition?.active === false),
    'no settled aim frame was recorded after the drive-to-walk transition');

  const invalidSurface = recorded.filter((sample) => (
    sample.voidProxy === true
      || !finite(sample.surface)
      || !finite(sample.surfaceClearance)
      || sample.surfaceClearance < minCameraSurfaceClearance
  ));
  const blocked = recorded.filter((sample) => (
    sample.worldBlocker != null
      || Number(sample.telemetryBlocker?.clearance) < -0.05
  ));
  const contained = recorded.filter((sample) => sample.containingVehicles?.length > 0);
  assert(invalidSurface.length === 0,
    'camera dropped below the authoritative local surface/eye-clearance envelope', {
      count: invalidSurface.length,
      first: invalidSurface[0] ?? null,
      minimum: recorded.length
        ? Math.min(...recorded.map((sample) => Number(sample.surfaceClearance)))
        : null,
    });
  assert(blocked.length === 0,
    'camera arm penetrated a core or streamed world blocker', {
      count: blocked.length,
      first: blocked[0] ?? null,
    });
  assert(contained.length === 0,
    'camera entered the exact live geometry bounds of a traffic vehicle', {
      count: contained.length,
      first: contained[0] ?? null,
    });

  const aimSamples = recorded.filter((sample) => sample.aiming);
  const invalidEmbodiment = aimSamples.filter((sample) => {
    const embodiment = sample.embodiment;
    const avatar = embodiment?.avatar;
    const screen = avatar?.screen;
    const weapon = embodiment?.weapon;
    const reticle = embodiment?.reticle;
    const lineOfSight = sample.avatarLineOfSight;
    return embodiment?.connected !== true
      || avatar?.visible !== true
      || !finite(screen?.heightPx)
      || screen.heightPx < minAvatarHeightPx
      || screen.heightPx > maxAvatarHeightPx
      || !finite(screen?.centerX)
      || screen.centerX < 400
      || screen.centerX > 560
      || !finite(screen?.right)
      || !finite(reticle?.x)
      || screen.right > reticle.x - 24
      || avatar?.parts?.head !== true
      || avatar?.parts?.torso !== true
      || avatar?.parts?.rightArm !== true
      || Number(avatar?.visibilityRatio) < 0.75
      || weapon?.visible !== true
      || weapon?.connected !== true
      || !finite(weapon?.gripSocketDistance)
      || weapon.gripSocketDistance > 0.08
      || embodiment?.camera?.collisionSafe !== true
      || embodiment?.camera?.insideBuilding !== false
      || embodiment?.camera?.insideVehicle !== false
      || sample.domReticle?.visible !== true
      || Math.abs(Number(sample.domReticle?.x) - viewport.width / 2) > 2
      || Math.abs(Number(sample.domReticle?.y) - viewport.height / 2) > 2
      || lineOfSight?.head !== true
      || lineOfSight?.torso !== true
      || lineOfSight?.rightArm !== true;
  });
  assert(invalidEmbodiment.length === 0,
    'an RMB animation frame lacked a connected, unobstructed 220-320px avatar left of the reticle', {
      count: invalidEmbodiment.length,
      first: invalidEmbodiment[0] ?? null,
    });

  return {
    sampleCount: recorded.length,
    aimSampleCount: aimSamples.length,
    transitionSamples: recorded.filter((sample) => sample.transition?.active).length,
    modes: [...new Set(recorded.map((sample) => sample.mode))],
    minimumSurfaceClearance: recorded.length
      ? Math.min(...recorded.map((sample) => Number(sample.surfaceClearance)))
      : null,
    invalidSurfaceCount: invalidSurface.length,
    blockerPenetrationCount: blocked.length,
    vehicleContainmentCount: contained.length,
    invalidEmbodimentCount: invalidEmbodiment.length,
  };
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

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.setWeather?.('clear');
    sim.streetHeat?.restart?.();
    sim.combat?.restart?.();
  });
  stagedVehicle = await stageParkedVehicle();
  assert(Number.isInteger(stagedVehicle?.id),
    'no parked private vehicle was available for the real E/W/S/E sequence', stagedVehicle);
  if (!Number.isInteger(stagedVehicle?.id)) throw new Error('vehicle staging failed');
  await page.waitForTimeout(800);
  await page.locator('#scene-canvas').focus();

  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true,
    null, { timeout: 4000, polling: 20 });
  const roadStage = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.exportPlayerVehicleState?.();
    if (!snapshot || snapshot.mode !== 'driving') return null;
    snapshot.position = { x: 28, z: 38 };
    snapshot.heading = 0;
    snapshot.speed = 0;
    const imported = sim.traffic.importPlayerVehicleState?.(snapshot) === true;
    return { imported, state: sim.traffic.getPlayerVehicleState?.() ?? null };
  });
  assert(roadStage?.imported === true,
    'the real-entered vehicle could not be QA-staged on the authored public road', roadStage);
  if (!roadStage?.imported) throw new Error('public-road vehicle staging failed');
  await page.waitForTimeout(900);

  const driveStart = await page.evaluate(() => (
    window.__SF_SIM__?.traffic?.getPlayerVehicleState?.()?.position ?? null
  ));
  await page.keyboard.down('w');
  try {
    await page.waitForFunction((start) => {
      const state = window.__SF_SIM__?.traffic?.getPlayerVehicleState?.();
      return state?.speed >= 2
        && Math.hypot(state.position.x - start.x, state.position.z - start.z) >= 5;
    }, driveStart, { timeout: 12000, polling: 20 });
  } finally {
    await page.keyboard.up('w').catch(() => {});
  }
  const driven = await page.evaluate(() => window.__SF_SIM__?.traffic?.getPlayerVehicleState?.());
  assert(driven?.speed >= 2,
    'real W did not accelerate the entered vehicle before braking', { driveStart, driven });

  await page.keyboard.down('s');
  try {
    await page.waitForFunction(() => (
      (window.__SF_SIM__?.traffic?.getPlayerVehicleState?.()?.speed ?? 1) <= 0.25
    ), null, { timeout: 8000, polling: 20 });
  } finally {
    await page.keyboard.up('s').catch(() => {});
  }
  const braked = await page.evaluate(() => window.__SF_SIM__?.traffic?.getPlayerVehicleState?.());
  assert(braked?.speed <= 0.25,
    'real S did not brake the vehicle to a safe exit speed', braked);

  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await startFrameRecorder();
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === false,
    null, { timeout: 4000, polling: 10 });
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getTraversalCameraState?.()?.transition?.active === true
  ), null, { timeout: 2000, polling: 10 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  exitFrame = await capture('exit-transition');

  const canvas = await page.locator('#scene-canvas').boundingBox();
  if (!canvas) throw new Error('scene canvas bounds unavailable for real RMB/LMB input');
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);
  const combatBefore = await page.evaluate(() => window.__SF_SIM__?.getCombatState?.() ?? null);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.()?.aiming === true,
    null, { timeout: 3000, polling: 10 });
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim?.getCombatState?.()?.aiming === true
      && sim?.getTraversalCameraState?.()?.mode === 'aim'
      && sim?.getTraversalCameraState?.()?.transition?.active === false;
  }, null, { timeout: 5000, polling: 10 });
  await page.waitForTimeout(280);

  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForFunction((beforeShots) => (
    window.__SF_SIM__?.getCombatState?.()?.shots === beforeShots + 1
  ), combatBefore?.shots, { timeout: 3000, polling: 10 });
  const combatAfter = await page.evaluate(() => window.__SF_SIM__?.getCombatState?.() ?? null);
  shot = {
    before: { shots: combatBefore?.shots, ammo: combatBefore?.ammo },
    after: { shots: combatAfter?.shots, ammo: combatAfter?.ammo },
  };
  assert(combatAfter?.shots === combatBefore?.shots + 1
    && combatAfter?.ammo === combatBefore?.ammo - 1,
  'one real LMB press during RMB aim did not consume exactly one round', shot);
  aimFrame = await capture('aim-settled');

  await page.waitForFunction(() => (
    (window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0) >= 180
  ), null, { timeout: 12000, polling: 50 });
  performanceSnapshot = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  samples = await stopFrameRecorder();
  await page.mouse.up({ button: 'right' });

  const sampleSummary = verifyFrameSamples(samples);
  verifyVisualProxy('exit transition', exitFrame?.visual);
  verifyVisualProxy('settled aim', aimFrame?.visual);
  assert(performanceSnapshot?.applicationFrameCount >= 180
    && finite(performanceSnapshot?.applicationP99FrameMs)
    && performanceSnapshot.applicationP99FrameMs <= 16.67,
  'combat transition camera exceeded the 16.67ms application p99 budget', performanceSnapshot);
  assert(consoleErrors.length === 0, 'page/console errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestErrors.length === 0, 'request failures occurred', requestErrors);

  const report = {
    result: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestErrors.length === 0
      ? 'combat transition camera gate passed'
      : 'combat transition camera gate failed',
    baseUrl,
    angle,
    renderer,
    viewport,
    contract: {
      sequence: 'real E / real W / real S / real E / real RMB / real LMB',
      minCameraSurfaceClearance,
      avatarHeightPx: [minAvatarHeightPx, maxAvatarHeightPx],
      avatarCenterX: [400, 560],
      applicationP99FrameMs: 16.67,
    },
    stagedVehicle,
    drive: { start: driveStart, driven, braked },
    shot,
    sampleSummary,
    captures,
    performance: performanceSnapshot,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'combat transition camera gate passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'combat transition camera gate failed',
    error: error.message,
    stack: error.stack,
    renderer,
    stagedVehicle,
    shot,
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
  await page.keyboard.up('w').catch(() => {});
  await page.keyboard.up('s').catch(() => {});
  await page.mouse.up({ button: 'left' }).catch(() => {});
  await page.mouse.up({ button: 'right' }).catch(() => {});
  await page.evaluate(() => {
    const recorder = window.__SF_COMBAT_TRANSITION_CAMERA_RECORDER__;
    if (recorder) recorder.active = false;
  }).catch(() => {});
  await browser.close();
}
