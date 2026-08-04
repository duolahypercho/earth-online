import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Harsh gate: frames must be rich, varied, colorful, and structurally sound;
// metadata must prove one-way streets, signals, and building data exist.
const frames = [
  { file: '.qa-citygen-hero.png', name: 'hero', minEdge: 0.12, minSat: 30 },
  { file: '.qa-citygen-street.png', name: 'street', minEdge: 0.09, minSat: 38 },
  { file: '.qa-citygen-aerial.png', name: 'aerial', minEdge: 0.2, minSat: 32 },
  { file: '.qa-citygen-night.png', name: 'night', minEdge: 0.05, minSat: 35 },
];

const critic = {
  result: 'PASS',
  score: 0,
  maxScore: 0,
  frames: [],
  metadata: null,
  blockers: [],
  notes: [],
};

try {
  const results = JSON.parse(await readFile('.qa-citygen-results.json', 'utf8'));
  critic.metadata = results.state;
  const checks = [
    ['buildings >= 150', (results.state?.buildings || 0) >= 150],
    ['blocks >= 40', (results.state?.blocks || 0) >= 40],
    ['streets >= 12', (results.state?.streets || 0) >= 12],
    ['signals >= 5', (results.state?.signals || 0) >= 5],
    ['one-way metadata present', (results.state?.oneWayStreets || 0) > 0],
    ['street metadata has oneway/lanes/sidewalk', Boolean(results.state?.streetMeta?.oneway && results.state?.streetMeta?.lanes && results.state?.streetMeta?.sidewalkW)],
    ['signal metadata has phase/streets', Boolean(results.state?.signalMeta?.period && results.state?.signalMeta?.streetIds?.length >= 2)],
    ['no fatal page errors', !(results.errors || []).some((error) => error.includes('Uncaught') || error.includes('TypeError') || error.includes('ReferenceError'))],
  ];
  for (const [label, pass] of checks) {
    critic.maxScore += 1;
    if (pass) critic.score += 1;
    else {
      critic.blockers.push(label);
      critic.notes.push(`FAIL ${label}`);
    }
  }

  for (const frame of frames) {
    const metrics = results.frames?.[frame.file] || {};
    const row = { name: frame.name, file: frame.file, ...metrics, passes: 0, checks: 0 };
    const values = [
      ['non-blank', (metrics.nonBlankRatio || 0) >= 0.98, `${((metrics.nonBlankRatio || 0) * 100).toFixed(1)}%`],
      ['exposure', (metrics.meanLuma || 0) > 60 && (metrics.meanLuma || 0) < 230, `${Math.round(metrics.meanLuma || 0)} luma`],
      ['color', (metrics.meanSaturation || 0) >= frame.minSat, `${Math.round(metrics.meanSaturation || 0)} sat`],
      ['structure', (metrics.edgeDensity || 0) >= frame.minEdge, `${(metrics.edgeDensity || 0).toFixed(3)} edges`],
      ['variety', (metrics.saturatedHues || 0) >= 4, `${metrics.saturatedHues || 0} hues`],
    ];
    for (const [label, pass, detail] of values) {
      row.checks += 1;
      if (pass) row.passes += 1;
      else critic.notes.push(`${frame.name}/${label}: ${detail}`);
    }
    critic.maxScore += row.checks;
    critic.score += row.passes;
    critic.frames.push(row);
  }

  critic.score = Math.round((critic.score / critic.maxScore) * 1000) / 10;
  if (critic.blockers.length || critic.score < 82) {
    critic.result = 'FAIL';
  }

  const criticOut = {
    result: critic.result,
    score: critic.score,
    frames: critic.frames.map(({ name, passes, checks, nonBlankRatio, meanLuma, meanSaturation, edgeDensity, saturatedHues }) => ({
      name,
      passes: `${passes}/${checks}`,
      nonBlankRatio,
      meanLuma,
      meanSaturation,
      edgeDensity,
      saturatedHues,
    })),
    metadata: {
      buildings: critic.metadata?.buildings,
      blocks: critic.metadata?.blocks,
      streets: critic.metadata?.streets,
      oneWayStreets: critic.metadata?.oneWayStreets,
      signals: critic.metadata?.signals,
    },
    notes: critic.notes,
  };
  await writeFile('.qa-citygen-harsh.json', JSON.stringify(criticOut, null, 2));
  console.log(JSON.stringify(criticOut, null, 2));
  process.exitCode = critic.result === 'PASS' ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ result: 'CRITIC FAILED', error: error.message }, null, 2));
  process.exitCode = 2;
}
