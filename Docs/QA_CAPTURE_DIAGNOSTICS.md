# Screenshot capture diagnostics

`scripts/qa-capture-diagnostics.mjs` provides a browser-client-compatible
capture helper. It accepts an existing browser-client `tab` (and optionally its
`browser`) and returns two independent values:

```js
{
  image,       // exact value returned by tab.screenshot(), or null on failure
  diagnostics, // JSON-safe companion metadata
}
```

The helper never draws an error, watermark, or status text into the screenshot.
On a successful capture, `image` is returned unchanged even if a later
diagnostic probe fails. On a screenshot exception, `image` is `null` and
`diagnostics.status` is `"failed"`; `diagnostics.screenshotException.exact` is
the exact `String(error)` value.

Screenshot bytes are identified from their magic bytes, not from a filename.
When `outputPath` is supplied, the helper writes the exact bytes only if the
path extension matches the detected MIME type. A JPEG/JFIF capture requested
as `.png` is rejected and no file is written.

## REPL invocation contract

Use the already connected in-app Browser runtime and existing tab. Do not
launch a standalone Playwright browser:

```js
var { captureWithDiagnostics } = await import(
  "/Volumes/OWC 2TB EXternal SSD/Code/San Fransisco/scripts/qa-capture-diagnostics.mjs"
);
var result = await captureWithDiagnostics({
  tab,                         // existing browser-client Tab binding
  browser,                     // optional existing Browser binding
  caller: { purpose: "hero-shot", pass: 1 },
  screenshotOptions: {},       // passed unchanged to tab.screenshot()
  outputPath: "/absolute/path/capture.jpg",
});
if (result.image) await nodeRepl.emitImage(result.image);
nodeRepl.write(JSON.stringify(result.diagnostics, null, 2));
```

`iab` can be passed as `browser` when the selected binding is named `iab`.
`captureScreenshotWithDiagnostics` is the long-form export; the
`captureWithDiagnostics` export is an alias.

## Diagnostic schema

- `status`: `"success"` or `"failed"` for the screenshot call.
- `timestamp`: ISO-8601 UTC timestamp at the start of the attempt.
- `caller`: caller-supplied string/object context, unchanged.
- `browserConnection`: connection probe status, browser id/name, and tab id.
- `pageUrl` / `pageTitle`: values read from the existing tab.
- `runtimeErrorOverlay`: visible error-like DOM overlay metadata, or `null`.
- `consoleErrors` / `consoleWarnings`: captured tab logs from `tab.dev.logs`.
- `failedNetworkRequests`: CDP `Network.loadingFailed` entries and HTTP
  response entries with status 400 or greater. The helper enables Network
  events once per tab and keeps a cursor for subsequent captures.
- `screenshotImage`: detected `format`, `mimeType`, `byteLength`,
  `suggestedExtension`, optional `jpegVariant`, `outputPath`,
  `actualExtension`, `savedExtension`, and `saveStatus`. PNG uses `.png`;
  JPEG/JFIF uses canonical `.jpg` while `.jpeg` and `.jfif` are also accepted.
- `screenshotException`: `{ name, message, exact, stack }` on failure, else
  `null`.
- `saveException`: the exact save/extension failure on a requested save, else
  `null`. A mismatch changes overall `status` to `"failed"`, leaves
  `savedExtension` null, and never creates the requested file.
- `diagnosticsErrors`: errors while collecting optional metadata. These do not
  rewrite a successful screenshot status.

## Verification artifacts

The following files were produced by the in-app Browser run in this workspace:

- `.qa-streaming-continuity-round3-capture-format-success.jpg`: genuine
  45,400-byte JPEG/JFIF screenshot emitted by `tab.screenshot()` and written
  unchanged by this helper.
- `.qa-streaming-continuity-round3-capture-format-success.json`: successful
  capture diagnostics with MIME `image/jpeg` and suggested, actual, and saved
  extensions all `.jpg`.
- `.qa-streaming-continuity-round3-capture-format-controlled-failure.json`:
  controlled failure diagnostics with `screenshotException.exact =
  "Error: QA_CONTROLLED_SCREENSHOT_FAILURE_CAPTURE_FORMAT_ROUND3"`.

The controlled failure used a wrapper tab whose `screenshot()` throws and left
the original game tab binding untouched; no screenshot was emitted for that
attempt.

## Checks and limitations

`node --check scripts/qa-capture-diagnostics.mjs` and
`node --test scripts/qa-capture-diagnostics.test.mjs` pass (5 tests).

Network failures are reported from the browser-client CDP event stream. A
failure that happened before Network events were enabled or after the final
event read cannot be reconstructed. If a browser backend does not expose CDP,
the field remains an empty array and any probe error is listed in
`diagnosticsErrors`; the screenshot result is still truthful.
