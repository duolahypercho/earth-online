import { access, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const outputDir = process.env.SF_LOCOMOTION_FACING_DIR || '.qa-locomotion-facing';
const viewport = { width: 1280, height: 720 };
const stagePose = { x: 28, z: 38, yaw: 0, pitch: 1.36, distance: 12 };
const facingLimitRadians = 12 * Math.PI / 180;
const settleBudgetMs = 250;
const postSettleAlignmentRatio = 0.95;
const minDisplacement = 4;
const maxGroundResidual = 0.08;

const scenarioDefinitions = [
  { id: 'forward-w', keys: ['w'], axis: { x: 0, z: -1 } },
  { id: 'reverse-s', keys: ['s'], axis: { x: 0, z: 1 } },
  { id: 'left-a', keys: ['a'], axis: { x: -1, z: 0 } },
  { id: 'right-d', keys: ['d'], axis: { x: 1, z: 0 } },
  { id: 'forward-right-wd', keys: ['w', 'd'], axis: { x: 1, z: -1 } },
];

if (process.platform !== 'darwin') {
  throw new Error('verify-locomotion-facing requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-locomotion-facing requires SF_QA_ANGLE=metal, received ${angle}`);
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
const scenarios = [];
let renderer = null;
let performanceSnapshot = null;
let resourceBaseline = null;
let resourceAfter = null;

const finite = (value) => Number.isFinite(value);
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
const degrees = (radians) => Number(radians) * 180 / Math.PI;

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
  await page.addInitScript(() => {
    window.localStorage.removeItem('earth-online-player-progress-v1');
  });
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getTraversalCameraState?.();
    const locomotion = state?.avatar?.locomotion;
    return typeof sim?.setRoamPose === 'function'
      && typeof sim?.getPerformanceSnapshot === 'function'
      && state?.mode === 'walk'
      && state?.avatar?.visible === true
      && locomotion
      && Object.prototype.hasOwnProperty.call(locomotion, 'facingYaw')
      && Object.prototype.hasOwnProperty.call(locomotion, 'targetYaw')
      && Object.prototype.hasOwnProperty.call(locomotion, 'facingErrorRadians')
      && locomotion.displacement;
  }, null, { timeout: 12000, polling: 25 });
  await page.locator('#scene-canvas').focus();
}

async function readState() {
  return page.evaluate(() => window.__SF_SIM__?.getTraversalCameraState?.() ?? null);
}

async function stageScenario(label) {
  const staged = await page.evaluate((pose) => (
    window.__SF_SIM__?.setRoamPose?.(pose) ?? null
  ), stagePose);
  assert(staged?.target, `${label}: deterministic roam staging did not expose a target`, staged);
  await page.waitForFunction(() => {
    const state = window.__SF_SIM__?.getTraversalCameraState?.();
    return state?.mode === 'walk'
      && state?.transition?.active === false
      && state?.avatar?.visible === true
      && state?.avatar?.locomotion?.moving === false;
  }, null, { timeout: 5000, polling: 20 });
  await page.waitForTimeout(360);
  await page.locator('#scene-canvas').focus();
  const state = await readState();
  assert(finite(state?.yaw) && Math.abs(angleDifference(state.yaw, stagePose.yaw)) <= 0.02,
    `${label}: deterministic camera yaw reset did not settle`, state);
  return state;
}

