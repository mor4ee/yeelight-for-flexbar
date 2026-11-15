import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UdpR2Transport,
  YeelightUdpR2SessionError
} from '../../src/backend/connection/udp-r2-transport';
import { setBrightness } from '../../src/backend/protocol';
import { UdpR2Simulator } from '../helpers/udp-r2-simulator';

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

test('creates a token session and sends an unconfirmed UDP command', async () => {
  const simulator = new UdpR2Simulator();
  const port = await simulator.start();
  const readyGenerations: number[] = [];
  const transport = new UdpR2Transport({
    host: '127.0.0.1',
    port,
    heartbeatIntervalMs: 1_000,
    onSessionReady: (generation) =>
      readyGenerations.push(generation)
  });

  try {
    await transport.start();
    assert.deepEqual(transport.snapshot(), {
      phase: 'ready',
      sessionGeneration: 1,
      missedHeartbeats: 0
    });
    assert.deepEqual(readyGenerations, [1]);

    await transport.send(setBrightness(37));
    await waitFor(() => simulator.commands.length === 1, 'UDP command');
    assert.equal(simulator.commands[0].method, 'set_bright');
    assert.deepEqual(simulator.commands[0].params, [
      37,
      'smooth',
      500
    ]);
    assert.match(simulator.commands[0].token ?? '', /^[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(transport.snapshot()).includes('token'), false);
  } finally {
    transport.stop();
    await simulator.stop();
  }
});

test('recreates the UDP session after the configured missed heartbeats', async () => {
  const simulator = new UdpR2Simulator();
  const port = await simulator.start();
  const transport = new UdpR2Transport({
    host: '127.0.0.1',
    port,
    heartbeatIntervalMs: 5,
    missedHeartbeatLimit: 2,
    handshakeTimeoutMs: 100
  });

  try {
    await transport.start();
    simulator.respondToHeartbeats = false;
    await waitFor(
      () =>
        simulator.sessionRequests >= 2 &&
        transport.snapshot().sessionGeneration >= 2,
      'replacement UDP session'
    );
    assert.ok(simulator.heartbeatRequests >= 2);
    assert.equal(transport.snapshot().phase, 'ready');
    assert.equal(transport.snapshot().missedHeartbeats, 0);
  } finally {
    transport.stop();
    await simulator.stop();
  }
});

test('ignores malformed session tokens and times out the handshake', async () => {
  const simulator = new UdpR2Simulator();
  simulator.malformedSessionToken = true;
  const port = await simulator.start();
  const warnings: string[] = [];
  const transport = new UdpR2Transport({
    host: '127.0.0.1',
    port,
    handshakeTimeoutMs: 20,
    onWarning: (message) => warnings.push(message)
  });

  try {
    await assert.rejects(
      transport.start(),
      (error: unknown) =>
        error instanceof YeelightUdpR2SessionError &&
        error.message.includes('timed out')
    );
    assert.equal(transport.snapshot().phase, 'idle');
    assert.deepEqual(warnings, [
      'Ignored invalid Yeelight UDP R2 packet'
    ]);
  } finally {
    transport.stop();
    await simulator.stop();
  }
});

test('ignores stale session responses with another request id', async () => {
  const simulator = new UdpR2Simulator();
  simulator.sessionResponseIdOffset = 1;
  const port = await simulator.start();
  const transport = new UdpR2Transport({
    host: '127.0.0.1',
    port,
    handshakeTimeoutMs: 20
  });

  try {
    await assert.rejects(
      transport.start(),
      (error: unknown) =>
        error instanceof YeelightUdpR2SessionError &&
        error.message.includes('timed out')
    );
    assert.equal(transport.snapshot().phase, 'idle');
    assert.equal(simulator.sessionRequests, 1);
  } finally {
    transport.stop();
    await simulator.stop();
  }
});

test('stop cancels heartbeat work and refuses further commands', async () => {
  const simulator = new UdpR2Simulator();
  const port = await simulator.start();
  const transport = new UdpR2Transport({
    host: '127.0.0.1',
    port,
    heartbeatIntervalMs: 5
  });

  try {
    await transport.start();
    await waitFor(
      () => simulator.heartbeatRequests >= 1,
      'first heartbeat'
    );
    transport.stop();
    const heartbeatCount = simulator.heartbeatRequests;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(simulator.heartbeatRequests, heartbeatCount);
    assert.deepEqual(transport.snapshot(), {
      phase: 'stopped',
      sessionGeneration: 1,
      missedHeartbeats: 0
    });
    await assert.rejects(
      transport.send(setBrightness(50)),
      YeelightUdpR2SessionError
    );
  } finally {
    transport.stop();
    await simulator.stop();
  }
});
