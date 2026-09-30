import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { shanghaiDateKey } from "@/lib/planning/task-actions";
import { runPawPlanTool } from "@/lib/mcp/tools";
import { confirmAssistantChange, previewAssistantChange } from "@/lib/assistant/service";
const url = process.env.DATABASE_URL ?? "";
const run = process.env.RUN_DATABASE_INTEGRATION === "1" && url.includes("pawplan_assistant_check") && url.includes("127.0.0.1");
describe.runIf(run)("cloud assistant PostgreSQL acceptance", () => {
  let pool: Pool; let db: ReturnType<typeof drizzle<typeof schema>>; const workspaceIds: string[] = [];
  beforeAll(() => { pool = new Pool({ connectionString: url }); db = drizzle(pool, { schema }); });
  afterEach(async () => { if (workspaceIds.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds.splice(0))); });
  afterAll(async () => { await pool.end(); });
  async function workspace() { const [w] = await db.insert(schema.workspaces).values({ name: `assistant-${randomUUID()}`, passwordHash: "isolated-test" }).returning(); workspaceIds.push(w.id); return w.id; }
  async function seed() {
    const w = await workspace();
    const [plan] = await db.insert(schema.plans).values({ workspaceId: w, title: "test", status: "active", baselineSnapshot: {}, startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") }).returning();
    const [project] = await db.insert(schema.projects).values({ workspaceId: w, name: "Gao project" }).returning();
    const [task] = await db.insert(schema.tasks).values({ workspaceId: w, planId: plan.id, projectId: project.id, title: "Proof", date: new Date("2026-09-30T00:00:00+08:00"), daySegment: "morning", estimatedMinutes: 30, energyLevel: "low", scheduledStart: new Date("2026-09-30T09:00:00+08:00"), scheduledEnd: new Date("2026-09-30T09:30:00+08:00") }).returning();
    return { w, plan, task, project };
  }
  const confirm = (draftId: string) => ({ draft_id: draftId, confirmation: "USER_CONFIRMED", user_instruction: "I confirm the displayed exact preview." });
  async function draft(w: string, change: unknown) { return runPawPlanTool(db, w, "preview_assistant_change", { change, idempotency_key: randomUUID() }, "review_only"); }
  it("previews without live mutation, applies exact completion, reads persisted ID, and retries concurrently once", async () => {
    const { w, task } = await seed();
    const proposal = await draft(w, { action: "update_task", task_id: task.id, changes: { status: "done", checkpoint: "Lemma proven" } });
    expect(proposal.liveUnchanged).toBe(true);
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]).toEqual(task);
    for (const permission of ["read_only", "review_only"] as const) await expect(runPawPlanTool(db, w, "confirm_assistant_change", confirm(proposal.draftId), permission)).rejects.toMatchObject({ code: "mcp_permission_denied" });
    await expect(confirmAssistantChange(db, w, { draft_id: proposal.draftId })).rejects.toThrow();
    const applied = await Promise.all([runPawPlanTool(db, w, "confirm_assistant_change", confirm(proposal.draftId)), runPawPlanTool(db, w, "confirm_assistant_change", confirm(proposal.draftId))]);
    expect(applied.map((r) => r.status).sort()).toEqual(["duplicate", "succeeded"]);
    expect(applied[0].readback).toMatchObject({ verification: "succeeded", matchesMutation: true, id: task.id, row: { status: "done", checkpoint: "Lemma proven" } });
    expect((await db.select().from(schema.actualRecords)).length).toBe(0);
    expect(await db.select().from(schema.changeLogs).where(eq(schema.changeLogs.workspaceId, w))).toHaveLength(1);
  });
  it("rejects cross-workspace IDs, stale previews, expiry and mismatched retry keys", async () => {
    const { w, task } = await seed(); const other = await workspace();
    const change = { action: "update_task", task_id: task.id, changes: { title: "Edited proof" } };
    await expect(draft(other, change)).rejects.toMatchObject({ code: "no_active_plan" });
    const proposal = await draft(w, change);
    await expect(confirmAssistantChange(db, other, confirm(proposal.draftId))).rejects.toMatchObject({ code: "draft_not_found" });
    await db.update(schema.tasks).set({ title: "Concurrent edit" }).where(eq(schema.tasks.id, task.id));
    await expect(confirmAssistantChange(db, w, confirm(proposal.draftId))).rejects.toMatchObject({ code: "preview_stale" });
    const expired = await previewAssistantChange(db, w, { change, idempotency_key: randomUUID() }, new Date("2020-01-01"));
    await expect(confirmAssistantChange(db, w, confirm(expired.draftId))).rejects.toMatchObject({ code: "preview_expired" });
    const key = randomUUID(); await previewAssistantChange(db, w, { change, idempotency_key: key });
    await expect(previewAssistantChange(db, w, { change: { ...change, changes: { title: "Other" } }, idempotency_key: key })).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });
  it("creates a backlog task only after confirmation, handles concurrent preview retries, preserves protection", async () => {
    const { w, task, project } = await seed();
    const args = { change: { action: "create_task", title: "Follow up", date: "2026-10-01", day_segment: "morning", estimated_minutes: 30, energy_level: "low", project_id: project.id }, idempotency_key: randomUUID() };
    const proposals = await Promise.all([previewAssistantChange(db, w, args), previewAssistantChange(db, w, args)]);
    expect(proposals[0].draftId).toBe(proposals[1].draftId);
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, w))).toHaveLength(1);
    const applied = await confirmAssistantChange(db, w, confirm(proposals[0].draftId));
    expect(applied.readback).toMatchObject({ verification: "succeeded", matchesMutation: true, row: { status: "backlog", title: "Follow up", scheduledStart: null, scheduledEnd: null } });
    const createdId = (applied.readback as any).id;
    await expect(draft(w, { action: "update_task", task_id: createdId, changes: { status: "todo" } })).rejects.toMatchObject({ code: "schedule_preview_required" });
    await db.update(schema.tasks).set({ movable: false }).where(eq(schema.tasks.id, task.id));
    await expect(draft(w, { action: "update_task", task_id: task.id, changes: { status: "backlog" } })).rejects.toMatchObject({ code: "protected_task" });
  });
  it("records continuation and supplied meeting feedback without making implied tasks, summarizes explicit projects", async () => {
    const { w, task, project } = await seed(); const other = await workspace();
    const progress = { action: "save_continuation", task_id: task.id, project_id: project.id, progress: "Lemma 1 complete", blockers: [], next_step: "Prove lemma 2", remaining_minutes: 15, energy_required: "low", evidence: ["user report"] };
    await expect(draft(other, progress)).rejects.toMatchObject({ code: "task_not_found" });
    const proposal = await draft(w, progress);
    expect(await db.select().from(schema.continuationRecords)).toHaveLength(0);
    await confirmAssistantChange(db, w, confirm(proposal.draftId));
    const feedback = await draft(w, { action: "save_meeting_feedback", project_id: project.id, advisor: "gao", meeting_date: "2026-09-30", feedback: "Check the assumptions", decisions: ["Use a smaller pilot"], next_actions: [{ title: "Run pilot", due_date: "2026-10-04" }], open_questions: ["Which baseline?"] });
    await confirmAssistantChange(db, w, confirm(feedback.draftId));
    const records = await runPawPlanTool(db, w, "get_continuation", { task_id: task.id }, "read_only");
    expect(records.records[0].content.next_step).toBe("Prove lemma 2");
    expect((await runPawPlanTool(db, other, "get_continuation", {}, "read_only")).records).toHaveLength(0);
    const summary = await runPawPlanTool(db, w, "prepare_meeting_summary", { advisor: "gao", project_ids: [project.id], date_from: "2026-01-01", date_to: "2026-12-31" }, "read_only").catch((e) => e);
    expect(summary.code).toBe("invalid_range");
    const today = shanghaiDateKey(new Date());
    const bundle = await runPawPlanTool(db, w, "prepare_meeting_summary", { advisor: "gao", project_ids: [project.id], date_from: today, date_to: today }, "read_only");
    expect(bundle.continuation).toHaveLength(2);
    expect(bundle.completedTasks).toHaveLength(0);
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, w))).toHaveLength(1);
    const recommendation = await runPawPlanTool(db, w, "recommend_next_tasks", { start_at: "2026-09-30T09:00:00+08:00", available_minutes: 60, energy_level: "low" }, "read_only");
    expect(recommendation.recommendations[0]).toMatchObject({ taskId: task.id, minutes: 15, nextStep: "Prove lemma 2" });
  });
  it("stores reminders disabled, rejects activation, and provides caveated actual comparisons", async () => {
    const { w, task } = await seed();
    const configuration = { enabled: false, timezone: "Asia/Shanghai", quiet_hours: { start: "22:00", end: "08:00" }, minimum_interval_minutes: 120, maximum_per_day: 2, topics: ["next_step"] };
    const proposal = await draft(w, { action: "configure_reminders", configuration });
    expect((await runPawPlanTool(db, w, "get_reminder_configuration", {}, "read_only")).configuration).toBeNull();
    await confirmAssistantChange(db, w, confirm(proposal.draftId));
    expect(await runPawPlanTool(db, w, "get_reminder_configuration", {}, "read_only")).toMatchObject({ configuration, enabled: false, deliveryAdapter: "unconfigured" });
    await expect(draft(w, { action: "configure_reminders", configuration: { ...configuration, enabled: true } })).rejects.toThrow();
    const record = { idempotency_key: randomUUID(), record: { title: "Proof work", task_id: task.id, starts_at: "2026-01-01T09:00:00+08:00", ends_at: "2026-01-01T09:20:00+08:00", approximate: true } };
    await runPawPlanTool(db, w, "save_actual_record", record);
    const comparison = await runPawPlanTool(db, w, "compare_plan_actual", { date_from: "2026-01-01", date_to: "2026-01-01" }, "read_only");
    expect(comparison.comparisons[0]).toMatchObject({ taskId: task.id, capturedEstimateMinutes: 30, recordedMinutes: 20, observedDeltaMinutes: -10, approximate: true });
  });
  it("rolls back the entity and leaves the preview retryable if auditing fails", async () => {
    const { w, task } = await seed(); const proposal = await draft(w, { action: "update_task", task_id: task.id, changes: { status: "done" } });
    const broken = { ...db, select: db.select.bind(db), insert: db.insert.bind(db), update: db.update.bind(db), transaction: (fn: (tx: any) => Promise<any>) => db.transaction(async (tx) => {
      const proxy = new Proxy(tx, { get(target, property) {
        if (property === "insert") return (table: unknown) => { if (table === schema.changeLogs) throw new Error("audit unavailable"); return target.insert(table as any); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      return fn(proxy);
    }) };
    await expect(confirmAssistantChange(broken, w, confirm(proposal.draftId))).rejects.toThrow("audit unavailable");
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]).toEqual(task);
    expect((await db.select().from(schema.assistantDrafts).where(eq(schema.assistantDrafts.id, proposal.draftId)))[0].status).toBe("preview");
    expect((await confirmAssistantChange(db, w, confirm(proposal.draftId))).status).toBe("succeeded");
  });
  it("keeps a committed receipt through readback failure and detects later edits on replay", async () => {
    const { w, task } = await seed(); const proposal = await draft(w, { action: "update_task", task_id: task.id, changes: { status: "done" } });
    const broken = { transaction: db.transaction.bind(db), select: () => { throw new Error("read unavailable"); }, insert: db.insert.bind(db), update: db.update.bind(db) };
    expect((await confirmAssistantChange(broken, w, confirm(proposal.draftId))).status).toBe("applied_with_readback_error");
    expect((await confirmAssistantChange(db, w, confirm(proposal.draftId))).readback).toMatchObject({ verification: "succeeded", matchesMutation: true });
    await db.update(schema.tasks).set({ title: "Later edit" }).where(eq(schema.tasks.id, task.id));
    expect((await confirmAssistantChange(db, w, confirm(proposal.draftId))).readback).toMatchObject({ verification: "succeeded", matchesMutation: false });
  });
});
