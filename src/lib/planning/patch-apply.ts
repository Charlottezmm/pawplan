import { and, desc, eq, inArray } from "drizzle-orm";
import { agentPatches, agentPatchReviews, changeLogs, plans, planVersions, tasks } from "@/lib/db/schema";
import { materializeTimetableRows, saveTimetableRowsInTransaction } from "@/lib/imports/timetable-save";
import { findTimetableImportConflicts } from "@/lib/mcp/timetable-import";
import { agentPatchSchema, type AgentPatch } from "@/lib/patches/patch-schema";
import { getActivePlanId } from "@/lib/planning/active-plan";

type PatchApplyDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

type ApplyAgentPatchInput = {
  workspaceId: string;
  patchId: string;
  acceptedOperationIndexes: number[];
  rejectedOperationIndexes?: number[];
};

type RejectReviewPatchesInput = {
  workspaceId: string;
  patchIds: string[];
};

type AppliedOperation = {
  index: number;
  type: AgentPatch["operations"][number]["type"];
  taskId?: string;
  action: string;
};

type SkippedOperation = {
  index: number;
  type: string;
  reason: string;
};

type ConflictOperation = SkippedOperation & {
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
};

export type ApplyAgentPatchResult = {
  patchId: string;
  planId: string;
  status: "applied" | "rejected" | "conflicted";
  acceptedOperationIndexes: number[];
  rejectedOperationIndexes: number[];
  applied: AppliedOperation[];
  skipped: SkippedOperation[];
  conflicts: ConflictOperation[];
};

export class PatchApplyError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type RejectReviewPatchesResult = {
  status: "succeeded" | "no_change";
  planId: string;
  requestedPatchCount: number;
  rejectedPatchCount: number;
  rejectedOperationCount: number;
  rejectedPatchIds: string[];
  remainingDraftCount: number;
};

function uniqueIndexes(indexes: number[]) {
  const normalized = [...new Set(indexes)];
  if (normalized.some((index) => !Number.isInteger(index) || index < 0)) {
    throw new PatchApplyError("Invalid accepted operation indexes", 400);
  }
  return normalized;
}

function uniquePatchIds(patchIds: string[]) {
  const normalized = [...new Set(patchIds)];
  if (normalized.length === 0) {
    throw new PatchApplyError("Select at least one Review draft to reject", 400);
  }
  return normalized;
}

export async function rejectReviewPatches(
  db: PatchApplyDb,
  input: RejectReviewPatchesInput,
): Promise<RejectReviewPatchesResult> {
  const patchIds = uniquePatchIds(input.patchIds);

  return db.transaction(async (tx) => {
    const planId = await getActivePlanId(tx, input.workspaceId);
    if (!planId) throw new PatchApplyError("No active plan", 400);

    // Claim only the drafts shown in the user's confirmation snapshot. A draft
    // created concurrently remains in Review and is reported by readback below.
    const rejectedPatches = await tx
      .update(agentPatches)
      .set({ status: "rejected" })
      .where(
        and(
          eq(agentPatches.workspaceId, input.workspaceId),
          eq(agentPatches.planId, planId),
          eq(agentPatches.status, "draft"),
          inArray(agentPatches.id, patchIds),
        ),
      )
      .returning({
        id: agentPatches.id,
        planId: agentPatches.planId,
        patchJson: agentPatches.patchJson,
      });

    const audits = rejectedPatches.map((patchRow: { id: string; planId: string; patchJson: unknown }) => {
      const patchJson = patchRow.patchJson;
      const operations =
        patchJson && typeof patchJson === "object" && Array.isArray((patchJson as { operations?: unknown }).operations)
          ? (patchJson as { operations: unknown[] }).operations
          : null;
      return {
        workspaceId: input.workspaceId,
        patchId: patchRow.id,
        planId: patchRow.planId,
        acceptedOperationIndexes: [],
        rejectedOperationIndexes: operations?.map((_, index) => index) ?? [],
        skippedJson: operations ? [] : [{ reason: "Draft operations were unavailable during rejection" }],
        conflictJson: [],
      };
    });

    if (audits.length > 0) {
      await tx.insert(agentPatchReviews).values(audits);
    }

    const remainingDrafts = await tx
      .select({ id: agentPatches.id })
      .from(agentPatches)
      .where(
        and(
          eq(agentPatches.workspaceId, input.workspaceId),
          eq(agentPatches.planId, planId),
          eq(agentPatches.status, "draft"),
        ),
      );

    return {
      status: rejectedPatches.length > 0 ? "succeeded" : "no_change",
      planId,
      requestedPatchCount: patchIds.length,
      rejectedPatchCount: rejectedPatches.length,
      rejectedOperationCount: audits.reduce(
        (total: number, audit: { rejectedOperationIndexes: number[] }) => total + audit.rejectedOperationIndexes.length,
        0,
      ),
      rejectedPatchIds: rejectedPatches.map((patch: { id: string }) => patch.id),
      remainingDraftCount: remainingDrafts.length,
    };
  });
}

