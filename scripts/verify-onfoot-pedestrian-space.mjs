import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const chrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(chrome).then(() => chrome).catch(() => null);
const angle = process.env.SF_QA_ANGLE || 'metal';
const captureDir = process.env.SF_QA_CAPTURE_DIR || '.qa-onfoot-pedestrian-space';
const captures = Object.fromEntries([
  ['contact', 'contact.png'],
  ['held', 'held.png'],
  ['rearm', 'rearm.png'],
  ['diagonal', 'diagonal.png'],
  ['empty', 'empty.png'],
  ['negative', 'negative.png'],
].map(([key, name]) => [key, join(captureDir, name)]));

if (process.platform !== 'darwin' || angle !== 'metal' || !executablePath) {
  throw new Error('verify-onfoot-pedestrian-space requires macOS System Chrome and SF_QA_ANGLE=metal.');
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
  await page.waitForTimeout(300);
}

async function snapshot() {
  return page.evaluate(() => {
    const qa = window.__SF_SIM__?.getOnFootPedestrianSpaceQa?.();
    return qa?.snapshot?.() ?? { contractError: 'getOnFootPedestrianSpaceQa().snapshot() is required' };
  });
}

async function stage(kind) {
  const result = await page.evaluate(async (requestedKind) => {
    const qa = window.__SF_SIM__?.getOnFootPedestrianSpaceQa?.();
    if (!qa || typeof qa.stage !== 'function' || typeof qa.snapshot !== 'function') {
      return { contractError: 'getOnFootPedestrianSpaceQa() must expose stage() and snapshot()' };
    }
    return qa.stage({ kind: requestedKind });
  }, kind);
  if (result?.contractError) throw new Error(result.contractError);
  assert(result?.ready === true && result?.syntheticEvents === 0,
    `${kind} staging was unavailable or mutated measured behavior`, result);
  return result;
}

const boundsCenter = (bounds) => ({
  x: (bounds.min.x + bounds.max.x) / 2,
  y: (bounds.min.y + bounds.max.y) / 2,
  z: (bounds.min.z + bounds.max.z) / 2,
});

function framingCandidates(geometry) {
  if (!geometry?.playerBounds || !geometry?.pedestrianBounds) return [];
  const player = boundsCenter(geometry.playerBounds);
  const pedestrian = boundsCenter(geometry.pedestrianBounds);
  const midpoint = {
    x: (player.x + pedestrian.x) / 2,
    y: (player.y + pedestrian.y) / 2,
    z: (player.z + pedestrian.z) / 2,
  };
  const length = Math.hypot(player.x - pedestrian.x, player.z - pedestrian.z) || 1;
  const forward = { x: (player.x - pedestrian.x) / length, z: (player.z - pedestrian.z) / length };
  const side = { x: -forward.z, z: forward.x };
  const distance = Math.max(7.5, length * 4.5);
  return [2.2, 3, 4.8].flatMap((elevation) => Array.from({ length: 16 }, (_, index) => {
    const angle = (index / 16) * Math.PI * 2;
    const forwardAmount = Math.cos(angle) * distance;
    const sideAmount = Math.sin(angle) * distance;
    return {
      position: {
        x: midpoint.x + forward.x * forwardAmount + side.x * sideAmount,
        y: midpoint.y + elevation,
        z: midpoint.z + forward.z * forwardAmount + side.z * sideAmount,
      },
      lookAt: { x: midpoint.x, y: midpoint.y + 0.1, z: midpoint.z },
      threeQuarter: Math.abs(Math.sin(angle * 2)),
      roadSide: midpoint.z - (midpoint.z + forward.z * forwardAmount + side.z * sideAmount) > 0,
      elevation,
    };
  }));
}

