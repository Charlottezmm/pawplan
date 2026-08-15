import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { editableTimeBlockKinds, type EditableTimeBlockKind, type TimeBlockInput } from "@/lib/constraints/schema";
import { weekdayMaskFromRecurrence } from "@/lib/constraints/recurrence";
import { changeLogs, courses, plans, timeBlockExceptions, timeBlocks } from "@/lib/db/schema";
import {
  expandEffectiveRecurringBlocks,
  type TimeBlockExceptionInput,
} from "@/lib/planning/recurring-time-blocks";

const editableTimeBlockKindValues = [...editableTimeBlockKinds];

type DbLike = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

type CourseRow = {
  id: string;
  workspaceId: string;
  name: string;
  color?: string;
};

type TimeBlockRow = {
  id: string;
  workspaceId: string;
  title: string;
  kind: string;
  startsAt: Date;
  endsAt: Date;
  recurrenceRule: string | null;
  recurrenceWeekdayMask: number | null;
  courseId: string | null;
  movable: boolean;
  protected: boolean;
};

export class ConstraintsServiceError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function isEditableKind(kind: string): kind is EditableTimeBlockKind {
  return editableTimeBlockKinds.includes(kind as EditableTimeBlockKind);
}

function normalizeNullable(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function serializeTimeBlock(row: TimeBlockRow, courseNames: Map<string, string>) {
  return {
    ...row,
    courseName: row.courseId ? courseNames.get(row.courseId) ?? null : null,
    movable: false,
  };
}

function serializeCourse(row: CourseRow) {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? "#2563eb",
  };
}

function blockOverlaps(first: TimeBlockRow, second: TimeBlockRow) {
  return first.startsAt < second.endsAt && first.endsAt > second.startsAt;
}

function overlapWindow(first: TimeBlockRow, second: TimeBlockRow) {
  return {
    startsAt: new Date(Math.max(first.startsAt.getTime(), second.startsAt.getTime())).toISOString(),
    endsAt: new Date(Math.min(first.endsAt.getTime(), second.endsAt.getTime())).toISOString(),
  };
}

function buildConstraintConflicts(blocks: TimeBlockRow[]) {
  const conflicts: Array<{
    id: string;
    firstTitle: string;
    secondTitle: string;
    startsAt: string;
    endsAt: string;
  }> = [];

  for (let index = 0; index < blocks.length; index += 1) {
    for (let compareIndex = index + 1; compareIndex < blocks.length; compareIndex += 1) {
      const first = blocks[index];
      const second = blocks[compareIndex];
      if (!blockOverlaps(first, second)) continue;
      conflicts.push({
        id: `${first.id}__${second.id}`,
        firstTitle: first.title,
        secondTitle: second.title,
        ...overlapWindow(first, second),
      });
    }
  }

  return conflicts;
}

function expandBlocksForConflictCheck(blocks: TimeBlockRow[], exceptions: TimeBlockExceptionInput[]) {
  if (blocks.length === 0) return [];
  const rangeStart = new Date(Math.min(...blocks.map((block) => block.startsAt.getTime())));
  const rangeEnd = new Date(Math.max(...blocks.map((block) => block.endsAt.getTime())));
  return expandEffectiveRecurringBlocks(blocks, exceptions, rangeStart, rangeEnd);
}

async function getActivePlanId(tx: DbLike, workspaceId: string) {
  const [plan] = await tx
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.workspaceId, workspaceId), eq(plans.status, "active")))
    .limit(1);

  return (plan?.id as string | undefined) ?? null;
}

async function findOrCreateCourse(tx: DbLike, workspaceId: string, courseName: string | null) {
  if (!courseName) return null;

  const [existing] = await tx
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.workspaceId, workspaceId), eq(courses.name, courseName)))
    .limit(1);

  if (existing) return existing.id as string;

  const [created] = await tx.insert(courses).values({ workspaceId, name: courseName }).returning();
  return created.id as string;
}

async function writeManualChangeLog(
  tx: DbLike,
  workspaceId: string,
  summary: string,
  detailsJson: Record<string, unknown>,
) {
  await tx.insert(changeLogs).values({
    workspaceId,
    planId: await getActivePlanId(tx, workspaceId),
    source: "manual",
    summary,
    detailsJson,
  });
}

