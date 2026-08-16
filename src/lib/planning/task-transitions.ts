import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { changeLogs, planOperations, tasks } from "@/lib/db/schema";
import { ActivePlanError, resolveActivePlanContext } from "@/lib/planning/active-plan";

type TransitionDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

type DaySegment = "morning" | "afternoon" | "evening";
type TransitionAction = "reschedule_backlog" | "restore_archived_to_backlog" | "move_legacy_skipped_to_backlog";

type TaskReadback = {
  id: string;
  status: "todo" | "done" | "skipped" | "backlog";
  date: string;
  daySegment: DaySegment;
  archivedAt: string | null;
  updatedAt: string;
};

export type TaskTransitionResult = {
  status: "succeeded" | "duplicate";
  originalStatus?: "succeeded";
  operationId: string;
  idempotencyKey: string;
  action: TransitionAction;
  task: TaskReadback;
  readback: {
    verification: "succeeded";
    task: TaskReadback;
    counts: { todo: number; backlog: number; archived: number };
  };
};

export class TaskTransitionError extends Error {
  constructor(
    public code:
      | "invalid_date"
      | "invalid_idempotency_key"
      | "invalid_request"
      | "active_plan_missing"
      | "task_not_found"
      | "task_state_conflict"
      | "idempotency_payload_mismatch"
      | "operation_in_progress"
      | "operation_failed",
    message: string,
    public status = 400,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function operationKind(action: TransitionAction) {
  if (action === "reschedule_backlog") return "reschedule_backlog_task";
  if (action === "restore_archived_to_backlog") return "restore_archived_task";
  return "restore_legacy_skipped_task";
}

function stableHash(value: unknown) {
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (!input || typeof input !== "object" || input instanceof Date) return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sort(item)]),
    );
  }
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

function parseDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TaskTransitionError("invalid_date", "A specific task date is required", 400);
  }
  const date = new Date(`${value}T00:00:00.000+08:00`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (Number.isNaN(date.getTime()) || formatter.format(date) !== value) {
    throw new TaskTransitionError("invalid_date", "Invalid task date", 400);
  }
  return date;
}

function dateKey(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function serializeTask(task: {
  id: string;
  status: TaskReadback["status"];
  date: Date;
  daySegment: DaySegment;
  archivedAt: Date | null;
  updatedAt: Date;
}): TaskReadback {
  return {
    id: task.id,
    status: task.status,
    date: dateKey(task.date),
    daySegment: task.daySegment,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    updatedAt: task.updatedAt.toISOString(),
  };
}

function validateIdempotencyKey(value: string) {
  if (value.trim().length < 8 || value.length > 200) {
    throw new TaskTransitionError("invalid_idempotency_key", "Invalid idempotency key", 400);
  }
}

async function readTaskSurface(tx: any, workspaceId: string, planId: string, taskId: string) {
  const rows = await tx
    .select({
      id: tasks.id,
      status: tasks.status,
      date: tasks.date,
      daySegment: tasks.daySegment,
      archivedAt: tasks.archivedAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId)));
  const task = rows.find((row: { id: string }) => row.id === taskId);
  if (!task) throw new TaskTransitionError("task_not_found", "Task not found", 404);
  const active = rows.filter((row: { archivedAt: Date | null }) => row.archivedAt === null);
  return {
    task: serializeTask(task),
    counts: {
      todo: active.filter((row: { status: string }) => row.status === "todo").length,
      backlog: active.filter((row: { status: string }) => row.status === "backlog").length,
      archived: rows.length - active.length,
    },
  };
}

