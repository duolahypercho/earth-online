// Fixed-pose, source-bound staging audit for the Ferry civilian presentation.
// This is deliberately evidence-only: it never mutates camera, walker paths,
// source transforms, or the staged source pool. A REJECT means selection alone
// cannot make the immutable source geometry satisfy the hero composition gate.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outputDir = resolve(process.env.SF_I36_CIVILIAN_STAGING_DIR || '.qa-i36-ferry-civilian-staging');
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const viewport = { width: 1440, height: 810 };
// This is the existing Ferry hero-card pose. It is a camera reset only; it
// leaves every staged person's source-owned progression untouched.
const fixedPose = Object.freeze({ x: 2173, z: 1831.4, yaw: 0.8008 });

const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

function screenAdult(adult) {
  const [ndcX, ndcY, ndcZ] = adult.ndc;
  return {
    sourceIdentity: adult.sourceIdentity,
    sourceUuid: adult.sourceUuid,
    detailed: adult.detailed,
    fullyInside: adult.fullyInside,
    readable: adult.readable,
    ndc: adult.ndc,
    centerPx: {
      x: round((ndcX + 1) * 0.5 * viewport.width, 1),
      y: round((1 - ndcY) * 0.5 * viewport.height, 1),
    },
    depth: ndcZ,
  };
}

function compositionMetrics(screenSpace) {
  const adults = screenSpace.adults.map(screenAdult);
  const inHeroBand = adults.filter(({ centerPx }) => (
    centerPx.x >= viewport.width * 0.25
    && centerPx.x <= viewport.width * 0.85
    && centerPx.y >= viewport.height * 0.4
    && centerPx.y <= viewport.height * 0.88
  ));
  const pairDistances = [];
  for (let index = 0; index < adults.length; index += 1) {
    for (let other = index + 1; other < adults.length; other += 1) {
      const first = adults[index];
      const second = adults[other];
      const distancePx = Math.hypot(
        first.centerPx.x - second.centerPx.x,
        first.centerPx.y - second.centerPx.y,
      );
      pairDistances.push({
        sourceIdentities: [first.sourceIdentity, second.sourceIdentity],
        distancePx: round(distancePx, 1),
        separated100Px: distancePx >= 100,
      });
    }
  }
  const visiblePairs = pairDistances.filter(({ sourceIdentities }) => sourceIdentities.every((identity) => (
    inHeroBand.some((adult) => adult.sourceIdentity === identity)
  )));
  const separatedVisiblePairCount = visiblePairs.filter(({ separated100Px }) => separated100Px).length;
  return {
    adults,
    inHeroBandCount: inHeroBand.length,
    inHeroBandIdentities: inHeroBand.map(({ sourceIdentity }) => sourceIdentity),
    pairDistances,
    visiblePairCount: visiblePairs.length,
    separatedVisiblePairCount,
    allVisiblePairsSeparated100Px: visiblePairs.length > 0 && separatedVisiblePairCount === visiblePairs.length,
    // Any six screen-space centers need all 15 pair comparisons to be at least
    // 100 px apart.  The count here exposes the immutable source constraint
    // without pretending an off-screen actor is part of the composition.
    hasSixPairwiseSeparatedActors: inHeroBand.length >= 6 && visiblePairs.length >= 15
      && separatedVisiblePairCount >= 15,
  };
}

async function sideBySide(beforePath, afterPath, sheetPath) {
  const [before, after] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate(async ({ beforeBase64, afterBase64 }) => {
      const load = async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        return image;
      };
      const [left, right] = await Promise.all([load(beforeBase64), load(afterBase64)]);
      const canvas = document.createElement('canvas');
      canvas.width = left.width * 2;
      canvas.height = left.height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#091017';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(left, 0, 0);
      context.drawImage(right, left.width, 0);
      context.fillStyle = 'rgba(9, 16, 23, 0.82)';
      context.fillRect(0, 0, left.width, 46);
      context.fillRect(left.width, 0, right.width, 46);
      context.fillStyle = '#f2efe8';
      context.font = '700 20px sans-serif';
      context.fillText('SOURCE-LOCKED BASELINE', 20, 30);
      context.fillText('SELECTION-ONLY CANDIDATE', left.width + 20, 30);
      return canvas.toDataURL('image/png');
    }, { beforeBase64: before.toString('base64'), afterBase64: after.toString('base64') });
    await writeFile(sheetPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await browser.close();
  }
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [];

