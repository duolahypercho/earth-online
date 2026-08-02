/**
 * Capture a browser tab screenshot without hiding failures in the image.
 *
 * The returned image is the exact value returned by tab.screenshot(). All
 * diagnostics are kept in a companion object so callers can emit the image
 * and JSON independently.
 */

import { writeFile } from 'node:fs/promises';
import { extname } from 'node:path';

const DEFAULT_RUNTIME_ERROR_OVERLAY_SELECTORS = Object.freeze([
  '[data-runtime-error]',
  '[data-error-overlay]',
  '#runtime-error',
  '#error-overlay',
  '.runtime-error',
  '.error-overlay',
  '.vite-error-overlay',
  'vite-error-overlay',
  '[role="alert"]',
  '[aria-live="assertive"]',
]);

const NETWORK_EVENT_METHODS = Object.freeze([
  'Network.requestWillBeSent',
  'Network.loadingFailed',
  'Network.responseReceived',
]);

const ERROR_WORDS = /(?:error|exception|failed|failure|uncaught|stack overflow|not found)/i;
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jfif']);

// A capture can be repeated against one long-lived tab. Keep the CDP cursor
// per tab so each call reports only new network events after the first read.
const networkStateByTab = new WeakMap();

function isoNow() {
  return new Date().toISOString();
}

function errorRecord(error) {
  const message = error && typeof error.message === 'string'
    ? error.message
    : String(error);
  const name = error && typeof error.name === 'string' ? error.name : 'Error';
  const stack = error && typeof error.stack === 'string' ? error.stack : null;
  return {
    name,
    message,
    // `exact` is deliberately kept alongside parsed fields for reports that
    // need the original exception text verbatim.
    exact: String(error),
    stack,
  };
}

function diagnosticError(stage, error) {
  return {
    stage,
    ...errorRecord(error),
  };
}

function screenshotBytes(image) {
  if (image instanceof ArrayBuffer) return new Uint8Array(image);
  if (ArrayBuffer.isView(image)) {
    return new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
  }
  return null;
}

