import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  proposeTaskTiming,
  applyTaskTiming,
  readTaskTiming,
} from "@/lib/planning/task-timing-service";
import { decideOperationApproval } from "@/lib/approvals/service";
const url = process.env.DATABASE_URL ?? "";
const run =
  process.env.RUN_DATABASE_INTEGRATION === "1" &&
  url.includes("pawplan_timing_check") &&
  url.includes("127.0.0.1");
describe.runIf(run)("task timing persistence and approval", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const workspaces: string[] = [];
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });
  afterEach(async () => {
    if (workspaces.length)
      await db
        .delete(schema.workspaces)
        .where(inArray(schema.workspaces.id, workspaces.splice(0)));
  });
  afterAll(async () => {
    await pool.end();
  });
  async function seed() {
    const [w] = await db
      .insert(schema.workspaces)
      .values({ name: `timing-test-${randomUUID()}`, passwordHash: "test" })
      .returning();
    workspaces.push(w.id);
    const [p] = await db
      .insert(schema.plans)
      .values({
        workspaceId: w.id,
        title: "plan",
        startDate: new Date("2035-01-01"),
        endDate: new Date("2035-12-31"),
        status: "active",
        baselineSnapshot: {},
      })
      .returning();
    const [t] = await db
      .insert(schema.tasks)
      .values({
        workspaceId: w.id,
        planId: p.id,
        title: "Note7",
        date: new Date("2035-09-20T00:00:00+08:00"),
        daySegment: "morning",
      })
      .returning();
    return { w, p, t };
  }
  function request(id: string, more: Record<string, unknown> = {}) {
    return {
      action: "schedule",
      edits: [
        {
          taskId: id,
          date: "2035-09-20",
          startTime: "09:00",
          minutes: 45,
          locked: false,
          deadlineAt: null,
          targetDate: null,
          ...more,
        },
      ],
    };
  }
  async function approve(w: string, id: string) {
    await decideOperationApproval(db, {
      workspaceId: w,
      approvalId: id,
      decision: "approved",
    });
  }
  it("preview is read-only; approval is required; Apply reads persisted IDs; retries do not duplicate", async () => {
    const { w, t } = await seed();
    const key = randomUUID();
    const p = await proposeTaskTiming(db, w.id, request(t.id), key);
    expect(
      (await readTaskTiming(db, w.id, "2035-09-20")).tasks[0].scheduledStart,
    ).toBeNull();
    expect(
      (await proposeTaskTiming(db, w.id, request(t.id), key)).approvalId,
    ).toBe(p.approvalId);
    await expect(applyTaskTiming(db, w.id, p.approvalId!)).rejects.toThrow(
      "先确认",
    );
    await approve(w.id, p.approvalId!);
    const saved = await applyTaskTiming(db, w.id, p.approvalId!);
    expect(saved.verified).toBe(true);
    expect(saved.readback[0]?.scheduledStart).toBe("2035-09-20T01:00:00.000Z");
    expect((await applyTaskTiming(db, w.id, p.approvalId!)).replayed).toBe(
      true,
    );
    expect(
      await db
        .select()
        .from(schema.changeLogs)
        .where(eq(schema.changeLogs.workspaceId, w.id)),
    ).toHaveLength(1);
  });
  it("stale task and new fixed block prevent all writes", async () => {
    const { w, t } = await seed();
    const p = await proposeTaskTiming(db, w.id, request(t.id), randomUUID());
    await approve(w.id, p.approvalId!);
    await db
      .insert(schema.timeBlocks)
      .values({
        workspaceId: w.id,
        title: "new class",
        kind: "course",
        startsAt: new Date("2035-09-20T09:00:00+08:00"),
        endsAt: new Date("2035-09-20T10:00:00+08:00"),
      });
    await expect(applyTaskTiming(db, w.id, p.approvalId!)).rejects.toMatchObject({
      code: "preview_stale",
      message: expect.stringContaining("已经变化"),
    });
    expect(
      (await readTaskTiming(db, w.id, "2035-09-20")).tasks[0].scheduledStart,
    ).toBeNull();
    expect(
      (await db
        .select({ status: schema.operationApprovals.status })
        .from(schema.operationApprovals)
        .where(eq(schema.operationApprovals.id, p.approvalId!)))[0].status,
    ).toBe("stale");
  });
  it("expired, rejected and cross-workspace approvals cannot apply", async () => {
    const { w, t } = await seed();
    const other = await seed();
    const p = await proposeTaskTiming(db, w.id, request(t.id), randomUUID());
    await expect(
      applyTaskTiming(db, other.w.id, p.approvalId!),
    ).rejects.toThrow("找不到");
    await approve(w.id, p.approvalId!);
    await db
      .update(schema.operationApprovals)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.operationApprovals.id, p.approvalId!));
    await expect(applyTaskTiming(db, w.id, p.approvalId!)).rejects.toMatchObject({
      code: "preview_stale",
      message: expect.stringContaining("过期"),
    });
    await expect(
      proposeTaskTiming(db, other.w.id, request(t.id), randomUUID()),
    ).rejects.toThrow("任务不存在");
  });
  it("backlog becomes planned; pause preserves todo and remaining work; complete requires its own review", async () => {
    const { w, t } = await seed();
    await db
      .update(schema.tasks)
      .set({ status: "backlog" })
      .where(eq(schema.tasks.id, t.id));
    const p = await proposeTaskTiming(
      db,
      w.id,
      {
        action: "defer",
        taskId: t.id,
        date: "2035-09-22",
        startTime: "08:00",
        endTime: "22:00",
        gapMinutes: 10,
        minutes: 30,
        checkpoint: "继续 nanoGPT",
      },
      randomUUID(),
    );
    await approve(w.id, p.approvalId!);
    expect(
      (await applyTaskTiming(db, w.id, p.approvalId!)).readback[0],
    ).toMatchObject({
      date: "2035-09-22",
      status: "todo",
      checkpoint: "继续 nanoGPT",
    });
    const pause = await proposeTaskTiming(
      db,
      w.id,
      { action: "pause", taskId: t.id, checkpoint: "尚余最后一节" },
      randomUUID(),
    );
    await approve(w.id, pause.approvalId!);
    expect(
      (await applyTaskTiming(db, w.id, pause.approvalId!)).readback[0],
    ).toMatchObject({
      status: "todo",
      scheduledStart: null,
      checkpoint: "尚余最后一节",
    });
    const done = await proposeTaskTiming(
      db,
      w.id,
      { action: "complete", taskId: t.id },
      randomUUID(),
    );
    await approve(w.id, done.approvalId!);
    expect(
      (await applyTaskTiming(db, w.id, done.approvalId!)).readback[0]?.status,
    ).toBe("done");
  });
  it("legacy date writers clear unlocked slots, and cannot move protected ones", async () => {
    const { w, t } = await seed();
    let p = await proposeTaskTiming(db, w.id, request(t.id), randomUUID());
    await approve(w.id, p.approvalId!);
    await applyTaskTiming(db, w.id, p.approvalId!);
    await db
      .update(schema.tasks)
      .set({ date: new Date("2035-09-21T00:00:00+08:00") })
      .where(eq(schema.tasks.id, t.id));
    expect(
      (await readTaskTiming(db, w.id, "2035-09-21")).tasks[0].scheduledStart,
    ).toBeNull();
    p = await proposeTaskTiming(
      db,
      w.id,
      request(t.id, { date: "2035-09-21", locked: true }),
      randomUUID(),
    );
    await approve(w.id, p.approvalId!);
    await applyTaskTiming(db, w.id, p.approvalId!);
    await expect(
      db
        .update(schema.tasks)
        .set({ date: new Date("2035-09-22T00:00:00+08:00") })
        .where(eq(schema.tasks.id, t.id)),
    ).rejects.toThrow("protected");
  });
  it("concurrent apply of one approval commits exactly once", async () => {
    const { w, t } = await seed();
    const p = await proposeTaskTiming(db, w.id, request(t.id), randomUUID());
    await approve(w.id, p.approvalId!);
    const results = await Promise.all([
      applyTaskTiming(db, w.id, p.approvalId!),
      applyTaskTiming(db, w.id, p.approvalId!),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
  });
  it("respects configured capacity when proposing backlog slots", async () => {
    const { w, t } = await seed();
    await db
      .update(schema.tasks)
      .set({ status: "backlog" })
      .where(eq(schema.tasks.id, t.id));
    await db
      .insert(schema.dayCapacities)
      .values({
        workspaceId: w.id,
        date: new Date("2035-09-20T00:00:00+08:00"),
        morningMinutes: 0,
        afternoonMinutes: 90,
        eveningMinutes: 0,
      });
    const p = await proposeTaskTiming(
      db,
      w.id,
      {
        action: "arrange",
        date: "2035-09-20",
        startTime: "08:00",
        endTime: "22:00",
        gapMinutes: 0,
        taskIds: [t.id],
      },
      randomUUID(),
    );
    expect(p.changes[0].after.daySegment).toBe("afternoon");
    expect(p.changes[0].after.scheduledStart).toBe("2035-09-20T04:00:00.000Z");
  });
  it("rejects idempotency key reuse with a different payload", async () => {
    const { w, t } = await seed();
    const key = randomUUID();
    await proposeTaskTiming(db, w.id, request(t.id), key);
    await expect(
      proposeTaskTiming(db, w.id, request(t.id, { minutes: 60 }), key),
    ).rejects.toThrow("同一请求标识");
  });
  it("protecting a slot normalizes the date without losing the window", async () => {
    const { w, t } = await seed();
    await db
      .update(schema.tasks)
      .set({
        date: new Date("2035-09-20T09:00:00+08:00"),
        scheduledStart: new Date("2035-09-20T09:00:00+08:00"),
        scheduledEnd: new Date("2035-09-20T09:45:00+08:00"),
        movable: false,
      })
      .where(eq(schema.tasks.id, t.id));
    const p = await proposeTaskTiming(
      db,
      w.id,
      request(t.id, { locked: true, checkpoint: "保留时段" }),
      randomUUID(),
    );
    await approve(w.id, p.approvalId!);
    expect(
      (await applyTaskTiming(db, w.id, p.approvalId!)).readback[0],
    ).toMatchObject({
      movable: false,
      scheduledStart: "2035-09-20T01:00:00.000Z",
    });
  });
  it("changed task version rolls back a multi-task approval", async () => {
    const { w, p, t } = await seed();
    const [other] = await db
      .insert(schema.tasks)
      .values({
        workspaceId: w.id,
        planId: p.id,
        title: "GE",
        date: new Date("2035-09-20T00:00:00+08:00"),
        daySegment: "morning",
      })
      .returning();
    const r = request(t.id);
    r.edits.push({ ...r.edits[0], taskId: other.id, startTime: "10:00" });
    const preview = await proposeTaskTiming(db, w.id, r, randomUUID());
    await approve(w.id, preview.approvalId!);
    await db
      .update(schema.tasks)
      .set({ updatedAt: new Date(), notes: "another writer" })
      .where(eq(schema.tasks.id, other.id));
    await expect(
      applyTaskTiming(db, w.id, preview.approvalId!),
    ).rejects.toThrow("已经变化");
    expect(
      (await readTaskTiming(db, w.id, "2035-09-20")).tasks.every(
        (t) => t.scheduledStart === null,
      ),
    ).toBe(true);
  });
});
