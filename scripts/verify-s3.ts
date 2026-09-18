/**
 * S3 adapter verification against a real S3-protocol server.
 *
 * This starts a minimal S3-compatible object server on localhost and drives the
 * production `S3StorageProvider` against it over real HTTP, with real AWS
 * SigV4-signed requests produced by the AWS SDK. It proves the adapter speaks
 * the protocol — PUT/GET/HEAD/DELETE, byte ranges, and presigned URLs.
 *
 * What it does NOT prove: that any particular vendor (AWS, R2, MinIO, B2)
 * accepts these requests. The mock implements the subset of the protocol this
 * application uses and is deliberately lenient about signatures. Pointing
 * S3_ENDPOINT at a real bucket and re-running the same checks is the step that
 * proves a specific provider, and it has not been run here.
 *
 *     npm run verify:s3
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { S3StorageProvider } from "../src/lib/storage/s3.ts";
import { buildAssetKey } from "../src/lib/storage/keys.ts";
import { ObjectNotFoundError } from "../src/lib/storage/types.ts";

const BUCKET = "filmmaker-test";
const PROJECT = "clx0000000000000000000009";

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

interface StoredObject {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
}

/** Records what the SDK actually sent, so the adapter's behaviour is observable. */
const seen: { method: string; path: string; authorization: boolean; range?: string }[] = [];

function s3Mock(store: Map<string, StoredObject>) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Path-style addressing: /{bucket}/{key...}
    const segments = url.pathname.replace(/^\//, "").split("/");
    const bucket = segments.shift();
    const key = segments.join("/");

    seen.push({
      method: req.method ?? "",
      path: url.pathname,
      authorization: Boolean(req.headers.authorization || url.searchParams.has("X-Amz-Signature")),
      range: req.headers.range,
    });

    if (bucket !== BUCKET) {
      res.writeHead(404).end("<Error><Code>NoSuchBucket</Code></Error>");
      return;
    }

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const metadata: Record<string, string> = {};
        for (const [header, value] of Object.entries(req.headers)) {
          if (header.startsWith("x-amz-meta-")) metadata[header.slice("x-amz-meta-".length)] = String(value);
        }
        store.set(key, {
          body,
          contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
          metadata,
        });
        res.writeHead(200, { ETag: `"${createHash("md5").update(body).digest("hex")}"` }).end();
      });
      return;
    }

    const object = store.get(key);
    if (!object) {
      res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }

    if (req.method === "DELETE") {
      store.delete(key);
      res.writeHead(204).end();
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": object.contentType,
      "Last-Modified": new Date().toUTCString(),
    };
    for (const [k, v] of Object.entries(object.metadata)) headers[`x-amz-meta-${k}`] = v;

    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range) {
      const start = Number(range[1]);
      const end = range[2] === "" ? object.body.byteLength - 1 : Math.min(Number(range[2]), object.body.byteLength - 1);
      const slice = object.body.subarray(start, end + 1);
      res
        .writeHead(206, {
          ...headers,
          "Content-Length": String(slice.byteLength),
          "Content-Range": `bytes ${start}-${end}/${object.body.byteLength}`,
        })
        .end(req.method === "HEAD" ? undefined : slice);
      return;
    }

    res.writeHead(200, { ...headers, "Content-Length": String(object.body.byteLength) });
    res.end(req.method === "HEAD" ? undefined : object.body);
  };
}

async function main(): Promise<void> {
  const store = new Map<string, StoredObject>();
  const server = createServer(s3Mock(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}`;
  console.log(`Mock S3 listening on ${endpoint}\n`);

  const provider = new S3StorageProvider({
    bucket: BUCKET,
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
  });

  try {
    const key = buildAssetKey(PROJECT, "video/mp4");
    const body = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    const sha = createHash("sha256").update(body).digest("hex");

    const stored = await provider.put(key, body, { contentType: "video/mp4", size: body.byteLength });
    check("put stores the object and reports its checksum", stored.checksum === sha, stored.checksum.slice(0, 16));
    check("put lands it at the exact key", store.has(key), key);
    check(
      "put records the checksum as object metadata, so a bucket can be reconciled later",
      store.get(key)?.metadata.sha256 === sha
    );
    check("put sends the content type through", store.get(key)?.contentType === "video/mp4");

    const fetched = await provider.get(key);
    check("get returns the exact bytes", fetched.equals(body), `${fetched.byteLength} bytes`);

    const ranged = await provider.getRange(key, 10, 14);
    check(
      "getRange asks the server for a range rather than downloading the object",
      ranged.toString() === "abcde" && seen.some((r) => r.range === "bytes=10-14"),
      ranged.toString()
    );

    const meta = await provider.head(key);
    check("head reports size and type without transferring the body", meta?.size === body.byteLength, `${meta?.size}`);
    check("exists is true for a stored object", (await provider.exists(key)) === true);

    const missing = buildAssetKey(PROJECT, "image/png");
    check("exists is false for an absent object", (await provider.exists(missing)) === false);
    let notFound = false;
    try {
      await provider.get(missing);
    } catch (err) {
      notFound = err instanceof ObjectNotFoundError;
    }
    check("get on an absent object raises ObjectNotFound, not a vendor error", notFound);

    const signed = await provider.signedDownloadUrl(key, { expiresInSeconds: 60 });
    const signedUrl = new URL(signed.url);
    check(
      "the presigned URL is signed and time-limited",
      signedUrl.searchParams.has("X-Amz-Signature") && signedUrl.searchParams.get("X-Amz-Expires") === "60",
      `expires in ${signedUrl.searchParams.get("X-Amz-Expires")}s`
    );
    check(
      "the presigned URL carries no secret key",
      !signed.url.includes("test-secret-key"),
      "secret absent from the URL"
    );
    const viaSignedUrl = await fetch(signed.url);
    const signedBytes = Buffer.from(await viaSignedUrl.arrayBuffer());
    check("the presigned URL actually serves the object", signedBytes.equals(body), `${signedBytes.byteLength} bytes`);

    await provider.delete(key);
    check("delete removes the object", !store.has(key));
    await provider.delete(key);
    check("deleting an absent object is not an error", true, "idempotent");

    check(
      "the adapter never describes itself with a credential",
      !provider.description.includes("test-secret-key") && !provider.description.includes("test-access-key"),
      provider.description
    );
    check(
      "every request was authenticated",
      seen.length > 0 && seen.every((r) => r.authorization),
      `${seen.length} requests`
    );
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
