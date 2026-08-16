import { describe, expect, it } from "vitest";
import { addMonthsToMonthKey, buildMonthPlanViewData, normalizeMonthKey } from "@/lib/planning/view-data";

describe("month plan view data", () => {
  it("returns an honest empty state when there are no imported summaries or tasks", () => {
    const result = buildMonthPlanViewData([], {}, new Date("2026-06-12T04:00:00.000Z"));

    expect(result.cards).toEqual([]);
    expect(result.days.length).toBeGreaterThanOrEqual(35);
    expect(result.emptyText).toContain("没有计划中或已完成");
  });

  it("computes month cards from real tasks and imported plan summary", () => {
    const result = buildMonthPlanViewData(
      [
        { id: "task-1", title: "Ship MCP", status: "done", date: new Date("2026-06-12T00:00:00.000Z"), daySegment: "morning", estimatedMinutes: 90 },
        { id: "task-2", title: "Verify import", status: "todo", date: new Date("2026-06-19T00:00:00.000Z"), daySegment: "morning", estimatedMinutes: 30 },
      ],
      {
        overall_plan: { title: "PawPlan v0.2", summary: "Ship hosted MCP." },
        weekly_summary: { focus: "Make PawPlan agent-readable.", milestones: ["Hosted MCP"] },
        monthly_summary: { month: "2026-06", goal: "Usable planning loop.", milestones: ["Production deploy", "MCP import"] },
      },
      new Date("2026-06-12T04:00:00.000Z"),
    );

    expect(result.cards).toEqual([
      expect.objectContaining({
        title: "PawPlan v0.2",
        text: "Usable planning loop.",
        tag: "已完成 1/2",
        progress: 50,
      }),
      expect.objectContaining({
        title: "每周拆分",
        text: "Make PawPlan agent-readable.",
        tag: "2 周有任务",
        progress: null,
      }),
      expect.objectContaining({
        title: "重要节点",
        text: "Production deploy；MCP import；Hosted MCP",
        progress: null,
      }),
    ]);
    const june12 = result.days.find((day) => day.key === "2026-06-12");
    expect(june12).toEqual(expect.objectContaining({ taskCount: 1, doneCount: 1, totalMinutes: "1h 30m" }));
    expect(june12?.tasks[0]).toEqual(expect.objectContaining({ title: "Ship MCP", done: true }));
  });

  it("keeps structured task notes available for task detail drawers", () => {
    const result = buildMonthPlanViewData(
      [
        {
          id: "task-1",
          title: "SolidWorks first model",
          status: "todo",
          date: new Date("2026-06-12T00:00:00.000Z"),
          estimatedMinutes: 120,
          daySegment: "afternoon",
          notes: "目标：建出第一个可保存模型\n完成标准：能打开并保存\n- 记录 3 个不熟操作\n资源：入门视频",
        },
      ],
      {},
      new Date("2026-06-12T04:00:00.000Z"),
    );

    const task = result.days.find((day) => day.key === "2026-06-12")?.tasks[0];
    expect(task?.detail.sections).toEqual([
      { label: "目标", lines: ["建出第一个可保存模型"] },
      { label: "完成标准", lines: ["能打开并保存", "记录 3 个不熟操作"] },
      { label: "资源", lines: ["入门视频"] },
    ]);
  });

  it("keeps backlog as a separate count and excludes backlog, skipped, and archived tasks from the execution calendar", () => {
    const result = buildMonthPlanViewData(
      [
        { id: "todo-1", title: "Plan experiment", status: "todo", projectId: "project-1", date: new Date("2026-06-10T00:00:00.000+08:00"), daySegment: "morning", estimatedMinutes: 60 },
        { id: "done-1", title: "Run baseline", status: "done", projectId: "project-1", date: new Date("2026-06-11T00:00:00.000+08:00"), daySegment: "afternoon", estimatedMinutes: 30 },
        { id: "backlog-1", title: "Later idea", status: "backlog", projectId: "project-1", date: new Date("2026-06-12T00:00:00.000+08:00"), daySegment: "morning", estimatedMinutes: 120 },
        { id: "skipped-1", title: "Legacy cleanup", status: "skipped", projectId: "project-1", date: new Date("2026-06-13T00:00:00.000+08:00"), daySegment: "morning", estimatedMinutes: 90 },
        { id: "archived-1", title: "Archived task", status: "todo", projectId: "project-1", date: new Date("2026-06-14T00:00:00.000+08:00"), daySegment: "morning", estimatedMinutes: 600, archivedAt: new Date("2026-06-15T00:00:00.000+08:00") },
      ],
      {},
      new Date("2026-06-12T04:00:00.000Z"),
      new Map([["project-1", { name: "Physics-Grounded Manipulation", color: "#2563eb" }]]),
    );

    expect(result.taskCount).toBe(2);
    expect(result.doneCount).toBe(1);
    expect(result.statusCounts).toEqual({ todo: 1, done: 1, backlog: 1, skipped: 1 });
    expect(result.totalHours).toBe("1h 30m");
    expect(result.completionPercent).toBe(50);
    expect(result.days.flatMap((day) => day.tasks.map((task) => task.id))).toEqual(["todo-1", "done-1"]);
    expect(result.weeks.reduce((sum, week) => sum + week.taskCount, 0)).toBe(2);
    expect(result.projectSummaries).toEqual([
      expect.objectContaining({
        projectName: "Physics-Grounded Manipulation",
        taskCount: 2,
        totalMinutes: "1h 30m",
        statusCounts: { todo: 1, done: 1, backlog: 0, skipped: 0 },
      }),
    ]);
  });

  it("normalizes month query values and moves across year boundaries", () => {
    expect(normalizeMonthKey("2026-08")).toBe("2026-08");
    expect(normalizeMonthKey("2026-13", new Date("2026-06-12T04:00:00.000Z"))).toBe("2026-06");
    expect(addMonthsToMonthKey("2026-12", 1)).toBe("2027-01");
    expect(addMonthsToMonthKey("2026-01", -1)).toBe("2025-12");
  });
});
