import { eq } from "drizzle-orm";
import type { TimetableOccurrenceView, TimetableWeekView } from "@/components/time-block-timetable";
import { getDb } from "@/lib/db/client";
import { courses } from "@/lib/db/schema";
import { loadEffectiveTimeBlocks } from "@/lib/planning/effective-time-blocks";
import { buildTimetableAxis } from "@/lib/planning/timetable-layout";

const shanghaiTimeZone = "Asia/Shanghai";
const dayMs = 24 * 60 * 60 * 1000;
const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
const coursePalette = ["#2563eb", "#7c3aed", "#0f766e", "#c2410c", "#be123c", "#0369a1", "#4d7c0f"];
const kindPalette = {
  exam: "#b7663d",
  meeting: "#537e9f",
  unavailable: "#7f7a72",
  routine: "#7a9561",
  recovery: "#8b72a7",
} as const;

export function shanghaiTimetableParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: shanghaiTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return {
    dateKey: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

function dateFromKey(dateKey: string) {
  return new Date(`${dateKey}T12:00:00.000+08:00`);
}

function addDays(dateKey: string, amount: number) {
  return shanghaiTimetableParts(new Date(dateFromKey(dateKey).getTime() + amount * dayMs)).dateKey;
}

function validDateKey(value: string | undefined, fallback: string) {
  if (!value || !dateKeyPattern.test(value)) return fallback;
  const parsed = dateFromKey(value);
  return Number.isNaN(parsed.getTime()) || shanghaiTimetableParts(parsed).dateKey !== value ? fallback : value;
}

function mondayFor(dateKey: string) {
  const date = dateFromKey(dateKey);
  const weekdayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: shanghaiTimeZone,
    weekday: "short",
  }).format(date);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayLabel);
  const normalizedWeekday = weekday >= 0 ? weekday : 1;
  return addDays(dateKey, normalizedWeekday === 0 ? -6 : 1 - normalizedWeekday);
}

function labelParts(dateKey: string) {
  const date = dateFromKey(dateKey);
  return {
    weekdayLabel: new Intl.DateTimeFormat("zh-CN", { timeZone: shanghaiTimeZone, weekday: "short" }).format(date),
    dateLabel: new Intl.DateTimeFormat("zh-CN", { timeZone: shanghaiTimeZone, month: "numeric", day: "numeric" }).format(date),
  };
}

function stableColor(key: string, stored: string | undefined) {
  if (stored && stored !== "#2563eb" && /^#[0-9a-f]{6}$/i.test(stored)) return stored;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return coursePalette[hash % coursePalette.length];
}

function occurrenceView(
  occurrence: Awaited<ReturnType<typeof loadEffectiveTimeBlocks>>["occurrences"][number],
  courseById: Map<string, { name: string; color: string }>,
): TimetableOccurrenceView | null {
  const start = shanghaiTimetableParts(occurrence.startsAt);
  const end = shanghaiTimetableParts(occurrence.endsAt);
  if (start.dateKey !== end.dateKey || end.minute <= start.minute) return null;
  const course = occurrence.courseId ? courseById.get(occurrence.courseId) : undefined;
  const seriesId = occurrence.recurrenceSourceId ?? occurrence.id;
  return {
    id: occurrence.id,
    seriesId,
    dateKey: start.dateKey,
    title: occurrence.title,
    kind: occurrence.kind,
    startsAt: occurrence.startsAt.toISOString(),
    endsAt: occurrence.endsAt.toISOString(),
    startMinute: start.minute,
    endMinute: end.minute,
    courseName: course?.name ?? null,
    location: occurrence.location ?? null,
    color: occurrence.kind === "course"
      ? stableColor(occurrence.courseId ?? seriesId, course?.color)
      : kindPalette[occurrence.kind],
  };
}

export async function getTimetableWeekView(
  workspaceId: string,
  requestedDateKey?: string,
): Promise<TimetableWeekView> {
  const todayDateKey = shanghaiTimetableParts(new Date()).dateKey;
  const selectedDateKey = validDateKey(requestedDateKey, todayDateKey);
  const weekStartKey = mondayFor(selectedDateKey);
  const weekEndKey = addDays(weekStartKey, 7);
  let occurrences: TimetableOccurrenceView[] = [];
  let unavailable = false;
  try {
    const db = getDb();
    const [snapshot, courseRows] = await Promise.all([
      loadEffectiveTimeBlocks(db, {
        workspaceId,
        rangeStart: new Date(`${weekStartKey}T00:00:00.000+08:00`),
        rangeEnd: new Date(`${weekEndKey}T00:00:00.000+08:00`),
        kinds: ["course", "exam", "meeting", "unavailable", "routine", "recovery"],
      }),
      db.select({ id: courses.id, name: courses.name, color: courses.color })
        .from(courses)
        .where(eq(courses.workspaceId, workspaceId)),
    ]);
    const courseById = new Map(courseRows.map((course) => [course.id, { name: course.name, color: course.color }]));
    occurrences = snapshot.occurrences
      .map((occurrence) => occurrenceView(occurrence, courseById))
      .filter((occurrence): occurrence is TimetableOccurrenceView => occurrence !== null);
  } catch (error) {
    unavailable = true;
    console.error("Unable to read timetable", error);
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const dateKey = addDays(weekStartKey, index);
    return {
      dateKey,
      ...labelParts(dateKey),
      isToday: dateKey === todayDateKey,
      occurrences: occurrences.filter((occurrence) => occurrence.dateKey === dateKey),
    };
  });
  const weekEndDisplayKey = addDays(weekStartKey, 6);
  const weekLabel = `${labelParts(weekStartKey).dateLabel} – ${labelParts(weekEndDisplayKey).dateLabel}`;

  return {
    weekLabel,
    days,
    selectedDateKey,
    todayDateKey,
    previousDateKey: addDays(selectedDateKey, -1),
    nextDateKey: addDays(selectedDateKey, 1),
    previousWeekDateKey: addDays(selectedDateKey, -7),
    nextWeekDateKey: addDays(selectedDateKey, 7),
    axis: buildTimetableAxis(occurrences),
    unavailable,
  };
}
