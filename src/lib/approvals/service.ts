import { createHash } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { operationApprovals } from "@/lib/db/schema";

type ApprovalDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

export type OperationApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export class OperationApprovalError extends Error {
  constructor(
    public code:
      | "approval_required"
      | "approval_not_found"
      | "approval_expired"
      | "approval_not_approved"
      | "approval_mismatch"
      | "approval_already_decided",
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

export function approvalPreviewHash(previewToken: string) {
  return createHash("sha256").update(previewToken).digest("hex");
}

export async function createOperationApproval(
  db: Pick<ApprovalDb, "select" | "insert">,
  input: {
    workspaceId: string;
    operationKind: string;
    requestHash: string;
    previewToken: string;
    summary: Record<string, unknown>;
    expiresAt: Date;
  },
) {
  const previewHash = approvalPreviewHash(input.previewToken);
  const [existing] = await db
    .select()
    .from(operationApprovals)
    .where(
      and(
        eq(operationApprovals.workspaceId, input.workspaceId),
        eq(operationApprovals.operationKind, input.operationKind),
        eq(operationApprovals.requestHash, input.requestHash),
        eq(operationApprovals.previewHash, previewHash),
        eq(operationApprovals.status, "pending"),
        gt(operationApprovals.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(operationApprovals.createdAt))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(operationApprovals)
    .values({
      workspaceId: input.workspaceId,
      operationKind: input.operationKind,
      requestHash: input.requestHash,
      previewHash,
      summaryJson: input.summary,
      expiresAt: input.expiresAt,
      status: "pending",
    })
    .returning();
  return created;
}

export async function listPendingOperationApprovals(
  db: Pick<ApprovalDb, "select">,
  workspaceId: string,
  now = new Date(),
) {
  return db
    .select()
    .from(operationApprovals)
    .where(
      and(
        eq(operationApprovals.workspaceId, workspaceId),
        eq(operationApprovals.status, "pending"),
        gt(operationApprovals.expiresAt, now),
      ),
    )
    .orderBy(desc(operationApprovals.createdAt));
}

export async function listRecentExpiredTaskNotesApprovals(
  db: Pick<ApprovalDb, "select">,
  workspaceId: string,
  now = new Date(),
) {
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(operationApprovals)
    .where(
      and(
        eq(operationApprovals.workspaceId, workspaceId),
        eq(operationApprovals.operationKind, "task_notes_batch"),
        inArray(operationApprovals.status, ["pending", "approved"]),
        lte(operationApprovals.expiresAt, now),
        gte(operationApprovals.expiresAt, oneDayAgo),
      ),
    )
    .orderBy(desc(operationApprovals.expiresAt))
    .limit(10);
}

export async function decideOperationApproval(
  db: Pick<ApprovalDb, "update">,
  input: { workspaceId: string; approvalId: string; decision: "approved" | "rejected"; now?: Date },
) {
  const now = input.now ?? new Date();
  const rows = await db
    .update(operationApprovals)
    .set({
      status: input.decision,
      approvedAt: input.decision === "approved" ? now : null,
      rejectedAt: input.decision === "rejected" ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(operationApprovals.id, input.approvalId),
        eq(operationApprovals.workspaceId, input.workspaceId),
        eq(operationApprovals.status, "pending"),
        gt(operationApprovals.expiresAt, now),
      ),
    )
    .returning();
  if (rows.length !== 1) {
    throw new OperationApprovalError(
      "approval_already_decided",
      "Approval is missing, expired, or was already decided",
    );
  }
  return rows[0];
}

function assertApprovalMatches(
  approval: typeof operationApprovals.$inferSelect | undefined,
  input: {
    operationKind: string;
    requestHash: string;
    previewToken: string;
    now: Date;
  },
) {
  if (!approval) throw new OperationApprovalError("approval_not_found", "Approval was not found", 404);
  if (approval.expiresAt <= input.now) throw new OperationApprovalError("approval_expired", "Approval expired");
  if (approval.status !== "approved") {
    throw new OperationApprovalError("approval_not_approved", "Approval has not been approved by the user");
  }
  if (
    approval.operationKind !== input.operationKind ||
    approval.requestHash !== input.requestHash ||
    approval.previewHash !== approvalPreviewHash(input.previewToken)
  ) {
    throw new OperationApprovalError("approval_mismatch", "Approval does not match this exact Preview");
  }
  return approval;
}

export async function verifyOperationApproval(
  db: Pick<ApprovalDb, "select">,
  input: {
    workspaceId: string;
    approvalId: string | undefined;
    operationKind: string;
    requestHash: string;
    previewToken: string;
    now?: Date;
  },
) {
  if (!input.approvalId) {
    throw new OperationApprovalError("approval_required", "Authenticated user approval is required");
  }
  const [approval] = await db
    .select()
    .from(operationApprovals)
    .where(
      and(
        eq(operationApprovals.id, input.approvalId),
        eq(operationApprovals.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  return assertApprovalMatches(approval, {
    operationKind: input.operationKind,
    requestHash: input.requestHash,
    previewToken: input.previewToken,
    now: input.now ?? new Date(),
  });
}

export async function consumeOperationApproval(
  tx: Pick<ApprovalDb, "select" | "update">,
  input: {
    workspaceId: string;
    approvalId: string | undefined;
    operationKind: string;
    requestHash: string;
    previewToken: string;
    now?: Date;
  },
) {
  if (!input.approvalId) {
    throw new OperationApprovalError("approval_required", "Authenticated user approval is required");
  }
  const now = input.now ?? new Date();
  let query = tx
    .select()
    .from(operationApprovals)
    .where(
      and(
        eq(operationApprovals.id, input.approvalId),
        eq(operationApprovals.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (typeof query.for === "function") query = query.for("update");
  const [approval] = await query;
  assertApprovalMatches(approval, {
    operationKind: input.operationKind,
    requestHash: input.requestHash,
    previewToken: input.previewToken,
    now,
  });
  const consumed = await tx
    .update(operationApprovals)
    .set({ status: "consumed", consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(operationApprovals.id, approval.id),
        eq(operationApprovals.workspaceId, input.workspaceId),
        eq(operationApprovals.status, "approved"),
      ),
    )
    .returning({ id: operationApprovals.id });
  if (consumed.length !== 1) {
    throw new OperationApprovalError("approval_not_approved", "Approval was already consumed");
  }
  return approval;
}
