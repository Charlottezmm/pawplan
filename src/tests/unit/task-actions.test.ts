import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  defaultPostponeDate,
  moveOutOfScheduleUpdate,
  postponeTaskUpdate,
  shanghaiDateKey,
} from "@/lib/planning/task-actions";

describe("task date actions", () => {
  it("uses the Shanghai calendar day when choosing the default postpone date", () => {
    const instant = new Date("2026-08-15T16:30:00.000Z");
    expect(shanghaiDateKey(instant)).toBe("2026-08-16");
    expect(defaultPostponeDate(instant)).toBe("2026-08-17");
  });

  it("moves across month boundaries without changing the date key shape", () => {
    expect(addDaysToDateKey("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("rejects impossible calendar dates", () => {
    expect(() => addDaysToDateKey("2026-02-30", 1)).toThrow("Invalid date key");
  });

  it("keeps ordinary postponement as todo and reserves backlog for moving out of schedule", () => {
    expect(postponeTaskUpdate("task-1", "2026-08-17")).toEqual({
      id: "task-1",
      date: "2026-08-17",
      status: "todo",
      blocked: false,
    });
    expect(moveOutOfScheduleUpdate("task-1")).toEqual({
      id: "task-1",
      status: "backlog",
      blocked: false,
    });
  });
});
