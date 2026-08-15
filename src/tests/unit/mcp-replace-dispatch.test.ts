import { afterEach, describe, expect, it, vi } from "vitest";

const replaceMocks = vi.hoisted(() => ({
  previewReplacePlanWindow: vi.fn(),
  replacePlanWindow: vi.fn(),
}));

vi.mock("@/lib/mcp/replace-plan-window", () => replaceMocks);

import { runPawPlanTool } from "@/lib/mcp/tools";

describe("replace plan window MCP dispatch", () => {
  afterEach(() => {
    delete process.env.PAWPLAN_REPLACE_PLAN_WINDOW_ENABLED;
    replaceMocks.replacePlanWindow.mockReset();
  });

  it("returns the service's persisted post-commit readback without a second fallible wrapper read", async () => {
    process.env.PAWPLAN_REPLACE_PLAN_WINDOW_ENABLED = "true";
    const serviceResult = {
      status: "succeeded",
      created: [],
      archived: [],
      unchanged: [],
      failed: [],
      postCommitReadback: { verification: "succeeded", todoCount: 0, backlogCount: 0 },
    };
    replaceMocks.replacePlanWindow.mockResolvedValue(serviceResult);

    const result = await runPawPlanTool({} as any, "workspace-1", "replace_plan_window", {
      date_from: "2026-08-15",
      date_to: "2026-08-30",
      source_key: "august-plan",
      expected_plan_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expected_current_version_id: null,
      retire_scope: "all_non_completed",
      tasks: [],
      weekly_summaries: [],
      monthly_summaries: [],
      focus_project_ids: [],
      idempotency_key: "replace-key",
      mode: "replace",
      preview_token: "x".repeat(40),
      approval_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    expect(result).toBe(serviceResult);
    expect(replaceMocks.replacePlanWindow).toHaveBeenCalledTimes(1);
  });
});
