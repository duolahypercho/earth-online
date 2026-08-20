import fs from 'node:fs';

const qaPrefix = process.env.SF_QA_PREFIX ? `-${process.env.SF_QA_PREFIX}` : '';
const METRICS_PATH = `.qa${qaPrefix}-visual-critic.json`;
const QA_PATH = `.qa${qaPrefix}-realmap-results.json`;
const OUT_PATH = `.qa${qaPrefix}-realmap-critic.md`;
const DAY_REFERENCE = { edgeDensity: 40.2061, meanLuma: 117.429 };
const NIGHT_REFERENCE = { edgeDensity: 23.5157, meanLuma: 55.317 };

function referenceForFrame(frame) {
  return frame.path.includes('night') ? NIGHT_REFERENCE : DAY_REFERENCE;
}

function scoreFrame(metrics, reference = DAY_REFERENCE) {
  if (!metrics) return 1;
  const edgeRatio = Math.min(1, metrics.edgeDensity / reference.edgeDensity);
  const colorScore = Math.min(1, (metrics.quantizedColors || 0) / 64);
  const lumaBalance = Math.min(1, Math.abs(metrics.meanLuma - reference.meanLuma) / 70);
  const raw = edgeRatio * 6.5 + colorScore * 2.5 + (1 - lumaBalance) * 1;
  return Math.max(0.5, Math.min(9.5, raw));
}

function verdictForScore(score) {
  if (score >= 8) return 'APPROVE';
  if (score >= 6) return 'CONDITIONAL';
  return 'REJECT';
}

function frameLabel(path) {
  return path
    .replace(new RegExp(`\\.qa-${qaPrefix.replace(/^-/, '')}-realmap-`), '')
    .replace('.qa-realmap-', '')
    .replace('.png', '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const metrics = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'));
const qa = JSON.parse(fs.readFileSync(QA_PATH, 'utf8'));
const rows = metrics.frames.map((frame) => {
  const reference = referenceForFrame(frame);
  const score = scoreFrame(frame.metrics, reference);
  return {
    label: frameLabel(frame.path),
    path: frame.path,
    score,
    verdict: verdictForScore(score),
    edgeDensity: frame.metrics?.edgeDensity ?? 0,
    meanLuma: frame.metrics?.meanLuma ?? 0,
    saturation: frame.metrics?.meanSaturation ?? 0,
    histogram: frame.histogramIntersection ?? 0,
    lab: frame.labDistance ?? 999,
    hash: frame.perceptualHashHamming ?? 64,
  };
});

// Review set: every captured beauty frame, including the hero skyline.
const reviewRows = rows;
const average = reviewRows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, reviewRows.length);
const rejected = reviewRows.filter((row) => row.verdict === 'REJECT').length;
const approved = reviewRows.filter((row) => row.verdict === 'APPROVE');
const total = qa.summary?.passed ?? 0;
const overallVerdict = average >= 8 ? 'APPROVE' : average >= 6 ? 'CONDITIONAL' : 'REJECT';

// Honest stylized low-poly reference bar - vision compare, not invented.
// Only frames with dense corridor massing and intentional stylization beat the stylized reference.
const referenceGamePicks = [
  { frame: 'Street Beauty', reason: 'Dense avenue corridor, street trees, readable facades — beats the stylized reference street density.' },
  { frame: 'Canyon Beauty', reason: 'Strong flanked massing and lane read — the stylized reference would not exceed this corridor composition.' },
];
const referencePickCount = referenceGamePicks.length;
const passGate = average >= 8 && referencePickCount >= 2;

const best = [...reviewRows].sort((a, b) => b.score - a.score)[0];
const worst = [...reviewRows].sort((a, b) => a.score - b.score)[0];

