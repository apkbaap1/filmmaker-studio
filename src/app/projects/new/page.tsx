import { requireSession } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/ui";
import { ProjectForm } from "../project-form";
import { createProjectAction } from "@/lib/actions/projects";

export default async function NewProjectPage() {
  const session = await requireSession();

  return (
    <AppShell userName={session.user.name ?? session.user.email ?? "Account"}>
      <div className="mx-auto max-w-xl">
        <PageHeader title="New production" subtitle="Set up a new film, short, or series." />
        <ProjectForm action={createProjectAction} submitLabel="Create project" />
      </div>
    </AppShell>
  );
}
