"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess, requireSession } from "@/lib/access";
import {
  emailsMatch,
  expiryFrom,
  invitationIsUsable,
  invitationPath,
  invitationStatus,
  isInvitableRole,
  looksLikeEmail,
  maskEmail,
  normaliseEmail,
  type RefusalReason,
} from "@/lib/invitations";
import { generateInvitationToken, hashInvitationToken } from "@/lib/invitation-tokens";

/**
 * Who is on a project, and how they got there.
 *
 * ## Only the owner may change the guest list
 *
 * Every action here that adds, removes or re-roles somebody requires ownership,
 * not merely write access. An editor who could invite other editors would be
 * able to hand out write access to a project they do not own — and, because an
 * editor can start generations, to hand out the ability to spend against the
 * owner's ceilings. That is the owner's decision to make.
 *
 * The one exception is leaving, which anybody may do to themselves.
 *
 * ## Why an invitation is never returned twice
 *
 * `inviteCollaboratorAction` returns the link once, and nothing can produce it
 * again: only a hash is stored. If the owner loses it, they revoke and re-invite.
 * That is the cost of not keeping a working key to the project in the database.
 */

export type ActionState = { error?: string } | undefined;

/** Carries the one-time link back to the page that asked for it. */
export type InviteState = { error?: string; invitePath?: string; email?: string } | undefined;

function peoplePath(projectId: string) {
  return `/projects/${projectId}/people`;
}

/**
 * Access for the actions that change who can get in.
 *
 * `requireProjectAccess` already 404s a project the caller cannot see; this adds
 * that a member who is not the owner is refused too, with the same 404 rather
 * than a 403 — the existing convention here, so that probing cannot distinguish
 * "not yours" from "does not exist".
 */
async function requireOwner(projectId: string) {
  const access = await requireProjectAccess(projectId);
  if (!access.isOwner) {
    return null;
  }
  return access;
}

// --- inviting ----------------------------------------------------------------

export async function inviteCollaboratorAction(
  projectId: string,
  input: { email: string; role: string }
): Promise<InviteState> {
  const access = await requireOwner(projectId);
  if (!access) return { error: "Only the project's owner can invite people." };

  const email = normaliseEmail(input.email);
  if (!looksLikeEmail(email)) return { error: "Enter an email address to invite." };
  if (!isInvitableRole(input.role)) {
    return { error: "Choose Editor or Viewer. Ownership cannot be handed over from here." };
  }

  // Inviting yourself is always a mistake rather than an intention.
  if (emailsMatch(email, access.session.user.email ?? "")) {
    return { error: "That is your own address — you already own this project." };
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existingUser) {
    const alreadyIn = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: existingUser.id } },
      select: { id: true },
    });
    if (alreadyIn) return { error: "They are already on this project." };
  }

  // A second live invitation to the same address would mean two working links
  // for one seat, and revoking one would not close the door. The owner revokes
  // the first instead, which is a visible decision rather than a silent
  // replacement.
  const live = await prisma.projectInvitation.findFirst({
    where: { projectId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (live) {
    return { error: "There is already a pending invitation for that address. Revoke it first." };
  }

  const token = generateInvitationToken();
  await prisma.projectInvitation.create({
    data: {
      projectId,
      email,
      role: input.role,
      tokenHash: hashInvitationToken(token),
      invitedById: access.session.user.id,
      expiresAt: expiryFrom(new Date()),
    },
  });

  revalidatePath(peoplePath(projectId));
  // The only moment this value exists outside the sender's hands.
  return { invitePath: invitationPath(token), email };
}

export async function revokeInvitationAction(
  projectId: string,
  invitationId: string
): Promise<ActionState> {
  const access = await requireOwner(projectId);
  if (!access) return { error: "Only the project's owner can withdraw an invitation." };

  // Kept as a revoked row rather than deleted: an owner should be able to see
  // what was offered to whom, including the offers they took back.
  await prisma.projectInvitation.updateMany({
    where: { id: invitationId, projectId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  revalidatePath(peoplePath(projectId));
  return undefined;
}

// --- accepting ---------------------------------------------------------------

export type AcceptResult =
  | { ok: true; projectId: string; projectTitle: string }
  | { ok: false; reason: RefusalReason; invitedEmail?: string };

/**
 * Turns a link into a membership.
 *
 * Deliberately does everything in one place and in one transaction: the checks
 * and the write have to be the same step, or two people holding the same link
 * could both pass the "not yet accepted" test before either wrote a row.
 */
export async function acceptInvitationAction(token: string): Promise<AcceptResult> {
  const session = await requireSession();

  const invitation = await prisma.projectInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    include: { project: { select: { id: true, title: true, ownerId: true } } },
  });
  if (!invitation) return { ok: false, reason: "not-found" };

  const status = invitationStatus(invitation);
  if (status !== "pending") {
    return {
      ok: false,
      reason:
        status === "accepted" ? "already-accepted" : status === "revoked" ? "revoked" : "expired",
    };
  }

  // The link is necessary and not sufficient. Someone who was forwarded it
  // cannot use it unless they are signed in as the address it names.
  if (!emailsMatch(invitation.email, session.user.email ?? "")) {
    // Masked, not raw: this value crosses to the browser, and whoever is
    // holding a forwarded link should not learn a stranger's address from it.
    return { ok: false, reason: "wrong-account", invitedEmail: maskEmail(invitation.email) };
  }

  if (invitation.project.ownerId === session.user.id) {
    return { ok: false, reason: "already-a-member" };
  }
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: invitation.projectId, userId: session.user.id } },
    select: { id: true },
  });
  if (existing) return { ok: false, reason: "already-a-member" };

  await prisma.$transaction(async (tx) => {
    // Re-checked inside the transaction and scoped to "still unused", so a
    // second request holding the same link finds nothing to update and writes
    // no membership.
    const claimed = await tx.projectInvitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { acceptedAt: new Date(), acceptedById: session.user.id },
    });
    if (claimed.count === 0) return;

    await tx.projectMember.create({
      data: {
        projectId: invitation.projectId,
        userId: session.user.id,
        role: invitation.role,
      },
    });
  });

  // Re-read rather than assumed: if the claim above lost the race, no
  // membership exists and this reports the truth instead of a success.
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: invitation.projectId, userId: session.user.id } },
    select: { id: true },
  });
  if (!member) return { ok: false, reason: "already-accepted" };

  revalidatePath(peoplePath(invitation.projectId));
  revalidatePath("/dashboard");
  return { ok: true, projectId: invitation.projectId, projectTitle: invitation.project.title };
}

