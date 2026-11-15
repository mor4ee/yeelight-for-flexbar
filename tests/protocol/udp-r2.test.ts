import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeUdpR2Packet,
  encodeUdpCommand,
  encodeUdpHeartbeat,
  encodeUdpSessionNew,
  setBrightness,
  YEELIGHT_UDP_R2_MAX_PACKET_BYTES,
  YEELIGHT_UDP_R2_PORT,
  YeelightProtocolError
} from '../../src/backend/protocol';

const TOKEN = '0123456789abcdef0123456789abcdef';

test('encodes UDP R2 session, heartbeat and closed commands without CRLF', () => {
  assert.equal(YEELIGHT_UDP_R2_PORT, 55_444);
  assert.deepEqual(
    JSON.parse(encodeUdpSessionNew(1).toString('utf8')),
    {
      id: 1,
      method: 'udp_sess_new',
      params: []
    }
  );

  assert.deepEqual(
    JSON.parse(encodeUdpHeartbeat(2, TOKEN).toString('utf8')),
    {
      id: 2,
      method: 'udp_sess_keep_alive',
      params: ['keeplive_interval', '10'],
      token: TOKEN
    }
  );

  const command = encodeUdpCommand(3, setBrightness(42), TOKEN);
  assert.equal(command.toString('utf8').endsWith('\r\n'), false);
  assert.deepEqual(JSON.parse(command.toString('utf8')), {
    id: 3,
    method: 'set_bright',
    params: [42, 'smooth', 500],
    token: TOKEN
  });
});

test('decodes session tokens and heartbeat results', () => {
  assert.deepEqual(
    decodeUdpR2Packet(
      JSON.stringify({
        id: 7,
        method: 'udp_sess_token',
        params: {
          token: TOKEN.toUpperCase()
        }
      })
    ),
    {
      kind: 'session-token',
      id: 7,
      token: TOKEN
    }
  );

  assert.deepEqual(
    decodeUdpR2Packet(
      JSON.stringify({
        id: 8,
        result: ['ok'],
        token: TOKEN
      })
    ),
    {
      kind: 'result',
      id: 8,
      result: ['ok'],
      token: TOKEN
    }
  );
});

test('rejects malformed, oversized and tokenless UDP packets', () => {
  assert.throws(
    () => decodeUdpR2Packet('{'),
    (error: unknown) =>
      error instanceof YeelightProtocolError &&
      error.code === 'INVALID_UDP_PACKET'
  );
  assert.throws(
    () =>
      decodeUdpR2Packet(
        JSON.stringify({
          id: 1,
          method: 'udp_sess_token',
          params: {
            token: 'bad'
          }
        })
      ),
    (error: unknown) =>
      error instanceof YeelightProtocolError &&
      error.code === 'INVALID_UDP_TOKEN'
  );
  assert.throws(
    () =>
      decodeUdpR2Packet(
        Buffer.alloc(YEELIGHT_UDP_R2_MAX_PACKET_BYTES + 1)
      ),
    (error: unknown) =>
      error instanceof YeelightProtocolError &&
      error.code === 'UDP_PACKET_TOO_LARGE'
  );
  assert.throws(() =>
    encodeUdpCommand(
      4,
      {
        method: 'arbitrary_method',
        params: []
      },
      TOKEN
    )
  );
});
