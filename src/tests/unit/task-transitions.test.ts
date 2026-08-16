import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  moveLegacySkippedTaskToBacklog,
  rescheduleBacklogTask,
  restoreArchivedTaskToBacklog,
} from "@/lib/planning/task-transitions";

type Row = Record<string, any>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createDb(task: Partial<Row> = {}) {
  let state = {
    plans: [{
      id: "22222222-2222-4222-8222-222222222222",
      workspaceId: "workspace-1",
      title: "Active",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-09-01T00:00:00.000Z"),
      currentVersionId: null,
      baselineSnapshot: {},
    }],
    tasks: [{
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "workspace-1",
      planId: "22222222-2222-4222-8222-222222222222",
      title: "Continue experiment",
      status: "backlog",
      date: new Date("2026-08-10T16:00:00.000Z"),
      daySegment: "morning",
      archivedAt: null,
      updatedAt: new Date("2026-08-16T00:00:00.000Z"),
      ...task,
    }],
    operations: [] as Row[],
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
                : tableName === "plan_operations"
                  ? [...draft.operations].reverse()
                  : [];
            return {
              where() {
                return {
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
        const tableName = name(table);
        return {
          values(values: Row) {
            if (tableName === "change_logs") {
              draft.changeLogs.push(values);
              return Promise.resolve();
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
                  Object.assign(draft.tasks[0], values);
                  return { returning: () => Promise.resolve([{ id: draft.tasks[0].id }]) };
                }
                if (tableName === "plan_operations") Object.assign(draft.operations.at(-1)!, values);
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
      const draft = clone(state);
      const result = await callback(connection(draft));
      state = draft;
      Object.assign(db, connection(state));
      return result;
    },
  };
  return db;
}

describe("single-task state transitions", () => {
  it("reschedules a backlog task to todo with audit, readback, and idempotent retry", async () => {
    const db = createDb();
    const input = {
      workspaceId: "workspace-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      date: "2026-08-20",
      idempotencyKey: "backlog-reschedule-1",
      now: new Date("2026-08-16T01:00:00.000Z"),
    };

    const result = await rescheduleBacklogTask(db, input);

    expect(result).toMatchObject({
      status: "succeeded",
      task: { status: "todo", date: "2026-08-20", archivedAt: null },
      readback: { verification: "succeeded", counts: { todo: 1, backlog: 0, archived: 0 } },
    });
    expect(db.state.changeLogs).toHaveLength(1);
    expect(db.state.changeLogs[0]).toMatchObject({
      source: "manual",
      summary: "Rescheduled backlog task",
      detailsJson: { before: { status: "backlog" }, after: { status: "todo", date: "2026-08-20" } },
    });

    const duplicate = await rescheduleBacklogTask(db, input);
    expect(duplicate).toMatchObject({ status: "duplicate", originalStatus: "succeeded" });
    expect(db.state.changeLogs).toHaveLength(1);
  });

  it("keeps a non-backlog task unchanged when the expected state does not match", async () => {
    const db = createDb({ status: "done" });

    await expect(rescheduleBacklogTask(db, {
      workspaceId: "workspace-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      date: "2026-08-20",
      idempotencyKey: "backlog-conflict-1",
    })).rejects.toMatchObject({ code: "task_state_conflict", status: 409 });

    expect(db.state.tasks[0].status).toBe("done");
    expect(db.state.changeLogs).toEqual([]);
    expect(db.state.operations).toEqual([]);
  });

  it("restores an archived task to backlog without preserving legacy skipped as completion", async () => {
    const db = createDb({ status: "skipped", archivedAt: new Date("2026-08-15T01:00:00.000Z") });

    const result = await restoreArchivedTaskToBacklog(db, {
      workspaceId: "workspace-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      expectedArchived: true,
      idempotencyKey: "archive-restore-1",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      task: { status: "backlog", archivedAt: null },
      readback: { counts: { todo: 0, backlog: 1, archived: 0 } },
    });
    expect(db.state.changeLogs[0].detailsJson.before.status).toBe("skipped");
    expect(db.state.changeLogs[0].detailsJson.after.status).toBe("backlog");
  });

  it("moves an active legacy skipped task into backlog with an expected-status guard", async () => {
    const db = createDb({ status: "skipped" });

    const result = await moveLegacySkippedTaskToBacklog(db, {
      workspaceId: "workspace-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      expectedStatus: "skipped",
      idempotencyKey: "legacy-restore-1",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      task: { status: "backlog", archivedAt: null },
      readback: { counts: { todo: 0, backlog: 1, archived: 0 } },
    });
    expect(db.state.changeLogs[0].summary).toBe("Moved legacy skipped task to backlog");
  });

  it("rejects a task from another workspace without writing", async () => {
    const db = createDb({ workspaceId: "workspace-other" });

    await expect(restoreArchivedTaskToBacklog(db, {
      workspaceId: "workspace-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      expectedArchived: true,
      idempotencyKey: "cross-workspace-1",
    })).rejects.toMatchObject({ code: "task_not_found", status: 404 });

    expect(db.state.changeLogs).toEqual([]);
    expect(db.state.operations).toEqual([]);
  });
});
