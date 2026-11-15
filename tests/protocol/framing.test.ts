import assert from 'node:assert/strict';
import test from 'node:test';
import {
  YeelightFrameDecoder,
  YeelightProtocolError
} from '../../src/backend/protocol';

test('decodes a frame split across TCP chunks', () => {
  const decoder = new YeelightFrameDecoder();
  assert.deepEqual(decoder.feed('{"id":1,"res'), []);
  const result = decoder.feed('ult":["ok"]}\r\n');

  assert.deepEqual(result, [
    {
      kind: 'message',
      message: {
        kind: 'result',
        id: 1,
        result: ['ok']
      }
    }
  ]);
});

test('decodes coalesced frames and a split CRLF delimiter', () => {
  const decoder = new YeelightFrameDecoder();
  const first = decoder.feed(
    '{"id":1,"result":["ok"]}\r\n{"method":"props","params":{"power":"on"}}\r'
  );
  assert.equal(first.length, 1);

  const second = decoder.feed(
    '\n{"method":"future_event","params":{"value":1}}\r\n'
  );
  assert.deepEqual(second, [
    {
      kind: 'message',
      message: {
        kind: 'props',
        method: 'props',
        params: {
          power: 'on'
        }
      }
    },
    {
      kind: 'message',
      message: {
        kind: 'notification',
        method: 'future_event',
        params: {
          value: 1
        }
      }
    }
  ]);
});

test('reports malformed JSON without losing the next frame', () => {
  const decoder = new YeelightFrameDecoder();
  const results = decoder.feed(
    '{bad json}\r\n{"id":2,"result":["ok"]}\r\n'
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].kind, 'error');
  if (results[0].kind === 'error') {
    assert.ok(results[0].error instanceof YeelightProtocolError);
  }
  assert.equal(results[1].kind, 'message');
});

test('normalizes numeric props values emitted by real firmware', () => {
  const decoder = new YeelightFrameDecoder();
  const [result] = decoder.feed(
    '{"method":"props","params":{"bright":50}}\r\n'
  );
  assert.deepEqual(result, {
    kind: 'message',
    message: {
      kind: 'props',
      method: 'props',
      params: {
        bright: '50'
      }
    }
  });
});

test('rejects malformed non-scalar props values', () => {
  const decoder = new YeelightFrameDecoder();
  const [result] = decoder.feed(
    '{"method":"props","params":{"bright":{"value":50}}}\r\n'
  );
  assert.equal(result.kind, 'error');
});

test('recovers after an oversized frame', () => {
  const decoder = new YeelightFrameDecoder(32);
  const first = decoder.feed('x'.repeat(40));
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'error');

  const second = decoder.feed(
    '\r\n{"id":3,"result":[]}\r\n'
  );
  assert.deepEqual(second, [
    {
      kind: 'message',
      message: {
        kind: 'result',
        id: 3,
        result: []
      }
    }
  ]);
});
