import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { changeLogs, mcpTaskWriteBatches, tasks } from "@/lib/db/schema";

type TaskStatus = "todo" | "done" | "skipped" | "backlog";
type DaySegment = "morning" | "afternoon" | "evening";

export type TaskBatchOperation = {
  taskId: string;
  status?: TaskStatus;
  date?: string;
  daySegment?: DaySegment;
  blocked?: boolean;
  estimatedMinutes?: number;
  expectedStatus?: TaskStatus;
  expectedDate?: string;
  expectedDaySegment?: DaySegment;
  expectedBlocked?: boolean;
  expectedEstimatedMinutes?: number;
};

export type TaskBatchResult = {
  status: "succeeded" | "no_change" | "duplicate";
  batchId: string;
  idempotencyKey: string;
  completedTaskIds: string[];
  pendingTaskIds: string[];
  readback: Array<{
    id: string;
    status: TaskStatus;
    date: string;
    daySegment: DaySegment;
    blocked: boolean;
    estimatedMinutes: number;
  }>;
};

type TaskBatchDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

export class McpTaskBatchError extends Error {
  constructor(
    public code: "invalid_batch" | "task_not_found" | "task_state_conflict" | "idempotency_payload_mismatch",
    message: string,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function shanghaiDateKey(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function dateFromKey(value: string) {
  const date = new Date(`${value}T00:00:00.000+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || shanghaiDateKey(date) !== value) {
    throw new McpTaskBatchError("invalid_batch", `Invalid task date: ${value}`, 400);
  }
  return date;
}

function requestHash(operations: TaskBatchOperation[]) {
  const canonical = operations.map((operation) => ({
    taskId: operation.taskId,
    status: operation.status,
    date: operation.date,
    daySegment: operation.daySegment,
    blocked: operation.blocked,
    estimatedMinutes: operation.estimatedMinutes,
    expectedStatus: operation.expectedStatus,
    expectedDate: operation.expectedDate,
    expectedDaySegment: operation.expectedDaySegment,
    expectedBlocked: operation.expectedBlocked,
    expectedEstimatedMinutes: operation.expectedEstimatedMinutes,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function serializeTask(task: Record<string, any>) {
  return {
    id: String(task.id),
    status: task.status as TaskStatus,
    date: shanghaiDateKey(task.date),
    daySegment: task.daySegment as DaySegment,
    blocked: Boolean(task.blocked),
    estimatedMinutes: Number(task.estimatedMinutes),
  };
}

async function readTasks(tx: any, workspaceId: string, taskIds: string[], lock = false) {
  const query = tx
    .select({
      id: tasks.id,
      planId: tasks.planId,
      status: tasks.status,
      date: tasks.date,
      daySegment: tasks.daySegment,
      blocked: tasks.blocked,
      estimatedMinutes: tasks.estimatedMinutes,
    })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, taskIds), isNull(tasks.archivedAt)));
  const rows = lock ? await query.orderBy(tasks.id).for("update") : await query;
  return (rows as Array<Record<string, any>>).filter((row) => taskIds.includes(String(row.id)));
}

function stateConflicts(task: Record<string, any>, operation: TaskBatchOperation) {
  const conflicts: Array<{ field: string; expected: unknown; actual: unknown }> = [];
  const actualDate = shanghaiDateKey(task.date);
  if (operation.expectedStatus !== undefined && task.status !== operation.expectedStatus) {
    conflicts.push({ field: "status", expected: operation.expectedStatus, actual: task.status });
  }
  if (operation.expectedDate !== undefined && actualDate !== operation.expectedDate) {
    conflicts.push({ field: "date", expected: operation.expectedDate, actual: actualDate });
  }
  if (operation.expectedDaySegment !== undefined && task.daySegment !== operation.expectedDaySegment) {
    conflicts.push({ field: "day_segment", expected: operation.expectedDaySegment, actual: task.daySegment });
  }
  if (operation.expectedBlocked !== undefined && Boolean(task.blocked) !== operation.expectedBlocked) {
    conflicts.push({ field: "blocked", expected: operation.expectedBlocked, actual: Boolean(task.blocked) });
  }
  if (
    operation.expectedEstimatedMinutes !== undefined &&
    task.estimatedMinutes !== operation.expectedEstimatedMinutes
  ) {
    conflicts.push({
      field: "estimated_minutes",
      expected: operation.expectedEstimatedMinutes,
      actual: task.estimatedMinutes,
    });
  }
  return conflicts;
}

function updateValues(task: Record<string, any>, operation: TaskBatchOperation) {
  const values: Record<string, unknown> = {};
  if (operation.status !== undefined && task.status !== operation.status) values.status = operation.status;
  if (operation.date !== undefined && shanghaiDateKey(task.date) !== operation.date) values.date = dateFromKey(operation.date);
  if (operation.daySegment !== undefined && task.daySegment !== operation.daySegment) values.daySegment = operation.daySegment;
  if (operation.blocked !== undefined && Boolean(task.blocked) !== operation.blocked) values.blocked = operation.blocked;
  if (operation.estimatedMinutes !== undefined && task.estimatedMinutes !== operation.estimatedMinutes) {
    values.estimatedMinutes = operation.estimatedMinutes;
  }
  return values;
}

export async function updateTasksBatch(
  db: TaskBatchDb,
  input: { workspaceId: string; idempotencyKey: string; operations: TaskBatchOperation[] },
): Promise<TaskBatchResult> {
  if (input.operations.length < 1 || input.operations.length > 50) {
    throw new McpTaskBatchError("invalid_batch", "A task batch must contain 1 to 50 operations", 400);
  }
  if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new McpTaskBatchError("invalid_batch", "Invalid batch idempotency key", 400);
  }
  for (const operation of input.operations) {
    if (!operation.taskId.trim()) {
      throw new McpTaskBatchError("invalid_batch", "Batch task IDs must not be empty", 400);
    }
    if (
      operation.status === undefined &&
      operation.date === undefined &&
      operation.daySegment === undefined &&
      operation.blocked === undefined &&
      operation.estimatedMinutes === undefined
    ) {
      throw new McpTaskBatchError(
        "invalid_batch",
        "Each batch operation must update status, date, daySegment, blocked, or estimatedMinutes",
        400,
      );
    }
  }
  const taskIds = input.operations.map((operation) => operation.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new McpTaskBatchError("invalid_batch", "Each task may appear only once in a batch", 400);
  }
  for (const operation of input.operations) {
    if (operation.date !== undefined) dateFromKey(operation.date);
    if (operation.expectedDate !== undefined) dateFromKey(operation.expectedDate);
    if (
      (operation.estimatedMinutes !== undefined &&
        (!Number.isInteger(operation.estimatedMinutes) || operation.estimatedMinutes < 5 || operation.estimatedMinutes > 480)) ||
      (operation.expectedEstimatedMinutes !== undefined &&
        (!Number.isInteger(operation.expectedEstimatedMinutes) ||
          operation.expectedEstimatedMinutes < 5 ||
          operation.expectedEstimatedMinutes > 480))
    ) {
      throw new McpTaskBatchError("invalid_batch", "Task estimates must be integers from 5 to 480 minutes", 400);
    }
  }

  const hash = requestHash(input.operations);
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .insert(mcpTaskWriteBatches)
      .values({
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        status: "started",
        resultJson: {},
      })
      .onConflictDoNothing({
        target: [mcpTaskWriteBatches.workspaceId, mcpTaskWriteBatches.idempotencyKey],
      })
      .returning();

    if (!claim) {
      const [existing] = await tx
        .select()
        .from(mcpTaskWriteBatches)
        .where(
          and(
            eq(mcpTaskWriteBatches.workspaceId, input.workspaceId),
            eq(mcpTaskWriteBatches.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing || existing.requestHash !== hash) {
        throw new McpTaskBatchError(
          "idempotency_payload_mismatch",
          "Idempotency key was already used with a different payload",
          409,
        );
      }
      const readbackRows = await readTasks(tx, input.workspaceId, taskIds);
      if (readbackRows.length !== taskIds.length) {
        throw new McpTaskBatchError("task_not_found", "One or more batch tasks no longer exist", 404);
      }
      const byId = new Map(readbackRows.map((task) => [task.id, task]));
      return {
        status: "duplicate",
        batchId: existing.id,
        idempotencyKey: input.idempotencyKey,
        completedTaskIds: taskIds,
        pendingTaskIds: [],
        readback: taskIds.map((taskId) => serializeTask(byId.get(taskId)!)),
      };
    }

    const currentRows = await readTasks(tx, input.workspaceId, taskIds, true);
    const currentById = new Map(currentRows.map((task) => [task.id, task]));
    const missingTaskIds = taskIds.filter((taskId) => !currentById.has(taskId));
    if (missingTaskIds.length > 0) {
      throw new McpTaskBatchError("task_not_found", "One or more batch tasks were not found", 404, { missingTaskIds });
    }

    const conflicts = input.operations.flatMap((operation) => {
      const task = currentById.get(operation.taskId)!;
      return stateConflicts(task, operation).map((conflict) => ({ taskId: operation.taskId, ...conflict }));
    });
    if (conflicts.length > 0) {
      throw new McpTaskBatchError("task_state_conflict", "One or more batch tasks changed before execution", 409, {
        conflicts,
      });
    }

    let changedCount = 0;
    for (const operation of input.operations) {
      const task = currentById.get(operation.taskId)!;
      const values = updateValues(task, operation);
      if (Object.keys(values).length === 0) continue;
      changedCount += 1;
      values.updatedAt = new Date();
      const updated = await tx
        .update(tasks)
        .set(values)
        .where(
          and(
            eq(tasks.id, operation.taskId),
            eq(tasks.workspaceId, input.workspaceId),
            eq(tasks.planId, task.planId),
            isNull(tasks.archivedAt),
          ),
        )
        .returning({ id: tasks.id });
      if (updated.length !== 1) {
        throw new McpTaskBatchError("task_not_found", `Task disappeared during batch: ${operation.taskId}`, 404);
      }
      await tx.insert(changeLogs).values({
        workspaceId: input.workspaceId,
        planId: task.planId,
        source: "mcp",
        summary: "Batch updated task",
        detailsJson: {
          taskId: operation.taskId,
          idempotencyKey: input.idempotencyKey,
          values: {
            status: operation.status,
            date: operation.date,
            daySegment: operation.daySegment,
            blocked: operation.blocked,
            estimatedMinutes: operation.estimatedMinutes,
          },
        },
      });
    }

    const readbackRows = await readTasks(tx, input.workspaceId, taskIds);
    if (readbackRows.length !== taskIds.length) {
      throw new McpTaskBatchError("task_not_found", "Batch readback was incomplete", 404);
    }
    const readbackById = new Map(readbackRows.map((task) => [task.id, task]));
    const result: TaskBatchResult = {
      status: changedCount > 0 ? "succeeded" : "no_change",
      batchId: claim.id,
      idempotencyKey: input.idempotencyKey,
      completedTaskIds: taskIds,
      pendingTaskIds: [],
      readback: taskIds.map((taskId) => serializeTask(readbackById.get(taskId)!)),
    };
    await tx
      .update(mcpTaskWriteBatches)
      .set({ status: result.status, resultJson: result, updatedAt: new Date() })
      .where(and(eq(mcpTaskWriteBatches.id, claim.id), eq(mcpTaskWriteBatches.workspaceId, input.workspaceId)));
    return result;
  });
}
