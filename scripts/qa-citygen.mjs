import { chromium } from 'playwright';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REVISION as threeRevisionString } from 'three';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/citygen.html';
const includeBuiltinSf = process.env.SF_QA_SF_BUILTIN !== '0';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const threeRevision = Number(threeRevisionString);
const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(process.env.SF_QA_ANGLE === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal']),
  ],
  ...(executablePath ? { executablePath } : {}),
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const navigations = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) navigations.push({ url: frame.url(), at: new Date().toISOString() });
});
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
    errors.push(message.text());
  }
});

async function analyzeImage(filePath) {
  const buffer = await readFile(filePath);
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlank = 0;
    let lumaSum = 0;
    let saturationSum = 0;
    let edgeSum = 0;
    let upperEdgeSum = 0;
    let upperSamples = 0;
    let facadeTintPixels = 0;
    let upperWashedOutPixels = 0;
    let darkPixels = 0;
    let blackClippedPixels = 0;
    let highlightClippedPixels = 0;
    let hueBuckets = new Array(12).fill(0);
    let samples = 0;
    const width = canvas.width;
    const height = canvas.height;
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const index = (y * width + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max - min;
        lumaSum += luma;
        saturationSum += saturation;
        if (luma > 8) nonBlank += 1;
        if (luma < 32) darkPixels += 1;
        if (max <= 4) blackClippedPixels += 1;
        if (min >= 250) highlightClippedPixels += 1;
        if (saturation > 18) {
          const hue = Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180 / Math.PI;
          hueBuckets[Math.floor(((hue + 180) / 360) * 12) % 12] += 1;
        }
        if (x + 4 < width && y + 4 < height) {
          const next = ((y + 4) * width + x) * 4;
          const below = (y * width + x + 4) * 4;
          const dx = Math.abs(data[next] - r) + Math.abs(data[next + 1] - g) + Math.abs(data[next + 2] - b);
          const dy = Math.abs(data[below] - r) + Math.abs(data[below + 1] - g) + Math.abs(data[below + 2] - b);
          edgeSum += Math.min(1, (dx + dy) / 140);
          if (y >= 140 && y < height * 0.6) upperEdgeSum += Math.min(1, (dx + dy) / 140);
        }
        if (y >= 140 && y < height * 0.6) {
          upperSamples += 1;
          if (r > g * 1.1 && b > g * 1.1) facadeTintPixels += 1;
          if (luma > 200 && saturation < 28) upperWashedOutPixels += 1;
        }
        samples += 1;
      }
    }
    const saturatedHues = hueBuckets.filter((count) => count > samples * 0.004).length;
    return {
      nonBlankRatio: nonBlank / samples,
      meanLuma: lumaSum / samples,
      meanSaturation: saturationSum / samples,
      edgeDensity: edgeSum / samples,
      saturatedHues,
      upperSceneEdgeDensity: upperSamples ? upperEdgeSum / upperSamples : 0,
      facadeTintRatio: upperSamples ? facadeTintPixels / upperSamples : 0,
      upperWashedOutRatio: upperSamples ? upperWashedOutPixels / upperSamples : 0,
      darkPixelRatio: darkPixels / samples,
      blackClipRatio: blackClippedPixels / samples,
      highlightClipRatio: highlightClippedPixels / samples,
    };
  }, dataUrl);
}

async function auditUiText(stage) {
  return page.evaluate((auditStage) => {
    const selectors = [
      '.brand h1',
      '#city-name',
      '.toolbar button',
      '.tool-label',
      '.city-search input',
      '.readout span',
      '.hint span',
      '#inspector-title',
      '#inspector-empty',
    ];
    const entries = selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
      const text = (element.value || element.placeholder || element.textContent || '').trim();
      const clippedX = visible && text.length > 0 && element.scrollWidth > element.clientWidth + 2;
      const clippedY = visible && text.length > 0 && element.scrollHeight > element.clientHeight + 2;
      const outsideViewport = visible && (
        rect.left < -1
        || rect.top < -1
        || rect.right > window.innerWidth + 1
        || rect.bottom > window.innerHeight + 1
      );
      return {
        selector,
        text,
        clippedX,
        clippedY,
        outsideViewport,
        client: [element.clientWidth, element.clientHeight],
        scroll: [element.scrollWidth, element.scrollHeight],
      };
    }));
    const failures = entries.filter((entry) => entry.clippedX || entry.clippedY || entry.outsideViewport);
    return { stage: auditStage, pass: failures.length === 0, failures, checked: entries.filter((entry) => entry.text).length };
  }, stage);
}

