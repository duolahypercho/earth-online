import { access, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const outputDir = process.env.SF_THIRD_PERSON_COMBAT_DIR || '.qa-third-person-combat';
const viewport = { width: 1280, height: 720 };

if (process.platform !== 'darwin') {
  throw new Error('verify-third-person-combat requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-third-person-combat requires SF_QA_ANGLE=metal, received ${angle}`);
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
const scenarios = {};
let renderer = null;
let performance = null;

const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail ? { detail } : {}) });
};
const finite = (value) => Number.isFinite(value);
const closeTo = (value, expected, tolerance) => (
  finite(value) && Math.abs(value - expected) <= tolerance
);
const distance2d = (left, right) => Math.hypot(
  Number(left?.x) - Number(right?.x),
  Number(left?.z) - Number(right?.z),
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
      && typeof sim?.setRoamPose === 'function'
      && sim.playerAvatar?.visible === true
      && sim.getTraversalCameraState?.()?.mode === 'walk';
  }, null, { timeout: 10000, polling: 25 });
  await page.waitForTimeout(700);
  await page.locator('#scene-canvas').focus();
}

async function stageRoam(position) {
  const staged = await page.evaluate((nextPosition) => (
    window.__SF_SIM__?.setRoamPose?.(nextPosition) ?? null
  ), position);
  assert(staged?.target, 'QA roam staging did not expose a target', { position, staged });
  await page.waitForTimeout(420);
  await page.locator('#scene-canvas').focus();
  return staged;
}

async function beginAim() {
  const canvas = await page.locator('#scene-canvas').boundingBox();
  if (!canvas) throw new Error('scene canvas bounds unavailable for real RMB/LMB input');
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.()?.aiming === true,
    null, { timeout: 3000, polling: 20 });
  await page.waitForTimeout(700);
}

