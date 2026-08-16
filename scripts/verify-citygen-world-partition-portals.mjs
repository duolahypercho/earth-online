import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://localhost:5173/';
const chrome = process.env.SF_QA_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(chrome).then(() => chrome).catch(() => undefined);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'], ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const expected = Object.freeze({ sf: [135, 24, 8100], night: [121, 23, 7260], aerial: [700, 93, 42000] });
const heroIds = ['sf-building-132127809', 'sf-building-132127810', 'sf-building-149335979', 'sf-building-149335987', 'sf-building-149335988', 'sf-building-151183777'];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];

async function comparePngs(left, right) {
  return page.evaluate(async ({ leftBase64, rightBase64 }) => {
    const decode = async (base64) => createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const [a, b] = await Promise.all([decode(leftBase64), decode(rightBase64)]);
    const canvas = new OffscreenCanvas(a.width, a.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(a, 0, 0);
    const first = context.getImageData(0, 0, a.width, a.height).data;
    context.clearRect(0, 0, a.width, a.height);
    context.drawImage(b, 0, 0);
    const second = context.getImageData(0, 0, b.width, b.height).data;
    let changedPixels = 0;
    let channelDelta = 0;
    for (let index = 0; index < first.length; index += 4) {
      const delta = Math.abs(first[index] - second[index])
        + Math.abs(first[index + 1] - second[index + 1])
        + Math.abs(first[index + 2] - second[index + 2]);
      if (delta > 18) changedPixels += 1;
      channelDelta += delta;
    }
    return { width: a.width, height: a.height, changedPixels, channelDelta };
  }, { leftBase64: left.toString('base64'), rightBase64: right.toString('base64') });
}

async function captureMatchedPair(label, cameraPose, hour) {
  await page.evaluate(({ cameraPose, hour }) => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    api.setTime(hour);
    api.setCameraPose(cameraPose);
    renderer.controls.update();
    renderer.updatePortalPartition(true, true);
    const traffic = api.getTraffic?.();
    if (traffic?.group) traffic.group.visible = false;
    window.__PORTAL_FROZEN_UPDATE__ = renderer.update;
    window.__PORTAL_FORCE_UPDATE__ = renderer.updatePortalPartition.bind(renderer);
    renderer.update = () => {};
  }, { cameraPose, hour });
  await page.waitForTimeout(150);
  const candidate = await page.screenshot({ path: `.qa-citygen-portal-partition-${label}-candidate.png` });
  await page.evaluate(() => window.__PORTAL_FORCE_UPDATE__(true, true, true));
  await page.waitForTimeout(150);
  const forceAll = await page.screenshot({ path: `.qa-citygen-portal-partition-${label}-force-all.png` });
  await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    renderer.update = window.__PORTAL_FROZEN_UPDATE__;
    window.__PORTAL_FORCE_UPDATE__(true, true, false);
    delete window.__PORTAL_FROZEN_UPDATE__;
    delete window.__PORTAL_FORCE_UPDATE__;
  });
  return comparePngs(candidate, forceAll);
}

async function ready() {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const a = window.__CITYGEN__, r = a?.getRenderer?.(), s = a?.getState?.();
    return s?.generator === 'sf-builtin' && s?.buildings === 700 && !s?.busy && r?.root && r?.portalPartitionDiagnostics?.enabled;
  }, { timeout: 60000 });
}
async function pose(name, hour) {
  await page.evaluate(([name, hour]) => { const a = window.__CITYGEN__, r = a.getRenderer(); a.setTime(hour); a.setCameraPose(name); r.controls.update(); r.updatePortalPartition(true, true); r.renderFrame(); }, [name, hour]);
  return page.evaluate(() => ({ snapshot: window.__PORTAL_SNAP__(), portals: window.__CITYGEN__.getBuildingPortals() }));
}
function core(s, label) {
  const d = s.diagnostics;
  assert.equal(d.schemaVersion, 1, `${label}: schema`); assert.equal(d.pass, 'sf-world-partition-portals-v1', `${label}: pass`); assert.equal(d.failure, null, `${label}: failure`);
  assert.deepEqual(s.coverage, { registered: 700, functional: 700, accessible: 700 }, `${label}: coverage`);
  assert.equal(d.source.portals, 700, `${label}: source portals`); assert.equal(d.source.genericTriangles, 42000, `${label}: source tris`); assert.equal(d.source.trianglesPerPortal, 60, `${label}: tris/portal`);
  assert.ok(d.source.recordsUnchanged && d.source.unchanged && d.source.inputChecksumBefore === d.source.inputChecksumAfter, `${label}: source immutable`);
  assert.deepEqual(d.policy, { cellSizeMeters: 140, enterRadiusMeters: 420, exitRadiusMeters: 520, aerialHeightMeters: 500, updateIntervalFrames: 8 }, `${label}: policy`);
  assert.deepEqual(d.resources, { drawGroups: 0, geometries: 0, materials: 0, textures: 0 }, `${label}: zero resources`);
  assert.equal(d.active.portals + d.active.hiddenPortals, 700, `${label}: full logical set`); assert.equal(d.active.indices.length, d.active.portals, `${label}: indices`);
  assert.deepEqual(d.batches.panels.count, d.active.portals, `${label}: panel count`); assert.equal(d.batches.frames.count, d.active.portals * 3, `${label}: frame count`); assert.equal(d.batches.lights.count, d.active.portals, `${label}: light count`);
  assert.equal(d.submittedTriangles, d.active.portals * 60, `${label}: submitted tris`);
  assert.deepEqual(s.presentation, { panels: 700, frames: 2100, lights: 700, glazing: 12, trim: 30, signage: 6 }, `${label}: portal/hero presentation capacity`);
  assert.deepEqual(s.identity, { renderer: true, scene: true, canvas: true, roots: 1, sceneCanvas: 1, loop: true }, `${label}: canonical runtime`);
}

