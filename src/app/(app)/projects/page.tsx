import { redirect } from "next/navigation";
import { ProjectPortfolio } from "@/components/project-portfolio";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getProjectPortfolioData } from "@/lib/planning/project-view-data";

export default async function ProjectsPage() {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) redirect("/login");
  const data = await getProjectPortfolioData(workspaceId);
  return <ProjectPortfolio data={data} />;
}
