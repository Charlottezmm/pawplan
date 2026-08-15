import { NextResponse } from "next/server";
import { z } from "zod";
import { decideOperationApproval, OperationApprovalError } from "@/lib/approvals/service";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { readJsonBody } from "@/lib/validation/common";

const decisionSchema = z
  .object({
    approvalId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
  })
  .strict();

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = decisionSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: "Invalid approval decision" }, { status: 400 });

  try {
    const approval = await decideOperationApproval(getDb(), {
      workspaceId,
      approvalId: parsed.data.approvalId,
      decision: parsed.data.decision,
    });
    return NextResponse.json({
      status: approval.status,
      approvalId: approval.id,
      approvedAt: approval.approvedAt,
      rejectedAt: approval.rejectedAt,
    });
  } catch (error) {
    if (error instanceof OperationApprovalError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to decide approval" }, { status: 500 });
  }
}
