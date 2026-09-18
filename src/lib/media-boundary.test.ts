import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Static audit of the media authorization boundary.
 *
 * The bug this exists to prevent is a *shape*, not a value: somewhere down the
 * line a new route reads an Asset by id, gets its storage key and serves the
 * bytes, skipping the project check because the key "looked scoped". No runtime
 * test catches that in code nobody wrote yet, so the shape is asserted over the
 * real source instead — the same approach `src/lib/authz.test.ts` takes for
 * cross-project writes.
 */

const SRC = path.resolve(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = sourceFiles(SRC).map((file) => ({
  file,
  rel: path.relative(SRC, file),
  source: readFileSync(file, "utf8"),
}));

/**
 * Strips comments, so an assertion about what the code *does* is not satisfied
 * — or broken — by prose describing what it deliberately does not do.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const MEDIA = path.join(SRC, "lib", "media.ts");
const MEDIA_ROUTE = path.join(SRC, "app", "api", "media", "route.ts");
const ASSET_ROUTE = path.join(SRC, "app", "api", "assets", "[assetId]", "file", "route.ts");

describe("the media boundary", () => {
  it("finds the modules it is auditing", () => {
    assert.ok(existsSync(MEDIA), "src/lib/media.ts moved — update this test");
    assert.ok(existsSync(MEDIA_ROUTE), "src/app/api/media/route.ts moved — update this test");
    assert.ok(existsSync(ASSET_ROUTE), "the asset file route moved — update this test");
    assert.ok(files.length > 50, "the source walk found suspiciously little");
  });

  it("has no second storage module left behind", () => {
    assert.ok(
      !existsSync(path.join(SRC, "lib", "storage.ts")),
      "src/lib/storage.ts is back — there must be exactly one storage layer"
    );
  });

  it("no longer references the removed Asset.filePath column", () => {
    const stragglers = files
      .filter((f) => /\bfilePath\b/.test(f.source))
      .map((f) => f.rel);
    assert.deepEqual(stragglers, [], `these still reference filePath: ${stragglers}`);
  });

  it("only the media module and its own route reach a storage provider", () => {
    // Everything else goes through src/lib/media.ts, which is where the project
    // check lives. A direct provider import elsewhere is how that check gets
    // skipped.
    const allowed = new Set([MEDIA, MEDIA_ROUTE]);
    const offenders = files
      .filter((f) => !allowed.has(f.file))
      .filter((f) => !f.rel.startsWith(path.join("lib", "storage")))
      .filter((f) =>
        /from\s+["'](@\/lib\/storage(\/[a-z0-9-]+)?|\.\.?\/storage(\/[a-z0-9-]+)?)["']/.test(f.source)
      )
      .map((f) => f.rel);

    assert.deepEqual(offenders, [], `these reach storage without going through media.ts: ${offenders}`);
  });

  it("serves no asset without authorizeAsset deciding first", () => {
    const route = readFileSync(ASSET_ROUTE, "utf8");
    assert.ok(route.includes("authorizeAsset"), "the asset route must call authorizeAsset");
    assert.ok(
      !/prisma\./.test(code(route)),
      "the asset route must hold no database query of its own — the check lives in media.ts"
    );
    // The bytes are only reached on the authorized branch.
    const authorizeAt = route.indexOf("authorizeAsset(");
    for (const reader of ["readAssetBytes(", "readAssetRange("]) {
      const at = route.indexOf(reader);
      assert.ok(at > authorizeAt, `${reader} must come after the authorization call`);
    }
  });

  it("decides access from the Asset's project, not from its storage key", () => {
    const media = readFileSync(MEDIA, "utf8");
    assert.ok(
      /project:\s*\{[\s\S]*ownerId:\s*session\.user\.id[\s\S]*members:/.test(media),
      "authorizeAsset must join through the project's owner and members"
    );
    assert.ok(
      !/keyBelongsToProject/.test(code(media)),
      "the key must never be consulted as an access check"
    );
  });

  it("cannot issue a signed URL for an asset that was never authorized", () => {
    const media = readFileSync(MEDIA, "utf8");
    // The type is the guard: these take an AuthorizedAsset, which only
    // authorizeAsset produces.
    for (const fn of ["signedUrlForAsset", "readAssetBytes", "readAssetRange"]) {
      const signature = new RegExp(`function ${fn}\\(\\s*asset: AuthorizedAsset`);
      assert.match(media, signature, `${fn} must take an AuthorizedAsset, not an id or a key`);
    }
  });

  it("gates every stored byte on type and size before it reaches a provider", () => {
    const media = readFileSync(MEDIA, "utf8");
    const gate = media.indexOf("assertStorableMedia(");
    const write = media.indexOf("provider.put(");
    assert.ok(gate > 0, "storeProjectMedia must call assertStorableMedia");
    assert.ok(write > gate, "the size and type gate must come before the write");
  });

  it("builds every storage key from the project and the verified type", () => {
    const media = readFileSync(MEDIA, "utf8");
    assert.ok(media.includes("buildAssetKey(projectId, mimeType)"), "the key comes from the project and the type");
    assert.ok(
      !/file\.name|originalname|filename/i.test(code(media)),
      "no user-supplied filename may influence a key"
    );
  });

  it("records the provider alongside the key on every asset it creates", () => {
    // A key with no provider is unreadable after a migration: whoever writes a
    // row has to say which store the bytes are in.
    const creates = files.flatMap((f) => {
      const out: { rel: string; body: string }[] = [];
      const marker = "prisma.asset.create(";
      let at = f.source.indexOf(marker);
      while (at !== -1) {
        let depth = 0;
        let i = at + marker.length - 1;
        for (; i < f.source.length; i += 1) {
          if (f.source[i] === "(") depth += 1;
          else if (f.source[i] === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        out.push({ rel: f.rel, body: f.source.slice(at, i) });
        at = f.source.indexOf(marker, i);
      }
      return out;
    });

    assert.ok(creates.length > 0, "no asset creation found — update this test");
    const incomplete = creates
      .filter((c) => !(c.body.includes("storageKey") && c.body.includes("storageProvider")))
      .map((c) => c.rel);
    assert.deepEqual(incomplete, [], `these create an Asset without recording where its bytes are: ${incomplete}`);
  });

  it("refuses an unsigned or malformed key on the local media route", () => {
    const route = readFileSync(MEDIA_ROUTE, "utf8");
    assert.ok(route.includes("verifySignedKey"), "the media route must verify the signature");
    assert.ok(route.includes("assertValidKey"), "the media route must validate the key");
    const validate = route.indexOf("assertValidKey");
    const read = route.indexOf("provider.get");
    assert.ok(read > validate, "the key must be validated before anything is read");
  });

  it("exposes no storage location to the browser", () => {
    // A storage key in a client component is a key an attacker can scrape. The
    // browser addresses media by asset id, and the server resolves it.
    const leaks = files
      .filter((f) => /^\s*["']use client["']/.test(f.source))
      .filter((f) => /storageKey|storageProvider|\/api\/media\?/.test(f.source))
      .map((f) => f.rel);
    assert.deepEqual(leaks, [], `these client components handle storage locations: ${leaks}`);
  });
});
