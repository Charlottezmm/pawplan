import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createMcpToken, McpTokenError, listMcpTokens, revokeMcpToken } from "@/lib/mcp/tokens";
import { readJsonBody } from "@/lib/validation/common";

const createTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    permission: z.enum(["read_only", "review_only", "read_write"]).default("read_only"),
    expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
  })
  .strict();

const patchTokenSchema = z
  .object({
    action: z.literal("revoke"),
    id: z.string().min(1),
  })
  .strict();

function mcpUrl(request: Request) {
  return new URL("/api/mcp", request.url).toString();
}

function codexConfig(url: string) {
  return [
    "[mcp_servers.pawplan]",
    `url = "${url}"`,
    'bearer_token_env_var = "PAWPLAN_MCP_TOKEN"',
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 60",
    'default_tools_approval_mode = "prompt"',
  ].join("\n");
}

function mcpConnection(request: Request) {
  const url = mcpUrl(request);
  return {
    url,
    codexConfig: codexConfig(url),
  };
}

function serviceError(error: unknown) {
  if (error instanceof McpTokenError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json({ error: "Failed to update MCP tokens" }, { status: 500 });
}

export async function GET(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const tokens = await listMcpTokens(db, workspaceId);
  return NextResponse.json({
    workspaceId,
    tokens,
    mcp: mcpConnection(request),
  });
}

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody(request);
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid MCP token request" }, { status: 400 });

  try {
    const result = await createMcpToken(getDb(), workspaceId, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return serviceError(error);
  }
}

export async function PATCH(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody(request);
  const parsed = patchTokenSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid MCP token action" }, { status: 400 });

  try {
    await revokeMcpToken(getDb(), workspaceId, parsed.data.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return serviceError(error);
  }
}
