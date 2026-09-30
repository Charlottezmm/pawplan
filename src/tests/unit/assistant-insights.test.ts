import { describe, expect, it } from "vitest";
import { durationComparison, firstGap, rankRecommendations } from "@/lib/assistant/insights";
import { assistantMutationSchema } from "@/lib/assistant/schema";
const start = Date.parse("2026-09-30T09:00:00+08:00");
const task = { id: "one", title: "Resume proof", status: "backlog", movable: true, blocked: false, energyLevel: "low", estimatedMinutes: 30, priority: "normal" };
describe("assistant read-only insights", () => {
  it("finds contiguous gaps across overlapping fixed intervals", () => {
    expect(firstGap(start, start + 60 * 60000, 25, [{ start, end: start + 20 * 60000 }, { start: start + 10 * 60000, end: start + 35 * 60000 }])).toBe(start + 35 * 60000);
    expect(firstGap(start, start + 60 * 60000, 30, [{ start, end: start + 35 * 60000 }])).toBeNull();
  });
  it("filters blockers, energy, locked unscheduled work, deadline violations and occupied slots", () => {
    const candidates = [task, { ...task, id: "blocked", blocked: true }, { ...task, id: "heavy", energyLevel: "high" }, { ...task, id: "locked", movable: false }, { ...task, id: "late", deadlineAt: new Date(start + 10 * 60000) }, { ...task, id: "busy", status: "todo", scheduledStart: new Date(start), scheduledEnd: new Date(start + 20 * 60000), energyLevel: "high" }];
    const results = rankRecommendations({ start, end: start + 60 * 60000, energy: "low", limit: 10, candidates, fixed: [], latest: new Map([["one", { next_step: "Finish lemma", remaining_minutes: 15 }]]) });
    expect(results.map((r) => r.taskId)).toEqual(["one"]);
    expect(results[0]).toMatchObject({ minutes: 15, nextStep: "Finish lemma", suggestedStart: new Date(start + 20 * 60000).toISOString() });
    expect(task.status).toBe("backlog");
  });
  it("keeps missing logs unknown, distinguishes captured and current estimates, merges overlaps", () => {
    const records = [{ taskId: "one", startsAt: new Date(start).toISOString(), endsAt: new Date(start + 20 * 60000).toISOString(), approximate: true, planSnapshot: { estimatedMinutes: 30 } }, { taskId: "one", startsAt: new Date(start + 10 * 60000).toISOString(), endsAt: new Date(start + 30 * 60000).toISOString(), planSnapshot: { estimatedMinutes: 30 } }];
    const result = durationComparison([{ ...task, estimatedMinutes: 45 }, { ...task, id: "unknown" }], records, start, start + 60 * 60000);
    expect(result.comparisons[0]).toMatchObject({ currentEstimateMinutes: 45, capturedEstimateMinutes: 30, recordedMinutes: 30, observedDeltaMinutes: 0, approximate: true, overlappingRecords: true });
    expect(result.comparisons[1].recordedMinutes).toBeNull();
    expect(durationComparison([task], records, start + 5 * 60000, start + 60 * 60000).comparisons[0].observedDeltaMinutes).toBeNull();
    expect(durationComparison([task], records, start, start + 60 * 60000, true).comparisons[0].observedDeltaMinutes).toBeNull();
  });
  it("withholds baseline deltas with changing or missing plan snapshots", () => {
    const records = [20, 40].map((estimate) => ({ taskId: "one", startsAt: new Date(start).toISOString(), endsAt: new Date(start + 20 * 60000).toISOString(), planSnapshot: { estimatedMinutes: estimate } }));
    expect(durationComparison([task], records, start, start + 60 * 60000).comparisons[0].observedDeltaMinutes).toBeNull();
    records[1].planSnapshot = {} as any;
    expect(durationComparison([task], records, start, start + 60 * 60000).comparisons[0].observedDeltaMinutes).toBeNull();
  });
  it("rejects reminder activation and invalid clocks/timezones", () => {
    const configuration = { enabled: false, timezone: "Asia/Shanghai", quiet_hours: { start: "22:00", end: "08:00" }, minimum_interval_minutes: 120, maximum_per_day: 2, topics: ["next_step"] };
    expect(assistantMutationSchema.safeParse({ action: "configure_reminders", configuration }).success).toBe(true);
    for (const patch of [{ enabled: true }, { timezone: "Made/Up" }, { minimum_interval_minutes: 5 }, { quiet_hours: { start: "22:00", end: "22:00" } }]) expect(assistantMutationSchema.safeParse({ action: "configure_reminders", configuration: { ...configuration, ...patch } }).success).toBe(false);
  });
});
