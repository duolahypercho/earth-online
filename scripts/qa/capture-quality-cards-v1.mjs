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
//      SF_QA_TRAVERSAL_SPAN_M, SF_QA_TRAVERSAL_SPEED
//
// Frame budget: this harness draws frames only when it asks for them. The
// animation loop keeps ticking (the world simulates, the compositor stays
// live) but `renderFrame` is gated behind `window.__QA_RENDER__`, so a round
// pays for exactly the frames it captures.
import { chromium } from 'playwright';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const URL_BASE = process.env.SF_QA_URL || 'http://127.0.0.1:5178/';
const OUT = process.env.SF_QA_OUT || '.qa-quality-cards';
// The gate's blind-review protocol wants 1440p or higher. That is ~4x the
// fragments of 720p on a software backend, so iteration rounds run smaller and
// say so; a round offered for review must set SF_QA_PROTOCOL=1.
const PROTOCOL = process.env.SF_QA_PROTOCOL === '1';
const W = Number(process.env.SF_QA_W || (PROTOCOL ? 2560 : 1280));
const H = Number(process.env.SF_QA_H || (PROTOCOL ? 1440 : 720));
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
  { id: '04-waterfront',   hour: 10, pose: 'waterfront', weather: 'clear' },
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

// A software-GL city build is heavy enough that the renderer process can be
// killed under memory pressure, or the page can reload underneath us. Either
// way `page.evaluate` fails with "Execution context was destroyed" and the run
// used to die *after* paying the five-minute boot. Report it, and re-boot once
// instead of throwing away the whole round.
let crashes = 0;
page.on('crash', () => { crashes += 1; consoleErrors.push('renderer process crashed'); });

// SF_QA_WINDOW="x,z,radius" rebuilds the world on a different window of the SF
// extract before any card is posed. The default window has no shoreline in it,
// so the waterfront card is captured in its own run rather than by rebuilding
// the world mid-round (a rebuild costs a full world build).
const WINDOW_SPEC = (process.env.SF_QA_WINDOW || '').split(',').map(Number);
const WORLD_WINDOW = WINDOW_SPEC.length === 3 && WINDOW_SPEC.every(Number.isFinite)
  ? { center: [WINDOW_SPEC[0], WINDOW_SPEC[1]], radius: WINDOW_SPEC[2] }
  : null;

async function bootWorld() {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => {
    const api = window.__CITYGEN__;
    return typeof api?.getState === 'function' && (api.getCity()?.buildings?.length || 0) > 50;
  }, null, { timeout: BOOT_MS });
  // Pin BEFORE the animation loop starts. `state.city` is assigned at the top
  // of `buildCity`, so the wait above returns while the renderer is still
  // building and `setAnimationLoop` has not been called yet. Installing here is
  // what makes the round pay for zero unrequested frames; installing after the
  // state reads (where this used to live) leaked whole frames at ~161 s each.
  report.pin = await installPin();
  // The city object exists before TrafficSim is constructed, so reading runtime
  // state here reported pedestrians: 0 on a world that actually spawns 48 of
  // them. Wait for the simulation too, or every report understates the city.
  await page.waitForFunction(() => {
    const t = window.__CITYGEN__?.getTraffic?.();
    return !!t && (t.pedestrians?.length || 0) > 0 && (t.cars?.length || 0) > 0;
  }, null, { timeout: BOOT_MS }).catch(() => {});
  if (WORLD_WINDOW) {
    report.worldWindow = await page.evaluate(async (w) => {
      const api = window.__CITYGEN__;
      if (typeof api.loadSfWindow !== 'function') return { error: 'no loadSfWindow hook' };
      return api.loadSfWindow(w);
    }, WORLD_WINDOW);
    console.log(`world window: ${JSON.stringify(report.worldWindow)}`);
    await page.waitForFunction(() => (window.__CITYGEN__?.getCity()?.buildings?.length || 0) > 50, null, { timeout: BOOT_MS });
  }
}

