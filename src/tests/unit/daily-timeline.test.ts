import { describe, expect, it } from "vitest";
import { buildDailyTimeline, validateLearningHandoff, type TimelineSource, type TimelineTask } from "@/lib/planning/daily-timeline";
import { dailyTimelineArgsSchema, type DailyTimelineArgs, type TimelineFeedback } from "@/lib/planning/timeline-schema";

const at = (time: string) => `2026-09-20T${time}:00+08:00`;
const task = (id: string, overrides: Partial<TimelineTask> = {}): TimelineTask => ({
  id, title: id, notes: `Entire original scope of ${id}`, date: at("00:00"), status: "todo", estimatedMinutes: 60,
  updatedAt: "2026-09-19T00:00:00.000Z", priority: "normal", ...overrides,
});
const source = (tasks = [task("a")], blocks: TimelineSource["blocks"] = []): TimelineSource => ({ tasks, blocks });
const args = (overrides: Partial<DailyTimelineArgs> = {}): DailyTimelineArgs => dailyTimelineArgsSchema.parse({
  date: "2026-09-20", start: "08:00", end: "12:00", now: at("08:00"), protected_windows: [], ...overrides,
});
const session = (overrides: Partial<TimelineFeedback> = {}): TimelineFeedback => ({
  id: "session-1", task_id: "a", expected_updated_at: task("a").updatedAt, state: "partial",
  started_at: at("08:00"), ended_at: at("09:00"), remaining_minutes: 40,
  checkpoint: "page 4, exercise 2; prompted correction only", next_step: "finish own derivation", ...overrides,
});
const minute = (value: string) => new Date(value).getTime() / 60000;
const work = (r: ReturnType<typeof buildDailyTimeline>) => r.timeline.filter(s => s.task_id);

