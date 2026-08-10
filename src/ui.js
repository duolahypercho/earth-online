import './styles.css';
import { createUiAudio } from './audio.js';

const HUD_DATA_ATTRIBUTE = 'data-hud';
const FPS_WINDOW_SECONDS = 2;
const FPS_STABLE_WINDOW_SECONDS = 0.8;
const SIMULATION_START_HOUR = 7;
const SIMULATION_HOURS_PER_SECOND = 0.033;
const RESIDENT_STORY_ROTATION_SECONDS = 6;
const CALLOUT_DURATION_MS = 3400;
const COMPLETE_CALLOUT_DURATION_MS = 5400;
const LOW_NEED_WARNING_INTERVAL_MS = 6000;
const PULSE_DURATION_MS = 820;

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

function readFeaturedResidents(source) {
  if (!source || typeof source.getFeaturedResidentSnapshots !== 'function') return null;
  try {
    const stories = source.getFeaturedResidentSnapshots();
    return Array.isArray(stories)
      ? stories.filter((story) => story && typeof story === 'object')
      : null;
  } catch {
    return null;
  }
}

function readFeaturedResident(source, elapsed = 0) {
  const stories = readFeaturedResidents(source);
  if (!stories?.length) return null;

  const visibleStories = stories.filter((story) => story.visible);
  if (!visibleStories.length) return stories[0] || null;

  const seconds = Number(elapsed);
  const safeElapsed = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const rotation = Math.floor(safeElapsed / RESIDENT_STORY_ROTATION_SECONDS);
  return visibleStories[rotation % visibleStories.length] || null;
}

function readResidentText(value, keys = []) {
  try {
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    for (const key of keys) {
      const text = readResidentText(value[key]);
      if (text) return text;
    }
  } catch {
    // Optional story metadata must never interrupt HUD synchronization.
  }

  return null;
}

