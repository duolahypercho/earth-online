// Fixed-pose, source-bound staging audit for the Ferry civilian presentation.
// It verifies the deterministic OSM-footway staging correction without changing
// camera, walker paths, source transforms, or the staged source pool.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outputDir = resolve(process.env.SF_I36_CIVILIAN_STAGING_DIR || '.qa-i36-ferry-civilian-staging');
const preChangePath = resolve(process.env.SF_I36_CIVILIAN_PRECHANGE_PATH || '.qa-i36-ferry-civilian-staging/before-source-locked.png');
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const viewport = { width: 1440, height: 810 };
const poseSettleMs = 150;
const postSettleSampleMs = 900;
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
  // A projected center alone is not evidence of visible life. Only rendered,
  // fully-inside, readable adult rigs may satisfy the composition gate.
  const inHeroBand = adults.filter(({ detailed, readable, fullyInside, centerPx }) => (
    detailed && readable && fullyInside
    &&
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
  const separatedSubset = [];
  for (let mask = 1; mask < (1 << inHeroBand.length); mask += 1) {
    const subset = inHeroBand.filter((_, index) => mask & (1 << index));
    if (subset.length < separatedSubset.length) continue;
    const separated = subset.every((first, index) => subset.slice(index + 1).every((second) => (
      Math.hypot(first.centerPx.x - second.centerPx.x, first.centerPx.y - second.centerPx.y) >= 100
    )));
    if (separated && subset.length > separatedSubset.length) separatedSubset.splice(0, separatedSubset.length, ...subset);
  }
  return {
    adults,
    readableDetailedInHeroBandCount: inHeroBand.length,
    readableDetailedInHeroBandIdentities: inHeroBand.map(({ sourceIdentity }) => sourceIdentity),
    pairDistances,
    eligiblePairDistances: visiblePairs,
    visiblePairCount: visiblePairs.length,
    separatedVisiblePairCount,
    allVisiblePairsSeparated100Px: visiblePairs.length > 0 && separatedVisiblePairCount === visiblePairs.length,
    largestPairwiseSeparatedSubset: separatedSubset.map(({ sourceIdentity }) => sourceIdentity),
    hasSixPairwiseSeparatedActors: separatedSubset.length >= 6,
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
      context.fillText('PRE-CHANGE SOURCE-LOCKED', 20, 30);
      context.fillText('SOURCE-BOUND STAGED CORRECTION', left.width + 20, 30);
      return canvas.toDataURL('image/png');
    }, { beforeBase64: before.toString('base64'), afterBase64: after.toString('base64') });
    await writeFile(sheetPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await browser.close();
  }
}

await mkdir(outputDir, { recursive: true });
async function captureBoot({ screenshotPath = null } = {}) {
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
  await page.waitForTimeout(poseSettleMs);
  const arrival = await page.evaluate(() => ({
    life: window.__SF_REALMAP__.getHeroLifeLighting(),
    staging: window.__SF_REALMAP__.getHeroPedestrianStaging(),
    camera: window.__SF_REALMAP__.getHeroCamera(),
    perf: window.__SF_REALMAP__.getPerf(),
  }));
  await page.waitForTimeout(postSettleSampleMs);
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
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

  return { arrival, after, night, errors };
  } finally {
    await browser.close();
  }
}

const afterPath = resolve(outputDir, 'after-source-bound-staging.png');
const [firstBoot, secondBoot] = await Promise.all([
  captureBoot({ screenshotPath: afterPath }),
  captureBoot(),
]);
const sourceSignature = (staging) => staging.current.map((record) => ({
  sourceIdentity: record.sourceIdentity,
  sourceRoadId: record.sourceRoadId,
  sourceHighway: record.sourceHighway,
  nativePedestrianPath: record.nativePedestrianPath,
  lateralOffsetM: record.lateralOffsetM,
  reverse: record.reverse,
  initialPosition: record.initialPosition,
}));
const composition = compositionMetrics(firstBoot.after.staging.screenSpace);
const secondComposition = compositionMetrics(secondBoot.after.staging.screenSpace);
const sourceLocked = JSON.stringify(sourceSignature(firstBoot.after.staging))
  === JSON.stringify(sourceSignature(secondBoot.after.staging));
