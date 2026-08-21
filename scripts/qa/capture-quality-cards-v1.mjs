// Capture the visual-quality-gate scene cards from the canonical route.
//
// Evidence only: this script produces frames and a settings manifest. It makes
// no quality claim. Scoring happens against Docs/VISUAL_QUALITY_GATE.md.
//
//   node scripts/qa/capture-quality-cards-v1.mjs
//
// Env: SF_QA_URL, SF_QA_OUT, SF_QA_CARDS (comma list), SF_QA_W, SF_QA_H,
//      SF_QA_SETTLE_MS (weather rig only), SF_QA_SHOT_MS, SF_QA_SETTLE_FRAMES,
//      SF_QA_SIM_WARM_S, SF_QA_SIM_CARD_S, SF_QA_SIM_STEP_S, SF_QA_PREWARM=on,
//      SF_QA_COVER_COLS, SF_QA_COVER_ROWS, SF_QA_TRAVERSAL_FRAMES,
//      SF_QA_TRAVERSAL_SPAN_M, SF_QA_TRAVERSAL_SPEED, SF_QA_WINDOW,
//      SF_QA_WATERFRONT_WINDOW ("x,z,r" or "off"), SF_QA_MAX_RECOVERIES
//
// What the report says about itself, and why those fields exist:
//   resolution        - the raw SF_QA_W/SF_QA_H/SF_QA_PROTOCOL strings, the
//                       viewport the browser opened, and the pixel size of the
//                       PNGs. roundStatus.meetsProtocolResolution is decided
//                       from the WRITTEN PIXELS.
//   eyeHeights        - height above the DRAWN surface under each camera,
//                       measured with a down-ray. `pose.eye.y` is a world Y.
//   dressingInFrame   - what the harness raycast filter excluded (nothing is
//                       excluded from the FRAME), and what is genuinely absent
//                       because an ancestor is hidden.
//   frameCostAttribution (per card) - where the frame time went: image
//                       pipeline, shadow passes, active night practicals.
//   urlOverrides      - query parameters that change what the runtime builds.
//   readingNotes      - fields that have been misread before, and their meaning.
//
// Frame budget: this harness draws frames only when it asks for them. The
// animation loop keeps ticking (the world simulates, the compositor stays
// live) but `renderFrame` is gated behind `window.__QA_RENDER__`, so a round
// pays for exactly the frames it captures.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pngStats } from './png-stats-v1.mjs';
import { resolveCaptureResolution, compareResolution } from './qa-resolution-v1.mjs';

const URL_BASE = process.env.SF_QA_URL || 'http://127.0.0.1:5178/';
const OUT = process.env.SF_QA_OUT || '.qa-quality-cards';
// The gate's blind-review protocol wants 1440p or higher. That is ~4x the
// fragments of 720p on a software backend, so iteration rounds run smaller and
// say so; a round offered for review must set SF_QA_PROTOCOL=1.
//
// Resolved in `qa-resolution-v1.mjs`, which also records the RAW environment it
// resolved from. Five rounds in a row reported a sub-protocol resolution and
// the last one was believed to have been launched at 1280x720 while it wrote
// 1600x900 frames; nothing in the report could settle that, because the report
// only ever held the resolved numbers. It now holds the request, the viewport
// the browser opened, and the pixel size of the PNGs that were written, and it
// says so out loud when they disagree.
const RESOLUTION = resolveCaptureResolution(process.env);
const PROTOCOL = RESOLUTION.protocolFlag;
const W = RESOLUTION.w;
const H = RESOLUTION.h;
// Wall-clock settles are gone from the card path: a fixed millisecond wait is
// not evidence that anything was drawn (see `renderFrames`). This remains only
// for the asynchronous weather rig rebuild, which is not a frame.
const WEATHER_SETTLE = Number(process.env.SF_QA_SETTLE_MS || 1500);
const SHOT_MS = Number(process.env.SF_QA_SHOT_MS || 600000);
const BOOT_MS = Number(process.env.SF_QA_BOOT_MS || 300000);
// One rendered frame costs minutes on this software rasterizer, so the round
// pays for frames explicitly: the animation loop is stopped from DRAWING for
// everything that is not a card, and a card waits for a counted number of
// RENDERED frames instead of a wall-clock guess.
const SETTLE_FRAMES = Math.max(1, Number(process.env.SF_QA_SETTLE_FRAMES || 1));
const FRAME_MS = Number(process.env.SF_QA_FRAME_MS || 600000);
// Simulated seconds to advance before the first card, and before each pose.
// The loop clamps its delta to 0.05 s, so at ~161 s per frame the world would
// otherwise be frozen at the boot instant for the whole round.
const SIM_WARM_S = Number(process.env.SF_QA_SIM_WARM_S ?? 20);
const SIM_CARD_S = Number(process.env.SF_QA_SIM_CARD_S ?? 4);
// The character card needs a walker to actually reach the kerb it is framed
// on. Stepping is CPU-only, so simulated time is cheap; frames are not.
const SIM_CHARACTER_S = Number(process.env.SF_QA_SIM_CHARACTER_S ?? 15);
const SIM_CHARACTER_TRIES = Math.max(1, Number(process.env.SF_QA_SIM_CHARACTER_TRIES || 6));
const SIM_STEP_S = Number(process.env.SF_QA_SIM_STEP_S || 1 / 60);
// Ground-hole tripwire grid. Four consecutive rounds reported 0.0% holes, so
// this is a regression signal, not a discovery tool; 12x6 keeps it cheap.
const COVER_COLS = Math.max(2, Number(process.env.SF_QA_COVER_COLS || 12));
const COVER_ROWS = Math.max(2, Number(process.env.SF_QA_COVER_ROWS || 6));
// Traversal card: a stepped strip along a path that crosses a runtime tile
// boundary. Each frame is a full render, so the count is explicit and small.
const TRAVERSAL_FRAMES = Math.max(2, Number(process.env.SF_QA_TRAVERSAL_FRAMES || 4));
const TRAVERSAL_SPAN_M = Number(process.env.SF_QA_TRAVERSAL_SPAN_M || 210);
const TRAVERSAL_SPEED_MS = Number(process.env.SF_QA_TRAVERSAL_SPEED || 1.45);
// The lighting warm-up exists to smooth the day/night pipeline transition. A
// capture pins the clock per card and never experiences that transition, so it
// is skipped by default here and only here. SF_QA_PREWARM=on restores it.
const SKIP_PREWARM = process.env.SF_QA_PREWARM !== 'on';

// Eye level in metres. The runtime is 1 unit = 1 metre.
const EYE = 1.65;

const ALL_CARDS = [
  { id: '01-street-day',   hour: 11, pose: 'street', weather: 'clear' },
  { id: '02-intersection', hour: 13, pose: 'intersection', weather: 'clear' },
  { id: '03-canyon-golden',hour: 18.5, pose: 'canyon', weather: 'clear' },
  // Afternoon, deliberately. The shoreline here faces roughly east, so a
  // morning hour puts the camera looking straight into the sun across 200 m of
  // open water under near-white daylight fog: the first frame this card ever
  // produced was a 250/255 mean-luma white-out with an edge density of 0.04.
  // Any daylight hour satisfies the gate's "shoreline/waterfront at daylight",
  // so the card takes the one where the sun is behind the camera.
  { id: '04-waterfront',   hour: 15.5, pose: 'waterfront', weather: 'clear' },
  { id: '05-wet-street',   hour: 15, pose: 'street', weather: 'drizzle' },
  { id: '06-night-street', hour: 21.5, pose: 'street', weather: 'clear' },
  { id: '07-character-curb',hour: 12, pose: 'character', weather: 'clear' },
  { id: '08-traversal',    hour: 12, pose: 'traversal', weather: 'clear' },
];
// SF_QA_PROBE="cardId:u,v u,v; cardId:u,v" - screen-space points to raycast.
const PROBES = new Map();
for (const spec of (process.env.SF_QA_PROBE || '').split(';').map((x) => x.trim()).filter(Boolean)) {
  const [id, list] = spec.split(':');
  if (!id || !list) continue;
  const points = list.trim().split(/\s+/).map((pair) => pair.split(',').map(Number))
    .filter((pt) => pt.length === 2 && pt.every(Number.isFinite));
  if (points.length) PROBES.set(id.trim(), points);
}

const wanted = process.env.SF_QA_CARDS
  ? process.env.SF_QA_CARDS.split(',').map((s) => s.trim())
  : ALL_CARDS.map((c) => c.id);
const cards = ALL_CARDS.filter((c) => wanted.includes(c.id));

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
// Read BACK, not assumed. This is the browser's own answer to "what did you
// open", and it is a different fact from what the harness asked for.
const openedViewport = page.viewportSize();
// Read once, before any module runs: `prewarmLightingPipelines` checks this
// probe at the end of every buildCity.
if (SKIP_PREWARM) {
  await page.addInitScript(() => { window.__QA_SKIP_PREWARM__ = true; });
}
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
    consoleErrors.push(m.text().slice(0, 300));
  }
});

const report = { url: URL_BASE, viewport: { w: W, h: H }, cards: [], errors: [] };
report.resolution = {
  requested: { w: W, h: H },
  requestedFromEnv: RESOLUTION.raw,
  source: RESOLUTION.source,
  invalidEnv: RESOLUTION.invalid,
  protocolFlagSet: PROTOCOL,
  browserViewport: openedViewport ? { w: openedViewport.width, h: openedViewport.height } : null,
  // Filled in from the first card actually written to disk.
  writtenPng: null,
  note: 'requestedFromEnv holds the RAW SF_QA_W/SF_QA_H/SF_QA_PROTOCOL strings this process '
    + 'received. If a round comes out at an unexpected size, compare these three: what the '
    + 'launcher asked for, what the browser opened, and what was written.',
};
// A round shot on a URL that switches passes off is not evidence about the
// production build. The runtime reads `?cascades=`, `?ao=`, `?post=`, `?aa=`,
// `?samples=`, `?nightLights=`, `?qaPasses=`, `?detailRes=` and friends at
// construction, and one debug run has already been captured at `?cascades=0`
// without the report saying so anywhere except a nested diagnostics string.
const RUNTIME_OVERRIDE_KEYS = new Set(['qaPasses', 'post', 'ao', 'aoScale', 'aoRadius', 'aoNormals',
  'aa', 'samples', 'cascades', 'shadowMap', 'shadowFar', 'nightLights', 'nightShadows',
  'nightShadowMap', 'decalFade', 'practicalSolve', 'detailRes', 'groundDetail', 'facadeDetail',
  'detailBump', 'qaPrewarm', 'street', 'sidewalk', 'preset']);
report.urlOverrides = (() => {
  try {
    const parsed = new URL(URL_BASE);
    const found = [...parsed.searchParams.entries()].filter(([key]) => RUNTIME_OVERRIDE_KEYS.has(key));
    return {
      url: URL_BASE,
      query: parsed.search || '',
      overrides: Object.fromEntries(found),
      count: found.length,
      note: found.length
        ? 'This round was captured on a URL that changes what the runtime builds or draws. It is '
          + 'NOT evidence about production behaviour and must not be scored as if it were.'
        : 'no runtime-behaviour overrides on the capture URL',
    };
  } catch (error) {
    return { url: URL_BASE, error: String(error).slice(0, 120) };
  }
})();
if (report.urlOverrides?.count) {
  const message = `capture URL carries runtime overrides ${JSON.stringify(report.urlOverrides.overrides)}; `
    + 'this round is NOT production behaviour';
  consoleErrors.push(message);
  console.error(message);
}
for (const message of RESOLUTION.invalid) {
  consoleErrors.push(`resolution: ${message}`);
  console.error(`resolution: ${message}`);
}
console.log(`capture resolution ${W}x${H} (width from ${RESOLUTION.source.width}, `
  + `height from ${RESOLUTION.source.height}; env SF_QA_W=${JSON.stringify(RESOLUTION.raw.SF_QA_W)} `
  + `SF_QA_H=${JSON.stringify(RESOLUTION.raw.SF_QA_H)} SF_QA_PROTOCOL=${JSON.stringify(RESOLUTION.raw.SF_QA_PROTOCOL)}); `
  + `browser opened ${JSON.stringify(openedViewport)}`);
// SF_QA_W/SF_QA_H beat SF_QA_PROTOCOL, and used to do it silently: a launch of
// `SF_QA_PROTOCOL=1 SF_QA_W=1600 SF_QA_H=900` produced a sub-protocol round
// whose report said `protocolFlagSet: true`. Say it, at the top of the log,
// before the round spends an hour.
if (PROTOCOL && !RESOLUTION.meetsProtocol) {
  const message = `SF_QA_PROTOCOL=1 was set, but SF_QA_W/SF_QA_H pinned the round to ${W}x${H}, `
    + 'which does NOT meet the review protocol (16:9 at >= 1440p). Unset SF_QA_W/SF_QA_H to '
    + 'capture at 2560x1440.';
  report.resolution.protocolOverriddenByEnv = true;
  consoleErrors.push(`resolution: ${message}`);
  console.error(`resolution: ${message}`);
}
if (openedViewport && (openedViewport.width !== W || openedViewport.height !== H)) {
  const message = `browser viewport ${openedViewport.width}x${openedViewport.height} does not match `
    + `the requested ${W}x${H}`;
  consoleErrors.push(`resolution: ${message}`);
  console.error(`resolution: ${message}`);
}

// A software-GL city build is heavy enough that the renderer process can be
// killed under memory pressure, or the page can reload underneath us. Either
// way `page.evaluate` fails with "Execution context was destroyed" and the run
// used to die *after* paying the five-minute boot. Report it, and re-boot once
// instead of throwing away the whole round.
let crashes = 0;
page.on('crash', () => { crashes += 1; consoleErrors.push('renderer process crashed'); });

// SF_QA_WINDOW="x,z,radius" rebuilds the world on a different window of the SF
// extract before any card is posed, and pins EVERY card to that window.
//
// The runtime's own boot window (centre [1600, 400], radius 720) contains no
// shoreline at all: `scripts/qa/find-waterfront-window-v1.mjs` replicates
// `loadSfData`'s windowing maths against the same prebuilt slice and reports 0
// shoreline-street segments inside it, which is exactly why card 04 has never
// been delivered. The waterfront card therefore declares its OWN window and the
// round rebuilds once, mid-round, rather than paying for a second browser boot.
// Every card records the window it was shot on, so a two-window round is
// self-describing evidence rather than a silent substitution.
function parseWindow(spec) {
  const parts = String(spec || '').split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite)
    ? { center: [parts[0], parts[1]], radius: parts[2] }
    : null;
}
const WORLD_WINDOW = parseWindow(process.env.SF_QA_WINDOW);
// Verified before this default was chosen, twice and without drawing a frame:
//   * scripts/qa/find-waterfront-window-v1.mjs (offline, on the same prebuilt
//     slice): 50 "The Embarcadero" roads and 207 buildings inside it, against
//     0 shoreline roads in the runtime's boot window;
//   * scripts/qa/probe-waterfront-window-v1.mjs (live runtime, frame-free):
//     58 shoreline segments, terrain 0.13-0.40 m against a water surface at
//     0.45 m (so the water is above the ground it meets), and 68% of the
//     lower-frame raycast samples from the shoreline kerb landing on water.
// It is also the corridor the gate's own "minimum next quality milestone"
// names. "Southern Embarcadero Freeway" is a motorway about three kilometres
// inland with the same word in its name; it is excluded by name everywhere.
const WATERFRONT_WINDOW = process.env.SF_QA_WATERFRONT_WINDOW === 'off'
  ? null
  : (parseWindow(process.env.SF_QA_WATERFRONT_WINDOW) || { center: [2290, 1938], radius: 720 });
/** The window a card needs, or null for whatever the runtime booted on. */
function windowForCard(card) {
  if (WORLD_WINDOW) return WORLD_WINDOW;
  if (card.pose === 'waterfront') return WATERFRONT_WINDOW;
  return null;
}
const windowKey = (w) => (w ? `${w.center[0]},${w.center[1]},${w.radius}` : 'boot');
const MAX_RECOVERIES = Math.max(1, Number(process.env.SF_QA_MAX_RECOVERIES || 3));

// --- world lifecycle --------------------------------------------------------
//
// The round that lost card 08 died here, and NOT the way the old recovery path
// assumed. It threw
//   TypeError: Cannot read properties of undefined (reading 'stepSimulation')
// out of the run-level boot-warm step. `window.__CITYGEN__` was undefined
// inside a context that was perfectly alive: the page had reloaded (this dev
// server hot-reloads, and other agents edit `src/` while a round runs), the
// navigation completed before the next `page.evaluate`, and the app was still
// booting on the new document. That is not "Execution context was destroyed",
// so the message-matching recovery never fired - and because the failing call
// sat OUTSIDE the per-card try/catch, it took a round that had already paid for
// its boot down with it.
//
// Three things changed. The world handle is watched directly (a main-frame
// navigation marks it lost), the loss test covers a missing handle as well as a
// destroyed context, and every recovery restores the FULL capture state - pin,
// hidden interface, world window, clock, pose - not just the page.
let worldLost = false;
let booting = false;
// `renderer.info` and the shadow render target only exist once something has
// actually been DRAWN on the current world. A round that rebuilt or recovered
// after its last card reads an undrawn world, and the shadow assertion then
// reports "never allocated" for a runtime that allocates it perfectly well.
// That false alarm is worse than no alarm: another agent is raising the cascade
// count on the assumption that these targets allocate. So the frame counter is
// tracked per world, and the assertion states its precondition.
let worldFrameBase = 0;
let worldRecoveries = 0;
let currentWindow = null;
let currentWindowRecord = { source: 'boot', center: null, radius: null };
let activeHour = null;
let activeCam = null;
let activeWeather = null;
report.worldRecoveries = [];

page.on('framenavigated', (frame) => {
  if (frame !== page.mainFrame()) return;
  // The harness's own `goto` navigates too; only an UNEXPECTED navigation
  // (a dev-server hot reload, a crash reload) means the world went away.
  if (booting) return;
  if (!worldLost) {
    worldLost = true;
    consoleErrors.push(`main frame navigated to ${frame.url()} - world handle assumed lost`);
    console.warn('main frame navigated; the world handle is assumed lost');
  }
});

// A dead target cannot be interrogated; anything else is decided by ASKING the
// page whether the handle is there, which is exact and costs one round trip.
const DEAD_TARGET = /Execution context was destroyed|Target closed|Target crashed|frame was detached|Session closed|has been closed/i;
async function worldHandlePresent() {
  try {
    return await page.evaluate(() => typeof window.__CITYGEN__?.getState === 'function'
      && (window.__CITYGEN__.getCity()?.buildings?.length || 0) > 50);
  } catch {
    return false;
  }
}

async function waitForWorldHandle(timeout = BOOT_MS) {
  await page.waitForFunction(() => {
    const api = window.__CITYGEN__;
    return typeof api?.getState === 'function' && (api.getCity()?.buildings?.length || 0) > 50;
  }, null, { timeout });
}

/** The city object exists before TrafficSim does; without this the report understates the crowd. */
async function waitForSimulation() {
  await page.waitForFunction(() => {
    const t = window.__CITYGEN__?.getTraffic?.();
    return !!t && (t.pedestrians?.length || 0) > 0 && (t.cars?.length || 0) > 0;
  }, null, { timeout: BOOT_MS }).catch(() => {});
}

async function bootWorld() {
  booting = true;
  try {
    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitForWorldHandle();
  } finally {
    booting = false;
  }
  // Pin BEFORE the animation loop starts. `state.city` is assigned at the top
  // of `buildCity`, so the wait above returns while the renderer is still
  // building and `setAnimationLoop` has not been called yet. Installing here is
  // what makes the round pay for zero unrequested frames; installing after the
  // state reads (where this used to live) leaked whole frames at ~161 s each.
  report.pin = await installPin();
  await waitForSimulation();
  worldFrameBase = 0;
  currentWindow = null;
  currentWindowRecord = { source: 'boot', center: null, radius: null };
  worldLost = false;
}

