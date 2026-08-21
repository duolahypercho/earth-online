// The one place a capture round decides what resolution it is shooting at.
//
// Every round this project has ever run reported `meetsProtocolResolution
// false`, and the last one was believed to have been launched at 1280x720 while
// it wrote 1600x900 PNGs. That belief could not be checked, because the report
// recorded only the RESOLVED numbers - never the raw environment it resolved
// them from, never the viewport the browser actually opened, and never the
// pixel size of the PNGs it wrote. Three different things were being called
// "the resolution" and nothing compared them.
//
// So the resolution lives here, is resolved once from a passed-in environment
// (which makes it testable without a browser), and records its own provenance.
// `scripts/qa/probe-capture-resolution-v1.mjs` exercises this same function and
// then measures the chain end to end for a few seconds and no world build.

/** The gate's blind-review protocol: 16:9, 1440p or higher. */
export function meetsProtocolResolution(width, height) {
  return Number.isFinite(width) && Number.isFinite(height)
    && height >= 1440 && Math.abs(width / height - 16 / 9) < 0.02;
}

const positiveInt = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

/**
 * Resolve the capture resolution, and say where every number came from.
 *
 * An unparsable SF_QA_W used to become `Number('720p') === NaN` and be handed
 * straight to the browser as a viewport dimension. It is now refused, reported,
 * and replaced by the default, so a typo cannot silently decide what a review
 * round looks like.
 */
export function resolveCaptureResolution(env = process.env) {
  const rawW = env.SF_QA_W ?? null;
  const rawH = env.SF_QA_H ?? null;
  const rawProtocol = env.SF_QA_PROTOCOL ?? null;
  const protocolFlag = rawProtocol === '1';
  const defaults = { w: protocolFlag ? 2560 : 1280, h: protocolFlag ? 1440 : 720 };
  const invalid = [];
  const pick = (raw, name, fallback) => {
    const parsed = positiveInt(raw);
    if (parsed === null) return { value: fallback, source: protocolFlag ? 'SF_QA_PROTOCOL default' : 'harness default' };
    if (Number.isNaN(parsed)) {
      invalid.push(`${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}`);
      return { value: fallback, source: `${name} REJECTED (not a positive integer)` };
    }
    return { value: parsed, source: name };
  };
  const w = pick(rawW, 'SF_QA_W', defaults.w);
  const h = pick(rawH, 'SF_QA_H', defaults.h);
  return {
    w: w.value,
    h: h.value,
    protocolFlag,
    // The raw strings this process actually received. If a round comes out at a
    // size nobody expected, this is the field that answers whether the launcher
    // asked for it.
    raw: { SF_QA_W: rawW, SF_QA_H: rawH, SF_QA_PROTOCOL: rawProtocol },
    source: { width: w.source, height: h.source },
    invalid,
    aspect: +(w.value / h.value).toFixed(4),
    meetsProtocol: meetsProtocolResolution(w.value, h.value),
  };
}

/**
 * Compare what was asked for, what the browser opened, and what was written.
 *
 * These are three separate facts and the round is only trustworthy when they
 * agree; `agrees` is false the moment they do not.
 */
export function compareResolution({ resolved, viewport, png }) {
  const pair = (v) => (v && Number.isFinite(v.w) && Number.isFinite(v.h) ? [v.w, v.h] : null);
  const requested = resolved ? [resolved.w, resolved.h] : null;
  const opened = pair(viewport);
  const written = pair(png);
  const same = (a, b) => !!(a && b && a[0] === b[0] && a[1] === b[1]);
  const mismatches = [];
  if (opened && !same(requested, opened)) {
    mismatches.push(`browser viewport ${JSON.stringify(opened)} != requested ${JSON.stringify(requested)}`);
  }
  if (written && !same(requested, written)) {
    mismatches.push(`written PNG ${JSON.stringify(written)} != requested ${JSON.stringify(requested)}`);
  }
  return {
    requested,
    browserViewport: opened,
    writtenPng: written,
    agrees: mismatches.length === 0,
    mismatches,
    // The gate's condition is the DELIVERED PIXELS, not the intent. When a PNG
    // has been measured it decides; before that, the request stands in.
    meetsProtocolResolution: written
      ? meetsProtocolResolution(written[0], written[1])
      : meetsProtocolResolution(requested?.[0], requested?.[1]),
    decidedBy: written ? 'measured PNG pixels' : 'requested viewport (no frame measured yet)',
  };
}

export default resolveCaptureResolution;
