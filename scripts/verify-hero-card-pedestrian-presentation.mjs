import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const outputDir = process.env.SF_HERO_CARD_PEDESTRIAN_DIR || '.qa-hero-card-pedestrian-presentation';
const viewport = { width: 1440, height: 810 };
const cards = [
  { id: '01-commercial-street-day', x: 2173, z: 1831.4, yaw: 0.8008 },
  { id: '02-intersection-crosswalk', x: 2238, z: 1835, yaw: 2.28 },
];
const errors = [];
const card02ExpectedSources = Object.freeze([
  Object.freeze({
    id: 'ambient:669627682-s1:native:10', initialS: 12.8,
    initialPosition: Object.freeze({ x: 2256.0885, y: 0, z: 1834.1401 }),
  }),
  Object.freeze({
    id: 'ambient:669627682-s1:native:11', initialS: 15.4,
    initialPosition: Object.freeze({ x: 2254.5018, y: 0, z: 1836.1998 }),
  }),
  Object.freeze({
    id: 'ambient:669627682-s1:native:12', initialS: 18,
    initialPosition: Object.freeze({ x: 2252.9151, y: 0, z: 1838.2595 }),
  }),
]);

function card02Sources(cohort) {
  return cohort.members
    .filter(({ id }) => /669627682-s1:native:(10|11|12)$/.test(id))
    .sort((first, second) => first.id.localeCompare(second.id));
}

function card02SourceSnapshot(cohort) {
  return card02Sources(cohort).map(({
    id, pathId, sourceRoadId, sourceHighway, sourceSurface, nativePedestrianPath,
    lateralOffsetM, reverse, withinSourceWalkwayEnvelope, initialS, initialPosition,
  }) => ({
    id, pathId, sourceRoadId, sourceHighway, sourceSurface, nativePedestrianPath,
    lateralOffsetM, reverse, withinSourceWalkwayEnvelope, initialS, initialPosition,
  }));
}

function assertCard01Strict({ staging, life }) {
  assert.equal(life.presentation.mode, 'plaza', 'Card01 must retain the original seven-person Ferry plaza presentation');
  assert.equal(staging.stagedCount, 7, 'Card01 must retain all seven staged source records');
  assert.equal(staging.sourceUuidUnique, true, 'Card01 staged source UUIDs must stay unique');
  assert.equal(staging.sourceIdentityUnique, true, 'Card01 staged source identities must stay unique');
  assert.equal(staging.sourceFootwayOnly, true, 'Card01 sources must remain exact OSM footways');
  assert.equal(staging.sourceWalkwaySurfaceClear, true, 'Card01 sources cannot use asphalt');
  assert.equal(staging.sourceWalkwayEnvelopeClear, true, 'Card01 sources must stay inside their source walkway envelopes');
  assert.equal(staging.buildingClear, true, 'Card01 sources cannot enter buildings');
  assert.equal(staging.activeLandRegionClear, true, 'Card01 sources cannot leave the active source land region');
  assert.equal(life.stats.detailedActors, 7, 'Card01 must retain seven detailed civilian rigs');
  assert.equal(life.stats.fallbackActors, 0, 'Card01 cannot add fallback silhouettes');
  const adults = staging.screenSpace.adults.filter(({ detailed, readable, fullyInside }) => detailed && readable && fullyInside);
  const inBand = adults.filter(({ screen }) => (
    screen.centerPx.x >= viewport.width * 0.25
    && screen.centerPx.x <= viewport.width * 0.85
    && screen.centerPx.y >= viewport.height * 0.4
    && screen.centerPx.y <= viewport.height * 0.88
  ));
  let sixClique = [];
  for (let mask = 0; mask < (1 << inBand.length); mask += 1) {
    const subset = inBand.filter((_, index) => mask & (1 << index));
    if (subset.length <= sixClique.length) continue;
    if (subset.every((first, index) => subset.slice(index + 1).every((second) => (
      Math.hypot(
        first.screen.centerPx.x - second.screen.centerPx.x,
        first.screen.centerPx.y - second.screen.centerPx.y,
      ) >= 100
    )))) sixClique = subset;
  }
  assert.ok(sixClique.length >= 6, `Card01 needs a six-person 100px clique; got ${sixClique.length}`);
  return { readableDetailedCount: adults.length, sixClique: sixClique.map(({ sourceIdentity }) => sourceIdentity) };
}

