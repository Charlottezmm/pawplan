"use client";

import { Check, Lock, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CatIcon } from "./cat-icon";
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
  const blockedCount = visiblePatchItems.filter((item) => item.protected || item.skipped || item.conflict).length;
  const visibleDraftPatchIds = data.draftPatchIds.filter((patchId) => !closedPatchIds.includes(patchId));
  const { patchIds: visiblePatchIds, draftCount, operationCount } = getReviewQueueSummary(
    visiblePatchItems,
    visibleDraftPatchIds,
  );

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
    const confirmed = window.confirm(
      `确认清空 Review 中的 ${draftCount} 份草稿（共 ${operationCount} 项建议）？\n\n草稿会标记为已拒绝并离开 Review；已生效日程不会改动。`,
    );
    if (!confirmed) return;

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
            : "清空待审核草稿失败",
        );
      }

      const result = parseRejectReviewPatchesResponse(body);
      if (!result) throw new Error("清空结果无法验证，请刷新页面确认 Review 状态");
      const rejectedPatchIds = result.rejectedPatchIds;
      setClosedPatchIds((current) => [...new Set([...current, ...rejectedPatchIds])]);
      setDecisions((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => !rejectedPatchIds.some((patchId) => id.startsWith(`${patchId}:`))),
        ),
      );
      setApplyNotice(getRejectReviewPatchesNotice(result));
      router.refresh();
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "清空待审核草稿失败");
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
    setApplyError(null);
    setApplyNotice(null);
    try {
      for (const patchId of patchIds) {
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
        } else if (body?.status === "rejected") {
          setClosedPatchIds((current) => [...current, patchId]);
          setDecisions((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(`${patchId}:`))));
        } else {
          throw new Error("审核结果无法确认，草稿仍保留，请刷新后核对。");
        }
      }
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "应用建议失败");
    } finally {
      setPendingAction(null);
    }
  }

  function formatConflictSide(value: Record<string, unknown> | undefined) {
    if (!value) return "无";
    return Object.entries(value).map(([key, entry]) => `${key}: ${String(entry ?? "无")}`).join("；");
  }

  return (
    <div className="paw-page">
      <section className="paw-page-header">
        <h1 className="paw-page-date">审核</h1>
        <div className="paw-agent-row">
          <CatIcon size={40} mood="think" />
          <p className="paw-agent-msg">这些是 Agent 提的调整建议，你点头才会生效。</p>
        </div>
      </section>

      {data.dataUnavailable ? (
        <section className="paw-status-pill warn" role="status">
          当前没有 DATABASE_URL，无法读取 agent patch；配置数据库后会显示待审核建议。
        </section>
      ) : null}

      <div className="paw-trust-banner">Routine 和 Recovery 受保护；Agent 可以提任务调整或日程导入草稿，但只有你确认后才会写入。</div>

      <OperationApprovalList approvals={approvals} expiredApprovals={expiredApprovals} />

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">Review queue</h2>
            <p className="paw-list-subtitle">提交前会重查任务状态和固定日程冲突。</p>
          </div>
          <div className="paw-review-queue-actions">
            <span className="paw-status-pill">{draftCount} 份草稿 · {operationCount} 项建议</span>
            {draftCount > 0 ? (
              <button
                type="button"
                onClick={dismissAllDrafts}
                disabled={isApplying}
                className="paw-review-clear-btn"
                aria-label="清空全部待审核草稿"
              >
                <Trash2 size={14} />
                {pendingAction === "bulk-reject" ? "清空中…" : "清空草稿"}
              </button>
            ) : null}
          </div>
        </div>
        <div className="paw-status-pills mt-4">
          <span className="paw-status-pill">任务调整 {taskChangeCount}</span>
          <span className="paw-status-pill">日程导入 {timetableImportCount}</span>
          <span className={blockedCount > 0 ? "paw-status-pill warn" : "paw-status-pill"}>冲突/阻止 {blockedCount}</span>
          <span className="paw-status-pill">用户确认后才写入</span>
        </div>
      </section>

      {applyError ? (
        <section className="paw-status-pill warn" role="status">
          {applyError}
        </section>
      ) : null}

      {applyNotice ? (
        <section className="paw-status-pill" role="status">
          {applyNotice}
        </section>
      ) : null}

      <section className="paw-suggestion-list">
        {visiblePatchItems.length === 0 ? (
          <div className="paw-empty">
            <h2>暂时没有新建议</h2>
            <p>Agent 提出调整后会出现在这里，逐条确认就行。</p>
          </div>
        ) : null}

        {visiblePatchItems.map((item: PatchItem) => {
          const decision = decisions[item.id];
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
                    已阻止
                  </span>
                ) : null}
                {item.skipped ? <span className="paw-status-pill warn">未应用</span> : null}
                {item.conflict ? <span className="paw-status-pill warn">冲突</span> : null}
                {decision ? <span className="paw-status-pill link">{decision === "accepted" ? "已接受" : "已拒绝"}</span> : null}
              </div>
              <h2 className="paw-suggestion-what mt-3">{item.title}</h2>
              <p className="paw-suggestion-why">类型：{item.operationType}</p>
              <p className="paw-suggestion-why paw-wrap-anywhere">{item.reason}</p>
              <p className="paw-suggestion-why">
                来源：patch {item.provenance.patchId.slice(0, 8)} · op {item.provenance.operationIndex} · {item.provenance.createdBy} · {new Date(item.provenance.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
              </p>
              {item.agentRun ? (
                <p className="paw-suggestion-why">
                  Agent run：{item.agentRunLabel} · {item.agentRun.status} · run {item.agentRun.id.slice(0, 8)}
                </p>
              ) : null}
              {item.skippedReason ? <p className="paw-suggestion-why paw-wrap-anywhere">未应用原因：{item.skippedReason}</p> : null}
              {item.conflict ? (
                <div className="paw-status-pill warn paw-wrap-anywhere" role="status">
                  冲突：{item.conflict.reason}；期望 {formatConflictSide(item.conflict.expected)}；当前 {formatConflictSide(item.conflict.actual)}
                </div>
              ) : null}
              <div className="paw-suggestion-row">
                <div className="paw-suggestion-diff">
                  <div className="paw-diff-box paw-diff-before">
                    <div className="paw-diff-label">Before</div>
                    {item.from ?? "无"}
                  </div>
                  <div className="paw-diff-box paw-diff-after">
                    <div className="paw-diff-label">After</div>
                    {item.to ?? "无"}
                  </div>
                </div>

                <div className="paw-suggestion-actions">
                  {item.protected || item.skipped || item.conflict ? (
                    <>
                      <span className="paw-status-pill">需要手动处理</span>
                      <button
                        type="button"
                        onClick={() => dismissPatch(item.patchId)}
                        disabled={isApplying}
                        className="paw-sg-btn reject"
                      >
                        <X size={15} />
                        丢弃整条
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
                {item.impact.map((impact) => (
                  <span key={impact} className="paw-status-pill">{impact}</span>
                ))}
                <span className="paw-status-pill">{item.capacity}</span>
                {item.protectedEvidence.map((evidence) => (
                  <span key={evidence} className="paw-status-pill">
                    <Lock size={12} />
                    {evidence}
                  </span>
                ))}
              </div>
            </article>
          );
        })}
      </section>

      {visiblePatchItems.length > 0 ? (
      <section className="paw-review-bottom">
        <button type="button" onClick={() => setDecisions({})} disabled={isApplying} className="paw-secondary-btn">
          <RotateCcw size={14} /> 重新选择
        </button>
        <button type="button" onClick={acceptAll} disabled={isApplying} className="paw-secondary-btn">
          全部接受
        </button>
        <button type="button" onClick={applySelected} disabled={actionable.length === 0 || pending > 0 || isApplying} className="paw-primary-btn">
          {pendingAction === "apply-selected" ? "提交中" : accepted > 0 ? `提交审核：应用 ${accepted} 项` : "提交审核：全部拒绝"}
        </button>
        <span className="paw-status-pill">
          {accepted} 接受 · {rejected} 拒绝 · {pending} 待定
        </span>
      </section>
      ) : null}
    </div>
  );
}

export const ReschedulePreview = ReviewPreview;
