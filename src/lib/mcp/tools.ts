import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { checkins, courses, dayCapacities, routines, tasks } from "@/lib/db/schema";
import { buildCapacityModel } from "@/lib/planning/capacity-model";
import { loadEffectiveTimeBlocks } from "@/lib/planning/effective-time-blocks";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/lib/agent-runs/service";
import type { AgentRunKind } from "@/lib/agent-runs/types";
import {
  createDailyCheckin,
  createInboxItem,
  getActivePlanId,
  proposeAgentPatch,
  updateTaskSchedule,
  updateTaskNotes,
  updateTaskStatus,
} from "@/lib/planning/service";
import { proposeRebalancePatch } from "@/lib/planning/rebalance";
import { saveMcpPlanImport } from "@/lib/mcp/plan-import";
import {
  getConversationSummaries,
  getDecisionRecords,
  recordDecision,
  saveConversationSummary,
} from "@/lib/mcp/conversation-tools";
import { proposeTimetableImport, proposeTimetableImportArgsSchema } from "@/lib/mcp/timetable-import";
import { updateTasksBatch } from "@/lib/mcp/task-batch";
import { applyTaskNotesBatch, proposeTaskNotesBatch } from "@/lib/mcp/task-notes-batch";
import {
  applyTaskArchiveBatch,
  attachTaskBatchPostCommitReadback,
  previewTaskBatch,
} from "@/lib/mcp/task-archive";
import { previewReplacePlanWindow, replacePlanWindow } from "@/lib/mcp/replace-plan-window";
import {
  applyProjectPortfolioUpdate,
  proposeProjectPortfolioUpdate,
} from "@/lib/mcp/project-portfolio-update";
import {
  applyTimeBlockSeriesMutation,
  previewTimeBlockSeriesMutation,
} from "@/lib/constraints/time-block-series";
import { getHostedMcpUsageSnapshot } from "@/lib/mcp/usage";
import {
  getProjectPortfolio,
  getTasksWithProjectContext as readTasks,
} from "@/lib/mcp/project-context";
import {
  canUsePawPlanTool,
  isPawPlanWriteTool,
  McpPermissionError,
  pawPlanWriteToolNames,
  type McpPermission,
} from "@/lib/mcp/tool-metadata";

type PlanningDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

type SerializedTask = ReturnType<typeof serializeTask>;

const taskStatusSchema = z.enum(["todo", "done", "skipped", "backlog"]);
const writableTaskStatusSchema = z.enum(["todo", "done", "backlog"]);
const projectStatusSchema = z.enum(["active", "paused", "completed", "archived"]);
const prioritySchema = z.enum(["low", "normal", "high", "urgent"]);
const energyLevelSchema = z.enum(["low", "medium", "high"]);
const daySegmentSchema = z.enum(["morning", "afternoon", "evening"]);
const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dateTimeStringSchema = z.string().datetime({ offset: true });
const createdBySchema = z.enum(["codex", "claude", "user"]);
const conversationContextTypeSchema = z.enum([
  "weekly_review",
  "decision",
  "learning_qa",
  "check_in_followup",
  "methodology",
  "adhoc",
]);
const decisionStatusSchema = z.enum(["active", "superseded", "abandoned"]);
const limitSchema = z.number().int().min(1).max(100).optional();

const emptyArgsSchema = z.object({}).strict();
const rangeArgsSchema = z
  .object({
    date_from: dateStringSchema.optional(),
    date_to: dateStringSchema.optional(),
  })
  .strict();
const mcpAgentPatchSchema = z
  .object({
    operations: z
      .array(
        z
          .object({
            type: z.string(),
            task_id: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .strict();
const mcpAgentPatchInputSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, mcpAgentPatchSchema);
const proposePatchArgsSchema = z
  .object({
    mode: z.enum(["today", "week"]),
    reason: z.string().min(1),
    patch: mcpAgentPatchInputSchema,
    created_by: createdBySchema.optional(),
  })
  .strict();
const rebalanceMoveSchema = z
  .object({
    task_id: z.string().min(1),
    to_date: dateStringSchema,
    to_day_segment: daySegmentSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
const proposeRebalanceArgsSchema = z
  .object({
    idempotency_key: z.string().trim().min(8).max(200),
    reason: z.string().trim().min(1).max(4000),
    moves: z.array(rebalanceMoveSchema).min(1).max(50),
    created_by: createdBySchema.optional(),
  })
  .strict();
const taskBatchOperationSchema = z
  .object({
    task_id: z.string().min(1),
    status: writableTaskStatusSchema.optional(),
    date: dateStringSchema.optional(),
    day_segment: daySegmentSchema.optional(),
    blocked: z.boolean().optional(),
    expected_status: taskStatusSchema.optional(),
    expected_date: dateStringSchema.optional(),
    expected_day_segment: daySegmentSchema.optional(),
    expected_blocked: z.boolean().optional(),
  })
  .strict()
  .refine(
    (operation) =>
      operation.status !== undefined ||
      operation.date !== undefined ||
      operation.day_segment !== undefined ||
      operation.blocked !== undefined,
    { message: "Each batch operation must update status, date, day_segment, or blocked" },
  );

const taskBatchFiltersSchema = z
  .object({
    statuses: z.array(taskStatusSchema).min(1).max(4).refine((values) => new Set(values).size === values.length, {
      message: "statuses must be unique",
    }).optional(),
    date_from: dateStringSchema.optional(),
    date_to: dateStringSchema.optional(),
    project_ids: z.array(z.string().uuid()).min(1).max(100).refine((values) => new Set(values).size === values.length, {
      message: "project_ids must be unique",
    }).optional(),
    task_ids: z.array(z.string().uuid()).min(1).max(500).refine((values) => new Set(values).size === values.length, {
      message: "task_ids must be unique",
    }).optional(),
  })
  .strict()
  .superRefine((filters, context) => {
    if (Object.values(filters).every((value) => value === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one task filter is required" });
    }
    if ((filters.date_from === undefined) !== (filters.date_to === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "date_from and date_to must be provided together" });
    }
  });

const taskArchiveApplySchema = z
  .object({
    preview_token: z.string().min(32),
    approval_id: z.string().uuid(),
    confirm_task_count: z.number().int().min(1).max(500),
    idempotency_key: z.string().trim().min(8).max(200),
  })
  .strict();

const timeBlockSeriesChangesSchema = z
  .object({
    title: z.string().trim().min(1).max(180).optional(),
    kind: z.enum(["course", "exam", "meeting", "unavailable", "routine", "recovery"]).optional(),
    start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    location: z.string().trim().max(240).nullable().optional(),
    weekday_mask: z.number().int().min(0).max(127).nullable().optional(),
    recurrence_label: z.string().trim().max(160).nullable().optional(),
    protected: z.boolean().optional(),
    starts_on: dateStringSchema.optional(),
    ends_on: dateStringSchema.optional(),
  })
  .strict();

const timeBlockSeriesBaseSchema = z
  .object({
    series_id: z.string().uuid(),
    scope: z.enum(["occurrence", "following", "series"]),
    occurrence_date: dateStringSchema,
    mode: z.enum(["preview", "apply"]),
    preview_token: z.string().min(32).optional(),
    approval_id: z.string().uuid().optional(),
    idempotency_key: z.string().trim().min(8).max(200),
  })
  .strict();

const replacePlanTaskSchema = z
  .object({
    external_task_key: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(240),
    project_id: z.string().uuid(),
    milestone_id: z.string().uuid().nullable().optional(),
    parent_external_task_key: z.string().trim().min(1).max(200).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    date: dateStringSchema,
    day_segment: daySegmentSchema,
    estimated_minutes: z.number().int().min(5).max(480),
    priority: prioritySchema.optional(),
    energy_level: energyLevelSchema.optional(),
    movable: z.boolean().optional(),
    blocked: z.boolean().optional(),
  })
  .strict();

const projectPortfolioFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    color: z.string().trim().min(1).max(32),
    category: z.string().trim().min(1).max(80).nullable(),
    objective: z.string().trim().min(1).max(4000).nullable(),
    success_criteria: z.string().trim().min(1).max(4000).nullable(),
    status: projectStatusSchema,
    priority: prioritySchema,
    start_date: dateStringSchema.nullable(),
    target_date: dateStringSchema.nullable(),
    weekly_target_minutes: z.number().int().min(0).max(10080).nullable(),
  })
  .strict();

const projectPortfolioChangesSchema = projectPortfolioFieldsSchema.partial().refine(
  (changes) => Object.keys(changes).length > 0,
  { message: "Project changes cannot be empty" },
);

const milestoneFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    objective: z.string().trim().min(1).max(4000).nullable(),
    success_criteria: z.string().trim().min(1).max(4000).nullable(),
    target_date: dateStringSchema.nullable(),
    status: z.enum(["planned", "in_progress", "completed", "skipped"]),
    position: z.number().int().min(0).max(10000),
  })
  .strict();

const milestoneChangesSchema = milestoneFieldsSchema.partial().refine(
  (changes) => Object.keys(changes).length > 0,
  { message: "Milestone changes cannot be empty" },
);

const projectPortfolioUpdateSchema = z
  .object({
    projects: z.array(z.discriminatedUnion("action", [
      projectPortfolioFieldsSchema.extend({
        action: z.literal("create"),
        client_key: z.string().trim().min(1).max(120),
      }),
      z.object({
        action: z.literal("update"),
        project_id: z.string().uuid(),
        expected_updated_at: dateTimeStringSchema,
        changes: projectPortfolioChangesSchema,
      }).strict(),
    ])).max(50),
    milestones: z.array(z.discriminatedUnion("action", [
      milestoneFieldsSchema.extend({
        action: z.literal("create"),
        client_key: z.string().trim().min(1).max(120),
        project_id: z.string().uuid().optional(),
        project_client_key: z.string().trim().min(1).max(120).optional(),
      }),
      z.object({
        action: z.literal("update"),
        milestone_id: z.string().uuid(),
        expected_updated_at: dateTimeStringSchema,
        changes: milestoneChangesSchema,
      }).strict(),
    ])).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.projects.length + value.milestones.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one Project or Milestone operation is required" });
    }
    for (const milestone of value.milestones) {
      if (milestone.action === "create" && (milestone.project_id ? 1 : 0) + (milestone.project_client_key ? 1 : 0) !== 1) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one Project reference" });
      }
    }
  });

