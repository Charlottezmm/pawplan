import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ propose: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/mcp/project-portfolio-update", () => {
  class ProjectPortfolioUpdateError extends Error {
    constructor(
      public code: string,
      message: string,
      public status = 409,
      public details: Record<string, unknown> = {},
    ) { super(message); }
  }
  return {
    ProjectPortfolioUpdateError,
    proposeProjectPortfolioUpdate: mocks.propose,
    applyProjectPortfolioUpdate: vi.fn(),
  };
});

describe("Project Portfolio MCP server error mapping", () => {
  it("returns a structured tool error for a stale Project proposal", async () => {
    const { ProjectPortfolioUpdateError } = await import("@/lib/mcp/project-portfolio-update");
    mocks.propose.mockRejectedValue(new ProjectPortfolioUpdateError(
      "stale_project",
      "Project changed after it was read",
      409,
      { projectId: "11111111-1111-4111-8111-111111111111" },
    ));
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPawPlanMcpServer({ workspaceId: "workspace-1", permission: "read_write" });
    const client = new Client({ name: "project-error-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "propose_project_portfolio_update",
        arguments: {
          update: {
            projects: [{
              action: "update",
              project_id: "11111111-1111-4111-8111-111111111111",
              expected_updated_at: "2026-08-16T01:00:00.000Z",
              changes: { objective: "New objective" },
            }],
            milestones: [],
          },
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "failed",
        error: { code: "stale_project", message: "Project changed after it was read" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
