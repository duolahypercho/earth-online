import { chromium } from 'playwright';
import { access, readFile } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const capture = process.env.SF_QA_CAPTURE !== '0';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome)
  .then(() => systemChrome)
  .catch(() => undefined);
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
const httpErrors = [];
const checks = [];
const stops = [
  { key: '1:0', position: { x: 256, z: -59 }, name: 'Civic Center edge' },
  { key: '4:0', position: { x: 1600, z: 0 }, name: 'Financial District edge' },
  { key: '0:4', position: { x: 0, z: 1536 }, name: 'Pacific Heights' },
  { key: '4:4', position: { x: 1600, z: 1536 }, name: 'North Beach edge' },
  { key: '-4:1', position: { x: -1600, z: 384 }, name: 'Presidio Heights edge' },
];

const check = (name, pass, detail = null) => {
  checks.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
};

page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
    errors.push(message.text());
  }
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    httpErrors.push(`${response.status()} ${response.url()}`);
  }
});

async function settle() {
  // Let streaming settle and the HUD's two-second rolling FPS window fill
  // before treating a teleported district as visual evidence.
  await page.waitForTimeout(3000);
}

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
  await settle();

  const boot = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    return {
      webgl2: sim.renderer.capabilities.isWebGL2 === true,
      revision: sim.renderer.getContext()?.getParameter(sim.renderer.getContext().RENDERER) || null,
      city: sim.streaming.getStats(),
    };
  });
  check('WebGL2 active', boot.webgl2);
  check('Large streamed city is available', boot.city.totalCitySectors >= 800, boot.city);

  for (const stop of stops) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), stop.position);
    await page.waitForFunction(
      (key) => window.__SF_SIM__?.streaming?.stats?.focusSector === key,
      stop.key,
      { timeout: 12000 },
    );
    await settle();
    const evidence = await page.evaluate((position) => {
      const sim = window.__SF_SIM__;
      const stats = sim.streaming.getStats();
      const agents = stats.streamedAgents;
      const portal = sim.streaming.getNearestEnterablePortal(position, 1800);
      return {
        focusSector: stats.focusSector,
        activeDetailed: stats.activeDetailed,
        activeProxies: stats.activeProxies,
        enterableBuildings: stats.enterableBuildings,
        enterableSectors: stats.enterableSectors,
        district: sim.streaming.getSectorPresentation(stats.focusSector)?.presentation?.district || null,
        vehicles: agents?.vehicles?.visible ?? null,
        pedestrians: agents?.pedestrians?.visible ?? null,
        portal: portal ? {
          id: portal.id,
          district: portal.district,
          roomKind: portal.roomKind,
          position: portal.position,
          approach: portal.approach,
        } : null,
      };
    }, stop.position);
    check(`${stop.key} reaches streamed focus`, evidence.focusSector === stop.key, evidence);
    check(`${stop.key} exposes detail buildings`, evidence.enterableBuildings > 0, evidence);
    check(`${stop.key} exposes live representatives`, evidence.vehicles > 0 && evidence.pedestrians > 0, evidence);
    check(`${stop.key} exposes an enterable portal`, Boolean(evidence.portal), evidence);

    if (evidence.portal) {
      await page.evaluate((approach) => window.__SF_SIM__.setRoamPose(approach), evidence.portal.approach);
      await settle();
      await page.keyboard.press('e');
      // Interior transitions include the staged shadow/lighting handoff;
      // match the production gate's settled window so low-elevation sectors
      // are not sampled mid-transition.
      await page.waitForTimeout(3200);
      const interior = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
      check(`${stop.key} portal enters`, interior.active === true, {
        portalId: interior.portalId,
        variant: interior.variant,
      });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(650);
      const exterior = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
      check(`${stop.key} portal exits`, exterior.active === false, exterior);
      // Return the camera to the district framing before capturing evidence;
      // the portal approach deliberately faces the doorway at close range.
      await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), stop.position);
      await settle();
    }

    if (capture) {
      await page.screenshot({ path: `.qa-gauntlet-${stop.key.replaceAll(':', '-')}.png` });
    }
  }

  for (const mode of ['fog', 'drizzle', 'clear']) {
    const requested = await page.evaluate((next) => window.__SF_SIM__.setWeather(next), mode);
    await page.waitForTimeout(1500);
    const active = await page.evaluate(() => window.__SF_SIM__.weather);
    check(`Weather ${mode} settles`, requested === mode && active === mode, { requested, active });
  }

  const result = {
    result: checks.every((entry) => entry.pass) && errors.length === 0 && httpErrors.length === 0
      ? 'gauntlet matrix passed'
      : 'gauntlet matrix failed',
    baseUrl,
    qaAngle,
    checks,
    errors: [...errors, ...httpErrors],
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'gauntlet matrix passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'gauntlet matrix failed',
    error: error.message,
    errors: [...errors, ...httpErrors],
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
