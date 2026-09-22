import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { crc32, zipStream, ZipLimitError, type ZipEntry } from "./zip.ts";

/**
 * The ZIP writer, checked against implementations that did not come from here.
 *
 * A format writer that only passes its own reader proves nothing — the reader
 * would simply share whatever the writer got wrong. So every archive below is
 * opened by Python's `zipfile` and by the `unzip` binary, and the bytes that
 * come back out are compared to the bytes that went in.
 */

const workspace = mkdtempSync(path.join(tmpdir(), "zip-test-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

const FIXED = new Date("2026-03-04T05:06:08Z");

async function archive(entries: ZipEntry[]): Promise<Buffer> {
  async function* source() {
    for (const entry of entries) yield { modifiedAt: FIXED, ...entry };
  }
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(source())) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Writes the archive to disk and returns its path, for the external readers. */
function onDisk(name: string, bytes: Buffer): string {
  const file = path.join(workspace, name);
  writeFileSync(file, bytes);
  return file;
}

/** Reads every entry back with Python's zipfile — an independent implementation. */
function readWithPython(file: string): Record<string, string> {
  const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    if bad is not None:
        raise SystemExit("CRC failure in " + bad)
    print(json.dumps({n: z.read(n).decode("utf8", "surrogateescape") for n in z.namelist()}))
`;
  const out = execFileSync("python3", ["-c", script, file], { encoding: "utf8" });
  return JSON.parse(out) as Record<string, string>;
}

describe("CRC-32", () => {
  it("matches the published check values", () => {
    // The standard vector: CRC-32 of "123456789" is 0xCBF43926.
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)), 0);
    assert.equal(crc32(Buffer.from("a")), 0xe8b7be43);
  });

  it("returns an unsigned value, so the header field is never negative", () => {
    for (const sample of ["", "a", "The quick brown fox", "ÿþ"]) {
      const value = crc32(Buffer.from(sample));
      assert.ok(value >= 0 && value <= 0xffff_ffff, `${sample} produced ${value}`);
    }
  });
});

describe("the archive opens in other implementations", () => {
  it("round-trips through Python's zipfile with the CRCs intact", async () => {
    const bytes = await archive([
      { path: "manifest.json", bytes: Buffer.from('{"ok":true}') },
      { path: "assets/one.txt", bytes: Buffer.from("first") },
      { path: "assets/two.txt", bytes: Buffer.from("second") },
    ]);

    const read = readWithPython(onDisk("basic.zip", bytes));
    assert.deepEqual(read, {
      "manifest.json": '{"ok":true}',
      "assets/one.txt": "first",
      "assets/two.txt": "second",
    });
  });

  it("passes unzip's own integrity check", async () => {
    const bytes = await archive([
      { path: "a.bin", bytes: Buffer.from([0, 1, 2, 250, 251, 255]) },
      { path: "nested/deep/b.txt", bytes: Buffer.from("deep") },
    ]);
    const file = onDisk("integrity.zip", bytes);

    const out = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.match(out, /No errors detected/);
  });

  it("preserves binary content byte for byte", async () => {
    // Every byte value, so a signed/unsigned slip anywhere would show up.
    const every = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const bytes = await archive([{ path: "all-bytes.bin", bytes: every }]);
    const file = onDisk("binary.zip", bytes);

    const script = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    sys.stdout.write(",".join(str(b) for b in z.read("all-bytes.bin")))
`;
    const out = execFileSync("python3", ["-c", script, file], { encoding: "utf8" });
    assert.deepEqual(
      out.split(",").map(Number),
      Array.from({ length: 256 }, (_, i) => i)
    );
  });

  it("keeps non-ASCII filenames readable", async () => {
    const bytes = await archive([{ path: "assets/scène-4-café.txt", bytes: Buffer.from("ok") }]);
    const read = readWithPython(onDisk("utf8.zip", bytes));
    assert.deepEqual(Object.keys(read), ["assets/scène-4-café.txt"]);
  });

  it("writes an empty archive that still opens", async () => {
    const bytes = await archive([]);
    assert.deepEqual(readWithPython(onDisk("empty.zip", bytes)), {});
  });

  it("handles an entry with no content", async () => {
    const bytes = await archive([{ path: "empty.txt", bytes: Buffer.alloc(0) }]);
    assert.deepEqual(readWithPython(onDisk("zero-length.zip", bytes)), { "empty.txt": "" });
  });

  it("handles an asset larger than one chunk", async () => {
    // 5 MiB of non-repeating content, so a naive buffer reuse would corrupt it.
    const large = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < large.length; i += 1) large[i] = (i * 31) & 0xff;

    const bytes = await archive([{ path: "big.bin", bytes: large }]);
    const file = onDisk("large.zip", bytes);

    const script = `
import hashlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    sys.stdout.write(hashlib.sha256(z.read("big.bin")).hexdigest())
`;
    const out = execFileSync("python3", ["-c", script, file], { encoding: "utf8" });
    const { createHash } = await import("node:crypto");
    assert.equal(out, createHash("sha256").update(large).digest("hex"));
  });
});