async function auditScene(stage) {
  return page.evaluate((auditStage) => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    const camera = renderer.camera;
    const badObjects = [];
    const geometries = new Set();
    renderer.scene.traverse((object) => {
      const matrix = object.matrixWorld?.elements;
      if (matrix && matrix.some((value) => !Number.isFinite(value))) {
        badObjects.push(object.name || object.type || '(unnamed)');
      }
      if (object.geometry) geometries.add(object.geometry);
    });
    let vertices = 0;
    let nonFiniteVertices = 0;
    for (const geometry of geometries) {
      const position = geometry.attributes?.position;
      if (!position) continue;
      vertices += position.count;
      for (let index = 0; index < position.array.length; index += 1) {
        if (!Number.isFinite(position.array[index])) nonFiniteVertices += 1;
      }
    }
    const closeHits = [];
    let sampledRays = 0;
    for (const y of [0.65, 0.3, -0.05, -0.4]) {
      for (const x of [-0.75, -0.375, 0, 0.375, 0.75]) {
        sampledRays += 1;
        const hit = renderer.pick({ x, y });
        if (hit && hit.distance < 2.5) closeHits.push({ x, y, distance: Number(hit.distance.toFixed(2)) });
      }
    }
    const cameraValues = [
      ...camera.position.toArray(),
      ...camera.quaternion.toArray(),
      camera.fov,
      camera.near,
      camera.far,
    ];
    const renderContext = renderer.renderer.getContext?.();
    const glError = typeof renderContext?.getError === 'function' ? renderContext.getError() : 0;
    return {
      stage: auditStage,
      pass: cameraValues.every(Number.isFinite)
        && camera.near > 0
        && camera.far > camera.near
        && badObjects.length === 0
        && nonFiniteVertices === 0
        && closeHits.length / sampledRays <= 0.2
        && glError === 0,
      camera: {
        position: camera.position.toArray(),
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
      },
      geometry: { objects: geometries.size, vertices, nonFiniteVertices, badObjects },
      closeHits,
      closeHitRatio: closeHits.length / sampledRays,
      glError,
    };
  }, stage);
}

function sfFrameIsBoxed(metrics) {
  return (metrics.upperSceneEdgeDensity || 0) > 0.55
    && (metrics.facadeTintRatio || 0) > 0.3;
}

function sfFrameIsLowVisibility(metrics) {
  return (metrics.nonBlankRatio || 0) < 0.95
    || (metrics.meanLuma || 0) < 45
    || (metrics.upperWashedOutRatio || 0) > 0.48
    || sfFrameIsBoxed(metrics);
}

function sfFrameScore(metrics) {
  const lowVisibilityPenalty = sfFrameIsLowVisibility(metrics) ? 1000 : 0;
  return (metrics.edgeDensity || 0) * 2
    + (metrics.meanSaturation || 0) / 100
    + (metrics.saturatedHues || 0) / 10
    - lowVisibilityPenalty;
}

async function captureSfCandidate(name, pose) {
  await page.evaluate((cameraPose) => window.__CITYGEN__.setCameraPose(cameraPose), pose);
  await page.waitForTimeout(700);
  const candidatePath = `.qa-citygen-sf-${name}.png`;
  await page.screenshot({ path: candidatePath });
  const metrics = await analyzeImage(candidatePath);
  const scene = await auditScene(`sf-${name}`);
  return { name, pose, file: candidatePath, metrics, scene, boxed: sfFrameIsBoxed(metrics), lowVisibility: sfFrameIsLowVisibility(metrics) };
}

