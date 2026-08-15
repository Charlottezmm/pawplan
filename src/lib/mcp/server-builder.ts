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
import { McpTaskBatchError } from "@/lib/mcp/task-batch";
import { McpTaskArchiveError } from "@/lib/mcp/task-archive";
import { ReplacePlanWindowError } from "@/lib/mcp/replace-plan-window";
import { TimeBlockSeriesError } from "@/lib/constraints/time-block-series";
import { ActivePlanError } from "@/lib/planning/active-plan";
import { OperationApprovalError } from "@/lib/approvals/service";

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

function jsonToolError(error: McpTaskBatchError, args: unknown) {
  const pendingTaskIds =
    args && typeof args === "object" && Array.isArray((args as { operations?: unknown }).operations)
      ? (args as { operations: Array<{ task_id?: unknown }> }).operations
          .map((operation) => operation.task_id)
          .filter((taskId): taskId is string => typeof taskId === "string")
      : [];
  const value = {
    status: "failed" as const,
    completedTaskIds: [],
    pendingTaskIds,
    error: { code: error.code, message: error.message, details: error.details },
  };
  return { ...jsonToolResult(value), isError: true as const };
}

function jsonOperationError(error: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}) {
  const value = {
    status: "failed" as const,
    error: { code: error.code, message: error.message, details: error.details },
  };
  return { ...jsonToolResult(value), isError: true as const };
}

export function createPawPlanMcpServer(input: { workspaceId: string; permission: McpPermission }) {
  const db = getDb();
  const server = new McpServer({
    name: "pawplan",
    version: "0.3.0",
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
      async (args: unknown) => {
        try {
          return jsonToolResult(await runPawPlanTool(db, input.workspaceId, toolName, args, input.permission));
        } catch (error) {
          if (error instanceof McpTaskBatchError) return jsonToolError(error, args);
          if (
            error instanceof McpTaskArchiveError ||
            error instanceof ReplacePlanWindowError ||
            error instanceof TimeBlockSeriesError ||
            error instanceof ActivePlanError ||
            error instanceof OperationApprovalError
          ) {
            return jsonOperationError(error);
          }
          throw error;
        }
      },
    );
  }

  return server;
}
