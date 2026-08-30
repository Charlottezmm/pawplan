import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

function signedWorkspaceSession(workspaceId: string) {
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  return `${workspaceId}.${signature}`;
}

test("import page shows preview warnings and saves with explicit confirmation", async ({ context, page }) => {
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

  const saveRequests: unknown[] = [];
  await page.route("**/api/imports/plan", async (route) => {
    await route.fulfill({
      json: {
        preview: {
          goal: "ship PawPlan tomorrow",
          projects: [{ name: "PawPlan Import", deadline: "2026-06-11" }],
          constraints: [],
          timezone: "Asia/Shanghai",
          warnings: ["Duplicate project name: PawPlan Import"],
          conflicts: ["Project PawPlan Import appears 2 times in this import"],
        },
        previewToken: "plan-preview-token",
      },
    });
  });
  await page.route("**/api/imports/plan/save", async (route) => {
    saveRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { message: "Saved plan.md preview." } });
  });
  await page.route("**/api/imports/timetable", async (route) => {
    await route.fulfill({
      json: {
        preview: {
          rows: [
            {
              title: "Deep Learning Lecture",
              kind: "course",
              dayOfWeek: "Monday",
              startTime: "09:00",
              endTime: "11:00",
              startsOn: "2026-09-01",
              endsOn: "2026-09-14",
              course: "Deep Learning",
              recurrence: "weekly",
              notes: "Room 204",
            },
          ],
          timezone: "Asia/Shanghai",
          blocksPreviewed: 2,
          warnings: ["Times are interpreted in Asia/Shanghai"],
          conflicts: ["Deep Learning Lecture overlaps Existing Block"],
        },
        previewToken: "timetable-preview-token",
      },
    });
  });

  await page.goto("/import");

  await expect(page.getByLabel("Markdown 内容")).toHaveValue("");
  await expect(page.getByLabel("CSV 内容")).toHaveValue("");
  await page.getByRole("button", { name: "填入 plan.md 示例" }).click();
  await expect(page.getByLabel("Markdown 内容")).toHaveValue(/Goal: ship PawPlan tomorrow/);

  await page.getByRole("button", { name: "预览" }).first().click();
  await expect(page.getByText("目标：ship PawPlan tomorrow")).toBeVisible();
  await expect(page.getByText("提醒（1）", { exact: true })).toBeVisible();
  await expect(page.getByText("不会阻止保存，建议先确认。")).toBeVisible();
  await expect(page.getByText("冲突（1）", { exact: true })).toBeVisible();
  await expect(page.getByText("可能产生重复或重叠，保存前请确认。")).toBeVisible();
  await expect(page.getByText("Duplicate project name: PawPlan Import")).toBeVisible();
  await expect(page.getByText("Project PawPlan Import appears 2 times in this import")).toBeVisible();

  await page.getByRole("button", { name: "保存" }).first().click();
  await expect.poll(() => saveRequests).toEqual([
    expect.objectContaining({ confirmation: "CONFIRM_PLAN_IMPORT", previewToken: "plan-preview-token" }),
  ]);
  await expect(page.getByText("已保存 plan.md：项目已创建或复用，未自动生成任务或里程碑。")).toBeVisible();

  await page.getByRole("button", { name: "填入 timetable.csv 示例" }).click();
  await page.getByRole("button", { name: "预览" }).nth(1).click();
  await expect(page.getByText(/预览行数：1 · 将生成时间块：2 · 时区：Asia\/Shanghai/)).toBeVisible();
  await expect(page.getByText(/课程 · 星期一 · 09:00-11:00/)).toBeVisible();
  await expect(page.getByText("Times are interpreted in Asia/Shanghai")).toBeVisible();
  await expect(page.getByText("Deep Learning Lecture overlaps Existing Block")).toBeVisible();
  await expect(page.getByRole("heading", { name: "HTML" })).toHaveCount(0);
});
