import { expect, test, type BrowserContext } from "@playwright/test";
import { createHmac } from "node:crypto";

function signedWorkspaceSession(workspaceId: string) {
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  return `${workspaceId}.${signature}`;
}

async function addWorkspaceSession(context: BrowserContext) {
  await context.addCookies([
    {
      name: "daily_progress_workspace",
      value: signedWorkspaceSession("00000000-0000-0000-0000-000000000001"),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

const template = {
  schemaVersion: "pawplan.template.v0.4",
  exportedAt: "2026-06-12T00:00:00.000Z",
  workspace: { name: "E2E Workspace" },
  tracks: [],
  courses: [],
  routines: [],
  segmentEnergySettings: [
    { segment: "morning", energyLevel: "high" },
    { segment: "afternoon", energyLevel: "medium" },
    { segment: "evening", energyLevel: "low" },
  ],
  timeBlocks: [],
  tasks: [
    {
      id: "template-task",
      title: "Template task",
      notes: null,
      date: "2026-06-12T00:00:00.000Z",
      daySegment: "morning",
      status: "todo",
      priority: "normal",
      estimatedMinutes: 30,
      energyLevel: "medium",
      movable: true,
      courseId: null,
      trackId: null,
      parentTaskId: null,
    },
  ],
};

test("exports and imports a safe workspace template from Settings", async ({ context, page }) => {
  await addWorkspaceSession(context);

  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      json: {
        routines: [],
        segmentEnergySettings: template.segmentEnergySettings,
        recoveryTarget: { minutes: 480, editable: false, source: "system_default" },
      },
    });
  });

  await page.route("**/api/mcp-tokens", async (route) => {
    await route.fulfill({
      json: {
        workspaceId: "00000000-0000-0000-0000-000000000001",
        tokens: [],
        mcp: {
          url: "https://pawplan.example/api/mcp",
          codexConfig: "[mcp_servers.pawplan]",
        },
      },
    });
  });

  await page.route("**/api/templates/export", async (route) => {
    await route.fulfill({ json: template });
  });

  let importedBody: unknown = null;
  await page.route("**/api/templates/import", async (route) => {
    importedBody = route.request().postDataJSON();
    await route.fulfill({
      json: { planId: "plan-from-template", tasksCreated: 1, routinesCreated: 0, timeBlocksCreated: 0 },
    });
  });

  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "计划空间模板" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出计划空间模板" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/pawplan-template-.*\.json/);
  await expect(page.getByText("计划空间模板已导出。")).toBeVisible();

  await page.getByLabel("导入模板").setInputFiles({
    name: "pawplan-template.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(template)),
  });

  await expect(page.getByText("模板已导入：1 个任务、0 项日常安排、0 个固定日程。")).toBeVisible();
  expect(importedBody).toEqual({ template, mode: "new_plan" });
});
