import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { persistTodayTaskUpdate } from "@/components/today-view";

const taskId = "88a66f98-3e15-48f3-9259-cc606bda9074";

describe("Today task status persistence", () => {
  it("accepts only a successful response that confirms the requested state", async () => {
    const request = vi.fn(async () => Response.json({
      task: { id: taskId, status: "done", blocked: false },
    }));

    await expect(persistTodayTaskUpdate(taskId, { status: "done", blocked: false }, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ id: taskId, status: "done", blocked: false }),
    }));
  });

  it("accepts a persisted UTC timestamp that represents the requested Shanghai date", async () => {
    const request = vi.fn(async () => Response.json({
      task: { id: taskId, status: "todo", blocked: false, date: "2026-09-03T16:00:00.000Z" },
    }));

    await expect(persistTodayTaskUpdate(taskId, { status: "todo", date: "2026-09-04" }, request)).resolves.toBeUndefined();
  });

  it("rejects network errors and non-2xx responses", async () => {
    const networkFailure = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const serverFailure = vi.fn(async () => Response.json({ error: "Database unavailable" }, { status: 503 }));

    await expect(persistTodayTaskUpdate(taskId, { status: "done" }, networkFailure)).rejects.toThrow("Failed to fetch");
    await expect(persistTodayTaskUpdate(taskId, { status: "done" }, serverFailure)).rejects.toThrow("Task update request failed");
  });

  it("rejects malformed or contradictory success responses", async () => {
    const malformed = vi.fn(async () => new Response("not-json", { status: 200 }));
    const wrongState = vi.fn(async () => Response.json({
      task: { id: taskId, status: "todo", blocked: false },
    }));

    await expect(persistTodayTaskUpdate(taskId, { status: "done" }, malformed)).rejects.toThrow("response was invalid");
    await expect(persistTodayTaskUpdate(taskId, { status: "done" }, wrongState)).rejects.toThrow("did not confirm");
  });

  it("keeps rollback and duplicate-request guards without moving completed tasks", () => {
    const source = readFileSync("src/components/today-view.tsx", "utf8");

    expect(source).toContain("statusRequests.current.has(id)");
    expect(source).toContain("task.id === id ? currentTask : task");
    expect(source).toContain("已恢复原状态，请重试");
    expect(source).not.toContain('typeof el.animate === "function"');
    expect(source).not.toContain("setTasks((current) => [...current].sort");
    expect(source).toContain("task.id === id ? optimisticTask : task");
  });
});
