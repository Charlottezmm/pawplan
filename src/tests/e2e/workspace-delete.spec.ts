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

async function mockSettingsApis(page: import("@playwright/test").Page) {
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      json: {
        routines: [],
        segmentEnergySettings: [
          { segment: "morning", energyLevel: "high" },
          { segment: "afternoon", energyLevel: "medium" },
          { segment: "evening", energyLevel: "low" },
        ],
        recoveryTarget: { minutes: 480, editable: false, source: "system_default" },
      },
    });
  });

  await page.route("**/api/mcp-tokens", async (route) => {
    await route.fulfill({
      json: {
        workspaceId: "00000000-0000-0000-0000-000000000001",
        tokens: [],
        mcp: { url: "https://pawplan.example/api/mcp", codexConfig: "[mcp_servers.pawplan]" },
      },
    });
  });
}

test("requires typed workspace confirmation before enabling delete", async ({ context, page }) => {
  await addWorkspaceSession(context);
  await mockSettingsApis(page);

  let deleteCalls = 0;
  await page.route("**/api/workspace", async (route) => {
    deleteCalls += 1;
    await route.fulfill({ status: 500, json: { error: "Delete should stay disabled" } });
  });

  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "危险操作" })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除计划空间" })).toBeDisabled();

  await page.getByLabel("删除确认").fill("DELETE Wrong Name");
  await expect(page.getByRole("button", { name: "删除计划空间" })).toBeDisabled();
  expect(deleteCalls).toBe(0);
});

test("deletes workspace from Settings after exact typed confirmation", async ({ context, page }) => {
  await addWorkspaceSession(context);
  await mockSettingsApis(page);

  let deleteBody: unknown = null;
  await page.route("**/api/workspace", async (route) => {
    deleteBody = route.request().postDataJSON();
    await route.fulfill({
      headers: {
        "Set-Cookie": "daily_progress_workspace=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly",
      },
      json: { deleted: true },
    });
  });

  await page.goto("/settings");
  await page.getByLabel("计划空间名称").fill("Focus Lab");
  await page.getByLabel("删除确认").fill("DELETE Focus Lab");
  const deleteButton = page.getByRole("button", { name: "删除计划空间" });
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();

  expect(deleteBody).toEqual({ confirmation: "DELETE Focus Lab" });
  await expect(page).toHaveURL(/\/login$/);
});
