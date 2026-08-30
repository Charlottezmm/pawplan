import { expect, test, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";

function signedWorkspaceSession(workspaceId: string) {
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  return `${workspaceId}.${signature}`;
}

async function routeEmptyOnboarding(page: Page) {
  await page.route("**/api/onboarding", async (route) => {
    await route.fulfill({
      json: {
        workspaceId: "00000000-0000-0000-0000-000000000001",
        signals: { workspaceCreated: true },
        completedCount: 0,
        totalCount: 4,
        nextStep: null,
        steps: [],
      },
    });
  });
}

test("shows invite-gated login and create modes without open workspace creation copy", async ({ page }) => {
  await page.goto("/login");

  const loginMode = page.getByRole("button", { name: "登录已有计划空间" });
  const createMode = page.getByRole("button", { name: "邀请创建计划空间" });

  await expect(loginMode).toBeVisible();
  await expect(loginMode).toHaveAttribute("aria-pressed", "true");
  await expect(createMode).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("新名字会自动创建")).toHaveCount(0);
  await expect(page.getByLabel("邀请码")).toHaveCount(0);
  await expect(page.getByLabel("计划空间名称")).toHaveAttribute("name", "workspaceName");
  await expect(page.getByLabel("计划空间名称")).toHaveAttribute("required", "");
  await expect(page.getByLabel("计划空间名称")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("autocomplete", "current-password");

  await createMode.click();

  await expect(loginMode).toHaveAttribute("aria-pressed", "false");
  await expect(createMode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("邀请码")).toBeVisible();
  await expect(page.getByLabel("确认密码")).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("autocomplete", "new-password");

  await page.getByRole("button", { name: "显示密码" }).click();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "text");
  await expect(page.getByLabel("确认密码")).toHaveAttribute("type", "text");
  await expect(page.getByText("目前没有自助找回或重置入口")).toHaveCount(1);
});

test("creates a beta workspace through the mocked invite route and redirects to Today", async ({ page }) => {
  await routeEmptyOnboarding(page);
  await page.route("**/api/beta/workspaces", async (route) => {
    await route.fulfill({
      status: 201,
      headers: {
        "Set-Cookie": `daily_progress_workspace=${signedWorkspaceSession("00000000-0000-0000-0000-000000000001")}; Path=/; SameSite=Lax; HttpOnly`,
      },
      json: { workspaceId: "00000000-0000-0000-0000-000000000001", planId: "plan-1", created: true },
    });
  });

  await page.goto("/login");
  await page.getByRole("button", { name: "邀请创建计划空间" }).click();
  await page.getByLabel("计划空间名称").fill("Focus Lab");
  await page.getByLabel("密码", { exact: true }).fill("correct horse");
  await page.getByLabel("确认密码").fill("correct horse");
  await page.getByLabel("邀请码").fill("BETA-123");
  await page.getByRole("button", { name: "创建并进入" }).click();

  await expect(page).toHaveURL(/\/today$/);
});

test("creates a workspace from a one-time invite link without exposing the invite code", async ({ page }) => {
  await routeEmptyOnboarding(page);
  let submittedBody: unknown = null;
  await page.route("**/api/beta/workspaces", async (route) => {
    submittedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      headers: {
        "Set-Cookie": `daily_progress_workspace=${signedWorkspaceSession("00000000-0000-0000-0000-000000000001")}; Path=/; SameSite=Lax; HttpOnly`,
      },
      json: { workspaceId: "00000000-0000-0000-0000-000000000001", planId: "plan-1", created: true },
    });
  });

  await page.goto("/join/PAW-LINK-123");

  await expect(page.getByText(/把任务、固定日程和 Agent 建议放进同一个可审核的计划空间/)).toBeVisible();
  await expect(page.getByLabel("邀请码")).toHaveCount(0);
  await page.getByLabel("计划空间名称").fill("Invite Lab");
  await page.getByLabel("密码", { exact: true }).fill("correct horse");
  await page.getByLabel("确认密码").fill("correct horse");
  await page.getByRole("button", { name: "创建并进入" }).click();

  await expect(page).toHaveURL(/\/today$/);
  expect(submittedBody).toEqual({
    workspaceName: "Invite Lab",
    password: "correct horse",
    inviteCode: "PAW-LINK-123",
  });
});

test("shows the login error from the existing workspace login route", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({ status: 401, json: { error: "Workspace not found" } });
  });

  await page.goto("/login");
  await page.getByLabel("计划空间名称").fill("Missing Lab");
  await page.getByLabel("密码", { exact: true }).fill("correct horse");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByText("未找到这个计划空间")).toBeVisible();
});

