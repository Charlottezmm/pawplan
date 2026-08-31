import { getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changeLogs,
  planOperations,
  plans,
  planVersions,
  planWindowRevisions,
  planWindowTaskRefs,
  projectMilestones,
  projects,
  tasks,
} from "@/lib/db/schema";
import {
  previewReplacePlanWindow,
  replacePlanWindow,
  type ReplacePlanWindowInput,
} from "@/lib/mcp/replace-plan-window";

type Row = Record<string, any>;

function createDb(options: { failTaskInsert?: boolean; failPostCommitReadback?: boolean; needsDefinition?: boolean } = {}) {
  const now = new Date("2026-08-16T00:00:00.000+08:00");
  const tables: Record<string, Row[]> = {
    plans: [{
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Long plan",
      startDate: new Date("2026-08-01T00:00:00.000+08:00"),
      endDate: new Date("2026-12-31T00:00:00.000+08:00"),
      status: "active",
      currentVersionId: "22222222-2222-4222-8222-222222222222",
      baselineSnapshot: {},
      updatedAt: now,
    }],
    projects: [{
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Physics-Grounded Manipulation",
      color: "#7c3aed",
      category: "科研",
      objective: "Reproduce and analyze manipulation methods",
      successCriteria: "Experiment report accepted",
      status: "active",
      priority: "high",
      startDate: null,
      targetDate: new Date("2026-12-01T00:00:00.000+08:00"),
      weeklyTargetMinutes: 600,
      needsDefinition: options.needsDefinition ?? false,
      createdAt: now,
      updatedAt: now,
    }],
    project_milestones: [],
    tasks: [{
      id: "44444444-4444-4444-8444-444444444444",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      planId: "11111111-1111-4111-8111-111111111111",
      title: "Old baseline task",
      notes: null,
      date: new Date("2026-08-20T00:00:00.000+08:00"),
      daySegment: "morning",
      status: "todo",
      blocked: false,
      priority: "normal",
      estimatedMinutes: 30,
      energyLevel: "medium",
      isChore: false,
      movable: true,
      projectId: "33333333-3333-4333-8333-333333333333",
      milestoneId: null,
      courseId: null,
      trackId: null,
      parentTaskId: null,
      originalDate: new Date("2026-08-20T00:00:00.000+08:00"),
      rolloverCount: 0,
      lastRolloverAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }],
    plan_window_task_refs: [{
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      planId: "11111111-1111-4111-8111-111111111111",
      sourceKey: "roadmap-sync",
      externalTaskKey: "baseline",
      taskId: "44444444-4444-4444-8444-444444444444",
      revisionId: "55555555-5555-4555-8555-555555555555",
    }],
    plan_versions: [{
      id: "22222222-2222-4222-8222-222222222222",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      planId: "11111111-1111-4111-8111-111111111111",
      versionNumber: 1,
      snapshot: {},
      source: "baseline",
      createdAt: now,
    }],
    plan_operations: [],
    operation_approvals: [],
    plan_window_revisions: [],
    change_logs: [],
    time_blocks: [],
    routines: [],
    day_capacities: [],
  };
  const ids: Record<string, number> = {};
  let failTaskInsert = options.failTaskInsert ?? false;
  let transactionDepth = 0;
  let successfulTransactions = 0;

  function name(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function nextId(table: string) {
    ids[table] = (ids[table] ?? 0) + 1;
    const suffix = String(ids[table]).padStart(12, "0");
    return `99999999-9999-4999-8999-${suffix}`;
  }

  function selectable(rows: Row[]) {
    const query: any = {
      orderBy: () => query,
      limit: (count: number) => selectable(rows.slice(0, count)),
      for: () => Promise.resolve(rows),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  }

  function createClient() {
    return {
      select() {
        return {
          from(table: unknown) {
            if (
              options.failPostCommitReadback &&
              transactionDepth === 0 &&
              successfulTransactions >= 2 &&
              name(table) === "tasks"
            ) {
              throw new Error("injected post-commit readback failure");
            }
            const rows = () => tables[name(table)] ?? [];
            return {
              where() {
                return selectable(rows());
              },
            };
          },
        };
      },
      insert(table: unknown) {
        const tableName = name(table);
        return {
          values(values: Row | Row[]) {
            const inputRows = Array.isArray(values) ? values : [values];
            let conflictMode: "nothing" | "update" | null = null;
            let conflictSet: Row = {};
            let completed: Row[] | null = null;
            function commit() {
              if (completed) return completed;
              if (tableName === "tasks" && failTaskInsert) {
                failTaskInsert = false;
                throw new Error("injected task insert failure");
              }
              const stored = tables[tableName] ?? (tables[tableName] = []);
              if (tableName === "plan_operations" && conflictMode === "nothing") {
                const row = inputRows[0];
                const existing = stored.find(
                  (item) => item.workspaceId === row.workspaceId && item.idempotencyKey === row.idempotencyKey,
                );
                if (existing) return (completed = []);
              }
              if (tableName === "plan_window_task_refs" && conflictMode === "update") {
                const row = inputRows[0];
                const existing = stored.find(
                  (item) => item.planId === row.planId && item.sourceKey === row.sourceKey && item.externalTaskKey === row.externalTaskKey,
                );
                if (existing) {
                  Object.assign(existing, conflictSet);
                  return (completed = [existing]);
                }
              }
              completed = inputRows.map((row) => {
                const storedRow = {
                  ...(tableName === "plan_window_task_refs" ? {} : { id: nextId(tableName) }),
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: tableName === "tasks" ? null : undefined,
                  ...row,
                };
                stored.push(storedRow);
                return storedRow;
              });
              return completed;
            }
            const builder: any = {
              onConflictDoNothing() {
                conflictMode = "nothing";
                return builder;
              },
              onConflictDoUpdate(args: { set: Row }) {
                conflictMode = "update";
                conflictSet = args.set;
                return builder;
              },
              returning: () => Promise.resolve().then(commit),
              then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                Promise.resolve().then(commit).then(resolve, reject),
            };
            return builder;
          },
        };
      },
      update(table: unknown) {
        const tableName = name(table);
        return {
          set(values: Row) {
            return {
              where() {
                const rows = tables[tableName] ?? [];
                for (const row of rows) Object.assign(row, values);
                const result = rows;
                const query: any = {
                  returning: () => Promise.resolve(result),
                  then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                    Promise.resolve(result).then(resolve, reject),
                };
                return query;
              },
            };
          },
        };
      },
    };
  }

  const client = createClient();
  return {
    tables,
    ...client,
    transaction: async <T>(callback: (tx: ReturnType<typeof createClient>) => Promise<T>) => {
      const snapshot = structuredClone(tables);
      transactionDepth += 1;
      try {
        const result = await callback(client);
        successfulTransactions += 1;
        return result;
      } catch (error) {
        for (const key of Object.keys(tables)) delete tables[key];
        Object.assign(tables, snapshot);
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
  };
}

function input(): ReplacePlanWindowInput {
  return {
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    dateFrom: "2026-08-16",
    dateTo: "2026-09-01",
    sourceKey: "roadmap-sync",
    expectedPlanId: "11111111-1111-4111-8111-111111111111",
    expectedCurrentVersionId: "22222222-2222-4222-8222-222222222222",
    retireScope: "source_managed",
    tasks: [{
      externalTaskKey: "baseline",
      title: "Reproduce baseline and record results",
      projectId: "33333333-3333-4333-8333-333333333333",
      date: "2026-08-20",
      daySegment: "morning",
      estimatedMinutes: 90,
      priority: "high",
      energyLevel: "high",
    }],
    weeklySummaries: [{ weekStart: "2026-08-17", focus: "Baseline" }],
    monthlySummaries: [{ month: "2026-08", goal: "Reproduce baseline" }],
    focusProjectIds: ["33333333-3333-4333-8333-333333333333"],
    idempotencyKey: "replace-window-1",
    createdBy: "codex",
    now: new Date("2026-08-16T08:00:00.000+08:00"),
  };
}

async function prepareApprovedReplace(db: ReturnType<typeof createDb>, request: ReplacePlanWindowInput) {
  const preview = await previewReplacePlanWindow(db, request);
  const approval = db.tables.operation_approvals.find((row) => row.id === preview.approvalId)!;
  approval.status = "approved";
  approval.approvedAt = request.now;
  request.previewToken = preview.previewToken;
  request.approvalId = preview.approvalId;
  return preview;
}

describe("replace plan window", () => {
  beforeEach(() => {
    process.env.APP_SECRET = "replace-window-test-secret";
  });

  afterEach(() => {
    delete process.env.APP_SECRET;
  });

  it("previews exact archive/create changes without applying a workload limit", async () => {
    const db = createDb();
    const before = structuredClone(db.tables.tasks);
    const request = input();
    request.tasks[0].estimatedMinutes = 600;
    db.tables.day_capacities.push({
      workspaceId: request.workspaceId,
      date: new Date("2026-08-20T00:00:00.000+08:00"),
      morningMinutes: 0,
      afternoonMinutes: 0,
      eveningMinutes: 0,
    });

    const preview = await previewReplacePlanWindow(db, request);

    expect(preview).toEqual(expect.objectContaining({
      status: "preview",
      planId: input().expectedPlanId,
      diff: expect.objectContaining({
        replaceTaskIds: ["44444444-4444-4444-8444-444444444444"],
        wouldArchiveTaskIds: ["44444444-4444-4444-8444-444444444444"],
      }),
      conflicts: [],
      previewToken: expect.any(String),
      liveUnchanged: true,
    }));
    expect(db.tables.tasks).toEqual(before);
    expect(db.tables.plan_operations).toEqual([]);
  });

  it("rejects undefined Projects in preview instead of guessing by name", async () => {
    const db = createDb({ needsDefinition: true });

    const preview = await previewReplacePlanWindow(db, input());

    expect(preview.status).toBe("needs_decision");
    expect(preview.conflicts).toEqual([
      expect.objectContaining({ code: "project_definition_incomplete" }),
    ]);
    expect(preview.approvalId).toBeUndefined();
    expect(db.tables.operation_approvals).toEqual([]);
    expect(db.tables.tasks[0].archivedAt).toBeNull();
  });

  it("preserves completed tasks even for explicit all-non-completed replacement", async () => {
    const db = createDb();
    db.tables.tasks.push({
      ...structuredClone(db.tables.tasks[0]),
      id: "66666666-6666-4666-8666-666666666666",
      title: "Completed experiment",
      status: "done",
      updatedAt: new Date("2026-08-16T00:00:00.000+08:00"),
    });
    const request = input();
    request.retireScope = "all_non_completed";

    const preview = await previewReplacePlanWindow(db, request);

    expect(preview.diff.preservedDoneTaskIds).toContain("66666666-6666-4666-8666-666666666666");
    expect(preview.diff.wouldArchiveTaskIds).not.toContain("66666666-6666-4666-8666-666666666666");
  });

  it("atomically archives the old managed task, creates the replacement, versions the plan, and reads back", async () => {
    const db = createDb();
    const request = input();
    await prepareApprovedReplace(db, request);

    const result = await replacePlanWindow(db, request);

    expect(result).toEqual(expect.objectContaining({
      status: "succeeded",
      createdTaskIds: [expect.any(String)],
      archivedTaskIds: ["44444444-4444-4444-8444-444444444444"],
      failedTaskIds: [],
      currentVersionId: expect.any(String),
      readback: expect.objectContaining({
        verification: "succeeded",
        todo: expect.objectContaining({ count: 1 }),
        backlog: expect.objectContaining({ count: 0 }),
        week: expect.objectContaining({ count: 0 }),
        month: expect.objectContaining({ count: 1 }),
        total: { all: 2, active: 1, archived: 1, byStatus: { todo: 1, done: 0, skipped: 0, backlog: 0 } },
      }),
    }));
    expect(db.tables.tasks.find((task) => task.id === "44444444-4444-4444-8444-444444444444")?.archivedAt).toEqual(request.now);
    expect(db.tables.tasks.find((task) => task.id === result.createdTaskIds[0])).toEqual(
      expect.objectContaining({ title: "Reproduce baseline and record results", archivedAt: null }),
    );
    expect(db.tables.plan_window_revisions).toHaveLength(1);
    expect(db.tables.plan_versions).toHaveLength(2);
    expect(db.tables.change_logs).toEqual([
      expect.objectContaining({ summary: "Replaced active plan window" }),
    ]);
    expect(db.tables.plan_operations[0]).toEqual(expect.objectContaining({ status: "succeeded" }));

    const duplicate = await replacePlanWindow(db, request);
    expect(duplicate).toEqual(expect.objectContaining({ status: "duplicate", operationId: result.operationId }));
    expect(db.tables.tasks).toHaveLength(2);
  });

  it("reports a committed replacement as succeeded when post-commit readback fails", async () => {
    const db = createDb({ failPostCommitReadback: true });
    const request = input();
    await prepareApprovedReplace(db, request);

    const result = await replacePlanWindow(db, request);

    expect(result).toEqual(expect.objectContaining({
      status: "succeeded",
      createdTaskIds: [expect.any(String)],
      archivedTaskIds: ["44444444-4444-4444-8444-444444444444"],
      readback: {
        verification: "failed",
        verifiedAt: expect.any(String),
        error: { code: "readback_failed", message: "injected post-commit readback failure" },
      },
    }));
    expect(db.tables.tasks).toHaveLength(2);
    expect(db.tables.tasks[0].archivedAt).toEqual(request.now);
    expect(db.tables.plan_versions).toHaveLength(2);
    expect(db.tables.plan_operations[0]).toEqual(expect.objectContaining({ status: "succeeded" }));
  });

  it("rolls back archive/create/version writes and persists an observable failed operation", async () => {
    const db = createDb({ failTaskInsert: true });
    const request = input();
    await prepareApprovedReplace(db, request);

    await expect(replacePlanWindow(db, request)).rejects.toThrow("injected task insert failure");

    expect(db.tables.tasks).toHaveLength(1);
    expect(db.tables.tasks[0].archivedAt).toBeNull();
    expect(db.tables.plan_versions).toHaveLength(1);
    expect(db.tables.plan_window_revisions).toHaveLength(0);
    expect(db.tables.plan_operations).toEqual([
      expect.objectContaining({
        status: "failed",
        errorJson: expect.objectContaining({ code: "replace_plan_window_failed" }),
      }),
    ]);
  });

  it("rejects a stale preview before archiving any task", async () => {
    const db = createDb();
    const request = input();
    request.previewToken = (await previewReplacePlanWindow(db, request)).previewToken;
    db.tables.tasks[0].title = "User edited after preview";
    db.tables.tasks[0].updatedAt = new Date("2026-08-16T09:00:00.000+08:00");

    await expect(replacePlanWindow(db, request)).rejects.toMatchObject({ code: "preview_stale" });

    expect(db.tables.tasks).toHaveLength(1);
    expect(db.tables.tasks[0].archivedAt).toBeNull();
    expect(db.tables.plan_operations).toEqual([]);
  });

  it("rejects reuse of an idempotency key with a different payload", async () => {
    const db = createDb();
    const first = input();
    await prepareApprovedReplace(db, first);
    await replacePlanWindow(db, first);

    const changed = input();
    changed.tasks[0].title = "Different replacement payload";

    await expect(replacePlanWindow(db, changed)).rejects.toMatchObject({
      code: "idempotency_payload_mismatch",
      status: 409,
    });
    expect(db.tables.plan_operations).toHaveLength(1);
  });
});