try {
  await ready();
  await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    window.__PORTAL_IDENTITY__ = {
      renderer,
      scene: renderer.scene,
      root: renderer.root,
      canvas: renderer.renderer.domElement,
      animationLoop: renderer.renderer._animation?._animationLoop,
    };
  });
  await page.evaluate((source) => { window.__PORTAL_SNAP__ = (0, eval)(`(${source})`); }, snap.toString());
  const baseline = await page.evaluate(() => ({ portals: window.__CITYGEN__.getBuildingPortals(), coverage: window.__CITYGEN__.getInteriorCoverage() }));
  const results = { sf: await pose('sf', 14), night: await pose('night', 22), aerial: await pose('aerial', 14) };
  for (const [name, result] of Object.entries(results)) { const s = result.snapshot; core(s, name); assert.deepEqual(result.portals, baseline.portals, `${name}: registry byte-stable`); assert.deepEqual([s.diagnostics.active.portals, s.diagnostics.cells.active, s.diagnostics.submittedTriangles], expected[name], `${name}: reset counts`); assert.equal(s.diagnostics.active.aerial, name === 'aerial', `${name}: aerial`); await page.screenshot({ path: `.qa-citygen-portal-partition-${name}.png` }); }
  await page.addStyleTag({ content: '.brand,.toolbar,.readout,.hint,.minimap,.inspector,.status-pill,.osm-overlay{display:none!important}' });
  const visualParity = {
    sf: await captureMatchedPair('sf', 'sf', 14),
    night: await captureMatchedPair('night', 'night', 22),
  };
  for (const [label, diff] of Object.entries(visualParity)) {
    assert.equal(diff.width, 1280, `${label}: matched capture width`);
    assert.equal(diff.height, 720, `${label}: matched capture height`);
    assert.ok(diff.changedPixels <= 20000,
      `${label}: candidate/force-all portal pixels remain below 2.2% (${diff.changedPixels})`);
    assert.ok(diff.channelDelta <= 2500000,
      `${label}: candidate/force-all aggregate channel delta remains bounded (${diff.channelDelta})`);
  }
  const equivalence = await page.evaluate(() => {
    const a = window.__CITYGEN__, r = a.getRenderer(); a.setCameraPose('aerial'); r.updatePortalPartition(true, true, true);
    const runtime = r.portalPartitionRuntime, meshes = [runtime.panels, runtime.frames, runtime.lights], all = meshes.map((m) => ({ matrix: new Float32Array(m.instanceMatrix.array), color: m.instanceColor ? new Float32Array(m.instanceColor.array) : null }));
    a.setCameraPose('sf'); r.updatePortalPartition(true, true); let bad = 0;
    r.portalPartitionDiagnostics.active.indices.forEach((source, target) => meshes.forEach((mesh, batch) => { const count = batch === 1 ? 3 : 1; for (let k = 0; k < count; k += 1) { for (let n = 0; n < 16; n += 1) if (mesh.instanceMatrix.array[(target * count + k) * 16 + n] !== all[batch].matrix[(source * count + k) * 16 + n]) bad += 1; if (batch < 2) for (let n = 0; n < 3; n += 1) if (mesh.instanceColor.array[(target * count + k) * 3 + n] !== all[batch].color[(source * count + k) * 3 + n]) bad += 1; } }));
    return { bad, restored: window.__PORTAL_SNAP__() };
  });
  assert.equal(equivalence.bad, 0, 'candidate panel/frame colors and all matrices match force-all'); core(equivalence.restored, 'equivalence');
  const interaction = await page.evaluate((heroIds) => { const a = window.__CITYGEN__, r = a.getRenderer(), portals = a.getBuildingPortals(), ids = [portals[0].buildingId, portals[Math.floor(portals.length / 2)].buildingId, portals.at(-1).buildingId, ...heroIds]; const results = []; for (const id of ids) { const portal = a.getBuildingPortals().find((x) => x.buildingId === id); const entered = a.enterBuilding(id); const active = a.getInteriorState().active; const exited = a.exitBuilding(); const state = a.getInteriorState(); results.push({ id, entered, activeId: active?.buildingId, exited, x: state.playerPosition.x, z: state.playerPosition.z, approach: portal.approach }); } return results; }, heroIds);
  for (const item of interaction) { assert.equal(item.entered, true, `${item.id}: enters`); assert.equal(item.activeId, item.id, `${item.id}: correct interior`); assert.equal(item.exited, true, `${item.id}: exits`); assert.ok(Math.hypot(item.x - item.approach.x, item.z - item.approach.z) < 1e-6, `${item.id}: exact approach restore`); }
  const heroPin = await page.evaluate((heroIds) => { const a = window.__CITYGEN__, r = a.getRenderer(), q = r.portalPartitionRuntime; const pinned = q.records.filter((x) => x.pinned), hero = pinned.map((x) => x.buildingId).sort(), pinnedIndices = pinned.map((x) => x.index); a.setCameraPose('sf'); r.controls.target.set(-900, r.controls.target.y, -900); r.camera.position.set(-880, 8, -880); r.camera.lookAt(r.controls.target); r.updatePortalPartition(true, true); const activeIndices = [...r.portalPartitionDiagnostics.active.indices]; let prefixExact = activeIndices.length === pinned.length; activeIndices.forEach((source, target) => { const record = q.records[source]; for (let n = 0; n < 16; n += 1) prefixExact &&= q.panels.instanceMatrix.array[target * 16 + n] === record.panelMatrix[n] && q.lights.instanceMatrix.array[target * 16 + n] === record.lightMatrix[n]; for (let n = 0; n < 3; n += 1) prefixExact &&= q.panels.instanceColor.array[target * 3 + n] === record.panelColor[n]; for (let part = 0; part < 3; part += 1) { for (let n = 0; n < 16; n += 1) prefixExact &&= q.frames.instanceMatrix.array[(target * 3 + part) * 16 + n] === record.frameMatrices[part][n]; for (let n = 0; n < 3; n += 1) prefixExact &&= q.frames.instanceColor.array[(target * 3 + part) * 3 + n] === record.frameColors[part][n]; } }); return { hero, pinnedIndices, activeIndices, prefixExact, active: r.portalPartitionDiagnostics.active.pinnedHeroIds, batches: structuredClone(r.portalPartitionDiagnostics.batches), submittedTriangles: r.portalPartitionDiagnostics.submittedTriangles, aerial: r.portalPartitionDiagnostics.active.aerial, presentation: window.__PORTAL_SNAP__().presentation }; }, heroIds);
  assert.deepEqual(heroPin.hero, [...heroIds].sort(), 'six hero records pinned in source'); assert.deepEqual(heroPin.activeIndices, heroPin.pinnedIndices, 'only six pinned hero source indices remain active at distant focus'); assert.equal(heroPin.prefixExact, true, 'pinned hero prefix matrices and colors match source records'); assert.deepEqual([...heroPin.active].sort(), [...heroIds].sort(), 'six hero records remain active at distant focus'); assert.equal(heroPin.batches.panels.count, 6, 'distant hero panels exact'); assert.equal(heroPin.batches.frames.count, 18, 'distant hero frames exact'); assert.equal(heroPin.batches.lights.count, 6, 'distant hero lights exact'); assert.equal(heroPin.submittedTriangles, 360, 'distant hero generic triangles exact'); assert.equal(heroPin.aerial, false, 'hero pin test is non-aerial'); assert.deepEqual(heroPin.presentation, { panels: 700, frames: 2100, lights: 700, glazing: 12, trim: 30, signage: 6 }, 'hero presentation retained');
  const hysteresis = await page.evaluate(() => { const a = window.__CITYGEN__, r = a.getRenderer(), q = r.portalPartitionRuntime, c = q.cells.find((x) => x.indices.some((i) => !q.records[i].pinned)), camera = r.camera, controls = r.controls, offset = camera.position.clone().sub(controls.target); const set = (distance, reset = false, normal = false) => { controls.target.set(c.x + 70 + 300, controls.target.y, c.z + 70 + Math.sqrt(distance * distance - 300 * 300)); camera.position.copy(controls.target).add(offset); camera.lookAt(controls.target); if (normal) for (let i = 0; i < 8; i += 1) r.updatePortalPartition(false); else r.updatePortalPartition(true, reset); return structuredClone(r.portalPartitionDiagnostics); }; const enter = set(419, true), held = set(510), exit = set(521, false, true); return { id: c.id, enter, held, exit }; });
  assert.ok(hysteresis.enter.cells.ids.includes(hysteresis.id), '419m portal cell enters'); assert.ok(hysteresis.held.cells.ids.includes(hysteresis.id), '510m portal cell retained'); assert.ok(!hysteresis.exit.cells.ids.includes(hysteresis.id), '521m portal cell naturally exits');
  const lifecycle = await page.evaluate(async () => { const a = window.__CITYGEN__, r = a.getRenderer(), q = r.portalPartitionRuntime, old = [q.panels, q.frames, q.lights, q.storefrontGlass, q.storefrontTrim], disposed = old.map(() => false); old.forEach((m, i) => m.addEventListener('dispose', () => { disposed[i] = true; })); await a.loadBuiltinSf(); a.setCameraPose('sf'); r.updatePortalPartition(true, true); return { disposed, reachable: old.some((m) => { let found = false; r.scene.traverse((o) => { if (o === m) found = true; }); return found; }), after: window.__PORTAL_SNAP__(), portals: a.getBuildingPortals() }; });
  assert.deepEqual(lifecycle.disposed, [true, true, true, true, true], 'rebuild disposes generic and hero portal instancers'); assert.equal(lifecycle.reachable, false, 'old portal meshes unreachable'); core(lifecycle.after, 'rebuild'); assert.deepEqual(lifecycle.portals, baseline.portals, 'registry records byte-stable');
  const cpu = await page.evaluate(() => { const a = window.__CITYGEN__, r = a.getRenderer(), c = r.controls, p = c.target.clone(), offset = r.camera.position.clone().sub(c.target); const measure = (on) => { const original = r.updatePortalPartition, times = [], activeCounts = new Set(), before = r.portalPartitionDiagnostics.updates.compactions; if (!on) r.updatePortalPartition = () => false; for (let i = 0; i < 180; i += 1) { c.target.copy(p); c.target.x += Math.floor(i / 8) % 3 * 520; r.camera.position.copy(c.target).add(offset); const t = performance.now(); r.update(1 / 60, { time: 14 }); times.push(performance.now() - t); if (on) activeCounts.add(r.portalPartitionDiagnostics.active.portals); } const compactions = on ? r.portalPartitionDiagnostics.updates.compactions - before : 0; r.updatePortalPartition = original; return { times, compactions, activeCounts: [...activeCounts] }; }; r.updatePortalPartition(true, true); const off = measure(false); r.updatePortalPartition(true, true); const on = measure(true); a.setCameraPose('sf'); r.updatePortalPartition(true, true); return { off, on }; });
  const offP95 = percentile(cpu.off.times, .95), onP95 = percentile(cpu.on.times, .95), delta = onP95 - offP95; assert.ok(cpu.on.compactions >= 10, `moving benchmark performs real compactions (${cpu.on.compactions})`); assert.ok(cpu.on.activeCounts.length >= 2, `moving benchmark covers distinct active counts (${cpu.on.activeCounts})`); assert.ok(offP95 <= 8 && onP95 <= 8, `absolute update p95 stays <=8ms (${offP95}/${onP95})`); assert.ok(delta <= .35, `moving compaction p95 <=.35ms (${delta})`);
  assert.deepEqual(errors, [], 'browser errors'); console.log(JSON.stringify({ result: 'PASS', counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.snapshot.diagnostics.active.portals])), visualParity, cpu: { offP95, onP95, p95DeltaMs: delta, compactions: cpu.on.compactions, activeCounts: cpu.on.activeCounts } }, null, 2));
} finally { await browser.close(); }

