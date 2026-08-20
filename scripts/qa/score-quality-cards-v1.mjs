// Score a review round against Docs/VISUAL_QUALITY_GATE.md.
//
// A reviewer (human or model) supplies per-dimension integer scores 0-5 and a
// written justification. This script owns the arithmetic and the gate logic so
// a reviewer cannot accidentally (or conveniently) mis-add a total.
//
//   node scripts/qa/score-quality-cards-v1.mjs review.json
//
// review.json:
// {
//   "round": "r1", "build": "<git sha>", "capture": ".qa-quality-cards",
//   "scores": { "street": 2, "architecture": 1, ... },
//   "justification": { "street": "...", ... },
//   "criticalArtifacts": [ "..." ]
// }
//
// Exit 0 = APPROVE, 1 = CONDITIONAL, 2 = REJECT, 3 = malformed input.
import { readFile } from 'node:fs/promises';

// Weights and gates are transcribed from Docs/VISUAL_QUALITY_GATE.md.
// Keep them in sync with that document; it is the source of truth.
const RUBRIC = [
  { key: 'street',       weight: 18, gate: 4.0, label: 'Street and road realism' },
  { key: 'architecture', weight: 18, gate: 4.0, label: 'Architecture and materials' },
  { key: 'lighting',     weight: 14, gate: 4.0, label: 'Lighting and atmosphere' },
  { key: 'water',        weight: 10, gate: 3.5, label: 'Water and weather' },
  { key: 'character',    weight: 10, gate: 4.0, label: 'Character grounding' },
  { key: 'life',         weight: 10, gate: 3.5, label: 'NPC and traffic life' },
  { key: 'composition',  weight:  8, gate: 4.0, label: 'Composition and place identity' },
  { key: 'technical',    weight: 12, gate: 4.0, label: 'Technical integrity' },
];
const APPROVE_AT = 82;
const CONDITIONAL_AT = 70;

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/qa/score-quality-cards-v1.mjs <review.json>');
  process.exit(3);
}
const review = JSON.parse(await readFile(file, 'utf8'));
const scores = review.scores || {};

const missing = RUBRIC.filter((d) => !Number.isInteger(scores[d.key]));
if (missing.length) {
  console.error(`missing or non-integer scores: ${missing.map((d) => d.key).join(', ')}`);
  console.error('every dimension must be scored 0-5 as an integer');
  process.exit(3);
}
const outOfRange = RUBRIC.filter((d) => scores[d.key] < 0 || scores[d.key] > 5);
if (outOfRange.length) {
  console.error(`scores out of range 0-5: ${outOfRange.map((d) => d.key).join(', ')}`);
  process.exit(3);
}

let weighted = 0;
const rows = RUBRIC.map((d) => {
  const s = scores[d.key];
  const points = (s * d.weight) / 5;
  weighted += points;
  return { ...d, score: s, points: +points.toFixed(2), passesGate: s >= d.gate };
});
const total = +weighted.toFixed(2);
const failedGates = rows.filter((r) => !r.passesGate);
const critical = review.criticalArtifacts || [];

let verdict;
if (critical.length) verdict = 'REJECT';
else if (total >= APPROVE_AT && !failedGates.length) verdict = 'APPROVE';
else if (total >= CONDITIONAL_AT) verdict = 'CONDITIONAL';
else verdict = 'REJECT';
// A dimension below its gate can never approve, whatever the total.
if (verdict === 'APPROVE' && failedGates.length) verdict = 'CONDITIONAL';

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nRound ${review.round || '?'}  build ${review.build || '?'}  capture ${review.capture || '?'}`);
console.log('-'.repeat(78));
console.log(`${pad('Dimension', 34)}${pad('score', 7)}${pad('weight', 8)}${pad('points', 8)}gate`);
console.log('-'.repeat(78));
for (const r of rows) {
  console.log(
    `${pad(r.label, 34)}${pad(`${r.score}/5`, 7)}${pad(r.weight, 8)}${pad(r.points.toFixed(2), 8)}`
    + `${r.passesGate ? 'pass' : `FAIL (needs ${r.gate})`}`,
  );
}
console.log('-'.repeat(78));
console.log(`${pad('WEIGHTED TOTAL', 34)}${pad('', 7)}${pad(100, 8)}${pad(total.toFixed(2), 8)}`);
console.log(`\nApprove >= ${APPROVE_AT} with no failed gate and no critical artifact.`);
console.log(`Conditional ${CONDITIONAL_AT}-${APPROVE_AT - 1}. Below ${CONDITIONAL_AT} is reject.`);
if (failedGates.length) console.log(`\nFailed gates (${failedGates.length}): ${failedGates.map((r) => `${r.key} ${r.score}<${r.gate}`).join(', ')}`);
if (critical.length) {
  console.log(`\nCritical artifacts (automatic reject):`);
  for (const c of critical) console.log(`  - ${c}`);
}
console.log(`\nVERDICT: ${verdict}`);
console.log(`Gap to approval: ${Math.max(0, +(APPROVE_AT - total).toFixed(2))} points`
  + `${failedGates.length ? ` plus ${failedGates.length} gate(s)` : ''}\n`);

process.exit(verdict === 'APPROVE' ? 0 : verdict === 'CONDITIONAL' ? 1 : 2);
