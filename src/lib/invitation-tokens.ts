import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Invitation tokens.
 *
 * Separate from `invitations.ts` and marked server-only, because a token must
 * never be generated, hashed or compared in a browser — and because the moment
 * a client component imported the module that did any of those, Node's crypto
 * would be pulled into the bundle. That is how this file came to exist: the
 * accept button imported one sentence of wording and took the token machinery
 * with it.
 *
 * ## The token is a secret, and is treated like one
 *
 * A token is 32 random bytes. Only its SHA-256 is stored, so a row cannot be
 * turned back into a working link — a database dump is a list of hashes rather
 * than a set of keys to other people's productions. The consequence the UI has
 * to live with is that a link can be shown exactly once, when it is made.
 *
 * SHA-256 with no salt or stretching is right here and would be wrong for a
 * password: this input is 32 bytes of CSPRNG output, not something a person
 * chose, so there is no dictionary to run against it and nothing for a slow
 * hash to defend.
 */

/** 32 bytes of CSPRNG, URL-safe. The only time this value exists in the clear. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compares two token hashes without leaking where they diverge.
 *
 * The lookup itself is by indexed hash, so this is belt and braces rather than
 * the primary defence — but a comparison that returns early is a habit worth
 * not having in a file about access.
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
