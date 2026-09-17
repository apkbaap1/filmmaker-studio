import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { EquipmentList } from "./equipment-list";

export default async function EquipmentPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const items = await prisma.equipment.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });

  return (
    <div>
      <PageHeader title="Equipment" subtitle={`${items.length} items tracked`} />
      <EquipmentList projectId={projectId} items={items} />
    </div>
  );
}
