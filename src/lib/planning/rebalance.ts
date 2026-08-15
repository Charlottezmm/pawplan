import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AgentRunWarning } from "@/lib/agent-runs/types";
import { tasks } from "@/lib/db/schema";
import { PlanningServiceError, proposeAgentPatch } from "@/lib/planning/service";

export type PlanningDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

type DaySegment = "morning" | "afternoon" | "evening";
type TaskStatus = "todo" | "done" | "skipped" | "backlog";

type RebalanceTaskRow = {
  id: string;
  date: Date | string;
  daySegment: DaySegment;
  status: TaskStatus;
  movable: boolean;
};

export type RebalanceMoveInput = {
  taskId: string;
  toDate: string;
  toDaySegment: DaySegment;
  reason: string;
};

const shanghaiTimeZone = "Asia/Shanghai";

function shanghaiDateKey(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: shanghaiTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function isShanghaiDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000+08:00`);
  return !Number.isNaN(date.getTime()) && shanghaiDateKey(date) === value;
}

function skipped(taskId: string, code: string, message: string): AgentRunWarning {
  return { taskId, code, message };
}

export async function proposeRebalancePatch(
  db: PlanningDb,
  input: {
    workspaceId: string;
    mode: "today" | "week";
    reason: string;
    moves: RebalanceMoveInput[];
    createdBy: "codex" | "claude" | "user";
  },
): Promise<{
  patchId?: string;
  operationCount: number;
  skipped: AgentRunWarning[];
  warnings: AgentRunWarning[];
}> {
  for (const move of input.moves) {
    if (!isShanghaiDateKey(move.toDate)) {
      throw new PlanningServiceError("Invalid rebalance target date", 400);
    }
  }

  const taskIds = Array.from(new Set(input.moves.map((move) => move.taskId)));
  const taskRows: RebalanceTaskRow[] =
    taskIds.length === 0
      ? []
      : await db
          .select({
            id: tasks.id,
            date: tasks.date,
            daySegment: tasks.daySegment,
            status: tasks.status,
            movable: tasks.movable,
          })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, input.workspaceId), inArray(tasks.id, taskIds), isNull(tasks.archivedAt)));
  const tasksById = new Map(taskRows.map((task) => [task.id, task]));
  const skippedMoves: AgentRunWarning[] = [];
  const operations = [];

  for (const move of input.moves) {
    const task = tasksById.get(move.taskId);
    if (!task) {
      skippedMoves.push(skipped(move.taskId, "task_not_found", `Task ${move.taskId} was not found.`));
      continue;
    }

    if (task.status === "done" || task.status === "skipped") {
      skippedMoves.push(
        skipped(move.taskId, "task_not_movable_status", `Task ${move.taskId} has status ${task.status}.`),
      );
      continue;
    }

    if (task.movable === false) {
      skippedMoves.push(skipped(move.taskId, "task_not_movable", `Task ${move.taskId} is not movable.`));
      continue;
    }

    const fromDate = shanghaiDateKey(task.date);
    if (fromDate === move.toDate && task.daySegment === move.toDaySegment) {
      skippedMoves.push(skipped(move.taskId, "move_is_noop", `Task ${move.taskId} is already in that slot.`));
      continue;
    }

    operations.push({
      type: "move_task" as const,
      task_id: task.id,
      from_date: fromDate,
      from_day_segment: task.daySegment,
      to_date: move.toDate,
      to_day_segment: move.toDaySegment,
      reason: move.reason,
    });
  }

  if (operations.length === 0) {
    return { operationCount: 0, skipped: skippedMoves, warnings: [] };
  }

  const patch = await proposeAgentPatch(db, {
    workspaceId: input.workspaceId,
    mode: input.mode,
    reason: input.reason,
    patch: { operations },
    createdBy: input.createdBy,
  });

  return {
    patchId: patch.patchId,
    operationCount: operations.length,
    skipped: skippedMoves,
    warnings: [],
  };
}
