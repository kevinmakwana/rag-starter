# Demo mode: design

Status: implemented; see the plan for the rulings made on the way.

## Why

The owner wants a live instance anyone can try. Today a public instance has two bad options: leave
`API_KEYS` unset, so every visitor is the same `default` user who can upload, overwrite and delete
everything (and the web app shows all those controls); or set keys, so visitors need one handed to them.
Demo mode is the third option: strangers can ask questions over the sample documents and nothing else.
Per-caller rate limits and request size caps (already merged) bound abuse per visitor; this adds the
read-only boundary and a global spend guard.

## Understanding

- **Goal:** anyone can open the live instance and try the RAG chat on the Acme sample documents, without
  being able to damage it, store anything on it, or run up the owner's model bill without bound.
- **Visitor scope (confirmed):** ask questions only, over preloaded sample documents. No uploads, edits,
  deletes or re-indexing. Visitor uploads (private expiring workspaces) are a possible later project and
  are out of scope.
- **The server enforces it.** Hiding buttons in the web app is a courtesy, never the protection.
- **Success:** with `DEMO_MODE=true` every write route answers `403`, queries work, the sample documents
  are present after a fresh start with no manual seed step, a global daily query cap bounds worst-case
  spend, and the web app presents itself as a read-only demo. With `DEMO_MODE` unset nothing changes.
- **Constraints:** single API process, in-memory counters (as for rate limiting), no new table.

## Decisions

### Enforcement: deny by default

Rejected alternatives: marking write routes (a write route added later would be open until someone
remembered to mark it, the wrong failure mode on a public server) and a separate read-only deployment
(more infrastructure for no gain).

In demo mode a global `DemoModeGuard` allows:

- any `GET`, `HEAD` or `OPTIONS` request;
- any handler marked `@DemoSafe()` (metadata, same style as `@Public()` and `@Costly()`). Today that is
  exactly `POST /query` and `POST /query/stream`, which read but use `POST` because they carry a body. Only a
  handler can be marked: the marker is read from the handler alone, so `@DemoSafe()` on a whole controller
  opens nothing.

Everything else answers `403` with the standard JSON error and the message
"This is a read-only demo: uploading, editing and deleting are turned off." That covers `POST /documents`,
`PUT`/`DELETE /documents/:id`, `POST /documents/upload`, `POST /documents/reindex`,
`POST /documents/:id/reindex`, and `POST /jobs/documents`, `/jobs/upload`, `/jobs/reindex`. `@Public()`
routes (`/health`) pass. A route added later is blocked until someone marks it `@DemoSafe()`.

Guard order is `AuthGuard`, `DemoModeGuard`, `RateLimitGuard`, `DemoBudgetGuard`. A blocked write is refused
cheaply and never spends a visitor's rate-limit budget, and the daily cap (below) only counts requests the
rate limiter admitted, so one address that floods the API cannot burn the shared budget with refused
requests. `AuthGuard` still comes first, but demo mode and `API_KEYS` are not meant to be combined (see Config).

### Config

- `DEMO_MODE`: `true` or `false` (default `false`); anything else is a startup error naming the variable.
- `DEMO_MAX_QUERIES_PER_DAY`: whole number, default `500`, `0` = no daily cap. Only used in demo mode.
- `DEMO_MODE=true` together with `API_KEYS` is a startup error. A demo is open to everyone and its sample
  documents belong to the `default` user, so key holders (who are other users) would see no documents, and the
  web app offers no key prompt in demo mode.
- `/health` reports `demo: boolean`. The API logs one line at startup saying it is in demo mode and what the
  daily cap is.

### Sample documents seed themselves

In demo mode the API indexes `samples/` at startup, so a fresh deploy works with no manual step. The
logic behind `npm run seed` moves into one shared function (`seedSamples`), used by both. It stays
idempotent: titles and content hashes that already exist are skipped, so restarts re-embed nothing.
Documents belong to the `default` user, which is who every visitor is when auth is off.

Startup waits at most 30 seconds for seeding, so a provider that hangs cannot keep the API from opening its
port; it then logs that it is still indexing and starts, and seeding finishes in the background.
If seeding fails at startup (for example the embedding provider is unreachable) the API logs the error
and keeps starting: an empty demo that says so is better than one that does not start. The web app shows
a notice when demo mode is on and no documents are listed.

### Global daily query cap

A single in-memory counter shared by all visitors, counting `@DemoSafe()` requests that reach the model
(`/query`, `/query/stream`). When it reaches `DEMO_MAX_QUERIES_PER_DAY`, further queries get `429`
with "The demo has reached today's question limit. Please try again tomorrow." and a `Retry-After` for the
seconds until the next UTC midnight. The day is the UTC date; the counter also resets on restart (a known
limit, as for the rate limiter). Rate limits cannot stop many different addresses at once; this caps that
worst case. A spend cap at the model provider remains the final backstop.

The check is its own guard, `DemoBudgetGuard`, last in the chain: refused writes and rate-limited requests
never count. It counts when the request is admitted, not when the model answers, so a request that later
fails still counts (conservative on purpose). It applies to `@DemoSafe()` routes only.

