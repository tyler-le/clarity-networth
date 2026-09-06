import { defineConfig, devices } from '@playwright/test';

const networkDisabled = Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED);

export default defineConfig({
  testDir: './test/ui',
  timeout: 30_000,
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  // Every browser journey runs at the breakpoints we actively support. This
  // catches layout regressions before staging, rather than treating mobile as
  // a separate afterthought.
  projects: [
    { name: 'phone', use: { ...devices['iPhone 13'] } },
    {
      name: 'tablet',
      use: {
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: false
      }
    },
    {
      name: 'laptop',
      use: {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false
      }
    },
    {
      name: 'desktop',
      use: {
        viewport: { width: 1680, height: 1000 },
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false
      }
    }
  ],
  webServer: networkDisabled ? undefined : {
    command: 'node server.js',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      PORT: '4173',
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      DATA_DIR: '.playwright-data',
      ENCRYPTION_KEY: 'playwright-test-encryption-key'
    }
  }
});
