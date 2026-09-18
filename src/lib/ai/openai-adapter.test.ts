import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { png } from "./image-metadata.test.ts";

const { generateImage, openAiImageProvider, retryAfterSeconds, OPENAI_IMAGE_MODEL } = await import(
  "./image-providers/openai.ts"
);
const { GenerationError } = await import("../jobs/state.ts");

/**
 * Adapter tests against a local server that speaks the OpenAI Images protocol.
 *
 * **These are not verification that OpenAI works.** They exercise this
 * application's half of the conversation — the request it builds, the header it
 * sends, the responses it accepts, and the ones it refuses — against a server
 * whose replies are chosen by the test. A green run here says the adapter is
 * correct about the protocol as documented; it says nothing about the real
 * service, which has not been called. See the workstream report.
 */

interface Recorded {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

let recorded: Recorded[] = [];
let reply: (req: IncomingMessage, res: ServerResponse, body: unknown) => void;
let baseUrl: string;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    recorded.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    });
    reply(req, res, body);
  });
});

/** The happy path: a real, decodable PNG in the documented envelope. */
function respondWithImage(width = 1024, height = 1024) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ b64_json: png(width, height).toString("base64") }] }));
  };
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
});

after(() => {
  server.close();
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
});

beforeEach(() => {
  recorded = [];
  reply = respondWithImage();
});

describe("the request the adapter builds", () => {
  it("posts to the images endpoint with the model and prompt verbatim", async () => {
    const prompt =
      "Medium Close-Up, Low Angle, 85mm. Ravi on the platform of an abandoned railway station at night.";
    await generateImage(prompt);

    assert.equal(recorded.length, 1);
    const [request] = recorded;
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v1/images/generations");
    assert.equal(request.contentType, "application/json");

    const body = request.body as Record<string, unknown>;
    assert.equal(body.model, OPENAI_IMAGE_MODEL);
    assert.equal(
      body.prompt,
      prompt,
      "the prompt must reach the provider byte-for-byte, with no rewriting"
    );
  });

  it("preserves the filmmaker's own vocabulary without normalising it", async () => {
    // The values the workstream calls out by name: nothing here may translate
    // "85mm" into a focal-length bucket or "Low Angle" into a camera pitch.
    const prompt = "85mm lens, Low Angle, Medium Close-Up, practical sodium lighting";
    await generateImage(prompt);

    const body = recorded[0].body as Record<string, unknown>;
    assert.equal(body.prompt, prompt);
    for (const phrase of ["85mm", "Low Angle", "Medium Close-Up"]) {
      assert.ok(String(body.prompt).includes(phrase), `${phrase} did not survive the adapter`);
    }
  });

  it("sends the credential as a bearer token and nothing else", async () => {
    await generateImage("anything");
    const [request] = recorded;
    assert.equal(request.authorization, "Bearer sk-test-not-a-real-key");

    // The key must not be smuggled anywhere else — not the URL, not the body.
    assert.ok(!request.path.includes("sk-test"), "the key must not appear in the URL");
    assert.ok(
      !JSON.stringify(request.body).includes("sk-test"),
      "the key must not appear in the request body"
    );
  });

  it("sends the default size when none is requested", async () => {
    await generateImage("anything");
    const body = recorded[0].body as Record<string, unknown>;
    assert.equal(body.size, openAiImageProvider.capabilities?.defaultSize);
  });

  it("sends a supported size that was requested", async () => {
    await generateImage("anything", { size: "1024x1536" });
    assert.equal((recorded[0].body as Record<string, unknown>).size, "1024x1536");
  });
});

