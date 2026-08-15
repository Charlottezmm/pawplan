import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agentPatches,
  checkins,
  conversations,
  courses,
  decisions,
  mcpTokens,
  projectMilestones,
  projects,
  routines,
  segmentEnergySettings,
  tasks,
  timeBlocks,
  tracks,
  workspaces,
} from "@/lib/db/schema";
import { exportWorkspaceTemplate } from "@/lib/templates/export";

function createExportDb() {
  const rowsByTable: Record<string, Array<Record<string, unknown>>> = {
    [getTableName(workspaces)]: [
      {
        id: "workspace-1",
        name: "Grad School Plan",
        passwordHash: "secret-password-hash",
      },
    ],
    [getTableName(tracks)]: [
      {
        id: "track-1",
        workspaceId: "workspace-1",
        name: "Research",
        kind: "main",
        targetMinPercent: 50,
        targetMaxPercent: 70,
        color: "#16a34a",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ],
    [getTableName(projects)]: [
      {
        id: "project-1",
        workspaceId: "workspace-1",
        name: "Physics-Grounded Manipulation",
        color: "#7c3aed",
        category: "科研",
        objective: "Build a manipulation world model",
        successCriteria: "Validated experiment",
        status: "paused",
        priority: "urgent",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        targetDate: new Date("2026-12-01T00:00:00.000Z"),
        weeklyTargetMinutes: 600,
        needsDefinition: false,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ],
    [getTableName(projectMilestones)]: [
      {
        id: "milestone-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
        title: "Baseline experiment",
        objective: null,
        successCriteria: "Results recorded",
        targetDate: new Date("2026-09-30T00:00:00.000Z"),
        status: "completed",
        position: 1,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ],
    [getTableName(courses)]: [
      {
        id: "course-1",
        workspaceId: "workspace-1",
        name: "Deep Learning",
        color: "#2563eb",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ],
    [getTableName(routines)]: [
      {
        id: "routine-1",
        workspaceId: "workspace-1",
        title: "Cook dinner",
        defaultTimeSegment: "evening",
        defaultStartTime: null,
        defaultEndTime: null,
        weekdayPattern: "daily",
        estimatedMinutes: 45,
        energyLevel: "low",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ],
    [getTableName(segmentEnergySettings)]: [
      { id: "energy-1", workspaceId: "workspace-1", segment: "morning", energyLevel: "high" },
      { id: "energy-2", workspaceId: "workspace-1", segment: "afternoon", energyLevel: "medium" },
      { id: "energy-3", workspaceId: "workspace-1", segment: "evening", energyLevel: "low" },
    ],
    [getTableName(timeBlocks)]: [
      {
        id: "block-1",
        workspaceId: "workspace-1",
        title: "Deep Learning Lecture",
        kind: "course",
        startsAt: new Date("2026-09-07T01:00:00.000Z"),
        endsAt: new Date("2026-09-07T03:00:00.000Z"),
        recurrenceRule: "weekly",
        courseId: "course-1",
        trackId: "track-1",
        movable: false,
        estimatedMinutes: null,
        energyLevel: null,
      },
    ],
    [getTableName(tasks)]: [
      {
        id: "task-1",
        workspaceId: "workspace-1",
        planId: "plan-1",
        title: "Finish paper draft",
        notes: "Keep structure, not completion history",
        date: new Date("2026-09-08T00:00:00.000Z"),
        daySegment: "morning",
        status: "done",
        priority: "high",
        estimatedMinutes: 120,
        energyLevel: "high",
        movable: true,
        projectId: "project-1",
        milestoneId: "milestone-1",
        courseId: "course-1",
        trackId: "track-1",
        parentTaskId: null,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ],
    [getTableName(mcpTokens)]: [{ tokenHash: "mcp-token-hash-secret", name: "Codex" }],
    [getTableName(checkins)]: [{ completedText: "personal progress history" }],
    [getTableName(agentPatches)]: [{ reason: "agent patch history", patchJson: { token: "unsafe" } }],
    [getTableName(conversations)]: [{ summary: "conversation summary" }],
    [getTableName(decisions)]: [{ chosen: "private decision" }],
  };
  const selectedTables: string[] = [];

  return {
    selectedTables,
    select() {
      return {
        from(table: unknown) {
          const tableName = getTableName(table as Parameters<typeof getTableName>[0]);
          selectedTables.push(tableName);
          const rows = rowsByTable[tableName] ?? [];
          const chain = {
            where() {
              return chain;
            },
            orderBy() {
              return chain;
            },
            limit(count: number) {
              return Promise.resolve(rows.slice(0, count));
            },
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              return Promise.resolve(rows).then(resolve, reject);
            },
          };
          return chain;
        },
      };
    },
  };
}

describe("template export", () => {
  it("exports only safe template data and resets task status", async () => {
    const db = createExportDb();

    const template = await exportWorkspaceTemplate(db, "workspace-1", new Date("2026-06-12T00:00:00.000Z"));

    expect(template).toMatchObject({
      schemaVersion: "pawplan.template.v0.5",
      exportedAt: "2026-06-12T00:00:00.000Z",
      workspace: { name: "Grad School Plan" },
    });
    expect(template.projects).toEqual([
      expect.objectContaining({
        id: "project-1",
        category: "科研",
        objective: "Build a manipulation world model",
        status: "active",
        priority: "urgent",
        needsDefinition: false,
      }),
    ]);
    expect(template.milestones).toEqual([
      expect.objectContaining({ id: "milestone-1", projectId: "project-1", status: "planned" }),
    ]);
    expect(template.tracks).toEqual([expect.objectContaining({ id: "track-1", name: "Research", kind: "main" })]);
    expect(template.courses).toEqual([expect.objectContaining({ id: "course-1", name: "Deep Learning" })]);
    expect(template.routines).toEqual([expect.objectContaining({ id: "routine-1", title: "Cook dinner" })]);
    expect(template.segmentEnergySettings).toEqual(
      expect.arrayContaining([expect.objectContaining({ segment: "morning", energyLevel: "high" })]),
    );
    expect(template.timeBlocks).toEqual([
      expect.objectContaining({ id: "block-1", title: "Deep Learning Lecture", courseId: "course-1", trackId: "track-1" }),
    ]);
    expect(template.tasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        title: "Finish paper draft",
        status: "todo",
        projectId: "project-1",
        milestoneId: "milestone-1",
        courseId: "course-1",
        trackId: "track-1",
      }),
    ]);

    expect(db.selectedTables).not.toEqual(
      expect.arrayContaining([
        "mcp_tokens",
        "checkins",
        "checkin_tasks",
        "agent_patches",
        "agent_patch_reviews",
        "conversations",
        "decisions",
      ]),
    );
    expect(JSON.stringify(template)).not.toContain("secret-password-hash");
    expect(JSON.stringify(template)).not.toContain("mcp-token-hash-secret");
    expect(JSON.stringify(template)).not.toContain("personal progress history");
    expect(JSON.stringify(template)).not.toContain("agent patch history");
    expect(JSON.stringify(template)).not.toContain("conversation summary");
    expect(JSON.stringify(template)).not.toContain("private decision");
    expect(JSON.stringify(template)).not.toContain("\"done\"");
    expect(JSON.stringify(template)).not.toContain("rolloverCount");
    expect(JSON.stringify(template)).not.toContain("lastRolloverAt");
    expect(JSON.stringify(template)).not.toContain("createdAt");
    expect(JSON.stringify(template)).not.toContain("updatedAt");
  });
});