/**
 * Rebuild the world on a different window of the SF extract.
 *
 * Costs one world build (~13 s of `buildCity` plus the data fetch), which is
 * far cheaper than a second browser boot, and keeps the whole round in one
 * report with the window recorded per card.
 */
async function applyWindow(w, label) {
  const startedAt = Date.now();
  const loaded = await page.evaluate(async (spec) => {
    const api = window.__CITYGEN__;
    if (typeof api.loadSfWindow !== 'function') return { error: 'no loadSfWindow hook' };
    return api.loadSfWindow(spec);
  }, w);
  await waitForWorldHandle();
  await waitForSimulation();
  // `loadSfWindow` reopens the "real map loaded" panel and rebuilds the world
  // root, so the interface has to be hidden again, the pin re-checked, and the
  // raycast target cache dropped.
  await hideInterface();
  await installPin();
  await page.evaluate(() => { window.__QA_TARGETS__ = null; });
  // The OSM-fallback refusal at the top of the round only ever saw the BOOT
  // window. A rebuilt window is a different slice of the same dataset and can
  // fail on its own, so it reports its own integrity next to the frames it
  // produces rather than inheriting the boot window's clean bill of health.
  const integrity = await page.evaluate(() => {
    const c = window.__CITYGEN__.getCity();
    const blds = c.buildings || [];
    const osm = blds.filter((b) => String(b.id).startsWith('sf-building-')).length;
    return {
      buildings: blds.length,
      osmBuildings: osm,
      osmShare: blds.length ? +(osm / blds.length).toFixed(3) : 0,
      segments: (c.segments || []).length,
      waterPolygons: (c.water || []).length,
    };
  }).catch((error) => ({ error: String(error).slice(0, 160) }));
  if (!(integrity?.osmShare >= 0.9)) {
    consoleErrors.push(`world window ${windowKey(w)} is not real OSM geometry: ${JSON.stringify(integrity)}`);
    console.error(`world window ${windowKey(w)} FAILED the OSM integrity check: ${JSON.stringify(integrity)}`);
  }
  worldFrameBase = await page.evaluate(() => window.__QA_FRAMES__ | 0).catch(() => 0);
  currentWindow = w;
  currentWindowRecord = {
    source: label, center: w.center, radius: w.radius, loaded, integrity, rebuildMs: Date.now() - startedAt,
  };
  report.worldWindows = report.worldWindows || [];
  report.worldWindows.push(currentWindowRecord);
  console.log(`world window ${label} ${windowKey(w)}: ${JSON.stringify(loaded)} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return currentWindowRecord;
}

/** Put the capture conditions back after a reload or a rebuild. */
async function restoreCaptureState() {
  await hideInterface().catch(() => {});
  report.pin = await installPin().catch(() => 'pin-failed');
  await page.evaluate(() => { window.__QA_TARGETS__ = null; }).catch(() => {});
  if (currentWindow) {
    const want = currentWindow;
    currentWindow = null;
    await applyWindow(want, 'restored-after-recovery');
  }
  await page.evaluate(({ hour, cam, weather }) => {
    const api = window.__CITYGEN__;
    if (hour != null) { window.__QA_HOUR__ = hour; api.setClock?.(hour); }
    if (cam) {
      window.__QA_CAM__ = cam;
      const r = api.getRenderer();
      r.camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
      r.camera.lookAt(cam.look[0], cam.look[1], cam.look[2]);
    }
    if (weather) {
      const r = api.getRenderer?.();
      if (typeof api.setWeather === 'function') api.setWeather(weather);
      else if (r && typeof r.setWeather === 'function') r.setWeather(weather);
    }
  }, { hour: activeHour, cam: activeCam, weather: activeWeather }).catch(() => {});
}

/**
 * Re-establish the world after a loss, WITHOUT throwing away the round.
 *
 * A reload only needs the handle to come back; a dead target needs a full
 * navigation. Both are bounded by MAX_RECOVERIES so a permanently broken page
 * fails the round loudly instead of looping.
 */
async function recoverWorld(reason) {
  if (worldRecoveries >= MAX_RECOVERIES) {
    throw new Error(`world lost ${worldRecoveries} times (limit ${MAX_RECOVERIES}); last: ${reason}`);
  }
  worldRecoveries += 1;
  const startedAt = Date.now();
  const record = { attempt: worldRecoveries, reason: String(reason).slice(0, 200), via: null };
  consoleErrors.push(`world lost (${record.reason}); recovering, attempt ${worldRecoveries}`);
  console.warn(`world lost (${record.reason}); recovering, attempt ${worldRecoveries}`);
  try {
    await waitForWorldHandle(Math.min(BOOT_MS, 120000));
    record.via = 'reload-settled';
    worldLost = false;
    await waitForSimulation();
    await restoreCaptureState();
  } catch {
    record.via = 'full-reboot';
    await bootWorld();
    await restoreCaptureState();
  }
  record.ms = Date.now() - startedAt;
  report.worldRecoveries.push(record);
  console.warn(`world recovered via ${record.via} in ${(record.ms / 1000).toFixed(1)}s`);
  return record;
}

/**
 * Make sure there is a world to talk to before doing something expensive.
 *
 * Without this, a reload that lands mid-card costs TEN MINUTES: `renderFrames`
 * waits on `window.__QA_FRAMES__` reaching a target, and on a fresh document
 * that counter does not exist, so the predicate is simply false until
 * SF_QA_FRAME_MS (600 s) expires. One round trip before each frame turns that
 * into one recovery.
 */
async function ensureWorld(reason) {
  if (!worldLost && await worldHandlePresent()) return false;
  await recoverWorld(reason);
  return true;
}

/**
 * Evaluate against the live world, recovering if the handle went away.
 *
 * The failure that killed the last round was a live context with no
 * `window.__CITYGEN__` on it, so a thrown error is not classified by its
 * message: the page is asked whether the world handle is still there. A real
 * harness bug ("x is not a function" in my own code) therefore propagates as
 * itself instead of triggering a pointless five-minute reboot.
 */
async function evaluateInWorld(fn, arg = null) {
  if (worldLost) await recoverWorld('main frame navigated');
  try {
    return await page.evaluate(fn, arg);
  } catch (error) {
    const message = String(error?.message || error);
    const dead = DEAD_TARGET.test(message);
    if (!dead && await worldHandlePresent()) throw error;
    await recoverWorld(message.slice(0, 160));
    return page.evaluate(fn, arg);
  }
}

// A round is expensive and mostly boot. Nothing outside the card loop is
// allowed to end it silently: whatever happens, the report that describes what
// WAS captured gets written. `writeFileSync` on purpose - an async write in a
// dying process is a write that may not land.
let finalized = false;
function emergencyFinalize(kind, error) {
  if (finalized) return;
  finalized = true;
  report.fatal = {
    kind,
    error: String(error?.stack || error).slice(0, 800),
    at: new Date().toISOString(),
  };
  report.roundStatus = {
    ...(report.roundStatus || {}),
    requested: cards.map((c) => c.id),
    captured: report.cards.filter((c) => c.file).map((c) => c.id),
    complete: false,
    endedEarly: kind,
  };
  report.errors = consoleErrors.slice(0, 40);
  try {
    writeFileSync(path.join(OUT, 'capture-report.json'), JSON.stringify(report, null, 2));
  } catch { /* nothing left to do */ }
  console.error(`\nROUND ENDED EARLY (${kind}): ${String(error).slice(0, 200)}`);
  console.error(`report written with ${report.cards.length} card record(s), `
    + `${report.cards.filter((c) => c.file).length} frame(s) on disk`);
}
process.on('uncaughtException', (error) => { emergencyFinalize('uncaughtException', error); process.exit(5); });
process.on('unhandledRejection', (error) => { emergencyFinalize('unhandledRejection', error); process.exit(5); });

/**
 * Run one run-level step so that its failure is RECORDED, not fatal.
 *
 * Every step below this point used to be a bare top-level await: a single one
 * of them throwing discarded the boot and every card that had already been
 * paid for. They are diagnostics and warm-up, not evidence, so a failure is
 * written into `report.setup` and the round carries on to the cards.
 */
report.setup = [];
async function runStep(name, fn, { fatal = false } = {}) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    report.setup.push({ name, ok: true, ms: Date.now() - startedAt });
    return value;
  } catch (error) {
    const message = String(error?.stack || error).slice(0, 300);
    report.setup.push({ name, ok: false, ms: Date.now() - startedAt, error: message });
    consoleErrors.push(`setup step ${name} failed: ${message.slice(0, 160)}`);
    console.error(`setup step ${name} FAILED: ${message.slice(0, 200)}`);
    if (fatal) throw error;
    return null;
  }
}

// NOTE: waitForFunction is (pageFunction, arg, options) - passing the options
// object as the second argument silently leaves the 30s default in place.
const bootStartedAt = Date.now();
try {
  await bootWorld();
} catch (error) {
  emergencyFinalize('boot', error);
  await browser.close().catch(() => {});
  process.exit(5);
}
report.bootMs = Date.now() - bootStartedAt;
console.log(`world ready in ${(report.bootMs / 1000).toFixed(1)}s`);

// Group the round by world window: the boot-window cards are all delivered
// before anything rebuilds the world, and the round rebuilds at most once per
// distinct window. Array#sort is stable, so card order inside a group is the
// declared order.
const orderedCards = cards.slice().sort((a, b) => {
  const ka = windowKey(windowForCard(a));
  const kb = windowKey(windowForCard(b));
  if (ka === kb) return 0;
  if (ka === 'boot') return -1;
  if (kb === 'boot') return 1;
  return ka < kb ? -1 : 1;
});
report.cardOrder = orderedCards.map((c) => ({ id: c.id, window: windowKey(windowForCard(c)) }));
if (WORLD_WINDOW) {
  await runStep('world-window', () => applyWindow(WORLD_WINDOW, 'SF_QA_WINDOW'));
  report.worldWindow = currentWindowRecord;
}

// The canonical route silently falls back to a procedurally generated city
// when the real OSM dataset fails to load. Frames from the fallback are not
// evidence about San Francisco, so refuse to produce them.
report.world = await runStep('world-integrity', () => evaluateInWorld(() => {
  const c = window.__CITYGEN__.getCity();
  const blds = c.buildings || [];
  const osm = blds.filter((b) => String(b.id).startsWith('sf-building-')).length;
  return {
    buildings: blds.length,
    osmBuildings: osm,
    osmShare: blds.length ? +(osm / blds.length).toFixed(3) : 0,
    sampleIds: blds.slice(0, 3).map((b) => b.id),
    sampleStreets: [...new Set((c.segments || []).map((s) => s.streetName).filter(Boolean))].slice(0, 6),
    // Read, not assumed: the round records the window the RUNTIME booted on
    // rather than a hardcoded copy of the runtime's default.
    windowCentre: c.meta?.center || null,
    bounds: c.meta?.bounds || null,
  };
}));
// This refusal is a gate, and `runStep` must not become a way around it: an
// UNMEASURABLE world is refused exactly like a failed one. A round that cannot
// prove it loaded real San Francisco must not produce frames that imply it did.
if (!report.world || report.world.osmShare < 0.9) {
  await writeFile(path.join(OUT, 'capture-report.json'), JSON.stringify(report, null, 2));
  console.error('REFUSING TO CAPTURE: real San Francisco OSM data did not load.');
  if (!report.world) {
    console.error('  the world-integrity read failed, so the map source could not be verified at all');
  } else {
    console.error(`  osm buildings: ${report.world.osmBuildings}/${report.world.buildings} (need >= 90%)`);
    console.error(`  sample ids: ${JSON.stringify(report.world.sampleIds)}`);
    console.error(`  sample streets: ${JSON.stringify(report.world.sampleStreets)}`);
    console.error('  This is the procedural fallback, not the real map. Frames would be misleading.');
  }
  finalized = true;
  await browser.close();
  process.exit(3);
}

report.state = await runStep('runtime-state', () => evaluateInWorld(() => {
  const s = window.__CITYGEN__.getState();
  return {
    generator: s.generator, buildings: s.buildings, streets: s.streets,
    blocks: s.blocks, signals: s.signals, pedestrians: s.pedestrians,
    rendererBackend: s.rendererBackend, webgpu: s.webgpu, webgl2: s.webgl2,
    avgBuildingHeight: s.avgBuildingHeight, avgStreetWidth: s.avgStreetWidth,
    errors: s.errors,
    // What each presentation pass contributed, and what it cost to build. A
    // round with a silently-empty pass is not evidence about that pass.
    shadows: s.shadows || null,
    passes: s.passes ? {
      registered: s.passes.registered,
      errors: s.passes.errors,
      totals: s.passes.totals,
      built: (s.passes.built || []).map((b) => ({
        id: b.id, buildMs: b.buildMs, triangles: b.triangles, drawCalls: b.drawCalls,
        // A pass's own diagnostics are the only record of what it did AFTER
        // build: which LOD centre it ended on, whether it had to give budget
        // back, and what it actually built there. `triangles` above is a
        // build-time snapshot and says nothing about the captured frame.
        detail: b.detail || null,
      })),
    } : null,
  };
}));

// Hide HUD so the frames show the world, not the interface.
async function hideInterface() {
  await page.keyboard.press('h').catch(() => {});
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body > *:not(#scene-canvas)')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'absolute') el.style.visibility = 'hidden';
    }
    const c = document.getElementById('scene-canvas');
    if (c) { c.style.visibility = 'visible'; c.style.zIndex = '9999'; }
  });
}
await runStep('hide-interface', () => hideInterface());

// Let the world live before the first card. The loop clamps its delta to
// 0.05 s and a frame costs minutes, so without this every card of every round
// samples the same boot instant: cars parked mid-lane, nobody having taken a
// step. This runs the canonical fixed-step driver and draws nothing.
report.simWarm = await runStep('boot-warm', () => stepSimulation(SIM_WARM_S, 'boot-warm'));
if (report.simWarm) {
  console.log(`simulation warmed ${report.simWarm.simulatedSeconds}s in ${(report.simWarm.wallMs / 1000).toFixed(1)}s wall `
    + `(${report.simWarm.steps} steps of ${report.simWarm.stepSeconds.toFixed(4)}s)`);
}

// The runtime re-frames the camera every frame in orbit mode and advances
// state.clock at 0.6h per second, so a card would otherwise drift through half
// a day mid-exposure. Wrap renderer.update to pin both for the duration.
//
// The pin also owns WHEN THE WORLD DRAWS. The animation loop keeps rendering
// throughout every `page.evaluate` this harness makes, so all harness work was
// paid twice: the renderer main thread idled while the GPU process burned
// cores on frames nobody looks at. `renderFrame` is wrapped behind
// `__QA_RENDER__`, false by default, and `__QA_FRAMES__` counts the frames
// that were actually drawn. The rAF loop itself keeps ticking - the world
// keeps simulating and the compositor stays live - it just stops drawing.
async function installPin() {
  return page.evaluate(() => {
    const r = window.__CITYGEN__.getRenderer();
    // ONE definition of "what a harness raycast is allowed to hit", installed
    // on the page so the ground probe, the coverage grid and the waterfront
    // water check cannot drift apart. It also does the accounting properly.
    //
    // `coverage.droppedDressing` was read across the project as "387 of 1036
    // pieces of street dressing are missing from every frame". It never meant
    // that. `targets` (1036) is what the list KEPT and `droppedDressing` (387)
    // is what it EXCLUDED - two independent counts of a 1423-mesh scene, and
    // the exclusion applies to the RAYCAST TARGET LIST only. Every excluded
    // mesh is visible, has visible ancestors, and is drawn. The field is now
    // named for what it is, the totals are published next to each other so they
    // cannot be read as a ratio, and `drawnMeshes` states the denominator.
    // Names, matched at the START of the name and not as loose substrings.
    //
    // The substring filter this replaces excluded the entire drawn street,
    // because the word "street" contains "tree":
    //
    //   street-surface-v2:carriageway  matched "car" and "tree"
    //   street-surface-v2:concrete     matched "tree"
    //   street-surface-v2:markings     matched "tree"
    //   ground-coverage-v1:carpet      matched "car"
    //
    // So every mesh whose name begins with "street-" was dropped, and four
    // consecutive rounds of "0.0% ground holes" were measured against a target
    // list with no road, no kerb, no footway and no markings in it. The
    // ground-hole tripwire had never once tested the street. Verified by
    // running the old expression over the real mesh names in
    // src/world/streets/street-surface-v2.js and src/world/ground-coverage.js.
    window.__QA_DRESSING_PREFIXES__ = [
      'street-lamps', 'street-life', 'street-furniture', 'sidewalk-props',
      'shopfront-awnings', 'pedestrian', 'crowd', 'vehicle-', 'vehicle-presentation',
      'parked-car', 'contact-shadow', 'bay-ripple-cards', 'rain', 'elevation-contours',
      'local-light-pool', 'local-night-light', 'sf-transit-', 'sf-bike-rack',
      'sf-newspaper-box', 'sf-pay-station', 'sf-trash-can', 'marker', 'ghost', 'minimap',
    ];
    // The atmospherics. A ray that reaches any of these has left the world, and
    // the hole detector must say so - it used to recognise only 'sky-dome',
    // while the sky-atmosphere pass draws its own dome ON TOP of that one
    // ("later than the legacy dome's -10 so this one wins"), so a ray to the
    // sky could be counted as SOLID GROUND.
    //
    // The sky itself, and only the sky. `sky-atmosphere:ground-haze` and
    // `:dither` are deliberately NOT here: they are ground-level and
    // screen-level effects, and calling a ray that stops on them "a hole in the
    // world" would manufacture holes. They are dressing - the ray passes
    // through them to the surface underneath, which is the answer the hole
    // detector and the eye-height probe both want.
    window.__QA_SKY_NAMES__ = ['sky-dome', 'sky-atmosphere:dome', 'sky-atmosphere:sky',
      'sky-atmosphere:stars', 'sky-atmosphere:moon', 'sky-atmosphere:clouds',
      'sky-atmosphere:sun-disc', 'sky-atmosphere:sun-glow'];
    window.__QA_CLASSIFY__ = (name) => {
      const key = String(name || '').toLowerCase();
      if (window.__QA_SKY_NAMES__.some((sky) => key === sky || key.startsWith(`${sky}:`))) return 'sky';
      // Everything else the sky-atmosphere pass draws is a ground decal or a
      // glow lying on the world (light pools, road pools, wet sheen, grounding,
      // shop spill). It must not stop a ground ray a few millimetres above the
      // surface the card is standing on.
      if (key.startsWith('sky-atmosphere:')) return 'dressing';
      if (window.__QA_DRESSING_PREFIXES__.some((prefix) => key.startsWith(prefix))) return 'dressing';
      // Default KEEP. An unknown name is more likely to be world geometry than
      // dressing, and keeping it can only make a raycast stop on something that
      // is drawn - it can never invent a hole.
      return 'surface';
    };
    window.__QA_BUILD_TARGETS__ = () => {
      const renderer = window.__CITYGEN__.getRenderer();
      const rootId = renderer.root?.uuid || null;
      const cached = window.__QA_TARGETS__;
      if (cached && cached.rootId === rootId && cached.list) return cached;
      // `Object3D.traverse` visits the children of an invisible node too, so
      // "object.visible" alone counts meshes that are never drawn. Walk the
      // ancestors: a mesh under a hidden group is not in the frame, and must
      // not be a raycast target either - otherwise the hole detector stops on
      // geometry the reviewer cannot see.
      const ancestorsVisible = (object) => {
        let node = object.parent;
        while (node) {
          if (node.visible === false) return false;
          node = node.parent;
        }
        return true;
      };
      const list = [];
      const excludedByName = {};
      const keptByName = {};
      const hiddenByAncestorNames = {};
      let excluded = 0;
      let hiddenByAncestor = 0;
      let excludedInstances = 0;
      let drawnMeshes = 0;
      let skyMeshes = 0;
      let streetSurfaceMeshes = 0;
      renderer.scene.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh) return;
        if (!object.geometry) return;
        if (object.visible === false) return;
        if (!ancestorsVisible(object)) {
          hiddenByAncestor += 1;
          const key = object.name || object.parent?.name || '(unnamed)';
          hiddenByAncestorNames[key] = (hiddenByAncestorNames[key] || 0) + 1;
          return;
        }
        drawnMeshes += 1;
        const name = object.name || object.parent?.name || '';
        const kind = window.__QA_CLASSIFY__(name);
        if (kind === 'dressing') {
          excluded += 1;
          excludedInstances += object.isInstancedMesh ? (object.count || 0) : 1;
          const key = name || '(unnamed)';
          excludedByName[key] = (excludedByName[key] || 0) + 1;
          return;
        }
        if (kind === 'sky') skyMeshes += 1;
        if (/^street-surface-v2|^ground-coverage|^sf-ground-|^terrain/i.test(name)) streetSurfaceMeshes += 1;
        keptByName[name || '(unnamed)'] = (keptByName[name || '(unnamed)'] || 0) + 1;
        list.push(object);
      });
      window.__QA_TARGETS__ = {
        rootId,
        list,
        kept: list.length,
        excludedDressing: excluded,
        excludedDressingInstances: excludedInstances,
        excludedByName,
        keptByName,
        hiddenByAncestor,
        hiddenByAncestorNames,
        drawnMeshes,
        skyMeshes,
        // The assertion that matters: a hole detector with no road, kerb or
        // footway in its target list is not testing the street.
        streetSurfaceMeshes,
      };
      return window.__QA_TARGETS__;
    };
    if (window.__QA_RENDER__ === undefined) window.__QA_RENDER__ = false;
    if (window.__QA_FRAMES__ === undefined) window.__QA_FRAMES__ = 0;
    if (!window.__QA_FRAME_MS__) window.__QA_FRAME_MS__ = [];
    if (r.__qaPinned) return 'already';
    const origUpdate = r.update.bind(r);
    r.update = (delta, opts) => {
      const hour = window.__QA_HOUR__;
      const out = origUpdate(delta, hour == null ? opts : { ...(opts || {}), time: hour });
      const c = window.__QA_CAM__;
      if (c) {
        r.camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
        r.camera.lookAt(c.look[0], c.look[1], c.look[2]);
        if (r.controls?.target?.set) r.controls.target.set(c.look[0], c.look[1], c.look[2]);
      }
      return out;
    };
    const origRender = r.renderFrame.bind(r);
    r.renderFrame = () => {
      if (!window.__QA_RENDER__) return undefined;
      const startedAt = performance.now();
      const out = origRender();
      // Main-thread cost of issuing the frame. The GPU cost is measured by the
      // harness as wall-clock between arming the flag and the counter moving.
      window.__QA_FRAME_MS__.push(+(performance.now() - startedAt).toFixed(1));
      if (window.__QA_FRAME_MS__.length > 64) window.__QA_FRAME_MS__.shift();
      window.__QA_FRAMES__ = (window.__QA_FRAMES__ | 0) + 1;
      // Snapshot the draw counters now: the next frame resets them, and a
      // counter read after the world stops drawing describes nothing.
      try {
        const info = r.renderer?.info;
        if (info) {
          window.__QA_RENDER_INFO__ = {
            render: info.render ? { ...info.render } : null,
            memory: info.memory ? { ...info.memory } : null,
          };
        }
      } catch { /* diagnostics only */ }
      // Stop at exactly the requested number of frames. The harness polls at
      // second granularity, so without this the loop started a second frame
      // while the first was still being detected - and the screenshot then had
      // to wait on that second frame's GPU work as well.
      if ((window.__QA_FRAME_BUDGET__ | 0) > 0) {
        window.__QA_FRAME_BUDGET__ = (window.__QA_FRAME_BUDGET__ | 0) - 1;
        if ((window.__QA_FRAME_BUDGET__ | 0) <= 0) window.__QA_RENDER__ = false;
      }
      return out;
    };
    r.__qaPinned = true;
    return 'installed';
  });
}

/**
 * Draw a counted number of frames and stop again.
 *
 * This replaces the wall-clock settle. A fixed millisecond wait on a machine
 * where one frame costs 161-197 s is not evidence that anything was drawn;
 * a frame counter advancing by a known number is.
 */
async function renderFrames(count = SETTLE_FRAMES) {
  const startedAt = Date.now();
  const base = await page.evaluate((need) => {
    window.__QA_FRAME_MS__ = [];
    window.__QA_FRAME_BUDGET__ = need;
    window.__QA_RENDER__ = true;
    return window.__QA_FRAMES__ | 0;
  }, count).catch(() => 0);
  let timedOut = false;
  try {
    await page.waitForFunction(
      ({ base: b, need }) => (window.__QA_FRAMES__ | 0) >= b + need,
      { base, need: count },
      { timeout: FRAME_MS, polling: 1000 },
    );
  } catch (error) {
    timedOut = true;
    // Say WHY. A timeout with the world handle gone is a lost page, not a slow
    // frame, and the two need different responses from whoever reads this.
    const handle = await worldHandlePresent();
    consoleErrors.push(`renderFrames timed out after ${Date.now() - startedAt} ms `
      + `(world handle ${handle ? 'present - genuinely slow frame' : 'MISSING - the page went away'})`);
  }
  const detail = await page.evaluate((b) => ({
    drawn: (window.__QA_FRAMES__ | 0) - b,
    cpuFrameMs: (window.__QA_FRAME_MS__ || []).slice(-8),
  }), base).catch((error) => ({ drawn: null, cpuFrameMs: [], readFailed: String(error).slice(0, 140) }));
  return { requested: count, ...detail, wallMs: Date.now() - startedAt, timedOut };
}

/**
 * Draw the card, stop drawing, then take the screenshot.
 *
 * With the loop drawing continuously, `page.screenshot` queued behind in-flight
 * frames and measured 161-197 s per card. Once the world holds still the
 * compositor already owns the last presented frame, so the screenshot is a
 * copy. The frame that matters is paid for exactly once, above.
 *
 * A stale/blank compositor surface would be silent false evidence, so the PNG
 * size is checked: a black or empty frame compresses to a few KB. If it looks
 * empty, re-shoot once with the loop drawing and record that it happened.
 */
async function captureFrame(file, { frames = SETTLE_FRAMES } = {}) {
  const out = { file };
  if (await ensureWorld(`before ${path.basename(file)}`)) out.recoveredBeforeFrame = true;
  out.render = await renderFrames(frames);
  await stopRendering();
  // NOTHING DRAWN IS NOT A FRAME. `renderFrames` returns after SF_QA_FRAME_MS
  // whether or not the counter moved, and the compositor then still holds the
  // last frame it was given - which is the PREVIOUS card's pose. Screenshotting
  // that files a duplicate frame under this card's name, which is the exact
  // class of false evidence this harness refuses elsewhere. Retry once, then
  // refuse: a missing card is honest, a mislabelled one is not.
  if (!(out.render?.drawn > 0)) {
    const message = `${path.basename(file)}: the render drew ${out.render?.drawn ?? 'an unreadable number of'} `
      + `frames in ${out.render?.wallMs} ms; the compositor still holds the previous pose`;
    consoleErrors.push(message);
    console.error(`  ${message} - retrying once`);
    out.retryRender = await renderFrames(1);
    await stopRendering();
    if (!(out.retryRender?.drawn > 0)) {
      throw new Error(`${path.basename(file)}: no frame was drawn for this pose `
        + `(first attempt ${out.render?.drawn ?? 'unreadable'}, retry ${out.retryRender?.drawn ?? 'unreadable'}); `
        + 'refusing to screenshot the previous card\'s frame under this name');
    }
  }
  // The screenshot is where the last two lost traversal frames died: this dev
  // server hot-reloads while a round runs, and a reload mid-screenshot times
  // out after ten minutes and takes the card with it. One recovery and one
  // retry is cheaper than losing a frame that has already been paid for.
  const shoot = async () => {
    const startedShot = Date.now();
    await page.screenshot({ path: file, timeout: SHOT_MS });
    return Date.now() - startedShot;
  };
  try {
    out.shotMs = await shoot();
  } catch (error) {
    out.screenshotFailure = String(error?.message || error).slice(0, 200);
    consoleErrors.push(`${path.basename(file)} screenshot failed: ${out.screenshotFailure}`);
    console.error(`  ${path.basename(file)} screenshot FAILED: ${out.screenshotFailure} - recovering and retrying once`);
    out.recoveredAfterScreenshotFailure = await ensureWorld(`screenshot of ${path.basename(file)}`);
    out.retryAfterScreenshotFailure = await renderFrames(1);
    await stopRendering();
    if (!(out.retryAfterScreenshotFailure?.drawn > 0)) {
      throw new Error(`${path.basename(file)}: screenshot failed and the retry drew no frame`);
    }
    out.shotMs = await shoot();
    out.reshotAfterFailure = true;
  }
  out.bytes = (await stat(file)).size;
  // Measure the frame. "Is the PNG bigger than 20 KB" is not a test that it is
  // a picture: a fully blown-out waterfront card compressed to 24.7 KB and
  // passed it, while being 250/255 mean luma with no local contrast. These are
  // regression signals only - they cannot approve anything - but they can say
  // "this is not a photograph of anything", which is the failure that matters
  // to a round nobody in the loop can look at.
  try {
    out.stats = pngStats(await readFile(file));
    if (out.stats.featureless) {
      consoleErrors.push(`${path.basename(file)} is featureless: meanLuma ${out.stats.meanLuma}, `
        + `edge density ${out.stats.edgeDensity} - blown out or blank, not a card`);
      console.error(`  ${path.basename(file)} IS FEATURELESS (meanLuma ${out.stats.meanLuma}, `
        + `edges ${out.stats.edgeDensity}) - blown out or blank`);
    }
  } catch (error) {
    out.statsError = String(error).slice(0, 160);
  }
  // The PIXELS that were written. Not the viewport, not the request - the IHDR
  // of the file a reviewer will open. `meetsProtocolResolution` is decided from
  // this, so the field describes the delivered evidence rather than the intent.
  if (out.stats?.width && out.stats?.height) {
    out.pngPixels = { w: out.stats.width, h: out.stats.height };
    if (!report.resolution.writtenPng) {
      report.resolution.writtenPng = { ...out.pngPixels, from: path.basename(file) };
      const agreement = compareResolution({
        resolved: { w: W, h: H },
        viewport: report.resolution.browserViewport,
        png: out.pngPixels,
      });
      report.resolution.agreement = agreement;
      for (const mismatch of agreement.mismatches) {
        consoleErrors.push(`resolution: ${mismatch}`);
        console.error(`resolution: ${mismatch}`);
      }
    } else if (out.pngPixels.w !== report.resolution.writtenPng.w
      || out.pngPixels.h !== report.resolution.writtenPng.h) {
      const message = `${path.basename(file)} is ${out.pngPixels.w}x${out.pngPixels.h}, but `
        + `${report.resolution.writtenPng.from} was ${report.resolution.writtenPng.w}x${report.resolution.writtenPng.h}; `
        + 'the round is not one resolution';
      consoleErrors.push(`resolution: ${message}`);
      console.error(`resolution: ${message}`);
      report.resolution.mixedSizes = true;
    }
  }
  if (out.bytes < 20000) {
    out.emptyFrameSuspected = out.bytes;
    consoleErrors.push(`${path.basename(file)} was ${out.bytes} B; re-shooting with the loop drawing`);
    const second = await renderFrames(1);
    const shotMs = await shoot();
    await stopRendering();
    out.reshot = { render: second, shotMs, bytes: (await stat(file)).size };
    out.bytes = out.reshot.bytes;
  }
  return out;
}

/** Stop drawing. Simulation, rAF and the compositor keep running. */
async function stopRendering() {
  await page.evaluate(() => { window.__QA_RENDER__ = false; }).catch(() => {});
}

/**
 * Advance the world by simulated seconds without drawing a frame.
 * `stepSimulation` runs the canonical fixed-step driver; it is deterministic
 * and it does not let presentation write simulation state.
 */
async function stepSimulation(seconds, label) {
  if (!(seconds > 0)) return null;
  const result = await evaluateInWorld(({ s, step }) => {
    const api = window.__CITYGEN__;
    if (typeof api.stepSimulation !== 'function') return { ok: false, reason: 'no stepSimulation hook' };
    return api.stepSimulation(s, { step });
  }, { s: seconds, step: SIM_STEP_S });
  if (result && result.ok === false) consoleErrors.push(`stepSimulation(${label}): ${result.reason}`);
  return result ? { label, ...result } : null;
}

// Place the camera in world metres. Returns what it actually chose so the
// manifest records the real pose, not the requested one.
async function placeCamera(pose, { measureWater = true } = {}) {
  return evaluateInWorld(({ pose, EYE, traversal, measureWater }) => {
    const api = window.__CITYGEN__;
    const r = api.getRenderer();
    const city = api.getCity();
    const cam = r.camera;
    const controls = r.controls;
    // `terrain.heightAt` is BARE GROUND. The street is built on top of it: the
    // carriageway sits at `streetDesign.roadLift` and the footway 45 mm above
    // that. Standing the eye on bare terrain put the camera ~0.5 m low, which is
    // why the baseline card reads as a crouch rather than a 1.65 m eye line.
    const lift = r.streetSurfaceLift ? r.streetSurfaceLift(city) : { footway: 0, datum: 0 };
    // A traversal pose stands on the FOOTWAY (its eye is offset by `walk`, the
    // same kerb offset the street cards use), so it must be lifted onto the
    // footway datum like they are. Lifting it onto the carriageway datum put
    // the eye 0.10 m below the surface it is standing on - the same class of
    // placement-datum disagreement as a floating prop, just small enough to
    // read only as a slightly low camera. The intersection pose is left on the
    // carriageway datum: it is existing, already-scored evidence and changing
    // its eye height is not this task's to change.
    const surfaceLift = pose === 'intersection' ? lift.datum : lift.footway;
    const groundAt = (x, z) => (r.terrain?.heightAt ? r.terrain.heightAt(x, z) + surfaceLift : surfaceLift);

    // The MODEL above is the placement code's own arithmetic: bare terrain plus
    // a constant cross-section lift. This is the DRAWN answer - a ray dropped
    // through the scene onto whatever surface is really there. A reviewer
    // measured "eye heights of 2.17-2.57 m" off `pose.eye.y`, which is an
    // absolute world Y and not an eye height at all; the report never carried
    // the height above ground, so there was nothing to correct them with. Now
    // the eye is SET from the drawn surface and the report carries both numbers
    // and their disagreement.
    const dropRay = api.THREE?.Raycaster ? new api.THREE.Raycaster() : null;
    const downVector = api.THREE?.Vector3 ? new api.THREE.Vector3(0, -1, 0) : null;
    const rayOrigin = api.THREE?.Vector3 ? new api.THREE.Vector3() : null;
    /**
     * The drawn surface under (x, z), or null if nothing is there.
     *
     * `modelY` bounds what counts as "the ground under the camera": a hit far
     * above it is a roof or a canopy, and accepting it would aim the card at
     * the sky. A rejected hit is reported, never silently swapped.
     */
    const drawnGroundAt = (x, z, modelY) => {
      if (!dropRay || !downVector || typeof window.__QA_BUILD_TARGETS__ !== 'function') return null;
      const bundle = window.__QA_BUILD_TARGETS__();
      if (!bundle?.list?.length) return null;
      rayOrigin.set(x, modelY + 6, z);
      dropRay.set(rayOrigin, downVector);
      dropRay.near = 0;
      dropRay.far = 120;
      const hits = dropRay.intersectObjects(bundle.list, false);
      let best = null;
      let rejectedAbove = null;
      for (const hit of hits) {
        const name = hit.object.name || hit.object.parent?.name || '';
        if (window.__QA_CLASSIFY__(name) === 'sky') continue;
        const y = hit.point.y;
        // The band the ground under a standing camera can plausibly be in.
        if (y > modelY + 1 || y < modelY - 4) {
          if (!rejectedAbove) rejectedAbove = { y: +y.toFixed(3), surface: name || '(unnamed)' };
          continue;
        }
        if (!best || y > best.y) best = { y, surface: name || '(unnamed)', distance: hit.distance };
      }
      return {
        y: best ? +best.y.toFixed(3) : null,
        surface: best ? best.surface : null,
        modelY: +modelY.toFixed(3),
        hits: hits.length,
        rejectedOutsideBand: rejectedAbove,
      };
    };

    // A simulated pedestrian's position is NOT on the record: it is derived from
    // its path (`points`, `cum`, `s`) and mirrored onto its group each frame.
    // Reading `agent.x` returned undefined for every agent, so the character
    // card refused every pose with "nearest none" and the camera-clearance test
    // silently never fired.
    const agentPosition = (agent) => {
      const gp = agent?.group?.position;
      if (gp && Number.isFinite(gp.x) && Number.isFinite(gp.z)) return { x: gp.x, z: gp.z };
      const pts = agent?.points;
      if (Array.isArray(pts) && pts.length >= 2) {
        const total = Number(agent.total) || 0;
        const distance = total > 0 ? ((Number(agent.s) || 0) % total + total) % total : 0;
        const cum = agent.cum;
        let index = 0;
        if (Array.isArray(cum)) {
          while (index < cum.length - 1 && cum[index + 1] < distance) index += 1;
        }
        const a = pts[Math.min(index, pts.length - 2)];
        const b = pts[Math.min(index + 1, pts.length - 1)];
        const segStart = Array.isArray(cum) ? (cum[index] || 0) : 0;
        const segLength = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const t = Math.max(0, Math.min(1, (distance - segStart) / segLength));
        return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      }
      if (Number.isFinite(agent?.x) && Number.isFinite(agent?.z)) return { x: agent.x, z: agent.z };
      return null;
    };

    // Road geometry lives on segments, not streets.
    const segs = (city.segments || []).filter((s) => (s.points || []).length >= 2);
    if (!segs.length) return { ok: false, reason: 'no segments' };

    const segLen = (s) => {
      let L = 0;
      for (let i = 1; i < s.points.length; i += 1) {
        L += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].z - s.points[i - 1].z);
      }
      return L;
    };
    const mid = (s) => s.points[Math.floor(s.points.length / 2)];

    // Building centroids, for "how tall is it around here".
    const blds = (city.buildings || []).map((b) => {
      const poly = b.polygon || [];
      if (!poly.length) return null;
      let x = 0; let z = 0;
      for (const p of poly) { x += p.x; z += p.z; }
      return { x: x / poly.length, z: z / poly.length, h: b.height || 0 };
    }).filter(Boolean);
    const tallnessAt = (p, radius = 70) => {
      let sum = 0; let n = 0;
      for (const b of blds) {
        if (Math.abs(b.x - p.x) > radius || Math.abs(b.z - p.z) > radius) continue;
        if (Math.hypot(b.x - p.x, b.z - p.z) <= radius) { sum += b.h; n += 1; }
      }
      return { avg: n ? sum / n : 0, count: n };
    };

    // Reject camera positions that land inside a building shell.
    const polys = (city.buildings || []).map((b) => b.polygon).filter((p) => p && p.length > 2);
    const insideAny = (pt) => {
      for (const poly of polys) {
        let hit = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[i]; const b = poly[j];
          if (((a.z > pt.z) !== (b.z > pt.z))
            && (pt.x < ((b.x - a.x) * (pt.z - a.z)) / ((b.z - a.z) || 1e-9) + a.x)) hit = !hit;
        }
        if (hit) return true;
      }
      return false;
    };

    const named = (needle) => segs.filter((s) => (s.streetName || '').toLowerCase().includes(needle));
    const longest = (list) => list.slice().sort((a, b) => segLen(b) - segLen(a))[0];

    // The runtime's water body. `renderer.water` is the handle the renderer
    // keeps; the scene scan is the fallback if that name ever moves. There is
    // exactly one water body on this path - the OSM slice this route loads
    // carries no water polygons at all (`city.water` is empty in every window),
    // so the card is only ever standing in front of the renderer's own bay
    // surface, and the card report says so.
    const findWater = () => {
      if (r.water && r.water.visible !== false) return r.water;
      let found = null;
      r.scene.traverse((object) => {
        if (found || !object.isMesh) return;
        if (!/water|bay/i.test(object.name || '')) return;
        found = object;
      });
      return found;
    };

    let chosen = null;
    let note = null;
    if (pose === 'canyon') {
      let best = null; let bestScore = -1;
      for (const s of segs) {
        if (segLen(s) < 25) continue;
        const t = tallnessAt(mid(s));
        if (t.count < 3) continue;
        if (t.avg > bestScore) { bestScore = t.avg; best = s; }
      }
      chosen = best || longest(segs);
      note = `avgHeightAround=${bestScore.toFixed(1)}m`;
    } else if (pose === 'waterfront') {
      // "The Embarcadero" is the shoreline street. "Southern Embarcadero
      // Freeway" is a motorway about three kilometres inland with the same word
      // in its name, and framing it would be a fabricated waterfront card, so
      // it is excluded by name AND by highway class.
      const shore = segs.filter((s) => /embarcadero/i.test(s.streetName || '')
        && !/freeway/i.test(s.streetName || '')
        && s.highway !== 'motorway');
      if (!shore.length) {
        return {
          ok: false,
          reason: 'no shoreline street in the loaded window',
          hint: 'the runtime boot window has none; rebuild on a shoreline window (SF_QA_WATERFRONT_WINDOW="x,z,r")',
          windowCentre: city.meta?.center || null,
          bounds: city.meta?.bounds || null,
          cityWaterPolygons: (city.water || []).length,
        };
      }
      const waterMesh = findWater();
      if (!waterMesh) {
        return {
          ok: false,
          reason: 'the loaded world has no water body to stand in front of',
          shoreSegments: shore.length,
          cityWaterPolygons: (city.water || []).length,
        };
      }
      const waterAt = {
        x: waterMesh.position.x, y: waterMesh.position.y, z: waterMesh.position.z,
      };
      // Stand where the shoreline street comes closest to the water body.
      let bestSeg = null;
      let bestDistance = Infinity;
      for (const s of shore) {
        for (const pt of s.points) {
          const d = Math.hypot(pt.x - waterAt.x, pt.z - waterAt.z);
          if (d < bestDistance) { bestDistance = d; bestSeg = s; }
        }
      }
      chosen = { ...bestSeg, __water: waterAt, __waterName: waterMesh.name || '(unnamed)' };
      note = `shoreline street ${bestSeg.streetName}; water body "${waterMesh.name || '(unnamed)'}" `
        + `${bestDistance.toFixed(0)} m away at y=${waterAt.y.toFixed(2)}; `
        + `${shore.length} shoreline segments in window`;
    } else if (pose === 'traversal') {
      // The gate asks for a clip "crossing a tile boundary". The runtime's
      // streaming tile is the 140 m world-partition cell that gates street
      // life, portals and parked cars (BISTRO/PORTAL/PARKED_CAR_PARTITION_CELL_SIZE
      // in the renderer), so a traversal crosses one of those cell lines.
      const tile = traversal.tileM;
      const cellKey = (x, z) => `${Math.floor(x / tile)},${Math.floor(z / tile)}`;
      const walkable = segs.filter((sg) => !['footway', 'cycleway', 'pedestrian', 'service', 'motorway'].includes(sg.highway)
        && segLen(sg) >= 90);
      const pool = (walkable.length ? walkable : segs).map((sg) => {
        // Count cell changes along the polyline, sampled at 5 m: a two-point
        // segment can cross a cell line without either endpoint reporting it.
        let crossings = 0;
        let previous = null;
        for (let i = 1; i < sg.points.length; i += 1) {
          const p0 = sg.points[i - 1];
          const p1 = sg.points[i];
          const length = Math.hypot(p1.x - p0.x, p1.z - p0.z);
          const steps = Math.max(1, Math.ceil(length / 5));
          for (let k = 0; k <= steps; k += 1) {
            const t = k / steps;
            const key = cellKey(p0.x + (p1.x - p0.x) * t, p0.z + (p1.z - p0.z) * t);
            if (previous !== null && key !== previous) crossings += 1;
            previous = key;
          }
        }
        return { sg, length: segLen(sg), crossings };
      });
      pool.sort((left, right) => (right.crossings - left.crossings) || (right.length - left.length));
      chosen = pool[0]?.sg || longest(segs);
      note = `tile=${tile}m partition cells; crossings=${pool[0]?.crossings ?? 0}; length=${(pool[0]?.length || 0).toFixed(0)}m`;
    } else if (pose === 'intersection') {
      const withSig = (city.intersections || []).filter((i) => i.position);
      if (!withSig.length) return { ok: false, reason: 'no intersections' };
      // busiest = most adjoining streets
      const inter = withSig.slice().sort((a, b) => (b.streetIds?.length || 0) - (a.streetIds?.length || 0))[0];
      const near = segs
        .map((s) => ({ s, d: Math.hypot(mid(s).x - inter.position.x, mid(s).z - inter.position.z) }))
        .sort((a, b) => a.d - b.d)[0];
      chosen = near?.s || longest(segs);
      chosen = { ...chosen, __focus: inter.position };
      note = `intersection ${inter.id} streets=${inter.streetIds?.length || 0}`;
    } else {
      // A street card is only evidence if there is actually a street wall around it.
      const MIN_NEIGHBOURS = 8;
      const scored = [];
      for (const sg of segs) {
        if (segLen(sg) < 35) continue;
        const t = tallnessAt(mid(sg), 60);
        if (t.count < MIN_NEIGHBOURS) continue;
        // favour commercial-width roads with a dense, moderately tall street wall
        scored.push({ sg, score: t.count * 1.6 + Math.min(t.avg, 45) * 0.9 + (sg.width || 0) * 1.4, t });
      }
      scored.sort((a, b) => b.score - a.score);
      if (!scored.length) return { ok: false, reason: `no segment with >= ${MIN_NEIGHBOURS} buildings within 60m` };
      chosen = scored[0].sg;
      note = `neighbours=${scored[0].t.count} avgH=${scored[0].t.avg.toFixed(1)}m of ${scored.length} candidates`;
      chosen.__candidates = scored.slice(0, 14).map((c) => c.sg);
    }
    if (!chosen) return { ok: false, reason: 'no candidate segment' };

    const pts = chosen.points;
    const i = Math.max(1, Math.floor(pts.length / 2));
    const a = pts[i - 1]; const b = pts[i];
    const dx = b.x - a.x; const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    let ux = dx / len; let uz = dz / len;

    // Face away from the sun, not into it. A card shot with the view heading
    // close to the anti-solar azimuth puts every shadow behind its own caster
    // and reads as a flat, shadowless frame no matter how good the shadow map
    // is: the intersection card was 9.2 degrees off anti-solar and looked
    // unlit, while the street cards were 104 degrees off and looked correct.
    // A street runs both ways, so choosing the direction along it is free.
    const sun = r.sun?.position;
    let sunNote = null;
    // The waterfront card's heading is decided by where the water is, not by
    // the sun: flipping it would turn the camera inland and there would be no
    // water in the frame at all.
    if (sun && (sun.x || sun.z) && pose !== 'waterfront') {
      // Where shadows point: away from the sun, projected on the ground.
      const antiSolar = Math.atan2(-sun.x, -sun.z);
      const separation = (heading) => {
        const delta = Math.abs(((heading - antiSolar + Math.PI) % (Math.PI * 2)) - Math.PI);
        return (delta * 180) / Math.PI;
      };
      const forward = separation(Math.atan2(ux, uz));
      const backward = separation(Math.atan2(-ux, -uz));
      if (backward > forward) { ux = -ux; uz = -uz; }
      sunNote = `anti-solar separation ${Math.max(forward, backward).toFixed(1)} deg`;
    }
    // right-hand normal
    const nx = -uz; const nz = ux;
    const halfRoad = (chosen.width || 7) / 2;
    const walk = halfRoad + Math.max(1.2, (chosen.sidewalkW || 2) * 0.55);

    let eye; let target; let eyeLift = EYE;
    let targetYOverride = null;
    let traversalPlan = null;
    if (pose === 'waterfront') {
      // Seaward kerb, looking out over the water at a shallow angle along the
      // shore so the frame contains the shoreline contact, not only open water.
      const w = chosen.__water;
      let wx = -uz; let wz = ux;
      if ((w.x - a.x) * wx + (w.z - a.z) * wz < 0) { wx = -wx; wz = -wz; }
      eye = { x: a.x + wx * walk, z: a.z + wz * walk };
      // Look ALONG the shore, with the bay on one side - not straight out to
      // sea. Straight out measured 83% open water and produced a white-out:
      // 200 m of flat water under daylight fog is a picture of a fog plane.
      // Roughly 24 degrees off the shore axis keeps the quay, the kerb, the
      // Embarcadero itself and the buildings behind it in frame WITH the water,
      // which is what "shoreline" means.
      //
      // The along-shore sign is chosen by the sun: whichever direction puts
      // more of the key behind the camera. This is the same anti-solar test the
      // street cards use; the waterfront card just cannot apply it to the
      // across-water component, because that one is fixed by where the bay is.
      let alongX = ux; let alongZ = uz;
      const sunAt = r.sun?.position;
      if (sunAt && (sunAt.x || sunAt.z)) {
        const antiSolar = Math.atan2(-sunAt.x, -sunAt.z);
        const separation = (hx, hz) => {
          const delta = Math.abs(((Math.atan2(hx, hz) - antiSolar + Math.PI) % (Math.PI * 2)) - Math.PI);
          return (delta * 180) / Math.PI;
        };
        const forward = separation(wx * 90 + ux * 200, wz * 90 + uz * 200);
        const backward = separation(wx * 90 - ux * 200, wz * 90 - uz * 200);
        if (backward > forward) { alongX = -ux; alongZ = -uz; }
        note = `${note}; along-shore heading chosen for anti-solar separation `
          + `${Math.max(forward, backward).toFixed(1)} deg`;
      }
      target = { x: eye.x + wx * 90 + alongX * 200, z: eye.z + wz * 90 + alongZ * 200 };
      targetYOverride = w.y;
    } else if (pose === 'intersection') {
      const f = chosen.__focus;
      eye = { x: f.x - ux * 22 + nx * walk, z: f.z - uz * 22 + nz * walk };
      target = { x: f.x, z: f.z };
    } else if (pose === 'character') {
      // The card is only evidence if there is a character in it. The canonical
      // runtime has no player avatar, so this frames the nearest simulated
      // pedestrian to the chosen kerb - and refuses if there is nobody there,
      // rather than shooting an empty pavement and calling it a character card.
      // "nearest none m" with 348 agents on the record is not a crowd problem,
      // it is arithmetic: one non-finite term makes every distance NaN, NaN is
      // never `< bestDistance`, and the card reports an empty street. Guard the
      // kerb point, skip non-finite agents, and say WHICH input was bad instead
      // of blaming the crowd.
      const kerb = { x: a.x + nx * (halfRoad + 0.6), z: a.z + nz * (halfRoad + 0.6) };
      const stand = Number.isFinite(kerb.x) && Number.isFinite(kerb.z) ? kerb : { x: a.x, z: a.z };
      if (!Number.isFinite(stand.x) || !Number.isFinite(stand.z)) {
        return {
          ok: false,
          reason: 'kerb point is not finite',
          detail: { a, nx, nz, halfRoad, width: chosen.width ?? null, sidewalkW: chosen.sidewalkW ?? null },
        };
      }
      const traffic = api.getTraffic?.();
      const crowd = typeof traffic?.presentationAgents === 'function'
        ? traffic.presentationAgents()
        : (traffic?.pedestrians || []);
      let best = null; let bestDistance = Infinity;
      let positioned = 0;
      let unpositionedSample = null;
      for (const agent of crowd) {
        const position = agentPosition(agent);
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
          if (!unpositionedSample && agent) {
            unpositionedSample = {
              keys: Object.keys(agent).slice(0, 14),
              hasGroup: !!agent.group,
              groupPosition: agent.group?.position
                ? { x: agent.group.position.x, z: agent.group.position.z } : null,
              points: Array.isArray(agent.points) ? agent.points.length : null,
              s: agent.s ?? null,
              total: agent.total ?? null,
            };
          }
          continue;
        }
        positioned += 1;
        const distance = Math.hypot(position.x - stand.x, position.z - stand.z);
        if (!Number.isFinite(distance)) continue;
        if (distance < bestDistance) { bestDistance = distance; best = position; }
      }
      if (!best || bestDistance > 30) {
        return {
          ok: false,
          reason: `no pedestrian within 30 m of the kerb (nearest ${Number.isFinite(bestDistance) ? bestDistance.toFixed(1) : 'none'} m)`,
          crowd: crowd.length,
          // The three numbers that separate "the street is empty" from "the
          // measurement is broken".
          positioned,
          kerbPoint: { x: +stand.x.toFixed(2), z: +stand.z.toFixed(2) },
          unpositionedSample,
        };
      }
      // Stand off far enough that the subject is whole in frame. Anything under
      // ~3 m puts the camera inside the body.
      const away = Math.hypot(best.x - a.x, best.z - a.z) > 0.01
        ? { x: (best.x - a.x), z: (best.z - a.z) }
        : { x: nx, z: nz };
      const awayLength = Math.hypot(away.x, away.z) || 1;
      const offsetX = away.x / awayLength;
      const offsetZ = away.z / awayLength;
      const STANDOFF = 4.6;
      eye = { x: best.x + offsetX * STANDOFF - ux * 1.4, z: best.z + offsetZ * STANDOFF - uz * 1.4 };
      target = best;
      eyeLift = EYE + 0.15;
      note = `${note ? `${note}; ` : ''}subject is a simulated pedestrian ${bestDistance.toFixed(1)} m from the kerb point; the runtime has no player avatar`;
    } else if (pose === 'traversal') {
      // A stepped strip along the chosen street: `traversal.frames` poses
      // spread over `traversal.spanM` metres of real polyline, each recording
      // the partition cell it stands in. The harness renders one frame per
      // pose and steps the simulation between them.
      const tile = traversal.tileM;
      const poly = chosen.points;
      const cum = [0];
      for (let i = 1; i < poly.length; i += 1) {
        cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z));
      }
      const total = cum[cum.length - 1];
      const at = (distance) => {
        const d = Math.max(0, Math.min(total, distance));
        let i = 0;
        while (i < cum.length - 2 && cum[i + 1] < d) i += 1;
        const p0 = poly[i];
        const p1 = poly[i + 1];
        const length = (cum[i + 1] - cum[i]) || 1;
        const t = (d - cum[i]) / length;
        return {
          x: p0.x + (p1.x - p0.x) * t,
          z: p0.z + (p1.z - p0.z) * t,
          ux: (p1.x - p0.x) / length,
          uz: (p1.z - p0.z) / length,
        };
      };
      const cellOf = (x, z) => [Math.floor(x / tile), Math.floor(z / tile)];
      const span = Math.min(traversal.spanM, total * 0.98);
      const start = Math.max(0, (total - span) / 2);
      const count = Math.max(2, traversal.frames);
      const buildSide = (side) => {
        const frames = [];
        for (let k = 0; k < count; k += 1) {
          const d = start + (span * k) / (count - 1);
          const p = at(d);
          const px = -p.uz * side;
          const pz = p.ux * side;
          const ex = p.x + px * walk;
          const ez = p.z + pz * walk;
          const look = at(Math.min(total, d + 34));
          // Every pose in the strip stands on the DRAWN surface under it, like
          // the single-frame cards, and records what it measured. A traversal
          // that walks off the footway model shows up here as a per-frame
          // disagreement instead of as a subtly floating camera in four frames.
          const modelEyeGround = groundAt(ex, ez);
          const eyeGround = drawnGroundAt(ex, ez, modelEyeGround);
          const eyeSurfaceY = eyeGround?.y != null ? eyeGround.y : modelEyeGround;
          const modelLookGround = groundAt(look.x, look.z);
          const lookGround = drawnGroundAt(look.x, look.z, modelLookGround);
          const lookSurfaceY = lookGround?.y != null ? lookGround.y : modelLookGround;
          frames.push({
            index: k,
            distanceAlong: +d.toFixed(2),
            eye: { x: +ex.toFixed(2), y: +(eyeSurfaceY + EYE).toFixed(2), z: +ez.toFixed(2) },
            look: {
              x: +look.x.toFixed(2),
              y: +(lookSurfaceY + EYE * 0.92).toFixed(2),
              z: +look.z.toFixed(2),
            },
            eyeHeight: {
              target: EYE,
              modelGroundY: +modelEyeGround.toFixed(3),
              drawnGroundY: eyeGround?.y ?? null,
              drawnGroundSurface: eyeGround?.surface ?? null,
              modelMinusDrawnM: eyeGround?.y != null ? +(modelEyeGround - eyeGround.y).toFixed(3) : null,
              heightAboveDrawnGroundM: eyeGround?.y != null ? EYE : null,
              measured: !!eyeGround?.y,
            },
            cell: cellOf(ex, ez),
            insideBuilding: insideAny({ x: ex, z: ez }),
          });
        }
        return frames;
      };
      const left = buildSide(1);
      const right = buildSide(-1);
      const badness = (list) => list.filter((f) => f.insideBuilding).length;
      const frames = badness(right) < badness(left) ? right : left;
      let crossings = 0;
      let previous = null;
      for (let d = start; d <= start + span + 0.001; d += 5) {
        const p = at(d);
        const key = cellOf(p.x, p.z).join(',');
        if (previous !== null && key !== previous) crossings += 1;
        previous = key;
      }
      traversalPlan = {
        tileMeters: tile,
        surfaceLift: +surfaceLift.toFixed(3),
        surfaceDatum: 'footway',
        tileDefinition: 'runtime world-partition cell (streamed street life, portals, parked cars)',
        spanMeters: +span.toFixed(1),
        segmentLengthMeters: +total.toFixed(1),
        boundaryCrossings: crossings,
        crossesTileBoundary: crossings > 0,
        distinctCells: [...new Set(frames.map((f) => f.cell.join(',')))],
        framesInsideBuilding: frames.filter((f) => f.insideBuilding).length,
        frames,
      };
      eye = { x: frames[0].eye.x, z: frames[0].eye.z };
      target = { x: frames[0].look.x, z: frames[0].look.z };
    } else {
      eye = { x: a.x + nx * walk, z: a.z + nz * walk };
      target = { x: a.x + ux * 90 + nx * (walk * 0.35), z: a.z + uz * 90 + nz * (walk * 0.35) };
    }

    // If the eye landed inside a building, try the opposite kerb, then other candidates.
    // A traversal path has already chosen its side over the whole strip; moving
    // just its first pose here would desync the recorded path from the frames.
    // The waterfront pose has already chosen the side the water is on; flipping
    // it would point the camera inland, which is the one thing that card cannot do.
    if (pose !== 'traversal' && pose !== 'waterfront' && insideAny(eye)) {
      const flipped = { x: a.x - nx * walk, z: a.z - nz * walk };
      if (!insideAny(flipped)) {
        eye = flipped;
        target = { x: a.x + ux * 90 - nx * (walk * 0.35), z: a.z + uz * 90 - nz * (walk * 0.35) };
      } else {
        for (const alt of (chosen.__candidates || []).slice(1)) {
          const ap = alt.points; const ai = Math.max(1, Math.floor(ap.length / 2));
          const aa = ap[ai - 1]; const ab = ap[ai];
          const adx = ab.x - aa.x; const adz = ab.z - aa.z;
          const al = Math.hypot(adx, adz) || 1;
          const aux = adx / al; const auz = adz / al;
          const anx = -auz; const anz = aux;
          const aw = (alt.width || 7) / 2 + Math.max(1.2, (alt.sidewalkW || 2) * 0.55);
          const cand = { x: aa.x + anx * aw, z: aa.z + anz * aw };
          if (!insideAny(cand)) {
            eye = cand;
            target = { x: aa.x + aux * 90 + anx * (aw * 0.35), z: aa.z + auz * 90 + anz * (aw * 0.35) };
            chosen = alt;
            note = `${note || ''} | relocated: first pick was inside a building`;
            break;
          }
        }
      }
    }

    let eyeY = groundAt(eye.x, eye.z) + eyeLift;
    const targetLift = pose === 'canyon' ? 22 : (pose === 'character' ? 1.1 : EYE * 0.92);
    let tgtY = targetYOverride != null ? targetYOverride : groundAt(target.x, target.z) + targetLift;
    cam.position.set(eye.x, eyeY, eye.z);
    cam.lookAt(target.x, tgtY, target.z);
    // Keep the crowd out of the lens. Two reviewers reported a card whose near
    // quarter is the shoulder of a pedestrian standing on the camera, occluding
    // the thing the card exists to show. The eye is a camera, not a person: if
    // an agent is inside the near field, step the eye back along its own view
    // ray until the nearest agent clears a stated radius.
    const CAMERA_CLEARANCE = 1.6;
    const agents = (() => {
      const traffic = api.getTraffic?.();
      if (typeof traffic?.presentationAgents === 'function') return traffic.presentationAgents();
      return traffic?.pedestrians || [];
    })();
    // The simulated crowd is not the only thing that can stand in the lens: the
    // street-life pass draws its own standing figures, and one of those - not a
    // simulated pedestrian - is what ended up inside the near plane on the
    // intersection card. The guard therefore unions the crowd with the figures
    // that pass has actually drawn.
    //
    // The pass now PUBLISHES that list (`userData.streetLife.nearAnchors`:
    // every figure it is currently drawing inside the near-ring radius, near
    // and mid tier alike, nearest first, in world metres). Read it. It is
    // authoritative, it costs one scene walk instead of a full instance-matrix
    // decode, and unlike the old scrape it does not miss figures the near
    // budget spilled into the mid ring or break when a mesh is renamed.
    let streetLifeAnchorSource = 'none';
    const publishedStreetLife = (() => {
      const out = [];
      let record = null;
      r.scene.traverse((object) => {
        if (record) return;
        const published = object.userData?.streetLife;
        if (published && Array.isArray(published.nearAnchors)) record = published;
      });
      if (!record) return null;
      for (const anchor of record.nearAnchors) {
        if (Number.isFinite(anchor?.x) && Number.isFinite(anchor?.z)) out.push({ x: anchor.x, z: anchor.z });
      }
      return { points: out, radius: record.radius ?? null, version: record.version ?? null };
    })();

    // Fallback only: the pre-publication scrape, kept so a build where the pass
    // has not run yet still gets *some* guard rather than silently none.
    const scrapedStreetLife = (() => {
      const out = [];
      const T = api.THREE;
      if (!T?.Matrix4) return out;
      const local = new T.Matrix4();
      const world = new T.Matrix4();
      const seen = new Set();
      r.scene.traverse((object) => {
        if (!object.isInstancedMesh || !object.visible) return;
        if (!/^street-life-near/.test(object.name || '')) return;
        object.updateWorldMatrix(true, false);
        const count = Math.min(object.count || 0, object.instanceMatrix?.count || 0);
        for (let i = 0; i < count; i += 1) {
          object.getMatrixAt(i, local);
          world.multiplyMatrices(object.matrixWorld, local);
          const x = world.elements[12];
          const z = world.elements[14];
          const key = `${x.toFixed(1)},${z.toFixed(1)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ x, z });
        }
      });
      return out;
    })();
    const streetLifePoints = publishedStreetLife ? publishedStreetLife.points : scrapedStreetLife;
    streetLifeAnchorSource = publishedStreetLife ? 'pass-published-nearAnchors' : 'scene-instance-matrices';
    const nearestAgent = (point) => {
      let best = Infinity;
      for (const agent of agents) {
        const position = agentPosition(agent);
        if (!position) continue;
        const distance = Math.hypot(position.x - point.x, position.z - point.z);
        if (distance < best) best = distance;
      }
      for (const position of streetLifePoints) {
        const distance = Math.hypot(position.x - point.x, position.z - point.z);
        if (distance < best) best = distance;
      }
      return best;
    };
    let clearanceNote = null;
    if (pose !== 'character') {
      const back = { x: eye.x - target.x, z: eye.z - target.z };
      const backLength = Math.hypot(back.x, back.z) || 1;
      let steps = 0;
      while (nearestAgent(eye) < CAMERA_CLEARANCE && steps < 8) {
        eye = { x: eye.x + (back.x / backLength) * 0.8, z: eye.z + (back.z / backLength) * 0.8 };
        steps += 1;
      }
      if (steps) clearanceNote = `stepped back ${(steps * 0.8).toFixed(1)} m to clear a figure`;
    }
    if (clearanceNote) note = note ? `${note}; ${clearanceNote}` : clearanceNote;
    if (sunNote) note = note ? `${note}; ${sunNote}` : sunNote;
    // Stand the eye on the surface that is actually drawn under it, AFTER the
    // clearance guard has finished moving it. Everything above this line is the
    // placement model; this is the measurement, and the measurement wins.
    const eyeGround = drawnGroundAt(eye.x, eye.z, groundAt(eye.x, eye.z));
    const modelEyeGround = groundAt(eye.x, eye.z);
    const eyeHeight = {
      target: +eyeLift.toFixed(3),
      surfaceDatum: pose === 'intersection' ? 'carriageway' : 'footway',
      modelGroundY: +modelEyeGround.toFixed(3),
      modelEyeY: +eyeY.toFixed(3),
      drawnGroundY: eyeGround?.y ?? null,
      drawnGroundSurface: eyeGround?.surface ?? null,
      // Whether the camera is standing on the paved cross-section it was placed
      // against, or on the backdrop ground behind it. A street card whose eye
      // stands on the backdrop is off the pavement, and that is a framing fact
      // a reviewer should be told rather than left to infer from a name.
      standingOn: (() => {
        const name = String(eyeGround?.surface || '');
        if (/^street-surface-v2/i.test(name)) return 'drawn street cross-section';
        if (/^ground-coverage|^sf-ground-|^terrain/i.test(name)) return 'ground backdrop, NOT the paved cross-section';
        if (!name) return 'nothing measured';
        return name;
      })(),
      modelMinusDrawnM: eyeGround?.y != null ? +(modelEyeGround - eyeGround.y).toFixed(3) : null,
      rejectedHitOutsideBand: eyeGround?.rejectedOutsideBand ?? null,
      measured: !!eyeGround?.y,
    };
    if (eyeGround?.y != null) {
      eyeY = +(eyeGround.y + eyeLift).toFixed(3);
      eyeHeight.snapped = true;
    } else {
      eyeHeight.snapped = false;
      eyeHeight.note = 'no drawn surface under the camera; the eye stands on the placement model '
        + 'and its height above the frame is NOT measured';
    }
    eyeHeight.eyeY = +eyeY.toFixed(3);
    eyeHeight.heightAboveDrawnGroundM = eyeGround?.y != null ? +(eyeY - eyeGround.y).toFixed(3) : null;
    eyeHeight.ok = eyeHeight.heightAboveDrawnGroundM != null
      && Math.abs(eyeHeight.heightAboveDrawnGroundM - eyeLift) <= 0.02;
    // Same treatment for the look-at point, but with a tighter guard: a target
    // 90 m down the street can sit inside a building footprint, and a down-ray
    // that stops on a roof would aim a street card at the sky. Out-of-band hits
    // are already refused inside `drawnGroundAt`; a refusal here keeps the
    // model and says so.
    let targetGround = null;
    if (targetYOverride == null) {
      const modelTargetGround = groundAt(target.x, target.z);
      targetGround = drawnGroundAt(target.x, target.z, modelTargetGround);
      if (targetGround?.y != null) tgtY = +(targetGround.y + targetLift).toFixed(3);
    }
    if (cam.fov != null) { cam.fov = pose === 'canyon' ? 58 : 47; cam.updateProjectionMatrix(); }
    cam.position.set(eye.x, eyeY, eye.z);
    cam.lookAt(target.x, tgtY, target.z);
    if (controls?.target?.set) controls.target.set(target.x, tgtY, target.z);
    if (controls) controls.enabled = false;
    window.__QA_CAM__ = { pos: [eye.x, eyeY, eye.z], look: [target.x, tgtY, target.z] };

    // A "waterfront" card with no water in it would be fabricated evidence, so
    // the pose MEASURES the water before the round pays for a 90-190 s frame.
    // Two steps: project the water body's bounding box into screen space (free,
    // and answers "is it even in front of the camera"), then raycast a grid
    // across the horizon-down band of the frame to see how much of it is water
    // rather than quay, pier or building. The card REFUSES if it is not there.
    let waterCheck = null;
    // The pre-focus pass exists only to move the world's local-life focus; it
    // is thrown away. Running the water raycast on it would pay for the
    // measurement twice.
    if (pose === 'waterfront' && measureWater) {
      const startedAt = performance.now();
      const THREE = api.THREE;
      const waterMesh = findWater();
      // Measure from the FINAL pose. `cam.position` was set before the
      // camera-clearance guard ran, and that guard walks `eye` backwards along
      // the view ray; `__QA_CAM__` (what the pin actually applies every frame)
      // holds the stepped-back eye. Measuring the pre-step position would
      // answer a question about a camera the round never uses.
      cam.position.set(eye.x, eyeY, eye.z);
      cam.lookAt(target.x, tgtY, target.z);
      if (cam.updateProjectionMatrix) cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      if (!THREE?.Box3 || !waterMesh) {
        waterCheck = { error: 'no water mesh or no THREE handle' };
      } else {
        const box = new THREE.Box3().setFromObject(waterMesh);
        const v = new THREE.Vector3();
        let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
        let inFront = 0;
        for (let corner = 0; corner < 8; corner += 1) {
          v.set(corner & 1 ? box.max.x : box.min.x,
            corner & 2 ? box.max.y : box.min.y,
            corner & 4 ? box.max.z : box.min.z);
          const view = v.clone().applyMatrix4(cam.matrixWorldInverse);
          if (view.z >= 0) continue; // behind the camera
          inFront += 1;
          v.project(cam);
          const u = (v.x + 1) / 2;
          const w = (1 - v.y) / 2;
          if (u < minU) minU = u; if (u > maxU) maxU = u;
          if (w < minV) minV = w; if (w > maxV) maxV = w;
        }
        const clampedU = [Math.max(0, minU), Math.min(1, maxU)];
        const clampedV = [Math.max(0, minV), Math.min(1, maxV)];
        const screenArea = inFront === 0 ? 0
          : Math.max(0, clampedU[1] - clampedU[0]) * Math.max(0, clampedV[1] - clampedV[0]);
        // Then the measurement that actually matters: how much of the frame,
        // from the horizon band down, is water and not quay, pier or building.
        // The raycast runs against the same curated target list the coverage
        // grid uses (the whole 650k-triangle scene with no acceleration
        // structure costs tens of seconds); the water body survives that filter
        // because it is an unnamed child of `city-root`.
        if (typeof window.__QA_BUILD_TARGETS__ !== 'function') {
          return { ok: false, reason: 'the QA raycast target builder is not installed on this '
            + 'document (the page reloaded under the round); recover and re-pose' };
        }
        const targets = window.__QA_BUILD_TARGETS__().list;
        const COLS = 9;
        const ROWS = 6;
        let sampled = 0; let waterHits = 0; let skyHits = 0;
        const blockers = {};
        const ray = new THREE.Raycaster();
        for (let iy = 0; iy < ROWS; iy += 1) {
          // From just above the horizon band to the bottom of the frame.
          const sv = 0.42 + ((iy + 0.5) / ROWS) * 0.58;
          for (let ix = 0; ix < COLS; ix += 1) {
            const su = (ix + 0.5) / COLS;
            ray.setFromCamera({ x: su * 2 - 1, y: -(sv * 2 - 1) }, cam);
            const hit = ray.intersectObjects(targets, false)[0];
            sampled += 1;
            if (!hit) continue;
            const name = hit.object.name || hit.object.parent?.name || '(unnamed)';
            if (hit.object === waterMesh || /water|bay/i.test(name)) { waterHits += 1; continue; }
            if (window.__QA_CLASSIFY__(name) === 'sky') { skyHits += 1; continue; }
            blockers[name] = (blockers[name] || 0) + 1;
          }
        }
        waterCheck = {
          waterMesh: waterMesh.name || '(unnamed child of city-root)',
          waterY: +waterMesh.position.y.toFixed(2),
          waterBoxXZ: [+box.min.x.toFixed(1), +box.min.z.toFixed(1), +box.max.x.toFixed(1), +box.max.z.toFixed(1)],
          cornersInFrontOfCamera: inFront,
          screenBox: inFront ? [+clampedU[0].toFixed(3), +clampedV[0].toFixed(3),
            +clampedU[1].toFixed(3), +clampedV[1].toFixed(3)] : null,
          screenAreaFraction: +screenArea.toFixed(3),
          grid: [COLS, ROWS],
          gridBand: [0.42, 1],
          sampled,
          waterHits,
          skyHits,
          waterFraction: sampled ? +(waterHits / sampled).toFixed(3) : 0,
          blockers: Object.entries(blockers).sort((l, m) => m[1] - l[1]).slice(0, 6),
          targets: targets.length,
          ms: +(performance.now() - startedAt).toFixed(0),
        };
      }
      // Refuse rather than shoot a waterfront card with no water in it. The
      // bar is deliberately low: this catches "there is no water in this
      // frame", it does not grade the composition.
      //
      // The gate is the RAYCAST, not the projected bounding box. The water body
      // is a flat plane, so its bounding box has zero height: all eight corners
      // project to the same screen row and `screenAreaFraction` is exactly 0
      // for a pose that is in fact looking at nothing but water. That measured
      // 0 refused a pose whose frame was 83% water. The box projection stays as
      // a diagnostic - it still answers "is the body in front of the camera" -
      // but it decides nothing.
      const okWater = waterCheck && !waterCheck.error && waterCheck.waterFraction >= 0.06;
      if (!okWater) {
        return {
          ok: false,
          reason: 'the waterfront pose does not actually see water',
          waterCheck,
          note,
          eye: { x: +eye.x.toFixed(2), y: +eyeY.toFixed(2), z: +eye.z.toFixed(2) },
          target: { x: +target.x.toFixed(2), y: +tgtY.toFixed(2), z: +target.z.toFixed(2) },
        };
      }
    }

    const t = tallnessAt({ x: a.x, z: a.z });
    return {
      ok: true,
      traversal: traversalPlan,
      waterCheck,
      // The number a reviewer wants when they ask "what height was this shot
      // from". `eye.y` below is an ABSOLUTE world Y and is not it.
      eyeHeight,
      eyeHeightAboveDrawnGroundM: eyeHeight.heightAboveDrawnGroundM,
      targetGround: targetGround ? {
        drawnGroundY: targetGround.y, surface: targetGround.surface,
        modelGroundY: targetGround.modelY, lift: +targetLift.toFixed(2),
        rejectedHitOutsideBand: targetGround.rejectedOutsideBand,
      } : null,
      eyeInsideBuilding: insideAny(eye),
      street: chosen.streetName || null,
      segmentId: chosen.id,
      roadWidth: chosen.width || null,
      sidewalkW: chosen.sidewalkW || null,
      surroundingAvgHeight: +t.avg.toFixed(1),
      surroundingCount: t.count,
      crowdPoints: agents.length,
      streetLifeNearPoints: streetLifePoints.length,
      streetLifeAnchorSource,
      streetLifeAnchorRadius: publishedStreetLife?.radius ?? null,
      streetLifeScrapedPoints: scrapedStreetLife.length,
      nearestFigureM: +nearestAgent(eye).toFixed(2),
      note,
      eye: { x: +eye.x.toFixed(2), y: +eyeY.toFixed(2), z: +eye.z.toFixed(2) },
      target: { x: +target.x.toFixed(2), y: +tgtY.toFixed(2), z: +target.z.toFixed(2) },
      fov: cam.fov ?? null,
    };
  }, { pose, EYE, measureWater, traversal: { frames: TRAVERSAL_FRAMES, spanM: TRAVERSAL_SPAN_M, tileM: 140 } });
}

