import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  getWorkspaceIdFromSession: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/planning/active-plan", () => ({
  getActivePlanId: vi.fn(),
}));

vi.mock("@/lib/planning/service", () => {
  class PlanningServiceError extends Error {
    constructor(message: string, public status = 400) {
      super(message);
    }
  }

  return {
    PlanningServiceError,
    updateTaskNotes: vi.fn(),
    updateTaskSchedule: vi.fn(),
    updateTaskStatus: vi.fn(),
  };
});

const taskId = "11111111-1111-4111-8111-111111111111";

function patchRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/tasks", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(path = "/api/tasks") {
  return new Request(`http://localhost${path}`);
}

function sqlParamValues(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return [];
  return chunks.flatMap((chunk) => {
    if (chunk && typeof chunk === "object" && "value" in chunk && "encoder" in chunk) {
      return [(chunk as { value: unknown }).value];
    }
    return sqlParamValues(chunk);
  });
}

describe("tasks route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("requires a workspace session for PATCH", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({ id: taskId, status: "done" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("rejects an invalid GET task id before opening the database", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { GET } = await import("@/app/api/tasks/route");

    const response = await GET(getRequest("/api/tasks?id=not-a-uuid"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid task id" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("filters single-task reads by the session workspace and active plan before task id", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { getActivePlanId } = await import("@/lib/planning/active-plan");
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-a");
    vi.mocked(getActivePlanId).mockResolvedValue("plan-active");
    vi.mocked(getDb).mockReturnValue({ select } as never);
    const { GET } = await import("@/app/api/tasks/route");

    const response = await GET(getRequest(`/api/tasks?id=${taskId}`));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Task not found" });
    expect(getActivePlanId).toHaveBeenCalledWith({ select }, "workspace-a");
    expect(sqlParamValues(where.mock.calls[0][0])).toEqual(["workspace-a", "plan-active", taskId]);
  });

  it("filters task list reads by the session workspace and active plan", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { getActivePlanId } = await import("@/lib/planning/active-plan");
    const where = vi.fn().mockResolvedValue([]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-b");
    vi.mocked(getActivePlanId).mockResolvedValue("plan-active");
    vi.mocked(getDb).mockReturnValue({ select } as never);
    const { GET } = await import("@/app/api/tasks/route");

    const response = await GET(getRequest("/api/tasks"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: [] });
    expect(getActivePlanId).toHaveBeenCalledWith({ select }, "workspace-b");
    expect(sqlParamValues(where.mock.calls[0][0])).toEqual(["workspace-b", "plan-active"]);
  });

  it("rejects PATCH without a status or schedule field before opening the database", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({ id: taskId }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid task update" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("does not expose legacy skipped as a user-writable task status", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({ id: taskId, status: "skipped" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid task update" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("updates task status through the status service", async () => {
    const task = { id: taskId, status: "done" };
    const db = { id: "db" };
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { updateTaskSchedule, updateTaskStatus } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(updateTaskStatus).mockResolvedValue(task);
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({ id: taskId, status: "done" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task });
    expect(updateTaskStatus).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      taskId,
      status: "done",
      source: "manual",
    });
    expect(updateTaskSchedule).not.toHaveBeenCalled();
  });

  it("updates task notes through the notes service", async () => {
    const task = { id: taskId, notes: "目标：补齐任务说明" };
    const db = { id: "db" };
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { updateTaskNotes, updateTaskSchedule, updateTaskStatus } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(updateTaskNotes).mockResolvedValue(task);
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({ id: taskId, notes: "目标：补齐任务说明" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task });
    expect(updateTaskNotes).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      taskId,
      notes: "目标：补齐任务说明",
      source: "manual",
    });
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(updateTaskSchedule).not.toHaveBeenCalled();
  });

  it("updates blocked state through the status service", async () => {
    const task = { id: taskId, blocked: true };
    const db = { id: "db" };
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { updateTaskSchedule, updateTaskStatus } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(updateTaskStatus).mockResolvedValue(task);
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({ id: taskId, blocked: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task });
    expect(updateTaskStatus).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      taskId,
      blocked: true,
      source: "manual",
    });
    expect(updateTaskSchedule).not.toHaveBeenCalled();
  });

  it("updates task schedule through the schedule service", async () => {
    const task = { id: taskId, date: "2026-06-17", daySegment: "afternoon" };
    const db = { id: "db" };
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { updateTaskSchedule, updateTaskStatus } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(updateTaskSchedule).mockResolvedValue(task);
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({ id: taskId, date: "2026-06-17", daySegment: "afternoon" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task });
    expect(updateTaskSchedule).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: "workspace-1",
        taskId,
        date: "2026-06-17",
        daySegment: "afternoon",
        source: "manual",
      }),
    );
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it("updates an existing estimate only with the expected current value", async () => {
    const task = { id: taskId, estimatedMinutes: 20, status: "todo" };
    const db = { id: "db" };
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { updateTaskSchedule, updateTaskStatus } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(updateTaskSchedule).mockResolvedValue(task);
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({
      id: taskId,
      estimatedMinutes: 20,
      expectedEstimatedMinutes: 60,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task });
    expect(updateTaskSchedule).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      taskId,
      status: undefined,
      blocked: undefined,
      date: undefined,
      daySegment: undefined,
      estimatedMinutes: 20,
      expectedEstimatedMinutes: 60,
      source: "manual",
    });
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it("rejects an estimate update without optimistic-concurrency state", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(patchRequest({ id: taskId, estimatedMinutes: 20 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid task update" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("keeps status when status and schedule are updated together", async () => {
    const task = { id: taskId, status: "done", date: "2026-06-17", daySegment: "evening" };
    const db = { id: "db" };
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { updateTaskSchedule, updateTaskStatus } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(updateTaskSchedule).mockResolvedValue(task);
    const { PATCH } = await import("@/app/api/tasks/route");

    const response = await PATCH(
      patchRequest({ id: taskId, status: "done", date: "2026-06-17", daySegment: "evening" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task });
    expect(updateTaskSchedule).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      taskId,
      status: "done",
      blocked: undefined,
      date: "2026-06-17",
      daySegment: "evening",
      source: "manual",
    });
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });
});
