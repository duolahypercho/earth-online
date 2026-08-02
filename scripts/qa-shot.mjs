import { chromium } from 'playwright';
import { access } from 'node:fs/promises';

// Usage: node scripts/qa-shot.mjs <out.png> [--vehicle <class>] [--rear] [--weather <mode>]
// --vehicle frames a tracking close-up of a pooled traffic vehicle.
const args = process.argv.slice(2);
const out = args[0] || '.qa-traffic-shot.png';
const vi = args.indexOf('--vehicle');
const vehicleClass = vi >= 0 ? (args[vi + 1] || 'sedan') : null;
const rear = args.includes('--rear');
const wi = args.indexOf('--weather');
const weatherMode = wi >= 0 ? (args[wi + 1] || 'clear') : null;
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
    ...(qaAngle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
  ],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
await page.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(
  () => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled,
  { timeout: 30000 },
);
await page.evaluate(() => document.querySelector('#launch-button').click());
await page.waitForFunction(
  () => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'),
  { timeout: 10000 },
);
if (weatherMode) {
  await page.evaluate((mode) => window.__SF_SIM__.setWeather(mode), weatherMode);
  await page.waitForTimeout(1800);
}
await page.waitForTimeout(vehicleClass ? 2200 : 9000);
if (vehicleClass) {
  // Track the vehicle for a short burst so the pose stays framed while the
  // sim advances, then screenshot on the last applied pose.
  const ok = await page.evaluate(async ({ cls, rearView }) => {
    const sim = window.__SF_SIM__;
    const group = sim.traffic.group;
    const matches = group.children.filter((child) => (
      child.userData?.vehicleClass === cls
      && !child.children.some((c) => c.name === 'Detailed hero traffic LOD')
    ));
    if (!matches.length) return false;
    // Prefer a light-bodied vehicle for legibility (white/silver paint).
    const target = matches[0];
    const frames = 30;
    for (let i = 0; i < frames; i += 1) {
      const p = target.position;
      const yaw = target.rotation.y;
      const dist = 8.6;
      const angle = yaw + (rearView ? Math.PI - 0.62 : 0.68);
      sim.setCameraPose(
        { x: p.x + Math.sin(angle) * dist, y: p.y + 2.05, z: p.z + Math.cos(angle) * dist },
        { x: p.x, y: p.y + 0.72, z: p.z },
      );
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return true;
  }, { cls: vehicleClass, rearView: rear });
  if (!ok) console.log('warn: no vehicle of class', vehicleClass, 'found');
}
await page.screenshot({ path: out });
console.log('saved', out);
if (errors.length) console.log('errors:', errors.slice(0, 5));
await browser.close();
