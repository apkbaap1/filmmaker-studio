import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Card, PageHeader } from "@/components/ui";
import { invitationStatus } from "@/lib/invitations";
import { LeaveProject, MemberList, PendingInvitations, InviteForm } from "./people-views";

/**
 * Who can reach this project.
 *
 * Visible to every member, because knowing who else can see your production is
 * not a privilege — but only the owner gets the controls, and the actions
 * enforce that again on the server rather than trusting this page to hide them.
 */
export default async function PeoplePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { session, project, isOwner } = await requireProjectAccess(projectId);

  const [owner, members, invitations] = await Promise.all([
    prisma.user.findUnique({
      where: { id: project.ownerId },
      select: { id: true, name: true, email: true },
    }),
    prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    // Only the owner sees the invitation list: a pending invitation names an
    // address that has not agreed to anything yet, and showing it to the rest
    // of the crew would publish it.
    isOwner
      ? prisma.projectInvitation.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          take: 50,
          include: {
            invitedBy: { select: { name: true } },
            acceptedBy: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        subtitle={`Who can reach ${project.title}, and what they can do.`}
      />

      <MemberList
        projectId={projectId}
        owner={owner ? { ...owner, isYou: owner.id === session.user.id } : null}
        members={members.map((m) => ({
          userId: m.userId,
          name: m.user.name,
          email: m.user.email,
          role: m.role,
          joinedAt: m.createdAt.toISOString(),
          isYou: m.userId === session.user.id,
        }))}
        canManage={isOwner}
      />

      {isOwner && (
        <>
          <Card className="p-5">
            <InviteForm projectId={projectId} />
          </Card>

          <PendingInvitations
            projectId={projectId}
            invitations={invitations.map((i) => ({
              id: i.id,
              email: i.email,
              role: i.role,
              status: invitationStatus(i),
              expiresAt: i.expiresAt.toISOString(),
              createdAt: i.createdAt.toISOString(),
              invitedBy: i.invitedBy?.name ?? null,
              acceptedBy: i.acceptedBy?.name ?? null,
            }))}
          />
        </>
      )}

      {!isOwner && <LeaveProject projectId={projectId} projectTitle={project.title} />}
    </div>
  );
}
