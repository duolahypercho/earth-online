import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.SF_QA_URL || 'http://127.0.0.1:5174';
const outputDir = process.env.SF_WARDROBE_QA_DIR || '.qa-hero-life-wardrobe-i30';
const url = `${baseUrl}/realmap.html?place=ferry-building&mode=walk`;
const viewport = { width: 1440, height: 810 };
const deviceScaleFactor = 2;
const pose = { x: 2173, z: 1831.4, yaw: 0.8008 };
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [];

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function imageData(page, path) {
  const bytes = await readFile(path);
  return page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  }, `data:image/png;base64,${bytes.toString('base64')}`);
}

function bodyCropFromNdc(rect, width, height) {
  const ndcWidth = rect.right - rect.left;
  const ndcHeight = rect.top - rect.bottom;
  // The staging gate supplies a conservative adult rectangle. Restrict the
  // metric to the jacket/torso band so pavement and sky cannot inflate a
  // wardrobe readability claim. This is identical for day and night.
  return {
    x0: Math.max(0, Math.floor((rect.left + ndcWidth * 0.25 + 1) * width / 2)),
    x1: Math.min(width, Math.ceil((rect.left + ndcWidth * 0.75 + 1) * width / 2)),
    y0: Math.max(0, Math.floor((1 - (rect.top - ndcHeight * 0.35)) * height / 2)),
    y1: Math.min(height, Math.ceil((1 - (rect.top - ndcHeight * 0.78)) * height / 2)),
  };
}

function cropMetrics(frame, crop) {
  const { width, height, pixels } = frame;
  const values = [];
  const saturations = [];
  const edges = [];
  for (let y = crop.y0; y < crop.y1; y += 2) {
    for (let x = crop.x0; x < crop.x1; x += 2) {
      const index = (y * width + x) * 4;
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      saturations.push(Math.max(r, g, b) - Math.min(r, g, b));
      if (x + 2 < crop.x1 && y + 2 < crop.y1) {
        const right = (y * width + x + 2) * 4;
        const below = ((y + 2) * width + x) * 4;
        edges.push(Math.min(1, (
          Math.abs(r - pixels[right])
          + Math.abs(g - pixels[right + 1])
          + Math.abs(b - pixels[right + 2])
          + Math.abs(r - pixels[below])
          + Math.abs(g - pixels[below + 1])
          + Math.abs(b - pixels[below + 2])
        ) / 192));
      }
    }
  }
  const ordered = values.slice().sort((a, b) => a - b);
  return {
    crop,
    samples: values.length,
    meanLuma: Number(mean(values).toFixed(3)),
    p90Luma: Number((ordered[Math.max(0, Math.ceil(ordered.length * 0.9) - 1)] || 0).toFixed(3)),
    shadowPixelRatio: Number((values.filter((value) => value <= 8).length / Math.max(1, values.length)).toFixed(4)),
    meanSaturation: Number(mean(saturations).toFixed(3)),
    edgeDensity: Number(mean(edges).toFixed(4)),
  };
}

function localBackgroundMetrics(frame, crop) {
  const { width, height, pixels } = frame;
  const padX = Math.max(8, Math.ceil((crop.x1 - crop.x0) * 0.35));
  const padY = Math.max(8, Math.ceil((crop.y1 - crop.y0) * 0.25));
  const outer = {
    x0: Math.max(0, crop.x0 - padX),
    x1: Math.min(width, crop.x1 + padX),
    y0: Math.max(0, crop.y0 - padY),
    y1: Math.min(height, crop.y1 + padY),
  };
  const values = [];
  for (let y = outer.y0; y < outer.y1; y += 2) {
    for (let x = outer.x0; x < outer.x1; x += 2) {
      if (x >= crop.x0 && x < crop.x1 && y >= crop.y0 && y < crop.y1) continue;
      const index = (y * width + x) * 4;
      values.push(0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]);
    }
  }
  return {
    ring: outer,
    samples: values.length,
    meanLuma: Number(mean(values).toFixed(3)),
  };
}

