import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/{core,cli}/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/{core,cli}/src/**/*.ts'],
      exclude: ['**/*.{test,spec}.ts', '**/*.d.ts'],
    },
  },
});