describe("capability validation", () => {
  it("refuses an unsupported size rather than substituting one", async () => {
    await assert.rejects(
      () => generateImage("anything", { size: "512x512" }),
      (error: unknown) =>
        error instanceof GenerationError &&
        error.kind === "PERMANENT" &&
        /cannot render 512x512/.test(error.message)
    );
    assert.equal(recorded.length, 0, "an impossible request must not reach the provider at all");
  });

  it("refuses an over-long prompt rather than truncating it", async () => {
    // Truncation would silently drop the end of a compiled prompt, which is
    // usually the lighting and the mood.
    const tooLong = "x".repeat(40_000);
    await assert.rejects(
      () => generateImage(tooLong),
      (error: unknown) =>
        error instanceof GenerationError &&
        error.kind === "PERMANENT" &&
        /Shorten it rather than letting it be cut off/.test(error.message)
    );
    assert.equal(recorded.length, 0);
  });

  it("refuses an empty prompt", async () => {
    await assert.rejects(
      () => generateImage("   "),
      (error: unknown) => error instanceof GenerationError && error.kind === "PERMANENT"
    );
    assert.equal(recorded.length, 0);
  });

  it("declares itself a real provider that cannot deduplicate a resubmission", () => {
    assert.equal(openAiImageProvider.capabilities?.kind, "real");
    assert.equal(
      openAiImageProvider.supportsIdempotencyKey,
      false,
      "the Images API has no idempotency key; claiming one would risk double billing"
    );
  });
});

describe("the response the adapter accepts", () => {
  it("returns the decoded bytes with dimensions read from them", async () => {
    reply = respondWithImage(1536, 1024);
    const image = await generateImage("anything", { size: "1536x1024" });

    assert.equal(image.mimeType, "image/png");
    assert.equal(image.width, 1536);
    assert.equal(image.height, 1024);
    assert.deepEqual(image.data.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("reports the dimensions that came back, not the ones asked for", async () => {
    // A provider that quietly returns a different size must not be recorded as
    // having honoured the request.
    reply = respondWithImage(512, 512);
    const image = await generateImage("anything", { size: "1024x1024" });
    assert.equal(image.width, 512);
    assert.equal(image.height, 512);
  });
});

describe("the responses the adapter refuses", () => {
  it("refuses an HTML error page served with a 200", async () => {
    reply = (_req, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end("<html><body>502</body></html>");

    await assert.rejects(
      () => generateImage("anything"),
      (error: unknown) => error instanceof GenerationError && /non-JSON body/.test(error.message)
    );
  });

  it("refuses JSON with no image in it", async () => {
    reply = (_req, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));

    await assert.rejects(
      () => generateImage("anything"),
      (error: unknown) =>
        error instanceof GenerationError &&
        error.kind === "PERMANENT" &&
        /no image data/.test(error.message)
    );
  });

  it("refuses base64 that decodes to something that is not an image", async () => {
    reply = (_req, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          data: [{ b64_json: Buffer.from("<html>not an image at all</html>").toString("base64") }],
        })
      );

    await assert.rejects(
      () => generateImage("anything"),
      (error: unknown) =>
        error instanceof GenerationError && /HTML page, not an image/.test(error.message)
    );
  });

  it("refuses an empty image", async () => {
    reply = (_req, res) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ b64_json: "" }] }));

    await assert.rejects(
      () => generateImage("anything"),
      (error: unknown) => error instanceof GenerationError && error.kind === "PERMANENT"
    );
  });
});

