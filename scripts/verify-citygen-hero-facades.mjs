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

const HERO_SIGNAGE_LABELS = Object.freeze(new Map([
  ['sf-building-132127809', 'HEARST BUILDING'],
  ['sf-building-132127810', 'CENTRAL TOWER'],
  ['sf-building-149335979', '1 KEARNY'],
  ['sf-building-149335987', '700 MARKET'],
  ['sf-building-149335988', 'MARKET LOFTS'],
  ['sf-building-151183777', 'MARKET STREET'],
]));

const STOREFRONT_RENDER_BASELINE = Object.freeze({
  hero: { drawCalls: 476, triangles: 449146, geometries: 401, textures: 258 },
  elevated: { drawCalls: 252, triangles: 439854, geometries: 401, textures: 258 },
  aerial: { drawCalls: 863, triangles: 522067, geometries: 401, textures: 258 },
});

const HERO_CURB_PRESENTATION_DELTA = Object.freeze({
  // The Market curb-surface pass adds exactly two merged submissions and
  // 94 triangles to the pre-existing curb-life envelope; matched facade
  // poses may cull either surface mesh, so this remains a hard upper bound.
  drawCalls: 6,
  triangles: 614,
  geometries: 4,
  textures: 0,
});

// Traffic is hidden for deterministic facade/roof isolation. The 642a296
// atlas baseline is 471 draws / 504,374 triangles on the canonical hero pose
// and 858 / 521,007 aerial. Actual roof geometry gets only two draw groups and
// 462 triangles; these caps retain a tiny scheduling/culling margin.
// f23fd16 keeps the exact hero budgets while retaining the shared authored
// vehicle hull geometry introduced by the independently verified vehicle pass.
const HERO_POSE_CAPS = Object.freeze({ drawCalls: 480, triangles: 505894, geometries: 405, textures: 261 });
const ELEVATED_POSE_CAPS = Object.freeze({ drawCalls: 259, triangles: 496696, geometries: 406, textures: 261 });
const AERIAL_POSE_CAPS = Object.freeze({ drawCalls: 870, triangles: 522693, geometries: 406, textures: 261 });

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
  assert.ok(sample.geometries <= caps.geometries,
    `${label}: geometries <=${caps.geometries} (${sample.geometries})`);
  assert.ok(sample.textures <= caps.textures,
    `${label}: textures <=${caps.textures} (${sample.textures})`);
  assert.deepEqual(sample.identity, { renderer: true, root: true, scene: true, canvas: true },
    `${label}: canonical renderer, root, scene, and canvas remain unchanged`);
}

