import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import {
  moveLegacySkippedTaskToBacklog,
  rescheduleBacklogTask,
  restoreArchivedTaskToBacklog,
  TaskTransitionError,
} from "@/lib/planning/task-transitions";
import { readJsonBody } from "@/lib/validation/common";

const idempotencyKeySchema = z.string().trim().min(8).max(200);

const taskTransitionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reschedule_backlog"),
    taskId: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    daySegment: z.enum(["morning", "afternoon", "evening"]).optional(),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  z.object({
    action: z.literal("restore_archived_to_backlog"),
    taskId: z.string().uuid(),
    expectedArchived: z.literal(true),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  z.object({
    action: z.literal("move_legacy_skipped_to_backlog"),
    taskId: z.string().uuid(),
    expectedStatus: z.literal("skipped"),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
]);

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });

  const parsed = taskTransitionSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      { status: "failed", error: { code: "invalid_request", message: "Invalid task transition" } },
      { status: 400 },
    );
  }

  const db = getDb();
  try {
    const result = parsed.data.action === "reschedule_backlog"
      ? await rescheduleBacklogTask(db, { workspaceId, ...parsed.data })
      : parsed.data.action === "restore_archived_to_backlog"
        ? await restoreArchivedTaskToBacklog(db, { workspaceId, ...parsed.data })
        : await moveLegacySkippedTaskToBacklog(db, { workspaceId, ...parsed.data });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TaskTransitionError) {
      return NextResponse.json(
        { status: "failed", error: { code: error.code, message: error.message, details: error.details } },
        { status: error.status },
      );
    }
    throw error;
  }
}
