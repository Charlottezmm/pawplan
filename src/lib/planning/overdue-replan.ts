import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import {
  dayCapacities,
  plans,
  projectMilestones,
  projects,
  routines,
  segmentEnergySettings,
  tasks,
} from "@/lib/db/schema";
import { type AgentRunWarning } from "@/lib/agent-runs/types";
import {
  buildCapacityModel,
  capacityDateKey,
  startOfShanghaiCapacityDay,
  type CapacitySegment,
} from "@/lib/planning/capacity-model";
import { proposeAgentPatch } from "@/lib/planning/service";
import { loadEffectiveTimeBlocks } from "@/lib/planning/effective-time-blocks";

type PlanningDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

type Priority = "low" | "normal" | "high" | "urgent";
type EnergyLevel = "low" | "medium" | "high";
type DaySegment = "morning" | "afternoon" | "evening";

type TaskRow = {
  id: string;
  workspaceId: string;
  planId: string;
  projectId: string | null;
  milestoneId: string | null;
  title: string;
  date: Date;
  daySegment: DaySegment;
  status: "todo" | "done" | "skipped" | "backlog";
  blocked: boolean;
  movable: boolean;
  estimatedMinutes: number;
  energyLevel: EnergyLevel;
  priority: Priority;
  rolloverCount: number;
  originalDate: Date | null;
};

type ProjectRow = {
  id: string;
  name: string;
  category: string | null;
  objective: string | null;
  successCriteria: string | null;
  status: "active" | "paused" | "completed" | "archived";
  priority: Priority;
  targetDate: Date | null;
  needsDefinition: boolean;
};

type MilestoneRow = {
  id: string;
  projectId: string;
  title: string;
  status: "planned" | "in_progress" | "completed" | "skipped";
  targetDate: Date | null;
};

export type OverdueReplanDecision = AgentRunWarning & {
  title?: string;
  projectId?: string | null;
  projectName?: string | null;
  milestoneId?: string | null;
  milestoneTitle?: string | null;
  currentDate?: string;
  originalDate?: string | null;
  rolloverCount?: number;
};

export type OverdueReplanResult = {
  patchId?: string;
  operationCount: number;
  skipped: AgentRunWarning[];
  warnings: AgentRunWarning[];
  needsDecision: OverdueReplanDecision[];
};