async function endAim(label) {
  await page.mouse.up({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.()?.aiming === false,
    null, { timeout: 3000, polling: 20 });
  const weapon = await page.evaluate(() => (
    window.__SF_SIM__?.getCombatState?.()?.embodiment?.weapon ?? null
  ));
  assert(weapon?.visible !== true || weapon?.connected === true,
    `${label}: weapon was visible without a connected avatar socket after aim`, weapon);
}

async function readEvidence(label) {
  return page.evaluate((evidenceLabel) => {
    const sim = window.__SF_SIM__;
    const combat = sim?.getCombatState?.() ?? null;
    const reticle = document.querySelector('.combat-reticle');
    const reticleStyle = reticle ? getComputedStyle(reticle) : null;
    const rect = reticle?.getBoundingClientRect?.() ?? null;
    const target = sim?.getRoamState?.()?.target ?? null;
    return {
      label: evidenceLabel,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      combat,
      traversal: sim?.getTraversalCameraState?.() ?? null,
      roam: target ? { x: target.x, y: target.y, z: target.z } : null,
      domReticle: rect ? {
        visible: reticleStyle.display !== 'none'
          && reticleStyle.visibility !== 'hidden'
          && Number(reticleStyle.opacity) > 0.01,
        x: (rect.left + rect.right) * 0.5,
        y: (rect.top + rect.bottom) * 0.5,
        width: rect.width,
        height: rect.height,
      } : null,
    };
  }, label);
}

function verifyEmbodiment(label, evidence) {
  const embodiment = evidence?.combat?.embodiment;
  assert(evidence?.viewport?.width === viewport.width
    && evidence?.viewport?.height === viewport.height,
  `${label}: browser viewport was not exactly 1280x720`, evidence?.viewport);
  assert(embodiment && typeof embodiment === 'object',
    `${label}: getCombatState().embodiment contract is missing`, evidence?.combat);
  if (!embodiment || typeof embodiment !== 'object') return;

  const avatar = embodiment.avatar;
  const screen = avatar?.screen;
  const weapon = embodiment.weapon;
  const reticle = embodiment.reticle;
  const near = embodiment.convergence?.near;
  const far = embodiment.convergence?.far;
  const camera = embodiment.camera;
  const screenValues = screen
    ? [screen.left, screen.right, screen.top, screen.bottom, screen.width,
      screen.height, screen.heightPx, screen.centerX, screen.centerY]
    : [];
  const derivedCenterX = screen ? (screen.left + screen.right) * 0.5 : NaN;
  const derivedCenterY = screen ? (screen.top + screen.bottom) * 0.5 : NaN;

  assert(embodiment.connected === true,
    `${label}: combat embodiment was not connected`, embodiment);
  assert(avatar?.visible === true,
    `${label}: avatar silhouette was not visible`, avatar);
  assert(screenValues.length === 9 && screenValues.every(finite),
    `${label}: avatar.screen must expose a finite full screen rect`, screen);
  assert(finite(screen?.heightPx) && screen.heightPx >= 220 && screen.heightPx <= 320,
    `${label}: avatar silhouette height was outside 220-320px`, screen);
  assert(closeTo(screen?.width, screen?.right - screen?.left, 2)
    && closeTo(screen?.height, screen?.bottom - screen?.top, 2)
    && closeTo(screen?.heightPx, screen?.bottom - screen?.top, 2),
  `${label}: avatar screen dimensions disagreed with its full rect`, screen);
  assert(closeTo(screen?.centerX, derivedCenterX, 2)
    && closeTo(screen?.centerY, derivedCenterY, 2),
  `${label}: avatar screen center disagreed with its full rect`, screen);
  assert(finite(derivedCenterX) && derivedCenterX >= 400 && derivedCenterX <= 560,
    `${label}: avatar silhouette was not composed left of the reticle`, {
      derivedCenterX,
      screen,
    });
  assert(avatar?.parts?.head === true
    && avatar?.parts?.torso === true
    && avatar?.parts?.rightArm === true,
  `${label}: head, torso, and right arm were not all visibly embodied`, avatar?.parts);
  if (Object.prototype.hasOwnProperty.call(avatar || {}, 'visibilityRatio')) {
    assert(finite(avatar.visibilityRatio) && avatar.visibilityRatio >= 0.8,
      `${label}: avatar visibility ratio was below 0.8`, avatar);
  }

  assert(weapon?.visible !== true || weapon?.connected === true,
    `${label}: weapon was visible without a connected avatar socket`, weapon);
  assert(weapon?.visible === true && weapon?.connected === true,
    `${label}: aiming weapon was not visibly connected`, weapon);
  assert(finite(weapon?.gripSocketDistance) && weapon.gripSocketDistance <= 0.06,
    `${label}: weapon grip/socket separation exceeded 0.06m`, weapon);

  assert(closeTo(reticle?.x, viewport.width * 0.5, 2)
    && closeTo(reticle?.y, viewport.height * 0.5, 2),
  `${label}: telemetry reticle was not centered within 2px`, reticle);
  assert(evidence?.domReticle?.visible === true
    && closeTo(evidence.domReticle.x, viewport.width * 0.5, 2)
    && closeTo(evidence.domReticle.y, viewport.height * 0.5, 2),
  `${label}: rendered DOM reticle was not visible and centered within 2px`, evidence?.domReticle);

  assert(closeTo(near?.distance, 10, 0.01)
    && finite(near?.errorPx) && near.errorPx <= 4,
  `${label}: 10m muzzle convergence exceeded 4px`, near);
  assert(closeTo(far?.distance, 30, 0.01)
    && finite(far?.errorPx) && far.errorPx <= 4,
  `${label}: 30m muzzle convergence exceeded 4px`, far);
  assert(camera?.collisionSafe === true
    && camera?.insideBuilding === false
    && camera?.insideVehicle === false,
  `${label}: shoulder camera was not collision-safe in the public world`, camera);
}

async function captureFrame(name) {
  const path = `${outputDir}/${name}`;
  await page.screenshot({ path, fullPage: false });
  captures.push(path);
}

async function fireRealShot(label) {
  const before = await page.evaluate(() => window.__SF_SIM__?.getCombatState?.() ?? null);
  assert(before?.aiming === true, `${label}: real LMB shot began outside RMB aim`, before);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await page.waitForFunction((beforeShots) => (
    window.__SF_SIM__?.getCombatState?.()?.shots === beforeShots + 1
  ), before?.shots, { timeout: 3000, polling: 20 });
  const after = await page.evaluate(() => window.__SF_SIM__?.getCombatState?.() ?? null);
  assert(after?.shots === before?.shots + 1 && after?.ammo === before?.ammo - 1,
    `${label}: one real LMB press did not fire exactly one round`, { before, after });
  await page.waitForTimeout(240);
  return { before, after };
}

async function stageNearVehicle() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const roam = sim?.getRoamState?.()?.target || { x: 28, z: 38 };
    const all = sim?.traffic?.getVehicleLifeSnapshot?.()?.vehicles || [];
    const vehicleAtSurface = (vehicle) => {
      const root = sim?.traffic?.group?.children?.[vehicle?.index ?? vehicle?.id];
      const surface = sim?.streaming?.getSurfaceHeight?.(vehicle?.position);
      return Number.isFinite(root?.position?.y)
        && Number.isFinite(surface)
        && Math.abs(root.position.y - surface) <= 0.35;
    };
    let candidates = all.filter((vehicle) => (
      vehicle?.visible !== false
      && vehicle?.class !== 'bike'
      && vehicle?.damage?.disabled !== true
      && vehicle?.action?.key === 'parked'
      && vehicle?.position
      && vehicleAtSurface(vehicle)
    ));
    if (!candidates.length) {
      candidates = all.filter((vehicle) => (
        vehicle?.visible !== false
        && vehicle?.class !== 'bike'
        && vehicle?.damage?.disabled !== true
        && vehicle?.position
        && vehicleAtSurface(vehicle)
      ));
    }
    const vehicle = candidates.sort((left, right) => (
      Math.hypot(left.position.x - roam.x, left.position.z - roam.z)
      - Math.hypot(right.position.x - roam.x, right.position.z - roam.z)
    ))[0];
    if (!vehicle?.position) return null;
    const vehicleRoot = sim.traffic.group.children[vehicle.index ?? vehicle.id];

    // With yaw 0 the shoulder camera sits behind the player along -Z. Keep a
    // live vehicle close enough to exercise ordinary collision resolution.
    const player = {
      x: vehicle.position.x - 0.85,
      z: vehicle.position.z + 3.2,
      yaw: 0,
      pitch: 1.36,
      distance: 12,
    };
    const staged = sim.setRoamPose(player);
    return {
      id: vehicle.id,
      class: vehicle.class,
      action: vehicle.action?.key ?? null,
      position: { x: vehicle.position.x, y: vehicleRoot.position.y, z: vehicle.position.z },
      surfaceHeight: sim.streaming.getSurfaceHeight(vehicle.position),
      player,
      staged,
    };
  });
}

