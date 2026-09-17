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

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up the database

You need a PostgreSQL database. Copy `.env.example` to `.env` and fill in
your connection string and an auth secret:

```bash
cp .env.example .env
```

```
DATABASE_URL="postgresql://user:password@localhost:5432/filmmaker_studio?schema=public"
AUTH_SECRET="generate with: openssl rand -base64 32"
```

Then apply the schema:

```bash
npx prisma migrate dev
```

### 3. Run the app

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
src/app/projects/[projectId]/  Project workspace: scenes, schedule,
                                cast-crew, locations, equipment, budget
```

## Deployment

Deploy anywhere that runs Next.js (Vercel, Railway, Fly.io, etc.) with a
PostgreSQL database attached. Set `DATABASE_URL` and `AUTH_SECRET` as
environment variables, then run `npx prisma migrate deploy` before starting
the app.
