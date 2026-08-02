import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        realmap: resolve(import.meta.dirname, 'realmap.html'),
      },
    },
  },
});
