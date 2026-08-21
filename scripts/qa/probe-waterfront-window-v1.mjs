// Runtime probe: does a given world window actually put water in front of the
// waterfront card's camera?
//
// Evidence only, and DELIBERATELY FRAME-FREE. It boots the canonical route,
// rebuilds the world on each candidate window, and asks the live scene what is
// there by raycasting. It never calls `renderFrame`, so it costs a world build
// per window instead of the 90-190 s a drawn frame costs on this rasterizer.
// Nothing here is visual evidence; it is geometry bookkeeping that says whether
// spending a capture round on a window is justified.
//
//   node scripts/qa/probe-waterfront-window-v1.mjs
//
// Env: SF_QA_URL, SF_QA_WINDOWS="x,z,r;x,z,r", SF_QA_PROBE_OUT
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const URL_BASE = process.env.SF_QA_URL || 'http://127.0.0.1:5178/';
const OUT = process.env.SF_QA_PROBE_OUT || '.qa-waterfront-probe';
const BOOT_MS = Number(process.env.SF_QA_BOOT_MS || 300000);
const WINDOWS = (process.env.SF_QA_WINDOWS || '2290,1938,720;1927,2342,720')
  .split(';').map((s) => s.trim()).filter(Boolean)
  .map((s) => s.split(',').map(Number))
  .filter((a) => a.length === 3 && a.every(Number.isFinite))
  .map(([x, z, radius]) => ({ center: [x, z], radius }));

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.addInitScript(() => { window.__QA_SKIP_PREWARM__ = true; });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => {
  const api = window.__CITYGEN__;
  return typeof api?.getState === 'function' && (api.getCity()?.buildings?.length || 0) > 50;
}, null, { timeout: BOOT_MS });

// Stop drawing before anything else. A probe that leaves the loop rendering
// burns minutes per window on frames nobody looks at.
await page.evaluate(() => {
  const r = window.__CITYGEN__.getRenderer();
  if (!r.__probePinned) {
    r.renderFrame = () => undefined;
    r.__probePinned = true;
  }
});

const report = { url: URL_BASE, windows: [], errors: [] };

