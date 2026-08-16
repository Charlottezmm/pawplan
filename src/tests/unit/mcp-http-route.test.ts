import { beforeEach, describe, expect, it, vi } from "vitest";

const handleRequestMock = vi.hoisted(() => vi.fn(() => Response.json({ ok: true })));
const reserveHostedMcpWriteMock = vi.hoisted(() => vi.fn());
const releaseHostedMcpWriteReservationMock = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: vi.fn(() => ({
    handleRequest: handleRequestMock,
  })),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock("@/lib/mcp/tokens", () => ({
  verifyMcpBearerToken: vi.fn(),
  McpTokenError: class McpTokenError extends Error {
    constructor(message: string, public status = 400) {
      super(message);
    }
  },
}));

vi.mock("@/lib/oauth/connector-auth", () => ({
  verifyConnectorAccessToken: vi.fn(),
}));

vi.mock("@/lib/mcp/server-builder", () => ({
  createPawPlanMcpServer: vi.fn(() => ({
    connect: vi.fn(),
  })),
}));

vi.mock("@/lib/mcp/usage", () => ({
  McpUsageLimitError: class McpUsageLimitError extends Error {
    status = 429;
    code = "hosted_mcp_daily_write_limit_reached";
    constructor(public quota: { limit: number; used: number; remaining: number; resetAt: Date }) {
      super("Hosted MCP daily write limit reached");
    }
  },
  extractMcpUsageToolName: vi.fn((payload) =>
    payload?.method === "tools/call" ? payload.params?.name ?? "tools/call" : payload?.method ?? "unknown",
  ),
  recordHostedMcpUsage: vi.fn(),
  reserveHostedMcpWrite: reserveHostedMcpWriteMock,
  releaseHostedMcpWriteReservation: releaseHostedMcpWriteReservationMock,
  retryAfterSeconds: vi.fn(() => 3600),
}));

