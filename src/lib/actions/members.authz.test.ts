import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Who is allowed to change the guest list.
 *
 * The rule: everything that adds, removes or re-roles somebody requires
 * *ownership*, not merely write access. An editor who could invite other
 * editors would be handing out write access to a project they do not own — and,
 * because an editor can start generations, handing out the ability to spend
 * against the owner's ceilings.
 *
 * That rule lives in a call at the top of each action, which is exactly the kind
 * of line that goes missing when a new action is added by copying an old one.
 * These read the source and check it is still there, because a session cannot be
 * faked convincingly enough to test it any other way.
 */

const SOURCE = readFileSync(
  path.join(process.cwd(), "src/lib/actions/members.ts"),
  "utf8"
);

/** The body of one exported action, from its signature to the next export. */
function bodyOf(name: string): string {
  const start = SOURCE.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} is not exported from members.ts — has it been renamed?`);
  const rest = SOURCE.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? rest : rest.slice(0, next);
}

const OWNER_ONLY = [
  "inviteCollaboratorAction",
  "revokeInvitationAction",
  "changeMemberRoleAction",
  "removeMemberAction",
];

describe("only the owner changes who can get in", () => {
  for (const action of OWNER_ONLY) {
    it(`${action} requires ownership`, () => {
      const body = bodyOf(action);
      assert.match(body, /requireOwner\(/, `${action} must go through requireOwner`);
      // And must actually act on the answer, rather than calling it and
      // carrying on regardless.
      assert.match(body, /if \(!access\)/, `${action} must refuse when requireOwner says no`);
    });
  }

  it("requireOwner is built on the same access gate as every other page", () => {
    const helper = SOURCE.slice(SOURCE.indexOf("async function requireOwner"));
    assert.match(helper, /requireProjectAccess\(/, "ownership is checked on top of access, not instead of it");
    assert.match(helper, /isOwner/);
  });

  it("leaving is the one membership change that does not need ownership", () => {
    // Anybody may remove themselves — and only themselves.
    const body = bodyOf("leaveProjectAction");
    assert.ok(!body.includes("requireOwner("), "leaving must not be owner-only");
    assert.match(body, /requireProjectAccess\(/);
    assert.match(body, /userId: access\.session\.user\.id/, "scoped to the caller, never to an id they sent");
    assert.match(body, /isOwner/, "and the owner is refused, since nobody could administer it after");
  });
});

describe("the rules an action cannot be written around", () => {
  it("accepting is scoped to the signed-in user, never to a supplied id", () => {
    const body = bodyOf("acceptInvitationAction");
    assert.match(body, /session\.user\.id/);
    // A userId parameter here would let anyone with a link add anybody at all.
    assert.ok(
      !/acceptInvitationAction\(\s*token: string,\s*userId/.test(SOURCE),
      "acceptInvitationAction must not take a userId"
    );
  });

  it("accepting checks the address as well as the token", () => {
    const body = bodyOf("acceptInvitationAction");
    assert.match(body, /emailsMatch\(/, "the link alone must not be enough");
    assert.match(body, /wrong-account/);
  });

  it("accepting claims the invitation conditionally, so one link is one seat", () => {
    const body = bodyOf("acceptInvitationAction");
    assert.match(body, /\$transaction/);
    assert.match(body, /acceptedAt: null/, "the claim must be scoped to an unused invitation");
    assert.match(body, /count === 0/, "and must notice when it lost the race");
  });

  it("never offers ownership through an invitation or a role change", () => {
    for (const action of ["inviteCollaboratorAction", "changeMemberRoleAction"]) {
      assert.match(bodyOf(action), /isInvitableRole\(/, `${action} must go through the role allow-list`);
    }
    assert.ok(
      !/role:\s*"OWNER"/.test(SOURCE),
      "no action may write an OWNER membership row"
    );
  });

  it("scopes every membership write to the project it was asked about", () => {
    // Without the projectId in the filter, an id from another project would be
    // writable by anyone who owns any project.
    for (const action of ["changeMemberRoleAction", "removeMemberAction", "revokeInvitationAction"]) {
      assert.match(bodyOf(action), /projectId[,}]/, `${action} must filter by projectId`);
    }
  });

  it("stores only a hash of the token", () => {
    const body = bodyOf("inviteCollaboratorAction");
    assert.match(body, /tokenHash: hashInvitationToken\(token\)/);
    assert.ok(
      !/data:\s*\{[^}]*\btoken\b\s*:/.test(body),
      "the token itself must never be written to a column"
    );
  });
});

describe("the token machinery stays on the server", () => {
  /** Every .ts/.tsx file under src, so a new component cannot opt out by being new. */
  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, found);
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
    return found;
  }

  it("no client component imports it", () => {
    // How this rule was learned: the accept button imported one sentence of
    // wording from the invitations module, which at the time also held the
    // hashing, and the production build failed trying to put node:crypto in a
    // browser bundle. The split fixed it; this stops it coming back.
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(source)) continue;
      if (/from ["']@\/lib\/invitation-tokens["']/.test(source)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    assert.deepEqual(offenders, [], "invitation tokens must never reach the browser");
  });

  it("is marked server-only, so the build enforces it too", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/invitation-tokens.ts"), "utf8");
    assert.match(source, /^import "server-only";/m);
  });

  it("leaves the shared half importable by a client component", () => {
    // The wording and the lifecycle rules have to be reachable from the accept
    // button, or the two would drift into separate copies of the same rules.
    const source = readFileSync(path.join(process.cwd(), "src/lib/invitations.ts"), "utf8");
    // The directive, not the phrase — this module's doc comment explains the
    // split, and matching that prose would fail for saying why it exists.
    assert.ok(
      !/^import "server-only";/m.test(source),
      "the shared half must stay importable from a client component"
    );
    assert.ok(!/node:crypto/.test(source), "and must pull nothing node-only into a bundle");
    assert.match(source, /export function describeRefusal/);
  });
});