async function inspectEvidenceFrame(geometry) {
  return page.evaluate(async (bodyGeometry) => {
    const sim = window.__SF_SIM__;
    const camera = sim?.camera;
    const scene = sim?.scene;
    const state = sim?.getOnFootPedestrianSpaceQa?.()?.snapshot?.();
    const avatar = sim?.playerAvatar;
    const pedestrian = state?.pedestrian?.objectUuid
      ? scene?.getObjectByProperty?.('uuid', state.pedestrian.objectUuid)
      : null;
    if (!camera || !scene || !avatar || !pedestrian) return null;
    const threeUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /(?:^|\/)three(?:\.module)?\.js(?:\?|$)/.test(url));
    if (!threeUrl) return { contractError: 'Three.js module URL was unavailable for evidence raycasting' };
    const THREE = await import(threeUrl);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const isVisible = (node) => {
      for (let current = node; current; current = current.parent) {
        if (current.visible === false) return false;
      }
      return true;
    };
    const transform4 = (value, elements) => {
      const x = elements[0] * value.x + elements[4] * value.y + elements[8] * value.z + elements[12];
      const y = elements[1] * value.x + elements[5] * value.y + elements[9] * value.z + elements[13];
      const z = elements[2] * value.x + elements[6] * value.y + elements[10] * value.z + elements[14];
      const w = elements[3] * value.x + elements[7] * value.y + elements[11] * value.z + elements[15];
      return { x, y, z, w };
    };
    const projectPoint = (point) => {
      const view = transform4(point, camera.matrixWorldInverse.elements);
      const clip = transform4(view, camera.projectionMatrix.elements);
      return Math.abs(clip.w) < 1e-6 ? null : {
        x: clip.x / clip.w, y: clip.y / clip.w, z: clip.z / clip.w,
      };
    };
    const summarizeProjection = (points) => {
      const onScreen = points.filter((point) => (
        point.x >= -0.82 && point.x <= 0.82
        && point.y >= -0.82 && point.y <= 0.82
        && point.z >= -1 && point.z <= 1
      )).length;
      const screenBounds = points.length ? points.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x), maxX: Math.max(result.maxX, point.x),
        minY: Math.min(result.minY, point.y), maxY: Math.max(result.maxY, point.y),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }) : null;
      return {
        corners: points.length,
        onScreen,
        fraction: points.length ? onScreen / points.length : 0,
        screenBounds,
      };
    };
    const projectBounds = (bounds) => {
      const corners = [];
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            const point = projectPoint({ x, y, z });
            if (point) corners.push(point);
          }
        }
      }
      return summarizeProjection(corners);
    };
    const playerProjection = projectBounds(bodyGeometry.playerBounds);
    const pedestrianProjection = projectBounds(bodyGeometry.pedestrianBounds);
    const playerLowerProjection = summarizeProjection((bodyGeometry.playerLowerPoints ?? [])
      .map(projectPoint).filter(Boolean));
    const pedestrianLowerProjection = summarizeProjection((bodyGeometry.pedestrianLowerPoints ?? [])
      .map(projectPoint).filter(Boolean));
    const playerFootProjection = summarizeProjection((bodyGeometry.playerFootPoints ?? [])
      .map(projectPoint).filter(Boolean));
    const pedestrianFootProjection = summarizeProjection((bodyGeometry.pedestrianFootPoints ?? [])
      .map(projectPoint).filter(Boolean));
    const belongsTo = (node, root) => {
      for (let current = node; current; current = current.parent) {
        if (current === root) return true;
      }
      return false;
    };
    const opaque = (material) => {
      const materials = Array.isArray(material) ? material : [material];
      return materials.some((entry) => entry && entry.visible !== false
        && (entry.opacity ?? 1) >= 0.85);
    };
    const occluders = [];
    scene.traverse((node) => {
      if (node.visible && node.isMesh && opaque(node.material)
        && !belongsTo(node, avatar) && !belongsTo(node, pedestrian)) occluders.push(node);
    });
    const blocker = (bounds, points = []) => {
      if (!bounds) return 'missing posed lower-body bounds';
      const origin = new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z);
      const targets = points.length ? points : [{
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: (bounds.min.z + bounds.max.z) / 2,
      }];
      for (const value of targets) {
        const target = new THREE.Vector3(value.x, value.y, value.z);
        const direction = target.clone().sub(origin);
        const distance = direction.length();
        if (!Number.isFinite(distance) || distance <= 0.2) continue;
        // Feet rest on the opaque sidewalk mesh.  Exclude only the final 25 cm
        // around the exact posed sample so that contact with the ground itself
        // is not misclassified as foreground occlusion; any slab or facade in
        // front of the silhouette is substantially farther along the ray.
        const raycaster = new THREE.Raycaster(origin, direction.normalize(), 0.05, distance - 0.25);
        for (const hit of raycaster.intersectObjects(occluders, false)) {
          const normal = hit.face?.normal?.clone?.().transformDirection(hit.object.matrixWorld);
          const distanceBeforeTarget = distance - hit.distance;
          // Feet legitimately terminate on the opaque sidewalk. Ignore only an
          // upward-facing support plane immediately before/below the posed foot;
          // vertical or raised foreground slabs remain hard blockers.
          const supportingSurface = points.length > 0
            && normal?.y >= 0.7
            && distanceBeforeTarget <= 0.65
            && hit.point.y <= bounds.min.y + 0.45;
          const withinTarget = points.length === 0
            && hit.point.x >= bounds.min.x - 0.04 && hit.point.x <= bounds.max.x + 0.04
            && hit.point.y >= bounds.min.y - 0.04 && hit.point.y <= bounds.max.y + 0.04
            && hit.point.z >= bounds.min.z - 0.04 && hit.point.z <= bounds.max.z + 0.04;
          if (!supportingSurface && !withinTarget) {
            return {
              name: hit.object.name || hit.object.uuid,
              normalY: normal?.y ?? null,
              pointY: hit.point.y,
              targetY: value.y,
              distanceBeforeTarget,
            };
          }
        }
      }
      return null;
    };
    const overlap = (() => {
      const left = playerProjection.screenBounds;
      const right = pedestrianProjection.screenBounds;
      if (!left || !right) return 1;
      const width = Math.max(0, Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX));
      const height = Math.max(0, Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY));
      const smaller = Math.min(
        Math.max(1e-6, (left.maxX - left.minX) * (left.maxY - left.minY)),
        Math.max(1e-6, (right.maxX - right.minX) * (right.maxY - right.minY)),
      );
      return (width * height) / smaller;
    })();
    return {
      player: {
        rendered: isVisible(avatar),
        projection: playerProjection,
        lowerProjection: playerLowerProjection,
        footProjection: playerFootProjection,
        blocker: blocker(bodyGeometry.playerBounds),
        lowerBlocker: blocker(bodyGeometry.playerLowerBounds, bodyGeometry.playerFootPoints),
      },
      pedestrian: {
        rendered: isVisible(pedestrian),
        projection: pedestrianProjection,
        lowerProjection: pedestrianLowerProjection,
        footProjection: pedestrianFootProjection,
        blocker: blocker(bodyGeometry.pedestrianBounds),
        lowerBlocker: blocker(bodyGeometry.pedestrianLowerBounds, bodyGeometry.pedestrianFootPoints),
      },
      overlap,
    };
  }, geometry);
}

