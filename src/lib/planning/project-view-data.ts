import { and, desc, eq, gte, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { projectMilestones, projects, tasks } from "@/lib/db/schema";
import { getActivePlanId } from "@/lib/planning/active-plan";

type ProjectStatus = "active" | "paused" | "completed" | "archived";
type Priority = "low" | "normal" | "high" | "urgent";
type TaskStatus = "todo" | "done" | "skipped" | "backlog";

type ProjectRow = {
  id: string;
  name: string;
  color: string;
  category: string | null;
  objective: string | null;
  successCriteria: string | null;
  status: ProjectStatus;
  priority: Priority;
  startDate: Date | null;
  targetDate: Date | null;
  weeklyTargetMinutes: number | null;
  needsDefinition: boolean;
  updatedAt: Date;
};

type MilestoneRow = {
  id: string;
  projectId: string;
  title: string;
  objective: string | null;
  successCriteria: string | null;
  targetDate: Date | null;
  status: "planned" | "in_progress" | "completed" | "skipped";
  position: number;
};

type TaskSummaryRow = {
  id?: string;
  projectId: string | null;
  status: TaskStatus;
  title?: string;
  milestoneId?: string | null;
  parentTaskId?: string | null;
  priority?: Priority;
  date?: Date;
};

export type ProjectPortfolioItemView = {
  id: string;
  name: string;
  color: string;
  category: string | null;
  objective: string | null;
  successCriteria: string | null;
  status: ProjectStatus;
  priority: Priority;
  startDate: string | null;
  targetDate: string | null;
  weeklyTargetMinutes: number | null;
  needsDefinition: boolean;
  taskCounts: Record<TaskStatus, number>;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    priority: Priority;
    date: string | null;
    milestoneId: string | null;
    milestoneTitle: string | null;
    parentTaskId: string | null;
    parentTitle: string | null;
  }>;
  milestones: Array<{
    id: string;
    title: string;
    objective: string | null;
    successCriteria: string | null;
    targetDate: string | null;
    status: MilestoneRow["status"];
  }>;
};

export type ProjectPortfolioViewData = {
  dataUnavailable: boolean;
  projects: ProjectPortfolioItemView[];
};

type BacklogTaskRow = {
  id: string;
  title: string;
  notes: string | null;
  projectId: string | null;
  priority: Priority;
  estimatedMinutes: number;
  updatedAt: Date;
};

export type BacklogViewData = {
  dataUnavailable: boolean;
  totalCount: number;
  groups: Array<{
    projectId: string | null;
    projectName: string;
    category: string | null;
    color: string;
    tasks: Array<{
      id: string;
      title: string;
      notes: string | null;
      priority: Priority;
      estimatedMinutes: number;
      updatedLabel: string;
    }>;
  }>;
};

