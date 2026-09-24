# Filmmaker Studio

An all-in-one production management app for independent filmmakers: script
breakdown, shot lists, shooting schedules and call sheets, cast & crew,
locations, equipment, and budget tracking.

## Stack

- [Next.js 15](https://nextjs.org) (App Router, Server Actions)
- [Prisma 6](https://www.prisma.io) + PostgreSQL
- [Auth.js / NextAuth v5](https://authjs.dev) (credentials, JWT sessions)
- Tailwind CSS 4
- Zod for input validation

## Features

- **Accounts & productions** — sign up, create multiple projects, invite
  collaborators (owner/editor/viewer roles are modeled in the schema).
- **Script breakdown** — scenes with INT/EXT, time of day, location,
  synopsis, script text, and page-eighths.
- **Shot lists** — per-scene shots with type, camera movement, lens,
  equipment notes, and status (planned/shot/cut).
- **Shooting schedule** — shoot days with call/wrap times, scenes assigned
  to each day, and a printable **call sheet** (cast, crew, scene order).
- **Cast & crew** — casting status per character, crew by department with
  contact info and day rates.
- **Locations** — address, contacts, permit status, notes.
- **Equipment** — owned/rented/borrowed, quantity, daily cost, vendor.
- **Budget** — categories with line items tracking estimated vs. actual
  spend.
- **Visualization Studio** — a dedicated previsualization workspace,
  following the workflow Story → Scene → Shot → Visualization → Storyboard:
  - Every scene has a **Visualization Studio** header: computed slugline
    (`INT. LOCATION — NIGHT`), assigned characters (from your cast roster),
    synopsis, action, dialogue/script, emotional beat, and director's notes.
  - A full **Shot Builder** per scene — camera (angle, height, lens, focal
    length, movement, start/end position, speed), subject movement &
    blocking, composition/framing/depth of field, lighting & mood, audio
    (dialogue, SFX, sound design), duration, edit transition & edit point,
    equipment and director's notes. Shot type, camera angle, camera
    movement, and transition fields are curated dropdowns that still accept
    free text, so you're never blocked by the preset list.
  - Project-wide mood board plus per-scene **storyboard** gallery and
    per-shot reference-image gallery — upload your own or generate with AI.
  - **AI image generation** (OpenAI `gpt-image-1`) for storyboard frames from
    a text prompt — optional, see "AI image generation" below.
  - Video generation isn't wired up yet (no provider chosen) — you can
    still upload your own video reference clips. Ask to have this added
    once you've picked a provider (Runway, Luma, etc.).

- **Storyboard** — the film's shot-by-shot visual plan. Every panel is a live
  view of its `ShotListItem` record (no duplicated storyboard data), grouped
  under each scene's slugline in chronological order, showing the shot frame,
  number, size, camera angle, movement, lens, duration, dialogue, sound,
  transition, and director's note. Drag panels to reorder (persisted to the
  shot's `order` field), duplicate a shot (the copy lands directly after its
  source), delete, add, and edit inline. Panel edits are a *partial* update —
  they only write the fields shown on the panel, so the detailed Shot Builder
  fields (camera height, focal length, composition, blocking, etc.) are never
  clobbered. Per-panel image upload/generation reuses the same asset gallery.

- **Prompt Compiler Engine** (`src/lib/prompt/`) — compiles structured shot
  data into cinematic prompts for image, video, image-to-video and storyboard
  generation. Pure, deterministic, no database access and no LLM: values the
  filmmaker selected (lens, angle, shot size, movement, duration…) are carried
  through verbatim, and values they left blank never appear. Produces a
  provider-independent `CinematicPromptSpec` first; string rendering and
  provider formatting are separate layers, so new platforms (Seedance, Veo,
  Higgsfield…) plug in as adapters without touching the data model. Run its
  tests with `npm test`.

- **Shot design canvas** (`/projects/…/scenes/…/shots/…`) — an interactive
  composition canvas per shot. A top-down stage shows the camera, its
  field-of-view cone, subjects with facing, props by layer, movement paths and
  the 180° axis (flagged in red if a camera move crosses it). A 16:9 frame view
  shows subject placement with optional overlays: rule of thirds, centre lines,
  eyeline, headroom, safe area and leading lines. Everything draggable also has
  an exact numeric control, so precision never depends on a steady hand.
  Alongside it, a temporal panel sets initial/final framing, initial/final
  composition, camera movement and speed, camera and subject start/end
  positions, subject movement and duration — and states plainly whether each
  axis will hold or change. The canvas writes to the shot's own `blocking`
  column, so there is no separate visualization store to drift out of sync, and
  dragging never rewrites the shot's text fields: promoting a frame placement
  into composition wording is an explicit button.

- **AI image generation from a shot** (`/projects/…/scenes/…/shots/…`) — two
  paths, side by side. The original free-text *Generate with AI* button is
  unchanged: type a description, get an image. The new **Filmmaker Generation**
  runs the structured path instead —
  `Shot + Blocking → ShotVisualizationContext → CinematicPromptSpec → image
  renderer → prompt adapter → image provider adapter → stored Asset`. The
  compiled prompt is shown *before* anything is generated and can be copied or
  edited; an edited prompt is sent and recorded verbatim, never silently
  recompiled. Every attempt is a `Generation` row (queued → processing →
  completed/failed) with the prompt used, a snapshot of the spec, the provider,
  and any provider error, so regenerating adds to the history rather than
  overwriting it. Provider credentials are read only inside `server-only`
  modules — a test walks the real import graph to prove no client component can
  reach them.

- **AI video previsualization** — same shot, two more modes on the same
  compiler. **Generate Video** renders the shot's *temporal* half — opening and
  closing framing, camera and subject start/end positions, movement and its
  speed, environmental movement, duration — as an explicit
  `START → MOTION → END → HOLD → DURATION` progression, with axes you stated as
  stable listed under HOLD rather than animated. **Generate Image → Video**
  animates one of the shot's existing frames under a literal PRESERVE / ANIMATE
  contract. Neither is "the image prompt plus motion words": both are
  projections of the same `CinematicPromptSpec`, and a still still drops the
  time axis entirely. Video jobs are asynchronous (submit → poll), so the rest
  of the app keeps working while one runs, and a reload resumes polling instead
  of orphaning the job.

  **No video provider is integrated yet** — none has been chosen for this
  project. The `VideoGenerationProvider` adapter interface and registry are in
  place, and a clearly-labelled local stub (`VIDEO_PROVIDER=local-stub`)
  exercises the pipeline end to end for development and tests. Nothing in the
  codebase drives Seedance, Veo, Higgsfield or Runway, and nothing claims to.

- **Timeline / edit view** (`/projects/…/timeline`) — arrange the shots you
  already have into an edit and watch the scene play through. A *sequence* owns
  *placements*, not shots: every clip carries a `shotId` and reads its camera
  data, storyboard frame and generations from the shot itself, so the timeline
  can never drift from the Shot Builder. Horizontal ruler with timecode, scene
  bands, clip blocks with thumbnails, a scrubable playhead, zoom, drag-to-
  reorder, split at the playhead, and a clip inspector.

  The distinction the whole view turns on: **a shot's intended duration and a
  clip's used duration are different things.** Trimming a 6-second shot to 3.5
  seconds writes `inPointSeconds` / `outPointSeconds` on the *placement* — the
  shot is still a 6-second shot, and the inspector says so when a generated clip
  measures something different. Removing a clip removes the placement; the shot
  stays in the project with everything attached and can be reinserted.

  Edit points (cut, dissolve, fade, match cut, J-cut, L-cut) are stated, never
  inferred: an unset boundary renders as a plain cut with no marker, and is a
  different value from an explicit **Cut**. Playback runs generated video where
  it exists and the storyboard frame where it does not, so a scene plays through
  whether or not every shot has been generated.

- **Camera blocking workspace** — the Phase 4 top-down canvas, grown into a
  proper blocking tool. Camera and every character get an explicit **path**
  (start → waypoints → end), not just a label: `cameraMovement = "Dolly In"`
  says what kind of move it is, the path says where it actually goes, and
  neither is derived from the other. Multiple characters, each with their own
  position, facing and route. The **180° axis** is stated rather than assumed —
  automatic, between two characters, along a character's direction of travel, or
  drawn by hand — and crossing it raises a **warning, never a veto**, including
  a crossing that happens only at a waypoint.

  The frame previews beside the diagram are **projected from the camera's
  geometry**: horizontal placement comes from its position, rotation and field
  of view, so moving the camera moves the subject in frame with no second value
  to drift. Subject size at the end of a move follows 1/distance from the size
  set at the start — no assumption about anyone's height. Vertical placement and
  eyeline stay the filmmaker's, because the diagram records neither camera nor
  performer height.

  Distances are stage units unless you state the stage's real size, and speed
  appears only when there is **both** a drawn path and a stated duration — a
  movement label like "Slow" is a feel, not a measurement. Blocking lives on
  `ShotListItem.blocking` as before: one spatial record per shot, so a scene can
  hold Shot 1 → Camera A and Shot 2 → Camera B with nothing shared. Version-1
  blocking is upgraded on read rather than discarded.

- **Continuity** (`/projects/…/continuity`) — a read-only analysis layer over
  the shots you already have. It compares consecutive shots within a scene, and
  shots you placed next to each other in an edit; never every shot against every
  other, so a DAY scene followed by a NIGHT scene raises nothing.

  Two rules run through all of it. **Unspecified is never absent** — a blank
  wardrobe field means you have not said yet, not that the coat is gone, and no
  rule may fire from a value that was never stated. **A difference is never an
  error** — shots are supposed to differ; findings are `INFO`, `REVIEW` or
  `POTENTIAL ISSUE`, and each one says what changed, why it may matter and which
  shots are involved.

  Covers wardrobe, hair and makeup, props carried, character presence, location,
  time of day, lighting, set props, the 180° axis across shots, screen direction,
  eyeline and camera. Screen direction comes from the Phase 8 projection rather
  than raw coordinates, and an axis the camera itself defines is skipped because
  "which side is the camera on" has no answer there. Character and prop
  timelines let you read the progression yourself; the prop timeline keeps
  **present**, **absent** and **unspecified** as three different things.

  Findings are *derived, never stored*: they are recomputed on every load, so a
  difference you actually fix disappears on its own. Only your decision —
  Reviewed, Intentional, Dismissed — is persisted, attached by the finding's
  stable key, and it annotates the difference rather than deleting it. Nothing in
  this feature writes a Shot, a Scene, blocking, the timeline or a prompt.

- **Prompt Studio** (`/projects/…/studio`) — the control centre over everything
  above, and an interface rather than another store: every value it shows is
  read from the Shots, recompiled by the compiler, or derived by the continuity
  analyser.

  Three layers are kept apart and never collapsed into one editable box:
  **Layer 1** the Shot's structured choices, **Layer 2** the provider-independent
  `CinematicPromptSpec`, **Layer 3** the rendered text — one rendering per mode
  per adapter. Editing Layer 3 for a generation never touches Layer 1.

  Per shot: Overview (shot, continuity, storyboard frame, timeline placement,
  every take with the exact prompt that produced it), Image / Video /
  Image→Video tabs with View · Edit · Copy · Save version · Reset to compiled,
  a **Provider** tab listing only adapters that actually exist, and an
  **Inspector** that prints real provenance — `85mm ← shot.focalLength` — from
  the `{ value, from }` tags the compiler already records, claiming none where
  none exists.

  **Versions are append-only.** A later compilation never rewrites an edited
  one; when a structured value changes, the Studio says so and offers both
  *"use new compiled prompt"* and *"keep version N"*. Generations keep their own
  copy of what was sent, so a take's history can never be altered by later
  editing. **Compare** is a deterministic LCS word diff — no model, no network.

  Project level adds filters (scene, prompt type, generation status, continuity)
  and the **production export**: a structured **JSON** package, a **CSV** shot
  breakdown, and a **PDF** production report. All three are built from one
  package so they cannot disagree, they read the project without changing it,
  and each states plainly which provider produced what — a stub is named as a
  stub in the UI and in the exported documents.

  Previsualization roadmap:
  1. ✅ Scene & Shot Builder (structured data model)
  2. ✅ Storyboard view: chronological panel grid, drag-drop reorder
  3. ✅ Prompt Compiler Engine (IR + renderers + provider adapters)
  4. ✅ Visual composition canvas + overlays (rule of thirds, eyeline, etc.)
  5. ✅ AI image generation driven by the compiler
  6. ✅ AI video previsualization + video provider adapters
  7. ✅ Timeline/edit view (shot clips, transitions that shorten the ruler,
     running duration)
  8. ✅ Camera blocking diagram (draggable top-down 2D)
  9. ✅ Continuity tracking + warnings across shots
  10. ✅ Prompt Studio UI (inspector, versions, per-provider tabs) + export package
  11. ✅ Audio tracks (roles, levels, fades, J/L cuts, previz playback)

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up the database

You need a PostgreSQL database. The easiest way is Docker Compose, which
ships with this repo:

```bash
docker compose up -d
```

That starts Postgres on `localhost:5432` with user `postgres`, password
`postgres`, database `filmmaker_studio` — matching the default in
`.env.example`. (No Docker? See "Other ways to get Postgres" below.)

Copy `.env.example` to `.env` and set an auth secret:

```bash
cp .env.example .env
```

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/filmmaker_studio?schema=public"
AUTH_SECRET="generate with: openssl rand -base64 32"
```

Then apply the schema:

```bash
npx prisma migrate dev
```

#### Other ways to get Postgres

- **Local install**: create a database named `filmmaker_studio` and point
  `DATABASE_URL` at it.
- **Hosted free tier** (Neon, Supabase, Railway, etc.): use the connection
  string they give you as `DATABASE_URL`.

### 3. (Optional) enable AI storyboard generation

Uploading and organizing your own images/diagrams/video works with no extra
setup. To also enable the "Generate with AI" button on storyboards and shot
references, add an OpenAI key to `.env`:

```
OPENAI_API_KEY="sk-..."
```

Without it, the button is still there but shows a message pointing back
here instead of erroring.

To use an OpenAI-compatible endpoint instead (Azure OpenAI, a gateway, a local
stub), set `OPENAI_BASE_URL` as well — it defaults to
`https://api.openai.com/v1`.

Uploaded and generated files go to local disk by default (`./storage/uploads`,
configurable via `STORAGE_DIR`) and to S3-compatible object storage as soon as
it is configured. See **"Storage"** below — local disk is a development
backend, not a deployment target.

### 3b. (Optional) enable AI video previsualization

No video provider is wired up — you haven't picked one yet. To exercise the
video and image-to-video pipeline locally with a clearly-labelled placeholder
clip:

```
VIDEO_PROVIDER="local-stub"
# VIDEO_STUB_DELAY_MS="1500"   # how long a stub job stays "processing"
```

The stub returns the same short clip stamped *"STUB CLIP — no provider"* for
every prompt and ignores the requested duration. It proves the pipeline, never
the generation. With `VIDEO_PROVIDER` unset the video buttons are disabled and
say so.

When you choose a real provider, write an adapter against
`VideoGenerationProvider` in `src/lib/ai/video-providers/` and register it —
the compiler, the `CinematicPromptSpec` and the Shot model do not change.

### 4. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign up, and create
your first production.

## Project structure

```
prisma/schema.prisma          Data model for all entities
src/auth.ts, src/auth.config.ts   NextAuth setup (split for edge middleware)
src/middleware.ts              Route protection
src/lib/actions/*              Server actions (mutations) per module
src/lib/validation.ts          Zod schemas shared by every form
src/lib/jobs/                  Durable generation jobs: state machine, queue, runner, worker
scripts/worker.ts              The worker process (npm run worker)
src/lib/media.ts               Media authorization boundary (the only way to reach a byte)
src/lib/storage/               Storage providers: interface, key policy, local disk, S3
src/lib/ai/openai-image.ts     OpenAI image HTTP call (server-only; reads the key)
src/lib/ai/image-providers/    Image provider registry + adapters (text → pixels)
src/lib/ai/video-providers/    Video provider registry + adapters (text → async job)
src/lib/prompt/                Prompt compiler: IR, renderers, prompt adapters
src/lib/shot-prompt.ts         DB ↔ compiler bridge (the only place a Shot becomes a prompt)
src/lib/actions/generations.ts Structured image generation: queue, run, persist
src/lib/actions/video-generations.ts  Video/image-to-video jobs: start, submit, poll
src/lib/timeline.ts            Edit timing: source vs used duration, layout, split (pure)
src/lib/continuity.ts          Continuity rules + timelines (pure, read-only)
src/lib/diff.ts                Deterministic LCS prompt comparison (no LLM)
src/lib/export/                Production export: package, CSV, PDF
src/app/projects/[projectId]/studio/  Prompt Studio (project and shot level)
src/lib/actions/continuity.ts  Continuity decisions — the only writes this layer makes
src/lib/actions/timeline.ts    Sequence/clip mutations — never writes a Shot field
src/app/api/assets/[id]/file/  Authenticated file-serving route
src/app/projects/[projectId]/  Project workspace: scenes, visualization,
                                schedule, cast-crew, locations, equipment,
                                budget
```

## Not production-ready yet

Deliberately out of scope so far, and each one is real work before this is
deployable:

| Area | State today | Needed for production |
|---|---|---|
| **Asset storage** | S3-compatible object storage, local disk in development | Configure `S3_*` and run `npm run storage:migrate` |
| **Image provider** | OpenAI gpt-image-1, implemented and tested; not yet run against the live API | A credential and network egress — see "Image generation" |
| **Video providers** | Google Veo 3.1 adapter, implemented and unit-tested; **never run against the live API** — see `docs/veo-api-contract.md` | A credential in a runtime that can reach Google, then one real generation |
| **Generation jobs** | Durable Postgres-backed queue + worker | Run `npm run worker` alongside the app (see below) |
| **Billing / quotas** | Hard ceilings, plus a per-attempt spend ledger attributed to the user who started each generation | Rates configured in `GENERATION_RATES`; a UI for the totals |
| **Export assets** | JSON, CSV, PDF, and a ZIP bundle carrying the media itself | ZIP64, for a bundle or single asset over 4 GiB |
| **Timeline transitions** | All six edit points: dissolves overlap and shorten the ruler, fades run through black, cuts are instant, J- and L-cuts move the sound | — |
| **Audio** | Audio assets, tracks with roles and levels, placements with trims and fades, J/L-cut offsets, playback in the previz player | Waveform display; a rendered mixdown |

J- and L-cuts are where those two rows meet. Both are straight cuts in the
picture; what moves is the sound, and how far it can move is decided by material
that actually exists. Revealing a clip's sound early means playing its source
from before its in point, so a clip trimmed hard against the head of its file has
nothing to reveal and the cut is refused with that said in words. What a J- or
L-cut must never quietly become is a dissolve, and keeping picture timing
(`src/lib/timeline.ts`) apart from sound timing (`src/lib/audio.ts`) is what
stops it.

Two things the sound layer deliberately does not do. It never invents a length:
an audio file the browser has not decoded has an unknown length, and its
placement is drawn as a marker rather than a bar of a plausible width. And a
level nobody stated stays distinguishable from 0 dB, even though the two sound
identical — the same omission-by-default rule the prompt compiler runs on.

The preview player cannot boost above unity, because `HTMLMediaElement.volume`
tops out at 1. A track set louder than unity is stored at that level, previewed
clamped, and flagged in the track header rather than silently playing quieter
than the mix asks for.

## Storage

Media lives behind a provider interface (`src/lib/storage/types.ts`). The
application only ever knows about *objects addressed by a storage key* — never
whether the bytes are on a disk, in S3, in R2 or anywhere else. Which backend is
used is a configuration choice, not a code change.

### Development: local disk

With no `S3_*` variables set, uploads and generated media are written under
`STORAGE_DIR` (default `./storage/uploads`). This exists so the application runs
with no cloud credentials and so the test suite exercises the same interface
production uses.

> **Local disk is not production infrastructure.** It does not survive a
> serverless deploy (Vercel and friends have no persistent filesystem), does not
> survive a container being replaced, cannot be shared between app instances,
> and has no redundancy, lifecycle policy or CDN. Generated **video** makes this
> sharper than it was for stills: clips are large, and losing them loses work
> that cost real provider credits.

### Production: S3-compatible object storage

Set these and the application stores new media in the bucket instead, with no
other change:

```
S3_BUCKET="filmmaker-studio"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
S3_REGION="auto"
S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com"   # omit for AWS S3
S3_FORCE_PATH_STYLE="true"                                  # MinIO and most S3-compatibles
```

Any S3-compatible store works — AWS S3, Cloudflare R2, Backblaze B2, MinIO,
Wasabi. The adapter is verified against an S3-protocol server by
`npm run verify:s3`; that proves the adapter speaks the protocol, **not** that
any particular vendor accepts it. Point `S3_ENDPOINT` at your real bucket and
re-run it before trusting a specific provider.

The bucket should be **private**. Nothing in the application depends on public
object URLs, and making the bucket public would move the access decision out of
the application, which is exactly what the next section is about.

### Migrating existing local files

```
npm run storage:migrate            # report: what would move, and where
npm run storage:migrate -- --apply # upload, verify by checksum, then repoint
```

An Asset row is only repointed after the uploaded object has been read back out
of the bucket and its SHA-256 matched. **Local files are never deleted** — the
script prints which have become redundant and leaves removing them (and taking a
backup first) to you. Re-running is safe.

### How access is decided

A storage key is **never** proof of anything. Every byte goes through
`src/lib/media.ts`, in this order and only this order:

    signed-in user
      → does this Asset exist
      → does its Project grant this user access
      → only now, a short-lived URL or a read of the object

`signedUrlForAsset`, `readAssetBytes` and `readAssetRange` take an
`AuthorizedAsset`, a type only `authorizeAsset` produces, so it is not possible
to serve an asset without having checked project access first. An asset id
belonging to someone else returns a 404 indistinguishable from one that does not
exist.

In development, a "signed URL" is a real HMAC over the key and an expiry
pointing at `/api/media`, so the interface behaves the same as it does in
production; in production it is a presigned S3 URL. Neither is the authorization
boundary — both are issued only after the check above, and their expiry limits
how long a leaked link stays useful, nothing more.

Run `npm run verify:storage` against a built app to exercise all of this over
real HTTP with two real users.

## Image generation

One real provider is implemented: **OpenAI `gpt-image-1`**, via the Images API
(`POST /v1/images/generations`). It is reached through the same
`ImageGenerationProvider` interface everything else uses, so replacing it means
writing one adapter file and changing one registry entry — no filmmaking data,
no compiler behaviour and no storage code moves.

```
OPENAI_API_KEY="sk-..."          # required; billed
OPENAI_BASE_URL="https://..."    # optional: Azure OpenAI, a gateway, a mock
IMAGE_PROVIDER="local-stub"      # optional: the deterministic local stub instead
```

With no key set, image generation is unavailable and the UI says so. It never
quietly falls back to the stub.

### What the adapter will and will not do

It sends the prompt **byte-for-byte** as the deterministic compiler produced it,
or as the filmmaker edited it. There is no LLM in this path, no "prompt
improvement" step and no vocabulary substitution: an 85mm lens stays 85mm, a Low
Angle stays a Low Angle, a Medium Close-Up stays a Medium Close-Up.

Where the provider genuinely cannot do something, the request **fails
explicitly** rather than being quietly adjusted:

| Requested | Response |
|---|---|
| a size outside 1024×1024, 1536×1024, 1024×1536 | refused, naming the supported sizes |
| a prompt over 32,000 characters | refused — truncating would silently drop the lighting and mood off the end |
| an empty prompt | refused |

### Validating what comes back

Nothing about the response is taken on trust. The status is checked, the body is
checked for being JSON at all, the payload is checked for containing image data,
and the decoded bytes are parsed as an image before anything is stored. An HTML
error page from a proxy or gateway cannot become a PNG in a storyboard.

Width and height are read **from the returned file**, never from what was asked
for. The Generation records the request; the Asset records what actually arrived.
If an adapter cannot determine dimensions, the Asset stores null rather than a
guess.

### Failure classification

| Provider says | Treated as |
|---|---|
| 401 / 403 — bad credentials | permanent; never retried |
| 400 / 404 / 422 — rejected prompt, unknown model, bad parameter | permanent |
| 429 — rate limited | retryable; the provider's `Retry-After` is preserved in the message |
| 5xx, timeout, connection failure | retryable |

**On rate limits, precisely:** the adapter reads and reports the provider's
`Retry-After` hint and the worker's bounded retries prevent a tight loop. There
is no client-side rate *limiter* — nothing paces requests ahead of time or
tracks a token budget. The concurrency ceiling below is what actually caps
parallel requests.

### Cost protection

This is the first thing here that spends money, so there are hard ceilings,
checked server-side before a job is queued:

| Limit | Default | Environment variable |
|---|---|---|
| per user, per window, across all their projects | 50 | `GENERATION_LIMIT_PER_USER` |
| per project, per window | 200 | `GENERATION_LIMIT_PER_PROJECT` |
| in flight at once, per project | 5 | `GENERATION_LIMIT_CONCURRENT` |
| images per request | 1 | `GENERATION_LIMIT_PER_REQUEST` |
| the rolling window | 24h | `GENERATION_LIMIT_WINDOW_HOURS` |

They count **attempts, not successes** — a failed generation was still billed —
and they ignore local stub generations, which cost nothing. Every limit has a
finite default and there is no "unlimited" setting. A nonsensical value falls
back to the default rather than disabling the limit.

This is deliberately not billing and not quota accounting; Workstream 11.7 owns
that. It is a blunt stop so nothing can run away before then.

### Real versus stub

The local stub renders a flat PNG derived from the prompt's hash. It exists to
exercise the pipeline and is **never** presented as AI generation: the adapter
declares `kind: "stub"`, and the UI badges it "Local stub · not AI-generated",
explains itself under a completed card, and warns before you press Generate. The
worker's log lines carry `providerKind` too, so a log alone distinguishes a paid
render from a placeholder.

### Verification status

The adapter is verified against a local server speaking the OpenAI Images
protocol (`npm run verify:image-provider`, 40 checks), plus 41 unit tests over
request construction, response validation and error classification.

**It has not been run against the live OpenAI API.** Status:
**REAL PROVIDER INTEGRATION IMPLEMENTED — EXTERNAL VERIFICATION PENDING.**

To close that gap, set `OPENAI_API_KEY`, allow outbound HTTPS to
`api.openai.com`, leave `OPENAI_BASE_URL` unset, and run:

```
npm run build && npm run verify:real-generation
```

That performs exactly **one** genuine, billed generation from Shot 12 and records
the evidence — provider, model, timestamps, generation id, asset id, MIME type,
measured dimensions, file size and checksum — then re-reads it from the database,
**loads Shot 12 over real HTTP in a signed-in session** to confirm the image is
still served, and checks a second user can reach none of it.

Its post-generation half is not first exercised on the real run: the same code is
shared with `npm run verify:image-provider`, which runs it against a local
protocol mock on every pass. The one paid call is therefore the only part that
has never been executed before.

### Deployment requirements for the one real run

| Requirement | Value |
|---|---|
| `OPENAI_API_KEY` | a real key with image-generation access, server-side only |
| `OPENAI_BASE_URL` | **unset** — the harness refuses any other host |
| `IMAGE_PROVIDER` | unset, or `openai-gpt-image-1` |
| `DATABASE_URL` | a PostgreSQL instance with migrations applied |
| `AUTH_SECRET` | any long random string |
| Egress | outbound HTTPS to `api.openai.com` must be permitted |
| Port | `VERIFY_PORT` (default 3122) free, for the browser-refresh check |
| Data | the "The Last Reel" project, Scene 4, Shot 12 present |
| Limits | `GENERATION_LIMIT_*` must permit one more generation |
| Build | `npm run build` first — the harness scans the bundle for the credential |

The run costs one `gpt-image-1` image and takes under a minute.

It **cannot be satisfied by a mock**: it aborts unless the adapter is pointed at
`api.openai.com`, so a pass cannot have come from anything else. It also refuses
to start without a credential, if the credential appears in any client bundle, if
the provider is unreachable (a proxy's 403 on CONNECT is reported as the egress
denial it is, not mistaken for the provider answering), or if the application's
own generation limits would refuse the request. Nothing is generated and nothing
is billed unless every precondition passes.

## Background generation

Generation does not run in the browser, and it does not run inside a request.
Clicking Generate writes a durable job; a separate worker process does the work.
Close the tab, lose the network, reboot the laptop — the generation finishes
anyway, because nothing about it was ever living in the page.

```
npm run dev       # the web application
npm run worker    # the generation worker — a separate process
```

Both are needed for a generation to complete. With no worker running, jobs simply
queue up and the UI says so; start one and they drain.

### The job

There is no separate job table. A `Generation` **is** the job, and it carries its
own lifecycle:

```
QUEUED ──claim──▶ PROCESSING ──▶ COMPLETED
   │                  │
   │                  ├──▶ AWAITING_PROVIDER ──poll──▶ PROCESSING
   │                  ├──▶ QUEUED            (retryable failure, or lease expired)
   │                  └──▶ FAILED ──retry──▶ QUEUED   (explicit, by a person)
   └──▶ CANCELLED     (only before anything reached a provider)
```

The legal transitions live in `src/lib/jobs/state.ts`, along with *who* may make
each one. Nothing a browser can do reaches COMPLETED: only a worker holding a
valid lease can finish a job.

### Why Postgres and not a queue broker

The requirements are durable, restart-safe and multi-worker-safe. A committed row
is durable; a lease that expires is restart-safe; a conditional `UPDATE` is
multi-worker-safe. Redis, BullMQ or SQS would add an operational dependency and a
second source of truth to buy nothing this application needs yet. If that changes,
`src/lib/jobs/queue.ts` is the interface to reimplement, and nothing above it
would move.

### Claiming, leases and crashes

A worker claims a job with a compare-and-swap on a lease token: it reads a
candidate row, then updates it conditional on the token it saw. Two workers
racing produce one winner and one no-op. Every later write the worker makes is
conditional on the same token, so a worker that was merely *slow* cannot
overwrite the result of the worker that took over from it.

A worker that dies holds nothing: its lease simply expires, and the next worker
picks the job up. There is no sweeper process and no liveness protocol — expiry
is the whole mechanism. A long-running job stays alive by heartbeating, which is
what distinguishes "slow" from "dead".

### Retries

Failures are classified, not counted blindly:

| Kind | Meaning | Retried? |
|---|---|---|
| `RETRYABLE` | a timeout, a rate limit, a storage blip | yes, with exponential backoff, up to `maxAttempts` |
| `PERMANENT` | a rejected prompt, an unsupported configuration, media we will not accept | no — it will fail identically |
| `INDETERMINATE` | see below | no — a retry might cost real money |

### The one window that cannot be closed

A worker can submit to a provider and die before recording the provider's job id.
Recovery depends on what the provider offers:

- **An idempotency key** (`supportsIdempotencyKey`) — resubmitting is safe, and
  the worker does exactly that.
- **A job lookup** (`findJobByIdempotencyKey`) — the worker finds the existing
  job and adopts it.
- **Neither** — the submission may or may not have happened, and there is no way
  to find out. The worker does **not** resubmit: the job is marked FAILED with
  `INDETERMINATE`, and a person decides after checking the provider. This is a
  real, unavoidable failure window, not a bug, and it is the reason an adapter
  must not claim idempotency support it does not have.

### Webhooks

Not implemented. No provider here requires them, and a webhook endpoint that
exists before something needs it is an unauthenticated hole with no test
coverage. Polling is scheduled rather than blocking — a submitted job releases
its worker and is re-claimed for a single poll later — so one worker can carry
many in-flight generations.

### Production topology

```
   Web application  ──┐
                      ├──▶  PostgreSQL  ◀──  Worker (1..n)
   Object storage  ◀──┘                          │
          ▲                                      │
          └──────────────────────────────────────┘
```

The worker needs the database, the storage configuration and the provider
configuration. It needs no browser, no inbound port and no session. Run one or
several; claiming is safe across processes and machines. Deploy it as a separate
service (a second Railway/Fly process, an ECS service, a systemd unit) with the
same environment as the web application.

Set `WORKER_ID` if you want stable names in the logs; one is derived from the
hostname and pid otherwise. `SIGTERM` stops it cleanly — it finishes the step in
flight and stops claiming. Killing it outright is also safe: the lease expires
and another worker continues.

## Deployment

Deploy anywhere that runs Next.js (Vercel, Railway, Fly.io, etc.) with a
PostgreSQL database attached. Set `DATABASE_URL` and `AUTH_SECRET` as
environment variables, then run `npx prisma migrate deploy` before starting
the app.

**Storage:** configure the `S3_*` variables (see "Storage" above) before
deploying. Without them the app falls back to local disk, which does not persist
on Vercel's serverless functions and cannot be shared between instances
anywhere. If you already have assets on local disk, run
`npm run storage:migrate -- --apply` once the bucket is configured.

**Run the worker too:** the web application alone will queue generations and
never finish them. See "Background generation" above.

**Auth behind a proxy:** a production build refuses an untrusted `Host` header.
Set `AUTH_URL` to the app's public URL, or `AUTH_TRUST_HOST=true` if you
terminate TLS in front of it. Without one of these, sign-in returns
"There was a problem with the server configuration".
