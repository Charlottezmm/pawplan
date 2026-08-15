import { and, eq } from "drizzle-orm";
import { plans } from "@/lib/db/schema";

type PlanningDb = {
  select: (...args: any[]) => any;
};

export type ActivePlanContext = {
  id: string;
  workspaceId: string;
  title: string;
  startDate: Date;
  endDate: Date;
  currentVersionId: string | null;
  baselineSnapshot: unknown;
};

export class ActivePlanError extends Error {
  constructor(
    public code: "active_plan_missing" | "active_plan_conflict",
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function resolveActivePlanContext(
  db: PlanningDb,
  workspaceId: string,
  options: { lock?: boolean } = {},
): Promise<ActivePlanContext> {
  let query = db
    .select({
      id: plans.id,
      workspaceId: plans.workspaceId,
      title: plans.title,
      startDate: plans.startDate,
      endDate: plans.endDate,
      currentVersionId: plans.currentVersionId,
      baselineSnapshot: plans.baselineSnapshot,
    })
    .from(plans)
    .where(and(eq(plans.workspaceId, workspaceId), eq(plans.status, "active")))
    .limit(2);
  const rows = options.lock ? await query.for("update") : await query;

  if (rows.length === 0) {
    throw new ActivePlanError("active_plan_missing", "No active plan", { workspaceId });
  }
  if (rows.length > 1) {
    throw new ActivePlanError("active_plan_conflict", "Workspace has multiple active plans", {
      workspaceId,
      planIds: rows.map((plan: { id: string }) => plan.id),
    });
  }

  return rows[0] as ActivePlanContext;
}

export async function getActivePlanId(db: PlanningDb, workspaceId: string) {
  try {
    return (await resolveActivePlanContext(db, workspaceId)).id;
  } catch (error) {
    if (error instanceof ActivePlanError && error.code === "active_plan_missing") return null;
    throw error;
  }
}
