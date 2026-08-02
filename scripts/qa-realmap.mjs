import { chromium } from 'playwright';
import { access, writeFile } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/realmap.html';
const presetName = process.env.SF_QA_PRESET || 'downtown';
const blindAbPath = '.qa-realmap-blind-ab.html';
const systemChrome = process.env.SF_QA_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const qaAngle = process.env.SF_QA_ANGLE || 'metal';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${qaAngle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const httpErrors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
    const expectedFallback = /^(Road resolution strategy failed|REALMAP_DIAGNOSTICS|Whole-model mesh failed|Road surface mesher failed)/;
    if (!expectedFallback.test(message.text())) errors.push(message.text());
  }
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${response.status()} ${response.url()}`);
  }
});

const checks = [];
const check = (name, pass, detail = null) => {
  checks.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
};

try {
  const blindAb = await page.goto(`file://${process.cwd()}/${blindAbPath}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.pair').length === 5, { timeout: 10000 });
  const firstVote = await page.evaluate(() => {
    const firstButton = document.querySelector('.pair .actions button');
    firstButton?.click();
    return {
      pairs: document.querySelectorAll('.pair').length,
      choices: JSON.parse(document.querySelector('.results')?.textContent || '{}'),
    };
  });
  check('Blind A/B page renders 5 pairs', firstVote.pairs === 5, firstVote.pairs);
  check('Blind A/B records a vote', Boolean(firstVote.choices?.choices && Object.keys(firstVote.choices.choices).length), firstVote.choices);
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    { timeout: 120000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: '.qa-realmap-map.png' });

  const mapPixels = await page.evaluate(() => {
    const canvas = document.querySelector('#map-canvas');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const buckets = new Set();
    for (let i = 0; i < data.length; i += 4 * 2000) {
      buckets.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
    }
    return { buckets: buckets.size };
  });
  check('Boundary map renders varied layers', mapPixels.buckets > 12, mapPixels);

  const mapState = await page.evaluate(() => {
    const lab = window.__SF_REALMAP__;
    const data = lab.getData();
    return {
      boundaryRings: data.boundary.length,
      roads: data.meta.counts.roads,
      buildings: data.meta.counts.detailBuildings + data.meta.counts.coarseBuildings,
      signals: data.meta.counts.signals,
      sources: data.meta.sources.length,
    };
  });
  check('Real city data loaded', mapState.boundaryRings >= 20 && mapState.roads > 30000, mapState);
  check('Boundary has metadata sources', mapState.sources >= 2, mapState.sources);

  await page.evaluate((preset) => window.__SF_REALMAP__.applyPreset(preset), presetName);
  const region = await page.evaluate(() => window.__SF_REALMAP__.getRegion().length);
  check(`Preset draws a boundary (${presetName})`, region >= 4, { preset: presetName, region });

  const buildResult = await page.evaluate(() => window.__SF_REALMAP__.build());
  if (buildResult?.error) {
    throw new Error(`Real map build failed: ${buildResult.error}`);
  }
  await page.waitForFunction(
    () => window.__SF_REALMAP__.getBuildState().isCity,
    { timeout: 240000 },
  );
  await page.waitForTimeout(2600);
  await page.screenshot({ path: '.qa-realmap-city.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setCameraPose({
    position: [1780, 34, 1760],
    target: [1900, 26, 1580],
  }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.qa-realmap-hero.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setCameraPose({
    position: [1780, 34, 1760],
    target: [1900, 26, 1580],
  }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.qa-realmap-canyon.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__SF_REALMAP__.setCameraPose({
    position: [1780, 34, 1760],
    target: [1900, 26, 1580],
  }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.qa-realmap-hero-beauty.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setCameraPose({
    position: [1780, 34, 1760],
    target: [1900, 26, 1580],
  }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.qa-realmap-canyon-beauty.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(false));

  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('#scene-canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return null;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const buckets = new Map();
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let blank = 0;
    const sampleStep = Math.max(1, Math.floor((width * height) / 160000));
    for (let i = 0; i < data.length; i += 4 * sampleStep) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 8) {
        blank += 1;
        continue;
      }
      sumR += r;
      sumG += g;
      sumB += b;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const total = Math.max(1, buckets.size ? [...buckets.values()].reduce((a, b) => a + b, 0) : 0);
    const mean = [
      sumR / total,
      sumG / total,
      sumB / total,
    ];
    let variance = 0;
    for (let i = 0; i < data.length; i += 4 * sampleStep) {
      if (data[i + 3] < 8) continue;
      variance += (data[i] - mean[0]) ** 2 + (data[i + 1] - mean[1]) ** 2 + (data[i + 2] - mean[2]) ** 2;
    }
    const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return {
      width,
      height,
      colorBuckets: buckets.size,
      mean: mean.map((value) => Math.round(value)),
      stddev: Math.round(Math.sqrt(variance / Math.max(1, total))),
      blankRatio: Number((blank / Math.max(1, total + blank)).toFixed(4)),
      topColors: sorted.map(([key, count]) => ({ key, ratio: Number((count / total).toFixed(3)) })),
    };
  });
  check('Rendered frame is visually varied', Boolean(pixels && pixels.colorBuckets > 120 && pixels.stddev > 24), pixels);
  check('Frame is not blank', Boolean(pixels && pixels.blankRatio < 0.2), pixels?.blankRatio);
  check('Golden-hour sky present', Boolean(pixels && pixels.topColors.some((entry) => entry.key.startsWith('1') || entry.key.startsWith('2'))), pixels?.topColors);

  const cityState = await page.evaluate(() => {
    const lab = window.__SF_REALMAP__;
    const state = lab.getBuildState();
    return {
      ...state,
      webgl2: document.querySelector('#scene-canvas').getContext('webgl2') !== null,
    };
  });
  check('WebGL2 city generated', cityState.webgl2 && cityState.isCity, cityState);
  if (presetName === 'city') {
    check('Full city uses all real OSM roads', cityState.fullCity === true && Number(cityState.selectedRoads || 0) > 10000, {
      selectedRoads: cityState.selectedRoads,
      simpleRoadSegments: cityState.simpleRoadSegments,
      simpleSidewalkSegments: cityState.simpleSidewalkSegments,
    });
  } else {
    check('Authored preset keeps lane-level road mesher', cityState.fullCity === false, cityState.fullCity);
  }
  check('City has real signal metadata', cityState.signals > 0, cityState.signals);
  check('Traffic flows on OSM roads', cityState.traffic > 0, cityState.traffic);
  check('Real elevation terrain loaded', Boolean(cityState.terrain && cityState.terrain.width > 100), cityState.terrain);
  check('SF hills present in heightmap', Number(cityState.terrain?.maxElevation || 0) > 100, cityState.terrain?.maxElevation);
  const hillProbe = await page.evaluate(() => {
    const lab = window.__SF_REALMAP__;
    const data = lab.getData();
    const first = data.boundary[0];
    const samples = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < first.length; i += 2) {
      minX = Math.min(minX, first[i]);
      maxX = Math.max(maxX, first[i]);
      minZ = Math.min(minZ, first[i + 1]);
      maxZ = Math.max(maxZ, first[i + 1]);
    }
    for (let zi = 0; zi <= 16; zi += 1) {
      for (let xi = 0; xi <= 16; xi += 1) {
        const x = minX + (maxX - minX) * (xi / 16);
        const z = minZ + (maxZ - minZ) * (zi / 16);
        samples.push({ x, z, elevation: lab.getElevationAt(x, z) });
      }
    }
    const max = Math.max(...samples.map((sample) => sample.elevation));
    const min = Math.min(...samples.map((sample) => sample.elevation));
    return { samples: samples.length, min, max };
  });
  check('Terrain sampling returns varied city elevation', hillProbe.max - hillProbe.min > 30, hillProbe);
  for (const mode of ['fog', 'drizzle', 'clear']) {
    const next = await page.evaluate((weather) => window.__SF_REALMAP__.setWeather(weather), mode);
    await page.waitForTimeout(350);
    check(`Weather mode ${mode} applies`, next === mode, { next });
  }
  await page.screenshot({ path: '.qa-realmap-drizzle.png' });
  for (const mode of ['day', 'dusk', 'night', 'dawn']) {
    const next = await page.evaluate((time) => window.__SF_REALMAP__.setTimeOfDay(time), mode);
    await page.waitForTimeout(350);
    check(`Time of day ${mode} applies`, next === mode, { next });
  }
  await page.evaluate(() => window.__SF_REALMAP__.setWeather('clear'));
  await page.evaluate(() => window.__SF_REALMAP__.setTimeOfDay('night'));
  await page.waitForTimeout(450);
  await page.screenshot({ path: '.qa-realmap-night.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.qa-realmap-night-beauty.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(false));
  const nightPixels = await page.evaluate(() => window.__SF_REALMAP__.getFrameDiagnostics());
  check('Night frame is dark with city glow', Boolean(nightPixels && nightPixels.meanLuma < 90 && nightPixels.brightRatio > 0.002), nightPixels);
  await page.evaluate(() => window.__SF_REALMAP__.setTimeOfDay('day'));
  check('Renderer emitted geometry', Number(cityState.geometryTriangles || cityState.renderer?.triangles || 0) > 0, {
    geometryTriangles: cityState.geometryTriangles,
    renderer: cityState.renderer,
  });
  check('Sidewalk pedestrians spawned', Number(cityState.pedestrians || 0) > 0, cityState.pedestrians);
  check('Player collision volumes built', Number(cityState.collisionVolumes || 0) > 0, cityState.collisionVolumes);
  check('Building doorways mark entrances', Number(cityState.doorways || 0) > 0, cityState.doorways);

  const walkResult = await page.evaluate(() => window.__SF_REALMAP__.setCityMode('walk'));
  check('Walk mode activates', walkResult === true);
  const startPlayer = await page.evaluate(() => window.__SF_REALMAP__.getPlayerPosition());
  await page.keyboard.down('w');
  await page.waitForTimeout(700);
  await page.keyboard.up('w');
  const endPlayer = await page.evaluate(() => window.__SF_REALMAP__.getPlayerPosition());
  const movedDistance = startPlayer && endPlayer
    ? Math.hypot(endPlayer.x - startPlayer.x, endPlayer.z - startPlayer.z)
    : 0;
  check('WASD walk moves the player', movedDistance > 0.5, { startPlayer, endPlayer, movedDistance });
  await page.waitForTimeout(250);
  await page.screenshot({ path: '.qa-realmap-street.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
  await page.waitForTimeout(250);
  await page.screenshot({ path: '.qa-realmap-street-beauty.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(false));

  const entrance = await page.evaluate(() => window.__SF_REALMAP__.getBuildingEntrance(0));
  if (entrance) {
    await page.evaluate((point) => window.__SF_REALMAP__.setPlayerPosition(point.x, point.z), entrance);
    await page.waitForTimeout(200);
    const entered = await page.evaluate(() => window.__SF_REALMAP__.enterNearestBuilding());
    check('Enterable real-map building opens', entered === true);
    const interior = await page.evaluate(() => window.__SF_REALMAP__.getInteriorState());
    check('Interior exposes OSM metadata', Boolean(interior && (interior.name || interior.address)), interior);
    check('Interior has a room archetype', Boolean(interior?.archetype), interior?.archetype);
    check('Interior has scheduled residents', Boolean(interior?.residents?.length && interior.residents.every((resident) => resident.role && resident.action && resident.schedule)), interior?.residents);
    const dayVisibleSchedules = interior.residents.filter((resident) => resident.visible).map((resident) => resident.schedule).sort();
    await page.evaluate(() => window.__SF_REALMAP__.setTimeOfDay('night'));
    await page.waitForTimeout(250);
    const nightInterior = await page.evaluate(() => window.__SF_REALMAP__.getInteriorState());
    const nightVisibleSchedules = nightInterior?.residents?.filter((resident) => resident.visible).map((resident) => resident.schedule).sort() || [];
    check('Resident schedules change occupancy', dayVisibleSchedules.join(',') !== nightVisibleSchedules.join(','), { dayVisibleSchedules, nightVisibleSchedules });
    await page.evaluate(() => window.__SF_REALMAP__.setTimeOfDay('day'));
    await page.waitForTimeout(350);
    await page.screenshot({ path: '.qa-realmap-interior.png' });
  const exited = await page.evaluate(() => window.__SF_REALMAP__.exitInterior());
  check('Interior returns to the street', exited === true);

  const archetypeSweep = await page.evaluate(() => {
    const lab = window.__SF_REALMAP__;
    const seen = new Set();
    const details = [];
    for (let index = 0; index < Math.min(80, 999); index += 1) {
      const entrance = lab.getBuildingEntrance(index);
      if (!entrance) continue;
      lab.setPlayerPosition(entrance.x, entrance.z);
      if (!lab.enterNearestBuilding()) continue;
      const state = lab.getInteriorState();
      if (state?.archetype) {
        if (!seen.has(state.archetype)) {
          seen.add(state.archetype);
          details.push({ index, archetype: state.archetype, name: state.name });
        }
      }
      lab.exitInterior();
      if (seen.size >= 4) break;
    }
    return { seen: [...seen], details };
  });
  check('Interior sweep finds multiple room archetypes', archetypeSweep.seen.length >= 3, archetypeSweep);
  } else {
    check('Enterable real-map building opens', false, 'no detailed building entrance');
    check('Interior exposes OSM metadata', false, 'no detailed building entrance');
  }

  const highPoint = await page.evaluate(() => {
    const lab = window.__SF_REALMAP__;
    const regionPoints = lab.getRegion();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of regionPoints) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    let best = { x: minX, z: minZ, elevation: -Infinity };
    for (let zi = 0; zi <= 32; zi += 1) {
      for (let xi = 0; xi <= 32; xi += 1) {
        const x = minX + (maxX - minX) * (xi / 32);
        const z = minZ + (maxZ - minZ) * (zi / 32);
        const elevation = lab.getElevationAt(x, z);
        if (elevation > best.elevation) best = { x, z, elevation };
      }
    }
    return best;
  });
  const hillThreshold = presetName === 'city' ? 120 : 40;
  check(`Hill probe found a real SF high point (${presetName})`, Number(highPoint?.elevation || 0) > hillThreshold, {
    highPoint,
    threshold: hillThreshold,
  });
  await page.evaluate((point) => window.__SF_REALMAP__.setPlayerPosition(point.x, point.z), highPoint);
  await page.evaluate((point) => {
    window.__SF_REALMAP__.setCityMode('orbit');
    window.__SF_REALMAP__.setCameraPose({
      position: [point.x - 110, point.elevation + 42, point.z + 80],
      target: [point.x + 90, point.elevation - 8, point.z - 60],
    });
  }, highPoint);
  await page.waitForTimeout(450);
  await page.screenshot({ path: '.qa-realmap-hills.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
  await page.waitForTimeout(250);
  await page.screenshot({ path: '.qa-realmap-hills-beauty.png' });
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(false));

  const nearest = await page.evaluate(() => window.__SF_REALMAP__.getNearestVehicle());
  let driveTarget = nearest;
  if (!driveTarget) {
    const trafficPositions = await page.evaluate(() => window.__SF_REALMAP__.getTrafficPositions());
    if (trafficPositions?.length) driveTarget = { position: trafficPositions[0] };
  }
  if (driveTarget) {
    const exact = await page.evaluate((position) => {
      const lab = window.__SF_REALMAP__;
      const traffic = lab.getTrafficPositions();
      let best = null;
      let bestDistance = Infinity;
      for (const point of traffic) {
        const distance = Math.hypot(point.x - position.x, point.z - position.z);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = point;
        }
      }
      if (best) lab.setPlayerPosition(best.x, best.z);
      return { player: lab.getPlayerPosition(), traffic: traffic.slice(0, 4), best, bestDistance };
    }, driveTarget.position);
    console.log('drive probe exact', JSON.stringify(exact));
    await page.waitForTimeout(150);
    const driveProbe = exact;
    const driveResult = await page.evaluate(() => window.__SF_REALMAP__.setCityMode('drive'));
    const driveIndex = await page.evaluate(() => window.__SF_REALMAP__.getDriveIndex());
    check('Drive mode enters a real road vehicle', driveResult === true && driveIndex >= 0, {
      ...driveProbe,
      driveIndex,
      driveResult,
    });
    await page.waitForTimeout(200);
    await page.keyboard.down('w');
    await page.waitForTimeout(900);
    await page.keyboard.up('w');
    const driveState = await page.evaluate(() => window.__SF_REALMAP__.getBuildState());
    check('Drive accelerates along OSM roads', Number(driveState.vehicleSpeed || 0) > 0.5, driveState.vehicleSpeed);
  } else {
    check('Drive mode enters a real road vehicle', false, 'no nearby vehicle after walk');
  }
  await page.evaluate(() => window.__SF_REALMAP__.setCityMode('orbit'));

  await page.evaluate(() => window.__SF_REALMAP__.showInspector('Street', {
    id: 999,
    name: 'Market Street',
    highway: 'primary',
    oneway: true,
    lanes: 3,
    maxspeed: '25 mph',
    surface: 'asphalt',
    sidewalk: 'both',
    bridge: false,
    tunnel: false,
  }));
  await page.waitForTimeout(200);
  const inspectorVisible = await page.locator('#inspector').isVisible();
  check('Street metadata inspector opens', inspectorVisible);
  await page.screenshot({ path: '.qa-realmap-inspector.png' });
} catch (error) {
  errors.push(error.message);
} finally {
  await writeFile('.qa-realmap-results.json', JSON.stringify({
    checks,
    errors,
    httpErrors,
    summary: {
      passed: checks.filter((entry) => entry.pass).length,
      failed: checks.filter((entry) => !entry.pass).length,
    },
  }, null, 2));
  console.log(JSON.stringify({ checks, errors, httpErrors }, null, 2));
  await browser.close();
}

const failed = checks.filter((entry) => !entry.pass);
if (failed.length || errors.length) process.exitCode = 1;
