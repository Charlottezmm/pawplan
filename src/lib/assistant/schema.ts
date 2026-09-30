import { z } from "zod";
import { clockSchema, localDateSchema } from "@/lib/planning/task-timing";

const text = z.string().trim().min(1).max(4000);
const energy = z.enum(["low", "medium", "high"]);
const references = { task_id: z.string().uuid().optional(), project_id: z.string().uuid().optional() };
export const reminderConfigurationSchema = z.object({
  enabled: z.literal(false).default(false),
  timezone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Valid IANA timezone required"),
  quiet_hours: z.object({ start: clockSchema, end: clockSchema }).strict()
    .refine((value) => value.start !== value.end, "Quiet hours must have different boundaries").nullable(),
  minimum_interval_minutes: z.number().int().min(60).max(10080),
  maximum_per_day: z.number().int().min(1).max(24),
  topics: z.array(z.enum(["next_step", "deadline", "check_in", "meeting"])).min(1).max(4),
}).strict();

export const assistantMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_task"), title: z.string().trim().min(1).max(240),
    date: localDateSchema, day_segment: z.enum(["morning", "afternoon", "evening"]),
    estimated_minutes: z.number().int().min(5).max(480), energy_level: energy,
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    notes: text.optional(), project_id: z.string().uuid().optional(),
  }).strict(),
  z.object({ action: z.literal("update_task"), task_id: z.string().uuid(), changes: z.object({
    title: z.string().trim().min(1).max(240).optional(), notes: text.nullable().optional(),
    status: z.enum(["todo", "done", "backlog"]).optional(), blocked: z.boolean().optional(),
    estimated_minutes: z.number().int().min(5).max(480).optional(), energy_level: energy.optional(),
    checkpoint: text.nullable().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "At least one change required") }).strict(),
  z.object({ action: z.literal("save_continuation"), ...references,
    progress: text, blockers: z.array(text).max(20), next_step: text,
    remaining_minutes: z.number().int().min(1).max(480).optional(),
    energy_required: energy.optional(), evidence: z.array(text).max(20).default([]),
  }).strict(),
  z.object({ action: z.literal("save_meeting_feedback"), ...references,
    advisor: z.enum(["gao", "liu"]), meeting_date: localDateSchema,
    feedback: text, decisions: z.array(text).max(20),
    next_actions: z.array(z.object({ title: text, due_date: localDateSchema.optional() }).strict()).max(20),
    open_questions: z.array(text).max(20),
  }).strict(),
  z.object({ action: z.literal("configure_reminders"), configuration: reminderConfigurationSchema }).strict(),
]);
export type AssistantMutation = z.infer<typeof assistantMutationSchema>;
export const assistantToolSchemas = {
  preview_assistant_change: z.object({ change: assistantMutationSchema, idempotency_key: z.string().trim().min(8).max(200) }).strict(),
  confirm_assistant_change: z.object({ draft_id: z.string().uuid(), confirmation: z.literal("USER_CONFIRMED"), user_instruction: text }).strict(),
  get_continuation: z.object({ ...references, limit: z.number().int().min(1).max(100).default(30) }).strict(),
  recommend_next_tasks: z.object({ start_at: z.string().datetime({ offset: true }), available_minutes: z.number().int().min(5).max(480), energy_level: energy, limit: z.number().int().min(1).max(10).default(5) }).strict(),
  prepare_meeting_summary: z.object({ advisor: z.enum(["gao", "liu"]), project_ids: z.array(z.string().uuid()).min(1).max(20), date_from: localDateSchema, date_to: localDateSchema }).strict(),
  get_reminder_configuration: z.object({}).strict(),
  compare_plan_actual: z.object({ date_from: localDateSchema, date_to: localDateSchema }).strict(),
};

export class AssistantError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
