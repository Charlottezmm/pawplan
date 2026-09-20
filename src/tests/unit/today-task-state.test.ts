import { describe, expect, it } from "vitest";
import {
  displayTask,
  reconcileTodayTasks,
  sortTodayTasks,
  type StatusOverride,
} from "@/lib/planning/today-task-state";
import type { TodayTaskView } from "@/lib/planning/view-data";
const task = (
  id: string,
  status: TodayTaskView["status"] = "todo",
  extra = {},
): TodayTaskView => ({
  id,
  status,
  title: id,
  segment: "morning",
  context: "test",
  track: "test",
  minutes: 30,
  energy: "中",
  priority: "normal",
  notes: null,
  detail: { summary: null, sections: [] },
  blocked: false,
  done: status === "done",
  isChore: false,
  updatedAt: "2026-09-20T01:00:00Z",
  ...extra,
});
describe("Today server refresh reconciliation", () => {
  it("keeps pending tasks before completed/backlog tasks on initial load and refreshed server order", () => {
    const rows = [
      task("done", "done"),
      task("a"),
      task("backlog", "backlog"),
      task("b"),
    ];
    const expected = ["a", "b", "done", "backlog"];
    expect(sortTodayTasks(rows.map(displayTask)).map((t) => t.id)).toEqual(
      expected,
    );
    expect(reconcileTodayTasks(rows, new Map()).map((t) => t.id)).toEqual(
      expected,
    );
  });
  it("retains optimistic status while accepting new timing fields during in-flight PATCH", () => {
    const overrides = new Map<string, StatusOverride>([
      ["a", { status: "done", blocked: false }],
    ]);
    const [result] = reconcileTodayTasks(
      [task("a", "todo", { timeLabel: "18:00–18:30" })],
      overrides,
    );
    expect(result).toMatchObject({
      status: "done",
      displayStatus: "done",
      done: true,
      timeLabel: "18:00–18:30",
    });
  });
  it("ignores older server status after PATCH acknowledgement and accepts newer external edits", () => {
    const overrides = new Map<string, StatusOverride>([
      [
        "a",
        { status: "done", blocked: false, updatedAt: "2026-09-20T02:00:00Z" },
      ],
    ]);
    expect(reconcileTodayTasks([task("a")], overrides)[0].status).toBe("done");
    expect(
      reconcileTodayTasks(
        [
          task("a", "todo", {
            updatedAt: "2026-09-20T03:00:00Z",
            blocked: true,
          }),
        ],
        overrides,
      )[0].displayStatus,
    ).toBe("blocked");
  });
  it("can roll back only status without losing refreshed task details", () => {
    const refreshed = task("a", "done", { timeLabel: "18:00–18:30" });
    expect(
      displayTask({ ...refreshed, status: "todo", blocked: false }),
    ).toMatchObject({
      displayStatus: "todo",
      done: false,
      timeLabel: "18:00–18:30",
    });
  });
});
