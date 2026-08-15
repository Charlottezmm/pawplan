import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, type SQL } from "drizzle-orm";
import {
  agentPatches,
  changeLogs,
  checkinTasks,
  planOperations,
  projects,
  taskTags,
  tasks,
} from "@/lib/db/schema";
import { ActivePlanError, resolveActivePlanContext } from "@/lib/planning/active-plan";
import {
  consumeOperationApproval,
  createOperationApproval,
  verifyOperationApproval,
} from "@/lib/approvals/service";
import {
  createTaskBatchPreviewToken,
  stableHash,
  taskSelectionHash,
  verifyTaskBatchPreviewToken,
  type TaskBatchAction,
  type TaskBatchFingerprintRow,
  type TaskBatchPreviewPayload,
} from "@/lib/mcp/task-batch-preview";

type TaskStatus = "todo" | "done" | "skipped" | "backlog";

export type TaskBatchFilters = {
  statuses?: TaskStatus[];
  dateFrom?: string;
  dateTo?: string;
  projectIds?: string[];
  taskIds?: string[];
};

export type TaskBatchPreview = {
  status: "succeeded" | "no_change";
  action: TaskBatchAction;
  count: number;
  totalMinutes: number;
  excludedDoneCount: number;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    date: string;
    projectId: string | null;
    projectName: string | null;
    archivedAt: string | null;
  }>;
  sideEffects: {
    checkinTaskLinks: number;
    taskTagLinks: number;
    detachedChildTaskIds: string[];
    affectedDraftPatchIds: string[];
  };
  previewToken?: string;
  expiresAt?: string;
  approvalId?: string;
};

