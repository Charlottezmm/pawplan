import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDb } from "@/lib/db/client";
import { createPawPlanMcpServer } from "@/lib/mcp/server-builder";
import { McpTokenError, verifyMcpBearerToken } from "@/lib/mcp/tokens";
import {
  McpUsageLimitError,
  extractMcpUsageToolName,
  recordHostedMcpUsage,
  releaseHostedMcpWriteReservation,
  reserveHostedMcpWrite,
  retryAfterSeconds,
} from "@/lib/mcp/usage";
import { verifyConnectorAccessToken } from "@/lib/oauth/connector-auth";
import { canUsePawPlanTool, isPawPlanWriteTool } from "@/lib/mcp/tool-metadata";

export const dynamic = "force-dynamic";

class McpRequestError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function bearerToken(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new McpTokenError("Missing MCP bearer token", 401);

  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new McpTokenError("Missing MCP bearer token", 401);
  return token;
}

function resourceMetadataUrl(request: Request) {
  return new URL("/.well-known/oauth-protected-resource/api/mcp", request.url).toString();
}

function wwwAuthenticate(request: Request, error?: string) {
  const params = [`resource_metadata="${resourceMetadataUrl(request)}"`];
  if (error) params.push(`error="${error}"`);
  return `Bearer ${params.join(", ")}`;
}

function errorResponse(request: Request, error: unknown) {
  if (error instanceof McpTokenError) {
    return Response.json(
      { error: error.message },
      {
        status: error.status,
        headers: { "WWW-Authenticate": wwwAuthenticate(request, error.status === 401 ? "invalid_token" : undefined) },
      },
    );
  }
  if (error instanceof McpUsageLimitError) {
    const retryAfter = retryAfterSeconds(error.quota);
    return Response.json(
      {
        error: error.code,
        message: error.message,
        retry_after: retryAfter,
        reset_at: error.quota.resetAt.toISOString(),
        limit: error.quota.limit,
        remaining: error.quota.remaining,
      },
      { status: error.status, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  if (error instanceof McpRequestError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  return Response.json({ error: "MCP request failed" }, { status: 500 });
}

async function resolveMcpAuth(db: ReturnType<typeof getDb>, token: string) {
  const mcpAuth = await verifyMcpBearerToken(db, token);
  if (mcpAuth) return { ...mcpAuth, kind: "mcp_token" as const };

  return verifyConnectorAccessToken(db, token);
}

async function requestToolName(request: Request) {
  if (request.method === "GET") return "GET";
  try {
    const payload = await request.clone().json();
    if (Array.isArray(payload)) throw new McpRequestError("JSON-RPC batch requests are not supported", 400);
    return extractMcpUsageToolName(payload);
  } catch (error) {
    if (error instanceof McpRequestError) throw error;
    throw new McpRequestError("Invalid MCP JSON request", 400);
  }
}

function hasJsonRpcError(payload: unknown): boolean {
  if (Array.isArray(payload)) {
    return payload.some((item) => hasJsonRpcError(item));
  }
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  if (record.isError === true) return true;
  if (record.error) return true;
  return "result" in record && hasJsonRpcError(record.result);
}

function hasStructuredStatus(payload: unknown, status: string): boolean {
  if (Array.isArray(payload)) return payload.some((item) => hasStructuredStatus(item, status));
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  if (record.status === status) return true;
  return Object.values(record).some((value) => hasStructuredStatus(value, status));
}

async function responseOutcome(response: Response) {
  if (response.status >= 400) return { succeeded: false, duplicate: false };
  try {
    const payload = await response.clone().json();
    return {
      succeeded: !hasJsonRpcError(payload),
      duplicate: hasStructuredStatus(payload, "duplicate"),
    };
  } catch {
    return { succeeded: true, duplicate: false };
  }
}

async function handle(request: Request) {
  const db = getDb();
  try {
    const auth = await resolveMcpAuth(db, bearerToken(request));
    if (!auth) throw new McpTokenError("Invalid MCP bearer token", 401);
    const toolName = await requestToolName(request);
    const usageInput = {
      workspaceId: auth.workspaceId,
      tokenId: auth.kind === "mcp_token" ? auth.tokenId : null,
      toolName,
      permission: auth.permission,
    };

    let reservationId: string | null = null;
    try {
      if (canUsePawPlanTool(auth.permission, toolName) && isPawPlanWriteTool(toolName)) {
        const reservation = await reserveHostedMcpWrite(db, usageInput);
        reservationId = reservation?.reservationId ?? null;
      }

      const server = createPawPlanMcpServer({ workspaceId: auth.workspaceId, permission: auth.permission });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        authInfo: {
          token: "redacted",
          scopes: [auth.permission],
          clientId: auth.tokenId,
        },
      });
      const outcome = await responseOutcome(response);
      if (reservationId && (!outcome.succeeded || outcome.duplicate)) {
        await releaseHostedMcpWriteReservation(db, reservationId);
      } else if (!reservationId) {
        await recordHostedMcpUsage(db, { ...usageInput, success: outcome.succeeded });
      }
      return response;
    } catch (error) {
      if (reservationId) {
        await releaseHostedMcpWriteReservation(db, reservationId);
      } else if (!(error instanceof McpUsageLimitError)) {
        await recordHostedMcpUsage(db, { ...usageInput, success: false });
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
