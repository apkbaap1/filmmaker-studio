import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { CastList } from "./cast-list";
import { CrewList } from "./crew-list";

export default async function CastCrewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const [cast, crew] = await Promise.all([
    prisma.castMember.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
    prisma.crewMember.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
  ]);

  return (
    <div className="space-y-10">
      <div>
        <PageHeader title="Cast" subtitle={`${cast.length} characters tracked`} />
        <CastList projectId={projectId} members={cast} />
      </div>
      <div>
        <PageHeader title="Crew" subtitle={`${crew.length} crew members tracked`} />
        <CrewList projectId={projectId} members={crew} />
      </div>
    </div>
  );
}
