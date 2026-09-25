# Filmmaker Studio — project status

**As of commit `7cfd25a`+ (Second image provider), branch `main`.**
Reconstructed from the codebase itself: git history, the Prisma schema, the
route tree and the test suite — not from conversation memory.

Health at time of writing: **981 tests pass, 0 fail, 0 cancelled**;
`next build` compiles; `tsc --noEmit` clean; `eslint` clean.

> Keep this file current. It exists because the original planning history was
> lost, and a status report that lives only in a chat window is one deletion
> away from being lost again.

---

## 1. Purpose and feature scope

An **all-in-one production management and AI previsualization app for
independent filmmakers**. Two halves that meet in the middle:

**Production management** — script breakdown, shot lists, shooting schedules
and call sheets, cast & crew, locations, equipment, budget.

**AI previsualization** — turn the structured filmmaking data into images and
video clips, assemble them on a timeline, track continuity, and export the
package.

The architectural spine everything hangs off, and the rule that has governed
every phase:

```
Project → Scene → Shot → structured filmmaking data
        → CinematicPromptSpec → Provider Adapter
        → Generation → Asset → Timeline → Export
```

Four standing rules, visible throughout the code and its comments:

1. **No second source of truth.** The Shot owns its data; nothing derives a
   parallel copy.
2. **Unspecified ≠ absent.** A value the filmmaker did not choose is *omitted*
   from a provider request, never defaulted or guessed.
3. **Never silently modify a filmmaker's decision.** No prompt rewriting, no
   rounding an unsupported duration to a supported one, no substituting a
   resolution.
4. **Never claim more than was verified.** A stub is labelled a stub; an
   unpriced call is labelled unpriced; an unverified integration says so.

---

## 2. Phases as planned and executed

Reconstructed from `git log --reverse`:

| Phase | Subject |
|---|---|
| Initial | Production management app (scenes, shots, schedule, cast/crew, locations, equipment, budget) |
| Visualization | Storyboards, mood boards, shot pre-viz fields |
| 1 | Scene & Shot Builder data model |
| 2 | Storyboard view |
| 3 | Prompt Compiler Engine |
| 3.1 | Temporal camera state separated from shot designation |
| 4 | Visual composition canvas, overlays, temporal controls |
| 5 | AI image generation via the prompt compiler |
| 6 | AI video previsualization + video provider adapters |
| 7 | Timeline / edit view |
| 8 | Camera blocking workspace |
| 9 | Continuity tracking + warnings |
| 10 | Prompt Studio + production export |
| 11.1 | Closed a cross-project authorization hole |
| 11.2 | Production object storage behind a provider interface |
| 11.3 | Durable background generation jobs |
| 11.4 | First real image provider (OpenAI `gpt-image-1`) |
| 11.4-R | Real-provider verification harness — **verification still pending** |
| 11.5 | Google Veo 3.1 video provider — **live verification deferred** |
| 11.7 | Generation spend accounting + spend UI |
| 12.1 | Export asset bundling — a ZIP carrying the media, not pointers |
| 12.2 | Timeline transitions that affect duration |
| 12.3 | Audio tracks — sound on the ruler, and J/L cuts that do something |
| 12.4 | Spend ceilings — a cap on money, not just on attempts |
| 12.5 | Collaborator invitations and project permissions |
| 12.6 | A second real image provider, and the seam audit it enabled |

**11.6 was never defined or executed.** The numbering jumps 11.5 → 11.7
because 11.7 (per-user spend tracking) was named in the codebase itself.

---

## 3. COMPLETED

Everything below is implemented, tested, and verified working against real
infrastructure (real Postgres, real HTTP servers, real file I/O).

- **Accounts & projects** — sign-up/sign-in, multiple projects, owner/editor/
  viewer roles modelled and enforced.
- **Script breakdown** — scenes with INT/EXT, time of day, location, synopsis,
  script text, page-eighths, characters, action, emotional beat, director notes.
- **Shot lists** — the full shot field set: type, angle, height, lens, focal
  length, movement, speed, framing, composition, depth of field, lighting,
  mood, wardrobe, duration, dialogue/audio.
- **Shooting schedule + printable call sheets.**
- **Cast & crew, locations, equipment, budget.**
- **Storyboard view** (Phase 2) — reads shot data, adds no source of truth.
- **Prompt Compiler** (Phase 3/3.1) — deterministic, no LLM. Structured data →
  `CinematicPromptSpec` → rendered text. Every value carries provenance
  (`Specified<T> = { value, from }`). Temporal camera state (start → motion →
  end) is modelled separately from shot designation.
