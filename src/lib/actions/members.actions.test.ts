import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { PrismaClient } from "@prisma/client";

/**
 * The membership server actions, called directly.
 *
 * Two workstreams tested *around* these, because an action reaches for a
 * NextAuth session and a page-level `notFound()`, and neither exists outside a
 * request. The workaround was static assertions over the source — good at
 * noticing a missing line, useless at noticing a line that is present and
 * wrong.
 *
 * Node's module mocking closes that gap. The session is substituted, the two
 * `next/*` helpers are replaced with throws a test can catch, and everything
 * below is the real action against a real database: the real authorization
 * check, the real queries, the real transaction.
 *
 * `notFound()` is the one worth explaining. `requireProjectAccess` calls it for
 * a project the caller cannot see, so in these tests a refused action throws
 * rather than returning — which is the behaviour, not an artefact of the
 * harness.
 */

class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundSignal";
  }
}

/** Who the actions believe is signed in. Swapped per test. */
let currentUser: { id: string; email: string; name: string } | null = null;

mock.module("next/navigation", {
  namedExports: {
    notFound: () => {
      throw new NotFoundSignal();
    },
    redirect: (to: string) => {
      throw new Error(`NEXT_REDIRECT:${to}`);
    },
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
mock.module("@/auth", {
  namedExports: {
    auth: async () => (currentUser ? { user: currentUser } : null),
  },
});

const {
  inviteCollaboratorAction,
  revokeInvitationAction,
  acceptInvitationAction,
  changeMemberRoleAction,
  removeMemberAction,
  leaveProjectAction,
} = await import("./members.ts");
const { hashInvitationToken } = await import("@/lib/invitation-tokens");

const prisma = new PrismaClient();

let owner: { id: string; email: string; name: string };
let editor: { id: string; email: string; name: string };
let stranger: { id: string; email: string; name: string };
let projectId: string;

async function makeUser(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const user = await prisma.user.create({
    data: { name: label, email, passwordHash: "x" },
  });
  return { id: user.id, email: user.email, name: user.name };
}

before(async () => {
  owner = await makeUser("owner");
  editor = await makeUser("editor");
  stranger = await makeUser("stranger");
  projectId = (await prisma.project.create({ data: { title: "Night Station", ownerId: owner.id } })).id;
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, editor.id, stranger.id] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.projectInvitation.deleteMany({ where: { projectId } });
  await prisma.projectMember.deleteMany({ where: { projectId } });
  currentUser = owner;
});

/** The token from a link, which is all the page ever has. */
function tokenFrom(invitePath: string): string {
  return invitePath.replace("/invitations/", "");
}

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the action to throw, and it resolved");
}

describe("inviting, as the owner", () => {
  it("returns a link once and stores only its hash", async () => {
    const result = await inviteCollaboratorAction(projectId, {
      email: editor.email,
      role: "EDITOR",
    });

    assert.equal(result?.error, undefined);
    assert.ok(result?.invitePath?.startsWith("/invitations/"));

    const row = await prisma.projectInvitation.findFirst({ where: { projectId } });
    assert.ok(row);
    assert.equal(row.tokenHash, hashInvitationToken(tokenFrom(result!.invitePath!)));
    assert.ok(!JSON.stringify(row).includes(tokenFrom(result!.invitePath!)));
    assert.equal(row.role, "EDITOR");
    assert.equal(row.invitedById, owner.id);
  });

  it("lower-cases the address it was given", async () => {
    await inviteCollaboratorAction(projectId, {
      email: `  ${editor.email.toUpperCase()}  `,
      role: "VIEWER",
    });
    const row = await prisma.projectInvitation.findFirst({ where: { projectId } });
    assert.equal(row?.email, editor.email.toLowerCase());
  });

  it("refuses ownership, whatever the form sends", async () => {
    const result = await inviteCollaboratorAction(projectId, {
      email: editor.email,
      role: "OWNER",
    });
    assert.match(result?.error ?? "", /Ownership cannot be handed over/);
    assert.equal(await prisma.projectInvitation.count({ where: { projectId } }), 0);
  });

  it("refuses a second live invitation to the same address", async () => {
    await inviteCollaboratorAction(projectId, { email: editor.email, role: "VIEWER" });
    const second = await inviteCollaboratorAction(projectId, { email: editor.email, role: "VIEWER" });

    assert.match(second?.error ?? "", /already a pending invitation/);
    assert.equal(await prisma.projectInvitation.count({ where: { projectId } }), 1);
  });

  it("refuses to invite the owner to their own project", async () => {
    const result = await inviteCollaboratorAction(projectId, {
      email: owner.email,
      role: "EDITOR",
    });
    assert.match(result?.error ?? "", /your own address/);
  });

  it("refuses someone already on the project", async () => {
    await prisma.projectMember.create({
      data: { projectId, userId: editor.id, role: "VIEWER" },
    });
    const result = await inviteCollaboratorAction(projectId, {
      email: editor.email,
      role: "EDITOR",
    });
    assert.match(result?.error ?? "", /already on this project/);
  });

  it("refuses something that is not an address", async () => {
    const result = await inviteCollaboratorAction(projectId, { email: "not-an-email", role: "VIEWER" });
    assert.match(result?.error ?? "", /email address/);
  });
});

describe("inviting, as anybody else", () => {
  it("refuses an editor, who could otherwise hand out spend on someone else's project", async () => {
    await prisma.projectMember.create({
      data: { projectId, userId: editor.id, role: "EDITOR" },
    });
    currentUser = editor;

    const result = await inviteCollaboratorAction(projectId, {
      email: stranger.email,
      role: "EDITOR",
    });

    assert.match(result?.error ?? "", /Only the project's owner/);
    assert.equal(await prisma.projectInvitation.count({ where: { projectId } }), 0);
  });

  it("shows a stranger nothing at all", async () => {
    // A 404 rather than a 403: probing must not distinguish "not yours" from
    // "does not exist".
    currentUser = stranger;
    const error = await caught(() =>
      inviteCollaboratorAction(projectId, { email: stranger.email, role: "VIEWER" })
    );
    assert.equal(error.name, "NotFoundSignal");
  });
});

describe("accepting", () => {
  async function invited(role: "EDITOR" | "VIEWER" = "EDITOR") {
    currentUser = owner;
    const result = await inviteCollaboratorAction(projectId, { email: editor.email, role });
    return tokenFrom(result!.invitePath!);
  }

  it("creates the membership the invitation offered", async () => {
    const token = await invited("EDITOR");
    currentUser = editor;

    const result = await acceptInvitationAction(token);
    assert.equal(result.ok, true);

    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: editor.id } },
    });
    assert.equal(member?.role, "EDITOR");
  });

  it("refuses a signed-in account with a different address", async () => {
    // The property that makes a copied link safe to paste into a chat window.
    const token = await invited();
    currentUser = stranger;

    const result = await acceptInvitationAction(token);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "wrong-account");
    assert.equal(await prisma.projectMember.count({ where: { projectId } }), 0);
  });

  it("masks the invited address in the refusal", async () => {
    const token = await invited();
    currentUser = stranger;

    const result = await acceptInvitationAction(token);
    assert.equal(result.ok, false);
    const shown = result.ok === false ? (result.invitedEmail ?? "") : "";
    assert.ok(shown.length > 0);
    assert.ok(!shown.includes(editor.email), "a forwarded link must not teach a stranger an address");
  });

  it("works once", async () => {
    const token = await invited();
    currentUser = editor;
    assert.equal((await acceptInvitationAction(token)).ok, true);

    await prisma.projectMember.deleteMany({ where: { projectId, userId: editor.id } });
    const second = await acceptInvitationAction(token);
    assert.equal(second.ok, false);
  });

  it("refuses a withdrawn invitation", async () => {
    const token = await invited();
    const invitation = await prisma.projectInvitation.findFirst({ where: { projectId } });
    currentUser = owner;
    await revokeInvitationAction(projectId, invitation!.id);

    currentUser = editor;
    const result = await acceptInvitationAction(token);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "revoked");
  });

  it("refuses a token nobody issued", async () => {
    currentUser = editor;
    const result = await acceptInvitationAction("not-a-real-token");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "not-found");
  });
});

