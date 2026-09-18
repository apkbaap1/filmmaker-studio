/**
 * Video metadata read from the bytes themselves.
 *
 * The video counterpart of `image-metadata.ts`, and it exists for the same two
 * reasons:
 *
 *   1. **Report a clip's true dimensions and length.** A provider's *request*
 *      asked for six seconds at 16:9; that is what was asked for, not
 *      necessarily what came back. Until now a generated clip's width, height
 *      and duration stayed null in the database until somebody happened to open
 *      it in the timeline and the browser reported them back. A clip nobody
 *      opened had no recorded length, so the ruler silently fell back to the
 *      shot's *intended* duration — exactly the conflation the timeline was
 *      built to avoid.
 *
 *   2. **Confirm the bytes are a video at all.** A provider returning an HTML
 *      error page, a JSON fault, a truncated download or an audio-only file must
 *      not be stored as a previsualization clip.
 *
 * It is a container parser, not a decoder: it reads the handful of header
 * structures that carry the numbers and touches no frame data. It needs no
 * dependency, decodes nothing, and cannot be made to execute anything by a
 * hostile file.
 *
 * Provider-independent by construction — it takes bytes and returns facts, and
 * knows nothing about who produced them.
 */

export type VideoContainer = "webm" | "mp4";

export interface VideoMetadata {
  container: VideoContainer;
  mimeType: string;
  width: number;
  height: number;
  /**
   * Seconds, measured from the container's own timing fields.
   *
   * `null` when the container genuinely does not state one — a live-muxed WebM
   * with no Duration element, or an MP4 whose mvhd duration is the "unknown"
   * sentinel. Null is the honest answer there; a number would be invented.
   */
  durationSeconds: number | null;
  byteLength: number;
}

export class InvalidVideoError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`The provider did not return a usable video: ${detail}`);
    this.name = "InvalidVideoError";
    this.detail = detail;
  }
}

/** Sanity ceilings. A header claiming more is corrupt or hostile, not a clip. */
const MAX_DIMENSION = 16_384;
const MAX_DURATION_SECONDS = 24 * 3_600;

/**
 * Describes the bytes, or explains why they are not a video.
 *
 * Throws rather than returning undefined: every caller treats an unreadable
 * video as a failure, and the thrown reason ends up on the Generation where
 * someone can read it.
 */
export function readVideoMetadata(bytes: Buffer): VideoMetadata {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    throw new InvalidVideoError("the response body was empty");
  }
  if (bytes.byteLength < 32) {
    throw new InvalidVideoError(`only ${bytes.byteLength} bytes, too short to be a video`);
  }

  const metadata = readWebm(bytes) ?? readMp4(bytes);
  if (!metadata) throw new InvalidVideoError(describeNonVideo(bytes));

  if (
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > MAX_DIMENSION ||
    metadata.height > MAX_DIMENSION
  ) {
    throw new InvalidVideoError(`implausible dimensions ${metadata.width}x${metadata.height}`);
  }
  if (
    metadata.durationSeconds !== null &&
    (!Number.isFinite(metadata.durationSeconds) ||
      metadata.durationSeconds < 0 ||
      metadata.durationSeconds > MAX_DURATION_SECONDS)
  ) {
    throw new InvalidVideoError(`implausible duration ${metadata.durationSeconds}s`);
  }

  return metadata;
}

