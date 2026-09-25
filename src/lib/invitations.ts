/**
 * Invitations: the way a second person gets into a project.
 *
 * Until now a `ProjectMember` row could only be created by hand in the
 * database. Everything that reads membership — `requireProjectAccess`, the
 * per-user generation ceilings, spend attribution — already worked; what was
 * missing was the door.
 *
 * This module is the pure half: expiry, addresses, roles and the wording shown
 * to somebody holding a link. It touches no database, no session and no crypto,
 * which is what lets the sign-in page and the accept button import it — the
 * token machinery lives in `invitation-tokens.ts` and is server-only, so a
 * client component reaching for it is a build error rather than a review
 * comment.
 *
 * ## Why an invitation is bound to an email address
 *
 * This application cannot send mail. Whoever invites someone copies the link and
 * sends it themselves, which means the link ends up in a chat window or a
 * forwarded message. A pure bearer token in that setting is a key to a whole
 * production lying in somebody's message history, and every person who can read
 * that history can walk in.
 *
 * So the link is necessary and not sufficient: accepting also requires being
 * signed in as the address the invitation names. That is a real cost — an
 * invitee who signed up under a different address cannot accept, and has to be
 * re-invited — and it is the right trade for what the link grants.
 */

/** How long a link is good for, unless the operator says otherwise. */
export const DEFAULT_INVITATION_TTL_HOURS = 168; // seven days

export function invitationTtlHours(): number {
  const raw = Number(process.env.INVITATION_TTL_HOURS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_INVITATION_TTL_HOURS;
}

export type ProjectRoleValue = "OWNER" | "EDITOR" | "VIEWER";

/**
 * The roles an invitation may offer.
 *
 * OWNER is absent on purpose. Ownership here is `Project.ownerId` — one field,
 * one person — and it decides who can delete the project and who its spend
 * belongs to. Handing it out as a membership row would create a second kind of
 * owner with none of those powers and a confusingly similar name. Transferring
 * ownership is a different operation with different consequences, and it is not
 * implemented.
 */
export const INVITABLE_ROLES = ["EDITOR", "VIEWER"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(role: string): role is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(role);
}

export const ROLE_DESCRIPTION: Record<InvitableRole, string> = {
  EDITOR:
    "Can change the script, shots, blocking and edit, and can start generations — which spend money against this project's ceilings.",
  VIEWER: "Can see everything and change nothing. Cannot start a generation.",
};

// --- addresses ---------------------------------------------------------------

/** How an address is stored and compared: trimmed and lower-cased. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether these two addresses are the same person, as far as this app can tell.
 *
 * Case and surrounding space only. Deliberately *not* clever: stripping dots or
 * `+tag` suffixes is a Gmail convention, not a rule of email, and applying it
 * would silently let one address accept another's invitation on a provider that
 * treats them as different mailboxes.
 */
export function emailsMatch(a: string, b: string): boolean {
  return normaliseEmail(a) === normaliseEmail(b);
}

/**
 * Enough of an address to recognise, not enough to collect.
 *
 * The person holding a forwarded link should not learn a stranger's email from
 * it. But the legitimate invitee who signed in under the wrong account needs to
 * be told which one to use, and "a different address" does not help them. So the
 * refusal shows a masked form: `a****n@example.com`.
 */
export function maskEmail(email: string): string {
  const value = normaliseEmail(email);
  const at = value.lastIndexOf("@");
  if (at <= 0) return "\u2022\u2022\u2022\u2022";

  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 2) return `${local[0] ?? ""}\u2022\u2022\u2022\u2022${domain}`;
  return `${local[0]}\u2022\u2022\u2022\u2022${local[local.length - 1]}${domain}`;
}

/** Minimal shape check. The real test is whether the invitee can be signed in as it. */
export function looksLikeEmail(email: string): boolean {
  const value = normaliseEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

// --- lifecycle ---------------------------------------------------------------

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InvitationState {
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
}

/**
 * What became of an invitation.
 *
 * Order matters: an invitation that was accepted and has since passed its expiry
 * reads as accepted, because that is what happened to it. Expiry only describes
 * one that was never used.
 */
export function invitationStatus(state: InvitationState, now: Date = new Date()): InvitationStatus {
  if (state.acceptedAt) return "accepted";
  if (state.revokedAt) return "revoked";
  if (state.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export function invitationIsUsable(state: InvitationState, now: Date = new Date()): boolean {
  return invitationStatus(state, now) === "pending";
}

export function expiryFrom(now: Date, ttlHours: number = invitationTtlHours()): Date {
  return new Date(now.getTime() + ttlHours * 3_600_000);
}

/**
 * The path a link points at.
 *
 * A path rather than a full URL because the origin is not knowable from the
 * server with any confidence — it depends on proxies, forwarded headers and
 * deployment. The browser that created the invitation knows its own origin for
 * certain, so it builds the absolute link. Guessing it here would produce links
 * that quietly point at the wrong host.
 */
export function invitationPath(token: string): string {
  return `/invitations/${token}`;
}

/** Why an invitation cannot be accepted, in words for the person holding it. */
export type RefusalReason =
  | "not-found"
  | "expired"
  | "revoked"
  | "already-accepted"
  | "wrong-account"
  | "already-a-member";

export function describeRefusal(reason: RefusalReason, invitedEmail?: string): string {
  switch (reason) {
    case "not-found":
      return "This invitation link is not valid. Ask whoever invited you for a new one.";
    case "expired":
      return "This invitation has expired. Ask whoever invited you to send a new one.";
    case "revoked":
      return "This invitation was withdrawn.";
    case "already-accepted":
      return "This invitation has already been used. An invitation works once.";
    case "wrong-account":
      // The address arrives already masked by the caller: a forwarded link must
      // not teach a stranger somebody's email.
      return `This invitation was sent to ${invitedEmail ?? "a different address"}. Sign in as that account to accept it, or ask to be invited at the address you use here.`;
    case "already-a-member":
      return "You are already on this project, so there is nothing to accept.";
  }
}
