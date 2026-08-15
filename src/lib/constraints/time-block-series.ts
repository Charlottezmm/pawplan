import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  changeLogs,
  dayCapacities,
  planOperations,
  routines,
  tasks,
  timeBlockExceptions,
  timeBlocks,
} from "@/lib/db/schema";
import { getActivePlanId } from "@/lib/planning/active-plan";
import {
  consumeOperationApproval,
  createOperationApproval,
  verifyOperationApproval,
} from "@/lib/approvals/service";
import { buildCapacityModel } from "@/lib/planning/capacity-model";
import { loadEffectiveTimeBlocks } from "@/lib/planning/effective-time-blocks";
import {
  expandEffectiveRecurringBlocks,
  expandRecurringBlocks,
  shanghaiOccurrenceDate,
  type TimeBlockExceptionInput,
} from "@/lib/planning/recurring-time-blocks";
import {
  createTimeBlockSeriesPreviewToken,
  timeBlockSeriesHash,
  verifyTimeBlockSeriesPreviewToken,
} from "@/lib/constraints/time-block-series-token";

export type TimeBlockSeriesScope = "occurrence" | "following" | "series";
export type TimeBlockSeriesAction = "update" | "delete";

export type TimeBlockSeriesChanges = {
  title?: string;
  kind?: "course" | "meeting" | "unavailable" | "routine" | "recovery";
  startTime?: string;
  endTime?: string;
  weekdayMask?: number | null;
  recurrenceLabel?: string | null;
  protected?: boolean;
  startsOn?: string;
  endsOn?: string;
};

export type TimeBlockSeriesRequest = {
  seriesId: string;
  scope: TimeBlockSeriesScope;
  occurrenceDate: string;
  changes?: TimeBlockSeriesChanges;
};

type DbLike = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

type SeriesRow = typeof timeBlocks.$inferSelect;
type ExceptionRow = typeof timeBlockExceptions.$inferSelect;

type MutationPlan = {
  action: TimeBlockSeriesAction;
  effectiveScope: TimeBlockSeriesScope;
  occurrenceDate: string;
  noChange: boolean;
  series: SeriesRow;
  exceptions: ExceptionRow[];
  nextSeries: SeriesRow[];
  nextExceptions: Array<ExceptionRow | PlannedException>;
  affectedDates: string[];
  rangeStart: Date;
  rangeEnd: Date;
  updateValues?: Partial<SeriesRow>;
  followingValues?: Partial<SeriesRow>;
};

type PlannedException = Omit<ExceptionRow, "createdAt" | "updatedAt"> & {
  createdAt?: Date;
  updatedAt?: Date;
};

