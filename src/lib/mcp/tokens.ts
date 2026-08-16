import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { mcpTokens } from "@/lib/db/schema";
import type { McpPermission } from "@/lib/mcp/tool-metadata";

type DbLike = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

type TokenRow = {
  id: string;
  workspaceId: string;
  tokenHash: string;
  name: string;
  permission: McpPermission;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
  createdAt: Date | string;
};

export class McpTokenError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function hashMcpToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function toIsoDate(value: Date | string | null) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeToken(row: TokenRow) {
  return {
    id: row.id,
    name: row.name,
    permission: row.permission,
    expiresAt: toIsoDate(row.expiresAt),
    revokedAt: toIsoDate(row.revokedAt),
    createdAt: toIsoDate(row.createdAt),
  };
}

function validatePermission(permission: McpPermission) {
  if (permission !== "read_only" && permission !== "review_only" && permission !== "read_write") {
    throw new McpTokenError("Invalid MCP token permission", 400);
  }
}

export async function createMcpToken(
  db: DbLike,
  workspaceId: string,
  input: { name: string; permission: McpPermission; expiresInDays: number | null },
) {
  const name = input.name.trim();
  if (!name) throw new McpTokenError("Token name is required", 400);
  validatePermission(input.permission);

  const rawToken = `pwp_live_${randomBytes(32).toString("base64url")}`;
  const expiresAt =
    input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
  const [token] = await db
    .insert(mcpTokens)
    .values({
      workspaceId,
      name,
      permission: input.permission,
      tokenHash: hashMcpToken(rawToken),
      expiresAt,
    })
    .returning();

  return {
    token: serializeToken(token),
    rawToken,
  };
}

export async function listMcpTokens(db: DbLike, workspaceId: string) {
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(eq(mcpTokens.workspaceId, workspaceId))
    .orderBy(mcpTokens.createdAt);

  return (rows as TokenRow[]).map(serializeToken);
}

export async function revokeMcpToken(db: DbLike, workspaceId: string, tokenId: string) {
  const [token] = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.workspaceId, workspaceId), isNull(mcpTokens.revokedAt)))
    .returning();

  return token ? serializeToken(token) : null;
}

export async function verifyMcpBearerToken(db: DbLike, rawToken: string) {
  if (!rawToken.startsWith("pwp_live_")) return null;

  const candidateHash = hashMcpToken(rawToken);
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.tokenHash, candidateHash),
        isNull(mcpTokens.revokedAt),
        or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, new Date())),
      ),
    )
    .limit(1);
  const row = (rows as TokenRow[])[0];
  if (!row || !safeEqual(row.tokenHash, candidateHash)) return null;

  return {
    workspaceId: row.workspaceId,
    permission: row.permission,
    tokenId: row.id,
  };
}
