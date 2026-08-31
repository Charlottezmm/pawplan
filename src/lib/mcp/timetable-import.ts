import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { agentPatches, timeBlocks } from "@/lib/db/schema";
import { parseTimetableCsv, type TimetableImportPreviewRow } from "@/lib/imports/timetable-csv";
import {
  buildTimetableRowsPreview,
  materializeTimetableRows,
  storedTimeBlockFingerprint,
  timetableBlockFingerprint,
  type MaterializedTimetableBlock,
} from "@/lib/imports/timetable-save";
import { getActivePlanId } from "@/lib/planning/active-plan";
import { expandRecurringBlocks } from "@/lib/planning/recurring-time-blocks";

type PlanningDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
};

const createdBySchema = z.enum(["codex", "claude", "user"]);
const singleWeekdaySchema = z
  .enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])
  .describe("Single weekday only. Use sun, mon, tue, wed, thu, fri, or sat. For multi-day recurrence, leave day_of_week null and set recurrence such as weekdays or mon-sat.");

export const mcpTimetableRowSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    kind: z.enum(["course", "exam", "meeting", "unavailable", "routine", "recovery"]),
    day_of_week: singleWeekdaySchema.optional().nullable(),
    start_time: z.string().trim().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().trim().regex(/^\d{2}:\d{2}$/),
    starts_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
    ends_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
    course: z.string().trim().max(120).optional().nullable(),
    location: z.string().trim().max(240).optional().nullable(),
    recurrence: z
      .string()
      .trim()
      .max(240)
      .optional()
      .nullable()
      .describe("Optional recurrence rule. Supports weekly, daily, weekdays, weekends, mon-sat, and localized equivalents like 每天, 工作日, 周一到周六."),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict();

export const proposeTimetableImportArgsSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    source_label: z.string().trim().max(120).optional(),
    created_by: createdBySchema.optional(),
    csv: z.string().min(1).max(200_000).optional(),
    rows: z.array(mcpTimetableRowSchema).min(1).max(200).optional(),
  })
  .strict();

export type ProposeTimetableImportArgs = z.infer<typeof proposeTimetableImportArgsSchema>;

function emptyToNull(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRows(args: ProposeTimetableImportArgs): TimetableImportPreviewRow[] {
  if (Boolean(args.csv) === Boolean(args.rows)) throw new Error("Provide exactly one of csv or rows");
  if (args.csv) return parseTimetableCsv(args.csv);
  return (args.rows ?? []).map((row) => ({
    title: row.title,
    kind: row.kind,
    dayOfWeek: emptyToNull(row.day_of_week),
    startTime: row.start_time,
    endTime: row.end_time,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    course: emptyToNull(row.course),
    location: emptyToNull(row.location),
    recurrence: emptyToNull(row.recurrence),
    notes: emptyToNull(row.notes),
  }));
}

function minDate(blocks: MaterializedTimetableBlock[]) {
  return new Date(Math.min(...blocks.map((block) => block.startsAt.getTime())));
}

function maxDate(blocks: MaterializedTimetableBlock[]) {
  return new Date(Math.max(...blocks.map((block) => block.endsAt.getTime())));
}

function blockOverlaps(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }) {
  return a.startsAt < b.endsAt && a.endsAt > b.startsAt;
}

function conflictLabel(block: MaterializedTimetableBlock, existing: Record<string, unknown>) {
  const existingTitle = typeof existing.title === "string" ? existing.title : "现有日程";
  return `${block.row.title} 与 ${existingTitle} 时间重叠`;
}

export async function inspectTimetableImportConflicts(
  db: PlanningDb,
  input: {
    workspaceId: string;
    blocks: MaterializedTimetableBlock[];
  },
) {
  const start = minDate(input.blocks);
  const end = maxDate(input.blocks);
  const existingRows = await db
    .select()
    .from(timeBlocks)
    .where(
      and(
        eq(timeBlocks.workspaceId, input.workspaceId),
        lt(timeBlocks.startsAt, end),
        gt(timeBlocks.endsAt, start),
      ),
    );

  const incomingWithFingerprints = input.blocks.map((block, index) => ({
    id: `incoming-${index}`,
    importFingerprint: timetableBlockFingerprint(block),
    ...block,
  }));
  const existingWithFingerprints = (existingRows as Array<any>).map((block) => ({
    ...block,
    importFingerprint: block.importFingerprint ?? storedTimeBlockFingerprint(block),
  }));
  const existingFingerprints = new Set(existingWithFingerprints.map((block) => block.importFingerprint));
  const incomingBlocks = expandRecurringBlocks(
    incomingWithFingerprints,
    start,
    end,
  );
  const existingBlocks = expandRecurringBlocks(existingWithFingerprints, start, end);
  const conflicts: string[] = [];
  const conflictFingerprints = new Set<string>();
  for (const block of incomingBlocks) {
    for (const existing of existingBlocks as Array<Record<string, unknown>>) {
      if (block.importFingerprint === existing.importFingerprint) continue;
      if (!(existing.startsAt instanceof Date) || !(existing.endsAt instanceof Date)) continue;
      if (blockOverlaps(block, { startsAt: existing.startsAt, endsAt: existing.endsAt })) {
        conflicts.push(conflictLabel(block, existing));
        conflictFingerprints.add(block.importFingerprint);
      }
    }
  }
  return {
    conflicts: [...new Set(conflicts)],
    existingFingerprints,
    conflictFingerprints,
  };
}

export async function findTimetableImportConflicts(
  db: PlanningDb,
  input: {
    workspaceId: string;
    blocks: MaterializedTimetableBlock[];
  },
) {
  return (await inspectTimetableImportConflicts(db, input)).conflicts;
}

export async function proposeTimetableImport(
  db: PlanningDb,
  workspaceId: string,
  args: ProposeTimetableImportArgs,
) {
  const planId = await getActivePlanId(db, workspaceId);
  if (!planId) throw new Error("No active plan");

  const rows = normalizeRows(args);
  const preview = buildTimetableRowsPreview(rows);
  const blocks = materializeTimetableRows(rows);
  const conflicts = [...preview.conflicts, ...(await findTimetableImportConflicts(db, { workspaceId, blocks }))];
  const patch = {
    operations: [
      {
        type: "import_timetable" as const,
        source_label: args.source_label,
        rows,
        reason: args.reason,
        protected_evidence: [...preview.warnings, ...conflicts],
      },
    ],
  };

  const [agentPatch] = await db
    .insert(agentPatches)
    .values({
      workspaceId,
      planId,
      scopeStart: minDate(blocks),
      scopeEnd: maxDate(blocks),
      reason: args.reason,
      patchJson: patch,
      createdBy: args.created_by ?? "codex",
    })
    .returning();

  return {
    patchId: agentPatch.id,
    workspaceId,
    planId,
    status: "draft" as const,
    previewOnly: true,
    rowsPreviewed: rows.length,
    blocksPreviewed: blocks.length,
    conflicts,
    review: {
      route: "/review",
      instruction: "Open Review and explicitly accept the timetable import operation to write constraints.",
    },
  };
}
