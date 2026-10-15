import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameSplitter } from './sse-frames.ts';

test('splits snapshot and ping frames across arbitrary chunk boundaries', () => {
  const push = createFrameSplitter();
  const stream = 'event: snapshot\ndata: {"a":1}\n\n: ping\n\n: ping\n\n';
  const frames = [];
  for (const ch of stream) frames.push(...push(ch));
  assert.deepStrictEqual(frames, [
    { kind: 'event', event: 'snapshot', data: '{"a":1}' },
    { kind: 'comment', text: 'ping' },
    { kind: 'comment', text: 'ping' },
  ]);
});

test('keeps an incomplete frame buffered and accepts CRLF', () => {
  const push = createFrameSplitter();
  assert.deepStrictEqual(push('event: snapshot\r\ndata: {}'), []);
  assert.deepStrictEqual(push('\r\n\r\n'), [{ kind: 'event', event: 'snapshot', data: '{}' }]);
});
