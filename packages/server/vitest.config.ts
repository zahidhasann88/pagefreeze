import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *  - `unit` runs everywhere and needs no external services.
 *  - `integration` needs a real PostgreSQL (DATABASE_URL_TEST or the default local one)
 *    and a Playwright browser; it skips itself with a clear message when unavailable.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
          exclude: ['tests/integration/**', 'node_modules/**'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          // Real browser + real database: keep it single-threaded and deterministic.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/scripts/**',
        'src/index.ts',
        'src/**/worker.ts',
        'src/fixtures/**',
        // Type-only modules and ambient declarations contain no executable code.
        'src/types/**',
        'src/api/deps.ts',
        'src/api/types.ts',
        'src/context.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
