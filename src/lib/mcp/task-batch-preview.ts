import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TaskBatchAction = "archive" | "restore" | "delete";

export type TaskBatchFingerprintRow = {
  id: string;
  planId: string;
  title: string;
  status: string;
  date: Date | string;
  projectId: string | null;
  milestoneId: string | null;
  parentTaskId: string | null;
  estimatedMinutes: number;
  archivedAt: Date | string | null;
  updatedAt: Date | string;
};

export type TaskBatchPreviewPayload = {
  version: 1;
  action: TaskBatchAction;
  workspaceId: string;
  planId: string;
  taskIds: string[];
  selectionHash: string;
  filtersHash: string;
  count: number;
  expiresAt: string;
};

const tokenTtlMs = 30 * 60 * 1000;

function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error("APP_SECRET is required");
  return secret;
}

function iso(value: Date | string | null) {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function canonicalRows(rows: TaskBatchFingerprintRow[]) {
  return [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => ({
      id: row.id,
      planId: row.planId,
      title: row.title,
      status: row.status,
      date: iso(row.date),
      projectId: row.projectId,
      milestoneId: row.milestoneId,
      parentTaskId: row.parentTaskId,
      estimatedMinutes: row.estimatedMinutes,
      archivedAt: iso(row.archivedAt),
      updatedAt: iso(row.updatedAt),
    }));
}

export function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function taskSelectionHash(rows: TaskBatchFingerprintRow[]) {
  return stableHash(canonicalRows(rows));
}

function sign(payload: string) {
  return createHmac("sha256", appSecret()).update(payload).digest("base64url");
}

function signaturesMatch(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createTaskBatchPreviewToken(input: {
  action: TaskBatchAction;
  workspaceId: string;
  planId: string;
  rows: TaskBatchFingerprintRow[];
  filters: unknown;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const taskIds = [...input.rows.map((row) => row.id)].sort();
  const body: TaskBatchPreviewPayload = {
    version: 1,
    action: input.action,
    workspaceId: input.workspaceId,
    planId: input.planId,
    taskIds,
    selectionHash: taskSelectionHash(input.rows),
    filtersHash: stableHash(input.filters),
    count: taskIds.length,
    expiresAt: new Date(now.getTime() + tokenTtlMs).toISOString(),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, payload: body };
}

export function verifyTaskBatchPreviewToken(input: {
  token: string | undefined;
  action: TaskBatchAction;
  workspaceId: string;
  now?: Date;
}):
  | { ok: true; payload: TaskBatchPreviewPayload }
  | { ok: false; code: "preview_required" | "preview_invalid" | "preview_expired"; reason: string } {
  if (!input.token) return { ok: false, code: "preview_required", reason: "Task batch preview token required" };
  const [payload, signature] = input.token.split(".");
  if (!payload || !signature || !signaturesMatch(signature, sign(payload))) {
    return { ok: false, code: "preview_invalid", reason: "Invalid task batch preview token" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, code: "preview_invalid", reason: "Invalid task batch preview token" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, code: "preview_invalid", reason: "Invalid task batch preview token" };
  }
  const body = parsed as Partial<TaskBatchPreviewPayload>;
  if (
    body.version !== 1 ||
    body.action !== input.action ||
    body.workspaceId !== input.workspaceId ||
    typeof body.planId !== "string" ||
    !Array.isArray(body.taskIds) ||
    body.taskIds.some((id) => typeof id !== "string") ||
    new Set(body.taskIds).size !== body.taskIds.length ||
    typeof body.selectionHash !== "string" ||
    typeof body.filtersHash !== "string" ||
    !Number.isInteger(body.count) ||
    body.count !== body.taskIds.length ||
    typeof body.expiresAt !== "string"
  ) {
    return { ok: false, code: "preview_invalid", reason: "Task batch preview token does not match this operation" };
  }

  const expiresAt = new Date(body.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= (input.now ?? new Date())) {
    return { ok: false, code: "preview_expired", reason: "Task batch preview token expired" };
  }

  return { ok: true, payload: body as TaskBatchPreviewPayload };
}
