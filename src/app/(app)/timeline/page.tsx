import { redirect } from "next/navigation";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { DailyTimelineView } from "@/components/daily-timeline-view";
export default async function TimelinePage() {
  if (!await getWorkspaceIdFromSession()) redirect("/login");
  return <DailyTimelineView />;
}
