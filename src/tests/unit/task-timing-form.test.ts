import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import {
  selectedTimingTaskIds,
  timingMinutes,
  timingRequestKey,
} from "@/lib/client/task-timing-form";
import type { TimingTask } from "@/lib/planning/task-timing";

const task = (
  id: string,
  date: string,
  more: Partial<TimingTask> = {},
): TimingTask => ({
  id,
  date,
  title: id,
  daySegment: "morning",
  status: "todo",
  movable: true,
  estimatedMinutes: 30,
  updatedAt: "2026-09-20T00:00:00Z",
  scheduledStart: null,
  scheduledEnd: null,
  deadlineAt: null,
  targetDate: null,
  checkpoint: null,
  ...more,
});

describe("timing dialog request guards", () => {
  it("does not submit previous-day or unavailable tasks after a date change", () => {
    const tasks = [
      task("yesterday", "2026-09-20"),
      task("today", "2026-09-21"),
      task("locked", "2026-09-21", { movable: false }),
      task("done", "2026-09-21", { status: "done" }),
    ];
    expect(
      selectedTimingTaskIds(tasks, "2026-09-21", [
        "yesterday",
        "today",
        "locked",
        "done",
        "missing",
      ]),
    ).toEqual(["today"]);
    expect(selectedTimingTaskIds(tasks, "2026-09-21", ["yesterday"])).toEqual(
      [],
    );
  });
  it.each(["", " ", "0", "4", "481", "5.5", "NaN", "Infinity"])(
    "rejects invalid duration %j",
    (input) => {
      expect(() => timingMinutes(input, 480)).toThrow("整数分钟");
    },
  );
  it("accepts both bounds and enforces the shorter extension limit", () => {
    expect(timingMinutes("5", 480)).toBe(5);
    expect(timingMinutes("480", 480)).toBe(480);
    expect(() => timingMinutes("121", 120)).toThrow();
    expect(timingMinutes("120", 120)).toBe(120);
  });
  it("generates unique UUID v4 keys when LAN HTTP omits randomUUID", () => {
    const cryptoApi = {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    } as Pick<Crypto, "getRandomValues">;
    const first = timingRequestKey(cryptoApi);
    expect(first).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
    expect(timingRequestKey(cryptoApi)).not.toBe(first);
  });
});
