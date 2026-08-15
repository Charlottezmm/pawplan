import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agentPatches,
  checkins,
  conversations,
  courses,
  decisions,
  mcpTokens,
  plans,
  planVersions,
  projectMilestones,
  projects,
  routines,
  segmentEnergySettings,
  tasks,
  timeBlocks,
  tracks,
} from "@/lib/db/schema";
import { importWorkspaceTemplate } from "@/lib/templates/import";
import type { PawPlanTemplate, PawPlanTemplateV05 } from "@/lib/templates/export";

type TableWrite = {
  table: string;
  values: Record<string, unknown>;
  inTransaction: boolean;
};

function createImportDb() {
  const inserts: TableWrite[] = [];
  const updates: TableWrite[] = [];
  let inTransaction = false;
  const counters: Record<string, number> = {};

  function nextId(tableName: string) {
    counters[tableName] = (counters[tableName] ?? 0) + 1;
    return `${tableName}-${counters[tableName]}`;
  }

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function createClient() {
    return {
      insert(table: unknown) {
        const tableNameValue = tableName(table);
        return {
          values(values: Record<string, unknown> | Array<Record<string, unknown>>) {
            const rows = Array.isArray(values) ? values : [values];
            for (const row of rows) {
              inserts.push({ table: tableNameValue, values: row, inTransaction });
            }
            return {
              returning() {
                return Promise.resolve(
                  rows.map((row) => ({
                    id: nextId(tableNameValue),
                    ...row,
                  })),
                );
              },
              then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
                return Promise.resolve(undefined).then(resolve, reject);
              },
            };
          },
        };
      },
      update(table: unknown) {
        const tableNameValue = tableName(table);
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                updates.push({ table: tableNameValue, values, inTransaction });
                return Promise.resolve([{ id: "updated", ...values }]);
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
      try {
        return await callback(client);
      } finally {
        inTransaction = false;
      }
    },
    ...client,
  };
}

const template: PawPlanTemplate = {
  schemaVersion: "pawplan.template.v0.4",
  exportedAt: "2026-06-12T00:00:00.000Z",
  workspace: { name: "Source Workspace" },
  tracks: [
    {
      id: "source-track",
      name: "Research",
      kind: "main",
      targetMinPercent: 50,
      targetMaxPercent: 70,
      color: "#16a34a",
    },
  ],
  courses: [{ id: "source-course", name: "Deep Learning", color: "#2563eb" }],
  routines: [
    {
      id: "source-routine",
      title: "Cook dinner",
      defaultTimeSegment: "evening",
      defaultStartTime: null,
      defaultEndTime: null,
      weekdayPattern: "daily",
      estimatedMinutes: 45,
      energyLevel: "low",
    },
  ],
  segmentEnergySettings: [
    { segment: "morning", energyLevel: "high" },
    { segment: "afternoon", energyLevel: "medium" },
    { segment: "evening", energyLevel: "low" },
  ],
  timeBlocks: [
    {
      id: "source-block",
      title: "Deep Learning Lecture",
      kind: "course",
      startsAt: "2026-09-07T01:00:00.000Z",
      endsAt: "2026-09-07T03:00:00.000Z",
      recurrenceRule: "weekly",
      courseId: "source-course",
      trackId: "source-track",
      movable: false,
      estimatedMinutes: null,
      energyLevel: null,
    },
  ],
  tasks: [
    {
      id: "source-task",
      title: "Finish paper draft",
      notes: "template notes",
      date: "2026-09-08T00:00:00.000Z",
      daySegment: "morning",
      status: "done",
      priority: "high",
      estimatedMinutes: 120,
      energyLevel: "high",
      movable: true,
      courseId: "source-course",
      trackId: "source-track",
      parentTaskId: null,
    },
  ],
};

