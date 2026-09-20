import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "src/tests/e2e",
  testMatch: ["task-timing.spec.ts", "task-timing-failures.spec.ts"],
  workers: 1,
  timeout: 45000,
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3157",
    url: "http://127.0.0.1:3157",
    reuseExistingServer: false,
    timeout: 60000,
  },
  use: { baseURL: "http://127.0.0.1:3157", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
});
