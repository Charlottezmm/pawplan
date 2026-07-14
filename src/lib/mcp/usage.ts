import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { mcpUsageEvents } from "@/lib/db/schema";
import { isPawPlanWriteTool, pawPlanWriteToolNames, type McpPermission } from "@/lib/mcp/tool-metadata";

export const HOSTED_MCP_DAILY_WRITE_LIMIT = 50;

type UsageDb = {
  transaction?: <T>(callback: (tx: any) => Promise<T>) => Promise<T>;
  execute?: (...args: any[]) => any;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update?: (...args: any[]) => any;
};

export type HostedMcpUsageSnapshot = {
  limit: number;
  used: number;
  remaining: number;
  resetAt: Date;
};

export class McpUsageLimitError extends Error {
  status = 429;
  code = "hosted_mcp_daily_write_limit_reached";

  constructor(public quota: HostedMcpUsageSnapshot, message = "Hosted MCP daily write limit reached") {
    super(message);
  }
}

function truncateToolName(value: string) {
  return value.slice(0, 80);
}

function shanghaiDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function startOfShanghaiDay(date: Date) {
  const { year, month, day } = shanghaiDateParts(date);
  return new Date(Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function retryAfterSeconds(snapshot: HostedMcpUsageSnapshot, now = new Date()) {
  return Math.max(0, Math.ceil((snapshot.resetAt.getTime() - now.getTime()) / 1000));
}

async function countHostedMcpWrites(db: UsageDb, workspaceId: string, now: Date) {
  const start = startOfShanghaiDay(now);
  const end = addDays(start, 1);
  const rows = await db
    .select({ value: count() })
    .from(mcpUsageEvents)
    .where(
      and(
        eq(mcpUsageEvents.workspaceId, workspaceId),
        eq(mcpUsageEvents.success, true),
        inArray(mcpUsageEvents.toolName, [...pawPlanWriteToolNames]),
        gte(mcpUsageEvents.createdAt, start),
        lt(mcpUsageEvents.createdAt, end),
      ),
    );
  return { used: Number(rows[0]?.value ?? 0), resetAt: end };
}

export async function getHostedMcpUsageSnapshot(
  db: UsageDb,
  input: { workspaceId: string; now?: Date },
): Promise<HostedMcpUsageSnapshot> {
  const { used, resetAt } = await countHostedMcpWrites(db, input.workspaceId, input.now ?? new Date());
  return {
    limit: HOSTED_MCP_DAILY_WRITE_LIMIT,
    used,
    remaining: Math.max(0, HOSTED_MCP_DAILY_WRITE_LIMIT - used),
    resetAt,
  };
}

export function extractMcpUsageToolName(payload: unknown) {
  if (!payload || typeof payload !== "object") return "unknown";
  if (Array.isArray(payload)) return "batch";

  const record = payload as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : "unknown";
  if (method !== "tools/call") return truncateToolName(method);

  const params = record.params;
  if (!params || typeof params !== "object") return "tools/call";
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" && name ? truncateToolName(name) : "tools/call";
}

export async function recordHostedMcpUsage(
  db: UsageDb,
  input: {
    workspaceId: string;
    tokenId: string | null;
    toolName: string;
    permission: McpPermission;
    success: boolean;
    createdAt?: Date;
  },
) {
  await db.insert(mcpUsageEvents).values({
    workspaceId: input.workspaceId,
    tokenId: input.tokenId,
    toolName: truncateToolName(input.toolName),
    permission: input.permission,
    success: input.success,
    createdAt: input.createdAt ?? new Date(),
  });
}

export async function assertHostedMcpWriteAllowed(
  db: UsageDb,
  input: {
    workspaceId: string;
    toolName: string;
    now?: Date;
  },
) {
  if (!isPawPlanWriteTool(input.toolName)) return;

  const quota = await getHostedMcpUsageSnapshot(db, { workspaceId: input.workspaceId, now: input.now });
  if (quota.remaining === 0) {
    throw new McpUsageLimitError(quota);
  }
}

export async function reserveHostedMcpWrite(
  db: UsageDb,
  input: {
    workspaceId: string;
    tokenId: string | null;
    toolName: string;
    permission: McpPermission;
    now?: Date;
  },
) {
  if (!isPawPlanWriteTool(input.toolName)) return null;
  if (!db.transaction) throw new Error("Hosted MCP usage reservations require transactions");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    if (!tx.execute) throw new Error("Hosted MCP usage reservations require PostgreSQL advisory locks");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.workspaceId}))`);
    const quota = await getHostedMcpUsageSnapshot(tx, { workspaceId: input.workspaceId, now });
    if (quota.remaining === 0) throw new McpUsageLimitError(quota);

    const [reservation] = await tx
      .insert(mcpUsageEvents)
      .values({
        workspaceId: input.workspaceId,
        tokenId: input.tokenId,
        toolName: truncateToolName(input.toolName),
        permission: input.permission,
        success: true,
        createdAt: now,
      })
      .returning({ id: mcpUsageEvents.id });
    if (!reservation?.id) throw new Error("Failed to reserve Hosted MCP write quota");
    return { reservationId: reservation.id, quota: { ...quota, used: quota.used + 1, remaining: quota.remaining - 1 } };
  });
}

export async function releaseHostedMcpWriteReservation(db: UsageDb, reservationId: string) {
  if (!db.update) throw new Error("Hosted MCP usage reservation release requires updates");
  await db.update(mcpUsageEvents).set({ success: false }).where(eq(mcpUsageEvents.id, reservationId));
}
