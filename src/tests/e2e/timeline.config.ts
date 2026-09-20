import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "timeline.spec.ts", timeout: 45000,
  webServer: { command: "env -u DATABASE_URL APP_SECRET=test-secret npm run dev -- --port 3417", url: "http://127.0.0.1:3417", reuseExistingServer: false, timeout: 120000 },
  use: { baseURL: "http://127.0.0.1:3417" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }, { name: "mobile-safari", use: { ...devices["iPhone 13"] } }],
});
