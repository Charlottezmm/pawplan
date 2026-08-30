import { readFileSync } from "node:fs";
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInboxItem, processInboxItem } from "@/lib/planning/service";
import type { getDb as getAppDb } from "@/lib/db/client";

type TableWrite = {
  table: string;
  values: Record<string, unknown>;
  inTransaction: boolean;
};

type FakeDbOptions = {
  activePlanId?: string | null;
  inboxItems?: Array<Record<string, unknown>>;
  selectedInboxItemId?: string;
  selectedWorkspaceId?: string;
};

type RouteDb = ReturnType<typeof getAppDb>;

function createRouteDb() {
  return { id: "db" } as unknown as RouteDb;
}

function createFakeDb(options: FakeDbOptions = {}) {
  const inserts: TableWrite[] = [];
  const updates: TableWrite[] = [];
  const deletes: Array<{ table: string; inTransaction: boolean }> = [];
  let inTransaction = false;

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  function rowsFor(table: unknown) {
    const name = tableName(table);
    if (name === "plans") {
      return options.activePlanId === null ? [] : [{ id: options.activePlanId ?? "plan-1" }];
    }
    if (name === "inbox_items") {
      const selectedInboxItemId = options.selectedInboxItemId ?? "inbox-1";
      const selectedWorkspaceId = options.selectedWorkspaceId ?? "workspace-1";
      return (options.inboxItems ?? []).filter(
        (row) =>
          row.id === selectedInboxItemId &&
          row.workspaceId === selectedWorkspaceId &&
          (row.processedAt === null || row.processedAt === undefined),
      );
    }
    return [];
  }

  function selectableRows(table: unknown) {
    const rows = rowsFor(table);
    return {
      limit() {
        return Promise.resolve(rows);
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
  }

  function createClient() {
    return {
      select() {
        return {
          from(table: unknown) {
            return {
              where() {
                return selectableRows(table);
              },
            };
          },
        };
      },
      insert(table: unknown) {
        return {
          values(values: Record<string, unknown>) {
            inserts.push({ table: tableName(table), values, inTransaction });
            return {
              returning() {
                return Promise.resolve([{ id: `${tableName(table)}-1`, ...values }]);
              },
              then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
                return Promise.resolve().then(resolve, reject);
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                updates.push({ table: tableName(table), values, inTransaction });
                return Promise.resolve();
              },
            };
          },
        };
      },
      delete(table: unknown) {
        return {
          where() {
            deletes.push({ table: tableName(table), inTransaction });
            return Promise.resolve();
          },
        };
      },
    };
  }

  const client = createClient();

  return {
    inserts,
    updates,
    deletes,
    transaction: async <T>(callback: (tx: ReturnType<typeof createClient>) => Promise<T>) => {
      inTransaction = true;
      return callback(client);
    },
    ...client,
  };
}

function inboxItem(title = "Submit insurance form") {
  return { id: "inbox-1", workspaceId: "workspace-1", title };
}

describe("inbox promotion", () => {
  it("creates only an inbox row when capturing an item", async () => {
    const db = createFakeDb();

    await createInboxItem(db, { workspaceId: "workspace-1", title: "Renew passport", source: "manual" });

    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "inbox_items",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          title: "Renew passport",
          source: "manual",
        }),
      }),
    ]);
    expect(db.inserts.filter((write) => write.table === "tasks" || write.table === "routines")).toEqual([]);
  });

  it("promotes an inbox item to a task using explicit scheduling metadata", async () => {
    const db = createFakeDb({ activePlanId: "plan-1", inboxItems: [inboxItem()] });

    const result = await processInboxItem(db, {
      workspaceId: "workspace-1",
      inboxItemId: "inbox-1",
      action: "task",
      date: "2026-06-20",
      daySegment: "afternoon",
      estimatedMinutes: 45,
      priority: "high",
    } as Parameters<typeof processInboxItem>[1]);

    expect(result).toEqual({ ok: true, action: "task" });
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "tasks",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          planId: "plan-1",
          title: "Submit insurance form",
          date: new Date("2026-06-19T16:00:00.000Z"),
          daySegment: "afternoon",
          estimatedMinutes: 45,
          priority: "high",
          status: "todo",
        }),
      }),
    ]);
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "inbox_items",
        values: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    ]);
  });

  it("promotes a quick chore only through the explicit quick chore action", async () => {
    const db = createFakeDb({ activePlanId: "plan-1", inboxItems: [inboxItem("Pay water bill")] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T12:00:00.000Z"));

    let result: Awaited<ReturnType<typeof processInboxItem>> | undefined;
    try {
      result = await processInboxItem(db, {
        workspaceId: "workspace-1",
        inboxItemId: "inbox-1",
        action: "quick_chore_task",
        daySegment: "morning",
      } as Parameters<typeof processInboxItem>[1]);
    } finally {
      vi.useRealTimers();
    }

    expect(result).toEqual({ ok: true, action: "quick_chore_task" });
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "tasks",
        values: expect.objectContaining({
          title: "Pay water bill",
          date: new Date("2026-06-16T16:00:00.000Z"),
          daySegment: "morning",
          estimatedMinutes: 15,
          priority: "normal",
        }),
      }),
    ]);
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "inbox_items",
        values: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    ]);
  });

  it("rejects an inbox item from another workspace", async () => {
    const db = createFakeDb({
      activePlanId: "plan-1",
      inboxItems: [{ ...inboxItem("Wrong workspace item"), workspaceId: "workspace-2" }],
    });

    await expect(
      processInboxItem(db, {
        workspaceId: "workspace-1",
        inboxItemId: "inbox-1",
        action: "task",
        date: "2026-06-20",
        daySegment: "afternoon",
        estimatedMinutes: 45,
      } as Parameters<typeof processInboxItem>[1]),
    ).rejects.toMatchObject({ message: "Inbox item not found", status: 404 });
    expect(db.inserts.filter((write) => write.table === "tasks" || write.table === "routines")).toEqual([]);
    expect(db.updates.filter((write) => write.table === "inbox_items")).toEqual([]);
  });

  it("rejects an already processed inbox item", async () => {
    const db = createFakeDb({
      activePlanId: "plan-1",
      inboxItems: [{ ...inboxItem("Processed item"), processedAt: new Date("2026-06-17T08:00:00.000Z") }],
    });

    await expect(
      processInboxItem(db, {
        workspaceId: "workspace-1",
        inboxItemId: "inbox-1",
        action: "routine",
        weekdayPattern: "daily",
        defaultTimeSegment: "evening",
        estimatedMinutes: 20,
      } as Parameters<typeof processInboxItem>[1]),
    ).rejects.toMatchObject({ message: "Inbox item not found", status: 404 });
    expect(db.inserts.filter((write) => write.table === "tasks" || write.table === "routines")).toEqual([]);
    expect(db.updates.filter((write) => write.table === "inbox_items")).toEqual([]);
  });

  it("promotes an inbox item to a routine using visible recurrence metadata", async () => {
    const db = createFakeDb({ inboxItems: [inboxItem("Take vitamins")] });

    const result = await processInboxItem(db, {
      workspaceId: "workspace-1",
      inboxItemId: "inbox-1",
      action: "routine",
      weekdayPattern: "mon,wed,fri",
      defaultTimeSegment: "morning",
      estimatedMinutes: 10,
    } as Parameters<typeof processInboxItem>[1]);

    expect(result).toEqual({ ok: true, action: "routine" });
    expect(db.inserts).toEqual([
      expect.objectContaining({
        table: "routines",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          title: "Take vitamins",
          weekdayPattern: "mon,wed,fri",
          defaultTimeSegment: "morning",
          estimatedMinutes: 10,
          energyLevel: "low",
        }),
      }),
    ]);
    expect(db.updates).toEqual([
      expect.objectContaining({
        table: "inbox_items",
        values: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    ]);
  });

  it("deletes an inbox item without creating a task or routine", async () => {
    const db = createFakeDb({ inboxItems: [inboxItem("Duplicate note")] });

    const result = await processInboxItem(db, {
      workspaceId: "workspace-1",
      inboxItemId: "inbox-1",
      action: "delete",
    });

    expect(result).toEqual({ ok: true, action: "delete" });
    expect(db.deletes).toEqual([expect.objectContaining({ table: "inbox_items", inTransaction: true })]);
    expect(db.inserts.filter((write) => write.table === "tasks" || write.table === "routines")).toEqual([]);
    expect(db.updates.filter((write) => write.table === "inbox_items")).toEqual([]);
  });
});

