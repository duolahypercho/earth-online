import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const chrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(chrome).then(() => chrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const captureDir = process.env.SF_QA_CAPTURE_DIR || '.qa-player-vehicle-embodiment';
const captures = Object.fromEntries([
  ['approach', '00-approach.png'],
  ['ingress100', '01-ingress-100ms.png'],
  ['ingressMid', '02-ingress-mid.png'],
  ['seated', '03-seated-idle.png'],
  ['seatedMoving', '04-seated-moving.png'],
  ['driveBy', '05-drive-by-rmb.png'],
  ['driveByRelease', '06-drive-by-release.png'],
  ['egressMid', '07-egress-mid.png'],
  ['exit', '08-grounded.png'],
].map(([key, name]) => [key, join(captureDir, name)]));

if (process.platform !== 'darwin' || angle !== 'metal' || !executablePath) {
  throw new Error('verify-player-vehicle-embodiment requires macOS System Chrome and SF_QA_ANGLE=metal.');
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

async function launch({ clearStorage = false } = {}) {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  if (clearStorage) await page.evaluate(() => window.localStorage.clear());
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  if (!await page.locator('#boot-overlay').evaluate((element) => element.classList.contains('is-dismissed'))) {
    await page.locator('#launch-button').click();
    await page.waitForFunction(() => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
      null, { timeout: 15000 });
  }
  await page.locator('canvas').focus();
  await page.waitForTimeout(150);
}

async function stage() {
  const result = await page.evaluate(async () => {
    const sim = window.__SF_SIM__;
    const qa = sim?.getVehicleEmbodimentQa?.();
    if (!qa || typeof qa.stage !== 'function' || typeof sim?.getPlayerVehicleEmbodimentState !== 'function') {
      return { contractError: 'getVehicleEmbodimentQa().stage() and getPlayerVehicleEmbodimentState() are required' };
    }
    return qa.stage({ kind: 'core-private' });
  });
  if (result?.contractError) throw new Error(result.contractError);
  assert(result?.ready === true && result?.syntheticEvents === 0,
    'core-road private-car staging was unavailable or mutated measured behavior', result);
  return result;
}

async function snapshot() {
  return page.evaluate(() => {
    const state = window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.();
    return state ?? { contractError: 'getPlayerVehicleEmbodimentState() is required' };
  });
}

const avatarId = (state) => state?.avatar?.uuid ?? state?.avatar?.id ?? null;
const vehicleId = (state) => state?.vehicle?.id ?? state?.vehicle?.vehicleId ?? null;
const phase = (state) => state?.transition?.phase ?? state?.phase ?? null;
const hip = (state) => state?.avatar?.hip ?? state?.avatar?.body?.hip ?? null;
const finitePoint = (point) => Number.isFinite(point?.x)
  && Number.isFinite(point?.y) && Number.isFinite(point?.z);
const distance = (left, right) => finitePoint(left) && finitePoint(right)
  ? Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) : Infinity;

async function waitForPhase(expected, message, timeout = 1800) {
  try {
    await page.waitForFunction((wanted) => {
      const state = window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.();
      return (state?.transition?.phase ?? state?.phase) === wanted;
    }, expected, { timeout, polling: 25 });
    return await snapshot();
  } catch {
    const state = await snapshot();
    assert(false, message, state);
    return state;
  }
}

async function sampleUntilPhaseEnds(expected, initial, timeout = 1300) {
  const samples = [initial];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(55);
    const state = await snapshot();
    samples.push(state);
    if (phase(state) !== expected) break;
  }
  return samples;
}

async function beginFrameSampling(expected) {
  const key = `__sfVehicleEmbodimentFrames${Math.random().toString(36).slice(2)}`;
  await page.evaluate(({ sampleKey, expectedPhase }) => {
    const read = () => {
      const state = window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.();
      return {
        phase: state?.transition?.phase ?? state?.phase ?? null,
        transition: { progress: state?.transition?.progress },
        avatar: { hip: state?.avatar?.hip ?? state?.avatar?.body?.hip ?? null },
      };
    };
    const samples = [];
    const tick = () => {
      const sample = read();
      samples.push(sample);
      if (sample.phase !== expectedPhase && samples.length > 1) {
        window[sampleKey] = { done: true, samples };
        return;
      }
      requestAnimationFrame(tick);
    };
    window[sampleKey] = { done: false, samples };
    requestAnimationFrame(tick);
  }, { sampleKey: key, expectedPhase: expected });
  return key;
}

