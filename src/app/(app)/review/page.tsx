import React from "react";
import { redirect } from "next/navigation";
import { ReviewOpenedRecorder } from "@/components/review-opened-recorder";
import type { ExpiredOperationApproval, PendingOperationApproval } from "@/components/operation-approval-list";
import { ReviewPreview } from "@/components/reschedule-preview";
import { listPendingOperationApprovals, listRecentExpiredTaskNotesApprovals } from "@/lib/approvals/service";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { operationApprovals } from "@/lib/db/schema";
import { getReschedulePageData } from "@/lib/planning/view-data";

export default async function ReviewPage() {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");

  const now = new Date();
  const [data, approvalRows, expiredApprovalRows] = await Promise.all([
    getReschedulePageData(workspaceId),
    listPendingOperationApprovals(getDb(), workspaceId, now),
    listRecentExpiredTaskNotesApprovals(getDb(), workspaceId, now),
  ]);
  function mapApproval(approval: typeof operationApprovals.$inferSelect): PendingOperationApproval {
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
        noteChanges: Array.isArray(raw.noteChanges)
          ? raw.noteChanges.flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const change = item as Record<string, unknown>;
              if (
                typeof change.taskId !== "string" ||
                typeof change.title !== "string" ||
                (change.before !== null && typeof change.before !== "string") ||
                typeof change.after !== "string"
              ) return [];
              return [{
                taskId: change.taskId,
                title: change.title,
                before: change.before as string | null,
                after: change.after,
              }];
            })
          : undefined,
      },
      expiresAt: approval.expiresAt.toISOString(),
    };
  }
  const approvals = (approvalRows as Array<typeof operationApprovals.$inferSelect>).map(mapApproval);
  const expiredApprovals: ExpiredOperationApproval[] = (expiredApprovalRows as Array<typeof operationApprovals.$inferSelect>)
    .map((approval) => ({
      ...mapApproval(approval),
      status: approval.status === "approved" ? "approved" : "pending",
    }));
  return (
    <>
      <ReviewOpenedRecorder />
      <ReviewPreview data={data} approvals={approvals} expiredApprovals={expiredApprovals} />
    </>
  );
}
