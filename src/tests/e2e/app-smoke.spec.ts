import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

function signedWorkspaceSession(workspaceId: string) {
  const signature = createHmac("sha256", "test-secret").update(workspaceId).digest("base64url");
  return `${workspaceId}.${signature}`;
}

test("redirects unauthenticated visitors to login", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "PawPlan" })).toBeVisible();
  await expect(page.getByPlaceholder("Workspace 名称")).toBeVisible();
});

test("renders Today on desktop and mobile with a workspace session", async ({ context, page, isMobile }) => {
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

  await page.goto("/today");
  await expect(page.getByText(/月\d+日 星期/)).toBeVisible();
  await expect(page.getByText("今天还没有安排任务", { exact: true })).toBeVisible();
  await expect(page.getByText("今日任务")).toBeVisible();
  await expect(page.getByRole("heading", { name: "收工反馈" })).toBeVisible();
  const nav = page.getByLabel(isMobile ? "Mobile navigation" : "Primary navigation");
  await expect(nav.getByRole("link", { name: "今天", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "计划", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "收集", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "审核", exact: true })).toBeVisible();
  await expect(nav.getByRole("link")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "账户与设置" })).toBeVisible();
});

test("renders real settings surfaces without fake recovery saves", async ({ context, page }) => {
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

  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      json: {
        routines: [],
        segmentEnergySettings: [
          { segment: "morning", energyLevel: "high" },
          { segment: "afternoon", energyLevel: "medium" },
          { segment: "evening", energyLevel: "low" },
        ],
        agentRuns: [],
        recoveryTarget: { minutes: 480, editable: false, source: "system_default" },
      },
    });
  });
  await page.route("**/api/mcp-tokens", async (route) => {
    await route.fulfill({
      json: {
        workspaceId: "00000000-0000-0000-0000-000000000001",
        tokens: [],
        mcp: { url: "https://pawplan.example/api/mcp", codexConfig: "[mcp_servers.pawplan]" },
      },
    });
  });
  await page.route("**/api/oauth/authorizations", async (route) => {
    await route.fulfill({
      json: {
        mcpUrl: "https://pawplan.example/api/mcp",
        protectedResourceMetadataUrl: "https://pawplan.example/.well-known/oauth-protected-resource/api/mcp",
        authorizationServerMetadataUrl: "https://pawplan.example/.well-known/oauth-authorization-server",
        authorizations: [],
      },
    });
  });
  await page.route("https://pawplan.example/.well-known/oauth-protected-resource/api/mcp", async (route) => {
    await route.fulfill({
      json: {
        resource: "https://pawplan.example/api/mcp",
        authorization_servers: ["https://pawplan.example"],
      },
    });
  });
  await page.route("https://pawplan.example/.well-known/oauth-authorization-server", async (route) => {
    await route.fulfill({
      json: {
        issuer: "https://pawplan.example",
        authorization_endpoint: "https://pawplan.example/api/oauth/authorize",
        token_endpoint: "https://pawplan.example/api/oauth/token",
        scopes_supported: ["mcp"],
      },
    });
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "恢复目标" })).toBeVisible();
  await expect(page.getByText("系统默认 8 小时", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "日常事项", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "能量规则", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex bearer token 连接配置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Claude Custom Connector" })).toBeVisible();
  await expect(page.getByText("Metadata verified", { exact: true })).toHaveCount(2);
});

test("keeps legacy More free of duplicate Settings and Plan destinations", async ({ context, page }) => {
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

  await page.goto("/more");
  await expect(page.getByText("PawPlan v1 formal controlled beta")).toBeVisible();
  await expect(page.locator('a[href="/constraints"]').filter({ hasText: "固定安排" })).toHaveCount(0);
  await expect(page.locator('a[href="/settings#routines"]').filter({ hasText: "日常事项" })).toHaveCount(0);
  await expect(page.locator('a[href="/constraints"]').filter({ hasText: "日历与课程" })).toHaveCount(0);
  await expect(page.locator(".paw-more-sections").locator('a[href="/settings"]')).toHaveCount(1);
  await expect(page.getByText("MCP 连接", { exact: true })).toHaveCount(0);
});
