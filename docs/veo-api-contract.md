# Google Veo — Gemini Developer API contract

> ## 11.5 LIVE GOOGLE VEO VERIFICATION — DEFERRED
>
> **No request from this codebase has ever reached Google.** The adapter, this
> contract and the project-format wiring are complete and unit-tested against a
> local server; the single real generation that would verify them has not been
> performed, because `GOOGLE_API_KEY` has never been present in a runtime that
> could make the call.
>
> Deferred pending external environment configuration. Until a real generation
> completes successfully, Google Veo integration is **implemented, not
> verified**, and nothing in this repository should be read as claiming
> otherwise. Sections 3–10 below record which parts remain unverified and why.

Source of truth for `src/lib/ai/video-providers/google-veo.ts`.
Nothing here is recalled from memory. Every line cites the artifact it was read from.

Sources:

- **[D]** Google's machine-readable API definition,
  `https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta`,
  `"name": "generativelanguage"`, `"revision": "20260918"`. Fetched unauthenticated.
- **[S]** Google's published SDK `@google/genai@2.23.0` (`npm pack`), file
  `dist/index.mjs`. The `*ToMldev` / `*FromMldev` transformers are the functions that
  actually build and parse the Gemini Developer API wire format. The `*ToVertex`
  variants are a *different* backend and must not be copied.
- **[P]** The authenticated probe run recorded in `artifacts/veo-api-contract.json`.

> Doc comments in `dist/genai.d.ts` describe **both** backends at once and are NOT
> authoritative for this one. `genai.d.ts` documents `seed`, `generateAudio` and `fps`,
> but `generateVideosConfigToMldev` **throws** on all three. The transformer wins.

## 1. Endpoint

```
POST https://generativelanguage.googleapis.com/v1beta/{model}:predictLongRunning
```

`[D]` `models.predictLongRunning`, flatPath `v1beta/models/{modelsId}:predictLongRunning`,
request `PredictLongRunningRequest`, response `Operation`.
Credential is sent as the `x-goog-api-key` header, never as `?key=`.

## 2. Request envelope

`[D]` `PredictLongRunningRequest`:

| field | type | required |
|---|---|---|
| `instances` | array | **Required** |
| `parameters` | any | optional |
| `labels` | map<string,string> | optional — `[S]` **rejects it on this backend** |

`[P]` confirms `instances` is required and is the correct name: `{}` and `{"instances": []}`
both return `400 "No instances in the request."`

`instances` and `parameters` are typed `any` in `[D]`, which is why probing could not
recover their contents — see §10.

## 3. Request body — `instances[0]`

`[S]` `generateVideosParametersToMldev`, `generateVideosSourceToMldev`:

| JSON path | source |
|---|---|
| `instances[0].prompt` | text prompt |
| `instances[0].image` | first-frame image (image-to-video) |
| `instances[0].video` | input video (video extension) |
| `instances[0].lastFrame` | last-frame image — image-to-video only |
| `instances[0].referenceImages[]` | `{ image, referenceType }` |

## 4. Request body — `parameters`

`[S]` `generateVideosConfigToMldev`. **Accepted:**

| JSON path | SDK name |
|---|---|
| `parameters.sampleCount` | `numberOfVideos` |
| `parameters.durationSeconds` | `durationSeconds` |
| `parameters.aspectRatio` | `aspectRatio` |
| `parameters.resolution` | `resolution` |
| `parameters.personGeneration` | `personGeneration` |
| `parameters.negativePrompt` | `negativePrompt` |
| `parameters.enhancePrompt` | `enhancePrompt` |

**Rejected on this backend** (the SDK throws before sending): `outputGcsUri`, `fps`,
`seed`, `pubsubTopic`, `generateAudio`, `mask`, `compressionQuality`, `labels`,
`resizeMode`. Vertex AI only.

`enhancePrompt` is Google-side prompt rewriting. Phase 11.4 forbids an LLM rewriting
step, and 11.x forbids silently modifying filmmaker decisions, so the adapter must send
`enhancePrompt: false` explicitly rather than omit it and inherit a server default.

## 5. Image encoding (image-to-video)

`[S]` `imageToMldev`:

```json
{ "bytesBase64Encoded": "<base64>", "mimeType": "image/png" }
```

`gcsUri` **throws** on this backend. Note the asymmetry — `[S]` `videoToMldev` uses
`encodedVideo` + `encoding`, not `bytesBase64Encoded` + `mimeType`.

## 6. Operation lifecycle

`[D]` response is `Operation`: `name`, `done`, `error` (`Status`), `metadata`, `response`.

