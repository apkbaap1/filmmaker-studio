import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { ProjectForm } from "../../project-form";
import { updateProjectAction } from "@/lib/actions/projects";
import { DeleteProjectButton } from "./delete-project-button";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { project, isOwner } = await requireProjectAccess(projectId, { write: true });

  const boundAction = updateProjectAction.bind(null, projectId);

  return (
    <div className="mx-auto max-w-xl space-y-8">
      <div>
        <PageHeader title="Project settings" />
        <ProjectForm
          action={boundAction}
          submitLabel="Save changes"
          defaultValues={{
            title: project.title,
            logline: project.logline ?? "",
            description: project.description ?? "",
            genre: project.genre ?? "",
            format: project.format ?? "",
            status: project.status,
          }}
        />
      </div>

      {isOwner && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-5">
          <h2 className="text-sm font-semibold text-red-300">Danger zone</h2>
          <p className="mt-1 text-sm text-red-300/70">
            Deleting this project permanently removes every scene, shot, schedule, and budget
            item attached to it.
          </p>
          <div className="mt-4">
            <DeleteProjectButton projectId={projectId} />
          </div>
        </div>
      )}
    </div>
  );
}
