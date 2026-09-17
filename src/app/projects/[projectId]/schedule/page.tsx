import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";

export default async function SchedulePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const days = await prisma.scheduleDay.findMany({
    where: { projectId },
    orderBy: { dayNumber: "asc" },
    include: { _count: { select: { items: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Shooting schedule"
        subtitle={days.length ? `${days.length} shoot days` : "Plan your shoot days"}
        actions={
          <Link href={`/projects/${projectId}/schedule/new`}>
            <Button>New shoot day</Button>
          </Link>
        }
      />

      {days.length === 0 ? (
        <EmptyState title="No shoot days yet" description="Add a shoot day to start scheduling scenes." />
      ) : (
        <div className="space-y-3">
          {days.map((day) => (
            <Link key={day.id} href={`/projects/${projectId}/schedule/${day.id}`}>
              <Card className="flex items-center justify-between gap-4 p-4 transition-colors hover:border-accent/60">
                <div className="flex items-center gap-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-sm font-semibold text-foreground">
                    {day.dayNumber}
                  </span>
                  <div>
                    <p className="font-medium text-foreground">
                      {new Date(day.date).toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                    <p className="mt-0.5 text-sm text-muted">
                      {day.location || "No location set"}
                      {day.callTime ? ` · Call ${day.callTime}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm text-muted">{day._count.items} scenes</span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