export type ArchiveHistoryFilters = {
  status?: TaskStatus;
  projectId?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type ArchiveHistoryViewData = {
  dataUnavailable: boolean;
  totalCount: number;
  totalMinutes: number;
  filters: ArchiveHistoryFilters;
  projects: Array<{ id: string; name: string }>;
  groups: Array<{
    projectId: string | null;
    projectName: string;
    category: string | null;
    color: string;
    tasks: Array<{
      id: string;
      title: string;
      status: TaskStatus;
      date: string | null;
      estimatedMinutes: number;
      archivedLabel: string;
    }>;
  }>;
};

function dateKey(date: Date | null) {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function updatedLabel(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function isMissingDatabase(error: unknown) {
  return error instanceof Error && error.message.includes("DATABASE_URL is required");
}

export function buildProjectPortfolioData(
  projectRows: ProjectRow[],
  milestoneRows: MilestoneRow[],
  taskRows: TaskSummaryRow[],
): ProjectPortfolioItemView[] {
  const taskCounts = new Map<string, Record<TaskStatus, number>>();
  taskRows.forEach((task) => {
    if (!task.projectId) return;
    const counts = taskCounts.get(task.projectId) ?? { todo: 0, done: 0, skipped: 0, backlog: 0 };
    counts[task.status] += 1;
    taskCounts.set(task.projectId, counts);
  });

  const milestonesByProject = new Map<string, MilestoneRow[]>();
  milestoneRows.forEach((milestone) => {
    const values = milestonesByProject.get(milestone.projectId) ?? [];
    values.push(milestone);
    milestonesByProject.set(milestone.projectId, values);
  });
  const taskTitles = new Map(taskRows.flatMap((task) => task.id && task.title ? [[task.id, task.title]] : []));
  const milestoneTitles = new Map(milestoneRows.map((milestone) => [milestone.id, milestone.title]));
  const tasksByProject = new Map<string, TaskSummaryRow[]>();
  taskRows.forEach((task) => {
    if (!task.projectId || !task.id || !task.title) return;
    const values = tasksByProject.get(task.projectId) ?? [];
    values.push(task);
    tasksByProject.set(task.projectId, values);
  });

  return [...projectRows]
    .sort((a, b) => {
      const statusOrder: Record<ProjectStatus, number> = { active: 0, paused: 1, completed: 2, archived: 3 };
      const priorityOrder: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
      return statusOrder[a.status] - statusOrder[b.status] || priorityOrder[a.priority] - priorityOrder[b.priority] || a.name.localeCompare(b.name, "zh-CN");
    })
    .map((project) => ({
      id: project.id,
      name: project.name,
      color: project.color,
      category: project.category,
      objective: project.objective,
      successCriteria: project.successCriteria,
      status: project.status,
      priority: project.priority,
      startDate: dateKey(project.startDate),
      targetDate: dateKey(project.targetDate),
      weeklyTargetMinutes: project.weeklyTargetMinutes,
      needsDefinition: project.needsDefinition,
      taskCounts: taskCounts.get(project.id) ?? { todo: 0, done: 0, skipped: 0, backlog: 0 },
      tasks: (tasksByProject.get(project.id) ?? [])
        .sort((a, b) => {
          if (!a.parentTaskId && b.parentTaskId) return -1;
          if (a.parentTaskId && !b.parentTaskId) return 1;
          return (a.date?.getTime() ?? Number.POSITIVE_INFINITY) - (b.date?.getTime() ?? Number.POSITIVE_INFINITY)
            || (a.title ?? "").localeCompare(b.title ?? "", "zh-CN");
        })
        .map((task) => ({
          id: task.id!,
          title: task.title!,
          status: task.status,
          priority: task.priority ?? "normal",
          date: dateKey(task.date ?? null),
          milestoneId: task.milestoneId ?? null,
          milestoneTitle: task.milestoneId ? milestoneTitles.get(task.milestoneId) ?? null : null,
          parentTaskId: task.parentTaskId ?? null,
          parentTitle: task.parentTaskId ? taskTitles.get(task.parentTaskId) ?? null : null,
        })),
      milestones: (milestonesByProject.get(project.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .map((milestone) => ({
          id: milestone.id,
          title: milestone.title,
          objective: milestone.objective,
          successCriteria: milestone.successCriteria,
          targetDate: dateKey(milestone.targetDate),
          status: milestone.status,
        })),
    }));
}

export function buildBacklogData(projectRows: Array<Pick<ProjectRow, "id" | "name" | "category" | "color">>, taskRows: BacklogTaskRow[]): BacklogViewData {
  const projectMap = new Map(projectRows.map((project) => [project.id, project]));
  const groups = new Map<string, BacklogViewData["groups"][number]>();

  taskRows.forEach((task) => {
    const project = task.projectId ? projectMap.get(task.projectId) : null;
    const key = project?.id ?? "unassigned";
    const group = groups.get(key) ?? {
      projectId: project?.id ?? null,
      projectName: project?.name ?? "未关联 Project",
      category: project?.category ?? null,
      color: project?.color ?? "#a89f8d",
      tasks: [],
    };
    group.tasks.push({
      id: task.id,
      title: task.title,
      notes: task.notes,
      priority: task.priority,
      estimatedMinutes: task.estimatedMinutes,
      updatedLabel: updatedLabel(task.updatedAt),
    });
    groups.set(key, group);
  });

  return {
    dataUnavailable: false,
    totalCount: taskRows.length,
    groups: [...groups.values()].sort((a, b) => {
      if (a.projectId === null) return 1;
      if (b.projectId === null) return -1;
      return a.projectName.localeCompare(b.projectName, "zh-CN");
    }),
  };
}

export async function getProjectPortfolioData(workspaceId: string): Promise<ProjectPortfolioViewData> {
  try {
    const db = getDb();
    const planId = await getActivePlanId(db, workspaceId);
    const [projectRows, milestoneRows, taskRows] = await Promise.all([
      db.select().from(projects).where(eq(projects.workspaceId, workspaceId)),
      db.select().from(projectMilestones).where(eq(projectMilestones.workspaceId, workspaceId)),
      planId
        ? db
            .select({
              id: tasks.id,
              projectId: tasks.projectId,
              status: tasks.status,
              title: tasks.title,
              milestoneId: tasks.milestoneId,
              parentTaskId: tasks.parentTaskId,
              priority: tasks.priority,
              date: tasks.date,
            })
            .from(tasks)
            .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.planId, planId), isNull(tasks.archivedAt)))
        : Promise.resolve([]),
    ]);
    return { dataUnavailable: false, projects: buildProjectPortfolioData(projectRows, milestoneRows, taskRows) };
  } catch (error) {
    if (isMissingDatabase(error)) return { dataUnavailable: true, projects: [] };
    throw error;
  }
}

export async function getBacklogPageData(workspaceId: string): Promise<BacklogViewData> {
  try {
    const db = getDb();
    const planId = await getActivePlanId(db, workspaceId);
    if (!planId) return { dataUnavailable: false, totalCount: 0, groups: [] };
    const [projectRows, taskRows] = await Promise.all([
      db
        .select({ id: projects.id, name: projects.name, category: projects.category, color: projects.color })
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId)),
      db
        .select({
          id: tasks.id,
          title: tasks.title,
          notes: tasks.notes,
          projectId: tasks.projectId,
          priority: tasks.priority,
          estimatedMinutes: tasks.estimatedMinutes,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.planId, planId),
            eq(tasks.status, "backlog"),
            isNull(tasks.archivedAt),
          ),
        )
        .orderBy(desc(tasks.updatedAt)),
    ]);
    return buildBacklogData(projectRows, taskRows);
  } catch (error) {
    if (isMissingDatabase(error)) return { dataUnavailable: true, totalCount: 0, groups: [] };
    throw error;
  }
}

