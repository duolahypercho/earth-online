import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves this repo at /earth-online/; local dev stays at /.
  base: process.env.GITHUB_PAGES === 'true' ? '/earth-online/' : '/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        realmap: resolve(import.meta.dirname, 'realmap.html'),
      },
    },
  },
});