let currentStep = 'launch';
const results = {
  capture: {
    builtinSf: includeBuiltinSf,
    threePackageVersion: `0.${threeRevision}.x`,
    threeRevision,
  },
};
try {
  currentStep = 'load CityGen';
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const api = window.__CITYGEN__;
    return typeof api?.getState === 'function'
      && typeof api.getRenderer === 'function'
      && api.getCity()?.buildings?.length > 50;
  }, { timeout: 60000 });
  await page.waitForTimeout(1200);

  currentStep = 'capture initial state';
  results.state = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    return api.getState();
  });
  results.runtime = await page.evaluate(() => {
    const cityRenderer = window.__CITYGEN__.getRenderer();
    const renderer = cityRenderer?.renderer;
    const gl = renderer?.getContext?.();
    const canInspectWebGl = typeof gl?.getParameter === 'function';
    return {
      rendererType: renderer?.constructor?.name || null,
      rendererBackend: cityRenderer?.rendererBackend || null,
      webgpuBackend: renderer?.backend?.isWebGPUBackend === true,
      webglFallbackBackend: renderer?.backend?.isWebGLBackend === true,
      webglVersion: canInspectWebGl ? gl.getParameter(gl.VERSION) : null,
      shadingLanguageVersion: canInspectWebGl ? gl.getParameter(gl.SHADING_LANGUAGE_VERSION) : null,
    };
  });
  results.export = await page.evaluate(() => {
    const payload = JSON.parse(window.__CITYGEN__.exportMetadata());
    return {
      generator: payload.generator,
      counts: payload.counts,
      buildings: payload.buildings.length,
      streets: payload.streets.length,
      blocks: payload.blocks.length,
      segments: payload.segments.length,
      signals: payload.signals.length,
      oneWayStreets: payload.oneWayStreets.length,
      streetSample: payload.streets[0],
      buildingSample: payload.buildings[0],
    };
  });
  results.importRoundtrip = await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    const original = api.getState();
    const payload = JSON.parse(api.exportMetadata());
    const result = await api.importMetadata(payload);
    if (!result.ok) return { ok: false, reason: result.reason };
    const imported = api.getState();
    const ok = imported.buildings === original.buildings
      && imported.streets === original.streets
      && imported.signals === original.signals
      && api.getCity().meta.imported === true;
    await api.generate('sanfrancisco', 731);
    return {
      ok,
      importedGenerator: api.getCity().meta.generator,
      before: { buildings: original.buildings, streets: original.streets, signals: original.signals },
      after: { buildings: imported.buildings, streets: imported.streets, signals: imported.signals },
    };
  });
  results.clockStart = await page.evaluate(() => window.__CITYGEN__.getState().clock);
  await page.waitForTimeout(700);
  results.clockEnd = await page.evaluate(() => window.__CITYGEN__.getState().clock);
  await page.evaluate(() => window.__CITYGEN__.setClock(21.5));
  results.clockNight = await page.evaluate(() => {
    const state = window.__CITYGEN__.getState();
    return { clock: state.clock, day: state.day, timeLabel: document.querySelector('[data-action="time"]').textContent };
  });
  await page.evaluate(() => window.__CITYGEN__.setClock(9));
  await page.evaluate(() => window.__CITYGEN__.setDay(true));
  results.sandboxStartCash = await page.evaluate(() => window.__CITYGEN__.getState().cash);
  results.sandboxPlan = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const city = api.getCity();
    for (const block of city.blocks) {
      if (block.landUse === 'park' || !block.polygon?.length) continue;
      const xs = block.polygon.map((p) => p.x);
      const zs = block.polygon.map((p) => p.z);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      if (api.planPlacement(cx, cz).ok) return { ok: true, x: cx, z: cz };
      for (let dx = -12; dx <= 12; dx += 4) {
        for (let dz = -12; dz <= 12; dz += 4) {
          if (api.planPlacement(cx + dx, cz + dz).ok) return { ok: true, x: cx + dx, z: cz + dz };
        }
      }
    }
    return { ok: false };
  });
  if (results.sandboxPlan.ok) {
    await page.evaluate(({ x, z }) => window.__CITYGEN__.placeBuildingAt(x, z), results.sandboxPlan);
    await page.waitForTimeout(300);
  }
  results.sandboxAfterBuild = await page.evaluate(() => {
    const state = window.__CITYGEN__.getState();
    return { cash: state.cash, buildingsPlaced: state.buildingsPlaced, blocksTouched: state.blocksTouched };
  });
  results.walkPhysics = await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    const renderer = api.getRenderer();
    api.setMode('walk');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const before = renderer.camera.position.toArray();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
    const after = renderer.camera.position.toArray();
    api.setMode('orbit');
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    return { moved: Number(moved.toFixed(2)), before, after };
  });
  results.drivePhysics = await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    if (!api.enterVehicle(true)) return { entered: false };
    await new Promise((resolve) => setTimeout(resolve, 150));
    const car = api.getTraffic().cars.find((entry) => entry.controlled);
    if (!car) return { entered: false };
    const before = car.group.position.toArray();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    await new Promise((resolve) => setTimeout(resolve, 2200));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = car.group.position.toArray();
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    const speed = api.getState().vehicleSpeed;
    api.exitVehicle();
    api.setMode('orbit');
    return { entered: true, moved: Number(moved.toFixed(2)), speed };
  });
  results.pedestrianPhysics = await page.evaluate(async () => {
    const api = window.__CITYGEN__;
    const pedestrians = api.getTraffic()?.pedestrians || [];
    if (!pedestrians.length) return { count: 0 };
    const pedestrian = pedestrians[0];
    const before = pedestrian.group.position.toArray();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const after = pedestrian.group.position.toArray();
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    return { count: pedestrians.length, moved: Number(moved.toFixed(2)) };
  });
  await page.evaluate(() => window.__CITYGEN__.setCameraPose('hero'));
  await page.waitForTimeout(400);

  const placement = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const city = api.getCity();
    for (const block of city.blocks) {
      if (block.landUse === 'park' || !block.polygon?.length) continue;
      const xs = block.polygon.map((p) => p.x);
      const zs = block.polygon.map((p) => p.z);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      if (api.planPlacement(cx, cz).ok) return { ok: true, x: cx, z: cz };
      for (let dx = -12; dx <= 12; dx += 4) {
        for (let dz = -12; dz <= 12; dz += 4) {
          if (api.planPlacement(cx + dx, cz + dz).ok) return { ok: true, x: cx + dx, z: cz + dz };
        }
      }
    }
    return { ok: false };
  });
  results.placementPlan = placement;
  if (placement.ok) {
    const placed = await page.evaluate(({ x, z }) => window.__CITYGEN__.placeBuildingAt(x, z), placement);
    await page.waitForTimeout(900);
    results.placement = {
      placed,
      ...(await page.evaluate(() => {
        const api = window.__CITYGEN__;
        const city = api.getCity();
        const last = [...city.buildings].filter((b) => b.userAdded).at(-1) || null;
        return {
          placedBuildings: api.getState().placedBuildings,
          buildings: api.getState().buildings,
          lastAdded: last ? {
            id: last.id,
            typeLabel: last.typeLabel,
            usage: last.usage,
            blockId: last.blockId,
            district: last.district,
            material: last.material,
            facade: last.facade,
            height: last.height,
            stories: last.stories,
            facingStreet: last.facingStreet,
            address: last.address,
            userAdded: last.userAdded,
          } : null,
        };
      })),
    };
    await page.screenshot({ path: '.qa-citygen-placed.png' });
    results.frames = results.frames || {};
    results.frames['.qa-citygen-placed.png'] = await analyzeImage('.qa-citygen-placed.png');
    await page.evaluate(async () => {
      const api = window.__CITYGEN__;
      while (api.getState().placedBuildings > 0) {
        await api.undoLastAdded();
      }
    });
    await page.waitForTimeout(800);
    results.afterUndo = await page.evaluate(() => {
      const api = window.__CITYGEN__;
      return { placedBuildings: api.getState().placedBuildings, buildings: api.getState().buildings };
    });
    await page.evaluate(() => window.__CITYGEN__.setCameraPose('hero'));
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => {
    const status = document.querySelector('#status-pill');
    if (status) status.hidden = true;
  });
  results.uiText = { procedural: await auditUiText('procedural') };
  results.sceneDiagnostics = { hero: await auditScene('hero') };
  await page.screenshot({ path: '.qa-citygen-hero.png' });

  await page.evaluate(() => window.__CITYGEN__.setCameraPose('street'));
  await page.waitForTimeout(500);
  results.sceneDiagnostics.street = await auditScene('street');
  await page.screenshot({ path: '.qa-citygen-street.png' });

  await page.evaluate(() => window.__CITYGEN__.setCameraPose('aerial'));
  await page.waitForTimeout(500);
  results.sceneDiagnostics.aerial = await auditScene('aerial');
  await page.screenshot({ path: '.qa-citygen-aerial.png' });

  await page.evaluate(() => window.__CITYGEN__.setDay(false));
  await page.evaluate(() => window.__CITYGEN__.setTime(21.5));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__CITYGEN__.setCameraPose('night'));
  await page.waitForTimeout(500);
  results.sceneDiagnostics.night = await auditScene('night');
  await page.screenshot({ path: '.qa-citygen-night.png' });
  await page.evaluate(() => window.__CITYGEN__.setDay(true));
  await page.evaluate(() => window.__CITYGEN__.setTime(15));

  const mainFrames = {};
  for (const file of ['.qa-citygen-hero.png', '.qa-citygen-street.png', '.qa-citygen-aerial.png', '.qa-citygen-night.png']) {
    try {
      mainFrames[path.basename(file)] = await analyzeImage(file);
    } catch (error) {
      mainFrames[path.basename(file)] = { error: error.message };
    }
  }
  results.frames = { ...(results.frames || {}), ...mainFrames };
  if (includeBuiltinSf) {
    await page.click('[data-action="osm"]');
    await page.waitForTimeout(250);
    await page.click('[data-action="sf-builtin"]');
    await page.waitForFunction(
      () => window.__CITYGEN__?.getState?.().generator === 'sf-builtin' && window.__CITYGEN__.getState().buildings >= 500,
      { timeout: 60000 },
    );
    await page.waitForTimeout(900);
    results.sfBuiltin = await page.evaluate(() => {
      const state = window.__CITYGEN__.getState();
      return {
        buildings: state.buildings,
        blocks: state.blocks,
        streets: state.streets,
        signals: state.signals,
        oneWayStreets: state.oneWayStreets,
        furniture: state.furniture,
        signalMeta: state.signalMeta,
        streetMeta: state.streetMeta,
        generator: state.generator,
      };
    });
    results.sfIdentity = await page.evaluate(() => {
      const city = window.__CITYGEN__.getCity();
      const normalize = (value) => String(value || '')
        .toLowerCase()
        .replace(/\bstreet\b/g, 'st')
        .replace(/\bavenue\b/g, 'ave')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      const expectedStreetNames = [
        'Market St', 'Mission St', 'Howard St', 'Folsom St', 'Harrison St', 'Bryant St',
        '3rd St', '4th St', '5th St', '6th St', '7th St', '8th St', '9th St', '10th St',
      ];
      const streetNames = [...new Set(city.streets.map((street) => street.name).filter(Boolean))];
      const normalizedNames = new Set(streetNames.map(normalize));
      const knownStreetMatches = expectedStreetNames.filter((name) => normalizedNames.has(normalize(name)));
      const namedBuildings = city.buildings.filter((building) => String(building.name || '').trim());
      const addressedBuildings = city.buildings.filter((building) => String(building.address || '').trim());
      const landmarkBuildings = city.buildings.filter((building) => building.landmark === true);
      const bearingBuckets = new Set();
      for (const segment of city.segments || []) {
        const start = segment.points?.[0];
        const end = segment.points?.at(-1);
        if (!start || !end) continue;
        const length = Math.hypot(end.x - start.x, end.z - start.z);
        if (length < 20) continue;
        const bearing = (Math.atan2(end.z - start.z, end.x - start.x) * 180 / Math.PI + 180) % 180;
        bearingBuckets.add(Math.floor(bearing / 15));
      }
      return {
        source: city.meta?.generator,
        namedStreetCount: streetNames.length,
        knownStreetMatches,
        namedBuildingCount: namedBuildings.length,
        addressedBuildingCount: addressedBuildings.length,
        landmarkCount: landmarkBuildings.length,
        landmarkSample: landmarkBuildings.slice(0, 8).map((building) => building.name || building.address || building.id),
        bearingBucketCount: bearingBuckets.size,
      };
    });
    results.sfExport = await page.evaluate(() => {
      const payload = JSON.parse(window.__CITYGEN__.exportMetadata());
      return {
        generator: payload.generator,
        buildings: payload.buildings.length,
        streets: payload.streets.length,
        blocks: payload.blocks.length,
        signals: payload.signals.length,
        oneWayStreets: payload.oneWayStreets.length,
        streetSample: payload.streets[0],
        buildingSample: payload.buildings[0],
      };
    });
    const sfPlacementPlan = await page.evaluate(() => {
      const api = window.__CITYGEN__;
      const city = api.getCity();
      for (const block of city.blocks) {
        if (block.landUse === 'park' || !block.polygon?.length) continue;
        const xs = block.polygon.map((p) => p.x);
        const zs = block.polygon.map((p) => p.z);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const candidates = [[cx, cz]];
        for (let dx = -24; dx <= 24; dx += 4) {
          for (let dz = -24; dz <= 24; dz += 4) {
            if (dx === 0 && dz === 0) continue;
            candidates.push([cx + dx, cz + dz]);
          }
        }
        for (const [x, z] of candidates) {
          const plan = api.planPlacement(x, z);
          if (plan.ok) return { ok: true, x, z, blockId: plan.block.id, blockBuildings: plan.block.buildings.length };
        }
      }
      return { ok: false };
    });
    results.sfPlacementPlan = sfPlacementPlan;
    if (sfPlacementPlan.ok) {
      await page.evaluate(({ x, z }) => window.__CITYGEN__.placeBuildingAt(x, z), sfPlacementPlan);
      await page.waitForTimeout(900);
      results.sfPlacement = await page.evaluate(() => {
        const api = window.__CITYGEN__;
        const city = api.getCity();
        const last = [...city.buildings].filter((b) => b.userAdded).at(-1) || null;
        return {
          placedBuildings: api.getState().placedBuildings,
          buildings: api.getState().buildings,
          lastAdded: last ? {
            id: last.id,
            blockId: last.blockId,
            district: last.district,
            typeLabel: last.typeLabel,
            material: last.material,
            facade: last.facade,
            height: last.height,
            address: last.address,
            facingStreet: last.facingStreet,
            userAdded: last.userAdded,
          } : null,
        };
      });
      await page.evaluate(() => window.__CITYGEN__.undoLastAdded());
      await page.waitForTimeout(800);
    results.sfAfterUndo = await page.evaluate(() => {
      const api = window.__CITYGEN__;
      return { placedBuildings: api.getState().placedBuildings, buildings: api.getState().buildings };
    });
  }
  currentStep = 'choose real SF camera';
  await page.evaluate(() => window.__CITYGEN__.setTime(14));
  const sfCandidates = [];
  for (const candidate of [
    { name: 'street', pose: 'sf' },
    { name: 'aerial', pose: 'aerial' },
  ]) {
    sfCandidates.push(await captureSfCandidate(candidate.name, candidate.pose));
  }
  const sfStreet = sfCandidates.find((candidate) => candidate.name === 'street');
  const sfCapture = sfStreet && !sfStreet.lowVisibility && (sfStreet.metrics.edgeDensity || 0) >= 0.25
    ? sfStreet
    : [...sfCandidates].sort((a, b) => sfFrameScore(b.metrics) - sfFrameScore(a.metrics))[0];
  results.sfCapture = {
    selected: sfCapture.name,
    acceptable: !sfCapture.lowVisibility,
    candidates: sfCandidates.map(({ name, file, boxed, lowVisibility, metrics, scene }) => ({ name, file, boxed, lowVisibility, metrics, scene })),
  };
  await page.evaluate(() => window.__CITYGEN__.setTime(14));
  await page.evaluate((cameraPose) => window.__CITYGEN__.setCameraPose(cameraPose), sfCapture.pose);
  await page.waitForTimeout(700);
  await page.screenshot({ path: '.qa-citygen-sf.png' });
  results.frames['.qa-citygen-sf.png'] = await analyzeImage('.qa-citygen-sf.png');
  for (const candidate of sfCandidates) results.frames[candidate.file] = candidate.metrics;
  results.sceneDiagnostics.sfSelected = await auditScene(`sf-selected-${sfCapture.name}`);
  results.uiText.sfBuiltin = await auditUiText('sf-builtin');
  if (includeBuiltinSf) {
    results.sfImportRoundtrip = await page.evaluate(async () => {
      const api = window.__CITYGEN__;
      const before = api.getState().buildings;
      const payload = JSON.parse(api.exportMetadata());
      const result = await api.importMetadata(payload);
      if (!result.ok) return { ok: false, reason: result.reason };
      const after = api.getState().buildings;
      return {
        ok: after === before && api.getCity().meta.imported === true,
        generator: api.getCity().meta.generator,
        buildings: after,
      };
    });
  }
  }
  results.errors = errors;
  await writeFile('.qa-citygen-results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'qa-citygen failed', step: currentStep, error: error.message, errors, navigations }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