/** Evaluate against the live world, re-booting once if the context is lost. */
async function evaluateInWorld(fn, arg = null) {
  try {
    return await page.evaluate(fn, arg);
  } catch (error) {
    const message = String(error?.message || error);
    if (!/Execution context was destroyed|Target closed|Target crashed/i.test(message)) throw error;
    consoleErrors.push(`context lost, re-booting once: ${message.slice(0, 160)}`);
    console.warn(`context lost, re-booting once: ${message.slice(0, 160)}`);
    await bootWorld();
    return page.evaluate(fn, arg);
  }
}

// NOTE: waitForFunction is (pageFunction, arg, options) - passing the options
// object as the second argument silently leaves the 30s default in place.
const bootStartedAt = Date.now();
await bootWorld();
report.bootMs = Date.now() - bootStartedAt;
console.log(`world ready in ${(report.bootMs / 1000).toFixed(1)}s`);

// The canonical route silently falls back to a procedurally generated city
// when the real OSM dataset fails to load. Frames from the fallback are not
// evidence about San Francisco, so refuse to produce them.
report.world = await evaluateInWorld(() => {
  const c = window.__CITYGEN__.getCity();
  const blds = c.buildings || [];
  const osm = blds.filter((b) => String(b.id).startsWith('sf-building-')).length;
  return {
    buildings: blds.length,
    osmBuildings: osm,
    osmShare: blds.length ? +(osm / blds.length).toFixed(3) : 0,
    sampleIds: blds.slice(0, 3).map((b) => b.id),
    sampleStreets: [...new Set((c.segments || []).map((s) => s.streetName).filter(Boolean))].slice(0, 6),
  };
});
if (report.world.osmShare < 0.9) {
  await writeFile(path.join(OUT, 'capture-report.json'), JSON.stringify(report, null, 2));
  console.error(`REFUSING TO CAPTURE: real San Francisco OSM data did not load.`);
  console.error(`  osm buildings: ${report.world.osmBuildings}/${report.world.buildings} (need >= 90%)`);
  console.error(`  sample ids: ${JSON.stringify(report.world.sampleIds)}`);
  console.error(`  sample streets: ${JSON.stringify(report.world.sampleStreets)}`);
  console.error(`  This is the procedural fallback, not the real map. Frames would be misleading.`);
  await browser.close();
  process.exit(3);
}

report.state = await evaluateInWorld(() => {
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
});

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
await hideInterface();