function assertCard02Strict({ staging, life, cohort }) {
  assert.equal(life.presentation.mode, 'card02', 'Card02 must select its bounded source cohort');
  assert.equal(life.stats.pedestriansAttached, 3, 'Card02 must attach only its three existing source identities');
  assert.equal(life.stats.detailedActors, 3, 'Card02 needs three detailed civilian rigs');
  assert.equal(life.stats.fallbackActors, 0, 'Card02 cannot use a fallback silhouette');
  const sourceRecords = card02Sources(cohort);
  assert.equal(sourceRecords.length, 3, 'Card02 must retain exactly slots 10–12');
  assert.deepEqual(card02SourceSnapshot(cohort), card02ExpectedSources.map(({ id, initialS, initialPosition }) => ({
    id,
    pathId: '669627682-s1:native',
    sourceRoadId: '669627682-s1',
    sourceHighway: 'footway',
    sourceSurface: 'concrete',
    nativePedestrianPath: true,
    lateralOffsetM: 0,
    reverse: false,
    withinSourceWalkwayEnvelope: true,
    initialS,
    initialPosition,
  })), 'Card02 must retain exact source path, surface, staging, and one-metre world launch positions');
  const adults = staging.screenSpace.adults;
  assert.equal(adults.length, 3, 'Card02 must expose all three selected civilians to the screen gate');
  assert.ok(adults.every(({ detailed, readable, fullyInside }) => detailed && readable && fullyInside),
    `Card02 civilians must all be detailed/readable/fully inside: ${JSON.stringify(adults)}`);
  const requiredIdentities = new Set(sourceRecords.map(({ id }) => id));
  assert.deepEqual(new Set(adults.map(({ sourceIdentity }) => sourceIdentity)), requiredIdentities,
    'Card02 renderer identities must exactly match slots 10–12');
  const pairMetrics = staging.screenSpace.pairMetrics;
  assert.equal(pairMetrics.length, 3, 'three Card02 actors require exactly three pair measurements');
  assert.ok(pairMetrics.every(({ passes, silhouetteGapPx, centerDistancePx, minCenterDistancePx }) => (
    passes && silhouetteGapPx >= 4 && centerDistancePx >= minCenterDistancePx
  )), `Card02 must pass unrounded >=4px silhouette and scale-aware center gaps: ${JSON.stringify(pairMetrics)}`);
  return { identities: adults.map(({ sourceIdentity }) => sourceIdentity), pairMetrics };
}

async function waitForReady(page) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getHeroCamera?.().active
      && window.__SF_REALMAP__?.getAmbientPedestrianCohort?.().count > 0
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  await page.waitForTimeout(700);
}

async function poseAndRead(page, pose, screenshotPath = null) {
  await page.evaluate((next) => window.__SF_REALMAP__.setPlayerPose(next), pose);
  await page.waitForTimeout(800);
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  return page.evaluate(() => ({
    staging: window.__SF_REALMAP__.getHeroPedestrianStaging(),
    life: window.__SF_REALMAP__.getHeroLifeLighting(),
    cohort: window.__SF_REALMAP__.getAmbientPedestrianCohort(),
    perf: window.__SF_REALMAP__.getPerf(),
  }));
}

async function signedMarginAt(page, pose) {
  return page.evaluate((next) => {
    window.__SF_REALMAP__.setPlayerPose(next);
    const presentation = window.__SF_REALMAP__.getHeroLifeLighting().presentation;
    return { pose: window.__SF_REALMAP__.getPlayerPosition(), presentation };
  }, pose);
}