async function capture(page, name) {
  const path = join(outputDir, `${name}.png`);
  await page.screenshot({ path });
  const diagnostics = await page.evaluate(() => {
    const api = window.__SF_REALMAP__;
    const perf = api.getPerf();
    return {
      timeOfDay: perf.timeOfDay,
      weather: perf.weather,
      life: api.getHeroLifeLighting(),
      staging: perf.heroPedestrianStaging,
      camera: api.getHeroCamera(),
      fps: perf.fps,
      frameMs: perf.avgFrameMs,
    };
  });
  return { name, path, diagnostics };
}

try {
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__SF_REALMAP__?.getHeroLifeLighting?.()?.active
      && document.body.classList.contains('is-city'),
    { timeout: 60000 },
  );
  await page.evaluate(() => window.__SF_REALMAP__.setBeauty(true));
  await page.evaluate((settings) => {
    const api = window.__SF_REALMAP__;
    api.setWeather('clear');
    api.setTimeOfDay('day');
    api.setPlayerPose(settings);
  }, pose);
  await page.waitForTimeout(850);
  const day = await capture(page, 'day');
  const dayCamera = day.diagnostics.camera.cameraPosition;
  await page.evaluate(() => window.__SF_REALMAP__.setTimeOfDay('night'));
  // Keep the camera/pose fixed and capture at the first stable night frame;
  // this is a lighting-only pair, with actor movement measured below.
  await page.waitForTimeout(140);
  const night = await capture(page, 'night');
  const nightCamera = night.diagnostics.camera.cameraPosition;

  const [dayFrame, nightFrame] = await Promise.all([
    imageData(page, day.path),
    imageData(page, night.path),
  ]);
  assert.equal(dayFrame.width, nightFrame.width, 'day/night frame widths must match');
  assert.equal(dayFrame.height, nightFrame.height, 'day/night frame heights must match');
  const dayAdults = day.diagnostics.staging?.screenSpace?.adults || [];
  const nightAdults = night.diagnostics.staging?.screenSpace?.adults || [];
  const nightByIdentity = new Map(nightAdults.map((adult) => [adult.sourceIdentity, adult]));
  const adultMetrics = dayAdults
    .filter((adult) => adult.detailed && adult.readable && nightByIdentity.has(adult.sourceIdentity))
    .map((adult) => {
      const nightAdult = nightByIdentity.get(adult.sourceIdentity);
      const dayCrop = bodyCropFromNdc(adult.rect, dayFrame.width, dayFrame.height);
      const nightCrop = bodyCropFromNdc(nightAdult.rect, nightFrame.width, nightFrame.height);
      const dayMetric = cropMetrics(dayFrame, dayCrop);
      const nightMetric = cropMetrics(nightFrame, nightCrop);
      const dayBackground = localBackgroundMetrics(dayFrame, dayCrop);
      const nightBackground = localBackgroundMetrics(nightFrame, nightCrop);
      return {
        sourceIdentity: adult.sourceIdentity,
        day: {
          ...dayMetric,
          localBackground: dayBackground,
          localBackgroundContrast: Number((dayMetric.meanLuma - dayBackground.meanLuma).toFixed(3)),
        },
        night: {
          ...nightMetric,
          localBackground: nightBackground,
          localBackgroundContrast: Number((nightMetric.meanLuma - nightBackground.meanLuma).toFixed(3)),
        },
        nightMinusDayLuma: Number((nightMetric.meanLuma - dayMetric.meanLuma).toFixed(3)),
      };
    });
  assert.ok(adultMetrics.length >= 3, 'matched crop metrics require at least three readable detailed adults');

  const dayUrl = `data:image/png;base64,${(await readFile(day.path)).toString('base64')}`;
  const nightUrl = `data:image/png;base64,${(await readFile(night.path)).toString('base64')}`;
  const contactSheet = await page.evaluate(async ({ dayUrl: dayImageUrl, nightUrl: nightImageUrl }) => {
    const load = async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image;
    };
    const [dayImage, nightImage] = await Promise.all([load(dayImageUrl), load(nightImageUrl)]);
    const canvas = document.createElement('canvas');
    canvas.width = dayImage.width * 2;
    canvas.height = dayImage.height;
    const context = canvas.getContext('2d');
    context.drawImage(dayImage, 0, 0);
    context.drawImage(nightImage, dayImage.width, 0);
    context.fillStyle = 'rgba(0,0,0,0.62)';
    context.fillRect(24, 24, 118, 34);
    context.fillRect(dayImage.width + 24, 24, 132, 34);
    context.fillStyle = '#ffffff';
    context.font = '700 22px sans-serif';
    context.fillText('DAY', 42, 48);
    context.fillText('NIGHT', dayImage.width + 42, 48);
    return canvas.toDataURL('image/png');
  }, { dayUrl, nightUrl });
  await writeFile(join(outputDir, 'day-night-sbs.png'), Buffer.from(contactSheet.split(',')[1], 'base64'));

  const sourcePositions = (diagnostics) => new Map(
    (diagnostics.life?.stats?.detailAssignments || [])
      .map((assignment) => [assignment.sourceIdentity, assignment.position]),
  );
  const dayPositions = sourcePositions(day.diagnostics);
  const nightPositions = sourcePositions(night.diagnostics);
  const movement = [...dayPositions.entries()]
    .filter(([identity]) => nightPositions.has(identity))
    .map(([identity, position]) => {
      const next = nightPositions.get(identity);
      return { identity, metres: Number(Math.hypot(next[0] - position[0], next[2] - position[2]).toFixed(4)) };
    });
  const report = {
    result: errors.length ? 'failed' : 'captured',
    url,
    pose,
    buildHash: process.env.SF_QA_BUILD_HASH || 'runtime-head',
    viewport,
    outputPixels: { width: dayFrame.width, height: dayFrame.height },
    matchedAdults: adultMetrics.length,
    adultMetrics,
    aggregate: {
      dayMeanLuma: Number(mean(adultMetrics.map(({ day: metric }) => metric.meanLuma)).toFixed(3)),
      nightMeanLuma: Number(mean(adultMetrics.map(({ night: metric }) => metric.meanLuma)).toFixed(3)),
      dayMeanShadowPixelRatio: Number(mean(adultMetrics.map(({ day: metric }) => metric.shadowPixelRatio)).toFixed(4)),
      nightMeanShadowPixelRatio: Number(mean(adultMetrics.map(({ night: metric }) => metric.shadowPixelRatio)).toFixed(4)),
      dayMeanSaturation: Number(mean(adultMetrics.map(({ day: metric }) => metric.meanSaturation)).toFixed(3)),
      nightMeanSaturation: Number(mean(adultMetrics.map(({ night: metric }) => metric.meanSaturation)).toFixed(3)),
      dayMeanLocalBackgroundContrast: Number(mean(
        adultMetrics.map(({ day: metric }) => metric.localBackgroundContrast),
      ).toFixed(3)),
      nightMeanLocalBackgroundContrast: Number(mean(
        adultMetrics.map(({ night: metric }) => metric.localBackgroundContrast),
      ).toFixed(3)),
    },
    cameraDeltaM: Number(Math.hypot(
      nightCamera[0] - dayCamera[0],
      nightCamera[1] - dayCamera[1],
      nightCamera[2] - dayCamera[2],
    ).toFixed(5)),
    sourceMovementM: movement,
    day: {
      life: day.diagnostics.life,
      fps: day.diagnostics.fps,
      frameMs: day.diagnostics.frameMs,
    },
    night: {
      life: night.diagnostics.life,
      fps: night.diagnostics.fps,
      frameMs: night.diagnostics.frameMs,
    },
    errors,
  };
  await writeFile(join(outputDir, 'wardrobe-metrics.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  await page.close();
} finally {
  await browser.close();
}
