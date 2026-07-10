import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  getWorkspaceIdFromSession: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/planning/service", () => {
  class PatchApplyError extends Error {
    constructor(message: string, public status = 400) {
      super(message);
    }
  }

  return {
    PatchApplyError,
    rejectReviewPatches: vi.fn(),
  };
});

const patchId = "11111111-1111-4111-8111-111111111111";

function postRequest(body: unknown) {
  return new Request("http://localhost/api/patches/reject-all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("reject all Review drafts route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("requires a workspace session", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue(null);
    const { POST } = await import("@/app/api/patches/reject-all/route");

    const response = await POST(postRequest({ patchIds: [patchId] }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("rejects malformed patch ids before opening the database", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST } = await import("@/app/api/patches/reject-all/route");

    const response = await POST(postRequest({ patchIds: ["not-a-uuid"] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Select between 1 and 1000 Review drafts to reject" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("rejects duplicate ids and unexpected request fields", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST } = await import("@/app/api/patches/reject-all/route");

    const duplicateResponse = await POST(postRequest({ patchIds: [patchId, patchId] }));
    const extraFieldResponse = await POST(postRequest({ patchIds: [patchId], workspaceId: "other-workspace" }));

    expect(duplicateResponse.status).toBe(400);
    expect(extraFieldResponse.status).toBe(400);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("returns structured rejection and readback counts", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { rejectReviewPatches } = await import("@/lib/planning/service");
    const db = { transaction: vi.fn() };
    const result = {
      status: "succeeded" as const,
      planId: "plan-1",
      requestedPatchCount: 1,
      rejectedPatchCount: 1,
      rejectedOperationCount: 3,
      rejectedPatchIds: [patchId],
      remainingDraftCount: 0,
    };
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(rejectReviewPatches).mockResolvedValue(result);
    const { POST } = await import("@/app/api/patches/reject-all/route");

    const response = await POST(postRequest({ patchIds: [patchId] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(rejectReviewPatches).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      patchIds: [patchId],
    });
  });

  it("returns a safe error for unexpected failures", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { rejectReviewPatches } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({ transaction: vi.fn() } as never);
    vi.mocked(rejectReviewPatches).mockRejectedValue(new Error("database unavailable"));
    const { POST } = await import("@/app/api/patches/reject-all/route");

    const response = await POST(postRequest({ patchIds: [patchId] }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to reject Review drafts" });
  });

  it("preserves known service error status and message", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { PatchApplyError, rejectReviewPatches } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({ transaction: vi.fn() } as never);
    vi.mocked(rejectReviewPatches).mockRejectedValue(new PatchApplyError("No active plan", 400));
    const { POST } = await import("@/app/api/patches/reject-all/route");

    const response = await POST(postRequest({ patchIds: [patchId] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No active plan" });
  });
});
