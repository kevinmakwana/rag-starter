export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface DocumentSummary {
  id: string;
  title: string;
  source: string;
  charCount: number;
  chunkCount: number;
  createdAt: string;
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
  meta: { embeddingProvider: string; chatProvider: string; retrieved: number; tookMs: number };
}

export interface Health {
  status: string;
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

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

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
};
