import { expect, test, type BrowserContext } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://charlotte@localhost:5432/daily_progress";
let dbAvailable = false;

function signedWorkspaceSession(workspaceId: string) {
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  return `${workspaceId}.${signature}`;
}

async function addWorkspaceSession(context: BrowserContext, workspaceId: string) {
  await context.addCookies([
    {
      name: "daily_progress_workspace",
      value: signedWorkspaceSession(workspaceId),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
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

async function seedPlanWorkspace() {
  const workspaceId = randomUUID();
  const planId = randomUUID();
  const taskId = randomUUID();
  const now = new Date();
  const taskDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0));

  await withClient(async (client) => {
    await client.query(
      `insert into workspaces (id, name, password_hash)
       values ($1, $2, $3)`,
      [workspaceId, `mobile-plan-${workspaceId}`, "test-password-hash"],
    );
    await client.query(
      `insert into plans (id, workspace_id, title, start_date, end_date, status, baseline_snapshot)
       values ($1, $2, $3, $4, $5, 'active', $6::jsonb)`,
      [planId, workspaceId, "Mobile Plan", taskDate, taskDate, "{}"],
    );
    await client.query(
      `insert into tasks (
        id, workspace_id, plan_id, title, notes, date, day_segment, status,
        priority, estimated_minutes, energy_level, movable
      )
       values ($1, $2, $3, $4, $5, $6, 'morning', 'todo', 'normal', 30, 'medium', true)`,
      [taskId, workspaceId, planId, "Mobile plan task", "目标：验证移动端详情不会挡住滚动。", taskDate],
    );
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
      const result = await client.query(
        `select column_name
         from information_schema.columns
         where table_name = 'tasks'
           and column_name in ('is_chore', 'movable', 'energy_level')`,
      );
      dbAvailable = result.rowCount === 3;
    });
  } catch {
    dbAvailable = false;
  }
});

test("mobile Plan month detail opens only after selection and stays in page flow", async ({ context, page, isMobile }) => {
  test.skip(!isMobile, "mobile-only regression");
  test.skip(!dbAvailable, "local DATABASE_URL/Postgres unavailable or schema not migrated");

  const workspaceId = await seedPlanWorkspace();
  try {
    await addWorkspaceSession(context, workspaceId);
    await page.goto("/plan");

    const sectionNav = page.getByRole("navigation", { name: "Plan sections" });
    await expect(sectionNav.getByRole("link", { name: "日程", exact: true })).toHaveAttribute("href", "/plan");
    await expect(sectionNav.getByRole("link", { name: "项目", exact: true })).toHaveAttribute("href", "/projects");
    await expect(sectionNav.getByRole("link", { name: "稍后处理", exact: true })).toHaveAttribute("href", "/backlog");
    await expect(sectionNav.getByRole("link", { name: "归档", exact: true })).toHaveAttribute("href", "/archive");

    await page.getByRole("link", { name: "月", exact: true }).click();
    await expect(page).toHaveURL(/\/plan\?view=month/);
    await expect(page.locator(".paw-month-selected")).toHaveCount(0);
    await expect(page.locator(".paw-month-sheet-backdrop")).toHaveCount(0);

    await page.locator(".paw-month-day.today").click();
    await expect(page.locator(".paw-month-selected")).toBeVisible();
    await expect(page.locator(".paw-month-sheet-backdrop")).toHaveCount(1);
    await expect(page.locator(".paw-month-sheet-backdrop")).toBeHidden();
    await expect(page.locator(".paw-month-selected")).not.toHaveCSS("position", "fixed");
  } finally {
    await cleanupWorkspace(workspaceId);
  }
});
