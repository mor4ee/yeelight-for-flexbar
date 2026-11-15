import assert from 'node:assert/strict';
import test from 'node:test';
import {
  YeelightCommandError,
  YeelightConnectionClosedError,
  YeelightProtocolError,
  YeelightRequestCorrelator,
  YeelightRequestTimeoutError
} from '../../src/backend/protocol';

test('correlates out-of-order results by request id', async () => {
  const correlator = new YeelightRequestCorrelator();
  const first = correlator.create('set_power', 1000);
  const second = correlator.create('set_bright', 1000);

  correlator.handle({
    kind: 'result',
    id: second.id,
    result: ['second']
  });
  correlator.handle({
    kind: 'result',
    id: first.id,
    result: ['first']
  });

  assert.deepEqual(await first.response, ['first']);
  assert.deepEqual(await second.response, ['second']);
  assert.equal(correlator.size, 0);
});

test('turns Yeelight error responses into typed errors', async () => {
  const correlator = new YeelightRequestCorrelator();
  const request = correlator.create('set_bright', 1000);
  correlator.handle({
    kind: 'error',
    id: request.id,
    error: {
      code: -1,
      message: 'unsupported method'
    }
  });

  await assert.rejects(
    request.response,
    (error: unknown) =>
      error instanceof YeelightCommandError &&
      error.commandCode === -1 &&
      error.requestId === request.id
  );
});

test('times out pending requests', async () => {
  const correlator = new YeelightRequestCorrelator();
  const request = correlator.create('get_prop', 5);

  await assert.rejects(
    request.response,
    (error: unknown) => error instanceof YeelightRequestTimeoutError
  );
  assert.equal(correlator.size, 0);
});

test('rejects pending requests when connection closes', async () => {
  const correlator = new YeelightRequestCorrelator();
  const first = correlator.create('set_power', 1000);
  const second = correlator.create('set_bright', 1000);

  correlator.close();

  await assert.rejects(first.response, YeelightConnectionClosedError);
  await assert.rejects(second.response, YeelightConnectionClosedError);
  assert.equal(correlator.size, 0);
  assert.throws(
    () => correlator.create('get_prop', 1000),
    YeelightConnectionClosedError
  );
});

test('enforces the pending-request limit', async () => {
  const correlator = new YeelightRequestCorrelator(1);
  const first = correlator.create('set_power', 1000);
  assert.throws(
    () => correlator.create('set_bright', 1000),
    (error: unknown) =>
      error instanceof YeelightProtocolError &&
      error.code === 'PENDING_LIMIT_REACHED'
  );

  correlator.close();
  await assert.rejects(first.response, YeelightConnectionClosedError);
});
