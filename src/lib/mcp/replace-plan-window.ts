import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import {
  changeLogs,
  planOperations,
  plans,
  planVersions,
  planWindowRevisions,
  planWindowTaskRefs,
  projectMilestones,
  projects,
  tasks,
} from "@/lib/db/schema";
import {
  ActivePlanError,
  resolveActivePlanContext,
  type ActivePlanContext,
} from "@/lib/planning/active-plan";
import {
  consumeOperationApproval,
  createOperationApproval,
  verifyOperationApproval,
} from "@/lib/approvals/service";

type DaySegment = "morning" | "afternoon" | "evening";
type Priority = "low" | "normal" | "high" | "urgent";
type EnergyLevel = "low" | "medium" | "high";
type RetireScope = "source_managed" | "all_non_completed";

export type ReplacePlanWindowTask = {
  externalTaskKey: string;
  title: string;
  projectId: string;
  milestoneId?: string | null;
  parentExternalTaskKey?: string | null;
  notes?: string | null;
  date: string;
  daySegment: DaySegment;
  estimatedMinutes: number;
  priority?: Priority;
  energyLevel?: EnergyLevel;
  movable?: boolean;
  blocked?: boolean;
};

export type ReplacePlanWindowInput = {
  workspaceId: string;
  dateFrom: string;
  dateTo: string;
  sourceKey: string;
  expectedPlanId: string;
  expectedCurrentVersionId: string | null;
  retireScope: RetireScope;
  tasks: ReplacePlanWindowTask[];
  weeklySummaries: unknown[];
  monthlySummaries: unknown[];
  focusProjectIds: string[];
  idempotencyKey: string;
  createdBy?: "codex" | "claude" | "user";
  previewToken?: string;
  approvalId?: string;
  now?: Date;
};

type ReplaceDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

type TaskRow = typeof tasks.$inferSelect;
type TaskRefRow = typeof planWindowTaskRefs.$inferSelect;

type ReplaceConflict = {
  code: string;
  message: string;
  externalTaskKey?: string;
  taskId?: string;
};

type ReplaceDiff = {
  createExternalTaskKeys: string[];
  replaceTaskIds: string[];
  unchangedTaskIds: string[];
  wouldArchiveTaskIds: string[];
  preservedDoneTaskIds: string[];
  summaryChanged: boolean;
};

type PreviewState = {
  plan: ActivePlanContext;
  inputTasks: ReplacePlanWindowTask[];
  refs: TaskRefRow[];
  refTasks: TaskRow[];
  windowTasks: TaskRow[];
  projectRows: Array<typeof projects.$inferSelect>;
  milestoneRows: Array<typeof projectMilestones.$inferSelect>;
  diff: ReplaceDiff;
  conflicts: ReplaceConflict[];
  stateHash: string;
  requestHash: string;
};

export type ReplacePlanWindowPreview = {
  status: "preview" | "needs_decision";
  workspaceId: string;
  planId: string;
  window: { dateFrom: string; dateTo: string };
  sourceKey: string;
  retireScope: RetireScope;
  diff: ReplaceDiff;
  conflicts: ReplaceConflict[];
  projectReadback: Array<{
    id: string;
    name: string;
    category: string | null;
    objective: string | null;
    successCriteria: string | null;
    priority: Priority;
    targetDate: string | null;
  }>;
  previewToken: string;
  approvalId?: string;
  liveUnchanged: true;
};

export type ReplacePlanWindowResult = {
  status: "succeeded" | "no_change" | "duplicate" | "failed";
  operationId: string;
  revisionId: string | null;
  planId: string;
  currentVersionId: string | null;
  window: { dateFrom: string; dateTo: string };
  createdTaskIds: string[];
  archivedTaskIds: string[];
  unchangedTaskIds: string[];
  preservedDoneTaskIds: string[];
  failedTaskIds: string[];
  readback: ReplacePlanWindowReadback;
  error?: { code: string; message: string };
};

type ReplaceTaskReadback = {
  id: string;
  externalTaskKey: string | null;
  title: string;
  status: string;
  date: string;
  archivedAt: string | null;
};

type ReadbackTaskSurface = {
  count: number;
  tasks: ReplaceTaskReadback[];
};

export type ReplacePlanWindowReadback =
  | {
      verification: "succeeded";
      verifiedAt: string;
      window: ReadbackTaskSurface & { dateFrom: string; dateTo: string };
      todo: ReadbackTaskSurface;
      backlog: ReadbackTaskSurface;
      week: ReadbackTaskSurface & { dateFrom: string; dateTo: string };
      month: ReadbackTaskSurface & { dateFrom: string; dateTo: string };
      total: {
        all: number;
        active: number;
        archived: number;
        byStatus: Record<"todo" | "done" | "skipped" | "backlog", number>;
      };
    }
  | {
      verification: "failed";
      verifiedAt: string;
      error: { code: "readback_failed"; message: string };
    };

