import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildExactFixedTimelineItems } from "@/lib/planning/view-data";

describe("Today exact fixed timeline", () => {
  it("includes real time blocks and specific-window routines only", () => {
    const items = buildExactFixedTimelineItems({
      date: new Date("2026-08-30T04:00:00.000Z"),
      blockRows: [{
        id: "course",
        title: "课程",
        kind: "course",
        startsAt: new Date("2026-08-30T01:00:00.000Z"),
        endsAt: new Date("2026-08-30T03:00:00.000Z"),
        protected: true,
      }],
      routineRows: [
        {
          id: "rough-routine",
          title: "晚间复盘",
          defaultTimeSegment: "evening",
          defaultStartTime: null,
          defaultEndTime: null,
          weekdayPattern: "daily",
          estimatedMinutes: 30,
        },
        {
          id: "incomplete-window",
          title: "只有开始时间",
          defaultTimeSegment: "specific_window",
          defaultStartTime: "18:00",
          defaultEndTime: null,
          weekdayPattern: "daily",
          estimatedMinutes: 30,
        },
        {
          id: "exact-routine",
          title: "健身",
          defaultTimeSegment: "specific_window",
          defaultStartTime: "19:00",
          defaultEndTime: "20:00",
          weekdayPattern: "daily",
          estimatedMinutes: 60,
        },
      ],
    });

    expect(items.map((item) => item.id)).toEqual(["course", "exact-routine"]);
    expect(items.map((item) => item.minutes)).toEqual([120, 60]);
  });

  it("keeps visual height proportional and exposes a transparent 44px hit area", () => {
    const css = readFileSync("src/components/today-fixed-timeline.module.css", "utf8");
    const blockRule = css.match(/\.block \{[\s\S]*?\}/)?.[0] ?? "";
    const hitRule = css.match(/\.block::after \{[\s\S]*?\}/)?.[0] ?? "";

    expect(blockRule).toContain("height: var(--block-height);");
    expect(blockRule).not.toContain("min-height: 44px;");
    expect(hitRule).toContain("height: max(100%, 44px);");
    expect(hitRule).not.toContain("background:");
  });
});