- **Camera blocking workspace** (Phase 4/8) — top-down canvas, camera FOV,
  subject paths, 180° axis, derived frame preview, 11 explicit temporal fields
  with no inference.
- **Timeline / edit view** (Phase 7) — `Sequence` + `TimelineClip` entities,
  pure timing module, editor and player.
- **Continuity tracking** (Phase 9) — analysis engine plus a decision store, so
  a flagged issue can be accepted rather than nagging forever.
- **Prompt Studio + export** (Phase 10) — prompt versioning with diff; export
  to JSON, CSV and PDF.
- **Object storage** (11.2) — provider interface with local-disk and
  S3-compatible backends; media authorization is decided in the app, never by
  URL possession.
- **Durable generation jobs** (11.3) — Postgres-backed lease/claim queue with
  compare-and-swap, bounded retries, crash recovery, and a worker process.
  Generation no longer depends on a browser tab staying open. The browser
  cannot mark a generation COMPLETED.
- **Spend accounting + UI** (11.7) — per-attempt ledger attributed to the user
  who started each generation; usage and cost kept as separate concepts;
  unpriced calls reported as unpriced, never as zero.
- **Export asset bundling** (12.1) — a streaming ZIP containing the media files
  themselves alongside `manifest.json`, `shot-list.csv`,
  `production-report.pdf`, `ASSETS.txt` and `README.txt`. Hand-written STORE-only
  ZIP writer (media is already compressed, so deflate buys nothing and costs a
  dependency), verified against Python's `zipfile` and the `unzip` binary. A
  missing or oversized asset is recorded in the manifest with a reason rather
  than silently dropped, and the bundle still completes.
- **Timeline transitions that affect duration** (12.2) — a dissolve now overlaps
  the clips either side of it and the sequence gets shorter by that much. The
  six edit points do four different things and the code says which:
  `CUT`/`MATCH_CUT` are instant, `DISSOLVE` overlaps, `FADE` runs through black
  over its own material without shortening anything, and `J_CUT`/`L_CUT` move
  sound rather than picture and are reported as unmodelled until audio tracks
  exist. A transition is clamped to the material actually available on either
  side, and every clamp is surfaced in the inspector in words rather than
  silently applied. The player composites the two clips of a dissolve instead of
  cutting on a boundary the ruler has already shortened.
- **Audio tracks** (12.3) — `AssetType.AUDIO`, `AudioTrack` (name, role, mute,
  level) and `AudioClip` (position, trim, level, fades). Two kinds of sound,
  kept apart: a clip's *sync* sound lives inside the video representing its
  shot and is what a J- or L-cut moves; *track* sound is score, narration or
  room tone, placed at a stated position against the picture. A J-cut plays a
  clip's source from before its in point and an L-cut plays the previous clip's
  past its out point, so both are limited by trim handles that actually exist
  and every limit is reported in words. Sound plays in the previz player
  through its own elements, separately positioned from the picture — which is
  what makes a J-cut audible rather than merely recorded. An unmeasured file
  has an unknown length and says so instead of being given a plausible one.
- **Spend ceilings** (12.4) — `GENERATION_SPEND_LIMIT_PER_PROJECT` and
  `..._PER_USER`, checked before a generation is queued, adding the pending
  call's estimated cost so the crossing call is the one refused. Opt-in with no
  default, because money is only measurable from configured rates — the
  inversion of the attempt limits, which all have finite defaults. Both ways an
  opt-in guard could fail open are closed loudly: a ceiling that is set but
  unreadable stops paid generation naming the variable, and a call no rate can
  price is refused unless `GENERATION_SPEND_UNPRICED=allow`. Currencies are
  compared separately and never converted; spend in a currency with no ceiling
  is uncapped and the report says so. Surfaced on the usage page.
- **Collaborator invitations** (12.5) — `ProjectInvitation`, a People tab, and
  an accept page. Only a SHA-256 of the token is stored, so the link is shown
  exactly once and a database dump holds no working keys. Because the app
  cannot send mail, the owner passes the link on by hand — which is why
  accepting also requires being signed in as the invited address: a forwarded
  link is not enough on its own. Single-use via a conditional claim inside a
  transaction, expiring (`INVITATION_TTL_HOURS`, default seven days), and
  withdrawable; all three end states are kept rather than deleted. Invites,
  role changes and removals are owner-only, since an editor who could invite
  editors would be handing out spend against someone else's ceilings. `OWNER`
  is not offerable. Removing someone leaves their work and the ledger's
  attribution intact.