describe("hosted MCP route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    handleRequestMock.mockResolvedValue(Response.json({ ok: true }));
    reserveHostedMcpWriteMock.mockReset().mockResolvedValue(null);
    releaseHostedMcpWriteReservationMock.mockReset().mockResolvedValue(undefined);
  });

  it("requires bearer token", async () => {
    const { POST } = await import("@/app/api/mcp/route");

    const response = await POST(new Request("https://pawplan.test/api/mcp", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "Missing MCP bearer token" });
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://pawplan.test/.well-known/oauth-protected-resource/api/mcp"',
    );
  });

  it("rejects invalid bearer tokens", async () => {
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    const { verifyConnectorAccessToken } = await import("@/lib/oauth/connector-auth");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue(null);
    vi.mocked(verifyConnectorAccessToken).mockResolvedValue(null);
    const { POST } = await import("@/app/api/mcp/route");

    const response = await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_bad" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("resolves bearer token before building MCP server", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_write",
      tokenId: "token-1",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(createPawPlanMcpServer).toHaveBeenCalledWith({ workspaceId: "workspace-1", permission: "read_write" });
  });

  it("passes read-only bearer permissions to the shared MCP server builder", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_only",
      tokenId: "token-1",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(createPawPlanMcpServer).toHaveBeenCalledWith({ workspaceId: "workspace-1", permission: "read_only" });
  });

  it("passes review-only bearer permissions to the shared MCP server builder", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "review_only",
      tokenId: "token-review",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_review" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(createPawPlanMcpServer).toHaveBeenCalledWith({ workspaceId: "workspace-1", permission: "review_only" });
  });

  it("reserves write quota for review-only proposal calls", async () => {
    const { reserveHostedMcpWrite } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "review_only",
      tokenId: "token-review",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_review" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "propose_daily_rebalance", arguments: {} },
        }),
      }),
    );

    expect(reserveHostedMcpWrite).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace-1",
        tokenId: "token-review",
        toolName: "propose_daily_rebalance",
        permission: "review_only",
      }),
    );
  });

  it("does not reserve quota before a disallowed review-only direct write", async () => {
    const { reserveHostedMcpWrite } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "review_only",
      tokenId: "token-review",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_review" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "update_task_schedule", arguments: {} },
        }),
      }),
    );

    expect(reserveHostedMcpWrite).not.toHaveBeenCalled();
  });

  it("reserves hosted daily write quota before write tool calls", async () => {
    const { reserveHostedMcpWrite } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_write",
      tokenId: "token-1",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_checkin", arguments: { completed_text: "Shipped audit." } },
        }),
      }),
    );

    expect(reserveHostedMcpWrite).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: "workspace-1", tokenId: "token-1", toolName: "create_checkin" }),
    );
  });

  it("records hosted MCP usage after authenticated requests", async () => {
    const { recordHostedMcpUsage } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_only",
      tokenId: "token-1",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(recordHostedMcpUsage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace-1",
        tokenId: "token-1",
        toolName: "tools/list",
        permission: "read_only",
        success: true,
      }),
    );
  });

  it("releases reserved quota for JSON-RPC error responses even when HTTP status is 200", async () => {
    const { releaseHostedMcpWriteReservation, reserveHostedMcpWrite } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_write",
      tokenId: "token-1",
    });
    vi.mocked(reserveHostedMcpWrite).mockResolvedValue({
      reservationId: "usage-1",
      quota: { limit: 50, used: 1, remaining: 49, resetAt: new Date("2026-06-13T16:00:00.000Z") },
    });
    handleRequestMock.mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Tool failed" },
      }),
    );
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_checkin", arguments: { completed_text: "Will fail." } },
        }),
      }),
    );

    expect(releaseHostedMcpWriteReservation).toHaveBeenCalledWith({}, "usage-1");
  });

  it("releases reserved quota when an MCP tool returns result.isError", async () => {
    const { releaseHostedMcpWriteReservation, reserveHostedMcpWrite } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_write",
      tokenId: "token-1",
    });
    vi.mocked(reserveHostedMcpWrite).mockResolvedValue({
      reservationId: "usage-2",
      quota: { limit: 50, used: 1, remaining: 49, resetAt: new Date("2026-06-13T16:00:00.000Z") },
    });
    handleRequestMock.mockResolvedValue(
      Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, structuredContent: { status: "failed" } } }),
    );
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_tasks_batch", arguments: {} } }),
      }),
    );

    expect(releaseHostedMcpWriteReservation).toHaveBeenCalledWith({}, "usage-2");
  });

  it("does not charge quota again when an idempotent task batch returns duplicate", async () => {
    const { releaseHostedMcpWriteReservation, reserveHostedMcpWrite } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_write",
      tokenId: "token-1",
    });
    vi.mocked(reserveHostedMcpWrite).mockResolvedValue({
      reservationId: "usage-duplicate",
      quota: { limit: 50, used: 2, remaining: 48, resetAt: new Date("2026-06-13T16:00:00.000Z") },
    });
    handleRequestMock.mockResolvedValue(
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { status: "duplicate", completedTaskIds: ["task-1"], pendingTaskIds: [] } },
      }),
    );
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "update_tasks_batch", arguments: { idempotency_key: "batch-retry", operations: [] } },
        }),
      }),
    );

    expect(releaseHostedMcpWriteReservation).toHaveBeenCalledWith({}, "usage-duplicate");
  });

  it("returns structured quota recovery metadata without invoking the tool", async () => {
    const { McpUsageLimitError, reserveHostedMcpWrite } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_write",
      tokenId: "token-1",
    });
    vi.mocked(reserveHostedMcpWrite).mockRejectedValue(
      new McpUsageLimitError({ limit: 50, used: 50, remaining: 0, resetAt: new Date("2026-06-13T16:00:00.000Z") }),
    );
    const { POST } = await import("@/app/api/mcp/route");
    const response = await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_checkin", arguments: {} } }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    await expect(response.json()).resolves.toEqual({
      error: "hosted_mcp_daily_write_limit_reached",
      message: "Hosted MCP daily write limit reached",
      retry_after: 3600,
      reset_at: "2026-06-13T16:00:00.000Z",
      limit: 50,
      remaining: 0,
    });
    expect(handleRequestMock).not.toHaveBeenCalled();
  });

  it("rejects JSON-RPC array bodies before quota or tool execution", async () => {
    const { reserveHostedMcpWrite } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_write",
      tokenId: "token-1",
    });
    const { POST } = await import("@/app/api/mcp/route");
    const response = await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_live_secret" },
        body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_checkin" } }]),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "JSON-RPC batch requests are not supported" });
    expect(reserveHostedMcpWrite).not.toHaveBeenCalled();
    expect(handleRequestMock).not.toHaveBeenCalled();
  });

  it("accepts OAuth connector access tokens and builds the shared MCP server with workspace permission", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    const { verifyConnectorAccessToken } = await import("@/lib/oauth/connector-auth");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue(null);
    vi.mocked(verifyConnectorAccessToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_write",
      tokenId: "authorization-1",
      kind: "oauth_connector",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_oauth_access_secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(createPawPlanMcpServer).toHaveBeenCalledWith({ workspaceId: "workspace-1", permission: "read_write" });
  });

  it("keeps connector usage audit without writing a connector id into the MCP token foreign key", async () => {
    const { recordHostedMcpUsage } = await import("@/lib/mcp/usage");
    const { verifyMcpBearerToken } = await import("@/lib/mcp/tokens");
    const { verifyConnectorAccessToken } = await import("@/lib/oauth/connector-auth");
    vi.mocked(verifyMcpBearerToken).mockResolvedValue(null);
    vi.mocked(verifyConnectorAccessToken).mockResolvedValue({
      workspaceId: "workspace-1",
      permission: "read_only",
      tokenId: "authorization-1",
      kind: "oauth_connector",
    });
    const { POST } = await import("@/app/api/mcp/route");

    await POST(
      new Request("https://pawplan.test/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer pwp_oauth_access_secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(recordHostedMcpUsage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace-1",
        tokenId: null,
        permission: "read_only",
        success: true,
      }),
    );
  });
});
