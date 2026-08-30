export type RejectReviewPatchesResponse = {
  status: "succeeded" | "no_change";
  requestedPatchCount: number;
  rejectedPatchCount: number;
  rejectedOperationCount: number;
  rejectedPatchIds: string[];
  remainingDraftCount: number;
};

export function getReviewQueueSummary(items: Array<{ patchId: string }>, draftPatchIds?: string[]) {
  const patchIds = [...new Set(draftPatchIds ?? items.map((item) => item.patchId))];
  return {
    patchIds,
    draftCount: patchIds.length,
    operationCount: items.length,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseRejectReviewPatchesResponse(value: unknown): RejectReviewPatchesResponse | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (result.status !== "succeeded" && result.status !== "no_change") return null;
  if (!isNonNegativeInteger(result.requestedPatchCount)) return null;
  if (!isNonNegativeInteger(result.rejectedPatchCount)) return null;
  if (!isNonNegativeInteger(result.rejectedOperationCount)) return null;
  if (!isNonNegativeInteger(result.remainingDraftCount)) return null;
  if (!Array.isArray(result.rejectedPatchIds) || result.rejectedPatchIds.some((id) => typeof id !== "string")) return null;
  if (result.rejectedPatchCount !== result.rejectedPatchIds.length) return null;
  return result as RejectReviewPatchesResponse;
}

export function getRejectReviewPatchesNotice(result: RejectReviewPatchesResponse) {
  if (result.remainingDraftCount > 0) {
    return `已拒绝 ${result.rejectedPatchCount} 份调整建议、${result.rejectedOperationCount} 项变更；仍有 ${result.remainingDraftCount} 份待审核建议。`;
  }
  if (result.status === "no_change") {
    return "这些调整建议已不在待审核队列，已重新读取最新状态。";
  }
  return `已清空 ${result.rejectedPatchCount} 份调整建议、${result.rejectedOperationCount} 项变更；已生效日程未更改。`;
}
