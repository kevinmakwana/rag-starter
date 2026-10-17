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
- [x] **Check filtered HNSW search.** Reproduced: a `documentIds` filter (and, separately, deleted-but-unvacuumed entries) made HNSW return too few or zero rows. Fixed with an exact-scan fallback when the index comes back short. pgvector's iterative scans did not fix the deleted-entries case.
- [ ] **Improve the chunker.** Heading path, tables and lists kept intact, document title in the embedded text, token-based sizing.
- [ ] **Loosen citation parsing.** Accept `[1, 2]` and ranges, flag answers with no valid citation.
