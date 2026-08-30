import { describe, expect, it } from "vitest";
import { materializeTimetableRows, timetableBlockFingerprint } from "@/lib/imports/timetable-save";
import { inspectTimetableImportConflicts } from "@/lib/mcp/timetable-import";

function fakeDb(rows: Array<Record<string, unknown>>) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
    insert() {
      throw new Error("not used");
    },
  };
}

const incomingRow = {
  title: "Deep Learning Lecture",
  kind: "course" as const,
  dayOfWeek: "Monday",
  startTime: "09:00",
  endTime: "11:00",
  startsOn: "2026-09-07",
  endsOn: "2026-09-14",
  course: "Deep Learning",
  location: "Room 204",
  recurrence: "weekly",
  notes: null,
};

describe("timetable import inspection", () => {
  it("classifies an exact historical block as existing instead of a conflict", async () => {
    const blocks = materializeTimetableRows([incomingRow]);
    const fingerprint = timetableBlockFingerprint(blocks[0]);
    const inspection = await inspectTimetableImportConflicts(fakeDb([
      {
        id: "existing-1",
        title: incomingRow.title,
        kind: incomingRow.kind,
        startsAt: blocks[0].startsAt,
        endsAt: blocks[0].endsAt,
        recurrenceRule: incomingRow.recurrence,
        recurrenceWeekdayMask: blocks[0].recurrenceWeekdayMask,
        location: incomingRow.location,
        importFingerprint: null,
      },
    ]), { workspaceId: "workspace-1", blocks });

    expect(inspection.existingFingerprints).toContain(fingerprint);
    expect(inspection.conflicts).toEqual([]);
    expect(inspection.conflictFingerprints.size).toBe(0);
  });

  it("keeps a different overlapping block as an explicit conflict", async () => {
    const blocks = materializeTimetableRows([incomingRow]);
    const inspection = await inspectTimetableImportConflicts(fakeDb([
      {
        id: "existing-2",
        title: "Office Hours",
        kind: "meeting",
        startsAt: new Date("2026-09-07T02:00:00.000Z"),
        endsAt: new Date("2026-09-14T04:00:00.000Z"),
        recurrenceRule: "weekly",
        recurrenceWeekdayMask: 2,
        location: "Room 205",
        importFingerprint: null,
      },
    ]), { workspaceId: "workspace-1", blocks });

    expect(inspection.conflicts).toEqual(["Deep Learning Lecture 与 Office Hours 时间重叠"]);
    expect(inspection.conflictFingerprints).toContain(timetableBlockFingerprint(blocks[0]));
  });
});