describe("template import", () => {
  it("keeps v0.4 imports compatible and resets imported tasks to todo", async () => {
    const db = createImportDb();

    const result = await importWorkspaceTemplate(db, "target-workspace", { template, mode: "new_plan" });

    expect(result).toEqual({
      planId: "plans-1",
      tasksCreated: 1,
      routinesCreated: 1,
      timeBlocksCreated: 1,
    });
    expect(db.inserts.every((write) => write.inTransaction)).toBe(true);
    expect(db.inserts.map((write) => write.table)).not.toEqual(
      expect.arrayContaining([
        getTableName(mcpTokens),
        getTableName(checkins),
        getTableName(agentPatches),
        getTableName(conversations),
        getTableName(decisions),
      ]),
    );
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: getTableName(plans),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            title: "Source Workspace Template",
            status: "active",
          }),
        }),
        expect.objectContaining({
          table: getTableName(planVersions),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            planId: "plans-1",
            versionNumber: 1,
            source: "baseline",
          }),
        }),
        expect.objectContaining({
          table: getTableName(tracks),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            name: "Research",
          }),
        }),
        expect.objectContaining({
          table: getTableName(courses),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            name: "Deep Learning",
          }),
        }),
        expect.objectContaining({
          table: getTableName(routines),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            title: "Cook dinner",
          }),
        }),
        expect.objectContaining({
          table: getTableName(segmentEnergySettings),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            segment: "morning",
          }),
        }),
        expect.objectContaining({
          table: getTableName(timeBlocks),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            title: "Deep Learning Lecture",
            courseId: "courses-1",
            trackId: "tracks-1",
          }),
        }),
        expect.objectContaining({
          table: getTableName(tasks),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            planId: "plans-1",
            title: "Finish paper draft",
            status: "todo",
            courseId: "courses-1",
            trackId: "tracks-1",
          }),
        }),
      ]),
    );
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: getTableName(plans),
        values: expect.objectContaining({ currentVersionId: "plan_versions-1" }),
      }),
    ]);
  });

  it("imports v0.5 projects, milestones, and task hierarchy with remapped ids", async () => {
    const db = createImportDb();
    const v05Template: PawPlanTemplateV05 = {
      ...template,
      schemaVersion: "pawplan.template.v0.5",
      projects: [
        {
          id: "source-project",
          name: "Physics-Grounded Manipulation",
          color: "#7c3aed",
          category: "科研",
          objective: "Build a manipulation world model",
          successCriteria: "Validated experiment",
          status: "active",
          priority: "urgent",
          startDate: "2026-06-01T00:00:00.000Z",
          targetDate: "2026-12-01T00:00:00.000Z",
          weeklyTargetMinutes: 600,
          needsDefinition: false,
        },
      ],
      milestones: [
        {
          id: "source-milestone",
          projectId: "source-project",
          title: "Baseline experiment",
          objective: null,
          successCriteria: "Results recorded",
          targetDate: "2026-09-30T00:00:00.000Z",
          status: "in_progress",
          position: 1,
        },
      ],
      tasks: [
        {
          ...template.tasks[0],
          id: "source-parent-task",
          projectId: "source-project",
          milestoneId: "source-milestone",
        },
        {
          ...template.tasks[0],
          id: "source-child-task",
          title: "Analyze results",
          projectId: "source-project",
          milestoneId: "source-milestone",
          parentTaskId: "source-parent-task",
        },
      ],
    };

    const result = await importWorkspaceTemplate(db, "target-workspace", { template: v05Template, mode: "new_plan" });

    expect(result.tasksCreated).toBe(2);
    expect(db.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: getTableName(projects),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            name: "Physics-Grounded Manipulation",
            category: "科研",
            needsDefinition: false,
          }),
        }),
        expect.objectContaining({
          table: getTableName(projectMilestones),
          values: expect.objectContaining({
            workspaceId: "target-workspace",
            projectId: "projects-1",
            title: "Baseline experiment",
          }),
        }),
        expect.objectContaining({
          table: getTableName(tasks),
          values: expect.objectContaining({
            projectId: "projects-1",
            milestoneId: "project_milestones-1",
            parentTaskId: null,
            originalDate: new Date("2026-09-08T00:00:00.000Z"),
          }),
        }),
      ]),
    );
    expect(db.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: getTableName(tasks),
          values: { parentTaskId: "tasks-1" },
        }),
      ]),
    );
  });

  it("rejects broken v0.5 project references before writing", async () => {
    const db = createImportDb();
    const invalidTemplate: PawPlanTemplateV05 = {
      ...template,
      schemaVersion: "pawplan.template.v0.5",
      projects: [],
      milestones: [
        {
          id: "orphan-milestone",
          projectId: "missing-project",
          title: "Orphan milestone",
          objective: null,
          successCriteria: null,
          targetDate: null,
          status: "planned",
          position: 0,
        },
      ],
      tasks: [],
    };

    await expect(
      importWorkspaceTemplate(db, "target-workspace", { template: invalidTemplate, mode: "new_plan" }),
    ).rejects.toThrow("Template milestone references an unknown project");
    expect(db.inserts).toEqual([]);
  });
});
