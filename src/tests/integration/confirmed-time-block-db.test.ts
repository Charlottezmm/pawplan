import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { runPawPlanTool } from "@/lib/mcp/tools";
import { applyTimeBlockSeriesMutation, previewTimeBlockSeriesMutation, previewConfirmedTimeBlock, updateConfirmedTimeBlock } from "@/lib/constraints/time-block-series";
import { decideOperationApproval } from "@/lib/approvals/service";

const databaseUrl = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_DATABASE_INTEGRATION === "1" && /(?:localhost|127\.0\.0\.1)/.test(databaseUrl);

describe.runIf(enabled)("confirmed fixed-time edits in isolated PostgreSQL", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const ids: string[] = [];
  const previousFlag = process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED;
  const previousSecret = process.env.APP_SECRET;
  beforeAll(() => {
    process.env.APP_SECRET = "confirmed-time-test-secret";
    process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED = "true";
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
  });
  afterEach(async () => {
    if (ids.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, ids.splice(0)));
    process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED = "true";
  });
  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED;
    else process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED = previousFlag;
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
    await pool.end();
  });
  async function fixture(scope: "occurrence" | "following" | "series" = "occurrence") {
    const [workspace] = await db.insert(schema.workspaces).values({ name: `__fixed_${randomUUID()}`, passwordHash: "test" }).returning();
    ids.push(workspace.id);
    await db.insert(schema.plans).values({ workspaceId: workspace.id, title: "Test", status: "active", baselineSnapshot: {}, startDate: new Date("2026-08-01"), endDate: new Date("2026-08-31") });
    const [series] = await db.insert(schema.timeBlocks).values({ workspaceId: workspace.id, title: "Course", kind: "course", startsAt: new Date("2026-08-03T09:00:00+08:00"), endsAt: new Date("2026-08-31T10:00:00+08:00"), recurrenceRule: "weekly", recurrenceWeekdayMask: 2, protected: true }).returning();
    const args = { series_id: series.id, scope, occurrence_date: "2026-08-10", changes: { start_time: "10:00", end_time: "11:00" } };
    const call = (name: string, values: unknown, permission: "read_only" | "review_only" | "read_write" = "read_write") => runPawPlanTool(db, workspace.id, name, values, permission);
    const preview = await call("preview_confirmed_time_block", args, "read_only");
    const applyArgs = { ...args, preview_token: preview.previewToken, confirmation: "USER_CONFIRMED", user_instruction: "把这次课改到10点至11点", idempotency_key: randomUUID() };
    return { workspace, series, args, preview, applyArgs, call };
  }
  it("previews without writes, changes only one occurrence and records verified audit once", async () => {
    const f = await fixture();
    expect(await db.select().from(schema.operationApprovals)).toHaveLength(0);
    expect(await db.select().from(schema.timeBlockExceptions)).toHaveLength(0);
    const [before] = await db.select().from(schema.timeBlocks).where(eq(schema.timeBlocks.id, f.series.id));
    expect(before).toEqual(f.series);
    const result = await f.call("update_confirmed_time_block", f.applyArgs);
    expect(result.status).toBe("succeeded");
    const [exception] = await db.select().from(schema.timeBlockExceptions).where(eq(schema.timeBlockExceptions.seriesId, f.series.id));
    expect(exception.occurrenceDate).toBe("2026-08-10");
    expect(exception.overrideStartsAt?.toISOString()).toBe("2026-08-10T02:00:00.000Z");
    expect(exception.overrideProtected).toBe(true);
    const [after] = await db.select().from(schema.timeBlocks).where(eq(schema.timeBlocks.id, f.series.id));
    expect(after.startsAt).toEqual(before.startsAt);
    expect(result.readback.verification).toBe("succeeded");
    const retry = await f.call("update_confirmed_time_block", f.applyArgs);
    expect(retry.status).toBe("duplicate");
    expect(retry.priorStatus).toBe("succeeded");
    expect(await db.select().from(schema.timeBlockExceptions)).toHaveLength(1);
    const logs = await db.select().from(schema.changeLogs).where(eq(schema.changeLogs.workspaceId, f.workspace.id));
    expect(logs).toHaveLength(1);
    expect(logs[0].detailsJson).toMatchObject({ authorization: "chat_confirmation", userInstruction: f.applyArgs.user_instruction, before: expect.any(Object) });
    expect(await db.select().from(schema.operationApprovals)).toHaveLength(0);
  });
  it.each(["following", "series"] as const)("persists the explicit %s scope", async (scope) => {
    const f = await fixture(scope);
    await f.call("update_confirmed_time_block", f.applyArgs);
    const rows = await db.select().from(schema.timeBlocks).where(eq(schema.timeBlocks.workspaceId, f.workspace.id));
    expect(rows).toHaveLength(scope === "following" ? 2 : 1);
    expect(rows.every((row) => row.protected)).toBe(true);
    if (scope === "following") {
      expect(rows.find((row) => row.id === f.series.id)?.startsAt.toISOString()).toBe("2026-08-03T01:00:00.000Z");
      expect(rows.find((row) => row.id !== f.series.id)?.startsAt.toISOString()).toBe("2026-08-10T02:00:00.000Z");
    } else expect(rows[0].startsAt.toISOString()).toBe("2026-08-03T02:00:00.000Z");
  });
  it("rejects unauthorized connections, missing confirmation, protected edits and disabled feature", async () => {
    const f = await fixture();
    for (const permission of ["read_only", "review_only"] as const) await expect(f.call("update_confirmed_time_block", f.applyArgs, permission)).rejects.toMatchObject({ code: "mcp_permission_denied" });
    await expect(f.call("update_confirmed_time_block", { ...f.applyArgs, confirmation: undefined })).rejects.toThrow();
    await expect(f.call("update_confirmed_time_block", { ...f.applyArgs, changes: { protected: false } })).rejects.toThrow();
    process.env.PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED = "0";
    await expect(f.call("update_confirmed_time_block", f.applyArgs)).rejects.toThrow("disabled");
    expect(await db.select().from(schema.timeBlockExceptions)).toHaveLength(0);
  });
  it("rejects cross-workspace, changed content and stale snapshots without overwriting", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(other.call("update_confirmed_time_block", f.applyArgs)).rejects.toMatchObject({ code: "preview_required" });
    await expect(f.call("update_confirmed_time_block", { ...f.applyArgs, changes: { title: "Other" } })).rejects.toMatchObject({ code: "preview_required" });
    await db.update(schema.timeBlocks).set({ title: "Manually changed" }).where(eq(schema.timeBlocks.id, f.series.id));
    await expect(f.call("update_confirmed_time_block", f.applyArgs)).rejects.toMatchObject({ code: "preview_stale" });
    expect(await db.select().from(schema.timeBlockExceptions)).toHaveLength(0);
  });
  it("rejects expired snapshots and reused keys with different content", async () => {
    const f = await fixture();
    const request = { seriesId: f.series.id, scope: "occurrence" as const, occurrenceDate: "2026-08-10", changes: { startTime: "10:00", endTime: "11:00" } };
    const old = await previewConfirmedTimeBlock(db, { workspaceId: f.workspace.id, request, now: new Date("2026-01-01") });
    await expect(updateConfirmedTimeBlock(db, { workspaceId: f.workspace.id, request, previewToken: old.previewToken, confirmation: "USER_CONFIRMED", userInstruction: "move", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "preview_required" });
    await f.call("update_confirmed_time_block", f.applyArgs);
    const changed = { ...f.args, changes: { title: "New title" } };
    const preview = await f.call("preview_confirmed_time_block", changed);
    await expect(f.call("update_confirmed_time_block", { ...f.applyArgs, ...changed, preview_token: preview.previewToken })).rejects.toMatchObject({ code: "idempotency_payload_mismatch" });
  });
  it("handles concurrent retries once and reports an unchanged series without mutation", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.call("update_confirmed_time_block", f.applyArgs),
      f.call("update_confirmed_time_block", f.applyArgs),
    ]);
    expect(results.some((result) => result.status === "fulfilled" && result.value.status === "succeeded")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason.code).toBe("operation_in_progress");
      else expect(["succeeded", "duplicate"]).toContain(result.value.status);
    }
    expect(await db.select().from(schema.timeBlockExceptions)).toHaveLength(1);
    expect(await db.select().from(schema.changeLogs)).toHaveLength(1);
    const unchanged = { ...f.args, scope: "series", changes: { title: "Course" } };
    const preview = await f.call("preview_confirmed_time_block", unchanged);
    const result = await f.call("update_confirmed_time_block", { ...f.applyArgs, ...unchanged, preview_token: preview.previewToken, idempotency_key: randomUUID() });
    expect(result.status).toBe("no_change");
    expect(result.readback.verification).toBe("succeeded");
  });
  it("keeps the existing Review approval and consumption path intact", async () => {
    const f = await fixture();
    const request = { seriesId: f.series.id, scope: "occurrence" as const, occurrenceDate: "2026-08-10", changes: { title: "Reviewed title" } };
    const preview = await previewTimeBlockSeriesMutation(db, { workspaceId: f.workspace.id, action: "update", request });
    const input = { workspaceId: f.workspace.id, action: "update" as const, request, previewToken: preview.previewToken, approvalId: preview.approvalId, idempotencyKey: randomUUID() };
    await expect(applyTimeBlockSeriesMutation(db, input)).rejects.toMatchObject({ code: "approval_not_approved" });
    expect(await db.select().from(schema.timeBlockExceptions)).toHaveLength(0);
    await decideOperationApproval(db, { workspaceId: f.workspace.id, approvalId: preview.approvalId, decision: "approved" });
    expect((await applyTimeBlockSeriesMutation(db, input)).status).toBe("succeeded");
    const [approval] = await db.select().from(schema.operationApprovals).where(eq(schema.operationApprovals.id, preview.approvalId));
    expect(approval.status).toBe("consumed");
  });
});
