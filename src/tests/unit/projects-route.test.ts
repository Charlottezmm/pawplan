import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getWorkspaceIdFromSession: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

const projectId = "11111111-1111-4111-8111-111111111111";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/projects", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validProject(overrides: Record<string, unknown> = {}) {
  return {
    id: projectId,
    name: "Physics-Grounded Manipulation",
    category: "科研",
    objective: "建立 manipulation world model",
    successCriteria: "完成一组基线实验",
    status: "active",
    priority: "high",
    startDate: "2026-08-01",
    targetDate: "2026-12-31",
    weeklyTargetMinutes: 480,
    ...overrides,
  };
}

describe("projects route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("does not let an active Project lose its category or goal definition", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { PATCH } = await import("@/app/api/projects/route");

    const response = await PATCH(request(validProject({ category: null })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Active projects require category, objective, and success criteria" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("rejects a target date before the start date", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { PATCH } = await import("@/app/api/projects/route");

    const response = await PATCH(request(validProject({ targetDate: "2026-07-31" })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Target date cannot be before start date" });
  });

  it("updates only the Project in the current workspace and clears needsDefinition", async () => {
    const where = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: projectId, needsDefinition: false }]) }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({ update } as never);
    const { PATCH } = await import("@/app/api/projects/route");

    const response = await PATCH(request(validProject()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: { id: projectId, needsDefinition: false } });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      name: "Physics-Grounded Manipulation",
      category: "科研",
      status: "active",
      priority: "high",
      weeklyTargetMinutes: 480,
      needsDefinition: false,
    }));
    expect(where).toHaveBeenCalledOnce();
  });

  it("creates another fully defined active Project in the same workspace", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "project-new", color: "#71717a" }]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({ insert } as never);
    const { POST } = await import("@/app/api/projects/route");
    const { id: _id, ...payload } = validProject();

    const response = await POST(request(payload));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project: { id: "project-new", color: "#71717a" } });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      name: "Physics-Grounded Manipulation",
      category: "科研",
      needsDefinition: false,
    }));
  });
});