for (const w of WINDOWS) {
  const loaded = await page.evaluate(async (spec) => {
    const api = window.__CITYGEN__;
    if (typeof api.loadSfWindow !== 'function') return { error: 'no loadSfWindow hook' };
    return api.loadSfWindow(spec);
  }, w);
  await page.waitForFunction(() => (window.__CITYGEN__?.getCity()?.buildings?.length || 0) > 50, null, { timeout: BOOT_MS });

  const probe = await page.evaluate(({ EYE }) => {
    const api = window.__CITYGEN__;
    const THREE = api.THREE;
    const r = api.getRenderer();
    const city = api.getCity();
    const segs = (city.segments || []).filter((s) => (s.points || []).length >= 2);
    const shore = segs.filter((s) => /embarcadero/i.test(s.streetName || '')
      && !/freeway/i.test(s.streetName || '') && s.highway !== 'motorway');

    // Every mesh the scene calls water, plus the renderer's own handle.
    const waterMeshes = [];
    r.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (!/water|bay/i.test(o.name || '')) return;
      const box = new THREE.Box3().setFromObject(o);
      waterMeshes.push({
        name: o.name || '(unnamed)',
        visible: o.visible,
        y: +o.position.y.toFixed(2),
        box: [+box.min.x.toFixed(1), +box.min.y.toFixed(2), +box.min.z.toFixed(1),
          +box.max.x.toFixed(1), +box.max.y.toFixed(2), +box.max.z.toFixed(1)],
      });
    });
    const water = r.water || null;
    const waterBox = water ? new THREE.Box3().setFromObject(water) : null;

    const lift = r.streetSurfaceLift ? r.streetSurfaceLift(city) : { footway: 0, datum: 0 };
    const groundAt = (x, z) => (r.terrain?.heightAt ? r.terrain.heightAt(x, z) : 0);

    // East-west transect at the shoreline street's z: where does terrain drop
    // below the water plane? That is the only place the plane can read as water.
    let transect = null;
    if (water && shore.length) {
      const p = shore[Math.floor(shore.length / 2)].points[0];
      const row = [];
      for (let x = water.position.x - 420; x <= water.position.x + 300; x += 30) {
        row.push({ x: +x.toFixed(0), terrain: +groundAt(x, p.z).toFixed(2) });
      }
      transect = { z: +p.z.toFixed(1), waterY: +water.position.y.toFixed(2), samples: row };
    }

    // Stand on the seaward kerb of the shoreline street, look at the water
    // plane centre, and raycast a grid: how much of the frame is water?
    let view = null;
    if (water && shore.length) {
      // The shore segment closest to the water plane centre.
      const target = { x: water.position.x, z: water.position.z };
      let best = null; let bestD = Infinity;
      for (const s of shore) {
        for (const pt of s.points) {
          const d = Math.hypot(pt.x - target.x, pt.z - target.z);
          if (d < bestD) { bestD = d; best = { s, pt }; }
        }
      }
      const s = best.s;
      const a = s.points[0]; const b = s.points[s.points.length - 1];
      const ux = (b.x - a.x) / (Math.hypot(b.x - a.x, b.z - a.z) || 1);
      const uz = (b.z - a.z) / (Math.hypot(b.x - a.x, b.z - a.z) || 1);
      let nx = -uz; let nz = ux;
      // Point the normal at the water.
      if ((target.x - best.pt.x) * nx + (target.z - best.pt.z) * nz < 0) { nx = -nx; nz = -nz; }
      const walk = (s.width || 12) / 2 + 2.4;
      const eye = { x: best.pt.x + nx * walk, z: best.pt.z + nz * walk };
      const eyeY = groundAt(eye.x, eye.z) + lift.footway + EYE;
      const look = { x: eye.x + nx * 260, z: eye.z + nz * 260 };
      const cam = r.camera;
      const before = { pos: cam.position.clone(), quat: cam.quaternion.clone() };
      cam.position.set(eye.x, eyeY, eye.z);
      cam.lookAt(look.x, water.position.y, look.z);
      cam.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      let hits = 0; let waterHits = 0; let skyHits = 0; let misses = 0;
      const names = {};
      for (let iy = 0; iy < 7; iy += 1) {
        for (let ix = 0; ix < 9; ix += 1) {
          const sx = (ix + 0.5) / 9;
          const sy = 0.45 + ((iy + 0.5) / 7) * 0.55;
          ray.setFromCamera({ x: sx * 2 - 1, y: -(sy * 2 - 1) }, cam);
          const hit = ray.intersectObject(r.scene, true)[0];
          hits += 1;
          if (!hit) { misses += 1; continue; }
          const name = hit.object.name || hit.object.parent?.name || '(unnamed)';
          names[name] = (names[name] || 0) + 1;
          if (/^sky/i.test(name)) skyHits += 1;
          else if (hit.object === water || /water|bay/i.test(name)) waterHits += 1;
        }
      }
      cam.position.copy(before.pos);
      cam.quaternion.copy(before.quat);
      cam.updateMatrixWorld(true);
      view = {
        street: s.streetName,
        eye: { x: +eye.x.toFixed(1), y: +eyeY.toFixed(2), z: +eye.z.toFixed(1) },
        look: { x: +look.x.toFixed(1), z: +look.z.toFixed(1) },
        distanceToWaterCentreM: +bestD.toFixed(1),
        samples: hits,
        waterHits,
        skyHits,
        misses,
        waterFraction: +(waterHits / hits).toFixed(3),
        hitNames: Object.entries(names).sort((l, m) => m[1] - l[1]).slice(0, 10),
      };
    }

    return {
      buildings: (city.buildings || []).length,
      segments: segs.length,
      cityWaterPolygons: (city.water || []).length,
      shoreSegments: shore.length,
      shoreNames: [...new Set(shore.map((s) => s.streetName))].slice(0, 4),
      bounds: city.meta?.bounds || null,
      rendererWater: water ? {
        name: water.name || '(unnamed)',
        visible: water.visible,
        position: [+water.position.x.toFixed(1), +water.position.y.toFixed(2), +water.position.z.toFixed(1)],
        box: waterBox ? [+waterBox.min.x.toFixed(1), +waterBox.min.z.toFixed(1),
          +waterBox.max.x.toFixed(1), +waterBox.max.z.toFixed(1)] : null,
      } : null,
      waterMeshes,
      surfaceLift: lift,
      transect,
      view,
    };
  }, { EYE: 1.65 });

  report.windows.push({ requested: w, loaded, probe });
  console.log(JSON.stringify({ window: w, shore: probe.shoreSegments, water: probe.rendererWater?.position,
    waterFraction: probe.view?.waterFraction, hits: probe.view?.hitNames }, null, 1));
}

report.errors = errors.slice(0, 20);
await writeFile(path.join(OUT, 'waterfront-probe.json'), JSON.stringify(report, null, 2));
console.log(`\nwrote ${path.join(OUT, 'waterfront-probe.json')}`);
await browser.close();