export async function getConstraints(db: DbLike, workspaceId: string) {
  const [courseRows, rawBlocks, exceptionRows] = await Promise.all([
    db.select().from(courses).where(eq(courses.workspaceId, workspaceId)).orderBy(asc(courses.name)),
    db
      .select()
      .from(timeBlocks)
      .where(and(eq(timeBlocks.workspaceId, workspaceId), inArray(timeBlocks.kind, editableTimeBlockKindValues)))
      .orderBy(asc(timeBlocks.startsAt)),
    db
      .select()
      .from(timeBlockExceptions)
      .where(eq(timeBlockExceptions.workspaceId, workspaceId))
      .orderBy(asc(timeBlockExceptions.occurrenceDate)),
  ]);

  const courseNames = new Map<string, string>();
  for (const course of courseRows as CourseRow[]) courseNames.set(course.id, course.name);

  const sortedBlocks = (rawBlocks as TimeBlockRow[])
    .filter((block) => isEditableKind(block.kind))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const conflicts = buildConstraintConflicts(
    expandBlocksForConflictCheck(sortedBlocks, exceptionRows as TimeBlockExceptionInput[]),
  );

  return {
    workspaceId,
    courses: (courseRows as CourseRow[]).map(serializeCourse),
    timeBlocks: sortedBlocks.map((block) => serializeTimeBlock(block, courseNames)),
    summary: {
      courseCount: courseRows.length,
      timeBlockCount: sortedBlocks.length,
      conflictCount: conflicts.length,
      nextStartsAt: sortedBlocks[0]?.startsAt.toISOString() ?? null,
    },
    conflicts,
  };
}

export async function upsertTimeBlock(db: DbLike, workspaceId: string, input: TimeBlockInput) {
  return db.transaction(async (tx) => {
    const courseName = input.kind === "course" ? normalizeNullable(input.courseName) : null;
    const courseId = await findOrCreateCourse(tx, workspaceId, courseName);
    const course =
      courseId && courseName
        ? ({ id: courseId, workspaceId, name: courseName, color: input.color ?? "#2563eb" } satisfies CourseRow)
        : null;
    const recurrenceRule = normalizeNullable(input.recurrenceRule);
    const values = {
      workspaceId,
      title: input.title,
      kind: input.kind,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      recurrenceRule,
      recurrenceWeekdayMask: weekdayMaskFromRecurrence(recurrenceRule, input.startsAt),
      courseId,
      movable: false,
    };

    let timeBlock: TimeBlockRow;
    if (input.id) {
      const [existing] = await tx
        .select()
        .from(timeBlocks)
        .where(and(eq(timeBlocks.id, input.id), eq(timeBlocks.workspaceId, workspaceId)))
        .limit(1);

      if (!existing) throw new ConstraintsServiceError("Time block not found", 404);
      if (!isEditableKind(existing.kind)) throw new ConstraintsServiceError("Time block is not editable here", 403);
      if (existing.recurrenceRule || existing.recurrenceWeekdayMask) {
        throw new ConstraintsServiceError(
          "Recurring time blocks must be changed with an explicit occurrence, following, or series scope",
          409,
        );
      }

      const [updated] = await tx
        .update(timeBlocks)
        .set({ ...values, revision: sql`${timeBlocks.revision} + 1`, updatedAt: new Date() })
        .where(and(eq(timeBlocks.id, input.id), eq(timeBlocks.workspaceId, workspaceId)))
        .returning();
      timeBlock = updated as TimeBlockRow;
    } else {
      const [created] = await tx.insert(timeBlocks).values(values).returning();
      timeBlock = created as TimeBlockRow;
    }

    await writeManualChangeLog(tx, workspaceId, "Updated calendar constraint", {
      action: input.id ? "update_time_block" : "create_time_block",
      timeBlockId: timeBlock.id,
      kind: input.kind,
      title: input.title,
      courseName,
    });

    return {
      timeBlock: {
        ...timeBlock,
        courseName,
        movable: false,
      },
      course: course ? serializeCourse(course) : null,
    };
  });
}

export async function deleteTimeBlock(db: DbLike, workspaceId: string, id: string) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(timeBlocks)
      .where(and(eq(timeBlocks.id, id), eq(timeBlocks.workspaceId, workspaceId)))
      .limit(1);

    if (!existing) throw new ConstraintsServiceError("Time block not found", 404);
    if (!isEditableKind(existing.kind)) throw new ConstraintsServiceError("Time block is not editable here", 403);
    if (existing.recurrenceRule || existing.recurrenceWeekdayMask) {
      throw new ConstraintsServiceError(
        "Recurring time blocks must be deleted with an explicit occurrence, following, or series scope",
        409,
      );
    }

    const [deleted] = await tx
      .delete(timeBlocks)
      .where(and(eq(timeBlocks.id, id), eq(timeBlocks.workspaceId, workspaceId)))
      .returning();

    if (!deleted) throw new ConstraintsServiceError("Time block not found", 404);

    await writeManualChangeLog(tx, workspaceId, "Deleted calendar constraint", {
      action: "delete_time_block",
      timeBlockId: id,
      kind: existing.kind,
      title: existing.title,
    });

    return { deleted: true };
  });
}