async function startRecorder() {
  await page.evaluate(() => {
    const token = {};
    const recorder = { token, active: true, samples: [] };
    window.__SF_LOCOMOTION_FACING_RECORDER__ = recorder;
    const sample = () => {
      if (window.__SF_LOCOMOTION_FACING_RECORDER__?.token !== token || !recorder.active) return;
      const state = window.__SF_SIM__?.getTraversalCameraState?.();
      if (state) {
        const locomotion = state.avatar?.locomotion;
        recorder.samples.push({
          at: performance.now(),
          mode: state.mode,
          transitionActive: state.transition?.active ?? null,
          cameraSurfaceClearance: state.cameraSurfaceClearance ?? null,
          avatar: {
            visible: state.avatar?.visible ?? null,
            groundResidual: state.avatar?.groundResidual ?? null,
            position: state.avatar?.position ? { ...state.avatar.position } : null,
          },
          locomotion: locomotion ? {
            moving: locomotion.moving,
            facingYaw: locomotion.facingYaw,
            targetYaw: locomotion.targetYaw,
            facingErrorRadians: locomotion.facingErrorRadians,
            displacement: locomotion.displacement ? { ...locomotion.displacement } : null,
          } : null,
        });
      }
      if (recorder.samples.length < 1800) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopRecorder() {
  return page.evaluate(() => {
    const recorder = window.__SF_LOCOMOTION_FACING_RECORDER__;
    if (!recorder) return [];
    recorder.active = false;
    const samples = recorder.samples.map((sample) => sample);
    delete window.__SF_LOCOMOTION_FACING_RECORDER__;
    return samples;
  });
}

async function captureHudFree(name) {
  const hud = await page.evaluate(() => {
    const app = document.querySelector('#app');
    const combatOverlay = document.querySelector('.combat-overlay');
    const nameTag = window.__SF_SIM__?.playerAvatar?.userData?.nameTag ?? null;
    const nameTags = [];
    window.__SF_SIM__?.scene?.traverse?.((object) => {
      if (object?.name !== 'Player name tag') return;
      nameTags.push({
        object,
        objectVisible: object.visible,
        materialVisible: object.material?.visible ?? null,
      });
      object.visible = false;
      if (object.material) object.material.visible = false;
    });
    window.__SF_LOCOMOTION_FACING_CAPTURE_RESTORE__ = {
      hadBeautyClass: app?.classList.contains('is-beauty') ?? false,
      combatVisibility: combatOverlay?.style.visibility ?? '',
      nameTag,
      nameTagVisible: nameTag?.visible ?? null,
      nameTagMaterialVisible: nameTag?.material?.visible ?? null,
      nameTags,
    };
    app?.classList.add('is-beauty');
    if (combatOverlay) combatOverlay.style.visibility = 'hidden';
    if (nameTag) nameTag.visible = false;
    // updatePlayerWeapon restores the sprite object's visibility every frame,
    // but it does not mutate the material. Hide both so the clean frame cannot
    // pick up the local-player label between the CSS settle and screenshot.
    if (nameTag?.material) nameTag.material.visible = false;
    return Boolean(document.querySelector('.hud'));
  });
  assert(hud, `${name}: HUD root was unavailable before capture`);
  await page.waitForTimeout(260);
  const opacity = await page.locator('.hud').evaluate((element) => getComputedStyle(element).opacity);
  assert(Number(opacity) === 0, `${name}: HUD remained visible in capture`, { opacity });
  const path = `${outputDir}/${name}.png`;
  const png = await page.screenshot({ path });
  const dimensions = png.length >= 24
    ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    : null;
  assert(dimensions?.width === viewport.width && dimensions?.height === viewport.height,
    `${name}: capture was not exactly 1280x720`, dimensions);
  captures.push({ path, ...dimensions });
  await page.evaluate(() => {
    const restore = window.__SF_LOCOMOTION_FACING_CAPTURE_RESTORE__;
    const app = document.querySelector('#app');
    const combatOverlay = document.querySelector('.combat-overlay');
    if (!restore?.hadBeautyClass) app?.classList.remove('is-beauty');
    if (combatOverlay) combatOverlay.style.visibility = restore?.combatVisibility ?? '';
    if (restore?.nameTag && restore.nameTagVisible != null) {
      restore.nameTag.visible = restore.nameTagVisible;
    }
    if (restore?.nameTag?.material && restore.nameTagMaterialVisible != null) {
      restore.nameTag.material.visible = restore.nameTagMaterialVisible;
    }
    for (const entry of restore?.nameTags || []) {
      entry.object.visible = entry.objectVisible;
      if (entry.object.material && entry.materialVisible != null) {
        entry.object.material.visible = entry.materialVisible;
      }
    }
    delete window.__SF_LOCOMOTION_FACING_CAPTURE_RESTORE__;
  });
  await page.waitForTimeout(30);
}

function expectedWorldDirection(axis, yaw) {
  const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const x = right.x * axis.x + forward.x * axis.z;
  const z = right.z * axis.x + forward.z * axis.z;
  const length = Math.hypot(x, z) || 1;
  return { x: x / length, z: z / length };
}

function summarizeScenario(definition, stagedState, samples, endState, inputLeakDistance) {
  const movingSamples = samples.filter((sample) => sample.locomotion?.moving === true);
  const firstMovingAt = movingSamples[0]?.at ?? null;
  let settledAt = null;
  for (let index = 0; index <= movingSamples.length - 3; index += 1) {
    const window = movingSamples.slice(index, index + 3);
    if (window.every((sample) => finite(sample.locomotion?.facingErrorRadians)
      && Math.abs(sample.locomotion.facingErrorRadians) <= facingLimitRadians)) {
      settledAt = movingSamples[index].at;
      break;
    }
  }
  const settleMs = settledAt == null || firstMovingAt == null ? null : settledAt - firstMovingAt;
  const postBudgetSamples = firstMovingAt == null
    ? []
    : movingSamples.filter((sample) => sample.at >= firstMovingAt + settleBudgetMs);
  const alignedPostBudget = postBudgetSamples.filter((sample) => (
    finite(sample.locomotion?.facingErrorRadians)
      && Math.abs(sample.locomotion.facingErrorRadians) <= facingLimitRadians
  ));
  const alignedRatio = postBudgetSamples.length
    ? alignedPostBudget.length / postBudgetSamples.length
    : 0;
  const telemetryValidSamples = movingSamples.filter((sample) => {
    const locomotion = sample.locomotion;
    const displacement = locomotion?.displacement;
    if (![locomotion?.facingYaw, locomotion?.targetYaw,
      locomotion?.facingErrorRadians, displacement?.x,
      displacement?.z, displacement?.length].every(finite)) return false;
    const derivedLength = Math.hypot(displacement.x, displacement.z);
    const derivedError = Math.abs(angleDifference(locomotion.targetYaw, locomotion.facingYaw));
    const targetFromDisplacement = Math.atan2(displacement.x, displacement.z);
    return Math.abs(derivedLength - displacement.length) <= 0.002
      && Math.abs(derivedError - Math.abs(locomotion.facingErrorRadians)) <= 0.01
      && Math.abs(angleDifference(targetFromDisplacement, locomotion.targetYaw)) <= 0.02;
  });
  const groundResiduals = movingSamples
    .map((sample) => Number(sample.avatar?.groundResidual))
    .filter(finite);
  const maxObservedGroundResidual = groundResiduals.length
    ? Math.max(...groundResiduals.map(Math.abs))
    : null;
  const start = stagedState?.avatar?.position;
  const end = endState?.avatar?.position;
  const displacement = distance2d(start, end);
  const dx = Number(end?.x) - Number(start?.x);
  const dz = Number(end?.z) - Number(start?.z);
  const expected = expectedWorldDirection(definition.axis, stagedState?.yaw);
  const directionDot = displacement > 0
    ? (dx * expected.x + dz * expected.z) / displacement
    : null;
  const durationMs = movingSamples.length > 1
    ? movingSamples.at(-1).at - movingSamples[0].at
    : 0;
  const maxFacingErrorDegrees = movingSamples.length
    ? Math.max(...movingSamples.map((sample) => Math.abs(degrees(
      sample.locomotion?.facingErrorRadians,
    ))))
    : null;

  const summary = {
    keys: definition.keys,
    sampleCount: samples.length,
    movingSampleCount: movingSamples.length,
    durationMs,
    settleMs,
    postBudgetSampleCount: postBudgetSamples.length,
    postBudgetAlignedRatio: alignedRatio,
    maxFacingErrorDegrees,
    telemetryValidSampleCount: telemetryValidSamples.length,
    displacement,
    directionDot,
    expectedDirection: expected,
    maxGroundResidual: maxObservedGroundResidual,
    inputLeakDistance,
  };

  assert(samples.length >= 30 && movingSamples.length >= 24,
    `${definition.id}: insufficient per-RAF held-input samples`, summary);
  assert(telemetryValidSamples.length === movingSamples.length,
    `${definition.id}: locomotion telemetry was missing, non-finite, or internally inconsistent`, summary);
  assert(finite(settleMs) && settleMs <= settleBudgetMs,
    `${definition.id}: avatar facing did not settle within 250ms`, summary);
  assert(postBudgetSamples.length >= 12 && alignedRatio >= postSettleAlignmentRatio,
    `${definition.id}: fewer than 95% of post-settle RAF samples were within 12 degrees`, summary);
  assert(finite(displacement) && displacement >= minDisplacement,
    `${definition.id}: real held input displaced the avatar less than 4m`, summary);
  assert(finite(directionDot) && directionDot >= 0.97,
    `${definition.id}: avatar displacement did not match the requested input direction`, summary);
  assert(groundResiduals.length === movingSamples.length
    && finite(maxObservedGroundResidual)
    && maxObservedGroundResidual <= maxGroundResidual,
  `${definition.id}: avatar left the ground-residual contract during movement`, summary);
  assert(movingSamples.every((sample) => sample.mode === 'walk'
    && sample.avatar?.visible === true
    && sample.transitionActive === false),
  `${definition.id}: traversal mode, avatar visibility, or transition state changed during input`, summary);
  assert(inputLeakDistance <= 0.08,
    `${definition.id}: movement continued after all held keys were released`, summary);
  return summary;
}

async function readResources() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      domNodes: document.querySelectorAll('*').length,
      geometries: sim?.renderer?.info?.memory?.geometries ?? null,
      textures: sim?.renderer?.info?.memory?.textures ?? null,
      recorderPresent: Boolean(window.__SF_LOCOMOTION_FACING_RECORDER__),
      captureRestorePresent: Boolean(window.__SF_LOCOMOTION_FACING_CAPTURE_RESTORE__),
      beautyClass: document.querySelector('#app')?.classList.contains('is-beauty') ?? null,
      combatVisibility: document.querySelector('.combat-overlay')?.style.visibility ?? null,
      nameTagMaterialVisible: sim?.playerAvatar?.userData?.nameTag?.material?.visible ?? null,
    };
  });
}

