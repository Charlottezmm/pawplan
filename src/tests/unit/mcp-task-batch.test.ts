import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateTasksBatch } from "@/lib/mcp/task-batch";

type Row = Record<string, any>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createBatchDb(options: { tasks?: Row[]; failAtTaskUpdate?: number } = {}) {
  let rowLockCount = 0;
  let state = {
    tasks: clone(options.tasks ?? [
      {
        id: "task-1",
        workspaceId: "workspace-1",
        planId: "plan-1",
        status: "todo",
        date: new Date("2026-07-14T16:00:00.000Z"),
        daySegment: "morning",
        blocked: false,
        estimatedMinutes: 60,
        notes: "keep task 1 notes",
      },
      {
        id: "task-2",
        workspaceId: "workspace-1",
        planId: "plan-1",
        status: "todo",
        date: new Date("2026-07-14T16:00:00.000Z"),
        daySegment: "afternoon",
        blocked: false,
        estimatedMinutes: 90,
        notes: "keep task 2 notes",
      },
    ]),
    batches: [] as Row[],
    changeLogs: [] as Row[],
  };

  function connection(draft: typeof state) {
    let taskUpdateCount = 0;
    return {
      select() {
        return {
          from(table: unknown) {
            const name = getTableName(table as Parameters<typeof getTableName>[0]);
            const rows = name === "tasks" ? draft.tasks : name === "mcp_task_write_batches" ? draft.batches : [];
            const result = {
              where() {
                const filtered = rows;
                return {
                  orderBy() {
                    return this;
                  },
                  for() {
                    rowLockCount += 1;
                    return Promise.resolve(filtered);
                  },
                  limit(count: number) {
                    return Promise.resolve(filtered.slice(0, count));
                  },
                  then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
                    return Promise.resolve(filtered).then(resolve, reject);
                  },
                };
              },
            };
            return result;
          },
        };
      },
      insert(table: unknown) {
        const name = getTableName(table as Parameters<typeof getTableName>[0]);
        return {
          values(values: Row) {
            if (name === "mcp_task_write_batches") {
              return {
                onConflictDoNothing() {
                  return {
                    returning() {
                      const existing = draft.batches.find(
                        (row) => row.workspaceId === values.workspaceId && row.idempotencyKey === values.idempotencyKey,
                      );
                      if (existing) return Promise.resolve([]);
                      const row = { id: `batch-${draft.batches.length + 1}`, ...values };
                      draft.batches.push(row);
                      return Promise.resolve([row]);
                    },
                  };
                },
              };
            }
            if (name === "change_logs") draft.changeLogs.push(values);
            return Promise.resolve();
          },
        };
      },
      update(table: unknown) {
        const name = getTableName(table as Parameters<typeof getTableName>[0]);
        return {
          set(values: Row) {
            if (name === "tasks") {
              taskUpdateCount += 1;
              const taskIndex = taskUpdateCount - 1;
              return {
                where() {
                  return {
                    returning() {
                      if (options.failAtTaskUpdate === taskUpdateCount) throw new Error("injected task update failure");
                      const task = draft.tasks[taskIndex];
                      if (!task) return Promise.resolve([]);
                      Object.assign(task, values);
                      return Promise.resolve([{ id: task.id }]);
                    },
                  };
                },
              };
            }
            return {
              where() {
                const batch = draft.batches[0];
                if (batch) Object.assign(batch, values);
                return Promise.resolve();
              },
            };
          },
        };
      },
    };
  }

  return {
    get state() {
      return state;
    },
    get rowLockCount() {
      return rowLockCount;
    },
    async transaction<T>(callback: (tx: any) => Promise<T>) {
      const draft = clone(state);
      const result = await callback(connection(draft));
      state = draft;
      return result;
    },
  };
}

const operations = [
  {
    taskId: "task-1",
    status: "backlog" as const,
    expectedStatus: "todo" as const,
  },
  {
    taskId: "task-2",
    date: "2026-07-16",
    daySegment: "evening" as const,
    expectedDate: "2026-07-15",
  },
];