for (const card of orderedCards) {
  const entry = { id: card.id, requested: card };
  try {
    // Rebuild the world if this card needs a different window of the extract.
    // Recorded per card: a two-window round is only honest evidence if each
    // frame says which window it came from.
    const need = windowForCard(card);
    if (windowKey(need) !== windowKey(currentWindow)) {
      if (need) {
        entry.worldRebuild = await applyWindow(need, `card:${card.id}`);
        // A freshly built world is frozen at its build instant, exactly like a
        // fresh boot, so give it the same warm-up the boot window got.
        entry.rebuildWarm = await stepSimulation(SIM_WARM_S, `${card.id}:rebuild-warm`);
      } else {
        entry.worldRebuildSkipped = 'card wants the boot window but the world is on another';
      }
    }
    entry.worldWindow = currentWindowRecord;
    // One round trip, and it makes every later step on this card safe against a
    // hot reload that slipped past the navigation watcher: the pin, the render
    // gate and the shared raycast target builder all live on the document.
    await installPin().catch(() => {});
    activeHour = card.hour;
    activeWeather = card.weather || null;
    await evaluateInWorld((h) => { window.__QA_HOUR__ = h; window.__CITYGEN__.setClock?.(h); }, card.hour);
    if (card.weather) {
      // `setWeather` is a renderer method. Calling it on the __CITYGEN__ handle
      // silently returned null for every card, so the wet-street card was dry
      // and the water/weather rubric dimension had no evidence behind it.
      entry.weatherApplied = await evaluateInWorld((w) => {
        const api = window.__CITYGEN__;
        const r = api.getRenderer?.();
        if (typeof api.setWeather === 'function') return { via: 'api', applied: api.setWeather(w) ?? w };
        if (r && typeof r.setWeather === 'function') return { via: 'renderer', applied: r.setWeather(w) };
        return { via: null, applied: null };
      }, card.weather);
      // The environment rig rebuilds asynchronously; a screenshot taken in the
      // same tick records the previous weather. This one is a genuine
      // asynchronous rebuild, not a frame, so it stays a wall-clock wait.
      await page.waitForTimeout(WEATHER_SETTLE);
      entry.weatherState = await evaluateInWorld(() => {
        const r = window.__CITYGEN__.getRenderer?.();
        const fog = r?.scene?.fog;
        return {
          envWeather: r?.envWeather ?? null,
          fog: fog ? { near: +fog.near.toFixed(1), far: +fog.far.toFixed(1), color: fog.color.getHexString() } : null,
          exposure: r?.renderer?.toneMappingExposure ?? null,
        };
      });
    }
    // Pose, then let the world LIVE, then pose again.
    //
    // Every card used to sample the same frozen boot instant: the loop clamps
    // its delta to 0.05 s and a frame costs minutes, so nothing ever walked
    // anywhere and the character card had no subject to frame. The first pose
    // moves the local-life focus to where the card will be shot, the step then
    // advances the crowd deterministically around that focus, and the second
    // pose is the one that becomes evidence - it sees the crowd as it will be
    // photographed, which is also what the camera-clearance guard needs.
    const focusPose = card.pose === 'character' ? 'street' : card.pose;
    entry.prefocus = await placeCamera(focusPose, { measureWater: false });
    entry.sim = await stepSimulation(SIM_CARD_S, card.id);
    entry.pose = await placeCamera(card.pose);
    if (entry.pose?.ok) {
      activeCam = {
        pos: [entry.pose.eye.x, entry.pose.eye.y, entry.pose.eye.z],
        look: [entry.pose.target.x, entry.pose.target.y, entry.pose.target.z],
      };
    }
    if (card.pose === 'character' && entry.pose?.ok === false) {
      // Walk the world forward until somebody is actually at the kerb. The
      // guard itself is untouched: the card is only allowed to shoot a subject
      // within 30 m of the kerb point, and if nobody gets there in
      // SIM_CHARACTER_TRIES x SIM_CHARACTER_S simulated seconds the card is
      // still refused, with the nearest distance on the record.
      entry.characterSearch = [{ attempt: 0, reason: entry.pose.reason, crowd: entry.pose.crowd }];
      for (let attempt = 1; attempt <= SIM_CHARACTER_TRIES; attempt += 1) {
        const stepped = await stepSimulation(SIM_CHARACTER_S, `${card.id}:subject-${attempt}`);
        entry.pose = await placeCamera(card.pose);
        entry.characterSearch.push({
          attempt,
          simulatedSeconds: stepped?.simulatedSeconds ?? null,
          ok: entry.pose?.ok === true,
          reason: entry.pose?.ok === true ? null : entry.pose?.reason,
        });
        if (entry.pose?.ok) {
          activeCam = {
            pos: [entry.pose.eye.x, entry.pose.eye.y, entry.pose.eye.z],
            look: [entry.pose.target.x, entry.pose.target.y, entry.pose.target.z],
          };
          break;
        }
      }
      entry.characterSimulatedSeconds = entry.characterSearch
        .reduce((sum, item) => sum + (item.simulatedSeconds || 0), 0);
    }
    // A failed pose used to leave the camera wherever the previous card left it
    // and shoot anyway, so the round silently contained a duplicate frame under
    // a different card's name. That is worse than a missing card: it is false
    // evidence. Refuse, and fail the round.
    if (entry.pose?.ok === false) {
      entry.error = `pose failed: ${entry.pose.reason || 'unknown'}`;
      entry.skipped = true;
      report.cards.push(entry);
      console.error(`${card.id}: SKIPPED (${entry.error}) - no frame written`);
      continue;
    }
    if (card.pose === 'traversal' && !entry.pose?.traversal?.frames?.length) {
      // The traversal card is a strip, not a frame. If the plan is missing the
      // old code fell through to the single-frame branch and wrote
      // `08-traversal.png` from whatever pose survived - a card-shaped object
      // that is not the evidence the gate asks for. Refuse instead.
      entry.error = 'traversal plan produced no frames';
      entry.skipped = true;
      entry.traversalPlan = entry.pose?.traversal || null;
      report.cards.push(entry);
      console.error(`${card.id}: SKIPPED (${entry.error}) - no frame written`);
      continue;
    }
    // Eye height, stated per card in the terms the gate calibrates against.
    // `pose.eye.y` is an absolute world Y; a reviewer read those as eye heights
    // and reported "2.17-2.57 m against the 1.65 m human scale". The height
    // above the DRAWN surface under the camera is the number that answers that,
    // and it is asserted here rather than assumed.
    const eyeHeightRecord = card.pose === 'traversal'
      ? {
        target: EYE,
        perFrame: (entry.pose?.traversal?.frames || []).map((f) => ({
          index: f.index,
          eyeY: f.eye.y,
          drawnGroundY: f.eyeHeight?.drawnGroundY ?? null,
          heightAboveDrawnGroundM: f.eyeHeight?.heightAboveDrawnGroundM ?? null,
          modelMinusDrawnM: f.eyeHeight?.modelMinusDrawnM ?? null,
          measured: !!f.eyeHeight?.measured,
        })),
      }
      : entry.pose?.eyeHeight || null;
    entry.eyeHeight = eyeHeightRecord;
    const heights = card.pose === 'traversal'
      ? (eyeHeightRecord?.perFrame || []).map((f) => f.heightAboveDrawnGroundM).filter((v) => v != null)
      : (entry.pose?.eyeHeight?.heightAboveDrawnGroundM != null
        ? [entry.pose.eyeHeight.heightAboveDrawnGroundM] : []);
    const wantedEyeHeight = card.pose === 'character' ? EYE + 0.15 : EYE;
    if (!heights.length) {
      const message = `${card.id}: eye height NOT MEASURED - no drawn surface under the camera. `
        + 'The frame is still evidence; its scale is not asserted.';
      consoleErrors.push(message);
      console.error(`  ${message}`);
    } else {
      const worst = heights.reduce(
        (acc, v) => (Math.abs(v - wantedEyeHeight) > Math.abs(acc - wantedEyeHeight) ? v : acc),
        heights[0],
      );
      entry.eyeHeightAboveDrawnGroundM = worst;
      if (Math.abs(worst - wantedEyeHeight) > 0.02) {
        const message = `${card.id}: eye sits ${worst.toFixed(3)} m above the drawn surface, `
          + `not the ${wantedEyeHeight.toFixed(2)} m this pose asks for`;
        consoleErrors.push(message);
        console.error(`  ${message}`);
      } else {
        console.log(`  ${card.id}: eye ${worst.toFixed(3)} m above the drawn `
          + `${entry.pose?.eyeHeight?.drawnGroundSurface || 'surface'} `
          + `(placement model was ${entry.pose?.eyeHeight?.modelMinusDrawnM ?? 'n/a'} m off it)`);
      }
    }
    if (card.pose === 'traversal') {
      // The gate asks for a 30 s 60 FPS traversal clip. One frame costs minutes
      // on this rasterizer, so 1800 of them is not a thing this machine can
      // produce; the honest substitute is a numbered strip of stepped frames
      // along a real traversal path that crosses a runtime tile boundary, with
      // the simulation advanced between frames by the time the walk would take.
      const plan = entry.pose.traversal;
      entry.sequence = [];
      entry.frameFailures = [];
      for (const frame of plan.frames) {
        // One frame of the strip failing must not cost the frames already paid
        // for, so each pose is attempted independently and its failure recorded.
        try {
          if (frame.index > 0) {
            const gap = frame.distanceAlong - plan.frames[frame.index - 1].distanceAlong;
            entry.sequence.push({ stepped: await stepSimulation(gap / TRAVERSAL_SPEED_MS, `${card.id}:${frame.index}`) });
          }
          activeCam = { pos: [frame.eye.x, frame.eye.y, frame.eye.z], look: [frame.look.x, frame.look.y, frame.look.z] };
          await evaluateInWorld((f) => {
            const r = window.__CITYGEN__.getRenderer();
            window.__QA_CAM__ = { pos: [f.eye.x, f.eye.y, f.eye.z], look: [f.look.x, f.look.y, f.look.z] };
            r.camera.position.set(f.eye.x, f.eye.y, f.eye.z);
            r.camera.lookAt(f.look.x, f.look.y, f.look.z);
            if (r.controls?.target?.set) r.controls.target.set(f.look.x, f.look.y, f.look.z);
          }, frame);
          const name = `${card.id}-${String(frame.index + 1).padStart(2, '0')}.png`;
          const shot = await captureFrame(path.join(OUT, name));
          const record = { ...frame, ...shot, name };
          entry.sequence.push(record);
          console.log(`  ${name}: cell ${frame.cell.join(',')} ${shot.render.wallMs} ms frame, ${shot.shotMs} ms shot`);
        } catch (frameError) {
          const message = String(frameError).slice(0, 200);
          entry.frameFailures.push({ index: frame.index, error: message });
          consoleErrors.push(`${card.id} frame ${frame.index}: ${message.slice(0, 140)}`);
          console.error(`  ${card.id} frame ${frame.index} FAILED: ${message}`);
          if (!(await worldHandlePresent())) await recoverWorld(message);
        }
      }
      const shots = entry.sequence.filter((item) => item.file);
      entry.file = shots[0]?.file || null;
      entry.shotMs = shots.reduce((sum, item) => sum + (item.shotMs || 0), 0);
      entry.frameWallMs = shots.reduce((sum, item) => sum + (item.render?.wallMs || 0), 0);
      // Say exactly what this evidence IS, and what it is not. The gate asks
      // for a 30 s 60 FPS clip = 1800 frames. One frame costs 65-190 s on this
      // software rasterizer, so 1800 of them is roughly 40 days of wall clock
      // and is not a thing this machine can produce. The substitute is a
      // numbered strip of fully rendered frames along a real traversal path,
      // with the simulation advanced between frames by the time the walk would
      // actually take, so the world moves between frames as it would in a clip.
      // It demonstrates tile-boundary continuity and world streaming; it does
      // NOT demonstrate animation smoothness, frame pacing, or temporal
      // stability, and must not be scored as if it did.
      entry.clipForm = `stepped strip of ${shots.length} rendered frames over ${plan.spanMeters} m `
        + `of real street polyline, crossing ${plan.boundaryCrossings} runtime tile `
        + `(${plan.tileMeters} m world-partition cell) boundaries, simulation advanced `
        + `${(TRAVERSAL_SPEED_MS).toFixed(2)} m/s of walking time between frames; `
        + 'NOT a 30 s 60 FPS clip (1800 frames) - this rasterizer cannot render one. '
        + 'Evidence for tile-boundary continuity and streaming only, not for frame pacing or temporal stability';
      if (entry.frameFailures.length) {
        entry.error = `${entry.frameFailures.length} of ${plan.frames.length} traversal frames failed`;
      }
    } else {
      const shot = await captureFrame(path.join(OUT, `${card.id}.png`));
      entry.file = shot.file;
      entry.shotMs = shot.shotMs;
      entry.frame = shot.render;
      entry.frameWallMs = shot.render?.wallMs ?? null;
      entry.bytes = shot.bytes;
      // The frame statistics belong on the CARD, not only inside the capture
      // helper: they are what tells a reader who cannot see the frame that it
      // is a picture of something. Without this line they were computed and
      // then thrown away for every single-frame card.
      entry.stats = shot.stats ?? null;
      if (shot.statsError) entry.statsError = shot.statsError;
      if (shot.emptyFrameSuspected) entry.emptyFrameSuspected = shot.emptyFrameSuspected;
      if (shot.reshot) entry.reshot = shot.reshot;
    }
    // Hole detector. The rubric's automatic-reject list includes visible gaps,
    // and a 30-65s software frame inspected by eye is a bad way to find them.
    // Cast a grid of rays through the lower half of the frame: any ray that
    // reaches the sky dome, or hits nothing at all, is a hole in the ground.
    const coverageStartedAt = Date.now();
    entry.coverage = await evaluateInWorld(({ cols, rows }) => {
      const api = window.__CITYGEN__;
      // The app's own THREE. This used to dynamically import a SECOND copy of
      // three per card, which is both wasteful and a different class identity
      // from the objects it raycasts against.
      const THREE = api.THREE;
      const r = api.getRenderer();
      if (!THREE?.Raycaster) return { error: 'no THREE handle' };
      r.camera.updateMatrixWorld(true);

      // Curated target list, collected once per boot. Raycasting the whole
      // 658k-triangle scene with no acceleration structure cost ~54 s of main
      // thread per card. The list keeps everything that legitimately fills the
      // lower frame - terrain, ground, roads, footways, building shells - plus
      // the sky dome the hole test needs, and drops named street dressing.
      //
      // Dropping dressing cannot invent a hole: a ray that would have stopped
      // on a parked car now stops on the road under it, which is the correct
      // answer for "is the ground there". It COULD miss a hole whose only
      // surface is dressing (an elevated deck, say); that limit is the price of
      // the 30x saving and is stated in the round report.
      if (typeof window.__QA_BUILD_TARGETS__ !== 'function') {
        return { error: 'the QA raycast target builder is not installed on this document '
          + '(the page reloaded under the round)' };
      }
      const targets = window.__QA_BUILD_TARGETS__();

      const ray = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let holes = 0;
      let solid = 0;
      let farGround = 0;
      const worst = [];
      const far = [];
      for (let iy = 0; iy < rows; iy += 1) {
        // lower 45% of the frame: where ground/pavement must be
        const sy = 0.55 + (iy + 0.5) / rows * 0.45;
        for (let ix = 0; ix < cols; ix += 1) {
          const sx = (ix + 0.5) / cols;
          pointer.set(sx * 2 - 1, -(sy * 2 - 1));
          ray.setFromCamera(pointer, r.camera);
          const hit = ray.intersectObjects(targets.list, false)[0];
          // A ray that reaches the sky dome, or hits nothing at all, is a hole
          // in the ground. A ray that hits REAL GROUND 600 m away is not: it is
          // a long view down a straight street. Counting distance as a hole
          // reported 62.5% holes on the traversal card whose six worst samples
          // all hit `ground-coverage-v1` at 540-686 m - ground, correctly drawn.
          // The distance signal is kept, separately and by name, so nothing is
          // hidden and the historical `holeRatioLegacy` series stays comparable.
          // A ray that reaches ANY sky mesh has left the world. This used to
          // test only the name 'sky-dome', while the sky-atmosphere pass draws
          // its own dome in front of that one - so a ray to the sky was counted
          // as solid ground, and the hole ratio could not have found a hole.
          const isVoid = !hit || window.__QA_CLASSIFY__(hit.object.name || hit.object.parent?.name || '') === 'sky';
          const isFarGround = !isVoid && hit.distance > 400;
          if (isFarGround) {
            farGround += 1;
            if (far.length < 6) {
              far.push({ sx: +sx.toFixed(3), sy: +sy.toFixed(3),
                hit: hit.object.name || '(unnamed)', dist: +hit.distance.toFixed(1) });
            }
          }
          if (isVoid) {
            holes += 1;
            if (worst.length < 6) {
              worst.push({ sx: +sx.toFixed(3), sy: +sy.toFixed(3),
                hit: hit ? hit.object.name || '(unnamed)' : 'nothing',
                dist: hit ? +hit.distance.toFixed(1) : null });
            }
          } else solid += 1;
        }
      }
      const total = holes + solid;
      return {
        samples: total,
        grid: [cols, rows],
        // These three are counts of the SCENE, not of each other. `droppedDressing`
        // used to sit next to `targets` and was read across the project as "387
        // of 1036 dressing objects are missing from every frame". Nothing is
        // missing: `drawnMeshes` is every mesh in the frame, `raycastTargets` is
        // the subset this hole detector is allowed to stop on, and
        // `raycastExcludedDressing` is the rest - all of it drawn.
        drawnMeshes: targets.drawnMeshes,
        raycastTargets: targets.kept,
        raycastExcludedDressing: targets.excludedDressing,
        raycastExcludedDressingInstances: targets.excludedDressingInstances,
        meshesHiddenByAncestor: targets.hiddenByAncestor,
        streetSurfaceMeshesInTargets: targets.streetSurfaceMeshes,
        skyMeshesInTargets: targets.skyMeshes,
        testsTheDrawnStreet: targets.streetSurfaceMeshes > 0,
        raycastFilter: 'excluded from the RAYCAST TARGET LIST ONLY, to keep the hole detector off '
          + 'street dressing and 30x cheaper. Every excluded mesh is visible, has visible '
          + 'ancestors, and is drawn in the frame. drawnMeshes = raycastTargets + '
          + 'raycastExcludedDressing.',
        // Kept so the historical series stays readable, named so it cannot be
        // read as "dropped from the frame" again.
        targets: targets.kept,
        holes,
        solid,
        farGround,
        /** Rays that reached sky or nothing. This is the hole signal. */
        holeRatio: +(holes / total).toFixed(4),
        /** Rays that hit ground beyond 400 m. A long view, not a hole. */
        farGroundRatio: +(farGround / total).toFixed(4),
        /** The pre-2026-08-21 definition, which counted far ground as a hole. */
        holeRatioLegacy: +((holes + farGround) / total).toFixed(4),
        worst,
        farthest: far,
      };
    }, { cols: COVER_COLS, rows: COVER_ROWS });
    if (entry.coverage) entry.coverage.ms = Date.now() - coverageStartedAt;
    // The hole detector is only a hole detector if the drawn street is in its
    // target list. It was not, for every round this project has run.
    if (entry.coverage && entry.coverage.testsTheDrawnStreet === false) {
      const message = `${card.id}: the ground-hole raycast target list contains NO street-surface, `
        + 'ground or terrain mesh, so its hole ratio is not a statement about the street';
      consoleErrors.push(message);
      console.error(`  ${message}`);
    }

    // Optional: ask the world what actually drew at a screen pixel. A visual
    // artifact is otherwise a guessing game, and a re-boot to investigate costs
    // a full world build. Format: SF_QA_PROBE="01-street-day:0.25,0.85 0.5,0.9"
    if (PROBES.has(card.id)) {
      entry.probes = await evaluateInWorld(({ points, viewport }) => {
        const api = window.__CITYGEN__;
        const THREE = api.THREE;
        const r = api.getRenderer();
        if (!THREE?.Raycaster) return { error: 'no THREE handle' };
        const raycaster = new THREE.Raycaster();
        const out = [];
        for (const [u, v] of points) {
          raycaster.setFromCamera({ x: u * 2 - 1, y: -(v * 2 - 1) }, r.camera);
          const hits = raycaster.intersectObject(r.scene, true).slice(0, 3);
          out.push({
            u, v,
            hits: hits.map((hit) => ({
              name: hit.object.name || '(unnamed)',
              parent: hit.object.parent?.name || '(no parent)',
              passId: hit.object.userData?.passId || hit.object.parent?.userData?.passId || null,
              userData: JSON.stringify(hit.object.userData || {}).slice(0, 200),
              distance: +hit.distance.toFixed(2),
              point: { x: +hit.point.x.toFixed(2), y: +hit.point.y.toFixed(2), z: +hit.point.z.toFixed(2) },
              material: hit.object.material ? {
                type: hit.object.material.type,
                color: hit.object.material.color?.getHexString?.() || null,
                transparent: !!hit.object.material.transparent,
                opacity: hit.object.material.opacity,
                depthWrite: hit.object.material.depthWrite,
                renderOrder: hit.object.renderOrder,
              } : null,
            })),
          });
        }
        return { viewport, out };
      }, { points: PROBES.get(card.id), viewport: { w: W, h: H } });
    }

    // Per-card shadow state. The run-level block is read once at boot and
    // therefore describes the boot clock, not this card - it reported a 23.2
    // degree sun for a card whose hour puts the sun at 43.3.
    entry.shadows = await evaluateInWorld(() => {
      const r = window.__CITYGEN__.getRenderer();
      const cam = r.sun?.shadow?.camera;
      return {
        hour: window.__QA_HOUR__,
        sunIntensity: r.sun?.intensity ?? null,
        sunPosition: r.sun ? [+r.sun.position.x.toFixed(1), +r.sun.position.y.toFixed(1), +r.sun.position.z.toFixed(1)] : null,
        castShadow: r.sun?.castShadow ?? null,
        shadowIntensity: r.sun?.shadow?.intensity ?? null,
        normalBias: r.sun?.shadow?.normalBias ?? null,
        bias: r.sun?.shadow?.bias ?? null,
        camera: cam ? {
          left: +cam.left.toFixed(1), right: +cam.right.toFixed(1),
          top: +cam.top.toFixed(1), bottom: +cam.bottom.toFixed(1),
          near: +cam.near.toFixed(1), far: +cam.far.toFixed(1),
        } : null,
        fit: r.shadowDiagnostics ? {
          texelsPerMetre: r.shadowDiagnostics.texelsPerMetre,
          sunAltitudeDeg: r.shadowDiagnostics.sunAltitudeDeg,
          fitted: r.shadowDiagnostics.fitted,
          warnings: r.shadowDiagnostics.warnings,
          casting: r.shadowDiagnostics.casterPolicy?.casting ?? null,
        } : null,
        hemi: r.hemi?.intensity ?? null,
        ambient: r.ambient?.intensity ?? null,
        environmentIntensity: r.scene?.environmentIntensity ?? null,
      };
    });

    // SF_QA_KEYOFF=1 shoots a second frame per card with the key light off.
    // Differencing the two isolates exactly what the sun contributes and where:
    // a real cast shadow appears as a hard boundary in the difference, and a
    // frame with no shadows shows a smooth falloff and nothing else. This is
    // the only way to answer "is the sun casting" from a screenshot.
    if (process.env.SF_QA_KEYOFF === '1') {
      await evaluateInWorld(() => {
        const r = window.__CITYGEN__.getRenderer();
        window.__QA_KEY__ = r.sun.intensity;
        r.sun.intensity = 0;
      });
      entry.keyOff = await captureFrame(path.join(OUT, `${card.id}-keyoff.png`));
      await evaluateInWorld(() => {
        const r = window.__CITYGEN__.getRenderer();
        r.sun.intensity = window.__QA_KEY__;
      });
      entry.keyOffFrame = `${card.id}-keyoff.png`;
    }

    entry.held = await evaluateInWorld(() => {
      const r = window.__CITYGEN__.getRenderer();
      const c = window.__QA_CAM__;
      const p = r.camera.position;
      return {
        cameraDriftM: c ? +Math.hypot(p.x - c.pos[0], p.y - c.pos[1], p.z - c.pos[2]).toFixed(3) : null,
        hour: window.__QA_HOUR__,
        clock: +window.__CITYGEN__.getState().clock.toFixed(2),
      };
    });

    // What this card's frame actually cost, and what it drew. The next wave
    // adds ambient occlusion, an AA resolve and possibly a cascade split onto a
    // rasterizer where one frame already costs minutes; without a per-card
    // attribution the round after this one can simply fail to finish with
    // nobody able to say which change did it.
    entry.telemetry = await evaluateInWorld(() => {
      const api = window.__CITYGEN__;
      const r = api.getRenderer();
      const info = r.renderer?.info || null;
      return {
        // Counters snapshotted inside the frame wrapper, at the moment this
        // card's frame finished. `renderer.info` read here would describe an
        // idle world, which is how it reported 0 draw calls for a captured card.
        renderInfoAtFrame: window.__QA_RENDER_INFO__ || null,
        renderInfoNow: info ? {
          render: info.render ? { ...info.render } : null,
          memory: info.memory ? { ...info.memory } : null,
          programs: Array.isArray(info.programs) ? info.programs.length : (info.programs ?? null),
        } : null,
        performance: typeof api.getPerformanceTelemetry === 'function' ? api.getPerformanceTelemetry() : null,
        // The app's own frame timer runs over EVERY animation-loop tick, and
        // this harness gates `renderFrame` off for all of them except the ones
        // it pays for. Its percentiles therefore describe suppressed no-op
        // ticks, not rendered frames: a card that cost 173 s of wall clock to
        // draw sits next to `appFrameMs.p50 = 7`. Say so, in the field.
        performanceCaveat: 'appFrameMs/frameIntervalMs percentiles are measured over animation-loop '
          + 'ticks in which this harness SUPPRESSED drawing. They are not frame times for the '
          + 'captured frames and must not be read as an FPS figure. The rendered-frame cost is '
          + 'frameCostAttribution.frameWallMs (wall clock to draw one frame) and cpuFrameMs '
          + '(main-thread ms inside renderFrame).',
        // Per-card cost attribution for the things this build just added. A
        // round that fails to finish must be able to say WHICH stage did it.
        pipeline: typeof r.getImagePipeline === 'function' ? r.getImagePipeline() : null,
        cascade: r.shadowDiagnostics?.cascade ? {
          installed: r.shadowDiagnostics.cascade.installed,
          count: Array.isArray(r.shadowDiagnostics.cascade.cascades)
            ? r.shadowDiagnostics.cascade.cascades.length : null,
          shadowPassesPerFrame: r.shadowDiagnostics.cascade.shadowPassesPerFrame ?? null,
          texelBytes: r.shadowDiagnostics.cascade.texelBytes ?? null,
          reason: r.shadowDiagnostics.cascade.reason ?? null,
        } : null,
        localLights: r.localLightDiagnostics ? {
          pass: r.localLightDiagnostics.pass ?? null,
          candidates: r.localLightDiagnostics.candidates ?? null,
          active: r.localLightDiagnostics.active ?? null,
          budget: r.localLightDiagnostics.budget ?? null,
          shadowRefreshes: r.localLightDiagnostics.shadowRefreshes ?? null,
        } : null,
        // Counted from the scene, not from a pass's own record of itself.
        lightsInScene: (() => {
          const counts = { total: 0, visible: 0, casting: 0, byType: {} };
          r.scene.traverse((object) => {
            if (!object.isLight) return;
            counts.total += 1;
            if (object.visible !== false) counts.visible += 1;
            if (object.castShadow) counts.casting += 1;
            const key = object.type || 'Light';
            counts.byType[key] = (counts.byType[key] || 0) + 1;
          });
          return counts;
        })(),
        drawnFrames: window.__QA_FRAMES__ | 0,
      };
    });
    // One row per card, so a reviewer can attribute the frame cost across the
    // ambient-occlusion pass, the shadow cascades and the night practicals
    // without reading five nested objects.
    entry.frameCostAttribution = {
      frameWallMs: entry.frameWallMs ?? null,
      screenshotMs: entry.shotMs ?? null,
      cpuFrameMs: entry.frame?.cpuFrameMs ?? null,
      postChainMs: entry.telemetry?.pipeline?.lastRenderMs ?? null,
      postChainEnabled: entry.telemetry?.pipeline?.enabled ?? null,
      ao: entry.telemetry?.pipeline?.ao ?? null,
      antialias: entry.telemetry?.pipeline?.antialias ?? null,
      sceneSamples: entry.telemetry?.pipeline?.sceneSamples ?? null,
      shadowPassesPerFrame: entry.telemetry?.cascade?.shadowPassesPerFrame ?? null,
      shadowCascades: entry.telemetry?.cascade?.count ?? null,
      shadowDepthBytes: entry.telemetry?.cascade?.texelBytes ?? null,
      localLightsActive: entry.telemetry?.localLights?.active ?? null,
      localLightShadowRefreshes: entry.telemetry?.localLights?.shadowRefreshes ?? null,
      lightsInScene: entry.telemetry?.lightsInScene ?? null,
      drawCalls: entry.telemetry?.renderInfoAtFrame?.render?.drawCalls ?? null,
      triangles: entry.telemetry?.renderInfoAtFrame?.render?.triangles ?? null,
      note: 'frameWallMs is wall clock from arming the render flag to the frame counter moving, on '
        + 'a software rasterizer with no GPU. postChainMs is the image pipeline\'s own last-frame '
        + 'cost, which is where ambient occlusion and the AA resolve are paid.',
    };
  } catch (e) {
    // ISOLATION. One card failing must never end a round that has already paid
    // for its boot and its earlier cards: the failure is recorded on the card,
    // the world is put back if it is what broke, and the loop moves on. The
    // round then reports itself incomplete and names the card - honestly - at
    // the end, instead of dying with a stack trace and no report.
    entry.error = String(e?.stack || e).slice(0, 400);
    console.error(`${card.id}: FAILED ${entry.error.slice(0, 200)}`);
    try {
      if (!(await worldHandlePresent())) {
        entry.recovery = await recoverWorld(`card ${card.id}: ${String(e).slice(0, 140)}`);
        entry.recovered = true;
      }
    } catch (recoveryError) {
      entry.recoveryError = String(recoveryError).slice(0, 200);
      consoleErrors.push(`card ${card.id} recovery failed: ${entry.recoveryError}`);
    }
  } finally {
    // A card that threw mid-frame can leave the loop drawing. Every subsequent
    // `page.evaluate` would then queue behind unwanted 65-190 s frames.
    await stopRendering();
  }
  entry.frameDelivered = !!entry.file;
  report.cards.push(entry);
  console.log(`${card.id}: ${entry.error
    ? `FAILED ${entry.error}${entry.frameDelivered ? ' (the FRAME is on disk; the failure is after it)' : ''}`
    : `ok frame ${entry.frameWallMs ?? '?'}ms shot ${entry.shotMs}ms coverage ${entry.coverage?.ms ?? '?'}ms`}`);
}

