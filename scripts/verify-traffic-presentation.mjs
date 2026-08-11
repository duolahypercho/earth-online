import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const viewport = { width: 1280, height: 720 };
const outputDir = resolve(process.env.SF_TRAFFIC_PRESENTATION_DIR || '.qa-traffic-presentation');
const captures = {
  hudDrive: join(outputDir, 'hud-drive.png'),
  hudlessDrive: join(outputDir, 'hudless-drive.png'),
  combatSide: join(outputDir, 'combat-side.png'),
  pursuitResponder: join(outputDir, 'pursuit-responder.png'),
};
const resultsPath = join(outputDir, 'results.json');

await mkdir(outputDir, { recursive: true });

if (process.platform !== 'darwin') {
  throw new Error('verify-traffic-presentation requires macOS so Apple Metal can be verified.');
}
if (angle !== 'metal') {
  throw new Error(`verify-traffic-presentation requires SF_QA_ANGLE=metal, received ${angle}`);
}
if (!executablePath) {
  throw new Error(`System Chrome is required for the Apple Metal gate: ${systemChrome}`);
}

const failures = [];
const consoleErrors = [];
const httpErrors = [];
const requestErrors = [];
const evidence = {
  renderer: null,
  captures: {},
  scenarios: {},
  classProfiles: null,
  lod: null,
  resources: { initial: null, before: null, after: null },
  performance: null,
};

const assert = (condition, message, detail = null) => {
  if (!condition) failures.push({ message, ...(detail == null ? {} : { detail }) });
};

function watchPageDiagnostics(page) {
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
}

async function launch(page) {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('earth-online-player-progress-v1'));
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  await page.locator('#launch-button').click();
  await page.waitForFunction(() => document.querySelector('#boot-overlay')
    ?.classList.contains('is-dismissed'), null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const sim = window.__SF_SIM__;
    return sim?.renderer
      && sim?.traffic?.group
      && typeof sim.traffic.getVehicleLifeSnapshot === 'function'
      && typeof sim.traffic.setRemotePose === 'function'
      && typeof sim.traffic.clearRemotePose === 'function'
      && typeof sim.traffic.setPursuitResponder === 'function'
      && typeof sim.setCameraPose === 'function'
      && typeof sim.setRoamPose === 'function'
      && typeof sim.getPerformanceSnapshot === 'function'
      && typeof sim.resetPerformanceTelemetry === 'function';
  }, null, { timeout: 15000, polling: 25 });
  await page.waitForTimeout(900);
  await page.locator('#scene-canvas').focus();
}

async function waitForWorldSettled(page, timeout = 15000) {
  const settled = await page.waitForFunction(() => {
    const stats = window.__SF_SIM__?.streaming?.getStats?.();
    return !stats || (stats.populationPending === 0 && stats.handoffs?.pending === 0);
  }, null, { timeout, polling: 50 }).then(() => true).catch(() => false);
  await page.waitForTimeout(700);
  return settled;
}

async function capture(page, key) {
  const buffer = await page.screenshot({ path: captures[key], animations: 'disabled' });
  const dimensions = buffer.length >= 24 && buffer.subarray(1, 4).toString() === 'PNG'
    ? { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    : null;
  evidence.captures[key] = { path: captures[key], bytes: buffer.length, dimensions };
  assert(dimensions?.width === viewport.width && dimensions?.height === viewport.height,
    `${key} capture was not exactly ${viewport.width}x${viewport.height}`, dimensions);
}

async function readResources(page) {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const stats = sim.streaming?.getStats?.() ?? null;
    return {
      geometries: sim.renderer?.info?.memory?.geometries ?? null,
      textures: sim.renderer?.info?.memory?.textures ?? null,
      programs: sim.renderer?.info?.programs?.length ?? null,
      streaming: stats ? {
        populationPending: stats.populationPending ?? null,
        handoffPending: stats.handoffs?.pending ?? null,
      } : null,
    };
  });
}