describe("atomic MCP task batch", () => {
  it("updates all tasks atomically and returns persisted readback", async () => {
    const db = createBatchDb();

    const result = await updateTasksBatch(db, {
      workspaceId: "workspace-1",
      idempotencyKey: "batch-reliability-1",
      operations,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      completedTaskIds: ["task-1", "task-2"],
      pendingTaskIds: [],
      readback: [
        expect.objectContaining({ id: "task-1", status: "backlog" }),
        expect.objectContaining({ id: "task-2", date: "2026-07-16", daySegment: "evening" }),
      ],
    });
    expect(db.state.changeLogs).toHaveLength(2);
    expect(db.state.batches[0]).toMatchObject({ status: "succeeded", idempotencyKey: "batch-reliability-1" });
    expect(db.rowLockCount).toBe(1);
  });

  it("returns duplicate readback for the same key and rejects payload mismatch", async () => {
    const db = createBatchDb();
    await updateTasksBatch(db, { workspaceId: "workspace-1", idempotencyKey: "batch-reliability-2", operations });
    const duplicate = await updateTasksBatch(db, {
      workspaceId: "workspace-1",
      idempotencyKey: "batch-reliability-2",
      operations,
    });

    expect(duplicate.status).toBe("duplicate");
    expect(db.state.changeLogs).toHaveLength(2);
    await expect(
      updateTasksBatch(db, {
        workspaceId: "workspace-1",
        idempotencyKey: "batch-reliability-2",
        operations: [{ taskId: "task-1", status: "done" }],
      }),
    ).rejects.toMatchObject({ code: "idempotency_payload_mismatch", status: 409 });
    expect(db.state.changeLogs).toHaveLength(2);
  });

  it("rolls back the claim and every earlier update when one update fails", async () => {
    const db = createBatchDb({ failAtTaskUpdate: 2 });

    await expect(
      updateTasksBatch(db, { workspaceId: "workspace-1", idempotencyKey: "batch-reliability-3", operations }),
    ).rejects.toThrow("injected task update failure");

    expect(db.state.tasks.map((task) => ({ status: task.status, date: task.date, daySegment: task.daySegment }))).toEqual([
      { status: "todo", date: new Date("2026-07-14T16:00:00.000Z"), daySegment: "morning" },
      { status: "todo", date: new Date("2026-07-14T16:00:00.000Z"), daySegment: "afternoon" },
    ]);
    expect(db.state.changeLogs).toEqual([]);
    expect(db.state.batches).toEqual([]);
  });

  it("prevalidates missing tasks and stale expected state before writing", async () => {
    const db = createBatchDb();
    await expect(
      updateTasksBatch(db, {
        workspaceId: "workspace-1",
        idempotencyKey: "batch-reliability-4",
        operations: [{ taskId: "missing-task", status: "done" }],
      }),
    ).rejects.toMatchObject({ code: "task_not_found", status: 404 });
    await expect(
      updateTasksBatch(db, {
        workspaceId: "workspace-1",
        idempotencyKey: "batch-reliability-5",
        operations: [{ taskId: "task-1", status: "done", expectedStatus: "backlog" }],
      }),
    ).rejects.toMatchObject({ code: "task_state_conflict", status: 409 });
    expect(db.state.changeLogs).toEqual([]);
    expect(db.state.batches).toEqual([]);
  });

  it("returns no_change with full readback when every target already matches", async () => {
    const db = createBatchDb();
    const result = await updateTasksBatch(db, {
      workspaceId: "workspace-1",
      idempotencyKey: "batch-reliability-6",
      operations: [{ taskId: "task-1", status: "todo", date: "2026-07-15", daySegment: "morning" }],
    });

    expect(result).toMatchObject({
      status: "no_change",
      completedTaskIds: ["task-1"],
      pendingTaskIds: [],
      readback: [expect.objectContaining({ id: "task-1", status: "todo", date: "2026-07-15" })],
    });
    expect(db.state.changeLogs).toEqual([]);
  });

  it("atomically updates estimates with stale-state protection, audit, and persisted readback", async () => {
    const db = createBatchDb();
    const result = await updateTasksBatch(db, {
      workspaceId: "workspace-1",
      idempotencyKey: "batch-estimates-1",
      operations: [
        { taskId: "task-1", estimatedMinutes: 20, expectedEstimatedMinutes: 60 },
        { taskId: "task-2", estimatedMinutes: 45, expectedEstimatedMinutes: 90 },
      ],
    });

    expect(result.readback).toEqual([
      expect.objectContaining({ id: "task-1", status: "todo", estimatedMinutes: 20 }),
      expect.objectContaining({ id: "task-2", status: "todo", estimatedMinutes: 45 }),
    ]);
    expect(db.state.tasks.map((task) => task.estimatedMinutes)).toEqual([20, 45]);
    expect(db.state.tasks.map((task) => task.notes)).toEqual(["keep task 1 notes", "keep task 2 notes"]);
    expect(db.state.changeLogs.map((log) => log.detailsJson.values.estimatedMinutes)).toEqual([20, 45]);

    await expect(updateTasksBatch(db, {
      workspaceId: "workspace-1",
      idempotencyKey: "batch-estimates-stale",
      operations: [
        { taskId: "task-1", estimatedMinutes: 10, expectedEstimatedMinutes: 60 },
        { taskId: "task-2", estimatedMinutes: 30, expectedEstimatedMinutes: 45 },
      ],
    })).rejects.toMatchObject({
      code: "task_state_conflict",
      status: 409,
      details: { conflicts: [expect.objectContaining({ taskId: "task-1", field: "estimated_minutes", actual: 20 })] },
    });
    expect(db.state.tasks.map((task) => task.estimatedMinutes)).toEqual([20, 45]);
  });

  it("defends batch size, unique task IDs, and required update fields in the service", async () => {
    const db = createBatchDb();
    await expect(
      updateTasksBatch(db, { workspaceId: "workspace-1", idempotencyKey: "batch-empty", operations: [] }),
    ).rejects.toMatchObject({ code: "invalid_batch", status: 400 });
    await expect(
      updateTasksBatch(db, {
        workspaceId: "workspace-1",
        idempotencyKey: "batch-invalid-estimate",
        operations: [{ taskId: "task-1", estimatedMinutes: 481 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_batch", status: 400 });
    await expect(
      updateTasksBatch(db, {
        workspaceId: "workspace-1",
        idempotencyKey: "batch-too-large",
        operations: Array.from({ length: 51 }, (_, index) => ({ taskId: `task-${index}`, status: "done" as const })),
      }),
    ).rejects.toMatchObject({ code: "invalid_batch", status: 400 });
    await expect(
      updateTasksBatch(db, {
        workspaceId: "workspace-1",
        idempotencyKey: "batch-duplicate-task",
        operations: [{ taskId: "task-1", status: "done" }, { taskId: "task-1", blocked: true }],
      }),
    ).rejects.toMatchObject({ code: "invalid_batch", status: 400 });
    await expect(
      updateTasksBatch(db, {
        workspaceId: "workspace-1",
        idempotencyKey: "batch-no-update",
        operations: [{ taskId: "task-1", expectedStatus: "todo" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_batch", status: 400 });
    expect(db.state.batches).toEqual([]);
  });
});
