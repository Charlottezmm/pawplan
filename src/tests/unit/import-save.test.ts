import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ImportSaveError, savePlanImport } from "@/lib/imports/plan-save";
import { saveTimetableImport } from "@/lib/imports/timetable-save";

type TableWrite = {
  table: string;
  values: Record<string, unknown>;
  inTransaction: boolean;
};

type FakeDbOptions = {
  activePlan?: Record<string, unknown> | null;
  latestVersionNumber?: number;
  existingProjects?: Array<Record<string, unknown>>;
  existingCourses?: Array<Record<string, unknown>>;
};

function createFakeDb(options: FakeDbOptions = {}) {
  const inserts: TableWrite[] = [];
  const updates: TableWrite[] = [];
  let inTransaction = false;

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function rowsFor(table: unknown) {
    const name = tableName(table);
    if (name === "plans") {
      return options.activePlan === null
        ? []
        : [
            options.activePlan ?? {
              id: "plan-1",
              baselineSnapshot: {
                version: 1,
                source: "starter",
                goal: null,
                projects: [],
                constraints: [],
              },
            },
          ];
    }
    if (name === "plan_versions") {
      return options.latestVersionNumber ? [{ versionNumber: options.latestVersionNumber }] : [];
    }
    if (name === "projects") {
      return options.existingProjects ?? [];
    }
    if (name === "courses") {
      return options.existingCourses ?? [];
    }
    if (name === "time_blocks") {
      return inserts
        .map((write, index) => ({ write, index }))
        .filter(({ write }) => write.table === "time_blocks")
        .map(({ write, index }) => ({ id: `time_blocks-${index + 1}`, ...write.values }));
    }
    return [];
  }

  function selectableRows(table: unknown) {
    const rows = rowsFor(table);
    return {
      orderBy() {
        return this;
      },
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
      insert(table: unknown) {
        return {
          values(values: Record<string, unknown> | Array<Record<string, unknown>>) {
            const rows = Array.isArray(values) ? values : [values];
            for (const row of rows) {
              inserts.push({ table: tableName(table), values: row, inTransaction });
            }
            const builder = {
              onConflictDoNothing() {
                return builder;
              },
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
            return builder;
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
                    return Promise.resolve([{ id: values.currentVersionId ?? "updated", ...values }]);
                  },
                };
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
    transaction: async <T>(callback: (tx: ReturnType<typeof createClient>) => Promise<T>) => {
      inTransaction = true;
      return callback(client);
    },
    wasInTransaction: () => inTransaction,
    ...client,
  };
}

describe("import save services", () => {
  it("saves plan markdown into projects, a new plan version, and an import change log", async () => {
    const db = createFakeDb({ latestVersionNumber: 2 });

    const result = await savePlanImport(db, {
      workspaceId: "workspace-1",
      confirmation: "CONFIRM_PLAN_IMPORT",
      markdown: `Goal: ship PawPlan tomorrow

## Projects
- PawPlan Import: save imports by 2026-06-11

## Constraints
- protect tomorrow morning for verification
`,
    });

    expect(db.wasInTransaction()).toBe(true);
    expect(result).toEqual({
      planId: "plan-1",
      versionId: "plan_versions-2",
      projectsCreated: 1,
      projectsReused: 0,
    });
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "projects",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            name: "PawPlan Import",
          }),
        }),
        expect.objectContaining({
          table: "plan_versions",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            versionNumber: 3,
            source: "manual_edit",
            snapshot: expect.objectContaining({
              importSummary: expect.objectContaining({
                type: "plan.md",
                projectCount: 1,
              }),
            }),
          }),
        }),
        expect.objectContaining({
          table: "change_logs",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            source: "import",
            summary: "Imported plan.md preview",
            detailsJson: expect.objectContaining({
              confirmedBy: "user",
              confirmation: "CONFIRM_PLAN_IMPORT",
              preview: expect.objectContaining({
                timezone: "Asia/Shanghai",
                warnings: [],
                conflicts: [],
              }),
            }),
          }),
        }),
      ]),
    );
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "plans",
        values: expect.objectContaining({
          currentVersionId: "plan_versions-2",
          baselineSnapshot: expect.objectContaining({
            importSummary: expect.objectContaining({ type: "plan.md" }),
          }),
        }),
      }),
    ]);
  });

  it("saves timetable CSV as one recurring weekly time block and writes an import change log", async () => {
    const db = createFakeDb();

    const result = await saveTimetableImport(db, {
      workspaceId: "workspace-1",
      confirmation: "CONFIRM_TIMETABLE_IMPORT",
      csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,location,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,Room 204,weekly,Bring laptop
`,
    });

    expect(db.wasInTransaction()).toBe(true);
    expect(result).toEqual({
      status: "succeeded",
      blocksCreated: 1,
      blocksExisting: 0,
      coursesCreated: 1,
      coursesReused: 0,
      readback: [
        expect.objectContaining({
          id: expect.any(String),
          title: "Deep Learning Lecture",
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
    });
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "courses",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            name: "Deep Learning",
          }),
        }),
        expect.objectContaining({
          table: "time_blocks",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            title: "Deep Learning Lecture",
            kind: "course",
            startsAt: new Date("2026-09-01T01:00:00.000Z"),
            endsAt: new Date("2026-09-14T03:00:00.000Z"),
            courseId: "courses-1",
            location: "Room 204",
            recurrenceRule: "weekly",
            recurrenceWeekdayMask: 2,
          }),
        }),
        expect.objectContaining({
          table: "change_logs",
          values: expect.objectContaining({
            workspaceId: "workspace-1",
            planId: "plan-1",
            source: "import",
            summary: "Imported timetable.csv preview",
            detailsJson: expect.objectContaining({
              confirmedBy: "user",
              confirmation: "CONFIRM_TIMETABLE_IMPORT",
              timezone: "Asia/Shanghai",
              rowsPreviewed: 1,
              warnings: [],
              conflicts: [],
              status: "succeeded",
              blocksCreated: 1,
              blocksExisting: 0,
            }),
          }),
        }),
      ]),
    );
  });

  it("treats a repeated timetable import as no_change and returns persisted readback", async () => {
    const db = createFakeDb();
    const input = {
      workspaceId: "workspace-1",
      confirmation: "CONFIRM_TIMETABLE_IMPORT",
      csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,location,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,Room 204,weekly,
`,
    };

    const first = await saveTimetableImport(db, input);
    const second = await saveTimetableImport(db, input);

    expect(first.status).toBe("succeeded");
    expect(second).toEqual({
      status: "no_change",
      blocksCreated: 0,
      blocksExisting: 1,
      coursesCreated: 0,
      coursesReused: 0,
      readback: first.readback,
    });
    expect(db.inserts.filter((write) => write.table === "time_blocks")).toHaveLength(1);
  });

  it("collapses duplicate rows within one CSV but keeps a location change distinct", async () => {
    const db = createFakeDb();
    const duplicateResult = await saveTimetableImport(db, {
      workspaceId: "workspace-1",
      confirmation: "CONFIRM_TIMETABLE_IMPORT",
      csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,location,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,Room 204,weekly,
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,Room 204,weekly,
`,
    });
    const changedLocation = await saveTimetableImport(db, {
      workspaceId: "workspace-1",
      confirmation: "CONFIRM_TIMETABLE_IMPORT",
      csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,location,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,Room 205,weekly,
`,
    });

    expect(duplicateResult).toMatchObject({ status: "succeeded", blocksCreated: 1, blocksExisting: 1 });
    expect(changedLocation).toMatchObject({ status: "succeeded", blocksCreated: 1, blocksExisting: 0 });
    expect(db.inserts.filter((write) => write.table === "time_blocks")).toHaveLength(2);
  });

  it("requires explicit confirmation before saving plan or timetable imports", async () => {
    const db = createFakeDb();

    await expect(
      savePlanImport(db, {
        workspaceId: "workspace-1",
        markdown: `Goal: ship PawPlan tomorrow

## Projects
- PawPlan Import: save imports by 2026-06-11
`,
      }),
    ).rejects.toMatchObject({
      message: "Plan import confirmation required",
      status: 400,
    });

    await expect(
      saveTimetableImport(db, {
        workspaceId: "workspace-1",
        csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,weekly,Room 204
`,
      }),
    ).rejects.toMatchObject({
      message: "Timetable import confirmation required",
      status: 400,
    });

    expect(db.inserts).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it("rejects timetable import without an active plan before writing import data", async () => {
    const db = createFakeDb({ activePlan: null });

    let error: unknown;
    try {
      await saveTimetableImport(db, {
        workspaceId: "workspace-1",
        confirmation: "CONFIRM_TIMETABLE_IMPORT",
        csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,weekly,Room 204
`,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ImportSaveError);
    expect(error).toMatchObject({
      message: "No active plan",
      status: 400,
    });

    expect(db.inserts.filter((write) => ["courses", "time_blocks", "change_logs"].includes(write.table))).toEqual([]);
  });

  it("rejects invalid timetable dates and blocks whose end time is not after start time", async () => {
    const db = createFakeDb();

    await expect(
      saveTimetableImport(db, {
        workspaceId: "workspace-1",
        confirmation: "CONFIRM_TIMETABLE_IMPORT",
        csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Bad Date,meeting,Monday,09:00,10:00,2026-99-01,2026-09-14,,weekly,
`,
      }),
    ).rejects.toThrow("Invalid timetable date");

    await expect(
      saveTimetableImport(db, {
        workspaceId: "workspace-1",
        confirmation: "CONFIRM_TIMETABLE_IMPORT",
        csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Bad Time,meeting,Monday,10:00,10:00,2026-09-01,2026-09-14,,weekly,
`,
      }),
    ).rejects.toThrow("end_time must be after start_time");
  });
});
