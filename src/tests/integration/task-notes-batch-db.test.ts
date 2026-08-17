import { randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decideOperationApproval } from "@/lib/approvals/service";
import {
  changeLogs,
  operationApprovals,
  planOperations,
  plans,
  tasks,
  workspaces,
} from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import { applyTaskNotesBatch, proposeTaskNotesBatch } from "@/lib/mcp/task-notes-batch";

const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseIntegration =
  process.env.RUN_DATABASE_INTEGRATION === "1" &&
  /(?:localhost|127\.0\.0\.1)/.test(databaseUrl);

describe.runIf(runDatabaseIntegration)("task notes batch PostgreSQL integration", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const workspaceIds: string[] = [];
  const previousSecret = process.env.APP_SECRET;

  beforeAll(() => {
    process.env.APP_SECRET = "task-notes-batch-local-integration-secret";
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

  async function seedTasks(taskCount: number) {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name: `__notes_batch_${randomUUID()}`, passwordHash: "integration-test" })
      .returning();
    workspaceIds.push(workspace.id);
    const [plan] = await db
      .insert(plans)
      .values({
        workspaceId: workspace.id,
        title: "Notes batch plan",
        startDate: new Date("2026-08-01T00:00:00.000+08:00"),
        endDate: new Date("2026-12-31T00:00:00.000+08:00"),
        status: "active",
        baselineSnapshot: {},
      })
      .returning();
    const taskRows = await db
      .insert(tasks)
      .values(Array.from({ length: taskCount }, (_, index) => ({
        workspaceId: workspace.id,
        planId: plan.id,
        title: `Notes task ${index + 1}`,
        notes: `old ${index + 1}`,
        date: new Date("2026-08-20T09:00:00.000+08:00"),
        daySegment: "morning" as const,
      })))
      .returning();
    return { workspace, plan, taskRows };
  }

  it("shows 43 diffs in one approval and atomically applies them once", async () => {
    const { workspace, taskRows } = await seedTasks(43);
    const operations = taskRows.map((task, index) => ({ taskId: task.id, notes: `new ${index + 1}` }));
    const proposalIdempotencyKey = `propose-notes-${randomUUID()}`;

    const preview = await proposeTaskNotesBatch(db, {
      workspaceId: workspace.id,
      idempotencyKey: proposalIdempotencyKey,
      operations,
      reason: "Replace the exact 43 task notes",
    });
    expect(preview).toMatchObject({ status: "draft_created", count: 43, liveUnchanged: true });
    const approvals = await db.select().from(operationApprovals).where(eq(operationApprovals.workspaceId, workspace.id));
    expect(approvals).toHaveLength(1);
    expect((approvals[0].summaryJson as { noteChanges: unknown[] }).noteChanges).toHaveLength(43);
    const duplicatePreview = await proposeTaskNotesBatch(db, {
      workspaceId: workspace.id,
      idempotencyKey: proposalIdempotencyKey,
      operations,
      reason: "Replace the exact 43 task notes",
    });
    expect(duplicatePreview).toMatchObject({
      status: "duplicate",
      originalStatus: "succeeded",
      approvalId: preview.approvalId,
      previewToken: preview.previewToken,
    });
    const approvalsAfterRetry = await db.select().from(operationApprovals)
      .where(eq(operationApprovals.workspaceId, workspace.id));
    expect(approvalsAfterRetry).toHaveLength(1);
    const before = await db.select({ notes: tasks.notes }).from(tasks).where(eq(tasks.workspaceId, workspace.id));
    expect(before.every((row) => row.notes?.startsWith("old "))).toBe(true);

    await decideOperationApproval(db, {
      workspaceId: workspace.id,
      approvalId: preview.approvalId,
      decision: "approved",
    });
    const idempotencyKey = `notes-${randomUUID()}`;
    const applied = await applyTaskNotesBatch(db, {
      workspaceId: workspace.id,
      approvalId: preview.approvalId,
      previewToken: preview.previewToken,
      idempotencyKey,
    });
    expect(applied).toMatchObject({
      status: "succeeded",
      processedCount: 43,
      mutationApplied: true,
      postCommitReadback: { verification: "succeeded" },
    });
    expect(applied.postCommitReadback.verification === "succeeded" && applied.postCommitReadback.tasks).toHaveLength(43);

    const persisted = await db.select({ id: tasks.id, notes: tasks.notes }).from(tasks)
      .where(eq(tasks.workspaceId, workspace.id)).orderBy(tasks.id);
    const expectedById = new Map(operations.map((operation) => [operation.taskId, operation.notes]));
    expect(persisted.every((task) => task.notes === expectedById.get(task.id))).toBe(true);
    const [auditCount] = await db.select({ value: count() }).from(changeLogs).where(and(
      eq(changeLogs.workspaceId, workspace.id),
      eq(changeLogs.summary, "Approved batch updated task notes"),
    ));
    expect(Number(auditCount.value)).toBe(43);
    const [approval] = await db.select().from(operationApprovals).where(eq(operationApprovals.id, preview.approvalId));
    expect(approval.status).toBe("consumed");

    const duplicate = await applyTaskNotesBatch(db, {
      workspaceId: workspace.id,
      approvalId: preview.approvalId,
      previewToken: preview.previewToken,
      idempotencyKey,
    });
    expect(duplicate).toMatchObject({ status: "duplicate", originalStatus: "succeeded", mutationApplied: true });
    const [auditCountAfterDuplicate] = await db.select({ value: count() }).from(changeLogs).where(and(
      eq(changeLogs.workspaceId, workspace.id),
      eq(changeLogs.summary, "Approved batch updated task notes"),
    ));
    expect(Number(auditCountAfterDuplicate.value)).toBe(43);
  });

  it("rolls back the whole batch when one task changed after Preview", async () => {
    const { workspace, taskRows } = await seedTasks(2);
    const preview = await proposeTaskNotesBatch(db, {
      workspaceId: workspace.id,
      idempotencyKey: `propose-notes-${randomUUID()}`,
      operations: taskRows.map((task, index) => ({ taskId: task.id, notes: `new ${index + 1}` })),
    });
    await decideOperationApproval(db, {
      workspaceId: workspace.id,
      approvalId: preview.approvalId,
      decision: "approved",
    });
    await db.update(tasks).set({ title: "Concurrent edit", updatedAt: new Date() }).where(eq(tasks.id, taskRows[1].id));
    const operationsBeforeApply = await db.select().from(planOperations)
      .where(eq(planOperations.workspaceId, workspace.id));

    await expect(applyTaskNotesBatch(db, {
      workspaceId: workspace.id,
      approvalId: preview.approvalId,
      previewToken: preview.previewToken,
      idempotencyKey: `notes-${randomUUID()}`,
    })).rejects.toMatchObject({ code: "preview_stale" });

    const persisted = await db.select({ notes: tasks.notes }).from(tasks)
      .where(eq(tasks.workspaceId, workspace.id)).orderBy(tasks.id);
    expect(persisted.map((task) => task.notes).sort()).toEqual(["old 1", "old 2"]);
    const [approval] = await db.select().from(operationApprovals).where(eq(operationApprovals.id, preview.approvalId));
    expect(approval.status).toBe("approved");
    const operations = await db.select().from(planOperations).where(eq(planOperations.workspaceId, workspace.id));
    expect(operations).toHaveLength(operationsBeforeApply.length);
  });
});
