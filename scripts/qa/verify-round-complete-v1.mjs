// Precondition check for a round OFFERED FOR REVIEW.
//
// Docs/VISUAL_QUALITY_GATE.md requires the same EIGHT scene cards, at 16:9 and
// 1440p or higher, and lists "omits the movement/tile-boundary verification
// clip" as an automatic rejection condition in its own right. Those are facts
// about the capture, not judgements about the image, so they can and should be
// checked mechanically before a reviewer's time is spent.
//
// This ENFORCES the gate. It cannot pass a round that is missing evidence, and
// it makes no quality claim about the frames it counts.
//
//   node scripts/qa/verify-round-complete-v1.mjs .qa-round5
//
// Exit 0 = the round is complete enough to offer for blind review.
// Exit 1 = complete as an ITERATION round, but not offerable (e.g. resolution).
// Exit 2 = incomplete: evidence is missing.
// Exit 3 = malformed input.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_CARDS = [
  '01-street-day', '02-intersection', '03-canyon-golden', '04-waterfront',
  '05-wet-street', '06-night-street', '07-character-curb', '08-traversal',
];
const MIN_PROTOCOL_HEIGHT = 1440;
// A frame that compresses to almost nothing is a blank surface, not a card.
const MIN_FRAME_BYTES = 20000;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/qa/verify-round-complete-v1.mjs <capture-dir>');
  process.exit(3);
}
let report;
try {
  report = JSON.parse(await readFile(path.join(dir, 'capture-report.json'), 'utf8'));
} catch (error) {
  console.error(`cannot read ${path.join(dir, 'capture-report.json')}: ${error.message}`);
  process.exit(3);
}

const problems = [];
const warnings = [];
const notes = [];
const byId = new Map((report.cards || []).map((c) => [c.id, c]));

async function bytesOf(file) {
  try { return (await stat(file)).size; } catch { return null; }
}

for (const id of REQUIRED_CARDS) {
  const card = byId.get(id);
  if (!card) { problems.push(`${id}: not in the round at all`); continue; }
  if (card.skipped) { problems.push(`${id}: skipped (${card.error || 'no reason recorded'})`); continue; }
  if (card.error && id !== '08-traversal') { problems.push(`${id}: failed (${String(card.error).slice(0, 160)})`); continue; }
  const files = id === '08-traversal'
    ? (card.sequence || []).filter((item) => item.file).map((item) => item.file)
    : (card.file ? [card.file] : []);
  if (!files.length) { problems.push(`${id}: no frame on disk`); continue; }
  for (const file of files) {
    const bytes = await bytesOf(file);
    if (bytes === null) problems.push(`${id}: recorded ${file} but it is not on disk`);
    else if (bytes < MIN_FRAME_BYTES) problems.push(`${id}: ${path.basename(file)} is ${bytes} B - a blank surface, not a card`);
  }
}

// The traversal card is the gate's named automatic-rejection condition.
const traversal = byId.get('08-traversal');
if (traversal) {
  const frames = (traversal.sequence || []).filter((item) => item.file);
  const plan = traversal.pose?.traversal || null;
  if (frames.length < 2) problems.push(`08-traversal: ${frames.length} frame(s); a traversal needs at least 2`);
  if (!plan) problems.push('08-traversal: no traversal plan recorded');
  else {
    if (!plan.crossesTileBoundary || !(plan.boundaryCrossings > 0)) {
      problems.push('08-traversal: the path crosses no runtime tile boundary - '
        + 'this is the gate\'s named verification and it is not satisfied');
    }
    const cells = new Set(frames.map((f) => (f.cell || []).join(',')));
    if (cells.size < 2) {
      problems.push(`08-traversal: all ${frames.length} frames stand in the same partition cell `
        + `(${[...cells].join(' ')}); the frames do not straddle the boundary the path crosses`);
    }
    notes.push(`08-traversal: ${frames.length} frames over ${plan.spanMeters} m, `
      + `${plan.boundaryCrossings} boundary crossing(s), cells {${[...cells].join(' | ')}}`);
  }
  if (traversal.clipForm) notes.push(`08-traversal form: ${traversal.clipForm}`);
  else warnings.push('08-traversal: no clipForm recorded - the evidence does not say what it is');
  if (traversal.frameFailures?.length) {
    problems.push(`08-traversal: ${traversal.frameFailures.length} frame(s) in the strip failed`);
  }
}

// The waterfront card must actually contain water.
const waterfront = byId.get('04-waterfront');
if (waterfront && !waterfront.skipped) {
  const check = waterfront.pose?.waterCheck || null;
  if (!check) warnings.push('04-waterfront: no water measurement recorded for the pose');
  else if (!(check.waterFraction > 0)) problems.push('04-waterfront: no water in the measured frame');
  else notes.push(`04-waterfront: ${(check.waterFraction * 100).toFixed(0)}% of the sampled `
    + `lower frame is water (${check.waterMesh})`);
  if (report.waterfrontEvidence?.provenance) notes.push(`04-waterfront provenance: ${report.waterfrontEvidence.provenance}`);
}

