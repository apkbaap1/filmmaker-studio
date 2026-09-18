/**
 * Post-generation verification, shared by both verification scripts.
 *
 * It lives here rather than in either script because both need to make exactly
 * the same claims about a finished generation, and two copies of these checks
 * would drift. More importantly: the real-provider run is a one-shot that costs
 * money, so this code must already have been executed before it matters. The
 * mock-backed `verify-image-provider` run exercises it on every test pass,
 * which is what stops the real run from being the first time it is tried.
 *
 * Nothing here talks to a provider. It takes a generation that has already
 * completed — however it completed — and checks that a person can still see it,
 * and that a stranger cannot.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

const APP_PORT = Number(process.env.VERIFY_PORT ?? 3122);
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;

/**
 * A cookie jar, so the persistence checks are made by something that behaves
 * like a browser rather than by another database query.
 */
class Session {
  private jar = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const response = await fetch(`${APP_BASE}${path}`, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers ?? {}), cookie },
    });
    this.absorb(response);
    return response;
  }
}

async function signIn(email: string, password: string): Promise<Session> {
  const session = new Session();
  const { csrfToken } = (await (await session.fetch("/api/auth/csrf")).json()) as {
    csrfToken: string;
  };
  await session.fetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: APP_BASE }).toString(),
  });
  return session;
}

function startApp(): ChildProcess {
  return spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(APP_PORT)], {
    cwd: process.cwd(),
    // Its own process group, so the teardown takes the whole tree with it.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      // A production build refuses an untrusted Host header.
      AUTH_TRUST_HOST: "true",
      AUTH_URL: APP_BASE,
    },
  });
}

function stopApp(app: ChildProcess): void {
  if (!app.pid) return;
  try {
    process.kill(-app.pid, "SIGKILL");
  } catch {
    app.kill("SIGKILL");
  }
}

