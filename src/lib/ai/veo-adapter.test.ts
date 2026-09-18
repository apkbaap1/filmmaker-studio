import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { mp4 } from "./video-metadata.test.ts";

/**
 * Google Veo adapter tests, against a local server that speaks the
 * predictLongRunning protocol.
 *
 * **These are not verification that Veo works.** No request has ever reached
 * Google from this codebase. What they exercise is this application's half of
 * the conversation — the JSON it builds, the header it sends, the operation
 * lifecycle it follows, the responses it accepts and the ones it refuses —
 * against a server whose replies are chosen by the test.
 *
 * A green run here says the adapter is self-consistent with the contract in
 * `docs/veo-api-contract.md`. It says nothing about whether that contract
 * matches the live service, which remains unverified for the request payload
 * and every parameter value range. See the workstream report.
 */

const KEY = "test-key-not-a-real-credential-0000";

interface Recorded {
  method: string;
  url: string;
  apiKeyHeader: string | undefined;
  authorizationHeader: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

let recorded: Recorded[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    recorded.push({
      method: req.method ?? "",
      url: req.url ?? "",
      apiKeyHeader: req.headers["x-goog-api-key"] as string | undefined,
      authorizationHeader: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    });
    handler(req, res, body);
  });
});

// Started at module scope rather than in a `before` hook: the adapter reads
// both variables lazily on every call, so they must be in place before the
// first test body runs, not merely before the first hook.
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
process.env.GOOGLE_API_BASE_URL = base;
process.env.GOOGLE_API_KEY = KEY;

after(() => {
  server.close();
  delete process.env.GOOGLE_API_BASE_URL;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_VEO_MODEL;
});

beforeEach(() => {
  recorded = [];
  handler = (_req, res) => {
    res.writeHead(500).end("the test did not set a handler");
  };
});

const veo = await import("./video-providers/google-veo.ts");
const { GenerationError } = await import("../jobs/state.ts");
const { MAX_BYTES } = await import("../media.ts");
const { readVideoMetadata } = await import("./video-metadata.ts");

