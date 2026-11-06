# Public Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A production overlay (Caddy with automatic HTTPS in front, nothing else published, a required database password) plus a guide, so the demo can be put on a public domain.

**Architecture:** `docker-compose.prod.yml` is applied over `docker-compose.yml`. It adds a Caddy service on ports 80/443, removes the published ports of `db`, `api` and `web`, requires `SITE_ADDRESS` and `POSTGRES_PASSWORD`, and derives `CORS_ORIGIN`, the web build's `NEXT_PUBLIC_API_URL` and `TRUST_PROXY=1` from them. Caddy serves the web app at `/` and the API under `/api` on one host.

**Tech Stack:** Docker Compose 2.24+ (`!reset`), Caddy 2 (`caddy:2-alpine`), the existing images.

**Spec:** `docs/superpowers/specs/2026-11-06-public-deployment-design.md`

## Global Constraints

- One domain: web at `/`, API under `/api` (`handle_path /api/*` strips the prefix). `NEXT_PUBLIC_API_URL=https://<SITE_ADDRESS>/api`, `CORS_ORIGIN=https://<SITE_ADDRESS>`.
- Only Caddy publishes ports: `80`, `443`, `443/udp`. `db`, `api` and `web` publish nothing in the overlay.
- `SITE_ADDRESS` and `POSTGRES_PASSWORD` are required (`${VAR:?message}`); there is no default for either.
- `TRUST_PROXY` is `1` in the overlay (exactly one proxy hop).
- `encode` (compression) applies to the web handler only, never to the API.
- `docker-compose.yml` is not modified. The local workflow (`docker compose up --build`, `npm run db:up`, tests) must behave exactly as before.
- Real certificate issuance, DNS and real-network client addresses cannot be verified on this machine; the guide says so.
- Do not touch the developer's running dev database: run every stack check under a separate project name (`docker compose -p ragprod ...`) so its volume and containers are separate, and never run `down -v` without `-p ragprod`.
- Throwaway files (test override, secrets) live in the session scratchpad directory, not in the repository.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

Conditions a person deploying this will meet that the checks below must pin:

1. `SITE_ADDRESS` or `POSTGRES_PASSWORD` missing: a clear error, never a silent default or an open database (Task 1, Steps 4-5).
2. An existing database volume plus a new password: the database keeps the old one and the API cannot connect; the guide's `ALTER USER` path must actually work (Task 2, Step 4).
3. A forged `X-Forwarded-For` header must not reset or dodge a rate limit (Task 1, Step 8).
4. The answer stream must reach the browser as `text/event-stream`, uncompressed and unbuffered by the proxy (Task 1, Step 7).
5. `api`, `web` and `db` must not be reachable from the host network, only through Caddy (Task 1, Step 6).

---

### Task 1: The production overlay, the Caddyfile, and the template env file

**Files:**
- Create: `docker-compose.prod.yml`
- Create: `Caddyfile`
- Create: `.env.production.example`
- Modify: `.github/workflows/ci.yml` (a validation step)

**Interfaces:**
- Consumes: `docker-compose.yml` services `db`, `api`, `web` (healthchecks on `api` and `web`; build arg `NEXT_PUBLIC_API_URL` on `web`).
- Produces: service `caddy`; volumes `caddy-data`, `caddy-config`; required variables `SITE_ADDRESS` and `POSTGRES_PASSWORD`; the file name `.env.production.example` with `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml`. Task 2 documents all of these by these exact names.

- [ ] **Step 1: Write the failing check**

Run: `SITE_ADDRESS=demo.example.com POSTGRES_PASSWORD=x docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q; echo "exit=$?"`
Expected: FAIL (`exit=1`), "no such file or directory" for `docker-compose.prod.yml`.

- [ ] **Step 2: Write the overlay**

Create `docker-compose.prod.yml`:

