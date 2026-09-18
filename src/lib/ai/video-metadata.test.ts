import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InvalidVideoError, readVideoMetadata } from "./video-metadata.ts";
import { STUB_CLIP_WEBM_BASE64 } from "./video-providers/stub-clip.ts";

/**
 * Measurements come from the file, or they do not come at all.
 *
 * The WebM fixture is a real container — the same clip the local stub returns —
 * and its expected values were established with an independent reader before
 * this parser was written, so these assertions check the parser rather than
 * agreeing with it. The MP4 fixtures are built here from the ISO base media
 * box structure, which is what makes the field offsets testable: an offset that
 * is eight bytes out reads plausible-looking rubbish rather than failing, and
 * only a real box layout catches it.
 */

const STUB_WEBM = Buffer.from(STUB_CLIP_WEBM_BASE64, "base64");

// --- MP4 fixture construction -------------------------------------------

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.byteLength + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

function u32(...values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
}

/** An mvhd whose timescale and duration give `duration / timescale` seconds. */
function mvhd(timescale: number, duration: number): Buffer {
  return box(
    "mvhd",
    Buffer.concat([
      Buffer.from([0, 0, 0, 0]), // version 0, flags
      u32(0, 0, timescale, duration), // creation, modification, timescale, duration
      u32(0x00010000), // rate
      Buffer.from([0x01, 0x00]), // volume
      Buffer.alloc(10), // reserved
      Buffer.alloc(36), // matrix
      Buffer.alloc(24), // pre_defined
      u32(2), // next_track_ID
    ])
  );
}

/** A tkhd carrying a 16.16 fixed-point presentation size. */
function tkhd(width: number, height: number): Buffer {
  return box(
    "tkhd",
    Buffer.concat([
      Buffer.from([0, 0, 0, 7]), // version 0, flags = enabled|inMovie|inPreview
      u32(0, 0, 1, 0, 3600), // creation, modification, trackID, reserved, duration
      Buffer.alloc(8), // reserved
      Buffer.alloc(4), // layer, alternate_group
      Buffer.alloc(4), // volume, reserved
      Buffer.alloc(36), // matrix
      u32(Math.round(width * 65_536), Math.round(height * 65_536)),
    ])
  );
}

function ftyp(): Buffer {
  return box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), u32(512), Buffer.from("isomiso2avc1mp41", "latin1")]));
}

function mp4(options: { width: number; height: number; timescale?: number; duration?: number; tracks?: Buffer[] }): Buffer {
  const tracks = options.tracks ?? [box("trak", tkhd(options.width, options.height))];
  return Buffer.concat([
    ftyp(),
    box("moov", Buffer.concat([mvhd(options.timescale ?? 600, options.duration ?? 3600), ...tracks])),
    box("mdat", Buffer.alloc(64)),
  ]);
}

describe("WebM", () => {
  it("measures the real clip's dimensions and duration", () => {
    // Established independently before this parser existed: 256x144, 1.906632s.
    const meta = readVideoMetadata(STUB_WEBM);
    assert.equal(meta.container, "webm");
    assert.equal(meta.mimeType, "video/webm");
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 144);
    assert.ok(meta.durationSeconds !== null);
    assert.ok(
      Math.abs(meta.durationSeconds! - 1.906632) < 1e-5,
      `duration was ${meta.durationSeconds}`
    );
  });

  it("reports the byte length it was given", () => {
    assert.equal(readVideoMetadata(STUB_WEBM).byteLength, STUB_WEBM.byteLength);
  });

  it("applies the container's timecode scale rather than assuming milliseconds", () => {
    // The stub's scale is the Matroska default of 1,000,000ns. Reading the raw
    // Duration without scaling would report 1906 seconds instead of 1.9.
    const meta = readVideoMetadata(STUB_WEBM);
    assert.ok(meta.durationSeconds! < 10, `unscaled duration leaked through: ${meta.durationSeconds}`);
  });

  it("refuses a WebM truncated before its track headers", () => {
    assert.throws(
      () => readVideoMetadata(STUB_WEBM.subarray(0, 120)),
      (error: unknown) =>
        error instanceof InvalidVideoError && /no readable video track/.test(error.message)
    );
  });
});