/** `assert.throws` returns nothing, so this is how a thrown error is inspected. */
function caught(fn: () => unknown): InstanceType<typeof GenerationError> {
  try {
    fn();
  } catch (error) {
    return error as InstanceType<typeof GenerationError>;
  }
  throw new Error("expected the call to throw, and it did not");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const OPERATION = "models/veo-3.1-generate-preview/operations/abc123";

/** A completed operation carrying one sample, in Google's documented shape. */
function completedOperation(uri: string): unknown {
  return {
    name: OPERATION,
    done: true,
    response: {
      generateVideoResponse: {
        generatedSamples: [{ video: { uri } }],
      },
    },
  };
}

function textToVideo(overrides: Record<string, unknown> = {}) {
  return { prompt: "A slow dolly in on Ravi.", mode: "text-to-video" as const, ...overrides };
}

// --- request construction ----------------------------------------------------

describe("Veo request construction", () => {
  it("builds the documented instances/parameters envelope", () => {
    const body = veo.buildRequestBody(textToVideo({ durationSeconds: 6 }));

    assert.deepEqual(body.instances, [{ prompt: "A slow dolly in on Ravi." }]);
    assert.equal(body.parameters?.durationSeconds, 6);
    assert.equal(body.parameters?.sampleCount, 1);
  });

  it("sends the prompt byte-for-byte, with no rewriting step", () => {
    const prompt = "85mm Prime, Low Angle — Ravi frame left; HOLD: composition stays.";
    const body = veo.buildRequestBody(textToVideo({ prompt }));
    assert.equal((body.instances[0] as { prompt: string }).prompt, prompt);
  });

  it("disables Google's own prompt rewriting explicitly rather than by omission", () => {
    const body = veo.buildRequestBody(textToVideo());
    assert.equal(
      body.parameters?.enhancePrompt,
      false,
      "enhancePrompt must be sent false, not left to a server-side default"
    );
  });

  it("omits every parameter the filmmaker did not choose", () => {
    const body = veo.buildRequestBody(textToVideo());
    assert.ok(!("durationSeconds" in (body.parameters ?? {})));
    assert.ok(!("aspectRatio" in (body.parameters ?? {})));
    assert.ok(!("resolution" in (body.parameters ?? {})));
  });

  it("carries a chosen aspect ratio and resolution through", () => {
    const body = veo.buildRequestBody(
      textToVideo({ aspectRatio: "9:16", resolution: "720p", durationSeconds: 4 })
    );
    assert.equal(body.parameters?.aspectRatio, "9:16");
    assert.equal(body.parameters?.resolution, "720p");
  });

  it("rejects an empty prompt rather than sending one", () => {
    assert.throws(() => veo.buildRequestBody(textToVideo({ prompt: "   " })), GenerationError);
  });

  it("refuses a prompt that is over the token budget under any tokenisation", () => {
    const error = caught(() => veo.buildRequestBody(textToVideo({ prompt: "x".repeat(6_000) })));
    assert.equal(error.kind, "PERMANENT");
    assert.match(error.message, /not shortened automatically/);
  });
});

// --- image-to-video ----------------------------------------------------------

describe("Veo image-to-video", () => {
  const frame = { data: Buffer.from("fake-png-bytes"), mimeType: "image/png" };

  it("encodes the source frame as bytesBase64Encoded with its mime type", () => {
    const body = veo.buildRequestBody({
      prompt: "Animate the provided frame.",
      mode: "image-to-video",
      sourceImage: frame,
    });
    assert.deepEqual(body.instances[0].image, {
      bytesBase64Encoded: frame.data.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("refuses image-to-video with no frame", () => {
    assert.throws(
      () => veo.buildRequestBody({ prompt: "p", mode: "image-to-video" }),
      GenerationError
    );
  });

  it("refuses text-to-video that carries a frame, which would change the mode", () => {
    assert.throws(
      () => veo.buildRequestBody({ prompt: "p", mode: "text-to-video", sourceImage: frame }),
      GenerationError
    );
  });
});

// --- duration validation -----------------------------------------------------

describe("Veo duration validation", () => {
  for (const seconds of [4, 6, 8]) {
    it(`accepts ${seconds} seconds`, () => {
      assert.equal(veo.validateDuration(seconds), seconds);
    });
  }

  for (const seconds of [3, 5, 7, 10, 0, -4, 6.5]) {
    it(`rejects ${seconds} seconds`, () => {
      assert.throws(() => veo.validateDuration(seconds), GenerationError);
    });
  }

  it("never rounds an unsupported duration to a supported one", () => {
    const error = caught(() => veo.validateDuration(5));
    assert.match(error.message, /not rounded/);
  });

  it("leaves an unchosen duration unchosen", () => {
    assert.equal(veo.validateDuration(undefined), undefined);
  });
});

// --- resolution validation ---------------------------------------------------

describe("Veo resolution validation", () => {
  for (const value of ["720p", "1080p", "4k"]) {
    it(`accepts ${value}`, () => {
      assert.equal(veo.validateResolution(value), value);
    });
  }

  for (const value of ["1440p", "8k", "720", "HD", ""]) {
    it(`rejects "${value}"`, () => {
      assert.throws(() => veo.validateResolution(value), GenerationError);
    });
  }

  it("leaves an unchosen resolution unchosen", () => {
    assert.equal(veo.validateResolution(undefined), undefined);
  });
});

// --- resolution / duration compatibility -------------------------------------

describe("Veo resolution and duration compatibility", () => {
  it("allows 1080p at 8 seconds", () => {
    assert.doesNotThrow(() => veo.assertResolutionDurationCompatible("1080p", 8));
  });

  it("allows 4k at 8 seconds", () => {
    assert.doesNotThrow(() => veo.assertResolutionDurationCompatible("4k", 8));
  });

  for (const [resolution, duration] of [
    ["1080p", 4],
    ["1080p", 6],
    ["4k", 4],
    ["4k", 6],
  ] as const) {
    it(`rejects ${resolution} at ${duration} seconds before any call`, () => {
      const error = caught(() => veo.assertResolutionDurationCompatible(resolution, duration));
      assert.equal(error.kind, "PERMANENT");
      assert.match(error.message, /Neither value was changed automatically/);
    });
  }

  it("rejects a fixed-duration resolution with no duration, rather than inheriting a default", () => {
    assert.throws(() => veo.assertResolutionDurationCompatible("1080p", undefined), GenerationError);
  });

  it("leaves 720p free to use any supported duration", () => {
    for (const duration of [4, 6, 8, undefined]) {
      assert.doesNotThrow(() => veo.assertResolutionDurationCompatible("720p", duration));
    }
  });

  it("refuses an incompatible pair at the point the body is built", async () => {
    await assert.rejects(
      veo.googleVeoVideoProvider.submit(
        textToVideo({ resolution: "4k", durationSeconds: 4 })
      ),
      GenerationError
    );
    assert.equal(recorded.length, 0, "an incompatible pair must cost no network call");
  });
});

// --- aspect-ratio validation -------------------------------------------------

describe("Veo aspect-ratio validation", () => {
  for (const value of ["16:9", "9:16"]) {
    it(`accepts ${value}`, () => {
      assert.equal(veo.validateAspectRatio(value), value);
    });
  }

  for (const value of ["1:1", "4:3", "21:9", "16x9", ""]) {
    it(`rejects "${value}"`, () => {
      assert.throws(() => veo.validateAspectRatio(value), GenerationError);
    });
  }

  it("leaves an unchosen aspect ratio unchosen", () => {
    assert.equal(veo.validateAspectRatio(undefined), undefined);
  });
});

// --- authentication header ---------------------------------------------------

describe("Veo authentication", () => {
  it("sends the credential as x-goog-api-key, never as Authorization", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION });
    await veo.googleVeoVideoProvider.submit(textToVideo());

    assert.equal(recorded[0].apiKeyHeader, KEY);
    assert.equal(recorded[0].authorizationHeader, undefined);
  });

  it("never puts the credential in the URL", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION });
    await veo.googleVeoVideoProvider.submit(textToVideo());

    for (const call of recorded) {
      assert.ok(!call.url.includes(KEY), `credential leaked into URL: ${call.url}`);
      assert.ok(!call.url.includes("key="), `query-parameter auth used: ${call.url}`);
    }
  });

  it("sends the credential when polling too", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION, done: false });
    await veo.googleVeoVideoProvider.poll(OPERATION);
    assert.equal(recorded[0].apiKeyHeader, KEY);
  });

  it("posts JSON with the right content type", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION });
    await veo.googleVeoVideoProvider.submit(textToVideo());
    assert.equal(recorded[0].method, "POST");
    assert.match(recorded[0].contentType ?? "", /application\/json/);
  });

  it("reports itself unconfigured when no credential is set", () => {
    const saved = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      assert.equal(veo.googleVeoVideoProvider.isConfigured(), false);
    } finally {
      process.env.GOOGLE_API_KEY = saved;
    }
  });
});

