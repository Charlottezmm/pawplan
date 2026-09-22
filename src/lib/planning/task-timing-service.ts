import { buildCapacityModel } from "./capacity-model";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  tasks,
  workspaces,
  routines,
  dayCapacities,
  operationApprovals,
  planOperations,
  changeLogs,
} from "@/lib/db/schema";
import { getActivePlanId } from "./active-plan";
import { loadEffectiveTimeBlocks } from "./effective-time-blocks";
import { buildExactFixedTimelineItems } from "./view-data";
import { addDaysToDateKey, shanghaiDateKey } from "./task-actions";
import { stableJson } from "@/lib/constraints/time-block-series-token";
import {
  buildTimingChanges,
  localDateSchema,
  localInstant,
  timingLabel,
  timingRange,
  timingRequestSchema,
  timingState,
  TimingError,
  type TimingTask,
  type TimingChange,
  type TimingRequest,
  type TimingBlock,
} from "./task-timing";

type Db = {
  select: (...args: any[]) => any;
  transaction<T>(fn: (tx: any) => Promise<T>, config?: any): Promise<T>;
};
const hash = (data: unknown) =>
  createHash("sha256").update(stableJson(data)).digest("hex");
const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;
export function serializeTimingTask(
  row: typeof tasks.$inferSelect,
): TimingTask {
  return {
    id: row.id,
    title: row.title,
    date: shanghaiDateKey(new Date(row.date)),
    daySegment: row.daySegment,
    status: row.status,
    movable: row.movable,
    estimatedMinutes: row.estimatedMinutes,
    updatedAt: new Date(row.updatedAt).toISOString(),
    scheduledStart: iso(row.scheduledStart),
    scheduledEnd: iso(row.scheduledEnd),
    deadlineAt: iso(row.deadlineAt),
    targetDate: row.targetDate
      ? shanghaiDateKey(new Date(row.targetDate))
      : null,
    checkpoint: row.checkpoint,
  };
}
async function readTasks(db: any, workspaceId: string, lock = false) {
  const planId = await getActivePlanId(db, workspaceId);
  if (!planId) throw new TimingError("当前没有启用的计划", 404);
  const query = db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.planId, planId),
        isNull(tasks.archivedAt),
      ),
    )
    .orderBy(tasks.id);
  const rows = lock ? await query.for("update") : await query;
  return { planId, tasks: rows.map(serializeTimingTask) as TimingTask[] };
}
async function snapshot(
  db: any,
  workspaceId: string,
  range: { from: string; to: string },
  lock = false,
) {
  const state = await readTasks(db, workspaceId, lock);
  const blocks = await loadEffectiveTimeBlocks(db, {
    workspaceId,
    rangeStart: new Date(localInstant(range.from, 0)),
    rangeEnd: new Date(localInstant(addDaysToDateKey(range.to, 1), 0)),
  });
  const capacityRows = await db
    .select()
    .from(dayCapacities)
    .where(eq(dayCapacities.workspaceId, workspaceId))
    .orderBy(dayCapacities.date);
  const routineRows = await db
    .select()
    .from(routines)
    .where(eq(routines.workspaceId, workspaceId))
    .orderBy(routines.id);
  const fixed: TimingBlock[] = [];
  for (
    let date = range.from;
    date <= range.to;
    date = addDaysToDateKey(date, 1)
  ) {
    fixed.push(
      ...buildExactFixedTimelineItems({
        date: new Date(localInstant(date, 0)),
        blockRows: blocks.occurrences.map((b) => ({
          ...b,
          recurrenceWeekdayMask: null,
        })),
        routineRows,
      }).map((b) => ({
        id: b.id,
        title: b.title,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
      })),
    );
  }
  return {
    ...state,
    fixed,
    capacityRows,
    routineRows,
    blocks: blocks.occurrences.map((b) => ({
      ...b,
      recurrenceWeekdayMask: null,
    })),
    hash: hash({ ...state, fixed, routineRows, capacityRows }),
  };
}
function calculateProposal(
  request: TimingRequest,
  data: Awaited<ReturnType<typeof snapshot>>,
) {
  const model = (rows: TimingTask[], dates: string[]) =>
    buildCapacityModel({
      dates: dates.map((d) => new Date(localInstant(d, 0))),
      capacities: data.capacityRows,
      tasks: rows.map((t) => ({
        ...t,
        date: new Date(localInstant(t.date, 0)),
        status: t.status as "todo" | "done" | "backlog",
        scheduledStart: t.scheduledStart ? new Date(t.scheduledStart) : null,
        scheduledEnd: t.scheduledEnd ? new Date(t.scheduledEnd) : null,
      })),
      timeBlocks: data.blocks,
      routines: data.routineRows,
    });
  const result = buildTimingChanges(
    request,
    data.tasks,
    data.fixed,
    new Date(),
    (task, start, minutes, working) => {
      const date = shanghaiDateKey(new Date(start));
      const candidate = {
        ...task,
        date,
        status: "todo",
        scheduledStart: new Date(start).toISOString(),
        scheduledEnd: new Date(start + minutes * 60000).toISOString(),
      };
      const day = model(
        working.map((t) => (t.id === task.id ? candidate : t)),
        [date],
      ).days[0];
      const baseline = model(
        working.filter((t) => t.id !== task.id),
        [date],
      ).days[0];
      return (["morning", "afternoon", "evening"] as const).every((segment) => {
        const after = day.segments[segment];
        const before = baseline.segments[segment];
        return (
          after.totalUsedMinutes <=
          Math.max(after.availableMinutes, before.totalUsedMinutes)
        );
      });
    },
  );
  const changed = new Map(result.changes.map((c) => [c.taskId, c.after]));
  const rows = data.tasks.map((t) => ({ ...t, ...changed.get(t.id) }));
  const dates = [...new Set(result.changes.map((c) => c.after.date))];
  const labels = { morning: "上午", afternoon: "下午", evening: "晚上" };
  for (const day of model(rows, dates).days)
    for (const segment of ["morning", "afternoon", "evening"] as const) {
      const usage = day.segments[segment];
      if (usage.totalUsedMinutes > usage.availableMinutes)
        result.warnings.push(
          `${day.dateKey} ${labels[segment]}：安排后容量 ${usage.totalUsedMinutes}/${usage.availableMinutes} 分钟，请确认是否合适。`,
        );
    }
  return result;
}
export async function readTaskTiming(
  db: Db,
  workspaceId: string,
  from: string,
  to = from,
) {
  localDateSchema.parse(from);
  localDateSchema.parse(to);
  if (to < from || Date.parse(to) - Date.parse(from) > 31 * 86400000)
    throw new TimingError("请选择 31 天以内的日期范围", 400);
  const data = await snapshot(db, workspaceId, { from, to });
  return { tasks: data.tasks, fixed: data.fixed, date: from, dateTo: to };
}