function compactResidentPhrase(value) {
  return String(value || '')
    .replace(/\b(?:a|an|the|to|at|for|then|toward|along|before)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readFeaturedVehicle(source) {
  if (!source || typeof source.getVehicleLifeSnapshot !== 'function') return null;
  try {
    const snapshot = source.getVehicleLifeSnapshot();
    const vehicles = Array.isArray(snapshot?.vehicles) ? snapshot.vehicles : [];
    return vehicles.find((vehicle) => vehicle?.featured && vehicle.visible)
      || vehicles.find((vehicle) => vehicle?.visible)
      || null;
  } catch {
    return null;
  }
}

function formatResidentStory(resident) {
  const identity = String(resident.label || resident.id || 'Resident').trim();
  const role = resident.role ? String(resident.role).trim().toUpperCase() : null;
  const action = String(resident.action || resident.activity || 'moving through the district').trim();
  const relationship = resident.relationship?.actorLabel
    ? `WITH ${resident.relationship.actorLabel}`
    : resident.need
      ? `NEED ${resident.need.replace(/^to\s+/i, '')}`
      : resident.destination
        ? `TO ${resident.destination}`
        : null;
  const mood = readResidentText(resident.mood, ['label', 'name', 'text', 'value', 'state', 'tone']);
  const choice = readResidentText(
    resident.choice,
    ['label', 'name', 'text', 'value', 'option', 'action', 'title'],
  );
  const compactAction = compactResidentPhrase(action);
  const compactRelationship = relationship ? compactResidentPhrase(relationship) : null;
  const compact = [
    identity,
    role,
    compactAction,
  ].filter(Boolean).join(' · ')
    + '\n'
    + [
      compactRelationship,
      mood ? `MOOD ${compactResidentPhrase(mood)}` : null,
      choice ? `CHOICE ${compactResidentPhrase(choice)}` : null,
    ].filter(Boolean).join(' · ');
  const aria = [
    identity,
    role ? `role ${role.toLowerCase()}` : null,
    `action: ${action}`,
    relationship ? `context: ${relationship}` : null,
    mood ? `mood: ${mood}` : null,
    choice ? `choice: ${choice}` : null,
  ].filter(Boolean).join('. ');

  return { compact, aria };
}

function formatStreetStory(pedestrians, traffic, elapsed, streamedAgents, outsideCore = false) {
  const storySource = outsideCore && typeof streamedAgents?.getFeaturedResidentSnapshots === 'function'
    ? streamedAgents
    : pedestrians;
  const resident = readFeaturedResident(storySource, elapsed);
  if (resident) {
    return formatResidentStory(resident);
  }

  const vehicleSource = outsideCore ? null : traffic;
  const vehicle = readFeaturedVehicle(vehicleSource);
  if (!vehicle) return null;
  const identity = String(
    vehicle.identity?.label || vehicle.livery?.board || vehicle.class || 'Vehicle',
  ).trim();
  const action = String(vehicle.action?.label || 'Driving').trim();
  const cue = vehicle.stop?.cue
    ? `${vehicle.stop.cue.replaceAll('-', ' ')}`
    : vehicle.route?.targetRoad
      ? `toward ${vehicle.route.targetRoad}`
      : vehicle.livery?.service
        ? vehicle.livery.service
        : null;
  const compact = [identity, action, cue].filter(Boolean).join(' · ');
  return {
    compact,
    aria: [identity, `action: ${action}`, cue ? `context: ${cue}` : null]
      .filter(Boolean)
      .join('. '),
  };
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
  const missionObjectiveCount = createElement(
    'span',
    'hud__mission-objective-count',
    'OBJECTIVE / —',
  );
  const missionScore = createElement('span', 'hud__mission-score', 'SCORE / 0000');
  const missionClock = createElement('span', 'hud__mission-clock', 'SHIFT / 00:00');
  missionMeta.append(missionDistance, missionObjectiveCount, missionScore, missionClock);
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
    ['Outer Sunset', 6, 82],
    ['Mission', 28, 78],
    ['Castro', 22, 68],
    ['Haight', 14, 58],
    ['Golden Gate Park', 8, 48],
    ['Richmond', 10, 34],
    ['Presidio', 12, 18],
    ['Pacific Heights', 26, 22],
    ['Fillmore', 30, 40],
    ['Civic Center', 38, 52],
    ['SoMa', 48, 68],
    ['Downtown', 54, 50],
    ['Embarcadero', 72, 52],
    ['Chinatown', 58, 38],
    ['Nob Hill', 48, 36],
    ['Russian Hill', 52, 28],
    ['North Beach', 66, 26],
    ['Marina', 42, 14],
    ['Twin Peaks', 24, 58],
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

  // Render quality and FPS are developer controls, not player-facing city
  // information. Keep the elements and update paths alive for diagnostics,
  // but remove them from the default fantasy HUD so the world owns the frame.
  telemetryToggle.hidden = true;
  qualityToggle.hidden = true;
  quality.hidden = true;
  renderControls.hidden = true;

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
  const messageDot = createElement('span', 'hud__message-dot');
  messageDot.setAttribute('aria-hidden', 'true');
  const messageText = createElement('span', 'hud__message-text');
  message.append(messageDot, messageText);

  const callout = createElement('section', 'hud__callout');
  callout.setAttribute('role', 'status');
  callout.hidden = true;
  const calloutKicker = createElement('span', 'hud__callout-kicker', 'SHIFT PULSE');
  const calloutTitle = createElement('strong', 'hud__callout-title');
  const calloutDetail = createElement('span', 'hud__callout-detail');
  callout.append(calloutKicker, calloutTitle, calloutDetail);

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

  /* ---- life panel ---- */
  const lifePanel = createElement('section', 'hud__life');
  lifePanel.setAttribute('aria-label', 'Life needs');
  const lifeHeader = createElement('div', 'hud__life-header');
  const lifeTitle = createElement('span', 'hud__life-title', 'LIFE / DAY 01');
  const lifeClock = createElement('span', 'hud__life-clock', '07:00');
  const lifeCash = createElement('span', 'hud__life-cash', '$140');
  const lifeMood = createElement('span', 'hud__life-mood', 'GOOD');
  lifeHeader.append(lifeTitle, lifeClock, lifeCash, lifeMood);
  const lifeBars = createElement('div', 'hud__life-bars');
  const lifeBarNodes = new Map();
  ['energy', 'hunger', 'social', 'fun'].forEach((key) => {
    const row = createElement('div', 'hud__life-bar');
    const label = createElement('span', 'hud__life-bar-label', key.toUpperCase());
    const track = createElement('span', 'hud__life-bar-track');
    const fill = createElement('span', 'hud__life-bar-fill');
    fill.setAttribute('aria-hidden', 'true');
    row.setAttribute('aria-valuemin', '0');
    row.setAttribute('aria-valuemax', '100');
    track.append(fill);
    row.append(label, track);
    lifeBarNodes.set(key, { row, fill, label });
    lifeBars.append(row);
  });
  const lifeInventory = createElement(
    'span',
    'hud__life-inventory',
    'MEDKIT / 0 OF 3 · B BUY $28 · G USE · AMMO / N BUY $32',
  );
  lifeInventory.setAttribute(
    'aria-label',
    'Medkits: 0 of 3. Press B to buy for 28 dollars at a market. Press G to use. Press N to buy ammunition for 32 dollars.',
  );
  const lifeDebt = createElement('span', 'hud__life-inventory hud__life-debt', 'LEGAL DEBT / $0');
  lifeDebt.setAttribute('aria-label', 'Legal debt: 0 dollars.');
  const lifeFavor = createElement('span', 'hud__life-favor');
  lifeFavor.hidden = true;
  lifePanel.append(lifeHeader, lifeBars, lifeInventory, lifeDebt, lifeFavor);

  const drivePanel = createElement('section', 'hud__drive');
  drivePanel.setAttribute('aria-label', 'Driving telemetry');
  drivePanel.hidden = true;
  const driveSpeed = createElement('span', 'hud__drive-speed', '0');
  const driveUnit = createElement('span', 'hud__drive-unit', 'KM/H');
  const driveMode = createElement('span', 'hud__drive-mode', 'DRIVE / CLEAR');
  const driveHeading = createElement('span', 'hud__drive-heading', 'N');
  drivePanel.append(driveSpeed, driveUnit, driveMode, driveHeading);

  /* ---- online panel ---- */
  const onlinePanel = createElement('section', 'hud__online');
  onlinePanel.setAttribute('aria-label', 'Online players and voice');
  const onlineHeader = createElement('div', 'hud__online-header');
  const onlineStatus = createElement('span', 'hud__online-status', 'SOLO MODE');
  onlineStatus.setAttribute('data-state', 'offline');
  const onlineCount = createElement('span', 'hud__online-count', '0 ONLINE');
  const voiceToggle = createElement('button', 'hud__voice-toggle', 'VOICE OFF');
  voiceToggle.type = 'button';
  voiceToggle.setAttribute('aria-pressed', 'false');
  voiceToggle.setAttribute('aria-label', 'Toggle voice chat. A live indicator shows when you are speaking.');
  onlineHeader.append(onlineStatus, onlineCount, voiceToggle);
  const playerList = createElement('ul', 'hud__players');
  playerList.setAttribute('aria-label', 'Connected players');
  const chatLog = createElement('div', 'hud__chat-log');
  chatLog.setAttribute('aria-live', 'polite');
  const chatRow = createElement('div', 'hud__chat-row');
  const chatInput = createElement('input', 'hud__chat-input');
  chatInput.type = 'text';
  chatInput.placeholder = 'Message the room…';
  chatInput.setAttribute('aria-label', 'Chat message');
  chatInput.maxLength = 180;
  const chatSend = createElement('button', 'hud__chat-send', 'SEND');
  chatSend.type = 'button';
  chatRow.append(chatInput, chatSend);
  onlinePanel.append(onlineHeader, playerList, chatLog, chatRow);

  root.append(header, mission, telemetry, state, interaction, lifePanel, onlinePanel, drivePanel, message, callout, footer, touchControls, mapOverlay);
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
  let lastStory = null;
  let lastStoryAria = null;
  let telemetryAccumulator = 0;
  const missionStepNodes = new Map();
  let mapOpen = false;
  const mapRemoteNodes = new Map();
  let lastCompletedSteps = null;
  let lastMissionStatus = null;
  let calloutTimer = null;
  let lastLowNeedAt = 0;
  const previousNeeds = new Map();
  let uiAudio = null;
  let uiAudioPrimed = false;

  function primeUiAudio() {
    if (uiAudioPrimed) return;
    uiAudioPrimed = true;
    uiAudio?.prime?.();
  }

  function showCallout({ kind = 'info', kicker = 'SHIFT PULSE', title = '', detail = '' } = {}) {
    if (disposed) return;

    const calloutKind = ['objective', 'complete', 'low', 'info'].includes(kind) ? kind : 'info';
    callout.dataset.kind = calloutKind;
    calloutKicker.textContent = String(kicker || 'SHIFT PULSE');
    calloutTitle.textContent = String(title || '');
    calloutDetail.textContent = String(detail || '');
    callout.classList.remove('hud__callout--closing');
    callout.hidden = false;
    window.clearTimeout(calloutTimer);
    window.requestAnimationFrame(() => {
      callout.dataset.open = 'true';
    });

    const duration = calloutKind === 'complete'
      ? COMPLETE_CALLOUT_DURATION_MS
      : CALLOUT_DURATION_MS;
    calloutTimer = window.setTimeout(() => {
      callout.dataset.open = 'false';
      callout.classList.add('hud__callout--closing');
      window.setTimeout(() => {
        callout.hidden = true;
        callout.classList.remove('hud__callout--closing');
      }, 220);
    }, duration);
  }

  function pulseMission() {
    mission.dataset.pulse = 'true';
    missionProgressFill.dataset.pulse = 'true';
    window.setTimeout(() => {
      mission.dataset.pulse = 'false';
      missionProgressFill.dataset.pulse = 'false';
    }, PULSE_DURATION_MS);
  }

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
      : status === 'failed'
        ? 'FAILED'
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
    missionObjectiveCount.textContent = totalSteps > 0
      ? `OBJECTIVE / ${completedSteps} OF ${totalSteps}`
      : 'OBJECTIVE / FREE ROAM';
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
    const replayable = status === 'complete' || status === 'failed';
    missionRestart.hidden = !replayable;
    missionRestart.disabled = !replayable;

    const previousCompleted = lastCompletedSteps;
    const previousStatus = lastMissionStatus;
    const freshState = previousCompleted === null || previousStatus === null;
    const becameComplete = !freshState
      && status === 'complete'
      && previousStatus !== 'complete';
    const becameFailed = !freshState
      && status === 'failed'
      && previousStatus !== 'failed';
    const advanced = !freshState && completedSteps > previousCompleted;

    if (becameComplete || becameFailed || advanced) {
      if (becameComplete) {
        pulseMission();
        showCallout({
          kind: 'complete',
          kicker: 'SHIFT COMPLETE',
          title: String(gameState.title || 'The Waterfront Loop'),
          detail: `${totalSteps} OBJECTIVES CLEARED · SCORE / ${String(score).padStart(4, '0')}`,
        });
        uiAudio?.play?.('complete');
      } else if (becameFailed) {
        showCallout({
          kind: 'low',
          kicker: 'SHIFT FAILED',
          title: 'Route time expired',
          detail: 'REPLAY THE SHIFT TO TRY AGAIN',
        });
        uiAudio?.play?.('low');
      } else {
        const completedStep = steps[previousCompleted] || null;
        if (completedStep) {
          const nextStep = steps[completedSteps] || null;
          pulseMission();
          showCallout({
            kind: 'objective',
            kicker: 'OBJECTIVE COMPLETE',
            title: completedStep.label || 'Objective complete',
            detail: nextStep ? `NEXT / ${nextStep.label}` : 'SHIFT CLEAR',
          });
          uiAudio?.play?.('objective');
        }
      }
    }
    lastCompletedSteps = completedSteps;
    lastMissionStatus = status;
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

  function syncLifeContext(district, beat, cue, story) {
    lastDistrict = String(district || 'Core district').trim() || 'Core district';
    lastBeat = String(beat || '07:00 · City rhythm').trim() || '07:00 · City rhythm';
    lastCue = String(cue || 'City / in motion').trim() || 'City / in motion';
    if (story !== undefined) {
      const compactStory = typeof story === 'string' ? story : story?.compact;
      const ariaStory = typeof story === 'string' ? story : story?.aria;
      lastStory = compactStory ? String(compactStory).trim() : null;
      lastStoryAria = ariaStory ? String(ariaStory).trim() : lastStory;
    }
    const visibleLifeDetail = lastStory || lastCue;
    stateLifeDistrict.textContent = lastDistrict;
    stateLifeBeat.textContent = `${lastBeat} · ${visibleLifeDetail}`;
    stateLife.setAttribute(
      'aria-label',
      `District: ${lastDistrict}. Schedule: ${lastBeat}. Activity: ${lastCue}.${lastStoryAria ? ` Street story: ${lastStoryAria}.` : ''}`,
    );

    if (root.dataset.cameraMode === 'interior') return;

    context.dataset.mode = 'district';
    contextLabel.textContent = 'District';
    contextDistrict.textContent = lastDistrict;
    contextActivity.textContent = lastStory
      ? `Street story / ${lastStory}`
      : `Activity / ${lastBeat} · ${lastCue}`;
    context.setAttribute(
      'aria-label',
      `Current district: ${lastDistrict}. Current activity: ${lastBeat}. ${lastCue}.${lastStoryAria ? ` Street story: ${lastStoryAria}.` : ''}`,
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
    const story = formatStreetStory(pedestrians, traffic, elapsed, streamedAgents, outsideCore);
    syncLifeContext(district, beat, cue, story);
    if (gameState) setGameState(gameState);
    if (mapState) setMapState(mapState);
    if (frameFps !== null) updateQualityReadout();
  }

  function setMessage(text) {
    if (disposed) return;

    const nextMessage = text === null || text === undefined ? '' : String(text).trim();
    messageText.textContent = nextMessage;
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

  const lifeBarColors = {
    energy: '#f2c14e',
    hunger: '#e07856',
    social: '#6ba3a8',
    fun: '#c08fd0',
  };

  function setLifeState(lifeState = {}) {
    if (disposed) return;
    const day = Math.max(1, Number(lifeState.day) || 1);
    lifeTitle.textContent = `LIFE / DAY ${String(day).padStart(2, '0')}`;
    lifeClock.textContent = `${String(lifeState.clockLabel || '07:00')} ${String(lifeState.phase || 'MORNING')}`;
    lifeCash.textContent = `$${Math.max(0, Math.round(Number(lifeState.cash) || 0))}`;
    const legalDebt = Math.max(0, Math.round(Number(lifeState.legalDebt) || 0));
    lifeDebt.textContent = `LEGAL DEBT / $${legalDebt}`;
    lifeDebt.dataset.outstanding = legalDebt > 0 ? 'true' : 'false';
    lifeDebt.setAttribute('aria-label', `Legal debt: ${legalDebt} dollars.`);
    lifeMood.textContent = String(lifeState.mood || 'GOOD').toUpperCase();
    lifeMood.dataset.mood = String(lifeState.mood || 'good');
    const medkit = lifeState.inventory?.medkit || {};
    const medkitCount = Math.max(0, Math.round(Number(medkit.count) || 0));
    const medkitCapacity = Math.max(medkitCount, Math.round(Number(medkit.capacity) || 0));
    const medkitCost = Math.max(0, Math.round(Number(medkit.cost) || 0));
    const ammunition = lifeState.inventory?.ammunition || {};
    const ammoCost = Math.max(0, Math.round(Number(ammunition.cost) || 0));
    lifeInventory.textContent = `MEDKIT / ${medkitCount} OF ${medkitCapacity} · B BUY $${medkitCost} · G USE · AMMO / N BUY $${ammoCost}`;
    lifeInventory.setAttribute(
      'aria-label',
      `Medkits: ${medkitCount} of ${medkitCapacity}. Press B to buy for ${medkitCost} dollars at a market. Press G to use. Press N to buy ammunition for ${ammoCost} dollars.`,
    );
    const favor = lifeState.residentFavor;
    lifeFavor.hidden = favor?.active !== true;
    if (favor?.active) {
      const remaining = Math.max(0, Math.ceil(Number(favor.remaining) || 0));
      lifeFavor.textContent = `FAVOR / ${favor.residentLabel} → ${favor.target?.label} · ${remaining}S · $${favor.reward}`;
      lifeFavor.setAttribute(
        'aria-label',
        `Resident favor for ${favor.residentLabel}. Deliver to ${favor.target?.label} within ${remaining} seconds for ${favor.reward} dollars.`,
      );
    } else {
      lifeFavor.textContent = '';
      lifeFavor.removeAttribute('aria-label');
    }
    const needs = lifeState.needs || {};
    const lowCrossings = [];
    for (const [key, node] of lifeBarNodes) {
      const value = Math.min(100, Math.max(0, Number(needs[key]) || 0));
      node.fill.style.width = `${value}%`;
      node.fill.style.backgroundColor = lifeBarColors[key] || '#6ba3a8';
      node.fill.style.opacity = value < 30 ? '0.95' : '0.75';
      node.row.dataset.need = key;
      node.row.dataset.low = String(value < 30);
      node.label.textContent = `${key.toUpperCase()} ${Math.round(value)}`;
      node.row.setAttribute('aria-label', `${key}: ${Math.round(value)} out of 100`);
      node.row.setAttribute('aria-valuenow', String(Math.round(value)));
      const previousValue = previousNeeds.get(key);
      if (previousValue !== undefined && previousValue >= 30 && value < 30) {
        lowCrossings.push(key);
        node.row.dataset.flash = 'true';
        window.setTimeout(() => {
          node.row.dataset.flash = 'false';
        }, PULSE_DURATION_MS);
      }
      previousNeeds.set(key, value);
    }
    if (lowCrossings.length) {
      const now = performance.now();
      if (now - lastLowNeedAt >= LOW_NEED_WARNING_INTERVAL_MS) {
        lastLowNeedAt = now;
        const labels = lowCrossings.map((key) => key.toUpperCase()).join(', ');
        const hint = String(
          lifeState.needHint
          || (lowCrossings.includes('hunger')
            ? 'Grab a bite at the Ferry Building market hall.'
            : lowCrossings.includes('social')
              ? 'Talk to residents along the avenue.'
              : lowCrossings.includes('fun')
                ? 'Take a car out for a spin.'
                : 'Rest for a moment to recover energy.'),
        );
        showCallout({
          kind: 'low',
          kicker: 'NEED WARNING',
          title: labels,
          detail: hint,
        });
        uiAudio?.play?.('low');
      }
    }
  }

  let onlineAction = null;

  function setOnlineAction(action) {
    onlineAction = action;
  }

  function setOnlineState(onlineState = {}) {
    if (disposed) return;
    const connected = onlineState.connected === true;
    const peers = Array.isArray(onlineState.peers) ? onlineState.peers : [];
    onlineStatus.textContent = connected ? 'ONLINE' : 'SOLO MODE';
    onlineStatus.dataset.state = connected ? 'online' : 'offline';
    onlineCount.textContent = `${peers.length} ONLINE`;
    if (onlineState.playerName) onlineStatus.setAttribute('aria-label', `Multiplayer: ${onlineState.playerName}`);
    const talking = onlineState.talking === true;
    const voiceOn = onlineState.voiceOn === true;
    voiceToggle.textContent = voiceOn ? (talking ? 'SPEAKING' : 'VOICE ON') : 'VOICE OFF';
    voiceToggle.dataset.state = voiceOn ? (talking ? 'talking' : 'on') : 'off';
    voiceToggle.setAttribute('aria-pressed', String(voiceOn));
    if (onlineState.error) {
      voiceToggle.setAttribute('aria-label', onlineState.error);
      voiceToggle.title = onlineState.error;
    }

    while (playerList.firstChild) playerList.removeChild(playerList.firstChild);
    const ownItem = createElement('li', 'hud__player hud__player--self');
    const ownDot = createElement('span', 'hud__player-dot');
    ownDot.setAttribute('aria-hidden', 'true');
    ownDot.dataset.talking = String(talking);
    const ownName = createElement('span', 'hud__player-name', `${onlineState.playerName || 'You'} (you)`);
    const ownMode = createElement('span', 'hud__player-mode', voiceOn ? 'VOICE' : 'MUTED');
    ownItem.append(ownDot, ownName, ownMode);
    playerList.append(ownItem);
    peers.forEach((peer) => {
      const item = createElement('li', 'hud__player');
      const dot = createElement('span', 'hud__player-dot');
      dot.setAttribute('aria-hidden', 'true');
      dot.dataset.talking = String(peer.talking === true);
      const name = createElement('span', 'hud__player-name', peer.name || 'Player');
      const gameplay = peer.gameplay || {};
      const mission = peer.mission || null;
      const missionLabel = mission
        ? mission.status === 'complete'
          ? 'CO-OP SHIFT · COMPLETE'
          : mission.status === 'failed'
            ? 'CO-OP SHIFT · FAILED'
            : `CO-OP SHIFT · ${mission.completedSteps}/${mission.totalSteps}`
        : null;
      const modeLabel = gameplay.pursuitActive
        ? `PURSUIT · L${gameplay.wantedLevel || 1}`
        : gameplay.heat > 0
          ? `HEAT ${gameplay.heat}`
          : gameplay.healthBand === 'downed'
            ? 'DOWNED'
            : missionLabel
              || (peer.driving
                ? 'DRIVING'
                : String(gameplay.activity || 'on foot').replace('-', ' ').toUpperCase());
      const mode = createElement('span', 'hud__player-mode', modeLabel);
      item.dataset.wanted = String(gameplay.pursuitActive === true || gameplay.heat > 0);
      item.dataset.coopShift = String(Boolean(mission));
      if (mission?.objective) item.title = mission.objective;
      item.append(dot, name, mode);
      playerList.append(item);
    });
    setMapRemoteState(peers);
  }

  function setMapRemoteState(peers = []) {
    if (disposed) return;
    const activeRemoteIds = new Set(peers.map((peer) => peer.id));
    for (const [id, node] of mapRemoteNodes) {
      if (activeRemoteIds.has(id)) continue;
      node.remove();
      mapRemoteNodes.delete(id);
    }
    peers.forEach((peer) => {
      let node = mapRemoteNodes.get(peer.id);
      if (!node) {
        node = createElement('span', 'hud__map-remote', peer.name.slice(0, 2).toUpperCase());
        node.setAttribute('aria-hidden', 'true');
        mapGrid.append(node);
        mapRemoteNodes.set(peer.id, node);
      }
      const x = Number(peer.x);
      const z = Number(peer.z);
      if (Number.isFinite(x) && Number.isFinite(z)) {
        node.style.left = `${Math.min(96, Math.max(4, (x / 5760 + 0.5) * 100))}%`;
        node.style.top = `${Math.min(96, Math.max(4, (z / 5760 + 0.5) * 100))}%`;
      }
      node.dataset.driving = String(peer.driving === true);
      node.dataset.talking = String(peer.talking === true);
      node.dataset.wanted = String(peer.gameplay?.pursuitActive === true || peer.gameplay?.heat > 0);
      const initials = peer.name.slice(0, 2).toUpperCase();
      node.textContent = node.dataset.wanted === 'true' ? `!${initials.slice(0, 1)}` : initials;
    });
  }

  const headingLabels = {
    N: 'NORTH',
    NE: 'NORTHEAST',
    E: 'EAST',
    SE: 'SOUTHEAST',
    S: 'SOUTH',
    SW: 'SOUTHWEST',
    W: 'WEST',
    NW: 'NORTHWEST',
  };

  function setDriveState(driveState = {}) {
    if (disposed) return;
    const active = driveState.active === true;
    drivePanel.hidden = !active;
    if (!active) return;
    const speed = Math.max(0, Math.round(Number(driveState.speed) || 0));
    driveSpeed.textContent = String(speed);
    driveSpeed.dataset.speedBand = speed < 6 ? 'idle' : speed < 18 ? 'city' : 'cruise';
    const headingRad = Number(driveState.heading);
    const index = Number.isFinite(headingRad)
      ? Math.floor((((headingRad * 180 / Math.PI) + 360) % 360 + 22.5) / 45) % 8
      : 0;
    const cardinal = Object.keys(headingLabels)[index];
    driveHeading.textContent = cardinal;
    const integrity = Math.round(
      Math.max(0, Math.min(1, Number(driveState.damage?.ratio) || 0)) * 100,
    );
    const disabled = driveState.damage?.disabled === true;
    const repairCost = Math.max(0, Math.round(Number(driveState.repairCost) || 0));
    drivePanel.dataset.damage = String(driveState.damage?.state || 'clear');
    driveMode.textContent = disabled
      ? `VEHICLE / DISABLED · R $${repairCost}`
      : `DRIVE / ${String(driveState.weather || 'CLEAR').toUpperCase()} · ${integrity}%`;
    drivePanel.setAttribute(
      'aria-label',
      `Driving. Speed ${speed} kilometers per hour. Heading ${headingLabels[cardinal]}. Vehicle integrity ${integrity} percent${disabled ? `, disabled, roadside repair ${repairCost} dollars` : ''}.`,
    );
  }

  function appendChat(entry = {}) {
    if (disposed) return;
    const line = createElement('p', 'hud__chat-line');
    if (entry.local) line.dataset.local = 'true';
    if (entry.peerGameplayEvent) line.dataset.peerGameplayEvent = String(entry.peerGameplayEvent);
    if (entry.peerGameplayPeer) line.dataset.peerGameplayPeer = String(entry.peerGameplayPeer);
    const name = createElement('strong', 'hud__chat-name', `${entry.name || 'Player'}: `);
    const text = createElement('span', 'hud__chat-text', String(entry.text || ''));
    line.append(name, text);
    chatLog.append(line);
    while (chatLog.childElementCount > 24) chatLog.removeChild(chatLog.firstChild);
  }

  function clearPeerGameplayEvent(peerId) {
    chatLog.querySelectorAll('[data-peer-gameplay-event]').forEach((line) => {
      if (!peerId || line.dataset.peerGameplayPeer === peerId) line.remove();
    });
  }

  voiceToggle.addEventListener('click', () => onlineAction?.());
  const sendChat = () => {
    const text = chatInput.value;
    chatInput.value = '';
    onlineAction?.({ chat: text });
  };
  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendChat();
    }
  });

  uiAudio = createUiAudio();
  const uiAudioEventNames = ['pointerdown', 'keydown', 'touchstart'];
  if (uiAudio && typeof window !== 'undefined') {
    uiAudioEventNames.forEach((eventName) => {
      window.addEventListener(eventName, primeUiAudio, { capture: true, passive: true });
    });
  }

  function dispose() {
    if (disposed) return;

    disposed = true;
    window.clearTimeout(calloutTimer);
    if (uiAudio && typeof window !== 'undefined') {
      uiAudioEventNames.forEach((eventName) => {
        window.removeEventListener(eventName, primeUiAudio, { capture: true });
      });
      uiAudio.dispose();
      uiAudio = null;
    }
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
    setLifeState,
    setOnlineState,
    setOnlineAction,
    appendChat,
    clearPeerGameplayEvent,
    setDriveState,
    setMapRemoteState,
    dispose,
  };
}