// --- endpoint and model ------------------------------------------------------

describe("Veo endpoint", () => {
  it("posts to {model}:predictLongRunning", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION });
    await veo.googleVeoVideoProvider.submit(textToVideo());
    assert.equal(recorded[0].url, "/v1beta/models/veo-3.1-generate-preview:predictLongRunning");
  });

  it("honours a model chosen from the three the account exposes", async () => {
    process.env.GOOGLE_VEO_MODEL = "veo-3.1-fast-generate-preview";
    try {
      handler = (_req, res) => json(res, 200, { name: OPERATION });
      await veo.googleVeoVideoProvider.submit(textToVideo());
      assert.match(recorded[0].url, /veo-3\.1-fast-generate-preview:predictLongRunning$/);
    } finally {
      delete process.env.GOOGLE_VEO_MODEL;
    }
  });

  it("refuses a model that is not one of the three", async () => {
    process.env.GOOGLE_VEO_MODEL = "veo-9-imaginary";
    try {
      await assert.rejects(veo.googleVeoVideoProvider.submit(textToVideo()), GenerationError);
      assert.equal(recorded.length, 0);
    } finally {
      delete process.env.GOOGLE_VEO_MODEL;
    }
  });

  it("does not claim idempotency it cannot provide", () => {
    assert.equal(veo.googleVeoVideoProvider.supportsIdempotencyKey, false);
    assert.equal(veo.googleVeoVideoProvider.findJobByIdempotencyKey, undefined);
  });

  it("declares itself a real, billed provider", () => {
    assert.equal(veo.googleVeoVideoProvider.capabilities.kind, "real");
    assert.equal(veo.googleVeoVideoProvider.capabilities.imageToVideo, true);
    assert.deepEqual(veo.googleVeoVideoProvider.capabilities.allowedDurationsSeconds, [4, 6, 8]);
  });
});

