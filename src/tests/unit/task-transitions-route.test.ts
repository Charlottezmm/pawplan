import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getWorkspaceIdFromSession: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/planning/task-transitions", async () => {
  class TaskTransitionError extends Error {
    constructor(
      public code: string,
      message: string,
      public status = 400,
      public details: Record<string, unknown> = {},
    ) {
      super(message);
    }
  }
  return {
    TaskTransitionError,
    rescheduleBacklogTask: vi.fn(),
    restoreArchivedTaskToBacklog: vi.fn(),
    moveLegacySkippedTaskToBacklog: vi.fn(),
    triageLegacySkippedTasks: vi.fn(),
  };
});

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/tasks/transitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const taskId = "11111111-1111-4111-8111-111111111111";

describe("task transition route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires an authenticated workspace", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue(null);
    const { POST } = await import("@/app/api/tasks/transitions/route");

    const response = await POST(request({}));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
  });

  it("rejects backlog rescheduling without an explicit date", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST } = await import("@/app/api/tasks/transitions/route");

    const response = await POST(request({
      action: "reschedule_backlog",
      taskId,
      idempotencyKey: "reschedule-1",
    }));

    expect(response.status).toBe(400);
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("passes a backlog transition to the workspace-scoped service", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { rescheduleBacklogTask } = await import("@/lib/planning/task-transitions");
    const db = { id: "db" };
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(rescheduleBacklogTask).mockResolvedValue({ status: "succeeded" } as never);
    const { POST } = await import("@/app/api/tasks/transitions/route");

    const response = await POST(request({
      action: "reschedule_backlog",
      taskId,
      date: "2026-08-20",
      idempotencyKey: "reschedule-1",
    }));

    expect(response.status).toBe(200);
    expect(rescheduleBacklogTask).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      action: "reschedule_backlog",
      taskId,
      date: "2026-08-20",
      idempotencyKey: "reschedule-1",
    });
  });

  it("requires and passes the expected archived state", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { restoreArchivedTaskToBacklog } = await import("@/lib/planning/task-transitions");
    const db = { id: "db" };
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(restoreArchivedTaskToBacklog).mockResolvedValue({ status: "succeeded" } as never);
    const { POST } = await import("@/app/api/tasks/transitions/route");

    const response = await POST(request({
      action: "restore_archived_to_backlog",
      taskId,
      expectedArchived: true,
      idempotencyKey: "archive-restore-1",
    }));

    expect(response.status).toBe(200);
    expect(restoreArchivedTaskToBacklog).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      action: "restore_archived_to_backlog",
      taskId,
      expectedArchived: true,
      idempotencyKey: "archive-restore-1",
    });
  });

  it("moves legacy skipped only with expectedStatus=skipped", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { moveLegacySkippedTaskToBacklog } = await import("@/lib/planning/task-transitions");
    const db = { id: "db" };
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(moveLegacySkippedTaskToBacklog).mockResolvedValue({ status: "succeeded" } as never);
    const { POST } = await import("@/app/api/tasks/transitions/route");

    const response = await POST(request({
      action: "move_legacy_skipped_to_backlog",
      taskId,
      expectedStatus: "skipped",
      idempotencyKey: "legacy-restore-1",
    }));

    expect(response.status).toBe(200);
    expect(moveLegacySkippedTaskToBacklog).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      action: "move_legacy_skipped_to_backlog",
      taskId,
      expectedStatus: "skipped",
      idempotencyKey: "legacy-restore-1",
    });
  });

  it("passes exact legacy task decisions and confirmed count to the batch service", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { triageLegacySkippedTasks } = await import("@/lib/planning/task-transitions");
    const db = { id: "db" };
    const decisions = [
      { taskId, decision: "backlog" as const },
      { taskId: "33333333-3333-4333-8333-333333333333", decision: "archive" as const },
    ];
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(triageLegacySkippedTasks).mockResolvedValue({ status: "succeeded" } as never);
    const { POST } = await import("@/app/api/tasks/transitions/route");

    const response = await POST(request({
      action: "triage_legacy_skipped_tasks",
      decisions,
      confirmCount: 2,
      idempotencyKey: "legacy-triage-1",
    }));

    expect(response.status).toBe(200);
    expect(triageLegacySkippedTasks).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      action: "triage_legacy_skipped_tasks",
      decisions,
      confirmCount: 2,
      idempotencyKey: "legacy-triage-1",
    });
  });
});