async function waitForApp(): Promise<boolean> {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${APP_BASE}/sign-in`, { redirect: "manual" });
      if (response.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

export interface AfterGenerationInput {
  prisma: PrismaClient;
  check: (name: string, ok: boolean, detail?: string) => boolean;
  projectId: string;
  sceneId: string;
  shotId: string;
  generationId: string;
  assetId: string;
  assetChecksum: string | null;
  assetMimeType: string;
  promptText: string;
  /** The shot's generations as they were *before* this one, to prove they survived. */
  before: { id: string; status: string; assetId: string | null; promptUsed: string }[];
}

/**
 * Re-reads the finished generation from the database, then from a browser, then
 * checks a stranger can reach none of it.
 */
export async function verifyAfterGeneration(input: AfterGenerationInput): Promise<void> {
  const { prisma, check, projectId, sceneId, shotId, generationId, assetId, promptText } = input;

  console.log("\nPERSISTENCE (re-read from the database)\n");
  const reread = await prisma.generation.findMany({
    where: { shotId },
    orderBy: { createdAt: "asc" },
    include: { asset: true },
  });
  const mine = reread.find((g) => g.id === generationId);

  check("the generation is still COMPLETED", mine?.status === "COMPLETED");
  check("its image is still attached", mine?.asset?.id === assetId);
  check("its exact prompt is still attached", mine?.promptUsed === promptText);
  check(
    "previous generations were not overwritten",
    input.before.every((g) => {
      const now = reread.find((r) => r.id === g.id);
      return now?.status === g.status && now?.assetId === g.assetId && now?.promptUsed === g.promptUsed;
    }),
    `${input.before.length} earlier generation(s) intact`
  );

  //
  // A database re-read proves the row survived. It does not prove a person
  // reopening Shot 12 can actually see the image, which is what "refresh the
  // browser" means. So the built application is started and asked over HTTP,
  // with a real signed-in session.
  //
  console.log("\nBROWSER REFRESH (real HTTP against the built application)\n");

  const password = `verify-${randomUUID()}`;
  const viewer = await prisma.user.create({
    data: {
      name: "Verification viewer",
      email: `verify-viewer-${randomUUID().slice(0, 8)}@example.test`,
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  // A temporary member of this project, removed at the end. The owner's own
  // password is not known to this script, and inventing one would mean
  // rewriting a real user's credentials.
  await prisma.projectMember.create({
    data: { projectId, userId: viewer.id, role: "EDITOR" },
  });

  const app = startApp();
  try {
    if (!check("the application started", await waitForApp(), APP_BASE)) {
      throw new Error("the application did not start");
    }

    const browser = await signIn(viewer.email, password);
    const sessionResponse = await browser.fetch("/api/auth/session");
    const session = (await sessionResponse.json()) as { user?: { id?: string } };
    check("the viewer is signed in", session.user?.id === viewer.id);

    // The refresh itself.
    const page = await browser.fetch(
      `/projects/${projectId}/scenes/${sceneId}/shots/${shotId}`
    );
    const html = await page.text();
    check("Shot 12 loads for a signed-in member", page.status === 200, `HTTP ${page.status}`);
    check(
      "the page references the generated asset",
      html.includes(assetId),
      `asset ${assetId} appears in the rendered page`
    );
    check(
      "the page still shows the generation as completed",
      html.includes("Completed"),
      "status rendered"
    );

    // The image itself, as the browser's <img> would fetch it.
    const media = await browser.fetch(`/api/assets/${assetId}/file`);
    const served = Buffer.from(await media.arrayBuffer());
    check("the image is served over HTTP", media.status === 200, `HTTP ${media.status}`);
    check(
      "the served bytes are the stored bytes",
      createHash("sha256").update(served).digest("hex") === input.assetChecksum,
      `${served.byteLength} bytes`
    );
    check(
      "it is served with the recorded content type",
      media.headers.get("content-type") === input.assetMimeType,
      String(media.headers.get("content-type"))
    );
    check(
      "and privately, so no shared cache can hold it",
      media.headers.get("cache-control")?.includes("private") === true
    );

    // --- authorization, over the same HTTP surface -------------------------
    console.log("\nAUTHORIZATION (a second, unrelated user, over HTTP)\n");

    const strangerPassword = `verify-${randomUUID()}`;
    const stranger = await prisma.user.create({
      data: {
        name: "Verification stranger",
        email: `verify-stranger-${randomUUID().slice(0, 8)}@example.test`,
        passwordHash: await bcrypt.hash(strangerPassword, 10),
      },
    });

    try {
      const outsider = await signIn(stranger.email, strangerPassword);

      const theirPage = await outsider.fetch(
        `/projects/${projectId}/scenes/${sceneId}/shots/${shotId}`
      );
      check(
        "the stranger cannot open Shot 12",
        theirPage.status === 404 || theirPage.status === 307,
        `HTTP ${theirPage.status}`
      );

      const theirMedia = await outsider.fetch(`/api/assets/${assetId}/file`);
      const theirBytes = Buffer.from(await theirMedia.arrayBuffer());
      check(
        "the stranger cannot fetch the private media URL",
        theirMedia.status === 404,
        `HTTP ${theirMedia.status}`
      );
      check(
        "and receives none of the image's bytes",
        !theirBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );

      const anonymous = await fetch(`${APP_BASE}/api/assets/${assetId}/file`, {
        redirect: "manual",
      });
      check(
        "an anonymous request receives nothing either",
        anonymous.status !== 200,
        `HTTP ${anonymous.status}`
      );

      // Writes, checked at the database boundary the server actions use.
      const { scopedTo } = await import("@/lib/authz");
      const theirProject = await prisma.project.create({
        data: { title: "Stranger", ownerId: stranger.id },
      });

      const modified = await prisma.generation.updateMany({
        where: { id: generationId, ...scopedTo.generation(theirProject.id) },
        data: { status: "FAILED" },
      });
      check("the stranger cannot modify the Generation", modified.count === 0);

      const deleted = await prisma.generation.deleteMany({
        where: { id: generationId, ...scopedTo.generation(theirProject.id) },
      });
      check("the stranger cannot delete the Generation", deleted.count === 0);

      const survived = await prisma.generation.findUnique({ where: { id: generationId } });
      check("the generation survived those attempts unchanged", survived?.status === "COMPLETED");

      await prisma.project.delete({ where: { id: theirProject.id } }).catch(() => {});
    } finally {
      await prisma.user.delete({ where: { id: stranger.id } }).catch(() => {});
    }
  } finally {
    stopApp(app);
    // The temporary membership and user are removed whatever happened, so the
    // project is left exactly as it was found.
    await prisma.projectMember
      .deleteMany({ where: { projectId, userId: viewer.id } })
      .catch(() => {});
    await prisma.user.delete({ where: { id: viewer.id } }).catch(() => {});
  }

}
