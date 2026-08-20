import { readFile, writeFile, access } from 'node:fs/promises';

// Usage: node scripts/build-realmap-blind-ab.mjs
// Builds .qa-realmap-blind-ab.html with five randomized pairs split into two axes:
//   geography — game vs real SF photos (street layout, blocks, landmarks, grades)
//   art       — game vs stylized low-poly references (stylized low-poly reference tier)
// Reports separate geography and art scores.
const args = process.argv.slice(2);
const outPath = args[args.indexOf('--out') + 1] || '.qa-realmap-blind-ab.html';

const pairs = [
  {
    id: 'walking-street',
    label: 'Walking / street life',
    axis: 'geography',
    ref: 'public/data/reference-sf-street.jpg',
    game: '.qa-realmap-street-beauty.png',
  },
  {
    id: 'downtown-canyon',
    label: 'Downtown avenue',
    axis: 'geography',
    ref: 'public/data/reference-sf.jpg',
    game: '.qa-realmap-canyon-beauty.png',
  },
  {
    id: 'hills',
    label: 'San Francisco hills',
    axis: 'geography',
    ref: 'public/data/reference-sf.jpg',
    game: '.qa-realmap-hills-beauty.png',
  },
  {
    id: 'night-city',
    label: 'Night city',
    axis: 'art',
    ref: 'public/data/reference-style-night.jpg',
    game: '.qa-realmap-night-beauty.png',
  },
  {
    id: 'hero-canyon',
    label: 'Skyline / canyon',
    axis: 'art',
    ref: 'public/data/reference-style-skyline.jpg',
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
    header { padding:1.2rem 1.5rem; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; align-items:baseline; gap:.5rem 1.5rem; }
    h1 { margin:0 0 .35rem; font-size:1.25rem; letter-spacing:.02em; flex:1 1 auto; }
    .scoreboard { display:flex; gap:1.2rem; font:700 .82rem ui-monospace,monospace; }
    .scoreboard span { padding:.25rem .55rem; border-radius:4px; }
    .geo-score { background:rgba(107,214,197,.15); color:var(--teal); }
    .art-score { background:rgba(242,181,109,.15); color:var(--gold); }
    p { margin:.25rem 0; color:var(--muted); }
    main { max-width:1280px; margin:0 auto; padding:1.5rem; }
    .pair { margin-bottom:2.5rem; }
    .pair-title { display:flex; align-items:center; gap:.75rem; margin-bottom:.7rem; flex-wrap:wrap; }
    .pair-title h2 { margin:0; font-size:1rem; }
    .pair-id { font:700 .75rem ui-monospace,monospace; text-transform:uppercase; }
    .pair-id.geography { color:var(--teal); }
    .pair-id.art { color:var(--gold); }
    .axis-tag { font:600 .68rem ui-sans-serif,system-ui,sans-serif; padding:.12rem .42rem; border-radius:3px; text-transform:uppercase; letter-spacing:.05em; }
    .axis-tag.geography { background:rgba(107,214,197,.15); color:var(--teal); }
    .axis-tag.art { background:rgba(242,181,109,.15); color:var(--gold); }
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
    .legend { display:flex; gap:1rem; margin-bottom:1.5rem; font-size:.82rem; color:var(--muted); }
    .legend .geo { color:var(--teal); }
    .legend .art { color:var(--gold); }
    @media (max-width:720px) { .images { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Blind A/B &mdash; San Francisco Real Map Lab</h1>
    <div class="scoreboard">
      <span class="geo-score" id="geo-score">Geography: &mdash;</span>
      <span class="art-score" id="art-score">Art: &mdash;</span>
    </div>
    <p>Five pairs split across two axes. Sides are shuffled per pair.</p>
  </header>
  <main id="main">
    <div class="legend">
      <span><span class="geo">&#9632;</span> Geography axis &mdash; pick the side that looks more like real San Francisco (streets, blocks, landmarks, grades).</span>
      <span><span class="art">&#9632;</span> Art axis &mdash; pick the side with better stylized low-poly art (lighting, materials, composition).</span>
    </div>
  </main>
  <script>
    const pairs = ${JSON.stringify(embedded.map(({ refData, gameData, ...rest }) => ({ ...rest, hasRef: true, hasGame: true })))};
    const data = ${JSON.stringify(embedded.map(({ id, refData, gameData, axis }) => ({ id, refData, gameData, axis })))};
    const storageKey = 'sf-realmap-blind-ab-v1';
    const saved = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } })();
    const choices = saved.choices || {};
    const order = saved.order || {};
    const main = document.querySelector('#main');
    const geoScoreEl = document.querySelector('#geo-score');
    const artScoreEl = document.querySelector('#art-score');

    function updateScoreboard() {
      let geoWins = 0;
      let artPicks = 0;
      let geoTotal = 0;
      let artTotal = 0;
      for (const pair of pairs) {
        const d = data.find((entry) => entry.id === pair.id);
        if (!choices[pair.id]) continue;
        const pickedGame = (choices[pair.id] === 'A') !== order[pair.id];
        if (d.axis === 'geography') {
          geoTotal += 1;
          if (pickedGame) geoWins += 1;
        } else {
          artTotal += 1;
          if (pickedGame) artPicks += 1;
        }
      }
      geoScoreEl.textContent = 'Geography: ' + geoWins + '/' + geoTotal + (geoTotal ? ' game-wins' : ' \u2014');
      artScoreEl.textContent = 'Art: ' + artPicks + '/' + artTotal + (artTotal ? ' game-wins' : ' \u2014');
    }

    function render() {
      const removals = main.querySelectorAll('.pair, .results, .reveal');
      removals.forEach((el) => el.remove());
      for (const pair of pairs) {
        if (typeof order[pair.id] !== 'boolean') order[pair.id] = Math.random() < 0.5;
        const d = data.find((entry) => entry.id === pair.id);
        const section = document.createElement('section');
        section.className = 'pair';
        const title = document.createElement('div');
        title.className = 'pair-title';
        const h2 = document.createElement('h2');
        h2.textContent = pair.label;
        const id = document.createElement('span');
        id.className = 'pair-id';
        id.classList.add(d.axis);
        id.textContent = pair.id;
        const axisTag = document.createElement('span');
        axisTag.className = 'axis-tag ' + d.axis;
        axisTag.textContent = d.axis;
        title.append(h2, id, axisTag);
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
        images.append(
          frame('A', leftIsRef ? d.refData : d.gameData),
          frame('B', leftIsRef ? d.gameData : d.refData),
        );
        section.append(images);
        const actions = document.createElement('div');
        actions.className = 'actions';
        const a = document.createElement('button');
        a.textContent = d.axis === 'art' ? 'A has better stylized art' : 'A looks more like real SF';
        a.disabled = Boolean(choices[pair.id]);
        a.addEventListener('click', () => { choices[pair.id] = 'A'; save(); render(); });
        const b = document.createElement('button');
        b.textContent = d.axis === 'art' ? 'B has better stylized art' : 'B looks more like real SF';
        b.disabled = Boolean(choices[pair.id]);
        b.addEventListener('click', () => { choices[pair.id] = 'B'; save(); render(); });
        const verdict = document.createElement('div');
        verdict.className = 'verdict';
        if (choices[pair.id]) {
          const pickedGame = (choices[pair.id] === 'A') !== order[pair.id];
          verdict.textContent = d.axis === 'art'
            ? (pickedGame ? 'You picked the stylized Three.js build.' : 'You picked the stylized reference.')
            : (pickedGame ? 'You picked the Three.js build.' : 'You picked the real San Francisco photo.');
        }
        actions.append(a, b, verdict);
        section.append(actions);
        main.append(section);
      }

      // Build the report
      let geoWins = 0;
      let geoTotal = 0;
      let artPicks = 0;
      let artTotal = 0;
      const geoPairs = [];
      const artPairs = [];
      for (const pair of pairs) {
        const d = data.find((entry) => entry.id === pair.id);
        if (!choices[pair.id]) continue;
        const pickedGame = (choices[pair.id] === 'A') !== order[pair.id];
        const result = { id: pair.id, label: pair.label, pickedGame };
        if (d.axis === 'geography') {
          geoTotal += 1;
          if (pickedGame) geoWins += 1;
          geoPairs.push(result);
        } else {
          artTotal += 1;
          if (pickedGame) artPicks += 1;
          artPairs.push(result);
        }
      }

      const results = document.createElement('section');
      results.className = 'results';
      const report = {
        geography: {
          score: geoTotal ? geoWins + '/' + geoTotal + ' game-wins' : 'no votes',
          gameWins: geoWins,
          total: geoTotal,
          pairs: geoPairs,
        },
        art: {
          score: artTotal ? artPicks + '/' + artTotal + ' game-wins' : 'no votes',
          gameWins: artPicks,
          total: artTotal,
          pairs: artPairs,
        },
        choices,
        order,
      };
      results.textContent = JSON.stringify(report, null, 2);
      main.append(results);
      const reveal = document.createElement('button');
      reveal.className = 'reveal';
      reveal.textContent = 'Reveal labels';
      reveal.addEventListener('click', () => {
        for (const section of document.querySelectorAll('.pair')) {
          const id = section.querySelector('.pair-id').textContent;
          const orderForPair = order[id];
          const labels = section.querySelectorAll('.frame-label');
          const d = data.find((entry) => entry.id === id);
          if (d.axis === 'art') {
            labels[0].textContent = orderForPair ? 'A / REF' : 'A / GAME';
            labels[1].textContent = orderForPair ? 'B / GAME' : 'B / REF';
          } else {
            labels[0].textContent = orderForPair ? 'A / REAL' : 'A / GAME';
            labels[1].textContent = orderForPair ? 'B / GAME' : 'B / REAL';
          }
        }
        reveal.disabled = true;
      });
      main.append(reveal);

      updateScoreboard();
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
console.log(JSON.stringify({
  pairs: pairs.map((p) => ({ id: p.id, label: p.label, axis: p.axis })),
  geographyPairs: pairs.filter((p) => p.axis === 'geography').length,
  artPairs: pairs.filter((p) => p.axis === 'art').length,
}, null, 2));
