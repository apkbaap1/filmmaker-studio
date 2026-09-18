/**
 * Image metadata read from the bytes themselves.
 *
 * Two jobs, and the second is the important one:
 *
 *   1. Report a generated image's true dimensions. The application records
 *      width and height on every Asset, and the only honest source for them is
 *      the file's own header. A provider's *request* said 1024×1024; that is
 *      what was asked for, not necessarily what came back, and the two must
 *      never be conflated.
 *
 *   2. Confirm the bytes are the format they claim to be. A provider that
 *      returns an HTML error page, a JSON fault, an empty body or a truncated
 *      file must not end up stored as an image asset — the filmmaker would see
 *      a broken frame in their storyboard and no error anywhere.
 *
 * Deliberately a header parser rather than an image library: it needs the first
 * few dozen bytes, decodes nothing, allocates nothing, and cannot be made to
 * execute anything by a hostile file.
 */

export interface ImageMetadata {
  format: "png" | "jpeg" | "webp" | "gif";
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
}

export class InvalidImageError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`The provider did not return a usable image: ${detail}`);
    this.name = "InvalidImageError";
    this.detail = detail;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Sanity ceilings. A "16-gigapixel" header is a corrupt or hostile file, not a picture. */
const MAX_DIMENSION = 16_384;
const MIN_DIMENSION = 1;

/**
 * Describes the bytes, or explains why they are not an image.
 *
 * Throws rather than returning undefined: every caller here treats an
 * unreadable image as a failure, and a thrown error carries the reason to the
 * Generation's error field where someone can read it.
 */
export function readImageMetadata(bytes: Buffer): ImageMetadata {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    throw new InvalidImageError("the response body was empty");
  }
  if (bytes.byteLength < 16) {
    throw new InvalidImageError(`only ${bytes.byteLength} bytes, too short to be an image`);
  }

  const metadata =
    readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes) ?? readGif(bytes);

  if (!metadata) {
    throw new InvalidImageError(describeNonImage(bytes));
  }

  if (
    metadata.width < MIN_DIMENSION ||
    metadata.height < MIN_DIMENSION ||
    metadata.width > MAX_DIMENSION ||
    metadata.height > MAX_DIMENSION
  ) {
    throw new InvalidImageError(
      `implausible dimensions ${metadata.width}×${metadata.height}`
    );
  }

  return metadata;
}

/**
 * Says what arrived instead of an image, in terms useful in an error message.
 *
 * An HTML error page is the case worth naming explicitly: it is what a
 * misconfigured gateway, a captive portal or a proxy denial returns, and
 * "stored an HTML page as a PNG" is exactly the bug this module prevents.
 */
function describeNonImage(bytes: Buffer): string {
  const head = bytes.subarray(0, 200).toString("utf8").trim();
  if (/^<!doctype html|^<html/i.test(head)) return "an HTML page, not an image";
  if (/^\{|^\[/.test(head)) return "a JSON document, not an image";
  if (/^<\?xml|^<svg/i.test(head)) return "an XML or SVG document, which is not an accepted format";
  const magic = [...bytes.subarray(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return `unrecognised format (starts with ${magic})`;
}

function readPng(bytes: Buffer): ImageMetadata | undefined {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  // IHDR must be the first chunk, and its length must be 13.
  if (bytes.byteLength < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new InvalidImageError("a PNG with no IHDR header — the file is truncated or corrupt");
  }
  return {
    format: "png",
    mimeType: "image/png",
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    byteLength: bytes.byteLength,
  };
}

function readJpeg(bytes: Buffer): ImageMetadata | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  // Walk the marker segments to the frame header, which is where the size is.
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];

    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start-of-frame: SOF0..SOF15, excluding the non-frame markers in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        format: "jpeg",
        mimeType: "image/jpeg",
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
        byteLength: bytes.byteLength,
      };
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) throw new InvalidImageError("a JPEG with a malformed segment length");
    offset += 2 + length;
  }
  throw new InvalidImageError("a JPEG with no frame header — the file is truncated or corrupt");
}

function readWebp(bytes: Buffer): ImageMetadata | undefined {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }
  const chunk = bytes.toString("ascii", 12, 16);

  // Three container variants, each storing the size differently.
  if (chunk === "VP8X" && bytes.byteLength >= 30) {
    return {
      format: "webp",
      mimeType: "image/webp",
      // 24-bit little-endian, stored as (dimension - 1).
      width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
      height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
      byteLength: bytes.byteLength,
    };
  }
  if (chunk === "VP8 " && bytes.byteLength >= 30) {
    return {
      format: "webp",
      mimeType: "image/webp",
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      byteLength: bytes.byteLength,
    };
  }
  if (chunk === "VP8L" && bytes.byteLength >= 25) {
    const bits = bytes.readUInt32LE(21);
    return {
      format: "webp",
      mimeType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      byteLength: bytes.byteLength,
    };
  }
  throw new InvalidImageError("a WebP whose container variant could not be read");
}

function readGif(bytes: Buffer): ImageMetadata | undefined {
  const signature = bytes.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  return {
    format: "gif",
    mimeType: "image/gif",
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
    byteLength: bytes.byteLength,
  };
}