async function finishFrameSampling(key, timeout = 1500) {
  await page.waitForFunction((sampleKey) => window[sampleKey]?.done === true, key, { timeout, polling: 20 });
  return page.evaluate((sampleKey) => {
    const result = window[sampleKey] || { samples: [] };
    delete window[sampleKey];
    return result.samples;
  }, key);
}

async function capture(path) {
  await page.waitForTimeout(80);
  await page.screenshot({ path });
}

// This probe deliberately avoids the product's reported clearance values. It
// samples the animated SkinnedMesh after skinning, then compares those posed
// vertices against the real target vehicle root's opaque shell meshes. Cabin
// glazing and explicitly marked cabin furniture are not exterior shell: a
// seated player is expected to occupy that volume, but never an opaque shell.
async function renderedEmbodimentGeometry() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getPlayerVehicleEmbodimentState?.();
    const avatar = sim?.playerAvatar;
    const id = state?.vehicle?.id ?? state?.vehicle?.vehicleId;
    const vehicle = Number.isInteger(id) ? sim?.traffic?.group?.children?.[id] : null;
    if (!state || !avatar || !vehicle) return null;

    const transform = (point, elements) => ({
      x: elements[0] * point.x + elements[4] * point.y + elements[8] * point.z + elements[12],
      y: elements[1] * point.x + elements[5] * point.y + elements[9] * point.z + elements[13],
      z: elements[2] * point.x + elements[6] * point.y + elements[10] * point.z + elements[14],
    });
    const boundsFor = (points) => points.reduce((bounds, point) => ({
      min: {
        x: Math.min(bounds.min.x, point.x), y: Math.min(bounds.min.y, point.y), z: Math.min(bounds.min.z, point.z),
      },
      max: {
        x: Math.max(bounds.max.x, point.x), y: Math.max(bounds.max.y, point.y), z: Math.max(bounds.max.z, point.z),
      },
    }), {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    });
    const verticesFor = (node) => {
      const position = node.geometry?.attributes?.position;
      if (!position) return [];
      const vertex = node.position.clone();
      const matrix = node.matrixWorld.elements;
      const points = [];
      for (let index = 0; index < position.count; index += 1) {
        // BufferGeometry positions on a SkinnedMesh remain bind-pose values.
        // getVertexPosition applies the active skeleton before matrixWorld.
        if (node.isSkinnedMesh && typeof node.getVertexPosition === 'function') {
          node.getVertexPosition(index, vertex);
        } else {
          vertex.set(position.getX(index), position.getY(index), position.getZ(index));
        }
        points.push(transform(vertex, matrix));
      }
      return points;
    };
    const trianglesFor = (node) => {
      const position = node.geometry?.attributes?.position;
      if (!position) return [];
      const matrix = node.matrixWorld.elements;
      const vertexAt = (index) => {
        const vertex = node.position.clone();
        if (node.isSkinnedMesh && typeof node.getVertexPosition === 'function') {
          node.getVertexPosition(index, vertex);
        } else {
          vertex.set(position.getX(index), position.getY(index), position.getZ(index));
        }
        return transform(vertex, matrix);
      };
      const index = node.geometry.index;
      const triangles = [];
      const count = index ? index.count : position.count;
      for (let offset = 0; offset + 2 < count; offset += 3) {
        const a = index ? index.getX(offset) : offset;
        const b = index ? index.getX(offset + 1) : offset + 1;
        const c = index ? index.getX(offset + 2) : offset + 2;
        triangles.push([vertexAt(a), vertexAt(b), vertexAt(c)]);
      }
      return triangles;
    };
    avatar.updateMatrixWorld(true);
    vehicle.updateMatrixWorld(true);
    const avatarVertices = [];
    let skinnedMeshCount = 0;
    avatar.traverse((node) => {
      if (!node.visible || !node.isMesh || !node.isSkinnedMesh) return;
      skinnedMeshCount += 1;
      avatarVertices.push(...verticesFor(node));
    });

    const project = (point) => {
      const view = transform(point, sim.camera.matrixWorldInverse.elements);
      const projection = sim.camera.projectionMatrix.elements;
      const x = projection[0] * view.x + projection[4] * view.y + projection[8] * view.z + projection[12];
      const y = projection[1] * view.x + projection[5] * view.y + projection[9] * view.z + projection[13];
      const w = projection[3] * view.x + projection[7] * view.y + projection[11] * view.z + projection[15];
      return w > 0 ? { x: x / w, y: y / w } : null;
    };
    const projectedBounds = (points) => {
      const projected = points.map(project).filter(Boolean);
      if (!projected.length) return null;
      const minX = Math.min(...projected.map((point) => point.x));
      const maxX = Math.max(...projected.map((point) => point.x));
      const minY = Math.min(...projected.map((point) => point.y));
      const maxY = Math.max(...projected.map((point) => point.y));
      return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
    };

    const transparentMaterial = (material) => Boolean(material?.transparent)
      || Number(material?.opacity) < 0.98;
    const excludedCabinNode = (node) => Boolean(
      node.userData?.embodimentCabin === true
      || node.userData?.embodimentSeat === true
      || /(?:seat|cabin furniture|interior|contact shadow)/i.test(node.name || '')
    );
    const shellNodes = [];
    const cabinGlassNodes = [];
    const doorNodes = [];
    const authoredDoors = vehicle.userData?.vehicleEmbodiment?.doors || {};
    for (const [side, door] of Object.entries(authoredDoors)) {
      const pivot = door?.pivot;
      if (!pivot?.getWorldPosition) continue;
      const world = pivot.getWorldPosition(sim.camera.position.clone());
      doorNodes.push({
        name: pivot.name || `Traveler ${side} driver door pivot`,
        side,
        apertureAngle: Number(door.angle),
        apertureVisible: door.aperture?.visible === true,
        pivot: { x: world.x, y: world.y, z: world.z },
      });
    }
    const effectivelyVisible = (node) => {
      for (let current = node; current; current = current.parent) {
        if (current.visible === false) return false;
        if (current === vehicle) break;
      }
      return true;
    };
    vehicle.traverse((node) => {
      if (!effectivelyVisible(node)) return;
      if (node.userData?.embodimentDoor === true && !doorNodes.some((door) => door.name === node.name)) {
        doorNodes.push({
          name: node.name || '(unnamed driver door)',
          apertureAngle: Number(node.userData?.apertureAngle),
          apertureVisible: node.userData?.apertureVisible === true,
          pivot: node.userData?.pivotWorld ? {
            x: node.userData.pivotWorld.x, y: node.userData.pivotWorld.y, z: node.userData.pivotWorld.z,
          } : null,
        });
      }
      if (!node.isMesh || excludedCabinNode(node)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const opaque = materials.length > 0 && materials.every((material) => !transparentMaterial(material));
      const markedShell = node.userData?.embodimentShell === true;
      if (markedShell || opaque) {
        const vertices = verticesFor(node);
        if (vertices.length) shellNodes.push({
          name: node.name || '(unnamed shell mesh)',
          parentName: node.parent?.name || '(unnamed parent)',
          markedShell,
          material: materials.map((material) => ({
            name: material?.name || null,
            color: material?.color?.getHexString?.() ?? null,
            transparent: Boolean(material?.transparent),
            opacity: Number.isFinite(material?.opacity) ? material.opacity : null,
          })),
          geometryType: node.geometry?.type || null,
          localPosition: { x: node.position.x, y: node.position.y, z: node.position.z },
          localScale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
          vertices,
          triangles: trianglesFor(node),
          bounds: boundsFor(vertices),
        });
      }
      if (materials.some(transparentMaterial)) {
        const vertices = verticesFor(node);
        if (vertices.length) cabinGlassNodes.push({ name: node.name || '(unnamed glass mesh)', vertices });
      }
    });
    const contains = (bounds, point, margin = 0.004) => (
      point.x > bounds.min.x + margin && point.x < bounds.max.x - margin
      && point.y > bounds.min.y + margin && point.y < bounds.max.y - margin
      && point.z > bounds.min.z + margin && point.z < bounds.max.z - margin
    );
    const rayIntersectsTriangle = (origin, triangle) => {
      const [a, b, c] = triangle;
      const edge1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const edge2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      // Möller–Trumbore with a fixed +X ray. This is only evaluated after a
      // vertex is inside the individual opaque mesh AABB.
      const p = { x: 0, y: -edge2.z, z: edge2.y };
      const determinant = edge1.y * p.y + edge1.z * p.z;
      if (Math.abs(determinant) < 1e-8) return false;
      const inverse = 1 / determinant;
      const t = { x: origin.x - a.x, y: origin.y - a.y, z: origin.z - a.z };
      const u = (t.y * p.y + t.z * p.z) * inverse;
      if (u < 0 || u > 1) return false;
      const q = {
        x: t.y * edge1.z - t.z * edge1.y,
        y: t.z * edge1.x - t.x * edge1.z,
        z: t.x * edge1.y - t.y * edge1.x,
      };
      const v = q.x * inverse;
      if (v < 0 || u + v > 1) return false;
      const rayDistance = edge2.x * q.x * inverse;
      return rayDistance > 0.0005;
    };
    const insideOpaqueMesh = (point, triangles) => {
      let hits = 0;
      for (const triangle of triangles) if (rayIntersectsTriangle(point, triangle)) hits += 1;
      return hits % 2 === 1;
    };
    const penetrating = [];
    for (const shell of shellNodes) {
      let count = 0;
      for (const point of avatarVertices) {
        if (contains(shell.bounds, point) && insideOpaqueMesh(point, shell.triangles)) count += 1;
      }
      if (count) penetrating.push({
        name: shell.name,
        parentName: shell.parentName,
        markedShell: shell.markedShell,
        material: shell.material,
        geometryType: shell.geometryType,
        localPosition: shell.localPosition,
        localScale: shell.localScale,
        worldBounds: shell.bounds,
        vertices: count,
      });
    }
    const legacyRigs = [];
    sim?.scene?.traverse?.((node) => {
      if (node.visible && (node.userData?.legacyDriveByRig === true
        || /(?:vehicle-window )?drive-by rig/i.test(node.name || ''))) {
        legacyRigs.push(node.name || '(unnamed legacy drive-by rig)');
      }
    });
    const isFinitePoint = (point) => Number.isFinite(point?.x)
      && Number.isFinite(point?.y) && Number.isFinite(point?.z);
    const hip = state?.avatar?.hip ?? state?.avatar?.body?.hip ?? null;
    const worldToVehicle = (point) => {
      if (!isFinitePoint(point)) return null;
      const e = vehicle.matrixWorld.elements;
      const dx = point.x - e[12];
      const dy = point.y - e[13];
      const dz = point.z - e[14];
      // Vehicle roots are unscaled rigid transforms. Dot the offset with
      // their world axes instead of asking the product for a local seat pose.
      return {
        x: e[0] * dx + e[1] * dy + e[2] * dz,
        y: e[4] * dx + e[5] * dy + e[6] * dz,
        z: e[8] * dx + e[9] * dy + e[10] * dz,
      };
    };
    return {
      avatarVertices: avatarVertices.length,
      skinnedMeshCount,
      avatarBounds: avatarVertices.length ? boundsFor(avatarVertices) : null,
      avatarScreen: projectedBounds(avatarVertices),
      vehicleRootVisible: vehicle.visible === true,
      opaqueShellMeshes: shellNodes.length,
      markedShellMeshes: shellNodes.filter((shell) => shell.markedShell).length,
      cabinGlassMeshes: cabinGlassNodes.length,
      cabinGlassScreen: projectedBounds(cabinGlassNodes.flatMap((node) => node.vertices)),
      doors: doorNodes,
      penetratingShellMeshes: penetrating,
      intersectingVertices: penetrating.reduce((total, shell) => total + shell.vertices, 0),
      legacyVisibleRigs: legacyRigs,
      actualSeatLocalHip: worldToVehicle(hip),
      actualSeatLocalYaw: (() => {
        const yawFor = (object) => {
          if (!object?.getWorldQuaternion) return null;
          const q = object.getWorldQuaternion(sim.camera.quaternion.clone());
          return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
        };
        const avatarYaw = yawFor(avatar.userData?.rig || avatar);
        const vehicleYaw = yawFor(vehicle);
        return Number.isFinite(avatarYaw) && Number.isFinite(vehicleYaw) ? avatarYaw - vehicleYaw : null;
      })(),
    };
  });
}