async function readNearVehicle(vehicleId) {
  return page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const vehicle = sim?.traffic?.getVehicleLifeSnapshot?.()?.vehicles
      ?.find((candidate) => candidate.id === id) ?? null;
    const target = sim?.getRoamState?.()?.target ?? null;
    if (!vehicle?.position || !target) return null;
    const vehicleRoot = sim?.traffic?.group?.children?.[vehicle.index ?? vehicle.id] ?? null;
    return {
      id: vehicle.id,
      class: vehicle.class,
      visible: vehicle.visible !== false,
      action: vehicle.action?.key ?? null,
      position: { ...vehicle.position, y: vehicleRoot?.position?.y ?? null },
      surfaceHeight: sim?.streaming?.getSurfaceHeight?.(vehicle.position) ?? null,
      target: { x: target.x, y: target.y, z: target.z },
      distance: Math.hypot(vehicle.position.x - target.x, vehicle.position.z - target.z),
    };
  }, vehicleId);
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

  await stageRoam({ x: 0, z: 0, yaw: 0, pitch: 1.36, distance: 12 });
  await beginAim();
  const stationaryEvidence = await readEvidence('stationary aim');
  verifyEmbodiment('stationary aim', stationaryEvidence);
  await captureFrame('stationary-aim.png');
  const stationaryShot = await fireRealShot('stationary aim');
  scenarios.stationary = { evidence: stationaryEvidence, shot: stationaryShot };
  await endAim('stationary aim');

  await stageRoam({ x: 0, z: 0, yaw: 0, pitch: 1.36, distance: 12 });
  await beginAim();
  const strafeStart = await page.evaluate(() => window.__SF_SIM__?.getRoamState?.()?.target ?? null);
  await page.keyboard.down('w');
  await page.keyboard.down('a');
  await page.waitForTimeout(420);
  const strafeLeft = await page.evaluate(() => window.__SF_SIM__?.getRoamState?.()?.target ?? null);
  await page.keyboard.up('a');
  await page.keyboard.down('d');
  await page.waitForTimeout(420);
  const strafeEvidence = await readEvidence('strafe aim');
  verifyEmbodiment('strafe aim', strafeEvidence);
  await captureFrame('strafe-aim.png');
  const strafeShot = await fireRealShot('strafe aim');
  await page.keyboard.up('d');
  await page.keyboard.up('w');
  const strafeEnd = await page.evaluate(() => window.__SF_SIM__?.getRoamState?.()?.target ?? null);
  assert(distance2d(strafeStart, strafeLeft) >= 1.3
    && distance2d(strafeLeft, strafeEnd) >= 1.3
    && distance2d(strafeStart, strafeEnd) >= 2.5,
  'real W/A/D strafe input did not move the aiming avatar through both legs', {
    strafeStart,
    strafeLeft,
    strafeEnd,
  });
  scenarios.strafe = {
    start: strafeStart,
    leftLeg: strafeLeft,
    end: strafeEnd,
    evidence: strafeEvidence,
    shot: strafeShot,
  };
  await endAim('strafe aim');

  const vehicleStage = await stageNearVehicle();
  assert(vehicleStage?.id >= 0, 'no live non-bike vehicle was available for near-vehicle aim', vehicleStage);
  if (!vehicleStage?.id && vehicleStage?.id !== 0) {
    throw new Error('near-vehicle combat staging failed');
  }
  await page.waitForTimeout(420);
  await page.locator('#scene-canvas').focus();
  await beginAim();
  const nearVehicle = await readNearVehicle(vehicleStage.id);
  assert(nearVehicle?.visible === true
    && nearVehicle?.class !== 'bike'
    && finite(nearVehicle?.distance)
    && nearVehicle.distance >= 1.5
    && nearVehicle.distance <= 4.8
    && finite(nearVehicle.surfaceHeight)
    && Math.abs(nearVehicle.position.y - nearVehicle.surfaceHeight) <= 0.35,
  'near-vehicle scenario did not keep a live vehicle beside the aiming avatar', nearVehicle);
  const vehicleEvidence = await readEvidence('near-vehicle aim');
  verifyEmbodiment('near-vehicle aim', vehicleEvidence);
  await captureFrame('near-vehicle-aim.png');
  const vehicleShot = await fireRealShot('near-vehicle aim');

  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    (window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount || 0) >= 180
  ), null, { timeout: 10000, polling: 100 });
  performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.() ?? null);
  assert(Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'third-person combat exceeded the 16.67ms application p99 budget', performance);
  const sustainedVehicleEvidence = await readEvidence('near-vehicle sustained aim');
  verifyEmbodiment('near-vehicle sustained aim', sustainedVehicleEvidence);
  scenarios.nearVehicle = {
    stage: vehicleStage,
    vehicle: nearVehicle,
    evidence: vehicleEvidence,
    sustainedEvidence: sustainedVehicleEvidence,
    shot: vehicleShot,
  };
  await endAim('near-vehicle aim');

  assert(consoleErrors.length === 0, 'page/console errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestErrors.length === 0, 'request failures occurred', requestErrors);

  const report = {
    pass: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestErrors.length === 0,
    baseUrl,
    angle,
    viewport,
    renderer,
    input: {
      aim: 'real RMB',
      fire: 'real LMB in every scenario',
      movement: 'real W+A then W+D while RMB held',
      directCombatMutation: false,
    },
    scenarios,
    captures,
    performance,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    pass: false,
    result: 'third-person combat gate failed',
    error: error.message,
    stack: error.stack,
    baseUrl,
    angle,
    viewport,
    renderer,
    scenarios,
    captures,
    performance,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await page.keyboard.up('w').catch(() => {});
  await page.keyboard.up('a').catch(() => {});
  await page.keyboard.up('d').catch(() => {});
  await page.mouse.up({ button: 'left' }).catch(() => {});
  await page.mouse.up({ button: 'right' }).catch(() => {});
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
