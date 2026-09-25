import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { png } from "./image-metadata.test.ts";

const {
  generateGeminiImage,
  geminiImageProvider,
  configuredGeminiImageModel,
  isGeminiImageConfigured,
  GEMINI_IMAGE_MODEL_ENV,
} = await import("./image-providers/gemini-image.ts");
const { GenerationError } = await import("../jobs/state.ts");

/**
 * The Gemini image adapter, against a local server that speaks its protocol.
 *
 * **These are not verification that Google works.** They exercise this
 * application's half of the conversation — the URL it builds, the header it
 * sends, the body it composes, and which replies it accepts or refuses —
 * against a server whose answers the test chooses. A green run says the adapter
 * is correct about the contract in `docs/gemini-image-api-contract.md`, which
 * was read out of Google's own SDK. It says nothing about the live service,
 * which has never been called from here.
 */

interface Recorded {
  method: string;
  path: string;
  apiKey: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

let recorded: Recorded[] = [];
let reply: (req: IncomingMessage, res: ServerResponse) => void;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = { __raw: raw };
    }
    recorded.push({
      method: req.method ?? "",
      path: req.url ?? "",
      apiKey: req.headers["x-goog-api-key"] as string | undefined,
      contentType: req.headers["content-type"] as string | undefined,
      body,
    });
    reply(req, res);
  });
});

const MODEL = "gemini-test-image-model";

/** The happy path: a real, decodable PNG inside the documented envelope. */
function respondWithImage(width = 1024, height = 768, mimeType = "image/png") {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ inlineData: { mimeType, data: png(width, height).toString("base64") } }],
            },
            finishReason: "STOP",
          },
        ],
      })
    );
  };
}

function respondWith(status: number, body: unknown) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GOOGLE_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
  process.env.GOOGLE_API_KEY = "test-key-not-a-real-credential";
  process.env[GEMINI_IMAGE_MODEL_ENV] = MODEL;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.GOOGLE_API_BASE_URL;
  delete process.env.GOOGLE_API_KEY;
  delete process.env[GEMINI_IMAGE_MODEL_ENV];
});

beforeEach(() => {
  recorded = [];
  reply = respondWithImage();
  process.env.GOOGLE_API_KEY = "test-key-not-a-real-credential";
  process.env[GEMINI_IMAGE_MODEL_ENV] = MODEL;
});

/** assert.rejects does not hand back the error, and these need to read it. */
async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject, and it resolved");
}

describe("the request it builds", () => {
  it("posts to the model's generateContent endpoint", async () => {
    await generateGeminiImage("a wide establishing shot");

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].method, "POST");
    assert.equal(recorded[0].path, `/v1beta/models/${MODEL}:generateContent`);
  });

  it("sends the credential as a header and never in the URL", async () => {
    await generateGeminiImage("a wide establishing shot");

    assert.equal(recorded[0].apiKey, "test-key-not-a-real-credential");
    // A URL is logged by proxies, written into error messages and kept in
    // browser history; a header is not.
    assert.ok(!recorded[0].path.includes("key="), recorded[0].path);
    assert.ok(!recorded[0].path.includes("test-key"), recorded[0].path);
  });

  it("asks for an image, in the shape the SDK puts on the wire", async () => {
    await generateGeminiImage("a wide establishing shot");
    const body = recorded[0].body;

    assert.deepEqual(body.generationConfig, { responseModalities: ["IMAGE"] });
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "a wide establishing shot" }] },
    ]);
  });

  it("sends the prompt byte for byte", async () => {
    // The compiler's vocabulary has to survive: an 85mm lens and a Low Angle
    // reach the provider exactly as the filmmaker wrote them.
    const prompt = "SHOT: Low Angle, 85mm.  Golden hour — backlit, rim-lit hair.";
    await generateGeminiImage(prompt);

    const contents = recorded[0].body.contents as Array<{ parts: Array<{ text: string }> }>;
    assert.equal(contents[0].parts[0].text, prompt);
  });

  it("sends nothing it was not asked to send", async () => {
    await generateGeminiImage("a wide establishing shot");
    // No seed, no negative prompt, no safety overrides, no size: the adapter
    // supplies only what the filmmaker stated.
    assert.deepEqual(Object.keys(recorded[0].body).sort(), ["contents", "generationConfig"]);
  });
});

