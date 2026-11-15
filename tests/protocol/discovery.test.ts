import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDiscoveryPacket,
  YeelightProtocolError
} from '../../src/backend/protocol';

function packet(lines: readonly string[]): string {
  return `${lines.join('\r\n')}\r\n\r\n`;
}

test('parses discovery response headers case-insensitively', () => {
  const result = parseDiscoveryPacket(
    packet([
      'HTTP/1.1 200 OK',
      'LOCATION: yeelight://192.168.1.50:55443',
      'Id: 0x000000000012ABCD',
      'MODEL: color',
      'fw_ver: 42',
      'Support: get_prop set_power set_bright',
      'Power: on',
      'bright: 75',
      'x-vendor-prop: value'
    ])
  );

  assert.equal(result.kind, 'response');
  assert.deepEqual(result.location, {
    host: '192.168.1.50',
    port: 55443
  });
  assert.equal(result.deviceId, '0x000000000012abcd');
  assert.equal(result.model, 'color');
  assert.equal(result.firmwareVersion, '42');
  assert.deepEqual([...result.support], [
    'get_prop',
    'set_power',
    'set_bright'
  ]);
  assert.deepEqual(result.properties, {
    power: 'on',
    bright: '75',
    'x-vendor-prop': 'value'
  });
});

test('parses alive notifications', () => {
  const result = parseDiscoveryPacket(
    packet([
      'NOTIFY * HTTP/1.1',
      'location: yeelight://10.0.0.12:55443',
      'id: 0x1',
      'nts: ssdp:alive'
    ])
  );

  assert.equal(result.kind, 'notification');
  assert.equal(result.deviceId, '0x1');
});

test('allows identical duplicate headers and rejects conflicting ones', () => {
  const duplicate = packet([
    'HTTP/1.1 200 OK',
    'location: yeelight://192.168.0.3:55443',
    'Location: yeelight://192.168.0.3:55443',
    'id: 0x10'
  ]);
  assert.equal(parseDiscoveryPacket(duplicate).location.port, 55443);

  const conflicting = packet([
    'HTTP/1.1 200 OK',
    'location: yeelight://192.168.0.3:55443',
    'Location: yeelight://192.168.0.4:55443',
    'id: 0x10'
  ]);
  assert.throws(
    () => parseDiscoveryPacket(conflicting),
    (error: unknown) =>
      error instanceof YeelightProtocolError &&
      error.code === 'CONFLICTING_HEADER'
  );
});

test('rejects hostnames, IPv6 and invalid ports in Location', () => {
  for (const location of [
    'yeelight://bulb.local:55443',
    'yeelight://[fe80::1]:55443',
    'yeelight://192.168.1.5:0',
    'http://192.168.1.5:55443'
  ]) {
    assert.throws(
      () =>
        parseDiscoveryPacket(
          packet([
            'HTTP/1.1 200 OK',
            `location: ${location}`,
            'id: 0x10'
          ])
        ),
      YeelightProtocolError
    );
  }
});

test('rejects oversized discovery packets', () => {
  assert.throws(
    () => parseDiscoveryPacket('x'.repeat(65), 64),
    (error: unknown) =>
      error instanceof YeelightProtocolError &&
      error.code === 'DISCOVERY_PACKET_TOO_LARGE'
  );
});