/** Says what arrived instead of a video, in terms useful in an error message. */
function describeNonVideo(bytes: Buffer): string {
  const head = bytes.subarray(0, 200).toString("utf8").trim();
  if (/^<!doctype html|^<html/i.test(head)) return "an HTML page, not a video";
  if (/^\{|^\[/.test(head)) return "a JSON document, not a video";
  if (/^<\?xml/i.test(head)) return "an XML document, not a video";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "a PNG image, not a video";
  }
  const magic = [...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return `an unrecognised container (starts with ${magic})`;
}

// --- WebM / Matroska (EBML) --------------------------------------------------
//
// Duration lives in Segment > Info as a float in TimecodeScale units (which are
// nanoseconds), and the picture size in Segment > Tracks > TrackEntry > Video.
// Both are near the front of the file, before any frame data.

const EBML_HEADER = 0x1a45dfa3;
const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
} as const;

const MASTER_ELEMENTS = new Set<number>([
  EBML_HEADER,
  ID.Segment,
  ID.Info,
  ID.Tracks,
  ID.TrackEntry,
  ID.Video,
]);

interface Vint {
  value: number;
  next: number;
  /** True when every value bit is set, which EBML uses to mean "unknown size". */
  unknown: boolean;
}

/**
 * Reads an EBML variable-length integer.
 *
 * Element *ids* keep their length marker (the id is the whole byte sequence);
 * element *sizes* strip it. Getting that backwards silently misreads the file,
 * so the caller states which it wants.
 */
function readVint(bytes: Buffer, at: number, keepMarker: boolean): Vint | undefined {
  if (at >= bytes.byteLength) return undefined;
  const first = bytes[at];
  if (first === 0) return undefined; // lengths beyond 8 bytes are not valid here

  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    length += 1;
    if (length > 8) return undefined;
  }
  if (at + length > bytes.byteLength) return undefined;

  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { value, next: at + length, unknown: !keepMarker && allOnes };
}

function readWebm(bytes: Buffer): VideoMetadata | undefined {
  if (bytes.readUInt32BE(0) !== EBML_HEADER) return undefined;

  let timecodeScale = 1_000_000; // nanoseconds; the Matroska default
  let rawDuration: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  // Only a video track's dimensions count. An audio-only file has none, and
  // must not be accepted as a clip.
  let currentTrackType: number | undefined;
  let videoTrackFound = false;

  const walk = (start: number, end: number, depth: number): void => {
    let at = start;
    while (at < end && depth < 8) {
      const id = readVint(bytes, at, true);
      if (!id) return;
      const size = readVint(bytes, id.next, false);
      if (!size) return;

      const bodyStart = size.next;
      // An unknown-size master element runs to the end of its parent, which is
      // how a live-muxed Segment is written.
      const bodyEnd = size.unknown ? end : Math.min(end, bodyStart + size.value);
      if (bodyEnd < bodyStart) return;

      if (MASTER_ELEMENTS.has(id.value)) {
        if (id.value === ID.TrackEntry) currentTrackType = undefined;
        walk(bodyStart, bodyEnd, depth + 1);
      } else {
        const body = bytes.subarray(bodyStart, bodyEnd);
        switch (id.value) {
          case ID.TimecodeScale:
            timecodeScale = uint(body) || timecodeScale;
            break;
          case ID.Duration:
            rawDuration = body.byteLength === 4 ? body.readFloatBE(0) : body.byteLength === 8 ? body.readDoubleBE(0) : undefined;
            break;
          case ID.TrackType:
            currentTrackType = uint(body);
            break;
          case ID.PixelWidth:
            // TrackType is written before Video in a well-formed TrackEntry, so
            // by here we know whether this track is the video one.
            if (currentTrackType === undefined || currentTrackType === 1) {
              width = uint(body);
              videoTrackFound = true;
            }
            break;
          case ID.PixelHeight:
            if (currentTrackType === undefined || currentTrackType === 1) height = uint(body);
            break;
        }
      }
      at = bodyEnd;
    }
  };

  walk(0, bytes.byteLength, 0);

  if (!videoTrackFound || width === undefined || height === undefined) {
    throw new InvalidVideoError(
      "a WebM container with no readable video track — it may be audio-only or truncated before its track headers"
    );
  }

  return {
    container: "webm",
    mimeType: "video/webm",
    width,
    height,
    durationSeconds:
      rawDuration !== undefined && rawDuration > 0
        ? (rawDuration * timecodeScale) / 1_000_000_000
        : null,
    byteLength: bytes.byteLength,
  };
}

function uint(body: Buffer): number {
  let value = 0;
  for (const byte of body) value = value * 256 + byte;
  return value;
}

// --- MP4 / ISO base media file format ----------------------------------------
//
// Duration is mvhd's duration divided by its timescale; the picture size is the
// video track's tkhd width/height, stored as 16.16 fixed-point.

/** The "unknown duration" sentinel in a 32-bit mvhd. */
const MP4_UNKNOWN_DURATION_32 = 0xffffffff;

