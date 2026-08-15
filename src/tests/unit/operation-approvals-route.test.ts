import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  getWorkspaceIdFromSession: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/approvals/service", () => {
  class OperationApprovalError extends Error {
    constructor(
      public code: string,
      message: string,
      public status = 409,
    ) {
      super(message);
    }
  }
  return { OperationApprovalError, decideOperationApproval: vi.fn() };
});

const approvalId = "11111111-1111-4111-8111-111111111111";

function postRequest(body: unknown) {
  return new Request("http://localhost/api/operation-approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("operation approval route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("requires an authenticated workspace", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue(null);
    const { POST } = await import("@/app/api/operation-approvals/route");

    const response = await POST(postRequest({ approvalId, decision: "approved" }));

    expect(response.status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("rejects malformed or expanded input before opening the database", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST } = await import("@/app/api/operation-approvals/route");

    const malformed = await POST(postRequest({ approvalId: "bad", decision: "approved" }));
    const expanded = await POST(postRequest({ approvalId, decision: "approved", workspaceId: "other" }));

    expect(malformed.status).toBe(400);
    expect(expanded.status).toBe(400);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("binds the decision to the session workspace", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { decideOperationApproval } = await import("@/lib/approvals/service");
    const db = {};
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(decideOperationApproval).mockResolvedValue({
      id: approvalId,
      status: "approved",
      approvedAt: new Date("2026-08-16T01:00:00.000Z"),
      rejectedAt: null,
    } as never);
    const { POST } = await import("@/app/api/operation-approvals/route");

    const response = await POST(postRequest({ approvalId, decision: "approved" }));

    expect(response.status).toBe(200);
    expect(decideOperationApproval).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      approvalId,
      decision: "approved",
    });
  });

  it("preserves known one-time approval errors", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { decideOperationApproval, OperationApprovalError } = await import("@/lib/approvals/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(decideOperationApproval).mockRejectedValue(
      new OperationApprovalError("approval_already_decided", "Approval was already decided", 409),
    );
    const { POST } = await import("@/app/api/operation-approvals/route");

    const response = await POST(postRequest({ approvalId, decision: "rejected" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Approval was already decided",
      code: "approval_already_decided",
    });
  });
});
