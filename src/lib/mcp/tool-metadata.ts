export type McpPermission = "read_only" | "review_only" | "read_write";
export type PawPlanToolCapability = "read" | "review" | "write";

export class McpPermissionError extends Error {
  code = "mcp_permission_denied" as const;
  status = 403;

  constructor(
    public permission: McpPermission,
    public toolName: string,
  ) {
    super(`MCP ${permission} token does not allow ${toolName}`);
  }

  get details() {
    return { permission: this.permission, toolName: this.toolName };
  }
}

export const pawPlanToolPermissions = {
  get_agent_guidance: "read",
  get_mcp_usage: "read",
  get_today: "read",
  get_week: "read",
  get_month: "read",
  get_constraints: "read",
  get_capacity: "read",
  get_decisions: "read",
  get_conversations: "read",
  get_checkins: "read",
  get_project_portfolio: "read",
  propose_project_portfolio_update: "review",
  apply_project_portfolio_update: "write",
  get_tasks: "read",
  preview_task_batch: "write",
  create_inbox_item: "write",
  create_checkin: "write",
  update_task_status: "write",
  update_task_schedule: "write",
  update_task_notes: "write",
  propose_task_notes_batch: "review",
  apply_task_notes_batch: "write",
  update_tasks_batch: "write",
  archive_tasks_batch: "write",
  restore_tasks_batch: "write",
  delete_tasks_batch: "write",
  update_time_block_series: "write",
  delete_time_block_series: "write",
  replace_plan_window: "write",
  save_conversation_summary: "write",
  record_decision: "write",
  propose_patch: "review",
  propose_daily_rebalance: "review",
  propose_week_rebalance: "review",
  propose_overdue_replan: "review",
  propose_timetable_import: "review",
  import_plan_bundle: "write",
} as const satisfies Record<string, PawPlanToolCapability>;

export const pawPlanWriteToolNames = Object.entries(pawPlanToolPermissions)
  .filter(([, capability]) => capability !== "read")
  .map(([name]) => name);

const pawPlanWriteToolNameSet = new Set<string>(pawPlanWriteToolNames);

export function isPawPlanWriteTool(name: string) {
  return pawPlanWriteToolNameSet.has(name);
}

export function canUsePawPlanTool(permission: McpPermission, name: string) {
  const capability = pawPlanToolPermissions[name as keyof typeof pawPlanToolPermissions];
  if (!capability) return false;
  if (permission === "read_write") return true;
  if (permission === "review_only") return capability === "read" || capability === "review";
  return capability === "read";
}
