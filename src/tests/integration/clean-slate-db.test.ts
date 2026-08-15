import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decideOperationApproval } from "@/lib/approvals/service";
import {
  planOperations,
  plans,
  planVersions,
  projects,
  tasks,
  timeBlockExceptions,
  timeBlocks,
  workspaces,
} from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import { previewReplacePlanWindow, replacePlanWindow } from "@/lib/mcp/replace-plan-window";
import { applyTaskArchiveBatch, previewTaskBatch } from "@/lib/mcp/task-archive";
import {
  applyTimeBlockSeriesMutation,
  previewTimeBlockSeriesMutation,
} from "@/lib/constraints/time-block-series";
import { loadEffectiveTimeBlocks } from "@/lib/planning/effective-time-blocks";

const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseIntegration =
  process.env.RUN_DATABASE_INTEGRATION === "1" &&
  /(?:localhost|127\.0\.0\.1)/.test(databaseUrl);

describe.runIf(runDatabaseIntegration)("Clean Slate PostgreSQL integration", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const workspaceIds: string[] = [];
  const previousSecret = process.env.APP_SECRET;

  beforeAll(() => {
    process.env.APP_SECRET = "clean-slate-local-integration-secret";
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
  });

  afterEach(async () => {
    if (workspaceIds.length > 0) {
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds.splice(0)));
    }
  });

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
    await pool.end();
  });

  async function seedPlan(label: string) {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `__clean_slate_${label}_${randomUUID()}`, passwordHash: "integration-test" })
      .returning();
    workspaceIds.push(workspace.id);
    const [plan] = await db
      .insert(plans)
      .values({
        workspaceId: workspace.id,
        title: "Integration plan",
        startDate: new Date("2026-08-01T00:00:00.000+08:00"),
        endDate: new Date("2026-12-31T00:00:00.000+08:00"),
        status: "active",
        baselineSnapshot: {},
      })
      .returning();
    const [version] = await db
      .insert(planVersions)
      .values({
        workspaceId: workspace.id,
        planId: plan.id,
        versionNumber: 1,
        snapshot: {},
        source: "baseline",
      })
      .returning();
    await db.update(plans).set({ currentVersionId: version.id }).where(eq(plans.id, plan.id));
    return { workspace, plan: { ...plan, currentVersionId: version.id }, version };
  }

  it("archives and restores the exact 61 todo plus 79 backlog selection", async () => {
    const { workspace, plan } = await seedPlan("archive");
    await db.insert(tasks).values(Array.from({ length: 140 }, (_, index) => ({
      workspaceId: workspace.id,
      planId: plan.id,
      title: `Legacy task ${index + 1}`,
      date: new Date(`2026-08-${String(1 + (index % 28)).padStart(2, "0")}T09:00:00.000+08:00`),
      daySegment: "morning" as const,
      status: index < 61 ? "todo" as const : "backlog" as const,
      estimatedMinutes: 30,
    })));

    const preview = await previewTaskBatch(db, {
      workspaceId: workspace.id,
      action: "archive",
      filters: { statuses: ["todo", "backlog"] },
    });
    expect(preview).toMatchObject({ status: "succeeded", count: 140, totalMinutes: 4_200 });
    await decideOperationApproval(db, {
      workspaceId: workspace.id,
      approvalId: preview.approvalId!,
      decision: "approved",
    });

    const idempotencyKey = `archive-${randomUUID()}`;
    const archived = await applyTaskArchiveBatch(db, {
      workspaceId: workspace.id,
      action: "archive",
      previewToken: preview.previewToken,
      approvalId: preview.approvalId,
      confirmTaskCount: 140,
      idempotencyKey,
    });
    expect(archived).toMatchObject({ status: "succeeded", processedCount: 140 });

    const [activeTodo, activeBacklog, archivedCount] = await Promise.all([
      db.select({ value: count() }).from(tasks).where(and(
        eq(tasks.workspaceId, workspace.id), eq(tasks.status, "todo"), isNull(tasks.archivedAt),
      )),
      db.select({ value: count() }).from(tasks).where(and(
        eq(tasks.workspaceId, workspace.id), eq(tasks.status, "backlog"), isNull(tasks.archivedAt),
      )),
      db.select({ value: count() }).from(tasks).where(and(
        eq(tasks.workspaceId, workspace.id), isNotNull(tasks.archivedAt),
      )),
    ]);
    expect({ todo: activeTodo[0].value, backlog: activeBacklog[0].value, archived: archivedCount[0].value })
      .toEqual({ todo: 0, backlog: 0, archived: 140 });

    const duplicate = await applyTaskArchiveBatch(db, {
      workspaceId: workspace.id,
      action: "archive",
      previewToken: preview.previewToken,
      approvalId: preview.approvalId,
      confirmTaskCount: 140,
      idempotencyKey,
    });
    expect(duplicate).toMatchObject({ status: "duplicate", processedCount: 140 });

    const restorePreview = await previewTaskBatch(db, {
      workspaceId: workspace.id,
      action: "restore",
      filters: { taskIds: archived.taskIds },
    });
    await decideOperationApproval(db, {
      workspaceId: workspace.id,
      approvalId: restorePreview.approvalId!,
      decision: "approved",
    });
    const restored = await applyTaskArchiveBatch(db, {
      workspaceId: workspace.id,
      action: "restore",
      previewToken: restorePreview.previewToken,
      approvalId: restorePreview.approvalId,
      confirmTaskCount: 140,
      idempotencyKey: `restore-${randomUUID()}`,
    });
    expect(restored).toMatchObject({ status: "succeeded", processedCount: 140 });
    const [remainingArchived] = await db
      .select({ value: count() })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspace.id), isNotNull(tasks.archivedAt)));
    expect(remainingArchived.value).toBe(0);
  });

  it("does not resolve exact task IDs across workspaces", async () => {
    const first = await seedPlan("workspace_a");
    const second = await seedPlan("workspace_b");
    const [task] = await db.insert(tasks).values({
      workspaceId: first.workspace.id,
      planId: first.plan.id,
      title: "Private task",
      date: new Date("2026-08-20T09:00:00.000+08:00"),
      daySegment: "morning",
    }).returning();

    await expect(previewTaskBatch(db, {
      workspaceId: second.workspace.id,
      action: "archive",
      filters: { taskIds: [task.id] },
    })).rejects.toMatchObject({ code: "unresolved_filter" });
  });

  it("rolls back the old-task archive when replacement task insertion fails", async () => {
    const { workspace, plan, version } = await seedPlan("replace_rollback");
    const [project] = await db.insert(projects).values({
      workspaceId: workspace.id,
      name: "Research project",
      category: "科研",
      objective: "Verify atomic replacement",
      successCriteria: "Rollback is observed",
      status: "active",
      priority: "high",
      needsDefinition: false,
    }).returning();
    const [oldTask] = await db.insert(tasks).values({
      workspaceId: workspace.id,
      planId: plan.id,
      projectId: project.id,
      title: "Old managed task",
      date: new Date("2026-08-20T09:00:00.000+08:00"),
      daySegment: "morning",
    }).returning();
    const request = {
      workspaceId: workspace.id,
      dateFrom: "2026-08-15",
      dateTo: "2026-08-31",
      sourceKey: "integration-replace",
      expectedPlanId: plan.id,
      expectedCurrentVersionId: version.id,
      retireScope: "all_non_completed" as const,
      tasks: [{
        externalTaskKey: "replacement",
        title: "__clean_slate_forced_insert_failure__",
        projectId: project.id,
        date: "2026-08-20",
        daySegment: "morning" as const,
        estimatedMinutes: 30,
      }],
      weeklySummaries: [],
      monthlySummaries: [],
      focusProjectIds: [project.id],
      idempotencyKey: `replace-${randomUUID()}`,
      createdBy: "codex" as const,
    };
    const preview = await previewReplacePlanWindow(db, request);
    await decideOperationApproval(db, {
      workspaceId: workspace.id,
      approvalId: preview.approvalId!,
      decision: "approved",
    });

    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `clean_slate_fail_insert_${suffix}`;
    const triggerName = `clean_slate_fail_insert_trigger_${suffix}`;
    await pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title = '__clean_slate_forced_insert_failure__' THEN
          RAISE EXCEPTION 'forced clean slate insert failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON tasks
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);
    try {
      await expect(replacePlanWindow(db, {
        ...request,
        previewToken: preview.previewToken,
        approvalId: preview.approvalId,
      })).rejects.toThrow("forced clean slate insert failure");
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON tasks; DROP FUNCTION IF EXISTS ${functionName}();`);
    }

    const [oldTaskReadback] = await db.select().from(tasks).where(eq(tasks.id, oldTask.id));
    const [taskCount] = await db.select({ value: count() }).from(tasks).where(eq(tasks.workspaceId, workspace.id));
    const [versionCount] = await db.select({ value: count() }).from(planVersions).where(eq(planVersions.planId, plan.id));
    const [operation] = await db.select().from(planOperations).where(eq(planOperations.idempotencyKey, request.idempotencyKey));
    expect(oldTaskReadback.archivedAt).toBeNull();
    expect(taskCount.value).toBe(1);
    expect(versionCount.value).toBe(1);
    expect(operation.status).toBe("failed");
  });

  it("applies recurring cancel and override exceptions to effective readback", async () => {
    const { workspace } = await seedPlan("series_exceptions");
    const [series] = await db.insert(timeBlocks).values({
      workspaceId: workspace.id,
      title: "Hardware learning",
      kind: "routine",
      startsAt: new Date("2026-08-03T05:00:00.000+08:00"),
      endsAt: new Date("2026-08-31T07:00:00.000+08:00"),
      recurrenceRule: "weekly",
      recurrenceWeekdayMask: 1 << 1,
      protected: true,
    }).returning();
    const now = new Date("2026-08-01T00:00:00.000+08:00");

    const cancelRequest = {
      seriesId: series.id,
      scope: "occurrence" as const,
      occurrenceDate: "2026-08-10",
    };
    const cancelPreview = await previewTimeBlockSeriesMutation(db, {
      workspaceId: workspace.id,
      action: "delete",
      request: cancelRequest,
      now,
    });
    await decideOperationApproval(db, {
      workspaceId: workspace.id,
      approvalId: cancelPreview.approvalId,
      decision: "approved",
      now,
    });
    const cancelled = await applyTimeBlockSeriesMutation(db, {
      workspaceId: workspace.id,
      action: "delete",
      request: cancelRequest,
      previewToken: cancelPreview.previewToken,
      approvalId: cancelPreview.approvalId,
      idempotencyKey: `cancel-${randomUUID()}`,
      now,
    });
    expect(cancelled).toMatchObject({ status: "succeeded", readback: { verification: "succeeded" } });

    const overrideRequest = {
      seriesId: series.id,
      scope: "occurrence" as const,
      occurrenceDate: "2026-08-17",
      changes: { title: "Hardware exam", startTime: "08:00", endTime: "09:30", protected: false },
    };
    const overridePreview = await previewTimeBlockSeriesMutation(db, {
      workspaceId: workspace.id,
      action: "update",
      request: overrideRequest,
      now,
    });
    await decideOperationApproval(db, {
      workspaceId: workspace.id,
      approvalId: overridePreview.approvalId,
      decision: "approved",
      now,
    });
    const overridden = await applyTimeBlockSeriesMutation(db, {
      workspaceId: workspace.id,
      action: "update",
      request: overrideRequest,
      previewToken: overridePreview.previewToken,
      approvalId: overridePreview.approvalId,
      idempotencyKey: `override-${randomUUID()}`,
      now,
    });
    expect(overridden).toMatchObject({ status: "succeeded", readback: { verification: "succeeded" } });

    const exceptionRows = await db
      .select()
      .from(timeBlockExceptions)
      .where(eq(timeBlockExceptions.seriesId, series.id));
    expect(exceptionRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ occurrenceDate: "2026-08-10", action: "cancel" }),
      expect.objectContaining({
        occurrenceDate: "2026-08-17",
        action: "override",
        overrideTitle: "Hardware exam",
        overrideProtected: false,
      }),
    ]));

    const effective = await loadEffectiveTimeBlocks(db, {
      workspaceId: workspace.id,
      rangeStart: new Date("2026-08-10T00:00:00.000+08:00"),
      rangeEnd: new Date("2026-08-18T00:00:00.000+08:00"),
    });
    expect(effective.occurrences.some((occurrence) => occurrence.startsAt.toISOString().startsWith("2026-08-09T"))).toBe(false);
    expect(effective.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Hardware exam", protected: false }),
    ]));
  });
});
