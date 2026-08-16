import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

// Compares the latest CityGen frames against official Schedule I screenshots
// so the blind A/B page has a recorded metric companion, not just a visual one.
const pairs = [
  {
    id: 'street',
    ref: 'public/data/reference/schedule1-street.jpg',
    frames: ['.qa-citygen-street.png'],
  },
  {
    id: 'night',
    ref: 'public/data/reference/schedule1-night.jpg',
    frames: ['.qa-citygen-night.png'],
  },
  {
    id: 'streetlife',
    ref: 'public/data/reference/schedule1-streetlife.jpg',
    frames: ['.qa-citygen-placed.png'],
  },
  {
    id: 'real-sf-street',
    ref: 'public/data/reference/schedule1-streetlife.jpg',
    frames: ['.qa-citygen-sf.png'],
  },
];

const combined = {
  reference: 'Schedule I official screenshots (Steam)',
  pairs: [],
};

for (const pair of pairs) {
  const outPath = `.qa-citygen-schedule-${pair.id}.json`;
  const result = spawnSync(
    'python3',
    [
      'scripts/qa-visual-compare.py',
      '--ref',
      pair.ref,
      '--out',
      outPath,
      ...pair.frames,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  const report = JSON.parse(await readFile(outPath, 'utf8'));
  combined.pairs.push({
    id: pair.id,
    reference: report.reference,
    referenceMetrics: report.referenceMetrics,
    frames: report.frames,
  });
}

await writeFile('.qa-citygen-schedule-critic.json', JSON.stringify(combined, null, 2));
console.log(JSON.stringify({
  out: '.qa-citygen-schedule-critic.json',
  pairs: combined.pairs.map((pair) => ({
    id: pair.id,
    frames: pair.frames.map((frame) => ({
      path: frame.path,
      histogramIntersection: frame.histogramIntersection,
      labDistance: frame.labDistance,
      perceptualHashHamming: frame.perceptualHashHamming,
    })),
  })),
}, null, 2));
