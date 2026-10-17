# RAG Starter

A small, production-minded **retrieval-augmented generation** starter: upload Markdown or text, ask questions, and get answers that **cite the passages they came from**.

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

**Ingest:** text → structure-aware chunks (split on Markdown sections, ~800 chars, 120-char overlap, code fences respected) → embeddings (section heading included) → one transaction into `documents` + `chunks`.

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

You can also add your own file with **Upload .md / .txt** (or paste text with **Paste text**) and ask questions about it.

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

`EMBEDDING_DIM` must match the embedding model (1536 for `text-embedding-3-small`). If you change it, drop the `chunks` table and re-ingest. The API refuses to start on a mismatch rather than failing at query time.

> Switching from mock to OpenAI embeddings? Re-index: vectors from different models aren't comparable. Each document records the embedding model it was indexed with, so the API logs a warning at startup, reports `degraded` on `/health`, and refuses to add documents (409) while the index mixes models. Documents indexed before this was tracked have no recorded model and are not flagged. The quickest way is `docker compose down -v && npm run db:up && npm run seed`.

## API

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/health` | | DB check, active providers and embedding model; `status` is `degraded` if some documents were embedded with a different model |
| `GET` | `/documents` | | List indexed documents |
| `POST` | `/documents` | `{ title, content }` | Index pasted text (≤ 500k chars). Identical content is never indexed twice: you get the existing document back (`duplicate: true`, HTTP 200). Returns 409 if the index was built with a different embedding model |
| `POST` | `/documents/upload` | multipart `file` | `.md`, `.markdown`, `.txt` (≤ 2 MB); first `# H1` becomes the title |
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

All settings live in the root `.env` (see [`.env.example`](.env.example)): providers and models, `EMBEDDING_DIM`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `TOP_K`, `MIN_SCORE`, `SEARCH_MODE`, `HISTORY_MESSAGES`, ports and CORS.

## Measuring retrieval

`eval/dataset.json` holds questions labelled with the section that answers them (and a few the documents can't answer). `npm run eval` reports hit@k, hit@1, MRR and how often unanswerable questions correctly retrieve nothing, against whatever providers `.env` selects. Run it with `SEARCH_MODE=vector` and `SEARCH_MODE=hybrid` to compare, and with a real embedding provider before trusting the numbers: the offline mock is word-based, so it flatters lexical search. The e2e suite fails if mock-mode quality drops below the recorded baseline.

## Testing

```bash
npm test                                   # unit tests
E2E_DATABASE_URL=postgres://rag:rag@localhost:5432/rag_test npm test   # + e2e
```

The e2e suite boots the real Nest app against pgvector with the mock providers, indexes a document, checks the cited answer, deletes it and confirms the "I don't know" path. CI runs everything on every push.

## Ideas for next steps

- PDF and DOCX ingestion
- Re-ranking
- Auth and per-user document scoping

## License

MIT © Kevin Makwana
