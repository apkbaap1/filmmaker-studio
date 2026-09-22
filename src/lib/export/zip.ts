/**
 * A minimal, streaming ZIP writer.
 *
 * ## Why hand-written rather than a dependency
 *
 * Everything this bundle carries — PNG, JPEG, WebP, MP4, WebM — is already
 * compressed. Deflating it again spends CPU to produce a file a fraction of a
 * percent smaller, so the only method used here is STORE, and STORE is a
 * container format rather than a compression algorithm: headers, offsets and a
 * CRC. That is a few hundred lines with no entropy coder in it, and it is
 * verified in the tests against two independent implementations (the `unzip`
 * binary and Python's `zipfile`) rather than against itself.
 *
 * ## Why streaming
 *
 * A production's media can be gigabytes. Building the archive as an async
 * iterable of chunks means the process holds one asset at a time rather than
 * the whole bundle, so a large project exports without the memory use scaling
 * with it.
 *
 * ## What this deliberately does not implement
 *
 * ZIP64. The classic format tops out at 4 GiB per entry, 4 GiB per archive and
 * 65,535 entries. Rather than emit a silently corrupt archive past those
 * points, `ZipLimitError` is thrown with the limit named — a failed export a
 * filmmaker can act on beats a downloaded file that will not open.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/** Marks the filename as UTF-8, so non-ASCII captions survive the round trip. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const VERSION_NEEDED = 20;

const MAX_UINT32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

export interface ZipEntry {
  /** Path inside the archive. Forward slashes, no leading slash. */
  path: string;
  bytes: Buffer;
  /** Entry timestamp. Defaults to now; passed explicitly so tests are stable. */
  modifiedAt?: Date;
}

// --- CRC-32 ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

export function crc32(bytes: Buffer): number {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// --- DOS timestamps ----------------------------------------------------------

/**
 * ZIP stores MS-DOS time: two-second resolution, and no year before 1980.
 *
 * A date outside that range is clamped rather than allowed to wrap into a
 * nonsense value, because a wrapped timestamp is the kind of thing that makes
 * an archive look subtly corrupt to a strict reader.
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

// --- writer ------------------------------------------------------------------

interface CentralRecord {
  path: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

function localHeader(entry: {
  path: Buffer;
  crc: number;
  size: number;
  time: number;
  date: number;
}): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(FLAG_UTF8, 6);
  header.writeUInt16LE(METHOD_STORE, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.size, 18); // compressed — identical under STORE
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.path.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, entry.path]);
}

function centralHeader(record: CentralRecord): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_HEADER, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(FLAG_UTF8, 8);
  header.writeUInt16LE(METHOD_STORE, 10);
  header.writeUInt16LE(record.time, 12);
  header.writeUInt16LE(record.date, 14);
  header.writeUInt32LE(record.crc, 16);
  header.writeUInt32LE(record.size, 20);
  header.writeUInt32LE(record.size, 24);
  header.writeUInt16LE(record.path.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(record.offset, 42);
  return Buffer.concat([header, record.path]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(size, 12);
  // Byte 16, not 14: the size field above is four bytes wide, and overlapping
  // them produces an archive whose total length is correct and whose central
  // directory cannot be found. Exactly the kind of error a writer checked only
  // against its own reader would never notice.
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

/**
 * Turns a stream of entries into a stream of archive chunks.
 *
 * The caller decides what goes in and in what order; this only knows how to
 * write it. Entries are consumed lazily, so a producer that reads one asset at
 * a time keeps the whole export at one asset of memory.
 */
export async function* zipStream(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Buffer> {
  const central: CentralRecord[] = [];
  let offset = 0;

  for await (const entry of entries) {
    const path = Buffer.from(entry.path, "utf8");
    const { time, date } = dosDateTime(entry.modifiedAt ?? new Date());
    const crc = crc32(entry.bytes);

    if (entry.bytes.length > MAX_UINT32) {
      throw new ZipLimitError(
        `"${entry.path}" is ${entry.bytes.length} bytes, over the 4 GiB per-entry limit of the ZIP format. ZIP64 is not implemented, and emitting a truncated size field would produce an archive that does not open.`
      );
    }
    if (central.length >= MAX_ENTRIES) {
      throw new ZipLimitError(
        `The archive already holds ${MAX_ENTRIES} entries, the limit of the ZIP format without ZIP64.`
      );
    }

    const header = localHeader({ path, crc, size: entry.bytes.length, time, date });
    yield header;
    yield entry.bytes;

    central.push({ path, crc, size: entry.bytes.length, offset, time, date });
    offset += header.length + entry.bytes.length;

    if (offset > MAX_UINT32) {
      throw new ZipLimitError(
        "The archive has passed 4 GiB, the limit of the ZIP format without ZIP64."
      );
    }
  }

  const directory = Buffer.concat(central.map(centralHeader));
  yield directory;
  yield endOfCentralDirectory(central.length, directory.length, offset);
}