## 7. Polling

`[S]` line 23914: `path = formatMap('{operationName}', ...)` — the operation name is used
verbatim as the path.

```
GET https://generativelanguage.googleapis.com/v1beta/{operation.name}
```

`[D]` `models.operations.get` → `GET v1beta/{+name}`, response `Operation`.
Terminal when `done === true`; then exactly one of `error` / `response` is set.

## 8. Result path

`[S]` `generateVideosOperationFromMldev` reads `['response', 'generateVideoResponse']`
— note singular `generateVideoResponse` wrapping plural `generatedSamples`:

```
operation.response.generateVideoResponse.generatedSamples[0].video.uri
```

`[S]` `generateVideosResponseFromMldev` also exposes `raiMediaFilteredCount` and
`raiMediaFilteredReasons` at that same level. A safety-filtered result returns
`done: true` with **no** `generatedSamples` and a non-zero `raiMediaFilteredCount`.
That is a PERMANENT failure, not RETRYABLE — it must not consume retry budget.

`[S]` `videoFromMldev` maps `uri`, `encodedVideo` → bytes, `encoding` → mime type.

## 9. Downloading the bytes

`[S]` `tFileName` + `downloadFile`: the returned `uri` is a Files API URL. The SDK takes
the segment after `files/`, then:

```
GET https://generativelanguage.googleapis.com/v1beta/files/{id}:download?alt=media
```

issued **through the authenticated client**, so `GOOGLE_API_KEY` is required on the
download too. The URI is not a public link.

This is exactly what `src/lib/ai/media-download.ts` (11.5 prep) is for — the cap must be
enforced during transfer, and `readVideoMetadata` measures the result. Dimensions and
duration are measured from the bytes, never taken from the request parameters.

## 10. Models

`[P]` `listModels` filtered to those declaring `predictLongRunning`, plus each model's
`GET /v1beta/models/{id}` detail. Three exist, all Veo 3.1, all preview:

| model | displayName | inputTokenLimit | methods |
|---|---|---|---|
| `models/veo-3.1-generate-preview` | Veo 3.1 | 480 | `predictLongRunning` |
| `models/veo-3.1-fast-generate-preview` | Veo 3.1 fast | 480 | `predictLongRunning` |
| `models/veo-3.1-lite-generate-preview` | Veo 3.1 lite | 480 | `predictLongRunning` |

All three are `-preview`. The adapter pins exactly one model ID explicitly and records it
on the Generation for the audit trail. A preview ID can be withdrawn, so an unknown-model
rejection is PERMANENT, not retryable.

## 11. Prompt budget — `inputTokenLimit: 480`

This is the constraint with real consequences for the compiler, and it is roughly **60x
tighter than the image provider**: `openai.ts` allows `MAX_PROMPT_CHARACTERS = 32_000`.

Measured against the Phase 3 worked example (Shot 12, fully specified, every temporal
field populated), rendered through `renderVideoPrompt`:

| prompt | chars | words |
|---|---|---|
| text-to-video | 948 | 148 |
| image-to-video | 798 | 126 |

That fits, with roughly a 2x margin. But the margin is not guaranteed: a scene with
several characters, a long `action`, or long dialogue will grow the prompt, and Veo's
tokenizer is not available locally, so the true count cannot be computed here.

Two rules follow, and they are not optional:

1. **The adapter must never truncate the prompt to fit.** Truncation silently discards
   filmmaker decisions, which every phase from 3 onward forbids. A prompt that cannot
   fit is a PERMANENT failure naming the overflow, so the filmmaker decides what to cut.
2. **A local pre-check cannot be authoritative**, because we cannot count Veo's tokens.
   It may reject early on a conservative budget, but a provider-side rejection must be
   surfaced verbatim rather than worked around.

## 12. Not yet established

Per-model allowed values for `durationSeconds`, `resolution` and `aspectRatio` are
**model-specific** and appear in none of the three sources above:

- `[D]` types `parameters` as `any`, so it carries no enum.
- `[S]` types `aspectRatio` and `resolution` as bare `string`, with no validation.
- `[P]` returns a generic `"Unsupported video generation request."` with
  `fieldViolations: null` for every malformed shape, so it leaks no field names
  or value ranges.

The model detail in `[P]` does **not** carry them either — it declares only
`inputTokenLimit`, `outputTokenLimit`, `version` and `supportedGenerationMethods`. So all
four sources have now been exhausted, and these values can only come from a real accepted
call. **Do not guess them.**
The adapter must send only values the filmmaker chose, and surface a provider
rejection verbatim rather than silently substituting a value it believes is valid.
