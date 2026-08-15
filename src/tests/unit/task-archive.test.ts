import { createHash } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applyTaskArchiveBatch,
  attachTaskBatchPostCommitReadback,
  McpTaskArchiveError,
  previewTaskBatch,
} from "@/lib/mcp/task-archive";
import {
  createTaskBatchPreviewToken,
  stableHash,
  verifyTaskBatchPreviewToken,
  type TaskBatchFingerprintRow,
} from "@/lib/mcp/task-batch-preview";

type Row = Record<string, any>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createDb(options: { task?: Partial<Row>; patches?: Row[] } = {}) {
  let state = {
    plans: [{ id: "22222222-2222-4222-8222-222222222222", workspaceId: "workspace-1", status: "active" }],
    tasks: [{
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "workspace-1",
      planId: "22222222-2222-4222-8222-222222222222",
      title: "Write methods",
      status: "todo",
      date: new Date("2026-08-15T16:00:00.000Z"),
      projectId: null,
      milestoneId: null,
      parentTaskId: null,
      estimatedMinutes: 60,
      archivedAt: null,
      updatedAt: new Date("2026-08-16T00:00:00.000Z"),
      ...options.task,
    }],
    patches: options.patches ?? [],
    operations: [] as Row[],
    approvals: [] as Row[],
    changeLogs: [] as Row[],
  };

  function name(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function connection(draft: typeof state) {
    return {
      select() {
        return {
          from(table: unknown) {
            const tableName = name(table);
            const rows = tableName === "plans"
              ? draft.plans
              : tableName === "tasks"
                ? draft.tasks
                : tableName === "agent_patches"
                  ? draft.patches
                : tableName === "plan_operations"
                    ? [...draft.operations].reverse()
                    : tableName === "operation_approvals"
                      ? [...draft.approvals].reverse()
                    : [];
            return {
              where() {
                const result = {
                  orderBy() {
                    return {
                      limit(count: number) {
                        return Promise.resolve(rows.slice(0, count));
                      },
                      for() {
                        return Promise.resolve(rows);
                      },
                      then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
                        return Promise.resolve(rows).then(resolve, reject);
                      },
                    };
                  },
                  limit(count: number) {
                    return {
                      for() {
                        return Promise.resolve(rows.slice(0, count));
                      },
                      then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
                        return Promise.resolve(rows.slice(0, count)).then(resolve, reject);
                      },
                    };
                  },
                  then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
                    return Promise.resolve(rows).then(resolve, reject);
                  },
                };
                return result;
              },
            };
          },
        };
      },
      insert(table: unknown) {
        const tableName = name(table);
        return {
          values(values: Row) {
            if (tableName === "change_logs") {
              draft.changeLogs.push(values);
              return Promise.resolve();
            }
            if (tableName === "operation_approvals") {
              return {
                returning() {
                  const approval = { id: `approval-${draft.approvals.length + 1}`, ...values };
                  draft.approvals.push(approval);
                  return Promise.resolve([approval]);
                },
              };
            }
            return {
              onConflictDoNothing() {
                return {
                  returning() {
                    const existing = draft.operations.find(
                      (row) => row.workspaceId === values.workspaceId && row.idempotencyKey === values.idempotencyKey,
                    );
                    if (existing) return Promise.resolve([]);
                    const operation = { id: `operation-${draft.operations.length + 1}`, ...values };
                    draft.operations.push(operation);
                    return Promise.resolve([{ id: operation.id }]);
                  },
                };
              },
            };
          },
        };
      },
      update(table: unknown) {
        const tableName = name(table);
        return {
          set(values: Row) {
            return {
              where() {
                if (tableName === "tasks") {
                  for (const task of draft.tasks) Object.assign(task, values);
                  return {
                    returning() {
                      return Promise.resolve(draft.tasks.map((task) => ({ id: task.id })));
                    },
                  };
                }
                if (tableName === "plan_operations") {
                  const operation = draft.operations.at(-1);
                  if (operation) Object.assign(operation, values);
                }
                if (tableName === "operation_approvals") {
                  const approval = draft.approvals.at(-1);
                  if (approval) Object.assign(approval, values);
                  return {
                    returning() {
                      return Promise.resolve(approval ? [{ id: approval.id }] : []);
                    },
                  };
                }
                return Promise.resolve();
              },
            };
          },
        };
      },
      delete(table: unknown) {
        const tableName = name(table);
        return {
          where() {
            return {
              returning() {
                if (tableName !== "tasks") return Promise.resolve([]);
                const deleted = draft.tasks.map((task) => ({ id: task.id }));
                draft.tasks = [];
                return Promise.resolve(deleted);
              },
            };
          },
        };
      },
    };
  }

  const db = {
    get state() {
      return state;
    },
    setTask(values: Row) {
      Object.assign(state.tasks[0], values);
    },
    setPatches(patches: Row[]) {
      state.patches = patches;
    },
    setOperations(operations: Row[]) {
      state.operations = operations;
    },
    setApprovals(approvals: Row[]) {
      state.approvals = approvals;
    },
    ...connection(state),
    async transaction<T>(callback: (tx: any) => Promise<T>) {
      const draft = clone(state);
      const result = await callback(connection(draft));
      state = draft;
      Object.assign(db, connection(state));
      return result;
    },
  };
  return db;
}

