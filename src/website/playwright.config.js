import { defineConfig, devices } from '@playwright/test';

// [WEB-DESIGN-MEDIA] Windows WebKit rejects known-good H.264. Keep phone viewport/touch coverage
// on installed Chrome there, and WebKit elsewhere, without skipping decoding.
const phoneBrowser = process.platform === 'win32' ? { browserName: 'chromium', channel: 'chrome' } : {};

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8081',
    trace: 'on-first-retry',
  },
  projects: [
    // The Windows system decoder failed where bundled Chromium/WebKit passed.
    // Keep the regression on installed browsers, with their default GPU settings.
    ...(process.platform === 'win32' ? ['chrome', 'msedge'].map((channel) => ({
      name: channel,
      testMatch: 'video-playback.spec.js',
      use: { ...devices['Desktop Chrome'], channel },
    })) : []),
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'iPhone SE',
      use: { ...devices['iPhone SE'], ...phoneBrowser },
    },
    {
      name: 'iPhone 14',
      use: { ...devices['iPhone 14'], ...phoneBrowser },
    },
  ],
  webServer: {
    command: 'npx @11ty/eleventy --serve --port=8081',
    url: 'http://localhost:8081',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
