import { and, eq, inArray, or, sql } from "drizzle-orm";
import { consumeOperationApproval, createOperationApproval, verifyOperationApproval } from "@/lib/approvals/service";
import { changeLogs, planOperations, projectMilestones, projects } from "@/lib/db/schema";
import { resolveActivePlanContext } from "@/lib/planning/active-plan";
import {
  createProjectPortfolioPreviewToken,
  projectPortfolioHash,
  verifyProjectPortfolioPreviewToken,
} from "@/lib/mcp/project-portfolio-update-token";

type DbLike = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

type ProjectStatus = "active" | "paused" | "completed" | "archived";
type Priority = "low" | "normal" | "high" | "urgent";
type MilestoneStatus = "planned" | "in_progress" | "completed" | "skipped";

type ProjectFields = {
  name: string;
  color: string;
  category: string | null;
  objective: string | null;
  successCriteria: string | null;
  status: ProjectStatus;
  priority: Priority;
  startDate: string | null;
  targetDate: string | null;
  weeklyTargetMinutes: number | null;
};

type MilestoneFields = {
  title: string;
  objective: string | null;
  successCriteria: string | null;
  targetDate: string | null;
  status: MilestoneStatus;
  position: number;
};

export type ProjectPortfolioUpdate = {
  projects: Array<
    | ({ action: "create"; clientKey: string } & ProjectFields)
    | { action: "update"; projectId: string; expectedUpdatedAt: string; changes: Partial<ProjectFields> }
  >;
  milestones: Array<
    | {
        action: "create";
        clientKey: string;
        projectId?: string;
        projectClientKey?: string;
        title: string;
        objective: string | null;
        successCriteria: string | null;
        targetDate: string | null;
        status: MilestoneStatus;
        position: number;
      }
    | {
        action: "update";
        milestoneId: string;
        expectedUpdatedAt: string;
        changes: Partial<MilestoneFields>;
      }
  >;
};

type ProjectRow = typeof projects.$inferSelect;
type MilestoneRow = typeof projectMilestones.$inferSelect;

