import assert from 'node:assert/strict';
import test from 'node:test';
import type { RemoteInfo } from 'node:dgram';
import {
  DiscoveryManager,
  type DiscoveryPacketEvent
} from '../../src/backend/discovery/discovery-manager';
import { YEELIGHT_DISCOVERY_ADDRESS } from '../../src/backend/protocol';

type MessageHandler = (message: Buffer, info: RemoteInfo) => void;
type ErrorHandler = (error: Error) => void;

class FakeUdpSocket {
  readonly sent: Array<{ port: number; address: string; message: Buffer }> = [];
  readonly memberships: Array<{ group: string; address?: string }> = [];
  closed = false;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly errorHandlers: ErrorHandler[] = [];

  constructor(
    private readonly onSend?: (
      socket: FakeUdpSocket,
      address: string
    ) => void
  ) {}

  bind(_port: number, _address: string, callback: () => void): void {
    callback();
  }

  on(event: 'message' | 'error', handler: MessageHandler | ErrorHandler): this {
    if (event === 'message') {
      this.messageHandlers.push(handler as MessageHandler);
    } else {
      this.errorHandlers.push(handler as ErrorHandler);
    }
    return this;
  }

  send(
    message: Buffer,
    port: number,
    address: string,
    callback?: (error: Error | null) => void
  ): void {
    this.sent.push({
      message,
      port,
      address
    });
    callback?.(null);
    this.onSend?.(this, address);
  }

  setMulticastInterface(_address: string): void {}
  setMulticastTTL(_ttl: number): void {}

  addMembership(group: string, address?: string): void {
    this.memberships.push({ group, address });
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(message: Buffer, address: string): void {
    const info: RemoteInfo = {
      address,
      family: 'IPv4',
      port: 1982,
      size: message.length
    };
    for (const handler of this.messageHandlers) {
      handler(message, info);
    }
  }
}

function response(address: string, deviceId: string): Buffer {
  return Buffer.from(
    [
      'HTTP/1.1 200 OK',
      `Location: yeelight://${address}:55443`,
      `id: ${deviceId}`,
      'model: color',
      'support: set_power set_bright set_hsv',
      'power: on',
      '',
      ''
    ].join('\r\n'),
    'utf8'
  );
}

const interfaces = [
  {
    name: 'Ethernet',
    address: '192.168.1.2',
    netmask: '255.255.255.0'
  }
];

test('sends multicast per interface and probes saved manual addresses', async () => {
  const events: DiscoveryPacketEvent[] = [];
  const sockets: FakeUdpSocket[] = [];
  const manager = new DiscoveryManager({
    listInterfaces: () => interfaces,
    createUdpSocket: () => {
      const socket = new FakeUdpSocket((current, address) => {
        if (address === YEELIGHT_DISCOVERY_ADDRESS) {
          current.emitMessage(
            response('192.168.1.50', '0x10'),
            '192.168.1.50'
          );
        } else if (address === '10.0.0.20') {
          current.emitMessage(response('10.0.0.20', '0x20'), '10.0.0.20');
        }
      });
      sockets.push(socket);
      return socket;
    },
    onPacket: (event) => events.push(event),
    scanDurationMs: 10,
    scanRounds: 1,
    scanIntervalMs: 0
  });

  const result = await manager.scan(['10.0.0.20']);

  assert.equal(result.interfaceCount, 1);
  assert.deepEqual(result.discoveredDeviceIds, ['0x10', '0x20']);
  assert.deepEqual(
    events.map((event) => event.source),
    ['active', 'manual']
  );
  assert.deepEqual(
    sockets[0].sent.map((entry) => entry.address),
    [YEELIGHT_DISCOVERY_ADDRESS, '10.0.0.20']
  );
  assert.equal(sockets[0].closed, true);
});

test('rejects packets outside interface networks unless explicitly manual', async () => {
  const events: DiscoveryPacketEvent[] = [];
  const warnings: string[] = [];
  const manager = new DiscoveryManager({
    listInterfaces: () => interfaces,
    createUdpSocket: () =>
      new FakeUdpSocket((socket, address) => {
        if (address === YEELIGHT_DISCOVERY_ADDRESS) {
          socket.emitMessage(response('8.8.8.8', '0x30'), '8.8.8.8');
        }
      }),
    onPacket: (event) => events.push(event),
    onWarning: (message) => warnings.push(message),
    scanDurationMs: 10,
    scanRounds: 1,
    scanIntervalMs: 0
  });

  const result = await manager.scan();
  assert.deepEqual(result.discoveredDeviceIds, []);
  assert.deepEqual(events, []);
  assert.equal(warnings.some((warning) => warning.includes('untrusted')), true);
});

test('cancels an active scan without waiting for its full window', async () => {
  const manager = new DiscoveryManager({
    listInterfaces: () => interfaces,
    createUdpSocket: () => new FakeUdpSocket(),
    onPacket: () => {},
    scanDurationMs: 10_000,
    scanRounds: 1,
    scanIntervalMs: 0
  });

  const scan = manager.scan();
  manager.cancelScan();
  const result = await scan;

  assert.equal(result.cancelled, true);
  assert.equal(manager.getStatus().scanning, false);
});

test('joins passive multicast listener on every active interface', () => {
  const socket = new FakeUdpSocket();
  const manager = new DiscoveryManager({
    listInterfaces: () => interfaces,
    createUdpSocket: () => socket,
    onPacket: () => {}
  });

  manager.startPassiveListener();

  assert.deepEqual(socket.memberships, [
    {
      group: YEELIGHT_DISCOVERY_ADDRESS,
      address: '192.168.1.2'
    }
  ]);
  assert.equal(manager.getStatus().passiveListening, true);

  manager.stop();
  assert.equal(socket.closed, true);
});

test('accepts passive packets from explicitly saved manual subnets', () => {
  const socket = new FakeUdpSocket();
  const events: DiscoveryPacketEvent[] = [];
  const manager = new DiscoveryManager({
    listInterfaces: () => interfaces,
    createUdpSocket: () => socket,
    onPacket: (event) => events.push(event)
  });
  manager.setManualAddresses(['10.0.0.20']);
  manager.startPassiveListener();

  socket.emitMessage(response('10.0.0.20', '0x20'), '10.0.0.20');

  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'manual');
  manager.stop();
});
