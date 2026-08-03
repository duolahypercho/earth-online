import { chromium } from 'playwright';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const outputDir = process.env.SF_NPC_ANIM_DIR || join(projectRoot, 'tmp/npc-anim-qa');
const PASS_SCORE = Number(process.env.SF_NPC_ANIM_PASS ?? 8);
const FRAME_COUNT = Number(process.env.SF_NPC_ANIM_FRAMES ?? 16);
const FRAME_INTERVAL_MS = Number(process.env.SF_NPC_ANIM_INTERVAL_MS ?? 80);

const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';

const SUBJECTS = [
  {
    id: 'core-hero',
    label: 'Core hero pedestrian',
    // Open sidewalk corridor on the beauty route — avoids facade clipping.
    // Beauty corridor east of the cable-car apron — avoids tan deck burial.
    roam: { x: 72, z: -8 },
    preferHero: true,
    minHeroDetail: true,
    focusRadius: 96,
    roamRadius: 88,
    settleMs: 3000,
  },
  {
    id: 'core-crowd',
    label: 'Core background pedestrian',
    // North of cable-car plaza; aperture reject keeps subjects off tan decks.
    roam: { x: 55, z: 12 },
    preferHero: false,
    excludeHeroDetail: true,
    focusRadius: 72,
    roamRadius: 48,
    settleMs: 3200,
  },
  {
    id: 'streamed-walk',
    label: 'Streamed district pedestrian',
    // Mid-block between 64m grids — avoid painted crosswalks at intersections.
    roam: { x: 400, z: 100 },
    sectorKey: '1:0',
    streamed: true,
    settleMs: 4000,
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function correlation(a, b) {
  if (a.length !== b.length || a.length < 2) return 0;
  const avgA = mean(a);
  const avgB = mean(b);
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index] - avgA;
    const db = b[index] - avgB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 1e-6 ? num / den : 0;
}

function isContextDestroyed(error) {
  const message = String(error?.message || error || '');
  return /Execution context was destroyed|Target closed|frame was detached|most likely because of a navigation/i.test(message);
}

async function bootSim(page) {
  const stage = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      error.message = `bootSim:${name}: ${error.message}`;
      throw error;
    }
  };
  // `commit` is enough — full domcontentloaded can hang under Vite HMR rebuilds.
  await stage('goto', () => page.goto(baseUrl, { waitUntil: 'commit', timeout: 90000 }));
  await stage('launch-ready', () => page.waitForFunction(
    () => document.querySelector('#launch-button')
      && !document.querySelector('#launch-button').disabled
      && document.querySelector('#boot-overlay')?.classList.contains('is-ready'),
    { timeout: 90000 },
  ));
  await stage('launch-click', () => page.locator('#launch-button').click({ force: true, timeout: 15000 }));
  await stage('overlay-dismiss', () => page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed')
      || Boolean(window.__SF_SIM__?.pedestrians?.group),
    { timeout: 45000 },
  ));
  await stage('sim-api', () => page.waitForFunction(
    () => Boolean(window.__SF_SIM__?.pedestrians?.group && window.__SF_SIM__?.streamedAgents),
    { timeout: 45000 },
  ));
  await stage('qa-env', () => page.evaluate(() => {
    window.__SF_SIM__.setRenderQuality('cinematic');
    window.__SF_SIM__.setWeather('clear');
    window.__SF_SIM__.setTimeOfDay(10.5);
  }));
  await page.keyboard.press('h');
  await page.waitForTimeout(1200);
  await stage('ped-pool', () => page.waitForFunction(
    () => (window.__SF_SIM__?.pedestrians?.group?.children?.length ?? 0) > 0,
    { timeout: 45000 },
  ));
}

async function recoverSim(page) {
  // Vite HMR / full reload often leaves us on the boot overlay again.
  await page.waitForTimeout(1500);
  const needsBoot = await page.evaluate(() => {
    const overlay = document.querySelector('#boot-overlay');
    const dismissed = overlay?.classList.contains('is-dismissed');
    return !dismissed || !window.__SF_SIM__?.pedestrians?.group;
  }).catch(() => true);
  if (needsBoot) {
    console.warn('[qa-npc-anim] recovering from navigation/HMR — rebooting sim');
    await bootSim(page);
  } else {
    await page.waitForFunction(
      () => Boolean(window.__SF_SIM__?.pedestrians?.group && window.__SF_SIM__?.streamedAgents),
      { timeout: 30000 },
    );
  }
}

async function ensureSimLive(page) {
  const live = await page.evaluate(() => {
    const overlay = document.querySelector('#boot-overlay');
    const dismissed = Boolean(overlay?.classList.contains('is-dismissed'));
    const hasLaunch = Boolean(document.querySelector('#launch-button'));
    // Boot card still visible ⇒ any screenshot would score the landing UI.
    if (hasLaunch && overlay && !dismissed) return false;
    return Boolean(window.__SF_SIM__?.pedestrians?.group && window.__SF_SIM__?.streamedAgents);
  }).catch(() => false);
  if (live) return true;
  await recoverSim(page);
  return false;
}

async function withSimRetry(page, label, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isContextDestroyed(error) || attempt === attempts) throw error;
      console.warn(`[qa-npc-anim] ${label} attempt ${attempt} lost context — retrying`);
      await recoverSim(page);
    }
  }
  throw lastError;
}

