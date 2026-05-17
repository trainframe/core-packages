import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Cross-package wire tests open real TCP sockets — give them time.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // The integration package IS the cross-cutting coverage; gating it on
    // its own coverage thresholds would be circular.
    coverage: {
      provider: 'v8',
      enabled: false,
    },
  },
});
