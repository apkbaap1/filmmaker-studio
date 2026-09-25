"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import {
  changeMemberRoleAction,
  inviteCollaboratorAction,
  leaveProjectAction,
  removeMemberAction,
  revokeInvitationAction,
} from "@/lib/actions/members";
import {
  INVITABLE_ROLES,
  ROLE_DESCRIPTION,
  type InvitableRole,
  type InvitationStatus,
} from "@/lib/invitations";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  EDITOR: "Editor",
  VIEWER: "Viewer",
};

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// --- who is already in -------------------------------------------------------

export function MemberList({
  projectId,
  owner,
  members,
  canManage,
}: {
  projectId: string;
  owner: { id: string; name: string; email: string; isYou: boolean } | null;
  members: Array<{
    userId: string;
    name: string;
    email: string;
    role: string;
    joinedAt: string;
    isYou: boolean;
  }>;
  canManage: boolean;
}) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-foreground">On this project</h2>

      <ul className="mt-3 divide-y divide-border">
        {owner && (
          <li className="flex flex-wrap items-center gap-2 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">
                {owner.name}
                {owner.isYou && <span className="text-muted"> (you)</span>}
              </p>
              <p className="truncate text-xs text-muted">{owner.email}</p>
            </div>
            <Badge tone="accent">Owner</Badge>
          </li>
        )}

        {members.map((member) => (
          <MemberRow key={member.userId} projectId={projectId} member={member} canManage={canManage} />
        ))}
      </ul>

      {members.length === 0 && (
        <p className="mt-3 text-xs text-muted">
          Nobody else yet. {canManage ? "Invite someone below." : ""}
        </p>
      )}
    </Card>
  );
}

function MemberRow({
  projectId,
  member,
  canManage,
}: {
  projectId: string;
  member: { userId: string; name: string; email: string; role: string; joinedAt: string; isYou: boolean };
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function run(fn: () => Promise<{ error?: string } | undefined>) {
    setError(undefined);
    start(async () => {
      const result = await fn();
      if (result?.error) setError(result.error);
    });
  }

  return (
    <li className="flex flex-wrap items-center gap-2 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          {member.name}
          {member.isYou && <span className="text-muted"> (you)</span>}
        </p>
        <p className="truncate text-xs text-muted">
          {member.email} · joined {when(member.joinedAt)}
        </p>
        {error && <ErrorText message={error} />}
      </div>

      {canManage ? (
        <>
          <div className="w-32">
            <Select
              value={member.role}
              disabled={pending}
              onChange={(e) => run(() => changeMemberRoleAction(projectId, member.userId, e.target.value))}
            >
              {INVITABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </Select>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            title="Remove them from this project. Their work stays."
            onClick={() => run(() => removeMemberAction(projectId, member.userId))}
          >
            Remove
          </Button>
        </>
      ) : (
        <Badge>{ROLE_LABEL[member.role] ?? member.role}</Badge>
      )}
    </li>
  );
}

// --- inviting ----------------------------------------------------------------

export function InviteForm({ projectId }: { projectId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("VIEWER");
  const [issued, setIssued] = useState<{ url: string; email: string } | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <h2 className="text-sm font-semibold text-foreground">Invite someone</h2>
      <p className="mt-1 text-xs text-muted">
        This app does not send email. You get a link to pass on yourself — and because a link in a
        chat window can be forwarded, it only works for someone signed in as the address you invite.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="w-64">
          <Field label="Their email">
            <Input
              type="email"
              value={email}
              placeholder="editor@example.com"
              disabled={pending}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        </div>
        <div className="w-36">
          <Field label="As">
            <Select
              value={role}
              disabled={pending}
              onChange={(e) => setRole(e.target.value as InvitableRole)}
            >
              {INVITABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button
          size="sm"
          disabled={pending || email.trim() === ""}
          onClick={() => {
            setError(undefined);
            setIssued(null);
            setCopied(false);
            start(async () => {
              const result = await inviteCollaboratorAction(projectId, { email, role });
              if (result?.error) {
                setError(result.error);
                return;
              }
              if (result?.invitePath) {
                // Built here rather than on the server: the browser knows its
                // own origin for certain, and a guessed one produces links
                // pointing at the wrong host.
                setIssued({
                  url: `${window.location.origin}${result.invitePath}`,
                  email: result.email ?? email,
                });
                setEmail("");
              }
            });
          }}
        >
          Create link
        </Button>
      </div>

      <p className="mt-2 text-xs text-muted">{ROLE_DESCRIPTION[role]}</p>
      {error && <ErrorText message={error} />}

      {issued && (
        <div className="mt-4 rounded border border-accent/50 bg-accent/10 p-3">
          <p className="text-sm font-semibold text-foreground">
            Copy this now — it is not shown again
          </p>
          <p className="mt-1 text-xs text-muted">
            Only a hash of this link is stored, so nothing here can show it to you a second time.
            Send it to {issued.email}. If you lose it, withdraw the invitation and make another.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1.5 text-xs text-foreground">
              {issued.url}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(issued.url).then(
                  () => setCopied(true),
                  () => setCopied(false)
                );
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- what has been offered ---------------------------------------------------

const STATUS_TONE: Record<InvitationStatus, "default" | "accent" | "green" | "red"> = {
  pending: "accent",
  accepted: "green",
  revoked: "default",
  expired: "default",
};

export function PendingInvitations({
  projectId,
  invitations,
}: {
  projectId: string;
  invitations: Array<{
    id: string;
    email: string;
    role: string;
    status: InvitationStatus;
    expiresAt: string;
    createdAt: string;
    invitedBy: string | null;
    acceptedBy: string | null;
  }>;
}) {
  const [pending, start] = useTransition();

  if (invitations.length === 0) return null;

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-foreground">Invitations</h2>
      <p className="mt-1 text-xs text-muted">
        Withdrawn and expired invitations are kept rather than deleted, so you can see what was
        offered to whom.
      </p>

      <ul className="mt-3 divide-y divide-border">
        {invitations.map((invitation) => (
          <li key={invitation.id} className="flex flex-wrap items-center gap-2 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{invitation.email}</p>
              <p className="truncate text-xs text-muted">
                {ROLE_LABEL[invitation.role] ?? invitation.role} · invited {when(invitation.createdAt)}
                {invitation.invitedBy && ` by ${invitation.invitedBy}`}
                {invitation.status === "pending" && ` · expires ${when(invitation.expiresAt)}`}
                {invitation.status === "accepted" &&
                  invitation.acceptedBy &&
                  ` · accepted by ${invitation.acceptedBy}`}
              </p>
            </div>
            <Badge tone={STATUS_TONE[invitation.status]}>{invitation.status}</Badge>
            {invitation.status === "pending" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => start(() => revokeInvitationAction(projectId, invitation.id).then(() => {}))}
              >
                Withdraw
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- leaving -----------------------------------------------------------------

export function LeaveProject({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-foreground">Leave this project</h2>
      <p className="mt-1 text-xs text-muted">
        You lose access to {projectTitle}. Everything you made on it stays — scenes, shots and
        generations belong to the production, not to whoever typed them.
      </p>
      {error && <ErrorText message={error} />}

      {confirming ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() => {
              setError(undefined);
              start(async () => {
                const result = await leaveProjectAction(projectId);
                if (result?.error) {
                  setError(result.error);
                  setConfirming(false);
                } else {
                  window.location.href = "/dashboard";
                }
              });
            }}
          >
            Yes, leave
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button className="mt-3" size="sm" variant="secondary" onClick={() => setConfirming(true)}>
          Leave
        </Button>
      )}
    </Card>
  );
}
