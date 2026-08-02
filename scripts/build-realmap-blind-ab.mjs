import { readFile, writeFile, access } from 'node:fs/promises';

// Usage: node scripts/build-realmap-blind-ab.mjs
// Builds .qa-realmap-blind-ab.html with five randomized real-vs-game pairs.
const args = process.argv.slice(2);
const outPath = args[args.indexOf('--out') + 1] || '.qa-realmap-blind-ab.html';

const pairs = [
  {
    id: 'walking-street',
    label: 'Walking / street life',
    ref: 'public/data/reference-sf-street.jpg',
    game: '.qa-realmap-street-beauty.png',
  },
  {
    id: 'downtown-canyon',
    label: 'Downtown avenue',
    ref: 'public/data/reference-sf.jpg',
    game: '.qa-realmap-canyon-beauty.png',
  },
  {
    id: 'hills',
    label: 'San Francisco hills',
    ref: 'public/data/reference-sf.jpg',
    game: '.qa-realmap-hills-beauty.png',
  },
  {
    id: 'night-city',
    label: 'Night city',
    ref: 'public/data/reference-sf-night.jpg',
    game: '.qa-realmap-night-beauty.png',
  },
  {
    id: 'hero-canyon',
    label: 'Skyline / canyon',
    ref: 'public/data/reference-sf.jpg',
    game: '.qa-realmap-hero-beauty.png',
  },
];

for (const pair of pairs) {
  await access(pair.ref);
  await access(pair.game);
}

