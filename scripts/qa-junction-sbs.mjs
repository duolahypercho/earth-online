/**
 * Capture Full City junction views + side-by-side vs reference SF street photo.
 * Usage: node scripts/qa-junction-sbs.mjs
 * Env: SF_QA_URL (default http://localhost:5173/realmap.html?play=1)
 *
 * Camera notes:
 * - Always force orbit mode (never walk/first-person).
 * - Poses use elevationAware: Y is height ABOVE terrain.
 * - Fallback targets sit on a real street junction, not a plaza gap.
 */
import { chromium } from 'playwright';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(projectRoot, 'tmp/junction-qa');
const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/realmap.html?play=1';
const referencePath = join(projectRoot, 'public/data/reference-sf-street.jpg');
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);

await mkdir(outDir, { recursive: true });

// Real secondary/residential junction near Financial — asphalt is on-screen here.
const JUNCTION = { x: 892, z: 377 };

const fallbackShots = [
  {
    id: 'spawn-overhead',
    label: 'SPAWN OVERHEAD',
    pose: {
      elevationAware: true,
      position: [JUNCTION.x - 80, 140, JUNCTION.z - 90],
      target: [JUNCTION.x, 1, JUNCTION.z],
    },
  },
  {
    id: 'spawn-street',
    label: 'SPAWN STREET',
    pose: {
      elevationAware: true,
      position: [JUNCTION.x - 28, 10, JUNCTION.z - 36],
      target: [JUNCTION.x + 40, 1, JUNCTION.z + 50],
    },
  },
  {
    id: 'junction-close',
    label: 'JUNCTION CLOSE',
    pose: {
      elevationAware: true,
      position: [JUNCTION.x - 18, 36, JUNCTION.z - 28],
      target: [JUNCTION.x + 8, 1, JUNCTION.z + 10],
    },
  },
];

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--use-angle=metal', '--enable-gpu'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message || error)));

