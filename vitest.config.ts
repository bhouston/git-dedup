import { defineConfig } from 'vitest/config';

// The behavior suites run against the native binary (see test/native.ts); `pnpm build` places it.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
