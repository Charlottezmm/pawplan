export type McpPermission = "read_only" | "read_write";

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
  get_tasks: "read",
  preview_task_batch: "write",
  create_inbox_item: "write",
  create_checkin: "write",
  update_task_status: "write",
  update_task_schedule: "write",
  update_task_notes: "write",
  update_tasks_batch: "write",
  archive_tasks_batch: "write",
  restore_tasks_batch: "write",
  delete_tasks_batch: "write",
  update_time_block_series: "write",
  delete_time_block_series: "write",
  replace_plan_window: "write",
  save_conversation_summary: "write",
  record_decision: "write",
  propose_patch: "write",
  propose_daily_rebalance: "write",
  propose_week_rebalance: "write",
  propose_overdue_replan: "write",
  propose_timetable_import: "write",
  import_plan_bundle: "write",
} as const satisfies Record<string, "read" | "write">;

export const pawPlanWriteToolNames = Object.entries(pawPlanToolPermissions)
  .filter(([, permission]) => permission === "write")
  .map(([name]) => name);

const pawPlanWriteToolNameSet = new Set<string>(pawPlanWriteToolNames);

export function isPawPlanWriteTool(name: string) {
  return pawPlanWriteToolNameSet.has(name);
}
