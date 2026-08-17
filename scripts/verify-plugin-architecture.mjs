import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pluginsRoot = resolve(root, 'plugins');
const manifest = JSON.parse(await readFile(resolve(pluginsRoot, 'manifest.json'), 'utf8'));
const failures = [];

function fail(message) {
  failures.push(message);
}

if (manifest.schemaVersion !== 1) fail('manifest schemaVersion must be 1');
if (manifest.worldId !== 'sf') fail('manifest worldId must be sf');
if (!Array.isArray(manifest.plugins) || manifest.plugins.length === 0) fail('manifest must register at least one plugin');

const ids = new Set();
const manifestPlugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
for (const plugin of manifestPlugins) {
  if (!plugin?.id || ids.has(plugin.id)) fail(`duplicate or missing plugin id: ${plugin?.id || '<missing>'}`);
  ids.add(plugin?.id);
  for (const field of ['name', 'owner', 'kind', 'runtimeEntry', 'verificationPage']) {
    if (typeof plugin?.[field] !== 'string' || !plugin[field]) fail(`${plugin?.id || '<missing>'} is missing ${field}`);
  }
  if (plugin?.runtimeEntry !== `plugins/${plugin.id}/index.js`) fail(`${plugin.id} runtimeEntry must use its own plugin directory`);
  if (plugin?.verificationPage !== `plugins/${plugin.id}/verify.html`) fail(`${plugin.id} verificationPage must use its own plugin directory`);

  for (const path of [plugin.runtimeEntry, plugin.verificationPage]) {
    try {
      const info = await stat(resolve(root, path));
      if (!info.isFile()) fail(`${plugin.id} expected file is not a file: ${path}`);
    } catch {
      fail(`${plugin.id} is missing ${path}`);
    }
  }

  const sourceFiles = (await readdir(resolve(pluginsRoot, plugin.id)))
    .filter((name) => name.endsWith('.js'));
  for (const sourceFile of sourceFiles) {
    const source = await readFile(resolve(pluginsRoot, plugin.id, sourceFile), 'utf8');
    const forbidden = [
      ['renderer', /\b(?:WebGPU|WebGL)Renderer\b/],
      ['animation loop', /\b(?:requestAnimationFrame|setAnimationLoop)\s*\(/],
      ['world scene', /new\s+(?:THREE\.)?Scene\s*\(/],
    ];
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) fail(`${plugin.id}/${sourceFile} creates a forbidden ${label}`);
    }
  }
}

const pluginDirectories = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const directory of pluginDirectories) {
  if (!ids.has(directory)) fail(`unregistered plugin directory: ${directory}`);
}

const registrySource = await readFile(resolve(root, 'src/plugins/registry.js'), 'utf8');
for (const id of ids) {
  if (!registrySource.includes(`../../plugins/${id}/index.js`)) fail(`${id} is not imported by the canonical registry`);
}

const runtimeSource = await readFile(resolve(root, 'src/citygen/main.js'), 'utf8');
if (!runtimeSource.includes("getWorldPlugin('sf-authoritative-metric-map')")) {
  fail('canonical CityGen runtime does not resolve the metric map through the plugin registry');
}
if (runtimeSource.includes("from './metric-tile-stream.js'")) {
  fail('canonical CityGen runtime bypasses the plugin registry for metric tiles');
}

const viteSource = await readFile(resolve(root, 'vite.config.js'), 'utf8');
if (!viteSource.includes('pluginVerificationInputs')) fail('Vite does not auto-discover plugin verification pages');

if (failures.length) {
  console.error(JSON.stringify({ result: 'FAIL', failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  result: 'PASS',
  worldId: manifest.worldId,
  plugins: [...ids],
  verificationPages: manifestPlugins.map((plugin) => plugin.verificationPage),
}, null, 2));
