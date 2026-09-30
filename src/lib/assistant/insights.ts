import { and, eq, isNull } from "drizzle-orm";
import { tasks } from "@/lib/db/schema";
import { getActivePlanId } from "@/lib/planning/active-plan";
import { readTaskTiming } from "@/lib/planning/task-timing-service";
import { shanghaiDateKey } from "@/lib/planning/task-actions";
import { getActualRecords } from "@/lib/actual-records/service";
import { getContinuation } from "./service";
import { assistantToolSchemas, AssistantError } from "./schema";

type Db = Parameters<typeof getContinuation>[0];
type Interval = { start: number; end: number };
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const interval of [...intervals].filter((v) => v.end > v.start).sort((a, b) => a.start - b.start)) {
    const last = result[result.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}
export function firstGap(start: number, end: number, minutes: number, busy: Interval[]) {
  let cursor = start;
  for (const interval of mergeIntervals(busy)) {
    if (interval.end <= cursor || interval.start >= end) continue;
    if (interval.start - cursor >= minutes * 60000) return cursor;
    cursor = Math.max(cursor, interval.end);
  }
  return end - cursor >= minutes * 60000 ? cursor : null;
}
const energyRank = { low: 1, medium: 2, high: 3 };
const priorityRank = { low: 1, normal: 2, high: 3, urgent: 4 };
export function rankRecommendations(input: {
  start: number; end: number; energy: keyof typeof energyRank; limit: number;
  candidates: Array<any>; fixed: Array<{ startsAt: string; endsAt: string }>; latest: Map<string, any>;
}) {
  const recommendations = [];
  for (const task of input.candidates) {
    const continuation = input.latest.get(task.id);
    if (!["todo", "backlog"].includes(task.status) || task.archivedAt || task.blocked || continuation?.blockers?.length) continue;
    const energy = continuation?.energy_required ?? task.energyLevel;
    if (energyRank[energy as keyof typeof energyRank] > energyRank[input.energy]) continue;
    const minutes = continuation?.remaining_minutes ?? task.estimatedMinutes;
    const busy = input.fixed.map((b) => ({ start: Date.parse(b.startsAt), end: Date.parse(b.endsAt) }));
    for (const other of input.candidates) if (other.id !== task.id && other.status === "todo" && other.scheduledStart && other.scheduledEnd) busy.push({ start: +new Date(other.scheduledStart), end: +new Date(other.scheduledEnd) });
    // Locked tasks can only be recommended within their existing confirmed slot.
    const windowStart = !task.movable ? Math.max(input.start, +new Date(task.scheduledStart ?? 0)) : input.start;
    const windowEnd = !task.movable ? Math.min(input.end, +new Date(task.scheduledEnd ?? 0)) : input.end;
    const deadline = task.deadlineAt ? +new Date(task.deadlineAt) : Infinity;
    const at = firstGap(windowStart, Math.min(windowEnd, deadline), minutes, busy);
    if (at === null) continue;
    const deadlineSoon = deadline <= input.end + 86400000;
    recommendations.push({ taskId: task.id, title: task.title, minutes, energyRequired: energy,
      suggestedStart: new Date(at).toISOString(), suggestedEnd: new Date(at + minutes * 60000).toISOString(),
      nextStep: continuation?.next_step ?? task.checkpoint ?? null,
      reasons: ["Fits a contiguous free interval and supplied energy", ...(deadlineSoon ? ["Formal deadline within a day of this window"] : []), ...(continuation?.remaining_minutes ? ["Uses user-reported remaining duration"] : ["Uses current task estimate; actual duration is unknown"])],
      score: priorityRank[task.priority as keyof typeof priorityRank] * 100 + (deadlineSoon ? 500 : 0) + (continuation?.next_step ? 20 : 0),
    });
  }
  return recommendations.sort((a, b) => b.score - a.score || a.suggestedStart.localeCompare(b.suggestedStart) || a.taskId.localeCompare(b.taskId)).slice(0, input.limit).map(({ score, ...result }) => result);
}
export async function recommendNextTasks(db: Db, workspaceId: string, args: unknown) {
  const input = assistantToolSchemas.recommend_next_tasks.parse(args);
  const start = Date.parse(input.start_at); const end = start + input.available_minutes * 60000;
  const planId = await getActivePlanId(db, workspaceId);
  if (!planId) throw new AssistantError("no_active_plan", "An active plan is required", 404);
  const [candidates, timing, continuation] = await Promise.all([
    db.select().from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId), isNull(tasks.archivedAt))),
    readTaskTiming(db, workspaceId, shanghaiDateKey(new Date(start)), shanghaiDateKey(new Date(end))),
    getContinuation(db, workspaceId, { limit: 100 }),
  ]);
  const latest = new Map<string, any>();
  for (const record of continuation.records) if (record.taskId && record.kind === "progress" && !latest.has(record.taskId)) latest.set(record.taskId, record.content);
  return { recommendations: rankRecommendations({ start, end, energy: input.energy_level, limit: input.limit, candidates, fixed: timing.fixed, latest }),
    mutationApplied: false, continuationTruncated: continuation.truncated,
    caveats: ["Suggestions do not reserve or move work. Use propose_task_timing to validate current capacity, fixed slots, protection, and deadlines before booking.", "Energy and duration are user reports or estimates. Missing continuation data is unknown."] };
}
export function durationComparison(taskRows: any[], records: any[], start: number, end: number, truncated = false) {
  const byTask = new Map<string, any[]>();
  for (const record of records) if (record.taskId) byTask.set(record.taskId, [...(byTask.get(record.taskId) ?? []), record]);
  const all = new Map(taskRows.map((row) => [row.id, row]));
  for (const record of records) if (record.taskId && !all.has(record.taskId)) all.set(record.taskId, { id: record.taskId, title: record.task?.title ?? record.title, estimatedMinutes: record.task?.estimatedMinutes ?? null });
  const comparisons = [...all.values()].map((task) => {
    const linked = byTask.get(task.id) ?? [];
    const intervals = linked.map((r) => ({ start: Math.max(start, Date.parse(r.startsAt)), end: Math.min(end, Date.parse(r.endsAt)) }));
    const recordedMinutes = linked.length ? mergeIntervals(intervals).reduce((sum, r) => sum + (r.end - r.start) / 60000, 0) : null;
    const estimates = [...new Set(linked.map((r) => r.planSnapshot?.estimatedMinutes).filter((n) => typeof n === "number"))];
    const capturedEstimateMinutes = estimates.length === 1 ? estimates[0] as number : null;
    const missingSnapshots = linked.some((r) => typeof r.planSnapshot?.estimatedMinutes !== "number");
    const boundaryClipped = linked.some((r) => Date.parse(r.startsAt) < start || Date.parse(r.endsAt) > end);
    const overlappingRecords = intervals.reduce((sum, r) => sum + (r.end - r.start) / 60000, 0) > (recordedMinutes ?? 0);
    return { taskId: task.id, title: task.title, currentEstimateMinutes: task.estimatedMinutes ?? null, capturedEstimateMinutes,
      recordedMinutes, observedDeltaMinutes: recordedMinutes !== null && capturedEstimateMinutes !== null && !missingSnapshots && !boundaryClipped && !truncated ? recordedMinutes - capturedEstimateMinutes : null,
      recordCount: linked.length, approximate: linked.some((r) => r.approximate), overlappingRecords, boundaryClipped,
      caveats: [...(!linked.length ? ["No actual duration recorded; this is unknown, not zero."] : ["Recorded time may omit sessions; delta compares observed time only, not final duration."]), ...(estimates.length > 1 ? ["Plan estimates changed across captured records; no single baseline delta."] : []), ...(missingSnapshots ? ["Some records lack a captured plan estimate."] : []), ...(boundaryClipped ? ["Actual time is clipped to the requested period; no full-task delta."] : []), ...(overlappingRecords ? ["Overlapping sessions merged to avoid counting the same minutes twice."] : [])],
    };
  });
  return { comparisons, truncated, unlinkedRecordCount: records.filter((r) => !r.taskId).length,
    tasksWithoutActuals: comparisons.filter((r) => r.recordedMinutes === null).length,
    caveats: ["Completion clicks and schedules do not establish actual duration. Unrecorded work is unknown.", "Captured snapshots reflect the plan when activity was recorded, not the original historical plan. Current estimates are shown separately.", "No aggregate performance ratio is computed from incomplete logs. Cross-task overlapping sessions may represent shared time.", ...(truncated ? ["Actual records are truncated; comparisons are partial and deltas withheld."] : [])] };
}
export async function comparePlanActual(db: Db, workspaceId: string, args: unknown) {
  const input = assistantToolSchemas.compare_plan_actual.parse(args);
  if (input.date_from > input.date_to || Date.parse(input.date_to) - Date.parse(input.date_from) > 30 * 86400000) throw new AssistantError("invalid_range", "Use an inclusive range of at most 31 days", 400);
  const start = Date.parse(`${input.date_from}T00:00:00+08:00`); const end = Date.parse(`${input.date_to}T00:00:00+08:00`) + 86400000;
  const [actual, rows] = await Promise.all([getActualRecords(db, workspaceId, input), db.select().from(tasks).where(and(eq(tasks.workspaceId, workspaceId), isNull(tasks.archivedAt)))]);
  return durationComparison(rows.filter((t: any) => +new Date(t.date) >= start && +new Date(t.date) < end), actual.records, start, end, actual.truncated);
}
