import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { GeneratedImage, ImageGenerationProvider, ImageGenerationRequest } from "./types.ts";

/**
 * A local, deterministic stand-in for a real image provider.
 *
 * Its purpose is to exercise the durable job pipeline without an external
 * account, a network call or a bill. It is NOT a simulation of any provider's
 * behaviour or quality: it renders a flat 64×64 PNG whose colour is derived from
 * the prompt's hash, so the same prompt always yields the same bytes and two
 * different prompts are visibly different. Anything it produces is evidence
 * that the *pipeline* works, never that generation works.
 *
 * It holds no credentials, so it is safe to import from a test. It is only
 * registered when IMAGE_PROVIDER=local-stub.
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

/** A real, decodable PNG — not a placeholder buffer with a .png name. */
function flatPng(size: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  // 10..12 are compression, filter and interlace, all zero.

  const row = Buffer.concat([
    Buffer.from([0]), // filter: none
    Buffer.concat(Array.from({ length: size }, () => Buffer.from(rgb))),
  ]);
  const raster = Buffer.concat(Array.from({ length: size }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Test-only: every prompt this adapter has been asked to render, in order. */
const calls: string[] = [];

export function stubImageCalls(): readonly string[] {
  return calls;
}

export function resetStubImageCalls(): void {
  calls.length = 0;
}

export const localStubImageProvider: ImageGenerationProvider = {
  id: "local-stub-image",
  label: "Local stub (no external provider)",
  model: "local-stub-image-v1",

  /**
   * `kind: "stub"` is the load-bearing field. Everything that reports on a
   * generation — the card, the logs, the export — reads it to say plainly that
   * this image was produced locally and is not the output of any external AI
   * model.
   */
  capabilities: {
    kind: "stub",
    sizes: ["64x64"],
    defaultSize: "64x64",
    outputMimeTypes: ["image/png"],
    maxPromptCharacters: 32_000,
    imagesPerRequest: 1,
    supportsReferenceImages: false,
  },

  // The output is a pure function of the prompt, so re-rendering the same
  // request costs nothing and returns identical bytes. That is idempotency in
  // the only sense that matters here.
  supportsIdempotencyKey: true,

  isConfigured: () => true,

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    calls.push(request.prompt);

    // A real adapter refuses an empty prompt rather than rendering noise.
    if (request.prompt.trim() === "") {
      throw new Error("The prompt was empty");
    }

    const digest = createHash("sha256").update(request.prompt).digest();
    return {
      data: flatPng(64, [digest[0], digest[1], digest[2]]),
      mimeType: "image/png",
      width: 64,
      height: 64,
    };
  },
};
