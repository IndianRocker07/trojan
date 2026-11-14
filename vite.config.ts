import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        models: resolve(__dirname, 'models.html'),
        renderTest: resolve(__dirname, 'render-test.html'),
        uiTest: resolve(__dirname, 'ui-test.html'),
      },
    },
  },
});