async function captureEvidenceFrame(path, label, geometry, measuredState) {
  const candidates = framingCandidates(geometry);
  if (!candidates.length) {
    assert(false, `${label} has no posed body bounds for evidence framing`, geometry);
    return null;
  }
  let selected = null;
  try {
    for (const candidate of candidates) {
      await page.evaluate((pose) => window.__SF_SIM__?.setCameraPose?.(pose.position, pose.lookAt), candidate);
      await page.waitForTimeout(70);
      const frame = await inspectEvidenceFrame(geometry);
      const score = Math.min(frame?.player?.projection?.fraction ?? 0, frame?.pedestrian?.projection?.fraction ?? 0)
        + Math.min(frame?.player?.lowerProjection?.fraction ?? 0, frame?.pedestrian?.lowerProjection?.fraction ?? 0)
        + Math.min(frame?.player?.footProjection?.fraction ?? 0, frame?.pedestrian?.footProjection?.fraction ?? 0)
        + (1 - Math.min(1, frame?.overlap ?? 1)) * 2
        + (frame?.player?.blocker ? 0 : 2) + (frame?.pedestrian?.blocker ? 0 : 2)
        + (frame?.player?.lowerBlocker ? 0 : 2) + (frame?.pedestrian?.lowerBlocker ? 0 : 2)
        + (candidate.roadSide ? 4 : 0)
        + (candidate.threeQuarter ?? 0) * 0.1;
      if (!selected || score > selected.score) selected = { candidate, frame, score };
    }
    await page.evaluate((pose) => window.__SF_SIM__?.setCameraPose?.(pose.position, pose.lookAt), selected.candidate);
    await page.waitForTimeout(90);
    selected.frame = await inspectEvidenceFrame(geometry);
    assert(selected.frame?.player?.rendered === true && selected.frame?.pedestrian?.rendered === true
      && selected.frame.player.projection.fraction === 1
      && selected.frame.pedestrian.projection.fraction === 1
      && selected.frame.player.lowerProjection.fraction === 1
      && selected.frame.pedestrian.lowerProjection.fraction === 1
      && selected.frame.player.footProjection.corners >= 2
      && selected.frame.pedestrian.footProjection.corners >= 2
      && selected.frame.player.footProjection.fraction === 1
      && selected.frame.pedestrian.footProjection.fraction === 1
      && selected.frame.overlap <= 0.45
      && selected.frame.player.blocker === null && selected.frame.pedestrian.blocker === null
      && selected.frame.player.lowerBlocker === null && selected.frame.pedestrian.lowerBlocker === null,
    `${label} evidence camera did not show full posed silhouettes and unoccluded lower bodies`, selected);
    await page.screenshot({ path });
    return selected;
  } finally {
    await page.evaluate(() => window.__SF_SIM__?.setCameraPose?.(null, null));
    await page.waitForTimeout(70);
    const resumed = await snapshot();
    assert(Number((resumed.collision ?? resumed.contact)?.events)
      === Number((measuredState.collision ?? measuredState.contact)?.events),
    `${label} evidence camera changed measured collision events`, { measuredState, resumed });
  }
}

