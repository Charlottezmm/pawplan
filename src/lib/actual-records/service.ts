import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { actualRecords, actualRecordWrites, tasks } from "@/lib/db/schema";
import { actualRecordRangeSchema, deleteActualRecordSchema, saveActualRecordSchema, type ActualRecord, type PlanSnapshot } from "./schema";
import { stableJson } from "@/lib/constraints/time-block-series-token";

type Db = { select: (...args: any[]) => any; insert: (...args: any[]) => any; update: (...args: any[]) => any; transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> };
export class ActualRecordError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
function serialize(row: typeof actualRecords.$inferSelect): ActualRecord {
  return { id: row.id, taskId: row.taskId, title: row.title, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), approximate: row.approximate, revision: row.revision, deletedAt: row.deletedAt?.toISOString() ?? null, planSnapshot: row.planSnapshot as PlanSnapshot, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export async function getActualRecords(db: Db, workspaceId: string, args: unknown) {
  const range = actualRecordRangeSchema.parse(args);
  const start = new Date(`${range.date_from}T00:00:00+08:00`);
  const end = new Date(Date.parse(`${range.date_to}T00:00:00+08:00`) + 86400000);
  const rows = await db.select({ record: actualRecords, task: tasks }).from(actualRecords)
    .leftJoin(tasks, and(eq(tasks.id, actualRecords.taskId), eq(tasks.workspaceId, workspaceId)))
    .where(and(eq(actualRecords.workspaceId, workspaceId), isNull(actualRecords.deletedAt), lt(actualRecords.startsAt, end), gt(actualRecords.endsAt, start), range.task_id ? eq(actualRecords.taskId, range.task_id) : undefined))
    .orderBy(asc(actualRecords.startsAt), asc(actualRecords.id)).limit(1001);
  return { records: rows.slice(0, 1000).map(({ record, task }: { record: typeof actualRecords.$inferSelect; task: typeof tasks.$inferSelect | null }) => ({ ...serialize(record), task: task ? { title: task.title, status: task.status, scheduledStart: task.scheduledStart?.toISOString() ?? null, scheduledEnd: task.scheduledEnd?.toISOString() ?? null, estimatedMinutes: task.estimatedMinutes } : null })), truncated: rows.length > 1000 };
}

export async function mutateActualRecord(db: Db, workspaceId: string, action: "save" | "delete", args: unknown, source: "manual" | "mcp" = "manual", now = new Date()) {
  const parsed = action === "save" ? saveActualRecordSchema.parse(args) : deleteActualRecordSchema.parse(args);
  const fields = "record" in parsed ? parsed.record : null;
  if (fields && Date.parse(fields.ends_at) > now.getTime()) throw new ActualRecordError("future_record", "实际记录不能填入尚未发生的时间", 400);
  const hash = createHash("sha256").update(stableJson({ action, parsed })).digest("hex");
  const receipt = await db.transaction(async (tx) => {
    // The unique insert serializes concurrent retries; failed transactions leave no receipt.
    const [claimed] = await tx.insert(actualRecordWrites).values({ workspaceId, idempotencyKey: parsed.idempotency_key, requestHash: hash, source, result: {} }).onConflictDoNothing().returning();
    if (!claimed) {
      const [previous] = await tx.select().from(actualRecordWrites).where(and(eq(actualRecordWrites.workspaceId, workspaceId), eq(actualRecordWrites.idempotencyKey, parsed.idempotency_key))).limit(1);
      if (!previous || previous.requestHash !== hash) throw new ActualRecordError("idempotency_mismatch", "此重试标识已用于其他内容，请刷新后重试");
      return { duplicate: true, ...(previous.result as { record: ActualRecord }) };
    }
    let before: typeof actualRecords.$inferSelect | undefined;
    if (parsed.id) {
      [before] = await tx.select().from(actualRecords).where(and(eq(actualRecords.id, parsed.id), eq(actualRecords.workspaceId, workspaceId))).for("update");
      if (!before || before.deletedAt) throw new ActualRecordError("record_not_found", "记录不存在或已移除", 404);
      if (before.revision !== parsed.expected_revision) throw new ActualRecordError("record_changed", "这条记录已被修改，请关闭并重新打开后再保存");
    }
    let snapshot = before?.planSnapshot ?? {};
    if (fields?.task_id && (!before || before.taskId !== fields.task_id)) {
      const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, fields.task_id), eq(tasks.workspaceId, workspaceId), isNull(tasks.archivedAt))).for("share");
      if (!task) throw new ActualRecordError("task_not_found", "关联任务不存在或不属于当前计划空间", 404);
      snapshot = { taskId: task.id, title: task.title, date: task.date.toISOString(), scheduledStart: task.scheduledStart?.toISOString() ?? null, scheduledEnd: task.scheduledEnd?.toISOString() ?? null, estimatedMinutes: task.estimatedMinutes, capturedAt: now.toISOString() };
    } else if (fields && !fields.task_id && before?.taskId) snapshot = {};
    const values = fields ? { title: fields.title, taskId: fields.task_id, startsAt: new Date(fields.starts_at), endsAt: new Date(fields.ends_at), approximate: fields.approximate, planSnapshot: snapshot } : {};
    const [saved] = before
      ? await tx.update(actualRecords).set({ ...values, revision: before.revision + 1, updatedAt: now, ...(action === "delete" ? { deletedAt: now } : {}) }).where(and(eq(actualRecords.id, before.id), eq(actualRecords.workspaceId, workspaceId))).returning()
      : await tx.insert(actualRecords).values({ ...values, workspaceId }).returning();
    const result = { record: serialize(saved), before: before ? serialize(before) : null };
    await tx.update(actualRecordWrites).set({ result }).where(eq(actualRecordWrites.id, claimed.id));
    return { duplicate: false, ...result };
  });
  // Keep a committed receipt even if this independent post-commit read fails.
  try {
    const [persisted] = await db.select().from(actualRecords).where(and(eq(actualRecords.id, receipt.record.id), eq(actualRecords.workspaceId, workspaceId))).limit(1);
    if (!persisted) throw new Error("record missing after commit");
    const record = serialize(persisted);
    return { status: receipt.duplicate ? "duplicate" : "succeeded", mutationApplied: true, record, readback: { verification: "succeeded", matchesMutation: record.revision === receipt.record.revision }, mutationRevision: receipt.record.revision };
  } catch {
    return { status: "applied_with_readback_error", mutationApplied: true, record: receipt.record, readback: { verification: "failed", matchesMutation: false }, mutationRevision: receipt.record.revision };
  }
}
