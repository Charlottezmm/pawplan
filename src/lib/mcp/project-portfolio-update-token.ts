import { createHmac, timingSafeEqual } from "node:crypto";
import { timeBlockSeriesHash } from "@/lib/constraints/time-block-series-token";

const tokenTtlMs = 30 * 60 * 1000;

function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error("APP_SECRET is required");
  return secret;
}

function sign(payload: string) {
  return createHmac("sha256", appSecret()).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export type ProjectPortfolioPreviewTokenPayload = {
  version: 1;
  kind: "project_portfolio_update";
  workspaceId: string;
  planId: string;
  requestHash: string;
  snapshotHash: string;
  expiresAt: string;
};

export function projectPortfolioHash(value: unknown) {
  return timeBlockSeriesHash(value);
}

export function createProjectPortfolioPreviewToken(input: {
  workspaceId: string;
  planId: string;
  requestHash: string;
  snapshotHash: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const body: ProjectPortfolioPreviewTokenPayload = {
    version: 1,
    kind: "project_portfolio_update",
    workspaceId: input.workspaceId,
    planId: input.planId,
    requestHash: input.requestHash,
    snapshotHash: input.snapshotHash,
    expiresAt: new Date(now.getTime() + tokenTtlMs).toISOString(),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, payload: body };
}

export function verifyProjectPortfolioPreviewToken(input: {
  token: string | undefined;
  workspaceId: string;
  requestHash: string;
  now?: Date;
}):
  | { ok: true; payload: ProjectPortfolioPreviewTokenPayload }
  | { ok: false; code: "preview_required" | "preview_invalid" | "preview_expired"; reason: string } {
  if (!input.token) return { ok: false, code: "preview_required", reason: "Project portfolio Preview token required" };
  const [payload, suppliedSignature] = input.token.split(".");
  if (!payload || !suppliedSignature || !safeEqual(suppliedSignature, sign(payload))) {
    return { ok: false, code: "preview_invalid", reason: "Invalid Project portfolio Preview token" };
  }
  let body: ProjectPortfolioPreviewTokenPayload;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ProjectPortfolioPreviewTokenPayload;
  } catch {
    return { ok: false, code: "preview_invalid", reason: "Invalid Project portfolio Preview token" };
  }
  if (
    body.version !== 1 ||
    body.kind !== "project_portfolio_update" ||
    body.workspaceId !== input.workspaceId ||
    body.requestHash !== input.requestHash ||
    typeof body.planId !== "string" ||
    typeof body.snapshotHash !== "string" ||
    typeof body.expiresAt !== "string"
  ) {
    return { ok: false, code: "preview_invalid", reason: "Project portfolio Preview token does not match this update" };
  }
  const expiresAt = new Date(body.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= (input.now ?? new Date())) {
    return { ok: false, code: "preview_expired", reason: "Project portfolio Preview token expired" };
  }
  return { ok: true, payload: body };
}