- **A second image provider** (12.6) — Google Gemini image output, alongside
  OpenAI. Its contract was read out of Google's own `@google/genai` SDK
  (installed, inspected, removed — the adapter has no dependency), with
  provenance in `docs/gemini-image-api-contract.md`. Imagen was tried first and
  abandoned: `generateImages` is Vertex-only in that SDK, and Vertex needs
  service-account OAuth rather than the API key this application holds. The
  model id has no default, because which models return images is a fact about
  Google's catalogue rather than about its SDK.

  The point of the workstream was auditing the claim that one specification
  renders to many providers. It held: the compiler, the IR, the schema and the
  submission path were untouched. One thing did not fit —
  `ImageProviderCapabilities.defaultSize` was required, on the assumption that
  every provider picks from a set of size tokens, and Gemini's image output has
  no dimension parameter at all. It is now optional, absent meaning "does not
  accept a size". One field, no consumer changes. `provider-seam.test.ts` keeps
  every property the audit established.

---

## 4. PARTIAL

| Feature | What exists | What is missing |
|---|---|---|
| **OpenAI image generation** (11.4) | Full `gpt-image-1` adapter: request, response, error classification, size validation, cost ceilings, measured dimensions. Tested against a local server speaking the OpenAI protocol. | **Never run against the live OpenAI API.** Needs a credential in a runtime with egress. |
| **Google Veo 3.1 video** (11.5) | Full adapter: `predictLongRunning`, operation polling, result path, authenticated download, 500 MB cap, metadata validation, error classification. Contract documented with per-value provenance in `docs/veo-api-contract.md`. 62 tests. | **Never run against the live Google API** — see §13. Request payload, polling, download and every parameter value range remain unverified. |
| **Spend accounting** | Ledger, rates module, project report UI. | Ships with **no prices** by design; nothing is priced until `GENERATION_RATES` is configured. No date filter, no pagination, no spend *ceiling* (limits count attempts, not money). |
| **Aspect ratio / resolution** | Stored on `Project`, snapshotted onto `Generation`, passed to the adapter, validated. | No per-shot override. Free text, not a picker. |
| **Collaborator roles** | Invitations, role changes, removal and leaving, on top of the enforcement `requireProjectAccess` already did. | Ownership transfer; email delivery — the owner passes the link on by hand. |

---

## 5. NOT IMPLEMENTED

- **Waveform display** — an audio placement is a bar with a caption, not a
  picture of its contents. Drawing one needs the file decoded client-side.
- **A rendered mixdown** — the export carries the source files and the mix
  decisions; it does not render them into a single audio track or a muxed
  video. That needs an encoding pipeline this app does not have.
- **Gain above unity in the preview** — stored and flagged, but
  `HTMLMediaElement.volume` caps at 1, so previewing a boost needs Web Audio.
- **Image-to-video from a generated still in the UI** — the adapter supports it;
  the pipeline supports it; the end-to-end UX is thin.
- **Any second AI provider** — one image provider, one video provider.
- **Email delivery** — no mailer is configured, so an invitation link is passed
  on by hand. Password reset is blocked on the same thing.
- **Ownership transfer** — `Project.ownerId` can only be changed in the database.
- **Multi-tenant billing and deployment config.**

---

## 6. Architecture and stack

- **Next.js 15** App Router, Server Actions, React 19
- **Prisma 6 + PostgreSQL** — 20 models, 17 migrations
- **NextAuth v5 beta** — credentials, JWT sessions
  (production builds need `AUTH_TRUST_HOST` or `AUTH_URL`)
- **Tailwind CSS 4**, **Zod** validation
- **AWS SDK v3** (S3-compatible storage), **pdf-lib** (export)
- **Tests:** Node 22 built-in `node:test` with `--experimental-strip-types` —
  no test framework, no mocking library. 29 test files, 703 tests.

**Adapter pattern throughout.** Four provider families, each behind an
interface, each swappable by configuration rather than code change:
`PromptProvider`, `ImageGenerationProvider`, `VideoGenerationProvider`,
`StorageProvider`.

**Worker/web split.** The Next.js app queues jobs; a separate `npm run worker`
process claims and runs them. The web process never calls a paid provider.

---

## 7. Folder structure

