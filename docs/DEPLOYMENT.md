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

That shape is why a pure serverless host does not fit: the worker is a
long-running process that must be able to poll a provider for minutes. Anywhere
that can run two containers will do.

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