```yaml
# Production overlay: put Caddy (automatic HTTPS) in front and publish nothing else.
# Use it together with docker-compose.yml; see docs/deployment.md.
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# or set COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml in .env (see .env.production.example).
# Needs Docker Compose 2.24 or newer (`!reset`).

services:
  db:
    environment:
      # Applied when the database volume is first created. See "Changing the database password" in the guide.
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD (for example: openssl rand -hex 24)}
    ports: !reset []

  api:
    environment:
      DATABASE_URL: postgres://rag:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@db:5432/rag
      # Exactly one proxy (Caddy) sits in front, and it replaces any client-supplied X-Forwarded-For.
      TRUST_PROXY: "1"
      CORS_ORIGIN: https://${SITE_ADDRESS:?set SITE_ADDRESS to your domain, for example demo.example.com}
    ports: !reset []

  web:
    build:
      args:
        NEXT_PUBLIC_API_URL: https://${SITE_ADDRESS:?set SITE_ADDRESS to your domain}/api
    ports: !reset []

  caddy:
    image: caddy:2-alpine
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS:?set SITE_ADDRESS to your domain}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      api:
        condition: service_healthy
      web:
        condition: service_healthy
    restart: unless-stopped

volumes:
  caddy-data:
  caddy-config:
```

- [ ] **Step 3: Write the Caddyfile and the template env file**

Create `Caddyfile`:

```caddyfile
# {$SITE_ADDRESS} is your domain (set in .env). Caddy obtains and renews its HTTPS certificate by itself.
{$SITE_ADDRESS} {
	# The API lives under /api; the prefix is removed before the request reaches it.
	# No compression here: Caddy already sends text/event-stream (streamed answers) unbuffered, and compressing
	# would hold it back.
	handle_path /api/* {
		reverse_proxy api:4000
	}

	handle {
		encode zstd gzip
		reverse_proxy web:3000
	}
}
```

Create `.env.production.example`:

```
# Copy this file to .env on the server and edit it (see docs/deployment.md).

# Use the production overlay with plain `docker compose` commands.
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml

# Your domain, without a scheme or a path. Its DNS record must point at this server.
# CORS_ORIGIN, NEXT_PUBLIC_API_URL and TRUST_PROXY are derived from it and set by the overlay.
SITE_ADDRESS=demo.example.com

# Database password: letters and digits only (it goes into a URL). Generate one: openssl rand -hex 24
# It is applied when the database volume is first created; to change it later see the guide.
POSTGRES_PASSWORD=replace-me-with-openssl-rand-hex-24

# A real model. (EMBEDDING_PROVIDER=mock and CHAT_PROVIDER=mock work offline but only for testing.)
EMBEDDING_PROVIDER=openai
CHAT_PROVIDER=openai
OPENAI_API_KEY=
EMBEDDING_DIM=1536

# Public demo: read-only, sample documents only. Leave API_KEYS empty so anyone can try it.
DEMO_MODE=true
# Questions answered per UTC day across all visitors. Size it to your budget (0 = no cap).
DEMO_MAX_QUERIES_PER_DAY=300
# Per visitor, per minute.
RATE_LIMIT_COSTLY_PER_MIN=5
RATE_LIMIT_PER_MIN=120
API_KEYS=
```

- [ ] **Step 4: Check that the required variables are enforced**

Run: `docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q > "$SCRATCHPAD/req.log" 2>&1; echo "exit=$?"; head -4 "$SCRATCHPAD/req.log"`
Expected: a non-zero exit and messages naming `SITE_ADDRESS` ("set SITE_ADDRESS to your domain") and `POSTGRES_PASSWORD`. Then:
`SITE_ADDRESS=demo.example.com docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q > "$SCRATCHPAD/req.log" 2>&1; echo "exit=$?"; head -3 "$SCRATCHPAD/req.log"`
Expected: a non-zero exit and only the `POSTGRES_PASSWORD` message. Then with both set: `SITE_ADDRESS=demo.example.com POSTGRES_PASSWORD=abc123 docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q; echo "exit=$?"` → `exit=0`.

