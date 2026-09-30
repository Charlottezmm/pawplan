import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "src/tests/e2e", testMatch: ["assistant-ui.spec.ts", "actual-records.spec.ts", "mobile-ui-regression.spec.ts", "constraints.spec.ts"], workers: 1,
  outputDir: "../assistant-ui-evidence", reporter: "list",
  use: { baseURL: "http://127.0.0.1:3104", trace: "retain-on-failure" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"] } }],
});
