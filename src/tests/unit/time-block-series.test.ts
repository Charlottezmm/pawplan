import { afterEach, describe, expect, it } from "vitest";
import {
  attachTimeBlockSeriesPostCommitReadback,
  planTimeBlockSeriesMutation,
  TimeBlockSeriesError,
} from "@/lib/constraints/time-block-series";
import {
  createTimeBlockSeriesPreviewToken,
  timeBlockSeriesHash,
  verifyTimeBlockSeriesPreviewToken,
} from "@/lib/constraints/time-block-series-token";

function series(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    title: "Hardware learning",
    kind: "routine" as const,
    startsAt: new Date("2026-08-03T05:00:00.000+08:00"),
    endsAt: new Date("2026-08-31T07:00:00.000+08:00"),
    location: "Engineering 204",
    recurrenceRule: "weekly",
    recurrenceWeekdayMask: 1 << 1,
    courseId: null,
    trackId: null,
    movable: false,
    protected: true,
    estimatedMinutes: null,
    energyLevel: null,
    revision: 0,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("time block series mutation planning", () => {
  it("preserves the committed mutation when post-commit readback fails", async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const result = await attachTimeBlockSeriesPostCommitReadback(
      {
        status: "succeeded",
        operationId: "operation-1",
        seriesIds: [series().id],
        exceptionIds: [],
        affectedDates: ["2026-08-10"],
        transactionReadback: { status: "succeeded", constraints: [] } as never,
      },
      async () => { throw new Error("read replica unavailable"); },
      async (value) => { persisted.push(value); },
    );

    expect(result).toMatchObject({
      status: "applied_with_readback_error",
      persistedStatus: "succeeded",
      readback: {
        verification: "failed",
        error: { code: "readback_failed", message: "read replica unavailable" },
      },
      warnings: [{ code: "readback_failed", mutationApplied: true }],
    });
    expect(persisted).toHaveLength(1);
  });

  it("overrides only the selected occurrence", () => {
    const plan = planTimeBlockSeriesMutation({
      action: "update",
      request: {
        seriesId: series().id,
        scope: "occurrence",
        occurrenceDate: "2026-08-10",
        changes: {
          title: "Hardware exam",
          startTime: "08:00",
          endTime: "09:30",
          location: "Engineering 305",
          protected: false,
        },
      },
      series: series(),
      exceptions: [],
    });

    expect(plan.nextSeries).toHaveLength(1);
    expect(plan.nextExceptions).toEqual([
      expect.objectContaining({
        seriesId: series().id,
        occurrenceDate: "2026-08-10",
        action: "override",
        overrideTitle: "Hardware exam",
        overrideStartsAt: new Date("2026-08-10T08:00:00.000+08:00"),
        overrideEndsAt: new Date("2026-08-10T09:30:00.000+08:00"),
        overrideLocation: "Engineering 305",
        overrideLocationSet: true,
        overrideProtected: false,
      }),
    ]);
  });

  it("splits this-and-future while preserving the old daily end time", () => {
    const plan = planTimeBlockSeriesMutation({
      action: "update",
      request: {
        seriesId: series().id,
        scope: "following",
        occurrenceDate: "2026-08-17",
        changes: { title: "Research hardware", startTime: "09:00", endTime: "11:00", location: "Lab 2" },
      },
      series: series(),
      exceptions: [],
    });

    expect(plan.effectiveScope).toBe("following");
    expect(plan.nextSeries).toHaveLength(2);
    expect(plan.nextSeries[0].endsAt).toEqual(new Date("2026-08-16T07:00:00.000+08:00"));
    expect(plan.nextSeries[1]).toMatchObject({
      title: "Research hardware",
      startsAt: new Date("2026-08-17T09:00:00.000+08:00"),
      endsAt: new Date("2026-08-31T11:00:00.000+08:00"),
      location: "Lab 2",
    });
  });

  it("keeps occurrence location inherited unless the request explicitly overrides it", () => {
    const plan = planTimeBlockSeriesMutation({
      action: "update",
      request: {
        seriesId: series().id,
        scope: "occurrence",
        occurrenceDate: "2026-08-10",
        changes: { title: "Hardware exam" },
      },
      series: series(),
      exceptions: [],
    });

    expect(plan.nextExceptions[0]).toMatchObject({ overrideLocation: null, overrideLocationSet: false });
    expect(plan.nextSeries[0].location).toBe("Engineering 204");
  });

  it("records an explicit nullable occurrence location override", () => {
    const plan = planTimeBlockSeriesMutation({
      action: "update",
      request: {
        seriesId: series().id,
        scope: "occurrence",
        occurrenceDate: "2026-08-10",
        changes: { location: null },
      },
      series: series(),
      exceptions: [],
    });

    expect(plan.nextExceptions[0]).toMatchObject({ overrideLocation: null, overrideLocationSet: true });
  });

  it("stops this-and-future without removing earlier occurrences", () => {
    const plan = planTimeBlockSeriesMutation({
      action: "delete",
      request: {
        seriesId: series().id,
        scope: "following",
        occurrenceDate: "2026-08-17",
      },
      series: series(),
      exceptions: [],
    });

    expect(plan.nextSeries).toHaveLength(1);
    expect(plan.nextSeries[0].endsAt).toEqual(new Date("2026-08-16T07:00:00.000+08:00"));
    expect(plan.affectedDates).toContain("2026-08-10");
    expect(plan.affectedDates).toContain("2026-08-31");
  });

  it("treats following on the first occurrence as a whole-series mutation", () => {
    const plan = planTimeBlockSeriesMutation({
      action: "delete",
      request: {
        seriesId: series().id,
        scope: "following",
        occurrenceDate: "2026-08-03",
      },
      series: series(),
      exceptions: [],
    });

    expect(plan.effectiveScope).toBe("series");
    expect(plan.nextSeries).toEqual([]);
  });

  it("rejects recurrence changes for one occurrence", () => {
    expect(() =>
      planTimeBlockSeriesMutation({
        action: "update",
        request: {
          seriesId: series().id,
          scope: "occurrence",
          occurrenceDate: "2026-08-10",
          changes: { weekdayMask: 62 },
        },
        series: series(),
        exceptions: [],
      }),
    ).toThrowError(TimeBlockSeriesError);
  });

  it("marks an identical whole-series update as no_change", () => {
    const plan = planTimeBlockSeriesMutation({
      action: "update",
      request: {
        seriesId: series().id,
        scope: "series",
        occurrenceDate: "2026-08-10",
        changes: { title: "Hardware learning", protected: true },
      },
      series: series(),
      exceptions: [],
    });

    expect(plan.noChange).toBe(true);
  });
});

