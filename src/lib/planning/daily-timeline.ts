import { createHash } from "node:crypto";
import { dailyTimelineArgsSchema, validateLearningHandoffArgsSchema, type DailyTimelineArgs } from "./timeline-schema";

export type TimelineTask = {
  id: string; title: string; notes: string | null; date: string; status: string;
  estimatedMinutes: number; updatedAt: string; priority: string;
  projectId?: string | null; blocked?: boolean; archivedAt?: string | null;
};
export type TimelineBlock = { id: string; title: string; kind: string; startsAt: string; endsAt: string };
export type TimelineSource = { tasks: TimelineTask[]; blocks: TimelineBlock[]; warnings?: string[] };
export class TimelineError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
type Interval = { start: number; end: number };
type Slot = Interval & { kind: string; title: string; task_id?: string; scope?: string; stop_condition?: string };
const ms = (value: string) => new Date(value).getTime();
const dateKey = (value: string) => new Date(ms(value) + 8 * 3600000).toISOString().slice(0, 10);
const priority: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const fail = (code: string, message: string): never => { throw new TimelineError(code, message); };

export function timelineSnapshot(source: TimelineSource) {
  // Stable across database ordering; includes constraint and task content, not just ids.
  return createHash("sha256").update(JSON.stringify({
    tasks: [...source.tasks].sort((a, b) => a.id.localeCompare(b.id)),
    blocks: [...source.blocks].sort((a, b) => a.id.localeCompare(b.id)),
    warnings: [...(source.warnings ?? [])].sort(),
  })).digest("hex");
}
function subtract(free: Interval[], occupied: Interval): Interval[] {
  return free.flatMap((slot) => {
    if (occupied.end <= slot.start || occupied.start >= slot.end) return [slot];
    return [
      { start: slot.start, end: Math.min(slot.end, occupied.start) },
      { start: Math.max(slot.start, occupied.end), end: slot.end },
    ].filter((part) => part.end > part.start);
  });
}
function overlaps(a: Interval, b: Interval) { return a.start < b.end && b.start < a.end; }

