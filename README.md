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

**Query:** embed the question → top-k nearest chunks by cosine similarity (optionally filtered to selected documents) → drop low-score chunks → prompt with numbered passages → return the answer plus sources, scores and which ones were cited.

## Quick start

Requirements: Node 20+, Docker.

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

Try asking *"Can I deploy on Fridays?"* or *"What does the Team plan cost?"*.

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

> Switching from mock to OpenAI embeddings? Re-index: vectors from different models aren't comparable. The quickest way is `docker compose down -v && npm run db:up && npm run seed`.

## API

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/health` | | DB check + active providers |
| `GET` | `/documents` | | List indexed documents |
| `POST` | `/documents` | `{ title, content }` | Index pasted text (≤ 500k chars) |
| `POST` | `/documents/upload` | multipart `file` | `.md`, `.markdown`, `.txt` (≤ 2 MB); first `# H1` becomes the title |
| `DELETE` | `/documents/:id` | | Removes the document and its chunks |
| `POST` | `/query` | `{ question, topK?, documentIds? }` | Returns `answer`, `sources[]`, `meta` |

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

All settings live in the root `.env` (see [`.env.example`](.env.example)): providers and models, `EMBEDDING_DIM`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `TOP_K`, `MIN_SCORE`, ports and CORS.

## Testing

```bash
npm test                                   # unit tests
E2E_DATABASE_URL=postgres://rag:rag@localhost:5432/rag_test npm test   # + e2e
```

The e2e suite boots the real Nest app against pgvector with the mock providers, indexes a document, checks the cited answer, deletes it and confirms the "I don't know" path. CI runs everything on every push.

## Ideas for next steps

- Stream answers over SSE
- PDF and DOCX ingestion
- Hybrid search (pgvector + Postgres full-text) with reciprocal rank fusion
- Re-ranking, and an eval set to measure retrieval quality
- Auth and per-user document scoping

## License

MIT © Kevin Makwana
