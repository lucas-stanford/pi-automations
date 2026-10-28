/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: process.env.MANAGER_URL
      ? {
          '/api': {
            target: process.env.MANAGER_URL,
            changeOrigin: true,
            configure(proxy) {
              proxy.on('proxyReq', (req) => {
                req.removeHeader('origin');
                req.removeHeader('sec-fetch-site');
              });
            },
          },
        }
      : undefined,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 15_000,
    // `server/` runs in node; its files say so with `@vitest-environment node`.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'server/**/*.test.ts'],
  },
});
