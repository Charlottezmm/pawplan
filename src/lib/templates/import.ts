import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  courses,
  plans,
  planVersions,
  projectMilestones,
  projects,
  routines,
  segmentEnergySettings,
  tasks,
  timeBlockExceptions,
  timeBlocks,
  tracks,
} from "@/lib/db/schema";
import { pawPlanTemplateSchema, type PawPlanTemplate } from "@/lib/templates/export";

type TxLike = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

type DbLike = TxLike & {
  transaction: <T>(callback: (tx: TxLike) => Promise<T>) => Promise<T>;
};

export const templateImportRequestSchema = z
  .object({
    template: pawPlanTemplateSchema,
    mode: z.literal("new_plan"),
  })
  .strict();

export type TemplateImportRequest = z.infer<typeof templateImportRequestSchema>;

export class TemplateImportError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "template_import_failed",
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function validateTemplateReferences(template: PawPlanTemplate) {
  const timeBlockIds = new Set(template.timeBlocks.map((block) => block.id));
  const exceptionIds = new Set((template.timeBlockExceptions ?? []).map((exception) => exception.id));
  if (timeBlockIds.size !== template.timeBlocks.length) {
    throw new TemplateImportError("Template contains duplicate time block ids");
  }
  if (exceptionIds.size !== (template.timeBlockExceptions ?? []).length) {
    throw new TemplateImportError("Template contains duplicate time block exception ids");
  }
  for (const exception of template.timeBlockExceptions ?? []) {
    if (!timeBlockIds.has(exception.seriesId)) {
      throw new TemplateImportError("Template time block exception references an unknown series");
    }
  }

  if (template.schemaVersion !== "pawplan.template.v0.5") return;

  const projectIds = new Set(template.projects.map((project) => project.id));
  const milestoneById = new Map(template.milestones.map((milestone) => [milestone.id, milestone]));
  const taskById = new Map(template.tasks.map((task) => [task.id, task]));

  if (projectIds.size !== template.projects.length) {
    throw new TemplateImportError("Template contains duplicate project ids");
  }
  if (milestoneById.size !== template.milestones.length) {
    throw new TemplateImportError("Template contains duplicate milestone ids");
  }
  if (taskById.size !== template.tasks.length) {
    throw new TemplateImportError("Template contains duplicate task ids");
  }

  for (const milestone of template.milestones) {
    if (!projectIds.has(milestone.projectId)) {
      throw new TemplateImportError("Template milestone references an unknown project");
    }
  }

  for (const task of template.tasks) {
    if (task.projectId && !projectIds.has(task.projectId)) {
      throw new TemplateImportError("Template task references an unknown project");
    }
    if (task.milestoneId) {
      const milestone = milestoneById.get(task.milestoneId);
      if (!milestone) throw new TemplateImportError("Template task references an unknown milestone");
      if (task.projectId !== milestone.projectId) {
        throw new TemplateImportError("Template task and milestone must belong to the same project");
      }
    }
    if (task.parentTaskId) {
      const parent = taskById.get(task.parentTaskId);
      if (!parent) throw new TemplateImportError("Template task references an unknown parent task");
      if (parent.id === task.id) throw new TemplateImportError("Template task cannot be its own parent");
      if (parent.projectId !== task.projectId) {
        throw new TemplateImportError("Template parent and child tasks must belong to the same project");
      }
    }
  }

  for (const task of template.tasks) {
    const ancestors = new Set<string>([task.id]);
    let parentId = task.parentTaskId;
    while (parentId) {
      if (ancestors.has(parentId)) throw new TemplateImportError("Template task hierarchy contains a cycle");
      ancestors.add(parentId);
      parentId = taskById.get(parentId)?.parentTaskId ?? null;
    }
  }
}

function parseDate(value: string) {
  return new Date(value);
}

function planDateRange(template: PawPlanTemplate, now = new Date()) {
  const dates = [
    ...template.tasks.map((task) => parseDate(task.date)),
    ...template.timeBlocks.map((block) => parseDate(block.startsAt)),
    ...template.timeBlocks.map((block) => parseDate(block.endsAt)),
    ...(template.schemaVersion === "pawplan.template.v0.5"
      ? [
          ...template.projects.flatMap((project) =>
            [project.startDate, project.targetDate].filter((value): value is string => value !== null).map(parseDate),
          ),
          ...template.milestones.flatMap((milestone) =>
            milestone.targetDate ? [parseDate(milestone.targetDate)] : [],
          ),
        ]
      : []),
  ].filter((date) => !Number.isNaN(date.getTime()));

  if (dates.length === 0) {
    const end = new Date(now);
    end.setDate(end.getDate() + 30);
    return { startDate: now, endDate: end };
  }

  return {
    startDate: new Date(Math.min(...dates.map((date) => date.getTime()))),
    endDate: new Date(Math.max(...dates.map((date) => date.getTime()))),
  };
}

