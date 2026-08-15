import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

function createFakeDb() {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  return {
    inserts,
    select() {
      return {
        from(table: unknown) {
          const name = tableName(table);
          return {
            where() {
              const rows = name === "plans" ? [{ id: "plan-1" }] : [];
              return {
                limit(count: number) {
                  return Promise.resolve(rows.slice(0, count));
                },
                then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
                  return Promise.resolve(rows).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserts.push({ table: tableName(table), values });
          return {
            returning() {
              return Promise.resolve([{ id: `${tableName(table)}-1`, ...values }]);
            },
          };
        },
      };
    },
  };
}

const fakeDb = vi.hoisted(() => createFakeDb());

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(() => fakeDb),
}));

describe("PawPlan MCP server builder", () => {
  beforeEach(() => {
    fakeDb.inserts.length = 0;
  });

  it("publishes a concrete propose_patch patch schema through tools/list", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPawPlanMcpServer({ workspaceId: "workspace-1", permission: "read_write" });
    const client = new Client({ name: "schema-check", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getServerVersion()).toEqual({ name: "pawplan", version: "0.2.2" });

      const result = await client.listTools();
      const tool = result.tools.find((candidate) => candidate.name === "propose_patch");
      const patchSchema = tool?.inputSchema.properties?.patch as any;

      expect(patchSchema).toMatchObject({
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                task_id: { type: "string" },
              },
              required: ["type"],
              additionalProperties: true,
            },
          },
        },
        required: ["operations"],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("publishes startup instructions pointing agents to daily guidance", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPawPlanMcpServer({ workspaceId: "workspace-1", permission: "read_only" });
    const client = new Client({ name: "schema-check", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getInstructions()).toContain("get_agent_guidance");
      expect(client.getInstructions()).toContain("Review draft");

      const result = await client.listTools();
      const tool = result.tools.find((candidate) => candidate.name === "get_agent_guidance");

      expect(tool?.description).toContain("daily");
      expect(tool?.description).toContain("PawPlan");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("publishes propose_daily_rebalance schema for read-write MCP clients", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPawPlanMcpServer({ workspaceId: "workspace-1", permission: "read_write" });
    const client = new Client({ name: "schema-check", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.listTools();
      const tool = result.tools.find((candidate) => candidate.name === "propose_daily_rebalance");
      const toolNames = result.tools.map((candidate) => candidate.name);
      const moveSchema = (tool?.inputSchema.properties?.moves as any)?.items;

      expect(tool).toBeDefined();
      expect(toolNames).toContain("propose_week_rebalance");
      expect(toolNames).toContain("propose_overdue_replan");
      expect(moveSchema).toMatchObject({
        type: "object",
        properties: {
          task_id: { type: "string" },
          to_date: { type: "string" },
          to_day_segment: { type: "string", enum: ["morning", "afternoon", "evening"] },
          reason: { type: "string" },
        },
        required: ["task_id", "to_date", "to_day_segment", "reason"],
        additionalProperties: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("excludes rebalance write tools for read-only MCP clients", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPawPlanMcpServer({ workspaceId: "workspace-1", permission: "read_only" });
    const client = new Client({ name: "schema-check", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).not.toContain("propose_daily_rebalance");
      expect(result.tools.map((tool) => tool.name)).not.toContain("propose_week_rebalance");
      expect(result.tools.map((tool) => tool.name)).not.toContain("propose_overdue_replan");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("accepts stringified propose_patch payloads from clients that serialize object fields", async () => {
    const { createPawPlanMcpServer } = await import("@/lib/mcp/server-builder");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPawPlanMcpServer({ workspaceId: "workspace-1", permission: "read_write" });
    const client = new Client({ name: "schema-check", version: "0.0.0" });
    const patch = {
      operations: [
        {
          type: "move_task",
          task_id: "task-1",
          from_date: "2026-06-14",
          from_day_segment: "afternoon",
          to_date: "2026-06-15",
          to_day_segment: "afternoon",
          reason: "Move after overload.",
        },
      ],
    };

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "propose_patch",
        arguments: {
          mode: "week",
          reason: "Client serialized the patch object as JSON.",
          patch: JSON.stringify(patch),
          created_by: "claude",
        },
      });

      const text = result.content[0]?.type === "text" ? result.content[0].text : null;
      expect(JSON.parse(text ?? "{}")).toEqual(
        expect.objectContaining({
          patchId: "agent_patches-1",
          previewOnly: true,
          status: "draft",
        }),
      );
      expect(fakeDb.inserts).toEqual([
        expect.objectContaining({
          table: "agent_patches",
          values: expect.objectContaining({
            patchJson: patch,
            createdBy: "claude",
          }),
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
