import { chromium } from 'playwright';
import { access } from 'node:fs/promises';
// node scripts/qa-vehicles.mjs <cls> <out.png> [yaw] [colorHex]
const [cls = 'sedan', out = '.qa-veh.png', yaw = '38', color = 'c7cbd1'] = process.argv.slice(2);
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
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('cerr', m.text()); });
await page.goto(`http://localhost:5173/scripts/qa-vehicles.html?cls=${cls}&yaw=${yaw}&color=${color}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__READY__, { timeout: 20000 });
await page.waitForTimeout(150);
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
