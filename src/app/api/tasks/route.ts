import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { tasks } from "@/lib/db/schema";
import { getActivePlanId } from "@/lib/planning/active-plan";
import { createChoreTask, PlanningServiceError, updateTaskNotes, updateTaskSchedule, updateTaskStatus } from "@/lib/planning/service";
import { readJsonBody } from "@/lib/validation/common";

const choreSchema = z.object({ title: z.string().trim().min(1).max(240) });

const taskUpdateSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["todo", "done", "backlog"]).optional(),
    blocked: z.boolean().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    daySegment: z.enum(["morning", "afternoon", "evening"]).optional(),
    estimatedMinutes: z.number().int().min(5).max(480).optional(),
    expectedEstimatedMinutes: z.number().int().min(5).max(480).optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((value) =>
    value.status ||
    value.blocked !== undefined ||
    value.date ||
    value.daySegment ||
    value.estimatedMinutes !== undefined ||
    value.notes,
  {
    message: "At least one task update field is required",
  })
  .refine((value) => !value.notes || (
    !value.status &&
    value.blocked === undefined &&
    !value.date &&
    !value.daySegment &&
    value.estimatedMinutes === undefined &&
    value.expectedEstimatedMinutes === undefined
  ), {
    message: "Task notes updates cannot be mixed with status or schedule updates",
  })
  .refine((value) => value.estimatedMinutes === undefined || value.expectedEstimatedMinutes !== undefined, {
    message: "expectedEstimatedMinutes is required when estimatedMinutes changes",
  });

export async function GET(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const taskId = new URL(request.url).searchParams.get("id");
  let taskIdValue: string | null = null;
  if (taskId) {
    const parsedTaskId = z.string().uuid().safeParse(taskId);
    if (!parsedTaskId.success) return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
    taskIdValue = parsedTaskId.data;
  }

  const db = getDb();
  const planId = await getActivePlanId(db, workspaceId);
  if (!planId) return NextResponse.json(taskId ? { error: "Task not found" } : { tasks: [] }, { status: taskId ? 404 : 200 });

  if (taskIdValue) {
    const [task] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.planId, planId),
          eq(tasks.id, taskIdValue),
          isNull(tasks.archivedAt),
        ),
      )
      .limit(1);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ task });
  }

  const items = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId), isNull(tasks.archivedAt)));
  return NextResponse.json({ tasks: items });
}

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = choreSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: "Invalid chore" }, { status: 400 });

  const db = getDb();
  try {
    const task = await createChoreTask(db, { workspaceId, title: parsed.data.title });
    return NextResponse.json({ task });
  } catch (error) {
    if (error instanceof PlanningServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function PATCH(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = taskUpdateSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: "Invalid task update" }, { status: 400 });

  const db = getDb();
  try {
    const hasScheduleUpdate =
      parsed.data.date !== undefined ||
      parsed.data.daySegment !== undefined ||
      parsed.data.estimatedMinutes !== undefined;
    if (parsed.data.notes) {
      const task = await updateTaskNotes(db, {
        workspaceId,
        taskId: parsed.data.id,
        notes: parsed.data.notes,
        source: "manual",
      });

      if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
      return NextResponse.json({ task });
    }

    const task = hasScheduleUpdate
      ? await updateTaskSchedule(db, {
          workspaceId,
          taskId: parsed.data.id,
          status: parsed.data.status,
          blocked: parsed.data.blocked,
          date: parsed.data.date,
          daySegment: parsed.data.daySegment,
          ...(parsed.data.estimatedMinutes === undefined
            ? {}
            : { estimatedMinutes: parsed.data.estimatedMinutes }),
          ...(parsed.data.expectedEstimatedMinutes === undefined
            ? {}
            : { expectedEstimatedMinutes: parsed.data.expectedEstimatedMinutes }),
          source: "manual",
        })
      : await updateTaskStatus(db, {
          workspaceId,
          taskId: parsed.data.id,
          status: parsed.data.status,
          blocked: parsed.data.blocked,
          source: "manual",
        });

    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (error) {
    if (error instanceof PlanningServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
