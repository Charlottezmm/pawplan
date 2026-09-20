import { redirect } from "next/navigation";
import Link from "next/link";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { TodayView } from "@/components/today-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getTodayPageData } from "@/lib/planning/view-data";

export default async function TodayPage() {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");

  const data = await getTodayPageData(workspaceId);
  return <TodayView data={data} beforeTasks={<><Link href="/timeline" className="inline-block rounded-xl border px-4 py-2">安排时间线 · 开始与续接</Link><OnboardingChecklist /></>} />;
}
