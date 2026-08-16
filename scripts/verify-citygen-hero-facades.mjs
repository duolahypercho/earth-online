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
const HERO_ATLAS_CELLS = Object.freeze(new Map([
  ['sf-building-132127809', 0],
  ['sf-building-151183777', 1],
  ['sf-building-132127810', 2],
  ['sf-building-149335987', 3],
  ['sf-building-149335979', 4],
  ['sf-building-149335988', 5],
]));
const HERO_SOURCE_VERTEX_COUNTS = Object.freeze(new Map([
  ['sf-building-132127809', 17],
  ['sf-building-151183777', 4],
  ['sf-building-132127810', 5],
  ['sf-building-149335987', 5],
  ['sf-building-149335979', 9],
  ['sf-building-149335988', 11],
]));

// Traffic is hidden for deterministic facade/roof isolation. The 642a296
// atlas baseline is 471 draws / 504,374 triangles on the canonical hero pose
// and 858 / 521,007 aerial. Actual roof geometry gets only two draw groups and
// 462 triangles; these caps retain a tiny scheduling/culling margin.
const HERO_POSE_CAPS = Object.freeze({ drawCalls: 476, triangles: 505500 });
const ELEVATED_POSE_CAPS = Object.freeze({ drawCalls: 900, triangles: 530000 });
const AERIAL_POSE_CAPS = Object.freeze({ drawCalls: 864, triangles: 522150 });

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
    const ground = renderer.heroGroundDiagnostics || null;
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
          streetwall: entry?.streetwall ? {
            atlasCell: entry.streetwall.atlasCell,
            wallEdges: entry.streetwall.wallEdges,
            wallVertices: entry.streetwall.wallVertices,
            contactTreatment: entry.streetwall.contactTreatment,
            facadeNeutralVertices: entry.streetwall.facadeNeutralVertices,
            finite: entry.streetwall.finite,
          } : null,
          entrance: entry?.entrance ? {
            portalId: entry.entrance.portalId,
            portalIndex: entry.entrance.portalIndex,
            panelInstances: entry.entrance.panelInstances,
            frameInstances: entry.entrance.frameInstances,
            cueInstances: entry.entrance.cueInstances,
            recessedMeters: entry.entrance.recessedMeters,
            revealDepthMeters: entry.entrance.revealDepthMeters,
            thresholdGapMeters: entry.entrance.thresholdGapMeters,
            transomCue: entry.entrance.transomCue,
            positionUnchanged: entry.entrance.positionUnchanged,
            headingUnchanged: entry.entrance.headingUnchanged,
            finite: entry.entrance.finite,
          } : null,
        })) : null,
        drawGroups: hero.drawGroups,
        triangleDelta: hero.triangleDelta,
        streetwall: hero.streetwall ? {
          schemaVersion: hero.streetwall.schemaVersion,
          pass: hero.streetwall.pass,
          expectedIds: Array.isArray(hero.streetwall.expectedIds) ? [...hero.streetwall.expectedIds] : null,
          treatedIds: Array.isArray(hero.streetwall.treatedIds) ? [...hero.streetwall.treatedIds] : null,
          portalStyledIds: Array.isArray(hero.streetwall.portalStyledIds) ? [...hero.streetwall.portalStyledIds] : null,
          wallEdges: hero.streetwall.wallEdges,
          wallVertices: hero.streetwall.wallVertices,
          contactTreatment: hero.streetwall.contactTreatment,
          facadeNeutralVertices: hero.streetwall.facadeNeutralVertices,
          finite: hero.streetwall.finite,
          sourceFootprintsUnchanged: hero.streetwall.sourceFootprintsUnchanged,
          sourcePortalsUnchanged: hero.streetwall.sourcePortalsUnchanged,
          portalPositionsUnchanged: hero.streetwall.portalPositionsUnchanged,
          portalHeadingsUnchanged: hero.streetwall.portalHeadingsUnchanged,
          portalPanelInstances: hero.streetwall.portalPanelInstances,
          portalFrameInstances: hero.streetwall.portalFrameInstances,
          portalCueInstances: hero.streetwall.portalCueInstances,
          storefront: hero.streetwall.storefront ? {
            pass: hero.streetwall.storefront.pass,
            expectedIds: Array.isArray(hero.streetwall.storefront.expectedIds)
              ? [...hero.streetwall.storefront.expectedIds] : null,
            builtIds: Array.isArray(hero.streetwall.storefront.builtIds)
              ? [...hero.streetwall.storefront.builtIds] : null,
            skippedIds: Array.isArray(hero.streetwall.storefront.skippedIds)
              ? [...hero.streetwall.storefront.skippedIds] : null,
            entries: Array.isArray(hero.streetwall.storefront.entries)
              ? hero.streetwall.storefront.entries.map((entry) => ({ ...entry })) : null,
            displayInstances: hero.streetwall.storefront.displayInstances,
            trimInstances: hero.streetwall.storefront.trimInstances,
            drawGroups: hero.streetwall.storefront.drawGroups,
            triangles: hero.streetwall.storefront.triangles,
            geometries: hero.streetwall.storefront.geometries,
            textures: hero.streetwall.storefront.textures,
            materialProfiles: hero.streetwall.storefront.materialProfiles,
            minimumPortalClearanceMeters: hero.streetwall.storefront.minimumPortalClearanceMeters,
            minimumEdgeClearanceMeters: hero.streetwall.storefront.minimumEdgeClearanceMeters,
            absoluteRoadOverlaps: hero.streetwall.storefront.absoluteRoadOverlaps,
            additionalRoadIntrusions: hero.streetwall.storefront.additionalRoadIntrusions,
            sourcePortalsUnchanged: hero.streetwall.storefront.sourcePortalsUnchanged,
            finite: hero.streetwall.storefront.finite,
          } : null,
          incremental: hero.streetwall.incremental ? { ...hero.streetwall.incremental } : null,
        } : null,
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
      ground: ground ? {
        pass: ground.pass,
        expectedIds: Array.isArray(ground.expectedIds) ? [...ground.expectedIds] : null,
        builtIds: Array.isArray(ground.builtIds) ? [...ground.builtIds] : null,
        skippedIds: Array.isArray(ground.skippedIds) ? [...ground.skippedIds] : null,
        entries: Array.isArray(ground.entries) ? ground.entries.map((entry) => ({ ...entry })) : null,
        sourceEdges: ground.sourceEdges,
        renderedEdges: ground.renderedEdges,
        skippedRoadEdges: ground.skippedRoadEdges,
        vertices: ground.vertices,
        triangles: ground.triangles,
        drawGroups: ground.drawGroups,
        geometries: ground.geometries,
        textures: ground.textures,
        bandHeightMeters: ground.bandHeightMeters,
        outwardOffsetMeters: ground.outwardOffsetMeters,
        finite: ground.finite,
        roadChecks: ground.roadChecks,
        roadIntrusions: ground.roadIntrusions,
        sourceFootprintsUnchanged: ground.sourceFootprintsUnchanged,
        sourcePortalsUnchanged: ground.sourcePortalsUnchanged,
        incremental: ground.incremental ? { ...ground.incremental } : null,
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

  const streetwall = runtime.hero.streetwall;
  assert.ok(streetwall,
    'heroFacadeDiagnostics.streetwall is required; streetwall grounding contract is absent');
  assert.equal(streetwall.schemaVersion, 1,
    'streetwall diagnostics schema version is 1');
  assert.equal(streetwall.pass, 'hero-streetwall-grounding-v1',
    'streetwall grounding contract version is explicit');
  for (const field of ['expectedIds', 'treatedIds', 'portalStyledIds']) {
    assert.ok(Array.isArray(streetwall[field]),
      `streetwall diagnostics expose ${field}`);
    assert.equal(streetwall[field].length, HERO_IDS.length,
      `streetwall ${field} cover exactly six buildings`);
    assert.equal(new Set(streetwall[field]).size, HERO_IDS.length,
      `streetwall ${field} contain no duplicate ids`);
    assert.deepEqual([...streetwall[field]].sort(), [...HERO_IDS].sort(),
      `streetwall ${field} cover the exact audited building id set`);
  }
  assert.equal(streetwall.wallEdges, 51,
    'streetwall presentation consumes all 51 source polygon edges');
  assert.equal(streetwall.wallVertices, 204,
    'streetwall presentation exposes exactly 204 wall vertices');
  assert.equal(streetwall.contactTreatment, 'recessed-portal-reveal-v1',
    'streetwall contact treatment uses the existing portal reveal batches');
  assert.equal(streetwall.facadeNeutralVertices, 204,
    'streetwall treatment preserves all facade vertices at neutral atlas color');
  assert.equal(streetwall.finite, true,
    'streetwall geometry and metadata are finite');
  assert.equal(streetwall.sourceFootprintsUnchanged, true,
    'streetwall pass preserves source building footprints');
  assert.equal(streetwall.sourcePortalsUnchanged, true,
    'streetwall pass preserves canonical source portals');
  assert.equal(streetwall.portalPositionsUnchanged, true,
    'streetwall pass preserves canonical portal positions');
  assert.equal(streetwall.portalHeadingsUnchanged, true,
    'streetwall pass preserves canonical portal headings');
  assert.equal(streetwall.portalPanelInstances, 6,
    'streetwall pass reuses one portal panel instance per hero');
  assert.equal(streetwall.portalFrameInstances, 18,
    'streetwall pass reuses three portal frame instances per hero');
  assert.equal(streetwall.portalCueInstances, 6,
    'streetwall pass reuses one portal cue instance per hero');
  assert.deepEqual(streetwall.incremental,
    { drawGroups: 0, triangles: 0, geometries: 0, textures: 0, instances: 0 },
    'streetwall grounding adds no structural render cost');

  const portalIndices = [];
  const portalIds = [];
  for (const entry of runtime.hero.heroes) {
    const label = entry.id;
    const expectedEdges = HERO_SOURCE_VERTEX_COUNTS.get(label);
    const expectedCell = HERO_ATLAS_CELLS.get(label);
    assert.ok(entry.streetwall,
      `${label}: per-hero streetwall metadata is required`);
    assert.equal(entry.streetwall.atlasCell, expectedCell,
      `${label}: streetwall metadata remains in its canonical atlas cell`);
    assert.equal(entry.streetwall.wallEdges, expectedEdges,
      `${label}: streetwall wall edges match the unchanged source footprint`);
    assert.equal(entry.streetwall.wallVertices, expectedEdges * 4,
      `${label}: streetwall wall vertices equal four per source edge`);
    assert.equal(entry.streetwall.contactTreatment, 'recessed-portal-reveal-v1',
      `${label}: streetwall contact treatment uses its canonical portal reveal`);
    assert.equal(entry.streetwall.facadeNeutralVertices, expectedEdges * 4,
      `${label}: facade vertices remain neutral and preserve atlas detail`);
    assert.equal(entry.streetwall.finite, true,
      `${label}: streetwall geometry and metadata are finite`);

    assert.ok(entry.entrance,
      `${label}: per-hero entrance metadata is required`);
    assert.equal(entry.entrance.portalId, `sf-portal:${label}`,
      `${label}: streetwall entrance is linked to its canonical portal`);
    assert.ok(Number.isInteger(entry.entrance.portalIndex) && entry.entrance.portalIndex >= 0,
      `${label}: portal index is a finite non-negative integer`);
    assert.equal(entry.entrance.panelInstances, 1,
      `${label}: entrance reuses one portal panel instance`);
    assert.equal(entry.entrance.frameInstances, 3,
      `${label}: entrance reuses three portal frame instances`);
    assert.equal(entry.entrance.cueInstances, 1,
      `${label}: entrance reuses one portal cue instance`);
    assert.equal(entry.entrance.recessedMeters, 0.31,
      `${label}: entrance panel is recessed 0.31 metres into its frontage`);
    assert.equal(entry.entrance.revealDepthMeters, 0.04,
      `${label}: entrance exposes a shallow reveal in front of the recessed panel`);
    assert.equal(entry.entrance.thresholdGapMeters, 0.1,
      `${label}: raised entrance panel exposes a grounded threshold gap`);
    assert.equal(entry.entrance.transomCue, true,
      `${label}: entrance reuses its cue instance as a warm transom`);
    assert.equal(entry.entrance.positionUnchanged, true,
      `${label}: portal position remains unchanged`);
    assert.equal(entry.entrance.headingUnchanged, true,
      `${label}: portal heading remains unchanged`);
    assert.equal(entry.entrance.finite, true,
      `${label}: entrance metadata is finite`);
    portalIndices.push(entry.entrance.portalIndex);
    portalIds.push(entry.entrance.portalId);
  }
  assert.equal(new Set(portalIndices).size, HERO_IDS.length,
    'hero entrance metadata contains no duplicate portal indices');
  assert.equal(new Set(portalIds).size, HERO_IDS.length,
    'hero entrance metadata contains no duplicate portal ids');

  const storefront = streetwall.storefront;
  assert.ok(storefront, 'hero streetwall exposes the authored storefront contract');
  assert.equal(storefront.pass, 'hero-storefronts-v1', 'storefront contract version is explicit');
  assert.deepEqual([...storefront.expectedIds].sort(), [...HERO_IDS].sort(),
    'storefront diagnostics expect the exact six hero buildings');
  assert.deepEqual([...storefront.builtIds].sort(), [...HERO_IDS].sort(),
    'storefront presentation covers the exact six hero buildings');
  assert.deepEqual(storefront.skippedIds, [], 'no hero storefront is skipped');
  assert.equal(storefront.entries.length, 6, 'storefront diagnostics expose six entries');
  const storefrontProfiles = new Set();
  for (const entry of storefront.entries) {
    assert.ok(HERO_IDS.includes(entry.id), `${entry.id}: storefront belongs to the audited hero set`);
    assert.ok(Number.isInteger(entry.sourceEdgeIndex) && entry.sourceEdgeIndex >= 0,
      `${entry.id}: storefront is attached to a concrete source edge`);
    assert.ok(entry.sourceEdgeLength >= 7.8,
      `${entry.id}: storefront source edge is wide enough (${entry.sourceEdgeLength}m)`);
    assert.equal(entry.displayInstances, 2, `${entry.id}: storefront has two display bays`);
    assert.equal(entry.trimInstances, 5, `${entry.id}: storefront has four jambs and one canopy`);
    assert.ok(entry.portalClearanceMeters >= 0.075,
      `${entry.id}: storefront clears the canonical portal (${entry.portalClearanceMeters}m)`);
    assert.ok(entry.edgeClearanceMeters >= 1.7,
      `${entry.id}: storefront remains inside its source frontage (${entry.edgeClearanceMeters}m)`);
    assert.equal(entry.finite, true, `${entry.id}: storefront placement is finite`);
    storefrontProfiles.add(entry.profile);
  }
  assert.equal(storefrontProfiles.size, 6, 'all six storefronts use distinct authored profiles');
  assert.equal(storefront.displayInstances, 12, 'storefronts use exactly 12 display instances');
  assert.equal(storefront.trimInstances, 30, 'storefronts use exactly 30 trim/canopy instances');
  assert.equal(storefront.drawGroups, 2, 'storefronts use exactly two instanced draw groups');
  assert.equal(storefront.triangles, 504, 'storefronts add exactly 504 rendered triangles');
  assert.equal(storefront.geometries, 2, 'storefronts use exactly two geometries');
  assert.equal(storefront.textures, 0, 'storefronts add no textures');
  assert.equal(storefront.materialProfiles, 6, 'storefront diagnostics retain six material profiles');
  assert.ok(storefront.minimumPortalClearanceMeters >= 0.075,
    'storefront presentation preserves a traversable central portal gap');
  assert.ok(storefront.minimumEdgeClearanceMeters >= 1.7,
    'storefront presentation stays inside all source frontage edges');
  assert.ok(Number.isInteger(storefront.absoluteRoadOverlaps) && storefront.absoluteRoadOverlaps >= 0,
    'storefront diagnostics report source-level absolute road overlaps');
  assert.equal(storefront.additionalRoadIntrusions, 0,
    'storefront components are never closer to asphalt than their canonical portal plane');
  assert.equal(storefront.sourcePortalsUnchanged, true, 'storefronts preserve canonical portal transforms');
  assert.equal(storefront.finite, true, 'storefront geometry metadata is finite');

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

  assert.ok(runtime.ground,
    'getRenderer().heroGroundDiagnostics is required; base-occlusion contract is absent');
  assert.equal(runtime.ground.pass, 'hero-base-occlusion-v1',
    'hero base-occlusion contract version is explicit');
  assert.deepEqual([...runtime.ground.expectedIds].sort(), [...HERO_IDS].sort(),
    'base-occlusion diagnostics expect the exact audited six buildings');
  assert.deepEqual([...runtime.ground.builtIds].sort(), [...HERO_IDS].sort(),
    'base-occlusion geometry covers the exact audited six buildings');
  assert.deepEqual(runtime.ground.skippedIds, [], 'no hero base-occlusion geometry was skipped');
  assert.equal(runtime.ground.entries.length, 6, 'base-occlusion diagnostics expose six entries');
  for (const entry of runtime.ground.entries) {
    assert.equal(entry.sourceVertexCount, HERO_SOURCE_VERTEX_COUNTS.get(entry.id),
      `${entry.id}: base band follows the unchanged source edge count`);
    assert.equal(entry.finite, true, `${entry.id}: base band is finite`);
  }
  assert.equal(runtime.ground.sourceEdges, 51, 'base-band gate considers all 51 source edges');
  assert.equal(runtime.ground.renderedEdges, 47, 'base bands render the 47 non-road source edges');
  assert.equal(runtime.ground.skippedRoadEdges, 4, 'four asphalt-overlapping source edges are culled');
  assert.equal(runtime.ground.vertices, 282, 'base bands contain exactly 282 vertices');
  assert.equal(runtime.ground.triangles, 94, 'base bands add exactly 94 triangles');
  assert.equal(runtime.ground.drawGroups, 1, 'base bands merge into exactly one draw group');
  assert.equal(runtime.ground.geometries, 1, 'base bands use exactly one live geometry');
  assert.equal(runtime.ground.textures, 0, 'base bands add no textures');
  assert.equal(runtime.ground.bandHeightMeters, 0.12, 'base band height is restrained to 0.12m');
  assert.equal(runtime.ground.outwardOffsetMeters, 0.012,
    'base band clears facade z-fighting by only 0.012m');
  assert.equal(runtime.ground.finite, true, 'base band positions, normals, and colors are finite');
  assert.equal(runtime.ground.roadChecks, 51, 'every source edge is checked against asphalt');
  assert.equal(runtime.ground.roadIntrusions, 0, 'base bands do not intrude into road asphalt');
  assert.equal(runtime.ground.sourceFootprintsUnchanged, true, 'base bands preserve source footprints');
  assert.equal(runtime.ground.sourcePortalsUnchanged, true, 'base bands preserve source portals');
  assert.deepEqual(runtime.ground.incremental,
    { drawGroups: 1, triangles: 94, geometries: 1, textures: 0 },
    'base-occlusion cost is exact and bounded');

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