async function measureVehicle(page, vehicleId) {
  return page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const root = sim?.traffic?.group?.children?.[id];
    if (!root) return null;
    root.updateWorldMatrix(true, true);
    sim.camera.updateMatrixWorld(true);
    const Vector3 = sim.camera.position.constructor;
    const canvas = sim.renderer.domElement;

    const effectivelyVisible = (object) => {
      let cursor = object;
      while (cursor) {
        if (cursor.visible === false) return false;
        if (cursor === root) return true;
        cursor = cursor.parent;
      }
      return false;
    };
    const ancestryName = (object) => {
      const names = [];
      let cursor = object;
      while (cursor && cursor !== root) {
        if (cursor.name) names.push(cursor.name);
        cursor = cursor.parent;
      }
      return names.join(' ');
    };
    const visibleMeshes = [];
    root.traverse((object) => {
      if (object.isMesh && object.geometry && effectivelyVisible(object)) visibleMeshes.push(object);
    });
    const shadowMeshes = visibleMeshes.filter((mesh) => (
      /contact shadow|shadow decal/i.test(`${mesh.name} ${ancestryName(mesh)}`)
    ));
    const detailedWheelGroup = root.children.find((child) => (
      child.isGroup
      && child.children.length >= 2
      && child.children.every((entry) => entry.isMesh && /cylinder/i.test(entry.geometry?.type || ''))
    ));
    const wheelMeshes = detailedWheelGroup && effectivelyVisible(detailedWheelGroup)
      ? detailedWheelGroup.children.filter((mesh) => mesh.isMesh && effectivelyVisible(mesh))
      : visibleMeshes.filter((mesh) => /wheel|tire|tyre/i.test(
        `${mesh.name} ${ancestryName(mesh)}`,
      ));
    const wheelSet = new Set(wheelMeshes);
    const shadowSet = new Set(shadowMeshes);
    const bodyMeshes = visibleMeshes.filter((mesh) => !wheelSet.has(mesh) && !shadowSet.has(mesh));

    const cornersFor = (mesh, local = false) => {
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box) return [];
      const points = [];
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const point = new Vector3(x, y, z).applyMatrix4(mesh.matrixWorld);
            if (local) root.worldToLocal(point);
            points.push(point);
          }
        }
      }
      return points;
    };
    const boundsFor = (meshes, local = false) => {
      const points = meshes.flatMap((mesh) => cornersFor(mesh, local));
      if (!points.length) return null;
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      points.forEach((point) => {
        min.min(point);
        max.max(point);
      });
      return {
        min: { x: min.x, y: min.y, z: min.z },
        max: { x: max.x, y: max.y, z: max.z },
        size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      };
    };
    const projectedRectFor = (meshes) => {
      const points = meshes.flatMap((mesh) => cornersFor(mesh));
      if (!points.length) return null;
      const projected = points.map((point) => point.project(sim.camera)).filter((point) => (
        Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
      ));
      if (!projected.length) return null;
      const xs = projected.map((point) => (point.x * 0.5 + 0.5) * canvas.clientWidth);
      const ys = projected.map((point) => (-point.y * 0.5 + 0.5) * canvas.clientHeight);
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      return {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
        centerX: (left + right) * 0.5,
        centerY: (top + bottom) * 0.5,
      };
    };
    const mode = visibleMeshes.some((mesh) => /distance silhouette|proxy/i.test(
      `${mesh.name} ${ancestryName(mesh)}`,
    )) ? 'proxy' : visibleMeshes.some((mesh) => /production|detailed|gltf/i.test(
      `${mesh.name} ${ancestryName(mesh)}`,
    )) ? 'production' : 'procedural';
    const wheelWorld = boundsFor(wheelMeshes);
    const bodyWorld = boundsFor(bodyMeshes);
    const wheelContacts = wheelMeshes.map((mesh) => {
      const bounds = boundsFor([mesh], true);
      const center = new Vector3();
      mesh.getWorldPosition(center);
      return {
        x: center.x,
        z: center.z,
        localSoleY: bounds?.min?.y ?? null,
        contactPlaneY: 0,
        residual: Number.isFinite(bounds?.min?.y) ? Math.abs(bounds.min.y) : null,
      };
    });
    const allMeshes = visibleMeshes.filter((mesh) => !shadowSet.has(mesh));
    return {
      id,
      class: root.userData?.vehicleClass ?? null,
      identity: root.userData?.vehicleIdentity ?? null,
      rootVisible: effectivelyVisible(root),
      mode,
      visibleMeshCount: visibleMeshes.length,
      wheelMeshCount: wheelMeshes.length,
      bodyMeshCount: bodyMeshes.length,
      rootY: root.position.y,
      wheelWorld,
      wheelContacts,
      bodyWorld,
      localBounds: boundsFor(allMeshes, true),
      rect: projectedRectFor(allMeshes),
      bodyRect: projectedRectFor(bodyMeshes),
      wheelRect: projectedRectFor(wheelMeshes),
    };
  }, vehicleId);
}

