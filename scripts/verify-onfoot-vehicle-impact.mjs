import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const chrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(chrome).then(() => chrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const captureDir = process.env.SF_QA_CAPTURE_DIR || '.qa-onfoot-vehicle-impact';
const captures = {
  impact: join(captureDir, 'impact.png'),
  block: join(captureDir, 'block.png'),
  rearm: join(captureDir, 'rearm.png'),
  negative: join(captureDir, 'negative.png'),
};

if (process.platform !== 'darwin' || angle !== 'metal' || !executablePath) {
  throw new Error('verify-onfoot-vehicle-impact requires macOS System Chrome and SF_QA_ANGLE=metal.');
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
  await page.waitForFunction(() => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    null, { timeout: 15000 });
  await page.locator('canvas').focus();
  await page.waitForTimeout(500);
}

async function snapshot() {
  return page.evaluate(() => {
    const qa = window.__SF_SIM__?.getOnFootVehicleImpactQa?.();
    return qa?.snapshot?.() ?? { contractError: 'getOnFootVehicleImpactQa().snapshot() is required' };
  });
}

async function stage(kind) {
  const result = await page.evaluate(async (requestedKind) => {
    const qa = window.__SF_SIM__?.getOnFootVehicleImpactQa?.();
    if (!qa || typeof qa.stage !== 'function' || typeof qa.snapshot !== 'function') {
      return { contractError: 'getOnFootVehicleImpactQa() must expose stage() and snapshot()' };
    }
    return qa.stage({ kind: requestedKind });
  }, kind);
  assert(result?.ready === true && result?.syntheticEvents === 0,
    `${kind} staging was unavailable or mutated measured impact state`, result);
  if (result?.contractError) {
    throw new Error(`on-foot vehicle impact QA contract unavailable: ${result.contractError}`);
  }
  return result;
}

async function waitFor(predicate, expected, message, timeout = 7000) {
  try {
    await page.waitForFunction((test) => {
      const state = window.__SF_SIM__?.getOnFootVehicleImpactQa?.()?.snapshot?.();
      if (!state) return false;
      if (test.kind === 'contact') return state.impact?.events >= test.expected;
      if (test.kind === 'clear') return state.impact?.latched === false && state.impact?.finalOverlap === false;
      return false;
    }, { kind: predicate, expected }, { timeout, polling: 25 });
    return true;
  } catch {
    assert(false, message, await snapshot());
    return false;
  }
}

async function realMove(key, duration) {
  await page.locator('canvas').focus();
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
}

async function capture(path) {
  await page.waitForTimeout(120);
  await page.screenshot({ path });
}

function resources(state) {
  return state.resources || {};
}

// The collision system works from a disc/footprint broad phase. This probe
// deliberately reads the rendered roots after a measured contact so a root
// correction cannot hide an avatar mesh inside the visible vehicle shell.
async function renderedContactGeometry() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getOnFootVehicleImpactQa?.()?.snapshot?.();
    const avatar = sim?.playerAvatar;
    const vehicle = sim?.traffic?.group?.children?.[state?.vehicle?.vehicleId];
    if (!state?.vehicle || !avatar || !vehicle) return null;

    const transform = (point, elements) => ({
      x: elements[0] * point.x + elements[4] * point.y + elements[8] * point.z + elements[12],
      y: elements[1] * point.x + elements[5] * point.y + elements[9] * point.z + elements[13],
      z: elements[2] * point.x + elements[6] * point.y + elements[10] * point.z + elements[14],
    });
    const collectVertices = (root) => {
      root.updateMatrixWorld(true);
      const vertices = [];
      root.traverse((node) => {
        const position = node.visible && node.isMesh ? node.geometry?.attributes?.position : null;
        if (!position) return;
        const matrix = node.matrixWorld.elements;
        const vertex = node.position.clone();
        for (let index = 0; index < position.count; index += 1) {
          // SkinnedMesh geometry positions are bind-pose coordinates. Query
          // the skinned vertex before matrixWorld so the verifier samples the
          // same animated silhouette the renderer displays.
          if (node.isSkinnedMesh && typeof node.getVertexPosition === 'function') {
            node.getVertexPosition(index, vertex);
          } else {
            vertex.set(position.getX(index), position.getY(index), position.getZ(index));
          }
          vertices.push(transform(vertex, matrix));
        }
      });
      if (!vertices.length) return { vertices, box: null };
      const box = vertices.reduce((bounds, point) => ({
        min: {
          x: Math.min(bounds.min.x, point.x),
          y: Math.min(bounds.min.y, point.y),
          z: Math.min(bounds.min.z, point.z),
        },
        max: {
          x: Math.max(bounds.max.x, point.x),
          y: Math.max(bounds.max.y, point.y),
          z: Math.max(bounds.max.z, point.z),
        },
      }), {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
      });
      return { vertices, box };
    };
    const avatarGeometry = collectVertices(avatar);
    const vehicleGeometry = collectVertices(vehicle);
    if (!avatarGeometry.box || !vehicleGeometry.box) return null;

    const heading = state.vehicle.heading;
    const forward = { x: Math.sin(heading), z: Math.cos(heading) };
    const right = { x: forward.z, z: -forward.x };
    const origin = state.vehicle.position;
    const toVehicleLocal = (point) => {
      const x = point.x - origin.x;
      const z = point.z - origin.z;
      return {
        forward: x * forward.x + z * forward.z,
        right: x * right.x + z * right.z,
        y: point.y,
      };
    };
    const vehicleLocal = vehicleGeometry.vertices.map(toVehicleLocal);
    const vehicleObb = vehicleLocal.reduce((bounds, point) => ({
      min: {
        forward: Math.min(bounds.min.forward, point.forward),
        right: Math.min(bounds.min.right, point.right),
        y: Math.min(bounds.min.y, point.y),
      },
      max: {
        forward: Math.max(bounds.max.forward, point.forward),
        right: Math.max(bounds.max.right, point.right),
        y: Math.max(bounds.max.y, point.y),
      },
    }), {
      min: { forward: Infinity, right: Infinity, y: Infinity },
      max: { forward: -Infinity, right: -Infinity, y: -Infinity },
    });
    const outsideDistance = (value, minimum, maximum) => Math.max(minimum - value, 0, value - maximum);
    let intersectingVertices = 0;
    let minSilhouetteClearance = Infinity;
    for (const point of avatarGeometry.vertices) {
      const local = toVehicleLocal(point);
      const forwardGap = outsideDistance(local.forward, vehicleObb.min.forward, vehicleObb.max.forward);
      const rightGap = outsideDistance(local.right, vehicleObb.min.right, vehicleObb.max.right);
      const verticalGap = outsideDistance(local.y, vehicleObb.min.y, vehicleObb.max.y);
      const clearance = Math.hypot(forwardGap, rightGap, verticalGap);
      minSilhouetteClearance = Math.min(minSilhouetteClearance, clearance);
      if (forwardGap === 0 && rightGap === 0 && verticalGap === 0) intersectingVertices += 1;
    }
    const boxesOverlap = (left, right) => (
      left.min.x < right.max.x && left.max.x > right.min.x
      && left.min.y < right.max.y && left.max.y > right.min.y
      && left.min.z < right.max.z && left.max.z > right.min.z
    );
    const project = (point) => {
      const view = transform(point, sim.camera.matrixWorldInverse.elements);
      const projection = sim.camera.projectionMatrix.elements;
      const x = projection[0] * view.x + projection[4] * view.y + projection[8] * view.z + projection[12];
      const y = projection[1] * view.x + projection[5] * view.y + projection[9] * view.z + projection[13];
      const w = projection[3] * view.x + projection[7] * view.y + projection[11] * view.z + projection[15];
      return w > 0 ? { x: x / w, y: y / w, visible: Math.abs(x / w) <= 1 && Math.abs(y / w) <= 1 } : null;
    };
    const center = (box) => ({
      x: (box.min.x + box.max.x) * 0.5,
      y: (box.min.y + box.max.y) * 0.5,
      z: (box.min.z + box.max.z) * 0.5,
    });
    const avatarScreen = project(center(avatarGeometry.box));
    const vehicleScreen = project(center(vehicleGeometry.box));
    return {
      avatarBox: avatarGeometry.box,
      vehicleBox: vehicleGeometry.box,
      vehicleObb,
      avatarVertices: avatarGeometry.vertices.length,
      vehicleVertices: vehicleGeometry.vertices.length,
      boxOverlap: boxesOverlap(avatarGeometry.box, vehicleGeometry.box),
      silhouette: { intersectingVertices, minClearance: minSilhouetteClearance },
      screen: { avatar: avatarScreen, vehicle: vehicleScreen },
    };
  });
}

