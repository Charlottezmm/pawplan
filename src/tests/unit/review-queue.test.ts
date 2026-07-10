import { describe, expect, it } from "vitest";
import {
  getRejectReviewPatchesNotice,
  getReviewQueueSummary,
  parseRejectReviewPatchesResponse,
} from "@/lib/planning/review-queue";

describe("review queue summary", () => {
  it("counts distinct patches separately from their operations", () => {
    const items = [
      { patchId: "patch-1" },
      { patchId: "patch-1" },
      { patchId: "patch-2" },
    ];

    expect(getReviewQueueSummary(items)).toEqual({
      patchIds: ["patch-1", "patch-2"],
      draftCount: 2,
      operationCount: 3,
    });
  });

  it("counts patch-level drafts even when a draft has no operations", () => {
    expect(getReviewQueueSummary([{ patchId: "patch-1" }], ["patch-1", "empty-patch"])).toEqual({
      patchIds: ["patch-1", "empty-patch"],
      draftCount: 2,
      operationCount: 1,
    });
  });

  it("validates structured readback before reporting success", () => {
    const result = parseRejectReviewPatchesResponse({
      status: "succeeded",
      requestedPatchCount: 2,
      rejectedPatchCount: 2,
      rejectedOperationCount: 3,
      rejectedPatchIds: ["patch-1", "patch-2"],
      remainingDraftCount: 0,
    });

    expect(result).not.toBeNull();
    expect(getRejectReviewPatchesNotice(result!)).toBe(
      "已清空 2 份草稿、3 项建议；已生效日程未更改。",
    );
    expect(parseRejectReviewPatchesResponse({})).toBeNull();
    expect(parseRejectReviewPatchesResponse({
      status: "succeeded",
      requestedPatchCount: 2,
      rejectedPatchCount: 2,
      rejectedOperationCount: 3,
      rejectedPatchIds: [],
      remainingDraftCount: 0,
    })).toBeNull();
  });

  it("reports persisted drafts that remain after the confirmed snapshot is rejected", () => {
    const result = parseRejectReviewPatchesResponse({
      status: "succeeded",
      requestedPatchCount: 1,
      rejectedPatchCount: 1,
      rejectedOperationCount: 2,
      rejectedPatchIds: ["patch-1"],
      remainingDraftCount: 1,
    });

    expect(getRejectReviewPatchesNotice(result!)).toBe(
      "已拒绝 1 份草稿、2 项建议；仍有 1 份待审核草稿。",
    );
  });
});
