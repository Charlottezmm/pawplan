import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ConstraintsServiceError, deleteTimeBlock, getConstraints, upsertTimeBlock } from "@/lib/constraints/service";

type FakeDbOptions = {
  activePlan?: Record<string, unknown> | null;
  courses?: Array<Record<string, unknown>>;
  timeBlocks?: Array<Record<string, unknown>>;
  deletedRows?: Array<Record<string, unknown>>;
};

function createFakeDb(options: FakeDbOptions = {}) {
  const inserts: Array<{ table: string; values: Record<string, unknown>; inTransaction: boolean }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown>; inTransaction: boolean }> = [];
  const deletes: Array<{ table: string; inTransaction: boolean }> = [];
  let inTransaction = false;

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function rowsFor(table: unknown) {
    const name = tableName(table);
    if (name === "plans") return options.activePlan === null ? [] : [options.activePlan ?? { id: "plan-1" }];
    if (name === "courses") return options.courses ?? [];
    if (name === "time_blocks") return options.timeBlocks ?? [];
    return [];
  }

  function selectableRows(table: unknown) {
    const rows = rowsFor(table);
    return {
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows.slice(0, 1));
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
              orderBy() {
                return selectableRows(table);
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
              inserts.push({ table: tableName(table), values: row, inTransaction });
            }
            return {
              returning() {
                return Promise.resolve(
                  rows.map((row, index) => ({
                    id: `${tableName(table)}-${inserts.length - rows.length + index + 1}`,
                    ...row,
                  })),
                );
              },
              then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
                return Promise.resolve().then(resolve, reject);
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
                    return Promise.resolve([{ id: "block-1", ...values }]);
                  },
                };
              },
            };
          },
        };
      },
      delete(table: unknown) {
        return {
          where() {
            deletes.push({ table: tableName(table), inTransaction });
            return {
              returning() {
                return Promise.resolve(options.deletedRows ?? [{ id: "block-1" }]);
              },
            };
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
    ...client,
  };
}

describe("constraints service", () => {
  it("returns workspace courses and only editable time block kinds with course names", async () => {
    const db = createFakeDb({
      courses: [
        { id: "course-1", workspaceId: "workspace-1", name: "Robotics" },
        { id: "course-2", workspaceId: "workspace-1", name: "Linear Algebra" },
      ],
      timeBlocks: [
        {
          id: "routine-1",
          workspaceId: "workspace-1",
          title: "Sleep",
          kind: "recovery",
          startsAt: new Date("2026-06-14T14:00:00.000Z"),
          endsAt: new Date("2026-06-14T22:00:00.000Z"),
          recurrenceRule: null,
          courseId: null,
          movable: false,
        },
        {
          id: "meeting-1",
          workspaceId: "workspace-1",
          title: "Study group",
          kind: "meeting",
          startsAt: new Date("2026-06-12T02:30:00.000Z"),
          endsAt: new Date("2026-06-12T04:00:00.000Z"),
          recurrenceRule: null,
          courseId: null,
          movable: true,
        },
        {
          id: "course-block-1",
          workspaceId: "workspace-1",
          title: "Robotics lecture",
          kind: "course",
          startsAt: new Date("2026-06-12T01:00:00.000Z"),
          endsAt: new Date("2026-06-12T03:00:00.000Z"),
          location: "Engineering 204",
          recurrenceRule: "weekly",
          courseId: "course-1",
          movable: false,
        },
      ],
    });

    const result = await getConstraints(db, "workspace-1");

    expect(result.workspaceId).toBe("workspace-1");
    expect(result.courses).toEqual([
      expect.objectContaining({ id: "course-1", name: "Robotics" }),
      expect.objectContaining({ id: "course-2", name: "Linear Algebra" }),
    ]);
    expect(result.timeBlocks).toEqual([
      expect.objectContaining({
        id: "course-block-1",
        kind: "course",
        courseName: "Robotics",
        location: "Engineering 204",
        movable: false,
      }),
      expect.objectContaining({
        id: "meeting-1",
        kind: "meeting",
        courseName: null,
        movable: false,
      }),
      expect.objectContaining({
        id: "routine-1",
        kind: "recovery",
        courseName: null,
        movable: false,
      }),
    ]);
    expect(result.summary).toEqual({
      courseCount: 2,
      timeBlockCount: 3,
      conflictCount: 1,
      nextStartsAt: "2026-06-12T01:00:00.000Z",
    });
    expect(result.conflicts).toEqual([
      {
        id: "course-block-1__meeting-1",
        firstTitle: "Robotics lecture",
        secondTitle: "Study group",
        firstLocation: "Engineering 204",
        secondLocation: null,
        startsAt: "2026-06-12T02:30:00.000Z",
        endsAt: "2026-06-12T03:00:00.000Z",
      },
    ]);
  });

  it("checks recurring constraint conflicts against expanded occurrences", async () => {
    const db = createFakeDb({
      timeBlocks: [
        {
          id: "study-rule",
          workspaceId: "workspace-1",
          title: "Study block",
          kind: "routine",
          startsAt: new Date("2026-06-15T05:00:00.000+08:00"),
          endsAt: new Date("2026-06-30T07:00:00.000+08:00"),
          recurrenceRule: "weekly",
          recurrenceWeekdayMask: 1 << 1,
          courseId: null,
          movable: false,
        },
        {
          id: "tuesday-meeting",
          workspaceId: "workspace-1",
          title: "Tuesday meeting",
          kind: "meeting",
          startsAt: new Date("2026-06-16T05:30:00.000+08:00"),
          endsAt: new Date("2026-06-16T06:00:00.000+08:00"),
          recurrenceRule: null,
          courseId: null,
          movable: false,
        },
      ],
    });

    const result = await getConstraints(db, "workspace-1");

    expect(result.summary?.conflictCount).toBe(0);
    expect(result.conflicts).toEqual([]);
  });

  it("creates a course time block, reusing the current workspace course and writing a manual change log", async () => {
    const db = createFakeDb({
      courses: [{ id: "course-1", workspaceId: "workspace-1", name: "Robotics" }],
    });

    const result = await upsertTimeBlock(db, "workspace-1", {
      title: "Robotics lab",
      kind: "course",
      startsAt: new Date("2026-06-12T01:00:00.000Z"),
      endsAt: new Date("2026-06-12T03:00:00.000Z"),
      recurrenceRule: "weekly",
      courseName: "Robotics",
      location: "  Engineering 204  ",
    });

    expect(result).toEqual({
      timeBlock: expect.objectContaining({ title: "Robotics lab", kind: "course", courseId: "course-1" }),
      course: expect.objectContaining({ id: "course-1", name: "Robotics" }),
    });
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "time_blocks",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            title: "Robotics lab",
            kind: "course",
            courseId: "course-1",
            location: "Engineering 204",
            movable: false,
          }),
          inTransaction: true,
        }),
        expect.objectContaining({
          table: "change_logs",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            source: "manual",
            summary: "Updated calendar constraint",
          }),
          inTransaction: true,
        }),
      ]),
    );
    expect(db.inserts.some((write) => write.table === "courses")).toBe(false);
  });

  it("creates a missing current workspace course before saving a course block", async () => {
    const db = createFakeDb();

    await upsertTimeBlock(db, "workspace-1", {
      title: "Robotics lab",
      kind: "course",
      startsAt: new Date("2026-06-12T01:00:00.000Z"),
      endsAt: new Date("2026-06-12T03:00:00.000Z"),
      recurrenceRule: null,
      courseName: "Robotics",
      location: "   ",
    });

    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "courses",
          values: expect.objectContaining({ workspaceId: "workspace-1", name: "Robotics" }),
          inTransaction: true,
        }),
        expect.objectContaining({
          table: "time_blocks",
          values: expect.objectContaining({ courseId: "courses-1", location: null }),
          inTransaction: true,
        }),
      ]),
    );
  });

  it("refuses to delete non-editable time block kinds", async () => {
    const db = createFakeDb({
      timeBlocks: [{ id: "block-1", workspaceId: "workspace-1", kind: "system" }],
    });

    await expect(deleteTimeBlock(db, "workspace-1", "block-1")).rejects.toEqual(
      new ConstraintsServiceError("Time block is not editable here", 403),
    );
    expect(db.deletes).toEqual([]);
  });

  it("requires an explicit scope before updating or deleting a recurring block", async () => {
    const db = createFakeDb({
      timeBlocks: [{
        id: "block-1",
        workspaceId: "workspace-1",
        title: "Weekly meeting",
        kind: "meeting",
        recurrenceRule: "weekly",
        recurrenceWeekdayMask: 1 << 1,
      }],
    });

    await expect(upsertTimeBlock(db, "workspace-1", {
      id: "block-1",
      title: "Updated weekly meeting",
      kind: "meeting",
      startsAt: new Date("2026-06-15T01:00:00.000Z"),
      endsAt: new Date("2026-06-15T03:00:00.000Z"),
      recurrenceRule: "weekly",
    })).rejects.toEqual(new ConstraintsServiceError(
      "Recurring time blocks must be changed with an explicit occurrence, following, or series scope",
      409,
    ));
    await expect(deleteTimeBlock(db, "workspace-1", "block-1")).rejects.toEqual(
      new ConstraintsServiceError(
        "Recurring time blocks must be deleted with an explicit occurrence, following, or series scope",
        409,
      ),
    );
    expect(db.updates).toEqual([]);
    expect(db.deletes).toEqual([]);
  });

  it("deletes editable blocks with the stable API response", async () => {
    const db = createFakeDb({
      timeBlocks: [{ id: "block-1", workspaceId: "workspace-1", title: "Class", kind: "course" }],
    });

    await expect(deleteTimeBlock(db, "workspace-1", "block-1")).resolves.toEqual({ deleted: true });
  });
});