export class ProjectPortfolioUpdateError extends Error {
  constructor(
    public code:
      | "invalid_project_update"
      | "project_not_found"
      | "milestone_not_found"
      | "stale_project"
      | "stale_milestone"
      | "preview_required"
      | "preview_invalid"
      | "preview_expired"
      | "preview_stale"
      | "idempotency_payload_mismatch"
      | "operation_in_progress"
      | "operation_lease_lost",
    message: string,
    public status = 409,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function dateValue(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = new Date(`${value}T00:00:00.000+08:00`);
  if (Number.isNaN(parsed.getTime()) || dateKey(parsed) !== value) {
    throw new ProjectPortfolioUpdateError("invalid_project_update", `Invalid date: ${value}`, 400);
  }
  return parsed;
}

function dateKey(value: Date | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function projectSnapshot(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    category: row.category,
    objective: row.objective,
    successCriteria: row.successCriteria,
    status: row.status,
    priority: row.priority,
    startDate: dateKey(row.startDate),
    targetDate: dateKey(row.targetDate),
    weeklyTargetMinutes: row.weeklyTargetMinutes,
    needsDefinition: row.needsDefinition,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function milestoneSnapshot(row: MilestoneRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    objective: row.objective,
    successCriteria: row.successCriteria,
    targetDate: dateKey(row.targetDate),
    status: row.status,
    position: row.position,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requestPayload(update: ProjectPortfolioUpdate) {
  return {
    projects: update.projects,
    milestones: update.milestones,
  };
}

function ensureValidUpdate(update: ProjectPortfolioUpdate) {
  if (update.projects.length + update.milestones.length === 0) {
    throw new ProjectPortfolioUpdateError("invalid_project_update", "At least one Project or Milestone operation is required", 400);
  }
  const projectClientKeys = update.projects.flatMap((entry) => entry.action === "create" ? [entry.clientKey] : []);
  const milestoneClientKeys = update.milestones.flatMap((entry) => entry.action === "create" ? [entry.clientKey] : []);
  const projectUpdateIds = update.projects.flatMap((entry) => entry.action === "update" ? [entry.projectId] : []);
  const milestoneUpdateIds = update.milestones.flatMap((entry) => entry.action === "update" ? [entry.milestoneId] : []);
  if (new Set(projectClientKeys).size !== projectClientKeys.length || new Set(milestoneClientKeys).size !== milestoneClientKeys.length) {
    throw new ProjectPortfolioUpdateError("invalid_project_update", "Client keys must be unique within their type", 400);
  }
  if (new Set(projectUpdateIds).size !== projectUpdateIds.length || new Set(milestoneUpdateIds).size !== milestoneUpdateIds.length) {
    throw new ProjectPortfolioUpdateError("invalid_project_update", "Each existing Project or Milestone can be updated only once", 400);
  }
  const createdProjects = new Set(projectClientKeys);
  for (const milestone of update.milestones) {
    if (milestone.action !== "create") continue;
    if ((milestone.projectId ? 1 : 0) + (milestone.projectClientKey ? 1 : 0) !== 1) {
      throw new ProjectPortfolioUpdateError("invalid_project_update", "A new Milestone needs exactly one Project reference", 400);
    }
    if (milestone.projectClientKey && !createdProjects.has(milestone.projectClientKey)) {
      throw new ProjectPortfolioUpdateError("invalid_project_update", `Unknown Project client key: ${milestone.projectClientKey}`, 400);
    }
  }
}

function resultingProject(row: ProjectRow | null, operation: ProjectPortfolioUpdate["projects"][number]) {
  if (operation.action === "create") return operation;
  if (!row) throw new ProjectPortfolioUpdateError("project_not_found", `Project ${operation.projectId} was not found`, 404);
  return {
    ...projectSnapshot(row),
    ...operation.changes,
  };
}

function validateProjectDefinition(project: ReturnType<typeof resultingProject>) {
  if (project.status === "active" && (!project.name?.trim() || !project.category?.trim() || !project.objective?.trim() || !project.successCriteria?.trim())) {
    throw new ProjectPortfolioUpdateError(
      "invalid_project_update",
      "Active Projects require name, category, objective, and success criteria",
      400,
    );
  }
  const start = dateValue(project.startDate);
  const target = dateValue(project.targetDate);
  if (start && target && target < start) {
    throw new ProjectPortfolioUpdateError("invalid_project_update", "Project target date cannot be before start date", 400);
  }
}

async function loadState(db: Pick<DbLike, "select">, workspaceId: string, update: ProjectPortfolioUpdate, lock = false) {
  ensureValidUpdate(update);
  const projectIds = [...new Set([
    ...update.projects.flatMap((entry) => entry.action === "update" ? [entry.projectId] : []),
    ...update.milestones.flatMap((entry) => entry.action === "create" && entry.projectId ? [entry.projectId] : []),
  ])];
  const milestoneIds = [...new Set(update.milestones.flatMap((entry) => entry.action === "update" ? [entry.milestoneId] : []))];
  let projectQuery = projectIds.length
    ? db.select().from(projects).where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, projectIds))).orderBy(projects.id)
    : null;
  let milestoneQuery = milestoneIds.length
    ? db.select().from(projectMilestones).where(and(eq(projectMilestones.workspaceId, workspaceId), inArray(projectMilestones.id, milestoneIds))).orderBy(projectMilestones.id)
    : null;
  if (lock && projectQuery && typeof projectQuery.for === "function") projectQuery = projectQuery.for("update");
  const projectRows = projectQuery ? await projectQuery as ProjectRow[] : [];
  if (lock && milestoneQuery && typeof milestoneQuery.for === "function") milestoneQuery = milestoneQuery.for("update");
  const milestoneRows = milestoneQuery ? await milestoneQuery as MilestoneRow[] : [];
  const projectById = new Map(projectRows.map((row) => [row.id, row]));
  const milestoneById = new Map(milestoneRows.map((row) => [row.id, row]));

  for (const id of projectIds) {
    if (!projectById.has(id)) throw new ProjectPortfolioUpdateError("project_not_found", `Project ${id} was not found`, 404);
  }
  for (const id of milestoneIds) {
    if (!milestoneById.has(id)) throw new ProjectPortfolioUpdateError("milestone_not_found", `Milestone ${id} was not found`, 404);
  }
  for (const operation of update.projects) {
    if (operation.action === "update") {
      const row = projectById.get(operation.projectId)!;
      if (row.updatedAt.toISOString() !== operation.expectedUpdatedAt) {
        throw new ProjectPortfolioUpdateError("stale_project", `Project ${row.id} changed after it was read`, 409);
      }
      validateProjectDefinition(resultingProject(row, operation));
    } else {
      validateProjectDefinition(resultingProject(null, operation));
    }
  }
  for (const operation of update.milestones) {
    if (operation.action !== "update") continue;
    const row = milestoneById.get(operation.milestoneId)!;
    if (row.updatedAt.toISOString() !== operation.expectedUpdatedAt) {
      throw new ProjectPortfolioUpdateError("stale_milestone", `Milestone ${row.id} changed after it was read`, 409);
    }
  }
  const snapshot = {
    projects: projectRows.map(projectSnapshot),
    milestones: milestoneRows.map(milestoneSnapshot),
  };
  return { projectRows, milestoneRows, projectById, milestoneById, snapshotHash: projectPortfolioHash(snapshot) };
}

function projectChanged(row: ProjectRow, changes: Partial<ProjectFields>) {
  return Object.entries(changes).some(([key, value]) => {
    const current = projectSnapshot(row)[key as keyof ReturnType<typeof projectSnapshot>];
    return current !== value;
  });
}

function milestoneChanged(row: MilestoneRow, changes: Partial<MilestoneFields>) {
  return Object.entries(changes).some(([key, value]) => {
    const current = milestoneSnapshot(row)[key as keyof ReturnType<typeof milestoneSnapshot>];
    return current !== value;
  });
}

function previewItems(update: ProjectPortfolioUpdate) {
  return [
    ...update.projects.map((entry) => entry.action === "create"
      ? `新 Project ${entry.clientKey}：${entry.name}；category=${entry.category ?? "null"}；objective=${entry.objective ?? "null"}；successCriteria=${entry.successCriteria ?? "null"}；status=${entry.status}；priority=${entry.priority}；startDate=${entry.startDate ?? "null"}；targetDate=${entry.targetDate ?? "null"}；weeklyTargetMinutes=${entry.weeklyTargetMinutes ?? "null"}`
      : `更新 Project ${entry.projectId}（expected_updated_at=${entry.expectedUpdatedAt}）：${JSON.stringify(entry.changes)}`),
    ...update.milestones.map((entry) => entry.action === "create"
      ? `新 Milestone ${entry.clientKey}：${entry.title}；project=${entry.projectId ?? entry.projectClientKey}；objective=${entry.objective ?? "null"}；successCriteria=${entry.successCriteria ?? "null"}；targetDate=${entry.targetDate ?? "null"}；status=${entry.status}；position=${entry.position}`
      : `更新 Milestone ${entry.milestoneId}（expected_updated_at=${entry.expectedUpdatedAt}）：${JSON.stringify(entry.changes)}`),
  ];
}

export async function proposeProjectPortfolioUpdate(
  db: DbLike,
  input: { workspaceId: string; update: ProjectPortfolioUpdate; reason?: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const plan = await resolveActivePlanContext(db, input.workspaceId);
  const state = await loadState(db, input.workspaceId, input.update);
  const requestHash = projectPortfolioHash(requestPayload(input.update));
  const token = createProjectPortfolioPreviewToken({
    workspaceId: input.workspaceId,
    planId: plan.id,
    requestHash,
    snapshotHash: state.snapshotHash,
    now,
  });
  const approval = await createOperationApproval(db, {
    workspaceId: input.workspaceId,
    operationKind: "project_portfolio_update",
    requestHash,
    previewToken: token.token,
    expiresAt: new Date(token.payload.expiresAt),
    summary: {
      title: "AI 提议更新 Project Portfolio",
      description: input.reason ?? "创建或更新 Project 与 Milestone；不会关联或移动任务。",
      count: input.update.projects.length + input.update.milestones.length,
      items: previewItems(input.update),
    },
  });
  return {
    status: "pending_review" as const,
    planId: plan.id,
    requestHash,
    previewToken: token.token,
    approvalId: approval.id,
    expiresAt: token.payload.expiresAt,
    proposed: {
      projectOperations: input.update.projects.length,
      milestoneOperations: input.update.milestones.length,
      items: previewItems(input.update),
      exactUpdate: input.update,
    },
    liveUnchanged: true,
  };
}

async function claimOperation(db: DbLike, input: {
  workspaceId: string;
  planId: string;
  idempotencyKey: string;
  requestHash: string;
  now: Date;
}) {
  return db.transaction(async (tx) => {
    const leaseExpiresAt = new Date(input.now.getTime() + 5 * 60 * 1000);
    const [created] = await tx.insert(planOperations).values({
      workspaceId: input.workspaceId,
      planId: input.planId,
      operationKind: "project_portfolio_update",
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      status: "started",
      resultJson: {},
      leaseExpiresAt,
    }).onConflictDoNothing({ target: [planOperations.workspaceId, planOperations.idempotencyKey] }).returning();
    if (created) return { duplicate: false as const, operation: created, leaseExpiresAt };
    const [existing] = await tx.select().from(planOperations).where(and(
      eq(planOperations.workspaceId, input.workspaceId),
      eq(planOperations.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (!existing || existing.operationKind !== "project_portfolio_update" || existing.requestHash !== input.requestHash) {
      throw new ProjectPortfolioUpdateError("idempotency_payload_mismatch", "Idempotency key was used with a different Project update", 409);
    }
    if (existing.status !== "started") return { duplicate: true as const, operation: existing };
    if (existing.leaseExpiresAt && existing.leaseExpiresAt > input.now) {
      throw new ProjectPortfolioUpdateError("operation_in_progress", "Project update is already in progress", 409);
    }
    const [reclaimed] = await tx.update(planOperations).set({ leaseExpiresAt, updatedAt: input.now }).where(and(
      eq(planOperations.id, existing.id),
      eq(planOperations.workspaceId, input.workspaceId),
      eq(planOperations.status, "started"),
      or(sql`${planOperations.leaseExpiresAt} IS NULL`, sql`${planOperations.leaseExpiresAt} <= ${input.now}`),
    )).returning();
    if (!reclaimed) throw new ProjectPortfolioUpdateError("operation_in_progress", "Project update is already in progress", 409);
    return { duplicate: false as const, operation: reclaimed, leaseExpiresAt };
  });
}

async function findOperation(db: Pick<DbLike, "select">, workspaceId: string, idempotencyKey: string) {
  const [row] = await db.select().from(planOperations).where(and(
    eq(planOperations.workspaceId, workspaceId),
    eq(planOperations.idempotencyKey, idempotencyKey),
  )).limit(1);
  return row as typeof planOperations.$inferSelect | undefined;
}

async function readback(db: Pick<DbLike, "select">, workspaceId: string, projectIds: string[], milestoneIds: string[]) {
  const projectRows = projectIds.length
    ? await db.select().from(projects).where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, projectIds))).orderBy(projects.id)
    : [];
  const milestoneRows = milestoneIds.length
    ? await db.select().from(projectMilestones).where(and(eq(projectMilestones.workspaceId, workspaceId), inArray(projectMilestones.id, milestoneIds))).orderBy(projectMilestones.id)
    : [];
  return {
    verification: "succeeded" as const,
    projects: (projectRows as ProjectRow[]).map(projectSnapshot),
    milestones: (milestoneRows as MilestoneRow[]).map(milestoneSnapshot),
  };
}

function duplicateResult(operation: typeof planOperations.$inferSelect) {
  const stored = operation.resultJson as Record<string, unknown>;
  return { ...stored, status: "duplicate" as const, originalStatus: operation.status, operationId: operation.id };
}

function sameInstant(left: Date | null | undefined, right: Date) {
  return Boolean(left && new Date(left).getTime() === right.getTime());
}

async function verifyOperationLease(tx: any, input: {
  workspaceId: string;
  operationId: string;
  requestHash: string;
  leaseExpiresAt: Date;
  now: Date;
}) {
  const [operation] = await tx.select().from(planOperations).where(and(
    eq(planOperations.id, input.operationId),
    eq(planOperations.workspaceId, input.workspaceId),
  )).limit(1).for("update");
  if (
    !operation ||
    operation.requestHash !== input.requestHash ||
    operation.status !== "started" ||
    !sameInstant(operation.leaseExpiresAt, input.leaseExpiresAt) ||
    input.leaseExpiresAt <= input.now
  ) {
    throw new ProjectPortfolioUpdateError(
      "operation_lease_lost",
      "Project update no longer owns its write lease",
      409,
      { operationId: input.operationId, retryable: true },
    );
  }
}

async function markFailed(db: DbLike, workspaceId: string, operationId: string, leaseExpiresAt: Date, error: unknown) {
  const errorJson = {
    code: error instanceof ProjectPortfolioUpdateError ? error.code : "project_portfolio_update_failed",
    message: error instanceof Error ? error.message : "Project portfolio update failed",
  };
  try {
    await db.transaction(async (tx) => {
      const [operation] = await tx.select().from(planOperations).where(and(
        eq(planOperations.id, operationId),
        eq(planOperations.workspaceId, workspaceId),
      )).limit(1).for("update");
      if (!operation || operation.status !== "started" || !sameInstant(operation.leaseExpiresAt, leaseExpiresAt)) return;
      await tx.update(planOperations).set({
        status: "failed",
        resultJson: { status: "failed", operationId, error: errorJson },
        errorJson,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(planOperations.id, operationId),
        eq(planOperations.workspaceId, workspaceId),
        eq(planOperations.status, "started"),
        eq(planOperations.leaseExpiresAt, leaseExpiresAt),
      )).returning({ id: planOperations.id });
    });
  } catch {
    // Preserve the original operation error; failure recording is best effort.
  }
}

export async function applyProjectPortfolioUpdate(db: DbLike, input: {
  workspaceId: string;
  update: ProjectPortfolioUpdate;
  previewToken: string | undefined;
  approvalId: string | undefined;
  idempotencyKey: string;
  source?: "manual" | "mcp";
  now?: Date;
}) {
  if (input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 200) {
    throw new ProjectPortfolioUpdateError("invalid_project_update", "Invalid idempotency key", 400);
  }
  ensureValidUpdate(input.update);
  const now = input.now ?? new Date();
  const requestHash = projectPortfolioHash(requestPayload(input.update));
  const verified = verifyProjectPortfolioPreviewToken({
    token: input.previewToken,
    workspaceId: input.workspaceId,
    requestHash,
    now,
  });
  if (!verified.ok) throw new ProjectPortfolioUpdateError(verified.code, verified.reason, 409);
  const existing = await findOperation(db, input.workspaceId, input.idempotencyKey);
  if (existing) {
    if (existing.operationKind !== "project_portfolio_update" || existing.requestHash !== requestHash) {
      throw new ProjectPortfolioUpdateError("idempotency_payload_mismatch", "Idempotency key was used with a different Project update", 409);
    }
    if (existing.status !== "started") return duplicateResult(existing);
  }
  const activePlan = await resolveActivePlanContext(db, input.workspaceId);
  if (activePlan.id !== verified.payload.planId) {
    throw new ProjectPortfolioUpdateError("preview_stale", "Active plan changed after Preview", 409);
  }
  const previewState = await loadState(db, input.workspaceId, input.update);
  if (previewState.snapshotHash !== verified.payload.snapshotHash) {
    throw new ProjectPortfolioUpdateError("preview_stale", "Project Portfolio changed after Preview", 409);
  }
  await verifyOperationApproval(db, {
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    operationKind: "project_portfolio_update",
    requestHash,
    previewToken: input.previewToken!,
    now,
  });
  const claim = await claimOperation(db, {
    workspaceId: input.workspaceId,
    planId: verified.payload.planId,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    now,
  });
  if (claim.duplicate) return duplicateResult(claim.operation);

  let committed: Record<string, any>;
  try {
    committed = await db.transaction(async (tx) => {
      const plan = await resolveActivePlanContext(tx, input.workspaceId, { lock: true });
      if (plan.id !== verified.payload.planId) throw new ProjectPortfolioUpdateError("preview_stale", "Active plan changed after Preview", 409);
      await verifyOperationLease(tx, {
        workspaceId: input.workspaceId,
        operationId: claim.operation.id,
        requestHash,
        leaseExpiresAt: claim.leaseExpiresAt,
        now,
      });
      const state = await loadState(tx, input.workspaceId, input.update, true);
      if (state.snapshotHash !== verified.payload.snapshotHash) {
        throw new ProjectPortfolioUpdateError("preview_stale", "Project Portfolio changed after Preview", 409);
      }
      await consumeOperationApproval(tx, {
        workspaceId: input.workspaceId,
        approvalId: input.approvalId,
        operationKind: "project_portfolio_update",
        requestHash,
        previewToken: input.previewToken!,
        now,
      });

      const projectClientIds = new Map<string, string>();
      const createdProjectIds: string[] = [];
      const updatedProjectIds: string[] = [];
      const unchangedProjectIds: string[] = [];
      for (const operation of input.update.projects) {
        if (operation.action === "create") {
          const [created] = await tx.insert(projects).values({
            workspaceId: input.workspaceId,
            name: operation.name,
            color: operation.color,
            category: operation.category,
            objective: operation.objective,
            successCriteria: operation.successCriteria,
            status: operation.status,
            priority: operation.priority,
            startDate: dateValue(operation.startDate),
            targetDate: dateValue(operation.targetDate),
            weeklyTargetMinutes: operation.weeklyTargetMinutes,
            needsDefinition: !operation.category || !operation.objective || !operation.successCriteria,
            updatedAt: now,
          }).returning();
          projectClientIds.set(operation.clientKey, created.id);
          createdProjectIds.push(created.id);
        } else {
          const row = state.projectById.get(operation.projectId)!;
          if (!projectChanged(row, operation.changes)) {
            unchangedProjectIds.push(operation.projectId);
            continue;
          }
          const values = { ...operation.changes } as Record<string, unknown>;
          if ("startDate" in values) values.startDate = dateValue(values.startDate as string | null);
          if ("targetDate" in values) values.targetDate = dateValue(values.targetDate as string | null);
          const resulting = resultingProject(row, operation);
          values.needsDefinition = !resulting.category || !resulting.objective || !resulting.successCriteria;
          values.updatedAt = now;
          // loadState locked this row and compared the caller-visible millisecond timestamp.
          // PostgreSQL can retain sub-millisecond precision that Date/ISO readback cannot,
          // so repeating the comparison as exact SQL timestamp equality rejects valid writes.
          const updated = await tx.update(projects).set(values).where(and(
            eq(projects.id, operation.projectId),
            eq(projects.workspaceId, input.workspaceId),
          )).returning({ id: projects.id });
          if (updated.length !== 1) throw new ProjectPortfolioUpdateError("stale_project", `Project ${operation.projectId} changed before write`, 409);
          updatedProjectIds.push(operation.projectId);
        }
      }

      const createdMilestoneIds: string[] = [];
      const updatedMilestoneIds: string[] = [];
      const unchangedMilestoneIds: string[] = [];
      const milestoneClientIds = new Map<string, string>();
      for (const operation of input.update.milestones) {
        if (operation.action === "create") {
          const projectId = operation.projectId ?? projectClientIds.get(operation.projectClientKey!);
          if (!projectId) throw new ProjectPortfolioUpdateError("invalid_project_update", "Milestone Project reference was not resolved", 409);
          const [created] = await tx.insert(projectMilestones).values({
            workspaceId: input.workspaceId,
            projectId,
            title: operation.title,
            objective: operation.objective,
            successCriteria: operation.successCriteria,
            targetDate: dateValue(operation.targetDate),
            status: operation.status,
            position: operation.position,
            updatedAt: now,
          }).returning();
          createdMilestoneIds.push(created.id);
          milestoneClientIds.set(operation.clientKey, created.id);
        } else {
          const row = state.milestoneById.get(operation.milestoneId)!;
          if (!milestoneChanged(row, operation.changes)) {
            unchangedMilestoneIds.push(operation.milestoneId);
            continue;
          }
          const values = { ...operation.changes } as Record<string, unknown>;
          if ("targetDate" in values) values.targetDate = dateValue(values.targetDate as string | null);
          values.updatedAt = now;
          const updated = await tx.update(projectMilestones).set(values).where(and(
            eq(projectMilestones.id, operation.milestoneId),
            eq(projectMilestones.workspaceId, input.workspaceId),
          )).returning({ id: projectMilestones.id });
          if (updated.length !== 1) throw new ProjectPortfolioUpdateError("stale_milestone", `Milestone ${operation.milestoneId} changed before write`, 409);
          updatedMilestoneIds.push(operation.milestoneId);
        }
      }

      const changedProjectIds = [...createdProjectIds, ...updatedProjectIds];
      const changedMilestoneIds = [...createdMilestoneIds, ...updatedMilestoneIds];
      const readbackProjectIds = [...changedProjectIds, ...unchangedProjectIds];
      const readbackMilestoneIds = [...changedMilestoneIds, ...unchangedMilestoneIds];
      const status = changedProjectIds.length + changedMilestoneIds.length === 0 ? "no_change" as const : "succeeded" as const;
      const transactionReadback = await readback(tx, input.workspaceId, readbackProjectIds, readbackMilestoneIds);
      const result = {
        status,
        operationId: claim.operation.id,
        planId: plan.id,
        createdProjectIds,
        updatedProjectIds,
        unchangedProjectIds,
        createdMilestoneIds,
        updatedMilestoneIds,
        unchangedMilestoneIds,
        projectClientIds: Object.fromEntries(projectClientIds),
        milestoneClientIds: Object.fromEntries(milestoneClientIds),
        transactionReadback,
      };
      await tx.insert(changeLogs).values({
        workspaceId: input.workspaceId,
        planId: plan.id,
        source: input.source ?? "mcp",
        summary: status === "no_change" ? "Project Portfolio unchanged" : "Updated Project Portfolio",
        detailsJson: { ...result, requestHash },
      });
      const finalized = await tx.update(planOperations).set({
        status,
        resultJson: result,
        errorJson: null,
        leaseExpiresAt: null,
        updatedAt: now,
      }).where(and(
        eq(planOperations.id, claim.operation.id),
        eq(planOperations.workspaceId, input.workspaceId),
        eq(planOperations.status, "started"),
        eq(planOperations.leaseExpiresAt, claim.leaseExpiresAt),
      )).returning({ id: planOperations.id });
      if (finalized.length !== 1) {
        throw new ProjectPortfolioUpdateError(
          "operation_lease_lost",
          "Project update lost its write lease before commit",
          409,
          { operationId: claim.operation.id, retryable: true },
        );
      }
      return result;
    });
  } catch (error) {
    await markFailed(db, input.workspaceId, claim.operation.id, claim.leaseExpiresAt, error);
    throw error;
  }

  try {
    const finalReadback = await readback(db, input.workspaceId, [
      ...committed.createdProjectIds,
      ...committed.updatedProjectIds,
      ...committed.unchangedProjectIds,
    ], [
      ...committed.createdMilestoneIds,
      ...committed.updatedMilestoneIds,
      ...committed.unchangedMilestoneIds,
    ]);
    const result = { ...committed, readback: finalReadback };
    await db.update(planOperations).set({ resultJson: result, updatedAt: new Date() }).where(and(
      eq(planOperations.id, committed.operationId),
      eq(planOperations.workspaceId, input.workspaceId),
    ));
    return result;
  } catch (error) {
    const result = {
      ...committed,
      readback: {
        verification: "failed" as const,
        error: { code: "readback_failed", message: error instanceof Error ? error.message : "Project readback failed" },
      },
      warnings: [{ code: "readback_failed", mutationApplied: committed.status === "succeeded" }],
    };
    await db.update(planOperations).set({ resultJson: result, updatedAt: new Date() }).where(and(
      eq(planOperations.id, committed.operationId),
      eq(planOperations.workspaceId, input.workspaceId),
    )).catch(() => undefined);
    return result;
  }
}
