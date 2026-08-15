import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baselineDir = process.env.SF_NIGHT_BASELINE_DIR || '.qa-night-foreground-i31-baseline';
const candidateDir = process.env.SF_NIGHT_CANDIDATE_DIR || '.qa-night-foreground-i31-candidate';
const outputDir = process.env.SF_NIGHT_AB_DIR || '.qa-night-foreground-i31-ab';

async function readReport(dir) {
  return JSON.parse(await readFile(join(dir, 'wardrobe-metrics.json'), 'utf8'));
}

function round(value, digits = 3) {
  return Number(Number(value).toFixed(digits));
}

function mapAdults(report) {
  return new Map(report.adultMetrics.map((adult) => [adult.sourceIdentity, adult]));
}

function metricDelta(candidate, baseline) {
  return {
    nightMeanLuma: round(candidate.aggregate.nightMeanLuma - baseline.aggregate.nightMeanLuma),
    nightShadowPixelRatio: round(
      candidate.aggregate.nightMeanShadowPixelRatio - baseline.aggregate.nightMeanShadowPixelRatio,
      4,
    ),
    nightMeanLocalBackgroundContrast: round(
      candidate.aggregate.nightMeanLocalBackgroundContrast
      - baseline.aggregate.nightMeanLocalBackgroundContrast,
    ),
    dayMeanLuma: round(candidate.aggregate.dayMeanLuma - baseline.aggregate.dayMeanLuma),
    dayMeanLocalBackgroundContrast: round(
      candidate.aggregate.dayMeanLocalBackgroundContrast
      - baseline.aggregate.dayMeanLocalBackgroundContrast,
    ),
  };
}

async function writeContactSheet(baselinePath, candidatePath, outputPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const [baselineBytes, candidateBytes] = await Promise.all([
      readFile(baselinePath),
      readFile(candidatePath),
    ]);
    const sheet = await page.evaluate(async ({ baselineUrl, candidateUrl }) => {
      const load = async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
      };
      const [baseline, candidate] = await Promise.all([load(baselineUrl), load(candidateUrl)]);
      if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
        throw new Error('baseline/candidate screenshot dimensions differ');
      }
      const canvas = document.createElement('canvas');
      canvas.width = baseline.width * 2;
      canvas.height = baseline.height;
      const context = canvas.getContext('2d');
      context.drawImage(baseline, 0, 0);
      context.drawImage(candidate, baseline.width, 0);
      context.fillStyle = 'rgba(0, 0, 0, 0.68)';
      context.fillRect(24, 24, 194, 40);
      context.fillRect(baseline.width + 24, 24, 194, 40);
      context.fillStyle = '#ffffff';
      context.font = '700 24px sans-serif';
      context.fillText('BASELINE', 42, 52);
      context.fillText('CANDIDATE', baseline.width + 42, 52);
      return canvas.toDataURL('image/png');
    }, {
      baselineUrl: `data:image/png;base64,${baselineBytes.toString('base64')}`,
      candidateUrl: `data:image/png;base64,${candidateBytes.toString('base64')}`,
    });
    await writeFile(outputPath, Buffer.from(sheet.split(',')[1], 'base64'));
    await page.close();
  } finally {
    await browser.close();
  }
}

const baseline = await readReport(baselineDir);
const candidate = await readReport(candidateDir);
assert.equal(baseline.result, 'passed', 'baseline QA must have passed');
assert.equal(candidate.result, 'passed', 'candidate QA must have passed');
assert.deepEqual(candidate.pose, baseline.pose, 'baseline/candidate pose must match exactly');
assert.deepEqual(candidate.viewport, baseline.viewport, 'baseline/candidate viewport must match exactly');
assert.deepEqual(candidate.outputPixels, baseline.outputPixels, 'baseline/candidate pixel dimensions must match');
assert.equal(candidate.cameraDeltaM, 0, 'candidate day/night camera must remain fixed');
assert.equal(baseline.cameraDeltaM, 0, 'baseline day/night camera must remain fixed');

