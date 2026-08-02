import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureScreenshotWithDiagnostics,
  detectScreenshotImageType,
  isIsoTimestamp,
} from './qa-capture-diagnostics.mjs';

function makeBrowser(tabId) {
  return {
    browserId: 'browser-test',
    name: 'Mock Browser',
    tabs: {
      list: async () => [{ id: tabId, url: 'http://localhost:5173/', title: 'Test page' }],
    },
  };
}

function makeTab({ bytes, logs = [], overlay = null, cdp = null, screenshot = null } = {}) {
  const tab = {
    id: 'tab-test',
    gameAlive: true,
    screenshot: screenshot || (async () => bytes),
    url: async () => 'http://localhost:5173/',
    title: async () => 'Test page',
    playwright: {
      evaluate: async () => overlay,
    },
    dev: {
      logs: async () => logs,
    },
  };
  if (cdp) {
    tab.capabilities = {
      get: async (name) => {
        assert.equal(name, 'cdp');
        return cdp;
      },
    };
  }
  return tab;
}

test('successful capture preserves bytes and returns browser/page/runtime diagnostics', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const networkEvents = [
    {
      method: 'Network.loadingFailed',
      sequence: 7,
      params: {
        requestId: 'req-1',
        url: 'http://localhost:5173/missing.glb',
        errorText: 'net::ERR_FILE_NOT_FOUND',
        type: 'Other',
      },
    },
    {
      method: 'Network.responseReceived',
      sequence: 8,
      params: {
        requestId: 'req-2',
        type: 'Script',
        response: {
          url: 'http://localhost:5173/broken.js',
          status: 503,
          statusText: 'Service Unavailable',
          mimeType: 'text/javascript',
        },
      },
    },
  ];
  let readCount = 0;
  const cdp = {
    send: async (method) => assert.equal(method, 'Network.enable'),
    readEvents: async () => {
      readCount += 1;
      return readCount === 1
        ? { cursor: 8, events: networkEvents }
        : { cursor: 8, events: [] };
    },
  };
  const overlay = {
    selector: '#runtime-error',
    tagName: 'div',
    id: 'runtime-error',
    className: 'runtime-error visible',
    text: 'Uncaught Error: test overlay',
  };
  const tab = makeTab({
    bytes,
    overlay,
    cdp,
    logs: [
      { level: 'error', message: 'shader compile failed', timestamp: '2026-08-01T00:00:00.000Z', url: 'http://localhost:5173/' },
      { level: 'warn', message: 'fallback asset', timestamp: '2026-08-01T00:00:01.000Z', url: 'http://localhost:5173/' },
      { level: 'info', message: 'ignored info log' },
    ],
  });
  const browser = makeBrowser(tab.id);
  const screenshotOptions = { fullPage: false };
  const result = await captureScreenshotWithDiagnostics({
    tab,
    browser,
    caller: { test: 'success', pass: 1 },
    screenshotOptions,
  });

  assert.strictEqual(result.image, bytes, 'capture bytes must be returned untouched');
  assert.deepEqual(result.image, bytes);
  assert.equal(result.diagnostics.status, 'success');
  assert.equal(isIsoTimestamp(result.diagnostics.timestamp), true);
  assert.deepEqual(result.diagnostics.caller, { test: 'success', pass: 1 });
  assert.equal(result.diagnostics.browserConnection.status, 'connected');
  assert.equal(result.diagnostics.browserConnection.connected, true);
  assert.equal(result.diagnostics.pageUrl, 'http://localhost:5173/');
  assert.deepEqual(result.diagnostics.runtimeErrorOverlay, overlay);
  assert.equal(result.diagnostics.consoleErrors.length, 1);
  assert.equal(result.diagnostics.consoleWarnings.length, 1);
  assert.equal(result.diagnostics.failedNetworkRequests.length, 2);
  assert.equal(result.diagnostics.failedNetworkRequests[0].errorText, 'net::ERR_FILE_NOT_FOUND');
  assert.equal(result.diagnostics.failedNetworkRequests[1].status, 503);
  assert.deepEqual(result.diagnostics.screenshotImage, {
    format: 'png',
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    suggestedExtension: '.png',
    jpegVariant: null,
    outputPath: null,
    actualExtension: null,
    savedExtension: null,
    saveStatus: 'not-requested',
  });
  assert.equal(result.diagnostics.screenshotException, null);
  assert.equal(result.diagnostics.saveException, null);
  assert.deepEqual(result.diagnostics.diagnosticsErrors, []);
});

