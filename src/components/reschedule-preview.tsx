"use client";

import { Check, Lock, RotateCcw, Trash2, X } from "lucide-react";
import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { CatIcon } from "./cat-icon";
import { ConfirmDialog } from "./ui/confirm-dialog";
import {
  getReviewSubmitPresentation,
  ReviewItemState,
  ReviewNotice,
  ReviewTechnicalDetails,
} from "./review-feedback";
import {
  type ExpiredOperationApproval,
  OperationApprovalList,
  type PendingOperationApproval,
} from "./operation-approval-list";
import {
  getRejectReviewPatchesNotice,
  getReviewQueueSummary,
  parseRejectReviewPatchesResponse,
} from "@/lib/planning/review-queue";
import type { RescheduleViewData } from "@/lib/planning/view-data";

type Decision = "accepted" | "rejected";
type PatchItem = RescheduleViewData["patchItems"][number];
type ApplyPatchResponse = {
  status?: "applied" | "rejected" | "conflicted";
  applied?: Array<{
    index: number;
    type: string;
    taskId?: string;
    action: string;
    readback?: Record<string, unknown>;
  }>;
  skipped?: Array<{ index: number; reason?: string }>;
  conflicts?: Array<{ index: number; reason?: string; expected?: Record<string, unknown>; actual?: Record<string, unknown> }>;
};

type PendingAction = "bulk-reject" | "single-reject" | "apply-selected";

const capacityTextPattern = /(?:容量|capacity|超载|过载|余量|负载|remainingMinutes|protectedOverCapacity)/i;

function isCapacityText(value: string) {
  return capacityTextPattern.test(value);
}