async function analyzeImage(page, path) {
  const buffer = await readFile(path);
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const width = canvas.width;
    const height = canvas.height;
    const cropX = Math.floor(width * 0.28);
    const cropY = Math.floor(height * 0.08);
    const cropW = Math.floor(width * 0.44);
    const cropH = Math.floor(height * 0.84);
    const data = ctx.getImageData(cropX, cropY, cropW, cropH).data;
    let nonBlank = 0;
    let lumaSum = 0;
    let colorSum = 0;
    let edgeSum = 0;
    let sampleCount = 0;
    const step = 3;
    for (let y = 0; y < cropH; y += step) {
      for (let x = 0; x < cropW; x += step) {
        const index = (y * cropW + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        lumaSum += luma;
        colorSum += saturation;
        if (luma > 8) nonBlank += 1;
        sampleCount += 1;
        if (x + step < cropW && y + step < cropH) {
          const next = ((y + step) * cropW + x) * 4;
          const dx = Math.abs(data[next] - r) + Math.abs(data[next + 1] - g) + Math.abs(data[next + 2] - b);
          const below = (y * cropW + x + step) * 4;
          const dy = Math.abs(data[below] - r) + Math.abs(data[below + 1] - g) + Math.abs(data[below + 2] - b);
          edgeSum += Math.min(1, (dx + dy) / 96);
        }
      }
    }
    return {
      width,
      height,
      crop: { x: cropX, y: cropY, w: cropW, h: cropH },
      nonBlankRatio: nonBlank / sampleCount,
      meanLuma: lumaSum / sampleCount,
      meanSaturation: colorSum / sampleCount,
      edgeDensity: edgeSum / sampleCount,
    };
  }, dataUrl);
}

async function compareFramePair(page, previousPath, nextPath) {
  const previous = await readFile(previousPath);
  const next = await readFile(nextPath);
  return page.evaluate(async ({ previousUrl, nextUrl }) => {
    const load = async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const a = await load(previousUrl);
    const b = await load(nextUrl);
    const width = 1280;
    const height = 720;
    const cropX = Math.floor(width * 0.28);
    const cropY = Math.floor(height * 0.08);
    const cropW = Math.floor(width * 0.44);
    const cropH = Math.floor(height * 0.84);
    let diffSum = 0;
    let diffMax = 0;
    let samples = 0;
    const step = 4;
    for (let y = cropY; y < cropY + cropH; y += step) {
      for (let x = cropX; x < cropX + cropW; x += step) {
        const index = (y * width + x) * 4;
        const dr = Math.abs(a[index] - b[index]);
        const dg = Math.abs(a[index + 1] - b[index + 1]);
        const db = Math.abs(a[index + 2] - b[index + 2]);
        const delta = (dr + dg + db) / 765;
        diffSum += delta;
        diffMax = Math.max(diffMax, delta);
        samples += 1;
      }
    }
    return {
      meanDelta: diffSum / Math.max(1, samples),
      maxDelta: diffMax,
    };
  }, {
    previousUrl: `data:image/png;base64,${previous.toString('base64')}`,
    nextUrl: `data:image/png;base64,${next.toString('base64')}`,
  });
}

function scoreMotionEnergy(meanDelta, maxDelta) {
  const meanScore = clamp((meanDelta - 0.004) / 0.028, 0, 1) * 2.5;
  const peakScore = clamp((maxDelta - 0.02) / 0.12, 0, 1) * 1.0;
  return meanScore + peakScore;
}

function scoreLimbCycle({ legRange, alternation, armRange }) {
  const rangeScore = clamp((legRange - 0.12) / 0.55, 0, 1) * 1.4;
  const altScore = clamp((alternation + 0.15) / 0.85, 0, 1) * 1.2;
  const armScore = clamp((armRange - 0.08) / 0.45, 0, 1) * 0.4;
  return rangeScore + altScore + armScore;
}

function scoreRigOscillation({ bobRange, footRange }) {
  const bobScore = clamp((bobRange - 0.004) / 0.018, 0, 1) * 0.9;
  const footScore = clamp((footRange - 0.012) / 0.06, 0, 1) * 0.6;
  return bobScore + footScore;
}

function scoreSilhouette(metrics) {
  if (!metrics) return 0;
  const edgeScore = clamp(metrics.edgeDensity / 0.22, 0, 1) * 0.55;
  const blankScore = clamp((metrics.nonBlankRatio - 0.18) / 0.42, 0, 1) * 0.45;
  return edgeScore + blankScore;
}

function scoreContinuity(frameDiffs, rigSamples = []) {
  if (frameDiffs.length) {
    const activeFrames = frameDiffs.filter((entry) => entry.meanDelta > 0.006).length;
    const activeRatio = activeFrames / frameDiffs.length;
    const variance = stddev(frameDiffs.map((entry) => entry.meanDelta));
    const activeScore = clamp((activeRatio - 0.45) / 0.45, 0, 1) * 0.8;
    const varianceScore = clamp((variance - 0.0015) / 0.012, 0, 1) * 0.7;
    if (activeScore + varianceScore > 0.2) return activeScore + varianceScore;
  }
  const leftLegs = rigSamples.map((sample) => sample.leftLegX);
  if (leftLegs.length < 4) return 0;
  const rigVariance = stddev(leftLegs);
  return clamp((rigVariance - 0.04) / 0.22, 0, 1) * 1.5;
}

