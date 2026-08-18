import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { consumeOperationApproval, createOperationApproval } from "@/lib/approvals/service";
import { changeLogs, planOperations, tasks } from "@/lib/db/schema";
import { stableHash } from "@/lib/mcp/task-batch-preview";
import { resolveActivePlanContext } from "@/lib/planning/active-plan";

const operationKind = "task_notes_batch";
const proposalOperationKind = "propose_task_notes_batch";
const tokenTtlMs = 24 * 60 * 60 * 1000;

type NotesOperation = { taskId: string; notes: string };
export type TaskNotesPreviewOperation = {
  taskId: string;
  title: string;
  beforeNotes: string | null;
  beforeUpdatedAt: string;
  afterNotes: string;
};

type PreviewPayload = {
  version: 1;
  kind: typeof operationKind;
  workspaceId: string;
  planId: string;
  requestHash: string;
  operations: TaskNotesPreviewOperation[];
  expiresAt: string;
};

type NotesBatchDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
};

export class TaskNotesBatchError extends Error {
  constructor(
    public code:
      | "invalid_notes_batch"
      | "task_not_found"
      | "preview_required"
      | "preview_invalid"
      | "preview_expired"
      | "preview_stale"
      | "idempotency_payload_mismatch"
      | "operation_in_progress"
      | "transaction_readback_failed",
    message: string,
    public status = 409,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error("APP_SECRET is required");
  return secret;
}

function sign(payload: string) {
  return createHmac("sha256", appSecret()).update(payload).digest("base64url");
}

function signaturesMatch(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestHash(operations: TaskNotesPreviewOperation[]) {
  return stableHash(operations.map((operation) => ({
    taskId: operation.taskId,
    beforeNotes: operation.beforeNotes,
    beforeUpdatedAt: operation.beforeUpdatedAt,
    afterNotes: operation.afterNotes,
  })));
}

export function createTaskNotesPreviewToken(input: {
  workspaceId: string;
  planId: string;
  operations: TaskNotesPreviewOperation[];
  now: Date;
}) {
  const body: PreviewPayload = {
    version: 1,
    kind: operationKind,
    workspaceId: input.workspaceId,
    planId: input.planId,
    requestHash: requestHash(input.operations),
    operations: input.operations,
    expiresAt: new Date(input.now.getTime() + tokenTtlMs).toISOString(),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, payload: body };
}

export function verifyTaskNotesPreviewToken(input: { token: string | undefined; workspaceId: string; now: Date }) {
  if (!input.token) {
    throw new TaskNotesBatchError("preview_required", "Task notes batch Preview token required");
  }
  const [payload, signature] = input.token.split(".");
  if (!payload || !signature || !signaturesMatch(signature, sign(payload))) {
    throw new TaskNotesBatchError("preview_invalid", "Invalid task notes batch Preview token");
  }

  let body: PreviewPayload;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PreviewPayload;
  } catch {
    throw new TaskNotesBatchError("preview_invalid", "Invalid task notes batch Preview token");
  }
  if (
    body.version !== 1 ||
    body.kind !== operationKind ||
    body.workspaceId !== input.workspaceId ||
    typeof body.planId !== "string" ||
    typeof body.requestHash !== "string" ||
    !Array.isArray(body.operations) ||
    body.operations.length < 1 ||
    body.operations.length > 50 ||
    body.operations.some((operation) =>
      !operation ||
      typeof operation.taskId !== "string" ||
      typeof operation.title !== "string" ||
      (operation.beforeNotes !== null && typeof operation.beforeNotes !== "string") ||
      typeof operation.beforeUpdatedAt !== "string" ||
      typeof operation.afterNotes !== "string"
    ) ||
    new Set(body.operations.map((operation) => operation.taskId)).size !== body.operations.length ||
    requestHash(body.operations) !== body.requestHash ||
    typeof body.expiresAt !== "string"
  ) {
    throw new TaskNotesBatchError("preview_invalid", "Task notes batch Preview token does not match this operation");
  }
  const expiresAt = new Date(body.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= input.now) {
    throw new TaskNotesBatchError("preview_expired", "Task notes batch Preview token expired");
  }
  return body;
}

function normalizeOperations(operations: NotesOperation[]) {
  if (operations.length < 1 || operations.length > 50) {
    throw new TaskNotesBatchError("invalid_notes_batch", "A task notes batch must contain 1 to 50 operations", 400);
  }
  const normalized = operations.map((operation) => ({
    taskId: operation.taskId.trim(),
    notes: operation.notes.trim(),
  }));
  if (normalized.some((operation) => !operation.taskId || operation.notes.length < 1 || operation.notes.length > 2000)) {
    throw new TaskNotesBatchError("invalid_notes_batch", "Each operation needs a task ID and 1 to 2000 note characters", 400);
  }
  if (new Set(normalized.map((operation) => operation.taskId)).size !== normalized.length) {
    throw new TaskNotesBatchError("invalid_notes_batch", "Each task may appear only once in a notes batch", 400);
  }
  return normalized.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

async function readExactTasks(
  db: Pick<NotesBatchDb, "select">,
  workspaceId: string,
  planId: string,
  taskIds: string[],
  lock = false,
) {
  let query = db
    .select({
      id: tasks.id,
      planId: tasks.planId,
      title: tasks.title,
      notes: tasks.notes,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.planId, planId),
      inArray(tasks.id, taskIds),
      isNull(tasks.archivedAt),
    ))
    .orderBy(tasks.id);
  if (lock && typeof query.for === "function") query = query.for("update");
  return await query as Array<{
    id: string;
    planId: string;
    title: string;
    notes: string | null;
    updatedAt: Date;
  }>;
}

function noteChanges(operations: TaskNotesPreviewOperation[]) {
  return operations.map((operation) => ({
    taskId: operation.taskId,
    title: operation.title,
    before: operation.beforeNotes,
    after: operation.afterNotes,
  }));
}

export async function proposeTaskNotesBatch(
  db: NotesBatchDb,
  input: {
    workspaceId: string;
    idempotencyKey: string;
    operations: NotesOperation[];
    reason?: string;
    now?: Date;
  },
) {
  if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new TaskNotesBatchError("invalid_notes_batch", "Invalid notes proposal idempotency key", 400);
  }
  const now = input.now ?? new Date();
  const normalized = normalizeOperations(input.operations);
  const reason = input.reason?.trim();
  const proposalHash = stableHash({ operations: normalized, reason: reason ?? null });

