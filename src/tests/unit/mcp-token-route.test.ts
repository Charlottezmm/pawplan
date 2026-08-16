import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  getWorkspaceIdFromSession: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/mcp/tokens", () => ({
  createMcpToken: vi.fn(),
  listMcpTokens: vi.fn(),
  revokeMcpToken: vi.fn(),
}));

describe("MCP token route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("requires a workspace session", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue(null);
    const { GET } = await import("@/app/api/mcp-tokens/route");

    const response = await GET(new Request("https://pawplan.example/api/mcp-tokens"));

    expect(response.status).toBe(401);
  });

  it("lists token metadata and hosted MCP connection config", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { listMcpTokens } = await import("@/lib/mcp/tokens");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(listMcpTokens).mockResolvedValue([
      {
        id: "token-1",
        name: "Codex local",
        permission: "read_write",
        expiresAt: null,
        revokedAt: null,
        createdAt: "2026-06-12T00:00:00.000Z",
      },
    ]);
    const { GET } = await import("@/app/api/mcp-tokens/route");

    const response = await GET(new Request("https://pawplan.example/api/mcp-tokens"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.workspaceId).toBe("workspace-1");
    expect(body.tokens).toEqual([
      expect.objectContaining({ id: "token-1", name: "Codex local", permission: "read_write" }),
    ]);
    expect(body.mcp.url).toBe("https://pawplan.example/api/mcp");
    expect(body.mcp.codexConfig).toContain("[mcp_servers.pawplan]");
    expect(body.mcp.codexConfig).toContain('bearer_token_env_var = "PAWPLAN_MCP_TOKEN"');
    expect(JSON.stringify(body)).not.toContain("tokenHash");
  });

  it("creates a token and returns the raw token once", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { createMcpToken } = await import("@/lib/mcp/tokens");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(createMcpToken).mockResolvedValue({
      token: {
        id: "token-1",
        name: "Daily Review",
        permission: "review_only",
        expiresAt: null,
        revokedAt: null,
        createdAt: "2026-06-12T00:00:00.000Z",
      },
      rawToken: "pwp_live_secret",
    });
    const { POST } = await import("@/app/api/mcp-tokens/route");

    const response = await POST(
      new Request("https://pawplan.example/api/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Daily Review", permission: "review_only", expiresInDays: null }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createMcpToken).toHaveBeenCalledWith(expect.anything(), "workspace-1", {
      name: "Daily Review",
      permission: "review_only",
      expiresInDays: null,
    });
    expect(body.rawToken).toBe("pwp_live_secret");
    expect(body.token).toEqual(expect.objectContaining({ id: "token-1" }));
  });

  it("revokes a token", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { revokeMcpToken } = await import("@/lib/mcp/tokens");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(revokeMcpToken).mockResolvedValue({ id: "token-1" } as never);
    const { PATCH } = await import("@/app/api/mcp-tokens/route");

    const response = await PATCH(
      new Request("https://pawplan.example/api/mcp-tokens", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", id: "token-1" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(revokeMcpToken).toHaveBeenCalledWith(expect.anything(), "workspace-1", "token-1");
    expect(body).toEqual({ ok: true });
  });
});
