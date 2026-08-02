import './styles.css';

const HUD_DATA_ATTRIBUTE = 'data-hud';
const FPS_WINDOW_SECONDS = 2;
const FPS_STABLE_WINDOW_SECONDS = 0.8;
const SIMULATION_START_HOUR = 7;
const SIMULATION_HOURS_PER_SECOND = 0.033;

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);

  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;

  return element;
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const number = typeof value === 'number' ? value : Number(value);

    if (Number.isFinite(number)) return number;
  }

  return null;
}

function readEntityCount(source, type) {
  if (source === null || source === undefined) return null;

  if (typeof source === 'function') {
    try {
      return readEntityCount(source(), type);
    } catch {
      return null;
    }
  }

  if (typeof source === 'number') return Number.isFinite(source) ? source : null;
  if (Array.isArray(source)) return source.length;
  if (source instanceof Set || source instanceof Map) return source.size;

  if (typeof source !== 'object') return null;

  const countMethods = type === 'traffic'
    ? ['getVehicleCount', 'getTrafficCount', 'getActiveCount', 'getStats', 'getCount']
    : ['getPedestrianCount', 'getWalkerCount', 'getActiveCount', 'getStats', 'getCount'];

  for (const methodName of countMethods) {
    if (typeof source[methodName] === 'function') {
      try {
        const count = readEntityCount(source[methodName](), type);
        if (count !== null) return count;
      } catch {
        // A telemetry read should never interrupt the simulation loop.
      }
    }
  }

  const directKeys = ['count', 'length', 'total', 'active', 'activeCount'];
  for (const key of directKeys) {
    const count = firstFiniteNumber([source[key]]);
    if (count !== null) return count;
  }

  const nestedKeys = type === 'traffic'
    ? ['vehicles', 'cars', 'agents', 'entities', 'items']
    : ['pedestrians', 'walkers', 'people', 'agents', 'entities', 'items'];

  for (const key of nestedKeys) {
    const count = readEntityCount(source[key], type);
    if (count !== null) return count;
  }

  return null;
}

function readSystemStats(source) {
  if (!source) return {};

  if (typeof source.getStats === 'function') {
    try {
      const stats = source.getStats();
      if (stats && typeof stats === 'object') return stats;
    } catch {
      // HUD telemetry is optional and must not interrupt the simulation loop.
    }
  }

  return source.stats && typeof source.stats === 'object' ? source.stats : {};
}

function readRendererFps(renderer) {
  if (!renderer) return null;

  return firstFiniteNumber([
    renderer.fps,
    renderer.stats?.fps,
    renderer.info?.render?.fps,
    renderer.performance?.fps,
  ]);
}

function normalizeDelta(delta) {
  const value = Number(delta);

  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1 ? value / 1000 : value;
}

function formatCount(value) {
  return value === null ? '—' : String(Math.max(0, Math.round(value))).padStart(2, '0');
}

function formatFps(value) {
  return value === null ? 'MEASURING' : `${Math.round(value)} FPS AVG`;
}

function formatTrafficDetail(stats) {
  const speed = firstFiniteNumber([stats.avgSpeed]);
  const signal = typeof stats.signalPhase === 'string' ? stats.signalPhase.toUpperCase() : '—';
  const speedLabel = speed === null ? 'AVG SPEED / —' : `AVG SPEED / ${speed.toFixed(1)} M/S`;
  return `${speedLabel} · SIGNAL / ${signal}`;
}

function formatPedestrianDetail(stats) {
  const walking = firstFiniteNumber([stats.walking]);
  const working = firstFiniteNumber([stats.working]);
  const crossing = firstFiniteNumber([stats.crossing]);
  const walkingLabel = walking === null ? 'WALK / —' : `WALK / ${Math.max(0, Math.round(walking))}`;
  const workingLabel = working === null ? 'WORK / —' : `WORK / ${Math.max(0, Math.round(working))}`;
  const crossingLabel = crossing === null ? 'CROSS / —' : `CROSS / ${Math.max(0, Math.round(crossing))}`;
  return `${walkingLabel} · ${workingLabel} · ${crossingLabel}`;
}

function simulationDayHour(elapsed) {
  const seconds = Number(elapsed);
  const rawHour = SIMULATION_START_HOUR
    + (Number.isFinite(seconds) ? seconds : 0) * SIMULATION_HOURS_PER_SECOND;
  return ((rawHour % 24) + 24) % 24;
}