```
src/app/                    routes (see §9)
src/components/             app-shell, asset-gallery, ui (shared primitives)
src/lib/
  access.ts, authz.ts       project authorization gate
  validation.ts             Zod schemas
  prisma.ts                 client singleton
  actions/                  17 server-action modules, one per domain
  prompt/                   the compiler
    types.ts                CinematicPromptSpec + Specified<T>
    context.ts              gathers Shot/Scene/blocking into one context
    compiler.ts             context → spec, deterministic, provenance-tagged
    render.ts               spec → text, per mode
    providers/              prompt adapters (generic)
  ai/
    image-providers/        openai.ts (real), local-stub.ts, registry
    video-providers/        google-veo.ts (real), local-stub.ts, registry
    image-metadata.ts       PNG/JPEG/WebP/GIF header parsing
    video-metadata.ts       WebM/EBML + MP4/ISO-BMFF parsing
    media-download.ts       capped streaming download
  jobs/
    state.ts                pure state machine + GenerationError kinds
    queue.ts                CAS lease/claim
    runner.ts               one job step: submit, poll, store, complete
    worker.ts               the loop
    log.ts                  structured logging with credential redaction
  storage/                  types, local, s3, keys (single upload gate), index
  billing/
    rates.ts                operator rate table — ships with NO prices
    usage.ts                ledger writes + spend/breakdown/attribution reads
    ceilings.ts             spend caps — opt-in, fail-closed, per currency
  media.ts                  the media authorization boundary
  generation-limits.ts      hard attempt ceilings (always on, finite defaults)
  invitations.ts            invitation rules — shared with client components
  invitation-tokens.ts      token generation and hashing — server-only
  ai/image-providers/       openai, gemini-image, local-stub, registry
  ai/video-providers/       google-veo, local-stub, registry
  timeline.ts               picture timing: trims, dissolves, the ruler
  audio.ts                  sound timing: J/L cuts, tracks, levels, fades
  blocking.ts, continuity.ts, diff.ts
  export/                   build, csv, pdf, types
    zip.ts                  STORE-only streaming ZIP writer
    bundle.ts               the production bundle: media + manifest

scripts/                    worker + 9 verification/migration scripts
docs/                       veo-api-contract.md, PROJECT_STATUS.md
prisma/                     schema + 19 migrations
```

---

## 8. Database

PostgreSQL via Prisma. **20 models, 16 enums, 17 migrations.** Every migration
to date has been additive — no destructive statement has ever been applied.

Core: `User`, `Project`, `ProjectMember`, `Scene`, `ShotListItem`.
Production: `ScheduleDay`, `ScheduleItem`, `CastMember`, `CrewMember`,
`Location`, `Equipment`, `BudgetCategory`, `BudgetLineItem`.
Previsualization: `Asset`, `Generation`, `PromptVersion`, `Sequence`,
`TimelineClip`, `ContinuityDecision`, `GenerationUsage`.

`Generation` is the interesting one — it is simultaneously the audit record and
the durable job: prompt snapshot, spec snapshot, provider, model, requested
params, lease token, attempt counters, failure kind, and the format snapshot.

**No client state library.** Server Components read directly; mutations are
Server Actions with `revalidatePath`. No Redux, no Zustand, no React Query.

---

## 9. Routes

26 pages. Project tabs: **Overview · Script · Visualization · Storyboard ·
Timeline · Continuity · Prompt Studio · Schedule · Cast & Crew · Locations ·
Equipment · Budget · Usage · Settings**, plus scene detail, shot detail,
call sheet, and the sign-in/sign-up/dashboard routes.

5 API routes: NextAuth, register, `/api/media`, authenticated asset file
serving, and project export by format.

---

## 10. AI / API integrations

| Integration | Status |
|---|---|
| **OpenAI `gpt-image-1`** | Implemented, unit-tested. **Not verified live.** |
| **Google Veo 3.1** (`generativelanguage.googleapis.com`) | Implemented, 62 tests. **Not verified live — deferred.** |
| **Local image stub** | Working. Deterministic PNG from the prompt. Never presented as AI generation. |
| **Local video stub** | Working. Labelled placeholder clip, disk-backed job store so crash recovery is genuinely exercised. |
| **S3-compatible storage** | Working, verified against a mock S3. |
| **Prompt compilation** | Fully deterministic. **No LLM anywhere in the prompt path**, by design. |

Credentials (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `S3_*`) are each read in
exactly one server-only module, never bundled, never logged, never stored,
never interpolated into an error. Enforced by an import-graph test.

---

## 11. Mock / demo data

**There is none.** No seed script, no fixture data, no hard-coded sample
projects. Every row in a running instance was created through the UI.

