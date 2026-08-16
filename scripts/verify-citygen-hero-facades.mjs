// Fail-closed verifier for the hero-facade presentation contract.
//
// The canonical renderer must expose `renderer.heroFacadeDiagnostics`
// describing the audited hero buildings (exact six source IDs), each built
// from its source polygon footprint with a finite shell whose roofline,
// cornice, and parapet are represented, plus the pattern keys and draw-group
// budget the hero regrouping costs. Until that contract lands, this gate
// fails closed by design.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const report = { render: {} };

page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
    errors.push(message.text());
  }
});

const HERO_IDS = Object.freeze([
  'sf-building-132127809',
  'sf-building-132127810',
  'sf-building-149335979',
  'sf-building-149335987',
  'sf-building-149335988',
  'sf-building-151183777',
]);

// Traffic is hidden for deterministic facade/roof isolation. The 642a296
// atlas baseline is 471 draws / 504,374 triangles on the canonical hero pose
// and 858 / 521,007 aerial. Actual roof geometry gets only two draw groups and
// 462 triangles; these caps retain a tiny scheduling/culling margin.
const HERO_POSE_CAPS = Object.freeze({ drawCalls: 474, triangles: 504950 });
const ELEVATED_POSE_CAPS = Object.freeze({ drawCalls: 900, triangles: 530000 });
const AERIAL_POSE_CAPS = Object.freeze({ drawCalls: 862, triangles: 521600 });

const sampleRenderer = () => page.evaluate(() => {
  const renderer = window.__CITYGEN__.getRenderer();
  return {
    identity: {
      renderer: renderer === window.__CITYGEN_HERO_IDENTITY__.renderer,
      root: renderer.root === window.__CITYGEN_HERO_IDENTITY__.root,
      scene: renderer.scene === window.__CITYGEN_HERO_IDENTITY__.scene,
      canvas: renderer.renderer.domElement === window.__CITYGEN_HERO_IDENTITY__.canvas,
    },
    drawCalls: renderer.renderer.info.render.drawCalls,
    triangles: renderer.renderer.info.render.triangles,
    geometries: renderer.renderer.info.memory.geometries,
    textures: renderer.renderer.info.memory.textures,
  };
});