- [ ] **Step 5: Check what is published and what the resolved config says**

```bash
SITE_ADDRESS=demo.example.com POSTGRES_PASSWORD=abc123 docker compose -f docker-compose.yml -f docker-compose.prod.yml config > "$SCRATCHPAD/resolved.yml"
grep -c "published:" "$SCRATCHPAD/resolved.yml"
grep -E "CORS_ORIGIN|TRUST_PROXY|DATABASE_URL|NEXT_PUBLIC_API_URL" "$SCRATCHPAD/resolved.yml"
docker run --rm -e SITE_ADDRESS=localhost -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -2
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy fmt --diff /etc/caddy/Caddyfile >/dev/null; echo "fmt-exit=$?"
docker compose --env-file .env.production.example config --services
```

Expected: `3` (only Caddy's three ports); `CORS_ORIGIN: https://demo.example.com`, `TRUST_PROXY: "1"`, `DATABASE_URL: postgres://rag:abc123@db:5432/rag`, and `NEXT_PUBLIC_API_URL: https://demo.example.com/api` for the web build; `Valid configuration`; `fmt-exit=0`; and the last command lists `db`, `api`, `web`, `caddy` (the template's `COMPOSE_FILE` is honoured). Note `NEXT_PUBLIC_API_URL: http://localhost:4000` may also appear inside the api container's environment from `.env`; that is harmless.

- [ ] **Step 6: Bring the stack up under its own project name (Review Focus 5)**

Write the throwaway test override `$SCRATCHPAD/prod-test.yml` (Caddy on high local ports, demo mode, a low costly limit so the rate-limit check is quick):

```yaml
services:
  caddy:
    ports: !override
      - "127.0.0.1:8080:80"
      - "127.0.0.1:8443:443"
  api:
    environment:
      DEMO_MODE: "true"
      RATE_LIMIT_COSTLY_PER_MIN: "3"
```

Then:

```bash
export SITE_ADDRESS=localhost POSTGRES_PASSWORD=$(openssl rand -hex 12)
P="-p ragprod -f docker-compose.yml -f docker-compose.prod.yml -f $SCRATCHPAD/prod-test.yml"
docker compose $P up --build -d --wait > "$SCRATCHPAD/prod-up.log" 2>&1; echo "up-exit=$?"; tail -4 "$SCRATCHPAD/prod-up.log"
docker compose $P ps --format '{{.Service}} {{.Status}} {{.Ports}}'
for p in 3000 4000 5432; do curl -s -m 3 -o /dev/null -w "host-port-$p=%{http_code}\n" http://127.0.0.1:$p/; done
```

Expected: `up-exit=0`; `ps` shows `db`, `api`, `web` healthy with no published ports and `caddy` with the 8080/8443 mappings; each host-port probe prints `000` (nothing answers; ignore a dev service you started yourself on 3000/4000, and note the dev database uses 5433).

- [ ] **Step 7: Check traffic through Caddy (Review Focus 4)**

```bash
B=https://localhost:8443
curl -sk $B/api/health
curl -sk -o /dev/null -D - -H 'Accept-Encoding: gzip' $B/ | grep -iE "^HTTP|content-encoding"
curl -sk -N -D - -X POST $B/api/query/stream -H 'content-type: application/json' -H 'Accept-Encoding: gzip' \
  -d '{"question":"How do I reset my password?"}' | grep -iE "^HTTP|content-type|content-encoding|^event:"
curl -sk -o /dev/null -w "write=%{http_code}\n" -X POST $B/api/documents -H 'content-type: application/json' -d '{"title":"x","content":"y"}'
curl -sk $B/api/documents | grep -o '"title":"[^"]*"' | head -3
docker compose $P exec -T web sh -c 'grep -rl "https://localhost/api" .next/static | head -1; grep -rl "localhost:4000" .next/static | head -1; echo scan-done'
```

