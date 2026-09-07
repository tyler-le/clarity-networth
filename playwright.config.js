import { defineConfig, devices } from '@playwright/test';

const networkDisabled = Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED);

export default defineConfig({
  testDir: './test/ui',
  timeout: 30_000,
  // The demo server intentionally has shared in-memory preview state. Keep UI
  // verification serial everywhere so a developer's multi-core machine runs
  // the same deterministic suite as GitHub Actions.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // UI tests should select durable, intentional hooks where semantics alone
    // are insufficient. This prevents markup rearrangements from becoming
    // release blockers while keeping accessibility-first locators preferred.
    testIdAttribute: 'data-testid',
    browserName: 'chromium',
    // Service-worker lifecycle belongs to the PWA/browser boundary, not every
    // visual journey. Block it here so a newly claimed worker cannot reload a
    // page halfway through a deterministic UI test.
    serviceWorkers: 'block',
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
    command: 'node src/server.js',
    url: 'http://127.0.0.1:4173/api/health',
    // Test runs must own their server. Reusing an unrelated local dev server
    // makes long multi-viewport suites flaky when that process restarts or
    // exits underneath Playwright. Opt in only for deliberate debugging.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === 'true',
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
