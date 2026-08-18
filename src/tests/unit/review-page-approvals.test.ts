import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getWorkspaceIdFromSession: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/planning/view-data", () => ({ getReschedulePageData: vi.fn() }));
vi.mock("@/lib/approvals/service", () => ({
  listPendingOperationApprovals: vi.fn(),
  listRecentExpiredTaskNotesApprovals: vi.fn(),
}));
vi.mock("@/components/review-opened-recorder", () => ({ ReviewOpenedRecorder: () => null }));
vi.mock("@/components/reschedule-preview", () => ({ ReviewPreview: () => null }));

describe("Review page operation approvals", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("passes the full approval summary to the Review UI", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    const { getReschedulePageData } = await import("@/lib/planning/view-data");
    const { listPendingOperationApprovals, listRecentExpiredTaskNotesApprovals } = await import("@/lib/approvals/service");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(getReschedulePageData).mockResolvedValue({} as never);
    vi.mocked(listPendingOperationApprovals).mockResolvedValue([{
      id: "approval-1",
      operationKind: "task_notes_batch",
      summaryJson: {
        title: "批量更新任务详情",
        count: 2,
        totalMinutes: 90,
        items: ["任务 A", "任务 B"],
        noteChanges: [{ taskId: "task-1", title: "任务 A", before: "旧内容", after: "新内容" }],
      },
      expiresAt: new Date("2026-08-16T01:00:00.000Z"),
    }] as never);
    vi.mocked(listRecentExpiredTaskNotesApprovals).mockResolvedValue([{
      id: "approval-2",
      operationKind: "task_notes_batch",
      status: "approved",
      summaryJson: {
        title: "过期的任务详情",
        count: 3,
      },
      expiresAt: new Date("2026-08-15T01:00:00.000Z"),
    }] as never);
    const { default: ReviewPage } = await import("@/app/(app)/review/page");

    const page = await ReviewPage();
    const children = page.props.children as Array<{ props: Record<string, unknown> }>;

    expect(children[1].props.approvals).toEqual([{
      id: "approval-1",
      operationKind: "task_notes_batch",
      summary: {
        title: "批量更新任务详情",
        description: undefined,
        count: 2,
        totalMinutes: 90,
        items: ["任务 A", "任务 B"],
        noteChanges: [{ taskId: "task-1", title: "任务 A", before: "旧内容", after: "新内容" }],
      },
      expiresAt: "2026-08-16T01:00:00.000Z",
    }]);
    expect(children[1].props.expiredApprovals).toEqual([{
      id: "approval-2",
      operationKind: "task_notes_batch",
      status: "approved",
      summary: {
        title: "过期的任务详情",
        description: undefined,
        count: 3,
        totalMinutes: undefined,
        items: undefined,
        noteChanges: undefined,
      },
      expiresAt: "2026-08-15T01:00:00.000Z",
    }]);
    const pendingNow = vi.mocked(listPendingOperationApprovals).mock.calls[0][2];
    const expiredNow = vi.mocked(listRecentExpiredTaskNotesApprovals).mock.calls[0][2];
    expect(pendingNow).toBe(expiredNow);
  });
});
