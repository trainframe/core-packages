import { defineConfig } from '@playwright/test';

const SIM_PORT = 4173;
const VISUALISER_PORT = 4174;
export const SIM_URL = `http://127.0.0.1:${SIM_PORT}`;
export const VISUALISER_URL = `http://127.0.0.1:${VISUALISER_PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: SIM_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @trainframe/simulator-ui exec vite preview --host 127.0.0.1 --port ${SIM_PORT} --strictPort`,
      url: SIM_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm --filter @trainframe/visualiser exec vite preview --host 127.0.0.1 --port ${VISUALISER_PORT} --strictPort`,
      url: VISUALISER_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
