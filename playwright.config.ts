import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/ui',
  timeout: 20_000,
  // API-backed specs share one fixture and mutate its configuration and binding.
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8795', channel: 'msedge', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node scripts/serve-ui-fixture.mjs', url: 'http://127.0.0.1:8795', reuseExistingServer: false, timeout: 10_000 },
    { command: 'node --import tsx scripts/serve-api-fixture.ts', url: 'http://127.0.0.1:8796/health', reuseExistingServer: false, timeout: 10_000 },
  ],
});
