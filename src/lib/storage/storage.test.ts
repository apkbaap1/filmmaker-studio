import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  MAX_BYTES,
  MediaTooLargeError,
  UnsupportedMediaError,
  assertStorableMedia,
  assertValidKey,
  buildAssetKey,
  canonicaliseLegacyKey,
  isLegacyKey,
  isSupportedMimeType,
  keyBelongsToProject,
  maxBytesFor,
} from "./keys.ts";
import { InvalidStorageKeyError, ObjectNotFoundError } from "./types.ts";
import { LocalStorageProvider, signKey, verifySignedKey } from "./local.ts";

const PROJECT = "clx0000000000000000000001";
const OTHER_PROJECT = "clx0000000000000000000002";

async function tempProvider(): Promise<{ provider: LocalStorageProvider; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "fms-storage-"));
  return { provider: new LocalStorageProvider(root), root };
}

describe("storage keys", () => {
  it("builds a key from the project and the verified MIME type only", () => {
    const key = buildAssetKey(PROJECT, "image/png");
    assert.match(key, new RegExp(`^projects/${PROJECT}/assets/[0-9a-f-]{36}/original\\.png$`));
  });

  it("never lets a user-supplied filename reach the key", () => {
    // There is no filename parameter at all — that is the point. Two uploads of
    // the same file get different keys, so one can never overwrite the other.
    const a = buildAssetKey(PROJECT, "image/png");
    const b = buildAssetKey(PROJECT, "image/png");
    assert.notEqual(a, b);
  });

  it("refuses a MIME type that is not on the allow-list", () => {
    assert.equal(isSupportedMimeType("application/x-sh"), false);
    assert.equal(isSupportedMimeType("text/html"), false);
    assert.equal(isSupportedMimeType("image/svg+xml"), false, "SVG can carry script; not accepted");
    assert.throws(() => buildAssetKey(PROJECT, "application/x-sh"), InvalidStorageKeyError);
  });

  it("refuses a project id that is not a plausible id", () => {
    for (const bad of ["../../etc", "a", "project id", "proj/ect", ""]) {
      assert.throws(() => buildAssetKey(bad, "image/png"), InvalidStorageKeyError, bad);
    }
  });

  it("rejects traversal in every encoding the pattern could otherwise admit", () => {
    const traversals = [
      "../../../etc/passwd",
      `projects/${PROJECT}/assets/../../../etc/passwd`,
      `projects/${PROJECT}/../${OTHER_PROJECT}/assets/x/original.png`,
      `/projects/${PROJECT}/assets/x/original.png`,
      `projects//${PROJECT}/assets/x/original.png`,
      "..",
      "./original.png",
      `projects/${PROJECT}/assets/%2e%2e%2f/original.png`,
      `projects/${PROJECT}/assets/x/original.png\0.txt`,
    ];
    for (const key of traversals) {
      assert.throws(() => assertValidKey(key), InvalidStorageKeyError, key);
    }
  });

  it("rejects a malformed key that is merely wrong rather than hostile", () => {
    for (const key of ["", "projects/", "original.png", `projects/${PROJECT}/assets/x/original`]) {
      assert.throws(() => assertValidKey(key), InvalidStorageKeyError, JSON.stringify(key));
    }
    // Not a string at all — the database column is typed, but a cast could lie.
    assert.throws(() => assertValidKey(undefined as unknown as string), InvalidStorageKeyError);
    assert.throws(() => assertValidKey(42 as unknown as string), InvalidStorageKeyError);
  });

  it("still accepts pre-existing legacy keys so old assets keep working", () => {
    const legacy = `${PROJECT}/123e4567-e89b-12d3-a456-426614174000.png`;
    assert.equal(isLegacyKey(legacy), true);
    assert.equal(assertValidKey(legacy), legacy);
    assert.equal(
      canonicaliseLegacyKey(legacy, PROJECT),
      `projects/${PROJECT}/assets/123e4567-e89b-12d3-a456-426614174000/original.png`
    );
  });

  it("reports project membership for diagnostics without claiming it is authorization", () => {
    const key = buildAssetKey(PROJECT, "image/png");
    assert.equal(keyBelongsToProject(key, PROJECT), true);
    assert.equal(keyBelongsToProject(key, OTHER_PROJECT), false);
  });

  it("sets a size ceiling per kind", () => {
    assert.equal(maxBytesFor("image/png"), MAX_BYTES.image);
    assert.equal(maxBytesFor("video/mp4"), MAX_BYTES.video);
    assert.equal(maxBytesFor("application/pdf"), MAX_BYTES.other);
    assert.ok(MAX_BYTES.video > MAX_BYTES.image, "a clip may be larger than a still");
  });
});

