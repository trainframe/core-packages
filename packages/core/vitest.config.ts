import { defineConfig } from 'vitest/config';

// Coverage thresholds.
//
// These are *minima* — they should ratchet up over time as we add tests.
// Don't lower them to match a regression. If a test legitimately can't be
// written, exclude the file or the specific line in this config.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 75,
        functions: 70,
        branches: 75,
        statements: 75,
      },
    },
  },
});
