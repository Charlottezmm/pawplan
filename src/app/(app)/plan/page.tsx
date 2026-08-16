import { redirect } from "next/navigation";
import { PlanView, type PlanTab } from "@/components/plan-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getMonthPlanData, getTodayPageData, getWeekPageData, normalizeMonthKey } from "@/lib/planning/view-data";

const planTabs = new Set<PlanTab>(["day", "week", "month", "reschedule"]);

export default async function PlanPage({ searchParams }: { searchParams: { view?: string; month?: string } }) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");

  const initialTab = searchParams.view && planTabs.has(searchParams.view as PlanTab)
    ? searchParams.view as PlanTab
    : "day";
  const monthKey = normalizeMonthKey(searchParams.month);

  const [today, week, month] = await Promise.all([
    getTodayPageData(workspaceId),
    getWeekPageData(workspaceId),
    getMonthPlanData(workspaceId, monthKey),
  ]);
  return <PlanView today={today} week={week} month={month} initialTab={initialTab} />;
}
