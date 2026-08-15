import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  courses,
  projectMilestones,
  projects,
  routines,
  segmentEnergySettings,
  tasks,
  timeBlocks,
  tracks,
  workspaces,
} from "@/lib/db/schema";

type DbLike = {
  select: (...args: any[]) => any;
};

const daySegmentSchema = z.enum(["morning", "afternoon", "evening"]);
const energyLevelSchema = z.enum(["low", "medium", "high"]);
const routineTimeSegmentSchema = z.enum(["morning", "afternoon", "evening", "specific_window"]);
const trackKindSchema = z.enum(["main", "work", "side", "recovery", "custom"]);
const timeBlockKindSchema = z.enum(["course", "meeting", "unavailable", "routine", "recovery"]);
const taskStatusSchema = z.enum(["todo", "done", "skipped", "backlog"]);
const prioritySchema = z.enum(["low", "normal", "high", "urgent"]);
const projectStatusSchema = z.enum(["active", "paused", "completed", "archived"]);
const milestoneStatusSchema = z.enum(["planned", "in_progress", "completed", "skipped"]);

const trackTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: trackKindSchema,
  targetMinPercent: z.number().int().nullable(),
  targetMaxPercent: z.number().int().nullable(),
  color: z.string().min(1).max(32),
});

const courseTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  color: z.string().min(1).max(32),
});

const routineTemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(180),
  defaultTimeSegment: routineTimeSegmentSchema,
  defaultStartTime: z.string().nullable(),
  defaultEndTime: z.string().nullable(),
  weekdayPattern: z.string().min(1).max(80),
  estimatedMinutes: z.number().int().min(1).max(1440),
  energyLevel: energyLevelSchema,
});

const segmentEnergyTemplateSchema = z.object({
  segment: daySegmentSchema,
  energyLevel: energyLevelSchema,
});

const timeBlockTemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(180),
  kind: timeBlockKindSchema,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  recurrenceRule: z.string().nullable(),
  courseId: z.string().nullable(),
  trackId: z.string().nullable(),
  movable: z.boolean(),
  estimatedMinutes: z.number().int().nullable(),
  energyLevel: energyLevelSchema.nullable(),
});

const legacyTaskTemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(240),
  notes: z.string().nullable(),
  date: z.string().datetime(),
  daySegment: daySegmentSchema,
  status: taskStatusSchema,
  priority: prioritySchema,
  estimatedMinutes: z.number().int().min(1),
  energyLevel: energyLevelSchema,
  movable: z.boolean(),
  courseId: z.string().nullable(),
  trackId: z.string().nullable(),
  parentTaskId: z.string().nullable(),
});

const templateBase = {
  exportedAt: z.string().datetime(),
  workspace: z.object({
    name: z.string().min(1).max(120),
  }),
  tracks: z.array(trackTemplateSchema),
  courses: z.array(courseTemplateSchema),
  routines: z.array(routineTemplateSchema),
  segmentEnergySettings: z.array(segmentEnergyTemplateSchema),
  timeBlocks: z.array(timeBlockTemplateSchema),
};

export const pawPlanTemplateV04Schema = z
  .object({
    schemaVersion: z.literal("pawplan.template.v0.4"),
    ...templateBase,
    tasks: z.array(legacyTaskTemplateSchema),
  })
  .strict();

export const pawPlanTemplateV05Schema = z
  .object({
    schemaVersion: z.literal("pawplan.template.v0.5"),
    ...templateBase,
    projects: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(120),
        color: z.string().min(1).max(32),
        category: z.string().min(1).max(80).nullable(),
        objective: z.string().nullable(),
        successCriteria: z.string().nullable(),
        status: projectStatusSchema,
        priority: prioritySchema,
        startDate: z.string().datetime().nullable(),
        targetDate: z.string().datetime().nullable(),
        weeklyTargetMinutes: z.number().int().min(0).nullable(),
        needsDefinition: z.boolean(),
      }),
    ),
    milestones: z.array(
      z.object({
        id: z.string().min(1),
        projectId: z.string().min(1),
        title: z.string().min(1).max(180),
        objective: z.string().nullable(),
        successCriteria: z.string().nullable(),
        targetDate: z.string().datetime().nullable(),
        status: milestoneStatusSchema,
        position: z.number().int(),
      }),
    ),
    tasks: z.array(
      legacyTaskTemplateSchema.extend({
        projectId: z.string().nullable(),
        milestoneId: z.string().nullable(),
      }),
    ),
  })
  .strict();

export const pawPlanTemplateSchema = z.discriminatedUnion("schemaVersion", [
  pawPlanTemplateV04Schema,
  pawPlanTemplateV05Schema,
]);

export type PawPlanTemplate = z.infer<typeof pawPlanTemplateSchema>;
export type PawPlanTemplateV05 = z.infer<typeof pawPlanTemplateV05Schema>;

