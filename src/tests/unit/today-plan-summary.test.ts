import { describe, expect, it } from "vitest";
import { buildTodayPlannedItems, getTodayPlanSummary, type TodayTimingData } from "@/lib/planning/today-plan-summary";
import type { TimelineItemView } from "@/lib/planning/view-data";
import type { ActualRecord } from "@/lib/actual-records/schema";

const date = "2026-09-30";
const instant = (clock: string) => new Date(`${date}T${clock}:00+08:00`);
function item(id: string, start: string, end: string, kind: TimelineItemView["kind"] = "course"): TimelineItemView {
  return { id, title: id, kind, startsAt: instant(start).toISOString(), endsAt: instant(end).toISOString(), minutes: 60, segment: "afternoon", protected: true };
}
const course = item("课程", "16:00", "17:15");
const meeting = item("会议", "18:00", "19:00", "meeting");

describe("Today current and next planned arrangements", () => {
  it("still shows the current course when all tasks are done", () => {
    const task = item("已完成任务", "16:00", "16:30", "task");
    const result = getTodayPlanSummary([task, meeting, course], date, instant("16:10"), [task.id]);
    expect(result.state).toBe("scheduled");
    expect(result.current.map((row) => row.id)).toEqual([course.id]);
    expect(result.next?.id).toBe(meeting.id);
  });

  it("shows the next fixed arrangement even with no tasks", () => {
    const result = getTodayPlanSummary([meeting, course], date, instant("15:59"), []);
    expect(result.current).toEqual([]);
    expect(result.next?.id).toBe(course.id);
  });

  it("uses inclusive starts and exclusive ends, including adjacent slots", () => {
    const next = item("紧接的课程", "17:15", "18:00");
    expect(getTodayPlanSummary([course, next], date, instant("16:00"), []).current.map((row) => row.id)).toEqual([course.id]);
    expect(getTodayPlanSummary([course, next], date, instant("17:15"), []).current.map((row) => row.id)).toEqual([next.id]);
    expect(getTodayPlanSummary([course, next], date, instant("18:00"), []).state).toBe("finished");
  });

  it("keeps simultaneous current plans visible and chooses the nearest future slot", () => {
    const overlap = item("重叠安排", "16:05", "16:45", "meeting");
    const result = getTodayPlanSummary([meeting, overlap, course], date, instant("16:10"), []);
    expect(result.current.map((row) => row.id)).toEqual([course.id, overlap.id]);
    expect(result.next?.id).toBe(meeting.id);
  });

  it("distinguishes no clock slots, ended slots and an unhydrated clock", () => {
    expect(getTodayPlanSummary([], date, instant("12:00"), []).state).toBe("empty");
    expect(getTodayPlanSummary([course], date, instant("23:59"), []).state).toBe("finished");
    expect(getTodayPlanSummary([course], date, null, []).state).toBe("loading");
  });

  it("requires a fresh day after Shanghai midnight rather than showing yesterday as today's plan", () => {
    expect(getTodayPlanSummary([course], date, new Date("2026-09-30T16:00:00Z"), []).state).toBe("stale");
    expect(getTodayPlanSummary([course], date, new Date("2026-09-29T16:00:00Z"), []).next?.id).toBe(course.id);
  });

  it("uses the timeline's plan-versus-actual visibility rules without promoting actual records into planned activity", () => {
    const task = item("已经记录实际经历的任务", "16:00", "17:00", "task");
    const record = { id: "record", taskId: task.id, title: "实际记录", startsAt: instant("15:30").toISOString(), endsAt: instant("16:30").toISOString(), deletedAt: null, task: { status: "todo" } } as ActualRecord;
    const result = getTodayPlanSummary([task, course, meeting], date, instant("16:15"), [], [record]);
    expect(result.current.map((row) => row.id)).toEqual([course.id]);
    expect(result.next?.id).toBe(meeting.id);
  });

  it("preserves real slots and fixed kinds, omitting coarse, backlog and other-day tasks", () => {
    const task: TodayTimingData["tasks"][number] = { updatedAt: instant("12:00").toISOString(), deadlineAt: null, targetDate: null, checkpoint: null, id: "exact", title: "精确任务", date, status: "todo", scheduledStart: instant("20:00").toISOString(), scheduledEnd: instant("21:00").toISOString(), estimatedMinutes: 120, daySegment: "evening", movable: false };
    const data: TodayTimingData = { date, fixed: [course], tasks: [task, { ...task, id: "coarse", scheduledStart: null, scheduledEnd: null }, { ...task, id: "backlog", status: "backlog" }, { ...task, id: "tomorrow", date: "2026-10-01" }] };
    const planned = buildTodayPlannedItems(data, [course]);
    expect(planned.map((row) => row.id)).toEqual([course.id, task.id]);
    expect(planned[0].kind).toBe("course");
    expect(planned[1]).toMatchObject({ startsAt: task.scheduledStart, endsAt: task.scheduledEnd, minutes: 60, protected: true });
    expect(buildTodayPlannedItems(null, [course])).toEqual([course]);
  });
});
