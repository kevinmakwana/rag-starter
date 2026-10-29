# Rate limiting and request size limits: design

Status: implemented. Written 2026-10-24; amended after implementation (see "Amendments").

## Why

Every query costs model money (a chat call, plus rerank and rewrite calls when enabled), and every
document write costs an embedding call. Today any caller can send unlimited requests. The project is
heading for a public live demo (see "Live demo" below), where that is a direct risk to the owner's
bill. This spec covers the per-caller request limits and the request-size gap; it does not cover the
demo mode itself.

## Understanding

- **Goal:** a caller who sends too many requests gets `429` with a hint when to retry, and cannot
  run up model cost or starve other callers.
- **Success:** limits are on by default, configurable by env, exempt `/health`, and tested end to end
  with low limits. The web app shows a readable message instead of "Request failed".
- **Constraints:** single API process today (the compose stack runs one), counters in memory, no new
  database table, quickstart (no API keys, mock providers) keeps working.
- **Assumptions the user confirmed:** in-memory storage; the caller is the user id when API keys are
  configured and the client IP when they are not.

## Decisions

### Library

None. A small in-memory fixed-window `RateLimiter` plus a global `RateLimitGuard` (see Amendments for why
`@nestjs/throttler`, the original choice, was dropped).

### Two tiers

| Tier | Applies to | Default | Env |
|---|---|---|---|
| general | every route except exempt ones | 300 / minute | `RATE_LIMIT_PER_MIN` |
| costly | `POST /query`, `POST /query/stream`, `POST /documents`, `PUT /documents/:id`, `POST /documents/upload`, `POST /documents/reindex`, `POST /documents/:id/reindex`, `POST /jobs/documents`, `POST /jobs/upload`, `POST /jobs/reindex` | 20 / minute | `RATE_LIMIT_COSTLY_PER_MIN` |

- A costly request counts against both tiers; the costly limit is the lower one in practice.
- `0` turns a tier off. A negative or non-integer value is a startup error, like the other config.
- Routes are marked with a `@Costly()` decorator (metadata, same style as `@Public()`), so the tier
  of a route is visible where the route is defined.
- Windows are 60 seconds. The numbers are defaults, chosen so the web app's job-status polling and
  normal browsing stay well under the general limit.

### Who is a caller

- API keys configured: the user id that `AuthGuard` put on `request.user`. The rate-limit guard must
  therefore run **after** `AuthGuard` (provider registration order).
- No API keys: the client IP (`request.ip`).
- New `TRUST_PROXY` env: unset or `false` (default), a whole number of proxy hops (recommended), or `true`
  (discouraged: it believes the left-most `X-Forwarded-For` entry, which a client can choose when the proxy
  appends to the header; the API warns at startup). A `req.ip` that is not an IP address, which `true` allows
  through, falls back to the socket address so a client cannot invent buckets. It is
  passed to Express (`trust proxy`) so `request.ip` is the real client behind a reverse proxy. If it
  is forgotten behind a proxy, all clients share the proxy's IP, which over-throttles rather than
  under-throttles. The README says so. Invalid values are a startup error.

### Exempt routes

Routes marked `@Public()` (today only `/health`) are not throttled.

### Response

