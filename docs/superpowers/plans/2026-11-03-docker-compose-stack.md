# Docker Images and Compose Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker compose up --build` starts Postgres/pgvector, the API and the web app on a machine with only Docker installed.

**Architecture:** One multi-stage Dockerfile per app, built from the repo root so the root `package-lock.json` and npm workspaces work unchanged. The final images keep the `/app/apps/<app>` layout the apps' relative paths (`../../.env`, `../../samples`) expect. `docker-compose.yml` adds `api` and `web` services that read the root `.env`, override only `DATABASE_URL` and the in-container API port, wait on health, and publish on `127.0.0.1` only. `NEXT_PUBLIC_API_URL` is a build argument of the web image.

**Tech Stack:** Docker 29 / Compose v5, `node:22-slim`, npm workspaces, NestJS 12 (compiled with `tsc`), Next.js 16 (`next start`).

**Spec:** `docs/superpowers/specs/2026-11-03-docker-compose-stack-design.md`

## Global Constraints

- Node image: `node:22-slim` (the version CI uses). Final images run as the non-root `node` user.
- `package-lock.json` is not modified. Images install with `npm ci`; never `npm install`.
- Final images contain no `.env`, no dev dependencies (`ts-node`, `jest`, `typescript`), and keep the layout `/app/apps/api`, `/app/apps/web`, `/app/samples`.
- Published ports bind to `127.0.0.1` only: `${DB_PORT:-5432}:5432`, `${API_PORT:-4000}:4000`, `3000:3000`.
- The web image's API address is the build argument `NEXT_PUBLIC_API_URL`, default `http://localhost:4000`.
- Do not pipe a gating command (`docker build ... | tail`) without `set -o pipefail`; read the exit code.
- Out of scope: HTTPS or a reverse proxy, a non-default database password, a spend cap, publishing images, runtime-configurable API address.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

Failing or unusual conditions a person running this will meet, each pinned by a step below:

1. No `.env` file (a fresh clone): the stack must still start with the mock providers (Task 3, Step 5).
2. A `.env` written for local development (`DATABASE_URL=...@localhost:5433/...`): the containerised API must still reach the `db` service (Task 3, Step 4).
3. `API_PORT` other than 4000 in `.env`: the published host port follows it while the container keeps listening on 4000 (Task 3, Step 6).
4. Changing `NEXT_PUBLIC_API_URL`: only a rebuild of the web image takes effect, and it must actually reach the bundle (Task 2, Step 6).
5. `docker compose down` then `up`: documents survive in the `rag-data` volume (Task 3, Step 7).
6. A secret in `.env` must never end up inside an image (Task 1, Step 5; Task 2, Step 5).

---

### Task 1: Build context filter and the API image

**Files:**
- Create: `.dockerignore`
- Create: `apps/api/Dockerfile`

**Interfaces:**
- Consumes: root `package.json` and `package-lock.json`, `apps/api/package.json`, `apps/web/package.json` (npm needs every workspace manifest to validate the lockfile), `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/src/`, `samples/`.
- Produces: an image whose command is `node dist/main.js` in `/app/apps/api`, listening on `API_PORT` (default 4000). Tag used by later steps: `rag-api:test`. Task 3 builds it through compose instead.

- [ ] **Step 1: Write the build context filter**

Create `.dockerignore`:

```
.git
.github
.superpowers
docs
**/node_modules
**/dist
**/.next
**/coverage
**/*.log
**/.DS_Store
.env
.env.*
!.env.example
apps/api/test
apps/api/eval
apps/web/test
```

- [ ] **Step 2: Write the failing check**

Run: `docker build -f apps/api/Dockerfile -t rag-api:test .`
Expected: FAIL with "failed to read dockerfile" (the Dockerfile does not exist yet).

- [ ] **Step 3: Write the API Dockerfile**

Create `apps/api/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/api/Dockerfile .

FROM node:22-slim AS build
WORKDIR /app
# npm validates the lockfile against every workspace, so both manifests are needed even for one app.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN npm run build -w apps/api

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --omit=dev && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production
# The API resolves ../../.env and ../../samples from its working directory, so keep the repository layout.
COPY --from=deps /app /app
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY samples /app/samples
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
```

- [ ] **Step 4: Build it and read the exit code**

Run: `set -o pipefail; docker build -f apps/api/Dockerfile -t rag-api:test . 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"`
Expected: `exit=0` and the last lines show the image was written. If `npm ci -w apps/api --omit=dev` fails or leaves `node_modules` missing, record the error and rule: the spec's risk list names this step.

- [ ] **Step 5: Verify the image's contents**

