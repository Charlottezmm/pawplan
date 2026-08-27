import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  getWorkspaceIdFromSession: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

describe("constraints route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("requires a workspace session for GET", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue(null);
    const { GET } = await import("@/app/api/constraints/route");

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("accepts routine and recovery time block kinds for the data API", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [{ id: "plan-1" }],
              }),
            }),
          }),
          insert: () => ({
            values: (values: Record<string, unknown>) => ({
              returning: async () => [{ id: "block-1", ...values }],
              then: (resolve: (value: unknown) => unknown) => Promise.resolve().then(resolve),
            }),
          }),
        }),
    } as never);
    const { POST } = await import("@/app/api/constraints/route");

    const routineResponse = await POST(
      new Request("http://localhost/api/constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert_time_block",
          timeBlock: {
            title: "Morning routine",
            kind: "routine",
            startsAt: "2026-06-12T01:00:00.000Z",
            endsAt: "2026-06-12T02:00:00.000Z",
            location: "Room 204",
          },
        }),
      }),
    );
    const recoveryResponse = await POST(
      new Request("http://localhost/api/constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert_time_block",
          timeBlock: {
            title: "Recovery",
            kind: "recovery",
            startsAt: "2026-06-12T14:00:00.000Z",
            endsAt: "2026-06-12T15:00:00.000Z",
          },
        }),
      }),
    );

    expect(routineResponse.status).toBe(200);
    expect(await routineResponse.json()).toEqual({
      timeBlock: expect.objectContaining({
        id: "block-1",
        kind: "routine",
        title: "Morning routine",
        location: "Room 204",
      }),
      course: null,
    });
    expect(recoveryResponse.status).toBe(200);
    expect(await recoveryResponse.json()).toEqual({
      timeBlock: expect.objectContaining({ id: "block-1", kind: "recovery", title: "Recovery" }),
      course: null,
    });
  });

  it("rejects blocks longer than 12 hours", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST } = await import("@/app/api/constraints/route");

    const response = await POST(
      new Request("http://localhost/api/constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert_time_block",
          timeBlock: {
            title: "Long block",
            kind: "unavailable",
            startsAt: "2026-06-12T01:00:00.000Z",
            endsAt: "2026-06-12T14:01:00.000Z",
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid constraints action" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("requires a course name for course blocks", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST } = await import("@/app/api/constraints/route");

    const response = await POST(
      new Request("http://localhost/api/constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert_time_block",
          timeBlock: {
            title: "Lecture",
            kind: "course",
            startsAt: "2026-06-12T01:00:00.000Z",
            endsAt: "2026-06-12T02:00:00.000Z",
            courseName: "",
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid constraints action" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("rejects locations longer than 240 characters", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST } = await import("@/app/api/constraints/route");

    const response = await POST(
      new Request("http://localhost/api/constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsert_time_block",
          timeBlock: {
            title: "Lecture",
            kind: "course",
            startsAt: "2026-06-12T01:00:00.000Z",
            endsAt: "2026-06-12T02:00:00.000Z",
            courseName: "Robotics",
            location: "x".repeat(241),
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid constraints action" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });
});
