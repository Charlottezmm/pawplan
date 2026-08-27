import { and, eq } from "drizzle-orm";
import { changeLogs, courses, plans, timeBlocks } from "@/lib/db/schema";
import { weekdayMaskFromRecurrence } from "@/lib/constraints/recurrence";
import { parseTimetableCsv, type TimetableImportPreviewRow } from "@/lib/imports/timetable-csv";
import { ImportSaveError } from "@/lib/imports/plan-save";

type ImportDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
} & TimetableWriteDb;

type TimetableWriteDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
};

const weekdayNumbers = new Map([
  ["sunday", 0],
  ["sun", 0],
  ["monday", 1],
  ["mon", 1],
  ["tuesday", 2],
  ["tue", 2],
  ["wednesday", 3],
  ["wed", 3],
  ["thursday", 4],
  ["thu", 4],
  ["friday", 5],
  ["fri", 5],
  ["saturday", 6],
  ["sat", 6],
]);

const maxTimetableImportRows = 200;
const maxTimetableImportRangeDays = 370;
const maxTimetableImportBlocks = 1000;

function parseDateKey(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new ImportSaveError("Invalid timetable date", 400);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ImportSaveError("Invalid timetable date", 400);
  }

  return date;
}

function daysBetween(start: Date, end: Date) {
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function parseTimeMinutes(value: string) {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new ImportSaveError("Invalid timetable time", 400);

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new ImportSaveError("Invalid timetable time", 400);
  return hours * 60 + minutes;
}

function normalizeWeekday(value: string | null) {
  if (!value) return null;
  const weekday = weekdayNumbers.get(value.trim().toLowerCase());
  if (weekday === undefined) throw new ImportSaveError("Invalid day_of_week", 400);
  return weekday;
}

function shanghaiDateTime(date: string, time: string) {
  return new Date(`${date}T${time}:00.000+08:00`);
}

export type MaterializedTimetableBlock = {
  row: TimetableImportPreviewRow;
  startsAt: Date;
  endsAt: Date;
  recurrenceWeekdayMask: number | null;
};

export type TimetableImportPublicBetaPreview = {
  rows: TimetableImportPreviewRow[];
  timezone: "Asia/Shanghai";
  blocksPreviewed: number;
  warnings: string[];
  conflicts: string[];
};

export function materializeTimetableRows(rows: TimetableImportPreviewRow[]) {
  if (rows.length > maxTimetableImportRows) throw new ImportSaveError("Timetable import has too many rows", 400);

  const blocks: Array<{
    row: TimetableImportPreviewRow;
    startsAt: Date;
    endsAt: Date;
    recurrenceWeekdayMask: number | null;
  }> = [];

  for (const row of rows) {
    const startMinutes = parseTimeMinutes(row.startTime);
    const endMinutes = parseTimeMinutes(row.endTime);
    if (endMinutes <= startMinutes) throw new ImportSaveError("end_time must be after start_time", 400);

    const rangeStart = parseDateKey(row.startsOn);
    const rangeEnd = parseDateKey(row.endsOn);
    if (rangeEnd.getTime() < rangeStart.getTime()) {
      throw new ImportSaveError("Invalid timetable date range", 400);
    }
    if (daysBetween(rangeStart, rangeEnd) > maxTimetableImportRangeDays) {
      throw new ImportSaveError("Timetable import date range is too long", 400);
    }

    const weekday = normalizeWeekday(row.dayOfWeek);
    // 没有显式 day_of_week 时，允许用 recurrence（每天 / 工作日 / 周一到周六 / weekly …）
    // 一行就生成一个跨多星期的循环块（多位掩码）。
    const ruleMask =
      weekday === null
        ? weekdayMaskFromRecurrence(row.recurrence, shanghaiDateTime(row.startsOn, row.startTime))
        : null;

    if (weekday !== null) {
      blocks.push({
        row,
        startsAt: shanghaiDateTime(row.startsOn, row.startTime),
        endsAt: shanghaiDateTime(row.endsOn, row.endTime),
        recurrenceWeekdayMask: 1 << weekday,
      });
    } else if (ruleMask !== null) {
      blocks.push({
        row,
        startsAt: shanghaiDateTime(row.startsOn, row.startTime),
        endsAt: shanghaiDateTime(row.endsOn, row.endTime),
        recurrenceWeekdayMask: ruleMask,
      });
    } else {
      if (row.startsOn !== row.endsOn) {
        throw new ImportSaveError("day_of_week or recurrence is required for multi-day timetable ranges", 400);
      }
      blocks.push({
        row,
        startsAt: shanghaiDateTime(row.startsOn, row.startTime),
        endsAt: shanghaiDateTime(row.startsOn, row.endTime),
        recurrenceWeekdayMask: null,
      });
    }

    if (blocks.length > maxTimetableImportBlocks) {
      throw new ImportSaveError("Timetable import has too many generated blocks", 400);
    }
  }

  if (blocks.length === 0) throw new ImportSaveError("No timetable blocks to import", 400);
  return blocks;
}

function shanghaiDateTimeLabel(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function duplicateEntries(values: Array<{ key: string; label: string }>) {
  const counts = new Map<string, { label: string; count: number }>();
  for (const value of values) {
    const current = counts.get(value.key);
    counts.set(value.key, { label: current?.label ?? value.label, count: (current?.count ?? 0) + 1 });
  }
  return Array.from(counts.values()).filter((entry) => entry.count > 1);
}

export function buildTimetableRowsPreview(rows: TimetableImportPreviewRow[]): TimetableImportPublicBetaPreview {
  const blocks = materializeTimetableRows(rows);
  const duplicateRows = duplicateEntries(
    rows.map((row) => ({
      key: [
        row.title.trim().toLowerCase(),
        row.dayOfWeek?.trim().toLowerCase() ?? row.startsOn,
        row.startTime,
        row.endTime,
        row.startsOn,
        row.endsOn,
      ].join("|"),
      label: `${row.title} ${row.dayOfWeek ?? row.startsOn} ${row.startTime}-${row.endTime}`,
    })),
  );
  const duplicateBlocks = duplicateEntries(
    blocks.map((block) => ({
      key: `${block.row.title.trim().toLowerCase()}|${block.startsAt.toISOString()}|${block.endsAt.toISOString()}`,
      label: `${block.row.title} on ${shanghaiDateTimeLabel(block.startsAt).slice(0, 10)} ${block.row.startTime}-${block.row.endTime}`,
    })),
  );

  return {
    rows,
    timezone: "Asia/Shanghai",
    blocksPreviewed: blocks.length,
    warnings: duplicateRows.map((entry) => `Duplicate timetable row: ${entry.label}`),
    conflicts: duplicateBlocks.map((entry) => `Duplicate imported time block: ${entry.label}`),
  };
}

export function buildTimetableImportPreview(csv: string): TimetableImportPublicBetaPreview {
  if (csv.length > 200_000) throw new ImportSaveError("Timetable CSV is too long", 400);

  let rows: TimetableImportPreviewRow[];
  try {
    rows = parseTimetableCsv(csv);
  } catch (error) {
    throw new ImportSaveError(error instanceof Error ? error.message : "Invalid timetable CSV", 400);
  }
  return buildTimetableRowsPreview(rows);
}

async function getActivePlanId(tx: TimetableWriteDb, workspaceId: string) {
  const [plan] = await tx
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.workspaceId, workspaceId), eq(plans.status, "active")))
    .limit(1);

  if (!plan) throw new ImportSaveError("No active plan", 400);
  return plan.id as string;
}