export class TimeBlockSeriesError extends Error {
  constructor(
    public code:
      | "invalid_request"
      | "series_not_found"
      | "occurrence_not_found"
      | "preview_required"
      | "preview_stale"
      | "idempotency_payload_mismatch"
      | "operation_in_progress",
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function shanghaiDate(value: string) {
  if (!datePattern.test(value)) throw new TimeBlockSeriesError("invalid_request", "Invalid occurrence date");
  const date = new Date(`${value}T00:00:00.000+08:00`);
  if (Number.isNaN(date.getTime()) || shanghaiOccurrenceDate(date) !== value) {
    throw new TimeBlockSeriesError("invalid_request", "Invalid occurrence date");
  }
  return date;
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function timePart(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("hour")}:${value("minute")}`;
}

function dateTime(date: string, time: string) {
  return new Date(`${date}T${time}:00.000+08:00`);
}

function requestPayload(action: TimeBlockSeriesAction, request: TimeBlockSeriesRequest) {
  return {
    action,
    seriesId: request.seriesId,
    scope: request.scope,
    occurrenceDate: request.occurrenceDate,
    changes: request.changes ?? null,
  };
}

function serializeDate(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function snapshotPayload(series: SeriesRow, exceptions: ExceptionRow[]) {
  return {
    series: {
      id: series.id,
      title: series.title,
      kind: series.kind,
      startsAt: series.startsAt.toISOString(),
      endsAt: series.endsAt.toISOString(),
      recurrenceRule: series.recurrenceRule,
      recurrenceWeekdayMask: series.recurrenceWeekdayMask,
      courseId: series.courseId,
      trackId: series.trackId,
      movable: series.movable,
      protected: series.protected,
      revision: series.revision,
      updatedAt: series.updatedAt.toISOString(),
    },
    exceptions: [...exceptions]
      .sort((left, right) => left.occurrenceDate.localeCompare(right.occurrenceDate))
      .map((exception) => ({
        id: exception.id,
        occurrenceDate: exception.occurrenceDate,
        action: exception.action,
        overrideTitle: exception.overrideTitle,
        overrideKind: exception.overrideKind,
        overrideStartsAt: serializeDate(exception.overrideStartsAt),
        overrideEndsAt: serializeDate(exception.overrideEndsAt),
        overrideProtected: exception.overrideProtected,
        updatedAt: exception.updatedAt.toISOString(),
      })),
  };
}

function exceptionInput(row: ExceptionRow | PlannedException): TimeBlockExceptionInput {
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

function validateRequest(action: TimeBlockSeriesAction, request: TimeBlockSeriesRequest) {
  shanghaiDate(request.occurrenceDate);
  if (!request.seriesId.trim()) throw new TimeBlockSeriesError("invalid_request", "Series ID is required");
  if (!(["occurrence", "following", "series"] as const).includes(request.scope)) {
    throw new TimeBlockSeriesError("invalid_request", "Invalid series scope");
  }
  if (action === "update" && (!request.changes || Object.keys(request.changes).length === 0)) {
    throw new TimeBlockSeriesError("invalid_request", "Update changes are required");
  }
  if (action === "delete" && request.changes) {
    throw new TimeBlockSeriesError("invalid_request", "Delete does not accept changes");
  }
  const changes = request.changes;
  if (!changes) return;
  if (changes.title !== undefined && (!changes.title.trim() || changes.title.length > 180)) {
    throw new TimeBlockSeriesError("invalid_request", "Invalid time block title");
  }
  if (changes.startTime !== undefined && !timePattern.test(changes.startTime)) {
    throw new TimeBlockSeriesError("invalid_request", "Invalid start time");
  }
  if (changes.endTime !== undefined && !timePattern.test(changes.endTime)) {
    throw new TimeBlockSeriesError("invalid_request", "Invalid end time");
  }
  if (changes.weekdayMask !== undefined && changes.weekdayMask !== null && (changes.weekdayMask < 0 || changes.weekdayMask > 127)) {
    throw new TimeBlockSeriesError("invalid_request", "Invalid weekday mask");
  }
  if (changes.startsOn !== undefined) shanghaiDate(changes.startsOn);
  if (changes.endsOn !== undefined) shanghaiDate(changes.endsOn);
  if (
    request.scope === "occurrence" &&
    (changes.weekdayMask !== undefined ||
      changes.recurrenceLabel !== undefined ||
      changes.startsOn !== undefined ||
      changes.endsOn !== undefined)
  ) {
    throw new TimeBlockSeriesError(
      "invalid_request",
      "A single occurrence cannot change recurrence or series date bounds",
    );
  }
}

function changedSeriesValues(series: SeriesRow, changes: TimeBlockSeriesChanges, forcedStartsOn?: string) {
  const startsOn = forcedStartsOn ?? changes.startsOn ?? shanghaiOccurrenceDate(series.startsAt);
  const endsOn = changes.endsOn ?? shanghaiOccurrenceDate(series.endsAt);
  const startTime = changes.startTime ?? timePart(series.startsAt);
  const endTime = changes.endTime ?? timePart(series.endsAt);
  if (endTime <= startTime) {
    throw new TimeBlockSeriesError("invalid_request", "Cross-midnight or zero-length time blocks are not supported");
  }
  if (endsOn < startsOn) throw new TimeBlockSeriesError("invalid_request", "Series end date must not precede start date");
  const recurrenceWeekdayMask = changes.weekdayMask === undefined
    ? series.recurrenceWeekdayMask
    : changes.weekdayMask && changes.weekdayMask > 0
      ? changes.weekdayMask
      : null;
  if (!recurrenceWeekdayMask && startsOn !== endsOn) {
    throw new TimeBlockSeriesError("invalid_request", "A non-recurring time block must start and end on the same date");
  }
  return {
    title: changes.title?.trim() ?? series.title,
    kind: changes.kind ?? series.kind,
    startsAt: dateTime(startsOn, startTime),
    endsAt: dateTime(endsOn, endTime),
    recurrenceRule: changes.recurrenceLabel === undefined ? series.recurrenceRule : changes.recurrenceLabel?.trim() || null,
    recurrenceWeekdayMask,
    protected: changes.protected ?? series.protected,
  };
}

function logicalOccurrenceExists(series: SeriesRow, occurrenceDate: string) {
  const dayStart = shanghaiDate(occurrenceDate);
  return expandRecurringBlocks([series], dayStart, addDays(dayStart, 1)).length === 1;
}

function cloneSeries(series: SeriesRow, values: Partial<SeriesRow>, id = series.id): SeriesRow {
  return { ...series, ...values, id };
}

function plannedException(
  series: SeriesRow,
  action: TimeBlockSeriesAction,
  request: TimeBlockSeriesRequest,
): PlannedException {
  const changes = request.changes ?? {};
  const startTime = changes.startTime ?? timePart(series.startsAt);
  const endTime = changes.endTime ?? timePart(series.endsAt);
  if (endTime <= startTime) {
    throw new TimeBlockSeriesError("invalid_request", "Cross-midnight or zero-length time blocks are not supported");
  }
  return {
    id: `planned-${series.id}-${request.occurrenceDate}`,
    workspaceId: series.workspaceId,
    seriesId: series.id,
    occurrenceDate: request.occurrenceDate,
    action: action === "delete" ? "cancel" : "override",
    overrideTitle: action === "update" ? changes.title?.trim() ?? series.title : null,
    overrideKind: action === "update" ? changes.kind ?? series.kind : null,
    overrideStartsAt: action === "update" ? dateTime(request.occurrenceDate, startTime) : null,
    overrideEndsAt: action === "update" ? dateTime(request.occurrenceDate, endTime) : null,
    overrideProtected: action === "update" ? changes.protected ?? series.protected : null,
  };
}

function uniqueDates(values: string[]) {
  return [...new Set(values)].sort();
}

function sameException(left: ExceptionRow | undefined, right: PlannedException) {
  if (!left) return false;
  return (
    left.action === right.action &&
    left.overrideTitle === right.overrideTitle &&
    left.overrideKind === right.overrideKind &&
    serializeDate(left.overrideStartsAt) === serializeDate(right.overrideStartsAt) &&
    serializeDate(left.overrideEndsAt) === serializeDate(right.overrideEndsAt) &&
    left.overrideProtected === right.overrideProtected
  );
}

function sameSeriesValues(series: SeriesRow, values: Partial<SeriesRow>) {
  return (
    (values.title === undefined || values.title === series.title) &&
    (values.kind === undefined || values.kind === series.kind) &&
    (values.startsAt === undefined || values.startsAt.getTime() === series.startsAt.getTime()) &&
    (values.endsAt === undefined || values.endsAt.getTime() === series.endsAt.getTime()) &&
    (values.recurrenceRule === undefined || values.recurrenceRule === series.recurrenceRule) &&
    (values.recurrenceWeekdayMask === undefined || values.recurrenceWeekdayMask === series.recurrenceWeekdayMask) &&
    (values.protected === undefined || values.protected === series.protected)
  );
}

export function planTimeBlockSeriesMutation(input: {
  action: TimeBlockSeriesAction;
  request: TimeBlockSeriesRequest;
  series: SeriesRow;
  exceptions: ExceptionRow[];
}): MutationPlan {
  validateRequest(input.action, input.request);
  const { action, request, series, exceptions } = input;
  if (!logicalOccurrenceExists(series, request.occurrenceDate)) {
    throw new TimeBlockSeriesError("occurrence_not_found", "The selected date is not an occurrence of this series", 404);
  }
  const oldStart = shanghaiDate(shanghaiOccurrenceDate(series.startsAt));
  const hasEarlierOccurrence = expandRecurringBlocks(
    [series],
    oldStart,
    shanghaiDate(request.occurrenceDate),
  ).length > 0;
  const effectiveScope = request.scope === "following" && (!series.recurrenceWeekdayMask || !hasEarlierOccurrence)
    ? "series"
    : request.scope;
  let nextSeries: SeriesRow[] = [series];
  let nextExceptions: Array<ExceptionRow | PlannedException> = [...exceptions];
  let updateValues: Partial<SeriesRow> | undefined;
  let followingValues: Partial<SeriesRow> | undefined;
  let noChange = false;

  if (effectiveScope === "occurrence") {
    const exception = plannedException(series, action, request);
    noChange = sameException(
      exceptions.find((row) => row.occurrenceDate === request.occurrenceDate),
      exception,
    );
    nextExceptions = [
      ...exceptions.filter((row) => row.occurrenceDate !== request.occurrenceDate),
      exception,
    ];
  } else if (effectiveScope === "following") {
    const previousDate = shanghaiOccurrenceDate(addDays(shanghaiDate(request.occurrenceDate), -1));
    updateValues = {
      endsAt: dateTime(previousDate, timePart(series.endsAt)),
      revision: series.revision + 1,
    };
    const shortened = cloneSeries(series, updateValues);
    nextSeries = [shortened];
    if (action === "update") {
      followingValues = {
        ...changedSeriesValues(series, request.changes ?? {}, request.occurrenceDate),
        revision: 0,
      };
      const nextId = `${series.id}-following`;
      nextSeries.push(cloneSeries(series, followingValues, nextId));
      nextExceptions = exceptions.map((row) =>
        row.occurrenceDate >= request.occurrenceDate ? { ...row, seriesId: nextId } : row,
      );
    } else {
      nextExceptions = exceptions.filter((row) => row.occurrenceDate < request.occurrenceDate);
    }
  } else if (action === "update") {
    const changedValues = changedSeriesValues(series, request.changes ?? {});
    noChange = sameSeriesValues(series, changedValues);
    updateValues = { ...changedValues, revision: series.revision + 1 };
    nextSeries = [cloneSeries(series, updateValues)];
  } else {
    nextSeries = [];
    nextExceptions = [];
  }

  const possibleDates = [
    shanghaiOccurrenceDate(series.startsAt),
    shanghaiOccurrenceDate(series.endsAt),
    request.occurrenceDate,
    ...nextSeries.flatMap((row) => [shanghaiOccurrenceDate(row.startsAt), shanghaiOccurrenceDate(row.endsAt)]),
  ];
  const rangeStart = shanghaiDate([...possibleDates].sort()[0]);
  const rangeEnd = addDays(shanghaiDate([...possibleDates].sort().at(-1)!), 1);
  const before = expandEffectiveRecurringBlocks(series ? [series] : [], exceptions.map(exceptionInput), rangeStart, rangeEnd);
  const after = expandEffectiveRecurringBlocks(nextSeries, nextExceptions.map(exceptionInput), rangeStart, rangeEnd);
  const affectedDates = uniqueDates([
    ...before.map((row) => row.occurrenceDate ?? shanghaiOccurrenceDate(row.startsAt)),
    ...after.map((row) => row.occurrenceDate ?? shanghaiOccurrenceDate(row.startsAt)),
  ]);

  return {
    action,
    effectiveScope,
    occurrenceDate: request.occurrenceDate,
    noChange,
    series,
    exceptions,
    nextSeries,
    nextExceptions,
    affectedDates,
    rangeStart,
    rangeEnd,
    updateValues,
    followingValues,
  };
}

async function readTargetSnapshot(db: DbLike | any, workspaceId: string, seriesId: string, lock = false) {
  let query = db
    .select()
    .from(timeBlocks)
    .where(and(eq(timeBlocks.id, seriesId), eq(timeBlocks.workspaceId, workspaceId)))
    .limit(1);
  if (lock && typeof query.for === "function") query = query.for("update");
  const [series] = (await query) as SeriesRow[];
  if (!series) throw new TimeBlockSeriesError("series_not_found", "Time block series not found", 404);
  const exceptions = (await db
    .select()
    .from(timeBlockExceptions)
    .where(
      and(
        eq(timeBlockExceptions.workspaceId, workspaceId),
        eq(timeBlockExceptions.seriesId, seriesId),
      ),
    )
    .orderBy(timeBlockExceptions.occurrenceDate)) as ExceptionRow[];
  return { series, exceptions };
}

function occurrenceSummary(rows: Array<Record<string, any>>) {
  return rows.map((row) => ({
    id: row.id,
    seriesId: row.recurrenceSourceId ?? row.id,
    occurrenceDate: row.occurrenceDate ?? shanghaiOccurrenceDate(row.startsAt),
    title: row.title,
    kind: row.kind,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    protected: row.protected ?? true,
  }));
}

function datesForCapacity(dateKeys: string[]) {
  return dateKeys.map(shanghaiDate);
}

async function capacityComparison(
  db: DbLike | any,
  input: {
    workspaceId: string;
    planId: string;
    plan: MutationPlan;
  },
) {
  if (input.plan.affectedDates.length === 0) return { before: { days: [], warnings: [] }, after: { days: [], warnings: [] } };
  const rangeStart = shanghaiDate(input.plan.affectedDates[0]);
  const rangeEnd = addDays(shanghaiDate(input.plan.affectedDates.at(-1)!), 1);
  const [seriesRows, taskRows, routineRows, capacityRows] = await Promise.all([
    db
      .select()
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.workspaceId, input.workspaceId),
          lt(timeBlocks.startsAt, rangeEnd),
          gte(timeBlocks.endsAt, rangeStart),
        ),
      ),
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.planId, input.planId),
          isNull(tasks.archivedAt),
          gte(tasks.date, rangeStart),
          lt(tasks.date, rangeEnd),
        ),
      ),
    db.select().from(routines).where(eq(routines.workspaceId, input.workspaceId)),
    db
      .select()
      .from(dayCapacities)
      .where(
        and(
          eq(dayCapacities.workspaceId, input.workspaceId),
          gte(dayCapacities.date, rangeStart),
          lt(dayCapacities.date, rangeEnd),
        ),
      ),
  ]);
  const rawSeries = seriesRows as SeriesRow[];
  const seriesIds = rawSeries.map((row) => row.id);
  const allExceptions = seriesIds.length === 0
    ? []
    : (await db
        .select()
        .from(timeBlockExceptions)
        .where(
          and(
            eq(timeBlockExceptions.workspaceId, input.workspaceId),
            inArray(timeBlockExceptions.seriesId, seriesIds),
            gte(timeBlockExceptions.occurrenceDate, input.plan.affectedDates[0]),
            lt(timeBlockExceptions.occurrenceDate, shanghaiOccurrenceDate(rangeEnd)),
          ),
        )) as ExceptionRow[];

  const beforeOccurrences = expandEffectiveRecurringBlocks(
    rawSeries,
    allExceptions.map(exceptionInput),
    rangeStart,
    rangeEnd,
  );
  const unrelatedSeries = rawSeries.filter((row) => row.id !== input.plan.series.id);
  const unrelatedExceptions = allExceptions.filter((row) => row.seriesId !== input.plan.series.id);
  const afterSeries = [...unrelatedSeries, ...input.plan.nextSeries];
  const afterExceptions = [...unrelatedExceptions, ...input.plan.nextExceptions];
  const afterOccurrences = expandEffectiveRecurringBlocks(
    afterSeries,
    afterExceptions.map(exceptionInput),
    rangeStart,
    rangeEnd,
  );
  const dates = datesForCapacity(input.plan.affectedDates);
  const capacityInput = (occurrences: typeof beforeOccurrences) => ({
    dates,
    capacities: capacityRows,
    tasks: taskRows,
    timeBlocks: occurrences.map((row) => ({ ...row, recurrenceWeekdayMask: null })),
    routines: routineRows,
  });
  return {
    before: buildCapacityModel(capacityInput(beforeOccurrences)),
    after: buildCapacityModel(capacityInput(afterOccurrences)),
  };
}

async function buildPreview(
  db: DbLike,
  input: {
    workspaceId: string;
    action: TimeBlockSeriesAction;
    request: TimeBlockSeriesRequest;
  },
) {
  validateRequest(input.action, input.request);
  const planId = await getActivePlanId(db, input.workspaceId);
  if (!planId) throw new TimeBlockSeriesError("invalid_request", "No active plan", 409);
  const snapshot = await readTargetSnapshot(db, input.workspaceId, input.request.seriesId);
  const plan = planTimeBlockSeriesMutation({ action: input.action, request: input.request, ...snapshot });
  const requestHash = timeBlockSeriesHash(requestPayload(input.action, input.request));
  const snapshotHash = timeBlockSeriesHash(snapshotPayload(snapshot.series, snapshot.exceptions));
  const capacity = await capacityComparison(db, { workspaceId: input.workspaceId, planId, plan });
  const beforeOccurrences = expandEffectiveRecurringBlocks(
    [snapshot.series],
    snapshot.exceptions.map(exceptionInput),
    plan.rangeStart,
    plan.rangeEnd,
  );
  const afterOccurrences = expandEffectiveRecurringBlocks(
    plan.nextSeries,
    plan.nextExceptions.map(exceptionInput),
    plan.rangeStart,
    plan.rangeEnd,
  );
  return {
    planId,
    plan,
    requestHash,
    snapshotHash,
    preview: {
      status: "preview" as const,
      action: input.action,
      requestedScope: input.request.scope,
      effectiveScope: plan.effectiveScope,
      noChange: plan.noChange,
      affectedDates: plan.affectedDates,
      constraints: {
        before: occurrenceSummary(beforeOccurrences),
        after: occurrenceSummary(afterOccurrences),
      },
      capacity,
    },
  };
}

export async function previewTimeBlockSeriesMutation(
  db: DbLike,
  input: {
    workspaceId: string;
    action: TimeBlockSeriesAction;
    request: TimeBlockSeriesRequest;
    now?: Date;
  },
) {
  const built = await buildPreview(db, input);
  const previewToken = createTimeBlockSeriesPreviewToken({
    workspaceId: input.workspaceId,
    action: input.action,
    requestHash: built.requestHash,
    snapshotHash: built.snapshotHash,
    now: input.now,
  });
  const approval = await createOperationApproval(db, {
    workspaceId: input.workspaceId,
    operationKind: `${input.action}_time_block_series`,
    requestHash: built.requestHash,
    previewToken,
    expiresAt: new Date((input.now ?? new Date()).getTime() + 30 * 60 * 1000),
    summary: {
      title: input.action === "update" ? "修改循环时间块" : "删除循环时间块",
      description: `${built.plan.series.title} · ${built.preview.effectiveScope}`,
      count: built.preview.affectedDates.length,
      items: built.preview.affectedDates,
    },
  });
  return {
    ...built.preview,
    previewToken,
    approvalId: approval.id,
  };
}

async function claimOperation(
  db: DbLike,
  input: {
    workspaceId: string;
    planId: string;
    action: TimeBlockSeriesAction;
    idempotencyKey: string;
    requestHash: string;
    now: Date;
  },
) {
  if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new TimeBlockSeriesError("invalid_request", "Invalid idempotency key");
  }
  return db.transaction(async (tx) => {
    const leaseExpiresAt = new Date(input.now.getTime() + 5 * 60 * 1000);
    const [created] = await tx
      .insert(planOperations)
      .values({
        workspaceId: input.workspaceId,
        planId: input.planId,
        operationKind: `${input.action}_time_block_series`,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        status: "started",
        resultJson: {},
        leaseExpiresAt,
      })
      .onConflictDoNothing({
        target: [planOperations.workspaceId, planOperations.idempotencyKey],
      })
      .returning();
    if (created) return { duplicate: false as const, operation: created };

    const [existing] = await tx
      .select()
      .from(planOperations)
      .where(
        and(
          eq(planOperations.workspaceId, input.workspaceId),
          eq(planOperations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing || existing.requestHash !== input.requestHash) {
      throw new TimeBlockSeriesError(
        "idempotency_payload_mismatch",
        "Idempotency key was already used with a different request",
        409,
      );
    }
    if (["succeeded", "no_change", "failed"].includes(existing.status)) {
      return { duplicate: true as const, operation: existing };
    }
    if (existing.leaseExpiresAt && existing.leaseExpiresAt > input.now) {
      throw new TimeBlockSeriesError("operation_in_progress", "Time block operation is already in progress", 409);
    }
    const [reclaimed] = await tx
      .update(planOperations)
      .set({ status: "started", leaseExpiresAt, updatedAt: input.now })
      .where(
        and(
          eq(planOperations.id, existing.id),
          eq(planOperations.workspaceId, input.workspaceId),
          sql`${planOperations.leaseExpiresAt} IS NULL OR ${planOperations.leaseExpiresAt} <= ${input.now}`,
        ),
      )
      .returning();
    if (!reclaimed) {
      throw new TimeBlockSeriesError("operation_in_progress", "Time block operation is already in progress", 409);
    }
    return { duplicate: false as const, operation: reclaimed };
  });
}

async function markOperationFailed(db: DbLike, workspaceId: string, operationId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown time block operation error";
  await db
    .update(planOperations)
    .set({
      status: "failed",
      errorJson: { message },
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(planOperations.id, operationId), eq(planOperations.workspaceId, workspaceId)));
}

function persistedExceptionValues(exception: PlannedException) {
  return {
    workspaceId: exception.workspaceId,
    seriesId: exception.seriesId,
    occurrenceDate: exception.occurrenceDate,
    action: exception.action,
    overrideTitle: exception.overrideTitle,
    overrideKind: exception.overrideKind,
    overrideStartsAt: exception.overrideStartsAt,
    overrideEndsAt: exception.overrideEndsAt,
    overrideProtected: exception.overrideProtected,
  };
}

function insertedSeriesValues(series: SeriesRow, values: Partial<SeriesRow>) {
  return {
    workspaceId: series.workspaceId,
    title: values.title ?? series.title,
    kind: values.kind ?? series.kind,
    startsAt: values.startsAt ?? series.startsAt,
    endsAt: values.endsAt ?? series.endsAt,
    recurrenceRule: values.recurrenceRule === undefined ? series.recurrenceRule : values.recurrenceRule,
    recurrenceWeekdayMask:
      values.recurrenceWeekdayMask === undefined ? series.recurrenceWeekdayMask : values.recurrenceWeekdayMask,
    courseId: series.courseId,
    trackId: series.trackId,
    movable: series.movable,
    protected: values.protected ?? series.protected,
    estimatedMinutes: series.estimatedMinutes,
    energyLevel: series.energyLevel,
    revision: values.revision ?? 0,
  };
}

async function executeMutation(tx: any, workspaceId: string, plan: MutationPlan) {
  const now = new Date();
  const seriesIds = [plan.series.id];
  const exceptionIds: string[] = [];

  if (plan.effectiveScope === "occurrence") {
    const exception = plan.nextExceptions.find(
      (row) => row.seriesId === plan.series.id && row.occurrenceDate === plan.occurrenceDate,
    ) as PlannedException | undefined;
    if (!exception) throw new TimeBlockSeriesError("invalid_request", "Occurrence mutation was not planned");
    const [saved] = await tx
      .insert(timeBlockExceptions)
      .values(persistedExceptionValues(exception))
      .onConflictDoUpdate({
        target: [
          timeBlockExceptions.workspaceId,
          timeBlockExceptions.seriesId,
          timeBlockExceptions.occurrenceDate,
        ],
        set: {
          action: exception.action,
          overrideTitle: exception.overrideTitle,
          overrideKind: exception.overrideKind,
          overrideStartsAt: exception.overrideStartsAt,
          overrideEndsAt: exception.overrideEndsAt,
          overrideProtected: exception.overrideProtected,
          updatedAt: now,
        },
      })
      .returning({ id: timeBlockExceptions.id });
    exceptionIds.push(saved.id);
  } else if (plan.effectiveScope === "following") {
    await tx
      .update(timeBlocks)
      .set({ ...plan.updateValues, updatedAt: now })
      .where(and(eq(timeBlocks.id, plan.series.id), eq(timeBlocks.workspaceId, workspaceId)));
    if (plan.action === "update") {
      const [created] = await tx
        .insert(timeBlocks)
        .values(insertedSeriesValues(plan.series, plan.followingValues ?? {}))
        .returning();
      seriesIds.push(created.id);
      const moved = await tx
        .update(timeBlockExceptions)
        .set({ seriesId: created.id, updatedAt: now })
        .where(
          and(
            eq(timeBlockExceptions.workspaceId, workspaceId),
            eq(timeBlockExceptions.seriesId, plan.series.id),
            gte(timeBlockExceptions.occurrenceDate, plan.occurrenceDate),
          ),
        )
        .returning({ id: timeBlockExceptions.id });
      exceptionIds.push(...moved.map((row: { id: string }) => row.id));
    } else {
      const removed = await tx
        .delete(timeBlockExceptions)
        .where(
          and(
            eq(timeBlockExceptions.workspaceId, workspaceId),
            eq(timeBlockExceptions.seriesId, plan.series.id),
            gte(timeBlockExceptions.occurrenceDate, plan.occurrenceDate),
          ),
        )
        .returning({ id: timeBlockExceptions.id });
      exceptionIds.push(...removed.map((row: { id: string }) => row.id));
    }
  } else if (plan.action === "update") {
    await tx
      .update(timeBlocks)
      .set({ ...plan.updateValues, updatedAt: now })
      .where(and(eq(timeBlocks.id, plan.series.id), eq(timeBlocks.workspaceId, workspaceId)));
  } else {
    const deletedExceptions = await tx
      .delete(timeBlockExceptions)
      .where(
        and(
          eq(timeBlockExceptions.workspaceId, workspaceId),
          eq(timeBlockExceptions.seriesId, plan.series.id),
        ),
      )
      .returning({ id: timeBlockExceptions.id });
    exceptionIds.push(...deletedExceptions.map((row: { id: string }) => row.id));
    await tx
      .delete(timeBlocks)
      .where(and(eq(timeBlocks.id, plan.series.id), eq(timeBlocks.workspaceId, workspaceId)));
  }
  return { seriesIds, exceptionIds };
}

async function readActualMutationState(
  db: DbLike | any,
  input: {
    workspaceId: string;
    planId: string;
    plan: MutationPlan;
    seriesIds: string[];
  },
) {
  const snapshot = await loadEffectiveTimeBlocks(db, {
    workspaceId: input.workspaceId,
    rangeStart: input.plan.rangeStart,
    rangeEnd: input.plan.rangeEnd,
  });
  // The same readback runs inside the mutation transaction; one pg client
  // must execute its queries sequentially.
  const taskRows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, input.workspaceId),
        eq(tasks.planId, input.planId),
        isNull(tasks.archivedAt),
        gte(tasks.date, input.plan.rangeStart),
        lt(tasks.date, input.plan.rangeEnd),
      ),
    );
  const routineRows = await db.select().from(routines).where(eq(routines.workspaceId, input.workspaceId));
  const capacityRows = await db
    .select()
    .from(dayCapacities)
    .where(
      and(
        eq(dayCapacities.workspaceId, input.workspaceId),
        gte(dayCapacities.date, input.plan.rangeStart),
        lt(dayCapacities.date, input.plan.rangeEnd),
      ),
    );
  const capacity = buildCapacityModel({
    dates: datesForCapacity(input.plan.affectedDates),
    capacities: capacityRows,
    tasks: taskRows,
    timeBlocks: snapshot.occurrences.map((row) => ({ ...row, recurrenceWeekdayMask: null })),
    routines: routineRows,
  });
  return {
    status: "succeeded" as const,
    constraints: occurrenceSummary(
      snapshot.occurrences.filter((row) =>
        input.seriesIds.includes(row.recurrenceSourceId ?? row.id),
      ),
    ),
    capacity,
  };
}

type TimeBlockSeriesCommittedResult = {
  status: "succeeded" | "no_change";
  operationId: string;
  seriesIds: string[];
  exceptionIds: string[];
  affectedDates: string[];
  transactionReadback: Awaited<ReturnType<typeof readActualMutationState>>;
};

export async function attachTimeBlockSeriesPostCommitReadback(
  committed: TimeBlockSeriesCommittedResult,
  readback: () => Promise<Awaited<ReturnType<typeof readActualMutationState>>>,
  persistResult?: (result: Record<string, unknown>) => Promise<unknown>,
) {
  let result: Record<string, unknown>;
  try {
    result = {
      ...committed,
      readback: { verification: "succeeded" as const, ...(await readback()) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Post-commit readback failed";
    result = {
      ...committed,
      status: committed.status === "succeeded" ? "applied_with_readback_error" : committed.status,
      persistedStatus: committed.status,
      readback: {
        verification: "failed" as const,
        error: { code: "readback_failed", message },
      },
      warnings: [{ code: "readback_failed", message, mutationApplied: committed.status === "succeeded" }],
    };
  }
  if (persistResult) await persistResult(result).catch(() => undefined);
  return result;
}

export async function applyTimeBlockSeriesMutation(
  db: DbLike,
  input: {
    workspaceId: string;
    action: TimeBlockSeriesAction;
    request: TimeBlockSeriesRequest;
    previewToken: string;
    approvalId?: string;
    idempotencyKey: string;
    source?: "manual" | "mcp";
    now?: Date;
  },
) {
  validateRequest(input.action, input.request);
  const now = input.now ?? new Date();
  const requestHash = timeBlockSeriesHash(requestPayload(input.action, input.request));
  const verified = verifyTimeBlockSeriesPreviewToken({
    token: input.previewToken,
    workspaceId: input.workspaceId,
    action: input.action,
    requestHash,
    now,
  });
  if (!verified.ok) {
    throw new TimeBlockSeriesError("preview_required", verified.reason, 409);
  }
  const planId = await getActivePlanId(db, input.workspaceId);
  if (!planId) throw new TimeBlockSeriesError("invalid_request", "No active plan", 409);
  const [existingOperation] = await db
    .select()
    .from(planOperations)
    .where(
      and(
        eq(planOperations.workspaceId, input.workspaceId),
        eq(planOperations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existingOperation && existingOperation.status !== "started") {
    const duplicate = await claimOperation(db, {
      workspaceId: input.workspaceId,
      planId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      now,
    });
    if (duplicate.duplicate) {
      return {
        status: "duplicate" as const,
        operationId: duplicate.operation.id,
        priorStatus: duplicate.operation.status,
        result: duplicate.operation.resultJson,
      };
    }
  }
  await verifyOperationApproval(db, {
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    operationKind: `${input.action}_time_block_series`,
    requestHash,
    previewToken: input.previewToken,
    now,
  });
  const claim = await claimOperation(db, {
    workspaceId: input.workspaceId,
    planId,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    now,
  });
  if (claim.duplicate) {
    return {
      status: "duplicate" as const,
      operationId: claim.operation.id,
      priorStatus: claim.operation.status,
      result: claim.operation.resultJson,
    };
  }

  let committed: {
    status: "succeeded" | "no_change";
    operationId: string;
    seriesIds: string[];
    exceptionIds: string[];
    affectedDates: string[];
    transactionReadback: Awaited<ReturnType<typeof readActualMutationState>>;
    plan: MutationPlan;
  };
  try {
    committed = await db.transaction(async (tx) => {
      const snapshot = await readTargetSnapshot(tx, input.workspaceId, input.request.seriesId, true);
      const currentSnapshotHash = timeBlockSeriesHash(snapshotPayload(snapshot.series, snapshot.exceptions));
      if (currentSnapshotHash !== verified.payload.snapshotHash) {
        throw new TimeBlockSeriesError("preview_stale", "Time block series changed after preview", 409);
      }
      await consumeOperationApproval(tx, {
        workspaceId: input.workspaceId,
        approvalId: input.approvalId,
        operationKind: `${input.action}_time_block_series`,
        requestHash,
        previewToken: input.previewToken,
        now,
      });
      const plan = planTimeBlockSeriesMutation({
        action: input.action,
        request: input.request,
        ...snapshot,
      });
      const applied = plan.noChange
        ? { seriesIds: [plan.series.id], exceptionIds: [] as string[] }
        : await executeMutation(tx, input.workspaceId, plan);
      const transactionReadback = await readActualMutationState(tx, {
        workspaceId: input.workspaceId,
        planId,
        plan,
        seriesIds: applied.seriesIds,
      });
      const result = {
        status: plan.noChange ? "no_change" as const : "succeeded" as const,
        operationId: claim.operation.id,
        seriesIds: applied.seriesIds,
        exceptionIds: applied.exceptionIds,
        affectedDates: plan.affectedDates,
        transactionReadback,
      };
      await tx.insert(changeLogs).values({
        workspaceId: input.workspaceId,
        planId,
        source: input.source ?? "mcp",
        summary: plan.noChange
          ? "Time block series unchanged"
          : input.action === "update"
            ? "Updated time block series"
            : "Deleted time block series",
        detailsJson: {
          operationId: claim.operation.id,
          idempotencyKey: input.idempotencyKey,
          seriesId: input.request.seriesId,
          requestedScope: input.request.scope,
          effectiveScope: plan.effectiveScope,
          occurrenceDate: input.request.occurrenceDate,
          seriesIds: applied.seriesIds,
          exceptionIds: applied.exceptionIds,
          affectedDates: plan.affectedDates,
          status: result.status,
        },
      });
      await tx
        .update(planOperations)
        .set({
          status: result.status,
          resultJson: result,
          errorJson: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(planOperations.id, claim.operation.id),
            eq(planOperations.workspaceId, input.workspaceId),
          ),
        );
      return { ...result, plan };
    });
  } catch (error) {
    await markOperationFailed(db, input.workspaceId, claim.operation.id, error);
    throw error;
  }

  return attachTimeBlockSeriesPostCommitReadback(
    committed,
    () => readActualMutationState(db, {
      workspaceId: input.workspaceId,
      planId,
      plan: committed.plan,
      seriesIds: committed.seriesIds,
    }),
    (result) => db
      .update(planOperations)
      .set({ resultJson: result, updatedAt: new Date() })
      .where(
        and(
          eq(planOperations.id, committed.operationId),
          eq(planOperations.workspaceId, input.workspaceId),
        ),
      ),
  );
}

export function previewUpdateTimeBlockSeries(
  db: DbLike,
  input: { workspaceId: string; request: TimeBlockSeriesRequest; now?: Date },
) {
  return previewTimeBlockSeriesMutation(db, { ...input, action: "update" });
}

export function previewDeleteTimeBlockSeries(
  db: DbLike,
  input: { workspaceId: string; request: TimeBlockSeriesRequest; now?: Date },
) {
  return previewTimeBlockSeriesMutation(db, { ...input, action: "delete" });
}

export function updateTimeBlockSeries(
  db: DbLike,
  input: Omit<Parameters<typeof applyTimeBlockSeriesMutation>[1], "action">,
) {
  return applyTimeBlockSeriesMutation(db, { ...input, action: "update" });
}

export function deleteTimeBlockSeries(
  db: DbLike,
  input: Omit<Parameters<typeof applyTimeBlockSeriesMutation>[1], "action">,
) {
  return applyTimeBlockSeriesMutation(db, { ...input, action: "delete" });
}
