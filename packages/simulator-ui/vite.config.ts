/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: process.env.SIMULATOR_UI_BASE ?? '/',
  server: { port: 5174 },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react')) return 'react-vendor';
          if (id.includes('node_modules/mqtt')) return 'mqtt-vendor';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test-setup.ts',
        'src/main.tsx',
        /* Visual demo-scenario views — pure SVG scaffolding that mounts the physics
         * engine and renders it. There is no logic to unit-test (the engine they
         * drive lives in `@trainframe/simulator` and is tested there); they are
         * verified end-to-end via the Playwright `?physics=` journeys, not units.
         * Excluded so the floor measures the logic-bearing rendering code, not the
         * coverage of SVG markup. */
        'src/components/BridgeRunoffScenarioView.tsx',
        'src/components/CraneDropScenarioView.tsx',
        'src/components/DepotScenarioView.tsx',
        'src/components/InterestingLayoutView.tsx',
        'src/components/LiftBridgeArt.tsx',
        'src/components/LiftBridgeScenarioView.tsx',
        'src/components/RailyardPiecesView.tsx',
        'src/components/TurntableScenarioView.tsx',
        'src/components/YardScenarioView.tsx',
      ],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
  },
});
