import { and, eq, isNull } from "drizzle-orm";
import { agentPatches, changeLogs, checkins, inboxItems, routines, tasks, timeBlocks } from "@/lib/db/schema";
import { validatePatchAgainstProtectedBlocks, type AgentPatch } from "@/lib/patches/patch-schema";
import {
  applyAgentPatch as applyReviewPatch,
  PatchApplyError,
  rejectReviewPatches,
} from "@/lib/planning/patch-apply";
import { getActivePlanId } from "@/lib/planning/active-plan";

type PlanningDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

type ChangeSource = "manual" | "mcp";
type TaskStatus = "todo" | "done" | "skipped" | "backlog";
type DaySegment = "morning" | "afternoon" | "evening";
type TaskPriority = "low" | "normal" | "high" | "urgent";
type RoutineTimeSegment = "morning" | "afternoon" | "evening" | "specific_window";
type InboxSource = "manual" | "imported";
type PatchMode = "today" | "week";
type PatchCreatedBy = "claude" | "codex" | "user";
const shanghaiTimeZone = "Asia/Shanghai";

type ProcessInboxInput =
  | {
      workspaceId: string;
      inboxItemId: string;
      action: "delete";
    }
  | {
      workspaceId: string;
      inboxItemId: string;
      action: "task";
      date: string;
      daySegment: DaySegment;
      estimatedMinutes: number;
      priority?: TaskPriority;
    }
  | {
      workspaceId: string;
      inboxItemId: string;
      action: "quick_chore_task";
      date?: string;
      daySegment?: DaySegment;
    }
  | {
      workspaceId: string;
      inboxItemId: string;
      action: "routine";
      weekdayPattern: string;
      defaultTimeSegment: RoutineTimeSegment;
      estimatedMinutes: number;
    };

export { applyReviewPatch, PatchApplyError, rejectReviewPatches };
export { getActivePlanId } from "@/lib/planning/active-plan";

export class PlanningServiceError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function shanghaiDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: shanghaiTimeZone,
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

