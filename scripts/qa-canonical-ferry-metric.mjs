import { access, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const FERRY_TILE_ID = 'epsg26910-1441-10893';
const EXPECTED_MANIFEST_TILE_COUNT = 803;
const url = process.env.SF_QA_URL || 'http://127.0.0.1:5173/';
const output = process.env.SF_QA_OUTPUT || '.qa-canonical-ferry-metric.json';
const screenshots = {
  dayAerial: process.env.SF_QA_DAY_SCREENSHOT || '.qa-canonical-ferry-metric-day-aerial.png',
  duskAerial: process.env.SF_QA_DUSK_SCREENSHOT || '.qa-canonical-ferry-metric-dusk-aerial.png',
};
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const report = {
  result: 'failed',
  url,
  expectedScope: {
    tileId: FERRY_TILE_ID,
    residentTileCount: 1,
    manifestTileCount: EXPECTED_MANIFEST_TILE_COUNT,
  },
  screenshots,
};

function closeEnough(left, right, epsilon = 1e-6) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= epsilon;
}

function samePose(left, right) {
  if (!left || !right) return false;
  return ['position', 'quaternion', 'target'].every((key) => (
    left[key].length === right[key].length
      && left[key].every((value, index) => closeEnough(value, right[key][index]))
  )) && closeEnough(left.fov, right.fov);
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const api = window.__CITYGEN__;
    const state = api?.getState?.();
    return typeof api?.loadMetricSf === 'function'
      && state?.generator === 'sf-builtin'
      && state?.busy === false;
  }, null, { timeout: 90000 });

  report.canonicalPath = new URL(page.url()).pathname;
  report.beforeSwitch = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const cityRenderer = api.getRenderer();
    const renderer = cityRenderer.renderer;
    window.__CANONICAL_FERRY_QA__ = {
      scene: cityRenderer.scene,
      renderer,
      canvas: renderer.domElement,
      loop: renderer._animation?._animationLoop || null,
      root: cityRenderer.root,
    };
    return {
      generator: api.getState().generator,
      rendererType: renderer.constructor.name,
      rendererBackend: cityRenderer.rendererBackend,
      sceneRootName: cityRenderer.root?.name || null,
      canvasId: renderer.domElement?.id || null,
      canvasCount: document.querySelectorAll('canvas').length,
      sceneCanvasCount: document.querySelectorAll('#scene-canvas').length,
      animationLoopInstalled: typeof renderer._animation?._animationLoop === 'function',
      animationRequestActive: renderer._animation?._requestId != null,
    };
  });

  const loadResult = await page.evaluate(() => window.__CITYGEN__.loadMetricSf());
  report.loadAccepted = Boolean(loadResult);
  await page.waitForFunction((tileId) => {
    const state = window.__CITYGEN__?.getState?.();
    return state?.busy === false
      && state?.generator === 'sf-metric-tiles'
      && state?.metricMap?.verifiedTiles === 1
      && state.metricMap.tileIds?.length === 1
      && state.metricMap.tileIds[0] === tileId;
  }, FERRY_TILE_ID, { timeout: 120000 });

  await page.addStyleTag({
    content: `
      #app > :not(#scene-canvas) { display: none !important; }
      #scene-canvas { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; }
      html, body, #app { margin: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }
    `,
  });

  const capture = async (hour, path) => {
    await page.evaluate((nextHour) => {
      window.__CITYGEN__.setCameraPose('aerial');
      window.__CITYGEN__.setTime(nextHour);
    }, hour);
    await page.waitForTimeout(900);
    const evidence = await page.evaluate((requestedHour) => {
      const api = window.__CITYGEN__;
      const cityRenderer = api.getRenderer();
      const renderer = cityRenderer.renderer;
      const { camera, controls } = cityRenderer;
      return {
        requestedHour,
        clockAtCapture: api.getState().clock,
        camera: {
          position: camera.position.toArray(),
          quaternion: camera.quaternion.toArray(),
          target: controls.target.toArray(),
          fov: camera.fov,
        },
        rendererCounters: {
          drawCalls: renderer.info?.render?.drawCalls ?? renderer.info?.render?.calls ?? null,
          triangles: renderer.info?.render?.triangles ?? null,
          geometries: renderer.info?.memory?.geometries ?? null,
          textures: renderer.info?.memory?.textures ?? null,
        },
      };
    }, hour);
    await page.screenshot({ path });
    return evidence;
  };

  report.evidence = {
    dayAerial: await capture(14, screenshots.dayAerial),
    duskAerial: await capture(19.25, screenshots.duskAerial),
  };
  report.evidence.matchedCamera = samePose(
    report.evidence.dayAerial.camera,
    report.evidence.duskAerial.camera,
  );

  await page.waitForTimeout(250);
  report.runtime = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const state = api.getState();
    const metric = api.getMetricMap();
    const cityRenderer = api.getRenderer();
    const renderer = cityRenderer.renderer;
    const root = cityRenderer.root;
    const prior = window.__CANONICAL_FERRY_QA__;
    const geometryIds = new Set();
    const nonFiniteSamples = [];
    let nonFiniteValueCount = 0;
    let meshes = 0;
    let vertices = 0;
    let triangles = 0;

    const inspectArray = (array, label) => {
      if (!array || typeof array.length !== 'number') return;
      for (let index = 0; index < array.length; index += 1) {
        if (Number.isFinite(array[index])) continue;
        nonFiniteValueCount += 1;
        if (nonFiniteSamples.length < 20) nonFiniteSamples.push({ label, index, value: String(array[index]) });
      }
    };

    root?.traverse((node) => {
      const geometry = node.geometry;
      if (!geometry) return;
      if (node.isMesh) meshes += 1;
      if (!geometryIds.has(geometry.uuid)) {
        geometryIds.add(geometry.uuid);
        for (const [name, attribute] of Object.entries(geometry.attributes || {})) {
          inspectArray(attribute.array || attribute.data?.array, `${node.name || node.type}.${name}`);
        }
        for (const [name, attributes] of Object.entries(geometry.morphAttributes || {})) {
          attributes.forEach((attribute, index) => {
            inspectArray(attribute.array || attribute.data?.array, `${node.name || node.type}.morph.${name}.${index}`);
          });
        }
        inspectArray(geometry.index?.array, `${node.name || node.type}.index`);
      }
      const positionCount = geometry.getAttribute?.('position')?.count || 0;
      const indexCount = geometry.index?.count || 0;
      const instanceCount = node.isInstancedMesh ? node.count : 1;
      vertices += positionCount * instanceCount;
      if (node.isMesh) triangles += (indexCount || positionCount) / 3 * instanceCount;
    });

    const activeRootOccurrences = cityRenderer.scene.children.filter((child) => child === root).length;
    const namedWorldRoots = cityRenderer.scene.children.filter((child) => (
      child.name === 'city-root' || child.name === 'authoritative-sf-metric-root'
    ));
    return {
      generator: state.generator,
      metric: {
        anchorOriginEpsg26910: metric?.anchorOriginEpsg26910 || null,
        manifestTileCount: metric?.manifestTileCount ?? null,
        tileIds: metric?.tileIds || [],
        records: metric?.records || [],
      },
      scene: {
        rootName: root?.name || null,
        rootChildCount: root?.children?.length ?? null,
        rootChildNames: root?.children?.map((child) => child.name) || [],
        activeRootOccurrences,
        namedWorldRootCount: namedWorldRoots.length,
        rootInstalledInScene: root?.parent === cityRenderer.scene,
        priorRootReplaced: prior.root !== root,
        sceneIdentityPreserved: prior.scene === cityRenderer.scene,
      },
      renderer: {
        type: renderer.constructor.name,
        backend: cityRenderer.rendererBackend,
        identityPreserved: prior.renderer === renderer,
        drawCalls: renderer.info?.render?.drawCalls ?? renderer.info?.render?.calls ?? null,
        triangles: renderer.info?.render?.triangles ?? null,
        geometries: renderer.info?.memory?.geometries ?? null,
        textures: renderer.info?.memory?.textures ?? null,
      },
      canvas: {
        id: renderer.domElement?.id || null,
        identityPreserved: prior.canvas === renderer.domElement,
        canonicalIdentity: renderer.domElement === document.querySelector('#scene-canvas'),
        sceneCanvasCount: document.querySelectorAll('#scene-canvas').length,
        totalCanvasCount: document.querySelectorAll('canvas').length,
      },
      animationLoop: {
        installed: typeof renderer._animation?._animationLoop === 'function',
        identityPreserved: prior.loop === renderer._animation?._animationLoop,
        requestActive: renderer._animation?._requestId != null,
      },
      geometry: {
        meshes,
        uniqueGeometries: geometryIds.size,
        vertices,
        triangles,
        nonFiniteValueCount,
        nonFiniteSamples,
        tileScaleOne: root?.children?.every((tile) => (
          tile.scale.x === 1 && tile.scale.y === 1 && tile.scale.z === 1
        )) ?? false,
      },
      stateErrors: Array.isArray(state.errors) ? [...state.errors] : state.errors,
    };
  });

  const { runtime } = report;
  const records = runtime.metric.records;
  const counters = [
    runtime.renderer.drawCalls,
    runtime.renderer.triangles,
    runtime.renderer.geometries,
    runtime.renderer.textures,
  ];
  report.checks = {
    canonicalRootUrl: report.canonicalPath === '/',
    loaderAcceptedCandidate: report.loadAccepted,
    exactResidentScope: runtime.metric.tileIds.length === 1
      && runtime.metric.tileIds[0] === FERRY_TILE_ID,
    exactManifestScope: runtime.metric.manifestTileCount === EXPECTED_MANIFEST_TILE_COUNT,
    exactIntegrityRecord: records.length === 1
      && records[0].id === FERRY_TILE_ID
      && /^sha256:[a-f0-9]{64}$/.test(records[0].glbSha256)
      && /^sha256:[a-f0-9]{64}$/.test(records[0].receiptSha256)
      && records[0].presentationMode === 'source-tone-v1'
      && records[0].authorization === 'production-authorized-bounded-ferry-mixed-mode'
      && records[0].originSubtractions === 1
      && records[0].sceneScale === 1,
    metricGeneratorActive: runtime.generator === 'sf-metric-tiles',
    exactMetricRoot: runtime.scene.rootName === 'authoritative-sf-metric-root'
      && runtime.scene.rootChildCount === 1
      && runtime.scene.rootChildNames[0] === `${FERRY_TILE_ID} authoritative metric tile`
      && runtime.scene.activeRootOccurrences === 1
      && runtime.scene.namedWorldRootCount === 1
      && runtime.scene.rootInstalledInScene,
    sourceSwitchReplacedOnlyWorldRoot: runtime.scene.priorRootReplaced
      && runtime.scene.sceneIdentityPreserved,
    canonicalWebGpuRenderer: runtime.renderer.type === 'WebGPURenderer'
      && runtime.renderer.backend === 'webgpu'
      && runtime.renderer.identityPreserved,
    canonicalCanvas: runtime.canvas.id === 'scene-canvas'
      && runtime.canvas.identityPreserved
      && runtime.canvas.canonicalIdentity
      && runtime.canvas.sceneCanvasCount === 1,
    onePreservedAnimationLoop: runtime.animationLoop.installed
      && runtime.animationLoop.identityPreserved,
    finiteRendererCounters: counters.every((value) => Number.isFinite(value) && value >= 0),
    finiteNonemptyGeometry: runtime.geometry.meshes > 0
      && runtime.geometry.uniqueGeometries > 0
      && runtime.geometry.vertices > 0
      && runtime.geometry.triangles > 0
      && runtime.geometry.nonFiniteValueCount === 0,
    metreScalePreserved: runtime.geometry.tileScaleOne,
    matchedAerialEvidence: report.evidence.matchedCamera,
    noStateErrors: Array.isArray(runtime.stateErrors) && runtime.stateErrors.length === 0,
    noPageErrors: pageErrors.length === 0,
    noConsoleErrors: consoleErrors.length === 0,
  };
  report.pageErrors = pageErrors;
  report.consoleErrors = consoleErrors;
  report.failures = Object.entries(report.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  report.result = report.failures.length === 0 ? 'passed' : 'failed';
} catch (error) {
  report.fatalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  report.pageErrors = pageErrors;
  report.consoleErrors = consoleErrors;
  report.failures = ['fatalError'];
} finally {
  await browser.close();
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'passed') process.exitCode = 1;
}