export class TemplateExportError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

export async function exportWorkspaceTemplate(
  db: DbLike,
  workspaceId: string,
  exportedAt: Date = new Date(),
): Promise<PawPlanTemplateV05> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) throw new TemplateExportError("Workspace not found", 404);

  const [projectRows, milestoneRows, trackRows, courseRows, routineRows, energyRows, timeBlockRows, taskRows] = await Promise.all([
    db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).orderBy(asc(projects.createdAt)),
    db
      .select()
      .from(projectMilestones)
      .where(eq(projectMilestones.workspaceId, workspaceId))
      .orderBy(asc(projectMilestones.position), asc(projectMilestones.createdAt)),
    db.select().from(tracks).where(eq(tracks.workspaceId, workspaceId)).orderBy(asc(tracks.createdAt)),
    db.select().from(courses).where(eq(courses.workspaceId, workspaceId)).orderBy(asc(courses.createdAt)),
    db.select().from(routines).where(eq(routines.workspaceId, workspaceId)).orderBy(asc(routines.createdAt)),
    db
      .select()
      .from(segmentEnergySettings)
      .where(eq(segmentEnergySettings.workspaceId, workspaceId))
      .orderBy(asc(segmentEnergySettings.segment)),
    db.select().from(timeBlocks).where(eq(timeBlocks.workspaceId, workspaceId)).orderBy(asc(timeBlocks.startsAt)),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId)))
      .orderBy(asc(tasks.date), asc(tasks.createdAt)),
  ]);

  return pawPlanTemplateV05Schema.parse({
    schemaVersion: "pawplan.template.v0.5",
    exportedAt: exportedAt.toISOString(),
    workspace: { name: workspace.name },
    projects: projectRows.map((project: typeof projects.$inferSelect) => ({
      id: project.id,
      name: project.name,
      color: project.color,
      category: project.category,
      objective: project.objective,
      successCriteria: project.successCriteria,
      status: "active",
      priority: project.priority,
      startDate: project.startDate ? iso(project.startDate) : null,
      targetDate: project.targetDate ? iso(project.targetDate) : null,
      weeklyTargetMinutes: project.weeklyTargetMinutes,
      needsDefinition: project.needsDefinition,
    })),
    milestones: milestoneRows.map((milestone: typeof projectMilestones.$inferSelect) => ({
      id: milestone.id,
      projectId: milestone.projectId,
      title: milestone.title,
      objective: milestone.objective,
      successCriteria: milestone.successCriteria,
      targetDate: milestone.targetDate ? iso(milestone.targetDate) : null,
      status: "planned",
      position: milestone.position,
    })),
    tracks: trackRows.map((track: typeof tracks.$inferSelect) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      targetMinPercent: track.targetMinPercent,
      targetMaxPercent: track.targetMaxPercent,
      color: track.color,
    })),
    courses: courseRows.map((course: typeof courses.$inferSelect) => ({
      id: course.id,
      name: course.name,
      color: course.color,
    })),
    routines: routineRows.map((routine: typeof routines.$inferSelect) => ({
      id: routine.id,
      title: routine.title,
      defaultTimeSegment: routine.defaultTimeSegment,
      defaultStartTime: routine.defaultStartTime,
      defaultEndTime: routine.defaultEndTime,
      weekdayPattern: routine.weekdayPattern,
      estimatedMinutes: routine.estimatedMinutes,
      energyLevel: routine.energyLevel,
    })),
    segmentEnergySettings: energyRows.map((setting: typeof segmentEnergySettings.$inferSelect) => ({
      segment: setting.segment,
      energyLevel: setting.energyLevel,
    })),
    timeBlocks: timeBlockRows.map((block: typeof timeBlocks.$inferSelect) => ({
      id: block.id,
      title: block.title,
      kind: block.kind,
      startsAt: iso(block.startsAt),
      endsAt: iso(block.endsAt),
      recurrenceRule: block.recurrenceRule,
      courseId: block.courseId,
      trackId: block.trackId,
      movable: block.movable,
      estimatedMinutes: block.estimatedMinutes,
      energyLevel: block.energyLevel,
    })),
    tasks: taskRows.map((task: typeof tasks.$inferSelect) => ({
      id: task.id,
      title: task.title,
      notes: task.notes,
      date: iso(task.date),
      daySegment: task.daySegment,
      status: "todo",
      priority: task.priority,
      estimatedMinutes: task.estimatedMinutes,
      energyLevel: task.energyLevel,
      movable: task.movable,
      projectId: task.projectId,
      milestoneId: task.milestoneId,
      courseId: task.courseId,
      trackId: task.trackId,
      parentTaskId: task.parentTaskId,
    })),
  });
}
