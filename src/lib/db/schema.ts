import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const planStatus = pgEnum("plan_status", ["active", "archived"]);
export const planVersionSource = pgEnum("plan_version_source", ["baseline", "manual_edit", "agent_patch", "mcp"]);
export const taskStatus = pgEnum("task_status", ["todo", "done", "skipped", "backlog"]);
export const priority = pgEnum("priority", ["low", "normal", "high", "urgent"]);
export const energyLevel = pgEnum("energy_level", ["low", "medium", "high"]);
export const daySegment = pgEnum("day_segment", ["morning", "afternoon", "evening"]);
export const routineTimeSegment = pgEnum("routine_time_segment", ["morning", "afternoon", "evening", "specific_window"]);
export const trackKind = pgEnum("track_kind", ["main", "work", "side", "recovery", "custom"]);
export const timeBlockKind = pgEnum("time_block_kind", ["course", "meeting", "unavailable", "routine", "recovery"]);
export const agentPatchStatus = pgEnum("agent_patch_status", ["draft", "applied", "rejected"]);
export const agentRunKind = pgEnum("agent_run_kind", [
  "morning_rebalance",
  "evening_review",
  "weekly_rebalance",
]);
export const agentRunStatus = pgEnum("agent_run_status", [
  "started",
  "draft_created",
  "no_change",
  "duplicate",
  "failed",
]);
export const inboxSource = pgEnum("inbox_source", ["manual", "imported"]);
export const checkinTaskStatus = pgEnum("checkin_task_status", ["done", "not_done", "partial", "skipped"]);
export const changeLogSource = pgEnum("change_log_source", ["manual", "agent_patch", "import", "mcp"]);
export const mcpPermission = pgEnum("mcp_permission", ["read_only", "read_write"]);
export const onboardingEventType = pgEnum("onboarding_event_type", [
  "schedule_import_skipped",
  "connector_setup_skipped",
  "review_opened",
]);
export const conversationContextType = pgEnum("conversation_context_type", [
  "weekly_review",
  "decision",
  "learning_qa",
  "check_in_followup",
  "methodology",
  "adhoc",
]);
export const decisionStatus = pgEnum("decision_status", ["active", "superseded", "abandoned"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueName: uniqueIndex("workspaces_name_unique").on(table.name),
}));

export const betaInviteCodes = pgTable("beta_invite_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  maxRedemptions: integer("max_redemptions"),
  redemptionCount: integer("redemption_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  codeHashUnique: uniqueIndex("beta_invite_codes_code_hash_unique").on(table.codeHash),
}));

export const workspaceBetaAccess = pgTable("workspace_beta_access", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  inviteCodeId: uuid("invite_code_id").references(() => betaInviteCodes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceOnboardingEvents = pgTable("workspace_onboarding_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  eventType: onboardingEventType("event_type").notNull(),
  metadataJson: jsonb("metadata_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueWorkspaceEvent: uniqueIndex("workspace_onboarding_events_workspace_event_unique").on(
    table.workspaceId,
    table.eventType,
  ),
}));

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 180 }).notNull(),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  status: planStatus("status").notNull().default("active"),
  baselineSnapshot: jsonb("baseline_snapshot").notNull(),
  currentVersionId: uuid("current_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const planVersions = pgTable("plan_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  source: planVersionSource("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  color: varchar("color", { length: 32 }).notNull().default("#71717a"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const courses = pgTable("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  color: varchar("color", { length: 32 }).notNull().default("#2563eb"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  kind: trackKind("kind").notNull(),
  targetMinPercent: integer("target_min_percent"),
  targetMaxPercent: integer("target_max_percent"),
  color: varchar("color", { length: 32 }).notNull().default("#16a34a"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  color: varchar("color", { length: 32 }).notNull().default("#71717a"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 240 }).notNull(),
  notes: text("notes"),
  date: timestamp("date", { withTimezone: true }).notNull(),
  daySegment: daySegment("day_segment").notNull(),
  status: taskStatus("status").notNull().default("todo"),
  blocked: boolean("blocked").notNull().default(false),
  priority: priority("priority").notNull().default("normal"),
  estimatedMinutes: integer("estimated_minutes").notNull().default(30),
  energyLevel: energyLevel("energy_level").notNull().default("medium"),
  isChore: boolean("is_chore").notNull().default(false),
  movable: boolean("movable").notNull().default(true),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
  trackId: uuid("track_id").references(() => tracks.id, { onDelete: "set null" }),
  parentTaskId: uuid("parent_task_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const taskTags = pgTable("task_tags", {
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
}, (table) => ({
  uniqueTaskTag: uniqueIndex("task_tags_task_id_tag_id_unique").on(table.taskId, table.tagId),
}));

export const timeBlocks = pgTable("time_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 180 }).notNull(),
  kind: timeBlockKind("kind").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  recurrenceRule: text("recurrence_rule"),
  recurrenceWeekdayMask: integer("recurrence_weekday_mask"),
  courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
  trackId: uuid("track_id").references(() => tracks.id, { onDelete: "set null" }),
  movable: boolean("movable").notNull().default(false),
  estimatedMinutes: integer("estimated_minutes"),
  energyLevel: energyLevel("energy_level"),
});

