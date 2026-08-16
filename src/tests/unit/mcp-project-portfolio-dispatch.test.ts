import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proposeProjectPortfolioUpdate: vi.fn(),
  applyProjectPortfolioUpdate: vi.fn(),
}));
vi.mock("@/lib/mcp/project-portfolio-update", () => ({
  ...mocks,
  ProjectPortfolioUpdateError: class ProjectPortfolioUpdateError extends Error {},
}));

import { pawPlanToolSchemas, runPawPlanTool } from "@/lib/mcp/tools";
import { allowedPawPlanToolNames } from "@/lib/mcp/tools";

const update = {
  projects: [{
    action: "create",
    client_key: "research",
    name: "Embodied AI Research",
    color: "#2563eb",
    category: "科研",
    objective: "Build a world model",
    success_criteria: "Validated experiment",
    status: "active",
    priority: "high",
    start_date: null,
    target_date: "2026-12-20",
    weekly_target_minutes: 600,
  }],
  milestones: [],
};

describe("Project Portfolio MCP contract and dispatch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps both tools strict and requires approval fields only on apply", () => {
    expect(pawPlanToolSchemas.propose_project_portfolio_update.safeParse({ update, extra: true }).success).toBe(false);
    expect(pawPlanToolSchemas.propose_project_portfolio_update.safeParse({ update }).success).toBe(true);
    expect(pawPlanToolSchemas.apply_project_portfolio_update.safeParse({ update }).success).toBe(false);
    expect(pawPlanToolSchemas.apply_project_portfolio_update.safeParse({
      update,
      preview_token: "x".repeat(40),
      approval_id: "11111111-1111-4111-8111-111111111111",
      idempotency_key: "portfolio-key",
    }).success).toBe(true);
    expect(allowedPawPlanToolNames("read_write")).toEqual(expect.arrayContaining([
      "propose_project_portfolio_update",
      "apply_project_portfolio_update",
    ]));
    expect(allowedPawPlanToolNames("read_only")).not.toContain("propose_project_portfolio_update");
    expect(allowedPawPlanToolNames("read_only")).not.toContain("apply_project_portfolio_update");
  });

  it("maps strict snake-case MCP input to the exact service update", async () => {
    mocks.proposeProjectPortfolioUpdate.mockResolvedValue({ status: "pending_review" });
    await runPawPlanTool({} as any, "workspace-1", "propose_project_portfolio_update", {
      update,
      reason: "Define before planning",
    });
    expect(mocks.proposeProjectPortfolioUpdate).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceId: "workspace-1",
      reason: "Define before planning",
      update: {
        projects: [expect.objectContaining({ clientKey: "research", successCriteria: "Validated experiment" })],
        milestones: [],
      },
    }));
  });

  it("does not allow direct task writers to create skipped status", () => {
    expect(pawPlanToolSchemas.update_task_status.safeParse({ task_id: "task-1", status: "skipped" }).success).toBe(false);
    expect(pawPlanToolSchemas.update_task_schedule.safeParse({ task_id: "task-1", status: "skipped" }).success).toBe(false);
    expect(pawPlanToolSchemas.update_tasks_batch.safeParse({
      idempotency_key: "task-write-key",
      operations: [{ task_id: "task-1", status: "skipped" }],
    }).success).toBe(false);
    expect(pawPlanToolSchemas.get_tasks.safeParse({ status: "skipped" }).success).toBe(true);
  });
});
