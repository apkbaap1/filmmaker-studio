# Deploying Filmmaker Studio

What this needs, what it does not have, and the decisions nobody can make for
you.

---

## What the app actually is

Three processes, not one:

| | | |
|---|---|---|
| **PostgreSQL** | the production data | every scene, shot, generation and ledger row |
| **web** | Next.js server | serves pages, queues generations, never calls a provider |
| **worker** | `npm run worker` | claims queued jobs and calls the paid providers |

**The worker is not optional.** Without it a generation is queued and stays
queued, which looks like the app being broken and is the app waiting. It is also
the only process that needs a provider credential — the web container is
deliberately not given one, so a compromise there reaches no billable account.

Anywhere that can run two containers will do, and that is the shape to prefer.
A serverless host cannot run the third process at all — there the queue is
worked by a scheduler instead, which is a real but lesser arrangement. See
[Vercel](#vercel) below.

---

## The quickest honest deployment

One machine with Docker:

```bash
cp .env.example .env
# Set at minimum: POSTGRES_PASSWORD, AUTH_SECRET
docker compose up --build
```

`docker-compose.yml` brings up Postgres, runs `prisma migrate deploy`, then
starts the web server and the worker. The app is on `http://localhost:3000`.

This is a real deployment and it is **not** a highly-available one: one Postgres,
one volume, no backups configured. Read the rest of this page before pointing a
domain at it.

---

## Vercel

Vercel runs the web half of this application well and cannot run the worker at
all. Every invocation there is bounded and then killed, so nothing can sit and
poll a provider for minutes. Four things follow, and none of them are optional.

### 1. The worker becomes a scheduled endpoint

`vercel.json` schedules `/api/cron/worker`. Each invocation claims what it can
and stops cleanly before the platform's timeout.

It claims through the same compare-and-swap lease as `npm run worker`, so two
overlapping invocations cannot take the same job and one killed mid-step loses
its lease by expiry and is picked up again. That is not new concurrency; it is
the queue built in 11.3, driven by a different clock.

**Set `CRON_SECRET`.** Without it the endpoint refuses every request, including
the scheduler's. It fails closed on purpose: the alternative is a public URL
that claims jobs and calls billed providers.

```
CRON_SECRET=$(openssl rand -base64 32)
```

Vercel sends this as `Authorization: Bearer <CRON_SECRET>` automatically.

**What you give up:** jobs advance in bursts at the schedule's cadence rather
than continuously, so a generation finishes up to one interval later than it
otherwise would. An image generation that takes 20 seconds of provider time can
take a minute of wall clock. A video generation polls once per interval instead
of continuously.

**Check two things against your own plan**, because they differ by plan and this
file will not tell you numbers it cannot verify:

- **How often your plan will run a cron job.** The schedule in `vercel.json` is
  every minute. If your plan will not run it that often, the cadence penalty
  above grows to whatever your plan does allow — on a daily-only plan this
  application does not work.
- **The function timeout ceiling.** `maxDuration` in `vercel.json` must be
  something your plan permits, and `CRON_WORKER_DEADLINE_MS` (default 50000)
  must stay comfortably below it. The worker has to be what stops the run: if
  the platform kills it first, it dies holding a lease and that job stalls until
  the lease expires.

An invocation that finds an empty queue returns in milliseconds rather than
waiting out its budget, so an idle deployment costs two queries a minute, not a
minute of compute a minute. If `hitDeadline` is persistently true in the cron
log, the schedule is not keeping up with the work.

### 2. Object storage is required, not recommended

Vercel's filesystem is ephemeral. The local-disk storage backend would accept
every upload and lose it, which is worse than refusing — so when `VERCEL` is set
in the environment (Vercel sets it for you) and no `S3_*` configuration is
present, the first operation that touches storage **throws** instead of falling
back to local disk.

That means an unconfigured deployment builds and serves pages normally and then
fails the first upload or generation, loudly, with a message naming the
variables it wants. It does not fail at boot, so do not read a successful deploy
as evidence that storage is configured.

Any S3-compatible store works (Cloudflare R2, AWS S3, Backblaze B2, Wasabi).
The bucket must be **private**: this application never depends on a public
object URL and decides access itself.

### 3. Postgres needs a pooled connection string

Serverless functions scale by count, and each one opens its own connection.
A direct Postgres connection string will exhaust `max_connections` under load in
a way that looks like random 500s. Use the pooled endpoint your provider offers
(Neon's pooler, Supabase's transaction pooler, PgBouncer) as `DATABASE_URL`.

Migrations are the exception — `prisma migrate deploy` needs a **direct**
connection, not a pooled one. Run it from your own machine or a build step
against the direct URL, not against the pooler.

### 4. Upload size

Two different ceilings apply to two different paths, and only one of them is
about your users:

- **Browser uploads** go through server actions, capped at `50mb` by
  `bodySizeLimit` in `next.config.ts`. A serverless platform imposes its own
  request body limit on top of that, and whichever is smaller wins. Check
  yours; if it is below 50mb, that is the real limit and a larger upload fails
  as a platform error rather than as the app's own message.
- **Provider media** is downloaded by the worker, capped at 500MB for video
  (`MAX_BYTES` in `src/lib/storage/keys.ts`). On Vercel that download happens
  inside the cron function, in memory. The function needs enough memory for the
  largest clip your video provider returns, or the generation fails at the last
  step — after you have paid for it.

### What it costs to run this way

The honest summary: the app works on Vercel, generation is slower and less
continuous than it is with a real worker, and the failure modes are quieter.
If you can run a container anywhere — Fly, Railway, Render, a VPS with the
`docker-compose.yml` above — run `npm run worker` instead and skip this entire
section.

---

## Secrets

### `AUTH_SECRET` — required, and generate it properly

```bash
openssl rand -base64 32
```

It signs session cookies. Changing it signs everyone out; leaking it lets
somebody forge a session for any account. It is never baked into an image: the
`Dockerfile` sets a build-time placeholder because `next build` refuses to start
without one, and the real value arrives from the environment at runtime.

### `AUTH_URL` — required behind a proxy

Behind anything that terminates TLS, set it to the public origin:

```
AUTH_URL="https://studio.example.com"
```

Without it NextAuth builds callback URLs from what the proxy forwarded, which is
how sign-in ends up redirecting to `http://` or to an internal hostname.
`AUTH_TRUST_HOST=true` is enough only when nothing sits in front.

### Provider credentials — worker only

`OPENAI_API_KEY`, `GOOGLE_API_KEY` and the model variables go to the worker and
nowhere else. Every one of them is billed.

Before setting any of them, set the ceilings. `GENERATION_LIMIT_*` are always on
and have finite defaults; `GENERATION_SPEND_*` are opt-in and off until
configured. See README > Cost protection. An unbounded generation endpoint with
a live credential behind it is the single most expensive mistake available here.

---

## Storage: the decision that outlives the machine

Media — every generated frame and clip — goes to one of two places.

**Local disk** (unset `S3_*`) writes into the container's `/app/storage`, kept in
a Docker volume. Fine for one machine. Wrong for more than one: a second web
container cannot serve a file the first one wrote, and the volume is the one
thing a `docker compose down -v` destroys.

**S3-compatible object storage** (set `S3_BUCKET`, `S3_REGION`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_ENDPOINT` for a non-AWS
provider) is what to use for anything that has to survive the machine. The
bucket must be **private**: media is served through `/api/assets/{id}/file`,
which checks project access first, and a public bucket would make that check
decorative.

Already have local media and want to move it? `npm run storage:migrate` copies
it and verifies checksums.

---

## Migrations

```bash
npx prisma migrate deploy
```

`deploy`, never `dev`. It applies the migrations that exist and fails if the
schema has drifted, rather than inventing one — a deployment is the wrong moment
to discover a migration was never written. CI runs `prisma migrate diff` on
every push for the same reason.

The `migrate` service in `docker-compose.yml` runs once before web and worker
start, and both wait for it to succeed.

---

## Health

`GET /api/health` is public, runs `SELECT 1`, and returns 200 with a duration or
503 with the word `unhealthy` and nothing else. A load balancer has no session,
so it cannot be behind auth; an unauthenticated endpoint that described its
failure would be describing your infrastructure to whoever asked. The real
reason is in the logs.

Point the load balancer's readiness check at it. The worker has no equivalent and
needs none — whether it is working is visible in the queue, and a job that stays
`QUEUED` is a worker that is not running.

---

## Scaling, and where it stops

**Web** scales horizontally once storage is S3: the containers share nothing but
the database.

**Worker** scales horizontally as-is. Claiming is a compare-and-swap on a lease
token, so two workers cannot take the same job — that was built in 11.3 and is
tested against a real database.

**Postgres** does not scale by adding containers. Use a managed instance for
anything real, which also gets you the backups this compose file does not have.

---

## What is missing, and what it costs you

**No mailer.** Nothing sends email. Two consequences:

- An invitation produces a link the owner copies and sends by hand. The flow
  works; it just is not automatic.
- **There is no password reset.** Somebody who forgets their password cannot
  recover the account without an operator editing `passwordHash` directly. This
  is the most likely thing to bite a real user, and it is not a small gap.

**No ownership transfer.** `Project.ownerId` can only be changed in the database.

**No live provider verification.** Every adapter is implemented and tested
against a local server speaking the provider's protocol. **None has ever made a
real call.** The first generation on a live credential is the first time any of
this code talks to a paid API — expect to debug it, and start with the smallest
model and the lowest ceilings you are willing to pay for.

**No rate limiting on sign-in.** Credentials auth does a constant-time bcrypt
comparison, so it does not leak which accounts exist, but nothing paces
attempts. Put the app behind something that does before exposing it publicly.

---

## A pre-flight checklist

- [ ] `AUTH_SECRET` generated with `openssl rand -base64 32`, not typed
- [ ] `AUTH_URL` set to the public origin, if anything terminates TLS
- [ ] `DATABASE_URL` pointing at managed Postgres, with backups on
- [ ] `S3_*` set and the bucket **private**
- [ ] `GENERATION_LIMIT_*` reviewed, `GENERATION_SPEND_*` set
- [ ] `GENERATION_RATES` set, or spend will report as unpriced
- [ ] Provider credentials on the **worker only**
- [ ] `prisma migrate deploy` run, and `migrate diff` clean
- [ ] `/api/health` returning 200 and wired to the load balancer
- [ ] Worker running, and a test generation moving off `QUEUED`
- [ ] Something rate-limiting sign-in
- [ ] You know there is no password reset

On Vercel, additionally:

- [ ] `CRON_SECRET` set — without it the scheduled worker refuses everything
- [ ] `/api/cron/worker` answering 401 without a token and 200 with it
- [ ] The cron job actually firing at the cadence your plan allows
- [ ] `CRON_WORKER_DEADLINE_MS` below the function's `maxDuration`
- [ ] `DATABASE_URL` pointing at a **pooled** endpoint, migrations run direct
- [ ] Function memory above the largest clip your video provider returns
