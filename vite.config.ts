import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'web',
  // GitHub Pages serves the site from a project sub-path.
  base: './',
  // Chrome keeps the font and serial permissions per origin, so keep this port.
  server: { port: 8000, strictPort: true },
  preview: { port: 8000, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
    testTimeout: 30_000,
  },
});
