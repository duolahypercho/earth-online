/**
 * Full City street design — global + per-street asphalt/sidewalk controls.
 *
 * === Global size (priority: URL > map meta > code defaults) ===
 *   streetScale   → asphalt / driving lane width multiplier
 *   sidewalkScale → sidewalk width multiplier
 *
 * === Per-street (dynamic) ===
 *   __SF_REALMAP__.setStreet('Market St', { asphaltWidth: 16, sidewalkWidth: 3.5 })
 *   __SF_REALMAP__.setStreet(roadId, { streetScale: 2.4, sidewalkScale: 1.4 })
 *   __SF_REALMAP__.getStreet('Market St')
 *   __SF_REALMAP__.listStreets({ q: 'Valencia', limit: 12 })
 *   __SF_REALMAP__.clearStreet('Market St')
 *
 * Embedded in map data:
 *   public/data/sf/sf-city.json → meta.streetDesign (+ .overrides)
 *   Rebuild: npm run build:realmap-assets
 *   Patch only: npm run embed:street-design
 *
 * URL examples (global experiments):
 *   realmap.html?play=1&street=1.85&sidewalk=1.1
 *   realmap.html?play=1&preset=wide
 */

/** Schema version written into sf-city.json meta.streetDesign */
export const STREET_DESIGN_META_VERSION = 2;

/** Named presets — pick one with ?preset= or setStreetPreset() */
export const STREET_PRESETS = Object.freeze({
  /** Fits typical OSM SF lot setbacks (~12–14 m asphalt). */
  compact: Object.freeze({ streetScale: 1.9, sidewalkScale: 1.15, label: 'Compact' }),
  /** Default: readable asphalt + visible sidewalk band between buildings. */
  default: Object.freeze({ streetScale: 1.85, sidewalkScale: 1.35, label: 'Default' }),
  wide: Object.freeze({ streetScale: 2.2, sidewalkScale: 1.55, label: 'Wide' }),
  boulevard: Object.freeze({ streetScale: 2.6, sidewalkScale: 1.8, label: 'Boulevard' }),
});

/** Base OSM-ish section in meters (before scale multipliers). */
export const STREET_SECTION_BASE = Object.freeze({
  motorway: { lanes: 4, sidewalk: 0, laneW: 3.6 },
  trunk: { lanes: 4, sidewalk: 0, laneW: 3.5 },
  primary: { lanes: 4, sidewalk: 2.8, laneW: 3.4 },
  secondary: { lanes: 3, sidewalk: 2.6, laneW: 3.35 },
  tertiary: { lanes: 2, sidewalk: 2.5, laneW: 3.3 },
  unclassified: { lanes: 2, sidewalk: 2.4, laneW: 3.25 },
  residential: { lanes: 2, sidewalk: 2.4, laneW: 3.2 },
  living_street: { lanes: 2, sidewalk: 2.2, laneW: 3.0 },
  service: { lanes: 1, sidewalk: 0, laneW: 3.2 },
  pedestrian: { lanes: 1, sidewalk: 0, laneW: 3.6 },
  footway: { lanes: 1, sidewalk: 0, laneW: 2.4 },
  cycleway: { lanes: 1, sidewalk: 0, laneW: 2.4 },
  path: { lanes: 1, sidewalk: 0, laneW: 2.2 },
});

