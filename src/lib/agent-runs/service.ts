import { and, desc, eq } from "drizzle-orm";
import { agentRuns } from "@/lib/db/schema";
import type {
  AgentRunCreatedBy,
  AgentRunError,
  AgentRunKind,
  AgentRunResult,
  AgentRunStatus,
  AgentRunWarning,
} from "@/lib/agent-runs/types";

export type PlanningDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

type AgentRunRow = {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  patchId: string | null;
  reason: string;
  idempotencyKey: string;
  resultJson: unknown;
  warningsJson: unknown;
  errorJson: unknown;
  createdAt: Date;
};

type StartAgentRunInput = {
  workspaceId: string;
  planId: string | null;
  kind: AgentRunKind;
  idempotencyKey: string;
  reason: string;
  inputJson: unknown;
  createdBy: AgentRunCreatedBy;
};

type CompleteAgentRunInput = {
  workspaceId: string;
  runId: string;
  idempotencyKey: string;
  status: "draft_created" | "needs_decision" | "no_change";
  patchId?: string;
  operationCount: number;
  skipped: AgentRunWarning[];
  warnings: AgentRunWarning[];
  needsDecision?: AgentRunWarning[];
};

type FailAgentRunInput = {
  workspaceId: string;
  runId: string;
  idempotencyKey: string;
  error: AgentRunError;
  warnings?: AgentRunWarning[];
};

type LatestAgentRunsInput = {
  workspaceId: string;
  limit?: number;
};

function compactError(error: AgentRunError): AgentRunError {
  return { code: error.code, message: error.message };
}

function asWarningArray(value: unknown): AgentRunWarning[] {
  return Array.isArray(value) ? (value as AgentRunWarning[]) : [];
}

function operationCountFrom(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  const count = (value as { operationCount?: unknown }).operationCount;
  return typeof count === "number" ? count : 0;
}

function skippedFrom(value: unknown) {
  if (!value || typeof value !== "object") return [];
  return asWarningArray((value as { skipped?: unknown }).skipped);
}

function needsDecisionFrom(value: unknown) {
  if (!value || typeof value !== "object") return [];
  return asWarningArray((value as { needsDecision?: unknown }).needsDecision);
}

function sanitizeInputJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (value instanceof Map) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const entries = Array.from(value.entries()).map(([key, entry]) => [
      sanitizeInputJson(key, seen),
      typeof key === "string" && isSensitiveInputKey(key) ? "[redacted]" : sanitizeInputJson(entry, seen),
    ]);
    seen.delete(value);
    return entries;
  }
  if (value instanceof Set) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const entries = Array.from(value.values()).map((entry) => sanitizeInputJson(entry, seen));
    seen.delete(value);
    return entries;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const entries = value.map((entry) => sanitizeInputJson(entry, seen));
    seen.delete(value);
    return entries;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 && !isPlainObject(value)) {
    seen.delete(value);
    return String(value);
  }

  const output = Object.fromEntries(
    entries.map(([key, entry]) => [
      key,
      isSensitiveInputKey(key) ? "[redacted]" : sanitizeInputJson(entry, seen),
    ]),
  );
  seen.delete(value);
  return output;
}

function isPlainObject(value: object) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSensitiveInputKey(key: string) {
  const normalized = key.toLowerCase();
  return normalized === "authorization" || normalized.includes("prompt") || normalized.includes("token");
}

async function findByIdempotencyKey(db: PlanningDb, workspaceId: string, idempotencyKey: string) {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.idempotencyKey, idempotencyKey)))
    .limit(1);

  return (rows as AgentRunRow[])[0] ?? null;
}

async function findByRunKey(db: PlanningDb, workspaceId: string, runId: string, idempotencyKey: string) {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        eq(agentRuns.id, runId),
        eq(agentRuns.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  return (rows as AgentRunRow[])[0] ?? null;
}

function duplicateResult(row: AgentRunRow): AgentRunResult {
  const result: AgentRunResult = {
    runId: row.id,
    status: "duplicate",
    reviewUrl: "/review",
    operationCount: operationCountFrom(row.resultJson),
    skipped: skippedFrom(row.resultJson),
    warnings: asWarningArray(row.warningsJson),
    idempotencyKey: row.idempotencyKey,
  };
  if (row.patchId) result.patchId = row.patchId;
  const needsDecision = needsDecisionFrom(row.resultJson);
  if (needsDecision.length > 0) result.needsDecision = needsDecision;
  if (row.errorJson && typeof row.errorJson === "object") {
    result.error = compactError(row.errorJson as AgentRunError);
  }
  return result;
}

function resultFromExistingRun(row: AgentRunRow): AgentRunResult {
  const result: AgentRunResult = {
    runId: row.id,
    status: row.status,
    reviewUrl: "/review",
    operationCount: operationCountFrom(row.resultJson),
    skipped: skippedFrom(row.resultJson),
    warnings: asWarningArray(row.warningsJson),
    idempotencyKey: row.idempotencyKey,
  };
  if (row.patchId) result.patchId = row.patchId;
  const needsDecision = needsDecisionFrom(row.resultJson);
  if (needsDecision.length > 0) result.needsDecision = needsDecision;
  if (row.errorJson && typeof row.errorJson === "object") {
    result.error = compactError(row.errorJson as AgentRunError);
  }
  return result;
}

function isTerminalStatus(status: AgentRunStatus) {
  return status === "draft_created" || status === "needs_decision" || status === "no_change" || status === "failed";
}

async function returnExistingTerminalOrThrow(
  db: PlanningDb,
  input: { workspaceId: string; runId: string; idempotencyKey: string },
) {
  const existing = await findByRunKey(db, input.workspaceId, input.runId, input.idempotencyKey);
  if (existing && isTerminalStatus(existing.status)) return resultFromExistingRun(existing);
  throw new Error("Agent run not found");
}

function isUniqueConflict(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      ((error as { code?: unknown }).code === "23505" ||
        (error as { constraint?: unknown }).constraint === "agent_runs_workspace_idempotency_unique"),
  );
}