async function captureContextFrame(path, measuredState) {
  await page.waitForTimeout(70);
  await page.screenshot({ path });
  const resumed = await snapshot();
  assert(Number((resumed.collision ?? resumed.contact)?.events)
    === Number((measuredState.collision ?? measuredState.contact)?.events),
  'downed context capture changed measured collision events', { measuredState, resumed });
  return { contextOnly: true };
}

async function realKey(key, duration) {
  await page.locator('canvas').focus();
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
}

async function waitFor(kind, expected, message, timeout = 6000) {
  try {
    await page.waitForFunction(({ waitKind, value }) => {
      const state = window.__SF_SIM__?.getOnFootPedestrianSpaceQa?.()?.snapshot?.();
      const contact = state?.collision ?? state?.contact;
      if (waitKind === 'event') return Number(contact?.events) >= value;
      if (waitKind === 'clear') return contact?.latched === false && contact?.finalOverlap === false;
      if (waitKind === 'talk-clearance') return Number.isFinite(contact?.finalClearance)
        && contact.finalClearance >= 0.75 && contact.finalClearance <= 2.5;
      if (waitKind === 'diagonal') return contact?.diagonalPassed === true;
      if (waitKind === 'empty') return contact?.emptyPathClear === true;
      return false;
    }, { waitKind: kind, value: expected }, { timeout, polling: 25 });
    return true;
  } catch {
    assert(false, message, await snapshot());
    return false;
  }
}

async function moveToEmptyTalkRange() {
  await page.locator('canvas').focus();
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(() => {
      const sim = window.__SF_SIM__;
      const state = sim?.getOnFootPedestrianSpaceQa?.()?.snapshot?.();
      const position = state?.player?.position;
      return Boolean(position) && !sim?.pedestrians?.getNearestPerson?.(position, 4.6, { includeDefeated: true })?.id;
    }, null, { timeout: 5000, polling: 25 });
  } catch {
    assert(false, 'real W could not reach an honestly empty T-interaction range', await snapshot());
  } finally {
    await page.keyboard.up('w');
  }
}

const point = (value) => Number.isFinite(value?.x) && Number.isFinite(value?.y) && Number.isFinite(value?.z);
const distance = (left, right) => point(left) && point(right)
  ? Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) : Infinity;
const resources = (state) => state?.resources || {};
const reportGeometry = ({
  playerLowerPoints, pedestrianLowerPoints, playerFootPoints, pedestrianFootPoints, ...geometry
} = {}) => geometry;

