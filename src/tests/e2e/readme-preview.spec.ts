import { expect, test, type BrowserContext } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://charlotte@localhost:5432/daily_progress";
let dbAvailable = false;

function signedWorkspaceSession(workspaceId: string) {
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  return `${workspaceId}.${signature}`;
}

function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "01";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function atShanghaiTime(dateKey: string, time: string) {
  return `${dateKey}T${time}:00+08:00`;
}

async function withClient<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function addWorkspaceSession(context: BrowserContext, workspaceId: string) {
  await context.addCookies([{
    name: "daily_progress_workspace",
    value: signedWorkspaceSession(workspaceId),
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

async function seedPreviewWorkspace(dateKey: string) {
  const workspaceId = randomUUID();
  const planId = randomUUID();
  const taskIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  await withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `insert into workspaces (id, name, password_hash)
         values ($1, $2, $3)`,
        [workspaceId, `readme-preview-${workspaceId}`, "test-password-hash"],
      );
      await client.query(
        `insert into plans (id, workspace_id, title, start_date, end_date, status, baseline_snapshot)
         values ($1, $2, 'PawPlan 预览', $3, $3, 'active', '{}'::jsonb)`,
        [planId, workspaceId, atShanghaiTime(dateKey, "00:00")],
      );
      await client.query(
        `insert into tasks (
           id, workspace_id, plan_id, title, notes, date, day_segment, status,
           blocked, priority, estimated_minutes, energy_level, movable
         ) values
           ($1, $5, $6, '论文 第三章', null, $7, 'afternoon', 'todo', false, 'high', 90, 'high', true),
           ($2, $5, $6, '线代复习', null, $7, 'evening', 'todo', false, 'normal', 45, 'medium', true),
           ($3, $5, $6, '开题报告 改摘要', '卡住：等待导师回复', $7, 'afternoon', 'todo', true, 'urgent', 40, 'medium', true),
           ($4, $5, $6, '回复导师邮件', null, $7, 'morning', 'done', false, 'normal', 20, 'low', true)`,
        [...taskIds, workspaceId, planId, atShanghaiTime(dateKey, "00:00")],
      );
      await client.query(
        `insert into time_blocks (
           id, workspace_id, title, kind, starts_at, ends_at, location, movable, protected
         ) values
           ($1, $4, '深度学习 · 课程', 'course', $5, $6, '教室 204', false, true),
           ($2, $4, '午餐', 'recovery', $7, $8, null, false, true),
           ($3, $4, '健身', 'recovery', $9, $10, null, false, true)`,
        [
          randomUUID(), randomUUID(), randomUUID(), workspaceId,
          atShanghaiTime(dateKey, "09:00"), atShanghaiTime(dateKey, "11:00"),
          atShanghaiTime(dateKey, "12:30"), atShanghaiTime(dateKey, "13:00"),
          atShanghaiTime(dateKey, "19:00"), atShanghaiTime(dateKey, "20:00"),
        ],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  return workspaceId;
}

async function cleanupWorkspace(workspaceId: string) {
  await withClient(async (client) => {
    await client.query("delete from workspaces where id = $1", [workspaceId]);
  });
}

test.beforeAll(async () => {
  try {
    await withClient(async (client) => {
      const result = await client.query("select to_regclass('public.time_blocks') as table_name");
      dbAvailable = Boolean(result.rows[0]?.table_name);
    });
  } catch {
    dbAvailable = false;
  }
});

test("renders the completed Today direction and refreshes the README preview", async ({ browserName, context, page }) => {
  test.skip(browserName !== "chromium", "README preview is generated once in Chromium");
  test.skip(!dbAvailable, "local DATABASE_URL/Postgres unavailable or schema not migrated");

  const dateKey = shanghaiDateKey();
  const workspaceId = await seedPreviewWorkspace(dateKey);
  try {
    await addWorkspaceSession(context, workspaceId);
    await page.route("**/api/onboarding", async (route) => {
      await route.fulfill({
        json: { completedCount: 6, totalCount: 6, nextStep: null, steps: [] },
      });
    });
    await page.setViewportSize({ width: 1280, height: 1240 });
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "今天的固定安排" })).toBeVisible();
    await expect(page.getByText("3h 30m", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /深度学习 · 课程/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /午餐/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /健身/ })).toBeVisible();

    const lunchMetrics = await page.getByRole("button", { name: /午餐/ }).evaluate((element) => ({
      visualHeight: element.getBoundingClientRect().height,
      hitHeight: Number.parseFloat(getComputedStyle(element, "::after").height),
    }));
    expect(lunchMetrics.visualHeight).toBeCloseTo(30, 0);
    expect(lunchMetrics.hitHeight).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

    await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; }" });
    await page.screenshot({
      path: resolve(process.cwd(), "public/screenshots/pawplan-preview.png"),
      fullPage: true,
    });
  } finally {
    await cleanupWorkspace(workspaceId);
  }
});
