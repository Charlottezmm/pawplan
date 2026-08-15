import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTaskBatchPreviewToken,
  taskSelectionHash,
  verifyTaskBatchPreviewToken,
  type TaskBatchFingerprintRow,
} from "@/lib/mcp/task-batch-preview";

const previousSecret = process.env.APP_SECRET;

const row: TaskBatchFingerprintRow = {
  id: "11111111-1111-4111-8111-111111111111",
  planId: "22222222-2222-4222-8222-222222222222",
  title: "Write the methods section",
  status: "todo",
  date: new Date("2026-08-15T16:00:00.000Z"),
  projectId: "33333333-3333-4333-8333-333333333333",
  milestoneId: "44444444-4444-4444-8444-444444444444",
  parentTaskId: null,
  estimatedMinutes: 90,
  archivedAt: null,
  updatedAt: new Date("2026-08-15T08:00:00.000Z"),
};

describe("task batch preview token", () => {
  beforeEach(() => {
    process.env.APP_SECRET = "task-batch-preview-test-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
  });

  it("binds the signed token to workspace, action, exact IDs, filters, and expiry", () => {
    const now = new Date("2026-08-16T00:00:00.000Z");
    const created = createTaskBatchPreviewToken({
      action: "archive",
      workspaceId: "workspace-1",
      planId: row.planId,
      rows: [row],
      filters: { statuses: ["todo"], includeDone: false },
      now,
    });

    expect(
      verifyTaskBatchPreviewToken({
        token: created.token,
        action: "archive",
        workspaceId: "workspace-1",
        now,
      }),
    ).toEqual({ ok: true, payload: created.payload });
    expect(
      verifyTaskBatchPreviewToken({
        token: created.token,
        action: "delete",
        workspaceId: "workspace-1",
        now,
      }),
    ).toMatchObject({ ok: false, code: "preview_invalid" });
    expect(
      verifyTaskBatchPreviewToken({
        token: created.token,
        action: "archive",
        workspaceId: "workspace-2",
        now,
      }),
    ).toMatchObject({ ok: false, code: "preview_invalid" });
    expect(
      verifyTaskBatchPreviewToken({
        token: created.token,
        action: "archive",
        workspaceId: "workspace-1",
        now: new Date("2026-08-16T00:31:00.000Z"),
      }),
    ).toMatchObject({ ok: false, code: "preview_expired" });
  });

  it("rejects a tampered token", () => {
    const created = createTaskBatchPreviewToken({
      action: "archive",
      workspaceId: "workspace-1",
      planId: row.planId,
      rows: [row],
      filters: { taskIds: [row.id] },
    });
    const [payload, signature] = created.token.split(".");
    const tampered = `${payload.slice(0, -1)}A.${signature}`;

    expect(
      verifyTaskBatchPreviewToken({ token: tampered, action: "archive", workspaceId: "workspace-1" }),
    ).toMatchObject({ ok: false, code: "preview_invalid" });
  });

  it("invalidates the fingerprint when title or hierarchy changes", () => {
    const original = taskSelectionHash([row]);

    expect(taskSelectionHash([{ ...row, title: "Renamed task" }])).not.toBe(original);
    expect(
      taskSelectionHash([{ ...row, milestoneId: "55555555-5555-4555-8555-555555555555" }]),
    ).not.toBe(original);
    expect(
      taskSelectionHash([{ ...row, parentTaskId: "66666666-6666-4666-8666-666666666666" }]),
    ).not.toBe(original);
  });

  it("produces the same fingerprint independent of row order", () => {
    const second = { ...row, id: "77777777-7777-4777-8777-777777777777", title: "Second task" };
    expect(taskSelectionHash([row, second])).toBe(taskSelectionHash([second, row]));
  });
});