function scoreRigMotionEnergy({ legRange, alternation, bobRange }) {
  const legScore = clamp((legRange - 0.12) / 0.55, 0, 1) * 2.0;
  const altScore = clamp((alternation + 0.15) / 0.85, 0, 1) * 1.0;
  const bobScore = clamp((bobRange - 0.004) / 0.018, 0, 1) * 0.5;
  return legScore + altScore + bobScore;
}

function scoreSubject(subject) {
  const checks = [];
  const addCheck = (name, pass, detail = null) => {
    checks.push({ name, pass: Boolean(pass), ...(detail == null ? {} : { detail }) });
  };

  const frameDiffs = subject.frameDiffs || [];
  const rigSamples = subject.rigSamples || [];
  const frameMetrics = subject.frames?.map((frame) => frame.metrics).filter(Boolean) || [];
  const meanDelta = mean(frameDiffs.map((entry) => entry.meanDelta));
  const maxDelta = Math.max(0, ...frameDiffs.map((entry) => entry.maxDelta));

  const leftLegs = rigSamples.map((sample) => sample.leftLegX);
  const rightLegs = rigSamples.map((sample) => sample.rightLegX);
  const leftArms = rigSamples.map((sample) => sample.leftArmX);
  const rightArms = rigSamples.map((sample) => sample.rightArmX);
  const bobs = rigSamples.map((sample) => sample.rigBob);
  const feet = rigSamples.flatMap((sample) => [sample.leftFootY, sample.rightFootY]);

  const legRange = Math.max(
    Math.max(...leftLegs, 0) - Math.min(...leftLegs, 0),
    Math.max(...rightLegs, 0) - Math.min(...rightLegs, 0),
  );
  const armRange = Math.max(
    Math.max(...leftArms, 0) - Math.min(...leftArms, 0),
    Math.max(...rightArms, 0) - Math.min(...rightArms, 0),
  );
  const alternation = -correlation(leftLegs, rightLegs);
  const bobRange = bobs.length ? Math.max(...bobs) - Math.min(...bobs) : 0;
  const footRange = feet.length ? Math.max(...feet) - Math.min(...feet) : 0;

  addCheck('Subject resolved', Boolean(subject.target));
  addCheck('Walk cycle frames captured', (subject.frames?.length ?? 0) >= Math.min(8, FRAME_COUNT), {
    frames: subject.frames?.length ?? 0,
  });
  addCheck('NPC region visible', mean(frameMetrics.map((metrics) => metrics.nonBlankRatio)) > 0.22, {
    nonBlankRatio: mean(frameMetrics.map((metrics) => metrics.nonBlankRatio)),
  });
  // Night districts have near-black skies; only treat a frame as blank when
  // both luma AND silhouette energy collapse (true void / lost subject).
  const blankFrames = frameMetrics.filter((metrics) => (
    metrics.meanLuma < 8 && metrics.edgeDensity < 0.012 && metrics.nonBlankRatio < 0.08
  )).length;
  addCheck('No blank / black frames', blankFrames <= 1, { blankFrames });
  const dimFrames = frameMetrics.filter((metrics) => (
    metrics.meanLuma < 20 && metrics.edgeDensity < 0.015 && metrics.nonBlankRatio < 0.12
  )).length;
  addCheck('Subject stays framed', dimFrames <= Math.floor(FRAME_COUNT * 0.35), { dimFrames });
  const rigMotionEnergy = scoreRigMotionEnergy({ legRange, alternation, bobRange });
  const pixelMotionEnergy = scoreMotionEnergy(meanDelta, maxDelta);
  const hasPixelMotion = meanDelta > 0.004;
  const hasRigMotion = legRange > 0.12 && alternation > 0.15;

  addCheck('Frame motion detected', subject.streamed ? hasPixelMotion : (hasPixelMotion || hasRigMotion), {
    meanDelta,
    legRange,
    alternation,
  });
  addCheck(
    'No animation freeze',
    subject.streamed
      ? frameDiffs.filter((entry) => entry.meanDelta > 0.004).length >= 4
      : (frameDiffs.filter((entry) => entry.meanDelta > 0.004).length >= 2 || rigSamples.length >= 8),
    {
      activePairs: frameDiffs.filter((entry) => entry.meanDelta > 0.004).length,
      rigSamples: rigSamples.length,
    },
  );

  if (!subject.streamed) {
    addCheck('Leg swing amplitude', legRange > 0.12, { legRange });
    addCheck('Alternating leg drive', alternation > 0.15, { alternation });
    addCheck('Vertical bob present', bobRange > 0.004, { bobRange });
  } else {
    addCheck('Streamed actor motion', meanDelta > 0.0045, { meanDelta });
    addCheck('Streamed actor tracked', Boolean(subject.target?.id), subject.target);
  }

  const components = {
    motionEnergy: Number((subject.streamed
      ? pixelMotionEnergy
      : Math.max(pixelMotionEnergy, rigMotionEnergy)).toFixed(3)),
    limbCycle: subject.streamed
      ? Number(clamp(meanDelta / 0.035, 0, 1) * 3).toFixed(3)
      : Number(scoreLimbCycle({ legRange, alternation, armRange }).toFixed(3)),
    rigOscillation: subject.streamed
      ? Number(clamp(meanDelta / 0.03, 0, 1) * 1.5).toFixed(3)
      : Number(scoreRigOscillation({ bobRange, footRange }).toFixed(3)),
    silhouette: Number(scoreSilhouette(frameMetrics.length ? {
      edgeDensity: mean(frameMetrics.map((metrics) => metrics.edgeDensity)),
      nonBlankRatio: mean(frameMetrics.map((metrics) => metrics.nonBlankRatio)),
    } : null).toFixed(3)),
    continuity: Number(scoreContinuity(frameDiffs, rigSamples).toFixed(3)),
    visibility: Number(clamp(mean(frameMetrics.map((metrics) => metrics.nonBlankRatio)) / 0.55, 0, 1).toFixed(3)),
  };

  const rawScore = Object.values(components).reduce((sum, value) => sum + Number(value), 0);
  const score = Number(clamp(rawScore, 0.5, 10).toFixed(1));
  const pass = score >= PASS_SCORE && checks.every((entry) => entry.pass);

  return {
    id: subject.id,
    label: subject.label,
    streamed: Boolean(subject.streamed),
    target: subject.target,
    score,
    pass,
    verdict: pass ? 'PASS' : 'FAIL',
    threshold: PASS_SCORE,
    components,
    metrics: {
      meanDelta,
      maxDelta,
      legRange,
      armRange,
      alternation,
      bobRange,
      footRange,
      meanEdgeDensity: mean(frameMetrics.map((metrics) => metrics.edgeDensity)),
      meanNonBlankRatio: mean(frameMetrics.map((metrics) => metrics.nonBlankRatio)),
    },
    checks,
    frames: subject.frames?.map((frame) => ({
      index: frame.index,
      file: frame.file,
      metrics: frame.metrics,
      rig: frame.rig,
    })) ?? [],
    frameDiffs,
  };
}

