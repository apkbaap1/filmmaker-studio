import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  emailsMatch,
  expiryFrom,
  invitationStatus,
} from "@/lib/invitations";
import { generateInvitationToken, hashInvitationToken } from "@/lib/invitation-tokens";

/**
 * The membership lifecycle, against a real database.
 *
 * The server actions themselves cannot be called here — they reach for a
 * NextAuth session, and a test that faked one would be testing the fake. So
 * these exercise the same queries the actions run, against real rows, and pin
 * the things a session could not have changed anyway: what a token looks up,
 * what a second use of one finds, what a removal leaves behind.
 *
 * The authorization rules the actions add on top are asserted separately, by
 * reading the actions' own source — see `members.authz.test.ts`.
 */

const prisma = new PrismaClient();

let ownerId: string;
let editorId: string;
let strangerId: string;
let projectId: string;

const OWNER_EMAIL = `owner-${Date.now()}@example.test`;
const EDITOR_EMAIL = `editor-${Date.now()}@example.test`;

before(async () => {
  ownerId = (
    await prisma.user.create({ data: { name: "Owner", email: OWNER_EMAIL, passwordHash: "x" } })
  ).id;
  editorId = (
    await prisma.user.create({ data: { name: "Editor", email: EDITOR_EMAIL, passwordHash: "x" } })
  ).id;
  strangerId = (
    await prisma.user.create({
      data: { name: "Stranger", email: `stranger-${Date.now()}@example.test`, passwordHash: "x" },
    })
  ).id;

  projectId = (await prisma.project.create({ data: { title: "Night Station", ownerId } })).id;
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, editorId, strangerId] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.projectInvitation.deleteMany({ where: { projectId } });
  await prisma.projectMember.deleteMany({ where: { projectId } });
});

/** Issues an invitation the way the action does, and hands back the token. */
async function invite(
  email: string,
  options: { role?: "EDITOR" | "VIEWER"; expiresAt?: Date } = {}
) {
  const token = generateInvitationToken();
  const invitation = await prisma.projectInvitation.create({
    data: {
      projectId,
      email: email.toLowerCase(),
      role: options.role ?? "VIEWER",
      tokenHash: hashInvitationToken(token),
      invitedById: ownerId,
      expiresAt: options.expiresAt ?? expiryFrom(new Date()),
    },
  });
  return { token, invitation };
}

/** The claim-then-create the accept action performs, without its session. */
async function accept(token: string, userId: string, userEmail: string) {
  const invitation = await prisma.projectInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
  });
  if (!invitation) return { ok: false as const, reason: "not-found" };
  if (invitationStatus(invitation) !== "pending") {
    return { ok: false as const, reason: invitationStatus(invitation) };
  }
  if (!emailsMatch(invitation.email, userEmail)) {
    return { ok: false as const, reason: "wrong-account" };
  }

  let claimed = 0;
  await prisma.$transaction(async (tx) => {
    const result = await tx.projectInvitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { acceptedAt: new Date(), acceptedById: userId },
    });
    claimed = result.count;
    if (claimed === 0) return;
    await tx.projectMember.create({
      data: { projectId: invitation.projectId, userId, role: invitation.role },
    });
  });

  return claimed > 0 ? { ok: true as const } : { ok: false as const, reason: "already-accepted" };
}

describe("a link resolves to exactly one invitation", () => {
  it("finds the invitation it was issued for", async () => {
    const { token, invitation } = await invite(EDITOR_EMAIL);
    const found = await prisma.projectInvitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
    });
    assert.equal(found?.id, invitation.id);
  });

  it("finds nothing for a token that was never issued", async () => {
    await invite(EDITOR_EMAIL);
    const found = await prisma.projectInvitation.findUnique({
      where: { tokenHash: hashInvitationToken(generateInvitationToken()) },
    });
    assert.equal(found, null);
  });

  it("does not keep the token anywhere on the row", async () => {
    // The property the whole design rests on: a database dump is a list of
    // hashes, not a set of working keys to other people's productions.
    const { token, invitation } = await invite(EDITOR_EMAIL);
    const row = await prisma.projectInvitation.findUnique({ where: { id: invitation.id } });
    assert.ok(row);
    assert.ok(!JSON.stringify(row).includes(token), "the token must not survive anywhere on the row");
  });
});