function normalizeReviewIndexes(input: ApplyAgentPatchInput, operationCount: number) {
  const acceptedOperationIndexes = uniqueIndexes(input.acceptedOperationIndexes);
  const rejectedOperationIndexes = uniqueIndexes(input.rejectedOperationIndexes ?? []);
  if (acceptedOperationIndexes.length === 0 && rejectedOperationIndexes.length === 0) {
    throw new PatchApplyError("Select at least one operation to apply", 400);
  }

  const acceptedSet = new Set(acceptedOperationIndexes);
  if (rejectedOperationIndexes.some((index) => acceptedSet.has(index))) {
    throw new PatchApplyError("Operation indexes cannot be both accepted and rejected", 400);
  }
  if ([...acceptedOperationIndexes, ...rejectedOperationIndexes].some((index) => index >= operationCount)) {
    throw new PatchApplyError("Operation index not found", 400);
  }
  if (acceptedOperationIndexes.length === 0 && rejectedOperationIndexes.length !== operationCount) {
    throw new PatchApplyError("Reject all operations or accept at least one operation", 400);
  }
  return { acceptedOperationIndexes, rejectedOperationIndexes };
}

function dateFromDateKey(dateKey: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const date = new Date(`${dateKey}T00:00:00.000+08:00`);
  if (Number.isNaN(date.getTime()) || shanghaiDateKey(date) !== dateKey) return null;
  return date;
}

function shanghaiDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function dateKeyFromValue(value: unknown) {
  if (value instanceof Date) return shanghaiDateKey(value);
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return shanghaiDateKey(parsed);
    return value.slice(0, 10);
  }
  return null;
}

async function findTask(tx: any, workspaceId: string, planId: string, taskId: string) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId)))
    .limit(1);
  return task as Record<string, unknown> | undefined;
}

