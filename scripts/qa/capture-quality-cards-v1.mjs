// Capture the visual-quality-gate scene cards from the canonical route.
//
// Evidence only: this script produces frames and a settings manifest. It makes
// no quality claim. Scoring happens against Docs/VISUAL_QUALITY_GATE.md.
//
//   node scripts/qa/capture-quality-cards-v1.mjs
//
// Env: SF_QA_URL, SF_QA_OUT, SF_QA_CARDS (comma list), SF_QA_W, SF_QA_H,
//      SF_QA_SETTLE_MS, SF_QA_SHOT_MS
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL_BASE = process.env.SF_QA_URL || 'http://127.0.0.1:5178/';
const OUT = process.env.SF_QA_OUT || '.qa-quality-cards';
// The gate's blind-review protocol wants 1440p or higher. That is ~4x the
// fragments of 720p on a software backend, so iteration rounds run smaller and
// say so; a round offered for review must set SF_QA_PROTOCOL=1.
const PROTOCOL = process.env.SF_QA_PROTOCOL === '1';
const W = Number(process.env.SF_QA_W || (PROTOCOL ? 2560 : 1280));
const H = Number(process.env.SF_QA_H || (PROTOCOL ? 1440 : 720));
const SETTLE = Number(process.env.SF_QA_SETTLE_MS || 2500);
const SHOT_MS = Number(process.env.SF_QA_SHOT_MS || 600000);
const BOOT_MS = Number(process.env.SF_QA_BOOT_MS || 300000);

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

// The runtime re-frames the camera every frame in orbit mode and advances
// state.clock at 0.6h per second, so a card would otherwise drift through half
// a day mid-exposure. Wrap renderer.update to pin both for the duration.
async function installPin() {
  return page.evaluate(() => {
    const r = window.__CITYGEN__.getRenderer();
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
    r.__qaPinned = true;
    return 'installed';
  });
}

// Place the camera in world metres. Returns what it actually chose so the
// manifest records the real pose, not the requested one.
async function placeCamera(pose) {
  return page.evaluate(({ pose, EYE }) => {
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
    if (pose === 'intersection') {
      const f = chosen.__focus;
      eye = { x: f.x - ux * 22 + nx * walk, z: f.z - uz * 22 + nz * walk };
      target = { x: f.x, z: f.z };
    } else if (pose === 'character') {
      // The card is only evidence if there is a character in it. The canonical
      // runtime has no player avatar, so this frames the nearest simulated
      // pedestrian to the chosen kerb - and refuses if there is nobody there,
      // rather than shooting an empty pavement and calling it a character card.
      const stand = { x: a.x + nx * (halfRoad + 0.6), z: a.z + nz * (halfRoad + 0.6) };
      const traffic = api.getTraffic?.();
      const crowd = typeof traffic?.presentationAgents === 'function'
        ? traffic.presentationAgents()
        : (traffic?.pedestrians || []);
      let best = null; let bestDistance = Infinity;
      for (const agent of crowd) {
        const position = agentPosition(agent);
        if (!position) continue;
        const distance = Math.hypot(position.x - stand.x, position.z - stand.z);
        if (distance < bestDistance) { bestDistance = distance; best = position; }
      }
      if (!best || bestDistance > 30) {
        return { ok: false, reason: `no pedestrian within 30 m of the kerb (nearest ${Number.isFinite(bestDistance) ? bestDistance.toFixed(1) : 'none'} m)`, crowd: crowd.length };
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
      eye = { x: a.x - ux * 30 + nx * walk, z: a.z - uz * 30 + nz * walk };
      target = { x: a.x + ux * 140, z: a.z + uz * 140 };
    } else {
      eye = { x: a.x + nx * walk, z: a.z + nz * walk };
      target = { x: a.x + ux * 90 + nx * (walk * 0.35), z: a.z + uz * 90 + nz * (walk * 0.35) };
    }

    // If the eye landed inside a building, try the opposite kerb, then other candidates.
    if (insideAny(eye)) {
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
    const nearestAgent = (point) => {
      let best = Infinity;
      for (const agent of agents) {
        const position = agentPosition(agent);
        if (!position) continue;
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
      if (steps) clearanceNote = `stepped back ${(steps * 0.8).toFixed(1)} m to clear a pedestrian`;
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
      eyeInsideBuilding: insideAny(eye),
      street: chosen.streetName || null,
      segmentId: chosen.id,
      roadWidth: chosen.width || null,
      sidewalkW: chosen.sidewalkW || null,
      surroundingAvgHeight: +t.avg.toFixed(1),
      surroundingCount: t.count,
      note,
      eye: { x: +eye.x.toFixed(2), y: +eyeY.toFixed(2), z: +eye.z.toFixed(2) },
      target: { x: +target.x.toFixed(2), y: +tgtY.toFixed(2), z: +target.z.toFixed(2) },
      fov: cam.fov ?? null,
    };
  }, { pose, EYE });
}

report.pin = await installPin();

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
      // same tick records the previous weather.
      await page.waitForTimeout(1500);
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
    entry.pose = await placeCamera(card.pose);
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
    await page.waitForTimeout(SETTLE);
    const file = path.join(OUT, `${card.id}.png`);
    const t0 = Date.now();
    await page.screenshot({ path: file, timeout: SHOT_MS });
    entry.file = file;
    entry.shotMs = Date.now() - t0;
    // Hole detector. The rubric's automatic-reject list includes visible gaps,
    // and a 30-65s software frame inspected by eye is a bad way to find them.
    // Cast a grid of rays through the lower half of the frame: any ray that
    // reaches the sky dome, or hits nothing at all, is a hole in the ground.
    entry.coverage = await page.evaluate(async () => {
      const THREE = await import(/* @vite-ignore */ '/node_modules/three/build/three.module.js');
      const r = window.__CITYGEN__.getRenderer();
      r.camera.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      const COLS = 24;
      const ROWS = 12;
      let holes = 0;
      let solid = 0;
      const worst = [];
      for (let iy = 0; iy < ROWS; iy += 1) {
        // lower 45% of the frame: where ground/pavement must be
        const sy = 0.55 + (iy + 0.5) / ROWS * 0.45;
        for (let ix = 0; ix < COLS; ix += 1) {
          const sx = (ix + 0.5) / COLS;
          ray.setFromCamera(new THREE.Vector2(sx * 2 - 1, -(sy * 2 - 1)), r.camera);
          const hit = ray.intersectObjects(r.scene.children, true)[0];
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
      return { samples: total, holes, solid, holeRatio: +(holes / total).toFixed(4), worst };
    });

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
      await page.waitForTimeout(SETTLE);
      await page.screenshot({ path: path.join(OUT, `${card.id}-keyoff.png`), timeout: SHOT_MS });
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
  console.log(`${card.id}: ${entry.error ? `FAILED ${entry.error}` : `ok ${entry.shotMs}ms`}`);
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
