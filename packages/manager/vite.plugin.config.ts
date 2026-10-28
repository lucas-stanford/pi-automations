import { defineConfig } from 'vite';

// pi-automations installs this package from git without its dependencies, so the plugin bundle uses node built-ins only.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'server/plugin.ts',
    outDir: 'plugin',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'index.js', chunkFileNames: '[name].js' },
    },
  },
});