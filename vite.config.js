import { defineConfig } from 'vite';

export default defineConfig({
  // manifold-3d ships an Emscripten module that locates its .wasm itself; keep it out of the pre-bundler.
  optimizeDeps: { exclude: ['manifold-3d'] },
  worker: { format: 'es' },
  build: { rolldownOptions: { input: { main: 'index.html', api: 'api.html' } } },
});