// A frame that is not a picture. Image statistics cannot approve a quality
// bar (Docs/VISUAL_QUALITY_GATE.md is explicit about that) but they can refuse
// a white-out or a black surface, which is the failure a round nobody can look
// at is otherwise blind to.
for (const id of REQUIRED_CARDS) {
  const card = byId.get(id);
  if (!card || card.skipped) continue;
  const frames = id === '08-traversal'
    ? (card.sequence || []).filter((item) => item.stats)
    : (card.frame || card.stats ? [card] : []);
  const shots = id === '08-traversal' ? frames : [card];
  for (const shot of shots) {
    const stats = shot.stats || shot.frame?.stats;
    if (!stats) continue;
    if (stats.featureless) {
      problems.push(`${id}${shot.name ? ` ${shot.name}` : ''}: featureless frame `
        + `(mean luma ${stats.meanLuma}, edge density ${stats.edgeDensity}) - blown out or blank`);
    } else if (stats.blownOut || stats.nearBlack) {
      warnings.push(`${id}${shot.name ? ` ${shot.name}` : ''}: mean luma ${stats.meanLuma} `
        + `(${stats.blownOut ? 'very bright' : 'very dark'}) with edge density ${stats.edgeDensity}`);
    }
  }
}

// Resolution and framing.
const w = report.viewport?.w ?? 0;
const h = report.viewport?.h ?? 0;
const aspect = h ? w / h : 0;
if (Math.abs(aspect - 16 / 9) > 0.02) problems.push(`viewport ${w}x${h} is not 16:9`);
const protocolResolution = h >= MIN_PROTOCOL_HEIGHT;
if (!protocolResolution) {
  warnings.push(`captured at ${w}x${h}; the blind-review protocol needs >= ${MIN_PROTOCOL_HEIGHT}p. `
    + 'This is an ITERATION round and must be labelled as one.');
}

// Anything the harness itself already flagged.
if (report.fatal) problems.push(`the round ended early: ${report.fatal.kind}`);
if (report.rendererCrashes) warnings.push(`${report.rendererCrashes} renderer crash(es) during the round`);
const shadow = report.runtime?.shadowTarget;
if (shadow) {
  if (shadow.assertable === false) {
    warnings.push('shadow render-target allocation was NOT asserted this round: no frame was drawn '
      + 'on the world that the run-level read saw. Not evidence either way.');
  } else if (!shadow.exists || !shadow.matchesRequest) {
    problems.push(`shadow render target ${shadow.exists ? 'mismatched' : 'never allocated'}: `
      + `requested ${JSON.stringify(shadow.requested)}, allocated ${JSON.stringify(shadow.allocated)}`);
  } else {
    notes.push(`shadow render target allocated ${JSON.stringify(shadow.allocated)} as requested`
      + `${shadow.cascade?.count ? `; cascade rig ${shadow.cascade.count} cascade(s), `
        + `${shadow.cascade.shadowPassesPerFrame} shadow pass(es)/frame` : ''}`);
  }
}
for (const recovery of report.worldRecoveries || []) {
  warnings.push(`world was lost and recovered (${recovery.via}): ${recovery.reason}`);
}
for (const step of report.setup || []) {
  if (!step.ok) warnings.push(`setup step "${step.name}" failed: ${String(step.error).slice(0, 140)}`);
}
if (report.world && report.world.osmShare < 0.9) {
  problems.push(`only ${(report.world.osmShare * 100).toFixed(0)}% of buildings are real OSM geometry`);
}
// Every rebuilt window has to prove it is real OSM geometry too; the boot
// window's clean bill of health does not transfer to a different slice.
for (const w of report.worldWindows || []) {
  const share = w.integrity?.osmShare;
  if (!(share >= 0.9)) {
    problems.push(`world window ${w.center ? w.center.join(',') : '?'} r${w.radius}: `
      + `OSM share ${share ?? 'unmeasured'} - cards shot on it are not verified real-map evidence`);
  }
}
// A multi-window round is acceptable evidence, but only if it says so.
const windows = new Set((report.worldWindowSummary?.perCard || []).map((c) => c.window));
if (windows.size > 1) {
  notes.push(`multi-window round: ${[...windows].join(' | ')} - each card records its own window`);
}

console.log(`\nround: ${dir}`);
console.log(`viewport: ${w}x${h} (aspect ${aspect.toFixed(3)})`);
console.log(`cards present: ${REQUIRED_CARDS.filter((id) => byId.get(id) && !byId.get(id).skipped).length}/8`);
for (const note of notes) console.log(`  note: ${note}`);
for (const warning of warnings) console.log(`  WARN: ${warning}`);
for (const problem of problems) console.error(`  FAIL: ${problem}`);

if (problems.length) {
  console.error(`\nROUND INCOMPLETE: ${problems.length} problem(s). Not offerable for blind review.`);
  process.exit(2);
}
if (!protocolResolution) {
  console.log('\nROUND COMPLETE as an ITERATION round. Not offerable for blind review at this resolution.');
  process.exit(1);
}
console.log('\nROUND COMPLETE and at protocol resolution. Offerable for blind review.');
console.log('This checks that the evidence EXISTS. It makes no claim about what the frames look like.');
process.exit(0);
