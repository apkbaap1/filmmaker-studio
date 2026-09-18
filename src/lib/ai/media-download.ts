/**
 * Downloading provider-delivered media, with a ceiling enforced as it arrives.
 *
 * Video providers hand back a URL rather than bytes. Fetching that URL is the
 * adapter's job, but *how* it is fetched is a safety property shared by all of
 * them, so it lives here rather than being reimplemented — slightly differently,
 * and eventually wrongly — in each one.
 *
 * The property that matters: the size limit is checked **during** the transfer,
 * not after it. `await response.arrayBuffer()` on a hostile or malfunctioning
 * endpoint buffers whatever it is sent before anyone can object, which is an
 * out-of-memory crash rather than a rejected download. This reads the stream and
 * aborts the moment the ceiling is crossed.
 *
 * Provider-independent by construction: it takes a URL and headers and returns
 * bytes, and knows nothing about who is at the other end. The caller supplies
 * any credential as a header, and nothing here logs, stores or echoes it.
 */

export class MediaDownloadError extends Error {
  readonly kind: "too-large" | "bad-status" | "transport" | "empty";

  constructor(kind: MediaDownloadError["kind"], message: string) {
    super(message);
    this.name = "MediaDownloadError";
    this.kind = kind;
  }
}

export interface DownloadOptions {
  /** Hard ceiling. The transfer is aborted the moment it is exceeded. */
  maxBytes: number;
  /** Sent as-is. A credential belongs here and nowhere else. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DownloadedMedia {
  bytes: Buffer;
  /** What the server said it was. Advisory only — the bytes are what decide. */
  contentType: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Fetches a URL into memory, refusing anything over `maxBytes`.
 *
 * Returns the bytes and the advertised content type. It deliberately does *not*
 * decide whether the result is valid media — that is the metadata parser's job,
 * and it works from the bytes rather than from what the server claimed.
 */
export async function downloadWithLimit(
  url: string,
  options: DownloadOptions
): Promise<DownloadedMedia> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: options.headers,
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (error) {
    clearTimeout(timer);
    const detail = error instanceof Error ? error.message : String(error);
    throw new MediaDownloadError("transport", `Could not fetch the media: ${detail.slice(0, 200)}`);
  }

  try {
    if (!response.ok) {
      throw new MediaDownloadError(
        "bad-status",
        `The media URL answered ${response.status}`
      );
    }

    // A declared length over the ceiling is refused before a single byte of the
    // body is read. It is only a hint — a server may lie or omit it — so the
    // streaming check below is what actually enforces the limit.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new MediaDownloadError(
        "too-large",
        `The media is ${mb(declared)}MB; the limit is ${mb(options.maxBytes)}MB`
      );
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    const bytes = await readCapped(response, options.maxBytes, controller);

    if (bytes.byteLength === 0) {
      throw new MediaDownloadError("empty", "The media URL returned an empty body");
    }
    return { bytes, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the body chunk by chunk, stopping at the ceiling.
 *
 * The abort is what makes this a real limit rather than a check: without it the
 * remote end keeps sending, and a caller that only stops *reading* still leaves
 * the transfer running.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  controller: AbortController
): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    // No stream available: fall back, but only after the declared-length check
    // above, and verify the size once it is in hand.
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) {
      throw new MediaDownloadError(
        "too-large",
        `The media is ${mb(whole.byteLength)}MB; the limit is ${mb(maxBytes)}MB`
      );
    }
    return whole;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the transfer rather than merely stop reading it.
        controller.abort();
        throw new MediaDownloadError(
          "too-large",
          `The media exceeds the ${mb(maxBytes)}MB limit; the download was stopped after ${mb(total)}MB`
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof MediaDownloadError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new MediaDownloadError("transport", `The media transfer failed: ${detail.slice(0, 200)}`);
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks, total);
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