describe("local storage provider", () => {
  it("round-trips an object and reports its checksum", async () => {
    const { provider } = await tempProvider();
    const key = buildAssetKey(PROJECT, "image/png");
    const body = Buffer.from("not really a png, but bytes are bytes");

    const stored = await provider.put(key, body, { contentType: "image/png" });
    assert.equal(stored.key, key);
    assert.equal(stored.size, body.byteLength);
    assert.match(stored.checksum, /^[0-9a-f]{64}$/);

    assert.deepEqual(await provider.get(key), body);
    assert.equal(await provider.exists(key), true);
  });

  it("writes the object inside the storage root and nowhere else", async () => {
    const { provider, root } = await tempProvider();
    const key = buildAssetKey(PROJECT, "image/png");
    await provider.put(key, Buffer.from("x"), { contentType: "image/png" });
    assert.deepEqual(await readFile(path.join(root, key)), Buffer.from("x"));
  });

  it("refuses to read, write or delete outside the storage root", async () => {
    const { provider, root } = await tempProvider();
    // A real file next door, to prove the refusal is not merely "file missing".
    const outside = path.join(path.dirname(root), "outside-secret.txt");
    await writeFile(outside, "secret");

    const escape = `../${path.basename(outside)}`;

    // A read fails, and fails as *not found* rather than as *invalid key*: the
    // error must not tell a prober which of their guesses was well-formed.
    await assert.rejects(() => provider.get(escape), ObjectNotFoundError);
    await assert.equal(await provider.exists(escape), false);
    await assert.equal(await provider.head(escape), undefined);

    // A write is refused outright.
    await assert.rejects(
      () => provider.put(escape, Buffer.from("overwritten"), { contentType: "image/png" }),
      InvalidStorageKeyError
    );

    // A delete is a silent no-op — "already gone" is its success condition, and
    // what matters is that it did not reach the file.
    await provider.delete(escape);

    // The one assertion that actually proves containment.
    assert.equal(await readFile(outside, "utf8"), "secret", "the neighbouring file is untouched");
  });

  it("reports a missing object as missing rather than as an empty one", async () => {
    const { provider } = await tempProvider();
    await assert.rejects(() => provider.get(buildAssetKey(PROJECT, "image/png")), ObjectNotFoundError);
    assert.equal(await provider.exists(buildAssetKey(PROJECT, "image/png")), false);
    assert.equal(await provider.head(buildAssetKey(PROJECT, "image/png")), undefined);
  });

  it("serves a byte range without reading the whole object", async () => {
    const { provider } = await tempProvider();
    const key = buildAssetKey(PROJECT, "video/mp4");
    const body = Buffer.from("0123456789abcdefghij");
    await provider.put(key, body, { contentType: "video/mp4" });

    assert.equal((await provider.getRange(key, 0, 3)).toString(), "0123");
    assert.equal((await provider.getRange(key, 10, 14)).toString(), "abcde");
    assert.equal((await provider.getRange(key, 15, 999)).toString(), "fghij", "clamps past the end");
  });
});

