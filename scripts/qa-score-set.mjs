/**
 * Score a captured frame set against the real SF reference.
 * Usage: node scripts/qa-score-set.mjs --shots <dir> [--out <json>]
 * Reuses scripts/qa-visual-compare.py metrics and the harsh-critic scoring.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const shotsDir = get('--shots', 'tmp/shots');
const outPath = get('--out', join(shotsDir, 'scores.json'));

const frames = readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort();
const refFor = (id) => {
  if (id.includes('street')) return 'public/data/reference-sf-street.jpg';
  if (id.includes('night')) return 'public/data/reference-sf-night.jpg';
  return 'public/data/reference-sf.jpg';
};

const results = [];
for (const frame of frames) {
  const path = join(shotsDir, frame);
  const raw = execFileSync('python3', [
    'scripts/qa-visual-compare.py', '--ref', refFor(frame), '--out', join(shotsDir, '.tmp-metrics.json'), path,
  ], { encoding: 'utf8' });
  const metrics = JSON.parse(readFileSync(join(shotsDir, '.tmp-metrics.json'), 'utf8'));
  results.push({ frame, ...metrics.frames[0] });
}

const REFERENCE_EDGE_DENSITY = 40.2061;
const scoreFrame = (m) => {
  if (!m) return 1;
  const edgeRatio = Math.min(1, m.edgeDensity / REFERENCE_EDGE_DENSITY);
  const colorScore = Math.min(1, (m.quantizedColors || 0) / 64);
  const lumaBalance = Math.min(1, Math.abs(m.meanLuma - 117) / 70);
  return Math.max(0.5, Math.min(9.5, edgeRatio * 6.5 + colorScore * 2.5 + (1 - lumaBalance) * 1));
};
const rows = results.map((r) => ({
  frame: r.frame,
  score: Number(scoreFrame(r.metrics).toFixed(2)),
  verdict: scoreFrame(r.metrics) >= 8 ? 'APPROVE' : scoreFrame(r.metrics) >= 6 ? 'CONDITIONAL' : 'REJECT',
  edgeDensity: r.metrics?.edgeDensity,
  meanLuma: r.metrics?.meanLuma,
  histogram: r.histogramIntersection,
  lab: r.labDistance,
}));
const average = rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length);
const report = { average: Number(average.toFixed(2)), rows };
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
