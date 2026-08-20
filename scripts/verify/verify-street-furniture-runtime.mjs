// Runtime gate for the street-furniture presentation pass.
//
// This replaces scripts/verify-citygen-sidewalk-props.mjs, which pinned the
// hard-coded counts of the legacy `buildSidewalkProps` layer that the pass has
// retired. The geometric properties that verifier used to imply - inside the
// footway band, above the curb, no overlaps, nothing in the roadway, base on
// the surface - are proved headlessly on real data by verify-street-furniture.mjs.
// What a browser check uniquely proves is that the pass RAN IN THE REAL APP, so
// that is all this asserts.
//
// It reads a capture round's report rather than booting its own browser: the
// world build costs ~15 minutes on this box and the capture already records
// every pass's diagnostics.
//
//   node scripts/verify/verify-street-furniture-runtime.mjs [.qa-round2/capture-report.json]
//
// Exits non-zero on the first failed assertion.
import { readFile } from 'node:fs/promises';

const REQUIRED_KINDS = [
  'hydrant', 'parkingMeter', 'signPole', 'bollard', 'wasteBin', 'bikeRack',
  'newsBox', 'mailbox', 'tree', 'planter', 'bench', 'transitShelter',
  'standpipe', 'wallMeter',
];
const MIN_ITEMS = 3000;
const MAX_DRAW_CALLS = 40;
const MIN_KINDS = 14;

const file = process.argv[2] || '.qa-round2/capture-report.json';
const report = JSON.parse(await readFile(file, 'utf8'));

let checks = 0;
const failures = [];
function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const passes = report?.state?.passes;
check('the capture recorded pass diagnostics', !!passes,
  'no state.passes in the report - re-capture with a harness that records them');
if (!passes) {
  console.error(`FAIL ${failures.length}/${checks}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

check('no pass reported an error', (passes.errors || []).length === 0, JSON.stringify(passes.errors));

const entry = (passes.built || []).find((b) => b.id === 'street-furniture');
check('street-furniture built in the real app', !!entry,
  `built passes: ${(passes.built || []).map((b) => b.id).join(', ') || 'none'}`);

if (entry) {
  const detail = entry.detail || {};
  const totals = detail.totals || {};
  const counts = detail.counts || {};
  check('the pass placed a city-wide furniture set',
    Number(totals.items) >= MIN_ITEMS, `items=${totals.items} (need >= ${MIN_ITEMS})`);
  check('the pass stayed inside its draw-call budget',
    Number(entry.drawCalls) <= MAX_DRAW_CALLS, `drawCalls=${entry.drawCalls} (max ${MAX_DRAW_CALLS})`);
  check('the pass placed the full vocabulary',
    Object.keys(counts).length >= MIN_KINDS, `kinds=${Object.keys(counts).length} (need >= ${MIN_KINDS})`);
  for (const kind of REQUIRED_KINDS) {
    check(`the world contains at least one ${kind}`, Number(counts[kind]) > 0, `count=${counts[kind] ?? 0}`);
  }
  // The regression that would have caught round 1 on the day: the build focus
  // was the startup camera, 1450 m from the loaded window, and this pass placed
  // nothing at all in the world it shipped.
  check('the pass built around the world, not the startup camera',
    detail.focusSource === 'ctx', `focusSource=${detail.focusSource}, focusRejected=${detail.focusRejected}`);
  check('every ring stayed inside its budget',
    Array.isArray(detail.rings) && detail.rings.every((r) => r.withinBudget !== false),
    JSON.stringify(detail.rings));
  console.log(JSON.stringify({ items: totals.items, drawCalls: entry.drawCalls, kinds: Object.keys(counts).length, focusSource: detail.focusSource }, null, 2));
}

if (failures.length) {
  console.error(`\nFAIL ${failures.length}/${checks}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nPASS ${checks} checks`);
