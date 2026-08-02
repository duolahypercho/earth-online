import { chromium } from 'playwright';
const [cls = 'sedan'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://localhost:5173/scripts/qa-vehicles.html?cls=${cls}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__READY__, { timeout: 20000 });
const dump = await page.evaluate(() => ({ dims: window.__DIMS__, body: window.__BODY_DUMP__ }));
console.log('dims', dump.dims);
for (const r of dump.body) {
  console.log(`pos(${r.pos.join(',')}) scale(${r.scale.join(',')}) #${r.color}${r.glass ? ' GLASS' : ''}`);
}
await browser.close();