async function applyOperation(
  tx: any,
  workspaceId: string,
  planId: string,
  index: number,
  operation: AgentPatch["operations"][number],
) {
  const now = new Date();
  if (operation.protected_over_capacity && operation.type !== "move_to_backlog") {
    const reason = operation.protected_over_capacity_reason ?? "Target is protected over capacity";
    const conflict = {
      index,
      type: operation.type,
      reason,
      expected: { protectedOverCapacity: false },
      actual: { protectedOverCapacity: true },
    };
    return { skipped: { index, type: operation.type, reason }, conflict };
  }

  if (operation.type === "move_task") {
    const targetDate = dateFromDateKey(operation.to_date);
    if (!targetDate) {
      return { skipped: { index, type: operation.type, reason: "Invalid target date" } };
    }

    const currentTask = await findTask(tx, workspaceId, planId, operation.task_id);
    if (!currentTask) {
      return { skipped: { index, type: operation.type, reason: "Task not found" } };
    }
    const actualDate = dateKeyFromValue(currentTask.date);
    const actualSegment = typeof currentTask.daySegment === "string" ? currentTask.daySegment : null;
    if (actualDate !== operation.from_date || actualSegment !== operation.from_day_segment) {
      const conflict = {
        index,
        type: operation.type,
        reason: "Task changed since patch was proposed",
        expected: { date: operation.from_date, daySegment: operation.from_day_segment },
        actual: { date: actualDate, daySegment: actualSegment },
      };
      return { skipped: { index, type: operation.type, reason: conflict.reason }, conflict };
    }

    const updatedTasks = await tx
      .update(tasks)
      .set({ date: targetDate, daySegment: operation.to_day_segment, updatedAt: now })
      .where(and(eq(tasks.id, operation.task_id), eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId)))
      .returning();
    if (updatedTasks.length === 0) {
      return { skipped: { index, type: operation.type, reason: "Task not found" } };
    }
    return { applied: { index, type: operation.type, taskId: operation.task_id, action: "updated task date and segment" } };
  }

  if (operation.type === "defer_task") {
    const targetDate = dateFromDateKey(operation.target_week_or_date);
    const values = targetDate ? { date: targetDate, updatedAt: now } : { status: "backlog" as const, updatedAt: now };

    const updatedTasks = await tx
      .update(tasks)
      .set(values)
      .where(and(eq(tasks.id, operation.task_id), eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId)))
      .returning();
    if (updatedTasks.length === 0) {
      return { skipped: { index, type: operation.type, reason: "Task not found" } };
    }
    return {
      applied: {
        index,
        type: operation.type,
        taskId: operation.task_id,
        action: targetDate ? "updated task date" : "moved task to backlog",
      },
    };
  }

  if (operation.type === "move_to_backlog") {
    const updatedTasks = await tx
      .update(tasks)
      .set({ status: "backlog", updatedAt: now })
      .where(and(eq(tasks.id, operation.task_id), eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId)))
      .returning();
    if (updatedTasks.length === 0) {
      return { skipped: { index, type: operation.type, reason: "Task not found" } };
    }
    return { applied: { index, type: operation.type, taskId: operation.task_id, action: "moved task to backlog" } };
  }

  if (operation.type === "change_priority") {
    const currentTask = await findTask(tx, workspaceId, planId, operation.task_id);
    if (!currentTask) {
      return { skipped: { index, type: operation.type, reason: "Task not found" } };
    }
    const actualPriority = typeof currentTask.priority === "string" ? currentTask.priority : null;
    if (actualPriority !== operation.from_priority) {
      const conflict = {
        index,
        type: operation.type,
        reason: "Task priority changed since patch was proposed",
        expected: { priority: operation.from_priority },
        actual: { priority: actualPriority },
      };
      return { skipped: { index, type: operation.type, reason: conflict.reason }, conflict };
    }

    const updatedTasks = await tx
      .update(tasks)
      .set({ priority: operation.to_priority, updatedAt: now })
      .where(and(eq(tasks.id, operation.task_id), eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId)))
      .returning();
    if (updatedTasks.length === 0) {
      return { skipped: { index, type: operation.type, reason: "Task not found" } };
    }
    return { applied: { index, type: operation.type, taskId: operation.task_id, action: "updated task priority" } };
  }

  if (operation.type === "import_timetable") {
    const blocks = materializeTimetableRows(operation.rows);
    const overlaps = await findTimetableImportConflicts(tx, { workspaceId, blocks });
    if (overlaps.length > 0) {
      const reason = "Timetable import overlaps existing blocks";
      const conflict = {
        index,
        type: operation.type,
        reason,
        expected: { overlapCount: 0 },
        actual: { overlapCount: overlaps.length, overlaps: overlaps.slice(0, 10) },
      };
      return { skipped: { index, type: operation.type, reason }, conflict };
    }

    const result = await saveTimetableRowsInTransaction(tx, {
      workspaceId,
      planId,
      rows: operation.rows,
      sourceLabel: operation.source_label,
      writeChangeLog: false,
    });
    return {
      applied: {
        index,
        type: operation.type,
        action: `imported ${result.blocksCreated} timetable blocks`,
      },
    };
  }

  return { skipped: { index, type: operation.type, reason: "Unsupported operation for apply v0.1" } };
}

async function insertReviewAudit(
  tx: any,
  input: {
    workspaceId: string;
    patchId: string;
    planId: string;
    acceptedOperationIndexes: number[];
    rejectedOperationIndexes: number[];
    skipped: SkippedOperation[];
    conflicts: ConflictOperation[];
  },
) {
  await tx.insert(agentPatchReviews).values({
    workspaceId: input.workspaceId,
    patchId: input.patchId,
    planId: input.planId,
    acceptedOperationIndexes: input.acceptedOperationIndexes,
    rejectedOperationIndexes: input.rejectedOperationIndexes,
    skippedJson: input.skipped,
    conflictJson: input.conflicts,
  });
}