const t0 = Date.now();
async function bootUntilReady() {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__SF_REALMAP__, { timeout: 90000 });
  while (Date.now() - t0 < 720000) {
    try {
      const ready = await page.evaluate(() => {
        const cov = window.__SF_REALMAP__?.getCoverage?.();
        const overlay = document.getElementById('build-overlay')
          || document.querySelector('[data-build-overlay], .build-overlay');
        const overlayHidden = !overlay || overlay.hidden || overlay.getAttribute('hidden') !== null
          || getComputedStyle(overlay).display === 'none'
          || getComputedStyle(overlay).visibility === 'hidden';
        return Boolean(
          cov?.cityWideReady
          && (cov.roadSegments || 0) > 1000
          && document.body.classList.contains('is-city')
          && overlayHidden,
        );
      });
      if (ready) return true;
    } catch (error) {
      const msg = String(error?.message || error);
      // Vite HMR / rebuild navigates away — reload and keep waiting.
      if (/Execution context was destroyed|navigation|Target closed/i.test(msg)) {
        console.warn('Page navigated during build wait — reloading…');
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        await page.waitForFunction(() => window.__SF_REALMAP__, { timeout: 90000 }).catch(() => {});
        continue;
      }
      throw error;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

const booted = await bootUntilReady();
const bootCoverage = booted
  ? await page.evaluate(() => window.__SF_REALMAP__?.getCoverage?.() || null)
  : null;
if (!bootCoverage?.cityWideReady) {
  console.error('Full City build not ready within timeout', bootCoverage);
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(5000);
await page.evaluate(() => {
  window.__SF_REALMAP__?.setCityMode?.('orbit');
  window.__SF_REALMAP__?.setBeauty?.(true);
  window.__SF_REALMAP__?.setTimeOfDay?.('day');
  window.__SF_REALMAP__?.setWeather?.('clear');
});
await page.waitForTimeout(400);

const suggested = await page.evaluate(() => {
  try {
    return window.__SF_REALMAP__?.getSuggestedCameraPoses?.() || null;
  } catch {
    return null;
  }
});

const shots = [...fallbackShots];
if (suggested?.hero?.position && suggested?.hero?.target) {
  shots.push({
    id: 'hero',
    label: 'HERO',
    pose: {
      elevationAware: suggested.hero.elevationAware !== false,
      position: suggested.hero.position,
      target: suggested.hero.target,
    },
  });
}
if (suggested?.street?.position && suggested?.street?.target) {
  shots.push({
    id: 'street',
    label: 'STREET',
    pose: {
      elevationAware: suggested.street.elevationAware !== false,
      position: suggested.street.position,
      target: suggested.street.target,
    },
  });
}

let coverage = await page.evaluate(() => window.__SF_REALMAP__.getCoverage());
const streetDesign = await page.evaluate(() => window.__SF_REALMAP__.getStreetDesign?.() || null);
const manifest = {
  capturedAt: new Date().toISOString(),
  baseUrl,
  coverage,
  streetDesign,
  errors: errors.slice(0, 12),
  frames: [],
};

let referenceBase64 = null;
try {
  referenceBase64 = (await readFile(referencePath)).toString('base64');
} catch {
  referenceBase64 = null;
}

async function capturePose(shot) {
  await page.evaluate((pose) => {
    window.__SF_REALMAP__.setCityMode?.('orbit');
    window.__SF_REALMAP__.setCameraPose({
      ...pose,
      elevationAware: pose.elevationAware !== false,
    });
  }, shot.pose);
  await page.waitForTimeout(1100);
  const gamePath = join(outDir, `${shot.id}.png`);
  await page.screenshot({ path: gamePath });
  manifest.frames.push({ id: shot.id, path: gamePath, label: shot.label });

  if (!referenceBase64) return;
  const gameBase64 = (await readFile(gamePath)).toString('base64');
  const sbs = await browser.newPage({ viewport: { width: 1600, height: 720 } });
  const html = `<!doctype html><html><body style="margin:0;background:#0a0f13">
    <img id="ref" src="data:image/jpeg;base64,${referenceBase64}" />
    <img id="game" src="data:image/png;base64,${gameBase64}" />
  </body></html>`;
  await sbs.setContent(html, { waitUntil: 'load' });
  await sbs.waitForFunction(() => {
    const ref = document.querySelector('#ref');
    const game = document.querySelector('#game');
    return ref?.complete && game?.complete && ref.naturalWidth > 0 && game.naturalWidth > 0;
  });
  await sbs.evaluate((label) => {
    const ref = document.querySelector('#ref');
    const game = document.querySelector('#game');
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0f13';
    ctx.fillRect(0, 0, 1600, 720);
    ctx.drawImage(ref, 0, 0, 800, 720);
    ctx.drawImage(game, 800, 0, 800, 720);
    ctx.fillStyle = 'rgba(10,15,19,0.82)';
    ctx.fillRect(0, 0, 800, 44);
    ctx.fillRect(800, 0, 800, 44);
    ctx.fillStyle = '#f5f0e7';
    ctx.font = '700 22px sans-serif';
    ctx.fillText('REAL SF STREET / PHOTO', 24, 30);
    ctx.fillText(`GAME · ${label}`, 824, 30);
    document.body.append(canvas);
    ref.style.display = 'none';
    game.style.display = 'none';
  }, shot.label);
  const sbsPath = join(outDir, `sbs-${shot.id}.png`);
  await sbs.screenshot({ path: sbsPath });
  await sbs.close();
  manifest.frames.push({ id: `sbs-${shot.id}`, path: sbsPath, label: `SBS ${shot.label}` });
}

for (const shot of shots) {
  await capturePose(shot);
}

// FPS after orbit settles — early coverage often reads ~1 right after build.
await page.waitForTimeout(1500);
coverage = await page.evaluate(() => window.__SF_REALMAP__.getCoverage());
manifest.coverage = coverage;

await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({
  outDir,
  frames: manifest.frames.map((f) => f.id),
  streetDesign: streetDesign?.summary || null,
  junctions: coverage.nearThreeRoadsJunctions,
  threeRoads: coverage.nearThreeRoads,
  fps: coverage.fps,
  roadGroupChildren: coverage.roadGroupChildren,
  centerlineDashes: coverage.centerlineDashes,
  crosswalkStripes: coverage.crosswalkStripes,
  sidewalkCorners: coverage.sidewalkCorners,
  junctionPads: coverage.junctionPads,
  errors: errors.slice(0, 6),
}, null, 2));
await browser.close();