Run, one per line, and read each output:

```bash
docker run --rm --entrypoint sh rag-api:test -c 'id -un; ls /app/apps/api/dist/main.js /app/samples; ls /app/.env 2>&1; ls /app/node_modules/.bin 2>/dev/null | grep -E "^(ts-node|jest|tsc)$" || echo "no dev tools"; node -e "require(\"pg\"); console.log(\"pg resolves\")"'
```

Expected: `node` (non-root), both paths listed, `ls /app/.env` reports "No such file", `no dev tools`, `pg resolves`.

Then plant a sentinel to prove `.env` stays out of the image:

```bash
echo "SENTINEL_SECRET=do-not-ship" >> .env && docker build -f apps/api/Dockerfile -t rag-api:test . >/dev/null && docker run --rm --entrypoint sh rag-api:test -c 'grep -rl SENTINEL_SECRET /app 2>/dev/null | head -3; echo scan-done'
```

Expected: only `scan-done` (no file path). Then remove the sentinel line: `sed -i.bak '/^SENTINEL_SECRET=/d' .env && rm -f .env.bak` and confirm `grep -c SENTINEL .env` prints `0`.

- [ ] **Step 6: Verify it starts and fails clearly without a database**

Run: `docker run --rm -e DATABASE_URL=postgres://rag:rag@127.0.0.1:1/rag rag-api:test 2>&1 | head -8`
Expected: Nest starts and reports a database connection error (ECONNREFUSED), not a module-not-found or path error. That proves dependencies and paths resolve.

- [ ] **Step 7: Commit**

```bash
git add .dockerignore apps/api/Dockerfile
git commit -m "$(cat <<'EOF'
Add an API image and a build context filter

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The web image

**Files:**
- Create: `apps/web/Dockerfile`

**Interfaces:**
- Consumes: `.dockerignore` from Task 1; `apps/web/` sources; build arg `NEXT_PUBLIC_API_URL`.
- Produces: an image whose command is `next start -p 3000` in `/app/apps/web`. Tag used by later steps: `rag-web:test`.

- [ ] **Step 1: Write the failing check**

Run: `docker build -f apps/web/Dockerfile -t rag-web:test .`
Expected: FAIL with "failed to read dockerfile".

- [ ] **Step 2: Write the web Dockerfile**

Create `apps/web/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/web/Dockerfile .

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web
COPY apps/web apps/web
# Next.js inlines NEXT_PUBLIC_* into the browser bundle at build time, so the API address is fixed per image.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --omit=dev && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app /app
COPY --from=build /app/apps/web/.next /app/apps/web/.next
COPY apps/web/next.config.mjs /app/apps/web/next.config.mjs
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "-p", "3000"]
```

- [ ] **Step 3: Build it and read the exit code**

Run: `set -o pipefail; docker build -f apps/web/Dockerfile -t rag-web:test . 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"`
Expected: `exit=0`. If `next build` complains about a missing `next-env.d.ts` or a type error, record it; `next build` regenerates `next-env.d.ts`.

- [ ] **Step 4: Verify it serves a page**

```bash
docker run -d --rm --name web-check -p 127.0.0.1:3999:3000 rag-web:test
sleep 6
curl -s -o /dev/null -w "status=%{http_code}\n" http://127.0.0.1:3999/
curl -s http://127.0.0.1:3999/ | grep -c "RAG"
docker logs web-check 2>&1 | tail -5
docker rm -f web-check
```

Expected: `status=200`, a non-zero count, and no stack trace in the logs. (If the page title has no "RAG", match another string from `apps/web/app/layout.tsx`.)

- [ ] **Step 5: Verify contents and that no secret is inside**

```bash
docker run --rm --entrypoint sh rag-web:test -c 'id -un; ls /app/.env 2>&1; ls /app/node_modules/.bin | grep -E "^(tsc|ts-node)$" || echo "no dev tools"'
```

Expected: `node`, "No such file", `no dev tools`. Repeat the sentinel check from Task 1, Step 5 against `rag-web:test` (`grep -rl SENTINEL_SECRET /app`), then remove the sentinel; expected: no file path printed.

- [ ] **Step 6: Verify the build argument reaches the bundle**

```bash
set -o pipefail
docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.test -t rag-web:url . >/dev/null; echo "exit=$?"
docker run --rm --entrypoint sh rag-web:url -c 'grep -rl "https://api.example.test" /app/apps/web/.next/static | head -2'
docker run --rm --entrypoint sh rag-web:test -c 'grep -rl "https://api.example.test" /app/apps/web/.next/static | head -2; echo default-scan-done'
```