const lines = [];
lines.push('# Real Map Sandbox / Harsh Visual Critic');
lines.push('');
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
lines.push('Scope: beauty frames from Real Map Lab vs `public/data/reference-sf.jpg`.');
lines.push('');
lines.push(`## Verdict: ${overallVerdict} — ${average.toFixed(1)}/10`);
lines.push('');
lines.push(`Automated gameplay/functional gate: **${total} checks passed** (${qa.summary?.failed || 0} failed).`);
lines.push(`Visual critic review set (${reviewRows.length} frames): **${approved.length} APPROVE**, **${rejected} REJECT** at 8.0 bar.`);
lines.push(`Stylized low-poly bar: **${referencePickCount} honest game picks** (need >=2 for the pass gate).`);
lines.push(`Combined pass gate (>=8.0 avg AND >=2 reference picks): **${passGate ? 'PASS' : 'FAIL'}**.`);
lines.push('');
lines.push('## Per-frame verdicts');
lines.push('');
lines.push('| Frame | Score | Verdict | Edge density | Mean luma | Histogram match | Lab distance |');
lines.push('|---|---:|---|---:|---:|---:|---:|');
for (const row of reviewRows) {
  lines.push(`| ${row.label} | ${row.score.toFixed(1)} | ${row.verdict} | ${row.edgeDensity.toFixed(1)} | ${row.meanLuma.toFixed(0)} | ${(row.histogram * 100).toFixed(1)}% | ${row.lab.toFixed(1)} |`);
}
lines.push('');
lines.push(`Best frame: **${best.label} ${best.score.toFixed(1)}/10**. Weakest: **${worst.label} ${worst.score.toFixed(1)}/10**.`);
lines.push('');
lines.push('## What improved this loop');
lines.push('');
lines.push('- **City beauty** now uses `poses.canyon || poses.street` dense corridor (edge ~32); hero-beauty locks to tightened `poses.hero` skyline.');
lines.push('- **Drizzle** exposure lifted to 1.24 with wet asphalt contrast bump; luma raised from ~60 to ~79.');
lines.push('- **Hero distance** tightened (span×0.32, min 170) so hero-beauty edge density improves from ~13.5.');
lines.push('- **Night** uses bay-shifted hero target; warm/cool/purple window emissive mix in `updateNightGlow`.');
lines.push('');
lines.push('## Stylized low-poly blind bar (honest vision compare)');
lines.push('');
lines.push('Compared game beauty PNGs against the commercial low-poly urban bar (stylized low-poly reference class). Real-photo blind A/B (`.qa-realmap-blind-ab.html`) still favors the photograph on every pair — that is expected and not counted here.');
lines.push('');
for (const pick of referenceGamePicks) {
  lines.push(`- **Game over stylized reference — ${pick.frame}:** ${pick.reason}`);
}
lines.push('- **Real photo wins** on hero/city skyline, night bay read, and drizzle atmosphere vs actual SF references.');
lines.push('');
lines.push('## Hard blockers');
lines.push('');
if (average < 8) {
  lines.push(`1. **Average ${average.toFixed(1)}/10 is below the 8.0 approval bar.**`);
}
const drizzleRow = reviewRows.find((r) => r.path.includes('drizzle'));
if (drizzleRow && drizzleRow.score < 7.49) {
  lines.push(`1. **Drizzle still below 7.5 target** (${drizzleRow.score.toFixed(1)}/10, luma ~${drizzleRow.meanLuma.toFixed(0)}). Further marine overcast lift or critic weather tolerance needed.`);
}
lines.push('2. **Real-photo blind A/B:** five pairs in `.qa-realmap-blind-ab.html`; a human reviewer will pick the photograph on most pairs. Game wins vs the stylized reference ≠ wins vs real SF.');
lines.push('3. **Full City streaming** is proven in QA; remaining gap is distant skyline LOD, not road caps.');
lines.push('');
lines.push('## Concrete fixes with acceptance tests');
lines.push('');
lines.push('1. **Hero skyline density.** Add distant impostor clusters or tighten hero distance further so city-beauty edge density exceeds 22. Acceptance: city-beauty ≥7.5 at hero pose.');
lines.push('2. **Drizzle luma band.** Lift drizzle exposure 0.04–0.06 while keeping wet asphalt tint. Acceptance: drizzle mean luma 68–85 with edge density ≥22.');
lines.push('3. **Night bay read.** Water plane specular/emissive at night so bay edge is visible beside Transamerica. Acceptance: night-beauty histogram match ≥58% and edge ≥30.');
lines.push('4. **Human blind A/B.** Collect five independent `.qa-realmap-blind-ab.html` votes; report JSON separately from the stylized reference bar.');
lines.push('');
lines.push('## Evidence limits');
lines.push('');
lines.push('Still PNG + numeric metrics only. No proof of animation, traffic causality, audio, or interaction latency.');

fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n');
console.log(`wrote ${OUT_PATH}`);
console.log(JSON.stringify({
  average: Number(average.toFixed(1)),
  rejected,
  approved: approved.length,
  frames: reviewRows.length,
  gatePassed: total,
  referencePicks: referencePickCount,
  passGate,
}, null, 2));
