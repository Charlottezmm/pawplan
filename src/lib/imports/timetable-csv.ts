import Papa from "papaparse";
import { z } from "zod";

const rowSchema = z.object({
  title: z.string().trim().min(1).max(180),
  kind: z.enum(["course", "exam", "meeting", "unavailable", "routine", "recovery"]),
  day_of_week: z.string().trim().max(20).optional(),
  start_time: z.string().trim().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().trim().regex(/^\d{2}:\d{2}$/),
  starts_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  ends_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  course: z.string().trim().max(120).optional(),
  location: z.string().trim().max(240).optional(),
  recurrence: z.string().trim().max(240).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export type TimetableImportPreviewRow = {
  title: string;
  kind: "course" | "exam" | "meeting" | "unavailable" | "routine" | "recovery";
  dayOfWeek: string | null;
  startTime: string;
  endTime: string;
  startsOn: string;
  endsOn: string;
  course: string | null;
  location?: string | null;
  recurrence: string | null;
  notes: string | null;
};

function optionalCell(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function parseTimetableCsv(csv: string): TimetableImportPreviewRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0].message);
  }

  return parsed.data.map((raw) => {
    const row = rowSchema.parse(raw);
    return {
      title: row.title,
      kind: row.kind,
      dayOfWeek: optionalCell(row.day_of_week),
      startTime: row.start_time,
      endTime: row.end_time,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      course: optionalCell(row.course),
      location: optionalCell(row.location),
      recurrence: optionalCell(row.recurrence),
      notes: optionalCell(row.notes),
    };
  });
}