try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getHeroLifeLighting?.()?.active
      && window.__SF_REALMAP__?.getHeroPedestrianStaging?.()?.screenSpace?.active
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  await page.evaluate((pose) => {
    const sim = window.__SF_REALMAP__;
    sim.setBeauty(true);
    sim.setWeather('clear');
    sim.setTimeOfDay('day');
    sim.setPlayerPose(pose);
  }, fixedPose);
  await page.waitForTimeout(900);

  const beforePath = resolve(outputDir, 'before-source-locked.png');
  // The candidate intentionally receives no source, path, camera, or actor
  // edit. Capturing the same fixed state makes the failed selection-only
  // proposition inspectable side-by-side rather than masking it with a move.
  await page.screenshot({ path: beforePath });
  const before = await page.evaluate(() => ({
    life: window.__SF_REALMAP__.getHeroLifeLighting(),
    staging: window.__SF_REALMAP__.getHeroPedestrianStaging(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
    perf: window.__SF_REALMAP__.getPerf(),
  }));
  const afterPath = resolve(outputDir, 'after-selection-only.png');
  await page.screenshot({ path: afterPath });
  const after = await page.evaluate(() => ({
    life: window.__SF_REALMAP__.getHeroLifeLighting(),
    staging: window.__SF_REALMAP__.getHeroPedestrianStaging(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
    perf: window.__SF_REALMAP__.getPerf(),
  }));
  await page.evaluate(() => window.__SF_REALMAP__.setTimeOfDay('night'));
  await page.waitForTimeout(300);
  const night = await page.evaluate(() => ({
    life: window.__SF_REALMAP__.getHeroLifeLighting(),
    perf: window.__SF_REALMAP__.getPerf(),
  }));

  const composition = compositionMetrics(after.staging.screenSpace);
  const beforeIds = before.staging.sourceIdentities;
  const afterIds = after.staging.sourceIdentities;
  const sourceLocked = JSON.stringify(beforeIds) === JSON.stringify(afterIds)
    && before.staging.current.every((record, index) => (
      record.sourceIdentity === after.staging.current[index]?.sourceIdentity
      && record.sourceRoadId === after.staging.current[index]?.sourceRoadId
      && record.nativePedestrianPath === after.staging.current[index]?.nativePedestrianPath
    ));
  const allDetailed = after.life.stats.detailedActors === 7 && after.life.stats.fallbackActors === 0;
  const landmarkPreserved = before.camera.active && after.camera.active
    && JSON.stringify(before.camera.frameOptions) === JSON.stringify(after.camera.frameOptions)
    && before.camera.fov === after.camera.fov;
  const nightNotWorse = night.life.stats.detailedActors === 7
    && night.life.stats.fallbackActors === 0
    && night.life.stats.activePracticals === 6;
  const result = allDetailed && sourceLocked && landmarkPreserved && nightNotWorse
    && composition.inHeroBandCount >= 5
    && composition.hasSixPairwiseSeparatedActors
    && !errors.length
    && after.perf.fps >= 60
    ? 'PASS'
    : 'REJECT';
  const rejectionReasons = [];
  if (!allDetailed) rejectionReasons.push('Ferry must retain seven detailed civilians and zero instanced fallbacks');
  if (!sourceLocked) rejectionReasons.push('selection changed a source identity or OSM path envelope');
  if (composition.inHeroBandCount < 5) rejectionReasons.push(`only ${composition.inHeroBandCount}/7 immutable source centers lie in x25–85%, y40–88%`);
  if (!composition.hasSixPairwiseSeparatedActors) rejectionReasons.push(
    `the immutable source pool cannot produce six pairwise >=100px-separated centers (${composition.separatedVisiblePairCount} qualifying visible pairs)`,
  );
  if (!landmarkPreserved) rejectionReasons.push('hero camera/landmark framing changed');
  if (!nightNotWorse) rejectionReasons.push('night detailed-civilian or practical-light continuity changed');
  if (after.perf.fps < 60) rejectionReasons.push(`FPS below 60 (${after.perf.fps})`);
  if (errors.length) rejectionReasons.push(`runtime errors: ${errors.join('; ')}`);
  const sheetPath = resolve(outputDir, 'fixed-pose-before-after-side-by-side.png');
  await sideBySide(beforePath, afterPath, sheetPath);
  const report = {
    verdict: result,
    conclusion: result === 'PASS'
      ? 'Selection-only staging satisfies the fixed-pose Ferry composition gate.'
      : 'REJECT: source-bound presentation selection cannot repair the fixed-pose geometry; moving or replacing a staged source would be required.',
    url,
    viewport,
    fixedPose,
    allDetailed,
    sourceLocked,
    landmarkPreserved,
    nightNotWorse,
    fps: after.perf.fps,
    avgFrameMs: after.perf.avgFrameMs,
    errors,
    composition,
    sourceEnvelope: after.staging.current.map((record) => ({
      sourceIdentity: record.sourceIdentity,
      sourceRoadId: record.sourceRoadId,
      sourceHighway: record.sourceHighway,
      nativePedestrianPath: record.nativePedestrianPath,
      lateralOffsetM: record.lateralOffsetM,
      withinSourceWalkwayEnvelope: record.withinSourceWalkwayEnvelope,
    })),
    screenshots: { beforePath, afterPath, sheetPath },
    rejectionReasons,
  };
  await writeFile(resolve(outputDir, 'ferry-civilian-staging-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