function assertRenderedClearance(label, before, after, geometry) {
  const corrected = after.impact?.lastContact?.correctedPosition;
  const renderedCorrection = after.impact?.lastContact?.consequence?.correctedPosition;
  const renderedBody = after.player?.renderedBody;
  const bodyClearance = after.vehicle?.bodyClearance;
  const correctionConsistency = corrected && renderedCorrection ? Math.hypot(
    corrected.x - renderedCorrection.x,
    corrected.z - renderedCorrection.z,
  ) : Infinity;
  assert(renderedBody?.source === 'Shared skinned adult body'
    && renderedBody?.bounds?.min && renderedBody?.bounds?.max
    && after.vehicle?.obb && after.vehicle?.renderedBounds?.min && after.vehicle?.renderedBounds?.max,
  `${label} did not expose the authoritative rendered avatar Box3 and vehicle OBB/Box3`, after);
  assert(Number.isFinite(bodyClearance?.root) && bodyClearance.root >= 0
    && Number.isFinite(bodyClearance?.renderedSat) && bodyClearance.renderedSat > 0
    && bodyClearance.renderedOverlap === false,
  `${label} left the authoritative rendered avatar silhouette inside the vehicle OBB`, {
    renderedBody,
    vehicle: after.vehicle,
    independentRenderedRootSample: geometry,
  });
  assert(geometry?.avatarVertices > 0 && geometry?.vehicleVertices > 0
    && geometry?.avatarBox && geometry?.vehicleBox && geometry?.vehicleObb
    && geometry?.boxOverlap === false
    && geometry?.silhouette?.intersectingVertices === 0
    && Number.isFinite(geometry?.silhouette?.minClearance)
    && geometry.silhouette.minClearance >= 0.004,
  `${label} left the independently sampled rendered avatar silhouette inside the vehicle shell`, geometry);
  assert(after.impact?.corrections > (before.impact?.corrections || 0)
    && after.impact?.lastContact?.consequence?.blocked === true
    && after.impact?.lastContact?.consequence?.avatarSynchronized === true
    && correctionConsistency <= 0.001,
  `${label} did not produce a readable rendered pushback/rewind`, {
    before,
    after,
    correctionConsistency,
    geometry,
  });
}