export const routines = pgTable("routines", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 180 }).notNull(),
  defaultTimeSegment: routineTimeSegment("default_time_segment").notNull(),
  defaultStartTime: varchar("default_start_time", { length: 5 }),
  defaultEndTime: varchar("default_end_time", { length: 5 }),
  weekdayPattern: varchar("weekday_pattern", { length: 80 }).notNull(),
  estimatedMinutes: integer("estimated_minutes").notNull(),
  energyLevel: energyLevel("energy_level").notNull().default("low"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dayCapacities = pgTable("day_capacities", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  date: timestamp("date", { withTimezone: true }).notNull(),
  morningMinutes: integer("morning_minutes").notNull().default(180),
  afternoonMinutes: integer("afternoon_minutes").notNull().default(240),
  eveningMinutes: integer("evening_minutes").notNull().default(120),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueWorkspaceDate: uniqueIndex("day_capacities_workspace_id_date_unique").on(table.workspaceId, table.date),
}));

export const segmentEnergySettings = pgTable("segment_energy_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  segment: daySegment("segment").notNull(),
  energyLevel: energyLevel("energy_level").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueWorkspaceSegment: uniqueIndex("segment_energy_workspace_id_segment_unique").on(table.workspaceId, table.segment),
}));

export const routineCompletions = pgTable("routine_completions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  routineId: uuid("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
  date: timestamp("date", { withTimezone: true }).notNull(),
  completed: boolean("completed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxItems = pgTable("inbox_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 240 }).notNull(),
  source: inboxSource("source").notNull().default("manual"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const checkins = pgTable("checkins", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  date: timestamp("date", { withTimezone: true }).notNull(),
  completedText: text("completed_text").notNull().default(""),
  blockerText: text("blocker_text").notNull().default(""),
  nextText: text("next_text").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueWorkspaceDate: uniqueIndex("checkins_workspace_id_date_unique").on(table.workspaceId, table.date),
}));

export const checkinTasks = pgTable("checkin_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  checkinId: uuid("checkin_id").notNull().references(() => checkins.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  status: checkinTaskStatus("status").notNull(),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentPatches = pgTable("agent_patches", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  status: agentPatchStatus("status").notNull().default("draft"),
  scopeStart: timestamp("scope_start", { withTimezone: true }).notNull(),
  scopeEnd: timestamp("scope_end", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  patchJson: jsonb("patch_json").notNull(),
  createdBy: varchar("created_by", { length: 40 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
});

export const agentPatchReviews = pgTable("agent_patch_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  patchId: uuid("patch_id").notNull().references(() => agentPatches.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  acceptedOperationIndexes: jsonb("accepted_operation_indexes").notNull(),
  rejectedOperationIndexes: jsonb("rejected_operation_indexes").notNull(),
  skippedJson: jsonb("skipped_json").notNull(),
  conflictJson: jsonb("conflict_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspacePatchIdx: index("agent_patch_reviews_workspace_patch_idx").on(table.workspaceId, table.patchId),
}));

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
  patchId: uuid("patch_id").references(() => agentPatches.id, { onDelete: "set null" }),
  kind: agentRunKind("kind").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  status: agentRunStatus("status").notNull(),
  reason: text("reason").notNull(),
  inputJson: jsonb("input_json").notNull(),
  resultJson: jsonb("result_json").notNull(),
  warningsJson: jsonb("warnings_json").notNull().default([]),
  errorJson: jsonb("error_json"),
  createdBy: varchar("created_by", { length: 40 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueWorkspaceIdempotency: uniqueIndex("agent_runs_workspace_idempotency_unique").on(
    table.workspaceId,
    table.idempotencyKey,
  ),
  workspaceCreatedIdx: index("agent_runs_workspace_created_idx").on(table.workspaceId, table.createdAt),
  workspaceStatusIdx: index("agent_runs_workspace_status_idx").on(table.workspaceId, table.status),
}));

export const changeLogs = pgTable("change_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").references(() => plans.id, { onDelete: "cascade" }),
  source: changeLogSource("source").notNull(),
  summary: text("summary").notNull(),
  detailsJson: jsonb("details_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpTokens = pgTable("mcp_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  permission: mcpPermission("permission").notNull().default("read_only"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashIdx: index("mcp_tokens_token_hash_idx").on(table.tokenHash),
}));

