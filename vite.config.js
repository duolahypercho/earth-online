import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { defineConfig } from 'vite';

const pluginsDirectory = resolve(import.meta.dirname, 'plugins');
const pluginVerificationInputs = Object.fromEntries(
  readdirSync(pluginsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [
      `plugin-${entry.name}`,
      resolve(pluginsDirectory, entry.name, 'verify.html'),
    ]),
);

export default defineConfig({
  // GitHub Pages serves this repo at /earth-online/; local dev stays at /.
  base: process.env.GITHUB_PAGES === 'true' ? '/earth-online/' : '/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        about: resolve(import.meta.dirname, 'about.html'),
        realmap: resolve(import.meta.dirname, 'realmap.html'),
        citygen: resolve(import.meta.dirname, 'citygen.html'),
        sfMap: resolve(import.meta.dirname, 'sf-map.html'),
        vehiclePreview: resolve(import.meta.dirname, 'vehicle-preview.html'),
        pluginCatalog: resolve(import.meta.dirname, 'plugins/index.html'),
        ...pluginVerificationInputs,
      },
    },
  },
});
