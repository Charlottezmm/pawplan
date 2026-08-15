import React from "react";
import { redirect } from "next/navigation";
import { ReviewOpenedRecorder } from "@/components/review-opened-recorder";
import type { PendingOperationApproval } from "@/components/operation-approval-list";
import { ReviewPreview } from "@/components/reschedule-preview";
import { listPendingOperationApprovals } from "@/lib/approvals/service";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { operationApprovals } from "@/lib/db/schema";
import { getReschedulePageData } from "@/lib/planning/view-data";

export default async function ReviewPage() {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");

  const [data, approvalRows] = await Promise.all([
    getReschedulePageData(workspaceId),
    listPendingOperationApprovals(getDb(), workspaceId),
  ]);
  const approvals: PendingOperationApproval[] = (approvalRows as Array<typeof operationApprovals.$inferSelect>)
    .map((approval) => {
      const raw = approval.summaryJson && typeof approval.summaryJson === "object"
        ? approval.summaryJson as Record<string, unknown>
        : {};
      return {
        id: approval.id,
        operationKind: approval.operationKind,
        summary: {
          title: typeof raw.title === "string" ? raw.title : undefined,
          description: typeof raw.description === "string" ? raw.description : undefined,
          count: typeof raw.count === "number" ? raw.count : undefined,
          totalMinutes: typeof raw.totalMinutes === "number" ? raw.totalMinutes : undefined,
          items: Array.isArray(raw.items) ? raw.items.filter((item): item is string => typeof item === "string") : undefined,
        },
        expiresAt: approval.expiresAt.toISOString(),
      };
    });
  return (
    <>
      <ReviewOpenedRecorder />
      <ReviewPreview data={data} approvals={approvals} />
    </>
  );
}