export function buildDailyTimeline(source: TimelineSource, rawArgs: unknown) {
  const args = dailyTimelineArgsSchema.parse(rawArgs);
  const base = ms(`${args.date}T00:00:00+08:00`);
  if (!Number.isFinite(base) || dateKey(new Date(base).toISOString()) !== args.date) fail("invalid_date", "Invalid calendar date");
  const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const instant = (value: string) => (ms(value) - base) / 60000;
  const stamp = (value: number) => new Date(base + value * 60000).toISOString();
  const window = (value: { start: string; end: string }) => {
    const result = { start: minute(value.start), end: minute(value.end) };
    if (result.end <= result.start) fail("invalid_window", "Windows must end after they start on the same day");
    return result;
  };
  const day = window(args);
  const now = instant(args.now);
  if (dateKey(args.now) !== args.date) fail("invalid_now", "now must be on the requested Shanghai date");
  const snapshot = timelineSnapshot(source);
  if (args.expected_snapshot && args.expected_snapshot !== snapshot) fail("snapshot_stale", "Live tasks or constraints changed; reload and reconcile before replaying feedback");
  const warnings = [...(source.warnings ?? [])];
  const taskMap = new Map(source.tasks.filter(t => !t.archivedAt).map(t => [t.id, t]));
  if (taskMap.size !== source.tasks.filter(t => !t.archivedAt).length) fail("duplicate_task", "Duplicate live task ids");
  const requireTask = (id: string) => taskMap.get(id) ?? fail("task_not_found", `Task is outside the active workspace/plan: ${id}`);
  const options = new Map<string, DailyTimelineArgs["task_options"][number]>();
  for (const option of args.task_options) {
    requireTask(option.task_id);
    if (options.has(option.task_id)) fail("duplicate_option", `Duplicate task option: ${option.task_id}`);
    if (option.must_finish_by && !option.deadline_reason) fail("deadline_source_required", "A deadline needs its confirmed reason/source");
    for (const id of option.depends_on) requireTask(id);
    options.set(option.task_id, option);
  }
  const fixed: Slot[] = source.blocks.filter(b => b.kind !== "routine").map(b => ({
    start: instant(b.startsAt), end: instant(b.endsAt), kind: "fixed", title: b.title,
  })).filter(b => b.end > day.start && b.start < day.end);
  const protections: Slot[] = args.protected_windows.map(w => ({ ...window(w), title: w.title, kind: w.kind }));
  if (!protections.some(w => w.kind === "meal") && day.end - day.start > 300) warnings.push("meal_windows_missing: protect actual meal times before using this long day");
  if (!protections.some(w => w.kind === "buffer")) warnings.push("buffer_window_missing: reserve recovery capacity explicitly");
  if (fixed.length && !protections.some(w => w.kind === "commute")) warnings.push("commute_window_missing: verify travel time around fixed events");
  const reservations = [...fixed, ...protections];
  for (let i = 0; i < reservations.length; i++) {
    for (let j = i + 1; j < reservations.length; j++) {
      if (overlaps(reservations[i], reservations[j])) warnings.push(`fixed_conflict: ${reservations[i].title} / ${reservations[j].title}`);
    }
  }
  const backlog = args.backlog_windows.map(w => ({ ...window(w), task_ids: w.task_ids }));
  const backlogIds = new Set<string>();
  for (const w of backlog) {
    if (w.start < day.start || w.end > day.end) fail("backlog_outside_day", "Backlog slots must fit within the workday");
    for (const id of w.task_ids) {
      if (requireTask(id).status !== "backlog") fail("backlog_state_changed", `Task is no longer backlog: ${id}`);
      if (backlogIds.has(id)) fail("duplicate_backlog_selection", `Select each backlog task once: ${id}`);
      backlogIds.add(id);
    }
    if (reservations.some(r => overlaps(r, w))) warnings.push("backlog_fixed_conflict: only remaining free capacity will be used");
  }
  for (let i = 0; i < backlog.length; i++) for (let j = i + 1; j < backlog.length; j++) {
    if (overlaps(backlog[i], backlog[j])) fail("backlog_overlap", "Backlog windows must not overlap");
  }

  const eventIds = new Map<string, string>();
  const feedback = args.feedback.filter(f => {
    const encoded = JSON.stringify(f);
    if (eventIds.has(f.id)) {
      if (eventIds.get(f.id) !== encoded) fail("feedback_id_conflict", "A feedback id was reused with different content");
      return false;
    }
    eventIds.set(f.id, encoded); return true;
  }).sort((a, b) => ms(a.started_at) - ms(b.started_at));
  const latest = new Map<string, typeof feedback[number]>();
  const actual: Slot[] = [];
  let lastEnd = -Infinity;
  for (const f of feedback) {
    const task = requireTask(f.task_id);
    if (task.updatedAt !== f.expected_updated_at) fail("feedback_stale", `Reconcile feedback with the current task: ${task.title}`);
    if (!["todo", "backlog"].includes(task.status)) fail("feedback_state_changed", "Feedback cannot reopen a closed task");
    if (f.state === "started" ? Boolean(f.ended_at) : !f.ended_at) fail("invalid_feedback_time", "Started sessions are open; other feedback requires an actual end time");
    const start = instant(f.started_at), end = f.ended_at ? instant(f.ended_at) : now;
    if (start < 0 || end < start || end > now || start < lastEnd) fail("invalid_feedback_time", "Sessions must be ordered, non-overlapping, on this day, and not in the future");
    if (f.state === "completed" && (f.remaining_minutes !== 0 || !f.evidence_ref)) fail("completion_evidence_required", "Completion needs zero remaining scope and a verifiable evidence reference");
    if (f.state !== "completed" && f.remaining_minutes === 0) fail("remaining_scope_required", "Unfinished feedback must preserve a positive remaining estimate");
    if (latest.get(f.task_id)?.state === "completed") fail("completed_session_reopened", "Reconcile the task before reopening completed scope");
    lastEnd = end;
    latest.set(f.task_id, f);
    if (end > start) actual.push({ start, end, kind: "actual", title: task.title, task_id: task.id, scope: f.checkpoint, stop_condition: f.next_step });
  }
  if (feedback.filter(f => f.state === "started").length > 1 || feedback.some((f, i) => f.state === "started" && i !== feedback.length - 1)) fail("multiple_active_sessions", "Close the active session before starting another");

  const candidates = [...taskMap.values()].filter(t => ["todo", "backlog"].includes(t.status) &&
    (t.status === "backlog" ? backlogIds.has(t.id) || latest.has(t.id) : dateKey(t.date) === args.date || options.has(t.id) || latest.has(t.id)));
  const remaining = new Map(candidates.map(t => [t.id, latest.get(t.id)?.remaining_minutes ?? t.estimatedMinutes]));
  const budget = new Map(candidates.map(t => [t.id, Math.min(remaining.get(t.id)!, options.get(t.id)?.budget_minutes ?? remaining.get(t.id)!)]));
  const used = new Map<string, number>();
  const finish = new Map<string, number>();
  const slots: Slot[] = [];
  let free: Interval[] = now >= day.end ? [] : [{ start: Math.max(day.start, Math.ceil(now)), end: day.end }];
  for (const r of reservations) free = subtract(free, r);
  // Routine time blocks are availability windows in the existing capacity model.
  const availability = source.blocks.filter(b => b.kind === "routine").map(b => ({ start: instant(b.startsAt), end: instant(b.endsAt) }));
  if (availability.length) free = free.flatMap(f => availability.map(a => ({ start: Math.max(f.start, a.start), end: Math.min(f.end, a.end) })).filter(a => a.end > a.start))
    .sort((a, b) => a.start - b.start).reduce<Interval[]>((result, f) => {
      const last = result[result.length - 1];
      if (last && f.start <= last.end) last.end = Math.max(last.end, f.end); else result.push(f);
      return result;
    }, []);
  const allocate = (task: TimelineTask, windows: Interval[]) => {
    const f = latest.get(task.id), option = options.get(task.id);
    if (task.blocked || (f && ["stuck", "paused", "completed"].includes(f.state))) return;
    let after = Math.max(day.start, Math.ceil(now));
    for (const id of option?.depends_on ?? []) {
      if (requireTask(id).status === "done" || latest.get(id)?.state === "completed") continue;
      if (!finish.has(id) || (used.get(id) ?? 0) < (remaining.get(id) ?? Infinity)) {
        warnings.push(`dependency_unresolved: ${task.title} requires ${requireTask(id).title}`); return;
      }
      after = Math.max(after, finish.get(id)!);
    }
    const deadline = option?.must_finish_by ? instant(option.must_finish_by) : Infinity;
    let left = (budget.get(task.id) ?? 0) - (used.get(task.id) ?? 0);
    for (const available of [...free]) for (const w of windows) {
      let cursor = Math.max(available.start, w.start, after);
      const limit = Math.min(available.end, w.end, deadline);
      while (left > 0 && cursor < limit) {
        const length = Math.min(left, args.max_focus_minutes, limit - cursor);
        if (length < Math.min(15, left)) break;
        const part: Slot = { start: cursor, end: cursor + length, task_id: task.id, title: task.title,
          kind: task.status === "backlog" ? "backlog" : "task",
          scope: option?.scope ?? task.notes ?? "Read the existing task scope before starting",
          stop_condition: option?.stop_condition ?? "Stop at the boundary; record the exact checkpoint and remaining scope. Time elapsed is not completion." };
        slots.push(part); free = subtract(free, part);
        used.set(task.id, (used.get(task.id) ?? 0) + length);
        finish.set(task.id, Math.max(finish.get(task.id) ?? 0, part.end));
        left -= length;
        const rest = { start: part.end, end: Math.min(part.end + args.break_minutes, available.end, w.end) };
        if (rest.end > rest.start) { slots.push({ ...rest, kind: "rest", title: "休息 / 切换缓冲" }); free = subtract(free, rest); }
        cursor = rest.end;
      }
    }
  };
  const critical = (t: TimelineTask) => Boolean(options.get(t.id)?.must_finish_by);
  const ordered = [...candidates].sort((a, b) => Number(critical(b)) - Number(critical(a)) ||
    ms(options.get(a.id)?.must_finish_by ?? "9999-01-01") - ms(options.get(b.id)?.must_finish_by ?? "9999-01-01") ||
    (priority[a.priority] ?? 2) - (priority[b.priority] ?? 2) || a.id.localeCompare(b.id));
  // Topological order preserves explicitly supplied prerequisites without inferring them from prose.
  const sorted: TimelineTask[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const visit = (t: TimelineTask) => {
    if (visiting.has(t.id)) fail("dependency_cycle", "Task dependencies contain a cycle");
    if (visited.has(t.id)) return;
    visiting.add(t.id);
    for (const id of options.get(t.id)?.depends_on ?? []) { const dep = candidates.find(c => c.id === id); if (dep) visit(dep); }
    visiting.delete(t.id); visited.add(t.id); sorted.push(t);
  };
  ordered.forEach(visit);
  const criticalIds = new Set<string>();
  const markCritical = (id: string) => { if (criticalIds.has(id)) return; criticalIds.add(id); (options.get(id)?.depends_on ?? []).forEach(markCritical); };
  candidates.filter(critical).forEach(t => markCritical(t.id));
  const active = candidates.find(t => latest.get(t.id)?.state === "started");
  if (active) {
    if (reservations.some(r => r.start <= now && r.end > now)) warnings.push("active_fixed_conflict: the reported current session overlaps a protected block; confirm whether to pause");
    allocate(active, [day]);
  }
  let outsideBacklog = [day];
  for (const w of backlog) outsideBacklog = subtract(outsideBacklog, w);
  for (const t of sorted.filter(t => criticalIds.has(t.id))) allocate(t, outsideBacklog);
  // Reclaim a backlog reservation only when deadline work cannot fit elsewhere.
  for (const t of sorted.filter(t => criticalIds.has(t.id))) {
    if ((used.get(t.id) ?? 0) < (budget.get(t.id) ?? 0)) allocate(t, [day]);
  }
  for (const w of backlog) for (const id of w.task_ids) { const t = candidates.find(t => t.id === id); if (t && !criticalIds.has(id)) allocate(t, [w]); }
  // Remaining backlog reservation is protected from ordinary tasks, making its capacity real.
  for (const w of backlog) free = subtract(free, w);
  for (const t of sorted.filter(t => t.status !== "backlog" && !criticalIds.has(t.id))) allocate(t, [day]);

  const outcomes = candidates.map(t => ({
    task_id: t.id, title: t.title, expected_updated_at: t.updatedAt,
    original_scope: t.notes, scope: options.get(t.id)?.scope ?? t.notes,
    remaining_minutes: remaining.get(t.id)!, allocated_minutes: used.get(t.id) ?? 0,
    unallocated_minutes: remaining.get(t.id)! - (used.get(t.id) ?? 0),
    actual_minutes: actual.filter(a => a.task_id === t.id).reduce((sum, a) => sum + a.end - a.start, 0),
    feedback_state: latest.get(t.id)?.state ?? null,
    checkpoint: latest.get(t.id)?.checkpoint ?? null,
    next_step: latest.get(t.id)?.next_step ?? "Read current materials and outline before starting",
    must_finish_by: options.get(t.id)?.must_finish_by ?? null,
    deadline_reason: options.get(t.id)?.deadline_reason ?? null,
    disposition: latest.get(t.id)?.state === "completed" ? "reported_complete_pending_record" :
      (used.get(t.id) ?? 0) < remaining.get(t.id)! ? "needs_capacity_or_scope_decision" : "planned_not_completed",
  }));
  for (const o of outcomes) if (o.unallocated_minutes > 0 && o.must_finish_by) warnings.push(`deadline_capacity_shortfall: ${o.title} (${o.unallocated_minutes}m)`);
  const backlogCapacity = backlog.map(w => ({
    start: stamp(w.start), end: stamp(w.end), requested_minutes: w.end - w.start,
    budget_minutes: w.task_ids.reduce((n, id) => n + (budget.get(id) ?? 0), 0),
    allocated_minutes: slots.filter(s => s.kind === "backlog" && w.task_ids.includes(s.task_id!) && overlaps(s, w)).reduce((n, s) => n + Math.min(s.end, w.end) - Math.max(s.start, w.start), 0),
    task_ids: w.task_ids,
  }));
  for (const w of backlogCapacity) if (w.allocated_minutes < w.budget_minutes) warnings.push("backlog_capacity_shortfall: retain unallocated scope; choose a concrete future slot after reading that day's capacity");
  const groups = new Map<string, TimelineTask[]>();
  for (const t of taskMap.values()) if (t.status === "backlog") {
    const key = `${t.projectId ?? ""}:${t.title.normalize("NFKC").replace(/\s+/g, "").toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const format = (s: Slot) => ({ ...s, start: stamp(s.start), end: stamp(s.end), minutes: s.end - s.start });
  return {
    status: warnings.length || outcomes.some(o => o.unallocated_minutes > 0) ? "needs_decision" : "preview_ready",
    date: args.date, timezone: "Asia/Shanghai", snapshot, persisted: false, notifications: "not_scheduled",
    timeline: [...reservations.map(r => ({ ...r, start: Math.max(r.start, day.start), end: Math.min(r.end, day.end) })).filter(r => r.end > r.start), ...slots]
      .sort((a, b) => a.start - b.start || a.end - b.end).map(format),
    actual: actual.map(format), outcomes, backlog_capacity: backlogCapacity,
    backlog_triage: [...groups.values()].map(group => ({
      task_ids: group.map(t => t.id), title: group[0].title,
      duplicate_candidate: group.length > 1,
      selected: group.some(t => backlogIds.has(t.id)),
      stale_candidate: group.some(t => ms(args.now) - ms(t.updatedAt) > 14 * 86400000),
      action: "Verify current scope and evidence; never auto-archive or assume identical titles mean duplicate work",
    })),
    warnings: [...new Set(warnings)], feedback,
    continuation: "Carry this request plus feedback to the next assistant; reread live snapshot and canonical learning source. Persist authorized changes through existing Review/Apply/readback. No automatic rollover or mastery update.",
  };
}

export function validateLearningHandoff(source: TimelineSource, rawArgs: unknown) {
  const { handoff, observed_source_revision } = validateLearningHandoffArgsSchema.parse(rawArgs);
  const task = source.tasks.find(t => t.id === handoff.task_id && !t.archivedAt);
  if (!task) fail("task_not_found", "Handoff task is not in the active workspace/plan");
  if (task!.updatedAt !== handoff.expected_updated_at) fail("handoff_stale", "PawPlan task changed; reconcile the canonical source before resuming");
  if (observed_source_revision && observed_source_revision !== handoff.source_revision) fail("source_revision_stale", "The original learning record changed; regenerate the handoff");
  return {
    status: observed_source_revision ? "references_checked_by_caller" : "source_read_required",
    persisted: false, mastery: "not_inferred", handoff,
    task: { id: task!.id, status: task!.status, updated_at: task!.updatedAt },
    source_verification: "PawPlan checks task freshness only. The receiving assistant must read the source, confirm branch/position and revision, and retain first-answer/prompt evidence. A revision supplied by the caller is not a server file read.",
  };
}
