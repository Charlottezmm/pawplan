import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  applyTaskNotesBatch,
  attachTaskNotesPostCommitReadback,
  createTaskNotesPreviewToken,
  proposeTaskNotesBatch,
  verifyTaskNotesPreviewToken,
  type TaskNotesPreviewOperation,
} from "@/lib/mcp/task-notes-batch";

const previousSecret = process.env.APP_SECRET;
const operations: TaskNotesPreviewOperation[] = [{
  taskId: "11111111-1111-4111-8111-111111111111",
  title: "Write methods",
  beforeNotes: null,
  beforeUpdatedAt: "2026-08-18T00:00:00.000Z",
  afterNotes: "New exact notes",
}];

type Row = Record<string, any>;

function createDb() {
  let state = {
    plans: [{
      id: "22222222-2222-4222-8222-222222222222",
      workspaceId: "workspace-1",
      status: "active",
      title: "Plan",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-12-31T00:00:00.000Z"),
      currentVersionId: null,
      baselineSnapshot: {},
    }],
    tasks: [{
      id: operations[0].taskId,
      workspaceId: "workspace-1",
      planId: "22222222-2222-4222-8222-222222222222",
      title: operations[0].title,
      notes: null,
      archivedAt: null,
      updatedAt: new Date(operations[0].beforeUpdatedAt),
    }],
    operations: [] as Row[],
    approvals: [] as Row[],
    logs: [] as Row[],
  };

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function queryRows(draft: typeof state, table: unknown) {
    const name = tableName(table);
    if (name === "plans") return draft.plans;
    if (name === "tasks") return draft.tasks;
    if (name === "plan_operations") return [...draft.operations].reverse();
    if (name === "operation_approvals") return [...draft.approvals].reverse();
    return [];
  }

  function connection(draft: typeof state) {
    return {
      select() {
        return {
          from(table: unknown) {
            const rows = queryRows(draft, table);
            return {
              where() {
                return {
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
              },
            };
          },
        };
      },
      insert(table: unknown) {
        const name = tableName(table);
        return {
          values(values: Row) {
            if (name === "change_logs") {
              draft.logs.push(values);
              return Promise.resolve();
            }
            if (name === "operation_approvals") {
              return {
                returning() {
                  const row = {
                    id: `approval-${draft.approvals.length + 1}`,
                    status: "pending",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...values,
                  };
                  draft.approvals.push(row);
                  return Promise.resolve([row]);
                },
              };
            }
            return {
              onConflictDoNothing() {
                return {
                  returning() {
                    const existing = draft.operations.find((row) =>
                      row.workspaceId === values.workspaceId && row.idempotencyKey === values.idempotencyKey
                    );
                    if (existing) return Promise.resolve([]);
                    const row = { id: `operation-${draft.operations.length + 1}`, ...values };
                    draft.operations.push(row);
                    return Promise.resolve([row]);
                  },
                };
              },
            };
          },
        };
      },
      update(table: unknown) {
        const name = tableName(table);
        return {
          set(values: Row) {
            return {
              where() {
                if (name === "tasks") {
                  Object.assign(draft.tasks[0], values);
                  return { returning: () => Promise.resolve([{ id: draft.tasks[0].id }]) };
                }
                if (name === "plan_operations") Object.assign(draft.operations.at(-1)!, values);
                if (name === "operation_approvals") {
                  Object.assign(draft.approvals.at(-1)!, values);
                  return { returning: () => Promise.resolve([{ id: draft.approvals.at(-1)!.id }]) };
                }
                return Promise.resolve();
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
    ...connection(state),
    async transaction<T>(callback: (tx: any) => Promise<T>) {
      const draft = structuredClone(state);
      const result = await callback(connection(draft));
      state = draft;
      Object.assign(db, connection(state));
      return result;
    },
  };
  return db;
}

describe("task notes batch post-commit readback", () => {
  beforeEach(() => {
    process.env.APP_SECRET = "task-notes-batch-test-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
  });

  it("binds old notes, updatedAt, new notes, workspace, plan, and expiry", () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    const created = createTaskNotesPreviewToken({
      workspaceId: "workspace-1",
      planId: "22222222-2222-4222-8222-222222222222",
      operations,
      now,
    });
    expect(verifyTaskNotesPreviewToken({ token: created.token, workspaceId: "workspace-1", now })).toEqual(created.payload);
    expect(created.payload.expiresAt).toBe("2026-08-19T00:00:00.000Z");
    expect(() => verifyTaskNotesPreviewToken({ token: created.token, workspaceId: "workspace-2", now }))
      .toThrowError(expect.objectContaining({ code: "preview_invalid" }));
    expect(verifyTaskNotesPreviewToken({
      token: created.token,
      workspaceId: "workspace-1",
      now: new Date("2026-08-18T23:59:59.000Z"),
    })).toEqual(created.payload);
    expect(() => verifyTaskNotesPreviewToken({
      token: created.token,
      workspaceId: "workspace-1",
      now: new Date("2026-08-19T00:00:00.000Z"),
    })).toThrowError(expect.objectContaining({ code: "preview_expired" }));

    const [payload, signature] = created.token.split(".");
    expect(() => verifyTaskNotesPreviewToken({
      token: `${payload.slice(0, -1)}A.${signature}`,
      workspaceId: "workspace-1",
      now,
    })).toThrowError(expect.objectContaining({ code: "preview_invalid" }));
  });

  it("creates one idempotent Review and applies the approved notes once", async () => {
    const db = createDb();
    const proposal = await proposeTaskNotesBatch(db, {
      workspaceId: "workspace-1",
      idempotencyKey: "proposal-key-1",
      operations: [{ taskId: operations[0].taskId, notes: operations[0].afterNotes }],
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    expect(proposal).toMatchObject({ status: "draft_created", count: 1, liveUnchanged: true });
    expect(db.state.tasks[0].notes).toBeNull();
    expect(db.state.approvals).toHaveLength(1);

    const duplicateProposal = await proposeTaskNotesBatch(db, {
      workspaceId: "workspace-1",
      idempotencyKey: "proposal-key-1",
      operations: [{ taskId: operations[0].taskId, notes: operations[0].afterNotes }],
      now: new Date("2026-08-18T00:00:01.000Z"),
    });
    expect(duplicateProposal).toMatchObject({
      status: "duplicate",
      originalStatus: "succeeded",
      approvalId: proposal.approvalId,
    });
    expect(db.state.approvals).toHaveLength(1);

    Object.assign(db.state.approvals[0], { status: "approved", approvedAt: new Date("2026-08-18T00:01:00.000Z") });
    const applied = await applyTaskNotesBatch(db, {
      workspaceId: "workspace-1",
      approvalId: proposal.approvalId,
      previewToken: proposal.previewToken,
      idempotencyKey: "apply-key-1",
      now: new Date("2026-08-18T00:01:00.000Z"),
    });
    expect(applied).toMatchObject({
      status: "succeeded",
      mutationApplied: true,
      postCommitReadback: { verification: "succeeded" },
    });
    expect(db.state.tasks[0].notes).toBe(operations[0].afterNotes);
    expect(db.state.approvals[0].status).toBe("consumed");
    expect(db.state.logs).toHaveLength(1);

    const duplicateApply = await applyTaskNotesBatch(db, {
      workspaceId: "workspace-1",
      approvalId: proposal.approvalId,
      previewToken: proposal.previewToken,
      idempotencyKey: "apply-key-1",
      now: new Date("2026-08-18T00:02:00.000Z"),
    });
    expect(duplicateApply).toMatchObject({ status: "duplicate", originalStatus: "succeeded" });
    expect(db.state.logs).toHaveLength(1);
  });

  it("writes nothing and preserves the approval when any task changed after Preview", async () => {
    const db = createDb();
    const proposal = await proposeTaskNotesBatch(db, {
      workspaceId: "workspace-1",
      idempotencyKey: "proposal-key-2",
      operations: [{ taskId: operations[0].taskId, notes: operations[0].afterNotes }],
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    Object.assign(db.state.approvals[0], { status: "approved", approvedAt: new Date("2026-08-18T00:01:00.000Z") });
    db.state.tasks[0].updatedAt = new Date("2026-08-18T00:00:30.000Z");
    const operationCountBeforeApply = db.state.operations.length;

    await expect(applyTaskNotesBatch(db, {
      workspaceId: "workspace-1",
      approvalId: proposal.approvalId,
      previewToken: proposal.previewToken,
      idempotencyKey: "apply-key-2",
      now: new Date("2026-08-18T00:01:00.000Z"),
    })).rejects.toMatchObject({ code: "preview_stale" });

    expect(db.state.tasks[0].notes).toBeNull();
    expect(db.state.approvals[0].status).toBe("approved");
    expect(db.state.logs).toHaveLength(0);
    expect(db.state.operations).toHaveLength(operationCountBeforeApply);
  });

  it("reports a committed mutation separately from a failed external readback", async () => {
    const result = await attachTaskNotesPostCommitReadback({
      status: "succeeded",
      operationId: "operation-1",
      mutationApplied: true,
    }, async () => {
      throw new Error("database connection dropped after commit");
    });

    expect(result).toMatchObject({
      status: "applied_with_readback_error",
      persistedStatus: "succeeded",
      mutationApplied: true,
      postCommitReadback: {
        verification: "failed",
        error: { code: "readback_failed" },
      },
      warnings: [{ code: "readback_failed", mutationApplied: true }],
    });
  });
});