describe("changing and removing", () => {
  beforeEach(async () => {
    await prisma.projectMember.create({
      data: { projectId, userId: editor.id, role: "EDITOR" },
    });
    currentUser = owner;
  });

  it("lets the owner change a role", async () => {
    assert.equal((await changeMemberRoleAction(projectId, editor.id, "VIEWER"))?.error, undefined);
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: editor.id } },
    });
    assert.equal(member?.role, "VIEWER");
  });

  it("refuses a member changing their own role", async () => {
    currentUser = editor;
    const result = await changeMemberRoleAction(projectId, editor.id, "EDITOR");
    assert.match(result?.error ?? "", /Only the project's owner/);
  });

  it("refuses promoting anyone to owner", async () => {
    const result = await changeMemberRoleAction(projectId, editor.id, "OWNER");
    assert.match(result?.error ?? "", /Ownership cannot be handed over/);
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: editor.id } },
    });
    assert.equal(member?.role, "EDITOR", "and the role is unchanged");
  });

  it("lets the owner remove someone, and leaves their work", async () => {
    const scene = await prisma.scene.create({
      data: { projectId, number: "4", location: "Station", order: 1 },
    });

    assert.equal((await removeMemberAction(projectId, editor.id))?.error, undefined);
    assert.equal(await prisma.projectMember.count({ where: { projectId, userId: editor.id } }), 0);
    assert.ok(await prisma.scene.findUnique({ where: { id: scene.id } }), "the scene stays");

    await prisma.scene.delete({ where: { id: scene.id } });
  });

  it("refuses a member removing another member", async () => {
    currentUser = editor;
    const result = await removeMemberAction(projectId, editor.id);
    assert.match(result?.error ?? "", /Only the project's owner/);
    assert.equal(await prisma.projectMember.count({ where: { projectId, userId: editor.id } }), 1);
  });
});

