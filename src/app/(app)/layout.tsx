import { redirect } from "next/navigation";
import { isAdminWorkspaceId } from "@/lib/admin/owner";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { AppShell } from "@/components/app-shell";
import { getPendingReviewCount } from "@/lib/planning/pending-review-count";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");

  const pendingReviewCount = await getPendingReviewCount(workspaceId);
  return (
    <AppShell
      pendingReviewCount={pendingReviewCount}
      showAdminInvites={isAdminWorkspaceId(workspaceId)}
    >
      {children}
    </AppShell>
  );
}
