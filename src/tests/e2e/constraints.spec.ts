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

test("opens fixed courses from Plan, preserves location, and protects recurring edits", async ({ context, page, isMobile }) => {
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

    if (request.method() === "POST") {
      const body = request.postDataJSON() as {
        action: "upsert_time_block";
        timeBlock: { id?: string; title: string; kind: "course"; courseName: string; location: string | null; recurrenceRule: string | null };
      };
      if (body.timeBlock.id) {
        const block = timeBlocks.find((item) => item.id === body.timeBlock.id);
        expect(block).toBeTruthy();
        Object.assign(block!, {
          title: body.timeBlock.title,
          recurrenceRule: body.timeBlock.recurrenceRule,
        });
        await route.fulfill({ json: { timeBlock: block, course: null } });
        return;
      }

      expect(body).toMatchObject({
        action: "upsert_time_block",
        timeBlock: {
          title: "Robotics lab",
          kind: "course",
          courseName: "Robotics",
          location: "Lab 410",
          recurrenceRule: null,
        },
      });
      const created = {
        id: "block-3",
        title: body.timeBlock.title,
        kind: body.timeBlock.kind,
        startsAt: "2026-06-14T01:00:00.000Z",
        endsAt: "2026-06-14T03:00:00.000Z",
        recurrenceRule: body.timeBlock.recurrenceRule,
        recurrenceWeekdayMask: null,
        courseId: "course-2",
        courseName: body.timeBlock.courseName,
        location: body.timeBlock.location,
        movable: false,
      };
      timeBlocks.push(created);
      await route.fulfill({ json: { timeBlock: created, course: { id: "course-2", name: "Robotics", color: "#2563eb" } } });
      return;
    }

    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { action: "delete_time_block"; id: string };
      expect(body).toEqual({ action: "delete_time_block", id: "block-3" });
      timeBlocks.splice(
        timeBlocks.findIndex((block) => block.id === body.id),
        1,
      );
      await route.fulfill({ json: { deleted: true } });
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
  await expect(page.getByText("Linear Algebra", { exact: true })).toBeVisible();
  await expect(page.getByText("Studio unavailable", { exact: true })).toBeVisible();

  await page.getByLabel("类型").selectOption("course");
  await page.getByLabel("标题").fill("Robotics lab");
  await page.getByRole("textbox", { name: "日期", exact: true }).fill("2026-06-14");
  await page.getByLabel("开始").fill("09:00");
  await page.getByLabel("结束").fill("11:00");
  await page.getByLabel("课程名").fill("Robotics");
  await page.getByLabel("地点（可选）").fill("Lab 410");
  await page.getByRole("button", { name: "保存约束" }).click();
  await expect(page.getByText("约束已保存。")).toBeVisible();
  await expect(page.getByText("Robotics lab", { exact: true })).toBeVisible();
  await expect(page.getByText(/Lab 410/).first()).toBeVisible();

  await page.locator(".paw-constraint-group", { hasText: "Robotics lab" }).getByText("查看 / 编辑 1 个实例").click();
  await page.getByRole("button", { name: "编辑 Robotics lab" }).click();
  await page.getByLabel("标题").fill("Robotics studio");
  await page.getByRole("button", { name: "更新约束" }).click();
  await expect(page.getByText("Robotics studio", { exact: true })).toBeVisible();
  await expect(page.getByText("Robotics lab", { exact: true })).toHaveCount(0);

  await page.locator(".paw-constraint-group", { hasText: "Linear Algebra" }).getByText("查看 / 编辑 1 个实例").click();
  await page.getByRole("button", { name: "编辑 Linear Algebra" }).click();
  await expect(page.getByText(/循环安排不能直接覆盖/)).toBeVisible();

  await page.locator(".paw-constraint-group", { hasText: "Robotics studio" }).getByText("查看 / 编辑 1 个实例").click();
  await page.getByRole("button", { name: "删除 Robotics studio" }).click();
  await expect(page.getByText("约束已删除。")).toBeVisible();
  await expect(page.getByText("Robotics studio", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Linear Algebra", { exact: true })).toBeVisible();
});
