# TODO

## Phase 1: highest impact

- [x] **Stream answers over SSE.** `stream()` on `ChatProvider` (OpenAI, Anthropic, mock), a streaming endpoint, and a UI that renders tokens as they arrive.
- [x] **Dedupe documents.** `content_hash` column with a unique constraint, return the existing document on a duplicate, replace the title check in `seed.ts`.
- [x] **Record the embedding model per document.** `embedding_model` column; refuse or warn on mismatch with the active provider.
- [x] **Conversation memory.** Chat history from the UI, follow-up rewriting before retrieval, capped history length.

Verified: unit tests, SSE controller tests, typecheck, build, and the e2e suite against real pgvector (47 tests).

## Phase 2: retrieval quality

- [x] **Eval set first.** Questions with expected sources and a script reporting hit rate and MRR; guarded in the test suite.
- [x] **Hybrid search.** `tsvector` + GIN, fused with reciprocal rank fusion; compared against the eval baseline.
- [x] **Re-ranking (optional).** Pluggable `Reranker` interface that runs after retrieval.
- [x] **Check filtered HNSW search.** Reproduced: a `documentIds` filter (and, separately, deleted-but-unvacuumed entries) made HNSW return too few or zero rows. Fixed by searching exactly up to `EXACT_SEARCH_MAX_CHUNKS` chunks, with an exact re-run if the index returns fewer rows than asked for above that. pgvector's iterative scans did not fix the deleted-entries case. Found by CI, not locally: dead entries degrade recall randomly, not only by returning short results.
- [x] **Improve the chunker.** Heading path (a lone document title is dropped from it), tables split between rows with the header repeated, lists split between items, lead-in sentences kept with their list, document title in the embedded text. Documents indexed earlier keep their old chunks until re-indexed.
- [ ] **Token-based chunk sizing (deferred from the chunker item).** Needs a tokenizer dependency (model-specific), and changing what `CHUNK_SIZE` means would silently break existing configs; characters are a fair proxy for English prose. Revisit for code-heavy or non-English corpora, probably as an opt-in `CHUNK_UNIT`.
- [x] **Loosen citation parsing.** Accepts `[1, 2]` and ranges (`[1-3]`), flags answers with no valid citation via `meta.citationsMissing`; the UI links list and range citations.

## Phase 3: features

- [x] **Batch chunk inserts.** One `unnest` insert per document instead of a query per chunk.
- [x] **More providers.** OpenAI-compatible `baseURL` (Ollama, vLLM, etc.); configurable Anthropic `max_tokens`.
- [x] **PDF and DOCX ingestion.** Extractor interface with `.pdf` and `.docx` implementations.
- [x] **Document update and re-index.** `PUT /documents/:id` and `POST /documents/:id/reindex`.
- [x] **Background ingestion.** Return a job id immediately, with a status endpoint, so large uploads don't hold a request open.
- [x] **Auth and per-user document scoping.** API key auth, `owner_id` on documents, every query filtered by it.

## Phase 4: quality, deployment, product

Retrieval quality and answer quality:

- [ ] **Answer-quality eval.** The eval set only measures retrieval (hit rate, MRR). Add a groundedness check (an LLM judge, or "is each citation supported by its chunk") to the eval script, guarded in the test suite with the mock provider.
- [ ] **Multilingual full-text search.** The `fts` column is hardcoded to the `'english'` configuration; make it configurable (or per-document) so hybrid search works for other languages.
- [ ] **Metadata filters and tags.** Filter queries by tag, source or date, not only by `documentIds`.
- [ ] **More ingestion sources.** HTML and URL ingestion as new extractors.
- [ ] **Token-based chunk sizing (carried over from Phase 2).** See above; opt-in `CHUNK_UNIT`.

Deployment and operations:

- [ ] **Dockerfiles and a full compose stack.** `docker-compose.yml` only runs Postgres today; add images for the API and web app so the whole stack starts with one command.
- [ ] **Rate limiting.** Per-user limits on the query endpoints (each call costs LLM money), plus request size limits.
- [ ] **Real migrations.** Replace the inline `ALTER ... IF NOT EXISTS` statements in `database.service.ts` with versioned migrations once the schema changes again.
- [ ] **Observability.** Structured logs with request IDs, latency and token counts per query, optionally OpenTelemetry.
- [ ] **OpenAPI docs.** Generate Swagger docs for the API.

Product:

- [ ] **Persisted conversations.** Store conversations server-side (scoped by owner) so chats can be listed and resumed.
- [ ] **Answer feedback.** Thumbs up/down on answers, stored and usable as an input to the eval set.
- [ ] **Document management in the UI.** Edit, re-index and view a single document from the web app.