function fingerprint(row: Row): TaskBatchFingerprintRow {
  return {
    id: row.id,
    planId: row.planId,
    title: row.title,
    status: row.status,
    date: row.date,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    parentTaskId: row.parentTaskId,
    estimatedMinutes: row.estimatedMinutes,
    archivedAt: row.archivedAt,
    updatedAt: row.updatedAt,
  };
}

function token(db: ReturnType<typeof createDb>, action: "archive" | "restore" | "delete", now: Date) {
  return createTaskBatchPreviewToken({
    action,
    workspaceId: "workspace-1",
    planId: db.state.plans[0].id,
    rows: db.state.tasks.map(fingerprint),
    filters: { taskIds: db.state.tasks.map((task) => task.id) },
    now,
  }).token;
}

function approveToken(
  db: ReturnType<typeof createDb>,
  action: "archive" | "restore" | "delete",
  previewToken: string,
  now: Date,
) {
  const verified = verifyTaskBatchPreviewToken({
    token: previewToken,
    action,
    workspaceId: "workspace-1",
    now,
  });
  if (!verified.ok) throw new Error("preview token verification failed in test");
  const approval = {
    id: `approved-${db.state.approvals.length + 1}`,
    workspaceId: "workspace-1",
    operationKind: `${action}_tasks_batch`,
    requestHash: stableHash({
      action,
      planId: verified.payload.planId,
      taskIds: verified.payload.taskIds,
      selectionHash: verified.payload.selectionHash,
      count: verified.payload.count,
    }),
    previewHash: createHash("sha256").update(previewToken).digest("hex"),
    status: "approved",
    expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
  };
  db.setApprovals([...db.state.approvals, approval]);
  return approval.id;
}