// Run-level technical evidence. Read AFTER the cards, because a shadow render
// target does not exist until something has actually been drawn.
report.runtime = await evaluateInWorld(() => {
  const api = window.__CITYGEN__;
  const r = api.getRenderer();
  const gl = r.renderer;
  // Every field below is diagnostics. One throwing accessor must not be able
  // to delete the whole block - that is exactly what happened the first time.
  const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
  const shadow = r.sun?.shadow || null;
  const map = shadow?.map || null;
  const requested = shadow?.mapSize ? [shadow.mapSize.width, shadow.mapSize.height] : null;
  const allocated = map
    ? [map.width ?? map.texture?.image?.width ?? null, map.height ?? map.texture?.image?.height ?? null]
    : null;
  // EVERY shadow-casting light, not just the key.
  //
  // There is a standing suspicion that shadow render targets fail to allocate
  // silently on this backend, and a cascade rig multiplies the number of
  // targets a build depends on. Reading only `sun.shadow` would assert nothing
  // about cascades 1..n, so the scene is walked and each casting light reports
  // requested-vs-allocated on its own. Assert-and-log: this records what the
  // runtime got, it relaxes nothing.
  const shadowLights = safe(() => {
    const out = [];
    r.scene.traverse((object) => {
      if (!object.isLight || !object.castShadow) return;
      const s2 = object.shadow;
      const m2 = s2?.map;
      const req = s2?.mapSize ? [s2.mapSize.width, s2.mapSize.height] : null;
      const got = m2 ? [m2.width ?? m2.texture?.image?.width ?? null,
        m2.height ?? m2.texture?.image?.height ?? null] : null;
      out.push({
        name: object.name || object.type || '(unnamed light)',
        type: object.type || null,
        layers: object.layers?.mask ?? null,
        requested: req,
        allocated: got,
        exists: !!m2,
        matchesRequest: !!(req && got && req[0] === got[0] && req[1] === got[1]),
      });
    });
    return out;
  }, []);
  return {
    backend: {
      rendererBackend: safe(() => api.getState().rendererBackend),
      // Coerced, so "false" (the WebGL2 fallback) is distinguishable from
      // "null" (the read failed). It reported null for both before.
      isWebGPUBackend: safe(() => (gl?.backend ? !!gl.backend.isWebGPUBackend : null)),
      isWebGLBackend: safe(() => (gl?.backend ? !!gl.backend.isWebGLBackend : null)),
      backendName: safe(() => gl?.backend?.constructor?.name || null),
      samples: safe(() => gl?.samples ?? null),
      pixelRatio: safe(() => gl?.getPixelRatio?.() ?? null),
      // `getDrawingBufferSize` writes into a THREE.Vector2 - a plain object
      // throws inside the renderer and took the whole telemetry block with it.
      drawingBufferSize: (() => {
        try {
          const V = api.THREE?.Vector2;
          if (!V || !gl?.getDrawingBufferSize) return null;
          const size = gl.getDrawingBufferSize(new V());
          return [size.x, size.y];
        } catch (error) { return { error: String(error).slice(0, 120) }; }
      })(),
      outputColorSpace: gl?.outputColorSpace ?? null,
      toneMappingExposure: gl?.toneMappingExposure ?? null,
    },
    shadowTarget: {
      requested,
      allocated,
      // Assert-and-log only: this records what the runtime got, it does not
      // relax anything.
      matchesRequest: !!(requested && allocated && requested[0] === allocated[0] && requested[1] === allocated[1]),
      exists: !!map,
      type: map?.constructor?.name || null,
      // Per-light, so a cascade rig is covered too.
      lights: shadowLights,
      allLightsMatch: Array.isArray(shadowLights) && shadowLights.length > 0
        && shadowLights.every((l) => l.exists && l.matchesRequest),
      cascade: safe(() => {
        const c = r.shadowDiagnostics?.cascade;
        if (!c) return null;
        return {
          installed: c.installed, initialised: c.initialised, reason: c.reason,
          count: Array.isArray(c.cascades) ? c.cascades.length : null,
          shadowPassesPerFrame: c.shadowPassesPerFrame ?? null,
          texelBytes: c.texelBytes ?? null,
          cascades: Array.isArray(c.cascades) ? c.cascades : null,
        };
      }),
    },
    boot: safe(() => (typeof api.getBootPhases === 'function' ? api.getBootPhases() : null)),
    performance: safe(() => (typeof api.getPerformanceTelemetry === 'function' ? api.getPerformanceTelemetry() : null)),
    performanceCaveat: 'appFrameMs/frameIntervalMs are measured over animation-loop ticks in which '
      + 'this harness SUPPRESSED drawing (see installPin). They are NOT frame times for the '
      + 'captured frames and are not an FPS figure. Per-card rendered-frame cost is in '
      + 'frameCost and in each card\'s frameCostAttribution.',
    imagePipeline: safe(() => (typeof r.getImagePipeline === 'function' ? r.getImagePipeline() : null)),
    localLights: safe(() => r.localLightDiagnostics ?? null),
    drawnFrames: window.__QA_FRAMES__ | 0,
  };
}).catch((error) => ({ error: String(error).slice(0, 200) }));