function hasBytesAt(bytes, expected, offset = 0) {
  if (!bytes || bytes.byteLength < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

/**
 * Identify a screenshot format from its bytes, without decoding or rewriting it.
 *
 * @param {unknown} image Screenshot value returned by tab.screenshot().
 * @returns {{format: string, mimeType: string, byteLength: number, suggestedExtension: string|null, jpegVariant: string|null}}
 */
export function detectScreenshotImageType(image) {
  const bytes = screenshotBytes(image);
  if (!bytes) {
    return {
      format: 'unknown',
      mimeType: 'application/octet-stream',
      byteLength: null,
      suggestedExtension: null,
      jpegVariant: null,
    };
  }

  if (hasBytesAt(bytes, PNG_SIGNATURE)) {
    return {
      format: 'png',
      mimeType: 'image/png',
      byteLength: bytes.byteLength,
      suggestedExtension: '.png',
      jpegVariant: null,
    };
  }

  if (hasBytesAt(bytes, [0xff, 0xd8, 0xff])) {
    return {
      format: 'jpeg',
      mimeType: 'image/jpeg',
      byteLength: bytes.byteLength,
      suggestedExtension: '.jpg',
      jpegVariant: hasBytesAt(bytes, [0x4a, 0x46, 0x49, 0x46, 0x00], 6) ? 'jfif' : null,
    };
  }

  return {
    format: 'unknown',
    mimeType: 'application/octet-stream',
    byteLength: bytes.byteLength,
    suggestedExtension: null,
    jpegVariant: null,
  };
}

function imageExtensionMatches(extension, imageType) {
  if (imageType.mimeType === 'image/png') return extension === '.png';
  if (imageType.mimeType === 'image/jpeg') return JPEG_EXTENSIONS.has(extension);
  return false;
}

async function saveScreenshot(image, outputPath, imageType, diagnostics) {
  const actualExtension = extname(outputPath).toLowerCase() || null;
  diagnostics.screenshotImage.outputPath = outputPath;
  diagnostics.screenshotImage.actualExtension = actualExtension;
  diagnostics.screenshotImage.saveStatus = 'failed';

  if (!actualExtension || !imageExtensionMatches(actualExtension, imageType)) {
    const expected = imageType.suggestedExtension || 'a recognized image extension';
    const actual = actualExtension || '(none)';
    throw new TypeError(
      `Refusing to save ${imageType.mimeType} screenshot bytes with extension "${actual}"; use "${expected}"`,
    );
  }

  const bytes = screenshotBytes(image);
  if (!bytes) throw new TypeError('Refusing to save a screenshot value that is not binary image data');
  await writeFile(outputPath, bytes);
  diagnostics.screenshotImage.savedExtension = actualExtension;
  diagnostics.screenshotImage.saveStatus = 'saved';
}

function normalizeLog(log) {
  return {
    level: typeof log?.level === 'string' ? log.level : 'unknown',
    message: typeof log?.message === 'string' ? log.message : String(log?.message ?? ''),
    timestamp: typeof log?.timestamp === 'string' ? log.timestamp : null,
    url: typeof log?.url === 'string' ? log.url : null,
  };
}

function isConsoleError(level) {
  return level === 'error';
}

function isConsoleWarning(level) {
  return level === 'warn' || level === 'warning';
}

function networkEventRecord(event) {
  const params = event?.params ?? {};
  if (event?.method === 'Network.loadingFailed') {
    const request = params.requestId == null ? null : String(params.requestId);
    return {
      kind: 'loadingFailed',
      requestId: request,
      url: typeof params.url === 'string' ? params.url : null,
      errorText: typeof params.errorText === 'string' ? params.errorText : null,
      resourceType: typeof params.type === 'string' ? params.type : null,
      canceled: params.canceled === true,
      timestamp: typeof params.timestamp === 'number' ? params.timestamp : null,
      sequence: typeof event?.sequence === 'number' ? event.sequence : null,
    };
  }

  const response = params.response ?? {};
  const status = Number(response.status);
  if (!Number.isFinite(status) || status < 400) return null;
  return {
    kind: 'httpError',
    requestId: params.requestId == null ? null : String(params.requestId),
    url: typeof response.url === 'string' ? response.url : null,
    status,
    statusText: typeof response.statusText === 'string' ? response.statusText : null,
    mimeType: typeof response.mimeType === 'string' ? response.mimeType : null,
    resourceType: typeof params.type === 'string' ? params.type : null,
    timestamp: typeof params.timestamp === 'number' ? params.timestamp : null,
    sequence: typeof event?.sequence === 'number' ? event.sequence : null,
  };
}

function appendNetworkEvents(events, state, diagnostics) {
  for (const event of Array.isArray(events) ? events : []) {
    const params = event?.params ?? {};
    const requestId = params.requestId == null ? null : String(params.requestId);
    if (event?.method === 'Network.requestWillBeSent' && requestId) {
      const requestUrl = params.request?.url;
      if (typeof requestUrl === 'string') state.requestUrls.set(requestId, requestUrl);
      continue;
    }

    const record = networkEventRecord(event);
    if (!record) continue;
    if (!record.url && record.requestId) record.url = state.requestUrls.get(record.requestId) ?? null;
    diagnostics.failedNetworkRequests.push(record);
  }
}

function uniqueNetworkEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [event.kind, event.requestId, event.url, event.sequence].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function inspectRuntimeErrorOverlay(tab, selectors, errors) {
  if (!tab?.playwright || typeof tab.playwright.evaluate !== 'function') return null;

  try {
    return await tab.playwright.evaluate(({ overlaySelectors, errorPattern }) => {
      const visible = (element) => {
        if (!element || typeof element.getBoundingClientRect !== 'function') return false;
        const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
          ? window.getComputedStyle(element)
          : null;
        const rect = element.getBoundingClientRect();
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
          return false;
        }
        return rect.width > 0 && rect.height > 0;
      };

      for (const selector of overlaySelectors) {
        let nodes;
        try {
          nodes = document.querySelectorAll(selector);
        } catch {
          continue;
        }
        for (const element of nodes) {
          if (!visible(element)) continue;
          const text = String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
          const explicitSelector = /runtime-error|error-overlay|vite-error-overlay|data-runtime-error|data-error-overlay/i.test(selector);
          if (!explicitSelector && !(new RegExp(errorPattern, 'i')).test(text)) continue;
          return {
            selector,
            tagName: String(element.tagName || '').toLowerCase() || null,
            id: element.id || null,
            className: typeof element.className === 'string' ? element.className : null,
            text,
          };
        }
      }
      return null;
    }, {
      overlaySelectors: selectors,
      errorPattern: ERROR_WORDS.source,
    });
  } catch (error) {
    errors.push(diagnosticError('runtimeErrorOverlay', error));
    return null;
  }
}

async function inspectConsole(tab, diagnostics, logsLimit, errors) {
  if (!tab?.dev || typeof tab.dev.logs !== 'function') return;

  try {
    const logs = await tab.dev.logs({
      levels: ['error', 'warn', 'warning'],
      limit: logsLimit,
    });
    for (const rawLog of Array.isArray(logs) ? logs : []) {
      const log = normalizeLog(rawLog);
      if (isConsoleError(log.level)) diagnostics.consoleErrors.push(log);
      if (isConsoleWarning(log.level)) diagnostics.consoleWarnings.push(log);
    }
  } catch (error) {
    errors.push(diagnosticError('consoleLogs', error));
  }
}

async function inspectNetwork(tab, diagnostics, errors) {
  if (!tab?.capabilities || typeof tab.capabilities.get !== 'function') return;

  let cdp;
  try {
    cdp = await tab.capabilities.get('cdp');
  } catch (error) {
    errors.push(diagnosticError('networkCapability', error));
    return;
  }
  if (!cdp || typeof cdp.readEvents !== 'function') return;

  let state = networkStateByTab.get(tab);
  try {
    if (!state) {
      if (typeof cdp.send === 'function') {
        try {
          await cdp.send('Network.enable');
        } catch (error) {
          // CDP event reading is still useful when Network.enable is already
          // active, so report but do not turn a good screenshot into failure.
          errors.push(diagnosticError('networkEnable', error));
        }
      }
      const initial = await cdp.readEvents({
        methods: NETWORK_EVENT_METHODS,
        limit: 1000,
      });
      state = { cdp, cursor: initial?.cursor, requestUrls: new Map() };
      networkStateByTab.set(tab, state);
      appendNetworkEvents(initial?.events, state, diagnostics);
    }

    const afterSequence = typeof state.cursor === 'number' ? state.cursor : undefined;
    const next = await cdp.readEvents({
      methods: NETWORK_EVENT_METHODS,
      ...(afterSequence == null ? {} : { afterSequence }),
      limit: 1000,
    });
    if (typeof next?.cursor === 'number') state.cursor = next.cursor;
    appendNetworkEvents(next?.events, state, diagnostics);
    diagnostics.failedNetworkRequests = uniqueNetworkEvents(diagnostics.failedNetworkRequests);
  } catch (error) {
    errors.push(diagnosticError('networkEvents', error));
  }
}

async function inspectBrowserConnection({ browser, tab, diagnostics, errors }) {
  let tabReachable = false;
  try {
    if (browser && browser.tabs && typeof browser.tabs.list === 'function') {
      const tabs = await browser.tabs.list();
      const tabId = tab?.id == null ? null : String(tab.id);
      // A tab may be represented by a provider-specific id; the list probe is
      // still a successful connection check even when it omits that id.
      tabReachable = Array.isArray(tabs)
        && (tabId == null || tabs.some((candidate) => String(candidate?.id) === tabId));
      if (!Array.isArray(tabs)) tabReachable = false;
    }
  } catch (error) {
    errors.push(diagnosticError('browserTabs', error));
  }

  try {
    if (tab && typeof tab.url === 'function') {
      diagnostics.pageUrl = await tab.url();
      tabReachable = true;
    }
  } catch (error) {
    errors.push(diagnosticError('pageUrl', error));
  }

  try {
    if (tab && typeof tab.title === 'function') diagnostics.pageTitle = await tab.title();
  } catch (error) {
    errors.push(diagnosticError('pageTitle', error));
  }

  diagnostics.browserConnection = {
    status: tabReachable ? 'connected' : 'disconnected',
    connected: tabReachable,
    browserId: browser?.browserId == null ? null : String(browser.browserId),
    browserName: browser?.name == null ? null : String(browser.name),
    tabId: tab?.id == null ? null : String(tab.id),
  };
}

/**
 * Capture a screenshot and return it with truthful companion diagnostics.
 *
 * @param {object} options
 * @param {object} options.tab Existing browser-client tab binding.
 * @param {object} [options.browser] Existing browser-client browser binding.
 * @param {string|object|null} [options.caller] Caller/context label to persist.
 * @param {object} [options.screenshotOptions] Options passed unchanged to tab.screenshot().
 * @param {string|null} [options.outputPath] Optional path to save exact screenshot bytes.
 * @param {string[]} [options.runtimeErrorOverlaySelectors] Additional/replacement selectors.
 * @param {number} [options.logsLimit=200] Maximum console entries to inspect.
 * @returns {Promise<{image: unknown|null, diagnostics: object}>}
 */
export async function captureScreenshotWithDiagnostics({
  tab,
  browser,
  caller = null,
  screenshotOptions = {},
  outputPath = null,
  runtimeErrorOverlaySelectors = DEFAULT_RUNTIME_ERROR_OVERLAY_SELECTORS,
  logsLimit = 200,
} = {}) {
  const startedAt = isoNow();
  const diagnostics = {
    schemaVersion: 2,
    status: 'failed',
    timestamp: startedAt,
    caller,
    browserConnection: {
      status: 'unknown',
      connected: false,
      browserId: browser?.browserId == null ? null : String(browser.browserId),
      browserName: browser?.name == null ? null : String(browser.name),
      tabId: tab?.id == null ? null : String(tab.id),
    },
    pageUrl: null,
    pageTitle: null,
    runtimeErrorOverlay: null,
    consoleErrors: [],
    consoleWarnings: [],
    failedNetworkRequests: [],
    screenshotImage: null,
    screenshotException: null,
    saveException: null,
    diagnosticsErrors: [],
  };

  await inspectBrowserConnection({ browser, tab, diagnostics, errors: diagnostics.diagnosticsErrors });

  let image = null;
  try {
    if (!tab || typeof tab.screenshot !== 'function') {
      throw new TypeError('captureScreenshotWithDiagnostics requires a tab.screenshot() function');
    }
    // Do not transform, encode, annotate, or otherwise mutate screenshot
    // bytes. The exact return value is handed back to the caller.
    image = await tab.screenshot(screenshotOptions);
    const imageType = detectScreenshotImageType(image);
    diagnostics.screenshotImage = {
      ...imageType,
      outputPath: null,
      actualExtension: null,
      savedExtension: null,
      saveStatus: 'not-requested',
    };
    diagnostics.status = 'success';

    if (outputPath != null) {
      try {
        if (typeof outputPath !== 'string' || outputPath.length === 0) {
          throw new TypeError('outputPath must be a non-empty string when provided');
        }
        await saveScreenshot(image, outputPath, imageType, diagnostics);
      } catch (error) {
        diagnostics.status = 'failed';
        diagnostics.screenshotImage.saveStatus = 'failed';
        diagnostics.saveException = errorRecord(error);
      }
    }
  } catch (error) {
    diagnostics.screenshotException = errorRecord(error);
  }

  const selectors = Array.isArray(runtimeErrorOverlaySelectors)
    ? runtimeErrorOverlaySelectors.filter((selector) => typeof selector === 'string')
    : [...DEFAULT_RUNTIME_ERROR_OVERLAY_SELECTORS];
  diagnostics.runtimeErrorOverlay = await inspectRuntimeErrorOverlay(
    tab,
    selectors.length ? selectors : DEFAULT_RUNTIME_ERROR_OVERLAY_SELECTORS,
    diagnostics.diagnosticsErrors,
  );
  await inspectConsole(tab, diagnostics, logsLimit, diagnostics.diagnosticsErrors);
  await inspectNetwork(tab, diagnostics, diagnostics.diagnosticsErrors);

  return { image, diagnostics };
}

export const DEFAULT_OVERLAY_SELECTORS = DEFAULT_RUNTIME_ERROR_OVERLAY_SELECTORS;

// Short alias for REPL callers that already have a capture-oriented helper
// namespace in scope.
export const captureWithDiagnostics = captureScreenshotWithDiagnostics;

export function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value === new Date(value).toISOString();
}