function shanghaiDateKey(date: Date) {
  const { year, month, day } = shanghaiDateParts(date);
  if (!year || !month || !day) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function dateFromDateKey(dateKey: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const date = new Date(`${dateKey}T00:00:00.000+08:00`);
  if (Number.isNaN(date.getTime()) || shanghaiDateKey(date) !== dateKey) return null;
  return date;
}

function currentShanghaiSegment(date = new Date()): DaySegment {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: shanghaiTimeZone,
      hour: "2-digit",
      hour12: false,
    }).format(date),
  );
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function normalizeCheckinDate(date?: Date | string) {
  if (!date) return startOfShanghaiDay(new Date());
  if (date instanceof Date) return date;

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000+08:00`) : new Date(date);
  if (Number.isNaN(parsed.getTime())) throw new PlanningServiceError("Invalid check-in date", 400);
  return parsed;
}

async function requireActivePlanId(db: PlanningDb, workspaceId: string) {
  const planId = await getActivePlanId(db, workspaceId);
  if (!planId) throw new PlanningServiceError("No active plan", 400);
  return planId;
}

async function getProtectedBlockIds(db: PlanningDb, workspaceId: string) {
  const rows = await db
    .select({ id: timeBlocks.id })
    .from(timeBlocks)
    .where(
      and(
        eq(timeBlocks.workspaceId, workspaceId),
        eq(timeBlocks.protected, true),
      ),
    );

  return rows.map((row: { id: string }) => row.id);
}

export async function updateTaskStatus(
  db: PlanningDb,
  input: {
    workspaceId: string;
    taskId: string;
    status?: TaskStatus;
    blocked?: boolean;
    note?: string;
    source?: ChangeSource;
  },
) {
  if (!input.status && input.blocked === undefined) {
    throw new PlanningServiceError("Task status update required", 400);
  }

  const values: { status?: TaskStatus; blocked?: boolean; updatedAt: Date } = { updatedAt: new Date() };
  const detailsJson: { taskId: string; status?: TaskStatus; blocked?: boolean; note?: string } = {
    taskId: input.taskId,
  };
  if (input.status) {
    values.status = input.status;
    detailsJson.status = input.status;
  }
  if (input.blocked !== undefined) {
    values.blocked = input.blocked;
    detailsJson.blocked = input.blocked;
  }
  if (input.note?.trim()) detailsJson.note = input.note.trim();

  return db.transaction(async (tx) => {
    const [task] = await tx
      .update(tasks)
      .set(values)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, input.workspaceId), isNull(tasks.archivedAt)))
      .returning();

    if (!task) return null;

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId: task.planId,
      source: input.source ?? "manual",
      summary: input.status ? `Updated task status to ${input.status}` : "Updated task blocked state",
      detailsJson,
    });

    return task;
  });
}

export async function updateTaskSchedule(
  db: PlanningDb,
  input: {
    workspaceId: string;
    taskId: string;
    status?: TaskStatus;
    blocked?: boolean;
    date?: string;
    daySegment?: DaySegment;
    source?: ChangeSource;
  },
) {
  if (!input.date && !input.daySegment) throw new PlanningServiceError("Task schedule update required", 400);

  const values: { status?: TaskStatus; blocked?: boolean; date?: Date; daySegment?: DaySegment; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  const detailsJson: { taskId: string; status?: TaskStatus; blocked?: boolean; date?: string; daySegment?: DaySegment } = {
    taskId: input.taskId,
  };

  if (input.status) {
    values.status = input.status;
    detailsJson.status = input.status;
  }

  if (input.blocked !== undefined) {
    values.blocked = input.blocked;
    detailsJson.blocked = input.blocked;
  }

  if (input.date) {
    const date = dateFromDateKey(input.date);
    if (!date) throw new PlanningServiceError("Invalid task date", 400);
    values.date = date;
    detailsJson.date = input.date;
  }

  if (input.daySegment) {
    values.daySegment = input.daySegment;
    detailsJson.daySegment = input.daySegment;
  }

  return db.transaction(async (tx) => {
    const [task] = await tx
      .update(tasks)
      .set(values)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, input.workspaceId), isNull(tasks.archivedAt)))
      .returning();

    if (!task) return null;

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId: task.planId,
      source: input.source ?? "manual",
      summary: "Updated task schedule",
      detailsJson,
    });

    return task;
  });
}

export async function updateTaskNotes(
  db: PlanningDb,
  input: {
    workspaceId: string;
    taskId: string;
    notes: string;
    source?: ChangeSource;
  },
) {
  const notes = input.notes.trim();
  if (!notes) throw new PlanningServiceError("Task notes update required", 400);

  return db.transaction(async (tx) => {
    const [task] = await tx
      .update(tasks)
      .set({ notes, updatedAt: new Date() })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, input.workspaceId), isNull(tasks.archivedAt)))
      .returning();

    if (!task) return null;

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId: task.planId,
      source: input.source ?? "manual",
      summary: "Updated task notes",
      detailsJson: {
        taskId: input.taskId,
        notes,
      },
    });

    return task;
  });
}

export async function createDailyCheckin(
  db: PlanningDb,
  input: {
    workspaceId: string;
    date?: Date | string;
    completedText: string;
    blockerText: string;
    nextText: string;
    source?: ChangeSource;
  },
) {
  return db.transaction(async (tx) => {
    const planId = await requireActivePlanId(tx, input.workspaceId);
    const date = normalizeCheckinDate(input.date);
    const now = new Date();

    await tx
      .insert(checkins)
      .values({
        workspaceId: input.workspaceId,
        planId,
        date,
        completedText: input.completedText,
        blockerText: input.blockerText,
        nextText: input.nextText,
      })
      .onConflictDoUpdate({
        target: [checkins.workspaceId, checkins.date],
        set: {
          completedText: input.completedText,
          blockerText: input.blockerText,
          nextText: input.nextText,
          updatedAt: now,
        },
      });

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId,
      source: input.source ?? "manual",
      summary: "Updated daily check-in",
      detailsJson: {
        date: date.toISOString(),
      },
    });

    return { planId, date };
  });
}

export async function createInboxItem(
  db: PlanningDb,
  input: {
    workspaceId: string;
    title: string;
    source?: InboxSource;
    changeLogSource?: ChangeSource;
  },
) {
  if (input.source && input.source !== "manual" && input.source !== "imported") {
    throw new PlanningServiceError("Invalid inbox source", 400);
  }
  const source = input.source ?? "manual";

  if (!input.changeLogSource) {
    const [item] = await db
      .insert(inboxItems)
      .values({ workspaceId: input.workspaceId, title: input.title, source })
      .returning();
    return item;
  }

  return db.transaction(async (tx) => {
    const [item] = await tx
      .insert(inboxItems)
      .values({ workspaceId: input.workspaceId, title: input.title, source })
      .returning();
    const planId = await getActivePlanId(tx, input.workspaceId);

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId,
      source: input.changeLogSource ?? "manual",
      summary: "Created inbox item through MCP",
      detailsJson: {
        inboxItemId: item.id,
        title: input.title,
        inboxSource: source,
      },
    });

    return item;
  });
}

export async function processInboxItem(
  db: PlanningDb,
  input: ProcessInboxInput,
) {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.id, input.inboxItemId),
          eq(inboxItems.workspaceId, input.workspaceId),
          isNull(inboxItems.processedAt),
        ),
      )
      .limit(1);

    if (!item) throw new PlanningServiceError("Inbox item not found", 404);

    if (input.action === "delete") {
      await tx
        .delete(inboxItems)
        .where(and(eq(inboxItems.id, item.id), eq(inboxItems.workspaceId, input.workspaceId)));
      return { ok: true, action: "delete" as const };
    }

    if (input.action === "task") {
      const planId = await requireActivePlanId(tx, input.workspaceId);
      const date = dateFromDateKey(input.date);
      if (!date) throw new PlanningServiceError("Invalid task date", 400);
      await tx.insert(tasks).values({
        workspaceId: input.workspaceId,
        planId,
        title: item.title,
        date,
        originalDate: date,
        daySegment: input.daySegment,
        estimatedMinutes: input.estimatedMinutes,
        energyLevel: "medium",
        priority: input.priority ?? "normal",
        status: "todo",
      });
    }

    if (input.action === "quick_chore_task") {
      const planId = await requireActivePlanId(tx, input.workspaceId);
      const date = input.date ? dateFromDateKey(input.date) : startOfShanghaiDay(new Date());
      if (!date) throw new PlanningServiceError("Invalid task date", 400);
      await tx.insert(tasks).values({
        workspaceId: input.workspaceId,
        planId,
        title: item.title,
        date,
        originalDate: date,
        daySegment: input.daySegment ?? "morning",
        estimatedMinutes: 15,
        energyLevel: "medium",
        priority: "normal",
        status: "todo",
        isChore: true,
      });
    }

    if (input.action === "routine") {
      await tx.insert(routines).values({
        workspaceId: input.workspaceId,
        title: item.title,
        defaultTimeSegment: input.defaultTimeSegment,
        weekdayPattern: input.weekdayPattern,
        estimatedMinutes: input.estimatedMinutes,
        energyLevel: "low",
      });
    }

    await tx
      .update(inboxItems)
      .set({ processedAt: new Date() })
      .where(and(eq(inboxItems.id, item.id), eq(inboxItems.workspaceId, input.workspaceId)));

    return { ok: true, action: input.action };
  });
}

export async function createChoreTask(
  db: PlanningDb,
  input: { workspaceId: string; title: string },
) {
  const planId = await requireActivePlanId(db, input.workspaceId);
  const date = startOfShanghaiDay(new Date());
  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId: input.workspaceId,
      planId,
      title: input.title,
      date,
      originalDate: date,
      daySegment: currentShanghaiSegment(),
      estimatedMinutes: 15,
      energyLevel: "medium",
      priority: "normal",
      status: "todo",
      isChore: true,
    })
    .returning();
  return task;
}

export async function proposeAgentPatch(
  db: PlanningDb,
  input: {
    workspaceId: string;
    mode: PatchMode;
    reason: string;
    patch: unknown;
    createdBy: PatchCreatedBy;
    scopeStart?: Date;
    scopeEnd?: Date;
  },
) {
  const planId = await requireActivePlanId(db, input.workspaceId);
  const protectedBlockIds = await getProtectedBlockIds(db, input.workspaceId);
  const patchPayload = typeof input.patch === "string" ? parsePatchJson(input.patch) : input.patch;
  const patch: AgentPatch = validatePatchAgainstProtectedBlocks(patchPayload, protectedBlockIds);
  const scopeStart = input.scopeStart ?? startOfToday();
  const scopeEnd = input.scopeEnd ?? (input.mode === "today" ? addDays(scopeStart, 1) : addDays(scopeStart, 7));
  if (scopeEnd <= scopeStart) throw new PlanningServiceError("Invalid agent patch scope", 400);
  const [agentPatch] = await db
    .insert(agentPatches)
    .values({
      workspaceId: input.workspaceId,
      planId,
      scopeStart,
      scopeEnd,
      reason: input.reason,
      patchJson: patch,
      createdBy: input.createdBy,
    })
    .returning();

  return {
    patchId: agentPatch.id,
    workspaceId: input.workspaceId,
    planId,
    mode: input.mode,
    reason: input.reason,
    patch,
    createdBy: input.createdBy,
    status: "draft" as const,
  };
}

function parsePatchJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new PlanningServiceError("Invalid agent patch JSON", 400);
  }
}