test('detects PNG and JPEG/JFIF magic bytes truthfully', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jfif = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]);

  assert.deepEqual(detectScreenshotImageType(png), {
    format: 'png',
    mimeType: 'image/png',
    byteLength: png.byteLength,
    suggestedExtension: '.png',
    jpegVariant: null,
  });
  assert.deepEqual(detectScreenshotImageType(jfif), {
    format: 'jpeg',
    mimeType: 'image/jpeg',
    byteLength: jfif.byteLength,
    suggestedExtension: '.jpg',
    jpegVariant: 'jfif',
  });
});

test('matching extension saves exact bytes and reports the saved extension', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qa-capture-diagnostics-'));
  const outputPath = join(directory, 'capture.jpg');
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03,
  ]);
  const tab = makeTab({ bytes });

  try {
    const result = await captureScreenshotWithDiagnostics({
      tab,
      browser: makeBrowser(tab.id),
      outputPath,
    });

    assert.strictEqual(result.image, bytes);
    assert.equal(result.diagnostics.status, 'success');
    assert.equal(result.diagnostics.screenshotImage.mimeType, 'image/jpeg');
    assert.equal(result.diagnostics.screenshotImage.byteLength, bytes.byteLength);
    assert.equal(result.diagnostics.screenshotImage.suggestedExtension, '.jpg');
    assert.equal(result.diagnostics.screenshotImage.actualExtension, '.jpg');
    assert.equal(result.diagnostics.screenshotImage.savedExtension, '.jpg');
    assert.equal(result.diagnostics.screenshotImage.saveStatus, 'saved');
    assert.equal(result.diagnostics.saveException, null);
    assert.deepEqual(new Uint8Array(await readFile(outputPath)), bytes);
  } finally {
    await unlink(outputPath);
    await rmdir(directory);
  }
});

test('mismatched extension is rejected without writing screenshot bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qa-capture-diagnostics-'));
  const outputPath = join(directory, 'capture.png');
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]);
  const tab = makeTab({ bytes });

  try {
    const result = await captureScreenshotWithDiagnostics({
      tab,
      browser: makeBrowser(tab.id),
      outputPath,
    });

    assert.strictEqual(result.image, bytes);
    assert.equal(result.diagnostics.status, 'failed');
    assert.equal(result.diagnostics.screenshotImage.actualExtension, '.png');
    assert.equal(result.diagnostics.screenshotImage.savedExtension, null);
    assert.equal(result.diagnostics.screenshotImage.saveStatus, 'failed');
    assert.equal(
      result.diagnostics.saveException.exact,
      'TypeError: Refusing to save image/jpeg screenshot bytes with extension ".png"; use ".jpg"',
    );
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    await rmdir(directory);
  }
});

test('controlled screenshot exception preserves its exact cause without mutating the page/game', async () => {
  const expected = new Error('controlled screenshot-call failure');
  const tab = makeTab({
    screenshot: async () => {
      tab.gameAlive = true;
      throw expected;
    },
    logs: [{ level: 'warn', message: 'warning remains observable' }],
  });
  const result = await captureScreenshotWithDiagnostics({
    tab,
    browser: makeBrowser(tab.id),
    caller: 'controlled-failure-test',
  });

  assert.equal(result.image, null);
  assert.equal(result.diagnostics.status, 'failed');
  assert.equal(result.diagnostics.screenshotException.name, 'Error');
  assert.equal(result.diagnostics.screenshotException.message, expected.message);
  assert.equal(result.diagnostics.screenshotException.exact, String(expected));
  assert.equal(result.diagnostics.screenshotImage, null);
  assert.equal(result.diagnostics.saveException, null);
  assert.equal(result.diagnostics.browserConnection.connected, true);
  assert.equal(result.diagnostics.consoleWarnings.length, 1);
  assert.equal(tab.gameAlive, true, 'a screenshot failure must not break game state');
});