describe("inbox UI promotion payloads", () => {
  it("does not keep or send a hidden quick chore date", () => {
    const source = readFileSync("src/components/inbox-view.tsx", "utf8");

    expect(source).not.toContain("quickDate");
    expect(source).not.toMatch(/action:\s*"quick_chore_task"[\s\S]{0,160}date:/);
  });

  it("uses destination-first forms and friendly recurrence controls", () => {
    const source = readFileSync("src/components/inbox-view.tsx", "utf8");

    expect(source).toContain('type PromotionDestination = "task" | "routine"');
    expect(source).toContain('role="group" aria-label="选择条目去向"');
    expect(source).toContain("weekdayOptions.map");
    expect(source).not.toContain('placeholder="daily / mon,wed,fri"');
    expect(source).toContain('aria-invalid={Boolean(itemErrors.taskDate)}');
    expect(source).toContain("刚刚捕获");
    expect(source).toContain('title="删除收集条目？"');
    expect(source).toContain("将从收集区永久删除");
  });
});

const inboxId = "11111111-1111-4111-8111-111111111111";

function patchRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/inbox", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockInboxRouteModules() {
  class PlanningServiceError extends Error {
    constructor(message: string, public status = 400) {
      super(message);
    }
  }

  vi.doMock("@/lib/auth/session", () => ({
    getWorkspaceIdFromSession: vi.fn(),
  }));
  vi.doMock("@/lib/db/client", () => ({
    getDb: vi.fn(),
  }));
  vi.doMock("@/lib/planning/service", () => ({
    PlanningServiceError,
    createInboxItem: vi.fn(),
    processInboxItem: vi.fn(),
  }));
}

