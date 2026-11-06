import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesizing bundles the Lambda code with esbuild once per process.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
