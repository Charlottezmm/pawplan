import { describe, expect, it } from "vitest";
import {
  expandEffectiveRecurringBlocks,
  expandRecurringBlocks,
} from "@/lib/planning/recurring-time-blocks";

describe("recurring time block expansion", () => {
  it("expands a weekly rule into dated occurrences inside the requested range", () => {
    const occurrences = expandRecurringBlocks(
      [
        {
          id: "block-1",
          title: "Study block",
          kind: "routine",
          startsAt: new Date("2026-06-15T05:00:00.000+08:00"),
          endsAt: new Date("2026-06-30T07:00:00.000+08:00"),
          recurrenceWeekdayMask: (1 << 1) | (1 << 3),
        },
      ],
      new Date("2026-06-15T00:00:00.000+08:00"),
      new Date("2026-06-22T00:00:00.000+08:00"),
    );

    expect(occurrences).toEqual([
      expect.objectContaining({
        id: "block-1__2026-06-15",
        startsAt: new Date("2026-06-15T05:00:00.000+08:00"),
        endsAt: new Date("2026-06-15T07:00:00.000+08:00"),
        recurrenceSourceId: "block-1",
      }),
      expect.objectContaining({
        id: "block-1__2026-06-17",
        startsAt: new Date("2026-06-17T05:00:00.000+08:00"),
        endsAt: new Date("2026-06-17T07:00:00.000+08:00"),
        recurrenceSourceId: "block-1",
      }),
    ]);
  });

  it("applies cancel and override exceptions after expanding a series", () => {
    const occurrences = expandEffectiveRecurringBlocks(
      [
        {
          id: "block-1",
          title: "Study block",
          kind: "routine",
          protected: true,
          startsAt: new Date("2026-06-15T05:00:00.000+08:00"),
          endsAt: new Date("2026-06-30T07:00:00.000+08:00"),
          recurrenceWeekdayMask: (1 << 1) | (1 << 3),
        },
      ],
      [
        {
          id: "cancel-1",
          seriesId: "block-1",
          occurrenceDate: "2026-06-15",
          action: "cancel",
        },
        {
          id: "override-1",
          seriesId: "block-1",
          occurrenceDate: "2026-06-17",
          action: "override",
          overrideTitle: "Moved study block",
          overrideStartsAt: new Date("2026-06-17T08:00:00.000+08:00"),
          overrideEndsAt: new Date("2026-06-17T09:00:00.000+08:00"),
          overrideProtected: false,
        },
      ],
      new Date("2026-06-15T00:00:00.000+08:00"),
      new Date("2026-06-22T00:00:00.000+08:00"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      id: "block-1__2026-06-17",
      recurrenceSourceId: "block-1",
      occurrenceDate: "2026-06-17",
      title: "Moved study block",
      protected: false,
      startsAt: new Date("2026-06-17T08:00:00.000+08:00"),
      endsAt: new Date("2026-06-17T09:00:00.000+08:00"),
    });
  });
});
