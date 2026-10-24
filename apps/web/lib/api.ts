export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface DocumentSummary {
  id: string;
  title: string;
  source: string;
  charCount: number;
  chunkCount: number;
  createdAt: string;
  /** True when identical content was already indexed and this is the existing document. */
  duplicate: boolean;
}

export interface ReindexReport {
  reindexed: number;
  skipped: { id: string; title: string; reason: string }[];
  failed: { id: string; title: string; reason: string }[];
}

export interface Job {
  id: string;
  kind: 'ingest_text' | 'ingest_file' | 'reindex_all';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  title: string | null;
  progress?: { done: number; total: number };
  result?: unknown;
  error?: string;
}

export interface Source {
  n: number;
  documentId: string;
  title: string;
  heading: string | null;
  label: string;
  snippet: string;
  score: number;
  cited: boolean;
}

export interface QueryResult {
  answer: string;
  sources: Source[];
  meta: {
    embeddingProvider: string;
    chatProvider: string;
    retrieved: number;
    tookMs: number;
    /** True when the answer cites none of the retrieved passages. */
    citationsMissing?: boolean;
    /** The standalone question that was searched, when a follow-up was rewritten. */
    rewrittenQuestion?: string;
  };
}

export interface Health {
  status: string;
  authRequired: boolean;
  embeddingModel: string;
  mismatchedDocuments: number;
  embeddingProvider: string;
  chatProvider: string;
}

const KEY_STORAGE = 'rag-api-key';

/** The API key lives in this browser only (localStorage); it is sent as a Bearer token. */
export const apiKey = {
  get(): string {
    try {
      return localStorage.getItem(KEY_STORAGE) ?? '';
    } catch {
      return '';
    }
  },
  set(key: string): void {
    try {
      if (key) localStorage.setItem(KEY_STORAGE, key);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* storage unavailable: the key just won't persist */
    }
  },
};

/** The API wants a key and this browser has none, or the one it has is wrong. */
export class AuthError extends Error {}

/** The API refused the request because this caller sent too many. */
export class RateLimitError extends Error {}

function rateLimited(res: Response): RateLimitError {
  const seconds = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(seconds) && seconds > 0 ? `Try again in ${Math.ceil(seconds)} seconds.` : 'Try again shortly.';
  return new RateLimitError(`Too many requests. ${wait}`);
}

const withAuth = (init?: RequestInit): RequestInit => {
  const key = apiKey.get();
  return key ? { ...init, headers: { ...init?.headers, authorization: `Bearer ${key}` } } : (init ?? {});
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, withAuth(init));
  } catch {
    throw new Error(`Can't reach the API at ${API_URL}. Is it running?`);
  }
  if (res.status === 401) throw new AuthError('This API needs a valid API key.');
  if (res.status === 429) throw rateLimited(res);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    throw new Error(message ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamHandlers {
  onSources?: (sources: Source[]) => void;
  onToken?: (text: string) => void;
}

/** Split an SSE byte stream into `{ event, data }` frames (frames end with a blank line). */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
    if (done) return;
  }
}

/** Poll a background job until it finishes; resolves with its result or throws its error. */
async function waitForJob<T>(job: Job, intervalMs = 400): Promise<T> {
  let current = job;
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    current = await request<Job>(`/jobs/${current.id}`);
  }
  if (current.status === 'failed') throw new Error(current.error ?? 'The job failed.');
  return current.result as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Ask a question and receive the answer incrementally. Resolves with the final result. */
async function queryStream(
  question: string,
  documentIds: string[] | undefined,
  history: HistoryMessage[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<QueryResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/query/stream`, {
      ...withAuth(json({
        question,
        documentIds: documentIds?.length ? documentIds : undefined,
        history: history.length ? history : undefined,
      })),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(`Can't reach the API at ${API_URL}. Is it running?`);
  }
  if (res.status === 401) throw new AuthError('This API needs a valid API key.');
  if (res.status === 429) throw rateLimited(res);
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    throw new Error(message ?? `Request failed (${res.status})`);
  }

  let result: QueryResult | undefined;
  for await (const { event, data } of readSse(res.body)) {
    if (event === 'sources') handlers.onSources?.(data.sources);
    else if (event === 'token') handlers.onToken?.(data.text);
    else if (event === 'done') result = data.result;
    else if (event === 'error') throw new Error(data.message);
  }
  if (!result) throw new Error('The answer stream ended unexpectedly.');
  return result;
}

export const api = {
  health: () => request<Health>('/health'),
  listDocuments: () => request<DocumentSummary[]>('/documents'),
  // Indexing runs as a background job so big PDFs and slow embedding calls don't hold a request open.
  createDocument: async (title: string, content: string) =>
    waitForJob<DocumentSummary>(await request<Job>('/jobs/documents', json({ title, content }))),
  uploadDocument: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return waitForJob<DocumentSummary>(await request<Job>('/jobs/upload', { method: 'POST', body: form }));
  },
  reindexAll: async () => waitForJob<ReindexReport>(await request<Job>('/jobs/reindex', { method: 'POST' })),
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),
  query: (question: string, documentIds?: string[]) =>
    request<QueryResult>('/query', json({ question, documentIds: documentIds?.length ? documentIds : undefined })),
  queryStream,
};
