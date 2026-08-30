import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

function signedWorkspaceSession(workspaceId: string) {
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  return `${workspaceId}.${signature}`;
}

test("review route frames suggestions as user-reviewed drafts, not applied changes", async ({ context, page }) => {
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
  const onboardingEvents: unknown[] = [];
  await page.route("**/api/onboarding", async (route) => {
    if (route.request().method() === "PATCH") {
      onboardingEvents.push(route.request().postDataJSON());
    }
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto("/review");

  await expect(page.getByRole("heading", { name: "审核", exact: true })).toBeVisible();
  await expect(page.getByText("这些是待确认的调整建议，只有你确认后才会生效。")).toBeVisible();
  await expect(page.getByText("日常与恢复时间受保护，不会自动修改；所有调整建议只有在你确认并通过最终核对后才会写入。")).toBeVisible();
  await expect(page.getByText("待审核建议")).toBeVisible();
  await expect(page.getByText("任务调整 0")).toBeVisible();
  await expect(page.getByText("日程导入 0")).toBeVisible();
  await expect(page.getByText("受保护 0")).toBeVisible();
  await expect(page.getByText("已跳过 0")).toBeVisible();
  await expect(page.getByText("冲突 0")).toBeVisible();
  await expect(page.getByText("0 份建议 · 0 项调整")).toBeVisible();
  await expect(page.getByRole("button", { name: "清空全部待审核建议" })).toHaveCount(0);
  await expect(page.getByText("提交前会重查任务状态和固定日程冲突。")).toBeVisible();
  await expect(page.getByText("已应用")).toHaveCount(0);
  await expect.poll(() => onboardingEvents).toEqual([{ eventKey: "review_opened" }]);
});

test("review onboarding recorder failure does not block the Review page", async ({ context, page }) => {
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
  await page.route("**/api/onboarding", async (route) => {
    await route.fulfill({ status: 500, json: { error: "failed" } });
  });

  await page.goto("/review");

  await expect(page.getByRole("heading", { name: "审核", exact: true })).toBeVisible();
  await expect(page.getByText("这些是待确认的调整建议，只有你确认后才会生效。")).toBeVisible();
});
