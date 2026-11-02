# Docker images and a full compose stack: design

## Goal

`docker compose up --build` starts the whole app (Postgres with pgvector, the API, the web app) on a machine with
only Docker installed. It is also the artifact the public deployment guide (a later TODO item) builds on.

## Context

- The API (`apps/api`, NestJS, compiled to CommonJS with `tsc`) and the web app (`apps/web`, Next.js, `next start`)
  are npm workspaces of one repo with a single root `package-lock.json`.
- Both load config relative to their working directory: `../../.env` (dotenv) and, for demo seeding,
  `../../samples`. The images must keep the `/app/apps/api`, `/app/apps/web` and `/app/samples` layout.
- `NEXT_PUBLIC_API_URL` is inlined into the web bundle at build time (`next.config.mjs`).
- `docker-compose.yml` runs only Postgres and publishes its port on every interface with the password `rag`.
- The API migrates the schema itself at startup, so a fresh database needs no separate step.

## Scope

In: Dockerfiles for the API and the web app, a root `.dockerignore`, `api` and `web` services in
`docker-compose.yml`, binding all published ports to `127.0.0.1`, a CI step that builds the images, README and
`.env.example` notes, ticking the TODO item.

Out (the public deployment guide): HTTPS and a reverse proxy, a non-default database password, a spend cap,
publishing images to a registry, runtime-configurable `NEXT_PUBLIC_API_URL`.

## Decisions

1. **The API address is a build argument of the web image.** `NEXT_PUBLIC_API_URL` is passed as `build.args`,
   defaulting to `http://localhost:4000`. Changing it means `docker compose build web`. This adds no application
   code. The alternative (runtime config, one image for every address) changes the web app's request path and is
   not needed to run locally or on one host.
2. **One Dockerfile per app, built from the repo root** (`context: .`, `dockerfile: apps/<app>/Dockerfile`),
   because the lockfile and workspaces are at the root. The lockfile is not modified.
3. **Multi-stage, `node:22-slim`** (the Node version CI uses). A build stage runs `npm ci` and the build; the final
   stage holds production dependencies and the build output only, and runs as the non-root `node` user.
4. **API final stage:** `npm ci --omit=dev -w apps/api`, `apps/api/dist`, and `samples/`. Command
   `node dist/main.js`, working directory `/app/apps/api`.
5. **Web final stage:** `npm ci --omit=dev -w apps/web`, `apps/web/.next`, `apps/web/next.config.mjs` and
   `apps/web/package.json`. Command `next start -p 3000`, working directory `/app/apps/web`. No `standalone`
   output, so `next.config.mjs` is unchanged.
6. **`.dockerignore`** excludes `.env`, `.git`, `node_modules`, `dist`, `.next`, `coverage`, `.superpowers`, docs,
   and tests, so no secret enters an image or a layer and the build context stays small.
7. **Configuration comes from the root `.env` through `env_file`**, so one file configures dev and compose. The
   compose file overrides what only makes sense inside the network: `DATABASE_URL` points at the `db` service
   (`postgres://rag:rag@db:5432/rag`) and the API's `API_PORT` stays `4000` inside the container. `.env` is never
   copied into an image. If `.env` is missing, `env_file` is marked optional so a fresh clone still starts with
   the mock providers.
8. **Startup order and health.** `db` has its existing healthcheck. `api` waits for `db` to be healthy and has a
   healthcheck on `GET /health`. `web` waits for `api` to be healthy. All services restart `unless-stopped`.
9. **Ports bind to `127.0.0.1`**: `127.0.0.1:${DB_PORT:-5432}:5432`, `127.0.0.1:${API_PORT:-4000}:4000`,
   `127.0.0.1:3000:3000`. `npm run db:up` (`docker compose up -d db`) and the e2e tests that use the published
   database port keep working, because they connect from the host.
10. **CORS.** `CORS_ORIGIN` already defaults to `http://localhost:3000`, which matches the published web port.

## Verification

Run on this machine, with output read, before the work is called done:

- `docker compose config` is valid.
- `docker compose up --build -d` brings all three services to healthy.
- `GET /health` on the API reports `ok`; the web page returns 200 and contains the app shell.
- With the mock providers, seeding the samples and asking a question returns an answer with citations.
- With `DEMO_MODE=true` in `.env`, the samples are indexed at startup and `POST /documents` returns 403.
- The images contain no `.env`, no dev dependencies (`ts-node`, `jest`) and run as a non-root user.
- `docker compose down` leaves the `rag-data` volume; `npm run db:up` and `npm test` still pass.
- CI gains a `docker compose build` step so a broken Dockerfile fails a pull request.

## Risks

- `npm ci -w <app> --omit=dev` in a final stage must resolve the hoisted root `node_modules` correctly; the check is
  that the container starts and answers a question, not that the build succeeds.
- Next.js 16 `next start` needs the build output and `next` at runtime; if it needs more than listed, the web
  container fails its first request and the verification above catches it.
- Rebuilding the web image on every change to the API address is a known cost of decision 1.

## Documentation

README: a "Run everything with Docker" section (command, localhost-only ports, the rebuild when
`NEXT_PUBLIC_API_URL` changes, a pointer to the deployment guide). `.env.example`: a note on
`NEXT_PUBLIC_API_URL` being a build-time value. TODO: tick "Dockerfiles and a full compose stack" and narrow the
deployment-guide item (the database is now bound to localhost).