try {
  await launch();
  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string' && /metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe)/i.test(renderer),
  'Apple Metal hardware rendering is required', { renderer, angle });

  await stage('high-speed');
  const highBefore = await snapshot();
  assert(highBefore.player?.onFoot === true && highBefore.vehicle?.speed > highBefore.thresholds?.damageSpeed,
    'high-speed scenario was not an on-foot moving civilian contact', highBefore);
  await page.keyboard.down('w');
  await waitFor('contact', (highBefore.impact?.events || 0) + 1,
    'real W did not create a high-speed on-foot vehicle contact');
  const impact = await snapshot();
  await capture(captures.impact);
  assert(impact.impact?.events === (highBefore.impact?.events || 0) + 1
    && impact.impact?.damageEvents === (highBefore.impact?.damageEvents || 0) + 1
    && impact.player?.health < highBefore.player?.health
    && impact.player?.feedback?.active === true
    && impact.impact?.finalOverlap === false,
  'high-speed real contact did not apply exactly one damage/feedback event and separate the OBBs', {
    highBefore,
    impact,
  });
  const impactGeometry = await renderedContactGeometry();
  assertRenderedClearance('high-speed contact', highBefore, impact, impactGeometry);

  await page.waitForTimeout(700);
  await page.keyboard.up('w');
  const held = await snapshot();
  assert(held.impact?.events === impact.impact?.events
    && held.impact?.damageEvents === impact.impact?.damageEvents,
  'holding real W across contact repeated the impact or damage', { impact, held });

  await stage('low-speed');
  const lowBefore = await snapshot();
  await page.keyboard.down('w');
  await waitFor('contact', (lowBefore.impact?.events || 0) + 1,
    'real W did not create the low-speed block/push contact');
  const block = await snapshot();
  await capture(captures.block);
  assert(block.impact?.events === (lowBefore.impact?.events || 0) + 1
    && block.impact?.damageEvents === (lowBefore.impact?.damageEvents || 0)
    && block.player?.health === lowBefore.player?.health
    && block.impact?.finalOverlap === false,
  'low-speed contact was not a zero-damage block/push with separated OBBs', { lowBefore, block });
  const blockGeometry = await renderedContactGeometry();
  assertRenderedClearance('low-speed block', lowBefore, block, blockGeometry);

  await page.waitForTimeout(700);
  await page.keyboard.up('w');
  const blockHeld = await snapshot();
  assert(blockHeld.impact?.events === block.impact?.events
    && blockHeld.impact?.damageEvents === block.impact?.damageEvents,
  'holding real W against the stationary solid vehicle repeated its blocking contact', { block, blockHeld });

  await realMove('s', 650);
  await realMove('a', 320);
  await realMove('d', 320);
  await waitFor('clear', null, 'real S/A separation did not clear the stationary blocker latch');
  await page.keyboard.down('w');
  await waitFor('contact', (block.impact?.events || 0) + 1,
    'real W re-entry did not create exactly one new stationary blocking contact');
  const rearm = await snapshot();
  await page.keyboard.up('w');
  await capture(captures.rearm);
  assert(rearm.impact?.events === block.impact?.events + 1
    && rearm.impact?.damageEvents === block.impact?.damageEvents
    && rearm.player?.health === block.player?.health
    && rearm.impact?.finalOverlap === false,
  'separation/re-entry did not rearm exactly one zero-damage stationary blocking contact', {
    block,
    rearm,
  });
  const rearmGeometry = await renderedContactGeometry();
  assertRenderedClearance('stationary re-entry', blockHeld, rearm, rearmGeometry);

  await stage('disabled');
  const disabledBefore = await snapshot();
  await page.keyboard.down('w');
  await waitFor('contact', (disabledBefore.impact?.events || 0) + 1,
    'real W did not block against a visible disabled vehicle');
  const disabledBlock = await snapshot();
  await page.keyboard.up('w');
  assert(disabledBlock.impact?.events === (disabledBefore.impact?.events || 0) + 1
    && disabledBlock.impact?.damageEvents === (disabledBefore.impact?.damageEvents || 0)
    && disabledBlock.player?.health === disabledBefore.player?.health
    && disabledBlock.impact?.finalOverlap === false,
  'visible disabled vehicle did not act as a zero-damage solid blocker', {
    disabledBefore,
    disabledBlock,
  });
  const disabledGeometry = await renderedContactGeometry();
  assertRenderedClearance('disabled solid block', disabledBefore, disabledBlock, disabledGeometry);

  const negatives = [];
  let negativeFrame = null;
  let negativeGeometry = null;
  let roadHeightDelta = null;
  for (const kind of ['parallel', 'hidden', 'garage', 'impounded', 'remote', 'downed']) {
    await stage(kind);
    const before = await snapshot();
    if (kind === 'parallel') {
      // The first parallel fixture is still on the Ferry/core road. Preserve
      // that measured, visible miss as evidence before later negatives move
      // the player or intentionally down them.
      await page.waitForTimeout(120);
      negativeFrame = await snapshot();
      negativeGeometry = await renderedContactGeometry();
      roadHeightDelta = Math.abs(
        negativeGeometry?.avatarBox?.min?.y - negativeGeometry?.vehicleBox?.min?.y,
      );
      assert(negativeFrame.player?.onFoot === true
        && negativeFrame.player?.status === 'running'
        && negativeFrame.player?.feedback?.active === false
        && negativeFrame.player?.feedback?.kind === null
        && negativeFrame.vehicle?.visible === true
        && negativeGeometry?.screen?.avatar?.visible === true
        && negativeGeometry?.screen?.vehicle?.visible === true
        && Number.isFinite(roadHeightDelta) && roadHeightDelta <= 0.65,
      'negative capture is not a clean on-road, visible parallel miss', {
        negativeFrame,
        negativeGeometry,
        roadHeightDelta,
      });
      await capture(captures.negative);
    }
    await realMove(kind === 'parallel' ? 'w' : 'd', 700);
    const after = await snapshot();
    negatives.push({ kind, before, after });
    assert(after.impact?.events === before.impact?.events
      && after.impact?.damageEvents === before.impact?.damageEvents
      && after.player?.health === before.player?.health
      && after.impact?.finalOverlap !== true,
    `${kind} negative path created an on-foot vehicle impact or penetration`, { before, after });
  }
  await stage('pursuit-responder');
  const responderBefore = await snapshot();
  await page.keyboard.down('w');
  await waitFor('contact', (responderBefore.impact?.events || 0) + 1,
    'real W did not reach the staged pursuit responder');
  const responderAfter = await snapshot();
  await page.keyboard.up('w');
  assert(responderAfter.impact?.events === (responderBefore.impact?.events || 0) + 1
    && responderAfter.impact?.damageEvents === responderBefore.impact?.damageEvents
    && responderAfter.impact?.finalOverlap === false,
    'pursuit responder contact added generic on-foot vehicle damage on top of StreetHeat authority', {
      responderBefore,
      responderAfter,
    });
  const responderGeometry = await renderedContactGeometry();
  assertRenderedClearance('pursuit responder block', responderBefore, responderAfter, responderGeometry);

  const resourceSamples = [highBefore, impact, held, lowBefore, block, blockHeld, rearm, disabledBefore,
    disabledBlock, negativeFrame, responderBefore, responderAfter, ...negatives.map(({ after }) => after)]
    .map(resources);
  assert(resourceSamples.every((sample) => Object.keys(resourceSamples[0]).every((key) => (
    Number.isFinite(sample[key]) && sample[key] === resourceSamples[0][key]
  ))), 'on-foot vehicle contact scenarios grew resources', resourceSamples);

  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0
  ) >= 180, null, { timeout: 12000, polling: 50 });
  const performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  assert(performance?.applicationFrameCount >= 180
    && Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'on-foot vehicle impact exceeded the 16.67 ms application p99 budget', performance);
  assert(consoleErrors.length === 0 && httpErrors.length === 0 && requestFailures.length === 0,
    'runtime errors leaked during on-foot vehicle impact verification', {
      consoleErrors, httpErrors, requestFailures,
    });

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0
      && httpErrors.length === 0 && requestFailures.length === 0,
    renderer,
    impact,
    impactGeometry,
    block,
    blockGeometry,
    disabledBlock,
    disabledGeometry,
    responder: responderAfter,
    responderGeometry,
    rearm,
    rearmGeometry,
    negatives,
    negativeFrame,
    negativeGeometry,
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
  console.error(JSON.stringify({ result: 'on-foot vehicle impact verifier failed', error: error.message, failures }, null, 2));
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
