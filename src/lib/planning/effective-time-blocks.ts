import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { timeBlockExceptions, timeBlocks } from "@/lib/db/schema";
import {
  expandEffectiveRecurringBlocks,
  shanghaiOccurrenceDate,
  type TimeBlockExceptionInput,
} from "@/lib/planning/recurring-time-blocks";

type DbLike = {
  select: (...args: any[]) => any;
};

type TimeBlockRow = typeof timeBlocks.$inferSelect;
type TimeBlockExceptionRow = typeof timeBlockExceptions.$inferSelect;

export type EffectiveTimeBlockSnapshot = {
  series: TimeBlockRow[];
  exceptions: TimeBlockExceptionRow[];
  occurrences: ReturnType<typeof expandEffectiveRecurringBlocks<TimeBlockRow>>;
};

function exceptionInput(row: TimeBlockExceptionRow): TimeBlockExceptionInput {
  return {
    id: row.id,
    seriesId: row.seriesId,
    occurrenceDate: row.occurrenceDate,
    action: row.action,
    overrideTitle: row.overrideTitle,
    overrideKind: row.overrideKind,
    overrideStartsAt: row.overrideStartsAt,
    overrideEndsAt: row.overrideEndsAt,
    overrideProtected: row.overrideProtected,
  };
}
export async function loadEffectiveTimeBlocks(
  db: DbLike,
  input: {
    workspaceId: string;
    rangeStart: Date;
    rangeEnd: Date;
    kinds?: TimeBlockRow["kind"][];
  },
): Promise<EffectiveTimeBlockSnapshot> {
  const baseCondition = and(
    eq(timeBlocks.workspaceId, input.workspaceId),
    lt(timeBlocks.startsAt, input.rangeEnd),
    gte(timeBlocks.endsAt, input.rangeStart),
  );
  const series = (await db
    .select()
    .from(timeBlocks)
    .where(
      input.kinds && input.kinds.length > 0
        ? and(baseCondition, inArray(timeBlocks.kind, input.kinds))
        : baseCondition,
    )
    .orderBy(timeBlocks.startsAt)) as TimeBlockRow[];

  if (series.length === 0) return { series: [], exceptions: [], occurrences: [] };

  const exceptions = (await db
    .select()
    .from(timeBlockExceptions)
    .where(
      and(
        eq(timeBlockExceptions.workspaceId, input.workspaceId),
        inArray(timeBlockExceptions.seriesId, series.map((row) => row.id)),
        gte(timeBlockExceptions.occurrenceDate, shanghaiOccurrenceDate(input.rangeStart)),
        lt(timeBlockExceptions.occurrenceDate, shanghaiOccurrenceDate(input.rangeEnd)),
      ),
    )) as TimeBlockExceptionRow[];

  return {
    series,
    exceptions,
    occurrences: expandEffectiveRecurringBlocks(
      series,
      exceptions.map(exceptionInput),
      input.rangeStart,
      input.rangeEnd,
    ),
  };
}