describe("leaving", () => {
  it("lets a member remove themselves", async () => {
    await prisma.projectMember.create({
      data: { projectId, userId: editor.id, role: "EDITOR" },
    });
    currentUser = editor;

    assert.equal((await leaveProjectAction(projectId))?.error, undefined);
    assert.equal(await prisma.projectMember.count({ where: { projectId, userId: editor.id } }), 0);
  });

  it("refuses the owner, who would leave nobody able to administer it", async () => {
    currentUser = owner;
    const result = await leaveProjectAction(projectId);
    assert.match(result?.error ?? "", /cannot leave it/);
  });

  it("removes only the caller, whatever else is on the project", async () => {
    await prisma.projectMember.create({ data: { projectId, userId: editor.id, role: "EDITOR" } });
    await prisma.projectMember.create({ data: { projectId, userId: stranger.id, role: "VIEWER" } });
    currentUser = editor;

    await leaveProjectAction(projectId);
    const left = await prisma.projectMember.findMany({ where: { projectId } });
    assert.deepEqual(left.map((m) => m.userId), [stranger.id]);
  });
});

describe("with nobody signed in", () => {
  it("sends every action to sign-in rather than acting", async () => {
    currentUser = null;
    for (const call of [
      () => inviteCollaboratorAction(projectId, { email: editor.email, role: "VIEWER" }),
      () => changeMemberRoleAction(projectId, editor.id, "VIEWER"),
      () => removeMemberAction(projectId, editor.id),
      () => leaveProjectAction(projectId),
      () => acceptInvitationAction("anything"),
    ]) {
      const error = await caught(call);
      assert.match(error.message, /NEXT_REDIRECT:\/sign-in/);
    }
  });
});
