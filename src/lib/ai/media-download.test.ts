import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { MediaDownloadError, downloadWithLimit } from "./media-download.ts";

/**
 * The download ceiling has to hold against a real HTTP stream.
 *
 * These run against a local server rather than a mocked `fetch`, because the
 * property under test is what happens to a *transfer in progress* — a fake that
 * resolves with a whole body at once cannot demonstrate that the limit is
 * enforced before the bytes are all in memory.
 */

let baseUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let seenAuthorization: string | undefined;

const server = createServer((req, res) => {
  seenAuthorization = req.headers.authorization;
  handler(req, res);
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

/** Streams `total` bytes in small chunks, so a cap can bite part-way through. */
function streamBytes(total: number, declareLength: boolean) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string> = { "content-type": "video/mp4" };
    if (declareLength) headers["content-length"] = String(total);
    res.writeHead(200, headers);

    const chunk = Buffer.alloc(16 * 1024, 0x61);
    let sent = 0;
    const push = () => {
      while (sent < total) {
        const size = Math.min(chunk.byteLength, total - sent);
        sent += size;
        if (!res.write(chunk.subarray(0, size))) {
          res.once("drain", push);
          return;
        }
      }
      res.end();
    };
    push();
  };
}

describe("a normal download", () => {
  it("returns the bytes and the advertised content type", async () => {
    handler = (_req, res) =>
      res.writeHead(200, { "content-type": "video/webm" }).end(Buffer.from("some video bytes"));

    const result = await downloadWithLimit(`${baseUrl}/clip`, { maxBytes: 1_000_000 });
    assert.equal(result.bytes.toString(), "some video bytes");
    assert.equal(result.contentType, "video/webm");
  });

  it("sends the caller's headers, and nothing invents one", async () => {
    handler = (_req, res) => res.writeHead(200).end("ok-bytes");
    seenAuthorization = undefined;

    await downloadWithLimit(`${baseUrl}/clip`, {
      maxBytes: 1_000,
      headers: { Authorization: "Bearer provider-token" },
    });
    assert.equal(seenAuthorization, "Bearer provider-token");
  });

  it("accepts a download exactly at the limit", async () => {
    handler = streamBytes(64 * 1024, true);
    const result = await downloadWithLimit(`${baseUrl}/clip`, { maxBytes: 64 * 1024 });
    assert.equal(result.bytes.byteLength, 64 * 1024);
  });
});

describe("the size ceiling", () => {
  it("refuses before reading a byte when the declared length is over the limit", async () => {
    handler = streamBytes(5 * 1024 * 1024, true);

    await assert.rejects(
      () => downloadWithLimit(`${baseUrl}/clip`, { maxBytes: 1024 * 1024 }),
      (error: unknown) =>
        error instanceof MediaDownloadError &&
        error.kind === "too-large" &&
        /the limit is 1MB/.test(error.message)
    );
  });

  it("still stops a transfer that declares no length at all", async () => {
    // The case the content-length check cannot catch: chunked, or a server that
    // simply omits it. This is what makes the limit real.
    handler = streamBytes(4 * 1024 * 1024, false);

    await assert.rejects(
      () => downloadWithLimit(`${baseUrl}/clip`, { maxBytes: 256 * 1024 }),
      (error: unknown) =>
        error instanceof MediaDownloadError &&
        error.kind === "too-large" &&
        /the download was stopped/.test(error.message)
    );
  });

  it("enforces the ceiling after a redirect, not before it", async () => {
    // How providers actually serve a rendered file: the job response points at a
    // short-lived CDN URL. A limit applied only to the first hop would never see
    // the bytes.
    handler = (req, res) => {
      if (req.url === "/clip") {
        res.writeHead(302, { location: `${baseUrl}/cdn` }).end();
        return;
      }
      streamBytes(4 * 1024 * 1024, false)(req, res);
    };

    await assert.rejects(
      () => downloadWithLimit(`${baseUrl}/clip`, { maxBytes: 256 * 1024 }),
      (error: unknown) => error instanceof MediaDownloadError && error.kind === "too-large"
    );
  });

  it("follows a redirect and returns the redirected body", async () => {
    handler = (req, res) => {
      if (req.url === "/clip") {
        res.writeHead(302, { location: `${baseUrl}/cdn` }).end();
        return;
      }
      res.writeHead(200, { "content-type": "video/mp4" }).end(Buffer.from("cdn video bytes"));
    };

    const result = await downloadWithLimit(`${baseUrl}/clip`, { maxBytes: 1_000_000 });
    assert.equal(result.bytes.toString(), "cdn video bytes");
    assert.equal(result.contentType, "video/mp4");
  });
});

describe("failures", () => {
  it("reports a non-2xx status rather than storing the error body", async () => {
    handler = (_req, res) =>
      res.writeHead(404, { "content-type": "text/html" }).end("<html>not found</html>");

    await assert.rejects(
      () => downloadWithLimit(`${baseUrl}/missing`, { maxBytes: 1_000_000 }),
      (error: unknown) =>
        error instanceof MediaDownloadError &&
        error.kind === "bad-status" &&
        /answered 404/.test(error.message)
    );
  });

  it("reports an empty body", async () => {
    handler = (_req, res) => res.writeHead(200, { "content-type": "video/mp4" }).end();

    await assert.rejects(
      () => downloadWithLimit(`${baseUrl}/empty`, { maxBytes: 1_000 }),
      (error: unknown) => error instanceof MediaDownloadError && error.kind === "empty"
    );
  });

  it("reports an unreachable endpoint as a transport failure", async () => {
    await assert.rejects(
      () => downloadWithLimit("http://127.0.0.1:1/clip", { maxBytes: 1_000 }),
      (error: unknown) => error instanceof MediaDownloadError && error.kind === "transport"
    );
  });

  it("hands back an HTML page rather than judging it — the parser decides", async () => {
    // A 200 carrying HTML is a *download* success and a *media* failure. Keeping
    // that judgement in one place means the bytes always decide, never a header.
    handler = (_req, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end("<html><body>error</body></html>");

    const result = await downloadWithLimit(`${baseUrl}/clip`, { maxBytes: 1_000_000 });
    assert.equal(result.contentType, "text/html");
    assert.match(result.bytes.toString(), /<html>/);
  });
});