function timingRequestTaskIds(request: TimingRequest) {
  if (request.action === "schedule") return request.edits.map((edit) => edit.taskId);
  if (request.action === "arrange") return request.taskIds;
  return [request.taskId];
}

export async function applyConfirmedTaskTiming(
  db: Db,
  workspaceId: string,
  input: unknown,
  idempotencyKey: string,
) {
  const request = timingRequestSchema.parse(input);
  if (!idempotencyKey || idempotencyKey.length > 180) throw new TimingError("缺少有效的请求标识", 400);
  const requestHash = hash({ request, idempotencyKey });

  return db.transaction(async (tx) => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    const [existing] = await tx
      .select()
      .from(planOperations)
      .where(and(eq(planOperations.workspaceId, workspaceId), eq(planOperations.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new TimingError("同一请求标识不能用于不同变更", 409);
      if (existing.status === "succeeded") return { ...(existing.resultJson as Record<string, unknown>), replayed: true };
      throw new TimingError("这次时间写入仍在处理中，请稍后重试", 409);
    }

    const current = await readTasks(tx, workspaceId);
    const range = timingRange(request, current.tasks);
    const data = await snapshot(tx, workspaceId, range, true);
    const result = calculateProposal(request, data);
    const protectedMove = result.changes.find((change) =>
      !change.before.movable && (
        change.before.date !== change.after.date ||
        change.before.scheduledStart !== change.after.scheduledStart ||
        change.before.scheduledEnd !== change.after.scheduledEnd
      ));
    if (protectedMove) {
      throw new TimingError(`${protectedMove.title} 的时段受保护，请改用 Review 确认移动`, 409);
    }
    const [operation] = await tx
      .insert(planOperations)
      .values({
        workspaceId,
        planId: data.planId,
        operationKind: "confirmed_task_timing",
        idempotencyKey,
        requestHash,
        status: "started",
        resultJson: {},
      })
      .returning({ id: planOperations.id });

    for (const change of result.changes) {
      const after = change.after;
      await tx
        .update(tasks)
        .set({
          date: new Date(localInstant(after.date, 0)),
          daySegment: after.daySegment,
          status: after.status,
          movable: after.movable,
          scheduledStart: after.scheduledStart ? new Date(after.scheduledStart) : null,
          scheduledEnd: after.scheduledEnd ? new Date(after.scheduledEnd) : null,
          deadlineAt: after.deadlineAt ? new Date(after.deadlineAt) : null,
          targetDate: after.targetDate ? new Date(localInstant(after.targetDate, 0)) : null,
          checkpoint: after.checkpoint,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, change.taskId), eq(tasks.workspaceId, workspaceId), eq(tasks.planId, data.planId)));
    }

    const saved = await readTasks(tx, workspaceId);
    const requestedIds = timingRequestTaskIds(request);
    const changedById = new Map(result.changes.map((change) => [change.taskId, change]));
    const readback = requestedIds.map((taskId) => saved.tasks.find((task) => task.id === taskId)).filter(Boolean);
    if (readback.length !== requestedIds.length || result.changes.some((change) => {
      const task = saved.tasks.find((item) => item.id === change.taskId);
      return !task || hash(timingState(task)) !== hash(change.after);
    })) {
      throw new TimingError("保存校验失败，全部变更已回滚", 500);
    }

    const output = {
      status: result.changes.length > 0 ? "applied" as const : "no_change" as const,
      operationId: operation.id,
      idempotencyKey,
      changedTaskIds: [...changedById.keys()],
      warnings: result.warnings,
      verified: true,
      readback,
      replayed: false,
    };
    await tx
      .update(planOperations)
      .set({ status: "succeeded", resultJson: output, updatedAt: new Date() })
      .where(eq(planOperations.id, operation.id));
    await tx.insert(changeLogs).values({
      workspaceId,
      planId: data.planId,
      source: "mcp",
      summary: "Applied user-confirmed task time slots directly",
      detailsJson: { operationId: operation.id, idempotencyKey, changes: result.changes, warnings: result.warnings },
    });
    return output;
  });
}
type SavedPreview = {
  title: string;
  description: string;
  items: string[];
  count: number;
  request: TimingRequest;
  snapshotHash: string;
  planId: string;
  range: { from: string; to: string };
  changes: TimingChange[];
  warnings: string[];
  idempotencyKey: string;
};
export async function proposeTaskTiming(
  db: Db,
  workspaceId: string,
  input: unknown,
  idempotencyKey: string,
) {
  const request = timingRequestSchema.parse(input);
  if (!idempotencyKey || idempotencyKey.length > 180)
    throw new TimingError("缺少有效的请求标识", 400);
  const requestHash = hash({ idempotencyKey });
  return db.transaction(async (tx) => {
    await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    const [existing] = await tx
      .select()
      .from(operationApprovals)
      .where(
        and(
          eq(operationApprovals.workspaceId, workspaceId),
          eq(operationApprovals.operationKind, "task_timing"),
          eq(operationApprovals.requestHash, requestHash),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        hash((existing.summaryJson as SavedPreview).request) !== hash(request)
      )
        throw new TimingError("同一请求标识不能用于不同变更", 400);
      if (
        existing.expiresAt <= new Date() ||
        !["pending", "approved"].includes(existing.status)
      )
        throw new TimingError("这份预览已处理或过期，请生成新预览");
      const s = existing.summaryJson as SavedPreview;
      return {
        approvalId: existing.id,
        changes: s.changes,
        warnings: s.warnings,
        liveUnchanged: true as const,
      };
    }
    const current = await readTasks(tx, workspaceId);
    const range = timingRange(request, current.tasks);
    const data = await snapshot(tx, workspaceId, range);
    const result = calculateProposal(request, data);
    if (!result.changes.length)
      return {
        approvalId: null,
        changes: [],
        warnings: result.warnings.length ? result.warnings : ["安排没有变化。"],
        liveUnchanged: true as const,
      };
    const summary: SavedPreview = {
      title: "任务时间安排",
      description: "确认以下时间、保护设置和进展变更后应用。",
      items: result.changes.map(
        (c) =>
          `${c.title}：${timingLabel(c.before)} → ${timingLabel(c.after)}${c.after.checkpoint ? `；剩余／进展：${c.after.checkpoint}` : ""}`,
      ),
      count: result.changes.length,
      request,
      snapshotHash: data.hash,
      planId: data.planId,
      range,
      ...result,
      idempotencyKey,
    };
    const changedTaskIds = new Set(result.changes.map((change) => change.taskId));
    const activePreviews = await tx
      .select({ id: operationApprovals.id, summaryJson: operationApprovals.summaryJson })
      .from(operationApprovals)
      .where(and(
        eq(operationApprovals.workspaceId, workspaceId),
        eq(operationApprovals.operationKind, "task_timing"),
        inArray(operationApprovals.status, ["pending", "approved"]),
      ));
    const supersededIds = activePreviews
      .filter((preview: { summaryJson: unknown }) => {
        const prior = preview.summaryJson as Partial<SavedPreview> | null;
        return Array.isArray(prior?.changes) && prior.changes.some((change) => changedTaskIds.has(change.taskId));
      })
      .map((preview: { id: string }) => preview.id);
    if (supersededIds.length > 0) {
      await tx
        .update(operationApprovals)
        .set({ status: "stale", updatedAt: new Date() })
        .where(inArray(operationApprovals.id, supersededIds));
    }
    const [approval] = await tx
      .insert(operationApprovals)
      .values({
        workspaceId,
        operationKind: "task_timing",
        requestHash,
        previewHash: hash(summary),
        summaryJson: summary,
        status: "pending",
        expiresAt: new Date(Date.now() + 30 * 60000),
      })
      .returning();
    return { approvalId: approval.id, ...result, liveUnchanged: true as const };
  });
}
export async function applyTaskTiming(
  db: Db,
  workspaceId: string,
  approvalId: string,
) {
  async function stale(tx: any, message: string) {
    await tx
      .update(operationApprovals)
      .set({ status: "stale", updatedAt: new Date() })
      .where(eq(operationApprovals.id, approvalId));
    return { kind: "stale" as const, message };
  }

  const applied = await db.transaction(async (tx) => {
    await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    const [approval] = await tx
      .select()
      .from(operationApprovals)
      .where(
        and(
          eq(operationApprovals.workspaceId, workspaceId),
          eq(operationApprovals.id, approvalId),
          eq(operationApprovals.operationKind, "task_timing"),
        ),
      )
      .for("update");
    if (!approval) throw new TimingError("找不到这份时间安排预览", 404);
    const s = approval.summaryJson as SavedPreview;
    if (approval.status === "consumed")
      return { kind: "ready" as const, changes: s.changes, replayed: true };
    if (approval.status !== "approved")
      throw new TimingError("请先确认这份预览");
    if (approval.expiresAt <= new Date())
      return stale(tx, "预览已过期，请重新生成");
    const data = await snapshot(tx, workspaceId, s.range, true);
    if (data.hash !== s.snapshotHash || data.planId !== s.planId)
      return stale(tx, "任务或固定安排已经变化，请重新预览后确认");
    // Revalidate against current time as well as the persisted snapshot.
    const computed = calculateProposal(s.request, data);
    if (hash(computed) !== hash({ changes: s.changes, warnings: s.warnings }))
      return stale(tx, "时间已变化，请重新生成预览");
    for (const c of s.changes) {
      const a = c.after;
      await tx
        .update(tasks)
        .set({
          date: new Date(localInstant(a.date, 0)),
          daySegment: a.daySegment,
          status: a.status,
          movable: a.movable,
          scheduledStart: a.scheduledStart ? new Date(a.scheduledStart) : null,
          scheduledEnd: a.scheduledEnd ? new Date(a.scheduledEnd) : null,
          deadlineAt: a.deadlineAt ? new Date(a.deadlineAt) : null,
          targetDate: a.targetDate
            ? new Date(localInstant(a.targetDate, 0))
            : null,
          checkpoint: a.checkpoint,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, c.taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.planId, s.planId),
          ),
        );
    }
    const readback = await readTasks(tx, workspaceId);
    for (const c of s.changes) {
      const saved = readback.tasks.find((t) => t.id === c.taskId);
      if (!saved || hash(timingState(saved)) !== hash(c.after))
        throw new TimingError("保存校验失败，全部变更已回滚", 500);
    }
    await tx
      .update(operationApprovals)
      .set({
        status: "consumed",
        consumedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(operationApprovals.id, approvalId));
    await tx
      .insert(changeLogs)
      .values({
        workspaceId,
        planId: s.planId,
        source: "manual",
        summary: "Applied reviewed task time slots",
        detailsJson: { approvalId, changes: s.changes, warnings: s.warnings },
      });
    return { kind: "ready" as const, changes: s.changes, replayed: false };
  });
  if (applied.kind === "stale")
    throw new TimingError(applied.message, 409, "preview_stale");
  const after = await readTasks(db, workspaceId);
  const readback = applied.changes.map((c) =>
    after.tasks.find((t) => t.id === c.taskId),
  );
  const verified = applied.changes.every(
    (c, i) => readback[i] && hash(timingState(readback[i]!)) === hash(c.after),
  );
  if (!verified)
    throw new TimingError("变更已提交，但最新状态又发生变化，请刷新核对");
  return {
    status: "applied" as const,
    approvalId,
    replayed: applied.replayed,
    verified,
    readback,
  };
}
