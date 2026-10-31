import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'web/tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:8000/', viewport: { width: 1400, height: 900 } },
  webServer: {
    command: 'vite build && vite preview',
    url: 'http://localhost:8000/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /support\.spec\.ts/ },
  ],
});
