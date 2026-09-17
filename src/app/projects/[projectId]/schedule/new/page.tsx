import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { DayForm } from "../day-form";
import { createScheduleDayAction } from "@/lib/actions/schedule";

export default async function NewScheduleDayPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId, { write: true });

  const dayCount = await prisma.scheduleDay.count({ where: { projectId } });
  const boundAction = createScheduleDayAction.bind(null, projectId);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New shoot day" />
      <DayForm
        action={boundAction}
        submitLabel="Add shoot day"
        defaultValues={{ dayNumber: dayCount + 1 }}
      />
    </div>
  );
}
