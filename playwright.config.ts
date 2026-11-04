import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: { browserName: 'chromium', channel: 'msedge', baseURL: 'http://127.0.0.1:1421', viewport: { width: 1440, height: 960 } },
  webServer: { command: 'npm run preview -- --port 1421 --strictPort', url: 'http://127.0.0.1:1421', reuseExistingServer: false },
});
