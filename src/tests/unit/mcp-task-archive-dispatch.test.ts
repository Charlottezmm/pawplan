import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const archiveMocks = vi.hoisted(() => ({
  applyTaskArchiveBatch: vi.fn(),
  attachTaskBatchPostCommitReadback: vi.fn(async (result: unknown) => result),
  previewTaskBatch: vi.fn(),
}));

vi.mock("@/lib/mcp/task-archive", () => archiveMocks);

import { runPawPlanTool } from "@/lib/mcp/tools";

const approvalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("archive/delete MCP approval dispatch", () => {
  beforeEach(() => {
    process.env.PAWPLAN_TASK_ARCHIVE_ENABLED = "true";
    process.env.PAWPLAN_TASK_DELETE_ENABLED = "true";
    archiveMocks.applyTaskArchiveBatch.mockReset().mockResolvedValue({
      status: "succeeded",
      operationId: "operation-1",
      groupId: null,
      idempotencyKey: "archive-key",
      processedCount: 1,
      taskIds: ["task-1"],
      unchangedTaskIds: [],
    });
    archiveMocks.attachTaskBatchPostCommitReadback.mockClear();
  });

  afterEach(() => {
    delete process.env.PAWPLAN_TASK_ARCHIVE_ENABLED;
    delete process.env.PAWPLAN_TASK_DELETE_ENABLED;
  });

  it("passes the approved approval_id to archive/restore apply", async () => {
    await runPawPlanTool({} as any, "workspace-1", "archive_tasks_batch", {
      preview_token: "x".repeat(40),
      approval_id: approvalId,
      confirm_task_count: 1,
      idempotency_key: "archive-key",
    });

    expect(archiveMocks.applyTaskArchiveBatch).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceId: "workspace-1",
      action: "archive",
      approvalId,
    }));
  });

  it("passes the approved approval_id to permanent delete apply", async () => {
    const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await runPawPlanTool({} as any, "workspace-1", "delete_tasks_batch", {
      preview_token: "x".repeat(40),
      approval_id: approvalId,
      confirm_task_count: 1,
      confirmation: "PERMANENT_DELETE",
      idempotency_key: "delete-key",
      operation_id: operationId,
    });

    expect(archiveMocks.applyTaskArchiveBatch).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceId: "workspace-1",
      action: "delete",
      approvalId,
      groupId: operationId,
    }));
  });
});