describe("the reply it accepts", () => {
  it("returns the bytes and the dimensions read out of them", async () => {
    reply = respondWithImage(1200, 800);
    const image = await generateGeminiImage("a wide establishing shot");

    assert.equal(image.mimeType, "image/png");
    assert.equal(image.width, 1200);
    assert.equal(image.height, 800);
    assert.ok(image.data.byteLength > 0);
  });

  it("believes the bytes rather than the provider's claim about them", async () => {
    // The envelope says JPEG; the bytes are a PNG. The header wins, because it
    // is what the file actually is.
    reply = respondWithImage(640, 480, "image/jpeg");
    const image = await generateGeminiImage("a wide establishing shot");

    assert.equal(image.mimeType, "image/png");
    assert.equal(image.width, 640);
  });

  it("skips a text part and takes the image one", async () => {
    reply = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "Here is the frame you asked for." },
                  { inlineData: { mimeType: "image/png", data: png(300, 200).toString("base64") } },
                ],
              },
            },
          ],
        })
      );
    };

    const image = await generateGeminiImage("a wide establishing shot");
    assert.equal(image.width, 300);
  });
});

describe("the replies it refuses", () => {
  it("refuses a response that is only text, and quotes what was said", async () => {
    // A model asked for an image may answer with a refusal. That is not an
    // empty success, and reporting it as one would store a zero-byte asset.
    reply = respondWith(200, {
      candidates: [{ content: { parts: [{ text: "I can't generate that image." }] } }],
    });

    const error = await caught(() => generateGeminiImage("a wide establishing shot"));
    assert.ok(error instanceof GenerationError);
    assert.equal(error.kind, "PERMANENT");
    assert.match(error.message, /answered with text instead of an image/);
    assert.match(error.message, /I can't generate that image/);
  });

  it("refuses a response with no candidates at all", async () => {
    reply = respondWith(200, { candidates: [] });
    const error = await caught(() => generateGeminiImage("a wide establishing shot"));
    assert.equal((error as InstanceType<typeof GenerationError>).kind, "PERMANENT");
    assert.match(error.message, /no image data/);
  });

  it("refuses inline data that is not an image", async () => {
    reply = respondWith(200, {
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("not an image").toString("base64") } }],
          },
        },
      ],
    });

    const error = await caught(() => generateGeminiImage("a wide establishing shot"));
    assert.equal((error as InstanceType<typeof GenerationError>).kind, "PERMANENT");
  });

  it("treats a 200 that is not JSON as something in the middle answering", async () => {
    reply = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end("<html><body>Gateway</body></html>");
    };

    const error = await caught(() => generateGeminiImage("a wide establishing shot"));
    assert.equal((error as InstanceType<typeof GenerationError>).kind, "RETRYABLE");
    assert.match(error.message, /non-JSON body/);
  });
});