describe("time block preview token", () => {
  const previousSecret = process.env.APP_SECRET;

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
  });

  it("binds the HMAC token to request, snapshot, workspace, and expiry", () => {
    process.env.APP_SECRET = "test-secret";
    const now = new Date("2026-08-16T00:00:00.000Z");
    const requestHash = timeBlockSeriesHash({ scope: "occurrence", occurrenceDate: "2026-08-17" });
    const token = createTimeBlockSeriesPreviewToken({
      workspaceId: series().workspaceId,
      action: "delete",
      requestHash,
      snapshotHash: "snapshot-a",
      now,
    });

    expect(
      verifyTimeBlockSeriesPreviewToken({
        token,
        workspaceId: series().workspaceId,
        action: "delete",
        requestHash,
        now: new Date("2026-08-16T00:10:00.000Z"),
      }),
    ).toMatchObject({ ok: true, payload: { snapshotHash: "snapshot-a" } });
    expect(
      verifyTimeBlockSeriesPreviewToken({
        token,
        workspaceId: series().workspaceId,
        action: "update",
        requestHash,
        now,
      }),
    ).toMatchObject({ ok: false });
    expect(
      verifyTimeBlockSeriesPreviewToken({
        token,
        workspaceId: series().workspaceId,
        action: "delete",
        requestHash,
        now: new Date("2026-08-16T00:31:00.000Z"),
      }),
    ).toMatchObject({ ok: false, reason: "Time block preview token expired" });
  });
});