function courseNameFor(row: TimetableImportPreviewRow) {
  if (row.course) return row.course;
  if (row.kind === "course") return row.title;
  return null;
}

export async function saveTimetableImport(
  db: ImportDb,
  input: {
    workspaceId: string;
    csv: string;
    confirmation?: string;
  },
) {
  if (input.confirmation !== "CONFIRM_TIMETABLE_IMPORT") {
    throw new ImportSaveError("Timetable import confirmation required", 400);
  }
  const preview = buildTimetableImportPreview(input.csv);

  return db.transaction(async (tx) => {
    return saveTimetableRowsInTransaction(tx, {
      workspaceId: input.workspaceId,
      rows: preview.rows,
      sourceLabel: "timetable.csv",
      summary: "Imported timetable.csv preview",
      writeChangeLog: true,
      importPreview: preview,
    });
  });
}

export async function saveTimetableRowsInTransaction(
  tx: TimetableWriteDb,
  input: {
    workspaceId: string;
    rows: TimetableImportPreviewRow[];
    planId?: string;
    sourceLabel?: string;
    summary?: string;
    writeChangeLog?: boolean;
    importPreview?: TimetableImportPublicBetaPreview;
  },
) {
  const blocks = materializeTimetableRows(input.rows);
  const planId = input.planId ?? (await getActivePlanId(tx, input.workspaceId));
  const courseIds = new Map<string, string>();
  let coursesCreated = 0;
  let coursesReused = 0;

  for (const block of blocks) {
    const courseName = courseNameFor(block.row);
    if (!courseName || courseIds.has(courseName)) continue;

    const [existing] = await tx
      .select({ id: courses.id })
      .from(courses)
      .where(and(eq(courses.workspaceId, input.workspaceId), eq(courses.name, courseName)))
      .limit(1);

    if (existing) {
      courseIds.set(courseName, existing.id);
      coursesReused += 1;
      continue;
    }

    const [created] = await tx
      .insert(courses)
      .values({ workspaceId: input.workspaceId, name: courseName })
      .returning();
    courseIds.set(courseName, created.id);
    coursesCreated += 1;
  }

  const blockValues = blocks.map((block) => {
    const courseName = courseNameFor(block.row);
    return {
      workspaceId: input.workspaceId,
      title: block.row.title,
      kind: block.row.kind,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      recurrenceRule: block.row.recurrence,
      recurrenceWeekdayMask: block.recurrenceWeekdayMask,
      courseId: courseName ? courseIds.get(courseName) ?? null : null,
      location: block.row.location ?? null,
      movable: false,
    };
  });

  await tx.insert(timeBlocks).values(blockValues);

  if (input.writeChangeLog !== false) {
    await tx.insert(changeLogs).values({
      workspaceId: input.workspaceId,
      planId,
      source: "import",
      summary: input.summary ?? "Imported timetable preview",
      detailsJson: {
        format: input.sourceLabel ?? "timetable",
        rowsPreviewed: input.rows.length,
        timezone: input.importPreview?.timezone ?? "Asia/Shanghai",
        warnings: input.importPreview?.warnings ?? [],
        conflicts: input.importPreview?.conflicts ?? [],
        confirmedBy: input.importPreview ? "user" : undefined,
        confirmation: input.importPreview ? "CONFIRM_TIMETABLE_IMPORT" : undefined,
        blocksCreated: blockValues.length,
        coursesCreated,
        coursesReused,
        note: "Save adds new time_blocks; duplicate imports are not deduplicated.",
      },
    });
  }

  return {
    blocksCreated: blockValues.length,
    coursesCreated,
    coursesReused,
  };
}
