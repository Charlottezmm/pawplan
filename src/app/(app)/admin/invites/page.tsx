import { AdminInvitesView } from "@/components/admin-invites-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { isAdminWorkspaceId } from "@/lib/admin/owner";

export default async function AdminInvitesPage() {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!isAdminWorkspaceId(workspaceId)) {
    return (
      <div className="paw-page">
        <section className="paw-page-header">
          <h1 className="paw-page-date">邀请管理</h1>
          <div className="paw-agent-row">
            <p className="paw-agent-msg">当前计划空间没有邀请管理权限。</p>
          </div>
        </section>
      </div>
    );
  }

  return <AdminInvitesView />;
}
