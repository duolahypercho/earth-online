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
const W = Number(process.env.SF_QA_W || 1280);
const H = Number(process.env.SF_QA_H || 720);
const SETTLE = Number(process.env.SF_QA_SETTLE_MS || 2500);
const SHOT_MS = Number(process.env.SF_QA_SHOT_MS || 240000);
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

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
// NOTE: waitForFunction is (pageFunction, arg, options) - passing the options
// object as the second argument silently leaves the 30s default in place.
const bootStartedAt = Date.now();
await page.waitForFunction(() => {
  const api = window.__CITYGEN__;
  return typeof api?.getState === 'function' && (api.getCity()?.buildings?.length || 0) > 50;
}, null, { timeout: BOOT_MS });
report.bootMs = Date.now() - bootStartedAt;
console.log(`world ready in ${(report.bootMs / 1000).toFixed(1)}s`);

// The canonical route silently falls back to a procedurally generated city
// when the real OSM dataset fails to load. Frames from the fallback are not
// evidence about San Francisco, so refuse to produce them.
report.world = await page.evaluate(() => {
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

report.state = await page.evaluate(() => {
  const s = window.__CITYGEN__.getState();
  return {
    generator: s.generator, buildings: s.buildings, streets: s.streets,
    blocks: s.blocks, signals: s.signals, pedestrians: s.pedestrians,
    rendererBackend: s.rendererBackend, webgpu: s.webgpu, webgl2: s.webgl2,
    avgBuildingHeight: s.avgBuildingHeight, avgStreetWidth: s.avgStreetWidth,
    errors: s.errors,
  };
});

// Hide HUD so the frames show the world, not the interface.
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
    const groundAt = (x, z) => (r.terrain?.heightAt ? r.terrain.heightAt(x, z) : 0);

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
    const ux = dx / len; const uz = dz / len;
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
      // third person: behind and above a figure standing at the curb
      const stand = { x: a.x + nx * (halfRoad + 0.6), z: a.z + nz * (halfRoad + 0.6) };
      eye = { x: stand.x - ux * 4.2 + nx * 1.1, z: stand.z - uz * 4.2 + nz * 1.1 };
      target = stand;
      eyeLift = EYE + 0.35;
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
      entry.weatherApplied = await page.evaluate((w) => {
        const api = window.__CITYGEN__;
        if (typeof api.setWeather === 'function') { api.setWeather(w); return w; }
        return null;
      }, card.weather);
    }
    entry.pose = await placeCamera(card.pose);
    await page.waitForTimeout(SETTLE);
    const file = path.join(OUT, `${card.id}.png`);
    const t0 = Date.now();
    await page.screenshot({ path: file, timeout: SHOT_MS });
    entry.file = file;
    entry.shotMs = Date.now() - t0;
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
  }
  report.cards.push(entry);
  console.log(`${card.id}: ${entry.error ? `FAILED ${entry.error}` : `ok ${entry.shotMs}ms`}`);
}

report.errors = consoleErrors.slice(0, 40);
await writeFile(path.join(OUT, 'capture-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.state, null, 2));
console.log(`errors: ${report.errors.length}`);
await browser.close();