Expected: `/api/health` returns `"status":"ok"` and `"demo":true`; the web page is `HTTP/2 200` with `content-encoding: gzip` (or `zstd`); the stream response is `HTTP/2 200`, `content-type: text/event-stream`, **no** `content-encoding` line, and `event: sources`, `event: token`, `event: done` frames; `write=403`; the two Acme sample titles are listed; the bundle scan prints one file for the `https://localhost/api` search and nothing for the `localhost:4000` search before `scan-done`.

- [ ] **Step 8: A forged `X-Forwarded-For` does not dodge the rate limit (Review Focus 3)**

The test override sets `RATE_LIMIT_COSTLY_PER_MIN=3`. Wait for a fresh minute window, then:

```bash
for ip in 1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4 5.5.5.5 6.6.6.6; do
  curl -sk -o /dev/null -w "xff=$ip -> %{http_code}\n" -X POST $B/api/query -H 'content-type: application/json' \
    -H "X-Forwarded-For: $ip" -d '{"question":"What is the refund policy?"}'
done
```

Expected: the first three print `200`, the next three `429`, although every request carries a different forged address (Caddy replaces the header, so all six are one caller). If the minute window rolls over mid-run, wait for the next window and run it again; one clean run is the evidence.

- [ ] **Step 9: The password is real, and data survives a restart**

```bash
docker compose $P exec -T -e PGPASSWORD=rag db psql -h 127.0.0.1 -U rag -d rag -c 'select 1' 2>&1 | tail -2
docker compose $P exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db psql -h 127.0.0.1 -U rag -d rag -tAc 'select count(*) from documents'
docker compose $P down && docker compose $P up -d --wait >/dev/null 2>&1
curl -sk $B/api/documents | grep -o '"title":"[^"]*"' | wc -l
```

Expected: the first command reports `password authentication failed for user "rag"`; the second prints `2`; after `down` and `up` (no `-v`) the document count is still `2`.

- [ ] **Step 10: The local workflow is unchanged, then add the CI validation and commit**

Run (without the overlay or the exports): `unset SITE_ADDRESS POSTGRES_PASSWORD; docker compose config --services; docker compose config -q; echo "exit=$?"`
Expected: `db`, `api`, `web` only, `exit=0`.

Add to `.github/workflows/ci.yml`, after the `Build the Docker images` step:

```yaml
      - name: Validate the production overlay
        run: docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q
        env:
          SITE_ADDRESS: ci.example.test
          POSTGRES_PASSWORD: ci-only
```

Then tear down this task's stack (only this project): `docker compose $P down -v`, and unset the exports. Commit:

```bash
git add docker-compose.prod.yml Caddyfile .env.production.example .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
Add a production overlay: Caddy with HTTPS in front, nothing else published

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The deployment guide

**Files:**
- Create: `docs/deployment.md`
- Modify: `README.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: Task 1's file names, service names (`db`, `api`, `web`, `caddy`), variables `SITE_ADDRESS`, `POSTGRES_PASSWORD`, `COMPOSE_FILE`, and the `.env.production.example` template.
- Produces: `docs/deployment.md`, linked from the README.

- [ ] **Step 1: Write the failing check**

Run: `test -f docs/deployment.md && echo exists || echo missing; grep -c "deployment.md" README.md`
Expected: `missing` and `0`.

- [ ] **Step 2: Write the guide**

Create `docs/deployment.md` with exactly this content:

````markdown
# Deploying the public demo

This puts the read-only demo (or the full app) on `https://your-domain`, on one Linux server, with HTTPS, a database password of your own, per-visitor rate limits and a daily question cap. Everything runs in Docker.

```
Internet ──443──▶ Caddy ──/api/*──▶ api (NestJS) ──▶ db (Postgres + pgvector)
                    └────everything else──▶ web (Next.js)
```

Only Caddy is reachable from the internet. The API, the web app and the database have no published ports.

## Before you start

