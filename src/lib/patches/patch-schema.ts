import { z } from "zod";

const daySegmentSchema = z.enum(["morning", "afternoon", "evening"]);
const prioritySchema = z.enum(["low", "normal", "high", "urgent"]);
const timetableKindSchema = z.enum(["course", "exam", "meeting", "unavailable", "routine", "recovery"]);
const evidenceFields = {
  protected_evidence: z.array(z.string()).optional(),
};

const moveTaskSchema = z.object({
  type: z.literal("move_task"),
  task_id: z.string(),
  from_date: z.string(),
  from_day_segment: daySegmentSchema,
  to_date: z.string(),
  to_day_segment: daySegmentSchema,
  reason: z.string(),
  overdue_rollover: z.boolean().optional(),
  expected_rollover_count: z.number().int().nonnegative().optional(),
  ...evidenceFields,
});

const splitTaskSchema = z.object({
  type: z.literal("split_task"),
  task_id: z.string(),
  new_tasks: z.array(
    z.object({
      title: z.string(),
      estimated_minutes: z.number().int().positive(),
      day_segment: daySegmentSchema,
    }),
  ),
  reason: z.string(),
  ...evidenceFields,
});

const deferTaskSchema = z.object({
  type: z.literal("defer_task"),
  task_id: z.string(),
  target_week_or_date: z.string(),
  reason: z.string(),
  ...evidenceFields,
});

const moveToBacklogSchema = z.object({
  type: z.literal("move_to_backlog"),
  task_id: z.string(),
  reason: z.string(),
  ...evidenceFields,
});

const changePrioritySchema = z.object({
  type: z.literal("change_priority"),
  task_id: z.string(),
  from_priority: prioritySchema,
  to_priority: prioritySchema,
  reason: z.string(),
  ...evidenceFields,
});

const suggestMilestoneChangeSchema = z.object({
  type: z.literal("suggest_milestone_change"),
  milestone_id: z.string(),
  proposed_text: z.string(),
  reason: z.string(),
  ...evidenceFields,
});

const timetableImportRowSchema = z.object({
  title: z.string().trim().min(1),
  kind: timetableKindSchema,
  dayOfWeek: z.string().trim().nullable(),
  startTime: z.string().trim().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().trim().regex(/^\d{2}:\d{2}$/),
  startsOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  course: z.string().trim().nullable(),
  location: z.string().trim().max(240).nullable().optional(),
  recurrence: z.string().trim().nullable(),
  notes: z.string().trim().nullable(),
});

const importTimetableSchema = z.object({
  type: z.literal("import_timetable"),
  source_label: z.string().trim().max(120).optional(),
  rows: z.array(timetableImportRowSchema).min(1).max(200),
  reason: z.string(),
  ...evidenceFields,
});

const moveProtectedBlockSchema = z.object({
  type: z.literal("move_protected_block"),
  block_id: z.string(),
  reason: z.string(),
});

export const agentPatchSchema = z.object({
  operations: z.array(
    z.union([
      moveTaskSchema,
      splitTaskSchema,
      deferTaskSchema,
      moveToBacklogSchema,
      changePrioritySchema,
      suggestMilestoneChangeSchema,
      importTimetableSchema,
    ]),
  ),
});

export type AgentPatch = z.infer<typeof agentPatchSchema>;

export function validatePatchAgainstProtectedBlocks(
  rawPatch: unknown,
  protectedBlockIds: string[],
): AgentPatch {
  const raw = z.object({ operations: z.array(z.unknown()) }).parse(rawPatch);

  for (const operation of raw.operations) {
    const parsed = moveProtectedBlockSchema.safeParse(operation);
    if (parsed.success && protectedBlockIds.includes(parsed.data.block_id)) {
      throw new Error("Agent patch cannot modify routine or recovery blocks");
    }
    if (typeof operation === "object" && operation !== null && !Array.isArray(operation)) {
      const record = operation as Record<string, unknown>;
      const protectedBlockId = record.protected_block_id;
      if (typeof protectedBlockId === "string" && protectedBlockIds.includes(protectedBlockId)) {
        throw new Error("Agent patch cannot modify routine or recovery blocks");
      }
      const protectedBlockIdsValue = record.protected_block_ids;
      if (
        Array.isArray(protectedBlockIdsValue) &&
        protectedBlockIdsValue.some((id) => typeof id === "string" && protectedBlockIds.includes(id))
      ) {
        throw new Error("Agent patch cannot modify routine or recovery blocks");
      }
    }
  }

  return agentPatchSchema.parse(rawPatch);
}
