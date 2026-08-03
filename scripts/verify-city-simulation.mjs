import { chromium } from 'playwright';
import { access, readFile } from 'node:fs/promises';

const baseUrl = process.env.SF_QA_URL || 'http://localhost:5173/';
const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
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
const httpErrors = [];
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

const checks = [];
const check = (name, pass, detail = null) => {
  checks.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
};

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
  await page.waitForTimeout(1400);

  const boot = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const coverage = sim.city.getPortalCoverage();
    const traffic = sim.traffic.getStats();
    const trafficDiagnostics = sim.traffic.getDiagnostics?.() ?? null;
    const pedestrians = sim.pedestrians.getStats();
    const residentStories = sim.pedestrians.getFeaturedResidentSnapshots?.() ?? [];
    const vehicleLife = sim.traffic.getVehicleLifeSnapshot?.() ?? null;
    const hudLife = document.querySelector('[data-state="life"]')?.textContent || '';
    return {
      webgl2: sim.renderer.capabilities.isWebGL2 === true,
      coverage,
      traffic,
      trafficDiagnostics,
      pedestrians,
      residentStories,
      vehicleLife,
      hudLife,
      weather: sim.weather,
    };
  });

  check('WebGL2 active', boot.webgl2);
  check('Three.js r180 pinned', packageJson.dependencies?.three === '0.180.0', packageJson.dependencies?.three);
  check('Authored portals functional', boot.coverage.functional >= boot.coverage.coreFunctional);
  check('Core portal coverage milestone', boot.coverage.coreFunctional >= 43, boot.coverage.coreFunctional);
  check('Doorway/sign coverage',
    boot.coverage.doorwayMeshLinked >= 50 && boot.coverage.explicitlySignposted >= 50,
    {
      doorwayMeshLinked: boot.coverage.doorwayMeshLinked,
      explicitlySignposted: boot.coverage.explicitlySignposted,
    });
  check('Interior variants present', boot.coverage.interiorVariants >= 6, boot.coverage.interiorVariants);
  check('Traffic active', Number(boot.traffic.active ?? boot.traffic.visible ?? 0) > 0, boot.traffic);
  const trafficDiagnosticFields = [
    'elapsed',
    'maxAcceleration',
    'maxDeceleration',
    'maxJerk',
    'maxSafetyCorrection',
  ];
  check(
    'Traffic dynamics diagnostics finite',
    trafficDiagnosticFields.every((field) => Number.isFinite(boot.trafficDiagnostics?.[field])),
    boot.trafficDiagnostics,
  );
  check(
    'Traffic gap diagnostics safe',
    ['minLaneGap', 'minMovingHeadway', 'minStoppedGap'].every((field) => (
      boot.trafficDiagnostics?.[field] == null || boot.trafficDiagnostics[field] >= -0.01
    )),
    boot.trafficDiagnostics,
  );
  check('NPCs walking', Number(boot.pedestrians.walking ?? 0) > 0, boot.pedestrians);
  check('NPCs working', Number(boot.pedestrians.working ?? 0) > 0, boot.pedestrians);
  check(
    'Resident micro-stories exposed',
    boot.residentStories.some((story) => (
      story?.visible
      && story.role
      && story.action
      && (story.destination || story.need)
    )),
    boot.residentStories.slice(0, 2),
  );
  check(
    'Resident operational mood and choice exposed',
    boot.residentStories.some((story) => (
      story?.visible
      && story.mood
      && story.choice
    )),
    boot.residentStories.slice(0, 2),
  );
  check(
    'Vehicle life identities exposed',
    Number(boot.vehicleLife?.count ?? 0) > 0
      && boot.vehicleLife?.vehicles?.some((vehicle) => (
        vehicle?.identity?.label
        && vehicle?.action?.label
        && vehicle?.class
      )),
    {
      count: boot.vehicleLife?.count ?? 0,
      featured: boot.vehicleLife?.featured ?? 0,
    },
  );
  check(
    'HUD shows a live street story',
    /Resident|Courier|Barista|Worker|Cleaner|Tourist|Phone/i.test(boot.hudLife),
    boot.hudLife,
  );
  check(
    'HUD includes operational story context',
    /MOOD|CHOICE/.test(boot.hudLife),
    boot.hudLife,
  );

  const weatherModes = [];
  for (const mode of ['fog', 'drizzle', 'clear']) {
    const next = await page.evaluate((requested) => window.__SF_SIM__.setWeather(requested), mode);
    await page.waitForTimeout(1450);
    const active = await page.evaluate(() => window.__SF_SIM__.weather);
    weatherModes.push(active);
    check(`Weather ${mode}`, next === mode && active === mode, { next, active });
  }

  const interior = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const portal = sim.city.portals.find((candidate) => (
      candidate.featured
      && candidate.room
      && String(candidate.label || '').toLowerCase().includes('welcome center')
    ))
      ?? sim.city.portals.find((candidate) => candidate.featured && candidate.room)
      ?? sim.city.portals.find((candidate) => candidate.room);
    const route = portal?.approachRoute || [];
    const point = route[route.length - 1] || portal?.position;
    if (!point) return { active: false, reason: 'no portal' };
    sim.setRoamPose({ x: point.x, z: point.z });
    return { active: false, portal: portal.id };
  });
  await page.waitForTimeout(1000);
  await page.keyboard.press('e');
  await page.waitForTimeout(3200);
  const interiorState = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
  check('Portal enters interior', interiorState.active === true, interiorState);
  const flagshipActions = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const state = sim.city.getInteriorState();
    const portal = sim.city.portals.find((candidate) => candidate.id === state.portalId);
    const origin = portal?.room?.position;
    if (!state.flagship || !origin) return [];
    return state.flagship.hotspots.map((hotspot) => sim.city.useInteriorInteraction(
      hotspot.id,
      {
        x: origin.x + hotspot.position.x,
        y: origin.y + hotspot.position.y,
        z: origin.z + hotspot.position.z,
      },
    ));
  });
  check('Flagship hotspot actions', flagshipActions.length === 3
    && flagshipActions.every((action) => action?.changed === true), flagshipActions);
  const flagshipAfterActions = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
  check('Flagship archive reveal', flagshipAfterActions.flagship?.backRoom === 'revealed', flagshipAfterActions.flagship);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(650);
  const exteriorState = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
  check('Portal exits interior', exteriorState.active === false, exteriorState);

  await page.evaluate(() => window.__SF_SIM__.setRoamPose({ x: 288, z: -64 }));
  await page.waitForTimeout(1800);
  const streamedPortal = await page.evaluate(() => {
    const sim = window.__SF_SIM__;
    const descriptor = sim.streaming.getNearestEnterablePortal({ x: 288, z: -64 }, 240);
    return descriptor ? {
      id: descriptor.id,
      label: descriptor.label,
      sectorKey: descriptor.sectorKey,
      buildingId: descriptor.buildingId,
      roomKind: descriptor.roomKind,
      position: descriptor.position,
      distance: descriptor.distance,
    } : null;
  });
  check('Streamed enterable portal exposed', Boolean(streamedPortal), streamedPortal);
  if (streamedPortal) {
    await page.evaluate((position) => window.__SF_SIM__.setRoamPose(position), streamedPortal.position);
    await page.waitForTimeout(850);
    await page.keyboard.press('e');
    await page.waitForTimeout(3200);
    const streamedInterior = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
    check('Streamed portal enters interior', streamedInterior.active === true
      && streamedInterior.portalId?.startsWith('sf-streamed-portal:'), streamedInterior);
    check('Streamed interior exposes prop collision', streamedInterior.interiorCollisionMode === 'aabb-envelope+address-dressing'
      && streamedInterior.interiorCollisionBoxes > 0, streamedInterior);
    check(
      'Streamed civic portal resolves its own room identity',
      streamedInterior.roomLabel !== 'Embarcadero Welcome Center'
        && streamedInterior.flagship === null,
      streamedInterior,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(650);
    const streamedExterior = await page.evaluate(() => window.__SF_SIM__.city.getInteriorState());
    check('Streamed portal exits interior', streamedExterior.active === false, streamedExterior);
  }

  const evidence = await page.evaluate(async () => window.__SF_SIM__.setStreamingEvidenceStop('1:0'));
  check('Streaming evidence stop verified', evidence.verified === true, {
    sector: evidence.sectorKey,
    errors: evidence.verificationErrors,
  });

  const result = {
    result: checks.every((entry) => entry.pass) && errors.length === 0 ? 'city simulation gate passed' : 'city simulation gate failed',
    baseUrl,
    weatherModes,
    checks,
    errors: [...errors, ...httpErrors],
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'city simulation gate passed') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    result: 'city simulation gate failed',
    error: error.message,
    errors: [...errors, ...httpErrors],
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