- **A server** you can SSH into, Linux, 2 GB of RAM or more (the images build on the server). Any VPS works.
- **Docker Engine and Docker Compose 2.24 or newer.** Check with `docker compose version`. Install: https://docs.docker.com/engine/install/
- **A domain name** whose DNS you control, and ports **80 and 443** open to the internet (80 is needed to get the certificate and to redirect to HTTPS).
- **A model provider key** (this guide assumes OpenAI embeddings and chat; see `.env.example` for Anthropic and others) **and a spend cap set at the provider**, see "Set a spend cap" below.

## Steps

1. **Point your domain at the server.** Create an `A` record (and `AAAA` if the server has IPv6) for the name you will use, for example `demo.example.com`. Check it with `dig +short demo.example.com`; it should print the server's address. Caddy cannot get a certificate until this works.

2. **Open the firewall for SSH, HTTP and HTTPS only.** For example with ufw: `sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable`. Docker edits the firewall rules itself for ports it publishes and can bypass ufw, so the rule of this setup is: never add a `ports:` entry for `db`, `api` or `web`.

3. **Get the code and configure it.**

   ```bash
   git clone https://github.com/kevinmakwana/rag-starter.git
   cd rag-starter
   cp .env.production.example .env
   openssl rand -hex 24          # use the output as POSTGRES_PASSWORD
   nano .env                     # set SITE_ADDRESS, POSTGRES_PASSWORD, OPENAI_API_KEY
   ```

   `SITE_ADDRESS` is your domain with no `https://` and no path. `.env` holds your keys: never commit it, and keep it readable only by you (`chmod 600 .env`).

4. **Start it.**

   ```bash
   docker compose up -d --build
   docker compose logs -f caddy      # wait for "certificate obtained successfully", then Ctrl+C
   ```

   The first start builds the images (a few minutes). The `.env` file tells Compose to use the production overlay, `docker-compose.prod.yml`. If `SITE_ADDRESS` or `POSTGRES_PASSWORD` is missing, Compose stops with a message naming it.

5. **Check it works** (replace the domain):

   ```bash
   curl -s https://demo.example.com/api/health          # "status":"ok","demo":true
   curl -sI https://demo.example.com/ | head -1         # HTTP/2 200
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://demo.example.com/api/documents \
     -H 'content-type: application/json' -d '{"title":"x","content":"y"}'      # 403 in demo mode
   ```

   Then open the site in a browser and ask one of the starter questions. From outside the server, ports other than 22, 80 and 443 should be closed (try `nc -vz demo.example.com 5432`: it must fail).

## What the settings mean for a public demo

The template `.env.production.example` already sets these; change them to fit:

| Setting | Why |
| --- | --- |
| `DEMO_MODE=true` | Visitors can ask questions over the sample documents and nothing else; every write is refused with 403. |
| `DEMO_MAX_QUERIES_PER_DAY=300` | A daily cap across all visitors; after it the API answers 429 until midnight UTC. Pick a number your budget can pay for: each question costs one embedding call and one chat call. |
| `RATE_LIMIT_COSTLY_PER_MIN=5` | Per visitor, per minute, for the routes that call a model. |
| `API_KEYS=` (empty) | A demo is open to everyone. The API refuses `DEMO_MODE=true` together with `API_KEYS`. |

`TRUST_PROXY=1`, `CORS_ORIGIN` and the web app's API address are set from `SITE_ADDRESS` by the overlay, so you do not set them. To run the full app instead of the demo, set `DEMO_MODE=false` and give people `API_KEYS` (see the README); do not leave write routes open to the internet.

## Set a spend cap

The daily cap bounds how many questions are answered, but the only hard limit on cost is the one at your model provider. Before you share the link, open your provider's billing settings and set a monthly budget or hard usage limit, and enable any usage alerts it offers. This repository cannot set or check that for you.

## Operating it

