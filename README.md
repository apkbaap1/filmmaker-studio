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

  Previsualization roadmap:
  1. ✅ Scene & Shot Builder (structured data model)
  2. ✅ Storyboard view: chronological panel grid, drag-drop reorder
  3. ✅ Prompt Compiler Engine (IR + renderers + provider adapters)
  4. ✅ Visual composition canvas + overlays (rule of thirds, eyeline, etc.)
  5. ✅ AI image generation driven by the compiler
  6. ✅ AI video previsualization + video provider adapters
  7. ✅ Timeline/edit view (shot clips, transitions, running duration)
  8. ✅ Camera blocking diagram (draggable top-down 2D)
  9. ✅ Continuity tracking + warnings across shots
  10. Prompt Studio UI (inspector, versions, per-provider tabs) + export package

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

Uploaded and generated files are saved to `./storage/uploads` on disk by
default (configurable via `STORAGE_DIR`). See
**"Storage: development-stage"** below before deploying anything.

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
src/lib/storage.ts             Local-disk file storage for uploaded/generated assets
src/lib/ai/openai-image.ts     OpenAI image HTTP call (server-only; reads the key)
src/lib/ai/image-providers/    Image provider registry + adapters (text → pixels)
src/lib/ai/video-providers/    Video provider registry + adapters (text → async job)
src/lib/prompt/                Prompt compiler: IR, renderers, prompt adapters
src/lib/shot-prompt.ts         DB ↔ compiler bridge (the only place a Shot becomes a prompt)
src/lib/actions/generations.ts Structured image generation: queue, run, persist
src/lib/actions/video-generations.ts  Video/image-to-video jobs: start, submit, poll
src/lib/timeline.ts            Edit timing: source vs used duration, layout, split (pure)
src/lib/continuity.ts          Continuity rules + timelines (pure, read-only)
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
| **Asset storage** | Local disk (see below) | S3-compatible object storage with signed URLs |
| **Video providers** | Adapter interface + labelled local stub | A real adapter once a platform is chosen |
| **Generation jobs** | Driven by an open browser tab | A server-side worker/queue so jobs finish unattended |
| **Prompt Studio** | Prompts shown and editable per shot | Inspector, versioning, per-provider tabs, export |
| **Billing / quotas** | None | Provider spend tracking and limits |
| **Timeline transitions** | Type and length stored as edit metadata | Overlapping dissolves that actually shorten the ruler |
| **Audio** | Shot-level dialogue/SFX/music text fields | Real audio tracks, waveforms, J/L-cut offsets |

The timeline's data model is shaped so the last two are additive: `Sequence` and
`TimelineClip` are proper entities, so markers, beat markers and audio tracks
attach as new related tables rather than a rewrite.

## Storage: development-stage

> **This is not production infrastructure yet, and must not be deployed as-is.**

`src/lib/storage.ts` writes uploaded and generated files to the local
filesystem. That is fine for `npm run dev` and for a single self-hosted box
with a persistent disk. It is **not** a production design:

- it does not survive a serverless deploy (Vercel and friends have no
  persistent filesystem, so uploads vanish between requests);
- it does not survive a container being replaced or rescheduled;
- it cannot be shared by more than one app instance, so it blocks horizontal
  scaling;
- it has no redundancy, no lifecycle policy and no CDN in front of it.

Generated **video** makes this sharper than it was for stills: clips are large,
and losing them loses work that cost real provider credits.

**Before any production deployment**, replace it with an S3-compatible object
store (S3, R2, GCS, B2…) using signed URLs. The swap is deliberately contained:
`saveUploadedFile` / `saveGeneratedImage` / `saveGeneratedVideo` /
`readStoredFile` / `deleteStoredFile` are the entire surface area, plus the
file-serving route at `src/app/api/assets/[assetId]/file/`.

## Deployment

Deploy anywhere that runs Next.js (Vercel, Railway, Fly.io, etc.) with a
PostgreSQL database attached. Set `DATABASE_URL` and `AUTH_SECRET` as
environment variables, then run `npx prisma migrate deploy` before starting
the app.

**Storage first:** see "Storage: development-stage" above. Local-disk storage
does not persist on Vercel's serverless functions and cannot be shared between
instances anywhere. Use a host with a persistent disk (Railway, Fly.io, a VPS)
for Visualization to work at all, and swap in object storage before this is
anything but a development deployment.
