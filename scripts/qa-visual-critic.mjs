import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Usage: node scripts/qa-visual-critic.mjs [frame.png ...]
const frames = process.argv.slice(2);
if (!frames.length) {
  console.error('usage: node scripts/qa-visual-critic.mjs [frame.png ...]');
  process.exit(2);
}
const qaPrefix = process.env.SF_QA_PREFIX ? `${process.env.SF_QA_PREFIX}-` : '';
const outPath = `.qa-${qaPrefix}visual-critic.json`;

const DAY_REF = 'public/data/reference-sf.jpg';
const NIGHT_REF = 'public/data/reference-sf-night.jpg';
const refForFrame = (frame) => (frame.includes('night') ? NIGHT_REF : DAY_REF);
const rows = [];

for (const frame of frames) {
  const ref = refForFrame(frame);
  const tmpPath = join('/tmp', `.qa-critic-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  const result = spawnSync(
    'python3',
    ['scripts/qa-visual-compare.py', '--ref', ref, '--out', tmpPath, frame, ref],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    rmSync(tmpPath, { force: true });
    console.error(`frame comparison failed for ${frame}`);
    process.exitCode = 1;
    continue;
  }
  const parsed = JSON.parse(readFileSync(tmpPath, 'utf8'));
  rmSync(tmpPath, { force: true });
  const compared = parsed.frames[0];
  rows.push({
    path: frame,
    metrics: compared.metrics,
    histogramIntersection: compared.histogramIntersection,
    labDistance: compared.labDistance,
    perceptualHashHamming: compared.perceptualHashHamming,
    reference: {
      path: ref,
      metrics: parsed.frames[1]?.metrics || null,
    },
  });
}

writeFileSync(outPath, JSON.stringify({ frames: rows }, null, 2));
console.log(`wrote ${outPath} (${rows.length} frames)`);