// Keep the high-frequency drift sample light. The independent mesh audit runs
// at the still captures; this reads only the actual live root transform and
// avatar hip, never the product's reported local-seat residual.
async function actualSeatPose() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getPlayerVehicleEmbodimentState?.();
    const avatar = sim?.playerAvatar;
    const id = state?.vehicle?.id ?? state?.vehicle?.vehicleId;
    const vehicle = Number.isInteger(id) ? sim?.traffic?.group?.children?.[id] : null;
    const hip = state?.avatar?.hip ?? state?.avatar?.body?.hip;
    if (!avatar || !vehicle || !Number.isFinite(hip?.x) || !Number.isFinite(hip?.y) || !Number.isFinite(hip?.z)) {
      return null;
    }
    vehicle.updateMatrixWorld(true);
    const e = vehicle.matrixWorld.elements;
    const dx = hip.x - e[12];
    const dy = hip.y - e[13];
    const dz = hip.z - e[14];
    return {
      actualSeatLocalHip: {
        x: e[0] * dx + e[1] * dy + e[2] * dz,
        y: e[4] * dx + e[5] * dy + e[6] * dz,
        z: e[8] * dx + e[9] * dy + e[10] * dz,
      },
      actualSeatLocalYaw: (() => {
        const yawFor = (object) => {
          if (!object?.getWorldQuaternion) return null;
          const q = object.getWorldQuaternion(sim.camera.quaternion.clone());
          return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
        };
        const avatarYaw = yawFor(avatar.userData?.rig || avatar);
        const vehicleYaw = yawFor(vehicle);
        return Number.isFinite(avatarYaw) && Number.isFinite(vehicleYaw) ? avatarYaw - vehicleYaw : null;
      })(),
    };
  });
}

