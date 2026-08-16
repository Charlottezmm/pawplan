import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { triageLegacySkippedTasks } from "@/lib/planning/task-transitions";

type Row = Record<string, any>;

const backlogTaskId = "11111111-1111-4111-8111-111111111111";
const archiveTaskId = "33333333-3333-4333-8333-333333333333";
const untouchedTaskId = "44444444-4444-4444-8444-444444444444";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createDb(overrides: Record<string, Partial<Row>> = {}) {
  const planId = "22222222-2222-4222-8222-222222222222";
  const baseTask = (id: string) => ({
    id,
    workspaceId: "workspace-1",
    planId,
    title: `Task ${id.slice(0, 4)}`,
    status: "skipped",
    date: new Date("2026-08-10T16:00:00.000Z"),
    daySegment: "morning",
    archivedAt: null,
    updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    ...overrides[id],
  });
  let state = {
    plans: [{
      id: planId,
      workspaceId: "workspace-1",
      title: "Active",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-09-01T00:00:00.000Z"),
      currentVersionId: null,
      baselineSnapshot: {},
    }],
    tasks: [baseTask(backlogTaskId), baseTask(archiveTaskId), baseTask(untouchedTaskId)],
    operations: [] as Row[],
    changeLogs: [] as Row[],
  };

  function name(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function connection(draft: typeof state) {
    return {
      select(selection?: Row) {
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
                    };
                  },
                  for() {
                    return Promise.resolve(rows);
                  },
                  then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
                    const projected = selection
                      ? (rows as Row[]).map((row) => Object.fromEntries(Object.keys(selection).map((key) => [key, row[key]])))
                      : rows;
                    return Promise.resolve(projected).then(resolve, reject);
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
                if (tableName === "plan_operations") {
                  Object.assign(draft.operations.at(-1)!, values);
                  return Promise.resolve();
                }
                const ids = values.status === "backlog" ? [backlogTaskId] : [archiveTaskId];
                const updated = draft.tasks.filter((task) => ids.includes(task.id) && task.status === "skipped" && task.archivedAt === null);
                updated.forEach((task) => Object.assign(task, values));
                return { returning: () => Promise.resolve(updated.map((task) => ({ id: task.id }))) };
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
    async transaction<T>(callback: (tx: any) => Promise<T>) {
      const draft = clone(state);
      const result = await callback(connection(draft));
      state = draft;
      return result;
    },
  };
  return db;
}

function input() {
  return {
    workspaceId: "workspace-1",
    decisions: [
      { taskId: backlogTaskId, decision: "backlog" as const },
      { taskId: archiveTaskId, decision: "archive" as const },
    ],
    confirmCount: 2,
    idempotencyKey: "legacy-triage-1",
    now: new Date("2026-08-16T02:00:00.000Z"),
  };
}

describe("legacy skipped task triage", () => {
  it("atomically moves explicit keep decisions to backlog and explicit stop decisions to archive", async () => {
    const db = createDb();

    const result = await triageLegacySkippedTasks(db, input());

    expect(result).toMatchObject({
      status: "succeeded",
      processedCount: 2,
      movedToBacklog: { count: 1, taskIds: [backlogTaskId] },
      archived: { count: 1, taskIds: [archiveTaskId] },
      readback: { verification: "succeeded", legacySkippedRemaining: 1, backlogCount: 1, archivedCount: 1 },
    });
    expect(db.state.tasks.find((task) => task.id === backlogTaskId)).toMatchObject({ status: "backlog", archivedAt: null });
    expect(db.state.tasks.find((task) => task.id === archiveTaskId)?.archivedAt).toEqual(new Date("2026-08-16T02:00:00.000Z"));
    expect(db.state.tasks.find((task) => task.id === untouchedTaskId)).toMatchObject({ status: "skipped", archivedAt: null });
    expect(db.state.changeLogs).toHaveLength(1);
    expect(db.state.changeLogs[0]).toMatchObject({
      source: "manual",
      summary: "Organized legacy skipped tasks",
      detailsJson: { movedToBacklog: [backlogTaskId], archived: [archiveTaskId] },
    });

    const duplicate = await triageLegacySkippedTasks(db, input());
    expect(duplicate).toMatchObject({ status: "duplicate", originalStatus: "succeeded" });
    expect(db.state.changeLogs).toHaveLength(1);
  });

  it("rejects mismatched confirmation before opening a transaction", async () => {
    const db = createDb();

    await expect(triageLegacySkippedTasks(db, { ...input(), confirmCount: 1 }))
      .rejects.toMatchObject({ code: "invalid_request", status: 400 });

    expect(db.state.tasks.every((task) => task.status === "skipped" && task.archivedAt === null)).toBe(true);
    expect(db.state.operations).toEqual([]);
  });

  it("rolls back every decision when one selected task changed", async () => {
    const db = createDb({ [archiveTaskId]: { status: "done" } });

    await expect(triageLegacySkippedTasks(db, input()))
      .rejects.toMatchObject({ code: "task_state_conflict", status: 409 });

    expect(db.state.tasks.find((task) => task.id === backlogTaskId)?.status).toBe("skipped");
    expect(db.state.changeLogs).toEqual([]);
    expect(db.state.operations).toEqual([]);
  });
});