describe("archive, restore, and permanent delete task batches", () => {
  it("rejects a missing user approval before claiming the idempotency key", async () => {
    process.env.APP_SECRET = "task-archive-test-secret";
    const db = createDb();
    const now = new Date("2026-08-16T01:00:00.000Z");
    const previewToken = token(db, "archive", now);

    await expect(applyTaskArchiveBatch(db as any, {
      workspaceId: "workspace-1",
      action: "archive",
      previewToken,
      confirmTaskCount: 1,
      idempotencyKey: "archive-no-approval-1",
      now,
    })).rejects.toMatchObject({ code: "approval_required" });

    expect(db.state.operations).toEqual([]);
    expect(db.state.tasks[0].archivedAt).toBeNull();
  });

  it("previews the exact task count, minutes, title, and a signed token", async () => {
    process.env.APP_SECRET = "task-archive-test-secret";
    const db = createDb();
    const now = new Date("2026-08-16T01:00:00.000Z");

    const preview = await previewTaskBatch(db as any, {
      workspaceId: "workspace-1",
      action: "archive",
      filters: { taskIds: ["11111111-1111-4111-8111-111111111111"] },
      now,
    });

    expect(preview).toMatchObject({
      status: "succeeded",
      action: "archive",
      count: 1,
      totalMinutes: 60,
      tasks: [{
        id: "11111111-1111-4111-8111-111111111111",
        title: "Write methods",
        status: "todo",
      }],
      sideEffects: {
        checkinTaskLinks: 0,
        taskTagLinks: 0,
        detachedChildTaskIds: [],
        affectedDraftPatchIds: [],
      },
    });
    expect(preview.previewToken).toEqual(expect.any(String));
  });

  it("archives atomically without changing task status and returns duplicate from persisted result", async () => {
    process.env.APP_SECRET = "task-archive-test-secret";
    const db = createDb();
    const now = new Date("2026-08-16T01:00:00.000Z");
    const previewToken = token(db, "archive", now);
    const approvalId = approveToken(db, "archive", previewToken, now);
    const input = {
      workspaceId: "workspace-1",
      action: "archive" as const,
      previewToken,
      approvalId,
      confirmTaskCount: 1,
      idempotencyKey: "archive-task-1",
      now,
    };

    const result = await applyTaskArchiveBatch(db as any, input);

    expect(result).toMatchObject({
      status: "succeeded",
      processedCount: 1,
      taskIds: ["11111111-1111-4111-8111-111111111111"],
      readback: { todoCount: 0, backlogCount: 0, archivedCount: 1, verification: "succeeded" },
    });
    expect(db.state.tasks[0]).toMatchObject({ status: "todo", archivedAt: now });
    expect(db.state.changeLogs).toHaveLength(1);
    expect(db.state.operations[0]).toMatchObject({ status: "succeeded" });

    const duplicate = await applyTaskArchiveBatch(db as any, input);
    expect(duplicate).toMatchObject({ status: "duplicate", originalStatus: "succeeded", processedCount: 1 });
    expect(db.state.changeLogs).toHaveLength(1);
  });

  it("records stale-preview failure and returns a structured failed duplicate", async () => {
    process.env.APP_SECRET = "task-archive-test-secret";
    const db = createDb();
    const now = new Date("2026-08-16T01:00:00.000Z");
    const previewToken = token(db, "archive", now);
    const approvalId = approveToken(db, "archive", previewToken, now);
    db.setTask({ title: "Renamed after preview" });
    const input = {
      workspaceId: "workspace-1",
      action: "archive" as const,
      previewToken,
      approvalId,
      confirmTaskCount: 1,
      idempotencyKey: "archive-stale-1",
      now,
    };

    await expect(applyTaskArchiveBatch(db as any, input)).rejects.toMatchObject({ code: "preview_stale" });
    expect(db.state.tasks[0].archivedAt).toBeNull();
    expect(db.state.operations[0]).toMatchObject({ status: "failed", errorJson: { code: "preview_stale" } });

    const duplicate = await applyTaskArchiveBatch(db as any, input);
    expect(duplicate).toMatchObject({
      status: "duplicate",
      originalStatus: "failed",
      processedCount: 0,
      taskIds: [],
      error: { code: "preview_stale" },
    });
    expect(duplicate.readback).toBeUndefined();
  });

  it("fails an expired started lease safely and allows retry with a new idempotency key", async () => {
    process.env.APP_SECRET = "task-archive-test-secret";
    const db = createDb();
    const now = new Date("2026-08-16T01:00:00.000Z");
    const previewToken = token(db, "archive", now);
    const verified = verifyTaskBatchPreviewToken({
      token: previewToken,
      action: "archive",
      workspaceId: "workspace-1",
      now,
    });
    if (!verified.ok) throw new Error("preview token verification failed in test");
    const requestHash = stableHash({
      action: "archive",
      planId: verified.payload.planId,
      taskIds: verified.payload.taskIds,
      selectionHash: verified.payload.selectionHash,
      confirmTaskCount: 1,
      groupId: null,
    });
    db.setOperations([{
      id: "expired-operation",
      workspaceId: "workspace-1",
      planId: verified.payload.planId,
      operationKind: "archive_tasks_batch",
      idempotencyKey: "archive-expired-1",
      requestHash,
      groupId: null,
      status: "started",
      resultJson: {},
      errorJson: null,
      leaseExpiresAt: new Date("2026-08-16T00:59:00.000Z"),
    }]);

    const expired = await applyTaskArchiveBatch(db as any, {
      workspaceId: "workspace-1",
      action: "archive",
      previewToken,
      confirmTaskCount: 1,
      idempotencyKey: "archive-expired-1",
      now,
    });
    expect(expired).toMatchObject({
      status: "duplicate",
      originalStatus: "failed",
      processedCount: 0,
      error: {
        code: "operation_lease_expired",
        details: { retryable: true, retryWithNewIdempotencyKey: true },
      },
    });
    expect(db.state.tasks[0].archivedAt).toBeNull();
    expect(db.state.operations[0]).toMatchObject({ status: "failed", leaseExpiresAt: null });

    const retried = await applyTaskArchiveBatch(db as any, {
      workspaceId: "workspace-1",
      action: "archive",
      previewToken,
      approvalId: approveToken(db, "archive", previewToken, now),
      confirmTaskCount: 1,
      idempotencyKey: "archive-expired-retry-2",
      now,
    });
    expect(retried).toMatchObject({ status: "succeeded", processedCount: 1 });
    expect(db.state.tasks[0].archivedAt).toEqual(now);
  });

  it("blocks delete while a Review draft references the task, then returns DELETE RETURNING IDs", async () => {
    process.env.APP_SECRET = "task-archive-test-secret";
    const now = new Date("2026-08-16T01:00:00.000Z");
    const db = createDb({
      task: { archivedAt: new Date("2026-08-15T01:00:00.000Z") },
      patches: [{
        id: "patch-1",
        workspaceId: "workspace-1",
        planId: "22222222-2222-4222-8222-222222222222",
        status: "draft",
        patchJson: { operations: [{ type: "move_task", task_id: "11111111-1111-4111-8111-111111111111" }] },
      }],
    });
    const blockedToken = token(db, "delete", now);
    const blockedApprovalId = approveToken(db, "delete", blockedToken, now);
    await expect(
      applyTaskArchiveBatch(db as any, {
        workspaceId: "workspace-1",
        action: "delete",
        previewToken: blockedToken,
        approvalId: blockedApprovalId,
        confirmTaskCount: 1,
        confirmation: "PERMANENT_DELETE",
        idempotencyKey: "delete-blocked-1",
        groupId: "99999999-9999-4999-8999-999999999999",
        now,
      }),
    ).rejects.toMatchObject({ code: "active_review_dependency" });
    expect(db.state.tasks).toHaveLength(1);

    db.setPatches([]);
    const deleteToken = token(db, "delete", now);
    const deleteApprovalId = approveToken(db, "delete", deleteToken, now);
    const input = {
      workspaceId: "workspace-1",
      action: "delete" as const,
      previewToken: deleteToken,
      approvalId: deleteApprovalId,
      confirmTaskCount: 1,
      confirmation: "PERMANENT_DELETE",
      idempotencyKey: "delete-task-1",
      groupId: "99999999-9999-4999-8999-999999999999",
      now,
    };
    const result = await applyTaskArchiveBatch(db as any, input);
    expect(result).toMatchObject({
      status: "succeeded",
      processedCount: 1,
      taskIds: ["11111111-1111-4111-8111-111111111111"],
      readback: { archivedCount: 0 },
    });
    expect(db.state.tasks).toEqual([]);

    const duplicate = await applyTaskArchiveBatch(db as any, input);
    expect(duplicate).toMatchObject({ status: "duplicate", processedCount: 1 });
  });

  it("requires exact permanent-delete confirmation before touching the database", async () => {
    await expect(
      applyTaskArchiveBatch({} as any, {
        workspaceId: "workspace-1",
        action: "delete",
        previewToken: "unused",
        confirmTaskCount: 1,
        confirmation: "delete",
        idempotencyKey: "delete-validation-1",
        groupId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toBeInstanceOf(McpTaskArchiveError);
  });

  it("reports post-commit readback failure without changing an applied result to failed", async () => {
    const applied = {
      status: "succeeded" as const,
      operationId: "operation-1",
      groupId: null,
      idempotencyKey: "archive-readback-1",
      processedCount: 1,
      taskIds: ["task-1"],
      unchangedTaskIds: [],
      readback: {
        todoCount: 0,
        backlogCount: 0,
        archivedCount: 1,
        weekVisibleCount: 0,
        monthVisibleCount: 0,
        verification: "succeeded" as const,
      },
    };

    const result = await attachTaskBatchPostCommitReadback(applied, async () => {
      throw new Error("read replica unavailable");
    });

    expect(result).toMatchObject({
      status: "applied_with_readback_error",
      persistedStatus: "succeeded",
      processedCount: 1,
      postCommitReadback: {
        verification: "failed",
        error: { code: "readback_failed", message: "read replica unavailable" },
      },
      warnings: [{ code: "readback_failed", mutationApplied: true }],
    });
  });

  it("returns structured post-commit counts when readback succeeds", async () => {
    const result = await attachTaskBatchPostCommitReadback(
      {
        status: "succeeded",
        operationId: "operation-1",
        groupId: null,
        idempotencyKey: "archive-readback-2",
        processedCount: 1,
        taskIds: ["task-1"],
        unchangedTaskIds: [],
      },
      async () => ({ counts: { active: 3, todo: 2, backlog: 1, archived: 4, today: 1, week: 2, month: 3 } }),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      postCommitReadback: {
        verification: "succeeded",
        counts: { active: 3, todo: 2, backlog: 1, archived: 4, today: 1, week: 2, month: 3 },
      },
    });
  });
});