describe("accepting", () => {
  it("turns a link into a membership with the role it offered", async () => {
    const { token } = await invite(EDITOR_EMAIL, { role: "EDITOR" });
    const result = await accept(token, editorId, EDITOR_EMAIL);
    assert.equal(result.ok, true);

    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: editorId } },
    });
    assert.equal(member?.role, "EDITOR");
  });

  it("records who used it and when", async () => {
    const { token, invitation } = await invite(EDITOR_EMAIL);
    await accept(token, editorId, EDITOR_EMAIL);

    const row = await prisma.projectInvitation.findUnique({ where: { id: invitation.id } });
    assert.ok(row?.acceptedAt);
    assert.equal(row?.acceptedById, editorId);
  });

  it("works once", async () => {
    const { token } = await invite(EDITOR_EMAIL);
    assert.equal((await accept(token, editorId, EDITOR_EMAIL)).ok, true);

    await prisma.projectMember.deleteMany({ where: { projectId, userId: editorId } });
    const second = await accept(token, editorId, EDITOR_EMAIL);
    assert.equal(second.ok, false, "a spent link cannot be used again, even after leaving");
  });

  it("cannot be used by a signed-in account with a different address", async () => {
    // The link on its own is not enough. This is what makes it safe to paste
    // into a chat window, which is the only way this app can deliver one.
    const { token } = await invite(EDITOR_EMAIL);
    const result = await accept(token, strangerId, "stranger@elsewhere.test");

    assert.equal(result.ok, false);
    assert.equal(result.reason, "wrong-account");
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: strangerId } },
    });
    assert.equal(member, null, "and no membership was written");
  });

  it("cannot be used after it expires", async () => {
    const { token } = await invite(EDITOR_EMAIL, { expiresAt: new Date(Date.now() - 1000) });
    const result = await accept(token, editorId, EDITOR_EMAIL);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expired");
  });

  it("cannot be used after it is withdrawn", async () => {
    const { token, invitation } = await invite(EDITOR_EMAIL);
    await prisma.projectInvitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() },
    });

    const result = await accept(token, editorId, EDITOR_EMAIL);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "revoked");
  });

  it("gives one membership when the same link is used twice at once", async () => {
    // Two clicks in flight together. The claim is a conditional update scoped
    // to "still unused", so only one of them can write a membership.
    const { token } = await invite(EDITOR_EMAIL);
    const [a, b] = await Promise.all([
      accept(token, editorId, EDITOR_EMAIL),
      accept(token, editorId, EDITOR_EMAIL),
    ]);

    assert.equal([a.ok, b.ok].filter(Boolean).length, 1, "exactly one may succeed");
    const members = await prisma.projectMember.findMany({ where: { projectId, userId: editorId } });
    assert.equal(members.length, 1);
  });

  it("matches the address case-insensitively", async () => {
    const { token } = await invite(EDITOR_EMAIL.toUpperCase());
    assert.equal((await accept(token, editorId, EDITOR_EMAIL)).ok, true);
  });
});