Expected: `exit=0`; the first scan lists at least one file; the second prints only `default-scan-done`. Then `docker rmi rag-web:url`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/Dockerfile
git commit -m "$(cat <<'EOF'
Add a web image with the API address as a build argument

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Compose services and the full-stack check

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: both Dockerfiles; root `.env` (optional); `GET /health` on the API.
- Produces: services `db`, `api`, `web`; host ports on `127.0.0.1`; the volume `rag-data` unchanged.

- [ ] **Step 1: Write the failing check**

Run: `docker compose config --services`
Expected: prints only `db` (no `api` or `web` yet). That is the gap this task closes.

- [ ] **Step 2: Replace `docker-compose.yml`**

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: rag
      POSTGRES_PASSWORD: rag
      POSTGRES_DB: rag
    # Published on this machine only. A public deployment must not expose the database at all.
    ports:
      - "127.0.0.1:${DB_PORT:-5432}:5432"
    volumes:
      - rag-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rag -d rag"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    # The same .env as local development; a fresh clone without one runs on the mock providers.
    env_file:
      - path: .env
        required: false
    environment:
      # Only what differs inside the compose network. Values here win over env_file.
      DATABASE_URL: postgres://rag:rag@db:5432/rag
      API_PORT: "4000"
    ports:
      - "127.0.0.1:${API_PORT:-4000}:4000"
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    restart: unless-stopped

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args:
        # Inlined into the browser bundle: changing it needs `docker compose build web`.
        NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL:-http://localhost:4000}
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 15s
    restart: unless-stopped

volumes:
  rag-data:
```

- [ ] **Step 3: Validate the file**

Run: `docker compose config --services && docker compose config -q; echo "exit=$?"`
Expected: `db`, `api`, `web` (any order) and `exit=0`.

- [ ] **Step 4: Bring the stack up with a development `.env` (Review Focus 2)**

The repository `.env` points `DATABASE_URL` at `localhost`. Leave it as is.

```bash
docker compose up --build -d --wait 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"
docker compose ps
curl -s http://127.0.0.1:${API_PORT:-4000}/health
```

Expected: `exit=0`, all three services `healthy`, and `/health` returns JSON with `"status":"ok"`. The API reaching the database proves the compose `DATABASE_URL` override beat the `.env` value.

- [ ] **Step 5: Check the web page, a question, and the no-`.env` case (Review Focus 1)**

```bash
curl -s -o /dev/null -w "web=%{http_code}\n" http://127.0.0.1:3000/
curl -s -X POST http://127.0.0.1:4000/documents -H 'content-type: application/json' \
  -d '{"title":"Compose check","content":"The compose stack was verified on a clean machine."}'
curl -s -X POST http://127.0.0.1:4000/query -H 'content-type: application/json' \
  -d '{"question":"Where was the compose stack verified?"}' | head -c 600
```

Expected: `web=200`, a created document, and an answer object with a non-empty `sources` list (mock providers, so the answer echoes context).

Then test a missing `.env`: `docker compose down`, `mv .env .env.keep`, `docker compose up -d --wait`, `curl -s http://127.0.0.1:4000/health` (expect `"status":"ok"` and mock providers in the JSON), then `docker compose down`, `mv .env.keep .env`. Expected: starts fine with no `.env`. Restore `.env` even if a command fails.

- [ ] **Step 6: Port override follows `API_PORT` (Review Focus 3)**

```bash
docker compose down
API_PORT=4100 docker compose up -d --wait
curl -s -o /dev/null -w "host4100=%{http_code}\n" http://127.0.0.1:4100/health
docker compose ps api --format '{{.Ports}}'
docker compose down
```

