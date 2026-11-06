# Public deployment: design

## Goal

Someone with a small Linux server, a domain name and a model-provider key can follow one guide and end up with the
read-only demo (or the full app) on `https://their-domain`, with HTTPS, no database or internal service reachable from
the internet, a non-default database password, a per-visitor rate limit that sees real client addresses, and a
spend cap in place.

## Context

- The Docker stack exists (`docker-compose.yml`: `db`, `api`, `web`), publishing every port on `127.0.0.1`.
- Demo mode, rate limiting and `TRUST_PROXY` exist. `TRUST_PROXY=1` trusts exactly one proxy hop; a client-chosen
  `X-Forwarded-For` is only safe if that proxy replaces it.
- Caddy (v2, documented behaviour) ignores incoming `X-Forwarded-*` values and sets `X-Forwarded-For` to the real
  remote address, so it is safe behind `TRUST_PROXY=1` when it is the first thing clients reach. It obtains and
  renews Let's Encrypt certificates automatically and flushes `text/event-stream` responses immediately.
- `NEXT_PUBLIC_API_URL` is baked into the web image at build time.
- The database password is `rag` and is also written into `docker-compose.yml`.

## Scope

In: a production overlay `docker-compose.prod.yml`, a `Caddyfile`, a `.env.production.example`, the guide
`docs/deployment.md`, README pointer, TODO update.

Out: provisioning servers, deploy automation or CI deploys, publishing images to a registry, high availability or
several API instances (rate limits and the daily cap live in one process's memory), a CDN in front (it changes the
client-address story), monitoring and alerting.

## Decisions

1. **One domain, two paths.** Caddy serves the web app at `/` and the API under `/api` on the same host
   (`handle_path /api/*` strips the prefix, so `/api/query/stream` reaches `/query/stream`). One DNS record, one
   certificate, and the browser makes same-origin requests apart from the API prefix. The web image is built with
   `NEXT_PUBLIC_API_URL=https://<domain>/api`; `CORS_ORIGIN=https://<domain>`.
2. **An overlay, not a second stack.** `docker-compose.prod.yml` is applied over `docker-compose.yml`. The template
   env file sets `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml`, so plain `docker compose up -d --build`
   uses both. The overlay needs Compose 2.24 or newer (`!reset`).
3. **Nothing but Caddy is published.** The overlay removes the published ports of `db`, `api` and `web` with
   `ports: !reset []`. Caddy publishes `80`, `443` and `443/udp` (HTTP/3). Caddy reaches `api:4000` and `web:3000`
   on the compose network and waits for both to be healthy.
4. **`SITE_ADDRESS` is the single source of the domain.** It is required (`${SITE_ADDRESS:?...}`). The overlay derives
   `NEXT_PUBLIC_API_URL` (build arg) and the API's `CORS_ORIGIN` from it, so they cannot disagree. `CORS_ORIGIN` from
   `.env` is therefore overridden in production on purpose; the guide says so.
5. **A required database password.** `POSTGRES_PASSWORD` is required (`:?`), applied to the `db` service and to the
   API's `DATABASE_URL`, which the overlay rebuilds as `postgres://rag:${POSTGRES_PASSWORD}@db:5432/rag`. It must be
   URL-safe (the guide generates one with `openssl rand -hex 24`). The Postgres image applies the password only when
   it initialises an empty volume, so the guide includes the one command that changes it on an existing volume
   (`ALTER USER`), and says a fresh volume is the simpler route.
6. **`TRUST_PROXY=1`** is set by the overlay, because the overlay is the topology that has exactly one proxy.
7. **Compression only on the web path.** `encode` is applied inside the web handler, not around the API, so a
   compressing proxy never buffers the answer stream.
8. **The guide is the product.** It covers: what you get; prerequisites (server size, Docker and Compose versions,
   DNS A/AAAA record, ports 80 and 443 open); the steps; recommended demo settings (`DEMO_MODE=true`, a low
   `RATE_LIMIT_COSTLY_PER_MIN`, a daily cap sized to the budget, `API_KEYS` empty); the spend cap at the provider
   (set a hard monthly limit in the provider's billing settings, which this repo cannot do or check); a firewall note
   (only 22, 80 and 443; the overlay publishes nothing else); updates (`git pull`, then
   `docker compose up -d --build`, which rebuilds the web image); backups (`pg_dump` and restore commands); a
   verification checklist with commands; and the known limits.
9. **Client-address check in the guide.** Docker's port forwarding can hide client addresses on some setups (rootless
   Docker, some NAT layouts), which would put every visitor in one rate-limit bucket. The guide gives a concrete
   two-network test (the sixth question in a minute from one address returns 429 while a phone on mobile data still
   gets an answer) and says what to do if it fails.

## Verification

Run on this machine with output read, using a throwaway override that maps Caddy to high host ports and
`SITE_ADDRESS=localhost` (Caddy issues a locally trusted certificate for `localhost`):

- `docker compose config` with the overlay is valid, and fails with a clear message when `SITE_ADDRESS` or
  `POSTGRES_PASSWORD` is missing.
- The stack comes up healthy; only Caddy's ports are published (`docker compose ps`, and a connection attempt to the
  old `3000`/`4000`/`5432` host ports is refused).
- Through Caddy: the web page returns 200 over HTTPS; `GET /api/health` returns `ok`; `POST /api/query/stream`
  returns `text/event-stream` with no `Content-Encoding` and delivers `sources`, `token` and `done` events; a write in
  demo mode returns 403.
- A client-supplied `X-Forwarded-For` does not change the rate-limit bucket (sending a forged header cannot reset a
  429 for the same real address).
- The web bundle contains `https://localhost/api` (and not `http://localhost:4000`).
- The API connects with the non-default password; the old password `rag` is rejected by the database.
- `docker compose down && up` keeps the data.
- The existing local workflow still works with no overlay: `docker compose up --build`, `npm run db:up`, and the test
  suite.

Not verifiable here, and stated as untested in the guide: certificate issuance from Let's Encrypt for a real domain,
DNS, HTTP-to-HTTPS redirect on port 80 from the internet, and client addresses behind a Linux server's real network.

## Risks

- `ports: !reset []` and `COMPOSE_FILE` in `.env` depend on the Compose version; the guide states the minimum and
  the check (`docker compose version`).
- A mistake that publishes `api` or `web` to the internet bypasses the rate limiter's address handling; the
  verification checks the published ports explicitly.
- The daily cap protects the bill, not availability (one visitor can use it up); this is documented, not changed.

## Documentation

`docs/deployment.md` (new), README "Running a public demo" gains a link to it, TODO: tick "Public deployment guide"
and keep any leftover items (for example CI deploys) as new unchecked items only if the guide leaves them out.
