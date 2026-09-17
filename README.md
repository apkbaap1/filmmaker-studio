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
- **Visualization** — a dedicated space to previsualize the film:
  - Project-wide mood board for concept art, tone references, diagrams.
  - Per-scene **storyboard** gallery (upload frames or generate them with AI).
  - Per-shot **camera angle**, **lighting notes**, and **sound design notes**,
    plus a collapsible reference-image gallery on every shot.
  - **AI image generation** (OpenAI `gpt-image-1`) for storyboard frames from
    a text prompt — optional, see "AI image generation" below.
  - Video generation isn't wired up yet (no provider chosen) — you can
    still upload your own video reference clips. Ask to have this added
    once you've picked a provider (Runway, Luma, etc.).

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

Uploaded and generated files are saved to `./storage/uploads` on disk by
default (configurable via `STORAGE_DIR`). This works great for self-hosting
but **not** on Vercel, which has no persistent filesystem — see
"Deployment" below if you're targeting Vercel.

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
src/lib/ai/openai-image.ts     AI storyboard image generation (OpenAI)
src/app/api/assets/[id]/file/  Authenticated file-serving route
src/app/projects/[projectId]/  Project workspace: scenes, visualization,
                                schedule, cast-crew, locations, equipment,
                                budget
```

## Deployment

Deploy anywhere that runs Next.js (Vercel, Railway, Fly.io, etc.) with a
PostgreSQL database attached. Set `DATABASE_URL` and `AUTH_SECRET` as
environment variables, then run `npx prisma migrate deploy` before starting
the app.

**Vercel note:** the Visualization feature stores uploaded/generated files
on local disk (`src/lib/storage.ts`), which doesn't persist on Vercel's
serverless functions. Deploying there works for every other feature, but
uploads would be lost between requests. Use a host with a persistent disk
(Railway, Fly.io, a VPS) for Visualization to work, or ask to have the
storage module swapped for an S3-compatible provider first.