function portfolioUpdateInput(value: z.infer<typeof projectPortfolioUpdateSchema>) {
  return {
    projects: value.projects.map((entry) => entry.action === "create"
      ? {
          action: "create" as const,
          clientKey: entry.client_key,
          name: entry.name,
          color: entry.color,
          category: entry.category,
          objective: entry.objective,
          successCriteria: entry.success_criteria,
          status: entry.status,
          priority: entry.priority,
          startDate: entry.start_date,
          targetDate: entry.target_date,
          weeklyTargetMinutes: entry.weekly_target_minutes,
        }
      : {
          action: "update" as const,
          projectId: entry.project_id,
          expectedUpdatedAt: entry.expected_updated_at,
          changes: {
            ...(entry.changes.name !== undefined ? { name: entry.changes.name } : {}),
            ...(entry.changes.color !== undefined ? { color: entry.changes.color } : {}),
            ...(entry.changes.category !== undefined ? { category: entry.changes.category } : {}),
            ...(entry.changes.objective !== undefined ? { objective: entry.changes.objective } : {}),
            ...(entry.changes.success_criteria !== undefined ? { successCriteria: entry.changes.success_criteria } : {}),
            ...(entry.changes.status !== undefined ? { status: entry.changes.status } : {}),
            ...(entry.changes.priority !== undefined ? { priority: entry.changes.priority } : {}),
            ...(entry.changes.start_date !== undefined ? { startDate: entry.changes.start_date } : {}),
            ...(entry.changes.target_date !== undefined ? { targetDate: entry.changes.target_date } : {}),
            ...(entry.changes.weekly_target_minutes !== undefined ? { weeklyTargetMinutes: entry.changes.weekly_target_minutes } : {}),
          },
        }),
    milestones: value.milestones.map((entry) => entry.action === "create"
      ? {
          action: "create" as const,
          clientKey: entry.client_key,
          projectId: entry.project_id,
          projectClientKey: entry.project_client_key,
          title: entry.title,
          objective: entry.objective,
          successCriteria: entry.success_criteria,
          targetDate: entry.target_date,
          status: entry.status,
          position: entry.position,
        }
      : {
          action: "update" as const,
          milestoneId: entry.milestone_id,
          expectedUpdatedAt: entry.expected_updated_at,
          changes: {
            ...(entry.changes.title !== undefined ? { title: entry.changes.title } : {}),
            ...(entry.changes.objective !== undefined ? { objective: entry.changes.objective } : {}),
            ...(entry.changes.success_criteria !== undefined ? { successCriteria: entry.changes.success_criteria } : {}),
            ...(entry.changes.target_date !== undefined ? { targetDate: entry.changes.target_date } : {}),
            ...(entry.changes.status !== undefined ? { status: entry.changes.status } : {}),
            ...(entry.changes.position !== undefined ? { position: entry.changes.position } : {}),
          },
        }),
  };
}

const weeklySummarySchema = z
  .object({
    week_start: dateStringSchema,
    focus: z.string().trim().min(1).max(2000),
    milestones: z.array(z.string().trim().min(1).max(240)).max(30),
  })
  .strict();

const monthlySummarySchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    goal: z.string().trim().min(1).max(2000),
    milestones: z.array(z.string().trim().min(1).max(240)).max(50),
  })
  .strict();

