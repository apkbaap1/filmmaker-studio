import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Badge, Button, Card } from "@/components/ui";
import {
  ROLE_DESCRIPTION,
  describeRefusal,
  emailsMatch,
  invitationPath,
  invitationStatus,
  maskEmail,
  type InvitableRole,
} from "@/lib/invitations";
import { hashInvitationToken } from "@/lib/invitation-tokens";
import { AcceptInvitation } from "./accept-invitation";

/**
 * The landing page for an invitation link.
 *
 * Nothing about the project is revealed until two things are true: the token
 * resolves to a live invitation, and the person reading the page is signed in
 * as the address it names. Until then this says only that an invitation exists
 * — because a link can be forwarded, and the name of somebody's production is
 * theirs to share.
 *
 * Accepting is a POST from the button below, never a side effect of loading
 * this page. A link that joined you to a project merely by being visited would
 * be triggered by every preview crawler and mail scanner that touched it.
 */
export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await auth();

  const invitation = await prisma.projectInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    include: {
      project: { select: { id: true, title: true, logline: true, ownerId: true } },
      invitedBy: { select: { name: true } },
    },
  });

  // Signed out: say an invitation exists and send them to sign in, with no
  // detail at all. They may not be the person it was meant for.
  if (!session?.user?.id) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-foreground">You have been invited</h1>
        <p className="mt-2 text-sm text-muted">
          Sign in to see what this invitation is for. It only works for the account it was sent to,
          so sign in as the address you were invited at — or create that account first.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/sign-in?callbackUrl=${encodeURIComponent(invitationPath(token))}`}>
            <Button size="sm">Sign in</Button>
          </Link>
          <Link href={`/sign-up?callbackUrl=${encodeURIComponent(invitationPath(token))}`}>
            <Button size="sm" variant="secondary">
              Create an account
            </Button>
          </Link>
        </div>
      </Shell>
    );
  }

  if (!invitation) {
    return <Refused message={describeRefusal("not-found")} />;
  }

  const status = invitationStatus(invitation);
  if (status !== "pending") {
    return (
      <Refused
        message={describeRefusal(
          status === "accepted" ? "already-accepted" : status === "revoked" ? "revoked" : "expired"
        )}
      />
    );
  }

  if (!emailsMatch(invitation.email, session.user.email ?? "")) {
    return <Refused message={describeRefusal("wrong-account", maskEmail(invitation.email))} />;
  }

  // From here the reader is the invitee, so the project may be named.
  const alreadyIn =
    invitation.project.ownerId === session.user.id ||
    (await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: invitation.projectId, userId: session.user.id } },
      select: { id: true },
    })) !== null;

  if (alreadyIn) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-foreground">You are already on this project</h1>
        <p className="mt-2 text-sm text-muted">{describeRefusal("already-a-member")}</p>
        <Link href={`/projects/${invitation.projectId}`} className="mt-4 inline-block">
          <Button size="sm">Open {invitation.project.title}</Button>
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-xs uppercase tracking-wide text-muted">You have been invited to</p>
      <h1 className="mt-1 text-lg font-semibold text-foreground">{invitation.project.title}</h1>
      {invitation.project.logline && (
        <p className="mt-1 text-sm text-muted">{invitation.project.logline}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="accent">{invitation.role === "EDITOR" ? "Editor" : "Viewer"}</Badge>
        {invitation.invitedBy && (
          <span className="text-xs text-muted">invited by {invitation.invitedBy.name}</span>
        )}
      </div>

      <p className="mt-3 text-sm text-muted">
        {ROLE_DESCRIPTION[invitation.role as InvitableRole] ??
          "Your access is set by whoever invited you."}
      </p>

      <AcceptInvitation token={token} projectTitle={invitation.project.title} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link href="/" className="text-lg font-semibold tracking-tight text-foreground">
            Filmmaker Studio
          </Link>
        </div>
        <Card className="p-6">{children}</Card>
      </div>
    </div>
  );
}

function Refused({ message }: { message: string }) {
  return (
    <Shell>
      <h1 className="text-lg font-semibold text-foreground">This invitation cannot be used</h1>
      <p className="mt-2 text-sm text-muted">{message}</p>
      <Link href="/dashboard" className="mt-4 inline-block">
        <Button size="sm" variant="secondary">
          Go to your productions
        </Button>
      </Link>
    </Shell>
  );
}
