import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ErrorBody, Snapshot } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';
import type { Ingest } from '../ingest/ingest.ts';
import { buildApp } from './build-app.ts';

const config: EventConfig = {
  eventId: 'test-run',
  name: 'Test run',
  opensAt: 1,
  closesAt: 2,
  runners: [{ runnerId: 'alice', displayName: 'Alice', color: '#e6194b', keyHash: 'a'.repeat(64) }],
};

// Story 1.3 tests below replace this with stubs that record their calls.
const noIngest: Ingest = {
  authenticate: () => undefined,
  ingestBatch: () => {
    throw new Error('not expected');
  },
};

const makeApp = () => buildApp({ config, ingest: noIngest, now: () => 1_760_000_000_123 });

test('GET /api/v1/health returns ok, serverNow and eventId', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /application\/json/);
  assert.deepStrictEqual(res.json(), { ok: true, serverNow: 1_760_000_000_123, eventId: 'test-run' });
  await app.close();
});

test('unknown route returns 404 NOT_FOUND ErrorBody', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(res.statusCode, 404);
  const body = ErrorBody.parse(res.json());
  assert.equal(body.error.code, 'NOT_FOUND');
  await app.close();
});

test('thrown error returns 500 INTERNAL_ERROR without leaking the message', async () => {
  const app = makeApp();
  app.get('/boom', async () => {
    throw new Error('secret detail');
  });
  const res = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(res.statusCode, 500);
  assert.deepStrictEqual(res.json(), { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  await app.close();
});

test('framework 4xx errors keep their status and use ErrorBody', async () => {
  const app = makeApp();
  app.post('/echo', async (req) => req.body);
  const res = await app.inject({
    method: 'POST',
    url: '/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{bad',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(ErrorBody.parse(res.json()).error.code, 'BAD_REQUEST');
  await app.close();
});

test('unsupported content-type returns 415 UNSUPPORTED_MEDIA_TYPE', async () => {
  const app = makeApp();
  app.post('/echo', async (req) => req.body);
  const res = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/xml' }, payload: '<a/>' });
  assert.equal(res.statusCode, 415);
  assert.equal(ErrorBody.parse(res.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');
  await app.close();
});

test('body over the limit returns 413 PAYLOAD_TOO_LARGE', async () => {
  const app = makeApp();
  app.post('/echo', { bodyLimit: 10 }, async (req) => req.body);
  const res = await app.inject({
    method: 'POST',
    url: '/echo',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ padding: 'x'.repeat(100) }),
  });
  assert.equal(res.statusCode, 413);
  assert.equal(ErrorBody.parse(res.json()).error.code, 'PAYLOAD_TOO_LARGE');
  await app.close();
});

// ---- Story 1.2: snapshot, live stream, static web app ----

const keyHashes = ['a'.repeat(64)];

function assertNoSecrets(text: string) {
  assert.ok(!text.includes('keyHash'), 'body must not contain keyHash');
  for (const h of keyHashes) assert.ok(!text.includes(h), 'body must not contain a key hash value');
}

test('GET /api/v1/snapshot returns the notStarted snapshot without secrets', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/snapshot' });
  assert.equal(res.statusCode, 200);
  assertNoSecrets(res.body);
  const snap = Snapshot.parse(res.json());
  assert.equal(snap.serverNow, 1_760_000_000_123);
  assert.deepStrictEqual(snap.event, {
    eventId: 'test-run',
    name: 'Test run',
    hasCourse: false,
    lengthM: null,
    runners: [{ runnerId: 'alice', displayName: 'Alice', color: '#e6194b' }],
  });
  assert.deepStrictEqual(
    snap.runners.map((r) => [r.runnerId, r.status, r.distanceM, r.lastPosition]),
    [['alice', 'notStarted', 0, null]],
  );
  assert.deepStrictEqual(snap.tracks, { alice: [] });
  await app.close();
});

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function readUntil(body: ReadableStream<Uint8Array>, predicate: (text: string) => boolean, timeoutMs = 2_000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (!predicate(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(deadline);
  }
  return { text, reader };
}

test('GET /api/v1/live streams SSE headers, a snapshot first, then pings', async () => {
  const app = buildApp({ config, ingest: noIngest, now: () => 1_760_000_000_123, pingIntervalMs: 40 });
  const base = await listen(app);
  try {
    const res = await fetch(`${base}/api/v1/live`, { headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.equal(res.headers.get('content-encoding'), null);
    const { text, reader } = await readUntil(res.body!, (t) => t.split(': ping\n\n').length > 2);
    assertNoSecrets(text);
    const [frame, ...rest] = text.split('\n\n');
    const lines = frame!.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'event: snapshot');
    assert.ok(lines[1]!.startsWith('data: '));
    const snap = Snapshot.parse(JSON.parse(lines[1]!.slice('data: '.length)));
    const viaGet = await app.inject({ method: 'GET', url: '/api/v1/snapshot' });
    assert.deepStrictEqual(snap, viaGet.json());
    assert.deepStrictEqual(rest.filter((f) => f !== ''), [': ping', ': ping']);
    await reader.cancel();
  } finally {
    await app.close();
  }
});

test('app.close() ends open live streams and resolves', async () => {
  const app = buildApp({ config, ingest: noIngest, now: () => 0, pingIntervalMs: 60_000 });
  const base = await listen(app);
  const streams = await Promise.all([fetch(`${base}/api/v1/live`), fetch(`${base}/api/v1/live`)]);
  const readers = [];
  for (const res of streams) readers.push((await readUntil(res.body!, (t) => t.includes('\n\n'))).reader);
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 1_000, 'close should not wait for the streams');
  for (const reader of readers) {
    // Drain anything still buffered; the stream must then report its end, promptly.
    const drain = (async () => {
      let chunk = await reader.read();
      while (!chunk.done) chunk = await reader.read();
    })();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('stream did not end after app.close()')), 1_000);
    });
    try {
      await Promise.race([drain, deadline]);
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
  }
});

test('client abort does not break the server', async () => {
  const app = buildApp({ config, ingest: noIngest, now: () => 0, pingIntervalMs: 20 });
  const base = await listen(app);
  try {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/live`, { signal: controller.signal });
    await readUntil(res.body!, (t) => t.includes('\n\n'));
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    const health = await fetch(`${base}/api/v1/health`);
    assert.equal(health.status, 200);
  } finally {
    await app.close();
  }
});

test('webRoot directory is served at /, /api misses stay JSON 404', async () => {
  const webRoot = mkdtempSync(join(tmpdir(), 'rlt-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>diag</title>');
  const app = buildApp({ config, ingest: noIngest, now: () => 0, webRoot });
  try {
    const index = await app.inject({ method: 'GET', url: '/' });
    assert.equal(index.statusCode, 200);
    assert.match(String(index.headers['content-type']), /text\/html/);
    assert.match(index.body, /diag/);
    const miss = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    assert.equal(miss.statusCode, 404);
    assert.equal(ErrorBody.parse(miss.json()).error.code, 'NOT_FOUND');
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(health.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('missing webRoot logs a warning and serves no web app', async () => {
  const webRoot = join(tmpdir(), 'rlt-web-does-not-exist');
  const logs: string[] = [];
  const stream = { write: (line: string) => void logs.push(line) };
  const app = buildApp({ config, ingest: noIngest, now: () => 0, webRoot, logger: { level: 'warn', stream } });
  try {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 404);
    assert.equal(ErrorBody.parse(res.json()).error.code, 'NOT_FOUND');
    assert.ok(logs.some((l) => l.includes('web build not found')), logs.join('\n'));
  } finally {
    await app.close();
  }
});

test('HEAD /api/v1/live is not routed (a hijacked HEAD would hang)', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'HEAD', url: '/api/v1/live' });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---- Story 1.3: POST /api/v1/ingest ----

const KEY = 'iPjrsCiGy9NtfNOBsf18EVex9bcFh_IiBKe7NCeXNuc';
const SESSION = '3f1c2b9e-8a4d-4c6e-9b2a-1d5e7f0a3c48';
const BATCH = {
  sessionId: SESSION,
  sessionStartedAt: 1_760_000_000_000,
  records: [{ seq: 0, kind: 'fix', recordedAt: 1_760_000_000_000, lat: 48.856613, lon: 2.352219, accuracyM: 4.5 }],
};

type IngestResult = ReturnType<Ingest['ingestBatch']>;
type IngestCalls = { headers: (string | undefined)[]; batches: [string, unknown][] };

function stubIngest(result: IngestResult): { ingest: Ingest; calls: IngestCalls } {
  const calls: IngestCalls = { headers: [], batches: [] };
  return {
    calls,
    ingest: {
      authenticate: (header) => {
        calls.headers.push(header);
        return header === `Bearer ${KEY}` ? 'alice' : undefined;
      },
      ingestBatch: (runnerId, body) => {
        calls.batches.push([runnerId, body]);
        return result;
      },
    },
  };
}

const ACK = { sessionId: SESSION, ackedThroughSeq: 0, serverNow: 1_760_000_000_500 };
const ACCEPTED: IngestResult = { ok: true, ack: ACK, recordCount: 1, inserted: 1, clockSkewMs: 500 };

function postIngest(app: FastifyInstance, payload: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/ingest',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...headers },
    payload,
  });
}

const HUGE = JSON.stringify({ padding: 'x'.repeat(2_000_000) });

test('POST /api/v1/ingest returns the ack and passes the key runner and parsed body', async () => {
  const { ingest, calls } = stubIngest(ACCEPTED);
  const app = buildApp({ config, ingest, now: () => 0 });
  try {
    const res = await postIngest(app, JSON.stringify(BATCH));
    assert.equal(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), ACK);
    assert.deepStrictEqual(calls.batches, [['alice', BATCH]]);
  } finally {
    await app.close();
  }
});

const badAuth: [string, Record<string, string>][] = [
  ['an empty', { authorization: '' }],
  ['a non-Bearer', { authorization: `Basic ${KEY}` }],
  ['an unknown', { authorization: 'Bearer nope' }],
];
for (const [name, headers] of badAuth) {
  test(`POST /api/v1/ingest with ${name} key is 401 UNAUTHORIZED, whatever the body`, async () => {
    const { ingest, calls } = stubIngest(ACCEPTED);
    const app = buildApp({ config, ingest, now: () => 0 });
    try {
      for (const payload of [JSON.stringify(BATCH), '{bad json', HUGE]) {
        const res = await postIngest(app, payload, headers);
        assert.equal(res.statusCode, 401);
        assert.equal(ErrorBody.parse(res.json()).error.code, 'UNAUTHORIZED');
      }
      assert.deepStrictEqual(calls.batches, []);
    } finally {
      await app.close();
    }
  });
}

test('POST /api/v1/ingest without any Authorization header is 401', async () => {
  const { ingest, calls } = stubIngest(ACCEPTED);
  const app = buildApp({ config, ingest, now: () => 0 });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(BATCH),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(ErrorBody.parse(res.json()).error.code, 'UNAUTHORIZED');
    assert.deepStrictEqual(calls.headers, [undefined]);
    assert.deepStrictEqual(calls.batches, []);
  } finally {
    await app.close();
  }
});

const rejections: [400 | 409 | 413, 'INVALID_BATCH' | 'SESSION_OWNER_MISMATCH' | 'BATCH_TOO_LARGE'][] = [
  [400, 'INVALID_BATCH'],
  [413, 'BATCH_TOO_LARGE'],
  [409, 'SESSION_OWNER_MISMATCH'],
];
for (const [status, code] of rejections) {
  test(`POST /api/v1/ingest maps an ingest ${status} to ${code}`, async () => {
    const { ingest } = stubIngest({ ok: false, status, code, message: 'nope' });
    const app = buildApp({ config, ingest, now: () => 0 });
    try {
      const res = await postIngest(app, JSON.stringify(BATCH));
      assert.equal(res.statusCode, status);
      assert.deepStrictEqual(res.json(), { error: { code, message: 'nope' } });
    } finally {
      await app.close();
    }
  });
}

const unparseable: [string, string, Record<string, string>, number, string][] = [
  ['malformed JSON', '{"lat": 48.856613, bad', {}, 400, 'INVALID_BATCH'],
  ['an empty JSON body', '', {}, 400, 'INVALID_BATCH'],
  ['a non-JSON content type', '<a/>', { 'content-type': 'application/xml' }, 400, 'INVALID_BATCH'],
  ['a body over the byte limit', HUGE, {}, 413, 'BATCH_TOO_LARGE'],
];
for (const [name, payload, headers, status, code] of unparseable) {
  test(`POST /api/v1/ingest with ${name} is ${status} ${code} and never reaches ingest`, async () => {
    const { ingest, calls } = stubIngest(ACCEPTED);
    const app = buildApp({ config, ingest, now: () => 0 });
    try {
      const res = await postIngest(app, payload, headers);
      assert.equal(res.statusCode, status);
      assert.equal(ErrorBody.parse(res.json()).error.code, code);
      assert.ok(!res.body.includes('48.856613') && !res.body.includes('xxxx'), 'the reply must not echo the body');
      assert.deepStrictEqual(calls.batches, []);
    } finally {
      await app.close();
    }
  });
}

test('an unexpected ingest failure is 500 INTERNAL_ERROR', async () => {
  const ingest: Ingest = {
    authenticate: () => 'alice',
    ingestBatch: () => {
      throw new Error('disk on fire');
    },
  };
  const app = buildApp({ config, ingest, now: () => 0 });
  try {
    const res = await postIngest(app, JSON.stringify(BATCH));
    assert.equal(res.statusCode, 500);
    assert.deepStrictEqual(res.json(), { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  } finally {
    await app.close();
  }
});

test('ingest logs one batch line with clockSkewMs and never the key, header or body', async () => {
  const logs: string[] = [];
  const stream = { write: (line: string) => void logs.push(line) };
  const { ingest } = stubIngest(ACCEPTED);
  const app = buildApp({ config, ingest, now: () => 0, logger: { level: 'trace', stream } });
  try {
    assert.equal((await postIngest(app, JSON.stringify(BATCH))).statusCode, 200);
    assert.equal((await postIngest(app, JSON.stringify(BATCH), { authorization: 'Bearer wrong-key-123' })).statusCode, 401);
    assert.equal((await postIngest(app, '{"lat": 48.856613, bad')).statusCode, 400);
    const all = logs.join('\n');
    for (const secret of [KEY, 'wrong-key-123', 'Bearer', '48.856613', '2.352219']) {
      assert.ok(!all.includes(secret), `logs must not contain ${secret}`);
    }
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const accepted = lines.filter((l) => l['msg'] === 'ingest batch accepted');
    assert.equal(accepted.length, 1);
    const { runnerId, sessionId, recordCount, ackedThroughSeq, clockSkewMs } = accepted[0]!;
    assert.deepStrictEqual(
      { runnerId, sessionId, recordCount, ackedThroughSeq, clockSkewMs },
      { runnerId: 'alice', sessionId: SESSION, recordCount: 1, ackedThroughSeq: 0, clockSkewMs: 500 },
    );
    assert.deepStrictEqual(
      lines.filter((l) => l['msg'] === 'ingest rejected').map((l) => l['code']),
      ['UNAUTHORIZED', 'INVALID_BATCH'],
    );
  } finally {
    await app.close();
  }
});