- **Logs:** `docker compose logs -f api` (or `web`, `caddy`, `db`).
- **Update:** `git pull && docker compose up -d --build`. The web image is rebuilt because the API address is baked into it.
- **Stop:** `docker compose down` keeps the data. `docker compose down -v` deletes the database and the certificates, so only use it when you mean it.
- **Back up** (the documents and their vectors are in Postgres):

  ```bash
  docker compose exec -T db pg_dump -U rag -d rag | gzip > rag-$(date +%F).sql.gz
  ```

- **Restore** from such a file (this replaces the current data):

  ```bash
  docker compose stop api web
  docker compose exec -T db psql -U rag -d postgres -c 'DROP DATABASE rag' -c 'CREATE DATABASE rag'
  gunzip -c rag-2026-11-06.sql.gz | docker compose exec -T db psql -U rag -d rag
  docker compose start api web
  ```

### Changing the database password

`POSTGRES_PASSWORD` only takes effect when the database volume is first created. If you already started the stack and want a different password, change it in the database first, then in `.env`:

```bash
docker compose exec db psql -U rag -d rag -c "ALTER USER rag PASSWORD 'the-new-password'"
nano .env                      # set POSTGRES_PASSWORD to the same value
docker compose up -d
```

(The simpler route on a fresh server with nothing worth keeping is `docker compose down -v` and a new start.) Use letters and digits only, because the password is placed in a URL.

## Check that visitors are told apart

The rate limiter works per visitor address. Docker's port forwarding keeps the real address on a standard Linux server, but some setups (rootless Docker, certain network layers) hide it, which would put every visitor in one bucket. Test once:

1. Temporarily set `RATE_LIMIT_COSTLY_PER_MIN=3` in `.env` and run `docker compose up -d`.
2. From your laptop, ask four questions within a minute (`curl -s -X POST https://demo.example.com/api/query -H 'content-type: application/json' -d '{"question":"What is the refund policy?"}'`). The fourth must return `429`.
3. From a different network (a phone on mobile data), ask one question. It must succeed (200).

If the phone also gets `429`, the API sees one address for everyone: every visitor shares one limit. Restore the setting afterwards.

## Known limits

- **One server, one API process.** The rate limits and the daily cap live in that process's memory and reset when it restarts. Running several API instances multiplies the limits.
- **The daily cap protects your bill, not availability.** One visitor can use up the day's questions; then everyone sees "try again tomorrow".
- **No CDN or extra proxy in front of Caddy** without further changes: `TRUST_PROXY=1` trusts exactly one hop, and a second proxy changes which address the limiter sees.
- **The database password is a single shared secret for one local user**, and `.env` holds your API keys: treat the server accordingly (SSH keys, updates).

## What has and has not been tested

Tested with the same files on a laptop (Caddy using its local certificate for `localhost`): the overlay refusing to start without `SITE_ADDRESS` or `POSTGRES_PASSWORD`; nothing published except Caddy; the site and the API through Caddy; the streamed answer arriving as `text/event-stream` without compression; demo-mode writes refused; the rate limit ignoring a forged `X-Forwarded-For`; the non-default password; data surviving a restart; and the backup, restore and password-change commands above.

Not tested here, because it needs a real domain and server: certificate issuance from Let's Encrypt, DNS, the redirect from port 80, and client addresses on a real network (use the check above).
````

- [ ] **Step 3: Run the guide's commands that can be run locally**

Reuse the test stack of Task 1 (recreate the `P`, `B`, `SITE_ADDRESS`, `POSTGRES_PASSWORD` shell variables as in Task 1 Step 6, then `docker compose $P up -d --wait`). Check the three operational procedures against it, in this order, reading each output:

