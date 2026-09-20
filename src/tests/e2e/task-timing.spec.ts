import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { Pool } from "pg";
import { createHmac, randomUUID } from "node:crypto";
const url = process.env.DATABASE_URL ?? "";
if (!url.includes("pawplan_timing_check") || !url.includes("127.0.0.1"))
  throw new Error(
    "Task timing E2E requires the isolated pawplan_timing_check database",
  );
const pool = new Pool({ connectionString: url });
let workspaceId: string;
let taskId: string;
let nextId: string;
let backlogId: string;
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
async function signIn(context: BrowserContext) {
  const token = `${workspaceId}.${createHmac("sha256", "test-secret").update(workspaceId).digest("base64url")}`;
  await context.addCookies([
    {
      name: "daily_progress_workspace",
      value: token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
async function clickSlot(page: Page, title = "MATH 4710 · Note7 补课") {
  await page
    .getByRole("button", {
      name: new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}，`),
    })
    .click();
}
async function apply(page: Page) {
  await page.getByRole("button", { name: "预览安排", exact: true }).click();
  await page.getByRole("button", { name: "确认并应用", exact: true }).click();
  await expect(page.getByText("已保存，任务时间和进展已核对。")).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
}
test.beforeEach(async ({ context }) => {
  workspaceId = randomUUID();
  const planId = randomUUID();
  taskId = randomUUID();
  nextId = randomUUID();
  backlogId = randomUUID();
  await pool.query(
    "insert into workspaces(id,name,password_hash) values($1,$2,$3)",
    [workspaceId, "时间安排验收", "test"],
  );
  await pool.query(
    "insert into plans(id,workspace_id,title,start_date,end_date,status,baseline_snapshot) values($1,$2,'验收计划',$3,$4,'active','{}')",
    [planId, workspaceId, `${today()}T00:00:00+08:00`, "2036-12-31"],
  );
  for (const [id, title, start, end, status] of [
    [taskId, "MATH 4710 · Note7 补课", "20:00", "20:30", "todo"],
    [nextId, "GE · 课前准备", "20:45", "21:15", "todo"],
    [backlogId, "nanoGPT · 最后一课", null, null, "backlog"],
  ]) {
    await pool.query(
      "insert into tasks(id,workspace_id,plan_id,title,date,day_segment,status,scheduled_start,scheduled_end,estimated_minutes) values($1,$2,$3,$4,$5,'evening',$6,$7,$8,30)",
      [
        id,
        workspaceId,
        planId,
        title,
        `${today()}T00:00:00+08:00`,
        status,
        start ? `${today()}T${start}:00+08:00` : null,
        end ? `${today()}T${end}:00+08:00` : null,
      ],
    );
  }
  await pool.query(
    "insert into time_blocks(workspace_id,title,kind,starts_at,ends_at) values($1,'COMM · 固定课程','course',$2,$3)",
    [workspaceId, `${today()}T13:00:00+08:00`, `${today()}T14:00:00+08:00`],
  );
  await signIn(context);
});
test.afterEach(async () => {
  await pool.query("delete from workspaces where id=$1", [workspaceId]);
});
test.afterAll(async () => {
  await pool.end();
});
test("existing Today timeline, preview before write, extension, pause and reload", async ({
  page,
}, info) => {
  await page.goto("/today");
  await expect(
    page.getByRole("heading", { name: "今天的时间安排" }),
  ).toBeVisible();
  await clickSlot(page);
  await page.getByLabel("本次安排（分钟）").fill("45");
  await page
    .getByLabel("做到哪里／剩下什么")
    .fill("Note7 已到第4页，下一步例题2");
  await page.getByRole("button", { name: "预览安排", exact: true }).click();
  expect(
    (
      await pool.query("select scheduled_end from tasks where id=$1", [taskId])
    ).rows[0].scheduled_end.toISOString(),
  ).toBe(new Date(`${today()}T20:30:00+08:00`).toISOString());
  await expect(page.getByText("确认这次调整")).toBeVisible();
  await page.getByRole("button", { name: "确认并应用", exact: true }).click();
  await expect(page.getByText("已保存，任务时间和进展已核对。")).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await clickSlot(page);
  await page.getByRole("button", { name: "继续一段", exact: true }).click();
  await page.getByRole("button", { name: "预览安排", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("GE · 课前准备", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("timing-preview.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "确认并应用", exact: true }).click();
  await expect(page.getByText("已保存，任务时间和进展已核对。")).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /GE · 课前准备，21:05 至 21:35/ }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("today-timing.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await clickSlot(page);
  await page.getByRole("button", { name: "先收尾", exact: true }).click();
  await page.getByLabel("做到哪里／剩下什么").fill("例题2还没做，下次继续");
  await apply(page);
  const row = (
    await pool.query(
      "select status,scheduled_start,checkpoint from tasks where id=$1",
      [taskId],
    )
  ).rows[0];
  expect(row).toMatchObject({
    status: "todo",
    scheduled_start: null,
    checkpoint: "例题2还没做，下次继续",
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: /MATH 4710 · Note7 补课，/ }),
  ).toHaveCount(0);
});
test("backlog next week creates a persisted slot through confirmation", async ({
  page,
}) => {
  await page.goto("/backlog");
  await page.getByRole("button", { name: "找一个时间段" }).click();
  await page.getByRole("button", { name: "下周安排", exact: true }).click();
  await page.getByRole("button", { name: "预览安排", exact: true }).click();
  expect(
    (await pool.query("select status from tasks where id=$1", [backlogId]))
      .rows[0].status,
  ).toBe("backlog");
  await page.getByRole("button", { name: "确认并应用", exact: true }).click();
  await expect(page.getByText("已保存，任务时间和进展已核对。")).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "nanoGPT · 最后一课" }),
  ).toHaveCount(0);
  const row = (
    await pool.query("select status,scheduled_start from tasks where id=$1", [
      backlogId,
    ])
  ).rows[0];
  expect(row.status).toBe("todo");
  expect(row.scheduled_start).not.toBeNull();
});
test("Review shows the full preview and applies a proposal after confirmation", async ({
  page,
}) => {
  // MCP/API proposals intentionally remain in Review; dismissing a UI preview does not.
  const proposal = await page.request.post("/api/task-timing", {
    data: {
      request: {
        action: "schedule",
        edits: [
          {
            taskId,
            date: today(),
            startTime: "20:00",
            minutes: 30,
            locked: true,
            deadlineAt: null,
            targetDate: null,
          },
        ],
      },
      idempotencyKey: randomUUID(),
    },
  });
  expect(proposal.ok()).toBe(true);
  await page.goto("/review");
  await expect(page.getByText("任务时间安排", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认并应用", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认并应用", exact: true })
    .click();
  await expect(page.getByText("任务时间安排", { exact: true })).toHaveCount(0);
  expect(
    (await pool.query("select movable from tasks where id=$1", [taskId]))
      .rows[0].movable,
  ).toBe(false);
});

test("closing an unconfirmed preview rejects it without changing the task", async ({
  page,
}) => {
  await page.goto("/today");
  await clickSlot(page);
  await page.getByLabel("保护这个时段，调整时保留").check();
  const proposed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/task-timing") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "预览安排", exact: true }).click();
  const { approvalId } = await (await proposed).json();
  expect(approvalId).toBeTruthy();
  await page.getByRole("button", { name: /^关闭MATH 4710/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "select status from operation_approvals where id=$1",
            [approvalId],
          )
        ).rows[0].status,
    )
    .toBe("rejected");
  expect(
    (await pool.query("select movable from tasks where id=$1", [taskId]))
      .rows[0].movable,
  ).toBe(true);
  await page.goto("/review");
  await expect(page.getByText("任务时间安排", { exact: true })).toHaveCount(0);
});

test("blank and out-of-range durations never send a preview request", async ({
  page,
}) => {
  await page.goto("/today");
  await clickSlot(page);
  let proposals = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/api/task-timing") &&
      request.method() === "POST"
    )
      proposals++;
  });
  for (const [mode, label, invalid] of [
    ["设置时段", "本次安排（分钟）", ["", "0", "4", "481"]],
    ["继续一段", "继续多少分钟", ["", "0", "4", "121"]],
  ] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    for (const value of invalid) {
      await page.getByLabel(label).fill(value);
      const preview = page.getByRole("button", {
        name: "预览安排",
        exact: true,
      });
      if (await preview.isEnabled()) await preview.click();
      await expect(
        page.getByRole("button", { name: "确认并应用", exact: true }),
      ).toHaveCount(0);
      expect(proposals).toBe(0);
    }
  }
});

test("batch date changes only submit checked tasks from the visible date", async ({
  page,
}) => {
  const tomorrow = new Date(`${today()}T12:00:00+08:00`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(tomorrow);
  await pool.query(
    "update tasks set scheduled_start=null,scheduled_end=null where id=$1",
    [taskId],
  );
  await pool.query(
    "update tasks set scheduled_start=null,scheduled_end=null,date=$2 where id=$1",
    [nextId, `${nextDate}T00:00:00+08:00`],
  );
  await page.goto("/today");
  await page.getByRole("button", { name: "安排任务时段", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /MATH 4710/ })).toBeChecked();
  await page.getByLabel("日期", { exact: true }).fill(nextDate);
  await expect(page.getByRole("checkbox", { name: /MATH 4710/ })).toHaveCount(
    0,
  );
  const visibleTask = page.getByRole("checkbox", { name: /GE · 课前准备/ });
  await expect(visibleTask).toBeVisible();
  await visibleTask.check();
  await page.getByLabel("从几点开始").fill("18:00");
  const request = page.waitForRequest(
    (request) =>
      request.url().includes("/api/task-timing") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "预览安排", exact: true }).click();
  expect((await request).postDataJSON().request).toMatchObject({
    date: nextDate,
    taskIds: [nextId],
  });
  await expect(page.getByText("确认这次调整")).toBeVisible();
  await page.getByRole("button", { name: /^关闭/ }).click();
});

test("Today keeps completed tasks last after a timing save refresh", async ({
  page,
}) => {
  // Put the first database row into done so a raw server-order replacement is detectable.
  await pool.query(
    "update tasks set status='done',created_at='2020-01-01' where id=$1",
    [taskId],
  );
  await page.goto("/today");
  const ids = () =>
    page
      .locator(".paw-task-list [data-task-id]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-task-id")),
      );
  await expect.poll(ids).toEqual([nextId, taskId]);
  await clickSlot(page, "GE · 课前准备");
  await page.getByLabel("做到哪里／剩下什么").fill("refresh regression");
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes("/today") &&
      response.headers()["content-type"]?.includes("text/x-component"),
  );
  await apply(page);
  await refreshed;
  await expect(page.locator(`[data-task-id="${nextId}"]`)).toContainText(
    "GE · 课前准备",
  );
  await expect.poll(ids).toEqual([nextId, taskId]);
  await page.reload();
  await expect.poll(ids).toEqual([nextId, taskId]);
});

test("initial task slots do not depend on a client timing fetch", async ({
  page,
}) => {
  await page.route("**/api/task-timing?*", (route) => route.abort());
  await page.goto("/today");
  await expect(
    page.getByRole("button", {
      name: /MATH 4710 · Note7 补课，20:00 至 20:30/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /GE · 课前准备，20:45 至 21:15/ }),
  ).toBeVisible();
});

test("mobile timeline is scrollable and completed task details use task wording", async ({
  page,
}, info) => {
  await pool.query("update tasks set status='done' where id=$1", [taskId]);
  await page.goto("/today");
  const timeline = page.getByRole("region", {
    name: "全天时间轴",
    exact: true,
  });
  await expect(timeline).toBeVisible();
  if (info.project.name === "mobile") {
    const dimensions = await timeline.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY,
    }));
    expect(dimensions.height).toBeLessThanOrEqual(421);
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    expect(dimensions.overflowY).toMatch(/auto|scroll/);
  }
  await clickSlot(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("已完成任务", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("已完成，此处仅查看已记录的任务时段", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("固定时间安排", { exact: true })).toHaveCount(
    0,
  );
});

test("preview still works when crypto.randomUUID is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto("/today");
  await clickSlot(page);
  await page.getByLabel("保护这个时段，调整时保留").check();
  await page.getByRole("button", { name: "预览安排", exact: true }).click();
  await expect(page.getByText("确认这次调整")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认并应用", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^关闭MATH 4710/ }).click();
});
