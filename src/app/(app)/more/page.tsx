import { MoreView } from "@/components/more-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { isAdminWorkspaceId } from "@/lib/admin/owner";

export default async function MorePage() {
  const workspaceId = await getWorkspaceIdFromSession();
  return <MoreView showAdminInvites={isAdminWorkspaceId(workspaceId)} />;
}