const DEFAULT_DESIGN = Object.freeze({
  preset: 'default',
  /** ★ Main knob — asphalt / lane width */
  streetScale: STREET_PRESETS.default.streetScale,
  /** ★ Main knob — sidewalk width */
  sidewalkScale: STREET_PRESETS.default.sidewalkScale,
  curbScale: 1.2,
  /**
   * Building clearance tracks the visual sidewalk outer edge (see resolveStreetCrossSection).
   * These soft scales are a floor only; buildings must leave the full visual ROW.
   */
  buildingStreetScale: 1.85,
  buildingSidewalkScale: 1.35,
  buildingCurbScale: 1.2,
  buildingClearance: 0.35,
  /** Must reach past asphaltHalf so facades cannot sit on the roadway. */
  buildingPushCap: 14,
  buildingInset: 0.55,
  roadSurfaceLift: 0.45,
  buildingBaseClearance: 0.28,
  /** Per-street overrides: { byId: { [id]: {...} }, byName: { [name]: {...} } } */
  overrides: Object.freeze({ byId: Object.freeze({}), byName: Object.freeze({}) }),
});

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cloneOverrides(raw = null) {
  const byId = {};
  const byName = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const idSrc = src.byId && typeof src.byId === 'object' ? src.byId : src;
  const nameSrc = src.byName && typeof src.byName === 'object' ? src.byName : {};
  // Legacy flat map treated as byId unless keys look like street names.
  for (const [key, value] of Object.entries(idSrc || {})) {
    if (key === 'byId' || key === 'byName') continue;
    const normalized = normalizeStreetOverride(value);
    if (!normalized) continue;
    if (/^\d/.test(String(key)) || String(key).includes('-s') || String(key).length > 24) {
      byId[String(key)] = normalized;
    } else if (src.byId) {
      byId[String(key)] = normalized;
    } else {
      // Flat legacy: prefer byId for numeric-looking OSM ids, else byName.
      if (/^\d+$/.test(String(key))) byId[String(key)] = normalized;
      else byName[normalizeStreetName(key)] = normalized;
    }
  }
  for (const [key, value] of Object.entries(nameSrc || {})) {
    const normalized = normalizeStreetOverride(value);
    if (!normalized) continue;
    byName[normalizeStreetName(key)] = normalized;
  }
  return { byId, byName };
}