// What the raycast filter excluded, and proof that it is still in the frame.
//
// The round-4 report said `droppedDressing: 387` next to `targets: 1036` and
// that pair was read as "37% of street dressing is missing from every frame".
// It never meant that. This block states the scene totals, names the excluded
// meshes, and checks the only way dressing could actually be absent from a
// frame - a hidden ancestor, which `Object3D.traverse` does not report.
report.dressingInFrame = await evaluateInWorld(() => {
  if (typeof window.__QA_BUILD_TARGETS__ !== 'function') {
    return { error: 'the QA raycast target builder is not installed on this document' };
  }
  const bundle = window.__QA_BUILD_TARGETS__();
  const named = Object.entries(bundle.excludedByName || {})
    .sort((left, right) => right[1] - left[1]);
  return {
    drawnMeshes: bundle.drawnMeshes,
    raycastTargets: bundle.kept,
    raycastExcludedDressing: bundle.excludedDressing,
    raycastExcludedDressingInstances: bundle.excludedDressingInstances,
    meshesHiddenByAncestor: bundle.hiddenByAncestor,
    excludedByName: named.slice(0, 24),
    distinctExcludedNames: named.length,
    keptByName: Object.entries(bundle.keptByName || {}).sort((l, m) => m[1] - l[1]).slice(0, 24),
    streetSurfaceMeshesInTargets: bundle.streetSurfaceMeshes,
    skyMeshesInTargets: bundle.skyMeshes,
    classifier: 'names are matched at the START of the name. The previous substring filter dropped '
      + 'every mesh whose name begins with "street-", because the word "street" contains "tree" - '
      + 'so street-surface-v2:carriageway, :concrete and :markings, plus ground-coverage-v1:carpet '
      + '("car"), were all excluded, and the ground-hole tripwire had no road, kerb, footway or '
      + 'markings in its target list at all.',
    meaning: 'raycastExcludedDressing counts meshes excluded from the HARNESS RAYCAST TARGET LIST. '
      + 'They are visible, their ancestors are visible, and they are drawn. Nothing here is missing '
      + 'from a frame. drawnMeshes = raycastTargets + raycastExcludedDressing.',
    absentFromFrame: bundle.hiddenByAncestor,
    absentFromFrameNames: Object.entries(bundle.hiddenByAncestorNames || {}).sort((l, m) => m[1] - l[1]).slice(0, 16),
    absentFromFrameMeaning: 'meshes whose own .visible is true but which sit under a hidden '
      + 'ancestor, so they are NOT drawn. This is the only count on this block that means '
      + '"missing from the frame".',
  };
}).catch((error) => ({ error: String(error).slice(0, 200) }));
if (report.dressingInFrame && !report.dressingInFrame.error) {
  const d = report.dressingInFrame;
  console.log(`\nscene meshes drawn: ${d.drawnMeshes} `
    + `(${d.raycastTargets} are harness raycast targets, ${d.raycastExcludedDressing} are street `
    + `dressing excluded from the raycast list ONLY - all ${d.drawnMeshes} are in the frame); `
    + `${d.meshesHiddenByAncestor} mesh(es) hidden by an ancestor and therefore NOT drawn`);
}

