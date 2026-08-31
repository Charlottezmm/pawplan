import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { applyAgentPatch, rejectReviewPatches } from "@/lib/planning/patch-apply";

type PatchRow = {
  id: string;
  workspaceId: string;
  planId: string;
  status: "draft" | "applied" | "rejected";
  patchJson: {
    operations: Array<Record<string, unknown>>;
  };
};

function objectContainsValue(value: unknown, expected: string, seen = new WeakSet<object>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((child) => objectContainsValue(child, expected, seen));
}

function createFakeDb(
  patch: PatchRow,
  latestVersionNumber = 0,
  options: {
    taskSelectResults?: Array<Array<Record<string, unknown>>>;
    taskUpdateResults?: Array<Array<Record<string, unknown>>>;
    agentPatchUpdateResult?: Array<Record<string, unknown>>;
    selectRows?: Partial<Record<string, Array<Record<string, unknown>>>>;
  } = {},
) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const taskUpdateWhereClauses: unknown[] = [];
  let taskSelectCount = 0;
  let taskUpdateCount = 0;
  let inTransaction = false;

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  const tx = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                orderBy() {
                  return this;
                },
                limit() {
                  const limitValue = arguments[0] as number | undefined;
                  if (tableName(table) === "plan_versions") {
                    return Promise.resolve(latestVersionNumber ? [{ versionNumber: latestVersionNumber }] : []);
                  }
                  if (tableName(table) === "tasks") {
                    const result = options.taskSelectResults?.[taskSelectCount];
                    taskSelectCount += 1;
                    return Promise.resolve(result ?? []);
                  }
                  if (tableName(table) === "time_blocks") {
                    const rows = [
                      ...(options.selectRows?.time_blocks ?? []),
                      ...inserts
                        .map((insert, index) => ({ insert, index }))
                        .filter(({ insert }) => insert.table === "time_blocks")
                        .map(({ insert, index }) => ({ id: `time_blocks-${index + 1}`, ...insert.values })),
                    ];
                    return Promise.resolve(typeof limitValue === "number" ? rows.slice(0, limitValue) : rows);
                  }
                  if (options.selectRows?.[tableName(table)]) {
                    const rows = options.selectRows[tableName(table)] ?? [];
                    return Promise.resolve(typeof limitValue === "number" ? rows.slice(0, limitValue) : rows);
                  }
                  return Promise.resolve([patch]);
                },
                then(resolve: (value: Array<Record<string, unknown>>) => unknown, reject?: (reason: unknown) => unknown) {
                  const rows = tableName(table) === "time_blocks"
                    ? [
                        ...(options.selectRows?.time_blocks ?? []),
                        ...inserts
                          .map((insert, index) => ({ insert, index }))
                          .filter(({ insert }) => insert.table === "time_blocks")
                          .map(({ insert, index }) => ({ id: `time_blocks-${index + 1}`, ...insert.values })),
                      ]
                    : options.selectRows?.[tableName(table)] ?? [patch];
                  return Promise.resolve(rows).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: unknown) {
              updates.push({ table: tableName(table), values });
              if (tableName(table) === "tasks") {
                taskUpdateWhereClauses.push(condition);
              }
              return {
                returning() {
                  if (tableName(table) === "tasks") {
                    const result = options.taskUpdateResults?.[taskUpdateCount];
                    taskUpdateCount += 1;
                    if (result) return Promise.resolve(result);
                  }
                  if (tableName(table) === "agent_patches" && options.agentPatchUpdateResult) {
                    return Promise.resolve(options.agentPatchUpdateResult);
                  }
                  return Promise.resolve([{ id: values.currentVersionId ?? "updated" }]);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown> | Array<Record<string, unknown>>) {
          const rows = Array.isArray(values) ? values : [values];
          for (const row of rows) {
            inserts.push({ table: tableName(table), values: row });
          }
          const builder = {
            onConflictDoNothing() {
              return builder;
            },
            returning() {
              return Promise.resolve(
                rows.map((row, index) => ({
                  id: `${tableName(table)}-${inserts.length - rows.length + index + 1}`,
                  versionNumber: row.versionNumber,
                  ...row,
                })),
              );
            },
          };
          return builder;
        },
      };
    },
  };

  return {
    updates,
    inserts,
    taskUpdateWhereClauses,
    transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => {
      inTransaction = true;
      return callback(tx);
    },
    wasInTransaction: () => inTransaction,
    taskUpdateWhereContains: (expected: string) =>
      taskUpdateWhereClauses.every((condition) => objectContainsValue(condition, expected)),
  };
}