describe("inbox API promotion schema", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockInboxRouteModules();
  });

  it("rejects generic task promotion without visible scheduling metadata before opening the database", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { PATCH } = await import("@/app/api/inbox/route");

    const response = await PATCH(patchRequest({ id: inboxId, action: "task" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid inbox action" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("passes explicit task promotion metadata to the service", async () => {
    const db = createRouteDb();
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { processInboxItem: mockedProcessInboxItem } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(mockedProcessInboxItem).mockResolvedValue({ ok: true, action: "task" });
    const { PATCH } = await import("@/app/api/inbox/route");

    const response = await PATCH(
      patchRequest({
        id: inboxId,
        action: "task",
        date: "2026-06-20",
        daySegment: "afternoon",
        estimatedMinutes: 45,
        priority: "urgent",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: "task" });
    expect(mockedProcessInboxItem).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      inboxItemId: inboxId,
      action: "task",
      date: "2026-06-20",
      daySegment: "afternoon",
      estimatedMinutes: 45,
      priority: "urgent",
    });
  });

  it("accepts quick chore promotion as an explicit defaulted action", async () => {
    const db = createRouteDb();
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { processInboxItem: mockedProcessInboxItem } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(mockedProcessInboxItem).mockResolvedValue({ ok: true, action: "quick_chore_task" });
    const { PATCH } = await import("@/app/api/inbox/route");

    const response = await PATCH(
      patchRequest({
        id: inboxId,
        action: "quick_chore_task",
        daySegment: "morning",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: "quick_chore_task" });
    expect(mockedProcessInboxItem).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      inboxItemId: inboxId,
      action: "quick_chore_task",
      daySegment: "morning",
    });
  });

  it("passes routine promotion metadata to the service", async () => {
    const db = createRouteDb();
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { processInboxItem: mockedProcessInboxItem } = await import("@/lib/planning/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue(db);
    vi.mocked(mockedProcessInboxItem).mockResolvedValue({ ok: true, action: "routine" });
    const { PATCH } = await import("@/app/api/inbox/route");

    const response = await PATCH(
      patchRequest({
        id: inboxId,
        action: "routine",
        weekdayPattern: "mon,wed,fri",
        defaultTimeSegment: "evening",
        estimatedMinutes: 20,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: "routine" });
    expect(mockedProcessInboxItem).toHaveBeenCalledWith(db, {
      workspaceId: "workspace-1",
      inboxItemId: inboxId,
      action: "routine",
      weekdayPattern: "mon,wed,fri",
      defaultTimeSegment: "evening",
      estimatedMinutes: 20,
    });
  });
});
