import { MoreView } from "@/components/more-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { isAdminWorkspaceId } from "@/lib/admin/owner";
import { getBacklogCount } from "@/lib/planning/project-view-data";

export default async function MorePage() {
  const workspaceId = await getWorkspaceIdFromSession();
  const backlog = workspaceId ? await getBacklogCount(workspaceId) : { count: 0 };
  return <MoreView showAdminInvites={isAdminWorkspaceId(workspaceId)} backlogCount={backlog.count} />;
}
