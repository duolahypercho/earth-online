import { spawnSync } from 'node:child_process';

// Usage: node scripts/qa-visual-critic.mjs [frame.png ...]
const frames = process.argv.slice(2);
if (!frames.length) {
  console.error('usage: node scripts/qa-visual-critic.mjs [frame.png ...]');
  process.exit(2);
}
const qaPrefix = process.env.SF_QA_PREFIX ? `${process.env.SF_QA_PREFIX}-` : '';
const outPath = `.qa-${qaPrefix}visual-critic.json`;
const result = spawnSync(
  'python3',
  [
    'scripts/qa-visual-compare.py',
    '--ref',
    'public/data/reference-sf.jpg',
    '--out',
    outPath,
    ...frames,
  ],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
