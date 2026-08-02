import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('cerr', m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#launch-button') && !document.querySelector('#launch-button').disabled, { timeout: 30000 });
await page.evaluate(() => document.querySelector('#launch-button').click());
await page.waitForFunction(() => document.querySelector('#boot-overlay')?.classList.contains('is-dismissed'), { timeout: 10000 });
await page.evaluate(async () => {
  const sim = window.__SF_SIM__;
  const THREE = sim.scene.children[0].constructor.prototype ? null : null;
  // Reuse the app's own THREE via an existing object: grab from a mesh's geometry ctor chain is messy.
  // Instead: traffic group children are vehicle roots. Clone one sedan root into an isolated rig.
  const group = sim.traffic.group;
  const sedan = group.children.find((c) => c.userData?.vehicleClass === 'sedan'
    && !c.children.some((x) => x.name === 'Detailed hero traffic LOD'));
  // Detach from sim and pin at origin-ish in front of a QA camera.
  sedan.position.set(28, 0.05, 0);
  sedan.rotation.set(0, Math.PI * 0.22, 0);
  sedan.updateMatrixWorld(true);
  sim.setCameraPose({ x: 28 + 6.4, y: 2.4, z: 0 + 6.8 }, { x: 28, y: 0.85, z: 0 });
  // Hide everything else for a clean plate.
  sim.traffic.group.children.forEach((c) => { if (c !== sedan) c.visible = false; });
  sim.pedestrians.group.visible = false;
});
await page.waitForTimeout(400);
await page.screenshot({ path: '.qa-iso-sedan.png' });
console.log('saved .qa-iso-sedan.png');
await browser.close();
