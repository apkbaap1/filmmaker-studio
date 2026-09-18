import { NextResponse } from "next/server";
import { LocalStorageProvider, mediaSigningKey, verifySignedKey } from "@/lib/storage/local";
import { assertValidKey } from "@/lib/storage/keys";
import { ObjectNotFoundError } from "@/lib/storage/types";

/**
 * Serves a locally-stored object for a signed URL.
 *
 * This is the development counterpart of an S3 presigned URL, and it works the
 * same way: the *signature* is the capability, not the key. `signedUrlForAsset`
 * mints one only after `authorizeAsset` has established that the requester may
 * see the asset, and the HMAC covers both the key and the expiry, so neither
 * can be edited in the address bar.
 *
 * A caller who has guessed or scraped a storage key, but has no signature,
 * gets a 404 — the key on its own proves nothing here, exactly as it proves
 * nothing anywhere else in the application.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature");

  if (!key || !signature || !Number.isFinite(expires)) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    assertValidKey(key);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const verified = verifySignedKey(mediaSigningKey(), key, expires, signature);
  if (!verified.ok) {
    // An expired link is reported as gone rather than forbidden: it was valid,
    // it no longer is, and the holder should ask the application for a new one.
    return new NextResponse(verified.reason === "expired" ? "Link expired" : "Not found", {
      status: verified.reason === "expired" ? 410 : 404,
    });
  }

  const provider = new LocalStorageProvider();
  const meta = await provider.head(key);
  if (!meta) return new NextResponse("Not found", { status: 404 });

  const headers: Record<string, string> = {
    // The signed URL carries no content type of its own, and the stored object
    // has none on local disk. Serving it as a generic stream keeps the browser
    // from sniffing user bytes into something executable; the asset route above
    // is what serves media with its real, database-recorded type.
    "Content-Type": "application/octet-stream",
    "Cache-Control": "private, max-age=60",
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  };

  const range = parseSingleRange(req.headers.get("range"), meta.size);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${meta.size}`, "Accept-Ranges": "bytes" },
    });
  }

  try {
    if (range) {
      const buffer = await provider.getRange(key, range.start, range.end);
      return new NextResponse(new Uint8Array(buffer), {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${range.start}-${range.end}/${meta.size}`,
          "Content-Length": String(buffer.byteLength),
        },
      });
    }
    const buffer = await provider.get(key);
    return new NextResponse(new Uint8Array(buffer), {
      headers: { ...headers, "Content-Length": String(buffer.byteLength) },
    });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return new NextResponse("Not found", { status: 404 });
    throw err;
  }
}

type ParsedRange = { start: number; end: number };

function parseSingleRange(
  header: string | null,
  size: number
): ParsedRange | "unsatisfiable" | undefined {
  if (!header || size <= 0) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === "") {
    if (rawEnd === "") return undefined;
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    if (start >= size || start < 0 || end < start) return "unsatisfiable";
    end = Math.min(end, size - 1);
  }

  if (start === 0 && end === size - 1) return undefined;
  return { start, end };
}