describe("MP4", () => {
  it("measures dimensions from the track header", () => {
    const meta = readVideoMetadata(mp4({ width: 1920, height: 1080 }));
    assert.equal(meta.container, "mp4");
    assert.equal(meta.mimeType, "video/mp4");
    assert.equal(meta.width, 1920);
    assert.equal(meta.height, 1080);
  });

  it("measures duration as the movie header's duration over its timescale", () => {
    const meta = readVideoMetadata(mp4({ width: 1280, height: 720, timescale: 600, duration: 3600 }));
    assert.equal(meta.durationSeconds, 6);
  });

  it("handles a non-integer duration without rounding it away", () => {
    // 90000 ticks at 24000/s is 3.75s — a real frame-rate-derived timescale.
    const meta = readVideoMetadata(mp4({ width: 640, height: 480, timescale: 24_000, duration: 90_000 }));
    assert.equal(meta.durationSeconds, 3.75);
  });

  it("reports portrait dimensions the right way round", () => {
    // Transposing width and height is the classic silent bug, and it would make
    // every vertical clip land in the timeline as a landscape one.
    const meta = readVideoMetadata(mp4({ width: 1080, height: 1920 }));
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1920);
  });

  it("skips an audio track and measures the video one", () => {
    // An audio tkhd carries zeroes where the picture size would be, which is
    // how the video track is found without parsing handler boxes.
    const audio = box("trak", tkhd(0, 0));
    const video = box("trak", tkhd(1920, 800));
    const meta = readVideoMetadata(mp4({ width: 0, height: 0, tracks: [audio, video] }));
    assert.equal(meta.width, 1920);
    assert.equal(meta.height, 800);
  });

  it("reports no duration rather than inventing one when mvhd says unknown", () => {
    const meta = readVideoMetadata(
      mp4({ width: 1280, height: 720, timescale: 600, duration: 0xffffffff })
    );
    assert.equal(meta.durationSeconds, null, "an unknown duration must be null, not a number");
    assert.equal(meta.width, 1280, "the dimensions are still measured");
  });

  it("reports no duration when the movie header is absent entirely", () => {
    const moov = box("moov", box("trak", tkhd(1920, 1080)));
    const meta = readVideoMetadata(Buffer.concat([ftyp(), moov, box("mdat", Buffer.alloc(64))]));
    assert.equal(meta.durationSeconds, null);
    assert.equal(meta.width, 1920);
  });

  it("refuses an MP4 with no video track", () => {
    const audioOnly = box("trak", tkhd(0, 0));
    assert.throws(
      () => readVideoMetadata(mp4({ width: 0, height: 0, tracks: [audioOnly] })),
      (error: unknown) => error instanceof InvalidVideoError && /no video track/.test(error.message)
    );
  });

  it("refuses an MP4 whose moov box never arrived", () => {
    // Real and common: metadata placed after the media data, in a download that
    // was cut short.
    const truncated = Buffer.concat([ftyp(), box("mdat", Buffer.alloc(256))]);
    assert.throws(
      () => readVideoMetadata(truncated),
      (error: unknown) => error instanceof InvalidVideoError && /no moov box/.test(error.message)
    );
  });
});

describe("refusing what is not a video", () => {
  it("names an HTML error page for what it is", () => {
    // The case that matters most: a proxy denial or gateway error arriving with
    // a 200 and being stored as a clip.
    const html = Buffer.from(
      "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>".padEnd(64, " ")
    );
    assert.throws(
      () => readVideoMetadata(html),
      (error: unknown) =>
        error instanceof InvalidVideoError && /HTML page, not a video/.test(error.message)
    );
  });

  it("names a JSON fault for what it is", () => {
    const json = Buffer.from(JSON.stringify({ error: { message: "quota exceeded", code: 429 } }));
    assert.throws(
      () => readVideoMetadata(json),
      (error: unknown) => error instanceof InvalidVideoError && /JSON document/.test(error.message)
    );
  });

  it("refuses an image offered as a video", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]);
    assert.throws(
      () => readVideoMetadata(png),
      (error: unknown) => error instanceof InvalidVideoError && /PNG image/.test(error.message)
    );
  });

  it("refuses an empty body", () => {
    assert.throws(
      () => readVideoMetadata(Buffer.alloc(0)),
      (error: unknown) => error instanceof InvalidVideoError && /empty/.test(error.message)
    );
  });

  it("refuses something far too short to be a video", () => {
    assert.throws(() => readVideoMetadata(Buffer.from("webm")), InvalidVideoError);
  });

  it("includes the leading bytes when it cannot identify the container", () => {
    const junk = Buffer.concat([Buffer.from([0xde, 0xad, 0xbe, 0xef]), Buffer.alloc(64)]);
    assert.throws(
      () => readVideoMetadata(junk),
      (error: unknown) =>
        error instanceof InvalidVideoError && /de ad be ef/.test(error.message)
    );
  });

  it("refuses implausible dimensions", () => {
    assert.throws(
      () => readVideoMetadata(mp4({ width: 40_000, height: 40_000 })),
      (error: unknown) => error instanceof InvalidVideoError && /implausible dimensions/.test(error.message)
    );
  });

  it("refuses an implausible duration", () => {
    // A timescale of 1 with a huge duration: decades of footage.
    assert.throws(
      () => readVideoMetadata(mp4({ width: 640, height: 480, timescale: 1, duration: 9_000_000 })),
      (error: unknown) => error instanceof InvalidVideoError && /implausible duration/.test(error.message)
    );
  });
});
