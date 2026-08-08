import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Harsh gate: frames must be rich, varied, colorful, and structurally sound;
// metadata must prove one-way streets, signals, and building data exist.
const frames = [
  { file: '.qa-citygen-hero.png', name: 'hero', minEdge: 0.3, minSat: 55 },
  { file: '.qa-citygen-street.png', name: 'street', minEdge: 0.2, minSat: 60 },
  { file: '.qa-citygen-aerial.png', name: 'aerial', minEdge: 0.35, minSat: 55 },
  { file: '.qa-citygen-night.png', name: 'night', minEdge: 0.18, minSat: 60 },
];

const critic = {
  result: 'PASS',
  score: 0,
  maxScore: 0,
  frames: [],
  metadata: null,
  blockers: [],
  notes: [],
};

try {
  const results = JSON.parse(await readFile('.qa-citygen-results.json', 'utf8'));
  critic.metadata = results.state;
  const checks = [
    ['buildings >= 150', (results.state?.buildings || 0) >= 150],
    ['blocks >= 40', (results.state?.blocks || 0) >= 40],
    ['streets >= 12', (results.state?.streets || 0) >= 12],
    ['signals >= 5', (results.state?.signals || 0) >= 5],
    ['one-way metadata present', (results.state?.oneWayStreets || 0) > 0],
    ['street metadata has oneway/lanes/sidewalk', Boolean(results.state?.streetMeta?.oneway && results.state?.streetMeta?.lanes && results.state?.streetMeta?.sidewalkW)],
    ['signal metadata has phase/streets', Boolean(results.state?.signalMeta?.period && results.state?.signalMeta?.streetIds?.length >= 2)],
    ['street width is full-size (avg >= 11m)', Number(results.state?.avgStreetWidth || 0) >= 11],
    ['building massing reads urban (avg >= 14m)', Number(results.state?.avgBuildingHeight || 0) >= 14],
    ['no fatal page errors', !(results.errors || []).some((error) => error.includes('Uncaught') || error.includes('TypeError') || error.includes('ReferenceError'))],
    ['no NaN geometry warnings', !(results.errors || []).some((error) => error.includes('NaN'))],
    ['Three.js r180 package active', results.capture?.threeRevision === 180],
    ['Three WebGLRenderer active', results.runtime?.rendererType === 'WebGLRenderer'],
    ['WebGL2 renderer active', results.state?.webgl2 === true && /^WebGL 2\.0/.test(results.runtime?.webglVersion || '')],
    ['walk physics moves the player', Number(results.walkPhysics?.moved || 0) > 0.5],
    ['drive mode enters a vehicle', results.drivePhysics?.entered === true],
    ['drive physics moves the vehicle', Number(results.drivePhysics?.moved || 0) > 1],
    ['sidewalk pedestrians exist', Number(results.state?.pedestrians || 0) >= 12],
    ['sidewalk pedestrians move', Number(results.pedestrianPhysics?.moved || 0) > 0.05],
    ['sandbox clock advances', Number(results.clockEnd || 0) > Number(results.clockStart || 0)],
    ['sandbox clock drives night', Boolean(Number(results.clockNight?.clock || 0) >= 21.4 && Number(results.clockNight?.clock || 0) <= 22 && results.clockNight?.day === false && results.clockNight?.timeLabel === 'Night')],
    ['building sandbox pays cash', Number(results.sandboxAfterBuild?.cash || 0) > Number(results.sandboxStartCash || 0)],
    ['building sandbox tracks blocks', Number(results.sandboxAfterBuild?.buildingsPlaced || 0) >= 1 && Number(results.sandboxAfterBuild?.blocksTouched || 0) >= 1],
    ['export metadata matches city counts', Boolean(results.export)
      && results.export.counts?.buildings === results.state?.buildings
      && results.export.counts?.streets === results.state?.streets
      && results.export.counts?.signals === results.state?.signals],
    ['export includes street metadata', Boolean(results.export?.streetSample?.oneway && results.export?.streetSample?.sidewalkW && results.export?.streetSample?.asphaltWidth)],
    ['export includes building metadata', Boolean(results.export?.buildingSample?.blockId && results.export?.buildingSample?.material && results.export?.buildingSample?.facade)],
    ['export/import round-trip preserves counts', results.importRoundtrip?.ok === true],
  ];
  for (const [label, pass] of checks) {
    critic.maxScore += 1;
    if (pass) critic.score += 1;
    else {
      critic.blockers.push(label);
      critic.notes.push(`FAIL ${label}`);
    }
  }
  if (results.placementPlan?.ok) {
    const placed = results.placement;
    const last = placed?.lastAdded;
    const placedChecks = [
      ['dynamic add places a building', placed?.placed === true && placed?.placedBuildings >= 1],
      ['added building carries block metadata', Boolean(last?.blockId && last?.district && last?.typeLabel)],
      ['added building carries street metadata', Boolean(last?.facingStreet && last?.address)],
      ['added building carries visual metadata', Boolean(last?.material && last?.facade && last?.height && last?.stories)],
      ['undo restores original building count', results.afterUndo?.buildings === results.state?.buildings && results.afterUndo?.placedBuildings === 0],
    ];
    for (const [label, pass] of placedChecks) {
      critic.maxScore += 1;
      if (pass) critic.score += 1;
      else {
        critic.blockers.push(label);
        critic.notes.push(`FAIL ${label}`);
      }
    }
    const placedFrame = results.frames?.['.qa-citygen-placed.png'] || {};
    const placedFrameChecks = [
      ['placed frame non-blank', (placedFrame.nonBlankRatio || 0) >= 0.98],
      ['placed frame exposure', (placedFrame.meanLuma || 0) > 60 && (placedFrame.meanLuma || 0) < 230],
      ['placed frame structure', (placedFrame.edgeDensity || 0) >= 0.1],
    ];
    for (const [label, pass] of placedFrameChecks) {
      critic.maxScore += 1;
      if (pass) critic.score += 1;
      else critic.notes.push(`placed/${label}`);
    }
  }
  const sf = results.sfBuiltin;
  if (!sf) {
    critic.maxScore += 1;
    critic.blockers.push('real SF built-in capture missing');
    critic.notes.push('FAIL real SF built-in capture missing (run qa-citygen without SF_QA_SF_BUILTIN=0)');
  } else {
    critic.maxScore += 1;
    const sfPass = sf.buildings >= 500 && sf.signals >= 5 && sf.streets >= 1000;
    if (sfPass) critic.score += 1;
    else {
      critic.blockers.push('real SF metadata');
      critic.notes.push(`FAIL real SF metadata: ${sf.buildings} buildings / ${sf.signals} signals / ${sf.streets} streets`);
    }
  }

  for (const frame of frames) {
    const metrics = results.frames?.[frame.file] || {};
    const row = { name: frame.name, file: frame.file, ...metrics, passes: 0, checks: 0 };
    const values = [
      ['non-blank', (metrics.nonBlankRatio || 0) >= 0.98, `${((metrics.nonBlankRatio || 0) * 100).toFixed(1)}%`],
      ['exposure', (metrics.meanLuma || 0) > 60 && (metrics.meanLuma || 0) < 230, `${Math.round(metrics.meanLuma || 0)} luma`],
      ['color', (metrics.meanSaturation || 0) >= frame.minSat, `${Math.round(metrics.meanSaturation || 0)} sat`],
      ['structure', (metrics.edgeDensity || 0) >= frame.minEdge, `${(metrics.edgeDensity || 0).toFixed(3)} edges`],
      ['variety', (metrics.saturatedHues || 0) >= 4, `${metrics.saturatedHues || 0} hues`],
    ];
    for (const [label, pass, detail] of values) {
      row.checks += 1;
      if (pass) row.passes += 1;
      else critic.notes.push(`${frame.name}/${label}: ${detail}`);
    }
    critic.maxScore += row.checks;
    critic.score += row.passes;
    critic.frames.push(row);
  }

  const sfFrame = results.frames?.['.qa-citygen-sf.png'] || {};
  if (results.sfBuiltin) {
    const sfChecks = [
      ['real SF frame is not boxed or low visibility', results.sfCapture?.acceptable === true, results.sfCapture?.selected || 'no selected frame'],
      ['real SF frame non-blank', (sfFrame.nonBlankRatio || 0) >= 0.98, `${((sfFrame.nonBlankRatio || 0) * 100).toFixed(1)}%`],
      ['real SF frame exposure', (sfFrame.meanLuma || 0) > 60 && (sfFrame.meanLuma || 0) < 230, `${Math.round(sfFrame.meanLuma || 0)} luma`],
      ['real SF frame structure', (sfFrame.edgeDensity || 0) >= 0.25, `${(sfFrame.edgeDensity || 0).toFixed(3)} edges`],
      ['real SF frame color', (sfFrame.meanSaturation || 0) >= 55 && (sfFrame.saturatedHues || 0) >= 8, `${Math.round(sfFrame.meanSaturation || 0)} sat / ${sfFrame.saturatedHues || 0} hues`],
      ['real SF frame hue variety', (sfFrame.saturatedHues || 0) >= 8, `${sfFrame.saturatedHues || 0} hues`],
    ];
    critic.maxScore += sfChecks.length;
    for (const [label, pass, detail] of sfChecks) {
      if (pass) critic.score += 1;
      else {
        critic.blockers.push(label);
        critic.notes.push(`real SF/${label}: ${detail}`);
      }
    }
    if (results.sfPlacementPlan?.ok) {
      const placed = results.sfPlacement;
      const last = placed?.lastAdded;
      const sfAuthoringChecks = [
        ['real SF dynamic add places a building', placed?.placedBuildings >= 1 && placed?.buildings === results.sfBuiltin.buildings + 1],
        ['real SF added building carries street metadata', Boolean(last?.blockId && last?.facingStreet && last?.address && last?.typeLabel && last?.material && last?.facade)],
        ['real SF undo restores original building count', results.sfAfterUndo?.buildings === results.sfBuiltin.buildings && results.sfAfterUndo?.placedBuildings === 0],
      ];
      for (const [label, pass] of sfAuthoringChecks) {
        critic.maxScore += 1;
        if (pass) critic.score += 1;
        else {
          critic.blockers.push(label);
          critic.notes.push(`FAIL ${label}`);
        }
      }
    }
    if (results.sfExport) {
      critic.maxScore += 5;
      const sfExportChecks = [
        ['real SF export carries real street names', results.sfExport.streets === results.sfBuiltin.streets && Boolean(results.sfExport.streetSample?.name)],
        ['real SF export includes one-way metadata', results.sfExport.oneWayStreets === results.sfBuiltin.oneWayStreets],
        ['real SF street has sidewalk props', Number(results.sfBuiltin?.furniture?.props || 0) >= 120],
        ['real SF street has parked cars', Number(results.sfBuiltin?.furniture?.cars || 0) >= 60],
        ['real SF export/import round-trip preserves counts', results.sfImportRoundtrip?.ok === true],
      ];
      for (const [label, pass] of sfExportChecks) {
        if (pass) critic.score += 1;
        else {
          critic.blockers.push(label);
          critic.notes.push(`FAIL ${label}`);
        }
      }
    }
  }

  critic.score = Math.round((critic.score / critic.maxScore) * 1000) / 10;
  if (critic.blockers.length || critic.score < 82) {
    critic.result = 'FAIL';
  }

  const criticOut = {
    result: critic.result,
    score: critic.score,
    frames: critic.frames.map(({ name, passes, checks, nonBlankRatio, meanLuma, meanSaturation, edgeDensity, saturatedHues }) => ({
      name,
      passes: `${passes}/${checks}`,
      nonBlankRatio,
      meanLuma,
      meanSaturation,
      edgeDensity,
      saturatedHues,
    })),
    metadata: {
      buildings: critic.metadata?.buildings,
      blocks: critic.metadata?.blocks,
      streets: critic.metadata?.streets,
      oneWayStreets: critic.metadata?.oneWayStreets,
      signals: critic.metadata?.signals,
    },
    notes: critic.notes,
  };
  await writeFile('.qa-citygen-harsh.json', JSON.stringify(criticOut, null, 2));
  console.log(JSON.stringify(criticOut, null, 2));
  process.exitCode = critic.result === 'PASS' ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ result: 'CRITIC FAILED', error: error.message }, null, 2));
  process.exitCode = 2;
}
