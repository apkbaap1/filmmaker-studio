import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { PrismaClient } from "@prisma/client";

/**
 * The timeline server actions, called directly.
 *
 * The rule these exist to defend is the one the whole edit view is built on: a
 * timeline placement is an *edit* decision and a shot is a *filmmaking*
 * decision, and nothing in this file may cross that line. Trimming a clip must
 * not move the shot. Deleting a clip must not delete anything. Splitting must
 * not touch the source.
 *
 * Until now that was a rule stated in comments and checked by reading. Here it
 * is checked by doing it and then looking at the shot.
 */

class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundSignal";
  }
}

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
  namedExports: { auth: async () => (currentUser ? { user: currentUser } : null) },
});

const {
  createSequenceAction,
  addClipAction,
  removeClipAction,
  reorderClipsAction,
  trimClipAction,
  splitClipAction,
  setClipTransitionAction,
  populateSequenceAction,
} = await import("./timeline.ts");

const prisma = new PrismaClient();

let owner: { id: string; email: string; name: string };
let viewer: { id: string; email: string; name: string };
let projectId: string;
let otherProjectId: string;
let sceneId: string;
let shotA: string;
let shotB: string;
let foreignShotId: string;
let sequenceId: string;

async function makeUser(label: string) {
  const email = `${label}-tl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const user = await prisma.user.create({ data: { name: label, email, passwordHash: "x" } });
  return { id: user.id, email: user.email, name: user.name };
}

before(async () => {
  owner = await makeUser("owner");
  viewer = await makeUser("viewer");

  projectId = (await prisma.project.create({ data: { title: "Night Station", ownerId: owner.id } })).id;
  otherProjectId = (await prisma.project.create({ data: { title: "Elsewhere", ownerId: owner.id } })).id;
  await prisma.projectMember.create({ data: { projectId, userId: viewer.id, role: "VIEWER" } });

  const scene = await prisma.scene.create({
    data: { projectId, number: "4", location: "Station", order: 1 },
  });
  sceneId = scene.id;
  shotA = (
    await prisma.shotListItem.create({
      data: { sceneId, shotNumber: "12", shotType: "WIDE", order: 1, durationSeconds: 8 },
    })
  ).id;
  shotB = (
    await prisma.shotListItem.create({
      data: { sceneId, shotNumber: "13", shotType: "MEDIUM", order: 2, durationSeconds: 6 },
    })
  ).id;

  const foreignScene = await prisma.scene.create({
    data: { projectId: otherProjectId, number: "1", location: "Signal box", order: 1 },
  });
  foreignShotId = (
    await prisma.shotListItem.create({
      data: { sceneId: foreignScene.id, shotNumber: "1", shotType: "CLOSE_UP", order: 1 },
    })
  ).id;
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.sequence.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
  currentUser = owner;
  sequenceId = (
    await prisma.sequence.create({ data: { projectId, name: "Main edit", order: 0 } })
  ).id;
});

async function clipsOf(id = sequenceId) {
  return prisma.timelineClip.findMany({ where: { sequenceId: id }, orderBy: { order: "asc" } });
}

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the action to throw, and it resolved");
}

describe("placing shots", () => {
  it("creates a placement without moving the shot", async () => {
    const before = await prisma.shotListItem.findUnique({ where: { id: shotA } });
    assert.equal((await addClipAction(projectId, sequenceId, shotA))?.error, undefined);

    const clips = await clipsOf();
    assert.equal(clips.length, 1);
    assert.equal(clips[0].shotId, shotA);

    const after = await prisma.shotListItem.findUnique({ where: { id: shotA } });
    assert.deepEqual(after, before, "the shot is untouched, field for field");
  });

  it("lets one shot appear more than once", async () => {
    // A placement is not the shot. The same setup can be cut to twice.
    await addClipAction(projectId, sequenceId, shotA);
    await addClipAction(projectId, sequenceId, shotA);

    const clips = await clipsOf();
    assert.equal(clips.length, 2);
    assert.deepEqual(clips.map((c) => c.order), [0, 1]);
  });

  it("refuses a shot from another project", async () => {
    const result = await addClipAction(projectId, sequenceId, foreignShotId);
    assert.match(result?.error ?? "", /does not belong to this project/);
    assert.equal((await clipsOf()).length, 0);
  });

  it("refuses a sequence from another project", async () => {
    const foreign = await prisma.sequence.create({
      data: { projectId: otherProjectId, name: "Theirs", order: 0 },
    });
    const result = await addClipAction(projectId, foreign.id, shotA);

    assert.match(result?.error ?? "", /Sequence not found/);
    assert.equal((await clipsOf(foreign.id)).length, 0);
  });

  it("refuses a viewer", async () => {
    currentUser = viewer;
    const error = await caught(() => addClipAction(projectId, sequenceId, shotA));
    assert.equal(error.name, "NotFoundSignal");
  });
});

describe("trimming — the rule this whole layer exists for", () => {
  it("writes the placement and never the shot", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();

    const result = await trimClipAction(projectId, clip.id, {
      inPointSeconds: 1,
      outPointSeconds: 3.5,
    });
    assert.equal(result?.error, undefined);

    const trimmed = await prisma.timelineClip.findUnique({ where: { id: clip.id } });
    assert.equal(trimmed?.inPointSeconds, 1);
    assert.equal(trimmed?.outPointSeconds, 3.5);

    // An 8-second shot trimmed to 2.5 seconds here is still an 8-second shot.
    const shot = await prisma.shotListItem.findUnique({ where: { id: shotA } });
    assert.equal(shot?.durationSeconds, 8);
  });

  it("refuses an out point before the in point", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();

    const result = await trimClipAction(projectId, clip.id, {
      inPointSeconds: 5,
      outPointSeconds: 2,
    });
    assert.ok(result?.error);

    const untouched = await prisma.timelineClip.findUnique({ where: { id: clip.id } });
    assert.equal(untouched?.inPointSeconds, 0);
  });

  it("cannot trim a clip in another project's sequence", async () => {
    const foreign = await prisma.sequence.create({
      data: { projectId: otherProjectId, name: "Theirs", order: 0 },
    });
    const clip = await prisma.timelineClip.create({
      data: { sequenceId: foreign.id, shotId: foreignShotId, order: 0 },
    });

    const result = await trimClipAction(projectId, clip.id, {
      inPointSeconds: 1,
      outPointSeconds: 2,
    });
    assert.match(result?.error ?? "", /not found/i);

    const after = await prisma.timelineClip.findUnique({ where: { id: clip.id } });
    assert.equal(after?.inPointSeconds, 0, "and it is not trimmed");
  });
});

describe("splitting", () => {
  it("makes two placements of one shot and touches nothing else", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    await addClipAction(projectId, sequenceId, shotB);
    const [first] = await clipsOf();

    const result = await splitClipAction(projectId, first.id, 3, 8);
    assert.equal(result?.error, undefined);

    const clips = await clipsOf();
    assert.equal(clips.length, 3);
    assert.deepEqual(clips.map((c) => c.shotId), [shotA, shotA, shotB]);
    assert.deepEqual(clips.map((c) => c.order), [0, 1, 2], "the later clip was pushed along");
    assert.equal(clips[0].outPointSeconds, 3);
    assert.equal(clips[1].inPointSeconds, 3);

    const shot = await prisma.shotListItem.findUnique({ where: { id: shotA } });
    assert.equal(shot?.durationSeconds, 8, "the source is unchanged");
  });

  it("gives the second half no transition of its own", async () => {
    // The new boundary is one the filmmaker has not chosen an edit for, so it
    // gets none rather than inheriting the first half's.
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();
    await setClipTransitionAction(projectId, clip.id, "DISSOLVE", 1);

    await splitClipAction(projectId, clip.id, 3, 8);
    const clips = await clipsOf();

    assert.equal(clips[0].transition, "DISSOLVE");
    assert.equal(clips[1].transition, null);
  });

  it("refuses a split at either edge, which would make a zero-length clip", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();

    for (const at of [0, 8]) {
      const result = await splitClipAction(projectId, clip.id, at, 8);
      assert.match(result?.error ?? "", /inside the clip/, `split at ${at}`);
    }
    assert.equal((await clipsOf()).length, 1);
  });
});

describe("transitions", () => {
  it("stores a type and a length", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();

    assert.equal((await setClipTransitionAction(projectId, clip.id, "DISSOLVE", 1.5))?.error, undefined);
    const after = await prisma.timelineClip.findUnique({ where: { id: clip.id } });
    assert.equal(after?.transition, "DISSOLVE");
    assert.equal(after?.transitionDurationSeconds, 1.5);
  });

  it("keeps 'not specified' reachable, distinct from an explicit cut", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();

    await setClipTransitionAction(projectId, clip.id, "CUT", null);
    assert.equal(
      (await prisma.timelineClip.findUnique({ where: { id: clip.id } }))?.transition,
      "CUT"
    );

    await setClipTransitionAction(projectId, clip.id, null, null);
    assert.equal(
      (await prisma.timelineClip.findUnique({ where: { id: clip.id } }))?.transition,
      null,
      "null is a plain boundary, not a cut chosen"
    );
  });

  it("refuses an invented transition type", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();

    const result = await setClipTransitionAction(projectId, clip.id, "SMASH_ZOOM", null);
    assert.ok(result?.error);
    assert.equal(
      (await prisma.timelineClip.findUnique({ where: { id: clip.id } }))?.transition,
      null
    );
  });
});

describe("removing and reordering", () => {
  it("removes a placement and leaves the shot in the project", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();

    await removeClipAction(projectId, clip.id);

    assert.equal((await clipsOf()).length, 0);
    const shot = await prisma.shotListItem.findUnique({ where: { id: shotA } });
    assert.ok(shot, "the shot survives, and can be placed again");
    assert.equal(shot.shotNumber, "12");
  });

  it("closes the gap so order stays 0..n-1", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    await addClipAction(projectId, sequenceId, shotB);
    await addClipAction(projectId, sequenceId, shotA);

    const clips = await clipsOf();
    await removeClipAction(projectId, clips[1].id);

    assert.deepEqual((await clipsOf()).map((c) => c.order), [0, 1]);
  });

  it("reorders only within the sequence it was given", async () => {
    const foreign = await prisma.sequence.create({
      data: { projectId: otherProjectId, name: "Theirs", order: 0 },
    });
    const theirs = await prisma.timelineClip.create({
      data: { sequenceId: foreign.id, shotId: foreignShotId, order: 0 },
    });

    await addClipAction(projectId, sequenceId, shotA);
    const [mine] = await clipsOf();

    // An id from another project, handed to a reorder of this one. The write is
    // scoped in its own filter, so it matches nothing.
    await reorderClipsAction(projectId, sequenceId, [theirs.id, mine.id]);

    assert.equal(
      (await prisma.timelineClip.findUnique({ where: { id: theirs.id } }))?.order,
      0,
      "the other project's clip is untouched"
    );
    assert.equal(
      (await prisma.timelineClip.findUnique({ where: { id: theirs.id } }))?.sequenceId,
      foreign.id,
      "and it did not move sequence"
    );
  });

  it("refuses a viewer removing a clip", async () => {
    await addClipAction(projectId, sequenceId, shotA);
    const [clip] = await clipsOf();
    currentUser = viewer;

    const error = await caught(() => removeClipAction(projectId, clip.id));
    assert.equal(error.name, "NotFoundSignal");
    assert.equal((await clipsOf()).length, 1);
  });
});

describe("filling a sequence from the project", () => {
  it("places every shot in scene then shot order", async () => {
    await populateSequenceAction(projectId, sequenceId);
    const clips = await clipsOf();
    assert.deepEqual(clips.map((c) => c.shotId), [shotA, shotB]);
  });

  it("is safe to run twice", async () => {
    await populateSequenceAction(projectId, sequenceId);
    await populateSequenceAction(projectId, sequenceId);
    assert.equal((await clipsOf()).length, 2, "already-placed shots are skipped");
  });

  it("takes no shots from another project", async () => {
    await populateSequenceAction(projectId, sequenceId);
    const clips = await clipsOf();
    assert.ok(!clips.some((c) => c.shotId === foreignShotId));
  });
});

describe("creating a sequence", () => {
  it("names it and leaves every shot alone", async () => {
    const shotsBefore = await prisma.shotListItem.count({ where: { scene: { projectId } } });

    const form = new FormData();
    form.set("name", "Alternate cut");
    form.set("notes", "shorter opening");
    assert.equal(await createSequenceAction(projectId, undefined, form), undefined);

    const sequences = await prisma.sequence.findMany({ where: { projectId } });
    assert.ok(sequences.some((s) => s.name === "Alternate cut"));
    assert.equal(await prisma.shotListItem.count({ where: { scene: { projectId } } }), shotsBefore);
  });

  it("refuses an empty name", async () => {
    const form = new FormData();
    form.set("name", "   ");
    const result = await createSequenceAction(projectId, undefined, form);
    assert.ok(result?.error);
  });

  it("refuses a viewer", async () => {
    currentUser = viewer;
    const form = new FormData();
    form.set("name", "Theirs");
    const error = await caught(() => createSequenceAction(projectId, undefined, form));
    assert.equal(error.name, "NotFoundSignal");
  });
});
