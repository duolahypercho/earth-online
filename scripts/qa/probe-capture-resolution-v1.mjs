// Prove the capture resolution control end to end, without building a world.
//
// Every round this project has run reported `meetsProtocolResolution false`,
// and round 4 was believed to have been launched at 1280x720 while writing
// 1600x900 PNGs. That was never checkable, because three different facts were
// all being called "the resolution": what the launcher asked for, what the
// browser opened, and what the PNG contains. This probe measures all three from
// the SAME resolver the capture harness uses (`qa-resolution-v1.mjs`), against
// a blank page, so it costs a browser launch and a screenshot - seconds, not a
// world build and not a rendered card.
//
//   SF_QA_W=1280 SF_QA_H=720 node scripts/qa/probe-capture-resolution-v1.mjs
//   SF_QA_PROTOCOL=1 node scripts/qa/probe-capture-resolution-v1.mjs
//   SF_QA_RES_CASES=1 node scripts/qa/probe-capture-resolution-v1.mjs   # sweep
//
// Env: SF_QA_W, SF_QA_H, SF_QA_PROTOCOL, SF_QA_PROBE_OUT, SF_QA_RES_CASES
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pngStats } from './png-stats-v1.mjs';
import { resolveCaptureResolution, compareResolution } from './qa-resolution-v1.mjs';

const OUT = process.env.SF_QA_PROBE_OUT || '.qa-resolution-probe';
await mkdir(OUT, { recursive: true });

// A blank, deterministic page. The point is the PIXEL PIPELINE, not the world:
// if the viewport and the written PNG agree here, then a capture round that
// disagrees was given different numbers, and the report now records which.
const PAGE = 'data:text/html,'
  + encodeURIComponent('<body style="margin:0;background:#204060">'
    + '<div style="width:100%;height:100%;background:'
    + 'repeating-linear-gradient(45deg,#204060 0 20px,#6090c0 20px 40px)"></div></body>');

const cases = process.env.SF_QA_RES_CASES === '1'
  ? [
    { label: 'harness default (no env)', env: {} },
    { label: 'SF_QA_W/H 1280x720', env: { SF_QA_W: '1280', SF_QA_H: '720' } },
    { label: 'SF_QA_W/H 960x540', env: { SF_QA_W: '960', SF_QA_H: '540' } },
    { label: 'SF_QA_W/H 1600x900', env: { SF_QA_W: '1600', SF_QA_H: '900' } },
    { label: 'SF_QA_PROTOCOL=1', env: { SF_QA_PROTOCOL: '1' } },
    { label: 'SF_QA_PROTOCOL=1 overridden to 1600x900', env: { SF_QA_PROTOCOL: '1', SF_QA_W: '1600', SF_QA_H: '900' } },
    { label: 'unparsable SF_QA_W', env: { SF_QA_W: '720p' } },
  ]
  : [{ label: 'this process environment', env: process.env }];

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const report = { at: new Date().toISOString(), cases: [] };
let failures = 0;
for (const testCase of cases) {
  const resolved = resolveCaptureResolution(testCase.env);
  const page = await browser.newPage({ viewport: { width: resolved.w, height: resolved.h } });
  const viewport = page.viewportSize();
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  const file = path.join(OUT, `res-${resolved.w}x${resolved.h}.png`);
  await page.screenshot({ path: file });
  const stats = pngStats(await readFile(file));
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  await page.close();
  const agreement = compareResolution({
    resolved,
    viewport: viewport ? { w: viewport.width, h: viewport.height } : null,
    png: { w: stats.width, h: stats.height },
  });
  if (!agreement.agrees) failures += 1;
  report.cases.push({
    label: testCase.label,
    env: { SF_QA_W: resolved.raw.SF_QA_W, SF_QA_H: resolved.raw.SF_QA_H, SF_QA_PROTOCOL: resolved.raw.SF_QA_PROTOCOL },
    resolved: { w: resolved.w, h: resolved.h, source: resolved.source, invalid: resolved.invalid },
    browserViewport: agreement.browserViewport,
    devicePixelRatio,
    writtenPng: agreement.writtenPng,
    agrees: agreement.agrees,
    mismatches: agreement.mismatches,
    meetsProtocolResolution: agreement.meetsProtocolResolution,
    file,
  });
  console.log(`${agreement.agrees ? 'OK  ' : 'FAIL'} ${testCase.label}: `
    + `env(${JSON.stringify(resolved.raw.SF_QA_W)},${JSON.stringify(resolved.raw.SF_QA_H)},`
    + `${JSON.stringify(resolved.raw.SF_QA_PROTOCOL)}) -> resolved ${resolved.w}x${resolved.h} `
    + `-> viewport ${JSON.stringify(agreement.browserViewport)} -> png ${JSON.stringify(agreement.writtenPng)} `
    + `(dpr ${devicePixelRatio}, protocol ${agreement.meetsProtocolResolution})`
    + (agreement.mismatches.length ? ` :: ${agreement.mismatches.join('; ')}` : ''));
}
await browser.close();
report.allAgree = failures === 0;
await writeFile(path.join(OUT, 'resolution-probe.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.cases.length} case(s), ${failures} mismatch(es). `
  + 'A mismatch here means the browser or the PNG encoder is changing the size; no mismatch means '
  + 'a round captured at an unexpected size was ASKED for that size, and capture-report.json '
  + 'records the raw request under resolution.requestedFromEnv.');
process.exit(failures ? 1 : 0);
