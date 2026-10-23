# RAG Starter

A small, production-minded **retrieval-augmented generation** starter: upload Markdown, text, PDF or Word files, ask questions, and get answers that **cite the passages they came from**.

**NestJS** API · **Next.js** chat UI · **Postgres + pgvector** · pluggable LLM providers (**OpenAI**, **Anthropic**, or an **offline mock** that needs no API key).

![Chat UI answering a question with cited sources](docs/screenshot.png)

## Why this exists

Most RAG demos are a notebook and a vector database you have to sign up for. This one is the shape I'd actually ship:

- **One database.** Vectors live next to your data in Postgres (pgvector, HNSW index). No extra service.
- **Grounded answers.** The model only sees numbered passages and must cite them (`[1]`, `[2]`). The API returns which sources were actually cited, and says "I don't know" when retrieval finds nothing relevant.
- **Swappable providers.** Embeddings and chat sit behind small interfaces. Switch OpenAI ↔ Anthropic with an env var, or add your own.
- **Runs offline.** The mock provider (hashed bag-of-words embeddings + an echo "LLM") lets you run the whole app, and the test suite, with zero keys.
- **Tested.** Unit tests for chunking and prompting, plus an end-to-end test against real pgvector in CI.

## Architecture

```mermaid
flowchart LR
  subgraph Web["Next.js UI"]
    U[Upload / paste] --> A
    Q[Ask question] --> A
  end
  A[NestJS API]
  A -- "1. chunk (heading-aware)" --> C[Chunker]
  A -- "2. embed" --> E[(Embedding provider<br/>OpenAI · mock)]
  A -- "3. store / search<br/>cosine, HNSW" --> P[(Postgres + pgvector)]
  A -- "4. answer from numbered passages" --> L[(Chat provider<br/>OpenAI · Anthropic · mock)]
```

**Ingest:** text → structure-aware chunks (split on Markdown sections with the full heading path such as `Setup › Install`, ~800 chars, 120-char overlap on prose, code fences respected, tables split between rows with their header repeated, lists split between items, a lead-in sentence kept with its list) → embeddings (document title and section path included) → one transaction into `documents` + `chunks`.

**Query:** embed the question → candidates from vector search (cosine) and Postgres full-text search, merged with reciprocal rank fusion (`SEARCH_MODE=hybrid`, the default; optionally filtered to selected documents) → drop low-score chunks → prompt with numbered passages → return the answer plus sources, scores and which ones were cited.

## Quick start

Requirements: Node 20.19+ (or 22.12+), Docker.

```bash
git clone https://github.com/kevinmakwana/rag-starter.git
cd rag-starter
cp .env.example .env          # defaults to the offline mock providers
npm install
npm run db:up                 # Postgres 16 + pgvector
npm run seed                  # index the sample docs in /samples
npm run dev:api               # http://localhost:4000
npm run dev:web               # http://localhost:3000  (second terminal)
```

Port 5432 taken? Set DB_PORT in .env and update DATABASE_URL to match.

### Try it (no technical knowledge needed)

