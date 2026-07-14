import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { mcpUsageEvents } from "@/lib/db/schema";
import {
  HOSTED_MCP_DAILY_WRITE_LIMIT,
  McpUsageLimitError,
  assertHostedMcpWriteAllowed,
  extractMcpUsageToolName,
  getHostedMcpUsageSnapshot,
  recordHostedMcpUsage,
  releaseHostedMcpWriteReservation,
  reserveHostedMcpWrite,
  retryAfterSeconds,
} from "@/lib/mcp/usage";

function createUsageDb(options: { writeCount?: number } = {}) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];

  return {
    inserts,
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([{ value: options.writeCount ?? 0 }]);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserts.push({ table: getTableName(table as Parameters<typeof getTableName>[0]), values });
          return Promise.resolve();
        },
      };
    },
  };
}

describe("hosted MCP usage audit", () => {
  beforeEach(() => {
    expect(getTableName(mcpUsageEvents)).toBe("mcp_usage_events");
  });

  it("extracts tool names from JSON-RPC tool calls and falls back to method names", () => {
    expect(
      extractMcpUsageToolName({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_checkin", arguments: {} },
      }),
    ).toBe("create_checkin");
    expect(extractMcpUsageToolName({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe("tools/list");
    expect(extractMcpUsageToolName(null)).toBe("unknown");
  });

  it("records workspace, token, tool, permission, success, and timestamp", async () => {
    const db = createUsageDb();
    const createdAt = new Date("2026-06-12T03:04:05.000Z");

    await recordHostedMcpUsage(db, {
      workspaceId: "workspace-1",
      tokenId: "token-1",
      toolName: "get_today",
      permission: "read_only",
      success: true,
      createdAt,
    });

    expect(db.inserts).toEqual([
      {
        table: "mcp_usage_events",
        values: {
          workspaceId: "workspace-1",
          tokenId: "token-1",
          toolName: "get_today",
          permission: "read_only",
          success: true,
          createdAt,
        },
      },
    ]);
  });

  it("allows read tools even when write usage is at the daily cap", async () => {
    const db = createUsageDb({ writeCount: HOSTED_MCP_DAILY_WRITE_LIMIT });

    await expect(
      assertHostedMcpWriteAllowed(db, {
        workspaceId: "workspace-1",
        toolName: "get_today",
        now: new Date("2026-06-12T12:00:00.000+08:00"),
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks write tools when the workspace reaches the daily write cap", async () => {
    const db = createUsageDb({ writeCount: HOSTED_MCP_DAILY_WRITE_LIMIT });

    await expect(
      assertHostedMcpWriteAllowed(db, {
        workspaceId: "workspace-1",
        toolName: "create_checkin",
        now: new Date("2026-06-12T12:00:00.000+08:00"),
      }),
    ).rejects.toBeInstanceOf(McpUsageLimitError);
  });

  it("reports remaining quota and the next Shanghai midnight", async () => {
    const db = createUsageDb({ writeCount: 49 });
    const now = new Date("2026-06-12T12:00:00.000+08:00");

    const quota = await getHostedMcpUsageSnapshot(db, { workspaceId: "workspace-1", now });

    expect(quota).toEqual({
      limit: 50,
      used: 49,
      remaining: 1,
      resetAt: new Date("2026-06-12T16:00:00.000Z"),
    });
    expect(retryAfterSeconds(quota, now)).toBe(43_200);
  });

  it("serializes concurrent final-slot reservations and releases failed calls", async () => {
    let writeCount = 49;
    let sequence = Promise.resolve();
    const updates: Array<Record<string, unknown>> = [];
    const reservationDb: any = {
      transaction<T>(callback: (tx: any) => Promise<T>) {
        const run = sequence.then(() => callback(reservationDb));
        sequence = run.then(() => undefined, () => undefined);
        return run;
      },
      execute: vi.fn(),
      select() {
        return { from: () => ({ where: () => Promise.resolve([{ value: writeCount }]) }) };
      },
      insert() {
        return {
          values() {
            return {
              returning() {
                writeCount += 1;
                return Promise.resolve([{ id: `usage-${writeCount}` }]);
              },
            };
          },
        };
      },
      update() {
        return {
          set(values: Record<string, unknown>) {
            updates.push(values);
            return { where: () => Promise.resolve() };
          },
        };
      },
    };

    const attempts = await Promise.allSettled([
      reserveHostedMcpWrite(reservationDb, {
        workspaceId: "workspace-1",
        tokenId: "token-1",
        toolName: "create_checkin",
        permission: "read_write",
        now: new Date("2026-06-12T12:00:00.000+08:00"),
      }),
      reserveHostedMcpWrite(reservationDb, {
        workspaceId: "workspace-1",
        tokenId: "token-2",
        toolName: "update_task_status",
        permission: "read_write",
        now: new Date("2026-06-12T12:00:00.000+08:00"),
      }),
    ]);

    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(reservationDb.execute).toHaveBeenCalledTimes(2);
    const success = attempts.find((attempt): attempt is PromiseFulfilledResult<any> => attempt.status === "fulfilled")!;
    expect(success.value.quota.remaining).toBe(0);
    await releaseHostedMcpWriteReservation(reservationDb, success.value.reservationId);
    expect(updates).toContainEqual({ success: false });
  });
});
