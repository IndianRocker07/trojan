import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { jevPlugin } from './server/vitePlugin';

export default defineConfig({
  plugins: [jevPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        models: resolve(__dirname, 'models.html'),
        renderTest: resolve(__dirname, 'render-test.html'),
        uiTest: resolve(__dirname, 'ui-test.html'),
        theater: resolve(__dirname, 'theater.html'),
      },
    },
  },
});
