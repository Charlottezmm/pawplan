import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const tokenTtlMs = 30 * 60 * 1000;

function appSecret() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error("APP_SECRET is required");
  return secret;
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function timeBlockSeriesHash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function signature(payload: string) {
  return createHmac("sha256", appSecret()).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export type TimeBlockSeriesPreviewTokenPayload = {
  kind: "time_block_series";
  workspaceId: string;
  action: "update" | "delete";
  requestHash: string;
  snapshotHash: string;
  expiresAt: string;
};

export function createTimeBlockSeriesPreviewToken(input: {
  workspaceId: string;
  action: "update" | "delete";
  requestHash: string;
  snapshotHash: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const body: TimeBlockSeriesPreviewTokenPayload = {
    kind: "time_block_series",
    workspaceId: input.workspaceId,
    action: input.action,
    requestHash: input.requestHash,
    snapshotHash: input.snapshotHash,
    expiresAt: new Date(now.getTime() + tokenTtlMs).toISOString(),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function verifyTimeBlockSeriesPreviewToken(input: {
  token: string | undefined;
  workspaceId: string;
  action: "update" | "delete";
  requestHash: string;
  now?: Date;
}) {
  if (!input.token) return { ok: false as const, reason: "Time block preview token required" };
  const [payload, suppliedSignature] = input.token.split(".");
  if (!payload || !suppliedSignature || !safeEqual(suppliedSignature, signature(payload))) {
    return { ok: false as const, reason: "Invalid time block preview token" };
  }

  let body: TimeBlockSeriesPreviewTokenPayload;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TimeBlockSeriesPreviewTokenPayload;
  } catch {
    return { ok: false as const, reason: "Invalid time block preview token" };
  }

  if (
    body.kind !== "time_block_series" ||
    body.workspaceId !== input.workspaceId ||
    body.action !== input.action ||
    body.requestHash !== input.requestHash
  ) {
    return { ok: false as const, reason: "Time block preview token does not match this request" };
  }
  const expiresAt = new Date(body.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= (input.now ?? new Date())) {
    return { ok: false as const, reason: "Time block preview token expired" };
  }

  return { ok: true as const, payload: body };
}
