import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "@/lib/db/client";
import {
  allowedPawPlanToolNames,
  pawPlanServerInstructions,
  pawPlanToolDescriptions,
  pawPlanToolSchemas,
  runPawPlanTool,
  type McpPermission,
  type PawPlanToolName,
} from "@/lib/mcp/tools";

function jsonToolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createPawPlanMcpServer(input: { workspaceId: string; permission: McpPermission }) {
  const db = getDb();
  const server = new McpServer({
    name: "pawplan",
    version: "0.2.2",
  }, {
    instructions: pawPlanServerInstructions,
  });

  for (const name of allowedPawPlanToolNames(input.permission)) {
    const toolName: PawPlanToolName = name;
    server.registerTool(
      toolName,
      {
        description: pawPlanToolDescriptions[toolName],
        inputSchema: pawPlanToolSchemas[toolName].shape,
      },
      async (args: unknown) =>
        jsonToolResult(await runPawPlanTool(db, input.workspaceId, toolName, args, input.permission)),
    );
  }

  return server;
}
