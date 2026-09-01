import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createInboxItem,
  createDailyCheckin,
  processInboxItem,
  proposeAgentPatch,
  updateTaskNotes,
  updateTaskSchedule,
  updateTaskStatus,
} from "@/lib/planning/service";

type TableWrite = {
  table: string;
  values: Record<string, unknown>;
  inTransaction: boolean;
};

type FakeDbOptions = {
  activePlanId?: string | null;
  inboxItems?: Array<Record<string, unknown>>;
  taskUpdateResult?: Array<Record<string, unknown>>;
  taskRows?: Array<Record<string, unknown>>;
  protectedBlockIds?: string[];
};

function createFakeDb(options: FakeDbOptions = {}) {
  const inserts: TableWrite[] = [];
  const updates: TableWrite[] = [];
  const deletes: Array<{ table: string; inTransaction: boolean }> = [];
  let inTransaction = false;

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function rowsFor(table: unknown) {
    const name = tableName(table);
    if (name === "plans") {
      return options.activePlanId === null ? [] : [{ id: options.activePlanId ?? "plan-1" }];
    }
    if (name === "inbox_items") {
      return options.inboxItems ?? [];
    }
    if (name === "time_blocks") {
      return (options.protectedBlockIds ?? []).map((id) => ({ id }));
    }
    if (name === "tasks") {
      return options.taskRows ?? [];
    }
    return [];
  }

  function selectableRows(table: unknown) {
    const rows = rowsFor(table);
    return {
      limit() {
        return Promise.resolve(rows);
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
  }

  function createClient() {
    return {
      select() {
        return {
          from(table: unknown) {
            return {
              where() {
                return selectableRows(table);
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                updates.push({ table: tableName(table), values, inTransaction });
                return {
                  returning() {
                    return Promise.resolve(options.taskUpdateResult ?? []);
                  },
                };
              },
            };
          },
        };
      },
      insert(table: unknown) {
        return {
          values(values: Record<string, unknown>) {
            inserts.push({ table: tableName(table), values, inTransaction });
            return {
              onConflictDoUpdate(config: { set: Record<string, unknown> }) {
                updates.push({ table: tableName(table), values: config.set, inTransaction });
                return Promise.resolve();
              },
              returning() {
                return Promise.resolve([{ id: `${tableName(table)}-1`, ...values }]);
              },
              then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
                return Promise.resolve().then(resolve, reject);
              },
            };
          },
        };
      },
      delete(table: unknown) {
        return {
          where() {
            deletes.push({ table: tableName(table), inTransaction });
            return Promise.resolve();
          },
        };
      },
    };
  }

  const client = createClient();

  return {
    inserts,
    updates,
    deletes,
    transaction: async <T>(callback: (tx: ReturnType<typeof createClient>) => Promise<T>) => {
      inTransaction = true;
      return callback(client);
    },
    wasInTransaction: () => inTransaction,
    ...client,
  };
}

describe("planning service", () => {
  it("updates task status and writes a manual change log", async () => {
    const db = createFakeDb({
      taskUpdateResult: [{ id: "task-1", planId: "plan-1", status: "done" }],
    });

    const task = await updateTaskStatus(db, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      status: "done",
      source: "manual",
    });

    expect(db.wasInTransaction()).toBe(true);
    expect(task).toEqual({ id: "task-1", planId: "plan-1", status: "done" });
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "tasks",
        values: expect.objectContaining({ status: "done", updatedAt: expect.any(Date) }),
      }),
    ]);
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "change_logs",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          planId: "plan-1",
          source: "manual",
          detailsJson: expect.objectContaining({ taskId: "task-1", status: "done" }),
        }),
      }),
    ]);
  });

  it("updates task blocked state and writes a manual change log", async () => {
    const db = createFakeDb({
      taskUpdateResult: [{ id: "task-1", planId: "plan-1", blocked: true }],
    });

    const task = await updateTaskStatus(db, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      blocked: true,
      note: "Blocked by missing credentials.",
      source: "manual",
    });

    expect(task).toEqual({ id: "task-1", planId: "plan-1", blocked: true });
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "tasks",
        values: expect.objectContaining({ blocked: true, updatedAt: expect.any(Date) }),
      }),
    ]);
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "change_logs",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          planId: "plan-1",
          source: "manual",
          summary: "Updated task blocked state",
          detailsJson: expect.objectContaining({
            taskId: "task-1",
            blocked: true,
            note: "Blocked by missing credentials.",
          }),
        }),
      }),
    ]);
  });

  it("updates task schedule and writes a manual change log", async () => {
    const scheduledDate = new Date("2026-06-16T16:00:00.000Z");
    const db = createFakeDb({
      taskUpdateResult: [{ id: "task-1", planId: "plan-1", date: scheduledDate, daySegment: "afternoon" }],
    });

    const task = await updateTaskSchedule(db, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      status: "done",
      date: "2026-06-17",
      daySegment: "afternoon",
      source: "manual",
    });

    expect(db.wasInTransaction()).toBe(true);
    expect(task).toEqual({ id: "task-1", planId: "plan-1", date: scheduledDate, daySegment: "afternoon" });
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "tasks",
        values: expect.objectContaining({
          date: scheduledDate,
          daySegment: "afternoon",
          status: "done",
          updatedAt: expect.any(Date),
        }),
      }),
    ]);
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "change_logs",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          planId: "plan-1",
          source: "manual",
          summary: "Updated task schedule",
          detailsJson: expect.objectContaining({
            taskId: "task-1",
            status: "done",
            date: "2026-06-17",
            daySegment: "afternoon",
          }),
        }),
      }),
    ]);
    expect(db.inserts.filter((write) => write.table === "agent_patches")).toEqual([]);
  });

  it("updates a task estimate with an expected-value guard and audit", async () => {
    const db = createFakeDb({
      taskUpdateResult: [{ id: "task-1", planId: "plan-1", status: "todo", estimatedMinutes: 20 }],
    });

    const task = await updateTaskSchedule(db, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      estimatedMinutes: 20,
      expectedEstimatedMinutes: 60,
      source: "manual",
    });

    expect(task).toEqual({ id: "task-1", planId: "plan-1", status: "todo", estimatedMinutes: 20 });
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "tasks",
        values: { estimatedMinutes: 20, updatedAt: expect.any(Date) },
      }),
    ]);
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "change_logs",
        values: expect.objectContaining({
          summary: "Updated task estimate",
          detailsJson: {
            taskId: "task-1",
            estimatedMinutes: 20,
            expectedEstimatedMinutes: 60,
          },
        }),
      }),
    ]);
  });

  it("returns a 409 conflict when the expected estimate is stale", async () => {
    const db = createFakeDb({
      taskUpdateResult: [],
      taskRows: [{ id: "task-1", estimatedMinutes: 45 }],
    });

    await expect(updateTaskSchedule(db, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      estimatedMinutes: 20,
      expectedEstimatedMinutes: 60,
      source: "manual",
    })).rejects.toMatchObject({
      message: "Task estimate changed since the update was requested",
      status: 409,
    });
    expect(db.inserts).toEqual([]);
  });

  it("updates task notes and writes a manual change log without touching schedule fields", async () => {
    const db = createFakeDb({
      taskUpdateResult: [{ id: "task-1", planId: "plan-1", notes: "目标：补齐任务说明" }],
    });

    const task = await updateTaskNotes(db, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      notes: "  目标：补齐任务说明  ",
      source: "manual",
    });

    expect(task).toEqual({ id: "task-1", planId: "plan-1", notes: "目标：补齐任务说明" });
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "tasks",
        values: {
          notes: "目标：补齐任务说明",
          updatedAt: expect.any(Date),
        },
      }),
    ]);
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "change_logs",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          planId: "plan-1",
          source: "manual",
          summary: "Updated task notes",
          detailsJson: {
            taskId: "task-1",
            notes: "目标：补齐任务说明",
          },
        }),
      }),
    ]);
  });

  it("rejects empty task notes updates", async () => {
    const db = createFakeDb();

    await expect(
      updateTaskNotes(db, {
        workspaceId: "workspace-1",
        taskId: "task-1",
        notes: "   ",
        source: "manual",
      }),
    ).rejects.toThrow("Task notes update required");
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("rejects invalid task schedule dates", async () => {
    const db = createFakeDb();

    await expect(
      updateTaskSchedule(db, {
        workspaceId: "workspace-1",
        taskId: "task-1",
        date: "2026-02-31",
        source: "manual",
      }),
    ).rejects.toThrow("Invalid task date");
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("creates a daily check-in using an explicit date", async () => {
    const db = createFakeDb({ activePlanId: "plan-1" });
    const date = new Date("2026-06-10T00:00:00.000Z");

    await createDailyCheckin(db, {
      workspaceId: "workspace-1",
      date,
      completedText: "Shipped the narrow refactor.",
      blockerText: "",
      nextText: "Run full verification.",
      source: "manual",
    });

    expect(db.wasInTransaction()).toBe(true);
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "checkins",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            date,
            completedText: "Shipped the narrow refactor.",
            blockerText: "",
            nextText: "Run full verification.",
          }),
        }),
        expect.objectContaining({
          table: "change_logs",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            source: "manual",
            detailsJson: expect.objectContaining({ date: date.toISOString() }),
          }),
        }),
      ]),
    );
  });

  it("proposes an agent patch as draft without changing tasks", async () => {
    const db = createFakeDb({ activePlanId: "plan-1" });
    const patch = {
      operations: [
        {
          type: "change_priority",
          task_id: "task-1",
          from_priority: "normal",
          to_priority: "high",
          reason: "Deadline moved earlier.",
        },
      ],
    };

    const result = await proposeAgentPatch(db, {
      workspaceId: "workspace-1",
      mode: "today",
      reason: "Rebalance today.",
      patch,
      createdBy: "codex",
    });

    expect(result).toEqual(
      expect.objectContaining({
        patchId: "agent_patches-1",
        workspaceId: "workspace-1",
        planId: "plan-1",
        mode: "today",
        reason: "Rebalance today.",
        patch,
        createdBy: "codex",
        status: "draft",
      }),
    );
    expect(db.updates.filter((write) => write.table === "tasks")).toEqual([]);
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "agent_patches",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          planId: "plan-1",
          reason: "Rebalance today.",
          patchJson: patch,
          createdBy: "codex",
        }),
      }),
    ]);
  });

  it("processes an inbox item into a task using the active plan", async () => {
    const db = createFakeDb({
      activePlanId: "plan-1",
      inboxItems: [{ id: "inbox-1", workspaceId: "workspace-1", title: "Draft launch checklist" }],
    });

    const result = await processInboxItem(db, {
      workspaceId: "workspace-1",
      inboxItemId: "inbox-1",
      action: "task",
      date: "2026-06-20",
      daySegment: "afternoon",
      estimatedMinutes: 45,
      priority: "high",
    });

    expect(result).toEqual({ ok: true, action: "task" });
    expect(db.wasInTransaction()).toBe(true);
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "tasks",
        inTransaction: true,
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          planId: "plan-1",
          title: "Draft launch checklist",
          date: new Date("2026-06-19T16:00:00.000Z"),
          daySegment: "afternoon",
          estimatedMinutes: 45,
          energyLevel: "medium",
          priority: "high",
          status: "todo",
        }),
      }),
    ]);
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "inbox_items",
        inTransaction: true,
        values: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    ]);
  });

  it("processes an inbox item into a routine", async () => {
    const db = createFakeDb({
      inboxItems: [{ id: "inbox-1", workspaceId: "workspace-1", title: "Read before bed" }],
    });

    const result = await processInboxItem(db, {
      workspaceId: "workspace-1",
      inboxItemId: "inbox-1",
      action: "routine",
      weekdayPattern: "mon,wed,fri",
      defaultTimeSegment: "morning",
      estimatedMinutes: 10,
    });

    expect(result).toEqual({ ok: true, action: "routine" });
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "routines",
        inTransaction: true,
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          title: "Read before bed",
          defaultTimeSegment: "morning",
          weekdayPattern: "mon,wed,fri",
          estimatedMinutes: 10,
          energyLevel: "low",
        }),
      }),
    ]);
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "inbox_items",
        inTransaction: true,
        values: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    ]);
  });

  it("deletes an inbox item without creating a task or routine", async () => {
    const db = createFakeDb({
      inboxItems: [{ id: "inbox-1", workspaceId: "workspace-1", title: "Discard this" }],
    });

    const result = await processInboxItem(db, {
      workspaceId: "workspace-1",
      inboxItemId: "inbox-1",
      action: "delete",
    });

    expect(result).toEqual({ ok: true, action: "delete" });
    expect(db.deletes).toEqual([expect.objectContaining({ table: "inbox_items", inTransaction: true })]);
    expect(db.inserts.filter((write) => write.table === "tasks" || write.table === "routines")).toEqual([]);
    expect(db.updates.filter((write) => write.table === "inbox_items")).toEqual([]);
  });

  it("creates manual and imported inbox items without mcp fallback", async () => {
    const db = createFakeDb();

    await createInboxItem(db, { workspaceId: "workspace-1", title: "Manual item", source: "manual" });
    await createInboxItem(db, { workspaceId: "workspace-1", title: "Imported item", source: "imported" });

    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "inbox_items",
        values: expect.objectContaining({ source: "manual" }),
      }),
      expect.objectContaining({
        table: "inbox_items",
        values: expect.objectContaining({ source: "imported" }),
      }),
    ]);
    expect(db.inserts.map((write) => write.values.source)).not.toContain("mcp");
  });

  it("does not accept mcp as an inbox item source", async () => {
    const db = createFakeDb();

    await expect(
      // @ts-expect-error MCP inbox semantics are intentionally undefined until Stage 3.
      createInboxItem(db, { workspaceId: "workspace-1", title: "MCP item", source: "mcp" }),
    ).rejects.toThrow("Invalid inbox source");
  });
});