function assertIdentity(state, expectedAvatarId, expectedVehicleId, label) {
  assert(typeof avatarId(state) === 'string' && avatarId(state) === expectedAvatarId
    && Number.isInteger(vehicleId(state)) && vehicleId(state) === expectedVehicleId
    && state.vehicle?.occupantAvatarId === expectedAvatarId,
  `${label} broke avatar or vehicle identity continuity`, state);
}

function assertTransition(label, samples, terminal) {
  const transition = terminal?.transition;
  const durationMs = Number(transition?.durationMs);
  assert(Number.isFinite(durationMs) && durationMs >= 450 && durationMs <= 1000
    && transition?.startedAt != null && transition?.completedAt != null,
  `${label} was not a bounded 0.45–1.0s transition`, terminal);
  assert(samples.length >= 4
    && samples.every((state) => finitePoint(hip(state)))
    && samples.slice(1).every((state, index) => distance(hip(state), hip(samples[index])) < 0.45),
  `${label} lacked bounded per-frame hip continuity`, samples);
  const progress = samples.map((state) => Number(state?.transition?.progress));
  assert(progress.every(Number.isFinite)
    && progress.slice(1).every((value, index) => value >= progress[index] - 0.001),
  `${label} transition progress was not monotonic`, { samples, progress });
}