async function dataUrl(path) {
  const buffer = await readFile(path);
  const extension = path.split('.').pop().toLowerCase();
  const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

const embedded = [];
for (const pair of pairs) {
  embedded.push({
    ...pair,
    refData: await dataUrl(pair.ref),
    gameData: await dataUrl(pair.game),
  });
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Blind A/B - Real San Francisco vs the Real Map Lab</title>
  <style>
    :root { color-scheme: dark; --ink:#f5f0e7; --muted:rgba(245,240,231,.62); --line:rgba(245,240,231,.16); --gold:#f2b56d; --teal:#6bd6c5; }
    * { box-sizing: border-box; }
    body { margin:0; background:#0a0f13; color:var(--ink); font:16px/1.45 ui-sans-serif,system-ui,sans-serif; }
    header { padding:1.2rem 1.5rem; border-bottom:1px solid var(--line); }
    h1 { margin:0 0 .35rem; font-size:1.25rem; letter-spacing:.02em; }
    p { margin:.25rem 0; color:var(--muted); }
    main { max-width:1280px; margin:0 auto; padding:1.5rem; }
    .pair { margin-bottom:2.5rem; }
    .pair-title { display:flex; align-items:center; gap:.75rem; margin-bottom:.7rem; }
    .pair-title h2 { margin:0; font-size:1rem; }
    .pair-id { color:var(--gold); font:700 .75rem ui-monospace,monospace; text-transform:uppercase; }
    .images { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
    .frame { position:relative; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#04070a; }
    .frame img { display:block; width:100%; height:auto; min-height:320px; object-fit:cover; }
    .frame-label { position:absolute; left:.6rem; top:.6rem; padding:.22rem .5rem; border-radius:4px; background:rgba(6,11,15,.72); color:var(--muted); font:700 .72rem ui-monospace,monospace; letter-spacing:.08em; }
    .actions { display:flex; gap:.7rem; margin-top:.8rem; }
    button { border:1px solid var(--line); border-radius:6px; padding:.65rem 1rem; background:rgba(245,240,231,.08); color:var(--ink); font:600 .85rem ui-sans-serif,system-ui,sans-serif; cursor:pointer; }
    button:hover { background:rgba(245,240,231,.16); }
    button:disabled { opacity:.35; cursor:default; }
    .verdict { margin-top:.6rem; font:600 .85rem ui-monospace,monospace; color:var(--teal); }
    .results { margin-top:1rem; padding:1rem; border:1px solid var(--line); border-radius:8px; background:rgba(6,11,15,.55); white-space:pre-wrap; }
    .reveal { margin-left:auto; color:var(--gold); }
    @media (max-width:720px) { .images { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Blind A/B - Real San Francisco vs the Real Map Lab</h1>
    <p>Five pairs. Choose which side looks more like real San Francisco. Sides are shuffled per pair. The JSON verdict below is what you paste back to the build record.</p>
  </header>
  <main id="main"></main>
  <script>
    const pairs = ${JSON.stringify(embedded.map(({ refData, gameData, ...rest }) => rest))};
    const data = ${JSON.stringify(embedded.map(({ id, refData, gameData }) => ({ id, refData, gameData })))};
    const storageKey = 'sf-realmap-blind-ab-v1';
    const saved = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } })();
    const choices = saved.choices || {};
    const order = saved.order || {};
    const main = document.querySelector('#main');

    function render() {
      main.innerHTML = '';
      for (const pair of pairs) {
        if (!order[pair.id]) order[pair.id] = Math.random() < 0.5;
        const section = document.createElement('section');
        section.className = 'pair';
        const title = document.createElement('div');
        title.className = 'pair-title';
        const h2 = document.createElement('h2');
        h2.textContent = pair.label;
        const id = document.createElement('span');
        id.className = 'pair-id';
        id.textContent = pair.id;
        title.append(h2, id);
        section.append(title);
        const images = document.createElement('div');
        images.className = 'images';
        const leftIsRef = order[pair.id];
        const frame = (label, src) => {
          const frameEl = document.createElement('div');
          frameEl.className = 'frame';
          const labelEl = document.createElement('span');
          labelEl.className = 'frame-label';
          labelEl.textContent = label;
          const img = document.createElement('img');
          img.src = src;
          frameEl.append(labelEl, img);
          return frameEl;
        };
        const d = data.find((entry) => entry.id === pair.id);
        images.append(
          frame('A', leftIsRef ? d.refData : d.gameData),
          frame('B', leftIsRef ? d.gameData : d.refData),
        );
        section.append(images);
        const actions = document.createElement('div');
        actions.className = 'actions';
        const a = document.createElement('button');
        a.textContent = 'A looks more like SF';
        a.disabled = Boolean(choices[pair.id]);
        a.addEventListener('click', () => { choices[pair.id] = 'A'; save(); render(); });
        const b = document.createElement('button');
        b.textContent = 'B looks more like SF';
        b.disabled = Boolean(choices[pair.id]);
        b.addEventListener('click', () => { choices[pair.id] = 'B'; save(); render(); });
        const verdict = document.createElement('div');
        verdict.className = 'verdict';
        if (choices[pair.id]) {
          const pickedRef = (choices[pair.id] === 'A') === order[pair.id];
          verdict.textContent = pickedRef ? 'You picked the real San Francisco photo.' : 'You picked the Three.js build.';
        }
        actions.append(a, b, verdict);
        section.append(actions);
        main.append(section);
      }
      const results = document.createElement('section');
      results.className = 'results';
      results.textContent = JSON.stringify({ choices, order }, null, 2);
      main.append(results);
      const reveal = document.createElement('button');
      reveal.className = 'reveal';
      reveal.textContent = 'Reveal labels';
      reveal.addEventListener('click', () => {
        for (const section of document.querySelectorAll('.pair')) {
          const id = section.querySelector('.pair-id').textContent;
          const orderForPair = order[id];
          const labels = section.querySelectorAll('.frame-label');
          labels[0].textContent = orderForPair ? 'A / REAL' : 'A / GAME';
          labels[1].textContent = orderForPair ? 'B / GAME' : 'B / REAL';
        }
        reveal.disabled = true;
      });
      main.append(reveal);
    }

    function save() {
      try { localStorage.setItem(storageKey, JSON.stringify({ choices, order })); } catch {}
    }

    render();
  </script>
</body>
</html>`;

await writeFile(outPath, html);
console.log('saved', outPath);
