import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Configuration and migration tests mutate process-wide state and a shared
    // database. Disabling file parallelism keeps one fork and preserves
    // deterministic execution under Vitest 4.
    pool: 'forks',
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20_000,
  },
});