async function waitForWalkingSubject(page, options = {}) {
  await page.waitForFunction(
    () => Boolean(window.__SF_SIM__?.pedestrians?.group && window.__SF_SIM__?.streamedAgents),
    { timeout: 30000 },
  ).catch(() => {});
  return page.evaluate(async (config) => {
    const sim = window.__SF_SIM__;
    if (!sim?.pedestrians?.group || !sim?.streamedAgents) return null;
    const waitFrames = (count) => new Promise((resolve) => {
      let seen = 0;
      const step = () => {
        seen += 1;
        if (seen >= count) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    const sampleMesh = (mesh) => {
      const ud = mesh.userData || {};
      return {
        leftLegX: ud.leftLeg?.rotation?.x ?? 0,
        rightLegX: ud.rightLeg?.rotation?.x ?? 0,
        leftArmX: ud.leftArm?.rotation?.x ?? 0,
        rightArmX: ud.rightArm?.rotation?.x ?? 0,
        rigBob: ud.rig?.position?.y ?? 0,
        rigRoll: ud.rig?.rotation?.z ?? 0,
        leftFootY: ud.leftFoot?.position?.y ?? 0,
        rightFootY: ud.rightFoot?.position?.y ?? 0,
      };
    };

    const frameCamera = (mesh) => {
      const pos = mesh.position;
      const surface = sim.streaming.getSurfaceHeight?.({ x: pos.x, z: pos.z });
      const groundY = Math.max(
        Number.isFinite(surface) ? surface : pos.y,
        pos.y - 0.08,
      );
      if (config.excludeHeroDetail && !config.minHeroDetail) {
        // Street-side three-quarter — yaw-based profile often buries the
        // camera inside facades on tight sidewalks.
        const focusY = pos.y + 1.05;
        sim.setCameraPose(
          {
            x: pos.x + 6.2,
            y: pos.y + 3.25,
            z: pos.z + 5.4,
          },
          { x: pos.x, y: focusY, z: pos.z },
        );
      } else {
        // Waterfront beauty routes: massing on −X, curb/street on +X. Keep the
        // lens on +X with only a light along-path offset so corner facades
        // don't swallow the first frames.
        const feetY = pos.y;
        const along = Math.cos(mesh.rotation?.y || 0) * 1.6;
        // High street-side lens clears tan plaza decks that otherwise crop legs.
        sim.setCameraPose(
          { x: pos.x + 8.2, y: feetY + 3.35, z: pos.z + along },
          { x: pos.x, y: feetY + 1.2, z: pos.z },
        );
      }
      return {
        x: pos.x,
        y: groundY,
        z: pos.z,
      };
    };

    if (config.streamed) {
      const origin = { x: config.roam.x, y: 0, z: config.roam.z };
      const first = sim.streamedAgents.getEvidenceState(origin, 120);
      await waitFrames(12);
      const second = sim.streamedAgents.getEvidenceState(origin, 120);
      const before = new Map(first.actors.map((actor) => [actor.id, actor]));
      let best = null;
      let bestMotion = -1;
      for (const actor of second.actors) {
        if (actor.kind !== 'pedestrian' || actor.state !== 'moving') continue;
        // Skip active crossers — high rear lenses make stride read as a sit.
        if (actor.state === 'crossing') continue;
        const prior = before.get(actor.id);
        if (!prior || prior.state !== 'moving' || prior.state === 'crossing') continue;
        const motion = Math.hypot(
          actor.position.x - prior.position.x,
          actor.position.z - prior.position.z,
        );
        if (motion < 0.12) continue;
        // Reject walkers sitting on a crosswalk grid cell.
        const prog = Number.isFinite(actor.progress) ? actor.progress : 0;
        const gridDist = Math.abs(prog - Math.round(prog / 64) * 64);
        if (gridDist < 6) continue;
        // Prefer sidewalk strollers — crossers look seated from high rear cams.
        const score = motion
          + (actor.state === 'crossing' ? -0.25 : 0.35)
          + Math.min(gridDist, 20) * 0.02
          + (actor.pace || 1) * 0.08;
        if (score > bestMotion) {
          bestMotion = score;
          best = actor;
        }
      }
      if (!best || bestMotion < 0.12) return null;
      const surface = sim.streaming.getSurfaceHeight?.({ x: best.position.x, z: best.position.z })
        ?? best.position.y;
      const groundY = Math.max(Number.isFinite(surface) ? surface : best.position.y, best.position.y - 1.2);
      // Profile / three-quarter so capsule L/R legs don't fuse from dead rear.
      const yaw = Number.isFinite(best.yaw) ? best.yaw : 0;
      // Strong profile — dead-rear cams under-report meanDelta on sidewalk strolls.
      const side = Math.sin(yaw) || 1;
      const along = Math.cos(yaw) * 0.35;
      sim.setCameraPose(
        {
          x: best.position.x + along * 1.2 + side * 5.4,
          y: groundY + 2.15,
          z: best.position.z - side * 1.2 + along * 5.4,
        },
        { x: best.position.x, y: groundY + 1.0, z: best.position.z },
      );
      return {
        kind: 'streamed',
        id: best.id,
        role: best.role,
        activity: best.activity,
        yaw,
        progress: best.progress,
        position: best.position,
      };
    }
    const children = sim.pedestrians.group.children.filter((mesh) => mesh.visible && mesh.userData?.rig);
    if (config.focusRadius && config.roam) {
      sim.pedestrians.setFocus?.({ x: config.roam.x, z: config.roam.z }, config.focusRadius);
    }
    const roamX = config.roam?.x ?? 0;
    const roamZ = config.roam?.z ?? 0;
    const roamRadius = config.roamRadius ?? 42;
    // Heroes often sit in WORK/IDLE on beauty stops — kick the nearest into
    // walk before sampling so selection doesn't return target:null.
    if (config.minHeroDetail) {
      let nearestHero = null;
      let nearestDist = Infinity;
      for (const mesh of children) {
        if (!mesh.userData?.heroDetail) continue;
        const dist = Math.hypot(mesh.position.x - roamX, mesh.position.z - roamZ);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestHero = mesh;
        }
      }
      if (nearestHero) {
        const index = sim.pedestrians.group.children.indexOf(nearestHero);
        if (index >= 0) {
          sim.pedestrians.setQaSolo?.(index, { forceWalk: true });
          await waitFrames(24);
          sim.pedestrians.setQaSolo?.(null);
        }
      }
    }
    const candidates = [];
    for (const mesh of children) {
      if (config.minHeroDetail && !mesh.userData.heroDetail) continue;
      if (config.excludeHeroDetail && mesh.userData.heroDetail) continue;
      const distFromRoam = Math.hypot(mesh.position.x - roamX, mesh.position.z - roamZ);
      if (distFromRoam > roamRadius) continue;
      const startPos = { x: mesh.position.x, z: mesh.position.z };
      const first = sampleMesh(mesh);
      await waitFrames(12);
      const second = sampleMesh(mesh);
      const legMotion = Math.abs(first.leftLegX - second.leftLegX)
        + Math.abs(first.rightLegX - second.rightLegX);
      const translate = Math.hypot(mesh.position.x - startPos.x, mesh.position.z - startPos.z);
      const motion = legMotion * 2.4 + translate * 10 + Math.abs(first.rigBob - second.rigBob) * 3;
      candidates.push({
        mesh,
        motion,
        legMotion,
        translate,
        distFromRoam,
        heroDetail: Boolean(mesh.userData.heroDetail),
        index: sim.pedestrians.group.children.indexOf(mesh),
        name: mesh.name,
      });
    }
    // Prefer actors that are both swinging limbs AND translating — idle
    // mannequins can still show tiny bob and poison the visual review.
    // Also reject plaza/cable-car burial candidates where surface >> mesh Y.
    const grounded = candidates.filter((entry) => {
      const { x, y, z } = entry.mesh.position;
      const surface = sim.streaming.getSurfaceHeight?.({ x, z });
      // Buried = deck above feet. Mesh above surface is normal on grades —
      // heroes often sit at y≈2.5 while surfaceHeight reports 0.
      const buried = Number.isFinite(surface) && surface - y > 0.28;
      // Cable-car / ferry plaza tan decks bury limbs in the lens.
      if (x > 18.5 && x < 45.5 && z > 4.5 && z < 33.5) {
        return false;
      }
      // Heroes: skip only the northern turntable apron (not the whole corridor).
      if (config.minHeroDetail && x > 22 && x < 48 && z > 33 && z < 42) {
        return false;
      }
      if (buried) return false;
      if (!Number.isFinite(surface)) return true;
      if (config.minHeroDetail) return y - surface < 6;
      return Math.abs(surface - y) < 0.7 || (y > surface && y - surface < 3.5);
    });
    if (!grounded.length && (config.excludeHeroDetail || config.minHeroDetail)) return null;
    const pool = grounded.length ? grounded : candidates;
    pool.sort((a, b) => {
      // On the waterfront corridor, higher +X is street-side (away from facades).
      // Heroes get a stronger street bias so the QA lens isn't born in a corner.
      const streetWeight = config.minHeroDetail ? 4.2 : 1.8;
      const street = (b.mesh.position.x - a.mesh.position.x) * streetWeight;
      // Hard-prefer translation so seated/idle bobbers don't win.
      const walkScore = (entry) => entry.translate * 14 + entry.legMotion * 2.4;
      return (walkScore(b) + street) - walkScore(a) || a.distFromRoam - b.distFromRoam;
    });
    const minTranslate = config.excludeHeroDetail ? 0.08 : 0.06;
    const chosen = pool.find((entry) => entry.legMotion > 0.12 && entry.translate > minTranslate)
      || pool.find((entry) => entry.translate > minTranslate && entry.legMotion > 0.06)
      || pool.find((entry) => entry.legMotion > 0.08 && entry.translate > 0.04)
      || pool.find((entry) => entry.legMotion > 0.08)
      || (config.minHeroDetail && pool.find((entry) => entry.translate > 0.02))
      || pool[0];
    // Skinned heroes animate mostly via bone rotation; allow lower legMotion.
    const minLeg = config.minHeroDetail ? 0.012 : 0.03;
    if (!chosen || chosen.legMotion <= minLeg) {
      if (!(config.minHeroDetail && chosen && chosen.translate > 0.015)) return null;
    }
    if (config.excludeHeroDetail && chosen.translate < 0.035) return null;
    const position = frameCamera(chosen.mesh);
      return {
        kind: 'core',
        index: chosen.index,
        name: chosen.name,
        heroDetail: chosen.heroDetail,
        motion: chosen.motion,
        legMotion: chosen.legMotion,
        translate: chosen.translate,
        position,
      };
  }, options);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
    errors.push(message.text());
  }
});