// --- managing who is already in ----------------------------------------------

export async function changeMemberRoleAction(
  projectId: string,
  userId: string,
  role: string
): Promise<ActionState> {
  const access = await requireOwner(projectId);
  if (!access) return { error: "Only the project's owner can change a role." };
  if (!isInvitableRole(role)) {
    return { error: "Choose Editor or Viewer. Ownership cannot be handed over from here." };
  }

  await prisma.projectMember.updateMany({
    where: { projectId, userId },
    data: { role },
  });

  revalidatePath(peoplePath(projectId));
  return undefined;
}

/**
 * Removes somebody from a project.
 *
 * Their work stays. Scenes, shots, generations and assets belong to the
 * project, not to the person who made them, and a removal that deleted them
 * would be a way to destroy a production by falling out with a collaborator.
 * The generation ledger keeps their name against what they spent, because that
 * is a record of what happened.
 */
export async function removeMemberAction(
  projectId: string,
  userId: string
): Promise<ActionState> {
  const access = await requireOwner(projectId);
  if (!access) return { error: "Only the project's owner can remove someone." };

  await prisma.projectMember.deleteMany({ where: { projectId, userId } });

  revalidatePath(peoplePath(projectId));
  return undefined;
}

/**
 * Leaves a project.
 *
 * The one membership change somebody can make without being the owner — of
 * themselves, and only themselves. The owner cannot leave: there would be
 * nobody able to administer or delete the project afterwards.
 */
export async function leaveProjectAction(projectId: string): Promise<ActionState> {
  const access = await requireProjectAccess(projectId);
  if (access.isOwner) {
    return { error: "You own this project, so you cannot leave it. Delete it in Settings instead." };
  }

  await prisma.projectMember.deleteMany({
    where: { projectId, userId: access.session.user.id },
  });

  revalidatePath("/dashboard");
  return undefined;
}

/** True when a token would be accepted right now — for the landing page's preview. */
export async function invitationIsOpen(token: string): Promise<boolean> {
  const invitation = await prisma.projectInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: { expiresAt: true, acceptedAt: true, revokedAt: true },
  });
  return invitation ? invitationIsUsable(invitation) : false;
}