export async function applyAgentPatch(db: PatchApplyDb, input: ApplyAgentPatchInput): Promise<ApplyAgentPatchResult> {
  return db.transaction(async (tx) => {
    const [patchRow] = await tx
      .select()
      .from(agentPatches)
      .where(
        and(
          eq(agentPatches.id, input.patchId),
          eq(agentPatches.workspaceId, input.workspaceId),
          eq(agentPatches.status, "draft"),
        ),
      )
      .limit(1);

    if (!patchRow) {
      throw new PatchApplyError("Draft patch not found", 404);
    }

    const patch = agentPatchSchema.parse(patchRow.patchJson);
    const { acceptedOperationIndexes, rejectedOperationIndexes } = normalizeReviewIndexes(input, patch.operations.length);
    const applied: AppliedOperation[] = [];
    const skipped: SkippedOperation[] = [];
    const conflicts: ConflictOperation[] = [];

    if (acceptedOperationIndexes.length === 0) {
      await insertReviewAudit(tx, {
        workspaceId: input.workspaceId,
        patchId: input.patchId,
        planId: patchRow.planId,
        acceptedOperationIndexes,
        rejectedOperationIndexes,
        skipped,
        conflicts,
      });
      const rejectedPatchRows = await tx
        .update(agentPatches)
        .set({ status: "rejected" })
        .where(
          and(
            eq(agentPatches.id, input.patchId),
            eq(agentPatches.workspaceId, input.workspaceId),
            eq(agentPatches.status, "draft"),
          ),
        )
        .returning();
      if (rejectedPatchRows.length === 0) {
        throw new PatchApplyError("Draft patch not found", 404);
      }

      return {
        patchId: input.patchId,
        planId: patchRow.planId,
        status: "rejected",
        acceptedOperationIndexes,
        rejectedOperationIndexes,
        applied,
        skipped,
        conflicts,
      };
    }

    for (const index of acceptedOperationIndexes) {
      const operation = patch.operations[index];
      const result = await applyOperation(tx, input.workspaceId, patchRow.planId, index, operation);
      if (result.applied) applied.push(result.applied);
      if (result.skipped) skipped.push(result.skipped);
      if (result.conflict) conflicts.push(result.conflict);
    }

    if (applied.length === 0) {
      await insertReviewAudit(tx, {
        workspaceId: input.workspaceId,
        patchId: input.patchId,
        planId: patchRow.planId,
        acceptedOperationIndexes,
        rejectedOperationIndexes,
        skipped,
        conflicts,
      });
      return {
        patchId: input.patchId,
        planId: patchRow.planId,
        status: "conflicted",
        acceptedOperationIndexes,
        rejectedOperationIndexes,
        applied,
        skipped,
        conflicts,
      };
    }

    const snapshot = {
      kind: "agent_patch_apply_v0.1",
      patchId: input.patchId,
      acceptedOperationIndexes,
      rejectedOperationIndexes,
      applied,
      skipped,
      conflicts,
      appliedAt: new Date().toISOString(),
    };

    const [latestVersion] = await tx
      .select({ versionNumber: planVersions.versionNumber })
      .from(planVersions)
      .where(and(eq(planVersions.workspaceId, input.workspaceId), eq(planVersions.planId, patchRow.planId)))
      .orderBy(desc(planVersions.versionNumber))
      .limit(1);

    const [version] = await tx
      .insert(planVersions)
      .values({
        workspaceId: input.workspaceId,
        planId: patchRow.planId,
        versionNumber: (latestVersion?.versionNumber ?? 0) + 1,
        snapshot,
        source: "agent_patch",
      })
      .returning();

    await tx
      .update(plans)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(and(eq(plans.id, patchRow.planId), eq(plans.workspaceId, input.workspaceId)))
      .returning();

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId: patchRow.planId,
      source: "agent_patch",
      summary: `Applied ${applied.length} agent patch operation${applied.length === 1 ? "" : "s"}`,
      detailsJson: {
        patchId: input.patchId,
        acceptedOperationIndexes,
        rejectedOperationIndexes,
        applied,
        skipped,
        conflicts,
      },
    });

    await insertReviewAudit(tx, {
      workspaceId: input.workspaceId,
      patchId: input.patchId,
      planId: patchRow.planId,
      acceptedOperationIndexes,
      rejectedOperationIndexes,
      skipped,
      conflicts,
    });

    const appliedPatchRows = await tx
      .update(agentPatches)
      .set({ status: "applied", appliedAt: new Date() })
      .where(
        and(
          eq(agentPatches.id, input.patchId),
          eq(agentPatches.workspaceId, input.workspaceId),
          eq(agentPatches.status, "draft"),
        ),
      )
      .returning();
    if (appliedPatchRows.length === 0) {
      throw new PatchApplyError("Draft patch not found", 404);
    }

    return {
      patchId: input.patchId,
      planId: patchRow.planId,
      status: "applied",
      acceptedOperationIndexes,
      rejectedOperationIndexes,
      applied,
      skipped,
      conflicts,
    };
  });
}
