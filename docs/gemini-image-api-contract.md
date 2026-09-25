# Gemini image generation — API contract

Provenance for `src/lib/ai/image-providers/gemini-image.ts`, the application's
second real image provider.

Every line below is marked with where it came from. Nothing here is from
memory, and nothing that could not be traced to a source was written into the
adapter.

```
[S]  Read out of the official @google/genai SDK, version 2.24.0, installed
     from npm and inspected on disk. This is the same method used for the Veo
     adapter (see veo-api-contract.md) and for the same reason: the SDK is
     Google's own code, so its request transformers are the wire format by
     construction rather than by description.
[U]  UNVERIFIED — not knowable from inside this codebase. Where a value is
     marked [U] the adapter does not supply one; the operator must.
```

There is no `[P]` section. The outbound network in this environment refuses
connections to `generativelanguage.googleapis.com`, so no probe was made and
none of the below has been confirmed against the live service.

---

## What was tried first, and why it was abandoned

**Imagen, via `models.generateImages`.** The obvious choice for a second image
provider, and it does not work on this application's credential.

From `node_modules/@google/genai/dist/index.mjs`, `generateImagesInternal`:

```js
if (this.apiClient.isVertexAI()) { … }
else {
  throw new Error('This method is only supported by the Gemini Enterprise
    Agent Platform (previously known as Vertex AI).');
}
```

`[S]` Imagen image generation is Vertex-only in this SDK. Vertex needs a GCP
project, a location and service-account OAuth — not the API key this
application already holds. Adding it would have meant a second, heavier auth
mechanism, so it was dropped in favour of the path below, which reuses
`GOOGLE_API_KEY` exactly as the Veo adapter does.

That finding is recorded rather than discarded because the next person to
reach for "add Imagen" deserves to know it is not an afternoon's work.

---

## The contract this adapter implements

### Endpoint

```
POST {base}/models/{model}:generateContent
```

`[S]` `generateContentInternal` builds `formatMap('{model}:generateContent', …)`
on both the Vertex and the non-Vertex branch; the non-Vertex (Gemini API) branch
is the one this adapter uses. `models/` prefixing and the base URL match the Veo
adapter, which is already verified against the same host.

`{base}` is `https://generativelanguage.googleapis.com/v1beta`, overridable via
`GOOGLE_API_BASE_URL` — the same variable the Veo adapter reads, so a gateway or
a test server is configured once for both.

### Authentication

```
x-goog-api-key: $GOOGLE_API_KEY
```

`[S]` The SDK sends the credential as a header. The adapter never puts it in the
query string: a URL is logged by proxies, written into error messages and kept
in browser history, and a header is not.

### Request body

```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "<the compiled prompt>" }] }],
  "generationConfig": { "responseModalities": ["IMAGE"] }
}
```

`[S]` `generateContentParametersToMldev` places the transformed config under
`generationConfig`, and `generateContentConfigToMldev` carries
`responseModalities` through on the non-Vertex path — both read from the SDK
source, not inferred.

`[S]` `Content.role` is documented in `genai.d.ts` as "Must be either 'user' or
'model'. If not set, the service will default to 'user'." It is sent explicitly
rather than relying on that default.

`[S]` `Modality.IMAGE = "IMAGE"` — the enum's wire value, used verbatim.

Nothing else is sent. There is no size, no aspect ratio, no seed and no negative
prompt in this request, because `GenerateContentConfig` has no field for a
rendered image's dimensions. See **What this provider cannot do** below.

### Response body

```json
{
  "candidates": [
    { "content": { "parts": [ { "inlineData": { "mimeType": "image/png",
                                                "data": "<base64>" } } ] },
      "finishReason": "STOP" }
  ]
}
```

`[S]` `Candidate.content?: Content`, `Content.parts?: Part[]`,
`Part.inlineData?: Blob`, and `Blob.data` is documented as "The raw bytes of the
data. @remarks Encoded as base64 string" with `Blob.mimeType` as "The IANA
standard MIME type of the source data".

A response may carry several parts — a model asked for an image may also return
text. The adapter takes the first part that has `inlineData` with a non-empty
`data`, and refuses a response with none rather than reporting success.

### The model id

`[U]` **Not supplied by this adapter.** Which model ids serve image output on
the Gemini API is a fact about Google's catalogue, not about the SDK, and it
changes without notice. The SDK contains no list of them.

So `GOOGLE_IMAGE_MODEL` has no default, and the adapter reports itself
unconfigured until one is set — the same decision, for the same reason, as the
empty rate table in `src/lib/billing/rates.ts`. A hard-coded model id would be a
guess wearing the costume of a fact, and the failure it produces (a 404 from the
provider, on a billed request path) is worse than refusing to start.

---

## What this provider cannot do

**It cannot be asked for a size.** `GenerateContentConfig` has no width, height
or aspect-ratio field for image output `[S]`, so the adapter declares no size
tokens and sends none. The image comes back at whatever the model produces, and
its real dimensions are read from the returned bytes like every other asset
here.

This is the one place the second provider did not fit the existing interface.
`ImageProviderCapabilities.defaultSize` was required, on the assumption that
every image provider picks from a set of size tokens; it is now optional, and
absent means "this provider does not accept a size". One field, no consumer
changes — the submission path already guarded on the value being present.

**It has no idempotency-key facility.** `supportsIdempotencyKey: false`, as with
OpenAI. Claiming otherwise would let the worker resubmit after a crash and bill
a second render.

---

## Status

**Implemented, not verified.** No request has been made to the live service from
this codebase. The request shape, the response shape, the endpoint and the auth
header are all traceable to Google's own SDK; whether a given model id answers
this call, and what it charges, is not knowable from here.

The same standing rule as Veo applies: this is not claimed as working
integration until a real generation has completed.