`429 Too Many Requests` with the standard JSON error body and a `Retry-After` header in whole seconds
(the time left in the caller's window, at least 1). CORS exposes `Retry-After` so the browser app can
read it. Because the guard runs before the handler, `POST /query/stream` answers
with a plain JSON 429 and never opens an SSE stream.

### Web app

`apps/web/lib/api.ts` has two request paths (JSON and stream), each currently turning a non-OK status
into a generic error. Both map `429` to a `RateLimitError` whose message is
"Too many requests. Try again in N seconds." (N from `Retry-After`, with a generic fallback when the
header is missing).

### Request size limits

Question (2000), history (20 x 4000), uploads (10 MB) and document content (500,000 characters) are
already capped by validation. One gap: Nest's default JSON body limit is 100 kB, which is smaller than
the 500,000-character document cap, so a large JSON create got `413` before validation could answer
(`body-limit.spec.ts` reproduces it). The document routes (`/documents`, `/jobs/documents`) now take
JSON bodies up to 4 MB, enough for the cap with worst-case JSON escaping. Every other route is limited
to 512 kB: the largest valid question (2,000 characters plus 20 history messages of 4,000) is about
490 kB when every character needs a six-byte escape. Body parsing runs before the guards, so a caller
over the rate limit can still make the server parse a body up to these sizes; that costs CPU, not model money.

## Components

- `apps/api/src/rate-limit/costly.decorator.ts`: `@Costly()`.
- `apps/api/src/rate-limit/rate-limiter.ts`: `RateLimiter` (fixed window per key, idle keys swept at most
  once a window, and never more than 100,000 callers: the longest-tracked is dropped) and `clientBucket()` (IPv4 as is, `::ffff:a.b.c.d` as the IPv4 address, other IPv6 by /64).
- `apps/api/src/rate-limit/rate-limit.guard.ts`: `RateLimitGuard`; caller is the user id when API keys
  are configured, else the client bucket; skips `@Public()` routes; counts every request against the
  general tier and `@Costly()` ones also against the costly tier; sets `Retry-After` on refusal.
- `apps/api/src/app.module.ts`: registers the guard after `AuthGuard`.
- `apps/api/src/app.setup.ts`: `configureApp()` (CORS with exposed `Retry-After`, `trust proxy`, JSON body
  limit, pipes, filters), shared by `main.ts` and the tests.
- `apps/api/src/config.ts`: `rateLimit: { perMinute, costlyPerMinute }`, `trustProxy`, with validation.
- `apps/web/lib/api.ts`: `RateLimitError` and the two mappings.
- README section and `.env.example` entries.

## Testing

- **Config unit tests:** defaults, `0` disables, negative / fractional / non-numeric rejected,
  `TRUST_PROXY` accepts `false`, `true`, whole numbers and rejects the rest.
- **Tracker unit test:** user id wins when present; otherwise IP.
- **E2E with tiny limits** (config overridden for the test app):
  - the (N+1)th costly request returns `429` with a numeric `Retry-After`;
  - two users do not share a bucket (auth on); two IPs do not share a bucket (auth off, via
    `X-Forwarded-For` with `TRUST_PROXY` set);
  - a costly request also consumes the general budget;
  - `/health` is never limited;
  - `POST /query/stream` over the limit gets JSON `429` with no `text/event-stream` content type;
  - with a limit of `0` that tier never limits.
- **Body limit test:** a JSON document create just under `MAX_DOCUMENT_CHARS` succeeds.
- **Web:** `apps/web/test/api.test.mjs` (Node's built-in test runner, which runs the TypeScript in `lib/`
  directly on Node 22.18+) covers the 429 mapping and job polling. The page's upload loop is checked in a browser.

## Amendments (found while implementing)

- **No `@nestjs/throttler`.** NestJS 12 is ESM-only and the library is CommonJS. It works at runtime on
  Node 22.12+ (`require` of ESM), but Jest in ESM mode cannot load it, so the real guard could not be
  tested; installing it also split Nest into two versions (12.2.0 at the repo root, 12.1.2 in
  `apps/api`) and broke the existing e2e suite. Since the tracker, the counter key and the
  `Retry-After` header all needed overriding anyway (the library keys counters per route and names the
  header `Retry-After-<tier>`), a ~60-line limiter costs less than the dependency.
- **Fixed window, not sliding.** A caller can send up to twice the limit across a window boundary. That
  protects a bill; it is not usage metering.
- **IPv4-mapped IPv6.** Express reports IPv4 clients on a dual-stack socket as `::ffff:a.b.c.d`. Grouping
  those by /64 would put every IPv4 client in one bucket, so they are mapped back to the IPv4 address.

## Known limits (documented in the README)

- Counters live in the API process memory: they reset on restart, and N instances allow N times the
  limit. A shared store is a later change.
- Failed authentication (`401`) is rejected by `AuthGuard` before the limiter runs, so wrong keys
  are not counted. Keys are at least 16 characters, so guessing is impractical, and a flood of 401s
  costs no model money.
- No per-key custom limits and no daily token or spend budget. A spend cap at the model provider is
  the backstop for a public deployment.

## Live demo (next, separate specs)

The user wants a live instance people can try. Rate limiting is one prerequisite. The others are
tracked in TODO.md and each gets its own spec: demo mode (read-only visitors on preloaded sample
documents), Dockerfiles and a full compose stack with the database bound to localhost, and a public
deployment guide (HTTPS, `TRUST_PROXY`, provider spend cap).

## Out of scope

Shared (Postgres or Redis) counter storage, per-key limits, spend budgets, rate limiting of failed
authentication, and the demo mode itself.
