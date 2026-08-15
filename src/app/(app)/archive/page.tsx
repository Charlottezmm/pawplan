import { redirect } from "next/navigation";
import { ArchiveHistoryView } from "@/components/archive-history-view";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getArchiveHistoryPageData, type ArchiveHistoryFilters } from "@/lib/planning/project-view-data";

const statuses = new Set(["todo", "done", "skipped", "backlog"]);

export default async function ArchivePage({
  searchParams,
}: {
  searchParams: { status?: string; project_id?: string; date_from?: string; date_to?: string };
}) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");
  const filters: ArchiveHistoryFilters = {
    status: searchParams.status && statuses.has(searchParams.status)
      ? searchParams.status as ArchiveHistoryFilters["status"]
      : undefined,
    projectId: searchParams.project_id || undefined,
    dateFrom: searchParams.date_from || undefined,
    dateTo: searchParams.date_to || undefined,
  };
  const data = await getArchiveHistoryPageData(workspaceId, filters);
  return <ArchiveHistoryView data={data} />;
}