const baselineAdults = mapAdults(baseline);
const candidateAdults = mapAdults(candidate);
const matchedIdentities = [...baselineAdults.keys()].filter((identity) => candidateAdults.has(identity));
assert.ok(matchedIdentities.length >= 3, 'A/B requires at least three matched adults');
const perActor = matchedIdentities.map((sourceIdentity) => {
  const before = baselineAdults.get(sourceIdentity);
  const after = candidateAdults.get(sourceIdentity);
  const cropEdges = ['x0', 'x1', 'y0', 'y1'];
  return {
    sourceIdentity,
    nightMeanLumaDelta: round(after.night.meanLuma - before.night.meanLuma),
    nightShadowPixelRatioDelta: round(after.night.shadowPixelRatio - before.night.shadowPixelRatio, 4),
    nightLocalBackgroundContrastBefore: before.night.localBackgroundContrast,
    nightLocalBackgroundContrastAfter: after.night.localBackgroundContrast,
    nightLocalBackgroundContrastDelta: round(
      after.night.localBackgroundContrast - before.night.localBackgroundContrast,
    ),
    dayMeanLumaDelta: round(after.day.meanLuma - before.day.meanLuma),
    dayLocalBackgroundContrastDelta: round(
      after.day.localBackgroundContrast - before.day.localBackgroundContrast,
    ),
    nightCropMaxDeltaPx: Math.max(
      ...cropEdges.map((edge) => Math.abs(after.night.crop[edge] - before.night.crop[edge])),
    ),
  };
});

const aggregateDelta = metricDelta(candidate, baseline);
const rejectionReasons = [];
if (aggregateDelta.nightMeanLuma < 8) rejectionReasons.push('night mean torso luma gain < 8');
if (aggregateDelta.nightShadowPixelRatio > -0.12) rejectionReasons.push('night near-black ratio reduction < 0.12');
if (aggregateDelta.nightMeanLocalBackgroundContrast < 2) rejectionReasons.push('aggregate local-background contrast gain < 2 luma');
if (Math.abs(aggregateDelta.dayMeanLuma) > 2) rejectionReasons.push('day mean torso luma changed by > 2');
if (Math.abs(aggregateDelta.dayMeanLocalBackgroundContrast) > 4) rejectionReasons.push('day local-background contrast changed by > 4 luma');
for (const actor of perActor) {
  if (actor.nightCropMaxDeltaPx > 5) {
    rejectionReasons.push(`${actor.sourceIdentity} night crop moved by > 5 px`);
  }
  if (actor.nightLocalBackgroundContrastDelta < 0.75) {
    rejectionReasons.push(`${actor.sourceIdentity} local-background contrast gain < 0.75 luma`);
  }
  if (Math.abs(actor.dayMeanLumaDelta) > 4) {
    rejectionReasons.push(`${actor.sourceIdentity} day torso luma changed by > 4`);
  }
  if (Math.abs(actor.dayLocalBackgroundContrastDelta) > 5) {
    rejectionReasons.push(`${actor.sourceIdentity} day local-background contrast changed by > 5 luma`);
  }
}
for (const [label, report] of [['baseline', baseline], ['candidate', candidate]]) {
  for (const frame of [report.day, report.night]) {
    const stats = frame.life?.stats;
    if (stats?.detailedActors !== 7) rejectionReasons.push(`${label}/${frame.life?.conditions?.timeOfDay} detailed actor count changed`);
    if (stats?.fallbackActors !== 0) rejectionReasons.push(`${label}/${frame.life?.conditions?.timeOfDay} fallback actor count changed`);
    if (stats?.drawCalls !== 10) rejectionReasons.push(`${label}/${frame.life?.conditions?.timeOfDay} draw budget changed`);
    if (stats?.materials !== 8) rejectionReasons.push(`${label}/${frame.life?.conditions?.timeOfDay} material budget changed`);
    if ((stats?.pointLights ?? Infinity) > 6) rejectionReasons.push(`${label}/${frame.life?.conditions?.timeOfDay} point-light cap exceeded`);
  }
}

await mkdir(outputDir, { recursive: true });
const contactSheetPath = join(outputDir, 'night-foreground-baseline-candidate-sbs.png');
await writeContactSheet(
  join(baselineDir, 'night.png'),
  join(candidateDir, 'night.png'),
  contactSheetPath,
);
const report = {
  verdict: rejectionReasons.length ? 'REJECT' : 'PASS',
  baselineDir,
  candidateDir,
  pose: candidate.pose,
  matchedAdults: matchedIdentities.length,
  aggregateDelta,
  perActor,
  contactSheetPath,
  rejectionReasons,
};
await writeFile(join(outputDir, 'night-foreground-ab.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (rejectionReasons.length) process.exitCode = 1;
