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

1. **Point your domain at the server.** Create an `A` record for the name you will use, for example `demo.example.com`, and use **one name only**. Do not add an `AAAA` (IPv6) record: with Docker's default networking, IPv6 visitors reach the API through Docker's port forwarding and appear to it as one shared address, so they would all share a single rate limit. (Add one only after you have enabled IPv6 for Docker and passed the check below with `curl -6`.) Check the record with `getent hosts demo.example.com`; it should print the server's address. Caddy cannot get a certificate until this works.

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

   The first start builds the images (a few minutes). The `.env` file tells Compose to use the production overlay, `docker-compose.prod.yml`. If `SITE_ADDRESS` or `POSTGRES_PASSWORD` is missing, Compose stops with a message naming it. If it ends with "api is unhealthy" or "dependency failed to start", run `docker compose logs api`: it names the problem, for example `OPENAI_API_KEY is required when an OpenAI provider is selected`. Fix `.env` and run `docker compose up -d` again.

5. **Check it works** (replace the domain):

   ```bash
   curl -s https://demo.example.com/api/health          # "status":"ok","demo":true
   curl -sI https://demo.example.com/ | head -1         # HTTP/2 200
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://demo.example.com/api/documents \
     -H 'content-type: application/json' -d '{"title":"x","content":"y"}'      # 403 in demo mode
   ```

   Then check that the sample documents were indexed, which needs a working provider key:

   ```bash
   docker compose logs api | grep -i "sample documents"
   ```

   You want `Sample documents ready (2 added)`. If you see `Could not index the sample documents: …` instead, the API is running but the demo has nothing to search: the key or the provider settings in `.env` are wrong. Fix them, run `docker compose up -d` (it recreates `api`, which indexes the samples again), and repeat the check. The health check above passes either way.

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
- **Update:** `git pull && docker compose pull caddy db && docker compose up -d --build --pull always`. The first pull refreshes the Caddy and Postgres images (Caddy is what faces the internet, so keep it current), `--pull always` refreshes the Node base images the app is built on, and the web image is rebuilt because the API address is baked into it.
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

### Database changes

The API applies any pending schema migrations when it starts and records them in the `schema_migrations` table, so an update needs no extra step. Take a backup (above) before updating to a version that adds one: migrations only go forward, and going back means restoring that backup. If an older image is started against a newer database it refuses to start and says so; update the image rather than editing `schema_migrations`. Starting several API containers at once is safe, they take turns.

### Changing the database password

`POSTGRES_PASSWORD` only takes effect when the database volume is first created. If you already started the stack and want a different password, change it in the database first, then in `.env`:

```bash
docker compose exec db psql -U rag -d rag -c "ALTER USER rag PASSWORD 'the-new-password'"
nano .env                      # set POSTGRES_PASSWORD to the same value
docker compose up -d
```