function snap() { const a = window.__CITYGEN__, r = a.getRenderer(), d = structuredClone(r.portalPartitionDiagnostics), identity = window.__PORTAL_IDENTITY__, names = {}; r.root.traverse((o) => { if (o.isInstancedMesh) names[o.name] = o.count; else if (o.name === 'hero-storefront-signage') names[o.name] = o.userData.signCount; }); const h = r.heroFacadeDiagnostics?.streetwall, q = r.portalPartitionRuntime; return { diagnostics: d, coverage: (({ registered, functional, accessible }) => ({ registered, functional, accessible }))(a.getInteriorCoverage()), presentation: { panels: q.panels.instanceMatrix.count, frames: q.frames.instanceMatrix.count, lights: q.lights.instanceMatrix.count, glazing: names['hero-storefront-glazing'] || 0, trim: names['hero-storefront-trim'] || 0, signage: names['hero-storefront-signage'] || 0 }, identity: { renderer: r === identity.renderer, scene: r.scene === identity.scene, canvas: r.renderer.domElement === identity.canvas, roots: r.scene.children.filter((x) => x.name === 'city-root').length, sceneCanvas: document.querySelectorAll('#scene-canvas').length, loop: r.renderer._animation?._animationLoop === identity.animationLoop && typeof identity.animationLoop === 'function' }, hero: h }; }
