import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_INVITATION_TTL_HOURS,
  INVITABLE_ROLES,
  ROLE_DESCRIPTION,
  describeRefusal,
  emailsMatch,
  expiryFrom,
  invitationIsUsable,
  invitationPath,
  invitationStatus,
  invitationTtlHours,
  isInvitableRole,
  looksLikeEmail,
  maskEmail,
  normaliseEmail,
} from "./invitations.ts";
import {
  generateInvitationToken,
  hashInvitationToken,
  hashesMatch,
} from "./invitation-tokens.ts";

/**
 * Invitations — the pure half.
 *
 * Three properties are load-bearing, and each has a section below:
 *
 *   The token is never recoverable from what is stored.
 *   The link is necessary but not sufficient — the address is too.
 *   An invitation stops working three different ways, and all three are final.
 */

describe("tokens", () => {
  it("makes a new one every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(generateInvitationToken());
    assert.equal(seen.size, 200);
  });

  it("makes one long enough not to be guessed", () => {
    const token = generateInvitationToken();
    // 32 bytes as base64url. Anything materially shorter would be a token an
    // attacker could work through, and this grants a whole production.
    assert.ok(token.length >= 42, `${token.length} characters is too few`);
    assert.match(token, /^[A-Za-z0-9_-]+$/, "must survive being put in a URL");
  });

  it("stores a hash the token cannot be read back out of", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);

    assert.notEqual(hash, token);
    assert.ok(!hash.includes(token));
    assert.ok(!token.includes(hash));
    assert.match(hash, /^[0-9a-f]{64}$/, "sha-256, hex");
  });

  it("hashes the same token to the same value, so a link can be looked up", () => {
    const token = generateInvitationToken();
    assert.equal(hashInvitationToken(token), hashInvitationToken(token));
  });

  it("hashes different tokens differently", () => {
    assert.notEqual(hashInvitationToken("a"), hashInvitationToken("b"));
  });

  it("compares hashes without a short circuit", () => {
    const a = hashInvitationToken("one");
    assert.equal(hashesMatch(a, a), true);
    assert.equal(hashesMatch(a, hashInvitationToken("two")), false);
    assert.equal(hashesMatch(a, "short"), false, "a length mismatch is not a crash");
  });

  it("puts the token in the path and nothing else", () => {
    const token = generateInvitationToken();
    assert.equal(invitationPath(token), `/invitations/${token}`);
  });
});

describe("the address is part of the key", () => {
  it("ignores case and surrounding space", () => {
    assert.ok(emailsMatch("Editor@Example.com", "  editor@example.com "));
    assert.equal(normaliseEmail("  Editor@Example.COM "), "editor@example.com");
  });

  it("does not apply one provider's aliasing rules to every provider", () => {
    // Stripping dots or +tags is a Gmail convention, not a rule of email.
    // Applying it would let one address accept another's invitation wherever
    // the mail host treats them as different mailboxes.
    assert.equal(emailsMatch("a.b@example.com", "ab@example.com"), false);
    assert.equal(emailsMatch("editor+crew@example.com", "editor@example.com"), false);
  });

  it("refuses something that is not an address at all", () => {
    for (const bad of ["", "   ", "editor", "editor@", "@example.com", "editor example.com"]) {
      assert.equal(looksLikeEmail(bad), false, `${JSON.stringify(bad)} must not pass`);
    }
    assert.equal(looksLikeEmail("editor@example.com"), true);
  });
});

describe("masking an address", () => {
  it("leaves enough to recognise and not enough to collect", () => {
    const masked = maskEmail("jordan@example.com");
    assert.match(masked, /^j/, "the first letter, so the right person recognises it");
    assert.match(masked, /@example\.com$/, "the domain, for the same reason");
    assert.ok(!masked.includes("jordan"), "and not the address itself");
  });

  it("does not expose a short local part by accident", () => {
    const masked = maskEmail("jo@example.com");
    assert.ok(!masked.includes("jo@"), `${masked} gives away the whole name`);
  });

  it("returns something harmless for a value that is not an address", () => {
    assert.ok(!maskEmail("nonsense").includes("nonsense"));
  });
});

