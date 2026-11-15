import assert from 'node:assert/strict';
import test from 'node:test';
import { YeelightTcpQueryTransport } from '../../src/backend/connection/tcp-query-transport';
import { MockYeelightServer } from '../integration/mock-yeelight-server';

test('runs a bounded get_prop transaction over a short TCP connection', async () => {
  const server = new MockYeelightServer({
    properties: {
      power: 'on',
      bright: '64'
    }
  });
  const endpoint = await server.start();
  const transport = new YeelightTcpQueryTransport({
    ...endpoint,
    timeoutMs: 100
  });

  try {
    assert.deepEqual(await transport.query(['power', 'bright']), {
      power: 'on',
      bright: '64'
    });
    assert.deepEqual(server.receivedMethods, ['get_prop']);
  } finally {
    transport.stop();
    await server.stop();
  }
});

test('refuses new TCP queries after stop', async () => {
  const transport = new YeelightTcpQueryTransport({
    host: '127.0.0.1',
    port: 55_443
  });
  transport.stop();
  await assert.rejects(transport.query(['power']), /stopped/);
});
