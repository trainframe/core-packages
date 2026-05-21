import { defineConfig } from '@playwright/test';

const UI_PORT = 4173;
const UI_URL = `http://127.0.0.1:${UI_PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: UI_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: `pnpm --filter @trainframe/simulator-ui exec vite preview --host 127.0.0.1 --port ${UI_PORT} --strictPort`,
    url: UI_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
