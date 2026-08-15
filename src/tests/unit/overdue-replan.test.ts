import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { proposeOverdueReplan } from "@/lib/planning/overdue-replan";

type Row = Record<string, any>;

function createFakeDb(rows: Record<string, Row[]>) {
  const inserts: Array<{ table: string; values: Row }> = [];

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function selectable(table: unknown) {
    const values = rows[tableName(table)] ?? [];
    return {
      orderBy() {
        return this;
      },
      limit(count: number) {
        return Promise.resolve(values.slice(0, count));
      },
      then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(values).then(resolve, reject);
      },
    };
  }

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return selectable(table);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Row) {
          inserts.push({ table: tableName(table), values });
          return {
            returning: () => Promise.resolve([{ id: `${tableName(table)}-1`, ...values }]),
          };
        },
      };
    },
    update() {
      throw new Error("unexpected update");
    },
    delete() {
      throw new Error("unexpected delete");
    },
    transaction: async <T>(callback: (tx: typeof db) => Promise<T>) => callback(db),
  };

  return { db, inserts };
}

function project(overrides: Partial<Row> = {}): Row {
  return {
    id: "project-1",
    workspaceId: "workspace-1",
    name: "Research Project",
    category: "科研",
    objective: "Validate the model",
    successCriteria: "Reproducible result",
    status: "active",
    priority: "normal",
    targetDate: new Date("2026-09-30T16:00:00.000Z"),
    needsDefinition: false,
    ...overrides,
  };
}

function task(overrides: Partial<Row> = {}): Row {
  return {
    id: "task-1",
    workspaceId: "workspace-1",
    planId: "plan-1",
    projectId: "project-1",
    milestoneId: null,
    title: "Run experiment",
    date: new Date("2026-08-13T16:00:00.000Z"),
    originalDate: new Date("2026-08-13T16:00:00.000Z"),
    daySegment: "morning",
    status: "todo",
    blocked: false,
    movable: true,
    estimatedMinutes: 60,
    energyLevel: "high",
    priority: "normal",
    rolloverCount: 0,
    ...overrides,
  };
}

function baseRows(overrides: Record<string, Row[]> = {}) {
  return {
    plans: [{ id: "plan-1", endDate: new Date("2026-12-31T16:00:00.000Z") }],
    projects: [project()],
    project_milestones: [],
    tasks: [task()],
    time_blocks: [],
    routines: [],
    day_capacities: [],
    segment_energy_settings: [],
    ...overrides,
  };
}

describe("proposeOverdueReplan", () => {
  it("stops before reads or drafts when the supplied date anchor is stale", async () => {
    const { db, inserts } = createFakeDb(baseRows());

    await expect(proposeOverdueReplan(db, {
      workspaceId: "workspace-1",
      asOfDate: "2026-08-14",
      taskIds: ["task-1"],
      reason: "Stale inspector date",
      createdBy: "codex",
      now: new Date("2026-08-15T04:00:00.000Z"),
    })).rejects.toMatchObject({ code: "date_source_conflict" });
    expect(inserts).toEqual([]);
  });

  it("sorts parallel Projects by Project priority before target date and creates one Review draft", async () => {
    const rows = baseRows({
      projects: [
        project({ id: "project-normal", name: "Exam", priority: "normal", targetDate: new Date("2026-08-20T16:00:00.000Z") }),
        project({ id: "project-urgent", name: "Research", priority: "urgent", targetDate: new Date("2026-09-30T16:00:00.000Z") }),
      ],
      tasks: [
        task({ id: "task-normal", projectId: "project-normal", title: "Review course" }),
        task({ id: "task-urgent", projectId: "project-urgent", title: "Run research test" }),
      ],
    });
    const { db, inserts } = createFakeDb(rows);

    const result = await proposeOverdueReplan(db, {
      workspaceId: "workspace-1",
      asOfDate: "2026-08-15",
      taskIds: ["task-normal", "task-urgent"],
      reason: "Replan first-time overdue work",
      createdBy: "codex",
      now: new Date("2026-08-15T04:00:00.000Z"),
    });

    expect(result).toEqual(expect.objectContaining({ patchId: "agent_patches-1", operationCount: 2 }));
    const patch = inserts.find((insert) => insert.table === "agent_patches")?.values.patchJson as {
      operations: Array<Record<string, unknown>>;
    };
    expect(patch.operations.map((operation) => operation.task_id)).toEqual(["task-urgent", "task-normal"]);
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ overdue_rollover: true, expected_rollover_count: 0 }),
    ]));
  });

  it("keeps repeated overdue and backlog tasks out of Review and returns an explicit decision", async () => {
    const { db, inserts } = createFakeDb(baseRows({
      tasks: [
        task({ id: "task-repeated", rolloverCount: 1 }),
        task({ id: "task-backlog", status: "backlog" }),
      ],
    }));

    const result = await proposeOverdueReplan(db, {
      workspaceId: "workspace-1",
      asOfDate: "2026-08-15",
      taskIds: ["task-repeated", "task-backlog"],
      reason: "Inspect overdue work",
      createdBy: "codex",
      now: new Date("2026-08-15T04:00:00.000Z"),
    });

    expect(result.patchId).toBeUndefined();
    expect(result.operationCount).toBe(0);
    expect(result.needsDecision).toEqual([
      expect.objectContaining({ taskId: "task-repeated", code: "repeated_overdue", rolloverCount: 1 }),
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ taskId: "task-backlog", code: "task_not_todo" }),
    ]);
    expect(inserts).toEqual([]);
  });

  it("preserves the original segment first, then uses an energy-compatible segment without moving future work", async () => {
    const futureTask = task({
      id: "future-fixed-in-place",
      date: new Date("2026-08-14T16:00:00.000Z"),
      estimatedMinutes: 150,
      projectId: "project-1",
      daySegment: "morning",
    });
    const { db, inserts } = createFakeDb(baseRows({
      tasks: [task(), futureTask],
      segment_energy_settings: [
        { segment: "morning", energyLevel: "medium" },
        { segment: "afternoon", energyLevel: "high" },
        { segment: "evening", energyLevel: "low" },
      ],
    }));

    await proposeOverdueReplan(db, {
      workspaceId: "workspace-1",
      asOfDate: "2026-08-15",
      taskIds: ["task-1"],
      reason: "Find capacity without displacing future work",
      createdBy: "codex",
      now: new Date("2026-08-15T04:00:00.000Z"),
    });

    const patch = inserts.find((insert) => insert.table === "agent_patches")?.values.patchJson as {
      operations: Array<Record<string, unknown>>;
    };
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toEqual(expect.objectContaining({
      task_id: "task-1",
      to_date: "2026-08-15",
      to_day_segment: "afternoon",
    }));
    expect(patch.operations.some((operation) => operation.task_id === "future-fixed-in-place")).toBe(false);
  });
});