function verifyVehicleContinuity(label, measurement, { requireWheels = true } = {}) {
  assert(measurement?.rootVisible === true, `${label} vehicle root was not visible`, measurement);
  assert((measurement?.bodyMeshCount ?? 0) >= 1, `${label} had no visible vehicle body`, measurement);
  if (!requireWheels) return;
  assert((measurement?.wheelMeshCount ?? 0) >= 4,
    `${label} did not expose four connected visible wheels`, measurement);
  const tireRoadGap = measurement?.wheelContacts?.length
    && measurement.wheelContacts.every((contact) => Number.isFinite(contact.residual))
    ? Math.max(...measurement.wheelContacts.map((contact) => contact.residual))
    : Infinity;
  const bodyWheelGap = measurement?.bodyWorld && measurement?.wheelWorld
    ? measurement.bodyWorld.min.y - measurement.wheelWorld.max.y
    : Infinity;
  const projectedGap = measurement?.bodyRect && measurement?.wheelRect
    ? Math.max(0, measurement.wheelRect.top - measurement.bodyRect.bottom)
    : Infinity;
  assert(tireRoadGap <= 0.2,
    `${label} wheel soles exceeded the 0.2m authored road-contact envelope`, {
      tireRoadGap,
      rootY: measurement?.rootY,
      contacts: measurement?.wheelContacts,
    });
  assert(bodyWheelGap <= 0.12,
    `${label} body and wheels were visibly disconnected`, { bodyWheelGap, measurement });
  assert(projectedGap <= 2,
    `${label} body-to-wheel screen gap exceeded 2px`, { projectedGap, measurement });
}

function rectIou(left, right) {
  if (!left || !right) return 0;
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const intersection = width * height;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

async function setFixedCamera(page, target, {
  side = false,
  roadAxis = false,
  distance = 11,
} = {}) {
  await page.evaluate(({ point, sideView, roadAxisView, cameraDistance }) => {
    const sim = window.__SF_SIM__;
    const y = Number.isFinite(point.y) ? point.y : 0;
    const position = roadAxisView
      ? { x: point.x, y: y + 3.7, z: point.z - cameraDistance }
      : sideView
      ? { x: point.x + cameraDistance, y: y + 3.35, z: point.z + 0.4 }
      : { x: point.x + cameraDistance * 0.68, y: y + 3.7, z: point.z - cameraDistance * 0.72 };
    sim.setCameraPose(position, { x: point.x, y: y + 0.9, z: point.z });
  }, {
    point: target,
    sideView: side,
    roadAxisView: roadAxis,
    cameraDistance: distance,
  });
  await page.waitForTimeout(450);
}

async function measureForegroundOcclusion(page, vehicleId) {
  return page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const root = sim?.traffic?.group?.children?.[id];
    if (!root) return null;
    root.updateWorldMatrix(true, true);
    sim.camera.updateMatrixWorld(true);
    const Vector3 = sim.camera.position.constructor;
    const cameraPosition = sim.camera.position.clone();
    const target = root.position.clone();
    target.y += 0.9;
    const targetDirection = target.clone().sub(cameraPosition);
    const targetDistance = targetDirection.length();
    const nearestBlocker = (origin, direction, maxDistance) => {
      const candidates = [
        sim.city?.getNearestRayBlocker?.(origin, direction, maxDistance),
        sim.streaming?.getNearestRayBlocker?.(origin, direction, maxDistance),
      ].filter((entry) => Number.isFinite(entry?.distance));
      return candidates.sort((left, right) => left.distance - right.distance)[0] ?? null;
    };
    const lineOfSightBlocker = nearestBlocker(
      cameraPosition,
      targetDirection,
      Math.max(0.1, targetDistance - 0.6),
    );
    const foregroundLimit = Math.min(5.5, targetDistance * 0.55);
    const samples = [];
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 9; column += 1) {
        const ndcX = -0.92 + column * (1.84 / 8);
        const ndcY = 0.84 - row * (1.68 / 4);
        const samplePoint = new Vector3(ndcX, ndcY, 0.1).unproject(sim.camera);
        const direction = samplePoint.sub(cameraPosition).normalize();
        const blocker = nearestBlocker(cameraPosition, direction, foregroundLimit);
        samples.push({ ndcX, ndcY, blocked: Boolean(blocker), blocker });
      }
    }
    const blockedSamples = samples.filter((sample) => sample.blocked).length;
    return {
      camera: { x: cameraPosition.x, y: cameraPosition.y, z: cameraPosition.z },
      target: { x: target.x, y: target.y, z: target.z },
      targetDistance,
      foregroundLimit,
      lineOfSightBlocker,
      blockedSamples,
      sampleCount: samples.length,
      foregroundOcclusionRatio: blockedSamples / samples.length,
      samples,
    };
  }, vehicleId);
}