Expected: `host4100=200` and the port mapping shows `127.0.0.1:4100->4000/tcp`. (The shell variable feeds compose's port interpolation; `.env` containing `API_PORT` behaves the same.)

- [ ] **Step 7: Data survives `down` and `up` (Review Focus 5), and demo mode works in the stack**

```bash
docker compose up -d --wait
curl -s http://127.0.0.1:4000/documents | head -c 300
docker compose down
docker compose up -d --wait
curl -s http://127.0.0.1:4000/documents | grep -c "Compose check"
```

Expected: after the second `up`, the count is at least `1` (the volume kept the document).

Demo mode through a throwaway override file (not committed):

```bash
printf 'services:\n  api:\n    environment:\n      DEMO_MODE: "true"\n' > "$SCRATCHPAD/demo.override.yml"
docker compose -f docker-compose.yml -f "$SCRATCHPAD/demo.override.yml" up -d --wait
curl -s http://127.0.0.1:4000/health | grep -o '"demo":true'
curl -s -o /dev/null -w "write=%{http_code}\n" -X POST http://127.0.0.1:4000/documents -H 'content-type: application/json' -d '{"title":"x","content":"y"}'
curl -s http://127.0.0.1:4000/documents | grep -c "acme"
docker compose down
```

Expected: `"demo":true`, `write=403`, and a non-zero count of the seeded Acme samples (the API log line "DEMO MODE" is also in `docker compose logs api`). Use the scratchpad directory path given in the session for `$SCRATCHPAD`.

- [ ] **Step 8: The development workflow still works**

```bash
docker compose down
npm run db:up
E2E_DATABASE_URL=postgres://rag:rag@localhost:${DB_PORT:-5433}/rag_test npm test; echo "exit=$?"
```

Expected: only `db` starts; `exit=0` (29 API suites, 343 tests, plus 11 web tests). Confirm the database is published on loopback only: `docker compose port db 5432` prints `127.0.0.1:...`.

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml
git commit -m "$(cat <<'EOF'
Run the API and web app in compose, with every port bound to localhost

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: CI image build and documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: the compose file from Task 3.
- Produces: a CI step `docker compose build` after `npm run build`; documentation.

- [ ] **Step 1: Add the CI step**

Append to the `steps:` of `.github/workflows/ci.yml`, after `- run: npm run build`:

```yaml
      - name: Build the Docker images
        run: docker compose build
```

(`ubuntu-24.04` runners ship Docker with Compose; no setup action is needed.)

- [ ] **Step 2: Document it in the README**

Read the README's "Quick start" area (`grep -n "db:up" README.md`) and add, directly after the local-development steps, a section titled `### Run everything with Docker`:

```markdown
### Run everything with Docker

No Node needed: `docker compose up --build` starts Postgres, the API and the web app, using the same `.env` as local development (without one it runs on the mock providers). Open http://localhost:3000.

- Every port is published on `127.0.0.1` only, so nothing is reachable from other machines. A public deployment needs a reverse proxy and HTTPS (a separate guide).
- `NEXT_PUBLIC_API_URL` is baked into the web image when it is built. After changing it (or `API_PORT`), rebuild: `docker compose build web && docker compose up -d`.
- `docker compose down` keeps your documents in the `rag-data` volume; `docker compose down -v` deletes them.
- For the read-only public demo, set `DEMO_MODE=true` in `.env` first (see the demo section below).
```

Also update the existing line `Port 5432 taken? Set DB_PORT in .env and update DATABASE_URL to match.` only if it contradicts the above; it does not, so leave it.

- [ ] **Step 3: Note the build-time variable in `.env.example`**

Replace the last two lines of `.env.example`:

```
CORS_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
```

with:

```
CORS_ORIGIN=http://localhost:3000
# Read when the web app is built or started in development. In Docker it is baked into the web image:
# after changing it, run `docker compose build web`.
NEXT_PUBLIC_API_URL=http://localhost:4000
```

- [ ] **Step 4: Tick the TODO item and narrow the deployment guide**

In `TODO.md` change `- [ ] **Dockerfiles and a full compose stack.** ...` to:

```
- [x] **Dockerfiles and a full compose stack.** Multi-stage images for the API and web app (non-root, production dependencies only), `docker compose up --build` runs the whole stack, and every published port, including the database, binds to `127.0.0.1`. `NEXT_PUBLIC_API_URL` is a build argument of the web image.
```

In the `Public deployment guide` item, replace "the database bound to localhost (compose currently publishes `5432` on all interfaces with password `rag`)" with "a database password other than the default `rag` (compose now binds the database to localhost)".

- [ ] **Step 5: Verify**

Run: `git diff --stat && grep -c "docker compose build" .github/workflows/ci.yml && docker compose build 2>&1 | tail -3; echo "exit=${PIPESTATUS[0]}"` (with `set -o pipefail`).
Expected: four files changed, count `1`, `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml README.md .env.example TODO.md
git commit -m "$(cat <<'EOF'
Build the images in CI and document running the stack in Docker

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

- **Spec coverage:** images (Tasks 1-2), `.dockerignore` (Task 1), compose services, env handling, health, localhost ports (Task 3), CI build, README, `.env.example`, TODO (Task 4). Verification list in the spec maps to Task 3 Steps 3-8 and Task 1/2 content checks.
- **Placeholders:** none. The one conditional ("match another string from `layout.tsx`") names the file to read.
- **Consistency:** the tags `rag-api:test`, `rag-web:test`, the service names and the ports are identical across tasks.
