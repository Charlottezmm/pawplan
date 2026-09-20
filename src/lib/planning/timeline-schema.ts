import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timestamp = z.string().datetime({ offset: true });
const minutes = z.number().int().min(0).max(1440);
const window = z.object({ start: clock, end: clock });

// This is a portable request/response contract, not another progress store.
export const timelineFeedbackSchema = z.object({
  id: text,
  task_id: text,
  expected_updated_at: timestamp,
  state: z.enum(["started", "stuck", "completed", "partial", "paused", "timeout"]),
  started_at: timestamp,
  ended_at: timestamp.optional(),
  remaining_minutes: minutes,
  checkpoint: text,
  next_step: text,
  evidence_ref: text.optional(),
}).strict();

export const dailyTimelineArgsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: clock,
  end: clock,
  now: timestamp,
  expected_snapshot: z.string().optional(),
  protected_windows: z.array(window.extend({
    title: text,
    kind: z.enum(["meal", "commute", "rest", "buffer", "other"]),
  }).strict()).max(50),
  backlog_windows: z.array(window.extend({
    task_ids: z.array(text).min(1).max(20),
  }).strict()).max(10).default([]),
  task_options: z.array(z.object({
    task_id: text,
    budget_minutes: minutes.optional(),
    scope: text,
    stop_condition: text,
    must_finish_by: timestamp.optional(),
    deadline_reason: text.optional(),
    depends_on: z.array(text).max(20).default([]),
  }).strict()).max(100).default([]),
  feedback: z.array(timelineFeedbackSchema).max(100).default([]),
  max_focus_minutes: z.number().int().min(10).max(120).default(50),
  break_minutes: z.number().int().min(5).max(30).default(10),
}).strict();

export type DailyTimelineArgs = z.infer<typeof dailyTimelineArgsSchema>;
export type TimelineFeedback = z.infer<typeof timelineFeedbackSchema>;

export const learningHandoffSchema = z.object({
  schema_version: z.literal(1),
  task_id: text,
  expected_updated_at: timestamp,
  source_ref: text,
  source_revision: text,
  branch: text,
  material_refs: z.array(text).min(1).max(30),
  outline_ref: text,
  position: text,
  independent_attempt_refs: z.array(text).max(30),
  prompt_dependency: text,
  open_error_refs: z.array(text).max(30),
  uncovered_scope: z.array(text).max(30),
  actual_minutes: minutes,
  next_step: text,
  stop_condition: text,
  recorded_at: timestamp,
}).strict();

export const validateLearningHandoffArgsSchema = z.object({
  handoff: learningHandoffSchema,
  // Supplied only after the receiving assistant reads the canonical source.
  observed_source_revision: text.optional(),
}).strict();
