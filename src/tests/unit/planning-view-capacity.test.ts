import { describe, expect, it } from "vitest";
import { buildDayTimelineItems, buildWeekDays } from "@/lib/planning/view-data";

describe("planning week view", () => {
  it("builds week days without capacity state", () => {
    const weekDates = [
      new Date("2026-06-12T00:00:00.000+08:00"),
      new Date("2026-06-13T00:00:00.000+08:00"),
    ];

    const days = buildWeekDays({
      weekDates,
      today: new Date("2026-06-12T00:00:00.000+08:00"),
      taskRows: [
        {
          id: "task-1",
          title: "Morning implementation",
          date: new Date("2026-06-12T00:00:00.000+08:00"),
          daySegment: "morning",
          estimatedMinutes: 90,
          status: "todo",
        },
        {
          id: "task-backlog",
          title: "Later idea",
          date: new Date("2026-06-12T00:00:00.000+08:00"),
          daySegment: "morning",
          estimatedMinutes: 300,
          status: "backlog",
        },
        {
          id: "task-skipped",
          title: "Legacy skipped task",
          date: new Date("2026-06-12T00:00:00.000+08:00"),
          daySegment: "morning",
          estimatedMinutes: 300,
          status: "skipped",
        },
      ],
      blockRows: [
        {
          id: "course-1",
          title: "Course block",
          kind: "course",
          startsAt: new Date("2026-06-12T09:00:00.000+08:00"),
          endsAt: new Date("2026-06-12T10:00:00.000+08:00"),
        },
      ],
      routineRows: [],
    });

    expect(days[0]).toEqual(
      expect.objectContaining({
        state: "today",
        items: ["Morning implementation"],
        taskCount: 1,
        doneCount: 0,
        totalMinutes: "1h 30m",
      }),
    );
    expect(days[0].tasks[0]).toEqual(expect.objectContaining({ title: "Morning implementation", minutes: 90 }));
    expect(days[0].tasks.map((task) => task.id)).not.toContain("task-skipped");
    expect(days[0].fixedItems[0]).toEqual(expect.objectContaining({ title: "Course block", kind: "course" }));
    expect(days[1]).toEqual(expect.objectContaining({ state: "default", items: [], taskCount: 0 }));
    expect(days[0]).not.toHaveProperty("load");
    expect(days[0]).not.toHaveProperty("capacity");
  });
});

describe("planning timeline data", () => {
  it("exposes dated task and protected block items with start/end times", () => {
    const items = buildDayTimelineItems({
      date: new Date("2026-06-12T00:00:00.000+08:00"),
      taskRows: [
        {
          id: "task-1",
          title: "Write implementation",
          date: new Date("2026-06-12T00:00:00.000+08:00"),
          daySegment: "morning",
          estimatedMinutes: 90,
          status: "todo",
        },
      ],
      blockRows: [
        {
          id: "course-1",
          title: "Course block",
          kind: "course",
          startsAt: new Date("2026-06-12T09:00:00.000+08:00"),
          endsAt: new Date("2026-06-12T10:00:00.000+08:00"),
        },
      ],
      routineRows: [
        {
          id: "routine-1",
          title: "Morning walk",
          defaultTimeSegment: "specific_window",
          defaultStartTime: "07:30",
          defaultEndTime: "08:00",
          weekdayPattern: "fri",
          estimatedMinutes: 30,
        },
      ],
    });

    expect(items).toEqual([
      expect.objectContaining({
        id: "task-1",
        kind: "task",
        title: "Write implementation",
        startsAt: "2026-06-11T16:00:00.000Z",
        endsAt: "2026-06-11T17:30:00.000Z",
        protected: false,
      }),
      expect.objectContaining({
        id: "routine-1",
        kind: "routine",
        title: "Morning walk",
        startsAt: "2026-06-11T23:30:00.000Z",
        endsAt: "2026-06-12T00:00:00.000Z",
        protected: true,
      }),
      expect.objectContaining({
        id: "course-1",
        kind: "course",
        title: "Course block",
        startsAt: "2026-06-12T01:00:00.000Z",
        endsAt: "2026-06-12T02:00:00.000Z",
        protected: true,
      }),
    ]);
  });

  it("expands recurring protected blocks before building a day timeline", () => {
    const mondayItems = buildDayTimelineItems({
      date: new Date("2026-06-15T00:00:00.000+08:00"),
      taskRows: [],
      blockRows: [
        {
          id: "study-rule",
          title: "Study block",
          kind: "routine",
          startsAt: new Date("2026-06-15T05:00:00.000+08:00"),
          endsAt: new Date("2026-06-30T07:00:00.000+08:00"),
          recurrenceWeekdayMask: 1 << 1,
        },
      ],
      routineRows: [],
    });
    const tuesdayItems = buildDayTimelineItems({
      date: new Date("2026-06-16T00:00:00.000+08:00"),
      taskRows: [],
      blockRows: [
        {
          id: "study-rule",
          title: "Study block",
          kind: "routine",
          startsAt: new Date("2026-06-15T05:00:00.000+08:00"),
          endsAt: new Date("2026-06-30T07:00:00.000+08:00"),
          recurrenceWeekdayMask: 1 << 1,
        },
      ],
      routineRows: [],
    });

    expect(mondayItems).toEqual([
      expect.objectContaining({
        id: "study-rule__2026-06-15",
        startsAt: "2026-06-14T21:00:00.000Z",
        endsAt: "2026-06-14T23:00:00.000Z",
      }),
    ]);
    expect(tuesdayItems).toEqual([]);
  });
});
