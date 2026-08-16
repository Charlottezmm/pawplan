import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPawPlanMcpServer } from "@/lib/mcp/server-builder";

function requiredWorkspaceId() {
  const workspaceId = process.env.PAWPLAN_WORKSPACE_ID;
  if (!workspaceId) throw new Error("PAWPLAN_WORKSPACE_ID is required");
  return workspaceId;
}

async function main() {
  const workspaceId = requiredWorkspaceId();
  const configuredPermission = process.env.PAWPLAN_MCP_PERMISSION;
  const permission = configuredPermission === "read_only" || configuredPermission === "review_only"
    ? configuredPermission
    : "read_write";
  const server = createPawPlanMcpServer({ workspaceId, permission });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
