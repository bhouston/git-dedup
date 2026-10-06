import { defineConfig } from 'vitest/config';

// Runs the behavior suites against the native binary named by GIT_DEDUP_BIN (see scripts/native-test.mjs).
// handlers and inprocess tests exercise the Node CLI's internals, so they stay with the Node suite.
export default defineConfig({
  test: {
    include: ['packages/core/test/**/*.test.ts', 'packages/cli/src/{cli,discover}.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