async function poseForSignedMargin(page, targetMarginM, plazaAnchor, card02Anchor) {
  let lower = 0;
  let upper = 1;
  const pointAt = (t) => ({
    x: plazaAnchor.x + (card02Anchor.x - plazaAnchor.x) * t,
    z: plazaAnchor.z + (card02Anchor.z - plazaAnchor.z) * t,
    yaw: cards[1].yaw,
  });
  const start = await signedMarginAt(page, pointAt(lower));
  const end = await signedMarginAt(page, pointAt(upper));
  assert.ok(start.presentation.signedMarginM < targetMarginM && end.presentation.signedMarginM > targetMarginM,
    `source-anchor segment must bracket ${targetMarginM}m; got ${start.presentation.signedMarginM}..${end.presentation.signedMarginM}`);
  for (let index = 0; index < 30; index += 1) {
    const middle = (lower + upper) * 0.5;
    const sample = await signedMarginAt(page, pointAt(middle));
    if (sample.presentation.signedMarginM < targetMarginM) lower = middle;
    else upper = middle;
  }
  const result = await signedMarginAt(page, pointAt((lower + upper) * 0.5));
  assert.ok(Math.abs(result.presentation.signedMarginM - targetMarginM) < 0.001,
    `signed-margin probe drifted from ${targetMarginM}m: ${result.presentation.signedMarginM}`);
  return { ...result.pose, yaw: cards[1].yaw };
}

