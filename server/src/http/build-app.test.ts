import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorBody } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';
import { buildApp } from './build-app.ts';

const config: EventConfig = {
  eventId: 'test-run',
  name: 'Test run',
  opensAt: 1,
  closesAt: 2,
  runners: [{ runnerId: 'alice', displayName: 'Alice', color: '#e6194b', keyHash: 'a'.repeat(64) }],
};

const makeApp = () => buildApp({ config, now: () => 1_760_000_000_123 });

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
