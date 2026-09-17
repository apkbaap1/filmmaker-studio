import "server-only";

/**
 * OpenAI image generation. The only place OPENAI_API_KEY is read, and — via the
 * `server-only` import above — a module the bundler refuses to pull into any
 * client component, so the key cannot reach the browser even by accident.
 */
export const OPENAI_IMAGE_MODEL = "gpt-image-1";

const DEFAULT_SIZE = "1024x1024";

/**
 * Overridable so an OpenAI-compatible endpoint (Azure OpenAI, a self-hosted
 * gateway, a local stub in tests) can be used without touching this code. The
 * default is OpenAI itself.
 */
function baseUrl(): string {
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function isImageGenerationConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export interface GenerateImageOptions {
  /** Provider-native size token. Anything unset falls back to the square default. */
  size?: string;
}

export async function generateImage(
  prompt: string,
  options: GenerateImageOptions = {}
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI image generation isn't configured. Add OPENAI_API_KEY to your .env (see README) to enable it."
    );
  }

  const res = await fetch(`${baseUrl()}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size: options.size ?? DEFAULT_SIZE,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // The response body is echoed for diagnosis; the request — which carries the
    // key — deliberately never is.
    throw new Error(`Image generation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Image generation returned no image data");
  }
  return Buffer.from(b64, "base64");
}
