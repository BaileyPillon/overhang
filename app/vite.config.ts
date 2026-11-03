import { defineConfig } from 'vite';

// Multi-page static build: index.html (the paper) and catalog.html (the searchable catalog).
// Paths are relative to the project root (where vite is run).
export default defineConfig({
  build: {
    chunkSizeWarningLimit: 700, // three.js lives in the lazily loaded globe chunk
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html',
        catalog: 'catalog.html',
      },
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