export const pawPlanToolSchemas = {
  get_agent_guidance: emptyArgsSchema,
  get_mcp_usage: emptyArgsSchema,
  get_today: emptyArgsSchema,
  get_week: emptyArgsSchema,
  get_month: rangeArgsSchema,
  get_constraints: rangeArgsSchema,
  get_capacity: rangeArgsSchema,
  get_decisions: z
    .object({
      status: decisionStatusSchema.optional(),
      limit: limitSchema,
    })
    .strict(),
  get_conversations: z
    .object({
      context_type: conversationContextTypeSchema.optional(),
      limit: limitSchema,
    })
    .strict(),
  get_checkins: z
    .object({
      days: z.number().int().min(1).max(90).optional(),
    })
    .strict(),
  get_project_portfolio: z
    .object({
      status: z.array(projectStatusSchema).min(1).max(4).optional(),
      category: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
      include_milestones: z.boolean().default(true),
      include_task_summary: z.boolean().default(true),
    })
    .strict(),
  propose_project_portfolio_update: z
    .object({
      update: projectPortfolioUpdateSchema,
      reason: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
  apply_project_portfolio_update: z
    .object({
      update: projectPortfolioUpdateSchema,
      preview_token: z.string().min(32),
      approval_id: z.string().uuid(),
      idempotency_key: z.string().trim().min(8).max(200),
    })
    .strict(),
  get_tasks: z
    .object({
      status: taskStatusSchema.optional(),
      archive_state: z.enum(["active", "archived", "all"]).optional(),
      date_from: dateStringSchema.optional(),
      date_to: dateStringSchema.optional(),
      project_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
      milestone_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
      parent_task_id: z.string().uuid().optional(),
      overdue_as_of: dateStringSchema.optional(),
    })
    .strict(),
  preview_task_batch: z
    .object({
      action: z.enum(["archive", "restore", "delete"]),
      filters: taskBatchFiltersSchema,
      include_done: z.boolean().optional(),
      allow_delete_unarchived: z.boolean().optional(),
    })
    .strict(),
  archive_tasks_batch: taskArchiveApplySchema,
  restore_tasks_batch: taskArchiveApplySchema,
  delete_tasks_batch: z
    .object({
      preview_token: z.string().min(32),
      approval_id: z.string().uuid(),
      confirm_task_count: z.number().int().min(1).max(50),
      confirmation: z.literal("PERMANENT_DELETE"),
      idempotency_key: z.string().trim().min(8).max(200),
      operation_id: z.string().uuid(),
    })
    .strict(),
  update_time_block_series: timeBlockSeriesBaseSchema
    .extend({ changes: timeBlockSeriesChangesSchema }),
  delete_time_block_series: timeBlockSeriesBaseSchema,
  replace_plan_window: z
    .object({
      date_from: dateStringSchema,
      date_to: dateStringSchema,
      source_key: z.string().trim().min(1).max(160),
      expected_plan_id: z.string().uuid(),
      expected_current_version_id: z.string().uuid().nullable(),
      retire_scope: z.enum(["source_managed", "all_non_completed"]),
      tasks: z.array(replacePlanTaskSchema).max(500),
      weekly_summaries: z.array(weeklySummarySchema).max(20),
      monthly_summaries: z.array(monthlySummarySchema).max(12),
      focus_project_ids: z.array(z.string().uuid()).max(50).refine((values) => new Set(values).size === values.length, {
        message: "focus_project_ids must be unique",
      }),
      idempotency_key: z.string().trim().min(8).max(200),
      mode: z.enum(["preview", "replace"]),
      preview_token: z.string().min(32).optional(),
      approval_id: z.string().uuid().optional(),
      created_by: createdBySchema.optional(),
    })
    .strict(),
  create_inbox_item: z
    .object({
      title: z.string().trim().min(1).max(240),
      source: z.enum(["manual", "imported"]).optional(),
    })
    .strict(),
  create_checkin: z
    .object({
      date: dateStringSchema.optional(),
      completed_text: z.string().max(1000),
      blocker_text: z.string().max(1000).optional(),
      next_text: z.string().max(1000).optional(),
    })
    .strict(),
  update_task_status: z
    .object({
      task_id: z.string().min(1),
      status: writableTaskStatusSchema,
      note: z.string().max(1000).optional(),
    })
    .strict(),
  update_task_schedule: z
    .object({
      task_id: z.string().min(1),
      date: dateStringSchema.optional(),
      day_segment: daySegmentSchema.optional(),
      status: writableTaskStatusSchema.optional(),
      blocked: z.boolean().optional(),
    })
    .strict(),
  update_task_notes: z
    .object({
      task_id: z.string().min(1),
      notes: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Structured Markdown notes. Prefer labels: 目标, 完成标准, 资源, 下一步, 备注."),
    })
    .strict(),
  propose_task_notes_batch: z
    .object({
      idempotency_key: z.string().trim().min(8).max(200),
      reason: z.string().trim().min(1).max(4000).optional(),
      operations: z
        .array(
          z
            .object({
              task_id: z.string().uuid(),
              notes: z
                .string()
                .trim()
                .min(1)
                .max(2000)
                .describe("Exact replacement notes to show in the single batch Review."),
            })
            .strict(),
        )
        .min(1)
        .max(50)
        .refine((operations) => new Set(operations.map((operation) => operation.task_id)).size === operations.length, {
          message: "task_id values must be unique",
        }),
    })
    .strict(),
  apply_task_notes_batch: z
    .object({
      approval_id: z.string().uuid(),
      preview_token: z.string().min(32),
      idempotency_key: z.string().trim().min(8).max(200),
    })
    .strict(),
  update_tasks_batch: z
    .object({
      idempotency_key: z.string().trim().min(8).max(200),
      operations: z.array(taskBatchOperationSchema).min(1).max(50),
    })
    .strict(),
  save_conversation_summary: z
    .object({
      topic: z.string().trim().min(1).max(240),
      context_type: conversationContextTypeSchema,
      summary: z.string().trim().min(1).max(10000),
      decisions: z
        .array(
          z
            .object({
              topic: z.string().trim().min(1).max(240),
              chosen: z.string().trim().min(1).max(2000),
              rationale: z.string().trim().min(1).max(4000),
            })
            .strict(),
        )
        .max(50),
      open_questions: z.array(z.string().trim().min(1).max(1000)).max(50),
      created_by: createdBySchema,
    })
    .strict(),
  record_decision: z
    .object({
      topic: z.string().trim().min(1).max(240),
      context: z.string().trim().min(1).max(10000),
      options_considered: z.array(z.string().trim().min(1).max(2000)).min(1).max(50),
      chosen: z.string().trim().min(1).max(4000),
      rationale: z.string().trim().min(1).max(10000),
      tradeoffs_accepted: z.string().trim().max(10000),
      status: decisionStatusSchema,
    })
    .strict(),
  propose_patch: proposePatchArgsSchema,
  propose_daily_rebalance: proposeRebalanceArgsSchema,
  propose_week_rebalance: proposeRebalanceArgsSchema,
  propose_timetable_import: proposeTimetableImportArgsSchema,
  import_plan_bundle: z
    .object({
      import_key: z.string().trim().min(1).max(160),
      created_by: createdBySchema.optional(),
      source_label: z.string().trim().max(120).optional(),
      overall_plan: z
        .object({
          title: z.string().trim().min(1).max(180),
          summary: z.string().trim().min(1).max(2000),
        })
        .strict(),
      daily_tasks: z
        .array(
          z
            .object({
              title: z.string().trim().min(1).max(240),
              date: dateStringSchema,
              day_segment: daySegmentSchema,
              estimated_minutes: z.number().int().min(5).max(480),
              priority: prioritySchema.optional(),
              energy_level: energyLevelSchema.optional(),
              notes: z
                .string()
                .max(2000)
                .optional()
                .describe("Structured Markdown details. Prefer labels like 目标, 完成标准, 资源, 下一步, 备注 so Plan can show useful task detail."),
              project_name: z.string().trim().max(120).optional(),
              track_name: z.string().trim().max(120).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
      weekly_summary: z
        .object({
          week_start: dateStringSchema,
          focus: z.string().trim().min(1).max(2000),
          milestones: z.array(z.string().trim().min(1).max(240)).max(20),
        })
        .strict(),
      monthly_summary: z
        .object({
          month: z.string().regex(/^\d{4}-\d{2}$/),
          goal: z.string().trim().min(1).max(2000),
          milestones: z.array(z.string().trim().min(1).max(240)).max(30),
        })
        .strict(),
    })
    .strict(),
};

export type PawPlanToolName = keyof typeof pawPlanToolSchemas;
export type { McpPermission } from "@/lib/mcp/tool-metadata";
export { isPawPlanWriteTool, pawPlanWriteToolNames };

export const pawPlanToolNames = Object.keys(pawPlanToolSchemas) as PawPlanToolName[];

export const pawPlanAgentGuidance = {
  purpose: "Use PawPlan MCP as a review-first planning interface. PawPlan owns validation, persistence, Review, audit, and readback.",
  planningPrompt: `Use this workflow only when the user explicitly asks to review or rebalance their PawPlan schedule. Do not run a recurring daily cleanup or create a Review merely because tasks are overdue.

Read first:
- get_today
- get_week
- get_month
- get_tasks
- get_project_portfolio
- get_capacity
- get_constraints
- get_checkins

Required workflow:
1. Confirm the user requested a schedule review or supplied a concrete event that requires one.
2. Read current tasks, capacity, and fixed constraints before suggesting exact moves.
3. If exact task targets are known, use propose_daily_rebalance or propose_week_rebalance to create one Review draft. Never choose new dates merely because a task is overdue.
4. Inspect the returned status before reporting the outcome:
   - draft_created: say a new Review draft was created and tell the user to open Review.
   - duplicate with patchId: say an existing Review draft is already available.
   - no_change: explain why no draft was created.
   - failed: report the error and do not claim success.
5. Do not apply changes automatically.
6. Do not hand-write propose_patch for routine daily task movement.
7. Do not edit constraints.
8. Do not treat Review drafts, suggestions, briefs, or spoken advice as applied changes.`,
  boundaries: [
    "Run planning review only after an explicit user request or a concrete user-provided event; do not perform recurring daily cleanup.",
    "Read planning context before proposing changes.",
    "Use propose_daily_rebalance for user-requested daily task moves with exact targets.",
    "Use propose_week_rebalance for user-requested weekly task moves with exact targets.",
    "Do not choose new dates automatically for overdue tasks or move them to backlog without the user's decision.",
    "Inspect the returned status before claiming a Review draft exists.",
    "Do not apply changes automatically.",
    "Do not edit constraints through MCP.",
    "Use create_checkin, update_task_status, update_task_schedule, or update_task_notes only when the user explicitly asks to record a fact or make a trusted direct edit.",
    "For multiple trusted direct status/schedule edits, use one update_tasks_batch call; do not loop low-level writes. Multiple notes edits must use propose_task_notes_batch, one user approval, then apply_task_notes_batch. Routine planning still uses Review-first rebalance tools.",
  ],
  reviewStatusMeanings: {
    draft_created: "A new Review draft was created.",
    duplicate: "A matching existing Review draft is already available; do not claim a new draft.",
    needs_decision: "No move was applied; one or more tasks need an explicit user decision.",
    no_change: "No Review draft was created.",
    failed: "The operation failed; report the error and do not claim success.",
  },
};

export const pawPlanServerInstructions =
  "PawPlan is review-first. Rebalance tools create a Review draft only and must be used only after an explicit user request or concrete user-provided event, never as recurring daily cleanup. AI Project Portfolio changes must use propose_project_portfolio_update to create a pending approval, then wait for the user to approve the exact Preview in PawPlan Review before apply_project_portfolio_update with approval_id. Multiple task-notes edits must use propose_task_notes_batch, wait for the single exact Review approval, then use apply_task_notes_batch; approval alone is authorization, not proof of persistence. An MCP agent cannot approve its own proposal. Before a user-requested planning review, call get_agent_guidance and follow its workflow. Never claim changes are applied until persisted readback succeeds.";

export const pawPlanToolDescriptions: Record<PawPlanToolName, string> = {
  get_agent_guidance: "Read PawPlan on-demand planning guidance and Review-first safety rules.",
  get_mcp_usage: "Read the current workspace Hosted MCP daily write quota and Shanghai-midnight reset time.",
  get_today: "Read today's PawPlan planning context for the configured workspace.",
  get_week: "Read this week's PawPlan planning context for the configured workspace.",
  get_month: "Read a minimal raw month/range task list for the configured workspace.",
  get_constraints: "Read workspace-scoped protected blocks, courses, routines, and time blocks.",
  get_capacity: "Read shared day/segment capacity for the configured workspace.",
  get_decisions: "Read recent workspace-scoped structured decisions, optionally filtered by status.",
  get_conversations: "Read recent workspace-scoped structured conversation summaries, optionally filtered by context type.",
  get_checkins: "Read recent daily check-ins for the configured workspace.",
  get_project_portfolio:
    "Read workspace-scoped Projects with their definitions, optional Milestones, task status counts, overdue counts, and unassigned-task summary.",
  propose_project_portfolio_update:
    "AI proposes an exact Project/Milestone definition update and creates a pending PawPlan Review approval. This never changes live Projects, Milestones, or tasks.",
  apply_project_portfolio_update:
    "After the user approves the exact Project Portfolio Preview in PawPlan Review, atomically apply it with approval_id, Preview token, idempotency, audit, and final readback. Never links or moves tasks.",
  get_tasks:
    "Read workspace-scoped tasks with Project, Milestone, and parent-task context, optionally filtered by status, date range, hierarchy, or overdue date.",
  preview_task_batch:
    "Resolve an exact task set for archive, restore, or permanent delete, create a pending user approval in PawPlan Review, and return its approval_id plus the signed Preview token. This never changes live tasks.",
  archive_tasks_batch:
    "Archive the exact tasks from a confirmed Preview without changing their todo/done/skipped/backlog status, then return persisted readback.",
  restore_tasks_batch:
    "Restore the exact archived tasks from a confirmed Preview while preserving their original task status, then return persisted readback.",
  delete_tasks_batch:
    "Permanently delete at most 50 exact, confirmed tasks and return the IDs actually deleted. This is irreversible and normally accepts archived tasks only.",
  update_time_block_series:
    "Preview a series update for user approval in PawPlan Review, or apply it with the approved approval_id, for one occurrence, following occurrences, or the entire series.",
  delete_time_block_series:
    "Preview a series cancellation/deletion for user approval in PawPlan Review, or apply it with the approved approval_id.",
  replace_plan_window:
    "Preview an exact active-plan window replacement for user approval in PawPlan Review, or atomically apply it with the approved approval_id.",
  create_inbox_item: "Create an inbox item and record an MCP audit changelog.",
  create_checkin: "Create or update a daily check-in with MCP source attribution.",
  update_task_status: "Update a task status with MCP source attribution.",
  update_task_schedule: "Update a task date or day segment with MCP source attribution.",
  update_task_notes: "Update only a task's notes/details with MCP source attribution; this does not change schedule, status, priority, or title.",
  propose_task_notes_batch:
    "Create one Review for 1 to 50 exact task-notes replacements, with every before/after diff visible. This never changes live tasks and does not support partial approval.",
  apply_task_notes_batch:
    "Atomically apply one user-approved task-notes batch using only its approval_id, signed Preview token, and idempotency key, then verify every note by readback.",
  update_tasks_batch:
    "Atomically apply up to 50 trusted direct task status/schedule edits with idempotency and final readback. Routine planning must use Review-first rebalance tools.",
  save_conversation_summary: "Save a structured conversation summary without storing raw transcript, with MCP provenance.",
  record_decision: "Record a structured workspace decision with MCP provenance.",
  propose_patch: "Create a preview-only agent patch draft; this never applies the patch.",
  propose_daily_rebalance:
    "Create an idempotent Review draft from task move intent for daily planning. PawPlan fills current from_date/from_day_segment.",
  propose_week_rebalance:
    "Create an idempotent Review draft from task move intent for weekly planning. PawPlan fills current from_date/from_day_segment.",
  propose_timetable_import: "Create a preview-only timetable import draft for user review; this never writes constraints directly.",
  import_plan_bundle: "Import a trusted structured plan bundle into real PawPlan tasks with MCP provenance.",
};

export function allowedPawPlanToolNames(permission: McpPermission) {
  return pawPlanToolNames.filter((name) => canUsePawPlanTool(permission, name));
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function shanghaiDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function startOfShanghaiDay(date: Date) {
  const { year, month, day } = shanghaiDateParts(date);
  return new Date(Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000);
}

function parseDateBoundary(value: string) {
  return new Date(`${value}T00:00:00.000+08:00`);
}

function toDateKey(date: Date) {
  const { year, month, day } = shanghaiDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function serializeTask(task: Record<string, any>) {
  return {
    ...task,
    date: task.date instanceof Date ? task.date.toISOString() : task.date,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
  };
}

function serializeCheckin(checkin: Record<string, any>) {
  return {
    ...checkin,
    date: checkin.date instanceof Date ? checkin.date.toISOString() : checkin.date,
    createdAt: checkin.createdAt instanceof Date ? checkin.createdAt.toISOString() : checkin.createdAt,
    updatedAt: checkin.updatedAt instanceof Date ? checkin.updatedAt.toISOString() : checkin.updatedAt,
  };
}

function serializeDateFields(row: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  );
}

function readRange(args: { date_from?: string; date_to?: string }) {
  const start = args.date_from ? parseDateBoundary(args.date_from) : startOfShanghaiDay(new Date());
  const end = args.date_to ? parseDateBoundary(args.date_to) : addDays(start, 7);
  return { start, end, date_from: toDateKey(start), date_to: toDateKey(end) };
}

function datesInRange(start: Date, end: Date) {
  const dates: Date[] = [];
  for (let cursor = start; cursor < end; cursor = addDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

async function readCheckins(db: PlanningDb, workspaceId: string, days = 7) {
  const start = addDays(startOfShanghaiDay(new Date()), -days + 1);
  const rows = await db
    .select()
    .from(checkins)
    .where(and(eq(checkins.workspaceId, workspaceId), gte(checkins.date, start)))
    .orderBy(desc(checkins.date));

  return {
    workspaceId,
    days,
    checkins: rows.map(serializeCheckin),
  };
}

async function readConstraints(
  db: PlanningDb,
  workspaceId: string,
  args: {
    date_from?: string;
    date_to?: string;
  },
) {
  const range = readRange(args);
  const [courseRows, routineRows, blockSnapshot] = await Promise.all([
    db.select().from(courses).where(eq(courses.workspaceId, workspaceId)).orderBy(courses.createdAt),
    db.select().from(routines).where(eq(routines.workspaceId, workspaceId)).orderBy(routines.createdAt),
    loadEffectiveTimeBlocks(db, { workspaceId, rangeStart: range.start, rangeEnd: range.end }),
  ]);

  const serializedBlocks: Record<string, unknown>[] = blockSnapshot.occurrences.map(
    (block: Record<string, any>) => serializeDateFields(block),
  );
  return {
    workspaceId,
    filters: args,
    courses: courseRows.map(serializeDateFields),
    routines: routineRows.map(serializeDateFields),
    timeBlocks: serializedBlocks,
    protectedBlocks: serializedBlocks.filter((block) => block.protected !== false),
  };
}

async function readCapacity(
  db: PlanningDb,
  workspaceId: string,
  args: {
    date_from?: string;
    date_to?: string;
  },
) {
  const range = readRange(args);
  const planId = await getActivePlanId(db, workspaceId);
  if (!planId) throw new Error("No active plan");
  const [taskRows, blockSnapshot, routineRows, capacityRows] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.planId, planId),
        isNull(tasks.archivedAt),
        gte(tasks.date, range.start),
        lt(tasks.date, range.end),
      )),
    loadEffectiveTimeBlocks(db, { workspaceId, rangeStart: range.start, rangeEnd: range.end }),
    db.select().from(routines).where(eq(routines.workspaceId, workspaceId)),
    db
      .select()
      .from(dayCapacities)
      .where(and(eq(dayCapacities.workspaceId, workspaceId), gte(dayCapacities.date, range.start), lt(dayCapacities.date, range.end))),
  ]);

  return {
    workspaceId,
    filters: args,
    capacity: buildCapacityModel({
      dates: datesInRange(range.start, range.end),
      capacities: capacityRows,
      tasks: taskRows,
      timeBlocks: blockSnapshot.occurrences.map((block) => ({ ...block, recurrenceWeekdayMask: null })),
      routines: routineRows,
    }),
  };
}

async function readToday(db: PlanningDb, workspaceId: string) {
  const start = startOfShanghaiDay(new Date());
  const end = addDays(start, 1);
  const [taskContext, checkinContext] = await Promise.all([
    readTasks(db, workspaceId, {
      date_from: toDateKey(start),
      date_to: toDateKey(end),
    }),
    readCheckins(db, workspaceId, 1),
  ]);

  return {
    workspaceId,
    scope: "today",
    date: toDateKey(start),
    tasks: taskContext.tasks,
    checkins: checkinContext.checkins,
  };
}

async function readWeek(db: PlanningDb, workspaceId: string) {
  const today = startOfShanghaiDay(new Date());
  const shanghaiNoon = new Date(today.getTime() + 20 * 60 * 60 * 1000);
  const weekday = shanghaiNoon.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const start = addDays(today, mondayOffset);
  const end = addDays(start, 7);
  const taskContext = await readTasks(db, workspaceId, {
    date_from: toDateKey(start),
    date_to: toDateKey(end),
  });

  const groupedTasks = (taskContext.tasks as SerializedTask[]).reduce<Record<string, SerializedTask[]>>((groups, task) => {
    const key = task.date ? toDateKey(new Date(task.date)) : "undated";
    groups[key] = groups[key] ?? [];
    groups[key].push(task);
    return groups;
  }, {});

  return {
    workspaceId,
    scope: "week",
    date_from: toDateKey(start),
    date_to: toDateKey(end),
    groupedTasks,
  };
}

async function readMonth(
  db: PlanningDb,
  workspaceId: string,
  args: {
    date_from?: string;
    date_to?: string;
  },
) {
  const start = args.date_from ? parseDateBoundary(args.date_from) : startOfShanghaiDay(new Date());
  const end = args.date_to ? parseDateBoundary(args.date_to) : addDays(start, 31);
  const taskContext = await readTasks(db, workspaceId, {
    date_from: toDateKey(start),
    date_to: toDateKey(end),
  });

  const groupedTasks = (taskContext.tasks as SerializedTask[]).reduce<Record<string, SerializedTask[]>>((groups, task) => {
    const key = task.date ? toDateKey(new Date(task.date)) : "undated";
    groups[key] = groups[key] ?? [];
    groups[key].push(task);
    return groups;
  }, {});

  return {
    workspaceId,
    scope: "raw_month_task_range",
    note: "Current app has no full month planner contract; this is a real workspace-scoped task query grouped by date.",
    date_from: toDateKey(start),
    date_to: toDateKey(end),
    groupedTasks,
  };
}

async function readTaskSurfacesAfterCommit(db: PlanningDb, workspaceId: string) {
  const [today, week, month, active, todo, backlog, archived] = await Promise.all([
    readToday(db, workspaceId),
    readWeek(db, workspaceId),
    readMonth(db, workspaceId, {}),
    readTasks(db, workspaceId, { archive_state: "active" }),
    readTasks(db, workspaceId, { status: "todo", archive_state: "active" }),
    readTasks(db, workspaceId, { status: "backlog", archive_state: "active" }),
    readTasks(db, workspaceId, { archive_state: "archived" }),
  ]);
  const weekCount = Object.values(week.groupedTasks).reduce((sum, rows) => sum + rows.length, 0);
  const monthCount = Object.values(month.groupedTasks).reduce((sum, rows) => sum + rows.length, 0);
  return {
    today,
    week,
    month,
    counts: {
      active: active.tasks.length,
      todo: todo.tasks.length,
      backlog: backlog.tasks.length,
      archived: archived.tasks.length,
      today: today.tasks.length,
      week: weekCount,
      month: monthCount,
    },
    verifiedAt: new Date().toISOString(),
  };
}

function requireFeatureFlag(name: string, message: string) {
  if (process.env[name] !== "true") throw new Error(message);
}

function compactRebalanceError(error: unknown) {
  return {
    code: typeof error === "object" && error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "rebalance_failed",
    message: error instanceof Error ? error.message : "Rebalance failed",
  };
}

async function runRebalanceTool(
  db: PlanningDb,
  workspaceId: string,
  tool: "propose_daily_rebalance" | "propose_week_rebalance",
  mode: "today" | "week",
  kind: AgentRunKind,
  args: unknown,
) {
  const parsed = proposeRebalanceArgsSchema.parse(args);
  const planId = await getActivePlanId(db, workspaceId);
  if (!planId) throw new Error("No active plan");
  const createdBy = parsed.created_by ?? "codex";
  const idempotencyKey = parsed.idempotency_key;
  const moves = parsed.moves.map((move) => ({
    taskId: move.task_id,
    toDate: move.to_date,
    toDaySegment: move.to_day_segment,
    reason: move.reason,
  }));

  const run = await startAgentRun(db, {
    workspaceId,
    planId,
    kind,
    idempotencyKey,
    reason: parsed.reason,
    inputJson: {
      tool,
      mode,
      moveCount: moves.length,
      moves: moves.map((move) => ({
        taskId: move.taskId,
        toDate: move.toDate,
        toDaySegment: move.toDaySegment,
      })),
    },
    createdBy,
  });
  if (run.duplicate) return run.result;

  try {
    const proposal = await proposeRebalancePatch(db, {
      workspaceId,
      mode,
      reason: parsed.reason,
      moves,
      createdBy,
    });

    return completeAgentRun(db, {
      workspaceId,
      runId: run.runId,
      idempotencyKey,
      status: proposal.patchId && proposal.operationCount > 0 ? "draft_created" : "no_change",
      patchId: proposal.patchId,
      operationCount: proposal.operationCount,
      skipped: proposal.skipped,
      warnings: proposal.warnings,
    });
  } catch (error) {
    return failAgentRun(db, {
      workspaceId,
      runId: run.runId,
      idempotencyKey,
      error: compactRebalanceError(error),
    });
  }
}

export async function runPawPlanTool(
  db: PlanningDb,
  workspaceId: string,
  name: string,
  args: unknown = {},
  permission: McpPermission = "read_write",
): Promise<any> {
  if (!workspaceId) throw new Error("PAWPLAN_WORKSPACE_ID is required");
  if (!Object.hasOwn(pawPlanToolSchemas, name)) throw new Error(`Unknown PawPlan MCP tool: ${name}`);

  const toolName = name as PawPlanToolName;
  if (!canUsePawPlanTool(permission, toolName)) {
    throw new McpPermissionError(permission, toolName);
  }

  if (toolName === "get_agent_guidance") {
    pawPlanToolSchemas.get_agent_guidance.parse(args);
    return pawPlanAgentGuidance;
  }

  if (toolName === "get_mcp_usage") {
    pawPlanToolSchemas.get_mcp_usage.parse(args);
    const quota = await getHostedMcpUsageSnapshot(db, { workspaceId });
    return {
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining,
      reset_at: quota.resetAt.toISOString(),
    };
  }

  if (toolName === "get_today") {
    pawPlanToolSchemas.get_today.parse(args);
    return readToday(db, workspaceId);
  }
  if (toolName === "get_week") {
    pawPlanToolSchemas.get_week.parse(args);
    return readWeek(db, workspaceId);
  }
  if (toolName === "get_month") {
    const parsed = pawPlanToolSchemas.get_month.parse(args);
    return readMonth(db, workspaceId, parsed);
  }
  if (toolName === "get_constraints") {
    const parsed = pawPlanToolSchemas.get_constraints.parse(args);
    return readConstraints(db, workspaceId, parsed);
  }
  if (toolName === "get_capacity") {
    const parsed = pawPlanToolSchemas.get_capacity.parse(args);
    return readCapacity(db, workspaceId, parsed);
  }
  if (toolName === "get_decisions") {
    const parsed = pawPlanToolSchemas.get_decisions.parse(args);
    return getDecisionRecords(db, workspaceId, parsed);
  }
  if (toolName === "get_conversations") {
    const parsed = pawPlanToolSchemas.get_conversations.parse(args);
    return getConversationSummaries(db, workspaceId, {
      contextType: parsed.context_type,
      limit: parsed.limit,
    });
  }
  if (toolName === "get_checkins") {
    const parsed = pawPlanToolSchemas.get_checkins.parse(args);
    return readCheckins(db, workspaceId, parsed.days ?? 7);
  }
  if (toolName === "get_project_portfolio") {
    const parsed = pawPlanToolSchemas.get_project_portfolio.parse(args);
    return getProjectPortfolio(db, workspaceId, parsed);
  }
  if (toolName === "propose_project_portfolio_update") {
    const parsed = pawPlanToolSchemas.propose_project_portfolio_update.parse(args);
    return proposeProjectPortfolioUpdate(db, {
      workspaceId,
      update: portfolioUpdateInput(parsed.update),
      reason: parsed.reason,
    });
  }
  if (toolName === "apply_project_portfolio_update") {
    const parsed = pawPlanToolSchemas.apply_project_portfolio_update.parse(args);
    return applyProjectPortfolioUpdate(db, {
      workspaceId,
      update: portfolioUpdateInput(parsed.update),
      previewToken: parsed.preview_token,
      approvalId: parsed.approval_id,
      idempotencyKey: parsed.idempotency_key,
      source: "mcp",
    });
  }
  if (toolName === "get_tasks") {
    const parsed = pawPlanToolSchemas.get_tasks.parse(args);
    return readTasks(db, workspaceId, parsed);
  }
  if (toolName === "preview_task_batch") {
    const parsed = pawPlanToolSchemas.preview_task_batch.parse(args);
    if (parsed.action === "delete") {
      requireFeatureFlag("PAWPLAN_TASK_DELETE_ENABLED", "Permanent task deletion is disabled");
    } else {
      requireFeatureFlag("PAWPLAN_TASK_ARCHIVE_ENABLED", "Task archive and restore are disabled");
    }
    return previewTaskBatch(db, {
      workspaceId,
      action: parsed.action,
      filters: {
        statuses: parsed.filters.statuses,
        dateFrom: parsed.filters.date_from,
        dateTo: parsed.filters.date_to,
        projectIds: parsed.filters.project_ids,
        taskIds: parsed.filters.task_ids,
      },
      includeDone: parsed.include_done,
      allowDeleteUnarchived: parsed.allow_delete_unarchived,
    });
  }

  if (toolName === "create_inbox_item") {
    const parsed = pawPlanToolSchemas.create_inbox_item.parse(args);
    const item = await createInboxItem(db, {
      workspaceId,
      title: parsed.title,
      source: parsed.source ?? "manual",
      changeLogSource: "mcp",
    });

    return {
      item,
      audit: {
        source: "mcp",
        note: `Inbox item source recorded as ${item.source}.`,
      },
    };
  }

  if (toolName === "create_checkin") {
    const parsed = pawPlanToolSchemas.create_checkin.parse(args);
    const result = await createDailyCheckin(db, {
      workspaceId,
      date: parsed.date,
      completedText: parsed.completed_text,
      blockerText: parsed.blocker_text ?? "",
      nextText: parsed.next_text ?? "",
      source: "mcp",
    });

    return {
      ...result,
      date: result.date.toISOString(),
      source: "mcp",
    };
  }

  if (toolName === "update_task_status") {
    const parsed = pawPlanToolSchemas.update_task_status.parse(args);
    const task = await updateTaskStatus(db, {
      workspaceId,
      taskId: parsed.task_id,
      status: parsed.status,
      note: parsed.note,
      source: "mcp",
    });
    if (!task) throw new Error("Task not found");

    return {
      task,
      note: parsed.note
        ? {
            received: parsed.note,
            persisted: true,
          }
      : undefined,
    };
  }

  if (toolName === "update_task_schedule") {
    const parsed = pawPlanToolSchemas.update_task_schedule.parse(args);
    if (!parsed.date && !parsed.day_segment) throw new Error("date or day_segment is required");
    const task = await updateTaskSchedule(db, {
      workspaceId,
      taskId: parsed.task_id,
      status: parsed.status,
      blocked: parsed.blocked,
      date: parsed.date,
      daySegment: parsed.day_segment,
      source: "mcp",
    });
    if (!task) throw new Error("Task not found");

    return { task };
  }

  if (toolName === "update_task_notes") {
    const parsed = pawPlanToolSchemas.update_task_notes.parse(args);
    const task = await updateTaskNotes(db, {
      workspaceId,
      taskId: parsed.task_id,
      notes: parsed.notes,
      source: "mcp",
    });
    if (!task) throw new Error("Task not found");

    return { task };
  }

  if (toolName === "propose_task_notes_batch") {
    const parsed = pawPlanToolSchemas.propose_task_notes_batch.parse(args);
    return proposeTaskNotesBatch(db, {
      workspaceId,
      idempotencyKey: parsed.idempotency_key,
      reason: parsed.reason,
      operations: parsed.operations.map((operation) => ({
        taskId: operation.task_id,
        notes: operation.notes,
      })),
    });
  }

  if (toolName === "apply_task_notes_batch") {
    const parsed = pawPlanToolSchemas.apply_task_notes_batch.parse(args);
    return applyTaskNotesBatch(db, {
      workspaceId,
      approvalId: parsed.approval_id,
      previewToken: parsed.preview_token,
      idempotencyKey: parsed.idempotency_key,
    });
  }

  if (toolName === "update_tasks_batch") {
    const parsed = pawPlanToolSchemas.update_tasks_batch.parse(args);
    return updateTasksBatch(db, {
      workspaceId,
      idempotencyKey: parsed.idempotency_key,
      operations: parsed.operations.map((operation) => ({
        taskId: operation.task_id,
        status: operation.status,
        date: operation.date,
        daySegment: operation.day_segment,
        blocked: operation.blocked,
        expectedStatus: operation.expected_status,
        expectedDate: operation.expected_date,
        expectedDaySegment: operation.expected_day_segment,
        expectedBlocked: operation.expected_blocked,
      })),
    });
  }

  if (toolName === "archive_tasks_batch" || toolName === "restore_tasks_batch") {
    requireFeatureFlag("PAWPLAN_TASK_ARCHIVE_ENABLED", "Task archive and restore are disabled");
    const parsed = pawPlanToolSchemas[toolName].parse(args);
    const result = await applyTaskArchiveBatch(db, {
      workspaceId,
      action: toolName === "archive_tasks_batch" ? "archive" : "restore",
      previewToken: parsed.preview_token,
      approvalId: parsed.approval_id,
      confirmTaskCount: parsed.confirm_task_count,
      idempotencyKey: parsed.idempotency_key,
    });
    return attachTaskBatchPostCommitReadback(result, () => readTaskSurfacesAfterCommit(db, workspaceId));
  }

  if (toolName === "delete_tasks_batch") {
    requireFeatureFlag("PAWPLAN_TASK_DELETE_ENABLED", "Permanent task deletion is disabled");
    const parsed = pawPlanToolSchemas.delete_tasks_batch.parse(args);
    const result = await applyTaskArchiveBatch(db, {
      workspaceId,
      action: "delete",
      previewToken: parsed.preview_token,
      approvalId: parsed.approval_id,
      confirmTaskCount: parsed.confirm_task_count,
      confirmation: parsed.confirmation,
      idempotencyKey: parsed.idempotency_key,
      groupId: parsed.operation_id,
    });
    return attachTaskBatchPostCommitReadback(result, () => readTaskSurfacesAfterCommit(db, workspaceId));
  }

  if (toolName === "update_time_block_series") {
    requireFeatureFlag("PAWPLAN_TIME_BLOCK_SERIES_ENABLED", "Time block series editing is disabled");
    const parsed = pawPlanToolSchemas.update_time_block_series.parse(args);
    const request = {
      seriesId: parsed.series_id,
      scope: parsed.scope,
      occurrenceDate: parsed.occurrence_date,
      changes: {
        title: parsed.changes.title,
        kind: parsed.changes.kind,
        startTime: parsed.changes.start_time,
        endTime: parsed.changes.end_time,
        location: parsed.changes.location,
        weekdayMask: parsed.changes.weekday_mask,
        recurrenceLabel: parsed.changes.recurrence_label,
        protected: parsed.changes.protected,
        startsOn: parsed.changes.starts_on,
        endsOn: parsed.changes.ends_on,
      },
    };
    if (parsed.mode === "preview") {
      return previewTimeBlockSeriesMutation(db, { workspaceId, action: "update", request });
    }
    return applyTimeBlockSeriesMutation(db, {
      workspaceId,
      action: "update",
      request,
      previewToken: parsed.preview_token!,
      approvalId: parsed.approval_id,
      idempotencyKey: parsed.idempotency_key,
      source: "mcp",
    });
  }

  if (toolName === "delete_time_block_series") {
    requireFeatureFlag("PAWPLAN_TIME_BLOCK_SERIES_ENABLED", "Time block series editing is disabled");
    const parsed = pawPlanToolSchemas.delete_time_block_series.parse(args);
    const request = {
      seriesId: parsed.series_id,
      scope: parsed.scope,
      occurrenceDate: parsed.occurrence_date,
    };
    if (parsed.mode === "preview") {
      return previewTimeBlockSeriesMutation(db, { workspaceId, action: "delete", request });
    }
    return applyTimeBlockSeriesMutation(db, {
      workspaceId,
      action: "delete",
      request,
      previewToken: parsed.preview_token!,
      approvalId: parsed.approval_id,
      idempotencyKey: parsed.idempotency_key,
      source: "mcp",
    });
  }

  if (toolName === "replace_plan_window") {
    requireFeatureFlag("PAWPLAN_REPLACE_PLAN_WINDOW_ENABLED", "Plan-window replacement is disabled");
    const parsed = pawPlanToolSchemas.replace_plan_window.parse(args);
    const input = {
      workspaceId,
      dateFrom: parsed.date_from,
      dateTo: parsed.date_to,
      sourceKey: parsed.source_key,
      expectedPlanId: parsed.expected_plan_id,
      expectedCurrentVersionId: parsed.expected_current_version_id,
      retireScope: parsed.retire_scope,
      tasks: parsed.tasks.map((task) => ({
        externalTaskKey: task.external_task_key,
        title: task.title,
        projectId: task.project_id,
        milestoneId: task.milestone_id,
        parentExternalTaskKey: task.parent_external_task_key,
        notes: task.notes,
        date: task.date,
        daySegment: task.day_segment,
        estimatedMinutes: task.estimated_minutes,
        priority: task.priority,
        energyLevel: task.energy_level,
        movable: task.movable,
        blocked: task.blocked,
      })),
      weeklySummaries: parsed.weekly_summaries,
      monthlySummaries: parsed.monthly_summaries,
      focusProjectIds: parsed.focus_project_ids,
      idempotencyKey: parsed.idempotency_key,
      createdBy: parsed.created_by,
      previewToken: parsed.preview_token,
      approvalId: parsed.approval_id,
    };
    if (parsed.mode === "preview") return previewReplacePlanWindow(db, input);
    return replacePlanWindow(db, input);
  }

  if (toolName === "save_conversation_summary") {
    const parsed = pawPlanToolSchemas.save_conversation_summary.parse(args);
    return saveConversationSummary(db, {
      workspaceId,
      topic: parsed.topic,
      contextType: parsed.context_type,
      summary: parsed.summary,
      decisions: parsed.decisions,
      openQuestions: parsed.open_questions,
      createdBy: parsed.created_by,
    });
  }

  if (toolName === "record_decision") {
    const parsed = pawPlanToolSchemas.record_decision.parse(args);
    return recordDecision(db, {
      workspaceId,
      topic: parsed.topic,
      context: parsed.context,
      optionsConsidered: parsed.options_considered,
      chosen: parsed.chosen,
      rationale: parsed.rationale,
      tradeoffsAccepted: parsed.tradeoffs_accepted,
      status: parsed.status,
    });
  }

  if (toolName === "import_plan_bundle") {
    const parsed = pawPlanToolSchemas.import_plan_bundle.parse(args);
    return saveMcpPlanImport(db, {
      workspaceId,
      importKey: parsed.import_key,
      createdBy: parsed.created_by ?? "codex",
      sourceLabel: parsed.source_label,
      overallPlan: parsed.overall_plan,
      dailyTasks: parsed.daily_tasks.map((task) => ({
        title: task.title,
        date: task.date,
        daySegment: task.day_segment,
        estimatedMinutes: task.estimated_minutes,
        priority: task.priority,
        energyLevel: task.energy_level,
        notes: task.notes,
        projectName: task.project_name,
        trackName: task.track_name,
      })),
      weeklySummary: {
        weekStart: parsed.weekly_summary.week_start,
        focus: parsed.weekly_summary.focus,
        milestones: parsed.weekly_summary.milestones,
      },
      monthlySummary: parsed.monthly_summary,
    });
  }

  if (toolName === "propose_timetable_import") {
    const parsed = pawPlanToolSchemas.propose_timetable_import.parse(args);
    return proposeTimetableImport(db, workspaceId, parsed);
  }

  if (toolName === "propose_daily_rebalance") {
    return runRebalanceTool(db, workspaceId, "propose_daily_rebalance", "today", "morning_rebalance", args);
  }

  if (toolName === "propose_week_rebalance") {
    return runRebalanceTool(db, workspaceId, "propose_week_rebalance", "week", "weekly_rebalance", args);
  }

  const parsed = pawPlanToolSchemas.propose_patch.parse(args);
  const result = await proposeAgentPatch(db, {
    workspaceId,
    mode: parsed.mode,
    reason: parsed.reason,
    patch: parsed.patch,
    createdBy: parsed.created_by ?? "codex",
  });

  return {
    ...result,
    previewOnly: true,
  };
}
