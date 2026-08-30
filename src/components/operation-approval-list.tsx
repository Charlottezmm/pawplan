"use client";

import { Check, ShieldCheck, X } from "lucide-react";
import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "./ui/confirm-dialog";

export type PendingOperationApproval = {
  id: string;
  operationKind: string;
  summary: {
    title?: string;
    description?: string;
    count?: number;
    totalMinutes?: number;
    items?: string[];
    noteChanges?: Array<{
      taskId: string;
      title: string;
      before: string | null;
      after: string;
    }>;
  };
  expiresAt: string;
};

export type ExpiredOperationApproval = PendingOperationApproval & {
  status: "pending" | "approved";
};

export function OperationApprovalList({
  approvals,
  expiredApprovals,
}: {
  approvals: PendingOperationApproval[];
  expiredApprovals: ExpiredOperationApproval[];
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalToConfirm, setApprovalToConfirm] = useState<PendingOperationApproval | null>(null);

  async function decide(approval: PendingOperationApproval, decision: "approved" | "rejected") {
    setPendingId(approval.id);
    setError(null);
    try {
      const response = await fetch("/api/operation-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: approval.id, decision }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "审核失败");
      if (decision === "approved") setApprovalToConfirm(null);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审核失败");
    } finally {
      setPendingId(null);
    }
  }

  if (approvals.length === 0 && expiredApprovals.length === 0) return null;
  return (
    <>
      {approvals.length > 0 ? (
        <section className="paw-list-card mb-4">
          <div className="paw-list-header">
            <div>
              <h2 className="paw-list-title">高风险操作待确认</h2>
              <p className="paw-list-subtitle">只有你在这里批准后，助手才能执行对应的精确预览。</p>
            </div>
            <span className="paw-status-pill"><ShieldCheck size={13} /> {approvals.length} 项</span>
          </div>
          {error ? <p className="paw-status-pill warn mt-3" role="status">{error}</p> : null}
          <div className="paw-suggestion-list mt-4">
            {approvals.map((approval) => (
              <article className="paw-suggestion-card" key={approval.id}>
                <div>
                  <h3 className="paw-row-title">{approval.summary.title ?? "计划操作"}</h3>
                  {approval.summary.description ? <p className="paw-row-meta">{approval.summary.description}</p> : null}
                  {typeof approval.summary.count === "number" ? <p className="paw-row-meta">共 {approval.summary.count} 项</p> : null}
                  {typeof approval.summary.totalMinutes === "number" ? (
                    <p className="paw-row-meta">预计总时长 {approval.summary.totalMinutes} 分钟</p>
                  ) : null}
                  {approval.summary.items?.length && !approval.summary.noteChanges?.length ? (
                    <details className="paw-row-meta mt-2">
                      <summary>查看全部 {approval.summary.items.length} 个标题</summary>
                      <ul className="mt-2">
                        {approval.summary.items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
                      </ul>
                    </details>
                  ) : null}
                  {approval.summary.noteChanges?.length ? (
                    <details className="paw-row-meta mt-2">
                      <summary>查看全部 {approval.summary.noteChanges.length} 条修改前后内容</summary>
                      <div className="mt-3 space-y-3">
                        {approval.summary.noteChanges.map((change) => (
                          <section className="rounded-xl border border-[var(--paw-line)] p-3" key={change.taskId}>
                            <h4 className="paw-row-title">{change.title}</h4>
                            <p className="paw-row-meta mt-2">修改前</p>
                            <pre className="mt-1 whitespace-pre-wrap break-words text-sm">{change.before ?? "（无）"}</pre>
                            <p className="paw-row-meta mt-3">修改后</p>
                            <pre className="mt-1 whitespace-pre-wrap break-words text-sm">{change.after}</pre>
                          </section>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  <p className="paw-row-meta">批准有效期至 {new Date(approval.expiresAt).toLocaleString("zh-CN")}</p>
                </div>
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    className="paw-primary-btn"
                    disabled={pendingId !== null}
                    onClick={() => setApprovalToConfirm(approval)}
                  >
                    <Check size={14} /> {pendingId === approval.id ? "处理中…" : "批准"}
                  </button>
                  <button
                    type="button"
                    className="paw-secondary-btn"
                    disabled={pendingId !== null}
                    onClick={() => decide(approval, "rejected")}
                  >
                    <X size={14} /> 拒绝
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={Boolean(approvalToConfirm)}
        onClose={() => {
          if (!pendingId) setApprovalToConfirm(null);
        }}
        onConfirm={() => {
          if (approvalToConfirm) void decide(approvalToConfirm, "approved");
        }}
        title="批准高风险操作？"
        description={approvalToConfirm?.summary.title ?? "请核对这一份精确预览。"}
        confirmLabel="批准这份预览"
        pending={Boolean(approvalToConfirm && pendingId === approvalToConfirm.id)}
        destructive
      >
        {approvalToConfirm ? (
          <>
            {approvalToConfirm.summary.description ? <p>{approvalToConfirm.summary.description}</p> : null}
            {typeof approvalToConfirm.summary.count === "number" ? <p>影响 {approvalToConfirm.summary.count} 项。</p> : null}
            <p>批准只授权这一份精确预览，助手不能扩大范围。</p>
          </>
        ) : null}
      </ConfirmDialog>

      {expiredApprovals.length > 0 ? (
        <section className="paw-list-card mb-4">
          <div className="paw-list-header">
            <div>
              <h2 className="paw-list-title">最近过期的任务详情审核</h2>
              <p className="paw-list-subtitle">这些预览已失效，不能再批准；如仍需执行，请让助手重新提交。</p>
            </div>
            <span className="paw-status-pill warn">{expiredApprovals.length} 项已过期</span>
          </div>
          <div className="paw-suggestion-list mt-4">
            {expiredApprovals.map((approval) => (
              <article className="paw-suggestion-card expired" key={approval.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="paw-status-pill warn">已过期</span>
                  <span className="paw-status-pill">
                    {approval.status === "approved" ? "已批准，尚未应用" : "尚未批准"}
                  </span>
                </div>
                <h3 className="paw-row-title mt-3">{approval.summary.title ?? "批量更新任务详情"}</h3>
                {approval.summary.description ? <p className="paw-row-meta">{approval.summary.description}</p> : null}
                {typeof approval.summary.count === "number" ? <p className="paw-row-meta">共 {approval.summary.count} 项</p> : null}
                <p className="paw-row-meta">过期于 {new Date(approval.expiresAt).toLocaleString("zh-CN")}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
