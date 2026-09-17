import { ReactNode } from "react";
import { requireProjectAccess } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { ProjectTabs } from "./project-tabs";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { session, project } = await requireProjectAccess(projectId);

  return (
    <AppShell userName={session.user.name ?? session.user.email ?? "Account"}>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted print:hidden">
        {project.status}
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-foreground print:hidden">{project.title}</h1>
      <div className="print:hidden">
        <ProjectTabs projectId={projectId} />
      </div>
      {children}
    </AppShell>
  );
}
