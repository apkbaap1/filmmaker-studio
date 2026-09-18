import { NextResponse } from "next/server";
import { authorizeAsset, readAssetBytes, readAssetRange } from "@/lib/media";

/**
 * Serves one asset's bytes to a signed-in member of its project.
 *
 * The whole authorization decision lives in `authorizeAsset`: this route holds
 * no `prisma` query and no ownership logic of its own, so there is exactly one
 * place where "may this user see this asset" is answered. The storage key never
 * appears in the URL — an asset id that the caller is not entitled to is a 404
 * indistinguishable from one that does not exist.
 *
 * `Range` is honoured so a browser can seek inside a previsualization clip
 * instead of downloading it from the top every time the playhead moves.
 */
export async function GET(req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;

  const access = await authorizeAsset(assetId);
  if (!access.ok) {
    return new NextResponse(access.status === 401 ? "Unauthorized" : "Not found", {
      status: access.status,
    });
  }
  const { asset } = access;

  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType,
    // Private: this response is scoped to one user's session and must never be
    // held in a shared cache where the next user could be served it.
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline",
    // The bytes are user-supplied; refuse to let a browser sniff them into
    // something executable.
    "X-Content-Type-Options": "nosniff",
  };

  const range = parseRange(req.headers.get("range"), asset.fileSize);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${asset.fileSize}`, "Accept-Ranges": "bytes" },
    });
  }

  try {
    if (range) {
      const buffer = await readAssetRange(asset, range.start, range.end);
      return new NextResponse(new Uint8Array(buffer), {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${range.start}-${range.end}/${asset.fileSize}`,
          "Content-Length": String(buffer.byteLength),
        },
      });
    }

    const buffer = await readAssetBytes(asset);
    return new NextResponse(new Uint8Array(buffer), {
      headers: { ...headers, "Content-Length": String(buffer.byteLength) },
    });
  } catch {
    // The row exists and the user may see it, but the object is gone. That is a
    // genuine 404 for the bytes, and it is worth being distinguishable from a
    // permission failure in the message because only the owner ever sees it.
    return new NextResponse("File missing", { status: 404 });
  }
}

type ParsedRange = { start: number; end: number };

/**
 * Parses a single-range `bytes=` header.
 *
 * Multi-range requests are deliberately not implemented: browsers use them for
 * PDFs, not for media playback, and answering one wrongly is worse than
 * ignoring the header and sending the whole object.
 */
function parseRange(header: string | null, size: number): ParsedRange | "unsatisfiable" | undefined {
  if (!header || size <= 0) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === "") {
    // "-500" means the last 500 bytes.
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

  // A range covering the entire object is served as a normal 200.
  if (start === 0 && end === size - 1) return undefined;
  return { start, end };
}
