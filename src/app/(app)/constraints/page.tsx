import { redirect } from "next/navigation";
import { ConstraintsView } from "@/components/constraints-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getTimetableWeekView } from "@/lib/planning/timetable-view-data";

export default async function ConstraintsPage({ searchParams }: { searchParams: { date?: string } }) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");
  const timetable = await getTimetableWeekView(workspaceId, searchParams.date);
  return <ConstraintsView timetable={timetable} />;
}