describe("the writer streams rather than buffering", () => {
  it("yields each entry before the next one is produced", async () => {
    const produced: string[] = [];
    const consumed: string[] = [];

    async function* source(): AsyncGenerator<ZipEntry> {
      for (const name of ["a", "b", "c"]) {
        produced.push(name);
        yield { path: name, bytes: Buffer.from(name), modifiedAt: FIXED };
      }
    }

    let bytes = 0;
    for await (const chunk of zipStream(source())) {
      bytes += chunk.length;
      consumed.push(produced[produced.length - 1]);
    }
    assert.ok(bytes > 0);

    // The producer is never more than one entry ahead: if the writer collected
    // the whole input first, "a","b","c" would all be produced before any
    // chunk came out, and this would read ["c","c",...].
    assert.equal(produced.length, 3);
    assert.equal(consumed[0], "a", "the first chunk arrived while only 'a' had been produced");
  });
});

describe("format limits are refused, not silently exceeded", () => {
  it("refuses more entries than the format can index", async () => {
    async function* many(): AsyncGenerator<ZipEntry> {
      for (let i = 0; i <= 0xffff; i += 1) {
        yield { path: `f${i}`, bytes: Buffer.alloc(0), modifiedAt: FIXED };
      }
    }

    await assert.rejects(
      (async () => {
        let bytes = 0;
        for await (const chunk of zipStream(many())) bytes += chunk.length;
        return bytes;
      })(),
      ZipLimitError
    );
  });

  it("names the limit it hit, so the failure is actionable", async () => {
    async function* many(): AsyncGenerator<ZipEntry> {
      for (let i = 0; i <= 0xffff; i += 1) {
        yield { path: `f${i}`, bytes: Buffer.alloc(0), modifiedAt: FIXED };
      }
    }
    const error = await (async () => {
      try {
        for await (const chunk of zipStream(many())) {
          assert.ok(chunk.length >= 0);
        }
      } catch (e) {
        return e as Error;
      }
      return null;
    })();

    assert.ok(error);
    assert.match(error.message, /65535 entries/);
    assert.match(error.message, /ZIP64/);
  });
});

describe("timestamps", () => {
  it("clamps a pre-1980 date rather than letting the field wrap", async () => {
    const bytes = await archive([
      { path: "old.txt", bytes: Buffer.from("x"), modifiedAt: new Date("1970-01-01T00:00:00Z") },
    ]);
    const file = onDisk("old.zip", bytes);

    const script = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    sys.stdout.write(str(z.getinfo("old.txt").date_time[0]))
`;
    const year = execFileSync("python3", ["-c", script, file], { encoding: "utf8" });
    assert.equal(year, "1980", "MS-DOS time has no year before 1980");
  });
});
