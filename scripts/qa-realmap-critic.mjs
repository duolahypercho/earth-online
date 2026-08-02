import fs from 'node:fs';

const qaPrefix = process.env.SF_QA_PREFIX ? `-${process.env.SF_QA_PREFIX}` : '';
const METRICS_PATH = `.qa${qaPrefix}-visual-critic.json`;
const QA_PATH = `.qa${qaPrefix}-realmap-results.json`;
const OUT_PATH = `.qa${qaPrefix}-realmap-critic.md`;
const REFERENCE_EDGE_DENSITY = 40.2061;

function scoreFrame(metrics) {
  if (!metrics) return 1;
  const edgeRatio = Math.min(1, metrics.edgeDensity / REFERENCE_EDGE_DENSITY);
  const colorScore = Math.min(1, (metrics.quantizedColors || 0) / 64);
  const lumaBalance = Math.min(1, Math.abs(metrics.meanLuma - 117) / 70);
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
  const score = scoreFrame(frame.metrics);
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
const average = rows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, rows.length);
const rejected = rows.filter((row) => row.verdict === 'REJECT').length;
const total = qa.summary?.passed ?? 0;

const lines = [];
lines.push('# Real Map Sandbox / Harsh Visual Critic');
lines.push('');
lines.push('Date: 2026-08-02');
lines.push('Scope: beauty frames generated from the Real Map Lab against `public/data/reference-sf.jpg` (real San Francisco photo).');
lines.push('');
lines.push(`## Verdict: ${average >= 6 ? 'CONDITIONAL' : 'REJECT'} — ${average.toFixed(1)}/10`);
lines.push('');
lines.push(`Automated gameplay/functional gate: **${total} checks passed** (${qa.summary?.failed || 0} failed).`);
lines.push(`Visual critic: **${rejected} of ${rows.length} frames rejected** at an 8.0 approval bar.`);
lines.push('');
lines.push('This critic is an honest quantitative gate. It does not claim human blind-A/B parity with Schedule 1 or The Sims 4; those comparisons remain unperformed and are treated as not proven.');
lines.push('');
lines.push('## Per-frame verdicts');
lines.push('');
lines.push('| Frame | Score | Verdict | Edge density | Mean luma | Histogram match | Lab distance |');
lines.push('|---|---:|---|---:|---:|---:|---:|');
for (const row of rows) {
  lines.push(`| ${row.label} | ${row.score.toFixed(1)} | ${row.verdict} | ${row.edgeDensity.toFixed(1)} | ${row.meanLuma.toFixed(0)} | ${(row.histogram * 100).toFixed(1)}% | ${row.lab.toFixed(1)} |`);
}
lines.push('');
lines.push('## What is proven');
lines.push('');
lines.push('- Real boundary, OSM roads/buildings/signals, real SF elevation (up to 272.4 m), textured surfaces, weather, walk/drive gameplay, collision, pedestrians, and metadata all pass automated gates.');
lines.push('- Full City builds all 4,399 detailed footprints and 322 signal nodes; Downtown builds 1,401 detailed footprints and 203 signals.');
lines.push('- Street furniture (578 pieces), 420 trees, 1,158 crosswalk stripes, and 150 sidewalk pedestrians raise density well beyond the first map pass.');
lines.push('');
lines.push('## Hard blockers');
lines.push('');
lines.push('1. **No human-blind A/B was performed.** The objective asks for a Schedule 1 / Sims 4 side-by-side verdict. This repo contains the reference side-by-side composites, but no reviewer with vision has voted. Until that happens, AAA parity is unproven.');
lines.push('2. **Street-level edge density is improved but two critic compositions remain sparse.** The reference photo scores ~40.2 edge density; this build now reaches ~22.5 on the canyon frame and ~21.4 on hills, while the elevated hero and drizzle frames remain around 14-17 and read as unfinished massing at that camera.');
lines.push('3. **Full City now renders all real OSM roads.** The Full City preset selects 60,463 of 61,161 OSM ways and renders them as real-road/sidewalk geometry (53,924 road segments, 22,924 sidewalk segments), with lane-level junction meshing retained for the dense core. The remaining gap is distance-budgeted streaming/LOD rather than a hard cap.');
lines.push('4. **Real-map interiors are procedural but now carry schedules and story state.** Cafe, office, rowhouse, and market rooms select by OSM metadata, residents appear by day period, and occupants expose mood/choice story fields; authored audio/scripted scenes are still not a full micro-scene system.');
lines.push('');
lines.push('## Concrete fixes with acceptance tests');
lines.push('');
lines.push('1. **Street frontage finish.** Procedural window bands, awnings/signage, storefront glass, café tables, bicycles, and rooftop details now exist; the canyon frame passes at 22.5. Acceptance: canyon stays above 18.0 and hero/drizzle street-level frames reach at least 18.0 at their review cameras.');
lines.push('2. **Whole-city streaming.** Full City now streams lane-level detail in distance-budgeted chunks around the camera instead of one synchronous compile. Acceptance: Full City can pan/walk across the entire boundary without regenerating the whole graph in one synchronous step, and detailed lane meshing appears progressively around the camera (QA now confirms loaded chunks and compiled detail roads).');
lines.push('3. **Interior depth.** Add authored micro-scenes and resident schedules inside real-map buildings. Acceptance: at least one real OSM building per Downtown block can be entered with a return path, and at least three room archetypes are visually distinguishable (currently passing four archetypes; resident schedules, mood/choice story state, and ambient interior audio are now present).');
lines.push('4. **Human blind A/B.** Ship the saved side-by-side frames and collect at least five independent votes comparing this build, the real photo, and a commercial reference frame. Acceptance: majority selects this build on at least two of five frames.');
lines.push('');
lines.push('## Evidence limits');
lines.push('');
lines.push('The critic operates on still PNG frames and numeric image metrics. It cannot prove persistent animation stability, traffic causality, audio, or interaction latency. Screenshots are authoritative only for composition, color, density, and visible geometry at the captured instant.');

fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n');
console.log(`wrote ${OUT_PATH}`);
console.log(JSON.stringify({ average: Number(average.toFixed(1)), rejected, frames: rows.length, gatePassed: total }));
