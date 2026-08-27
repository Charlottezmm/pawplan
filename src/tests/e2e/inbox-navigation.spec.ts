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

test("exposes 收集 as a primary navigation destination", async ({ context, page, isMobile }) => {
  await addWorkspaceSession(context);

  await page.goto("/today");
  const nav = page.getByLabel(isMobile ? "Mobile navigation" : "Primary navigation");
  const inboxLink = nav.getByRole("link", { name: "收集", exact: true });
  await expect(inboxLink).toBeVisible();

  await inboxLink.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("heading", { name: "暂存池", exact: true })).toBeVisible();
});