if (report.runtime?.backend) {
  console.log(`\nbackend: ${report.runtime.backend.rendererBackend} `
    + `isWebGPUBackend=${report.runtime.backend.isWebGPUBackend} samples=${report.runtime.backend.samples} `
    + `drawingBuffer=${JSON.stringify(report.runtime.backend.drawingBufferSize)}`);
}
if (report.runtime?.shadowTarget) {
  const st = report.runtime.shadowTarget;
  // The precondition. Three allocates a light's shadow map lazily, on the first
  // frame that renders it, so an undrawn world legitimately has none.
  const drawnOnThisWorld = (report.runtime.drawnFrames ?? 0) - worldFrameBase;
  st.framesDrawnOnCurrentWorld = drawnOnThisWorld;
  st.assertable = drawnOnThisWorld > 0;
  const line = `shadow map: requested ${JSON.stringify(st.requested)} allocated ${JSON.stringify(st.allocated)}`;
  if (!st.assertable) {
    st.note = 'NOT ASSERTED: no frame has been drawn on the current world since it was rebuilt or '
      + 'recovered, and three allocates a shadow map on first render. This is NOT evidence that '
      + 'shadow targets fail to allocate.';
    console.log(`${line} - not asserted (${drawnOnThisWorld} frame(s) drawn on the current world)`);
  } else if (st.exists && st.matchesRequest) console.log(line);
  else {
    console.error(`${line} - MISMATCH or not allocated`);
    consoleErrors.push(`shadow render target ${st.exists ? 'mismatched' : 'never allocated'}: ${line}`);
  }
  for (const light of (st.assertable ? st.lights : []) || []) {
    const detail = `shadow light "${light.name}": requested ${JSON.stringify(light.requested)} `
      + `allocated ${JSON.stringify(light.allocated)}`;
    if (light.exists && light.matchesRequest) console.log(`  ${detail}`);
    else {
      console.error(`  ${detail} - ${light.exists ? 'MISMATCH' : 'NEVER ALLOCATED'}`);
      consoleErrors.push(`shadow target ${light.exists ? 'mismatched' : 'never allocated'} for ${light.name}: ${detail}`);
    }
  }
  if (st.cascade) {
    console.log(`  cascade rig: installed=${st.cascade.installed} count=${st.cascade.count} `
      + `passes/frame=${st.cascade.shadowPassesPerFrame} depthBytes=${st.cascade.texelBytes}`);
  }
}
if (report.runtime?.boot?.phases?.length) {
  console.log('boot phases:');
  for (const phase of report.runtime.boot.phases) {
    console.log(`  ${phase.name}: ${(phase.ms / 1000).toFixed(1)}s`);
  }
  const prewarm = report.runtime.boot.prewarm;
  if (prewarm) {
    console.log(`  lighting warm-up: ${(prewarm.ms / 1000).toFixed(1)}s `
      + `(${prewarm.skipped ? `skipped: ${prewarm.skipped}` : `ran at ${JSON.stringify(prewarm.warmSize)}`})`);
  }
}
const framed = report.cards.filter((c) => c.frameWallMs != null);
if (framed.length) {
  report.frameCost = {
    perCardWallMs: Object.fromEntries(framed.map((c) => [c.id, c.frameWallMs])),
    perCardShotMs: Object.fromEntries(framed.map((c) => [c.id, c.shotMs])),
    totalFrameWallMs: framed.reduce((sum, c) => sum + c.frameWallMs, 0),
    totalShotMs: framed.reduce((sum, c) => sum + (c.shotMs || 0), 0),
  };
  console.log('\nper-card rendered-frame cost (wall ms to draw, then ms to copy the surface):');
  for (const c of framed) console.log(`  ${c.id}: ${c.frameWallMs} ms frame, ${c.shotMs} ms screenshot`);
}

