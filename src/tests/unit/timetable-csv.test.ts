import { describe, expect, it } from "vitest";
import { parseTimetableCsv } from "@/lib/imports/timetable-csv";
import { buildTimetableImportPreview } from "@/lib/imports/timetable-save";

describe("timetable csv parser", () => {
  it("extracts fixed weekly blocks with camelCase fields", () => {
    const result = parseTimetableCsv(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,location,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-12-20,Deep Learning,Room 204,weekly,Bring laptop
Office Hours,meeting,Tuesday,14:00,15:00,2026-09-01,2026-12-20,,,weekly,
`);

    expect(result).toEqual([
      {
        title: "Deep Learning Lecture",
        kind: "course",
        dayOfWeek: "Monday",
        startTime: "09:00",
        endTime: "11:00",
        startsOn: "2026-09-01",
        endsOn: "2026-12-20",
        course: "Deep Learning",
        location: "Room 204",
        recurrence: "weekly",
        notes: "Bring laptop",
      },
      {
        title: "Office Hours",
        kind: "meeting",
        dayOfWeek: "Tuesday",
        startTime: "14:00",
        endTime: "15:00",
        startsOn: "2026-09-01",
        endsOn: "2026-12-20",
        course: null,
        location: null,
        recurrence: "weekly",
        notes: null,
      },
    ]);
  });

  it("rejects unsupported timetable kinds", () => {
    expect(() =>
      parseTimetableCsv(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Errand,personal,Monday,09:00,10:00,2026-09-01,2026-12-20,,weekly,
`),
    ).toThrow();
  });

  it("does not infer a location from notes", () => {
    const [row] = parseTimetableCsv(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-12-20,Deep Learning,weekly,Room 204
`);

    expect(row.location).toBeNull();
    expect(row.notes).toBe("Room 204");
  });

  it("builds a public beta preview with duplicate warnings and Asia/Shanghai time blocks", () => {
    const result = buildTimetableImportPreview(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,weekly,Room 204
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,weekly,Room 204
`);

    expect(result).toEqual(
      expect.objectContaining({
        timezone: "Asia/Shanghai",
        rows: expect.any(Array),
        blocksPreviewed: 2,
        warnings: ["CSV 中存在重复行：Deep Learning Lecture Monday 09:00-11:00"],
        conflicts: [],
        conflictRowIndexes: [],
      }),
    );
  });

  it("marks different rows that overlap within the same import as conflicts", () => {
    const result = buildTimetableImportPreview(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,location,recurrence,notes
Lecture,course,Monday,09:00,11:00,2026-09-07,2026-09-14,Math,Room 1,weekly,
Office Hours,meeting,Monday,10:30,11:30,2026-09-07,2026-09-14,,Room 2,weekly,
`);

    expect(result.conflictRowIndexes).toEqual([0, 1]);
    expect(result.conflicts).toEqual(["Lecture 与本次导入中的 Office Hours 时间重叠"]);
  });

  it("rejects invalid dates, invalid times, end-before-start blocks, and too-long fields", () => {
    expect(() =>
      buildTimetableImportPreview(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Bad Date,meeting,Monday,09:00,10:00,2026-99-01,2026-09-14,,weekly,
`),
    ).toThrow("Invalid timetable date");

    expect(() =>
      buildTimetableImportPreview(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Bad Time,meeting,Monday,24:00,25:00,2026-09-01,2026-09-14,,weekly,
`),
    ).toThrow("Invalid timetable time");

    expect(() =>
      buildTimetableImportPreview(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Overnight,meeting,Monday,23:00,01:00,2026-09-01,2026-09-14,,weekly,
`),
    ).toThrow("end_time must be after start_time");

    expect(() =>
      buildTimetableImportPreview(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
${"x".repeat(181)},meeting,Monday,09:00,10:00,2026-09-01,2026-09-14,,weekly,
`),
    ).toThrow();
  });

  it("rejects imports that would materialize too many fixed blocks", () => {
    const rows = Array.from({ length: 201 }, (_, index) =>
      `Block ${index + 1},meeting,Monday,09:00,10:00,2026-09-01,2026-09-01,,,`,
    );

    expect(() =>
      buildTimetableImportPreview(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
${rows.join("\n")}
`),
    ).toThrow("Timetable import has too many rows");

    expect(() =>
      buildTimetableImportPreview(`title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Long Range,meeting,Monday,09:00,10:00,2026-01-01,2036-01-01,,weekly,
`),
    ).toThrow("Timetable import date range is too long");
  });
});