async function stagePlayerVehicle(page) {
  const candidate = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const vehicles = sim.traffic.getVehicleLifeSnapshot().vehicles;
    const enterable = (entry) => (
      entry.visible !== false
      && entry.class !== 'bike'
      && entry.damage?.disabled !== true
      && (entry.action?.key === 'parked' || entry.speed <= 0.9)
    );
    const vehicle = vehicles.find((entry) => (
      entry.class === 'sedan'
      && entry.identity?.category === 'private'
      && entry.damage?.disabled !== true
    )) ?? vehicles.find((entry) => (
      enterable(entry) && entry.identity?.category === 'private'
    )) ?? vehicles.find(enterable);
    if (!vehicle?.position) return null;
    sim.setRoamPose(vehicle.position);
    return vehicle;
  });
  if (!candidate) return null;
  await page.waitForTimeout(650);
  await page.locator('#scene-canvas').focus();
  const entered = await page.evaluate((id) => (
    window.__SF_SIM__.traffic.enterPlayerVehicle?.(id) === true
  ), candidate.id);
  if (!entered) return { candidate, entered: false };
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === true,
    null, { timeout: 4000, polling: 20 });
  const staged = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.exportPlayerVehicleState?.();
    if (!snapshot || snapshot.mode !== 'driving') return null;
    snapshot.position = { x: 28, z: 38 };
    snapshot.heading = 0;
    const imported = sim.traffic.importPlayerVehicleState?.(snapshot) === true;
    return { imported, player: sim.traffic.getPlayerVehicleState?.() ?? null };
  });
  await page.waitForTimeout(900);
  return { candidate, entered, staged };
}

async function selectClassVehicles(page) {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const fleet = sim.traffic.getVehicleLifeSnapshot().vehicles;
    const wanted = ['sedan', 'suv', 'pickup'];
    const selected = [];
    for (const cls of wanted) {
      const candidate = fleet.find((entry) => (
        entry.class === cls
        && entry.damage?.disabled !== true
      ));
      if (!candidate) continue;
      selected.push({ id: candidate.id, class: cls });
    }
    return selected;
  });
}

async function stageClassAtCore(page, vehicle) {
  const staged = await page.evaluate((target) => {
    const sim = window.__SF_SIM__;
    if (sim.isDriving?.()) sim.traffic.exitPlayerVehicle?.();
    const entered = sim.traffic.enterPlayerVehicle?.(target.id) === true;
    const snapshot = entered ? sim.traffic.exportPlayerVehicleState?.() : null;
    if (!snapshot || snapshot.mode !== 'driving') return { ...target, entered, imported: false };
    snapshot.position = { x: 28, z: 38 };
    snapshot.heading = 0;
    const imported = sim.traffic.importPlayerVehicleState?.(snapshot) === true;
    sim.setRoamPose({ x: 28, z: 38 });
    return { ...target, entered, imported };
  }, vehicle);
  await page.waitForTimeout(850);
  const state = await page.evaluate(() => window.__SF_SIM__?.traffic?.getPlayerVehicleState?.() ?? null);
  return { ...staged, position: state?.position ?? null, state };
}

