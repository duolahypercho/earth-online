import { spawnSync } from 'node:child_process';

const frames = [
  '.qa-citygen-hero.png',
  '.qa-citygen-street.png',
  '.qa-citygen-aerial.png',
  '.qa-citygen-night.png',
  '.qa-citygen-sf-street.png',
  '.qa-citygen-sf-aerial.png',
];
const outPath = '.qa-citygen-critic.json';
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
