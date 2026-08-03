import { chromium } from 'playwright';
import { access, readFile } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);
const angle = process.env.SF_QA_ANGLE || 'metal';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',
    `--use-angle=${angle}`,
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
    errors.push(message.text());
  }
});

async function analyzeImage(path) {
  const buffer = await readFile(path);
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlank = 0;
    let lumaSum = 0;
    let colorSum = 0;
    let edgeSum = 0;
    let sampleCount = 0;
    const width = canvas.width;
    const height = canvas.height;
    const step = 4;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const index = (y * width + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        lumaSum += luma;
        colorSum += saturation;
        if (luma > 8) nonBlank += 1;
        sampleCount += 1;
        if (x + step < width && y + step < height) {
          const next = ((y + step) * width + x) * 4;
          const dx = Math.abs(data[next] - r) + Math.abs(data[next + 1] - g) + Math.abs(data[next + 2] - b);
          const below = ((y) * width + x + step) * 4;
          const dy = Math.abs(data[below] - r) + Math.abs(data[below + 1] - g) + Math.abs(data[below + 2] - b);
          edgeSum += Math.min(1, (dx + dy) / 96);
        }
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      nonBlankRatio: nonBlank / sampleCount,
      meanLuma: lumaSum / sampleCount,
      meanSaturation: colorSum / sampleCount,
      edgeDensity: edgeSum / sampleCount,
    };
  }, dataUrl);
}

const results = {};
try {
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
    { timeout: 30000 },
  );
  await page.locator('#launch-button').click();
  await page.waitForFunction(
    () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
    { timeout: 15000 },
  );
  await page.waitForTimeout(1500);

  results.live = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const avatar = sim.playerAvatar;
    const avatarWorld = avatar?.position || null;
    const camera = sim.camera;
    const projected = avatarWorld
      ? avatarWorld.clone().project(camera)
      : null;
    const hudLife = document.querySelector('.hud__life')?.getBoundingClientRect() || null;
    const hudOnline = document.querySelector('.hud__online')?.getBoundingClientRect() || null;
    return {
      avatarVisible: avatar?.visible === true,
      avatarHeroRig: avatar?.userData?.heroDetail === true,
      avatarOnScreen: projected
        ? projected.x >= -1 && projected.x <= 1 && projected.y >= -1 && projected.y <= 1
        : false,
      avatarScreen: projected ? { x: projected.x, y: projected.y } : null,
      drawCalls: sim.renderer.info.render.calls,
      triangles: sim.renderer.info.render.triangles,
      cameraDistance: Math.hypot(
        camera.position.x - avatarWorld?.x,
        camera.position.y - avatarWorld?.y,
        camera.position.z - avatarWorld?.z,
      ),
      hudLife,
      hudOnline,
      fps: sim.getPerformanceSnapshot().averageFrameMs,
      lifeState: sim.lifeSim.getState(),
    };
  });

  const parked = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const snapshot = sim.traffic.getVehicleLifeSnapshot();
    const candidate = snapshot.vehicles.find((vehicle) => vehicle.action.key === 'parked')
      || snapshot.vehicles.find((vehicle) => Number(vehicle.speed) < 0.9);
    return candidate ? candidate.position : null;
  });
  if (parked) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose({ x: position.x - 2.6, z: position.z + 1.2 }), parked);
    await page.waitForTimeout(500);
    const entered = await page.evaluate(() => window.__SF_SIM__.enterCar());
    results.driveEntered = entered;
    if (entered) {
      await page.keyboard.down('w');
      await page.waitForTimeout(1200);
      await page.keyboard.up('w');
      await page.screenshot({ path: '.qa-probe-driving.png' });
      results.driving = await page.evaluate(() => {
        const sim = window.__SF_SIM__;
        const state = sim.traffic.getPlayerVehicleState();
        const project = (x, y, z) => {
          const cam = sim.camera;
          cam.updateMatrixWorld(true);
          cam.updateMatrixWorld();
          const e = cam.matrixWorldInverse.elements;
          const p = cam.projectionMatrix.elements;
          const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
          const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
          const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
          const vw = e[3] * x + e[7] * y + e[11] * z + e[15];
          const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw;
          const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw;
          const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw;
          return cw !== 0 ? { x: cx / cw, y: cy / cw } : null;
        };
        return {
          driving: sim.isDriving(),
          speed: state?.speed,
          carOnScreen: state
            ? (() => {
              const projected = project(state.position.x, state.position.y, state.position.z);
              return Boolean(projected && projected.x >= -1 && projected.x <= 1 && projected.y >= -1 && projected.y <= 1);
            })()
            : false,
        };
      });
    }
  }

  for (const file of [
    '.qa-online-walking.png',
    '.qa-online-driving.png',
    '.qa-online-remote-driver.png',
    '.qa-online-chat-voice.png',
    '.qa-probe-driving.png',
  ]) {
    try {
      results[file] = await analyzeImage(file);
    } catch {
      results[file] = null;
    }
  }
  results.errors = errors;
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: 'probe failed', error: error.message, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