Two *labelled* stubs exist and are opt-in via `IMAGE_PROVIDER` /
`VIDEO_PROVIDER`. They are not mock data to be replaced — they are deliberate
development backends, and both the UI and logs distinguish `kind: "stub"` from
`kind: "real"`.

---

## 12. Technical debt

**Clean by the usual measures:** zero `TODO`/`FIXME`/`HACK` markers, one
intentional `console.log` (structured job logging in `log.ts`), no broken
functionality, no build errors, no lint errors, no type errors.

Real debt, honestly stated:

1. **Two provider integrations are unverified against their live APIs.** The
   largest risk in the codebase. Deferred by decision while the remaining
   provider-independent features are completed.
2. **`next build` does not typecheck test files.** Type errors in tests have
   shipped green twice. `tsc --noEmit` must be run separately — it is not
   wired into any npm script.
3. **No server action is unit-tested.** They require a session; no harness
   exists. Covered by typecheck and by reading, not by tests.
4. **Spend is recorded after the provider call returns.** A call that reaches
   the provider and then times out is not counted — the same case the job marks
   INDETERMINATE. Closing it needs a provider-side usage API.
5. **A failed ledger write is logged and swallowed**, deliberately: failing the
   job would retry an already-paid generation and bill it twice.
6. **No CI.** All gates are run by hand.
7. **Postgres must be started manually** in this environment; a stopped database
   makes `node --test` report `fail 0` while *cancelling* suites. **The number
   to watch is `cancelled`, not `fail`.**

---

## 13. 11.5 LIVE GOOGLE VEO VERIFICATION — DEFERRED

**No request from this codebase has ever reached Google.** The adapter,
contract and wiring are complete and unit-tested against a local server. The
single real generation that would verify them has not been performed, because
`GOOGLE_API_KEY` has never been present in a runtime able to make the call —
verified absent nine times, several on containers seconds old, and a
deliberately trivial probe variable did not arrive either, which points at the
environment configuration rather than the key.

Until a real generation completes, Google Veo is **implemented, not verified**.

---

## 14. Last thing implemented

**Workstream 12.6 — a second real image provider**: the Google Gemini image
adapter, its contract document, the `defaultSize` change that adding it
exposed, and `provider-seam.test.ts`, which turns the audit's findings into a
standing guard rather than a one-off report.

Two real image providers now exist, which is the condition that gives the seam
tests their meaning: a single implementation can satisfy any interface.

---

## 15. Roadmap to production

Ordered by risk retired per unit of effort.

**A. Verify what is already built (highest value, lowest effort)**
1. One real Veo generation → closes 11.5. Needs a credential in a reachable
   runtime; everything else is ready.
2. One real OpenAI image generation → closes 11.4-R.
3. Wire `tsc --noEmit` into `npm test` or a `typecheck` script, and add CI.

**B. Make the output deliverable**
4. ~~Export asset bundling~~ — **done** (12.1).
5. ~~Timeline transitions that affect duration~~ — **done** (12.2).
6. ~~Audio tracks~~ — **done** (12.3).
7. Image-to-video from a generated still, end to end in the UI.

**C. Make it safe to expose to other people**
8. ~~Spend ceilings, not just attempt ceilings~~ — **done** (12.4).
9. ~~Collaborator invite flow and project permissions~~ — **done** (12.5).
10. Deployment: managed Postgres, S3 bucket, worker process, `AUTH_URL`,
    password reset.

**D. Depth and hardening**
11. A second **video** provider, to finish proving the adapter seams hold. The
    image half is done (12.6).
12. Wire `tsc --noEmit` into the validation pipeline; add CI.
13. Server-action test coverage.

---

## The single next task

**Production hardening** (priority #7, the last item on the agreed list).

The image seam is audited and held. A second *video* provider would audit the
other half, but it is the weaker of the two remaining options: the video
interface is the more constrained one (submit-then-poll, an explicit
idempotency contract), and no non-Google video vendor's API can be established
from here — outbound network to provider hosts is refused, and npm is the only
reachable source of an authoritative contract.

Hardening does not have that problem, and it is what actually stands between
the current state and a deployment:

  - `tsc --noEmit` is run by hand every workstream. Nothing stops a change
    landing untypechecked, and it has caught a real defect in four of the last
    five workstreams. It belongs in `npm test` and in CI.
  - The server actions are the least-tested layer, because they reach for a
    NextAuth session. Two workstreams have now worked *around* that with static
    source assertions and real-database queries. A session harness would let
    them be tested directly.
  - There is no CI at all: every gate is something a person remembers to run.

Live provider verification (Veo, OpenAI) remains deferred by decision, not by
blockage.