// Collision telemetry can claim separation while a posed body remains inside
// a pedestrian. Sample the renderer's post-skinning vertices directly.
async function renderedGeometry() {
  return page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim?.getOnFootPedestrianSpaceQa?.()?.snapshot?.();
    const avatar = sim?.playerAvatar;
    const pedestrianState = state?.pedestrian;
    const pedestrian = pedestrianState?.objectUuid
      ? sim?.scene?.getObjectByProperty?.('uuid', pedestrianState.objectUuid)
      : Number.isInteger(pedestrianState?.index)
        ? sim?.pedestrians?.group?.children?.[pedestrianState.index]
        : null;
    if (!avatar || !pedestrian) return null;

    const transform = (value, elements) => ({
      x: elements[0] * value.x + elements[4] * value.y + elements[8] * value.z + elements[12],
      y: elements[1] * value.x + elements[5] * value.y + elements[9] * value.z + elements[13],
      z: elements[2] * value.x + elements[6] * value.y + elements[10] * value.z + elements[14],
    });
    const collect = (root) => {
      root.updateMatrixWorld(true);
      const vertices = [];
      const skinnedVertices = [];
      let skinnedMeshes = 0;
      root.traverse((node) => {
        const position = node.visible && node.isMesh ? node.geometry?.attributes?.position : null;
        if (!position) return;
        if (node.isSkinnedMesh) skinnedMeshes += 1;
        const vertex = node.position.clone();
        const matrix = node.matrixWorld.elements;
        for (let index = 0; index < position.count; index += 1) {
          if (node.isSkinnedMesh && typeof node.getVertexPosition === 'function') {
            node.getVertexPosition(index, vertex);
          } else {
            vertex.set(position.getX(index), position.getY(index), position.getZ(index));
          }
          const worldVertex = transform(vertex, matrix);
          vertices.push(worldVertex);
          if (node.isSkinnedMesh) skinnedVertices.push(worldVertex);
        }
      });
      if (!vertices.length) return { vertices, skinnedMeshes, bounds: null };
      const bounds = vertices.reduce((result, value) => ({
        min: {
          x: Math.min(result.min.x, value.x), y: Math.min(result.min.y, value.y), z: Math.min(result.min.z, value.z),
        },
        max: {
          x: Math.max(result.max.x, value.x), y: Math.max(result.max.y, value.y), z: Math.max(result.max.z, value.z),
        },
      }), {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
      });
      const skinnedBounds = skinnedVertices.length ? skinnedVertices.reduce((result, value) => ({
        min: {
          x: Math.min(result.min.x, value.x), y: Math.min(result.min.y, value.y), z: Math.min(result.min.z, value.z),
        },
        max: {
          x: Math.max(result.max.x, value.x), y: Math.max(result.max.y, value.y), z: Math.max(result.max.z, value.z),
        },
      }), {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
      }) : null;
      const lowerLimit = skinnedBounds
        ? skinnedBounds.min.y + (skinnedBounds.max.y - skinnedBounds.min.y) * 0.32
        : -Infinity;
      const lowerVertices = skinnedVertices.filter((vertex) => vertex.y <= lowerLimit);
      const lowerBounds = lowerVertices.length ? lowerVertices.reduce((result, value) => ({
        min: {
          x: Math.min(result.min.x, value.x), y: Math.min(result.min.y, value.y), z: Math.min(result.min.z, value.z),
        },
        max: {
          x: Math.max(result.max.x, value.x), y: Math.max(result.max.y, value.y), z: Math.max(result.max.z, value.z),
        },
      }), {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
      }) : null;
      const stride = Math.max(1, Math.ceil(lowerVertices.length / 24));
      const lowerPoints = lowerVertices.filter((_, index) => index % stride === 0);
      if (lowerVertices.length && lowerPoints.at(-1) !== lowerVertices.at(-1)) {
        lowerPoints.push(lowerVertices.at(-1));
      }
      const footLimit = skinnedBounds
        ? skinnedBounds.min.y + Math.min(0.12, (skinnedBounds.max.y - skinnedBounds.min.y) * 0.08)
        : -Infinity;
      const footVertices = skinnedVertices.filter((vertex) => vertex.y <= footLimit);
      const footCenter = (values) => values.reduce((result, value) => ({
        x: result.x + value.x / values.length,
        y: result.y + value.y / values.length,
        z: result.z + value.z / values.length,
      }), { x: 0, y: 0, z: 0 });
      const footCenterPoint = footCenter(footVertices);
      const spreadX = footVertices.reduce((extent, value) => Math.max(extent, Math.abs(value.x - footCenterPoint.x)), 0);
      const spreadZ = footVertices.reduce((extent, value) => Math.max(extent, Math.abs(value.z - footCenterPoint.z)), 0);
      const splitKey = spreadX >= spreadZ ? 'x' : 'z';
      const nearFoot = footVertices.filter((vertex) => vertex[splitKey] <= footCenterPoint[splitKey]);
      const farFoot = footVertices.filter((vertex) => vertex[splitKey] > footCenterPoint[splitKey]);
      const footPoints = [nearFoot, farFoot].filter((values) => values.length).map(footCenter);
      return { vertices, skinnedMeshes, bounds, skinnedBounds, lowerBounds, lowerPoints, footPoints };
    };
    const player = collect(avatar);
    const pedestrianGeometry = collect(pedestrian);
    const overlaps = (left, right) => left?.min.x < right?.max.x && left?.max.x > right?.min.x
      && left?.min.y < right?.max.y && left?.max.y > right?.min.y
      && left?.min.z < right?.max.z && left?.max.z > right?.min.z;
    const minimumVertexSeparation = (() => {
      if (!player.vertices.length || !pedestrianGeometry.vertices.length) return Infinity;
      let minimum = Infinity;
      for (const playerVertex of player.vertices) {
        for (const pedestrianVertex of pedestrianGeometry.vertices) {
          const separation = Math.hypot(
            playerVertex.x - pedestrianVertex.x,
            playerVertex.y - pedestrianVertex.y,
            playerVertex.z - pedestrianVertex.z,
          );
          if (separation < minimum) minimum = separation;
        }
      }
      return minimum;
    })();
    const capsule = (bounds) => {
      const width = bounds.max.x - bounds.min.x;
      const depth = bounds.max.z - bounds.min.z;
      const radius = Math.max(0.12, Math.min(width, depth) * 0.32);
      return {
        x: (bounds.min.x + bounds.max.x) / 2,
        z: (bounds.min.z + bounds.max.z) / 2,
        minY: bounds.min.y + radius,
        maxY: Math.max(bounds.min.y + radius, bounds.max.y - radius),
        radius,
      };
    };
    const capsuleClearance = (() => {
      if (!player.bounds || !pedestrianGeometry.bounds) return -Infinity;
      const left = capsule(player.bounds);
      const right = capsule(pedestrianGeometry.bounds);
      const verticalGap = left.maxY < right.minY
        ? right.minY - left.maxY
        : right.maxY < left.minY
          ? left.minY - right.maxY
          : 0;
      return Math.hypot(left.x - right.x, left.z - right.z, verticalGap)
        - left.radius - right.radius;
    })();
    return {
      playerVertices: player.vertices.length,
      playerSkinnedMeshes: player.skinnedMeshes,
      pedestrianVertices: pedestrianGeometry.vertices.length,
      pedestrianSkinnedMeshes: pedestrianGeometry.skinnedMeshes,
      playerBounds: player.bounds,
      pedestrianBounds: pedestrianGeometry.bounds,
      playerSkinnedBounds: player.skinnedBounds,
      pedestrianSkinnedBounds: pedestrianGeometry.skinnedBounds,
      playerLowerBounds: player.lowerBounds,
      pedestrianLowerBounds: pedestrianGeometry.lowerBounds,
      playerLowerPoints: player.lowerPoints,
      pedestrianLowerPoints: pedestrianGeometry.lowerPoints,
      playerFootPoints: player.footPoints,
      pedestrianFootPoints: pedestrianGeometry.footPoints,
      boxOverlap: overlaps(player.bounds, pedestrianGeometry.bounds),
      minimumVertexSeparation,
      capsuleClearance,
    };
  });
}