export function normalizeStreetName(name = '') {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalize a per-street override. Accepts scales and/or absolute meters.
 * @returns {null|{streetScale?:number,sidewalkScale?:number,asphaltWidth?:number,sidewalkWidth?:number}}
 */
export function normalizeStreetOverride(partial = {}) {
  if (!partial || typeof partial !== 'object') return null;
  const out = {};
  if (partial.streetScale != null) out.streetScale = clamp(partial.streetScale, 0.6, 8, null);
  if (partial.sidewalkScale != null) out.sidewalkScale = clamp(partial.sidewalkScale, 0, 6, null);
  if (partial.asphaltWidth != null) out.asphaltWidth = clamp(partial.asphaltWidth, 2, 48, null);
  if (partial.asphaltWidthM != null) out.asphaltWidth = clamp(partial.asphaltWidthM, 2, 48, out.asphaltWidth);
  if (partial.sidewalkWidth != null) out.sidewalkWidth = clamp(partial.sidewalkWidth, 0, 12, null);
  if (partial.sidewalkWidthM != null) out.sidewalkWidth = clamp(partial.sidewalkWidthM, 0, 12, out.sidewalkWidth);
  if (partial.curbScale != null) out.curbScale = clamp(partial.curbScale, 0.5, 3, null);
  // Drop nullish clamps
  for (const key of Object.keys(out)) {
    if (out[key] == null || !Number.isFinite(out[key])) delete out[key];
  }
  return Object.keys(out).length ? out : null;
}

export function lookupStreetOverride(design, road) {
  const overrides = design?.overrides || { byId: {}, byName: {} };
  const byId = overrides.byId || {};
  const byName = overrides.byName || {};
  const id = road?.id != null ? String(road.id) : '';
  const nameKey = normalizeStreetName(road?.name || '');
  const fromId = id && byId[id] ? byId[id] : null;
  const fromName = nameKey && byName[nameKey] ? byName[nameKey] : null;
  if (!fromId && !fromName) return null;
  return { ...(fromName || {}), ...(fromId || {}) };
}

/**
 * @param {Partial<typeof DEFAULT_DESIGN> & { preset?: string, overrides?: object }} partial
 */
export function createStreetDesign(partial = {}) {
  const presetName = String(partial.preset || '').toLowerCase();
  const preset = STREET_PRESETS[presetName] || null;
  const base = {
    ...DEFAULT_DESIGN,
    ...(preset
      ? {
          preset: presetName,
          streetScale: preset.streetScale,
          sidewalkScale: preset.sidewalkScale,
          // Keep facade clearance locked to the chosen visual street size.
          buildingStreetScale: preset.streetScale,
          buildingSidewalkScale: preset.sidewalkScale,
        }
      : {}),
  };
  const design = {
    ...base,
    ...partial,
    streetScale: clamp(partial.streetScale ?? base.streetScale, 0.6, 8, base.streetScale),
    sidewalkScale: clamp(partial.sidewalkScale ?? base.sidewalkScale, 0.3, 6, base.sidewalkScale),
    curbScale: clamp(partial.curbScale ?? base.curbScale, 0.5, 3, base.curbScale),
    buildingStreetScale: clamp(partial.buildingStreetScale ?? base.buildingStreetScale, 0.4, 8, base.buildingStreetScale),
    buildingSidewalkScale: clamp(partial.buildingSidewalkScale ?? base.buildingSidewalkScale, 0, 6, base.buildingSidewalkScale),
    buildingCurbScale: clamp(partial.buildingCurbScale ?? base.buildingCurbScale, 0.4, 3, base.buildingCurbScale),
    buildingClearance: clamp(partial.buildingClearance ?? base.buildingClearance, 0, 6, base.buildingClearance),
    buildingPushCap: clamp(partial.buildingPushCap ?? base.buildingPushCap, 0.5, 28, base.buildingPushCap),
    buildingInset: clamp(partial.buildingInset ?? base.buildingInset, 0, 6, base.buildingInset),
    roadSurfaceLift: clamp(partial.roadSurfaceLift ?? base.roadSurfaceLift, 0.05, 2, base.roadSurfaceLift),
    buildingBaseClearance: clamp(partial.buildingBaseClearance ?? base.buildingBaseClearance, 0, 1, base.buildingBaseClearance),
    overrides: cloneOverrides(partial.overrides ?? base.overrides),
  };
  // Stale map meta sometimes carries tiny push caps — always reach past asphaltHalf.
  const asphaltHalf = (2 * 3.2 * design.streetScale) / 2;
  design.buildingPushCap = Math.max(design.buildingPushCap, asphaltHalf + design.buildingClearance + 2);
  if (!design.preset || !STREET_PRESETS[design.preset]) design.preset = 'custom';
  return design;
}

/** Merge/replace a per-street override. key = OSM id or street name. */
export function withStreetOverride(design, key, partial = {}) {
  const next = createStreetDesign(design);
  const normalized = normalizeStreetOverride(partial);
  if (!normalized) return next;
  const raw = String(key ?? '').trim();
  if (!raw) return next;
  if (/^\d/.test(raw) || raw.includes('-s')) {
    next.overrides.byId[raw] = {
      ...(next.overrides.byId[raw] || {}),
      ...normalized,
    };
  } else {
    const nameKey = normalizeStreetName(raw);
    next.overrides.byName[nameKey] = {
      ...(next.overrides.byName[nameKey] || {}),
      ...normalized,
    };
  }
  return next;
}

/** Remove a per-street override. */
export function withoutStreetOverride(design, key) {
  const next = createStreetDesign(design);
  const raw = String(key ?? '').trim();
  if (!raw) return next;
  if (/^\d/.test(raw) || raw.includes('-s')) {
    delete next.overrides.byId[raw];
  } else {
    delete next.overrides.byName[normalizeStreetName(raw)];
  }
  return next;
}

/** Extract only keys present in ?street=&sidewalk=&preset= (empty if none). */
export function extractStreetDesignSearch(search = '') {
  const params = typeof search === 'string'
    ? new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
    : search;
  const partial = {};
  const preset = params.get('preset') || params.get('streetPreset');
  if (preset) partial.preset = preset;
  if (params.has('street')) partial.streetScale = Number(params.get('street'));
  if (params.has('streetScale')) partial.streetScale = Number(params.get('streetScale'));
  if (params.has('sidewalk')) partial.sidewalkScale = Number(params.get('sidewalk'));
  if (params.has('sidewalkScale')) partial.sidewalkScale = Number(params.get('sidewalkScale'));
  if ((partial.streetScale != null || partial.sidewalkScale != null) && !partial.preset) {
    partial.preset = 'custom';
  }
  return partial;
}

/** Parse ?street=&sidewalk=&preset= from a query string or URLSearchParams. */
export function parseStreetDesignSearch(search = '') {
  return createStreetDesign(extractStreetDesignSearch(search));
}

const MAP_META_KEYS = [
  'preset',
  'streetScale',
  'sidewalkScale',
  'curbScale',
  'buildingStreetScale',
  'buildingSidewalkScale',
  'buildingCurbScale',
  'buildingClearance',
  'buildingPushCap',
  'buildingInset',
  'roadSurfaceLift',
  'buildingBaseClearance',
];

/** Plain knobs object suitable for merging into createStreetDesign(). */
export function streetDesignFromMapMeta(meta = null) {
  const block = meta?.streetDesign;
  if (!block || typeof block !== 'object') return {};
  const partial = {};
  for (const key of MAP_META_KEYS) {
    if (block[key] != null) partial[key] = block[key];
  }
  if (block.overrides) partial.overrides = cloneOverrides(block.overrides);
  return partial;
}

/**
 * Serialize design into sf-city.json meta.streetDesign.
 * Includes resolved residential/primary sections so the dataset documents meters.
 */
export function streetDesignToMapMeta(design, { generatedAt = new Date().toISOString() } = {}) {
  const resolved = createStreetDesign(design || {});
  const sectionHighways = ['residential', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
  const sections = {};
  for (const highway of sectionHighways) {
    const section = resolveStreetCrossSection({ highway, lanes: STREET_SECTION_BASE[highway].lanes }, resolved);
    sections[highway] = {
      lanes: section.lanes,
      asphaltWidthM: Number(section.asphaltWidth.toFixed(2)),
      sidewalkWidthM: Number(section.sidewalkWidth.toFixed(2)),
      rowOuterM: Number(section.rowOuter.toFixed(2)),
      buildingRowOuterM: Number(section.buildingRowOuter.toFixed(2)),
    };
  }
  return {
    version: STREET_DESIGN_META_VERSION,
    generatedAt,
    preset: resolved.preset,
    streetScale: resolved.streetScale,
    sidewalkScale: resolved.sidewalkScale,
    curbScale: resolved.curbScale,
    buildingStreetScale: resolved.buildingStreetScale,
    buildingSidewalkScale: resolved.buildingSidewalkScale,
    buildingCurbScale: resolved.buildingCurbScale,
    buildingClearance: resolved.buildingClearance,
    buildingPushCap: resolved.buildingPushCap,
    buildingInset: resolved.buildingInset,
    roadSurfaceLift: resolved.roadSurfaceLift,
    buildingBaseClearance: resolved.buildingBaseClearance,
    overrides: cloneOverrides(resolved.overrides),
    summary: summarizeStreetDesign(resolved),
    sections,
  };
}

/**
 * Resolve active design: code defaults ← map meta ← URL overrides.
 * @param {{ mapMeta?: object, urlSearch?: string|URLSearchParams }} layers
 */
export function resolveStreetDesignLayers({ mapMeta = null, urlSearch = '' } = {}) {
  const fromMap = streetDesignFromMapMeta(mapMeta);
  const fromUrl = extractStreetDesignSearch(urlSearch);
  const urlPreset = fromUrl.preset ? String(fromUrl.preset).toLowerCase() : '';
  // Named URL preset must replace map scales unless URL also sets street/sidewalk.
  if (urlPreset && STREET_PRESETS[urlPreset]) {
    const mapRest = { ...fromMap };
    if (fromUrl.streetScale == null) delete mapRest.streetScale;
    if (fromUrl.sidewalkScale == null) delete mapRest.sidewalkScale;
    return createStreetDesign({ ...mapRest, ...fromUrl });
  }
  return createStreetDesign({ ...fromMap, ...fromUrl });
}

export function summarizeStreetDesign(design) {
  const residential = resolveStreetCrossSection({ highway: 'residential', lanes: 2 }, design);
  const overrideCount = (design?.overrides?.byId
    ? Object.keys(design.overrides.byId).length
    : 0) + (design?.overrides?.byName
    ? Object.keys(design.overrides.byName).length
    : 0);
  return {
    preset: design.preset,
    streetScale: design.streetScale,
    sidewalkScale: design.sidewalkScale,
    residentialAsphaltM: Number(residential.asphaltWidth.toFixed(2)),
    residentialSidewalkM: Number(residential.sidewalkWidth.toFixed(2)),
    residentialRowHalfM: Number(residential.rowOuter.toFixed(2)),
    overrideCount,
  };
}

/**
 * Right-of-way cross-section for one OSM way.
 * Visual asphalt/sidewalk use streetScale / sidewalkScale, then per-street overrides.
 * Building clearance matches the visual sidewalk outer edge so streets never
 * paint through footprints.
 */
export function resolveStreetCrossSection(road, design) {
  const highway = STREET_SECTION_BASE[road?.highway] ? road.highway : 'service';
  const defaults = STREET_SECTION_BASE[highway];
  let lanes = Number(road?.lanes);
  if (!Number.isFinite(lanes) || lanes <= 0) {
    lanes = road?.oneway ? Math.max(1, Math.ceil(defaults.lanes / 2)) : defaults.lanes;
  }
  const laneCap = highway === 'motorway' || highway === 'trunk' ? 6 : 4;
  lanes = Math.max(1, Math.min(laneCap, lanes));

  const override = lookupStreetOverride(design, road);
  const streetScale = override?.streetScale ?? design.streetScale;
  const sidewalkScale = override?.sidewalkScale ?? design.sidewalkScale;
  const curbScale = override?.curbScale ?? design.curbScale;

  let asphaltHalf = (lanes * defaults.laneW * streetScale) / 2;
  let curbWidth = defaults.sidewalk > 0 ? 0.18 * curbScale : 0;
  let sidewalkWidth = defaults.sidewalk * sidewalkScale;

  // Absolute meters win over scales when provided on the override.
  if (override?.asphaltWidth != null) asphaltHalf = override.asphaltWidth / 2;
  if (override?.sidewalkWidth != null) {
    sidewalkWidth = override.sidewalkWidth;
    if (sidewalkWidth <= 0.05) curbWidth = 0;
    else if (defaults.sidewalk > 0 && curbWidth <= 0) curbWidth = 0.18 * curbScale;
  }

  const sidewalkInner = asphaltHalf + curbWidth;
  const sidewalkOuter = sidewalkInner + sidewalkWidth;
  const rowOuter = sidewalkOuter + 0.12;

  // Floor from soft scales, but never less than the visible sidewalk edge.
  const softAsphaltHalf = (lanes * defaults.laneW * design.buildingStreetScale) / 2;
  const softCurb = defaults.sidewalk > 0 ? 0.15 * design.buildingCurbScale : 0;
  const softSidewalk = defaults.sidewalk * design.buildingSidewalkScale;
  const softRow = softAsphaltHalf + softCurb + softSidewalk + design.buildingClearance;
  const buildingRowOuter = Math.max(rowOuter, softRow);

  // Match three-roads ribbon width to the city-wide asphalt strip.
  const drivingLaneWidth = Math.max(2.6, (asphaltHalf * 2) / Math.max(1, lanes));
  const templateSidewalkWidth = Math.max(1.8, sidewalkWidth || 0);

  return {
    highway,
    lanes,
    asphaltHalf,
    asphaltWidth: asphaltHalf * 2,
    curbWidth,
    sidewalkWidth,
    curbCenter: asphaltHalf + curbWidth * 0.5,
    sidewalkCenter: sidewalkInner + sidewalkWidth * 0.5,
    sidewalkInner,
    sidewalkOuter,
    rowOuter,
    buildingRowOuter,
    hasSidewalk: sidewalkWidth > 0.05,
    hasCurb: curbWidth > 0.05,
    drivingLaneWidth,
    templateSidewalkWidth,
    override: override || null,
    streetScale,
    sidewalkScale,
  };
}