describe("which roles may be offered", () => {
  it("offers editor and viewer", () => {
    assert.deepEqual([...INVITABLE_ROLES], ["EDITOR", "VIEWER"]);
    assert.ok(isInvitableRole("EDITOR"));
    assert.ok(isInvitableRole("VIEWER"));
  });

  it("never offers ownership", () => {
    // Ownership is Project.ownerId — one field, one person — and it decides who
    // can delete the project and whose spend it is. Handing it out as a
    // membership row would make a second kind of owner with none of that.
    assert.equal(isInvitableRole("OWNER"), false);
    assert.ok(!(INVITABLE_ROLES as readonly string[]).includes("OWNER"));
  });

  it("refuses an invented role", () => {
    assert.equal(isInvitableRole("ADMIN"), false);
    assert.equal(isInvitableRole("editor"), false, "the stored form is upper case");
  });

  it("says what each role can do, including that an editor can spend", () => {
    for (const role of INVITABLE_ROLES) {
      assert.ok(ROLE_DESCRIPTION[role].length > 0);
    }
    assert.match(ROLE_DESCRIPTION.EDITOR, /spend money/);
    assert.match(ROLE_DESCRIPTION.VIEWER, /Cannot start a generation/);
  });
});

describe("the three ways an invitation stops working", () => {
  const future = new Date("2026-06-01T00:00:00Z");
  const past = new Date("2020-01-01T00:00:00Z");
  const now = new Date("2026-01-01T00:00:00Z");

  it("is pending while it is none of them", () => {
    assert.equal(invitationStatus({ expiresAt: future }, now), "pending");
    assert.equal(invitationIsUsable({ expiresAt: future }, now), true);
  });

  it("expires", () => {
    assert.equal(invitationStatus({ expiresAt: past }, now), "expired");
    assert.equal(invitationIsUsable({ expiresAt: past }, now), false);
  });

  it("can be withdrawn", () => {
    const state = { expiresAt: future, revokedAt: now };
    assert.equal(invitationStatus(state, now), "revoked");
    assert.equal(invitationIsUsable(state, now), false);
  });

  it("works once", () => {
    const state = { expiresAt: future, acceptedAt: now };
    assert.equal(invitationStatus(state, now), "accepted");
    assert.equal(invitationIsUsable(state, now), false);
  });

  it("expires exactly at its expiry, not a moment after", () => {
    const at = new Date("2026-03-01T12:00:00Z");
    assert.equal(invitationStatus({ expiresAt: at }, at), "expired");
    assert.equal(invitationStatus({ expiresAt: at }, new Date(at.getTime() - 1)), "pending");
  });

  it("reports an accepted invitation as accepted even once it is also stale", () => {
    // What happened to it is more useful than what has happened since.
    const state = { expiresAt: past, acceptedAt: past };
    assert.equal(invitationStatus(state, now), "accepted");
  });

  it("reports a withdrawn invitation as withdrawn even once it is also stale", () => {
    assert.equal(invitationStatus({ expiresAt: past, revokedAt: past }, now), "revoked");
  });
});

describe("how long a link lasts", () => {
  it("defaults to a week", () => {
    assert.equal(DEFAULT_INVITATION_TTL_HOURS, 168);
  });

  it("is finite, whatever the operator sets", () => {
    const saved = process.env.INVITATION_TTL_HOURS;
    try {
      for (const bad of [undefined, "", "0", "-5", "forever", "1.5"]) {
        if (bad === undefined) delete process.env.INVITATION_TTL_HOURS;
        else process.env.INVITATION_TTL_HOURS = bad;
        assert.equal(
          invitationTtlHours(),
          DEFAULT_INVITATION_TTL_HOURS,
          `${JSON.stringify(bad)} must fall back rather than disable expiry`
        );
      }
      process.env.INVITATION_TTL_HOURS = "24";
      assert.equal(invitationTtlHours(), 24);
    } finally {
      if (saved === undefined) delete process.env.INVITATION_TTL_HOURS;
      else process.env.INVITATION_TTL_HOURS = saved;
    }
  });

  it("counts forward from now", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    assert.equal(expiryFrom(now, 24).toISOString(), "2026-01-02T00:00:00.000Z");
  });
});

describe("what the holder of a dead link is told", () => {
  it("says what to do next rather than only what went wrong", () => {
    assert.match(describeRefusal("expired"), /new one/);
    assert.match(describeRefusal("not-found"), /new one/);
    assert.match(describeRefusal("wrong-account", "j••••n@example.com"), /Sign in as that account/);
  });

  it("names only the masked address it was handed", () => {
    const message = describeRefusal("wrong-account", maskEmail("jordan@example.com"));
    assert.ok(!message.includes("jordan@"), "a forwarded link must not teach a stranger an address");
  });

  it("does not say an invitation exists when none does", () => {
    // "not valid" rather than "no such invitation": a message that confirmed a
    // token was real but spent would be a probe someone could iterate.
    assert.match(describeRefusal("not-found"), /not valid/);
  });
});