async function runScenario(definition) {
  const stagedState = await stageScenario(definition.id);
  const startPosition = stagedState?.avatar?.position;
  await startRecorder();
  try {
    for (const key of definition.keys) await page.keyboard.down(key);
    const moved = await page.waitForFunction(({ start, distance }) => {
      const position = window.__SF_SIM__?.getTraversalCameraState?.()?.avatar?.position;
      return position && Math.hypot(position.x - start.x, position.z - start.z) >= distance;
    }, { start: startPosition, distance: minDisplacement }, {
      timeout: 4000,
      polling: 'raf',
    }).then(() => true).catch(() => false);
    assert(moved, `${definition.id}: held input did not reach 4m within four seconds`);
    await captureHudFree(definition.id);
    const endState = await readState();
    const samples = await stopRecorder();
    for (const key of [...definition.keys].reverse()) await page.keyboard.up(key);
    await page.waitForFunction(() => (
      window.__SF_SIM__?.getTraversalCameraState?.()?.avatar?.locomotion?.moving === false
    ), null, { timeout: 1200, polling: 20 });
    const releasedStart = await readState();
    await page.waitForTimeout(220);
    const releasedEnd = await readState();
    const inputLeakDistance = distance2d(
      releasedStart?.avatar?.position,
      releasedEnd?.avatar?.position,
    );
    const summary = summarizeScenario(
      definition,
      stagedState,
      samples,
      endState,
      inputLeakDistance,
    );
    scenarios.push({ id: definition.id, ...summary });
  } finally {
    for (const key of [...definition.keys].reverse()) await page.keyboard.up(key).catch(() => {});
    await page.evaluate(() => {
      const recorder = window.__SF_LOCOMOTION_FACING_RECORDER__;
      if (recorder) recorder.active = false;
      delete window.__SF_LOCOMOTION_FACING_RECORDER__;
    }).catch(() => {});
  }
}