export async function startAgentRun(
  db: PlanningDb,
  input: StartAgentRunInput,
): Promise<{ duplicate: false; runId: string } | { duplicate: true; result: AgentRunResult }> {
  const existing = await findByIdempotencyKey(db, input.workspaceId, input.idempotencyKey);
  if (existing) return { duplicate: true, result: duplicateResult(existing) };

  try {
    const [run] = await db
      .insert(agentRuns)
      .values({
        workspaceId: input.workspaceId,
        planId: input.planId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        status: "started",
        reason: input.reason,
        inputJson: sanitizeInputJson(input.inputJson),
        resultJson: {
          status: "started",
          reviewUrl: "/review",
          operationCount: 0,
          skipped: [],
          warnings: [],
          idempotencyKey: input.idempotencyKey,
        },
        warningsJson: [],
        createdBy: input.createdBy,
      })
      .returning();

    return { duplicate: false, runId: run.id };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const duplicate = await findByIdempotencyKey(db, input.workspaceId, input.idempotencyKey);
    if (!duplicate) throw error;
    return { duplicate: true, result: duplicateResult(duplicate) };
  }
}

export async function completeAgentRun(db: PlanningDb, input: CompleteAgentRunInput): Promise<AgentRunResult> {
  const result: AgentRunResult = {
    runId: input.runId,
    status: input.status,
    reviewUrl: "/review",
    operationCount: input.operationCount,
    skipped: input.skipped,
    warnings: input.warnings,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.patchId) result.patchId = input.patchId;
  if (input.needsDecision && input.needsDecision.length > 0) result.needsDecision = input.needsDecision;

  const [run] = await db
    .update(agentRuns)
    .set({
      status: input.status,
      patchId: input.patchId ?? null,
      resultJson: result,
      warningsJson: input.warnings,
      errorJson: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.workspaceId, input.workspaceId),
        eq(agentRuns.idempotencyKey, input.idempotencyKey),
        eq(agentRuns.status, "started"),
      ),
    )
    .returning();

  if (!run) return returnExistingTerminalOrThrow(db, input);
  return result;
}

export async function failAgentRun(db: PlanningDb, input: FailAgentRunInput): Promise<AgentRunResult> {
  const error = compactError(input.error);
  const warnings = input.warnings ?? [];
  const result: AgentRunResult = {
    runId: input.runId,
    status: "failed",
    reviewUrl: "/review",
    operationCount: 0,
    skipped: [],
    warnings,
    idempotencyKey: input.idempotencyKey,
    error,
  };

  const [run] = await db
    .update(agentRuns)
    .set({
      status: "failed",
      resultJson: result,
      warningsJson: warnings,
      errorJson: error,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.workspaceId, input.workspaceId),
        eq(agentRuns.idempotencyKey, input.idempotencyKey),
        eq(agentRuns.status, "started"),
      ),
    )
    .returning();

  if (!run) return returnExistingTerminalOrThrow(db, input);
  return result;
}

export async function getLatestAgentRuns(
  db: PlanningDb,
  input: LatestAgentRunsInput,
): Promise<
  Array<{
    id: string;
    kind: AgentRunKind;
    status: AgentRunStatus;
    patchId: string | null;
    reason: string;
    createdAt: Date;
    errorJson: unknown;
    warningsJson: unknown;
  }>
> {
  const rows = await db
    .select({
      id: agentRuns.id,
      kind: agentRuns.kind,
      status: agentRuns.status,
      patchId: agentRuns.patchId,
      reason: agentRuns.reason,
      createdAt: agentRuns.createdAt,
      errorJson: agentRuns.errorJson,
      warningsJson: agentRuns.warningsJson,
    })
    .from(agentRuns)
    .where(eq(agentRuns.workspaceId, input.workspaceId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(input.limit ?? 10);

  return rows as Array<{
    id: string;
    kind: AgentRunKind;
    status: AgentRunStatus;
    patchId: string | null;
    reason: string;
    createdAt: Date;
    errorJson: unknown;
    warningsJson: unknown;
  }>;
}