export type TaskBatchApplyResult = {
  status: "succeeded" | "no_change" | "duplicate";
  originalStatus?: string;
  operationId: string;
  groupId: string | null;
  idempotencyKey: string;
  processedCount: number;
  taskIds: string[];
  unchangedTaskIds: string[];
  readback?: TaskSurfaceReadback;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

export type TaskBatchPostCommitResult = Omit<TaskBatchApplyResult, "status"> & {
  status: TaskBatchApplyResult["status"] | "applied_with_readback_error";
  persistedStatus?: TaskBatchApplyResult["status"];
  postCommitReadback:
    | ({ verification: "succeeded" } & Record<string, unknown>)
    | { verification: "failed"; error: { code: "readback_failed"; message: string } };
  warnings?: Array<{ code: "readback_failed"; message: string; mutationApplied: boolean }>;
};

type TaskSurfaceReadback = {
  todoCount: number;
  backlogCount: number;
  archivedCount: number;
  weekVisibleCount: number;
  monthVisibleCount: number;
  verification: "succeeded";
};

type TaskArchiveDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

type TaskRow = TaskBatchFingerprintRow & {
  workspaceId: string;
};

const taskStatuses: TaskStatus[] = ["todo", "done", "skipped", "backlog"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class McpTaskArchiveError extends Error {
  constructor(
    public code:
      | "invalid_filter"
      | "unresolved_filter"
      | "preview_required"
      | "preview_invalid"
      | "preview_expired"
      | "preview_stale"
      | "confirmation_count_mismatch"
      | "retirement_confirmation_required"
      | "active_plan_missing"
      | "active_plan_conflict"
      | "idempotency_payload_mismatch"
      | "operation_in_progress"
      | "operation_lease_expired"
      | "active_review_dependency"
      | "task_not_found",
    message: string,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function parseDateBoundary(value: string) {
  const date = new Date(`${value}T00:00:00.000+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || dateKey(date) !== value) {
    throw new McpTaskArchiveError("invalid_filter", `Invalid task date: ${value}`, 400);
  }
  return date;
}

function dateKey(value: Date | string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function iso(value: Date | string | null) {
  return value === null ? null : new Date(value).toISOString();
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfShanghaiDay(now = new Date()) {
  return parseDateBoundary(dateKey(now));
}

function readbackRanges(now = new Date()) {
  const today = startOfShanghaiDay(now);
  const shanghaiNoon = new Date(today.getTime() + 20 * 60 * 60 * 1000);
  const weekday = shanghaiNoon.getUTCDay();
  const weekStart = addDays(today, weekday === 0 ? -6 : 1 - weekday);
  const weekEnd = addDays(weekStart, 7);
  const [year, month] = dateKey(now).split("-").map(Number);
  const monthStart = parseDateBoundary(`${year}-${String(month).padStart(2, "0")}-01`);
  const nextMonthYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const monthEnd = parseDateBoundary(`${nextMonthYear}-${String(nextMonth).padStart(2, "0")}-01`);
  return { weekStart, weekEnd, monthStart, monthEnd };
}

function normalizedFilters(input: {
  filters: TaskBatchFilters;
  includeDone: boolean;
  allowDeleteUnarchived: boolean;
}) {
  return {
    statuses: input.filters.statuses ? [...input.filters.statuses].sort() : undefined,
    dateFrom: input.filters.dateFrom,
    dateTo: input.filters.dateTo,
    projectIds: input.filters.projectIds ? [...input.filters.projectIds].sort() : undefined,
    taskIds: input.filters.taskIds ? [...input.filters.taskIds].sort() : undefined,
    includeDone: input.includeDone,
    allowDeleteUnarchived: input.allowDeleteUnarchived,
  };
}

function validateFilters(filters: TaskBatchFilters) {
  const arrays = [filters.statuses, filters.projectIds, filters.taskIds];
  if (
    !filters.dateFrom &&
    !filters.dateTo &&
    arrays.every((values) => values === undefined || values.length === 0)
  ) {
    throw new McpTaskArchiveError("invalid_filter", "At least one task selection filter is required", 400);
  }
  if ((filters.dateFrom && !filters.dateTo) || (!filters.dateFrom && filters.dateTo)) {
    throw new McpTaskArchiveError("invalid_filter", "date_from and date_to must be provided together", 400);
  }
  if (filters.dateFrom && filters.dateTo && parseDateBoundary(filters.dateFrom) >= parseDateBoundary(filters.dateTo)) {
    throw new McpTaskArchiveError("invalid_filter", "date_from must be before date_to", 400);
  }
  if (filters.statuses) {
    if (filters.statuses.length === 0 || new Set(filters.statuses).size !== filters.statuses.length) {
      throw new McpTaskArchiveError("invalid_filter", "statuses must be a non-empty unique list", 400);
    }
    if (filters.statuses.some((status) => !taskStatuses.includes(status))) {
      throw new McpTaskArchiveError("invalid_filter", "Unknown task status", 400);
    }
  }
  for (const [name, ids] of [["project_ids", filters.projectIds], ["task_ids", filters.taskIds]] as const) {
    if (!ids) continue;
    if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !uuidPattern.test(id))) {
      throw new McpTaskArchiveError("invalid_filter", `${name} must be a non-empty unique UUID list`, 400);
    }
  }
}

function collectTaskIds(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectTaskIds(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "task_id" && typeof item === "string") result.add(item);
    else collectTaskIds(item, result);
  }
  return result;
}

async function requireActivePlanId(db: any, workspaceId: string, lock = false) {
  try {
    return (await resolveActivePlanContext(db, workspaceId, { lock })).id;
  } catch (error) {
    if (error instanceof ActivePlanError) {
      throw new McpTaskArchiveError(error.code, error.message, 409, error.details);
    }
    throw error;
  }
}

async function affectedDraftPatchIds(db: any, workspaceId: string, planId: string, taskIds: string[]) {
  if (taskIds.length === 0) return [];
  const targetIds = new Set(taskIds);
  const rows = await db
    .select({ id: agentPatches.id, patchJson: agentPatches.patchJson })
    .from(agentPatches)
    .where(
      and(
        eq(agentPatches.workspaceId, workspaceId),
        eq(agentPatches.planId, planId),
        eq(agentPatches.status, "draft"),
      ),
    );
  return rows
    .filter((row: { patchJson: unknown }) => [...collectTaskIds(row.patchJson)].some((id) => targetIds.has(id)))
    .map((row: { id: string }) => row.id);
}

async function requireResolvedIds(db: any, workspaceId: string, planId: string, filters: TaskBatchFilters) {
  if (filters.projectIds) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, filters.projectIds)));
    const found = new Set(rows.map((row: { id: string }) => row.id));
    const missingProjectIds = filters.projectIds.filter((id) => !found.has(id));
    if (missingProjectIds.length > 0) {
      throw new McpTaskArchiveError("unresolved_filter", "One or more Projects were not found", 400, {
        missingProjectIds,
      });
    }
  }
  if (filters.taskIds) {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.planId, planId),
          inArray(tasks.id, filters.taskIds),
        ),
      );
    const found = new Set(rows.map((row: { id: string }) => row.id));
    const missingTaskIds = filters.taskIds.filter((id) => !found.has(id));
    if (missingTaskIds.length > 0) {
      throw new McpTaskArchiveError("unresolved_filter", "One or more tasks were not found in the active plan", 400, {
        missingTaskIds,
      });
    }
  }
}

function taskSelectionConditions(input: {
  workspaceId: string;
  planId: string;
  action: TaskBatchAction;
  filters: TaskBatchFilters;
  includeDone: boolean;
  allowDeleteUnarchived: boolean;
}) {
  const conditions: SQL[] = [eq(tasks.workspaceId, input.workspaceId), eq(tasks.planId, input.planId)];
  if (input.action === "archive") conditions.push(isNull(tasks.archivedAt));
  if (input.action === "restore" || (input.action === "delete" && !input.allowDeleteUnarchived)) {
    conditions.push(isNotNull(tasks.archivedAt));
  }
  if (!input.includeDone) conditions.push(ne(tasks.status, "done"));
  if (input.filters.statuses) conditions.push(inArray(tasks.status, input.filters.statuses));
  if (input.filters.dateFrom) conditions.push(gte(tasks.date, parseDateBoundary(input.filters.dateFrom)));
  if (input.filters.dateTo) conditions.push(lt(tasks.date, parseDateBoundary(input.filters.dateTo)));
  if (input.filters.projectIds) conditions.push(inArray(tasks.projectId, input.filters.projectIds));
  if (input.filters.taskIds) conditions.push(inArray(tasks.id, input.filters.taskIds));
  return conditions;
}

async function previewSideEffects(db: any, workspaceId: string, planId: string, taskIds: string[]) {
  if (taskIds.length === 0) {
    return { checkinTaskLinks: 0, taskTagLinks: 0, detachedChildTaskIds: [], affectedDraftPatchIds: [] };
  }
  const [checkinRows, tagRows, childRows, patchIds] = await Promise.all([
    db
      .select({ id: checkinTasks.id })
      .from(checkinTasks)
      .where(and(eq(checkinTasks.workspaceId, workspaceId), inArray(checkinTasks.taskId, taskIds))),
    db
      .select({ taskId: taskTags.taskId })
      .from(taskTags)
      .where(and(eq(taskTags.workspaceId, workspaceId), inArray(taskTags.taskId, taskIds))),
    db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.planId, planId),
          inArray(tasks.parentTaskId, taskIds),
        ),
      ),
    affectedDraftPatchIds(db, workspaceId, planId, taskIds),
  ]);
  return {
    checkinTaskLinks: checkinRows.length,
    taskTagLinks: tagRows.length,
    detachedChildTaskIds: childRows
      .map((row: { id: string }) => row.id)
      .filter((id: string) => !taskIds.includes(id)),
    affectedDraftPatchIds: patchIds,
  };
}

export async function previewTaskBatch(
  db: TaskArchiveDb,
  input: {
    workspaceId: string;
    action: TaskBatchAction;
    filters: TaskBatchFilters;
    includeDone?: boolean;
    allowDeleteUnarchived?: boolean;
    now?: Date;
  },
): Promise<TaskBatchPreview> {
  validateFilters(input.filters);
  const includeDone = input.includeDone ?? false;
  const allowDeleteUnarchived = input.allowDeleteUnarchived ?? false;
  const planId = await requireActivePlanId(db, input.workspaceId);
  await requireResolvedIds(db, input.workspaceId, planId, input.filters);

  const selectionInput = {
    workspaceId: input.workspaceId,
    planId,
    action: input.action,
    filters: input.filters,
    includeDone,
    allowDeleteUnarchived,
  };
  const rows: TaskRow[] = await db
    .select({
      id: tasks.id,
      workspaceId: tasks.workspaceId,
      planId: tasks.planId,
      title: tasks.title,
      status: tasks.status,
      date: tasks.date,
      projectId: tasks.projectId,
      milestoneId: tasks.milestoneId,
      parentTaskId: tasks.parentTaskId,
      estimatedMinutes: tasks.estimatedMinutes,
      archivedAt: tasks.archivedAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(...taskSelectionConditions(selectionInput)))
    .orderBy(tasks.id);

  const maxCount = input.action === "delete" ? 50 : 500;
  if (rows.length > maxCount) {
    throw new McpTaskArchiveError("invalid_filter", `${input.action} preview exceeds the ${maxCount} task limit`, 400, {
      resolvedCount: rows.length,
      maxCount,
    });
  }

  let excludedDoneCount = 0;
  if (!includeDone) {
    const doneRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(...taskSelectionConditions({ ...selectionInput, includeDone: true }), eq(tasks.status, "done")));
    excludedDoneCount = doneRows.length;
  }

  const projectIds = [...new Set(rows.flatMap((row) => row.projectId ? [row.projectId] : []))];
  const projectRows = projectIds.length
    ? await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.workspaceId, input.workspaceId), inArray(projects.id, projectIds)))
    : [];
  const projectById = new Map<string, string>(
    projectRows.map((project: { id: string; name: string }) => [project.id, project.name] as const),
  );
  const sideEffects = await previewSideEffects(db, input.workspaceId, planId, rows.map((row) => row.id));
  const filters = normalizedFilters({ filters: input.filters, includeDone, allowDeleteUnarchived });
  const tokenResult = rows.length > 0
    ? createTaskBatchPreviewToken({
        action: input.action,
        workspaceId: input.workspaceId,
        planId,
        rows,
        filters,
        now: input.now,
      })
    : null;
  const approval = tokenResult
    ? await createOperationApproval(db, {
        workspaceId: input.workspaceId,
        operationKind: operationKind(input.action),
        requestHash: approvalRequestHash(tokenResult.payload),
        previewToken: tokenResult.token,
        expiresAt: new Date(tokenResult.payload.expiresAt),
        summary: {
          title:
            input.action === "archive"
              ? "批量归档任务"
              : input.action === "restore"
                ? "批量恢复任务"
                : "永久删除任务",
          description:
            input.action === "delete"
              ? "永久删除不可恢复，请逐项核对。"
              : "任务状态保持不变，只改变是否进入当前计划。",
          count: rows.length,
          totalMinutes: rows.reduce((sum, row) => sum + row.estimatedMinutes, 0),
          items: rows.map((row) => row.title),
        },
      })
    : null;

  return {
    status: rows.length > 0 ? "succeeded" : "no_change",
    action: input.action,
    count: rows.length,
    totalMinutes: rows.reduce((sum, row) => sum + row.estimatedMinutes, 0),
    excludedDoneCount,
    tasks: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status as TaskStatus,
      date: dateKey(row.date),
      projectId: row.projectId,
      projectName: row.projectId ? projectById.get(row.projectId) ?? null : null,
      archivedAt: iso(row.archivedAt),
    })),
    sideEffects,
    previewToken: tokenResult?.token,
    expiresAt: tokenResult?.payload.expiresAt,
    approvalId: approval?.id,
  };
}

async function readExactTasks(tx: any, workspaceId: string, planId: string, taskIds: string[], lock = false) {
  const query = tx
    .select({
      id: tasks.id,
      workspaceId: tasks.workspaceId,
      planId: tasks.planId,
      title: tasks.title,
      status: tasks.status,
      date: tasks.date,
      projectId: tasks.projectId,
      milestoneId: tasks.milestoneId,
      parentTaskId: tasks.parentTaskId,
      estimatedMinutes: tasks.estimatedMinutes,
      archivedAt: tasks.archivedAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.planId, planId),
        inArray(tasks.id, taskIds),
      ),
    );
  return lock ? query.orderBy(tasks.id).for("update") : query.orderBy(tasks.id);
}

async function readTaskSurface(tx: any, workspaceId: string, planId: string, now: Date): Promise<TaskSurfaceReadback> {
  const rows = await tx
    .select({ status: tasks.status, date: tasks.date, archivedAt: tasks.archivedAt })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId)));
  const { weekStart, weekEnd, monthStart, monthEnd } = readbackRanges(now);
  const activeRows = rows.filter((row: { archivedAt: Date | null }) => row.archivedAt === null);
  return {
    todoCount: activeRows.filter((row: { status: string }) => row.status === "todo").length,
    backlogCount: activeRows.filter((row: { status: string }) => row.status === "backlog").length,
    archivedCount: rows.length - activeRows.length,
    weekVisibleCount: activeRows.filter((row: { date: Date }) => row.date >= weekStart && row.date < weekEnd).length,
    monthVisibleCount: activeRows.filter((row: { date: Date }) => row.date >= monthStart && row.date < monthEnd).length,
    verification: "succeeded",
  };
}

function operationKind(action: TaskBatchAction) {
  return `${action}_tasks_batch`;
}

function approvalRequestHash(preview: TaskBatchPreviewPayload) {
  return stableHash({
    action: preview.action,
    planId: preview.planId,
    taskIds: preview.taskIds,
    selectionHash: preview.selectionHash,
    count: preview.count,
  });
}

async function claimOperation(
  db: TaskArchiveDb,
  input: {
    workspaceId: string;
    planId: string;
    action: TaskBatchAction;
    idempotencyKey: string;
    requestHash: string;
    groupId: string | null;
    now: Date;
  },
): Promise<{ kind: "claimed"; id: string } | { kind: "duplicate"; result: TaskBatchApplyResult }> {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .insert(planOperations)
      .values({
        workspaceId: input.workspaceId,
        planId: input.planId,
        operationKind: operationKind(input.action),
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        groupId: input.groupId,
        status: "started",
        resultJson: {},
        leaseExpiresAt: new Date(input.now.getTime() + 5 * 60 * 1000),
      })
      .onConflictDoNothing({ target: [planOperations.workspaceId, planOperations.idempotencyKey] })
      .returning({ id: planOperations.id });
    if (claim) return { kind: "claimed" as const, id: claim.id };

    const [existing] = await tx
      .select()
      .from(planOperations)
      .where(
        and(
          eq(planOperations.workspaceId, input.workspaceId),
          eq(planOperations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)
      .for("update");
    if (!existing || existing.requestHash !== input.requestHash) {
      throw new McpTaskArchiveError(
        "idempotency_payload_mismatch",
        "Idempotency key was already used with a different payload",
        409,
      );
    }
    if (existing.status === "started") {
      const leaseExpiresAt = existing.leaseExpiresAt ? new Date(existing.leaseExpiresAt) : null;
      if (!leaseExpiresAt || Number.isNaN(leaseExpiresAt.getTime()) || leaseExpiresAt <= input.now) {
        const failure = {
          code: "operation_lease_expired",
          message: "The previous task batch lease expired before completion",
          details: { retryable: true, retryWithNewIdempotencyKey: true },
        };
        await tx
          .update(planOperations)
          .set({
            status: "failed",
            resultJson: {
              status: "failed",
              operationId: existing.id,
              groupId: existing.groupId ?? null,
              idempotencyKey: input.idempotencyKey,
              processedCount: 0,
              taskIds: [],
              unchangedTaskIds: [],
              error: failure,
            },
            errorJson: failure,
            leaseExpiresAt: null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(planOperations.id, existing.id),
              eq(planOperations.workspaceId, input.workspaceId),
              eq(planOperations.status, "started"),
            ),
          );
        return {
          kind: "duplicate" as const,
          result: {
            status: "duplicate",
            originalStatus: "failed",
            operationId: existing.id,
            groupId: existing.groupId ?? null,
            idempotencyKey: input.idempotencyKey,
            processedCount: 0,
            taskIds: [],
            unchangedTaskIds: [],
            error: failure,
          },
        };
      }
      throw new McpTaskArchiveError("operation_in_progress", "Task batch operation is still in progress", 409, {
        operationId: existing.id,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      });
    }
    const stored = existing.resultJson as Partial<TaskBatchApplyResult>;
    if (existing.status === "failed") {
      const error = existing.errorJson && typeof existing.errorJson === "object"
        ? existing.errorJson as TaskBatchApplyResult["error"]
        : { code: "task_batch_failed", message: "The original task batch failed" };
      return {
        kind: "duplicate" as const,
        result: {
          status: "duplicate",
          originalStatus: "failed",
          operationId: existing.id,
          groupId: existing.groupId ?? null,
          idempotencyKey: input.idempotencyKey,
          processedCount: 0,
          taskIds: [],
          unchangedTaskIds: [],
          error,
        },
      };
    }
    return {
      kind: "duplicate" as const,
      result: {
        processedCount: stored.processedCount ?? 0,
        taskIds: stored.taskIds ?? [],
        unchangedTaskIds: stored.unchangedTaskIds ?? [],
        readback: stored.readback,
        status: "duplicate",
        originalStatus: existing.status,
        operationId: existing.id,
        groupId: existing.groupId ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    };
  });
}

async function verifyOperationLease(
  tx: any,
  input: { workspaceId: string; operationId: string; requestHash: string; now: Date },
) {
  const [operation] = await tx
    .select({
      id: planOperations.id,
      requestHash: planOperations.requestHash,
      status: planOperations.status,
      leaseExpiresAt: planOperations.leaseExpiresAt,
    })
    .from(planOperations)
    .where(
      and(
        eq(planOperations.id, input.operationId),
        eq(planOperations.workspaceId, input.workspaceId),
      ),
    )
    .limit(1)
    .for("update");
  const leaseExpiresAt = operation?.leaseExpiresAt ? new Date(operation.leaseExpiresAt) : null;
  if (
    !operation ||
    operation.requestHash !== input.requestHash ||
    operation.status !== "started" ||
    !leaseExpiresAt ||
    Number.isNaN(leaseExpiresAt.getTime()) ||
    leaseExpiresAt <= input.now
  ) {
    throw new McpTaskArchiveError(
      "operation_lease_expired",
      "Task batch operation no longer owns a valid write lease",
      409,
      { operationId: input.operationId, retryable: true, retryWithNewIdempotencyKey: true },
    );
  }
}

async function markOperationFailed(
  db: TaskArchiveDb,
  input: {
    workspaceId: string;
    operationId: string;
    groupId: string | null;
    idempotencyKey: string;
    error: unknown;
  },
) {
  const error = input.error;
  const failure = error instanceof McpTaskArchiveError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: "task_batch_failed", message: error instanceof Error ? error.message : "Task batch failed" };
  try {
    await db
      .update(planOperations)
      .set({
        status: "failed",
        resultJson: {
          status: "failed",
          operationId: input.operationId,
          groupId: input.groupId,
          idempotencyKey: input.idempotencyKey,
          processedCount: 0,
          taskIds: [],
          unchangedTaskIds: [],
          error: failure,
        },
        errorJson: failure,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(planOperations.id, input.operationId), eq(planOperations.workspaceId, input.workspaceId)));
  } catch {
    // The original operation error is more important than a best-effort failed-state write.
  }
}

function beforeSnapshot(rows: TaskRow[]) {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    date: iso(row.date),
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    parentTaskId: row.parentTaskId,
    estimatedMinutes: row.estimatedMinutes,
    archivedAt: iso(row.archivedAt),
  }));
}

export async function applyTaskArchiveBatch(
  db: TaskArchiveDb,
  input: {
    workspaceId: string;
    action: TaskBatchAction;
    previewToken: string | undefined;
    approvalId?: string;
    confirmTaskCount: number;
    idempotencyKey: string;
    confirmation?: string;
    groupId?: string;
    now?: Date;
  },
): Promise<TaskBatchApplyResult> {
  if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new McpTaskArchiveError("invalid_filter", "Invalid batch idempotency key", 400);
  }
  if (input.action === "delete") {
    if (input.confirmation !== "PERMANENT_DELETE") {
      throw new McpTaskArchiveError(
        "retirement_confirmation_required",
        "Permanent deletion requires exact confirmation",
        400,
      );
    }
    if (!input.groupId || !uuidPattern.test(input.groupId)) {
      throw new McpTaskArchiveError("invalid_filter", "Permanent deletion requires a valid operation_id", 400);
    }
  }

  const verified = verifyTaskBatchPreviewToken({
    token: input.previewToken,
    action: input.action,
    workspaceId: input.workspaceId,
    now: input.now,
  });
  if (!verified.ok) throw new McpTaskArchiveError(verified.code, verified.reason, 400);
  const preview = verified.payload;
  if (preview.count < 1 || input.confirmTaskCount !== preview.count) {
    throw new McpTaskArchiveError(
      "confirmation_count_mismatch",
      "Confirmed task count does not match the preview",
      409,
      { previewCount: preview.count, confirmedCount: input.confirmTaskCount },
    );
  }
  if (input.action === "delete" && preview.count > 50) {
    throw new McpTaskArchiveError("invalid_filter", "Permanent deletion is limited to 50 tasks per batch", 400);
  }
  if (input.action !== "delete" && preview.count > 500) {
    throw new McpTaskArchiveError("invalid_filter", "Archive and restore are limited to 500 tasks per batch", 400);
  }

  const requestHash = stableHash({
    action: input.action,
    planId: preview.planId,
    taskIds: preview.taskIds,
    selectionHash: preview.selectionHash,
    confirmTaskCount: input.confirmTaskCount,
    groupId: input.groupId ?? null,
  });
  const now = input.now ?? new Date();
  const [existingOperation] = await db
    .select()
    .from(planOperations)
    .where(
      and(
        eq(planOperations.workspaceId, input.workspaceId),
        eq(planOperations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existingOperation?.idempotencyKey === input.idempotencyKey) {
    const duplicate = await claimOperation(db, {
      workspaceId: input.workspaceId,
      planId: preview.planId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      groupId: input.groupId ?? null,
      now,
    });
    if (duplicate.kind === "duplicate") return duplicate.result;
  }
  await verifyOperationApproval(db, {
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    operationKind: operationKind(input.action),
    requestHash: approvalRequestHash(preview),
    previewToken: input.previewToken!,
    now,
  });
  const claim = await claimOperation(db, {
    workspaceId: input.workspaceId,
    planId: preview.planId,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    groupId: input.groupId ?? null,
    now,
  });
  if (claim.kind === "duplicate") return claim.result;

  try {
    return await db.transaction(async (tx) => {
      await verifyOperationLease(tx, {
        workspaceId: input.workspaceId,
        operationId: claim.id,
        requestHash,
        now,
      });
      const activePlanId = await requireActivePlanId(tx, input.workspaceId, true);
      if (activePlanId !== preview.planId) {
        throw new McpTaskArchiveError("preview_stale", "The active plan changed after preview", 409);
      }

      const currentRows: TaskRow[] = await readExactTasks(
        tx,
        input.workspaceId,
        preview.planId,
        preview.taskIds,
        true,
      );
      if (currentRows.length !== preview.taskIds.length || taskSelectionHash(currentRows) !== preview.selectionHash) {
        throw new McpTaskArchiveError("preview_stale", "One or more tasks changed after preview", 409, {
          expectedCount: preview.taskIds.length,
          actualCount: currentRows.length,
        });
      }

      await consumeOperationApproval(tx, {
        workspaceId: input.workspaceId,
        approvalId: input.approvalId,
        operationKind: operationKind(input.action),
        requestHash: approvalRequestHash(preview),
        previewToken: input.previewToken!,
        now,
      });

      if (input.action === "delete") {
        const patchIds = await affectedDraftPatchIds(tx, input.workspaceId, preview.planId, preview.taskIds);
        if (patchIds.length > 0) {
          throw new McpTaskArchiveError(
            "active_review_dependency",
            "One or more Review drafts still reference tasks selected for deletion",
            409,
            { patchIds },
          );
        }
      }

      let changedIds: string[];
      if (input.action === "delete") {
        const deleted = await tx
          .delete(tasks)
          .where(
            and(
              eq(tasks.workspaceId, input.workspaceId),
              eq(tasks.planId, preview.planId),
              inArray(tasks.id, preview.taskIds),
            ),
          )
          .returning({ id: tasks.id });
        changedIds = deleted.map((row: { id: string }) => row.id);
      } else {
        const archivedAt = input.action === "archive" ? now : null;
        const updated = await tx
          .update(tasks)
          .set({ archivedAt, updatedAt: now })
          .where(
            and(
              eq(tasks.workspaceId, input.workspaceId),
              eq(tasks.planId, preview.planId),
              inArray(tasks.id, preview.taskIds),
              input.action === "archive" ? isNull(tasks.archivedAt) : isNotNull(tasks.archivedAt),
            ),
          )
          .returning({ id: tasks.id });
        changedIds = updated.map((row: { id: string }) => row.id);
      }
      if (changedIds.length !== preview.taskIds.length) {
        throw new McpTaskArchiveError("preview_stale", "Task batch changed fewer rows than the confirmed preview", 409, {
          expectedCount: preview.taskIds.length,
          actualCount: changedIds.length,
        });
      }

      const readback = await readTaskSurface(tx, input.workspaceId, preview.planId, now);
      const result: TaskBatchApplyResult = {
        status: "succeeded",
        operationId: claim.id,
        groupId: input.groupId ?? null,
        idempotencyKey: input.idempotencyKey,
        processedCount: changedIds.length,
        taskIds: changedIds.sort(),
        unchangedTaskIds: [],
        readback,
      };
      await tx.insert(changeLogs).values({
        workspaceId: input.workspaceId,
        planId: preview.planId,
        source: "mcp",
        summary: `${operationKind(input.action)} completed`,
        detailsJson: {
          operationId: claim.id,
          groupId: input.groupId ?? null,
          idempotencyKey: input.idempotencyKey,
          taskCount: changedIds.length,
          taskIds: changedIds,
          before: beforeSnapshot(currentRows),
        },
      });
      await tx
        .update(planOperations)
        .set({
          status: "succeeded",
          resultJson: result,
          errorJson: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(eq(planOperations.id, claim.id), eq(planOperations.workspaceId, input.workspaceId)));
      return result;
    });
  } catch (error) {
    await markOperationFailed(db, {
      workspaceId: input.workspaceId,
      operationId: claim.id,
      groupId: input.groupId ?? null,
      idempotencyKey: input.idempotencyKey,
      error,
    });
    throw error;
  }
}

export async function attachTaskBatchPostCommitReadback(
  result: TaskBatchApplyResult,
  readback: () => Promise<Record<string, unknown>>,
): Promise<TaskBatchPostCommitResult> {
  try {
    return {
      ...result,
      postCommitReadback: { verification: "succeeded", ...(await readback()) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Post-commit task readback failed";
    return {
      ...result,
      status: result.status === "succeeded" ? "applied_with_readback_error" : result.status,
      persistedStatus: result.status,
      postCommitReadback: {
        verification: "failed",
        error: { code: "readback_failed", message },
      },
      warnings: [{ code: "readback_failed", message, mutationApplied: result.status === "succeeded" }],
    };
  }
}

export function taskBatchPreviewPayload(token: string, action: TaskBatchAction, workspaceId: string, now?: Date) {
  const result = verifyTaskBatchPreviewToken({ token, action, workspaceId, now });
  if (!result.ok) throw new McpTaskArchiveError(result.code, result.reason, 400);
  return result.payload as TaskBatchPreviewPayload;
}