(On a fresh server with nothing worth keeping, the simpler route is to remove only the database volume and start again: `docker compose down`, then `docker volume rm <folder>_rag-data` (the folder is the one you cloned into, for example `rag-starter_rag-data`; `docker volume ls` shows it), then `docker compose up -d`. Avoid `docker compose down -v` for this: it also deletes the certificates, and asking Let's Encrypt for a new one repeatedly runs into its weekly limit.) Use letters and digits only, because the password is placed in a URL.

## Reading the logs

With the production overlay the API writes one JSON object per line: Nest's own logs, and one line per request (see "Logs and usage" in the README for every field). Install `jq` on the server (`sudo apt install jq`). The filters below skip lines that are not JSON, because a couple of start-up lines are plain text.

```bash
# every request
docker compose logs --no-log-prefix api | jq -cR 'fromjson? | select(.context=="http")'

# the ten slowest requests
docker compose logs --no-log-prefix api \
  | jq -cR 'fromjson? | select(.context=="http") | {route, status, durationMs, requestId}' \
  | jq -s 'sort_by(-.durationMs) | .[0:10]'

# model calls and tokens in the last 24 hours
docker compose logs --no-log-prefix --since 24h api | jq -sRc '
  [split("\n")[] | fromjson? | select(.context=="http" and .usage) | .usage]
  | {requests: length,
     calls: (map(.calls) | add // 0),
     inputTokens: (map(.inputTokens) | add // 0),
     outputTokens: (map(.outputTokens) | add // 0),
     withUnknownTokens: (map(select(.tokensUnknown)) | length)}'

# everything logged for one request (visitors can read its id from the X-Request-Id response header)
docker compose logs --no-log-prefix api | grep THE-REQUEST-ID
```

If `withUnknownTokens` is not 0, the token totals are a lower bound: some calls (an answer a visitor stopped reading, a call that failed, or a streamed answer from a custom `OPENAI_BASE_URL`) did not report their tokens. `inputTokens` adds chat prompt tokens and the question-embedding tokens, which are priced differently; in the read-only demo the embeddings are short questions, so they are a small share, but price them separately if you also let people upload documents. Multiply the totals by your provider's current prices for a rough idea of the day's spend; the logs deliberately do not hard-code prices, and your provider's usage page is the authoritative number. Background jobs (uploads, re-indexing) are not in these lines. Questions, answers and visitor addresses are not in the logs by design, so you can see how much was asked and what it cost, not what people asked.

## Check that visitors are told apart

The rate limiter works per visitor address. Docker's port forwarding keeps the real address on a standard Linux server, but some setups (rootless Docker, certain network layers) hide it, which would put every visitor in one bucket. Test once:

1. Temporarily set `RATE_LIMIT_COSTLY_PER_MIN=3` in `.env` and run `docker compose up -d`.
2. From your laptop, ask four questions within a minute over IPv4 (`curl -4 -s -o /dev/null -w "%{http_code}\n" -X POST https://demo.example.com/api/query -H 'content-type: application/json' -d '{"question":"What is the refund policy?"}'`). The fourth must return `429`.
3. From a different network (a phone on mobile data, or a VPN), ask one question. It must succeed (200).

If the other network also gets `429`, the API sees one address for everyone: every visitor shares one limit.

4. **Undo the test:** set `RATE_LIMIT_COSTLY_PER_MIN` back (5 in the template) and run `docker compose up -d` again. Until you do, the live demo allows only 3 questions per minute per visitor.

## Known limits

- **One server, one API process.** The rate limits and the daily cap live in that process's memory and reset when it restarts. Running several API instances multiplies the limits.
- **The daily cap protects your bill, not availability.** One visitor can use up the day's questions; then everyone sees "try again tomorrow".
- **No CDN or extra proxy in front of Caddy** without further changes: `TRUST_PROXY=1` trusts exactly one hop, and a second proxy changes which address the limiter sees.
- **The database password is a single shared secret for one local user**, and `.env` holds your API keys: treat the server accordingly (SSH keys, updates).

## What has and has not been tested

Tested with the same files on a laptop (Caddy using its local certificate for `localhost`): the overlay refusing to start without `SITE_ADDRESS` or `POSTGRES_PASSWORD`; nothing published except Caddy; the site and the API through Caddy; the streamed answer arriving as `text/event-stream` without compression; demo-mode writes refused; the rate limit ignoring a forged `X-Forwarded-For`; the non-default password; data surviving a restart; the backup, restore and password-change commands above; and the log lines and the `jq` filters in "Reading the logs" against real output (token totals against a synthetic log, because the mock providers used here report no tokens).

Not tested here, because it needs a real domain and server: certificate issuance from Let's Encrypt, DNS, the redirect from port 80, client addresses on a real network (use the check above), IPv6 (which is why the guide tells you not to publish an `AAAA` record), and the `docker compose pull caddy db` update step (the Docker daemon on the test machine could not pull images at that time).
