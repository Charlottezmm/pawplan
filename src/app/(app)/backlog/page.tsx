import { redirect } from "next/navigation";
import { BacklogView } from "@/components/backlog-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getBacklogPageData } from "@/lib/planning/project-view-data";

export default async function BacklogPage() {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");
  const data = await getBacklogPageData(workspaceId);
  return <BacklogView data={data} />;
}