describe("withdrawing", () => {
  it("keeps the row rather than deleting it", async () => {
    // An owner should be able to see what was offered to whom, including the
    // offers they took back.
    const { invitation } = await invite(EDITOR_EMAIL);
    await prisma.projectInvitation.updateMany({
      where: { id: invitation.id, projectId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const row = await prisma.projectInvitation.findUnique({ where: { id: invitation.id } });
    assert.ok(row, "still there");
    assert.equal(invitationStatus(row), "revoked");
  });

  it("cannot un-accept an invitation that was already used", async () => {
    const { token, invitation } = await invite(EDITOR_EMAIL);
    await accept(token, editorId, EDITOR_EMAIL);

    const revoked = await prisma.projectInvitation.updateMany({
      where: { id: invitation.id, projectId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    assert.equal(revoked.count, 0);

    const row = await prisma.projectInvitation.findUnique({ where: { id: invitation.id } });
    assert.equal(invitationStatus(row!), "accepted");
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: editorId } },
    });
    assert.ok(member, "withdrawing does not remove someone who already joined");
  });
});

describe("removing somebody", () => {
  it("takes away their access and leaves the production alone", async () => {
    const { token } = await invite(EDITOR_EMAIL, { role: "EDITOR" });
    await accept(token, editorId, EDITOR_EMAIL);

    const scene = await prisma.scene.create({
      data: { projectId, number: "4", location: "Station", order: 1 },
    });
    const generation = await prisma.generation.create({
      data: {
        projectId,
        createdById: editorId,
        mode: "IMAGE",
        source: "STRUCTURED",
        status: "COMPLETED",
        promptUsed: "a wide shot",
        providerId: "openai-image",
      },
    });

    await prisma.projectMember.deleteMany({ where: { projectId, userId: editorId } });

    assert.equal(
      await prisma.projectMember.count({ where: { projectId, userId: editorId } }),
      0,
      "access is gone"
    );
    // Their work belongs to the production, not to them. A removal that took it
    // with them would be a way to destroy a film by falling out with someone.
    assert.ok(await prisma.scene.findUnique({ where: { id: scene.id } }), "the scene stays");
    const kept = await prisma.generation.findUnique({ where: { id: generation.id } });
    assert.ok(kept, "the generation stays");
    assert.equal(kept.createdById, editorId, "and it still says who made it");

    await prisma.generation.delete({ where: { id: generation.id } });
    await prisma.scene.delete({ where: { id: scene.id } });
  });

  it("does not disturb anyone else's membership", async () => {
    const { token } = await invite(EDITOR_EMAIL);
    await accept(token, editorId, EDITOR_EMAIL);
    await prisma.projectMember.create({
      data: { projectId, userId: strangerId, role: "VIEWER" },
    });

    await prisma.projectMember.deleteMany({ where: { projectId, userId: editorId } });
    assert.equal(await prisma.projectMember.count({ where: { projectId } }), 1);
  });
});

describe("the project's other tables know about members", () => {
  it("counts a collaborator's generations against their own user ceiling", async () => {
    // Attribution added in 11.7, and the reason it matters once there is more
    // than one person: before it, one busy editor's work was charged to every
    // collaborator's limit and could lock them all out.
    const { token } = await invite(EDITOR_EMAIL, { role: "EDITOR" });
    await accept(token, editorId, EDITOR_EMAIL);

    const generation = await prisma.generation.create({
      data: {
        projectId,
        createdById: editorId,
        mode: "IMAGE",
        source: "STRUCTURED",
        status: "QUEUED",
        promptUsed: "a close-up",
        providerId: "openai-image",
      },
    });

    assert.equal(await prisma.generation.count({ where: { createdById: editorId } }), 1);
    assert.equal(await prisma.generation.count({ where: { createdById: ownerId } }), 0);

    await prisma.generation.delete({ where: { id: generation.id } });
  });

  it("removes invitations with the project", async () => {
    const throwaway = await prisma.project.create({ data: { title: "Temporary", ownerId } });
    const token = generateInvitationToken();
    await prisma.projectInvitation.create({
      data: {
        projectId: throwaway.id,
        email: EDITOR_EMAIL,
        role: "VIEWER",
        tokenHash: hashInvitationToken(token),
        expiresAt: expiryFrom(new Date()),
      },
    });

    await prisma.project.delete({ where: { id: throwaway.id } });
    const orphan = await prisma.projectInvitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
    });
    assert.equal(orphan, null, "a deleted project leaves no working links behind");
  });
});
