'use client';

import { FormEvent, Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, DocumentSummary, Health, QueryResult } from '@/lib/api';

interface Turn {
  id: number;
  question: string;
  result?: QueryResult;
  error?: string;
}

/** Render "[1]" style citations as small, clickable markers. */
function Answer({ text, turnId }: { text: string; turnId: number }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <p className="answer">
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        if (!m) return <Fragment key={i}>{part}</Fragment>;
        return (
          <a key={i} className="cite" href={`#src-${turnId}-${m[1]}`}>
            {m[1]}
          </a>
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
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setDocs(await api.listDocuments());
    } catch (err) {
      setNotice({ kind: 'error', text: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    refresh();
  }, [refresh]);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [turns]);

  const run = async (label: string, fn: () => Promise<DocumentSummary>) => {
    setBusy(true);
    setNotice(null);
    try {
      const doc = await fn();
      setNotice({ kind: 'ok', text: `${label} "${doc.title}" (${doc.chunkCount} chunks)` });
      await refresh();
      return true;
    } catch (err) {
      setNotice({ kind: 'error', text: (err as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) await run('Indexed', () => api.uploadDocument(file));
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
      setNotice({ kind: 'error', text: (err as Error).message });
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
    setTurns((t) => [...t, { id, question: q }]);
    setQuestion('');
    setAsking(true);
    try {
      const result = await api.query(q, [...selected]);
      setTurns((t) => t.map((turn) => (turn.id === id ? { ...turn, result } : turn)));
    } catch (err) {
      setTurns((t) => t.map((turn) => (turn.id === id ? { ...turn, error: (err as Error).message } : turn)));
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

        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>
            Upload .md / .txt
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setPasteOpen((o) => !o)}>
            {pasteOpen ? 'Cancel' : 'Paste text'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.txt"
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

        {notice && <p className={`notice ${notice.kind}`}>{notice.text}</p>}

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
              {!turn.result && !turn.error && <p className="muted">Thinking…</p>}
              {turn.error && <p className="notice error">{turn.error}</p>}
              {turn.result && (
                <>
                  <Answer text={turn.result.answer} turnId={turn.id} />
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
