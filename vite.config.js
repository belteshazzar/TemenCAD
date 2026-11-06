import { defineConfig } from 'vite';

export default defineConfig({
  // Set BASE_PATH (e.g. /TextCAD/) when deploying under a sub-path such as GitHub Pages.
  base: process.env.BASE_PATH || '/',
  // manifold-3d ships an Emscripten module that locates its .wasm itself; keep it out of the pre-bundler.
  optimizeDeps: { exclude: ['manifold-3d'] },
  worker: { format: 'es' },
  build: { rolldownOptions: { input: { main: 'index.html', api: 'api.html' } } },
});