describe("daily timeline", () => {
  it("protects fixed classes, meals, travel and buffer while retaining full scope", () => {
    const r = buildDailyTimeline(source([task("a", { estimatedMinutes: 180 })], [
      { id: "class", title: "class", kind: "course", startsAt: at("09:00"), endsAt: at("10:00") },
    ]), args({ protected_windows: [
      { title: "travel", kind: "commute", start: "08:45", end: "09:00" },
      { title: "meal", kind: "meal", start: "10:00", end: "10:30" },
      { title: "buffer", kind: "buffer", start: "11:45", end: "12:00" },
    ] }));
    for (const s of work(r)) for (const protectedSlot of r.timeline.filter(s => ["fixed", "meal", "commute", "buffer"].includes(s.kind))) {
      expect(minute(s.end) <= minute(protectedSlot.start) || minute(s.start) >= minute(protectedSlot.end)).toBe(true);
    }
    expect(r.outcomes[0].unallocated_minutes).toBeGreaterThan(0);
    expect(r.outcomes[0].original_scope).toBe("Entire original scope of a");
    expect(r.persisted).toBe(false);
    expect(r.notifications).toBe("not_scheduled");
  });
  it("reports fixed conflicts rather than hiding either event", () => {
    const r = buildDailyTimeline(source([], [
      { id: "x", title: "x", kind: "exam", startsAt: at("09:00"), endsAt: at("10:00") },
      { id: "y", title: "y", kind: "course", startsAt: at("09:30"), endsAt: at("10:30") },
    ]), args());
    expect(r.warnings).toContain("fixed_conflict: x / y");
    expect(r.timeline.filter(s => s.kind === "fixed")).toHaveLength(2);
  });
  it("late start never extends the finish time or rolls remaining scope into tomorrow", () => {
    const r = buildDailyTimeline(source([task("a", { estimatedMinutes: 180 })]), args({ now: at("11:00") }));
    expect(work(r).every(s => minute(s.start) >= minute(at("11:00")) && minute(s.end) <= minute(at("12:00")))).toBe(true);
    expect(r.outcomes[0].unallocated_minutes).toBeGreaterThan(0);
    expect(r.outcomes[0].disposition).toBe("needs_capacity_or_scope_decision");
  });
  it("after closing time returns remaining scope and no work", () => {
    const r = buildDailyTimeline(source(), args({ now: at("13:00") }));
    expect(work(r)).toHaveLength(0); expect(r.outcomes[0].unallocated_minutes).toBe(60);
  });
  it("partial/timeout feedback uses explicit remaining scope, not elapsed time", () => {
    for (const state of ["partial", "timeout"] as const) {
      const r = buildDailyTimeline(source(), args({ now: at("10:00"), feedback: [session({ state, ended_at: at("10:00") })] }));
      expect(r.outcomes[0].actual_minutes).toBe(120);
      expect(r.outcomes[0].remaining_minutes).toBe(40);
      expect(r.outcomes[0].feedback_state).toBe(state);
      expect(r.outcomes[0].checkpoint).toContain("prompted");
    }
  });
  it("stuck and paused preserve next step without automatically resuming", () => {
    for (const state of ["stuck", "paused"] as const) {
      const r = buildDailyTimeline(source(), args({ now: at("09:00"), feedback: [session({ state })] }));
      expect(work(r)).toHaveLength(0);
      expect(r.outcomes[0].next_step).toBe("finish own derivation");
      expect(r.outcomes[0].remaining_minutes).toBe(40);
    }
  });
  it("started sessions accumulate actual time and pause/resume keeps history", () => {
    const feedback = [session({ state: "paused" }), session({ id: "session-2", state: "started", started_at: at("09:30"), ended_at: undefined })];
    const r = buildDailyTimeline(source(), args({ now: at("09:45"), feedback }));
    expect(r.outcomes[0].actual_minutes).toBe(75);
    expect(r.outcomes[0].allocated_minutes).toBe(40);
  });
  it("continues the task the user actually started, even outside its old backlog slot", () => {
    const r = buildDailyTimeline(source([task("urgent", { priority: "urgent" }), task("a", { status: "backlog" })]), args({ now: at("09:00"),
      feedback: [session({ state: "started", ended_at: undefined })],
    }));
    expect(work(r)[0].task_id).toBe("a");
    expect(work(r)[0].start).toBe(new Date(at("09:00")).toISOString());
    expect(r.outcomes.find(o => o.task_id === "a")?.actual_minutes).toBe(60);
  });
  it("completion needs an evidence reference and does not assert persisted completion or mastery", () => {
    expect(() => buildDailyTimeline(source(), args({ now: at("09:00"), feedback: [session({ state: "completed", remaining_minutes: 0 })] }))).toThrow(/evidence/);
    const r = buildDailyTimeline(source(), args({ now: at("09:00"), feedback: [session({ state: "completed", remaining_minutes: 0, evidence_ref: "existing-outline#attempt" })] }));
    expect(work(r)).toHaveLength(0);
    expect(r.outcomes[0].disposition).toBe("reported_complete_pending_record");
    expect(r.persisted).toBe(false); expect(r).not.toHaveProperty("mastery");
  });
  it("retries are idempotent but conflicting ids, overlaps, future and stale feedback fail", () => {
    const a = args({ now: at("09:00"), feedback: [session(), session()] });
    expect(buildDailyTimeline(source(), a).outcomes[0].actual_minutes).toBe(60);
    expect(() => buildDailyTimeline(source(), { ...a, feedback: [session(), session({ remaining_minutes: 50 })] })).toThrow(/reused/);
    expect(() => buildDailyTimeline(source(), { ...a, feedback: [session(), session({ id: "other" })] })).toThrow(/non-overlapping/);
    expect(() => buildDailyTimeline(source(), { ...a, feedback: [session({ ended_at: at("10:00") })] })).toThrow(/future/);
    expect(() => buildDailyTimeline(source(), { ...a, feedback: [session({ expected_updated_at: at("00:00") })] })).toThrow(/Reconcile/);
  });
  it("rejects stale snapshots when constraints or scope changes", () => {
    const r = buildDailyTimeline(source(), args());
    expect(() => buildDailyTimeline(source([task("a", { notes: "new scope" })]), args({ expected_snapshot: r.snapshot }))).toThrow(/changed/);
    expect(() => buildDailyTimeline(source([task("a")], [{ id: "new", title: "exam", kind: "exam", startsAt: at("10:00"), endsAt: at("11:00") }]), args({ expected_snapshot: r.snapshot }))).toThrow(/changed/);
  });
  it("reserves actual backlog capacity ahead of normal tasks and reports overflow", () => {
    const r = buildDailyTimeline(source([task("a", { estimatedMinutes: 240 }), task("b", { status: "backlog", estimatedMinutes: 90 })]), args({
      backlog_windows: [{ start: "10:00", end: "10:30", task_ids: ["b"] }],
    }));
    const b = work(r).find(s => s.task_id === "b")!;
    expect(b.start).toBe(new Date(at("10:00")).toISOString());
    expect(b.minutes).toBe(30);
    expect(r.outcomes.find(t => t.task_id === "b")?.unallocated_minutes).toBe(60);
    expect(work(r).filter(s => s.task_id === "a").every(s => minute(s.end) <= minute(at("10:00")) || minute(s.start) >= minute(at("10:30")))).toBe(true);
  });
  it("does not consume backlog early when deadline work fits later, and counts rest separately", () => {
    const r = buildDailyTimeline(source([task("urgent"), task("b", { status: "backlog", estimatedMinutes: 15 })]), args({
      backlog_windows: [{ start: "08:00", end: "08:20", task_ids: ["b"] }],
      task_options: [{ task_id: "urgent", scope: "urgent", stop_condition: "stop", must_finish_by: at("12:00"), deadline_reason: "confirmed", depends_on: [] }],
    }));
    expect(r.outcomes.find(t => t.task_id === "b")?.allocated_minutes).toBe(15);
    expect(r.warnings.some(w => w.startsWith("backlog_capacity_shortfall"))).toBe(false);
  });
  it("deadline and mentor preparation reclaim capacity before normal/backlog and never infer a meeting is confirmed", () => {
    const r = buildDailyTimeline(source([task("quiz"), task("ross"), task("b", { status: "backlog" })]), args({ end: "09:30", backlog_windows: [{ start: "08:00", end: "08:30", task_ids: ["b"] }],
      task_options: [{ task_id: "quiz", scope: "quiz", stop_condition: "record", must_finish_by: at("09:00"), deadline_reason: "User confirmed exam; details unknown", depends_on: [] },
        { task_id: "ross", scope: "ross", stop_condition: "record", must_finish_by: at("09:30"), deadline_reason: "User wants preparation before earliest possible meeting", depends_on: [] }],
    }));
    expect(work(r)[0].task_id).toBe("quiz");
    expect(r.outcomes.find(t => t.task_id === "b")?.allocated_minutes).toBe(0);
    expect(r.warnings.some(w => w.startsWith("deadline_capacity_shortfall"))).toBe(true);
  });
  it("respects dependencies; incomplete prerequisite budget keeps dependent scope unallocated", () => {
    const r = buildDailyTimeline(source([task("first"), task("second")]), args({ task_options: [
      { task_id: "first", scope: "first half", stop_condition: "stop", budget_minutes: 20, depends_on: [] },
      { task_id: "second", scope: "second", stop_condition: "stop", depends_on: ["first"] },
    ] }));
    expect(r.outcomes.find(t => t.task_id === "first")?.unallocated_minutes).toBe(40);
    expect(r.outcomes.find(t => t.task_id === "second")?.allocated_minutes).toBe(0);
    expect(r.warnings.some(w => w.startsWith("dependency_unresolved"))).toBe(true);
  });
  it("only flags old/same-title backlog for human scope comparison, never removes them", () => {
    const r = buildDailyTimeline(source([task("b1", { title: "same", status: "backlog", updatedAt: "2026-08-01T00:00:00Z" }), task("b2", { title: "same", status: "backlog" })]), args());
    expect(r.backlog_triage[0]).toMatchObject({ duplicate_candidate: true, stale_candidate: true, selected: false, task_ids: ["b1", "b2"] });
    expect(work(r)).toHaveLength(0);
  });
  it("protects routine time blocks just like the current production timetable", () => {
    const r = buildDailyTimeline(source([task("a", { estimatedMinutes: 200 })], [{ id: "r", title: "study window", kind: "routine", startsAt: at("09:00"), endsAt: at("10:00") }]), args());
    expect(work(r).every(s => minute(s.end) <= minute(at("09:00")) || minute(s.start) >= minute(at("10:00")))).toBe(true);
    expect(r.outcomes[0].allocated_minutes).toBe(150);
  });
  it("validates impossible dates, reversed windows, duplicate options, dependencies and backlog selection", () => {
    expect(() => buildDailyTimeline(source(), args({ date: "2026-02-30" }))).toThrow(/date/);
    expect(() => buildDailyTimeline(source(), args({ end: "07:00" }))).toThrow(/after/);
    expect(() => buildDailyTimeline(source(), args({ backlog_windows: [{ start: "08:00", end: "09:00", task_ids: ["a"] }] }))).toThrow(/backlog/);
    expect(() => buildDailyTimeline(source(), args({ task_options: [{ task_id: "a", scope: "s", stop_condition: "s", depends_on: ["a"] }] }))).toThrow(/cycle/);
  });
  it("never overlaps planned work even across many blocked intervals and budgets", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = buildDailyTimeline(source(Array.from({ length: 5 }, (_, i) => task(`t${i}`, { estimatedMinutes: 10 + ((seed * 17 + i * 31) % 150) }))), args({
        protected_windows: [{ title: "rest", kind: "buffer", start: "09:10", end: "09:35" }, { title: "meal", kind: "meal", start: "11:15", end: "11:45" }],
      }));
      const all = r.timeline.sort((a, b) => minute(a.start) - minute(b.start));
      for (let i = 1; i < all.length; i++) expect(minute(all[i].start)).toBeGreaterThanOrEqual(minute(all[i - 1].end));
      for (const t of r.outcomes) expect(t.allocated_minutes + t.unallocated_minutes).toBe(t.remaining_minutes);
    }
  });
});

