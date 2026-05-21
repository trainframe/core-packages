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
        // Operator HTTP surface. Every endpoint is exercised end-to-end by
        // @trainframe/integration's admin-http.test.ts hitting the real
        // server through real HTTP; a parallel unit suite here would just
        // restate the integration tests with mocks.
        'src/admin-http.ts',
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
