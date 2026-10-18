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
    /** The standalone question that was searched, when a follow-up was rewritten. */
    rewrittenQuestion?: string;
  };
}

export interface Health {
  status: string;
  embeddingModel: string;
  mismatchedDocuments: number;
  embeddingProvider: string;
  chatProvider: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, init);
  } catch {
    throw new Error(`Can't reach the API at ${API_URL}. Is it running?`);
  }
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
      ...json({
        question,
        documentIds: documentIds?.length ? documentIds : undefined,
        history: history.length ? history : undefined,
      }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(`Can't reach the API at ${API_URL}. Is it running?`);
  }
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
  createDocument: (title: string, content: string) =>
    request<DocumentSummary>('/documents', json({ title, content })),
  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<DocumentSummary>('/documents/upload', { method: 'POST', body: form });
  },
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),
  query: (question: string, documentIds?: string[]) =>
    request<QueryResult>('/query', json({ question, documentIds: documentIds?.length ? documentIds : undefined })),
  queryStream,
};
