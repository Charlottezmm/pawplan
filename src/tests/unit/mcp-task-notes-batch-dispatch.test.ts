import { beforeEach, describe, expect, it, vi } from "vitest";

const notesBatch = vi.hoisted(() => ({
  propose: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("@/lib/mcp/task-notes-batch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/task-notes-batch")>("@/lib/mcp/task-notes-batch");
  return {
    ...actual,
    proposeTaskNotesBatch: notesBatch.propose,
    applyTaskNotesBatch: notesBatch.apply,
  };
});

import { pawPlanToolSchemas, runPawPlanTool } from "@/lib/mcp/tools";

const taskId = "11111111-1111-4111-8111-111111111111";
const approvalId = "22222222-2222-4222-8222-222222222222";

describe("task notes batch MCP dispatch", () => {
  beforeEach(() => {
    notesBatch.propose.mockReset().mockResolvedValue({ status: "pending_review" });
    notesBatch.apply.mockReset().mockResolvedValue({ status: "succeeded" });
  });

  it("maps the review proposal and exact apply credentials", async () => {
    await runPawPlanTool({} as any, "workspace-1", "propose_task_notes_batch", {
      idempotency_key: "notes-proposal-1",
      reason: "Add structured details",
      operations: [{ task_id: taskId, notes: "  exact notes  " }],
    }, "review_only");
    expect(notesBatch.propose).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-1",
      idempotencyKey: "notes-proposal-1",
      reason: "Add structured details",
      operations: [{ taskId, notes: "exact notes" }],
    });

    await runPawPlanTool({} as any, "workspace-1", "apply_task_notes_batch", {
      approval_id: approvalId,
      preview_token: "x".repeat(40),
      idempotency_key: "notes-key-1",
    }, "read_write");
    expect(notesBatch.apply).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-1",
      approvalId,
      previewToken: "x".repeat(40),
      idempotencyKey: "notes-key-1",
    });
  });

  it("keeps apply closed to review-only tokens and rejects partial-apply fields", async () => {
    await expect(runPawPlanTool({} as any, "workspace-1", "apply_task_notes_batch", {
      approval_id: approvalId,
      preview_token: "x".repeat(40),
      idempotency_key: "notes-key-1",
    }, "review_only")).rejects.toMatchObject({
      code: "mcp_permission_denied",
      permission: "review_only",
      toolName: "apply_task_notes_batch",
    });

    expect(pawPlanToolSchemas.apply_task_notes_batch.safeParse({
      approval_id: approvalId,
      preview_token: "x".repeat(40),
      idempotency_key: "notes-key-1",
      task_ids: [taskId],
    }).success).toBe(false);
  });

  it("enforces unique task IDs and the 50-item limit", () => {
    expect(pawPlanToolSchemas.propose_task_notes_batch.safeParse({
      idempotency_key: "notes-proposal-1",
      operations: [
        { task_id: taskId, notes: "one" },
        { task_id: taskId, notes: "two" },
      ],
    }).success).toBe(false);
    expect(pawPlanToolSchemas.propose_task_notes_batch.safeParse({
      idempotency_key: "notes-proposal-1",
      operations: Array.from({ length: 51 }, (_, index) => ({
        task_id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
        notes: "notes",
      })),
    }).success).toBe(false);
  });
});
