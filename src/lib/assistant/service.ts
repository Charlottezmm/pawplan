import { createHash } from "node:crypto";
import { stableJson } from "@/lib/constraints/time-block-series-token";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { assistantDrafts, assistantReminderPreferences, changeLogs, continuationRecords, projects, tasks, workspaces } from "@/lib/db/schema";
import { shanghaiDateKey } from "@/lib/planning/task-actions";
import { getActivePlanId } from "@/lib/planning/active-plan";
import { assistantMutationSchema, assistantToolSchemas, AssistantError, type AssistantMutation } from "./schema";

type Db = { select: (...args: any[]) => any; insert: (...args: any[]) => any; update: (...args: any[]) => any; transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> };
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const hash = (value: unknown) => createHash("sha256").update(stableJson(json(value))).digest("hex");
const taskValues = (change: Extract<AssistantMutation, { action: "update_task" }>["changes"]) => {
  const { estimated_minutes, energy_level, ...rest } = change;
  return { ...rest, ...(estimated_minutes !== undefined ? { estimatedMinutes: estimated_minutes } : {}), ...(energy_level !== undefined ? { energyLevel: energy_level } : {}) };
};
async function context(db: any, workspaceId: string, change: AssistantMutation) {
  const result: Record<string, any> = {};
  if (change.action === "create_task" || change.action === "update_task") {
    result.planId = await getActivePlanId(db, workspaceId);
    if (!result.planId) throw new AssistantError("no_active_plan", "An active plan is required", 404);
  }
  if ("task_id" in change && change.task_id) {
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, change.task_id), eq(tasks.workspaceId, workspaceId), isNull(tasks.archivedAt))).limit(1);
    if (!task || (result.planId && task.planId !== result.planId)) throw new AssistantError("task_not_found", "Task is unavailable in this workspace/active plan", 404);
    result.task = json(task);
    if (change.action === "update_task" && change.changes.status === "todo" && task.status === "backlog") {
      throw new AssistantError("schedule_preview_required", "Use propose_task_timing to place backlog work in a validated slot");
    }
    if (change.action === "update_task" && change.changes.status === "backlog" && !task.movable) {
      throw new AssistantError("protected_task", "Use the existing protected-task Review flow");
    }
  }
  if ("project_id" in change && change.project_id) {
    const [project] = await db.select().from(projects).where(and(eq(projects.id, change.project_id), eq(projects.workspaceId, workspaceId))).limit(1);
    if (!project) throw new AssistantError("project_not_found", "Project is unavailable in this workspace", 404);
    if (result.task && result.task.projectId !== project.id) throw new AssistantError("project_task_mismatch", "The selected task does not belong to this project", 400);
    result.project = json(project);
  }
  if (change.action === "configure_reminders") {
    const [row] = await db.select().from(assistantReminderPreferences).where(eq(assistantReminderPreferences.workspaceId, workspaceId)).limit(1);
    result.preferences = row ? json(row) : null;
  }
  return result;
}
function preview(draft: typeof assistantDrafts.$inferSelect, duplicate = false) {
  const change = draft.request as AssistantMutation;
  const before = draft.before as Record<string, any>;
  return { status: duplicate ? "duplicate" : "preview_created", draftId: draft.id, draftStatus: draft.status,
    liveUnchanged: true, expiresAt: draft.expiresAt.toISOString(), change,
    before, after: change.action === "update_task" ? { ...before.task, ...taskValues(change.changes), ...(change.changes.status === "backlog" ? { scheduledStart: null, scheduledEnd: null } : {}) } : change.action === "create_task" ? { ...change, status: "backlog", scheduledStart: null, scheduledEnd: null }
      : (change.action === "save_continuation" || change.action === "save_meeting_feedback") ? { ...change, project_id: change.project_id ?? before.task?.projectId ?? null } : change,
    warnings: change.action === "create_task" ? ["Created work starts in backlog. The date is an anchor, not an exact appointment; use propose_task_timing to schedule it."]
      : change.action === "configure_reminders" ? ["Preferences are saved disabled; no scheduler or delivery adapter is connected."]
      : change.action === "save_meeting_feedback" ? ["Next actions are user-provided proposals; this does not create or schedule tasks."] : [],
  };
}
export async function previewAssistantChange(db: Db, workspaceId: string, args: unknown, now = new Date()) {
  const input = assistantToolSchemas.preview_assistant_change.parse(args);
  const requestHash = hash(input.change);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(assistantDrafts).where(and(eq(assistantDrafts.workspaceId, workspaceId), eq(assistantDrafts.idempotencyKey, input.idempotency_key))).limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new AssistantError("idempotency_mismatch", "This retry key belongs to a different change");
      return preview(existing, true);
    }
    const before = await context(tx, workspaceId, input.change);
    const [draft] = await tx.insert(assistantDrafts).values({ workspaceId, idempotencyKey: input.idempotency_key, requestHash, request: input.change, before, expiresAt: new Date(now.getTime() + 30 * 60000) }).onConflictDoNothing().returning();
    if (draft) return preview(draft);
    const [race] = await tx.select().from(assistantDrafts).where(and(eq(assistantDrafts.workspaceId, workspaceId), eq(assistantDrafts.idempotencyKey, input.idempotency_key))).limit(1);
    if (!race || race.requestHash !== requestHash) throw new AssistantError("idempotency_mismatch", "This retry key belongs to a different change");
    return preview(race, true);
  });
}
async function readResult(db: any, workspaceId: string, receipt: { entity: string; id: string; row: any }) {
  const table = receipt.entity === "task" ? tasks : receipt.entity === "continuation" ? continuationRecords : assistantReminderPreferences;
  const idColumn = receipt.entity === "reminder_preferences" ? assistantReminderPreferences.workspaceId : (table as typeof tasks).id;
  const [row] = await db.select().from(table).where(and(eq(idColumn, receipt.id), eq(table.workspaceId, workspaceId))).limit(1);
  if (!row) throw new Error("Committed entity unavailable");
  return { verification: "succeeded", matchesMutation: hash(json(row)) === hash(receipt.row), entity: receipt.entity, id: receipt.id, row: json(row) };
}
export async function confirmAssistantChange(db: Db, workspaceId: string, args: unknown, now = new Date()) {
  const input = assistantToolSchemas.confirm_assistant_change.parse(args);
  const outcome = await db.transaction(async (tx) => {
    // Serialize assistant writes per workspace, then claim the immutable proposal.
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    const [draft] = await tx.select().from(assistantDrafts).where(and(eq(assistantDrafts.id, input.draft_id), eq(assistantDrafts.workspaceId, workspaceId))).for("update");
    if (!draft) throw new AssistantError("draft_not_found", "Preview unavailable in this workspace", 404);
    if (draft.status === "applied") return { duplicate: true, receipt: draft.result };
    if (draft.status !== "preview" || draft.expiresAt <= now) throw new AssistantError("preview_expired", "Preview expired; generate and confirm a new preview");
    const change = assistantMutationSchema.parse(draft.request);
    // Lock related entities against ordinary UI/MCP writes as well.
    if ("task_id" in change && change.task_id) await tx.select().from(tasks).where(and(eq(tasks.id, change.task_id), eq(tasks.workspaceId, workspaceId))).for("update");
    if ("project_id" in change && change.project_id) await tx.select().from(projects).where(and(eq(projects.id, change.project_id), eq(projects.workspaceId, workspaceId))).for("share");
    const current = await context(tx, workspaceId, change);
    if (hash(json(current)) !== hash(draft.before)) throw new AssistantError("preview_stale", "Data changed since preview; regenerate and confirm it");
    let row: any; let entity: string;
    if (change.action === "create_task") {
      [row] = await tx.insert(tasks).values({ workspaceId, planId: current.planId, title: change.title, date: new Date(`${change.date}T00:00:00+08:00`), daySegment: change.day_segment, estimatedMinutes: change.estimated_minutes, energyLevel: change.energy_level, priority: change.priority, notes: change.notes, projectId: change.project_id, status: "backlog" }).returning();
      entity = "task";
    } else if (change.action === "update_task") {
      const values: Record<string, any> = { ...taskValues(change.changes), updatedAt: now };
      if (change.changes.status === "backlog") { values.scheduledStart = null; values.scheduledEnd = null; }
      [row] = await tx.update(tasks).set(values).where(and(eq(tasks.id, change.task_id), eq(tasks.workspaceId, workspaceId), isNull(tasks.archivedAt))).returning();
      entity = "task";
    } else if (change.action === "configure_reminders") {
      [row] = await tx.insert(assistantReminderPreferences).values({ workspaceId, configuration: change.configuration, updatedAt: now }).onConflictDoUpdate({ target: assistantReminderPreferences.workspaceId, set: { configuration: change.configuration, updatedAt: now } }).returning();
      entity = "reminder_preferences";
    } else {
      [row] = await tx.insert(continuationRecords).values({ workspaceId, taskId: change.task_id, projectId: change.project_id ?? current.task?.projectId, kind: change.action === "save_continuation" ? "progress" : "meeting_feedback", content: change }).returning();
      entity = "continuation";
    }
    const receipt = { entity, id: entity === "reminder_preferences" ? workspaceId : row.id, row: json(row) };
    await tx.insert(changeLogs).values({ workspaceId, planId: current.planId ?? null, source: "mcp", summary: `Confirmed assistant ${change.action}`, detailsJson: { draftId: draft.id, entity, entityId: receipt.id, userInstruction: input.user_instruction } });
    await tx.update(assistantDrafts).set({ status: "applied", result: receipt }).where(and(eq(assistantDrafts.id, draft.id), eq(assistantDrafts.workspaceId, workspaceId)));
    return { duplicate: false, receipt };
  });
  try {
    return { status: outcome.duplicate ? "duplicate" : "succeeded", mutationApplied: true, draftId: input.draft_id, readback: await readResult(db, workspaceId, outcome.receipt) };
  } catch {
    return { status: "applied_with_readback_error", mutationApplied: true, draftId: input.draft_id, receipt: outcome.receipt, readback: { verification: "failed", matchesMutation: false } };
  }
}
export async function getContinuation(db: Db, workspaceId: string, args: unknown) {
  const input = assistantToolSchemas.get_continuation.parse(args);
  const rows = await db.select().from(continuationRecords).where(and(eq(continuationRecords.workspaceId, workspaceId), input.task_id ? eq(continuationRecords.taskId, input.task_id) : undefined, input.project_id ? eq(continuationRecords.projectId, input.project_id) : undefined)).orderBy(desc(continuationRecords.createdAt), desc(continuationRecords.id)).limit(input.limit + 1);
  return { records: json(rows.slice(0, input.limit)), truncated: rows.length > input.limit, caveat: "Append-only user reports, newest first. Missing updates are unknown; progress is not automatic completion." };
}
export async function getReminderConfiguration(db: Db, workspaceId: string) {
  const [row] = await db.select().from(assistantReminderPreferences).where(eq(assistantReminderPreferences.workspaceId, workspaceId)).limit(1);
  return { configuration: row?.configuration ?? null, enabled: false, deliveryAdapter: "unconfigured", activationRequired: true, caveat: "No reminders are scheduled or delivered. Choose preferences and separately approve a supported cloud adapter before activation." };
}
export async function prepareMeetingSummary(db: Db, workspaceId: string, args: unknown) {
  const input = assistantToolSchemas.prepare_meeting_summary.parse(args);
  if (input.date_from > input.date_to || (Date.parse(input.date_to) - Date.parse(input.date_from)) / 86400000 > 90) throw new AssistantError("invalid_range", "Use an inclusive range of at most 91 days", 400);
  const owned = await db.select().from(projects).where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, input.project_ids)));
  if (new Set(owned.map((row: any) => row.id)).size !== new Set(input.project_ids).size) throw new AssistantError("project_not_found", "Select projects from this workspace", 404);
  const taskRows = await db.select().from(tasks).where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.projectId, input.project_ids), isNull(tasks.archivedAt)));
  const recordRows = await db.select().from(continuationRecords).where(and(eq(continuationRecords.workspaceId, workspaceId), inArray(continuationRecords.projectId, input.project_ids))).orderBy(desc(continuationRecords.createdAt)).limit(501);
  const records = recordRows.filter((row: any) => {
    const date = shanghaiDateKey(new Date(row.createdAt));
    return date >= input.date_from && date <= input.date_to && (row.kind !== "meeting_feedback" || row.content.advisor === input.advisor);
  });
  return { advisor: input.advisor, period: { from: input.date_from, to: input.date_to }, projects: json(owned),
    completedTasks: json(taskRows.filter((row: any) => row.status === "done")), openTasks: json(taskRows.filter((row: any) => row.status !== "done")),
    continuation: json(records.slice(0, 500)), truncated: recordRows.length > 500, nextActionWorkflow: "Use supplied feedback with preview_assistant_change(save_meeting_feedback), confirm it, then preview each agreed new task separately.",
    caveats: ["Task status is current; completion dates are unavailable, so completedTasks are not claimed as accomplishments during this period.", "Projects are explicitly selected; advisor assignment and missing feedback are not inferred.", "No message is sent to Gao or Liu. Next actions require user-provided feedback and confirmation."] };
}
