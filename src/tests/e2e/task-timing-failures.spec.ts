import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { createHmac, randomUUID } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (
  !databaseUrl.includes("pawplan_timing_check") ||
  !databaseUrl.includes("127.0.0.1")
) {
  throw new Error(
    "Task timing E2E requires the isolated pawplan_timing_check database",
  );
}
const pool = new Pool({ connectionString: databaseUrl });
let workspaceId: string;
let taskId: string;
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

test.beforeEach(async ({ context }) => {
  workspaceId = randomUUID();
  taskId = randomUUID();
  const planId = randomUUID();
  await pool.query(
    "insert into workspaces(id,name,password_hash) values($1,'时段失败重试验收','test')",
    [workspaceId],
  );
  await pool.query(
    "insert into plans(id,workspace_id,title,start_date,end_date,status,baseline_snapshot) values($1,$2,'验收计划',$3,'2036-12-31','active','{}')",
    [planId, workspaceId, `${today()}T00:00:00+08:00`],
  );
  await pool.query(
    "insert into tasks(id,workspace_id,plan_id,title,date,day_segment,status,scheduled_start,scheduled_end,estimated_minutes) values($1,$2,$3,'失败重试任务',$4,'evening','todo',$5,$6,30)",
    [
      taskId,
      workspaceId,
      planId,
      `${today()}T00:00:00+08:00`,
      `${today()}T20:00:00+08:00`,
      `${today()}T20:30:00+08:00`,
    ],
  );
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
});
test.afterEach(async () => {
  await pool.query("delete from workspaces where id=$1", [workspaceId]);
});
test.afterAll(async () => {
  await pool.end();
});

async function previewProtectedSlot(page: Page): Promise<string> {
  await page.goto("/today");
  await page.getByRole("button", { name: /失败重试任务，/ }).click();
  await page.getByLabel("保护这个时段，调整时保留").check();
  const proposed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/task-timing") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "预览安排", exact: true }).click();
  const { approvalId } = await (await proposed).json();
  expect(approvalId).toBeTruthy();
  await expect(page.getByText("确认这次调整")).toBeVisible();
  return approvalId;
}
async function approvalStatus(id: string) {
  return (
    await pool.query("select status from operation_approvals where id=$1", [id])
  ).rows[0].status;
}
async function taskMovable() {
  return (await pool.query("select movable from tasks where id=$1", [taskId]))
    .rows[0].movable;
}

test("failed preview rejection keeps the dialog and pending approval available for retry", async ({
  page,
}) => {
  const approvalId = await previewProtectedSlot(page);
  let rejectRequests = 0;
  await page.route("**/api/operation-approvals", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().decision === "rejected"
    ) {
      rejectRequests++;
      if (rejectRequests === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "测试撤回暂时不可用" }),
        });
        return;
      }
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "关闭失败重试任务", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("测试撤回暂时不可用");
  expect(await approvalStatus(approvalId)).toBe("pending");
  expect(await taskMovable()).toBe(true);
  await page
    .getByRole("button", { name: "关闭失败重试任务", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await approvalStatus(approvalId)).toBe("rejected");
  expect(await taskMovable()).toBe(true);
  expect(rejectRequests).toBe(2);
});

test("Apply failure preserves approval and retries without asking for approval again", async ({
  page,
}) => {
  const approvalId = await previewProtectedSlot(page);
  let approvalRequests = 0;
  let applyRequests = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/api/operation-approvals") &&
      request.method() === "POST" &&
      request.postDataJSON().decision === "approved"
    )
      approvalRequests++;
  });
  await page.route("**/api/task-timing", async (route) => {
    if (route.request().method() === "PATCH") {
      applyRequests++;
      if (applyRequests === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "测试应用暂时不可用" }),
        });
        return;
      }
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "确认并应用", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("测试应用暂时不可用");
  expect(await approvalStatus(approvalId)).toBe("approved");
  expect(await taskMovable()).toBe(true);
  await expect(
    page.getByRole("button", { name: "返回修改", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "确认并应用", exact: true }).click();
  await expect(page.getByText("已保存，任务时间和进展已核对。")).toBeVisible();
  expect(await approvalStatus(approvalId)).toBe("consumed");
  expect(await taskMovable()).toBe(false);
  expect(approvalRequests).toBe(1);
  expect(applyRequests).toBe(2);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
