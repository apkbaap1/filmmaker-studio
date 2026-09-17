import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/access";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";

export default async function DashboardPage() {
  const session = await requireSession();

  const projects = await prisma.project.findMany({
    where: {
      OR: [{ ownerId: session.user.id }, { members: { some: { userId: session.user.id } } }],
    },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { scenes: true, scheduleDays: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Your productions"
        subtitle="Every film, short, or series you're working on."
        actions={
          <Link href="/projects/new">
            <Button>New project</Button>
          </Link>
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          title="No productions yet"
          description="Create your first project to start breaking down scenes and planning shoot days."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="h-full p-5 transition-colors hover:border-accent/60">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-foreground">{project.title}</h3>
                  <Badge tone="accent">{project.status}</Badge>
                </div>
                {project.logline && (
                  <p className="mt-2 line-clamp-2 text-sm text-muted">{project.logline}</p>
                )}
                <div className="mt-4 flex gap-4 text-xs text-muted">
                  <span>{project._count.scenes} scenes</span>
                  <span>{project._count.scheduleDays} shoot days</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
