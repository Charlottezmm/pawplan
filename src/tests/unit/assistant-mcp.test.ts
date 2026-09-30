import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
import { createPawPlanMcpServer } from "@/lib/mcp/server-builder";
import { isHostedMcpQuotaWriteTool } from "@/lib/mcp/tool-metadata";
describe("assistant MCP discovery contract", () => {
  it("publishes concrete preview/confirm schemas and conservative annotations", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPawPlanMcpServer({ workspaceId: "owned", permission: "read_write" });
    const client = new Client({ name: "assistant-acceptance", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const preview = tools.find((t) => t.name === "preview_assistant_change");
      const confirm = tools.find((t) => t.name === "confirm_assistant_change");
      expect(preview?.inputSchema.required).toEqual(["change", "idempotency_key"]);
      expect((preview?.inputSchema.properties?.change as any).anyOf).toHaveLength(5);
      expect(confirm?.inputSchema.required).toEqual(["draft_id", "confirmation", "user_instruction"]);
      expect(confirm?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      expect(tools.find((t) => t.name === "recommend_next_tasks")?.annotations?.readOnlyHint).toBe(true);
      expect(client.getInstructions()).toContain("wait for explicit user confirmation");
      expect(isHostedMcpQuotaWriteTool("preview_assistant_change")).toBe(false);
      expect(isHostedMcpQuotaWriteTool("confirm_assistant_change")).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
  it("read-only and review-only clients cannot discover confirmation", async () => {
    for (const permission of ["read_only", "review_only"] as const) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createPawPlanMcpServer({ workspaceId: "owned", permission });
      const client = new Client({ name: "permission-acceptance", version: "1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("get_continuation"); expect(names).not.toContain("confirm_assistant_change");
        expect(names.includes("preview_assistant_change")).toBe(permission === "review_only");
      } finally { await client.close(); await server.close(); }
    }
  });
});
