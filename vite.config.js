import { defineConfig } from 'vite';

export default defineConfig({
  // Set BASE_PATH (e.g. /TemenCAD/) when deploying under a sub-path such as GitHub Pages.
  base: process.env.BASE_PATH || '/',
  worker: { format: 'es' },
  build: { rolldownOptions: { input: { main: 'index.html', api: 'api.html' } } },
});