export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: varchar("client_id", { length: 160 }).notNull(),
  clientName: varchar("client_name", { length: 180 }).notNull(),
  redirectUris: jsonb("redirect_uris").notNull(),
  grantTypes: jsonb("grant_types").notNull(),
  responseTypes: jsonb("response_types").notNull(),
  tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", { length: 40 }).notNull().default("none"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  clientIdUnique: uniqueIndex("oauth_clients_client_id_unique").on(table.clientId),
}));

export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  clientId: varchar("client_id", { length: 160 }).notNull(),
  codeHash: text("code_hash").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: varchar("code_challenge_method", { length: 16 }).notNull(),
  scope: text("scope").notNull(),
  permission: mcpPermission("permission").notNull().default("read_write"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  codeHashIdx: index("oauth_authorization_codes_code_hash_idx").on(table.codeHash),
  workspaceClientIdx: index("oauth_authorization_codes_workspace_client_idx").on(table.workspaceId, table.clientId),
}));

export const claudeConnectorAuthorizations = pgTable("claude_connector_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  clientId: varchar("client_id", { length: 160 }).notNull(),
  clientName: varchar("client_name", { length: 180 }).notNull().default("Claude"),
  accessTokenHash: text("access_token_hash").notNull(),
  refreshTokenHash: text("refresh_token_hash"),
  permission: mcpPermission("permission").notNull().default("read_write"),
  scope: text("scope").notNull().default("mcp"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  accessTokenHashIdx: index("claude_connector_authorizations_access_token_hash_idx").on(table.accessTokenHash),
  refreshTokenHashIdx: index("claude_connector_authorizations_refresh_token_hash_idx").on(table.refreshTokenHash),
  workspaceCreatedIdx: index("claude_connector_authorizations_workspace_created_idx").on(
    table.workspaceId,
    table.createdAt,
  ),
}));

export const mcpUsageEvents = pgTable("mcp_usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  tokenId: uuid("token_id").references(() => mcpTokens.id, { onDelete: "set null" }),
  toolName: varchar("tool_name", { length: 80 }).notNull(),
  permission: mcpPermission("permission").notNull(),
  success: boolean("success").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreatedIdx: index("mcp_usage_events_workspace_created_idx").on(table.workspaceId, table.createdAt),
  workspaceToolCreatedIdx: index("mcp_usage_events_workspace_tool_created_idx").on(
    table.workspaceId,
    table.toolName,
    table.createdAt,
  ),
  tokenIdx: index("mcp_usage_events_token_idx").on(table.tokenId),
}));

export const mcpTaskWriteBatches = pgTable("mcp_task_write_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  resultJson: jsonb("result_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueWorkspaceIdempotency: uniqueIndex("mcp_task_write_batches_workspace_key_unique").on(
    table.workspaceId,
    table.idempotencyKey,
  ),
  workspaceCreatedIdx: index("mcp_task_write_batches_workspace_created_idx").on(
    table.workspaceId,
    table.createdAt,
  ),
}));

export const mcpPlanImports = pgTable("mcp_plan_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
  importKey: varchar("import_key", { length: 160 }).notNull(),
  createdBy: varchar("created_by", { length: 40 }).notNull(),
  sourceLabel: varchar("source_label", { length: 120 }),
  taskCount: integer("task_count").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  derivedTaskIds: jsonb("derived_task_ids").notNull(),
  provenanceJson: jsonb("provenance_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueWorkspaceImportKey: uniqueIndex("mcp_plan_imports_workspace_id_import_key_unique").on(
    table.workspaceId,
    table.importKey,
  ),
  workspacePlanIdx: index("mcp_plan_imports_workspace_id_plan_id_idx").on(table.workspaceId, table.planId),
}));

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  topic: varchar("topic", { length: 240 }).notNull(),
  contextType: conversationContextType("context_type").notNull(),
  summary: text("summary").notNull(),
  decisionsJson: jsonb("decisions_json").notNull(),
  openQuestionsJson: jsonb("open_questions_json").notNull(),
  createdBy: varchar("created_by", { length: 40 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  topic: varchar("topic", { length: 240 }).notNull(),
  context: text("context").notNull(),
  optionsConsideredJson: jsonb("options_considered_json").notNull(),
  chosen: text("chosen").notNull(),
  rationale: text("rationale").notNull(),
  tradeoffsAccepted: text("tradeoffs_accepted").notNull().default(""),
  status: decisionStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  plans: many(plans),
  tasks: many(tasks),
}));