export function ReviewPreview({
  data,
  approvals = [],
  expiredApprovals = [],
}: {
  data: RescheduleViewData;
  approvals?: PendingOperationApproval[];
  expiredApprovals?: ExpiredOperationApproval[];
}) {
  const router = useRouter();
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [closedPatchIds, setClosedPatchIds] = useState<string[]>([]);
  const [reviewResults, setReviewResults] = useState<Record<string, Pick<PatchItem, "skipped" | "skippedReason" | "conflict">>>({});
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  const [applyProgress, setApplyProgress] = useState<{ current: number; total: number } | null>(null);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const isApplying = pendingAction !== null;
  const visiblePatchItems = data.patchItems
    .filter((item) => !closedPatchIds.includes(item.patchId))
    .map((item) => ({ ...item, ...reviewResults[item.id] }));
  const actionable = visiblePatchItems.filter((item) => !item.protected && !item.skipped && !item.conflict);
  const accepted = actionable.filter((item) => decisions[item.id] === "accepted").length;
  const rejected = actionable.filter((item) => decisions[item.id] === "rejected").length;
  const pending = actionable.length - accepted - rejected;
  const taskChangeCount = visiblePatchItems.filter((item) => item.operationType !== "import_timetable").length;
  const timetableImportCount = visiblePatchItems.filter((item) => item.operationType === "import_timetable").length;
  const protectedCount = visiblePatchItems.filter((item) => item.protected).length;
  const skippedCount = visiblePatchItems.filter((item) => item.skipped).length;
  const conflictCount = visiblePatchItems.filter((item) => item.conflict).length;
  const visibleDraftPatchIds = data.draftPatchIds.filter((patchId) => !closedPatchIds.includes(patchId));
  const { patchIds: visiblePatchIds, draftCount, operationCount } = getReviewQueueSummary(
    visiblePatchItems,
    visibleDraftPatchIds,
  );
  const hasVisibleSuggestions = visiblePatchItems.length > 0;

  function decide(id: string, decision: Decision) {
    setDecisions((current) => {
      const next = { ...current };
      if (next[id] === decision) {
        delete next[id];
      } else {
        next[id] = decision;
      }
      return next;
    });
  }

  function acceptAll() {
    setDecisions(Object.fromEntries(actionable.map((item) => [item.id, "accepted" as Decision])));
  }

  async function dismissAllDrafts() {
    if (draftCount === 0) return;

    setPendingAction("bulk-reject");
    setApplyError(null);
    setApplyNotice(null);
    try {
      const response = await fetch("/api/patches/reject-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patchIds: visiblePatchIds }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : "清空待审核建议失败",
        );
      }

      const result = parseRejectReviewPatchesResponse(body);
      if (!result) throw new Error("清空结果无法验证，请刷新页面确认审核状态");
      const rejectedPatchIds = result.rejectedPatchIds;
      setClosedPatchIds((current) => [...new Set([...current, ...rejectedPatchIds])]);
      setDecisions((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => !rejectedPatchIds.some((patchId) => id.startsWith(`${patchId}:`))),
        ),
      );
      setApplyNotice(getRejectReviewPatchesNotice(result));
      setClearConfirmationOpen(false);
      router.refresh();
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "清空待审核建议失败");
    } finally {
      setPendingAction(null);
    }
  }

  // 丢弃整条草稿：拒绝该 patch 的全部 operation，绕过冲突/未应用态的死路
  async function dismissPatch(patchId: string) {
    const rejectedOperationIndexes = [
      ...new Set(data.patchItems.filter((entry) => entry.patchId === patchId).map((entry) => entry.operationIndex)),
    ];
    if (rejectedOperationIndexes.length === 0) return;
    setPendingAction("single-reject");
    setApplyError(null);
    setApplyNotice(null);
    try {
      const response = await fetch("/api/patches/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patchId, acceptedOperationIndexes: [], rejectedOperationIndexes }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "丢弃草稿失败");
      }
      setClosedPatchIds((current) => [...current, patchId]);
      setDecisions((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(`${patchId}:`))));
      router.refresh();
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "丢弃草稿失败");
    } finally {
      setPendingAction(null);
    }
  }

  async function applySelected() {
    const acceptedByPatch = new Map<string, number[]>();
    const rejectedByPatch = new Map<string, number[]>();
    for (const item of actionable) {
      if (!decisions[item.id]) continue;
      const operationIndex = item.operationIndex;
      const target = decisions[item.id] === "accepted" ? acceptedByPatch : rejectedByPatch;
      target.set(item.patchId, [...(target.get(item.patchId) ?? []), operationIndex]);
    }

    const patchIds = new Set([...acceptedByPatch.keys(), ...rejectedByPatch.keys()]);
    if (patchIds.size === 0 || pending > 0) return;

    setPendingAction("apply-selected");
    setApplyProgress({ current: 1, total: patchIds.size });
    setApplyError(null);
    setApplyNotice(null);
    let closedAnyPatch = false;
    try {
      let patchNumber = 0;
      for (const patchId of patchIds) {
        patchNumber += 1;
        setApplyProgress({ current: patchNumber, total: patchIds.size });
        const acceptedOperationIndexes = acceptedByPatch.get(patchId) ?? [];
        const rejectedOperationIndexes = rejectedByPatch.get(patchId) ?? [];
        const response = await fetch("/api/patches/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patchId, acceptedOperationIndexes, rejectedOperationIndexes }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? "应用建议失败");
        }
        const body = (await response.json().catch(() => null)) as ApplyPatchResponse | null;
        const applied = body?.applied ?? [];
        const skipped = body?.skipped ?? [];
        const conflicts = body?.conflicts ?? [];
        if (skipped.length > 0 || conflicts.length > 0) {
          setReviewResults((current) => {
            const next = { ...current };
            for (const item of skipped) {
              next[`${patchId}:${item.index}`] = {
                ...next[`${patchId}:${item.index}`],
                skipped: true,
                skippedReason: item.reason,
              };
            }
            for (const item of conflicts) {
              next[`${patchId}:${item.index}`] = {
                ...next[`${patchId}:${item.index}`],
                conflict: {
                  reason: item.reason ?? "操作存在冲突",
                  expected: item.expected,
                  actual: item.actual,
                },
              };
            }
            return next;
          });
          const reasons = [...new Set([...skipped, ...conflicts].map((item) => item.reason).filter(Boolean))];
          setApplyError(`有 ${Math.max(skipped.length, conflicts.length)} 条建议未应用${reasons.length > 0 ? `：${reasons.join("；")}` : ""}`);
          continue;
        }

        if (body?.status === "applied") {
          const acceptedItems = actionable.filter(
            (item) => item.patchId === patchId && acceptedOperationIndexes.includes(item.operationIndex),
          );
          const appliedByIndex = new Map(applied.map((item) => [item.index, item]));
          const missingReadbacks = acceptedItems.filter((item) => {
            const appliedItem = appliedByIndex.get(item.operationIndex);
            if (!appliedItem) return true;
            if (item.operationType !== "move_task") return false;
            const readback = appliedItem.readback;
            if (!readback || typeof readback.date !== "string" || typeof readback.daySegment !== "string") return true;
            if (`${readback.date} ${readback.daySegment}` !== item.to) return true;
            if (!item.requiresRolloverReadback) return false;
            return typeof readback.rolloverCount !== "number" || !readback.lastRolloverAt;
          });
          if (missingReadbacks.length > 0) {
            throw new Error("写入返回成功，但最终状态读回不完整；草稿仍保留，请刷新后核对。");
          }
          const moveReadbacks = acceptedItems
            .map((item) => ({ item, applied: appliedByIndex.get(item.operationIndex) }))
            .filter((entry) => entry.item.operationType === "move_task" && entry.applied?.readback)
            .map((entry) => {
              const readback = entry.applied!.readback!;
              const rollover = entry.item.requiresRolloverReadback ? `，顺延次数 ${String(readback.rolloverCount)}` : "";
              return `${entry.item.title} → ${String(readback.date)} ${String(readback.daySegment)}${rollover}`;
            });
          setApplyNotice(
            moveReadbacks.length > 0
              ? `已写入并读回最终状态：${moveReadbacks.join("；")}`
              : `已写入并读回 ${applied.length} 项最终状态。`,
          );
          setClosedPatchIds((current) => [...current, patchId]);
          setDecisions((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(`${patchId}:`))));
          closedAnyPatch = true;
        } else if (body?.status === "rejected") {
          setClosedPatchIds((current) => [...current, patchId]);
          setDecisions((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(`${patchId}:`))));
          closedAnyPatch = true;
        } else {
          throw new Error("审核结果无法确认，草稿仍保留，请刷新后核对。");
        }
      }
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "应用建议失败");
    } finally {
      setPendingAction(null);
      setApplyProgress(null);
      if (closedAnyPatch) router.refresh();
    }
  }

  function formatConflictSide(value: Record<string, unknown> | undefined) {
    if (!value) return "无";
    return Object.entries(value).map(([key, entry]) => `${key}: ${String(entry ?? "无")}`).join("；");
  }

  const submitPresentation = getReviewSubmitPresentation({
    actionableCount: actionable.length,
    pendingCount: pending,
    acceptedCount: accepted,
    isApplying,
    progress: applyProgress,
  });

  return (
    <div className="paw-page">
      <section className="paw-page-header">
        <h1 className="paw-page-date">审核</h1>
        <div className="paw-agent-row">
          <CatIcon size={40} mood="think" />
          <p className="paw-agent-msg">这些是待确认的调整建议，只有你确认后才会生效。</p>
        </div>
      </section>

      {data.dataUnavailable ? (
        <ReviewNotice tone="danger" title="暂时无法读取调整建议">
          请稍后刷新页面。当前页面不会把未确认的建议写入计划。
        </ReviewNotice>
      ) : null}

      <div className="paw-trust-banner">
        <span className="paw-trust-banner-icon" aria-hidden="true">
          <Lock size={15} />
        </span>
        <span><strong>保护规则</strong>：日常与恢复时间不会自动修改；每次调整都需经你确认，并在写入后核对最终状态。</span>
      </div>

      <OperationApprovalList approvals={approvals} expiredApprovals={expiredApprovals} />

      <section className={`paw-list-card paw-review-summary-card ${hasVisibleSuggestions ? "" : "is-empty"} mb-4`}>
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">待审核建议</h2>
            <p className="paw-list-subtitle">
              {hasVisibleSuggestions
                ? "逐条确认后提交；写入前会重查任务状态和固定日程冲突。"
                : "需要你确认的任务与日程调整会集中显示在这里。"}
            </p>
          </div>
          <div className="paw-review-queue-actions">
            <span className="paw-review-count-badge">
              {hasVisibleSuggestions ? `${draftCount} 份建议 · ${operationCount} 项调整` : "0 项待审核"}
            </span>
            {draftCount > 0 ? (
              <button
                type="button"
                onClick={() => setClearConfirmationOpen(true)}
                disabled={isApplying}
                className="paw-review-clear-btn"
                aria-label="清空全部待审核建议"
              >
                <Trash2 size={14} />
                {pendingAction === "bulk-reject" ? "清空中…" : "清空建议"}
              </button>
            ) : null}
          </div>
        </div>
        {hasVisibleSuggestions ? (
          <div className="paw-status-pills mt-4">
            <span className="paw-status-pill">任务调整 {taskChangeCount}</span>
            <span className="paw-status-pill">日程导入 {timetableImportCount}</span>
            <span className="paw-status-pill">受保护 {protectedCount}</span>
            <span className="paw-status-pill">已跳过 {skippedCount}</span>
            <span className={conflictCount > 0 ? "paw-status-pill warn" : "paw-status-pill"}>冲突 {conflictCount}</span>
            <span className="paw-status-pill">用户确认后才写入</span>
          </div>
        ) : (
          <div
            className={`paw-review-empty-state ${applyNotice ? "is-success" : ""}`}
            role="status"
            aria-live="polite"
          >
            <span className="paw-review-empty-icon" aria-hidden="true">
              <Check size={18} strokeWidth={2.4} />
            </span>
            <div>
              <h3>{applyNotice ? "已完成并核对" : "现在没有待审核建议"}</h3>
              <p>{applyNotice ?? "计划保持原样。新的调整建议生成后，会在这里等你逐条确认。"}</p>
            </div>
          </div>
        )}
      </section>

      {applyError ? (
        <ReviewNotice tone="danger" title="未能完成审核">
          {applyError}
        </ReviewNotice>
      ) : null}

      {applyNotice && hasVisibleSuggestions ? (
        <ReviewNotice tone="success" title="最终状态已核对">
          {applyNotice}
        </ReviewNotice>
      ) : null}

      {pendingAction === "apply-selected" && applyProgress ? (
        <ReviewNotice tone="info" title={`正在逐份提交 ${applyProgress.current}/${applyProgress.total}`}>
          每份调整建议都会分别写入并核对最终状态。
        </ReviewNotice>
      ) : null}

      {hasVisibleSuggestions ? <section className="paw-suggestion-list">
        {visiblePatchItems.map((item: PatchItem) => {
          const decision = decisions[item.id];
          const userImpact = item.impact.filter(
            (impact) => !/^patch\s/i.test(impact) && !isCapacityText(impact),
          );
          const capacityConflict = item.conflict
            ? isCapacityText(`${item.conflict.reason} ${JSON.stringify(item.conflict.expected)} ${JSON.stringify(item.conflict.actual)}`)
            : false;
          const visibleReason = isCapacityText(item.reason) ? "这项建议会调整任务安排。" : item.reason;
          const visibleSkippedReason = item.skipped && item.skippedReason && !isCapacityText(item.skippedReason)
            ? item.skippedReason
            : "";
          const visibleProtectedEvidence = item.protectedEvidence.filter((evidence) => !isCapacityText(evidence));
          return (
            <article
              key={item.id}
              className={`paw-suggestion-card ${item.protected ? "protected" : ""} ${decision === "accepted" ? "accepted" : ""} ${decision === "rejected" ? "rejected" : ""}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="paw-status-pill">{item.kind}</span>
                {item.protected ? (
                  <span className="paw-status-pill">
                    <Lock size={12} />
                    受保护
                  </span>
                ) : null}
                {item.skipped ? <span className="paw-status-pill">已跳过</span> : null}
                {item.conflict ? <span className="paw-status-pill warn">冲突</span> : null}
                {decision ? <span className="paw-status-pill link">{decision === "accepted" ? "已接受" : "已拒绝"}</span> : null}
              </div>
              <h2 className="paw-suggestion-what mt-3">{item.title}</h2>
              <p className="paw-suggestion-why paw-wrap-anywhere">{visibleReason}</p>
              <ReviewItemState
                isProtected={Boolean(item.protected)}
                skippedReason={item.skipped ? visibleSkippedReason : undefined}
                conflict={item.conflict ? {
                  reason: capacityConflict ? "当前计划与建议基于的状态不一致" : item.conflict.reason,
                  expected: capacityConflict ? undefined : formatConflictSide(item.conflict.expected),
                  actual: capacityConflict ? undefined : formatConflictSide(item.conflict.actual),
                } : undefined}
              />
              <div className="paw-suggestion-row">
                <div className="paw-suggestion-diff">
                  <div className="paw-diff-box paw-diff-before">
                    <div className="paw-diff-label">原计划</div>
                    {item.from ?? "无"}
                  </div>
                  <div className="paw-diff-box paw-diff-after">
                    <div className="paw-diff-label">新计划</div>
                    {item.to ?? "无"}
                  </div>
                </div>

                <div className="paw-suggestion-actions">
                  {item.protected || item.skipped || item.conflict ? (
                    <>
                      <span className="paw-status-pill">保留现状或丢弃建议</span>
                      <button
                        type="button"
                        onClick={() => dismissPatch(item.patchId)}
                        disabled={isApplying}
                        className="paw-sg-btn reject"
                      >
                        <X size={15} />
                        丢弃整份建议
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => decide(item.id, "accepted")}
                        disabled={isApplying}
                        className={`paw-sg-btn accept ${decision === "accepted" ? "selected" : ""}`}
                      >
                        <Check size={15} />
                        接受
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(item.id, "rejected")}
                        disabled={isApplying}
                        className={`paw-sg-btn reject ${decision === "rejected" ? "selected" : ""}`}
                      >
                        <X size={15} />
                        拒绝
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="paw-status-pills">
                {userImpact.map((impact) => (
                  <span key={impact} className="paw-status-pill">{impact}</span>
                ))}
                {visibleProtectedEvidence.map((evidence) => (
                  <span key={evidence} className="paw-status-pill">
                    <Lock size={12} />
                    {evidence}
                  </span>
                ))}
              </div>
              <ReviewTechnicalDetails
                operationType={item.operationType}
                patchId={item.provenance.patchId}
                operationIndex={item.provenance.operationIndex}
                createdBy={item.provenance.createdBy}
                createdAt={new Date(item.provenance.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                agentRun={item.agentRun ? {
                  label: item.agentRunLabel,
                  status: item.agentRun.status,
                  id: item.agentRun.id,
                } : undefined}
              />
            </article>
          );
        })}
      </section> : null}

      {visiblePatchItems.length > 0 ? (
      <section className="paw-review-bottom">
        <button type="button" onClick={() => setDecisions({})} disabled={isApplying} className="paw-secondary-btn">
          <RotateCcw size={14} /> 重新选择
        </button>
        <button type="button" onClick={acceptAll} disabled={isApplying} className="paw-secondary-btn">
          全部接受
        </button>
        <button
          type="button"
          onClick={applySelected}
          disabled={submitPresentation.disabled}
          className="paw-primary-btn"
          aria-describedby="paw-review-submit-reason"
        >
          {submitPresentation.label}
        </button>
        <span className="paw-status-pill" aria-label="审核选择统计">
          {accepted} 接受 · {rejected} 拒绝 · {pending} 待定
        </span>
        <p id="paw-review-submit-reason" className="paw-review-submit-reason" aria-live="polite">
          {submitPresentation.reason}
        </p>
      </section>
      ) : null}

      <ConfirmDialog
        open={clearConfirmationOpen}
        onClose={() => {
          if (!isApplying) setClearConfirmationOpen(false);
        }}
        onConfirm={() => void dismissAllDrafts()}
        title="清空待审核建议？"
        description={`将拒绝 ${draftCount} 份建议，共 ${operationCount} 项变更。`}
        confirmLabel="确认清空"
        pending={pendingAction === "bulk-reject"}
        destructive
      >
        这些建议会离开审核页；已经生效的任务和日程不会改变。
      </ConfirmDialog>
    </div>
  );
}

export const ReschedulePreview = ReviewPreview;
