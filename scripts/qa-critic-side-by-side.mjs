import { chromium } from 'playwright';
import { access, readFile, mkdir } from 'node:fs/promises';

// Usage: node scripts/qa-critic-side-by-side.mjs [--game path] [--ref path] [--out path]
const args = process.argv.slice(2);
const gamePath = args[args.indexOf('--game') + 1] || '.qa-online-walking.png';
const referencePath = args[args.indexOf('--ref') + 1] || 'public/data/reference-sf.jpg';
const outPath = args[args.indexOf('--out') + 1] || '.qa-side-by-side-real-vs-game.png';
const systemChrome = process.env.SF_QA_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = await access(systemChrome).then(() => systemChrome).catch(() => undefined);

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage'],
  ...(executablePath ? { executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1600, height: 720 } });

const gameBase64 = await readFile(gamePath).then((buffer) => buffer.toString('base64'));
const referenceBase64 = await readFile(referencePath).then((buffer) => buffer.toString('base64'));

const html = `<!doctype html>
<html>
  <body style="margin:0;background:#0a0f13">
    <img id="ref" src="data:image/jpeg;base64,${referenceBase64}" />
    <img id="game" src="data:image/png;base64,${gameBase64}" />
  </body>
</html>`;
await page.setContent(html, { waitUntil: 'load' });
await page.waitForFunction(() => {
  const ref = document.querySelector('#ref');
  const game = document.querySelector('#game');
  return ref?.complete && game?.complete && ref.naturalWidth > 0 && game.naturalWidth > 0;
});

await page.evaluate(async () => {
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
  ctx.font = '700 24px sans-serif';
  ctx.fillText('REAL SAN FRANCISCO / PHOTO', 24, 31);
  ctx.fillText('THIS BUILD / THREE.JS r180', 824, 31);
  document.body.append(canvas);
  ref.style.display = 'none';
  game.style.display = 'none';
});
await page.screenshot({ path: outPath });
await browser.close();
console.log('saved', outPath);