function assertPosedBody(state, label) {
  const body = state?.avatar?.renderedBody;
  const sampled = state?.avatar?.skinnedMeshSample;
  const clearance = state?.clearance;
  assert(body?.source === 'player-avatar' && body?.visible === true
    && finitePoint(body?.hip) && Number.isFinite(body?.screen?.width)
    && Number.isFinite(body?.screen?.height)
    && sampled?.skinnedVertexCount > 0 && sampled?.bounds?.min && sampled?.bounds?.max,
  `${label} did not expose a readable posed same-avatar body with SkinnedMesh sampling`, state);
  assert(clearance?.bodyShellPenetration <= 0.02
    && clearance?.seatResidual <= 0.03,
  `${label} exceeded body-shell/seat penetration bounds`, state);
}

function assertCamera(state, label) {
  const camera = state?.camera;
  assert(camera?.safe === true && camera?.insideVehicle === false
    && camera?.belowSurface === false && Number.isFinite(camera?.surfaceClearance)
    && camera.surfaceClearance >= 0.4 && Number(camera?.maxStep) <= 3.25,
  `${label} camera was unsafe, underground, or stepped too far`, state);
}

function assertIndependentGeometry(geometry, label) {
  assert(geometry?.vehicleRootVisible === true && geometry?.skinnedMeshCount > 0
    && geometry?.avatarVertices > 0 && geometry?.opaqueShellMeshes > 0,
  `${label} did not expose a rendered SkinnedMesh avatar and real opaque vehicle shell`, geometry);
  assert(geometry?.intersectingVertices === 0,
    `${label} placed posed avatar vertices inside the actual opaque vehicle shell`, geometry);
  assert(Array.isArray(geometry?.legacyVisibleRigs) && geometry.legacyVisibleRigs.length === 0,
    `${label} left a visible legacy drive-by rig in the scene`, geometry);
}

function assertProjectedOccupant(geometry, label) {
  const body = geometry?.avatarScreen;
  const glass = geometry?.cabinGlassScreen;
  const overlaps = body && glass && body.maxX > glass.minX && body.minX < glass.maxX
    && body.maxY > glass.minY && body.minY < glass.maxY;
  assert(geometry?.cabinGlassMeshes > 0 && body?.width >= 0.035 && body?.height >= 0.07
    && overlaps,
  `${label} did not put a readable posed occupant through the actual cabin glazing in image space`, geometry);
}

