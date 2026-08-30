import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/cat-icon", () => ({ CatIcon: () => null }));

import {
  getReviewSubmitPresentation,
  ReviewItemState,
  ReviewNotice,
  ReviewTechnicalDetails,
} from "@/components/review-feedback";
import { ReviewPreview } from "@/components/reschedule-preview";

describe("Review feedback", () => {
  it("uses a readable live notice instead of a short status pill for long results", () => {
    const errorHtml = renderToStaticMarkup(React.createElement(ReviewNotice, {
      tone: "danger",
      title: "未能完成审核",
      children: "写入返回成功，但最终状态读回不完整；请刷新后核对。",
    }));
    const successHtml = renderToStaticMarkup(React.createElement(ReviewNotice, {
      tone: "success",
      title: "最终状态已核对",
      children: "已写入并读回最终状态。",
    }));

    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain('aria-live="assertive"');
    expect(errorHtml).toContain("paw-review-notice-danger");
    expect(errorHtml).not.toContain("paw-status-pill");
    expect(successHtml).toContain('role="status"');
    expect(successHtml).toContain('aria-live="polite"');
  });

  it("explains protected, skipped, and conflicted states separately", () => {
    const html = renderToStaticMarkup(React.createElement(ReviewItemState, {
      isProtected: true,
      skippedReason: "任务已经完成",
      conflict: {
        reason: "日期已改变",
        expected: "date: 2026-08-30",
        actual: "date: 2026-08-31",
      },
    }));

    expect(html).toContain("受保护，不会自动修改");
    expect(html).toContain("当前状态已经无需执行");
    expect(html).toContain("任务已变化，需要重新确认");
    expect(html).toContain("建议基于");
    expect(html).toContain("当前状态");
  });

  it("keeps patch provenance inside collapsed technical details", () => {
    const html = renderToStaticMarkup(React.createElement(ReviewTechnicalDetails, {
      operationType: "move_task",
      patchId: "patch-123",
      operationIndex: 2,
      createdBy: "agent",
      createdAt: "2026/8/30 10:00:00",
      agentRun: { label: "weekly rebalance", status: "draft_created", id: "run-123" },
    }));

    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("技术详情");
    expect(html).toContain("patch-123");
    expect(html).toContain("run-123");
  });

  it("puts the disabled reason directly on the submit action", () => {
    expect(getReviewSubmitPresentation({
      actionableCount: 3,
      pendingCount: 3,
      acceptedCount: 0,
      isApplying: false,
    })).toMatchObject({ disabled: true, label: "还有 3 项未决定" });

    expect(getReviewSubmitPresentation({
      actionableCount: 0,
      pendingCount: 0,
      acceptedCount: 0,
      isApplying: false,
    })).toMatchObject({ disabled: true, label: "没有可提交项" });

    expect(getReviewSubmitPresentation({
      actionableCount: 2,
      pendingCount: 0,
      acceptedCount: 1,
      isApplying: false,
    })).toMatchObject({ disabled: false, label: "提交并应用 1 项" });

    expect(getReviewSubmitPresentation({
      actionableCount: 2,
      pendingCount: 0,
      acceptedCount: 1,
      isApplying: true,
      progress: { current: 2, total: 3 },
    })).toMatchObject({ disabled: true, label: "正在提交 2/3" });
  });
});

describe("Review core flow", () => {
  it("renders Chinese plan differences and separate queue counts", () => {
    const html = renderToStaticMarkup(React.createElement(ReviewPreview, {
      data: {
        dataUnavailable: false,
        draftPatchIds: ["patch-1"],
        patchItems: [{
          id: "patch-1:0",
          patchId: "patch-1",
          operationIndex: 0,
          operationType: "move_task",
          kind: "移动任务",
          title: "论文第三章",
          from: "2026-08-30 afternoon",
          to: "2026-08-31 morning",
          reason: "为固定课程留出空间",
          impact: ["释放下午容量"],
          capacity: "应用前会重新计算容量",
          protected: false,
          protectedEvidence: [],
          provenance: {
            patchId: "patch-1",
            operationIndex: 0,
            createdBy: "agent",
            createdAt: "2026-08-30T02:00:00.000Z",
          },
        }],
      },
    }));

    expect(html).toContain("待审核建议");
    expect(html).toContain("原计划");
    expect(html).toContain("新计划");
    expect(html).toContain("受保护 0");
    expect(html).toContain("已跳过 0");
    expect(html).toContain("冲突 0");
    expect(html).toContain("1 份建议 · 1 项调整");
    expect(html).toContain("还有 1 项未决定");
    expect(html).not.toContain("Review queue");
    expect(html).not.toContain(">Before<");
    expect(html).not.toContain(">After<");
  });

  it("preserves per-patch apply and final readback validation", () => {
    const source = readFileSync("src/components/reschedule-preview.tsx", "utf8");
    const applyBlock = source.slice(source.indexOf("async function applySelected"), source.indexOf("function formatConflictSide"));

    expect(applyBlock).toContain("for (const patchId of patchIds)");
    expect(applyBlock).toContain('fetch("/api/patches/apply"');
    expect(applyBlock).toContain("setApplyProgress({ current: patchNumber, total: patchIds.size });");
    expect(applyBlock).toContain("missingReadbacks");
    expect(applyBlock).toContain("最终状态读回不完整");
    expect(applyBlock).toContain("body?.status === \"applied\"");
    expect(source).toContain('aria-describedby="paw-review-submit-reason"');
  });
});