  return db.transaction(async (tx) => {
    const plan = await resolveActivePlanContext(tx, input.workspaceId);
    const [claim] = await tx
      .insert(planOperations)
      .values({
        workspaceId: input.workspaceId,
        planId: plan.id,
        operationKind: proposalOperationKind,
        idempotencyKey: input.idempotencyKey,
        requestHash: proposalHash,
        status: "started",
        resultJson: {},
      })
      .onConflictDoNothing({ target: [planOperations.workspaceId, planOperations.idempotencyKey] })
      .returning();
    if (!claim) {
      const [existing] = await tx
        .select()
        .from(planOperations)
        .where(and(
          eq(planOperations.workspaceId, input.workspaceId),
          eq(planOperations.idempotencyKey, input.idempotencyKey),
        ))
        .limit(1)
        .for("update");
      if (!existing || existing.operationKind !== proposalOperationKind || existing.requestHash !== proposalHash) {
        throw new TaskNotesBatchError(
          "idempotency_payload_mismatch",
          "Idempotency key was used with a different task notes proposal",
        );
      }
      if (existing.status === "started") {
        throw new TaskNotesBatchError("operation_in_progress", "Task notes proposal is still in progress");
      }
      const stored = existing.resultJson && typeof existing.resultJson === "object"
        ? existing.resultJson as Record<string, unknown>
        : {};
      return { ...stored, status: "duplicate" as const, originalStatus: existing.status };
    }

    const taskIds = normalized.map((operation) => operation.taskId);
    const rows = await readExactTasks(tx, input.workspaceId, plan.id, taskIds);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const missingTaskIds = taskIds.filter((taskId) => !rowById.has(taskId));
    if (missingTaskIds.length > 0) {
      throw new TaskNotesBatchError("task_not_found", "One or more tasks were not found in the active plan", 404, {
        missingTaskIds,
      });
    }

    const unchangedTaskIds: string[] = [];
    const previewOperations = normalized.flatMap((operation): TaskNotesPreviewOperation[] => {
      const row = rowById.get(operation.taskId)!;
      if (row.notes === operation.notes) {
        unchangedTaskIds.push(operation.taskId);
        return [];
      }
      return [{
        taskId: row.id,
        title: row.title,
        beforeNotes: row.notes,
        beforeUpdatedAt: row.updatedAt.toISOString(),
        afterNotes: operation.notes,
      }];
    });
    if (previewOperations.length === 0) {
      const result = {
        status: "no_change" as const,
        count: 0,
        unchangedTaskIds,
        liveUnchanged: true,
      };
      await tx
        .update(planOperations)
        .set({ status: "no_change", resultJson: result, updatedAt: now })
        .where(and(eq(planOperations.id, claim.id), eq(planOperations.workspaceId, input.workspaceId)));
      return result;
    }

    const preview = createTaskNotesPreviewToken({
      workspaceId: input.workspaceId,
      planId: plan.id,
      operations: previewOperations,
      now,
    });
    const approval = await createOperationApproval(tx, {
      workspaceId: input.workspaceId,
      operationKind,
      requestHash: preview.payload.requestHash,
      previewToken: preview.token,
      expiresAt: new Date(preview.payload.expiresAt),
      summary: {
        title: "批量更新任务详情",
        description: reason ?? "逐条核对修改前后内容；批准后整批应用，不支持部分批准。",
        count: previewOperations.length,
        items: previewOperations.map((operation) =>
          `${operation.title}：${operation.beforeNotes ?? "（无）"} → ${operation.afterNotes}`
        ),
        noteChanges: noteChanges(previewOperations),
      },
    });
    const result = {
      status: "draft_created" as const,
      planId: plan.id,
      count: previewOperations.length,
      unchangedTaskIds,
      approvalId: approval.id,
      previewToken: preview.token,
      expiresAt: preview.payload.expiresAt,
      changes: noteChanges(previewOperations),
      liveUnchanged: true,
    };
    await tx
      .update(planOperations)
      .set({ status: "succeeded", resultJson: result, updatedAt: now })
      .where(and(eq(planOperations.id, claim.id), eq(planOperations.workspaceId, input.workspaceId)));
    return result;
  });
}

