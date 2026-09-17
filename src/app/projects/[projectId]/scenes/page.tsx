import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";

const INT_EXT_LABEL: Record<string, string> = { INT: "INT", EXT: "EXT", INT_EXT: "INT/EXT" };

export default async function ScenesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const scenes = await prisma.scene.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "asc" }],
    include: { _count: { select: { shots: true } } },
  });

  const totalEights = scenes.reduce((sum, s) => sum + s.pageEights, 0);

  return (
    <div>
      <PageHeader
        title="Script breakdown"
        subtitle={
          scenes.length
            ? `${scenes.length} scenes · ${totalEights.toFixed(2)} pages`
            : "Break your script into scenes"
        }
        actions={
          <Link href={`/projects/${projectId}/scenes/new`}>
            <Button>New scene</Button>
          </Link>
        }
      />

      {scenes.length === 0 ? (
        <EmptyState title="No scenes yet" description="Add your first scene to start the breakdown." />
      ) : (
        <div className="space-y-3">
          {scenes.map((scene) => (
            <Link key={scene.id} href={`/projects/${projectId}/scenes/${scene.id}`}>
              <Card className="flex items-center justify-between gap-4 p-4 transition-colors hover:border-accent/60">
                <div className="flex items-center gap-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-sm font-semibold text-foreground">
                    {scene.number}
                  </span>
                  <div>
                    <p className="font-medium text-foreground">
                      {INT_EXT_LABEL[scene.intExt]}. {scene.location} — {scene.timeOfDay}
                    </p>
                    {scene.synopsis && <p className="mt-0.5 text-sm text-muted">{scene.synopsis}</p>}
                  </div>
                </div>
                <Badge>{scene._count.shots} shots</Badge>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
