import { chromium } from 'playwright';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/citygen.html';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
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
page.on('pageerror', (error) => errors.push(error.message));
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
    };
  }, dataUrl);
}

const results = {};
try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__CITYGEN__?.getCity()?.buildings?.length > 50, { timeout: 60000 });
  await page.waitForTimeout(1200);

  results.state = await page.evaluate(() => {
    const api = window.__CITYGEN__;
    return api.getState();
  });
  await page.screenshot({ path: '.qa-citygen-hero.png' });

  await page.evaluate(() => {
    const api = window.__CITYGEN__;
    const camera = api.getRenderer().camera;
    camera.position.set(14, 3.4, 6);
    camera.lookAt(8, 1, -6);
    api.getRenderer().controls.target.set(8, 1, -6);
    api.getRenderer().controls.update();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.qa-citygen-street.png' });

  await page.evaluate(() => {
    const api = window.__CITYGEN__;
    api.getRenderer().camera.position.set(90, 230, 140);
    api.getRenderer().controls.target.set(0, 8, 0);
    api.getRenderer().controls.update();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.qa-citygen-aerial.png' });

  await page.evaluate(() => window.__CITYGEN__.setTime(21.5));
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const api = window.__CITYGEN__;
    api.getRenderer().camera.position.set(60, 8, 28);
    api.getRenderer().camera.lookAt(24, 2, -12);
    api.getRenderer().controls.target.set(24, 2, -12);
    api.getRenderer().controls.update();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.qa-citygen-night.png' });
  await page.evaluate(() => window.__CITYGEN__.setTime(15));

  results.frames = {};
  for (const file of ['.qa-citygen-hero.png', '.qa-citygen-street.png', '.qa-citygen-aerial.png', '.qa-citygen-night.png']) {
    try {
      results.frames[path.basename(file)] = await analyzeImage(file);
    } catch (error) {
      results.frames[path.basename(file)] = { error: error.message };
    }
  }
  results.errors = errors;
  await writeFile('.qa-citygen-results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'qa-citygen failed', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