// What a review-protocol round would COST. The gate's blind review needs
// >= 1440p; iteration rounds run smaller and say so.
//
// The obvious model - "software rasterization is fragment-bound, so scale by
// pixels" - is WRONG on this box, and measurement says so: a 2.8x change in
// fragment count moved the measured cost by about 1.6x. There is a per-card
// floor no resolution reduction can touch (scene walk, draw submission, surface
// readback, PNG encode setup) plus a per-megapixel slope. The estimate keeps
// the measured SLOPE and re-anchors the INTERCEPT on this round's own measured
// cost, so it improves as rounds accumulate; a resolution-independent floor and
// a pure linear-in-pixels ceiling are reported either side of it.
// Refitted by `scripts/qa/estimate-protocol-round-v1.mjs`, which reads every
// capture report on disk, drops each run's first frame (it costs 1.4-1.8x the
// rest and is paid once per round, not once per card) and least-squares fits
// steady-state frame cost against megapixels:
//
//   0.5184 Mpx (960x540)   steady mean  94 s   (.qa-card-debug, 2 frames)
//   1.4400 Mpx (1600x900)  steady mean 149 s   (.qa-round4, 5 frames)
//   1.4400 Mpx (1600x900)  steady mean 173 s   (.qa-round5, 3 frames)
//   fit: 72.6 s per megapixel + 56.2 s fixed, r2 0.912
//
// The two 1600x900 means are 24 s apart on the SAME resolution and DIFFERENT
// builds, which is the size of the build drift this slope carries along with
// the fragment cost. Treat the band, not the point.
const COST_SLOPE_MS_PER_MEGAPIXEL = 72600;
if (framed.length) {
  const pixels = W * H;
  const protocolPixels = 2560 * 1440;
  const scale = protocolPixels / pixels;
  const megapixels = pixels / 1e6;
  const protocolMegapixels = protocolPixels / 1e6;
  const singleCards = framed.filter((c) => c.id !== '08-traversal');
  const perSingle = singleCards.length
    ? singleCards.reduce((sum, c) => sum + (c.frameWallMs || 0) + (c.shotMs || 0), 0) / singleCards.length
    : null;
  const traversal = report.cards.find((c) => c.id === '08-traversal');
  const traversalFrames = (traversal?.sequence || []).filter((item) => item.file).length || TRAVERSAL_FRAMES;
  const roundMs = (perCard) => Math.round((report.bootMs || 45000)
    + perCard * (7 + traversalFrames)
    + (report.worldWindows || []).length * 30000);
  report.protocolEstimate = perSingle ? {
    measuredAt: { w: W, h: H, pixels },
    protocol: { w: 2560, h: 1440, pixels: protocolPixels, pixelScale: +scale.toFixed(2) },
    measuredPerSingleCardMs: Math.round(perSingle),
    model: {
      slopeMsPerMegapixel: COST_SLOPE_MS_PER_MEGAPIXEL,
      anchoredFixedMs: Math.round(perSingle - COST_SLOPE_MS_PER_MEGAPIXEL * megapixels),
      perCardMs: Math.round(perSingle + COST_SLOPE_MS_PER_MEGAPIXEL * (protocolMegapixels - megapixels)),
      fullRoundMs: roundMs(perSingle + COST_SLOPE_MS_PER_MEGAPIXEL * (protocolMegapixels - megapixels)),
    },
    perCardMsFloor: Math.round(perSingle),
    perCardMsCeiling: Math.round(perSingle * scale),
    fullRoundMsFloor: roundMs(perSingle),
    fullRoundMsCeiling: roundMs(perSingle * scale),
    // The linear-in-pixels ceiling is an extrapolation, and extrapolating 7x
    // from a 960x540 iteration round produces a number (hours per card) that
    // measurement has already contradicted. Say when it is worth reading.
    ceilingMeaningful: scale <= 3,
    // Cards measured, and whether the round's own first-frame warm-up premium
    // (1.4-2.3x, paid once per round) is diluted or dominating this mean.
    singleCardsMeasured: singleCards.length,
    traversalFramesAssumed: traversalFrames,
    basis: 'per-card cost = frame wall ms + screenshot ms for cards other than 08, measured this '
      + 'round. `model` keeps the ~52 s/megapixel slope measured between 960x540 and 1600x900 and '
      + 're-anchors it on this round; `floor` assumes resolution-independence, `ceiling` assumes '
      + 'pure linearity in fragment count. All include the boot and one world rebuild per extra '
      + 'window; all exclude SF_QA_KEYOFF second frames',
    caveat: '2560x1440 with MSAA also raises peak GPU/CPU memory, and this box has ~2 GB free. '
      + 'A protocol round can fail for memory reasons neither bound predicts. Nothing here is a '
      + 'measurement AT 1440p - no card has been captured at that size.',
    fullRoundMinutes: {
      floor: +(roundMs(perSingle) / 60000).toFixed(0),
      model: +(roundMs(perSingle + COST_SLOPE_MS_PER_MEGAPIXEL * (protocolMegapixels - megapixels)) / 60000).toFixed(0),
      ceiling: +(roundMs(perSingle * scale) / 60000).toFixed(0),
    },
    keyOffDoubles: process.env.SF_QA_KEYOFF === '1',
    refitWith: 'node scripts/qa/estimate-protocol-round-v1.mjs (reads every capture report on disk '
      + 'and refits the slope; this in-round estimate uses only this round plus the recorded slope)',
  } : null;
  if (report.protocolEstimate) {
    const e = report.protocolEstimate;
    console.log(`\nprotocol (2560x1440) estimate: ${(e.model.perCardMs / 1000).toFixed(0)}s per single card `
      + `(band ${(e.perCardMsFloor / 1000).toFixed(0)}-${(e.perCardMsCeiling / 1000).toFixed(0)}s), `
      + `${(e.model.fullRoundMs / 60000).toFixed(0)} min for a full 8-card round`
      + (e.ceilingMeaningful
        ? ` (band ${(e.fullRoundMsFloor / 60000).toFixed(0)}-${(e.fullRoundMsCeiling / 60000).toFixed(0)} min). `
        : `; the linear ceiling is a ${e.protocol.pixelScale}x extrapolation from this resolution and is not worth reading. `)
      + 'Estimate, not a measurement: no card has been captured at 1440p.');
  }
}

