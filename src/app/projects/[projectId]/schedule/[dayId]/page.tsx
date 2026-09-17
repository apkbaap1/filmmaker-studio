import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Button, PageHeader } from "@/components/ui";
import { DayForm } from "../day-form";
import { updateScheduleDayAction } from "@/lib/actions/schedule";
import { ScheduleItems } from "./schedule-items";
import { DeleteDayButton } from "./delete-day-button";

export default async function ScheduleDayPage({
  params,
}: {
  params: Promise<{ projectId: string; dayId: string }>;
}) {
  const { projectId, dayId } = await params;
  await requireProjectAccess(projectId);

  const [day, scenes] = await Promise.all([
    prisma.scheduleDay.findFirst({
      where: { id: dayId, projectId },
      include: { items: { include: { scene: true }, orderBy: { id: "asc" } } },
    }),
    prisma.scene.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { id: true, number: true, location: true, intExt: true },
    }),
  ]);
  if (!day) notFound();

  const boundAction = updateScheduleDayAction.bind(null, projectId, dayId);

  return (
    <div className="space-y-8">
      <div>
        <PageHeader
          title={`Day ${day.dayNumber}`}
          actions={
            <>
              <Link href={`/projects/${projectId}/schedule/${dayId}/call-sheet`}>
                <Button variant="secondary" size="sm">
                  View call sheet
                </Button>
              </Link>
              <DeleteDayButton projectId={projectId} dayId={dayId} />
            </>
          }
        />
        <DayForm
          action={boundAction}
          submitLabel="Save day"
          defaultValues={{
            dayNumber: day.dayNumber,
            date: format(day.date, "yyyy-MM-dd"),
            callTime: day.callTime ?? "",
            wrapTime: day.wrapTime ?? "",
            location: day.location ?? "",
            weather: day.weather ?? "",
            notes: day.notes ?? "",
          }}
        />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">
          Scenes scheduled ({day.items.length})
        </h2>
        <ScheduleItems
          projectId={projectId}
          dayId={dayId}
          items={day.items}
          availableScenes={scenes}
        />
      </div>
    </div>
  );
}
