import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agentRuns,
  changeLogs,
  checkinTasks,
  checkins,
  claudeConnectorAuthorizations,
  dayCapacities,
  inboxItems,
  mcpPlanImports,
  mcpTaskWriteBatches,
  mcpTokens,
  mcpUsageEvents,
  oauthAuthorizationCodes,
  planVersions,
  plans,
  projectMilestones,
  projects,
  routineCompletions,
  routines,
  segmentEnergySettings,
  tags,
  taskTags,
  tasks,
  timeBlocks,
  tracks,
} from "@/lib/db/schema";

describe("schema shape", () => {
  it("keeps track on tasks, not plans", () => {
    expect(tasks.trackId).toBeDefined();
  });

  it("supports routine and recovery time blocks", () => {
    expect(timeBlocks.kind).toBeDefined();
  });

  it("supports inbox capture", () => {
    expect(inboxItems.title).toBeDefined();
  });

  it("supports track thresholds", () => {
    expect(tracks.targetMinPercent).toBeDefined();
    expect(tracks.targetMaxPercent).toBeDefined();
  });

  it("supports tags, capacity, segment energy, check-in tasks, and change logs", () => {
    expect(tags.name).toBeDefined();
    expect(taskTags.taskId).toBeDefined();
    expect(dayCapacities.morningMinutes).toBeDefined();
    expect(segmentEnergySettings.energyLevel).toBeDefined();
    expect(checkinTasks.status).toBeDefined();
    expect(changeLogs.source).toBeDefined();
  });

  it("supports structured projects, milestones, and overdue rollover metadata", () => {
    expect(projects.category).toBeDefined();
    expect(projects.objective).toBeDefined();
    expect(projects.successCriteria).toBeDefined();
    expect(projects.status).toBeDefined();
    expect(projects.priority).toBeDefined();
    expect(projects.startDate).toBeDefined();
    expect(projects.targetDate).toBeDefined();
    expect(projects.weeklyTargetMinutes).toBeDefined();
    expect(projects.needsDefinition).toBeDefined();
    expect(projectMilestones.projectId).toBeDefined();
    expect(tasks.milestoneId).toBeDefined();
    expect(tasks.originalDate).toBeDefined();
    expect(tasks.rolloverCount).toBeDefined();
    expect(tasks.lastRolloverAt).toBeDefined();

    const milestoneConfig = getTableConfig(projectMilestones);
    expect(milestoneConfig.indexes.map((candidate) => candidate.config.name)).toEqual(
      expect.arrayContaining([
        "project_milestones_workspace_project_position_idx",
        "project_milestones_workspace_status_target_idx",
      ]),
    );

    const taskConfig = getTableConfig(tasks);
    expect(taskConfig.indexes.map((candidate) => candidate.config.name)).toEqual(
      expect.arrayContaining([
        "tasks_workspace_project_idx",
        "tasks_workspace_milestone_idx",
        "tasks_overdue_candidate_idx",
      ]),
    );
    expect(taskConfig.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      "tasks_parent_task_id_tasks_id_fk",
    );
  });

  it("supports specific-window routines and one check-in per workspace day", () => {
    expect(routines.defaultTimeSegment).toBeDefined();
    expect(checkins.date).toBeDefined();
  });

  it("keeps check-ins unique by workspace and date for upsert conflict handling", () => {
    const config = getTableConfig(checkins);
    const index = config.indexes.find((candidate) => candidate.config.name === "checkins_workspace_id_date_unique");

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => "name" in column ? column.name : undefined)).toEqual([
      "workspace_id",
      "date",
    ]);
  });

  it("tracks agent runs by workspace idempotency key", () => {
    expect(agentRuns.kind).toBeDefined();
    expect(agentRuns.status).toBeDefined();
    expect(agentRuns.inputJson).toBeDefined();
    expect(agentRuns.resultJson).toBeDefined();
    expect(agentRuns.warningsJson).toBeDefined();
    expect(agentRuns.errorJson).toBeDefined();

    const config = getTableConfig(agentRuns);
    const index = config.indexes.find((candidate) => candidate.config.name === "agent_runs_workspace_idempotency_unique");

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => "name" in column ? column.name : undefined)).toEqual([
      "workspace_id",
      "idempotency_key",
    ]);
  });

  it("tracks atomic MCP task batches by workspace idempotency key", () => {
    const config = getTableConfig(mcpTaskWriteBatches);
    const index = config.indexes.find(
      (candidate) => candidate.config.name === "mcp_task_write_batches_workspace_key_unique",
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => "name" in column ? column.name : undefined)).toEqual([
      "workspace_id",
      "idempotency_key",
    ]);
  });

  it("keeps tenant-owned data tables scoped by workspace_id", () => {
    const tenantTables = [
      plans,
      planVersions,
      projects,
      projectMilestones,
      tracks,
      tags,
      taskTags,
      tasks,
      timeBlocks,
      routines,
      routineCompletions,
      dayCapacities,
      segmentEnergySettings,
      checkins,
      checkinTasks,
      inboxItems,
      agentRuns,
      changeLogs,
      mcpTokens,
      mcpUsageEvents,
      mcpTaskWriteBatches,
      mcpPlanImports,
      oauthAuthorizationCodes,
      claudeConnectorAuthorizations,
    ];

    expect(tenantTables.map((table) => getTableConfig(table).columns.some((column) => column.name === "workspace_id"))).toEqual(
      tenantTables.map(() => true),
    );
  });
});
