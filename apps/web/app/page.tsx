'use client';

import { FormEvent, Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, apiKey, AuthError, DocumentSummary, Health, HistoryMessage, listNames, QueryResult, RateLimitError } from '@/lib/api';

/** How many past question/answer pairs are sent along so follow-ups make sense. */
const HISTORY_TURNS = 3;

interface Turn {
  id: number;
  question: string;
  /** Answer text received so far; replaced by `result.answer` once the stream finishes. */
  partial: string;
  result?: QueryResult;
  error?: string;
}

/** `[1]`, `[1, 3]`, `[1-3]`: the same citation forms the API understands. */
const CITATION = /(\[\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*\s*\])/;

/** Passage numbers named by a citation, ranges expanded (capped so a silly range can't flood the page). */
function citationNumbers(citation: string): number[] {
  return citation
    .slice(1, -1)
    .split(',')
    .flatMap((part) => {
      const [from, to = from] = part.split(/[-–]/).map((n) => Number(n.trim()));
      return Array.from({ length: Math.max(0, Math.min(to - from + 1, 20)) }, (_, i) => from + i);
    });
}

/** Render citations as small, clickable markers that jump to the matching source. */
function Answer({ text, turnId }: { text: string; turnId: number }) {
  return (
    <p className="answer">
      {text.split(CITATION).map((part, i) => {
        // split() with one capture group puts the captured citations at the odd indices.
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
        return (
          <Fragment key={i}>
            {citationNumbers(part).map((n) => (
              <a key={n} className="cite" href={`#src-${turnId}-${n}`}>
                {n}
              </a>
            ))}
          </Fragment>
        );
      })}
    </p>
  );
}

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteBody, setPasteBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  /** The error behind the last failed request, for callers that need to tell what kind it was. */
  const lastError = useRef<unknown>(null);

  /** A rejected key opens the key prompt; anything else is shown as a notice. */
  const handleError = useCallback((err: unknown) => {
    lastError.current = err;
    if (err instanceof AuthError) setNeedsKey(true);
    else setNotice({ kind: 'error', text: (err as Error).message });
  }, []);

  const refresh = useCallback(async () => {
    try {
      setDocs(await api.listDocuments());
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        if (h.authRequired && !apiKey.get()) setNeedsKey(true);
      })
      .catch(() => setHealth(null));
    refresh();
  }, [refresh]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const run = async (label: string, fn: () => Promise<DocumentSummary>) => {
    setBusy(true);
    setNotice(null);
    lastError.current = null;
    try {
      const doc = await fn();
      setNotice({
        kind: 'ok',
        text: doc.duplicate
          ? `"${doc.title}" is already indexed, nothing to add`
          : `${label} "${doc.title}" (${doc.chunkCount} chunks)`,
      });
      await refresh();
      return true;
    } catch (err) {
      handleError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onReindexAll = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.reindexAll();
      const problems = r.skipped.length + r.failed.length;
      setNotice({
        kind: problems ? 'error' : 'ok',
        text:
          `Re-indexed ${r.reindexed} document(s)` +
          (problems ? `; ${problems} could not be re-indexed (${[...r.skipped, ...r.failed].map((d) => d.title).join(', ')}): upload those again.` : '.'),
      });
      await refresh();
      api.health().then(setHealth).catch(() => setHealth(null));
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const onSaveKey = (e: FormEvent) => {
    e.preventDefault();
    apiKey.set(keyInput.trim());
    setKeyInput('');
    setNeedsKey(false);
    setNotice(null);
    api.health().then(setHealth).catch(() => setHealth(null));
    refresh();
  };

  const onSignOut = () => {
    apiKey.set('');
    setDocs([]);
    setSelected(new Set());
    setTurns([]);
    setNeedsKey(true);
  };

  const onUpload = async (files: FileList | null) => {
    const picked = Array.from(files ?? []);
    for (const [index, file] of picked.entries()) {
      const ok = await run('Indexed', () => api.uploadDocument(file));
      if (!ok && lastError.current instanceof RateLimitError) {
        // Every later upload would be refused too: stop, and say which files still need indexing.
        const left = listNames(picked.slice(index).map((f) => f.name));
        setNotice({ kind: 'error', text: `${lastError.current.message} Not indexed yet: ${left}.` });
        break;
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const onPaste = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run('Indexed', () => api.createDocument(pasteTitle, pasteBody));
    if (ok) {
      setPasteTitle('');
      setPasteBody('');
      setPasteOpen(false);
    }
  };

  const onDelete = async (doc: DocumentSummary) => {
    if (!confirm(`Delete "${doc.title}" and its chunks?`)) return;
    try {
      await api.deleteDocument(doc.id);
      setSelected((s) => {
        const next = new Set(s);
        next.delete(doc.id);
        return next;
      });
      await refresh();
    } catch (err) {
      handleError(err);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onAsk = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    const id = Date.now();
    // Earlier answered turns, oldest first. Failed or unanswered turns carry no context.
    const history: HistoryMessage[] = turns
      .filter((turn) => turn.result)
      .slice(-HISTORY_TURNS)
      .flatMap((turn) => [
        { role: 'user' as const, content: turn.question },
        { role: 'assistant' as const, content: turn.result!.answer },
      ]);
    const update = (patch: (turn: Turn) => Turn) =>
      setTurns((t) => t.map((turn) => (turn.id === id ? patch(turn) : turn)));
    setTurns((t) => [...t, { id, question: q, partial: '' }]);
    setQuestion('');
    setAsking(true);
    try {
      const result = await api.queryStream(q, [...selected], history, {
        onToken: (text) => update((turn) => ({ ...turn, partial: turn.partial + text })),
      });
      update((turn) => ({ ...turn, result }));
    } catch (err) {
      if (err instanceof AuthError) setNeedsKey(true);
      update((turn) => ({ ...turn, error: (err as Error).message }));
    } finally {
      setAsking(false);
    }
  };

  return (
    <main className="shell">
      <aside className="sidebar">
        <header className="brand">
          <h1>RAG Starter</h1>
          <p className="muted">
            {health
              ? `embeddings: ${health.embeddingProvider} · chat: ${health.chatProvider}`
              : 'API offline'}
          </p>
        </header>

        {needsKey && (
          <form className="paste" onSubmit={onSaveKey}>
            <p className="notice error">This API needs an API key.</p>
            <input
              type="password"
              placeholder="API key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
              required
            />
            <button className="btn">Use this key</button>
          </form>
        )}

        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>
            Upload file
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setPasteOpen((o) => !o)}>
            {pasteOpen ? 'Cancel' : 'Paste text'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.txt,.pdf,.docx"
            multiple
            hidden
            onChange={(e) => onUpload(e.target.files)}
          />
        </div>

        {pasteOpen && (
          <form className="paste" onSubmit={onPaste}>
            <input
              placeholder="Title"
              value={pasteTitle}
              onChange={(e) => setPasteTitle(e.target.value)}
              required
              maxLength={200}
            />
            <textarea
              placeholder="Paste Markdown or plain text…"
              value={pasteBody}
              onChange={(e) => setPasteBody(e.target.value)}
              rows={8}
              required
            />
            <button className="btn" disabled={busy}>
              {busy ? 'Indexing…' : 'Index document'}
            </button>
          </form>
        )}

        {health && health.mismatchedDocuments > 0 && (
          <p className="notice error">
            {health.mismatchedDocuments} document(s) were indexed with a different embedding model than the active one
            ({health.embeddingModel}). Search results will be unreliable until you re-index.{' '}
            <button className="link" disabled={busy} onClick={onReindexAll}>
              Re-index all
            </button>
          </p>
        )}

        {notice && <p className={`notice ${notice.kind}`}>{notice.text}</p>}
        {health?.authRequired && !needsKey && (
          <p className="muted small">
            <button className="link" onClick={onSignOut}>
              Sign out
            </button>
          </p>
        )}

        <h2>
          Documents <span className="muted">({docs.length})</span>
        </h2>
        {selected.size > 0 && (
          <p className="muted small">
            Searching {selected.size} selected ·{' '}
            <button className="link" onClick={() => setSelected(new Set())}>
              search all
            </button>
          </p>
        )}
        <ul className="docs">
          {docs.length === 0 && <li className="muted small">No documents yet. Upload one or run npm run seed.</li>}
          {docs.map((doc) => (
            <li key={doc.id} className={selected.has(doc.id) ? 'selected' : ''}>
              <label>
                <input type="checkbox" checked={selected.has(doc.id)} onChange={() => toggle(doc.id)} />
                <span>
                  <strong>{doc.title}</strong>
                  <span className="muted small">
                    {doc.chunkCount} chunks · {(doc.charCount / 1000).toFixed(1)}k chars
                  </span>
                </span>
              </label>
              <button className="icon" title="Delete" aria-label={`Delete ${doc.title}`} onClick={() => onDelete(doc)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat">
        <div className="thread">
          {turns.length === 0 && (
            <div className="empty">
              <h2>Ask your documents anything</h2>
              <p className="muted">
                Answers are grounded in the retrieved passages and cite their sources. Try “Can I deploy on
                Fridays?” or “What does the Team plan cost?” with the sample docs.
              </p>
            </div>
          )}
          {turns.map((turn) => (
            <article key={turn.id} className="turn">
              <p className="question">{turn.question}</p>
              {!turn.result && !turn.error && !turn.partial && <p className="muted">Thinking…</p>}
              {!turn.result && turn.partial && <Answer text={turn.partial} turnId={turn.id} />}
              {turn.error && <p className="notice error">{turn.error}</p>}
              {turn.result && (
                <>
                  <Answer text={turn.result.answer} turnId={turn.id} />
                  {turn.result.meta.citationsMissing && (
                    <p className="muted small">This answer cites no sources, so check it against the passages below.</p>
                  )}
                  {turn.result.meta.rewrittenQuestion && (
                    <p className="muted small">Searched for: “{turn.result.meta.rewrittenQuestion}”</p>
                  )}
                  {turn.result.sources.length > 0 && (
                    <details className="sources" open>
                      <summary>
                        {turn.result.sources.length} sources · {turn.result.meta.tookMs} ms
                      </summary>
                      <ol>
                        {turn.result.sources.map((s) => (
                          <li key={s.n} id={`src-${turn.id}-${s.n}`} className={s.cited ? 'cited' : ''}>
                            <div className="source-head">
                              <span className="badge">{s.n}</span>
                              <strong>{s.label}</strong>
                              <span className="muted small">score {s.score.toFixed(2)}</span>
                            </div>
                            <p className="snippet">{s.snippet}</p>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </>
              )}
            </article>
          ))}
          <div ref={bottom} />
        </div>

        <form className="composer" onSubmit={onAsk}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={docs.length ? 'Ask a question…' : 'Add a document first…'}
            maxLength={2000}
            disabled={asking}
          />
          <button className="btn" disabled={asking || !question.trim()}>
            {asking ? '…' : 'Ask'}
          </button>
        </form>
      </section>
    </main>
  );
}