Once both servers are running, open the web app in your browser (http://localhost:3000). The two sample documents are already loaded, so just type a question into the box at the bottom and press **Ask**. Each answer shows numbered sources underneath, so you can see exactly where it came from.

**About the Engineering Handbook**

1. Can I deploy on Fridays?
2. How many approvals does a pull request need before merging?
3. What are the working hours?
4. How does the on-call rotation work?
5. How much vacation time do I get?

**About the Cloud FAQ**

6. What does the Team plan cost?
7. What is the refund policy for annual plans?
8. How does billing work?
9. Is my data encrypted?
10. How do I contact support?

**Edge cases worth trying**

- *"What happens if I deploy a bad release during on-call?"* pulls from more than one section.
- *"What is the capital of France?"* is not in the documents, so the app should answer "I don't know based on the provided documents."

> In the default offline mode there is no AI model, so the answer is simply the best-matching passage from the documents, not a written reply. Add an OpenAI or Anthropic key (see below) to get fully written answers with citations.

You can also add your own file with **Upload file** (or paste text with **Paste text**) and ask questions about it.

### Use a real LLM

Edit `.env`:

```bash
# OpenAI for both
EMBEDDING_PROVIDER=openai
CHAT_PROVIDER=openai
OPENAI_API_KEY=sk-...

# or: OpenAI embeddings + Claude for answers
EMBEDDING_PROVIDER=openai
CHAT_PROVIDER=anthropic
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

**Self-hosted or other OpenAI-compatible servers** (Ollama, vLLM, LM Studio): keep `EMBEDDING_PROVIDER`/`CHAT_PROVIDER` on `openai`, set `OPENAI_BASE_URL` (for Ollama `http://localhost:11434/v1`), name your models in `OPENAI_EMBEDDING_MODEL`/`OPENAI_CHAT_MODEL`, and leave the key empty. Set `EMBEDDING_DIM` to the model's size (768 for `nomic-embed-text`); the API checks every returned vector against it and says so if they differ. `dimensions` is only sent to `text-embedding-3` models. `ANTHROPIC_MAX_TOKENS` (default 1024) caps the length of Claude's answers.

`EMBEDDING_DIM` must match the embedding model (1536 for `text-embedding-3-small`). If you change it, drop the `chunks` table and re-ingest. The API refuses to start on a mismatch rather than failing at query time.

> Switching from mock to OpenAI embeddings? (Also re-index after upgrading to the title-aware chunker if you want older documents to benefit.) Re-index: vectors from different models aren't comparable. Each document records the embedding model it was indexed with, so the API logs a warning at startup, reports `degraded` on `/health`, and refuses to add documents (409) while the index mixes models. Documents indexed before this was tracked have no recorded model and are not flagged. Call `POST /documents/reindex` (the web app shows a **Re-index all** button when it notices a mix). Documents indexed before source text was stored are skipped and must be uploaded again; a fresh start, `docker compose down -v && npm run db:up && npm run seed`, also works.

## API

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/health` | | DB check, active providers and embedding model; `status` is `degraded` if some documents were embedded with a different model |
| `GET` | `/documents` | | List indexed documents |
| `POST` | `/documents` | `{ title, content }` | Index pasted text (≤ 500k chars). Identical content is never indexed twice: you get the existing document back (`duplicate: true`, HTTP 200). Returns 409 if the index was built with a different embedding model |
| `POST` | `/documents/upload` | multipart `file` | `.md`, `.markdown`, `.txt`, `.pdf`, `.docx` (≤ 10 MB); first `# H1` becomes the title, else the file name. Word headings, lists and tables are kept as Markdown; unreadable, password-protected or scanned (no text layer, no OCR) files get a 400 that says why |
| `GET` | `/documents/:id` | | The document with its full source text (`content` is `null` for documents indexed before text was stored) |
| `PUT` | `/documents/:id` | `{ title?, content? }` | Change title and/or text; the document is re-chunked and re-embedded atomically (id and date kept). 409 if the new text duplicates another document |
| `POST` | `/documents/:id/reindex` | | Re-index from the stored text with the current chunk settings and embedding model |
| `POST` | `/documents/reindex` | | Re-index every document; returns `{ reindexed, skipped, failed }`. The fix after switching embedding model |
| `POST` | `/jobs/documents` | `{ title, content }` | Same as `POST /documents` but in the background: answers `202` with a job |
| `POST` | `/jobs/upload` | multipart `file` | Same as `POST /documents/upload`, extraction included, in the background (an unsupported file type is still a `400` straight away) |
| `POST` | `/jobs/reindex` | | Re-index everything in the background, with progress |
| `GET` | `/jobs/:id` | | `status` (`queued`, `running`, `succeeded`, `failed`), `progress`, and the `result` or `error`; `GET /jobs` lists recent jobs |
| `DELETE` | `/documents/:id` | | Removes the document and its chunks |
| `POST` | `/query` | `{ question, topK?, documentIds?, history? }` | Returns `answer`, `sources[]`, `meta` |
| `POST` | `/query/stream` | same as `/query` | Server-Sent Events: `sources`, then `token`s, then `done` (the full result), or `error` |

```bash
curl -s localhost:4000/query -H 'content-type: application/json' \
  -d '{"question":"How long are backups kept?"}'
```

Response shape (values illustrative):

```json
{
  "answer": "Backups are taken every six hours and kept for 30 days [1].",
  "sources": [
    { "n": 1, "label": "Acme Cloud FAQ — Data and security", "score": 0.61, "cited": true, "snippet": "…" }
  ],
  "meta": { "embeddingProvider": "openai", "chatProvider": "anthropic", "retrieved": 4, "tookMs": 912 }
}
```

`history` is the earlier chat, oldest first (`[{ "role": "user" | "assistant", "content": "…" }]`). When present, a follow-up like "and for annual plans?" is rewritten into a standalone question before retrieval (`meta.rewrittenQuestion` shows what was searched). Only the last `HISTORY_MESSAGES` messages are used, and with no history there is no extra model call.

```bash
curl -N localhost:4000/query/stream -H 'content-type: application/json' \
  -d '{"question":"How long are backups kept?"}'
```

Citations are read from `[1]`, `[1, 3]` and `[1-3]`. If passages were retrieved but the answer cites none of them, `meta.citationsMissing` is `true` (a plain "I don't know" is not flagged) and the UI says so.

Input is validated with `class-validator` (unknown fields are rejected), and upstream LLM errors come back as a clear `502` instead of an opaque `500`.

## Project layout

```
apps/
  api/                    NestJS
    src/
      config.ts           typed env config with validation
      database/           pg pool, idempotent schema + dimension check
      ingestion/chunker.ts  heading-aware chunking (pure, unit-tested)
      providers/          EmbeddingProvider / ChatProvider + OpenAI, Anthropic, mock
      documents/          ingest, upload, list, delete
      query/              retrieval, prompt building, citations
      seed.ts             index /samples
    test/                 unit + e2e (pgvector) tests
  web/                    Next.js (App Router) chat UI
samples/                  fictional docs to try it with
```

## Configuration

All settings live in the root `.env` (see [`.env.example`](.env.example)): providers and models, `EMBEDDING_DIM`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `TOP_K`, `MIN_SCORE`, `SEARCH_MODE`, `EXACT_SEARCH_MAX_CHUNKS`, `RERANKER`, `HISTORY_MESSAGES`, ports and CORS.

## Authentication and users

Off by default so the quickstart just works; the API logs a warning at startup when it is. Set `API_KEYS` to turn it on:

```bash
API_KEYS=$(openssl rand -hex 24):alice,$(openssl rand -hex 24):bob   # key:user pairs
curl -s localhost:4000/documents -H "Authorization: Bearer <alice's key>"    # or: -H "X-API-Key: <key>"
```

- Every route except `GET /health` then needs a key (`401` otherwise). Keys must be at least 16 characters, and a user may have several (for rotation). Only hashes of keys are kept in memory, and error messages never print one.
- **Each user only ever sees their own documents and jobs**: lists, reads, edits, deletes, re-indexing, background jobs and, above all, search. Naming another user's document id in a query returns nothing, and another user's resources answer `404`, not `403`, so ids cannot be probed. Identical text uploaded by two users stays two documents (duplicates are detected per user).
- Documents from before accounts existed, and everything created while auth is off, belong to the user `default`. After turning auth on, map a key to it (`<key>:default`) to keep access to them.
- The web app asks for the key on first use and keeps it in this browser's `localStorage`; **Sign out** forgets it. Serve the API over HTTPS in production, since keys travel in a header.
- This is access control for a shared deployment, not a full account system: there is no sign-up, per-key permissions or admin role. Switching the embedding model is index-wide, so each user must run **Re-index all** for their own documents. On a very large multi-tenant corpus, filtering by owner after an approximate (HNSW) search is slow; partition the table by owner instead.

## Background jobs

Slow work (parsing a big PDF, embedding hundreds of chunks, re-indexing everything) can run as a job instead of holding a request open. The queue is a Postgres table worked off inside the API process (`INGEST_CONCURRENCY`, default 2), so it needs no extra service. Queued jobs survive a restart; a job that was *running* when the server stopped is marked failed, not retried, because retrying a file that crashed the parser could loop forever. That recovery assumes a single API process (claiming jobs is safe with several; recovery would fail another instance's live jobs). Uploaded bytes and pasted text are deleted from the job row as soon as it finishes, and finished jobs are purged after 7 days. The web app uses jobs for uploads, pasted text and **Re-index all**.

## Retrieval details

- **File formats:** `.pdf` goes through `unpdf` (PDF.js) and `.docx` through `mammoth`, whose HTML is converted to Markdown so headings, lists and tables reach the chunker. Extractors are small objects in `ingestion/extractors.ts`, so another format is one more entry. Files are parsed in-process, so only expose uploads to people you trust. `npm audit` lists `sprintf-js` (via `argparse` via `mammoth`) as moderate with no patched release; only mammoth's command-line script loads it, never the library code used here.

- **Re-ranking** (`RERANKER=llm`): retrieval fetches three times as many passages, the chat model orders them in one extra call, and the top `TOP_K` are kept. Off by default; any failure falls back to the retrieval order.
- **Exact search for small corpora:** HNSW is approximate, and entries of deleted chunks stay in the index until `VACUUM`. In testing, an index full of them returned no live rows at all, and at other times a full page of rows that were not the true nearest (it depends on the random graph, so it showed up on CI but not locally). Up to `EXACT_SEARCH_MAX_CHUNKS` chunks (default 20000, a few tens of milliseconds at most) vector search is therefore exact. Above that it uses the HNSW index and re-runs exactly if the index returns fewer rows than requested, but recall can still dip after large deletes until autovacuum catches up: vacuum regularly and consider raising `hnsw.ef_search` for big corpora.

## Measuring retrieval

`eval/dataset.json` holds questions labelled with the section that answers them (and a few the documents can't answer). `npm run eval` reports hit@k, hit@1, MRR and how often unanswerable questions correctly retrieve nothing, against whatever providers `.env` selects. Run it with `SEARCH_MODE=vector` and `SEARCH_MODE=hybrid` to compare, and with a real embedding provider before trusting the numbers: the offline mock is word-based, so it flatters lexical search. The e2e suite fails if mock-mode quality drops below the recorded baseline.

### Measuring answers

`npm run eval -- --answers` also generates an answer for every question and scores it. The chat model acts as the judge: it splits each answer into claims and checks whether the passages that claim cites actually support it. It reports:

- **grounded**: the mean share of supported claims, and **fully grounded**, the share of answers where every claim is supported.
- **cited**: answers that cite at least one passage.
- **wrong refusals**: "I don't know" even though retrieval found the right section. (A refusal after retrieval missed is a retrieval failure and shows up in the retrieval numbers instead. Answers retrieve `TOP_K` passages, so the two reports line up only when `--k` equals `TOP_K`.)
- **refusal**: unanswerable questions that were correctly refused.

Failing answers are listed with the unsupported claims quoted. `--min-grounded=0.9` and `--min-refusal=0.8` set the exit code like `--min-hit` does, and need `--answers`. If the judge errors or returns something unreadable, that answer is reported as *unjudged* and left out of the scores; the `--min-grounded` gate counts unjudged answers as ungrounded, so a judge that fails on most answers fails the gate rather than letting the few that worked pass it. Write the flags as `--min-grounded=0.9`; a bare `--min-grounded` or `--min-grounded 0.9` is an error, not a skipped gate.

Caveats: the judge is the same model that wrote the answers, which tends to be lenient, so treat the score as a regression signal rather than an absolute measure. Judging is not deterministic, so compare runs on the same provider and expect a little variance. It generates an answer for every question and judges each answer that is not a refusal, so a run makes one chat call per question plus one judge call per answered question (more with `RERANKER=llm`, which adds a call per question). With `CHAT_PROVIDER=mock` the groundedness number is meaningless; the e2e suite only guards the deterministic parts (refusals and citations).

## Testing

```bash
npm test                                   # unit tests
E2E_DATABASE_URL=postgres://rag:rag@localhost:5432/rag_test npm test   # + e2e
```

The e2e suite boots the real Nest app against pgvector with the mock providers, indexes a document, checks the cited answer, deletes it and confirms the "I don't know" path. CI runs everything on every push.

## Ideas for next steps

- PDF and DOCX ingestion
- Auth and per-user document scoping

## License

MIT © Kevin Makwana
