export type AgentRunKind = "morning_rebalance" | "evening_review" | "weekly_rebalance" | "overdue_replan";
export type AgentRunStatus = "started" | "draft_created" | "needs_decision" | "no_change" | "duplicate" | "failed";
export type AgentRunCreatedBy = "codex" | "claude" | "user";
export type AgentRunWarning = { taskId?: string; code: string; message: string };
export type AgentRunError = { code: string; message: string };
export type AgentRunResult = {
  runId: string;
  status: AgentRunStatus;
  patchId?: string;
  reviewUrl: "/review";
  operationCount: number;
  skipped: AgentRunWarning[];
  warnings: AgentRunWarning[];
  needsDecision?: AgentRunWarning[];
  idempotencyKey: string;
  error?: AgentRunError;
};