describe("portable learning handoff", () => {
  const handoff = {
    schema_version: 1, task_id: "a", expected_updated_at: task("a").updatedAt,
    source_ref: "course/README.md", source_revision: "sha256:source-v1", branch: "class catchup",
    material_refs: ["_private/materials/Note7.pdf"], outline_ref: "existing-outline.md", position: "p8 ex2",
    independent_attempt_refs: ["_private/first-answer.md#2"], prompt_dependency: "hint required",
    open_error_refs: ["existing-outline.md#error-2"], uncovered_scope: ["p9-12"], actual_minutes: 50,
    next_step: "explain coefficient from own first answer", stop_condition: "stop at 10:00", recorded_at: at("09:00"),
  };
  it("preserves evidence links and asks the receiver to read the canonical source", () => {
    const r = validateLearningHandoff(source(), { handoff });
    expect(r.status).toBe("source_read_required"); expect(r.mastery).toBe("not_inferred");
    expect(r.handoff.open_error_refs).toEqual(handoff.open_error_refs);
    expect(r.handoff.prompt_dependency).toBe("hint required");
    expect(validateLearningHandoff(source(), { handoff, observed_source_revision: "sha256:source-v1" }).status).toBe("references_checked_by_caller");
  });
  it("rejects stale task/source revisions, unknown task and invented mastery fields", () => {
    expect(() => validateLearningHandoff(source([task("a", { updatedAt: at("09:01") })]), { handoff })).toThrow(/changed/);
    expect(() => validateLearningHandoff(source(), { handoff, observed_source_revision: "sha256:v2" })).toThrow(/changed/);
    expect(() => validateLearningHandoff(source([]), { handoff })).toThrow(/active/);
    expect(() => validateLearningHandoff(source(), { handoff: { ...handoff, mastery: "passed" } })).toThrow();
  });
});