describe("signed download URLs", () => {
  const SECRET = "test-signing-secret";

  it("issues a URL carrying the key, an expiry and a signature over both", async () => {
    const { provider } = await tempProvider();
    const key = buildAssetKey(PROJECT, "image/png");
    const { url, expiresAt } = await provider.signedDownloadUrl(key, { expiresInSeconds: 60 });

    const parsed = new URL(url, "http://localhost");
    assert.equal(parsed.pathname, "/api/media");
    assert.equal(parsed.searchParams.get("key"), key);
    assert.ok(parsed.searchParams.get("signature"));
    assert.ok(expiresAt.getTime() > Date.now());
  });

  it("rejects an expired URL even though its signature is valid", () => {
    const key = buildAssetKey(PROJECT, "image/png");
    const expired = Math.floor(Date.now() / 1000) - 1;
    const signature = signKey(SECRET, key, expired);

    const result = verifySignedKey(SECRET, key, expired, signature);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "expired");
  });

  it("rejects a URL whose expiry was extended in the address bar", () => {
    const key = buildAssetKey(PROJECT, "image/png");
    const expires = Math.floor(Date.now() / 1000) - 1;
    const signature = signKey(SECRET, key, expires);

    // The attacker pushes the expiry a year out, keeping the old signature.
    const forged = verifySignedKey(SECRET, key, expires + 31_536_000, signature);
    assert.equal(forged.ok, false);
    assert.equal(forged.ok === false && forged.reason, "bad-signature");
  });

  it("rejects a URL whose key was swapped for another project's", () => {
    const mine = buildAssetKey(PROJECT, "image/png");
    const theirs = buildAssetKey(OTHER_PROJECT, "image/png");
    const expires = Math.floor(Date.now() / 1000) + 300;
    const signature = signKey(SECRET, mine, expires);

    const swapped = verifySignedKey(SECRET, theirs, expires, signature);
    assert.equal(swapped.ok, false);
    assert.equal(swapped.ok === false && swapped.reason, "bad-signature");
  });

  it("rejects a signature made with a different secret", () => {
    const key = buildAssetKey(PROJECT, "image/png");
    const expires = Math.floor(Date.now() / 1000) + 300;
    const result = verifySignedKey(SECRET, key, expires, signKey("another-secret", key, expires));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "bad-signature");
  });

  it("rejects a signature of the wrong length or shape without throwing", () => {
    const key = buildAssetKey(PROJECT, "image/png");
    const expires = Math.floor(Date.now() / 1000) + 300;
    for (const signature of ["", "deadbeef", "x".repeat(64), "../../etc/passwd"]) {
      const result = verifySignedKey(SECRET, key, expires, signature);
      assert.equal(result.ok, false, JSON.stringify(signature));
    }
  });

  it("accepts a URL that is correctly signed and not yet expired", () => {
    const key = buildAssetKey(PROJECT, "image/png");
    const expires = Math.floor(Date.now() / 1000) + 300;
    assert.deepEqual(verifySignedKey(SECRET, key, expires, signKey(SECRET, key, expires)), { ok: true });
  });
});

describe("legacy local objects", () => {
  it("reads an object stored under a pre-migration key", async () => {
    const { provider, root } = await tempProvider();
    const legacy = `${PROJECT}/123e4567-e89b-12d3-a456-426614174000.png`;
    await mkdir(path.join(root, PROJECT), { recursive: true });
    await writeFile(path.join(root, legacy), "legacy bytes");

    assert.equal((await provider.get(legacy)).toString(), "legacy bytes");
  });
});

describe("the upload gate", () => {
  // `storeProjectMedia` calls exactly this function before it builds a key or
  // touches a provider, so these are the real limits the real upload enforces.

  it("accepts the media the application supports", () => {
    assert.doesNotThrow(() => assertStorableMedia("image/png", 1024));
    assert.doesNotThrow(() => assertStorableMedia("video/mp4", 400 * 1024 * 1024));
    assert.doesNotThrow(() => assertStorableMedia("application/pdf", 1024));
    assert.doesNotThrow(() => assertStorableMedia("image/png", 0), "an empty file is a caller concern, not a storage one");
  });

  it("rejects an unsupported MIME type", () => {
    for (const mimeType of [
      "text/html",
      "image/svg+xml",
      "application/x-sh",
      "application/javascript",
      "",
      "image/png; charset=utf-8",
    ]) {
      assert.throws(() => assertStorableMedia(mimeType, 1024), UnsupportedMediaError, mimeType);
    }
  });

  it("rejects an oversized upload, per kind", () => {
    assert.throws(() => assertStorableMedia("image/png", MAX_BYTES.image + 1), MediaTooLargeError);
    assert.throws(() => assertStorableMedia("video/mp4", MAX_BYTES.video + 1), MediaTooLargeError);
    assert.throws(() => assertStorableMedia("application/pdf", MAX_BYTES.other + 1), MediaTooLargeError);

    // A still at the video ceiling is still too large: the limits do not leak
    // into each other.
    assert.throws(() => assertStorableMedia("image/png", MAX_BYTES.video), MediaTooLargeError);
  });

  it("rejects a nonsensical size rather than trusting it", () => {
    for (const size of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => assertStorableMedia("image/png", size), MediaTooLargeError, String(size));
    }
  });

  it("reports the limit without leaking anything else", () => {
    try {
      assertStorableMedia("image/png", MAX_BYTES.image + 1);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof MediaTooLargeError);
      assert.match(err.message, /limit is 25MB/);
    }
  });

  it("truncates a hostile MIME type in its error message", () => {
    const hostile = "x/".repeat(500);
    try {
      assertStorableMedia(hostile, 10);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof UnsupportedMediaError);
      assert.ok(err.message.length < 140, `message was ${err.message.length} characters`);
    }
  });
});
