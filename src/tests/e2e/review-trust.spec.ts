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
  await expect(page.getByText(/保护规则.*日常与恢复时间不会自动修改/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "待审核建议", exact: true })).toBeVisible();
  await expect(page.getByText("0 项待审核")).toBeVisible();
  await expect(page.getByRole("heading", { name: "现在没有待审核建议" })).toBeVisible();
  await expect(page.getByText("任务调整 0")).toHaveCount(0);
  await expect(page.getByText("日程导入 0")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "清空全部待审核建议" })).toHaveCount(0);
  await expect(page.getByText("需要你确认的任务与日程调整会集中显示在这里。")).toBeVisible();
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