try {
  await launch();
  const environment = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const gl = sim?.renderer?.getContext?.();
    const debug = gl?.getExtension?.('WEBGL_debug_renderer_info');
    return {
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      canvas: {
        width: document.querySelector('#scene-canvas')?.clientWidth ?? null,
        height: document.querySelector('#scene-canvas')?.clientHeight ?? null,
      },
    };
  });
  renderer = environment.renderer;
  assert(/metal/i.test(renderer || '') && !/swiftshader|software|llvmpipe/i.test(renderer || ''),
    'renderer is not system Chrome on Apple Metal', environment);
  assert(environment.viewport.width === viewport.width
    && environment.viewport.height === viewport.height
    && environment.canvas.width === viewport.width
    && environment.canvas.height === viewport.height,
  'browser viewport or WebGL canvas was not exactly 1280x720', environment);

  await stageScenario('warmup');
  await page.waitForTimeout(1000);
  resourceBaseline = await readResources();
  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());

  for (const definition of scenarioDefinitions) await runScenario(definition);

  await page.waitForFunction(() => (
    (window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0) >= 180
  ), null, { timeout: 12000, polling: 50 });
  performanceSnapshot = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  resourceAfter = await readResources();
  const resourceDelta = {
    domNodes: Number(resourceAfter.domNodes) - Number(resourceBaseline.domNodes),
    geometries: Number(resourceAfter.geometries) - Number(resourceBaseline.geometries),
    textures: Number(resourceAfter.textures) - Number(resourceBaseline.textures),
  };

  assert(captures.length === scenarioDefinitions.length,
    'not all five HUD-free direction captures were written', captures);
  assert(performanceSnapshot?.applicationFrameCount >= 180
    && finite(performanceSnapshot?.applicationP99FrameMs)
    && performanceSnapshot.applicationP99FrameMs <= 16.67,
  'locomotion-facing verification exceeded the 16.67ms application p99 budget', performanceSnapshot);
  assert(resourceAfter.recorderPresent === false
    && resourceAfter.captureRestorePresent === false
    && resourceAfter.beautyClass === resourceBaseline.beautyClass
    && resourceAfter.combatVisibility === resourceBaseline.combatVisibility
    && resourceAfter.nameTagMaterialVisible === resourceBaseline.nameTagMaterialVisible,
  'locomotion-facing verification leaked recorder or HUD-free capture state', {
    baseline: resourceBaseline,
    after: resourceAfter,
    delta: resourceDelta,
  });
  assert(consoleErrors.length === 0, 'page/console errors occurred', consoleErrors);
  assert(httpErrors.length === 0, 'HTTP errors occurred', httpErrors);
  assert(requestErrors.length === 0, 'request failures occurred', requestErrors);

  const report = {
    result: failures.length === 0
      && consoleErrors.length === 0
      && httpErrors.length === 0
      && requestErrors.length === 0
      ? 'locomotion-facing gate passed'
      : 'locomotion-facing gate failed',
    baseUrl,
    angle,
    renderer,
    viewport,
    contract: {
      input: 'real held W / S / A / D / W+D',
      telemetry: 'getTraversalCameraState().avatar.locomotion sampled every RAF',
      settleBudgetMs,
      facingLimitDegrees: 12,
      postSettleAlignmentRatio,
      minDisplacement,
      maxGroundResidual,
      applicationP99FrameMs: 16.67,
    },
    scenarios,
    captures,
    resources: {
      baseline: resourceBaseline,
      after: resourceAfter,
      delta: resourceDelta,
    },
    performance: performanceSnapshot,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'locomotion-facing gate passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'locomotion-facing gate failed',
    error: error.message,
    stack: error.stack,
    renderer,
    scenarios,
    captures,
    resources: { baseline: resourceBaseline, after: resourceAfter },
    performance: performanceSnapshot,
    consoleErrors,
    httpErrors,
    requestErrors,
    failures,
  }, null, 2));
  process.exitCode = 1;
} finally {
  for (const key of ['w', 's', 'a', 'd']) await page.keyboard.up(key).catch(() => {});
  await page.evaluate(() => {
    const recorder = window.__SF_LOCOMOTION_FACING_RECORDER__;
    if (recorder) recorder.active = false;
    delete window.__SF_LOCOMOTION_FACING_RECORDER__;
    delete window.__SF_LOCOMOTION_FACING_CAPTURE_RESTORE__;
  }).catch(() => {});
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
