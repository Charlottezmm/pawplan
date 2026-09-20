import { describe, it, expect } from "vitest";
import {
  buildTimingChanges,
  localInstant,
  timingRequestSchema,
  type TimingTask,
  type TimingRequest,
} from "@/lib/planning/task-timing";
const date = "2026-09-21";
const now = new Date("2026-09-21T07:00:00+08:00");
const task = (id: string, more: Partial<TimingTask> = {}): TimingTask => ({
  id,
  title: id,
  date,
  daySegment: "morning",
  status: "todo",
  movable: true,
  estimatedMinutes: 30,
  updatedAt: now.toISOString(),
  scheduledStart: null,
  scheduledEnd: null,
  deadlineAt: null,
  targetDate: null,
  checkpoint: null,
  ...more,
});
const slot = (a: number, b: number) => ({
  scheduledStart: localInstant(date, a),
  scheduledEnd: localInstant(date, b),
});
const arrange = (ids: string[]): TimingRequest => ({
  action: "arrange",
  date,
  startTime: "08:00",
  endTime: "22:00",
  gapMinutes: 0,
  taskIds: ids,
});
describe("task timing planning", () => {
  it("places morning work around fixed classes without mutating input", () => {
    const rows = [task("a"), task("b")];
    const result = buildTimingChanges(
      arrange(["a", "b"]),
      rows,
      [
        {
          id: "c",
          title: "class",
          startsAt: localInstant(date, 480),
          endsAt: localInstant(date, 540),
        },
      ],
      now,
    );
    expect(result.changes.map((c) => c.after.scheduledStart)).toEqual([
      localInstant(date, 540),
      localInstant(date, 570),
    ]);
    expect(rows[0].scheduledStart).toBeNull();
  });
  it("preserves morning preference and explicitly reports no fit", () => {
    const result = buildTimingChanges(
      arrange(["a"]),
      [task("a", { estimatedMinutes: 300 })],
      [],
      now,
    );
    expect(result.changes).toEqual([]);
    expect(result.warnings[0]).toContain("没有可用时段");
  });
  it("reserves unslotted work before backlog suggestions", () => {
    const request = { ...arrange(["b"]), endTime: "09:00" };
    const r = buildTimingChanges(
      request,
      [
        task("existing", { estimatedMinutes: 60 }),
        task("b", { status: "backlog" }),
      ],
      [],
      now,
    );
    expect(r.changes).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
  it("shifts later tasks after extension while retaining order", () => {
    const r = buildTimingChanges(
      { action: "extend", taskId: "a", minutes: 20, endTime: "22:00" },
      [
        task("a", slot(480, 510)),
        task("b", slot(510, 540)),
        task("c", slot(540, 570)),
      ],
      [],
      now,
    );
    expect(r.changes.map((c) => c.after.scheduledEnd)).toEqual([
      localInstant(date, 530),
      localInstant(date, 560),
      localInstant(date, 590),
    ]);
  });
  it("refuses extension into a protected task", () => {
    expect(() =>
      buildTimingChanges(
        { action: "extend", taskId: "a", minutes: 20, endTime: "22:00" },
        [
          task("a", slot(480, 510)),
          task("b", { ...slot(510, 540), movable: false }),
        ],
        [],
        now,
      ),
    ).toThrow("受保护");
  });
  it("refuses cascade that cannot fit and never silently removes a task", () => {
    expect(() =>
      buildTimingChanges(
        { action: "extend", taskId: "a", minutes: 20, endTime: "09:00" },
        [task("a", slot(480, 510)), task("b", slot(510, 540))],
        [],
        now,
      ),
    ).toThrow("排不下");
  });
  it("pause records remaining work without completing the task", () => {
    const r = buildTimingChanges(
      { action: "pause", taskId: "a", checkpoint: "第 4 页继续" },
      [task("a", slot(480, 510))],
      [],
      now,
    );
    expect(r.changes[0].after).toMatchObject({
      status: "todo",
      scheduledStart: null,
      checkpoint: "第 4 页继续",
    });
  });
  it("defers remaining work and retains its checkpoint", () => {
    const r = buildTimingChanges(
      {
        action: "defer",
        taskId: "a",
        date: "2026-09-22",
        startTime: "08:00",
        endTime: "22:00",
        gapMinutes: 10,
        minutes: 20,
        checkpoint: "例题2",
      },
      [task("a", slot(480, 510))],
      [],
      now,
    );
    expect(r.changes[0].after).toMatchObject({
      date: "2026-09-22",
      status: "todo",
      checkpoint: "例题2",
    });
  });
  it("deadline blocks a slot, desired date only warns", () => {
    const edit = {
      taskId: "a",
      date,
      startTime: "09:00",
      minutes: 30,
      locked: false,
      deadlineAt: localInstant(date, 560),
      targetDate: null,
    };
    expect(() =>
      buildTimingChanges(
        { action: "schedule", edits: [edit] },
        [task("a")],
        [],
        now,
      ),
    ).toThrow("正式截止");
    const r = buildTimingChanges(
      {
        action: "schedule",
        edits: [{ ...edit, deadlineAt: null, targetDate: "2026-09-20" }],
      },
      [task("a")],
      [],
      now,
    );
    expect(r.warnings[0]).toContain("希望完成日期");
  });
  it("rejects invalid dates and reversed ranges", () => {
    expect(
      timingRequestSchema.safeParse({ ...arrange(["a"]), date: "2026-02-30" })
        .success,
    ).toBe(false);
    expect(() =>
      buildTimingChanges(
        { ...arrange(["a"]), dateTo: "2026-09-19" },
        [task("a")],
        [],
        now,
      ),
    ).toThrow("结束日期");
  });
  it("requires explicit unlock before changing a protected slot", () => {
    const edit = {
      taskId: "a",
      date,
      startTime: "09:00",
      minutes: 30,
      locked: true,
      deadlineAt: null,
      targetDate: null,
    };
    expect(() =>
      buildTimingChanges(
        { action: "schedule", edits: [edit] },
        [task("a", { ...slot(480, 510), movable: false })],
        [],
        now,
      ),
    ).toThrow("已保护");
    expect(
      buildTimingChanges(
        { action: "schedule", edits: [{ ...edit, locked: false }] },
        [task("a", { ...slot(480, 510), movable: false })],
        [],
        now,
      ).changes[0].after.movable,
    ).toBe(true);
  });
  it("does not schedule into the elapsed part of a day", () => {
    const r = buildTimingChanges(
      arrange(["a"]),
      [task("a")],
      [],
      new Date("2026-09-21T10:12:00+08:00"),
    );
    expect(r.changes[0].after.scheduledStart).toBe(localInstant(date, 615));
  });
});