const allDetailed = firstBoot.after.life.stats.detailedActors === 7 && firstBoot.after.life.stats.fallbackActors === 0;
const landmarkPreserved = firstBoot.arrival.camera.active && firstBoot.after.camera.active
  && JSON.stringify(firstBoot.arrival.camera.frameOptions) === JSON.stringify(firstBoot.after.camera.frameOptions)
  && firstBoot.arrival.camera.fov === firstBoot.after.camera.fov;
const nightNotWorse = firstBoot.night.life.stats.detailedActors === 7
  && firstBoot.night.life.stats.fallbackActors === 0
  && firstBoot.night.life.stats.activePracticals === 6;
const movement = firstBoot.after.staging.current.map((record) => ({
  sourceIdentity: record.sourceIdentity,
  driftM: record.driftM,
}));
const normalMovement = movement.every(({ driftM }) => driftM >= 0.25 && driftM <= 2);
const stableComposition = composition.hasSixPairwiseSeparatedActors
  && secondComposition.hasSixPairwiseSeparatedActors
  && JSON.stringify(composition.largestPairwiseSeparatedSubset)
    === JSON.stringify(secondComposition.largestPairwiseSeparatedSubset);
const errors = [...firstBoot.errors, ...secondBoot.errors];
const result = allDetailed && sourceLocked && landmarkPreserved && nightNotWorse && normalMovement
  && composition.readableDetailedInHeroBandCount >= 6
  && stableComposition
  && !errors.length
  && firstBoot.after.perf.fps >= 60
  ? 'PASS'
  : 'REJECT';
const rejectionReasons = [];
if (!allDetailed) rejectionReasons.push('Ferry must retain seven detailed civilians and zero instanced fallbacks');
if (!sourceLocked) rejectionReasons.push('two fresh boots changed a source identity, OSM path envelope, or initial path pose');
if (composition.readableDetailedInHeroBandCount < 6) rejectionReasons.push(`only ${composition.readableDetailedInHeroBandCount}/7 readable detailed centers lie in x25–85%, y40–88%`);
if (!stableComposition) rejectionReasons.push(
  `no six-person pairwise >=100px subset exists (largest is ${composition.largestPairwiseSeparatedSubset.length})`,
);
if (!landmarkPreserved) rejectionReasons.push('hero camera/landmark framing changed');
if (!nightNotWorse) rejectionReasons.push('night detailed-civilian or practical-light continuity changed');
if (!normalMovement) rejectionReasons.push('staged civilians did not make normal 0.25–2m progress over the sampled interval');
if (firstBoot.after.perf.fps < 60) rejectionReasons.push(`FPS below 60 (${firstBoot.after.perf.fps})`);
if (errors.length) rejectionReasons.push(`runtime errors: ${errors.join('; ')}`);
const sheetPath = resolve(outputDir, 'fixed-pose-before-after-side-by-side.png');
let preChangeCaptured = true;
try {
  await sideBySide(preChangePath, afterPath, sheetPath);
} catch (error) {
  preChangeCaptured = false;
  rejectionReasons.push(`pre-change comparison unavailable: ${error.message}`);
}
const report = {
  verdict: preChangeCaptured && result === 'PASS' ? 'PASS' : 'REJECT',
  conclusion: result === 'PASS'
    ? 'Source-bound staging satisfies the fixed-pose Ferry composition gate.'
    : 'REJECT: source-bound staging fails the fixed-pose Ferry composition gate.',
  url,
  viewport,
  fixedPose,
  fixedPoseSampleAfterSetMs: poseSettleMs + postSettleSampleMs,
  allDetailed,
  sourceLocked,
  landmarkPreserved,
  nightNotWorse,
  normalMovement,
  movement,
  fps: firstBoot.after.perf.fps,
  avgFrameMs: firstBoot.after.perf.avgFrameMs,
  errors,
  composition,
  secondBootComposition: secondComposition,
  sourceEnvelope: firstBoot.after.staging.current.map((record) => ({
    sourceIdentity: record.sourceIdentity,
    sourceRoadId: record.sourceRoadId,
    sourceHighway: record.sourceHighway,
    nativePedestrianPath: record.nativePedestrianPath,
    lateralOffsetM: record.lateralOffsetM,
    withinSourceWalkwayEnvelope: record.withinSourceWalkwayEnvelope,
  })),
  deterministicBootSignature: sourceSignature(firstBoot.after.staging),
  screenshots: { preChangePath, afterPath, sheetPath },
  rejectionReasons,
};
await writeFile(resolve(outputDir, 'ferry-civilian-staging-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
