import type { AssistantMutation } from "@/lib/assistant/schema";

export type ProgressContent = Extract<AssistantMutation, { action: "save_continuation" }>;
export type ContinuationRecord = { id: string; taskId: string | null; kind: string; createdAt: string; content: ProgressContent };
export type ContinuationList = { records: ContinuationRecord[]; truncated: boolean };
export type AssistantPreview = { draftId: string; draftStatus: string; expiresAt: string; change: ProgressContent; liveUnchanged: boolean };
export type AssistantSave = { status: string; mutationApplied: boolean; draftId: string; readback: {
  verification: string; matchesMutation: boolean; id?: string; entity?: string; row?: ContinuationRecord;
} };
export type NextTask = { taskId: string; title: string; minutes: number; energyRequired: "low" | "medium" | "high"; suggestedStart: string; suggestedEnd: string; nextStep: string | null };
export type RecommendationList = { recommendations: NextTask[]; continuationTruncated: boolean; mutationApplied: false };
export type DurationRow = { taskId: string; title: string; currentEstimateMinutes: number | null; capturedEstimateMinutes: number | null;
  recordedMinutes: number | null; observedDeltaMinutes: number | null; recordCount: number; approximate: boolean; overlappingRecords: boolean; boundaryClipped: boolean; caveats: string[] };
export type DurationReport = { comparisons: DurationRow[]; truncated: boolean; unlinkedRecordCount: number; tasksWithoutActuals: number };

const messages: Record<string, string> = {
  preview_stale: "内容已变化，请返回修改，重新预览后再确认。",
  preview_expired: "预览已过期，请返回修改并重新预览。",
  draft_not_found: "找不到这次预览，请返回修改并重新预览。",
  task_not_found: "这项任务已变化或不可用，请关闭后刷新任务。",
  no_active_plan: "还没有启用的计划。先到计划页启用一个计划，再来选下一步。",
  invalid_range: "请选择有效日期，范围不超过 31 天。",
  invalid_arguments: "请检查填写内容后再试。",
};
export class AssistantRequestError extends Error {
  constructor(message: string, public uncertain = false, public code?: string) { super(message); }
}
export async function requestAssistant<T>(tool: string, args: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool, arguments: args }), signal, cache: "no-store" });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AssistantRequestError("网络中断，请保持内容不变后重试。", true);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 401 ? "登录已过期，请重新登录后继续。" : messages[result?.error] ?? "暂时无法完成，请稍后重试。";
    throw new AssistantRequestError(message, response.status >= 500, result?.error);
  }
  if (!result || typeof result !== "object") throw new AssistantRequestError("暂未收到可核对的结果，请重试。", true);
  return result as T;
}
export function verifyContinuationSave(result: AssistantSave, preview: AssistantPreview) {
  if (!result.mutationApplied || result.draftId !== preview.draftId || result.readback?.verification !== "succeeded") {
    throw new AssistantRequestError("进展可能已保存，暂未核对成功。请重试同一次确认，或关闭后重新读取。", true);
  }
  if (!result.readback.matchesMutation) throw new AssistantRequestError("进展已保存，但随后又发生变化。请关闭后重新读取最新内容。", true);
  const row = result.readback.row;
  if (!row?.id || result.readback.id !== row.id || result.readback.entity !== "continuation" || row.kind !== "progress" || (row.taskId ?? null) !== (preview.change.task_id ?? null)
      || row.content.progress !== preview.change.progress || row.content.next_step !== preview.change.next_step
      || row.content.action !== preview.change.action || row.content.task_id !== preview.change.task_id
      || row.content.project_id !== preview.change.project_id || row.content.remaining_minutes !== preview.change.remaining_minutes
      || row.content.energy_required !== preview.change.energy_required
      || JSON.stringify(row.content.evidence) !== JSON.stringify(preview.change.evidence)
      || JSON.stringify(row.content.blockers) !== JSON.stringify(preview.change.blockers)) {
    throw new AssistantRequestError("返回内容尚不能核对，请重试同一次确认，或关闭后重新读取。", true);
  }
  return row;
}
