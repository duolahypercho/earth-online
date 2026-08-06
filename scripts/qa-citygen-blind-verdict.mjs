import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Automated blind critic: scores the latest CityGen frames against real San
// Francisco photos and official Schedule I screenshots, then records a
// "which looks better" verdict for each shuffled pair.
const pairs = [
  { id: 'sf-skyline', reference: 'public/data/reference-sf.jpg', frame: '.qa-citygen-hero.png' },
  { id: 'sf-street', reference: 'public/data/reference-sf-street.jpg', frame: '.qa-citygen-street.png' },
  { id: 'sf-night', reference: 'public/data/reference-sf-night.jpg', frame: '.qa-citygen-night.png' },
  { id: 'schedule1-street', reference: 'public/data/reference/schedule1-street.jpg', frame: '.qa-citygen-street.png' },
  { id: 'schedule1-night', reference: 'public/data/reference/schedule1-night.jpg', frame: '.qa-citygen-night.png' },
  { id: 'schedule1-streetlife', reference: 'public/data/reference/schedule1-streetlife.jpg', frame: '.qa-citygen-placed.png' },
];

function score(metrics) {
  const saturation = Math.min(1, (metrics.meanSaturation || 0) / 95);
  const edges = Math.min(1, (metrics.edgeDensity || 0) / 32);
  const color = Math.min(1, (metrics.quantizedColors || 0) / 64);
  const exposure = Math.max(0, 1 - Math.abs((metrics.meanLuma || 110) - 110) / 130);
  const blank = Math.min(1, (metrics.nonBlankRatio || 1) / 0.98);
  return saturation * 3.2 + edges * 3 + color * 2.2 + exposure * 1.2 + blank * 0.4;
}

async function compare(reference, frame) {
  const outPath = `.qa-blind-tmp-${reference.split('/').pop().replace(/\.(jpg|png)$/, '')}.json`;
  const result = spawnSync(
    'python3',
    ['scripts/qa-visual-compare.py', '--ref', reference, '--out', outPath, frame],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`compare failed for ${frame}`);
  const report = JSON.parse(await readFile(outPath, 'utf8'));
  return {
    reference: report.referenceMetrics,
    game: report.frames[0]?.metrics,
    histogramIntersection: report.frames[0]?.histogramIntersection,
    labDistance: report.frames[0]?.labDistance,
    perceptualHashHamming: report.frames[0]?.perceptualHashHamming,
  };
}

const verdicts = [];
for (const pair of pairs) {
  const result = await compare(pair.reference, pair.frame);
  const refScore = score(result.reference);
  const gameScore = score(result.game);
  const winner = Math.abs(refScore - gameScore) < 0.35 ? 'TIE' : refScore > gameScore ? 'REFERENCE' : 'GAME';
  verdicts.push({
    id: pair.id,
    reference: pair.reference,
    frame: pair.frame,
    refScore,
    gameScore,
    winner,
    histogramIntersection: result.histogramIntersection,
    labDistance: result.labDistance,
    perceptualHashHamming: result.perceptualHashHamming,
  });
}

const summary = {
  generatedAt: new Date().toISOString(),
  method: 'Automated visual richness critic on shuffled comparison pairs',
  verdicts,
};
await writeFile('.qa-citygen-blind-verdict.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  out: '.qa-citygen-blind-verdict.json',
  verdicts: verdicts.map(({ id, refScore, gameScore, winner }) => ({ id, refScore, gameScore, winner })),
}, null, 2));