async function runTransition(
  db: TransitionDb,
  input: {
    workspaceId: string;
    taskId: string;
    action: TransitionAction;
    idempotencyKey: string;
    request: Record<string, unknown>;
    apply: (tx: any, task: any, now: Date) => Promise<void>;
    now?: Date;
  },
): Promise<TaskTransitionResult> {
  validateIdempotencyKey(input.idempotencyKey);
  const requestHash = stableHash({ action: input.action, taskId: input.taskId, ...input.request });
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    let plan;
    try {
      plan = await resolveActivePlanContext(tx, input.workspaceId, { lock: true });
    } catch (error) {
      if (error instanceof ActivePlanError && error.code === "active_plan_missing") {
        throw new TaskTransitionError("active_plan_missing", "No active plan", 409);
      }
      throw error;
    }

    const [claimed] = await tx
      .insert(planOperations)
      .values({
        workspaceId: input.workspaceId,
        planId: plan.id,
        operationKind: operationKind(input.action),
        idempotencyKey: input.idempotencyKey,
        requestHash,
        status: "started",
        resultJson: {},
      })
      .onConflictDoNothing({ target: [planOperations.workspaceId, planOperations.idempotencyKey] })
      .returning({ id: planOperations.id });

    if (!claimed) {
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
      if (!existing || existing.requestHash !== requestHash) {
        throw new TaskTransitionError(
          "idempotency_payload_mismatch",
          "Idempotency key was already used with a different request",
          409,
        );
      }
      if (existing.status === "succeeded") {
        return {
          ...(existing.resultJson as TaskTransitionResult),
          status: "duplicate",
          originalStatus: "succeeded",
        };
      }
      if (existing.status === "failed") {
        throw new TaskTransitionError("operation_failed", "The original task transition failed", 409, {
          operationId: existing.id,
          error: existing.errorJson,
        });
      }
      throw new TaskTransitionError("operation_in_progress", "Task transition is still in progress", 409, {
        operationId: existing.id,
      });
    }

    let taskQuery = tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.planId, plan.id),
          eq(tasks.id, input.taskId),
        ),
      )
      .limit(1);
    if (typeof taskQuery.for === "function") taskQuery = taskQuery.for("update");
    const [task] = await taskQuery;
    if (!task || task.workspaceId !== input.workspaceId || task.planId !== plan.id) {
      throw new TaskTransitionError("task_not_found", "Task not found", 404);
    }

    const before = serializeTask(task);
    await input.apply(tx, task, now);
    const readback = await readTaskSurface(tx, input.workspaceId, plan.id, input.taskId);
    const result: TaskTransitionResult = {
      status: "succeeded",
      operationId: claimed.id,
      idempotencyKey: input.idempotencyKey,
      action: input.action,
      task: readback.task,
      readback: { verification: "succeeded", ...readback },
    };

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId: plan.id,
      source: "manual",
      summary: input.action === "reschedule_backlog"
        ? "Rescheduled backlog task"
        : input.action === "restore_archived_to_backlog"
          ? "Restored archived task to backlog"
          : "Moved legacy skipped task to backlog",
      detailsJson: {
        operationId: claimed.id,
        idempotencyKey: input.idempotencyKey,
        taskId: input.taskId,
        action: input.action,
        before,
        after: readback.task,
      },
    });
    await tx
      .update(planOperations)
      .set({ status: "succeeded", resultJson: result, errorJson: null, updatedAt: now })
      .where(and(eq(planOperations.id, claimed.id), eq(planOperations.workspaceId, input.workspaceId)));

    return result;
  });
}

export async function rescheduleBacklogTask(
  db: TransitionDb,
  input: {
    workspaceId: string;
    taskId: string;
    date: string;
    daySegment?: DaySegment;
    idempotencyKey: string;
    now?: Date;
  },
) {
  const date = parseDateKey(input.date);
  return runTransition(db, {
    ...input,
    action: "reschedule_backlog",
    request: { date: input.date, daySegment: input.daySegment ?? null },
    apply: async (tx, task, now) => {
      if (task.archivedAt !== null || task.status !== "backlog") {
        throw new TaskTransitionError(
          "task_state_conflict",
          "Only an active backlog task can be rescheduled",
          409,
          { actualStatus: task.status, archived: task.archivedAt !== null },
        );
      }
      const [updated] = await tx
        .update(tasks)
        .set({
          status: "todo",
          date,
          ...(input.daySegment ? { daySegment: input.daySegment } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.workspaceId, input.workspaceId),
            eq(tasks.planId, task.planId),
            eq(tasks.status, "backlog"),
          ),
        )
        .returning({ id: tasks.id });
      if (!updated) throw new TaskTransitionError("task_state_conflict", "Task changed before rescheduling", 409);
    },
  });
}