interface Mp4Box {
  type: string;
  start: number;
  end: number;
  bodyStart: number;
}

function readBoxes(bytes: Buffer, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    let bodyStart = at + 8;

    if (size === 1) {
      // 64-bit size follows the type.
      if (at + 16 > end) break;
      const high = bytes.readUInt32BE(at + 8);
      const low = bytes.readUInt32BE(at + 12);
      size = high * 2 ** 32 + low;
      bodyStart = at + 16;
    } else if (size === 0) {
      // Runs to the end of the enclosing box.
      size = end - at;
    }

    if (size < 8) break;
    const boxEnd = Math.min(end, at + size);
    if (boxEnd <= at) break;
    boxes.push({ type, start: at, end: boxEnd, bodyStart });
    at = boxEnd;
  }
  return boxes;
}

function readMp4(bytes: Buffer): VideoMetadata | undefined {
  const top = readBoxes(bytes, 0, bytes.byteLength);
  if (!top.some((b) => b.type === "ftyp")) return undefined;

  const moov = top.find((b) => b.type === "moov");
  if (!moov) {
    throw new InvalidVideoError(
      "an MP4 with no moov box — the file is truncated, or its metadata sits after the media data and was cut off"
    );
  }

  const moovBoxes = readBoxes(bytes, moov.bodyStart, moov.end);

  // --- mvhd: the overall timescale and duration ---
  let durationSeconds: number | null = null;
  const mvhd = moovBoxes.find((b) => b.type === "mvhd");
  if (mvhd) {
    const version = bytes[mvhd.bodyStart];
    const at = mvhd.bodyStart + 4; // skip version and flags
    if (version === 1) {
      if (at + 28 <= mvhd.end) {
        const timescale = bytes.readUInt32BE(at + 16);
        const high = bytes.readUInt32BE(at + 20);
        const low = bytes.readUInt32BE(at + 24);
        const duration = high * 2 ** 32 + low;
        if (timescale > 0 && duration > 0) durationSeconds = duration / timescale;
      }
    } else if (at + 16 <= mvhd.end) {
      const timescale = bytes.readUInt32BE(at + 8);
      const duration = bytes.readUInt32BE(at + 12);
      if (timescale > 0 && duration > 0 && duration !== MP4_UNKNOWN_DURATION_32) {
        durationSeconds = duration / timescale;
      }
    }
  }

  // --- tkhd: the video track's presentation size ---
  let width: number | undefined;
  let height: number | undefined;
  for (const trak of moovBoxes.filter((b) => b.type === "trak")) {
    const tkhd = readBoxes(bytes, trak.bodyStart, trak.end).find((b) => b.type === "tkhd");
    if (!tkhd) continue;

    const version = bytes[tkhd.bodyStart];
    //
    // width and height are the last two 32-bit fields of tkhd. Counting from
    // the body start (which begins with version+flags):
    //
    //   v0:  4 version/flags + 4 creation + 4 modification + 4 trackID
    //      + 4 reserved + 4 duration + 8 reserved + 2 layer + 2 altGroup
    //      + 2 volume + 2 reserved + 36 matrix                      = 76
    //   v1: the same with 8-byte creation, modification and duration = 88
    //
    const sizeAt = tkhd.bodyStart + (version === 1 ? 88 : 76);
    if (sizeAt + 8 > tkhd.end) continue;

    // 16.16 fixed-point.
    const w = bytes.readUInt32BE(sizeAt) / 65_536;
    const h = bytes.readUInt32BE(sizeAt + 4) / 65_536;
    // An audio track's tkhd carries zeroes here, which is how the video track
    // is identified without parsing handler boxes.
    if (w >= 1 && h >= 1) {
      width = Math.round(w);
      height = Math.round(h);
      break;
    }
  }

  if (width === undefined || height === undefined) {
    throw new InvalidVideoError(
      "an MP4 container with no video track — it may be audio-only, or its track headers are unreadable"
    );
  }

  return {
    container: "mp4",
    mimeType: "video/mp4",
    width,
    height,
    durationSeconds,
    byteLength: bytes.byteLength,
  };
}
