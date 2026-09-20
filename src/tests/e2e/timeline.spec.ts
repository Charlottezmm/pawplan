import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { buildDailyTimeline } from "../../lib/planning/daily-timeline";
import type { DailyTimelineArgs } from "../../lib/planning/timeline-schema";

test("timeline feedback, backlog reservation and portable resume work without live writes", async ({ context, page }) => {
  const workspaceId = "00000000-0000-0000-0000-000000000001";
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  await context.addCookies([{ name: "daily_progress_workspace", value: `${workspaceId}.${signature}`, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.clock.install({ time: new Date("2026-09-20T08:15:00+08:00") });
  const calls: DailyTimelineArgs[] = [];
  await page.route("**/api/timeline", async route => {
    const args = route.request().postDataJSON() as DailyTimelineArgs;
    calls.push(args);
    const source = { tasks: [
      { id: "quiz-1", title: "Quiz preparation", notes: "Original outline, closed-book first attempt then repair", status: "todo", date: "2026-09-20T00:00:00+08:00", updatedAt: "2026-09-19T00:00:00.000Z", estimatedMinutes: 60, priority: "high" },
      { id: "nano-1", title: "nanoGPT continuation", notes: "Resume at original timestamp", status: "backlog", date: "2026-09-20T00:00:00+08:00", updatedAt: "2026-09-19T00:00:00.000Z", estimatedMinutes: 90, priority: "normal" },
    ], blocks: [] };
    await route.fulfill({ json: buildDailyTimeline(source, args) });
  });
  const browserErrors: string[] = [];
  page.on("pageerror", e => browserErrors.push(e.message));
  await page.goto("/timeline");
  await expect(page.getByRole("heading", { name: "每日时间线", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "生成 / 按现在重排", exact: true }).click();
  await expect(page.getByRole("heading", { name: "反馈与续接", exact: true })).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "按所选 backlog 预览" }).click();
  await expect.poll(() => calls.at(-1)?.backlog_windows[0]?.task_ids).toEqual(["nano-1"]);
  await page.getByLabel("任务", { exact: true }).selectOption("quiz-1");
  await page.getByLabel("实际断点 / 当前页码题号").fill("Note2 p4, own first attempt pending");
  await page.getByLabel("唯一下一步").fill("derive acceptance rule without hints");
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect.poll(() => calls.at(-1)?.feedback[0]?.state).toBe("started");
  await page.clock.fastForward(65 * 60000);
  await page.getByLabel("还需约几分钟").fill("20");
  await page.getByRole("button", { name: "超时", exact: true }).click();
  await expect.poll(() => calls.at(-1)?.feedback[0]?.state).toBe("timeout");
  expect(calls.at(-1)?.feedback).toHaveLength(1);
  expect(calls.at(-1)?.feedback[0]?.remaining_minutes).toBe(20);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  // Closing an existing session again requires actual start, not a fabricated duration.
  await expect(page.getByRole("alert").filter({ hasText: "实际开始时间" })).toContainText("实际开始时间");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出续接 JSON" }).click();
  expect((await download).suggestedFilename()).toBe("pawplan-timeline-2026-09-20.json");
  await page.getByText("从 Claude / Codex 续接 JSON 导入", { exact: true }).click();
  await page.getByLabel("续接 JSON").fill(JSON.stringify(calls.at(-1)));
  await page.getByRole("button", { name: "载入并检查" }).click();
  await page.getByRole("button", { name: "生成 / 按现在重排", exact: true }).click();
  await expect(page.getByRole("heading", { name: "反馈与续接", exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("timeline.png"), fullPage: true });
});
