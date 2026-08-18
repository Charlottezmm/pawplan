import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { OperationApprovalList } from "@/components/operation-approval-list";

describe("OperationApprovalList expired task-notes history", () => {
  it("renders an expired-only notice without approval controls", () => {
    const html = renderToStaticMarkup(React.createElement(OperationApprovalList, {
      approvals: [],
      expiredApprovals: [{
        id: "approval-1",
        operationKind: "task_notes_batch",
        status: "approved",
        summary: {
          title: "批量更新任务详情",
          description: "更新 3 条任务详情",
          count: 3,
        },
        expiresAt: "2026-08-18T01:00:00.000Z",
      }],
    }));

    expect(html).toContain("最近过期的任务详情 Review");
    expect(html).toContain("这些 Preview 已失效，不能再批准");
    expect(html).toContain("已批准，尚未应用");
    expect(html).not.toContain("<button");
  });
});
