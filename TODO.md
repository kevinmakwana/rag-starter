# TODO

## Phase 1: highest impact

- [x] **Stream answers over SSE.** `stream()` on `ChatProvider` (OpenAI, Anthropic, mock), a streaming endpoint, and a UI that renders tokens as they arrive.
- [x] **Dedupe documents.** `content_hash` column with a unique constraint, return the existing document on a duplicate, replace the title check in `seed.ts`.
- [x] **Record the embedding model per document.** `embedding_model` column; refuse or warn on mismatch with the active provider.
- [x] **Conversation memory.** Chat history from the UI, follow-up rewriting before retrieval, capped history length.

Verification status: unit tests, the SSE controller tests (stubbed service), typecheck and `npm run build` pass.
The e2e suite (`api.e2e.spec.ts`, real pgvector) has new tests for streaming, dedupe, health and history that
have **not been run yet**: Docker could not pull `pgvector/pgvector:pg16` on this machine.
Run `E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_test npm test` once the database is up.
