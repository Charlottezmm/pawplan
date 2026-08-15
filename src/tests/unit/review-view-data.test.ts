import { describe, expect, it } from "vitest";
import { buildReschedulePatchItems } from "@/lib/planning/view-data";

describe("review view data", () => {
  it("exposes operation evidence and provenance for review cards", () => {
    const items = buildReschedulePatchItems({
      patches: [
        {
          id: "patch-12345678",
          createdBy: "codex",
          createdAt: new Date("2026-06-12T08:30:00.000Z"),
          patchJson: {
            operations: [
              {
                type: "move_task",
                task_id: "task-1",
                from_date: "2026-06-12",
                from_day_segment: "morning",
                to_date: "2026-06-12",
                to_day_segment: "afternoon",
                reason: "Morning is full.",
                capacity_impact: ["morning -60m", "afternoon +60m"],
                protected_evidence: ["Recovery block stays protected"],
              },
              {
                type: "change_priority",
                task_id: "task-2",
                from_priority: "normal",
                to_priority: "urgent",
                reason: "Deadline moved earlier.",
              },
            ],
          },
        },
      ],
      tasks: [
        { id: "task-1", title: "Write review brief" },
        { id: "task-2", title: "Call supplier" },
      ],
      reviews: [
        {
          patchId: "patch-12345678",
          skippedJson: [{ index: 1, type: "change_priority", reason: "Task priority changed since patch was proposed" }],
          conflictJson: [
            {
              index: 1,
              type: "change_priority",
              reason: "Task priority changed since patch was proposed",
              expected: { priority: "normal" },
              actual: { priority: "high" },
            },
          ],
        },
      ],
      agentRuns: [
        {
          id: "run-123",
          kind: "morning_rebalance",
          status: "draft_created",
          patchId: "patch-12345678",
        },
      ],
    });

    expect(items[0]).toEqual(
      expect.objectContaining({
        id: "patch-12345678:0",
        patchId: "patch-12345678",
        operationIndex: 0,
        operationType: "move_task",
        kind: "移动",
        title: "Write review brief",
        from: "2026-06-12 morning",
        to: "2026-06-12 afternoon",
        reason: "Morning is full.",
        impact: ["morning -60m", "afternoon +60m"],
        protectedEvidence: ["Recovery block stays protected"],
        provenance: {
          patchId: "patch-12345678",
          operationIndex: 0,
          createdBy: "codex",
          createdAt: "2026-06-12T08:30:00.000Z",
        },
        agentRun: {
          id: "run-123",
          kind: "morning_rebalance",
          status: "draft_created",
        },
        agentRunLabel: "Created by daily rebalance",
      }),
    );
    expect(items[1]).toEqual(
      expect.objectContaining({
        id: "patch-12345678:1",
        operationIndex: 1,
        skipped: true,
        conflict: expect.objectContaining({
          reason: "Task priority changed since patch was proposed",
          expected: { priority: "normal" },
          actual: { priority: "high" },
        }),
      }),
    );
  });

  it("renders timetable import drafts as reviewable user-confirmed operations", () => {
    const items = buildReschedulePatchItems({
      patches: [
        {
          id: "patch-timetable",
          createdBy: "codex",
          createdAt: new Date("2026-06-13T08:00:00.000Z"),
          patchJson: {
            operations: [
              {
                type: "import_timetable",
                source_label: "summer course table",
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
                    recurrence: null,
                    notes: null,
                  },
                ],
                reason: "Prepare course constraints for user review.",
                capacity_impact: ["将创建 1 个固定时间块", "不会自动写入，需用户确认"],
              },
            ],
          },
        },
      ],
      tasks: [],
    });

    expect(items).toEqual([
      expect.objectContaining({
        id: "patch-timetable:0",
        patchId: "patch-timetable",
        operationIndex: 0,
        operationType: "import_timetable",
        kind: "导入日程",
        title: "导入日程表：summer course table",
        from: "未导入",
        to: "1 行 / 1 个时间块",
        reason: "Prepare course constraints for user review.",
        impact: ["将创建 1 个固定时间块", "不会自动写入，需用户确认"],
        protected: false,
      }),
    ]);
  });

  it("uses the first agent run when multiple runs reference the same patch", () => {
    const items = buildReschedulePatchItems({
      patches: [
        {
          id: "patch-same-run",
          createdBy: "codex",
          createdAt: new Date("2026-06-14T08:00:00.000Z"),
          patchJson: {
            operations: [
              {
                type: "move_task",
                task_id: "task-1",
                from_date: "2026-06-14",
                from_day_segment: "morning",
                to_date: "2026-06-14",
                to_day_segment: "afternoon",
                reason: "Prefer the newest run returned by the query.",
              },
            ],
          },
        },
      ],
      tasks: [{ id: "task-1", title: "Move task" }],
      agentRuns: [
        {
          id: "run-newer",
          kind: "weekly_rebalance",
          status: "draft_created",
          patchId: "patch-same-run",
        },
        {
          id: "run-older",
          kind: "morning_rebalance",
          status: "failed",
          patchId: "patch-same-run",
        },
      ],
    });

    expect(items[0]).toEqual(
      expect.objectContaining({
        agentRun: {
          id: "run-newer",
          kind: "weekly_rebalance",
          status: "draft_created",
        },
        agentRunLabel: "Created by weekly rebalance",
      }),
    );
  });

  it("marks overdue rollover drafts as requiring final rollover readback", () => {
    const items = buildReschedulePatchItems({
      patches: [{
        id: "patch-overdue",
        createdBy: "codex",
        createdAt: new Date("2026-08-15T08:00:00.000Z"),
        patchJson: {
          operations: [{
            type: "move_task",
            task_id: "task-overdue",
            from_date: "2026-08-14",
            from_day_segment: "morning",
            to_date: "2026-08-16",
            to_day_segment: "afternoon",
            overdue_rollover: true,
            expected_rollover_count: 0,
            reason: "首次逾期，安排到安全时段。",
          }],
        },
      }],
      tasks: [{ id: "task-overdue", title: "Run experiment" }],
      agentRuns: [{
        id: "run-overdue",
        kind: "overdue_replan",
        status: "draft_created",
        patchId: "patch-overdue",
      }],
    });

    expect(items[0]).toEqual(expect.objectContaining({
      kind: "逾期顺延",
      requiresRolloverReadback: true,
      agentRunLabel: "Created by overdue replan",
    }));
  });
});
