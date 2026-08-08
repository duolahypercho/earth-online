import { chromium } from 'playwright';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/citygen.html';
const includeBuiltinSf = process.env.SF_QA_SF_BUILTIN !== '0';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const threePackage = JSON.parse(await readFile(new URL('../node_modules/three/package.json', import.meta.url), 'utf8'));
const threeRevision = Number(threePackage.version.split('.')[1]);
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
    };
  }, dataUrl);
}

function sfFrameIsBoxed(metrics) {
  return (metrics.upperSceneEdgeDensity || 0) > 0.55
    && (metrics.facadeTintRatio || 0) > 0.3;
}

function sfFrameIsLowVisibility(metrics) {
  return (metrics.nonBlankRatio || 0) < 0.95
    || (metrics.meanLuma || 0) < 45
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
  const candidatePath = path.join('/tmp', `citygen-${process.pid}-${name}.png`);
  await page.screenshot({ path: candidatePath });
  try {
    const metrics = await analyzeImage(candidatePath);
    return { name, pose, metrics, boxed: sfFrameIsBoxed(metrics), lowVisibility: sfFrameIsLowVisibility(metrics) };
  } finally {
    await unlink(candidatePath).catch(() => {});
  }
}

let currentStep = 'launch';
const results = {
  capture: {
    builtinSf: includeBuiltinSf,
    threePackageVersion: threePackage.version,
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
    const renderer = window.__CITYGEN__.getRenderer()?.renderer;
    const gl = renderer?.getContext?.();
    return {
      rendererType: renderer?.constructor?.name || null,
      webglVersion: gl?.getParameter(gl.VERSION) || null,
      shadingLanguageVersion: gl?.getParameter(gl.SHADING_LANGUAGE_VERSION) || null,
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
    await new Promise((resolve) => setTimeout(resolve, 450));
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
  await page.screenshot({ path: '.qa-citygen-hero.png' });

  await page.evaluate(() => window.__CITYGEN__.setCameraPose('street'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.qa-citygen-street.png' });

  await page.evaluate(() => window.__CITYGEN__.setCameraPose('aerial'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.qa-citygen-aerial.png' });

  await page.evaluate(() => window.__CITYGEN__.setDay(false));
  await page.evaluate(() => window.__CITYGEN__.setTime(21.5));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__CITYGEN__.setCameraPose('night'));
  await page.waitForTimeout(500);
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
  const sfCandidates = [];
  for (const candidate of [
    { name: 'street', pose: 'sf' },
    { name: 'aerial', pose: 'aerial' },
  ]) {
    sfCandidates.push(await captureSfCandidate(candidate.name, candidate.pose));
  }
  const sfCapture = [...sfCandidates].sort((a, b) => sfFrameScore(b.metrics) - sfFrameScore(a.metrics))[0];
  results.sfCapture = {
    selected: sfCapture.name,
    acceptable: !sfCapture.lowVisibility,
    candidates: sfCandidates.map(({ name, boxed, lowVisibility, metrics }) => ({ name, boxed, lowVisibility, metrics })),
  };
  await page.evaluate((cameraPose) => window.__CITYGEN__.setCameraPose(cameraPose), sfCapture.pose);
  await page.waitForTimeout(700);
  await page.screenshot({ path: '.qa-citygen-sf.png' });
  results.frames['.qa-citygen-sf.png'] = await analyzeImage('.qa-citygen-sf.png');
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
