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

test("opens fixed courses from Plan without edit panels or workspace identifiers", async ({ context, page, isMobile }) => {
  await addWorkspaceSession(context);

  const workspaceId = "00000000-0000-0000-0000-000000000001";
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

    await route.fallback();
  });

  await page.goto("/today");
  const primaryNav = page.getByLabel(isMobile ? "Mobile navigation" : "Primary navigation");
  await primaryNav.getByRole("link", { name: "计划", exact: true }).click();
  await page.getByRole("link", { name: "固定课程", exact: true }).click();
  await expect(page).toHaveURL(/\/constraints$/);
  await expect(page.getByRole("heading", { name: "固定安排", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "导入 timetable.csv" })).toHaveAttribute("href", "/import");
  await expect(page.getByText("冲突: 1")).toBeVisible();
  await expect(page.getByText("Linear Algebra 与 Studio unavailable 时间冲突")).toBeVisible();
  await expect(page.getByText("地点：C 201 / 待确认")).toBeVisible();
  await expect(page.getByRole("heading", { name: "新增固定安排" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "周循环摘要" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存约束" })).toHaveCount(0);
  await expect(page.getByText(/^Workspace:/)).toHaveCount(0);
  await expect(page.getByText("Workspace 读取中")).toHaveCount(0);
});
