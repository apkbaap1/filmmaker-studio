import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { LocationList } from "./location-list";

export default async function LocationsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const locations = await prisma.location.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });

  return (
    <div>
      <PageHeader title="Locations" subtitle={`${locations.length} locations scouted`} />
      <LocationList projectId={projectId} locations={locations} />
    </div>
  );
}