function assertSeparation(state, geometry, label) {
  const contact = state?.collision ?? state?.contact;
  assert(contact?.finalOverlap === false && contact?.latched === true
    && Number.isFinite(contact?.finalClearance) && contact.finalClearance >= 0,
    `${label} did not end in a latched, physically separated contact`, state);
  assert(geometry?.playerSkinnedMeshes > 0 && geometry?.playerVertices > 0
    && geometry?.pedestrianSkinnedMeshes > 0 && geometry?.pedestrianVertices > 0
    && geometry?.playerBounds && geometry?.pedestrianBounds
    && Number.isFinite(geometry?.minimumVertexSeparation)
    && geometry.minimumVertexSeparation >= 0.01
    && Number.isFinite(geometry?.capsuleClearance)
    && geometry.capsuleClearance >= 0.01,
  `${label} left posed player and pedestrian body geometry intersecting`, geometry);
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

  await stage('contact');
  const before = await snapshot();
  const beforeEvents = Number((before.collision ?? before.contact)?.events) || 0;
  assert(before?.player?.onFoot === true && before?.pedestrian?.visible === true
    && before?.player?.roadGrounded === true && point(before?.player?.position),
  'contact staging did not put a visible grounded player and pedestrian on a road', before);
  await page.keyboard.down('w');
  await waitFor('event', beforeEvents + 1, 'real W did not contact the pedestrian');
  const contact = await snapshot();
  await page.keyboard.up('w');
  assert(Number((contact.collision ?? contact.contact)?.events) === beforeEvents + 1
    && (contact.collision ?? contact.contact)?.corrections >= 1
    && contact?.pedestrian?.visible === true,
  'real W contact did not create exactly one pedestrian-space correction', { before, contact });
  const contactGeometry = await renderedGeometry();
  assertSeparation(contact, contactGeometry, 'positive on-road contact');
  const contactFrame = await captureEvidenceFrame(captures.contact, 'contact', contactGeometry, contact);

  // Evidence framing disables the crowd probe by design, so every subsequent
  // real-input phase is freshly staged after its prior capture has cleared.
  await stage('contact');
  const heldBefore = await snapshot();
  const heldEvents = Number((heldBefore.collision ?? heldBefore.contact)?.events) || 0;
  await page.keyboard.down('w');
  await waitFor('event', heldEvents + 1, 'real W did not contact before held-latch measurement');
  await page.waitForTimeout(600);
  await page.keyboard.up('w');
  const held = await snapshot();
  assert(Number((held.collision ?? held.contact)?.events) === heldEvents + 1,
    'held W repeated a latched pedestrian-space contact', { heldBefore, held });
  const heldGeometry = await renderedGeometry();
  const heldFrame = await captureEvidenceFrame(captures.held, 'held', heldGeometry, held);

  await stage('contact');
  const rearmBefore = await snapshot();
  const rearmEvents = Number((rearmBefore.collision ?? rearmBefore.contact)?.events) || 0;
  await page.keyboard.down('w');
  await waitFor('event', rearmEvents + 1, 'real W did not contact before rearm measurement');
  const rearmContact = await snapshot();
  await page.keyboard.up('w');
  await page.locator('canvas').focus();
  await page.keyboard.down('s');
  await waitFor('talk-clearance', null,
    'real S could not establish a safe post-contact talk clearance');
  await page.keyboard.up('s');
  const talkClearance = await snapshot();
  await page.keyboard.press('t');
  const postContactTalk = await snapshot();
  assert(postContactTalk?.interaction?.tConsumed === true
    && Number((postContactTalk.collision ?? postContactTalk.contact)?.events)
      === rearmEvents + 1
    && Number((postContactTalk.collision ?? postContactTalk.contact)?.finalClearance) >= 0.75,
  'real T failed at a safe post-contact clearance or created another contact', {
    talkClearance, postContactTalk,
  });

  await realKey('s', 350);
  await realKey('a', 180);
  await realKey('d', 180);
  await waitFor('clear', null, 'real S/A/D did not clear pedestrian contact latch');
  await page.keyboard.down('w');
  await waitFor('event', rearmEvents + 2, 'real W re-entry did not create exactly one new contact');
  const rearm = await snapshot();
  await page.keyboard.up('w');
  assert(Number((rearm.collision ?? rearm.contact)?.events) === rearmEvents + 2,
    'separation and re-entry did not rearm exactly one pedestrian-space event', { rearmBefore, rearm });
  const rearmGeometry = await renderedGeometry();
  assertSeparation(rearm, rearmGeometry, 'rearmed on-road contact');
  const rearmFrame = await captureEvidenceFrame(captures.rearm, 'rearm', rearmGeometry, rearm);

  await stage('diagonal');
  const diagonalBefore = await snapshot();
  await page.keyboard.down('w');
  await page.keyboard.down('d');
  await waitFor('diagonal', null, 'real W+D could not pass diagonally around the pedestrian');
  await page.keyboard.up('w');
  await page.keyboard.up('d');
  const diagonal = await snapshot();
  assert((diagonal.collision ?? diagonal.contact)?.finalOverlap === false
    && distance(diagonal?.player?.position, diagonalBefore?.player?.position) >= 1,
  'diagonal real input neither passed the pedestrian nor maintained separation', { diagonalBefore, diagonal });
  const diagonalGeometry = await renderedGeometry();
  const diagonalFrame = await captureEvidenceFrame(captures.diagonal, 'diagonal', diagonalGeometry, diagonal);

  await stage('empty');
  const emptyBefore = await snapshot();
  await moveToEmptyTalkRange();
  await page.keyboard.press('t');
  const empty = await snapshot();
  assert(Number((empty.collision ?? empty.contact)?.events) === Number((emptyBefore.collision ?? emptyBefore.contact)?.events)
    && distance(empty?.player?.position, emptyBefore?.player?.position) >= 1
    && empty?.interaction?.tConsumed === false,
  'empty-road W/T path was blocked, collided, or claimed a distant interaction', { emptyBefore, empty });
  const emptyGeometry = await renderedGeometry();
  const emptyFrame = await captureEvidenceFrame(captures.empty, 'empty', emptyGeometry, empty);

  // This is a real combat state created by main, not a scenario label.  We do
  // not stage driving/interior/passenger here because the pedestrian seam
  // cannot truthfully establish those live contexts.
  await stage('downed');
  const downedBefore = await snapshot();
  const downedEvents = Number((downedBefore.collision ?? downedBefore.contact)?.events) || 0;
  await realKey('w', 350);
  await page.keyboard.press('t');
  const downed = await snapshot();
  assert(downed?.player?.context?.downed === true
    && Number((downed.collision ?? downed.contact)?.events) === downedEvents
    && (downed.collision ?? downed.contact)?.active === false
    && downed?.interaction?.tConsumed === true,
  'real downed W/T input permitted an on-foot pedestrian collision or was not consumed', {
    before: downedBefore, after: downed,
  });
  const downedGeometry = await renderedGeometry();
  const downedFrame = await captureContextFrame(
    captures.negative,
    downed,
  );

  const resourceSamples = [before, contact, held, rearm, diagonal, empty, downed]
    .map(resources);
  assert(resourceSamples.every((sample) => Object.keys(resourceSamples[0]).every((key) => (
    Number.isFinite(sample[key]) && sample[key] === resourceSamples[0][key]
  ))), 'pedestrian-space scenarios grew resources', resourceSamples);

  await page.evaluate(() => window.__SF_SIM__?.resetPerformanceTelemetry?.());
  await page.waitForFunction(() => (
    window.__SF_SIM__?.getPerformanceSnapshot?.()?.applicationFrameCount ?? 0
  ) >= 180, null, { timeout: 12000, polling: 50 });
  const performance = await page.evaluate(() => window.__SF_SIM__?.getPerformanceSnapshot?.());
  assert(performance?.applicationFrameCount >= 180
    && Number.isFinite(performance?.applicationP99FrameMs)
    && performance.applicationP99FrameMs <= 16.67,
  'on-foot pedestrian-space exceeded the 16.67 ms application p99 budget', performance);
  assert(consoleErrors.length === 0 && httpErrors.length === 0 && requestFailures.length === 0,
    'runtime errors leaked during on-foot pedestrian-space verification', {
      consoleErrors, httpErrors, requestFailures,
    });

  const report = {
    pass: failures.length === 0 && consoleErrors.length === 0
      && httpErrors.length === 0 && requestFailures.length === 0,
    renderer,
    contact: { before, contact, geometry: reportGeometry(contactGeometry), frame: contactFrame },
    held: { before: heldBefore, state: held, geometry: reportGeometry(heldGeometry), frame: heldFrame },
    rearm: { before: rearmBefore, contact: rearmContact, talkClearance, postContactTalk, state: rearm, geometry: reportGeometry(rearmGeometry), frame: rearmFrame },
    diagonal: { before: diagonalBefore, state: diagonal, geometry: reportGeometry(diagonalGeometry), frame: diagonalFrame },
    empty: { before: emptyBefore, state: empty, geometry: reportGeometry(emptyGeometry), frame: emptyFrame },
    downed: { before: downedBefore, state: downed, geometry: reportGeometry(downedGeometry), frame: downedFrame },
    performance,
    captures,
    consoleErrors,
    httpErrors,
    requestFailures,
    failures,
  };
  console.log(JSON.stringify({
    evidenceSummary: {
      contact: contactFrame?.frame,
      held: heldFrame?.frame,
      rearm: rearmFrame?.frame,
      diagonal: diagonalFrame?.frame,
      empty: emptyFrame?.frame,
      downed: downedFrame?.frame,
    },
    failures,
  }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ result: 'on-foot pedestrian-space verifier failed', error: error.message, failures }, null, 2));
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