async function createSideBySide(beforePath, afterPath, outputPath) {
  const [before, after] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
  const sheetBrowser = await chromium.launch({ headless: true });
  try {
    const page = await sheetBrowser.newPage();
    const dataUrl = await page.evaluate(async ({ beforeBase64, afterBase64 }) => {
      const read = async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        return image;
      };
      const [beforeImage, afterImage] = await Promise.all([read(beforeBase64), read(afterBase64)]);
      const canvas = document.createElement('canvas');
      canvas.width = beforeImage.width + afterImage.width;
      canvas.height = Math.max(beforeImage.height, afterImage.height);
      const context = canvas.getContext('2d');
      context.fillStyle = '#081018';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(beforeImage, 0, 0);
      context.drawImage(afterImage, beforeImage.width, 0);
      context.fillStyle = 'rgba(8,16,24,0.85)';
      context.fillRect(0, 0, beforeImage.width, 44);
      context.fillRect(beforeImage.width, 0, afterImage.width, 44);
      context.fillStyle = '#f3eee5';
      context.font = '700 18px ui-sans-serif, system-ui, sans-serif';
      context.fillText('SIGNED MARGIN -4.1M — PLAZA COHORT', 16, 28);
      context.fillText('SIGNED MARGIN +4.1M — SOURCE-BOUND COHORT', beforeImage.width + 16, 28);
      return canvas.toDataURL('image/png');
    }, { beforeBase64: before.toString('base64'), afterBase64: after.toString('base64') });
    await writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await sheetBrowser.close();
  }
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await waitForReady(page);

  const card01 = await poseAndRead(page, cards[0], join(outputDir, 'card01.png'));
  const card01Result = assertCard01Strict(card01);
  const immutableAnchor = card02SourceSnapshot(card01.cohort);

  // Probe the signed margin between immutable source launch anchors, not a
  // camera-card radius.  The source segment is used solely to solve precise
  // ±3.9m/±4.1m QA positions; runtime selection only sees live player travel.
  const sourceAnchors = card01.life.presentation;
  const probePage = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await waitForReady(probePage);
  const marginPoses = {
    negativeOuter: await poseForSignedMargin(probePage, -4.1, sourceAnchors.plazaAnchor, sourceAnchors.card02Anchor),
    negativeInner: await poseForSignedMargin(probePage, -3.9, sourceAnchors.plazaAnchor, sourceAnchors.card02Anchor),
    positiveInner: await poseForSignedMargin(probePage, 3.9, sourceAnchors.plazaAnchor, sourceAnchors.card02Anchor),
    positiveOuter: await poseForSignedMargin(probePage, 4.1, sourceAnchors.plazaAnchor, sourceAnchors.card02Anchor),
  };
  await probePage.close();
  await waitForReady(page);
  const outside = await poseAndRead(page, marginPoses.negativeOuter, join(outputDir, 'card02-signed-margin-negative-4_1m.png'));
  assert.equal(outside.life.presentation.mode, 'plaza', '-4.1m signed margin must retain the plaza cohort');
  assert.equal(outside.life.presentation.switches.length, 0, 'initial -4.1m margin must not create a churn switch');
  const negativeInner = await poseAndRead(page, marginPoses.negativeInner);
  assert.equal(negativeInner.life.presentation.mode, 'plaza', '-3.9m margin must hold the plaza cohort');
  assert.equal(negativeInner.life.presentation.switches.length, 0, 'holding inside the negative band must not churn');
  const positiveInner = await poseAndRead(page, marginPoses.positiveInner);
  assert.equal(positiveInner.life.presentation.mode, 'plaza', '+3.9m margin must still hold the plaza cohort');
  assert.equal(positiveInner.life.presentation.switches.length, 0, 'holding inside the positive band must not churn');
  const inside = await poseAndRead(page, marginPoses.positiveOuter, join(outputDir, 'card02-signed-margin-positive-4_1m.png'));
  assert.equal(inside.life.presentation.mode, 'card02', '+4.1m signed margin must enter the intersection cohort');
  assert.equal(inside.life.presentation.switches.length, 1, '+4.1m entry must switch exactly once');
  assert.deepEqual(inside.life.presentation.switches[0].from, 'plaza');
  assert.deepEqual(inside.life.presentation.switches[0].to, 'card02');
  const positiveHold = await poseAndRead(page, marginPoses.positiveInner);
  assert.equal(positiveHold.life.presentation.switches.length, 1, 'post-entry +3.9m hold must not churn');
  const negativeHold = await poseAndRead(page, marginPoses.negativeInner);
  assert.equal(negativeHold.life.presentation.switches.length, 1, 'pre-exit -3.9m hold must not churn');
  const exited = await poseAndRead(page, marginPoses.negativeOuter);
  assert.equal(exited.life.presentation.mode, 'plaza', '-4.1m signed margin must exit the intersection cohort');
  assert.equal(exited.life.presentation.switches.length, 2, '-4.1m exit must switch exactly once');
  assert.deepEqual(exited.life.presentation.switches[1].from, 'card02');
  assert.deepEqual(exited.life.presentation.switches[1].to, 'plaza');
  const outsideSecondHold = await poseAndRead(page, marginPoses.negativeOuter);
  assert.equal(outsideSecondHold.life.presentation.switches.length, 2, 'post-exit -4.1m hold must not churn the cohort');

  const card02 = await poseAndRead(page, cards[1], join(outputDir, 'card02.png'));
  const card02Result = assertCard02Strict(card02);
  const anchorAfter = card02SourceSnapshot(card02.cohort);
  assert.deepEqual(anchorAfter, immutableAnchor, 'Card02 selection must not mutate its immutable source anchor snapshot');
  const freshPage = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  freshPage.on('pageerror', (error) => errors.push(error.message));
  freshPage.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await waitForReady(freshPage);
  const freshCard02 = await poseAndRead(freshPage, cards[1]);
  const freshAnchor = card02SourceSnapshot(freshCard02.cohort);
  assert.deepEqual(freshAnchor, immutableAnchor,
    'two fresh browser loads must retain exact Card02 identities, path/source, initial s, and metric launch positions');
  await freshPage.close();
  assert.ok(card01.perf.fps >= 60 && card02.perf.fps >= 60, 'locked cards must sustain >=60 FPS');
  assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);

  const sheetPath = join(outputDir, 'card02-signed-margin-side-by-side.png');
  await createSideBySide(join(outputDir, 'card02-signed-margin-negative-4_1m.png'), join(outputDir, 'card02-signed-margin-positive-4_1m.png'), sheetPath);
  const report = {
    result: 'verified', url, viewport, cards, card01: card01Result, card02: card02Result,
    immutableAnchor, twoFreshBrowserSourceSnapshot: freshAnchor,
    hysteresis: {
      sourceAnchors: {
        plaza: sourceAnchors.plazaAnchor,
        card02: sourceAnchors.card02Anchor,
      },
      marginM: card02.life.presentation.marginM,
      probePoses: marginPoses,
      samples: {
        negativeOuter: outside.life.presentation, negativeInner: negativeInner.life.presentation,
        positiveInner: positiveInner.life.presentation, positiveOuter: inside.life.presentation,
        positiveHold: positiveHold.life.presentation, negativeHold: negativeHold.life.presentation,
        exited: exited.life.presentation, negativeOuterHold: outsideSecondHold.life.presentation,
      },
    },
    fps: { card01: card01.perf.fps, card02: card02.perf.fps },
    screenshots: { card01: join(outputDir, 'card01.png'), card02: join(outputDir, 'card02.png'), boundarySideBySide: sheetPath },
    errors,
  };
  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
