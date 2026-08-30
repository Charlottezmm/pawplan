import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

function signedWorkspaceSession(workspaceId: string) {
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  return `${workspaceId}.${signature}`;
}

test("renders owner invite admin with invite and workspace tables", async ({ context, page }) => {
  await context.addCookies([
    {
      name: "daily_progress_workspace",
      value: signedWorkspaceSession("owner-workspace"),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  await page.route("**/api/admin/invites", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        json: {
          invite: {
            id: "invite-2",
            label: "Bob",
            maxRedemptions: 1,
            redemptionCount: 0,
            expiresAt: "2026-07-22T00:00:00.000Z",
            disabledAt: null,
            createdAt: "2026-06-22T02:00:00.000Z",
            inviteUrl: "https://pawplan.example/join/PAW-BOB",
          },
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        inviteUrlBase: "https://pawplan.example/join",
        invites: [
          {
            id: "invite-1",
            label: "Alice",
            maxRedemptions: 1,
            redemptionCount: 1,
            expiresAt: "2026-07-22T00:00:00.000Z",
            disabledAt: null,
            createdAt: "2026-06-22T00:00:00.000Z",
          },
        ],
        workspaces: [
          {
            workspaceId: "workspace-1",
            workspaceName: "Alice Plan",
            workspaceCreatedAt: "2026-06-22T01:00:00.000Z",
            inviteLabel: "Alice",
            inviteMaxRedemptions: 1,
            inviteRedemptionCount: 1,
            inviteExpiresAt: "2026-07-22T00:00:00.000Z",
            inviteDisabledAt: null,
          },
        ],
      },
    });
  });

  await page.goto("/admin/invites");

  await expect(page.getByRole("heading", { name: "邀请管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "邀请链接", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "已创建计划空间" })).toBeVisible();
  await expect(page.getByText("Alice Plan")).toBeVisible();
  await page.getByPlaceholder("邀请备注").fill("Bob");
  await page.getByRole("button", { name: "创建邀请链接" }).click();
  await expect(page.getByText("https://pawplan.example/join/PAW-BOB")).toBeVisible();
});