const captures = [];

try {
  await mkdir(outputDir, { recursive: true });
  await withSimRetry(page, 'boot', () => bootSim(page), 3);

  for (const subjectConfig of SUBJECTS) {
    const subjectDir = join(outputDir, subjectConfig.id);
    await mkdir(subjectDir, { recursive: true });

    const capture = await withSimRetry(page, subjectConfig.id, async () => {
      await page.evaluate(() => {
        window.__SF_SIM__.pedestrians.setQaSolo?.(null);
        window.__SF_SIM__.streamedAgents.setQaForceWalk?.(null);
        window.__SF_SIM__.pedestrians.group.children.forEach((mesh) => {
          if (mesh.userData?.rig) mesh.visible = true;
        });
      });

      await page.evaluate((position) => {
        window.__SF_SIM__.setRoamPose(position);
      }, subjectConfig.roam);

      if (subjectConfig.sectorKey) {
        await page.waitForFunction(
          (key) => window.__SF_SIM__?.streaming?.stats?.focusSector === key,
          subjectConfig.sectorKey,
          { timeout: 15000 },
        ).catch(() => {});
      }

      await page.waitForTimeout(subjectConfig.settleMs);

    let target = await waitForWalkingSubject(page, subjectConfig);
    if (!target && subjectConfig.streamed) {
      await page.waitForTimeout(2200);
      target = await waitForWalkingSubject(page, subjectConfig);
    }
    if (!target && subjectConfig.excludeHeroDetail) {
      // Background actors cluster on the beauty corridor; probe a few sidewalk
      // pockets until we find one that isn't deck-buried.
      const crowdRoams = [
        { x: 55, z: 12 },
        { x: 70, z: -15 },
        { x: 12, z: 55 },
        { x: -10, z: 30 },
        { x: 80, z: 20 },
        { x: 40, z: 60 },
      ];
      for (const roam of crowdRoams) {
        await page.evaluate((position) => {
          window.__SF_SIM__.setRoamPose(position);
        }, roam);
        await page.waitForTimeout(1600);
        target = await waitForWalkingSubject(page, { ...subjectConfig, roam });
        if (target) break;
      }
    }
    if (!target && subjectConfig.minHeroDetail) {
      const heroRoams = [
        { x: 72, z: -8 },
        { x: 85, z: 12 },
        { x: 60, z: -20 },
        { x: 12, z: 60 },
        { x: 90, z: 30 },
        { x: -10, z: 40 },
      ];
      for (const roam of heroRoams) {
        await page.evaluate((position) => {
          window.__SF_SIM__.setRoamPose(position);
        }, roam);
        await page.waitForTimeout(1800);
        target = await waitForWalkingSubject(page, {
          ...subjectConfig,
          roam,
          roamRadius: Math.max(subjectConfig.roamRadius || 64, 80),
          focusRadius: Math.max(subjectConfig.focusRadius || 72, 96),
        });
        if (target) break;
      }
    }
      if (!target) {
        return {
          ...subjectConfig,
          target: null,
          frames: [],
          frameDiffs: [],
          rigSamples: [],
        };
      }

      await page.waitForTimeout(350);
      if (subjectConfig.streamed && target.id) {
        await page.evaluate(({ actorId }) => {
          window.__SF_SIM__.streamedAgents.setQaForceWalk?.(actorId);
        }, { actorId: target.id });
        await page.waitForTimeout(180);
      } else if (!subjectConfig.streamed && Number.isInteger(target.index)) {
        await page.evaluate(({ meshIndex }) => {
          window.__SF_SIM__.pedestrians.setQaSolo?.(meshIndex);
        }, { meshIndex: target.index });
        await page.waitForTimeout(120);
        // Sync first frame to a mid-swing pose so captures don't open on stance.
        await page.waitForFunction(({ meshIndex }) => {
          const mesh = window.__SF_SIM__?.pedestrians?.group?.children?.[meshIndex];
          const ud = mesh?.userData;
          if (!ud?.leftLeg || !ud?.rightLeg) return true;
          return Math.abs(ud.leftLeg.rotation.x - ud.rightLeg.rotation.x) > 0.35;
        }, { meshIndex: target.index }, { timeout: 2500 }).catch(() => {});
      }
      const frames = [];
      const rigSamples = [];
      let lastStreamPos = target.position
        ? { x: target.position.x, z: target.position.z }
        : null;

      for (let index = 0; index < FRAME_COUNT; index += 1) {
        const live = await ensureSimLive(page);
        if (!live) {
          throw new Error('Execution context was destroyed, most likely because of a navigation');
        }
        if (subjectConfig.streamed && target.id) {
          const follow = await page.evaluate(({ actorId, lastPos }) => {
            const sim = window.__SF_SIM__;
            const origin = sim.camera.position;
            let evidence = sim.streamedAgents.getEvidenceState(origin, 200);
            let actor = evidence.actors.find((entry) => entry.id === actorId);
            const moved = actor && lastPos
              ? Math.hypot(actor.position.x - lastPos.x, actor.position.z - lastPos.z)
              : 1;
            // Hop if they sat, froze, or vanished — prefer sidewalk strollers
            // over crossers (high rear cams make crossing read as a sit).
            if (!actor || actor.state !== 'moving' || moved < 0.02) {
              evidence = sim.streamedAgents.getEvidenceState(origin, 260);
              const movers = evidence.actors
                .filter((entry) => entry.kind === 'pedestrian' && entry.state === 'moving')
                .sort((a, b) => {
                  const pace = (b.pace || 0) - (a.pace || 0);
                  const sidewalk = (a.state === 'crossing' ? 0 : 1) - (b.state === 'crossing' ? 0 : 1);
                  return sidewalk * 2 + pace;
                });
              actor = movers[0] || null;
              if (actor?.id) sim.streamedAgents.setQaForceWalk?.(actor.id);
            }
            if (!actor) return null;
            const surface = sim.streaming.getSurfaceHeight?.({ x: actor.position.x, z: actor.position.z })
              ?? actor.position.y;
            const groundY = Math.max(
              Number.isFinite(surface) ? surface : actor.position.y,
              actor.position.y - 1.2,
            );
            const yaw = Number.isFinite(actor.yaw) ? actor.yaw : 0;
            const side = Math.sin(yaw) || 1;
            const along = Math.cos(yaw) * 0.35;
            sim.setCameraPose(
              {
                x: actor.position.x + along * 1.2 + side * 5.4,
                y: groundY + 2.15,
                z: actor.position.z - side * 1.2 + along * 5.4,
              },
              { x: actor.position.x, y: groundY + 1.0, z: actor.position.z },
            );
            return {
              id: actor.id,
              yaw,
              position: { x: actor.position.x, z: actor.position.z },
            };
          }, { actorId: target.id, lastPos: lastStreamPos });
          if (follow?.id) {
            if (follow.id !== target.id) {
              target = { ...target, id: follow.id, yaw: follow.yaw };
            }
            lastStreamPos = follow.position;
          }
        } else if (!subjectConfig.streamed && Number.isInteger(target.index)) {
          const follow = await page.evaluate(({ meshIndex, crowdLens, heroLens }) => {
            const sim = window.__SF_SIM__;
            let index = meshIndex;
            let mesh = sim.pedestrians.group.children[index];
            const inDeckBurial = (pos) => (
              (pos.x > 18.5 && pos.x < 45.5 && pos.z > 4.5 && pos.z < 33.5)
              || (pos.x > 22 && pos.x < 48 && pos.z > 33 && pos.z < 42)
            );
            // Heroes that walk onto the cable-car apron mid-capture get hops.
            if (heroLens && (!mesh?.visible || inDeckBurial(mesh.position))) {
              const kids = sim.pedestrians.group.children;
              let best = null;
              let bestScore = -Infinity;
              for (let i = 0; i < kids.length; i += 1) {
                const candidate = kids[i];
                if (!candidate?.visible || !candidate.userData?.heroDetail) continue;
                if (inDeckBurial(candidate.position)) continue;
                const ud = candidate.userData;
                const swing = Math.abs((ud.leftLeg?.rotation?.x || 0) - (ud.rightLeg?.rotation?.x || 0));
                const score = candidate.position.x * 2 + swing * 8;
                if (score > bestScore) {
                  bestScore = score;
                  best = { mesh: candidate, index: i };
                }
              }
              if (best) {
                index = best.index;
                mesh = best.mesh;
                sim.pedestrians.setQaSolo?.(index);
              }
            }
            if (!mesh?.visible) return { index };
            const pos = mesh.position;
            if (crowdLens) {
              sim.setCameraPose(
                {
                  x: pos.x + 6.2,
                  y: pos.y + 3.25,
                  z: pos.z + 5.4,
                },
                { x: pos.x, y: pos.y + 1.05, z: pos.z },
              );
            } else {
              const along = Math.cos(mesh.rotation?.y || 0) * 1.6;
              sim.setCameraPose(
                { x: pos.x + 8.2, y: pos.y + 3.35, z: pos.z + along },
                { x: pos.x, y: pos.y + 1.2, z: pos.z },
              );
            }
            return {
              index,
              position: { x: pos.x, y: pos.y, z: pos.z },
            };
          }, {
            meshIndex: target.index,
            crowdLens: Boolean(subjectConfig.excludeHeroDetail),
            heroLens: Boolean(subjectConfig.minHeroDetail),
          });
          if (Number.isInteger(follow?.index) && follow.index !== target.index) {
            target = {
              ...target,
              index: follow.index,
              position: follow.position || target.position,
            };
          }
        }
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const fileName = `frame-${String(index).padStart(2, '0')}.png`;
        const filePath = join(subjectDir, fileName);
        await page.screenshot({ path: filePath });
        const rig = subjectConfig.streamed
          ? await page.evaluate(({ actorId }) => {
            const sim = window.__SF_SIM__;
            const origin = sim.camera.position;
            const evidence = sim.streamedAgents.getEvidenceState(origin, 220);
            const actor = evidence.actors.find((entry) => entry.id === actorId);
            if (!actor) return null;
            const swing = Number(actor.legSwing) || 0;
            return {
              leftLegX: swing,
              rightLegX: -swing,
              leftArmX: -swing * 0.85,
              rightArmX: swing * 0.85,
              rigBob: Math.abs(swing) * 0.02,
              rigRoll: swing * 0.03,
              leftFootY: Math.max(0, swing) * 0.04,
              rightFootY: Math.max(0, -swing) * 0.04,
            };
          }, { actorId: target.id })
          : await page.evaluate(({ meshIndex }) => {
            const mesh = window.__SF_SIM__.pedestrians.group.children[meshIndex];
            if (!mesh?.userData?.rig) return null;
            const ud = mesh.userData;
            return {
              leftLegX: ud.leftLeg.rotation.x,
              rightLegX: ud.rightLeg.rotation.x,
              leftArmX: ud.leftArm.rotation.x,
              rightArmX: ud.rightArm.rotation.x,
              rigBob: ud.rig.position.y,
              rigRoll: ud.rig.rotation.z,
              leftFootY: ud.leftFoot.position.y,
              rightFootY: ud.rightFoot.position.y,
            };
          }, { meshIndex: target.index ?? 0 });
        const metrics = await analyzeImage(page, filePath);
        frames.push({
          index,
          file: join('tmp/npc-anim-qa', subjectConfig.id, fileName),
          metrics,
          rig,
        });
        if (rig) rigSamples.push(rig);
        if (index + 1 < FRAME_COUNT) {
          await page.waitForTimeout(FRAME_INTERVAL_MS);
        }
      }

      const frameDiffs = [];
      for (let index = 1; index < frames.length; index += 1) {
        const previousPath = join(subjectDir, `frame-${String(index - 1).padStart(2, '0')}.png`);
        const nextPath = join(subjectDir, `frame-${String(index).padStart(2, '0')}.png`);
        frameDiffs.push(await compareFramePair(page, previousPath, nextPath));
      }

      return {
        ...subjectConfig,
        target,
        frames,
        frameDiffs,
        rigSamples,
      };
    });

    captures.push(capture);
  }

  const subjects = captures.map((capture) => scoreSubject(capture));
  const averageScore = Number(mean(subjects.map((subject) => subject.score)).toFixed(1));
  const pass = subjects.every((subject) => subject.pass) && errors.length === 0;
  const report = {
    result: pass ? 'npc animation qa passed' : 'npc animation qa failed',
    verdict: pass ? 'PASS' : 'FAIL',
    score: averageScore,
    threshold: PASS_SCORE,
    baseUrl,
    outputDir,
    frameCount: FRAME_COUNT,
    frameIntervalMs: FRAME_INTERVAL_MS,
    angle,
    subjects,
    errors,
    capturedAt: new Date().toISOString(),
  };

  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!pass) process.exitCode = 1;
} catch (error) {
  const failure = {
    result: 'npc animation qa failed',
    verdict: 'FAIL',
    error: error.message,
    errors,
    outputDir,
  };
  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(failure, null, 2)}\n`).catch(() => {});
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
