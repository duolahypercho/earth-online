// What a review-protocol round (2560x1440, eight cards) costs in wall clock.
//
// The orchestrator has to decide whether to spend it, and the only honest way
// to answer is from measurements this project already paid for. This reads
// every capture report on disk, pulls out the cost of each RENDERED frame with
// the resolution it was rendered at, and fits cost against fragment count.
//
// Three things it does NOT do, because they would make the number untrustworthy:
//   * it never counts a run's FIRST frame in the steady-state mean (the first
//     frame of a run costs 1.4-2.3x the rest and is paid once, not per card);
//   * it never mixes builds silently - each report is fitted and printed on its
//     own, and the cross-build fit is labelled as such;
//   * it never claims to be a measurement at 1440p. No card has been captured
//     at that size on this box.
//
//   node scripts/qa/estimate-protocol-round-v1.mjs
//   node scripts/qa/estimate-protocol-round-v1.mjs .qa-round5 .qa-throughput
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = { w: 2560, h: 1440 };
const PROTOCOL_MPX = (PROTOCOL.w * PROTOCOL.h) / 1e6;
// A full round: seven single-frame cards plus the traversal strip.
const SINGLE_CARDS = 7;
const TRAVERSAL_FRAMES = Number(process.env.SF_QA_TRAVERSAL_FRAMES || 4);

