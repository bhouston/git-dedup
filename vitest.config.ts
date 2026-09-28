import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/{core,cli}/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
