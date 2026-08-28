import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
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

async function seedTimetableWorkspace() {
  const workspaceId = randomUUID();
  const courseIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `insert into workspaces (id, name, password_hash)
         values ($1, $2, $3)`,
        [workspaceId, `mobile-ui-${workspaceId}`, "test-password-hash"],
      );
      await client.query(
        `insert into courses (id, workspace_id, name, color)
         values
           ($1, $5, 'Calculus III', '#c2410c'),
           ($2, $5, 'Advanced Robotics Laboratory', '#0f766e'),
           ($3, $5, 'Speech Communication', '#2563eb'),
           ($4, $5, 'Research Seminar', '#7c3aed')`,
        [...courseIds, workspaceId],
      );
      await client.query(
        `insert into time_blocks (
           id, workspace_id, title, kind, starts_at, ends_at, location, course_id,
           movable, protected
         ) values
           ($1, $9, 'MATH 3415 W02 · Calculus III', 'course', '2026-09-01T08:30:00+08:00', '2026-09-01T10:15:00+08:00', 'CSMT 139', $5, false, true),
           ($2, $9, 'Advanced Robotics and Embodied Intelligence Laboratory with an Exceptionally Long Course Name', 'course', '2026-09-01T11:30:00+08:00', '2026-09-01T12:00:00+08:00', 'Science and Engineering Building, Laboratory 410, East Wing', $6, false, true),
           ($3, $9, 'COMM 1402 W18 · Speech Communication', 'course', '2026-09-01T11:30:00+08:00', '2026-09-01T12:00:00+08:00', 'GEH C404', $7, false, true),
           ($4, $9, 'Research Seminar', 'course', '2026-09-01T12:00:00+08:00', '2026-09-01T13:00:00+08:00', '   ', $8, false, true)`,
        [randomUUID(), randomUUID(), randomUUID(), randomUUID(), ...courseIds, workspaceId],
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

async function expectNoPageOverflow(page: Page, width: number) {
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(metrics.innerWidth).toBe(width);
  expect(metrics.documentWidth).toBeLessThanOrEqual(width);
  expect(metrics.bodyWidth).toBeLessThanOrEqual(width);
}

async function expectMinimumHeight(locator: ReturnType<Page["locator"]>, minimum = 44) {
  const boxes = await locator.evaluateAll((elements) => elements
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })
    .filter((box) => box.width > 0 && box.height > 0));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.height).toBeGreaterThanOrEqual(minimum);
    expect(box.width).toBeGreaterThanOrEqual(minimum);
  }
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.beforeAll(async () => {
  try {
    await withClient(async (client) => {
      const result = await client.query(
        `select column_name
         from information_schema.columns
         where table_name = 'time_blocks'
           and column_name in ('location', 'course_id', 'starts_at', 'ends_at')`,
      );
      dbAvailable = result.rowCount === 4;
    });
  } catch {
    dbAvailable = false;
  }
});

