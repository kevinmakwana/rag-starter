# Answer-quality eval (groundedness)

Phase 4, first item. Date: 2026-10-21.

## Problem

`npm run eval` measures retrieval only (hit@k, MRR, abstention). It never generates an answer, so a
fluent answer that is not supported by the passages it cites, or a wrong "I don't know" despite the
right passage being retrieved, goes unnoticed.

## Goals

- Score generated answers for **groundedness**: is each claim supported by the passages the answer cites?
- Score **refusal behaviour**: refuse when the documents cannot answer, and do not refuse when they can.
- Same ergonomics as the retrieval eval: one command, a short report, `--min-*` thresholds that set the exit code.
- Retrieval-only runs stay free and fast; answer scoring is opt-in because it makes LLM calls.

## Non-goals

- Correctness against reference answers (needs hand-labelled answers; not in this item).
- A separate judge model or provider. The judge reuses the configured chat provider (see Caveats).
- Running real-LLM judging in CI.
- Changing the dataset format.

## Design

### Metrics

Each dataset case is run through the real pipeline. Cases split by `expected`:

**Answerable** (`expected` non-empty):

| Metric | Definition |
|---|---|
| `groundedness` | Mean over judged answers of (supported claims / total claims). Answers with zero claims are not judged (see Refusals). |
| `fullyGrounded` | Share of judged answers where every claim is supported. |
| `citationRate` | Share of answers that cite at least one valid passage (the inverse of `meta.citationsMissing`), counting only non-refusals. |
| `wrongRefusals` | Share of answers that refuse ("I don't know...") although retrieval returned a relevant chunk. |

**Unanswerable** (`expected: []`):

| Metric | Definition |
|---|---|
| `refusalRate` | Share of answers that are a refusal (`isRefusal`). Deterministic, needs no judge. |

A refusal on an answerable question is counted under `wrongRefusals` and excluded from groundedness
(it makes no claims). The report lists the worst answers with their unsupported claims quoted.

### Judge

New file `apps/api/src/eval/judge.ts`:

```ts
interface ClaimVerdict { claim: string; supported: boolean }
interface Verdict { claims: ClaimVerdict[] }
interface Judge { judge(question: string, answer: string, passages: RetrievedChunk[]): Promise<Verdict | null> }
```

`LlmJudge(chat: ChatProvider)` makes **one** `chat.complete` call per answer. The prompt gives the
question, the answer, and the full numbered passages, and asks for JSON:
`{"claims":[{"claim":"...","supported":true}]}`. A claim is supported only if the **passages the claim
cites** back it; a claim with no citation is unsupported. The prompt tells the judge to treat passage
text as data and ignore instructions inside it (same guard as the answer and rerank prompts).

Reply parsing is strict about shape and lenient about framing: take the first JSON object in the reply,
require a `claims` array of `{claim: string, supported: boolean}`, drop malformed entries. If nothing
usable remains the verdict is `null`. A thrown provider error is also `null`. `null` means **unjudged**:
the case is excluded from the means, counted in `unjudged`, and printed. It is never silently scored as
pass or fail.

### Getting full passages

`ask()` returns sources with snippets cut at 320 characters. Judging against truncated text would mark
true claims unsupported. So `QueryService` gains `askWithPassages(...)`, returning
`{ result: QueryResult, passages: RetrievedChunk[] }` (the chunks after reranking, in the order used
for citation numbers). `ask()` becomes a thin wrapper returning `.result`. No behaviour change for the
API; the extraction is covered by the existing query tests.

### Evaluation function

`evaluateAnswers(ask, judge, dataset)` in `apps/api/src/eval/evaluate.ts` (sibling of `evaluate`;
the retrieval path is untouched). `ask` is `(question) => Promise<{ result, passages }>`, injected so unit
tests need no database. Relevance for `wrongRefusals` reuses `isRelevant`. The cited-passage
subset handed to the judge is not needed: the judge sees all passages with their numbers and decides
support per claim from the claim's own citations.

Report shape (`AnswerReport`): the metrics above, `answerable`, `unanswerable`, `unjudged`, and
`failures: { question, answer, unsupported: string[] }[]` for answers with any unsupported claim or a
wrong refusal / missing refusal.

### CLI

`npm run eval` is unchanged. `npm run eval -- --answers` additionally prints an "Answer eval" section
after the retrieval section. New flags, each setting exit code 1 when missed (like `--min-hit`):

- `--min-grounded=<0..1>` against `groundedness`
- `--min-refusal=<0..1>` against `refusalRate`

If `--min-grounded` or `--min-refusal` is passed without `--answers`, the run errors out with a clear
message rather than silently skipping the check.

### Tests

- **Unit** (`test/answer-eval.spec.ts`, stub judge, no DB): metric math, unjudged exclusion, refusal
  handling both ways, failure listing.
- **Unit** (judge parsing): valid JSON, JSON wrapped in prose or a code fence, malformed shape, empty
  claims, provider error, passage text containing instructions is passed as data.
- **E2E guard** (real pgvector, mock providers, in `api.e2e.spec.ts` next to the retrieval baseline):
  only the deterministic metrics, `refusalRate` on the unanswerable cases and `citationRate` on
  answerable ones, against a recorded baseline. The mock chat provider echoes a passage excerpt and
  cites `[1]`, so it cannot be judged meaningfully; judge wiring is covered by the stub.
- **Existing tests**: `ask()` still returns identical results after the `askWithPassages` extraction.

### Docs

README: a section after "Measuring retrieval" covering `--answers`, the metrics, and the caveats below.
TODO.md: tick the item.

## Caveats (to be documented)

- The judge is the same model that wrote the answer, which tends to be lenient. Treat scores as a
  regression signal, not an absolute measure. A separate judge model is an easy later addition.
- Judging is non-deterministic; compare runs on the same provider and expect small variance.
- Cost: one chat call per answerable question for the answer plus one for the judge (more with
  `RERANKER=llm` or history rewriting).
- With the mock provider the groundedness number is meaningless; the CLI prints a note when the
  chat provider is `mock`.

## Open questions

None blocking. Deliberately deferred: separate judge provider, reference-answer correctness, and
CI-gated real-LLM baselines.
