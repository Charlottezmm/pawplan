"use client";

import { Check, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

export type PendingOperationApproval = {
  id: string;
  operationKind: string;
  summary: {
    title?: string;
    description?: string;
    count?: number;
    totalMinutes?: number;
    items?: string[];
  };
  expiresAt: string;
};

export function OperationApprovalList({ approvals }: { approvals: PendingOperationApproval[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(approval: PendingOperationApproval, decision: "approved" | "rejected") {
    if (
      decision === "approved" &&
      !window.confirm(`确认批准“${approval.summary.title ?? "这项操作"}”？\n\n批准后，Agent 只能执行这一份精确 Preview。`)
    ) return;
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
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审核失败");
    } finally {
      setPendingId(null);
    }
  }

  if (approvals.length === 0) return null;
  return (
    <section className="paw-list-card mb-4">
      <div className="paw-list-header">
        <div>
          <h2 className="paw-list-title">高风险操作待确认</h2>
          <p className="paw-list-subtitle">只有你在这里批准后，Agent 才能执行对应的精确 Preview。</p>
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
              {approval.summary.items?.length ? (
                <details className="paw-row-meta mt-2">
                  <summary>查看全部 {approval.summary.items.length} 个标题</summary>
                  <ul className="mt-2">
                    {approval.summary.items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}
                  </ul>
                </details>
              ) : null}
              <p className="paw-row-meta">批准有效期至 {new Date(approval.expiresAt).toLocaleString("zh-CN")}</p>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                className="paw-primary-btn"
                disabled={pendingId !== null}
                onClick={() => decide(approval, "approved")}
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
  );
}