// Let the world live before the first card. The loop clamps its delta to
// 0.05 s and a frame costs minutes, so without this every card of every round
// samples the same boot instant: cars parked mid-lane, nobody having taken a
// step. This runs the canonical fixed-step driver and draws nothing.
report.simWarm = await stepSimulation(SIM_WARM_S, 'boot-warm');
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
  }, count);
  let timedOut = false;
  try {
    await page.waitForFunction(
      ({ base: b, need }) => (window.__QA_FRAMES__ | 0) >= b + need,
      { base, need: count },
      { timeout: FRAME_MS, polling: 1000 },
    );
  } catch (error) {
    timedOut = true;
    consoleErrors.push(`renderFrames timed out after ${Date.now() - startedAt} ms`);
  }
  const detail = await page.evaluate((b) => ({
    drawn: (window.__QA_FRAMES__ | 0) - b,
    cpuFrameMs: (window.__QA_FRAME_MS__ || []).slice(-8),
  }), base);
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
  out.render = await renderFrames(frames);
  await stopRendering();
  let started = Date.now();
  await page.screenshot({ path: file, timeout: SHOT_MS });
  out.shotMs = Date.now() - started;
  out.bytes = (await stat(file)).size;
  if (out.bytes < 20000) {
    out.emptyFrameSuspected = out.bytes;
    consoleErrors.push(`${path.basename(file)} was ${out.bytes} B; re-shooting with the loop drawing`);
    const second = await renderFrames(1);
    started = Date.now();
    await page.screenshot({ path: file, timeout: SHOT_MS });
    await stopRendering();
    out.reshot = { render: second, shotMs: Date.now() - started, bytes: (await stat(file)).size };
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
async function placeCamera(pose) {
  return page.evaluate(({ pose, EYE, traversal }) => {
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
    const surfaceLift = pose === 'intersection' || pose === 'traversal' ? lift.datum : lift.footway;
    const groundAt = (x, z) => (r.terrain?.heightAt ? r.terrain.heightAt(x, z) + surfaceLift : surfaceLift);

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
      const emb = named('embarcadero');
      if (emb.length) chosen = longest(emb);
      else {
        // No shoreline in the loaded window: report honestly instead of faking it.
        return { ok: false, reason: 'no Embarcadero/water in loaded window', water: (city.water || []).length };
      }
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
    if (sun && (sun.x || sun.z)) {
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
    let traversalPlan = null;
    if (pose === 'intersection') {
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
          frames.push({
            index: k,
            distanceAlong: +d.toFixed(2),
            eye: { x: +ex.toFixed(2), y: +(groundAt(ex, ez) + EYE).toFixed(2), z: +ez.toFixed(2) },
            look: {
              x: +look.x.toFixed(2),
              y: +(groundAt(look.x, look.z) + EYE * 0.92).toFixed(2),
              z: +look.z.toFixed(2),
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
    if (pose !== 'traversal' && insideAny(eye)) {
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

    const eyeY = groundAt(eye.x, eye.z) + eyeLift;
    const tgtY = groundAt(target.x, target.z) + (pose === 'canyon' ? 22 : (pose === 'character' ? 1.1 : EYE * 0.92));
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
    // TODO(street-life): the pass exposes no active near-anchor list on its
    // diagnostics yet, and another agent is adding a minimum camera radius to
    // it this wave. Until that lands, read the drawn near-ring instance
    // matrices straight off the scene. Replace this with the pass's own anchor
    // list as soon as it publishes one.
    const streetLifePoints = (() => {
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
    if (cam.fov != null) { cam.fov = pose === 'canyon' ? 58 : 47; cam.updateProjectionMatrix(); }
    if (controls?.target?.set) controls.target.set(target.x, tgtY, target.z);
    if (controls) controls.enabled = false;
    window.__QA_CAM__ = { pos: [eye.x, eyeY, eye.z], look: [target.x, tgtY, target.z] };

    const t = tallnessAt({ x: a.x, z: a.z });
    return {
      ok: true,
      traversal: traversalPlan,
      eyeInsideBuilding: insideAny(eye),
      street: chosen.streetName || null,
      segmentId: chosen.id,
      roadWidth: chosen.width || null,
      sidewalkW: chosen.sidewalkW || null,
      surroundingAvgHeight: +t.avg.toFixed(1),
      surroundingCount: t.count,
      crowdPoints: agents.length,
      streetLifeNearPoints: streetLifePoints.length,
      nearestFigureM: +nearestAgent(eye).toFixed(2),
      note,
      eye: { x: +eye.x.toFixed(2), y: +eyeY.toFixed(2), z: +eye.z.toFixed(2) },
      target: { x: +target.x.toFixed(2), y: +tgtY.toFixed(2), z: +target.z.toFixed(2) },
      fov: cam.fov ?? null,
    };
  }, { pose, EYE, traversal: { frames: TRAVERSAL_FRAMES, spanM: TRAVERSAL_SPAN_M, tileM: 140 } });
}

for (const card of cards) {
  const entry = { id: card.id, requested: card };
  try {
    await page.evaluate((h) => { window.__QA_HOUR__ = h; window.__CITYGEN__.setClock?.(h); }, card.hour);
    if (card.weather) {
      // `setWeather` is a renderer method. Calling it on the __CITYGEN__ handle
      // silently returned null for every card, so the wet-street card was dry
      // and the water/weather rubric dimension had no evidence behind it.
      entry.weatherApplied = await page.evaluate((w) => {
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
      entry.weatherState = await page.evaluate(() => {
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
    entry.prefocus = await placeCamera(focusPose);
    entry.sim = await stepSimulation(SIM_CARD_S, card.id);
    entry.pose = await placeCamera(card.pose);
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
        if (entry.pose?.ok) break;
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
    if (card.pose === 'traversal' && entry.pose?.traversal?.frames?.length) {
      // The gate asks for a 30 s 60 FPS traversal clip. One frame costs minutes
      // on this rasterizer, so 1800 of them is not a thing this machine can
      // produce; the honest substitute is a numbered strip of stepped frames
      // along a real traversal path that crosses a runtime tile boundary, with
      // the simulation advanced between frames by the time the walk would take.
      const plan = entry.pose.traversal;
      entry.sequence = [];
      for (const frame of plan.frames) {
        if (frame.index > 0) {
          const gap = frame.distanceAlong - plan.frames[frame.index - 1].distanceAlong;
          entry.sequence.push({ stepped: await stepSimulation(gap / TRAVERSAL_SPEED_MS, `${card.id}:${frame.index}`) });
        }
        await page.evaluate((f) => {
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
      }
      const shots = entry.sequence.filter((item) => item.file);
      entry.file = shots[0]?.file || null;
      entry.shotMs = shots.reduce((sum, item) => sum + (item.shotMs || 0), 0);
      entry.frameWallMs = shots.reduce((sum, item) => sum + (item.render?.wallMs || 0), 0);
      entry.clipForm = `stepped strip of ${shots.length} rendered frames over ${plan.spanMeters} m `
        + `crossing ${plan.boundaryCrossings} runtime tile (${plan.tileMeters} m partition cell) boundaries; `
        + 'NOT a 30 s 60 FPS clip - this rasterizer cannot render 1800 frames';
    } else {
      const shot = await captureFrame(path.join(OUT, `${card.id}.png`));
      entry.file = shot.file;
      entry.shotMs = shot.shotMs;
      entry.frame = shot.render;
      entry.frameWallMs = shot.render?.wallMs ?? null;
      entry.bytes = shot.bytes;
      if (shot.emptyFrameSuspected) entry.emptyFrameSuspected = shot.emptyFrameSuspected;
      if (shot.reshot) entry.reshot = shot.reshot;
    }
    // Hole detector. The rubric's automatic-reject list includes visible gaps,
    // and a 30-65s software frame inspected by eye is a bad way to find them.
    // Cast a grid of rays through the lower half of the frame: any ray that
    // reaches the sky dome, or hits nothing at all, is a hole in the ground.
    const coverageStartedAt = Date.now();
    entry.coverage = await page.evaluate(({ cols, rows }) => {
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
      const cached = window.__QA_TARGETS__;
      const rootId = r.root?.uuid || null;
      if (!cached || cached.rootId !== rootId) {
        const DRESSING = /lamp|light|prop|awning|ripple|contour|contact-shadow|shadow|rail|tie|overhead|support|parked-car|street-life|crowd|pedestrian|vehicle|car|signal|tree|foliage|canopy|marker|ghost|minimap/i;
        const list = [];
        let dropped = 0;
        r.scene.traverse((object) => {
          if (!object.visible) return;
          if (!object.isMesh && !object.isInstancedMesh) return;
          if (!object.geometry) return;
          const name = object.name || object.parent?.name || '';
          if (name !== 'sky-dome' && DRESSING.test(name)) { dropped += 1; return; }
          list.push(object);
        });
        window.__QA_TARGETS__ = { rootId, list, dropped };
      }
      const targets = window.__QA_TARGETS__;

      const ray = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let holes = 0;
      let solid = 0;
      const worst = [];
      for (let iy = 0; iy < rows; iy += 1) {
        // lower 45% of the frame: where ground/pavement must be
        const sy = 0.55 + (iy + 0.5) / rows * 0.45;
        for (let ix = 0; ix < cols; ix += 1) {
          const sx = (ix + 0.5) / cols;
          pointer.set(sx * 2 - 1, -(sy * 2 - 1));
          ray.setFromCamera(pointer, r.camera);
          const hit = ray.intersectObjects(targets.list, false)[0];
          const isHole = !hit || hit.object.name === 'sky-dome' || hit.distance > 400;
          if (isHole) {
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
        targets: targets.list.length,
        droppedDressing: targets.dropped,
        holes,
        solid,
        holeRatio: +(holes / total).toFixed(4),
        worst,
      };
    }, { cols: COVER_COLS, rows: COVER_ROWS });
    if (entry.coverage) entry.coverage.ms = Date.now() - coverageStartedAt;

    // Optional: ask the world what actually drew at a screen pixel. A visual
    // artifact is otherwise a guessing game, and a re-boot to investigate costs
    // a full world build. Format: SF_QA_PROBE="01-street-day:0.25,0.85 0.5,0.9"
    if (PROBES.has(card.id)) {
      entry.probes = await page.evaluate(({ points, viewport }) => {
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
    entry.shadows = await page.evaluate(() => {
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
      await page.evaluate(() => {
        const r = window.__CITYGEN__.getRenderer();
        window.__QA_KEY__ = r.sun.intensity;
        r.sun.intensity = 0;
      });
      entry.keyOff = await captureFrame(path.join(OUT, `${card.id}-keyoff.png`));
      await page.evaluate(() => {
        const r = window.__CITYGEN__.getRenderer();
        r.sun.intensity = window.__QA_KEY__;
      });
      entry.keyOffFrame = `${card.id}-keyoff.png`;
    }

    entry.held = await page.evaluate(() => {
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
    entry.telemetry = await page.evaluate(() => {
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
        drawnFrames: window.__QA_FRAMES__ | 0,
      };
    });
  } catch (e) {
    entry.error = String(e).slice(0, 300);
    if (/Execution context was destroyed|Target closed|Target crashed/i.test(entry.error)) {
      // Recover capture conditions so the remaining cards still produce evidence.
      consoleErrors.push(`card ${card.id} lost its context; re-booting`);
      try {
        await bootWorld();
        await hideInterface();
        report.pin = await installPin();
        entry.recovered = true;
      } catch (bootError) {
        entry.recoveryError = String(bootError).slice(0, 200);
      }
    }
  }
  report.cards.push(entry);
  console.log(`${card.id}: ${entry.error
    ? `FAILED ${entry.error}`
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
  return {
    backend: {
      rendererBackend: safe(() => api.getState().rendererBackend),
      isWebGPUBackend: safe(() => gl?.backend?.isWebGPUBackend ?? null),
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
    },
    boot: safe(() => (typeof api.getBootPhases === 'function' ? api.getBootPhases() : null)),
    performance: safe(() => (typeof api.getPerformanceTelemetry === 'function' ? api.getPerformanceTelemetry() : null)),
    drawnFrames: window.__QA_FRAMES__ | 0,
  };
}).catch((error) => ({ error: String(error).slice(0, 200) }));

if (report.runtime?.backend) {
  console.log(`\nbackend: ${report.runtime.backend.rendererBackend} `
    + `isWebGPUBackend=${report.runtime.backend.isWebGPUBackend} samples=${report.runtime.backend.samples} `
    + `drawingBuffer=${JSON.stringify(report.runtime.backend.drawingBufferSize)}`);
}
if (report.runtime?.shadowTarget) {
  const st = report.runtime.shadowTarget;
  const line = `shadow map: requested ${JSON.stringify(st.requested)} allocated ${JSON.stringify(st.allocated)}`;
  if (st.exists && st.matchesRequest) console.log(line);
  else {
    console.error(`${line} - MISMATCH or not allocated`);
    consoleErrors.push(`shadow render target ${st.exists ? 'mismatched' : 'never allocated'}: ${line}`);
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
    console.log(`  ${c.id}: ${(c.coverage.holeRatio * 100).toFixed(1)}% of lower-frame rays reach sky/void`);
  }
}

report.rendererCrashes = crashes;
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
const skipped = report.cards.filter((c) => c.skipped).map((c) => c.id);
const failed = report.cards.filter((c) => c.error && !c.skipped).map((c) => c.id);
report.roundStatus = {
  requested: cards.map((c) => c.id),
  captured: report.cards.filter((c) => c.file).map((c) => c.id),
  skipped,
  failed,
  complete: skipped.length === 0 && failed.length === 0 && report.cards.length === cards.length,
  meetsProtocolResolution: PROTOCOL && H >= 1440,
};
report.errors = consoleErrors.slice(0, 40);
await writeFile(path.join(OUT, 'capture-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.state, null, 2));
console.log(`errors: ${report.errors.length}`);
if (!report.roundStatus.complete) {
  console.error(`\nROUND INCOMPLETE - skipped: [${skipped.join(', ') || 'none'}] failed: [${failed.join(', ') || 'none'}]`);
}
if (!report.roundStatus.meetsProtocolResolution) {
  console.error(`round captured at ${W}x${H}; the review protocol needs >= 1440p (SF_QA_PROTOCOL=1)`);
}
await browser.close();
if (!report.roundStatus.complete) process.exit(4);
