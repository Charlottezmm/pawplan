import { describe, expect, it } from "vitest";
import { buildBacklogData, buildProjectPortfolioData } from "@/lib/planning/project-view-data";

const researchProject = {
  id: "project-research",
  name: "Physics-Grounded Manipulation",
  color: "#2563eb",
  category: "科研",
  objective: "建立可验证的 manipulation world model",
  successCriteria: "完成一组基线实验",
  status: "active" as const,
  priority: "high" as const,
  startDate: new Date("2026-08-01T00:00:00.000+08:00"),
  targetDate: new Date("2026-12-31T00:00:00.000+08:00"),
  weeklyTargetMinutes: 480,
  needsDefinition: false,
  updatedAt: new Date("2026-08-15T00:00:00.000+08:00"),
};

describe("project portfolio view data", () => {
  it("keeps category separate from the concrete Project name and summarizes task states", () => {
    const result = buildProjectPortfolioData(
      [researchProject],
      [
        {
          id: "milestone-1",
          projectId: researchProject.id,
          title: "Baseline",
          objective: null,
          successCriteria: null,
          targetDate: new Date("2026-09-30T00:00:00.000+08:00"),
          status: "in_progress",
          position: 0,
        },
      ],
      [
        {
          id: "task-parent",
          projectId: researchProject.id,
          status: "todo",
          title: "Run baseline",
          milestoneId: "milestone-1",
          parentTaskId: null,
          priority: "high",
          date: new Date("2026-08-20T00:00:00.000+08:00"),
        },
        {
          id: "task-child",
          projectId: researchProject.id,
          status: "todo",
          title: "Prepare dataset",
          milestoneId: "milestone-1",
          parentTaskId: "task-parent",
          priority: "normal",
          date: new Date("2026-08-19T00:00:00.000+08:00"),
        },
        { projectId: researchProject.id, status: "backlog" },
      ],
    );

    expect(result[0]).toEqual(
      expect.objectContaining({
        name: "Physics-Grounded Manipulation",
        category: "科研",
        taskCounts: { todo: 2, done: 0, skipped: 0, backlog: 1 },
      }),
    );
    expect(result[0].milestones[0]).toEqual(expect.objectContaining({ title: "Baseline", status: "in_progress" }));
    expect(result[0].tasks).toEqual([
      expect.objectContaining({ id: "task-parent", milestoneTitle: "Baseline", parentTitle: null }),
      expect.objectContaining({ id: "task-child", milestoneTitle: "Baseline", parentTitle: "Run baseline" }),
    ]);
  });
});

describe("backlog view data", () => {
  it("groups backlog tasks by Project and keeps unassigned tasks visible", () => {
    const result = buildBacklogData(
      [researchProject],
      [
        {
          id: "task-1",
          title: "Read baseline paper",
          notes: null,
          projectId: researchProject.id,
          priority: "normal",
          estimatedMinutes: 60,
          updatedAt: new Date("2026-08-15T00:00:00.000+08:00"),
        },
        {
          id: "task-2",
          title: "Unassigned idea",
          notes: null,
          projectId: null,
          priority: "low",
          estimatedMinutes: 15,
          updatedAt: new Date("2026-08-14T00:00:00.000+08:00"),
        },
      ],
    );

    expect(result.totalCount).toBe(2);
    expect(result.groups.map((group) => [group.projectName, group.tasks.length])).toEqual([
      ["Physics-Grounded Manipulation", 1],
      ["未关联 Project", 1],
    ]);
  });
});
