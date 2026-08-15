import { and, eq, gte, inArray, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { projectMilestones, projects, tasks } from "@/lib/db/schema";
import { getActivePlanId } from "@/lib/planning/active-plan";

export type ProjectPortfolioFilters = {
  status?: Array<"active" | "paused" | "completed" | "archived">;
  category?: string[];
  include_milestones: boolean;
  include_task_summary: boolean;
};

export type TaskContextFilters = {
  status?: "todo" | "done" | "skipped" | "backlog";
  date_from?: string;
  date_to?: string;
  project_ids?: string[];
  milestone_ids?: string[];
  parent_task_id?: string;
  overdue_as_of?: string;
  archive_state?: "active" | "archived" | "all";
};

type ReadDb = {
  select: (...args: any[]) => any;
};

const TASK_STATUSES = ["todo", "done", "skipped", "backlog"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

function parseDateBoundary(value: string) {
  return new Date(`${value}T00:00:00.000+08:00`);
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
  return `${year}-${month}-${day}`;
}

function serializeDates<T extends Record<string, any>>(row: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  );
}

function taskCounts() {
  return { todo: 0, done: 0, skipped: 0, backlog: 0 };
}

function archiveFilter(archiveState: TaskContextFilters["archive_state"] = "active") {
  if (archiveState === "all") return undefined;
  return archiveState === "archived" ? isNotNull(tasks.archivedAt) : isNull(tasks.archivedAt);
}

function buildTaskFilters(workspaceId: string, planId: string, args: TaskContextFilters) {
  const filters: SQL[] = [eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId)];
  const archived = archiveFilter(args.archive_state);
  if (archived) filters.push(archived);
  if (args.status) filters.push(eq(tasks.status, args.status));
  if (args.date_from) filters.push(gte(tasks.date, parseDateBoundary(args.date_from)));
  if (args.date_to) filters.push(lt(tasks.date, parseDateBoundary(args.date_to)));
  if (args.project_ids) filters.push(inArray(tasks.projectId, args.project_ids));
  if (args.milestone_ids) filters.push(inArray(tasks.milestoneId, args.milestone_ids));
  if (args.parent_task_id) filters.push(eq(tasks.parentTaskId, args.parent_task_id));
  if (args.overdue_as_of) {
    filters.push(eq(tasks.status, "todo"));
    filters.push(lt(tasks.date, parseDateBoundary(args.overdue_as_of)));
  }
  return filters;
}

export async function getTasksWithProjectContext(
  db: ReadDb,
  workspaceId: string,
  args: TaskContextFilters,
) {
  const planId = await getActivePlanId(db, workspaceId);
  if (!planId) return { workspaceId, filters: args, tasks: [] };
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...buildTaskFilters(workspaceId, planId, args)))
    .orderBy(tasks.date, tasks.daySegment, tasks.createdAt);

  const projectIds = [...new Set(rows.map((row: any) => row.projectId).filter(Boolean))] as string[];
  const milestoneIds = [...new Set(rows.map((row: any) => row.milestoneId).filter(Boolean))] as string[];
  const parentTaskIds = [...new Set(rows.map((row: any) => row.parentTaskId).filter(Boolean))] as string[];

  const [projectRows, milestoneRows, parentRows] = await Promise.all([
    projectIds.length
      ? db
          .select()
          .from(projects)
          .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, projectIds)))
      : Promise.resolve([]),
    milestoneIds.length
      ? db
          .select()
          .from(projectMilestones)
          .where(and(eq(projectMilestones.workspaceId, workspaceId), inArray(projectMilestones.id, milestoneIds)))
      : Promise.resolve([]),
    parentTaskIds.length
      ? db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.workspaceId, workspaceId),
              eq(tasks.planId, planId),
              inArray(tasks.id, parentTaskIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  const projectById = new Map(projectRows.map((row: any) => [row.id, row]));
  const milestoneById = new Map(milestoneRows.map((row: any) => [row.id, row]));
  const parentById = new Map(parentRows.map((row: any) => [row.id, row]));

  return {
    workspaceId,
    filters: args,
    tasks: rows.map((task: any) => {
      const project: any = task.projectId ? projectById.get(task.projectId) : null;
      const milestone: any = task.milestoneId ? milestoneById.get(task.milestoneId) : null;
      const parent: any = task.parentTaskId ? parentById.get(task.parentTaskId) : null;

      return {
        ...serializeDates(task),
        project: project
          ? {
              id: project.id,
              name: project.name,
              category: project.category ?? null,
              status: project.status,
              priority: project.priority,
              targetDate: project.targetDate instanceof Date ? project.targetDate.toISOString() : project.targetDate ?? null,
            }
          : null,
        milestone: milestone
          ? {
              id: milestone.id,
              title: milestone.title,
              status: milestone.status,
              targetDate:
                milestone.targetDate instanceof Date ? milestone.targetDate.toISOString() : milestone.targetDate ?? null,
            }
          : null,
        parentTask: parent
          ? {
              id: parent.id,
              title: parent.title,
              status: parent.status,
              date: parent.date instanceof Date ? parent.date.toISOString() : parent.date,
            }
          : null,
      };
    }),
  };
}

