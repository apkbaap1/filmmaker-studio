/**
 * Live security verification for the media storage boundary.
 *
 * This is not a unit test. It starts the real application, registers two real
 * users, signs each of them in through NextAuth to get real session cookies,
 * puts a real file in real storage, and then tries to get at it the ways an
 * attacker would. Every assertion below is made against an HTTP response from
 * the running server.
 *
 *     npm run build && npm run verify:storage
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { LocalStorageProvider, signKey } from "../src/lib/storage/local.ts";
import { buildAssetKey } from "../src/lib/storage/keys.ts";

const PORT = Number(process.env.VERIFY_PORT ?? 3111);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A minimal cookie jar: NextAuth's session is a cookie, so we need one per user. */
class Session {
  private jar = new Map<string, string>();

  get cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers ?? {}), cookie: this.cookieHeader },
    });
    this.absorb(response);
    return response;
  }
}

async function signIn(email: string, password: string): Promise<Session> {
  const session = new Session();
  const csrfResponse = await session.fetch("/api/auth/csrf");
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  await session.fetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: BASE }).toString(),
  });
  return session;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${BASE}/sign-in`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("The application did not start");
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const storage = new LocalStorageProvider();
  const run = randomUUID().slice(0, 8);

  const server: ChildProcess = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    cwd: process.cwd(),
    // Its own process group, so the teardown below takes the whole tree with
    // it — a stray `next-server` holding the port makes the next run lie.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      // A production build refuses an untrusted Host header. The real deployment
      // sets one of these too — see README > Deployment.
      AUTH_TRUST_HOST: "true",
      AUTH_URL: BASE,
    },
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));

  try {
    await waitForServer();
    console.log(`Application up on ${BASE}\n`);

    // --- two real users, registered through the real endpoint ---------------
    const owner = { email: `owner-${run}@example.test`, password: "correct-horse-1", name: "Owner" };
    const stranger = { email: `stranger-${run}@example.test`, password: "correct-horse-2", name: "Stranger" };

    for (const user of [owner, stranger]) {
      const response = await fetch(`${BASE}/api/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(user),
      });
      if (!response.ok) throw new Error(`register failed: ${response.status} ${await response.text()}`);
    }

    const ownerId = (await prisma.user.findUniqueOrThrow({ where: { email: owner.email } })).id;
    const strangerId = (await prisma.user.findUniqueOrThrow({ where: { email: stranger.email } })).id;

    // --- a project each, and a real object in real storage ------------------
    const ownerProject = await prisma.project.create({
      data: { title: `Owner project ${run}`, ownerId },
    });
    const strangerProject = await prisma.project.create({
      data: { title: `Stranger project ${run}`, ownerId: strangerId },
    });

    const body = Buffer.from(`secret frame bytes ${run}`);
    const key = buildAssetKey(ownerProject.id, "image/png");
    await storage.put(key, body, { contentType: "image/png" });

    const asset = await prisma.asset.create({
      data: {
        projectId: ownerProject.id,
        type: "IMAGE",
        source: "UPLOADED",
        storageProvider: "LOCAL",
        storageKey: key,
        checksum: createHash("sha256").update(body).digest("hex"),
        mimeType: "image/png",
        fileSize: body.byteLength,
      },
    });

    const ownerSession = await signIn(owner.email, owner.password);
    const strangerSession = await signIn(stranger.email, stranger.password);

    const filePath = `/api/assets/${asset.id}/file`;

    console.log("Baseline");
    {
      const response = await ownerSession.fetch(filePath);
      const bytes = Buffer.from(await response.arrayBuffer());
      check(
        "the owner can download their own asset",
        response.status === 200 && bytes.equals(body),
        `status ${response.status}, ${bytes.byteLength} bytes`
      );
      check(
        "the response is marked private and non-sniffable",
        response.headers.get("cache-control")?.includes("private") === true &&
          response.headers.get("x-content-type-options") === "nosniff",
        `${response.headers.get("cache-control")} / ${response.headers.get("x-content-type-options")}`
      );
    }

    console.log("\n1. Cross-project media access");
    {
      const response = await strangerSession.fetch(filePath);
      const text = await response.text();
      check(
        "a signed-in user cannot download another project's asset",
        response.status === 404 && !text.includes("secret frame bytes"),
        `status ${response.status}`
      );
    }

    console.log("\n2. Guessed asset id");
    {
      const guesses = ["clxguessedguessedguessed", "1", "../../../etc/passwd", asset.id.slice(0, -1) + "z"];
      let worst = 0;
      for (const guess of guesses) {
        const response = await strangerSession.fetch(`/api/assets/${encodeURIComponent(guess)}/file`);
        worst = Math.max(worst, response.status === 404 ? 0 : 1);
      }
      check("a guessed asset id is always 404, never a hit or an error", worst === 0);
    }

    console.log("\n3. Guessed storage key");
    {
      // The stranger has learned the exact key — the hardest case — but has no
      // signature for it.
      const response = await strangerSession.fetch(`/api/media?key=${encodeURIComponent(key)}`);
      const text = await response.text();
      check(
        "the storage key alone buys nothing",
        response.status === 404 && !text.includes("secret frame bytes"),
        `status ${response.status}`
      );

      const forged = await strangerSession.fetch(
        `/api/media?key=${encodeURIComponent(key)}&expires=${Math.floor(Date.now() / 1000) + 3600}&signature=${"a".repeat(64)}`
      );
      check(
        "a forged signature is rejected",
        forged.status === 404,
        `status ${forged.status}`
      );
    }

    console.log("\n4. Expired signed URL");
    {
      const secret = process.env.MEDIA_URL_SECRET || process.env.AUTH_SECRET || "development-only";
      const expired = Math.floor(Date.now() / 1000) - 60;
      const url = `/api/media?key=${encodeURIComponent(key)}&expires=${expired}&signature=${signKey(secret, key, expired)}`;

      const response = await ownerSession.fetch(url);
      const text = await response.text();
      check(
        "an expired but correctly-signed URL no longer serves the object",
        response.status === 410 && !text.includes("secret frame bytes"),
        `status ${response.status}`
      );

      const live = Math.floor(Date.now() / 1000) + 300;
      const liveUrl = `/api/media?key=${encodeURIComponent(key)}&expires=${live}&signature=${signKey(secret, key, live)}`;
      const ok = await ownerSession.fetch(liveUrl);
      check(
        "an unexpired, correctly-signed URL does serve it",
        ok.status === 200,
        `status ${ok.status}`
      );
    }

    console.log("\n5. Unauthenticated download");
    {
      const response = await fetch(`${BASE}${filePath}`, { redirect: "manual" });
      const text = await response.text();
      check(
        "an anonymous request never receives the bytes",
        response.status !== 200 && !text.includes("secret frame bytes"),
        `status ${response.status}`
      );
    }

    console.log("\n6. Malformed storage key and path traversal on the media route");
    {
      const hostile = [
        "../../../../etc/passwd",
        `projects/${ownerProject.id}/../../etc/passwd`,
        "/etc/passwd",
        `projects/${ownerProject.id}/assets/x/original.png%00.txt`,
        "",
      ];
      let worst = 0;
      for (const candidate of hostile) {
        const secret = process.env.MEDIA_URL_SECRET || process.env.AUTH_SECRET || "development-only";
        const expires = Math.floor(Date.now() / 1000) + 300;
        // Signed by the *real* secret: the attacker is assumed to have somehow
        // obtained a valid signature, and the key must still be refused.
        const url = `/api/media?key=${encodeURIComponent(candidate)}&expires=${expires}&signature=${signKey(secret, candidate, expires)}`;
        const response = await ownerSession.fetch(url);
        const text = await response.text();
        if (response.status !== 404 || text.includes("root:")) worst = 1;
      }
      check("a malformed or traversing key is refused even when validly signed", worst === 0);
    }

    console.log("\n7. Cross-project asset rows");
    {
      // An asset row moved under the stranger's project must become visible to
      // them and invisible to the owner — proving the check reads the row's
      // project rather than anything cached in the URL or the key.
      const moved = await prisma.asset.create({
        data: {
          projectId: strangerProject.id,
          type: "IMAGE",
          source: "UPLOADED",
          storageProvider: "LOCAL",
          // Deliberately the OWNER's key, under the STRANGER's project.
          storageKey: key,
          mimeType: "image/png",
          fileSize: body.byteLength,
        },
      });
      const ownerTry = await ownerSession.fetch(`/api/assets/${moved.id}/file`);
      check(
        "the project on the row decides access, not the key inside it",
        ownerTry.status === 404,
        `owner got ${ownerTry.status} for a row in the stranger's project`
      );
      await prisma.asset.delete({ where: { id: moved.id } });
    }

    console.log("\n8. Range requests");
    {
      const response = await ownerSession.fetch(filePath, { headers: { range: "bytes=0-4" } });
      const bytes = Buffer.from(await response.arrayBuffer());
      check(
        "a range request is answered with 206 and only that range",
        response.status === 206 && bytes.equals(body.subarray(0, 5)),
        `status ${response.status}, ${bytes.byteLength} bytes, ${response.headers.get("content-range")}`
      );

      const bad = await ownerSession.fetch(filePath, { headers: { range: `bytes=${body.byteLength + 10}-` } });
      check("an unsatisfiable range is 416", bad.status === 416, `status ${bad.status}`);

      const strangerRange = await strangerSession.fetch(filePath, { headers: { range: "bytes=0-4" } });
      check(
        "a range request does not bypass the access check",
        strangerRange.status === 404,
        `status ${strangerRange.status}`
      );
    }

    console.log("\n9. Project pages");
    {
      const response = await strangerSession.fetch(`/projects/${ownerProject.id}/visualization`);
      check(
        "the stranger cannot open the owner's project, so its upload and delete controls are unreachable",
        response.status === 404 || response.status === 403 || response.status === 307,
        `status ${response.status}`
      );
    }

    // --- cleanup ----------------------------------------------------------
    await prisma.project.deleteMany({ where: { id: { in: [ownerProject.id, strangerProject.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
    await storage.delete(key);
    await prisma.$disconnect();
  } finally {
    if (server.pid) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        server.kill("SIGKILL");
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