// --- operation polling -------------------------------------------------------

describe("Veo operation polling", () => {
  it("returns the operation name as the job handle", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION });
    const handle = await veo.googleVeoVideoProvider.submit(textToVideo());
    assert.equal(handle.providerJobId, OPERATION);
  });

  it("parks as indeterminate when no operation name comes back", async () => {
    handler = (_req, res) => json(res, 200, {});
    const error = (await veo.googleVeoVideoProvider
      .submit(textToVideo())
      .catch((e: unknown) => e)) as InstanceType<typeof GenerationError>;
    assert.equal(error.kind, "INDETERMINATE", "a possible billed render must not be resubmitted");
  });

  it("polls the operation name verbatim as the path", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION, done: false });
    await veo.googleVeoVideoProvider.poll(OPERATION);
    assert.equal(recorded[0].method, "GET");
    assert.equal(recorded[0].url, `/v1beta/${OPERATION}`);
  });

  it("reports an unfinished operation as processing, not as a failure", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION, done: false });
    assert.deepEqual(await veo.googleVeoVideoProvider.poll(OPERATION), { status: "processing" });
  });

  it("treats a missing done flag as still processing", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION });
    assert.deepEqual(await veo.googleVeoVideoProvider.poll(OPERATION), { status: "processing" });
  });
});

// --- successful response parsing + download ----------------------------------

describe("Veo successful generation", () => {
  const clip = mp4({ width: 1920, height: 1080, timescale: 600, duration: 3600 });

  function serveCompletedThenFile(uri: string): void {
    handler = (req, res) => {
      if (req.url?.includes(":download")) {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(clip);
        return;
      }
      json(res, 200, completedOperation(uri));
    };
  }

  it("reads the video from response.generateVideoResponse.generatedSamples[0].video.uri", async () => {
    serveCompletedThenFile(`${base}/files/xyz789:download`);
    const result = await veo.googleVeoVideoProvider.poll(OPERATION);

    assert.equal(result.status, "completed");
    assert.ok(result.status === "completed");
    assert.ok(result.video.data.equals(clip));
  });

  it("downloads through the Files API with the credential attached", async () => {
    serveCompletedThenFile(`${base}/files/xyz789:download`);
    await veo.googleVeoVideoProvider.poll(OPERATION);

    const download = recorded.find((r) => r.url.includes(":download"));
    assert.ok(download, "no download request was made");
    assert.equal(download.apiKeyHeader, KEY, "the returned URI is not a public link");
    assert.match(download.url, /\/v1beta\/files\/xyz789:download\?alt=media$/);
  });

  it("rebuilds the download URL from the configured host, whatever host the URI names", () => {
    const url = veo.downloadUrlFor("https://generativelanguage.googleapis.com/v1beta/files/abc123:download");
    assert.equal(url, `${base}/files/abc123:download?alt=media`);
  });

  it("refuses a URI with no files/ segment rather than guessing one", () => {
    assert.throws(() => veo.downloadUrlFor("https://example.com/videos/1.mp4"), GenerationError);
  });

  it("returns bytes the existing metadata parser can measure", async () => {
    serveCompletedThenFile(`${base}/files/xyz789:download`);
    const result = await veo.googleVeoVideoProvider.poll(OPERATION);
    assert.ok(result.status === "completed");

    // The runner measures rather than trusting the request parameters; this is
    // the integration point that makes that possible.
    const measured = readVideoMetadata(result.video.data);
    assert.equal(measured.mimeType, "video/mp4");
    assert.equal(measured.width, 1920);
    assert.equal(measured.height, 1080);
    assert.equal(measured.durationSeconds, 6);
  });

  it("does not let the provider's declared type override the measured one", async () => {
    handler = (req, res) => {
      if (req.url?.includes(":download")) {
        // A server lying about the type must not change what gets stored.
        res.writeHead(200, { "content-type": "video/quicktime" });
        res.end(clip);
        return;
      }
      json(res, 200, completedOperation(`${base}/files/xyz789:download`));
    };
    const result = await veo.googleVeoVideoProvider.poll(OPERATION);
    assert.ok(result.status === "completed");
    assert.equal(readVideoMetadata(result.video.data).mimeType, "video/mp4");
  });
});