test("keeps Plan navigation and the real timetable usable at 375, 390, and 430px", async ({ browserName, context, page }, testInfo) => {
  test.setTimeout(60_000);
  test.skip(browserName !== "chromium", "explicit viewport matrix runs once in Chromium");
  test.skip(!dbAvailable, "local DATABASE_URL/Postgres unavailable or schema not migrated");

  const workspaceId = await seedTimetableWorkspace();
  try {
    await addWorkspaceSession(context, workspaceId);
    for (const width of [375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/constraints?date=2026-09-01");
      await expect(page.getByRole("heading", { name: "日程", exact: true })).toBeVisible();
      await expectNoPageOverflow(page, width);

      const sectionNav = page.getByRole("navigation", { name: "Plan sections" });
      await expect(sectionNav).toBeVisible();
      await expect(sectionNav.getByRole("link")).toHaveCount(5);
      await expectMinimumHeight(sectionNav.getByRole("link"));
      const sectionStyles = await sectionNav.getByRole("link").evaluateAll((links) => links.map((link) => ({
        whiteSpace: getComputedStyle(link).whiteSpace,
        lineHeight: getComputedStyle(link).lineHeight,
      })));
      expect(sectionStyles.every((style) => style.whiteSpace === "nowrap")).toBe(true);

      const dateStrip = page.getByRole("navigation", { name: "选择日期" });
      await expectMinimumHeight(dateStrip.getByRole("link"));
      await expectMinimumHeight(page.getByRole("link", { name: /上一天|下一天/ }));
      await expectMinimumHeight(page.getByRole("link", { name: "今天", exact: true }));
      await expectMinimumHeight(page.getByLabel("Mobile navigation").getByRole("link"));

      const shortCourse = page.getByRole("button", { name: /Advanced Robotics Laboratory/ }).first();
      await expect(shortCourse).toBeVisible();
      const shortMetrics = await shortCourse.evaluate((element) => ({
        visualHeight: element.getBoundingClientRect().height,
        hitHeight: Number.parseFloat(getComputedStyle(element, "::after").height),
        contentOverflow: element.scrollWidth > element.clientWidth + 1,
      }));
      expect(shortMetrics.visualHeight).toBeCloseTo(30, 0);
      expect(shortMetrics.hitHeight).toBeGreaterThanOrEqual(44);
      expect(shortMetrics.contentOverflow).toBe(false);

      await attachScreenshot(page, testInfo, `constraints-${width}`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/constraints?date=2026-09-01");
    await page.getByRole("button", { name: /Advanced Robotics Laboratory/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Science and Engineering Building, Laboratory 410, East Wing")).toBeVisible();
    await expectMinimumHeight(dialog.getByRole("button", { name: "关闭日程详情" }));
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox?.width ?? 999).toBeLessThanOrEqual(390);
    await expectNoPageOverflow(page, 390);
    await attachScreenshot(page, testInfo, "constraints-390-detail");

    await dialog.getByRole("button", { name: "关闭日程详情" }).click();
    const speechCourse = page.getByRole("button", { name: /Speech Communication/ }).first();
    const researchCourse = page.getByRole("button", { name: /Research Seminar/ }).first();
    await speechCourse.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const speechBox = await speechCourse.boundingBox();
    expect(speechBox).not.toBeNull();
    await page.mouse.click(
      (speechBox?.x ?? 0) + (speechBox?.width ?? 0) / 2,
      (speechBox?.y ?? 0) + (speechBox?.height ?? 0) - 1,
    );
    await expect(dialog.getByRole("heading", { name: /Speech Communication/ })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭日程详情" }).click();
    await researchCourse.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const researchBox = await researchCourse.boundingBox();
    expect(researchBox).not.toBeNull();
    await page.mouse.click(
      (researchBox?.x ?? 0) + (researchBox?.width ?? 0) / 2,
      (researchBox?.y ?? 0) + 1,
    );
    await expect(dialog.getByRole("heading", { name: "Research Seminar" })).toBeVisible();
    await expect(dialog.getByText("地点待确认", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭日程详情" }).click();

    await page.goto("/plan?view=day");
    const scheduleTabs = page.getByRole("navigation", { name: "日程视图" });
    await expect(scheduleTabs).toBeVisible();
    await expectMinimumHeight(scheduleTabs.getByRole("link"));
    const tabCenters = await scheduleTabs.getByRole("link").evaluateAll((links) => links.map((link) => {
      const rect = link.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }));
    expect(Math.max(...tabCenters) - Math.min(...tabCenters)).toBeLessThanOrEqual(1);
    await expectNoPageOverflow(page, 390);
    await attachScreenshot(page, testInfo, "plan-tabs-390");
  } finally {
    await cleanupWorkspace(workspaceId);
  }
});

test("keeps the desktop week proportional and free of page overflow", async ({ browserName, context, page }, testInfo) => {
  test.skip(browserName !== "chromium", "desktop visual regression runs once in Chromium");
  test.skip(!dbAvailable, "local DATABASE_URL/Postgres unavailable or schema not migrated");

  const workspaceId = await seedTimetableWorkspace();
  try {
    await addWorkspaceSession(context, workspaceId);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/constraints?date=2026-09-01");
    await expectNoPageOverflow(page, 1440);
    const longCourse = page.getByRole("button", { name: /MATH 3415 W02/ }).first();
    const shortCourse = page.getByRole("button", { name: /Advanced Robotics Laboratory/ }).first();
    expect((await longCourse.boundingBox())?.height).toBeCloseTo(105, 0);
    expect((await shortCourse.boundingBox())?.height).toBeCloseTo(30, 0);
    await attachScreenshot(page, testInfo, "constraints-desktop-1440");
  } finally {
    await cleanupWorkspace(workspaceId);
  }
});
