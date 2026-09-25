# syntax=docker/dockerfile:1

# Filmmaker Studio — two runtime images from one build.
#
# The app is two processes that must run the same code: the web server, and the
# worker that actually talks to paid providers. Building them from one source
# stage is what stops them drifting — a worker running yesterday's adapter
# against today's schema is a bug nobody would think to look for.
#
#   docker build --target web    -t filmmaker-web    .
#   docker build --target worker -t filmmaker-worker .
#
# Neither image contains a credential. Every secret is read from the environment
# at runtime; nothing is baked in, so the same image is safe to push to a
# registry and safe to roll back to.

# --- dependencies ------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

# Prisma's engines need OpenSSL, and the slim image does not ship it.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma

# `npm ci` for a reproducible install from the lockfile. `--legacy-peer-deps` is
# not optional here: the peer graph does not resolve without it, and an install
# that only works by accident is one that breaks on a clean machine.
RUN npm ci --legacy-peer-deps

# --- build -------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .

# Generated before the build, because the build imports the client's types.
RUN npx prisma generate

# `next build` reads the environment, and NextAuth refuses to start without
# knowing it may trust its host. These are build-time placeholders and reach no
# runtime image: the real values come from the environment when the container
# starts. A real AUTH_SECRET must never be baked into a layer.
ENV AUTH_SECRET=build-time-placeholder-not-used-at-runtime
ENV AUTH_TRUST_HOST=true
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- the web server ----------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Never root. A process that only has to read its own bundle and open a socket
# has no business being able to write to the image.
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app

# The standalone output carries the server and only the dependencies it uses;
# static assets and the public directory are not included in it and are copied
# alongside.
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public

USER app
EXPOSE 3000

# The same check a load balancer makes, so a container that cannot reach
# Postgres is visibly unhealthy rather than quietly serving errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# --- the worker --------------------------------------------------------------
# A separate target rather than a second command on the web image, because the
# worker runs TypeScript sources directly and needs node_modules — neither of
# which belongs in the image that faces the internet.
FROM node:22-slim AS worker
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/scripts ./scripts
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/tsconfig.json ./tsconfig.json

USER app

# No port and no health endpoint: the worker serves nothing. Whether it is
# doing its job is visible in the queue — a job that stays QUEUED is a worker
# that is not running, and that is the signal to watch.
CMD ["npm", "run", "worker"]
