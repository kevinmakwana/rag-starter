// Runs with `node --test` (Node 22.18+ runs the TypeScript in lib/ directly by stripping its types).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { api, listNames, RateLimitError } from '../lib/api.ts';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with a function of the request path; records every path asked for. */
function fakeApi(handler) {
  const paths = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace('http://localhost:4000', '');
    paths.push(path);
    return handler(path, paths.filter((p) => p === path).length);
  };
  return paths;
}

describe('rate-limited responses', () => {
  it('say how long to wait, in the message and on the error', async () => {
    fakeApi(() => json(429, { statusCode: 429 }, { 'retry-after': '7' }));

    const err = await api.listDocuments().catch((e) => e);

    assert.ok(err instanceof RateLimitError);
    assert.equal(err.message, 'Too many requests. Try again in 7 seconds.');
    assert.equal(err.retryAfterSeconds, 7);
  });

  it('use the singular for one second', async () => {
    fakeApi(() => json(429, { statusCode: 429 }, { 'retry-after': '1' }));

    const err = await api.listDocuments().catch((e) => e);

    assert.equal(err.message, 'Too many requests. Try again in 1 second.');
  });

  it('fall back to a generic wait when the header is missing or unusable', async () => {
    for (const headers of [{}, { 'retry-after': 'soon' }, { 'retry-after': '0' }]) {
      fakeApi(() => json(429, { statusCode: 429 }, headers));

      const err = await api.listDocuments().catch((e) => e);

      assert.equal(err.message, 'Too many requests. Try again shortly.');
      assert.equal(err.retryAfterSeconds, undefined);
    }
  });
});

describe('waiting for a background job', () => {
  const done = { id: 'j1', status: 'succeeded', result: { id: 'd', title: 'T', chunkCount: 1 } };

  it('keeps polling through a rate-limited status check, because the job is still running on the server', async () => {
    const paths = fakeApi((path, nth) => {
      if (path === '/jobs/upload') return json(202, { id: 'j1', status: 'queued', title: 'T' });
      return nth <= 2 ? json(429, { statusCode: 429 }, { 'retry-after': '1' }) : json(200, done);
    });

    const doc = await api.uploadDocument(new File(['x'], 'a.md'));

    assert.equal(doc.title, 'T');
    assert.equal(paths.filter((p) => p === '/jobs/j1').length, 3);
  });

  it('still fails when the status check fails for another reason', async () => {
    fakeApi((path) =>
      path === '/jobs/upload' ? json(202, { id: 'j1', status: 'queued', title: 'T' }) : json(500, { message: 'boom' }),
    );

    const err = await api.uploadDocument(new File(['x'], 'a.md')).catch((e) => e);

    assert.equal(err.message, 'boom');
    assert.ok(!(err instanceof RateLimitError));
  });

  it('gives up with the rate-limit error if the API never lets a status check through', async () => {
    let waits = 0;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => (waits++, realSetTimeout(fn, 0)); // skip the real waiting
    try {
      fakeApi((path) =>
        path === '/jobs/upload'
          ? json(202, { id: 'j1', status: 'queued', title: 'T' })
          : json(429, { statusCode: 429 }, { 'retry-after': '1' }),
      );

      const err = await api.uploadDocument(new File(['x'], 'a.md')).catch((e) => e);

      assert.ok(err instanceof RateLimitError);
      assert.ok(waits > 0 && waits < 200);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('listNames', () => {
  it('lists a few names in full', () => {
    assert.equal(listNames(['a.md', 'b.md']), 'a.md, b.md');
  });

  it('shortens a long list', () => {
    assert.equal(listNames(['1', '2', '3', '4', '5', '6', '7']), '1, 2, 3, 4, 5 and 2 more');
  });
});