// Eye height, run level, in one place a reviewer can find it. The gate
// calibrates human scale at 1.65 m; `pose.eye.y` is an absolute world Y and
// reading it as an eye height is what produced the "2.17-2.57 m" finding.
const withEye = report.cards.filter((c) => c.eyeHeightAboveDrawnGroundM != null);
report.eyeHeights = {
  targetM: EYE,
  characterCardTargetM: +(EYE + 0.15).toFixed(2),
  measuredAgainst: 'a ray dropped onto the drawn surface under the final camera position, after '
    + 'the clearance guard has finished moving it - not the placement model',
  perCard: report.cards.map((c) => ({
    id: c.id,
    eyeWorldY: c.pose?.eye?.y ?? null,
    drawnGroundY: c.eyeHeight?.drawnGroundY ?? null,
    heightAboveDrawnGroundM: c.eyeHeightAboveDrawnGroundM ?? null,
    surface: c.eyeHeight?.drawnGroundSurface ?? null,
    standingOn: c.eyeHeight?.standingOn ?? null,
    placementModelErrorM: c.eyeHeight?.modelMinusDrawnM ?? null,
  })),
  allWithinToleranceOfTarget: withEye.length > 0 && withEye.every((c) => {
    const want = c.id === '07-character-curb' ? EYE + 0.15 : EYE;
    return Math.abs(c.eyeHeightAboveDrawnGroundM - want) <= 0.02;
  }),
  unmeasured: report.cards.filter((c) => c.file && c.eyeHeightAboveDrawnGroundM == null).map((c) => c.id),
  note: 'pose.eye.y is an ABSOLUTE WORLD Y (terrain + street cross-section + eye). It is not the '
    + 'eye height. heightAboveDrawnGroundM is.',
};
if (withEye.length) {
  console.log('\neye height above the drawn surface (gate calibrates human scale at 1.65 m):');
  for (const c of report.eyeHeights.perCard) {
    if (c.heightAboveDrawnGroundM == null) continue;
    console.log(`  ${c.id}: ${c.heightAboveDrawnGroundM.toFixed(3)} m above ${c.surface} `
      + `(world Y ${c.eyeWorldY}, placement model off by ${c.placementModelErrorM} m)`);
  }
}

const covered = report.cards.filter((c) => c.coverage);
report.coverageSummary = covered.length ? {
  cards: covered.length,
  worstCard: covered.slice().sort((a, b) => b.coverage.holeRatio - a.coverage.holeRatio)[0]?.id || null,
  maxHoleRatio: Math.max(...covered.map((c) => c.coverage.holeRatio)),
  meanHoleRatio: +(covered.reduce((s2, c) => s2 + c.coverage.holeRatio, 0) / covered.length).toFixed(4),
} : null;
if (report.coverageSummary) {
  console.log(`\nground coverage: worst card ${report.coverageSummary.worstCard} `
    + `${(report.coverageSummary.maxHoleRatio * 100).toFixed(1)}% holes, `
    + `mean ${(report.coverageSummary.meanHoleRatio * 100).toFixed(1)}%`);
  for (const c of covered) {
    console.log(`  ${c.id}: ${(c.coverage.holeRatio * 100).toFixed(1)}% of lower-frame rays reach sky/void`
      + `, ${((c.coverage.farGroundRatio ?? 0) * 100).toFixed(1)}% hit ground beyond 400 m (a long view, not a hole)`);
  }
}

report.rendererCrashes = crashes;
report.worldWindowSummary = {
  boot: report.world?.windowCentre
    ? `runtime default (centre ${JSON.stringify(report.world.windowCentre)})`
    : 'runtime default (centre not reported)',
  rebuilds: (report.worldWindows || []).map((w) => ({ source: w.source, center: w.center, radius: w.radius, rebuildMs: w.rebuildMs })),
  perCard: report.cards.map((c) => ({
    id: c.id,
    window: c.worldWindow?.center
      ? windowKey({ center: c.worldWindow.center, radius: c.worldWindow.radius })
      : 'boot',
    windowSource: c.worldWindow?.source || 'boot',
  })),
};
// Fields in this report that have been MISREAD, and what they mean. Each entry
// is here because a reader acted on the wrong meaning and a round was scored,
// or a change was planned, on the strength of it.
report.readingNotes = [
  'pose.eye.y is an ABSOLUTE WORLD Y (terrain + street cross-section + eye height), not an eye '
    + 'height. The eye height is eyeHeights.perCard[].heightAboveDrawnGroundM, measured by dropping '
    + 'a ray onto the surface the camera actually stands over. Reading eye.y as an eye height '
    + 'produced the finding "cards were shot at 2.17-2.57 m".',
  'coverage.raycastTargets and coverage.raycastExcludedDressing are two counts of the same scene, '
    + 'not a ratio. The exclusion applies to the HARNESS RAYCAST TARGET LIST only; every excluded '
    + 'mesh is drawn. dressingInFrame.absentFromFrame is the only count that means "not in the '
    + 'frame". The old field name droppedDressing produced the finding "37% of street dressing is '
    + 'missing from every frame".',
  'runtime.performance.appFrameMs and frameIntervalMs are measured over animation-loop ticks in '
    + 'which this harness SUPPRESSED drawing. They are not frame times and not an FPS figure. Use '
    + 'frameCost and each card\'s frameCostAttribution.',
  'resolution.requestedFromEnv holds the raw SF_QA_W/SF_QA_H/SF_QA_PROTOCOL strings this process '
    + 'received. resolution.agreement compares the request, the browser viewport and the pixel size '
    + 'of the PNGs. roundStatus.meetsProtocolResolution is decided from the WRITTEN PIXELS.',
  'traversal evidence is a stepped strip of fully rendered frames, not a 30 s 60 FPS clip. See '
    + 'traversalEvidence.form for what it does and does not demonstrate.',
];
report.protocolResolution = PROTOCOL;
report.settings = {
  skipPrewarm: SKIP_PREWARM,
  settleFrames: SETTLE_FRAMES,
  simWarmSeconds: SIM_WARM_S,
  simCardSeconds: SIM_CARD_S,
  simStepSeconds: SIM_STEP_S,
  simCharacterSeconds: SIM_CHARACTER_S,
  simCharacterTries: SIM_CHARACTER_TRIES,
  coverageGrid: [COVER_COLS, COVER_ROWS],
  traversalFrames: TRAVERSAL_FRAMES,
  traversalSpanMeters: TRAVERSAL_SPAN_M,
  traversalSpeedMps: TRAVERSAL_SPEED_MS,
  weatherSettleMs: WEATHER_SETTLE,
  worldWindow: WORLD_WINDOW,
  waterfrontWindow: WATERFRONT_WINDOW,
  maxRecoveries: MAX_RECOVERIES,
  keyOff: process.env.SF_QA_KEYOFF === '1',
  eyeHeightM: EYE,
  raycastFilterVersion: 'anchored-prefix-v2 (2026-08-21)',
  raycastFilterNote: 'The previous substring filter excluded every drawn street-surface mesh from '
    + 'the raycast target list (the pattern "tree" matches the word "street"), and the hole test '
    + 'recognised only the mesh named "sky-dome" while the sky-atmosphere pass draws its own dome '
    + 'in front of it. holeRatio figures from rounds before this version were measured against a '
    + 'target list with no road in it and a sky that counted as solid ground; they are NOT '
    + 'comparable with this round.',
};
const traversalCard = report.cards.find((c) => c.id === '08-traversal');
if (traversalCard?.clipForm) {
  report.traversalEvidence = {
    form: traversalCard.clipForm,
    frames: (traversalCard.sequence || []).filter((item) => item.file).map((item) => item.name),
    plan: traversalCard.pose?.traversal || null,
  };
  console.log(`\ntraversal evidence: ${traversalCard.clipForm}`);
}
const waterfrontCard = report.cards.find((c) => c.id === '04-waterfront');
if (waterfrontCard) {
  // Say what the water in this card IS. The prebuilt OSM slice this route
  // loads carries no water/bay/beach polygons in ANY window - `city.water` is
  // empty everywhere - so the card is not standing in front of surveyed
  // shoreline geometry. It is standing on the real shoreline STREET, in front
  // of the renderer's own bay surface, which is placed at the eastern edge of
  // the loaded window's bounds. That is legitimate evidence for the water and
  // weather rubric dimension and for shoreline framing; it is not evidence
  // that the shoreline is surveyed, and a reviewer must be told which.
  report.waterfrontEvidence = {
    delivered: !!waterfrontCard.file,
    reason: waterfrontCard.file ? null : (waterfrontCard.error || 'not captured'),
    window: waterfrontCard.worldWindow
      ? { center: waterfrontCard.worldWindow.center, radius: waterfrontCard.worldWindow.radius }
      : 'boot',
    street: waterfrontCard.pose?.street || null,
    waterCheck: waterfrontCard.pose?.waterCheck || null,
    provenance: 'shoreline STREET geometry is real OSM ("The Embarcadero"). The water body is the '
      + 'renderer\'s own bay surface at the eastern edge of the loaded window bounds - the prebuilt '
      + 'OSM slice carries no water polygons in any window (city.water is empty). Score water '
      + 'behaviour and shoreline framing; do not score it as surveyed shoreline geometry.',
  };
  console.log(`\nwaterfront evidence: ${report.waterfrontEvidence.delivered ? 'delivered' : `NOT delivered (${report.waterfrontEvidence.reason})`}`
    + `; water in frame ${JSON.stringify(report.waterfrontEvidence.waterCheck?.waterFraction ?? null)}`);
}
// Three facts, compared once, at the end: what was asked for, what the browser
// opened, and what was written to disk.
const finalResolution = compareResolution({
  resolved: { w: W, h: H },
  viewport: report.resolution.browserViewport,
  png: report.resolution.writtenPng,
});
report.resolution.agreement = finalResolution;
const skipped = report.cards.filter((c) => c.skipped).map((c) => c.id);
const failed = report.cards.filter((c) => c.error && !c.skipped).map((c) => c.id);
// Per card, in one row: did it deliver, which window of the extract it came
// from, and how many frames it is. A two-window round is only honest evidence
// if each frame says which window it was shot on, and a traversal strip that
// lost a frame must not look like a complete one.
const traversalRequested = orderedCards.some((c) => c.pose === 'traversal');
const perCardStatus = report.cards.map((c) => {
  const frames = c.sequence ? c.sequence.filter((item) => item.file).length : (c.file ? 1 : 0);
  const planned = c.pose?.traversal?.frames?.length ?? (c.requested?.pose === 'traversal' ? TRAVERSAL_FRAMES : 1);
  return {
    id: c.id,
    delivered: !!c.file,
    frames,
    framesPlanned: planned,
    partial: !!c.file && frames < planned,
    window: c.worldWindow?.center
      ? windowKey({ center: c.worldWindow.center, radius: c.worldWindow.radius })
      : 'boot',
    windowSource: c.worldWindow?.source || 'boot',
    eyeHeightAboveDrawnGroundM: c.eyeHeightAboveDrawnGroundM ?? null,
    error: c.error ? String(c.error).slice(0, 160) : null,
  };
});
const partial = perCardStatus.filter((c) => c.partial).map((c) => c.id);
report.roundStatus = {
  requested: orderedCards.map((c) => c.id),
  captured: report.cards.filter((c) => c.file).map((c) => c.id),
  missing: orderedCards.map((c) => c.id).filter((id) => !report.cards.some((c) => c.id === id && c.file)),
  skipped,
  failed,
  partial,
  perCard: perCardStatus,
  windowsUsed: [...new Set(perCardStatus.map((c) => c.window))],
  waterfrontDelivered: perCardStatus.some((c) => c.id === '04-waterfront' && c.delivered),
  traversalDelivered: perCardStatus.some((c) => c.id === '08-traversal' && c.delivered && !c.partial),
  traversalRequested,
  complete: skipped.length === 0 && failed.length === 0 && report.cards.length === cards.length,
  // The gate's condition is the PIXELS ("16:9, 1440p or higher"), not which
  // environment variable set them. Reporting false for a round that really is
  // 2560x1440 because SF_QA_PROTOCOL was not the thing that set it would make
  // the field lie in the strict direction, which is still lying.
  //
  // Decided from the pixels that were WRITTEN when a frame exists to measure,
  // and from the request only when none does. A round whose PNGs disagree with
  // its own viewport cannot claim the protocol on the strength of the request.
  meetsProtocolResolution: finalResolution.meetsProtocolResolution && finalResolution.agrees,
  protocolResolutionDecidedBy: finalResolution.decidedBy,
  resolutionAgrees: finalResolution.agrees,
  resolutionMismatches: finalResolution.mismatches,
  requestedResolution: [W, H],
  writtenResolution: finalResolution.writtenPng,
  protocolFlagSet: PROTOCOL,
  aspect: +(W / H).toFixed(4),
};
report.errors = consoleErrors.slice(0, 40);
finalized = true;
await writeFile(path.join(OUT, 'capture-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.state, null, 2));
console.log(`errors: ${report.errors.length}`);
console.log('\nper card: delivered / frames / window');
for (const c of report.roundStatus.perCard) {
  console.log(`  ${c.id}: ${c.delivered ? 'delivered' : 'NOT DELIVERED'} `
    + `${c.frames}/${c.framesPlanned} frame(s) on window ${c.window} (${c.windowSource})`
    + (c.error ? ` :: ${c.error}` : ''));
}
if (!report.roundStatus.complete) {
  console.error(`\nROUND INCOMPLETE - skipped: [${skipped.join(', ') || 'none'}] `
    + `failed: [${failed.join(', ') || 'none'}] partial: [${partial.join(', ') || 'none'}]`);
  console.error(`  ${report.roundStatus.captured.length} of ${report.roundStatus.requested.length} `
    + 'cards ARE on disk and are usable evidence; a missing card does not invalidate the ones that '
    + 'delivered.');
}
if (!report.roundStatus.meetsProtocolResolution) {
  const written = report.resolution.writtenPng
    ? `${report.resolution.writtenPng.w}x${report.resolution.writtenPng.h}`
    : 'no frame written';
  console.error(`round requested ${W}x${H} (from SF_QA_W=${JSON.stringify(RESOLUTION.raw.SF_QA_W)}, `
    + `SF_QA_H=${JSON.stringify(RESOLUTION.raw.SF_QA_H)}, SF_QA_PROTOCOL=${JSON.stringify(RESOLUTION.raw.SF_QA_PROTOCOL)}) `
    + `and wrote ${written} (aspect ${report.roundStatus.aspect}); `
    + 'the review protocol needs 16:9 at >= 1440p (SF_QA_PROTOCOL=1). '
    + 'This is an ITERATION round and must be labelled as one.');
  for (const mismatch of finalResolution.mismatches) console.error(`  ${mismatch}`);
}
await browser.close();
if (!report.roundStatus.complete) process.exit(4);
