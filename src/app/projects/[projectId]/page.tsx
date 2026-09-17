import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Card } from "@/components/ui";

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { project } = await requireProjectAccess(projectId);

  const [sceneCount, shootDayCount, castCount, crewCount, budget] = await Promise.all([
    prisma.scene.count({ where: { projectId } }),
    prisma.scheduleDay.count({ where: { projectId } }),
    prisma.castMember.count({ where: { projectId } }),
    prisma.crewMember.count({ where: { projectId } }),
    prisma.budgetLineItem.aggregate({
      where: { category: { projectId } },
      _sum: { estimated: true, actual: true },
    }),
  ]);

  const stats = [
    { label: "Scenes", value: sceneCount, href: `/projects/${projectId}/scenes` },
    { label: "Shoot days", value: shootDayCount, href: `/projects/${projectId}/schedule` },
    { label: "Cast & crew", value: castCount + crewCount, href: `/projects/${projectId}/cast-crew` },
    {
      label: "Budgeted",
      value: `$${(budget._sum.estimated ?? 0).toLocaleString()}`,
      href: `/projects/${projectId}/budget`,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}>
            <Card className="p-4 transition-colors hover:border-accent/60">
              <p className="text-xs text-muted">{s.label}</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">{s.value}</p>
            </Card>
          </Link>
        ))}
      </div>

      {project.logline && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-foreground">Logline</h2>
          <p className="mt-2 text-sm text-muted">{project.logline}</p>
        </Card>
      )}

      {project.description && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-foreground">Notes</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{project.description}</p>
        </Card>
      )}
    </div>
  );
}