**Trade-off, stated plainly:** the cap protects the bill, not availability. With the default costly limit
of 20 per minute, one address can use up 500 questions in about 25 minutes and the demo then says "try
again tomorrow" for everyone. The README recommends a lower per-address limit for a public demo
(`RATE_LIMIT_COSTLY_PER_MIN=5` makes that about 100 minutes per address). A per-address daily limit is a
possible later addition.

### Web app

`Health` gains `demo: boolean`. When it is true the page:

- hides upload, paste text, delete and re-index, and never shows the API-key prompt;
- shows a banner: "Read-only demo: ask about the Acme sample documents.";
- shows clickable starter questions above the input while the conversation is empty, taken from the
  README's list: "Can I deploy on Fridays?", "How many approvals does a pull request need before
  merging?", "What does the Team plan cost?", "What is the refund policy for annual plans?",
  "How does the on-call rotation work?", and the out-of-corpus one "What is the capital of France?" (to
  show the refusal);
- shows the existing "429" message when the daily cap is hit (the status mapping already exists), and a
  notice when no documents are listed.

`403` responses read as a normal error message (the API's message is already shown by the existing error
path); the controls being hidden means a visitor normally never sees one.

## Components

- `apps/api/src/demo/demo-safe.decorator.ts`: `@DemoSafe()` and `IS_DEMO_SAFE`.
- `apps/api/src/demo/demo-mode.guard.ts`: `DemoModeGuard` (read-only check) and `DemoBudgetGuard` (daily cap).
- `apps/api/src/demo/daily-budget.ts`: `DailyBudget` (counter per UTC day, injectable clock).
- `apps/api/src/demo/seed-samples.ts`: `seedSamples(documents, dir)`, extracted from `seed.ts`.
- `apps/api/src/demo/demo-seeder.ts`: runs `seedSamples` on startup in demo mode (`OnApplicationBootstrap`).
- `apps/api/src/query/query.controller.ts`: `@DemoSafe()` on `ask` and `stream`.
- `apps/api/src/app.module.ts`: guard order; `/health` gains `demo`.
- `apps/api/src/config.ts`: `demo: { enabled, maxQueriesPerDay }`.
- `apps/api/src/seed.ts`: uses `seedSamples`.
- `apps/web/lib/api.ts` and `apps/web/app/page.tsx`: `Health.demo`, hidden controls, banner, starter questions.
- README "Running a public demo", `.env.example`, `TODO.md`.

## Testing

- **Config unit tests:** defaults; `DEMO_MODE` accepts `true`/`false` and rejects the rest;
  `DEMO_MAX_QUERIES_PER_DAY` rejects negative, fractional and non-numeric; `0` disables.
- **`DailyBudget` unit tests:** counts up to the cap and refuses beyond it; resets at the UTC day boundary;
  `Retry-After` is the seconds to the next UTC midnight (at least 1); `0` never refuses.
- **Guard HTTP tests on a probe app** (no database): in demo mode `GET`, `HEAD`, `OPTIONS` and `@DemoSafe()`
  `POST` pass; an unmarked `POST`, `PUT` and `DELETE` get `403` with the message; `@Public()` passes;
  a route added without any marker is blocked; with demo mode off every one passes; refused writes do not
  spend the daily budget or the rate-limit budget; rate-limited requests do not spend the daily budget;
  the daily cap answers `429` with `Retry-After`.
- **Costly/demo classification test:** like the existing costly-routes test, every route handler of
  every controller must be classified demo-safe or write, so a new route cannot be forgotten.
- **E2E on the real app** (inside `api.e2e.spec.ts`, since database specs must share one worker, with
  `DEMO_MODE=true`): the sample documents are present after startup with no seed step and a second startup
  adds none; `GET /documents` and `POST /query` work and cite a sample; `POST /documents`,
  `DELETE /documents/:id`, `POST /documents/reindex`, `POST /jobs/documents` get `403`; `/health` reports
  `demo: true`; the cap returns `429` with a low `DEMO_MAX_QUERIES_PER_DAY`.
- **Web:** `node --test` coverage of the `Health` field handling in `lib/api.ts` where it is logic; the
  page's hidden controls and banner are checked in a browser (the page component has no test runner).

## Known limits (documented in the README)

- The daily counter and the rate limits live in the API process memory: they reset on restart, and several
  API instances multiply them.
- Everyone shares the `default` user's documents, which is the point of the demo. Combining demo mode with
  `API_KEYS` is refused at startup.
- The demo is only as safe as the host in front of it: HTTPS, `TRUST_PROXY`, the database not exposed and a
  provider spend cap are the deployment guide's job (separate TODO item).
- The daily cap can be used up by one determined address (see the trade-off above); that is a loss of
  availability, never of money.
- The model can still be asked anything within the length limits; demo mode does not filter questions.

## Out of scope

Visitor uploads and per-visitor sessions, Dockerfiles and the full compose stack, the public deployment
guide, shared (multi-instance) counters, and filtering or moderating questions.