export class OverdueReplanError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const segments: DaySegment[] = ["morning", "afternoon", "evening"];
const priorityRank: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const fallbackEnergySegment: Record<EnergyLevel, DaySegment> = {
  high: "morning",
  medium: "afternoon",
  low: "evening",
};

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000+08:00`);
  if (Number.isNaN(date.getTime()) || capacityDateKey(date) !== value) return null;
  return startOfShanghaiCapacityDay(date);
}

function datesInRange(start: Date, endExclusive: Date) {
  const dates: Date[] = [];
  for (let cursor = start; cursor < endExclusive; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

function minDate(...values: Array<Date | null | undefined>) {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function decision(
  task: TaskRow,
  code: string,
  message: string,
  project?: ProjectRow,
  milestone?: MilestoneRow,
): OverdueReplanDecision {
  return {
    taskId: task.id,
    code,
    message,
    title: task.title,
    projectId: project?.id ?? task.projectId,
    projectName: project?.name ?? null,
    milestoneId: milestone?.id ?? task.milestoneId,
    milestoneTitle: milestone?.title ?? null,
    currentDate: capacityDateKey(task.date),
    originalDate: task.originalDate ? capacityDateKey(task.originalDate) : null,
    rolloverCount: task.rolloverCount,
  };
}

function segmentOrderForTask(
  task: TaskRow,
  segmentEnergy: Partial<Record<DaySegment, EnergyLevel>>,
) {
  const matching = segments.find((segment) => segmentEnergy[segment] === task.energyLevel)
    ?? fallbackEnergySegment[task.energyLevel];
  return [task.daySegment, matching, ...segments].filter(
    (segment, index, all): segment is DaySegment => all.indexOf(segment) === index,
  );
}

export async function proposeOverdueReplan(
  db: PlanningDb,
  input: {
    workspaceId: string;
    asOfDate: string;
    taskIds: string[];
    reason: string;
    createdBy: "codex" | "claude" | "user";
    now?: Date;
  },
): Promise<OverdueReplanResult> {
  const asOf = parseDateKey(input.asOfDate);
  if (!asOf) throw new OverdueReplanError("date_source_conflict", "Invalid overdue replan as_of_date");
  const currentDateKey = capacityDateKey(input.now ?? new Date());
  if (input.asOfDate !== currentDateKey) {
    throw new OverdueReplanError(
      "date_source_conflict",
      `as_of_date ${input.asOfDate} does not match current Shanghai date ${currentDateKey}`,
    );
  }

  const requestedTaskIds = Array.from(new Set(input.taskIds));
  const [plan] = await db
    .select({ id: plans.id, endDate: plans.endDate })
    .from(plans)
    .where(and(eq(plans.workspaceId, input.workspaceId), eq(plans.status, "active")))
    .limit(1);
  if (!plan) throw new Error("No active plan");

  const taskRows: TaskRow[] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, input.workspaceId),
        eq(tasks.planId, plan.id),
        isNull(tasks.archivedAt),
        inArray(tasks.id, requestedTaskIds),
      ),
    );
  const tasksById = new Map(taskRows.map((task) => [task.id, task]));
  const skipped: AgentRunWarning[] = requestedTaskIds
    .filter((taskId) => !tasksById.has(taskId))
    .map((taskId) => ({ taskId, code: "task_not_found", message: `Task ${taskId} was not found.` }));

  const projectIds = Array.from(new Set(taskRows.flatMap((task) => task.projectId ? [task.projectId] : [])));
  const milestoneIds = Array.from(new Set(taskRows.flatMap((task) => task.milestoneId ? [task.milestoneId] : [])));
  const projectRows: ProjectRow[] = projectIds.length === 0
    ? []
    : await db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, input.workspaceId), inArray(projects.id, projectIds)));
  const milestoneRows: MilestoneRow[] = milestoneIds.length === 0
    ? []
    : await db
        .select()
        .from(projectMilestones)
        .where(and(eq(projectMilestones.workspaceId, input.workspaceId), inArray(projectMilestones.id, milestoneIds)));
  const projectsById = new Map(projectRows.map((project) => [project.id, project]));
  const milestonesById = new Map(milestoneRows.map((milestone) => [milestone.id, milestone]));
  const needsDecision: OverdueReplanDecision[] = [];
  const candidates: TaskRow[] = [];

  for (const taskId of requestedTaskIds) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    const project = task.projectId ? projectsById.get(task.projectId) : undefined;
    const milestone = task.milestoneId ? milestonesById.get(task.milestoneId) : undefined;
    if (task.status !== "todo") {
      skipped.push({ taskId, code: "task_not_todo", message: `Task ${taskId} is ${task.status}.` });
      continue;
    }
    if (capacityDateKey(task.date) >= input.asOfDate) {
      skipped.push({ taskId, code: "task_not_overdue", message: `Task ${taskId} is not overdue.` });
      continue;
    }
    if (!task.movable) {
      needsDecision.push(decision(task, "task_not_movable", "Task is protected from movement.", project, milestone));
      continue;
    }
    if (task.blocked) {
      needsDecision.push(decision(task, "task_blocked", "Task is blocked and needs a user decision.", project, milestone));
      continue;
    }
    if (!project || project.needsDefinition || project.status !== "active") {
      needsDecision.push(
        decision(task, "project_context_missing", "Task does not belong to a fully defined active Project.", project, milestone),
      );
      continue;
    }
    if (task.rolloverCount >= 1) {
      needsDecision.push(
        decision(task, "repeated_overdue", "Task already had one approved rollover and needs a user decision.", project, milestone),
      );
      continue;
    }
    if (milestone && (milestone.status === "completed" || milestone.status === "skipped")) {
      needsDecision.push(
        decision(task, "milestone_context_conflict", `Milestone is ${milestone.status}.`, project, milestone),
      );
      continue;
    }
    candidates.push(task);
  }

  if (candidates.length === 0) {
    return { operationCount: 0, skipped, warnings: [], needsDecision };
  }

  candidates.sort((left, right) => {
    const leftProject = projectsById.get(left.projectId!);
    const rightProject = projectsById.get(right.projectId!);
    const leftTarget = leftProject?.targetDate?.getTime() ?? Number.POSITIVE_INFINITY;
    const rightTarget = rightProject?.targetDate?.getTime() ?? Number.POSITIVE_INFINITY;
    return (
      priorityRank[leftProject?.priority ?? "normal"] - priorityRank[rightProject?.priority ?? "normal"] ||
      leftTarget - rightTarget ||
      priorityRank[left.priority] - priorityRank[right.priority] ||
      (left.originalDate ?? left.date).getTime() - (right.originalDate ?? right.date).getTime() ||
      requestedTaskIds.indexOf(left.id) - requestedTaskIds.indexOf(right.id)
    );
  });

  const candidateEnds = candidates.map((task) => {
    const project = projectsById.get(task.projectId!);
    const milestone = task.milestoneId ? milestonesById.get(task.milestoneId) : undefined;
    return minDate(milestone?.targetDate, project?.targetDate, plan.endDate) ?? plan.endDate;
  });
  const maxEnd = new Date(Math.max(...candidateEnds.map((date) => date.getTime())));
  const rangeEnd = addDays(startOfShanghaiCapacityDay(maxEnd), 1);
  if (rangeEnd <= asOf) {
    for (const task of candidates) {
      needsDecision.push(
        decision(
          task,
          "no_capacity_before_target",
          "Project or Plan target date has already passed.",
          projectsById.get(task.projectId!),
          task.milestoneId ? milestonesById.get(task.milestoneId) : undefined,
        ),
      );
    }
    return { operationCount: 0, skipped, warnings: [], needsDecision };
  }

  const [scheduledTasks, blockRows, routineRows, capacityRows, energyRows] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.planId, plan.id),
          isNull(tasks.archivedAt),
          gte(tasks.date, asOf),
          lt(tasks.date, rangeEnd),
        ),
      ),
    loadEffectiveTimeBlocks(db, {
      workspaceId: input.workspaceId,
      rangeStart: asOf,
      rangeEnd,
    }).then((snapshot) => snapshot.occurrences.map((block) => ({ ...block, recurrenceWeekdayMask: null }))),
    db.select().from(routines).where(eq(routines.workspaceId, input.workspaceId)),
    db
      .select()
      .from(dayCapacities)
      .where(and(eq(dayCapacities.workspaceId, input.workspaceId), gte(dayCapacities.date, asOf), lt(dayCapacities.date, rangeEnd))),
    db.select().from(segmentEnergySettings).where(eq(segmentEnergySettings.workspaceId, input.workspaceId)),
  ]);
  const dates = datesInRange(asOf, rangeEnd);
  const capacity = buildCapacityModel({
    dates,
    capacities: capacityRows,
    tasks: scheduledTasks,
    timeBlocks: blockRows,
    routines: routineRows,
    now: asOf,
  });
  const remaining = new Map<string, number>();
  for (const day of capacity.days) {
    for (const segment of segments) remaining.set(`${day.dateKey}:${segment}`, day.segments[segment].remainingMinutes);
  }
  const segmentEnergy = Object.fromEntries(
    energyRows.map((row: { segment: DaySegment; energyLevel: EnergyLevel }) => [row.segment, row.energyLevel]),
  ) as Partial<Record<DaySegment, EnergyLevel>>;
  const operations: Array<Record<string, unknown>> = [];

  for (const task of candidates) {
    const project = projectsById.get(task.projectId!)!;
    const milestone = task.milestoneId ? milestonesById.get(task.milestoneId) : undefined;
    const target = minDate(milestone?.targetDate, project.targetDate, plan.endDate) ?? plan.endDate;
    const targetKey = capacityDateKey(target);
    let selected: { dateKey: string; segment: DaySegment; before: number; after: number } | null = null;
    const segmentOrder = segmentOrderForTask(task, segmentEnergy);
    for (const day of capacity.days) {
      if (day.dateKey > targetKey) break;
      for (const segment of segmentOrder) {
        const key = `${day.dateKey}:${segment}`;
        const before = remaining.get(key) ?? 0;
        if (before < task.estimatedMinutes) continue;
        selected = { dateKey: day.dateKey, segment, before, after: before - task.estimatedMinutes };
        remaining.set(key, selected.after);
        break;
      }
      if (selected) break;
    }

    if (!selected) {
      needsDecision.push(
        decision(
          task,
          "no_capacity_before_target",
          "No compatible capacity exists before the Project or Plan target date.",
          project,
          milestone,
        ),
      );
      continue;
    }

    operations.push({
      type: "move_task",
      task_id: task.id,
      from_date: capacityDateKey(task.date),
      from_day_segment: task.daySegment,
      to_date: selected.dateKey,
      to_day_segment: selected.segment,
      overdue_rollover: true,
      expected_rollover_count: task.rolloverCount,
      reason: `首次逾期；按 ${project.name} 的优先级和目标日期安排到下一个可用时段。`,
      capacity_impact: [
        `${selected.dateKey} ${selected.segment} 原剩余 ${selected.before} 分钟`,
        `安排后剩余 ${selected.after} 分钟`,
      ],
      protected_evidence: ["目标时段已通过 PawPlan capacity/protected-block 计算"],
    });
  }

  if (operations.length === 0) {
    return { operationCount: 0, skipped, warnings: capacity.warnings, needsDecision };
  }

  const proposal = await proposeAgentPatch(db, {
    workspaceId: input.workspaceId,
    mode: "week",
    reason: input.reason,
    patch: { operations },
    createdBy: input.createdBy,
    scopeStart: asOf,
    scopeEnd: rangeEnd,
  });
  return {
    patchId: proposal.patchId,
    operationCount: operations.length,
    skipped,
    warnings: capacity.warnings,
    needsDecision,
  };
}
