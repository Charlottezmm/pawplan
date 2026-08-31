import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  OperationApprovalList,
  formatApprovalExpiry,
  operationApprovalErrorMessage,
  operationApprovalIsExpired,
} from "@/components/operation-approval-list";

describe("OperationApprovalList expired task-notes history", () => {
  it("fails closed for expired approvals and translates stale approval errors", () => {
    expect(operationApprovalIsExpired("2026-08-31T04:47:18.000Z", Date.parse("2026-08-31T04:47:18.000Z"))).toBe(true);
    expect(operationApprovalIsExpired("2026-08-31T04:47:19.000Z", Date.parse("2026-08-31T04:47:18.000Z"))).toBe(false);
    expect(operationApprovalIsExpired("invalid", Date.now())).toBe(true);
    expect(operationApprovalErrorMessage({
      code: "approval_already_decided",
      error: "Approval is missing, expired, or was already decided",
    })).toBe("这份预览已过期或已经处理，请刷新后让助手重新生成。");
    expect(formatApprovalExpiry("2026-08-31T04:47:18.000Z")).toBe("2026/08/31 12:47");
    expect(formatApprovalExpiry("invalid")).toBe("时间无效");
  });

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

    expect(html).toContain("最近过期的任务详情审核");
    expect(html).toContain("这些预览已失效，不能再批准");
    expect(html).toContain("已批准，尚未应用");
    expect(html).not.toContain("<button");
  });
});