function assertRenderDelta(sample, label) {
  const baseline = STOREFRONT_RENDER_BASELINE[label];
  assert.ok(baseline, `${label}: storefront render baseline is defined`);
  const maxima = {
    drawCalls: 1 + HERO_CURB_PRESENTATION_DELTA.drawCalls,
    triangles: 12 + HERO_CURB_PRESENTATION_DELTA.triangles,
    geometries: 1 + HERO_CURB_PRESENTATION_DELTA.geometries,
    textures: 3 + HERO_CURB_PRESENTATION_DELTA.textures,
  };
  for (const field of ['drawCalls', 'triangles', 'geometries', 'textures']) {
    const delta = sample[field] - baseline[field];
    assert.ok(Number.isFinite(delta) && delta >= 0 && delta <= maxima[field],
      `${label}: signage ${field} delta stays within +${maxima[field]} (${delta})`);
  }
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
    const groundMaterials = renderer.groundMaterialDiagnostics || null;
    const footprint = renderer.buildingFootprintDiagnostics || null;
    const signageMeshes = [];
    renderer.root.traverse((object) => {
      if (object?.name === 'hero-storefront-signage') signageMeshes.push(object);
    });
    const signageMesh = signageMeshes.length === 1 ? signageMeshes[0] : null;
    const geometry = signageMesh?.geometry || null;
    const uvAttribute = geometry?.getAttribute?.('uv') || null;
    const positionAttribute = geometry?.getAttribute?.('position') || null;
    const indexAttribute = geometry?.getIndex?.() || null;
    const uvGroups = [];
    if (uvAttribute) {
      for (let offset = 0; offset + 3 < uvAttribute.count; offset += 4) {
        const values = [];
        for (let vertex = offset; vertex < offset + 4; vertex += 1) {
          values.push({ u: uvAttribute.getX(vertex), v: uvAttribute.getY(vertex) });
        }
        const minU = Math.min(...values.map((value) => value.u));
        const maxU = Math.max(...values.map((value) => value.u));
        const minV = Math.min(...values.map((value) => value.v));
        const maxV = Math.max(...values.map((value) => value.v));
        const cells = [];
        for (let cell = 0; cell < 6; cell += 1) {
          const cellMin = cell / 6;
          const cellMax = (cell + 1) / 6;
          if (minU >= cellMin - 1e-6 && maxU <= cellMax + 1e-6) cells.push(cell);
        }
        uvGroups.push({ minU, maxU, minV, maxV, cells });
      }
    }
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
          signage: hero.streetwall.signage ? {
            schemaVersion: hero.streetwall.signage.schemaVersion,
            pass: hero.streetwall.signage.pass,
            expectedIds: Array.isArray(hero.streetwall.signage.expectedIds)
              ? [...hero.streetwall.signage.expectedIds] : null,
            builtIds: Array.isArray(hero.streetwall.signage.builtIds)
              ? [...hero.streetwall.signage.builtIds] : null,
            skippedIds: Array.isArray(hero.streetwall.signage.skippedIds)
              ? [...hero.streetwall.signage.skippedIds] : null,
            expectedLabels: Array.isArray(hero.streetwall.signage.expectedLabels)
              ? hero.streetwall.signage.expectedLabels.map((entry) => ({ ...entry })) : null,
            entries: Array.isArray(hero.streetwall.signage.entries)
              ? hero.streetwall.signage.entries.map((entry) => ({
                ...entry,
                position: entry?.position ? { ...entry.position } : null,
                uv: entry?.uv ? { ...entry.uv } : null,
              })) : null,
            signInstances: hero.streetwall.signage.signInstances,
            meshCount: hero.streetwall.signage.meshCount,
            drawGroups: hero.streetwall.signage.drawGroups,
            triangles: hero.streetwall.signage.triangles,
            geometries: hero.streetwall.signage.geometries,
            textures: hero.streetwall.signage.textures,
            minimumCanopyGapMeters: hero.streetwall.signage.minimumCanopyGapMeters,
            minimumEdgeClearanceMeters: hero.streetwall.signage.minimumEdgeClearanceMeters,
            absoluteRoadOverlaps: hero.streetwall.signage.absoluteRoadOverlaps,
            additionalRoadIntrusions: hero.streetwall.signage.additionalRoadIntrusions,
            sourcePortalsUnchanged: hero.streetwall.signage.sourcePortalsUnchanged,
            portalPositionsUnchanged: hero.streetwall.signage.portalPositionsUnchanged,
            portalHeadingsUnchanged: hero.streetwall.signage.portalHeadingsUnchanged,
            atlas: hero.streetwall.signage.atlas ? { ...hero.streetwall.signage.atlas } : null,
            incremental: hero.streetwall.signage.incremental
              ? { ...hero.streetwall.signage.incremental } : null,
            finite: hero.streetwall.signage.finite,
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
      groundMaterials: groundMaterials ? structuredClone(groundMaterials) : null,
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
      signageMesh: {
        count: signageMeshes.length,
        name: signageMesh?.name || null,
        kind: signageMesh?.userData?.kind || null,
        signCount: signageMesh?.userData?.signCount ?? null,
        atlasCells: signageMesh?.userData?.atlasCells ?? null,
        isMesh: signageMesh?.isMesh === true,
        matrixFinite: signageMesh?.matrix?.elements?.every(Number.isFinite) ?? false,
        positionFinite: signageMesh?.position
          ? [signageMesh.position.x, signageMesh.position.y, signageMesh.position.z].every(Number.isFinite)
          : false,
        geometryCount: geometry ? 1 : 0,
        indexed: Boolean(indexAttribute),
        positionCount: positionAttribute?.count ?? null,
        uvCount: uvAttribute?.count ?? null,
        indexCount: indexAttribute?.count ?? null,
        uvGroups,
        uvFinite: uvAttribute
          ? Array.from({ length: uvAttribute.count }, (_, index) => (
            Number.isFinite(uvAttribute.getX(index)) && Number.isFinite(uvAttribute.getY(index))
          )).every(Boolean)
          : false,
        mapCanvas: Boolean(signageMesh?.material?.map?.isCanvasTexture),
        mapWidth: signageMesh?.material?.map?.image?.width ?? null,
        mapHeight: signageMesh?.material?.map?.image?.height ?? null,
        mapColorSpace: signageMesh?.material?.map?.colorSpace ?? null,
      },
    };
  });
  report.runtime = runtime;

  assert.equal(runtime.backend, 'webgpu', 'canonical renderer uses WebGPU');
  assert.ok(runtime.groundMaterials, 'ground material diagnostics are present on the canonical renderer');
  assert.equal(runtime.groundMaterials.pass, 'sf-ground-materials-v1', 'ground material pass is explicit');
  assert.equal(runtime.groundMaterials.enabled, true, 'SF ground material pass remains enabled');
  assert.equal(runtime.groundMaterials.failure, null, 'SF ground material pass has no failure');
  assert.deepEqual(runtime.groundMaterials.resourceDelta,
    { drawGroups: 0, triangles: 0, geometries: 0, materials: 0, textures: 2, uvAttributes: 2 },
    'facade slice retains the exact ground material resource delta');
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

  const signage = streetwall.signage;
  assert.ok(signage, 'hero streetwall exposes the authored signage contract');
  assert.equal(signage.schemaVersion, 1, 'signage diagnostics schema version is 1');
  assert.equal(signage.pass, 'hero-signage-v1', 'signage contract version is explicit');
  for (const field of ['expectedIds', 'builtIds']) {
    assert.ok(Array.isArray(signage[field]), `signage diagnostics expose ${field}`);
    assert.equal(signage[field].length, HERO_IDS.length,
      `signage ${field} cover exactly six buildings`);
    assert.equal(new Set(signage[field]).size, HERO_IDS.length,
      `signage ${field} contain no duplicate ids`);
    assert.deepEqual([...signage[field]].sort(), [...HERO_IDS].sort(),
      `signage ${field} cover the exact audited building id set`);
  }
  assert.deepEqual(signage.skippedIds, [], 'no hero signage is skipped');
  assert.ok(Array.isArray(signage.expectedLabels), 'signage diagnostics expose expected labels');
  assert.equal(signage.expectedLabels.length, HERO_IDS.length,
    'signage diagnostics expose six expected labels');
  const expectedLabelIds = new Set();
  const expectedLabelValues = new Set();
  for (const entry of signage.expectedLabels) {
    assert.ok(entry && HERO_SIGNAGE_LABELS.has(entry.id),
      'each expected signage label belongs to the audited hero set');
    assert.equal(entry.label, HERO_SIGNAGE_LABELS.get(entry.id),
      `${entry.id}: expected San Francisco label is exact`);
    assert.ok(typeof entry.label === 'string' && entry.label.trim().length > 0,
      `${entry.id}: signage label is non-empty`);
    assert.equal(entry.atlasCell, HERO_ATLAS_CELLS.get(entry.id),
      `${entry.id}: signage label remains in its assigned atlas cell`);
    expectedLabelIds.add(entry.id);
    expectedLabelValues.add(entry.label);
  }
  assert.equal(expectedLabelIds.size, HERO_IDS.length,
    'signage expected labels contain no duplicate ids');
  assert.equal(expectedLabelValues.size, HERO_IDS.length,
    'signage expected labels are six unique SF identities');

  assert.ok(Array.isArray(signage.entries), 'signage diagnostics expose per-building entries');
  assert.equal(signage.entries.length, HERO_IDS.length, 'signage diagnostics expose six entries');
  const signageEntryIds = new Set();
  const signageEntryLabels = new Set();
  const signageEntryCells = new Set();
  for (const entry of signage.entries) {
    const label = entry?.id;
    assert.ok(HERO_SIGNAGE_LABELS.has(label), `${label}: signage belongs to the audited hero set`);
    assert.equal(signageEntryIds.has(label), false, `${label}: signage id is unique`);
    assert.equal(entry.label, HERO_SIGNAGE_LABELS.get(label),
      `${label}: storefront sign text is the exact authored SF label`);
    assert.ok(typeof entry.label === 'string' && entry.label.trim().length > 0,
      `${label}: storefront sign text is non-empty`);
    assert.equal(entry.atlasCell, HERO_ATLAS_CELLS.get(label),
      `${label}: storefront sign uses its assigned atlas cell`);
    assert.ok(Number.isInteger(entry.sourceEdgeIndex) && entry.sourceEdgeIndex >= 0,
      `${label}: signage is attached to a concrete source edge`);
    assert.ok(Number.isFinite(entry.sourceEdgeLength) && entry.sourceEdgeLength >= 7.8,
      `${label}: signage source edge is wide enough (${entry.sourceEdgeLength}m)`);
    for (const field of ['widthMeters', 'heightMeters', 'canopyGapMeters',
      'edgeClearanceMeters', 'portalPlaneOffsetMeters']) {
      assert.ok(Number.isFinite(entry[field]), `${label}: signage ${field} is finite`);
    }
    assert.ok(entry.widthMeters > 0, `${label}: signage width is positive`);
    assert.equal(entry.heightMeters, 0.52, `${label}: signage height is the authored 0.52m band`);
    assert.equal(entry.canopyGapMeters, 0.1,
      `${label}: signage preserves the authored 0.10m canopy/portal gap`);
    assert.equal(entry.portalPlaneOffsetMeters, -0.46,
      `${label}: signage remains 0.46m behind the canonical portal plane`);
    assert.ok(entry.edgeClearanceMeters >= 1.9,
      `${label}: signage stays inside its source frontage (${entry.edgeClearanceMeters}m)`);
    assert.ok(entry.position && [entry.position.x, entry.position.y, entry.position.z].every(Number.isFinite),
      `${label}: signage transform position is finite`);
    assert.ok(Number.isFinite(entry.heading), `${label}: signage transform heading is finite`);
    assert.ok(entry.uv && [entry.uv.u0, entry.uv.u1, entry.uv.v0, entry.uv.v1].every(Number.isFinite),
      `${label}: signage UV rectangle is finite`);
    const cellMin = entry.atlasCell / signage.atlas.columns;
    const cellMax = (entry.atlasCell + 1) / signage.atlas.columns;
    assert.ok(entry.uv.u0 >= cellMin - 1e-6 && entry.uv.u1 <= cellMax + 1e-6,
      `${label}: signage U coordinates stay inside assigned atlas cell`);
    assert.ok(entry.uv.v0 >= -1e-6 && entry.uv.v1 <= 1 + 1e-6,
      `${label}: signage V coordinates stay inside assigned atlas row`);
    assert.ok(Number.isInteger(entry.absoluteRoadOverlaps) && entry.absoluteRoadOverlaps >= 0,
      `${label}: signage reports source-level absolute road overlaps`);
    assert.equal(entry.additionalRoadIntrusions, 0,
      `${label}: signage adds no road intrusion beyond the canonical portal plane`);
    assert.equal(entry.finite, true, `${label}: signage transforms and UVs are finite`);
    signageEntryIds.add(label);
    signageEntryLabels.add(entry.label);
    signageEntryCells.add(entry.atlasCell);
  }
  assert.equal(signageEntryIds.size, HERO_IDS.length, 'signage entries contain no duplicate ids');
  assert.equal(signageEntryLabels.size, HERO_IDS.length, 'signage entries contain six unique labels');
  assert.deepEqual([...signageEntryCells].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5],
    'signage entries cover every assigned atlas cell exactly once');
  assert.equal(signage.signInstances, 6, 'signage uses exactly six sign instances');
  assert.equal(signage.meshCount, 1, 'signage uses exactly one mesh');
  assert.equal(signage.drawGroups, 1, 'signage uses exactly one draw group');
  assert.equal(signage.triangles, 12, 'signage adds exactly 12 rendered triangles');
  assert.equal(signage.geometries, 1, 'signage uses exactly one geometry');
  assert.equal(signage.textures, 1, 'signage uses exactly one atlas texture');
  assert.equal(signage.minimumCanopyGapMeters, 0.1,
    'signage preserves the authored minimum canopy/portal gap');
  assert.ok(Number.isFinite(signage.minimumEdgeClearanceMeters)
    && signage.minimumEdgeClearanceMeters >= 1.9,
  'signage stays inside the minimum source frontage clearance');
  assert.ok(Number.isInteger(signage.absoluteRoadOverlaps) && signage.absoluteRoadOverlaps >= 0,
    'signage diagnostics report source-level absolute road overlaps');
  assert.equal(signage.additionalRoadIntrusions, 0,
    'signage components add no road intrusion beyond canonical portal planes');
  assert.equal(signage.sourcePortalsUnchanged, true,
    'signage preserves canonical source portal transforms');
  assert.equal(signage.portalPositionsUnchanged, true,
    'signage preserves canonical source portal positions');
  assert.equal(signage.portalHeadingsUnchanged, true,
    'signage preserves canonical source portal headings');
  assert.deepEqual(signage.atlas, {
    kind: 'runtime-canvas-atlas',
    width: 2304,
    height: 64,
    columns: 6,
    rows: 1,
    cells: 6,
    colorSpace: 'srgb',
    sharedTexture: true,
  }, 'signage atlas is the one shared six-cell runtime canvas');
  assert.deepEqual(signage.incremental,
    { drawGroups: 1, triangles: 12, geometries: 1, textures: 1, instances: 6 },
    'signage render cost is exactly one mesh/texture and six signs');
  assert.equal(signage.finite, true, 'signage geometry and metadata are finite');

  assert.equal(runtime.signageMesh.count, 1,
    'scene contains exactly one canonical hero signage mesh');
  assert.equal(runtime.signageMesh.name, 'hero-storefront-signage',
    'hero signage mesh has its canonical runtime name');
  assert.equal(runtime.signageMesh.kind, 'hero-storefront-signage',
    'hero signage mesh exposes its canonical userData kind');
  assert.equal(runtime.signageMesh.signCount, 6,
    'hero signage mesh userData covers exactly six signs');
  assert.equal(runtime.signageMesh.atlasCells, 6,
    'hero signage mesh userData exposes six atlas cells');
  assert.equal(runtime.signageMesh.isMesh, true, 'hero signage presentation uses one Mesh');
  assert.equal(runtime.signageMesh.geometryCount, 1, 'hero signage scene uses one live geometry');
  assert.equal(runtime.signageMesh.indexed, true, 'hero signage geometry is indexed');
  assert.equal(runtime.signageMesh.positionCount, 24,
    'hero signage geometry contains four vertices for each of six signs');
  assert.equal(runtime.signageMesh.uvCount, 24,
    'hero signage geometry exposes one UV per sign vertex');
  assert.equal(runtime.signageMesh.indexCount, 36,
    'hero signage geometry contains six indexed triangles per sign');
  assert.equal(runtime.signageMesh.matrixFinite, true, 'hero signage mesh transform matrix is finite');
  assert.equal(runtime.signageMesh.positionFinite, true, 'hero signage mesh position is finite');
  assert.equal(runtime.signageMesh.uvFinite, true, 'hero signage mesh UVs are finite');
  assert.equal(runtime.signageMesh.uvGroups.length, 6,
    'hero signage mesh contains six atlas UV quads');
  const meshUvCells = [];
  for (const [index, group] of runtime.signageMesh.uvGroups.entries()) {
    assert.equal(group.cells.length, 1,
      `hero signage mesh UV quad ${index} is contained by exactly one atlas cell`);
    assert.ok(group.minV >= -1e-6 && group.maxV <= 1 + 1e-6,
      `hero signage mesh UV quad ${index} stays inside the atlas row`);
    meshUvCells.push(group.cells[0]);
  }
  assert.deepEqual(meshUvCells.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5],
    'hero signage mesh UV quads cover each assigned atlas cell exactly once');
  assert.equal(runtime.signageMesh.mapCanvas, true,
    'hero signage material uses one runtime canvas texture');
  assert.equal(runtime.signageMesh.mapWidth, signage.atlas.width,
    'hero signage texture width matches the atlas contract');
  assert.equal(runtime.signageMesh.mapHeight, signage.atlas.height,
    'hero signage texture height matches the atlas contract');
  assert.equal(runtime.signageMesh.mapColorSpace, 'srgb',
    'hero signage atlas texture uses sRGB color space');

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
  assertRenderDelta(hero, 'hero');

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
  assertRenderDelta(elevated, 'elevated');

  await page.evaluate(() => window.__CITYGEN__.setCameraPose('aerial'));
  await page.waitForTimeout(500);
  const aerial = await sampleRenderer();
  report.render.aerial = aerial;
  assertRenderBudget(aerial, 'aerial', AERIAL_POSE_CAPS);
  assertRenderDelta(aerial, 'aerial');

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
