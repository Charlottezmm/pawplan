import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { runPawPlanTool, pawPlanToolSchemas } from "@/lib/mcp/tools";
import { cancelConfirmedTimeBlockOccurrences, previewConfirmedTimeBlockOccurrences } from "@/lib/constraints/time-block-series";
import { loadEffectiveTimeBlocks } from "@/lib/planning/effective-time-blocks";
import { getHostedMcpUsageSnapshot, recordHostedMcpUsage, reserveHostedMcpWrite } from "@/lib/mcp/usage";
import { hostedMcpUsageToolName } from "@/lib/mcp/tool-metadata";

const databaseUrl = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_DATABASE_INTEGRATION === "1" && /(?:localhost|127\.0\.0\.1)/.test(databaseUrl);

describe.runIf(enabled)("confirmed occurrence cancellation in isolated PostgreSQL", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const ids: string[] = [];
  const originalFlag = process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED;
  const originalSecret = process.env.APP_SECRET;
  beforeAll(() => {
    process.env.APP_SECRET = "isolated-cancellation-test-secret";
    process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED = "true";
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
  });
  afterEach(async () => {
    if (ids.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, ids.splice(0)));
    process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED = "true";
  });
  afterAll(async () => {
    if (originalFlag === undefined) delete process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED;
    else process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED = originalFlag;
    if (originalSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = originalSecret;
    await pool.end();
  });
  async function fixture() {
    const [workspace] = await db.insert(schema.workspaces).values({ name: `__cancel_${randomUUID()}`, passwordHash: "test" }).returning();
    ids.push(workspace.id);
    await db.insert(schema.plans).values({ workspaceId: workspace.id, title: "Test", status: "active", baselineSnapshot: {}, startDate: new Date("2026-08-01"), endDate: new Date("2026-08-31") });
    const series = await db.insert(schema.timeBlocks).values([1, 2].map((day) => ({
      workspaceId: workspace.id, title: `Course ${day}`, kind: "course" as const,
      startsAt: new Date(`2026-08-0${day + 2}T09:00:00+08:00`), endsAt: new Date("2026-08-31T10:00:00+08:00"),
      recurrenceRule: "weekly", recurrenceWeekdayMask: 1 << day, protected: true,
    }))).returning();
    const args = { occurrences: [
      { series_id: series[0].id, occurrence_date: "2026-08-10" },
      { series_id: series[0].id, occurrence_date: "2026-08-17" },
      { series_id: series[1].id, occurrence_date: "2026-08-11" },
    ] };
    const call = (name: string, input: unknown, permission: "read_only" | "review_only" | "read_write" = "read_write") => runPawPlanTool(db, workspace.id, name, input, permission);
    const preview = await call("preview_confirmed_time_block_occurrences", args, "read_only");
    const applyArgs = { ...args, preview_token: preview.previewToken, confirmation: "USER_CONFIRMED", user_instruction: "取消这三次课程，保留后续课表", idempotency_key: randomUUID() };
    const request = args.occurrences.map((item) => ({ seriesId: item.series_id, occurrenceDate: item.occurrence_date }));
    return { workspace, series, args, preview, applyArgs, request, call };
  }
  const workspaceRows = (table: any, workspaceId: string) => db.select().from(table).where(eq(table.workspaceId, workspaceId));

  it("previews without writes, atomically cancels multiple series, reads exact IDs and retries once", async () => {
    const f = await fixture();
    for (const table of [schema.operationApprovals, schema.planOperations, schema.changeLogs, schema.timeBlockExceptions]) {
      expect(await workspaceRows(table, f.workspace.id)).toHaveLength(0);
    }
    expect(await workspaceRows(schema.timeBlocks, f.workspace.id)).toEqual(f.series);
    expect(f.preview.count).toBe(3);
    expect(f.preview.affectedDates).toEqual(["2026-08-10", "2026-08-11", "2026-08-17"]);
    const result = await f.call("cancel_confirmed_time_block_occurrences", f.applyArgs);
    expect(result.status).toBe("succeeded");
    expect(result.readback.verification).toBe("succeeded");
    const exceptions = await db.select().from(schema.timeBlockExceptions).where(and(
      eq(schema.timeBlockExceptions.workspaceId, f.workspace.id), inArray(schema.timeBlockExceptions.id, result.exceptionIds),
    ));
    expect(exceptions).toHaveLength(3);
    expect(exceptions.every((row) => row.action === "cancel")).toBe(true);
    expect(result.readback.occurrences.map((row: { exceptionId: string }) => row.exceptionId).sort()).toEqual(exceptions.map((row) => row.id).sort());
    expect(await workspaceRows(schema.timeBlocks, f.workspace.id)).toEqual(f.series);
    const effective = await loadEffectiveTimeBlocks(db, { workspaceId: f.workspace.id, rangeStart: new Date("2026-08-10T00:00:00+08:00"), rangeEnd: new Date("2026-08-25T00:00:00+08:00") });
    expect(effective.occurrences.filter((row) => f.args.occurrences.some((item) => item.series_id === row.recurrenceSourceId && item.occurrence_date === row.occurrenceDate))).toHaveLength(0);
    expect(effective.occurrences.some((row) => row.recurrenceSourceId === f.series[0].id && row.occurrenceDate === "2026-08-24")).toBe(true);
    const retry = await f.call("cancel_confirmed_time_block_occurrences", { ...f.applyArgs, occurrences: [...f.args.occurrences].reverse() });
    expect(retry).toMatchObject({ status: "duplicate", priorStatus: "succeeded", result: { exceptionIds: result.exceptionIds } });
    const logs = await workspaceRows(schema.changeLogs, f.workspace.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].detailsJson).toMatchObject({ authorization: "chat_confirmation", userInstruction: f.applyArgs.user_instruction, requestedScope: "occurrence", before: expect.any(Array) });
    expect(await workspaceRows(schema.operationApprovals, f.workspace.id)).toHaveLength(0);
    expect(await workspaceRows(schema.planOperations, f.workspace.id)).toHaveLength(1);
    const preview = await f.call("preview_confirmed_time_block_occurrences", f.args);
    expect(preview.noChange).toBe(true);
    const unchanged = await f.call("cancel_confirmed_time_block_occurrences", { ...f.applyArgs, preview_token: preview.previewToken, idempotency_key: randomUUID() });
    expect(unchanged).toMatchObject({ status: "no_change", readback: { verification: "succeeded" } });
    expect(unchanged.exceptionIds).toEqual(result.exceptionIds);
  });

  it("enforces count, inclusive range, dates, unique targets and occurrence-only schema", async () => {
    const f = await fixture();
    const previewSchema = pawPlanToolSchemas.preview_confirmed_time_block_occurrences;
    for (const input of [
      { occurrences: [] }, { occurrences: Array(21).fill(f.args.occurrences[0]) },
      { occurrences: [f.args.occurrences[0], f.args.occurrences[0]] },
      { occurrences: [{ ...f.args.occurrences[0], occurrence_date: "2026-02-30" }] },
      { occurrences: [f.args.occurrences[0], { ...f.args.occurrences[1], occurrence_date: "2026-08-24" }] },
      { ...f.args, scope: "series" }, { occurrences: [{ ...f.args.occurrences[0], scope: "series" }] },
    ]) expect(previewSchema.safeParse(input).success).toBe(false);
    expect(previewSchema.safeParse({ occurrences: [f.args.occurrences[0], { ...f.args.occurrences[1], occurrence_date: "2026-08-23" }] }).success).toBe(true);
    const applySchema = pawPlanToolSchemas.cancel_confirmed_time_block_occurrences;
    for (const field of ["confirmation", "user_instruction", "idempotency_key", "preview_token"]) expect(applySchema.safeParse({ ...f.applyArgs, [field]: undefined }).success).toBe(false);
    expect(await workspaceRows(schema.timeBlockExceptions, f.workspace.id)).toHaveLength(0);
  });

  it("rejects unauthorized connections and disabled features without mutations", async () => {
    const f = await fixture();
    for (const permission of ["read_only", "review_only"] as const) {
      await expect(f.call("cancel_confirmed_time_block_occurrences", f.applyArgs, permission)).rejects.toMatchObject({ code: "mcp_permission_denied" });
    }
    process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED = "false";
    await expect(f.call("cancel_confirmed_time_block_occurrences", f.applyArgs)).rejects.toThrow("disabled");
    expect(await workspaceRows(schema.timeBlockExceptions, f.workspace.id)).toHaveLength(0);
  });

  it("rejects changed targets, cross-workspace and expired tokens", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(other.call("cancel_confirmed_time_block_occurrences", f.applyArgs)).rejects.toMatchObject({ code: "preview_required" });
    await expect(f.call("cancel_confirmed_time_block_occurrences", { ...f.applyArgs, occurrences: f.args.occurrences.slice(1) })).rejects.toMatchObject({ code: "preview_required" });
    const preview = await previewConfirmedTimeBlockOccurrences(db, { workspaceId: f.workspace.id, occurrences: f.request, now: new Date("2026-01-01") });
    await expect(cancelConfirmedTimeBlockOccurrences(db, {
      workspaceId: f.workspace.id, occurrences: f.request, previewToken: preview.previewToken,
      confirmation: "USER_CONFIRMED", userInstruction: "cancel", idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "preview_required" });
    expect(await workspaceRows(schema.timeBlockExceptions, f.workspace.id)).toHaveLength(0);
  });

  it("rejects any stale series before cancelling the batch", async () => {
    const f = await fixture();
    await db.update(schema.timeBlocks).set({ title: "Manual update" }).where(eq(schema.timeBlocks.id, f.series[1].id));
    await expect(f.call("cancel_confirmed_time_block_occurrences", f.applyArgs)).rejects.toMatchObject({ code: "preview_stale" });
    expect(await workspaceRows(schema.timeBlockExceptions, f.workspace.id)).toHaveLength(0);
    expect(await workspaceRows(schema.changeLogs, f.workspace.id)).toHaveLength(0);
  });

  it("rolls back earlier cancellations when a later write fails", async () => {
    const f = await fixture();
    let transactions = 0;
    const failingDb = Object.create(db);
    failingDb.transaction = (callback: (tx: any) => Promise<unknown>) => db.transaction(async (tx) => {
      transactions += 1;
      if (transactions !== 2) return callback(tx);
      let writes = 0;
      const proxy = new Proxy(tx, { get(target, property) {
        if (property === "insert") return (table: unknown) => {
          if (table === schema.timeBlockExceptions && ++writes === 2) throw new Error("injected second cancellation failure");
          return target.insert(table as never);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      return callback(proxy);
    });
    await expect(runPawPlanTool(failingDb, f.workspace.id, "cancel_confirmed_time_block_occurrences", f.applyArgs, "read_write")).rejects.toThrow("injected second cancellation failure");
    expect(await workspaceRows(schema.timeBlockExceptions, f.workspace.id)).toHaveLength(0);
    expect(await workspaceRows(schema.changeLogs, f.workspace.id)).toHaveLength(0);
    expect(await workspaceRows(schema.timeBlocks, f.workspace.id)).toEqual(f.series);
  });

  it("serializes concurrent retries and rejects reused keys with changed authorization", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.call("cancel_confirmed_time_block_occurrences", f.applyArgs), f.call("cancel_confirmed_time_block_occurrences", f.applyArgs)]);
    expect(results.some((result) => result.status === "fulfilled" && result.value.status === "succeeded")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason.code).toBe("operation_in_progress");
      else expect(["succeeded", "duplicate"]).toContain(result.value.status);
    }
    expect(await workspaceRows(schema.timeBlockExceptions, f.workspace.id)).toHaveLength(3);
    expect(await workspaceRows(schema.changeLogs, f.workspace.id)).toHaveLength(1);
    await expect(f.call("cancel_confirmed_time_block_occurrences", { ...f.applyArgs, user_instruction: "different instruction" })).rejects.toMatchObject({ code: "idempotency_payload_mismatch" });
  });

  it("keeps committed state and audit recoverable when post-commit readback fails", async () => {
    const f = await fixture();
    const failingDb = Object.create(db);
    let committed = false;
    failingDb.transaction = (callback: (tx: any) => Promise<unknown>) => db.transaction(callback).then((result) => {
      if (result && typeof result === "object" && "plans" in result) committed = true;
      return result;
    });
    failingDb.select = (...args: any[]) => {
      if (committed) throw new Error("injected readback unavailable");
      return (db.select as any)(...args);
    };
    const result = await runPawPlanTool(failingDb, f.workspace.id, "cancel_confirmed_time_block_occurrences", f.applyArgs, "read_write");
    expect(result).toMatchObject({ status: "applied_with_readback_error", persistedStatus: "succeeded", readback: { verification: "failed" } });
    expect(await workspaceRows(schema.timeBlockExceptions, f.workspace.id)).toHaveLength(3);
    const retry = await f.call("cancel_confirmed_time_block_occurrences", f.applyArgs);
    expect(retry).toMatchObject({ status: "duplicate", result: { status: "applied_with_readback_error" } });
    expect(await workspaceRows(schema.changeLogs, f.workspace.id)).toHaveLength(1);
  });

  it("accepts 20 targets and charges one persisted quota event", async () => {
    const f = await fixture();
    const series = await db.insert(schema.timeBlocks).values(Array.from({ length: 20 }, (_, i) => ({
      workspaceId: f.workspace.id, title: `Boundary course ${i}`, kind: "course" as const,
      startsAt: new Date("2026-08-03T09:00:00+08:00"), endsAt: new Date("2026-08-31T10:00:00+08:00"),
      recurrenceRule: "weekly", recurrenceWeekdayMask: 2, protected: true,
    }))).returning();
    const args = { occurrences: series.map((row) => ({ series_id: row.id, occurrence_date: "2026-08-10" })) };
    const preview = await f.call("preview_confirmed_time_block_occurrences", args);
    await reserveHostedMcpWrite(db, { workspaceId: f.workspace.id, tokenId: null, permission: "read_write", toolName: "cancel_confirmed_time_block_occurrences" });
    const result = await f.call("cancel_confirmed_time_block_occurrences", {
      ...f.applyArgs, ...args, preview_token: preview.previewToken, idempotency_key: randomUUID(),
    });
    expect(result).toMatchObject({ status: "succeeded", readback: { verification: "succeeded" } });
    expect(result.exceptionIds).toHaveLength(20);
    expect(await workspaceRows(schema.timeBlockExceptions, f.workspace.id)).toHaveLength(20);
    expect(await getHostedMcpUsageSnapshot(db, { workspaceId: f.workspace.id })).toMatchObject({ used: 1, remaining: 199 });
  });

  it("counts persisted successful previews as zero and batch reservations as one", async () => {
    const f = await fixture();
    for (const name of ["preview_task_batch", "preview_confirmed_time_block", "preview_confirmed_time_block_occurrences", "update_time_block_series", "delete_time_block_series", "replace_plan_window"]) {
      await recordHostedMcpUsage(db, { workspaceId: f.workspace.id, tokenId: null, permission: "read_write", success: true, toolName: hostedMcpUsageToolName(name, { mode: "preview" }) });
    }
    expect(await getHostedMcpUsageSnapshot(db, { workspaceId: f.workspace.id })).toMatchObject({ limit: 200, used: 0, remaining: 200 });
    await reserveHostedMcpWrite(db, { workspaceId: f.workspace.id, tokenId: null, permission: "read_write", toolName: "cancel_confirmed_time_block_occurrences" });
    expect(await getHostedMcpUsageSnapshot(db, { workspaceId: f.workspace.id })).toMatchObject({ used: 1, remaining: 199 });
  });
});