function formatClockTime(dayHour) {
  let hour = Math.floor(dayHour);
  let minute = Math.round((dayHour - hour) * 60);

  if (minute >= 60) {
    hour = (hour + 1) % 24;
    minute = 0;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function beatLabelForHour(dayHour) {
  if (dayHour >= 7 && dayHour < 10) return 'Morning rush';
  if (dayHour >= 16 && dayHour < 20) return 'Evening rush';
  if (dayHour >= 20 && dayHour < 23) return 'Night';
  if (dayHour >= 23 || dayHour < 5) return 'Late night';
  return 'Midday';
}

function formatLifeBeat(schedule, elapsed) {
  const scheduledHour = firstFiniteNumber([schedule?.dayHour]);
  const dayHour = scheduledHour === null ? simulationDayHour(elapsed) : scheduledHour;
  const label = String(schedule?.beatLabel || beatLabelForHour(dayHour)).trim();
  return `${formatClockTime(dayHour)} · ${label || 'City rhythm'}`;
}

function formatLifeCue(trafficStats, pedestrianStats) {
  const peopleMoving = firstFiniteNumber([
    pedestrianStats?.walking,
    pedestrianStats?.moving,
  ]);
  if (peopleMoving !== null && peopleMoving > 0) {
    return `PEOPLE / ${Math.max(0, Math.round(peopleMoving))} MOVING`;
  }

  const vehiclesMoving = firstFiniteNumber([
    trafficStats?.moving,
    trafficStats?.active,
  ]);
  if (vehiclesMoving !== null && vehiclesMoving > 0) {
    return `VEHICLES / ${Math.max(0, Math.round(vehiclesMoving))} MOVING`;
  }

  const speed = firstFiniteNumber([trafficStats?.avgSpeed]);
  if (speed !== null) return `ROAD / ${speed.toFixed(1)} M/S`;
  return 'CITY / IN MOTION';
}

function getQuality(value) {
  if (value === null) return 'unknown';
  if (value >= 54) return 'high';
  if (value >= 30) return 'medium';
  return 'low';
}

export function createHud({
  renderer,
  camera,
  traffic,
  pedestrians,
  streamedAgents,
  streaming,
  city,
  quality: initialQuality,
  onQualityChange,
  onInteraction,
  onTouchMove,
  onRestartGame,
} = {}) {
  if (typeof document === 'undefined' || !document.body) {
    throw new Error('createHud requires a document body.');
  }

  const root = createElement('aside', 'hud hud--cinematic');
  root.setAttribute(HUD_DATA_ATTRIBUTE, 'san-francisco');
  root.dataset.telemetry = 'compact';
  root.setAttribute('aria-label', 'San Francisco traffic simulation HUD');

  const header = createElement('header', 'hud__header');
  const identity = createElement('div', 'hud__identity');
  const eyebrow = createElement('p', 'hud__eyebrow', 'CITY / 01 — PACIFIC TIME');
  const title = createElement('h1', 'hud__title', 'San Francisco');
  identity.append(eyebrow, title);

  const context = createElement('section', 'hud__context');
  context.setAttribute('aria-label', 'Current district and activity');
  context.dataset.mode = 'district';
  const contextLabel = createElement('span', 'hud__context-label', 'District');
  const contextDistrict = createElement('strong', 'hud__context-district', 'Core district');
  const contextActivity = createElement(
    'span',
    'hud__context-activity',
    'Activity / Morning rush · People / in motion',
  );
  context.append(contextLabel, contextDistrict, contextActivity);

  const route = createElement('nav', 'hud__route');
  route.setAttribute('aria-label', 'Current route');
  const routeMeta = createElement('span', 'hud__route-meta', 'Route');
  const routeList = createElement('ol', 'hud__route-list');
  ['Mission', 'Downtown', 'Embarcadero'].forEach((label, index, labels) => {
    const item = createElement('li', 'hud__route-item');
    const itemLabel = createElement('span', 'hud__route-label', label);

    if (index === labels.length - 1) itemLabel.setAttribute('aria-current', 'page');

    item.append(itemLabel);
    routeList.append(item);
  });
  route.append(routeMeta, routeList);
  header.append(identity, context, route);

  const mission = createElement('section', 'hud__mission');
  mission.setAttribute('aria-label', 'City Shift objectives');
  mission.dataset.status = 'ready';
  const missionHeader = createElement('div', 'hud__mission-header');
  const missionKicker = createElement('span', 'hud__mission-kicker', 'CITY SHIFT / DAY 01');
  const missionTag = createElement('span', 'hud__mission-tag', 'READY');
  missionHeader.append(missionKicker, missionTag);
  const missionTitle = createElement('h2', 'hud__mission-title', 'The Waterfront Loop');
  const missionObjective = createElement(
    'p',
    'hud__mission-objective',
    'Enter the city to begin your first route.',
  );
  const missionHint = createElement(
    'p',
    'hud__mission-hint',
    'Follow the amber beacon through the living district.',
  );
  const missionMeta = createElement('div', 'hud__mission-meta');
  const missionDistance = createElement('span', 'hud__mission-distance', 'DISTANCE / —');
  const missionScore = createElement('span', 'hud__mission-score', 'SCORE / 0000');
  const missionClock = createElement('span', 'hud__mission-clock', 'SHIFT / 00:00');
  missionMeta.append(missionDistance, missionScore, missionClock);
  const missionProgress = createElement('div', 'hud__mission-progress');
  missionProgress.setAttribute('role', 'progressbar');
  missionProgress.setAttribute('aria-label', 'Waterfront loop progress');
  missionProgress.setAttribute('aria-valuemin', '0');
  missionProgress.setAttribute('aria-valuemax', '100');
  missionProgress.setAttribute('aria-valuenow', '0');
  const missionProgressFill = createElement('span', 'hud__mission-progress-fill');
  missionProgress.append(missionProgressFill);
  const missionList = createElement('ol', 'hud__mission-list');
  missionList.setAttribute('aria-label', 'Waterfront loop steps');
  const missionRestart = createElement('button', 'hud__mission-restart', 'Replay shift');
  missionRestart.type = 'button';
  missionRestart.hidden = true;
  missionRestart.addEventListener('click', () => onRestartGame?.());
  mission.append(
    missionHeader,
    missionTitle,
    missionObjective,
    missionHint,
    missionMeta,
    missionProgress,
    missionList,
    missionRestart,
  );

  const mapOverlay = createElement('section', 'hud__map');
  mapOverlay.setAttribute('aria-label', 'Live district map');
  mapOverlay.setAttribute('role', 'dialog');
  mapOverlay.setAttribute('aria-modal', 'false');
  mapOverlay.hidden = true;
  const mapPanel = createElement('div', 'hud__map-panel');
  const mapHeader = createElement('header', 'hud__map-header');
  const mapKicker = createElement('span', 'hud__map-kicker', 'LIVE CITY GRID');
  const mapTitle = createElement('h2', 'hud__map-title', 'District map');
  const mapClose = createElement('button', 'hud__map-close', 'Close');
  mapClose.type = 'button';
  mapClose.setAttribute('aria-label', 'Close district map');
  mapHeader.append(mapKicker, mapTitle, mapClose);
  const mapGrid = createElement('div', 'hud__map-grid');
  mapGrid.setAttribute('aria-label', 'Schematic district map');
  const mapDistricts = [
    ['Mission', 18, 75],
    ['Civic Center', 31, 53],
    ['Downtown', 51, 54],
    ['North Beach', 67, 33],
    ['Embarcadero', 78, 58],
    ['Pacific Heights', 19, 18],
  ];
  const mapDistrictNodes = new Map();
  mapDistricts.forEach(([label, left, top]) => {
    const node = createElement('span', 'hud__map-node', label);
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
    mapDistrictNodes.set(label, node);
    mapGrid.append(node);
  });
  const mapPlayer = createElement('span', 'hud__map-player', 'YOU');
  mapPlayer.setAttribute('aria-hidden', 'true');
  mapGrid.append(mapPlayer);
  const mapFooter = createElement('div', 'hud__map-footer');
  const mapSector = createElement('span', 'hud__map-sector', 'SECTOR / 0:0');
  const mapPopulation = createElement('span', 'hud__map-population', 'LIVE / 36 CARS · 48 PEOPLE');
  const mapWeather = createElement('span', 'hud__map-weather', 'WEATHER / CLEAR');
  mapFooter.append(mapSector, mapPopulation, mapWeather);
  const mapHint = createElement('p', 'hud__map-hint', 'M / CLOSE MAP · AMBER BEACON / ACTIVE SHIFT OBJECTIVE');
  mapPanel.append(mapHeader, mapGrid, mapFooter, mapHint);
  mapOverlay.append(mapPanel);

  const telemetry = createElement('section', 'hud__telemetry');
  telemetry.setAttribute('aria-label', 'Live simulation telemetry');
  telemetry.dataset.mode = 'compact';
  const telemetryHeading = createElement('h2', 'hud__sr-only', 'Live simulation telemetry');
  const telemetryBar = createElement('div', 'hud__telemetry-bar');
  const telemetryTitle = createElement('span', 'hud__telemetry-title', 'City pulse');
  const telemetryActions = createElement('div', 'hud__telemetry-actions');
  const telemetryToggle = createElement('button', 'hud__telemetry-toggle');
  telemetryToggle.type = 'button';
  telemetryToggle.setAttribute('aria-expanded', 'false');
  telemetryToggle.setAttribute('aria-label', 'Show full telemetry details');
  const telemetryToggleLabel = createElement('span', 'hud__disclosure-label', 'Details');
  const telemetryToggleState = createElement('span', 'hud__disclosure-value', 'Compact');
  telemetryToggle.append(telemetryToggleLabel, telemetryToggleState);

  const qualityToggle = createElement('button', 'hud__quality-toggle');
  qualityToggle.type = 'button';
  qualityToggle.setAttribute('aria-expanded', 'false');
  qualityToggle.setAttribute('aria-label', 'Show render quality options');
  const qualityToggleLabel = createElement('span', 'hud__disclosure-label', 'Quality');
  const qualityToggleValue = createElement('span', 'hud__disclosure-value', 'Auto');
  qualityToggle.append(qualityToggleLabel, qualityToggleValue);
  telemetryActions.append(telemetryToggle, qualityToggle);
  telemetryBar.append(telemetryTitle, telemetryActions);
  const metrics = createElement('div', 'hud__metrics');
  metrics.id = 'hud-telemetry-metrics';
  telemetryToggle.setAttribute('aria-controls', metrics.id);

  const trafficMetric = createElement('article', 'hud__metric');
  trafficMetric.setAttribute('data-metric', 'traffic');
  const trafficLabel = createElement('span', 'hud__metric-label', 'Road flow');
  const trafficValue = createElement('output', 'hud__metric-value', '—');
  trafficValue.setAttribute('aria-label', 'Active vehicles');
  const trafficDetail = createElement('span', 'hud__metric-detail', 'AVG SPEED / — · SIGNAL / —');
  trafficMetric.append(trafficLabel, trafficValue, trafficDetail);

  const pedestrianMetric = createElement('article', 'hud__metric');
  pedestrianMetric.setAttribute('data-metric', 'pedestrians');
  const pedestrianLabel = createElement('span', 'hud__metric-label', 'People nearby');
  const pedestrianValue = createElement('output', 'hud__metric-value', '—');
  pedestrianValue.setAttribute('aria-label', 'Active pedestrians');
  const pedestrianDetail = createElement(
    'span',
    'hud__metric-detail',
    'WALK / — · WORK / — · CROSS / —',
  );
  pedestrianMetric.append(pedestrianLabel, pedestrianValue, pedestrianDetail);

  metrics.append(trafficMetric, pedestrianMetric);

  const quality = createElement('div', 'hud__quality status-chip');
  quality.setAttribute('data-quality', 'unknown');
  quality.setAttribute('aria-label', 'Rendering performance');
  const qualityDot = createElement('span', 'hud__quality-dot');
  qualityDot.setAttribute('aria-hidden', 'true');
  const qualityLabel = createElement('span', 'hud__quality-label', 'AUTO / MEASURING');
  quality.append(qualityDot, qualityLabel);

  const renderControls = createElement('section', 'hud__render-controls');
  renderControls.id = 'hud-render-quality-controls';
  renderControls.dataset.open = 'false';
  renderControls.setAttribute('aria-hidden', 'true');
  renderControls.inert = true;
  qualityToggle.setAttribute('aria-controls', renderControls.id);
  renderControls.setAttribute('aria-label', 'Render quality');
  const renderHeading = createElement('span', 'hud__render-heading', 'Render quality');
  const renderOptions = createElement('div', 'hud__render-options');
  renderOptions.setAttribute('role', 'group');
  renderOptions.setAttribute('aria-label', 'Choose a render quality mode');
  const qualityButtons = new Map();
  const qualityModes = [
    ['auto', 'Auto'],
    ['balanced', 'Balanced'],
    ['cinematic', 'Cinema'],
  ];
  qualityModes.forEach(([mode, label]) => {
    const button = createElement('button', 'hud__render-option', label);
    button.type = 'button';
    button.dataset.qualityMode = mode;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      onQualityChange?.(mode);
      setQualityControlsOpen(false);
    });
    qualityButtons.set(mode, button);
    renderOptions.append(button);
  });
  const qualityMeta = createElement('span', 'hud__quality-meta', 'ADAPTIVE · CLEAN');
  renderControls.append(renderHeading, renderOptions, qualityMeta);
  telemetry.append(telemetryHeading, telemetryBar, metrics, quality, renderControls);

  const state = createElement('section', 'hud__state');
  state.setAttribute('aria-label', 'Simulation state');
  const stateMode = createElement('span', 'status-chip status-chip--active', 'MODE / FREE ROAM');
  stateMode.setAttribute('data-state', 'mode');
  stateMode.setAttribute('aria-label', 'Mode: free roam');
  const stateTime = createElement('span', 'status-chip status-chip--warm', 'WEATHER / CLEAR');
  stateTime.setAttribute('data-state', 'time');
  stateTime.setAttribute('aria-label', 'Weather: clear');
  const entryCount = city?.stats?.featuredInteriors ?? null;
  const stateEntry = createElement(
    'span',
    'status-chip status-chip--entry',
    `ENTRY / ${entryCount === null ? '—' : entryCount} FEATURED`,
  );
  stateEntry.setAttribute('data-state', 'entry');
  stateEntry.setAttribute(
    'aria-label',
    `Enterable featured interiors: ${entryCount === null ? 'unknown' : entryCount}`,
  );
  const stateLife = createElement(
    'span',
    'status-chip status-chip--active hud__state-life',
  );
  stateLife.setAttribute('data-state', 'life');
  const stateLifeLabel = createElement('span', 'status-chip__label', 'LIFE');
  const stateLifeDistrict = createElement('span', 'status-chip__value', 'CORE DISTRICT');
  const stateLifeBeat = createElement(
    'span',
    'status-chip__detail',
    '07:00 · MORNING RUSH · PEOPLE / IN MOTION',
  );
  stateLife.append(stateLifeLabel, stateLifeDistrict, stateLifeBeat);
  stateLife.setAttribute(
    'aria-label',
    'District: core district. Schedule: 07:00, morning rush. Activity: people in motion.',
  );
  state.append(stateMode, stateTime, stateEntry, stateLife);

  const interaction = createElement('button', 'hud__interaction');
  interaction.type = 'button';
  interaction.addEventListener('click', () => onInteraction?.());
  interaction.hidden = true;
  const interactionLabel = createElement('span', 'hud__interaction-label');
  const interactionPrompt = createElement('span', 'hud__interaction-prompt');
  const interactionHint = createElement('span', 'hud__sr-only', '');
  interactionHint.id = 'hud-interaction-hint';
  interaction.setAttribute('aria-describedby', interactionHint.id);
  interaction.setAttribute('aria-keyshortcuts', 'E');
  interaction.append(interactionLabel, interactionPrompt, interactionHint);

  const message = createElement('p', 'hud__message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.hidden = true;

  const footer = createElement('footer', 'hud__footer');
  const controls = createElement('ul', 'hud__controls');
  const isCoarsePointer = typeof window !== 'undefined'
    && window.matchMedia?.('(pointer: coarse)').matches;
  const controlHints = isCoarsePointer
    ? [
      ['DRAG', 'orbit'],
      ['PINCH', 'frame'],
      ['TAP', 'focus scene'],
    ]
    : [
      ['W A S D', 'move'],
      ['MOUSE', 'look'],
      ['E', 'enter'],
      ['M', 'map'],
      ['ESC', 'release cursor'],
    ];
  controlHints.forEach(([key, label]) => {
    const item = createElement('li', 'hud__control');
    const keyElement = createElement('kbd', 'hud__key', key);
    const labelElement = createElement('span', 'hud__control-label', label);
    item.append(keyElement, labelElement);
    controls.append(item);
  });
  const cameraHint = createElement('span', 'hud__camera', camera ? 'CAM / ROAM' : 'CAM / —');
  footer.append(controls, cameraHint);

  const touchControls = createElement('section', 'hud__touch-controls');
  touchControls.setAttribute('aria-label', 'Touch movement controls');
  const touchDirections = [
    ['up', '▲', 'Move forward', 'KeyW'],
    ['left', '◀', 'Move left', 'KeyA'],
    ['down', '▼', 'Move back', 'KeyS'],
    ['right', '▶', 'Move right', 'KeyD'],
  ];
  touchDirections.forEach(([direction, label, ariaLabel, code]) => {
    const button = createElement('button', `hud__touch-button hud__touch-button--${direction}`, label);
    button.type = 'button';
    button.setAttribute('aria-label', ariaLabel);
    const setPressed = (pressed) => onTouchMove?.(code, pressed);
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      setPressed(true);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((eventName) => {
      button.addEventListener(eventName, () => setPressed(false));
    });
    touchControls.append(button);
  });
  const touchEnter = createElement('button', 'hud__touch-button hud__touch-button--enter', 'E');
  touchEnter.type = 'button';
  touchEnter.setAttribute('aria-label', 'Enter or exit building');
  touchEnter.addEventListener('click', () => onInteraction?.());
  touchControls.append(touchEnter);

  root.append(header, mission, telemetry, state, interaction, message, footer, touchControls, mapOverlay);
  const mountPoint = document.querySelector('#hud-root') || document.body;
  mountPoint.append(root);

  let disposed = false;
  let telemetryMode = 'compact';
  let qualityControlsOpen = false;
  let rollingFps = null;
  let fpsWindowAge = 0;
  let fpsWeightedTotal = 0;
  let fpsState = 'measuring';
  const fpsSamples = [];
  let qualityMode = 'auto';
  let qualityScale = null;
  let qualityEffects = false;
  let lastCameraLabel = '';
  let lastDistrict = 'Core district';
  let lastBeat = '07:00 · Morning rush';
  let lastCue = 'People / in motion';
  let telemetryAccumulator = 0;
  const missionStepNodes = new Map();
  let mapOpen = false;

  function setTelemetryMode(mode = 'compact') {
    if (disposed) return;

    telemetryMode = mode === 'expanded' ? 'expanded' : 'compact';
    const expanded = telemetryMode === 'expanded';
    root.dataset.telemetry = telemetryMode;
    telemetry.dataset.mode = telemetryMode;
    telemetryToggle.setAttribute('aria-expanded', String(expanded));
    telemetryToggle.setAttribute(
      'aria-label',
      expanded ? 'Show compact telemetry' : 'Show full telemetry details',
    );
    telemetryToggleState.textContent = expanded ? 'Full' : 'Compact';
  }

  function setQualityControlsOpen(open) {
    if (disposed) return;

    qualityControlsOpen = Boolean(open);
    renderControls.dataset.open = String(qualityControlsOpen);
    renderControls.setAttribute('aria-hidden', String(!qualityControlsOpen));
    renderControls.inert = !qualityControlsOpen;
    qualityToggle.setAttribute('aria-expanded', String(qualityControlsOpen));
    qualityToggle.setAttribute(
      'aria-label',
      qualityControlsOpen ? 'Hide render quality options' : 'Show render quality options',
    );
  }

  function recordFpsSample(value, deltaSeconds) {
    if (!Number.isFinite(value) || value <= 0) return;

    const sample = Math.min(value, 240);
    const duration = Math.min(
      0.25,
      Math.max(1 / 240, deltaSeconds || 1 / sample),
    );
    fpsSamples.push({ value: sample, duration });
    fpsWindowAge += duration;
    fpsWeightedTotal += sample * duration;

    while (fpsWindowAge > FPS_WINDOW_SECONDS && fpsSamples.length > 2) {
      const removed = fpsSamples.shift();
      fpsWindowAge -= removed.duration;
      fpsWeightedTotal -= removed.value * removed.duration;
    }

    rollingFps = fpsWindowAge > 0 ? fpsWeightedTotal / fpsWindowAge : null;
    fpsState = fpsWindowAge >= FPS_STABLE_WINDOW_SECONDS && fpsSamples.length >= 2
      ? 'rolling'
      : 'measuring';
  }

  telemetryToggle.addEventListener('click', () => {
    setTelemetryMode(telemetryMode === 'compact' ? 'expanded' : 'compact');
  });
  qualityToggle.addEventListener('click', () => {
    setQualityControlsOpen(!qualityControlsOpen);
  });

  function setQualityProfile(profile = {}) {
    if (disposed) return;

    if (qualityButtons.has(profile.mode)) qualityMode = profile.mode;
    const scale = firstFiniteNumber([profile.scale]);
    if (scale !== null) qualityScale = scale;
    if (typeof profile.effects === 'boolean') qualityEffects = profile.effects;

    qualityButtons.forEach((button, mode) => {
      button.setAttribute('aria-pressed', String(mode === qualityMode));
    });
    qualityToggleValue.textContent = qualityMode.toUpperCase();
    quality.dataset.mode = qualityMode;
    qualityMeta.textContent = [
      qualityScale === null ? 'ADAPTIVE' : `${Math.round(qualityScale * 100)}% RENDER`,
      qualityEffects ? 'BLOOM' : 'CLEAN',
    ].join(' · ');
    updateQualityReadout();
  }

  function updateQualityReadout() {
    const stable = fpsState === 'rolling';
    const qualityLevel = stable ? getQuality(rollingFps) : 'unknown';
    quality.dataset.quality = qualityLevel;
    quality.dataset.fpsState = fpsState;
    qualityLabel.textContent = `${qualityMode.toUpperCase()} / ${formatFps(stable ? rollingFps : null)}`;
    quality.setAttribute(
      'aria-label',
      stable
        ? `Rendering performance: rolling average ${Math.round(rollingFps)} frames per second.`
        : 'Rendering performance: measuring a rolling frame average.',
    );
  }

  function setGameState(gameState = {}) {
    if (disposed) return;

    const status = String(gameState.status || 'ready');
    const completedSteps = Math.max(0, Number(gameState.completedSteps) || 0);
    const totalSteps = Math.max(completedSteps, Number(gameState.totalSteps) || 0);
    const progress = Math.max(0, Math.min(1, Number(gameState.progress) || 0));
    const distance = firstFiniteNumber([gameState.distance]);
    const score = Math.max(0, Math.round(Number(gameState.score) || 0));
    const statusLabel = status === 'complete'
      ? 'COMPLETE'
      : status === 'running'
        ? `${completedSteps} / ${totalSteps}`
        : 'READY';

    mission.dataset.status = status;
    missionTag.textContent = statusLabel;
    missionTitle.textContent = String(gameState.title || 'The Waterfront Loop');
    missionObjective.textContent = String(
      gameState.objective || 'Enter the city to begin your first route.',
    );
    missionHint.textContent = String(
      gameState.hint || 'Follow the amber beacon through the living district.',
    );
    missionDistance.textContent = distance === null
      ? 'DISTANCE / —'
      : distance < 1.2
        ? 'DISTANCE / ON SITE'
        : `DISTANCE / ${Math.round(distance)} M`;
    missionScore.textContent = `SCORE / ${String(score).padStart(4, '0')}`;
    missionClock.textContent = `SHIFT / ${String(gameState.clock || '00:00')}`;
    missionProgressFill.style.width = `${Math.round(progress * 100)}%`;
    missionProgress.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    missionProgress.setAttribute(
      'aria-valuetext',
      `${completedSteps} of ${totalSteps} objectives complete`,
    );

    const steps = Array.isArray(gameState.steps) ? gameState.steps : [];
    if (missionStepNodes.size !== steps.length) {
      missionStepNodes.clear();
      while (missionList.firstChild) missionList.removeChild(missionList.firstChild);
      steps.forEach((step) => {
        const item = createElement('li', 'hud__mission-step');
        const marker = createElement('span', 'hud__mission-step-marker');
        marker.setAttribute('aria-hidden', 'true');
        const label = createElement('span', 'hud__mission-step-label', step.label || 'Objective');
        item.append(marker, label);
        missionStepNodes.set(step.id, { item, marker, label });
        missionList.append(item);
      });
    }
    steps.forEach((step) => {
      const node = missionStepNodes.get(step.id);
      if (!node) return;
      node.item.dataset.state = step.completed ? 'complete' : step.current ? 'current' : 'locked';
      node.item.setAttribute(
        'aria-label',
        `${step.label || 'Objective'}: ${step.completed ? 'complete' : step.current ? 'current' : 'up next'}`,
      );
    });
    missionRestart.hidden = status !== 'complete';
    missionRestart.disabled = status !== 'complete';
  }

  function setMapOpen(open) {
    if (disposed) return;
    mapOpen = Boolean(open);
    mapOverlay.hidden = !mapOpen;
    mapOverlay.dataset.open = String(mapOpen);
    root.dataset.map = mapOpen ? 'open' : 'closed';
    mapClose.setAttribute('aria-expanded', String(mapOpen));
  }

  function toggleMap() {
    setMapOpen(!mapOpen);
  }

  function setMapState(mapState = {}) {
    if (disposed) return;
    const sector = String(mapState.sector || '0:0');
    const vehicles = Math.max(0, Math.round(Number(mapState.vehicles) || 0));
    const pedestrians = Math.max(0, Math.round(Number(mapState.pedestrians) || 0));
    const weather = String(mapState.weather || 'clear').toUpperCase();
    const district = String(mapState.district || 'Core district');
    const x = Math.max(4, Math.min(96, Number(mapState.mapX) || 50));
    const y = Math.max(4, Math.min(96, Number(mapState.mapY) || 50));
    mapSector.textContent = `SECTOR / ${sector}`;
    mapPopulation.textContent = `LIVE / ${vehicles} CARS · ${pedestrians} PEOPLE`;
    mapWeather.textContent = `WEATHER / ${weather}`;
    mapPlayer.style.left = `${x}%`;
    mapPlayer.style.top = `${y}%`;
    mapPlayer.setAttribute('aria-label', `You are in ${district}, sector ${sector}.`);
    mapDistrictNodes.forEach((node, label) => {
      node.dataset.active = label.toLowerCase() === district.toLowerCase()
        || district.toLowerCase().includes(label.toLowerCase())
        || label.toLowerCase().includes(district.toLowerCase());
    });
  }

  mapClose.addEventListener('click', () => {
    setMapOpen(false);
    document.querySelector('#scene-canvas')?.focus({ preventScroll: true });
  });

  function syncLifeContext(district, beat, cue) {
    lastDistrict = String(district || 'Core district').trim() || 'Core district';
    lastBeat = String(beat || '07:00 · City rhythm').trim() || '07:00 · City rhythm';
    lastCue = String(cue || 'City / in motion').trim() || 'City / in motion';
    stateLifeDistrict.textContent = lastDistrict;
    stateLifeBeat.textContent = `${lastBeat} · ${lastCue}`;
    stateLife.setAttribute(
      'aria-label',
      `District: ${lastDistrict}. Schedule: ${lastBeat}. Activity: ${lastCue}.`,
    );

    if (root.dataset.cameraMode === 'interior') return;

    context.dataset.mode = 'district';
    contextLabel.textContent = 'District';
    contextDistrict.textContent = lastDistrict;
    contextActivity.textContent = `Activity / ${lastBeat} · ${lastCue}`;
    context.setAttribute(
      'aria-label',
      `Current district: ${lastDistrict}. Current activity: ${lastBeat}. ${lastCue}.`,
    );
  }

  function update(dt, elapsed, gameState, mapState) {
    if (disposed) return;

    const deltaSeconds = normalizeDelta(dt);
    const measuredFps = readRendererFps(renderer);
    const frameFps = measuredFps !== null && measuredFps > 0
      ? measuredFps
      : (deltaSeconds ? 1 / deltaSeconds : null);
    recordFpsSample(frameFps, deltaSeconds);

    // Telemetry is useful at a glance, not at 60 DOM writes per second. Keep
    // the simulation loop hot and refresh the text surfaces at a readable
    // 8–10 Hz cadence.
    telemetryAccumulator += deltaSeconds || 0;
    if (telemetryAccumulator < 0.12) return;
    telemetryAccumulator = 0;
    const outsideCore = streaming?.stats?.focusSector !== '0:0';
    const streamedStats = outsideCore ? readSystemStats(streamedAgents) : null;
    const trafficStats = streamedStats?.vehicles ?? readSystemStats(traffic);
    const pedestrianStats = streamedStats?.pedestrians ?? readSystemStats(pedestrians);
    const trafficCount = streamedStats
      ? firstFiniteNumber([streamedStats.vehicles?.visible])
      : readEntityCount(traffic, 'traffic');
    const pedestrianCount = streamedStats
      ? firstFiniteNumber([streamedStats.pedestrians?.visible])
      : readEntityCount(pedestrians, 'pedestrians');
    trafficValue.textContent = formatCount(trafficCount);
    pedestrianValue.textContent = formatCount(pedestrianCount);
    trafficDetail.textContent = formatTrafficDetail(trafficStats);
    pedestrianDetail.textContent = formatPedestrianDetail(pedestrianStats);
    const focusDistrict = outsideCore
      ? streaming?.getSectorPresentation?.(streaming?.stats?.focusSector)?.presentation?.district
      : null;
    const district = focusDistrict || streamedStats?.districts?.[0] || 'Core district';
    const beat = formatLifeBeat(streamedStats?.schedule, elapsed);
    const cue = formatLifeCue(trafficStats, pedestrianStats);
    syncLifeContext(district, beat, cue);
    if (gameState) setGameState(gameState);
    if (mapState) setMapState(mapState);
    if (frameFps !== null) updateQualityReadout();
  }

  function setMessage(text) {
    if (disposed) return;

    const nextMessage = text === null || text === undefined ? '' : String(text).trim();
    message.textContent = nextMessage;
    message.hidden = !nextMessage;
    root.dataset.message = nextMessage ? 'visible' : 'hidden';
  }

  function setInteraction(value) {
    if (disposed) return;
    if (!value) {
      interaction.hidden = true;
      interaction.dataset.availability = 'hidden';
      root.dataset.interaction = 'hidden';
      stateEntry.dataset.availability = 'hidden';
      return;
    }
    const label = String(value.label || '').trim();
    const prompt = String(value.prompt || '').trim();
    const enabled = value.enabled !== false;
    const interiorExit = label.toUpperCase().startsWith('INTERIOR /');
    const inInterior = root.dataset.cameraMode === 'interior' || interiorExit;
    interaction.hidden = false;
    interaction.disabled = !enabled;
    interaction.dataset.availability = enabled ? (inInterior ? 'interior' : 'ready') : 'approach';
    root.dataset.interaction = interaction.dataset.availability;
    stateEntry.dataset.availability = interaction.dataset.availability;
    interaction.setAttribute('aria-disabled', String(!enabled));
    interactionLabel.textContent = label;
    interactionPrompt.textContent = prompt;
    interactionHint.textContent = enabled
      ? inInterior
        ? interiorExit
          ? 'Press E or tap to exit the current interior.'
          : 'Press E or tap to use this interior interaction.'
        : 'Press E or tap to enter this building.'
      : 'Move closer to the highlighted entrance to enter.';
    interaction.setAttribute(
      'aria-label',
      [...new Set([label, prompt].filter(Boolean))].join('. ') || 'Building interaction',
    );
  }

  function setCameraState({ mode = 'roam', distance } = {}) {
    if (disposed) return;

    const nextMode = String(mode).toLowerCase();
    const interiorMode = nextMode === 'interior';
    root.dataset.cameraMode = nextMode;
    stateMode.textContent = interiorMode ? 'MODE / INTERIOR' : 'MODE / FREE ROAM';
    stateMode.setAttribute('aria-label', interiorMode ? 'Mode: interior.' : 'Mode: free roam.');
    stateMode.dataset.mode = nextMode;
    stateEntry.dataset.mode = interiorMode ? 'interior' : 'exterior';
    route.setAttribute('aria-hidden', String(interiorMode));
    if (interiorMode) {
      context.dataset.mode = 'interior';
      contextLabel.textContent = 'Interior';
      contextDistrict.textContent = 'Indoor scene';
      contextActivity.textContent = 'E / TAP TO INTERACT · ESC TO EXIT';
      context.setAttribute('aria-label', 'Interior mode. Press E or tap to interact. Press Escape to exit.');
    } else {
      syncLifeContext(lastDistrict, lastBeat);
    }
    const distanceValue = firstFiniteNumber([distance]);
    const nextLabel = `CAM / ${nextMode.toUpperCase()}${
      distanceValue === null ? '' : ` · ${Math.round(distanceValue)} M`
    }`;
    if (nextLabel === lastCameraLabel) return;

    lastCameraLabel = nextLabel;
    cameraHint.textContent = nextLabel;
  }

  function setAtmosphere(mode = 'clear') {
    if (disposed) return;
    const labels = {
      clear: 'WEATHER / CLEAR',
      fog: 'WEATHER / COASTAL FOG',
      drizzle: 'WEATHER / PACIFIC RAIN',
    };
    stateTime.textContent = labels[mode] || String(mode).toUpperCase();
    stateTime.dataset.atmosphere = mode;
    root.dataset.atmosphere = mode;
    stateTime.setAttribute('aria-label', `Weather: ${String(mode).replace('-', ' ')}.`);
  }

  function dispose() {
    if (disposed) return;

    disposed = true;
    root.remove();
  }

  setQualityProfile(initialQuality);

  return {
    update,
    setMessage,
    setInteraction,
    setQualityProfile,
    setGameState,
    setMapState,
    setMapOpen,
    toggleMap,
    setCameraState,
    setAtmosphere,
    dispose,
  };
}