export async function restoreArchivedTaskToBacklog(
  db: TransitionDb,
  input: {
    workspaceId: string;
    taskId: string;
    expectedArchived: true;
    idempotencyKey: string;
    now?: Date;
  },
) {
  return runTransition(db, {
    ...input,
    action: "restore_archived_to_backlog",
    request: { expectedArchived: input.expectedArchived },
    apply: async (tx, task, now) => {
      if (input.expectedArchived !== true || task.archivedAt === null) {
        throw new TaskTransitionError(
          "task_state_conflict",
          "Task is not in the expected archived state",
          409,
          { expectedArchived: true, actualArchived: task.archivedAt !== null },
        );
      }
      const [updated] = await tx
        .update(tasks)
        .set({ status: "backlog", archivedAt: null, updatedAt: now })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.workspaceId, input.workspaceId),
            eq(tasks.planId, task.planId),
            eq(tasks.archivedAt, task.archivedAt),
          ),
        )
        .returning({ id: tasks.id });
      if (!updated) throw new TaskTransitionError("task_state_conflict", "Task changed before restoration", 409);
    },
  });
}

export async function moveLegacySkippedTaskToBacklog(
  db: TransitionDb,
  input: {
    workspaceId: string;
    taskId: string;
    expectedStatus: "skipped";
    idempotencyKey: string;
    now?: Date;
  },
) {
  return runTransition(db, {
    ...input,
    action: "move_legacy_skipped_to_backlog",
    request: { expectedStatus: input.expectedStatus },
    apply: async (tx, task, now) => {
      if (input.expectedStatus !== "skipped" || task.archivedAt !== null || task.status !== "skipped") {
        throw new TaskTransitionError(
          "task_state_conflict",
          "Task is not in the expected legacy skipped state",
          409,
          { expectedStatus: "skipped", actualStatus: task.status, archived: task.archivedAt !== null },
        );
      }
      const [updated] = await tx
        .update(tasks)
        .set({ status: "backlog", updatedAt: now })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.workspaceId, input.workspaceId),
            eq(tasks.planId, task.planId),
            eq(tasks.status, "skipped"),
          ),
        )
        .returning({ id: tasks.id });
      if (!updated) throw new TaskTransitionError("task_state_conflict", "Task changed before restoration", 409);
    },
  });
}

export type LegacyTaskTriageDecision = {
  taskId: string;
  decision: "backlog" | "archive";
};

export type LegacyTaskTriageResult = {
  status: "succeeded" | "duplicate";
  originalStatus?: "succeeded";
  operationId: string;
  idempotencyKey: string;
  processedCount: number;
  movedToBacklog: { count: number; taskIds: string[] };
  archived: { count: number; taskIds: string[] };
  readback: {
    verification: "succeeded";
    legacySkippedRemaining: number;
    backlogCount: number;
    archivedCount: number;
  };
};

