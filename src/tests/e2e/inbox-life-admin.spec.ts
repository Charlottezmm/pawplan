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

test("captures a chore in Inbox and promotes it with visible scheduling metadata", async ({ context, page }) => {
  await addWorkspaceSession(context);
  const inboxPatchBodies: unknown[] = [];

  await page.route("**/api/inbox", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({ title: "倒垃圾" });
      await route.fulfill({
        json: {
          item: {
            id: "11111111-1111-4111-8111-111111111111",
            title: "倒垃圾",
            age: "刚刚",
          },
        },
      });
      return;
    }

    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      inboxPatchBodies.push(body);
      await route.fulfill({ json: { ok: true, action: (body as { action: string }).action } });
      return;
    }

    await route.fallback();
  });

  await page.goto("/inbox");
  await expect(page.getByText(/暂存区/).first()).toBeVisible();
  await page.getByPlaceholder("记一条想法…").fill("倒垃圾");
  await page.getByRole("button", { name: "添加" }).click();
  await expect(page.getByText("倒垃圾", { exact: true })).toBeVisible();
  await expect(page.getByText("刚刚捕获")).toBeVisible();

  const row = page.locator(".paw-inbox-item", { hasText: "倒垃圾" });
  await row.getByRole("button", { name: /提升/ }).click();
  await expect(row.getByLabel("任务日期")).not.toBeVisible();
  await expect(row.getByRole("button", { name: "每天" })).not.toBeVisible();
  await row.getByRole("button", { name: "任务", exact: true }).click();
  await row.getByLabel("任务日期").fill("2026-06-20");
  await row.getByRole("combobox", { name: /^时段$/ }).selectOption("evening");
  await row.getByLabel("估时（分钟）").fill("15");
  await expect(row.getByRole("button", { name: "今天 · 晚上 · 15 分" })).toBeVisible();
  await row.getByRole("button", { name: "提升任务" }).click();

  await expect(row).toHaveCount(0);
  expect(inboxPatchBodies).toEqual([
    {
      id: "11111111-1111-4111-8111-111111111111",
      action: "task",
      date: "2026-06-20",
      daySegment: "evening",
      estimatedMinutes: 15,
      priority: "normal",
    },
  ]);
});

test("chooses a routine destination with weekday controls instead of raw recurrence syntax", async ({ context, page }) => {
  await addWorkspaceSession(context);
  const inboxPatchBodies: unknown[] = [];

  await page.route("**/api/inbox", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      await route.fulfill({
        json: {
          item: {
            id: "33333333-3333-4333-8333-333333333333",
            title: "整理桌面",
            age: "刚刚",
          },
        },
      });
      return;
    }

    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      inboxPatchBodies.push(body);
      await route.fulfill({ json: { ok: true, action: (body as { action: string }).action } });
      return;
    }

    await route.fallback();
  });

  await page.goto("/inbox");
  await page.getByPlaceholder("记一条想法…").fill("整理桌面");
  await page.getByRole("button", { name: "添加" }).click();

  const row = page.locator(".paw-inbox-item", { hasText: "整理桌面" });
  await row.getByRole("button", { name: /提升/ }).click();
  await row.getByRole("button", { name: "日常", exact: true }).click();
  await expect(row.getByRole("button", { name: "每天" })).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByLabel("任务日期")).not.toBeVisible();

  await row.getByRole("button", { name: "星期一" }).click();
  await row.getByRole("button", { name: "星期三" }).click();
  await row.getByRole("combobox", { name: "默认时段" }).selectOption("morning");
  await row.getByLabel("估时（分钟）").fill("20");
  await row.getByRole("button", { name: "转日常" }).click();

  expect(inboxPatchBodies).toEqual([
    {
      id: "33333333-3333-4333-8333-333333333333",
      action: "routine",
      weekdayPattern: "mon,wed",
      defaultTimeSegment: "morning",
      estimatedMinutes: 20,
    },
  ]);
});

test("shows field errors beside invalid promotion values and confirms permanent deletion", async ({ context, page }) => {
  await addWorkspaceSession(context);
  const inboxPatchBodies: unknown[] = [];

  await page.route("**/api/inbox", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      await route.fulfill({
        json: {
          item: {
            id: "44444444-4444-4444-8444-444444444444",
            title: "重复记录",
            age: "刚刚",
          },
        },
      });
      return;
    }

    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      inboxPatchBodies.push(body);
      await route.fulfill({ json: { ok: true, action: (body as { action: string }).action } });
      return;
    }

    await route.fallback();
  });

  await page.goto("/inbox");
  await page.getByPlaceholder("记一条想法…").fill("重复记录");
  await page.getByRole("button", { name: "添加" }).click();

  const row = page.locator(".paw-inbox-item", { hasText: "重复记录" });
  await row.getByRole("button", { name: /提升/ }).click();
  await row.getByRole("button", { name: "任务", exact: true }).click();
  await row.getByLabel("任务日期").fill("");
  await row.getByLabel("估时（分钟）").fill("4");
  await row.getByRole("button", { name: "提升任务" }).click();

  await expect(row.getByLabel("任务日期")).toHaveAttribute("aria-invalid", "true");
  await expect(row.getByLabel("估时（分钟）")).toHaveAttribute("aria-invalid", "true");
  await expect(row.getByText("请选择任务日期。")).toBeVisible();
  await expect(row.getByText("请输入 5–480 之间的整数分钟。")).toBeVisible();
  expect(inboxPatchBodies).toEqual([]);

  await row.getByRole("button", { name: "删除" }).click();
  const confirmDialog = page.getByRole("dialog", { name: "删除收集条目？" });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByText(/永久删除/)).toBeVisible();
  await confirmDialog.getByRole("button", { name: "确认删除" }).click();
  await expect(row).toHaveCount(0);
  expect(inboxPatchBodies).toEqual([
    {
      id: "44444444-4444-4444-8444-444444444444",
      action: "delete",
    },
  ]);
});

test("quick chore promotion sends no hidden browser-local date", async ({ context, page }) => {
  await addWorkspaceSession(context);
  const inboxPatchBodies: unknown[] = [];

  await page.route("**/api/inbox", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      await route.fulfill({
        json: {
          item: {
            id: "22222222-2222-4222-8222-222222222222",
            title: "买纸巾",
            age: "刚刚",
          },
        },
      });
      return;
    }

    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      inboxPatchBodies.push(body);
      await route.fulfill({ json: { ok: true, action: (body as { action: string }).action } });
      return;
    }

    await route.fallback();
  });

  await page.goto("/inbox");
  await page.getByPlaceholder("记一条想法…").fill("买纸巾");
  await page.getByRole("button", { name: "添加" }).click();

  const row = page.locator(".paw-inbox-item", { hasText: "买纸巾" });
  await row.getByRole("button", { name: "今日杂事" }).click();

  expect(inboxPatchBodies).toEqual([
    {
      id: "22222222-2222-4222-8222-222222222222",
      action: "quick_chore_task",
    },
  ]);
});