function assertRenderBudget(sample, label, caps) {
  assert.ok(Number.isFinite(sample.drawCalls), `${label}: renderer drawCalls is finite`);
  assert.ok(sample.drawCalls <= caps.drawCalls,
    `${label}: drawCalls <=${caps.drawCalls} (${sample.drawCalls})`);
  assert.ok(sample.triangles <= caps.triangles,
    `${label}: triangles <=${caps.triangles} (${sample.triangles})`);
  assert.ok(sample.geometries <= 430, `${label}: geometries <=430 (${sample.geometries})`);
  assert.ok(sample.textures <= 305, `${label}: textures <=305 (${sample.textures})`);
  assert.deepEqual(sample.identity, { renderer: true, root: true, scene: true, canvas: true },
    `${label}: canonical renderer, root, scene, and canvas remain unchanged`);
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const api = window.__CITYGEN__;
    const state = api?.getState?.();
    return typeof api?.getCity === 'function'
      && typeof api?.getRenderer === 'function'
      && typeof api?.setCameraPose === 'function'
      && typeof api?.setTime === 'function'
      && state?.generator === 'sf-builtin'
      && state?.buildings === 700
      && !state?.busy;
  }, { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__CITYGEN__.setTime(14));
  await page.waitForTimeout(300);

  const runtime = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const canvas = renderer.renderer?.domElement;
    window.__CITYGEN_HERO_IDENTITY__ = {
      renderer,
      root: renderer.root,
      scene: renderer.scene,
      canvas,
    };
    // Facade budget comparisons must not vary with moving actor culling.
    // The normal live-world capture remains covered by the simulation gates.
    const traffic = api.getTraffic?.();
    if (traffic?.group) traffic.group.visible = false;
    const hero = renderer.heroFacadeDiagnostics || null;
    const roof = renderer.heroRoofDiagnostics || null;
    const footprint = renderer.buildingFootprintDiagnostics || null;
    return {
      backend: renderer.rendererBackend,
      time: api.getState().clock,
      hero: hero ? {
        heroes: Array.isArray(hero.heroes) ? hero.heroes.map((entry) => ({
          id: entry?.id,
          footprintMode: entry?.footprintMode,
          finite: entry?.finite,
          roofline: entry?.roofline,
          cornice: entry?.cornice,
          parapet: entry?.parapet,
          patternKeys: Array.isArray(entry?.patternKeys) ? [...entry.patternKeys] : null,
        })) : null,
        drawGroups: hero.drawGroups,
        triangleDelta: hero.triangleDelta,
      } : null,
      roof: roof ? {
        expectedIds: Array.isArray(roof.expectedIds) ? [...roof.expectedIds] : null,
        builtIds: Array.isArray(roof.builtIds) ? [...roof.builtIds] : null,
        skippedIds: Array.isArray(roof.skippedIds) ? [...roof.skippedIds] : null,
        entries: Array.isArray(roof.entries) ? roof.entries.map((entry) => ({
          id: entry?.id,
          sourceVertexCount: entry?.sourceVertexCount,
          profile: entry?.profile,
          parapetDepth: entry?.parapetDepth,
          parapetHeight: entry?.parapetHeight,
          mechanicalBoxCount: entry?.mechanicalBoxCount,
          centroid: entry?.centroid ? { ...entry.centroid } : null,
        })) : null,
        sourceEdges: roof.sourceEdges,
        parapetTriangles: roof.parapetTriangles,
        mechanicalBoxes: roof.mechanicalBoxes,
        mechanicalTriangles: roof.mechanicalTriangles,
        triangleDelta: roof.triangleDelta,
        drawGroups: roof.drawGroups,
        geometries: roof.geometries,
        textures: roof.textures,
        finite: roof.finite,
        normalsFinite: roof.normalsFinite,
        minNormalLength: roof.minNormalLength,
        maxNormalLength: roof.maxNormalLength,
        maxFootprintOvershootMeters: roof.maxFootprintOvershootMeters,
        minRoofClearanceMeters: roof.minRoofClearanceMeters,
        materialPass: roof.materialPass,
        atlasUrl: roof.atlasUrl,
        atlasTextureShared: roof.atlasTextureShared,
        uvFinite: roof.uvFinite,
        uvWithinAssignedCell: roof.uvWithinAssignedCell,
        parapetFaceTriangles: roof.parapetFaceTriangles ? { ...roof.parapetFaceTriangles } : null,
        mechanicalColorVertices: roof.mechanicalColorVertices,
        shadowCasters: roof.shadowCasters,
        shadowReceivers: roof.shadowReceivers,
        materialCount: roof.materialCount,
        incremental: roof.incremental ? { ...roof.incremental } : null,
        pbr: roof.pbr ? JSON.parse(JSON.stringify(roof.pbr)) : null,
      } : null,
      footprint: footprint ? {
        sourceCount: footprint.sourceCount,
        polygonShells: footprint.polygonShells,
        fallbacks: footprint.fallbacks,
        finite: footprint.finite,
        maxAreaRelativeError: footprint.maxAreaRelativeError,
        triangleDelta: footprint.triangleDelta,
      } : null,
      canvases: document.querySelectorAll('canvas').length,
      sceneCanvases: document.querySelectorAll('#scene-canvas').length,
      rootOccurrences: renderer.scene.children.filter((child) => child === renderer.root).length,
    };
  });
  report.runtime = runtime;

  assert.equal(runtime.backend, 'webgpu', 'canonical renderer uses WebGPU');
  assert.equal(runtime.sceneCanvases, 1, 'exactly one canonical scene canvas exists');
  assert.ok(runtime.canvases <= 2, 'canonical scene and minimap are the only canvases');
  assert.equal(runtime.rootOccurrences, 1, 'world root is attached to the scene exactly once');

  assert.ok(runtime.footprint,
    'getRenderer().buildingFootprintDiagnostics is required; footprint contract is absent');
  assert.equal(runtime.footprint.sourceCount, 700, 'footprint diagnostics sourceCount is 700');
  assert.equal(runtime.footprint.polygonShells + runtime.footprint.fallbacks, 700,
    'polygon shells plus explicit fallbacks cover all 700 buildings');
  assert.equal(runtime.footprint.finite, true, 'footprint geometry is finite');
  assert.ok(Number.isFinite(runtime.footprint.maxAreaRelativeError),
    'footprint max area relative error is finite');
  assert.ok(runtime.footprint.maxAreaRelativeError <= 0.001,
    `footprint max area relative error <=0.001 (${runtime.footprint.maxAreaRelativeError})`);

  assert.ok(runtime.hero,
    'getRenderer().heroFacadeDiagnostics is required; hero facade contract is absent');
  assert.ok(Array.isArray(runtime.hero.heroes), 'hero diagnostics expose a heroes list');
  assert.equal(runtime.hero.heroes.length, 6, 'hero diagnostics cover exactly six buildings');

  const heroIds = runtime.hero.heroes.map((entry) => entry.id);
  assert.equal(new Set(heroIds).size, 6, 'hero diagnostics contain no duplicate ids');
  assert.deepEqual([...heroIds].sort(), [...HERO_IDS].sort(),
    'hero diagnostics cover the exact audited building id set');

  const patternKeyUnion = new Set();
  for (const entry of runtime.hero.heroes) {
    const label = entry.id;
    assert.equal(entry.footprintMode, 'polygon-footprint',
      `${label}: hero shell uses its source polygon footprint`);
    assert.equal(entry.finite, true, `${label}: hero shell geometry is finite`);
    assert.equal(entry.roofline, true, `${label}: hero roofline is represented`);
    assert.equal(entry.cornice, true, `${label}: hero cornice is represented`);
    assert.equal(entry.parapet, true, `${label}: hero parapet is represented`);
    assert.ok(Array.isArray(entry.patternKeys) && entry.patternKeys.length > 0,
      `${label}: hero reports at least one facade pattern key`);
    for (const key of entry.patternKeys) {
      assert.ok(typeof key === 'string' && key.length > 0,
        `${label}: facade pattern keys are non-empty strings`);
      patternKeyUnion.add(key);
    }
  }
  assert.ok(patternKeyUnion.size >= 3,
    `hero facades use at least three distinct pattern keys (${patternKeyUnion.size})`);

  assert.ok(Number.isFinite(runtime.hero.drawGroups), 'hero draw-group count is finite');
  assert.ok(runtime.hero.drawGroups <= 3,
    `hero facades merge into no more than three draw groups (${runtime.hero.drawGroups})`);
  assert.ok(Number.isFinite(runtime.hero.triangleDelta), 'hero triangle delta is finite');
  // Audited UV/material regrouping may add zero triangles; anything positive
  // must stay inside the bounded delta cap either way.
  assert.ok(runtime.hero.triangleDelta <= 5000,
    `hero facade triangle delta <=5000 (${runtime.hero.triangleDelta})`);
  report.zeroNewTriangles = runtime.hero.triangleDelta === 0;

  assert.ok(runtime.roof,
    'getRenderer().heroRoofDiagnostics is required; actual hero roof contract is absent');
  assert.deepEqual([...runtime.roof.expectedIds].sort(), [...HERO_IDS].sort(),
    'roof diagnostics expect the exact audited six buildings');
  assert.deepEqual([...runtime.roof.builtIds].sort(), [...HERO_IDS].sort(),
    'actual roof geometry was built for the exact audited six buildings');
  assert.deepEqual(runtime.roof.skippedIds, [], 'no hero roof geometry was skipped');
  assert.equal(new Set(runtime.roof.builtIds).size, 6, 'roof diagnostics contain no duplicate ids');
  assert.equal(runtime.roof.entries.length, 6, 'roof diagnostics expose six per-building entries');
  const expectedVertices = new Map([
    ['sf-building-132127809', 17],
    ['sf-building-151183777', 4],
    ['sf-building-132127810', 5],
    ['sf-building-149335987', 5],
    ['sf-building-149335979', 9],
    ['sf-building-149335988', 11],
  ]);
  for (const entry of runtime.roof.entries) {
    assert.equal(entry.sourceVertexCount, expectedVertices.get(entry.id),
      `${entry.id}: roof consumes the unchanged source polygon vertex count`);
    assert.ok(typeof entry.profile === 'string' && entry.profile.length > 0,
      `${entry.id}: roof reports a source-inspired profile key`);
    assert.ok(entry.parapetDepth > 0 && entry.parapetHeight > 0,
      `${entry.id}: parapet dimensions are positive`);
    assert.ok(Number.isInteger(entry.mechanicalBoxCount) && entry.mechanicalBoxCount > 0,
      `${entry.id}: mechanical presentation is represented`);
    assert.ok(entry.centroid && [entry.centroid.x, entry.centroid.y, entry.centroid.z].every(Number.isFinite),
      `${entry.id}: roof centroid is finite`);
  }
  assert.equal(runtime.roof.sourceEdges, 51, 'roof batches consume all 51 source polygon edges');
  assert.equal(runtime.roof.parapetTriangles, 306, 'parapet ring triangle count is exact');
  assert.equal(runtime.roof.mechanicalBoxes, 13, 'mechanical presentation uses exactly 13 boxes');
  assert.equal(runtime.roof.mechanicalTriangles, 156, 'mechanical triangle count is exact');
  assert.equal(runtime.roof.triangleDelta, 462, 'roof presentation adds exactly 462 triangles');
  assert.ok(runtime.roof.drawGroups <= 2,
    `roof presentation uses <=2 draw groups (${runtime.roof.drawGroups})`);
  assert.equal(runtime.roof.geometries, 2, 'roof presentation uses exactly two live geometries');
  assert.equal(runtime.roof.textures, 0, 'roof presentation adds no textures');
  assert.equal(runtime.roof.finite, true, 'roof positions and indices are finite');
  assert.equal(runtime.roof.normalsFinite, true, 'roof normals are finite');
  assert.ok(runtime.roof.minNormalLength >= 0.999,
    `minimum roof normal length >=0.999 (${runtime.roof.minNormalLength})`);
  assert.ok(runtime.roof.maxNormalLength <= 1.001,
    `maximum roof normal length <=1.001 (${runtime.roof.maxNormalLength})`);
  assert.ok(runtime.roof.maxFootprintOvershootMeters <= 0.01,
    `roof geometry stays inside/on source footprint (${runtime.roof.maxFootprintOvershootMeters}m)`);
  assert.ok(runtime.roof.minRoofClearanceMeters >= 0.02,
    `roof geometry clears source cap by >=0.02m (${runtime.roof.minRoofClearanceMeters}m)`);
  assert.equal(runtime.roof.materialPass, 'hero-roof-grounding-v1',
    'roof material grounding contract version is explicit');
  assert.equal(runtime.roof.atlasUrl, '/assets/sf-market-kearny-hero-atlas-v1.png',
    'roof presentation reuses the canonical hero atlas');
  assert.equal(runtime.roof.atlasTextureShared, true,
    'parapets share the exact loaded facade atlas texture object');
  assert.equal(runtime.roof.uvFinite, true, 'parapet atlas UVs are finite');
  assert.equal(runtime.roof.uvWithinAssignedCell, true, 'parapet UVs stay inside assigned atlas cells');
  assert.deepEqual(runtime.roof.parapetFaceTriangles, { outer: 102, inner: 102, top: 102 },
    'parapet face roles retain the exact 306-triangle split');
  assert.equal(runtime.roof.mechanicalColorVertices, 312,
    'all 13 HVAC/crown boxes receive grounded face colors');
  assert.equal(runtime.roof.shadowCasters, 2, 'both roof batches cast shadows');
  assert.equal(runtime.roof.shadowReceivers, 2, 'both roof batches receive shadows');
  assert.equal(runtime.roof.materialCount, 2, 'roof presentation retains two materials');
  assert.deepEqual(runtime.roof.incremental, { drawGroups: 0, triangles: 0, geometries: 0, textures: 0 },
    'material grounding adds no structural render cost');
  assert.deepEqual(runtime.roof.pbr, {
    parapet: { roughness: 0.84, metalness: 0.02 },
    mechanical: { roughness: 0.7, metalness: 0.14 },
  }, 'roof PBR values match the grounded material contract');

  await page.addStyleTag({
    content: '.brand,.toolbar,.readout,.hint,.minimap,.inspector,.status-pill,.osm-overlay{display:none!important}',
  });
  await page.evaluate(() => window.__CITYGEN__.setCameraPose('sf'));
  await page.waitForTimeout(600);
  const hero = await sampleRenderer();
  await page.screenshot({ path: '.qa-citygen-hero-facades.png' });
  report.render.hero = hero;
  assertRenderBudget(hero, 'hero', HERO_POSE_CAPS);

  const elevatedVisibility = await page.evaluate(() => {
    const renderer = window.__CITYGEN__.getRenderer();
    renderer.camera.position.set(1470, 180, 1160);
    renderer.controls.target.set(1375, 25, 1045);
    renderer.camera.fov = 50;
    renderer.camera.updateProjectionMatrix();
    renderer.controls.update();
    renderer.camera.updateMatrixWorld(true);
    return renderer.heroRoofDiagnostics.entries.map((entry) => {
      const projected = renderer.camera.position.clone()
        .set(entry.centroid.x, entry.centroid.y, entry.centroid.z)
        .project(renderer.camera);
      return { id: entry.id, x: projected.x, y: projected.y, z: projected.z };
    });
  });
  report.elevatedVisibility = elevatedVisibility;
  for (const entry of elevatedVisibility) {
    assert.ok(Math.abs(entry.x) <= 0.92 && Math.abs(entry.y) <= 0.92 && entry.z >= -1 && entry.z <= 1,
      `${entry.id}: roof centroid is visible in the matched elevated frame`);
  }
  await page.waitForTimeout(600);
  const elevated = await sampleRenderer();
  await page.screenshot({ path: '.qa-citygen-hero-roofs.png' });
  report.render.elevated = elevated;
  assertRenderBudget(elevated, 'elevated', ELEVATED_POSE_CAPS);

  await page.evaluate(() => window.__CITYGEN__.setCameraPose('aerial'));
  await page.waitForTimeout(500);
  const aerial = await sampleRenderer();
  report.render.aerial = aerial;
  assertRenderBudget(aerial, 'aerial', AERIAL_POSE_CAPS);

  assert.deepEqual(errors, [], 'hero facade render emits no browser errors');

  console.log(JSON.stringify({
    result: 'PASS',
    url,
    ...report,
    screenshots: ['.qa-citygen-hero-facades.png', '.qa-citygen-hero-roofs.png'],
    errors,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    result: 'FAIL',
    url,
    message: error.message,
    ...report,
    errors,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
