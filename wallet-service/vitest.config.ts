import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The suites share one PostgreSQL database and truncate between tests.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