// --- failed operation handling -----------------------------------------------

describe("Veo failed operations", () => {
  it("reports an operation error with Google's own status and message", async () => {
    handler = (_req, res) =>
      json(res, 200, {
        name: OPERATION,
        done: true,
        error: { code: 3, status: "INVALID_ARGUMENT", message: "Unsupported video request." },
      });

    const result = await veo.googleVeoVideoProvider.poll(OPERATION);
    assert.equal(result.status, "failed");
    assert.ok(result.status === "failed");
    assert.match(result.error, /INVALID_ARGUMENT/);
    assert.match(result.error, /Unsupported video request/);
  });

  it("treats a safety-filtered result as a failure, not as something to retry", async () => {
    handler = (_req, res) =>
      json(res, 200, {
        name: OPERATION,
        done: true,
        response: {
          generateVideoResponse: {
            raiMediaFilteredCount: 1,
            raiMediaFilteredReasons: ["Violative content"],
          },
        },
      });

    const result = await veo.googleVeoVideoProvider.poll(OPERATION);
    assert.ok(result.status === "failed");
    assert.match(result.error, /safety filters/i);
    assert.match(result.error, /Violative content/);
    assert.match(result.error, /will not be retried/);
  });

  it("reports a done operation with neither video nor reason honestly", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION, done: true, response: {} });
    const result = await veo.googleVeoVideoProvider.poll(OPERATION);
    assert.ok(result.status === "failed");
    assert.match(result.error, /no video, and gave no reason/);
  });

  it("classifies a rejected credential as permanent", async () => {
    handler = (_req, res) =>
      json(res, 403, { error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } });
    const error = (await veo.googleVeoVideoProvider
      .submit(textToVideo())
      .catch((e: unknown) => e)) as InstanceType<typeof GenerationError>;
    assert.equal(error.kind, "PERMANENT");
  });

  it("classifies a rejected request as permanent", async () => {
    handler = (_req, res) =>
      json(res, 400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "bad" } });
    const error = (await veo.googleVeoVideoProvider
      .submit(textToVideo())
      .catch((e: unknown) => e)) as InstanceType<typeof GenerationError>;
    assert.equal(error.kind, "PERMANENT");
  });

  it("classifies rate limiting and server faults as retryable", async () => {
    for (const status of [429, 500, 503]) {
      recorded = [];
      handler = (_req, res) => json(res, status, { error: { code: status, message: "later" } });
      const error = (await veo.googleVeoVideoProvider
        .submit(textToVideo())
        .catch((e: unknown) => e)) as InstanceType<typeof GenerationError>;
      assert.equal(error.kind, "RETRYABLE", `status ${status} should be retryable`);
    }
  });

  it("does not crash on a non-JSON response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end("<html>nope</html>");
    };
    await assert.rejects(veo.googleVeoVideoProvider.submit(textToVideo()), GenerationError);
  });
});

