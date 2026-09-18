import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";

import { InvalidImageError, readImageMetadata } from "./image-metadata.ts";

/**
 * Dimensions come from the file, or they do not come at all.
 *
 * The bug these guard against is quiet: a provider returns something that is not
 * an image, the application stores it anyway, and the filmmaker finds a broken
 * frame in their storyboard with no error recorded anywhere.
 */

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** A real, decodable PNG of the given size. */
export function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
  const raster = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(10);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);

  // An APP0 segment first, so the marker walk has something real to skip past.
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF", 4, "ascii");

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webpVp8x(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buffer[24] = w & 0xff;
  buffer[25] = (w >> 8) & 0xff;
  buffer[26] = (w >> 16) & 0xff;
  buffer[27] = h & 0xff;
  buffer[28] = (h >> 8) & 0xff;
  buffer[29] = (h >> 16) & 0xff;
  return buffer;
}

function gif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

describe("reading real dimensions", () => {
  it("reads a PNG's size from its IHDR", () => {
    const meta = readImageMetadata(png(1024, 1536));
    assert.equal(meta.format, "png");
    assert.equal(meta.mimeType, "image/png");
    assert.equal(meta.width, 1024);
    assert.equal(meta.height, 1536);
    assert.ok(meta.byteLength > 0);
  });

  it("reads a JPEG's size from its frame header", () => {
    const meta = readImageMetadata(jpeg(1536, 1024));
    assert.equal(meta.mimeType, "image/jpeg");
    assert.equal(meta.width, 1536);
    assert.equal(meta.height, 1024);
  });

  it("reads a WebP's size", () => {
    const meta = readImageMetadata(webpVp8x(800, 600));
    assert.equal(meta.mimeType, "image/webp");
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 600);
  });

  it("reads a GIF's size", () => {
    const meta = readImageMetadata(gif(320, 240));
    assert.equal(meta.mimeType, "image/gif");
    assert.equal(meta.width, 320);
    assert.equal(meta.height, 240);
  });

  it("reports non-square dimensions the right way round", () => {
    // Transposing width and height is the classic silent bug here, and it would
    // make every portrait frame land in the timeline as a landscape one.
    const meta = readImageMetadata(png(512, 1024));
    assert.equal(meta.width, 512);
    assert.equal(meta.height, 1024);
  });
});

describe("refusing what is not an image", () => {
  it("names an HTML error page for what it is", () => {
    // The case that matters most: a proxy denial or gateway error arriving with
    // a 200 and being stored as a PNG.
    const html = Buffer.from("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>");
    assert.throws(
      () => readImageMetadata(html),
      (error: unknown) =>
        error instanceof InvalidImageError && /HTML page, not an image/.test(error.message)
    );
  });

  it("names a JSON fault for what it is", () => {
    const json = Buffer.from(JSON.stringify({ error: { message: "insufficient_quota" } }));
    assert.throws(
      () => readImageMetadata(json),
      (error: unknown) => error instanceof InvalidImageError && /JSON document/.test(error.message)
    );
  });

  it("refuses SVG, which is a document that can carry script", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    assert.throws(
      () => readImageMetadata(svg),
      (error: unknown) => error instanceof InvalidImageError && /SVG/.test(error.message)
    );
  });

  it("refuses an empty body", () => {
    assert.throws(
      () => readImageMetadata(Buffer.alloc(0)),
      (error: unknown) => error instanceof InvalidImageError && /empty/.test(error.message)
    );
  });

  it("refuses something too short to be an image", () => {
    assert.throws(() => readImageMetadata(Buffer.from("PNG")), InvalidImageError);
  });

  it("refuses a truncated PNG rather than reading rubbish out of it", () => {
    const truncated = png(64, 64).subarray(0, 12);
    assert.throws(() => readImageMetadata(truncated), InvalidImageError);
  });

  it("refuses a PNG signature with no IHDR", () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32),
    ]);
    assert.throws(
      () => readImageMetadata(fake),
      (error: unknown) => error instanceof InvalidImageError && /IHDR/.test(error.message)
    );
  });

  it("refuses implausible dimensions", () => {
    // A header claiming a zero- or gigapixel image is corrupt or hostile.
    assert.throws(
      () => readImageMetadata(gif(0, 0)),
      (error: unknown) => error instanceof InvalidImageError && /implausible/.test(error.message)
    );
  });

  it("includes the leading bytes when it cannot identify the format at all", () => {
    const junk = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.throws(
      () => readImageMetadata(junk),
      (error: unknown) => error instanceof InvalidImageError && /de ad be ef/.test(error.message)
    );
  });
});