describe("error classification", () => {
  function respondWith(status: number, body: unknown, headers: Record<string, string> = {}) {
    return (_req: IncomingMessage, res: ServerResponse) =>
      res
        .writeHead(status, { "content-type": "application/json", ...headers })
        .end(typeof body === "string" ? body : JSON.stringify(body));
  }

  it("treats bad credentials as permanent", async () => {
    reply = respondWith(401, { error: { message: "Incorrect API key provided" } });
    await assert.rejects(
      () => generateImage("anything"),
      (error: unknown) =>
        error instanceof GenerationError &&
        error.kind === "PERMANENT" &&
        /rejected the credentials/.test(error.message)
    );
  });

  it("treats a rejected prompt or bad parameter as permanent", async () => {
    reply = respondWith(400, { error: { message: "Your request was rejected by our safety system" } });
    await assert.rejects(
      () => generateImage("anything"),
      (error: unknown) =>
        error instanceof GenerationError &&
        error.kind === "PERMANENT" &&
        /safety system/.test(error.message)
    );
  });

  it("treats an unknown model as permanent", async () => {
    reply = respondWith(404, { error: { message: "The model does not exist" } });
    await assert.rejects(
      () => generateImage("anything"),
      (error: unknown) => error instanceof GenerationError && error.kind === "PERMANENT"
    );
  });

  it("treats rate limiting as retryable and keeps the provider's hint", async () => {
    reply = respondWith(429, { error: { message: "Rate limit reached" } }, { "retry-after": "30" });
    await assert.rejects(
      () => generateImage("anything"),
      (error: unknown) =>
        error instanceof GenerationError &&
        error.kind === "RETRYABLE" &&
        /retry after 30s/.test(error.message)
    );
  });

  it("treats a provider outage as retryable", async () => {
    for (const status of [500, 502, 503]) {
      reply = respondWith(status, { error: { message: "server error" } });
      await assert.rejects(
        () => generateImage("anything"),
        (error: unknown) => error instanceof GenerationError && error.kind === "RETRYABLE",
        `status ${status} should be retryable`
      );
    }
  });

  it("treats an unreachable provider as retryable", async () => {
    const realBase = process.env.OPENAI_BASE_URL;
    // A port nothing is listening on: a genuine connection failure.
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1";
    try {
      await assert.rejects(
        () => generateImage("anything"),
        (error: unknown) =>
          error instanceof GenerationError &&
          error.kind === "RETRYABLE" &&
          /Could not reach the provider/.test(error.message)
      );
    } finally {
      process.env.OPENAI_BASE_URL = realBase;
    }
  });

  it("treats a missing credential as permanent", async () => {
    const realKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await assert.rejects(
        () => generateImage("anything"),
        (error: unknown) =>
          error instanceof GenerationError &&
          error.kind === "PERMANENT" &&
          /OPENAI_API_KEY/.test(error.message)
      );
      assert.equal(recorded.length, 0, "no request may be attempted without a credential");
    } finally {
      process.env.OPENAI_API_KEY = realKey;
    }
  });

  it("never puts the credential in an error message", async () => {
    reply = respondWith(401, { error: { message: "Incorrect API key provided: sk-test-not-a" } });
    await generateImage("anything").then(
      () => assert.fail("should have thrown"),
      (error: unknown) => {
        const message = (error as Error).message;
        // The provider may echo a fragment; what matters is that *we* never add
        // the key, and the header we sent is nowhere in the message.
        assert.ok(!message.includes("Bearer "), "an Authorization header leaked into an error");
        assert.ok(!message.includes("sk-test-not-a-real-key"), "the full key leaked into an error");
      }
    );
  });
});

describe("retry-after parsing", () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Response(null, { headers }) as Response;

  it("reads a numeric retry-after", () => {
    assert.equal(retryAfterSeconds(withHeaders({ "retry-after": "42" })), 42);
  });

  it("reads an HTTP-date retry-after", () => {
    const at = new Date(Date.now() + 60_000).toUTCString();
    const seconds = retryAfterSeconds(withHeaders({ "retry-after": at }));
    assert.ok(seconds !== undefined && seconds >= 55 && seconds <= 61, `got ${seconds}`);
  });

  it("caps an absurd value rather than scheduling a retry next year", () => {
    assert.equal(retryAfterSeconds(withHeaders({ "retry-after": "999999" })), 3_600);
  });

  it("returns nothing when the provider gave no hint", () => {
    assert.equal(retryAfterSeconds(withHeaders({})), undefined);
    assert.equal(retryAfterSeconds(withHeaders({ "retry-after": "soon" })), undefined);
  });
});
