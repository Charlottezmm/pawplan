import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildTimetableAxis,
  layoutTimetableIntervals,
  minuteLabel,
} from "@/lib/planning/timetable-layout";
import { shanghaiTimetableParts } from "@/lib/planning/timetable-view-data";

describe("timetable layout", () => {
  it("keeps real-minute positions and durations", () => {
    const axis = { startMinute: 6 * 60, endMinute: 23 * 60 };
    const items = layoutTimetableIntervals([
      { id: "a", startMinute: 8 * 60 + 30, endMinute: 9 * 60 + 15 },
      { id: "b", startMinute: 11 * 60 + 30, endMinute: 12 * 60 + 45 },
      { id: "c", startMinute: 14 * 60 + 15, endMinute: 16 * 60 },
    ], axis);

    expect(items.map(({ id, top, height }) => ({ id, top, height }))).toEqual([
      { id: "a", top: 150, height: 45 },
      { id: "b", top: 330, height: 75 },
      { id: "c", top: 495, height: 105 },
    ]);
  });

  it("does not treat adjacent intervals as conflicts", () => {
    const items = layoutTimetableIntervals([
      { id: "first", startMinute: 9 * 60, endMinute: 10 * 60 },
      { id: "second", startMinute: 10 * 60, endMinute: 11 * 60 },
    ]);

    expect(items.map(({ lane, laneCount, conflict }) => ({ lane, laneCount, conflict }))).toEqual([
      { lane: 0, laneCount: 1, conflict: false },
      { lane: 0, laneCount: 1, conflict: false },
    ]);
  });

  it("assigns stable lanes to two and three-way overlaps", () => {
    const items = layoutTimetableIntervals([
      { id: "long", startMinute: 9 * 60, endMinute: 12 * 60 },
      { id: "middle", startMinute: 9 * 60 + 30, endMinute: 10 * 60 + 30 },
      { id: "short", startMinute: 10 * 60, endMinute: 11 * 60 },
    ]);

    expect(items.map(({ id, lane, laneCount, conflict }) => ({ id, lane, laneCount, conflict }))).toEqual([
      { id: "long", lane: 0, laneCount: 3, conflict: true },
      { id: "middle", lane: 1, laneCount: 3, conflict: true },
      { id: "short", lane: 2, laneCount: 3, conflict: true },
    ]);
  });

  it("keeps a chain of overlaps in one component", () => {
    const items = layoutTimetableIntervals([
      { id: "a", startMinute: 9 * 60, endMinute: 10 * 60 },
      { id: "b", startMinute: 9 * 60 + 30, endMinute: 10 * 60 + 30 },
      { id: "c", startMinute: 10 * 60 + 15, endMinute: 11 * 60 },
    ]);

    expect(items.map((item) => item.laneCount)).toEqual([2, 2, 2]);
    expect(items.map((item) => item.lane)).toEqual([0, 1, 0]);
  });

  it("extends but never shrinks the 06:00-23:00 axis", () => {
    expect(buildTimetableAxis([])).toEqual({ startMinute: 360, endMinute: 1380 });
    expect(buildTimetableAxis([
      { id: "early", startMinute: 300, endMinute: 360 },
      { id: "late", startMinute: 1350, endMinute: 1410 },
    ])).toEqual({ startMinute: 240, endMinute: 1440 });
  });

  it("formats minute labels", () => {
    expect(minuteLabel(8 * 60 + 5)).toBe("08:05");
  });

  it("maps Shanghai midnight to minute zero instead of hour 24", () => {
    expect(shanghaiTimetableParts(new Date("2026-08-26T16:00:00.000Z"))).toEqual({
      dateKey: "2026-08-27",
      minute: 0,
    });
    expect(shanghaiTimetableParts(new Date("2026-08-26T16:30:00.000Z")).minute).toBe(30);
  });

  it("keeps short blocks visually proportional while exposing a 44px hit area", () => {
    const css = readFileSync("src/components/time-block-timetable.module.css", "utf8");
    const component = readFileSync("src/components/time-block-timetable.tsx", "utf8");
    const blockRule = css.match(/\.courseBlock \{[\s\S]*?\}/)?.[0] ?? "";
    const stripRule = css.match(/\.courseBlock::before \{[\s\S]*?\}/)?.[0] ?? "";
    const hitRule = css.match(/\.courseBlock::after \{[\s\S]*?\}/)?.[0] ?? "";
    const contentRule = css.match(/\.blockContent \{[\s\S]*?\}/)?.[0] ?? "";
    const titleRule = css.match(/\.blockTitle \{[\s\S]*?\}/)?.[0] ?? "";
    const metaRule = css.match(/\.blockMeta \{[\s\S]*?\}/)?.[0] ?? "";
    const mobileRule = css.slice(css.indexOf("@media (max-width: 760px)"));

    expect(blockRule).toContain("top: var(--block-top);");
    expect(blockRule).toContain("height: var(--block-height);");
    expect(blockRule).not.toContain("min-height: 44px;");
    expect(blockRule).toContain("overflow: visible;");
    expect(blockRule).toContain("var(--course-color) 16%");
    expect(stripRule).toContain("width: 4px;");
    expect(stripRule).toContain("background: var(--course-color);");
    expect(hitRule).toContain("width: max(100%, 44px);");
    expect(hitRule).toContain("height: max(100%, 44px);");
    expect(hitRule).not.toContain("background:");
    expect(css).toContain(".hitExtendBefore::after");
    expect(css).toContain(".hitExtendAfter::after");
    expect(contentRule).toContain("overflow: hidden;");
    expect(titleRule).toContain("text-overflow: ellipsis;");
    expect(titleRule).toContain("white-space: nowrap;");
    expect(metaRule).toContain("display: flex;");
    expect(metaRule).toContain("overflow: hidden;");
    expect(css).not.toMatch(/\.compactBlock \.blockTime\s*\{[^}]*display:\s*none/);
    expect(css).not.toMatch(/\.compactBlock \.blockLocation\s*\{[^}]*display:\s*none/);
    expect(component).toContain("item.courseName?.trim() || item.title");
    expect(component).toContain("styles.blockTime");
    expect(component).toContain("styles.blockLocation");
    expect(component).toContain('item.location?.trim() || "地点待确认"');
    expect(component).toContain('selected?.location?.trim() || "地点待确认"');
    expect(component).toContain("redactPrivateTitle(selected.courseName?.trim() || selected.title)");
    expect(component).not.toContain("candidate.height < 44");
    expect(mobileRule).toContain("width: calc(100% + 32px);");
    expect(mobileRule).toContain("grid-template-columns: repeat(7, minmax(44px, 1fr));");
    expect(mobileRule).toContain("min-width: 44px;");
  });
});