// --- the 500 MB ceiling ------------------------------------------------------

describe("Veo download size ceiling", () => {
  /**
   * The abort-mid-transfer behaviour itself is proven in media-download.test.ts
   * against a real stream. What is checked here is the wiring: that this adapter
   * hands that helper the storage layer's own video ceiling rather than a number
   * of its own, so the two can never drift apart.
   */
  it("treats an oversized render as permanent, and every other download fault as retryable", async () => {
    const { MediaDownloadError } = await import("./media-download.ts");

    assert.equal(
      veo.classifyDownloadFailure(new MediaDownloadError("too-large", "over 500MB")).kind,
      "PERMANENT",
      "retrying would re-download the same oversized file and fail identically"
    );

    for (const kind of ["bad-status", "transport", "empty"] as const) {
      assert.equal(
        veo.classifyDownloadFailure(new MediaDownloadError(kind, "x")).kind,
        "RETRYABLE",
        `${kind} can be transient`
      );
    }
  });

  it("uses the storage layer's 500 MB video ceiling", () => {
    assert.equal(MAX_BYTES.video, 500 * 1024 * 1024);

    const source = readFileSync(
      path.join(import.meta.dirname, "video-providers", "google-veo.ts"),
      "utf8"
    );
    assert.match(
      source,
      /maxBytes:\s*MAX_BYTES\.video/,
      "the download cap must be the storage layer's constant, not a local literal"
    );
  });
});

// --- credential non-leakage --------------------------------------------------

describe("Veo credential non-leakage", () => {
  it("never puts the credential in the request body", async () => {
    handler = (_req, res) => json(res, 200, { name: OPERATION });
    await veo.googleVeoVideoProvider.submit(
      textToVideo({ durationSeconds: 8, resolution: "1080p", aspectRatio: "16:9" })
    );
    assert.ok(!JSON.stringify(recorded[0].body).includes(KEY));
  });

  it("never puts the credential in an error message, on any failure path", async () => {
    const paths: Array<() => void> = [
      () => {
        handler = (_req, res) =>
          json(res, 403, { error: { code: 403, status: "PERMISSION_DENIED", message: "no" } });
      },
      () => {
        handler = (_req, res) => json(res, 400, { error: { message: "bad request" } });
      },
      () => {
        handler = (_req, res) => json(res, 429, { error: { message: "slow down" } });
      },
      () => {
        handler = (_req, res) => json(res, 500, { error: { message: "boom" } });
      },
      () => {
        handler = (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" }).end("not json");
        };
      },
    ];

    for (const setup of paths) {
      recorded = [];
      setup();
      const error = (await veo.googleVeoVideoProvider
        .submit(textToVideo())
        .catch((e: unknown) => e)) as Error;
      assert.ok(error instanceof Error);
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.ok(!rendered.includes(KEY), `credential leaked into an error: ${error.message}`);
    }
  });

  it("names the variable, not the value, when the credential is missing", async () => {
    const saved = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const error = (await veo.googleVeoVideoProvider
        .submit(textToVideo())
        .catch((e: unknown) => e)) as InstanceType<typeof GenerationError>;
      assert.equal(error.kind, "PERMANENT");
      assert.match(error.message, /GOOGLE_API_KEY is not set/);
      assert.ok(!error.message.includes(saved ?? " "));
    } finally {
      process.env.GOOGLE_API_KEY = saved;
    }
  });

  it("reads the credential in exactly one module", () => {
    const dir = path.join(import.meta.dirname, "video-providers");
    const readers = ["google-veo.ts", "local-stub.ts", "index.ts", "types.ts"].filter((f) =>
      readFileSync(path.join(dir, f), "utf8").includes("process.env.GOOGLE_API_KEY")
    );
    assert.deepEqual(readers, ["google-veo.ts"]);
  });
});