export class ReplacePlanWindowError extends Error {
  constructor(
    public code:
      | "invalid_window"
      | "window_outside_plan"
      | "stale_plan_version"
      | "preview_required"
      | "preview_expired"
      | "preview_stale"
      | "project_ref_unknown"
      | "project_definition_incomplete"
      | "milestone_project_mismatch"
      | "parent_cycle"
      | "managed_task_changed"
      | "idempotency_payload_mismatch"
      | "operation_in_progress",
    message: string,
    public status = 400,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const previewTtlMs = 30 * 60 * 1000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error("APP_SECRET is required");
  return secret;
}

function sign(payload: string) {
  return createHmac("sha256", appSecret()).update(payload).digest("base64url");
}

function signaturesEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000+08:00`);
  return Number.isNaN(date.getTime()) || dateKey(date) !== value ? null : date;
}

function dateKey(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function readbackRanges(now: Date) {
  const today = parseDateKey(dateKey(now))!;
  const shanghaiNoon = new Date(today.getTime() + 20 * 60 * 60 * 1000);
  const weekday = shanghaiNoon.getUTCDay();
  const weekStart = addDays(today, weekday === 0 ? -6 : 1 - weekday);
  const weekEnd = addDays(weekStart, 7);
  const [year, month] = dateKey(now).split("-").map(Number);
  const monthStart = parseDateKey(`${year}-${String(month).padStart(2, "0")}-01`)!;
  const nextMonthYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const monthEnd = parseDateKey(`${nextMonthYear}-${String(nextMonth).padStart(2, "0")}-01`)!;
  return { weekStart, weekEnd, monthStart, monthEnd };
}

function datesInRange(start: Date, end: Date) {
  const dates: Date[] = [];
  for (let cursor = start; cursor < end; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

function dateOrNull(value: Date | null | undefined) {
  return value instanceof Date ? value.toISOString() : null;
}

function normalizedTask(task: ReplacePlanWindowTask) {
  return {
    externalTaskKey: task.externalTaskKey.trim(),
    title: task.title.trim(),
    projectId: task.projectId,
    milestoneId: task.milestoneId ?? null,
    parentExternalTaskKey: task.parentExternalTaskKey ?? null,
    notes: task.notes?.trim() || null,
    date: task.date,
    daySegment: task.daySegment,
    estimatedMinutes: task.estimatedMinutes,
    priority: task.priority ?? "normal",
    energyLevel: task.energyLevel ?? "medium",
    movable: task.movable ?? true,
    blocked: task.blocked ?? false,
  };
}

function businessPayload(input: ReplacePlanWindowInput) {
  return {
    workspaceId: input.workspaceId,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    sourceKey: input.sourceKey.trim(),
    expectedPlanId: input.expectedPlanId,
    expectedCurrentVersionId: input.expectedCurrentVersionId,
    retireScope: input.retireScope,
    tasks: input.tasks.map(normalizedTask).sort((left, right) => left.externalTaskKey.localeCompare(right.externalTaskKey)),
    weeklySummaries: input.weeklySummaries,
    monthlySummaries: input.monthlySummaries,
    focusProjectIds: [...input.focusProjectIds].sort(),
  };
}

function validateInput(input: ReplacePlanWindowInput) {
  const windowStart = parseDateKey(input.dateFrom);
  const windowEnd = parseDateKey(input.dateTo);
  if (!windowStart || !windowEnd || windowEnd <= windowStart) {
    throw new ReplacePlanWindowError("invalid_window", "Replace window must be a valid right-open date range");
  }
  if (!input.sourceKey.trim() || input.sourceKey.trim().length > 160) {
    throw new ReplacePlanWindowError("invalid_window", "Invalid replace source key");
  }
  if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new ReplacePlanWindowError("invalid_window", "Invalid replace idempotency key");
  }
  if (input.tasks.length > 500) {
    throw new ReplacePlanWindowError("invalid_window", "Replace window supports at most 500 tasks per request");
  }
  const externalKeys = input.tasks.map((task) => task.externalTaskKey.trim());
  if (externalKeys.some((key) => !key || key.length > 200) || new Set(externalKeys).size !== externalKeys.length) {
    throw new ReplacePlanWindowError("managed_task_changed", "Every task needs a unique stable external key");
  }
  for (const task of input.tasks) {
    if (!task.title.trim() || !task.projectId || task.estimatedMinutes < 1 || task.estimatedMinutes > 1440) {
      throw new ReplacePlanWindowError("managed_task_changed", `Invalid task payload: ${task.externalTaskKey}`);
    }
    const taskDate = parseDateKey(task.date);
    if (!taskDate || taskDate < windowStart || taskDate >= windowEnd) {
      throw new ReplacePlanWindowError("invalid_window", `Task ${task.externalTaskKey} is outside the replace window`);
    }
  }
  validateParents(input.tasks);
  return { windowStart, windowEnd };
}

function validateParents(inputTasks: ReplacePlanWindowTask[]) {
  const byKey = new Map(inputTasks.map((task) => [task.externalTaskKey.trim(), task]));
  for (const task of inputTasks) {
    const parentKey = task.parentExternalTaskKey?.trim();
    if (parentKey && !byKey.has(parentKey)) {
      throw new ReplacePlanWindowError("parent_cycle", `Unknown parent external key: ${parentKey}`);
    }
    if (parentKey && byKey.get(parentKey)?.projectId !== task.projectId) {
      throw new ReplacePlanWindowError("parent_cycle", `Parent task ${parentKey} must belong to the same Project`);
    }
  }
  for (const task of inputTasks) {
    const visited = new Set<string>();
    let cursor: ReplacePlanWindowTask | undefined = task;
    while (cursor?.parentExternalTaskKey) {
      const key = cursor.externalTaskKey.trim();
      if (visited.has(key)) {
        throw new ReplacePlanWindowError("parent_cycle", `Task parent cycle includes ${key}`);
      }
      visited.add(key);
      cursor = byKey.get(cursor.parentExternalTaskKey.trim());
    }
  }
}

function assertExpectedPlan(plan: ActivePlanContext, input: ReplacePlanWindowInput, windowStart: Date, windowEnd: Date) {
  if (plan.id !== input.expectedPlanId || plan.currentVersionId !== input.expectedCurrentVersionId) {
    throw new ReplacePlanWindowError("stale_plan_version", "Active plan changed since the request was prepared", 409, {
      expectedPlanId: input.expectedPlanId,
      actualPlanId: plan.id,
      expectedCurrentVersionId: input.expectedCurrentVersionId,
      actualCurrentVersionId: plan.currentVersionId,
    });
  }
  const planStart = parseDateKey(dateKey(plan.startDate))!;
  const planEndExclusive = addDays(parseDateKey(dateKey(plan.endDate))!, 1);
  if (windowStart < planStart || windowEnd > planEndExclusive) {
    throw new ReplacePlanWindowError("window_outside_plan", "Replace window is outside the active plan range", 409, {
      planStart: dateKey(plan.startDate),
      planEnd: dateKey(plan.endDate),
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
    });
  }
}

function taskFingerprint(task: TaskRow) {
  return {
    id: task.id,
    planId: task.planId,
    title: task.title,
    notes: task.notes,
    date: dateKey(task.date),
    daySegment: task.daySegment,
    status: task.status,
    blocked: task.blocked,
    priority: task.priority,
    estimatedMinutes: task.estimatedMinutes,
    energyLevel: task.energyLevel,
    movable: task.movable,
    projectId: task.projectId,
    milestoneId: task.milestoneId,
    parentTaskId: task.parentTaskId,
    archivedAt: dateOrNull(task.archivedAt),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function currentTaskMatches(
  row: TaskRow,
  task: ReturnType<typeof normalizedTask>,
  expectedParentTaskId: string | null,
) {
  return (
    row.title === task.title &&
    (row.notes ?? null) === task.notes &&
    dateKey(row.date) === task.date &&
    row.daySegment === task.daySegment &&
    row.priority === task.priority &&
    row.estimatedMinutes === task.estimatedMinutes &&
    row.energyLevel === task.energyLevel &&
    row.movable === task.movable &&
    row.blocked === task.blocked &&
    row.projectId === task.projectId &&
    row.milestoneId === task.milestoneId &&
    row.parentTaskId === expectedParentTaskId
  );
}

function windowSnapshot(input: ReplacePlanWindowInput, revisionId: string | null, taskIds: string[]) {
  return {
    sourceKey: input.sourceKey.trim(),
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    weeklySummaries: input.weeklySummaries,
    monthlySummaries: input.monthlySummaries,
    focusProjectIds: [...input.focusProjectIds],
    taskIds,
    revisionId,
  };
}

function snapshotKey(input: ReplacePlanWindowInput) {
  return `${input.sourceKey.trim()}:${input.dateFrom}:${input.dateTo}`;
}

function snapshotWithWindow(base: unknown, input: ReplacePlanWindowInput, revisionId: string, taskIds: string[]) {
  const root = base && typeof base === "object" && !Array.isArray(base) ? base as Record<string, unknown> : {};
  const currentWindows = root.planWindows && typeof root.planWindows === "object" && !Array.isArray(root.planWindows)
    ? root.planWindows as Record<string, unknown>
    : {};
  return {
    ...root,
    planWindows: {
      ...currentWindows,
      [snapshotKey(input)]: windowSnapshot(input, revisionId, taskIds),
    },
  };
}

function summaryChanged(plan: ActivePlanContext, input: ReplacePlanWindowInput) {
  const root = plan.baselineSnapshot && typeof plan.baselineSnapshot === "object" && !Array.isArray(plan.baselineSnapshot)
    ? plan.baselineSnapshot as Record<string, unknown>
    : {};
  const windows = root.planWindows && typeof root.planWindows === "object" && !Array.isArray(root.planWindows)
    ? root.planWindows as Record<string, unknown>
    : {};
  const current = windows[snapshotKey(input)];
  const desired = windowSnapshot(input, null, []);
  if (!current || typeof current !== "object") return true;
  const normalizedCurrent = { ...(current as Record<string, unknown>), revisionId: null, taskIds: [] };
  return sha256(normalizedCurrent) !== sha256(desired);
}

async function loadPreviewState(
  db: Pick<ReplaceDb, "select">,
  input: ReplacePlanWindowInput,
  options: { lock?: boolean } = {},
): Promise<PreviewState> {
  const { windowStart, windowEnd } = validateInput(input);
  const plan = await resolveActivePlanContext(db, input.workspaceId, { lock: options.lock });
  assertExpectedPlan(plan, input, windowStart, windowEnd);

  const projectIds = [...new Set([...input.tasks.map((task) => task.projectId), ...input.focusProjectIds])];
  const milestoneIds = [...new Set(input.tasks.flatMap((task) => task.milestoneId ? [task.milestoneId] : []))];
  // This function also runs inside a PostgreSQL transaction. Keep reads
  // sequential because a transaction owns one client and pg does not support
  // concurrent queries on that client.
  const projectRows: Array<typeof projects.$inferSelect> = projectIds.length
    ? await db.select().from(projects).where(and(eq(projects.workspaceId, input.workspaceId), inArray(projects.id, projectIds)))
    : [];
  const milestoneRows: Array<typeof projectMilestones.$inferSelect> = milestoneIds.length
    ? await db
        .select()
        .from(projectMilestones)
        .where(and(eq(projectMilestones.workspaceId, input.workspaceId), inArray(projectMilestones.id, milestoneIds)))
    : [];
  const refs = await db
    .select()
    .from(planWindowTaskRefs)
    .where(
      and(
        eq(planWindowTaskRefs.workspaceId, input.workspaceId),
        eq(planWindowTaskRefs.planId, plan.id),
        eq(planWindowTaskRefs.sourceKey, input.sourceKey.trim()),
      ),
    ) as TaskRefRow[];
  const windowTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, input.workspaceId),
        eq(tasks.planId, plan.id),
        gte(tasks.date, windowStart),
        lt(tasks.date, windowEnd),
      ),
    ) as TaskRow[];
  const refIds = refs.map((ref: TaskRefRow) => ref.taskId);
  const refTasks: TaskRow[] = refIds.length
    ? await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.planId, plan.id), inArray(tasks.id, refIds)))
    : [];

  const projectsById = new Map(projectRows.map((project) => [project.id, project]));
  const milestonesById = new Map(milestoneRows.map((milestone) => [milestone.id, milestone]));
  const conflicts: ReplaceConflict[] = [];
  for (const projectId of projectIds) {
    const project = projectsById.get(projectId);
    if (!project) {
      conflicts.push({ code: "project_ref_unknown", message: `Project ${projectId} is not available in this workspace.` });
    } else if (project.needsDefinition || project.status !== "active") {
      conflicts.push({
        code: "project_definition_incomplete",
        message: `Project ${project.name} must be fully defined and active before replacement.`,
      });
    }
  }
  for (const task of input.tasks) {
    if (!task.milestoneId) continue;
    const milestone = milestonesById.get(task.milestoneId);
    if (
      !milestone ||
      milestone.projectId !== task.projectId ||
      milestone.status === "completed" ||
      milestone.status === "skipped"
    ) {
      conflicts.push({
        code: "milestone_project_mismatch",
        externalTaskKey: task.externalTaskKey,
        message: `Milestone ${task.milestoneId} does not belong to task Project ${task.projectId}.`,
      });
    }
  }

  const refByKey = new Map(refs.map((ref: TaskRefRow) => [ref.externalTaskKey, ref]));
  const refTaskById = new Map(refTasks.map((task) => [task.id, task]));
  const inputByKey = new Map(input.tasks.map((task) => [task.externalTaskKey.trim(), normalizedTask(task)]));
  const createExternalTaskKeys: string[] = [];
  const replaceTaskIds: string[] = [];
  const unchangedTaskIds: string[] = [];

  for (const [externalTaskKey, task] of inputByKey) {
    const ref = refByKey.get(externalTaskKey);
    const current = ref ? refTaskById.get(ref.taskId) : undefined;
    if (!current || current.archivedAt) {
      createExternalTaskKeys.push(externalTaskKey);
      continue;
    }
    if (current.status === "done" || current.date < windowStart || current.date >= windowEnd) {
      conflicts.push({
        code: "managed_task_changed",
        externalTaskKey,
        taskId: current.id,
        message: `Managed task ${externalTaskKey} is completed or outside the requested window.`,
      });
      continue;
    }
    const parentKey = task.parentExternalTaskKey;
    const parentTaskId = parentKey ? refByKey.get(parentKey)?.taskId ?? null : null;
    if (currentTaskMatches(current, task, parentTaskId)) unchangedTaskIds.push(current.id);
    else replaceTaskIds.push(current.id);
  }

  let parentReplacementPropagated = true;
  while (parentReplacementPropagated) {
    parentReplacementPropagated = false;
    for (const [externalTaskKey, task] of inputByKey) {
      if (!task.parentExternalTaskKey) continue;
      const childTaskId = refByKey.get(externalTaskKey)?.taskId;
      const parentTaskId = refByKey.get(task.parentExternalTaskKey)?.taskId;
      if (
        childTaskId &&
        parentTaskId &&
        unchangedTaskIds.includes(childTaskId) &&
        replaceTaskIds.includes(parentTaskId)
      ) {
        unchangedTaskIds.splice(unchangedTaskIds.indexOf(childTaskId), 1);
        replaceTaskIds.push(childTaskId);
        parentReplacementPropagated = true;
      }
    }
  }

  const activeWindowTasks = windowTasks.filter((task: TaskRow) => !task.archivedAt);
  if (input.retireScope === "source_managed") {
    const managedTaskIds = new Set(refs.map((ref) => ref.taskId));
    for (const incoming of input.tasks.map(normalizedTask)) {
      const collision = activeWindowTasks.find(
        (task) =>
          !managedTaskIds.has(task.id) &&
          task.status !== "done" &&
          task.title.trim().toLocaleLowerCase() === incoming.title.toLocaleLowerCase() &&
          dateKey(task.date) === incoming.date &&
          task.daySegment === incoming.daySegment,
      );
      if (collision) {
        conflicts.push({
          code: "manual_task_collision",
          externalTaskKey: incoming.externalTaskKey,
          taskId: collision.id,
          message: `Incoming task ${incoming.externalTaskKey} collides with an unmanaged task in the same slot.`,
        });
      }
    }
  }
  const preservedDoneTaskIds = activeWindowTasks.filter((task: TaskRow) => task.status === "done").map((task: TaskRow) => task.id);
  const retirementCandidates = input.retireScope === "all_non_completed"
    ? activeWindowTasks.filter((task) => task.status !== "done")
    : refTasks.filter(
        (task: TaskRow) => !task.archivedAt && task.status !== "done" && task.date >= windowStart && task.date < windowEnd,
      );
  const wouldArchiveTaskIds = retirementCandidates
    .filter((task: TaskRow) => !unchangedTaskIds.includes(task.id))
    .map((task: TaskRow) => task.id);

  const diff: ReplaceDiff = {
    createExternalTaskKeys,
    replaceTaskIds,
    unchangedTaskIds,
    wouldArchiveTaskIds: [...new Set(wouldArchiveTaskIds)],
    preservedDoneTaskIds,
    summaryChanged: summaryChanged(plan, input),
  };
  const requestHash = sha256(businessPayload(input));
  const stateHash = sha256({
    planId: plan.id,
    currentVersionId: plan.currentVersionId,
    tasks: [...new Map([...windowTasks, ...refTasks].map((task: TaskRow) => [task.id, taskFingerprint(task)])).values()]
      .sort((left, right) => left.id.localeCompare(right.id)),
    refs: refs
      .map((ref: TaskRefRow) => ({ externalTaskKey: ref.externalTaskKey, taskId: ref.taskId, revisionId: ref.revisionId }))
      .sort((left, right) => left.externalTaskKey.localeCompare(right.externalTaskKey)),
    projects: projectRows.map((project) => ({
      id: project.id,
      status: project.status,
      needsDefinition: project.needsDefinition,
      updatedAt: project.updatedAt.toISOString(),
    })),
    milestones: milestoneRows.map((milestone) => ({
      id: milestone.id,
      projectId: milestone.projectId,
      status: milestone.status,
      updatedAt: milestone.updatedAt.toISOString(),
    })),
  });

  return {
    plan,
    inputTasks: input.tasks,
    refs,
    refTasks,
    windowTasks,
    projectRows,
    milestoneRows,
    diff,
    conflicts,
    stateHash,
    requestHash,
  };
}

function createPreviewToken(input: ReplacePlanWindowInput, state: PreviewState) {
  const now = input.now ?? new Date();
  const payload = Buffer.from(
    JSON.stringify({
      kind: "replace_plan_window",
      workspaceId: input.workspaceId,
      planId: state.plan.id,
      requestHash: state.requestHash,
      stateHash: state.stateHash,
      expiresAt: new Date(now.getTime() + previewTtlMs).toISOString(),
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifyPreviewToken(input: ReplacePlanWindowInput, state: PreviewState) {
  if (!input.previewToken) throw new ReplacePlanWindowError("preview_required", "Replace preview token required");
  const [payload, signature] = input.previewToken.split(".");
  if (!payload || !signature || !signaturesEqual(signature, sign(payload))) {
    throw new ReplacePlanWindowError("preview_required", "Invalid replace preview token");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ReplacePlanWindowError("preview_required", "Invalid replace preview token");
  }
  if (
    parsed.kind !== "replace_plan_window" ||
    parsed.workspaceId !== input.workspaceId ||
    parsed.planId !== state.plan.id ||
    parsed.requestHash !== state.requestHash
  ) {
    throw new ReplacePlanWindowError("preview_required", "Replace preview token does not match this request");
  }
  const expiresAt = typeof parsed.expiresAt === "string" ? new Date(parsed.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= (input.now ?? new Date())) {
    throw new ReplacePlanWindowError("preview_expired", "Replace preview token expired", 409);
  }
  if (parsed.stateHash !== state.stateHash) {
    throw new ReplacePlanWindowError("preview_stale", "Replace window changed after preview", 409);
  }
}

function projectReadback(state: PreviewState): ReplacePlanWindowPreview["projectReadback"] {
  return state.projectRows.map((project) => ({
    id: project.id,
    name: project.name,
    category: project.category,
    objective: project.objective,
    successCriteria: project.successCriteria,
    priority: project.priority,
    targetDate: dateOrNull(project.targetDate),
  }));
}

export async function previewReplacePlanWindow(
  db: Pick<ReplaceDb, "select" | "insert" | "update">,
  input: ReplacePlanWindowInput,
): Promise<ReplacePlanWindowPreview> {
  const state = await loadPreviewState(db, input);
  const previewToken = createPreviewToken(input, state);
  const approval = state.conflicts.length === 0
    ? await createOperationApproval(db, {
        workspaceId: input.workspaceId,
        operationKind: "replace_plan_window",
        requestHash: state.requestHash,
        previewToken,
        expiresAt: new Date((input.now ?? new Date()).getTime() + previewTtlMs),
        summary: {
          title: "替换计划日期窗口",
          description: `${input.dateFrom} 至 ${input.dateTo}：归档 ${state.diff.wouldArchiveTaskIds.length} 条，创建 ${state.diff.createExternalTaskKeys.length} 条。`,
          count: state.diff.wouldArchiveTaskIds.length + state.diff.createExternalTaskKeys.length,
          items: input.tasks.map((task) => task.title),
        },
      })
    : null;
  return {
    status: state.conflicts.length > 0 ? "needs_decision" : "preview",
    workspaceId: input.workspaceId,
    planId: state.plan.id,
    window: { dateFrom: input.dateFrom, dateTo: input.dateTo },
    sourceKey: input.sourceKey.trim(),
    retireScope: input.retireScope,
    diff: state.diff,
    conflicts: state.conflicts,
    projectReadback: projectReadback(state),
    previewToken,
    approvalId: approval?.id,
    liveUnchanged: true,
  };
}

async function claimOperation(db: ReplaceDb, input: ReplacePlanWindowInput, requestHash: string) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(planOperations)
      .values({
        workspaceId: input.workspaceId,
        planId: input.expectedPlanId,
        operationKind: "replace_plan_window",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        status: "started",
        resultJson: {},
        leaseExpiresAt: new Date((input.now ?? new Date()).getTime() + 5 * 60 * 1000),
      })
      .onConflictDoNothing({ target: [planOperations.workspaceId, planOperations.idempotencyKey] })
      .returning();
    if (created) return { duplicate: false as const, operation: created };

    const [existing] = await tx
      .select()
      .from(planOperations)
      .where(and(eq(planOperations.workspaceId, input.workspaceId), eq(planOperations.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!existing || existing.operationKind !== "replace_plan_window" || existing.requestHash !== requestHash) {
      throw new ReplacePlanWindowError(
        "idempotency_payload_mismatch",
        "Idempotency key was already used with a different replace request",
        409,
      );
    }
    if (existing.status === "started") {
      const now = input.now ?? new Date();
      if (!existing.leaseExpiresAt || existing.leaseExpiresAt <= now) {
        const reclaimed = await tx
          .update(planOperations)
          .set({ leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000), updatedAt: now })
          .where(
            and(
              eq(planOperations.id, existing.id),
              eq(planOperations.workspaceId, input.workspaceId),
              eq(planOperations.status, "started"),
              or(isNull(planOperations.leaseExpiresAt), lt(planOperations.leaseExpiresAt, now)),
            ),
          )
          .returning();
        if (reclaimed.length === 1) return { duplicate: false as const, operation: reclaimed[0] };
      }
      throw new ReplacePlanWindowError("operation_in_progress", "Replace plan window is already in progress", 409, {
        operationId: existing.id,
      });
    }
    return { duplicate: true as const, operation: existing };
  });
}

async function findExistingOperation(db: ReplaceDb, input: ReplacePlanWindowInput) {
  const [existing] = await db
    .select()
    .from(planOperations)
    .where(and(eq(planOperations.workspaceId, input.workspaceId), eq(planOperations.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  return existing as typeof planOperations.$inferSelect | undefined;
}

async function markOperationFailed(db: ReplaceDb, operationId: string, workspaceId: string, error: unknown) {
  const errorJson = {
    code:
      error instanceof ReplacePlanWindowError || error instanceof ActivePlanError
        ? error.code
        : "replace_plan_window_failed",
    message: error instanceof Error ? error.message : "Replace plan window failed",
  };
  await db
    .update(planOperations)
    .set({ status: "failed", errorJson, resultJson: { status: "failed", error: errorJson }, updatedAt: new Date() })
    .where(and(eq(planOperations.id, operationId), eq(planOperations.workspaceId, workspaceId)));
}

function duplicateResult(operation: typeof planOperations.$inferSelect): ReplacePlanWindowResult {
  const saved = operation.resultJson as Partial<ReplacePlanWindowResult>;
  const savedError = operation.errorJson && typeof operation.errorJson === "object"
    ? operation.errorJson as { code?: unknown; message?: unknown }
    : null;
  return {
    status: operation.status === "failed" ? "failed" : "duplicate",
    operationId: operation.id,
    revisionId: saved.revisionId ?? null,
    planId: saved.planId ?? operation.planId ?? "",
    currentVersionId: saved.currentVersionId ?? null,
    window: saved.window ?? { dateFrom: "", dateTo: "" },
    createdTaskIds: saved.createdTaskIds ?? [],
    archivedTaskIds: saved.archivedTaskIds ?? [],
    unchangedTaskIds: saved.unchangedTaskIds ?? [],
    preservedDoneTaskIds: saved.preservedDoneTaskIds ?? [],
    failedTaskIds: saved.failedTaskIds ?? [],
    readback: saved.readback ?? {
      verification: "failed",
      verifiedAt: new Date().toISOString(),
      error: { code: "readback_failed", message: "The stored operation has no final readback" },
    },
    ...(operation.status === "failed"
      ? {
          error: {
            code: typeof savedError?.code === "string" ? savedError.code : "replace_plan_window_failed",
            message: typeof savedError?.message === "string" ? savedError.message : "Replace plan window failed",
          },
        }
      : {}),
  };
}

async function latestVersionNumber(tx: any, workspaceId: string, planId: string) {
  const [latest] = await tx
    .select({ versionNumber: planVersions.versionNumber })
    .from(planVersions)
    .where(and(eq(planVersions.workspaceId, workspaceId), eq(planVersions.planId, planId)))
    .orderBy(desc(planVersions.versionNumber))
    .limit(1);
  return Number(latest?.versionNumber ?? 0);
}

async function readPlanResult(db: any, input: ReplacePlanWindowInput, planId: string): Promise<ReplacePlanWindowReadback> {
  const start = parseDateKey(input.dateFrom)!;
  const end = parseDateKey(input.dateTo)!;
  const [rows, refs] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.planId, planId)))
      .orderBy(tasks.date, tasks.createdAt),
    db
      .select()
      .from(planWindowTaskRefs)
      .where(
        and(
          eq(planWindowTaskRefs.workspaceId, input.workspaceId),
          eq(planWindowTaskRefs.planId, planId),
          eq(planWindowTaskRefs.sourceKey, input.sourceKey.trim()),
        ),
      ),
  ]);
  const keyByTask = new Map<string, string>((refs as TaskRefRow[]).map((ref) => [ref.taskId, ref.externalTaskKey]));
  const serialized: ReplaceTaskReadback[] = (rows as TaskRow[]).map((task) => ({
    id: task.id,
    externalTaskKey: keyByTask.get(task.id) ?? null,
    title: task.title,
    status: task.status,
    date: dateKey(task.date),
    archivedAt: dateOrNull(task.archivedAt),
  }));
  const active = serialized.filter((task) => task.archivedAt === null);
  const windowTasks = serialized.filter((task) => task.date >= input.dateFrom && task.date < input.dateTo);
  const todoTasks = active.filter((task) => task.status === "todo");
  const backlogTasks = active.filter((task) => task.status === "backlog");
  const { weekStart, weekEnd, monthStart, monthEnd } = readbackRanges(input.now ?? new Date());
  const weekFrom = dateKey(weekStart);
  const weekTo = dateKey(weekEnd);
  const monthFrom = dateKey(monthStart);
  const monthTo = dateKey(monthEnd);
  const weekTasks = active.filter((task) => task.date >= weekFrom && task.date < weekTo);
  const monthTasks = active.filter((task) => task.date >= monthFrom && task.date < monthTo);
  const byStatus = { todo: 0, done: 0, skipped: 0, backlog: 0 };
  for (const task of active) {
    if (task.status in byStatus) byStatus[task.status as keyof typeof byStatus] += 1;
  }
  return {
    verification: "succeeded",
    verifiedAt: new Date().toISOString(),
    window: { dateFrom: input.dateFrom, dateTo: input.dateTo, count: windowTasks.length, tasks: windowTasks },
    todo: { count: todoTasks.length, tasks: todoTasks },
    backlog: { count: backlogTasks.length, tasks: backlogTasks },
    week: { dateFrom: weekFrom, dateTo: weekTo, count: weekTasks.length, tasks: weekTasks },
    month: { dateFrom: monthFrom, dateTo: monthTo, count: monthTasks.length, tasks: monthTasks },
    total: {
      all: serialized.length,
      active: active.length,
      archived: serialized.length - active.length,
      byStatus,
    },
  };
}

function failedReadback(error: unknown): ReplacePlanWindowReadback {
  return {
    verification: "failed",
    verifiedAt: new Date().toISOString(),
    error: {
      code: "readback_failed",
      message: error instanceof Error ? error.message : "Post-commit readback failed",
    },
  };
}

async function attachPostCommitReadback(
  db: ReplaceDb,
  input: ReplacePlanWindowInput,
  result: ReplacePlanWindowResult,
  persist = true,
): Promise<ReplacePlanWindowResult> {
  let readback: ReplacePlanWindowReadback;
  try {
    readback = await readPlanResult(db, input, result.planId);
  } catch (error) {
    readback = failedReadback(error);
  }
  const verifiedResult = { ...result, readback };
  if (persist) {
    try {
      await db
        .update(planOperations)
        .set({ resultJson: verifiedResult, updatedAt: new Date() })
        .where(and(eq(planOperations.id, result.operationId), eq(planOperations.workspaceId, input.workspaceId)));
      if (result.revisionId) {
        await db
          .update(planWindowRevisions)
          .set({ resultJson: verifiedResult })
          .where(and(eq(planWindowRevisions.id, result.revisionId), eq(planWindowRevisions.workspaceId, input.workspaceId)));
      }
    } catch {
      // The business transaction is already committed; persistence of verification metadata is best effort.
    }
  }
  return verifiedResult;
}

export async function replacePlanWindow(
  db: ReplaceDb,
  input: ReplacePlanWindowInput,
): Promise<ReplacePlanWindowResult> {
  const requestHash = sha256(businessPayload(input));
  const existing = await findExistingOperation(db, input);
  if (existing) {
    if (existing.operationKind !== "replace_plan_window" || existing.requestHash !== requestHash) {
      throw new ReplacePlanWindowError(
        "idempotency_payload_mismatch",
        "Idempotency key was already used with a different replace request",
        409,
      );
    }
    if (existing.status !== "started") {
      return attachPostCommitReadback(db, input, duplicateResult(existing), false);
    }
  }
  // Reject missing, expired, or mismatched previews before reserving the
  // idempotency key. The locked transaction below verifies the state again.
  const previewState = await loadPreviewState(db, input, { lock: false });
  verifyPreviewToken(input, previewState);
  await verifyOperationApproval(db, {
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    operationKind: "replace_plan_window",
    requestHash: previewState.requestHash,
    previewToken: input.previewToken!,
    now: input.now,
  });
  const claim = await claimOperation(db, input, requestHash);
  if (claim.duplicate) return attachPostCommitReadback(db, input, duplicateResult(claim.operation), false);

  let committed: ReplacePlanWindowResult;
  try {
    committed = await db.transaction(async (tx) => {
      const state = await loadPreviewState(tx, input, { lock: true });
      verifyPreviewToken(input, state);
      if (state.conflicts.length > 0) {
        throw new ReplacePlanWindowError("managed_task_changed", "Replace preview has unresolved conflicts", 409, {
          conflicts: state.conflicts,
        });
      }
      await consumeOperationApproval(tx, {
        workspaceId: input.workspaceId,
        approvalId: input.approvalId,
        operationKind: "replace_plan_window",
        requestHash: state.requestHash,
        previewToken: input.previewToken!,
        now: input.now,
      });

      const hasTaskChanges =
        state.diff.createExternalTaskKeys.length > 0 ||
        state.diff.replaceTaskIds.length > 0 ||
        state.diff.wouldArchiveTaskIds.length > 0;
      if (!hasTaskChanges && !state.diff.summaryChanged) {
        const result: ReplacePlanWindowResult = {
          status: "no_change",
          operationId: claim.operation.id,
          revisionId: null,
          planId: state.plan.id,
          currentVersionId: state.plan.currentVersionId,
          window: { dateFrom: input.dateFrom, dateTo: input.dateTo },
          createdTaskIds: [],
          archivedTaskIds: [],
          unchangedTaskIds: state.diff.unchangedTaskIds,
          preservedDoneTaskIds: state.diff.preservedDoneTaskIds,
          failedTaskIds: [],
          readback: failedReadback(new Error("Post-commit readback is pending")),
        };
        await tx
          .update(planOperations)
          .set({ status: "no_change", resultJson: result, leaseExpiresAt: null, updatedAt: new Date() })
          .where(and(eq(planOperations.id, claim.operation.id), eq(planOperations.workspaceId, input.workspaceId)));
        return result;
      }

      const now = input.now ?? new Date();
      const archivedTaskIds: string[] = [];
      if (state.diff.wouldArchiveTaskIds.length > 0) {
        const archived = await tx
          .update(tasks)
          .set({ archivedAt: now, updatedAt: now })
          .where(
            and(
              eq(tasks.workspaceId, input.workspaceId),
              eq(tasks.planId, state.plan.id),
              inArray(tasks.id, state.diff.wouldArchiveTaskIds),
              isNull(tasks.archivedAt),
              ne(tasks.status, "done"),
            ),
          )
          .returning({ id: tasks.id });
        archivedTaskIds.push(...archived.map((task: { id: string }) => task.id));
        if (archivedTaskIds.length !== state.diff.wouldArchiveTaskIds.length) {
          throw new ReplacePlanWindowError("preview_stale", "One or more tasks changed before replacement", 409);
        }
      }

      const refByKey = new Map(state.refs.map((ref) => [ref.externalTaskKey, ref]));
      const currentById = new Map(state.refTasks.map((task) => [task.id, task]));
      const unchangedByKey = new Map<string, string>();
      for (const [key, ref] of refByKey) {
        if (state.diff.unchangedTaskIds.includes(ref.taskId)) unchangedByKey.set(key, ref.taskId);
      }
      const tasksToCreate = input.tasks
        .map(normalizedTask)
        .filter((task) => {
          const ref = refByKey.get(task.externalTaskKey);
          return !ref || !state.diff.unchangedTaskIds.includes(ref.taskId);
        });
      const createdRows = tasksToCreate.length > 0
        ? await tx
            .insert(tasks)
            .values(
              tasksToCreate.map((task) => {
                const date = parseDateKey(task.date)!;
                return {
                  workspaceId: input.workspaceId,
                  planId: state.plan.id,
                  title: task.title,
                  notes: task.notes,
                  date,
                  originalDate: date,
                  daySegment: task.daySegment,
                  status: "todo" as const,
                  blocked: task.blocked,
                  priority: task.priority,
                  estimatedMinutes: task.estimatedMinutes,
                  energyLevel: task.energyLevel,
                  movable: task.movable,
                  projectId: task.projectId,
                  milestoneId: task.milestoneId,
                  parentTaskId: null,
                };
              }),
            )
            .returning()
        : [];
      const createdByKey = new Map(tasksToCreate.map((task, index) => [task.externalTaskKey, createdRows[index]]));
      const taskIdByExternalKey = new Map([...unchangedByKey, ...[...createdByKey].map(([key, row]) => [key, row.id] as const)]);

      for (const task of tasksToCreate) {
        if (!task.parentExternalTaskKey) continue;
        const taskId = taskIdByExternalKey.get(task.externalTaskKey);
        const parentTaskId = taskIdByExternalKey.get(task.parentExternalTaskKey);
        if (!taskId || !parentTaskId) {
          throw new ReplacePlanWindowError("parent_cycle", "Parent task mapping was incomplete", 409);
        }
        await tx
          .update(tasks)
          .set({ parentTaskId, updatedAt: now })
          .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, input.workspaceId), eq(tasks.planId, state.plan.id)));
      }

      const [revision] = await tx
        .insert(planWindowRevisions)
        .values({
          workspaceId: input.workspaceId,
          planId: state.plan.id,
          operationId: claim.operation.id,
          windowStart: parseDateKey(input.dateFrom)!,
          windowEnd: parseDateKey(input.dateTo)!,
          sourceKey: input.sourceKey.trim(),
          baseVersionId: state.plan.currentVersionId,
          requestHash,
          diffJson: state.diff,
          resultJson: {},
        })
        .returning();

      for (const [externalTaskKey, taskId] of taskIdByExternalKey) {
        await tx
          .insert(planWindowTaskRefs)
          .values({
            workspaceId: input.workspaceId,
            planId: state.plan.id,
            sourceKey: input.sourceKey.trim(),
            externalTaskKey,
            taskId,
            revisionId: revision.id,
          })
          .onConflictDoUpdate({
            target: [
              planWindowTaskRefs.planId,
              planWindowTaskRefs.sourceKey,
              planWindowTaskRefs.externalTaskKey,
            ],
            set: { taskId, revisionId: revision.id },
          });
      }

      const activeTaskIds = input.tasks.map((task) => taskIdByExternalKey.get(task.externalTaskKey.trim())!).filter(Boolean);
      const nextSnapshot = snapshotWithWindow(state.plan.baselineSnapshot, input, revision.id, activeTaskIds);
      const [version] = await tx
        .insert(planVersions)
        .values({
          workspaceId: input.workspaceId,
          planId: state.plan.id,
          versionNumber: (await latestVersionNumber(tx, input.workspaceId, state.plan.id)) + 1,
          snapshot: nextSnapshot,
          source: "mcp",
        })
        .returning();
      const updatedPlans = await tx
        .update(plans)
        .set({ baselineSnapshot: nextSnapshot, currentVersionId: version.id, updatedAt: now })
        .where(and(eq(plans.id, state.plan.id), eq(plans.workspaceId, input.workspaceId), eq(plans.status, "active")))
        .returning({ id: plans.id, currentVersionId: plans.currentVersionId });
      if (updatedPlans.length !== 1) {
        throw new ReplacePlanWindowError("stale_plan_version", "Active plan changed during replacement", 409);
      }

      const createdTaskIds = createdRows.map((task: TaskRow) => task.id);
      const result: ReplacePlanWindowResult = {
        status: "succeeded",
        operationId: claim.operation.id,
        revisionId: revision.id,
        planId: state.plan.id,
        currentVersionId: version.id,
        window: { dateFrom: input.dateFrom, dateTo: input.dateTo },
        createdTaskIds,
        archivedTaskIds,
        unchangedTaskIds: state.diff.unchangedTaskIds,
        preservedDoneTaskIds: state.diff.preservedDoneTaskIds,
        failedTaskIds: [],
        readback: failedReadback(new Error("Post-commit readback is pending")),
      };
      await tx
        .update(planWindowRevisions)
        .set({ resultJson: result })
        .where(and(eq(planWindowRevisions.id, revision.id), eq(planWindowRevisions.workspaceId, input.workspaceId)));
      await tx.insert(changeLogs).values({
        workspaceId: input.workspaceId,
        planId: state.plan.id,
        source: "mcp",
        summary: "Replaced active plan window",
        detailsJson: {
          operationId: claim.operation.id,
          revisionId: revision.id,
          sourceKey: input.sourceKey.trim(),
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
          retireScope: input.retireScope,
          createdBy: input.createdBy ?? "codex",
          createdTaskIds,
          archivedTaskIds,
          unchangedTaskIds: state.diff.unchangedTaskIds,
          preservedDoneTaskIds: state.diff.preservedDoneTaskIds,
        },
      });
      await tx
        .update(planOperations)
        .set({ status: "succeeded", resultJson: result, leaseExpiresAt: null, updatedAt: now })
        .where(and(eq(planOperations.id, claim.operation.id), eq(planOperations.workspaceId, input.workspaceId)));
      return result;
    });
  } catch (error) {
    await markOperationFailed(db, claim.operation.id, input.workspaceId, error);
    throw error;
  }
  return attachPostCommitReadback(db, input, committed);
}
