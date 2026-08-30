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

test("opens schedules from Plan with a compact manual-create flow and no workspace identifiers", async ({ context, page, isMobile }) => {
  await addWorkspaceSession(context);

  const workspaceId = "00000000-0000-0000-0000-000000000001";
  let savedPayload: Record<string, any> | null = null;
  const timeBlocks = [
    {
      id: "block-1",
      title: "Linear Algebra",
      kind: "course",
      startsAt: "2026-06-12T01:00:00.000Z",
      endsAt: "2026-06-12T03:00:00.000Z",
      recurrenceRule: "weekly",
      recurrenceWeekdayMask: 1 << 5,
      courseId: "course-1",
      courseName: "Linear Algebra",
      location: "C 201",
      movable: false,
    },
    {
      id: "block-2",
      title: "Studio unavailable",
      kind: "unavailable",
      startsAt: "2026-06-13T08:00:00.000Z",
      endsAt: "2026-06-13T09:00:00.000Z",
      recurrenceRule: null,
      recurrenceWeekdayMask: null,
      courseId: null,
      courseName: null,
      location: null,
      movable: false,
    },
  ];

  await page.route("**/api/constraints", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        json: {
          workspaceId,
          courses: [{ id: "course-1", name: "Linear Algebra", color: "#2563eb" }],
          timeBlocks,
          summary: {
            courseCount: 1,
            timeBlockCount: timeBlocks.length,
            conflictCount: 1,
            nextStartsAt: "2026-06-12T01:00:00.000Z",
          },
          conflicts: [
            {
              id: "block-1__block-2",
              firstTitle: "Linear Algebra",
              secondTitle: "Studio unavailable",
              startsAt: "2026-06-12T02:30:00.000Z",
              endsAt: "2026-06-12T03:00:00.000Z",
              firstLocation: "C 201",
              secondLocation: null,
            },
          ],
        },
      });
      return;
    }

    if (request.method() === "POST") {
      savedPayload = request.postDataJSON();
      const input = savedPayload?.timeBlock as Record<string, any>;
      await route.fulfill({
        json: {
          timeBlock: {
            id: "00000000-0000-0000-0000-000000000099",
            ...input,
            recurrenceRule: input.recurrenceRule ?? null,
            recurrenceWeekdayMask: null,
            courseId: null,
            courseName: null,
            movable: false,
          },
          course: null,
        },
      });
      return;
    }

    await route.fallback();
  });

  await page.goto("/today");
  const primaryNav = page.getByLabel(isMobile ? "移动导航" : "主导航");
  await primaryNav.getByRole("link", { name: "计划", exact: true }).click();
  await page.getByRole("link", { name: "日程", exact: true }).click();
  await expect(page).toHaveURL(/\/constraints$/);
  await expect(page.locator('section[aria-labelledby="timetable-heading"]')).toBeVisible();
  await expect(page.getByRole("link", { name: "导入日程" })).toHaveAttribute("href", "/import");
  await expect(page.getByRole("heading", { name: "时间冲突" })).toBeVisible();
  await expect(page.getByText("Linear Algebra 与 Studio unavailable 时间冲突")).toBeVisible();
  await expect(page.getByText("地点：C 201 / 待确认")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "周循环摘要" })).toHaveCount(0);
  await page.getByRole("button", { name: "新建", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存日程" })).toBeVisible();
  await page.getByRole("button", { name: "考试", exact: true }).click();
  await page.getByLabel("标题").fill("MATH 3700 期中考试");
  await page.getByLabel("地点（可选）").fill("C 201");
  await page.getByRole("button", { name: "保存日程" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(savedPayload).toMatchObject({
    action: "upsert_time_block",
    timeBlock: {
      kind: "exam",
      title: "MATH 3700 期中考试",
      location: "C 201",
    },
  });
  await expect(page.getByText(/^Workspace:/)).toHaveCount(0);
  await expect(page.getByText("Workspace 读取中")).toHaveCount(0);
});
