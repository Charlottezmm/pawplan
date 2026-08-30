import React, { type ReactNode } from "react";

export type ReviewNoticeTone = "info" | "success" | "warning" | "danger";

export function ReviewNotice({
  tone,
  title,
  children,
}: {
  tone: ReviewNoticeTone;
  title: string;
  children: ReactNode;
}) {
  const urgent = tone === "danger";
  return (
    <section
      className={`paw-review-notice paw-review-notice-${tone} paw-wrap-anywhere`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      <strong className="paw-review-notice-title">{title}</strong>
      <div className="paw-review-notice-body">{children}</div>
    </section>
  );
}

export function ReviewItemState({
  isProtected,
  skippedReason,
  conflict,
}: {
  isProtected: boolean;
  skippedReason?: string;
  conflict?: {
    reason: string;
    expected?: string;
    actual?: string;
  };
}) {
  return (
    <div className="paw-review-item-states">
      {isProtected ? (
        <ReviewNotice tone="info" title="受保护">
          受保护，不会自动修改。你可以保留当前计划，或丢弃这份调整建议。
        </ReviewNotice>
      ) : null}
      {skippedReason !== undefined ? (
        <ReviewNotice tone="info" title="已跳过">
          当前状态已经无需执行。{skippedReason ? `原因：${skippedReason}` : "刷新后可查看最新状态。"}
        </ReviewNotice>
      ) : null}
      {conflict ? (
        <ReviewNotice tone="warning" title="冲突">
          <p>任务已变化，需要重新确认。你可以丢弃这份建议，再基于最新计划重新生成。</p>
          <dl className="paw-review-conflict-detail">
            <div>
              <dt>建议基于</dt>
              <dd>{conflict.expected ?? "未提供"}</dd>
            </div>
            <div>
              <dt>当前状态</dt>
              <dd>{conflict.actual ?? "未提供"}</dd>
            </div>
            <div>
              <dt>检查结果</dt>
              <dd>{conflict.reason}</dd>
            </div>
          </dl>
        </ReviewNotice>
      ) : null}
    </div>
  );
}

export function ReviewTechnicalDetails({
  operationType,
  patchId,
  operationIndex,
  createdBy,
  createdAt,
  agentRun,
}: {
  operationType: string;
  patchId: string;
  operationIndex: number;
  createdBy: string;
  createdAt: string;
  agentRun?: {
    label?: string;
    status: string;
    id: string;
  };
}) {
  return (
    <details className="paw-review-technical-details">
      <summary>技术详情</summary>
      <dl>
        <div>
          <dt>操作类型</dt>
          <dd>{operationType}</dd>
        </div>
        <div>
          <dt>建议编号</dt>
          <dd>{patchId}</dd>
        </div>
        <div>
          <dt>操作序号</dt>
          <dd>{operationIndex}</dd>
        </div>
        <div>
          <dt>创建来源</dt>
          <dd>{createdBy}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{createdAt}</dd>
        </div>
        {agentRun ? (
          <div>
            <dt>助手运行</dt>
            <dd>{agentRun.label ?? "未命名运行"} · {agentRun.status} · {agentRun.id}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

export function getReviewSubmitPresentation(input: {
  actionableCount: number;
  pendingCount: number;
  acceptedCount: number;
  isApplying: boolean;
  progress?: { current: number; total: number } | null;
}) {
  if (input.isApplying) {
    const progress = input.progress;
    return {
      disabled: true,
      label: progress ? `正在提交 ${progress.current}/${progress.total}` : "正在处理，请稍候",
      reason: "正在逐份写入并核对最终状态，请不要关闭页面。",
    };
  }
  if (input.actionableCount === 0) {
    return {
      disabled: true,
      label: "没有可提交项",
      reason: "当前只有受保护、已跳过或冲突的建议；请保留现状或丢弃对应建议。",
    };
  }
  if (input.pendingCount > 0) {
    return {
      disabled: true,
      label: `还有 ${input.pendingCount} 项未决定`,
      reason: "请为每项可执行建议选择接受或拒绝。",
    };
  }
  return {
    disabled: false,
    label: input.acceptedCount > 0 ? `提交并应用 ${input.acceptedCount} 项` : "提交并拒绝全部",
    reason: "提交时会再次检查任务状态和固定日程冲突，并读回最终结果。",
  };
}