function createBulkRejectDb(options: {
  activePlanId?: string | null;
  rejectedPatches?: PatchRow[];
  remainingDrafts?: Array<{ id: string }>;
  auditError?: Error;
} = {}) {
  const updates: Array<{ table: string; values: Record<string, unknown>; condition: unknown }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const activePlanId = options.activePlanId === undefined ? "plan-1" : options.activePlanId;
  const rejectedPatches = options.rejectedPatches ?? [];
  let selectCount = 0;

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  const tx = {
    select() {
      selectCount += 1;
      const currentSelect = selectCount;
      return {
        from(table: unknown) {
          return {
            where() {
              if (tableName(table) === "plans") {
                return {
                  limit: () => Promise.resolve(activePlanId ? [{ id: activePlanId }] : []),
                };
              }
              if (tableName(table) === "agent_patches" && currentSelect > 1) {
                return Promise.resolve(options.remainingDrafts ?? []);
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: unknown) {
              updates.push({ table: tableName(table), values, condition });
              return {
                returning: () => Promise.resolve(rejectedPatches),
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown> | Array<Record<string, unknown>>) {
          if (options.auditError) return Promise.reject(options.auditError);
          const rows = Array.isArray(values) ? values : [values];
          inserts.push(...rows.map((row) => ({ table: tableName(table), values: row })));
          return Promise.resolve();
        },
      };
    },
  };

  return {
    updates,
    inserts,
    transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
  };
}

describe("rejectReviewPatches", () => {
  it("atomically rejects the confirmed draft snapshot and persists one full rejection audit per patch", async () => {
    const db = createBulkRejectDb({
      rejectedPatches: [
        {
          id: "patch-1",
          workspaceId: "workspace-1",
          planId: "plan-1",
          status: "draft",
          patchJson: {
            operations: [
              {
                type: "move_task",
                task_id: "task-1",
                from_date: "2026-07-10",
                from_day_segment: "morning",
                to_date: "2026-07-11",
                to_day_segment: "afternoon",
                reason: "Move it later",
              },
              {
                type: "change_priority",
                task_id: "task-2",
                from_priority: "normal",
                to_priority: "high",
                reason: "Deadline is closer",
              },
            ],
          },
        },
        {
          id: "patch-2",
          workspaceId: "workspace-1",
          planId: "plan-1",
          status: "draft",
          patchJson: { operations: [] },
        },
      ],
      remainingDrafts: [{ id: "concurrent-patch" }],
    });

    const result = await rejectReviewPatches(db, {
      workspaceId: "workspace-1",
      patchIds: ["patch-1", "patch-2", "patch-1"],
    });

    expect(result).toEqual({
      status: "succeeded",
      planId: "plan-1",
      requestedPatchCount: 2,
      rejectedPatchCount: 2,
      rejectedOperationCount: 2,
      rejectedPatchIds: ["patch-1", "patch-2"],
      remainingDraftCount: 1,
    });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toEqual(expect.objectContaining({
      table: "agent_patches",
      values: { status: "rejected" },
    }));
    for (const expected of ["workspace-1", "plan-1", "draft", "patch-1", "patch-2"]) {
      expect(objectContainsValue(db.updates[0].condition, expected)).toBe(true);
    }
    expect(db.inserts).toEqual([
      {
        table: "agent_patch_reviews",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          patchId: "patch-1",
          planId: "plan-1",
          acceptedOperationIndexes: [],
          rejectedOperationIndexes: [0, 1],
          skippedJson: [],
          conflictJson: [],
        }),
      },
      {
        table: "agent_patch_reviews",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          patchId: "patch-2",
          planId: "plan-1",
          acceptedOperationIndexes: [],
          rejectedOperationIndexes: [],
          skippedJson: [],
          conflictJson: [],
        }),
      },
    ]);
    expect([...db.updates, ...db.inserts].map((write) => write.table)).not.toEqual(
      expect.arrayContaining(["tasks", "plans", "plan_versions", "change_logs", "time_blocks"]),
    );
  });

  it("is idempotent when the confirmed drafts are already closed", async () => {
    const db = createBulkRejectDb();

    const result = await rejectReviewPatches(db, {
      workspaceId: "workspace-1",
      patchIds: ["patch-1"],
    });

    expect(result).toEqual(expect.objectContaining({
      status: "no_change",
      rejectedPatchCount: 0,
      rejectedOperationCount: 0,
      rejectedPatchIds: [],
      remainingDraftCount: 0,
    }));
    expect(db.inserts).toEqual([]);
  });

  it("fails before patch writes when the workspace has no active plan", async () => {
    const db = createBulkRejectDb({ activePlanId: null });

    await expect(
      rejectReviewPatches(db, { workspaceId: "workspace-1", patchIds: ["patch-1"] }),
    ).rejects.toThrow("No active plan");
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("propagates audit failures so the transaction can roll back the claimed patches", async () => {
    const db = createBulkRejectDb({
      rejectedPatches: [
        {
          id: "patch-1",
          workspaceId: "workspace-1",
          planId: "plan-1",
          status: "draft",
          patchJson: { operations: [] },
        },
      ],
      auditError: new Error("audit unavailable"),
    });

    await expect(
      rejectReviewPatches(db, { workspaceId: "workspace-1", patchIds: ["patch-1"] }),
    ).rejects.toThrow("audit unavailable");
  });

  it("rejects legacy malformed patch payloads without executing or strictly parsing their operations", async () => {
    const db = createBulkRejectDb({
      rejectedPatches: [
        {
          id: "patch-legacy",
          workspaceId: "workspace-1",
          planId: "plan-1",
          status: "draft",
          patchJson: { operations: "legacy-json" } as unknown as PatchRow["patchJson"],
        },
      ],
    });

    const result = await rejectReviewPatches(db, {
      workspaceId: "workspace-1",
      patchIds: ["patch-legacy"],
    });

    expect(result).toEqual(expect.objectContaining({
      status: "succeeded",
      rejectedPatchCount: 1,
      rejectedOperationCount: 0,
    }));
    expect(db.inserts[0].values).toEqual(expect.objectContaining({
      patchId: "patch-legacy",
      rejectedOperationIndexes: [],
      skippedJson: [{ reason: "Draft operations were unavailable during rejection" }],
    }));
  });
});

describe("applyAgentPatch", () => {
  it("rejects empty accepted operation lists", async () => {
    const db = createFakeDb({
      id: "patch-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: { operations: [] },
    });

    await expect(
      applyAgentPatch(db, {
        workspaceId: "workspace-1",
        patchId: "patch-1",
        acceptedOperationIndexes: [],
      }),
    ).rejects.toThrow("Select at least one operation to apply");
  });

  it("applies selected supported operations and persists review audit for accepted, rejected, and skipped indexes", async () => {
    const db = createFakeDb({
      id: "patch-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [
          {
            type: "move_task",
            task_id: "task-move",
            from_date: "2026-06-10",
            from_day_segment: "morning",
            to_date: "2026-06-11",
            to_day_segment: "afternoon",
            reason: "Move it out of a full morning.",
          },
          {
            type: "change_priority",
            task_id: "task-priority",
            from_priority: "normal",
            to_priority: "high",
            reason: "Deadline moved earlier.",
          },
          {
            type: "split_task",
            task_id: "task-split",
            new_tasks: [{ title: "Outline", estimated_minutes: 30, day_segment: "morning" }],
            reason: "Too large for one block.",
          },
        ],
      },
    }, 3, {
      taskSelectResults: [
        [{ id: "task-move", date: new Date("2026-06-10T00:00:00.000Z"), daySegment: "morning" }],
      ],
    });

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-1",
      acceptedOperationIndexes: [0, 2],
      rejectedOperationIndexes: [1],
    });

    expect(db.wasInTransaction()).toBe(true);
    expect(result.status).toBe("applied");
    expect(result.applied.map((operation) => operation.type)).toEqual(["move_task"]);
    expect(result.skipped).toEqual([{ index: 2, type: "split_task", reason: "Unsupported operation for apply v0.1" }]);
    expect(result.conflicts).toEqual([]);
    expect(db.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "tasks",
          values: expect.objectContaining({
            date: new Date("2026-06-10T16:00:00.000Z"),
            daySegment: "afternoon",
          }),
        }),
        expect.objectContaining({
          table: "plans",
          values: expect.objectContaining({ currentVersionId: "plan_versions-1" }),
        }),
        expect.objectContaining({
          table: "agent_patches",
          values: expect.objectContaining({ status: "applied", appliedAt: expect.any(Date) }),
        }),
      ]),
    );
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "plan_versions",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            versionNumber: 4,
            source: "agent_patch",
          }),
        }),
        expect.objectContaining({
          table: "change_logs",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            source: "agent_patch",
            detailsJson: expect.objectContaining({
              patchId: "patch-1",
              acceptedOperationIndexes: [0, 2],
              rejectedOperationIndexes: [1],
              skipped: [{ index: 2, type: "split_task", reason: "Unsupported operation for apply v0.1" }],
            }),
          }),
        }),
        expect.objectContaining({
          table: "agent_patch_reviews",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            patchId: "patch-1",
            acceptedOperationIndexes: [0, 2],
            rejectedOperationIndexes: [1],
            skippedJson: [{ index: 2, type: "split_task", reason: "Unsupported operation for apply v0.1" }],
            conflictJson: [],
          }),
        }),
      ]),
    );
  });

  it("skips missing task updates and keeps skipped details in the apply result", async () => {
    const db = createFakeDb(
      {
        id: "patch-1",
        workspaceId: "workspace-1",
        planId: "plan-1",
        status: "draft",
        patchJson: {
          operations: [
            {
              type: "move_task",
              task_id: "task-missing",
              from_date: "2026-06-10",
              from_day_segment: "morning",
              to_date: "2026-06-11",
              to_day_segment: "afternoon",
              reason: "Move it out of a full morning.",
            },
            {
              type: "change_priority",
              task_id: "task-priority",
              from_priority: "normal",
              to_priority: "high",
              reason: "Deadline moved earlier.",
            },
          ],
        },
      },
      3,
      {
        taskSelectResults: [
          [{ id: "task-missing", date: new Date("2026-06-10T00:00:00.000Z"), daySegment: "morning" }],
          [{ id: "task-priority", priority: "normal" }],
        ],
        taskUpdateResults: [[], [{ id: "task-priority" }]],
      },
    );

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-1",
      acceptedOperationIndexes: [0, 1],
    });

    expect(result.applied).toEqual([
      { index: 1, type: "change_priority", taskId: "task-priority", action: "updated task priority" },
    ]);
    expect(result.skipped).toEqual([{ index: 0, type: "move_task", reason: "Task not found" }]);
    expect(db.taskUpdateWhereContains("plan_id")).toBe(true);
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "plan_versions",
          values: expect.objectContaining({
            snapshot: expect.objectContaining({
              applied: result.applied,
              skipped: result.skipped,
            }),
          }),
        }),
        expect.objectContaining({
          table: "change_logs",
          values: expect.objectContaining({
            detailsJson: expect.objectContaining({
              applied: result.applied,
              skipped: result.skipped,
            }),
          }),
        }),
      ]),
    );
  });

  it("persists review audit and returns conflicts when a selected move_task is stale", async () => {
    const db = createFakeDb({
      id: "patch-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [
          {
            type: "move_task",
            task_id: "task-stale",
            from_date: "2026-06-10",
            from_day_segment: "morning",
            to_date: "2026-06-11",
            to_day_segment: "afternoon",
            reason: "Move it out of a full morning.",
          },
        ],
      },
    }, 3, {
      taskSelectResults: [
        [{ id: "task-stale", date: new Date("2026-06-12T00:00:00.000Z"), daySegment: "evening" }],
      ],
    });

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-1",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("conflicted");
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ index: 0, type: "move_task", reason: "Task changed since patch was proposed" }]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        index: 0,
        type: "move_task",
        reason: "Task changed since patch was proposed",
        expected: { date: "2026-06-10", daySegment: "morning" },
        actual: { date: "2026-06-12", daySegment: "evening" },
      }),
    ]);
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "agent_patch_reviews",
          values: expect.objectContaining({
            acceptedOperationIndexes: [0],
            rejectedOperationIndexes: [],
            skippedJson: result.skipped,
            conflictJson: result.conflicts,
          }),
        }),
      ]),
    );
    expect(db.inserts.filter((insert) => insert.table === "plan_versions" || insert.table === "change_logs")).toEqual([]);
    expect(db.updates.filter((update) => update.table === "plans" || update.table === "agent_patches")).toEqual([]);
  });

  it("increments rollover metadata only after an overdue Review move is accepted", async () => {
    const targetDate = new Date("2026-08-15T16:00:00.000Z");
    const db = createFakeDb({
      id: "patch-overdue",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [{
          type: "move_task",
          task_id: "task-overdue",
          from_date: "2026-08-14",
          from_day_segment: "morning",
          to_date: "2026-08-16",
          to_day_segment: "morning",
          overdue_rollover: true,
          expected_rollover_count: 0,
          reason: "首次逾期，安排到下一个安全时段。",
        }],
      },
    }, 0, {
      taskSelectResults: [[{
        id: "task-overdue",
        date: new Date("2026-08-13T16:00:00.000Z"),
        daySegment: "morning",
        status: "todo",
        rolloverCount: 0,
        estimatedMinutes: 60,
      }]],
      taskUpdateResults: [[{
        id: "task-overdue",
        date: targetDate,
        daySegment: "morning",
        status: "todo",
        rolloverCount: 1,
        lastRolloverAt: new Date("2026-08-15T10:00:00.000Z"),
      }]],
    });

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-overdue",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("applied");
    expect(result.applied[0]).toEqual(expect.objectContaining({
      taskId: "task-overdue",
      readback: expect.objectContaining({
        date: "2026-08-16",
        daySegment: "morning",
        status: "todo",
        rolloverCount: 1,
      }),
    }));
    expect(db.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "tasks",
        values: expect.objectContaining({
          date: targetDate,
          daySegment: "morning",
          rolloverCount: 1,
          lastRolloverAt: expect.any(Date),
        }),
      }),
    ]));
  });

  it("applies an overdue Review move regardless of other scheduled task minutes", async () => {
    const db = createFakeDb({
      id: "patch-overdue",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [{
          type: "move_task",
          task_id: "task-overdue",
          from_date: "2026-08-14",
          from_day_segment: "morning",
          to_date: "2026-08-16",
          to_day_segment: "morning",
          overdue_rollover: true,
          expected_rollover_count: 0,
          reason: "首次逾期，安排到下一个安全时段。",
        }],
      },
    }, 0, {
      taskSelectResults: [[{
        id: "task-overdue",
        date: new Date("2026-08-13T16:00:00.000Z"),
        daySegment: "morning",
        status: "todo",
        rolloverCount: 0,
        estimatedMinutes: 60,
      }]],
      taskUpdateResults: [[{
        id: "task-overdue",
        date: new Date("2026-08-15T16:00:00.000Z"),
        daySegment: "morning",
        status: "todo",
        rolloverCount: 1,
        lastRolloverAt: new Date("2026-08-15T10:00:00.000Z"),
      }]],
    });

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-overdue",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("applied");
    expect(result.conflicts).toEqual([]);
    expect(db.updates.filter((update) => update.table === "tasks")).toHaveLength(1);
  });

  it("returns conflicts when a selected change_priority is stale", async () => {
    const db = createFakeDb({
      id: "patch-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [
          {
            type: "change_priority",
            task_id: "task-priority",
            from_priority: "normal",
            to_priority: "high",
            reason: "Deadline moved earlier.",
          },
        ],
      },
    }, 3, {
      taskSelectResults: [[{ id: "task-priority", priority: "urgent" }]],
    });

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-1",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("conflicted");
    expect(result.skipped).toEqual([{ index: 0, type: "change_priority", reason: "Task priority changed since patch was proposed" }]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        index: 0,
        type: "change_priority",
        expected: { priority: "normal" },
        actual: { priority: "urgent" },
      }),
    ]);
  });

  it("ignores legacy over-capacity metadata on accepted operations", async () => {
    const db = createFakeDb({
      id: "patch-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [
          {
            type: "move_task",
            task_id: "task-1",
            from_date: "2026-06-10",
            from_day_segment: "morning",
            to_date: "2026-06-10",
            to_day_segment: "afternoon",
            protected_over_capacity: true,
            protected_over_capacity_reason: "Afternoon is already over capacity because of protected blocks.",
            reason: "Try to move it later.",
          },
        ],
      },
    }, 3, {
      taskSelectResults: [[{
        id: "task-1",
        date: new Date("2026-06-09T16:00:00.000Z"),
        daySegment: "morning",
        status: "todo",
        rolloverCount: 0,
      }]],
      taskUpdateResults: [[{
        id: "task-1",
        date: new Date("2026-06-09T16:00:00.000Z"),
        daySegment: "afternoon",
        status: "todo",
        rolloverCount: 0,
      }]],
    });

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-1",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("applied");
    expect(result.skipped).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(db.updates.filter((update) => update.table === "tasks")).toHaveLength(1);
    expect(db.inserts.filter((insert) => insert.table === "agent_patch_reviews")).toHaveLength(1);
  });

  it("marks a patch rejected and writes review audit when all operations are explicitly rejected", async () => {
    const db = createFakeDb({
      id: "patch-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [
          {
            type: "change_priority",
            task_id: "task-priority",
            from_priority: "normal",
            to_priority: "high",
            reason: "Deadline moved earlier.",
          },
        ],
      },
    }, 3);

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-1",
      acceptedOperationIndexes: [],
      rejectedOperationIndexes: [0],
    });

    expect(result.status).toBe("rejected");
    expect(result.applied).toEqual([]);
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "agent_patch_reviews",
          values: expect.objectContaining({
            acceptedOperationIndexes: [],
            rejectedOperationIndexes: [0],
            skippedJson: [],
            conflictJson: [],
          }),
        }),
      ]),
    );
    expect(db.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "agent_patches",
          values: expect.objectContaining({ status: "rejected" }),
        }),
      ]),
    );
    expect(db.inserts.filter((insert) => insert.table === "plan_versions" || insert.table === "change_logs")).toEqual([]);
  });

  it("returns conflicted review when selected operations cannot be applied without writing plan versions", async () => {
    const db = createFakeDb({
      id: "patch-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [
          {
            type: "move_task",
            task_id: "task-missing",
            from_date: "2026-06-10",
            from_day_segment: "morning",
            to_date: "2026-06-11",
            to_day_segment: "afternoon",
            reason: "Move it out of a full morning.",
          },
        ],
      },
    }, 3, { taskSelectResults: [[]] });

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-1",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("conflicted");
    expect(result.skipped).toEqual([{ index: 0, type: "move_task", reason: "Task not found" }]);
    expect(db.inserts.filter((insert) => insert.table === "agent_patch_reviews")).toHaveLength(1);
    expect(db.inserts.filter((insert) => insert.table === "plan_versions" || insert.table === "change_logs")).toEqual([]);
    expect(db.updates.filter((update) => update.table === "plans" || update.table === "agent_patches")).toEqual([]);
  });

  it("rolls back when marking the draft patch applied does not update a row", async () => {
    const db = createFakeDb(
      {
        id: "patch-1",
        workspaceId: "workspace-1",
        planId: "plan-1",
        status: "draft",
        patchJson: {
          operations: [
            {
              type: "change_priority",
              task_id: "task-priority",
              from_priority: "normal",
              to_priority: "high",
              reason: "Deadline moved earlier.",
            },
          ],
        },
      },
      3,
      { taskSelectResults: [[{ id: "task-priority", priority: "normal" }]], agentPatchUpdateResult: [] },
    );

    await expect(
      applyAgentPatch(db, {
        workspaceId: "workspace-1",
        patchId: "patch-1",
        acceptedOperationIndexes: [0],
      }),
    ).rejects.toMatchObject({ message: "Draft patch not found", status: 404 });
  });

  it("persists a conflicted review for impossible calendar dates without writing plan versions", async () => {
    const db = createFakeDb({
      id: "patch-1",
      workspaceId: "workspace-1",
      planId: "plan-1",
      status: "draft",
      patchJson: {
        operations: [
          {
            type: "move_task",
            task_id: "task-move",
            from_date: "2026-02-28",
            from_day_segment: "morning",
            to_date: "2026-02-31",
            to_day_segment: "afternoon",
            reason: "Move it out of a full morning.",
          },
        ],
      },
    }, 3);

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-1",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("conflicted");
    expect(result.skipped).toEqual([{ index: 0, type: "move_task", reason: "Invalid target date" }]);
    expect(db.inserts.filter((insert) => insert.table === "agent_patch_reviews")).toHaveLength(1);
    expect(db.inserts.filter((insert) => insert.table === "plan_versions" || insert.table === "change_logs")).toEqual([]);
    expect(db.updates.filter((update) => update.table === "plans" || update.table === "agent_patches")).toEqual([]);
  });

  it("applies a user-accepted timetable import draft by creating courses and time blocks", async () => {
    const db = createFakeDb(
      {
        id: "patch-timetable",
        workspaceId: "workspace-1",
        planId: "plan-1",
        status: "draft",
        patchJson: {
          operations: [
            {
              type: "import_timetable",
              source_label: "summer timetable",
              rows: [
                {
                  title: "Embodied AI seminar",
                  kind: "course",
                  dayOfWeek: "monday",
                  startTime: "09:00",
                  endTime: "10:30",
                  startsOn: "2026-06-15",
                  endsOn: "2026-06-22",
                  course: "Embodied AI",
                  location: "Room 204",
                  recurrence: null,
                  notes: null,
                },
              ],
              reason: "Import course constraints after user review.",
            },
          ],
        },
      },
      4,
      {
        selectRows: {
          time_blocks: [],
          courses: [],
        },
      },
    );

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-timetable",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("applied");
    expect(result.applied).toEqual([
      expect.objectContaining({
        index: 0,
        type: "import_timetable",
        action: "imported 1 timetable blocks",
      }),
    ]);
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "courses",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            name: "Embodied AI",
          }),
        }),
        expect.objectContaining({
          table: "time_blocks",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            title: "Embodied AI seminar",
            kind: "course",
            startsAt: new Date("2026-06-15T01:00:00.000Z"),
            endsAt: new Date("2026-06-22T02:30:00.000Z"),
            courseId: "courses-1",
            location: "Room 204",
            recurrenceWeekdayMask: 2,
            movable: false,
          }),
        }),
        expect.objectContaining({
          table: "agent_patch_reviews",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            patchId: "patch-timetable",
            acceptedOperationIndexes: [0],
          }),
        }),
      ]),
    );
  });

  it("persists a conflicted review for overlapping timetable imports without writing constraints", async () => {
    const db = createFakeDb(
      {
        id: "patch-timetable",
        workspaceId: "workspace-1",
        planId: "plan-1",
        status: "draft",
        patchJson: {
          operations: [
            {
              type: "import_timetable",
              source_label: "summer timetable",
              rows: [
                {
                  title: "Embodied AI seminar",
                  kind: "course",
                  dayOfWeek: "monday",
                  startTime: "09:00",
                  endTime: "10:30",
                  startsOn: "2026-06-15",
                  endsOn: "2026-06-15",
                  course: "Embodied AI",
                  recurrence: null,
                  notes: null,
                },
              ],
              reason: "Import course constraints after user review.",
            },
          ],
        },
      },
      4,
      {
        selectRows: {
          time_blocks: [
            {
              title: "Existing block",
              startsAt: new Date("2026-06-15T01:30:00.000Z"),
              endsAt: new Date("2026-06-15T02:00:00.000Z"),
            },
          ],
          courses: [],
        },
      },
    );

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-timetable",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("conflicted");
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        index: 0,
        type: "import_timetable",
        reason: "Timetable import overlaps existing blocks",
        actual: expect.objectContaining({ overlapCount: 1 }),
      }),
    ]);
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "agent_patch_reviews",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          patchId: "patch-timetable",
          acceptedOperationIndexes: [0],
        }),
      }),
    ]);
    expect(db.inserts.filter((insert) => insert.table === "courses" || insert.table === "time_blocks")).toEqual([]);
    expect(db.inserts.filter((insert) => insert.table === "plan_versions" || insert.table === "change_logs")).toEqual([]);
    expect(db.updates.filter((update) => update.table === "plans" || update.table === "agent_patches")).toEqual([]);
  });

  it("checks timetable import overlaps beyond the first 100 existing blocks before writing constraints", async () => {
    const nonOverlappingBlocks = Array.from({ length: 100 }, (_, index) => ({
      title: `Existing block ${index + 1}`,
      startsAt: new Date(`2026-06-16T${String(index % 10).padStart(2, "0")}:00:00.000Z`),
      endsAt: new Date(`2026-06-16T${String(index % 10).padStart(2, "0")}:30:00.000Z`),
    }));
    const db = createFakeDb(
      {
        id: "patch-timetable",
        workspaceId: "workspace-1",
        planId: "plan-1",
        status: "draft",
        patchJson: {
          operations: [
            {
              type: "import_timetable",
              source_label: "summer timetable",
              rows: [
                {
                  title: "Embodied AI seminar",
                  kind: "course",
                  dayOfWeek: "monday",
                  startTime: "09:00",
                  endTime: "10:30",
                  startsOn: "2026-06-15",
                  endsOn: "2026-06-15",
                  course: "Embodied AI",
                  recurrence: null,
                  notes: null,
                },
              ],
              reason: "Import course constraints after user review.",
            },
          ],
        },
      },
      4,
      {
        selectRows: {
          time_blocks: [
            ...nonOverlappingBlocks,
            {
              title: "Existing block 101",
              startsAt: new Date("2026-06-15T01:30:00.000Z"),
              endsAt: new Date("2026-06-15T02:00:00.000Z"),
            },
          ],
          courses: [],
        },
      },
    );

    const result = await applyAgentPatch(db, {
      workspaceId: "workspace-1",
      patchId: "patch-timetable",
      acceptedOperationIndexes: [0],
    });

    expect(result.status).toBe("conflicted");
    expect(result.conflicts[0]).toEqual(
      expect.objectContaining({
        reason: "Timetable import overlaps existing blocks",
        actual: expect.objectContaining({ overlapCount: 1 }),
      }),
    );
    expect(db.inserts.filter((insert) => insert.table === "courses" || insert.table === "time_blocks")).toEqual([]);
  });
});
