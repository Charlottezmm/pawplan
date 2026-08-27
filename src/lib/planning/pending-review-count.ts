import { and, eq, gt } from "drizzle-orm";
import { operationApprovals, agentPatches } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { getActivePlanId } from "@/lib/planning/active-plan";

type PendingReviewDb = Pick<ReturnType<typeof getDb>, "select">;

export function sumPendingReviewCount(draftPatches: unknown[], pendingApprovals: unknown[]) {
  return draftPatches.length + pendingApprovals.length;
}

export async function readPendingReviewCount(
  db: PendingReviewDb,
  workspaceId: string,
  now = new Date(),
) {
  const activePlanId = await getActivePlanId(db, workspaceId);
  const [draftPatches, pendingApprovals] = await Promise.all([
    activePlanId
      ? db
          .select({ id: agentPatches.id })
          .from(agentPatches)
          .where(and(
            eq(agentPatches.workspaceId, workspaceId),
            eq(agentPatches.planId, activePlanId),
            eq(agentPatches.status, "draft"),
          ))
      : Promise.resolve([]),
    db
      .select({ id: operationApprovals.id })
      .from(operationApprovals)
      .where(and(
        eq(operationApprovals.workspaceId, workspaceId),
        eq(operationApprovals.status, "pending"),
        gt(operationApprovals.expiresAt, now),
      )),
  ]);
  return sumPendingReviewCount(draftPatches, pendingApprovals);
}

export async function getPendingReviewCount(workspaceId: string, now = new Date()) {
  try {
    return await readPendingReviewCount(getDb(), workspaceId, now);
  } catch (error) {
    if (error instanceof Error && error.message.includes("DATABASE_URL")) return 0;
    console.error("Unable to read pending Review count", error);
    return 0;
  }
}
