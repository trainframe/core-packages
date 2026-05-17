import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        // CLI entry — exercised through manual smoke tests, not unit tests.
        'src/cli.ts',
        // Pure type definitions — no runtime code to cover.
        'src/broker/client.ts',
        // System-boundary adapter for the `mqtt` lib. Exercised only against
        // a real broker (see packages/integration); the contract is covered
        // via InMemoryBrokerClient.
        'src/broker/mqtt-client.ts',
      ],
      thresholds: {
        lines: 75,
        branches: 65,
        functions: 65,
        statements: 75,
      },
    },
  },
});