const roots = process.argv.slice(2);
async function reportPaths() {
  if (roots.length) return roots.map((r) => (r.endsWith('.json') ? r : path.join(r, 'capture-report.json')));
  const entries = await readdir('.', { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && e.name.startsWith('.qa-'))
    .map((e) => path.join(e.name, 'capture-report.json'));
}

const runs = [];
for (const file of await reportPaths()) {
  let report;
  try { report = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
  const w = report.viewport?.w;
  const h = report.viewport?.h;
  if (!w || !h) continue;
  const frames = [];
  for (const card of report.cards || []) {
    if (Array.isArray(card.sequence)) {
      for (const item of card.sequence) {
        if (!item.file) continue;
        frames.push({ id: `${card.id}/${item.index}`, ms: (item.render?.wallMs || 0) + (item.shotMs || 0) });
      }
    } else if (card.frameWallMs != null) {
      frames.push({ id: card.id, ms: card.frameWallMs + (card.shotMs || 0) });
    }
  }
  if (!frames.length) continue;
  const megapixels = (w * h) / 1e6;
  const steady = frames.slice(1);
  // What was actually RUNNING when these frames were timed. A cost measured on
  // a build whose shadow cascades and night practicals are switched off is a
  // lower bound for the build that has them on, and the estimate must say so
  // instead of quietly reporting the cheap number.
  const attribution = (report.cards || []).map((c) => c.frameCostAttribution).filter(Boolean);
  const features = {
    shadowCascades: report.runtime?.shadowTarget?.cascade?.count
      ?? (attribution.find((a) => a.shadowCascades != null)?.shadowCascades ?? null),
    shadowPassesPerFrame: attribution.find((a) => a.shadowPassesPerFrame != null)?.shadowPassesPerFrame ?? null,
    localLightsActive: attribution.length
      ? Math.max(...attribution.map((a) => a.localLightsActive ?? 0)) : null,
    ao: attribution.find((a) => a.ao)?.ao?.enabled ?? null,
    antialias: attribution.find((a) => a.antialias)?.antialias ?? null,
    sceneSamples: attribution.find((a) => a.sceneSamples != null)?.sceneSamples ?? null,
  };
  runs.push({
    file,
    w,
    h,
    megapixels,
    bootMs: report.bootMs ?? null,
    rebuildMs: (report.worldWindows || []).reduce((sum, x) => sum + (x.rebuildMs || 0), 0),
    coverageMs: (report.cards || []).reduce((sum, c) => sum + (c.coverage?.ms || 0), 0),
    keyOff: !!report.settings?.keyOff,
    frames,
    firstFrameMs: frames[0].ms,
    steadyFrames: steady.length,
    features,
    steadyMeanMs: steady.length ? steady.reduce((sum, f) => sum + f.ms, 0) / steady.length : null,
    warmupPremium: steady.length ? frames[0].ms / (steady.reduce((sum, f) => sum + f.ms, 0) / steady.length) : null,
  });
}
runs.sort((a, b) => a.megapixels - b.megapixels || a.file.localeCompare(b.file));

console.log('measured runs (steady-state excludes each run\'s first frame):');
for (const run of runs) {
  console.log(`  ${run.file.padEnd(42)} ${run.w}x${run.h} (${run.megapixels.toFixed(4)} Mpx) `
    + `first ${(run.firstFrameMs / 1000).toFixed(0)}s, steady mean `
    + `${run.steadyMeanMs != null ? (run.steadyMeanMs / 1000).toFixed(0) : '--'}s over ${run.steadyFrames} frame(s)`
    + (run.warmupPremium ? `, warm-up premium ${run.warmupPremium.toFixed(2)}x` : ''));
  if (run.features && (run.features.shadowCascades != null || run.features.localLightsActive != null)) {
    console.log(`      running: shadow cascades ${run.features.shadowCascades ?? '?'}, `
      + `shadow passes/frame ${run.features.shadowPassesPerFrame ?? '?'}, `
      + `night practicals active ${run.features.localLightsActive ?? '?'}, `
      + `ao ${run.features.ao ?? '?'}, aa ${run.features.antialias ?? '?'}, msaa ${run.features.sceneSamples ?? '?'}`);
  }
}

// Least squares on the runs that HAVE a steady-state mean.
const usable = runs.filter((r) => r.steadyMeanMs != null && r.steadyFrames >= 1);
function fit(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
  const denominator = n * sxx - sx * sx;
  if (!denominator) return null;
  const slope = (n * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.y - (intercept + slope * p.x)) ** 2, 0);
  return { slope, intercept, r2: ssTot ? 1 - ssRes / ssTot : null, n };
}
const model = fit(usable.map((r) => ({ x: r.megapixels, y: r.steadyMeanMs })));

// Non-frame cost, measured: boot, world rebuild, coverage raycast per card.
const latest = runs[runs.length - 1] || null;
const boot = Math.max(...runs.map((r) => r.bootMs || 0), 45000);
const rebuild = Math.max(...runs.map((r) => r.rebuildMs || 0), 6000);
const coveragePerCard = latest && latest.coverageMs
  ? latest.coverageMs / Math.max(1, latest.frames.length) : 5000;

const framesPerRound = SINGLE_CARDS + TRAVERSAL_FRAMES;
function round(perFrameMs) {
  // Frames dominate; the rest is boot, one mid-round world rebuild for the
  // waterfront window, the coverage raycast per card and the fixed per-card
  // page round trips (pose, shadow read, telemetry, weather settle).
  return boot + rebuild + perFrameMs * framesPerRound + coveragePerCard * 8 + 20000;
}

const newest = usable[usable.length - 1] || null;
const floorMs = newest ? newest.steadyMeanMs : null;
const modelMs = model ? model.intercept + model.slope * PROTOCOL_MPX : null;
const ceilingMs = newest ? newest.steadyMeanMs * (PROTOCOL_MPX / newest.megapixels) : null;

const estimate = {
  protocol: PROTOCOL,
  framesPerRound,
  measuredRuns: runs.map((r) => ({
    file: r.file, w: r.w, h: r.h, megapixels: +r.megapixels.toFixed(4),
    firstFrameMs: r.firstFrameMs, steadyMeanMs: r.steadyMeanMs ? Math.round(r.steadyMeanMs) : null,
    steadyFrames: r.steadyFrames, keyOff: r.keyOff,
  })),
  crossBuildFit: model ? {
    slopeMsPerMegapixel: Math.round(model.slope),
    fixedMs: Math.round(model.intercept),
    r2: model.r2 != null ? +model.r2.toFixed(4) : null,
    points: model.n,
    caveat: 'fitted across runs from DIFFERENT builds. Each wave adds work per frame, so the '
      + 'slope carries build drift as well as fragment cost.',
  } : null,
  perFrameMs: {
    floor: floorMs ? Math.round(floorMs) : null,
    model: modelMs ? Math.round(modelMs) : null,
    ceiling: ceilingMs ? Math.round(ceilingMs) : null,
    basis: 'floor = the newest measured steady-state frame cost, assuming resolution-independence '
      + '(contradicted by measurement, kept as a hard lower bound); model = the least-squares fit '
      + 'above; ceiling = pure linearity in fragment count from the newest measurement.',
  },
  fullRoundMs: {
    floor: floorMs ? round(floorMs) : null,
    model: modelMs ? round(modelMs) : null,
    ceiling: ceilingMs ? round(ceilingMs) : null,
  },
  nonFrameCostMs: { boot, worldRebuild: rebuild, coveragePerCard: Math.round(coveragePerCard), fixed: 20000 },
  keyOffDoubles: 'SF_QA_KEYOFF=1 shoots a second frame per card. It roughly doubles the frame cost '
    + 'of the round.',
  notMeasured: 'No card has ever been rendered at 2560x1440 on this box. '
    + 'scripts/qa/probe-protocol-resolution-v1.mjs has confirmed the route boots at that viewport '
    + 'with a 2560x1440 drawing buffer and MSAA 4, which is the boot half of the path, not a frame.',
  memoryRisk: '2560x1440 is 7.1x the fragments of 960x540 and raises peak renderer memory. This box '
    + 'has ~2 GB free; a protocol round can fail for memory reasons no cost model predicts.',
  featureWarning: (() => {
    const newestRun = runs[runs.length - 1];
    const f = newestRun?.features || {};
    const off = [];
    if (!f.shadowCascades) off.push('sun shadow cascades (0 cascades, 0 shadow passes per frame)');
    if (!f.localLightsActive) off.push('night practicals (0 active local lights)');
    return off.length
      ? `The newest measured run had these OFF: ${off.join('; ')}. Every number above is therefore a `
        + 'LOWER BOUND for a build that runs them. Re-measure after they are switched back on.'
      : null;
  })(),
};

console.log('');
if (model) {
  console.log(`cross-build fit: ${(model.slope / 1000).toFixed(1)} s per megapixel `
    + `+ ${(model.intercept / 1000).toFixed(1)} s fixed, r2 ${model.r2?.toFixed(3)} over ${model.n} run mean(s)`);
}
const fmtMin = (ms) => (ms == null ? '--' : (ms / 60000).toFixed(0));
const fmtSec = (ms) => (ms == null ? '--' : (ms / 1000).toFixed(0));
console.log(`per frame at ${PROTOCOL.w}x${PROTOCOL.h}: floor ${fmtSec(floorMs)}s, `
  + `model ${fmtSec(modelMs)}s, ceiling ${fmtSec(ceilingMs)}s`);
console.log(`full 8-card round (${framesPerRound} frames + boot + one world rebuild): `
  + `floor ${fmtMin(estimate.fullRoundMs.floor)} min, model ${fmtMin(estimate.fullRoundMs.model)} min, `
  + `ceiling ${fmtMin(estimate.fullRoundMs.ceiling)} min`);
console.log(`with SF_QA_KEYOFF=1: roughly ${fmtMin(estimate.fullRoundMs.model + (modelMs || 0) * framesPerRound)} min`);
if (estimate.featureWarning) console.log(`\nWARNING: ${estimate.featureWarning}`);
console.log('\nESTIMATE, NOT A MEASUREMENT: no card has been rendered at 1440p on this machine.');

await writeFile(process.env.SF_QA_ESTIMATE_OUT || 'tmp/protocol-round-estimate.json',
  JSON.stringify(estimate, null, 2)).catch(() => {});