test("shows a Chinese error when an invite can no longer be used", async ({ page }) => {
  await page.route("**/api/beta/workspaces", async (route) => {
    await route.fulfill({ status: 403, json: { error: "Invite code expired" } });
  });

  await page.goto("/login");
  await page.getByRole("button", { name: "邀请创建计划空间" }).click();
  await page.getByLabel("计划空间名称").fill("Focus Lab");
  await page.getByLabel("密码", { exact: true }).fill("correct horse");
  await page.getByLabel("确认密码").fill("correct horse");
  await page.getByLabel("邀请码").fill("OLD-BETA");
  await page.getByRole("button", { name: "创建并进入" }).click();

  await expect(page.getByText("邀请码已过期，请申请新的邀请链接", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建并进入" })).toBeEnabled();
});

test("recovers from non-JSON and network login failures without leaving the form pending", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" });
  });

  await page.goto("/login");
  await page.getByLabel("计划空间名称").fill("Focus Lab");
  await page.getByLabel("密码", { exact: true }).fill("correct horse");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByText("登录失败，请稍后重试", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入" })).toBeEnabled();

  await page.unroute("**/api/auth/login");
  await page.route("**/api/auth/login", async (route) => route.abort("failed"));
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page.getByText("网络请求失败，请检查连接后重试", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入" })).toBeEnabled();
});

test("blocks workspace creation when password confirmation does not match", async ({ page }) => {
  let createRequests = 0;
  await page.route("**/api/beta/workspaces", async (route) => {
    createRequests += 1;
    await route.fulfill({ status: 201, json: { created: true } });
  });

  await page.goto("/login");
  await page.getByRole("button", { name: "邀请创建计划空间" }).click();
  await page.getByLabel("计划空间名称").fill("Focus Lab");
  await page.getByLabel("密码", { exact: true }).fill("correct horse");
  await page.getByLabel("确认密码").fill("different horse");
  await page.getByLabel("邀请码").fill("BETA-123");
  await page.getByRole("button", { name: "创建并进入" }).click();

  await expect(page.getByText("两次输入的密码不一致", { exact: true })).toBeVisible();
  expect(createRequests).toBe(0);
});

test("honors a relative login next path after existing workspace login", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      headers: {
        "Set-Cookie": `daily_progress_workspace=${signedWorkspaceSession("00000000-0000-0000-0000-000000000001")}; Path=/; SameSite=Lax; HttpOnly`,
      },
      json: { workspaceId: "00000000-0000-0000-0000-000000000001", created: false },
    });
  });

  await page.goto("/login?next=%2Fapi%2Foauth%2Fauthorize%3Fresponse_type%3Dcode%26client_id%3Dclient-1");
  await page.getByLabel("计划空间名称").fill("Focus Lab");
  await page.getByLabel("密码", { exact: true }).fill("correct horse");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page).toHaveURL(/\/api\/oauth\/authorize\?response_type=code&client_id=client-1$/);
});

test("ignores external login next targets after existing workspace login", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      headers: {
        "Set-Cookie": `daily_progress_workspace=${signedWorkspaceSession("00000000-0000-0000-0000-000000000001")}; Path=/; SameSite=Lax; HttpOnly`,
      },
      json: { workspaceId: "00000000-0000-0000-0000-000000000001", created: false },
    });
  });

  await page.goto("/login?next=https%3A%2F%2Fevil.example%2Fcallback");
  await page.getByLabel("计划空间名称").fill("Focus Lab");
  await page.getByLabel("密码", { exact: true }).fill("correct horse");
  await page.getByRole("button", { name: "进入" }).click();

  await expect(page).toHaveURL(/\/today$/);
});

test("renders first-run checklist and skip action updates state", async ({ context, page }) => {
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

  const baseSteps = [
    {
      id: "plan_imported",
      title: "导入真实计划",
      description: "把 Claude/Codex 输出的计划导入 PawPlan。",
      href: "/import",
      status: "complete",
    },
    {
      id: "schedule_ready",
      title: "导入固定日程",
      description: "导入课程、会议或不可移动时间块。",
      href: "/constraints",
      status: "next",
      skipEventType: "schedule_import_skipped",
    },
    {
      id: "connector_ready",
      title: "连接 Codex MCP",
      description: "创建 active MCP token，或显式跳过连接设置。",
      href: "/settings",
      status: "pending",
      skipEventType: "connector_setup_skipped",
    },
    {
      id: "review_ready",
      title: "打开审核页",
      description: "看一次 Agent 建议审核页。",
      href: "/review",
      status: "pending",
    },
  ];
  let scheduleSkipped = false;
  let connectorSkipped = false;

  await page.route("**/api/onboarding", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { eventKey: string };
      if (body.eventKey === "schedule_import_skipped") scheduleSkipped = true;
      if (body.eventKey === "connector_setup_skipped") connectorSkipped = true;
    }

    const steps = baseSteps.map((step) => {
      if (step.id === "schedule_ready" && scheduleSkipped) return { ...step, status: "skipped" };
      if (step.id === "connector_ready" && connectorSkipped) return { ...step, status: "skipped" };
      if (step.id === "connector_ready" && scheduleSkipped) return { ...step, status: "next" };
      if (step.id === "review_ready" && connectorSkipped) return { ...step, status: "next" };
      return step;
    });
    await route.fulfill({
      json: {
        workspaceId: "00000000-0000-0000-0000-000000000001",
        signals: { workspaceCreated: true },
        completedCount: steps.filter((step) => step.status === "complete" || step.status === "skipped").length,
        totalCount: steps.length,
        nextStep: steps.find((step) => step.status === "next") ?? null,
        steps,
      },
    });
  });

  await page.goto("/today");

  await expect(page.getByRole("heading", { name: "v1 formal checklist" })).toBeVisible();
  await expect(page.getByRole("link", { name: /导入固定日程/ })).toHaveAttribute("href", "/constraints");
  await expect(page.getByText("下一步", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "跳过固定日程导入" }).click();

  await expect(page.getByText("已跳过", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /连接 Codex MCP/ })).toHaveAttribute("href", "/settings");

  await page.getByRole("button", { name: "跳过连接设置" }).click();

  await expect(page.getByRole("link", { name: /打开审核页/ })).toHaveAttribute("href", "/review");
});

test("shows a visible onboarding error when state fetch fails", async ({ context, page }) => {
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
  await page.route("**/api/onboarding", async (route) => {
    await route.fulfill({ status: 500, json: { error: "Onboarding unavailable" } });
  });

  await page.goto("/today");

  await expect(page.getByRole("heading", { name: "v1 formal checklist" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "无法读取 onboarding 状态" })).toBeVisible();
});
