import type { TodayTaskView } from "./view-data";

export type DisplayTask = TodayTaskView & {
  displayStatus: TodayTaskView["status"] | "blocked";
};
export type StatusOverride = {
  status: TodayTaskView["status"];
  blocked: boolean;
  // Undefined while the PATCH is in flight; then the persisted row version.
  updatedAt?: string;
};
export function displayTask(task: TodayTaskView): DisplayTask {
  return {
    ...task,
    done: task.status === "done",
    displayStatus:
      task.blocked && task.status === "todo" ? "blocked" : task.status,
  };
}
export function sortTodayTasks(tasks: DisplayTask[]): DisplayTask[] {
  return [...tasks].sort(
    (a, b) =>
      Number(a.status === "done" || a.status === "backlog") -
      Number(b.status === "done" || b.status === "backlog"),
  );
}
// Retain only the locally edited fields until an equally recent server row arrives.
// Timing/detail edits in that same server refresh must still be accepted.
export function reconcileTodayTasks(
  server: TodayTaskView[],
  overrides: ReadonlyMap<string, StatusOverride>,
): DisplayTask[] {
  return sortTodayTasks(
    server.map((task) => {
      const local = overrides.get(task.id);
      const caughtUp =
        local?.updatedAt &&
        task.updatedAt &&
        Date.parse(task.updatedAt) >= Date.parse(local.updatedAt);
      return displayTask(
        local && !caughtUp
          ? { ...task, status: local.status, blocked: local.blocked }
          : task,
      );
    }),
  );
}
