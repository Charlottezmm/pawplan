import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { projects, tasks } from "@/lib/db/schema";
import { getActivePlanId } from "@/lib/planning/active-plan";

export type LegacySkippedViewData = {
  dataUnavailable: boolean;
  tasks: Array<{
    id: string;
    title: string;
    date: string;
    estimatedMinutes: number;
    projectId: string | null;
    projectName: string;
    projectColor: string;
  }>;
};

function dateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isMissingDatabase(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  return code === "42P01" || code === "42703";
}

export async function getLegacySkippedTasks(workspaceId: string): Promise<LegacySkippedViewData> {
  try {
    const db = getDb();
    const planId = await getActivePlanId(db, workspaceId);
    if (!planId) return { dataUnavailable: false, tasks: [] };
    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        date: tasks.date,
        estimatedMinutes: tasks.estimatedMinutes,
        projectId: tasks.projectId,
        projectName: projects.name,
        projectColor: projects.color,
      })
      .from(tasks)
      .leftJoin(projects, and(eq(tasks.projectId, projects.id), eq(projects.workspaceId, workspaceId)))
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.planId, planId),
          eq(tasks.status, "skipped"),
          isNull(tasks.archivedAt),
        ),
      )
      .orderBy(desc(tasks.updatedAt));
    return {
      dataUnavailable: false,
      tasks: rows.map((task) => ({
        ...task,
        date: dateKey(task.date),
        projectName: task.projectName ?? "未关联项目",
        projectColor: task.projectColor ?? "#a89f8d",
      })),
    };
  } catch (error) {
    if (isMissingDatabase(error)) return { dataUnavailable: true, tasks: [] };
    throw error;
  }
}