async function parkStagedClass(page) {
  return page.evaluate(() => window.__SF_SIM__?.traffic?.exitPlayerVehicle?.() ?? null);
}

async function stagePursuitResponder(page) {
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.setCameraPose?.(null, null);
    sim.setRoamPose?.({ x: 28, z: 38 });
    sim.streetHeat?.importState?.({
      heat: 30,
      pursuitActive: true,
      responderContacts: 0,
      responderContactLatched: false,
      nearMisses: 0,
      witnessReports: 0,
      combatHold: 0,
      theftHold: 0,
    });
  });
  await waitForWorldSettled(page);
  await page.waitForFunction(() => (
    (window.__SF_SIM__?.traffic?.getPursuitResponders?.()?.length ?? 0) >= 1
  ), null, { timeout: 5000, polling: 25 });
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const responder = sim.traffic.getPursuitResponders?.()?.[0] ?? null;
    const id = responder?.index ?? responder?.id;
    if (!Number.isInteger(id)) return null;
    const record = sim.traffic.getVehicleLifeSnapshot().vehicles.find((entry) => entry.id === id) ?? null;
    const root = sim.traffic.group.children[id];
    return {
      id,
      position: { x: root.position.x, y: root.position.y, z: root.position.z },
      responder,
      record,
    };
  });
}

async function measureLodPair(page, vehicle, distances) {
  const measurements = [];
  for (const distance of distances) {
    await page.evaluate(({ point, distanceFromVehicle }) => {
      window.__SF_SIM__.setRoamPose({
        x: point.x + distanceFromVehicle,
        z: point.z,
      });
    }, { point: vehicle.position, distanceFromVehicle: distance });
    await page.waitForTimeout(220);
    await setFixedCamera(page, vehicle.position, { side: false, distance: 10 });
    measurements.push({ distance, measurement: await measureVehicle(page, vehicle.id) });
  }
  return measurements;
}

function verifyLodPair(label, pair) {
  const [near, far] = pair.map((entry) => entry.measurement);
  const iou = rectIou(near?.rect, far?.rect);
  const centerShift = near?.rect && far?.rect
    ? Math.hypot(near.rect.centerX - far.rect.centerX, near.rect.centerY - far.rect.centerY)
    : Infinity;
  const nearArea = (near?.rect?.width ?? 0) * (near?.rect?.height ?? 0);
  const farArea = (far?.rect?.width ?? 0) * (far?.rect?.height ?? 0);
  const areaDelta = nearArea > 0 ? Math.abs(farArea - nearArea) / nearArea : Infinity;
  assert(iou >= 0.86, `${label} LOD transition changed the projected silhouette (IoU < 0.86)`, {
    iou,
    pair,
  });
  assert(centerShift <= 3, `${label} LOD transition popped more than 3px`, { centerShift, pair });
  assert(areaDelta <= 0.12, `${label} LOD transition changed silhouette area by more than 12%`, {
    areaDelta,
    pair,
  });
  return { iou, centerShift, areaDelta, modes: pair.map((entry) => entry.measurement?.mode) };
}