function transactionReadback(rows: Array<{ id: string; notes: string | null; updatedAt: Date }>, operations: TaskNotesPreviewOperation[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const mismatches = operations.flatMap((operation) => {
    const row = byId.get(operation.taskId);
    return !row || row.notes !== operation.afterNotes ? [operation.taskId] : [];
  });
  if (mismatches.length > 0) {
    throw new TaskNotesBatchError(
      "transaction_readback_failed",
      "Task notes transaction readback did not match the approved Preview",
      500,
      { taskIds: mismatches },
    );
  }
  return operations.map((operation) => {
    const row = byId.get(operation.taskId)!;
    return { id: row.id, notes: row.notes!, updatedAt: row.updatedAt.toISOString() };
  });
}

function duplicateResult(operation: typeof planOperations.$inferSelect) {
  const stored = operation.resultJson && typeof operation.resultJson === "object"
    ? operation.resultJson as Record<string, unknown>
    : {};
  return {
    ...stored,
    status: "duplicate" as const,
    originalStatus: operation.status,
    operationId: operation.id,
    mutationApplied: operation.status === "succeeded",
  };
}

async function externalReadback(
  db: Pick<NotesBatchDb, "select">,
  input: { workspaceId: string; planId: string; operations: TaskNotesPreviewOperation[] },
) {
  const rows = await readExactTasks(
    db,
    input.workspaceId,
    input.planId,
    input.operations.map((operation) => operation.taskId),
  );
  return transactionReadback(rows, input.operations);
}

export async function attachTaskNotesPostCommitReadback<T extends {
  status: "succeeded" | "duplicate";
  originalStatus?: string;
}>(
  committed: T,
  readback: () => Promise<Array<{ id: string; notes: string; updatedAt: string }>>,
) {
  try {
    return {
      ...committed,
      postCommitReadback: { verification: "succeeded" as const, tasks: await readback() },
    };
  } catch (error) {
    const persistedStatus = committed.status === "duplicate"
      ? committed.originalStatus ?? "succeeded"
      : committed.status;
    return {
      ...committed,
      status: "applied_with_readback_error" as const,
      persistedStatus,
      mutationApplied: persistedStatus === "succeeded",
      postCommitReadback: {
        verification: "failed" as const,
        error: { code: "readback_failed" as const, message: error instanceof Error ? error.message : "Readback failed" },
      },
      warnings: [{
        code: "readback_failed" as const,
        message: "Task notes were committed, but the post-commit readback failed",
        mutationApplied: persistedStatus === "succeeded",
      }],
    };
  }
}

export async function applyTaskNotesBatch(
  db: NotesBatchDb,
  input: {
    workspaceId: string;
    previewToken: string | undefined;
    approvalId: string | undefined;
    idempotencyKey: string;
    now?: Date;
  },
) {
  if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new TaskNotesBatchError("invalid_notes_batch", "Invalid notes batch idempotency key", 400);
  }
  const now = input.now ?? new Date();
  const preview = verifyTaskNotesPreviewToken({ token: input.previewToken, workspaceId: input.workspaceId, now });

  const committed = await db.transaction(async (tx) => {
    const [claim] = await tx
      .insert(planOperations)
      .values({
        workspaceId: input.workspaceId,
        planId: preview.planId,
        operationKind,
        idempotencyKey: input.idempotencyKey,
        requestHash: preview.requestHash,
        status: "started",
        resultJson: {},
      })
      .onConflictDoNothing({ target: [planOperations.workspaceId, planOperations.idempotencyKey] })
      .returning();
    if (!claim) {
      const [existing] = await tx
        .select()
        .from(planOperations)
        .where(and(
          eq(planOperations.workspaceId, input.workspaceId),
          eq(planOperations.idempotencyKey, input.idempotencyKey),
        ))
        .limit(1)
        .for("update");
      if (!existing || existing.operationKind !== operationKind || existing.requestHash !== preview.requestHash) {
        throw new TaskNotesBatchError(
          "idempotency_payload_mismatch",
          "Idempotency key was used with a different task notes batch",
        );
      }
      if (existing.status === "started") {
        throw new TaskNotesBatchError("operation_in_progress", "Task notes batch is still in progress");
      }
      return duplicateResult(existing);
    }

    const plan = await resolveActivePlanContext(tx, input.workspaceId, { lock: true });
    if (plan.id !== preview.planId) {
      throw new TaskNotesBatchError("preview_stale", "Active plan changed after the task notes Preview");
    }
    const taskIds = preview.operations.map((operation) => operation.taskId);
    const rows = await readExactTasks(tx, input.workspaceId, preview.planId, taskIds, true);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const conflicts = preview.operations.flatMap((operation) => {
      const row = byId.get(operation.taskId);
      if (!row) return [{ taskId: operation.taskId, field: "task", expected: "present", actual: "missing" }];
      const fields: Array<{ taskId: string; field: string; expected: unknown; actual: unknown }> = [];
      if (row.notes !== operation.beforeNotes) {
        fields.push({ taskId: operation.taskId, field: "notes", expected: operation.beforeNotes, actual: row.notes });
      }
      if (row.updatedAt.toISOString() !== operation.beforeUpdatedAt) {
        fields.push({
          taskId: operation.taskId,
          field: "updatedAt",
          expected: operation.beforeUpdatedAt,
          actual: row.updatedAt.toISOString(),
        });
      }
      return fields;
    });
    if (conflicts.length > 0) {
      throw new TaskNotesBatchError(
        "preview_stale",
        "One or more tasks changed after the task notes Preview; no notes were written",
        409,
        { conflicts },
      );
    }

    await consumeOperationApproval(tx, {
      workspaceId: input.workspaceId,
      approvalId: input.approvalId,
      operationKind,
      requestHash: preview.requestHash,
      previewToken: input.previewToken!,
      now,
    });

    for (const operation of preview.operations) {
      const updated = await tx
        .update(tasks)
        .set({ notes: operation.afterNotes, updatedAt: now })
        .where(and(
          eq(tasks.id, operation.taskId),
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.planId, preview.planId),
          isNull(tasks.archivedAt),
        ))
        .returning({ id: tasks.id });
      if (updated.length !== 1) {
        throw new TaskNotesBatchError("preview_stale", `Task ${operation.taskId} changed before write`);
      }
      await tx.insert(changeLogs).values({
        workspaceId: input.workspaceId,
        planId: preview.planId,
        source: "mcp",
        summary: "Approved batch updated task notes",
        detailsJson: {
          operationId: claim.id,
          approvalId: input.approvalId,
          idempotencyKey: input.idempotencyKey,
          taskId: operation.taskId,
          beforeNotes: operation.beforeNotes,
          afterNotes: operation.afterNotes,
        },
      });
    }

    const readbackRows = await readExactTasks(tx, input.workspaceId, preview.planId, taskIds);
    const readback = transactionReadback(readbackRows, preview.operations);
    const result = {
      status: "succeeded" as const,
      operationId: claim.id,
      approvalId: input.approvalId!,
      idempotencyKey: input.idempotencyKey,
      processedCount: preview.operations.length,
      taskIds,
      readback,
      mutationApplied: true as const,
    };
    await tx
      .update(planOperations)
      .set({ status: "succeeded", resultJson: result, updatedAt: now })
      .where(and(eq(planOperations.id, claim.id), eq(planOperations.workspaceId, input.workspaceId)));
    return result;
  });

  return attachTaskNotesPostCommitReadback(committed, () => externalReadback(db, {
      workspaceId: input.workspaceId,
      planId: preview.planId,
      operations: preview.operations,
    }));
}