describe("how it classifies failure", () => {
  const permanent = [
    [401, "a bad credential"],
    [403, "a forbidden key"],
    [400, "a rejected request"],
    [404, "an unknown model"],
  ] as const;

  for (const [status, what] of permanent) {
    it(`treats ${status} (${what}) as permanent, so it does not burn attempts`, async () => {
      reply = respondWith(status, { error: { message: "no", code: status, status: "X" } });
      const error = await caught(() => generateGeminiImage("a wide establishing shot"));
      assert.equal((error as InstanceType<typeof GenerationError>).kind, "PERMANENT");
    });
  }

  for (const status of [429, 500, 503] as const) {
    it(`treats ${status} as retryable`, async () => {
      reply = respondWith(status, { error: { message: "busy" } });
      const error = await caught(() => generateGeminiImage("a wide establishing shot"));
      assert.equal((error as InstanceType<typeof GenerationError>).kind, "RETRYABLE");
    });
  }

  it("names the model variable on a 404, where a wrong one lands", async () => {
    reply = respondWith(404, { error: { message: "models/nope is not found" } });
    const error = await caught(() => generateGeminiImage("a wide establishing shot"));
    assert.match(error.message, new RegExp(GEMINI_IMAGE_MODEL_ENV));
  });

  it("quotes the provider's own message without leaking the key", async () => {
    reply = respondWith(400, { error: { message: "Invalid value for responseModalities" } });
    const error = await caught(() => generateGeminiImage("a wide establishing shot"));

    assert.match(error.message, /Invalid value for responseModalities/);
    assert.ok(!error.message.includes("test-key-not-a-real-credential"));
  });
});

describe("what it refuses to guess", () => {
  it("will not invent a model id", async () => {
    // Which Gemini models return images is a fact about Google's catalogue, not
    // about its SDK, and a wrong guess is a 404 on a billed path.
    delete process.env[GEMINI_IMAGE_MODEL_ENV];

    assert.equal(configuredGeminiImageModel(), undefined);
    assert.equal(isGeminiImageConfigured(), false);

    const error = await caught(() => generateGeminiImage("a wide establishing shot"));
    assert.equal((error as InstanceType<typeof GenerationError>).kind, "PERMANENT");
    assert.match(error.message, new RegExp(GEMINI_IMAGE_MODEL_ENV));
    assert.equal(recorded.length, 0, "and it made no request");
  });

  it("reports itself unconfigured without a credential", async () => {
    delete process.env.GOOGLE_API_KEY;
    assert.equal(isGeminiImageConfigured(), false);

    const error = await caught(() => generateGeminiImage("a wide establishing shot"));
    assert.equal((error as InstanceType<typeof GenerationError>).kind, "PERMANENT");
    assert.equal(recorded.length, 0);
  });

  it("refuses a size rather than ignoring one", async () => {
    // The API has no dimension parameter. Dropping a stated size silently would
    // return an image of some other shape and call it what was asked for.
    const error = await caught(() => generateGeminiImage("a wide shot", "1024x1024"));
    assert.equal((error as InstanceType<typeof GenerationError>).kind, "PERMANENT");
    assert.match(error.message, /cannot be asked for a size/);
    assert.equal(recorded.length, 0);
  });

  it("refuses an empty prompt", async () => {
    const error = await caught(() => generateGeminiImage("   "));
    assert.equal((error as InstanceType<typeof GenerationError>).kind, "PERMANENT");
    assert.equal(recorded.length, 0);
  });
});

describe("what it declares about itself", () => {
  it("declares no sizes and no default, because it accepts neither", async () => {
    assert.deepEqual(geminiImageProvider.capabilities?.sizes, []);
    assert.equal(
      geminiImageProvider.capabilities?.defaultSize,
      undefined,
      "absent means 'does not accept a size', not 'has one nobody named'"
    );
  });

  it("does not claim an idempotency guarantee it has no way to honour", async () => {
    // A false claim here would let the worker resubmit after a crash and bill a
    // second render.
    assert.equal(geminiImageProvider.supportsIdempotencyKey, false);
  });

  it("reports the configured model in the audit trail, and says so when there is none", async () => {
    assert.equal(geminiImageProvider.model, MODEL);
    delete process.env[GEMINI_IMAGE_MODEL_ENV];
    assert.match(geminiImageProvider.model, /no model configured/);
  });

  it("is a real provider, never a stub", async () => {
    assert.equal(geminiImageProvider.capabilities?.kind, "real");
  });
});