```bash
# backup
docker compose $P exec -T db pg_dump -U rag -d rag | gzip > "$SCRATCHPAD/rag-backup.sql.gz"; ls -l "$SCRATCHPAD/rag-backup.sql.gz" | awk '{print $5" bytes"}'
curl -sk $B/api/documents | grep -o '"title":"[^"]*"' | wc -l          # before: 2
# restore (as written in the guide, with the test project's file and flags)
docker compose $P stop api web
docker compose $P exec -T db psql -U rag -d postgres -c 'DROP DATABASE rag' -c 'CREATE DATABASE rag'
gunzip -c "$SCRATCHPAD/rag-backup.sql.gz" | docker compose $P exec -T db psql -U rag -d rag >/dev/null 2>"$SCRATCHPAD/restore.err"; echo "restore-exit=$?"; grep -ci "error" "$SCRATCHPAD/restore.err"
docker compose $P start api web; sleep 15
curl -sk $B/api/documents | grep -o '"title":"[^"]*"' | wc -l          # after: 2
```

Expected: a non-zero backup size, `2` before, `restore-exit=0` and `0` error lines (if any appear, read them: the guide's restore must be corrected until it is clean), `2` after.

Password change, as written in the guide:

```bash
NEWPW=$(openssl rand -hex 12)
docker compose $P exec -T db psql -U rag -d rag -c "ALTER USER rag PASSWORD '$NEWPW'"
POSTGRES_PASSWORD=$NEWPW docker compose $P up -d --wait >/dev/null 2>&1; echo "up-exit=$?"
curl -sk $B/api/health
```

Expected: `ALTER ROLE`, `up-exit=0`, and `/api/health` still `"status":"ok"` (the API reconnected with the new password). Then tear down only this project: `docker compose $P down -v`.

- [ ] **Step 4: Link the guide and tick the TODO**

In `README.md`, in the "Running a public demo" section, replace the line beginning `Recommended settings for a demo on a real model:` with:

```markdown
To put the demo on a public domain with HTTPS, a database password of your own and a spend cap, follow [docs/deployment.md](docs/deployment.md). It uses a production overlay (`docker-compose.prod.yml`, with Caddy) and the template `.env.production.example`.

Recommended settings for a demo on a real model: leave `API_KEYS` empty, `RATE_LIMIT_COSTLY_PER_MIN=5`, `TRUST_PROXY=1` behind one reverse proxy, HTTPS, the database not exposed to the internet, and a spend cap at your model provider (the overlay sets everything except the spend cap).
```

In `TODO.md`, change the `Public deployment guide` line to:

```
- [x] **Public deployment guide.** `docker-compose.prod.yml` puts Caddy (automatic HTTPS) in front on one domain, publishes nothing else, and requires a database password; `docs/deployment.md` covers DNS, firewall, demo settings, the provider spend cap, updates, backups, restoring and changing the password. Real certificate issuance and client addresses on a live server are untested and flagged as such in the guide.
```

- [ ] **Step 5: Verify the links and the final state, then commit**

Run: `grep -n "docs/deployment.md" README.md | head -3; grep -c "Public deployment guide" TODO.md; grep -n "\[x\] \*\*Public deployment" TODO.md | cut -c1-60; git status -sb | head -6`
Expected: the README link line, `1`, the ticked TODO line, and only `docs/deployment.md`, `README.md`, `TODO.md` changed.

```bash
git add docs/deployment.md README.md TODO.md
git commit -m "$(cat <<'EOF'
Add the public deployment guide

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

- **Spec coverage:** overlay with Caddy, nothing else published, required password, derived origin/API URL/`TRUST_PROXY` (Task 1); `encode` on the web path only (Task 1 Caddyfile); template env file and `COMPOSE_FILE` (Task 1); the guide with every section the spec lists, including the client-address test and the untested list (Task 2); README pointer and TODO (Task 2). The spec's verification list maps to Task 1 Steps 4-10 and Task 2 Step 3. One addition beyond the spec: a CI step that validates the overlay (Task 1 Step 10), recorded as a ruling at execution.
- **Placeholders:** none; every file's content is given in full.
- **Consistency:** variable names (`SITE_ADDRESS`, `POSTGRES_PASSWORD`, `COMPOSE_FILE`), service names, and the project name `ragprod` are the same across both tasks and the guide.
