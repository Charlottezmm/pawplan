import { redirect } from "next/navigation";
import { BacklogView } from "@/components/backlog-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getLegacySkippedTasks } from "@/lib/planning/legacy-skipped";
import { getBacklogPageData } from "@/lib/planning/project-view-data";

export default async function BacklogPage() {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");
  const [data, legacySkipped] = await Promise.all([
    getBacklogPageData(workspaceId),
    getLegacySkippedTasks(workspaceId),
  ]);
  return <BacklogView data={data} legacySkipped={legacySkipped} />;
}
