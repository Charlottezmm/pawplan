import { and, desc, eq } from "drizzle-orm";
import { changeLogs, mcpPlanImports, plans, planVersions, projects, tasks, tracks } from "@/lib/db/schema";

type PlanningDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

type CreatedBy = "codex" | "claude" | "user";
type DaySegment = "morning" | "afternoon" | "evening";
type Priority = "low" | "normal" | "high" | "urgent";
type EnergyLevel = "low" | "medium" | "high";

export type McpPlanImportInput = {
  workspaceId: string;
  importKey: string;
  createdBy: CreatedBy;
  sourceLabel?: string | null;
  overallPlan: {
    title: string;
    summary: string;
  };
  dailyTasks: Array<{
    title: string;
    date: string;
    daySegment: DaySegment;
    estimatedMinutes: number;
    priority?: Priority;
    energyLevel?: EnergyLevel;
    notes?: string;
    projectName?: string;
    trackName?: string;
  }>;
  weeklySummary: {
    weekStart: string;
    focus: string;
    milestones: string[];
  };
  monthlySummary: {
    month: string;
    goal: string;
    milestones: string[];
  };
};

export class McpPlanImportError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function parseDateBoundary(value: string) {
  return new Date(`${value}T00:00:00.000+08:00`);
}

function validDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = parseDateBoundary(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}` === value;
}

function normalizeName(value?: string) {
  const normalized = value?.trim();
  return normalized || null;
}

function validateMcpPlanImportInput(input: McpPlanImportInput) {
  if (!validDateKey(input.weeklySummary.weekStart)) throw new McpPlanImportError("Invalid MCP plan week start", 400);
  const seenTasks = new Set<string>();

  for (const task of input.dailyTasks) {
    if (!validDateKey(task.date)) throw new McpPlanImportError("Invalid MCP plan task date", 400);
    const key = `${task.title.trim().toLowerCase()}|${task.date}|${task.daySegment}`;
    if (seenTasks.has(key)) throw new McpPlanImportError("Duplicate MCP plan task", 400);
    seenTasks.add(key);
  }
}

function snakePayload(input: McpPlanImportInput) {
  return {
    import_key: input.importKey,
    created_by: input.createdBy,
    source_label: input.sourceLabel ?? null,
    overall_plan: input.overallPlan,
    daily_tasks: input.dailyTasks.map((task) => ({
      title: task.title,
      date: task.date,
      day_segment: task.daySegment,
      estimated_minutes: task.estimatedMinutes,
      priority: task.priority ?? "normal",
      energy_level: task.energyLevel ?? "medium",
      notes: task.notes ?? null,
      project_name: normalizeName(task.projectName),
      track_name: normalizeName(task.trackName),
    })),
    weekly_summary: {
      week_start: input.weeklySummary.weekStart,
      focus: input.weeklySummary.focus,
      milestones: input.weeklySummary.milestones,
    },
    monthly_summary: input.monthlySummary,
  };
}

async function requireActivePlan(db: PlanningDb, workspaceId: string) {
  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.workspaceId, workspaceId), eq(plans.status, "active")))
    .limit(1);

  if (!plan) throw new McpPlanImportError("No active plan", 400);
  return plan as { id: string; baselineSnapshot: Record<string, unknown> };
}

async function findExistingImport(db: PlanningDb, workspaceId: string, importKey: string) {
  const [existing] = await db
    .select()
    .from(mcpPlanImports)
    .where(and(eq(mcpPlanImports.workspaceId, workspaceId), eq(mcpPlanImports.importKey, importKey)))
    .limit(1);

  return existing as
    | {
        id: string;
        planId: string;
        taskCount: number;
        derivedTaskIds?: unknown;
      }
    | undefined;
}

async function latestVersionNumber(db: PlanningDb, workspaceId: string, planId: string) {
  const [latest] = await db
    .select({ versionNumber: planVersions.versionNumber })
    .from(planVersions)
    .where(and(eq(planVersions.workspaceId, workspaceId), eq(planVersions.planId, planId)))
    .orderBy(desc(planVersions.versionNumber))
    .limit(1);

  return Number(latest?.versionNumber ?? 0);
}

async function idsByName(
  db: PlanningDb,
  table: typeof projects | typeof tracks,
  workspaceId: string,
  names: string[],
  createValues: (name: string) => Record<string, unknown>,
) {
  if (names.length === 0) return new Map<string, string>();

  const existingRows = (await db.select().from(table).where(eq(table.workspaceId, workspaceId))) as Array<{
    id: string;
    name: string;
  }>;
  const ids = new Map(existingRows.map((row) => [row.name, row.id]));

  for (const name of names) {
    if (ids.has(name)) continue;
    const [created] = await db
      .insert(table)
      .values({
        workspaceId,
        name,
        ...createValues(name),
      })
      .returning();
    ids.set(name, created.id);
  }

  return ids;
}

function uniqueNames(tasksToImport: McpPlanImportInput["dailyTasks"], key: "projectName" | "trackName") {
  return Array.from(new Set(tasksToImport.map((task) => normalizeName(task[key])).filter((name): name is string => Boolean(name))));
}

function buildActivePlanSnapshot(
  planSnapshot: Record<string, unknown>,
  input: McpPlanImportInput,
  derivedTaskIds: string[],
) {
  const payload = snakePayload(input);
  return {
    ...planSnapshot,
    ...payload,
    importSummary: {
      type: "mcp_plan_bundle",
      importKey: input.importKey,
      createdBy: input.createdBy,
      sourceLabel: input.sourceLabel ?? null,
      taskCount: derivedTaskIds.length,
      derivedTaskIds,
    },
  };
}

function derivedTaskIdsFromExisting(value: unknown) {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export async function saveMcpPlanImport(db: PlanningDb, input: McpPlanImportInput) {
  validateMcpPlanImportInput(input);

  return db.transaction(async (tx) => {
    const existing = await findExistingImport(tx, input.workspaceId, input.importKey);
    if (existing) {
      return {
        imported: false as const,
        duplicate: true as const,
        importId: existing.id,
        planId: existing.planId,
        tasksCreated: existing.taskCount,
        taskIds: derivedTaskIdsFromExisting(existing.derivedTaskIds),
      };
    }

    const plan = await requireActivePlan(tx, input.workspaceId);
    const projectIds = await idsByName(tx, projects, input.workspaceId, uniqueNames(input.dailyTasks, "projectName"), () => ({}));
    const trackIds = await idsByName(tx, tracks, input.workspaceId, uniqueNames(input.dailyTasks, "trackName"), () => ({
      kind: "custom",
    }));

    const taskValues = input.dailyTasks.map((task) => {
      const projectName = normalizeName(task.projectName);
      const trackName = normalizeName(task.trackName);
      const date = parseDateBoundary(task.date);
      return {
        workspaceId: input.workspaceId,
        planId: plan.id,
        title: task.title,
        notes: task.notes ?? null,
        date,
        originalDate: date,
        daySegment: task.daySegment,
        priority: task.priority ?? "normal",
        estimatedMinutes: task.estimatedMinutes,
        energyLevel: task.energyLevel ?? "medium",
        status: "todo" as const,
        projectId: projectName ? projectIds.get(projectName) ?? null : null,
        trackId: trackName ? trackIds.get(trackName) ?? null : null,
      };
    });
    const createdTasks = await tx.insert(tasks).values(taskValues).returning();
    const derivedTaskIds = createdTasks.map((task: { id: string }) => task.id);
    const snapshot = snakePayload(input);
    const provenanceJson = {
      import_key: input.importKey,
      created_by: input.createdBy,
      source_label: input.sourceLabel ?? null,
      connector: "mcp",
    };
    const [importRow] = await tx
      .insert(mcpPlanImports)
      .values({
        workspaceId: input.workspaceId,
        planId: plan.id,
        importKey: input.importKey,
        createdBy: input.createdBy,
        sourceLabel: input.sourceLabel ?? null,
        taskCount: derivedTaskIds.length,
        snapshot,
        derivedTaskIds,
        provenanceJson,
      })
      .returning();

    const activePlanSnapshot = buildActivePlanSnapshot(plan.baselineSnapshot ?? {}, input, derivedTaskIds);
    const versionNumber = (await latestVersionNumber(tx, input.workspaceId, plan.id)) + 1;
    const [version] = await tx
      .insert(planVersions)
      .values({
        workspaceId: input.workspaceId,
        planId: plan.id,
        versionNumber,
        snapshot: activePlanSnapshot,
        source: "mcp",
      })
      .returning();

    await tx
      .update(plans)
      .set({
        baselineSnapshot: activePlanSnapshot,
        currentVersionId: version.id,
        updatedAt: new Date(),
      })
      .where(and(eq(plans.id, plan.id), eq(plans.workspaceId, input.workspaceId)));

    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId: plan.id,
      source: "mcp",
      summary: "Imported MCP plan bundle",
      detailsJson: {
        importId: importRow.id,
        importKey: input.importKey,
        createdBy: input.createdBy,
        sourceLabel: input.sourceLabel ?? null,
        taskCount: derivedTaskIds.length,
        derivedTaskIds,
      },
    });

    return {
      imported: true as const,
      duplicate: false as const,
      importId: importRow.id,
      planId: plan.id,
      tasksCreated: derivedTaskIds.length,
      taskIds: derivedTaskIds,
    };
  });
}
