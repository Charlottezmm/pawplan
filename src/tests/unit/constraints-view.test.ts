import { describe, expect, it } from "vitest";
import { buildConstraintGroups, buildConstraintTimelineRows } from "@/components/constraints-view";
import { redactPrivateTitle } from "@/lib/display/privacy";

function block(input: {
  id: string;
  title: string;
  kind?: "course" | "meeting" | "unavailable" | "routine" | "recovery";
  startsAt: string;
  endsAt: string;
  recurrenceWeekdayMask?: number | null;
  location?: string | null;
}) {
  return {
    id: input.id,
    title: input.title,
    kind: input.kind ?? "routine",
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    recurrenceRule: null,
    recurrenceWeekdayMask: input.recurrenceWeekdayMask ?? null,
    courseId: null,
    courseName: null,
    location: input.location ?? null,
    movable: false as const,
  };
}

describe("constraints view helpers", () => {
  it("redacts private names from fixed schedule titles", () => {
    expect(redactPrivateTitle("工作·程辉硬件(SolidWorks+Kalpakjian)")).toBe("工作·硬件(SolidWorks+Kalpakjian)");
  });

  it("folds repeated concrete time blocks into weekly summary groups", () => {
    const groups = buildConstraintGroups([
      block({
        id: "mon-hard",
        title: "学习主线·硬核",
        startsAt: "2026-06-15T05:00:00.000+08:00",
        endsAt: "2026-06-15T07:00:00.000+08:00",
      }),
      block({
        id: "tue-hard",
        title: "学习主线·硬核",
        startsAt: "2026-06-16T05:00:00.000+08:00",
        endsAt: "2026-06-16T07:00:00.000+08:00",
      }),
      block({
        id: "mon-work",
        title: "工作·程辉硬件",
        startsAt: "2026-06-15T13:00:00.000+08:00",
        endsAt: "2026-06-15T18:00:00.000+08:00",
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(expect.objectContaining({
      title: "学习主线·硬核",
      startTime: "05:00",
      endTime: "07:00",
      weekdays: ["mon", "tue"],
      blocks: expect.arrayContaining([expect.objectContaining({ id: "mon-hard" }), expect.objectContaining({ id: "tue-hard" })]),
    }));
    expect(groups[1]).toEqual(expect.objectContaining({
      title: "工作·程辉硬件",
      weekdays: ["mon"],
      blocks: [expect.objectContaining({ id: "mon-work" })],
    }));
  });

  it("shows one timeline row per recurring group for a selected weekday", () => {
    const groups = buildConstraintGroups([
      block({
        id: "mon-hard-1",
        title: "学习主线·硬核",
        startsAt: "2026-06-15T05:00:00.000+08:00",
        endsAt: "2026-06-15T07:00:00.000+08:00",
      }),
      block({
        id: "mon-hard-2",
        title: "学习主线·硬核",
        startsAt: "2026-06-22T05:00:00.000+08:00",
        endsAt: "2026-06-22T07:00:00.000+08:00",
      }),
      block({
        id: "mon-hard-3",
        title: "学习主线·硬核",
        startsAt: "2026-06-29T05:00:00.000+08:00",
        endsAt: "2026-06-29T07:00:00.000+08:00",
      }),
    ]);

    const rows = buildConstraintTimelineRows(groups, "mon");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      title: "学习主线·硬核",
      startTime: "05:00",
      endTime: "07:00",
      instanceCount: 3,
    }));
  });

  it("uses recurrence weekday masks for one-rule weekly summaries", () => {
    const groups = buildConstraintGroups([
      block({
        id: "study-rule",
        title: "学习主线·硬核",
        startsAt: "2026-06-15T05:00:00.000+08:00",
        endsAt: "2026-06-30T07:00:00.000+08:00",
        recurrenceWeekdayMask: (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6),
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].weekdays).toEqual(["mon", "tue", "wed", "thu", "fri", "sat"]);
    expect(buildConstraintTimelineRows(groups, "wed")).toEqual([
      expect.objectContaining({
        title: "学习主线·硬核",
        instanceCount: 1,
      }),
    ]);
  });

  it("keeps same-time course instances separate when their locations differ", () => {
    const groups = buildConstraintGroups([
      block({
        id: "course-room-a",
        title: "Linear Algebra",
        kind: "course",
        startsAt: "2026-06-15T09:00:00.000+08:00",
        endsAt: "2026-06-15T10:00:00.000+08:00",
        location: "C 201",
      }),
      block({
        id: "course-room-b",
        title: "Linear Algebra",
        kind: "course",
        startsAt: "2026-06-22T09:00:00.000+08:00",
        endsAt: "2026-06-22T10:00:00.000+08:00",
        location: "C 305",
      }),
    ]);

    expect(groups.map((group) => group.location)).toEqual(["C 201", "C 305"]);
  });
});