export async function getProjectPortfolio(
  db: ReadDb,
  workspaceId: string,
  args: ProjectPortfolioFilters,
) {
  const planId = await getActivePlanId(db, workspaceId);
  const projectFilters: SQL[] = [eq(projects.workspaceId, workspaceId)];
  if (args.status) projectFilters.push(inArray(projects.status, args.status));
  if (args.category) projectFilters.push(inArray(projects.category, args.category));

  const projectRows = await db
    .select()
    .from(projects)
    .where(and(...projectFilters))
    .orderBy(projects.priority, projects.targetDate, projects.createdAt);
  const projectIds = projectRows.map((project: any) => project.id) as string[];

  const [milestoneRows, taskRows] = await Promise.all([
    args.include_milestones && projectIds.length
      ? db
          .select()
          .from(projectMilestones)
          .where(and(eq(projectMilestones.workspaceId, workspaceId), inArray(projectMilestones.projectId, projectIds)))
          .orderBy(projectMilestones.position, projectMilestones.targetDate, projectMilestones.createdAt)
      : Promise.resolve([]),
    args.include_task_summary && planId
      ? db
          .select()
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId), isNull(tasks.archivedAt)))
      : Promise.resolve([]),
  ]);

  const today = parseDateBoundary(shanghaiDateKey(new Date()));
  const milestonesByProject = new Map<string, Array<Record<string, unknown>>>();
  for (const milestone of milestoneRows as any[]) {
    if (!projectIds.includes(milestone.projectId)) continue;
    const current = milestonesByProject.get(milestone.projectId) ?? [];
    current.push(serializeDates(milestone));
    milestonesByProject.set(milestone.projectId, current);
  }

  const summariesByProject = new Map<
    string,
    { taskCounts: ReturnType<typeof taskCounts>; overdueCount: number; unassignedMilestoneTaskCount: number }
  >();
  const workspaceTaskCounts = taskCounts();
  let workspaceOverdueCount = 0;
  let unassignedProjectTaskCount = 0;
  let unassignedMilestoneTaskCount = 0;

  for (const task of taskRows as any[]) {
    const status = task.status;
    if (isTaskStatus(status)) workspaceTaskCounts[status] += 1;
    const overdue = task.status === "todo" && task.date instanceof Date && task.date < today;
    if (overdue) workspaceOverdueCount += 1;
    if (!task.projectId) {
      unassignedProjectTaskCount += 1;
      continue;
    }
    if (!task.milestoneId) unassignedMilestoneTaskCount += 1;
    if (!projectIds.includes(task.projectId)) continue;

    const summary = summariesByProject.get(task.projectId) ?? {
      taskCounts: taskCounts(),
      overdueCount: 0,
      unassignedMilestoneTaskCount: 0,
    };
    if (isTaskStatus(status)) summary.taskCounts[status] += 1;
    if (overdue) summary.overdueCount += 1;
    if (!task.milestoneId) summary.unassignedMilestoneTaskCount += 1;
    summariesByProject.set(task.projectId, summary);
  }

  const needsDefinitionProjects = projectRows
    .filter((project: any) => project.needsDefinition)
    .map((project: any) => ({ id: project.id, name: project.name }));

  return {
    workspaceId,
    filters: args,
    asOfDate: shanghaiDateKey(new Date()),
    projects: projectRows.map((project: any) => ({
      ...serializeDates(project),
      ...(args.include_milestones ? { milestones: milestonesByProject.get(project.id) ?? [] } : {}),
      ...(args.include_task_summary
        ? {
            taskSummary: summariesByProject.get(project.id) ?? {
              taskCounts: taskCounts(),
              overdueCount: 0,
              unassignedMilestoneTaskCount: 0,
            },
          }
        : {}),
    })),
    summary: {
      projectCount: projectRows.length,
      needsDefinitionProjects,
      ...(args.include_task_summary
        ? {
            taskCounts: workspaceTaskCounts,
            overdueCount: workspaceOverdueCount,
            unassignedProjectTaskCount,
            unassignedMilestoneTaskCount,
          }
        : {}),
    },
  };
}