function mappedId(map: Map<string, string>, id: string | null) {
  if (!id) return null;
  return map.get(id) ?? null;
}

export async function importWorkspaceTemplate(
  db: DbLike,
  workspaceId: string,
  request: TemplateImportRequest,
  now: Date = new Date(),
) {
  const parsed = templateImportRequestSchema.safeParse(request);
  if (!parsed.success) throw new TemplateImportError("Invalid template import request", 400);

  const template = parsed.data.template;
  validateTemplateReferences(template);
  const range = planDateRange(template, now);
  const baselineSnapshot = {
    schemaVersion: template.schemaVersion,
    importedAt: now.toISOString(),
    source: "template",
    sourceWorkspaceName: template.workspace.name,
    counts: {
      tracks: template.tracks.length,
      projects: template.schemaVersion === "pawplan.template.v0.5" ? template.projects.length : 0,
      milestones: template.schemaVersion === "pawplan.template.v0.5" ? template.milestones.length : 0,
      courses: template.courses.length,
      routines: template.routines.length,
      timeBlocks: template.timeBlocks.length,
      timeBlockExceptions: (template.timeBlockExceptions ?? []).length,
      tasks: template.tasks.length,
    },
  };

  return db.transaction(async (tx) => {
    const activePlans = await tx
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.workspaceId, workspaceId), eq(plans.status, "active")))
      .limit(2);
    if (activePlans.length > 0) {
      throw new TemplateImportError(
        "Workspace already has an active plan; choose how to handle it before importing a new plan",
        409,
        "active_plan_conflict",
        { workspaceId, activePlanIds: activePlans.map((plan: { id: string }) => plan.id) },
      );
    }

    const [plan] = await tx
      .insert(plans)
      .values({
        workspaceId,
        title: `${template.workspace.name} Template`,
        startDate: range.startDate,
        endDate: range.endDate,
        status: "active",
        baselineSnapshot,
      })
      .returning();

    const [version] = await tx
      .insert(planVersions)
      .values({
        workspaceId,
        planId: plan.id,
        versionNumber: 1,
        snapshot: baselineSnapshot,
        source: "baseline",
      })
      .returning();

    await tx.update(plans).set({ currentVersionId: version.id }).where(eq(plans.id, plan.id));

    const projectRows =
      template.schemaVersion === "pawplan.template.v0.5" && template.projects.length > 0
        ? await tx
            .insert(projects)
            .values(
              template.projects.map((project) => ({
                workspaceId,
                name: project.name,
                color: project.color,
                category: project.category,
                objective: project.objective,
                successCriteria: project.successCriteria,
                status: project.status,
                priority: project.priority,
                startDate: project.startDate ? parseDate(project.startDate) : null,
                targetDate: project.targetDate ? parseDate(project.targetDate) : null,
                weeklyTargetMinutes: project.weeklyTargetMinutes,
                needsDefinition: project.needsDefinition,
              })),
            )
            .returning()
        : [];
    const projectIdMap = new Map(
      template.schemaVersion === "pawplan.template.v0.5"
        ? template.projects.map((project, index) => [project.id, projectRows[index]?.id])
        : [],
    );

    const milestoneRows =
      template.schemaVersion === "pawplan.template.v0.5" && template.milestones.length > 0
        ? await tx
            .insert(projectMilestones)
            .values(
              template.milestones.flatMap((milestone) => {
                const projectId = mappedId(projectIdMap, milestone.projectId);
                return projectId
                  ? [{
                      workspaceId,
                      projectId,
                      title: milestone.title,
                      objective: milestone.objective,
                      successCriteria: milestone.successCriteria,
                      targetDate: milestone.targetDate ? parseDate(milestone.targetDate) : null,
                      status: milestone.status,
                      position: milestone.position,
                    }]
                  : [];
              }),
            )
            .returning()
        : [];
    const importableMilestones =
      template.schemaVersion === "pawplan.template.v0.5"
        ? template.milestones.filter((milestone) => mappedId(projectIdMap, milestone.projectId) !== null)
        : [];
    const milestoneIdMap = new Map(
      importableMilestones.map((milestone, index) => [milestone.id, milestoneRows[index]?.id]),
    );

    const trackRows =
      template.tracks.length > 0
        ? await tx
            .insert(tracks)
            .values(
              template.tracks.map((track) => ({
                workspaceId,
                name: track.name,
                kind: track.kind,
                targetMinPercent: track.targetMinPercent,
                targetMaxPercent: track.targetMaxPercent,
                color: track.color,
              })),
            )
            .returning()
        : [];
    const trackIdMap = new Map(template.tracks.map((track, index) => [track.id, trackRows[index]?.id]));

    const courseRows =
      template.courses.length > 0
        ? await tx
            .insert(courses)
            .values(
              template.courses.map((course) => ({
                workspaceId,
                name: course.name,
                color: course.color,
              })),
            )
            .returning()
        : [];
    const courseIdMap = new Map(template.courses.map((course, index) => [course.id, courseRows[index]?.id]));

    if (template.routines.length > 0) {
      await tx.insert(routines).values(
        template.routines.map((routine) => ({
          workspaceId,
          title: routine.title,
          defaultTimeSegment: routine.defaultTimeSegment,
          defaultStartTime: routine.defaultStartTime,
          defaultEndTime: routine.defaultEndTime,
          weekdayPattern: routine.weekdayPattern,
          estimatedMinutes: routine.estimatedMinutes,
          energyLevel: routine.energyLevel,
        })),
      );
    }

    if (template.segmentEnergySettings.length > 0) {
      await tx.insert(segmentEnergySettings).values(
        template.segmentEnergySettings.map((setting) => ({
          workspaceId,
          segment: setting.segment,
          energyLevel: setting.energyLevel,
        })),
      );
    }

    const timeBlockRows = template.timeBlocks.length > 0
      ? await tx.insert(timeBlocks).values(
        template.timeBlocks.map((block) => ({
          workspaceId,
          title: block.title,
          kind: block.kind,
          startsAt: parseDate(block.startsAt),
          endsAt: parseDate(block.endsAt),
          recurrenceRule: block.recurrenceRule,
          recurrenceWeekdayMask: block.recurrenceWeekdayMask ?? null,
          courseId: mappedId(courseIdMap, block.courseId),
          trackId: mappedId(trackIdMap, block.trackId),
          movable: block.movable,
          protected: block.protected ?? true,
          estimatedMinutes: block.estimatedMinutes,
          energyLevel: block.energyLevel,
        })),
      ).returning()
      : [];
    const timeBlockIdMap = new Map(template.timeBlocks.map((block, index) => [block.id, timeBlockRows[index]?.id]));

    if ((template.timeBlockExceptions ?? []).length > 0) {
      await tx.insert(timeBlockExceptions).values(
        (template.timeBlockExceptions ?? []).flatMap((exception) => {
          const seriesId = mappedId(timeBlockIdMap, exception.seriesId);
          return seriesId
            ? [{
                workspaceId,
                seriesId,
                occurrenceDate: exception.occurrenceDate,
                action: exception.action,
                overrideTitle: exception.overrideTitle,
                overrideKind: exception.overrideKind,
                overrideStartsAt: exception.overrideStartsAt ? parseDate(exception.overrideStartsAt) : null,
                overrideEndsAt: exception.overrideEndsAt ? parseDate(exception.overrideEndsAt) : null,
                overrideProtected: exception.overrideProtected,
              }]
            : [];
        }),
      );
    }

    if (template.tasks.length > 0) {
      const taskRows = await tx.insert(tasks).values(
        template.tasks.map((task) => ({
          workspaceId,
          planId: plan.id,
          title: task.title,
          notes: task.notes,
          date: parseDate(task.date),
          daySegment: task.daySegment,
          status: "todo",
          priority: task.priority,
          estimatedMinutes: task.estimatedMinutes,
          energyLevel: task.energyLevel,
          movable: task.movable,
          projectId: "projectId" in task ? mappedId(projectIdMap, task.projectId) : null,
          milestoneId: "milestoneId" in task ? mappedId(milestoneIdMap, task.milestoneId) : null,
          courseId: mappedId(courseIdMap, task.courseId),
          trackId: mappedId(trackIdMap, task.trackId),
          parentTaskId: null,
          originalDate: parseDate(task.date),
        })),
      ).returning();

      const taskIdMap = new Map(template.tasks.map((task, index) => [task.id, taskRows[index]?.id]));
      for (const task of template.tasks) {
        const taskId = mappedId(taskIdMap, task.id);
        const parentTaskId = mappedId(taskIdMap, task.parentTaskId);
        if (!taskId || !parentTaskId || taskId === parentTaskId) continue;
        await tx.update(tasks).set({ parentTaskId }).where(eq(tasks.id, taskId));
      }
    }

    return {
      planId: plan.id,
      tasksCreated: template.tasks.length,
      routinesCreated: template.routines.length,
      timeBlocksCreated: template.timeBlocks.length,
    };
  });
}