function assertDoor(state, geometry, label, { requireOpen = false } = {}) {
  const door = state?.vehicle?.door ?? state?.door;
  const aperture = Number(door?.apertureAngle ?? door?.angle);
  const sceneDoor = geometry?.doors?.find((candidate) => candidate?.side === door?.side)
    ?? geometry?.doors?.[0];
  assert(typeof door?.pivotUuid === 'string' && typeof door?.apertureUuid === 'string'
    && Number.isFinite(aperture) && Number.isFinite(Number(door?.maxTransitionAngle))
    && sceneDoor && finitePoint(sceneDoor.pivot)
    && Number.isFinite(sceneDoor.apertureAngle),
  `${label} did not expose matching real scene/root door pivot/aperture/traversal`, { state, geometry });
  if (requireOpen) {
    assert(Math.abs(aperture) >= 0.18 && Number(door?.maxTransitionAngle) >= 0.75
      && Math.abs(sceneDoor.apertureAngle) >= 0.18
      && sceneDoor.apertureVisible === true,
    `${label} did not show an actually opened traversing door`, { state, geometry });
  }
}

function angularDistance(left, right) {
  return Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
}

function percentile(values, ratio) {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function assertSeatDrift(samples) {
  const baseline = samples[0];
  const positions = samples.map((sample) => sample?.actualSeatLocalHip);
  const yaws = samples.map((sample) => sample?.actualSeatLocalYaw);
  const valid = positions.length >= 8 && positions.every(finitePoint) && yaws.every(Number.isFinite);
  const drift = valid ? positions.map((point) => distance(point, baseline.actualSeatLocalHip)) : [];
  const yawDrift = valid ? yaws.map((yaw) => angularDistance(yaw, baseline.actualSeatLocalYaw)) : [];
  assert(valid && percentile(drift, 0.99) <= 0.035 && Math.max(...drift) <= 0.06
    && Math.max(...yawDrift) <= 0.035,
  'post-traffic seated avatar drift exceeded p99/max local seat or yaw bounds', {
    samples, drift, yawDrift, p99: percentile(drift, 0.99), max: Math.max(...drift), maxYaw: Math.max(...yawDrift),
  });
}

function resources(state) {
  return state?.resources || {};
}

try {
  await launch({ clearStorage: true });
  const renderer = await page.evaluate(() => {
    const gl = window.__SF_SIM__?.renderer?.getContext?.();
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  });
  assert(typeof renderer === 'string' && /metal/i.test(renderer)
    && !/(swiftshader|software|llvmpipe)/i.test(renderer),
  'Apple Metal hardware rendering is required', { renderer, angle });

  const staged = await stage();
  const approach = await snapshot();
  const rawOccupancyApi = await page.evaluate(() => ({
    enter: typeof window.__SF_SIM__?.traffic?.enterPlayerVehicle,
    exit: typeof window.__SF_SIM__?.traffic?.exitPlayerVehicle,
    driving: window.__SF_SIM__?.isDriving?.() === true,
  }));
  assert(rawOccupancyApi.enter === 'undefined' && rawOccupancyApi.exit === 'undefined'
    && rawOccupancyApi.driving === false,
  'raw traffic occupancy methods remained publicly callable outside the embodiment authority',
  rawOccupancyApi);
  const stableAvatarId = avatarId(approach);
  const stableVehicleId = vehicleId(approach);
  assert(typeof stableAvatarId === 'string' && Number.isInteger(stableVehicleId)
    && phase(approach) === 'approach' && approach?.avatar?.visible === true
    && approach?.vehicle?.private === true && approach?.vehicle?.coreRoad === true
    && approach?.vehicle?.distanceToAvatar <= 3.8,
  'staging did not place the real avatar beside a core-road private vehicle', approach);
  await capture(captures.approach);

  await page.keyboard.press('e');
  const ingressStart = await waitForPhase('ingress', 'real E did not begin vehicle ingress');
  assertIdentity(ingressStart, stableAvatarId, stableVehicleId, 'ingress start');
  const ingressFrameKey = await beginFrameSampling('ingress');
  await page.keyboard.press('e');
  await page.waitForTimeout(100);
  const ingress100 = await snapshot();
  assert(phase(ingress100) === 'ingress' && ingress100?.transition?.duplicateEIgnored === true
    && ingress100?.events?.theftIngressCount === (approach?.events?.theftIngressCount || 0) + 1,
  'duplicate E was not input-locked to exactly one theft ingress', ingress100);
  await capture(captures.ingress100);
  await page.waitForTimeout(180);
  const ingressMid = await snapshot();
  assert(phase(ingressMid) === 'ingress', 'ingress ended before its required mid-transition capture', ingressMid);
  const ingressMidGeometry = await renderedEmbodimentGeometry();
  assertDoor(ingressMid, ingressMidGeometry, 'ingress mid-transition', { requireOpen: true });
  await capture(captures.ingressMid);
  const ingressSamples = await sampleUntilPhaseEnds('ingress', ingressStart);
  const seated = await waitForPhase('seated', 'ingress did not complete into a seated driver');
  const ingressFrameSamples = await finishFrameSampling(ingressFrameKey);
  assertTransition('ingress', ingressFrameSamples, seated);
  assertIdentity(seated, stableAvatarId, stableVehicleId, 'seated idle');
  assertPosedBody(seated, 'seated idle');
  assertCamera(seated, 'seated idle');
  assert(seated?.legacyDriveByRigVisible === false && seated?.avatar?.seat?.vehicleId === stableVehicleId,
    'seated idle used legacy drive-by rig or lost the seat binding', seated);
  const seatedGeometry = await renderedEmbodimentGeometry();
  assertIndependentGeometry(seatedGeometry, 'seated idle');
  assertProjectedOccupant(seatedGeometry, 'seated idle');
  await capture(captures.seated);

  const movingStart = await snapshot();
  const movingStartPosition = movingStart?.vehicle?.position;
  const movingStartHeading = Number(movingStart?.vehicle?.heading);
  const seatSamples = [await actualSeatPose()];
  await page.keyboard.down('w');
  await page.keyboard.down('d');
  const trafficDeadline = Date.now() + 15000;
  let seatedMoving = movingStart;
  while (Date.now() < trafficDeadline) {
    await page.waitForTimeout(60);
    seatedMoving = await snapshot();
    seatSamples.push(await actualSeatPose());
    const travel = distance(seatedMoving?.vehicle?.position, movingStartPosition);
    const turn = angularDistance(Number(seatedMoving?.vehicle?.heading), movingStartHeading);
    if (travel >= 8 && turn >= 0.18) break;
  }
  await page.keyboard.up('w');
  await page.keyboard.up('d');
  const trafficTravel = distance(seatedMoving?.vehicle?.position, movingStartPosition);
  const trafficHeadingChange = angularDistance(Number(seatedMoving?.vehicle?.heading), movingStartHeading);
  assert(trafficTravel >= 8 && trafficHeadingChange >= 0.18,
    'real W driving did not cover >=8m with a >=.18rad heading change', {
      start: movingStart, end: seatedMoving, trafficTravel, trafficHeadingChange,
    });
  assertIdentity(seatedMoving, stableAvatarId, stableVehicleId, 'seated moving');
  const movingGeometry = await renderedEmbodimentGeometry();
  assertIndependentGeometry(movingGeometry, 'seated moving');
  assertProjectedOccupant(movingGeometry, 'seated moving');
  assertSeatDrift(seatSamples);
  await capture(captures.seatedMoving);

  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#launch-button')
    && !document.querySelector('#launch-button').disabled, null, { timeout: 60000 });
  if (!await page.locator('#boot-overlay').evaluate((element) => element.classList.contains('is-dismissed'))) {
    await page.locator('#launch-button').click();
    await page.waitForFunction(() => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
      null, { timeout: 15000 });
  }
  await page.locator('canvas').focus();
  const restored = await waitForPhase('seated', 'reload while driving did not restore direct seated state', 5000);
  assertIdentity(restored, stableAvatarId, stableVehicleId, 'reload seated state');
  assert(restored?.transition?.replayed === false && restored?.transition?.phase === 'seated',
    'reload replayed ingress instead of restoring direct seated state', restored);
  await page.waitForTimeout(2200);

  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  // Sweep toward the authored driver door so the image-space gate proves the
  // same shoulder/forearm/hand chain through that window, not across the roof.
  await page.mouse.move(440, 360, { steps: 8 });
  const driveBy = await page.waitForFunction(() => {
    const state = window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.();
    return state?.driveBy?.active === true;
  }, null, { timeout: 1500, polling: 25 }).then(snapshot).catch(async () => {
    const state = await snapshot();
    assert(false, 'real RMB did not activate drive-by embodiment', state);
    return state;
  });
  assertIdentity(driveBy, stableAvatarId, stableVehicleId, 'drive-by');
  assert(driveBy?.driveBy?.avatarId === stableAvatarId
    && driveBy?.driveBy?.bodySource === 'player-avatar'
    && driveBy?.driveBy?.bodyVisible === true
    && driveBy?.driveBy?.weapon?.parent === 'right-hand'
    && Number(driveBy?.driveBy?.weapon?.gripDistance) <= 0.08
    && driveBy?.legacyDriveByRigVisible === false,
  'RMB drive-by did not use the same seated avatar body/right hand', driveBy);
  assertPosedBody(driveBy, 'drive-by');
  assertCamera(driveBy, 'drive-by');
  const driveByGeometry = await renderedEmbodimentGeometry();
  assertIndependentGeometry(driveByGeometry, 'drive-by');
  assertProjectedOccupant(driveByGeometry, 'drive-by');
  await capture(captures.driveBy);
  await page.mouse.up({ button: 'right' });
  const releaseStartedAt = Date.now();
  const driveByReleased = await page.waitForFunction(() => {
    const state = window.__SF_SIM__?.getPlayerVehicleEmbodimentState?.();
    return state?.driveBy?.active === false ? state : null;
  }, null, { timeout: 350, polling: 20 }).then(snapshot).catch(async () => {
    const state = await snapshot();
    assert(false, 'RMB release did not recover seated embodiment within 350ms', state);
    return state;
  });
  assert(Date.now() - releaseStartedAt <= 350 && driveByReleased?.legacyDriveByRigVisible === false,
    'RMB release recovery exceeded 350ms or left the legacy rig visible', driveByReleased);
  const releaseGeometry = await renderedEmbodimentGeometry();
  assertIndependentGeometry(releaseGeometry, 'drive-by release');
  assertProjectedOccupant(releaseGeometry, 'drive-by release');
  await capture(captures.driveByRelease);

  await page.keyboard.press('e');
  const egressStart = await waitForPhase('egress', 'real E did not begin vehicle egress');
  assertIdentity(egressStart, stableAvatarId, stableVehicleId, 'egress start');
  const egressFrameKey = await beginFrameSampling('egress');
  await page.waitForTimeout(260);
  const egressMid = await snapshot();
  assert(phase(egressMid) === 'egress', 'egress ended before its required mid-transition capture', egressMid);
  const egressMidGeometry = await renderedEmbodimentGeometry();
  assertDoor(egressMid, egressMidGeometry, 'egress mid-transition', { requireOpen: true });
  await capture(captures.egressMid);
  const egressSamples = await sampleUntilPhaseEnds('egress', egressStart);
  const exited = await waitForPhase('grounded', 'egress did not complete into a grounded avatar');
  const egressFrameSamples = await finishFrameSampling(egressFrameKey);
  assertTransition('egress', egressFrameSamples, exited);
  assert(avatarId(exited) === stableAvatarId && vehicleId(exited) === stableVehicleId
    && exited?.avatar?.visible === true && Number(exited?.avatar?.feetSurfaceDelta) <= 0.03
    && exited?.vehicle?.occupantAvatarId == null,
  'egress did not restore the same grounded avatar beside the released vehicle', exited);
  assertCamera(exited, 'grounded exit');
  await capture(captures.exit);

  const resourceSamples = [approach, ingress100, ingressMid, seated, restored, driveBy, egressMid, exited]
    .map(resources);
  assert(resourceSamples.every((sample) => Object.keys(resourceSamples[0]).every((key) => (
    Number.isFinite(sample[key]) && sample[key] === resourceSamples[0][key]
  ))), 'vehicle embodiment scenarios grew resources', resourceSamples);

  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0
  ) >= 180, null, { timeout: 12000, polling: 50 });
  const performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  assert(performance?.applicationFrameCount >= 180
    && Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'player-vehicle embodiment exceeded the 16.67 ms application p99 budget', performance);
  assert(consoleErrors.length === 0 && httpErrors.length === 0 && requestFailures.length === 0,
    'runtime errors leaked during player-vehicle embodiment verification', {
      consoleErrors, httpErrors, requestFailures,
    });

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0
      && httpErrors.length === 0 && requestFailures.length === 0,
    renderer,
    staged,
    approach,
    ingress: { start: ingressStart, at100ms: ingress100, mid: ingressMid, midGeometry: ingressMidGeometry, samples: ingressSamples, frameSamples: ingressFrameSamples },
    seated,
    seatedGeometry,
    seatedMoving: { start: movingStart, end: seatedMoving, travel: trafficTravel, headingChange: trafficHeadingChange, seatSamples },
    restored,
    driveBy,
    driveByGeometry,
    driveByReleased,
    egress: { start: egressStart, mid: egressMid, midGeometry: egressMidGeometry, samples: egressSamples, frameSamples: egressFrameSamples, exited },
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
  console.error(JSON.stringify({ result: 'player vehicle embodiment verifier failed', error: error.message, failures }, null, 2));
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