export async function triageLegacySkippedTasks(
  db: TransitionDb,
  input: {
    workspaceId: string;
    decisions: LegacyTaskTriageDecision[];
    confirmCount: number;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<LegacyTaskTriageResult> {
  validateIdempotencyKey(input.idempotencyKey);
  if (input.decisions.length < 1 || input.decisions.length > 200 || input.confirmCount !== input.decisions.length) {
    throw new TaskTransitionError("invalid_request", "Confirmed task count does not match the selected tasks", 400);
  }
  const taskIds = input.decisions.map((decision) => decision.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TaskTransitionError("invalid_request", "Each task can only be classified once", 400);
  }

  const canonicalDecisions = [...input.decisions].sort((left, right) => left.taskId.localeCompare(right.taskId));
  const requestHash = stableHash({ action: "triage_legacy_skipped_tasks", decisions: canonicalDecisions });
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    let plan;
    try {
      plan = await resolveActivePlanContext(tx, input.workspaceId, { lock: true });
    } catch (error) {
      if (error instanceof ActivePlanError && error.code === "active_plan_missing") {
        throw new TaskTransitionError("active_plan_missing", "No active plan", 409);
      }
      throw error;
    }

    const [claimed] = await tx
      .insert(planOperations)
      .values({
        workspaceId: input.workspaceId,
        planId: plan.id,
        operationKind: "triage_legacy_skipped_tasks",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        status: "started",
        resultJson: {},
      })
      .onConflictDoNothing({ target: [planOperations.workspaceId, planOperations.idempotencyKey] })
      .returning({ id: planOperations.id });

    if (!claimed) {
      const [existing] = await tx
        .select()
        .from(planOperations)
        .where(and(
          eq(planOperations.workspaceId, input.workspaceId),
          eq(planOperations.idempotencyKey, input.idempotencyKey),
        ))
        .limit(1)
        .for("update");
      if (!existing || existing.requestHash !== requestHash) {
        throw new TaskTransitionError(
          "idempotency_payload_mismatch",
          "Idempotency key was already used with a different request",
          409,
        );
      }
      if (existing.status === "succeeded") {
        return {
          ...(existing.resultJson as LegacyTaskTriageResult),
          status: "duplicate",
          originalStatus: "succeeded",
        };
      }
      if (existing.status === "failed") {
        throw new TaskTransitionError("operation_failed", "The original task triage failed", 409, {
          operationId: existing.id,
          error: existing.errorJson,
        });
      }
      throw new TaskTransitionError("operation_in_progress", "Task triage is still in progress", 409, {
        operationId: existing.id,
      });
    }

    let selectedQuery = tx
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.workspaceId, input.workspaceId),
        eq(tasks.planId, plan.id),
        inArray(tasks.id, taskIds),
      ));
    if (typeof selectedQuery.for === "function") selectedQuery = selectedQuery.for("update");
    const selectedTasks = await selectedQuery;
    const selectedById = new Map(selectedTasks.map((task: { id: string }) => [task.id, task]));
    const conflicts = taskIds.filter((taskId) => {
      const task = selectedById.get(taskId) as { status?: string; archivedAt?: Date | null } | undefined;
      return !task || task.status !== "skipped" || task.archivedAt !== null;
    });
    if (conflicts.length > 0) {
      throw new TaskTransitionError(
        "task_state_conflict",
        "Some selected tasks are no longer waiting to be organized",
        409,
        { taskIds: conflicts },
      );
    }

    const backlogTaskIds = input.decisions
      .filter((decision) => decision.decision === "backlog")
      .map((decision) => decision.taskId);
    const archivedTaskIds = input.decisions
      .filter((decision) => decision.decision === "archive")
      .map((decision) => decision.taskId);

    if (backlogTaskIds.length > 0) {
      const updated = await tx
        .update(tasks)
        .set({ status: "backlog", updatedAt: now })
        .where(and(
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.planId, plan.id),
          eq(tasks.status, "skipped"),
          isNull(tasks.archivedAt),
          inArray(tasks.id, backlogTaskIds),
        ))
        .returning({ id: tasks.id });
      if (updated.length !== backlogTaskIds.length) {
        throw new TaskTransitionError("task_state_conflict", "Some tasks changed before they could be restored", 409);
      }
    }

    if (archivedTaskIds.length > 0) {
      const updated = await tx
        .update(tasks)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.planId, plan.id),
          eq(tasks.status, "skipped"),
          isNull(tasks.archivedAt),
          inArray(tasks.id, archivedTaskIds),
        ))
        .returning({ id: tasks.id });
      if (updated.length !== archivedTaskIds.length) {
        throw new TaskTransitionError("task_state_conflict", "Some tasks changed before they could be archived", 409);
      }
    }

    const taskSurface = await tx
      .select({ id: tasks.id, status: tasks.status, archivedAt: tasks.archivedAt })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.planId, plan.id)));
    const result: LegacyTaskTriageResult = {
      status: "succeeded",
      operationId: claimed.id,
      idempotencyKey: input.idempotencyKey,
      processedCount: input.decisions.length,
      movedToBacklog: { count: backlogTaskIds.length, taskIds: backlogTaskIds },
      archived: { count: archivedTaskIds.length, taskIds: archivedTaskIds },
      readback: {
        verification: "succeeded",
        legacySkippedRemaining: taskSurface.filter(
          (task: { status: string; archivedAt: Date | null }) => task.status === "skipped" && task.archivedAt === null,
        ).length,
        backlogCount: taskSurface.filter(
          (task: { status: string; archivedAt: Date | null }) => task.status === "backlog" && task.archivedAt === null,
        ).length,
        archivedCount: taskSurface.filter((task: { archivedAt: Date | null }) => task.archivedAt !== null).length,
      },
    };

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId: plan.id,
      source: "manual",
      summary: "Organized legacy skipped tasks",
      detailsJson: {
        operationId: claimed.id,
        idempotencyKey: input.idempotencyKey,
        movedToBacklog: backlogTaskIds,
        archived: archivedTaskIds,
        readback: result.readback,
      },
    });
    await tx
      .update(planOperations)
      .set({ status: "succeeded", resultJson: result, errorJson: null, updatedAt: now })
      .where(and(eq(planOperations.id, claimed.id), eq(planOperations.workspaceId, input.workspaceId)));

    return result;
  });
}
