import type { ActualRecord } from "./schema";
import type { TimelineItemView } from "@/lib/planning/view-data";
import { layoutTimetableIntervals } from "@/lib/planning/timetable-layout";
export function recordDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function recordClock(value: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}
export function localRecordValue(value: string) { return `${recordDate(new Date(value))}T${recordClock(value)}`; }
export function recordDuration(record: Pick<ActualRecord, "startsAt" | "endsAt">) { return Math.max(1, Math.round((Date.parse(record.endsAt) - Date.parse(record.startsAt)) / 60000)); }
export function recordTimeLabel(record: Pick<ActualRecord, "startsAt" | "endsAt">) {
  const from = recordDate(new Date(record.startsAt)), to = recordDate(new Date(record.endsAt));
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  return `${recordClock(record.startsAt)}–${days === 1 ? "次日 " : days > 1 ? `${to.slice(5)} ` : ""}${recordClock(record.endsAt)}`;
}
export type ActualTimelineItem = TimelineItemView & { actual?: ActualRecord; startMinute: number; endMinute: number; conflict: boolean };
export function buildActualTimeline(planned: TimelineItemView[], records: ActualRecord[], day: string): ActualTimelineItem[] {
  const start = Date.parse(`${day}T00:00:00+08:00`), end = start + 86400000;
  const visibleRecords = records.filter((r) => !r.deletedAt && Date.parse(r.startsAt) < end && Date.parse(r.endsAt) > start);
  const visiblePlans = planned.filter((p) => {
    if (p.kind !== "task") return true;
    const linked = visibleRecords.filter((r) => r.taskId === p.id);
    if (linked.some((r) => r.task?.status === "done")) return false;
    // A later explicit slot remains visible; an old/overlapping plan stays in details only.
    return !linked.length || Date.parse(p.startsAt) >= Math.max(...linked.map((r) => Date.parse(r.endsAt)));
  });
  const clamp = (value: string) => Math.max(0, Math.min(1440, Math.floor((Date.parse(value) - start) / 60000)));
  const plans = layoutTimetableIntervals(visiblePlans.map((p) => ({ ...p, startMinute: clamp(p.startsAt), endMinute: clamp(p.endsAt) })).filter((p) => p.endMinute > p.startMinute), { startMinute: 0, endMinute: 1440 });
  const actual: ActualTimelineItem[] = visibleRecords.map((r) => ({ id: `actual:${r.id}`, kind: r.taskId ? "task" : "routine", title: r.title, startsAt: r.startsAt, endsAt: r.endsAt, minutes: Math.max(1, Math.round((Math.min(end, Date.parse(r.endsAt)) - Math.max(start, Date.parse(r.startsAt))) / 60000)), segment: "morning", protected: false, actual: r, startMinute: clamp(r.startsAt), endMinute: clamp(r.endsAt), conflict: false }));
  return [...plans, ...actual].sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id));
}
