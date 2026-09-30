import { buildActualTimeline } from "@/lib/actual-records/display";
import type { ActualRecord } from "@/lib/actual-records/schema";
import type { TimelineItemView } from "./view-data";
import { clockMinute, localClock, segmentFor, type TimingBlock, type TimingTask } from "./task-timing";
import { shanghaiDateKey } from "./task-actions";

export type TodayTimingData = { tasks: TimingTask[]; fixed: TimingBlock[]; date: string };

// Use the same real slots for the summary and the full timeline; coarse task
// segments must never become invented clock times.
export function buildTodayPlannedItems(data: TodayTimingData | null, fixedItems: TimelineItemView[]): TimelineItemView[] {
  if (!data) return fixedItems;
  return [
    ...data.fixed.map((block) => ({
      ...block,
      kind: fixedItems.find((item) => item.id === block.id)?.kind ?? "unavailable" as const,
      minutes: (Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 60000,
      segment: segmentFor(clockMinute(localClock(block.startsAt))),
      protected: true,
    })),
    ...data.tasks.filter((task) => task.date === data.date && task.scheduledStart && task.scheduledEnd && task.status !== "backlog")
      .map((task) => ({
        id: task.id,
        title: task.title,
        kind: "task" as const,
        startsAt: task.scheduledStart!,
        endsAt: task.scheduledEnd!,
        minutes: (Date.parse(task.scheduledEnd!) - Date.parse(task.scheduledStart!)) / 60000,
        segment: task.daySegment,
        protected: !task.movable,
      })),
  ];
}

export function getTodayPlanSummary(
  items: TimelineItemView[],
  date: string,
  now: Date | null,
  completedTaskIds: string[],
  actualRecords: ActualRecord[] = [],
) {
  if (!now) return { state: "loading" as const, current: [], next: null };
  if (shanghaiDateKey(now) !== date) return { state: "stale" as const, current: [], next: null };
  const completed = new Set(completedTaskIds);
  const planned = buildActualTimeline(items, actualRecords, date)
    .filter((item) => !item.actual && !(item.kind === "task" && completed.has(item.id)));
  const current = planned.filter((item) => Date.parse(item.startsAt) <= now.getTime() && Date.parse(item.endsAt) > now.getTime());
  const next = planned.find((item) => Date.parse(item.startsAt) > now.getTime()) ?? null;
  const state = current.length || next ? "scheduled" as const : items.length ? "finished" as const : "empty" as const;
  return { state, current, next };
}