let browser;
try {
  browser = await chromium.launch({
    headless: process.env.SF_QA_HEADLESS !== 'false',
    executablePath,
    args: [
      '--disable-dev-shm-usage',
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  watchPageDiagnostics(page);
  await launch(page);

  evidence.renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof evidence.renderer === 'string'
    && /apple.*metal|metal/i.test(evidence.renderer)
    && !/(swiftshader|software|llvmpipe)/i.test(evidence.renderer),
  'a verified Apple Metal hardware renderer was required; software rendering is rejected', {
    angle,
    renderer: evidence.renderer,
  });

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.setWeather?.('clear');
    sim.setTimeOfDay?.(7.4);
    sim.setRenderQuality?.('balanced');
    sim.streetHeat?.restart?.();
    sim.combat?.restart?.();
    sim.resetPerformanceTelemetry?.();
  });
  assert(await waitForWorldSettled(page), 'streaming did not settle before traffic presentation QA');
  evidence.resources.initial = await readResources(page);

  const drivingStage = await stagePlayerVehicle(page);
  assert(drivingStage?.entered === true && drivingStage?.staged?.imported === true,
    'could not stage the real player vehicle for drive captures', drivingStage);
  if (!drivingStage?.staged?.player?.index && drivingStage?.staged?.player?.index !== 0) {
    throw new Error('traffic presentation player-vehicle staging failed');
  }
  await page.waitForFunction(() => document.querySelector('[data-hud="san-francisco"]')
    ?.dataset?.contextMode === 'drive', null, { timeout: 4000, polling: 20 });
  const playerVehicleId = drivingStage.staged.player.index;
  const hudDriveMeasurement = await measureVehicle(page, playerVehicleId);
  evidence.scenarios.hudDrive = { stage: drivingStage, measurement: hudDriveMeasurement };
  verifyVehicleContinuity('HUD drive', hudDriveMeasurement);
  await capture(page, 'hudDrive');

  await page.evaluate(() => document.querySelector('#app')?.classList.add('is-beauty'));
  await page.waitForTimeout(400);
  const beautyState = await page.evaluate(() => {
    const app = document.querySelector('#app');
    const hud = document.querySelector('[data-hud="san-francisco"]');
    const style = hud ? getComputedStyle(hud) : null;
    return {
      beauty: app?.classList.contains('is-beauty') === true,
      hudOpacity: style ? Number.parseFloat(style.opacity) : null,
      hudVisibility: style?.visibility ?? null,
    };
  });
  assert(beautyState.beauty && (beautyState.hudOpacity === 0 || beautyState.hudVisibility === 'hidden'),
    'HUDless drive capture did not suppress the HUD', beautyState);
  const hudlessMeasurement = await measureVehicle(page, playerVehicleId);
  evidence.scenarios.hudlessDrive = { beautyState, measurement: hudlessMeasurement };
  verifyVehicleContinuity('HUDless drive', hudlessMeasurement);
  await capture(page, 'hudlessDrive');
  await page.evaluate(() => document.querySelector('#app')?.classList.remove('is-beauty'));

  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.traffic.setPlayerInput?.({ throttle: 0, brake: 1, steer: 0 });
    if (sim.isDriving?.()) sim.exitCar?.();
  });
  await page.waitForFunction(() => window.__SF_SIM__?.isDriving?.() === false,
    null, { timeout: 4000, polling: 20 });
  await page.waitForTimeout(550);

  const lineup = await selectClassVehicles(page);
  assert(lineup.length === 3,
    'sedan/SUV/pickup candidates could not be selected for silhouette QA', lineup);
  const profiles = [];
  for (const vehicle of lineup) {
    const stagedVehicle = await stageClassAtCore(page, vehicle);
    assert(stagedVehicle.entered && stagedVehicle.imported && stagedVehicle.position,
      `${vehicle.class} could not be staged on the proven core road`, stagedVehicle);
    if (!stagedVehicle.position) continue;
    await setFixedCamera(page, stagedVehicle.position, { side: true, distance: 11 });
    const measurement = await measureVehicle(page, stagedVehicle.id);
    verifyVehicleContinuity(`${stagedVehicle.class} profile`, measurement);
    const bounds = measurement?.localBounds?.size;
    profiles.push({
      id: stagedVehicle.id,
      class: stagedVehicle.class,
      stage: stagedVehicle,
      measurement,
      normalized: bounds && bounds.z > 0 ? {
        width: bounds.x / bounds.z,
        height: bounds.y / bounds.z,
      } : null,
    });
    await parkStagedClass(page);
    await page.waitForTimeout(160);
  }
  const profileComparisons = [];
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex];
      const right = profiles[rightIndex];
      const distance = left.normalized && right.normalized
        ? Math.hypot(
          left.normalized.width - right.normalized.width,
          left.normalized.height - right.normalized.height,
        )
        : 0;
      profileComparisons.push({ pair: [left.class, right.class], distance });
      assert(distance >= 0.055,
        `${left.class}/${right.class} silhouettes collapsed into the same normalized profile`, {
          distance,
          left: left.normalized,
          right: right.normalized,
        });
    }
  }
  evidence.classProfiles = { profiles, comparisons: profileComparisons };

  const combatCandidate = lineup.find((entry) => entry.class === 'sedan') ?? lineup[0];
  const combatVehicle = await stageClassAtCore(page, combatCandidate);
  assert(combatVehicle.entered && combatVehicle.imported && combatVehicle.position,
    'combat-side sedan could not be restaged on the proven core road', combatVehicle);
  await parkStagedClass(page);
  await page.waitForTimeout(240);
  await page.evaluate((vehicle) => {
    const sim = window.__SF_SIM__;
    sim.setRoamPose({
      x: vehicle.position.x - 3.4,
      z: vehicle.position.z,
      yaw: Math.PI * 0.5,
      pitch: 1.36,
      distance: 12,
    });
  }, combatVehicle);
  await page.waitForTimeout(500);
  const canvas = await page.locator('#scene-canvas').boundingBox();
  if (!canvas) throw new Error('scene canvas bounds unavailable for combat-side capture');
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.__SF_SIM__?.getCombatState?.()?.aiming === true,
    null, { timeout: 4000, polling: 20 });
  await page.waitForFunction(() => document.querySelector('[data-hud="san-francisco"]')
    ?.dataset?.contextMode === 'combat', null, { timeout: 4000, polling: 20 });
  const combatMeasurement = await measureVehicle(page, combatVehicle.id);
  evidence.scenarios.combatSide = { vehicle: combatVehicle, measurement: combatMeasurement };
  verifyVehicleContinuity('combat-side', combatMeasurement);
  await capture(page, 'combatSide');
  await page.mouse.up({ button: 'right' });

  const productionTarget = combatVehicle;
  const productionPair = await measureLodPair(page, productionTarget, [24, 28]);
  const productionTransition = verifyLodPair('26m production', productionPair);
  const distancePair = await measureLodPair(page, productionTarget, [70, 74]);
  const distanceTransition = verifyLodPair('72m distance', distancePair);
  evidence.lod = {
    production: { samples: productionPair, transition: productionTransition },
    distance: { samples: distancePair, transition: distanceTransition },
  };

  const responder = await stagePursuitResponder(page);
  assert(Number.isInteger(responder?.id), 'could not recruit a pursuit responder', responder);
  if (!responder?.position) throw new Error('pursuit responder staging failed');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(80);
  const frozenResponder = await page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const root = sim.traffic.group.children[id];
    return root ? { id, position: { x: root.position.x, y: root.position.y, z: root.position.z } } : null;
  }, responder.id);
  await page.evaluate((point) => window.__SF_SIM__.setRoamPose({ x: point.x - 5, z: point.z }),
    frozenResponder.position);
  await setFixedCamera(page, frozenResponder.position, { roadAxis: true, distance: 11 });
  await page.waitForTimeout(80);
  const responderMeasurement = await measureVehicle(page, responder.id);
  const pursuitComposition = await measureForegroundOcclusion(page, responder.id);
  const pursuitState = await page.evaluate((id) => {
    const sim = window.__SF_SIM__;
    const root = sim.traffic.group.children[id];
    let presentationMeshes = 0;
    root?.traverse?.((object) => {
      if (object.visible !== false && (object.userData?.pursuitResponder === true
        || /pursuit|police|lightbar|siren/i.test(object.name || ''))) presentationMeshes += 1;
    });
    return {
      responder: sim.traffic.getPursuitResponders?.()?.find((entry) => (
        (entry.index ?? entry.id) === id
      )) ?? null,
      rootPursuit: root?.userData?.pursuitResponder === true,
      presentationMeshes,
    };
  }, responder.id);
  evidence.scenarios.pursuitResponder = {
    stage: responder,
    state: pursuitState,
    measurement: responderMeasurement,
    composition: pursuitComposition,
  };
  assert(pursuitState.rootPursuit && pursuitState.responder,
    'pursuit capture did not contain a live responder', pursuitState);
  assert(pursuitState.presentationMeshes >= 1,
    'pursuit responder had no visible pursuit presentation kit', pursuitState);
  verifyVehicleContinuity('pursuit responder', responderMeasurement);
  const responderRect = responderMeasurement?.rect;
  const responderMargin = responderRect ? Math.min(
    responderRect.left,
    viewport.width - responderRect.right,
    responderRect.top,
    viewport.height - responderRect.bottom,
  ) : -Infinity;
  assert(responderRect
    && responderMargin >= 80
    && Math.abs(responderRect.centerX - viewport.width * 0.5) <= viewport.width * 0.1
    && Math.abs(responderRect.centerY - viewport.height * 0.5) <= viewport.height * 0.15
    && responderRect.width >= 120 && responderRect.width <= 900
    && responderRect.height >= 60 && responderRect.height <= 620,
  'pursuit responder was not centered with an 80px shell-safe margin', {
    responderRect,
    responderMargin,
  });
  assert(pursuitComposition
    && pursuitComposition.lineOfSightBlocker === null
    && pursuitComposition.foregroundOcclusionRatio <= 0.25,
  'pursuit camera was blocked by foreground facade/column geometry', pursuitComposition);
  await capture(page, 'pursuitResponder');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await waitForWorldSettled(page);
  evidence.resources.before = await readResources(page);
  await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    sim.setCameraPose(null, null);
    sim.resetPerformanceTelemetry?.();
  });
  await page.waitForFunction(() => (
    (window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0) >= 180
  ), null, { timeout: 15000, polling: 50 });
  evidence.performance = await page.evaluate(() => window.__SF_SIM__.getPerformanceSnapshot());
  assert(Number.isFinite(evidence.performance?.applicationP99FrameMs)
    && evidence.performance.applicationP99FrameMs <= 16.67
    && evidence.performance.applicationHardBudgetMet === true,
  'traffic presentation application p99 exceeded the 16.67ms hard budget', evidence.performance);

  await waitForWorldSettled(page);
  evidence.resources.after = await readResources(page);
  const geometryDelta = evidence.resources.after.geometries - evidence.resources.before.geometries;
  const textureDelta = evidence.resources.after.textures - evidence.resources.before.textures;
  assert(geometryDelta <= 2 && textureDelta <= 2,
    'traffic presentation scenarios leaked renderer resources', { geometryDelta, textureDelta });
  assert(evidence.resources.after.streaming?.populationPending === 0
    && evidence.resources.after.streaming?.handoffPending === 0,
  'streaming/resource work remained pending after traffic presentation QA', evidence.resources.after);
} catch (error) {
  failures.push({ message: error?.message || String(error), stack: error?.stack || null });
} finally {
  if (browser) await browser.close().catch(() => {});
}

assert(consoleErrors.length === 0, 'browser console/page errors occurred', consoleErrors);
assert(httpErrors.length === 0, 'HTTP resource errors occurred', httpErrors);
assert(requestErrors.length === 0, 'resource requests failed', requestErrors);

const result = {
  ok: failures.length === 0,
  gate: 'traffic-presentation',
  requirements: {
    platform: 'darwin',
    renderer: 'Apple Metal hardware',
    viewport,
    applicationP99FrameMs: 16.67,
    bodyWheelWorldGapM: 0.12,
    bodyWheelScreenGapPx: 2,
    wheelSurfaceContactEnvelopeM: 0.2,
    classProfileDistance: 0.055,
    lodSilhouetteIou: 0.86,
    lodCenterShiftPx: 3,
    lodAreaDelta: 0.12,
    pursuitResponderMarginPx: 80,
    pursuitCenterTolerance: { x: 0.1, y: 0.15 },
    pursuitForegroundOcclusionRatio: 0.25,
  },
  evidence,
  diagnostics: { consoleErrors, httpErrors, requestErrors },
  failures,
};

await writeFile(resultsPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