export async function getBacklogCount(workspaceId: string) {
  const data = await getBacklogPageData(workspaceId);
  return { dataUnavailable: data.dataUnavailable, count: data.totalCount };
}

function parseArchiveBoundary(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function getArchiveHistoryPageData(
  workspaceId: string,
  filters: ArchiveHistoryFilters = {},
): Promise<ArchiveHistoryViewData> {
  try {
    const db = getDb();
    const planId = await getActivePlanId(db, workspaceId);
    if (!planId) {
      return { dataUnavailable: false, totalCount: 0, totalMinutes: 0, filters, projects: [], groups: [] };
    }
    const conditions: SQL[] = [
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.planId, planId),
      isNotNull(tasks.archivedAt),
    ];
    if (filters.status) conditions.push(eq(tasks.status, filters.status));
    if (filters.projectId) conditions.push(eq(tasks.projectId, filters.projectId));
    const dateFrom = parseArchiveBoundary(filters.dateFrom);
    const dateTo = parseArchiveBoundary(filters.dateTo);
    if (dateFrom) conditions.push(gte(tasks.date, dateFrom));
    if (dateTo) conditions.push(lt(tasks.date, dateTo));

    const [projectRows, taskRows] = await Promise.all([
      db
        .select({ id: projects.id, name: projects.name, category: projects.category, color: projects.color })
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId)),
      db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          date: tasks.date,
          projectId: tasks.projectId,
          estimatedMinutes: tasks.estimatedMinutes,
          archivedAt: tasks.archivedAt,
        })
        .from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.archivedAt), tasks.date),
    ]);
    const projectMap = new Map(projectRows.map((project) => [project.id, project]));
    const groups = new Map<string, ArchiveHistoryViewData["groups"][number]>();
    for (const task of taskRows) {
      const project = task.projectId ? projectMap.get(task.projectId) : null;
      const key = project?.id ?? "unassigned";
      const group = groups.get(key) ?? {
        projectId: project?.id ?? null,
        projectName: project?.name ?? "未关联 Project",
        category: project?.category ?? null,
        color: project?.color ?? "#a89f8d",
        tasks: [],
      };
      group.tasks.push({
        id: task.id,
        title: task.title,
        status: task.status,
        date: dateKey(task.date),
        estimatedMinutes: task.estimatedMinutes,
        archivedLabel: updatedLabel(task.archivedAt!),
      });
      groups.set(key, group);
    }
    return {
      dataUnavailable: false,
      totalCount: taskRows.length,
      totalMinutes: taskRows.reduce((sum, task) => sum + task.estimatedMinutes, 0),
      filters,
      projects: projectRows.map((project) => ({ id: project.id, name: project.name })),
      groups: [...groups.values()],
    };
  } catch (error) {
    if (isMissingDatabase(error)) {
      return { dataUnavailable: true, totalCount: 0, totalMinutes: 0, filters, projects: [], groups: [] };
    }
    throw error;
  }
}
